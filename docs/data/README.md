# NAM supply since genesis: the per-epoch table behind the Supply page's split

Public chain figures, re-derived on 2 November 2026 from indexer.namada.net and the chain's own inflation formulas.
`scripts/export-proof.ts` (`npm run gen`, which the build runs) reads the two files here, cross-checks them and writes
`web/src/generated/supply.ts`, the dated split the Supply page shows beside its live figures. Nothing in this folder is
a live figure: the minted total of today and the chain's total of shielded rewards come from the site's stored minute
readings and from the chain key the daily job reads, never from here.

## The files

- `supply_by_epoch_1207_2737.tsv`: one row per epoch the indexer has a figure for, from epoch 1207 (block 3,750,313,
  1 October 2025) to epoch 2737 (blocks 8,511,071 to 8,514,218, the last whole epoch before the halt of 2 November
  2026). Columns, in micro-NAM: `epoch`; `masp_epoch` (1 when the epoch is a multiple of 4, when shielded rewards are
  minted); `observed_mint` (the change of the chain's minted total as that epoch started); `pos_pred` (the staking
  inflation the formula gives); `pgf_pred` (the public-funding inflation the formula gives); `residual` (observed −
  staking − public funding: on a shielded-reward epoch, the shielded reward); `pgf_balance_change`; `pgf_outflow_implied`.
- `supply_since_genesis.json`: the totals by period that the table alone cannot give (the epochs the indexer lacks,
  and everything before epoch 1207), the genesis total, the minted total at epoch 2737, the epoch start blocks used,
  and the one large transfer into the public-funding account.

## Method

The minted total at the start of each epoch was read from indexer.namada.net (`/api/v1/chain/token-supply` for the
epoch: total and effective supply; the public-funding balance is their difference) and checked at epoch 2737 against
the chain's own minted key on three public nodes. The staking inflation of an epoch is Namada's formula over the
effective supply of the epoch before; the public-funding inflation is its formula over the effective supply plus the
staking mint, at the rate governance set (0.05 before epoch 1489, 0 from epoch 1489 on). Both formulas are the chain's
(the proof-of-stake and public-goods-funding inflation code), and the rates and the epochs-per-year divisor used in
the derivation were the chain's parameters at those epochs. They are not typed into the site's code as live values: the
live Supply page reads the staking inflation of the newest epoch step from the chain's own record
(`last_inflation_amount`), and says "not read" until the chain records one after this reading began.

Where the indexer has both an epoch and the one before it, the staking column is exact for that epoch, and 889 of the
892 such epochs match the formulas exactly (the three others are epochs where the indexer's figure disagrees with the
rule; they were not checked on chain). Where the indexer lacks an epoch, the effective supply was carried forward and
the formulas applied across the gap: those epochs are modelled, not measured.

## Coverage, and what is measured and what modelled

- Epochs 1 to 48: no inflation (the rates were switched on by governance with effect from epoch 49).
- Epochs 49 to 1206 (blocks 1 to 3,747,219): only the total growth is observed, 91,555,381.466871 NAM. The split
  between staking and public funding there is a model and is not shown; the page says "together" for this period.
  Shielded rewards before epoch 1207 are inside that total too.
- Epochs 1207 to 2199: 985 of 993 epochs in the table; the 8 others carried across.
- Epochs 2200 to 2409 (7 June to 29 July 2026): no indexer figure at all; one simulated span, 4,146,759.344549 NAM of
  staking inflation by the formula and 0 public funding. This is the modelled part the page's caveat names.
- Epochs 2410 to 2737: 194 of 328 epochs in the table; the rest carried across.
- In all, 1,179 of the 1,531 epochs from 1207 to 2737 have an indexer figure (the indexer lacks 30 ranges of epochs,
  the 210-epoch stretch above among them).

By period (observed growth = staking + public funding + shielded rewards):

| period | observed growth | staking (formula) | public funding (formula) | shielded rewards (residual) |
|---|---:|---:|---:|---:|
| epochs 49 to 1206 | 91,555,381.466871 | together, not told apart | together, not told apart | inside the total |
| epochs 1207 to 2199 | 45,888,919.165399 | 19,846,001.240615 | 10,295,702.540893 | 15,747,215.383891 |
| epochs 2200 to 2409 (no indexer figure) | 4,768,289.314453 | 4,146,759.344549 (modelled) | 0 | 621,529.969904 |
| epochs 2410 to 2737 | 6,521,937.341864 | 6,521,938.278951 | 0 | about 0 (the indexer duplicates one epoch's figure at 2548 and 2550) |
| genesis to epoch 2737 | 148,734,527.288587 | | | |

The shielded-reward total is also a chain key: the shielded pool's `max_total_rewards`, 27,347,610.418808 NAM when read
on 2 November 2026. The site uses that key as the measured figure for shielded rewards, read by its daily job, and this
table's residuals only as the per-epoch distribution.

## The public-funding transfer

The public-funding account received 52,378,111.75 NAM in one transparent transfer from a genesis account at block
5,725,013 (10 March 2026, 20:05 UTC, transaction 5E9C6830…2C8B29). It is a transfer between accounts,
not newly minted NAM, and the page names it as such.

## Not stated

The staking inflation's cap and the target staked share are chain parameters (the proof-of-stake parameters). This site
has no decoder for them, so it does not say whether the inflation is at its cap or what the target is; the per-epoch
figure it shows is the chain's own record of what was minted.
