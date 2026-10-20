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
  '/api/intel': [],
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
 * Requests that read many D1 rows per call (exports, search, address reports, flow and holder lists with a text
 * search), ask an outside service per call (quotes), or write for whoever asks (sign-in, pairing, tags, settings,
 * keys): limited per client address and path family, 30 a minute (the HEAVY_LIMITER binding in wrangler.jsonc;
 * skipped where it is absent).
 */
export function isHeavy(url: URL, method = 'GET'): boolean {
  const p = url.pathname;
  if (method === 'POST' || method === 'PUT' || method === 'DELETE') return /^\/api\/(auth\/|labels$|me($|\/))/.test(p);
  if (method !== 'GET') return false;
  return /^\/api\/(export\/|search$|address\/|quote$)/.test(p) || ((p === '/api/flows' || p === '/api/holders') && !!url.searchParams.get('search'));
}
/**
 * Rewound reads (`?at=`, `?since=`), metric histories, and the list and alert variants with many possible values
 * (`?minNam=`, a page past the first, a page size the app does not use, a custom alert threshold): every distinct
 * value is its own edge-cache entry, so a stream of them reaches D1 each time. Limited per client address and
 * path family, 120 a minute (REPLAY_LIMITER), and only on a cache miss (cachedApi), so going back to a moment
 * already shown, or the pages the app itself asks for, costs nothing.
 */
export function isReplay(url: URL): boolean {
  const p = url.pathname;
  if (p === '/api/metrics/history' || url.searchParams.has('at') || url.searchParams.has('since')) return true;
  if ((p === '/api/alerts/recent' || p === '/api/alerts/rules') && THRESHOLDS.some((k) => url.searchParams.has(k))) return true;
  if (p === '/api/flows' || p === '/api/holders') {
    if (url.searchParams.has('minNam')) return true;
    const page = Number(url.searchParams.get('page') || '1');
    if (!Number.isFinite(page) || page > 1) return true;
    const limit = url.searchParams.get('limit');
    if (limit != null && !['25', '50', '100'].includes(limit)) return true;
  }
  return false;
}
type Limiter = { limit(o: { key: string }): Promise<{ success: boolean }> } | undefined;
async function limitBy(limiter: Limiter, request: Request, url: URL, message: string): Promise<Response | null> {
  if (!limiter) return null;
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const r = await limiter.limit({ key: `${ip}:${url.pathname.split('/').slice(0, 3).join('/')}` }).catch(() => ({ success: true }));
  if (r.success) return null;
  return new Response(JSON.stringify({ error: message }), {
    status: 429, headers: { 'content-type': 'application/json', 'retry-after': '60', 'x-robots-tag': 'noindex', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
}
export async function rateLimited(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!isHeavy(url, request.method)) return null;
  return limitBy(env.HEAVY_LIMITER, request, url, 'Too many requests of this kind from your address; try again in a minute.');
}
export async function replayLimited(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!isReplay(url)) return null;
  return limitBy(env.REPLAY_LIMITER, request, url, 'Too many rewound reads from your address; try again in a minute.');
}

/** What browsers may keep an API answer for. The edge keeps its own copy for 15 s (EDGE_CACHE). */
export const BROWSER_CACHE = 'public, max-age=5';
const EDGE_CACHE = 'public, max-age=5, s-maxage=15, stale-while-revalidate=30';

/**
 * Every API answer: not for search indexes (the footer links /api/overview; robots.txt keeps the read paths
 * crawlable so pages render), never sniffed into another type, and for cacheable ones the browser lifetime set
 * here, whatever the stored copy says. Everything else (sign-in answers that carry a token, a user's settings,
 * live quotes) is for this request only: no browser or shared cache keeps it.
 */
function apiHeaders(res: Response, browserCache: string | null): Response {
  const out = new Response(res.body, res);
  out.headers.set('X-Robots-Tag', 'noindex');
  out.headers.set('X-Content-Type-Options', 'nosniff');
  out.headers.set('Cache-Control', browserCache ?? 'no-store');
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
  // No API path carries a percent-encoded character (addresses are bech32, ids are hex, typed text travels in the
  // query string). The router matches the decoded path while the cache and limiter rules below see the raw one, so
  // an encoded path (/api/%73earch) would only serve to slip past them: it is not found.
  if (url.pathname.includes('%')) return apiHeaders(new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'content-type': 'application/json' } }), null);
  // HEAD is answered from the GET's own cache entry, never stored itself: the router would run the GET handler and
  // answer with no body, and that empty answer must never become the stored copy every visitor is served.
  if (request.method === 'HEAD') {
    const r = await cachedApi(new Request(request.url, { method: 'GET', headers: request.headers }), env, ctx, fetchApp);
    return new Response(null, r);
  }
  const limited = await rateLimited(request, env);
  if (limited) return limited;
  const isExport = EXPORTS.test(url.pathname);
  // The cached routes are public market reads that never look at a session (test/review2-worker-round2.test.ts pins
  // it), so an Authorization header changes nothing about the answer and does not get past the cache.
  const cacheable = request.method === 'GET' && (CACHEABLE_API.test(url.pathname) || isExport);
  if (!cacheable) return apiHeaders(await fetchApp(request, env, ctx), null);
  const cache = caches.default;
  const key = new Request(cacheKeyUrl(url), { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) return apiHeaders(hit, BROWSER_CACHE);
  const replay = await replayLimited(request, env);
  if (replay) return replay;
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

