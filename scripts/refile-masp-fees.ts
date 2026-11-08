/**
 * Re-file the shielded pool's fees the live scan wrote as unshields. A shielded transaction that pays its gas from the
 * pool moves one NAM leg out of it, to the account that paid gas, and the chain marks its inner transaction with a
 * masp/fee-payment event; the parser (worker/src/parse/namada.ts namFlows, the rule of 2026-11-07) now files such a leg
 * as a flow of kind 'masp_fee'. Before that rule, fee detection ran only when the pool paid more than one target, so a
 * fee with no other leg was filed as an unshield to the gas payer.
 *
 * This script reads every stored Namada 'unshield' row of NAM under MASP_FEE_CAP_NAM from block FIRST_BLOCK on (the live
 * parser's rows; earlier rows are out of scope here), reads each row's block_results from two public nodes and takes the
 * block only when both give the same token and MASP events (scripts/chain-agree.ts), reads the wrappers' fee payers from
 * the block's tx bytes, parses the block as the live scan does now, and prints the migration:
 * - one UPDATE per row the parser now files as a fee, with a comment naming the block, the fee-payment event's
 *   indexed-tx and the two nodes;
 * - the flow_edges_daily rows the kind change moves, written as worker/src/series.ts dayAggregates would write them for
 *   the rows as they are now, each statement guarded by its first moved row still being an unshield, so the file can be
 *   applied twice and changes nothing the second time;
 * - a comment with the checks to run after applying.
 * Rows the parser still files as unshields are printed on stderr with the reason and stay as they are. Nothing is
 * written to D1 here: the reads are SELECTs (scripts/lib.ts d1).
 *
 *   npx tsx scripts/refile-masp-fees.ts [--nodes https://a,https://b] [--out migrations/0022_masp_fee_refile.sql]
 *
 * (tsx, not node --experimental-strip-types: the Worker's modules import each other without file extensions, which
 * Node's own loader does not resolve; scripts/rederive-namada.ts and rebuild-derived.ts run the same way.)
 *
 * What the migration leaves alone, and why: the stored counts (flow_counts, migration 0017) need no statement, since a
 * row's kind changing fires the flow_counts_au trigger, which marks them dirty, and the cron writes them again within
 * FLOW_RECOUNT_GAP_MS; activity_daily holds no column that depends on these rows' kind (their number, NAM and addresses
 * stay as counted); masp.out_daily sums every NAM row out of the pool whatever its kind (dayAggregates), so it does not
 * move either. address_links, pool_legs, stakes and the metrics read none of these rows by kind.
 */
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { d1 } from './lib.ts';
import { eventsKey, maspEvents } from './chain-agree.ts';
import { MASP_FEE_CAP_NAM, parseNamadaBlock, type NamadaBlock } from '../worker/src/parse/namada.ts';
import { feePayersOf } from '../worker/src/parse/namada-tx.ts';
import { NAM, NAMADA, UA } from '../worker/src/config.ts';
import { NAM_AMOUNT, NOT_LEGACY_TWIN } from '../worker/src/flows-query.ts';
import { isoDay, sideCategory } from '../worker/src/series.ts';
import type { RawEvent } from '../worker/src/parse/osmosis.ts';

/** The two public nodes that answer during the halt of 2 November 2026 (the app's configured nodes answer 502 on 2026-11-07). */
export const DEFAULT_NODES = ['https://namada-rpc.stakeandrelax.net', 'https://namada-rpc.polkachu.com'];
/** The first block whose rows this pass reads: the live parser's rows. Rows before it are out of scope here. */
export const FIRST_BLOCK = 7_682_174;
export const OUT_DEFAULT = 'migrations/0022_masp_fee_refile.sql';
const MASP = NAMADA.internal.masp;
const INTERNAL = new Set<string>(Object.values(NAMADA.internal));
const D = 86_400_000;

export interface StoredRow { id: string; height: number; ts: number; to_addr: string; amount_num: number; value_usd: number | null; meta: string | null }
export type Verdict =
  | { kind: 'masp_fee'; indexedTx: string; innerTxHash: string }
  | { kind: 'unshield'; reason: string };

const q = (v: unknown): string => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? (Number.isFinite(v) ? String(v) : 'NULL') : `'${String(v).replace(/'/g, "''")}'`);
const near = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
/** A sum of NAM amounts to the base unit (six decimals), so a float's noise is not written as a figure. */
const nam6 = (x: number) => Number(x.toFixed(6));
/** The local calendar date, as the migrations' headers date them. */
const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const attrsOf = (e: RawEvent): Record<string, string> => Object.fromEntries((Array.isArray(e.attributes) ? e.attributes : []).map((a: any) => [a.key, a.value]));

/** A block as the live scan reads one (worker/src/sources/namada.ts blockResults): every event list of the answer, in order. */
export function blockFromResults(answer: any, height: number, ts: number): NamadaBlock {
  const r = answer?.result;
  if (!r || typeof r !== 'object') throw new Error(`block_results ${height}: answer without a result`);
  const events: RawEvent[] = [
    ...(r.begin_block_events ?? []),
    ...(r.end_block_events ?? []),
    ...(r.finalize_block_events ?? []),
    ...((r.txs_results ?? []) as any[]).flatMap((t) => t?.events ?? []),
  ];
  return { height, ts, events };
}

/** Two block_results answers carry the same token and MASP events (chain-agree.ts eventsKey), and at least one event. */
export function sameEvents(a: any, b: any): boolean {
  const x = maspEvents(a), y = maspEvents(b);
  return x != null && y != null && eventsKey(x) === eventsKey(y);
}

/**
 * What the parser as it is now makes of one stored row: the flow of the same id in the block (else the flow with the
 * same ends and amount), 'masp_fee' with the fee-payment event's indexed-tx, or 'unshield' with the reason the rule
 * does not hold. `feePayers`: the wrappers' fee payers from the block's tx bytes, undefined when they could not be read.
 */
export function verdictOf(row: StoredRow, block: NamadaBlock, feePayers: ReadonlyMap<string, string> | undefined): Verdict {
  const parsed = parseNamadaBlock(block, null, feePayers);
  const flow = parsed.flows.find((f) => f.id === row.id)
    ?? parsed.flows.find((f) => f.from === MASP && f.to === row.to_addr && near(f.amount, row.amount_num) && !f.meta?.tokenSymbol);
  const stored = (() => { try { return row.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : {}; } catch { return {}; } })();
  const inner = String(flow?.meta?.innerTxHash ?? stored.innerTxHash ?? '').toUpperCase();
  const feeEvent = block.events.find((e) => e?.type === 'masp/fee-payment' && (attrsOf(e)['inner-tx-hash'] || '').toUpperCase() === inner);
  if (flow?.kind === 'masp_fee') {
    if (!feeEvent) throw new Error(`${row.id}: the parser filed a fee without a masp/fee-payment event in the block`);
    return { kind: 'masp_fee', indexedTx: attrsOf(feeEvent)['indexed-tx'] ?? '', innerTxHash: inner };
  }
  if (!inner) return { kind: 'unshield', reason: 'the row names no inner transaction' };
  if (!feeEvent) return { kind: 'unshield', reason: 'no masp/fee-payment event for its inner transaction' };
  const transfer = block.events.find((e) => e?.type === 'token/transfer' && (attrsOf(e)['inner-tx-hash'] || '').toUpperCase() === inner);
  const targets = (() => { try { return (JSON.parse(attrsOf(transfer!)['target-accounts'] || '[]') as [[string, string], string][]).filter(([[, token]]) => token === NAM.namadaToken); } catch { return []; } })();
  if (targets.length > 1) {
    const kept = !flow ? ' (the parser keeps this leg as maspFeeNam on the recipient\'s row)' : flow.meta?.maspFeeNam != null ? ' (the fee is kept on the row as maspFeeNam)' : '';
    return { kind: 'unshield', reason: `the pool paid ${targets.length} targets in the transfer${kept}` };
  }
  if (!flow) return { kind: 'unshield', reason: 'no flow of this id, or of its ends and amount, in the block as parsed now' };
  if (INTERNAL.has(row.to_addr)) return { kind: 'unshield', reason: 'the target is a protocol account, which pays no gas' };
  if (row.amount_num > MASP_FEE_CAP_NAM) return { kind: 'unshield', reason: `above the cap of ${MASP_FEE_CAP_NAM} NAM` };
  const payer = feePayers?.get(flow.txHash);
  if (payer !== undefined && payer !== row.to_addr) return { kind: 'unshield', reason: 'the wrapper names another account as its fee payer' };
  return { kind: 'unshield', reason: 'the parser filed it as an unshield (no rule above names why)' };
}

// ---------------------------------------------------------------- the daily edges

export interface EdgeRow { id: string; ts: number; to_addr: string; amount_num: number; value_usd: number | null; to_cat: string | null; to_src: string | null }
export interface StoredEdge { day: string; kind: string; to_cat: string; n: number; nam: number; usd: number | null }
/** n rows, their NAM, and their dollars when every row is priced (series.ts dayAggregates: one unpriced row makes the edge's usd null). */
export interface EdgeSum { n: number; nam: number; usd: number | null }
export interface EdgePlan {
  day: string;
  toCat: string;
  /** a moved row of this edge: the statements run only while it is still an unshield */
  guardId: string;
  /** the unshield edge as stored, null when the day holds none (the day was never aggregated: nothing is written for it) */
  stored: StoredEdge | null;
  /** the unshield edge's rows that stay */
  remaining: EdgeSum;
  /** the rows that become the masp_fee edge */
  moved: EdgeSum;
}

const sumOf = (rows: EdgeRow[]): EdgeSum => ({
  n: rows.length,
  nam: nam6(rows.reduce((a, r) => a + r.amount_num, 0)),
  usd: rows.every((r) => r.value_usd != null) ? rows.reduce((a, r) => a + (r.value_usd ?? 0), 0) : null,
});

/**
 * The edges the kind change moves: for each UTC day and receiving category with a moved row, the unshield edge's rows
 * that stay and the rows that become the masp_fee edge, from `rows` (every NAM unshield row out of the pool on those
 * days, with the receiver's label category and source, as DAY_FLOWS_SQL reads them) and `stored` (the unshield edges of
 * those days as flow_edges_daily holds them). The from category is the pool's own (sideCategory).
 */
export function edgePlans(rows: EdgeRow[], moved: ReadonlySet<string>, stored: StoredEdge[]): EdgePlan[] {
  const byKey = new Map<string, EdgeRow[]>();
  for (const r of rows) {
    const k = `${isoDay(r.ts)}|${sideCategory(r.to_addr, r.to_cat, r.to_src, 'namada')}`;
    (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(r);
  }
  const out: EdgePlan[] = [];
  for (const [k, rs] of [...byKey].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const mv = rs.filter((r) => moved.has(r.id));
    if (!mv.length) continue;
    const [day, toCat] = k.split('|');
    out.push({
      day, toCat, guardId: mv[0].id,
      stored: stored.find((e) => e.day === day && e.kind === 'unshield' && e.to_cat === toCat) ?? null,
      remaining: sumOf(rs.filter((r) => !moved.has(r.id))),
      moved: sumOf(mv),
    });
  }
  return out;
}

export interface MigrationInput {
  refiled: { row: StoredRow; verdict: Extract<Verdict, { kind: 'masp_fee' }> }[];
  left: { row: StoredRow; reason: string }[];
  edges: EdgePlan[];
  nodes: string[];
  /** the ISO date of the run */
  today: string;
}

/** The migration's text. Empty rows give an empty string: no file is written for nothing. */
export function renderMigration({ refiled, left, edges, nodes, today }: MigrationInput): string {
  if (!refiled.length) return '';
  const fromCat = sideCategory(MASP, null, null, 'namada');
  const guard = (id: string) => `EXISTS (SELECT 1 FROM flows WHERE id = ${q(id)} AND kind = 'unshield')`;
  const sumWords = (s: EdgeSum) => (s.n === 0 ? 'none left, the edge goes' : `n ${s.n}, ${s.nam} NAM, usd ${s.usd == null ? 'NULL' : s.usd}`);
  const nam = nam6(refiled.reduce((a, r) => a + r.row.amount_num, 0));
  const lines: string[] = [
    `-- ${today}. The shielded pool's fees the live scan filed as unshields are re-filed as kind 'masp_fee' (shared/types.ts;`,
    `-- worker/src/parse/namada.ts namFlows, the masp/fee-payment rule). A shielded transaction that pays its gas from the pool`,
    `-- moves one NAM leg out of it, to the account that paid gas, and the chain marks its inner transaction with a`,
    `-- masp/fee-payment event. Written by scripts/refile-masp-fees.ts from the stored rows and the blocks as two public nodes`,
    `-- served them (${nodes.join(', ')}; a block was taken only when both gave the same token and MASP`,
    `-- events). ${refiled.length} rows, ${nam} NAM in all, each under ${MASP_FEE_CAP_NAM} NAM; ${left.length} rows of the same shape stay unshields (the`,
    `-- script prints each with its reason). Rows before block ${FIRST_BLOCK.toLocaleString('en-US')} are out of scope for this pass.`,
    `--`,
    `-- 1. The daily edges first (flow_edges_daily, migration 0007): the unshield edge of each day and receiving category`,
    `--    loses the moved rows and a masp_fee edge takes them, with the values worker/src/series.ts dayAggregates gives the`,
    `--    rows as they are stored (usd NULL when any row of the edge is unpriced). Each statement runs only while the edge's`,
    `--    first moved row is still an unshield, so the file applied twice changes nothing the second time. The stored`,
    `--    counts (flow_counts) are marked dirty by migration 0017's trigger on the kind change and written again by the`,
    `--    cron; activity_daily and masp.out_daily do not depend on these rows' kind and stay.`,
  ];
  for (const e of edges) {
    const where = `day = ${q(e.day)} AND chain = 'namada' AND kind = 'unshield' AND from_cat = ${q(fromCat)} AND to_cat = ${q(e.toCat)}`;
    if (!e.stored) {
      lines.push(`-- ${e.day} ${fromCat}>${e.toCat}: ${e.moved.n} moved row(s), but the day holds no unshield edge (never aggregated): nothing written for it.`);
      continue;
    }
    const all = { n: e.remaining.n + e.moved.n, nam: e.remaining.nam + e.moved.nam };
    const differs = all.n !== e.stored.n || !near(all.nam, e.stored.nam);
    lines.push(`-- ${e.day} ${fromCat}>${e.toCat}: ${e.moved.n} of ${all.n} rows move; stored unshield edge n ${e.stored.n}, ${nam6(e.stored.nam)} NAM${differs ? ` (the rows give n ${all.n}, ${nam6(all.nam)} NAM: the values below are the rows')` : ''}.`);
    lines.push(e.remaining.n === 0
      ? `DELETE FROM flow_edges_daily WHERE ${where} AND ${guard(e.guardId)};`
      : `UPDATE flow_edges_daily SET n = ${e.remaining.n}, nam = ${q(e.remaining.nam)}, usd = ${q(e.remaining.usd)} WHERE ${where} AND ${guard(e.guardId)};`);
    lines.push(`INSERT INTO flow_edges_daily (day, chain, kind, from_cat, to_cat, n, nam, usd) SELECT ${q(e.day)}, 'namada', 'masp_fee', ${q(fromCat)}, ${q(e.toCat)}, ${e.moved.n}, ${q(e.moved.nam)}, ${q(e.moved.usd)} WHERE ${guard(e.guardId)}`
      + ` ON CONFLICT (chain, kind, from_cat, to_cat, day) DO UPDATE SET n = n + excluded.n, nam = nam + excluded.nam, usd = CASE WHEN flow_edges_daily.usd IS NULL OR excluded.usd IS NULL THEN NULL ELSE flow_edges_daily.usd + excluded.usd END;`);
    lines.push(`--    unshield ${sumWords(e.remaining)}; masp_fee ${sumWords(e.moved)}`);
  }
  lines.push(`--`, `-- 2. The rows. Each changes only while it is still an unshield.`);
  for (const { row, verdict } of refiled) {
    lines.push(`-- block ${row.height.toLocaleString('en-US')}, ${row.amount_num} NAM, indexed-tx ${verdict.indexedTx}; the same events from ${nodes.join(' and ')}`);
    lines.push(`UPDATE flows SET kind = 'masp_fee' WHERE id = ${q(row.id)} AND kind = 'unshield';`);
  }
  const sample = edges.find((e) => e.stored);
  lines.push(
    `--`,
    `-- Check after applying: ${refiled.length} rows of kind 'masp_fee' among these ids, none of them an unshield; the edges of one day as`,
    `-- written above; the stored counts dirty until the cron's next write.`,
    `--   SELECT kind, COUNT(*) FROM flows WHERE id IN (${refiled.slice(0, 3).map((r) => q(r.row.id)).join(', ')}${refiled.length > 3 ? ', …' : ''}) GROUP BY kind;`,
    ...(sample ? [`--   SELECT kind, to_cat, n, nam, usd FROM flow_edges_daily WHERE day = ${q(sample.day)} AND chain = 'namada' AND kind IN ('unshield', 'masp_fee');`] : []),
    `--   SELECT dirty FROM flow_count_mark WHERE id = 1;`,
  );
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------- the run

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson(url: string): Promise<any> {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return await res.json();
    } catch (e) {
      if (i >= 3) throw e;
      await sleep(1_000 * (i + 1));
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
  const nodes = (opt('nodes') ?? DEFAULT_NODES.join(',')).split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
  if (nodes.length !== 2) throw new Error('--nodes takes exactly two nodes');
  const out = opt('out') ?? OUT_DEFAULT;

  const rows = d1<StoredRow>(`SELECT id, height, ts, to_addr, amount_num, value_usd, meta FROM flows
    WHERE chain = 'namada' AND kind = 'unshield' AND from_addr = ${q(MASP)} AND amount_num <= ${MASP_FEE_CAP_NAM} AND height >= ${FIRST_BLOCK}
      AND (meta IS NULL OR meta NOT LIKE '%"tokenSymbol":%') ORDER BY height, id`)
    .map((r) => ({ ...r, height: Number(r.height), ts: Number(r.ts), amount_num: Number(r.amount_num) }));
  console.error(`${rows.length} stored unshield rows of NAM under ${MASP_FEE_CAP_NAM} NAM out of the pool from block ${FIRST_BLOCK}`);

  const byHeight = new Map<number, StoredRow[]>();
  for (const r of rows) (byHeight.get(r.height) ?? byHeight.set(r.height, []).get(r.height)!).push(r);
  const refiled: MigrationInput['refiled'] = [];
  const left: MigrationInput['left'] = [];
  let n = 0;
  for (const [h, rs] of [...byHeight].sort((a, b) => a[0] - b[0])) {
    if (n++) await sleep(150);
    let answers: any[];
    try {
      answers = await Promise.all(nodes.map((node) => getJson(`${node}/block_results?height=${h}`)));
    } catch (e) {
      for (const row of rs) left.push({ row, reason: `block_results not read from both nodes: ${e instanceof Error ? e.message : String(e)}` });
      continue;
    }
    if (!sameEvents(answers[0], answers[1])) {
      for (const row of rs) left.push({ row, reason: 'the two nodes did not give the same token and MASP events' });
      continue;
    }
    const block = blockFromResults(answers[0], h, rs[0].ts);
    let payers: Map<string, string> | undefined;
    try {
      const blk = await getJson(`${nodes[0]}/block?height=${h}`);
      if (!Array.isArray(blk?.result?.block?.data?.txs)) throw new Error('no txs array');
      payers = feePayersOf(blk.result.block.data.txs);
    } catch (e) {
      console.error(`block ${h}: tx bytes not read (${e instanceof Error ? e.message : String(e)}); the events and the cap decide`);
    }
    for (const row of rs) {
      const v = verdictOf(row, block, payers);
      if (v.kind === 'masp_fee') refiled.push({ row, verdict: v });
      else left.push({ row, reason: v.reason });
    }
    if (n % 10 === 0) console.error(`${n}/${byHeight.size} blocks`);
  }

  // the daily edges of the days with a moved row: every NAM unshield row out of the pool on those days, and the stored edges
  let edges: EdgePlan[] = [];
  if (refiled.length) {
    const days = [...new Set(refiled.map((r) => isoDay(r.row.ts)))].sort();
    const from = Date.parse(`${days[0]}T00:00:00Z`), to = Date.parse(`${days[days.length - 1]}T00:00:00Z`) + D;
    const dayRows = d1<EdgeRow>(`SELECT f.id, f.ts, f.to_addr, f.amount_num, f.value_usd, lt.category AS to_cat, lt.source AS to_src
      FROM flows f LEFT JOIN labels lt ON lt.address = f.to_addr
      WHERE f.chain = 'namada' AND f.kind = 'unshield' AND f.from_addr = ${q(MASP)} AND f.ts >= ${from} AND f.ts < ${to} AND ${NAM_AMOUNT} AND ${NOT_LEGACY_TWIN}`)
      .map((r) => ({ ...r, ts: Number(r.ts), amount_num: Number(r.amount_num) }))
      .filter((r) => days.includes(isoDay(r.ts)));
    const stored = d1<StoredEdge>(`SELECT day, kind, to_cat, n, nam, usd FROM flow_edges_daily WHERE chain = 'namada' AND kind IN ('unshield', 'masp_fee') AND day IN (${days.map(q).join(', ')})`)
      .map((e) => ({ ...e, n: Number(e.n), nam: Number(e.nam), usd: e.usd == null ? null : Number(e.usd) }));
    edges = edgePlans(dayRows, new Set(refiled.map((r) => r.row.id)), stored);
  }

  const text = renderMigration({ refiled, left, edges, nodes, today: localDate() });
  if (text) writeFileSync(out, text);
  console.error(`${refiled.length} rows re-filed as masp_fee (${nam6(refiled.reduce((a, r) => a + r.row.amount_num, 0))} NAM), ${left.length} left as unshield${text ? `; ${out} written` : '; nothing written'}`);
  for (const { row, reason } of left) console.error(`  left: ${row.id} block ${row.height} ${row.amount_num} NAM: ${reason}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
