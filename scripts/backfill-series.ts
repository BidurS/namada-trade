/**
 * The one-off backfills of the series (docs/design/screener-plan.md 5.5, "One-off backfills"), written as SQL files
 * for the orchestrator to apply with `npm run db:apply -- <file>`; this script never writes to the database.
 *
 *   npx tsx scripts/backfill-series.ts [--to YYYY-MM-DD]      (default --to: yesterday, UTC)
 *
 * It reads the production flows with read-only SELECTs (scripts/lib.ts d1) and the Osmosis data API, and computes
 * every row with the cron's own code (worker/src/series.ts), so a backfilled row is the row the cron would have
 * written. Output in scripts/out/backfill/series/, numbered in the order to apply:
 *
 *   01_rollups.sql        price.usd / dex.liquidity_usd / supply.total_stake / supply.masp_shielded .1h, .1h.lo, .1h.hi
 *                         for every hour closed when the file is applied (pure SQL on D1's clock; INSERT OR IGNORE)
 *   02_masp_daily.sql     supply.masp_shielded.daily for the days after the chain-history backfill (17 Oct 2026), each
 *                         day once it has closed at apply time, from its last minute reading (pure SQL; INSERT OR IGNORE)
 *   03_swap_hours.sql     every trade-hour's price.swap_1h.* and dex.swaps_1h.* up to the hour this script ran
 *                         (series.swapHourStmts; INSERT OR IGNORE, so a stored price.swap_1h point is never changed)
 *   04_flow_days.sql      flow_edges_daily for every day with flows up to --to; activity_daily and the daily keys from
 *                         14 Aug 2026 (the first day every kind is indexed; earlier days would read as quiet days that
 *                         were not). The nine staking-account rows are filed as pos_balance (the repair) in memory.
 *   05_pool_price.sql     price.pool_1h* from the Osmosis pair chart of pool 3005, range=all (from 20 Jun 2025 19:00 UTC)
 *   06_osmosis_daily.sql  price.token_1d.osmosis.* and dex.volume_usd_daily.osmosis (the Osmosis token candles, 20 Jun 2025
 *                         to 20 Jun 2026, gaps kept) and dex.ref_pool_liquidity_usd.daily.osmosis (pool 3005 over time)
 *
 * Not backfillable, so not here (screener-plan 3.9): holder cohorts, genesis cohorts, holder counts, first_seen (NULL
 * for every row that existed before migration 0007), validators, the unbond queue, per-pool depth.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { d1 as d1once } from './lib.ts';
import { inlineSql, stmt, type Stmt } from '../worker/src/db.ts';
import { swapHourStmts, dayAggregates, dayStmts, isoDay, poolPriceStmts, type SwapRow, type DayFlowRow } from '../worker/src/series.ts';
import { DAY_FLOWS_SQL, ROLLUP_KEYS } from '../worker/src/series-sql.ts';
import { parsePairChart, pairChartUrl, OSMOSIS_DATA } from '../worker/src/sources/osmosis-data.ts';
import { NAM } from '../worker/src/config.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'scripts', 'out', 'backfill', 'series');
const H = 3600000, D = 86400000;
/** The first day the live parser indexed every kind (block 7,682,174, screener-plan 3.9). */
const EVERY_KIND_FROM = '2026-08-14';
/** The last day the chain-history backfill wrote supply.masp_shielded.daily for. */
const MASP_DAILY_LAST = Date.UTC(2026, 9, 17);

/** Read-only SELECT on production, retried on Cloudflare's transient 7403. */
function d1<T = any>(sql: string): T[] {
  for (let i = 0; ; i++) {
    try { return d1once<T>(sql); } catch (e) { if (i >= 5) throw e; }
  }
}

/** The start of the current hour and day at the moment D1 runs the statement (unix ms). */
const APPLY_HOUR_SQL = `(CAST(strftime('%s', 'now') AS INTEGER) * 1000 - CAST(strftime('%s', 'now') AS INTEGER) * 1000 % ${3600000})`;
const APPLY_DAY_SQL = `(CAST(strftime('%s', 'now') AS INTEGER) * 1000 - CAST(strftime('%s', 'now') AS INTEGER) * 1000 % ${86400000})`;
const POS = 'tnam1qgqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqc8j2fp';

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const to = arg('--to') ?? isoDay(Date.now() - D);
const toEnd = Date.parse(`${to}T00:00:00Z`) + D;
if (!Number.isFinite(toEnd)) throw new Error(`--to ${to} is not a day`);
mkdirSync(OUT, { recursive: true });

const header = (what: string) => `-- ${what}\n-- Written by scripts/backfill-series.ts on ${new Date().toISOString().slice(0, 16)} UTC (--to ${to}); not applied by it.\n`;
function write(name: string, what: string, lines: string[]) {
  writeFileSync(join(OUT, name), header(what) + lines.join('\n') + '\n');
  console.log(`${name}: ${lines.filter((l) => !l.startsWith('--')).length} statements`);
}

// ---------------------------------------------------------------- 01, 02: pure SQL from the minute rows

{
  const lines: string[] = [];
  for (const key of ROLLUP_KEYS) {
    // every hour closed when the file is applied (D1's clock), so nothing between this file and the cron's first hour is missed
    const g = `SELECT key, ts - (ts % ${H}) h, MIN(value) lo, MAX(value) hi, MAX(ts) last_ts FROM metrics WHERE key = '${key}' AND ts < ${APPLY_HOUR_SQL} GROUP BY h`;
    lines.push(`INSERT OR IGNORE INTO metrics (ts, key, value) SELECT g.h, '${key}.1h', (SELECT x.value FROM metrics x WHERE x.key = g.key AND x.ts = g.last_ts) FROM (${g}) g;`);
    lines.push(`INSERT OR IGNORE INTO metrics (ts, key, value) SELECT g.h, '${key}.1h.lo', g.lo FROM (${g}) g;`);
    lines.push(`INSERT OR IGNORE INTO metrics (ts, key, value) SELECT g.h, '${key}.1h.hi', g.hi FROM (${g}) g;`);
  }
  write('01_rollups.sql', 'Hourly rollups of the minute readings (series.ts rollupStmts: last reading, lowest, highest of each closed hour).', lines);
}
{
  const lines: string[] = [];
  // through the last day closed when the file is applied (a day still running is never written: its last reading is not the day's)
  for (let d = MASP_DAILY_LAST + D; d < toEnd + 45 * D; d += D) {
    lines.push(`INSERT OR IGNORE INTO metrics (ts, key, value) SELECT ${d}, 'supply.masp_shielded.daily', value FROM metrics WHERE key = 'supply.masp_shielded' AND ts >= ${d} AND ts < ${d + D} AND ${d + D} <= ${APPLY_DAY_SQL} ORDER BY ts DESC LIMIT 1;`);
  }
  write('02_masp_daily.sql', 'The shielded pool\'s daily balance after the chain-history backfill: the last minute reading of each day (as series.daily).', lines);
}

// ---------------------------------------------------------------- 03: trade-hours from the executed swaps

{
  // every hour closed when this script runs (the cron catches up on HOURLY_CATCH_UP closed hours after its deploy)
  const rows = d1<SwapRow>(`SELECT id, ts, kind, amount_num, counter_denom, counter_amount, pool_id, value_usd, from_addr, to_addr, meta FROM flows WHERE chain = 'osmosis' AND kind IN ('buy', 'sell') AND ts < ${Math.floor(Date.now() / H) * H} ORDER BY ts`);
  const hours = [...new Set(rows.map((r) => Math.floor(r.ts / H) * H))].sort((a, b) => a - b);
  // INSERT OR IGNORE: a price.swap_1h the cron already wrote stays as it was written (every old point still present).
  const lines = hours.flatMap((h) => swapHourStmts(rows, h).map((s) => inlineSql(s).replace(/^INSERT OR REPLACE/, 'INSERT OR IGNORE')));
  write('03_swap_hours.sql', `Trade-hours from ${rows.length} executed swaps in ${hours.length} hours (series.ts swapHourStmts; INSERT OR IGNORE: stored price.swap_1h points are kept).`, lines);
}

// ---------------------------------------------------------------- 04: the flow index by day

{
  const first = d1<{ t: number }>(`SELECT MIN(ts) t FROM flows`)[0].t;
  const refunds = d1<DayFlowRow>(`SELECT id, chain, ts, kind, from_addr, to_addr, amount_num, value_usd, meta FROM flows WHERE chain = 'osmosis' AND kind = 'other' AND meta LIKE '%"ibcTimeoutRefund":true%'`);
  const byDay = new Map<string, DayFlowRow[]>();
  const STEP = 20 * D;
  for (let a = Math.floor(first / D) * D; a < toEnd; a += STEP) {
    const b = Math.min(a + STEP, toEnd);
    const part = d1<DayFlowRow>(DAY_FLOWS_SQL.replace('f.ts >= ? AND f.ts < ?', `f.ts >= ${a} AND f.ts < ${b}`));
    for (const r of part) {
      // As scripts/out/repair/pos_balance_2026-10-20.sql files them, whether or not it has been applied yet: the
      // staking account's own balance moved by a wasm transfer is 'pos_balance', not a bond or a withdrawal.
      if (r.chain === 'namada' && (r.kind === 'bond' || r.kind === 'withdraw') && (r.from_addr === POS || r.to_addr === POS)
        && JSON.parse(String(r.meta ?? '{}'))?.descriptor === 'transfer-from-wasm') r.kind = 'pos_balance';
      const k = isoDay(r.ts); (byDay.get(k) ?? byDay.set(k, []).get(k)!).push(r);
    }
    console.log(`flows ${isoDay(a)} .. ${isoDay(b - 1)}: ${part.length}`);
  }
  const lines: string[] = [];
  let edges = 0, activity = 0;
  for (let d = Math.floor(first / D) * D; d < toEnd; d += D) {
    const day = isoDay(d);
    const agg = dayAggregates(byDay.get(day) ?? [], refunds.filter((r) => r.ts >= d && r.ts < d + 4 * D));
    const full = day >= EVERY_KIND_FROM;
    const st: Stmt[] = dayStmts(day, full ? agg : { edges: agg.edges, activity: [], metrics: {} });
    if (!full && !agg.edges.length) continue;
    edges += agg.edges.length; if (full) activity += agg.activity.length;
    lines.push(...st.map(inlineSql));
  }
  write('04_flow_days.sql', `flow_edges_daily for every day with flows (${edges} edges) and, from ${EVERY_KIND_FROM}, activity_daily (${activity} rows) and the daily keys (series.ts dayAggregates, the cron's own code).`, lines);
}

// ---------------------------------------------------------------- 05, 06: the Osmosis data API imports

async function get(url: string): Promise<unknown> {
  const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'NamadaTrade backfill (+https://namada.trade)' } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

{
  // Closed hours only, as the cron (series.poolPriceStmts): the hour the script runs in is partial, and once stored
  // as the newest point the cron, which writes the hours after the newest stored one, would never correct it.
  const points = (parsePairChart(await get(pairChartUrl('3005', 'all'))) ?? []).filter((p) => p.t < Math.floor(Date.now() / 3600000) * 3600000);
  const lines = poolPriceStmts(points, Math.floor(Date.now() / 3600000) * 3600000).map((s) => inlineSql(s).replace(/^INSERT OR REPLACE/, 'INSERT OR IGNORE'));

  write('05_pool_price.sql', `The Osmosis data API pair chart of pool 3005 (range=all): ${points.length} hourly points from ${points[0] ? new Date(points[0].t).toISOString().slice(0, 16) : '—'} UTC, ${points.filter((p) => p.flat).length} of them flat. Pool spot price in dollars per NAM, not executions.`, lines);
}

{
  const candles = await get(`${OSMOSIS_DATA}/tokens/v2/historical/${encodeURIComponent(NAM.osmoDenom)}/chart?tf=1440`);
  if (!Array.isArray(candles)) throw new Error('token candles: not a list');
  const fin = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  const out: Stmt[] = [];
  for (const c of candles as any[]) {
    const t = fin(c?.time);
    if (t == null) continue;
    const ts = t * 1000;
    for (const [k, v] of [['price.token_1d.osmosis', c.close], ['price.token_1d.osmosis.open', c.open], ['price.token_1d.osmosis.high', c.high], ['price.token_1d.osmosis.low', c.low], ['dex.volume_usd_daily.osmosis', c.volume]] as const) {
      const n = fin(v);
      if (n != null) out.push(stmt.metric(ts, k, n));
    }
  }
  const liq = await get(`${OSMOSIS_DATA}/pools/liquidity/3005/over_time`);
  if (!Array.isArray(liq)) throw new Error('pool liquidity: not a list');
  let nLiq = 0;
  for (const r of liq as any[]) {
    const ts = Date.parse(String(r?.timestamp ?? '').replace(' ', 'T') + 'Z');
    const v = fin(r?.liquidity_usd);
    // daily readings only (the answer also carries the current reading at its own time)
    if (!Number.isFinite(ts) || v == null || ts % D !== 0) continue;
    out.push(stmt.metric(ts, 'dex.ref_pool_liquidity_usd.daily.osmosis', v)); nLiq++;
  }
  write('06_osmosis_daily.sql', `The Osmosis data API token candles (${(candles as unknown[]).length} days, tf=1440) and pool 3005 liquidity over time (${nLiq} daily readings, the priced side only since Osmosis stopped pricing NAM).`, out.map((s) => inlineSql(s).replace(/^INSERT OR REPLACE/, 'INSERT OR IGNORE')));
}
