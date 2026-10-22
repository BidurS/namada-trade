/**
 * After a re-derive of flows (scripts/rederive-osmosis.ts, scripts/rederive-namada.ts: rows marked meta.rederived),
 * the stored figures built from those flows, written again with the cron's own code. Reads the remote D1 with
 * read-only SELECTs and writes SQL for the owner to check and apply (scripts/d1-apply.ts). Writes nothing itself.
 *
 *   npx tsx scripts/rebuild-derived.ts [--mark 2026-10-22]   # scripts/out/rederive/derived.sql
 *
 * - Each closed trade-hour holding a re-derived Osmosis buy or sell: its 16 keys (price.swap_1h.* and dex.swaps_1h.*,
 *   series.ts swapHourStmts) deleted, then written again, so a key the hour no longer has (no trusted swap left, a
 *   trade now unpriced) does not stay behind.
 * - Each closed UTC day holding a re-derived row: its flow index as the daily job writes it (series.ts dayAggregates
 *   and dayStmts: flow_edges_daily replaced whole, activity_daily and the 11 daily keys, deleted first for the same
 *   reason). A day before 2026-08-14, the first day every kind is indexed, gets its edges only, as
 *   scripts/backfill-series.ts writes it.
 * The hour and the day still running are left to the cron. address_links (Osmosis and Namada ibc_in rows) and the
 * stake estimates are not touched: a re-derive changes neither ends nor amounts of bridge receives, bonds or unbonds.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { d1 as d1once } from './lib';
import { swapHourStmts, dayAggregates, dayStmts, isoDay, type SwapRow, type DayFlowRow } from '../worker/src/series';
import { DAY_FLOWS_SQL, REFUNDS_SQL } from '../worker/src/series-sql';
import { inlineSql } from '../worker/src/db';

const H = 3_600_000, D = 86_400_000;
const EVERY_KIND_FROM = Date.parse('2026-08-14T00:00:00Z');
const HOUR_KEYS = ['price.swap_1h', 'price.swap_1h.n', 'price.swap_1h.open', 'price.swap_1h.close', 'price.swap_1h.high', 'price.swap_1h.low', 'price.swap_1h.vwap',
  'dex.swaps_1h.n', 'dex.swaps_1h.nam', 'dex.swaps_1h.usd', 'dex.swaps_1h.buy_nam', 'dex.swaps_1h.sell_nam', 'dex.swaps_1h.buyers', 'dex.swaps_1h.sellers', 'dex.swaps_1h.buy_vwap', 'dex.swaps_1h.sell_vwap'];
const DAY_KEYS = ['active.namada_daily', 'active.osmosis_daily', 'dex.volume_nam_daily', 'dex.volume_usd_daily', 'dex.traders_daily', 'dex.hours_with_trades_daily',
  'bridge.in_daily', 'bridge.out_daily', 'bridge.refunded_daily', 'masp.in_daily', 'masp.out_daily'];
const args = process.argv.slice(2);
const mark = (() => { const i = args.indexOf('--mark'); return i >= 0 ? args[i + 1] : '2026-10-22'; })();
const OUT = join(import.meta.dirname, 'out', 'rederive');
mkdirSync(OUT, { recursive: true });
const keys = (ks: string[]) => ks.map((k) => `'${k}'`).join(',');
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

function d1<T = any>(sql: string): T[] {
  for (let i = 0; ; i++) {
    try { return d1once<T>(sql); } catch (e) { if (i >= 5) throw e; }
  }
}

const now = Date.now();
const touched = d1<{ chain: string; kind: string; ts: number }>(`SELECT chain, kind, ts FROM flows WHERE json_extract(meta, '$.rederived') = '${mark}'`);
const hours = [...new Set(touched.filter((r) => r.chain === 'osmosis' && (r.kind === 'buy' || r.kind === 'sell')).map((r) => Math.floor(Number(r.ts) / H) * H))]
  .filter((h) => h + H <= Math.floor(now / H) * H).sort((a, b) => a - b);
const days = [...new Set(touched.map((r) => Math.floor(Number(r.ts) / D) * D))].filter((d) => d + D <= Math.floor(now / D) * D).sort((a, b) => a - b);
console.error(`${touched.length} re-derived rows: ${hours.length} closed trade-hours, ${days.length} closed days`);

const lines: string[] = [];
for (const h of hours) {
  const rows = d1<SwapRow>(`SELECT id, ts, kind, amount_num, counter_denom, counter_amount, pool_id, value_usd, from_addr, to_addr, meta FROM flows WHERE kind IN ('buy', 'sell') AND chain = 'osmosis' AND ts >= ${h} AND ts < ${h + H}`)
    .map((r) => ({ ...r, ts: Number(r.ts) }));
  lines.push(`DELETE FROM metrics WHERE ts = ${h} AND key IN (${keys(HOUR_KEYS)});`, ...swapHourStmts(rows, h).map(inlineSql));
}
const hourLines = lines.length;
for (const d of days) {
  const rows = d1<DayFlowRow>(DAY_FLOWS_SQL.replace('f.ts >= ? AND f.ts < ?', `f.ts >= ${d} AND f.ts < ${d + D}`)).map((r) => ({ ...r, ts: Number(r.ts) }));
  const refunds = d1<DayFlowRow>(REFUNDS_SQL.replace('ts >= ? AND ts < ?', `ts >= ${d} AND ts < ${d + 4 * D}`)).map((r) => ({ ...r, ts: Number(r.ts) }));
  const agg = dayAggregates(rows, refunds);
  const full = d >= EVERY_KIND_FROM;
  if (full) lines.push(`DELETE FROM metrics WHERE ts = ${d} AND key IN (${keys(DAY_KEYS)});`);
  lines.push(...dayStmts(isoDay(d), full ? agg : { edges: agg.edges, activity: [], metrics: {} }).map(inlineSql));
}
writeFileSync(join(OUT, 'derived.sql'), lines.join('\n') + '\n');
console.error(`${hours.length} trade-hours (${hours.length ? `${iso(hours[0])} .. ${iso(hours[hours.length - 1])}` : '-'}): ${hourLines} statements; ${days.length} days (${days.length ? `${isoDay(days[0])} .. ${isoDay(days[days.length - 1])}` : '-'}): ${lines.length - hourLines} statements; to ${join(OUT, 'derived.sql')}`);
