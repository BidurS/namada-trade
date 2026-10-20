-- 2026-10-20. The series tables (docs/design/screener-plan.md 5.2; the plan names this file 0008, 0007 was free).
--
-- Every table here is written by the cron (worker/src/series.ts, statements in worker/src/series-sql.ts) from data
-- the tick already holds or from one primary-key range read, and read by the API as primary-key ranges. A day or an
-- hour the cron did not record stays missing: nothing is filled in later with an estimate, and no figure is 0
-- because it is unknown (an unknown is NULL). `day` is 'YYYY-MM-DD' (UTC) so a range is a string BETWEEN; times are
-- unix ms. The source of every column is named next to it; each table's first row is its honest start.

-- One row per Osmosis pool holding NAM per hour, written once an hour (series.hourly). `at` is when the router's
-- pools answer was read (the depth, reserves and spread columns); `osmosis_at` is the Osmosis data API summary's own
-- update time (`last_update_at`) for its two volume columns and its liquidity column, NULL when that pool is not in
-- the summary or the summary could not be read. `trades` and `nam` are for per-pool swap legs, NULL until the
-- parser records legs (a routed swap names several pools and cannot be split today).
CREATE TABLE IF NOT EXISTS pool_hourly (
  hour INTEGER NOT NULL,                 -- start of the UTC hour (unix ms)
  pool_id TEXT NOT NULL,
  at INTEGER,                            -- time of the Osmosis router (SQS) read; NULL when the router did not list the pool
  liquidity_usd REAL,                    -- SQS liquidity_cap (dollars)
  nam_reserve REAL,                      -- SQS pool balances: NAM
  counter_reserve REAL,                  -- SQS pool balances: the other coin, in its own units
  spread REAL,                           -- SQS spread_factor (the pool's swap fee as a fraction)
  volume_24h_usd_osmosis REAL,           -- Osmosis data API /pairs/v2/summary volume_24h (dollars, priced leg only)
  volume_7d_usd_osmosis REAL,            -- the same summary's volume_7d
  liquidity_usd_osmosis REAL,            -- the same summary's liquidity (dollars, the priced side only)
  osmosis_at INTEGER,                    -- the summary's last_update_at
  trades INTEGER, nam REAL,              -- from swap legs, NULL until legs are recorded
  PRIMARY KEY (pool_id, hour));

-- Holders by size, per chain, once a day (series.daily) from the stored rows the chain listings keep current: Namada
-- spendable from the balance listing and staked from the bond listing (holders.ts HOLDERS_UNION, protocol and pool
-- accounts left out); Osmosis spendable from the Osmosis bank's holder list. `as_of`: the older of the two listings'
-- completion times (Namada) or the holder list's read time (Osmosis). Buckets on spendable + staked: '10m+',
-- '1m-10m', '100k-1m', '10k-100k', '1k-10k', '1-1k', 'under1'. A bucket with no holder that day has no row.
CREATE TABLE IF NOT EXISTS holder_cohorts_daily (
  day TEXT NOT NULL, chain TEXT NOT NULL, bucket TEXT NOT NULL,
  holders INTEGER NOT NULL, nam REAL NOT NULL, spendable REAL NOT NULL, staked REAL NOT NULL, as_of INTEGER NOT NULL,
  PRIMARY KEY (chain, bucket, day));

-- The genesis cohorts once a day (series.daily): labels with source 'genesis' by category ('backer', 'foundation',
-- 'genesis') and 'none' (every Namada holder without such a label). `addrs`: addresses in the cohort (labelled ones,
-- holding or not; for 'none' the holders); `addrs_with_nam`: those holding spendable or staked NAM. Same rows and
-- the same `as_of` as holder_cohorts_daily.
CREATE TABLE IF NOT EXISTS cohort_daily (
  day TEXT NOT NULL, category TEXT NOT NULL,
  addrs INTEGER NOT NULL, addrs_with_nam INTEGER NOT NULL, spendable REAL NOT NULL, staked REAL NOT NULL, as_of INTEGER NOT NULL,
  PRIMARY KEY (category, day));

-- Where NAM moved each day, from the flow index (series.daily, for the closed day, and recomputed the day after for
-- late rows): NAM flows of that day by chain, kind and the category of each side ('genesis', 'backer', 'foundation',
-- 'pool', 'pos', 'masp', 'ibc', 'module', 'user' when unlabelled, 'osmosis' / 'namada' for an address on the other
-- chain, 'unknown' when the row names none). Older twins and other coins are left out, so are bridge sends that
-- timed out and their refunds; bot round trips are kept under kind 'bot' so what was left out can be said. `usd`:
-- the sum of each flow's value at execution, NULL when any flow of the edge has none.
CREATE TABLE IF NOT EXISTS flow_edges_daily (
  day TEXT NOT NULL, chain TEXT NOT NULL, kind TEXT NOT NULL, from_cat TEXT NOT NULL, to_cat TEXT NOT NULL,
  n INTEGER NOT NULL, nam REAL NOT NULL, usd REAL,
  PRIMARY KEY (chain, kind, from_cat, to_cat, day));
CREATE INDEX IF NOT EXISTS flow_edges_day ON flow_edges_daily (day);

-- Activity per chain per day from the flow index (series.daily, as flow_edges_daily): `flows` NAM flows (bots,
-- timed-out sends and refunds left out), `senders` / `receivers` / `active` distinct addresses of that chain in them
-- (protocol and pool accounts left out), `trades` / `traders` Osmosis buys and sells and their distinct makers (bots
-- left out). `chain_txs`: every transaction on the chain that day, NULL until a writer reads the block metas.
CREATE TABLE IF NOT EXISTS activity_daily (
  day TEXT NOT NULL, chain TEXT NOT NULL,
  flows INTEGER NOT NULL, senders INTEGER NOT NULL, receivers INTEGER NOT NULL, active INTEGER NOT NULL,
  nam REAL NOT NULL, trades INTEGER NOT NULL, traders INTEGER NOT NULL, chain_txs INTEGER,
  PRIMARY KEY (chain, day));

-- Stake per validator once a day, from the first complete bond listing of the UTC day (cron.ts runBondListing,
-- series.validatorDailyStmts): the sum of every bond to it net of slashing (pipeline included) and the number of
-- addresses bonded to it. Name, commission and state from indexer.namada.net /pos/validator/all (kv validators.names,
-- read daily; `names_at` its read time), NULL when that list does not have the validator or was not read.
CREATE TABLE IF NOT EXISTS validator_daily (
  day TEXT NOT NULL, validator TEXT NOT NULL,
  stake REAL NOT NULL, delegators INTEGER NOT NULL, commission REAL, state TEXT, name TEXT,
  as_of INTEGER NOT NULL, height INTEGER NOT NULL, names_at INTEGER,
  PRIMARY KEY (validator, day));

-- Every unbond on the chain by withdraw epoch, from the bond listing (series.unbondQueueStmts): NAM net of slashing
-- and the number of unbond entries. Rewritten whole when the queue changes (kv unbond.queue.hash); `listed_at` and
-- `height` are the listing that wrote it (kv bond.listing completeAt says the latest listing that confirmed it).
-- Epochs at or before the listing's epoch are withdrawable and not yet withdrawn.
CREATE TABLE IF NOT EXISTS unbond_queue (
  withdraw_epoch INTEGER PRIMARY KEY, nam REAL NOT NULL, n INTEGER NOT NULL, listed_at INTEGER NOT NULL, height INTEGER NOT NULL);

-- One row per complete chain listing (cron.ts runBalanceListing / runBondListing): kind 'balance' or 'bond'.
CREATE TABLE IF NOT EXISTS listings (
  at INTEGER PRIMARY KEY, kind TEXT NOT NULL, height INTEGER NOT NULL, provider TEXT NOT NULL);

-- Genesis NAM followed past its first hop (screener-plan 3.3, phase two); no writer yet.
CREATE TABLE IF NOT EXISTS cohort_taint (
  address TEXT NOT NULL, cohort TEXT NOT NULL, tainted_nam REAL NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (address, cohort));

-- Dated markers for the charts (screener-plan 3.5 d): governance proposals, forum topics, owner-curated
-- announcements; every row names who added it and its source URL. No writer yet.
CREATE TABLE IF NOT EXISTS events (
  ts INTEGER NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, url TEXT, added_by TEXT NOT NULL,
  PRIMARY KEY (ts, kind));

-- When this site first saw the address hold NAM (unix ms): set when a Namada holder row is created with a balance
-- (the balance listing, or a block's post-balance), never changed after. NULL for every row that existed before
-- this migration (the chain does not say when an address first received NAM) and for a row created empty.
ALTER TABLE holders ADD COLUMN first_seen INTEGER;
