// One address for every page: https://namada.trade. A page asked for on another host this Worker answers (www, the
// workers.dev origin) or over plain http is sent there with a 301 (308 for a method other than GET or HEAD, so a
// body is never turned into a GET). The API and the live socket stay reachable where an outside client already
// calls them: on www and workers.dev they are answered in place (with noindex), never redirected.
//
// Ownership files for the search engines' webmaster tools are answered here too, on every host, before any redirect,
// lowercase or not-found rule can reach them (test/seo-hosts.test.ts). A host written with its trailing dot
// (namada.trade.) is the same name in DNS but another origin to a browser, so it is treated as an old host.
import { SITE } from '../../shared/site';

export const CANONICAL_HOST = new URL(SITE.origin).hostname;

/** Hosts whose pages move to the canonical address. Version previews (<id>-namada-trade.…workers.dev) stay put. */
const OLD_HOSTS: RegExp[] = [/^www\.namada\.trade$/, /^namada-trade\.[a-z0-9-]+\.workers\.dev$/];

/** Paths an outside client calls: answered on every host, never redirected off an old one. */
export const isClientPath = (path: string): boolean => path.startsWith('/api/') || path === '/ws';

/**
 * Where a request must go instead, or null to answer it here. `edgeHttp` is true only when Cloudflare's edge saw
 * plain http (the CF-Visitor header), so local `wrangler dev` never redirects to itself.
 */
export function canonicalRedirect(url: URL, edgeHttp: boolean): string | null {
  const dotted = url.hostname.toLowerCase();
  const host = dotted.replace(/\.$/, '');
  const old = OLD_HOSTS.some((re) => re.test(host)) || (host === CANONICAL_HOST && dotted !== host);
  if (old && isClientPath(url.pathname)) return null;
  if (!old && !(host === CANONICAL_HOST && edgeHttp)) return null;
  const to = new URL(url.toString());
  to.protocol = 'https:';
  to.hostname = CANONICAL_HOST;
  to.port = '';
  return to.toString();
}

/** 301 for reads; 308 keeps the method and body of anything else. */
export const redirectStatus = (method: string): 301 | 308 => (method === 'GET' || method === 'HEAD' ? 301 : 308);

/** Any host but the canonical one is never indexed (the API on www, a version preview). */
export const isCanonicalHost = (url: URL): boolean => url.hostname.toLowerCase() === CANONICAL_HOST;

/**
 * The webmaster tools' ownership files, answered byte for byte at their exact path (case matters: Bing asks for
 * BingSiteAuth.xml). Kept for as long as the site stays verified; the same tokens are in every page's <head>.
 */
export function ownershipFile(path: string): Response | null {
  const v = SITE.verify;
  if (path === `/${v.googleFile}`) {
    return new Response(`google-site-verification: ${v.googleFile}`, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
  }
  if (path === '/BingSiteAuth.xml') {
    return new Response(`<?xml version="1.0"?>\n<users>\n\t<user>${v.bing}</user>\n</users>\n`, { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
  }
  return null;
}
