# SEO requirements for the rebuild

Source: the Googlebot crawl of namada.trade on 2026-10-17 (4 lenses, 50 findings, 32 confirmed by an independent refute pass, 0 refuted). The Worker-side findings are already shipped (real 404s, slash/case 301s, robots, per-route server-rendered page, edge cache, immutable assets, staking rate). Everything below can only be fixed in the React app and is a **gate** for the redesign.

## Must

1. **A visible `<h1>` on every route, rendered by React.** Google indexes the rendered DOM, and today `createRoot` replaces `#ssr`, so the rendered page has no h1. One h1 per route, equal in meaning to `RouteDef.h1` in `shared/routes.ts`; the title and the h1 must not contradict.
2. **Primary navigation is real links.** `<a href="/trade">` with an onClick that calls `preventDefault` and navigates client-side. The desktop top bar, the phone bottom bar, the footer, and the Home explainer links all use anchors, so internal links survive hydration. Keep `Ctrl/Cmd-click` and middle-click working.
3. **The server-rendered text survives mount.** The paragraphs in `BODY` (worker/src/seo.ts) are the page's plain-language explanation; the redesigned views render the same sentences visibly (Home explainer, section intros), so what Google reads in the raw HTML is also in the rendered DOM. Keep `worker/src/seo.ts` `BODY` and the visible copy in one source (`shared/copy.ts`) rather than two.
4. **No layout shift on data arrival.** Every `Loading…` becomes a skeleton with the loaded height: fixed-height chart box, 6-8 fixed rows per table, min-heights on cards, a reserved slot for provenance chips, a fixed-width price slot in the header. Targets: CLS < 0.1 on every route (today 0.20-0.62 on mobile for the non-home routes).
5. **Unknown paths show a real not-found view** (the server already sends 404 + noindex). Do not rewrite unknown paths to `/trade`; use `replaceState`, never `pushState`, when normalising the URL.
6. **Lazy-load what is not on the landing route.** `React.lazy` for Settings, AddressModal, LoginModal, TrustPanel and the non-landing views; `import('qrcode')` on the pair click. Initial JS ≤ 130 KB gzip.
7. **Self-host fonts** (fontsource woff2: Space Grotesk 400-700 variable, JetBrains Mono 400/500, latin subset, `font-display: swap`, preload the one used above the fold). Remove the Google Fonts `<link>`s from `web/index.html`: they are render-blocking and make the "no third parties" privacy line false.
8. **Titles ≤ 60 characters with the brand suffix, descriptions ≤ 155**, distinct per route (enforced by `test/routes.test.ts`). When routes are renamed (Supply, Activity, Holders, etc.) update `shared/routes.ts`, keep the old paths as 301 aliases (`ROUTE_ALIASES`), and update `BODY`.
9. **Disclaimer and wording.** One sentence on every route (footer): "NamadaTrade reports public on-chain and exchange data. It is not investment advice and is not affiliated with Namada or the Anoma Foundation." Copy describes what happened ("NAM bridged to Osmosis that has not been sold or sent back"), never what to do.
10. **Provenance wording is accurate.** Each figure states its own source and time; "tradable on Osmosis" becomes "held on Osmosis (wallets and pools)" and the pool depth sits beside it.

## New pages (real text answers what people search)

Add to `ROUTES` with `index: true`, a distinct h1/title/description and a `BODY` entry; link from the footer and from the Home explainer; add to the sitemap automatically. Each states its figures with source and time, in plain language, and answers the question in the first sentence.

| path | h1 (question) | contains |
|---|---|---|
| `/staking` | How does staking NAM work, and what does it earn? | bonded amount and share of supply; the staking rate reported by the indexer with source and time and "not a promise"; the unstaking wait (about 13.75 days = 53 unbonding + 2 pipeline epochs of 6 h; reconcile with the "14 days" that guides quote, as 55 epochs × 6 h = 13.75 days); what unstaking, restaking and redelegating mean |
| `/holders` | Who holds NAM, and how concentrated is it? | holder counts (module accounts excluded), top-10 share, the top ten rows, what "shielded" means for attribution |
| `/shielded` (extend) | How much NAM is in the shielded pool? | what the pool is, the size and share, net moves, largest moves out |
| `/osmosis` | NAM on Osmosis: pools, liquidity and what a trade costs | pool count and depth, 24 h volume, why a small order moves the price, the quote tool |
| `/learn/how-nam-trading-works` | How does NAM get from a Namada wallet to a sale? | the four steps (staked, unlocked, bridged, sold), what to check before trading, glossary links |
| `/faq` | NAM questions, answered with sources | "Why is this price different from other sites?", "Why can't I see who holds shielded NAM?", "How old is this number?", what the data sources are, what this site does not do |

Search intents to cover: "NAM price", "Namada staking rewards", "Namada unbonding period", "Namada shielded pool", "how to buy NAM", "NAM Osmosis liquidity", "Namada holders". Write for the first sentence of each H2 to answer the query (featured-snippet shape).

## Owner steps (not code)

1. Google Search Console: add a **Domain** property for `namada.trade`; verify with the DNS TXT record Google gives (Cloudflare → DNS → Records → Add record: TXT, name `@`, content `google-site-verification=…`, keep it permanently); Sitemaps → submit `https://namada.trade/sitemap.xml`; URL Inspection → Request indexing for the indexable URLs once, then wait (do not resubmit the same URL repeatedly).
2. Bing Webmaster Tools: sign in, My Sites → Import from Google Search Console.
3. Ecosystem links: the namada.net ecosystem submission form (category Builders or Integrations), a PR to the Luminara-Hub ecosystem list, and a post in the forum category "Ecosystem & Strategy". Use `https://namada.trade/` and the one-line tagline. (The chain registry, Osmosis, DefiLlama and CoinGecko do not list tools of this kind.)
4. Cloudflare dashboard: SSL/TLS → Edge Certificates → Always Use HTTPS (belt and braces), Analytics & Logs → Web Analytics (turn off if "no analytics" must be literally true).
