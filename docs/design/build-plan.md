# Build plan: the React app (web/src), worker and data changes

Status: ready to start. Companion to `system.md` (what it looks like and why) and `tokens.css` (the variables). Visual truth is `docs/design/final/` (CSS in `site.css`, pages `home.html`, `trade.html`, `holders.html`, shots in `shots/`).

Nothing in this plan has been executed. Nothing was committed or deployed while writing it.

**Rules of the plan**

1. Foundation first, screens in parallel after it, cleanup last. Two engineers never edit the same file: section 3 lists every file and its owner.
2. Port, do not reinvent: `final/site.css` is written against `tokens.css` with the same class names the app should use. Each block moves into one owned file wrapped in `@layer components { … }` (mapping in section 5.1).
3. The brief's gates are the definition of done (section 8). A screen is not finished when it looks right; it is finished when its checks are green.
4. N2 holds in code as in the mock-ups: no hard-coded fallback numbers; every figure is a field, a `derive()` of fields, or the dated static block.

---

## 1. State of the repo today (read from the tree, 2026-10-17)

| Area | Today | Consequence |
|---|---|---|
| `web/src` | `App.tsx` (state-based views, `pushState`), `api.ts`, `index.css` (152 lines), `components/*` (Header, TradeView, PressureView, BlindSpotView, TapeView, AlertsView, SettingsView, Num, TrustPanel, CommandPalette, AddressModal, LoginModal, AccountMenu, PairDevice, `charts/LineChart.tsx`), `lib/format.ts`, `lib/auth.ts`. Tailwind v4 via `@tailwindcss/vite`; `lightweight-charts` is a dependency. | Every view is rewritten. Auth, API and format helpers are kept and extended. |
| `shared/routes.ts` | Routes `/`, `/trade`, `/pressure`, `/shielded`, `/tape`, `/alerts`, `/settings`; `/` renders the trade view; `ROUTE_ALIASES` has `holders: '/tape'`. | Routes change (section 4). Tests in `test/routes.test.ts` enforce title and description lengths and distinctness. |
| `worker/src/seo.ts` | Server-rendered `#ssr` block per route from `BODY` plus live facts, JSON-LD, robots, sitemap, real 404. | Keep. Move `BODY` into `shared/copy.ts` (section 4, W8). |
| `web/index.html` | Google Fonts `<link>` tags, `theme-color #06080d`, desktop-terminal description. | Rewritten (F1). |
| Quote errors | `quoteErrorText()` returns plain text, never a URL (`worker/src/sources/sqs.ts`). The 11:24 snapshot still contains the raw URL, so the deployed worker may predate this. | Verify on production before the Trade screen is accepted. |
| Price status | When the live price fetch fails the stored price is returned as `stale` with the reason in `note` (`worker/src/api.ts`, `provAt(..., 0, { note })`). | Done. UI must never show fresh then. |
| Pool count | `overview.dex.pools = pools.length || stored dex.pool_count` (`api.ts` L153). | Done. |
| Replay (`?at=`) | `asOfParam` is read by `/api/overview`, `/pressure`, `/blindspot`, `/alerts/recent`, `/flows`, `/metrics/history`. **Not** by `/api/holders`, `/api/address/*`, `/api/search`, `/api/integrity`, `/api/pools`, `/api/quote*`. Under replay `overview.checks` and `sources` are empty. | The UI must say so (section 6, N3 notes). |

---

## 2. Decisions engineers do not reopen

| Topic | Decision |
|---|---|
| Stack | React 18, Vite 5, TypeScript, Hono worker. No router library: keep the small path router in `app/router.ts` with real `<a href>` and `preventDefault`. |
| CSS | Plain CSS in cascade layers, `tokens.css` first. **Tailwind is retired**: no utility classes in new code; `tailwindcss` and `@tailwindcss/vite` are removed in Phase 4 once the last old view is gone. Rationale: defect 7 in the brief (unlayered primitives silently beat utilities) and token names Tailwind v4 also defines. Until Phase 4 the old views keep working: import order in `index.css` is `tokens.css`, new component layers, then the Tailwind import. |
| Layer order | `@layer reset, tokens, base, components, utilities;` declared once in `tokens.css`. Nothing in `web/src` is unlayered. |
| Fonts | `@fontsource-variable/space-grotesk` (400 to 700, latin, one file) and `@fontsource/jetbrains-mono` (400 and 500, latin). `font-display: swap`, preload the one text file, metric-matched fallback with `size-adjust`. Remove every Google Fonts tag. Total at most 120 KB (gate G9). |
| Theming | `<html data-theme="dark|light">`, dark by default. A 10-line inline script in `index.html` reads `localStorage['nt.theme']` (`dark`, `light`, `system`; the existing key already stores `dark` or `light`) inside `try/catch`, resolves `system` with `matchMedia`, and sets the attribute before first paint. There are only two token sets. |
| Provenance | Components `Num`, `SNum`, `Derived`, `ProvChip`, `ProvDot`, `SourceLine`, `Sheet`. The rationing rule and the ProvScope clarification of N1 in `system.md` sections 8 and 12 are binding. |
| Charts | Custom SVG measured with `ResizeObserver` in CSS px (ticks always 11 px). Delete `lightweight-charts`. |
| Overlays | Native `popover` or `<dialog>`, light dismiss, Escape, focus return, `max-height: calc(100dvh - 16px)`, internal scroll. |
| Tests | Keep Vitest (`npm test`, `npm run test:replay`, byte-identical results per N10). Add Playwright (`@playwright/test`) and `@axe-core/playwright` as dev dependencies. |
| Before you start | Tag the current UI `ui-v1` (`git tag ui-v1`) so the task tests can compare old and new. (Not done here.) |

---

## 3. Directory layout and file ownership

Owners are roles, not people: **F1** shell and styles, **F2** provenance system, **F3** controls and feedback, **F4** data display and charts, **S1 to S8** screens, **W** worker, shared and data. One owner per file; a file that two roles need is split or made a contract.

```
web/
  index.html                      F1   fonts removed, theme boot script, theme-color #000000, critical CSS (black ground)
  src/
    main.tsx                      F1
    styles/
      index.css                   F1   @import tokens.css; component layers; (Tailwind import until Phase 4)
      tokens.css                  F1   copy of docs/design/tokens.css, never edited by hand: change it in docs/design first
      components/shell.css        F1   header, tab bar, footer, banners   (final/site.css: header, tab bar, footer, ruler)
      components/prov.css         F2   chip, pdot, srcb, num states       (provenance block)
      components/tag.css          F2   tags
      components/sheet.css        F2   sheet, popover, kv
      components/controls.css     F3   buttons, links, segmented, field, switch, presets, chips (selectable), tabs
      components/feedback.css     F3   notice, empty, skeleton, banner
      components/data.css         F4   dl rows (holders, ladder, pools), supply bar, facts, hero number
      components/charts.css       F4   chart, curve
      screens/home.css            S1   hero, narrative, rail, tape, path, explore, mini ticket, trust
      screens/trade.css           S2   split, ticket, chart block, ladder block
      screens/supply.css          S3
      screens/shielded.css        S4
      screens/activity.css        S5   tabs, filters, transaction rows, holders hero
      screens/alerts.css          S6
      screens/settings.css        S6
    app/
      App.tsx                     F1   providers, route outlet, overlays host
      router.ts                   F1   path router, ?at= preserved, replaceState for normalising, popstate
      replay.tsx                  F1   Replay context (at, setAt, banner), api wrapper adds ?at=
      overview.tsx                F1   overview polling (20 s), WebSocket stream, useNow(5000)
      theme.ts                    F1
      keys.ts                     F1   1..6, /, Ctrl or Cmd K; ignores Meta, Ctrl, Alt
      Header.tsx, TabBar.tsx, Footer.tsx, StatusPill.tsx, RewindBanner.tsx, UpdateBanner.tsx   F1
      Palette.tsx                 F1   search, rewind row, glossary
    ui/                           (the barrel ui/index.ts is owned by F1; each file by its owner)
      Num.tsx, ProvChip.tsx, ProvDot.tsx, SourceLine.tsx, Sheet.tsx, Tag.tsx, Term.tsx   F2
      Button.tsx, Segmented.tsx, Tabs.tsx, SelectChip.tsx, Field.tsx, Switch.tsx, Notice.tsx, EmptyState.tsx, Skeleton.tsx, Icon.tsx, Wordmark.tsx   F3
      DataList.tsx, SupplyBar.tsx, HeroNumber.tsx, Fact.tsx, PriceChart.tsx, OrderSizeCurve.tsx, Sparkline.tsx   F4
    lib/
      format.ts                   F2   extended (signed, sub-dollar, ages, rules in system.md 5.3); keep existing exports
      prov.ts                     F2   status map (live/stale/missing/conflict to fresh/old/none/disagree), PLAIN_SOURCE, CHECK_TITLES keyed by check.key
      derive.ts                   F2
      glossary.ts                 F2   plain row, expert row, from the brief plus six additions
      kinds.ts                    F3   flow kind to {word, glyph, hue, expert term}
      auth.ts                     S7   unchanged
    screens/
      home/*                      S1
      trade/*                     S2
      supply/*                    S3
      shielded/*                  S4
      activity/* (transactions, holders)   S5
      alerts/*, settings/*        S6
      sheets/ SourcesSheet.tsx, AddressSheet.tsx, SignInSheet.tsx, PairDevice.tsx   S7
      seo/ Staking.tsx, Osmosis.tsx, LearnHowTrading.tsx, Faq.tsx, NotFound.tsx      S8
    generated/                    W    build-time exports: proof.ts (replay report), events.ts (chart markers)
  public/                         F1   favicon.svg, icons, apple-touch, og.png, manifest (theme_color black)
shared/
  routes.ts                       W
  copy.ts                         W    SITE texts and BODY paragraphs, one source for worker/seo.ts and the views
  types.ts                        W
  alerts.ts                       W    titles and conditions in plain words; ids and logic unchanged
worker/src/                       W
scripts/export-proof.ts           W    parses docs/replay-report.md and docs/events.json into web/src/generated
web/e2e/                          F1 (harness, gates), each screen owner adds its own spec file
```

**Shared files and the rule:** `ui/index.ts`, `styles/index.css`, `styles/tokens.css`, `app/*`, `shared/*`, `worker/*` change only through their owner. A screen that needs a primitive change opens a request to that owner and uses the contract (section 5.2) meanwhile.

---

## 4. Worker, shared and data changes

| ID | Change | Status | Files | Test |
|---|---|---|---|---|
| W0 | Plain quote errors (no URL, no status line) | **Done in repo**; verify on production (the 11:24 snapshot still printed the URL) | `worker/src/sources/sqs.ts` (`quoteErrorText`) | `test/sqs.test.ts` exists; add a case asserting no `http` in `error` |
| W0b | Price is `stale` with a note when the live fetch failed | **Done** | `worker/src/api.ts` | add a test with a failing fetch |
| W0c | `overview.dex.pools` falls back to the stored pool count | **Done** | `worker/src/api.ts` L153 | fixture test |
| W0d | Worker-side SEO (real 404, redirects, robots, sitemap, per-route server-rendered text, edge cache, immutable assets) | **Done** | `worker/src/index.ts`, `seo.ts` | `test/routes.test.ts` |
| W1 | `GET /api/flows?minNam=&arb=false` for Home "Latest moves" (newest first, bots removed, at least N NAM). Today `limit` is clamped 10 to 100 and there is no amount filter. | To do | `worker/src/api.ts` | unit test on the SQL conditions |
| W2 | Holder rows get a server `status` (`live`, `stale` when `verifiedAt` is older than a configured window, `conflict` when `bonded` and `bondedEstimated` differ by more than 1 NAM) and `statusNote`. The design uses a 24 h placeholder until this exists. | To do | `worker/src/api.ts`, `shared/types.ts` | status fixture tests |
| W3 | Plain labels: `label_plain` and `category_plain` for genesis labels (`Genesis: af backers`, `Genesis: public allocations completed`) and the Heliax `foundation` category; **owner pass needed on the wording** | To do (owner input) | `worker/src/api.ts` or a label map | snapshot test |
| W4 | Build-time export of the dated proof block and the chart event markers: `scripts/export-proof.ts` parses `docs/replay-report.md` (generated date, events, flagged, median lead, base rate, window, the largest withdrawal and its first-alert time) and `docs/events.json` (the biggest price moves) into `web/src/generated/proof.ts` and `events.ts`; `npm run build` runs it. | To do | `scripts/`, `package.json` | parse test against the current report |
| W5 | `GET /api/alerts/recent` also returns `last`: the most recent hit of any age, for the empty state ("The last one: Staked 2,999,716 NAM, 16 days ago. Rewind to it."). | To do | `worker/src/api.ts`, `shared/types.ts` | fixture test |
| W6 | Document that `maxSafeClip1PctNam` and `maxSafeClip3PctNam` are the **worst side** (`safeClip` takes `max(sell, buy)`); UI copy says "buying or selling". No API change. | To do (comment and type doc) | `shared/types.ts` | none |
| W7 | Rewind honesty: `/api/holders`, `/api/address/*`, `/api/search` do not take `at`. Either add history or make the UI say "Balances are current, not as of {time}" (design default). `overview.checks` is empty under replay: the status pill shows `no data` with "Checks were not recorded then". | UI work in S5, S7, F1; API optional | | N3 test (section 8) |
| W8 | Routes and copy: `shared/routes.ts` new list (`/`, `/trade`, `/supply`, `/shielded`, `/activity`, `/holders`, `/alerts`, `/settings`, then `/staking`, `/osmosis`, `/learn/how-nam-trading-works`, `/faq`), ids no longer share `trade` with `/`, `ROUTE_ALIASES` gains `pressure: '/supply'`, `tape: '/activity'`, `flows: '/activity'`, drops `holders: '/tape'`; new `H1`, title (at most 46 characters), description (at most 155) per route; `shared/copy.ts` holds `SITE` texts and the `BODY` paragraphs that `worker/src/seo.ts` renders **and** the views show (`seo-requirements.md` 3); disclaimer sentence in every footer. `pageHtml` inline styles move to the black ground. | To do | `shared/routes.ts`, `shared/copy.ts`, `worker/src/seo.ts` | extend `test/routes.test.ts` (distinct title, description, h1; 301 for old paths with `?at=` kept; new routes classify as routes) |
| W9 | Alert rule titles and conditions in plain words (brief section 4). Ids, thresholds and logic unchanged; `npm run test:replay` must be identical except the timestamp. | To do | `shared/alerts.ts` | `test/replay.test.ts` unchanged |
| W10 | Analytics beacon: Cloudflare Web Analytics injects `static.cloudflareinsights.com` from the dashboard (owner step), or the privacy line is reworded. | **Owner** | Cloudflare dashboard, `SettingsView` copy | G10 network assertion (N9) |
| W11 | Brand assets: `web/public/favicon.svg`, PNG icons, apple-touch, `og.png` from the new design (yellow field, dial, tagline, no live numbers), `manifest.webmanifest` with `theme_color #000000`; `docs/design/og.svg` replaced. | To do (F1) | `web/public` | visual |
| W12 | `GET /api/quote*` and the pools request are live-only: under rewind the app does not call them (live quotes off). | UI work (S2) | | N3 test |

---

## 5. Phases

### Phase 0: owner inputs (parallel, only some block)

Blocking: none for Phase 1. Needed before Phase 2 ships: W3 label wording; repository URL for the footer (owner b); the dial mark approval (system.md, section 14). Not blocking: wallet logos, Namada symbol (owner c), beacon (owner d), the owner's trades stay out (owner a).

### Phase 1: foundation (F1 to F4 in parallel after step 1.1)

| Step | Owner | Work | Done when |
|---|---|---|---|
| 1.1 | F1 | Add `tokens.css`; `index.css` imports; layer order; `index.html` (fonts removed, theme script, critical black ground); fontsource packages; `main.tsx`; Playwright harness with the viewport matrix; empty `ui/index.ts` barrel. | App boots with the old views unchanged; no request to `fonts.googleapis.com`; build passes. |
| 1.2 | F2 | `lib/format.ts` rules, `lib/prov.ts`, `lib/derive.ts`, `Num`, `SNum`, `Derived`, `ProvChip`, `ProvDot`, `SourceLine`, `Sheet`, `Tag`, `Term`, glossary. | Storybook-less demo route `/__ui` (dev only) renders every state; unit tests for `derive` (oldest `at`, worst status, input names) and for format rules; keyboard and touch both open the sheet; hit areas are 44 px (G6). |
| 1.2 | F3 | `Button`, `Segmented`, `Tabs`, `SelectChip`, `Field`, `Switch`, `Notice`, `EmptyState`, `Skeleton`, `Icon` (the mock's symbol set plus the four new glyphs), `Wordmark`, `kinds.ts`. | Same demo route; no Unicode dingbats left in the primitives. |
| 1.2 | F4 | `DataList` (container-query rows to table, no `<table>`, no `display: contents`), `SupplyBar`, `HeroNumber`, `Fact`, `PriceChart` (ResizeObserver, 1-2-5 ticks, event markers, press-and-drag readout, hidden text table), `OrderSizeCurve` (log slider, snapping, estimate tag, interpolation rule), `Sparkline`. | Demo route; chart ticks measure 11 px at 320, 360, 1280 (not scaled); curve test: at a quoted size the readout equals the quote exactly; between two sizes it shows the Estimate tag and the two sizes used; outside the range it shows `—`. |
| 1.3 | F1 | `app/*`: providers, router with anchors (`replaceState` normalising, `?at=` preserved across every navigation and redirect), `Header` (52 px phone, 64 px desktop, `StatusPill` with check icon), `TabBar` (six tabs, count dot on Alerts), `Footer`, `RewindBanner`, `UpdateBanner`, `Palette`, theme, keys. Lazy boundaries: every non-landing screen, the sheets and Settings via `React.lazy`; `import('qrcode')` on the pair click. | Header and bar pass overflow and targets at 320, 360, 375, 1280; keys ignore Meta, Ctrl, Alt; initial JS at most 130 KB gzip (G9). |
| 1.4 | W | W1 to W9, W11 in the order of the table (W8 first: it unblocks routing). | Their tests are green; `npm test` and `npm run test:replay` unchanged. |

Foundation gate: demo route screenshots at 360 and 1280 in both themes match the reference CSS; the contrast script (G4) is green on `tokens.css` and on every primitive state.

### Phase 2: screens (S1 to S8 in parallel; each reads `system.md` section 9 and its reference page)

| Screen | Owner | Files owned | Reference | Data |
|---|---|---|---|---|
| Home `/` | S1 | `screens/home/*`, `styles/screens/home.css` | `final/home.html`, `shots/home-*` | `fetchOverview`, `fetchHolders('namada',1,10,'','total')`, `fetchPressure`, `fetchBlindSpot`, `fetchAlertsRecent` (+`last`), `fetchFlows({minNam})`, `fetchQuoteCurve`, `fetchQuote(5000,'sell')`, `generated/proof` |
| Trade `/trade` | S2 | `screens/trade/*`, `trade.css` | `final/trade.html` | `fetchQuote`, `fetchQuoteCurve`, `fetchPools`, `fetchMetricHistory`, `generated/events`; none of the live ones under rewind |
| Supply `/supply` | S3 | `screens/supply/*`, `supply.css` | system.md 9.3 | `fetchPressure(asOf, days)`, overview |
| Shielded `/shielded` | S4 | `screens/shielded/*`, `shielded.css` | system.md 9.4 | `fetchBlindSpot`, overview |
| Activity and Holders | S5 | `screens/activity/*`, `activity.css` | `final/holders.html`, system.md 9.5 | `fetchFlows` (+ stream rows), `fetchHolders` (+ W2 status) |
| Alerts and Settings | S6 | `screens/alerts/*`, `screens/settings/*` | system.md 9.6, 9.7 | alert endpoints, `lib/api` settings functions (unchanged) |
| Sheets | S7 | `screens/sheets/*` (Sources, Address, Sign-in, Pair) | system.md 9.8 | integrity, address report, auth (unchanged) |
| Not found and SEO pages | S8 | `screens/seo/*` | `seo-requirements.md` | overview, `shared/copy.ts` |

Every screen delivers: the layout at 375 and 1280, skeletons at final heights, the four data states per figure, the rewind behaviour, one `*.spec.ts` in `web/e2e`, and screenshots at 360, 390, 768, 1280 in dark and once in light.

### Phase 3: new SEO pages (after S1 to S6 are in)

`/staking`, `/osmosis`, `/learn/how-nam-trading-works`, `/faq` as specified in `seo-requirements.md`: answer-first first sentence per H2, figures with source and time, plain language, `BODY` entry and `RouteDef` with `index: true`, linked from the footer and the Home explainer, in the sitemap automatically.

### Phase 4: cleanup

Delete the old components and `index.css` rules; remove `lightweight-charts`, `tailwindcss`, `@tailwindcss/vite` and the Tailwind import; remove `LineChart.tsx`; remove the `prompt()` replay; grep for `text-[`, `sm:`, `btn`, `card`, `tag-` class leftovers and for Unicode dingbats (the old `format.ts` glyph map goes). Update `README` screenshots.

### Phase 5: prove

Run every gate in section 8 on the production build; run the human tests (five-second, task, believer) with the protocols in the brief; fix and rerun. The task tests need the `ui-v1` tag.

---

## 5.1 Where the reference CSS goes

| `final/site.css` block | Goes to | Owner |
|---|---|---|
| helpers (`.mono .u .ico .gly .wrap .band`), type (`.eyebrow .h1 .h2 .h3 .sub .lead .cap`), `.dot` | `components/shell.css` | F1 |
| header, tab bar, ruler, footer | `components/shell.css` | F1 |
| provenance (`.chip .pdot .srcb .src`), number states | `components/prov.css` | F2 |
| tags | `components/tag.css` | F2 |
| sheets and popovers, `.kv` | `components/sheet.css` | F2 |
| buttons, links, segmented, fields, presets | `components/controls.css` | F3 |
| notice, empty | `components/feedback.css` | F3 |
| supply bar and legend, facts, DataList rows (holders, ladder, pools) | `components/data.css` | F4 |
| chart and curve | `components/charts.css` | F4 |
| Home hero to trust | `screens/home.css` | S1 |
| Trade | `screens/trade.css` | S2 |
| Holders | `screens/activity.css` | S5 |
| motion keyframes | each block keeps its own; the reduced-motion rule is in `tokens.css` | |

Keep the container-query breakpoints (holders 620 and 930 px, ladder and pools 600 px, curve 480 and 800 px) and the 44 px hit-area pseudo-elements (`.chip::after { inset: -11px -5px }`, `.hbtn::after { inset: -7px -3px }`, `.pdot::after { inset: -10px -6px }`): the audit passes because of them.

## 5.2 Primitive contracts (so screens can start before the primitives are finished)

```ts
type Status = 'live' | 'stale' | 'missing' | 'conflict';          // server words; UI words are fresh, old, no data, sources disagree
interface Stamp { source: string; plain?: string; at: number | null; status: Status; note?: string; derivedFrom?: string; extra?: [string, ReactNode][] }

<Num v={n|null} prov={Provenance} fmt={fn} unit?="NAM" showAge? />          // renders <span data-num data-status>; none shows "—" and the reason inline
<SNum s={Sourced<number>} fmt unit showAge />
derive(inputs: Stamp[], label: string): Stamp                               // oldest at, worst status, names the inputs
<ProvChip p={Stamp} label? text? />   <ProvDot p label? text? />            // both open the Sheet; the text always has a source word
<SourceLine items={[{ label, p }]} label? lead?="Source" text? />            // the panel footer; opens the scope sheet
<Sheet open onClose title size?="md|lg"> … </Sheet>                          // native popover pattern
<Tag kind="buy|sell|shieldIn|shieldOut|staked|unstaking|unlocked|bridgedIn|bridgedOut|poolAdd|poolRemove|bot|pgf" /> <Tag cat="Genesis" />
<Button variant="primary|secondary|destructive" /> <Segmented value options onChange /> <Tabs /> <SelectChip /> <Field label unit hint /> <Switch />
<Notice tone="info|success|warning|danger" title> … </Notice> <EmptyState title last? /> <Skeleton rows heights />
<DataList kind="holders|ladder|pools|moves" container-queries />  <SupplyBar segments flag />  <Fact items /> <HeroNumber label value delta chip />
<PriceChart series events? range onRange /> <OrderSizeCurve points value onChange side mode="explore|ticket" /> <Sparkline points />
```

---

## 6. Behaviours that cut across screens

- **Ages tick.** One `useNow(5000)` store; ages derive from `at` on render. The live dot (header price) shows only while the stream is connected and the tab visible.
- **Rewind (N3).** `?at=<ms>` on every route; the `RewindBanner` is the only replay control below 1024 px; every fetch goes through one wrapper that adds `at`. Exempt (no `at` support today): `/api/holders`, `/api/address/*`, `/api/search`, `/api/integrity`. For those the UI says so in words ("Balances were not recorded over time; these are current, not as of {time}") and never shows them as if dated. The live quote and pool requests are not made. `overview.checks` empty: the status pill reads `no data` ("Checks were not recorded then"). Replay price falls back to the executed-swap price, labelled.
- **Degraded quote.** When `quote` is null: marker "live quote not answering" beside Amount, size-table paragraph, chip named `Size table`, no URL. Numbers come from the curve at listed sizes only.
- **Provenance in lists.** A scope whose figures are all old: dim once (`.is-old`), one sentence, one `SourceLine`; no per-row stamps. Rows that differ carry their own mark.
- **Skeletons** at final heights; chip slots reserved; the header price slot has a fixed width. CLS under 0.1 on every route.
- **Overflow.** `scrollWidth <= innerWidth` always; `body { overflow-x: clip }` is a safety net only.

---

## 7. Dependencies

Add: `@fontsource-variable/space-grotesk`, `@fontsource/jetbrains-mono` (runtime); `@playwright/test`, `@axe-core/playwright` (dev). Remove in Phase 4: `lightweight-charts`, `tailwindcss`, `@tailwindcss/vite`. `qrcode` stays, loaded dynamically.

---

## 8. Gates (the brief's, with the commands)

| Gate | Check | Pass | Where it runs |
|---|---|---|---|
| G1 Five-second | Home at 375 x 812 for 5 s to 5 adults who do not hold NAM, then hidden | 4 of 5 name NAM or Namada plus price, holders or market; 4 of 5 recall one real number | human, Phase 5 |
| G2 Task | `docs/task-tests.md` Q1 to Q6 in three conditions (`ui-v1`, new UI, Osmosis app plus explorer), at least 3 traders; plus "who holds the most NAM?" and "is NAM easy to sell in size, and how do you know?" for 3 non-holders | new UI median at most 70% of old and at most the Osmosis+explorer median on every question; accuracy at least old; no answer over 90 s | human |
| G3 Believer | owner's friend plus two Namada people blind-rate ours, the Osmosis app and a generic template, 1 to 5 | median at least 4.0, at least 1.0 above the template, no rating under 3 | human |
| G4 Contrast | `scripts/contrast.ts` reads `tokens.css` and checks every pair in `system.md` 4.1 in both themes; axe AA on every route | text at least 4.5 (3 at 24 px or 18.66 px bold); control borders, chart marks and focus rings at least 3; `--ink-3` never on a number | CI |
| G5 Copy lint | script over rendered strings and `web/src/**/*.tsx` literals | zero banned words (SQS, IBC, DEX, PoS, MASP, ABCI, RPC, cron, webhook, npm, bare D1 to D7, "Loading…") outside the allowlist (glossary, Sources "How it is computed", For developers); Home copy at most grade 8; sentence case | CI |
| G6 Overflow and targets | Playwright at 360x780, 375x812, 390x844, 412x915, 768x1024, 1280x800 on every route, with `?at=` and with each sheet open; header smoke at 320 | `scrollWidth <= innerWidth`; no `<table>`; at least 95% of interactive elements effectively 44 x 44 (hit-tested, inline links exempt); no text under 11 px; provenance at least 12 px | CI |
| G7 Motion | emulate reduced motion, sample after load | `document.getAnimations().length === 0`; no layout shift when data arrives | CI |
| G8 Lighthouse | mobile, default throttling: Home, Trade, Supply, Shielded, Activity | performance at least 90, accessibility and best practices at least 95; LCP at most 2.5 s, CLS under 0.1, TBT at most 200 ms | CI on a preview |
| G9 Budgets | build size report | initial JS at most 130 KB gzip; fonts at most 120 KB; tabular-figure test (`1`, `0`, `8` equal width at 48 px) | CI |
| G10 N1 to N10 | N1: Playwright with `/api/overview` mocked to each status: dim class, `—`, reason visible without hover, age text; **every `[data-num]` has its own provenance control, or sits in a scope whose `SourceLine` exists, is visible and lists it** (reachable by tap and keyboard). N2: number audit from a fixture of unique odd values; lint for numeric literals in JSX outside the dated block. N3: `/supply?at=1788116700000` at 375: no overflow, banner present, no header replay button, every `/api` request has `at=` except the exempt list, navigation keeps `at`, old `#/…?at=` still redirects. N4: `data-decision` sets per view equal {Trade D1; Supply D2 D3 D4; Shielded D5; Alerts D7; Sources D6}; no bare `D\d` in visible text. N5: `npm test` (auth) unchanged; sign-in sheet within 100dvh and scrolls; `/alerts?pair=CODE` opens it. N6: replay test identical except timestamp; settings tests unchanged. N7: push a mock WebSocket flow on Activity: row appears with source text; CSV link exists. N8: Sources sheet renders one row per `check.key`. N9: network assertion, only `/api` and `/ws`, fonts self-hosted. N10: `npm test` and `npm run test:replay` byte-identical. | all green | CI |

### Per-screen acceptance (in addition to G4 to G10 on that route)

| Screen | Checks |
|---|---|
| Home | One `<h1>` equal to `RouteDef.h1`. First screen at 375 x 812 contains H1, price, 24 h pill, chip, primary action, fact strip and the hero's bottom edge (reference: ruler edge at 749 px). Section order as `system.md` 9.1. At most 2 ProvChips on the route. Latest moves has six rows from `/api/flows?minNam=1000`. The supply bar legend sums to 100%; the escrow notice appears exactly when the bridge check is not ok. Holders rows: two lines, no chip per row, tag only when informative. The curve snaps to the six sizes. Static proof block shows its date. Rewind example link is `/supply?at=<first alert time>`. |
| Trade | Ticket first on phones. Degraded state shows the marker, the size-table paragraph and `Size table · now`; live state shows `Osmosis quote · now` and a real input. Price move is signed and 2 decimals everywhere; the same figure reads the same in ticket, notice and ladder. Both sides at equal weight in the desktop table. Pools table is below the split. Sticky ticket scrolls internally when taller than the window. No live request under rewind. |
| Supply | Hero "Ready to sell" with dollars derived and stamped; unlock outcomes as plain tags; votes only when non-empty; window 1, 7, 30 days. |
| Shielded | Share hero, supply bar, chart in `--shielded` with takeaway title, largest moves out as rows. |
| Activity and Holders | Filter sheet on phones with count badge, inline from 1024; live rows animate in only when streamed; CSV export; holders 7-day column only when any value is not zero; Osmosis tab shows the considered empty state; rank-1 style row exception works from `status: conflict`. |
| Alerts | "Since you were away" empty state shows the last event and a rewind link; rules as Switch rows when signed in, locked when not; one-line delivery with one action; count dot on the tab. |
| Settings | Sections in order; Discord test message still sends; delete is the one destructive button; the privacy line is true (G10 N9). |
| Sheets | Open within 100dvh and scroll; focus returns to the invoker; Escape closes; developer detail only under "How it is computed". |

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| The self-hosted Space Grotesk subset drops `tnum` | G9 test; fallback to JetBrains Mono for hero numerals. |
| Native `popover` focus and scroll-lock gaps in older Safari | Use `<dialog>` with the same markup; test on iOS Safari before Phase 5. |
| Container queries unsupported in a very old browser | Rows (the narrow layout) are the default; the table is the enhancement. |
| Holders have no server status yet | The 24 h placeholder is flagged in code as `// W2`; replace when W2 lands. |
| Home is long on phones | Section order by importance; cut candidates listed in `system.md` 14. |
| Sticky ticket taller than the viewport | `max-height` plus internal scroll; the "You get" block sits in the first 560 px of the ticket. |
| Scroll-driven reveals leave content hidden in a screenshot or a tall window | Gated by `prefers-reduced-motion: no-preference` and `@supports`; `html.static` when the page fits. |
