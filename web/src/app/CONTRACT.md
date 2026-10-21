# The screen contract (shell, F1)

How a screen or a sheet plugs into the app shell. Everything here is implemented in `web/src/app/*`; the short version is at the top of `App.tsx`. Design rules live in `docs/design/system.md`, file ownership in `docs/design/build-plan.md` section 3.

## 1. Your entry file

| Route | Entry file (default export unless noted) | Owner |
|---|---|---|
| `/` | `screens/home/index.tsx` | S1 |
| `/trade` | `screens/trade/index.tsx` | S2 |
| `/supply` | `screens/supply/index.tsx` | S3 |
| `/shielded` | `screens/shielded/index.tsx` | S4 |
| `/activity`, `/holders` | `screens/activity/index.tsx` (one component for both) | S5 |
| `/alerts` | `screens/alerts/index.tsx` | S6 |
| `/settings` | `screens/settings/index.tsx` | S6 |
| `/staking`, `/osmosis`, `/learn/how-nam-trading-works`, `/faq`, not found | `screens/seo/index.tsx`, **named** exports `Staking`, `Osmosis`, `Learn`, `Faq`, `NotFound` | S8 |
| sheets | `screens/sheets/index.tsx`, **named** exports `SourcesSheet`, `AddressSheet`, `SignInSheet`, `AccountSheet` | S7 |

Every entry is loaded with `React.lazy`, so it is its own chunk. Keep heavy imports (charts, big tables) inside your screen; never import a screen from the shell or from another screen.

## 2. Props

```tsx
import type { ScreenProps } from '../../app/index';

export default function TradeScreen({ view, route }: ScreenProps) { … }
```

- `view`: the `RouteId` (`'home'`, `'trade'`, `'supply'`, `'shielded'`, `'activity'`, `'holders'`, `'alerts'`, `'settings'`, `'staking'`, `'osmosis'`, `'learn'`, `'faq'`) or `'notfound'`. Activity uses it to pick the Transactions or the Holders tab; switching between `/activity` and `/holders` keeps the component mounted.
- `route`: the `RouteDef` from `shared/routes.ts` (`null` for not-found).
- Render **exactly one** `<h1>` whose text is `route.h1` (SEO gate, seo-requirements Must 1). The shell sets `document.title` (`fullTitle(route)`); screens never touch it.
- Render inside `<main>` (the shell's); start with your own `<section>`s. Use `.wrap` for the content width.

Import the shell from `'../../app/index'` (the barrel).

## 3. Hooks and helpers (`web/src/app/index.ts`)

| Need | Use |
|---|---|
| The overview | `const { overview, error, receivedAt, stale, pending, refresh } = useOverview()`. `/api/overview`, polled every 20 s while live and visible; one fetch per `?at=` under Rewind. `overview` is `null` until the first answer (show skeletons at final heights, never "Loading…"). If it never answers, `useOverviewFailed()` is true: show "—" instead of the skeleton; the shell's bar under the header gives the reason and "Try again" once for the page. While live, when the last poll failed or two went unanswered, `stale` is true and every stamp the server sent as live already reads old (with a note saying since when); the same bar says so. Screens need do nothing for that. |
| Live flows | `useOverview().liveFlows` (30 newest at load plus every streamed one, newest first, `[]` under Rewind); `streamedIds` holds the ids that came through the stream: animate only those in. `stream.connected`, `stream.lastAt`, `stream.osmosis` (the hub's own Osmosis feed). `streamStamp(stream, now)` is the stamp of "new moves as they happen" (old while the Osmosis feed is down), `osmosisStreaming(stream, now)` the same as a boolean. |
| Flow tags | `<Tag kind={f.kind} chain={f.chain} />` (or `tagOf(f)` from `lib/flows.ts`): a bridge crossing is named by where the NAM went, "Bridged to Osmosis" or "Bridged to Namada", on both of its records, and signed + into Osmosis, − out of it (`kindSign`). Without `chain` a bridge record has no direction. |
| Alerts since the last visit | `useOverview().alerts`: `{ count, since, hits }`. `since` is the previous visit's last moment (`nt.lastSeen`), the start of "Since you were away"; the shell clears the count when `/alerts` is open. |
| Ages | `useClock()` returns the rewound time under Rewind, else a clock that ticks every 5 s. `useNow()` is the wall clock. Compute ages on render from `at`; never store an age. The UI kit's `useUiNow()` follows the same rule (the shell wires it). |
| Rewind | `const { at, rewound, setAt, backToNow } = useReplay()`. |
| Navigation | `<Link to="/trade">` (a real `<a href>`; plain left clicks navigate client-side, Ctrl/Cmd/middle clicks open a tab; the current `?at=` is carried). `navigate(to, { replace?, keepAt? })` from code. A plain `<a href="/supply">` also works through a document-level delegate, but prefer `Link`. `useRoute()` gives `{ view, route, path, params, at }`. |
| Sheets | `const { openSources, openAddress, openSignIn, openSheet, closeSheet, openPalette } = useOverlays()`. `openAddress(addr)` also writes `?addr=` (shareable); `openPalette({ focus: 'rewind' })` opens search on the Rewind row. `openKeys()` opens the Keys sheet; `openSheet({ kind: 'address', address, label })` takes the plain name, when known, for this browser's Recent list (nothing else uses it). |
| Cancellable requests | `useQuery(key, (signal) => fetchX(…, { signal }), { debounceMs, keepPrevious, staleMs })` from `lib/useQuery.ts`: a newer key aborts the older request, and an answer for an older key is never shown. |
| Session | `const { session, setSession, signOut } = useSession()` (wraps `lib/auth.ts`, unchanged). |
| Theme | `const [pref, theme, setPref] = useTheme()`; `pref` is `'dark' | 'light' | 'system'`, stored in `localStorage['nt.theme']`. Dark is `<html>` without `data-theme`; light is `data-theme="light"`. |
| The header price, the check count | `useHeaderPrice()`, `useCheckCount()` (if a screen needs the same reading as the header). |

## 4. Rewind rules (N3)

- `?at=<unix ms>` on every route. While it is set, **every same-origin GET to `/api/` gets `at` added automatically** (one fetch wrapper installed in `main.tsx`), whoever makes the call. You may still pass `asOf` to `api.ts` functions; nothing is added twice.
- Exempt (no `at` on the server): `/api/holders`, `/api/address/*`, `/api/search`, `/api/integrity` (plus exports and account calls). Next to those figures say `REWIND_WORDS.balances(at)` ("Balances were not recorded over time; these are current, not as of {time}.") and never show them as if dated.
- Live-only: `/api/quote*` and `/api/pools`. Do not call them while `rewound` (check `isLiveOnly(path)` or just `rewound`); say `REWIND_WORDS.quotes`. In development a live-only call under Rewind logs a console warning.
- `overview.checks` is empty under Rewind; the header pill already says "no data" and "Checks were not recorded then".
- The Rewind banner is the only replay control below 1024 px. Any "Rewind to this time" link is `<Link to={`${path}?at=${ms}`}>` or `setAt(ms)`; the kit's `RewindLink` already does this.

## 5. Sheets (S7)

```tsx
export function SourcesSheet({ onClose }: { onClose: () => void }) {
  return <Sheet open onClose={onClose} title="Where every number comes from" size="lg">…</Sheet>;
}
export function AddressSheet({ address, onClose }: { address: string; onClose: () => void }) { … }
export function SignInSheet({ code, onClose }: { code: string | null; onClose: () => void }) { … }   // code from ?pair=
export function AccountSheet({ onClose }: { onClose: () => void }) { … }
```

The host (`app/overlays.tsx`) mounts one of these only while it is open and unmounts it on close: open yourself on mount (`<Sheet open …>` from `ui/Sheet.tsx`) and call `onClose` for Escape, the close button and a tap outside. The host returns focus to the control that opened the sheet and keeps `?addr=` and `?pair=` in step with the URL (replaceState).

## 6. Keys and focus

`1` to `6` switch tabs, `/` opens search, Ctrl or Cmd `K` toggles it; the shell ignores digits and `/` while typing, while a `<dialog>` or popover is open, and whenever Meta, Ctrl or Alt is held. Do not bind these keys in a screen. After a client-side navigation the shell scrolls to the top, focuses `<main>` and announces the new title. `?` opens the Keys sheet (every binding is listed from SHORTCUTS in app/keys.ts). On the two lists `/` focuses the list's own search field while it is on screen: a list registers it with `useSlashTarget(ref)` (activity/parts.tsx ListSearch does).

## 7. CSS

- Your file: `styles/screens/<name>.css`, everything inside `@layer components { … }`. Tokens from `styles/tokens.css` (a copy of `docs/design/tokens.css`; change it there first). Read `--c-*` ground tokens so a block works on black, yellow and paper; pick a ground with `.ground-ink`, `.ground-accent` or `.g-accent-to-ink`.
- Shell classes you can use (`styles/components/shell.css`): `.wrap` (`.wrap--wide` for Activity), `.band`, `.eyebrow`, `.h1`, `.h2`, `.h3`, `.sub`, `.lead`, `.cap`, `.mono`, `.u`, `.r`, `.ico` (`--btn`, `--inline`), `.gly` (`--lg`), `.ruler`, `.ruler--scale`, `.wordmark`, `.count`. The status `.dot` is in `prov.css`.
- No Tailwind (removed in Phase 4) and no utility classes: plain CSS in the cascade layers.
- Keep 44 px hit areas (the `::after` pattern) and text at least 11 px (12 px for provenance). Animations: geometry only, and nothing animates under `prefers-reduced-motion: reduce` (tokens.css base rule).

## 8. Tests

Add `web/e2e/<screen>.spec.ts`. Import `test`, `expect`, `gotoRoute`, `layoutAudit`, `trackRequests`, `apiUrls`, `REWIND_AT`, `isExempt`, `isLiveOnly` from `./helpers`. `npm run e2e` runs every spec in the G6 viewport matrix (360, 375, 390, 412, 768, 1280) against Vite on port 5199, proxied read-only to production; `npm run e2e -- --project=375x812 <file>` runs one. `web/e2e/shell.spec.ts` shows the patterns (layout audit scoped to a selector, the N3 request check, keys, palette).

## 9. Known interim details

- The fonts are self-hosted from the fontsource packages (latin woff2 only); `index.html` preloads Space Grotesk. In development the preload points at a path Vite does not serve, which only logs a preload warning; the production build rewrites it to the hashed file the CSS uses.
- `tokens.css` sets the dark block on `:root, :root[data-theme="dark"]`; with `data-theme="dark"` set, that selector would outrank the responsive token rules (header height, gutter, display size). The shell therefore leaves the attribute off for dark. Do not set `data-theme="dark"` anywhere.
