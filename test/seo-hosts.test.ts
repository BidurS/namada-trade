// One canonical address, real 404s and nothing indexed that should not be (SEO pass, 2026-10-24): the Worker's
// fetch handler driven end to end with a stand-in static host and HTMLRewriter. Covers worker/src/hosts.ts (host
// and protocol redirects, the ownership files), worker/src/index.ts (404s, noindex headers, the API on old hosts)
// and worker/src/seo.ts (noindex on list views, the sitemap's dates, llms.txt, structured data on the page).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalRedirect, redirectStatus, ownershipFile, isClientPath } from '../worker/src/hosts';
import { ROUTES, GUIDE_ROUTES, SITE, classifyPath, legacyHashTarget, routeByPath } from '../shared/routes';
import { isListView, lastmodOf, guideHtml, jsonLd, facts } from '../worker/src/seo';
import { testD1, insert } from './d1-sqlite';
import { depthFixture } from './depth-fixtures';
import { BODY } from '../shared/copy';
import { sellQuotable, bidQuotable, type DepthResponse } from '../shared/depth';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
const worker = (await import('../worker/src/index')).default as ExportedHandler<any> & { fetch: (r: Request, e: any, c: any) => Promise<Response> };

const ROOT = join(__dirname, '..');
const SHELL = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
const ctx = { waitUntil() {}, passThroughOnException() {} };

// ---------------------------------------------------------------- stand-ins

/**
 * The four rewrites seo.ts asks of HTMLRewriter (title text, remove the description meta, append to <head>, fill
 * #root), applied to the text once the body is read. Enough to check what a crawler receives.
 */
class FakeRewriter {
  private ops: { sel: string; h: { element: (e: any) => void } }[] = [];
  on(sel: string, h: { element: (e: any) => void }) { this.ops.push({ sel, h }); return this; }
  transform(res: Response): Response {
    const ops = this.ops;
    const body = new ReadableStream({
      async start(c) {
        let html = await res.text();
        for (const { sel, h } of ops) {
          const act: { inner?: string; append?: string; remove?: boolean } = {};
          h.element({ setInnerContent: (s: string) => { act.inner = s; }, append: (s: string) => { act.append = s; }, remove: () => { act.remove = true; } });
          if (sel === 'title' && act.inner != null) html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${act.inner}</title>`);
          if (sel === 'meta[name="description"]' && act.remove) html = html.replace(/<meta name="description"[^>]*>/, '');
          if (sel === 'head' && act.append != null) html = html.replace('</head>', `${act.append}</head>`);
          if (sel === '#root' && act.inner != null) html = html.replace('<div id="root"></div>', `<div id="root">${act.inner}</div>`);
        }
        c.enqueue(new TextEncoder().encode(html));
        c.close();
      },
    });
    return new Response(body, { status: res.status, headers: res.headers });
  }
}

/**
 * The static host as production answers (curl, 2026-10-24): known files as they are, everything else the app shell
 * (SPA fallback), one ETag per file with a 304 on a matching If-None-Match, a 307 from its html handling for /index,
 * and 405 for any method but GET and HEAD.
 */
const FILES: Record<string, [string, string]> = {
  '/favicon.ico': ['image/x-icon', 'ico'],
  '/og.png': ['image/png', 'png'],
  '/assets/index-abc.js': ['text/javascript', 'js'],
};
const ETAG = '"shell-etag"';
const ASSETS = {
  fetch: async (req: Request) => {
    const u = new URL(req.url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response(null, { status: 405 });
    if (u.pathname === '/index') return new Response(null, { status: 307, headers: { location: '/' } });
    const f = FILES[u.pathname];
    const h = { 'content-type': f ? f[0] : 'text/html', etag: ETAG };
    if (req.headers.get('if-none-match') === ETAG) return new Response(null, { status: 304, headers: h });
    return new Response(f ? f[1] : SHELL, { headers: h });
  },
};

let cached: Record<string, unknown> | null = null;
beforeEach(() => {
  cached = null;
  vi.stubGlobal('HTMLRewriter', FakeRewriter);
  // the facts cache: a stored copy when a test sets one, else a miss (and then no database: no figures)
  vi.stubGlobal('caches', { default: { match: async () => (cached ? new Response(JSON.stringify(cached)) : undefined), put: async () => {} } });
});

const env = () => ({ ASSETS });
const get = (url: string, init: RequestInit = {}) => worker.fetch(new Request(url, init), env(), ctx);

// ---------------------------------------------------------------- hosts

describe('one canonical address', () => {
  const u = (s: string) => new URL(s);

  it('www and the workers.dev origin send every page to https://namada.trade, path and query kept', () => {
    expect(canonicalRedirect(u('https://www.namada.trade/'), false)).toBe('https://namada.trade/');
    expect(canonicalRedirect(u('https://www.namada.trade/trade?at=1788116700000&x=1'), false)).toBe('https://namada.trade/trade?at=1788116700000&x=1');
    expect(canonicalRedirect(u('http://www.namada.trade/holders'), true)).toBe('https://namada.trade/holders');
    expect(canonicalRedirect(u('https://namada-trade.example-account.workers.dev/staking'), false)).toBe('https://namada.trade/staking');
    expect(canonicalRedirect(u('https://www.namada.trade:8443/faq'), false)).toBe('https://namada.trade/faq');
    expect(canonicalRedirect(u('https://www.namada.trade/robots.txt'), false)).toBe('https://namada.trade/robots.txt');
  });

  it('plain http on namada.trade goes to https, but only when Cloudflare\'s edge saw http (local dev never redirects)', () => {
    expect(canonicalRedirect(u('http://namada.trade/trade?q=1'), true)).toBe('https://namada.trade/trade?q=1');
    expect(canonicalRedirect(u('http://namada.trade/api/overview'), true)).toBe('https://namada.trade/api/overview');
    expect(canonicalRedirect(u('http://namada.trade/'), false)).toBeNull();
    expect(canonicalRedirect(u('https://namada.trade/trade'), false)).toBeNull();
  });

  it('the API and the live socket stay where outside clients call them', () => {
    for (const p of ['/api/overview', '/api/flows?addr=tnam1x', '/api/auth/nonce', '/ws']) {
      expect(canonicalRedirect(u(`https://www.namada.trade${p}`), false), p).toBeNull();
      expect(canonicalRedirect(u(`https://namada-trade.example-account.workers.dev${p}`), false), p).toBeNull();
    }
    // only the real prefixes count as the API
    expect(isClientPath('/api')).toBe(false);
    expect(isClientPath('/apix')).toBe(false);
    expect(isClientPath('/wss')).toBe(false);
    expect(canonicalRedirect(u('https://www.namada.trade/api'), false)).toBe('https://namada.trade/api');
  });

  it('version previews, local hosts and other hosts are answered where they are', () => {
    for (const h of ['https://0a1b2c3d-namada-trade.example-account.workers.dev/trade', 'http://localhost:8787/trade', 'http://127.0.0.1:8787/', 'https://other-worker.example-account.workers.dev/']) {
      expect(canonicalRedirect(u(h), false), h).toBeNull();
    }
  });

  it('a redirect can never leave namada.trade, whatever the path', () => {
    for (const p of ['//evil.example/x', '/\\evil.example', '/%2F%2Fevil.example', '/@evil.example', '/..//evil.example']) {
      const to = canonicalRedirect(u(`https://www.namada.trade${p}`), false)!;
      expect(new URL(to).host, p).toBe('namada.trade');
      expect(new URL(to).protocol).toBe('https:');
    }
  });

  it('reads move with 301; anything else with 308, so a body is never turned into a GET', () => {
    expect(redirectStatus('GET')).toBe(301);
    expect(redirectStatus('HEAD')).toBe(301);
    for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) expect(redirectStatus(m)).toBe(308);
  });

  it('through the Worker: www pages are 301s, www API answers in place with noindex', async () => {
    const r = await get('https://www.namada.trade/trade?at=5');
    expect(r.status).toBe(301);
    expect(r.headers.get('location')).toBe('https://namada.trade/trade?at=5');
    const post = await get('https://www.namada.trade/settings', { method: 'POST', body: 'x' });
    expect(post.status).toBe(308);
    const api = await get('https://www.namada.trade/api/no-such-thing');
    expect(api.status).not.toBe(301);
    expect(api.status).not.toBe(308);
    expect(api.headers.get('x-robots-tag')).toBe('noindex');
    const httpPage = await get('http://namada.trade/faq', { headers: { 'cf-visitor': '{"scheme":"http"}' } });
    expect(httpPage.status).toBe(301);
    expect(httpPage.headers.get('location')).toBe('https://namada.trade/faq');
  });
});

// ---------------------------------------------------------------- ownership files

describe('the search engines\' ownership files', () => {
  const v = SITE.verify;

  it('answer byte for byte at their exact path, before any lowercase, redirect or 404 rule', async () => {
    const g = await get(`https://namada.trade/${v.googleFile}`);
    expect(g.status).toBe(200);
    expect(g.headers.get('content-type')).toContain('text/html');
    expect(await g.text()).toBe(`google-site-verification: ${v.googleFile}`);
    const b = await get('https://namada.trade/BingSiteAuth.xml');
    expect(b.status).toBe(200);
    expect(b.headers.get('content-type')).toContain('xml');
    expect(await b.text()).toContain(`<user>${v.bing}</user>`);
    expect(b.headers.get('x-robots-tag')).toBeNull();
  });

  it('no other spelling is answered as one, and the router never rewrites them', () => {
    for (const p of ['/bingsiteauth.xml', '/BINGSITEAUTH.XML', `/${v.googleFile.toUpperCase()}`, `/${v.googleFile.replace('.html', '')}`, `/${v.googleFile}/`]) expect(ownershipFile(p), p).toBeNull();
    for (const p of [`/${v.googleFile}`, '/BingSiteAuth.xml']) expect(classifyPath(p).kind, p).not.toBe('redirect');
  });

  it('every page also carries both tokens as meta tags (the fallback method)', async () => {
    const html = await (await get('https://namada.trade/')).text();
    expect(html).toContain(`<meta name="google-site-verification" content="${v.google}">`);
    expect(html).toContain(`<meta name="msvalidate.01" content="${v.bing}">`);
  });
});

// ---------------------------------------------------------------- 404s and noindex

describe('a path that is not a page is a 404 with noindex, never a copy of the app', () => {
  it('file-like and probe paths are plain-text 404s', async () => {
    for (const p of ['/wp-login.php', '/xmlrpc.php', '/.env', '/wp-admin/install.php', '/config.json', '/assets/missing.js', '/sitemap_index.xml', '/ads.txt', '/trade.html', '/.git/config']) {
      const r = await get(`https://namada.trade${p}`);
      expect(r.status, p).toBe(404);
      expect(r.headers.get('content-type'), p).toContain('text/plain');
      expect(r.headers.get('x-robots-tag'), p).toBe('noindex');
      expect(await r.text(), p).not.toContain('<div id="root">');
    }
  });

  it('unknown page paths are the 404 view with noindex in the header and the page', async () => {
    for (const p of ['/admin', '/no-such-page', '/trade/extra', '/guides/no-such-guide', '/learn/other', '/__ui', '/trade;jsessionid=1', '/%74rade']) {
      const r = await get(`https://namada.trade${p}`);
      expect(r.status, p).toBe(404);
      expect(r.headers.get('x-robots-tag'), p).toMatch(/noindex/);
      const html = await r.text();
      expect(html, p).toContain('<meta name="robots" content="noindex,nofollow">');
      expect(html, p).not.toContain('rel="canonical"');
    }
  });

  it('a real page is indexable: 200, no noindex, its canonical, its own title and description', async () => {
    for (const r of ROUTES.filter((x) => x.index)) {
      const res = await get(`https://namada.trade${r.path}`);
      expect(res.status, r.path).toBe(200);
      expect(res.headers.get('x-robots-tag'), r.path).toBeNull();
      const html = await res.text();
      expect(html, r.path).toContain('<meta name="robots" content="index,follow,max-image-preview:large">');
      expect(html, r.path).toContain(`<link rel="canonical" href="${SITE.origin}${r.path}">`);
      expect(html.match(/<meta name="description"/g)?.length, r.path).toBe(1);
      expect(html, r.path).toContain('<meta property="og:title"');
      expect(html, r.path).toContain('application/ld+json');
      expect(html.match(/<h1\b/g)?.length, r.path).toBe(1);
    }
  });

  it('search results, filters, page numbers and rewound views are crawlable but not indexed, canonical to the plain page', async () => {
    for (const p of ['/activity?q=anoma', '/holders?what=genesis', '/holders?page=2', '/activity?cursor=abc', '/trade?at=1788116700000', '/activity?addr=tnam1x', '/?q=1']) {
      const res = await get(`https://namada.trade${p}`);
      expect(res.status, p).toBe(200);
      expect(res.headers.get('x-robots-tag'), p).toBe('noindex');
      const html = await res.text();
      expect(html, p).toContain('<meta name="robots" content="noindex,follow">');
      expect(html, p).toContain(`<link rel="canonical" href="${SITE.origin}${new URL(p, SITE.origin).pathname}">`);
      expect(html, p).not.toContain('application/ld+json');
    }
    // tracking parameters do not make another page
    expect(isListView(new URLSearchParams('utm_source=x&utm_medium=y&gclid=1&fbclid=2&ref=z'))).toBe(false);
    expect(isListView(new URLSearchParams('q=x&utm_source=y'))).toBe(true);
    const tracked = await get('https://namada.trade/trade?utm_source=newsletter');
    expect(tracked.headers.get('x-robots-tag')).toBeNull();
  });

  it('the private page is noindex', async () => {
    const res = await get('https://namada.trade/settings');
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    expect(await res.text()).toContain('<meta name="robots" content="noindex,follow">');
  });

  it('the API is never a search result; a static file is served as it is', async () => {
    const api = await get('https://namada.trade/api/no-such-thing');
    expect(api.headers.get('x-robots-tag')).toBe('noindex');
    const ico = await get('https://namada.trade/favicon.ico');
    expect(ico.status).toBe(200);
    expect(ico.headers.get('content-type')).toBe('image/x-icon');
    expect(ico.headers.get('location')).toBeNull();
  });

  it('a version preview is answered with noindex', async () => {
    const res = await get('https://0a1b2c3d-namada-trade.example-account.workers.dev/trade');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
  });

  it('wrong-case and slashed paths still 301 to the canonical page (POST keeps its method)', async () => {
    const r = await get('https://namada.trade/Guides/What-Is-Namada/');
    expect(r.status).toBe(301);
    expect(r.headers.get('location')).toBe('https://namada.trade/guides/what-is-namada');
    expect((await get('https://namada.trade/Trade', { method: 'POST', body: 'x' })).status).toBe(308);
  });
});

// ---------------------------------------------------------------- sitemap, robots, llms.txt, favicon

describe('the files crawlers read', () => {
  it('robots.txt points at the sitemap and the sitemap lists every indexable page once, guides with their date', async () => {
    const robots = await (await get('https://namada.trade/robots.txt')).text();
    expect(robots).toContain(`Sitemap: ${SITE.origin}/sitemap.xml`);
    const xml = await (await get('https://namada.trade/sitemap.xml')).text();
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(locs).toEqual(ROUTES.filter((r) => r.index).map((r) => `${SITE.origin}${r.path}`));
    for (const g of GUIDE_ROUTES) expect(xml).toContain(`<loc>${SITE.origin}${g.path}</loc><lastmod>${g.updated}</lastmod>`);
    // no figure read: a live page's date is left out, never guessed
    expect(xml).toContain(`<loc>${SITE.origin}/trade</loc></url>`);
    expect(xml).not.toContain('/settings');
  });

  it('a live page\'s date is the time of the newest figure it states', async () => {
    const t1 = Date.UTC(2026, 9, 24, 2, 44, 10), t2 = Date.UTC(2026, 9, 24, 2, 40);
    cached = { price: { text: 'p', at: t1, source: 's' }, supply: { text: 's', at: t2, source: 's' } };
    const xml = await (await worker.fetch(new Request('https://namada.trade/sitemap.xml'), { ASSETS, DB: {} }, ctx)).text();
    expect(xml).toContain(`<loc>${SITE.origin}/</loc><lastmod>2026-10-24T02:44:10Z</lastmod>`);
    expect(lastmodOf(ROUTES.find((r) => r.id === 'faq')!, null)).toBeNull();
  });

  it('the depth page’s date is its newest stored minute (the depth facts carry the minute’s own time), and /orderbook and /book 301 to it', async () => {
    const t = Date.UTC(2026, 9, 29, 2, 56);
    cached = { depthSell: { text: 's', at: t, source: 'Osmosis chain' }, depthBid: { text: 'b', at: t - 1, source: 'Osmosis chain' } };
    const xml = await (await worker.fetch(new Request('https://namada.trade/sitemap.xml'), { ASSETS, DB: {} }, ctx)).text();
    expect(xml).toContain(`<loc>${SITE.origin}/depth</loc><lastmod>2026-10-29T02:56:00Z</lastmod>`);
    for (const p of ['/orderbook', '/book', '/Book/']) {
      const r = await get(`https://namada.trade${p}?at=5`);
      expect([r.status, r.headers.get('location')], p).toEqual([301, 'https://namada.trade/depth?at=5']);
    }
    const page = await get('https://namada.trade/depth');
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('<title>NAM order book and depth on Osmosis · NamadaTrade</title>');
    expect(html).toContain('<h1 style="');
    expect(html).toContain('What rests at every price for NAM?');
  });

  it('the depth page’s date stays its stored minute when the price it also quotes is newer (the copy lists the dated facts); the page itself still states the price', async () => {
    const t = Date.UTC(2026, 9, 29, 2, 56);
    cached = { depthSell: { text: 's', at: t, source: 'Osmosis chain' }, depthBid: { text: 'b', at: t - 1, source: 'Osmosis chain' }, price: { text: 'NAM price: $0.001020', at: t + 40 * 60_000, source: 'Osmosis router quote' } };
    expect(BODY.depth.dated).toEqual(['depthSell', 'depthBid']);
    expect(BODY.depth.facts).toContain('price');
    const xml = await (await worker.fetch(new Request('https://namada.trade/sitemap.xml'), { ASSETS, DB: {} }, ctx)).text();
    expect(xml).toContain(`<loc>${SITE.origin}/depth</loc><lastmod>2026-10-29T02:56:00Z</lastmod>`);
    // Home is dated by every fact it states, the price among them
    expect(xml).toContain(`<loc>${SITE.origin}/</loc><lastmod>2026-10-29T03:36:00Z</lastmod>`);
    const html = await (await get('https://namada.trade/depth')).text();
    expect(html).toContain('NAM price: $0.001020');
  });

  it('the two depth facts come from kv depth.latest itself: the fixture minute’s own figures, with its own time, reach the facts, the page and the sitemap', async () => {
    const db = testD1();
    const latest = depthFixture<DepthResponse>('api_depth_latest.json');
    insert(db, 'kv', [{ key: 'depth.latest', value: JSON.stringify(latest), updated_at: latest.at }]);
    const f = await facts({ DB: db } as any);
    expect(f.depthSell).toEqual({ text: sellQuotable('10,000', 'NAM', '$9.92'), at: latest.at, source: 'Osmosis chain' });
    expect(f.depthBid).toEqual({ text: bidQuotable('$26.88', '10%'), at: latest.at, source: 'Osmosis chain' });
    expect(latest.within.bidUsd10).toBeCloseTo(26.88, 2);
    expect(f.depthSell!.text).toBe('Selling 10,000 NAM now fetches $9.92 across every Osmosis pool');
    expect(f.price).toBeUndefined(); // no metric row: the price is left out, never a stand-in
    const xml = await (await worker.fetch(new Request('https://namada.trade/sitemap.xml'), { ASSETS, DB: db }, ctx)).text();
    expect(xml).toContain(`<loc>${SITE.origin}/depth</loc><lastmod>${new Date(latest.at).toISOString().replace(/\.\d{3}Z$/, 'Z')}</lastmod>`);
    const html = await (await worker.fetch(new Request('https://namada.trade/depth'), { ASSETS, DB: db }, ctx)).text();
    expect(html).toContain('fetches $9.92 across every Osmosis pool');
    // an unreadable row gives no depth fact
    const empty = await facts({ DB: testD1() } as any);
    expect(empty.depthSell).toBeUndefined();
    expect(empty.depthBid).toBeUndefined();
  });

  it('llms.txt names the site, says what it is not, and links every indexable page and guide', async () => {
    const res = await get('https://namada.trade/llms.txt');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const txt = await res.text();
    expect(txt.startsWith(`# ${SITE.name}\n`)).toBe(true);
    expect(txt).toContain(SITE.disclaimer);
    for (const r of ROUTES.filter((x) => x.index)) expect(txt, r.path).toContain(`](${SITE.origin}${r.path})`);
    expect(txt).toContain(`](${SITE.origin}/api/depth)`);
    expect(txt).not.toMatch(/\$\d|\d+(\.\d+)? ?NAM\b/); // no figure typed
  });

  it('favicon.ico is a real icon with a 48 px image, and the shell links it', () => {
    const ico = readFileSync(join(ROOT, 'web', 'public', 'favicon.ico'));
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    const n = ico.readUInt16LE(4);
    const sizes = Array.from({ length: n }, (_, i) => ico[6 + i * 16] || 256);
    expect(sizes).toEqual(expect.arrayContaining([16, 32, 48]));
    expect(SHELL).toContain('href="/favicon.ico"');
    expect(classifyPath('/favicon.ico').kind).not.toBe('redirect');
  });
});

// ---------------------------------------------------------------- the adversarial review of 2026-10-24

describe('what the review found, fixed', () => {
  it('"constructor" and "__proto__" are not old slugs: a plain 404, never a redirect to junk', async () => {
    for (const p of ['/constructor', '/__proto__', '/toString', '/hasOwnProperty']) {
      expect(classifyPath(p).kind, p).toBe('not_found');
      const r = await get(`https://namada.trade${p}`);
      expect([r.status, r.headers.get('location')], p).toEqual([404, null]);
    }
    expect(legacyHashTarget('#constructor')).toBeNull();
    expect(legacyHashTarget('#/__proto__')).toBeNull();
    expect(classifyPath('/pressure')).toEqual({ kind: 'redirect', to: '/supply' });
  });

  it('a host written with its trailing dot is the old host: pages 301, the API is answered', async () => {
    for (const h of ['www.namada.trade.', 'namada.trade.']) {
      const r = await get(`https://${h}/trade?x=1`);
      expect([r.status, r.headers.get('location')], h).toEqual([301, 'https://namada.trade/trade?x=1']);
      const api = await get(`https://${h}/api/no-such-thing`);
      expect(api.status, h).not.toBe(301);
      expect(api.headers.get('x-robots-tag'), h).toBe('noindex');
    }
  });

  it('the ownership files are answered on every host, never redirected', async () => {
    for (const host of ['www.namada.trade', 'namada-trade.example-account.workers.dev']) {
      expect((await get(`https://${host}/${SITE.verify.googleFile}`)).status, host).toBe(200);
      expect((await get(`https://${host}/BingSiteAuth.xml`)).status, host).toBe(200);
    }
  });

  it('a page never carries the static shell\'s ETag, and a revalidation gets the page of this minute, not a 304', async () => {
    const full = await get('https://namada.trade/trade');
    expect(full.status).toBe(200);
    expect(full.headers.get('etag')).toBeNull();
    const again = await get('https://namada.trade/trade', { headers: { 'if-none-match': ETAG } });
    expect(again.status).toBe(200);
    expect(again.headers.get('content-security-policy')).toMatch(/script-src 'self' 'sha256-/);
    expect(await again.text()).toContain('<div id="root"><div id="ssr"');
    // a static file keeps its validators
    expect((await get('https://namada.trade/favicon.ico', { headers: { 'if-none-match': ETAG } })).status).toBe(304);
  });

  it('when the page rewrite fails, a path that is not a page is still a 404 and a page is not indexed', async () => {
    vi.stubGlobal('HTMLRewriter', class { constructor() { throw new Error('rewrite failed'); } });
    const junk = await get('https://namada.trade/wp-admin');
    expect([junk.status, junk.headers.get('x-robots-tag')]).toEqual([404, 'noindex']);
    const list = await get('https://namada.trade/activity?page=2');
    expect(list.headers.get('x-robots-tag')).toBe('noindex');
    const page = await get('https://namada.trade/trade');
    expect([page.status, page.headers.get('x-robots-tag')]).toEqual([200, 'noindex']);
  });

  it('the static host\'s own redirects and method refusals never answer a path that is not a page', async () => {
    for (const [p, method] of [['/index', 'GET'], ['/zzz', 'POST'], ['/wp-login.php', 'POST'], ['/admin', 'PUT'], ['/x.php', 'OPTIONS']] as const) {
      const r = await get(`https://namada.trade${p}`, { method, body: method === 'GET' || method === 'OPTIONS' ? undefined : 'x' });
      expect([r.status, r.headers.get('x-robots-tag'), r.headers.get('location')], `${method} ${p}`).toEqual([404, 'noindex', null]);
    }
  });

  it('the not-found view keeps its stricter "noindex, nofollow" header', async () => {
    const r = await get('https://namada.trade/no-such-page');
    expect(r.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });

  it('the guides\' list headings are links that keep the heading\'s own line height', () => {
    const hub = guideHtml(routeByPath('/guides')!);
    for (const m of hub.matchAll(/<h2 style="[^"]*"><a href="[^"]*" style="([^"]*)">/g)) expect(m[1]).not.toMatch(/line-height/);
  });

  it('a guide\'s Article states when it was published and checked, with the site\'s image', () => {
    for (const r of GUIDE_ROUTES) {
      const art = JSON.parse(jsonLd(r, null)!.replace(/^<script[^>]*>|<\/script>$/g, '')).find((d: any) => d['@type'] === 'Article');
      expect(art.datePublished, r.path).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(art.datePublished <= art.dateModified, r.path).toBe(true);
      expect(art.image).toBe(`${SITE.origin}/og.png`);
    }
  });
});
