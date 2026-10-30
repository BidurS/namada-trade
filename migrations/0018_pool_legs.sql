-- 2026-10-29. The coins besides NAM moving into and out of a NAM pool's address on Osmosis (worker/src/parse/osmosis.ts
-- poolLegsOf, written by the live hub beside a transaction's NAM rows and by scripts/backfill-osmosis.ts).
--
-- moves holds NAM deltas only (delta_num, in NAM), so a transaction that moves only a pool's other coin left no row
-- anywhere: in the 7 days to 2026-10-29, 9 bids placed or cancelled on the 3008 order book (+174.699236 USDC, all of
-- its USDC) and a USDC-only position withdrawal from 3005 (EBDEAC7A..., -69.912075 USDC). A swap's USDC or OSMO leg
-- into the pool was not kept either. One row per bank transfer leg with a pool's address on one end, per coin other
-- than NAM: the pool, the coin's denom and its signed amount in base units (into the pool positive), as text, so a coin
-- of 18 decimals stays exact. The NAM side of the same legs stays in moves; nothing that reads a NAM figure names this
-- table. The primary key's leading chain and tx_hash serve the reads by transaction; pool_legs_pool_ts a pool's ledger
-- over time (the reserves against the ledger, later).
CREATE TABLE IF NOT EXISTS pool_legs (
  chain    TEXT NOT NULL,
  pool_id  TEXT NOT NULL,
  address  TEXT NOT NULL,                  -- the pool's account (a CosmWasm pool's contract)
  height   INTEGER NOT NULL,
  ts       INTEGER NOT NULL,
  tx_hash  TEXT NOT NULL,
  idx      INTEGER NOT NULL,               -- the bank leg's index within the transaction, as moves.idx
  denom    TEXT NOT NULL,
  delta    TEXT NOT NULL,                  -- signed base units
  PRIMARY KEY (chain, tx_hash, idx, address, denom)
);
CREATE INDEX IF NOT EXISTS pool_legs_pool_ts ON pool_legs (pool_id, ts);
