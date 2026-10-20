# Review: feat/deep-protocol-intelligence before merge

Reviewed 2026-10-19 (evening) in the worktree `.claude/worktrees/deep-protocol-intelligence`, commit 6488999
"Add consensus unbond term structure, MASP turnstile linker, 2-hop attribution, TWAP burst detection, and CL
cliff analytics", stacked on `security/audit-fixes` (eccb451 on ef5a88c) with `origin/main` at 9b0235b. Every
worktree, branch and commit the request named exists as described (`git worktree list`, `git log --oneline`).
Diff reviewed: `security/audit-fixes..feat/deep-protocol-intelligence` (7 files, +1,148 / −49) and
`origin/main..feat/deep-protocol-intelligence` (30 files). The branch changes the worker and shared types only;
no web file changes.

## Results

| Check | Result |
| --- | --- |
| `npm run typecheck` (worker + web) | clean, exit 0 |
| `npx vitest run` | 25 files, 316 tests, all pass (matches the request's expectation) |
| `shared/alerts.ts` under Node (`node --experimental-strip-types`) | loads; the only import is `import type` (alerts.ts:7) |

**Recommendation: merge after fixes.** The borsh decoding is correct and well bounded. The analytics on top of
it have five concrete defects, each reproduced below with a failing input and each a few lines to fix: an invented
21,600 s epoch when the chain parameters are missing (the project's no-fallback rule), a double-counted sale in the
two-hop attribution, a dust transfer naming a bridge's "origin", a wrong marginal-slippage figure when one rung
lacks a sell quote, and a term structure served without a freshness gate. Three of the five advertised upgrades
in item 4 are library code with tests and no production call site. Fix list at the end.

## Upgrade 1: consensus unbond and slash decoding

**Verified**, with two wrong parts.

- Layout. `parseBondListing` (worker/src/sources/namada.ts:510) reads each unbond as `u64 start, u64 withdraw,
  Amount(32), Option<Amount>` (namada.ts:537-561) and each slash as `u64 epoch, u64 block, u8 type, 32 bytes rate`
  (namada.ts:563-571). Byte for byte this equals what the old `b.skip(16); b.skip(32); if (u8===1) skip(32)` and
  `skip(16); u8(); skip(32)` consumed, and it matches `BondsAndUnbondsDetail` (UnbondDetails, Slash). The
  mainnet fixture decodes with no unread bytes (namada.ts:431 would throw): 48 entries, 38 unbond items over 6
  sources, 42 slash records.
- Bounds. `u64()` (namada.ts:345) reads through the `DataView`, which throws `RangeError` past the end, exactly
  as the pre-existing `u32()` does; `amount()`, `u8()` and `address()` go through `take()` (namada.ts:338). Counts
  only drive loops: every unbond iteration consumes at least 49 bytes and every slash 49 bytes before anything is
  pushed, so a hostile count cannot allocate beyond the input size. A cut or malformed answer throws; `runBondListing`
  catches it, pushes `ok: false` health and writes `failedAt`/`error` to `bond.listing` (cron.ts:456-462) with no
  invented value. `Number()` of a u64 is exact below 2^53, fine for epochs and heights.
- Cron. `unbond.term_structure` and `unbond.withdraw` are written when the listing completes (cron.ts:501-512),
  `unbondingNam` lands on the record (cron.ts:473) and the coverage check reports `unbondingNam` and
  `posAccountedNam` (cron.ts:606-607). The per-address indexer fallback is skipped while `completeAt` is younger than
  3 × BOND_LISTING_MS (cron.ts:949-950). `pressure()` returns `unbondTermStructure` (analytics.ts:720) and
  `liquidAtSource: 'consensus'` when the cache entry says so (analytics.ts:581-586).

**Wrong 1a: an invented epoch length.** `buildUnbondTermStructure` defaults `epochSec` to 21600 and substitutes
21600 for any null or non-positive value (analytics.ts:286, 288); the cron passes `21600` when the chain parameters
cannot be read (cron.ts:504). Every `withdrawTime` and bucket `estimatedAt` is `now + epochsRemaining × 21600 s`
(analytics.ts:309). Failing input (run in a throwaway vitest file, since deleted): the mainnet fixture plus one
in-flight unbond of 150,000 NAM at withdraw epoch 2712, current epoch 2690, no `chain.params` row. `runBondListing`
writes `withdrawTime = now + 132 h`; `pressure()` then serves the unlock with `liquidAt = now + 132 h` and
`liquidAtSource: 'consensus'` while the same response says `unbondingProv.status: 'missing'`, `chainParams: null`,
`unbondingDays: null`. The existing path (`unbondingWait`, analytics.ts:368) returns null here and the unlock shows
"Wait not known"; the new path invents the time. On mainnet 21600 s happens to equal `minEpochSec`, so the number is
not absurd, but it is a fallback the owner's rules forbid, and the label "consensus" is wrong for it: only the epoch is
consensus, the clock time is an estimate from the epoch length (real epochs run longer than 6 h, see
`epochSecNote`). The `UnbondMaturityBucket.estimatedAt` type already allows null; use it.

**Wrong 1b: no freshness gate.** `pressure()` spreads whatever `unbond.term_structure` holds (analytics.ts:720).
Failing input: a row written 30 days ago (`at = asOf − 30 d`) is returned unchanged, with no status, while every
other current reading in the same response goes through `provAt` with a max age. When the listing starts failing
(gate refusals, node outages) the last term structure keeps being served as "consensus-verified". The old
`unbond.withdraw` had the same gap, but it was refreshed every 10 minutes; now the cache is rewritten only when a
listing completes (every 40 to 80 minutes, since the two listings never share a tick) and the indexer refresh is
suppressed meanwhile.

Smaller points on upgrade 1:
- `slashes[].rateBase` is read with `amount()` and named like a token amount (namada.ts:569); the field is a
  12-decimal `Dec` (fixture value 1e12 = rate 1.0, a 100 % slash). Nothing consumes it yet; rename or document
  before anything does. The 42 records are the validator's 14 slashes repeated for each of 3 sources, so summing
  them would overcount.
- `const unbondingNam = listing.unbondingBase != null ? … : 0` (cron.ts:473) is a `0` fallback; unreachable with
  the real parser, but leave the field undefined instead of 0 so `posAccountedNam` cannot be silently wrong.
- `unbond.withdraw` now holds every unbond on the chain (not the ≤60 unlock-list addresses) and `pressure()`
  parses the whole blob per request. Size on mainnet is unmeasured here (D1's row limit is 2 MB); worth one live
  measurement.
- The health line "Namada indexer (unbond withdraw times)" is no longer pushed while consensus is fresh, and
  `mergeHealth` keeps a probe's last result (cron.ts:985-990), so the Sources sheet will show that probe with a
  timestamp that stops advancing. Either push a note or retire it.
- Freshness regression for brand-new unbonds: between listings a fresh unbond has no consensus entry and the
  indexer refresh is skipped, so it shows `estimate` for up to ~80 minutes where it used to get the indexer's time
  within 10. Acceptable, but say so somewhere.
- Web: `Unlocks.tsx:32` only knows 'indexer' and 'estimate'; a 'consensus' time renders with no explanation.
- The branch test's consensus assertion never runs: every fixture unbond is already withdrawable at epoch 2690 and
  the largest is 20,000 NAM, below the 100,000 NAM list floor, so `if (sampleUnbond.amountNam >= 100_000)`
  (test/deep-intelligence.test.ts:93) is false and the `liquidAtSource: 'consensus'` path is untested on the branch.

## Upgrade 2: MASP turnstile correlation

**Verified** as a matcher; labelled as an inference in types, not at runtime; not consumed by the UI.

- One-to-one: each inflow index goes into `usedIn` once (analytics.ts:776) and each outflow yields at most one link.
- Window and tolerance as stated: `dwellMs` in [0, 24 h] and `|in − out| / in ≤ 0.005` (analytics.ts:741-770).
  The "fee side-leg" asymmetry check (`out ≤ in × 1.005`) is implied by the relDiff test, so the tolerance is
  symmetric ±0.5 %; the comment overstates it.
- `anonymitySetK` counts every inflow in the window within tolerance, used or not (analytics.ts:770); confidence
  is high only for k = 1, dwell ≤ 6 h, relDiff ≤ 0.1 %.
- `blindSpot()` adds `passthroughs7d`, `turnstileNam7d`, `stickySharePct7d` (analytics.ts:867-871) over legs
  already bounded to the 7-day MASP query; no new SQL. The matcher is O(ins × outs) over those legs.
- Inference labelling: the type docs say "Probabilistic" (types.ts:460, 500) and every link carries `confidence`,
  `anonymitySetK` and `relDiff`; there is no runtime `inferred`/source marker and no Provenance. Since no web
  screen reads these fields yet, nothing user-facing claims them as fact. If a screen ever does, the links name a
  specific address as the probable source of a shielded withdrawal, so they need the inference wording and the
  confidence on every row, per the provenance rule.
- Coverage gap to know: Namada-recorded crossings into the pool have `from = IBC escrow` (an internal address),
  so they are filtered out of the inflow side (analytics.ts:747); an osmo → MASP → out passthrough is only matched
  when Namada missed the receive and the Osmosis record stood in. `OnDeckEntry.passthroughFrom` (types.ts:307) is
  declared and never populated.

## Upgrade 3: two-hop burner attribution

**Wrong in one case; "within 48 h" not as described.**

- No overlap between direct and hop flows: direct follow-ups are `bond | ibc_out | shield` from the withdrawer
  (analytics.ts:600) and `transfer` is not among them, so a vault → burner → bridge path is counted once, via the hop.
  Burners that are themselves withdrawers are excluded (analytics.ts:615). `allocateFollowUps` caps each withdrawal
  at its own amount on both levels. Verified.
- **Wrong 3a: a shared Osmosis link counts one sale twice.** Direct sales come from the vault's `address_links`
  osmo address (`osmoOf`), hop sales from the burner's (`burnerOsmo`, analytics.ts:623), and nothing removes an
  osmo address present in both. Failing input: vault withdraws 300,000; `address_links` maps `osmo1shared` to both
  the vault and the burner (one Osmosis account funded from both); vault transfers 200,000 to the burner;
  `osmo1shared` sells 100,000 once. `pressure().unlocks[].outcome` = `{ kind: 'sold', amountNam: 200000 }` for a
  single 100,000 NAM sale (reproduced). Fix: drop from `burnerOsmo` any osmo address already in `osmoOf.values()`
  (or the reverse), so each Osmosis seller is attributed through one path.
- **Wrong 3b: on-deck `hopOriginNamada` has no time or size bound.** The query (analytics.ts:506-510) takes any
  `transfer` into the burner between `from − 48 h` and `asOf` (up to 9 days with the 7-day window) and picks the
  largest sender; the comment and types.ts:302 promise "within 48 h before bridging". Failing input: the burner got
  a 0.5 NAM transfer from a labelled genesis address 8 days ago, was funded by a 400,000 NAM unshield today and
  bridged it. `onDeck[].hopOriginNamada` = the dust sender, with its "Early backers (genesis)" label, and
  `dumpHazardScore` gets the +0.1 hop boost (reproduced). `reconstructIntentChains` applies a 10,000 NAM floor for
  the same hop (alerts.ts:319); `pressure()` applies none. Fix: bound the transfer to the 48 h before the entry's
  `first_ts` and require a meaningful amount (a floor, or a share of `bridgedIn`).
- Hop timing: the hop move is stamped with the transfer time (analytics.ts:648), so the vault's 48 h window runs
  withdraw → transfer and the burner's 48 h runs transfer → move, up to 96 h end to end. Document or tighten.
- `dumpHazardScore` (analytics.ts:536-538) is `0.7 × (sold + priorSells + 5,000) / (bridged + priorSells + 25,000)`
  plus fixed boosts. The pseudo-counts and boosts are hand-set, nothing is estimated from data, so "Empirical
  Bayesian Beta-Binomial" (types.ts:309) overclaims; it is a heuristic score with no provenance field. Label it
  as such or leave it out of the public response until it is calibrated against `docs/replay-report.md`.

## Upgrade 4: TWAP bursts, cross-block arb filter, intent chains

**Verified as library code; not wired into production.**

- `detectCrossBlockArbTraders`: `1 − |buy − sell| / (buy + sell)` with ≥ 6 swaps on both sides and ≥ 0.85
  (alerts.ts:176, 201); the same formula annotates movers in `pressure()` (analytics.ts:682-683) over swap rows
  that already exclude atomic `meta.arb`.
- `detectTwapBursts`: ≥ 3 same-direction clips each `< th.bigSwap`, within 2 h, summing `≥ th.bigSwap`,
  consumed once per burst (alerts.ts:213-262).
- `liquidityNormalizedThresholds` and `reconstructIntentChains` as described (alerts.ts:145, 306).
- `shared/alerts.ts` stays free of value imports (alerts.ts:7) and loads under Node directly; `npm run gen`
  (scripts/export-proof.ts) is unaffected.
- Not wired: no route, cron or alert path calls `detectTwapBursts`, `reconstructIntentChains` or
  `liquidityNormalizedThresholds` (grep over worker/, web/, shared/, scripts/: tests only). `'twap_burst'` is not in
  `RULES`, so `alertRules()` would not list it if it were. The commit message and request describe these as
  upgrades; today they change nothing a user sees.
- Nits in `reconstructIntentChains`: `dumpHazardScore` is four constants plus boosts, not "calibrated"
  (alerts.ts:295); `bridgedNam = Math.max(…)` (alerts.ts:407) collapses two separate crossings into the larger
  one, and the "within 15 m" pairing in the comment is not implemented; a chain older than the window is replaced
  in the map and dropped from the output.

## Upgrade 5: concentrated-liquidity tick-cliff detector

**Verified for complete ladders; wrong when a rung lacks a sell quote.**

- No division by zero: `dNam > 0` guards the sell slice (sqs.ts:283), `dBuyNam > 0` and `dBuyUsdc > 0` the buy
  slice, `spotUsd > 0` the impact, and the 2.5× ratio is only taken when `prevMarginalImpact > 0` (sqs.ts:305),
  else the ≥ 5 % absolute rule applies. Duplicate rungs give null marginals.
- **Wrong 5a.** `prevNam` advances on every rung (sqs.ts:314) but `prevSellUsdc` only on rungs with a sell quote
  (sqs.ts:289). `buildCurve` writes `sellOutUsdc: null` whenever SQS fails that tier's sell quote (sqs.ts:350),
  which its own tests show happens under the per-IP limit. Failing input: rungs 1,000 ($0.998), 5,000 (sell null),
  10,000 ($9.92), spot $0.001. The 10,000 rung gets `marginalSellUsd = (9.92 − 0.998) / 5,000 = 0.00178`, above
  spot, so `marginalSellImpactPct` is clamped to 0 % where the true 1,000 → 10,000 slice is 0.89 % (reproduced).
  Fix: keep a `prevSellNam` that advances only inside the sell branch, as the buy side already does with
  `prevBuyNam`.
- `marginalSellUsd = Math.max(0, …)` (sqs.ts:285) silently zeroes a negative slice (non-monotone quotes); a null
  with a note would follow the project's style better.
- Web consumers of the curve (web/src/ui/curveMath.ts, web/src/ui/OrderSizeCurve.tsx, web/src/screens/trade/model.ts)
  typecheck and ignore the new optional fields; nothing renders `liquidityCliffNam` or `cliffNote` yet.

## Item 6: existing API and test contracts

**Verified.** Every new response field is optional (`?`) in shared/types.ts (302-309, 326-333, 382-384, 438,
460-504, 637-641, 681-682); `liquidAtSource` gains a union member (types.ts:359) that the web ignores rather than
breaks (Unlocks.tsx:32 shows no source wording for it). `withPressure` (web/src/lib/compat.ts:132) spreads unknown
fields through. The routes return the analytics objects as before (worker/src/api.ts:264-272, 470). No existing
route's shape changed; no existing test changed.

## Cross-cutting checks

- SQL bounds and indexes. New statements are in `pressure()` only: hop origins (`to_addr IN (≤40) AND ts range`,
  flows_to), withdrawer transfers (`from_addr IN (≤60)`, flows_from), burner follow-ups and links (`≤40`, flows_from
  and links_namada), burner sales (`from_addr IN`, flows_from). All carry a time window and an IN list bounded by an
  earlier `LIMIT` (40 receivers, 60 unlock rows, `.slice(0, 40)` burners); the largest bind count is 62, under D1's
  100. No SQL was added to `cron.ts` or `shared/alerts.ts`.
- Provenance. `turnaroundRatio`/`crossBlockArb` derive from rows already in the response; `liquidityCliffNam`
  sits under the curve's `prov`; `unbondTermStructure` has `at`, `height`, `currentEpoch` but no status (1b);
  `passthroughs7d` has `confidence` and `anonymitySetK` but no source marker; `dumpHazardScore` and
  `hopOriginNamada` have none.
- Invented values: the 21600 s epoch (1a) and the `: 0` unbondingNam (unreachable) are the two; a failed listing is
  otherwise recorded as a failure, not a number.
- The worktree had no uncommitted changes at review start. Running the suite rewrites `docs/replay-report.md`'s
  timestamp (test/replay.test.ts:56); that change was reverted after the run so the worktree is as found.

## Fixes before merge

1. analytics.ts:286-288, 309 and cron.ts:504: no 21600 default. When `cachedChainParams` is null, write
   `withdrawTime`/`estimatedAt` as null (or skip the consensus `unbond.withdraw` write and let the indexer path
   run), and say in `UnbondTermStructure` that `estimatedAt` is epoch × measured epoch length, with its source.
2. analytics.ts:720: gate `unbondTermStructure` on `asOf − at` (3 × BOND_LISTING_MS, like `bondedCoverageCheck`)
   or attach a Provenance with `stale`/`missing`.
3. analytics.ts:623: exclude from `burnerOsmo` any osmo address already in `osmoOf.values()`.
4. analytics.ts:506-510: bound hop transfers to 48 h before the entry's `first_ts` and add an amount floor.
5. sqs.ts:283-314: advance the sell-side baseline only when the rung has a sell quote.
6. Unlocks.tsx:32: wording for `'consensus'` ("withdraw epoch from the chain, time estimated from the epoch length").
7. Optional: rename `rateBase`; leave `unbondingNam` undefined instead of 0; add a health note for the skipped
   indexer probe; add a test with an in-flight unbond ≥ 100,000 NAM so the consensus `liquidAt` path is exercised;
   state in the commit or docs that the item-4 detectors are not yet wired.

Nothing was merged, deployed, or run against the remote D1. The only change on this branch from the review is this
file.
