/**
 * After a re-derive of flows (scripts/rederive-osmosis.ts, scripts/rederive-namada.ts: rows marked meta.rederived),
 * the stored figures built from those flows, written again with the cron's own code. Reads the remote D1 with
 * read-only SELECTs and writes SQL for the owner to check and apply (scripts/d1-apply.ts). Writes nothing itself.
 *
 *   npx tsx scripts/rebuild-derived.ts [--mark 2026-10-22] [--key rederived] [--planned file.json] [--out file.sql]
 *     # default scripts/out/rederive/derived.sql, with derived.txt beside it
 *
 * `--key`: the meta field the mark is in: `rederived` (the re-derive scripts, the default), `restored` (rows a repair
 * wrote that the live scan never did) or `repaired` (rows a repair priced, scripts/repair-pool-hour-prices.ts).
 *
 * `--planned`: the rows a repair will change and the owner has not applied yet (scripts/repair-pool-hour-prices.ts
 * writes them: each row's id, the price_usd its statement sets and the meta keys it sets, the mark among them). Each
 * such row that still has no price is read as that statement will leave it (value_usd its price times its NAM, those
 * keys in its meta) and counts as marked, so the SQL written now is the SQL this script writes once the repair is
 * applied, and can be checked and applied right after it. A planned row that has a price by then is read as it is.
 *
 * `--out`: the SQL file. Beside it (.txt), each derived row that holds a marked move or that the SQL changes, as stored
 * and as written: the trade-hour keys, the day's flow_edges_daily and activity_daily rows and its daily keys.
 *
 * - Each closed trade-hour holding a marked Osmosis buy or sell: its 16 keys (price.swap_1h.* and dex.swaps_1h.*,
 *   series.ts swapHourStmts) deleted, then written again, so a key the hour no longer has (no trusted swap left, a
 *   trade now unpriced) does not stay behind.
 * - Each closed UTC day holding a marked row: its flow index as the daily job writes it (series.ts dayAggregates
 *   and dayStmts: flow_edges_daily replaced whole, activity_daily and the 11 daily keys, deleted first for the same
 *   reason). A day before 2026-08-14, the first day every kind is indexed, gets its edges only, as
 *   scripts/backfill-series.ts writes it.
 * The hour and the day still running are left to the cron. address_links (Osmosis and Namada ibc_in rows) and the
 * stake estimates are not touched: a re-derive changes neither ends nor amounts of bridge receives, bonds or unbonds,
 * and a repaired price changes neither.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { d1 as d1once } from './lib';
import { swapHourStmts, dayAggregates, dayStmts, isoDay, type SwapRow, type DayFlowRow, type DayAggregates } from '../worker/src/series';
import { DAY_FLOWS_SQL, REFUNDS_SQL } from '../worker/src/series-sql';
import { inlineSql } from '../worker/src/db';

const H = 3_600_000, D = 86_400_000;
const EVERY_KIND_FROM = Date.parse('2026-08-14T00:00:00Z');
export const HOUR_KEYS = ['price.swap_1h', 'price.swap_1h.n', 'price.swap_1h.open', 'price.swap_1h.close', 'price.swap_1h.high', 'price.swap_1h.low', 'price.swap_1h.vwap',
  'dex.swaps_1h.n', 'dex.swaps_1h.nam', 'dex.swaps_1h.usd', 'dex.swaps_1h.buy_nam', 'dex.swaps_1h.sell_nam', 'dex.swaps_1h.buyers', 'dex.swaps_1h.sellers', 'dex.swaps_1h.buy_vwap', 'dex.swaps_1h.sell_vwap'];
export const DAY_KEYS = ['active.namada_daily', 'active.osmosis_daily', 'dex.volume_nam_daily', 'dex.volume_usd_daily', 'dex.traders_daily', 'dex.hours_with_trades_daily',
  'bridge.in_daily', 'bridge.out_daily', 'bridge.refunded_daily', 'masp.in_daily', 'masp.out_daily'];
const keys = (ks: string[]) => ks.map((k) => `'${k}'`).join(',');
const sqlStr = (s: string) => `'${s.replace(/'/g, "''")}'`;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

/** A row a repair's statement will change: its id, the price_usd it sets, and the meta keys it sets (the mark among them). */
export interface PlannedRow { id: string; price_usd: number; meta: Record<string, unknown> }
/** A read-only SELECT, rows as plain objects. */
export type Read = <T = any>(sql: string) => T[];

export interface DerivedPart { at: number; ids: string[] }
export interface Derived {
  lines: string[];
  hourLines: number;
  hours: DerivedPart[];
  days: DerivedPart[];
  /** marked rows, planned rows that still had no price among them */
  touched: number;
  planned: number;
  /** each derived row that holds a marked move or that the SQL changes, as stored and as written */
  listing: string[];
}

const metaOf = (m: unknown): Record<string, unknown> => {
  if (m && typeof m === 'object') return m as Record<string, unknown>;
  if (typeof m !== 'string' || !m) return {};
  try { const v = JSON.parse(m); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
};
const num = (v: unknown): number | null => (v == null ? null : Number(v));
const fmt = (v: number | null | undefined) => (v == null ? 'none' : String(v));
/** Two stored figures read the same: both absent, or equal to the 12th significant digit (a sum in another order). */
const same = (a: number | null | undefined, b: number | null | undefined) => (a == null || b == null ? a == b : Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a), Math.abs(b)));

/**
 * The SQL that writes again every closed trade-hour and day holding a row whose meta[key] is `mark`, or a planned row
 * that still has no price (read as the repair will leave it), from the rows as `read` returns them.
 */
export function rebuildDerived(read: Read, o: { key: string; mark: string; now: number; planned?: readonly PlannedRow[] }): Derived {
  if (!/^[a-z]+$/i.test(o.key) || !/^[0-9-]+$/.test(o.mark)) throw new Error(`the key and the mark must be a word and a date: ${o.key} ${o.mark}`);
  const planned = new Map((o.planned ?? []).map((p) => [p.id, p]));
  for (const p of planned.values()) {
    if (p.meta[o.key] !== o.mark) throw new Error(`planned row ${p.id} does not set ${o.key} = ${o.mark}`);
    if (!(Number.isFinite(p.price_usd) && p.price_usd > 0)) throw new Error(`planned row ${p.id} has no price above 0`);
  }
  type Head = { id: string; chain: string; kind: string; ts: number };
  const byId = new Map<string, Head>();
  for (const r of read<Head>(`SELECT id, chain, kind, ts FROM flows WHERE json_extract(meta, '$.${o.key}') = '${o.mark}'`)) byId.set(r.id, { ...r, ts: Number(r.ts) });
  // the planned rows the repair's guard (price_usd IS NULL) still lets through
  const pending = new Set<string>();
  const ids = [...planned.keys()];
  for (let i = 0; i < ids.length; i += 90) {
    for (const r of read<Head>(`SELECT id, chain, kind, ts FROM flows WHERE price_usd IS NULL AND id IN (${ids.slice(i, i + 90).map(sqlStr).join(',')})`)) {
      pending.add(r.id);
      byId.set(r.id, { ...r, ts: Number(r.ts) });
    }
  }
  /** A row as the repair's statement will leave it, when it is a planned row that still has no price. */
  const asPlanned = <R extends { id?: string; amount_num: number; value_usd: number | null; meta: SwapRow['meta'] }>(r: R): R => {
    const p = r.id != null && pending.has(r.id) ? planned.get(r.id) : undefined;
    return p ? { ...r, value_usd: p.price_usd * Number(r.amount_num), meta: { ...metaOf(r.meta), ...p.meta } } : r;
  };
  const touched = [...byId.values()];
  const closedHour = Math.floor(o.now / H) * H, closedDay = Math.floor(o.now / D) * D;
  const hourOf = new Map<number, string[]>(), dayOf = new Map<number, string[]>();
  for (const r of touched) {
    if (r.chain === 'osmosis' && (r.kind === 'buy' || r.kind === 'sell')) {
      const h = Math.floor(r.ts / H) * H;
      if (h + H <= closedHour) hourOf.set(h, [...(hourOf.get(h) ?? []), r.id]);
    }
    const d = Math.floor(r.ts / D) * D;
    if (d + D <= closedDay) dayOf.set(d, [...(dayOf.get(d) ?? []), r.id]);
  }
  const hours = [...hourOf].sort((a, b) => a[0] - b[0]).map(([at, xs]) => ({ at, ids: xs }));
  const days = [...dayOf].sort((a, b) => a[0] - b[0]).map(([at, xs]) => ({ at, ids: xs }));

  const lines: string[] = [], listing: string[] = [];
  for (const { at: h, ids: hids } of hours) {
    const rows = read<SwapRow>(`SELECT id, ts, kind, amount_num, counter_denom, counter_amount, pool_id, value_usd, from_addr, to_addr, meta FROM flows WHERE kind IN ('buy', 'sell') AND chain = 'osmosis' AND ts >= ${h} AND ts < ${h + H}`)
      .map((r) => asPlanned({ ...r, ts: Number(r.ts) }));
    const stmts = swapHourStmts(rows, h);
    lines.push(`DELETE FROM metrics WHERE ts = ${h} AND key IN (${keys(HOUR_KEYS)});`, ...stmts.map(inlineSql));
    const stored = new Map(read<{ key: string; value: number }>(`SELECT key, value FROM metrics WHERE ts = ${h} AND key IN (${keys(HOUR_KEYS)})`).map((m) => [m.key, num(m.value)]));
    const written = new Map(stmts.map((s) => [String(s.params[1]), num(s.params[2])]));
    listing.push(`trade-hour ${iso(h)} UTC: ${hids.length} marked ${hids.length === 1 ? 'trade' : 'trades'} of ${rows.length}`);
    for (const k of HOUR_KEYS) {
      const a = stored.get(k), b = written.get(k);
      if (a == null && b == null) continue;
      listing.push(`  ${k}: ${same(a, b) ? `${fmt(b)} (as stored)` : `stored ${fmt(a)}, written ${fmt(b)}`}`);
    }
  }
  const hourLines = lines.length;
  for (const { at: d, ids: dids } of days) {
    const rows = read<DayFlowRow>(DAY_FLOWS_SQL.replace('f.ts >= ? AND f.ts < ?', `f.ts >= ${d} AND f.ts < ${d + D}`)).map((r) => asPlanned({ ...r, ts: Number(r.ts) }));
    const refunds = read<DayFlowRow>(REFUNDS_SQL.replace('ts >= ? AND ts < ?', `ts >= ${d} AND ts < ${d + 4 * D}`)).map((r) => ({ ...r, ts: Number(r.ts) }));
    const agg = dayAggregates(rows, refunds);
    const full = d >= EVERY_KIND_FROM;
    const out: DayAggregates = full ? agg : { edges: agg.edges, activity: [], metrics: {} };
    if (full) lines.push(`DELETE FROM metrics WHERE ts = ${d} AND key IN (${keys(DAY_KEYS)});`);
    lines.push(...dayStmts(isoDay(d), out).map(inlineSql));
    listing.push(...dayListing(read, d, dids, rows, refunds, out));
  }
  return { lines, hourLines, hours, days, touched: touched.length, planned: pending.size, listing };
}

/** The day's derived rows that hold a marked move (or that the SQL changes), as stored and as written. */
function dayListing(read: Read, d: number, ids: string[], rows: DayFlowRow[], refunds: DayFlowRow[], out: DayAggregates): string[] {
  const day = isoDay(d);
  const mine = new Set(ids);
  // the edges and activity rows that hold a marked move: the day's aggregates over those moves alone name them
  const holds = dayAggregates(rows.filter((r) => mine.has(r.id)), refunds);
  const edgeKey = (e: { chain: string; kind: string; from_cat: string; to_cat: string }) => `${e.chain} ${e.kind} ${e.from_cat} -> ${e.to_cat}`;
  const heldEdges = new Map(holds.edges.map((e) => [edgeKey(e), e.n]));
  const heldChains = new Map(holds.activity.filter((a) => a.flows > 0).map((a) => [a.chain, a.flows]));
  const lines = [`day ${day}: ${ids.length} marked ${ids.length === 1 ? 'move' : 'moves'} of ${rows.length}`];
  const edges = new Map(read<{ chain: string; kind: string; from_cat: string; to_cat: string; n: number; nam: number; usd: number | null }>(`SELECT chain, kind, from_cat, to_cat, n, nam, usd FROM flow_edges_daily WHERE day = '${day}'`).map((e) => [edgeKey(e), e]));
  const written = new Map(out.edges.map((e) => [edgeKey(e), e]));
  for (const k of [...new Set([...edges.keys(), ...written.keys()])].sort()) {
    const a = edges.get(k), b = written.get(k), held = heldEdges.get(k);
    const changed = !a || !b || a.n !== b.n || !same(a.nam, b.nam) || !same(num(a.usd), b.usd);
    if (!held && !changed) continue;
    const side = (e: { n: number; nam: number; usd: number | null } | undefined) => (e ? `n ${e.n}, nam ${e.nam}, usd ${fmt(num(e.usd))}` : 'none');
    lines.push(`  flow_edges_daily ${k}${held ? ` (holds ${held})` : ''}: ${changed ? `stored ${side(a)}; written ${side(b)}` : `${side(b)} (as stored)`}`);
  }
  if (out.activity.length) {
    type Act = DayAggregates['activity'][number];
    const acts = new Map(read<Act>(`SELECT chain, flows, senders, receivers, active, nam, trades, traders FROM activity_daily WHERE day = '${day}'`).map((a) => [a.chain, a]));
    for (const b of out.activity) {
      const a = acts.get(b.chain), held = heldChains.get(b.chain);
      const cols = ['flows', 'senders', 'receivers', 'active', 'nam', 'trades', 'traders'] as const;
      const changed = !a || cols.some((c) => !same(num(a[c]), b[c]));
      if (!held && !changed) continue;
      const side = (x: Act | undefined) => (x ? cols.map((c) => `${c} ${x[c]}`).join(', ') : 'none');
      lines.push(`  activity_daily ${b.chain}${held ? ` (holds ${held})` : ''}: ${changed ? `stored ${side(a)}; written ${side(b)}` : `${side(b)} (as stored; no column of it is a dollar figure)`}`);
    }
    const stored = new Map(read<{ key: string; value: number }>(`SELECT key, value FROM metrics WHERE ts = ${d} AND key IN (${keys(DAY_KEYS)})`).map((m) => [m.key, num(m.value)]));
    for (const k of DAY_KEYS) {
      const a = stored.get(k), b = out.metrics[k];
      if (a == null && b == null) continue;
      lines.push(`  ${k}: ${same(a, b) ? `${fmt(b)} (as stored)` : `stored ${fmt(a)}, written ${fmt(b)}`}`);
    }
  }
  return lines;
}

function main() {
  const args = process.argv.slice(2);
  const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const mark = arg('--mark') ?? '2026-10-22';
  const key = arg('--key') ?? 'rederived';
  if (!/^[a-z]+$/.test(key) || !/^[0-9-]+$/.test(mark)) throw new Error(`--key and --mark must be a word and a date: ${key} ${mark}`);
  const plannedFile = arg('--planned');
  const planned = plannedFile ? (JSON.parse(readFileSync(plannedFile, 'utf8')) as PlannedRow[]) : undefined;
  const out = resolve(arg('--out') ?? join(dirname(fileURLToPath(import.meta.url)), 'out', 'rederive', 'derived.sql'));
  mkdirSync(dirname(out), { recursive: true });
  /** Read-only SELECT on production, retried on Cloudflare's transient 7403. */
  const read: Read = (sql) => {
    for (let i = 0; ; i++) {
      try { return d1once(sql); } catch (e) { if (i >= 5) throw e; }
    }
  };
  const r = rebuildDerived(read, { key, mark, now: Date.now(), planned });
  const txt = out.replace(/\.sql$/, '') + '.txt';
  writeFileSync(out, r.lines.join('\n') + '\n');
  writeFileSync(txt, r.listing.join('\n') + '\n');
  const { hours, days } = r;
  console.error(`${r.touched} rows with ${key} = ${mark}${planned ? ` (${r.planned} of ${planned.length} planned rows still without a price, read as the repair leaves them)` : ''}: `
    + `${hours.length} closed trade-hours (${hours.length ? `${iso(hours[0].at)} .. ${iso(hours[hours.length - 1].at)}` : '-'}): ${r.hourLines} statements; `
    + `${days.length} closed days (${days.length ? `${isoDay(days[0].at)} .. ${isoDay(days[days.length - 1].at)}` : '-'}): ${r.lines.length - r.hourLines} statements; to ${out} (listing ${txt})`);
}

const isMain = process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
