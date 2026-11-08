/**
 * The indexer-era rows checked against the chain's own blocks. The rows scripts/backfill-history.ts imported from
 * indexer.namada.net (meta.source 'namada-indexer': transfers, shields, unshields, bridge legs, bonds and unbonds up
 * to block 8,301,075) were admitted on the indexer's exit code, which is not the chain's verdict both ways: a bond the
 * staking validity predicate rejected at block 8,202,488 read 'applied' there (migration 0020 took the row out), and a
 * transfer the chain applied at block 8,013,290 read 'rejected'. This script reads each row's block from two public
 * nodes and judges the inner transaction by the block's own `tx/applied` event: applied only when the event's code is
 * 0, the batch result of the inner hash is Ok and `vps_result.rejected_vps` is empty (the rule the live decoders use,
 * worker/src/parse/namada-pos.ts), and only when both nodes give the same event. It writes nothing to the database.
 *
 *   node --experimental-transform-types scripts/recheck-indexer-rows.ts pos      # bond and unbond rows (about 19,600 rows)
 *   node --experimental-transform-types scripts/recheck-indexer-rows.ts rest     # every other indexer-imported row
 *   node --experimental-transform-types scripts/recheck-indexer-rows.ts all      # both, bonds and unbonds first
 *   options: --conc 3 (block_results reads in flight per node)  --report docs/data/indexer-recheck-<date>.md
 *            --sql scripts/out/indexer_recheck.sql  --nodes https://a,https://b  --refresh (read the rows again)
 *   (--experimental-strip-types runs everything but the tx-bytes step below, whose decoder, worker/src/parse/namada-tx.ts,
 *   uses a constructor parameter property that strip-only mode refuses; the rows that step would judge are then
 *   reported as "batch not read", never as not applied.)
 *
 * Reads: the remote D1 through read-only SELECTs (scripts/lib.ts d1), and /block_results of two archive nodes, one
 * read per distinct block per node, cached under scripts/out/indexer_recheck/blocks/ (a block read once is never asked
 * again, so a stopped run resumes where it was; SIGINT writes the report and the SQL from what is cached so far).
 *
 * The tx-bytes step. A wrapper's tx/applied event carries one code for its whole batch: when another inner
 * transaction of the batch failed (ran out of gas, say), the code is 1 although this row's own result reads Ok with no
 * rejecting validity predicate. Whether the chain kept this row's writes then depends on the wrapper's atomic flag,
 * which is in the transaction bytes, not in the event: an atomic batch is committed whole or not at all (the live
 * decoders' rule, worker/src/parse/namada-pos.ts), a non-atomic one keeps the inner transactions that passed. For
 * exactly those rows the script reads the block's /block from both nodes too (cached under blocks_txs/), decodes the
 * wrappers with the Worker's own decoder, and judges: atomic, not applied; not atomic, applied. The same bytes give a
 * bond's or an unbond's amount, so for those rows the stored amount is compared with the chain's as well.
 *
 * Outputs:
 *   - the report (docs/data/indexer-recheck-<date>.md): counts by kind; the rows the chain did not apply; rows
 *     recorded twice; rows whose amount is not the one the block's token event carries; the bridge totals of the era
 *     before and after the rows the chain did not apply. Heights, kinds, amounts and counts only: no address but the
 *     protocol accounts, no transaction hash (the SQL file names the rows).
 *   - scripts/out/indexer_recheck.sql: for every row the chain did not apply, the statements migration 0020 modelled
 *     (the day's activity_daily and flow_edges_daily counts and NAM less the row, the edge gone when empty, the row
 *     deleted, the stake estimate of each delegator computed again from the rows that stay), for the operator to
 *     review and apply with `npm run db:apply`. A statement subtracts the row's stored amount while the row exists, so
 *     a second run, or a database without the row, changes nothing.
 *
 * What it does not judge: a bond's or an unbond's amount in a block whose tx bytes the step above did not need (one
 * /block read per such block would double the budget; the rows' sides are checked against the staking keys the inner
 * tx changed instead), and whether a wrapper whose code is 0 was atomic (its every inner transaction passed, so the
 * flag changes nothing).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { d1 } from './lib.ts';
import { INTERNAL_LABELS, NAMADA, UA } from '../worker/src/config.ts';

// ------------------------------------------------------------------ constants
export const NAM_TOKEN = 'tnam1q9gr66cvu4hrzm0sd5kmlnjje82gs3xlfg3v6nu7';
const POS = NAMADA.internal.pos;
/** The two public archive nodes that answer block_results back to genesis (checked 2026-11-07). */
export const DEFAULT_NODES = ['https://namada-rpc.stakeandrelax.net', 'https://namada-rpc.polkachu.com'];
const POS_KINDS = new Set(['bond', 'unbond']);
/** Kinds whose NAM move is a token/transfer event of the block (the amount can be compared with the event's). */
const TOKEN_KINDS = new Set(['transfer', 'shield', 'unshield', 'ibc_in', 'ibc_out']);
/** The last block the indexer import wrote (docs/decisions.md): the era this script covers. */
export const INDEXER_LAST_HEIGHT = 8_301_075;
/** The importer's rule for a repeated IBC relay (docs/decisions.md, 2026-10-17): same kind, ends and amount within 20 blocks of an earlier row. */
const RELAY_REPEAT_BLOCKS = 20;

// ------------------------------------------------------------------ types
export interface Row {
  id: string; height: number; ts: number; tx_hash: string; kind: string; from_addr: string | null; to_addr: string | null; amount_num: number; meta: string | null;
}
/** One inner transaction's result in a wrapper's tx/applied event, reduced to what the judgement reads. */
export interface InnerResult { ok: boolean; rejected: string[]; /** (source, validator) pairs of the PoS bond/unbond keys it changed */ posKeys: string[] }
export interface AppliedEvent { wrapper: string; code: string | null; batch: Record<string, InnerResult> | null }
/** One token/transfer event: the NAM legs by account (the event aggregates per account, not per pair). */
export interface TokenEvent { inner: string; wrapper: string; sources: Record<string, number>; targets: Record<string, number> }
/** A block as cached: only what the judgement reads. `empty` when the node answered with no transaction result at all. */
export interface ReducedBlock { height: number; node: string; readAt: number; applied: AppliedEvent[]; tokens: TokenEvent[]; empty: boolean }

export type Verdict =
  | { state: 'applied'; note?: string }
  | { state: 'not_applied'; reason: string }
  | { state: 'not_in_block' }
  | { state: 'disagree' }
  | { state: 'unread' }
  /** the row's own result is Ok but another inner tx of its batch failed, and the batch's atomic flag (tx bytes) was not read */
  | { state: 'batch_unread' };

/** One inner transaction as the tx bytes give it: the code it ran and, for a bond or an unbond, its decoded request. */
export interface InnerTx { tag: string | null; codeHash: string; stake: { validator: string; amount: number; source: string | null } | null }
/** One wrapper as the tx bytes give it: its atomic flag and its inner transactions by inner hash. */
export interface WrapperTx { atomic: boolean; inners: Record<string, InnerTx> }
/** A block's transactions as cached: only what the judgement reads. */
export interface TxSummary { height: number; node: string; readAt: number; nTxs: number; wrappers: Record<string, WrapperTx>; decodeErrors: number }

export interface Judged {
  row: Row;
  verdict: Verdict;
  /** for a token kind: whether the block's event carries the row's amount at the row's side; null when not compared */
  amount: 'same' | 'differs' | 'no_event' | null;
  /** the event's NAM at the row's side when it differs */
  eventAmount?: number;
  /** for a bond or unbond: whether a key the inner tx changed names the row's delegator */
  sides: 'same' | 'differs' | null;
  by: string[];
}

// ------------------------------------------------------------------ reduce
const bare = (a: string) => a.slice(a.indexOf('/') + 1);
function accounts(json: string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!json) return out;
  let v: unknown;
  try { v = JSON.parse(json); } catch { return out; }
  if (!Array.isArray(v)) return out;
  for (const item of v) {
    if (!Array.isArray(item) || !Array.isArray(item[0])) continue;
    const [[acct, tok], amt] = item as [[string, string], string];
    if (tok !== NAM_TOKEN || typeof acct !== 'string') continue;
    let n: number;
    try { n = Number(BigInt(amt)) / 1e6; } catch { continue; }
    out[bare(acct)] = (out[bare(acct)] ?? 0) + n;
  }
  return out;
}

interface Seg { AddressSeg?: string; StringSeg?: string }

/** A block_results answer reduced to its tx/applied verdicts and its NAM token events. Every shape check reads an unexpected shape as "not there". */
export function reduceBlock(answer: any, height: number, node: string, readAt = Date.now()): ReducedBlock | null {
  const r = answer?.result;
  if (!r || typeof r !== 'object') return null;
  if (Number(r.height) !== height) return null;
  const evs: any[] = [...(Array.isArray(r.begin_block_events) ? r.begin_block_events : []), ...(Array.isArray(r.end_block_events) ? r.end_block_events : []),
    ...(Array.isArray(r.finalize_block_events) ? r.finalize_block_events : []), ...((Array.isArray(r.txs_results) ? r.txs_results : []) as any[]).flatMap((x) => (Array.isArray(x?.events) ? x.events : []))];
  const applied: AppliedEvent[] = [];
  const tokens: TokenEvent[] = [];
  for (const e of evs) {
    if (!e || !Array.isArray(e.attributes)) continue;
    const a: Record<string, string> = {};
    for (const at of e.attributes) if (at && typeof at.key === 'string' && typeof at.value === 'string') a[at.key] = at.value;
    if (e.type === 'tx/applied') {
      let batch: Record<string, InnerResult> | null = null;
      if (a.batch) {
        let b: unknown = null;
        try { b = JSON.parse(a.batch); } catch {}
        if (b && typeof b === 'object' && !Array.isArray(b)) {
          batch = {};
          for (const [inner, res] of Object.entries(b as Record<string, any>)) {
            const ok = res?.Ok;
            const rejected = ok?.vps_result?.rejected_vps;
            const posKeys: string[] = [];
            for (const ck of (Array.isArray(ok?.changed_keys) ? ok.changed_keys : []) as { segments?: Seg[] }[]) {
              const s = Array.isArray(ck?.segments) ? ck.segments : [];
              if (s[0]?.AddressSeg === POS && (s[1]?.StringSeg === 'bond' || s[1]?.StringSeg === 'unbond') && s[2]?.AddressSeg && s[3]?.AddressSeg) {
                const k = `${s[2].AddressSeg}|${s[3].AddressSeg}`;
                if (!posKeys.includes(k)) posKeys.push(k);
              }
            }
            batch[inner.toUpperCase()] = { ok: !!ok && typeof ok === 'object', rejected: Array.isArray(rejected) ? rejected.filter((x: unknown) => typeof x === 'string') : ['(no vps_result)'], posKeys };
          }
        }
      }
      applied.push({ wrapper: (a.hash ?? '').toUpperCase(), code: a.code ?? null, batch });
    } else if (e.type === 'token/transfer') {
      tokens.push({ inner: (a['inner-tx-hash'] ?? '').toUpperCase(), wrapper: (a.hash ?? '').toUpperCase(), sources: accounts(a['source-accounts']), targets: accounts(a['target-accounts']) });
    }
  }
  return { height, node, readAt, applied, tokens, empty: !Array.isArray(r.txs_results) || r.txs_results.length === 0 };
}

/** Two nodes gave the same block when the verdicts and token events are the same, order of events aside. */
export const blockKey = (b: ReducedBlock): string => JSON.stringify({
  a: b.applied.map((x) => [x.wrapper, x.code, x.batch && Object.entries(x.batch).sort(([p], [q]) => (p < q ? -1 : 1)).map(([k, v]) => [k, v.ok, [...v.rejected].sort(), [...v.posKeys].sort()])]).sort(),
  t: b.tokens.map((x) => [x.inner, x.wrapper, Object.entries(x.sources).sort(), Object.entries(x.targets).sort()]).sort(),
  e: b.empty,
});

// ------------------------------------------------------------------ judge
const near = (a: number, b: number) => Math.abs(a - b) < 5e-7;

/** Whether a row's batch result needs the tx bytes to be judged: its own result is Ok and unrejected, but the wrapper's code is not 0. */
export const needsTxs = (ev: AppliedEvent, res: InnerResult): boolean => ev.code !== '0' && res.ok && res.rejected.length === 0;

/**
 * One row against its block as the nodes gave it (null: not read; `disagree`: two nodes gave different blocks), and,
 * when its batch's code is not 0 though its own result is Ok, against the block's tx bytes (`txs`: the same three
 * states), where the wrapper's atomic flag decides.
 */
export function judge(row: Row, blocks: ReducedBlock[] | 'disagree' | null, txs: TxSummary[] | 'disagree' | null = null): Judged {
  const base = { row, amount: null as Judged['amount'], sides: null as Judged['sides'], by: [] as string[] };
  if (blocks === 'disagree') return { ...base, verdict: { state: 'disagree' } };
  if (!blocks || blocks.length < 2) return { ...base, verdict: { state: 'unread' } };
  const b = blocks[0];
  const inner = row.tx_hash.toUpperCase();
  let found: { ev: AppliedEvent; res: InnerResult } | null = null;
  for (const ev of b.applied) if (ev.batch && ev.batch[inner]) { found = { ev, res: ev.batch[inner] }; break; }
  const by = blocks.map((x) => x.node);
  if (!found) return { ...base, by, verdict: { state: 'not_in_block' } };
  let verdict: Verdict;
  let wrapper: WrapperTx | null = null;
  if (!found.res.ok) verdict = { state: 'not_applied', reason: 'the batch result is not Ok' };
  else if (found.res.rejected.length) verdict = { state: 'not_applied', reason: `a validity predicate rejected it (${found.res.rejected.length})` };
  else if (found.ev.code !== '0') {
    // the row passed, another inner tx of its batch did not: the wrapper's atomic flag (tx bytes) decides
    if (txs === 'disagree') return { ...base, by, verdict: { state: 'disagree' } };
    if (!txs || txs.length < 2) return { ...base, by, verdict: { state: 'batch_unread' } };
    wrapper = txs[0].wrappers[found.ev.wrapper] ?? null;
    if (!wrapper) return { ...base, by, verdict: { state: 'batch_unread' } };
    if (wrapper.atomic) verdict = { state: 'not_applied', reason: `another inner transaction of its atomic batch failed (the wrapper's code is ${found.ev.code ?? 'not given'}), so the chain dropped the whole batch` };
    else verdict = { state: 'applied', note: `another inner transaction of its batch failed (the wrapper's code is ${found.ev.code ?? 'not given'}); the batch is not atomic, so this one's writes stand` };
  } else verdict = { state: 'applied' };
  const out: Judged = { ...base, by, verdict };
  if (POS_KINDS.has(row.kind) && wrapper?.inners[inner]?.stake) {
    // the tx bytes were read for this row: its amount and its delegator against the decoded request
    const s = wrapper.inners[inner].stake!;
    const delegator = row.kind === 'bond' ? row.from_addr : row.to_addr;
    out.amount = near(s.amount, row.amount_num) ? 'same' : 'differs';
    if (out.amount === 'differs') out.eventAmount = s.amount;
    out.sides = delegator && delegator === (s.source ?? s.validator) ? 'same' : 'differs';
    return out;
  }
  if (TOKEN_KINDS.has(row.kind)) {
    const evs = b.tokens.filter((t) => t.inner === inner);
    if (!evs.length) out.amount = 'no_event';
    else {
      const atTarget = row.to_addr ? evs.map((t) => t.targets[row.to_addr!]).find((v) => v != null) : undefined;
      const atSource = row.from_addr ? evs.map((t) => t.sources[row.from_addr!]).find((v) => v != null) : undefined;
      if ((atTarget != null && near(atTarget, row.amount_num)) || (atSource != null && near(atSource, row.amount_num))) out.amount = 'same';
      else { out.amount = 'differs'; out.eventAmount = atTarget ?? atSource; }
    }
  } else if (POS_KINDS.has(row.kind)) {
    const delegator = row.kind === 'bond' ? row.from_addr : row.to_addr;
    out.sides = delegator && found.res.posKeys.some((k) => k.startsWith(`${delegator}|`)) ? 'same' : 'differs';
  }
  return out;
}

// ------------------------------------------------------------------ tx bytes
/**
 * The checksums of the staking code the chain runs, as worker/src/parse/namada-pos.ts lists them (BOND_CODE_HASHES,
 * UNBOND_CODE_HASHES, OTHER_POS_CODES; from indexer.namada.net /chain/parameters checksums.current, read 2026-10-23):
 * a known checksum names its wasm whatever tag the signer wrote. That module imports the Worker's config without an
 * extension and cannot be loaded by node directly, so the four are repeated here.
 */
export const POS_CODES: ReadonlyMap<string, string> = new Map([
  ['490CF419BDBFFE616C6AA6C72D38064E350EE65FB04D92472CCF285AEC6844B6', 'tx_bond.wasm'],
  ['36E774350B865752C9D309D518223ABF0A60374BAE15A1F73DFE4721B5887048', 'tx_unbond.wasm'],
  ['7D5AD1877643F7D9B32A511EF93A11E8503426BAEE0F5986D29E3F63A2355D58', 'tx_redelegate.wasm'],
  ['A8686AE87AA940E3C45ADB79CB5E1DAA71033D41FE85F6B32713AE3CEF21FF25', 'tx_withdraw.wasm'],
]);

/** The Worker's transaction decoder (worker/src/parse/namada-tx.ts), as this script uses it. */
export interface Decoder {
  decodeNamadaTx(raw: Uint8Array): { wrapperHash: string; atomic: boolean; commitments: { innerHash: string; codeHash: string; dataHash: string }[]; codes: Map<string, { tag: string | null; codeHash: string }>; data: Map<string, Uint8Array> };
  decodeBond(data: Uint8Array): { validator: string; amount: bigint; source: string | null };
  txBytesFromBase64(b64: string): Uint8Array;
}

/** The decoder, or null when node cannot load it (strip-only mode refuses its constructor parameter property). */
export async function loadDecoder(): Promise<Decoder | null> {
  try { return (await import('../worker/src/parse/namada-tx.ts')) as unknown as Decoder; } catch { return null; }
}

/** A /block answer reduced to its wrappers' atomic flags and inner transactions (a bond's or an unbond's request decoded). */
export function reduceTxs(answer: any, height: number, node: string, dec: Decoder, readAt = Date.now()): TxSummary | null {
  const blk = answer?.result?.block;
  if (!blk || Number(blk.header?.height) !== height) return null;
  const txs: unknown[] = Array.isArray(blk.data?.txs) ? blk.data.txs : [];
  const out: TxSummary = { height, node, readAt, nTxs: txs.length, wrappers: {}, decodeErrors: 0 };
  for (const b64 of txs) {
    if (typeof b64 !== 'string') { out.decodeErrors++; continue; }
    try {
      const tx = dec.decodeNamadaTx(dec.txBytesFromBase64(b64));
      const w: WrapperTx = { atomic: tx.atomic, inners: {} };
      for (const c of tx.commitments) {
        const code = tx.codes.get(c.codeHash);
        const name = code ? POS_CODES.get(code.codeHash) ?? code.tag : null;
        let stake: InnerTx['stake'] = null;
        const data = tx.data.get(c.dataHash);
        if (data && (name === 'tx_bond.wasm' || name === 'tx_unbond.wasm')) {
          try { const s = dec.decodeBond(data); stake = { validator: s.validator, amount: Number(s.amount) / 1e6, source: s.source }; } catch { stake = null; }
        }
        w.inners[c.innerHash.toUpperCase()] = { tag: name, codeHash: code?.codeHash ?? '', stake };
      }
      out.wrappers[tx.wrapperHash.toUpperCase()] = w;
    } catch { out.decodeErrors++; }
  }
  return out;
}

/** Two nodes gave the same transactions when every wrapper's flag and decoded inner transactions are the same. */
export const txsKey = (t: TxSummary): string => JSON.stringify({
  n: t.nTxs,
  w: Object.entries(t.wrappers).sort(([p], [q]) => (p < q ? -1 : 1)).map(([h, w]) => [h, w.atomic, Object.entries(w.inners).sort(([p], [q]) => (p < q ? -1 : 1))]),
});

// ------------------------------------------------------------------ duplicates
export interface Dup { kept: string; dropped: string; kind: string; height: number; amount: number; why: 'same inner tx' | 'relay repeat' }
/** The IBC packet a live row records (meta.packetSequence, with its channel), or null for a row without one (the indexer import's). */
export function packetOf(r: Row): string | null {
  try {
    const m = JSON.parse(r.meta ?? '{}');
    return m.packetSequence != null ? `${m.channel ?? ''}/${m.packetSequence}` : null;
  } catch { return null; }
}

/**
 * Rows recorded twice among the era's Namada rows: two rows of one inner transaction with the same kind, ends and
 * amount (the same move written by two sources or twice by one), and a bridge leg that repeats an earlier one with the
 * same kind, ends and amount within RELAY_REPEAT_BLOCKS (the repeated relay rule of 2026-10-17), unless the two rows
 * name different IBC packets (meta.packetSequence, which the live reader records: two sends of the same amount a few
 * blocks apart are two crossings, not one relayed twice). The earlier row (lowest height, then id) is the one kept.
 */
export function duplicates(rows: Row[]): Dup[] {
  const sorted = [...rows].sort((a, b) => a.height - b.height || (a.id < b.id ? -1 : 1));
  const out: Dup[] = [];
  const byMove = new Map<string, Row>();
  const relays = new Map<string, Row[]>();
  for (const r of sorted) {
    const move = [r.tx_hash.toUpperCase(), r.kind, r.from_addr, r.to_addr, r.amount_num].join('|');
    const first = byMove.get(move);
    if (first) { out.push({ kept: first.id, dropped: r.id, kind: r.kind, height: r.height, amount: r.amount_num, why: 'same inner tx' }); continue; }
    byMove.set(move, r);
    if (r.kind === 'ibc_in' || r.kind === 'ibc_out') {
      const k = [r.kind, r.from_addr, r.to_addr, r.amount_num].join('|');
      const earlier = relays.get(k) ?? [];
      const packet = packetOf(r);
      const rep = earlier.find((e) => r.height - e.height <= RELAY_REPEAT_BLOCKS && r.height > e.height && (packet == null || packetOf(e) == null || packetOf(e) === packet));
      if (rep) out.push({ kept: rep.id, dropped: r.id, kind: r.kind, height: r.height, amount: r.amount_num, why: 'relay repeat' });
      else relays.set(k, [...earlier, r]);
    }
  }
  return out;
}

// ------------------------------------------------------------------ sql
const CATS = new Set(['genesis', 'backer', 'foundation', 'pool', 'pos', 'masp', 'ibc', 'module']);
/** worker/src/series.ts sideCategory, for the edge a row was counted in (the series module cannot be loaded without a bundler). */
export function sideCategory(addr: string | null, label: { category: string; source: string } | undefined): string {
  if (!addr) return 'unknown';
  const internal = INTERNAL_LABELS[addr]?.category;
  if (internal) return internal;
  if (label && CATS.has(label.category) && label.source !== 'user') return label.category;
  if (addr.startsWith('osmo1')) return 'osmosis';
  return 'user';
}
export const q = (v: unknown): string => v === null || v === undefined ? 'NULL' : typeof v === 'number' ? (Number.isFinite(v) ? String(v) : 'NULL') : `'${String(v).replace(/'/g, "''")}'`;
export const dayOf = (ts: number) => new Date(ts).toISOString().slice(0, 10);

/** The statements migration 0020 modelled, for one row the chain did not apply. */
export function sqlForRow(r: Row, labels: Map<string, { category: string; source: string }>): string[] {
  const day = dayOf(r.ts);
  const fc = sideCategory(r.from_addr, labels.get(r.from_addr ?? '')), tc = sideCategory(r.to_addr, labels.get(r.to_addr ?? ''));
  const amt = `(SELECT amount_num FROM flows WHERE id = ${q(r.id)})`;
  const exists = `EXISTS (SELECT 1 FROM flows WHERE id = ${q(r.id)})`;
  const edge = `day = ${q(day)} AND chain = 'namada' AND kind = ${q(r.kind)} AND from_cat = ${q(fc)} AND to_cat = ${q(tc)}`;
  return [
    `UPDATE activity_daily SET flows = flows - 1, nam = nam - ${amt} WHERE day = ${q(day)} AND chain = 'namada' AND ${exists};`,
    `UPDATE flow_edges_daily SET n = n - 1, nam = nam - ${amt} WHERE ${edge} AND ${exists};`,
    `DELETE FROM flow_edges_daily WHERE ${edge} AND n <= 0;`,
    `DELETE FROM flows WHERE id = ${q(r.id)};`,
  ];
}

/** cron.ts STAKE_ESTIMATES_SQL for one address, as migration 0020 wrote it. */
export const stakeEstimateSql = (address: string) =>
  `UPDATE stakes SET estimated_num = (SELECT SUM(CASE WHEN kind = 'bond' THEN amount_num ELSE -amount_num END) FROM flows WHERE chain = 'namada' AND ((kind = 'bond' AND from_addr = stakes.address) OR (kind = 'unbond' AND to_addr = stakes.address))) WHERE address = ${q(address)};`;

// ------------------------------------------------------------------ main
const OUT = join(import.meta.dirname, 'out', 'indexer_recheck');
const BLOCKS = join(OUT, 'blocks');
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

async function getJson(url: string, tries = 4): Promise<any> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(25000) });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) { last = e; await sleep(1000 * 2 ** i); }
  }
  throw last;
}

const short = (node: string) => node.replace(/^https?:\/\//, '').replace(/[^a-z0-9.-]/gi, '_');

/** The era's indexer rows, read once from D1 (paged by height and id) and cached as ndjson. */
function readRows(kinds: string[], refresh: boolean): Row[] {
  mkdirSync(OUT, { recursive: true });
  const out: Row[] = [];
  for (const kind of kinds) {
    const f = join(OUT, `rows_${kind}.ndjson`);
    if (existsSync(f) && !refresh) {
      for (const line of readFileSync(f, 'utf8').split('\n')) if (line) out.push(JSON.parse(line));
      continue;
    }
    const rows: Row[] = [];
    let h = -1, id = '';
    for (;;) {
      const page = d1<Row>(`SELECT id, height, ts, tx_hash, kind, from_addr, to_addr, amount_num, meta FROM flows
        WHERE chain = 'namada' AND kind = '${kind}' AND json_extract(meta, '$.source') = 'namada-indexer'
          AND (height > ${h} OR (height = ${h} AND id > '${id.replace(/'/g, "''")}'))
        ORDER BY height, id LIMIT 4000`);
      rows.push(...page);
      if (page.length < 4000) break;
      h = page[page.length - 1].height; id = page[page.length - 1].id;
    }
    writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
    log(`${kind}: ${rows.length} indexer rows read from D1`);
    out.push(...rows);
  }
  return out;
}

/** Every Namada row of the era whatever its source (for the duplicate check and the bridge totals), cached. */
function readEraRows(refresh: boolean): Row[] {
  const f = join(OUT, 'rows_era_all.ndjson');
  if (existsSync(f) && !refresh) return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const rows: Row[] = [];
  let h = -1, id = '';
  for (;;) {
    const page = d1<Row>(`SELECT id, height, ts, tx_hash, kind, from_addr, to_addr, amount_num, meta FROM flows
      WHERE chain = 'namada' AND height <= ${INDEXER_LAST_HEIGHT} AND (height > ${h} OR (height = ${h} AND id > '${id.replace(/'/g, "''")}'))
      ORDER BY height, id LIMIT 4000`);
    rows.push(...page);
    if (page.length < 4000) break;
    h = page[page.length - 1].height; id = page[page.length - 1].id;
  }
  writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  log(`era: ${rows.length} Namada rows up to block ${INDEXER_LAST_HEIGHT} (every source)`);
  return rows;
}

function cachedBlock(node: string, h: number): ReducedBlock | null {
  const f = join(BLOCKS, short(node), `${h}.json`);
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; }
}

async function fetchBlock(node: string, h: number): Promise<ReducedBlock | null> {
  const have = cachedBlock(node, h);
  if (have) return have;
  const ans = await getJson(`${node}/block_results?height=${h}`);
  const red = reduceBlock(ans, h, node);
  if (!red) return null;
  mkdirSync(join(BLOCKS, short(node)), { recursive: true });
  writeFileSync(join(BLOCKS, short(node), `${h}.json`), JSON.stringify(red));
  return red;
}

/** The blocks of each node for a height, when both are cached: the pair, 'disagree', or null when one is missing. */
function blocksOf(nodes: string[], h: number): ReducedBlock[] | 'disagree' | null {
  const bs = nodes.map((n) => cachedBlock(n, h));
  if (bs.some((b) => !b)) return null;
  const keys = new Set(bs.map((b) => blockKey(b!)));
  return keys.size === 1 ? (bs as ReducedBlock[]) : 'disagree';
}

async function readBlocks(nodes: string[], heights: number[], conc: number, stop: { now: boolean }) {
  const want = heights.filter((h) => nodes.some((n) => !cachedBlock(n, h)));
  log(`${want.length} of ${heights.length} blocks to read (${heights.length - want.length} cached)`);
  const failed = new Map<string, number>();
  let done = 0;
  const t0 = Date.now();
  await Promise.all(nodes.map(async (node) => {
    let i = 0;
    await Promise.all(Array.from({ length: conc }, async () => {
      while (i < want.length && !stop.now) {
        const h = want[i++];
        if (cachedBlock(node, h)) continue;
        try { await fetchBlock(node, h); } catch (e) { failed.set(node, (failed.get(node) ?? 0) + 1); appendFileSync(join(OUT, 'failed.log'), `${new Date().toISOString()} ${node} ${h} ${String((e as Error).message ?? e).slice(0, 100)}\n`); }
        if (++done % 500 === 0) {
          const s = (Date.now() - t0) / 1000;
          log(`  ${done}/${want.length * nodes.length} reads · ${s.toFixed(0)} s · ${(done / s).toFixed(1)}/s · failed ${[...failed].map(([n, k]) => `${short(n)} ${k}`).join(', ') || 'none'}`);
        }
      }
    }));
  }));
  log(`blocks read: ${done} reads, failed ${[...failed].map(([n, k]) => `${short(n)} ${k}`).join(', ') || 'none'}`);
}

// ---- the tx bytes of the blocks whose batch code is not 0 though the row's own result is Ok
const TXS = join(OUT, 'blocks_txs');

function cachedTxs(node: string, h: number): TxSummary | null {
  const f = join(TXS, short(node), `${h}.json`);
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; }
}

async function fetchTxs(node: string, h: number, dec: Decoder): Promise<TxSummary | null> {
  const have = cachedTxs(node, h);
  if (have) return have;
  const red = reduceTxs(await getJson(`${node}/block?height=${h}`), h, node, dec);
  if (!red) return null;
  mkdirSync(join(TXS, short(node)), { recursive: true });
  writeFileSync(join(TXS, short(node), `${h}.json`), JSON.stringify(red));
  return red;
}

function txsOf(nodes: string[], h: number): TxSummary[] | 'disagree' | null {
  const ts = nodes.map((n) => cachedTxs(n, h));
  if (ts.some((t) => !t)) return null;
  const keys = new Set(ts.map((t) => txsKey(t!)));
  return keys.size === 1 ? (ts as TxSummary[]) : 'disagree';
}

/** The heights among `rows` whose judgement needs the tx bytes (needsTxs), from the cached blocks. */
function heightsNeedingTxs(nodes: string[], rows: Row[]): number[] {
  const out = new Set<number>();
  for (const r of rows) {
    const bs = blocksOf(nodes, r.height);
    if (!bs || bs === 'disagree') continue;
    const inner = r.tx_hash.toUpperCase();
    for (const ev of bs[0].applied) if (ev.batch?.[inner] && needsTxs(ev, ev.batch[inner])) { out.add(r.height); break; }
  }
  return [...out].sort((a, b) => a - b);
}

async function readTxs(nodes: string[], heights: number[], conc: number, stop: { now: boolean }, dec: Decoder) {
  const want = heights.filter((h) => nodes.some((n) => !cachedTxs(n, h)));
  log(`tx bytes: ${want.length} of ${heights.length} blocks to read (${heights.length - want.length} cached)`);
  let done = 0, failed = 0;
  await Promise.all(nodes.map(async (node) => {
    let i = 0;
    await Promise.all(Array.from({ length: conc }, async () => {
      while (i < want.length && !stop.now) {
        const h = want[i++];
        if (cachedTxs(node, h)) continue;
        try { await fetchTxs(node, h, dec); } catch (e) { failed++; appendFileSync(join(OUT, 'failed.log'), `${new Date().toISOString()} ${node} block ${h} ${String((e as Error).message ?? e).slice(0, 100)}\n`); }
        if (++done % 200 === 0) log(`  tx bytes ${done}/${want.length * nodes.length} reads · failed ${failed}`);
      }
    }));
  }));
  log(`tx bytes read: ${done} reads, failed ${failed}`);
}

const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 6 });
const fmtNam = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 6, maximumFractionDigits: 6 });

function writeOutputs(opts: { judged: Judged[]; era: Row[]; dups: Dup[]; labels: Map<string, { category: string; source: string }>; nodes: string[]; report: string; sql: string; phase: string; partial: boolean }) {
  const { judged, era, dups, labels, nodes, phase } = opts;
  const date = new Date().toISOString().slice(0, 10);
  const kinds = [...new Set(judged.map((j) => j.row.kind))].sort((a, b) => (POS_KINDS.has(a) === POS_KINDS.has(b) ? (a < b ? -1 : 1) : POS_KINDS.has(a) ? -1 : 1));
  const by = (k: string) => judged.filter((j) => j.row.kind === k);
  const count = (js: Judged[], s: Verdict['state']) => js.filter((j) => j.verdict.state === s).length;
  const notApplied = judged.filter((j) => j.verdict.state === 'not_applied').sort((a, b) => a.row.height - b.row.height);
  const notInBlock = judged.filter((j) => j.verdict.state === 'not_in_block');
  const differs = judged.filter((j) => j.amount === 'differs' || j.sides === 'differs');
  const dupIds = new Set(dups.map((d) => d.dropped));
  const L: string[] = [];
  L.push(`# Indexer-era rows checked against the chain's blocks, ${date}${opts.partial ? ' (partial run)' : ''}`);
  L.push('');
  L.push(`Made by \`scripts/recheck-indexer-rows.ts ${phase}\`. Each row the import from indexer.namada.net wrote (\`flows\`, meta.source 'namada-indexer') was judged by its block's own \`tx/applied\` event as two public nodes gave it (${nodes.join(', ')}; \`/block_results\`, read ${date}): applied only when the event's code is 0, the inner transaction's batch result is Ok and \`vps_result.rejected_vps\` is empty, and only when both nodes gave the same event. Rows the chain did not apply are listed below and in \`scripts/out/indexer_recheck.sql\` (not in the repository) with the statements migration 0020 modelled, for the operator to review and apply. Nothing here was written to the database.`);
  L.push('');
  L.push('## Counts by kind');
  L.push('');
  L.push('| kind | rows | blocks | applied | not applied | not in block | nodes disagree | not read | batch not read |');
  L.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  const line = (name: string, js: Judged[]) => `| ${name} | ${fmt(js.length)} | ${fmt(new Set(js.map((j) => j.row.height)).size)} | ${fmt(count(js, 'applied'))} | ${fmt(count(js, 'not_applied'))} | ${fmt(count(js, 'not_in_block'))} | ${fmt(count(js, 'disagree'))} | ${fmt(count(js, 'unread'))} | ${fmt(count(js, 'batch_unread'))} |`;
  for (const k of kinds) L.push(line(k, by(k)));
  L.push(line('all', judged));
  L.push('');
  L.push('"Not in block": the block\'s tx/applied events name no batch result for the row\'s inner transaction hash. "Not read": a node did not answer for the block within the run\'s tries (scripts/out/indexer_recheck/failed.log names them); such rows are judged on the next run, which reads only what is missing. "Batch not read": the row\'s own result is Ok and no validity predicate rejected it, but another inner transaction of its batch failed, so the wrapper\'s atomic flag in the transaction bytes decides, and those bytes were not read for it (the same next run reads them).');
  L.push('');
  const sibling = judged.filter((j) => (j.verdict.state === 'applied' && j.verdict.note) || (j.verdict.state === 'not_applied' && j.verdict.reason.startsWith('another inner transaction')));
  if (sibling.length || count(judged, 'batch_unread')) {
    const kept = sibling.filter((j) => j.verdict.state === 'applied'), dropped = sibling.filter((j) => j.verdict.state === 'not_applied');
    L.push(`Batches with a failed inner transaction: ${fmt(sibling.length + count(judged, 'batch_unread'))} rows sit in a wrapper whose code is not 0 although their own result is Ok (another inner transaction of the batch failed). Read from the transaction bytes: ${fmt(kept.length)} are in a batch that is not atomic, so their writes stand and they count as applied (${fmtNam(kept.reduce((a, j) => a + j.row.amount_num, 0))} NAM); ${fmt(dropped.length)} are in an atomic batch, which the chain dropped whole (${fmtNam(dropped.reduce((a, j) => a + j.row.amount_num, 0))} NAM); ${fmt(count(judged, 'batch_unread'))} were not read. The indexer's exit code for all of them read "applied".`);
    L.push('');
  }
  L.push('## Rows the chain did not apply');
  L.push('');
  if (!notApplied.length) L.push('None among the rows read.');
  else {
    const sum = notApplied.reduce((a, j) => a + j.row.amount_num, 0);
    L.push(`${fmt(notApplied.length)} rows, ${fmtNam(sum)} NAM in all. The row's day is the UTC day of its stored time (interpolated between block anchors for most indexer rows, as the daily rows that counted it used).`);
    L.push('');
    L.push('| kind | block | day | NAM | why the chain did not apply it |');
    L.push('|---|---:|---|---:|---|');
    for (const j of notApplied) L.push(`| ${j.row.kind} | ${fmt(j.row.height)} | ${dayOf(j.row.ts)} | ${fmtNam(j.row.amount_num)} | ${(j.verdict as { reason: string }).reason} |`);
    L.push('');
    const perKind = new Map<string, { n: number; nam: number }>();
    for (const j of notApplied) { const e = perKind.get(j.row.kind) ?? { n: 0, nam: 0 }; e.n++; e.nam += j.row.amount_num; perKind.set(j.row.kind, e); }
    L.push('By kind: ' + [...perKind].map(([k, v]) => `${k} ${fmt(v.n)} rows, ${fmtNam(v.nam)} NAM`).join('; ') + '.');
  }
  L.push('');
  L.push('## Rows the block does not name');
  L.push('');
  L.push(notInBlock.length ? `${fmt(notInBlock.length)} rows (${fmtNam(notInBlock.reduce((a, j) => a + j.row.amount_num, 0))} NAM) whose inner transaction hash is in no tx/applied batch of the stored block on either node. They are listed by height in the SQL file's comments and are not deleted: a row the chain shows nowhere needs a look at the indexer's record of it first.` : 'None among the rows read.');
  L.push('');
  L.push('## Rows recorded twice');
  L.push('');
  if (!dups.length) L.push(`None among the ${fmt(era.length)} Namada rows up to block ${fmt(INDEXER_LAST_HEIGHT)} (every source).`);
  else {
    const same = dups.filter((d) => d.why === 'same inner tx'), relay = dups.filter((d) => d.why === 'relay repeat');
    L.push(`Among the ${fmt(era.length)} Namada rows up to block ${fmt(INDEXER_LAST_HEIGHT)} (every source): ${fmt(same.length)} rows repeat an earlier row of the same inner transaction with the same kind, ends and amount (${fmtNam(same.reduce((a, d) => a + d.amount, 0))} NAM), and ${fmt(relay.length)} bridge rows repeat an earlier row with the same kind, ends and amount within ${RELAY_REPEAT_BLOCKS} blocks (${fmtNam(relay.reduce((a, d) => a + d.amount, 0))} NAM), the repeated-relay rule of 2026-10-17. The later row of each pair is named in the SQL file's comments; none is deleted by it (which row of a pair to keep is the operator's call).`);
    L.push('');
    const perKind = new Map<string, { n: number; nam: number }>();
    for (const d of dups) { const e = perKind.get(d.kind) ?? { n: 0, nam: 0 }; e.n++; e.nam += d.amount; perKind.set(d.kind, e); }
    L.push('By kind: ' + [...perKind].map(([k, v]) => `${k} ${fmt(v.n)} rows, ${fmtNam(v.nam)} NAM`).join('; ') + '.');
  }
  L.push('');
  L.push('## Rows whose amount or sides differ from the block');
  L.push('');
  const amtRows = judged.filter((j) => j.amount != null && TOKEN_KINDS.has(j.row.kind));
  const posAmt = judged.filter((j) => j.amount != null && POS_KINDS.has(j.row.kind));
  const sideRows = judged.filter((j) => j.sides != null);
  L.push(`Transfer-like rows (transfer, shield, unshield, ibc_in, ibc_out): ${fmt(amtRows.length)} compared with the block's token/transfer event of the same inner transaction; ${fmt(amtRows.filter((j) => j.amount === 'same').length)} carry the event's NAM at their side, ${fmt(amtRows.filter((j) => j.amount === 'differs').length)} do not, ${fmt(amtRows.filter((j) => j.amount === 'no_event').length)} have no such event in the block. Bond and unbond rows: the amount is in the transaction bytes, read only for the blocks whose batch code is not 0 (above): ${fmt(posAmt.length)} rows compared with the decoded request, ${fmt(posAmt.filter((j) => j.amount === 'same').length)} the same, ${fmt(posAmt.filter((j) => j.amount === 'differs').length)} not; the other ${fmt(sideRows.length - posAmt.length)} were checked for their delegator against the staking keys the inner transaction changed. In all, ${fmt(sideRows.filter((j) => j.sides === 'differs').length)} bond or unbond rows name a delegator the chain does not.`);
  if (differs.length) {
    L.push('');
    L.push('| kind | block | row NAM | event NAM at the row\'s side | verdict |');
    L.push('|---|---:|---:|---:|---|');
    for (const j of differs.slice(0, 200)) L.push(`| ${j.row.kind} | ${fmt(j.row.height)} | ${fmtNam(j.row.amount_num)} | ${j.eventAmount != null ? fmtNam(j.eventAmount) : j.sides === 'differs' ? 'delegator not in the changed keys' : 'none'} | ${j.verdict.state.replace('_', ' ')} |`);
    if (differs.length > 200) L.push(`| … | ${fmt(differs.length - 200)} more | | | |`);
  }
  L.push('');
  // the bridge totals of the era
  const eraIbc = era.filter((r) => r.kind === 'ibc_in' || r.kind === 'ibc_out');
  const src = (r: Row) => { try { return String(JSON.parse(r.meta ?? '{}').source ?? 'no source in meta (the live reader)'); } catch { return 'no source in meta (the live reader)'; } };
  const sum = (rs: Row[]) => rs.reduce((a, r) => a + r.amount_num, 0);
  const notAppliedIds = new Set(notApplied.map((j) => j.row.id));
  L.push('## The bridge totals of the era');
  L.push('');
  L.push(`Namada's own records of NAM crossing the bridge up to block ${fmt(INDEXER_LAST_HEIGHT)}, by the source that wrote the row (the indexer import, the block_results scan of the shielded pool's legs, the live reader):`);
  L.push('');
  L.push('| kind | source | rows | NAM | rows the chain did not apply | NAM of them | rows recorded twice | NAM of them |');
  L.push('|---|---|---:|---:|---:|---:|---:|---:|');
  for (const kind of ['ibc_in', 'ibc_out']) {
    const srcs = [...new Set(eraIbc.filter((r) => r.kind === kind).map(src))].sort();
    for (const s of srcs) {
      const rs = eraIbc.filter((r) => r.kind === kind && src(r) === s);
      const na = rs.filter((r) => notAppliedIds.has(r.id)), du = rs.filter((r) => dupIds.has(r.id));
      L.push(`| ${kind} | ${s} | ${fmt(rs.length)} | ${fmtNam(sum(rs))} | ${fmt(na.length)} | ${fmtNam(sum(na))} | ${fmt(du.length)} | ${fmtNam(sum(du))} |`);
    }
    const rs = eraIbc.filter((r) => r.kind === kind);
    const na = rs.filter((r) => notAppliedIds.has(r.id)), du = rs.filter((r) => dupIds.has(r.id));
    L.push(`| ${kind} | all | ${fmt(rs.length)} | ${fmtNam(sum(rs))} | ${fmt(na.length)} | ${fmtNam(sum(na))} | ${fmt(du.length)} | ${fmtNam(sum(du))} |`);
  }
  const inAll = eraIbc.filter((r) => r.kind === 'ibc_in'), outAll = eraIbc.filter((r) => r.kind === 'ibc_out');
  const inAfter = inAll.filter((r) => !notAppliedIds.has(r.id) && !dupIds.has(r.id)), outAfter = outAll.filter((r) => !notAppliedIds.has(r.id) && !dupIds.has(r.id));
  L.push('');
  const idx = (rs: Row[]) => rs.filter((r) => src(r) === 'namada-indexer'), scan = (rs: Row[]) => rs.filter((r) => src(r) === 'namada-rpc-block-results');
  L.push(`The import's own rows: ${fmtNam(sum(idx(inAll)))} NAM in against ${fmtNam(sum(idx(outAll)))} NAM out, a difference of ${fmtNam(sum(idx(inAll)) - sum(idx(outAll)))} NAM; with the shielded pool's legs the block_results scan added on 2026-10-17 (${fmtNam(sum(scan(outAll)))} NAM out, ${fmtNam(sum(scan(inAll)))} NAM in), ${fmtNam((sum(idx(inAll)) + sum(scan(inAll))) - (sum(idx(outAll)) + sum(scan(outAll))))} NAM. Every row of the era: ${fmtNam(sum(inAll))} NAM in, ${fmtNam(sum(outAll))} NAM out, a difference of ${fmtNam(sum(inAll) - sum(outAll))} NAM.`);
  L.push('');
  L.push(`What this check changes: the rows the chain did not apply are ${fmtNam(sum(inAll.filter((r) => notAppliedIds.has(r.id))))} NAM of the in rows and ${fmtNam(sum(outAll.filter((r) => notAppliedIds.has(r.id))))} NAM of the out rows; the rows recorded twice ${fmtNam(sum(inAll.filter((r) => dupIds.has(r.id))))} NAM in and ${fmtNam(sum(outAll.filter((r) => dupIds.has(r.id))))} NAM out. Without them: ${fmtNam(sum(inAfter))} NAM in, ${fmtNam(sum(outAfter))} NAM out, a difference of ${fmtNam(sum(inAfter) - sum(outAfter))} NAM. The rest of the difference is not explained by this check: it compares each stored row with its block, and cannot see a crossing no row records (docs/decisions.md, "Namada-side IBC outflows look under-recorded"). ${notApplied.length ? 'Whether the indexer-era rows then balance against the escrow is for the ibc_conservation check to say once the operator has applied the SQL.' : 'The SQL file deletes nothing, so the ibc_conservation check reads the same rows as before.'}`);
  L.push('');
  L.push('## Method and limits');
  L.push('');
  L.push(`- One \`/block_results\` read per distinct block per node, cached under scripts/out/indexer_recheck/blocks/ (not in the repository). Both nodes must give the same tx/applied verdicts and token events for a block, event order aside; a block they differ on judges its rows "nodes disagree" and nothing is deleted for them.`);
  L.push('- The judgement is the live decoders\' rule (worker/src/parse/namada-pos.ts): the wrapper event\'s code 0, the inner transaction\'s result Ok, no rejecting validity predicate. A wrapper\'s code is one for its whole batch, so a row whose own result is Ok inside a wrapper whose code is not 0 (another inner transaction failed) is judged by the wrapper\'s atomic flag, read from the block\'s `/block` transaction bytes on both nodes (cached under blocks_txs/) and decoded with the Worker\'s own decoder: atomic, the chain dropped the whole batch; not atomic, the row\'s writes stand.');
  L.push('- A bond\'s or an unbond\'s amount is in the transaction bytes too: it is compared for the rows whose bytes that step read, and the other rows\' delegator is checked against the staking keys the inner transaction changed instead.');
  L.push('- "Event NAM at the row\'s side: none" means neither side of the row is a NAM account of the block\'s token event for that inner transaction. For an ibc_out row the import marked shielded (an `ibcUnshieldingTransfer`), the indexer named the fee payer as the source where the chain\'s event names the shielded pool, as docs/decisions.md recorded on 2026-10-17; the amount itself is the event\'s. An ibc_in row with no token event of its inner transaction is a bridge receipt whose NAM the chain credited under the relay\'s own event; the row stands on the indexer\'s record of the receipt.');
  L.push('- A "relay repeat" is the importer\'s rule (the same kind, ends and amount within 20 blocks), not proof: where both rows record their IBC packet (the live reader\'s meta.packetSequence) and the packets differ, the rows are two crossings and are not listed; rows without a packet (the indexer import\'s) are listed by the rule alone, for the operator to look at.');
  L.push('- The SQL subtracts a row from the day\'s activity_daily (flows, nam) and flow_edges_daily (n, nam) rows as migration 0020 did. The day\'s distinct-address counts (senders, receivers, active) are not changed by subtraction; the days touched are listed in the SQL file for a rebuild with the cron\'s own code when the operator wants them exact. activity_daily holds Namada rows from 2026-08-14 only; flow_edges_daily since 2024-12-03.');
  L.push('');
  mkdirSync(join(opts.report, '..'), { recursive: true });
  writeFileSync(opts.report, L.join('\n') + '\n');

  // the SQL
  const S: string[] = [];
  S.push(`-- scripts/recheck-indexer-rows.ts ${phase}, ${date}${opts.partial ? ' (partial run)' : ''}: rows the indexer import wrote that the chain did not apply`);
  S.push(`-- (both ${nodes.map(short).join(' and ')} gave the block's tx/applied event so), with the daily-row corrections migration 0020 modelled.`);
  S.push(`-- Review, then: npm run db:apply scripts/out/indexer_recheck.sql. Each statement is a no-op once its row is gone.`);
  S.push(`-- ${fmt(notApplied.length)} rows, ${fmtNam(notApplied.reduce((a, j) => a + j.row.amount_num, 0))} NAM.`);
  const days = new Set<string>(), delegators = new Set<string>();
  for (const j of notApplied) {
    S.push(`-- block ${j.row.height}, ${j.row.kind}, ${fmtNam(j.row.amount_num)} NAM: ${(j.verdict as { reason: string }).reason}`);
    S.push(...sqlForRow(j.row, labels));
    days.add(dayOf(j.row.ts));
    const d = j.row.kind === 'bond' ? j.row.from_addr : j.row.kind === 'unbond' ? j.row.to_addr : null;
    if (d && d !== POS) delegators.add(d);
  }
  if (delegators.size) {
    S.push(`-- The stake estimate of each delegator whose bond or unbond rows change, computed again from the rows that stay (cron.ts STAKE_ESTIMATES_SQL).`);
    for (const d of [...delegators].sort()) S.push(stakeEstimateSql(d));
  }
  if (days.size) S.push(`-- Days whose activity_daily distinct-address counts (senders, receivers, active) were not changed by subtraction and can be rebuilt with the cron's own code: ${[...days].sort().join(', ')}`);
  if (notInBlock.length) {
    S.push(`-- Rows whose inner transaction hash the stored block does not name on either node (not deleted; look at the indexer's record first):`);
    for (const j of notInBlock.sort((a, b) => a.row.height - b.row.height)) S.push(`--   ${j.row.id} block ${j.row.height} ${j.row.kind} ${fmtNam(j.row.amount_num)} NAM`);
  }
  if (dups.length) {
    S.push(`-- Rows recorded twice (not deleted; the earlier row of each pair is named first):`);
    for (const d of dups) S.push(`--   keep ${d.kept}  repeat ${d.dropped}  (${d.why}, ${d.kind}, block ${d.height}, ${fmtNam(d.amount)} NAM)`);
  }
  mkdirSync(join(opts.sql, '..'), { recursive: true });
  writeFileSync(opts.sql, S.join('\n') + '\n');
  log(`report ${opts.report}; sql ${opts.sql} (${notApplied.length} rows the chain did not apply)`);
}

async function main() {
  const phase = process.argv[2];
  if (!['pos', 'rest', 'all'].includes(phase ?? '')) { console.error('usage: recheck-indexer-rows.ts pos|rest|all [--conc 3] [--report file.md] [--sql file.sql] [--nodes a,b] [--refresh]'); process.exit(1); }
  const nodes = arg('nodes', DEFAULT_NODES.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
  if (nodes.length !== 2) { console.error('two nodes are needed'); process.exit(1); }
  const conc = Math.max(1, Math.min(8, Number(arg('conc', '3')) || 3));
  const date = new Date().toISOString().slice(0, 10);
  const report = arg('report', join(import.meta.dirname, '..', 'docs', 'data', `indexer-recheck-${date}.md`));
  const sql = arg('sql', join(import.meta.dirname, 'out', 'indexer_recheck.sql'));
  const refresh = process.argv.includes('--refresh');
  mkdirSync(BLOCKS, { recursive: true });

  const posKinds = ['bond', 'unbond'], restKinds = ['transfer', 'unshield', 'shield', 'ibc_in', 'ibc_out'];
  const kinds = phase === 'pos' ? posKinds : phase === 'rest' ? restKinds : [...posKinds, ...restKinds];
  const rows = readRows(kinds, refresh);
  const era = readEraRows(refresh);
  log(`${rows.length} rows of kinds ${kinds.join(', ')}; ${new Set(rows.map((r) => r.height)).size} distinct blocks`);

  const stop = { now: false };
  let wrote = false;
  const finish = (partial: boolean) => {
    if (wrote) return;
    wrote = true;
    const judged = rows.map((r) => judge(r, blocksOf(nodes, r.height), txsOf(nodes, r.height)));
    const dups = duplicates(era);
    const addrs = new Set<string>();
    for (const j of judged) if (j.verdict.state === 'not_applied') { if (j.row.from_addr) addrs.add(j.row.from_addr); if (j.row.to_addr) addrs.add(j.row.to_addr); }
    const labels = new Map<string, { category: string; source: string }>();
    const list = [...addrs];
    for (let i = 0; i < list.length; i += 200) {
      for (const r of d1<{ address: string; category: string; source: string }>(`SELECT address, category, source FROM labels WHERE address IN (${list.slice(i, i + 200).map((a) => q(a)).join(',')})`)) labels.set(r.address, { category: r.category, source: r.source });
    }
    writeOutputs({ judged, era, dups, labels, nodes, report, sql, phase, partial });
  };
  process.on('SIGINT', () => { log('stopping: writing the report from what is cached'); stop.now = true; });
  process.on('SIGTERM', () => { stop.now = true; });

  // bonds and unbonds first, then the rest, each kind's blocks in height order; then the tx bytes of the blocks whose
  // batch code is not 0 though the row's own result is Ok (the wrapper's atomic flag decides those rows)
  const dec = await loadDecoder();
  if (!dec) log('the tx decoder could not be loaded (run with --experimental-transform-types): rows whose batch needs it are reported as "batch not read"');
  const order = [...posKinds, ...restKinds].filter((k) => kinds.includes(k));
  for (const k of order) {
    if (stop.now) break;
    const ofKind = rows.filter((r) => r.kind === k);
    const heights = [...new Set(ofKind.map((r) => r.height))].sort((a, b) => a - b);
    log(`${k}: ${heights.length} distinct blocks`);
    await readBlocks(nodes, heights, conc, stop);
    if (dec && !stop.now) {
      const need = heightsNeedingTxs(nodes, ofKind);
      log(`${k}: ${need.length} blocks whose batch code is not 0 though the row's own result is Ok`);
      await readTxs(nodes, need, conc, stop, dec);
    }
  }
  finish(stop.now);
}

if (process.argv[1] && import.meta.filename && (process.argv[1] === import.meta.filename || process.argv[1].endsWith('recheck-indexer-rows.ts'))) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
