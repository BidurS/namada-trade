// HTTP helpers of the Worker's fetch handler (index.ts), in their own module so they can be tested without the
// Durable Object runtime: the API cache rule and the page security policy.
import type { Env } from './util';

export const CACHEABLE_API = /^\/api\/(overview|pools|pressure|blindspot|flows|holders|metrics\/history|quote\/curve|alerts\/rules|alerts\/recent|intel)$/;

const THRESHOLDS = ['ibcInventory', 'unlock', 'bigSwap', 'unshield', 'bond'];
/**
 * The query parameters each cacheable route reads (worker/src/api.ts, flows-query.ts). The edge copy is keyed on
 * these only, sorted, so `?r=<random>` cannot get past the cache; a parameter a route reads MUST be listed here,
 * or two different answers would share one copy.
 */
export const CACHE_PARAMS: Record<string, string[]> = {
  '/api/overview': ['at'],
  '/api/pools': [],
  '/api/pressure': ['at', 'days'],
  '/api/blindspot': ['at'],
  '/api/flows': ['chain', 'kind', 'whale', 'minNam', 'arb', 'pairs', 'search', 'at', 'page', 'limit'],
  '/api/holders': ['chain', 'by', 'category', 'search', 'page', 'limit'],
  '/api/metrics/history': ['key', 'hours', 'at'],
  '/api/quote/curve': [],
  '/api/alerts/rules': THRESHOLDS,
  '/api/alerts/recent': ['at', 'since', ...THRESHOLDS],
  '/api/intel': ['refresh'],
  '/api/export/holders': ['chain', 'by', 'category', 'search', 'limit', 'format'],
  '/api/export/flows': ['chain', 'kind', 'whale', 'minNam', 'arb', 'pairs', 'search', 'at', 'limit', 'format'],
};

/** The cache key for a request: its path and the parameters the route reads, sorted. */
export function cacheKeyUrl(url: URL): string {
  const keep = CACHE_PARAMS[url.pathname];
  const out = new URL(url.origin + url.pathname);
  if (!keep) return url.toString();
  for (const k of [...keep].sort()) { const v = url.searchParams.get(k); if (v != null) out.searchParams.set(k, v); }
  return out.toString();
}

/** Exports: built from up to 10,000 rows, so they are cached at the edge for a minute. */
const EXPORTS = /^\/api\/export\/(holders|flows)$/;
const EXPORT_EDGE_CACHE = 'public, max-age=5, s-maxage=60';

/**
 * Requests that read many D1 rows per call: exports, search, address reports, and flow lists with a text search.
 * They are limited per client address (the HEAVY_LIMITER binding in wrangler.jsonc; skipped where it is absent).
 */
export function isHeavy(url: URL): boolean {
  return /^\/api\/(export\/|search$|address\/)/.test(url.pathname) || (url.pathname === '/api/flows' && !!url.searchParams.get('search'));
}
export async function rateLimited(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!isHeavy(url) || !env.HEAVY_LIMITER) return null;
  const key = request.headers.get('cf-connecting-ip') || 'unknown';
  const r = await env.HEAVY_LIMITER.limit({ key: `${key}:${url.pathname.split('/').slice(0, 3).join('/')}` }).catch(() => ({ success: true }));
  if (r.success) return null;
  return new Response(JSON.stringify({ error: 'Too many requests of this kind from your address; try again in a minute.' }), {
    status: 429, headers: { 'content-type': 'application/json', 'retry-after': '60', 'x-robots-tag': 'noindex' },
  });
}

/** What browsers may keep an API answer for. The edge keeps its own copy for 15 s (EDGE_CACHE). */
export const BROWSER_CACHE = 'public, max-age=5';
const EDGE_CACHE = 'public, max-age=5, s-maxage=15, stale-while-revalidate=30';

/**
 * Every API answer: not for search indexes (the footer links /api/overview; robots.txt keeps the read paths
 * crawlable so pages render), and for cacheable ones the browser lifetime set here, whatever the stored copy says.
 */
function apiHeaders(res: Response, browserCache: string | null): Response {
  const out = new Response(res.body, res);
  out.headers.set('X-Robots-Tag', 'noindex');
  if (browserCache) out.headers.set('Cache-Control', browserCache);
  return out;
}

/**
 * Public read-only market endpoints: 15 s at the edge (and 5 s in the browser) so a burst of visitors costs one D1
 * read. A copy served from the edge cache is re-headed: the zone's Browser Cache TTL rewrites a stored copy's
 * Cache-Control (to max-age=14400 on 2026-10-17), and returning it as stored would let browsers keep market data
 * for hours.
 */
export async function cachedApi(request: Request, env: Env, ctx: ExecutionContext, fetchApp: (r: Request, e: Env, c: ExecutionContext) => Response | Promise<Response>): Promise<Response> {
  const url = new URL(request.url);
  const limited = await rateLimited(request, env);
  if (limited) return limited;
  const isExport = EXPORTS.test(url.pathname);
  const cacheable = request.method === 'GET' && (CACHEABLE_API.test(url.pathname) || isExport) && !request.headers.get('authorization');
  if (!cacheable) return apiHeaders(await fetchApp(request, env, ctx), null);
  const cache = caches.default;
  const key = new Request(cacheKeyUrl(url), { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) return apiHeaders(hit, BROWSER_CACHE);
  const res = await fetchApp(request, env, ctx);
  if (res.status !== 200) return apiHeaders(res, null);
  const stored = new Response(res.body, res);
  stored.headers.set('Cache-Control', isExport ? EXPORT_EDGE_CACHE : EDGE_CACHE);
  stored.headers.set('X-Robots-Tag', 'noindex');
  ctx.waitUntil(cache.put(key, stored.clone()));
  return apiHeaders(stored, BROWSER_CACHE);
}

// ---------------------------------------------------------------- Content-Security-Policy for the pages

/** sha256 (base64) of each inline executable <script> in a page, memoised per page text. */
const scriptHashes = new Map<string, string[]>();
export async function inlineScriptHashes(html: string): Promise<string[]> {
  const known = scriptHashes.get(html);
  if (known) return known;
  const out: string[] = [];
  const re = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi;
  for (let m; (m = re.exec(html)); ) {
    const attrs = m[1] ?? '';
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1]?.toLowerCase();
    if (type && type !== 'module' && type !== 'text/javascript' && type !== 'application/javascript') continue; // data blocks (JSON-LD) do not run
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(m[2]));
    out.push(`'sha256-${btoa(String.fromCharCode(...new Uint8Array(d)))}'`);
  }
  if (scriptHashes.size > 20) scriptHashes.clear();
  scriptHashes.set(html, out);
  return out;
}

/**
 * The page policy. Enforced now: no framing (clickjacking), no <base> or plugin tricks, forms only to this site.
 * The script and connection rules (only this site's scripts and the inline theme script, by hash; requests only to
 * this site and its live stream) are enforced since 2026-10-18, after the owner signed in with Keplr and Namada
 * Keychain on the live site (wallet extensions run outside the page's policy). Set ENFORCE_SCRIPT_POLICY to false
 * to send them as Report-Only again. Hashes are computed from the page served, so editing the theme script can
 * never silently break the page.
 */
export const ENFORCE_SCRIPT_POLICY = true;
export function pagePolicies(hashes: string[], url: URL): { enforce: string; scripts: string } {
  const ws = `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}`;
  const enforce = "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'";
  const scripts = [
    "default-src 'self'", `script-src 'self' ${hashes.join(' ')}`.trim(), "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:", "font-src 'self'", `connect-src 'self' ${ws}`, "manifest-src 'self'", "worker-src 'self'", enforce,
  ].join('; ');
  return { enforce, scripts };
}

