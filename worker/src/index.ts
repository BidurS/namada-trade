import { app } from './api';
import { LiveHub } from './live-hub';
import { runCron } from './cron';
import type { Env } from './util';
import { configureAlerts } from './sources/discord';
import { seoHtml, robotsTxt, sitemapXml, classifyPath } from './seo';
import { redirectLocation } from '../../shared/routes';
import { cachedApi as cachedApiWith, inlineScriptHashes, pagePolicies, ENFORCE_SCRIPT_POLICY, wsLimited } from './http';

const cachedApi = (request: Request, env: Env, ctx: ExecutionContext) => cachedApiWith(request, env, ctx, (r, e, c) => app.fetch(r, e, c));

/** The headers every page, file and text answer of the site carries. */
function withSiteHeaders(res: Response, url: URL, h = new Headers(res.headers)): Response {
  if (url.hostname === 'namada.trade') h.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

export { LiveHub };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    configureAlerts(env.SETTINGS_KEY);
    const url = new URL(request.url);

    // Canonical origin: https://namada.trade. Plain http and www are redirected (301) so links and
    // cookies have one home; the workers.dev origin keeps working for previews.
    // `CF-Visitor` is set only by Cloudflare's edge, so local `wrangler dev` (which presents the route's host
    // over http) never redirects to itself.
    const edgeHttp = url.protocol === 'http:' && (request.headers.get('cf-visitor') || '').includes('"http"');
    if (url.hostname === 'www.namada.trade' || (url.hostname === 'namada.trade' && edgeHttp)) {
      url.hostname = 'namada.trade';
      url.protocol = 'https:';
      return Response.redirect(url.toString(), 301);
    }

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
    if (url.pathname.startsWith('/api/')) return cachedApi(request, env, ctx);
    if (url.pathname === '/robots.txt') return withSiteHeaders(robotsTxt(), url);
    if (url.pathname === '/sitemap.xml') return withSiteHeaders(sitemapXml(), url);

    const action = classifyPath(url.pathname);
    // 301 with the query kept, so ?at= survives every redirect
    if (action.kind === 'redirect') return Response.redirect(redirectLocation(url.toString(), action.to), 301);

    let res = await env.ASSETS.fetch(request);
    const isHtml = (res.headers.get('content-type') || '').includes('text/html');
    if (action.kind === 'not_found' && action.asset && isHtml) {
      // a file or /assets path the static host does not have: a real 404, not the app shell
      return withSiteHeaders(new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=300' } }), url);
    }
    let hashes: string[] | null = null;
    if (isHtml) {
      try {
        const page = await res.clone().text();
        hashes = await inlineScriptHashes(page);
      } catch (e) { console.error('csp', e); }
      try { res = await seoHtml(env, request, res); } catch (e) { console.error('seo', e); }
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
    configureAlerts(env.SETTINGS_KEY);
    ctx.waitUntil(runCron(env));
  },
};
