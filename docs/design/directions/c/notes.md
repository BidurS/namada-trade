# Direction C: Paper and receipts

Pitch: **Receipts, not hype.** Every figure is stamped with where it came from. Dense, honest, a little bureaucratic in a charming way; the opposite of a crypto landing page.

Open `home.html`, `trade.html`, `holders.html` in a browser (they need `tokens.css` beside them and, for the two fonts, a network connection). Rebuild with `node build.mjs` from this folder.

## Concept

A bookkeeper's desk. The site is the ledger, each fact is a line item, and every line item is stamped with its source and age. Five devices carry the idea, and everything else is restraint (paper, ink, hairlines, 0 radius):

1. **The accountant's underline is the freshness.** Every number is underlined the way a ledger underlines a total: solid = fresh, dotted amber = old (with its age beside it or in the panel stub), wavy red = sources disagree, dashed grey `—` = no data (with the reason beside it). The key is in the footer. Tap or focus any number and a black receipt strip prints its source, UTC time, age and note (CSS only, `attr(data-prov)`).
2. **Every panel ends in a stub.** One dashed line: tick or clock glyph, "Source", name, HH:MM, age, and the state word. It is the per-panel footer line the direction promises.
3. **The slip.** The only lifted object is a receipt slip with a torn, zigzag edge. It holds the Home hero object (the latest real moves, as numbered receipts that print in line by line) and the quote mini-ticket. Nothing else is a card, and nothing nests in anything.
4. **The marker.** Namada Yellow is a highlighter, used on one word of the H1, the primary button, the active tab, the selected ladder size, the chart's last-value pill and the price move. It is never a state colour.
5. **A monogram from brackets.** `[ \ ]`: two brackets and a diagonal, read as an N, with a marker swipe behind the diagonal. It is bare (no tile), so it is not the "letter in a rounded square" tell.

Memorable thing: the price printed at 96 px with a ruler-straight accountant's underline, a slightly crooked rubber-stamp saying "Osmosis quotes, 0 s old", and a receipt tape beside it that really is the latest moves.

## The ten contested decisions, as committed

| # | Decision | Direction C |
|---|---|---|
| 1 | Ground | Light paper `#f4f4f2`, ink `#111110`, yellow marker. Dark "carbon copy" is a secondary variant (`home.dark.html`, shown once). |
| 2 | Display type | JetBrains Mono for H1, H2, numbers, labels, provenance. IBM Plex Sans for sentences. |
| 3 | Home hero object | The tape of real flows, as numbered receipts. |
| 4 | Explainer | Drag an order size; the price move is read against the six real quotes. |
| 5 | Navigation | Four tabs plus More (phone bottom bar, desktop top bar). |
| 6 | Provenance | Ambient underline plus a stub per panel. No chips. |
| 7 | Radius, density | 0 everywhere, hairlines, 56 px phone rows, 40 to 44 px desktop rows. |
| 8 | Names | Home, Trade, Movers, Feed, Shielded, Alerts. |
| 9 | H1 | "NAM, with receipts." Inner pages keep question H1s ("What would I get if I sold NAM now?", "Who holds NAM?"). |
| 10 | Logo | Bracket monogram with a marker swipe. |

Tabs are Home, Trade, Movers, Feed. **More** holds Shielded, Alerts (the count dot would sit on More), Holders, Rewind, "Where every number comes from", Glossary, Settings. On desktop the same four tabs plus a More dropdown sit in the 64 px header; there is no second row. The Feed tab is lit on Holders because Holders is the Feed's second view ("Transactions | Holders").

## Type scale (px, line height)

| Token | Size / line | Family, weight, tracking | Use |
|---|---|---|---|
| `--t-11` | 11 / 16 | mono 500, caps +0.08em | eyebrow (once), chart ticks, tab labels, receipt numbers |
| `--t-12` | 12 / 16 | mono 400 | every provenance string, ages, stubs, table headers |
| `--t-13` | 13 / 20 | mono 500 | controls, cells, chips |
| `--t-15` | 15 / 22 | Plex Sans 400 | body, sub copy |
| `--t-18` | 18 / 26 | Plex Sans 500 | lead (desktop), row and chart titles, key stats |
| `--t-20` | 20 / 26 | mono 600, -0.02em | H2 on phones |
| `--t-24` | 24 / 30 | mono 600, -0.025em | H2 desktop, inner H1 on phones, price field |
| `--t-32` | 32 / 36 | mono 700, -0.035em | Home H1 on phones, inner H1 desktop |
| `--t-48` | 48 / 50 | mono 700, -0.04em | Home H1 desktop, the "You get" hero |
| `--t-display` | clamp(52px, 14.5vw, 96px) | mono 700, -0.05em | the Home price only |

One large moment per screen: Home is the price (96 px desktop, 54 px at 375), Trade is "You get" (48 px), Holders is the list itself (its biggest type is the H1, 24 px on phones and 32 px on desktop, deliberately: the screen is a table). Spacing 4, 8, 12, 16, 24, 32, 48, 64, 96; gutter 16 / 24 / 32; section gap 32 / 48 / 64.

Contrast ratios for every text pair are in `tokens.css` comments (light and dark), computed with the WCAG 2.1 formula. Lowest text pair in use: flow tag `--ibc` on paper 4.85:1; `--ink-3` is 5.25:1 and is never used on a number. Control borders are `--line-strong` at 3.92:1.

## What is animated, and how (CSS only)

Motion reports change; it never invents it. No number is ever animated through intermediate values and there is no loop anywhere (no marquee, no pulsing dot; the live dot belongs to the production stream and is not in a frozen frame).

| Motion | Where | Property, timing |
|---|---|---|
| Receipt print | Home tape rows | `clip-path` inset top to bottom plus 4 px translate, 320 ms `steps(5)` (a line printer, not a tween), 90 ms stagger |
| Supply bar fill | Home "Where is all the NAM?" | `scaleX` 0 to 1 per segment, 320 ms ease-out, 80 ms stagger |
| Holder rows | Holders, Home | opacity and 4 px translate 200 ms, 40 ms stagger; share bar `scaleX` 320 ms |
| Top-10 share bar | Holders summary | `scaleX` 320 ms |
| Sheet, scrim, tap receipt, More menu | More, number focus | translateY 16 px or 6 px with opacity, 320 / 200 ms; scrim fade 200 ms |
| Buttons, segments, chips | everywhere | background and colour 120 ms; caret rotate 200 ms |

`prefers-reduced-motion: reduce` sets every duration token to 0 and `animation: none` on everything, so the page lands in its final state. Tiny JS (`client.js`, about 150 lines, no libraries) only adds three behaviours: the order-size explainer, the quote ticket, the holder filters. The pages are complete without it.

## The explainer, and how it stays honest

`snapshot.curve` has six quoted sizes (1,000 to 100,000 NAM). The slider is logarithmic and snaps to a real quote when the handle is near one. At a dot the readout says "A real quote: the pools were asked about N NAM". Between two dots it draws a straight line between the two real quotes, shows an **Estimate** tag, and says which two quotes it used. Outside 1,000 to 100,000 NAM (Trade's amount field) it shows `—` and says it will not guess. The dots, the lines and the chart all come from the same six points.

## Data honesty, as the snapshot actually is

- `alerts.hits` is empty. Home shows a designed empty state with the real alert thresholds ("an alert would list here") instead of faking a feed, and the tape lists the latest moves of 1,000 NAM or more from `pressure` and `blindspot` (a filter definition shown in its own subtitle).
- `quote5000.quote` is null (HTTP 403). The mini-ticket prints `— no live quote`, the "quote service is not answering" notice with the last quoted price, and the matching ladder row, clearly labelled as the ladder. Trade explains the same in one notice. No URL is printed.
- Two checks warn (`ibc_conservation`, `bonded_coverage`). "5 of 7" is computed. The 1,614 NAM escrow drift puts a wavy underline on every figure derived from the Osmosis amount; holder 01's staked figure is wavy too because `bonded` and `bondedEstimated` differ by 100,000.
- Flows are `stale` per the snapshot's coverage, holders were checked 2.3 days ago: both show the dotted "old" style with their ages, which is the real state.
- `priceHistory7d` has two points. The chart says "Short history" and draws them as a dashed segment, not a trend.
- The static replay block parses `docs/replay-report.md` at build time and prints its generated date.

## N1 to N10 in this mock-up

N1: every figure has an ambient underline and a focusable receipt; no data shows `—` plus the reason in view. N2: `build.mjs` reads the snapshot; the few literals are in `CONFIG` and printed with their meaning (stale after 5 minutes per `docs/decisions.md` D6, tape threshold 1,000 NAM, size steps 50M and 20M, seven-day change). A heuristic audit of every numeric token in the three pages traced all of them to snapshot fields, derived values or the replay report. N4: no bare D-codes in visible text (a copy lint over the rendered text found none of the banned words; raw source names such as "Osmosis SQS" appear only inside the tap receipt and tag tooltips, the expert-term-on-tap layer). N9 is **not** met in the mock-up: the two fonts load from Google Fonts. N3 (rewind) is not in scope for these three screens beyond the link in "Why you can trust".

Verified at 360, 375, 390, 412, 640, 768, 1024 and 1280 px: `scrollWidth` equals the viewport on all three pages; no `<table>` element anywhere (lists are `role="table"` grids that become two-line rows below 640); every link, button and input is at least 44 by 44 px (inline links in running text are exempt); the only text under 12 px is the 11 px eyebrow, chart ticks, tab labels and receipt numbers, none of which carries provenance.

## Files

`tokens.css` (the system, linked by every page) · `components.css` and `client.js` (inlined by the build) · `build.mjs` · `home.html`, `trade.html`, `holders.html` · `home.dark.html` (dark variant of Home, `data-theme="dark"`) · `shots/`.

Screenshots: the six requested (`home|trade|holders-375|1280.png`) plus `home-375-dark.png`, `more-375.png` (the More sheet, `home.html#more`) and `holders-375-osmosis.png` (the no-data tab, `holders.html#osmosis`). Note on tooling: headless Chrome refuses windows narrower than 500 px, so `shot.sh` at width 375 lays the page out at 500 px and crops the right edge off (the "before" phone shots have this too). The 375 shots here were taken with `shot.sh` pointed at a wrapper page holding the page in a 375 px iframe, so the layout really is 375 px wide. Full-page captures show the fixed tab bar at the bottom edge.

## What the production build must do differently

1. **Self-host the fonts** and remove the Google Fonts `<link>` (N9, no third-party requests): JetBrains Mono (variable 400 to 700, latin woff2) and IBM Plex Sans (400, 500, 600, latin woff2), `font-display: swap`, with `size-adjust` metric-matched fallbacks for both, inside the 120 KB font budget. Every figure is mono; numbers inside running sentences use Plex Sans, so confirm its tabular figures (`tnum`) are in the subset.
2. **Port `.n` to the real `Num`/`SNum`/`Derived`** with a focusable button and the full popover (source, UTC time, age, height, status, note, "Rewind to this time"). The mock-up's CSS-only receipt strip has no rewind link and no block height.
3. **Make ages live.** Ages here are frozen against `capturedAt`. In production they derive from `at` on render and tick; the print animation runs only for rows that arrive from the stream, not on load; the live dot appears only while the stream is connected and the tab is visible.
4. **Replace the `display: contents` wrappers** in the holder rows with flat cells directly under each row, and move the `role="table"` markup to real list semantics where a table is not needed, so assistive tech gets a clean tree. Add a focus trap and Escape to the More sheet (it is `:target` here).
5. **Real navigation targets.** Movers, Shielded and Alerts are not built in this exercise; their links are dead anchors. Feed points at the Holders page because that is the Feed view shown. `Rewind to that time` points at `movers.html?at=…`, which should be the production `/supply?at=`.
6. **Chart interaction.** Add the press-and-drag fixed readout above the plot, event markers from `docs/events.json` (not in the snapshot), and the `?at=` cursor. The plot is already fluid (HTML labels and non-scaling strokes, no letterboxing), so no ResizeObserver is needed.
7. **Holders:** real pagination and server-side filters (chain, what, size); the Osmosis list when it exists; "Load the next 10" is disabled here because the snapshot holds page one only.
8. **Footer:** the Namada symbol (owner decision c) and the repository URL (b) are not placed; the links are placeholders.
9. **Dark theme** follows `prefers-color-scheme` in `tokens.css` and a persisted toggle in Settings; the marker becomes an underline bar on dark because dark text on yellow is unreadable.

## Questions for the data owner

- `maxSafeClip1PctNam` (318) and `maxSafeClip3PctNam` (954) do not say which side they apply to. They match the buy column (buying 1,000 NAM moves the price 3.14%), and the copy says so, but a field is needed.
- `holders[].change7d` has no unit in the snapshot (all zero). The mock-up shows "no change" and would print it in NAM.
- The replay report was regenerated while this was built (11:27, then 11:57 UTC); the page prints whatever date the file carries.

## Self-critique

See the structured summary. The short version: Movers, Shielded and Alerts are not designed; the price chart lacks scrub and event markers; the tape's first two rows wrap their detail text on phones; the holder rows are a dense but samey run of ten; the desktop right rail is empty below the first screenful in a static capture (it is sticky in a browser).
