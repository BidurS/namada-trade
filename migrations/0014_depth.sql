-- Depth (plan section 1.5): what the base coin fetches at every price across every Osmosis pool that holds it, read
-- from the chain's own state every minute by worker/src/depth/index.ts. Every table is a primary-key range; nothing
-- here is ever filled in afterwards. A figure that was not read is NULL with the reason in `note`, never 0.

-- One row per live pool per minute, and one with pool_id 'all' (the aggregate, which alone carries the heat bands).
-- Kept 30 days (the hourly delete of plan section 1.7, step S3).
CREATE TABLE IF NOT EXISTS depth_minute (
  minute      INTEGER NOT NULL,   -- start of the UTC minute (unix ms)
  pool_id     TEXT    NOT NULL,   -- '3005' ... or 'all'
  at          INTEGER NOT NULL,   -- when the pool's state was read (unix ms)
  height      INTEGER,            -- the chain height of the read; NULL for 'all' when the pools came at different heights (then the lowest is in note)
  ref_usd     REAL    NOT NULL,   -- the reference pool's own spot at that minute, USD per whole base coin
  spot_usd    REAL,               -- this pool's own spot in USD (NULL for the book and for 'all')
  bid_1 REAL, bid_2 REAL, bid_5 REAL, bid_10 REAL, bid_25 REAL, bid_50 REAL,   -- USD received selling down to ref x (1 - p %)
  ask_1 REAL, ask_2 REAL, ask_5 REAL, ask_10 REAL, ask_25 REAL, ask_50 REAL,   -- USD it costs buying up to ref x (1 + p %)
  sell_1k REAL, sell_10k REAL, sell_100k REAL, sell_1m REAL,                   -- USD out for selling that many base coins (NULL when not fillable)
  buy_1k REAL, buy_10k REAL, buy_100k REAL, buy_1m REAL,                       -- USD in for buying that many base coins
  best_bid    REAL,               -- effective price of the first touch-size coins sold
  best_ask    REAL,               -- effective price of the first touch-size coins bought
  bid_usd     REAL,               -- everything resting on the bid side, USD
  ask_nam     REAL,               -- everything resting on the ask side, base coins
  nam         REAL,               -- the pool's base-coin balance (NULL for 'all')
  counter     REAL,               -- the pool's counter-coin balance (NULL for 'all')
  counter_usd REAL,               -- that balance in USD (NULL for 'all')
  heat_bid    TEXT,               -- 'all' only: base64 float32[112], USD per 2½ % band from ¼x the reference upward
  heat_ask    TEXT,
  note        TEXT,               -- why something is NULL ("counter coin unpriced", "read failed: 429"), at most 160 characters
  PRIMARY KEY (pool_id, minute)
);

-- The same columns keyed by the hour: the hour's last minute, the hour's extremes of two figures and the count of
-- minutes that had a row. Kept forever (17 pools x 720 rows a month). Written by the hourly job (step S3).
CREATE TABLE IF NOT EXISTS depth_hourly (
  hour        INTEGER NOT NULL,
  pool_id     TEXT    NOT NULL,
  at          INTEGER NOT NULL,
  height      INTEGER,
  ref_usd     REAL    NOT NULL,
  spot_usd    REAL,
  bid_1 REAL, bid_2 REAL, bid_5 REAL, bid_10 REAL, bid_25 REAL, bid_50 REAL,
  ask_1 REAL, ask_2 REAL, ask_5 REAL, ask_10 REAL, ask_25 REAL, ask_50 REAL,
  sell_1k REAL, sell_10k REAL, sell_100k REAL, sell_1m REAL,
  buy_1k REAL, buy_10k REAL, buy_100k REAL, buy_1m REAL,
  best_bid    REAL,
  best_ask    REAL,
  bid_usd     REAL,
  ask_nam     REAL,
  nam         REAL,
  counter     REAL,
  counter_usd REAL,
  heat_bid    TEXT,
  heat_ask    TEXT,
  note        TEXT,
  sell_10k_lo REAL,               -- the hour's lowest and highest sell_10k
  sell_10k_hi REAL,
  bid_10_lo   REAL,               -- the hour's lowest and highest bid_10
  bid_10_hi   REAL,
  n           INTEGER NOT NULL,   -- minutes of the hour that had a row
  PRIMARY KEY (pool_id, hour)
);

-- Liquidity that appeared, left or filled: the diff of two consecutive minutes' level sets (step S3). Bounded by real
-- events (position and order events on the chain). Kept forever.
CREATE TABLE IF NOT EXISTS depth_changes (
  ts       INTEGER NOT NULL,
  pool_id  TEXT    NOT NULL,
  ref      TEXT    NOT NULL,      -- 'pos:<position_id>' | 'ord:<order_id>' | 'rng:<lo>:<hi>' | 'res' (a reserve)
  kind     TEXT    NOT NULL,      -- 'added' | 'removed' | 'filled' | 'grew' | 'shrank'
  side     TEXT,                  -- 'bid' | 'ask' | NULL (a range that straddles the price)
  price_lo REAL,
  price_hi REAL,
  nam      REAL,
  usd      REAL,
  owner    TEXT,                  -- the address when known (positions and orders are on chain with owners), else NULL
  height   INTEGER,
  PRIMARY KEY (pool_id, ref, ts)
);
CREATE INDEX IF NOT EXISTS depth_changes_ts ON depth_changes (ts);
