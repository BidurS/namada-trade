# Timed task tests

Generated 2026-10-16 13:39 UTC. Answers computed from D1 and the Osmosis router at that time; re-run the script before a session so the answers are current.

## Protocol

1. One trader, one screen, a stopwatch. Three conditions, order randomised per trader: (A) old NamadaTrade UI (git tag `ui-v1`), (B) new UI, (C) app.osmosis.zone + namada.valopers.com / mintscan.
2. Read the question aloud; start the clock; stop when the trader states an answer. Record time and whether the answer matches within tolerance (±2% for amounts, exact for addresses).
3. Afterwards ask: "what did you look at first?" and "what would you have wanted to see?"

Score = median time and accuracy per condition. The new UI has to win on both or the redesign has failed.

## Questions and reference answers

### 1. Sell 25,000 NAM for USDC right now. How much USDC do you get, and what is the price impact?

- **Answer:** 24.50 USDC at $0.000980 (impact 6.49% vs. SQS spot $0.001048)
- **Derived from:** Osmosis SQS router quote, impact vs. SQS mid

### 2. Which single address has the most NAM bridged to Osmosis in the last 7 days that it has not yet sold? How much?

- **Answer:** osmo1d5vr22acajgwlr2qh334kplmfs7cs4wwqmxfc6 · 90 NAM remaining of 16,667 bridged
- **Derived from:** flows: ibc_in by receiver minus sells after first arrival

### 3. Who sold the most NAM on Osmosis in the last 7 days (excluding arbitrage)? How much, in how many trades?

- **Answer:** osmo12laa7fnv79602cqyzjrc3ah257pdkzyfjcfer4 · 79,214 NAM in 2 sells
- **Derived from:** flows: sells by from_addr, meta.arb excluded

### 4. What was the largest withdrawal from staking in the last 30 days, to which address, and when?

- **Answer:** 5,265,682 NAM to tnam1qr8x5rly5mj8wly2ph0zqjkcqkju0g5jkggjn9k3 at 2026-09-18 19:54 UTC
- **Derived from:** flows: kind=withdraw from the PoS address

### 5. What share of all NAM is currently inside the shielded pool?

- **Answer:** 4.42% (50,702,671 of 1,147,378,272 NAM)
- **Derived from:** MASP balance / minted supply, both via ABCI

### 6. What is the largest unshield to a user address in the last 30 days?

- **Answer:** 41,422 NAM to tnam1qpvlteqjrmjwjjepj4jf33tggehm4hdsqv5lgkj5 at 2026-09-20 23:57 UTC
- **Derived from:** flows: kind=unshield, module accounts excluded

## Record

| trader | condition | q1 | q2 | q3 | q4 | q5 | q6 | notes |
|---|---|---|---|---|---|---|---|---|
|  |  |  |  |  |  |  |  |  |
