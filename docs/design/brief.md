# NamadaTrade design brief (Phase A)

Status 2026-10-17. Inputs: the audit lenses, all code under `web/src`, README, `docs/decisions.md`, `private/trades.md` (not published), `docs/replay-report.md`, `docs/design/prompt.md`, namada.net/visual-identity, and my own measurements of namada.trade at 375x812 and 1024 px today.

Evidence notes:
- `index.css` lines are working-tree numbers. The tree has an uncommitted `@layer components { … }` wrap of the primitives (`index.css:78-80`). The live bundle (`index-Dp2FB5S-.css`) is still unlayered, so every defect that depends on it is live.
- Two lens claims are stale: the favicon is no longer hot-linked (icons are local), and hash routes are only a redirect (`App.tsx:23-28`, `shared/routes.ts`).
- The lens payload was truncated: the mobile lens stops after its first finding and the last lens or two never arrived. Section 7 rests on the mobile summary, other lenses' mobile findings, my measurements and the code; it is the least cross-checked section.
- **Resolved** marks a decision between conflicting lenses.

## 1. Positioning

**One sentence.** NamadaTrade shows what moved NAM, who moved it and what a trade really costs on Osmosis, and every number carries its source and age.

**Audiences.**
1. NAM traders: numbers fast, with provenance (what an order gets, inventory on deck, coming unlocks, shielded share, alerts). The market is thin: pool depth is $1,749 today (`overview.dex.liquidityUsd`; the docs said about $1,250 on 16 Oct), so a $50 order is a whale order.
2. Holders who follow Namada: understand the market in a minute (worth, holders, whether to worry, what "shielded" means for price). They do not read tables.

**Brand character: plain, exact, sourced.**
**Resolved:** the brand lens proposed "unshielded". I chose "sourced" because provenance is the one thing competitors lack, and "unshielded" collides with the unshield flow kind.

**Relationship to Namada: sibling, not clone.** Borrow Namada Yellow #FFFF00, black ground, Space Grotesk, 2 px and pill radii, the nouns "shielded" and "shielded set", and the voice rules "clarity without coercion" and "insights without monotony". Make our own: the dark instrument surface, tabular mono numbers with provenance, question headlines, a two-row term lockup (plain word over precise term). Never use Namada's symbol as our mark or favicon; it appears once, unmodified, in the footer beside "Not affiliated with Namada or the Anoma Foundation."

## 2. What reads as generic today (top 12, by impact)

| # | Tell | Where |
|---|---|---|
| 1 | No home page, no `<h1>`, no sentence saying what this is; `/` renders the trade ticket. Largest type 18 px (36 px once). Meta description is desk slang. | `App.tsx:32`, `shared/routes.ts:21`, `TradeView.tsx:74`, `BlindSpotView.tsx:25`, `index.html:6-7` |
| 2 | Every panel is one card (12 px bold uppercase title, D-chip, 11 px subtitle, `p-4`) in the same 12-col 5/7 grid: 26 `<Card`, four views. No primary, secondary or detail. | `Num.tsx:59-76`, `TradeView.tsx:53`, `PressureView.tsx:32`, `BlindSpotView.tsx:22`, `AlertsView.tsx:26` |
| 3 | Default AI type pairing, no scale. `text-[10px]` x53, `text-[11px]` x74. On `/pressure` at 375 px no text in `<main>` exceeds 12 px (9 px x10, 10 px x136, 11 px x174, 12 px x268). | `index.html:14`, `index.css:42-43` |
| 4 | Blue-tinted slate surfaces. Yellow is only the "selected" outline, up to four controls lit at once. Light theme swaps the accent to Tailwind blue. | `index.css:10-18`, `:19`, `:57`, `:95` |
| 5 | Copy is the author's changelog: "post-balances", "cron", "RPC keeps 3,600 blocks", `npm run test:replay`, `docs/events.json`, "ammunition", "overhang". D1-D7 sit in every title. | `BlindSpotView.tsx:43`, `PressureView.tsx:125`, `AlertsView.tsx:54`, `SettingsView.tsx:12-16`, `TapeView.tsx:98,124`, `Num.tsx:66` |
| 6 | Slang menu (Pressure, Blind spot, Tape). The plain questions are hover `title` only, so never on a phone. Holders are two taps deep. | `Header.tsx:9-13,59,86-91`, `TapeView.tsx:15-16` |
| 7 | Responsive utilities are dead because primitives are unlayered. At 375 px `btn hidden sm:inline-flex` still shows Search (102 px, x=157); the 24h change wraps to 26x33 px; the header is 96 px, sticky, two rows. At 1024 px the Tape search (`w-48`) is 950 px wide. | `index.css:81+` (live), `Header.tsx:49,53,71,86-91`, `TapeView.tsx:60` |
| 8 | Desktop tables on phones: Pressure tables are 459 and 537 px in a 317 px column; Tape shows 19 buttons above the data; 97 of 127 interactive elements are under 44 px (smallest 15). | `PressureView.tsx:49-51,98-100`, `TapeView.tsx:56-65,131-133`, `TradeView.tsx:116,143`, `BlindSpotView.tsx:49` |
| 9 | Unicode dingbats as icons: 18 glyphs from whatever fallback font the OS has, plus an emoji replay chip. | `format.ts:70`, `Header.tsx:68,90`, `Num.tsx:28`, `TrustPanel.tsx:49`, `LoginModal.tsx:87` |
| 10 | Chart is a fixed 600-unit viewBox: letterboxed on desktop, 5 px ticks on phones, three raw ticks, no source line, buy/sell colours reused for two price series. | `LineChart.tsx:28,46,69,73,110`, `TradeView.tsx:47-48` |
| 11 | Stock chrome: a letter in a rounded yellow square, a two-tone wordmark, a developer status line as footer, a cmdk-template palette, `prompt()` for replay. `docs/design/og.svg` repeats the mark and slate palette. | `Header.tsx:44-45`, `App.tsx:152,185-191`, `CommandPalette.tsx:48,81-83` |
| 12 | Flat states: "Loading…" x12, `<Empty>` x25 as a centred grey line; one 200 ms fade; no `prefers-reduced-motion`; sub-dollar values print "$0" (`fmtUsd(n*spot, 0)`). | `Num.tsx:78-80`, `index.css:142-147`, `PressureView.tsx:24` |

## 3. Success criteria

| Test | Protocol | Pass |
|---|---|---|
| Five-second | Home at 375x812 for 5 s to 5 adults who do not hold NAM, then hidden. Ask what the site is, who it is for, one number seen. | 4 of 5 name NAM or Namada plus "price, holders or market"; 4 of 5 recall one real number. |
| Task | `docs/task-tests.md` Q1-Q6, three conditions (old UI tag `ui-v1`, new UI, Osmosis app plus explorer), at least 3 traders. Add two tasks for 3 non-holders: "who holds the most NAM?", "is NAM easy to sell in size, and how do you know?" | New UI median at most 70% of old UI and at most the Osmosis+explorer median on every question; accuracy at least old UI; any answer over 90 s fails. The record table is empty today. |
| Believer | The owner's friend and two other Namada people blind-rate three screenshots (ours, Osmosis app, a generic Tailwind dashboard), 1-5, "built by a team / built by a prompt". | Ours median at least 4.0, at least 1.0 above the template, no rating under 3. |
| Lighthouse (mobile, default throttling) | Home, Trade, Supply, Shielded, Activity | Performance at least 90, accessibility and best practices at least 95; LCP at most 2.5 s, CLS under 0.1, TBT at most 200 ms. Initial JS at most 130 KB gzip (86 KB today), fonts at most 120 KB. |
| Contrast | axe AA plus a script over every token pair, both themes | Text at least 4.5:1 (3:1 at 24 px or 18.66 px bold); control borders and chart marks at least 3:1; `--ink-3` never on numbers. |
| Copy lint | Script over rendered strings and `web/src/**/*.tsx` literals | Zero hits for the banned list (SQS, IBC, DEX, PoS, MASP, ABCI, RPC, cron, webhook, npm, bare "D1"-"D7", "Loading…") outside the allowlist (glossary, Sources "How it is computed", For developers). Home copy at most grade 8 (Flesch-Kincaid). Sentence case. |
| Overflow | Playwright at 360x780, 375x812, 390x844, 412x915, 768, 1280 on every route, with `?at=` and with each sheet open | `scrollWidth <= innerWidth`; no `<table>` below 640 px; at least 95% of interactive elements at least 44x44 px (inline links exempt at line-height 24 px or more); no text under 11 px, provenance at least 12 px on phones. |
| Motion | Emulate reduced motion, sample after load | `document.getAnimations().length === 0`; no layout shift when data arrives. |

## 4. Naming

**Rules.** Plain word visible, expert term on tap or hover, never the reverse. Nav labels at most 9 characters. Each page's H1 is a question.

**Resolved (names).**
- *Shielded*, not "Hidden" or "Private pool": Namada's own noun, known to audience 2; the brand lens notes the protocol's feature must not read as a defect. The H1 carries the plain gloss.
- *Trade* stays. Three lenses kept it and traders look for it. The normie lens's worry (it implies execution) is answered by the page's first line, "An Osmosis quote, not an order. This site never trades for you." "Price check" stays an open alternative (9).
- *Supply*, not "Sellers & unlocks" (too long for a six-tab bar) or "Pressure" (blood pressure). The H1 says "Is a big sale coming?".
- *Activity*, not "Ledger" or "Tape". *Holders* are a Home section plus `/holders` (Activity on its Holders tab), not a tab, which keeps six items in the bar.
- *Rewind* is the visible word for replay; "replay" stays in URLs, docs, tests and the glossary.

| Where | Old | Plain (shown) | Expert (tooltip or glossary) |
|---|---|---|---|
| Nav 1 | none | Home, H1 "What moved, who moved it, and what it costs to trade NAM." | overview |
| Nav 2 | Trade | Trade, H1 "What would I get if I sold NAM now?" (verb follows the side toggle) | D1, route quote |
| Nav 3 | Pressure | Supply, H1 "Is a big sale coming?" | D2-D4, sell pressure |
| Nav 4 | Blind spot | Shielded, H1 "How much NAM can't be seen?" | D5, MASP |
| Nav 5 | Tape (Flows, Holders) | Activity (Transactions, Holders), H1 "Every move, with its source" | flows, tape |
| Nav 6 | Alerts | Alerts, H1 "What should wake me up?" | D7 |
| Header status | dot, stream/poll, "4/6 checks" | "Live · 5 of 7 checks" or "Updating every 20 s"; sheet title "Where every number comes from" | D6, trust panel |
| Replay | "Replay as of a time…", "⏪ … exit" | Rewind to a date…; banner "Rewound to 30 Aug 2026, 19:05 UTC. Every number is as it was then; live prices are paused. Back to now" | replay, `?at=` |
| Trade cards | Trade ticket, Price, Depth ladder, Pools | Your quote, Price: quoted vs paid, How size moves the price, Where NAM trades | ticket, SQS mid vs executed, depth ladder |
| Trade fields | Fill price, Impact, "split into N clips", Notional, Counter, Osmosis float, "arbs excluded", ▼ Sell NAM → USDC, "SQS mid" | Your average price, Price move, "better as N smaller orders", Value ($), Other coin, NAM on Osmosis, "bots removed", Sell NAM for USDC (no arrows), "Quoted price" | fill price, price impact, clips, float; USDC is a dollar-pegged coin; SQS is Osmosis's Sidecar Query Server |
| Supply cards | Inventory on deck, Who is moving the price, Unlocks and re-locks, Governance in flight | Ready to sell on Osmosis, Who is moving the price, Unstaking and restaking, Votes in progress | inventory on deck, movers, unbond/withdraw/bond |
| Supply columns | Receiver, Remaining, Prior sells, Last, "Then", "B / S", "IBC in 7d", "Net DEX 24h", "Bonded" | Address, Still held, Sold before (30 days), Last seen, "What happened next", "Buys / sells", "Bridged to Osmosis, 7 days", "Net bought on Osmosis, 24 h", "Staked" | IBC, net DEX, bonded |
| Unlock outcomes | in 3.2d, liquid · watching 48h, re-staked, → Osmosis, still liquid | sellable in 3.2 days, unlocked and watched for 48 h, restaked (changed validator, not a sale), moved to Osmosis, still unlocked and could be sold | liquidAt, rebonded, bridged_out |
| Shielded cards | What you cannot see, Hidden share, Net shielded 24h, Largest unshields 30d | Inside the shielded set, Share of all NAM, Moved in, net, 24 h, Largest moves out, 30 days | MASP balance, shield, unshield |
| Activity | Kind, Src, Tx, Liquid, Bonded, Verified, "indexed only" | What, Time and price source, Record, Spendable, Staked, Checked on chain, "not yet checked" | tsSource, priceSource, tx hash |
| Flow kinds | buy, sell, ibc in/out, shield, unshield, bond, unbond, withdraw, lp add/remove, arb, pgf | buy, sell, bridged in, bridged out, shielded in, shielded out, staked, unstaking, unlocked, added to pool, removed from pool, bot trade, public funding | old words in the tag tooltip |
| Status words | live, stale, missing, conflict | fresh, old, no data, sources disagree (each with its age) | provenance status |
| Alert rules | Inventory arrived on Osmosis, Stake withdrawn, Large DEX swap, Hidden holder surfaced, Overhang removed | NAM bridged to Osmosis, NAM unstaked, Large trade, NAM left the shielded set, Large amount staked; conditions in plain sentences ("50,000 NAM or more moved out of the shielded set to a personal address") | rule ids `ibc_inventory`, `unlock`, `big_swap`, `unshield`, `bond` unchanged |
| Sign-in and settings | "tnam1… · the browser extension", "never holds a key"; Notifications, Channels, Devices, API, Privacy & data | Namada wallet (addresses start with tnam1), "never gets your wallet's secret"; Alert rules, Where alerts go, Devices, For developers, Your data | Namada Keychain, Keplr |

**Glossary** (tap or hover on any term; plain row over precise row):
- *Staked* (bonded): locked with a validator; cannot be sold.
- *Unstaking* (unbonding): the wait of about {unbondingDays} days (chain parameter) before staked NAM is spendable.
- *Unlocked* (withdrawn, liquid): finished unstaking; can be bridged and sold.
- *Shielded set* (MASP, Multi-Asset Shielded Pool): the total is public, the owners are not.
- *Bridged* (IBC): moved between Namada and Osmosis; NAM must cross before it can be sold.
- *Ready to sell* (inventory on deck): NAM that crossed to Osmosis and has not been sold or sent back.
- *Pool*: a shared pot of NAM and another coin that anyone trades against.
- *Price move* (price impact): how far your own order pushes the price.
- *Quoted price* (SQS mid): what the exchange shows before any order. *Last trade price* (executed): what real trades paid.
- *Bot trade* (arbitrage): round trips for tiny profit; excluded from buyer and seller counts.
- *Rewind* (replay): every number as it was at a past moment.
- *Fresh, old, no data, sources disagree*: how far to trust a number right now.
- *Holder*: an address holding spendable or staked NAM; protocol accounts excluded.

**Tone.** Sentence case everywhere; capitals only for eyebrow labels and currency codes. Numbers lead the caption ("25,000 NAM bridged by osmo1d5v… 3 hours ago"). Verbs, not categories. Human time ("3.2 days"); UTC stated once per screen. No acronym on a card without its plain word. Empty states say what would appear and what its absence means ("No NAM crossed to Osmosis in 7 days. Crossings usually come before sales."). Operator text (npm, paths, cipher names, channel ids, node names, API routes) only in Sources "How it is computed" and For developers. No warehouse or war metaphors. Keep the honest register ("No transaction, no fee, nothing moves", `LoginModal.tsx:36`; "The honest limit…", `SettingsView.tsx:221`).

## 5. Information architecture

**Navigation.** Six destinations in fixed order: Home, Trade, Supply, Shielded, Activity, Alerts. Primary on every screen: those six. Secondary: Search, Rewind, the status control (opens Sources), the account menu (Settings, sign out, theme).
- Phone (below 1024 px): bottom tab bar, six tabs at least 62 px wide, 20 px icon plus 11 px label, 56 px high plus `env(safe-area-inset-bottom)`; Alerts carries a count dot for hits since `lastSeen`. Header is one 52 px row: mark, price with change (never wraps), status, search icon, account.
- Desktop (1024 px up): 64 px header with wordmark, six text tabs (selected = 2 px yellow underline, no box), price chip, Rewind, Search (shows "Ctrl K" only when `pointer: fine`), status, account. No second row.
- Keys follow the new order (1 Home … 6 Alerts) plus `/` for search, and must ignore events with Meta, Ctrl or Alt held (`App.tsx:139` also fires on browser Cmd-1…5).
- Routes: `/`, `/trade`, `/supply`, `/shielded`, `/activity`, `/holders`, `/alerts`, `/settings`. `/pressure` and `/tape` redirect (`ROUTE_ALIASES`, `routes.ts:31`). Per-route titles, the sitemap and the server-rendered summary (`worker/src/seo.ts`) carry the same plain names and H1; `?at=` survives every redirect.

**Resolved (price in header).** The price stays in the header on every route, Home included, because it is "the one number every decision starts from" (`Header.tsx:48`). It duplicates the Home hero on purpose.

**Reading order.** Each screen has one hero (a number of 32 px or more plus one sentence); everything else is 24 px or smaller.

| Screen | Phone (360-430 px) | Desktop (1280) |
|---|---|---|
| Home | Hero band, what changed, where all NAM is, who holds it, how NAM reaches the market, quote mini-ticket, why trust it, footer | Hero full width; below, narrative (8 cols) and a sticky "Right now" rail (4 cols: price, depth, NAM on Osmosis, unstaking days, each with a provenance chip) |
| Trade | H1, side toggle, amount, "You get" hero with price move, thin-market notice, chart, size ladder as rows, pools as rows | Ticket (5 cols, sticky) beside the chart; ladder and pools below as tables |
| Supply | H1, "Ready to sell" hero, who is moving the price, unstaking and restaking, votes | Hero strip; ready-to-sell beside movers; unstaking full width |
| Shielded | H1, share hero with bar, chart, largest moves out | Hero beside chart (5/7), list below |
| Activity | H1, Transactions/Holders tabs, one Filter button with count, list, load more | Inline filters, sticky-header table, pagination |
| Alerts | H1, "Since you were away", what triggers an alert, where alerts go (one line plus action) | Hits (7 cols) beside rules (5 cols) |

### Home copy deck

Every value is a bound field with a provenance chip or a `derive()` of bound fields. Nothing is typed in as a number except the block marked static and dated.

| Block | Copy | Binding |
|---|---|---|
| Eyebrow | NAMADA TRADE · NAM ON OSMOSIS | static |
| H1 | What moved, who moved it, and what it costs to trade NAM. | `SITE.tagline` |
| Sub | Live price, who holds NAM, who might sell, and how much is shielded. Every number shows where it came from and how old it is. | static |
| Price | NAM price {price} · {change24h} since this time yesterday · chip "Osmosis quote · {age}" | `overview.price` |
| Actions | **See what a trade costs** (to /trade) · How we know (opens Sources) | |
| Fact strip | {namada.holders} holders on Namada · {shielded%} shielded · {osmosis%} on Osmosis | `overview.namada.holders`, derived |
| What changed | H2 "What changed in the last 24 hours". Up to three alert hits in rule words with age, then "{n} more". Empty: "Nothing crossed an alert size in 24 hours. The last one: {title}, {age} ago. Rewind to it." Sub: "Alert sizes are small on purpose: at today's price 10,000 NAM is {derive(10000 x price)}." | `/api/alerts/recent`, `alertRules` |
| Where all NAM is | H2 "Where is all the NAM?" Bar: Staked, Shielded, Public funding, On Osmosis, Everything else spendable, each {pct}. "Only {osmosis%} of NAM, {osmosis} NAM, is on Osmosis, the one place it can be sold. The pools there hold {dex.liquidityUsd}." | `overview.supply`, `overview.dex` |
| Who holds NAM | H2 "Who holds NAM". Ten rows: rank, label or `shortAddr`, total NAM, % of supply, 7-day change, "checked {age}". Sub: "The 10 biggest holders own {namadaTop10Pct} of NAM on Namada. Protocol accounts are excluded. Shielded NAM cannot be attributed to anyone." Link "All {n} holders". | `fetchHolders('namada',1,10,'','total')`, `concentration` |
| How NAM reaches the market | H2 "How NAM gets from a wallet to a sale", four scroll steps. 1 Staked: "Most NAM is staked with validators. Staked NAM can't be sold." {bonded} NAM. 2 Unlocked: "Asking to unstake starts a wait of about {unbondingDays} days." 3 Bridged: "To be sold, NAM crosses to Osmosis. Crossings usually come before sales." {ibcIn7d} NAM in 7 days. 4 Sold: "On Osmosis, NAM trades in small pools. An order of 10,000 NAM moves the price {impact}%." Side note: "Shielded NAM sits in a pool whose total is public and whose owners are not: {share}% of all NAM." | `pressure`, `quote/curve`, `blindspot` |
| Mini-ticket | H2 "What would you get right now?" Amount (default 5,000 NAM), "You get {usdc}", "Price move {impact}%", link "Full quote". If no quote: "The Osmosis quote service is not answering. Last quoted price: {price}, {age}." | `fetchQuote` |
| Why trust it | H2 "Why you can trust these numbers". (1) "Every number shows its source and age. Tap one to see them." (2) "{ok} of {total} cross-checks pass right now{, N need a look}." (3) "Rewind: see the site as it was. Try 30 Aug 2026, 19:05 UTC, when 331 million NAM left staking" (link `/supply?at=1788116700000`). (4) *Static, dated:* "Tested on 26 past events (report of {generated}): each of the 10 biggest price moves had an alert-size flow in the prior 48 hours, median 25 hours ahead. Such flows precede 90% of all hours, so this shows the alerts are not blind, not that they predict direction." | `docs/replay-report.md`, exported at build time with its date |
| Footer | "Every number shows its source and age. Data: Osmosis router, Namada nodes, indexer.namada.net; records current as of {age}. Not investment advice. Not affiliated with Namada or the Anoma Foundation." Links: How we know, Settings, API, Source code (URL to confirm). Namada symbol, 16 px, unmodified. | static, `overview` |

A derived value inherits the oldest `at` and worst status of its inputs and names every input in its chip ("derived: price x total supply"). Build a `derive()` helper beside `Num`.

## 6. Design system parameters

**Colour.** Neutral and hue-less. Yellow is a brand colour, not a state colour.

| Token | Dark | Light |
|---|---|---|
| `--bg` | #000000 | #f4f4f2 |
| `--surface` | #0d0d0d | #ffffff |
| `--surface-2` | #171717 | #ececea |
| `--line` (hairline) | #242424 | #dcdcd8 |
| `--line-strong` (inputs, controls, 3:1) | #666666 | #767676 |
| `--ink` | #f5f5f5 | #000000 |
| `--ink-2` | #a8a8a8 (8.2:1) | #4d4d4d |
| `--ink-3` (12 px or more, never numbers) | #858585 (5.3:1) | #6b6b6b |
| `--accent` (fill, band, mark, focus) | #ffff00 | #ffff00 |
| `--accent-ink` | #000000 | #000000 |
| `--accent-text` | #ffff00 | #5c5100 (7.2:1) |
| `--focus` (2 px ring) | #ffff00 | #000000 |
| `--shielded` (shielded module only, with words) | #00ffff | #006b6b text, #00ffff fill |
| `--buy` `--sell` `--ibc` `--shield` `--pos` (flow tags) | #3987e5 #d95926 #199e70 #9085e9 #d55181 (all at least 4.5:1) | text #1f5fb0 #b8431a #0f7a55 #6250d6 #b02f63 (all at least 5.3:1) |
| `--good` `--warn` `--bad` (status) | #2fbf2f #ff9d00 #ff5c5c | #0a7a0a #b45309 #b42323 |
| `--scrim` | rgba(0,0,0,.6) | rgba(0,0,0,.4) |

Rules: selection is tonal (inverse-ink fill for segmented controls, 2 px yellow underline for the active tab), never a yellow box. Yellow marks only: the mark, the Home band, one primary button per view, the focus ring, the "you" tag, the rewind band, the chart's last-value pill. Flow colours appear only inside kind tags, always with a word and glyph. Status colours only for fresh, old, no data, disagree. Rewind is a full-width black-on-yellow band. Drop `--serious` and `--accent-dim`. Today's `--bad #d03b3b` is 4.05:1 on `--surface` (fails AA text) and `--warn #fab219` reads as a second yellow. Re-run the categorical validator on #0d0d0d before touching flow hues.
**Resolved (colour):** the first lens wanted yellow as the selected state, the references lens wanted it off controls. I took the references rule for controls and the first lens for brand moments.

**Type.** `Space Grotesk` for display and text (the Namada brand face; variable 400-700, latin woff2 about 30 KB, self-hosted, `font-display: swap`, metric-matched fallback) and `JetBrains Mono` for table numbers, addresses and provenance (400, 500, self-hosted). Hero numbers use Space Grotesk 500 with `tnum`; a test asserts "1" and "0" share a width at 48 px, else they switch to mono. No third-party font requests.
**Resolved (type):** the references lens proposed Instrument Serif plus Inter. I chose Space Grotesk: it makes the sibling relationship visible, Inter is itself a default tell, and a serif display competes with the brand. A serif direction stays open (9).

| Token | px / line | Weight, tracking | Use |
|---|---|---|---|
| `--t-11` | 11 / 16 | 500, caps +0.08em | eyebrows, chart ticks only |
| `--t-12` | 12 / 16 | 400 mono | provenance, table headers (sentence case), ages |
| `--t-13` | 13 / 20 | 400-500 | table cells, controls, chips |
| `--t-15` | 15 / 22 | 400 | body, explainers, sub copy |
| `--t-18` | 18 / 26 | 500 | lead, list titles |
| `--t-24` | 24 / 32 | 500 tnum | H2, panel hero numbers |
| `--t-32` | 32 / 38 | 500 tnum, -0.01em | H1 and hero number on phones |
| `--t-48` | 48 / 52 | 500 tnum, -0.02em | H1 and hero number on desktop |
| `--t-display` | clamp(40px, 11vw, 80px) / 1.05 | 500, -0.02em | Home price only |

Numbers: unit in `--t-12` after the value ("24.50 USDC"); sign on every delta; price keeps 6 decimals; sub-dollar values never print "$0" (use `fmtUsd` default digits, `format.ts:14-18`). Floor: 11 px anywhere, 12 px for anything carrying provenance.

**Spacing.** 4, 8, 12, 16, 24, 32, 48, 64, 96. Phone: gutter 16, panel 16, section gap 32. Desktop: gutter 32, panel 24, section gap 64 (Home 96). List row 56 on phones, table row 40 (28 compact). Content max width 1200 (Activity 1360). Breakpoints 360 (minimum), 640, 768, 1024, 1280.

**Radius.** `--r-0` 0 (tables, bands), `--r-1` 2 px (tags, inputs, insets), `--r-2` 12 px (sheets, popovers, modals), `--r-pill` (buttons, chips, segmented controls). The seven current radii and the card-in-inset-in-border nesting go.
**Elevation.** Dark: tone plus 1 px hairline; overlays use `--scrim` and one shadow `0 24px 48px -12px rgb(0 0 0 / .6)`. Light: shadows 0 1px 2px / 0 4px 12px / 0 24px 48px at .06 / .08 / .18. No bordered cards; sections separate by whitespace and a hairline top rule.

**Motion.** Durations 120 / 200 / 320 ms. Easing `--ease-out cubic-bezier(.16,1,.3,1)` for entering, `--ease-std cubic-bezier(.4,0,.2,1)` for state changes and exits (exits at 0.75x). Motion reports change; it never invents it.

| Motion | Trigger | Property | Time | Reduced motion |
|---|---|---|---|---|
| Tick flash | price or net-flow value changes | background `--buy-bg` / `--sell-bg` to transparent | 320 | static highlight, 1 s |
| Staleness | value becomes old | colour to `--ink-2`, dotted underline, age suffix | 200 | same, instant |
| New row | live flow arrives (Activity, Home strip) | opacity, translateY 4 px | 200 | opacity only |
| Supply bar fill | first paint of Home | segment width 0 to true value in sequence; adjacent numbers stay final | 320 each, 80 stagger | final state |
| Chart wipe | first paint of the Home chart | clip-path left to right | 600 | final state |
| Section reveal | Home section enters viewport, once | opacity, translateY 8 px | 320 | none |
| "Path of a NAM" | scroll position on Home | active step highlights, its real number emphasised | 200 | all four steps static |
| Sheets, popovers | open and close | translateY 16 px or scale .98 to 1, opacity; scrim fades | 200-320 | opacity 120 |
| Skeleton | loading | shimmer on row-shaped blocks | 1.2 s loop | static |

Never: counting or rolling a number through intermediate values, animating layout, parallax, or any loop except the skeleton and the live dot (only while the stream is connected and the tab visible).
**Resolved (motion):** the first lens wanted number roll and chart draw-on, the references lens forbids both. I forbid number animation (an intermediate value is a fabricated number) and allow geometry-only reveals on Home, because the owner asked for strong animation and a bar or line wipe shows no value that does not exist.

**Chart rules.** Container-measured SVG (ResizeObserver, CSS px). Keep the custom SVG and delete the unused `lightweight-charts` dependency. 1-2-5 ticks, 4-5 on y, tick text 11 px mono at every width. Title states the takeaway, subtitle the unit. A source line under every chart, built from series provenance ("Source: Osmosis quote, 1-minute; executed swaps, hourly median · as of 11:12 UTC"). Quoted price dashed `--ink-3`, executed price solid `--ink`, never buy/sell colours; shielded series `--shielded`. Yellow last-value pill. Event markers from `docs/events.json` as dashed verticals (labels of 12 characters or fewer), the user's own trades when signed in, a yellow cursor at `?at=`. Touch: press and drag reads values in a fixed readout above the plot (`touch-action: pan-y`), not a tooltip over data. State short history ("Recorded since 12 Aug 2026"). Visually hidden table fallback (first, min, max, last).

**Components.** States for all: default, hover, focus-visible, pressed, selected, disabled, loading; data components add fresh, old, no data, disagree, rewound.

| Component | Notes |
|---|---|
| `Num`, `SNum`, `Derived` | Behaviour as today (`Num.tsx:9-35`). New: the no-data reason shows inline, not cut at 40 characters (`Num.tsx:21`). |
| `ProvChip` (was `ProvBadge`) | Focusable button: dot, short source, age. Tap or Enter opens a popover with source, UTC time, age, height, status, note, "Rewind to this time". `title` kept for desktop hover. The dot always sits beside a word or age. |
| `SourceLine` | Panel footer "Source · as of HH:MM UTC · age" from the panel's coverage provenance. |
| `Tag` | Sentence case, 12 px, SVG glyph, word, tooltip with expert term. |
| `Button` | Primary (yellow fill, black text, one per view), secondary (outline), ghost, destructive (outline `--sell`). 44 px minimum on phones. |
| `Segmented`, `Chip`, `Tab` | Three distinct controls (all are `.btn` today). Close is an icon button with `aria-label="Close"`, never "esc". |
| `DataList` | Table from 640 px; below that rows: line 1 label or address plus one right-aligned number, line 2 tag, counterparty, age. |
| `SupplyBar`, `HeroNumber`, `Stat` | Bar: segments with words and values beneath. Number: label above, value, delta beside, `SourceLine` below. |
| `Sheet`, `Popover`, `Palette` | Bottom sheet on phones (max-height `calc(100dvh - 16px)`, internal scroll, handle), side panel on desktop. Palette groups Views, Addresses, Actions, Glossary; rewind row with a date-time input and presets from `docs/events.json`. |
| `Skeleton`, `EmptyState`, `Notice`, `Banner` | Skeleton rows match final column widths; footers hidden until data. Empty state: what appears here, the threshold, the last occurrence with a rewind link, the window in words (never under one hour). Notice tones (info, success, warning, danger) replace six hand-rolled boxes. Banners: rewound (black on yellow), update ready. |
| `Icon` | One 16/20 px, 1.5 px stroke set replacing the 18 glyphs (`format.ts:70`). |
| `Wordmark` | "NAMADA TRADE" in Space Grotesk caps, tracking 0.06em, "TRADE" yellow on black. Mark: a yellow ring in the Namada ring proportion holding one up/down triangle pair, visibly not Namada's symbol. Ships as `/favicon.svg`, PNGs, apple-touch icon and the OG image (replaces `docs/design/og.svg`). |

## 7. Mobile rules per screen

Baseline 360x780, 52 px header, 56 px tab bar, so about 670 px of content. No horizontal scroll, no hover-only information, no table.

| Screen | First screenful must show | Pattern |
|---|---|---|
| Home | Yellow band with H1, price, 24h pill, chip, primary action; top edge of "what changed" | One column; price 41 px; holders as 56 px rows; "path of a NAM" steps stack and reveal on scroll |
| Trade | H1, side toggle, amount with presets, "You get" and price move | Presets as a scrollable chip row with edge fade; ladder and pools as rows, tap a ladder row to set the size; range as segmented control |
| Supply | "Ready to sell" total with dollars and the top address row | Movers and on-deck as rows (address, one number, tag, age); unlock outcome as a tag; votes only when non-empty |
| Shielded | Share % hero and the supply bar | Chart full width at 160 px; largest moves out as rows |
| Activity | Tabs, Filter button, newest 6 rows | Filter opens a sheet (Chain, What, Size) with a count badge; "time and price source" as an expandable second line; Holders rows: rank, name, total, % |
| Alerts | "Since you were away" hits | Rules as toggle rows; delivery as one line plus action |
| Sheets (Sources, Address, Sign-in, Search) | Title, then the one thing asked for: checks in plain titles; name, spendable, staked; "No transaction, no fee, nothing moves" with wallet options or pair code; the input with recent addresses | Bottom sheets with internal scroll (sign-in has no max-height today, `LoginModal.tsx:31-32`); developer detail collapsed under "How it is computed"; wallet logos replace the "N" and "K" squares; no "Ctrl K" hint on touch |
| Rewind | Banner only | The banner is the only replay control below 1024 px (today the header button makes the page 482 px wide); sticky under the header, one line, 44 px "Back to now" |

## 8. Non-negotiables and regression tests

| # | Rule | Test |
|---|---|---|
| N1 | Every number keeps source and age: `Num`, `SNum`, `ProvChip`, `Sourced<T>`. Fresh normal, old dimmed with age, no data "—" with a visible reason, disagree flagged. | Playwright with `/api/overview` mocked to each status: assert dim class, "—", reason visible without hover, age text. Every `[data-num]` has a provenance control reachable by tap and keyboard. |
| N2 | No fabricated numbers, no hard-coded fallbacks. | Number audit: render each view from a fixture of unique odd values; every numeric text node must trace to a fixture field or a `derive()` call. Lint: numeric literals in JSX strings fail outside the dated static proof block. |
| N3 | Replay: `?at=<ms>` on every route, live quotes off, every fetch carries `at`. | Load `/supply?at=1788116700000` at 375: no overflow, banner present, no header replay button, every `/api` request has `at=`, navigation keeps `at`. Old `#/…?at=` links still redirect. |
| N4 | D1-D7 tags stay, demoted to a `data-decision` attribute, a footer line and a question popover, never a title chip. | Per view, the `data-decision` set equals {Trade D1; Supply D2, D3, D4; Shielded D5; Alerts D7; Sources D6}; the seven-question map is complete; no bare "D\d" in visible text. |
| N5 | Wallet sign-in (Namada Keychain, Keplr, pair code) and the pair deep link. | `npm test` (auth) unchanged; smoke at 375: sheet opens within 100dvh and scrolls; `/alerts?pair=CODE` opens it. |
| N6 | Alerts and settings: rules, thresholds, watchlist, quiet hours, Discord, devices, API keys, export, delete. Rule ids and logic in `shared/alerts.ts` unchanged; only title and condition strings change. | `npm run test:replay` identical except the timestamp; settings tests unchanged; Discord test message still sends. |
| N7 | Tape: live stream rows, per-row time and price source, CSV export. | On Activity push a mock WebSocket flow; assert the row appears with source text and the CSV link exists. |
| N8 | The seven cross-checks stay visible with plain titles mapped by `check.key`. | Sources sheet renders one row per key; worker strings untouched. |
| N9 | No third-party requests on load except `/api` and `/ws`. | Network assertion; fonts self-hosted. |
| N10 | Data layer untouched. | `npm test` and `npm run test:replay` byte-identical. |

**Defects to fix or design around before any test session** (measured 2026-10-17):
1. Request-time Osmosis quotes return HTTP 403, so the Trade ticket shows "no quote" and prints the raw URL (`TradeView.tsx:75` prints `quote?.error`). Task Q1 and the Home mini-ticket depend on it. Never print a URL; show the "quote service is not answering" state.
2. `overview.price.usd` reports status `live` while its note says "live fetch failed: HTTP 403". The chip must not say fresh when a fetch failed.
3. `overview.dex.pools` returns 0 while `liquidityUsd` is $1,749; use the `/api/pools` length.
4. A Cloudflare insights beacon loads from `static.cloudflareinsights.com` while the privacy table says "no analytics" (`SettingsView.tsx:216`). Turn it off or reword.
5. Two of seven checks warn today (`bonded_coverage`, `ibc_conservation`), so any "all checks pass" copy must be computed.
6. `private/trades.md` (not published) notes timed-out IBC packets count as outflow; do not feature "Bridged back" as a hero number until refunds are handled.

## 9. Open decisions for the three directions

The brief fixes rules, data, names and tests. The directions should genuinely differ here.

| # | Decision | A | B | C |
|---|---|---|---|---|
| 1 | Ground | Yellow-first like namada.net: large yellow bands, black type | Black-first, one yellow band on Home | Light paper (#f4f4f2), ink, yellow marker |
| 2 | Display type | Space Grotesk caps, brand-literal | Serif editorial display, grotesk UI | Mono-led terminal |
| 3 | Home hero object | Price at 80 px | Headline sentence | Live strip of real flows |
| 4 | Explainer | Scroll-led "path of a NAM" | Five questions as an accordion | Interactive: drag an order size, see the price move against depth |
| 5 | Navigation | Six-tab bottom bar | Top bar plus a sheet | Four tabs plus More |
| 6 | Provenance display | Always-visible chip (dot and age) | Tap-only, with panel footers | Ambient: underline style and colour, with footers |
| 7 | Radius and density | 0 / 2 px / pill | 4 / 12 px soft | 0 everywhere, hairlines |
| 8 | Names | As section 4 | Price check, Sellers, Private pool, Ledger | Movers, Shielded, Feed |
| 9 | H1 | "What moved, who moved it, and what it costs to trade NAM." | "NAM, in plain sight." | "NAM, with receipts." |
| 10 | Logo | Ring plus triangle pair | Wordmark only | Monogram from a tick or bracket |

Owner decisions, outside the directions: (a) whether the owner's three trades (kept outside the repository) may appear publicly as a worked example (default no, they expose the owner's address; Home uses market events from `docs/events.md`); (b) the repository URL for the footer; (c) whether Namada's symbol may appear in the footer with attribution; (d) self-hosting fonts and removing the analytics beacon, which the privacy line requires.
