# NamadaTrade design system, final (v1.0, 2026-10-17)

Status: decided. Inputs: `brief.md`, `prompt.md`, `seo-requirements.md`, `data/snapshot.json`, the three directions in `directions/a|b|c`, five judge reports. This file and `tokens.css` are the contract for engineers; `build-plan.md` says who builds what in which order.

**Visual truth** (open these, do not guess):

| What | Where |
|---|---|
| Production tokens, resets, grounds | `docs/design/tokens.css` |
| Reference component CSS | `docs/design/final/site.css` |
| Reference pages, bound to the snapshot | `docs/design/final/home.html`, `trade.html`, `holders.html` (built by `final/build.mjs`) |
| Screenshots (phone 375 at 2x, desktop 1280 at 1x, light theme once) | `docs/design/final/shots/` |
| Base direction the synthesis started from | `docs/design/directions/a/` |
| Pieces taken from the other two | `directions/b/` (holders row, dated proof block, degraded ticket), `directions/c/` (latest moves, order-size curve, supply fills) |

Everything in the reference pages is a field of the snapshot, of `docs/replay-report.md` or `docs/events.json`, or a `derive()` of them. Nothing numeric is typed by hand (N2). The mock-ups load fonts from Google Fonts; production self-hosts (section 5).

---

## 0. The decision in one page

**Winner: Direction A, "The Reading", as the base, with a deliberate graft layer and four departures.**

Why A, weighed against what the owner asked for rather than by vote (two judges for A, two for B, one for C):

| Owner ask | Why A carries it | What was missing and is now grafted |
|---|---|---|
| Believed by Namada insiders | The only direction that is visibly a Namada sibling: yellow field, black ink, Space Grotesk, the same nouns. B and C would read as someone else's product to a follower. | Pushed away from "a namada.net skin": own mark (the dial), own device (the stamp and the scale), sentence-case H2, black footer, yellow rationed to one field per screen. |
| High-end agency look | Distinct structure on every page: a hero reading, then evidence. Real type scale (11/12/13/15/18/24/32/48/80). The yellow/black rhythm is not a template. | Chip wallpaper removed, holders dump removed, supply bar fixed, ruler used only where it measures. |
| Non-crypto friendly in five seconds | Clearest H1 of the three. | B's definition sentence ("NAM is the coin of the Namada network"), the price set as "One NAM costs", the dateline. |
| Mobile on every screen | The only direction that meets the phone rules without exemptions: six-tab bar, 44 px hit areas through `::after`, no `<table>`. | A11y fixes: `scroll-padding-bottom`, reduced-motion gating, 320 px header. |
| Holders and explainers on the front page | Holders section and "path of a NAM" exist. | B's two-line holder rows with one age sentence; C's drag-an-order-size curve inside the path; C's latest moves under the hero. |
| Plain menu names | Exactly the brief's: Home, Trade, Supply, Shielded, Activity, Alerts. | None. B's "Price check, Sellers, Private pool, Ledger" and C's "Movers, Feed, More" are rejected. |
| Buildability | CSS-only states, native `popover`, container-query lists, ground tokens. | Tokens re-cut in rem, layer order declared, Tailwind retired. |

**Four departures from A that the judges' evidence forced:**

1. **Provenance is rationed, not removed.** A put about 30 identical black pills on Home. Now: a `ProvChip` (pill) only on hero figures, a `ProvDot` (dot, source word, age) on secondary figures, and one `SourceLine` at the foot of every panel or list. A list that is old is dimmed once and explained in one sentence; no per-row pills. (Amends the N1 test, section 12.)
2. **The mark is a dial, not a ring with two triangles.** Rendered at 32 px the triangle pair reads as an "eject" or sort icon (sceptic judge, confirmed on screen). The dial (a ring open at the top right, a needle, a hub) says "a reading", is distinct from Namada's symbol, and survives at 16 px.
3. **Yellow is a field once per screen, black everywhere else it can be.** Home keeps two yellow fields (hero, the path of a NAM), the footer goes black. Trade keeps the sticky yellow ticket column. Inner pages get one compact yellow reading band. The old yellow footer, yellow ladder block on desktop and ruler strips that measured nothing are gone.
4. **H2 is sentence case.** Caps survive in H1 (one shout per screen) and eyebrows. This also satisfies the brief's own tone rule ("capitals only for eyebrow labels and currency codes", with H1 as the one display exception).

---

## 1. The visual idea: "The Reading"

A yellow field, black ink, and an instrument. Every large surface carries **one reading**: a figure, a stamp, and (when it measures something) a scale.

- **The field.** Yellow bands state the question and the reading; black bands show the evidence. In the light theme the black bands become paper; the yellow does not change.
- **The stamp** is the provenance control: a dot, a source word, an age. Same grammar everywhere (`Osmosis quote · now`, `Flow index · old 3.2 h`, `Namada indexer · 2.3 days`). The dot never appears without a word.
- **The scale** (ruler) appears once per screen as an edge decoration (hero bottom edge, Trade ticket seam) and wherever a scale is real: supply bar (0 to 100%), chart axes, the order-size curve. A tick that does not measure anything is cut.
- **The dial** is the mark: a ring, a needle, a hub. Wordmark `NAMADA TRADE` in Space Grotesk 700 caps, tracking 0.06em, `TRADE` in yellow.
- **Plain word first, expert term on tap.** Tags, column heads and glossary terms show the plain word; the expert term (bonded, MASP, IBC, SQS) is in the tap sheet.
- **Numbers are the loudest thing on every page.** Home the price (64 px phone, 80 px desktop, leading zeros dimmed so the magnitude reads first), Trade the "You get" (48 px), inner pages the figure in the band. Everything else is 24 px or less.

What is borrowed from namada.net: Namada Yellow `#FFFF00`, black sections, Space Grotesk, 0/2 px/pill radii, "shielded" as a noun. What is ours: the dial, the stamp, the scale, question headlines, tabular numbers with provenance, the split ground on Trade, sentence-case H2, the rationed yellow.

---

## 2. The ten contested decisions

| # | Decision | Final | Reason | Grafts taken |
|---|---|---|---|---|
| 1 | Ground | **Yellow-first, rationed.** Black default theme; one yellow field per screen (Home two). Paper is the light theme. | Namada-sibling read (insiders) and a point of view (sceptics call flat `#FFFF00` the thing a prompt never does). Judges flagged night glare and empty yellow: so yellow is capped, the footer is black, the desktop path section is filled by the curve. | C: dark default stays (it was already A's). |
| 2 | Display type | **Space Grotesk.** H1 caps 600, H2 sentence case 600, numbers 500 tabular, JetBrains Mono for provenance, addresses, column heads, ticks. | Brand face, cheapest to self-host (direction A estimated about 72 KB for both; gate G9 measures it), tabular figures verified in direction A. A serif (B) reads as a different product; mono-everything (C) reads as a terminal. | B: nothing typographic. |
| 3 | Home hero object | **The price**, set as "One NAM costs $0.001025" under the tagline. | Fastest recall of a number (judge 2 tested it). Leading zeros ink-2 so `$0.001025` does not read as `$1025`. | B: definition sentence under the H1; dateline in the eyebrow. C: latest moves directly below the hero (not inside it, so the first screen stays clean). |
| 4 | Explainer | **Scroll-led "path of a NAM"** (four steps, geometry-only reveal) **plus the drag-an-order-size curve** in an explore panel under step 4. | The path is the visible spine (B's accordion hides three of four answers). The curve is the one explainer that teaches thin markets with only real quotes. | C: `OrderSizeCurve`. B: the Home answer to "What does a sale cost?" moves from an accordion to this panel. |
| 5 | Navigation | **Six-tab bottom bar below 1024 px; six text tabs from 1024 px.** | The brief's rule; Trade is one tap away. | A's bar kept; B's hamburger and C's "More" rejected. |
| 6 | Provenance display | **Rationed visible stamps**: ProvChip on hero figures, ProvDot on secondary figures, SourceLine per panel, state words not just colour. | Chip wallpaper vs tap-only underlines: neither survived judging. Stamps stay visible (N1) without becoming wallpaper. | B: section source lines, dimming plus one sentence for old lists. C: state word in the line, wavy/dashed vocabulary for isolated disagree/no-data numbers. |
| 7 | Radius and density | **0 / 2 px / pill.** Sheets are square with a 2 px yellow top rule. `--r-2` (12 px) from the brief is dropped. | Instrument bands and lists have no radius; pills mark things you press. | None. |
| 8 | Names | **Home, Trade, Supply, Shielded, Activity, Alerts.** Holders is a tab inside Activity and a Home section. | Plain, tested, at most 9 characters. | None. |
| 9 | H1 | **"What moved, who moved it, and what it costs to trade NAM."** | Says the product. "In plain sight" collides with a privacy chain; "with receipts" is slang. | B's sentence goes in the sub copy. |
| 10 | Logo | **The dial** (see section 1). | Section 0, departure 2. | None. |

### Grafts: taken, adapted, rejected

| Graft proposed by a judge | Decision | Where it lands |
|---|---|---|
| B holders list (two-line rows, hairline bar, one age sentence) | **Taken** | Home "Who holds NAM", Activity > Holders. Category tag only when it adds information; rank 1 keeps its own flag. |
| B section-level source line instead of a chip per row | **Taken** | `SourceLine`, section 8. |
| B degraded quote ("live quote not answering" beside Amount, size-table paragraph, signed move) | **Taken** | Trade ticket and Home mini-ticket. The chip says `Size table · now`, never `Osmosis quote`. |
| B dated proof block and rewind example parsed from the replay report | **Taken, reworded** | Home trust section. The example says "the first alert before 331 million NAM were withdrawn" because the report's timestamp is the first alert, not the withdrawal. |
| B hero sentence and dateline | **Adapted** | Sub copy defines NAM; the price carries the label "One NAM costs"; eyebrow is the dateline. |
| B empty state with the last event and a rewind link | **Taken** | Home "What changed". |
| B chart event markers (docs/events.json) and the y labels outside the plot | **Taken** | `PriceChart`. The mock draws the three biggest moves in the window. |
| B motion gating (`prefers-reduced-motion: no-preference` plus `@supports`) | **Taken** | tokens.css and `final/site.css` motion block. A's `step-in` opacity .3 is gone. |
| B bottom-sheet structure with a Note row | **Taken** | `Sheet`. |
| B compact two-sided ladder row | **Taken** | Trade ladder on phones; desktop is a table with both sides at equal weight. |
| B "show all checks" disclosure | **Taken** | Home shows the checks that need a look; "The 5 that pass" is a disclosure. |
| C latest receipts tape | **Taken, renamed "Latest moves"** | Home "What changed", under the empty state. No zigzag edge. |
| C drag-an-order-size curve | **Taken** | `OrderSizeCurve` on Home (explore panel) and Trade ("How size moves the price"). |
| C supply fills and the escrow callout | **Taken** | `SupplyBar` and the notice under it. |
| C chart stat strip (Low, High, Last, Quoted now) and short-history note | **Taken** | Trade chart block. |
| C safe-size line | **Taken, reworded** | The API field is the worst side (`worst side stays under target`, `sqs.ts` `safeClip`), not buy-only: the line says "buying or selling". |
| C wavy and dashed underlines | **Adapted** | Only for an isolated number in a fresh context. A whole old list is dimmed, not underlined. |
| C "+2 linked on Osmosis" | **Taken** | Holder rows. |
| C paper/mono ground, zigzag edge, rotated stamp, highlighter, "Feed", "Movers", "More" menu | **Rejected** | Brand fit and kitsch (judges 1, 2, 5). |
| B serif display, hamburger, accordion, invented nav names | **Rejected** | Judges 2, 4, 5. |
| A caps H2, yellow footer, ladder bars, bare `5/7`, ring-and-triangle mark | **Changed** | Sentence-case H2; black footer; bars replaced by the curve; check icon plus `5/7`; the dial. |

### Judges' red flags and how each is resolved

| Red flag | Resolution |
|---|---|
| A: chip wallpaper (about 30 pills on Home, ten identical on Holders) | Rationing rule (section 8). Home now has 2 ProvChips (the price and the mini-ticket), 6 SourceLines and a ProvDot only where a single figure needs its own stamp; Holders has 0 chips and 2 stamps in total. |
| A and B: a green or fresh signal beside "quote service not answering" | The result chip is `Size table · now` and the ticket says so in words next to the number. `Osmosis quote` appears only on the price. |
| A: Osmosis figure fresh while the bridge check needs a look | The figure carries the disagree state (wavy underline, `sources disagree` in the source line) and a notice prints both numbers and the gap (1,614 NAM, 0.008%). The hero percentage is unaffected. |
| A: 56.3% segment drawn as an empty outline | Solid fills, labels inside the large segments (`--fill-staked`, `--fill-rest`). |
| A: ladder bar is a stray tick | Bars removed. The curve replaces them. |
| A: Holders 5 to 6 lines per row, name and tag saying the same thing | Two lines per row, tag only when informative, one age sentence. Phone page 2,367 px (A 2,958). |
| A: sort/swap-icon mark | The dial. |
| A and B: first content after the hero is an empty state | Latest moves list directly under the empty state: six real rows within the second screen. |
| A: price move unsigned, 1.49% vs 1.5% | Sign on every delta; price moves are 2 decimals everywhere (1.49% in the ticket, the notice, the ladder). |
| A: buy columns greyed to 3:1 | Both sides at equal weight; the picked side is a highlighted row, nothing is dimmed. |
| A: desktop Trade empty yellow | Ticket is compact (H1 32 px), the pools table moved to a full-width band under the split, so the slab ends with the split. The ticket sticks as you scroll; in a full-page capture the slab below it is the only emptiness left, by design. |
| A: heavy yellow at night | One field per screen; footer black; no yellow ladder block on desktop. |
| A: brand proximity to namada.net | Dial mark, sentence-case H2, black footer, stamp and scale; "Not affiliated" sentence in every footer. |
| A: header `5/7` meaningless | Check icon (amber when any check needs a look) plus `5/7`; `5 of 7` from 400 px, `5 of 7 checks` from 640 px; the sheet title is "Where every number comes from". |
| A: 320 px header overflow; no `scroll-padding-bottom`; `step-in` low-contrast opacity | Fixed (tokens.css base layer; header drops the 24 h change below 360 px; scroll reveals gated). |
| B: three font families, hamburger, tap-only provenance | Not taken. |
| C: 150 tab stops of 16 px targets, tap receipt covering the number | Not taken. |
| All: Google Fonts in the mock-ups (N9) | Production self-hosts (section 5). |
| All: Home 6,900 to 8,500 px on a phone | Final Home is 8,114 px at 375 (A 7,600, B 6,855, C 8,555): longer than A because it now carries holders, the curve and the dated proof. See "Known gaps". |

---

## 3. Navigation, routes, keys

**Names, in this order, everywhere:**

| # | Label | Route | H1 (a question) | Key |
|---|---|---|---|---|
| 1 | Home | `/` | What moved, who moved it, and what it costs to trade NAM. | 1 |
| 2 | Trade | `/trade` | What would I get if I sold NAM now? (verb follows the side toggle: "What would I pay to buy NAM now?") | 2 |
| 3 | Supply | `/supply` | Is a big sale coming? | 3 |
| 4 | Shielded | `/shielded` | How much NAM can't be seen? | 4 |
| 5 | Activity | `/activity` (Transactions), `/holders` (Holders tab) | Every move, with its source / Who holds NAM? | 5 |
| 6 | Alerts | `/alerts` | What should wake me up? | 6 |

Also: `/settings` (account menu), and the SEO pages from `seo-requirements.md` (`/staking`, `/osmosis`, `/learn/how-nam-trading-works`, `/faq`) which are footer and Home links, not tabs. `/pressure` and `/tape` redirect (`ROUTE_ALIASES`); `?at=` survives every redirect. Holders lights the Activity tab.

**Phone (below 1024 px).** Header: one 52 px row, black in both themes: mark (44 px target) · price with 24 h change (never wraps; the change hides below 360 px) · status pill (check icon, `5/7`) · search icon · account icon. Bottom tab bar: six equal cells, at least 62 px wide at 375, 56 px high plus `env(safe-area-inset-bottom)`, 20 px icon plus 11 px label, 2 px yellow rule on the active cell, icon stroke 1.9 when active. Alerts carries a count dot for hits since `lastSeen`. No hamburger, no More.

**Desktop (1024 px up).** Header 64 px, one row: mark and wordmark (wordmark hidden 1024 to 1199) · six text tabs (15 px 500; active = ink and a 2 px yellow underline, no box) · price pill · Rewind button (label hidden 1024 to 1199) · status pill `5 of 7 checks` · search · account. No second row. The tab bar is hidden.

**Secondary controls.** Search (palette), Rewind, status (opens Sources), account menu (Settings, sign out, theme). On phones Rewind is reachable from the palette, from every "Rewind to this time" action, and from the rewound banner (the only replay control below 1024 px).

**Keyboard.** `1` to `6` switch view, `/` opens search, Ctrl or Cmd plus K toggles it, Esc closes the top overlay. Digit keys and `/` must ignore events with Meta, Ctrl or Alt held (browser Cmd-1 to 5 must pass through). "Ctrl K" hint only when `(pointer: fine)`.

**Links are links.** Every primary destination is `<a href>` with an `onClick` that calls `preventDefault` and navigates client-side (`seo-requirements.md` 2). Ctrl/Cmd-click and middle-click work. Unknown paths render the not-found view and use `replaceState`.

---

## 4. Colour

Source of truth: `tokens.css`. Neutral and hue-less; yellow is a brand colour, never a state colour.

### 4.1 Tokens and measured contrast

Ratios are WCAG 2.1 relative luminance, recomputed by script (not taken from the direction authors). Column order: on `--bg`, on `--surface`, on `--surface-2`.

**Dark (default)**

| Token | Value | Ink / role | On bg, surface, surface-2 |
|---|---|---|---|
| `--bg` | `#000000` | black band | n/a |
| `--surface` | `#0d0d0d` | sheets, popovers, inset panels | n/a |
| `--surface-2` | `#171717` | chips, inset fields | n/a |
| `--line` | `#242424` | hairline between rows, decorative only | 1.35 on bg |
| `--line-strong` | `#666666` | control borders, chip boundary | 3.66, 3.38, 3.12 |
| `--ink` | `#f5f5f5` | text | 19.26, 17.83, 16.44 |
| `--ink-2` | `#a8a8a8` | secondary text, **dimmed (old) numbers** | 8.83, 8.17, 7.54 |
| `--ink-3` | `#858585` | 12 px and up, **never on a number** | 5.69, 5.27, 4.86 |
| `--accent` | `#ffff00` | field, mark, focus, active underline | 19.56 on bg |
| `--accent-ink` | `#000000` | text on yellow | 19.56 on accent |
| `--focus` | `#ffff00` | 2 px ring, 2 px offset | 19.56 |
| `--shielded` | `#00ffff` | shielded module only, with words | 16.75, 15.50, 14.30 |
| `--buy` | `#3987e5` | flow tag text | 5.77, 5.34, 4.93 |
| `--sell` | `#d95926` | flow tag text | 5.41, 5.00, 4.62 |
| `--ibc` | `#199e70` | flow tag text | 6.17, 5.71, 5.26 |
| `--shield` | `#9085e9` | flow tag text | 6.72, 6.22, 5.73 |
| `--pos` | `#d55181` | flow tag text | 5.32, 4.93, 4.54 |
| `--good` | `#2fbf2f` | fresh | 8.61, 7.97, 7.35 |
| `--warn` | `#ff9d00` | old | 10.07, 9.32, 8.60 |
| `--bad` | `#ff5c5c` | disagree | 6.94, 6.42, 5.92 |
| `--fill-staked` | `#a8a8a8` | supply bar; black label on it 8.83 | n/a |
| `--fill-rest` | `#3a3a3a` | supply bar; ink label on it 10.43 | n/a |

Flow tag text on its own 6% tint (tags sit on `--bg` or `--surface` only): buy 5.52/5.08, sell 5.20/4.77, ibc 5.90/5.40, shield 6.38/5.86, pos 5.11/4.70.

**Light** (`<html data-theme="light">`)

| Token | Value | On bg, surface, surface-2 |
|---|---|---|
| `--bg` / `--surface` / `--surface-2` | `#f4f4f2` / `#ffffff` / `#ececea` | n/a |
| `--line` / `--line-strong` | `#dcdcd8` / `#767676` | line-strong 4.12, 4.54, 3.84 |
| `--ink` | `#000000` | 19.07, 21.00, 17.75 |
| `--ink-2` | `#4d4d4d` | 7.68, 8.45, 7.15 |
| `--ink-3` | `#6b6b6b` | 4.84, 5.33, 4.51 |
| `--accent-text` (yellow's text twin on paper) | `#5c5100` | 7.24, 7.98, 6.74 |
| `--focus` | `#000000` | 19.07 on bg |
| `--shielded` (text) | `#006b6b` | 5.75, 6.33, 5.35 |
| `--buy` `--sell` `--ibc` `--shield` `--pos` | `#1f5fb0` `#b8431a` `#0f7a55` `#6250d6` `#b02f63` | tag on tint over bg: 5.37, 4.61, 4.54, 4.91, 5.16 (over surface 5.88, 5.08, 4.98, 5.38, 5.68) |
| `--good` `--warn` `--bad` | `#0a7a0a` `#a84a07` `#b42323` | good 5.02/5.52/4.67, warn 5.23/5.76/4.87, bad 5.95/6.55/5.54 |
| `--btn-primary-*` | black fill, yellow text | 19.56 (yellow on paper would be 1.03, so the primary is black) |

Changes from the brief's table: light `--warn` darkened from `#b45309` (4.25 on surface-2) to `#a84a07`; tag tint 6% dark, 5% light (at 12% the tags fell to 4.4 and 4.1); chip boundary uses `--line-strong` on black (the old `--line` boundary was 1.35:1 against `--bg`, failing WCAG 1.4.11).

**Yellow ground** (`.ground-accent`): ink 19.56, `--accent-ink-2` `#3d3d00` 10.48, `--accent-ink-3` `#616100` 6.08. Chips on yellow are **black pills** (text 19.26; status dots keep their dark-theme hues: good 8.61, warn 10.07, bad 6.94 on black). Notice wash on yellow (black at 6%, `#f0f000`): ink 17.17, ink-2 9.20, ink-3 5.34.

**Chart marks.** Executed line is `--c-ink` (19.26 on black, 19.56 on yellow, 19.07 on paper). Quoted line dashed `--c-ink-3` (5.69 on black, 6.08 on yellow, 4.84 on paper). Last-value pill is `--c-mark` with `--c-mark-ink`.

### 4.2 Grounds

A band picks a ground; every component reads `--c-*` only. Classes in `tokens.css`: `.ground-ink` (default), `.ground-accent`, `.g-accent-to-ink` (yellow on phones, black from 1024 px), `.ground-chrome` (header and tab bar, black in both themes). Tokens per ground: `--c-bg --c-ink --c-ink-2 --c-ink-3 --c-line --c-line-strong --c-focus --c-primary-bg --c-primary-ink --c-chip-bg --c-chip-ink --c-chip-line --c-sel-bg --c-sel-ink --c-mark --c-mark-ink --c-hover --c-good --c-warn --c-bad`.

### 4.3 Rules

- Yellow marks only: the dial and wordmark, the hero field of a screen (Home also the path), the Trade ticket column, one primary button per view (yellow on black bands, black on yellow bands), the focus ring, the active underline (tab, nav), the Osmosis slice and last-value pill on black, the rewound banner, the "you" tag.
- Selection is tonal: inverse fill (`--c-sel-bg`/`--c-sel-ink`) for segmented controls, presets, the picked ladder row. Never a yellow box.
- Flow hues appear only inside a Tag, always with a glyph and a word.
- Status hues only beside the words fresh, old, no data, sources disagree.
- `--ink-3` is for 12 px and up and never on a number.
- Light theme: the primary button is black with yellow text, `--c-mark` becomes black with yellow ink, the shielded slice stays `#00ffff` as a fill with `#006b6b` as text.

### 4.4 Measured on the reference pages

`final/*.html`, headless Chrome 155.0.8059.82 on macOS, scroll reveals disabled so nothing is mid-animation. Every text node compared with its effective background: Home 317 nodes at 375 and 324 at 1280, Trade 281 and 251, Holders 118 and 127, light theme Home 317, Trade 281, Holders 118. **Zero AA failures** except the disabled "Load more holders" button (exempt). Re-run this check in CI on the real build (build-plan, gate G4).

---

## 5. Type

### 5.1 Families

| Role | Family | Files (self-hosted, latin, `font-display: swap`) |
|---|---|---|
| Display and text | **Space Grotesk**, variable 400 to 700, `tnum` on | `@fontsource-variable/space-grotesk` (family name `Space Grotesk Variable`), one woff2 |
| Provenance, addresses, column heads, ticks, units | **JetBrains Mono** 400, 500 | `@fontsource/jetbrains-mono`, two woff2 (400, 500) |

Budget: at most 120 KB for all three files; direction A estimated about 72 KB (an estimate, not a measurement of the fontsource files). The build fails above 120 KB (gate G9). Preload the one text file used above the fold. No third-party font request (N9). Metric-matched fallback: system-ui stack with `size-adjust` so the swap does not shift layout. Remove the Google Fonts `<link>` tags and both `preconnect` tags from `web/index.html`.

Tabular figures are asserted, not assumed: at 48 px `1`, `0` and `8` share a width with `font-variant-numeric: tabular-nums` (direction A measured 29.77 px for each). The self-hosted subset must repeat that assertion (a Playwright test); if the subset drops `tnum`, hero numerals switch to JetBrains Mono.

### 5.2 Scale (rem; 1rem = 16 px; defined in `tokens.css`)

| Token | px / line | Weight, tracking | Use |
|---|---|---|---|
| `--t-11` | 11 / 16 | 500, caps +0.08em | eyebrows, tab-bar labels, chart ticks. Nothing else. |
| `--t-12` | 12 / 16 | 400 to 500 mono | provenance, ages, column heads, units after a value. Floor for anything with provenance. |
| `--t-13` | 13 / 20 | 400 to 500 | captions, controls, chips, row detail |
| `--t-15` | 15 / 22 | 400 | body, list names, sub copy |
| `--t-18` | 18 / 26 | 500 | lead sentence, row numbers, list titles |
| `--t-24` | 24 / 28 | 600 (H2), 500 tnum (numbers), -0.01em / -0.02em | H2, panel and step numbers |
| `--t-32` | 32 / 34 | 600 caps, -0.015em | H1 on phones; Trade ticket H1 on desktop |
| `--t-48` | 48 / 48 | 600 caps | H1 from 1024 px; the Trade "You get" number on every width (500, -0.02em) |
| `--t-display` | clamp(3rem, 17vw, 5rem), line 1 | 500, -0.02em | Home price only: 64 px at 375, 80 px from 471 px. From 1024 px `clamp(4rem, 6.4vw, 5rem)` so it never outgrows its five columns. |

One large moment per screen: Home the price, Trade "You get", inner pages the H1 and the band figure. Real contrast between neighbours (11, 13, 15, 18, 24, 32, 48, 80), not a ramp of near sizes. Floors: 11 px anywhere, 12 px for anything carrying provenance (checked in the mock at 320 to 1280).

### 5.3 Numbers

- Unit in `--t-12` after the value, mono, `--c-ink-2` (`24.50 USDC`, `10,000 NAM`).
- Sign on every delta, with the true minus `U+2212`: `+0.87%`, `−1.49%`.
- Price keeps six decimals (`$0.001025`), never prints `$0`. Dollars: under $1 six decimals, $1 to $999.99 two decimals, $1,000 and over none (`$1,819`).
- Price move and share of supply: two decimals everywhere (`1.49%`, `4.80%`). Hero shares: one decimal (`4.4%`).
- NAM: integers from 1,000 up (`17,124 NAM`), two decimals under 10.
- Home price: the leading `$0.00` is `--c-ink-2` weight 400, the significant digits ink weight 500.
- Ages: `now` under 5 s, `9 s`, `32 min`, `3.2 h`, `2.3 days` (one decimal, human). UTC is stated once per screen in the dateline, then only in sheets.
- Never animate a number through intermediate values.

### 5.4 Case and copy

Sentence case everywhere. Caps only in the H1 (display), eyebrows, currency codes and the wordmark. Banned strings in rendered text and TSX literals (copy lint): SQS, IBC, DEX, PoS, MASP, ABCI, RPC, cron, webhook, npm, bare D1 to D7, "Loading…" (outside the glossary, Sources "How it is computed", For developers).

---

## 6. Space, shape, elevation

- **Spacing** `--s-1` to `--s-9`: 4, 8, 12, 16, 24, 32, 48, 64, 96 (rem). Phone: gutter 16, panel 16, section gap 32 (inside a band 48 above and below). Desktop: gutter 32, panel 24, section gap 64 (Home 96).
- **Layout.** Content max width 1200 (`--max`), Activity 1360 (`--max-wide`). Breakpoints 360 (minimum, tested down to 320), 640, 768, 1024, 1280. 12-column grid from 1024.
- **Rows.** Phone list row 56 to 72 px (holders 64, ladder 72, pools 68, latest moves 64, legend 60). Table row 40 px, 28 compact.
- **Radius.** `--r-0` 0 (bands, lists, tables, sheets), `--r-1` 2 px (tags, inputs, insets, proof block), `--r-pill` (buttons, chips, segmented controls, delta pill). The seven radii and the card-in-inset-in-border nesting of the old UI are gone.
- **Elevation.** Dark: tone plus 1 px hairline; overlays use `--scrim` and `--shadow-overlay` (`0 24px 48px -12px rgb(0 0 0 / .6)`). Light: shadows at .06/.08/.18. No bordered cards: sections separate by whitespace and a hairline top rule.
- **Z.** header 30, rewound banner 35, tab bar 40; sheets and popovers use the top layer (native `popover`).

---

## 7. Motion and charts

### 7.1 Motion

Durations 120 / 200 / 320 ms; chart wipe 600 ms. Easing `--ease-enter` (enter) and `--ease-state` (state change; exits run at 0.75x). Motion reports change; it never invents it. Everything below is CSS only.

| Motion | Trigger | Property | Time |
|---|---|---|---|
| Supply bar fill | first paint of the section | `scaleX` 0 to 1 per segment, 80 ms stagger; the figures beside it are final from the first frame | 320 each |
| Price and sparkline wipe | first paint | `clip-path` left to right | 600 |
| Curve wipe (selling line) | first paint | `clip-path` | 600 |
| Section reveal | section enters, once | opacity, 8 px rise, scroll-driven | scroll-tied |
| Path of a NAM | scroll position | rail draws (`scaleY` phone, `scaleX` desktop), ring dot scales in, step rises 8 px | scroll-tied |
| Sheets, popovers | open and close | `translateY` 16 px, opacity; scrim fades | 320 |
| Buttons, segmented, presets, rows | hover, press | background, colour; the button arrow slides 3 px; press moves 1 px | 120 to 200 |
| Skeleton | loading | shimmer on row-shaped blocks, 1.2 s loop (the only loop; the live dot is the other, only while the stream is connected and the tab visible) | 1200 |
| New live row | row arrives from the stream (never on load) | opacity, 4 px rise | 200 |
| Tick flash | price or net-flow value changes | background `--buy-bg`/`--sell-bg` to transparent | 320 |

**Gating.** Scroll-driven rules live inside `@media (prefers-reduced-motion: no-preference)` and `@supports (animation-timeline: view())`. The default state is visible and complete (all four steps, full rail, full bar, full line). A one-line script adds `html.static` when the page fits the window (tall monitors, screenshots) so a half-drawn rail never shows. Under `prefers-reduced-motion: reduce` nothing animates or transitions and sheets appear instantly (a deliberate simplification of the brief's "opacity 120": `document.getAnimations().length === 0` is then trivially true). The reduced rule is in `tokens.css` base.

**Never:** counting or rolling a number, animating layout, parallax, any loop except the skeleton and the live dot.

### 7.2 Chart rules (`PriceChart`, `OrderSizeCurve`, hero sparkline)

- Container-measured SVG (ResizeObserver, CSS px): no scaled viewBox, so ticks are exactly 11 px at every width. (The mock uses two fixed viewBoxes; at 320 its ticks scale to 9.7 px. Production must not.) Keep the custom SVG; delete the unused `lightweight-charts` dependency.
- 1-2-5 ticks, 4 to 5 on y. Y labels sit **outside** the plot (left gutter), never struck by a marker line.
- Title states the takeaway ("Executed price up 72% since 18 Sep"); subtitle states the unit and the count ("USDC per NAM, hourly median of executed swaps, 44 points").
- Executed price solid `--c-ink`, quoted price dashed `--c-ink-3`, never buy/sell colours. Shielded series `--shielded`. Last-value pill in `--c-mark`.
- Event markers: dashed verticals from `docs/events.json` (the three biggest price moves inside the window), labels of 12 characters or fewer (`+35.7%`), placed above the plot. Production reads them from an endpoint or build export, not the repo doc at runtime (build-plan). The user's own trades when signed in; a cursor at `?at=`.
- Touch: press and drag reads the nearest executed point into a fixed readout above the plot (`touch-action: pan-y`), never a tooltip over the data.
- Sparse data is said in words: "only 44 of the last 720 hours had a trade", "the quoted line has 3 points so far". Two points draw as dots, not a trend.
- A source line under every chart, naming each series with its own age (executed swaps: old 1.4 h; quoted price: now).
- Visually hidden text fallback: first, lowest, highest, last. The Low, High, Last trade price and Quoted now strip is visible text under the chart.
- **OrderSizeCurve:** log x axis over the six real quote sizes (1k to 100k NAM), linear y 0 to a nice maximum above the largest move (both sides plotted as magnitudes; the readout carries the sign). Selling solid, buying dashed, a dot per real quote (selling filled, buying hollow). The slider snaps to a real quote within about 12 of 1,000 slider units. Between two dots the readout interpolates **linearly between the two real quotes**, shows an `Estimate` tag and says which two quotes it used; outside 1,000 to 100,000 NAM it shows `—` and says it will not guess. Readout: Worth, You get, Price moves. The component never draws a number that the six quotes and a straight line do not produce.

---

## 8. Components

States for every component: default, hover, focus-visible, pressed, selected, disabled, loading. Data components add fresh, old, no data, disagree, rewound. Focus ring: 2 px `--c-focus`, offset 2 px, on every interactive element, never removed. Reference CSS for each is in `final/site.css` (selector in brackets).

### Num, SNum, Derived

`<span data-num data-status>`. Behaviour as `Num.tsx` today, plus:

| Status | Look | Notes |
|---|---|---|
| fresh | `--c-ink` | |
| old, isolated | `--c-ink-2`, 1 px dotted underline, offset 4 px, age suffix where there is room | `[data-num][data-status="old"]` |
| old, whole list | `--c-ink-2`, no underline | parent has `.is-old`; the list says it once in a sentence |
| no data | `—`, 1 px dashed underline, **the reason inline** (not cut at 40 characters, not hover-only) | `[data-status="none"]` |
| disagree | 1 px wavy underline `--c-bad` (black on yellow) | e.g. the 19,986,988 NAM on Osmosis |
| rewound | same styles; ages are measured from the rewound time | |

`derive(inputs, label)` returns a value whose `at` is the oldest input's, whose status is the worst input's, and whose sheet names every input ("derived: price x alert size"). Sentences that quote a number inside copy use `Num`.

### ProvChip (`.chip`) and ProvDot (`.pdot`)

Both are buttons that open the provenance `Sheet`. **Rule: ProvChip only on hero figures** (Home price, Trade "You get", mini-ticket "You get about", the band figure on Supply and Shielded). **ProvDot** on every other single figure that needs its own stamp (path steps, desktop rail, an exception row). Never more than three chips on a screenful.

| | ProvChip | ProvDot |
|---|---|---|
| Look | pill, 24 px high, 1 px `--c-chip-line` border, `--c-chip-bg`, mono 12 px 500 | no pill: dot, source word, age, mono 12 px 500 `--c-ink-2`; 1 px dotted underline under the text |
| Text | `{dot} {source} · {age}`; old: `{source} · old {age}`; none: `{source} · no data`; disagree: `{source} · disagree {age}` | same |
| Hit area | 44 px via `::after { inset: -11px -5px }` (1 px border: padding box 22 + 22 = 44) | 44 px via `::after { inset: -10px -6px }` |
| Rule | The dot always sits beside a word. A bare `10 s` is banned (stranger judge could not read it). | |

### SourceLine (`.srcb`) and the scope sheet

The panel footer. One button for every figure in the panel: `● Source · {source | N sources} · {age or range} · {state word}`; only the word "Source" is underlined. Opens a scope sheet listing each figure (label, source, UTC time, age, status). Rules: a panel whose figures are not fresh also says so **in words above the data** (one sentence: "Balances were last checked 2.3 days ago, so they are shown dimmed."). A row that differs from its scope (holder rank 1, the Osmosis supply figure) carries its own ProvDot or disagree underline.

### Sheet (provenance, sources, filters, address, sign-in)

Native `popover` (React: `<dialog>` or the same top-layer pattern) with light dismiss, Escape, focus return to the invoker, a heading inside it that fits the page outline. Phone: bottom sheet, 0 radius, 2 px yellow top rule, `max-height: calc(100dvh - 16px)`, internal scroll, safe-area padding at the foot. From 640 px: centred dialog, 460 px wide (560 for `--lg`); the brief's "side panel on desktop" is replaced by this centred dialog, except the Address sheet, which is a full-height right panel (420 px) from 1024 px (`--side`). Provenance sheet rows: Status, As of (UTC), Age, Source (plain), Derived, Note, Technical name (mono), and a secondary button **Rewind to this time**. Header has an icon button with `aria-label="Close"`, never "esc".

### Tag

Sentence case, 12 px 500, 24 px high, 2 px radius, SVG glyph (12 px) plus a word. Flow tags: hue text on a 6% (dark) or 5% (light) tint of the ground; kinds: Buy, Sell, Shielded in, Shielded out, Staked, Unstaking, Unlocked, Bridged in, Bridged out, Added to pool, Removed from pool, Bot trade, Public funding. Category tags (`Genesis`, `Foundation`, `Backer`, `Snapshot`, `Static, dated …`, `Estimate`): outlined `--c-line-strong`. **A category tag shows only when it adds information** (not "Foundation" next to "Anoma Foundation"). A tag with an expert term is a button that opens the glossary popover.

### Button, link, Segmented, Tab, selectable Chip

| Component | Spec |
|---|---|
| Button primary | pill, min-height 48, 15 px 500, 2 px border; fill `--c-primary-bg` text `--c-primary-ink`. **One per view.** Arrow icon slides 3 px on hover. |
| Button secondary | transparent, 2 px `--c-line-strong`; hover inverts. |
| Button destructive | outline `--sell`. Delete and sign-out-everywhere only. |
| Link | underline 2 px, offset 5 px, min-height 44, optional trailing icon. |
| Segmented | grid pill, 3 px padding, 1.5 px `--c-line-strong` border; option min-height 44 (range variant 32 plus 6 px padding each side = 44 hit); selected = inverse fill; `radiogroup`. |
| Tab (page tabs, `Transactions | Holders`) | 52 px high, 2 px `--accent` underline on the active tab (the only yellow underline besides desktop nav). |
| Chip (selectable, filters, presets) | pill, min-height 44, 1.5 px border, selected = inverse fill; count suffix mono 12. Presets are a horizontal scroll row with an edge fade on phones and wrap from 640 px. |

### Field, Switch (new)

**Field**: label row (13 px 500) with an optional right-aligned state; box 60 px high, 2 px `--c-ink` border, 2 px radius, value 24 px 500, unit mono 12 on the right; hint 13 px below (e.g. "Worth about $5.13"); numeric fields use `inputmode="decimal"`; errors are a Notice under the field, not red text alone. **Switch** (alert rules): row min-height 56, label plus plain condition sentence, 52 x 32 pill track, 24 px thumb, `role="switch"`, selected = inverse fill.

### DataList

`role="table"` grid, **no `<table>` element anywhere** and no `display: contents` wrappers: cells are direct children of the row so the accessibility tree is clean. Rows below a container width, table above (container queries): holders compact 620 px, holders full 930 px, ladder 600 px, pools 600 px. Phone row: line 1 label or address plus one right-aligned number, line 2 tag, counterparty, age. Row hairline `--c-line`; a 2 px share bar along the bottom edge where a share applies (`--w`). Header row `--t-12` 500, sentence case, sticky under the header at desktop. Skeleton rows match the final column widths.

### SupplyBar

Five segments in this order: Staked (`--fill-staked`, label inside), Public funding (diagonal hatch of `--c-ink-2`), Shielded (`--shielded-fill`), Everything else spendable (`--fill-rest`, label inside), On Osmosis (`--c-mark`, a flag above with a tick: "1.7% on Osmosis"). 44 px high (56 from 640). 2 px gaps, minimum width 4 px per segment. A real scale beneath (0, 25, 50, 75, 100%). Labels only where they fit; every segment has a legend row below (swatch, name, share, NAM figure plus plain note). Segments grow once on first paint; the legend numbers are final from the first frame.

### HeroNumber, Fact strip

HeroNumber: label above (13 px 500 ink-2), value (display, 48 or 32 px), delta pill beside (inverse fill, glyph, signed, "since this time yesterday"), ProvChip on the label row. Fact strip: 3 columns (4 columns on Holders, 2x2 on phone), 24 px number, 13 px label, top rule 2 px `--c-ink`, hairline between columns; **one** SourceLine under the strip for all of its figures.

### Banner, Notice, EmptyState, Skeleton

- **Banner rewound:** full width, black text on yellow, sticky directly under the header on phones, one line, 44 px `Back to now` button. Phone copy: "Rewound to 30 Aug 2026, 19:05 UTC" and the button; from 640 px the full sentence ("Every number is as it was then; live prices are paused."). The header Rewind button is hidden below 1024 px. **Banner update:** `--surface-2`, "A new version was deployed", `Reload` button.
- **Notice:** left 3 px rule, 20 px icon, title 600, sub 13 px ink-2; tones info, success, warning, danger replace the six hand-rolled boxes. On yellow: black rule, 6% black wash.
- **EmptyState:** dashed ring icon, one title ("Nothing crossed an alert size in 24 hours."), one sentence, the threshold in dollars (derived), the **last occurrence with a rewind link**, the window in words (never under one hour).
- **Skeleton:** row-shaped blocks at the final heights, six to eight rows, shimmer loop 1.2 s (static under reduced motion), footers hidden until data, a reserved 24 px slot for chips, a fixed-width price slot in the header. Targets CLS under 0.1 on every route.

### Icon, Wordmark and mark

Icons: one 24 px grid, 1.5 px stroke, round caps (1.9 px for the active tab), plus 12 px flow glyphs. The reference set (home, trade, supply, shielded, activity, alerts, search, account, rewind, arrow, close, chev, filter, info, warn, check; buy, sell, shield, lock, bridge, ring) is the `ICONS` block of `final/build.mjs`. Add glyphs for Bot trade, Public funding, Added to pool, Removed from pool in the same grid. No Unicode dingbats anywhere.

The mark (viewBox 32): `<path d="M16 3.5a12.5 12.5 0 1 0 12.5 12.5" fill="none" stroke="currentColor" stroke-width="4.5"/><path d="M16 16 25 7" stroke="currentColor" stroke-width="3.2" fill="none"/><circle cx="16" cy="16" r="2.6" fill="currentColor"/>`. Yellow on black in the header (32 px) and footer (40 px). Favicon: the same on a black square; apple-touch icon 180 px, the mark at 60% on black; **OG image 1200 x 630:** yellow field, black dial and wordmark top left, the tagline in caps 600 black, no live numbers (a static image must not carry a price). Ships as `/favicon.svg`, PNGs, apple-touch icon, OG image; replaces `docs/design/og.svg`. Wordmark: `NAMADA TRADE`, Space Grotesk 700 caps, tracking 0.06em, `TRADE` in `--accent-text`. Namada's symbol is never our mark or favicon; if the owner approves it appears once, unmodified, 16 px, beside "Not affiliated with Namada or the Anoma Foundation" in the footer (owner decision c, not placed).

### Popover

A small anchored card (max 320 px, `--surface`, 1 px `--line-strong`, 0 radius, 2 px yellow top rule) for glossary terms and tag explanations: plain row over expert row, one sentence, one "More in the glossary" link. On phones a popover opens as the same bottom `Sheet`. The provenance controls (ProvChip, ProvDot, SourceLine) always open the `Sheet`, never a popover, because they carry a Rewind action.

### Glossary term

A glossary term in running text is a button with a **solid** 1 px underline (offset 4 px), distinct from the dotted (old), wavy (disagree) and dashed (no data) number underlines. Tap opens a small popover: plain row over the expert row, from the brief's glossary plus: **Size table** (six order sizes the Osmosis router quotes at the same moment), **Cross-check** (two sources compared; passes or needs a look), **Latest moves** (the newest single moves of 1,000 NAM or more), **Estimate** (a straight line between two real quotes), **Thin market** (pools so small that your own order moves the price), **Rewind** (every number as it was at a past moment).

### Palette (search)

Dialog: full-height sheet on phones with the input at the top (16 px minimum text to stop iOS zoom) and recent addresses below; 640 px centred from 1024. Groups: Views, Addresses, Actions, Glossary. A Rewind row holds a date-time input (UTC) and presets from `docs/events.json` (the three biggest moves, and the 331 million NAM example). Rows 52 px; arrow keys and Enter; `/` and Ctrl or Cmd K open it. No "Ctrl K" hint on touch.

---

## 9. Screens

Every screen: one hero (a figure of 32 px or more plus one sentence), everything else 24 px or less; a SourceLine at the foot of every panel; skeletons at final heights; the H1 equals `RouteDef.h1` and is rendered by React (SEO gate); the plain server-rendered paragraphs (`BODY`) are visible text too (single source `shared/copy.ts`).

### 9.1 Home (`/`) — reference: `final/home.html`, `shots/home-375.png`, `home-1280.png`

Phone, top to bottom:

1. **Yellow hero** (ground-accent). Eyebrow = dateline (`NAM ON OSMOSIS · SAT 17 OCT 2026 · 11:24 UTC`, bound to `overview.generatedAt`, or the rewound time). H1 caps 32 px, three lines. Sub (15 px, three lines) defines NAM. Label row: "One NAM costs" left, ProvChip `Osmosis quote · now` right. Price 64 px, dimmed zeros. Delta pill plus "since this time yesterday". Primary button "See what a trade costs" (full width), secondary "How we know" (opens Sources). Fact strip (holders on Namada, shielded, on Osmosis) and its one SourceLine. Ruler on the bottom edge (the screen's one decorative scale). **The first screen at 375 x 812 shows all of this and the ruler edge (measured at 749 px from the top, inside the 756 px above the tab bar); the "What changed" heading starts at 797 px.**
2. **What changed in the last 24 hours** (black). Alert hits in rule words with age (max three, then "{n} more"); when none: the dashed empty state, "Alert sizes are small on purpose: at today's price 10,000 NAM is $10.25" (derived, ProvDot), "The last one: Staked 2,999,716 NAM, 16 days ago", link **Rewind to it**. Then **Latest moves** (1,000 NAM or more, newest first, six rows: number, kind tag, signed NAM, age, short address, detail) and one SourceLine ("Flow index · 32 min to 3.2 h · old"). Link "All activity". When the flow index is old the rows are dimmed once.
3. **Where is all the NAM?** The lead sentence, the supply bar, the legend, the escrow notice when the bridge check needs a look, a SourceLine.
4. **Who holds NAM.** Lead sentence, the age sentence, ten two-line rows (rank, name, address and `+2 linked on Osmosis`, total NAM, share, share bar; rank 1 carries "staked figures differ by 100,000 NAM"), SourceLine, link "All 2,209 holders".
5. **Yellow: How NAM gets from a wallet to a sale.** Four steps on a vertical rail (Staked, Unlocked, Bridged, Sold), each with its one real number and a ProvDot, then the **explore panel** "Drag an order size" (`OrderSizeCurve`, full width), then the shielded side note.
6. **What would you get right now?** The mini-ticket: Sell 5,000 NAM with `live quote not answering` beside the label, "You get about 5.05 USDC" with ProvChip `Size table · now`, Price move −1.49%, the warning notice ("The Osmosis quote service is not answering. Last quoted price: $0.001025, just now. These figures come from the size table…"), link "Full quote".
7. **Why you can trust these numbers.** Three points (source and age on every number; "5 of 7 cross-checks pass right now, 2 need a look"; Rewind with the example link), the **dated static proof block** (parsed from the replay report at build time with its date), the two checks that need a look as rows, "The 5 that pass" as a disclosure, a SourceLine ("Cross-checks ran 10 s ago").
8. **Footer** (black): dial and wordmark, snapshot line, the two-sentence legal block (data sources; "NamadaTrade reports public on-chain and exchange data. It is not investment advice and is not affiliated with Namada or the Anoma Foundation."), links How we know, Settings, API, Source code.

Desktop (1280): hero is two columns (H1, sub and actions left; price block and a 30-day executed-price sparkline right), the fact strip full width, ruler edge. Below: an 8-column narrative (sections 2 to 4) beside a **sticky "Right now" rail** (3 columns: pool depth, NAM on Osmosis, unstaking wait, cross-checks, each with a ProvDot). The path is four equal columns on the rail, then the explore panel with the curve left (7 of 12) and the controls and readout right (5 of 12). The closing section is the mini-ticket (5 columns) beside Why trust (6 columns).

### 9.2 Trade (`/trade`) — reference: `final/trade.html`

Phone: yellow ticket band (eyebrow, H1, "An Osmosis quote, not an order. This site never trades for you.", side toggle, Amount field with **`live quote not answering`** marker on the label row when the quote failed, "Worth about $5.13", presets scroll row, the listed-sizes note, the "You get" hero 48 px with a `from the size table` marker, "for 5,000 NAM at an average $0.001009 each", Quoted price and Price move (−1.49%) pair, the paragraph "These figures come from the size table…", ProvChip `Size table · now`, the Thin market notice) → black chart block (takeaway H2, range segmented 24h/7d/30d, readout, chart with event markers, key, Low/High/Last/Quoted-now strip, the sparse-data sentence, SourceLine) → yellow "How size moves the price" (lead, curve with slider, the ladder as two-line rows with both sides, the safe-size sentence, SourceLine) → black "Where NAM trades" (pools as rows, SourceLine).

Desktop: **split ground**. Left 5/12: the yellow ticket column, `position: sticky` under the header with `max-height: calc(100dvh - header - 32px)` and its own scroll when the ticket is taller than the window; the column edge carries the decorative scale. Right 7/12 black: chart block, then the size block (curve above, ladder as a six-column table with both sides at equal weight; the picked size is an inverse row; tapping a row sets the ticket size). Below the split, full width black: pools table. In production the **slider and the amount are one shared state** (two-way); with the live quote down only the six listed sizes (and interpolated estimates, labelled) are selectable; with the quote up any amount is quoted live and the curve shows a cursor at the amount.

Live variant (quote answering): the marker and paragraph disappear, the chip reads `Osmosis quote · now`, the amount is a real input, the size table remains below as context.

### 9.3 Supply (`/supply`)

H1 "Is a big sale coming?". Yellow band: hero figure **Ready to sell** (NAM that crossed to Osmosis and has not been sold or sent back, with dollars derived from the price, ProvChip) plus one sentence ("NAM that crossed to Osmosis in the last 7 days, minus what has been sold or sent back"), range segmented (1 day, 7 days, 30 days), fact strip (Bridged in, Bridged back out, Net bought on Osmosis 24 h, Staked share). Black body: **Ready to sell on Osmosis** (rows: address or name, remaining NAM, line two "bridged in X, sold Y, back out Z", tag "Sold before: N NAM" when prior sells exist, last seen, linked Namada address), **Who is moving the price** (rows: address, net 24 h signed in buy/sell hues, net 7 days, buys/sells, last seen), **Unstaking and restaking** (rows: when, kind tag Staked/Unstaking/Unlocked, signed NAM, address, outcome as a tag: "sellable in 3.2 days", "unlocked and watched for 48 h", "restaked (changed validator, not a sale)", "moved to Osmosis", "still unlocked and could be sold"; tx link; the 14-day staked-supply chart under it), **Votes in progress** only when non-empty. Desktop: hero strip; Ready to sell beside Who is moving; Unstaking full width. Provenance wording: "held on Osmosis (wallets and pools)" with the pool depth beside it.

### 9.4 Shielded (`/shielded`)

H1 "How much NAM can't be seen?". Yellow band: share hero (48 px, e.g. 4.4%) with the shielded bar (shielded vs the part on Osmosis, labelled), "of all NAM sits in the shielded set. The total is public; the owners are not." Panels: **Inside the shielded set** (Share of all NAM, On Osmosis, Moved in net 24 h and 7 days with in/out detail), **Shielded NAM over time** (chart in `--shielded`, takeaway title, 160 px phone, 260 desktop, source line states the daily history since 2025-06 then 6-hourly readings), **Largest moves out, 30 days** (rows: age, Shielded out tag, NAM with dollars, destination, tx). Plain "How to use this": discount any who-holds-what signal by the shielded share; a large move out to a fresh address is the only early sign of a hidden holder moving. Desktop: share hero beside the chart (5/7), list below.

### 9.5 Activity (`/activity`, `/holders`)

Yellow band: H1 ("Every move, with its source" / "Who holds NAM?") plus the fact strip. Page tabs `Transactions | Holders` (2 px yellow underline) and one **Filter** button (count badge) that opens a bottom sheet on phones (Chain, What, Size, search) and becomes inline controls from 1024 px.

**Transactions:** list rows: line 1 kind tag, signed NAM, value; line 2 from to short addresses and age; "time and price source" as an expandable third line; live rows animate in (200 ms) with their source text; "Load more" (cursor); "Export CSV" link; desktop table with sticky header (Time, What, NAM, Value, From to, Source, Tx).

**Holders** (reference: `final/holders.html`): the rows of Home plus Spendable and Staked columns from a 930 px container; the 7-day column appears only when any value is not zero and is otherwise said once ("No balance here changed in the last 7 days"); filters Chain (Namada, Osmosis) and What (All, Foundation, Genesis, Backer, No label) with counts; Osmosis shows a considered empty state when the list was not captured (the count and top-10 share are still shown); rank-1's staked cell shows both readings; one age sentence and one SourceLine.

### 9.6 Alerts (`/alerts`)

H1 "What should wake me up?". Hero: **Since you were away** (count of hits, or "Nothing crossed a threshold" with the empty-state pattern and the last one), window segmented (since last visit, 24 h, 7 days). Hits (rule tag, title in rule words, detail, age, tx link). **What triggers an alert**: five rows with plain conditions ("50,000 NAM or more moved out of the shielded set to a personal address") and, signed in, a Switch per row; signed out they show a locked state "Sign in to choose". **Where alerts go**: one line plus one action ("Open settings" or "Sign in"). Rule ids and logic in `shared/alerts.ts` are unchanged; only title and condition strings change. Desktop: hits (7 columns) beside rules (5).

### 9.7 Settings (`/settings`, signed in)

Sections in order, each a titled panel: **Alert rules** (Switch rows, thresholds as Fields with the dollar equivalent derived), **Where alerts go** (Discord webhook field masked, Send a test message, other channels), **Watchlist**, **Quiet hours**, **Devices** (signed-in devices with sign-out), **For developers** (API keys: create, copy, revoke; operator text allowed here), **Your data** ("What is stored about you" table, Export, Delete everything as the one destructive button), and **Appearance** (Dark, Light, Match my device). Phone: one column; desktop: a sticky section list (3 columns) beside the panels (7 columns). The privacy line must be true: no analytics beacon (owner decision d).

### 9.8 Sheets

- **Sign in** (bottom sheet, internal scroll, never taller than 100dvh): H "Sign in with your Namada wallet" (addresses start with tnam1), first line "No transaction, no fee, nothing moves.", three options (Namada Keychain, Keplr, pair code; wallet logos replace the "N" and "K" squares when licensed assets exist), a line "NamadaTrade never gets your wallet's secret". `/alerts?pair=CODE` opens it on the pair-code step.
- **Sources** ("Where every number comes from"): the lead sentence (`5 of 7` cross-checks pass, 2 need a look; the snapshot or live time), the checks that need a look first then the ones that pass, each with plain title, word (Passes, Needs a look) and the plain detail ("1,614 NAM apart"); "How it is computed" disclosure with the data-source list. Operator text lives only here and in For developers.
- **Address** (bottom sheet on phones, right-hand panel from 1024 px): name (or short address), full address with a copy button, Spendable and Staked (with checked age), linked addresses, recent moves as rows, "Rewind to this address's last move".
- **Search:** the Palette (section 8).
- **Filters:** the Activity filter sheet.

### 9.9 Not found, update, loading

Not found: H1 "That page does not exist", the six tabs as links, server 404 plus `noindex` unchanged. Update banner as section 8. Loading: skeletons only, never the word "Loading…".

---

## 10. Home copy deck (final)

Every value is a bound field with a stamp or a `derive()` of bound fields. The only typed numbers are in the block marked static, which is parsed from `docs/replay-report.md` at build time and carries its date.

| Block | Copy | Binding |
|---|---|---|
| Eyebrow | NAM ON OSMOSIS · {SAT 17 OCT 2026 · 11:24 UTC} | `overview.generatedAt` or `asOf` |
| H1 | What moved, who moved it, and what it costs to trade NAM. | `SITE.tagline` |
| Sub | NAM is the coin of the Namada network. Price, holders, who might sell, how much is shielded. Every number shows its source and age. | static |
| Price label | One NAM costs | static |
| Price | {$0.001025} · {+0.87%} since this time yesterday · chip "Osmosis quote · {age}" | `overview.price.usd`, `change24h` |
| Actions | **See what a trade costs** (to /trade) · How we know (opens Sources) | |
| Fact strip | {2,209} holders on Namada · {4.4%} shielded · {1.7%} on Osmosis · line "Source · 3 sources · 9 s to 10 s · fresh" | `overview.namada.holders`, derived shares |
| What changed | H2 "What changed in the last {24} hours". Hits: up to three in rule words with age, then "{n} more". Empty: "Nothing crossed an alert size in {24} hours." Sub: "Alert sizes are small on purpose: at today's price {10,000} NAM is {$10.25}." Last: "The last one: {Staked} {2,999,716} NAM, {16 days} ago." Link: Rewind to it. | `/api/alerts/recent`, `alertRules` |
| Latest moves | H3 "Latest moves" · "{1,000} NAM or more, newest first". Rows: number, tag, signed NAM, "{age} ago · {address} · {detail}". Link "All activity". | `/api/flows?minNam=1000&limit=6` |
| Where all NAM is | H2 "Where is all the NAM?" Lead: "Only {1.7%} of NAM, {19,986,988 NAM}, is on Osmosis, the one place it can be sold. The pools there hold {$1,819}." Bar: Staked, Public funding, Shielded, Everything else spendable, On Osmosis. Notice when the bridge check needs a look: "Two sources, {1,614} NAM apart. Namada holds {19,988,602} NAM in escrow for Osmosis. Osmosis counts {19,986,988}. The gap is {0.008%} of what is on Osmosis, and one of the cross-checks that needs a look." | `overview.supply`, `overview.dex`, `checks` |
| Who holds NAM | H2 "Who holds NAM". Lead: "The {10} biggest holders own {22.5%} of NAM on Namada. Protocol accounts are excluded. Shielded NAM cannot be attributed to anyone." Sentences: "No balance here changed in the last 7 days." (only when all zero) "Balances were last checked {2.3 days} ago, so they are shown dimmed." Link "All {2,209} holders". | `fetchHolders('namada',1,10,'','total')`, `concentration` |
| How NAM reaches the market | H2 "How NAM gets from a wallet to a sale". 1 Staked: "Staked NAM is locked with validators and can't be sold." {341,947,228} NAM, {29.8%} of all NAM. 2 Unlocked: "Asking to unstake starts a wait of about {13.75} days." 3 Bridged: "To be sold, NAM crosses to Osmosis. Crossings usually come before sales." {19,924} NAM crossed in the last 7 days. 4 Sold: "On Osmosis, NAM trades in small pools. An order of {10,000} NAM moves the price {2.75}%. Drag the size below." Explore: "Drag an order size", readout Worth, You get, Price moves. Side note: "Shielded NAM sits in a pool whose total is public and whose owners are not: {4.4%} of all NAM." | `pressure`, `quote/curve`, `blindspot` |
| Mini-ticket | H2 "What would you get right now?" Rows: Sell {5,000} NAM · You get about {5.05} USDC · Price move {−1.49%}. Marker: "live quote not answering". Notice: "The Osmosis quote service is not answering. Last quoted price: {$0.001025}, {just now}. These figures come from the size table, measured at the same moment, not from a live quote for your amount." Link "Full quote". | `fetchQuote`, `curve` |
| Why trust it | H2 "Why you can trust these numbers". (1) "Every number shows its source and age. Tap a dot and age, or the source line under a list, to see them." (2) "{5 of 7} cross-checks pass right now, {2} need a look." (3) "Rewind: see the site as it was. Try {30 Aug 2026, 19:05 UTC}, the first alert before {331} million NAM were withdrawn from staking." (4) Static, dated {17 Oct 2026}: "Tested on {26} past events (report of {17 Oct 2026}): each of the {10} biggest price moves had an alert-size flow in the prior {48} hours, median {25.0} hours ahead. Such flows precede {90}% of all hours, so this shows the alerts are not blind, not that they predict direction." | `checks`, `docs/replay-report.md` at build |
| Footer | "Every number shows its source and age. Data: Osmosis router, Namada nodes, indexer.namada.net; flow records current as of {32 min}." · "NamadaTrade reports public on-chain and exchange data. It is not investment advice and is not affiliated with Namada or the Anoma Foundation." Links: How we know, Settings, API, Source code (URL to confirm). | static, `overview` |

---

## 11. Names map

| Where | Old | Shown (plain) | Tap or hover (expert) |
|---|---|---|---|
| Nav 1 to 6 | (none) Trade, Pressure, Blind spot, Tape, Alerts | Home, Trade, Supply, Shielded, Activity, Alerts | overview; D1; D2 to D4; D5; flows, tape; D7 |
| Header status | dot, stream/poll, "4/6 checks" | check icon and `5/7`, `5 of 7 checks`; sheet "Where every number comes from" | D6, trust panel |
| Replay | "Replay as of a time…", "⏪ … exit" | Rewind to a date…; banner "Rewound to 30 Aug 2026, 19:05 UTC. Every number is as it was then; live prices are paused. Back to now" | replay, `?at=` |
| Trade cards | Trade ticket, Price, Depth ladder, Pools | Your quote, Price: quoted vs paid, How size moves the price, Where NAM trades | ticket, SQS mid vs executed, depth ladder |
| Trade fields | Fill price, Impact, "split into N clips", Notional, "SQS mid", "▼ Sell NAM → USDC" | Your average price, Price move, "better as N smaller orders", Value, Quoted price, Sell NAM for USDC | fill price, price impact, clips; SQS is Osmosis's Sidecar Query Server |
| Size table (new) | (curve, ladder) | Size table | six sizes quoted by the router at the same moment |
| Supply cards | Inventory on deck, Who is moving the price, Unlocks and re-locks, Governance in flight | Ready to sell on Osmosis, Who is moving the price, Unstaking and restaking, Votes in progress | inventory on deck, movers, unbond/withdraw/bond |
| Shielded cards | What you cannot see, Hidden share, Net shielded 24h, Largest unshields 30d | Inside the shielded set, Share of all NAM, Moved in, net, 24 h, Largest moves out, 30 days | MASP balance, shield, unshield |
| Activity | Kind, Src, Tx, Liquid, Bonded, Verified, "indexed only" | What, Time and price source, Record, Spendable, Staked, Checked on chain, "not yet checked" | tsSource, priceSource, tx hash |
| Flow kinds | buy, sell, ibc in/out, shield, unshield, bond, unbond, withdraw, lp add/remove, arb, pgf | Buy, Sell, Bridged in, Bridged out, Shielded in, Shielded out, Staked, Unstaking, Unlocked, Added to pool, Removed from pool, Bot trade, Public funding | the old words in the tag popover |
| Status words | live, stale, missing, conflict | fresh, old, no data, sources disagree (each with its age) | provenance status |
| Alert rules | Inventory arrived on Osmosis, Stake withdrawn, Large DEX swap, Hidden holder surfaced, Overhang removed | NAM bridged to Osmosis, NAM unstaked, Large trade, NAM left the shielded set, Large amount staked | rule ids unchanged |
| Settings | Notifications, Channels, Devices, API, Privacy & data | Alert rules, Where alerts go, Devices, For developers, Your data | |

Glossary: the brief's thirteen entries plus the six added in section 8 (Size table, Cross-check, Latest moves, Estimate, Thin market, Rewind). Labels from genesis data are printed with underscores removed; `Genesis: af backers`, `Genesis: public allocations completed` and the `foundation` category on Heliax need a plain-language pass from the owner (a `label_plain` map in the worker).

---

## 12. Data honesty (N1 to N10 as the design reads them)

**The four states, everywhere:** fresh (normal), old (dim, age shown), no data (`—` with the reason in view), sources disagree (wavy underline, both values reachable). A derived value inherits the oldest `at` and worst status of its inputs.

**N1, clarified (a test-wording change, not a weakening).** Every number keeps its source and age: `Num`, `SNum`, `ProvChip`, `ProvDot`, `Sourced<T>`. A number may lie inside a **ProvScope**: a panel whose `SourceLine` is a real, focusable control that opens the per-figure sheet. The Playwright assertion becomes: *every `[data-num]` has its own provenance control, or sits inside a scope whose `SourceLine` button exists, is visible, and lists it*; rows that differ from their scope carry their own mark. Mock evidence: Holders shows 0 chips per row and one SourceLine, and rank 1 has its own flag. (Without this, the per-row pill wallpaper returns.)

**Degraded quote.** When `quote` is null: the Trade ticket and Home mini-ticket say "live quote not answering" next to the Amount, the result chip is named `Size table`, a sentence says the figures come from the size table measured at the same moment, no URL or status line is ever printed (the worker already returns plain text, build-plan), and "Last quoted price" carries its age.

**Price status.** `overview.price.usd` reports `old` with the note when the live fetch failed (worker already does this); the chip must never say fresh then.

**Holders.** Rows carry no status of their own in the snapshot; the design treats them as old when older than a placeholder threshold (24 h) and asks the API for a real `status` (build-plan W7). Rank 1: `bonded` 14,662,107 vs `bondedEstimated` 14,562,107; the chain reading is shown, the flow estimate is in the sheet, the row says "staked figures differ by 100,000 NAM".

**Alert hits.** The snapshot has none; the empty state is designed, with the last event and a rewind link (computed from unlock and unshield rows against the rule sizes in the mock; production reads `/api/alerts/recent` over a wider window).

**Static proof.** The dated block and the 331 million example are parsed from `docs/replay-report.md` with its generated date; the owner's three trades (`private/trades.md` (not published)) never appear (owner decision a, default no).

---

## 13. Verification record (reference pages)

| Check | Result |
|---|---|
| Horizontal overflow at 320, 360, 375, 390, 412, 768, 1024, 1280 | none on Home, Trade, Holders (`scrollWidth` equals the width). |
| `<table>` elements | none. |
| Text under 11 px | none from 360 up (SVG ticks scale to 9.7 px at 320 only because the mock uses fixed viewBoxes; production measures). Provenance text 12 px or more. |
| Interactive targets, effective 44 x 44 (hit-tested, `::after` areas counted; inline links in running text exempt) | 39, 38 and 23 targets at 375 on Home, Trade, Holders: 0 under. At 1280: 45, 39, 23: 0 under. |
| Text contrast, dark and light | 0 failures (section 4.4). |
| First screen at 375 x 812 | H1, definition, price, 24 h pill, chip, primary action, fact strip, ruler edge. |
| Page height at 375 | Home 8,114 px, Trade 5,201, Holders 2,367. |
| Reduced motion | all animations removed by the `tokens.css` base rule; scroll reveals gated; `html.static` when the page fits. |

Not verified: Safari, VoiceOver, TalkBack, Lighthouse (the mock is static HTML), real fonts self-hosted, real data refresh. Those are the build gates.

---

## 14. Known gaps and owner questions

1. **Home is long** (8,114 px at 375). Order is by importance and every section is skippable; if the five-second and task tests show fatigue, cut the legend rows (the bar is labelled) and the path's explore panel to desktop only.
2. **Mark change.** The dial replaces the brief's ring-and-triangle pair. Confirm, or fall back to wordmark only.
3. **Repository URL** for "Source code" (owner b). **Namada symbol** in the footer (owner c): not placed.
4. **Cloudflare insights beacon** must be turned off for "no analytics" to be true (owner d), or the line reworded.
5. **Plain labels** for genesis addresses and the Heliax `foundation` category.
6. **Holder row status** and the meaning of `bonded` vs `bondedEstimated` (which is authoritative).
7. **Wallet logos** for Namada Keychain and Keplr (licensed assets) for the sign-in sheet.
8. **The 331 million example** is worded as "the first alert before … were withdrawn" because the report timestamps the alert, not the withdrawal. Confirm.
9. **Chart event markers** need a served source (`/api/events` or a build-time export); the repo doc is not read at runtime.
10. **Desktop Trade slab:** in a full-page capture the yellow column is empty below the ticket (the ticket sticks in a browser). If reviewers object, the fallback is a viewport-height sticky panel on a black column.
11. **Yellow at night.** Two yellow fields on Home is the cap. A "Calmer" appearance option (yellow only on the hero) is possible later; not built.
