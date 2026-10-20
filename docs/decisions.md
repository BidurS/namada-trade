# Decision inventory (Phase 0)

What a NAM trader actually decides, what evidence each decision needs, where that evidence is blind, and what the screen must therefore show. Every panel in the redesigned UI names the decision it serves; anything that serves none is cut.

Numbers below are from the live D1 on 2026-10-16: spot ≈ $0.0010, total supply 1.147B NAM, Osmosis float ≈ 20M NAM, total DEX liquidity across 28 pools ≈ $1,250, reference pool 3005 ≈ $730. This is a market where a $50 order is a whale order. Every decision is shaped by that.

## D1. "If I sell X NAM now, what do I actually get?"

- Evidence: live SQS route quote for X (`/api/quote`), reserves of pool 3005 and the next two pools (`PoolInfo.namReserve/counterReserve`), the ladder of impact by size (`QuoteCurveResponse.curve`), the 1% and 3% safe-clip sizes.
- Blind: SQS quotes can silently return 0 impact on multi-hop routes; CL tick liquidity outside the active range is not in `liquidityUsd`.
- Action: size the clip, split into N clips, or wait.
- Screen: one input (size + side), one answer (USDC out, effective price, impact), and the ladder. Impact is shown against the *current* spot from the same quote, never a stored one.

## D2. "Is a dump coming to Osmosis?"

The only way NAM reaches the DEX is IBC over channel-1 → channel-98451. Inventory arriving on Osmosis is sell-side ammunition until it is swapped or bridged back.

- Evidence: `flows.kind='ibc_in'` on Osmosis (and `ibc_out` on Namada) by size and by receiving `osmo1` address; whether that address has sold before (`flows.kind='sell'` from the same `meta.trader`); `address_links` to the Namada origin; the origin's label (`labels.category`: backer, foundation, genesis).
- Blind: shielded IBC (`ibcUnshieldingTransfer`) hides the Namada sender; the Osmosis receiver is still visible.
- Action: front-run (sell first), fade (buy the dip after), or ignore.
- Screen: an "inventory on deck" number: NAM bridged in during the last 24h/7d that has not yet been sold or bridged out, by address, ranked, with each address's prior sell behaviour.

## D3. "Is supply about to unlock?"

Unbonded NAM leaves PoS after the unbonding period and becomes liquid. The 331M NAM withdrawal on 2026-08-30 (then re-bonded) is the kind of event that moves this market by itself.

- Evidence: `flows.kind='withdraw'` and `'bond'` from the PoS address, by counterparty; the address's balance and label; chain params read live from `indexer.namada.net/api/v1/chain/parameters` (today: `unbondingLength` 53 epochs + `pipelineLength` 2, epoch ≥ 6h, so an unbond becomes liquid ≈ 13–14 days after it is requested); `metrics.supply.pos_bonded` over time.
- Blind: pending unbonds (requested, not yet withdrawable) are not in the event index; they must be read per address from `/api/v1/pos/unbonds` on the indexer.
- Action: reduce exposure ahead of a known unlock; or treat a re-bond as removal of overhang.
- Screen: a calendar of unlocks: who, how much, when withdrawable, with the source of the estimate.

## D4. "Who is actually moving the price?"

In a market this size, 3–5 addresses are the market.

- Evidence: `flows` grouped by `meta.trader` (Osmosis) or `from_addr` (Namada), net NAM over 24h/7d; `holders` with `change24h/change7d`; labels; `address_links`.
- Blind: Osmosis arb bots (`meta.arb=true`) churn volume without taking direction; they must be excluded from "who is buying".
- Action: follow or fade specific addresses; watch-list them.
- Screen: a ranked ledger of net buyers and net sellers with size, excluding arbs; one click opens the address.

## D5. "How much of this market can I not see?"

MASP shielding hides holders and transfers. The pool balance is visible; its contents are not.

- Evidence: `metrics.supply.masp_shielded` (live level), `metrics.supply.masp_shielded.daily` (chain post-balances since 2025-06), `flows.kind in ('shield','unshield','ibc_in','ibc_out')` legs touching the MASP, `ibcShieldingTransfer` volume.
- Blind: by design, everything inside the pool. Large unshields to a fresh address are the only early signal of a hidden holder preparing to move.
- Action: discount signals in proportion to the hidden share; watch unshields.
- Screen: a single honest number ("X% of supply is where we cannot see it") plus a feed of unshields ≥ threshold.

## D6. "Is the number I'm looking at true right now?"

Data here comes from five sources (SQS, Keplr RPC, two Namada RPCs, the public indexer) and a 1-minute cron that stores 0 when a source fails.

- Evidence: `Freshness.at`, `holders.verified_at`, `checks` (IBC conservation, RPC agreement, supply partition), block height vs. live head.
- Blind: a stored value cannot tell you the source is down; only its age can.
- Action: trust, discount, or refresh.
- Screen: every number carries its age and source; stale (> 5 min) numbers dim; missing numbers show "—" with the reason, never a fallback.

## D7. "Should something wake me up?"

Traders are not watching the screen when the move happens.

- Evidence: whale thresholds (`WHALE_*_NAM`), unlock calendar (D3), inventory on deck (D2), unshields (D5), governance status changes.
- Blind: Discord webhooks only reach whoever configured them.
- Action: get interrupted only for events that change D1–D5.
- Screen: an alert rule per decision with a plain-language condition, and an in-app "since you were away" list.

## What this removes

The previous UI was organised by source (Cockpit, Pools, Flows, Holders, Intel, Integrity). None of those is a decision. The redesign:

- **Trade** = D1 (ticket, depth ladder, pools, SQS-vs-executed price)
- **Pressure** = D2 + D3 + D4 (inventory on deck, unlocks/re-locks with the live unbonding period, movers, governance in flight)
- **Blind spot** = D5
- **Tape** = the raw feed and holder ledger, kept for verification, with the source of every timestamp and price
- **Trust panel** = D6, promoted from a tab to a property of every number (`Num` / `ProvBadge` components; `Sourced<T>` in the API)
- **Alerts** = D7, with the same rule code (`shared/alerts.ts`) running in the Worker, the UI and the replay harness

Cut from the old UI: the "regime" classifier (a narrative with hard-coded thresholds and no backtest), the fabricated integrity checks and supply fallbacks, the donation testimonials, the four cosmetic themes. Kept but demoted: forum feed (governance only, under Pressure), holders (under Tape).

## What the event set already taught us

- Unlocks are not reliably bearish here: the 331M NAM PoS withdrawal (2026-08-31) was followed by +10% in 24h, and the 300M re-bond (2026-09-22) by +21%. The UI therefore shows unlocks as evidence with the address and what it did next, never as a "sell signal".
- Every IBC packet appears twice in `flows` (once per chain). The pressure view groups by the Osmosis receiver so it counts each packet once.
- Arbitrage round-trips (`meta.arb`) dominate Osmosis swap counts; all buy/sell aggregates exclude them.

## Open questions for you

1. Your real past trades: when, what size, what you looked at, what you wished you had known. Each one is a test case for the replay harness.
2. Whether other traders use Osmosis directly or route via Keplr/Leap swap, which changes which route the quote should mimic.
3. Alert delivery: Discord only, or also Telegram/push?

## Known gaps (2026-10-16)

- **Shielded-pool history (cause found 2026-10-17; series now read off the chain).** The backwards reconstruction landed at −15.0M NAM because two things were missing from `flows`, in opposite directions. (1) **Shielded IBC withdrawals.** A NAM withdrawal straight from the pool to another chain is one `token/transfer` MASP → IBC escrow (`tnam1qcqq…vtr7x4`) on chain, but `indexer.namada.net` files it as `ibcUnshieldingTransfer` with a *transparent* `sources[0].owner` (the refund/fee address) and lists it under that address only, so `/chain/history?addresses=<MASP>` never returned them: 42.4M NAM of pool outflow was absent (the indexer's own `/masp/aggregates` all-time totals do include them: inflows 262.8M vs our 262.7M, outflows 239.4M vs our 197.0M). (2) **Shielded rewards.** Inflation for shielded assets is credited to the MASP's NAM balance once per MASP epoch (about daily) with no event and no tx; 25.7M NAM entered the pool this way between 2025-06 and ≈ block 7.0M (≈160k NAM/day in mid-2025, ≈50k/day later, ≈0 since: `/masp/rates` shows `maxRewardRate` 0 for every token but USDC). −15.0M = 50.7M − (262.7M − 197.0M) ⇔ 50.7M − 262.8M + 239.4M = +27.3M ≈ minted. **Fix** (`npm run backfill:history -- masp`): the public RPCs keep `block_results` back to genesis, and every `token/transfer` event carries `post-balances`, the MASP's exact NAM balance right after it. The step reads the balance at every block that touched the pool (indexer history ∪ `flows`, then scans the blocks between any two points whose balance change is not explained by the legs it knows, cheaply via `/blockchain` metas so empty blocks cost nothing), writes `metrics.supply.masp_shielded.daily` as the balance after the last pool transfer of each UTC day (provenance in kv `namada.masp_history`), and emits every MASP leg the chain shows that `flows` lacks as `INSERT OR IGNORE` rows (`id namada:<INNER>:c<i>`, `meta.source namada-rpc-block-results`, kind `ibc_out`/`ibc_in` for the escrow legs, exact block time). Result: 15,318 exact balance points from height 2,384,008 (4 NAM, the pool started empty) to 8,300,092 (50,702,670 NAM = the live ABCI reading). Between points the chain credited 27.35M NAM with no transfer event (shielded rewards); outflow still unexplained after scanning every gap: 1,432 NAM in 1,721 sub-NAM residuals (0.003% of the pool, fee-sized), so the daily series is written (`scripts/out/history/04_masp_daily_000.sql`, 493 days). 6,704 MASP legs were missing from `flows` and are emitted in `04_masp_flows_00{0,1}.sql`: 2,041 `ibc_out` legs MASP → escrow worth 42.50M NAM, 4,631 MASP fee legs (3,515 NAM), 29 escrow → MASP `ibc_in` legs (113k NAM), 3 shields. With those rows the flows-only backward reconstruction lands at +27,347,598 NAM before the first flow, i.e. the minted total within 1,432 NAM, which is what it should do: a flow list cannot close to zero because minting is not a flow. Remaining caveats: a minted amount and a missing outflow inside the same gap cancel in the residual, so the flows table can still miss legs where the scan did not run; the live RPC parser (`worker/src/parse/namada.ts`) now classifies MASP ↔ escrow legs as `ibc_out`/`ibc_in` and keeps the MASP fee leg in `meta.maspFeeNam` (tests on blocks 8,288,955 / 7,011,473 / 7,153,723 / 4,707,359); 6 RPC-era rows (Namada blocks 8,288,955–8,294,006, 2026-10-15 18:40–21:05 UTC) are twins of wrapper-hash rows, 109,331 NAM double counted: two worker builds (the deployed one keys rows by inner hash, the current parser by wrapper hash with `meta.innerTxHash`) wrote the same blocks to production D1 at the same time; the step ignores the twins and lists their ids, nothing has been deleted.
- **Unbond requests between 2026-08-14 and the deploy of the live decoder.** Every bond and unbond since genesis up to height 7,682,174 is in `flows` from the indexer pull (19k rows). Unbond *requests* are now also captured live (see below), but the window between the pull and the first deploy of the live decoder is not: fill it with `npm run backfill:history -- namada && -- pos` (same id scheme, so the two sources never duplicate a row). `indexer.namada.net`'s `pos/merged-unbonds` returns empty for the addresses we tested, so it cannot fill the gap per address either.
- **Unbond requests are captured live** (worker/src/parse/namada-tx.ts, namada-unbond.ts). An unbond moves no tokens, so it has no token/transfer event. The LiveHub poller now looks at each block's `tx/applied` event: its `batch` attribute lists every inner tx with its result and changed storage keys, and an applied unbond writes `<PoS>/unbond/<source>/<validator>/…`. Only for such blocks the poller fetches the block's tx bytes (RPC `/block`), borsh-decodes the wrapper (header commitments → inner hashes, Code sections → wasm tag, Data sections → `Unbond { validator, amount, source }`) and emits one `unbond` flow per applied inner tx whose Code tag is `tx_unbond.wasm` and whose decoded (source, validator) matches the changed key. Withdraws also touch unbond keys (they delete them) and are skipped by tag. Rows use the backfill's scheme (`namada:<INNER_HASH>:pos`, from = PoS, to = delegator, meta.validator / wrapper / tsSource `block`, meta.source `namada-rpc`, meta.code = wasm checksum) and the exact block time from block metas; if block metas or tx bytes cannot be fetched the block is retried next tick instead of being stamped with import time. The decoder was verified against mainnet blocks 6,957,587 and 8,300,328 (test/unbond.test.ts, fixtures under test/fixtures/): wrapper and inner hashes equal what the chain reports, and the delegator, validator and amount equal what indexer.namada.net reports. Outcomes (decoded count, last block, last failures) are kept in kv `namada.unbonds.live` and shown by the cron health probe "Namada RPC (live unbond decode)". Self-unbonds (no source) are recorded with to = validator and meta.selfUnbond.
- **Osmosis swaps before ~2026-08-30** carry extrapolated timestamps (public nodes prune older blocks).
- **Repeated IBC relays (fixed 2026-10-17).** The indexer records every applied relay of a packet as its own tx, although only the first moves funds; 1,693 transparent `ibc_in` rows (226M NAM) were such repeats and were removed (`scripts/out/history/07_ibc_dedupe_000.sql`, rule: same kind/from/to/amount within 20 blocks of an earlier row). `address_links` was rebuilt from the deduplicated flows. The importer now drops repeats on the way in. MASP-side rows were not affected (17 rows, 399 NAM).
- **Namada-side IBC outflows look under-recorded.** After dedupe, indexer-period `ibc_in` to Namada is 101M NAM but `ibc_out` only 25M, while ~20M NAM sits on Osmosis today; at least ~120M must have left Namada. The missing outflows are probably shielded-IBC paths (`ibcUnshieldingTransfer` shows a transparent source in the indexer) and need a dedicated look before any "net bridge flow since 2025" chart is trusted. Live (RPC-period) rows are not affected: the IBC conservation check passes within 1.6k NAM.
- **Bonded stake (added 2026-10-17).** Holders are ranked by liquid + bonded. Bonded is read per address from `vp/pos/delegations_at/{owner}/{epoch}` plus any self-bond, 120 addresses per cron tick (whole set in ≈10 ticks), with the bond/unbond-history sum shown as an estimate (~) until an address is verified. Cross-check `bonded_coverage` compares Σ verified bonds with the PoS balance. Known disagreement: `tnam1qrk5pyvtzxjmykcqmhglssshdjf3njac2qvqmlse` moved 332M NAM to the PoS address on 2026-09-22 (recorded as bonds from token-transfer events) but the chain reports no delegations and no validator stake for it; the address page shows the drift. Module accounts are excluded from the holders list and from the top-10 concentration.
