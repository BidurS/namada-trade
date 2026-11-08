-- 2026-11-02. The wallet that received the shielded pool's coins on 2026-06-18 labelled as the drain's, a note for the
-- staking-account exploit wallet of migration 0019 that keeps to what the chain shows for it, and one bond row the
-- chain did not apply taken out with what was counted from it.
--
-- 1. The drain (block_results from rpc-namada.5elementsnodes.com, read 2026-11-02). On 2026-06-18 from 09:13 to 10:09
--    UTC, six transfers out of the shielded pool (tnam1pcqq...zmefah) paid tnam1qqmr0e209... at blocks 6,966,393,
--    6,966,497, 6,966,503, 6,966,868, 6,966,879 and 6,966,885: 150,355.824285 USDC (transfer/channel-5/uusdc, from
--    Noble; 0.001 of it at 6,966,393), 228,517.650502 ATOM, 43,998.774379 OSMO, 236,743.105098 NYM and 4,990.513672
--    TIA. After the last transfer of each coin, the pool held none of it. None of the six moved NAM. Namada announced an exploit on X on
--    2026-06-20. The address had no label on 2026-11-02 and holds 453.133349 NAM (block 8,516,951). Category
--    'exploit', so scripts/events.ts leaves its moves out of the market events too. Source 'curated': the genesis
--    loader, the automatic labels and wallets' tags never replace it (worker/src/db.ts). Where it sent the coins is
--    not labelled: a receipt alone does not show who holds the receiving address.
INSERT INTO labels (address, chain, label, category, source, note, updated_at) VALUES
  ('tnam1qqmr0e209af2eqr0n4w6fq44a6udrhvcvqraa8h4', 'namada', 'Shielded pool drain, 2026-06-18', 'exploit', 'curated',
   'Received six transfers out of the shielded pool on 2026-06-18 (blocks 6,966,393-6,966,885, 09:13-10:09 UTC): 150,355.82 USDC (Noble), 228,517.65 ATOM, 43,998.77 OSMO, 236,743.11 NYM and 4,990.51 TIA. After the last transfer of each coin, the pool held none of it. None of the six moved NAM. Namada announced an exploit on 2026-06-20.', 1793577600000)
ON CONFLICT(address) DO UPDATE SET label = excluded.label, category = excluded.category, source = excluded.source,
  note = excluded.note, updated_at = excluded.updated_at, author = NULL
  WHERE labels.source != 'user';

-- 2. The exploit wallet tnam1qry99h4f... (migration 0019). Its note keeps to what the chain shows for this wallet and no
--    longer says what became of the NAM it shielded. Its balance read 3,000,997.134488 NAM at block 8,516,950
--    (5ElementsNodes, 2026-11-02), as the holder list has it.
UPDATE labels SET note = 'Took 332,386,683 NAM out of the staking account on 2026-08-31 (heights 7,900,823-7,900,866); shielded 50,000,000 NAM on 2026-09-01; received 9,999,997 NAM from the shielded pool on 2026-09-03; sent 289,385,685 NAM to the repayment wallet on 2026-09-03; still held 3,000,997.13 NAM at block 8,516,950 (2026-11-02).',
  updated_at = 1793577600000
  WHERE address = 'tnam1qry99h4faqtkleuuyecxzrswq7vgkj2hu5kg6dqp' AND source = 'curated';

-- 3. Flow namada:8D515657...:pos (block 8,202,488, 2026-10-08) came with the indexer import of bond requests, which
--    lists it as applied; the chain did not apply it (a validity predicate rejected the tx, block_results
--    vps_result.rejected_vps), so it wrote nothing, and the live decoder makes no row of such a tx (docs/decisions.md,
--    "Bond requests are captured live"). The row goes, with what was counted from it (read 2026-11-02):
--    - activity_daily 2026-10-08, namada: one flow and its NAM fewer (4 flows and 2,400.813422 NAM with it); its
--      sides are the staking account, never counted there as a sender or a receiver;
--    - flow_edges_daily 2026-10-08, namada, the row's bond edge: the row alone (n 1), so the edge goes;
--    - the staking account's stake estimate (cron.ts STAKE_ESTIMATES_SQL: its bonds less the unbonds to it): this was
--      its only row, so the estimate is NULL, unknown, as scripts/repair-pos-balance.sql left those of the 0019
--      wallets; the bonded_num the bond listing read (0) stays;
--    - flow_counts: the delete marks them dirty (migration 0017's trigger) and the next tick counts again.
--    No moves, address_links or pool_legs row and no kv or check names it. The daily rows change only while the flow
--    is there and the estimate is computed again from flows, so a second run, or a database without the row, changes
--    nothing. The history backfill's unbond-gap step leaves the row out (scripts/backfill-history.ts NOT_APPLIED).
UPDATE activity_daily SET flows = flows - 1,
    nam = nam - (SELECT amount_num FROM flows WHERE id = 'namada:8D515657565D2D26ABE13CCA578DACAF537B481F97FBEA556763D19195E77322:pos')
  WHERE day = '2026-10-08' AND chain = 'namada'
    AND EXISTS (SELECT 1 FROM flows WHERE id = 'namada:8D515657565D2D26ABE13CCA578DACAF537B481F97FBEA556763D19195E77322:pos');
UPDATE flow_edges_daily SET n = n - 1,
    nam = nam - (SELECT amount_num FROM flows WHERE id = 'namada:8D515657565D2D26ABE13CCA578DACAF537B481F97FBEA556763D19195E77322:pos')
  WHERE day = '2026-10-08' AND chain = 'namada' AND kind = 'bond' AND from_cat = 'pos' AND to_cat = 'pos'
    AND EXISTS (SELECT 1 FROM flows WHERE id = 'namada:8D515657565D2D26ABE13CCA578DACAF537B481F97FBEA556763D19195E77322:pos');
DELETE FROM flow_edges_daily WHERE day = '2026-10-08' AND chain = 'namada' AND kind = 'bond' AND from_cat = 'pos' AND to_cat = 'pos' AND n <= 0;
DELETE FROM flows WHERE id = 'namada:8D515657565D2D26ABE13CCA578DACAF537B481F97FBEA556763D19195E77322:pos';
UPDATE stakes SET estimated_num = (SELECT SUM(CASE WHEN kind = 'bond' THEN amount_num ELSE -amount_num END) FROM flows WHERE chain = 'namada' AND ((kind = 'bond' AND from_addr = stakes.address) OR (kind = 'unbond' AND to_addr = stakes.address)))
  WHERE address = 'tnam1qgqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqc8j2fp';
-- Check after applying: no row for the id; activity_daily 2026-10-08 namada 3 flows, 2,400.813412 NAM; no
-- flow_edges_daily bond row from pos to pos that day; stakes estimated_num NULL for tnam1qgqq...c8j2fp; 5 curated labels.
--   SELECT COUNT(*) FROM flows WHERE id LIKE 'namada:8D515657%';
--   SELECT flows, nam FROM activity_daily WHERE day = '2026-10-08' AND chain = 'namada';
--   SELECT address, label, category, source FROM labels WHERE source = 'curated';
