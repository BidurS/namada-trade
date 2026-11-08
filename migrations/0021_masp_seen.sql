-- 2026-11-07. The shielded transactions this site's block follower saw (worker/src/masp-seen.ts, written by the live
-- hub beside each Namada block's rows, live-hub.ts scanNamada): one row per `masp/transfer` or `masp/fee-payment`
-- event in a block's results, by the chain's own index of the transaction (the event's indexed-tx attribute: the block
-- height, the transaction's index in the block and the inner transaction's index in its batch). The hourly
-- masp_tx_coverage check (worker/src/cron.ts) compares these rows with what Namada's shielded-transaction indexer
-- (masp.namada.net) lists for the same blocks: a transaction the chain recorded that is missing here is a gap in this
-- site's record. Indexes only: no bytes, no addresses, no amounts. `kind` is 'transfer', 'fee-payment', or both
-- joined with '+' when one inner transaction raised both events. Rows are written INSERT OR IGNORE, so a block read
-- again (a cursor moved back) changes nothing. The primary key serves the check's reads by height range.
CREATE TABLE IF NOT EXISTS masp_seen (
  height      INTEGER NOT NULL,
  block_index INTEGER NOT NULL,
  batch_index INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  PRIMARY KEY (height, block_index, batch_index)
);
