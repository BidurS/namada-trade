// The reads behind /api/series (worker/src/api-series.ts mounts them): the Trade basics of
// docs/design/screener-plan.md 2.1 to 2.7 and 2.11, the read contract 2.12 and the honest start dates 3.9. Types
// are in shared/types.ts (SeriesResponse, PriceChangesResponse, VolumeResponse, PairsResponse, TradesResponse).
//
// The rules every read here keeps:
// - Each is a primary-key or index range (metrics (key, ts), flows_kind (kind, ts DESC), flows_to / flows_from
//   (addr, ts DESC), pool_hourly (pool_id, hour), labels by address). EXPLAIN QUERY PLAN of every statement is
//   checked in test/series-api.test.ts: SEARCH on an index, never a SCAN of flows, holders or balance_spans, never a
//   temporary B-tree. Sorting is never left to SQLite across index ranges: the trades tape reads buys and sells as two
//   index walks and merges them here, and ties on the same millisecond are read as their own small group.
// - Nothing is made up. A step without a reading has no point; a window the record does not cover is null with the
//   reason; a trade without a recorded price has none (no pool spot price stands in); an unknown is never 0.
// - Every answer names its source and the age of what it states, and every series its honest start (the first
//   reading it ever recorded, whatever range was asked).
// Rows read per call are noted beside each statement (production, 2026-10-20 22:15 UTC, `meta.rows_read`).
import type { Env } from './util';
import type {
  Provenance, Sourced, SeriesStep, SeriesUnit, SeriesAgg, SeriesSample, SeriesSource, SeriesGap, SeriesResponse,
  PriceChange, PriceChangeWindow, PoolChangeWindow, PriceChangesResponse, PriceReading, VolumeWindow, ExecutedVolume, VolumeResponse,
  PairRow, PairsResponse, TradeRow, TradeGroup, TradesResponse, TradePattern, ValueInput, ValueFigure, ValuesResponse,
} from '../../shared/types';
import {
  SERIES_STEP_MS, SERIES_MAX_POINTS, PRICE_CHANGE_WINDOW_MS, POOL_CHANGE_WINDOW_MS, PRICE_BASE_MAX_LAG_SHARE,
  VOLUME_WINDOW_MS, VOLUME_DISAGREE_PCT, TRADE_FOLD_MS, TRADE_FOLD_UNDER_NAM,
} from '../../shared/types';
import { encodeFlowCursor, type BeforeParam } from '../../shared/paging';
import { fmtDay } from '../../shared/search-grammar';
import { explorerHashOf, priceAtOf } from '../../shared/flow-rules';
import { label_plain, labelAuthorShort } from './labels';
import { VALUE_WORDS } from '../../shared/copy';
import { provAt, coverageOf, safeParseJson, settlePrices } from './analytics';
import { kvGetJson } from './db';
import { PRICE_HOW_KEY, priceHowAt, storedPriceNote, storedPriceSource, type PriceHowLog } from './price-how';
import { tradeValue } from '../../shared/settle';
import { OSMOSIS, INTERNAL_LABELS } from './config';
import { OSMOSIS_DATA_SOURCE } from './sources/osmosis-data';
import { JOB_WINDOW_MS, OSMOSIS_SUMMARY_STALE_MS } from './series';
import { poolHoldsSomething } from '../../shared/pool-sides';
import { POOLS_SOURCE, PRICED_FROM_SQL, routerCapNote, storedPoolsProv, type StoredPools } from './pool-sizes';
import { osmosisGapCounts, osmosisGapWindows, reachesOsmosisGap, withOsmosisGap } from '../../shared/osmosis-gap';
import { ApiInputError } from './api-route';

const H = 3_600_000, D = 86_400_000, MIN = 60_000;
type DB = Env['DB'];

/** A request the route refuses, with the status and the plain words it answers with. */
/** A series route's own refusal (worker/src/api-route.ts ApiInputError: the shared route wrapper answers it). */
export class SeriesInputError extends ApiInputError {}

const fmtClock = (ms: number) => new Date(ms).toISOString().slice(11, 16);
const fmtDayTime = (ms: number) => `${fmtDay(ms)} ${fmtClock(ms)} UTC`;
const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const STATUS_RANK: Record<Provenance['status'], number> = { live: 0, stale: 1, conflict: 2, missing: 3 };
/** A read started inside a promise, so one that fails as it is prepared rejects with the others instead of leaving them unhandled. */
const later = <T,>(f: () => Promise<T>): Promise<T> => Promise.resolve().then(f);

/** The source word of the Osmosis router's pools answer (plain word "Osmosis pools", web/src/lib/prov.ts). */
const ROUTER_SOURCE = 'Osmosis SQS pools';

/** Not a bot round trip (the Osmosis parser files those as kind 'other' with meta.arb; kept here for any older row). */
export const NOT_ARB = `(f.meta IS NULL OR f.meta NOT LIKE '%"arb":true%')`;

// ================================================================ GET /api/series

/** One stored series the route serves (a metric key), what its values are and where they come from. */
export interface SeriesKeyDef {
  unit: SeriesUnit;
  agg: SeriesAgg;
  /** written only when something happened (a trade): a step without a point had none, which is not a gap */
  sparse: boolean;
  /** the key's own cadence; a finer step is raised to it */
  native: SeriesStep;
  /** a minute key with hourly rollups `<key>.1h`, `.1h.lo`, `.1h.hi` (series.ts rollupStmts): steps of an hour or more read those */
  rollup?: boolean;
  /** keys written beside it at the same times: each step's lowest and highest reading, how many readings, a flat hour */
  lo?: string;
  hi?: string;
  n?: string;
  flat?: string;
  /** the source word (shown in plain words through web/src/lib/prov.ts) */
  source: string;
  /** what the start means, given the start's date (from data) */
  startNote: (start: string) => string;
  /** the history before its writer shipped was filled in once from stored rows */
  backfilled: boolean;
  /** a clock series whose newest reading is older than this is old */
  maxAgeMs: number;
  /** a step is due (missing it is a gap) this long after it ends: the writer's own delay */
  graceMs: number;
  /** why a clock series has no reading for a stretch, in plain words */
  gapWhy: string;
  /** counted from the stored Osmosis record: a window reaching back before it is complete says so (shared/osmosis-gap.ts) */
  osmosisRecord?: boolean;
  /** a pool size stored since before the pools were sized from their reserves: a window reaching back before then says so (pool-sizes.ts PRICED_KEY) */
  sizeBasis?: boolean;
}

const MINUTE_GAP = 'No reading was recorded: the minute reader was not running or its source did not answer.';
const minuteKey = (unit: SeriesUnit, source: string, what: string): SeriesKeyDef => ({
  unit, agg: 'last', sparse: false, native: '1m', rollup: true, source, backfilled: false, maxAgeMs: 5 * MIN, graceMs: 3 * MIN, gapWhy: MINUTE_GAP,
  startNote: (s) => `${what} recorded every minute since ${s}; nothing earlier exists. Steps of an hour or more are the last reading of each hour, with its lowest and highest.`,
});
const SWAP_SOURCE = 'executed Osmosis swaps (flow index)';
const swapKey = (unit: SeriesUnit, what: string): SeriesKeyDef => ({
  unit, agg: 'sum', sparse: true, native: '1h', source: SWAP_SOURCE, backfilled: true, maxAgeMs: 2 * H + JOB_WINDOW_MS, graceMs: JOB_WINDOW_MS, gapWhy: '', osmosisRecord: true,
  startNote: (s) => `${what} in each hour with a trade since ${s}, bot round trips left out. An hour without a point had no trade. The hours before the writer shipped were computed once from the same stored trades.`,
});
const hourlyClock = (unit: SeriesUnit, source: string, startNote: (s: string) => string, gapWhy: string, backfilled = false): SeriesKeyDef => ({
  // an hour's reading is written in the first minutes of the next hour (series.ts JOB_WINDOW_MS): due after that
  unit, agg: 'last', sparse: false, native: '1h', source, backfilled, maxAgeMs: 3 * H, graceMs: JOB_WINDOW_MS, gapWhy, startNote,
});
const DAILY_FLOWS = 'D1 flow index (daily)';
const dailyFlowKey = (unit: SeriesUnit, what: string): SeriesKeyDef => ({
  unit, agg: 'sum', sparse: false, native: '1d', source: DAILY_FLOWS, backfilled: true, maxAgeMs: 2 * D, graceMs: 2 * H, gapWhy: 'The daily writer did not record this day.', osmosisRecord: true,
  startNote: (s) => `${what} for each UTC day since ${s}, from the flow index, bot round trips left out (the days before the writer shipped were computed once from the same stored moves).`,
});

/**
 * Every key /api/series serves. Keys left out on purpose: dollar volume per hour or day (written only when every
 * trade of the hour had a value, so a missing point would read as "no trade"), and minute keys without hourly
 * rollups (a long range would read every minute row).
 */
export const SERIES_KEYS: Record<string, SeriesKeyDef> = {
  'price.usd': minuteKey('usd_per_nam', 'Osmosis SQS (stored)', 'The quoted price (the Osmosis router, NAM against USDC)'),
  'dex.liquidity_usd': { ...minuteKey('usd', `${POOLS_SOURCE} (stored)`, 'Money in the Osmosis NAM pools (each pool\'s coins at their own prices, the pools that can be priced)'), sizeBasis: true },
  'supply.total_stake': minuteKey('nam', 'Namada RPC abci_query', 'NAM staked with validators (the chain\'s total stake)'),
  'supply.masp_shielded': minuteKey('nam', 'Namada RPC (MASP balance)', 'NAM in the shielded pool'),
  'price.swap_1h': {
    unit: 'usd_per_nam', agg: 'last', sparse: true, native: '1h', lo: 'price.swap_1h.low', hi: 'price.swap_1h.high', n: 'price.swap_1h.n',
    source: 'executed NAM/USDC swaps (hourly median)', backfilled: true, maxAgeMs: 2 * H + JOB_WINDOW_MS, graceMs: JOB_WINDOW_MS, gapWhy: '',
    startNote: (s) => `The median price of the hour's executed single-pool NAM/USDC trades of 50 NAM or more, for each hour with such a trade, since ${s}. An hour without a point had no such trade. The hours before the writer shipped were computed once from the same stored trades.`,
  },
  'price.pool_1h': {
    ...hourlyClock('usd_per_nam', OSMOSIS_DATA_SOURCE,
      (s) => `Pool ${OSMOSIS.refPoolId}'s own price (NAM against USDC) at the close of each hour since ${s}, from the Osmosis app's data: imported once, then read every hour. It is the pool's price, not trades; an hour in which no trade moved the pool is flat.`,
      'The Osmosis app\'s data did not answer for these hours.', true),
    lo: 'price.pool_1h.low', hi: 'price.pool_1h.high', flat: 'price.pool_1h.flat',
  },
  'dex.swaps_1h.nam': swapKey('nam', 'NAM bought plus NAM sold'),
  'dex.swaps_1h.buy_nam': swapKey('nam', 'NAM bought'),
  'dex.swaps_1h.sell_nam': swapKey('nam', 'NAM sold'),
  'dex.swaps_1h.n': swapKey('count', 'Trades'),
  'dex.swaps_1h.buyers': swapKey('count', 'Addresses that bought (each counted once in each hour; a longer step adds the hours up)'),
  'dex.swaps_1h.sellers': swapKey('count', 'Addresses that sold (each counted once in each hour; a longer step adds the hours up)'),
  'dex.volume_24h_usd_osmosis': hourlyClock('usd', OSMOSIS_DATA_SOURCE,
    (s) => `Dollars traded in the last 24 hours across the NAM pools, as the Osmosis app's pair summary counts them (the side it can price), read every hour since ${s}.`,
    'The Osmosis app\'s pair summary was not read for these hours.'),
  'dex.volume_7d_usd_osmosis': hourlyClock('usd', OSMOSIS_DATA_SOURCE,
    (s) => `Dollars traded in the last 7 days across the NAM pools, as the Osmosis app's pair summary counts them (the side it can price), read every hour since ${s}.`,
    'The Osmosis app\'s pair summary was not read for these hours.'),
  'dex.volume_usd_daily.osmosis': {
    ...hourlyClock('usd', OSMOSIS_DATA_SOURCE,
      (s) => `Dollars traded in NAM each day from the Osmosis app's daily token figures since ${s}, imported once. The Osmosis app stopped publishing them, so they end where the series ends.`,
      'The Osmosis app\'s daily token figures have nothing for these days.', true),
    agg: 'sum', native: '1d', maxAgeMs: 2 * D, graceMs: 2 * H,
  },
  'dex.ref_pool_liquidity_usd.daily.osmosis': {
    ...hourlyClock('usd', OSMOSIS_DATA_SOURCE,
      (s) => `Money in pool ${OSMOSIS.refPoolId} once a day since ${s}, from the Osmosis app's data (imported once; the USDC side only, since Osmosis stopped pricing NAM).`,
      'The Osmosis app\'s data has no reading for these days.', true),
    native: '1d', maxAgeMs: 2 * D, graceMs: 2 * H,
  },
  'dex.volume_nam_daily': dailyFlowKey('nam', 'NAM bought plus NAM sold on Osmosis'),
  'dex.traders_daily': dailyFlowKey('count', 'Addresses that traded on Osmosis'),
  'dex.hours_with_trades_daily': dailyFlowKey('count', 'Hours with at least one trade'),
  'holders.namada': hourlyClock('count', 'NamadaTrade holder index',
    (s) => `Addresses holding spendable or staked NAM on Namada (protocol accounts left out), counted at each complete chain balance listing since ${s}. No count of every address exists before then.`,
    'No complete balance listing finished in these hours.'),
  'holders.osmosis': hourlyClock('count', 'NamadaTrade holder index',
    (s) => `Addresses holding NAM on Osmosis (protocol and pool accounts left out), counted every hour since ${s}.`,
    'The Osmosis holder list was not read in these hours, or no read of it added up to the supply.'),
};

const STEPS: SeriesStep[] = ['1m', '1h', '6h', '1d'];
/** The earliest and latest time a parameter may name (2020 to 2100). */
const TIME_MIN = Date.UTC(2020, 0, 1), TIME_MAX = Date.UTC(2100, 0, 1);

/**
 * `from` / `to` as the URL carries them: unix ms, or YYYY-MM-DD (UTC; `to` means the end of that day). undefined when
 * absent; throws SeriesInputError for anything else.
 */
export function parseTimeParam(raw: string | undefined, name: string, endOfDay: boolean): number | undefined {
  if (raw == null || raw === '') return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const t = Date.parse(`${raw}T00:00:00Z`);
    if (Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === raw && t >= TIME_MIN && t < TIME_MAX) return endOfDay ? t + D : t;
  } else if (/^\d{11,14}$/.test(raw)) {
    const t = Number(raw);
    if (t >= TIME_MIN && t < TIME_MAX) return t;
  }
  throw new SeriesInputError(400, `${name} must be a time in unix milliseconds or a day as YYYY-MM-DD.`);
}

/** The step of an answer: the one asked (raised to the key's own cadence), else the finest that keeps it within SERIES_MAX_POINTS. */
export function chooseStep(def: SeriesKeyDef, from: number, to: number, asked?: string): SeriesStep {
  const nativeIdx = STEPS.indexOf(def.native);
  const points = (s: SeriesStep) => Math.ceil((to - from) / SERIES_STEP_MS[s]);
  if (asked != null && asked !== '') {
    const i = STEPS.indexOf(asked as SeriesStep);
    if (i < 0) throw new SeriesInputError(400, `step must be one of ${STEPS.join(', ')}.`);
    const step = STEPS[Math.max(i, nativeIdx)];
    if (points(step) > SERIES_MAX_POINTS) throw new SeriesInputError(400, `A ${step} step over this range is ${points(step).toLocaleString('en-US')} points; the most one answer holds is ${SERIES_MAX_POINTS.toLocaleString('en-US')}. Ask for a coarser step or a shorter range.`);
    return step;
  }
  for (let i = nativeIdx; i < STEPS.length; i++) if (points(STEPS[i]) <= SERIES_MAX_POINTS) return STEPS[i];
  throw new SeriesInputError(400, `This range is longer than ${SERIES_MAX_POINTS.toLocaleString('en-US')} days; ask for a shorter one.`);
}

/**
 * The readings of one or more keys over [from, to), oldest first per key: the metrics primary key, one range per key
 * (`SEARCH metrics USING INDEX sqlite_autoindex_metrics_1 (key=? AND ts>? AND ts<?)`, in index order, no sort). Rows
 * read = the readings returned. ?1..?n the keys, then from and to.
 */
export const rangeSql = (keys: number) =>
  `SELECT key, ts, value FROM metrics WHERE key IN (${Array.from({ length: keys }, () => '?').join(', ')}) AND ts >= ? AND ts < ? ORDER BY key, ts`;
/**
 * The first reading a key ever recorded (its honest start), the first row of the key the answer reads (its hourly
 * rollup, for a minute key at an hour or more), and the hourly writer's marker: 3 rows read.
 */
export const START_SQL = `SELECT (SELECT MIN(ts) FROM metrics WHERE key = ?1) AS start, (SELECT MIN(ts) FROM metrics WHERE key = ?2) AS start_read,
  (SELECT value FROM kv WHERE key = 'jobs.hourly') AS job`;

interface NativePoint { t: number; at: number; v: number; lo?: number; hi?: number; n?: number; flat?: boolean }
/** The key an answer's points come from: the hourly rollup of a minute key at a step of an hour or more. */
const valueKeyOf = (key: string, useRollup: boolean) => (useRollup ? `${key}.1h` : key);

/**
 * Group native points into steps. 'last': the step's newest value, `lo` / `hi` the lowest and highest reading in it
 * (each native point's own extremes where it has them). 'sum': the values added up. `n` adds up when every native
 * point has one. `flat` (pool price): at a coarser step, true only when every native step in it is present and
 * flat, false when any of them moved, absent otherwise. `at` is the newest reading's own time.
 */
export function thin(points: NativePoint[], stepMs: number, agg: SeriesAgg, nativeMs: number): (SeriesSample & { at: number })[] {
  interface Acc { t: number; at: number; v: number; lo: number; hi: number; n: number | null; count: number; flatKnown: number; flatTrue: number }
  const accs: Acc[] = [];
  let cur: Acc | null = null;
  for (const p of [...points].sort((a, b) => a.t - b.t || a.at - b.at)) {
    const b = Math.floor(p.t / stepMs) * stepMs;
    if (!cur || cur.t !== b) {
      cur = { t: b, at: p.at, v: p.v, lo: p.lo ?? p.v, hi: p.hi ?? p.v, n: p.n ?? null, count: 1, flatKnown: p.flat != null ? 1 : 0, flatTrue: p.flat ? 1 : 0 };
      accs.push(cur);
      continue;
    }
    cur.v = agg === 'sum' ? cur.v + p.v : p.v;
    cur.lo = Math.min(cur.lo, p.lo ?? p.v);
    cur.hi = Math.max(cur.hi, p.hi ?? p.v);
    cur.at = p.at;
    cur.n = cur.n != null && p.n != null ? cur.n + p.n : null;
    cur.count++;
    if (p.flat != null) { cur.flatKnown++; if (p.flat) cur.flatTrue++; }
  }
  const per = Math.max(1, Math.round(stepMs / nativeMs));
  return accs.map((a) => {
    const s: SeriesSample & { at: number } = { t: a.t, v: a.v, at: a.at };
    if (agg === 'last') { s.lo = a.lo; s.hi = a.hi; }
    if (a.n != null) s.n = a.n;
    if (a.flatKnown > 0) {
      if (a.flatTrue < a.flatKnown) s.flat = false;
      else if (a.flatKnown === per) s.flat = true;
    }
    return s;
  });
}

/** Runs of `stepMs` steps in [from, to) without a point, at least `minSteps` long, merged. */
export function findGaps(pointTimes: Set<number>, from: number, to: number, stepMs: number, minSteps: number, why: string): SeriesGap[] {
  const gaps: SeriesGap[] = [];
  let run: number | null = null;
  const first = Math.ceil(from / stepMs) * stepMs;
  for (let b = first; b + stepMs <= to; b += stepMs) {
    if (!pointTimes.has(b)) { if (run == null) run = b; continue; }
    if (run != null && (b - run) / stepMs >= minSteps) gaps.push({ from: run, to: b, why });
    run = null;
  }
  if (run != null) {
    const end = Math.floor(to / stepMs) * stepMs;
    if ((end - run) / stepMs >= minSteps) gaps.push({ from: run, to: end, why });
  }
  return gaps;
}

export interface SeriesQuery { key: string; from?: string; to?: string; step?: string }

/**
 * One stored series over [from, to) at a step (screener-plan 2.6, 2.12). Reads: the key's readings in range (and
 * for a minute key at a step of an hour or more its hourly rollups, plus the minute readings of the last two hours
 * when the range reaches them, for the hours not rolled up yet) and its start: one range read per key (rows read =
 * the readings in range: 296 for 30 days of the executed price, 515 for 30 days of the quoted price by the hour,
 * 46,770 for the pool price since 20 Jun 2025 on 2026-10-20), and 3 rows. Throws SeriesInputError (400, 404).
 */
export async function readSeries(db: DB, q: SeriesQuery, asOf: number, replay: boolean): Promise<SeriesResponse> {
  const pool = POOL_KEY_RE.exec(q.key);
  if (pool) return readPoolSeries(db, q.key, pool[1], pool[2] as PoolColumn, q, asOf, replay);
  const def = SERIES_KEYS[q.key];
  if (!def) throw new SeriesInputError(404, 'No such series.', `Unknown key "${String(q.key).slice(0, 60)}". Served keys: ${Object.keys(SERIES_KEYS).join(', ')}, and pool_hourly.<pool id>.<${Object.keys(POOL_SERIES_COLUMNS).join(' | ')}>.`);
  const toAsked = parseTimeParam(q.to, 'to', true);
  const fromAsked = parseTimeParam(q.from, 'from', false);
  const to = Math.min(toAsked ?? asOf, asOf);
  const from = fromAsked ?? to - 30 * D;
  if (!(from < to)) throw new SeriesInputError(400, '`from` must be before `to` (and before the rewound time, if any).');
  const step = chooseStep(def, from, to, q.step);
  const stepMs = SERIES_STEP_MS[step];
  const nativeMs = SERIES_STEP_MS[def.native];

  // Which keys this answer reads.
  const useRollup = !!def.rollup && step !== '1m';
  const keys = useRollup ? [`${q.key}.1h`, `${q.key}.1h.lo`, `${q.key}.1h.hi`] : [q.key, def.lo, def.hi, def.n, def.flat].filter((k): k is string => !!k);
  const pointMs = useRollup ? H : nativeMs;
  // The minute readings of the hours the rollup has not written yet (the current one, and the one before until the hourly job runs).
  const tailFrom = useRollup && to > asOf - 3 * H ? Math.max(from, Math.floor((to - 1) / H) * H - H) : null;
  const [rows, tail, meta, sizeFrom] = await Promise.all([
    later(() => db.prepare(rangeSql(keys.length)).bind(...keys, from, to).all<{ key: string; ts: number; value: number }>()),
    later(() => (tailFrom != null ? db.prepare(rangeSql(1)).bind(q.key, tailFrom, to).all<{ key: string; ts: number; value: number }>() : Promise.resolve({ results: [] as { key: string; ts: number; value: number }[] }))),
    later(() => db.prepare(START_SQL).bind(q.key, valueKeyOf(q.key, useRollup)).first<{ start: number | null; start_read: number | null; job: string | null }>()),
    def.sizeBasis ? sizedFrom(db) : Promise.resolve(undefined),
  ]);

  // Native points, one per native step: the step's readings of the value key (the last, or their sum, with their
  // extremes and count), then the companion keys written at the same times laid over them.
  type Row = { key: string; ts: number; value: number };
  const byStep = new Map<number, NativePoint>();
  const add = (into: Map<number, NativePoint>, r: Row, stepOf: number, counted: boolean) => {
    const t = Math.floor(Number(r.ts) / stepOf) * stepOf, v = Number(r.value), p = into.get(t);
    if (!p) { into.set(t, { t, at: Number(r.ts), v, lo: v, hi: v, ...(counted ? { n: 1 } : {}) }); return; }
    p.v = def.agg === 'sum' ? p.v + v : v;
    p.at = Number(r.ts); p.lo = Math.min(p.lo!, v); p.hi = Math.max(p.hi!, v);
    if (p.n != null) p.n += 1;
  };
  const valueKey = keys[0];
  // a rollup hour keeps no count of its minute readings
  for (const r of (rows.results || []) as Row[]) if (r.key === valueKey) add(byStep, r, pointMs, !useRollup && !def.n);
  const loKey = useRollup ? `${q.key}.1h.lo` : def.lo, hiKey = useRollup ? `${q.key}.1h.hi` : def.hi;
  const seen = new Set<string>();
  for (const r of (rows.results || []) as Row[]) {
    if (r.key === valueKey) continue;
    const p = byStep.get(Math.floor(Number(r.ts) / pointMs) * pointMs);
    if (!p) continue;
    const v = Number(r.value), first = !seen.has(`${r.key}|${p.t}`);
    seen.add(`${r.key}|${p.t}`);
    if (r.key === loKey) p.lo = first ? v : Math.min(p.lo!, v);
    else if (r.key === hiKey) p.hi = first ? v : Math.max(p.hi!, v);
    else if (r.key === def.n) p.n = first ? v : (p.n ?? 0) + v;
    else if (r.key === def.flat) p.flat = first ? v === 1 : p.flat! && v === 1;
  }
  if (useRollup) {
    // hours without a rollup row yet, from their minute readings
    const hours = new Map<number, NativePoint>();
    for (const r of (tail.results || []) as Row[]) if (!byStep.has(Math.floor(Number(r.ts) / H) * H)) add(hours, r, H, false);
    for (const [t, p] of hours) byStep.set(t, p);
  }
  const native = [...byStep.values()];

  // The start is the key's first reading; a rollup hour is labelled with its hour's start, so it counts as earlier
  // only when it lies before the hour of the first minute reading (minute rows deleted since).
  const s0 = finite(meta?.start), s1 = finite(meta?.start_read);
  const start = s0 == null ? s1 : s1 != null && s1 < Math.floor(s0 / pointMs) * pointMs ? s1 : s0;
  return seriesAnswer(def, q.key, native, start, meta?.job ?? null, { from, to, step, pointMs }, asOf, replay, sizeFrom);
}

/** The first minute the stored pool sizes were the pools' coins at their own prices (pool-sizes.ts PRICED_KEY), null before; a failed read says nothing (undefined). */
const sizedFrom = (db: DB): Promise<number | null | undefined> =>
  later(() => db.prepare(PRICED_FROM_SQL).first<{ t: number | null }>()).then((r) => finite(r?.t ?? null), () => undefined);

/**
 * The answer from the native points: thinned to the step, with its start, coverage, gaps and stamp. A series counted
 * from the stored Osmosis record whose window reaches back before it is complete says so, and so does a pool size
 * whose window reaches back before the pools were sized from their reserves (`sizeFrom`: that minute, null before it).
 */
function seriesAnswer(def: SeriesKeyDef, key: string, native: NativePoint[], start: number | null, jobRaw: string | null,
  r: { from: number; to: number; step: SeriesStep; pointMs: number }, asOf: number, replay: boolean, sizeFrom?: number | null): SeriesResponse {
  const { from, to, step, pointMs } = r;
  const stepMs = SERIES_STEP_MS[step];
  const thinned = thin(native, stepMs, def.agg, pointMs);
  // each point keeps its newest reading's own time when that is not the step's start (a minute reading in the current
  // hour, the last traded hour of a 6-hour or daily step): the chart's "last trade" and "quoted now" ages read it
  const points: SeriesSample[] = thinned.map(({ at, ...x }) => (Number.isFinite(at) && at !== x.t ? { ...x, at } : x));
  const covFrom = Math.max(from, start ?? to);
  const firstStep = Math.floor(covFrom / stepMs) * stepMs;
  const steps = start == null || covFrom >= to ? 0 : Math.floor((to - 1) / stepMs) - firstStep / stepMs + 1;
  const withPoint = points.filter((p) => p.t >= firstStep).length;
  const gaps = def.sparse || start == null
    ? []
    : findGaps(new Set(points.map((p) => p.t)), covFrom, Math.min(to, asOf - def.graceMs), stepMs, step === '1m' ? 5 : 1, def.gapWhy);

  const newest = thinned[thinned.length - 1];
  const source: SeriesSource = {
    source: def.source, from: points[0]?.t ?? null, to: newest?.t ?? null, start,
    startNote: start != null ? def.startNote(fmtDay(start)) : 'Nothing is recorded for this series yet.', backfilled: def.backfilled,
  };
  let prov: Provenance;
  if (!newest) {
    prov = {
      source: def.source, at: null, status: 'missing',
      note: start == null ? 'Nothing is recorded for this series yet.'
        : start >= to ? `Nothing in this range: the series starts on ${fmtDay(start)}.`
        : def.sparse ? 'No hour in this range had a trade.' : 'No reading was recorded in this range.',
    };
  } else if (replay) {
    prov = { source: def.source, at: newest.at, status: 'live' };
  } else if (def.sparse) {
    // Quiet hours make the newest point old by nature; what can go stale is the writer, so its marker decides.
    const job = finite(jobRaw != null ? safeParseJson(jobRaw, null) : null);
    const fresh = job != null && job >= Math.floor(asOf / H) * H - H;
    prov = fresh
      ? { source: def.source, at: newest.at, status: 'live', note: `Written only for hours with a trade; the newest one began ${fmtDayTime(newest.at)}.` }
      : { source: def.source, at: newest.at, status: 'stale', note: job != null ? `Trades are counted up to ${fmtDayTime(job)}; the hourly writer has not run since, so newer trades are not counted yet.` : 'The hourly writer has not run yet.' };
  } else {
    prov = provAt(def.source, newest.at, asOf, def.maxAgeMs);
  }
  if (newest && def.osmosisRecord) prov = withOsmosisGap(prov, covFrom);
  if (newest && sizeFrom !== undefined && (sizeFrom == null || covFrom < sizeFrom)) prov = { ...prov, note: [prov.note, routerCapNote(sizeFrom)].filter(Boolean).join(' ') };
  return {
    key, from, to, step, stepMs, agg: def.agg, unit: def.unit, points, sources: [source], start,
    sparse: def.sparse, coverage: { steps: Math.max(0, steps), withPoint }, gaps, prov, asOf,
  };
}

// ---------------------------------------------------------------- one pool's hours (pool_hourly)

/** The pool_hourly columns served as series: `pool_hourly.<pool id>.<column>`. */
export const POOL_SERIES_COLUMNS = {
  liquidity_usd: { unit: 'usd', router: true, what: 'Money in the pool: its coins at their own prices, from the reserves the Osmosis router lists' },
  nam_reserve: { unit: 'nam', router: true, what: 'NAM in the pool, as the Osmosis router lists it' },
  volume_24h_usd_osmosis: { unit: 'usd', router: false, what: 'Dollars traded in the pool in the last 24 hours, as the Osmosis app\'s pair summary counts them (the side it can price)' },
  volume_7d_usd_osmosis: { unit: 'usd', router: false, what: 'Dollars traded in the pool in the last 7 days, as the Osmosis app\'s pair summary counts them (the side it can price)' },
  liquidity_usd_osmosis: { unit: 'usd', router: false, what: 'Money in the pool as the Osmosis app\'s pair summary prices it (the side it can price)' },
} as const satisfies Record<string, { unit: SeriesUnit; router: boolean; what: string }>;
type PoolColumn = keyof typeof POOL_SERIES_COLUMNS;
const POOL_KEY_RE = new RegExp(`^pool_hourly\\.(\\d{1,6})\\.(${Object.keys(POOL_SERIES_COLUMNS).join('|')})$`);

/** One pool's stored hours in [?2, ?3), on the primary key (pool_id, hour): rows read = the hours in range (at most 24 a day). */
export const POOL_RANGE_SQL = `SELECT hour, at, osmosis_at, liquidity_usd, nam_reserve, volume_24h_usd_osmosis, volume_7d_usd_osmosis, liquidity_usd_osmosis
  FROM pool_hourly WHERE pool_id = ?1 AND hour >= ?2 AND hour < ?3 ORDER BY hour`;
/** The pool's first stored hour (its honest start): 1 row read. */
export const POOL_START_SQL = `SELECT MIN(hour) AS start FROM pool_hourly WHERE pool_id = ?1`;

export function poolKeyDef(col: PoolColumn): SeriesKeyDef {
  const c = POOL_SERIES_COLUMNS[col];
  return {
    unit: c.unit, agg: 'last', sparse: false, native: '1h', source: c.router ? `${ROUTER_SOURCE} (stored)` : OSMOSIS_DATA_SOURCE, backfilled: false,
    maxAgeMs: 2 * H + JOB_WINDOW_MS, graceMs: JOB_WINDOW_MS,
    gapWhy: c.router ? 'No reading of this pool was stored for these hours (the router did not answer or did not list the pool).' : 'No figure for this pool was stored for these hours (the Osmosis app\'s summary did not answer or does not list the pool).',
    startNote: (st) => `${c.what}, stored once an hour since ${st}; per-pool readings were not kept before.`,
  };
}

/** `pool_hourly.<pool>.<column>`: one pool's stored hours as a series (screener-plan 2.3, 2.4). */
async function readPoolSeries(db: DB, key: string, pool: string, col: PoolColumn, q: SeriesQuery, asOf: number, replay: boolean): Promise<SeriesResponse> {
  const def = poolKeyDef(col);
  const toAsked = parseTimeParam(q.to, 'to', true);
  const fromAsked = parseTimeParam(q.from, 'from', false);
  const to = Math.min(toAsked ?? asOf, asOf);
  const from = fromAsked ?? to - 30 * D;
  if (!(from < to)) throw new SeriesInputError(400, '`from` must be before `to` (and before the rewound time, if any).');
  const step = chooseStep(def, from, to, q.step);
  const [rows, st, sizeFrom] = await Promise.all([
    later(() => db.prepare(POOL_RANGE_SQL).bind(pool, from, to).all<Record<string, number | null>>()),
    later(() => db.prepare(POOL_START_SQL).bind(pool).first<{ start: number | null }>()),
    col === 'liquidity_usd' ? sizedFrom(db) : Promise.resolve(undefined),
  ]);
  const native: NativePoint[] = [];
  for (const r of rows.results || []) {
    const v = finite(r[col]);
    if (v == null) continue;
    const hour = Number(r.hour);
    native.push({ t: hour, at: finite(POOL_SERIES_COLUMNS[col].router ? r.at : r.osmosis_at) ?? hour, v, n: 1 });
  }
  return seriesAnswer(def, key, native, finite(st?.start), null, { from, to, step, pointMs: H }, asOf, replay, sizeFrom);
}

// ================================================================ GET /api/series/changes

const QUOTED_KEY = 'price.usd', POOL_KEY = 'price.pool_1h';
const QUOTED_SOURCE = 'Osmosis SQS (stored)';
const QUOTED_MAX_AGE = 5 * MIN;
/** A provenance with a note added after its own (a route price's words after an age note). */
const withNote = (p: Provenance, note: string | undefined): Provenance => (note ? { ...p, note: [p.note, note].filter(Boolean).join('. ') } : p);
const POOL_MAX_AGE = 3 * H;
const WINDOW_WORD: Record<PriceChangeWindow | PoolChangeWindow, string> = { h1: '1-hour', h6: '6-hour', h24: '24-hour', d7: '7-day', d30: '30-day', y1: '1-year' };
const lagText = (ms: number) => (ms < H ? `${Math.round(ms / MIN)} minutes` : ms < 2 * D ? `${(ms / H).toFixed(ms < 10 * H ? 1 : 0)} hours` : `${(ms / D).toFixed(1)} days`);

/**
 * The newest reading of each key (the quoted price at or before ?3; the pool price's hour keyed at or before ?4, the
 * hours whose close is at or before the time asked) and each key's first reading: 6 scalar subqueries on the metrics
 * primary key, 6 rows read.
 */
export const CHANGES_NOW_SQL = `SELECT
  (SELECT ts FROM metrics WHERE key = ?1 AND ts <= ?3 ORDER BY ts DESC LIMIT 1) AS q_ts,
  (SELECT value FROM metrics WHERE key = ?1 AND ts <= ?3 ORDER BY ts DESC LIMIT 1) AS q_v,
  (SELECT ts FROM metrics WHERE key = ?2 AND ts <= ?4 ORDER BY ts DESC LIMIT 1) AS p_ts,
  (SELECT value FROM metrics WHERE key = ?2 AND ts <= ?4 ORDER BY ts DESC LIMIT 1) AS p_v,
  (SELECT MIN(ts) FROM metrics WHERE key = ?1) AS q_start,
  (SELECT MIN(ts) FROM metrics WHERE key = ?2) AS p_start`;
/** The first reading of a key at or after a time (each change's base): one primary-key seek, 1 row read each, two subqueries (time and value). */
export const firstAtOrAfterSql = (n: number) =>
  `SELECT ${Array.from({ length: n }, (_, i) => `(SELECT ts FROM metrics WHERE key = ?${3 * i + 1} AND ts >= ?${3 * i + 2} AND ts <= ?${3 * i + 3} ORDER BY ts LIMIT 1) AS t${i}, (SELECT value FROM metrics WHERE key = ?${3 * i + 1} AND ts >= ?${3 * i + 2} AND ts <= ?${3 * i + 3} ORDER BY ts LIMIT 1) AS v${i}`).join(', ')}`;

/**
 * One change: from the first reading at or after now.at − window (the base) to the newest reading (now). Covered when
 * the base came at most PRICE_BASE_MAX_LAG_SHARE of the window after the window's start; else null, with the reason.
 */
export function priceChange(window: PriceChangeWindow | PoolChangeWindow, windowMs: number, now: PriceReading | null, base: PriceReading | null, start: number | null, prov: Provenance, what: string): PriceChange {
  const out: PriceChange = { window, windowMs, pct: null, now, base: null, baseLagMs: null, prov };
  if (!now) return { ...out, note: `No ${what} is recorded at that time.` };
  const windowStart = now.at - windowMs;
  if (start == null || start > windowStart + windowMs * PRICE_BASE_MAX_LAG_SHARE) {
    // known once the first reading is within the allowed lag of the window's start
    const s = start ?? now.at;
    return { ...out, note: `The ${what} has been recorded since ${fmtDay(s)}, so its ${WINDOW_WORD[window]} change is known from ${fmtDay(s + windowMs * (1 - PRICE_BASE_MAX_LAG_SHARE))}.` };
  }
  if (!base || base.at >= now.at) return { ...out, note: `No ${what} was recorded after ${fmtDayTime(windowStart)}, so this change is not known.` };
  const lag = base.at - windowStart;
  if (lag > windowMs * PRICE_BASE_MAX_LAG_SHARE) {
    return { ...out, base, baseLagMs: lag, note: `The first ${what} after ${fmtDayTime(windowStart)} was read ${lagText(lag)} later (a gap in the readings), so this change is not shown.` };
  }
  return { ...out, base, baseLagMs: lag, pct: base.value > 0 ? ((now.value - base.value) / base.value) * 100 : null, ...(base.value > 0 ? {} : { note: `The ${what} it is measured from is not above 0.` }) };
}

/**
 * The quoted price's 1 h to 30 d changes and the pool price's 7 d, 30 d and 1 y (screener-plan 2.1): 2 queries, 22 rows read.
 *
 * A pool-price reading is an hour's close: it is stored under the hour's start (the chart draws each hour at its
 * start) and known only when the hour ends, so its time here is the key + 1 h, for now, the base and the age, and only
 * hours closed by the time asked are read (under Rewind, never a close from after the rewound time).
 */
export async function readChanges(db: DB, asOf: number, replay: boolean): Promise<PriceChangesResponse> {
  // price.how (price-how.ts): how the newest quoted price was read, the price list or the route's spot
  const [r, howLog] = await Promise.all([
    db.prepare(CHANGES_NOW_SQL).bind(QUOTED_KEY, POOL_KEY, asOf, asOf - H).first<any>(),
    kvGetJson<PriceHowLog>(db, PRICE_HOW_KEY).catch(() => null),
  ]);
  const qNow: PriceReading | null = r?.q_ts != null ? { at: Number(r.q_ts), value: Number(r.q_v) } : null;
  const qHow = qNow ? priceHowAt(howLog, qNow.at) : null;
  const qSource = storedPriceSource(qHow), qNote = storedPriceNote(qHow);
  const pNow: PriceReading | null = r?.p_ts != null ? { at: Number(r.p_ts) + H, value: Number(r.p_v) } : null;
  const qWins = Object.keys(PRICE_CHANGE_WINDOW_MS) as PriceChangeWindow[];
  const pWins = Object.keys(POOL_CHANGE_WINDOW_MS) as PoolChangeWindow[];
  // the pool's base: the first close at or after now − window, i.e. the first hour keyed at or after now − window − 1 h
  const asks: [string, number, number][] = [
    ...(qNow ? qWins.map((w): [string, number, number] => [QUOTED_KEY, qNow.at - PRICE_CHANGE_WINDOW_MS[w], qNow.at]) : []),
    ...(pNow ? pWins.map((w): [string, number, number] => [POOL_KEY, pNow.at - POOL_CHANGE_WINDOW_MS[w] - H, pNow.at - H]) : []),
  ];
  const b = asks.length ? await db.prepare(firstAtOrAfterSql(asks.length)).bind(...asks.flat()).first<any>() : null;
  const off = qNow ? qWins.length : 0;
  const reading = (i: number): PriceReading | null => (b && b[`t${i}`] != null ? { at: Number(b[`t${i}`]) + (i >= off ? H : 0), value: Number(b[`v${i}`]) } : null);
  const qProv: Provenance = !qNow ? { source: QUOTED_SOURCE, at: null, status: 'missing', note: 'No quoted price is recorded at that time.' }
    : replay ? { source: qSource, at: qNow.at, status: 'live', ...(qNote ? { note: qNote } : {}) } : withNote(provAt(qSource, qNow.at, asOf, QUOTED_MAX_AGE), qNote);
  const pProv: Provenance = !pNow ? { source: OSMOSIS_DATA_SOURCE, at: null, status: 'missing', note: 'No pool price is recorded at that time.' }
    : replay ? { source: OSMOSIS_DATA_SOURCE, at: pNow.at, status: 'live' } : provAt(OSMOSIS_DATA_SOURCE, pNow.at, asOf, POOL_MAX_AGE);
  // the pool price's first close: its first hour's end
  const qStart = r?.q_start != null ? Number(r.q_start) : null, pStart = r?.p_start != null ? Number(r.p_start) + H : null;
  const quoted = {} as Record<PriceChangeWindow, PriceChange>;
  qWins.forEach((w, i) => { quoted[w] = priceChange(w, PRICE_CHANGE_WINDOW_MS[w], qNow, qNow ? reading(i) : null, qStart, qProv, 'quoted price'); });
  const pool = {} as Record<PoolChangeWindow, PriceChange>;
  pWins.forEach((w, i) => { pool[w] = priceChange(w, POOL_CHANGE_WINDOW_MS[w], pNow, pNow ? reading(off + i) : null, pStart, pProv, 'pool price'); });
  return { asOf, quoted, pool };
}

// ================================================================ GET /api/series/volume

/** What the executed figures count, printed with them (screener-plan 2.2). */
export const VOLUME_DEFINITION = 'NAM bought plus NAM sold on Osmosis in the window, bot round trips left out. Dollars are each trade\'s value when it was executed, not at today\'s price; a trade with no recorded price counts in NAM only.';
/** What the Osmosis app's figure counts, printed beside it. */
export const OSMOSIS_VOLUME_DEFINITION = 'Dollars traded in the NAM pools as the Osmosis app\'s pair summary counts them: only the side of each trade it can price, added up pool by pool, so a trade routed through two pools counts in both.';
/** Per side, at most this many trades are read for the windows (about 900 buys and 130 sells in 30 days on 2026-10-20). */
export const VOLUME_ROWS_MAX = 10_000;

/**
 * One side's trades in the longest window, newest first, bots left out: `SEARCH flows USING INDEX flows_kind (kind=?
 * AND ts>? AND ts<?)`, no sort. Rows read = the side's trades in 30 days (901 buys and 126 sells on 2026-10-20).
 */
export const VOLUME_ROWS_SQL = `SELECT f.ts, f.amount_num, f.value_usd, CASE WHEN f.kind = 'buy' THEN f.to_addr ELSE f.from_addr END AS maker
  FROM flows f INDEXED BY flows_kind WHERE f.kind = ? AND f.chain = 'osmosis' AND f.ts > ? AND f.ts <= ? AND ${NOT_ARB} ORDER BY f.ts DESC LIMIT ?`;
/**
 * The first trade recorded (the figures' honest start), the newest Osmosis summary volumes at or before ?1, and each
 * side's first trade: index seeks, 6 rows read.
 */
export const VOLUME_META_SQL = `SELECT
  (SELECT MIN(ts) FROM flows INDEXED BY flows_kind WHERE kind = 'buy') AS first_buy,
  (SELECT MIN(ts) FROM flows INDEXED BY flows_kind WHERE kind = 'sell') AS first_sell,
  (SELECT ts FROM metrics WHERE key = 'dex.volume_24h_usd_osmosis' AND ts <= ?1 ORDER BY ts DESC LIMIT 1) AS o24_ts,
  (SELECT value FROM metrics WHERE key = 'dex.volume_24h_usd_osmosis' AND ts <= ?1 ORDER BY ts DESC LIMIT 1) AS o24,
  (SELECT ts FROM metrics WHERE key = 'dex.volume_7d_usd_osmosis' AND ts <= ?1 ORDER BY ts DESC LIMIT 1) AS o7_ts,
  (SELECT value FROM metrics WHERE key = 'dex.volume_7d_usd_osmosis' AND ts <= ?1 ORDER BY ts DESC LIMIT 1) AS o7`;

export interface VolumeTrade { ts: number; amount_num: number; value_usd: number | null; maker: string | null }

/** One window's figures from the trades of both sides (newest first or any order). */
export function executedVolume(window: VolumeWindow, asOf: number, buys: VolumeTrade[], sells: VolumeTrade[]): ExecutedVolume {
  const w = VOLUME_WINDOW_MS[window];
  const from = asOf - w;
  const inW = (r: VolumeTrade) => r.ts > from && r.ts <= asOf;
  const b = buys.filter(inW), s = sells.filter(inW);
  const sum = (xs: VolumeTrade[], f: (r: VolumeTrade) => number) => xs.reduce((a, r) => a + f(r), 0);
  const priced = (xs: VolumeTrade[]) => xs.filter((r) => r.value_usd != null && Number.isFinite(r.value_usd));
  const vwap = (xs: VolumeTrade[]) => { const p = priced(xs); const nam = sum(p, (r) => r.amount_num); return nam > 0 ? sum(p, (r) => r.value_usd!) / nam : null; };
  const all = [...b, ...s];
  const pricedAll = priced(all);
  const slots = new Set(all.map((r) => Math.floor((asOf - r.ts) / H)));
  return {
    window, from, to: asOf,
    nam: sum(all, (r) => r.amount_num), buyNam: sum(b, (r) => r.amount_num), sellNam: sum(s, (r) => r.amount_num),
    buys: b.length, sells: s.length,
    usd: pricedAll.length === all.length ? sum(all, (r) => r.value_usd ?? 0) : null,
    usdPriced: sum(pricedAll, (r) => r.value_usd!), unpriced: all.length - pricedAll.length,
    buyers: new Set(b.map((r) => r.maker).filter(Boolean)).size, sellers: new Set(s.map((r) => r.maker).filter(Boolean)).size,
    tradersHow: 'distinct',
    vwapUsd: vwap(all), buyVwapUsd: vwap(b), sellVwapUsd: vwap(s),
    hoursWithTrade: slots.size, hours: Math.round(w / H),
  };
}

/**
 * Executed volume for every window from one read of each side's trades in the longest window (screener-plan 2.2:
 * exact, each address once per window), the Osmosis app's 24 h and 7 d figures beside it. 3 queries plus the flow
 * index's coverage; about 1,040 rows read on 2026-10-20.
 */
export async function readVolume(db: DB, asOf: number, replay: boolean): Promise<VolumeResponse> {
  const longest = Math.max(...Object.values(VOLUME_WINDOW_MS));
  const [buysR, sellsR, meta, cov] = await Promise.all([
    later(() => db.prepare(VOLUME_ROWS_SQL).bind('buy', asOf - longest, asOf, VOLUME_ROWS_MAX).all<VolumeTrade>()),
    later(() => db.prepare(VOLUME_ROWS_SQL).bind('sell', asOf - longest, asOf, VOLUME_ROWS_MAX).all<VolumeTrade>()),
    later(() => db.prepare(VOLUME_META_SQL).bind(asOf).first<any>()),
    later(() => coverageOf(db, asOf, replay)),
  ]);
  const buys = buysR.results || [], sells = sellsR.results || [];
  const firsts = [meta?.first_buy, meta?.first_sell].map(finite).filter((x): x is number => x != null);
  const start = firsts.length ? Math.min(...firsts) : null;
  // A side read up to its cap covers only back to its oldest row read.
  const capFrom = Math.max(buys.length >= VOLUME_ROWS_MAX ? buys[buys.length - 1].ts : -Infinity, sells.length >= VOLUME_ROWS_MAX ? sells[sells.length - 1].ts : -Infinity);
  const windows = {} as Record<VolumeWindow, ExecutedVolume | null>;
  for (const w of Object.keys(VOLUME_WINDOW_MS) as VolumeWindow[]) {
    const from = asOf - VOLUME_WINDOW_MS[w];
    windows[w] = start == null || start > from || capFrom > from ? null : executedVolume(w, asOf, buys, sells);
  }
  let prov = cov.osmosis;
  const notes: string[] = [];
  if (start == null) notes.push('No trade is recorded yet.');
  else if (Object.values(windows).some((x) => x == null)) notes.push(`Trades are recorded since ${fmtDay(start)}, so a window reaching further back is not shown.`);
  if (capFrom > -Infinity) notes.push(`More than ${VOLUME_ROWS_MAX.toLocaleString('en-US')} trades on one side in the longest window: the windows reaching past ${fmtDayTime(capFrom)} are not computed per request.`);
  // a window shown that reaches back before the stored Osmosis record is complete says so (shared/osmosis-gap.ts); its figures are as stored
  const gapped = (Object.keys(VOLUME_WINDOW_MS) as VolumeWindow[]).filter((w) => windows[w] && reachesOsmosisGap(asOf - VOLUME_WINDOW_MS[w]));
  if (gapped.length) notes.push(osmosisGapWindows(gapped.map((w) => WINDOW_WORD[w])));
  if (notes.length) prov = { ...prov, note: [prov.note, ...notes].filter(Boolean).join(' ') };

  const o24 = finite(meta?.o24), o7 = finite(meta?.o7);
  const oAt = [meta?.o24_ts, meta?.o7_ts].map(finite).filter((x): x is number => x != null);
  const osmoAt = oAt.length ? Math.min(...oAt) : null;
  const osmosis: Sourced<{ usd24h: number | null; usd7d: number | null }> = osmoAt == null
    ? { value: null, prov: { source: OSMOSIS_DATA_SOURCE, at: null, status: 'missing', note: replay ? 'The Osmosis app\'s pair summary was not recorded at that time.' : 'The Osmosis app\'s pair summary has not been recorded yet.' } }
    : { value: { usd24h: o24, usd7d: o7 }, prov: replay ? { source: OSMOSIS_DATA_SOURCE, at: osmoAt, status: 'live' } : provAt(OSMOSIS_DATA_SOURCE, osmoAt, asOf, OSMOSIS_SUMMARY_STALE_MS + H) };
  const ours = windows.h24?.usd ?? null;
  const disagree = ours != null && o24 != null && Math.max(ours, o24) > 0 && (Math.abs(ours - o24) / Math.max(ours, o24)) * 100 > VOLUME_DISAGREE_PCT;
  return { asOf, definition: VOLUME_DEFINITION, windows, prov, start, osmosis, osmosisDefinition: OSMOSIS_VOLUME_DEFINITION, disagree };
}

// ================================================================ GET /api/series/pairs

/**
 * The newest stored hour of every pool recorded (pool_hourly, migration 0007): the pool ids come from the primary key
 * one seek at a time (the recursive step finds the next id, no scan of the hours), then each pool's row at the
 * reference pool's newest hour at or before ?2. ?1 the reference pool. 88 rows read for 28 pools on 2026-10-20,
 * whatever the number of hours kept.
 */
export const PAIRS_STORED_SQL = `WITH RECURSIVE ids(id) AS (
    SELECT MIN(pool_id) FROM pool_hourly
    UNION ALL SELECT (SELECT MIN(pool_id) FROM pool_hourly WHERE pool_id > ids.id) FROM ids WHERE ids.id IS NOT NULL)
  SELECT p.pool_id, p.hour, p.at, p.liquidity_usd, p.nam_reserve, p.counter_reserve, p.spread, p.volume_24h_usd_osmosis,
         p.volume_7d_usd_osmosis, p.liquidity_usd_osmosis, p.osmosis_at
  FROM ids JOIN pool_hourly p ON p.pool_id = ids.id AND p.hour = (SELECT MAX(hour) FROM pool_hourly WHERE pool_id = ?1 AND hour <= ?2)`;

export interface StoredPoolHour {
  pool_id: string; hour: number; at: number | null; liquidity_usd: number | null; nam_reserve: number | null; counter_reserve: number | null; spread: number | null;
  volume_24h_usd_osmosis: number | null; volume_7d_usd_osmosis: number | null; liquidity_usd_osmosis: number | null; osmosis_at: number | null;
}

const NO_LEGS: Provenance = { source: 'D1 flow index', at: null, status: 'missing', note: 'Trades per pool are not recorded yet: a routed trade names several pools and cannot be split between them.' };
const sumKnown = (xs: (number | null)[]) => (xs.some((x) => x != null) ? xs.reduce<number>((a, x) => a + (x ?? 0), 0) : null);
/** A raw denom ('ibc/…', 'UNKNOWN') is not a symbol a reader knows. */
const symbolOf = (s: string | null | undefined) => (!s || s === 'UNKNOWN' || s.startsWith('ibc/') || s.startsWith('factory/') ? null : s);

/**
 * The NAM pools (screener-plan 2.4): size, reserves and fee from the cron's stored pool list (pool-sizes.ts: each
 * pool's coins at their own price; old past its age; else the newest stored hour, marked old), with the Osmosis app's
 * 24 h and 7 d volume and its own update time from pool_hourly. Deepest first. 1 query (the stored hour) beside the
 * stored list, which the route reads (kv osmosis.pools): nothing here asks the router.
 */
export async function readPairs(db: DB, now: number, list: StoredPools | null): Promise<PairsResponse> {
  const stored = (await db.prepare(PAIRS_STORED_SQL).bind(OSMOSIS.refPoolId, now).all<StoredPoolHour>()).results || [];
  const byId = new Map(stored.map((r) => [String(r.pool_id), r]));
  const inList = list?.pools ?? [];
  const routed = inList.length > 0;
  const summaryRead = stored.some((r) => r.osmosis_at != null);
  const ids = new Set<string>([...inList.map((p) => p.id), ...stored.map((r) => String(r.pool_id))]);
  const livePool = new Map(inList.map((p) => [p.id, p]));
  const osmoMaxAge = OSMOSIS_SUMMARY_STALE_MS + H;
  const pairs: PairRow[] = [...ids].filter(Boolean).map((id) => {
    const p = livePool.get(id), s = byId.get(id);
    const router = routed ? (p ? { liquidityUsd: p.liquidityUsd, namReserve: p.namReserve, counterReserve: p.counterReserve, spreadFactor: p.spreadFactor, sizeProv: p.sizeProv } : null)
      : s && s.at != null ? { liquidityUsd: finite(s.liquidity_usd), namReserve: finite(s.nam_reserve), counterReserve: finite(s.counter_reserve), spreadFactor: finite(s.spread), sizeProv: undefined } : null;
    const sym = symbolOf(p?.counterSymbol);
    const osmosis: PairRow['osmosis'] = s?.osmosis_at != null
      ? { value: { volume24hUsd: finite(s.volume_24h_usd_osmosis), volume7dUsd: finite(s.volume_7d_usd_osmosis), liquidityUsd: finite(s.liquidity_usd_osmosis) }, prov: provAt(OSMOSIS_DATA_SOURCE, Number(s.osmosis_at), now, osmoMaxAge) }
      : { value: null, prov: { source: OSMOSIS_DATA_SOURCE, at: null, status: 'missing', note: !s ? 'Not recorded yet: the Osmosis app\'s pool figures are stored once an hour.' : summaryRead ? 'Osmosis does not list this pool\'s volume.' : 'The Osmosis app\'s pair summary was not read in the newest hour stored.' } };
    return {
      poolId: id, pair: sym ? `NAM/${sym}` : 'NAM/another coin', counterSymbol: sym, type: p?.type ?? null,
      liquidityUsd: router?.liquidityUsd ?? null, namReserve: router?.namReserve ?? null, counterReserve: router?.counterReserve ?? null, spreadFactor: router?.spreadFactor ?? null,
      ...(router?.sizeProv ? { sizeProv: router.sizeProv } : {}),
      osmosis, here24h: { value: null, prov: NO_LEGS }, createdAt: null,
    };
  });
  // a pool empty on both sides (in the live answer or the stored hour) holds nothing to trade and is not listed
  const listed = pairs.filter(poolHoldsSomething);
  // priced by size, then the pools that cannot be priced by the NAM inside, then by pool number
  listed.sort((a, b) => (b.liquidityUsd ?? -1) - (a.liquidityUsd ?? -1) || (b.namReserve ?? -1) - (a.namReserve ?? -1) || Number(a.poolId) - Number(b.poolId));
  const storedAt = stored.map((r) => finite(r.at)).filter((x): x is number => x != null);
  const prov: Provenance = routed ? storedPoolsProv(list, now)
    : storedAt.length ? { source: `${ROUTER_SOURCE} (stored)`, at: Math.max(...storedAt), status: 'stale', note: `The pool list has not been stored; depth and reserves as stored for the hour at ${fmtDayTime(Math.max(...storedAt))}.` }
    : { source: POOLS_SOURCE, at: null, status: 'missing', note: 'The pool list has not been stored and no pool reading is stored.' };
  const osAt = stored.map((r) => finite(r.osmosis_at)).filter((x): x is number => x != null);
  const osmosisProv: Provenance = osAt.length ? provAt(OSMOSIS_DATA_SOURCE, Math.max(...osAt), now, osmoMaxAge)
    : { source: OSMOSIS_DATA_SOURCE, at: null, status: 'missing', note: stored.length ? 'The Osmosis app\'s pair summary was not read in the newest hour stored.' : 'The Osmosis app\'s pool figures have not been stored yet.' };
  const known = listed.map((p) => p.osmosis.value);
  return {
    asOf: now, pairs: listed, prov, osmosisProv,
    osmosisTotals: { volume24hUsd: sumKnown(known.map((v) => v?.volume24hUsd ?? null)), volume7dUsd: sumKnown(known.map((v) => v?.volume7dUsd ?? null)), liquidityUsd: sumKnown(known.map((v) => v?.liquidityUsd ?? null)) },
  };
}

// ================================================================ GET /api/series/trades

/** "Repeated small buys" (screener-plan 2.5): a description of the maker's pattern, never a claim about intent. */
export const PATTERN_RULE = { minBuys: 20, underNam: TRADE_FOLD_UNDER_NAM, windowMs: D } as const;
/** Consecutive trades fold only when each is this small (a bigger trade always stands alone on the tape): shared/types.ts. */
export { TRADE_FOLD_UNDER_NAM };

const TRADE_COLS = `f.id, f.ts, f.height, f.tx_hash, f.kind, f.from_addr, f.to_addr, f.amount_num, f.counter_denom, f.counter_amount, f.pool_id, f.price_usd, f.value_usd, f.meta,
  l.label AS maker_label, l.source AS maker_label_source, l.author AS maker_label_author`;

/**
 * One side's trades, newest first, strictly before ?2 (or at exactly ?2 when `tie`), bots left out, with the maker's
 * label. Without a maker: `SEARCH f USING INDEX flows_kind (kind=? AND ts<?)`; with one: the maker's own index
 * (flows_to for buys, flows_from for sells; the signer is the receiving address of a buy and the sending address of
 * a sell, 0 exceptions in 1,267 trades on 2026-10-20). In index order, so no sort; rows read = limit + 1 (+ the label
 * lookups).
 */
export function tradesSql(kind: 'buy' | 'sell', o: { maker: boolean; min: boolean; tie: boolean }): string {
  const makerCol = kind === 'buy' ? 'to_addr' : 'from_addr';
  const index = o.maker ? (kind === 'buy' ? 'flows_to' : 'flows_from') : 'flows_kind';
  return `SELECT ${TRADE_COLS} FROM flows f INDEXED BY ${index} LEFT JOIN labels l ON l.address = f.${makerCol}
  WHERE ${o.maker ? `f.${makerCol} = ? AND ` : ''}f.kind = '${kind}' AND f.chain = 'osmosis' AND f.ts ${o.tie ? '=' : '<'} ?${o.min ? ' AND f.amount_num >= ?' : ''} AND ${NOT_ARB}
  ORDER BY f.ts DESC${o.tie ? '' : ' LIMIT ?'}`;
}
/** Each maker's recorded buys (sells) at or before ?n, bots left out: the maker's index, grouped in index order. Rows read = the makers' rows on that index. */
export const makerCountSql = (kind: 'buy' | 'sell', n: number) => {
  const col = kind === 'buy' ? 'to_addr' : 'from_addr';
  return `SELECT f.${col} AS maker, COUNT(*) AS n FROM flows f INDEXED BY ${kind === 'buy' ? 'flows_to' : 'flows_from'}
  WHERE f.${col} IN (${Array.from({ length: n }, () => '?').join(', ')}) AND f.kind = '${kind}' AND f.ts <= ? AND ${NOT_ARB} GROUP BY f.${col}`;
};
/** The makers' small buys from 24 h before the page's oldest trade to its newest (the pattern rule): the flows_to range of each maker. */
export const smallBuysSql = (n: number) => `SELECT f.to_addr AS maker, f.ts FROM flows f INDEXED BY flows_to
  WHERE f.to_addr IN (${Array.from({ length: n }, () => '?').join(', ')}) AND f.kind = 'buy' AND f.amount_num < ? AND f.ts >= ? AND f.ts <= ? AND ${NOT_ARB}`;
/** The first buy and the first sell recorded (the tape's honest start): 2 rows read. */
export const TRADES_START_SQL = `SELECT (SELECT MIN(ts) FROM flows INDEXED BY flows_kind WHERE kind = 'buy') AS b, (SELECT MIN(ts) FROM flows INDEXED BY flows_kind WHERE kind = 'sell') AS s`;
/** D1 binds at most 100 parameters to a statement. */
const MAKER_CHUNK = 90;

interface TradeDbRow {
  id: string; ts: number; height: number; tx_hash: string; kind: 'buy' | 'sell'; from_addr: string | null; to_addr: string | null; amount_num: number;
  counter_denom: string | null; counter_amount: number | null; pool_id: string | null; price_usd: number | null; value_usd: number | null; meta: string | null;
  maker_label: string | null; maker_label_source: string | null; maker_label_author: string | null;
}

/** Feed order: newest first, then by block height, then by id (flows-query.ts FLOWS_ORDER). */
const feedOrder = (a: { ts: number; height: number; id: string }, b: { ts: number; height: number; id: string }) =>
  b.ts - a.ts || b.height - a.height || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/** How a trade's price was set: meta.priceSource, else a USDC trade's own price, else priced but not said how. */
export function priceSourceOf(r: Pick<TradeDbRow, 'price_usd' | 'counter_denom' | 'counter_amount' | 'amount_num'>, meta: Record<string, unknown>): TradeRow['priceSource'] {
  if (r.price_usd == null) return null;
  const s = meta.priceSource;
  if (s === 'execution' || s === 'swap_1h' || s === 'spot' || s === 'pool_1h' || s === 'unknown') return s;
  if (r.counter_denom === 'USDC' && r.counter_amount && r.amount_num > 0) {
    const own = r.counter_amount / r.amount_num;
    if (Math.abs(own - r.price_usd) <= own * 1e-6) return 'execution';
  }
  return 'unknown';
}

export function tradeRowOf(r: TradeDbRow): TradeRow {
  const meta = (safeParseJson(r.meta, {}) ?? {}) as Record<string, unknown>;
  const maker = r.kind === 'buy' ? r.to_addr : r.from_addr;
  const src = r.maker_label ? r.maker_label_source ?? null : maker && INTERNAL_LABELS[maker] ? 'auto' : null;
  const row: TradeRow = {
    id: r.id, ts: Number(r.ts), height: Number(r.height), tsSource: typeof meta.tsSource === 'string' ? meta.tsSource : null,
    kind: r.kind, nam: Number(r.amount_num), counterSymbol: r.counter_denom ?? null, counterAmount: finite(r.counter_amount),
    priceUsd: finite(r.price_usd), priceSource: priceSourceOf(r, meta), valueUsd: finite(r.value_usd),
    maker, makerLabelPlain: label_plain(r.maker_label, maker, r.maker_label_source), makerLabelSource: src, makerLabelAuthor: r.maker_label ? labelAuthorShort(r.maker_label_source, r.maker_label_author) : null,
    makerTrades: null, route: r.pool_id ? r.pool_id.split(',').filter(Boolean) : [], txHash: r.tx_hash,
    explorerHash: explorerHashOf({ txHash: r.tx_hash, meta }), pattern: null,
  };
  if (row.priceUsd == null) row.priceNote = 'No price was recorded for this trade.';
  // a price from the pool's hourly close says which hour (the stored price.pool_1h row it was read from)
  const at = row.priceSource === 'pool_1h' ? priceAtOf({ meta }) : null;
  if (at != null) row.priceAt = at;
  return row;
}

/**
 * Consecutive tape rows by one maker on one side in the same pool, each under TRADE_FOLD_UNDER_NAM NAM and within
 * TRADE_FOLD_MS of the next, as one group (a single trade is a group of one). Rows newest first. "The same pool": the
 * router picks each trade's route itself (one maker's 18 buys within 16 minutes on 2026-10-20 took six different
 * routes, every one through pool 3005: test/fixtures/series-trades.json), so a row joins the group when it went
 * through a pool every row of the group went through.
 */
export function foldTrades(rows: TradeRow[]): TradeGroup[] {
  type Open = TradeGroup & { _pools: Set<string>; _pricedNam: number; _last: TradeRow };
  const groups: Open[] = [];
  let g: Open | null = null;
  const small = (r: TradeRow) => r.nam < TRADE_FOLD_UNDER_NAM;
  for (const r of rows) {
    const common = g ? new Set(r.route.filter((p) => g!._pools.has(p))) : new Set<string>();
    if (g && r.maker != null && g.maker === r.maker && g.kind === r.kind && common.size > 0 && small(r) && small(g._last) && g._last.ts - r.ts <= TRADE_FOLD_MS) {
      g.ids.push(r.id); g.n++; g.nam += r.nam; g.firstTs = r.ts; g._pools = common;
      const v = tradeValue(r);
      if (v) { g.usd = (g.usd ?? 0) + v.usd; g._pricedNam += v.nam; } else g.unpriced++;
      if (!g.pattern && r.pattern) g.pattern = r.pattern;
      g._last = r;
      continue;
    }
    const v = tradeValue(r);
    g = { maker: r.maker, kind: r.kind, ids: [r.id], n: 1, nam: r.nam, usd: v?.usd ?? null, unpriced: v ? 0 : 1, avgPriceUsd: null, firstTs: r.ts, lastTs: r.ts, pattern: r.pattern, _pools: new Set(r.route), _pricedNam: v?.nam ?? 0, _last: r };
    groups.push(g);
  }
  return groups.map(({ _pools, _pricedNam, _last, ...x }): TradeGroup => ({ ...x, avgPriceUsd: x.usd != null && _pricedNam > 0 ? x.usd / _pricedNam : null }));
}

/** For each row, whether its maker made PATTERN_RULE.minBuys small buys in the window up to and including the row's time. */
export function patternsOf(rows: TradeRow[], smallBuys: Map<string, number[]>): (TradePattern | null)[] {
  return rows.map((r) => {
    const ts = r.maker ? smallBuys.get(r.maker) : undefined;
    if (!ts?.length) return null;
    const from = r.ts - PATTERN_RULE.windowMs;
    let n = 0;
    for (const t of ts) if (t >= from && t <= r.ts) n++;
    return n >= PATTERN_RULE.minBuys ? 'repeated_small_buys' : null;
  });
}

export interface TradesQuery { before: BeforeParam | null; maker: string | null; min: number | null; limit: number }

/**
 * The trades tape (screener-plan 2.5): executed NAM swaps on Osmosis, newest first, keyset paged on (ts, height, id).
 * Per page: each side read in its index order (limit + 1 rows), the trades at the cursor's own millisecond and at a
 * side's last millisecond read whole (ties are never cut), the two sides merged here; then one grouped count of the
 * page's makers' trades and one read of their small buys for the pattern. About 1,700 rows read for the head page on
 * 2026-10-20 (most of it the busiest makers' rows for their counts).
 */
export async function readTrades(db: DB, q: TradesQuery, asOf: number, replay: boolean): Promise<TradesResponse> {
  const cursor = q.before?.kind === 'cursor' ? q.before.cursor : null;
  const bound = Math.min(q.before?.kind === 'time' ? q.before.ts : cursor ? cursor.ts : asOf + 1, asOf + 1);
  const sideParams = (tieTs: number | null) => [...(q.maker ? [q.maker] : []), tieTs ?? bound, ...(q.min != null ? [q.min] : [])];
  const o = { maker: !!q.maker, min: q.min != null };
  const side = async (kind: 'buy' | 'sell'): Promise<TradeDbRow[]> => {
    // Trades are Osmosis records: a Namada address never made one (and is never read for).
    if (q.maker && !q.maker.startsWith('osmo1')) return [];
    const rows = (await db.prepare(tradesSql(kind, { ...o, tie: false })).bind(...sideParams(null), q.limit + 1).all<TradeDbRow>()).results || [];
    const ties = cursor && cursor.ts <= asOf ? ((await db.prepare(tradesSql(kind, { ...o, tie: true })).bind(...sideParams(cursor.ts)).all<TradeDbRow>()).results || [])
      .filter((r) => Number(r.height) < cursor.height || (Number(r.height) === cursor.height && r.id < cursor.id)) : [];
    if (rows.length > q.limit) {
      // The side's last millisecond may hold more trades than the limit let through: read that millisecond whole.
      const last = Number(rows[rows.length - 1].ts);
      const group = (await db.prepare(tradesSql(kind, { ...o, tie: true })).bind(...sideParams(last)).all<TradeDbRow>()).results || [];
      return [...ties, ...rows.filter((r) => Number(r.ts) !== last), ...group];
    }
    return [...ties, ...rows];
  };
  const [buys, sells, startR, cov] = await Promise.all([side('buy'), side('sell'), later(() => db.prepare(TRADES_START_SQL).first<{ b: number | null; s: number | null }>()), later(() => coverageOf(db, asOf, replay))]);
  const merged = [...buys, ...sells].map((r) => ({ ...r, ts: Number(r.ts), height: Number(r.height) })).sort(feedOrder);
  const page = merged.slice(0, q.limit);
  const next = merged.length > q.limit ? encodeFlowCursor({ ts: page[page.length - 1].ts, height: page[page.length - 1].height, id: page[page.length - 1].id }) : null;
  const rows = page.map(tradeRowOf);

  // Each trade's settle price (its settle record, priced at its minute: a quote seek per coin that needs one), read
  // beside the makers' counts.
  const settled = later(() => settlePrices(db, page.map((r) => ({ kind: r.kind, ts: r.ts, meta: safeParseJson(r.meta, {}) as Record<string, unknown> | null }))))
    .then((ss) => ss.forEach((x, i) => { if (x) rows[i].settle = x; }));
  // The page's makers: their recorded trades (one grouped count per side) and their small buys for the pattern.
  const makers = [...new Set(rows.map((r) => r.maker).filter((m): m is string => !!m))];
  const buyCounts = new Map<string, number>(), sellCounts = new Map<string, number>(), small = new Map<string, number[]>();
  if (makers.length) {
    const minTs = Math.min(...rows.map((r) => r.ts)) - PATTERN_RULE.windowMs, maxTs = Math.max(...rows.map((r) => r.ts));
    const reads: Promise<void>[] = [];
    for (let i = 0; i < makers.length; i += MAKER_CHUNK) {
      const part = makers.slice(i, i + MAKER_CHUNK);
      const osmo = part.filter((m) => m.startsWith('osmo1'));
      reads.push(
        later(() => db.prepare(makerCountSql('buy', part.length)).bind(...part, asOf).all<{ maker: string; n: number }>()).then((r) => { for (const x of r.results || []) buyCounts.set(x.maker, Number(x.n)); }),
        later(() => db.prepare(makerCountSql('sell', part.length)).bind(...part, asOf).all<{ maker: string; n: number }>()).then((r) => { for (const x of r.results || []) sellCounts.set(x.maker, Number(x.n)); }),
      );
      if (osmo.length) reads.push(later(() => db.prepare(smallBuysSql(osmo.length)).bind(...osmo, PATTERN_RULE.underNam, minTs, maxTs).all<{ maker: string; ts: number }>())
        .then((r) => { for (const x of r.results || []) (small.get(x.maker) ?? small.set(x.maker, []).get(x.maker)!).push(Number(x.ts)); }));
    }
    await Promise.all(reads);
  }
  await settled;
  const pats = patternsOf(rows, small);
  rows.forEach((r, i) => {
    if (r.maker) r.makerTrades = { buys: buyCounts.get(r.maker) ?? 0, sells: sellCounts.get(r.maker) ?? 0 };
    r.pattern = pats[i];
  });
  const firsts = [startR?.b, startR?.s].map(finite).filter((x): x is number => x != null && x <= asOf);
  // A page reaching back before the stored Osmosis record is complete says so, and so do the makers' counts, which
  // cover every trade recorded (shared/osmosis-gap.ts); the rows and counts are as stored.
  const oldest = page.length ? page[page.length - 1].ts : bound;
  const prov = reachesOsmosisGap(oldest) ? withOsmosisGap(cov.osmosis, oldest)
    : makers.length && firsts.length && reachesOsmosisGap(Math.min(...firsts)) ? { ...cov.osmosis, note: [cov.osmosis.note, osmosisGapCounts('The makers\' trade counts')].filter(Boolean).join(' ') }
    : cov.osmosis;
  const res: TradesResponse & { foldUnderNam: number } = {
    rows, groups: foldTrades(rows), next, asOf, foldMs: TRADE_FOLD_MS, patternRule: { ...PATTERN_RULE }, prov,
    firstTs: firsts.length ? Math.min(...firsts) : null,
    // Not in the TradesResponse contract yet (requested): consecutive trades fold only under this size.
    foldUnderNam: TRADE_FOLD_UNDER_NAM,
  };
  return res;
}

// ================================================================ GET /api/series/values

// The words live in shared/copy.ts VALUE_WORDS, which the Trade page reads too.
export const FDV_LABEL = VALUE_WORDS.allNamLabel;
export const FDV_DEFINITION = VALUE_WORDS.allNam;
export const SPENDABLE_LABEL = VALUE_WORDS.spendableLabel;
export const SPENDABLE_DEFINITION = VALUE_WORDS.spendable;

/** The newest price, total supply, ordinary-account supply and Osmosis supply at or before ?1: 8 primary-key seeks, 8 rows read. */
export const VALUES_SQL = `SELECT ${['price.usd', 'supply.total', 'supply.liquid', 'supply.osmosis'].map((k, i) =>
  `(SELECT ts FROM metrics WHERE key = '${k}' AND ts <= ?1 ORDER BY ts DESC LIMIT 1) AS t${i}, (SELECT value FROM metrics WHERE key = '${k}' AND ts <= ?1 ORDER BY ts DESC LIMIT 1) AS v${i}`).join(', ')}`;

/** "All NAM at today's price" and "Spendable NAM at today's price", each with its definition and inputs. */
export async function readValues(db: DB, asOf: number, replay: boolean): Promise<ValuesResponse> {
  const r = await db.prepare(VALUES_SQL).bind(asOf).first<any>();
  const input = (i: number, name: string, source: string): ValueInput => {
    const at = finite(r?.[`t${i}`]), value = at != null ? finite(r?.[`v${i}`]) : null;
    const status = at == null ? 'missing' : replay ? 'live' : provAt(source, at, asOf, 5 * MIN).status;
    return { name, value, at, source, status };
  };
  const price = input(0, 'Quoted price (dollars per NAM)', QUOTED_SOURCE);
  const total = input(1, 'All NAM in existence', 'Namada RPC abci_query');
  const liquid = input(2, 'NAM in ordinary accounts on Namada', 'Namada RPC abci_query');
  const osmo = input(3, 'NAM on Osmosis', 'Keplr Osmosis bank/supply');
  const figure = (label: string, definition: string, inputs: ValueInput[], f: (v: number[]) => number): ValueFigure => {
    const gone = inputs.filter((x) => x.value == null);
    if (gone.length) return { label, definition, value: null, inputs, prov: { source: 'derived', at: null, status: 'missing', note: `${gone.map((x) => x.name).join(' and ')} ${gone.length > 1 ? 'are' : 'is'} not recorded ${replay ? 'at that time' : 'yet'}, so this figure is not shown.` } };
    const worst = inputs.reduce<Provenance['status']>((w, x) => (STATUS_RANK[x.status] > STATUS_RANK[w] ? x.status : w), 'live');
    const at = Math.min(...inputs.map((x) => x.at!));
    return { label, definition, value: f(inputs.map((x) => x.value!)), inputs, prov: { source: 'derived', at, status: worst, ...(worst !== 'live' ? { note: 'At least one input is older than 5 minutes.' } : {}) } };
  };
  return {
    asOf,
    fdv: figure(FDV_LABEL, FDV_DEFINITION, [total, price], ([t, p]) => t * p),
    spendable: figure(SPENDABLE_LABEL, SPENDABLE_DEFINITION, [liquid, osmo, price], ([l, o, p]) => (l + o) * p),
  };
}
