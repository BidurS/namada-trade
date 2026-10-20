# The screener plan: namada.trade as the place to find Namada activity

Written 2026-10-20 for engineers who have not seen the discussion. Read with `system.md` sections 3 (tabs), 7.2 (chart rules), 8 (components), 9 (screens) and 12 (data honesty), and `nav-search-plan.md` sections 1 and 5 (the paging and search build that runs first and changes `worker/src/api.ts`, `worker/src/holders.ts` and the Activity screen). Every figure below was measured by one of four research lenses on 2026-10-20 between 03:06 and 03:30 UTC, read-only, against the production database (`wrangler d1 execute namada-trade-db --remote --json`), the public Namada nodes, indexer.namada.net and the Osmosis endpoints, or read off the code at the line cited. The lenses are named in brackets: **[screener]** (what a DEX Screener user expects and which outside sources exist), **[trader]** (the Namada stakeholder and trader's eight views), **[VC]** (the fund analyst's thirteen questions), **[cost]** (data feasibility and the Cloudflare budget). Nothing here was deployed.

**Repo state this plan is written against.** Branch `integration` carries the bulk chain-index build staged (`worker/src/cron.ts`, `holders.ts`, `sources/namada.ts`, `db.ts`, `migrations/0006_stakes_height.sql`, `test/bulk-index.test.ts`); master holds it as `db208cf` ("WIP bulk chain index … review findings not yet applied"). Production does **not** run it: at 03:06 UTC no `kv balance.listing` or `bond.listing` row existed, every one of the 61,719 Namada holder rows written by the listing carries the same `verified_at` 2026-10-20 02:01:02 (a one-off backfill), and no `stakes` row has `verified_src = 'bonds_listing'` [VC, "Deployment state"; cost, finding 1]. Two consequences run through the whole plan: the holder figures are a snapshot kept current only by the block follower until that build deploys, and migration numbers move up by one (`0006` is taken by `stakes_height`, so the nav plan's migration becomes `0007_nav_search.sql` and this plan's is `0008_series.sql`).

---

## 1. The goal

DEX Screener dropped the Cosmos chains and Osmosis, GeckoTerminal never listed Osmosis, CoinGecko no longer returns NAM, and Imperator's Osmosis host no longer resolves [screener, "What a screener user expects" and "Other sources checked"], so a Namada user has no single page for price, pairs, volume, trades and holders. The goal is that namada.trade becomes that page and then goes past it with what no screener ever had: every balance and every bond on the chain read hourly, the staking structure, the shielded pool, the bridge and holder behaviour by cohort. The build keeps the site's rules without exception: every figure carries its source and its age (`Num`, `ProvChip` on heroes only, `ProvDot`, one `SourceLine` per panel), nothing is typed by hand or invented (no candles where there were no trades, no 0 where a window is not yet covered, no point before a series honestly starts), the words describe and never advise, the six tabs stay, and every screen works first on a 375 px phone (44 px targets, 16 px gutters, no horizontal scroll, text at least 11 px). The order of work puts the cron writers first, because the one thing that cannot be recovered later is a day of history not recorded: every Namada balance series starts the day its writer ships and no earlier.

---

## 2. The token-page basics, item by item

The yardstick is DEX Screener's pair object: `priceUsd`, `priceChange` and `volume` maps (h1/h6/h24), `liquidity`, `fdv`, `marketCap`, `txns {buys, sells}` per window, `pairCreatedAt`, `info` links, a candle chart with ranges, a trades tape, a pairs list, a watchlist and price alerts [screener, "What a screener user expects"]. For each item: what is honest today, the data contract to build, and its honest start date.

### 2.1 Price and changes

**Today.** Quoted price from the Osmosis router (SQS `/tokens/prices`, NAM against alloyed USDC) every minute, stored as `metrics` key `price.usd` since 2026-10-15 04:14 UTC (7,013 rows), live on every `/api/overview` call and honestly marked old with the reason when the live fetch fails (`api.ts` 124–138). Executed price: `price.swap_1h`, the hourly median of single-pool NAM/USDC swaps of 50 NAM or more (`cron.ts` 634–643), 119 points since 2026-08-12 11:00 UTC, 70 of the last 720 hours. The 24 h change is the live price against the first `price.usd` at or after 24 h ago (`api.ts` 115, 138): $0.0011664 at 03:11 UTC, +8.1% [screener, "Price"; VC, "Price context"]. Nothing gives a 1 h, 6 h, 7 d, 30 d or 1 y change, and the executed median now excludes most trades because swaps are routed through two or three pools (route `3005,3368` alone holds 333 swaps) [screener, "Price"].

**Contract.**

- `overview.price` gains `changes: { h1, h6, h24, d7, d30 }`, each `Sourced<number>` computed from `price.usd` (`metricAt(db, 'price.usd', asOf − window)`), null with `note: 'The quoted price has been recorded since 15 Oct 2026'` until the window is covered (7 d from 2026-10-22, 30 d from 2026-11-14). A second map `poolChanges: { d7, d30, y1 }` from the Osmosis pair series (section 2.11), source word `Osmosis data API`, labelled in copy as "pool price" and never mixed with the first.
- The executed median includes routed swaps by pricing each `token_swapped` leg's own in/out amounts (the parser already sees them, `parse/osmosis.ts` 153–171) instead of excluding the route; `price.swap_1h.n` then counts every priced NAM/USDC swap. Same key, so the chart and the `price_vs_execution` check are unchanged.
- Phone header: price plus 24 h change stays (system.md 3). The Trade chart strip gains the changes as a row of `Num`s under the Low/High/Last/Quoted strip: `1 h · 24 h · 7 d · 30 d`, each with its own status (`—` with the reason when not covered).

**Start.** Quoted: 15 Oct 2026. Executed: 12 Aug 2026. Pool price: 20 Jun 2025 (Osmosis series).

### 2.2 Volume, with its definition

**Today.** `/api/overview` computes 24 h volume from `flows`: NAM bought plus NAM sold, bot round trips removed (`meta.arb`), priced at the current price, with `buys24h` / `sells24h` and NAM per side (`api.ts` 101–104, 185–188): 377,960 NAM ≈ $441, 368 buys / 9 sells at 03:29 UTC. Each trade's value at execution exists on most rows (`value_usd`; `meta.priceSource` execution 180, swap_1h 456, older 530 without a source but priced, 85 unpriced), so a volume at execution is possible and differs from the current-price figure. SQS has no volume: `fees_data` is `{volume_24h: 0, is_error: true}` for all 28 pools, which is why `PoolInfo.volume24hUsd` is null on `/api/pools` [screener, "Volume"]. Osmosis's own pair summary gives $282 for the same 24 h and $665 for 7 d across 27 NAM pairs, counting only the priced leg per pool [screener, "The new source"].

**Definition to print (one sentence, in `shared/copy.ts` as the `volume` FactKey's note):** "NAM bought plus NAM sold on Osmosis in the window, each trade at the price it was executed at, bot round trips left out." Two figures, two stamps, never one: `volumeExecuted` (ours, at execution) and `volumeOsmosis` (the pair summary, priced leg only). When both exist and differ by more than 25% the pair shows the disagree state (wavy underline) with both reachable in the sheet.

**Contract.** New metric keys written beside `price.swap_1h` in cron phase 3 (`cron.ts` 635–643): `dex.swaps_1h.n`, `dex.swaps_1h.nam`, `dex.swaps_1h.usd` (sum of `value_usd` at execution), `dex.swaps_1h.buy_nam`, `dex.swaps_1h.sell_nam`, `dex.swaps_1h.buyers`, `dex.swaps_1h.sellers` (distinct makers). Rows exist only for hours with a trade; `/api/metrics/history?key=dex.swaps_1h.nam&hours=720` serves the bars. Windows (`h1`, `h6`, `h24`, `d7`, `d30`) are sums over at most 720 rows in `/api/series/volume` (section 2.12). `dex.volume_24h_usd_osmosis` hourly from the pair summary. One-off backfill from the 1,149 USDC swaps since 2026-08-11 (about 120 trade-hours, 2,400 writes) through `scripts/backfill-series.ts`, provenance `executed NAM/USDC swaps` [cost, finding 4a].

**Start.** Executed volume 12 Aug 2026 (first USDC swap 11 Aug 12:01 UTC). Osmosis pair volume: deploy day (the summary is live only). Daily dollar volume before our index: Osmosis token candles 2025-06-20 to 2026-06-20, then a gap to 2026-08-11 drawn as a gap and said in the caption.

### 2.3 Liquidity

**Today.** Pool depth for all 28 pools from SQS `liquidity_cap`, live on `/api/pools` and recorded per minute as `dex.liquidity_usd`, `dex.pool_count`, `dex.ref_pool_liquidity_usd`, `dex.ref_pool_nam`, `dex.ref_pool_counter` (pool 3005 only) since 2026-10-17 00:26 UTC (4,373 rows): $2,008 across 28 pools; 3005 $916, 3008 (the cosmwasm transmuter) $654, 3368 NAM/OSMO $182, 3020 $69, then 24 pools of $39 or less, two empty [screener, "Liquidity"]. Osmosis's `/pools/liquidity/3005/over_time` holds 467 readings from $112,072 on 2025-06-21 to $214 today (the USDC side only since Osmosis stopped pricing NAM), and `/pools/depth/3005/current` gives the sell depth at about 2% a side (994.6 NAM, 2.71 USDC) [screener, "The new source"].

**Contract.** Table `pool_hourly` (section 5.2) written from the SQS pools answer the tick already holds, one row per pool per hour: depth, reserves, spread, plus the Osmosis summary's `volume_24h_usd` and `volume_7d_usd` where that pool is listed. Hourly rollup keys `dex.liquidity_usd.1h` / `.1h.lo` / `.1h.hi` so a 30-day depth chart reads 720 rows, not 43,200 [cost, finding 3]. The long story ("pool depth since listing") is one-off imported from the Osmosis over-time series as `dex.ref_pool_liquidity_usd.daily.osmosis` (467 points) with its own source word; the chart draws it as a thin line that ends where ours begins and says so.

**Start.** Total depth 17 Oct 2026; per-pool history: deploy day; Osmosis reference-pool series: 21 Jun 2025 (a different source, labelled).

### 2.4 Pairs

**Today.** Trade's "Where NAM trades" lists pools above 0.5% of depth, up to 12 rows (`screens/trade/Pools.tsx` 33–72, `model.ts` 182–185): depth, share, NAM inside, fee. No volume or trades per pool: the parser stores a swap's route as one comma-joined `pool_id` (`'3005,3368,3009'`; 18 distinct route strings), so a routed swap cannot be attributed to one pool [screener, "Liquidity and the pairs list"]. `pairCreatedAt` is not stored.

**Contract.** Two volume columns per pool row, each with its own `ProvDot`: `Osmosis 24 h` from the pair summary (pool 3008 is absent from that summary and its pair series is empty, so its cell is `—` with "Osmosis does not list this pool's volume"), and `Here, 24 h` from `swap_legs` once legs are recorded: the parser writes one row per `token_swapped` leg (`pool_id, tokens_in, tokens_out`) into `flows.meta.legs` (JSON array; no new table, the flow row is the unit), and `pool_hourly.trades` / `.nam` sum the legs per pool. A one-off backfill of legs from the public Osmosis RPC's `tx_search` for the roughly six weeks it retains (`sources/osmosis.ts` 94–109 already uses it). `pairCreatedAt`: read each pool's creation height once from the chain and store it in `kv pool.created.<id>` with the block time; shown as "Pool since 21 Jun 2025". A 7-day sparkline per row from `pool_hourly.liquidity_usd` (168 points) from a 930 px container only; on phones the row stays two lines.

**Start.** Per-pool depth and Osmosis volume: deploy day. Leg volume: six weeks before deploy (the RPC window), live after.

### 2.5 The trades feed

**Today.** Every NAM swap on Osmosis is indexed from the live stream (`live-hub.ts` 17–23) plus a 5-minute catch-up search; each is one flow of kind buy or sell by net NAM with the signer as maker (`meta.trader`), counter asset and amount, route, price with `meta.priceSource`, and a bot flag for round trips within 5% (kind `other`, `meta.arb`). The Activity tab streams rows with a 200 ms rise and filters by chain, kind, minimum NAM, bots and crossings. The feed is a moves list, not a tape: no price per row, no per-maker count, no buyers/sellers per window [screener, "Live trades feed"]. Concentration matters for the design: 1,251 swaps by 62 makers since 2026-08-11; in the last 24 h 377 swaps from 6 makers, 321 of them routed buys of 105 to 1,179 NAM by one address (`osmo1vkyae7…`, 559 buys since 15 Oct); the all-time top maker made 98 buys and 101 sells of near-equal size.

**Contract.** `/api/series/trades?before=&maker=&min=&limit=` (section 2.12): flows with `kind IN ('buy','sell')`, `meta.arb` rows excluded, keyset on `(ts, id)`, each row `{ ts, kind, nam, counterSymbol, counterAmount, priceUsd, priceSource, maker, makerTrades, route, txHash }`; `makerTrades` is a per-request `COUNT(*)` grouped by maker over the page's makers (at most 50 makers, one query). Buyers and sellers per window come from `dex.swaps_1h.buyers` / `.sellers` summed as distinct-per-hour (say "distinct in each hour, summed" in the sheet; an exact distinct over 30 days is one `COUNT(DISTINCT)` over at most 1,500 rows and is cheap enough to run on request for the strip). The tape view on Trade (section 4): consecutive rows by the same maker within 10 minutes fold into one row "`osmo1vkyae7…` bought 12 times, 4,210 NAM, $4.91 average" with a disclosure; a `Repeated small buys` tag beside the existing `Bot trade` tag when a maker made 20 or more buys under 2,000 NAM in 24 h (a description of the pattern, never a claim about intent); buy and sell hues on the kind tag only (system.md 7.2 keeps them off series). Rows with no price (85 all-time) show `—` with "no price was recorded for this trade", never a pool spot price presented as the trade's.

**Start.** 12 Aug 2026 (11 Aug for the first USDC swap).

### 2.6 The chart that stays honest with sparse trades

**Today.** Trade's `PriceChart` draws the executed hourly median (solid ink, dots when 60 points or fewer, a line only above two points) and the quoted price (dashed, one point per hour) over 24 h / 7 d / 30 d, with the three biggest moves as dashed verticals, the Low/High/Last/Quoted strip, press-and-drag readout and the sparse-data sentence (`ui/PriceChart.tsx` 52–57, 204–248). The history endpoint already returns `lo`, `hi`, `n` per bucket (`analytics.ts` 64–81) and the client drops them (`screens/trade/data.ts` 130). There are no volume bars and no candles [screener, "The chart today"].

**Rule (unchanged from system.md 7.2, restated for this build):** no trades, no candle. The executed series is dots joined only when adjacent hours both traded; the quoted series is a dashed line; a flat line must never appear where one hour had one 105-NAM buy.

**Contract, `PriceChartProps` additions (F4, `ui/PriceChart.tsx`):**

```ts
export type ChartRange = '24h' | '7d' | '30d' | '90d' | '1y' | 'all';
export interface BarPoint { t: number; nam: number; usd: number | null; n: number }
export interface PriceChartProps {
  series: { executed: SeriesPoint[]; quoted?: SeriesPoint[]; pool?: SeriesPoint[] };   // pool: Osmosis pair closes, long ranges only
  bars?: BarPoint[];                 // hourly executed volume under the plot; absent hours are drawn empty
  band?: { t: number; lo: number; hi: number }[];   // the quoted price's hourly lo/hi, drawn as a 12% ink-3 band
  flatHours?: number[];              // pool hours with open = high = low = close, drawn as a 1 px tick on the x axis
  hoursWithTrade?: { n: number; of: number };       // feeds the sparse sentence: "70 of the last 720 hours had a trade"
  …existing props
}
```

Behaviour: `24h`, `7d`, `30d` draw executed + quoted + bars + band from our keys; `90d`, `1y`, `all` draw the pool series (thin `--c-ink-3` line, flat hours ticked), the executed dots where they exist, and no quoted line before 15 Oct 2026. The subtitle names the series and its count per range ("USDC per NAM; executed hourly medians, 70 points; pool price from Osmosis, 2,160 points"). The source line names each series with its own age (executed swaps, Osmosis router, Osmosis data API). Hourly volume bars use `dex.swaps_1h.nam` and are drawn in `--c-ink-2` at 40% (never buy/sell hues); an empty hour is an empty slot, so the reader sees that most hours are empty instead of reading it in a caption. The band uses the `lo`/`hi` the endpoint already returns. The 6-hour bucket the endpoint uses beyond 31 days (`historyBucketMs`, `api.ts` 839–854) keeps "last reading of the bucket" semantics, so a 1 y pool chart is 1,460 points of real closes. `hours` cap in `/api/metrics/history` rises from `24 * 400` to `24 * 520` so `all` reaches 20 Jun 2025 (one constant in `api.ts`, queued to the nav plan's W owner).

Home's desktop sparkline keeps the executed 30-day series.

### 2.7 Market cap and FDV: only with a stated definition

**Today.** FDV is computable: `supply.total` × `price.usd`, both per minute with their own stamps: 1,147,657,323 × $0.0011664 ≈ $1.34 M. No circulating authority exists: CoinGecko's search is empty and `/coins/namada` is 404; Osmosis's token endpoint still carries `coingecko_mcap` 909,962.99 of unknown date, which must not be reused [screener, "FDV and market cap"].

**Decision.** Two figures, both labelled with their definition in words, never the phrase "market cap":

- **All NAM at today's price** (`fdv`): `supply.total × price.usd`, derived (`derive()`: oldest input's age, worst status), source "Namada node × Osmosis router".
- **Spendable NAM at today's price** (`spendableValue`): (`supply.liquid` + `supply.osmosis`) × `price.usd`, where `supply.liquid` is minted minus the staking account, the bridge escrow, the shielded pool and public funding (`cron.ts` 622) and `supply.osmosis` is the NAM that crossed the bridge (voucher supply). Definition sentence (copy, no figures): "NAM in ordinary accounts on Namada plus NAM on Osmosis, at today's price. Staked NAM, NAM on its way out of staking, the shielded pool and public funding are left out." Today: (645,713,820 + 19,757,918) × $0.0011664 ≈ $776 k.
- Under both, the supply bar's legend (already on Home and Supply) is the breakdown; the genesis cohort holdings (section 3.3) are the next line down: "Of the spendable NAM, early backers, the foundation and other genesis addresses hold 514 M."

FactKeys added to `shared/copy.ts`: `'fdv'`, `'spendable'`. The SEO page `/osmosis` states both (W, `seo.ts`, after the nav plan's step 4 lands in that file).

### 2.8 Watchlist

**Today.** Signed-in users keep up to 100 addresses (`settings.ts` 28–29, 144–148); the list only tags Discord alert messages with `WATCHLIST`; there is no on-site view [screener, "Token info, links, watchlist and alerts"]. The site is single-token, so a token watchlist is moot.

**Contract.** A **Your addresses** panel on Alerts (signed in; section 4) and in Settings › Watchlist: rows from the same chunked span reads the holders page uses (`api.ts` 333–351, 5 queries of 95 addresses): name or short address, spendable now, 24 h and 7 d change (null with the reason until spans cover the window), last move (from `flows` by `from_addr`/`to_addr`, two indexed reads), a `Genesis`/`Backer`/`Foundation` tag where it adds information. Endpoint `/api/me/watchlist` (GET, signed in, not edge-cached, `HEAVY_LIMITER`). An "Add to watchlist" action in the Address sheet (S7) when signed in. The cohort-shift watch is in section 3.7.

### 2.9 Alerts

**Today.** Five size rules (`shared/alerts.ts`: `ibc_inventory` 25,000 NAM bridged to Osmosis, `unlock` 100,000, `big_swap` 10,000, `unshield` 50,000, `bond` 1,000,000), Discord delivery, quiet hours, late-found alerts. No price-move or volume rule, which every screener offers [screener, "Token info, links, watchlist and alerts"].

**Contract.** Three rule ids added to `AlertRuleId` (`shared/types.ts` 683) and `RULES`:

- `price_move`: "The quoted price moved more than X% in Y hours" (defaults 10% in 1 h; `X` and `Y` as `Fields` in Settings). Evaluated in the cron each tick from `price.usd` now against `metricAt(now − Y h)`; one hit per crossing, re-armed when the move falls under X/2 (kv `alerts.price_move.armed`). Title: "Quoted price up 12.4% in 1 hour, $0.001166" (figures from data, not copy).
- `price_cross`: "The executed price crossed $Z" (user-set, no default on); evaluated when `price.swap_1h` is written.
- `cohort_move` (section 3.7).

`evaluateFlow` stays per-flow; the price rules are per-tick and live in `worker/src/series.ts` (`priceRules(db, now)`), writing hits through the same Discord path with `source: 'price'`. Alerts page: the rule rows become eight; the "What triggers an alert" list stays one panel. Existing rule ids and logic are untouched except the `bond`/`unlock` kind test, which the classifier change in section 3.0 makes correct by itself (the new kind is neither `bond` nor `withdraw`).

### 2.10 Token info and links

**Today.** `shared/site.ts` carries the repository link only; no namada.net, docs, explorer, X or Discord; no logo (the Osmosis assetlist URL is in `config.ts` 32 but its NAM entry is not read) [screener, "Token info, links, watchlist and alerts"].

**Contract.** `SITE.links: { name: string; href: string }[]` curated by the owner (namada.net, docs, the explorer used by the tx links, GitHub, X, Discord, forum), rendered as a "Links" row in the Trade pools block and the footer. The chain facts the site already states as FactKeys (minted supply, staked share, unstaking wait, shielded share, escrow, staking rate) stay the "token info" block. No logo until a licensed asset is confirmed (owner decision 4 pattern).

### 2.11 The Osmosis data API: the one new source, with its caveats

app.osmosis.zone's backend is the Numia-run data API at `https://data.app.osmosis.zone`, no key (the frontend's `.env` sets `NEXT_PUBLIC_HISTORICAL_DATA_URL` to it; SQS stays the router) [screener, "The new source"]. Probed on 2026-10-20 with the NAM denom (the `ibc/…` string in `worker/src/config.ts`):

| Endpoint | What it has for NAM | Caveat to print |
|---|---|---|
| `/pairs/v1/historical/3005/chart?asset_in=<NAM>&asset_out=<USDC>&range=7d\|1mo\|1y\|all&asset_type=denom` | hourly `open/high/low/close` of the pool's spot price as NAM per USDC (last close 857.33 = $0.0011664); 721 points for `1mo`, 169 for `7d`, `all` from 2025-06-20 19:00 UTC (1.2 MB) | no volume; 74 of the last 169 hours have open = high = low = close (no trade, drawn as flat ticks, never candles); pool spot, not executions; pool 3008 answers `[]` |
| `/pairs/v2/summary` | 27 NAM pairs with price, base/quote 24 h volume, `volume_24h`, `volume_7d` (dollars) and the priced-side liquidity: 3005 $188 / $439 / $214; all NAM pairs $282 / $665 / $384 | 2.3 MB, refreshed continuously; counts the priced leg only; 3008 absent; age from `/fees/v1/pools` `last_update_at` |
| `/pools/liquidity/3005/over_time` | 467 daily readings, $112,072 on 2025-06-21 → $214 | USDC side only since Osmosis stopped pricing NAM |
| `/pools/depth/3005/current` | sell depth at ~2% each side (994.6 NAM, 2.71 USDC) | live only |
| `/tokens/v2/historical/<denom>/chart?tf=1440` | 309 daily OHLCV with dollar volume, 2025-06-20 to 2026-06-20 | nothing after 2026-06-20; `tf=60` empty; the token index is dead for NAM (`/tokens/v2/<denom>`: price null, volume 0, `main:false`, a stale `coingecko_mcap` never to be reused) |

Use: the pair series for long price ranges and 7 d / 30 d / 1 y changes labelled "pool price"; the pair summary as a second, labelled volume source per pool; the over-time series for "pool depth since listing"; the daily token candles for dollar volume before our index. Source word `Osmosis data API`; plain word (`web/src/lib/prov.ts` `PLAIN_SOURCE`) "Osmosis app data". Each figure carries its own stamp and takes the disagree state against the site's own figure where both are shown. Fetch rules in section 5.4. Numia's keyed API has no swap-history endpoint and its SQL warehouse is the only named source for a complete NAM trade history before 2026-08-11 (paid, not exercised) [screener, "Other sources checked"]; not in this plan.

### 2.12 The read contract for everything above

`/api/metrics/history` serves every new metric key unchanged (`key`, `hours`, `at`). Four small routes in a new module `worker/src/series-api.ts`, mounted by one line in `api.ts` (`app.route('/', seriesApp)`) and listed in `CACHEABLE_API` / `CACHE_PARAMS` (`http.ts`), every one a primary-key range read with no union, no sort in a temp B-tree, no offset:

| Route | Params | Reads | Answer |
|---|---|---|---|
| `/api/series/:table` (`pool_hourly`, `holder_cohorts_daily`, `cohort_daily`, `flow_edges_daily`, `activity_daily`, `validator_daily`, `unbond_queue`) | `from`, `to` (unix ms or `YYYY-MM-DD`), `chain`, `at` | `WHERE … AND day BETWEEN ? AND ?` on the PK | `{ table, rows, from, to, firstDay, prov }`; `firstDay` is the table's honest start for the chart caption |
| `/api/series/volume` | `window` (`h1`,`h6`,`h24`,`d7`,`d30`), `at` | at most 720 `dex.swaps_1h.*` rows | `{ executed: {nam, usd, buys, sells, buyers, sellers, hoursWithTrade, hours}, osmosis: Sourced<{usd24h, usd7d}> }` |
| `/api/series/trades` | `before`, `maker`, `min`, `limit` (≤ 100), `at` | `flows_kind` index, keyset | `{ rows, next }` (section 2.5) |
| `/api/movers` | `window` (`h24`,`d7`,`d30`), `chain` | one kv row | `{ up: MoverRow[], down: MoverRow[], at, from, to }` (section 3.1) |

Client: `web/src/api-series.ts` (`fetchSeries(table, opts)`, `fetchVolume(window, at)`, `fetchTrades(opts)`, `fetchMovers(window, chain)`), types in `shared/series-types.ts`. Every answer carries `prov` and, for snapshot tables, `firstDay`.

---

## 3. The decision stats, in priority order

Each stat: the query or metric, today's figure where measured, the form, the plain label, the stamp, the caveat sentence the panel prints, and the honest start date. All of them are **cron-written rollups read as primary-key ranges**: D1 answered "overloaded" once during about thirty read queries and the holder-union aggregates cost 0.7–1.5 s and 580,000–1,170,000 rows read per request [VC, "Database load"; trader, finding 13 (10)], so none of these is computed per request.

### 3.0 First, a data flag that gates sections 3.2, 3.4 and 3.5: the staking-account balance transfers

The "331 million NAM withdrawn from staking" the site uses as its Rewind example, and the "300 M re-bond" of 22 Sep, were transparent transfers of the staking account's own NAM balance: block 7,900,851 (31 Aug 2026 23:35 UTC) moved 331,386,682 NAM from the staking account to `tnam1qry99h4…` with descriptor `transfer-from-wasm`, leaving it 1 NAM; 329,386,967 came back on 22 Sep and 2,999,716 on 1 Oct; the chain's total stake never moved; the receiving address has 0 delegations and no bond entry [trader, finding 12, chain and indexer cross-checks cited there]. `worker/src/parse/namada.ts` `classify()` (line 72) returns `bond` for any NAM transfer into the staking account and `withdraw` for any out of it unless the descriptor is `pos-claim-rewards` or `pos-withdraw-token`; these eight rows carry `transfer-from-wasm` while the 277 real live bond rows carry no descriptor. Consequences today: the Rewind example wording (owner decision 3), the 22 Sep "Large amount staked" alerts, the Supply "Unstaking and restaking" list, the 30-day flow map (332 M of 341 M "into staking"), the stakes estimate for `tnam1qrk5py…` (332,386,683 against a chain read of 0) and the cohort accumulation artefact (a 4-NAM address "accumulated" 3.0 M).

**Build.** `FlowKind` gains `'pos_balance'` (`shared/types.ts` 5–8); `classify()` returns it when the descriptor is `transfer-from-wasm` and either side is the staking account. Tag word (F3, `web/src/lib/kinds.ts`): "Staking account balance", glyph `lock`, hue `pos`, expert "Internal transfer", with the glossary line "The staking account's balance holds staked NAM, NAM on its way out and unclaimed rewards; normally only the chain's own staking logic moves it." A read-only report of the affected rows (`scripts/repair-pos-balance.ts --dry-run`, the eight ids listed in the trader lens) before the `UPDATE flows SET kind='pos_balance' WHERE id IN (…)`; then the stake-estimate upsert (`cron.ts` 770–777) recomputes by itself because it sums `bond` and `unbond` only. `shared/alerts.ts` needs no change (the `bond` and `unlock` rules test `kind`); `test/alerts.test.ts` gains the case. Owner question, not an engineering decision: the Rewind example's wording and whether the 22 Sep hits stay in the record as "staked". The site says what happened, not why a transfer from an internal account was accepted.

### 3.1 Holder cohorts and accumulation

**Query.** The union the holder list uses (`HOLDERS_UNION`, `holders.ts` 69: spendable from `holders`, staked from `stakes` via `stakeNum()`, protocol and pool accounts excluded), bucketed on total = spendable + staked. Measured 744 ms, 582,782 rows read [trader, finding 1]; with the nav plan's stored `total_num` column it becomes an index walk, but it stays a cron job either way.

**Today (20 Oct 2026, 64,814 addresses).**

| Cohort | Addresses | NAM | Share of all NAM | Stake at all |
|---|---|---|---|---|
| 10 M+ | 18 | 372,988,208 | 32.5% | 4 |
| 1 M to 10 M | 114 | 383,638,382 | 33.4% | 54 |
| 100 k to 1 M | 309 | 95,869,263 | 8.4% | |
| 10 k to 100 k | 1,017 | 33,673,886 | 2.9% | |
| 1 k to 10 k | 11,394 | 21,223,833 | 1.8% | |
| 1 to 1 k | 47,533 | 6,550,636 | 0.6% | |
| under 1 | 4,429 | 1,350 | | |

132 addresses hold 756.6 M = 65.9% of all NAM; 51,962 of 64,814 holders (80%) hold under 1,000 NAM each. Spendable in the cohorts sums to 645,713,820, equal to the chain's user-spendable figure, and staked to 268.2 M, so the table reconciles to the supply bar [trader, finding 1].

**Accumulation.** Not answerable from stored data today: 0 addresses have a balance reading 7 days back on either chain (spans began 18 Oct, kept 8 days), stakes have no history, and the flow index has ever seen 3,014 of the 64,373 spendable holders [trader, finding 3]. Attributing flows to today's cohorts produces artefacts (the 3.0 M foundation transfer that landed in the "under 1 k" cohort). The honest build is the daily snapshot and its differences.

**New rows.** Table `holder_cohorts_daily(day, chain, bucket, holders, nam, spendable, staked, as_of, PRIMARY KEY (chain, bucket, day))`, 7 buckets × 2 chains, written at the first tick after 00:00 UTC once the last complete balance and bond listings are both newer than 6 h (`as_of` = the older of `kv balance.listing.completeAt` and `bond.listing.completeAt`); 28 writes a day [cost, finding 6]. A missed day stays a gap (state cannot be recomputed later); `kv jobs.daily.last` makes the job run on the first tick after midnight rather than only at 00:00. The 7 d and 30 d change per cohort is the difference of two rows. **Movers** (who accumulated or distributed): after the bulk build every address has balance spans; an hourly pass joins `holders` with the span containing t − window (`balanceAt` rule: a span that contains the time with readings at most `SPAN_MAX_GAP_MS` apart, else null) and writes one kv row `movers` with the top 50 up and down per chain and window, each row carrying its two reading times (reads about 64,000 holders + 70,000 spans, 200–400 ms, 3.2 M rows read a day); 30-day movers need `SPAN_KEEP_MS` raised from 8 to 31 days (rows are created on change only, so the cost is storage) [cost, finding 11]. The same pass writes `holders.namada.accumulating_7d` / `.distributing_7d` (counts of addresses up or down by more than 1 NAM) for a breadth line.

**Form (phone).** Hero sentence "132 addresses hold 66% of all NAM" (figures from data). One `ShareBar` (section 6, F4: `SupplyBar` generalised) with five segments (10 M+, 1 M–10 M, 100 k–1 M, 10 k–100 k, under 10 k: the two smallest cohorts merged because 0.6% and 0.0001% do not draw), legend rows below. Five `DataList` rows (cohort · addresses · NAM · share · 7-day change as a signed `Num` with a diverging 2 px bar). Then **Biggest changes** (movers): segmented `24 h | 7 d | 30 d`, ten rows up and ten down (address or name, signed NAM in buy/sell hues, from → to balance, two reading ages).

**Plain label.** "Who holds NAM, by size" and "Who gained and who sold down".

**Stamp.** One `SourceLine`: "NamadaTrade holder index · balances from the chain's full balance listing (height, time) · stakes from the chain's bond listing (time)"; the snapshot rows: "Daily holder snapshot · since 20 Oct 2026 · last 2026-10-27". Movers: "NamadaTrade balance readings" with both reading times per row.

**Caveats printed.** "Recorded daily since 20 Oct 2026, so the 30-day change is not known yet" (a dash with this reason, never 0). "A cohort's total also moves when an address crosses a size line." "Balances as of the last full chain listing at {time}." Unknown movers windows are null, never 0 [cost, finding 11].

**Start.** Namada cohorts 20 Oct 2026 (the first complete read of every balance; ABCI state reaches about 6 hours back, so nothing earlier exists anywhere a Worker can reach [cost, finding 5]); Osmosis cohorts 18 Oct 2026 if reconstructed from spans, else deploy day. Movers: 24 h one day after the bulk build's first complete listing, 7 d one week after, 30 d 31 days after.

### 3.2 The token-flow map

**Query.** `flows` grouped by day, kind and the category of each side (label category `genesis`, `backer`, `foundation`, `pool`, `pos`, `masp`, `ibc`, `module`, or `user` when unlabelled, and `osmosis` / `namada` for the far side of a crossing), with the overview's `NOT_LEGACY_TWIN`, `NAM_AMOUNT` and refund rules (`flows-query.ts` 45–57; `analytics.ts` 314–353 `timedOutSends`), each crossing counted once. Measured 64 ms over 53,480 rows for 30 days on Namada, 9 ms on Osmosis [trader, finding 5].

**Today, last 7 days (13–20 Oct), NAM only.** Into staking 398,337 (114 bonds: 235,012 from unlabelled wallets, 163,325 from genesis wallets); out of staking 151,087 (claimed rewards 101,264, unlocked 42,035, unstaking requested 7,788 not yet out). Into the shielded pool 345,630 (330,630 of it straight from Osmosis over the bridge in 17 crossings); out 316,205 (315,705 unshielded to 31 wallets). Bridged in from Osmosis 485,865; bridged out 19,167; the Osmosis side shows the same two figures to the NAM (29 paired records each side, 0 unpaired over 14 days). Bought from the pools 495,232 NAM in 805 buys; sold 466,096 in 44 sells; bot round trips 160,238 left out; added to pools 33,117, removed 14,398. Last 30 days: "into staking" reads 341.8 M of which 332.4 M are the staking-account transfers of section 3.0 and 9,427,762 are 109 real bonds [trader, finding 5].

**New rows.** Table `flow_edges_daily(day, chain, kind, from_cat, to_cat, n, nam, usd, PRIMARY KEY (chain, kind, from_cat, to_cat, day))` plus `INDEX flow_edges_day (day)`, written at the daily tick from that day's flows JOIN labels (4 to 515 rows a day, under 10 ms); at most ~40 distinct edges a day × 3 index entries = 120 writes a day. One-off backfill from the whole table (about 686 days × ~20 edges = 14,000 rows, ~42,000 writes) through `scripts/d1-apply.ts`, never the tick [cost, finding 8].

**Form (phone).** Not a Sankey. A **ledger of five paired rows**, segmented `7 days | 30 days`, each row "into / out of" with signed figures and a two-sided bar: Staking +398 k / −151 k · Shielded pool +346 k / −316 k · Bridge: to Namada +486 k / to Osmosis −19 k · Osmosis pools: bought 495 k / sold 466 k · Bots 160 k, left out. One sentence names the biggest single leg. Desktop (from 1024 px) draws the five nodes with arrow widths from the same rows (an SVG inside `Ledger`, container-measured, 11 px labels). Component `Ledger` (F4, `ui/Ledger.tsx`): `rows: { key, label, inNam, outNam, inLabel, outLabel, prov }[]`, `window`, `note`.

**Plain label.** "Where NAM moved this week" (the window word follows the segment).

**Stamp.** "Flow index · Namada scanned to block N (age) · Osmosis stream live, catch-up search to block M" (`coverageOf` gives both).

**Caveats printed.** "No exchange addresses are labelled, so exchange flows are not shown" (the labels table has no `cex`/`exchange` row; one deposit-and-sweep candidate wallet, `tnam1qq9lfreer8hwlsj6xjq7d06l25h3fp6x8cc9mlla`, received 6,627 transfers from 2,594 senders totalling 94.64 M NAM and holds 0: a candidate for the owner to verify, never an automatic label [VC, "Exchange inflows"]). "Bridge out of Namada before 14 Aug 2026 is under-recorded on the Namada side; the Osmosis records since 31 Jul 2026 are the trustworthy side." Shielded legs say nothing about who is inside the pool.

**Start, per kind (printed on the chart).** Staking edges 3 Dec 2024 (indexer history); transfers and shielded in/out 13 Jun 2025; bridge in 20 Jun 2025 (Namada side), bridge net 31 Jul 2026 (Osmosis side, refunds removed); rewards and withdraw 14/15 Aug 2026; Osmosis trade edges 11 Aug 2026; every kind together 14 Aug 2026 (block 7,682,174, the live parser) [cost, findings 1 and 8].

### 3.3 Genesis and backer cohorts

**Query.** `labels` (`source='genesis'`, 5,925 rows in 15 label groups, allocation in `note`) LEFT JOIN `holders` and `stakes`, grouped by category or label: 162–181 ms, 17,184 rows read [VC, "Genesis and backer cohorts"; trader, finding 4].

**Today.**

| Cohort | Addresses | Holds now (spendable + staked) | Of allocation | Untouched (≥ 99%) |
|---|---|---|---|---|
| Early backers (`backer`) | 269 | 215.55 M + 48.25 M = 263.80 M of 325.49 M | 81.0% | 210; 14 empty |
| Foundation | 21 | 153.29 M + 55.55 M = 208.84 M of 262.14 M | 79.7% | 18; 1 empty |
| Other genesis (`genesis`) | 5,635 | 145.16 M + 109.47 M = 254.63 M of 386.56 M | 65.9% | 3,925; 503 empty |

Together 727.3 M = 74.7% of what they were given and 63.4% of today's supply [VC]. By label: `af_backers` 240 addresses 239.9 M (20.9% of all NAM, 84% spendable); public sale 5,195 addresses 138.3 M; Anoma Foundation 136.3 M; early core contributors 200 addresses 107.1 M; Heliax 75.0 M [trader, finding 4]. Their 30-day moves: genesis-labelled wallets staked 8,686,931, were paid 2,601,317 of rewards, unlocked 5,712,271, requested 3,056,772 of unstaking, received 452,791 over the bridge, sent 16,833 to Osmosis, shielded 42,300 and transferred 2,999,720 out (the foundation transfer) [trader, finding 4].

**The label-loss fact.** Of the 70.46 M NAM backers ever transferred, 67.90 M (135 transfers) went to 69 addresses with no label; those hold 0.75 M spendable + 0.61 M staked today and show only 8.78 M of onward transfers and 2.12 M of shields, so about 56 M NAM of backer money cannot be followed with today's tables [VC, "Cohort label loss"].

**New rows.** Table `cohort_daily(day, category, addrs, addrs_with_nam, spendable, staked, as_of, PRIMARY KEY (category, day))` for `backer`, `foundation`, `genesis` and `none` (the complement), 10 writes a day [cost, finding 7]. Cohort moves come from `flow_edges_daily` by `from_cat` (no new table). **Taint propagation** (the only way to answer "how much of each allocation was sold or bridged"): table `cohort_taint(address, cohort, tainted_nam, updated_at, PRIMARY KEY (address, cohort))` updated by the daily job from that day's transfers by proportional split of the sender's tainted share (never more than the transfer; shielded NAM is a hard stop, bridged NAM to an `osmo1` address keeps its tag through `address_links` only), with cohort totals written as metrics `cohort.<name>.at_source`, `.moved_1hop`, `.bridged`, `.shielded`, `.sold_linked` [VC, "Cohort label loss"]. Phase two of this section: ship the daily table first, taint second.

**Form (phone).** Five rows (cohort · NAM held · share of all NAM · spendable vs staked as a two-tone bar · 30-day net towards the market), hero line "Early backers still hold 81% of what they were given". Per-address rows (the 50 largest in the cohort, from the holders index with the `category` filter the nav plan adds) with 7-day change from spans. On `/holders` the `What` filter already has Foundation / Genesis / Backer.

**Plain label.** "What the early holders are doing".

**Stamp.** "Genesis allocations (chain genesis files) · holder index (listing times) · flow index".

**Caveats printed.** "NAM that left a genesis address is counted only at its first hop; after that it is unlabelled." "'Sold' is matched through the 252 bridge-linked address pairs only." "Shielded NAM went private; it is not counted as sold." Only 159 of 269 backer, 7 of 21 foundation and 1,399 of 5,635 genesis addresses have any recorded flow at all.

**Start.** Balances 20 Oct 2026 (no earlier balance exists; the cheaper partial backfill is indexer.namada.net `/chain/history` per address for the 5,925 cohort addresses, offline, with its documented shielded-bridge blind spot, labelled as such if ever used). Moves: as the flow map per kind (staking 3 Dec 2024, transfers and shielding 13 Jun 2025, bridge 20 Jun 2025 with the under-recording caveat).

### 3.4 Staking structure

**Query.** Per-validator sums over `stakes.delegations` JSON (`json_each`, 216–228 ms, 71,969 rows read): 245–246 validators carry the stake, 19,453 stakers, 26,842 staker-validator pairs, 268.4 M NAM [trader, finding 7; VC, "Validator count"]. Names, state and commission come from `kv intel.cache` (indexer, two pages sliced to 25) for 23 validators only.

**Today.** polkachu.com 24.79 M (9.2–9.3%, 871 delegators), ZecHub 18.01 M (17 delegators, one of 14.66 M), nodemeister 16.69 M, bitszn/valopers 16.47 M, 5ElementsNodes 16.42 M, Architect Nodes 11.46 M, Staking4All 8.67 M, namada-validator 8.12 M, Precipice 7.65 M, PRO Delegators 7.34 M. Top 5 = 34.5% of the chain's total stake (267,175,777), top 10 = 50.7%, 44 validators with ≥ 1 M; five validators together pass one third [VC]. The trader lens printed 53.0% for the top 10 from the same rows against the sum of delegations (268.4 M): two denominators, two figures, which is exactly why the cron writes one figure from one listing with the chain's total stake as the denominator. Stakers: 57 addresses stake ≥ 1 M each, 223.3 M together = 83.2% of all stake; 15,641 addresses stake under 1,000 NAM [VC, "Staking participation"]. Unstaking wait 56 epochs × 6.005 h = 14.01 days; staking rate 10.89% (`kv chain.params`). The staking account holds 342,121,958 while total stake is 267,175,777, so 74,946,181 (6.5% of supply) is unstaking, withdrawable or unclaimed rewards, all of it at most about 14 days from spendable [VC, "The 'on its way out' figure"].

**New rows.** `parseBondListing` (`sources/namada.ts` 464–477) currently skips the unbond vector (`b.skip(16); b.skip(32)` per entry: start epoch, withdraw epoch, amount, slashed). Reading those fields instead gives, per 40-minute listing, (a) the chain-wide unbond queue by withdraw epoch: table `unbond_queue(withdraw_epoch INTEGER PRIMARY KEY, nam, n, listed_at, height)`, at most 56 rows, rewritten only when a hash of the queue changes (kv `unbond.queue.hash`): ~1,000 writes a day typical, 4,032 at most; this replaces the derived `unstaking = PoS balance − total stake` with an exact "what becomes spendable, when" for the whole chain; (b) per-validator totals: table `validator_daily(day, validator, stake, delegators, commission, state, PRIMARY KEY (validator, day))`, 246 rows a day (490 writes), with names and commission from the indexer's full validator list (all pages, all states) cached in `kv validators.names`; (c) metrics per listing `stake.validators`, `stake.top10_pct`, `stake.third_count` (how many validators together hold a third; descriptive, not "Nakamoto coefficient"), `stake.unbonding_nam`, `stake.withdrawable_nam`, `stake.stakers`, `stake.top57_share` (addresses ≥ 1 M): 7 × 36 × 2 = 504 writes a day. CPU: the parser already iterates every entry; reading 24 bytes instead of skipping them is the same byte count [cost, finding 9].

**Form (phone).** Fact strip (validators with stake · stakers · top 10 hold N% · N validators reach one third), one `SourceLine`. Top-10 rows (name · NAM · share bar · delegators · commission). **What unlocks when**: a 14-day bar chart of `unbond_queue` by withdraw date (NAM per day, `Bars` component) with the hero "74.9 M NAM is on its way out of staking". **Moves of 100,000 NAM or more, 30 days** rows (date · Staked / Unstaking / Unlocked tag · NAM · address label · validator name): the 30 Sep cluster of six early-core-contributor addresses unlocking 5.1 M and bonding 7.9 M the same morning reads as "unlocked, then restaked elsewhere", not a sale [trader, finding 7].

**Plain label.** "Who the stake is with" and "What unlocks when".

**Stamp.** "Chain bond listing (time) · names and commission from indexer.namada.net (time)".

**Caveats printed.** "Names are known for 23 of 246 validators until the full list is cached." "Stake moving between validators without unstaking (redelegation) is not in the flow index." "Turnout is shown against today's stake, not the stake at the time" (governance: `intel.cache` holds the 20 most recent proposals; #42 drew 22.8 M voting NAM, 8.5% of today's stake [VC, "Governance"]; a per-proposal row `gov_proposals(id, title, kind, end_epoch, yay, nay, abstain, total_stake_at_close)` written when a proposal closes is a small addition to the same daily job and is listed last in section 8).

**Do not draw.** A cumulative Σbond − Σunbond line from flows as "staked over time": the recorded flows give 900.6 M bonded − 369.2 M unbonded = 531 M against the chain's 267.2 M [cost, finding 9]. The staked-share trend is honest from 18 Oct 2026 (`supply.total_stake`); before that only monthly bond/unbond bars with the dated gap note.

**Start.** Validators, queue, commission: deploy day (ABCI state about 6 h back; the indexer has no history). Chain total stake 18 Oct 2026; staking-account balance 15 Oct 2026.

### 3.5 Price context: what buyers paid, how thin the market is, what could reach it

**(a) What recent buyers paid.** Volume-weighted average of Osmosis buys at their own executed price, bots out (10 ms over `flows`): 7 days $0.000894 over 495,232 NAM in 805 buys by 5 buyers; 30 days $0.000757 (896 buys, 22 buyers, 33 unpriced); 90 days $0.000672 (1,034 buys, 33 buyers, 53 unpriced). Sellers received $0.000908 / $0.000739 / $0.000652. Price now $0.001166 (router) and $0.001207 (last hour with trades): 30% above the last 7 days' buyers, 54% above the 30-day buyers, 74% above the 90-day buyers; the 90-day executed range is $0.000303 to $0.001524 [trader, finding 8]. **Rows:** `dex.swaps_1h.vwap`, `.buy_vwap`, `.sell_vwap` beside the volume keys; a window VWAP is a weighted sum over at most 720 rows in `/api/series/volume`. **Form:** three rows (7 · 30 · 90 days: "Buyers paid on average $x (n buyers, m NAM) · sellers got $y"), hero line "Now $0.001166, +30% vs the last 7 days' buyers", the sparse sentence. **Label:** "What recent buyers paid". **Stamp:** "Executed Osmosis swaps (flow index) · each swap at its own price · Osmosis router (age)". **Caveat:** "5 buyers in a week is the whole market"; a cost basis of the NAM held on Osmosis is not computable because 89% of it arrived before the index began. **Start:** 12 Aug 2026.

**(b) How much trades against how little.** 19 Oct: 377,960 NAM in 377 swaps worth $325 against $2,008 of depth at the day's end: 16% of the pools' depth traded in one day; last 7 days about 961,000 NAM and $866 against $2,091 (41%); 14 of the last 30 days had under $25 of trade [trader, finding 9]. **Rows:** `dex.volume_nam_daily`, `dex.volume_usd_daily`, `dex.traders_daily`, `dex.hours_with_trades_daily` from flows at the daily tick (8 writes), plus the depth rollups; the ratio is two PK reads in the API. **Form:** hero "16% of the pools' depth traded yesterday"; a 14-day bar chart of daily NAM traded (buys and sells stacked in buy/sell hues, the one place series carry those hues because each bar is a buy or a sell) with pool depth as a line from 17 Oct only; strip "Bots left out: 160,238 NAM this week". **Label:** "How much trades against how little". **Stamp:** "Executed swaps (flow index) · pool depth from the Osmosis router, read every minute (age)". **Caveat:** "Pool depth has been recorded since 17 Oct 2026"; swap times before about 30 Aug are extrapolated (known gap). **Start:** volume 12 Aug 2026; depth 17 Oct 2026.

**(c) NAM that could reach the market.** Four layers [trader, finding 6]: sellable now 18,365,388 NAM in 1,308 Osmosis wallets (5 wallets of 1 M+ hold 7.0 M, none with an indexed move or a Namada link); bridged in the last 30 days and not yet sold or sent back: about 0 (26,596 crossed to 6 receivers; the two largest sold 16,577 of 16,667 and 8,237 of 9,251 within days); unstaking inside the 14-day wait 51,062 NAM (10 requests, 6 addresses); unlocked in the last 14 days and not restaked 42,185 (7 withdrawals). Against this: $2,091 of pool depth; pool 3005 holds 214 USDC and 601,916 NAM. The Supply hero "Ready to sell" (7-day on-deck) would read close to 0 and mislead by omission. **Rows:** layer 1 from `holders` (3 ms); layer 2 the existing `pressure()` on-deck query; layers 3–4 from `unbond_queue` (whole chain, exact by withdraw epoch) once section 3.4 ships, until then the flows-based unlock list. **Form:** hero "NAM on Osmosis outside the pools: 18.4 M" with four rows (In Osmosis wallets now · Bridged in, not yet sold (30 days) · Unlocking within 14 days · Unlocked in the last 14 days, not restaked), each with NAM, dollars derived from the price and its own `ProvDot`; a closing line stating the pool depth beside it and a link to Trade's size table ("what 10 k, 50 k, 100 k NAM do to the price"), never "enough to crash the price". **Label:** "NAM that could reach the market". **Stamps:** layer 1 "Keplr Osmosis bank list (time)"; layer 2 "Flow index (Osmosis)"; layers 3–4 "Chain bond listing (time)" or, before it, "Flow index (Namada) · chain parameters read (time)". **Caveats:** 1,250 of the 1,308 Osmosis wallets (16.3 M of 18.4 M NAM) have no indexed move, so how long that NAM has sat there is unknown; "not yet sold" is matched by address and time, not by lot. **Start:** Osmosis balances live (history from deploy day); bridge 31 Jul 2026; unlocks 15 Aug 2026 (queue: deploy day).

**(d) Events on the charts.** Nothing records announcements or upgrades; `docs/events.json` holds data-derived events only and the chart reads the repo file (`system.md` 14, gap 9). Table `events(ts INTEGER, kind TEXT, title TEXT, url TEXT, added_by TEXT, PRIMARY KEY (ts, kind))` seeded automatically from governance proposals (activation epoch → block time) and forum topics in `intel.cache`, curated by the owner for off-chain announcements; `/api/events?from&to` serves the markers on the price, supply and staking charts; every marker shows its source URL. Copy: "what happened around then", never "because" [VC, "Comparisons to the chain's own announcements"].

### 3.6 Active addresses and new holders

**Active.** Addresses in any recorded NAM move, protocol and pool accounts out: Namada 3–20 a day over the last 14 days (19 Oct: 20 addresses, 31 legs), Osmosis 6–24 a day (19 Oct: 23 addresses but 522 legs, bot round trips); weekly over both chains 39 (partial), 76, 53, 55, 79, 67, 27, 41, 84, 57, 49 back to mid-August [VC, "Active addresses"]. **Rows:** `activity_daily(day, chain, flows, senders, receivers, active, nam, trades, traders, PRIMARY KEY (chain, day))`, 4 writes a day at the daily tick, backfilled once from flows (1,372 rows) [cost, finding 10]; `chain.txs_daily` from `/blockchain` block metas (`num_txs` per block; nodes serve metas back to genesis, `blockMetas()` in `sources/namada.ts`) so one line shows total chain transactions, which NAM-flow activity does not. **Form:** on Activity › Transactions, a fact strip above the list (active today · this week · moves today · chain transactions today) and a 12-week bar chart with the unit in the subtitle ("addresses in a recorded NAM move"). **Label:** "How many addresses moved NAM". **Stamp:** "Flow index · Namada since 14 Aug 2026 (older moves from the public indexer) · Osmosis since 31 Jul 2026". **Caveat:** "Active means an address in a recorded NAM move; votes, other tokens, shielded-to-shielded and fee-only transactions are not counted." **Start:** 14 Aug 2026 for every kind (earlier weeks in a second, labelled series "staking and transfers as recorded by the public indexer"); Osmosis 31 Jul / 11 Aug 2026.

**New holders.** Not honestly answerable yet: `holders` has no first-seen column, first appearance in flows has seen the birth of a sliver (11 new addresses in the week to 19 Oct against 64,826 holders), and 57,635 holders (88.9%, 49.1 M NAM) have no move on record [VC, "New holders"; trader, finding 2]. **Rows:** inside `runBalanceListing` (`cron.ts` 295–363) add a counter `added` for the `!s && balance !== '0'` branch (rows new to the table; zeroed rows are kept at 0, so a re-entry is "changed" and `added` is exactly "held NAM for the first time since 20 Oct 2026"), and write per complete listing: `holders.namada`, `holders.namada.new_1h`, `holders.namada.gone_1h`, `holders.namada.under1`, `holders.namada.user_nam`, and `holders.osmosis` hourly from the Osmosis list: 288 writes a day, provenance "Namada node balance listing at height H" [cost, finding 5]. A `first_seen` column on `holders` (migration 0008) filled with the listing time of the first listing that saw the address, null for the 64,377 that were already there. The overview then reads these keys instead of the 360,000-row queries (the nav plan's `kv holders.counts` and these metrics come from the same listing pass). **Form:** on `/holders`, the fact strip gains "New this week" and "Emptied this week"; per holder row a `Tag`: `Genesis` (label), `First seen 20 Aug 2026` (flow index) or `No move on record`. **Caveat (one sentence on the cohort panel):** "57,635 holders have no move on record: this site's index starts on 14 Aug 2026, and the chain does not say when an address first received NAM." Until the writer ships, the page says "New holders are not counted yet", never 0. **Start:** 20 Oct 2026 (the first complete listing; not backfillable, the only exact earlier path is an offline `block_results` replay from genesis, days of fetching, not Worker work).

### 3.7 Watch lists that notice cohort shifts

**Rule `cohort_move`** (`shared/alerts.ts`, per-flow): a move of `X` NAM or more (default 100,000) by an address labelled `backer`, `foundation` or `genesis` of a kind that takes NAM towards the market: `ibc_out`, `transfer` to an unlabelled address, `shield`, or a `sell` by a bridge-linked `osmo1` address. Title in rule words: "Early backer moved 250,000 NAM to Osmosis". `evaluateFlow` needs the sender's label category: the cron's alert path joins `labels` for the tick's new rows (at most a few hundred) and sets `fromCategory` on the `Flow` it evaluates (the API rows already carry `fromLabel`/`toLabel`; the same field is reused). **Daily cohort check** (per-tick rule in `series.ts`): when a cohort's `cohort_daily.spendable + staked` falls by more than 1% day over day, or `holder_cohorts_daily` for 10 M+ changes by more than 2%, write one hit "Early backers' holdings fell 1.3% since yesterday (3.4 M NAM)" with both rows' stamps. **Watchlist view** (section 2.8) shows, per watched address, the cohort tag and the last cohort hit. Alerts hero "Since you were away" lists these beside the size hits. **Caveat:** label loss after the first hop (section 3.3) applies; a backer who moved to a fresh address before 20 Oct is invisible to the rule.

### 3.8 The shielded pool's direction (already on the Shielded tab; one addition)

Pool 50,812,667 NAM (4.43%); +29,423 in 7 days, +69,220 in 30, +215,049 in 90; peak 67,199,061 on 10 Jun 2026 (−24.4% since); the flow legs reconcile with the balance change to within 2 NAM [trader, finding 10]. **Rows:** `masp.in_daily`, `masp.out_daily`, `masp.shielders_weekly` (distinct shielding addresses, 0–4 a week over 12 weeks [VC, "Shielded adoption"]); the daily balance series `supply.masp_shielded.daily` ends 17 Oct and the cron must keep extending it (one row at the daily tick from the minute series). **Form:** hero direction word (In / Out / Flat, flat under 0.1% of the pool) with "+29 k NAM into the pool in 7 days", the in/out ledger for 7 and 30 days above the existing chart with the peak marked. **Stamp:** "Namada node, pool balance read every minute (age) · daily chain history 13 Jun 2025 to 17 Oct 2026 · flow index legs". **Caveat:** 42.4 M of historical shielded bridge withdrawals were missing before the 17 Oct repair; nothing inside the pool is attributable.

### 3.9 The honest start dates, in one table (print the date under every chart)

| Series | Start | Backfillable |
|---|---|---|
| Quoted price, supply split, staking-account balance | 15 Oct 2026 04:14 UTC | no |
| Executed price, hourly volume, buy VWAP, trades tape | 12 Aug 2026 (first USDC swap 11 Aug 12:01 UTC) | yes, from flows (one offline pass) |
| Pool depth, total | 17 Oct 2026 00:26 UTC | no |
| Per-pool depth and Osmosis volume, validators, unbond queue, commission | deploy day | no |
| Chain total stake | 18 Oct 2026 03:20 UTC | no |
| Shielded pool | daily 13 Jun 2025; per minute 15 Oct 2026 | already done |
| Holder count, new and emptied holders, size cohorts, genesis cohort balances | 20 Oct 2026 (Namada); 18 Oct 2026 (Osmosis, from spans) | no (ABCI state about 6 h back; an offline block_results replay from genesis is the only exact path and is not Worker work) |
| Movers 24 h / 7 d / 30 d | 1 day / 7 days / 31 days after the bulk build's first complete listing | no |
| Flow map by kind | staking 3 Dec 2024; transfers and shielded 13 Jun 2025; bridge in 20 Jun 2025; bridge net 31 Jul 2026; every kind 14 Aug 2026 | yes, from flows |
| Active addresses | 14 Aug 2026 (Osmosis 31 Jul / 11 Aug 2026) | yes, from flows |
| Pool price (Osmosis data API) | 20 Jun 2025 19:00 UTC | yes, one import |
| Daily dollar volume (Osmosis token candles) | 20 Jun 2025 to 20 Jun 2026, then a gap to 11 Aug 2026 | yes, one import; the gap stays a gap |

---

## 4. Where it lives: the six tabs, the phone layout, and why not a seventh tab

### 4.1 The argument against a new Stats tab, and the one change argued for

Against: the phone tab bar is six equal cells of at least 62 px at 375 px (system.md 3); a seventh cell is 53 px and breaks the rule, and "More" is banned. Every stat above answers one of the six questions the tabs already ask (what moved; what would I get; is a big sale coming; how much can't be seen; every move and who holds; what should wake me up), so a Stats tab would be a second home for figures that already have one, and it would reintroduce the token-page grid the site deliberately replaced with questions (system.md 3; screener lens, "What a screener user expects"). The screener user's need ("price, pairs, trades and holders on one page") is met on Trade for the market figures and on Holders for the holders, with the Home rail as the one-glance summary on desktop; the palette (nav plan 4.2, group "Views") gains one row per panel ("Who holds NAM, by size" → `/holders#cohorts`) so any stat is two keystrokes away.

For (argued, and recommended): the **Supply hero changes** from "Ready to sell" (7-day on-deck, which would read close to 0 today) to **"NAM that could reach the market"** with the four layers as rows; the H1 "Is a big sale coming?" stays. And the **Activity › Holders page tabs** gain anchors (not tabs): `Cohorts`, `Early holders`, `Movers`, `All holders`, as in-page jump links under the page tabs (52 px row, horizontal scroll with an edge fade on phones), because the holders page becomes long.

### 4.2 Placement, screen by screen (phone order; desktop in brackets)

**Home (S1).** No new panel. The fact strip reads `holders.namada` from the listing metrics ("addresses with NAM"); "Where is all the NAM?" gets the two value lines of section 2.7 under the legend; Latest moves rows carry the new `Staking account balance` tag. (Desktop rail adds "Unlocking in 14 days" from `unbond_queue`.)

**Trade (S2).** After the ticket band: chart block with the six ranges, bars, band and the changes row (2.1, 2.6) → **What recent buyers paid** (3.5a, three rows) → **How much trades against how little** (3.5b, 14-day bars) → the size block as today → **Where NAM trades** with the two volume columns and "Pool since" (2.4) → **Trades** tape, 20 rows, grouped, with the per-maker filter and "All activity" link (2.5) → Links row (2.10). (Desktop: chart and buyers in the right 7/12 column; the tape full width under the pools table.)

**Supply (S3).** Yellow band: hero **NAM that could reach the market** with the four layer rows (3.5c), range segmented, fact strip (Bridged in, Bridged out, Net bought 24 h, Staked share). Black body: **Where NAM moved this week** ledger (3.2) → **Who the stake is with** fact strip and top-10 rows (3.4) → **What unlocks when** 14-day bars (3.4) → **Unstaking and restaking** rows as today, with the 14-day staked chart saying "recorded since 18 Oct 2026" until it has 14 days → **Who is moving the price** → Votes in progress. (Desktop: hero strip; ledger beside stake; unlocks full width.)

**Shielded (S4).** Direction word and the 7/30/90-day ledger above the existing chart (3.8); the rest unchanged.

**Activity › Transactions (S5).** Fact strip and 12-week bars of active addresses above the list (3.6); the list unchanged (the nav plan's cursor and filters).

**Activity › Holders (S5).** Yellow band fact strip gains New this week / Emptied this week (3.6). Anchors row. **Who holds NAM, by size** (3.1: `ShareBar`, five rows) → **What the early holders are doing** (3.3: five rows) → **Who gained and who sold down** (3.1 movers, segmented) → **All holders** (the nav plan's list, with the age tags per row).

**Alerts (S6).** Hero "Since you were away" includes price and cohort hits; "What triggers an alert" becomes eight rows (2.9, 3.7); **Your addresses** panel when signed in (2.8). Settings › Watchlist gets the same rows and thresholds for the three new rules.

### 4.3 Phone rules every new panel keeps

Rows 44 px with line 1 label plus one right-aligned number and line 2 tag, counterparty, age; mono 12 px figures and 11 px ticks; charts container-measured SVG with y labels outside the plot and the press-and-drag readout above it; one hero per screen (32 px or more), everything else 24 px or less; at most two yellow fields a screen; buy/sell hues only on buys and sells (the one series exception is the stacked daily volume bars, whose bars are buys and sells); every delta signed with a true minus; `role="table"` grids, no `<table>`; one `SourceLine` per panel; the first screen of each tab unchanged in height (the new panels sit below the existing hero and first panel).

---

## 5. Cron and storage, with the arithmetic

### 5.1 The frame

The tick runs every minute (`wrangler.jsonc` `"crons": ["* * * * *"]`), measured at about 13 s and 311 subrequests against a 45 s deadline (`TICK_DEADLINE_MS`) and the Workers Paid limit of 1,000 subrequests per invocation. Two chain-wide listings already run in it: every NAM balance hourly (about 12 MB; the code comments measured 9 MB, 90,783 keys) and every bond every 40 minutes (about 5 MB; 30,271 entries), never both in one tick (`cron.ts` 5a) [cost, finding 13]. D1 counts an index entry as a row written: a `metrics` row costs 2 writes (row + text primary key), a `flows` row 7 (six indexes); the paid plan includes 50 million rows written a month (about 1.61 M a day) and 25 billion read [cost, finding 2].

### 5.2 Migration `0008_series.sql` (W1)

```sql
CREATE TABLE IF NOT EXISTS pool_hourly (
  hour INTEGER NOT NULL, pool_id TEXT NOT NULL,
  liquidity_usd REAL, nam_reserve REAL, counter_reserve REAL, spread REAL,
  volume_24h_usd_osmosis REAL, volume_7d_usd_osmosis REAL, osmosis_at INTEGER,
  trades INTEGER, nam REAL,                  -- from swap legs, null until legs are recorded
  PRIMARY KEY (pool_id, hour));
CREATE TABLE IF NOT EXISTS holder_cohorts_daily (
  day TEXT NOT NULL, chain TEXT NOT NULL, bucket TEXT NOT NULL,
  holders INTEGER NOT NULL, nam REAL NOT NULL, spendable REAL NOT NULL, staked REAL NOT NULL, as_of INTEGER NOT NULL,
  PRIMARY KEY (chain, bucket, day));
CREATE TABLE IF NOT EXISTS cohort_daily (
  day TEXT NOT NULL, category TEXT NOT NULL,
  addrs INTEGER NOT NULL, addrs_with_nam INTEGER NOT NULL, spendable REAL NOT NULL, staked REAL NOT NULL, as_of INTEGER NOT NULL,
  PRIMARY KEY (category, day));
CREATE TABLE IF NOT EXISTS flow_edges_daily (
  day TEXT NOT NULL, chain TEXT NOT NULL, kind TEXT NOT NULL, from_cat TEXT NOT NULL, to_cat TEXT NOT NULL,
  n INTEGER NOT NULL, nam REAL NOT NULL, usd REAL,
  PRIMARY KEY (chain, kind, from_cat, to_cat, day));
CREATE INDEX IF NOT EXISTS flow_edges_day ON flow_edges_daily (day);
CREATE TABLE IF NOT EXISTS activity_daily (
  day TEXT NOT NULL, chain TEXT NOT NULL,
  flows INTEGER NOT NULL, senders INTEGER NOT NULL, receivers INTEGER NOT NULL, active INTEGER NOT NULL,
  nam REAL NOT NULL, trades INTEGER NOT NULL, traders INTEGER NOT NULL, chain_txs INTEGER,
  PRIMARY KEY (chain, day));
CREATE TABLE IF NOT EXISTS validator_daily (
  day TEXT NOT NULL, validator TEXT NOT NULL,
  stake REAL NOT NULL, delegators INTEGER NOT NULL, commission REAL, state TEXT, name TEXT,
  PRIMARY KEY (validator, day));
CREATE TABLE IF NOT EXISTS unbond_queue (
  withdraw_epoch INTEGER PRIMARY KEY, nam REAL NOT NULL, n INTEGER NOT NULL, listed_at INTEGER NOT NULL, height INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS listings (
  at INTEGER PRIMARY KEY, kind TEXT NOT NULL, height INTEGER NOT NULL, provider TEXT NOT NULL);   -- one row per complete listing (5.5c)
CREATE TABLE IF NOT EXISTS cohort_taint (
  address TEXT NOT NULL, cohort TEXT NOT NULL, tainted_nam REAL NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (address, cohort));
CREATE TABLE IF NOT EXISTS events (
  ts INTEGER NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, url TEXT, added_by TEXT NOT NULL,
  PRIMARY KEY (ts, kind));
ALTER TABLE holders ADD COLUMN first_seen INTEGER;
```

`day` is `YYYY-MM-DD` UTC text so a range is a string `BETWEEN`; every read is `WHERE <dims> = ? AND day BETWEEN ? AND ?` on the primary key, and `EXPLAIN QUERY PLAN` on the stand-in must show `SEARCH … USING INDEX` and never `TEMP B-TREE` (section 7).

### 5.3 New metric keys (all in `metrics`, served by `/api/metrics/history` unchanged)

Per minute, in phase 2's `metricStmts` (`cron.ts` 612–631): none new. Per hour (rollups, written once from the past hour's 60 rows, one query for all keys): `price.usd.1h`, `.1h.lo`, `.1h.hi`; `dex.liquidity_usd.1h` (+ lo/hi); `supply.total_stake.1h`; `supply.masp_shielded.1h`: 4 keys × 3 × 24 × 2 = 576 writes a day, so a 30-day chart reads 720 rows instead of 44,640 [cost, finding 3]. Per trade-hour, in phase 3: `price.swap_1h.open/.high/.low/.close/.vwap`, `dex.swaps_1h.n/.nam/.usd/.buy_nam/.sell_nam/.buyers/.sellers/.buy_vwap/.sell_vwap`: about 60 writes a day typical, 480 at most. Per complete balance listing: `holders.namada`, `.new_1h`, `.gone_1h`, `.under1`, `.user_nam`; hourly `holders.osmosis`: 288 a day. Per bond listing: `stake.validators`, `.top10_pct`, `.third_count`, `.unbonding_nam`, `.withdrawable_nam`, `.stakers`, `.top57_share`: 504 a day. Hourly from the Osmosis summary: `dex.volume_24h_usd_osmosis`, `dex.volume_7d_usd_osmosis`: 96 a day. Hourly from the Osmosis pair chart: `price.pool_1h`, `.open`, `.high`, `.low`, `.flat` for the closed hour and the current hour only (16 writes an hour, 384 a day; the one-off `range=all` import is 8,760 × 5 × 2 ≈ 90,000 writes once). Hourly movers: kv `movers` (2 writes) and `holders.namada.accumulating_7d` / `.distributing_7d` (4): 144 a day. Daily: `dex.volume_nam_daily`, `dex.volume_usd_daily`, `dex.traders_daily`, `dex.hours_with_trades_daily`, `masp.in_daily`, `masp.out_daily`, `active.namada_daily`, `active.osmosis_daily`, `chain.txs_daily`, `supply.masp_shielded.daily` (extended), `cohort.<name>.*` (five keys × three cohorts), `bridge.in_daily`, `.out_daily`, `.refunded_daily`: about 70 writes a day. Per-minute rows are **not** deleted (deleting 21,600 rows a day would cost 43,000 writes a day; keeping them costs storage only, about 8 million rows and 320 MB a year inside the 5 GB included) [cost, finding 3].

### 5.4 Fetch rules for the Osmosis data API (W2, `worker/src/sources/osmosis-data.ts`)

- `/pairs/v2/summary` (2.3 MB) once an hour, on the first tick of the hour where neither chain listing is due (`listingDue()` false for both; the same rule that keeps the two listings apart), at most once an hour (kv `osmo.summary.at`), 10 s timeout, parsed for the 27 NAM pairs only; its age is `last_update_at` from `/fees/v1/pools` (one small request) or, failing that, the fetch time marked as such. +2 subrequests an hour.
- `/pairs/v1/historical/3005/chart?range=7d` (169 points, small) once an hour in the same tick: +1 subrequest. The `range=all` import (1.2 MB) runs once, offline, through `scripts/backfill-series.ts`.
- `/pools/depth/3005/current` with the pools answer when the Trade page asks (live, through `/api/pools`, cached 15 s at the edge).
- `/pools/liquidity/3005/over_time` and `/tokens/v2/historical … tf=1440`: one-off imports, offline.
- Health rows `Osmosis data API (pairs)` and `(summary)` in `source.health`; a failed fetch keeps the last stored values marked old with the note, never a blank.

### 5.5 The budget, before and after

**Today's writers**, from the code (treat as ±40% until read off the D1 dashboard with `npx wrangler d1 info namada-trade-db`): about 562,000 rows a day, 17.4 M a month; 360,000 of it is the 10-minute stake-estimate upsert (1,167 rows × 144) and the 10-minute full rewrite of the 1,334 Osmosis holder rows [cost, finding 2]. **The staged bulk build adds** a 5-hourly `UPDATE` over every unchanged latest span (64,377 × 2 × 4.8 ≈ 618,000 a day, 19.2 M a month), taking the account to about 37 M a month; the nav plan's step-4 triggers would then fire on every Osmosis full-list rewrite (+576,000 a day) and overrun the 50 M. **Three changes in the bulk build's files free about 945,000 rows a day (29 M a month)** and are a gate for this plan (section 7): (a) diff the Osmosis list against the stored rows as the Namada listing is diffed and write only changed rows (~5,000 a day instead of 192,000); (b) run the stake-estimate upsert hourly (28,000 instead of 168,000) now that the bond listing is the chain's figure; (c) replace the span-extend sweep with the `listings` table (24 + 36 rows a day) and the rule "the latest span of a row the listing left unchanged is confirmed through the last complete listing within 6 h", so `balanceAt(t)` reads the span plus the listing times and spans are written on change only [cost, finding 2].

**This plan's writes**: hourly rollups 576; pool price 384; Osmosis volume 96; swap OHLC/volume ~60 (480 max); `pool_hourly` 28 × 24 × 2 = 1,344; `holders.*` 288; `stake.*` 504; `unbond_queue` ~1,000 (4,032 max); `validator_daily` 490; `holder_cohorts_daily` 28; `cohort_daily` 10; `flow_edges_daily` 120; `activity_daily` 4; daily keys ~70; movers and breadth 144: **about 5,100 a day typical, 9,000 at most = 0.15 to 0.27 M a month, under 0.6% of 50 M.** One-off backfills: OHLC/volume ~2,400, flow edges ~42,000, activity ~2,700, pool price ~90,000, token candles ~3,100, `first_seen` 0 (null): about 140,000 writes once. **Reads**: about 3.5 M rows a day (the movers pass is 3.2 M of it), 0.4% of 25 billion; and the overview stops reading 360,000 rows a call once the holder counts come from the listing metrics (today one steady viewer polling every 20 s costs 1.5 to 2.1 billion rows read a day [cost, finding 3]). **Storage**: about 1.6 M new rows a year, under 100 MB.

**Tick time and subrequests**: normal tick +0 external requests, +0 D1 calls (the new metric statements ride in the existing `metricStmts` batch; `runBatch` sends 80 statements per call and the batch holds about 20). Hourly tick: +1 read (the past hour's rows, all keys in one query), +1 batch, the movers pass +2 reads +1 kv write, the Osmosis fetches +3: about +8 subrequests. Bond-listing tick: +1 batch when the queue hash changed. Balance-listing tick: the `holders.*` rows join the listing's own batch, +0. Daily tick: 4 `GROUP BY` reads (cohorts 88 ms / 128,755 rows; genesis cohort 162 ms / 17,184; edges and activity under 10 ms) +1 batch: +5 subrequests, under 0.5 s. **Worst case 311 + 8 = 319 of 1,000; the 13 s tick stays far inside 45 s.** The hourly and daily jobs use the existing `now % period < 60000` gate plus kv `jobs.<name>.last` so a skipped tick (lock held, deadline) runs the job on the next tick; snapshot tables cannot be recomputed for a missed day and the chart shows the gap [cost, finding 13].

### 5.6 Where each writer sits in `cron.ts` (one call each, the body in `worker/src/series.ts`)

Phase 2 (612–631): nothing. Phase 3 (635–643): `swapHourStmts(rows, hour)` replaces the inline median with the median plus OHLC/VWAP/volume keys, same `price.swap_1h` output. After the batch at 645: `await series.hourly(env, now, { pools: poolRes, health })` (rollups, `pool_hourly`, Osmosis fetches, movers) and `await series.daily(env, now)` (snapshots, edges, activity, taint, events seed, governance rows), both self-gated. Inside `runBalanceListing` (295–363): `added` counter and `holdersListingStmts(rec)` pushed into the listing's batch. Inside `runBondListing` (372–425): `unbondQueueStmts(listing)` and `stakeListingStmts(listing)` after `parseBondListing` returns the unbond vector and per-validator sums. Price rules: `series.priceRules(env, now, price)` beside the `price_vs_execution` check (756). That is five lines in `cron.ts`, one in `sources/namada.ts` (return the vector), and nothing in `holders.ts` beyond `SPAN_KEEP_MS` 8 → 31 days.

---

## 6. File ownership for a parallel build (no shared file)

Roles as `build-plan.md` section 3 and `nav-search-plan.md` section 5: **W** worker, shared, data; **F2** provenance; **F3** controls; **F4** data display and charts; **S1–S7** screens and sheets. The nav plan's owners keep their files; this plan's owners get new files wherever the nav plan already owns the natural home, and the handful of one-line mounts into contended files are listed as such with their timing. `worker/src/cron.ts`, `holders.ts` and `sources/namada.ts` are being rewritten by the staged bulk build and touched by nav step 4 after it: **read them fresh from `master` on the day, never from this document**, and change them only in step 1b, after that build and nav step 4 have merged.

| Owner | Files | Work |
|---|---|---|
| **W1** series writer | `migrations/0008_series.sql` (new), `worker/src/series.ts` (new: `hourly`, `daily`, `swapHourStmts`, `holdersListingStmts`, `unbondQueueStmts`, `stakeListingStmts`, `moversPass`, `priceRules`, `cohortRules`), `worker/src/series-sql.ts` (new: every statement as a string with its measured cost in a comment), `scripts/backfill-series.ts` (new), `test/series.test.ts` (new), `test/fixtures/series-*.json` (new) | sections 3.1–3.8, 5.2, 5.3, 5.5 |
| **W1 (step 1b only)** | `worker/src/cron.ts` (five call lines, section 5.6), `worker/src/sources/namada.ts` (`parseBondListing` returns `unbonds` and `byValidator`), `worker/src/holders.ts` (`SPAN_KEEP_MS`), and the three budget changes of 5.5 (a)–(c) in the same files | after the bulk build and nav step 4 have merged |
| **W2** Osmosis source | `worker/src/sources/osmosis-data.ts` (new), `test/osmosis-data.test.ts` (new), `test/fixtures/osmosis-pair-chart.json`, `osmosis-pair-summary.json` (new, trimmed to the NAM pairs) | section 2.11, 5.4 |
| **W3** API and types | `worker/src/series-api.ts` (new, a Hono sub-app), `shared/series-types.ts` (new), `web/src/api-series.ts` (new), `test/series-api.test.ts` (new), `test/routes-series.test.ts` (new: every param read appears in `CACHE_PARAMS`) | section 2.12; the mount line in `api.ts`, the `hours` cap constant, the `CACHEABLE_API` / `CACHE_PARAMS` entries in `http.ts` and the two FactKeys in `shared/copy.ts` are **queued to the nav plan's W owner** as four named one-line changes, landed with nav step 3 |
| **W4** classifier and alerts | `worker/src/parse/namada.ts` (`classify`), `shared/alerts.ts` (three rules), `shared/types.ts` (`FlowKind`, `AlertRuleId`), `scripts/repair-pos-balance.ts` (new), `test/parsers.test.ts`, `test/alerts.test.ts` | sections 3.0, 2.9, 3.7; `shared/types.ts` is `M` in the staged bulk build: land after that merge, day 2 |
| **F2** | `web/src/lib/prov.ts` (`PLAIN_SOURCE` words: Osmosis app data, daily holder snapshot, chain bond listing, flow index), `web/src/lib/glossary.ts` (staking account balance, pool price, cohort, VWAP as "average price paid") | after the bulk build merge (`prov.ts` is `M` there) |
| **F3** | `web/src/lib/kinds.ts` (the `pos_balance` tag), `web/src/ui/Tag.tsx` (the `Repeated small buys` category tag) | |
| **F4** | `web/src/ui/PriceChart.tsx` (ranges, bars, band, pool series, flat ticks), `web/src/ui/ShareBar.tsx` (new; `SupplyBar` becomes a thin wrapper in a later cleanup, not now), `web/src/ui/Ledger.tsx` (new), `web/src/ui/Bars.tsx` (new: daily/hourly bars, stacked option, container-measured, 11 px ticks), `web/src/styles/components/series.css` (new), `web/src/ui/Demo.tsx` entries | the export lines in `ui/index.ts` and the `@import` in `styles/index.css` go to F1 as two one-line changes |
| **S2** Trade | `web/src/screens/trade/index.tsx`, `data.ts`, `Pools.tsx`, `model.ts`, and new `Buyers.tsx`, `Volume.tsx`, `Tape.tsx`, `Value.tsx`, `Links.tsx`; `web/src/styles/screens/trade.css`; `web/e2e/trade.spec.ts` | section 4.2 Trade |
| **S3** Supply | `web/src/screens/supply/index.tsx`, `parts.tsx`, `ReadyToSell.tsx` → `Sellable.tsx` (rename), new `FlowLedger.tsx`, `Validators.tsx`, `Unlocking.tsx`; `supply.css`; `web/e2e/supply.spec.ts` | section 4.2 Supply |
| **S4** Shielded | `web/src/screens/shielded/index.tsx`, new `Direction.tsx`; `shielded.css`; `web/e2e/shielded.spec.ts` | section 3.8 |
| **S5** Activity | new `web/src/screens/activity/Cohorts.tsx`, `Early.tsx`, `Movers.tsx`, `Active.tsx`, `anchors.ts`; the mount lines in `Holders.tsx`, `Transactions.tsx`, `index.tsx` and the age tags in `parts.tsx` are the **last change, after nav steps 4 and 7** (the same role owns both plans' Activity work); `web/e2e/activity.spec.ts` additions in a new describe block | sections 3.1, 3.3, 3.6 |
| **S6** Alerts and Settings | `web/src/screens/alerts/index.tsx`, `rules.ts`, new `Watchlist.tsx` (shared by Alerts and Settings), `settings/*`; `alerts.css`, `settings.css`; `web/e2e/alerts.spec.ts`, `settings.spec.ts` | sections 2.8, 2.9, 3.7 |
| **S1** Home | `web/src/screens/home/Hero.tsx` (fact strip key), `Where.tsx` (two value lines), `Rail.tsx` (unlocking), `data.ts` | section 4.2 Home |
| **S7** Sheets | `web/src/screens/sheets/AddressSheet.tsx`: "Add to watchlist" (after nav's origin eyebrow lands) | section 2.8 |
| **F1** | `ui/index.ts`, `styles/index.css`, `Palette.tsx` (panel rows in the Views group, after nav step 5), `app/overview.tsx` (nothing) | the one-line mounts |

Contracts that let owners start on day one: W3 publishes `shared/series-types.ts` and the four route shapes first; F4 publishes the four component prop types as stubs exported from `ui/index.ts` (F1 adds the lines); W1 publishes the table DDL and key names (section 5.2–5.3) and the fixture rows W3 and the screens test against. No file is touched by two owners inside this plan; the seven one-line changes into the nav plan's files are named above with the step they land in.

---

## 7. Tests and gates

**Unit (Vitest, `test/`, on the D1 stand-in `test/d1-sqlite.ts` with migrations 0001–0008 applied):**

- `series.test.ts` (W1): seed 400 holders across both chains, 60 stakers, 30 labelled genesis/backer/foundation addresses, two pools, the seven protocol accounts, 300 flows over four days including one `transfer-from-wasm` pair and one timed-out bridge send. Assert: `daily()` writes exactly 14 `holder_cohorts_daily` rows whose `spendable` sums to the seed's user-spendable total and `staked` to the seed's bonds (the reconciliation the trader lens measured); running `daily()` twice for the same day writes the same rows (idempotent `INSERT OR REPLACE`), and a missing day leaves a gap (no row is invented); `cohort_daily` for `backer` equals the labelled join; `flow_edges_daily` counts each crossing once and excludes the refunded send; `activity_daily.active` excludes protocol accounts; `swapHourStmts` writes OHLC rows only for hours with a qualifying swap and `price.swap_1h` equals the old inline median on the same rows byte for byte; the hourly rollup's `price.usd.1h` equals the last minute row of the hour and `.lo`/`.hi` its extremes; `moversPass` returns null, never 0, for an address with no span at t − window and lists the correct top and bottom rows; `unbondQueueStmts` from `test/fixtures/bonds_listing.json` (extended with an unbond vector) produces the right epochs and sums and rewrites nothing when the hash is unchanged; `stake.top10_pct` uses the chain's total stake as denominator; `priceRules` fires once per crossing and re-arms; `cohortRules` fires on a 1% fall. `EXPLAIN QUERY PLAN` for every `series-sql.ts` read contains `SEARCH` with `USING INDEX`/`PRIMARY KEY` and never `TEMP B-TREE` or `SCAN flows`.
- `osmosis-data.test.ts` (W2): the pair-chart fixture parses to hourly points with `flat` set where open = high = low = close (74 of 169 in the probe); a `[]` answer (pool 3008) is "no series", not an empty chart; the summary fixture yields 27 NAM pairs and the right `volume_24h` sum; a timeout keeps the previous values and sets the health note.
- `series-api.test.ts` (W3): each `/api/series/:table` range read returns `firstDay` and `prov`; `from`/`to` as dates and as ms; an unknown table is 404 with plain words; `/api/series/trades` pages by keyset without repeats, excludes `meta.arb`, and `makerTrades` matches a count; `/api/series/volume` windows sum the fixture; `/api/movers` serves the kv row whole. `routes-series.test.ts`: every `c.req.query('<name>')` in `series-api.ts` appears in `CACHE_PARAMS`.
- `parsers.test.ts` (W4): the eight staking-account rows (fixture from the trader lens' ids: `namada:6C1989…`, `59AA5A…`, `3B6C6C…`, `5F9E44…`, `192A22…`, `4F4C80…`, `F485AC…`, the 1 M at block 7,900,823) classify as `pos_balance`; a real bond (no descriptor, to the staking account) stays `bond`; a `pos-withdraw-token` row stays `withdraw`. `alerts.test.ts`: `bond` and `unlock` ignore `pos_balance`; `cohort_move` fires for a backer's `ibc_out` ≥ threshold and not for a transfer between two backers; the rule list is eight.
- Existing suites unchanged: `replay.test.ts` and the settings tests byte-identical (N10); `holders.test.ts`, `flows.test.ts`, `bulk-index.test.ts`, `stake-discovery.test.ts` pass.

**Playwright (`web/e2e/`, viewports 360, 375, 390, 412, 768, 1280):**

- `trade.spec.ts`: the range segmented shows six options, `90d` draws the pool series with the source line naming "Osmosis app data" and no quoted line before 15 Oct 2026; with a fixture of 3 trade-hours in 24 h the chart shows 3 dots, 3 bars and 21 empty slots, and the sparse sentence reads the counts from data; the changes row shows `—` with the reason for 30 d on a server whose `price.usd` starts 5 days ago; the tape groups 12 consecutive buys by one maker into one row with a disclosure; the pools rows show two volume columns with separate `ProvDot`s and `—` with the reason on pool 3008; the two value lines say "All NAM at today's price" and "Spendable NAM at today's price" and never the words "market cap"; `layoutAudit('main')` at every viewport: `overflowX` false, no `<table>`, `smallTargets` and `smallText` empty.
- `supply.spec.ts`: the hero reads "NAM that could reach the market" with four rows each carrying a `ProvDot`; the ledger's five rows show signed figures with true minus signs and a two-sided bar; the unlocking bars cover 14 days; the 14-day staked chart prints "recorded since 18 Oct 2026" when the series is shorter.
- `activity.spec.ts` (new describe): `/holders#cohorts` scrolls to the cohort panel under the sticky stack; the five cohort rows reconcile (their NAM sums to the fact strip's visible total within rounding); the 7-day change cell shows `—` with "Recorded daily since 20 Oct 2026…" on a fixture with one snapshot; a holder row shows exactly one of `Genesis`, `First seen …`, `No move on record`; the movers segmented switches windows without a request leaving `/api`.
- `shielded.spec.ts`: the direction word is one of In / Out / Flat and matches the sign of the 7-day ledger.
- `alerts.spec.ts`, `settings.spec.ts`: eight rule rows; the price rule's Fields take X and Y with the dollar equivalent derived; Your addresses lists a watched address with its cohort tag; signed out shows "Sign in to choose".
- `gates.spec.ts`: G4 axe on `/trade?range=90d`, `/holders#cohorts`, `/supply`; G5 copy (sentence case; none of the banned words in rendered text: the new panels must say "Osmosis router", "bridge", "staking account", "shielded pool", "Namada node"; no numeric literal in copy strings, every figure from data); G6 viewport matrix with the new panels; G7 reduced motion (bars draw complete, no wipe); G10 N1 on `/trade`, `/supply`, `/holders` (every `[data-num]` has its control or sits in a scope whose `SourceLine` lists it; the ledger's ten figures are listed by one `SourceLine`).

**Screens and audits with `scripts/shoot.mjs`** (each line must print `"overflowX":false`, `"smallText":[]`, `"smallTargets":[]`, `"tables":0`): `trade` at 375 (tall) and 1280; `trade?range=all` 375; `supply` 375 (tall) and 1280; `holders#cohorts` 375 and 1280; `shielded` 375; `alerts` 375 signed in; `trade` 320 × 700.

**The other gates, unchanged and required:** `npm run typecheck`; `npm test`; `node --experimental-strip-types scripts/copy-lint.ts`; `npm run build && node --experimental-strip-types scripts/budgets.ts` (the long-range chart data, the tape and the cohort panels load in lazy chunks; the initial JS stays at most 130 KB gzip; print before and after in the PR); `scripts/contrast.ts` (no token changes: this plan adds no colour).

**Production checks before each step is called done** (read-only `wrangler d1 execute namada-trade-db --remote --json`, and the tick log): after step 1a, the account's D1 rows-written figure a day later against the 5.5 arithmetic (ceiling: the day's figure within 20% of today's plus 9,000); the tick's subrequest count from the Worker log (ceiling 330) and its duration (ceiling 20 s on the daily tick); `EXPLAIN QUERY PLAN` of each series read on production (no `TEMP B-TREE`); the `holder_cohorts_daily` row sums against `/api/overview`'s `supply.transparentLiquid` and `supply.bonded` on the same day (within 0.1%); the `price.swap_1h` series before and after the routed-swap change on the last 30 days (every old point still present; new points only in hours with routed swaps); `price_vs_execution` still passing; the first `unbond_queue` sum against `supply.posBalance − supply.bonded` (the queue must be at most that figure; the remainder is withdrawable plus unclaimed rewards, printed as such).

---

## 8. Order of work, effort, and what ships first

Engineer-days by owner. The nav plan's 37 days run first or alongside; this plan's step 1b waits for the bulk build and nav step 4 because those three files are theirs until then. Everything else starts on day 1 against the published contracts.

| Step | What | Owner | Days | Depends on |
|---|---|---|---|---|
| 0 | **Contracts and the data flag.** `shared/series-types.ts`, the four route shapes, the DDL and key names, the component prop stubs; `pos_balance` kind, classifier, dry-run report, the eight-row repair, alert tests; owner questions filed (Rewind example wording; the exchange-candidate wallet; `SITE.links`) | W3 0.5, W1 0.5, F4 0.5, W4 1.5 | 3 | the bulk build merge for `shared/types.ts` |
| 1a | **The writers that do not touch the contended files**: `series.ts` and `series-sql.ts` with `hourly()` and `daily()`, migration 0008 applied (`--local`, stand-in proof, then `--remote` off-peak through `scripts/d1-apply.ts`), the rollups, `pool_hourly`, snapshots, edges, activity, daily keys, price and cohort rules; `osmosis-data.ts` and its hourly fetches; the one-off backfills (OHLC/volume, edges, activity, pool price, token candles). **Mounted by the two `series.hourly` / `series.daily` lines only**, which is the one exception to "no contended file before 1b": two lines after `cron.ts` 645, applied to whatever `cron.ts` is on `master` that day | W1 5, W2 2 | 7 | 0 |
| 1b | **The listing hooks and the budget changes** in `cron.ts`, `holders.ts`, `sources/namada.ts`: `holders.*` keys and `first_seen`, the unbond vector and per-validator sums, `unbond_queue` and `stake.*`, `SPAN_KEEP_MS` 31 d, the Osmosis list diff, the hourly stake estimate, the `listings` table in place of the span sweep | W1 | 3 | the bulk build merged and deployed, nav step 4 merged |
| 2 | **The API**: `series-api.ts`, `api-series.ts`, the four mounts queued to nav's W, tests | W3 | 2.5 | 0, 1a |
| 3 | **Trade**: chart ranges, bars, band, pool series, changes row; buyers paid; volume vs depth; pairs columns; tape; the two value lines; links | F4 3, S2 4 | 7 | 0, 2 |
| 4 | **Holders**: `ShareBar`, cohort panel, early holders, movers, age tags, anchors, fact strip | F4 1, S5 3 | 4 | 1a, 1b (movers, new holders), nav steps 4 and 7 |
| 5 | **Supply**: sellable hero and layers, flow ledger (`Ledger`), who the stake is with, what unlocks when (`Bars`), staked-chart caption | F4 1.5, S3 3.5 | 5 | 1a (ledger), 1b (validators, queue) |
| 6 | **Shielded, Home, Activity strip**: direction and ledger; fact strip key and value lines and rail; active-addresses strip and bars | S4 1, S1 1, S5 1 | 3 | 1a |
| 7 | **Alerts and watchlist**: three rules in the UI, Your addresses, Settings thresholds, Address-sheet action, palette rows | S6 3, S7 0.5, F1 0.5 | 4 | 0, 2, nav step 5 (palette) |
| 8 | **Tests, audits, production measurements** of section 7, shots into `docs/design/shots/`, the events table seed and `/api/events` markers, governance rows, cohort taint (phase two of 3.3) | W1 2, W3 1, S2 1, S3 1, S5 1 | 6 | each step |
| | | | **44.5** | |

**What ships first, and why.** Step 0 and step 1a go to production as one deploy with no visible change: the moment they run, the clocks start on every series that cannot be backfilled (holder counts and cohorts from the next complete listing; depth, validators and the queue from deploy day; the daily snapshots from the next midnight). Every day before that deploy is a day of history that will never exist. The second deploy is step 2 with the Trade screen (step 3): the screener basics, the one page a Namada user is looking for today, with the honest 70-of-720-hours chart and the Osmosis pool series for the long ranges. Then Holders (4) and Supply (5) together, the moat; then 6 and 7; 8 throughout. Each deploy keeps old clients working: the new chart props are optional, the overview's new fields are additive, and a client that meets a server without `/api/series` shows the panels' `—` state with the reason "This figure is not served yet", never an error.

**The verdict in one line.** Build it inside the six tabs, writers first and screens second, with the Osmosis data API as the only new outside source and every long-range or pool-level figure labelled as what it is; the Supply hero changes to the four sellable layers, the staking-account transfers get their own kind before any staking stat is drawn, and nothing before 20 Oct 2026 is shown for any Namada balance series.
