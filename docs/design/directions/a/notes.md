# Direction A, "The Reading": notes

Namada-literal. The sibling that is visibly family: it could have been commissioned by the people who made namada.net, and it is plainly a data instrument.

Files in this folder: `tokens.css` (every variable), `site.css` (components, inlined into each page by the build), `build.mjs` (reads `../../data/snapshot.json`, writes `home.html`, `trade.html`, `holders.html`), the three pages, `shots/` (six PNGs), this file. Run `node build.mjs`; `OUT_DIR=/tmp/x THEME=light node build.mjs` writes a light-theme variant elsewhere.

## 1. Concept

A yellow field, a black ink, and a ruler. Every large surface carries **one reading**: a figure, a stamp (dot and age) and a tick scale.

- **Yellow bands state the question and the reading** (Home hero, the path of a NAM, the Trade ticket, the size ladder on phones, the footer). Black type only.
- **Black bands show the evidence** (what changed, supply, holders, chart, pools, the checks). In the light theme these become paper; the yellow does not change.
- **The ruler** is the one recurring device: tick marks resting on the hero's bottom edge, hanging from the footer's top edge, running down the right edge of the yellow ticket column on desktop Trade, and under the supply bar (0, 25, 50, 75, 100%). It is the instrument's measuring tape, and it is how a page says "this is measured" without a word.
- **The stamp** is the provenance chip: a pill with a status dot and an age ("Osmosis quote · now", "old · 3.2 h", "checked 2.3 days"). It is the same shape everywhere; on yellow it is a black pill, on black it is a tonal pill. Every figure or group of figures has one next to it. Tap it and a sheet gives source, UTC time, age, status, a derivation if there is one, the raw technical name and a "Rewind to this time" action.
- **The ring** is the brand geometry: the mark (a thick ring holding an up/down triangle pair, visibly not Namada's symbol), the four markers of the path, the empty-state icon (a dashed ring: nothing here yet).
- A small typographic move that does a lot: in the Home price, the leading zeros ("$0.00") are dimmed and the significant digits ("1025") are full ink, so the order of magnitude is read before the number is. The zeros are ink-2 at weight 400 (not ink-3: the brief says ink-3 never sits on numbers), which also gives them a thinner stroke.

What is borrowed from namada.net: Namada Yellow `#FFFF00`, black sections, Space Grotesk in caps for display, 0 / 2 px / pill radii, "shielded" as a noun, the mono for labels. What is ours: the dark instrument surface, tabular numbers with provenance, question headlines, plain word first, the ruler, the stamp, the split ground.

## 2. The ten contested decisions, as committed

| # | Decision | A |
|---|---|---|
| 1 | Ground | Yellow-first: large `#FFFF00` bands, black type, black sections |
| 2 | Display type | Space Grotesk caps (600, tracking -0.015em) for H1 and H2; sentence case everywhere else |
| 3 | Home hero object | The price at 80 px (64 px on a 375 phone) |
| 4 | Explainer | Scroll-led "path of a NAM", four steps, geometry-only reveals |
| 5 | Navigation | Six-tab bottom bar below 1024 px, six top tabs from 1024 px |
| 6 | Provenance | Always-visible chip, dot and age, one per figure group |
| 7 | Radius / density | 0 (bands, tables, sheets) / 2 px (tags, inputs) / pill (buttons, chips, segmented) |
| 8 | Names | Exactly brief section 4: Home, Trade, Supply, Shielded, Activity, Alerts |
| 9 | H1 | "What moved, who moved it, and what it costs to trade NAM." |
| 10 | Logo | Ring plus triangle pair; wordmark "NAMADA TRADE" with TRADE in yellow on black |

Holders is the Activity tab "Holders" (Transactions | Holders underline tabs, 2 px yellow underline on the active one); its H1 is "Who holds NAM?" and the Activity tab is the lit one in the nav.

## 3. Type scale

Space Grotesk (display and text, `tnum` on) and JetBrains Mono (provenance, addresses, column heads). Tabular figures are asserted, not assumed: at 48 px, "1", "0" and "8" all measure 29.77 px with `tabular-nums` (20.89 and 30.94 proportional), so hero numbers stay in Space Grotesk and nothing switches to mono.

| Token | px / line | Weight | Use |
|---|---|---|---|
| `--t-11` | 11 / 16 | 500, caps +0.08em | eyebrows (one per band opener), chart ticks on phones, tab-bar labels |
| `--t-12` | 12 / 16 | 400-500 mono | provenance, ages, column heads, the unit after a value |
| `--t-13` | 13 / 20 | 400-500 | captions, controls, chips, row detail |
| `--t-15` | 15 / 22 | 400 | body, list names |
| `--t-18` | 18 / 26 | 500 | lead sentence, row numbers |
| `--t-24` | 24 / 28 | 500-600 | H2 (caps), panel numbers |
| `--t-32` | 32 / 34 | 600 caps | H1 on phones |
| `--t-48` | 48 / 48 | 600 caps | H1 on desktop; the Trade "You get" number on every width |
| `--t-display` | clamp(48, 17vw, 80) / 1 | 500 | Home price only. From 1024 px: clamp(64, 6.4vw, 80) so it never outgrows its five columns |

One large moment per screen: Home the price, Trade "5.05 USDC", Holders the H1. Everything else is 24 px or smaller. Contrast between neighbours is real (11, 13, 15, 18, 24, 32, 48, 80), not a ramp of near sizes.

Two deliberate departures from the brief: display weight is 600, not 500, because caps at 500 read thin on yellow; and the phone price is 64 px, not 41, because with a caps H1 at 32 px a 41 px price would not be the hero.

## 4. Colour and contrast (see tokens.css for every pair)

Values are the brief's, with three changes found by computing every pair:

1. **Light `--warn`** is `#a84a07`, not `#b45309`: the brief's value is 4.25:1 on `--surface-2` (fails AA). Ours is 5.2 / 5.8 / 4.9 on bg / surface / surface-2.
2. **Flow-tag fill** is the hue at 6% (dark) and 5% (light). At 12% the tag text fell to 4.4:1 on `--surface` in dark and 4.1:1 on paper in light. Tags sit on `--bg` or `--surface` only; worst cases are 4.7:1 (`--pos` on `--surface`) and 4.5:1 (light `--ibc` on paper).
3. **Grounds** are first-class: `.ground-ink`, `.ground-accent` and `.g-accent-to-ink` (yellow on phones, black from 1024 px, used for the size ladder) re-map one set of `--c-*` tokens, so a component is written once. On yellow: ink 19.6:1, secondary `#3d3d00` 10.5:1, 12 px captions `#616100` 6.1:1; chips are black pills (text 19.3:1) so status dots keep their dark-theme colours on yellow.

Yellow marks: the mark, the hero, the path, the ticket, the footer, the primary button of a dark band, the focus ring, the active-tab underline, the Osmosis slice of the supply bar, the last-value pill. Selection is tonal (inverse fill on segmented controls, presets and the ladder row), never a yellow box. Flow colours appear only inside tags with a glyph and a word. Status colours only beside the words fresh, old, no data, disagree.

## 5. Layout, navigation, pages

- **Header** is black in both themes ("the bezel"). Phone, 52 px, one row: mark, price with 24 h change (never wraps), status pill ("5/7", "5 of 7" from 400 px), search, account. Desktop, 64 px: mark, wordmark, six tabs (2 px yellow underline), price pill, Rewind, status ("5 of 7 checks"), search, account. 1024 to 1199 px drops the wordmark, the Rewind label and "checks" so one row always fits.
- **Tab bar** (below 1024 px): six equal cells (at least 62 px at 375), 20 px icon plus 11 px label, 56 px plus the safe-area inset, 2 px yellow line on the active cell. No count dot: `alerts.hits` is empty in the snapshot.
- **Home**: yellow hero (eyebrow, H1, sub, price with delta and chip, 30-day sparkline from 640 px up, actions, fact strip), black narrative (what changed, where is all the NAM, who holds NAM; on desktop an 8-column narrative beside a sticky 3-column "Right now" rail), yellow path, black closing (mini-ticket beside why-trust), yellow footer.
- **Trade**: on phones a yellow ticket band, then black chart, yellow size ladder, black pools. From 1024 px a **split ground**: a sticky yellow ticket column (5/12) beside a black evidence column (7/12) holding chart, ladder and pools; the yellow column's edge is a vertical ruler.
- **Holders**: yellow hero with four counts, then black list. Phone: rows (rank, name, total, address and category tag, share, spendable and staked, 7-day change, checked chip, a hairline bar sized against the biggest holder), a Filter button that opens a bottom sheet. Desktop: the same markup becomes an eight-column grid from a 930 px container, and the filters sit inline.
- **No `<table>` element exists anywhere.** Lists are `role="table"` grids; rows collapse below the container width (600 px for ladder and pools, 620 px compact holders, 930 px full holders), which is container-query based, so the same list is a table in a wide column and rows in a narrow one.
- Audit script results (headless Chrome, 360 / 375 / 390 / 412 / 768 / 1024 / 1100 / 1280, all three pages): no horizontal overflow, no visible table, no text under 11 px, nothing carrying provenance under 12 px, every interactive element at least 44 x 44 (chips and the header status pill reach it through an extended hit area; inline links exempt). SVG tick text is 11 px or more at every width (11.0 at 360, 11.3 at 1024).

## 6. What is bound, what is derived, what is not shown

Every figure is a snapshot field or a `derive()` of fields; ages are `capturedAt` minus the field's own timestamp. A derived value takes the oldest `at` and the worst status of its inputs and says so in its chip ("derived", with the inputs in the sheet). Where the snapshot has no value, nothing is invented:

- `alerts.hits` is empty: Home shows the honest empty state ("Nothing crossed an alert size in 24 hours", the alert size in dollars as a derived value) plus the 24-hour movements with flow tags. The hit-row component (rule words, age, "n more") is specified in the brief but unbound here.
- `quote5000.quote` is null with an error: both the Home mini-ticket and Trade say "The Osmosis quote service is not answering", never print the URL, give the last quoted price with its age, and show the 5,000 NAM figures from the size ladder, labelled "from the size ladder, not a fresh quote". Trade accepts listed sizes only today and says why.
- `priceHistory7d` has two points: the dashed quoted line is short, and the legend says "recorded since 15 Oct". The 24 h range has two executed points, so it is drawn as dots and the title says how few trades there are.
- Not rendered because they are not in the snapshot: market-event markers (events.json), the dated replay-report proof block, the "331 million NAM left staking" rewind example, `netIbc24h` (the brief says do not feature bridged-back until refunds are handled), the Osmosis holder rows.
- Namada's symbol in the footer is an owner decision (c) and the file is not in the repo, so it is omitted rather than redrawn.

Data questions this exposed (worth a line to whoever owns the API):
- `curve.maxSafeClip1PctNam` (318) and `3Pct` (954) are not labelled by side. They match the **buy** impact exactly (318 x 3.143% per 1,000 = 1%), so the Trade notice shows them only in the buy view. The sell side reaches 1% at a much larger size.
- The buy rows of the curve probe a USDC amount equal to the NAM size at spot (`buyInUsdc` equals `usdSize`), so the NAM you receive is `buyInUsdc / buyEffectiveUsd` (4,789 NAM for the 5,000 row). We show it as a derived value ("about"), not as 5,000.
- Holder objects carry no `status`, so their chips show an age with a hollow dot ("checked 2.3 days") instead of fresh or old; N1 wants a status there. Rank 1 has `bonded` 14,662,107 and `bondedEstimated` 14,562,107: it is flagged "disagree" with both values in the sheet. That reading of the two fields is ours.
- Labels such as "Genesis: af backers" are printed as the data gives them (underscores removed); they need a plain-language owner pass.

## 7. Motion: what moves and how (CSS only)

Geometry reports change; no number is ever animated through intermediate values.

| What | How | Time |
|---|---|---|
| Supply bar fill | `grow` (scaleX from 0), staggered by `--i` x 80 ms; the figures beside it are final from the first frame | 320 ms each |
| Hero sparkline and chart line | `wipe` (clip-path inset, left to right) | 600 ms |
| Path of a NAM | scroll-driven: `animation-timeline: view()`. The rail draws (scaleY on phone, scaleX on desktop), each ring's centre dot scales in, each step rises from 30% to full opacity as it enters | tied to scroll |
| Section reveal | `rise` (opacity, 8 px), scroll-driven, once | tied to scroll |
| Sheets and popovers | `sheet-in` (16 px, opacity), native `popover` | 320 ms |
| Segmented controls, presets, ladder rows, buttons | background and colour transitions; the button arrow slides 3 px | 120-200 ms |
| Chart cursor | opacity | 120 ms |

Easings are `--ease-out` for entering and `--ease-std` for state change. Everything above is wrapped so `prefers-reduced-motion: reduce` removes it (`document.getAnimations().length === 0`) and the final state shows: all four steps and the full rail, the full bar, the full line. Browsers without `animation-timeline` (Firefox and Safari today) get the same static final state through `@supports`. One line of script adds `html.static` when the whole page fits in the window (tall desktop monitors, screenshots), which also shows the final state, because a rail that is half-drawn on a page with nothing to scroll would be wrong.

## 8. Interaction without a framework

- Side, size and chart range are radio inputs; `:has()` switches the panels (12 side x size results, 3 ranges). The default state is correct before any rule applies (the `hidden` attribute), so a browser without `:has()` still shows a right page.
- Provenance chips, the status sheet and the filter sheet use the native `popover` attribute: light dismiss, Escape, top layer, no script. On a phone they are bottom sheets (max height 100dvh minus 16 px, internal scroll); from 640 px they centre; the holders filter sheet becomes the inline toolbar from 1024 px.
- Holders filters (chain, what) are radios plus `:has()`. Choosing Osmosis shows a considered empty state: the list was not captured, but the count and top-10 share are in the snapshot.
- Three small scripts: a chart readout (pointer or touch reads the nearest executed point into a fixed line above the plot, `touch-action: pan-y`), the filter badge count and button label, and the `html.static` check.

## 9. What the production build must do differently

1. **Self-host fonts.** The mockup loads Space Grotesk and JetBrains Mono from Google Fonts for convenience; production ships latin woff2 subsets (Space Grotesk variable 400-700, JetBrains Mono 400 and 500), `font-display: swap`, a metric-matched fallback, and no third-party request (N9). Remove the two `preconnect` links and the stylesheet link.
2. Replace the radio-driven panels with real state and a real quote call; replace the read-only amount box with an input, quote any size when the service answers, keep the "listed sizes only" fallback when it does not.
3. Replace the static chart SVGs with the container-measured SVG (ResizeObserver, 1-2-5 ticks, event markers, the user's trades, a cursor at `?at=`), keeping this look: dots for sparse data, the dashed quoted line, the yellow last-value pill, the source line, the 11 px tick floor.
4. Wire the dead controls: search, account, Rewind (the desktop button; below 1024 px only the rewound banner is a control), the Transactions tab, Supply, Shielded and Alerts, "How we know".
5. The `derive()` helper and the chip are the contract: port `chip()` and `derive()` from `build.mjs` into `Num`, `Derived` and `ProvChip`. Holder rows need a status in the API. The dot must never say fresh when a fetch failed (brief defect 2).
6. Move `tokens.css` into an unlayered `:root`, keep the `--c-*` ground tokens, add the theme toggle (`data-theme`), and run the contrast script over every pair in both themes.
7. Popover focus handling: return focus to the chip on close, and put a heading level inside each sheet that fits the page outline.
8. Namada's symbol in the footer once the owner confirms (c) and supplies the file; the analytics beacon off; the repository URL (b).
9. Lighthouse and the axe pass on the real build; this mockup was checked with a script (overflow, targets, font floor), not Lighthouse.

## 10. Screenshots

`shots/` holds `home`, `trade`, `holders` at 375 (scale 2) and 1280 (scale 1), full page. `shot.sh` at 375 gives a 500 px layout (headless Chrome will not make a window narrower than 500 px) and a viewport 87 px shorter than the window, so the phone shots were taken through `shot.sh` with the page inside a 375 px iframe sized to the page, and the capture height is the window height plus 87 px, cropped back to the page height. The layouts are therefore true 375 and 1280 px.

## 11. Self-critique: what is still weak

- The Home path of a NAM is the least resolved piece on desktop: four columns and a lot of yellow below them. The idea (the rail draws as you scroll) works, but it carries four numbers and nothing visual that is specific to each step.
- Holders is the plainest page. The row is well organised, but seven of ten rows say "Anoma Foundation" with the same tag, which makes the page repetitive in a way only real data variety can fix.
- The size ladder's bars compare against the biggest listed move, which makes the first bar a stray tick on phones. Honest, but not pretty.
- Mid widths (768 and 1024 px) hold up but were not designed for as carefully as 375 and 1280: Holders shows rows rather than the table until a 930 px container.
- The mini-ticket on Home reads as a ledger, not a ticket. It is correct and small; it has no moment.
- Yellow is used heavily, as the direction demands. On a bright phone outdoors that is fine; on a dark one at night the hero is a lot of light. The light and dark themes only change the black bands.
