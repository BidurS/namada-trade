// HTTP helpers of the Worker's fetch handler (index.ts), in their own module so they can be tested without the
// Durable Object runtime: the API cache rule and the page security policy.
import type { Env } from './util';
import { clientKey } from './client-key';
import { DAY_MS, DAILY_DAYS, HISTORY_FETCH_DAYS } from '../../shared/history';
import { TRADES_TAPE_LIMIT } from '../../shared/types';
import { QUOTE_NAM_MIN, QUOTE_NAM_MAX, roundQuoteNam, HEAT_DAYS, CHANGES_LIMIT_MAX } from '../../shared/depth';

export const CACHEABLE_API = /^\/api\/(overview|pools|pressure|blindspot|orderflow|flows|holders|search|metrics\/history|quote\/curve|alerts\/rules|alerts\/recent|intel|series|series\/changes|series\/volume|series\/pairs|series\/trades|series\/values|depth|depth\/quote|depth\/history|depth\/heat|depth\/owners|depth\/changes|integrity|donation)$/;

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
  '/api/orderflow': ['at', 'hours'],
  '/api/flows': ['chain', 'kind', 'whale', 'minNam', 'arb', 'pairs', 'search', 'at', 'page', 'limit', 'before', 'since', 'addr', 'hash', 'height', 'count'],
  '/api/holders': ['chain', 'by', 'category', 'search', 'page', 'limit', 'after', 'min', 'max'],
  '/api/search': ['q', 'limit'],
  '/api/metrics/history': ['key', 'hours', 'at'],
  '/api/quote/curve': [],
  '/api/alerts/rules': THRESHOLDS,
  '/api/alerts/recent': ['at', 'since', ...THRESHOLDS],
  '/api/intel': [],
  // The series routes (worker/src/api-series.ts SERIES_PARAMS lists exactly these; test/series-api.test.ts checks it)
  '/api/series': ['key', 'from', 'to', 'step', 'at'],
  '/api/series/changes': ['at'],
  '/api/series/volume': ['at'],
  '/api/series/pairs': [],
  '/api/series/trades': ['before', 'maker', 'min', 'limit', 'at'],
  '/api/series/values': ['at'],
  // The depth routes (worker/src/api-depth.ts DEPTH_PARAMS lists exactly these; test/depth-api.test.ts checks it)
  '/api/depth': [],
  '/api/depth/quote': ['side', 'nam'],
  '/api/depth/history': ['pool', 'from', 'to', 'step', 'at'],
  '/api/depth/heat': ['days', 'at'],
  '/api/depth/owners': [],
  '/api/depth/changes': ['pool', 'before', 'limit'],
  // The cross-checks and the donation addresses: one kv read each, no parameter, no session
  '/api/integrity': [],
  '/api/donation': [],
  '/api/export/holders': ['chain', 'by', 'category', 'search', 'limit', 'format', 'min', 'max'],
  '/api/export/flows': ['chain', 'kind', 'whale', 'minNam', 'arb', 'pairs', 'search', 'at', 'limit', 'format', 'since', 'addr', 'hash', 'height'],
};

/**
 * The address report (GET /api/address/:addr): the address is the path and the route reads no parameter, so its
 * copy is keyed on the path alone (the app sends none: web/src/api.ts fetchAddressReport). The charset and lengths
 * are chainOf's; any other path is answered 400 and never stored.
 */
export const ADDRESS_REPORT = /^\/api\/address\/(?:osmo1|tnam1)[02-9ac-hj-np-z]{38,80}$/;
/** The parameters a cached route reads (CACHE_PARAMS, or none for the address report); undefined: not a cached route. */
export const cacheParamsOf = (path: string): string[] | undefined => CACHE_PARAMS[path] ?? (ADDRESS_REPORT.test(path) ? [] : undefined);

/**
 * `?at=` as every route reads it (worker/src/api.ts asOfParam, api-series.ts asOfOf): a finite time after 0 and
 * before now is a rewound read, written as the route reads it (String(Number(raw)): "1.7e12" and "1700000000000" are
 * one copy); anything else (unreadable, empty, 0, negative, Infinity, a future time) is answered live, so it is null:
 * the live copy, and no replay limit. Read any other way, each spelling of a live `at` was a copy of its own under
 * the replay budget, and on /api/overview each one asked the Osmosis quote service twice.
 */
export function rewoundAt(url: URL, now = Date.now()): string | null {
  const raw = url.searchParams.get('at');
  const at = raw ? Number(raw) : NaN;
  return Number.isFinite(at) && at > 0 && at < now ? String(at) : null;
}

/**
 * The depth quote's size as the route answers it: rounded to three significant digits (shared/depth.ts roundQuoteNam), so
 * every size that rounds alike is one edge copy. A size the route would refuse is kept as written (the refusal is never stored).
 */
export function quoteNamKey(raw: string | null): string | null {
  if (raw == null) return null;
  const n = Number(raw);
  return raw !== '' && Number.isFinite(n) && n >= QUOTE_NAM_MIN && n <= QUOTE_NAM_MAX ? String(roundQuoteNam(n)) : raw;
}

/** The cache key for a request: its path and the parameters the route reads, sorted (`at` as rewoundAt reads it, the quote's `nam` rounded). */
export function cacheKeyUrl(url: URL, now = Date.now()): string {
  const keep = cacheParamsOf(url.pathname);
  const out = new URL(url.origin + url.pathname);
  if (!keep) return url.toString();
  for (const k of [...keep].sort()) {
    const v = k === 'at' ? rewoundAt(url, now) : k === 'nam' && url.pathname === '/api/depth/quote' ? quoteNamKey(url.searchParams.get(k)) : url.searchParams.get(k);
    if (v != null) out.searchParams.set(k, v);
  }
  return out.toString();
}

/** Exports: built from up to 10,000 rows, so they are cached at the edge for a minute. */
const EXPORTS = /^\/api\/export\/(holders|flows)$/;
const EXPORT_EDGE_CACHE = 'public, max-age=5, s-maxage=60';

/**
 * Which per-address limit a request falls under (nav-search-plan.md 4.5):
 * - 'heavy', 30 a minute per client address and path family (HEAVY_LIMITER): exports and address reports (many D1
 *   rows per call), quotes (an outside service per call), and every write for whoever asks (sign-in, pairing, tags,
 *   settings, keys);
 * - 'search', 120 a minute (SEARCH_LIMITER): the search and the lists searched by text. A person typing in the
 *   palette sends about one request per pause, which a long session took past 30 a minute;
 * - null: everything else. Each is skipped where its binding is absent; a search falls back to HEAVY_LIMITER when
 *   only that one is bound.
 */
export type LimiterKind = 'heavy' | 'search';
export function limiterFor(url: URL, method = 'GET'): LimiterKind | null {
  const p = url.pathname;
  if (method === 'POST' || method === 'PUT' || method === 'DELETE') return /^\/api\/(auth\/|labels$|me($|\/))/.test(p) ? 'heavy' : null;
  if (method !== 'GET') return null;
  if (/^\/api\/(export\/|address\/|quote$)/.test(p)) return 'heavy';
  if (p === '/api/search' || ((p === '/api/flows' || p === '/api/holders') && !!url.searchParams.get('search'))) return 'search';
  return null;
}
/** Is the request limited at all (either limiter)? */
export const isHeavy = (url: URL, method = 'GET'): boolean => limiterFor(url, method) !== null;
/**
 * Rewound reads (`?at=`, `?since=`), metric histories, and the list and alert variants with many possible values
 * (`?minNam=`, a page past the first, a page size the app does not use, a custom alert threshold): every distinct
 * value is its own edge-cache entry, so a stream of them reaches D1 each time. Limited per client address and
 * path family, 120 a minute (REPLAY_LIMITER), and only on a cache miss (cachedApi), so going back to a moment
 * already shown, or the pages the app itself asks for, costs nothing.
 */
/** The windows the pages ask for (web/src/screens/trade/data.ts rangeFetchHours; supply/parts.tsx WindowDays). */
const ORDERFLOW_HOURS = new Set(['24', '168', '720', '2160', '8760', '28800']);
const PRESSURE_DAYS = new Set(['1', '7', '30', '90', '365']);
/**
 * The `from` days a series request is sent with today (web/src/screens/trade/series.ts seriesWindow, data.ts
 * useDailyTrades): the UTC day `d` days before now for each window the Trade page draws, and the day either side
 * (a client clock a little off, a request made across midnight). Any other day is a cache entry no page asks for.
 */
export function seriesFromDays(now: number): Set<string> {
  const out = new Set<string>();
  for (const d of [...Object.values(HISTORY_FETCH_DAYS), DAILY_DAYS]) for (const k of [-1, 0, 1]) out.add(new Date(now - (d + k) * DAY_MS).toISOString().slice(0, 10));
  return out;
}
export function isReplay(url: URL): boolean {
  const p = url.pathname;
  if (p === '/api/metrics/history' || rewoundAt(url) != null || url.searchParams.has('since')) return true;
  // Orderflow and pressure aggregate the flows table over the window asked for; the ranges the pages offer are a
  // few cache entries each, any other value is a cache miss that reaches D1.
  if (p === '/api/orderflow') return !ORDERFLOW_HOURS.has(url.searchParams.get('hours') ?? '720');
  if (p === '/api/pressure') return !PRESSURE_DAYS.has(url.searchParams.get('days') ?? '7');
  if ((p === '/api/alerts/recent' || p === '/api/alerts/rules') && THRESHOLDS.some((k) => url.searchParams.has(k))) return true;
  // A series asked from one of the days the Trade page sends today is a few cache entries a day. Any other `from`
  // (another day, a time to the millisecond) and any `to` (the page never sends one) is its own entry, and a read of
  // up to the series' whole history (46,770 rows for the pool price): limited on a miss.
  if (p === '/api/series') {
    if (url.searchParams.has('to')) return true;
    const f = url.searchParams.get('from');
    if (f != null && !seriesFromDays(Date.now()).has(f)) return true;
  }
  // A tape page behind a cursor, one maker's trades, a size, or a page length the tape does not ask for: one entry per value.
  if (p === '/api/series/trades') {
    if (['before', 'maker', 'min'].some((k) => url.searchParams.has(k))) return true;
    const limit = url.searchParams.get('limit');
    if (limit != null && limit !== String(TRADES_TAPE_LIMIT)) return true;
  }
  // The depth history's default window (the last day of the aggregate at one-minute steps) and the hourly one are a
  // few cache entries a pool; any `from` or `to` is a window of its own and a read of up to 43,200 rows: limited on a miss.
  // A changes page behind a cursor or at a page length the page does not ask for is one entry per value, as the tape's.
  if (p === '/api/depth/history' && (url.searchParams.has('from') || url.searchParams.has('to'))) return true;
  if (p === '/api/depth/heat') { const d = url.searchParams.get('days'); if (d != null && !(d in HEAT_DAYS)) return true; }
  if (p === '/api/depth/changes') {
    if (url.searchParams.has('before')) return true;
    const limit = url.searchParams.get('limit');
    if (limit != null && limit !== String(CHANGES_LIMIT_MAX)) return true;
  }
  if (p === '/api/flows' || p === '/api/holders') {
    // a size, a cursor or a date jump: every value is its own cache entry
    // so is an address (every start of 8 to 62 characters of every address, or a whole one); a hub's count reads
    // every move it made (the MASP's 20,128 on 2026-10-22)
    if (p === '/api/flows' && url.searchParams.has('addr')) return true;
    if (['minNam', 'min', 'max', 'after', 'before'].some((k) => url.searchParams.has(k))) return true;
    // a page past the first, or the first spelled any other way ("-5", "0.3", "01"): the route reads them all as a
    // page number, so each spelling would be a cache entry of its own
    const page = url.searchParams.get('page');
    if (page != null && page !== '1') return true;
    const limit = url.searchParams.get('limit');
    if (limit != null && !['25', '50', '100'].includes(limit)) return true;
  }
  return false;
}
type Limiter = { limit(o: { key: string }): Promise<{ success: boolean }> } | undefined;
async function limitBy(limiter: Limiter, request: Request, url: URL, message: string): Promise<Response | null> {
  if (!limiter) return null;
  // per client (client-key.ts): an IPv4 address whole, an IPv6 address by its /64
  const who = clientKey(request.headers.get('cf-connecting-ip'));
  const r = await limiter.limit({ key: `${who}:${url.pathname.split('/').slice(0, 3).join('/')}` }).catch(() => ({ success: true }));
  if (r.success) return null;
  return new Response(JSON.stringify({ error: message }), {
    status: 429, headers: { 'content-type': 'application/json', 'retry-after': '60', 'x-robots-tag': 'noindex', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
}
export const SEARCH_LIMIT_WORDS = 'Too many searches from your address; try again in a minute.';
export async function rateLimited(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const kind = limiterFor(url, request.method);
  if (!kind) return null;
  if (kind === 'search') return limitBy(env.SEARCH_LIMITER ?? env.HEAVY_LIMITER, request, url, SEARCH_LIMIT_WORDS);
  return limitBy(env.HEAVY_LIMITER, request, url, 'Too many requests of this kind from your address; try again in a minute.');
}
/**
 * /ws upgrade attempts, 60 a minute per client address (WS_LIMITER), counted before the one LiveHub object sees them:
 * its admission (ws-admit.ts) bounds open sockets only, and every attempt, refused or accepted, is an event in the
 * object that runs the 6 s Namada scan. A page opens one socket per load and retries a close after 3 s, doubling to
 * 30 s (web/src/app/overview.tsx), so it stays far below.
 */
export const WS_LIMIT_WORDS = 'Too many live connection attempts from your address; try again in a minute.';
export const wsLimited = (request: Request, env: Env): Promise<Response | null> => limitBy(env.WS_LIMITER, request, new URL(request.url), WS_LIMIT_WORDS);

export async function replayLimited(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!isReplay(url)) return null;
  return limitBy(env.REPLAY_LIMITER, request, url, 'Too many rewound reads from your address; try again in a minute.');
}

/** What browsers may keep an API answer for. The edge keeps its own copy for 15 s (EDGE_CACHE). */
export const BROWSER_CACHE = 'public, max-age=5';
const EDGE_CACHE = 'public, max-age=5, s-maxage=15, stale-while-revalidate=30';
/**
 * A moves page behind a cursor or a date (`?before=`): a minute at the edge, not five, because the flow index can
 * catch up and add a row with an older time (the list's "last checked the chain" line covers that).
 */
export const EDGE_CACHE_BEHIND = 'public, max-age=5, s-maxage=60, stale-while-revalidate=30';
/**
 * The depth routes (depth plan section 2): the minute's answer and the quotes walked on it 30 s (a new minute lands
 * every 60 s), the history 30 s, the heat a minute, the owners five minutes (the hour writes them once).
 */
export const DEPTH_EDGE_SECONDS: Record<string, number> = { '/api/depth': 30, '/api/depth/quote': 30, '/api/depth/history': 30, '/api/depth/heat': 60, '/api/depth/owners': 300, '/api/depth/changes': 30 };
export const edgeCacheOf = (url: URL) => {
  const depth = DEPTH_EDGE_SECONDS[url.pathname];
  if (depth != null) return `public, max-age=5, s-maxage=${depth}, stale-while-revalidate=30`;
  return url.pathname === '/api/flows' && url.searchParams.has('before') ? EDGE_CACHE_BEHIND : EDGE_CACHE;
};

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
/**
 * Does a query parameter's name carry a percent sign? The cache key and the limiters read the query with
 * URLSearchParams (names decoded, the first occurrence), while the routes read it with Hono's c.req.query (the first
 * literal `name=`, an encoded name skipped). `?%6bind=sell&kind=buy` would be keyed and limited as kind=sell and
 * answered as kind=buy, which stored a false answer under the visitors' key and slipped past every limiter
 * (docs/security-review.md C1). No client of this API encodes a name (URLSearchParams writes plain ASCII names).
 */
export const hasEncodedName = (url: URL): boolean => url.search.slice(1).split('&').some((p) => p.split('=')[0].includes('%'));

export async function cachedApi(request: Request, env: Env, ctx: ExecutionContext, fetchApp: (r: Request, e: Env, c: ExecutionContext) => Response | Promise<Response>): Promise<Response> {
  const url = new URL(request.url);
  // No API path carries a percent-encoded character (addresses are bech32, ids are hex, typed text travels in the
  // query string). The router matches the decoded path while the cache and limiter rules below see the raw one, so
  // an encoded path (/api/%73earch) would only serve to slip past them: it is not found. So is a query whose
  // parameter names are encoded (hasEncodedName).
  if (url.pathname.includes('%') || hasEncodedName(url)) return apiHeaders(new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'content-type': 'application/json' } }), null);
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
  const cacheable = request.method === 'GET' && (CACHEABLE_API.test(url.pathname) || isExport || ADDRESS_REPORT.test(url.pathname));
  if (!cacheable) return apiHeaders(await fetchApp(request, env, ctx), null);
  const cache = caches.default;
  const key = new Request(cacheKeyUrl(url), { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) return apiHeaders(hit, BROWSER_CACHE);
  const replay = await replayLimited(request, env);
  if (replay) return replay;
  // The route reads the request as the key reads it: the key's own URL (only the parameters the route reads, each
  // once, as URLSearchParams decoded it), so the answer stored under a key is always the answer to that key.
  const res = await fetchApp(new Request(key.url, { method: 'GET', headers: request.headers }), env, ctx);
  if (res.status !== 200) return apiHeaders(res, null);
  const stored = new Response(res.body, res);
  stored.headers.set('Cache-Control', isExport ? EXPORT_EDGE_CACHE : edgeCacheOf(url));
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

