/**
 * Live PoS unbond requests from a block's `tx/applied` events + raw tx bytes.
 *
 * An unbond moves no tokens, so the token/transfer parser never sees it. Instead:
 *   1. The `tx/applied` event's `batch` attribute lists every inner tx with its result. An applied unbond's
 *      `changed_keys` include `<PoS>/unbond/<source>/<validator>/…`, which tells us a block has one (prefilter,
 *      so the extra `/block` fetch only happens for such blocks) and which (source, validator) pair it touched.
 *   2. The block's tx bytes are borsh-decoded (parse/namada-tx.ts); the Data section referenced by the applied
 *      inner tx's commitment is decoded as `Unbond { validator, amount, source }`.
 *   3. Withdraws also touch `unbond/…` keys (they delete them), so the code the inner tx ran decides: a known
 *      `tx_unbond.wasm` checksum (UNBOND_CODE_HASHES) is decoded whatever tag the signer wrote on its Code section,
 *      and so is a section tagged `tx_unbond.wasm` (a newer unbond wasm than the list knows); other tagged code is
 *      counted in `skipped`, and untagged code the list does not know is reported in `undecoded`. A flow is
 *      emitted only when the bytes decode exactly as an Unbond and the decoded (source, validator) matches the
 *      changed key for that inner hash.
 *      Rows use the same id/meta scheme as the indexer backfill (scripts/backfill-history.ts step `pos`):
 *      id `namada:<INNER_HASH>:pos`, from = PoS, to = delegator, meta.validator / meta.wrapper / meta.tsSource.
 *
 * Anything that fails to decode is returned in `undecoded` with the reason, never emitted with a guessed value.
 */
import { NAMADA } from '../config';
import { toNam } from '../util';
import type { Flow } from '../../../shared/types';
import type { NamadaBlock } from './namada';
import { decodeNamadaTx, decodeUnbond, txBytesFromBase64 } from './namada-tx';

const POS = NAMADA.internal.pos;
/** Tag the Namada SDK puts on the Code section of an unbond (the wasm file name; its hash is recorded in meta.code). */
const UNBOND_WASM = 'tx_unbond.wasm';
/**
 * Checksums of tx_unbond.wasm: the code the chain runs for an unbond, whatever the signer wrote in the Code section's
 * tag (the tag is the signer's own text and may be left out). 36E77435… is checksums.current['tx_unbond.wasm'] of
 * indexer.namada.net /chain/parameters, and the code of the unbonds in blocks 6,957,587 (2026-06-17) and 8,300,328
 * (2026-10-16). A protocol upgrade that ships a new tx_unbond.wasm adds its checksum here.
 */
export const UNBOND_CODE_HASHES: ReadonlySet<string> = new Set(['36E774350B865752C9D309D518223ABF0A60374BAE15A1F73DFE4721B5887048']);

interface AppliedInner {
  wrapperHash: string;
  innerHash: string;
  /** (source, validator) pairs from `<PoS>/unbond/<source>/<validator>` changed keys */
  unbondKeys: { source: string; validator: string }[];
}

interface Seg { AddressSeg?: string; StringSeg?: string }

/** Applied inner txs that wrote to a PoS unbond key, from the block's tx/applied events. */
export function appliedUnbonds(block: NamadaBlock): AppliedInner[] {
  const out: AppliedInner[] = [];
  // Every shape check below is on data a node sent: anything unexpected is read as "no unbond here", never thrown
  // (a throw would make the scan treat the whole block as unreadable).
  for (const e of Array.isArray(block.events) ? block.events : []) {
    if (e?.type !== 'tx/applied' || !Array.isArray(e.attributes)) continue;
    let wrapperHash = '';
    let batchJson = '';
    for (const a of e.attributes) {
      if (!a || typeof a.value !== 'string') continue;
      if (a.key === 'hash') wrapperHash = a.value.toUpperCase();
      else if (a.key === 'batch') batchJson = a.value;
    }
    if (!batchJson) continue;
    let batch: unknown;
    try { batch = JSON.parse(batchJson); } catch { continue; }
    if (!batch || typeof batch !== 'object' || Array.isArray(batch)) continue;
    for (const [innerHash, res] of Object.entries(batch as Record<string, any>)) {
      const ok = res?.Ok;
      if (!ok || typeof ok !== 'object') continue; // Err or unknown shape: not applied
      const unbondKeys: AppliedInner['unbondKeys'] = [];
      for (const ck of (Array.isArray(ok.changed_keys) ? ok.changed_keys : []) as { segments?: Seg[] }[]) {
        const s = Array.isArray(ck?.segments) ? ck.segments : [];
        if (s[0]?.AddressSeg === POS && s[1]?.StringSeg === 'unbond' && s[2]?.AddressSeg && s[3]?.AddressSeg) {
          const k = { source: s[2].AddressSeg, validator: s[3].AddressSeg };
          if (!unbondKeys.some((u) => u.source === k.source && u.validator === k.validator)) unbondKeys.push(k);
        }
      }
      if (unbondKeys.length) out.push({ wrapperHash, innerHash: innerHash.toUpperCase(), unbondKeys });
    }
  }
  return out;
}

/** True when the block needs its tx bytes fetched to extract unbond requests. */
export const blockHasUnbond = (block: NamadaBlock): boolean => appliedUnbonds(block).length > 0;

export interface UnbondParse {
  flows: Flow[];
  /** Applied inner txs that touched unbond keys but could not be turned into a flow, with the reason */
  undecoded: { innerHash: string; wrapperHash: string; reason: string }[];
  /** Applied inner txs that touched unbond keys but ran tagged code that is not an unbond (e.g. tx_withdraw.wasm), by tag */
  skipped: Record<string, number>;
}

/**
 * @param block   block_results events with the exact block time (block.ts must come from block metas)
 * @param txsB64  the block's txs as returned by RPC `/block` (base64)
 */
export function parseNamadaUnbonds(block: NamadaBlock, txsB64: string[], priceUsd: number | null): UnbondParse {
  const out: UnbondParse = { flows: [], undecoded: [], skipped: {} };
  const applied = appliedUnbonds(block);
  if (!applied.length) return out;

  // Decode every tx once; index inner hash -> (decoded tx, commitment)
  const byInner = new Map<string, { tx: ReturnType<typeof decodeNamadaTx>; dataHash: string; codeHash: string }>();
  const decodeErrors: string[] = [];
  for (const b64 of txsB64) {
    try {
      const tx = decodeNamadaTx(txBytesFromBase64(b64));
      for (const c of tx.commitments) byInner.set(c.innerHash, { tx, dataHash: c.dataHash, codeHash: c.codeHash });
    } catch (e) {
      decodeErrors.push(String(e));
    }
  }

  for (const a of applied) {
    const hit = byInner.get(a.innerHash);
    if (!hit) {
      out.undecoded.push({ ...a, reason: `inner hash not found in block txs${decodeErrors.length ? ` (tx decode errors: ${decodeErrors.join('; ')})` : ''}` });
      continue;
    }
    const code = hit.tx.codes.get(hit.codeHash);
    if (!code) {
      out.undecoded.push({ ...a, reason: `code section ${hit.codeHash.slice(0, 8)} not decoded${hit.tx.stoppedAt ? ` (stopped at ${hit.tx.stoppedAt})` : ''}` });
      continue;
    }
    // The executed code decides, not the tag alone: a known unbond checksum is decoded with any tag or none.
    if (!UNBOND_CODE_HASHES.has(code.codeHash) && code.tag !== UNBOND_WASM) {
      if (code.tag === null) {
        // No tag and a code the list does not know, on an inner tx that changed unbond keys: possibly an unbond under
        // a newer checksum. Reported (the health view shows it), never dropped in silence and never decoded on a guess.
        out.undecoded.push({ ...a, reason: `untagged code ${code.codeHash.slice(0, 8)} is not a known ${UNBOND_WASM} checksum` });
        continue;
      }
      out.skipped[code.tag] = (out.skipped[code.tag] ?? 0) + 1;
      continue;
    }
    const data = hit.tx.data.get(hit.dataHash);
    if (!data) {
      out.undecoded.push({ ...a, reason: `data section ${hit.dataHash.slice(0, 8)} not decoded${hit.tx.stoppedAt ? ` (stopped at ${hit.tx.stoppedAt})` : ''}` });
      continue;
    }
    let u;
    try { u = decodeUnbond(data); } catch (e) {
      out.undecoded.push({ ...a, reason: `not an Unbond: ${String(e)}` });
      continue;
    }
    const delegator = u.source ?? u.validator;
    const key = a.unbondKeys.find((k) => k.source === delegator && k.validator === u.validator);
    if (!key) {
      out.undecoded.push({ ...a, reason: `decoded (${delegator}, ${u.validator}) does not match changed keys ${JSON.stringify(a.unbondKeys)}` });
      continue;
    }
    const amount = toNam(u.amount);
    if (!(amount > 0)) {
      out.undecoded.push({ ...a, reason: `zero amount` });
      continue;
    }
    out.flows.push({
      id: `namada:${a.innerHash}:pos`,
      chain: 'namada',
      height: block.height,
      ts: block.ts,
      txHash: a.innerHash,
      kind: 'unbond',
      from: POS,
      to: delegator,
      amount,
      priceUsd,
      valueUsd: priceUsd != null ? priceUsd * amount : null,
      meta: {
        source: 'namada-rpc',
        txKind: 'unbond',
        validator: u.validator,
        wrapper: a.wrapperHash,
        tsSource: 'block',
        ...(u.source === null ? { selfUnbond: true } : {}),
        code: code.codeHash,
        ...(priceUsd != null ? { priceSource: 'spot' } : {}),
      },
    });
  }
  return out;
}
