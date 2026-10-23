/**
 * The live PoS request decoder that namada-unbond.ts (unbonds) and namada-bond.ts (bonds) share. Neither request has
 * a token/transfer event (an unbond moves no tokens; a bond's move from the delegator to the staking account emits
 * none), so both are read from the block's `tx/applied` events and its tx bytes:
 *   1. An applied inner tx (its result Ok, and no validity predicate rejecting it in `vps_result.rejected_vps`): its
 *      `changed_keys` show which PoS keys it wrote: `<PoS>/unbond/<source>/<validator>/…` for an
 *      unbond (and a withdraw, which deletes them), `<PoS>/bond/<source>/<validator>/…` for a bond (and an unbond or a
 *      redelegation, which change them). That prefilter decides which blocks need the extra `/block` read, and which
 *      (source, validator) pairs each inner tx touched.
 *   2. The block's tx bytes are decoded (namada-tx.ts) and indexed by inner hash; the Data section the applied inner
 *      tx's commitment names is decoded as `{ validator, amount, source }`, the layout of both Bond and Unbond.
 *   3. The code the inner tx ran decides what it was (codeName): a known checksum names its wasm whatever tag the
 *      signer wrote; only a checksum the lists do not know falls back to the tag. So no inner tx is read as both a
 *      bond and an unbond (their data have the same layout and an unbond writes bond keys too). Other tagged code is
 *      counted in `skipped` by its name, and untagged code the lists do not know is reported in `undecoded`.
 *   4. A flow is emitted only when the bytes decode exactly as the request and the decoded (source, validator) is a
 *      pair the inner tx's changed keys name. An inner tx of an atomic wrapper (the header's atomic flag) is applied
 *      only when its whole batch is: every inner tx the wrapper commits to has an applied result (Ok, no rejecting
 *      validity predicate) and the event's code, when given, is 0. Otherwise the chain dropped every write of the
 *      batch, though the request's own result reads Ok, and the request is reported in `undecoded`. Rows use the
 *      indexer backfill's id and meta scheme (scripts/backfill-history.ts step `pos`): id `namada:<INNER_HASH>:pos`, the same id for the same inner tx whichever source wrote
 *      it and apart from every transfer id (`namada:<hash>:<i>…`); an unbond goes PoS → delegator, a bond delegator →
 *      PoS; meta.validator, meta.wrapper, meta.tsSource 'block', meta.source 'namada-rpc', meta.code (the checksum).
 *
 * Anything that fails to decode is returned in `undecoded` with the reason, never emitted with a guessed value.
 */
import { NAMADA } from '../config';
import { toNam } from '../util';
import type { Flow } from '../../../shared/types';
import type { NamadaBlock } from './namada';
import { decodeBond, decodeNamadaTx, decodeUnbond, txBytesFromBase64, type DecodedTx, type UnbondData } from './namada-tx';

const POS = NAMADA.internal.pos;

/** Tags the Namada SDK puts on the Code section of an unbond and a bond (the wasm file names). */
export const UNBOND_WASM = 'tx_unbond.wasm';
export const BOND_WASM = 'tx_bond.wasm';
/**
 * Checksums of tx_unbond.wasm: the code the chain runs for an unbond, whatever the signer wrote in the Code section's
 * tag (the tag is the signer's own text and may be left out). 36E77435… is checksums.current['tx_unbond.wasm'] of
 * indexer.namada.net /chain/parameters, and the code of the unbonds in blocks 6,957,587 (2026-06-17) and 8,300,328
 * (2026-10-16). A protocol upgrade that ships a new tx_unbond.wasm adds its checksum here.
 */
export const UNBOND_CODE_HASHES: ReadonlySet<string> = new Set(['36E774350B865752C9D309D518223ABF0A60374BAE15A1F73DFE4721B5887048']);
/**
 * Checksums of tx_bond.wasm. 490CF419… is checksums.current['tx_bond.wasm'] of indexer.namada.net /chain/parameters
 * (read 2026-10-23) and the code of the chain's bonds from block 7,682,174 on, among them the bond of block 8,351,607
 * (test/fixtures/namada_block_8351607.json). A protocol upgrade that ships a new tx_bond.wasm adds its checksum here.
 */
export const BOND_CODE_HASHES: ReadonlySet<string> = new Set(['490CF419BDBFFE616C6AA6C72D38064E350EE65FB04D92472CCF285AEC6844B6']);
/**
 * Other PoS code that writes bond or unbond keys, by checksum (checksums.current of the same parameters, and the code
 * of the chain's redelegations and withdrawals from block 7,682,174 on): read as what it is, never as a bond or an
 * unbond, and never reported as code the decoders could not place.
 */
const OTHER_POS_CODES: ReadonlyMap<string, string> = new Map([
  ['7D5AD1877643F7D9B32A511EF93A11E8503426BAEE0F5986D29E3F63A2355D58', 'tx_redelegate.wasm'],
  ['A8686AE87AA940E3C45ADB79CB5E1DAA71033D41FE85F6B32713AE3CEF21FF25', 'tx_withdraw.wasm'],
]);

/** The wasm an inner tx ran: a known checksum's name whatever the tag; else the signer's tag (null when there is none). */
export function codeName(code: { tag: string | null; codeHash: string }): string | null {
  if (UNBOND_CODE_HASHES.has(code.codeHash)) return UNBOND_WASM;
  if (BOND_CODE_HASHES.has(code.codeHash)) return BOND_WASM;
  return OTHER_POS_CODES.get(code.codeHash) ?? code.tag;
}

export interface PosWrite {
  wrapperHash: string;
  innerHash: string;
  /** (source, validator) pairs from `<PoS>/<segment>/<source>/<validator>` changed keys */
  keys: { source: string; validator: string }[];
}

interface Seg { AddressSeg?: string; StringSeg?: string }

/** Applied inner txs that wrote to a `<PoS>/<segment>/<source>/<validator>` key, from the block's tx/applied events. */
export function appliedPosWrites(block: NamadaBlock, segment: 'bond' | 'unbond'): PosWrite[] {
  const out: PosWrite[] = [];
  // Every shape check below is on data a node sent: anything unexpected is read as "no such write here", never thrown
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
      // Err or an unknown shape is not applied. An inner tx whose code ran (Ok) but that a validity predicate rejected
      // is not applied either: its changed keys are listed and none of them is committed. Block 7,852,270's
      // 214.659543 NAM bond is one (its delegator's VP rejected it; indexer.namada.net files it as rejected). Only an
      // empty `rejected_vps` list is read as applied.
      if (!appliedResult(res)) continue;
      const ok = res.Ok;
      const keys: PosWrite['keys'] = [];
      for (const ck of (Array.isArray(ok.changed_keys) ? ok.changed_keys : []) as { segments?: Seg[] }[]) {
        const s = Array.isArray(ck?.segments) ? ck.segments : [];
        if (s[0]?.AddressSeg === POS && s[1]?.StringSeg === segment && s[2]?.AddressSeg && s[3]?.AddressSeg) {
          const k = { source: s[2].AddressSeg, validator: s[3].AddressSeg };
          if (!keys.some((u) => u.source === k.source && u.validator === k.validator)) keys.push(k);
        }
      }
      if (keys.length) out.push({ wrapperHash, innerHash: innerHash.toUpperCase(), keys });
    }
  }
  return out;
}

/** Whether one result of a tx/applied `batch` is applied: its code ran (Ok) and no validity predicate rejected it. */
function appliedResult(res: any): boolean {
  const ok = res?.Ok;
  if (!ok || typeof ok !== 'object') return false;
  const rejected = ok.vps_result?.rejected_vps;
  return Array.isArray(rejected) && rejected.length === 0;
}

/** What one wrapper's tx/applied event says of its batch: the inner hashes applied, and whether every result was. */
interface BatchOutcome { applied: Set<string>; allApplied: boolean }

/**
 * Each wrapper's batch outcome, by wrapper hash, from the block's tx/applied events. An event whose batch cannot be
 * read, or whose code is not 0, counts as a batch not every result of which was applied.
 */
function batchOutcomes(block: NamadaBlock): Map<string, BatchOutcome> {
  const out = new Map<string, BatchOutcome>();
  for (const e of Array.isArray(block.events) ? block.events : []) {
    if (e?.type !== 'tx/applied' || !Array.isArray(e.attributes)) continue;
    let wrapperHash = '';
    let batchJson = '';
    let code: string | null = null;
    for (const a of e.attributes) {
      if (!a || typeof a.value !== 'string') continue;
      if (a.key === 'hash') wrapperHash = a.value.toUpperCase();
      else if (a.key === 'batch') batchJson = a.value;
      else if (a.key === 'code') code = a.value;
    }
    if (!wrapperHash) continue;
    const o = out.get(wrapperHash) ?? { applied: new Set<string>(), allApplied: true };
    out.set(wrapperHash, o);
    if (code !== null && code !== '0') o.allApplied = false;
    let batch: unknown = null;
    try { batch = batchJson ? JSON.parse(batchJson) : null; } catch {}
    if (!batch || typeof batch !== 'object' || Array.isArray(batch)) { o.allApplied = false; continue; }
    for (const [innerHash, res] of Object.entries(batch as Record<string, unknown>)) {
      if (appliedResult(res)) o.applied.add(innerHash.toUpperCase());
      else o.allApplied = false;
    }
  }
  return out;
}

/** Inner hashes the block's token/transfer events name: tokens those inner txs moved are already rows of the event parser. */
function tokenEventInners(block: NamadaBlock): Set<string> {
  const out = new Set<string>();
  for (const e of Array.isArray(block.events) ? block.events : []) {
    if (e?.type !== 'token/transfer' || !Array.isArray(e.attributes)) continue;
    for (const a of e.attributes) if (a?.key === 'inner-tx-hash' && typeof a.value === 'string' && a.value) out.add(a.value.toUpperCase());
  }
  return out;
}

export interface PosParse {
  flows: Flow[];
  /** Applied inner txs that touched the request's keys but could not be turned into a flow, with the reason */
  undecoded: { innerHash: string; wrapperHash: string; reason: string }[];
  /** Applied inner txs that touched the request's keys but ran other code (e.g. tx_withdraw.wasm), by its name */
  skipped: Record<string, number>;
}

interface Request {
  kind: 'bond' | 'unbond';
  segment: 'bond' | 'unbond';
  wasm: string;
  /** the data's type name, for the reason of bytes that are not one */
  type: 'Bond' | 'Unbond';
  decode: (data: Uint8Array) => UnbondData;
  /** meta key for a request with no source (the validator's own stake) */
  self: 'selfBond' | 'selfUnbond';
}

export const UNBOND_REQUEST: Request = { kind: 'unbond', segment: 'unbond', wasm: UNBOND_WASM, type: 'Unbond', decode: decodeUnbond, self: 'selfUnbond' };
export const BOND_REQUEST: Request = { kind: 'bond', segment: 'bond', wasm: BOND_WASM, type: 'Bond', decode: decodeBond, self: 'selfBond' };

/**
 * The request flows of one block.
 * @param block   block_results events with the exact block time (block.ts must come from block metas)
 * @param txsB64  the block's txs as returned by RPC `/block` (base64)
 */
export function parsePosRequests(req: Request, block: NamadaBlock, txsB64: readonly string[], priceUsd: number | null): PosParse {
  const out: PosParse = { flows: [], undecoded: [], skipped: {} };
  const applied = appliedPosWrites(block, req.segment);
  if (!applied.length) return out;

  // Decode every tx once; index inner hash -> (decoded tx, commitment)
  const byInner = new Map<string, { tx: DecodedTx; dataHash: string; codeHash: string }>();
  const decodeErrors: string[] = [];
  for (const b64 of Array.isArray(txsB64) ? txsB64 : []) {
    try {
      const tx = decodeNamadaTx(txBytesFromBase64(b64));
      for (const c of tx.commitments) byInner.set(c.innerHash, { tx, dataHash: c.dataHash, codeHash: c.codeHash });
    } catch (e) {
      decodeErrors.push(String(e));
    }
  }
  // A bond moves tokens with no event today; an event naming the same inner tx would make a row of its own (parse/
  // namada.ts), and a decoded bond beside it would count the tokens twice.
  const moved = req.kind === 'bond' ? tokenEventInners(block) : new Set<string>();
  const batches = batchOutcomes(block);

  for (const w of applied) {
    const a = { wrapperHash: w.wrapperHash, innerHash: w.innerHash };
    const hit = byInner.get(w.innerHash);
    if (!hit) {
      out.undecoded.push({ ...a, reason: `inner hash not found in block txs${decodeErrors.length ? ` (tx decode errors: ${decodeErrors.join('; ')})` : ''}` });
      continue;
    }
    const code = hit.tx.codes.get(hit.codeHash);
    if (!code) {
      out.undecoded.push({ ...a, reason: `code section ${hit.codeHash.slice(0, 8)} not decoded${hit.tx.stoppedAt ? ` (stopped at ${hit.tx.stoppedAt})` : ''}` });
      continue;
    }
    // The executed code decides, not the tag alone: a known checksum is read as its own wasm with any tag or none.
    const ran = codeName(code);
    if (ran !== req.wasm) {
      if (ran === null) {
        // No tag and a code the lists do not know, on an inner tx that wrote the request's keys: possibly the request
        // under a newer checksum. Reported (the health view shows it), never dropped in silence or decoded on a guess.
        out.undecoded.push({ ...a, reason: `untagged code ${code.codeHash.slice(0, 8)} is not a known ${req.wasm} checksum` });
        continue;
      }
      out.skipped[ran] = (out.skipped[ran] ?? 0) + 1;
      continue;
    }
    const data = hit.tx.data.get(hit.dataHash);
    if (!data) {
      out.undecoded.push({ ...a, reason: `data section ${hit.dataHash.slice(0, 8)} not decoded${hit.tx.stoppedAt ? ` (stopped at ${hit.tx.stoppedAt})` : ''}` });
      continue;
    }
    let u: UnbondData;
    try { u = req.decode(data); } catch (e) {
      out.undecoded.push({ ...a, reason: `not a${req.type === 'Unbond' ? 'n' : ''} ${req.type}: ${String(e)}` });
      continue;
    }
    const delegator = u.source ?? u.validator;
    if (!w.keys.some((k) => k.source === delegator && k.validator === u.validator)) {
      out.undecoded.push({ ...a, reason: `decoded (${delegator}, ${u.validator}) does not match changed keys ${JSON.stringify(w.keys)}` });
      continue;
    }
    const amount = toNam(u.amount);
    if (!(amount > 0)) {
      out.undecoded.push({ ...a, reason: `zero amount` });
      continue;
    }
    // An atomic batch is committed whole or not at all: a request in one whose other inner txs did not all apply (or
    // have no result in the event) was dropped with them, though its own result reads Ok.
    if (hit.tx.atomic) {
      const b = batches.get(w.wrapperHash);
      if (!b || !b.allApplied || !hit.tx.commitments.every((c) => b.applied.has(c.innerHash))) {
        out.undecoded.push({ ...a, reason: 'atomic batch not committed' });
        continue;
      }
    }
    if (moved.has(w.innerHash)) {
      out.undecoded.push({ ...a, reason: `a token/transfer event of the block names this ${req.kind}: its tokens are a row of the event parser` });
      continue;
    }
    out.flows.push({
      id: `namada:${w.innerHash}:pos`,
      chain: 'namada',
      height: block.height,
      ts: block.ts,
      txHash: w.innerHash,
      kind: req.kind,
      from: req.kind === 'bond' ? delegator : POS,
      to: req.kind === 'bond' ? POS : delegator,
      amount,
      priceUsd,
      valueUsd: priceUsd != null ? priceUsd * amount : null,
      meta: {
        source: 'namada-rpc',
        txKind: req.kind,
        validator: u.validator,
        wrapper: w.wrapperHash,
        tsSource: 'block',
        ...(u.source === null ? { [req.self]: true } : {}),
        code: code.codeHash,
        ...(priceUsd != null ? { priceSource: 'spot' } : {}),
      },
    });
  }
  return out;
}
