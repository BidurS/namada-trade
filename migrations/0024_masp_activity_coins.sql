-- 2026-11-08. Activity inside the shielded pool as daily totals, and every coin the pool holds (builder G of the halt
-- release). Nothing here changes a stored figure.

-- masp_seen (migration 0021) gains the block's time, so its rows can be counted per UTC day (worker/src/masp-activity.ts):
-- the live hub writes it beside the index from the block's own header time (live-hub.ts scanNamada, the time every
-- flow of the block carries). A row written before this migration has no time and is never counted (on 2026-11-08
-- the table held no row: the chain has been halted since 2 November, and the hub records from release 2 on). The
-- index serves the day's count by time range.
ALTER TABLE masp_seen ADD COLUMN ts INTEGER;
CREATE INDEX IF NOT EXISTS masp_seen_ts ON masp_seen (ts);

-- One row per UTC day the block follower has scanned whole (worker/src/series.ts daily(), part 'shielded activity'):
-- how many shielded transactions the chain recorded that day (masp_seen rows, each transaction once by its block,
-- transaction and batch index), and of them how many were in a block with a NAM leg into the pool (a shield), out of
-- it (an unshield), over the bridge either way (an ibc_in or ibc_out row at the pool), and how many were in a block
-- with no NAM leg touching the pool at all (entirely inside the pool, in another coin, or paying a fee from the pool
-- and nothing else). The classes are read per block, since the index names no transaction's legs: a block with two
-- shielded transactions and one shield counts both as `nam_in`; a transaction can be in several of the first three
-- classes; `inside` is exclusive. `blocks`: how many blocks had a shielded transaction. `scanned_height` and
-- `scanned_ts`: the block follower's newest block when the day was counted (kv namada.scanned), past the day's end by
-- rule. Counts only: no note counts, no nullifiers, nothing per address. A day from before the hub recorded block
-- times is never written (not backfilled). Also written as metrics rows masp.txs_daily, masp.txs_nam_in_daily,
-- masp.txs_nam_out_daily, masp.txs_bridge_daily and masp.txs_inside_daily, which /api/series serves.
CREATE TABLE IF NOT EXISTS masp_activity_daily (
  day            TEXT PRIMARY KEY,
  txs            INTEGER NOT NULL,
  nam_in         INTEGER NOT NULL,
  nam_out        INTEGER NOT NULL,
  bridge         INTEGER NOT NULL,
  inside         INTEGER NOT NULL,
  blocks         INTEGER NOT NULL,
  scanned_height INTEGER NOT NULL,
  scanned_ts     INTEGER NOT NULL,
  written_at     INTEGER NOT NULL
);

-- The shielded pool's balance of every coin besides NAM, once a day per coin (series.ts daily(), part 'shielded coins';
-- worker/src/masp-coins.ts): `base` in the coin's base units as the chain writes them (text, exact for a coin of 18
-- decimals), `units` the same in the coin's units when the parser's token table knows its decimals (NULL otherwise),
-- `basis` how the figure was had: 'read' (one ABCI read of the pool's balance key for that token at the day's run,
-- `height` and `provider` the read's) or 'post-balance' (the newest post-balance a token/transfer event gave the pool,
-- kept by the live hub in kv masp.coins, `height` its block; written when the read failed, so the day is never left
-- without the last reading). `symbol` is the token table's name, or NULL for a token it does not name (stored by
-- address, shown nowhere). A coin whose balance was neither read nor seen in an event has no row. A coin the table
-- names also gets a metrics row masp.coin.<symbol slug>.daily with `units`. No page shows this table yet.
CREATE TABLE IF NOT EXISTS masp_coins_daily (
  day      TEXT NOT NULL,
  token    TEXT NOT NULL,
  symbol   TEXT,
  base     TEXT NOT NULL,
  units    REAL,
  basis    TEXT NOT NULL,
  height   INTEGER,
  provider TEXT,
  at       INTEGER NOT NULL,
  PRIMARY KEY (token, day)
);
