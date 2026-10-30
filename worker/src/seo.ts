// Search-engine surface for a single-page app: per-route <title>/meta/canonical/Open Graph, a
// server-rendered page (heading, plain-language text, live figures each with its own source and time)
// inside #root until React mounts, JSON-LD, robots.txt, sitemap.xml and a real 404 for unknown paths.
// The words come from shared/copy.ts, the same source the React views render, so the text Google reads
// in the raw HTML is also the visible text. Nothing here invents numbers: every figure is read from the
// same metrics the API serves, carries the time it was recorded, and is left out when missing.
import type { Env } from './util';
import { ROUTES, TABS, EXPLAINER_ROUTES, GUIDE_ROUTES, classifyPath, routeByPath, fullTitle, type RouteDef } from '../../shared/routes';
import { SITE, BODY, NOT_FOUND, type FactKey, type PageCopy } from '../../shared/copy';
import { GUIDES } from '../../shared/guides';
import { citations, GUIDE_INDEPENDENCE, type GPara } from '../../shared/guide-types';
import { metricAt, cachedChainParams, coverageOf, unbondingWait } from './analytics';
import { holderFigureValues, listingTimes } from './holders';
import { KV_KEYS } from './depth/sql';
import { PRICED_KEY } from './pool-sizes';
import { NAM_DEPTH } from './depth/config';
import { DEPTH_OFFSETS_PCT, DEPTH_PLAIN_SOURCE, OFFSET_10_INDEX, bidQuotable, sellQuotable, type DepthResponse } from '../../shared/depth';
import { fmtNamRule, fmtPctRule, fmtUsdRule } from '../../shared/format';

export type { FactKey };
export { BODY };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const num = (n: number, d = 0) => n.toLocaleString('en-US', { maximumFractionDigits: d });
const utc = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const D = 86400000;

interface Fact { text: string; at: number; source: string }
type Facts = Partial<Record<FactKey, Fact>>;

/** The figures the server-rendered pages state, each with its source and time (cached 2 minutes at the edge). */
export async function facts(env: Env): Promise<Facts> {
  const cache = caches.default;
  const key = new Request(`${SITE.origin}/__seo/facts-v6`);
  const hit = await cache.match(key).catch(() => null);
  if (hit) return hit.json();
  const db = env.DB;
  const now = Date.now();
  const listed = await listingTimes(db);
  const [price, total, bonded, shielded, osmosis, liquidity, pools, priced, holderFig, vol, cov, params, depthLatest] = await Promise.all([
    // Staked: the chain's own total stake, not the staking account's balance (which also holds NAM on its way out).
    metricAt(db, 'price.usd', now), metricAt(db, 'supply.total', now), metricAt(db, 'supply.total_stake', now), metricAt(db, 'supply.masp_shielded', now),
    // The pools' money: each pool's coins at their own prices (pool-sizes.ts), and how many pools that total counts.
    metricAt(db, 'supply.osmosis', now), metricAt(db, 'dex.liquidity_usd', now), metricAt(db, 'dex.pool_count', now), metricAt(db, PRICED_KEY, now),
    // The holder figures the cron stores after each complete listing (holders.ts holderFigureValues; the queries only without them).
    holderFigureValues(db, now, listed).catch(() => null),
    db.prepare(`SELECT SUM(amount_num) nam, COUNT(*) n FROM flows WHERE chain='osmosis' AND kind IN ('buy','sell') AND ts >= ? AND ts < ?
                AND (meta IS NULL OR meta NOT LIKE '%"arb":true%')`).bind(now - D, now).first<{ nam: number | null; n: number }>().catch(() => null),
    coverageOf(db, now, false).catch(() => null),
    // The cached parameters only: a page never waits on the indexer (the cron refreshes them).
    cachedChainParams(db).catch(() => null),
    // The newest depth minute (kv depth.latest, written in the same batch as its depth_minute rows): the two quotable figures.
    db.prepare('SELECT value FROM kv WHERE key = ?1').bind(KV_KEYS.latest).first<{ value: string }>().then((r) => (r?.value ? (JSON.parse(r.value) as DepthResponse) : null)).catch(() => null),
  ]);
  const pct = (n: number) => (total ? `${((n / total.value) * 100).toFixed(1)}% of all NAM` : '');
  const f: Facts = {};
  if (price) f.price = { text: `NAM price: $${price.value.toFixed(6)}`, at: price.ts, source: 'Osmosis router quote' };
  if (total) f.supply = { text: `All NAM in existence: ${num(total.value)} NAM`, at: total.ts, source: 'Namada nodes' };
  if (bonded) f.staked = { text: `Staked with validators: ${num(bonded.value)} NAM${total ? `, ${pct(bonded.value)}` : ''}`, at: bonded.ts, source: 'Namada nodes' };
  if (shielded) f.shielded = { text: `In the shielded pool: ${num(shielded.value)} NAM${total ? `, ${pct(shielded.value)}` : ''}`, at: shielded.ts, source: 'Namada nodes' };
  if (osmosis) f.osmosis = { text: `Held on Osmosis (wallets and pools): ${num(osmosis.value)} NAM${total ? `, ${pct(osmosis.value)}` : ''}`, at: osmosis.ts, source: 'Osmosis bank' };
  // A total from the pools' reserves has its count stored beside it; one without (stored before) was the router's own.
  const sized = priced != null && priced.ts === liquidity?.ts;
  const across = !pools ? '' : sized && priced!.value < pools.value ? ` across ${num(priced!.value)} of ${num(pools.value)} pools (the others cannot be priced)` : ` across ${num(pools.value)} pools`;
  if (liquidity) f.depth = { text: `Money in the Osmosis NAM pools: $${num(liquidity.value)}${across}`, at: liquidity.ts, source: sized ? 'Osmosis pool reserves' : 'Osmosis router' };
  // Stamped with how current the Osmosis index is (the scanner's own time, not the newest trade), so a stalled
  // index shows as an old figure and a quiet market does not.
  const osmoAt = cov?.osmosis.at ?? null;
  if (vol && osmoAt != null) {
    const usd = price ? ` (about $${num((vol.nam ?? 0) * price.value)})` : '';
    f.volume = vol.n > 0
      ? { text: `Bought and sold on Osmosis in the last 24 hours: ${num(vol.nam ?? 0)} NAM${usd} in ${num(vol.n)} trades, bot round trips removed`, at: osmoAt, source: 'NamadaTrade flow index' }
      : { text: 'No NAM was bought or sold on Osmosis in the last 24 hours (bot round trips removed)', at: osmoAt, source: 'NamadaTrade flow index' };
  }
  // Holder facts carry the time their data was written or read, not the time of this request: for Namada the last
  // complete balance listing (every address compared then), else the newest row write.
  const counts = holderFig?.counts ?? null, top10 = holderFig?.top10Namada ?? null;
  const namadaAt = listed.balance ?? counts?.namada_at ?? null;

  const countsAt = namadaAt != null && counts?.osmosis_at != null ? Math.min(namadaAt, counts.osmosis_at) : null;
  if (counts?.namada != null && counts?.osmosis != null && countsAt != null) f.holders = { text: `Holders: ${num(counts.namada)} on Namada (spendable or staked NAM), ${num(counts.osmosis)} on Osmosis; protocol and pool accounts left out`, at: countsAt, source: 'NamadaTrade holder index' };
  if (top10?.s != null && top10.at != null && total) f.top10 = { text: `The 10 largest holders on Namada own ${((top10.s / total.value) * 100).toFixed(1)}% of all NAM (spendable and staked; protocol accounts left out)`, at: top10.at, source: 'NamadaTrade holder index' };
  const wait = unbondingWait(params);
  if (params && wait) {
    f.unbonding = { text: `Unstaking wait: about ${wait.days.toFixed(1)} days (${wait.epochs} epochs of about ${num(wait.epochSec / 3600, 1)} h, the epoch length measured on the chain; at least ${num((wait.epochs * params.minEpochSec) / 86400, 1)} days)`, at: params.fetchedAt, source: 'Namada chain parameters' };
  }
  // The depth page's two quotable figures (depth plan 3.1): selling the quoted size across every pool, and the USD of bids
  // within the quoted distance of the price, each from the newest stored minute with that minute's own time.
  if (depthLatest?.answer && depthLatest.within && Number.isFinite(depthLatest.at)) {
    const cfg = NAM_DEPTH;
    const i = depthLatest.answer.sizes.indexOf(cfg.quotableSize);
    const sell = i >= 0 ? depthLatest.answer.sell[i] : undefined;
    if (sell?.complete && Number.isFinite(sell.usd)) f.depthSell = { text: sellQuotable(fmtNamRule(cfg.quotableSize), cfg.base.symbol, fmtUsdRule(sell.usd)), at: depthLatest.at, source: DEPTH_PLAIN_SOURCE };
    if (Number.isFinite(depthLatest.within.bidUsd10)) f.depthBid = { text: bidQuotable(fmtUsdRule(depthLatest.within.bidUsd10), fmtPctRule(DEPTH_OFFSETS_PCT[OFFSET_10_INDEX], 0)), at: depthLatest.at, source: DEPTH_PLAIN_SOURCE };
  }
  if (params?.apr) f.apr = { text: `Staking rate reported by the network indexer: ${(params.apr * 100).toFixed(1)}% a year, before validator commission; it changes with the share staked and is not a promise`, at: params.fetchedAt, source: 'indexer.namada.net' };
  await cache.put(key, new Response(JSON.stringify(f), { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=120' } })).catch(() => {});
  return f;
}

// ---------------------------------------------------------------- the server-rendered page (black ground)

// Inline styles only: this HTML is shown before any stylesheet loads. Colours are the dark tokens
// (docs/design/tokens.css): --bg #000000, --ink #f5f5f5 (19.3:1), --ink-2 #a8a8a8 (8.8:1).
// Single quotes only: these sit inside style="…" attributes.
const FONT = `'Space Grotesk Variable','Space Grotesk',ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;
const MONO = `'JetBrains Mono',ui-monospace,'SF Mono',Menlo,Consolas,monospace`;
const S = {
  // padding (not margin) and a full-height box so the swap to the React app does not shift the page
  root: `box-sizing:border-box;min-height:100dvh;margin:0;padding:40px 16px 48px;background:#000000;color:#f5f5f5;font-family:${FONT}`,
  wrap: 'max-width:720px;margin:0 auto',
  h1: 'font-size:32px;line-height:1.1;font-weight:700;letter-spacing:-.015em;margin:0 0 16px',
  h2: 'font-size:24px;line-height:1.2;font-weight:600;letter-spacing:-.01em;margin:32px 0 8px',
  p: 'font-size:16px;line-height:1.55;margin:0 0 12px;color:#f5f5f5',
  ul: 'font-size:15px;line-height:1.6;padding-left:20px;margin:0 0 12px;color:#f5f5f5',
  li: 'margin:0 0 6px',
  stamp: `font-family:${MONO};font-size:12px;color:#a8a8a8`,
  nav: 'display:flex;flex-wrap:wrap;column-gap:20px;margin:24px 0 8px;font-size:15px',
  // 44 px targets: 16 px line + 2 × 14 px padding, at least 44 px wide
  a: 'color:#f5f5f5;text-decoration:underline;text-underline-offset:3px;display:inline-block;line-height:16px;padding:14px 0;min-width:44px',
  small: 'font-size:13px;line-height:1.5;color:#a8a8a8;margin:16px 0 0',
};

/**
 * The paper twin for <html data-theme="light"> (set before first paint by web/index.html), appended to <head>
 * so the server-rendered page matches the theme the app will mount in: --bg #f4f4f2, --ink #000, --ink-2 #4d4d4d.
 */
export const SSR_LIGHT_CSS = `<style>html[data-theme="light"] #ssr{background:#f4f4f2!important;color:#000!important}html[data-theme="light"] #ssr :is(h1,h2,p,ul,a){color:#000!important}html[data-theme="light"] #ssr .ssr-2{color:#4d4d4d!important}</style>`;

function factList(keys: FactKey[], f: Facts | null, shown: Set<FactKey>): string {
  const items = keys.filter((k) => !shown.has(k)).map((k) => [k, f?.[k]] as const).filter((x): x is readonly [FactKey, Fact] => !!x[1]);
  for (const [k] of items) shown.add(k);
  return items.length
    ? `<ul style="${S.ul}">${items.map(([, x]) => `<li style="${S.li}">${esc(x.text)} <small class="ssr-2" style="${S.stamp}">(${esc(x.source)}, ${utc(x.at)})</small></li>`).join('')}</ul>`
    : '';
}

const paras = (ps: string[]) => ps.map((p) => `<p style="${S.p}">${esc(p)}</p>`).join('\n');

function navHtml(): string {
  const links = [...TABS.map((t) => routeByPath(t.path)!), ...EXPLAINER_ROUTES.filter((r) => !TABS.some((t) => t.path === r.path))];
  return `<nav aria-label="Pages" style="${S.nav}">${links.map((x) => `<a href="${x.path}" style="${S.a}">${esc(x.label)}</a>`).join('')}</nav>`;
}

/** The text of a route as served before the app mounts: H1, lead, figures, sections, links, disclaimer. */
export function pageHtml(route: RouteDef, f: Facts | null): string {
  const body: PageCopy | undefined = BODY[route.id];
  const shown = new Set<FactKey>();
  const sections = route.id === 'guides'
    ? guideListHtml()
    : (body?.sections ?? []).map((s) => `<section><h2 style="${S.h2}">${esc(s.h2)}</h2>\n${paras(s.paras)}\n${factList(s.facts ?? [], f, shown)}</section>`).join('\n');
  return `<div id="ssr" style="${S.root}"><div style="${S.wrap}">
<h1 style="${S.h1}">${esc(route.h1)}</h1>
${paras(body?.paras ?? [route.description])}
${factList(body?.facts ?? [], f, shown)}
${sections}
${navHtml()}
<p class="ssr-2" style="${S.small}">${esc(SITE.disclaimer)}</p>
</div></div>`;
}

/** The guides' list: each guide's question as an H2 link with its description. */
function guideListHtml(): string {
  // the heading's own line height: S.a's fixed 16 px line would draw a wrapped 24 px heading over itself
  const a = 'color:#f5f5f5;text-decoration:underline;text-underline-offset:4px';
  return GUIDE_ROUTES.map((g) => `<section><h2 style="${S.h2}"><a href="${g.path}" style="${a}">${esc(g.h1)}</a></h2>\n<p style="${S.p}">${esc(g.description)}</p></section>`).join('\n');
}

const sup = 'font-size:12px;line-height:0;vertical-align:super;margin-left:2px';
const citeHtml = (p: GPara, num: Record<string, number>) => p.src.filter((id) => num[id] != null)
  .map((id) => `<a href="#src-${num[id]}" style="${sup};color:inherit">[${num[id]}]</a>`).join('');
const gparas = (ps: GPara[], num: Record<string, number>) => ps.map((p) => `<p style="${S.p}">${esc(p.t)}${citeHtml(p, num)}</p>`).join('\n');

/**
 * A guide as served before the app mounts: the date it was checked, the H1, the lead, each section with its
 * citations and links to the pages that show the live figures, the questions, the numbered sources, the
 * independence line, links and the disclaimer. The same text the guide screen renders.
 */
export function guideHtml(route: RouteDef): string {
  const g = route.guide ? GUIDES[route.guide] : undefined;
  if (!g) return pageHtml(route, null);
  const { list, num } = citations(g);
  const sections = g.sections.map((s) => `<section><h2 id="${s.id}" style="${S.h2}">${esc(s.h2)}</h2>
${gparas(s.paras, num)}
${s.see?.length ? `<p style="${S.p}">${s.see.map((x) => `<a href="${x.to}" style="${S.a}">${esc(x.label)}</a>`).join(' · ')}</p>` : ''}</section>`).join('\n');
  const faq = g.faq.map((q) => `<h3 style="${S.p};font-weight:600;margin-top:20px">${esc(q.q)}</h3>\n${gparas(q.a, num)}`).join('\n');
  const sources = list.map((x) => `<li id="src-${x.n}" style="${S.li}"><a href="${esc(x.source.url)}" rel="noopener" style="${S.a}">${esc(x.source.publisher)}: ${esc(x.source.title)}</a></li>`).join('');
  const related = g.related.map((p) => routeByPath(p)).filter((r): r is RouteDef => !!r);
  return `<div id="ssr" style="${S.root}"><div style="${S.wrap}">
<p class="ssr-2" style="${S.stamp}">Guide · checked against its sources on ${esc(route.updated ?? '')}</p>
<h1 style="${S.h1}">${esc(route.h1)}</h1>
${gparas(g.lead, num)}
${sections}
<section><h2 id="questions" style="${S.h2}">Questions</h2>
${faq}</section>
<section><h2 id="sources" style="${S.h2}">Sources</h2>
<ol style="${S.ul}">${sources}</ol></section>
<p class="ssr-2" style="${S.small}">${esc(GUIDE_INDEPENDENCE)}</p>
${related.length ? `<nav aria-label="Related" style="${S.nav}">${related.map((x) => `<a href="${x.path}" style="${S.a}">${esc(x.label)}</a>`).join('')}</nav>` : ''}
${navHtml()}
<p class="ssr-2" style="${S.small}">${esc(SITE.disclaimer)}</p>
</div></div>`;
}

export function notFoundHtml(): string {
  return `<div id="ssr" style="${S.root}"><div style="${S.wrap}">
<h1 style="${S.h1}">${esc(NOT_FOUND.h1)}</h1>
<p style="${S.p}">${esc(NOT_FOUND.lead)}</p>
${navHtml()}
<p class="ssr-2" style="${S.small}">${esc(SITE.disclaimer)}</p>
</div></div>`;
}

/** The canonical URL of a route. */
const canonicalOf = (r: RouteDef) => `${SITE.origin}${r.path === '/' ? '/' : r.path}`;

/** The crumbs from Home to a route: Home › (Guides ›) the page. */
function breadcrumbs(route: RouteDef): RouteDef[] {
  const home = ROUTES[0];
  if (route.path === '/') return [home];
  const hub = routeByPath('/guides');
  return route.guide && hub ? [home, hub, route] : [home, route];
}

/**
 * Structured data, only what the page states visibly: WebSite on the home page (its url the canonical '/'), a
 * BreadcrumbList on every other indexable page, FAQPage on the questions page and on each guide (the questions are
 * on the page), and Article on each guide, with the date its text was checked and the sources it cites. No
 * WebApplication: Google's software-app result needs a rating or review, which this site cannot honestly give.
 */
export function jsonLd(route: RouteDef, _f: Facts | null): string | null {
  const data: unknown[] = [];
  const org = { '@type': 'Organization', name: SITE.name, url: `${SITE.origin}/` };
  if (route.id === 'home') data.push({ '@context': 'https://schema.org', '@type': 'WebSite', name: SITE.name, alternateName: ['Namada Trade', 'namada.trade'], url: `${SITE.origin}/`, description: SITE.description, inLanguage: 'en' });
  else {
    data.push({
      '@context': 'https://schema.org', '@type': 'BreadcrumbList',
      itemListElement: breadcrumbs(route).map((r, i) => ({ '@type': 'ListItem', position: i + 1, name: r.label, item: canonicalOf(r) })),
    });
  }
  // The questions page states its questions and answers visibly (same copy), so they can be marked up as such.
  const sections = BODY[route.id]?.sections;
  if (route.id === 'faq' && sections?.length) {
    data.push({
      '@context': 'https://schema.org', '@type': 'FAQPage',
      mainEntity: sections.map((s) => ({ '@type': 'Question', name: s.h2, acceptedAnswer: { '@type': 'Answer', text: s.paras.join(' ') } })),
    });
  }
  const g = route.guide ? GUIDES[route.guide] : undefined;
  if (g) {
    data.push({
      '@context': 'https://schema.org', '@type': 'Article',
      headline: route.h1, description: route.description, inLanguage: 'en', url: canonicalOf(route), mainEntityOfPage: canonicalOf(route),
      datePublished: g.published, dateModified: route.updated, image: `${SITE.origin}/og.png`, author: org, publisher: org, isAccessibleForFree: true,
      citation: citations(g).list.map((x) => ({ '@type': 'CreativeWork', name: `${x.source.publisher}: ${x.source.title}`, url: x.source.url })),
    });
    if (g.faq.length) {
      data.push({
        '@context': 'https://schema.org', '@type': 'FAQPage',
        mainEntity: g.faq.map((q) => ({ '@type': 'Question', name: q.q, acceptedAnswer: { '@type': 'Answer', text: q.a.map((p) => p.t).join(' ') } })),
      });
    }
  }
  if (!data.length) return null;
  return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;
}

/**
 * Query parameters that only track a visit (the page is the same page). Any other parameter makes the URL a view of
 * a list (a search, a filter, a page number, a rewound time): crawlable, never indexed, canonical to the plain page.
 */
const TRACKING = /^(utm_[a-z_]+|gclid|fbclid|msclkid|mc_cid|mc_eid|ref)$/i;
export const isListView = (q: URLSearchParams): boolean => [...q.keys()].some((k) => !TRACKING.test(k));

/** Rewrite the SPA shell for a path. Unknown paths get status 404 and noindex; views of a list get noindex. */
export async function seoHtml(env: Env, req: Request, res: Response): Promise<Response> {
  const url = new URL(req.url);
  const found = routeByPath(url.pathname);
  const route = found ?? ROUTES[0];
  let f: Facts | null = null;
  // a guide and the guides' list state no figure, so they never wait on the database
  if (found && !found.updated) {
    try { f = await facts(env); } catch {}
  }

  const title = !found ? `Page not found · ${SITE.name}` : fullTitle(route);
  const canonical = canonicalOf(route);
  const indexable = !!found && route.index && !isListView(url.searchParams);
  const description = found ? route.description : SITE.description;
  const inner = !found ? notFoundHtml() : route.guide ? guideHtml(route) : route.index ? pageHtml(route, f) : null;
  const article = !!found && !!route.guide;
  const v = SITE.verify;
  const head = `
<meta name="description" content="${esc(description)}">
<meta name="robots" content="${indexable ? 'index,follow,max-image-preview:large' : !found ? 'noindex,nofollow' : 'noindex,follow'}">
${found ? `<link rel="canonical" href="${canonical}">` : ''}
<meta name="google-site-verification" content="${esc(v.google)}">
<meta name="msvalidate.01" content="${esc(v.bing)}">
<meta property="og:type" content="${article ? 'article' : 'website'}">
<meta property="og:site_name" content="${esc(SITE.name)}">
<meta property="og:locale" content="en_US">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
${found ? `<meta property="og:url" content="${canonical}">` : ''}
${article && route.updated ? `<meta property="article:modified_time" content="${esc(route.updated)}">` : ''}
<meta property="og:image" content="${SITE.origin}/og.png">
<meta property="og:image:alt" content="NamadaTrade: what moved, who moved it, and what it costs to trade NAM">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${SITE.origin}/og.png">
${inner ? SSR_LIGHT_CSS : ''}
${indexable ? jsonLd(route, f) ?? '' : ''}`;

  const out = new HTMLRewriter()
    .on('title', { element(e) { e.setInnerContent(title); } })
    .on('meta[name="description"]', { element(e) { e.remove(); } })
    .on('head', { element(e) { e.append(head, { html: true }); } })
    .on('#root', { element(e) { if (inner) e.setInnerContent(inner, { html: true }); } })
    .transform(res);
  const h = new Headers(out.headers);
  h.set('cache-control', 'public, max-age=0, must-revalidate');
  // the static shell's validators describe the shell, not this page with its figures of this minute
  h.delete('etag');
  h.delete('last-modified');
  if (!indexable) h.set('X-Robots-Tag', found ? 'noindex' : 'noindex, nofollow');
  return new Response(out.body, { status: found ? out.status : 404, headers: h });
}

export function robotsTxt(): Response {
  // The app's public read-only data endpoints stay crawlable so Google can render the page the way users see it;
  // account, export and operator endpoints do not. Rules match by prefix (RFC 9309), so '/api/me/' keeps its
  // slash: '/api/me' would also block '/api/metrics/history', the price chart's data. test/routes.test.ts checks
  // that no rule covers a public read path. The two lists' numbered pages are left out: each one a crawler opens
  // costs the server a walk to that page (the first page and the list itself stay crawlable).
  const body = `User-agent: *
Allow: /
Disallow: /activity?*page=
Disallow: /holders?*page=
Disallow: /api/me/
Disallow: /api/auth
Disallow: /api/export
Disallow: /api/labels
Disallow: /api/cron
Disallow: /api/webhooks

Sitemap: ${SITE.origin}/sitemap.xml
`;
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
}

/** A time as the sitemap writes it (W3C datetime, to the second, UTC). */
const w3c = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * The day or time a route's content last changed, or null when it is not known: a guide (and the guides' list) has
 * the day its text was checked; a page that states live figures changes with them, so its date is the time of the
 * newest figure it states (or of the facts its copy lists as `dated`: the depth page is dated by its stored minute, not
 * by the price it also quotes). With no figure read, the date is left out rather than guessed.
 */
export function lastmodOf(route: RouteDef, f: Facts | null): string | null {
  if (route.updated) return route.updated;
  const body = BODY[route.id];
  const keys = body?.dated ?? [...(body?.facts ?? []), ...(body?.sections ?? []).flatMap((s) => s.facts ?? [])];
  const times = keys.map((k) => f?.[k]?.at).filter((t): t is number => typeof t === 'number' && Number.isFinite(t));
  return times.length ? w3c(Math.max(...times)) : null;
}

/** Every indexable route, nothing else, each with the date its content last changed when that is known. */
export async function sitemapXml(env: Env | null): Promise<Response> {
  let f: Facts | null = null;
  if (env) {
    try { f = await facts(env); } catch {}
  }
  const urls = ROUTES.filter((r) => r.index).map((r) => {
    const mod = lastmodOf(r, f);
    return `  <url><loc>${canonicalOf(r)}</loc>${mod ? `<lastmod>${mod}</lastmod>` : ''}</url>`;
  });
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`, { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=600' } });
}

/**
 * /llms.txt (llmstxt.org): what the site is, in a few lines, and every indexable page with what it answers, so a
 * language model reading the site starts from the right page. No figure is typed: the pages state them.
 */
export function llmsTxt(): Response {
  const line = (r: RouteDef) => `- [${r.label}](${canonicalOf(r)}): ${r.description}`;
  const pages = ROUTES.filter((r) => r.index && !r.guide && r.id !== 'guides');
  const body = `# ${SITE.name}

> ${SITE.description} ${SITE.disclaimer}

Every figure on the pages below states its source and the time it was read; the sources are Namada nodes, indexer.namada.net and the Osmosis router. The guides explain Namada in plain words and cite Namada's own documentation for every claim. The site is read-only: it never trades or holds funds.

## Pages

${pages.map(line).join('\n')}

## Guides

- [Guides](${SITE.origin}/guides): every guide, with what it answers
${GUIDE_ROUTES.map(line).join('\n')}

## Data

- [Overview (JSON)](${SITE.origin}/api/overview): the figures behind the home page, each with its source and time
- [Depth (JSON)](${SITE.origin}/api/depth): every bid and ask for NAM on Osmosis as of the newest stored minute, with every read behind it

## Optional

- [Source code](${SITE.repo}): the site's code, MIT licence
`;
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
}

export { classifyPath };
