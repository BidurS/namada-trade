# Replay report

Generated 2026-10-20 06:00 UTC by `test/replay.test.ts` from `docs/events.json` (22 events, 104 price points) with default thresholds {"ibcInventory":25000,"unlock":100000,"bigSwap":10000,"unshield":50000,"bond":1000000}.

**Price moves flagged ahead of time: 10 / 10.** Median lead 25.0 h; range 2.0–47.4 h.

A "flag" means at least one alert rule fired on a flow in the 48h before the move completed. It does not mean the rule predicted the direction: the table shows what fired so you can judge that yourself.

**Base rate:** 90% of all price points had an alert-size flow (≥ 10,000 NAM) in the prior 48h. Flagging 10/10 moves is only informative to the extent it beats that; the lead-time and rule columns are the useful part.

| event | move | rules fired | first alert | lead | exact times |
|---|---|---|---|---|---|
| price_2026-09-19T11 | +35.7% | unlock | 2026-09-18 19:54 | 15.1 h | yes |
| price_2026-08-28T09 | -26.5% | big_swap, ibc_inventory | 2026-08-27 12:53 | 20.1 h | yes |
| price_2026-10-05T12 | +21.2% | big_swap | 2026-10-04 11:01 | 25.0 h | yes |
| price_2026-09-30T01 | +20.8% | big_swap | 2026-09-28 16:24 | 32.6 h | yes |
| price_2026-09-12T07 | -20.2% | big_swap | 2026-09-11 18:31 | 12.5 h | yes |
| price_2026-08-30T16 | -17.9% | big_swap | 2026-08-29 19:05 | 20.9 h | yes |
| price_2026-09-23T12 | +15.5% | big_swap, bond, unlock | 2026-09-21 12:38 | 47.4 h | yes |
| price_2026-10-12T17 | -14.4% | big_swap | 2026-10-12 15:00 | 2.0 h | yes |
| price_2026-09-25T07 | -14.3% | big_swap | 2026-09-23 08:44 | 46.3 h | yes |
| price_2026-09-20T10 | +13.6% | big_swap, bond, unlock | 2026-09-18 19:54 | 38.1 h | yes |
| whale_namada:6C1989767A6939F9A | withdraw 331,386,682 → 24h +10.3% | unlock, big_swap | 2026-08-30 19:05 | 28.5 h | yes |
| whale_namada:9E232C836A370C386 | transfer 125,295,685 → 24h -5.5% | unshield, big_swap | 2026-09-01 17:37 | 47.8 h | yes |
| whale_namada:5F9E44142731CC939 | bond 100,000,000 → 24h +20.7% | bond, big_swap, unlock | 2026-09-20 23:14 | 42.1 h | yes |
| whale_namada:3B6C6C648886F5C2D | bond 100,000,000 → 24h +20.7% | bond, big_swap, unlock | 2026-09-20 23:14 | 42.1 h | yes |
| whale_namada:3B9BD4D7C277F69D3 | transfer 100,000,000 → 24h -5.5% | big_swap | 2026-09-01 17:37 | 46.8 h | yes |
| whale_namada:59AA5A3380F104710 | bond 99,999,900 → 24h +20.7% | big_swap, unlock | 2026-09-20 23:14 | 42.0 h | yes |
| whale_namada:024B84A6711C72687 | transfer 59,000,000 → 24h -5.5% | big_swap | 2026-09-01 17:37 | 46.7 h | yes |
| whale_namada:8CA6BBDD7B6D52B2A | shield 50,000,000 → 24h +10.3% | unlock, big_swap | 2026-08-30 19:05 | 29.1 h | yes |
| whale_osmosis:5E09118DB414150A | ibc_out 40,001,306 → 24h +12.6% | big_swap, ibc_inventory, unlock | 2026-08-31 23:32 | 36.5 h | yes |
| whale_namada:192A229ECB1C195D1 | bond 29,386,967 → 24h +20.7% | bond, big_swap, unlock | 2026-09-20 23:14 | 42.1 h | yes |
| whale_namada:54966349077EC5639 | transfer 24,219,192 → 24h -1.1% | _none_ | — | — | yes |
| whale_osmosis:844177EE91643B21 | ibc_out 20,000,000 → 24h -5.5% | big_swap | 2026-09-01 17:37 | 46.2 h | yes |

## Misses

_none_

## Caveats

- Prices are hourly medians of executed swaps; hours without trades have no point, so some "moves" span many hours and the lead time is an upper bound.
- Osmosis flows older than ~2026-08-30 carry extrapolated timestamps (see the "exact times" column).
- The arb-exclusion rule depends on `meta.arb`, which the Osmosis parser sets only for round-trips within one tx.
