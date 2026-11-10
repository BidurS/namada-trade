// The platform pages (docs/design/platform-plan.md, release A): the API reference and the document made from it, the
// limits it states, and the status, methodology, privacy and terms pages. What these tests hold true:
//   - the catalog documents exactly the public read routes the Worker keeps an edge copy of, each with exactly the
//     parameters that copy is keyed on (worker/src/http.ts CACHE_PARAMS), so no documented parameter is ignored and
//     no read parameter is undocumented;
//   - the limits on the page are the Worker's own (wrangler.jsonc);
//   - /openapi.json, the server-rendered page and llms.txt are made from the same list;
//   - the words keep the site's rules (no banned word, plain sentences), and the privacy page says what the Settings
//     page says about what is stored.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { API_CATALOG, API_GROUPS, NOT_DOCUMENTED, endpointByPath } from '../shared/api-catalog';
import { API_LIMITS } from '../shared/api-limits';
import { BODY } from '../shared/copy';
import { ASK_SHOWN } from '../shared/ask-words';
import { PLATFORM_ROUTES, PLATFORM_TEXT_CHECKED, ROUTES, classifyPath, fullTitle, routeByPath } from '../shared/routes';
import { CACHE_PARAMS, limiterFor } from '../worker/src/http';
import { openApiDoc, paramSchema, refuses } from '../worker/src/openapi';
import { apiListHtml, llmsTxt, pageHtml, sitemapXml, statesFigures, statusFacts } from '../worker/src/seo';
import { app, pressureDays, PRESSURE_DAYS_DEFAULT, PRESSURE_DAYS_MAX, PRESSURE_DAYS_MIN } from '../worker/src/api';
import { ROUTE_ALIASES } from '../shared/routes';
import { OPS_KV, emptyOps } from '../worker/src/ops';
import { kvSet } from '../worker/src/db';
import { testD1 } from './d1-sqlite';
import type { IntegrityResponse } from '../shared/types';
import { BANNED } from '../scripts/copy-lint';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
/** Routes the catalog documents that have no edge copy: the live quote (answered afresh each time) and the address report (keyed on its path). */
const UNCACHED = ['/api/quote', '/api/address/{address}'];

describe('the API catalog against the routes the Worker serves', () => {
  it('documents every route that has an edge copy, or says why not', () => {
    for (const path of Object.keys(CACHE_PARAMS)) {
      const documented = !!endpointByPath(path), left = path in NOT_DOCUMENTED;
      expect(documented !== left, `${path} must be in API_CATALOG or in NOT_DOCUMENTED, not both and not neither`).toBe(true);
    }
  });

  it('documents no route the Worker does not serve', () => {
    for (const e of API_CATALOG) {
      expect(e.path in CACHE_PARAMS || UNCACHED.includes(e.path), `${e.path} is not a public read route`).toBe(true);
    }
    expect(new Set(API_CATALOG.map((e) => e.path)).size).toBe(API_CATALOG.length);
  });

  it('lists for each route exactly the parameters its edge copy is keyed on', () => {
    for (const e of API_CATALOG) {
      if (!(e.path in CACHE_PARAMS)) continue;
      expect(e.params.map((p) => p.name).sort(), e.path).toEqual([...CACHE_PARAMS[e.path]].sort());
      expect(new Set(e.params.map((p) => p.name)).size, `${e.path} names a parameter twice`).toBe(e.params.length);
    }
    expect(endpointByPath('/api/quote')?.params.map((p) => p.name).sort()).toEqual(['amount', 'side']);
    const addr = endpointByPath('/api/address/{address}');
    expect(addr?.params).toEqual([]);
    expect(addr?.pathParam?.type).toBe('address');
  });

  it('gives every parameter a kind that can be shown, and every choice its values', () => {
    for (const e of API_CATALOG) {
      for (const p of [...e.params, ...(e.pathParam ? [e.pathParam] : [])]) {
        expect(p.what.trim().length, `${e.path} ${p.name}`).toBeGreaterThan(10);
        if (p.type === 'choice') expect(p.values?.length ?? 0, `${e.path} ${p.name} is a choice without values`).toBeGreaterThan(0);
        else expect(p.values, `${e.path} ${p.name} has values but is not a choice`).toBeUndefined();
        if (p.min != null && p.max != null) expect(p.min).toBeLessThanOrEqual(p.max);
      }
    }
  });

  it('names the fields of every JSON answer and none for a file', () => {
    for (const e of API_CATALOG) {
      if (e.csv) expect(Object.keys(e.fields), e.path).toEqual([]);
      else expect(Object.keys(e.fields).length, `${e.path} names no field`).toBeGreaterThan(0);
      for (const [name, what] of Object.entries(e.fields)) expect(what.trim().length, `${e.path} ${name}`).toBeGreaterThan(10);
      expect(API_GROUPS.some((g) => g.id === e.group), e.path).toBe(true);
    }
    for (const g of API_GROUPS) expect(API_CATALOG.some((e) => e.group === g.id), `group ${g.id} is empty`).toBe(true);
  });

  it('uses no word the pages may not use', () => {
    const texts = [
      ...API_GROUPS.flatMap((g) => [g.title, g.lead]),
      ...API_CATALOG.flatMap((e) => [e.title, e.what, ...Object.values(e.fields), ...e.params.map((p) => p.what), ...(e.pathParam ? [e.pathParam.what] : []), ...e.params.map((p) => p.fallback ?? '')]),
      ...API_LIMITS.map((l) => l.what),
      ...Object.values(NOT_DOCUMENTED),
    ];
    for (const t of texts) {
      for (const b of BANNED) expect(b.re.test(t), `"${b.word}" in: ${t}`).toBe(false);
      expect(t.includes('—'), `an em-dash in: ${t}`).toBe(false);
    }
  });
});

describe('the bounds the catalog states against the routes\' own constants', () => {
  const param = (path: string, name: string) => endpointByPath(path)!.params.find((p) => p.name === name)!;
  it('are the constants the Worker reads them from', async () => {
    const api = await import('../worker/src/api');
    expect(param('/api/quote', 'amount').max).toBe(api.QUOTE_MAX_NAM);
    expect(param('/api/flows', 'page').max).toBe(api.PAGE_MAX);
    expect(param('/api/holders', 'page').max).toBe(api.PAGE_MAX);
    expect(param('/api/search', 'limit')).toMatchObject({ max: api.SEARCH_LIMIT_MAX, fallback: String(api.SEARCH_LIMIT) });
    expect(param('/api/export/flows', 'limit')).toMatchObject({ max: api.FLOW_EXPORT_MAX, fallback: String(api.FLOW_EXPORT_MAX) });
    expect(param('/api/export/holders', 'limit')).toMatchObject({ max: api.HOLDER_EXPORT_MAX, fallback: String(api.HOLDER_EXPORT_MAX) });
    expect(param('/api/metrics/history', 'hours').max).toBe(api.HISTORY_MAX_HOURS);
    expect(param('/api/metrics/history', 'key').values).toEqual([...api.HISTORY_KEYS]);
  });

  it('are the numbers the pressure and orderflow routes clamp to', () => {
    const src = read('worker/src/api.ts');
    // /api/pressure: the route's own constants, and how it reads a value outside them or one that is not a number
    expect(param('/api/pressure', 'days')).toMatchObject({ max: PRESSURE_DAYS_MAX, min: PRESSURE_DAYS_MIN, fallback: String(PRESSURE_DAYS_DEFAULT) });
    expect([undefined, '', 'abc', 'NaN', '0', '-3', '1', '30', '365', '9999', '7.9'].map(pressureDays)).toEqual([7, 7, 7, 7, 1, 1, 1, 30, 365, 365, 7]);
    // /api/orderflow: Math.min(24 * 1500, Math.max(1, parseInt(c.req.query('hours') || '720', 10) || 720))
    const hours = /Math\.min\((\d+) \* (\d+), Math\.max\((\d+), parseInt\(c\.req\.query\('hours'\) \|\| '(\d+)'/.exec(src);
    expect(hours, 'the orderflow route no longer clamps hours where the test looks').not.toBeNull();
    expect(param('/api/orderflow', 'hours')).toMatchObject({ max: Number(hours![1]) * Number(hours![2]), min: Number(hours![3]), fallback: hours![4] });
  });
});

describe('the limits the API page states', () => {
  const cfg = read('wrangler.jsonc');
  it('are the ones the Worker is configured with', () => {
    const bound = [...cfg.matchAll(/"name":\s*"([A-Z_]+_LIMITER)"[^}]*"simple":\s*\{\s*"limit":\s*(\d+),\s*"period":\s*(\d+)/g)].map((m) => ({ name: m[1], limit: Number(m[2]), seconds: Number(m[3]) }));
    expect(bound.length).toBeGreaterThanOrEqual(API_LIMITS.length);
    for (const l of API_LIMITS) {
      const b = bound.find((x) => x.name === l.binding);
      expect(b, `${l.binding} is not bound`).toBeDefined();
      expect({ limit: l.limit, seconds: l.seconds }, l.binding).toEqual({ limit: b!.limit, seconds: b!.seconds });
    }
    // every per-address limiter of the documented routes is on the page; the chat's own limiter is the chat's, and the
    // quote service's budget is one count for the whole site, not a limit on a reader's address
    for (const b of bound) if (!['ASK_LIMITER', 'QUOTE_LIMITER'].includes(b.name)) expect(API_LIMITS.some((l) => l.binding === b.name), `${b.name} is not on the page`).toBe(true);
    expect(new Set(API_LIMITS.map((l) => l.binding)).size).toBe(API_LIMITS.length);
  });

  it('sorts the routes as the page says: quotes, address reports and files under the first limit, a text search under the second', () => {
    const kind = (p: string) => limiterFor(new URL(`https://namada.trade${p}`));
    expect(kind('/api/quote?amount=1000&side=sell')).toBe('heavy');
    expect(kind('/api/address/tnam1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq')).toBe('heavy');
    expect(kind('/api/export/flows')).toBe('heavy');
    expect(kind('/api/export/holders')).toBe('heavy');
    expect(kind('/api/search?q=anoma')).toBe('search');
    expect(kind('/api/flows?search=anoma')).toBe('search');
    expect(kind('/api/holders?search=anoma')).toBe('search');
    expect(kind('/api/overview')).toBeNull();
  });
});

describe('/openapi.json', () => {
  const doc = openApiDoc() as any;
  it('is made from the catalog: one GET per documented route, with its parameters and fields', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.version).toBe(PLATFORM_TEXT_CHECKED);
    expect(Object.keys(doc.paths).sort()).toEqual(API_CATALOG.map((e) => e.path).sort());
    for (const e of API_CATALOG) {
      const op = doc.paths[e.path].get;
      expect(op.parameters.map((p: any) => p.name)).toEqual([...(e.pathParam ? [e.pathParam.name] : []), ...e.params.map((p) => p.name)]);
      if (e.pathParam) expect(op.parameters[0]).toMatchObject({ in: 'path', required: true });
      const ok = op.responses['200'];
      if (e.csv) expect(Object.keys(ok.content)).toEqual(['text/csv', 'application/json']);
      else expect(Object.keys(ok.content['application/json'].schema.properties)).toEqual(Object.keys(e.fields));
    }
  });

  it('writes a parameter as the catalog states it', () => {
    expect(paramSchema({ name: 'side', type: 'choice', values: ['buy', 'sell'], what: 'x' })).toEqual({ type: 'string', enum: ['buy', 'sell'] });
    expect(paramSchema({ name: 'limit', type: 'whole', min: 1, max: 100, what: 'x' })).toEqual({ type: 'integer', minimum: 1, maximum: 100 });
    expect(paramSchema({ name: 'q', type: 'text', max: 80, what: 'x' })).toEqual({ type: 'string', maxLength: 80 });
    expect(paramSchema({ name: 'from', type: 'day', what: 'x' })).toEqual({ type: 'string', format: 'date' });
    // a range bound is a time or a day: the Trade page itself sends days
    const when = paramSchema({ name: 'from', type: 'when', what: 'x' }) as { oneOf: { type: string }[] };
    expect(when.oneOf.map((x) => x.type)).toEqual(['integer', 'string']);
    for (const path of ['/api/series', '/api/depth/history']) for (const name of ['from', 'to']) expect(endpointByPath(path)!.params.find((p) => p.name === name)!.type, `${path} ${name}`).toBe('when');
  });

  it('lists the answers a route really gives besides the plain one', () => {
    const codes = (path: string) => Object.keys(doc.paths[path].get.responses).sort();
    // the overview refuses nothing and always answers; a series must be named, and an unknown name is not found
    expect(codes('/api/overview')).toEqual(['200', '429']);
    expect(codes('/api/series')).toEqual(['200', '400', '404', '429']);
    expect(codes('/api/metrics/history')).toEqual(['200', '400', '404', '429']);
    // the depth answers are not found until a reading is stored; the quote also refuses a size it does not take
    expect(codes('/api/depth')).toEqual(['200', '404', '429']);
    expect(codes('/api/depth/owners')).toEqual(['200', '404', '429']);
    expect(codes('/api/depth/quote')).toEqual(['200', '400', '404', '429']);
    expect(codes('/api/health')).toEqual(['200', '429', '503']);
    // a 400 is listed exactly where the catalog's own words say a value is refused or a parameter must be sent
    for (const e of API_CATALOG) expect('400' in doc.paths[e.path].get.responses, e.path).toBe(refuses(e));
    expect(API_CATALOG.filter((e) => e.notFound).map((e) => e.path).sort()).toEqual(['/api/depth', '/api/depth/owners', '/api/depth/quote', '/api/metrics/history', '/api/series', '/api/validators/history']);
  });
});

describe('the platform pages as routes', () => {
  it('are five pages with a path, a question, words and a place in the lists', () => {
    expect(PLATFORM_ROUTES.map((r) => r.path)).toEqual(['/developers', '/status', '/methodology', '/privacy', '/terms']);
    for (const r of PLATFORM_ROUTES) {
      expect(classifyPath(r.path)).toEqual({ kind: 'route', route: r });
      expect(r.index).toBe(true);
      expect(fullTitle(r).length, r.path).toBeLessThanOrEqual(60);
      expect(r.description.length, r.path).toBeLessThanOrEqual(155);
      const copy = BODY[r.id];
      expect(copy?.paras.length, `${r.id} has no words`).toBeGreaterThan(0);
      expect(copy.sections?.length ?? 0, r.id).toBeGreaterThan(1);
      // a page of words carries the day they were checked; the status page states live figures and carries none
      expect(r.updated, r.id).toBe(r.id === 'status' ? undefined : PLATFORM_TEXT_CHECKED);
    }
  });

  it('answer the words people type with a redirect to the page', () => {
    const typed: Record<string, string> = {
      api: '/developers', docs: '/developers', 'api-docs': '/developers', developer: '/developers',
      health: '/status', uptime: '/status',
      method: '/methodology', methods: '/methodology', about: '/methodology',
      'privacy-policy': '/privacy',
      tos: '/terms', 'terms-of-use': '/terms', 'terms-of-service': '/terms', disclaimer: '/terms',
    };
    for (const [from, to] of Object.entries(typed)) {
      expect(ROUTE_ALIASES[from], from).toBe(to);
      expect(classifyPath(`/${from}`), from).toEqual({ kind: 'redirect', to });
      expect(PLATFORM_ROUTES.some((r) => r.path === to), to).toBe(true);
      // an alias never hides a page of its own name
      expect(ROUTES.some((r) => r.path === `/${from}`), from).toBe(false);
    }
  });

  it('are linked from the footer, the API page as a page and not as raw data', () => {
    const footer = read('web/src/app/Footer.tsx');
    const ids = /const LINK_IDS: RouteId\[\] = \[([^\]]+)\]/.exec(footer)?.[1] ?? '';
    for (const r of PLATFORM_ROUTES) expect(ids, r.id).toContain(`'${r.id}'`);
    expect(footer).not.toContain('href="/api/overview"');
  });

  it('keep the copy rules: no banned word, no em-dash, a first sentence under each heading', () => {
    for (const r of PLATFORM_ROUTES) {
      const copy = BODY[r.id];
      const texts = [...copy.paras, ...(copy.sections ?? []).flatMap((s) => [s.h2, ...s.paras])];
      for (const t of texts) {
        for (const b of BANNED) expect(b.re.test(t), `"${b.word}" on ${r.path}: ${t}`).toBe(false);
        expect(t.includes('—'), `an em-dash on ${r.path}`).toBe(false);
      }
      for (const s of copy.sections ?? []) {
        expect(s.h2.endsWith('?'), `${r.path}: "${s.h2}" is not a question`).toBe(true);
        expect(s.paras.length, `${r.path}: "${s.h2}" has no answer`).toBeGreaterThan(0);
      }
    }
  });

  it('are in the sitemap and in llms.txt, with the OpenAPI document under Data', async () => {
    const map = await (await sitemapXml(null)).text();
    const llms = await llmsTxt().text();
    for (const r of PLATFORM_ROUTES) {
      expect(map).toContain(`<loc>https://namada.trade${r.path}</loc>`);
      expect(llms).toContain(`(https://namada.trade${r.path})`);
    }
    expect(map).toContain(`<loc>https://namada.trade/developers</loc><lastmod>${PLATFORM_TEXT_CHECKED}</lastmod>`);
    expect(llms).toContain('https://namada.trade/openapi.json');
  });
});

describe('the server-rendered pages', () => {
  it('the API page lists every documented route with its parameters, for a reader without JavaScript', () => {
    const html = pageHtml(routeByPath('/developers')!, null);
    const list = apiListHtml();
    expect(html).toContain(list);
    for (const e of API_CATALOG) expect(list).toContain(`GET ${e.path}`);
    for (const g of API_GROUPS) expect(list).toContain(g.title.replace(/&/g, '&amp;').replace(/'/g, '&#39;'));
    expect(list).toContain('(parameters: amount, side)');
    // the limits the page's words point to, each route's field names, and the document a program reads
    for (const l of API_LIMITS) expect(list).toContain(`${l.limit} in ${l.seconds} seconds: `);
    expect(list).toContain('(fields: quote, error, code)');
    expect(list).toContain('<a href="/openapi.json"');
    // every platform page is one link away without JavaScript
    for (const r of PLATFORM_ROUTES) expect(html).toContain(`<a href="${r.path}"`);
    expect(html).toContain('<h1');
    expect(html).toContain('How do I read these figures from my own code?');
  });

  it('the status page states its two figures only when they were read', () => {
    const route = routeByPath('/status')!;
    const none = pageHtml(route, null);
    expect(none).not.toContain('Cross-checks that pass');
    const at = Date.UTC(2026, 10, 10, 5, 30);
    const some = pageHtml(route, { checks: { text: 'Cross-checks that pass: 10 of 20', at, source: 'NamadaTrade cross-checks' }, tick: { text: 'The last reading of every source completed', at, source: 'NamadaTrade' } });
    expect(some).toContain('Cross-checks that pass: 10 of 20');
    expect(some).toContain('(NamadaTrade cross-checks, 2026-11-10 05:30 UTC)');
    expect(some).toContain('The last reading of every source completed');
  });
});

describe('the figures the served pages state', () => {
  const at = Date.UTC(2026, 10, 10, 5, 30);
  it('counts a cross-check as passing only while it is current, and states nothing when nothing was read', () => {
    const row = (status: string, ageMs: number, everyMs?: number) => ({ status, detail: everyMs ? JSON.stringify({ everyMs }) : '{}', checked_at: at - ageMs });
    const f = statusFacts([row('ok', 60_000), row('ok', 20 * 60_000), row('ok', 50 * 60_000, 60 * 60_000), row('warn', 60_000), row('idle', 60_000)], at - 30_000, at);
    // the second passed, but ran twenty minutes ago on the usual interval: not counted; the third's own interval is an hour
    expect(f.checks).toEqual({ text: 'Cross-checks that pass: 2 of 5', at: at - 60_000, source: 'NamadaTrade cross-checks' });
    expect(f.tick).toEqual({ text: 'The last reading of every source completed', at: at - 30_000, source: 'NamadaTrade' });
    expect(statusFacts(null, null, at)).toEqual({});
    expect(statusFacts([], undefined, at)).toEqual({});
    expect(statusFacts([row('ok', 0)], null, at).tick).toBeUndefined();
  });

  it('serves a page with figures exactly when its copy lists any', () => {
    const says = (path: string) => statesFigures(routeByPath(path)!);
    expect(says('/')).toBe(true);
    expect(says('/status')).toBe(true);
    // the methodology page carries the day its text was checked and still states live figures under its words
    expect(routeByPath('/methodology')!.updated).toBe(PLATFORM_TEXT_CHECKED);
    expect(says('/methodology')).toBe(true);
    for (const p of ['/developers', '/privacy', '/terms', '/guides', '/settings']) expect(says(p), p).toBe(false);
    for (const r of ROUTES.filter((x) => x.guide)) expect(statesFigures(r), r.path).toBe(false);
  });
});

describe('the cross-checks answer', () => {
  it('carries the last completed reading, null when none is on record and left out when the record could not be read', async () => {
    const get = async (db: unknown) => (await (await app.request('/api/integrity', {}, { DB: db } as any)).json()) as IntegrityResponse;
    const db = testD1();
    const none = await get(db);
    expect('lastTickAt' in none).toBe(true);
    expect(none.lastTickAt).toBeNull();
    const at = Date.UTC(2026, 10, 10, 5, 30);
    await kvSet(db as any, OPS_KV, { ...emptyOps(), lastTickAt: at });
    expect((await get(db)).lastTickAt).toBe(at);
    // the record's read fails (the two rows /api/health reads): the field is left out, not null
    const broken = { ...db, prepare: (sql: string) => { if (sql.includes(OPS_KV)) throw new Error('D1_ERROR'); return (db as any).prepare(sql); } };
    const cut = await get(broken);
    expect('lastTickAt' in cut).toBe(false);
    expect(Array.isArray(cut.checks)).toBe(true);
  });

  it('answers the pressure route for a days value that is not a number, with the window it uses when days is left out', async () => {
    const db = testD1();
    const res = await app.request('/api/pressure?days=abc', {}, { DB: db } as any);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { windowDays: number }).windowDays).toBe(PRESSURE_DAYS_DEFAULT);
  });
});

describe('the privacy page against what the Settings page says is stored', () => {
  const settings = read('web/src/screens/settings/index.tsx');
  const words = BODY.privacy.sections!.flatMap((s) => s.paras).join(' ');
  it('says the same things about each stored item', () => {
    // each sentence of the Settings page's "Your data" list that the privacy page restates, word for word
    for (const sentence of [
      'No IP address and no browser details are stored with them.',
      'every user sees them, signed with your address.',
      'The honest limit: whoever deploys this site could change its code to record them while they are decrypted to send an alert.',
    ]) {
      expect(settings, `the Settings page no longer says: ${sentence}`).toContain(sentence);
      expect(words, `the privacy page does not say: ${sentence}`).toContain(sentence);
    }
    // and each stored item the Settings page lists is named on the privacy page
    for (const item of ['Telegram chat', 'Discord channel link', 'watchlist', 'quiet hours', 'Sessions and keys']) {
      expect(settings).toContain(item);
      expect(words.toLowerCase()).toContain(item.toLowerCase());
    }
  });

  it('says what the delete button and the file really cover', () => {
    const api = read('worker/src/api.ts');
    // the delete: the settings and every session and key, and nothing else (a tag is a row of the public labels table)
    const del = /app\.delete\('\/api\/me', async \(c\) => \{([\s\S]*?)\n\}\);/.exec(api)?.[1] ?? '';
    expect(del).toContain('deleteSettings(');
    expect(del).toContain('revokeAllSessions(');
    expect(del).not.toMatch(/labels|userTag/i);
    expect(settings).toContain('This deletes your settings, your Discord link, every session and every key, on every device.');
    expect(words).toContain('removes your settings, your Discord link, every session and every key, on every device.');
    expect(words).toContain('Tags you wrote on addresses are public and stay.');
    // the file: the route's own note says what it leaves out
    expect(api).toContain("note: 'The Discord webhook URL and the Telegram chat are stored encrypted and are not included.'");
    expect(words).toContain('The Discord channel link is in it only with its middle left out, and of the Telegram chat only whether one is linked and a group\'s name.');
    const st = read('worker/src/settings.ts');
    expect(st).toContain('webhookUrlMasked: url ? `${url.slice(0, 38)}••••${url.slice(-4)}` : null');
    expect(/export function telegramView[\s\S]*?\n\}/.exec(st)?.[0] ?? '').not.toMatch(/chatId:/);
  });

  it('says what the host keeps while the host is set to keep a request log', () => {
    // the Worker's request log is on (wrangler.jsonc observability): the page says so. Turned off, or its query strings
    // redacted, this fails and the page's sentence changes with it.
    const cfg = read('wrangler.jsonc');
    expect(cfg).toMatch(/"observability":\s*\{\s*"enabled":\s*true\s*\}/);
    expect(words).toContain('keeps a log of each request for up to seven days');
    // the hourly count of live connections is a number and nothing else (worker/src/live-hub.ts LIVE_SOCKETS_KEY)
    expect(read('worker/src/live-hub.ts')).toContain("export const LIVE_SOCKETS_KEY = 'site.live_sockets';");
    expect(words).toContain('recorded each hour, as a number and nothing else');
  });

  it('names the chat once the chat is open to readers', () => {
    // The chat is closed (shared/ask-words.ts ASK_SHOWN). The release that opens it adds what the chat counts to the
    // privacy page (worker/src/ask.ts: a day's tag per connection, never the question or the address); this fails then.
    // "question" is a word only the chat's sentence would bring (the page already names the Telegram chat)
    expect(words).not.toMatch(/\bquestions?\b/i);
    expect(!ASK_SHOWN || /\bquestions?\b/i.test(words), 'the chat is open and the privacy page does not say what it counts').toBe(true);
  });
});

describe('the status page', () => {
  it('calls a reading current for as long as /api/health does', async () => {
    const { HEALTH_TICK_MAX_AGE_MS } = await import('../worker/src/ops');
    const m = /const TICK_FRESH_MS = (\d+) \* 60_000;/.exec(read('web/src/screens/seo/Status.tsx'));
    expect(m, 'TICK_FRESH_MS is not where the test looks for it').not.toBeNull();
    expect(Number(m![1]) * 60_000).toBe(HEALTH_TICK_MAX_AGE_MS);
  });
});

describe('every route still has what a page needs', () => {
  it('a distinct path, title and description', () => {
    for (const key of ['path', 'title', 'description'] as const) expect(new Set(ROUTES.map((r) => r[key])).size, key).toBe(ROUTES.length);
  });
});
