// The series writers (docs/design/screener-plan.md sections 3 and 5): the rows that make history. Every one of them
// records what the chain or a source said at a time; a day or an hour not recorded is a gap forever (nothing here is
// ever filled in afterwards with an estimate), so these ship first.
//
// Mounted in cron.ts by one call each: `hourly()` and `daily()` after the tick's first batch (both self-gated: they
// look at kv only in the first JOB_WINDOW_MS of an hour, so most ticks cost nothing), `balanceListingSeries()` when a
// balance listing completes and `bondListingSeries()` when a bond listing completes. The SQL is in series-sql.ts.
//
// Provenance (SERIES_META): every table and key family names its source and the first time it can exist; the API
// serves `firstDay` (the table's first row) with each range, so a chart never draws before its honest start.
import type { Env } from './util';
import { fetchJson } from './util';
import { runBatch, stmt, type Stmt } from './db';
import { INTERNAL_LABELS, NAMADA, OSMOSIS } from './config';
import { INTERNAL_ADDRS } from './holders';
import { fetchPairChart, fetchPairSummary, OSMOSIS_DATA_SOURCE, type PairChartPoint, type PairSummary } from './sources/osmosis-data';
import { safeParseJson, timedOutSends, ibcRowOf } from './analytics';
import type { BondListing } from './sources/namada';
import type { PoolInfo, SourceHealth } from '../../shared/types';
import {
  ROLLUP_KEYS, ROLLUP_HOUR_SQL, SWAP_HOUR_SQL, OSMOSIS_HOLDERS_SQL, POOL_HOURLY_SQL,
  DAY_FLOWS_SQL, REFUNDS_SQL, DELETE_EDGES_DAY_SQL, EDGE_SQL, ACTIVITY_SQL, LAST_IN_RANGE_SQL,
  HOLDER_COHORTS_NAMADA_SQL, HOLDER_COHORTS_OSMOSIS_SQL, COHORT_LABELLED_SQL,
  HOLDER_COHORT_ROW_SQL, COHORT_ROW_SQL, STAKERS_SQL, LISTING_ROW_SQL,
  UNBOND_QUEUE_DELETE_SQL, UNBOND_QUEUE_ROW_SQL, VALIDATOR_ROW_SQL,
} from './series-sql';

const H = 3600000, D = 86400000;
const INDEXER = 'https://indexer.namada.net/api/v1';

/** The hourly and daily jobs look at kv (one read each) only in the first minutes of an hour; then they run once. */
export const JOB_WINDOW_MS = 15 * 60_000;
/** Closed hours the hourly job catches up on after missed windows (rollups and swap hours are recomputable from rows). */
export const HOURLY_CATCH_UP = 6;
/** The daily snapshot waits until both chain listings completed within this long (the stored rows are as of them). */
export const SNAPSHOT_MAX_AGE_MS = 6 * H;
/** The flow-index day is written from this hour of the next UTC day (late rows: the Osmosis catch-up search). */
export const DAY_FLOWS_FROM_HOUR = 1;

export const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayStart = (ms: number) => Math.floor(ms / D) * D;

/** Source and start of every series this file writes (W3 serves these with the rows; F2 turns the source into plain words). */
export const SERIES_META = {
  pool_hourly: { source: 'Osmosis SQS (pools) · Osmosis data API (pair summary)', start: 'deploy day of migration 0007 (per-pool readings were not kept before)' },
  holder_cohorts_daily: { source: 'Namada node balance listing and bond listing (holder index) · Keplr Osmosis bank list', start: 'first daily snapshot after migration 0007; no earlier balance of every address exists anywhere a Worker can reach' },
  cohort_daily: { source: 'Genesis allocations (labels, source genesis) · holder index', start: 'as holder_cohorts_daily' },
  flow_edges_daily: { source: 'NamadaTrade flow index', start: 'per kind: staking 3 Dec 2024, transfers and shielding 13 Jun 2025, bridge in 20 Jun 2025, every kind 14 Aug 2026 (screener-plan 3.2); backfilled from flows' },
  activity_daily: { source: 'NamadaTrade flow index', start: '14 Aug 2026 for every kind (Osmosis 31 Jul / 11 Aug 2026); backfilled from flows' },
  validator_daily: { source: 'Namada node bond listing · names and commission from indexer.namada.net /pos/validator/all', start: 'deploy day of migration 0007' },
  unbond_queue: { source: 'Namada node bond listing (every unbond on the chain)', start: 'deploy day of migration 0007 (current state only)' },
  listings: { source: 'cron.ts runBalanceListing / runBondListing', start: 'deploy day of migration 0007' },
  'metrics:*.1h': { source: 'hourly rollup of the minute readings', start: 'the minute series: price.usd and supply 15 Oct 2026, dex.liquidity_usd 17 Oct 2026, supply.total_stake 18 Oct 2026 (backfill from minute rows)' },
  'metrics:price.swap_1h.*, dex.swaps_1h.*': { source: 'executed Osmosis swaps (flow index)', start: '12 Aug 2026 (backfill from flows)' },
  'metrics:price.pool_1h*': { source: OSMOSIS_DATA_SOURCE + ' pair chart, pool 3005 (pool spot price, not executions)', start: '20 Jun 2025 19:00 UTC with the one-off range=all import, else deploy day' },
  'metrics:dex.volume_*_usd_osmosis': { source: OSMOSIS_DATA_SOURCE + ' pair summary (priced leg only)', start: 'deploy day (the summary is live only)' },
  'metrics:holders.*': { source: 'Namada node balance listing at height H (and the bond listing for stakers) · Keplr Osmosis bank list', start: 'first complete listing after deploy; new and emptied holders from the second' },
  'metrics:stake.*': { source: 'Namada node bond listing; shares against the chain total stake (/vp/pos/total_stake)', start: 'first complete bond listing after deploy' },
  'metrics:*_daily': { source: 'NamadaTrade flow index (masp.*, dex.*, active.*, bridge.*: Osmosis records for the bridge) · supply.masp_shielded.daily: last minute reading of the day', start: 'as flow_edges_daily; supply.masp_shielded.daily 13 Jun 2025 (chain history backfill)' },
} as const;

// ---------------------------------------------------------------- jobs bookkeeping

interface DailyJob { day: string; snapNamada?: boolean; snapOsmosis?: boolean; flows?: boolean; names?: boolean; /** the hour the validator list was last asked for (once an hour while it fails) */ namesTried?: number }

async function kvJson<T>(db: D1Database, keys: string[]): Promise<Record<string, T | null>> {
  const out: Record<string, T | null> = {};
  for (const k of keys) out[k] = null;
  const rows = await db.prepare(`SELECT key, value FROM kv WHERE key IN (${keys.map(() => '?').join(',')})`).bind(...keys).all<{ key: string; value: string }>();
  for (const r of rows.results || []) out[r.key] = safeParseJson(r.value, null) as T | null;
  return out;
}
const kvStmt = (key: string, value: unknown, at: number): Stmt => stmt.kvSet(key, JSON.stringify(value), at);

// ---------------------------------------------------------------- executed swaps per hour

export interface SwapRow {
  id?: string; ts: number; kind: string; amount_num: number; counter_denom: string | null; counter_amount: number | null;
  pool_id: string | null; value_usd: number | null; from_addr: string | null; to_addr: string | null; meta: string | Record<string, unknown> | null;
}

/** The median of an ascending list, as cron.ts phase 3 has always computed price.swap_1h. */
export function medianOf(sorted: number[]): number {
  return sorted.length % 2 ? sorted[sorted.length >> 1] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
}

/** A swap the executed price trusts (cron.ts SINGLE_POOL_USDC_SWAP, in code). */
export const singlePoolUsdc = (r: SwapRow) =>
  r.counter_denom === 'USDC' && (r.kind === 'buy' || r.kind === 'sell') && r.amount_num >= 50 && (r.counter_amount ?? 0) > 0 && r.pool_id != null && !r.pool_id.includes(',');

const metaOf = (m: SwapRow['meta']): Record<string, any> => (typeof m === 'string' ? safeParseJson(m, {}) ?? {} : m ?? {});

/**
 * Every key of one trade-hour (screener-plan 2.2, 3.5 a), from that hour's buy and sell rows. Nothing for an hour
 * without a trade.
 * - price.swap_1h (+ .n): the median of the trusted swaps' prices, the same value cron.ts phase 3 writes;
 *   .open / .high / .low / .close / .vwap of the same swaps in time order.
 * - dex.swaps_1h.n / .nam / .buy_nam / .sell_nam / .buyers / .sellers over every buy and sell, bots left out;
 *   .usd the sum of each trade's value at execution, written only when every trade of the hour has one;
 *   .buy_vwap / .sell_vwap: dollars per NAM over the priced trades of that side (none written without one).
 */
export function swapHourStmts(rows: SwapRow[], hour: number): Stmt[] {
  const out: Stmt[] = [];
  const m = (k: string, v: number | null) => { if (v != null && Number.isFinite(v)) out.push(stmt.metric(hour, k, v)); };
  const inHour = rows.filter((r) => r.ts >= hour && r.ts < hour + H).sort((a, b) => a.ts - b.ts || String(a.id ?? '').localeCompare(String(b.id ?? '')));
  const trusted = inHour.filter(singlePoolUsdc);
  if (trusted.length) {
    const px = trusted.map((s) => s.counter_amount! / s.amount_num);
    const sorted = [...px].sort((a, b) => a - b);
    m('price.swap_1h', medianOf(sorted));
    m('price.swap_1h.n', px.length);
    m('price.swap_1h.open', px[0]);
    m('price.swap_1h.close', px[px.length - 1]);
    m('price.swap_1h.high', sorted[sorted.length - 1]);
    m('price.swap_1h.low', sorted[0]);
    m('price.swap_1h.vwap', trusted.reduce((a, s) => a + s.counter_amount!, 0) / trusted.reduce((a, s) => a + s.amount_num, 0));
  }
  const trades = inHour.filter((r) => (r.kind === 'buy' || r.kind === 'sell') && metaOf(r.meta).arb !== true);
  if (trades.length) {
    const maker = (r: SwapRow) => { const t = metaOf(r.meta).trader; return typeof t === 'string' && t ? t : r.kind === 'buy' ? r.to_addr : r.from_addr; };
    const buys = trades.filter((r) => r.kind === 'buy'), sells = trades.filter((r) => r.kind === 'sell');
    const sum = (xs: SwapRow[], f: (r: SwapRow) => number) => xs.reduce((a, r) => a + f(r), 0);
    const vwap = (xs: SwapRow[]) => { const p = xs.filter((r) => r.value_usd != null && r.amount_num > 0); const n = sum(p, (r) => r.amount_num); return n > 0 ? sum(p, (r) => r.value_usd!) / n : null; };
    m('dex.swaps_1h.n', trades.length);
    m('dex.swaps_1h.nam', sum(trades, (r) => r.amount_num));
    if (trades.every((r) => r.value_usd != null)) m('dex.swaps_1h.usd', sum(trades, (r) => r.value_usd!));
    m('dex.swaps_1h.buy_nam', sum(buys, (r) => r.amount_num));
    m('dex.swaps_1h.sell_nam', sum(sells, (r) => r.amount_num));
    m('dex.swaps_1h.buyers', new Set(buys.map(maker).filter(Boolean)).size);
    m('dex.swaps_1h.sellers', new Set(sells.map(maker).filter(Boolean)).size);
    m('dex.swaps_1h.buy_vwap', vwap(buys));
    m('dex.swaps_1h.sell_vwap', vwap(sells));
  }
  return out;
}

// ---------------------------------------------------------------- hourly

export interface HourlyCtx {
  /** the router's pools answer this tick (cron.ts poolRes) and when it was read */
  pools: PoolInfo[];
  poolsAt: number | null;
  health: SourceHealth[];
  /** a chain listing is being read this tick: the Osmosis downloads wait for a quieter tick in the window */
  listingTick: boolean;
  signal?: AbortSignal;
  /** for tests */
  summary?: (signal?: AbortSignal) => Promise<PairSummary>;
  chart?: (signal?: AbortSignal) => Promise<PairChartPoint[] | null>;
}

export interface HourlyResult { hour: number; rolled: number[]; written: number; summaryAt: number | null; chartPoints: number | null }

/** The closed hours to roll up: from the hour after the last run's (at most HOURLY_CATCH_UP back) to the one just closed. */
export function hoursToRoll(lastRunHour: number | null, hour: number): number[] {
  const from = lastRunHour == null ? hour - H : Math.max(lastRunHour, hour - HOURLY_CATCH_UP * H);
  const out: number[] = [];
  for (let h = from; h <= hour - H; h += H) out.push(h);
  return out;
}

/** `<key>.1h`, `.1h.lo`, `.1h.hi` for one closed hour from ROLLUP_HOUR_SQL's rows. */
export function rollupStmts(rows: { key: string; lo: number; hi: number; n: number; last: number | null }[], hour: number): Stmt[] {
  const out: Stmt[] = [];
  for (const r of rows) {
    if (!(r.n > 0) || r.last == null) continue;
    out.push(stmt.metric(hour, `${r.key}.1h`, r.last), stmt.metric(hour, `${r.key}.1h.lo`, r.lo), stmt.metric(hour, `${r.key}.1h.hi`, r.hi));
  }
  return out;
}

/** pool_hourly rows for `hour`: every pool the router listed, plus every NAM pair the Osmosis summary lists. */
export function poolHourlyStmts(hour: number, pools: PoolInfo[], poolsAt: number | null, summary: PairSummary | null): Stmt[] {
  const byId = new Map<string, { p?: PoolInfo; s?: PairSummary['pairs'][number] }>();
  for (const p of pools) if (p.id) (byId.get(p.id) ?? byId.set(p.id, {}).get(p.id)!).p = p;
  for (const s of summary?.pairs ?? []) (byId.get(s.poolId) ?? byId.set(s.poolId, {}).get(s.poolId)!).s = s;
  const fin = (v: number | null | undefined) => (v != null && Number.isFinite(v) ? v : null);
  return [...byId.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).map(([id, { p, s }]) => ({
    sql: POOL_HOURLY_SQL,
    params: [hour, id, p ? poolsAt : null, fin(p?.liquidityUsd), fin(p?.namReserve), fin(p?.counterReserve), fin(p?.spreadFactor),
      s ? s.volume24hUsd : null, s ? s.volume7dUsd : null, s ? s.liquidityUsd : null, s ? summary!.at : null],
  }));
}

/** The pool price points of the closed and the current hour (screener-plan 5.3: price.pool_1h, .open, .high, .low, .flat). */
export function poolPriceStmts(points: PairChartPoint[], hour: number): Stmt[] {
  const out: Stmt[] = [];
  for (const p of points) {
    if (p.t < hour - H || p.t > hour) continue;
    out.push(stmt.metric(p.t, 'price.pool_1h', p.usd.close), stmt.metric(p.t, 'price.pool_1h.open', p.usd.open), stmt.metric(p.t, 'price.pool_1h.high', p.usd.high),
      stmt.metric(p.t, 'price.pool_1h.low', p.usd.low), stmt.metric(p.t, 'price.pool_1h.flat', p.flat ? 1 : 0));
  }
  return out;
}

/**
 * Once an hour, in the first JOB_WINDOW_MS (kv jobs.hourly: the hour it last ran): the rollups and the full
 * trade-hour keys of the closed hour(s), pool_hourly for this hour, the Osmosis data API's pair summary and the
 * reference pool's pair chart (5.4: +2 requests an hour, on a tick that reads no chain listing unless the window is
 * about to close), and holders.osmosis. A failed outside read writes nothing for that source and says so in health.
 */
export async function hourly(env: Env, now: number, ctx: HourlyCtx): Promise<HourlyResult | null> {
  if (now % H >= JOB_WINDOW_MS) return null;
  const hour = Math.floor(now / H) * H;
  const jobs = await kvJson<number>(env.DB, ['jobs.hourly']);
  const last = jobs['jobs.hourly'];
  if (last != null && last >= hour) return null;
  if (ctx.listingTick && now % H < JOB_WINDOW_MS - 2 * 60_000) return null;

  const stmts: Stmt[] = [];
  const rolled = hoursToRoll(last, hour);
  for (const h of rolled) {
    const rows = (await env.DB.prepare(ROLLUP_HOUR_SQL).bind(...ROLLUP_KEYS, h, h + H).all<any>()).results || [];
    stmts.push(...rollupStmts(rows, h));
    const swaps = (await env.DB.prepare(SWAP_HOUR_SQL).bind(h, h + H).all<SwapRow>()).results || [];
    stmts.push(...swapHourStmts(swaps, h));
  }

  const [summary, chart] = await Promise.all([
    (ctx.summary ?? fetchPairSummary)(ctx.signal).then((v) => ({ v }), (e) => ({ e })),
    (ctx.chart ?? ((s?: AbortSignal) => fetchPairChart(OSMOSIS.refPoolId, '7d', s)))(ctx.signal).then((v) => ({ v }), (e) => ({ e })),
  ]);
  let sum: PairSummary | null = null;
  if ('v' in summary && summary.v.at != null) {
    sum = summary.v;
    if (sum.volume24hUsd != null) stmts.push(stmt.metric(sum.at!, 'dex.volume_24h_usd_osmosis', sum.volume24hUsd));
    if (sum.volume7dUsd != null) stmts.push(stmt.metric(sum.at!, 'dex.volume_7d_usd_osmosis', sum.volume7dUsd));
    ctx.health.push({ name: `${OSMOSIS_DATA_SOURCE} (summary)`, ok: true, at: now, note: `${sum.pairs.length} NAM pairs, updated ${new Date(sum.at!).toISOString().slice(11, 16)} UTC` });
  } else {
    const why = 'e' in summary ? String(summary.e).slice(0, 120) : 'the answer had no update time';
    ctx.health.push({ name: `${OSMOSIS_DATA_SOURCE} (summary)`, ok: false, at: now, note: `Not read this hour (${why}); the last stored volumes stand, with their own time.` });
  }
  let chartPoints: number | null = null;
  if ('v' in chart) {
    if (chart.v) { stmts.push(...poolPriceStmts(chart.v, hour)); chartPoints = chart.v.length; }
    ctx.health.push({ name: `${OSMOSIS_DATA_SOURCE} (pairs)`, ok: !!chart.v, at: now, note: chart.v ? `pool ${OSMOSIS.refPoolId}: ${chart.v.length} hourly points` : `pool ${OSMOSIS.refPoolId}: no series` });
  } else {
    ctx.health.push({ name: `${OSMOSIS_DATA_SOURCE} (pairs)`, ok: false, at: now, note: `Not read this hour (${String(chart.e).slice(0, 120)}); the last stored pool prices stand.` });
  }
  stmts.push(...poolHourlyStmts(hour, ctx.pools, ctx.pools.length ? ctx.poolsAt : null, sum));

  const oh = await env.DB.prepare(OSMOSIS_HOLDERS_SQL).first<{ n: number; at: number | null }>();
  if (oh?.at != null && now - oh.at < H) stmts.push(stmt.metric(oh.at, 'holders.osmosis', oh.n));

  stmts.push(kvStmt('jobs.hourly', hour, now));
  const written = await runBatch(env.DB, stmts);
  return { hour, rolled, written, summaryAt: sum?.at ?? null, chartPoints };
}

// ---------------------------------------------------------------- daily: the flow index

export interface DayFlowRow {
  id: string; chain: string; ts: number; kind: string; from_addr: string | null; to_addr: string | null;
  amount_num: number; value_usd: number | null; meta: string | Record<string, unknown> | null;
  from_label_cat?: string | null; to_label_cat?: string | null; from_label_src?: string | null; to_label_src?: string | null;
}

/** Curated label categories an edge may name (a user's own tag never becomes a category). */
const CATS = new Set(['genesis', 'backer', 'foundation', 'pool', 'pos', 'masp', 'ibc', 'module']);
const PROTOCOL = new Set(INTERNAL_ADDRS);

/** The category of one side of a flow (migration 0007, flow_edges_daily). */
export function sideCategory(addr: string | null, labelCat: string | null | undefined, labelSrc: string | null | undefined, chain: string): string {
  if (!addr) return 'unknown';
  const internal = INTERNAL_LABELS[addr]?.category;
  if (internal) return internal;
  if (labelCat && CATS.has(labelCat) && labelSrc !== 'user') return labelCat;
  if (chain === 'namada' && addr.startsWith('osmo1')) return 'osmosis';
  if (chain === 'osmosis' && addr.startsWith('tnam1')) return 'namada';
  return 'user';
}

export interface DayAggregates {
  edges: { chain: string; kind: string; from_cat: string; to_cat: string; n: number; nam: number; usd: number | null }[];
  activity: { chain: string; flows: number; senders: number; receivers: number; active: number; nam: number; trades: number; traders: number }[];
  /** the day's metric keys (screener-plan 5.3 "Daily") and their values */
  metrics: Record<string, number>;
}

/**
 * One UTC day of flows as edges, activity and the daily keys. `refunds`: Osmosis bridge refunds from the day's
 * start to three days after its end. Left out everywhere: other coins (meta.tokenSymbol), bridge sends that timed
 * out and their refunds. Bot round trips are kept as kind 'bot' in the edges and left out of activity and volume.
 */
export function dayAggregates(rows: DayFlowRow[], refunds: DayFlowRow[]): DayAggregates {
  const meta = (r: DayFlowRow) => metaOf(r.meta);
  const nam = rows.filter((r) => meta(r).tokenSymbol == null);
  const outs = nam.filter((r) => r.chain === 'osmosis' && r.kind === 'ibc_out');
  const gone = timedOutSends(outs.map(ibcRowOf), refunds.map(ibcRowOf));
  const isRefund = (r: DayFlowRow) => r.kind === 'other' && meta(r).ibcTimeoutRefund === true;
  const isBot = (r: DayFlowRow) => meta(r).arb === true || (r.kind === 'other' && !isRefund(r));
  const kept = nam.filter((r) => !gone.has(r.id) && !isRefund(r));

  const edges = new Map<string, DayAggregates['edges'][number] & { priced: boolean }>();
  for (const r of kept) {
    const kind = isBot(r) ? 'bot' : r.kind;
    const fc = sideCategory(r.from_addr, r.from_label_cat, r.from_label_src, r.chain), tc = sideCategory(r.to_addr, r.to_label_cat, r.to_label_src, r.chain);
    const k = [r.chain, kind, fc, tc].join('|');
    const e = edges.get(k) ?? edges.set(k, { chain: r.chain, kind, from_cat: fc, to_cat: tc, n: 0, nam: 0, usd: 0, priced: true }).get(k)!;
    e.n++; e.nam += r.amount_num;
    if (r.value_usd == null) e.priced = false; else e.usd = (e.usd ?? 0) + r.value_usd;
  }

  const real = kept.filter((r) => !isBot(r));
  const ownChain = (a: string | null, chain: string) => !!a && !PROTOCOL.has(a) && (chain === 'namada' ? a.startsWith('tnam1') : a.startsWith('osmo1'));
  const isPool = (cat: string | null | undefined, src: string | null | undefined) => cat === 'pool' && src !== 'user';
  const activity: DayAggregates['activity'] = [];
  const metrics: Record<string, number> = {};
  for (const chain of ['namada', 'osmosis']) {
    const rs = real.filter((r) => r.chain === chain);
    const senders = new Set(rs.filter((r) => ownChain(r.from_addr, chain) && !isPool(r.from_label_cat, r.from_label_src)).map((r) => r.from_addr!));
    const receivers = new Set(rs.filter((r) => ownChain(r.to_addr, chain) && !isPool(r.to_label_cat, r.to_label_src)).map((r) => r.to_addr!));
    const trades = rs.filter((r) => r.kind === 'buy' || r.kind === 'sell');
    const maker = (r: DayFlowRow) => { const t = meta(r).trader; return typeof t === 'string' && t ? t : r.kind === 'buy' ? r.to_addr : r.from_addr; };
    activity.push({
      chain, flows: rs.length, senders: senders.size, receivers: receivers.size, active: new Set([...senders, ...receivers]).size,
      nam: rs.reduce((a, r) => a + r.amount_num, 0), trades: trades.length, traders: new Set(trades.map(maker).filter(Boolean)).size,
    });
    metrics[`active.${chain}_daily`] = new Set([...senders, ...receivers]).size;
    if (chain === 'osmosis') {
      metrics['dex.volume_nam_daily'] = trades.reduce((a, r) => a + r.amount_num, 0);
      if (trades.every((r) => r.value_usd != null)) metrics['dex.volume_usd_daily'] = trades.reduce((a, r) => a + (r.value_usd ?? 0), 0);
      metrics['dex.traders_daily'] = new Set(trades.map(maker).filter(Boolean)).size;
      metrics['dex.hours_with_trades_daily'] = new Set(trades.map((r) => Math.floor(r.ts / H))).size;
      // The bridge from the Osmosis records (the trustworthy side since 31 Jul 2026, screener-plan 3.2).
      metrics['bridge.in_daily'] = rs.filter((r) => r.kind === 'ibc_out').reduce((a, r) => a + r.amount_num, 0);
      metrics['bridge.out_daily'] = rs.filter((r) => r.kind === 'ibc_in').reduce((a, r) => a + r.amount_num, 0);
      metrics['bridge.refunded_daily'] = outs.filter((r) => gone.has(r.id)).reduce((a, r) => a + r.amount_num, 0);
    } else {
      const M = NAMADA.internal.masp;
      metrics['masp.in_daily'] = rs.filter((r) => r.to_addr === M).reduce((a, r) => a + r.amount_num, 0);
      metrics['masp.out_daily'] = rs.filter((r) => r.from_addr === M).reduce((a, r) => a + r.amount_num + (Number(meta(r).maspFeeNam) || 0), 0);
    }
  }
  return { edges: [...edges.values()].map(({ priced, ...e }) => ({ ...e, usd: priced ? e.usd : null })), activity, metrics };
}

/** The statements that write one day's aggregates (the day's edges replaced whole). */
export function dayStmts(day: string, agg: DayAggregates): Stmt[] {
  const ts = Date.parse(`${day}T00:00:00Z`);
  return [
    { sql: DELETE_EDGES_DAY_SQL, params: [day] },
    ...agg.edges.map((e) => ({ sql: EDGE_SQL, params: [day, e.chain, e.kind, e.from_cat, e.to_cat, e.n, e.nam, e.usd] })),
    ...agg.activity.map((a) => ({ sql: ACTIVITY_SQL, params: [day, a.chain, a.flows, a.senders, a.receivers, a.active, a.nam, a.trades, a.traders] })),
    ...Object.entries(agg.metrics).map(([k, v]) => stmt.metric(ts, k, v)),
  ];
}

/** Read one UTC day of flows (and the refunds that can cancel its sends) and aggregate it. */
export async function readDay(db: D1Database, day: string): Promise<DayAggregates> {
  const from = Date.parse(`${day}T00:00:00Z`);
  const [rows, refunds] = await Promise.all([
    db.prepare(DAY_FLOWS_SQL).bind(from, from + D).all<DayFlowRow>(),
    db.prepare(REFUNDS_SQL).bind(from, from + 4 * D).all<DayFlowRow>(),
  ]);
  return dayAggregates(rows.results || [], refunds.results || []);
}

// ---------------------------------------------------------------- daily: the snapshots

export interface CohortRow { bucket?: string; category?: string; holders?: number; addrs?: number; addrs_with_nam?: number; nam?: number; spendable: number; staked: number }

export function holderCohortStmts(day: string, chain: string, rows: CohortRow[], asOf: number): Stmt[] {
  return rows.filter((r) => r.bucket && (r.holders ?? 0) > 0).map((r) => ({ sql: HOLDER_COHORT_ROW_SQL, params: [day, chain, r.bucket, r.holders, r.nam ?? 0, r.spendable ?? 0, r.staked ?? 0, asOf] }));
}
export function cohortStmts(day: string, rows: CohortRow[], asOf: number): Stmt[] {
  return rows.filter((r) => r.category).map((r) => ({ sql: COHORT_ROW_SQL, params: [day, r.category, r.addrs ?? 0, r.addrs_with_nam ?? 0, r.spendable ?? 0, r.staked ?? 0, asOf] }));
}

/**
 * The 'none' cohort without a second pass over the holders: every holder is in exactly one size line, and the
 * labelled addresses holding NAM are holders (same union, same stake rule), so the rest is the totals minus them.
 */
export function noneCohort(cohorts: CohortRow[], labelled: CohortRow[]): CohortRow {
  const sum = (xs: CohortRow[], f: (r: CohortRow) => number) => xs.reduce((a, r) => a + (f(r) || 0), 0);
  const holders = sum(cohorts, (r) => r.holders ?? 0) - sum(labelled, (r) => r.addrs_with_nam ?? 0);
  return { category: 'none', addrs: holders, addrs_with_nam: holders, spendable: sum(cohorts, (r) => r.spendable) - sum(labelled, (r) => r.spendable), staked: sum(cohorts, (r) => r.staked) - sum(labelled, (r) => r.staked) };
}

export interface ValidatorName { address: string; name: string | null; commission: number | null; state: string | null }
export interface ValidatorNames { at: number; validators: ValidatorName[] }

/** indexer.namada.net /pos/validator/all, kept to name, commission and state (no contact fields are stored). */
export function parseValidatorList(json: unknown, at: number): ValidatorNames {
  if (!Array.isArray(json)) throw new Error('validator list: the answer is not a list');
  const validators: ValidatorName[] = [];
  for (const v of json as any[]) {
    if (typeof v?.address !== 'string' || !v.address.startsWith('tnam1')) continue;
    const c = Number(v.commission);
    const name = typeof v.name === 'string' && v.name.trim() && v.name !== '<decommissioned>' ? v.name.trim().slice(0, 80) : null;
    validators.push({ address: v.address, name, commission: v.commission != null && Number.isFinite(c) && c >= 0 && c <= 1 ? c : null, state: typeof v.state === 'string' ? v.state : null });
  }
  return { at, validators };
}

export interface DailyCtx { health: SourceHealth[]; signal?: AbortSignal; validators?: (signal?: AbortSignal) => Promise<unknown> }
export interface DailyResult { day: string; ran: string[]; waiting: string[]; written: number }

/**
 * Once a day (kv jobs.daily), each part when it can run, in the first JOB_WINDOW_MS of an hour:
 * - the snapshots of the UTC day (holder_cohorts_daily, cohort_daily), when both chain listings completed within
 *   SNAPSHOT_MAX_AGE_MS (Namada) or the Osmosis holder list is that fresh (Osmosis); `as_of` is the older listing;
 *   a day whose listings never become fresh stays a gap;
 * - from DAY_FLOWS_FROM_HOUR, the flow index of the two days before (flow_edges_daily, activity_daily, the daily
 *   keys; the day before yesterday again for rows that arrived late) and supply.masp_shielded.daily of yesterday;
 * - the validator list (names, commission, state) into kv validators.names for validator_daily.
 */
export async function daily(env: Env, now: number, ctx: DailyCtx): Promise<DailyResult | null> {
  if (now % H >= JOB_WINDOW_MS) return null;
  const day = isoDay(now);
  const kv = await kvJson<any>(env.DB, ['jobs.daily', 'balance.listing', 'bond.listing']);
  const job: DailyJob = kv['jobs.daily']?.day === day ? kv['jobs.daily'] : { day };
  if (job.snapNamada && job.snapOsmosis && job.flows && job.names) return null;
  const res: DailyResult = { day, ran: [], waiting: [], written: 0 };
  const stmts: Stmt[] = [];

  if (!job.snapNamada) {
    const b = Number(kv['balance.listing']?.completeAt) || 0, s = Number(kv['bond.listing']?.completeAt) || 0;
    const asOf = Math.min(b, s);
    if (b > 0 && s > 0 && now - asOf < SNAPSHOT_MAX_AGE_MS) {
      const [cohorts, labelled] = await Promise.all([env.DB.prepare(HOLDER_COHORTS_NAMADA_SQL).all<CohortRow>(), env.DB.prepare(COHORT_LABELLED_SQL).all<CohortRow>()]);
      const lab = labelled.results || [];
      stmts.push(...holderCohortStmts(day, 'namada', cohorts.results || [], asOf), ...cohortStmts(day, [...lab, noneCohort(cohorts.results || [], lab)], asOf));
      job.snapNamada = true; res.ran.push('snapshot namada');
    } else res.waiting.push(`snapshot namada: ${!b || !s ? 'no complete listing yet' : `the older listing is ${((now - asOf) / H).toFixed(1)} h old`}`);
  }
  if (!job.snapOsmosis) {
    const oh = await env.DB.prepare(OSMOSIS_HOLDERS_SQL).first<{ n: number; at: number | null }>();
    if (oh?.at != null && now - oh.at < SNAPSHOT_MAX_AGE_MS) {
      const rows = (await env.DB.prepare(HOLDER_COHORTS_OSMOSIS_SQL).all<CohortRow>()).results || [];
      stmts.push(...holderCohortStmts(day, 'osmosis', rows, oh.at));
      job.snapOsmosis = true; res.ran.push('snapshot osmosis');
    } else res.waiting.push('snapshot osmosis: the holder list is older than 6 h');
  }
  if (!job.flows) {
    if (new Date(now).getUTCHours() >= DAY_FLOWS_FROM_HOUR) {
      const today = dayStart(now);
      for (const d of [today - D, today - 2 * D]) stmts.push(...dayStmts(isoDay(d), await readDay(env.DB, isoDay(d))));
      const masp = await env.DB.prepare(LAST_IN_RANGE_SQL).bind('supply.masp_shielded', today - D, today).first<{ ts: number; value: number }>();
      if (masp) stmts.push(stmt.metric(today - D, 'supply.masp_shielded.daily', masp.value));
      job.flows = true; res.ran.push('flow index');
    } else res.waiting.push(`flow index: from ${DAY_FLOWS_FROM_HOUR}:00 UTC`);
  }
  const hourNow = Math.floor(now / H) * H;
  if (!job.names && job.namesTried !== hourNow) {
    job.namesTried = hourNow;
    const t0 = Date.now();
    try {
      const list = parseValidatorList(await (ctx.validators ?? ((s?: AbortSignal) => fetchJson<unknown>(`${INDEXER}/pos/validator/all`, { timeoutMs: 10_000, retries: 0, signal: s })))(ctx.signal), now);
      stmts.push(kvStmt('validators.names', list, now));
      job.names = true; res.ran.push('validator names');
      ctx.health.push({ name: 'Namada indexer (validator list)', ok: true, at: now, latencyMs: Date.now() - t0, note: `${list.validators.length} validators` });
    } catch (e) {
      ctx.health.push({ name: 'Namada indexer (validator list)', ok: false, at: now, latencyMs: Date.now() - t0, note: `Not read: ${String(e).slice(0, 120)}; names stay as last read.` });
    }
  }
  // The marker is written when something ran or was tried (a tick that only waited writes nothing).
  if (stmts.length || JSON.stringify(job) !== JSON.stringify(kv['jobs.daily'])) stmts.push(kvStmt('jobs.daily', job, now));
  res.written = stmts.length ? await runBatch(env.DB, stmts) : 0;
  if (res.waiting.length) ctx.health.push({ name: 'Series (daily snapshot)', ok: !!(job.snapNamada && job.snapOsmosis), at: now, note: `Waiting: ${res.waiting.join('; ')}`.slice(0, 160) });
  else ctx.health.push({ name: 'Series (daily snapshot)', ok: true, at: now, note: `Written for ${day}: ${res.ran.join(', ')}` });
  return res;
}

// ---------------------------------------------------------------- the balance listing's keys

export interface StoredHolder { address: string; balance_num: number; updated_at?: number | null; first_seen?: number | null }

export interface HolderListingStats {
  /** holders as the holder list counts them: spendable at the listing ∪ stakers, protocol accounts left out */
  holders: number;
  /** of those, whole holding (spendable + staked) under 1 NAM */
  under1: number;
  /** spendable NAM of user addresses at the listing */
  userNam: number;
  /** addresses holding spendable NAM for the first time this site saw since migration 0007 (null for the first listing) */
  added: number | null;
  /** addresses that held spendable NAM since the previous listing and hold none at this one (null for the first) */
  emptied: number | null;
}

/**
 * Counts from a complete balance listing (screener-plan 3.6). `entries`: the listing (address → base units, zeros
 * listed); `stored`: the Namada holder rows as read at the start of this tick; `stakers`: address → staked NAM;
 * `prevCompleteAt`: the previous complete listing. A row first seen after the previous listing counts as added;
 * one that held NAM then or moved since (updated after it) and the listing finds empty counts as emptied, unless it
 * was itself first seen since (it came and went between two listings).
 */
export function holderListingStats(entries: Map<string, string>, stored: StoredHolder[], stakers: Map<string, number>, prevCompleteAt: number | null): HolderListingStats {
  const spend = new Map<string, number>();
  let userNam = 0;
  for (const [a, v] of entries) if (v !== '0' && !PROTOCOL.has(a)) { const n = Number(BigInt(v)) / 1e6; spend.set(a, n); userNam += n; }
  const all = new Set<string>([...spend.keys(), ...[...stakers.keys()].filter((a) => !PROTOCOL.has(a))]);
  let under1 = 0;
  for (const a of all) if ((spend.get(a) ?? 0) + (stakers.get(a) ?? 0) < 1) under1++;
  let added: number | null = null, emptied: number | null = null;
  if (prevCompleteAt != null) {
    const by = new Map(stored.map((s) => [s.address, s]));
    added = 0; emptied = 0;
    for (const a of spend.keys()) { const s = by.get(a); if (!s || (s.first_seen != null && s.first_seen > prevCompleteAt)) added++; }
    for (const s of stored) {
      if (PROTOCOL.has(s.address) || spend.has(s.address)) continue;
      if (s.first_seen != null && s.first_seen > prevCompleteAt) continue;
      if (s.balance_num > 0 || (s.updated_at ?? 0) > prevCompleteAt) emptied++;
    }
  }
  return { holders: all.size, under1, userNam, added, emptied };
}

export function holderListingStmts(at: number, st: HolderListingStats, rec: { height: number; provider: string }): Stmt[] {
  const out = [stmt.metric(at, 'holders.namada', st.holders), stmt.metric(at, 'holders.namada.under1', st.under1), stmt.metric(at, 'holders.namada.user_nam', st.userNam)];
  if (st.added != null) out.push(stmt.metric(at, 'holders.namada.new_1h', st.added));
  if (st.emptied != null) out.push(stmt.metric(at, 'holders.namada.gone_1h', st.emptied));
  out.push({ sql: LISTING_ROW_SQL, params: [at, 'balance', rec.height, rec.provider] });
  return out;
}

/** cron.ts runBalanceListing, when a pass completes: the stakers read, the counts, one batch. */
export async function balanceListingSeries(db: D1Database, at: number, entries: Map<string, string>, stored: StoredHolder[], prevCompleteAt: number | null, rec: { height: number; provider: string }): Promise<HolderListingStats> {
  const rows = (await db.prepare(STAKERS_SQL).all<{ address: string; st: number }>()).results || [];
  const st = holderListingStats(entries, stored, new Map(rows.map((r) => [r.address, r.st])), prevCompleteAt);
  await runBatch(db, holderListingStmts(at, st, rec));
  return st;
}

// ---------------------------------------------------------------- the bond listing's rows

export interface UnbondQueue { rows: { epoch: number; nam: number; n: number }[]; hash: string; withdrawableNam: number; unbondingNam: number }

/** 32-bit FNV-1a of a string, hex: enough to tell whether the queue changed. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

/** Every unbond in the listing by withdraw epoch (net of slashing), and how much is withdrawable at `epoch` or still waiting. */
export function unbondQueue(listing: Pick<BondListing, 'sources'>, epoch: number): UnbondQueue {
  const by = new Map<number, { base: bigint; n: number }>();
  for (const s of listing.sources.values()) for (const u of s.unbonds ?? []) {
    if (u.amountBase <= 0n) continue;
    const b = by.get(u.withdrawEpoch) ?? by.set(u.withdrawEpoch, { base: 0n, n: 0 }).get(u.withdrawEpoch)!;
    b.base += u.amountBase; b.n++;
  }
  const rows = [...by.entries()].sort((a, b) => a[0] - b[0]).map(([e, b]) => ({ epoch: e, nam: Number(b.base) / 1e6, n: b.n, base: b.base }));
  let w = 0n, f = 0n;
  for (const r of rows) if (r.epoch <= epoch) w += r.base; else f += r.base;
  const clean = rows.map(({ base, ...r }) => r);
  return { rows: clean, hash: fnv1a(JSON.stringify(clean)), withdrawableNam: Number(w) / 1e6, unbondingNam: Number(f) / 1e6 };
}

export interface StakeStructure {
  validators: number; stakers: number;
  /** null when the chain's total stake was not read this tick (the shares need it as their denominator) */
  top10Pct: number | null; thirdCount: number | null; share1mPlus: number | null;
  stakers1mPlus: number;
  byValidator: Map<string, { stake: number; delegators: number }>;
}

/**
 * The staking structure from one bond listing (screener-plan 3.4). Shares are against the chain's total stake (one
 * denominator for every figure, as the plan asks): top 10 validators' share, how many validators together reach a
 * third (descriptive), the share staked by addresses with 1,000,000 NAM or more.
 */
export function stakeStructure(listing: Pick<BondListing, 'sources'>, stakeNam: number | null): StakeStructure {
  const byValidator = new Map<string, { stake: number; delegators: number }>();
  let stakers = 0, stakers1m = 0, big = 0;
  for (const s of listing.sources.values()) {
    if (s.bondedBase > 0n) stakers++;
    const bonded = Number(s.bondedBase) / 1e6;
    if (bonded >= 1_000_000) { stakers1m++; big += bonded; }
    for (const d of s.delegations) {
      const v = byValidator.get(d.validator) ?? byValidator.set(d.validator, { stake: 0, delegators: 0 }).get(d.validator)!;
      v.stake += d.amountNam; v.delegators++;
    }
  }
  const stakes = [...byValidator.values()].map((v) => v.stake).filter((x) => x > 0).sort((a, b) => b - a);
  const ok = stakeNam != null && stakeNam > 0;
  let third: number | null = null;
  if (ok) { let c = 0; for (let i = 0; i < stakes.length; i++) { c += stakes[i]; if (c >= stakeNam! / 3) { third = i + 1; break; } } }
  return {
    validators: stakes.length, stakers, stakers1mPlus: stakers1m, byValidator,
    top10Pct: ok ? (stakes.slice(0, 10).reduce((a, x) => a + x, 0) / stakeNam!) * 100 : null,
    thirdCount: third, share1mPlus: ok ? (big / stakeNam!) * 100 : null,
  };
}

export function stakeListingStmts(at: number, st: StakeStructure, q: UnbondQueue): Stmt[] {
  const out = [
    stmt.metric(at, 'stake.validators', st.validators), stmt.metric(at, 'stake.stakers', st.stakers), stmt.metric(at, 'stake.stakers_1m_plus', st.stakers1mPlus),
    stmt.metric(at, 'stake.unbonding_nam', q.unbondingNam), stmt.metric(at, 'stake.withdrawable_nam', q.withdrawableNam),
  ];
  if (st.top10Pct != null) out.push(stmt.metric(at, 'stake.top10_pct', st.top10Pct));
  if (st.thirdCount != null) out.push(stmt.metric(at, 'stake.third_count', st.thirdCount));
  if (st.share1mPlus != null) out.push(stmt.metric(at, 'stake.share_1m_plus', st.share1mPlus));
  return out;
}

export function unbondQueueStmts(q: UnbondQueue, at: number, height: number): Stmt[] {
  return [{ sql: UNBOND_QUEUE_DELETE_SQL, params: [] }, ...q.rows.map((r) => ({ sql: UNBOND_QUEUE_ROW_SQL, params: [r.epoch, r.nam, r.n, at, height] }))];
}

export function validatorDailyStmts(day: string, st: StakeStructure, names: ValidatorNames | null, at: number, height: number): Stmt[] {
  const by = new Map((names?.validators ?? []).map((v) => [v.address, v]));
  return [...st.byValidator.entries()].filter(([, v]) => v.stake > 0).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([validator, v]) => {
    const n = by.get(validator);
    return { sql: VALIDATOR_ROW_SQL, params: [day, validator, v.stake, v.delegators, n?.commission ?? null, n?.state ?? null, n?.name ?? null, at, height, n ? names!.at : null] };
  });
}

/**
 * cron.ts runBondListing, when a pass completes: the stake keys every listing, the unbond queue when it changed
 * (kv unbond.queue.hash), validator_daily on the first complete listing of the UTC day (kv jobs.validator_daily),
 * the listings row. One kv read, one batch.
 */
export async function bondListingSeries(db: D1Database, at: number, listing: Pick<BondListing, 'sources'> & { height: number; provider: string }, epoch: number, stakeNam: number | null): Promise<{ queueChanged: boolean; validatorsWritten: number; structure: StakeStructure; queue: UnbondQueue }> {
  const kv = await kvJson<any>(db, ['unbond.queue.hash', 'jobs.validator_daily', 'validators.names']);
  const q = unbondQueue(listing, epoch);
  const st = stakeStructure(listing, stakeNam);
  const stmts: Stmt[] = [...stakeListingStmts(at, st, q), { sql: LISTING_ROW_SQL, params: [at, 'bond', listing.height, listing.provider] }];
  const queueChanged = kv['unbond.queue.hash']?.hash !== q.hash;
  if (queueChanged) stmts.push(...unbondQueueStmts(q, at, listing.height), kvStmt('unbond.queue.hash', { hash: q.hash, at, height: listing.height, epoch }, at));
  const day = isoDay(at);
  let validatorsWritten = 0;
  if (kv['jobs.validator_daily'] !== day) {
    const v = validatorDailyStmts(day, st, kv['validators.names'] ?? null, at, listing.height);
    validatorsWritten = v.length;
    stmts.push(...v, kvStmt('jobs.validator_daily', day, at));
  }
  await runBatch(db, stmts);
  return { queueChanged, validatorsWritten, structure: st, queue: q };
}

