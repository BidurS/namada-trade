# Indexer-era rows checked against the chain's blocks, 2026-11-08

Made by `scripts/recheck-indexer-rows.ts all`. Each row the import from indexer.namada.net wrote (`flows`, meta.source 'namada-indexer') was judged by its block's own `tx/applied` event as two public nodes gave it (https://namada-rpc.stakeandrelax.net, https://namada-rpc.polkachu.com; `/block_results`, read 2026-11-08): applied only when the event's code is 0, the inner transaction's batch result is Ok and `vps_result.rejected_vps` is empty, and only when both nodes gave the same event. Rows the chain did not apply are listed below and in `scripts/out/indexer_recheck.sql` (not in the repository) with the statements migration 0020 modelled, for the operator to review and apply. Nothing here was written to the database.

## Counts by kind

| kind | rows | blocks | applied | not applied | not in block | nodes disagree | not read | batch not read |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| bond | 17,368 | 9,505 | 17,368 | 0 | 0 | 0 | 0 | 0 |
| unbond | 2,209 | 1,355 | 2,209 | 0 | 0 | 0 | 0 | 0 |
| ibc_in | 2,071 | 2,068 | 2,071 | 0 | 0 | 0 | 0 | 0 |
| ibc_out | 521 | 520 | 521 | 0 | 0 | 0 | 0 | 0 |
| shield | 2,902 | 2,885 | 2,902 | 0 | 0 | 0 | 0 | 0 |
| transfer | 10,904 | 8,096 | 10,904 | 0 | 0 | 0 | 0 | 0 |
| unshield | 8,794 | 6,234 | 8,794 | 0 | 0 | 0 | 0 | 0 |
| all | 44,769 | 30,145 | 44,769 | 0 | 0 | 0 | 0 | 0 |

"Not in block": the block's tx/applied events name no batch result for the row's inner transaction hash. "Not read": a node did not answer for the block within the run's tries (scripts/out/indexer_recheck/failed.log names them); such rows are judged on the next run, which reads only what is missing. "Batch not read": the row's own result is Ok and no validity predicate rejected it, but another inner transaction of its batch failed, so the wrapper's atomic flag in the transaction bytes decides, and those bytes were not read for it (the same next run reads them).

Batches with a failed inner transaction: 761 rows sit in a wrapper whose code is not 0 although their own result is Ok (another inner transaction of the batch failed). Read from the transaction bytes: 761 are in a batch that is not atomic, so their writes stand and they count as applied (13,185,717.894595 NAM); 0 are in an atomic batch, which the chain dropped whole (0.000000 NAM); 0 were not read. The indexer's exit code for all of them read "applied".

## Rows the chain did not apply

None among the rows read.

## Rows the block does not name

None among the rows read.

## Rows recorded twice

Among the 52,400 Namada rows up to block 8,301,075 (every source): 4 rows repeat an earlier row of the same inner transaction with the same kind, ends and amount (3.000000 NAM), and 13 bridge rows repeat an earlier row with the same kind, ends and amount within 20 blocks (1,285.000000 NAM), the repeated-relay rule of 2026-10-17. The later row of each pair is named in the SQL file's comments; none is deleted by it (which row of a pair to keep is the operator's call).

By kind: ibc_out 12 rows, 1,185.000000 NAM; ibc_in 1 rows, 100.000000 NAM; withdraw 4 rows, 3.000000 NAM.

## Rows whose amount or sides differ from the block

Transfer-like rows (transfer, shield, unshield, ibc_in, ibc_out): 25,192 compared with the block's token/transfer event of the same inner transaction; 24,835 carry the event's NAM at their side, 40 do not, 317 have no such event in the block. Bond and unbond rows: the amount is in the transaction bytes, read only for the blocks whose batch code is not 0 (above): 738 rows compared with the decoded request, 738 the same, 0 not; the other 18,839 were checked for their delegator against the staking keys the inner transaction changed. In all, 0 bond or unbond rows name a delegator the chain does not.

| kind | block | row NAM | event NAM at the row's side | verdict |
|---|---:|---:|---:|---|
| ibc_out | 3,155,679 | 0.010000 | none | applied |
| ibc_out | 3,155,759 | 0.001000 | none | applied |
| ibc_out | 3,155,873 | 0.010000 | none | applied |
| ibc_out | 3,685,651 | 10.000000 | none | applied |
| ibc_out | 3,686,177 | 5.000000 | none | applied |
| ibc_out | 3,687,373 | 5.000000 | none | applied |
| ibc_out | 3,687,452 | 5.000000 | none | applied |
| ibc_out | 3,735,722 | 1.000000 | none | applied |
| ibc_out | 3,736,276 | 5.000000 | none | applied |
| ibc_out | 3,736,311 | 1.000000 | none | applied |
| ibc_out | 3,736,476 | 1.000000 | none | applied |
| ibc_out | 3,736,578 | 1.000000 | none | applied |
| ibc_out | 3,746,911 | 1.000000 | none | applied |
| ibc_out | 3,746,960 | 1.000000 | none | applied |
| ibc_out | 3,747,085 | 1.000000 | none | applied |
| ibc_out | 3,747,109 | 1.000000 | none | applied |
| ibc_out | 3,747,203 | 1.000000 | none | applied |
| ibc_out | 3,747,235 | 1.000000 | none | applied |
| ibc_out | 3,747,279 | 1.000000 | none | applied |
| ibc_out | 3,748,211 | 1.000000 | none | applied |
| ibc_out | 3,748,301 | 1.000000 | none | applied |
| ibc_out | 3,750,484 | 1.000000 | none | applied |
| ibc_out | 3,750,518 | 1.000000 | none | applied |
| ibc_out | 3,821,106 | 0.000001 | none | applied |
| ibc_out | 3,821,175 | 0.000001 | none | applied |
| ibc_out | 3,821,209 | 0.000001 | none | applied |
| ibc_out | 3,821,244 | 0.000001 | none | applied |
| ibc_out | 3,821,280 | 0.000001 | none | applied |
| ibc_out | 3,821,332 | 0.000001 | none | applied |
| ibc_out | 3,822,494 | 0.000001 | none | applied |
| ibc_out | 3,822,593 | 1.000000 | none | applied |
| ibc_out | 3,822,660 | 1.000000 | none | applied |
| ibc_out | 3,822,809 | 1.000000 | none | applied |
| ibc_out | 3,823,541 | 1.000000 | none | applied |
| ibc_out | 3,823,613 | 1.000000 | none | applied |
| ibc_out | 3,823,810 | 0.000001 | none | applied |
| ibc_out | 3,824,057 | 0.000001 | none | applied |
| ibc_out | 3,824,104 | 1.000000 | none | applied |
| ibc_out | 3,824,208 | 1.000000 | none | applied |
| ibc_out | 3,837,012 | 1.000000 | none | applied |

## The bridge totals of the era

Namada's own records of NAM crossing the bridge up to block 8,301,075, by the source that wrote the row (the indexer import, the block_results scan of the shielded pool's legs, the live reader):

| kind | source | rows | NAM | rows the chain did not apply | NAM of them | rows recorded twice | NAM of them |
|---|---|---:|---:|---:|---:|---:|---:|
| ibc_in | namada-indexer | 2,071 | 101,366,772.720284 | 0 | 0.000000 | 1 | 100.000000 |
| ibc_in | namada-rpc-block-results | 29 | 113,423.534240 | 0 | 0.000000 | 0 | 0.000000 |
| ibc_in | no source in meta (the live reader) | 43 | 41,139,136.953254 | 0 | 0.000000 | 0 | 0.000000 |
| ibc_in | all | 2,143 | 142,619,333.207778 | 0 | 0.000000 | 1 | 100.000000 |
| ibc_out | namada-indexer | 521 | 25,090,560.512530 | 0 | 0.000000 | 0 | 0.000000 |
| ibc_out | namada-rpc-block-results | 2,041 | 42,498,552.653189 | 0 | 0.000000 | 12 | 1,185.000000 |
| ibc_out | no source in meta (the live reader) | 56 | 40,667,657.836558 | 0 | 0.000000 | 0 | 0.000000 |
| ibc_out | all | 2,618 | 108,256,771.002277 | 0 | 0.000000 | 12 | 1,185.000000 |

The import's own rows: 101,366,772.720284 NAM in against 25,090,560.512530 NAM out, a difference of 76,276,212.207754 NAM; with the shielded pool's legs the block_results scan added on 2026-10-17 (42,498,552.653189 NAM out, 113,423.534240 NAM in), 33,891,083.088805 NAM. Every row of the era: 142,619,333.207778 NAM in, 108,256,771.002277 NAM out, a difference of 34,362,562.205501 NAM.

What this check changes: the rows the chain did not apply are 0.000000 NAM of the in rows and 0.000000 NAM of the out rows; the rows recorded twice 100.000000 NAM in and 1,185.000000 NAM out. Without them: 142,619,233.207778 NAM in, 108,255,586.002277 NAM out, a difference of 34,363,647.205501 NAM. The rest of the difference is not explained by this check: it compares each stored row with its block, and cannot see a crossing no row records (docs/decisions.md, "Namada-side IBC outflows look under-recorded"). The SQL file deletes nothing, so the ibc_conservation check reads the same rows as before.

## Method and limits

- One `/block_results` read per distinct block per node, cached under scripts/out/indexer_recheck/blocks/ (not in the repository). Both nodes must give the same tx/applied verdicts and token events for a block, event order aside; a block they differ on judges its rows "nodes disagree" and nothing is deleted for them.
- The judgement is the live decoders' rule (worker/src/parse/namada-pos.ts): the wrapper event's code 0, the inner transaction's result Ok, no rejecting validity predicate. A wrapper's code is one for its whole batch, so a row whose own result is Ok inside a wrapper whose code is not 0 (another inner transaction failed) is judged by the wrapper's atomic flag, read from the block's `/block` transaction bytes on both nodes (cached under blocks_txs/) and decoded with the Worker's own decoder: atomic, the chain dropped the whole batch; not atomic, the row's writes stand.
- A bond's or an unbond's amount is in the transaction bytes too: it is compared for the rows whose bytes that step read, and the other rows' delegator is checked against the staking keys the inner transaction changed instead.
- "Event NAM at the row's side: none" means neither side of the row is a NAM account of the block's token event for that inner transaction. For an ibc_out row the import marked shielded (an `ibcUnshieldingTransfer`), the indexer named the fee payer as the source where the chain's event names the shielded pool, as docs/decisions.md recorded on 2026-10-17; the amount itself is the event's. An ibc_in row with no token event of its inner transaction is a bridge receipt whose NAM the chain credited under the relay's own event; the row stands on the indexer's record of the receipt.
- A "relay repeat" is the importer's rule (the same kind, ends and amount within 20 blocks), not proof: where both rows record their IBC packet (the live reader's meta.packetSequence) and the packets differ, the rows are two crossings and are not listed; rows without a packet (the indexer import's) are listed by the rule alone, for the operator to look at.
- The SQL subtracts a row from the day's activity_daily (flows, nam) and flow_edges_daily (n, nam) rows as migration 0020 did. The day's distinct-address counts (senders, receivers, active) are not changed by subtraction; the days touched are listed in the SQL file for a rebuild with the cron's own code when the operator wants them exact. activity_daily holds Namada rows from 2026-08-14 only; flow_edges_daily since 2024-12-03.

