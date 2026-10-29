// The depth statements (migration 0013): the minute row, the kv rows and the retention delete. Every REAL column is
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

/** A kv row, the value already a string or made one. */
export const kvStmt = (key: string, value: unknown, at: number): Stmt => stmt.kvSet(key, typeof value === 'string' ? value : JSON.stringify(value), at);

/** Copy one kv row onto another key in one statement (depth.states becomes depth.prev before the new states are written), with no read. */
export const copyKvStmt = (from: string, to: string): Stmt => ({
  sql: 'INSERT OR REPLACE INTO kv (key, value, updated_at) SELECT ?, value, updated_at FROM kv WHERE key = ?',
  params: [to, from],
});

/** The retention delete (C5): minute rows older than the window, at most `limit` a run, by the primary key's minute. */
export const deleteOldMinutesStmt = (before: number, limit: number): Stmt => ({
  sql: 'DELETE FROM depth_minute WHERE rowid IN (SELECT rowid FROM depth_minute WHERE minute < ? LIMIT ?)',
  params: [before, limit],
});

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
} as const;
export const kvManySql = (keys: readonly string[]) => `SELECT key, value FROM kv WHERE key IN (${keys.map(() => '?').join(',')})`;
