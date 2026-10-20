# Event replay set (Phase 1)

Generated 2026-10-17 01:39 UTC from D1. Price = hourly median of executed single-pool NAM/USDC swaps (104 points, 2026-08-12 11:00 → 2026-10-16 12:00); hours with no swap have no point, so a "move" can span several hours.

## Largest price moves

| # | window (UTC) | move | lead signals ≥5k NAM in prior 48h |
|---|---|---|---|
| 1 | 2026-09-19 02:00 → 2026-09-19 11:00 | +35.7% | withdraw 5,265,682 Namada PoS (bonded + unbondi→tnam1qr8x5…n9k3; bond 350,000 tnam1qrer2…c7r0→Namada PoS (bonded + unbondi; bond 21,090 tnam1qzx8j…77dw→Namada PoS (bonded + unbondi |
| 2 | 2026-08-26 09:00 → 2026-08-28 09:00 | -26.5% | sell 169,339 osmo1dvypt…sjfg→—; ibc_in 169,210 Genesis: public_allocations_→osmo1dvypt…sjfg; ibc_out 169,210 Genesis: public_allocations_→osmo1dvypt…sjfg; ibc_in 169,210 Namada IBC escrow→Genesis: public_allocations_ |
| 3 | 2026-10-04 14:00 → 2026-10-05 12:00 | +21.2% | sell 25,734 osmo18tg85…w57u→—; buy 14,144 —→osmo174ml5…3req; buy 13,185 —→osmo174ml5…3req |
| 4 | 2026-09-29 00:00 → 2026-09-30 01:00 | +20.8% | buy 20,551 —→osmo165wjk…kqly; sell 12,006 osmo1xw8zg…d7sy→—; buy 11,231 —→osmo165wjk…kqly; buy 7,212 —→osmo165wjk…kqly |
| 5 | 2026-09-11 15:00 → 2026-09-12 07:00 | -20.2% | sell 32,140 osmo1src4x…dqcd→—; sell 10,808 osmo1th5pf…y52d→—; buy 5,966 —→osmo10rgr9…3t6y; buy 5,146 —→osmo1wn33d…2lpe |
| 6 | 2026-08-29 21:00 → 2026-08-30 16:00 | -17.9% | bond 45,000 tnam1qz0ny…99kz→Namada PoS (bonded + unbondi; withdraw 44,864 Namada PoS (bonded + unbondi→tnam1qz0ny…99kz; sell 33,287 osmo1m967t…6xhs→—; bond 10,500 Genesis: pg_validators, publ→Namada PoS (bonded + unbondi |
| 7 | 2026-09-21 18:00 → 2026-09-23 12:00 | +15.5% | pos_balance 100,000,000 tnam1qrk5p…mlse→Namada PoS (bonded + unbondi; pos_balance 100,000,000 tnam1qrk5p…mlse→Namada PoS (bonded + unbondi; pos_balance 99,999,900 tnam1qrk5p…mlse→Namada PoS (bonded + unbondi; pos_balance 29,386,967 tnam1qrk5p…mlse→Namada PoS (bonded + unbondi |
| 8 | 2026-10-12 14:00 → 2026-10-12 17:00 | -14.4% | ibc_out 140,233 osmo1mpgtk…m5tg→Genesis: public_allocations_; ibc_out 140,233 osmo1mpgtk…m5tg→Genesis: public_allocations_; unbond 37,489 Namada PoS (bonded + unbondi→tnam1qztcy…86l9; sell 31,482 osmo1w7qun…fcmp→— |
| 9 | 2026-09-24 13:00 → 2026-09-25 07:00 | -14.3% | bond 300,000 tnam1qrw78…8gdh→Namada PoS (bonded + unbondi; ibc_in 265,370 osmo1wn33d…2lpe→Genesis: public_allocations_; ibc_out 265,370 osmo1wn33d…2lpe→Genesis: public_allocations_; ibc_in 200,000 osmo1wn33d…2lpe→tnam1qrw78…8gdh |
| 10 | 2026-09-19 13:00 → 2026-09-20 10:00 | +13.6% | withdraw 5,265,682 Namada PoS (bonded + unbondi→tnam1qr8x5…n9k3; withdraw 5,250,000 Namada PoS (bonded + unbondi→tnam1qr8x5…n9k3; bond 3,200,000 tnam1qr8x5…n9k3→Namada PoS (bonded + unbondi; bond 2,500,000 tnam1qr8x5…n9k3→Namada PoS (bonded + unbondi |

## Largest single flows and what price did next

| flow (UTC) | kind | NAM | from → to | 24h | 72h |
|---|---|---|---|---|---|
| 2026-08-31 23:35 | pos_balance | 331,386,682 | Namada PoS (bonded + unbondi → tnam1qry99…6dqp | +10.3% | +10.8% |
| 2026-09-03 17:24 | transfer | 125,295,685 | tnam1qry99…6dqp → tnam1qrk5p…mlse | -5.5% | -4% |
| 2026-09-22 17:20 | pos_balance | 100,000,000 | tnam1qrk5p…mlse → Namada PoS (bonded + unbondi | +20.7% | -3.9% |
| 2026-09-22 17:19 | pos_balance | 100,000,000 | tnam1qrk5p…mlse → Namada PoS (bonded + unbondi | +20.7% | -3.9% |
| 2026-09-03 16:23 | transfer | 100,000,000 | tnam1qry99…6dqp → tnam1qrk5p…mlse | -5.5% | -4% |
| 2026-09-22 17:17 | pos_balance | 99,999,900 | tnam1qrk5p…mlse → Namada PoS (bonded + unbondi | +20.7% | -3.9% |
| 2026-09-03 16:16 | transfer | 59,000,000 | tnam1qry99…6dqp → tnam1qrk5p…mlse | -5.5% | -4% |
| 2026-09-01 00:11 | shield | 50,000,000 | tnam1qry99…6dqp → MASP shielded pool | +10.3% | +10.8% |
| 2026-09-02 12:04 | ibc_out | 40,001,306 | osmo1lspwv…2f6x → MASP shielded pool | +12.6% | +7.5% |
| 2026-09-22 17:21 | pos_balance | 29,386,967 | tnam1qrk5p…mlse → Namada PoS (bonded + unbondi | +20.7% | -3.9% |
| 2026-08-25 07:19 | transfer | 24,219,192 | tnam1qq9lf…mlla → tnam1qqzg5…f0pa | -1.1% | -27.3% |
| 2026-09-03 15:48 | ibc_out | 20,000,000 | osmo1lspwv…2f6x → MASP shielded pool | -5.5% | -4% |

**Base rate:** a flow ≥ 10,000 NAM (non-arb) occurred in the 48h before 90% of all 104 price points. Any "flagged" rate must be read against this.

Full detail, including every lead signal with its timestamp source, is in [events.json](events.json). The replay harness (`npm run test:replay`) scores the alert rules against this file.

_2026-10-20: the nine flows of 31 Aug, 22 Sep and 1 Oct 2026 between the staking account and tnam1qry99…6dqp / tnam1qrk5p…mlse (descriptor `transfer-from-wasm`) are filed as `pos_balance`, a transfer of the staking account's own balance, instead of withdraw and bond (docs/design/screener-plan.md 3.0); the kinds above and in events.json were changed in place, nothing else was regenerated._
