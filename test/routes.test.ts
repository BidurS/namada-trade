import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HonoRequest } from 'hono/request';
import { app } from '../worker/src/api';
import { CACHE_PARAMS, CACHEABLE_API, cacheKeyUrl, limiterFor, isHeavy, isReplay, rateLimited, edgeCacheOf, SEARCH_LIMIT_WORDS } from '../worker/src/http';
import { testD1 } from './d1-sqlite';
import {
  ROUTES, SITE, TABS, ROUTE_ALIASES, classifyPath, routeById, routeByPath, fullTitle, redirectLocation, legacyHashTarget,
} from '../shared/routes';
import { BODY, SITE as COPY_SITE, NOT_FOUND } from '../shared/copy';
import { sitemapXml, robotsTxt, pageHtml, notFoundHtml, jsonLd, llmsTxt } from '../worker/src/seo';

const SUFFIX = ' · NamadaTrade'.length;

/** Words that must not appear in visible copy (build brief, gate G5), outside the glossary and developer text. */
const BANNED = [/\bSQS\b/i, /\bIBC\b/i, /\bDEX\b/i, /\bPoS\b/i, /\bMASP\b/i, /\bABCI\b/i, /\bRPC\b/i, /\bcron\b/i, /\bwebhooks?\b/i, /\bnpm\b/i, /\bD[1-7]\b/, /Loading…/];

/** Every visible string this file set owns: route words, site words and the page copy. */
function visibleStrings(): [string, string][] {
  const out: [string, string][] = [];
  for (const r of ROUTES) for (const k of ['h1', 'title', 'description', 'label'] as const) out.push([`${r.id}.${k}`, r[k]]);
  for (const [k, v] of Object.entries(COPY_SITE)) if (k !== 'origin' && typeof v === 'string') out.push([`SITE.${k}`, v]);
  for (const [id, b] of Object.entries(BODY)) {
    b.paras.forEach((p, i) => out.push([`BODY.${id}.paras[${i}]`, p]));
    (b.sections ?? []).forEach((s, i) => {
      out.push([`BODY.${id}.sections[${i}].h2`, s.h2]);
      s.paras.forEach((p, j) => out.push([`BODY.${id}.sections[${i}].paras[${j}]`, p]));
    });
  }
  out.push(['NOT_FOUND.h1', NOT_FOUND.h1], ['NOT_FOUND.lead', NOT_FOUND.lead]);
  return out;
}

describe('search-facing route copy', () => {
  it('titles stay within 60 characters with the brand suffix; descriptions within 155', () => {
    for (const r of ROUTES) {
      const full = r.path === '/' ? `${SITE.name}: ${r.title}`.length : r.title.length + SUFFIX;
      expect(full, `title of ${r.path}: ${r.title}`).toBeLessThanOrEqual(60);
      expect(fullTitle(r).length, `full title of ${r.path}`).toBe(full);
      expect(r.title.length, `title of ${r.path} is at most 46`).toBeLessThanOrEqual(r.path === '/' ? 47 : 46);
      expect(r.description.length, `description of ${r.path}`).toBeLessThanOrEqual(155);
      expect(r.description.length, `description of ${r.path} says something`).toBeGreaterThan(60);
    }
    expect(SITE.description.length).toBeLessThanOrEqual(155);
  });

  it('every route has a distinct id, path, title, description and heading', () => {
    for (const k of ['id', 'path', 'title', 'description', 'h1'] as const) {
      const vals = ROUTES.map((r) => r[k]);
      expect(new Set(vals).size, `distinct ${k}`).toBe(vals.length);
    }
  });

  it('Home answers with the tagline, and the shared SITE is the copy file\'s', () => {
    expect(routeByPath('/')!.h1).toBe(SITE.tagline);
    expect(SITE).toBe(COPY_SITE);
    expect(SITE.disclaimer).toBe('NamadaTrade reports public on-chain and exchange data. It is not investment advice and is not affiliated with Namada or the Anoma Foundation.');
  });

  it('has the six tabs in order with keys 1 to 6; Holders lights Activity; the SEO pages are indexable', () => {
    expect(TABS.map((t) => t.label)).toEqual(['Home', 'Trade', 'Supply', 'Shielded', 'Activity', 'Alerts']);
    expect(TABS.map((t) => t.key)).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(TABS.map((t) => t.path)).toEqual(['/', '/trade', '/supply', '/shielded', '/activity', '/alerts']);
    expect(routeById('holders')).toMatchObject({ path: '/holders', tab: 'activity', index: true });
    expect(routeById('holders').key).toBeUndefined();
    for (const id of ['staking', 'osmosis', 'learn', 'faq'] as const) expect(routeById(id)).toMatchObject({ index: true });
    expect(routeById('learn').path).toBe('/learn/how-nam-trading-works');
    expect(routeById('settings').index).toBe(false);
  });

  it('the depth page (step S5): its own route lighting Trade, indexable, no key, aliased from /orderbook and /book; the footer links it between NAM on Osmosis and How NAM trading works', () => {
    const r = routeById('depth');
    expect(r).toMatchObject({ path: '/depth', id: 'depth', label: 'Depth', tab: 'trade', index: true, h1: 'What rests at every price for NAM?', title: 'NAM order book and depth on Osmosis' });
    expect(r.key).toBeUndefined();
    expect(r.description.length).toBeLessThan(155);
    expect(TABS.some((t) => t.id === 'depth' || t.path === '/depth')).toBe(false);
    for (const p of ['/orderbook', '/book', '/Orderbook/', '/BOOK']) expect(classifyPath(p), p).toEqual({ kind: 'redirect', to: '/depth' });
    expect(classifyPath('/depth')).toMatchObject({ kind: 'route', route: r });
    const footer = readFileSync(join(__dirname, '..', 'web', 'src', 'app', 'Footer.tsx'), 'utf8');
    const ids = /const LINK_IDS: RouteId\[\] = \[([^\]]+)\]/.exec(footer)![1].split(',').map((x) => x.trim().replace(/'/g, ''));
    expect(ids.indexOf('depth')).toBe(ids.indexOf('osmosis') + 1);
    expect(ids.indexOf('learn')).toBe(ids.indexOf('depth') + 1);
    // the page copy names the two quotable figures and the price, never typing one
    expect(BODY.depth.facts).toEqual(['depthSell', 'depthBid', 'price']);
    expect(BODY.depth.paras.join(' ')).not.toMatch(/\d/);
  });

  it('resolves every id, and the old UI\'s view ids, to a route', () => {
    for (const r of ROUTES) expect(routeById(r.id)).toBe(r);
    expect(routeById('pressure').path).toBe('/supply');
    expect(routeById('blind').path).toBe('/shielded');
    expect(routeById('tape').path).toBe('/activity');
  });

  it('every indexable route has page copy, and every page names its figures instead of typing them (N2)', () => {
    // a guide's text is in shared/guides.ts (test/guides.test.ts holds it to the same rules)
    for (const r of ROUTES.filter((x) => x.index && !x.guide)) {
      const b = BODY[r.id];
      expect(b, `BODY for ${r.id}`).toBeDefined();
      expect(b.paras.length, `lead for ${r.id}`).toBeGreaterThan(0);
    }
    for (const [where, s] of visibleStrings()) {
      // addresses and URLs are identifiers, not figures (the donation address and the repository link carry digits)
      if (where === 'SITE.donateShielded' || where === 'SITE.donateZcash' || where === 'SITE.repo') continue;
      if (where.startsWith('BODY.') || where.startsWith('SITE.') || where.startsWith('NOT_FOUND')) expect(s, where).not.toMatch(/\d/);
    }
  });

  it('the SEO pages have answer-first sections whose headings are questions', () => {
    for (const id of ['staking', 'osmosis', 'learn', 'faq']) {
      const secs = BODY[id].sections ?? [];
      expect(secs.length, `sections of ${id}`).toBeGreaterThanOrEqual(3);
      for (const s of secs) {
        expect(s.h2, `${id}: ${s.h2}`).toMatch(/\?$/);
        expect(s.paras[0].length, `${id}: first paragraph of "${s.h2}"`).toBeGreaterThan(40);
      }
    }
    expect(new Set(Object.values(BODY).flatMap((b) => (b.sections ?? []).map((s) => s.h2))).size).toBe(Object.values(BODY).flatMap((b) => b.sections ?? []).length);
  });

  it('no banned word appears in route words, site words or page copy (G5)', () => {
    for (const [where, s] of visibleStrings()) for (const re of BANNED) expect(s, `${where}: ${s}`).not.toMatch(re);
  });

  it('copy is sentence case: no Title Case Headings', () => {
    for (const [where, s] of visibleStrings()) {
      if (!/\.(h1|h2|title)$/.test(where)) continue;
      // after the first word, a capital starts only a proper noun or acronym from this list
      const words = s.replace(/[?:,.()]/g, ' ').split(/\s+/).filter(Boolean).slice(1);
      for (const w of words) if (/^[A-Z][a-z]/.test(w)) expect(['NAM', 'Namada', 'Osmosis', 'NamadaTrade', 'Trade', 'Discord', 'USDC', 'Anoma', 'Foundation'], `${where}: "${w}" in "${s}"`).toContain(w.replace(/'s$/, ''));
    }
  });
});

describe('what the Worker does with a path', () => {
  const act = (p: string) => classifyPath(p);

  it('serves real routes, including the new and the multi-segment ones', () => {
    for (const r of ROUTES) expect(act(r.path)).toMatchObject({ kind: 'route', route: r });
    for (const p of ['/supply', '/activity', '/holders', '/staking', '/osmosis', '/learn/how-nam-trading-works', '/faq']) expect(act(p), p).toMatchObject({ kind: 'route' });
  });

  it('301s trailing-slash and wrong-case forms to the canonical path', () => {
    expect(act('/trade/')).toEqual({ kind: 'redirect', to: '/trade' });
    expect(act('/Trade')).toEqual({ kind: 'redirect', to: '/trade' });
    expect(act('//trade')).toEqual({ kind: 'redirect', to: '/trade' });
    expect(act('/settings/')).toEqual({ kind: 'redirect', to: '/settings' });
    expect(act('/index.html')).toEqual({ kind: 'redirect', to: '/' });
    expect(act('/learn/how-nam-trading-works/')).toEqual({ kind: 'redirect', to: '/learn/how-nam-trading-works' });
    expect(act('/Learn/How-NAM-Trading-Works')).toEqual({ kind: 'redirect', to: '/learn/how-nam-trading-works' });
    // a real icon served by the static host (web/public/favicon.ico), never a redirect
    expect(act('/favicon.ico')).toEqual({ kind: 'not_found', asset: true });
  });

  it('301s every old path to its new home', () => {
    const want: Record<string, string> = {
      '/blind': '/shielded', '/blind-spot': '/shielded', '/overview': '/', '/integrity': '/', '/pools': '/trade',
      '/flows': '/activity', '/tape': '/activity', '/intel': '/supply', '/pressure': '/supply', '/learn': '/learn/how-nam-trading-works',
    };
    for (const [from, to] of Object.entries(want)) {
      expect(act(from), from).toEqual({ kind: 'redirect', to });
      expect(act(from + '/'), from + '/').toEqual({ kind: 'redirect', to });
      expect(act(from.toUpperCase()), from.toUpperCase()).toEqual({ kind: 'redirect', to });
    }
    // every alias lands on a real route, and no alias shadows a route
    for (const [seg, to] of Object.entries(ROUTE_ALIASES)) {
      expect(routeByPath(to), `alias ${seg} → ${to}`).toBeDefined();
      expect(routeByPath('/' + seg), `alias ${seg} is not itself a route`).toBeUndefined();
    }
  });

  it('keeps the query, so ?at= survives every redirect', () => {
    const go = (href: string) => {
      const a = classifyPath(new URL(href).pathname);
      return a.kind === 'redirect' ? redirectLocation(href, a.to) : null;
    };
    expect(go('https://namada.trade/pressure?at=1788116700000')).toBe('https://namada.trade/supply?at=1788116700000');
    expect(go('https://namada.trade/tape?at=1788116700000&chain=namada')).toBe('https://namada.trade/activity?at=1788116700000&chain=namada');
    expect(go('https://namada.trade/Trade/?at=1')).toBe('https://namada.trade/trade?at=1');
    expect(go('https://namada.trade/blind-spot?at=1788116700000')).toBe('https://namada.trade/shielded?at=1788116700000');
  });

  it('maps old hash links for the client router, keeping ?at=', () => {
    expect(legacyHashTarget('#/pressure?at=1788116700000')).toBe('/supply?at=1788116700000');
    expect(legacyHashTarget('#tape')).toBe('/activity');
    expect(legacyHashTarget('#/holders')).toBe('/holders');
    expect(legacyHashTarget('#/trade?at=5')).toBe('/trade?at=5');
    expect(legacyHashTarget('#/nothing-here')).toBeNull();
    expect(legacyHashTarget('#section-2')).toBeNull();
    expect(legacyHashTarget('')).toBeNull();
  });

  it('gives junk URLs a real 404, and says when it looks like a missing file', () => {
    for (const p of ['/does-not-exist', '/trade/extra', '/trade.html', '/ads.txt', '/llms.txt', '/sitemap_index.xml', '/.well-known/security.txt', '/assets/missing.js', '/learn/other', '/learn/how-nam-trading-works/extra']) {
      expect(act(p), p).toMatchObject({ kind: 'not_found' });
    }
    expect(act('/assets/missing.js')).toEqual({ kind: 'not_found', asset: true });
    expect(act('/does-not-exist')).toEqual({ kind: 'not_found', asset: false });
  });
});

describe('sitemap, robots and the server-rendered page', () => {
  it('the sitemap lists every indexable route once and nothing private', async () => {
    const xml = await (await sitemapXml(null)).text();
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    const want = ROUTES.filter((r) => r.index).map((r) => `${SITE.origin}${r.path === '/' ? '/' : r.path}`);
    expect(locs).toEqual(want);
    expect(locs).toContain('https://namada.trade/learn/how-nam-trading-works');
    expect(locs).toContain('https://namada.trade/holders');
    expect(xml).not.toContain('/settings');
  });

  it('robots points at the sitemap and blocks no page', async () => {
    const txt = await robotsTxt().text();
    expect(txt).toContain(`Sitemap: ${SITE.origin}/sitemap.xml`);
    const disallowed = [...txt.matchAll(/^Disallow: (.+)$/gm)].map((m) => m[1].trim());
    for (const r of ROUTES) for (const d of disallowed) expect(r.path.startsWith(d), `${d} blocks ${r.path}`).toBe(false);
  });

  it('renders the H1, the copy, the sections and the disclaimer on the black ground, with no figure when none is known', () => {
    for (const r of ROUTES.filter((x) => x.index && !x.guide)) {
      const html = pageHtml(r, null);
      const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;');
      expect(html.match(/<h1\b/g)?.length, `one h1 on ${r.path}`).toBe(1);
      expect(html).toContain(`>${esc(r.h1)}</h1>`);
      for (const p of BODY[r.id].paras) expect(html).toContain(esc(p));
      for (const s of BODY[r.id].sections ?? []) expect(html).toContain(`>${esc(s.h2)}</h2>`);
      expect(html).toContain(esc(SITE.disclaimer));
      expect(html).toContain('background:#000000');
      // every style attribute is whole (a double quote inside one would cut it short)
      for (const m of html.matchAll(/style="([^"]*)"/g)) expect(m[1], r.path).toMatch(/;?[a-z0-9%)'-]$/i);
      expect(html).not.toMatch(/font-family:"/);
      expect(html).not.toMatch(/<ul/); // no facts given → no list, never a placeholder figure
      for (const t of TABS) expect(html).toContain(`href="${t.path}"`);
    }
    const nf = notFoundHtml();
    expect(nf).toContain(NOT_FOUND.h1);
    expect(nf).toContain('background:#000000');
  });

  it('lists each figure once, with its source and time', () => {
    const f = { price: { text: 'NAM price: $0.001025', at: Date.UTC(2026, 9, 17, 11, 24), source: 'Osmosis router quote' }, depth: { text: 'Money in the Osmosis NAM pools: $1,819 across 4 pools', at: Date.UTC(2026, 9, 17, 11, 24), source: 'Osmosis router' } };
    const html = pageHtml(routeById('osmosis'), f);
    expect(html.split('NAM price: $0.001025').length - 1).toBe(1);
    expect(html.split('Money in the Osmosis NAM pools').length - 1).toBe(1);
    expect(html).toContain('(Osmosis router quote, 2026-10-17 11:24 UTC)');
  });

  it('the depth page’s server-rendered text carries the two quotable figures with the minute’s own time, and its data line is in llms.txt', async () => {
    const at = Date.UTC(2026, 9, 29, 2, 56);
    const f = {
      depthSell: { text: 'Selling 10,000 NAM now fetches $9.92 across every Osmosis pool', at, source: 'Osmosis chain' },
      depthBid: { text: '$26.88 of bids within 10% of the price', at, source: 'Osmosis chain' },
    };
    const html = pageHtml(routeById('depth'), f);
    expect(html).toContain('>What rests at every price for NAM?</h1>');
    expect(html.split('Selling 10,000 NAM now fetches $9.92').length - 1).toBe(1);
    expect(html.split('$26.88 of bids within 10% of the price').length - 1).toBe(1);
    expect(html).toContain('(Osmosis chain, 2026-10-29 02:56 UTC)');
    expect(pageHtml(routeById('depth'), null)).not.toMatch(/<ul/);
    const llms = await llmsTxt().text();
    expect(llms).toContain(`- [Depth](${SITE.origin}/depth): `);
    expect(llms).toContain(`- [Depth (JSON)](${SITE.origin}/api/depth): `);
    expect(llms).not.toMatch(/\$\d|\d+(\.\d+)? ?NAM\b/);
  });

  it('marks up the questions page as questions and answers', () => {
    const ld = jsonLd(routeById('faq'), null)!;
    const data = JSON.parse(ld.replace(/^<script[^>]*>|<\/script>$/g, ''));
    const faq = data.find((d: any) => d['@type'] === 'FAQPage');
    expect(faq.mainEntity.map((q: any) => q.name)).toEqual(BODY.faq.sections!.map((s) => s.h2));
    expect(jsonLd(routeById('home'), null)).not.toContain('FAQPage');
  });

  it('structured data is only what the page states: WebSite on the home page, crumbs elsewhere, FAQPage where questions are answered, Article on guides', () => {
    const parse = (id: string) => { const ld = jsonLd(routeById(id), null); return ld ? JSON.parse(ld.replace(/^<script[^>]*>|<\/script>$/g, '')) : []; };
    for (const r of ROUTES) {
      const types = parse(r.id).map((d: any) => d['@type']);
      // A software-app result needs a rating or review, which this site cannot honestly give.
      expect(types, r.path).not.toContain('WebApplication');
      expect(types.includes('WebSite'), r.path).toBe(r.id === 'home');
      expect(types.includes('BreadcrumbList'), r.path).toBe(r.id !== 'home');
      expect(types.includes('FAQPage'), r.path).toBe(r.id === 'faq' || !!r.guide);
      expect(types.includes('Article'), r.path).toBe(!!r.guide);
    }
    expect(parse('home')[0].url).toBe(`${SITE.origin}/`);
    expect(parse('home')[0].alternateName).toContain('Namada Trade');
    const trade = parse('trade');
    expect(trade.map((d: any) => d['@type'])).toEqual(['BreadcrumbList']);
    expect(trade[0].itemListElement.map((c: any) => c.item)).toEqual([`${SITE.origin}/`, `${SITE.origin}/trade`]);
  });

  it('robots.txt blocks no public read path the pages fetch (rules match by prefix: /api/me would block /api/metrics)', async () => {
    const txt = await robotsTxt().text();
    const disallowed = [...txt.matchAll(/^Disallow: (.+)$/gm)].map((m) => m[1].trim());
    const reads = ['/api/overview', '/api/metrics/history?key=price.usd&hours=720', '/api/pools', '/api/quote?amount=1000&side=sell', '/api/quote/curve',
      '/api/flows', '/api/holders', '/api/pressure', '/api/blindspot', '/api/alerts/recent', '/api/alerts/rules', '/api/intel', '/api/address/tnam1x',
      '/api/search?q=x', '/api/integrity', '/api/donation', '/api/series?key=price.usd&from=2026-10-01', '/api/series/changes', '/api/series/volume',
      '/api/series/pairs', '/api/series/trades?limit=60', '/api/series/values', '/api/depth', '/api/depth/quote?side=sell&nam=7300', '/api/depth/history', '/depth', '/activity', '/holders', '/holders?what=genesis'];
    for (const p of reads) for (const d of disallowed) expect(p.startsWith(d), `${d} blocks ${p}`).toBe(false);
    // the account endpoints stay out
    for (const p of ['/api/me/settings', '/api/me/sessions', '/api/auth/me', '/api/export/holders', '/api/labels']) expect(disallowed.some((d) => p.startsWith(d)), p).toBe(true);
    // the lists' numbered pages stay out (a wildcard rule: '*' matches any run of characters)
    const blocks = (p: string) => disallowed.some((d) => new RegExp('^' + d.replace(/[.?+^$()[\]{}|\\]/g, '\\$&').replace(/\*/g, '.*')).test(p));
    for (const p of ['/activity?page=2', '/holders?by=staked&page=40', '/activity?what=sell&page=3&cursor=x']) expect(blocks(p), p).toBe(true);
    for (const p of ['/activity', '/holders?what=genesis', '/trade']) expect(blocks(p), p).toBe(false);
  });
});

// ---------------------------------------------------------------- the edge cache keys and the limits (nav-search-plan.md 2.2, 4.5)
describe('every query parameter a cached list or search route reads is in its cache key', () => {
  const SRC = readFileSync(join(__dirname, '..', 'worker', 'src', 'api.ts'), 'utf8');
  const FQ = readFileSync(join(__dirname, '..', 'worker', 'src', 'flows-query.ts'), 'utf8');
  /** The names each helper that takes the request reads: `function x(c…)` and `const x = (c…) =>` bodies, to a fixed point. */
  const helperReads = () => {
    const out = new Map<string, Set<string>>();
    const re = /(?:function\s+(\w+)\s*\(c\b[^)]*\)|const\s+(\w+)\s*=\s*(?:async\s*)?\(c\b[^)]*\)\s*(?::[^=]+)?=>)/g;
    const starts = [...SRC.matchAll(re)].map((m) => ({ name: m[1] ?? m[2], at: m.index! }));
    for (const s of starts) {
      // the helper's text: to the next top-level statement (a line that starts with neither a space nor a brace)
      const rest = SRC.slice(s.at);
      const end = rest.slice(1).search(/\n(?![\s}])/);
      const body = end < 0 ? rest : rest.slice(0, end + 1);
      out.set(s.name, new Set([...body.matchAll(/c\.req\.query\('([A-Za-z]+)'\)/g)].map((m) => m[1])));
    }
    return out;
  };
  const flowKeys = [...FQ.matchAll(/\bq\('([A-Za-z]+)'\)/g)].map((m) => m[1]);

  it('read statically: the route body, the helpers it calls with the request, and the flow filter', () => {
    const helpers = helperReads();
    expect(flowKeys).toEqual(expect.arrayContaining(['since', 'addr', 'hash', 'height']));
    for (const route of ['/api/holders', '/api/flows', '/api/search', '/api/export/holders', '/api/export/flows']) {
      expect(CACHEABLE_API.test(route) || route.startsWith('/api/export/'), route).toBe(true);
      const at = SRC.indexOf(`app.get('${route}'`);
      expect(at, route).toBeGreaterThan(0);
      const rest = SRC.slice(at + 1);
      const end = rest.search(/\napp\.(get|post|put|delete|use)\(/);
      const body = end < 0 ? rest : rest.slice(0, end);
      const reads = new Set([...body.matchAll(/c\.req\.query\('([A-Za-z]+)'\)/g)].map((m) => m[1]));
      for (const [name, keys] of helpers) if (new RegExp(`\\b${name}\\(c\\b`).test(body)) for (const k of keys) reads.add(k);
      if (/flowsFilterFromQuery\(|flowsFilterError\(/.test(body)) for (const k of flowKeys) reads.add(k);
      for (const k of reads) expect(CACHE_PARAMS[route], `${route} reads ?${k}`).toContain(k);
    }
  });

  it('read at run time: every name a real request asks for is in the key', async () => {
    const db = testD1();
    const read = new Map<string, Set<string>>();
    let current = '';
    const orig = HonoRequest.prototype.query;
    HonoRequest.prototype.query = function (this: HonoRequest, key?: string) {
      if (typeof key === 'string') (read.get(current) ?? read.set(current, new Set()).get(current)!).add(key);
      return (orig as any).call(this, key);
    } as typeof orig;
    try {
      const urls = [
        '/api/holders?chain=namada', '/api/holders?chain=all&search=zond&min=1', '/api/holders?after=x&page=2&by=bonded&category=none&max=5',
        '/api/flows', '/api/flows?before=1790000000000&count=none', '/api/flows?hash=ABCDEF01&since=1790000000000', '/api/flows?addr=tnam1qxyzqxyz&height=5',
        '/api/search?q=zond&limit=3', '/api/search?q=tnam1qxyzqxyz', '/api/export/holders?min=1', '/api/export/flows?addr=tnam1qxyzqxyz',
      ];
      for (const u of urls) {
        current = new URL(`https://namada.trade${u}`).pathname;
        const res = await app.request(u, {}, { DB: db } as any);
        expect(res.status, u).toBeLessThan(500);
      }
    } finally {
      HonoRequest.prototype.query = orig;
    }
    for (const [route, keys] of read) for (const k of keys) expect(CACHE_PARAMS[route], `${route} reads ?${k} at run time`).toContain(k);
    expect([...read.get('/api/flows')!]).toEqual(expect.arrayContaining(['before', 'since', 'addr', 'hash', 'height', 'count']));
    expect([...read.get('/api/holders')!]).toEqual(expect.arrayContaining(['after', 'min', 'max', 'search']));
  });

  it('the key keeps the new parameters and drops anything else', () => {
    expect(cacheKeyUrl(new URL('https://namada.trade/api/search?q=zond&limit=6&r=1'))).toBe('https://namada.trade/api/search?limit=6&q=zond');
    expect(cacheKeyUrl(new URL('https://namada.trade/api/flows?before=abc&addr=tnam1qxyzqxyz&x=1'))).toBe('https://namada.trade/api/flows?addr=tnam1qxyzqxyz&before=abc');
    expect(cacheKeyUrl(new URL('https://namada.trade/api/holders?after=abc&min=5&max=9&y=2'))).toBe('https://namada.trade/api/holders?after=abc&max=9&min=5');
  });
});

describe('which limit a request is under, and its words', () => {
  const u = (p: string) => new URL(`https://namada.trade${p}`);
  it('searches (the search, the lists searched by text) are under the search limit; exports, address reports and quotes under the heavy one', () => {
    expect(limiterFor(u('/api/search?q=x'))).toBe('search');
    expect(limiterFor(u('/api/holders?search=zz'))).toBe('search');
    expect(limiterFor(u('/api/flows?search=zz'))).toBe('search');
    expect(limiterFor(u('/api/holders?chain=namada'))).toBeNull();
    expect(limiterFor(u('/api/flows?addr=tnam1qxyzqxyz'))).toBeNull();
    for (const p of ['/api/export/holders', '/api/export/flows', `/api/address/tnam1${'q'.repeat(40)}`, '/api/quote?amount=1&side=buy']) expect(limiterFor(u(p)), p).toBe('heavy');
    expect(limiterFor(u('/api/labels'), 'POST')).toBe('heavy');
    expect(limiterFor(u('/api/overview'))).toBeNull();
    expect(isHeavy(u('/api/search?q=x'))).toBe(true);
  });

  it('a search over the limit is told so in plain words; the search limiter is used when bound, the heavy one otherwise', async () => {
    const deny = () => ({ limit: vi.fn(async () => ({ success: false })) });
    const allow = () => ({ limit: vi.fn(async () => ({ success: true })) });
    const req = (p: string) => new Request(`https://namada.trade${p}`, { headers: { 'cf-connecting-ip': '1.2.3.4' } });
    const search = deny(), heavy = allow();
    const r = await rateLimited(req('/api/search?q=zond'), { SEARCH_LIMITER: search, HEAVY_LIMITER: heavy } as any);
    expect(r?.status).toBe(429);
    expect(await r!.json()).toEqual({ error: SEARCH_LIMIT_WORDS });
    expect(SEARCH_LIMIT_WORDS).toBe('Too many searches from your address; try again in a minute.');
    expect(search.limit).toHaveBeenCalledWith({ key: '1.2.3.4:/api/search' });
    expect(heavy.limit).not.toHaveBeenCalled();
    const onlyHeavy = deny();
    expect((await rateLimited(req('/api/holders?search=zz'), { HEAVY_LIMITER: onlyHeavy } as any))?.status).toBe(429);
    expect(await rateLimited(req('/api/export/holders'), { SEARCH_LIMITER: deny(), HEAVY_LIMITER: allow() } as any)).toBeNull();
  });

  it('a moves page behind a cursor or a date stays a minute at the edge; a head page 15 s; a cursor, a size or a date is a high-cardinality read', () => {
    expect(edgeCacheOf(u('/api/flows?before=abc'))).toMatch(/s-maxage=60/);
    expect(edgeCacheOf(u('/api/flows'))).toMatch(/s-maxage=15/);
    expect(edgeCacheOf(u('/api/search?q=x'))).toMatch(/s-maxage=15/);
    for (const p of ['/api/flows?before=abc', '/api/holders?after=abc', '/api/holders?min=5', '/api/flows?since=1']) expect(isReplay(u(p)), p).toBe(true);
    expect(isReplay(u('/api/search?q=zond'))).toBe(false);
    expect(CACHEABLE_API.test('/api/search')).toBe(true);
  });

  it('the series routes: 15 s at the edge; asked by day (as the Trade page asks) they are cache entries, a time to the millisecond, a tape cursor, a maker or a size is a high-cardinality read', () => {
    for (const p of ['/api/series', '/api/series/changes', '/api/series/volume', '/api/series/pairs', '/api/series/trades', '/api/series/values']) {
      expect(CACHEABLE_API.test(p), p).toBe(true);
      expect(edgeCacheOf(u(p))).toMatch(/s-maxage=15/);
    }
    // a `from` of one of the days the Trade page sends today (30, 90, 365 or 1,200 days back, or 14 for the daily bars)
    const sent = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    for (const p of [`/api/series?key=price.usd&from=${sent}&step=1h`, '/api/series?key=price.usd', '/api/series/trades?limit=60', '/api/series/changes', '/api/series/pairs']) expect(isReplay(u(p)), p).toBe(false);
    for (const p of ['/api/series?key=price.usd&from=1792500000000', `/api/series?key=price.usd&from=${sent}&to=1792500000000`, '/api/series?key=price.pool_1h&from=2020-01-01&step=1d', '/api/series/trades?before=abc', '/api/series/trades?limit=61',
      '/api/series/trades?maker=tnam1x', '/api/series/trades?min=5000', '/api/series/volume?at=1792500000000']) expect(isReplay(u(p)), p).toBe(true);
    // the cache key keeps every parameter the route reads, sorted, and nothing else
    expect(cacheKeyUrl(u('/api/series?step=1h&key=price.usd&r=1&from=2026-10-01'))).toBe('https://namada.trade/api/series?from=2026-10-01&key=price.usd&step=1h');
    expect(cacheKeyUrl(u('/api/series/trades?limit=60&maker=tnam1x&zz=9'))).toBe('https://namada.trade/api/series/trades?limit=60&maker=tnam1x');
  });
});
