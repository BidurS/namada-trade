// The depth statements (migration 0014): the minute row, the hourly row and the rollup read behind it, the change row,
// the kv rows and the retention delete. Every REAL column is
// a finite number or NULL (cron.ts phase 3's rule, test/osmosis-hourly-finite.test.ts: D1 sends parameters as JSON, so
// a figure that is not finite would arrive as NULL and fail a NOT NULL column for the whole batch); the three NOT NULL
// figures (minute, at, ref_usd) must be finite or the row is not built at all.
import type { Stmt } from '../db';
import { stmt } from '../db';

/** One depth_minute row before it is bound: arrays in the order of DEPTH_OFFSETS_PCT and DEPTH_SIZES. */
export interface DepthMinuteRow {
  minute: number;
  pool_id: string;
  at: number;
  height: number | null;
  ref_usd: number;
  spot_usd: number | null;
  bid: (number | null)[];
  ask: (number | null)[];
  sell: (number | null)[];
  buy: (number | null)[];
  best_bid: number | null;
  best_ask: number | null;
  bid_usd: number | null;
  ask_nam: number | null;
  nam: number | null;
  counter: number | null;
  counter_usd: number | null;
  heat_bid: string | null;
  heat_ask: string | null;
  note: string | null;
}

/** A finite number as given, anything else NULL. */
export const finiteOrNull = (v: number | null | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
export const NOTE_MAX = 160;

export const DEPTH_MINUTE_COLUMNS = [
  'minute', 'pool_id', 'at', 'height', 'ref_usd', 'spot_usd',
  'bid_1', 'bid_2', 'bid_5', 'bid_10', 'bid_25', 'bid_50', 'ask_1', 'ask_2', 'ask_5', 'ask_10', 'ask_25', 'ask_50',
  'sell_1k', 'sell_10k', 'sell_100k', 'sell_1m', 'buy_1k', 'buy_10k', 'buy_100k', 'buy_1m',
  'best_bid', 'best_ask', 'bid_usd', 'ask_nam', 'nam', 'counter', 'counter_usd', 'heat_bid', 'heat_ask', 'note',
] as const;
const INSERT_MINUTE = `INSERT OR REPLACE INTO depth_minute (${DEPTH_MINUTE_COLUMNS.join(',')}) VALUES (${DEPTH_MINUTE_COLUMNS.map(() => '?').join(',')})`;

const six = (a: (number | null)[]): (number | null)[] => Array.from({ length: 6 }, (_, i) => finiteOrNull(a[i]));
const four = (a: (number | null)[]): (number | null)[] => Array.from({ length: 4 }, (_, i) => finiteOrNull(a[i]));

/** The minute row's statement. Throws when a NOT NULL figure is not finite: the caller leaves that row out and says so. */
export function minuteStmt(r: DepthMinuteRow): Stmt {
  if (!Number.isFinite(r.minute) || !Number.isFinite(r.at) || !Number.isFinite(r.ref_usd)) throw new Error(`depth_minute ${r.pool_id}: minute, at and ref_usd must be finite`);
  if (!r.pool_id) throw new Error('depth_minute: no pool id');
  return {
    sql: INSERT_MINUTE,
    params: [
      r.minute, r.pool_id, r.at, finiteOrNull(r.height), r.ref_usd, finiteOrNull(r.spot_usd),
      ...six(r.bid), ...six(r.ask), ...four(r.sell), ...four(r.buy),
      finiteOrNull(r.best_bid), finiteOrNull(r.best_ask), finiteOrNull(r.bid_usd), finiteOrNull(r.ask_nam), finiteOrNull(r.nam), finiteOrNull(r.counter), finiteOrNull(r.counter_usd),
      r.heat_bid, r.heat_ask, r.note ? r.note.slice(0, NOTE_MAX) : null,
    ],
  };
}

/** The hourly row's own columns past the minute's: the hour's extremes of two figures and the minutes that had a row. */
export const DEPTH_HOURLY_EXTRA = ['sell_10k_lo', 'sell_10k_hi', 'bid_10_lo', 'bid_10_hi', 'n'] as const;
const HOURLY_COLUMNS = ['hour', ...DEPTH_MINUTE_COLUMNS.slice(1), ...DEPTH_HOURLY_EXTRA] as const;
const INSERT_HOURLY = `INSERT OR REPLACE INTO depth_hourly (${HOURLY_COLUMNS.join(',')}) VALUES (${HOURLY_COLUMNS.map(() => '?').join(',')})`;

/** One depth_hourly row: the hour's last minute row, the extremes and the count (plan 1.5). */
export interface DepthHourlyRow extends Omit<DepthMinuteRow, 'minute'> {
  hour: number;
  sell_10k_lo: number | null;
  sell_10k_hi: number | null;
  bid_10_lo: number | null;
  bid_10_hi: number | null;
  n: number;
}
/** The hourly row's statement, with the minute row's own rules (throws when a NOT NULL figure is not finite). */
export function hourlyStmt(r: DepthHourlyRow): Stmt {
  const m = minuteStmt({ ...r, minute: r.hour });
  if (!Number.isInteger(r.n) || r.n < 1) throw new Error(`depth_hourly ${r.pool_id}: n must be a count`);
  return { sql: INSERT_HOURLY, params: [...m.params, finiteOrNull(r.sell_10k_lo), finiteOrNull(r.sell_10k_hi), finiteOrNull(r.bid_10_lo), finiteOrNull(r.bid_10_hi), r.n] };
}

/**
 * The rollup read of one pool's hour: the last minute's row with the hour's extremes and count beside it. Two primary-key
 * range searches (pool_id, minute), nothing scanned; one statement per pool of the hour, batched.
 */
export const HOURLY_ROLLUP_SQL = `SELECT d.*, a.sell_10k_lo, a.sell_10k_hi, a.bid_10_lo, a.bid_10_hi, a.n FROM depth_minute d, (
  SELECT MIN(sell_10k) sell_10k_lo, MAX(sell_10k) sell_10k_hi, MIN(bid_10) bid_10_lo, MAX(bid_10) bid_10_hi, COUNT(*) n, MAX(minute) last
  FROM depth_minute WHERE pool_id = ? AND minute >= ? AND minute < ?) a WHERE d.pool_id = ? AND d.minute = a.last`;
export const hourlyRollupStmt = (poolId: string, hour: number): Stmt => ({ sql: HOURLY_ROLLUP_SQL, params: [poolId, hour, hour + 3_600_000, poolId] });
/** What HOURLY_ROLLUP_SQL answers: the minute row's columns and the five extra. */
export type HourlyRollupRead = Record<(typeof DEPTH_MINUTE_COLUMNS)[number], unknown> & Record<(typeof DEPTH_HOURLY_EXTRA)[number], unknown>;

/** A rollup read as the hourly row: the stored columns as read (already finite or NULL), the arrays rebuilt. */
export function hourlyRowOf(r: HourlyRollupRead, hour: number): DepthHourlyRow {
  const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const req = (v: unknown, what: string): number => { const x = n(v); if (x == null) throw new Error(`depth_hourly: ${what} is not a number`); return x; };
  return {
    hour, pool_id: String(r.pool_id), at: req(r.at, 'at'), height: n(r.height), ref_usd: req(r.ref_usd, 'ref_usd'), spot_usd: n(r.spot_usd),
    bid: [r.bid_1, r.bid_2, r.bid_5, r.bid_10, r.bid_25, r.bid_50].map(n), ask: [r.ask_1, r.ask_2, r.ask_5, r.ask_10, r.ask_25, r.ask_50].map(n),
    sell: [r.sell_1k, r.sell_10k, r.sell_100k, r.sell_1m].map(n), buy: [r.buy_1k, r.buy_10k, r.buy_100k, r.buy_1m].map(n),
    best_bid: n(r.best_bid), best_ask: n(r.best_ask), bid_usd: n(r.bid_usd), ask_nam: n(r.ask_nam), nam: n(r.nam), counter: n(r.counter), counter_usd: n(r.counter_usd),
    heat_bid: typeof r.heat_bid === 'string' ? r.heat_bid : null, heat_ask: typeof r.heat_ask === 'string' ? r.heat_ask : null, note: typeof r.note === 'string' ? r.note : null,
    sell_10k_lo: n(r.sell_10k_lo), sell_10k_hi: n(r.sell_10k_hi), bid_10_lo: n(r.bid_10_lo), bid_10_hi: n(r.bid_10_hi), n: req(r.n, 'n'),
  };
}

/** A depth_changes row (plan 1.5; shared/depth.ts DepthChangeRow says what each column holds). Keyed (pool_id, ref, ts). */
export const changeStmt = (c: { ts: number; pool: string; ref: string; kind: string; side: string | null; loUsd: number | null; hiUsd: number | null; nam: number | null; usd: number | null; owner: string | null; height: number | null }): Stmt => {
  if (!Number.isFinite(c.ts) || !c.pool || !c.ref || !c.kind) throw new Error('depth_changes: ts, pool, ref and kind are required');
  return {
    sql: 'INSERT OR REPLACE INTO depth_changes (ts, pool_id, ref, kind, side, price_lo, price_hi, nam, usd, owner, height) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    params: [c.ts, c.pool, c.ref, c.kind, c.side, finiteOrNull(c.loUsd), finiteOrNull(c.hiUsd), finiteOrNull(c.nam), finiteOrNull(c.usd), c.owner, finiteOrNull(c.height)],
  };
};

/** A kv row, the value already a string or made one. */
export const kvStmt = (key: string, value: unknown, at: number): Stmt => stmt.kvSet(key, typeof value === 'string' ? value : JSON.stringify(value), at);

/** Copy one kv row onto another key in one statement (depth.states becomes depth.prev before the new states are written), with no read. */
export const copyKvStmt = (from: string, to: string): Stmt => ({
  sql: 'INSERT OR REPLACE INTO kv (key, value, updated_at) SELECT ?, value, updated_at FROM kv WHERE key = ?',
  params: [to, from],
});

/**
 * The retention delete (C5), one statement per pool: the primary key is (pool_id, minute), so `minute < ?` alone would
 * walk the whole index every run (about 734,000 rows a window at 17 pools); with the pool id in front each statement
 * is a range search that stops at the window. `limit` is the run's whole budget, shared out over the pools. The pool
 * ids are the ones the newest answer lists (every listed pool and 'all'): a pool the quote service's list no longer
 * names stops getting rows, and the hourly job of step S3 names it until its rows are out of the window.
 */
export const deleteOldMinutesStmts = (poolIds: readonly string[], before: number, limit: number): Stmt[] => {
  const ids = [...new Set(poolIds)];
  const each = Math.max(1, Math.floor(limit / Math.max(1, ids.length)));
  return ids.map((id) => ({
    sql: 'DELETE FROM depth_minute WHERE rowid IN (SELECT rowid FROM depth_minute WHERE pool_id = ? AND minute < ? ORDER BY minute LIMIT ?)',
    params: [id, before, each],
  }));
};

/** The stored swaps the realised check walks (check 3): the buys and sells of `chain` in the window, newest first. */
export const SWAPS_SQL = 'SELECT id, ts, kind, pool_id, meta FROM flows WHERE chain = ? AND kind IN (\'buy\', \'sell\') AND ts >= ? AND ts < ? ORDER BY ts DESC LIMIT 200';
export const swapsStmt = (chain: string, from: number, to: number): Stmt => ({ sql: SWAPS_SQL, params: [chain, from, to] });

/** The pool id of the aggregate's own rows (depth_minute and depth_hourly): every live pool summed, the only row with heat bands. */
export const AGGREGATE_POOL_ID = 'all';

/** The keys the minute reads first, in one statement. */
export const KV_KEYS = {
  on: 'depth.on',
  budget: 'depth.budget',
  book: 'depth.book',
  params: 'depth.params',
  latest: 'depth.latest',
  prev: 'depth.prev',
  states: 'depth.states',
  realised: 'depth.realised',
  owners: 'depth.owners',
  /** The hour the hourly job last finished (its own marker, as series.ts keeps jobs.hourly). */
  hourly: 'depth.hourly',
  /** The hour whose rollup into depth_hourly last went in; an hour spent at the row cap leaves it, so the rollup catches up. */
  rolled: 'depth.rolled',
} as const;
export const kvManySql = (keys: readonly string[]) => `SELECT key, value FROM kv WHERE key IN (${keys.map(() => '?').join(',')})`;
