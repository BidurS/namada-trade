// Every statement the digest's figures read, as the data map of 2026-10-23 measured them on production (each on an
// index: sqlite_autoindex_metrics_1, flows_kind, flows_to, flows_from, unbond_queue's rowid, kv's primary key,
// kv_alert_claim_time; validator_daily is the one table scanned, 984 rows, because its primary key leads with the
// validator). All parameters are bound; no value is ever interpolated. The guards are flows-query.ts's own
// (NAM_AMOUNT: a row of another coin carries meta.tokenSymbol; NOT_LEGACY_TWIN: the older twin of a transfer an
// earlier parser build wrote under its inner hash), so the digest counts what the moves list counts.
import { NAM_AMOUNT, NOT_LEGACY_TWIN } from '../flows-query';
import { NAMADA, OSMOSIS } from '../config';

/** The MASP shielded pool's address (a public protocol constant, config.ts NAMADA.internal). */
export const MASP_ADDRESS = NAMADA.internal.masp;

/** The kv rows every digest reads in one statement (PK lookups), beside the twelve the spec lists: source.health
 *  (the balance listing's and the indexer's rows decide two "not read" cases). intel.cache is about 44 KB. */
export const ANCHOR_KV_KEYS = [
  'namada.cursor', 'namada.head', 'osmosis.live', 'osmosis.cursor', 'bond.listing', 'balance.listing', 'chain.params',
  'intel.cache', 'holders.figures', 'osmosis.holders.pass', 'unbond.queue.hash', 'namada.bonds.live', 'namada.unbonds.live', 'source.health',
] as const;

const marks = (n: number) => Array.from({ length: n }, () => '?').join(', ');

/** The trades read is bounded at the newest DIGEST_TRADES_MAX rows; one more says the window held more. */
export const DIGEST_TRADES_MAX = 20_000;
/** A move's flow claim and its crossing's claim are taken within this of each other (one dispatch, two D1 writes). */
export const CLAIM_PAIR_MS = 5_000;


/**
 * How a priced trade's dollar price was set, in SQL: shared/flow-rules.ts priceHowOf's rule (meta.priceSource, else a
 * USDC trade whose price is its own USDC per NAM is 'execution', else 'unstated'); NULL for a trade with no dollar value.
 */
const PRICE_HOW_SQL = `(CASE WHEN value_usd IS NULL THEN NULL
    WHEN json_extract(meta,'$.priceSource') IN ('execution','swap_1h','spot','pool_1h') THEN json_extract(meta,'$.priceSource')
    WHEN counter_denom = 'USDC' AND counter_amount > 0 AND amount_num > 0 AND price_usd IS NOT NULL
      AND ABS(counter_amount / amount_num - price_usd) <= counter_amount / amount_num * 1e-6 THEN 'execution'
    ELSE 'unstated' END)`;

export const SQL = {
  /** latest(key, t): the last reading at or before t (sqlite_autoindex_metrics_1, 1 row, ~1 ms) */
  latest: 'SELECT ts, value FROM metrics WHERE key = ? AND ts <= ? ORDER BY ts DESC LIMIT 1',
  /** the reading at exactly t (the hour's trade count beside the hour's median) */
  at: 'SELECT ts, value FROM metrics WHERE key = ? AND ts = ? LIMIT 1',
  /** the series' first row, run only when a base is missing (PK, 1 row) */
  firstTs: 'SELECT MIN(ts) first_ts FROM metrics WHERE key = ?',
  /** the kv anchors (PK lookups) */
  anchors: `SELECT key, value, updated_at FROM kv WHERE key IN (${marks(ANCHOR_KV_KEYS.length)})`,
  /** one listing's row by its time (INTEGER PRIMARY KEY): height and provider of a listing-stamped reading */
  listingAt: 'SELECT at, kind, height, provider FROM listings WHERE at = ?',
  /** the current epoch's first reading in the last two epochs (a PK range of about 720 minute rows, filtered on value; spec 5.3) */
  epochAnchor: "SELECT MIN(ts) started FROM metrics WHERE key = 'epoch' AND ts > ? AND ts <= ? AND value = ?",
  /** the last reading of an earlier epoch in the same range (the same PK range, 1 row kept): the anchor's error is the
   *  gap between the two, and without such a reading the epoch began before the range and the anchor is not trusted */
  epochBefore: "SELECT ts before_ts, value before_value FROM metrics WHERE key = 'epoch' AND ts > ? AND ts <= ? AND value <> ? ORDER BY ts DESC LIMIT 1",

  /** bond and unbond requests, withdrawals and reward claims in [from, to) by kind (flows_kind, one range per kind) */
  posByKind: `SELECT f.kind, COUNT(*) n, SUM(f.amount_num) nam, MAX(f.amount_num) largest, MIN(f.ts) first_ts, MAX(f.ts) last_ts,
           SUM(CASE WHEN json_extract(f.meta,'$.via') IN ('late scan','catch-up search') THEN 1 ELSE 0 END) late
    FROM flows f INDEXED BY flows_kind
    WHERE f.kind IN ('bond','unbond','withdraw','rewards') AND f.chain = 'namada' AND f.ts >= ? AND f.ts < ?
      AND ${NAM_AMOUNT} AND ${NOT_LEGACY_TWIN}
    GROUP BY f.kind`,
  /** the earliest of the largest requests of one kind in the window (flows_kind; the ORDER BY sorts the window's rows; the id breaks a tie at the same time) */
  posLargest: `SELECT f.id, f.tx_hash, f.ts, f.height, f.amount_num, json_extract(f.meta,'$.validator') validator, json_extract(f.meta,'$.innerTxHash') inner_hash, json_extract(f.meta,'$.wrapper') wrapper
    FROM flows f INDEXED BY flows_kind
    WHERE f.kind = ? AND f.chain = 'namada' AND f.ts >= ? AND f.ts < ? AND ${NAM_AMOUNT} AND ${NOT_LEGACY_TWIN}
    ORDER BY f.amount_num DESC, f.ts ASC, f.id ASC LIMIT 1`,
  /** how many requests of one kind share the largest amount, and to how many validators (the window's rows grouped by amount, the top group) */
  posLargestTie: `SELECT f.amount_num, COUNT(*) n, COUNT(DISTINCT json_extract(f.meta,'$.validator')) validators
    FROM flows f INDEXED BY flows_kind
    WHERE f.kind = ? AND f.chain = 'namada' AND f.ts >= ? AND f.ts < ? AND ${NAM_AMOUNT} AND ${NOT_LEGACY_TWIN}
    GROUP BY f.amount_num ORDER BY f.amount_num DESC LIMIT 1`,
  /** NAM withdrawn in (after, upTo] between two listings (flows_kind) */
  withdrawnBetween: `SELECT COALESCE(SUM(f.amount_num),0) nam, COUNT(*) n FROM flows f INDEXED BY flows_kind
    WHERE f.kind = 'withdraw' AND f.chain = 'namada' AND f.ts > ? AND f.ts <= ? AND ${NAM_AMOUNT} AND ${NOT_LEGACY_TWIN}`,

  /** the oldest epoch still in the queue (the rowid's first entry, 1 row): the standing pile's first epoch */
  queueFirst: 'SELECT MIN(withdraw_epoch) e FROM unbond_queue',
  /** the queue's sum over the epochs in (from, to] (INTEGER PRIMARY KEY range) */
  queueSum: 'SELECT COALESCE(SUM(nam),0) nam, COALESCE(SUM(n),0) n FROM unbond_queue WHERE withdraw_epoch > ? AND withdraw_epoch <= ?',
  /** the buckets unlocking in (from, to] (INTEGER PRIMARY KEY range) */
  queueRange: 'SELECT withdraw_epoch, nam, n FROM unbond_queue WHERE withdraw_epoch > ? AND withdraw_epoch <= ? ORDER BY withdraw_epoch',
  /** the next bucket after an epoch (INTEGER PRIMARY KEY range, 1 row) */
  queueNext: 'SELECT withdraw_epoch, nam, n FROM unbond_queue WHERE withdraw_epoch > ? ORDER BY withdraw_epoch LIMIT 1',

  /** the trusted trades of the window: single-pool NAM/USDC swaps of at least 50 NAM (cron.ts SINGLE_POOL_USDC_SWAP's rule; flows_kind) */
  trusted: `SELECT COUNT(*) n, SUM(counter_amount) / SUM(amount_num) vwap, MIN(counter_amount / amount_num) lo, MAX(counter_amount / amount_num) hi, MAX(ts) last_ts
    FROM flows INDEXED BY flows_kind
    WHERE kind IN ('buy','sell') AND chain = 'osmosis' AND counter_denom = 'USDC' AND amount_num >= 50 AND counter_amount > 0
      AND pool_id IN (${OSMOSIS.pricePoolIds.map((p) => `'${p}'`).join(',')}) AND ts >= ? AND ts < ?`,
  /** the window's trades, bots out (meta.arb true, series.dayAggregates's rule), the newest DIGEST_TRADES_MAX + 1 at most (flows_kind) */
  trades: `SELECT COUNT(*) n, SUM(amount_num) nam, SUM(value_usd) usd, SUM(CASE WHEN value_usd IS NULL THEN 1 ELSE 0 END) unpriced,
           TOTAL(how = 'execution') how_execution, TOTAL(how = 'pool_1h') how_pool_1h, TOTAL(how = 'spot') how_spot, TOTAL(how = 'swap_1h') how_swap_1h, TOTAL(how = 'unstated') how_unstated,
           COUNT(DISTINCT COALESCE(json_extract(meta,'$.trader'), CASE WHEN kind = 'buy' THEN to_addr ELSE from_addr END)) traders,
           SUM(CASE WHEN kind = 'buy' THEN amount_num ELSE 0 END) buy_nam, SUM(CASE WHEN kind = 'sell' THEN amount_num ELSE 0 END) sell_nam, MAX(ts) last_ts
    FROM (SELECT kind, amount_num, value_usd, meta, to_addr, from_addr, ts, ${PRICE_HOW_SQL} how FROM flows INDEXED BY flows_kind
          WHERE kind IN ('buy','sell') AND chain = 'osmosis' AND ts >= ? AND ts < ? AND (meta IS NULL OR meta NOT LIKE '%"arb":true%')
          ORDER BY ts DESC LIMIT ${DIGEST_TRADES_MAX + 1})`,

  /** The newest closed hour of the depth store's aggregate row (pool_id 'all', one primary-key seek): what selling the
   *  quotable size fetched across every pool (sell_10k is the column of DEPTH_QUOTABLE_SIZE, 10,000 base coins; the
   *  digest test holds the two together) and the USD of bids within 10 % of the reference price (bid_10). */
  depthHour: `SELECT hour, at, height, sell_10k, bid_10, n, note FROM depth_hourly WHERE pool_id = ? AND hour <= ? ORDER BY hour DESC LIMIT 1`,
  /** The window's hourly rows of the aggregate (one primary-key range): the lowest and highest sell_10k of the window,
   *  the hours the two were taken over (n counts the rows whose sell_10k_lo is not NULL, the ones MIN and MAX read; an
   *  hour whose reference pool was not read has none) and the rows stored in the window. */
  depthDay: `SELECT MIN(sell_10k_lo) lo, MAX(sell_10k_hi) hi, COUNT(sell_10k_lo) n, COUNT(*) stored
    FROM depth_hourly WHERE pool_id = ? AND hour >= ? AND hour < ?`,

  /** the bridge crossings the Osmosis records show in the window (the side the series trusts; flows_kind) */
  bridge: `SELECT f.kind, COUNT(*) n, SUM(f.amount_num) nam, MAX(f.amount_num) largest,
           SUM(CASE WHEN json_extract(f.meta,'$.via') = 'catch-up search' THEN 1 ELSE 0 END) late
    FROM flows f INDEXED BY flows_kind
    WHERE f.kind IN ('ibc_in','ibc_out') AND f.chain = 'osmosis' AND f.ts >= ? AND f.ts < ? AND ${NAM_AMOUNT}
    GROUP BY f.kind`,
  /** bridge refunds on Osmosis from the window's start to three days after its end (series-sql.ts REFUNDS_SQL's shape; flows_kind) */
  refunds: `SELECT id, ts, from_addr, to_addr, amount_num, meta FROM flows INDEXED BY flows_kind
    WHERE kind = 'other' AND chain = 'osmosis' AND ts >= ? AND ts < ? AND meta LIKE '%"ibcTimeoutRefund":true%'`,
  /** the window's Osmosis → Namada sends one by one, read only when a refund exists, to take the refunded ones out (flows_kind) */
  bridgeOuts: `SELECT f.id, f.ts, f.from_addr, f.to_addr, f.amount_num, f.meta FROM flows f INDEXED BY flows_kind
    WHERE f.kind = 'ibc_out' AND f.chain = 'osmosis' AND f.ts >= ? AND f.ts < ? AND ${NAM_AMOUNT} ORDER BY f.ts DESC LIMIT 2001`,

  /** NAM into the shielded pool by kind. chain = 'namada' is the double-count guard: the flows_to range on the MASP
   *  address also returns Osmosis rows (ibc_out with the MASP address as the packet's receiver). */
  maspIn: `SELECT f.kind, COUNT(*) n, SUM(f.amount_num) nam FROM flows f INDEXED BY flows_to
    WHERE f.to_addr = ? AND f.chain = 'namada' AND f.ts >= ? AND f.ts < ? AND ${NAM_AMOUNT} AND ${NOT_LEGACY_TWIN} GROUP BY f.kind`,
  /** NAM out of the shielded pool by kind, with the NAM fee the pool paid on each (chain = 'namada': the same guard) */
  maspOut: `SELECT f.kind, COUNT(*) n, SUM(f.amount_num) nam, SUM(COALESCE(json_extract(f.meta,'$.maspFeeNam'), 0)) fee_nam FROM flows f INDEXED BY flows_from
    WHERE f.from_addr = ? AND f.chain = 'namada' AND f.ts >= ? AND f.ts < ? AND ${NAM_AMOUNT} AND ${NOT_LEGACY_TWIN} GROUP BY f.kind`,
  /** the NAM fees the pool paid on moves of other coins (rows with tokenSymbol whose maspFeeNam is NAM), as series.dayAggregates adds them */
  maspOtherCoinFees: `SELECT COUNT(*) n, SUM(COALESCE(json_extract(f.meta,'$.maspFeeNam'), 0)) fee_nam FROM flows f INDEXED BY flows_from
    WHERE f.from_addr = ? AND f.chain = 'namada' AND f.ts >= ? AND f.ts < ? AND f.meta LIKE '%"tokenSymbol":%' AND ${NOT_LEGACY_TWIN}`,

  /** the 20 newest proposals the intel cache holds (kv PK + json_each) */
  proposals: `SELECT json_extract(j.value,'$.id') id, json_extract(j.value,'$.status') status, json_extract(j.value,'$.type') type,
           json_extract(j.value,'$.startEpoch') startEpoch, json_extract(j.value,'$.endEpoch') endEpoch, substr(json_extract(j.value,'$.title'),1,80) title,
           json_extract(j.value,'$.discussionsUrl') discussionsUrl,
           json_extract(kv.value,'$.fetchedAt') fetchedAt, json_extract(kv.value,'$.indexerEpoch') indexerEpoch
    FROM kv, json_each(kv.value,'$.proposals') j WHERE kv.key = 'intel.cache' ORDER BY id DESC LIMIT 20`,
  /** the governance alert claims taken in [from, to): the only timestamped record of a status change (kv_alert_claim_time; its WHERE verbatim) */
  govClaims: `SELECT key, updated_at FROM kv INDEXED BY kv_alert_claim_time
    WHERE key >= 'alert:' AND key < 'alert;' AND updated_at >= ? AND updated_at < ? AND key LIKE 'alert:gov:prop:%'`,

  /** the validator snapshot days compared (a SCAN of validator_daily: its primary key leads with the validator) */
  vdDays: `SELECT day, COUNT(*) validators, SUM(stake) stake, SUM(delegators) delegators, MIN(as_of) as_of, MAX(height) height, MAX(names_at) names_at
    FROM validator_daily WHERE day IN (?, ?) GROUP BY day`,
  /** the two newest snapshot days, read only when today's rows do not exist yet */
  vdNewestDays: 'SELECT DISTINCT day FROM validator_daily ORDER BY day DESC LIMIT 2',
  /** the oldest snapshot day, read only when the weekly's base day does not exist yet */
  vdOldestDay: 'SELECT MIN(day) day FROM validator_daily',
  /** the five largest stake moves between the base day (?1) and the day (?2) */
  vdMoves: `SELECT a.validator, a.name, a.state, a.stake s_today, b.stake s_yday, a.stake - COALESCE(b.stake, 0) d, a.delegators d_today, b.delegators d_yday
    FROM validator_daily a LEFT JOIN validator_daily b ON b.validator = a.validator AND b.day = ?
    WHERE a.day = ? ORDER BY ABS(a.stake - COALESCE(b.stake, 0)) DESC LIMIT 5`,
  /** joined (in the day, not the base day), left (in the base day, not the day) and the gross |change| over the join */
  vdSets: `SELECT (SELECT COUNT(*) FROM validator_daily a WHERE a.day = ?1 AND NOT EXISTS (SELECT 1 FROM validator_daily b WHERE b.day = ?2 AND b.validator = a.validator)) joined,
           (SELECT COUNT(*) FROM validator_daily b WHERE b.day = ?2 AND NOT EXISTS (SELECT 1 FROM validator_daily a WHERE a.day = ?1 AND a.validator = b.validator)) left_,
           (SELECT SUM(ABS(a.stake - COALESCE(b.stake, 0))) FROM validator_daily a LEFT JOIN validator_daily b ON b.validator = a.validator AND b.day = ?2 WHERE a.day = ?1) gross`,
  /** validators whose state changed between the base day (?1) and the day (?2) */
  vdStates: `SELECT a.validator, a.name, b.state s_from, a.state s_to FROM validator_daily a JOIN validator_daily b ON b.validator = a.validator AND b.day = ?
    WHERE a.day = ? AND a.state IS NOT b.state`,

  // ---- the operator embed (spec section 8)
  /** the health log's entries in the window (kv PK + json_each), with the count of a name's older entries let go (cron.ts keepHealthLog) */
  healthLog: `SELECT json_extract(e.value,'$.name') name, json_extract(e.value,'$.at') at, json_extract(e.value,'$.ok') ok, json_extract(e.value,'$.note') note,
      json_extract(e.value,'$.cut') cut, json_extract(e.value,'$.cutFrom') cut_from
    FROM kv, json_each(kv.value) e WHERE kv.key = 'source.health.log' AND json_extract(e.value,'$.at') >= ? ORDER BY name, at`,
  /** the current state of every source (kv PK + json_each) */
  health: `SELECT j.key name, json_extract(j.value,'$.ok') ok, json_extract(j.value,'$.at') at, json_extract(j.value,'$.note') note
    FROM kv, json_each(kv.value) j WHERE kv.key = 'source.health' ORDER BY ok, name`,
  /** every check's latest status, and the cadence a check that runs less often states (freshness.ts checkStaleMs) */
  checks: "SELECT key, status, checked_at, CASE WHEN json_valid(detail) THEN json_extract(detail, '$.everyMs') END every_ms FROM checks",
  /**
   * The alert claims taken in [from, to) by prefix (kv_alert_claim_time; its WHERE verbatim), counted as posts: a move
   * is one claim of its flow id (alert:flow:<id>, a primary-key join to flows for its kind); a NAM bridge crossing is
   * also claimed per channel (alert:ibc:<channel>:<sequence>:<channel digest>), so it is counted once by its crossing
   * and never as a post of its own; the record of a crossing that claims its flow id while the crossing is already
   * claimed (no crossing claim within CLAIM_PAIR_MS of its own) is not posted again and is left out; the older second
   * key a move once took beside its own (alert:tx:<hash>) is no post either. A forum or governance alert claims its
   * operator's post apart (<key>:op) from its subscribers' (<key>): one alert, counted once. A digest is counted by its
   * period's key (alert:digest:daily:<date>, alert:digest:weekly:<week>); its per-channel claims under it are no
   * posts of their own.
   */
  claims: `SELECT
      SUM(CASE WHEN c.key LIKE 'alert:flow:%' THEN 1 ELSE 0 END) moves,
      SUM(CASE WHEN c.key LIKE 'alert:flow:%' AND f.kind IN ('ibc_in', 'ibc_out') AND NOT EXISTS (
            SELECT 1 FROM kv k2 INDEXED BY kv_alert_claim_time WHERE k2.key >= 'alert:' AND k2.key < 'alert;'
              AND k2.updated_at >= c.updated_at - ${CLAIM_PAIR_MS} AND k2.updated_at <= c.updated_at + ${CLAIM_PAIR_MS} AND k2.key LIKE 'alert:ibc:%')
          THEN 1 ELSE 0 END) crossing_repeats,
      COUNT(DISTINCT CASE WHEN c.key LIKE 'alert:ibc:%' THEN (CASE WHEN substr(c.key, -33, 1) = ':' THEN substr(c.key, 1, length(c.key) - 33) ELSE c.key END) END) crossings,
      COUNT(DISTINCT CASE WHEN c.key LIKE 'alert:gov:%' THEN (CASE WHEN c.key LIKE '%:op' THEN substr(c.key, 1, length(c.key) - 3) ELSE c.key END) END) governance,
      COUNT(DISTINCT CASE WHEN c.key LIKE 'alert:forum:%' THEN (CASE WHEN c.key LIKE '%:op' THEN substr(c.key, 1, length(c.key) - 3) ELSE c.key END) END) forum,
      SUM(CASE WHEN c.key LIKE 'alert:digest:%' AND c.key NOT LIKE 'alert:digest:%:%:%' THEN 1 ELSE 0 END) digests, SUM(CASE WHEN c.key LIKE 'alert:tx:%' THEN 1 ELSE 0 END) second_keys,
      SUM(CASE WHEN c.key NOT LIKE 'alert:flow:%' AND c.key NOT LIKE 'alert:ibc:%' AND c.key NOT LIKE 'alert:tx:%' AND c.key NOT LIKE 'alert:gov:%'
            AND c.key NOT LIKE 'alert:forum:%' AND c.key NOT LIKE 'alert:digest:%' THEN 1 ELSE 0 END) other,
      MIN(c.updated_at) first_at, MAX(c.updated_at) last_at
    FROM kv c INDEXED BY kv_alert_claim_time LEFT JOIN flows f ON c.key LIKE 'alert:flow:%' AND f.id = substr(c.key, 12)
    WHERE c.key >= 'alert:' AND c.key < 'alert;' AND c.updated_at >= ? AND c.updated_at < ?`,
  /** the operator's kv rows: the last digest's delivery record and the posts not sent (PK lookups) */
  operatorKv: "SELECT key, value, updated_at FROM kv WHERE key IN ('digest.last', 'digest.last.weekly', 'alerts.skipped')",
  /** whether a digest key was claimed (PK lookups, one row per key given) */
  digestClaims: (n: number) => `SELECT key, updated_at FROM kv WHERE key IN (${marks(n)})`,

  // ---- the per-user watchlists (spec 5.11)
  /** the current spendable balance of watched addresses on one chain (PK (chain, address): one seek each) */
  watchHolders: (n: number) => `SELECT address, balance_num, verified_at, verified_src, updated_at FROM holders WHERE chain = ? AND address IN (${marks(n)})`,
  /** the balance reading that contained the base instant (PK (chain, address, from_ts): one seek each) */
  watchSpans: (n: number) => `SELECT address, balance_num, from_ts, to_ts FROM balance_spans WHERE chain = ? AND address IN (${marks(n)}) AND from_ts <= ? AND to_ts >= ?`,
  /** the balance listing's record: the confirmation time a Namada row the listing wrote falls back to (holders.ts confirmedAt) */
  watchKv: "SELECT key, value FROM kv WHERE key = 'balance.listing'",
} as const;
