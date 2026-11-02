# Replay report

Generated 2026-11-02 16:10 UTC by `test/replay.test.ts` from `docs/events.json` (22 events, 216 price points) with default thresholds {"ibcInventory":25000,"unlock":100000,"bigSwap":10000,"unshield":50000,"bond":1000000,"exitBridge":100000,"liquidity":100000}.

**Price moves flagged ahead of time: 10 / 10.** Median lead 28.2 h; range 15.1–47.8 h.

A "flag" means at least one alert rule fired on a flow in the 48h before the move completed. It does not mean the rule predicted the direction: the table shows what fired so you can judge that yourself.

**Base rate:** 93% of all price points had an alert-size flow (≥ 10,000 NAM) in the prior 48h. Flagging 10/10 moves is only informative to the extent it beats that; the lead-time and rule columns are the useful part.

| event | move | rules fired | first alert | lead | exact times |
|---|---|---|---|---|---|
| price_2026-10-21T15 | +112.2% | big_swap, ibc_inventory, unshield | 2026-10-19 18:13 | 44.8 h | yes |
| price_2026-10-21T14 | -85.5% | big_swap, ibc_inventory, unshield | 2026-10-19 18:13 | 43.8 h | yes |
| price_2026-10-21T18 | +64% | big_swap, liquidity, ibc_inventory, unshield | 2026-10-19 18:13 | 47.8 h | yes |
| price_2026-08-19T21 | +38.8% | big_swap, liquidity, ibc_inventory | 2026-08-18 16:50 | 28.2 h | estimated |
| price_2026-08-19T19 | -36.9% | big_swap, liquidity, ibc_inventory | 2026-08-18 16:50 | 26.2 h | estimated |
| price_2026-09-19T11 | +34.7% | unlock | 2026-09-18 19:54 | 15.1 h | yes |
| price_2026-10-19T18 | -30.8% | unshield | 2026-10-18 16:08 | 25.9 h | yes |
| price_2026-10-27T08 | -28.8% | unshield, ibc_inventory | 2026-10-25 16:41 | 39.3 h | yes |
| price_2026-10-19T09 | +26.8% | unshield | 2026-10-18 16:08 | 16.9 h | yes |
| price_2026-10-19T20 | +26.2% | big_swap, unshield | 2026-10-18 16:08 | 27.9 h | yes |
| whale_namada:F4BE9CD91E6B680A0 | transfer 24,219,192 → 24h -1.1% | _none_ | — | — | yes |
| whale_namada:FE56A2F79DEB8D2D6 | unshield 15,000,000 → 24h — | unshield, liquidity, big_swap, ibc_inventory | 2026-11-01 07:26 | 25.7 h | yes |
| whale_namada:73F34473799569B9E | shield 5,336,700 → 24h +0.1% | liquidity, unshield, unlock | 2026-10-22 14:19 | 42.7 h | yes |
| whale_namada:CD3887C28933F3ADC | withdraw 5,265,682 → 24h +70.9% | _none_ | — | — | yes |
| whale_namada:6B46718DF86FD594C | withdraw 5,250,000 → 24h -2.9% | bond, unlock | 2026-09-18 19:54 | 26.7 h | yes |
| whale_namada:A50B97AA03DC936EB | unshield 4,500,000 → 24h — | liquidity, big_swap, unshield, ibc_inventory | 2026-11-01 07:26 | 24.6 h | yes |
| whale_namada:061AE0D18FE0E61D9 | bond 3,200,000 → 24h -2.9% | bond, unlock | 2026-09-18 19:54 | 26.7 h | yes |
| whale_namada:2ADD06BD3B7D403E8 | bond 2,500,000 → 24h -2.9% | unlock, bond | 2026-09-18 19:54 | 26.7 h | yes |
| whale_namada:F52195AB230103F3C | bond 2,500,000 → 24h -2.9% | bond, unlock | 2026-09-18 19:54 | 26.6 h | yes |
| whale_namada:0B4F50FFBBE39D695 | bond 2,500,000 → 24h -2.9% | unlock | 2026-09-18 19:54 | 26.6 h | yes |
| whale_osmosis:0CE000F67A64FC32 | ibc_in 2,300,000 → 24h -6.9% | unshield, liquidity, big_swap, ibc_inventory, unlock | 2026-10-30 16:42 | 45.8 h | yes |
| whale_namada:C9402B75D58A282AD | ibc_out 2,300,000 → 24h -6.9% | unshield, liquidity, big_swap, ibc_inventory, unlock | 2026-10-30 16:42 | 45.8 h | yes |

## Misses

_none_

## Caveats

- Prices are hourly medians of executed swaps; hours without trades have no point, so some "moves" span many hours and the lead time is an upper bound.
- Osmosis flows older than ~2026-08-30 carry extrapolated timestamps (see the "exact times" column).
- The arb-exclusion rule depends on `meta.arb`, which the Osmosis parser sets only for round-trips within one tx.
