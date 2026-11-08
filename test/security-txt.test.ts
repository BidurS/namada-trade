// Security backlog (2026-11-07): where a security problem with the site is reported. SECURITY.md in the repository
// root and /.well-known/security.txt (RFC 9116) from the Worker name one channel, a private security advisory on
// the public repository's GitHub page; the file's Expires is a year after the request, computed when it is made,
// and robots.txt points at the file.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { securityTxt, robotsTxt, SECURITY_CONTACT, SECURITY_TXT_VALID_MS } from '../worker/src/seo';
import { SITE } from '../shared/site';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
const worker = (await import('../worker/src/index')).default as ExportedHandler<any> & { fetch: (r: Request, e: any, c: any) => Promise<Response> };
const ctx = { waitUntil() {}, passThroughOnException() {} };
// the static host is never asked for the file: a request that reaches it fails the test
const env = { ASSETS: { fetch: async () => { throw new Error('the static host was asked'); } } };

const NOW = Date.parse('2026-11-07T12:00:00Z');
const field = (txt: string, name: string) => txt.match(new RegExp(`^${name}: (.+)$`, 'm'))?.[1];

describe('/.well-known/security.txt', () => {
  it('names the GitHub advisory page as the one contact, English, and the canonical copy', async () => {
    const txt = await securityTxt(NOW).text();
    expect(SECURITY_CONTACT).toBe('https://github.com/BidurS/namada-trade/security/advisories/new');
    expect(field(txt, 'Contact')).toBe(SECURITY_CONTACT);
    expect(field(txt, 'Preferred-Languages')).toBe('en');
    expect(field(txt, 'Canonical')).toBe(`${SITE.origin}/.well-known/security.txt`);
    // the fields the file carries, and no other (no key, no acknowledgements, no hiring line)
    const names = [...txt.matchAll(/^([A-Za-z-]+): /gm)].map((m) => m[1]).sort();
    expect(names).toEqual(['Canonical', 'Contact', 'Expires', 'Preferred-Languages']);
    expect(txt.endsWith('\n')).toBe(true);
  });

  it('expires a year after the request, computed when the file is made, to the second in UTC', async () => {
    const txt = await securityTxt(NOW).text();
    expect(SECURITY_TXT_VALID_MS).toBe(365 * 86_400_000);
    expect(field(txt, 'Expires')).toBe('2027-11-07T12:00:00Z');
    const later = await securityTxt(NOW + 86_400_000).text();
    expect(field(later, 'Expires')).toBe('2027-11-08T12:00:00Z');
    // without a time given, the request's own
    const before = Date.now();
    const now = Date.parse(field(await securityTxt().text(), 'Expires')!) - SECURITY_TXT_VALID_MS;
    expect(now).toBeGreaterThanOrEqual(before - 1000);
    expect(now).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('is served by the Worker as plain text, an hour at the edge, with the site headers, before the static host', async () => {
    const res = await worker.fetch(new Request('https://namada.trade/.well-known/security.txt'), env, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(res.headers.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-robots-tag')).toBeNull();
    const txt = await res.text();
    expect(field(txt, 'Contact')).toBe(SECURITY_CONTACT);
    const exp = Date.parse(field(txt, 'Expires')!);
    expect(exp - Date.now()).toBeGreaterThan(SECURITY_TXT_VALID_MS - 60_000);
    expect(exp - Date.now()).toBeLessThanOrEqual(SECURITY_TXT_VALID_MS);
  });

  it('robots.txt names the file in its comments', async () => {
    const txt = await robotsTxt().text();
    expect(txt).toContain('# A security problem with the site is reported as /.well-known/security.txt says.');
    // a comment, never a rule: the file stays crawlable
    expect([...txt.matchAll(/^Disallow: (.+)$/gm)].some((m) => '/.well-known/security.txt'.startsWith(m[1].trim()))).toBe(false);
  });

  it('SECURITY.md says the same: the private advisory on the repository\'s GitHub page, and the file', () => {
    const md = readFileSync(join(__dirname, '..', 'SECURITY.md'), 'utf8');
    // the approved text, whole: one channel and the file, nothing beside them
    expect(md).toBe(`# Reporting a security problem

To report a security problem with namada.trade or this code privately, open a private security advisory on this repository's GitHub page (Security, then Advisories, then "Report a vulnerability"), which GitHub provides for public repositories. The site serves the same contact at \`/.well-known/security.txt\`.
`);
  });
});
