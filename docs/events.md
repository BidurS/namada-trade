# Event replay set (Phase 1)

Generated 2026-11-02 16:10 UTC from D1. Price = hourly median of executed single-pool NAM/USDC swaps (216 points, 2026-08-11 04:00 → 2026-11-02 15:00); hours with no swap have no point, so a "move" can span several hours.

## Largest price moves

| # | window (UTC) | move | lead signals ≥5k NAM in prior 48h |
|---|---|---|---|
| 1 | 2026-10-21 14:00 → 2026-10-21 15:00 | +112.2% | unshield 1,600,000 MASP shielded pool→tnam1qzdxr…8su2; ibc_in 1,500,000 tnam1qzdxr…8su2→osmo1nn62s…vpvh; ibc_out 1,500,000 tnam1qzdxr…8su2→osmo1nn62s…vpvh; sell 791,848 osmo1nn62s…vpvh→— |
| 2 | 2026-10-21 13:00 → 2026-10-21 14:00 | -85.5% | unshield 1,600,000 MASP shielded pool→tnam1qzdxr…8su2; ibc_in 1,500,000 tnam1qzdxr…8su2→osmo1nn62s…vpvh; ibc_out 1,500,000 tnam1qzdxr…8su2→osmo1nn62s…vpvh; sell 99,002 osmo1nn62s…vpvh→— |
| 3 | 2026-10-21 17:00 → 2026-10-21 18:00 | +64% | unshield 1,600,000 MASP shielded pool→tnam1qzdxr…8su2; ibc_in 1,500,000 tnam1qzdxr…8su2→osmo1nn62s…vpvh; ibc_out 1,500,000 tnam1qzdxr…8su2→osmo1nn62s…vpvh; sell 791,848 osmo1nn62s…vpvh→— |
| 4 | 2026-08-19 19:00 → 2026-08-19 21:00 | +38.8% | ibc_in 247,335 tnam1qz4nr…e7ng→osmo1w785z…hg3q; ibc_out 247,335 tnam1qz4nr…e7ng→osmo1w785z…hg3q; lp_remove 149,022 —→osmo1tqajw…uau9; sell 69,451 osmo1w785z…hg3q→— |
| 5 | 2026-08-19 12:00 → 2026-08-19 19:00 | -36.9% | ibc_in 247,335 tnam1qz4nr…e7ng→osmo1w785z…hg3q; ibc_out 247,335 tnam1qz4nr…e7ng→osmo1w785z…hg3q; shield 150,000 Genesis: public_allocations_→MASP shielded pool; lp_remove 149,022 —→osmo1tqajw…uau9 |
| 6 | 2026-09-19 02:00 → 2026-09-19 11:00 | +34.7% | withdraw 5,265,682 Namada PoS account (staked +→tnam1qr8x5…n9k3; bond 350,000 tnam1qrer2…c7r0→Namada PoS account (staked +; bond 21,090 tnam1qzx8j…77dw→Namada PoS account (staked + |
| 7 | 2026-10-19 12:00 → 2026-10-19 18:00 | -30.8% | unshield 60,000 MASP shielded pool→tnam1qpy8m…2cf3; unshield 30,000 MASP shielded pool→tnam1qpy8m…2cf3; ibc_in 30,000 osmo1vkyae…lrl4→MASP shielded pool; ibc_out 30,000 osmo1vkyae…lrl4→MASP shielded pool |
| 8 | 2026-10-26 20:00 → 2026-10-27 08:00 | -28.8% | ibc_in 434,000 tnam1qzdxr…8su2→osmo1nn62s…vpvh; ibc_out 434,000 tnam1qzdxr…8su2→osmo1nn62s…vpvh; unshield 334,000 MASP shielded pool→tnam1qzdxr…8su2; bond 70,000 tnam1qztcy…86l9→Namada PoS account (staked + |
| 9 | 2026-10-19 06:00 → 2026-10-19 09:00 | +26.8% | unshield 60,000 MASP shielded pool→tnam1qpy8m…2cf3; ibc_out 25,000 osmo1vkyae…lrl4→MASP shielded pool; ibc_in 25,000 osmo1vkyae…lrl4→MASP shielded pool; withdraw 23,000 Namada PoS account (staked +→tnam1qp0zh…5z4q |
| 10 | 2026-10-19 18:00 → 2026-10-19 20:00 | +26.2% | sell 68,295 osmo12laa7…fer4→—; unshield 60,000 MASP shielded pool→tnam1qpy8m…2cf3; sell 54,440 osmo1g798y…vcyy→—; ibc_in 30,000 osmo1vkyae…lrl4→MASP shielded pool |

## Largest single flows and what price did next

| flow (UTC) | kind | NAM | from → to | 24h | 72h |
|---|---|---|---|---|---|
| 2026-08-25 07:19 | transfer | 24,219,192 | tnam1qq9lf…mlla → tnam1qqzg5…f0pa | -1.1% | -26.3% |
| 2026-11-02 09:08 | unshield | 15,000,000 | MASP shielded pool → tnam1qzsul…e6d3 | — | — |
| 2026-10-24 09:03 | shield | 5,336,700 | tnam1qr8pz…suqg → MASP shielded pool | +0.1% | -14.4% |
| 2026-09-18 19:54 | withdraw | 5,265,682 | Namada PoS account (staked + → tnam1qr8x5…n9k3 | +70.9% | +69.2% |
| 2026-09-19 22:33 | withdraw | 5,250,000 | Namada PoS account (staked + → tnam1qr8x5…n9k3 | -2.9% | +12.1% |
| 2026-11-02 08:04 | unshield | 4,500,000 | MASP shielded pool → tnam1qzdxr…8su2 | — | — |
| 2026-09-19 22:36 | bond | 3,200,000 | tnam1qr8x5…n9k3 → Namada PoS account (staked + | -2.9% | +12.1% |
| 2026-09-19 22:34 | bond | 2,500,000 | tnam1qr8x5…n9k3 → Namada PoS account (staked + | -2.9% | +12.1% |
| 2026-09-19 22:32 | bond | 2,500,000 | tnam1qr8x5…n9k3 → Namada PoS account (staked + | -2.9% | +12.1% |
| 2026-09-19 22:29 | bond | 2,500,000 | tnam1qr8x5…n9k3 → Namada PoS account (staked + | -2.9% | +12.1% |
| 2026-11-01 14:29 | ibc_in | 2,300,000 | tnam1qzdxr…8su2 → osmo1nn62s…vpvh | -6.9% | — |
| 2026-11-01 14:29 | ibc_out | 2,300,000 | tnam1qzdxr…8su2 → osmo1nn62s…vpvh | -6.9% | — |

**Base rate:** a flow ≥ 10,000 NAM (non-arb) occurred in the 48h before 93% of all 216 price points. Any "flagged" rate must be read against this.

Full detail, including every lead signal with its timestamp source, is in [events.json](events.json). The replay harness (`npm run test:replay`) scores the alert rules against this file.
