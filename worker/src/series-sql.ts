// Every statement the series writers (worker/src/series.ts) run, as a string, with what it costs. Costs are D1 rows
// read / written as measured on the stand-in with the plan's seed or read off production on 2026-10-20 (the plan's
// [cost] lens, docs/design/screener-plan.md 5.5); a metrics or flow_edges row costs 2 rows written (row + primary
// key), a row of a table with one more index 3.
//
// Reads served to the API later (SERIES_READS) are primary-key ranges: their EXPLAIN QUERY PLAN must show SEARCH on
// the primary key or an index and never a temporary B-tree (test/series.test.ts checks every one). The daily
// snapshot aggregates (HOLDER_COHORTS_*, COHORT_*) are whole-table passes by nature and run once a day in the cron,
// never on a request.
import { HOLDERS_UNION, INTERNAL_ADDRS, OSMOSIS_PASS_KV, OSMOSIS_READ_AT_SQL, notPool, stakeNum } from './holders';
import { NOT_LEGACY_TWIN } from './flows-query';

const H = 3600000;

// ---------------------------------------------------------------- hourly

/** Keys rolled up per closed hour into `<key>.1h` (last reading of the hour), `.1h.lo` and `.1h.hi`. */
export const ROLLUP_KEYS = ['price.usd', 'dex.liquidity_usd', 'supply.total_stake', 'supply.masp_shielded'] as const;

/**
 * One closed hour's minute rows of the rolled-up keys: per key the lowest, the highest, how many, and the last
 * reading. ?1..?4 the keys, ?5 the hour's start, ?6 its end. Reads at most 4 × 60 rows (+4 for the last values);
 * the writes are 3 metrics rows per key that had a reading (24 rows written an hour, 576 a day).
 */
export const ROLLUP_HOUR_SQL = `SELECT g.key, g.lo, g.hi, g.n, (SELECT x.value FROM metrics x WHERE x.key = g.key AND x.ts = g.last_ts) AS last
  FROM (SELECT key, MIN(value) lo, MAX(value) hi, COUNT(*) n, MAX(ts) last_ts FROM metrics
        WHERE key IN (?1, ?2, ?3, ?4) AND ts >= ?5 AND ts < ?6 GROUP BY key) g`;

/**
 * The executed swaps of one hour (Osmosis buys and sells; the flows_kind index): for the median price exactly as
 * cron.ts phase 3 (SINGLE_POOL_USDC_SWAP, filtered in series.swapHourStmts) and for the hour's volume keys. Today
 * 0 to about 400 rows an hour (sorted by time in code); written: about 16 metrics rows per hour with a trade (none for an hour
 * without one).
 */
export const SWAP_HOUR_SQL = `SELECT id, ts, kind, amount_num, counter_denom, counter_amount, pool_id, value_usd, from_addr, to_addr, meta
  FROM flows WHERE kind IN ('buy', 'sell') AND chain = 'osmosis' AND ts >= ? AND ts < ?`;

/**
 * Osmosis holders now (as the holder list, protocol and pool accounts left out), the oldest reading among them
 * (holders.ts OSMOSIS_READ_AT_SQL) and the stored pass record (kv osmosis.holders.pass): series.ts stamps the count
 * as the holder figures are stamped (holders.ts osmosisStamp), no later than the start of the last pass of the bank's
 * list that added up to the supply, so a pass that did not add up never makes the series current either.
 */
export const OSMOSIS_HOLDERS_SQL = `SELECT COUNT(*) n, (${OSMOSIS_READ_AT_SQL}) at, (SELECT value FROM kv WHERE key = '${OSMOSIS_PASS_KV}') pass
  FROM holders WHERE chain = 'osmosis' AND balance_num > 0 AND address NOT IN (${INTERNAL_ADDRS.map((a) => `'${a}'`).join(',')}) AND ${notPool('holders.address')}`;

/** pool_hourly: one row per pool per hour (12 parameters; 2 rows written each, about 28 pools: 1,344 a day). */
export const POOL_HOURLY_SQL = `INSERT OR REPLACE INTO pool_hourly (hour, pool_id, at, liquidity_usd, nam_reserve, counter_reserve, spread,
  volume_24h_usd_osmosis, volume_7d_usd_osmosis, liquidity_usd_osmosis, osmosis_at, trades, nam) VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)`;

// ---------------------------------------------------------------- daily: the flow index

/**
 * One UTC day of flows on both chains with the label category of each side (flows_ts index, labels by primary key),
 * older twins left out. 4 to 515 rows a day on production (2026-10-20), under 10 ms.
 */
export const DAY_FLOWS_SQL = `SELECT f.id, f.chain, f.ts, f.kind, f.from_addr, f.to_addr, f.amount_num, f.value_usd, f.meta,
    lf.category AS from_label_cat, lt.category AS to_label_cat, lf.source AS from_label_src, lt.source AS to_label_src
  FROM flows f LEFT JOIN labels lf ON lf.address = f.from_addr LEFT JOIN labels lt ON lt.address = f.to_addr
  WHERE f.ts >= ? AND f.ts < ? AND ${NOT_LEGACY_TWIN}`;

/** Bridge refunds on Osmosis from the day's start to three days after its end (a refund follows its send by at most 3 days: analytics.ts timedOutSends). */
export const REFUNDS_SQL = `SELECT id, ts, from_addr, to_addr, amount_num, meta FROM flows
  WHERE kind = 'other' AND chain = 'osmosis' AND ts >= ? AND ts < ? AND meta LIKE '%"ibcTimeoutRefund":true%'`;

/** A day's edges are replaced whole (an edge that no longer exists must not stay): 1 read pass over at most ~40 rows. */
export const DELETE_EDGES_DAY_SQL = `DELETE FROM flow_edges_daily WHERE day = ?`;
/**
 * One edge of one chain's records. A bridge move is recorded on both chains (sent on one, received on the other), so
 * the same NAM is an `ibc_out` edge on one chain and an `ibc_in` edge on the other: the rows of the two chains must
 * never be added together (a reader sums one chain, or names both separately; the daily bridge keys use the Osmosis
 * records only, series.dayAggregates).
 */

export const EDGE_SQL = `INSERT OR REPLACE INTO flow_edges_daily (day, chain, kind, from_cat, to_cat, n, nam, usd) VALUES (?,?,?,?,?,?,?,?)`;
export const ACTIVITY_SQL = `INSERT OR REPLACE INTO activity_daily (day, chain, flows, senders, receivers, active, nam, trades, traders, chain_txs) VALUES (?,?,?,?,?,?,?,?,?,NULL)`;

/** The last minute reading of the shielded pool's balance in [?1, ?2): the daily series' value for that day. */
export const LAST_IN_RANGE_SQL = `SELECT ts, value FROM metrics WHERE key = ? AND ts >= ? AND ts < ? ORDER BY ts DESC LIMIT 1`;

// ---------------------------------------------------------------- daily: the snapshots

/** The size line a holding falls in (spendable + staked, NAM). */
export const BUCKET_SQL = (t: string) => `CASE WHEN ${t} >= 10000000 THEN '10m+' WHEN ${t} >= 1000000 THEN '1m-10m' WHEN ${t} >= 100000 THEN '100k-1m'
  WHEN ${t} >= 10000 THEN '10k-100k' WHEN ${t} >= 1000 THEN '1k-10k' WHEN ${t} >= 1 THEN '1-1k' ELSE 'under1' END`;
export const BUCKETS = ['10m+', '1m-10m', '100k-1m', '10k-100k', '1k-10k', '1-1k', 'under1'] as const;

/**
 * Namada holders by size: the holder list's union (spendable from holders, staked from stakes with the list's stake
 * rule) joined back to both tables. A whole pass: 744 ms and 582,782 rows read on production (2026-10-20, trader lens
 * finding 1); once a day. Writes 7 rows (14 rows written).
 */
export const HOLDER_COHORTS_NAMADA_SQL = `SELECT bucket, COUNT(*) holders, SUM(sp + st) nam, SUM(sp) spendable, SUM(st) staked FROM (
    SELECT sp, st, ${BUCKET_SQL('sp + st')} bucket FROM (
      SELECT COALESCE(h.balance_num, 0) sp, ${stakeNum('s.')} st
      FROM (${HOLDERS_UNION}) x
      LEFT JOIN holders h ON h.chain = 'namada' AND h.address = x.address LEFT JOIN stakes s ON s.address = x.address
      WHERE x.chain = 'namada'))
  GROUP BY bucket`;

/** Osmosis holders by size (spendable only: NAM on Osmosis cannot be staked, so `staked` is a true 0 there). ~1,300 rows. */
export const HOLDER_COHORTS_OSMOSIS_SQL = `SELECT bucket, COUNT(*) holders, SUM(sp) nam, SUM(sp) spendable, 0 staked FROM (
    SELECT balance_num sp, ${BUCKET_SQL('balance_num')} bucket FROM holders
    WHERE chain = 'osmosis' AND balance_num > 0 AND address NOT IN (${INTERNAL_ADDRS.map((a) => `'${a}'`).join(',')}) AND ${notPool('holders.address')})
  GROUP BY bucket`;

/** Genesis categories the cohort table follows. */
export const COHORT_CATEGORIES = ['backer', 'foundation', 'genesis'] as const;

/**
 * The genesis cohorts: every address labelled from the genesis files, by category, with what it holds now. 162 to
 * 181 ms and 17,184 rows read on production (VC lens); once a day, 3 rows (6 written).
 */
export const COHORT_LABELLED_SQL = `SELECT l.category, COUNT(*) addrs, SUM(CASE WHEN sp + st > 0 THEN 1 ELSE 0 END) addrs_with_nam, SUM(sp) spendable, SUM(st) staked FROM (
    SELECT l.category, COALESCE(h.balance_num, 0) sp, ${stakeNum('s.')} st FROM labels l
    LEFT JOIN holders h ON h.chain = 'namada' AND h.address = l.address LEFT JOIN stakes s ON s.address = l.address
    WHERE l.source = 'genesis' AND l.category IN (${COHORT_CATEGORIES.map((c) => `'${c}'`).join(',')})) l
  GROUP BY l.category`;

/** 'none' (every other Namada holder) is the Namada size lines' totals minus the labelled cohorts' holders (series.noneCohort): no second pass. */
export const HOLDER_COHORT_ROW_SQL = `INSERT OR REPLACE INTO holder_cohorts_daily (day, chain, bucket, holders, nam, spendable, staked, as_of) VALUES (?,?,?,?,?,?,?,?)`;
export const COHORT_ROW_SQL = `INSERT OR REPLACE INTO cohort_daily (day, category, addrs, addrs_with_nam, spendable, staked, as_of) VALUES (?,?,?,?,?,?,?)`;

// ---------------------------------------------------------------- the listing hooks

/** Stakers as the holder list counts them (the bond listing's figure; the estimate only before any listing). About 19,500 rows, once per complete balance listing. */
export const STAKERS_SQL = `SELECT address, ${stakeNum('')} st FROM stakes WHERE ${stakeNum('')} > 0`;
export const LISTING_ROW_SQL = `INSERT OR REPLACE INTO listings (at, kind, height, provider) VALUES (?,?,?,?)`;
/**
 * The unbond queue is written per withdraw epoch when a listing changes it (series.unbondQueueDiffStmts): the stored
 * rows are read (642 epochs on production on 2026-10-20, so a whole rewrite was 1,286 rows written in about 650
 * statements), and only epochs whose NAM or entry count changed are upserted, UNBOND_QUEUE_ROWS a statement (5
 * parameters a row: D1 binds at most 100), and epochs the listing no longer has are deleted. A listing usually
 * changes a handful of epochs: one or two statements, in one atomic batch with the queue's hash.
 */
export const UNBOND_QUEUE_STORED_SQL = `SELECT withdraw_epoch, nam, n FROM unbond_queue`;
export const UNBOND_QUEUE_ROWS = 20;
export const unbondQueueUpsertSql = (rows: number) =>
  `INSERT OR REPLACE INTO unbond_queue (withdraw_epoch, nam, n, listed_at, height) VALUES ${Array.from({ length: rows }, () => '(?,?,?,?,?)').join(',')}`;
export const unbondQueueDeleteSql = (epochs: number) => `DELETE FROM unbond_queue WHERE withdraw_epoch IN (${Array.from({ length: epochs }, () => '?').join(',')})`;
/** The previous complete balance listing this worker recorded (the listings table, migration 0007): the new / emptied counts compare against it only. */
export const PREV_BALANCE_LISTING_SQL = `SELECT MAX(at) at FROM listings WHERE kind = 'balance' AND at < ?`;
/** The newest stored pool price hour (metrics primary key): the hourly job writes every closed hour after it. */
export const LAST_POOL_PRICE_SQL = `SELECT MAX(ts) t FROM metrics WHERE key = 'price.pool_1h'`;

/** Per validator, once a day (about 250 rows, 500 written). */
export const VALIDATOR_ROW_SQL = `INSERT OR REPLACE INTO validator_daily (day, validator, stake, delegators, commission, state, name, as_of, height, names_at) VALUES (?,?,?,?,?,?,?,?,?,?)`;

// ---------------------------------------------------------------- the API's range reads (W3), checked with EXPLAIN

/** Range reads of the series tables, each on its primary key: ?1.. the dimensions, then the day (or hour) range. */
export const SERIES_READS = {
  pool_hourly: `SELECT * FROM pool_hourly WHERE pool_id = ? AND hour BETWEEN ? AND ? ORDER BY hour`,
  holder_cohorts_daily: `SELECT * FROM holder_cohorts_daily WHERE chain = ? AND bucket = ? AND day BETWEEN ? AND ? ORDER BY day`,
  cohort_daily: `SELECT * FROM cohort_daily WHERE category = ? AND day BETWEEN ? AND ? ORDER BY day`,
  flow_edges_daily: `SELECT * FROM flow_edges_daily WHERE day BETWEEN ? AND ? ORDER BY day`,
  activity_daily: `SELECT * FROM activity_daily WHERE chain = ? AND day BETWEEN ? AND ? ORDER BY day`,
  validator_daily: `SELECT * FROM validator_daily WHERE validator = ? AND day BETWEEN ? AND ? ORDER BY day`,
  unbond_queue: `SELECT * FROM unbond_queue WHERE withdraw_epoch BETWEEN ? AND ? ORDER BY withdraw_epoch`,
  listings: `SELECT * FROM listings WHERE at BETWEEN ? AND ? ORDER BY at`,
  metric_range: `SELECT ts, value FROM metrics WHERE key = ? AND ts BETWEEN ? AND ? ORDER BY ts`,
} as const;

export const HOUR_MS = H;
