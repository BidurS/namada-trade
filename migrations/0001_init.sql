-- NamadaTrade schema. Amounts: *_num columns are NAM floats (for sorting/aggregates);
-- raw base-unit strings are kept where exactness matters (balances).

-- Current balances per chain (osmosis: full refresh from denom_owners; namada: post-balances + ABCI verify)
CREATE TABLE IF NOT EXISTS holders (
  chain          TEXT NOT NULL,              -- 'osmosis' | 'namada'
  address        TEXT NOT NULL,
  balance        TEXT NOT NULL,              -- base units (unam / ibc denom units, 6 decimals)
  balance_num    REAL NOT NULL,
  updated_height INTEGER,
  updated_at     INTEGER,                    -- unix ms
  verified_at    INTEGER,                    -- unix ms of last live verification (ABCI / REST)
  verified_src   TEXT,                       -- which endpoint verified it
  PRIMARY KEY (chain, address)
);
CREATE INDEX IF NOT EXISTS holders_rank ON holders (chain, balance_num DESC);

-- Raw ledger: every NAM balance change we observe (source of 24h/7d deltas + address history)
CREATE TABLE IF NOT EXISTS moves (
  chain     TEXT NOT NULL,
  address   TEXT NOT NULL,
  height    INTEGER NOT NULL,
  ts        INTEGER NOT NULL,
  tx_hash   TEXT NOT NULL,
  idx       INTEGER NOT NULL,                -- event index within tx/block
  delta_num REAL NOT NULL,
  PRIMARY KEY (chain, tx_hash, idx, address)
);
CREATE INDEX IF NOT EXISTS moves_addr_ts ON moves (chain, address, ts DESC);
CREATE INDEX IF NOT EXISTS moves_ts ON moves (ts DESC);

-- Semantic flows for the live feed (one row per meaningful action)
CREATE TABLE IF NOT EXISTS flows (
  id             TEXT PRIMARY KEY,           -- chain:tx_hash:idx
  chain          TEXT NOT NULL,
  height         INTEGER NOT NULL,
  ts             INTEGER NOT NULL,
  tx_hash        TEXT NOT NULL,
  kind           TEXT NOT NULL,              -- buy|sell|transfer|ibc_in|ibc_out|bond|withdraw|rewards|shield|unshield|lp_add|lp_remove|other
  from_addr      TEXT,
  to_addr        TEXT,
  amount_num     REAL NOT NULL,
  counter_denom  TEXT,
  counter_amount REAL,
  pool_id        TEXT,
  price_usd      REAL,
  value_usd      REAL,
  meta           TEXT                        -- JSON
);
CREATE INDEX IF NOT EXISTS flows_ts ON flows (ts DESC);
CREATE INDEX IF NOT EXISTS flows_from ON flows (from_addr, ts DESC);
CREATE INDEX IF NOT EXISTS flows_to ON flows (to_addr, ts DESC);
CREATE INDEX IF NOT EXISTS flows_kind ON flows (kind, ts DESC);

-- Labels (auto: pools, modules, validators, genesis allocations; user: manual tags; future: CEX wallets)
CREATE TABLE IF NOT EXISTS labels (
  address   TEXT PRIMARY KEY,
  chain     TEXT NOT NULL,
  label     TEXT NOT NULL,
  category  TEXT NOT NULL,                   -- pool|module|validator|foundation|backer|cex|team|whale|watch|ibc|masp|pos|other
  source    TEXT NOT NULL,                   -- auto|genesis|valopers|user
  note      TEXT,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS labels_cat ON labels (category);

-- osmo1 <-> tnam1 links observed in IBC packets
CREATE TABLE IF NOT EXISTS address_links (
  osmo_addr    TEXT NOT NULL,
  namada_addr  TEXT NOT NULL,
  first_seen   INTEGER NOT NULL,
  last_seen    INTEGER NOT NULL,
  transfers    INTEGER NOT NULL DEFAULT 1,
  volume_num   REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (osmo_addr, namada_addr)
);
CREATE INDEX IF NOT EXISTS links_namada ON address_links (namada_addr);

-- Time series metrics (price, liquidity, supply split, concentration...)
CREATE TABLE IF NOT EXISTS metrics (
  ts    INTEGER NOT NULL,
  key   TEXT NOT NULL,
  value REAL NOT NULL,
  PRIMARY KEY (key, ts)
);

-- Ingestion cursors + misc state
CREATE TABLE IF NOT EXISTS kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Integrity / double-check results
CREATE TABLE IF NOT EXISTS checks (
  key        TEXT PRIMARY KEY,
  status     TEXT NOT NULL,                  -- ok|warn|fail
  title      TEXT NOT NULL,
  detail     TEXT NOT NULL,                  -- JSON
  checked_at INTEGER NOT NULL
);
