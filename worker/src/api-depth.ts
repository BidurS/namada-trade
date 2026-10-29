// The depth API (depth plan section 2; step S4), a Hono sub-app mounted by one line in api.ts:
// `app.route('/api/depth', depthApp)`. The contract is in shared/depth.ts; the rows it reads are the depth module's
// (worker/src/depth/, migration 0013). Nothing here reaches outside the database: every figure is a stored read of the
// minute or the hour, with that read's own time and height beside it in `prov`.
//
//   GET /api/depth                                   DepthResponse         the newest minute (kv depth.latest, one row read)
//   GET /api/depth/quote?side=&nam=                  DepthQuoteResponse    any size walked on the stored minute, no outside request
//   GET /api/depth/history?pool=&from=&to=&step=&at= DepthHistoryResponse  the stored rows by primary-key range, gaps listed
//   GET /api/depth/heat?days=&at=                    DepthHeatResponse     the aggregate's heat bands, one column per step
//   GET /api/depth/owners                            DepthOwnersApiResponse kv depth.owners with today's labels, one statement
//   GET /api/depth/changes?pool=&before=&limit=      DepthChangesResponse  depth_changes newest first, keyset paged
//
// A request the route cannot answer as asked is refused with plain words (400), a reading not stored yet is a 404 in the
// NotServedBody shape, and no refusal or failure is ever cached (Cache-Control: no-store; the refusal body, the `?at=`
// reading and the route wrapper are worker/src/api-route.ts, shared with the series routes). Every query parameter a
// route reads is listed in DEPTH_PARAMS and read only through `params()`, which refuses a parameter not listed for the
// route, so the edge cache key (worker/src/http.ts CACHE_PARAMS) can be checked against it (test/depth-api.test.ts). The
// module is built for one configuration (depthAppFor); `depthApp` is this Worker's, for the base coin of worker/src/depth/config.ts.
import { Hono, type Context } from 'hono';
import type { Env } from './util';
import { NOT_SERVED } from '../../shared/types';
import { fmtAddr, fmtUtcClock, fmtUtcLong } from '../../shared/format';
import { DAY_MS } from '../../shared/history';
import { ApiInputError, asOfOf, refuse, route } from './api-route';
import { findGaps } from './series-api';
import { label_plain, category_plain } from './labels';
import { NAM_DEPTH, type DepthConfig } from './depth/config';
import { KV_KEYS, kvManySql, AGGREGATE_POOL_ID } from './depth/sql';
import { pricedOfState, type DepthStates, type DepthOwnersKv } from './depth/index';
import { aggregate, buildGrid, executeBuy, executeSell, thinIndices, unpackF32, type Aggregate, type PricedPool } from './depth/model';
import {
  DEPTH_STALE_MS, DEPTH_STALE_WORDS, DEPTH_NOT_STORED, OWNERS_NOT_STORED, QUOTE_NAM_MIN, QUOTE_NAM_MAX, roundQuoteNam, quoteIncomplete, QUOTE_HOW_STATES, QUOTE_HOW_CURVE,
  CURVE_POINTS_MAX, HISTORY_ROWS_MAX, HISTORY_DEFAULT_MS, minuteRowsKept, GAP_MINUTE, GAP_HOUR, historyCut, historyRowsWords, heatRowsWords, changesRowsWords, HEAT_DAYS, HEAT_DEFAULT_DAYS, HEAT_HOW, HEAT_EDGES, HEAT_BAND_PCT, CHANGES_LIMIT_MAX,
  type DepthResponse, type DepthQuoteResponse, type DepthFill, type DepthHistoryResponse, type DepthHistoryPoint, type DepthHeatResponse, type DepthOwnersApiResponse, type DepthChangesResponse, type DepthChangeRow, type DepthProv, type DepthRef,
} from '../../shared/depth';

/** The query parameters each route reads. The edge cache key must list every one (worker/src/http.ts CACHE_PARAMS). */
export const DEPTH_PARAMS = {
  '/api/depth': [],
  '/api/depth/quote': ['side', 'nam'],
  '/api/depth/history': ['pool', 'from', 'to', 'step', 'at'],
  '/api/depth/heat': ['days', 'at'],
  '/api/depth/owners': [],
  '/api/depth/changes': ['pool', 'before', 'limit'],
} as const satisfies Record<string, readonly string[]>;
type Route = keyof typeof DEPTH_PARAMS;

/** A depth route's own refusal (worker/src/api-route.ts ApiInputError: the shared route wrapper answers it). */
export class DepthInputError extends ApiInputError {}

/** The parameters of one route, and nothing else: a parameter the route does not list is refused, not ignored. */
function params<R extends Route>(c: Context, path: R): Record<(typeof DEPTH_PARAMS)[R][number], string | undefined> {
  const listed = DEPTH_PARAMS[path] as readonly string[];
  const unknown = Object.keys(c.req.queries()).filter((k) => !listed.includes(k));
  if (unknown.length) throw new DepthInputError(400, `${unknown[0]} is not a parameter of this route${listed.length ? `; it takes ${listed.join(', ')}` : '; it takes none'}.`);
  const out = {} as Record<string, string | undefined>;
  for (const k of listed) out[k] = c.req.query(k);
  return out as Record<(typeof DEPTH_PARAMS)[R][number], string | undefined>;
}

/** A time parameter: unix ms, or a UTC day (YYYY-MM-DD; `endOfDay` takes its last millisecond). */
export function timeParam(raw: string | undefined, name: string, endOfDay: boolean): number | undefined {
  if (raw == null || raw === '') return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const t = Date.parse(`${raw}T00:00:00Z`);
    if (!Number.isFinite(t)) throw new DepthInputError(400, `${name} is not a day.`);
    return endOfDay ? t + 86_400_000 : t;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new DepthInputError(400, `${name} must be a unix time in milliseconds or a day (YYYY-MM-DD).`);
  return n;
}

const sig = (x: number, d: number): number => (Number.isFinite(x) ? +x.toPrecision(d) : x);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const wholeCoins = (n: number): string => new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Math.floor(n));

// ---------------------------------------------------------------------------------------------------- the statements
/** The newest minute and, for the quote, its raw states: one statement, by key. */
export const LATEST_SQL = 'SELECT key, value, updated_at FROM kv WHERE key = ?1';
export const LATEST_AND_STATES_SQL = kvManySql([KV_KEYS.latest, KV_KEYS.states]);

export const HISTORY_COLUMNS = 'at, height, ref_usd, spot_usd, bid_1, bid_2, bid_5, bid_10, bid_25, bid_50, ask_1, ask_2, ask_5, ask_10, ask_25, ask_50, sell_1k, sell_10k, sell_100k, sell_1m, buy_1k, buy_10k, buy_100k, buy_1m, best_bid, best_ask, bid_usd, ask_nam, note';
/** The history read: one primary-key range (pool_id, minute | hour) in step order, at most HISTORY_ROWS_MAX rows (plan C7). */
export const HISTORY_MINUTE_SQL = `SELECT minute AS t, ${HISTORY_COLUMNS} FROM depth_minute WHERE pool_id = ?1 AND minute >= ?2 AND minute < ?3 ORDER BY minute LIMIT ?4`;
export const HISTORY_HOUR_SQL = `SELECT hour AS t, ${HISTORY_COLUMNS} FROM depth_hourly WHERE pool_id = ?1 AND hour >= ?2 AND hour < ?3 ORDER BY hour LIMIT ?4`;
/** The first stored step of the pool: the left edge of the primary key, no row walked. */
export const HISTORY_START_MINUTE_SQL = 'SELECT MIN(minute) AS start FROM depth_minute WHERE pool_id = ?1';
export const HISTORY_START_HOUR_SQL = 'SELECT MIN(hour) AS start FROM depth_hourly WHERE pool_id = ?1';

/**
 * The heat read of the aggregate's rows: a day at every minute, a week at the last minute of each five (the key's own
 * range, the fifth minute kept by the statement so 2,016 rows come back of the 10,080 in the window, plan C7), a month
 * from the hourly rows. Each is a primary-key range search; the five-minute filter is applied on the rows the range yields.
 */
const HEAT_COLUMNS = 'at, height, ref_usd, heat_bid, heat_ask';
export const HEAT_MINUTE_SQL = `SELECT minute AS t, ${HEAT_COLUMNS} FROM depth_minute WHERE pool_id = ?1 AND minute >= ?2 AND minute < ?3 ORDER BY minute LIMIT ?4`;
export const HEAT_FIVE_SQL = `SELECT minute AS t, ${HEAT_COLUMNS} FROM depth_minute WHERE pool_id = ?1 AND minute >= ?2 AND minute < ?3 AND minute % 300000 = 240000 ORDER BY minute LIMIT ?4`;
export const HEAT_HOUR_SQL = `SELECT hour AS t, ${HEAT_COLUMNS} FROM depth_hourly WHERE pool_id = ?1 AND hour >= ?2 AND hour < ?3 ORDER BY hour LIMIT ?4`;

/**
 * kv depth.owners and the labels of the addresses in it, in one statement: the kv row first (kind 'kv'), then one row per
 * labelled owner (kind 'label'), the addresses taken from the stored JSON with json_each and each looked up by the labels
 * table's primary key. The hour stores every owner with label and category null (owner decision 21's build note), so a
 * label changed after the hour's read is never stale here.
 */
export const OWNERS_SQL = `SELECT 'kv' AS kind, value AS a, NULL AS b, NULL AS c, NULL AS d, updated_at AS e FROM kv WHERE key = ?1
UNION ALL
SELECT 'label', l.address, l.label, l.category, l.source, NULL FROM kv k, json_each(k.value, '$.owners') j JOIN labels l ON l.address = json_extract(j.value, '$.address') WHERE k.key = ?1`;

/**
 * The changes read, newest first: over every pool on the ts index (depth_changes_ts, migration 0013), for one pool on
 * the (pool_id, ts) index (depth_changes_pool_ts, migration 0014), each named so the read is one range of that index
 * and never a sort, and a pool with few rows costs the rows it has, not a walk of every pool's (the primary key is
 * (pool_id, ref, ts), in ref order). Keyset on (ts, pool_id, ref): a page behind a cursor reads the rows of the cursor's
 * own millisecond in a second statement of the same round trip (a minute's rows share one ts) and keeps those after the
 * cursor in (pool_id, ref) order, then the older rows.
 */
const CHANGE_COLUMNS = 'ts, pool_id, ref, kind, side, price_lo, price_hi, nam, usd, owner, height';
export const changesSql = (o: { pool: boolean; tie: boolean }): string =>
  `SELECT ${CHANGE_COLUMNS} FROM depth_changes INDEXED BY ${o.pool ? 'depth_changes_pool_ts' : 'depth_changes_ts'} WHERE ${o.pool ? 'pool_id = ?2 AND ' : ''}ts ${o.tie ? '=' : '<'} ?1 ORDER BY ts DESC${o.tie ? '' : ` LIMIT ?${o.pool ? 3 : 2}`}`;

// ---------------------------------------------------------------------------------------------------- the reads
export interface KvRow { key: string; value: string; updated_at: number | null }
const parseJson = <T>(text: string | null | undefined): T | null => { try { return text ? (JSON.parse(text) as T) : null; } catch { return null; } };

/** The stored minute with its status set from its age: stale past DEPTH_STALE_MS, said in the note with the clock it was written at. */
export function withStatus(latest: DepthResponse, now: number): DepthResponse {
  const stale = now - latest.at > DEPTH_STALE_MS;
  const ref: DepthRef = { ...latest.ref, status: stale ? 'stale' : 'live' };
  const out: DepthResponse = { ...latest, ref };
  if (stale) out.note = [latest.note, `${DEPTH_STALE_WORDS} (written ${fmtUtcClock(latest.at)})`].filter(Boolean).join('; ');
  return out;
}

async function readLatest(db: D1Database, now: number): Promise<DepthResponse> {
  const row = await db.prepare(LATEST_SQL).bind(KV_KEYS.latest).first<KvRow>();
  const latest = parseJson<DepthResponse>(row?.value);
  if (!latest || !latest.ref || !latest.curve) throw new DepthInputError(404, NOT_SERVED, DEPTH_NOT_STORED);
  return withStatus(latest, now);
}

/**
 * The aggregate the quote walks. With the minute's states stored (the same minute, every pool's model rebuilt), the pool
 * models are walked on the stored curve's own grid: at a grid price each pool's cumulative figure is exact, so the sum
 * equals the stored curve at its points and the split by pool is exact. Without them, the stored aggregate curve alone.
 */
/**
 * The stored curve's grid at full precision: the minute built its grid from the reference price alone (model.ts buildGrid)
 * and kept every k-th point (thinIndices), writing the prices at six significant digits. Rebuilt the same way from the
 * stored reference and held to the stored prices digit for digit; when they differ (a minute written by other code), the
 * stored prices themselves are the grid.
 */
export function curveGridOf(latest: DepthResponse): number[] {
  const stored = latest.curve.price;
  try {
    const grid = buildGrid(latest.ref.usd);
    const refIndex = grid.findIndex((g) => g >= latest.ref.usd);
    const exact = thinIndices(grid.length, Math.max(0, refIndex), CURVE_POINTS_MAX).map((i) => grid[i]);
    if (exact.length === stored.length && exact.every((x, k) => sig(x, 6) === stored[k])) return exact;
  } catch { /* the stored prices below */ }
  return stored;
}

export function quoteAggregate(cfg: DepthConfig, latest: DepthResponse, states: DepthStates | null): { agg: Aggregate; pools: PricedPool[]; how: string } {
  if (states && states.minute === latest.at && Array.isArray(states.pools) && states.pools.length) {
    const pools = states.pools.map((s) => pricedOfState(cfg, s)).filter((p): p is PricedPool => p != null);
    if (pools.length === states.pools.length) return { agg: aggregate(pools, curveGridOf(latest), cfg.base.decimals), pools, how: QUOTE_HOW_STATES };
  }
  const grid = latest.curve.price;
  const f = (a: number[]) => Float64Array.from(a);
  return { agg: { grid, bidNam: f(latest.curve.bidNam), bidUsd: f(latest.curve.bidUsd), askNam: f(latest.curve.askNam), askUsd: f(latest.curve.askUsd), perPool: [] }, pools: [], how: QUOTE_HOW_CURVE };
}

const roundFill = (f: DepthFill): DepthFill => ({ ...f, usd: sig(f.usd, 7), avgPrice: f.avgPrice == null ? null : sig(f.avgPrice, 7), marginalPrice: sig(f.marginalPrice, 7), filledNam: sig(f.filledNam, 7), split: f.split.map((s) => ({ pool: s.pool, nam: sig(s.nam, 6), usd: sig(s.usd, 6) })) });

/** The refinement's points between the two grid prices the fill falls between. */
export const QUOTE_REFINE_POINTS = 32;
/**
 * The walk: first on the stored curve's grid, then, with the pool models in hand, again on QUOTE_REFINE_POINTS points
 * between the two grid prices the fill fell between (the models are exact at any price; the stored grid is thinned to
 * about a percent a step, and the fill between two of its points is linear). A size the whole curve cannot fill is
 * answered from the first walk as incomplete.
 */
export function walkQuote(cfg: DepthConfig, agg: Aggregate, pools: PricedPool[], side: 'sell' | 'buy', nam: number): DepthFill {
  const run = (a: Aggregate) => (side === 'sell' ? executeSell(a, pools, nam) : executeBuy(a, pools, nam));
  const first = run(agg);
  if (!first.complete || !pools.length) return first;
  const g = agg.grid;
  let hi = g.findIndex((x) => x >= first.marginalPrice);
  if (hi < 0) hi = g.length - 1;
  const lo = Math.max(0, hi - 1);
  if (!(g[hi] > g[lo])) return first;
  const sub = Array.from({ length: QUOTE_REFINE_POINTS + 1 }, (_, k) => g[lo] + ((g[hi] - g[lo]) * k) / QUOTE_REFINE_POINTS);
  const second = run(aggregate(pools, sub, cfg.base.decimals));
  return second.complete ? second : first;
}

/** The quote for a size: `nam` is answered rounded (roundQuoteNam), as the edge key rounds it, so one copy serves every size that rounds alike. */
export function quoteOf(cfg: DepthConfig, latest: DepthResponse, states: DepthStates | null, side: 'sell' | 'buy', asked: number): DepthQuoteResponse {
  const nam = roundQuoteNam(asked);
  const { agg, pools, how } = quoteAggregate(cfg, latest, states);
  const fill = roundFill(walkQuote(cfg, agg, pools, side, nam));
  const out: DepthQuoteResponse = {
    ...fill, side, ref: latest.ref, vsRef: fill.avgPrice != null && latest.ref.usd > 0 ? sig((fill.avgPrice / latest.ref.usd - 1) * 100, 5) : null,
    at: latest.at, height: latest.ref.height, how, prov: latest.prov,
  };
  if (!fill.complete) out.note = quoteIncomplete(side, wholeCoins(fill.filledNam), cfg.base.symbol);
  return out;
}

const MIN_MS = 60_000, HOUR_MS = 3_600_000;
/**
 * How long after a step's close its row is due: a minute's within two minutes of the minute's end (the next tick writes
 * it), an hour's within fifteen minutes of the hour's close (the rollup runs in the window after it). A step is a gap
 * only once it has closed (findGaps admits a step when its end is inside the span) and its grace has passed.
 */
export const HISTORY_GRACE_MS = { '1m': 2 * MIN_MS, '1h': 15 * MIN_MS } as const;

export interface HistoryAsk { pool: string; step: '1m' | '1h'; from: number; to: number; asOf: number }
export function historyAsk(p: { pool?: string; from?: string; to?: string; step?: string }, asOf: number): HistoryAsk {
  const pool = p.pool == null || p.pool === '' ? AGGREGATE_POOL_ID : p.pool;
  if (pool !== AGGREGATE_POOL_ID && !/^\d{1,12}$/.test(pool)) throw new DepthInputError(400, `pool must be a pool id or ${AGGREGATE_POOL_ID} (every pool summed).`);
  const step = p.step == null || p.step === '' ? '1m' : p.step;
  if (step !== '1m' && step !== '1h') throw new DepthInputError(400, 'step must be 1m or 1h.');
  const to = Math.min(asOf, timeParam(p.to, 'to', true) ?? asOf);
  const from = timeParam(p.from, 'from', false) ?? to - HISTORY_DEFAULT_MS;
  if (!(from < to)) throw new DepthInputError(400, 'from must be before to.');
  return { pool, step, from, to, asOf };
}

const pointOf = (r: Record<string, unknown>): DepthHistoryPoint => ({
  t: Number(r.t), at: Number(r.at), height: num(r.height), refUsd: Number(r.ref_usd), spotUsd: num(r.spot_usd),
  bid: [r.bid_1, r.bid_2, r.bid_5, r.bid_10, r.bid_25, r.bid_50].map(num), ask: [r.ask_1, r.ask_2, r.ask_5, r.ask_10, r.ask_25, r.ask_50].map(num),
  sell: [r.sell_1k, r.sell_10k, r.sell_100k, r.sell_1m].map(num), buy: [r.buy_1k, r.buy_10k, r.buy_100k, r.buy_1m].map(num),
  bestBid: num(r.best_bid), bestAsk: num(r.best_ask), bidUsd: num(r.bid_usd), askNam: num(r.ask_nam), note: typeof r.note === 'string' ? r.note : null,
});

/** One provenance line for a read of stored rows: no URL (nothing outside was asked) but the table and the key range, the newest row's own time and height, the rows' size. */
const storedProv = (what: string, table: string, key: Record<string, string | number>, rows: { at?: number | null; height?: number | null }[], asOf: number): DepthProv => {
  const newest = rows[rows.length - 1];
  return { what, url: null, table, key, at: num(newest?.at) ?? asOf, height: num(newest?.height), bytes: JSON.stringify(rows).length, status: 'stored' };
};

export async function readHistory(db: D1Database, cfg: DepthConfig, ask: HistoryAsk): Promise<DepthHistoryResponse> {
  const { pool, step, from, to, asOf } = ask;
  const minute = step === '1m';
  const limit = Math.min(HISTORY_ROWS_MAX, cfg.caps.historyRowsMax);
  // one row past the cap is asked for, so a window that holds exactly the cap (a whole retention of minutes) is not said to be cut
  const [range, startRow] = await db.batch([
    db.prepare(minute ? HISTORY_MINUTE_SQL : HISTORY_HOUR_SQL).bind(pool, from, to, limit + 1),
    db.prepare(minute ? HISTORY_START_MINUTE_SQL : HISTORY_START_HOUR_SQL).bind(pool),
  ]);
  const read = (range.results ?? []) as Record<string, unknown>[];
  const cut = read.length > limit;
  const rows = cut ? read.slice(0, limit) : read;
  const points = rows.map(pointOf);
  const start = num((startRow.results?.[0] as { start?: unknown } | undefined)?.start);
  const stepMs = minute ? MIN_MS : HOUR_MS;
  // a step is a gap only once its row is due: inside the known span, up to what the writer has had time to write, and
  // never past the cap (what lies past the last row read is not known to be missing)
  const known = Math.min(to, asOf - HISTORY_GRACE_MS[step], cut ? points[points.length - 1].t + stepMs : Infinity);
  const gaps = start == null ? [] : findGaps(new Set(points.map((p) => p.t)), Math.max(from, start), known, stepMs, 1, minute ? GAP_MINUTE : GAP_HOUR);
  const table = minute ? 'depth_minute' : 'depth_hourly';
  const notes = [minute ? minuteRowsKept(Math.round(cfg.caps.retentionMs / DAY_MS)) : null, cut ? historyCut(limit) : null, start == null ? `nothing is stored for pool ${pool} at this step` : start > from ? `stored from ${fmtUtcLong(start)}` : null].filter((x): x is string => !!x);
  return {
    pool, step, from, to, asOf, points, gaps, start, cut, note: notes.length ? notes.join('; ') : null,
    prov: [storedProv(historyRowsWords(table, pool, points.length, Math.floor((to - 1) / stepMs) - Math.ceil(from / stepMs) + 1), table, { pool_id: pool, from, to, limit }, points, asOf)],
  };
}

export async function readHeat(db: D1Database, cfg: DepthConfig, days: number, asOf: number): Promise<DepthHeatResponse> {
  const step = HEAT_DAYS[days];
  if (!step) throw new DepthInputError(400, `days must be one of ${Object.keys(HEAT_DAYS).join(', ')}.`);
  const to = asOf, from = to - days * 86_400_000;
  const sql = step === '1m' ? HEAT_MINUTE_SQL : step === '5m' ? HEAT_FIVE_SQL : HEAT_HOUR_SQL;
  const rows = ((await db.prepare(sql).bind(AGGREGATE_POOL_ID, from, to, cfg.caps.heatRowsMax).all<Record<string, unknown>>()).results ?? []);
  const columns: DepthHeatResponse['columns'] = [];
  let max = 0, blank = 0;
  for (const r of rows) {
    if (typeof r.heat_bid !== 'string' || typeof r.heat_ask !== 'string') { blank++; continue; }
    for (const s of [r.heat_bid, r.heat_ask]) for (const v of unpackF32(s)) if (v > max) max = v;
    columns.push({ t: Number(r.t), refUsd: Number(r.ref_usd), bid: r.heat_bid, ask: r.heat_ask, height: num(r.height) });
  }
  const table = step === '1h' ? 'depth_hourly' : 'depth_minute';
  return {
    days, from, to, asOf, bands: { edges: [...HEAT_EDGES], pct: HEAT_BAND_PCT }, columns, step, max,
    how: blank ? `${HEAT_HOW[step]}; ${blank} stored rows carry no bands and are left out` : HEAT_HOW[step],
    prov: [storedProv(heatRowsWords(table, columns.length), table, { pool_id: AGGREGATE_POOL_ID, from, to, step }, rows, asOf)],
  };
}

interface OwnersRow { kind: 'kv' | 'label'; a: string; b: string | null; c: string | null; d: string | null; e: number | null }
export async function readOwners(db: D1Database): Promise<DepthOwnersApiResponse> {
  const rows = ((await db.prepare(OWNERS_SQL).bind(KV_KEYS.owners).all<OwnersRow>()).results ?? []);
  const kvRow = rows.find((r) => r.kind === 'kv');
  const stored = parseJson<DepthOwnersKv>(kvRow?.a);
  if (!stored || !Array.isArray(stored.owners)) throw new DepthInputError(404, NOT_SERVED, OWNERS_NOT_STORED);
  const labels = new Map(rows.filter((r) => r.kind === 'label').map((r) => [r.a, { label: r.b, category: r.c, source: r.d }]));
  let labelled = 0;
  const owners = stored.owners.map((o) => {
    const l = labels.get(o.address);
    const label = label_plain(l?.label, o.address, l?.source);
    if (label) labelled++;
    return { ...o, short: fmtAddr(o.address), label, category: category_plain(l?.category, l?.label) };
  });
  return {
    at: stored.at, height: stored.height, owners, totals: stored.totals, prov: stored.prov ?? [], hour: stored.hour,
    positions: stored.positions, orders: stored.orders, invariants: stored.invariants, notes: stored.notes ?? [], labelled,
  };
}

/** The changes cursor: the last row's (ts, pool, ref), base64 of their JSON. */
export const changesCursor = (r: { ts: number; pool: string; ref: string }): string => btoa(JSON.stringify([r.ts, r.pool, r.ref])).replace(/=+$/, '');
export function parseChangesCursor(raw: string | undefined): { ts: number; pool: string; ref: string } | null {
  if (!raw) return null;
  if (raw.length > 200 || !/^[A-Za-z0-9+/]+$/.test(raw)) throw new DepthInputError(400, 'before must be a cursor from a previous page.');
  let p: unknown;
  try { p = JSON.parse(atob(raw)); } catch { throw new DepthInputError(400, 'before must be a cursor from a previous page.'); }
  if (!Array.isArray(p) || p.length !== 3 || typeof p[0] !== 'number' || !Number.isInteger(p[0]) || p[0] <= 0 || typeof p[1] !== 'string' || typeof p[2] !== 'string') throw new DepthInputError(400, 'before must be a cursor from a previous page.');
  return { ts: p[0], pool: p[1], ref: p[2] };
}
export function changesLimit(raw: string | undefined): number {
  if (raw == null || raw === '') return CHANGES_LIMIT_MAX;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > CHANGES_LIMIT_MAX) throw new DepthInputError(400, `limit must be a whole number from 1 to ${CHANGES_LIMIT_MAX}.`);
  return n;
}
const changeOf = (r: Record<string, unknown>): DepthChangeRow => ({
  ts: Number(r.ts), pool: String(r.pool_id), ref: String(r.ref), kind: r.kind as DepthChangeRow['kind'], side: (r.side as DepthChangeRow['side']) ?? null,
  loUsd: num(r.price_lo), hiUsd: num(r.price_hi), nam: num(r.nam), usd: num(r.usd), owner: typeof r.owner === 'string' ? r.owner : null, height: num(r.height),
});
/** Newest first: ts, then pool id, then ref, all descending (the cursor's order). */
const afterCursor = (r: DepthChangeRow, c: { pool: string; ref: string }) => r.pool < c.pool || (r.pool === c.pool && r.ref < c.ref);

/** The page's order: ts, then pool id, then ref, all descending (the cursor's order). */
const byKeyset = (a: DepthChangeRow, b: DepthChangeRow) => b.ts - a.ts || (b.pool < a.pool ? -1 : b.pool > a.pool ? 1 : 0) || (b.ref < a.ref ? -1 : b.ref > a.ref ? 1 : 0);

/**
 * One page. The older rows are read with one row past the page (series-api.ts readTrades' pattern): when that row shares
 * the last kept row's millisecond, the ts index gave that millisecond's rows in no promised order and the page could not
 * be a prefix of the keyset order, so the millisecond is read whole in a second round trip and the page ends inside it
 * in sorted order (the next page's tie statement reads the rest). A minute's diff writes every row at one ts, so this is
 * the common shape of a cut, not a corner.
 */
export async function readChanges(db: D1Database, o: { pool: string | null; before: { ts: number; pool: string; ref: string } | null; limit: number }, now: number): Promise<DepthChangesResponse> {
  const pool = o.pool;
  const bound = o.before?.ts ?? now + 1;
  const poolParams = pool ? [pool] : [];
  const older = db.prepare(changesSql({ pool: !!pool, tie: false })).bind(bound, ...poolParams, o.limit + 1);
  const tieStmt = (ts: number) => db.prepare(changesSql({ pool: !!pool, tie: true })).bind(ts, ...poolParams);
  const results = await db.batch(o.before ? [tieStmt(o.before.ts), older] : [older]);
  const rowsOf = (r: { results?: unknown[] } | undefined) => ((r?.results ?? []) as Record<string, unknown>[]).map(changeOf);
  const c = o.before;
  const ties = c ? rowsOf(results[0]).filter((r) => afterCursor(r, c)) : [];
  const read = rowsOf(results[results.length - 1]);
  const more = read.length > o.limit;
  let olderRows = read.slice(0, o.limit);
  if (more && read[o.limit].ts === read[o.limit - 1].ts) {
    const last = read[o.limit - 1].ts;
    const whole = rowsOf((await db.batch([tieStmt(last)]))[0]);
    olderRows = [...olderRows.filter((r) => r.ts !== last), ...whole];
  }
  const rows = [...ties, ...olderRows].sort(byKeyset);
  const page = rows.slice(0, o.limit);
  const lastRow = page[page.length - 1];
  const next = lastRow && (more || rows.length > o.limit) ? changesCursor(lastRow) : null;
  return { pool, rows: page, next, limit: o.limit, prov: [storedProv(changesRowsWords(pool, page.length), 'depth_changes', { ...(pool ? { pool_id: pool } : {}), before: o.before ? o.before.ts : now, limit: o.limit }, [...page].reverse().map((r) => ({ at: r.ts, height: r.height })), now)] };
}

// ---------------------------------------------------------------------------------------------------- the routes
export function depthAppFor(cfg: DepthConfig) {
  const depth = new Hono<{ Bindings: Env }>();
  depth.get('/', route('/api/depth', async (c) => {
    params(c, '/api/depth');
    return readLatest(c.env.DB, Date.now());
  }));

  depth.get('/quote', route('/api/depth/quote', async (c) => {
    const p = params(c, '/api/depth/quote');
    if (p.side !== 'sell' && p.side !== 'buy') throw new DepthInputError(400, 'side must be sell or buy.');
    const asked = p.nam == null || p.nam === '' ? NaN : Number(p.nam);
    if (!Number.isFinite(asked) || asked < QUOTE_NAM_MIN || asked > QUOTE_NAM_MAX) throw new DepthInputError(400, `nam must be a number of ${cfg.base.symbol} from ${QUOTE_NAM_MIN} to ${wholeCoins(QUOTE_NAM_MAX)}.`);
    const now = Date.now();
    const rows = ((await c.env.DB.prepare(LATEST_AND_STATES_SQL).bind(KV_KEYS.latest, KV_KEYS.states).all<KvRow>()).results ?? []);
    const latest = parseJson<DepthResponse>(rows.find((r) => r.key === KV_KEYS.latest)?.value);
    if (!latest || !latest.ref || !latest.curve) throw new DepthInputError(404, NOT_SERVED, DEPTH_NOT_STORED);
    const states = parseJson<DepthStates>(rows.find((r) => r.key === KV_KEYS.states)?.value);
    return quoteOf(cfg, withStatus(latest, now), states, p.side, asked);
  }));

  depth.get('/history', route('/api/depth/history', async (c) => {
    const p = params(c, '/api/depth/history');
    const { asOf } = asOfOf(p.at);
    return readHistory(c.env.DB, cfg, historyAsk(p, asOf));
  }));

  depth.get('/heat', route('/api/depth/heat', async (c) => {
    const p = params(c, '/api/depth/heat');
    const { asOf } = asOfOf(p.at);
    const days = p.days == null || p.days === '' ? HEAT_DEFAULT_DAYS : Number(p.days);
    return readHeat(c.env.DB, cfg, days, asOf);
  }));

  depth.get('/owners', route('/api/depth/owners', async (c) => {
    params(c, '/api/depth/owners');
    return readOwners(c.env.DB);
  }));

  depth.get('/changes', route('/api/depth/changes', async (c) => {
    const p = params(c, '/api/depth/changes');
    const pool = p.pool == null || p.pool === '' ? null : p.pool;
    // a change row belongs to one pool (depth/diff.ts): there is no aggregate row to filter by, so `all` is refused, not read
    if (pool != null && !/^\d{1,12}$/.test(pool)) throw new DepthInputError(400, `pool must be a pool id; leave it out for every pool’s changes (a change belongs to one pool, so there is no ${AGGREGATE_POOL_ID}).`);
    return readChanges(c.env.DB, { pool, before: parseChangesCursor(p.before), limit: changesLimit(p.limit) }, Date.now());
  }));

  depth.all('*', (c) => refuse(c, 404, new URL(c.req.url).pathname, NOT_SERVED, 'No such depth route.'));
  return depth;
}

/** This Worker's depth routes: the configuration of worker/src/depth/config.ts. */
export const depthApp = depthAppFor(NAM_DEPTH);
