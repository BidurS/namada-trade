// The site for a program (worker/src/agents.ts): every indexable page as Markdown at its address with .md and by
// Accept: text/markdown, never a search result of its own; /llms-full.txt; the IndexNow key file; the page's link to
// its Markdown; and the tool server at /mcp (initialize, tools/list, the three tools, its refusals). The Worker's
// fetch handler is driven end to end with a stand-in static host, as test/seo-hosts.test.ts drives it.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROUTES, GUIDE_ROUTES, SITE } from '../shared/routes';
import { GUIDES } from '../shared/guides';
import { API_CATALOG } from '../shared/api-catalog';
import { AGENT_ROUTES, documentedPath, notOffered, markdownPath, markdownRoute, pageMarkdown, wantsMarkdown, MCP_VERSIONS } from '../worker/src/agents';
import { BANNED } from './banned-words';
import { pageHtml, guideHtml, AGENT_NOTES } from '../worker/src/seo';
import { CACHE_PARAMS } from '../worker/src/http';
import { networkStatus } from '../shared/halt';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
const worker = (await import('../worker/src/index')).default as { fetch: (r: Request, e: any, c: any) => Promise<Response> };

const SHELL = readFileSync(join(__dirname, '..', 'web', 'index.html'), 'utf8');
const ctx = { waitUntil() {}, passThroughOnException() {} };
class FakeRewriter {
  private ops: { sel: string; h: { element: (e: any) => void } }[] = [];
  on(sel: string, h: { element: (e: any) => void }) { this.ops.push({ sel, h }); return this; }
  transform(res: Response): Response {
    const ops = this.ops;
    return new Response(new ReadableStream({
      async start(c) {
        let html = await res.text();
        for (const { sel, h } of ops) {
          const act: { append?: string } = {};
          h.element({ setInnerContent() {}, append: (s: string) => { act.append = s; }, remove() {} });
          if (sel === 'head' && act.append != null) html = html.replace('</head>', `${act.append}</head>`);
        }
        c.enqueue(new TextEncoder().encode(html));
        c.close();
      },
    }), { status: res.status, headers: res.headers });
  }
}
const ASSETS = { fetch: async () => new Response(SHELL, { headers: { 'content-type': 'text/html' } }) };
const FACTS = { price: { text: 'NAM price: $0.001020', at: Date.UTC(2026, 10, 10, 9), source: 'Osmosis router quote' } };
let cached: Record<string, unknown> | null = null;
beforeEach(() => {
  cached = null;
  vi.stubGlobal('HTMLRewriter', FakeRewriter);
  vi.stubGlobal('caches', { default: { match: async () => (cached ? new Response(JSON.stringify(cached)) : undefined), put: async () => {} } });
});
const get = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`https://namada.trade${path}`, init), { ASSETS }, ctx);

describe('pages as Markdown', () => {
  it('every indexable page has one, at its address with .md, with its heading, its address and the disclaimer', async () => {
    expect(AGENT_ROUTES.length).toBe(ROUTES.filter((r) => r.index).length);
    for (const r of AGENT_ROUTES) {
      const res = await get(markdownPath(r));
      expect(res.status, r.path).toBe(200);
      expect(res.headers.get('content-type'), r.path).toBe('text/markdown; charset=utf-8');
      expect(res.headers.get('x-robots-tag'), r.path).toBe('noindex');
      expect(res.headers.get('link'), r.path).toBe(`<${SITE.origin}${r.path}>; rel="canonical"`);
      const md = await res.text();
      expect(md.startsWith(`# ${r.h1}\n`), r.path).toBe(true);
      expect(md, r.path).toContain(SITE.disclaimer);
      expect(md, r.path).not.toMatch(/<[a-z][^>]*>/i);
      expect(md, r.path).not.toContain('undefined');
    }
  });

  it('a guide carries every paragraph, its citations numbered and its sources linked', () => {
    for (const r of GUIDE_ROUTES) {
      const g = GUIDES[r.guide!];
      const md = pageMarkdown(r, null);
      for (const p of [...g.lead, ...g.sections.flatMap((s) => s.paras), ...g.faq.flatMap((q) => q.a)]) expect(md, r.path).toContain(p.t);
      for (const s of g.sections) expect(md).toContain(`## ${s.h2}`);
      for (const q of g.faq) expect(md).toContain(`### ${q.q}`);
      for (const src of Object.values(g.sources)) if (md.includes(src.title)) expect(md).toContain(`](${src.url})`);
      expect(md).toMatch(/\n1\. \[/);
      expect(md).toContain(`checked against its sources on ${r.updated}`);
    }
  });

  it('a figure is stated with its source and time, once, and left out when it was not read', async () => {
    cached = FACTS;
    const md = await (await get('/index.md')).text();
    expect(md).toContain('- NAM price: $0.001020 (Osmosis router quote, 2026-11-10 09:00 UTC)');
    expect(md.split('NAM price: $0.001020').length).toBe(2);
    cached = null;
    expect(await (await get('/index.md')).text()).not.toContain('NAM price:');
    // one without the time it was read is left out too, never an error
    const home = AGENT_ROUTES.find((r) => r.path === '/')!;
    expect(pageMarkdown(home, { price: { ...FACTS.price, at: Number.NaN } } as any)).not.toContain('NAM price:');
  });

  it('Accept: text/markdown gives the Markdown at the page\'s own address; a browser still gets the page', async () => {
    expect(wantsMarkdown('text/markdown')).toBe(true);
    expect(wantsMarkdown('text/markdown, text/html;q=0.9')).toBe(true);
    expect(wantsMarkdown('text/html,application/xhtml+xml,*/*;q=0.8')).toBe(false);
    expect(wantsMarkdown('text/html, text/markdown')).toBe(false);
    expect(wantsMarkdown(null)).toBe(false);
    expect(wantsMarkdown('text/markdown;q=0, text/html')).toBe(false);
    expect(wantsMarkdown('*/*, text/markdown;q=0.1')).toBe(true);
    expect(wantsMarkdown('text/html;q=0.5, text/markdown;q=0.9')).toBe(true);
    expect(wantsMarkdown('text/html, text/markdown;q=0.9')).toBe(false);
    for (const a of ['text/markdown;q=abc, text/html', 'text/markdown;q=-1', 'text/markdown; q = 0', 'text/markdown;q="0"']) expect(wantsMarkdown(a), a).toBe(false);
    expect(wantsMarkdown('text/markdown;q=1.0')).toBe(true);
    const md = await get('/guides/what-is-namada', { headers: { accept: 'text/markdown' } });
    expect(md.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(md.headers.get('vary')).toBe('Accept');
    // the page's own address is never marked as not to be listed, whatever is asked of it
    expect(md.headers.get('x-robots-tag')).toBeNull();
    expect(md.headers.get('link')).toBe(`<${SITE.origin}/guides/what-is-namada>; rel="canonical"`);
    const html = await get('/guides/what-is-namada', { headers: { accept: 'text/html' } });
    expect(html.headers.get('content-type')).toContain('text/html');
    expect(html.headers.get('vary')).toContain('Accept');
    expect(await html.text()).toContain(`<link rel="alternate" type="text/markdown" href="${SITE.origin}/guides/what-is-namada.md"`);
    expect(await (await get('/')).text()).toContain(`href="${SITE.origin}/index.md"`);
  });

  it('only pages have Markdown: not the settings page, a list view\'s path, a file probe or a page that does not exist', async () => {
    expect(markdownRoute('/trade.md')?.id).toBe('trade');
    expect(markdownRoute('/index.md')?.path).toBe('/');
    for (const p of ['/settings.md', '/nope.md', '/.md', '/trade/.md', '/README.md', '/pressure.md', '/TRADE.md']) expect(markdownRoute(p), p).toBeNull();
    for (const p of ['/settings.md', '/nope.md', '/README.md']) expect((await get(p)).status, p).toBe(404);
    // the settings page asked for as Markdown is still the page, not indexed
    const s = await get('/settings', { headers: { accept: 'text/markdown' } });
    expect(s.headers.get('content-type')).toContain('text/html');
    // a POST is never answered with Markdown
    expect((await get('/trade.md', { method: 'POST' })).headers.get('content-type')).not.toContain('markdown');
  });

  it('/llms-full.txt holds every page, the guides first, and /llms.txt says how a program reads the site', async () => {
    const full = await (await get('/llms-full.txt')).text();
    const fullRes = await get('/llms-full.txt');
    expect(fullRes.headers.get('x-robots-tag')).toBe('noindex');
    for (const r of AGENT_ROUTES) expect(full, r.path).toContain(`# ${r.h1}\n`);
    expect(full.indexOf(`# ${GUIDE_ROUTES[0].h1}`)).toBeLessThan(full.indexOf(`# ${ROUTES[0].h1}\n`));
    const llms = await (await get('/llms.txt')).text();
    for (const w of ['/llms-full.txt', '/index.md', 'Accept: text/markdown']) expect(llms, w).toContain(w);
    // the tool server is named only once it is live
    for (const t of [llms, full, await (await get('/robots.txt')).text()]) expect(t.includes('/mcp')).toBe(SITE.mcpLive);
    expect(await (await get('/robots.txt')).text()).toContain('/llms-full.txt');
  });

  it('the IndexNow key file is the key, and the home page names who publishes the site', async () => {
    const key = SITE.verify.indexNow;
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    const res = await get(`/${key}.txt`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(key);
    expect((await get(`/${key.slice(0, 31)}0.txt`)).status).toBe(404);
    const home = await (await get('/')).text();
    expect(home).toContain('"@type":"Organization"');
    expect(home).toContain(`"sameAs":["${SITE.x}","${SITE.repo}"]`);
  });
});

describe('a program is told what the pages say, and nothing more', () => {
  // the words of a text, without its markup, its numbers or its addresses: what a reader of either form reads
  const words = (t: string) => t.toLowerCase().replace(/[^a-z]+/g, ' ').trim();
  // an element's accessible name (the related guides' "Related") is said by the page too
  const htmlWords = (h: string) => words(h.replace(/<[a-z]+\b[^>]*\baria-label="([^"]*)"[^>]*>/g, ' $1 ').replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"));
  const mdWords = (l: string) => words(l.replace(/\[([^\]]*)\]\([^)]*\)/g, ' $1 ').replace(/https?:\/\/\S+/g, ' '));

  it('every line of a page\'s Markdown is said by the page as served, with its figures and without', () => {
    for (const f of [null, FACTS as any]) {
      for (const r of AGENT_ROUTES) {
        const html = htmlWords(r.guide ? guideHtml(r) : pageHtml(r, f));
        for (const line of pageMarkdown(r, f).split('\n')) {
          const w = mdWords(line);
          if (w) expect(html, `${r.path}: ${line.slice(0, 120)}`).toContain(w);
        }
      }
    }
  });

  it('/llms-full.txt is the pages\' Markdown under the words of /llms.txt, and nothing else', async () => {
    const full = await (await get('/llms-full.txt')).text();
    const order = [...AGENT_ROUTES.filter((r) => r.guide), ...AGENT_ROUTES.filter((r) => !r.guide)];
    expect(full).toBe(`# ${SITE.name}

> ${SITE.description} ${SITE.disclaimer}

${AGENT_NOTES} Every figure below states its source and the time it was read; a figure that was not read is left out.

${order.map((r) => pageMarkdown(r, null).trimEnd()).join('\n\n---\n\n')}
`);
  });

  it('get_data calls exactly the documented routes that answer a tool result: every route the Worker names is judged by the catalog', () => {
    // every address of the API the Worker's code names, as written in it, and every cached read
    const dir = join(__dirname, '..', 'worker', 'src');
    const named = new Set<string>(Object.keys(CACHE_PARAMS));
    for (const file of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
      for (const m of readFileSync(join(dir, file), 'utf8').matchAll(/['`](\/api\/[a-zA-Z0-9/_.-]*[a-zA-Z0-9])['`]/g)) named.add(m[1]);
    }
    const offered = new Set(API_CATALOG.filter((e) => !notOffered(e.path) && !e.path.includes('{')).map((e) => e.path));
    expect(named.size).toBeGreaterThan(offered.size);
    for (const p of named) expect(documentedPath(p), p).toBe(offered.has(p));
  });

  it('the tool server names only pages and documented routes, and its words are the site\'s', async () => {
    const { mcp } = await import('../worker/src/agents');
    const rpc = async (method: string, params?: unknown) => JSON.stringify(await (await mcp(new Request('https://namada.trade/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }), { ASSETS } as any, async () => new Response('{}'))).json());
    const said = [await rpc('tools/list'), await rpc('tools/call', { name: 'list_pages', arguments: {} }), await rpc('initialize', {})].join('\n');
    const catalog = API_CATALOG.map((e) => e.path);
    for (const [p] of said.matchAll(/(?<![\w.])\/api(?:\/[a-z0-9_{}-]+)*/g)) expect(catalog.some((c) => c === p || c.startsWith(`${p}/`)), p).toBe(true);
    const pages = new Set(AGENT_ROUTES.map((r) => r.path));
    for (const [, p] of said.matchAll(/\\n- (\/[^ ]*) — /g)) expect(pages.has(p), p).toBe(true);
    // while the network is halted, the server's own words say so before anything else is read
    const status = networkStatus();
    if (status) {
      expect(said).toContain(status.said);
      const list = JSON.parse(await rpc('tools/call', { name: 'list_pages', arguments: {} })).result.content[0].text as string;
      expect(list.startsWith(`${status.title}.`)).toBe(true);
    }
  });

  it('while the network is halted, every page\'s Markdown and the full file open with the status the page shows', async () => {
    const status = networkStatus();
    const full = await (await get('/llms-full.txt')).text();
    for (const r of AGENT_ROUTES) {
      const md = pageMarkdown(r, null);
      if (status) { expect(md, r.path).toContain(`**${status.title}.**`); expect(md, r.path).toContain(status.said); }
      else expect(md, r.path).not.toContain('halted');
    }
    if (status) expect(full.split(`**${status.title}.**`).length - 1).toBe(AGENT_ROUTES.length);
  });
});

describe('/mcp', () => {
  const api = vi.fn(async (r: Request) => new Response(JSON.stringify({ path: new URL(r.url).pathname + new URL(r.url).search, ip: r.headers.get('cf-connecting-ip') })));
  const post = async (body: unknown, env: any = { ASSETS }, headers: Record<string, string> = {}) => {
    const { mcp } = await import('../worker/src/agents');
    return mcp(new Request('https://namada.trade/mcp', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }), env, api);
  };
  const call = async (name: string, args: unknown, env?: any) => ((await (await post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, env, { 'cf-connecting-ip': '203.0.113.9' })).json()) as any);

  it('initializes at the client\'s version when it speaks it, else its newest, and lists three read-only tools', async () => {
    const init = (await (await post({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } })).json()) as any;
    expect(init.result.protocolVersion).toBe('2025-06-18');
    expect(init.id).toBe(0);
    expect(init.result.capabilities).toEqual({ tools: {} });
    expect(init.result.serverInfo.name).toBe('namadatrade');
    const other = (await (await post({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '1999-01-01' } })).json()) as any;
    expect(other.result.protocolVersion).toBe(MCP_VERSIONS[0]);
    const tools = ((await (await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()) as any).result.tools;
    expect(tools.map((t: any) => t.name)).toEqual(['list_pages', 'read_page', 'get_data']);
    for (const t of tools) { expect(t.annotations.readOnlyHint).toBe(true); expect(t.annotations.openWorldHint).toBe(t.name === 'get_data'); expect(t.inputSchema.type).toBe('object'); expect(t.description).not.toMatch(BANNED); }
  });

  it('answers a notification with 202 and nothing, a ping with an empty result, an unknown method with -32601', async () => {
    const n = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(n.status).toBe(202);
    expect(await n.text()).toBe('');
    expect(((await (await post({ jsonrpc: '2.0', id: 'a', method: 'ping' })).json()) as any)).toEqual({ jsonrpc: '2.0', id: 'a', result: {} });
    expect(((await (await post({ jsonrpc: '2.0', id: 3, method: 'resources/list' })).json()) as any).error.code).toBe(-32601);
    expect(((await (await post('{not json')).json()) as any).error.code).toBe(-32700);
    expect((await post([{ jsonrpc: '2.0', id: 1, method: 'ping' }])).status).toBe(400);
    expect((await post('x'.repeat(20_000))).status).toBe(413);
    // a version this server does not speak, an id that is no id, a request without a method
    expect((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, undefined, { 'mcp-protocol-version': '2024-11-05' })).status).toBe(400);
    expect((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, undefined, { 'mcp-protocol-version': '2025-06-18' })).status).toBe(200);
    expect((await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, undefined, { 'mcp-protocol-version': '2030-01-01' })).status).toBe(200);
    expect((await post({ jsonrpc: '2.0', id: { a: 1 }, method: 'ping' })).status).toBe(400);
    expect((await post({ jsonrpc: '2.0', id: 4 })).status).toBe(400);
    expect((await post({ jsonrpc: '2.0', id: 4, result: {} })).status).toBe(202);
  });

  it('until the owner turns it on, /mcp is a 404 through the Worker, whatever the method', async () => {
    if (SITE.mcpLive) return;
    for (const init of [{}, { method: 'POST', body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' }, { method: 'OPTIONS' }]) expect((await get('/mcp', init)).status).toBe(404);
  });

  it('once on, a POST through the Worker is answered: initialize, the tool list and a tool call, never stored', async () => {
    if (!SITE.mcpLive) return;
    const send = (body: unknown) => get('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) });
    const init = await send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    expect(init.status).toBe(200);
    expect(init.headers.get('cache-control')).toBe('no-store');
    expect(((await init.json()) as any).result.serverInfo.name).toBe('namadatrade');
    expect((await send({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
    expect(((await (await send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()) as any).result.tools).toHaveLength(3);
    const list = ((await (await send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_pages', arguments: {} } })).json()) as any).result;
    expect(list.isError).toBe(false);
    for (const r of AGENT_ROUTES) expect(list.content[0].text).toContain(`- ${r.path} — `);
  });

  it('a GET is refused with 405 through the Worker, never indexed, and a preflight is allowed', async () => {
    if (!SITE.mcpLive) return;
    const g = await get('/mcp');
    expect(g.status).toBe(405);
    expect(g.headers.get('allow')).toContain('POST');
    expect(g.headers.get('x-robots-tag')).toBe('noindex');
    const o = await get('/mcp', { method: 'OPTIONS' });
    expect(o.status).toBe(204);
    expect(o.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('list_pages names every page; read_page gives its Markdown and refuses what is not a page', async () => {
    const list = (await call('list_pages', {})).result.content[0].text as string;
    for (const r of AGENT_ROUTES) expect(list).toContain(`- ${r.path} — ${r.label}:`);
    const page = await call('read_page', { path: '/guides/how-to-stake-nam' });
    expect(page.result.isError).toBe(false);
    expect(page.result.content[0].text.startsWith('# ')).toBe(true);
    expect((await call('read_page', { path: 'https://namada.trade/trade.md' })).result.content[0].text).toContain(SITE.origin + '/trade');
    expect((await call('read_page', { path: '/' })).result.isError).toBe(false);
    for (const p of ['/settings', '/nope', '', 5, '../etc/passwd', '.md']) expect((await call('read_page', { path: p })).result.isError, String(p)).toBe(true);
    expect((await call('no_such_tool', {})).error.code).toBe(-32602);
    const odd = (await (await post({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: { toString: 1 }, arguments: {} } })).json()) as any;
    expect(odd.error.code).toBe(-32602);
    expect((await call('read_page', { path: { toString: 1 } })).result.isError).toBe(true);
  });

  it('get_data calls only a documented route, with the caller\'s address and its parameters', async () => {
    for (const e of API_CATALOG) expect(documentedPath(e.path.replace(/\{[^}]+\}/, 'tnam1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq')), e.path).toBe(!notOffered(e.path));
    // nothing the URL parser would rewrite into another route passes: a backslash, dot segments, an encoded dot
    for (const p of ['/api/address/..\\..\\overview', '/api/address/..\\..\\ws', '/api/address/%2e%2e', '/api/address/..', '/api/address/.', '/api/export/flows', '/api/export/holders']) {
      expect(documentedPath(p), p).toBe(false);
      expect((await call('get_data', { path: p })).result.isError, p).toBe(true);
    }
    for (const p of ['/api/overview/../holders', '/api/overview?x=1', 'https://other.example/api/overview', '/api/address/a/b', '/ws', '']) expect(documentedPath(p), p).toBe(false);
    api.mockClear();
    const ok = await call('get_data', { path: '/api/flows', query: { limit: 5, kind: 'sell', nested: { a: 1 } } });
    expect(JSON.parse(ok.result.content[0].text)).toEqual({ path: '/api/flows?limit=5&kind=sell', ip: '203.0.113.9' });
    const no = await call('get_data', { path: '/api/nope' });
    expect(no.result.isError).toBe(true);
    expect(api).toHaveBeenCalledTimes(1);
    for (const c of api.mock.calls) expect(new URL(c[0].url).pathname).toBe('/api/flows');
    api.mockResolvedValueOnce(new Response('{"error":"slow down"}', { status: 429 }));
    const limited = await call('get_data', { path: '/api/overview' });
    expect(limited.result.isError).toBe(true);
    expect(limited.result.content[0].text).toContain('429');
    const failing = JSON.stringify({ ok: false, rows: 'z'.repeat(800) });
    api.mockResolvedValueOnce(new Response(failing, { status: 503 }));
    expect((await call('get_data', { path: '/api/health' })).result.content[0].text).toContain(failing);
    for (const p of ['/api/export/flows', '/api/depth/heat']) expect((await call('get_data', { path: p })).result.content[0].text, p).toContain('more than a tool result can hold');
  });

  it('tool calls are counted per address, and an answer too long is refused whole, never cut', async () => {
    let n = 0;
    const keys: string[] = [];
    const env = { ASSETS, SEARCH_LIMITER: { limit: async (o: { key: string }) => { keys.push(o.key); return { success: ++n <= 1 }; } } };
    expect((await call('list_pages', {}, env)).result.isError).toBe(false);
    const second = await call('list_pages', {}, env);
    expect(second.result.isError).toBe(true);
    expect(second.result.content[0].text).toContain('Too many requests');
    expect(keys[0]).toBe('203.0.113.9:/mcp');
    api.mockResolvedValueOnce(new Response('y'.repeat(300_000)));
    const long = (await call('get_data', { path: '/api/holders' })).result;
    expect(long.isError).toBe(true);
    expect(long.content[0].text).toContain('longer than 200,000 bytes');
    expect(long.content[0].text).not.toContain('yyy');
    // a body declared too large is refused before it is read
    const { mcp } = await import('../worker/src/agents');
    let readBody = false;
    const big = new Request('https://namada.trade/mcp', { method: 'POST', headers: { 'content-length': '50000000' }, body: new ReadableStream({ pull(c) { readBody = true; c.enqueue(new Uint8Array(1024)); c.close(); } }, { highWaterMark: 0 }), duplex: 'half' } as any);
    expect((await mcp(big, { ASSETS } as any, api)).status).toBe(413);
    expect(readBody).toBe(false);
  });
});
