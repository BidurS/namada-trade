import { describe, it, expect } from 'vitest';
import {
  ROUTES, SITE, TABS, ROUTE_ALIASES, classifyPath, routeById, routeByPath, fullTitle, redirectLocation, legacyHashTarget,
} from '../shared/routes';
import { BODY, SITE as COPY_SITE, NOT_FOUND } from '../shared/copy';
import { sitemapXml, robotsTxt, pageHtml, notFoundHtml, jsonLd } from '../worker/src/seo';

const SUFFIX = ' · NamadaTrade'.length;

/** Words that must not appear in visible copy (build brief, gate G5), outside the glossary and developer text. */
const BANNED = [/\bSQS\b/i, /\bIBC\b/i, /\bDEX\b/i, /\bPoS\b/i, /\bMASP\b/i, /\bABCI\b/i, /\bRPC\b/i, /\bcron\b/i, /\bwebhooks?\b/i, /\bnpm\b/i, /\bD[1-7]\b/, /Loading…/];

/** Every visible string this file set owns: route words, site words and the page copy. */
function visibleStrings(): [string, string][] {
  const out: [string, string][] = [];
  for (const r of ROUTES) for (const k of ['h1', 'title', 'description', 'label'] as const) out.push([`${r.id}.${k}`, r[k]]);
  for (const [k, v] of Object.entries(COPY_SITE)) if (k !== 'origin') out.push([`SITE.${k}`, v]);
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

  it('resolves every id, and the old UI\'s view ids, to a route', () => {
    for (const r of ROUTES) expect(routeById(r.id)).toBe(r);
    expect(routeById('pressure').path).toBe('/supply');
    expect(routeById('blind').path).toBe('/shielded');
    expect(routeById('tape').path).toBe('/activity');
  });

  it('every indexable route has page copy, and every page names its figures instead of typing them (N2)', () => {
    for (const r of ROUTES.filter((x) => x.index)) {
      const b = BODY[r.id];
      expect(b, `BODY for ${r.id}`).toBeDefined();
      expect(b.paras.length, `lead for ${r.id}`).toBeGreaterThan(0);
    }
    for (const [where, s] of visibleStrings()) {
      // addresses and URLs are identifiers, not figures (the donation address and the repository link carry digits)
      if (where === 'SITE.donateShielded' || where === 'SITE.repo') continue;
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
    expect(act('/favicon.ico')).toMatchObject({ kind: 'redirect' });
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
    const xml = await sitemapXml().text();
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
    for (const r of ROUTES.filter((x) => x.index)) {
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

  it('marks up the questions page as questions and answers', () => {
    const ld = jsonLd(routeById('faq'), null)!;
    const data = JSON.parse(ld.replace(/^<script[^>]*>|<\/script>$/g, ''));
    const faq = data.find((d: any) => d['@type'] === 'FAQPage');
    expect(faq.mainEntity.map((q: any) => q.name)).toEqual(BODY.faq.sections!.map((s) => s.h2));
    expect(jsonLd(routeById('home'), null)).not.toContain('FAQPage');
  });

  it('structured data is only what Google can accept honestly: WebSite on the home page, FAQPage on the questions page', () => {
    const parse = (id: string) => { const ld = jsonLd(routeById(id), null); return ld ? JSON.parse(ld.replace(/^<script[^>]*>|<\/script>$/g, '')) : []; };
    for (const r of ROUTES) {
      const types = parse(r.id).map((d: any) => d['@type']);
      // A software-app result needs a rating or review, which this site cannot honestly give.
      expect(types, r.path).not.toContain('WebApplication');
      expect(types.includes('WebSite'), r.path).toBe(r.id === 'home');
    }
    expect(parse('home')[0].url).toBe(`${SITE.origin}/`);
    expect(jsonLd(routeById('trade'), null)).toBeNull();
  });

  it('robots.txt blocks no public read path the pages fetch (rules match by prefix: /api/me would block /api/metrics)', async () => {
    const txt = await robotsTxt().text();
    const disallowed = [...txt.matchAll(/^Disallow: (.+)$/gm)].map((m) => m[1].trim());
    const reads = ['/api/overview', '/api/metrics/history?key=price.usd&hours=720', '/api/pools', '/api/quote?amount=1000&side=sell', '/api/quote/curve',
      '/api/flows', '/api/holders', '/api/pressure', '/api/blindspot', '/api/alerts/recent', '/api/alerts/rules', '/api/intel', '/api/address/tnam1x',
      '/api/search?q=x', '/api/integrity', '/api/donation'];
    for (const p of reads) for (const d of disallowed) expect(p.startsWith(d), `${d} blocks ${p}`).toBe(false);
    // the account endpoints stay out
    for (const p of ['/api/me/settings', '/api/me/sessions', '/api/auth/me', '/api/export/holders', '/api/labels']) expect(disallowed.some((d) => p.startsWith(d)), p).toBe(true);
  });
});
