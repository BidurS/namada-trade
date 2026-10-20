# Direction B, "Editorial instrument"

The Financial Times meets a terminal. Calm, literate, sourced. The page should make a sceptic think "someone with taste made this", and a non-crypto adult understand it in five seconds.

Files: `tokens.css` (every variable), `styles.css` (component CSS, inlined into each page by the build), `build.mjs` (reads `../../data/snapshot.json`, writes `home.html`, `trade.html`, `holders.html`), `shots/` (six final PNGs). Run `node build.mjs`.

## Concept

**A newspaper front page for one coin, set in a dark instrument room.** Three typefaces, three jobs:

- **Newsreader (serif)** says things: headlines, the lede, prose answers, and every number that is a moment (price, "You get", key figures). Light weight (300) at display size, 400 for H2.
- **Space Grotesk** operates things: nav, buttons, labels, glosses, list titles.
- **IBM Plex Mono** proves things: numbers in lists, addresses, ages, source lines, chart ticks. Slashed zeros and a slab "i" keep it bookish next to the serif.

The page is black. There is **one yellow band on Home**, the masthead: dateline, "NAM, in plain sight." at 160 px, and one sentence that carries the price inside it ("One NAM, the coin of the Namada network, costs **$0.001025**, [up pill] since this time yesterday."). Everything below is black and hairline-ruled, like a broadsheet at night. Yellow appears elsewhere only as the full stop of the wordmark, the one primary button per view, the focus ring, the active tab underline and the chart's last-value pill.

Provenance is a footnote system, not a badge system. Numbers carry a dotted underline (the footnote mark); tapping one opens a sheet with source, technical name, UTC time, age, status and note. Every panel ends with a quiet mono source line ("Source Namada node as of 11:24 UTC, 10 s"). Old numbers dim to ink-2 and say how old they are once, above the list, instead of ten times.

Signature small details: the 2 px proportional hairline under list rows (same motif in holders and the size ladder); the numbered section index; the "last one" empty state; a ticket with punched edges for the static quote; direct labels inside the supply bar and on the sliver that can be sold.

## Names and navigation

Home, Price check, Sellers, Private pool, Ledger, Alerts. Slim 52 px top bar on phones: wordmark, price with change (never wraps), menu button. The menu is a top sheet: six serif names, each with its plain question under it. From 1024 px the bar carries the six names inline (active = 2 px yellow underline) and the price. Same bar on every page. Wordmark only, with a yellow full stop. `Sellers`, `Private pool`, `Alerts` and the Ledger "Moves" tab are not built in this round; their links are `href="#"` with `data-unbuilt`.

## Type scale (px size / line height; second value from 1024 px)

| Token | Size / line | Face | Use |
|---|---|---|---|
| `--fs-11` | 11 / 16 | mono | chart ticks, in-bar labels only |
| `--fs-12` | 12 / 16 | mono | provenance, source lines, ages (the floor for anything with provenance) |
| `--fs-13` | 13 / 20 | grotesk, mono | controls, table cells, tags |
| `--fs-15` | 15 / 24 | grotesk | UI body, notes, glosses (24 so inline number buttons meet the tap-target exemption) |
| `--fs-17` | 17 / 26, 18 / 28 | serif | prose answers |
| `--fs-22` | 22 / 28, 24 / 32 | serif | lede, H3, accordion questions |
| `--fs-h2` | 30 / 34, 40 / 44 | serif 400 | H2 |
| `--fs-h1` | 36 / 40, 56 / 60 | serif 350 | H1 on Price check and Ledger |
| `--fs-fig` | 28 / 32, 40 / 44 from 640 | serif | key figures on the band |
| `--fs-ans` | 56 / 56, 72 / 72 | serif 300 | the number that leads an accordion answer |
| `--fs-num` | 72 / 72, 96 / 92 | serif 300 | "You get", the one number moment on Price check |
| `--fs-display` | clamp(56px, 16.2vw, 160px) / .94 | serif 300 | Home H1 only (61 px at 375) |

One large moment per screen: Home the H1, Price check the "You get" number, Ledger the H1. Newsreader numerals are already tabular (checked: "1111" and "0000" measure the same at 48 px, opsz 72), so serif figures need no feature switch. Lists use mono.

Colour, radius, spacing, elevation and motion tokens are in `tokens.css` with contrast ratios in the comments. Radius is soft 4 / 12 px: 4 for controls, tags, bars, inputs; 12 for sheets, the ticket, the proof block, notices; pill only for provenance chips and the status dot.

## What is animated (CSS only, all of it)

| What | How | Duration | Reduced motion |
|---|---|---|---|
| Supply bar fill, first paint | `clip-path` wipe per segment, `animation-delay: 400ms + i * 80ms` | 320 ms each | none (verified: `document.getAnimations().length === 0`) |
| Chart wipe, first paint | `clip-path` on the line group, left to right | 600 ms | none |
| Section reveal | `animation-timeline: view()`, opacity and 8 px rise, once, inside `@supports` | scroll-linked | none |
| Accordion open | chevron rotate, answer rises 8 px | 200 ms | none |
| Sheets (menu, source, filters) | `popover` with `@starting-style`, opacity and 16 px slide, scrim fades | 200 ms | duration tokens collapse to 0 |
| Hover, press | colour, background, 1 px press | 120 ms | 0 |

Nothing counts or rolls a number. There is no loop anywhere (no live dot in the mock, since nothing is streaming).

## What works without JavaScript

Everything, including the interactions, which are plain HTML and CSS: `popover` sheets for the menu, every source sheet and the filters; `<details name>` for the exclusive accordion; and `:has()` on visually hidden radios for the Price check side toggle, the six measured sizes, the 7 and 30 day chart ranges, and the Ledger filters (Chain, Who) with a CSS-counter badge. The one script (6 lines) opens a sheet from `#open-<id>` so a reviewer or a screenshot can deep-link to one. Keyboard focus rings follow the radios through their labels.

## The honest states shown

- **Empty:** Home "What changed" says "Nothing crossed an alert size", names the last event that did (computed from `pressure.unlocks` and `blindspot.unshields` against the rule sizes: 2,999,716 NAM staked, 16 days ago), offers a rewind link and states the flow index lag (32 min Osmosis, 3.2 h Namada) as a caveat.
- **No data:** the Home mini-ticket and the Price check ticket. `quote5000.quote` is null in the snapshot (HTTP error). The error string, which contains a URL, is never printed. The ticket shows "No live quote", an em dash, the reason, and the last quoted price with age; the size table is used as an explicitly labelled stand-in. Ledger with Chain = Osmosis shows a dashed no-data panel with the one figure we do hold (top ten own 50.5% there).
- **Old:** holders were verified 2.3 days ago, so their numbers dim, the half-filled dot appears, and one sentence says so. Provenance status words: Fresh, Old, No data, Sources disagree, each with its own shape.

## Where I deviated from the brief, and why

- **No right rail on Home desktop.** The brief's sticky "Right now" rail left four empty columns under it for 5,000 px in the static capture. I folded its numbers into the band's five-figure strip (holders, shielded, on Osmosis, held by the pools, days to unstake, each with its sheet) and made each section a two-column spread with a sticky heading. Same numbers, no dead space.
- **H2 at 30 / 40 px**, above the brief's "24 px or smaller outside the hero". The serif needs the size to hold the hierarchy.
- **Preset sizes wrap** rather than scroll with an edge fade: with CSS-only state, a selected chip could sit hidden past the fade. The first screenful still shows H1, toggle, amount, "You get" and price move (checked at 375 x 812).
- **Holder 7-day column omitted** when every value is zero; the sentence above the list says it once. It returns automatically when any value is not zero.
- **No Namada symbol in the footer** and no source-code link: owner decisions (b) and (c) are open.
- The tabs, "Moves" and the other three nav pages are placeholders.

## Data decisions and risks (all visible in `build.mjs`)

- `OLD_AFTER_MS` (24 h) is a design placeholder for rows that carry no status of their own (holder rows). Production should take the server status.
- Window lengths (7 and 30 days, the 1% and 3% clip sizes) are read from field names (`priceHistory7d`, `executedHistory30d`, `maxSafeClip1PctNam`), `pressure.windowDays`, and `docs/replay-report.md` (events, flagged, median lead, base rate, 48 h window, the 30 Aug example), not typed.
- **Buy side:** the snapshot has no quoted purchase total. "You pay" is derived (average price times size) and says so in its sheet. `maxSafeClip1PctNam` (318) and `3Pct` (954) match the buy impacts at 1,000 NAM (3.14%), not the sell side, so the clip tip is shown on the buy side only.
- The snapshot's own `buyEffectiveUsd` and `buyImpactPct` are not equal measures (average price versus final price move). The design shows both with their plain labels and never derives one from the other.
- `overview.dex.pools` is 28 here but the brief records 0 live; the page uses `pools.pools.length`.
- Chart events are the three biggest recorded moves in the window from `docs/events.json` (dashed verticals, 12-character labels).
- Plain source names and plain check titles are a lookup in `build.mjs` (`PLAIN_SOURCE`, `CHECKS`, keyed by `check.key`); the worker strings are untouched.

## What the production build must do differently

1. **Self-host fonts** (no Google Fonts request, N9): Newsreader variable (opsz 6-72, wght 300-600, roman and italic; subset to Latin, `font-display: swap`, metric-matched fallback such as Georgia with `size-adjust`), Space Grotesk variable 400-700, IBM Plex Mono 400 and 500. Budget: under 120 KB total. The italic is used only in the wordmark, so it can be dropped from the font set if the wordmark is drawn as an SVG.
2. **Measure charts in the browser** (ResizeObserver, CSS px), one SVG instead of the two pre-rendered widths here, ticks at 11 px at every width, with the press-and-drag readout above the plot and the cursor at `?at=`.
3. **Real quote entry.** Here the amount is a measured-size picker because the quote service is not answering. With a live quote the field is a real input; the size table stays as the degraded state.
4. **Real sheet anchoring and focus return.** Native `popover` gives light dismiss and Escape; production adds focus return to the invoker, scroll lock on the menu, and anchor positioning for desktop popovers.
5. **Server status for provenance**, `?at=` rewind with the yellow banner, the account menu, search, and the unbuilt pages. Light theme tokens are done but unreviewed beyond a sanity render.
6. Replace the CSS-only filters with data-driven ones once Osmosis holders and paging exist (the `:has()` filters only hide the ten loaded rows).
7. Add the glossary popovers (plain word over precise term) on tags and column heads; this round carries the technical name only inside the source sheet.

## Review pipeline note

Headless Chrome enforces a window width of about 500 px, so `shot.sh ... 375` lays the page out at 500 and crops. The 375 screenshots were rendered with `shot.sh` through a throwaway exact-375 px iframe wrapper (deleted afterwards), so the layout viewport really is 375. Checked by script at 360, 375, 412, 640, 768, 1024 and 1280: no horizontal overflow, no visible `<table>` below 640, no text under 11 px, reduced motion leaves zero running animations.

## What is still weak

- Home is long on a phone (about 6,900 px). The trust section's seven checks and the holders list carry most of it; a "show all checks" disclosure would cut about 600 px.
- The grey segments of the supply bar are separated by tone and direct labels only; two of the five have no label inside them.
- Chart y-labels sit inside the plot and can be crossed by a marker line; the halo helps but does not remove it.
- Four of six Home sections use the same head-left, content-right spread. It is consistent, but below the band there is little variation in rhythm.
- The light theme has not had a full contrast pass beyond the token comments.
