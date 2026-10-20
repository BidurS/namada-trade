// Search-engine surface for a single-page app: per-route <title>/meta/canonical/Open Graph, a
// server-rendered page (heading, plain-language text, live figures each with its own source and time)
// inside #root until React mounts, JSON-LD, robots.txt, sitemap.xml and a real 404 for unknown paths.
// The words come from shared/copy.ts, the same source the React views render, so the text Google reads
// in the raw HTML is also the visible text. Nothing here invents numbers: every figure is read from the
// same metrics the API serves, carries the time it was recorded, and is left out when missing.
import type { Env } from './util';
import { ROUTES, TABS, EXPLAINER_ROUTES, classifyPath, routeByPath, fullTitle, type RouteDef } from '../../shared/routes';
import { SITE, BODY, NOT_FOUND, type FactKey, type PageCopy } from '../../shared/copy';
import { metricAt, cachedChainParams, coverageOf, unbondingWait } from './analytics';
import { HOLDER_COUNTS_SQL, NAMADA_TOP10_SQL } from './holders';

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
  const key = new Request(`${SITE.origin}/__seo/facts-v4`);
  const hit = await cache.match(key).catch(() => null);
  if (hit) return hit.json();
  const db = env.DB;
  const now = Date.now();
  const [price, total, bonded, shielded, osmosis, liquidity, pools, counts, top10, vol, cov, params] = await Promise.all([
    // Staked: the chain's own total stake, not the staking account's balance (which also holds NAM on its way out).
    metricAt(db, 'price.usd', now), metricAt(db, 'supply.total', now), metricAt(db, 'supply.total_stake', now), metricAt(db, 'supply.masp_shielded', now),
    metricAt(db, 'supply.osmosis', now), metricAt(db, 'dex.liquidity_usd', now), metricAt(db, 'dex.pool_count', now),
    db.prepare(HOLDER_COUNTS_SQL).first<{ namada: number | null; osmosis: number | null; namada_at: number | null; osmosis_at: number | null }>().catch(() => null),
    db.prepare(NAMADA_TOP10_SQL).first<{ s: number | null; at: number | null }>().catch(() => null),
    db.prepare(`SELECT SUM(amount_num) nam, COUNT(*) n FROM flows WHERE chain='osmosis' AND kind IN ('buy','sell') AND ts >= ? AND ts < ?
                AND (meta IS NULL OR meta NOT LIKE '%"arb":true%')`).bind(now - D, now).first<{ nam: number | null; n: number }>().catch(() => null),
    coverageOf(db, now, false).catch(() => null),
    // The cached parameters only: a page never waits on the indexer (the cron refreshes them).
    cachedChainParams(db).catch(() => null),
  ]);
  const pct = (n: number) => (total ? `${((n / total.value) * 100).toFixed(1)}% of all NAM` : '');
  const f: Facts = {};
  if (price) f.price = { text: `NAM price: $${price.value.toFixed(6)}`, at: price.ts, source: 'Osmosis router quote' };
  if (total) f.supply = { text: `All NAM in existence: ${num(total.value)} NAM`, at: total.ts, source: 'Namada nodes' };
  if (bonded) f.staked = { text: `Staked with validators: ${num(bonded.value)} NAM${total ? `, ${pct(bonded.value)}` : ''}`, at: bonded.ts, source: 'Namada nodes' };
  if (shielded) f.shielded = { text: `In the shielded pool: ${num(shielded.value)} NAM${total ? `, ${pct(shielded.value)}` : ''}`, at: shielded.ts, source: 'Namada nodes' };
  if (osmosis) f.osmosis = { text: `Held on Osmosis (wallets and pools): ${num(osmosis.value)} NAM${total ? `, ${pct(osmosis.value)}` : ''}`, at: osmosis.ts, source: 'Osmosis bank' };
  if (liquidity) f.depth = { text: `Money in the Osmosis NAM pools: $${num(liquidity.value)}${pools ? ` across ${num(pools.value)} pools` : ''}`, at: liquidity.ts, source: 'Osmosis router' };
  // Stamped with how current the Osmosis index is (the scanner's own time, not the newest trade), so a stalled
  // index shows as an old figure and a quiet market does not.
  const osmoAt = cov?.osmosis.at ?? null;
  if (vol && osmoAt != null) {
    const usd = price ? ` (about $${num((vol.nam ?? 0) * price.value)})` : '';
    f.volume = vol.n > 0
      ? { text: `Bought and sold on Osmosis in the last 24 hours: ${num(vol.nam ?? 0)} NAM${usd} in ${num(vol.n)} trades, bot round trips removed`, at: osmoAt, source: 'NamadaTrade flow index' }
      : { text: 'No NAM was bought or sold on Osmosis in the last 24 hours (bot round trips removed)', at: osmoAt, source: 'NamadaTrade flow index' };
  }
  // Holder facts carry the time their data was written or read, not the time of this request.
  const countsAt = counts?.namada_at != null && counts?.osmosis_at != null ? Math.min(counts.namada_at, counts.osmosis_at) : null;
  if (counts?.namada != null && counts?.osmosis != null && countsAt != null) f.holders = { text: `Holders: ${num(counts.namada)} on Namada (spendable or staked NAM), ${num(counts.osmosis)} on Osmosis; protocol and pool accounts left out`, at: countsAt, source: 'NamadaTrade holder index' };
  if (top10?.s != null && top10.at != null && total) f.top10 = { text: `The 10 largest holders on Namada own ${((top10.s / total.value) * 100).toFixed(1)}% of all NAM (spendable and staked; protocol accounts left out)`, at: top10.at, source: 'NamadaTrade holder index' };
  const wait = unbondingWait(params);
  if (params && wait) {
    f.unbonding = { text: `Unstaking wait: about ${wait.days.toFixed(1)} days (${wait.epochs} epochs of about ${num(wait.epochSec / 3600, 1)} h, the epoch length measured on the chain; at least ${num((wait.epochs * params.minEpochSec) / 86400, 1)} days)`, at: params.fetchedAt, source: 'Namada chain parameters' };
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
  const sections = (body?.sections ?? []).map((s) => `<section><h2 style="${S.h2}">${esc(s.h2)}</h2>\n${paras(s.paras)}\n${factList(s.facts ?? [], f, shown)}</section>`).join('\n');
  return `<div id="ssr" style="${S.root}"><div style="${S.wrap}">
<h1 style="${S.h1}">${esc(route.h1)}</h1>
${paras(body?.paras ?? [route.description])}
${factList(body?.facts ?? [], f, shown)}
${sections}
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

/**
 * Structured data: WebSite on the home page only (its url the canonical '/'), FAQPage on the questions page. No
 * WebApplication: Google's software-app result needs a rating or review, which this site cannot honestly give.
 */
export function jsonLd(route: RouteDef, _f: Facts | null): string | null {
  const data: unknown[] = [];
  if (route.id === 'home') data.push({ '@context': 'https://schema.org', '@type': 'WebSite', name: SITE.name, url: `${SITE.origin}/`, description: SITE.description, inLanguage: 'en' });
  // The questions page states its questions and answers visibly (same copy), so they can be marked up as such.
  const sections = BODY[route.id]?.sections;
  if (route.id === 'faq' && sections?.length) {
    data.push({
      '@context': 'https://schema.org', '@type': 'FAQPage',
      mainEntity: sections.map((s) => ({ '@type': 'Question', name: s.h2, acceptedAnswer: { '@type': 'Answer', text: s.paras.join(' ') } })),
    });
  }
  if (!data.length) return null;
  return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;
}

/** Rewrite the SPA shell for a path. Unknown paths get status 404 and noindex. */
export async function seoHtml(env: Env, req: Request, res: Response): Promise<Response> {
  const url = new URL(req.url);
  const found = routeByPath(url.pathname);
  const route = found ?? ROUTES[0];
  let f: Facts | null = null;
  try { f = await facts(env); } catch {}

  const title = !found ? `Page not found · ${SITE.name}` : fullTitle(route);
  const canonical = `${SITE.origin}${route.path === '/' ? '/' : route.path}`;
  const indexable = !!found && route.index;
  const description = found ? route.description : SITE.description;
  const inner = !found ? notFoundHtml() : route.index ? pageHtml(route, f) : null;
  const head = `
<meta name="description" content="${esc(description)}">
<meta name="robots" content="${indexable ? 'index,follow,max-image-preview:large' : 'noindex,nofollow'}">
${found ? `<link rel="canonical" href="${canonical}">` : ''}
<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(SITE.name)}">
<meta property="og:locale" content="en_US">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
${found ? `<meta property="og:url" content="${canonical}">` : ''}
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
  return new Response(out.body, { status: found ? out.status : 404, headers: h });
}

export function robotsTxt(): Response {
  // The app's public read-only data endpoints stay crawlable so Google can render the page the way users see it;
  // account, export and operator endpoints do not. Rules match by prefix (RFC 9309), so '/api/me/' keeps its
  // slash: '/api/me' would also block '/api/metrics/history', the price chart's data. test/routes.test.ts checks
  // that no rule covers a public read path.
  const body = `User-agent: *
Allow: /
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

/** Every indexable route, nothing else. */
export function sitemapXml(): Response {
  const today = new Date().toISOString().slice(0, 10);
  const urls = ROUTES.filter((r) => r.index).map((r) => `  <url><loc>${SITE.origin}${r.path === '/' ? '/' : r.path}</loc><lastmod>${today}</lastmod></url>`);
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`, { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
}

export { classifyPath };
