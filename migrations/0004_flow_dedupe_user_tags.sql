-- 2026-10-18. Three repairs of stored data and the guard that keeps them repaired.
--
-- 1. labels.author: the wallet that wrote a user tag (source 'user'). A user tag can then only be changed by the
--    wallet that wrote it, and never replaces a curated label (genesis, pools, protocol accounts); see
--    worker/src/db.ts stmt.userTag.
ALTER TABLE labels ADD COLUMN author TEXT;

--    The staking account's stored label said "bonded + unbonding"; it also holds unclaimed rewards and unbonds
--    already withdrawable, and what is staked is the chain's total stake (worker/src/config.ts INTERNAL_LABELS).
UPDATE labels SET label = 'Namada PoS account (staked + unstaking + unclaimed rewards)'
 WHERE address = 'tnam1qgqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqc8j2fp' AND source = 'auto';

-- 2. Bridge crossings straight into or out of the shielded pool, written as shield / unshield by parser builds
--    before 411dc1c, get the kinds the current parser gives them (ibc_in: escrow → pool, ibc_out: pool → escrow),
--    so the pool's 24 h and 7 d figures use one definition across the window. NAM only.
UPDATE flows SET kind = 'ibc_in'
 WHERE chain = 'namada' AND kind = 'shield' AND to_addr = 'tnam1pcqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzmefah'
   AND (from_addr = 'tnam1qcqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqvtr7x4' OR from_addr LIKE 'osmo1%')
   AND (meta IS NULL OR meta NOT LIKE '%"tokenSymbol":%');
UPDATE flows SET kind = 'ibc_out'
 WHERE chain = 'namada' AND kind = 'unshield' AND from_addr = 'tnam1pcqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzmefah'
   AND (to_addr = 'tnam1qcqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqvtr7x4' OR to_addr LIKE 'osmo1%')
   AND (meta IS NULL OR meta NOT LIKE '%"tokenSymbol":%');

-- 3. Twin rows: one Namada transfer written twice, once by an older parser build under its inner hash
--    (id namada:<inner>:<i>, no meta.innerTxHash) and once by the current one under its wrapper hash
--    (id namada:<wrapper>:<i>, meta.innerTxHash = <inner>). Both rows of a pair have the same block, the same
--    inner hash and the same event index <i>: that triple identifies one transfer event. The older row of each
--    pair is deleted (on 2026-10-17: 23 pairs between blocks 8,284,116 and 8,294,006, 145,928 NAM counted twice).
--    The index on (chain, height) makes the lookup per row cheap (and serves block lookups).
CREATE INDEX IF NOT EXISTS flows_chain_height ON flows (chain, height);
DELETE FROM flows
 WHERE chain = 'namada' AND json_extract(meta, '$.innerTxHash') IS NULL
   AND EXISTS (SELECT 1 FROM flows w
                WHERE w.chain = 'namada' AND w.height = flows.height AND w.id != flows.id
                  AND json_extract(w.meta, '$.innerTxHash') = flows.tx_hash
                  AND replace(w.id, w.tx_hash, '') = replace(flows.id, flows.tx_hash, ''));

-- The guard: one row per Namada transfer event. INSERT OR REPLACE (worker/src/db.ts stmt.flow) then replaces an
-- older twin instead of adding a second row, and INSERT OR IGNORE (backfills) skips one.
CREATE UNIQUE INDEX IF NOT EXISTS flows_namada_event
  ON flows (height, COALESCE(json_extract(meta, '$.innerTxHash'), tx_hash), replace(id, tx_hash, ''))
  WHERE chain = 'namada';
