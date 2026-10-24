import { app } from './api';
import { LiveHub } from './live-hub';
import { runCron } from './cron';
import type { Env } from './util';
import { configureAlerts, sendsAlerts } from './sources/discord';
import { seoHtml, robotsTxt, sitemapXml, llmsTxt, classifyPath } from './seo';
import { redirectLocation } from '../../shared/routes';
import { cachedApi as cachedApiWith, inlineScriptHashes, pagePolicies, ENFORCE_SCRIPT_POLICY, wsLimited } from './http';
import { canonicalRedirect, redirectStatus, isCanonicalHost, ownershipFile } from './hosts';

const cachedApi = (request: Request, env: Env, ctx: ExecutionContext) => cachedApiWith(request, env, ctx, (r, e, c) => app.fetch(r, e, c));

/**
 * The headers every page, file and text answer of the site carries. Nothing a search engine should not list is
 * indexable: a 404, any answer on a host other than namada.trade, and (set by the caller) the API's JSON.
 */
function withSiteHeaders(res: Response, url: URL, h = new Headers(res.headers)): Response {
  if (url.hostname === 'namada.trade') h.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  // a stricter value set by the page (noindex, nofollow on the not-found view) is kept
  if ((res.status === 404 || !isCanonicalHost(url)) && !h.has('X-Robots-Tag')) h.set('X-Robots-Tag', 'noindex');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

/** The request without its validators (If-None-Match, If-Modified-Since), so the static host answers in full. */
function withoutValidators(request: Request): Request {
  if (!request.headers.has('if-none-match') && !request.headers.has('if-modified-since')) return request;
  const h = new Headers(request.headers);
  h.delete('if-none-match');
  h.delete('if-modified-since');
  return new Request(request, { headers: h });
}

/** The API's answers: data for the pages and for outside clients, never a search result. */
function apiHeaders(res: Response): Response {
  // a socket upgrade or an opaque answer is passed through untouched
  if (res.status === 101 || res.webSocket) return res;
  const h = new Headers(res.headers);
  h.set('X-Robots-Tag', 'noindex');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

export { LiveHub };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    configureAlerts(env.SETTINGS_KEY, sendsAlerts(env));
    const url = new URL(request.url);

    // Canonical origin: https://namada.trade (worker/src/hosts.ts). Plain http, www and the workers.dev origin are
    // redirected so links and cookies have one home; on www and workers.dev the API and /ws are answered in place,
    // for clients that still call them there. Version previews are answered as they are, with noindex.
    // `CF-Visitor` is set only by Cloudflare's edge, so local `wrangler dev` (which presents the route's host
    // over http) never redirects to itself.
    const edgeHttp = url.protocol === 'http:' && (request.headers.get('cf-visitor') || '').includes('"http"');
    // The search engines' ownership files, at their exact path on every host, before any host, lowercase, redirect
    // or 404 rule.
    const owned = ownershipFile(url.pathname);
    if (owned) return withSiteHeaders(owned, url);
    const moved = canonicalRedirect(url, edgeHttp);
    if (moved) return new Response(null, { status: redirectStatus(request.method), headers: { Location: moved, 'cache-control': 'public, max-age=3600' } });

    // Route WebSocket requests to the LiveHub Durable Object (only upgrades: a plain request never costs it a call)
    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected websocket upgrade', { status: 426 });
      // attempts per address, before the hub sees them (the plain request above never spends the budget)
      const limited = await wsLimited(request, env);
      if (limited) return limited;
      const id = env.LIVE.idFromName('namada-trade-live-hub');
      const obj = env.LIVE.get(id);
      return obj.fetch(request);
    }

    // API → Hono (read-only public GETs are cached at the edge for 15 s); everything else → the static UI.
    if (url.pathname.startsWith('/api/')) return apiHeaders(await cachedApi(request, env, ctx));
    if (url.pathname === '/robots.txt') return withSiteHeaders(robotsTxt(), url);
    if (url.pathname === '/sitemap.xml') return withSiteHeaders(await sitemapXml(env), url);
    if (url.pathname === '/llms.txt') return withSiteHeaders(llmsTxt(), url);

    const action = classifyPath(url.pathname);
    // 301 with the query kept, so ?at= survives every redirect
    if (action.kind === 'redirect') return withSiteHeaders(new Response(null, { status: redirectStatus(request.method), headers: { Location: redirectLocation(url.toString(), action.to) } }), url);

    // A page is rewritten with figures of this minute, so it is never answered from the static shell's validators:
    // a browser's If-None-Match would get a 304 and keep yesterday's server-rendered figures (and a 304 carries no
    // body to hash for the script policy). Static files keep their conditional requests.
    const page = action.kind === 'route' || (action.kind === 'not_found' && !action.asset);
    const assetReq = page ? withoutValidators(request) : request;
    let res = await env.ASSETS.fetch(assetReq);
    const isHtml = (res.headers.get('content-type') || '').includes('text/html');
    const notFound = () => withSiteHeaders(new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=300' } }), url);
    // a file or /assets path the static host does not have (/wp-login.php, /.env): a real 404, not the app shell;
    // nor the static host's own redirect (/index → /) or method refusal for a path that is not a page
    if (action.kind === 'not_found' && action.asset && (isHtml || res.status === 404)) return notFound();
    if (action.kind === 'not_found' && [301, 302, 303, 307, 308, 405].includes(res.status)) return notFound();
    let hashes: string[] | null = null;
    if (isHtml) {
      try {
        const html = await res.clone().text();
        hashes = await inlineScriptHashes(html);
      } catch (e) { console.error('csp', e); }
      try {
        res = await seoHtml(env, request, res);
      } catch (e) {
        console.error('seo', e);
        // fail closed: a path that is not a page is still a 404, and a page this rewrite could not finish is not indexed
        if (action.kind === 'not_found') return notFound();
        const h = new Headers(res.headers);
        h.set('X-Robots-Tag', 'noindex');
        res = new Response(res.body, { status: res.status, headers: h });
      }
    }
    const h = new Headers(res.headers);
    if (isHtml && hashes) {
      const p = pagePolicies(hashes, url);
      h.set('Content-Security-Policy', p.enforce);
      h.set(ENFORCE_SCRIPT_POLICY ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only', p.scripts);
      h.set('X-Frame-Options', 'DENY');
      h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    }
    if (url.pathname.startsWith('/assets/') && res.status === 200) h.set('Cache-Control', 'public, max-age=31536000, immutable');
    return withSiteHeaders(res, url, h);
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    configureAlerts(env.SETTINGS_KEY, sendsAlerts(env));
    ctx.waitUntil(runCron(env));
  },
};
