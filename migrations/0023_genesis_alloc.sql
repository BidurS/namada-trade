-- 2026-11-07. The genesis allocation table and the cohort columns it feeds (docs/design/owner-decisions.md row 39).
--
-- genesis_alloc: one row per NAM allocation of the genesis balances file (namada-net/namada-mainnet-genesis
-- genesis/balances.toml), written by scripts/genesis-alloc.ts from the reviewed copy pinned in shared/genesis.ts, and
-- never by the Worker. `category` is the allocation's cohort (shared/genesis.ts ALLOC_CATEGORIES: backer, foundation,
-- team, validators, ecosystem, public_completed, public_future). The script also writes kv 'genesis.alloc' (the file's
-- digest, row count and sums), which the API serves as the table's provenance. The labels table is untouched: the
-- 64,900 public-sale wallets get no label, their totals are computed from this table (the owner's call).
CREATE TABLE IF NOT EXISTS genesis_alloc (
  address    TEXT PRIMARY KEY,
  amount_num REAL NOT NULL,                  -- NAM at genesis
  category   TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS genesis_alloc_cat ON genesis_alloc (category);
-- the largest allocations (the Supply page lists those of 15,000,000 NAM or more) without a pass over the table
CREATE INDEX IF NOT EXISTS genesis_alloc_amount ON genesis_alloc (amount_num DESC);

-- cohort_daily rows written from the allocation table (series.ts allocCohortStmts; category 'alloc.<cohort>' and
-- 'alloc.all') carry four more columns. `shielded_out`: NAM the cohort's addresses have sent into the shielded pool
-- since this site's record began (flows of kind shield, NAM only, older twins left out), cumulative to `as_of`.
-- `alloc_nam`: the cohort's NAM at genesis. `balance_height` / `bond_height`: the blocks of the two chain listings
-- the holdings are read from. NULL on every row written from the labels (the 'backer' / 'foundation' / 'genesis' /
-- 'none' rows) and on rows before this migration.
ALTER TABLE cohort_daily ADD COLUMN shielded_out REAL;
ALTER TABLE cohort_daily ADD COLUMN alloc_nam REAL;
ALTER TABLE cohort_daily ADD COLUMN balance_height INTEGER;
ALTER TABLE cohort_daily ADD COLUMN bond_height INTEGER;
