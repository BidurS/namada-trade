// Security review (2026-10-19, docs/security-review.md): each block names the finding it guards.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base64, hex } from '@scure/base';
import { app, PAGE_MAX, TAGS_PER_AUTHOR, TAGS_PER_DAY, QUOTE_MAX_NAM, MAX_BODY_BYTES } from '../worker/src/api';
import { cachedApi, rateLimited, isHeavy, isReplay, cacheKeyUrl, CACHEABLE_API, rewoundAt, BROWSER_CACHE } from '../worker/src/http';
import { testD1, insert } from './d1-sqlite';
import {
  createSession, issueNonce, login, loginMessage, verifyNamada, namadaImplicitAddress, createPairCode, claimPairCode, pairKey, sweepAuth, ALERT_CLAIM_KEEP_MS, type Session,
} from '../worker/src/auth';
import { assertLoginMessage } from '../shared/login';
import { chainOf, isRealAddress, HttpError, fetchText } from '../worker/src/util';
import { inlineSql, stmt } from '../worker/src/db';
import { configureAlerts, buildFlowDiscordBody, sendDiscordWhaleAlert, sendDiscordForumAlert, plainMd, BACKOFF_AFTER, FANOUT_DEADLINE_MS, POST_CONCURRENCY } from '../worker/src/sources/discord';
import { saveSettings, defaultPrefs, type StoredSettings } from '../worker/src/settings';
import { appliedUnbonds } from '../worker/src/parse/namada-unbond';
import { parseNamadaBlock } from '../worker/src/parse/namada';
import { namadaStatusAny, blockResults, LIVE_READ } from '../worker/src/sources/namada';
import { admitSocket, MAX_SOCKETS, MAX_SOCKETS_PER_IPV4 } from '../worker/src/ws-admit';
import { clientOf } from '../worker/src/client-key';
import { NAMADA } from '../worker/src/config';
import type { Flow, ForumPost } from '../shared/types';

const D = 86400000;
const NOW = Date.now();
const env = (db: ReturnType<typeof testD1>, extra: Record<string, unknown> = {}) => ({ DB: db, ...extra } as any);
/** A made-up address in the bech32 alphabet (no checksum: enough for chainOf, the shape sign-in and tags accept). */
const A = 'tnam1q' + 'revjewer' + 'x'.repeat(31);
const tok = (s: Session | { error: string }) => ('token' in s ? s.token : '');
const json = (body: unknown, headers: Record<string, string> = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
afterEach(() => vi.unstubAllGlobals());

/** A Map-backed `caches.default`, and a fetchApp that counts its calls. */
function edge() {
  const store = new Map<string, Response>();
  const pending: Promise<unknown>[] = [];
  vi.stubGlobal('caches', { default: { match: async (r: Request) => store.get(r.url)?.clone(), put: async (r: Request, res: Response) => { store.set(r.url, res); } } });
  const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as any;
  const calls: Request[] = [];
  const fetchApp = (r: Request) => { calls.push(r); return new Response('{"a":1}', { status: 200, headers: { 'content-type': 'application/json' } }); };
  return { store, ctx, calls, fetchApp, settle: () => Promise.all(pending) };
}

// ------------------------------------------------------------------ C1: edge cache and limiter bypasses
describe('C1: the edge cache cannot be slipped past', () => {
  it('an Authorization header on a public read still hits the cache', async () => {
    const e = edge();
    await cachedApi(new Request('https://namada.trade/api/overview'), {} as any, e.ctx, e.fetchApp);
    await e.settle();
    const r = await cachedApi(new Request('https://namada.trade/api/overview', { headers: { Authorization: 'Bearer x' } }), {} as any, e.ctx, e.fetchApp);
    expect(r.status).toBe(200);
    expect(e.calls).toHaveLength(1);
  });
  it('the cross-checks and the donation addresses are kept at the edge, keyed on the path alone (external audit, 2026-10-29)', async () => {
    for (const p of ['/api/integrity', '/api/donation']) {
      const e = edge();
      const db = testD1();
      let reads = 0;
      const fetchApp = (r: Request, en: any, c: any) => { reads++; return app.fetch(r, en, c); };
      const first = await cachedApi(new Request(`https://namada.trade${p}`), env(db), e.ctx, fetchApp);
      await e.settle();
      const again = await cachedApi(new Request(`https://namada.trade${p}?r=${Math.random()}`, { headers: { Authorization: 'Bearer x' } }), env(db), e.ctx, fetchApp);
      expect([first.status, again.status], p).toEqual([200, 200]);
      expect(reads, p).toBe(1);
      expect(again.headers.get('cache-control'), p).toBe(BROWSER_CACHE);
      expect(await again.json(), p).toEqual(await first.json());
    }
  });
  it('HEAD is answered from the GET entry with no body, and never stores an empty copy', async () => {
    const e = edge();
    const h = await cachedApi(new Request('https://namada.trade/api/overview', { method: 'HEAD' }), {} as any, e.ctx, e.fetchApp);
    await e.settle();
    expect(h.status).toBe(200);
    expect(await h.text()).toBe('');
    expect(e.calls).toHaveLength(1);
    expect(e.calls[0].method).toBe('GET');
    const stored = e.store.get(cacheKeyUrl(new URL('https://namada.trade/api/overview')));
    expect(await stored!.clone().text()).toBe('{"a":1}');
    await cachedApi(new Request('https://namada.trade/api/overview'), {} as any, e.ctx, e.fetchApp);
    expect(e.calls).toHaveLength(1);
  });
  it('a percent-encoded API path is not found and never reaches the app or the limiter gap', async () => {
    const e = edge();
    for (const p of ['/api/%6fverview', '/api/%73earch?q=x', '/api/%61ddress/osmo1abc', '/api/export/%66lows']) {
      const r = await cachedApi(new Request(`https://namada.trade${p}`), {} as any, e.ctx, e.fetchApp);
      expect(r.status, p).toBe(404);
      expect(r.headers.get('cache-control')).toBe('no-store');
    }
    expect(e.calls).toHaveLength(0);
  });
  it('no cached route reads a session or a request header (so the Authorization rule above is sound)', () => {
    const src = readFileSync(join(__dirname, '..', 'worker', 'src', 'api.ts'), 'utf8');
    const routes = [...src.matchAll(/app\.get\('(\/api\/[^']+)'/g)].map((m) => m[1]);
    let checked = 0;
    for (const route of routes) {
      if (!(CACHEABLE_API.test(route) || route.startsWith('/api/export/'))) continue;
      const rest = src.slice(src.indexOf(`app.get('${route}'`) + 1);
      const end = rest.search(/\napp\.(get|post|put|delete|use)\(/);
      const body = end < 0 ? rest : rest.slice(0, end);
      expect(body, route).not.toContain('sessionFromRequest');
      expect(body, route).not.toContain('c.req.header(');
      checked++;
    }
    expect(checked).toBeGreaterThan(8);
  });
});

// ------------------------------------------------------------------ A1, C2, C14, E2: what is rate limited
describe('A1/C2/C14: writes, quotes and searched holder lists are limited per address', () => {
  const deny = () => ({ limit: vi.fn(async () => ({ success: false })) });
  it('every sign-in, pairing, tag and settings write shares a 30-a-minute bucket per path family', async () => {
    const limiter = deny();
    const post = (p: string, method = 'POST') => rateLimited(new Request(`https://namada.trade${p}`, { method, headers: { 'cf-connecting-ip': '1.2.3.4' } }), { HEAVY_LIMITER: limiter } as any);
    expect((await post('/api/auth/nonce'))?.status).toBe(429);
    expect(limiter.limit).toHaveBeenLastCalledWith({ key: '1.2.3.4:/api/auth' });
    expect((await post('/api/auth/login'))?.status).toBe(429);
    expect((await post('/api/auth/pair/claim'))?.status).toBe(429);
    expect((await post('/api/labels'))?.status).toBe(429);
    expect(limiter.limit).toHaveBeenLastCalledWith({ key: '1.2.3.4:/api/labels' });
    expect((await post('/api/me/settings', 'PUT'))?.status).toBe(429);
    expect((await post('/api/me/settings/test'))?.status).toBe(429);
    expect((await post('/api/me', 'DELETE'))?.status).toBe(429);
    // reads of one's own session and settings are not
    expect(await post('/api/auth/me', 'GET')).toBeNull();
    expect(await post('/api/me/settings', 'GET')).toBeNull();
  });
  it('quotes and searched holder lists are heavy; plain lists and the curve are not', async () => {
    const limiter = deny();
    const get = (p: string) => rateLimited(new Request(`https://namada.trade${p}`, { headers: { 'cf-connecting-ip': '1.2.3.4' } }), { HEAVY_LIMITER: limiter } as any);
    expect((await get('/api/quote?amount=1000&side=sell'))?.status).toBe(429);
    expect(limiter.limit).toHaveBeenLastCalledWith({ key: '1.2.3.4:/api/quote' });
    expect((await get('/api/holders?search=zz'))?.status).toBe(429);
    expect(await get('/api/holders?chain=namada')).toBeNull();
    expect(await get('/api/quote/curve')).toBeNull();
    expect(isHeavy(new URL('https://namada.trade/api/overview'))).toBe(false);
  });
  it('rewound reads and metric histories are limited on a cache miss only', async () => {
    const e = edge();
    const limiter = deny();
    const envR = { REPLAY_LIMITER: limiter } as any;
    expect((await cachedApi(new Request('https://namada.trade/api/overview?at=1'), envR, e.ctx, e.fetchApp)).status).toBe(429);
    expect((await cachedApi(new Request('https://namada.trade/api/metrics/history?hours=9600'), envR, e.ctx, e.fetchApp)).status).toBe(429);
    expect(e.calls).toHaveLength(0);
    expect((await cachedApi(new Request('https://namada.trade/api/overview'), envR, e.ctx, e.fetchApp)).status).toBe(200);
    await e.settle();
    expect(e.calls).toHaveLength(1);
    expect(limiter.limit).toHaveBeenCalledTimes(2);
    // a stored copy answers a rewound read without consulting the limiter
    const e2 = edge();
    await cachedApi(new Request('https://namada.trade/api/overview?at=1'), {} as any, e2.ctx, e2.fetchApp);
    await e2.settle();
    const limiter2 = deny();
    expect((await cachedApi(new Request('https://namada.trade/api/overview?at=1'), { REPLAY_LIMITER: limiter2 } as any, e2.ctx, e2.fetchApp)).status).toBe(200);
    expect(limiter2.limit).not.toHaveBeenCalled();
    expect(isReplay(new URL('https://namada.trade/api/alerts/recent?since=5'))).toBe(true);
    // without the binding nothing is limited (local dev, tests)
    expect((await cachedApi(new Request('https://namada.trade/api/overview?at=2'), {} as any, e.ctx, e.fetchApp)).status).toBe(200);
  });
});

// ------------------------------------------------------------------ HYG: API answer headers
describe('HYG: API answers are never stored by a browser unless they are public reads', () => {
  it('a sign-in answer is no-store and nosniff; a public read keeps its browser lifetime', async () => {
    const e = edge();
    const me = await cachedApi(new Request('https://namada.trade/api/auth/me'), {} as any, e.ctx, () => new Response('{}', { status: 200 }));
    expect(me.headers.get('cache-control')).toBe('no-store');
    expect(me.headers.get('x-content-type-options')).toBe('nosniff');
    const pub = await cachedApi(new Request('https://namada.trade/api/pools'), {} as any, e.ctx, e.fetchApp);
    expect(pub.headers.get('cache-control')).toBe('public, max-age=5');
    expect(pub.headers.get('x-content-type-options')).toBe('nosniff');
  });
  it('an error carries no key, even when the whole object is serialised', () => {
    const err = new HttpError(403, 'https://api.keplr.app/rpc/osmosis/keplr_abc123/status', 'x');
    expect(err.url).not.toContain('keplr_abc123');
    expect(err.message).not.toContain('keplr_abc123');
    expect(JSON.stringify(err)).not.toContain('keplr_abc123');
  });
});

// ------------------------------------------------------------------ A1/A6: request bodies and the nonce row
describe('A1/A6: bodies are bounded and malformed ones get the route\'s own answer', () => {
  const nonces = (db: ReturnType<typeof testD1>) => db.raw.prepare("SELECT COUNT(*) n FROM kv WHERE key LIKE 'authnonce:%'").get().n;
  it('a body over the cap is refused before a row is written', async () => {
    const db = testD1();
    const res = await app.request('/api/auth/nonce', json({ address: 'tnam1' + 'q'.repeat(MAX_BODY_BYTES) }), env(db));
    expect(res.status).toBe(413);
    expect(((await res.json()) as any).error).toMatch(/too large/);
    expect(nonces(db)).toBe(0);
  });
  it('the nonce row takes a real address shape only, and the message is the shared template', async () => {
    const db = testD1();
    expect((await app.request('/api/auth/nonce', json({ address: 'tnam1' + '!'.repeat(50) }), env(db))).status).toBe(400);
    expect((await app.request('/api/auth/nonce', json({ address: 'tnam1' + 'q'.repeat(2000) }), env(db))).status).toBe(400);
    expect(nonces(db)).toBe(0);
    const ok = await app.request('/api/auth/nonce', json({ address: A }), env(db));
    expect(ok.status).toBe(200);
    const b = (await ok.json()) as any;
    expect(b.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(b.message).toBe(loginMessage(A, b.nonce));
    expect(nonces(db)).toBe(1);
  });
  it('a JSON body of null or an array never gives a 500', async () => {
    const db = testD1();
    const key = base64.encode(new Uint8Array(32).fill(7));
    const s = await createSession(db as any, A, 'namada', 'namada');
    const auth = { Authorization: `Bearer ${tok(s)}` };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const body of ['null', '[]', '{', '']) {
      expect((await app.request('/api/auth/nonce', json(body), env(db))).status, body).toBe(400);
      expect((await app.request('/api/auth/login', json(body), env(db))).status, body).toBe(401);
      expect((await app.request('/api/auth/pair/claim', json(body), env(db, { SETTINGS_KEY: key }))).status, body).toBe(400);
      expect((await app.request('/api/labels', json(body, auth), env(db))).status, body).toBe(400);
      expect((await app.request('/api/me/settings', { ...json(body, auth), method: 'PUT' }, env(db, { SETTINGS_KEY: key }))).status, body).toBe(200);
    }
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
  it('chainOf bounds the length and keeps the 63-character Osmosis contract form', () => {
    expect(chainOf('osmo147h5x9pcj7lm0cttlaefx6sqq5vdfnmwfcqxkmjd7exqm9gc7grqhr75m0')).toBe('osmosis');
    expect(chainOf('osmo1' + 'q'.repeat(81))).toBeNull();
    expect(chainOf('tnam1' + 'q'.repeat(81))).toBeNull();
    expect(chainOf(NAMADA.internal.masp)).toBe('namada');
  });
});

// ------------------------------------------------------------------ B4, C2: page and amount caps
describe('B4/C2: page and quote size are refused beyond their caps, never passed to SQLite or Osmosis', () => {
  it('?page= beyond the cap answers 400 as JSON', async () => {
    const db = testD1();
    for (const p of ['99999999999999999999', String(PAGE_MAX + 1), '1' + '0'.repeat(400)]) {
      const f = await app.request(`/api/flows?page=${p}`, {}, env(db));
      expect(f.status, p).toBe(400);
      expect(((await f.json()) as any).error).toMatch(/page must be/);
      expect((await app.request(`/api/holders?chain=namada&page=${p}`, {}, env(db))).status, p).toBe(400);
    }
    expect((await app.request(`/api/flows?page=${PAGE_MAX}`, {}, env(db))).status).toBe(200);
  });
  it('a quote for an impossible size costs no Osmosis call', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', f);
    for (const q of ['amount=1e303&side=sell', 'amount=Infinity&side=buy', `amount=${QUOTE_MAX_NAM * 10}&side=sell`, 'amount=10&side=steal']) {
      const r = await app.request(`/api/quote?${q}`, {}, env(testD1()));
      expect(r.status, q).toBe(400);
      const b = (await r.json()) as any;
      expect(b.quote).toBeNull();
      expect(b.error).not.toMatch(/http|[0-9]{3}/);
    }
    expect(f).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------ C3: intel is served from the cron's copy
describe('C3: a visitor never makes the forum and the indexer answer', () => {
  it('serves the kept copy whatever its age, and reads live only when there is none', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', f);
    const db = testD1();
    insert(db, 'kv', [{ key: 'intel.cache', value: JSON.stringify({ topics: [{ id: 1, title: 'seeded' }], latestPosts: [], proposals: [], validators: [], indexerEpoch: 1, fetchedAt: NOW - 3 * D }), updated_at: NOW - 3 * D }]);
    for (const p of ['/api/intel', '/api/intel?refresh=true']) {
      const r = await app.request(p, {}, env(db));
      expect(((await r.json()) as any).topics[0].title).toBe('seeded');
    }
    expect(f).not.toHaveBeenCalled();
    await app.request('/api/intel', {}, env(testD1()));
    expect(f).toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------ A3, A4, A13: sign-in
describe('A3/A4/A13: sign-in', () => {
  const keypair = () => {
    const sk = ed25519.utils.randomSecretKey();
    const pkBorsh = new Uint8Array([0, ...ed25519.getPublicKey(sk)]);
    return { sk, pkBorsh, address: namadaImplicitAddress(pkBorsh) };
  };
  const signed = (sk: Uint8Array, message: string) => '00' + hex.encode(ed25519.sign(sha256(new TextEncoder().encode(message)), sk));
  it('a bad signature is refused before the indexer is asked; a good one asks it once', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ publicKey: null }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', f);
    const { sk, pkBorsh, address } = keypair();
    const message = loginMessage(address, 'a'.repeat(32));
    expect(await verifyNamada(address, message, hex.encode(pkBorsh), hex.encode(new Uint8Array(64)))).toMatch(/does not verify/);
    expect(f).not.toHaveBeenCalled();
    expect(await verifyNamada(address, message, hex.encode(pkBorsh), signed(sk, message))).toBeNull();
    expect(f).toHaveBeenCalledTimes(1);
    expect(String(f.mock.calls[0][0])).toContain(`/revealed-public-key/${address}`);
  });
  it('a nonce signs in once, even when two logins race on it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ publicKey: null }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const db = testD1();
    const { sk, pkBorsh, address } = keypair();
    const { nonce, message } = await issueNonce(db as any, address);
    const body = { address, nonce, pubkey: hex.encode(pkBorsh), signature: signed(sk, message) };
    const [a, b] = await Promise.all([login(db as any, body), login(db as any, body)]);
    expect([a.session, b.session].filter(Boolean)).toHaveLength(1);
    expect((await login(db as any, body)).error).toMatch(/expired or was already used/);
    expect(db.raw.prepare("SELECT COUNT(*) n FROM kv WHERE key LIKE 'session:%'").get().n).toBe(1);
  });
  it('the browser signs only the sign-in template for its own address', () => {
    const nonce = 'b'.repeat(32);
    expect(() => assertLoginMessage(A, nonce, loginMessage(A, nonce))).not.toThrow();
    expect(() => assertLoginMessage(A, nonce, loginMessage(A, nonce) + '\nSend 100 NAM')).toThrow(/not the expected/);
    expect(() => assertLoginMessage(A, 'short', loginMessage(A, 'short'))).toThrow(/one-time number/);
    expect(() => assertLoginMessage(`${A}\nX`, nonce, loginMessage(`${A}\nX`, nonce))).toThrow(/valid address/);
    expect(() => assertLoginMessage(A, nonce, loginMessage('tnam1qother', nonce))).toThrow();
  });
});

// ------------------------------------------------------------------ A5: pair codes
describe('A5: pair codes', () => {
  const PK = base64.encode(new Uint8Array(32).fill(7));
  it('a device shows one live code: a new one retires the old; a code pairs once even when two claims race', async () => {
    const db = testD1();
    const s = (await createSession(db as any, A, 'namada', 'namada')) as Session;
    const first = await createPairCode(db as any, s, PK);
    const second = await createPairCode(db as any, s, PK);
    expect('code' in first && 'code' in second).toBe(true);
    expect(db.raw.prepare("SELECT COUNT(*) n FROM kv WHERE key LIKE 'pair:%'").get().n).toBe(1);
    expect((await claimPairCode(db as any, (first as any).code, PK)).error).toMatch(/expired or already used/);
    const code = (second as any).code as string;
    const [x, y] = await Promise.all([claimPairCode(db as any, code, PK), claimPairCode(db as any, code, PK)]);
    expect([x.session, y.session].filter(Boolean)).toHaveLength(1);
  });
  it('a colliding draw never overwrites another device\'s live code', async () => {
    const db = testD1();
    const sA = (await createSession(db as any, A, 'namada', 'namada')) as Session;
    const sB = (await createSession(db as any, 'osmo1' + 'b'.repeat(38), 'osmosis', 'keplr')) as Session;
    const spy = vi.spyOn(crypto, 'getRandomValues').mockImplementation(((arr: Uint8Array) => { arr.fill(0xab); return arr; }) as any);
    try {
      const a = await createPairCode(db as any, sA, PK);
      expect(a).toEqual({ code: 'ABABABAB', expiresAt: expect.any(Number) });
      const b = await createPairCode(db as any, sB, PK);
      expect('error' in b).toBe(true);
      expect(JSON.parse(db.raw.prepare('SELECT value FROM kv WHERE key = ?').get(pairKey(PK, 'ABABABAB')).value).address).toBe(A);
      const res = await app.request('/api/auth/pair', { method: 'POST', headers: { Authorization: `Bearer ${sB.token}` } }, env(db, { SETTINGS_KEY: PK }));
      expect(res.status).toBe(503);
    } finally { spy.mockRestore(); }
  });
});

// ------------------------------------------------------------------ E2: user tags
describe('E2: user tags are bounded and never read as links', () => {
  const signedIn = async (db: ReturnType<typeof testD1>, address = A) => tok(await createSession(db as any, address, 'namada', 'namada'));
  const post = (db: any, token: string, body: unknown) => app.request('/api/labels', json(body, { Authorization: `Bearer ${token}` }), env(db));
  const addr = (i: number) => ('tnam1q' + [...String(i)].map((d) => 'acdefghjkl'[+d]).join('')).padEnd(45, 'q');
  it('links, hidden characters and protocol accounts are refused', async () => {
    const db = testD1();
    const t = await signedIn(db);
    const bad = ['claim at https://x.invalid', 'www.x.invalid', 'see x.invalid/claim', 'fine​name', 'fine‮name'];
    for (const label of bad) expect((await post(db, t, { address: addr(1), label, category: 'watch' })).status, label).toBe(400);
    expect((await post(db, t, { address: addr(1), label: 'ok', note: 'go to https://x.invalid', category: 'watch' })).status).toBe(400);
    expect((await post(db, t, { address: NAMADA.internal.masp, label: 'mine', category: 'watch' })).status).toBe(409);
    expect(db.raw.prepare('SELECT COUNT(*) n FROM labels').get().n).toBe(0);
    expect((await post(db, t, { address: addr(1), label: 'my whale (v2.0)', category: 'watch' })).status).toBe(200);
  });
  it('a wallet tags at most TAGS_PER_AUTHOR addresses; editing its own tag is never counted', async () => {
    const db = testD1();
    const t = await signedIn(db);
    insert(db, 'labels', Array.from({ length: TAGS_PER_AUTHOR }, (_, i) => ({ address: addr(100 + i), chain: 'namada', label: `t${i}`, category: 'watch', source: 'user', author: A, updated_at: NOW - 2 * D })));
    const res = await post(db, t, { address: addr(1), label: 'one more', category: 'watch' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toMatch(/at most/);
    expect((await post(db, t, { address: addr(100), label: 'renamed', category: 'watch' })).status).toBe(200);
  });
  it('the site takes TAGS_PER_DAY new tags a day in all', async () => {
    const db = testD1();
    const t = await signedIn(db);
    insert(db, 'labels', Array.from({ length: TAGS_PER_DAY }, (_, i) => ({ address: addr(1000 + i), chain: 'namada', label: `t${i}`, category: 'watch', source: 'user', author: 'tnam1qotherxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', updated_at: NOW - 60000, created_at: NOW - 60000 })));
    const res = await post(db, t, { address: addr(1), label: 'one more', category: 'watch' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toMatch(/paused/);
  });

  // security review, 2026-10-22: the caps were two counts before an unconditional insert, and the day's count read
  // updated_at, which a re-save renews
  const other = 'tnam1qotherxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const fill = (db: ReturnType<typeof testD1>, n: number, created: number, updated = created, from = 5000) =>
    insert(db, 'labels', Array.from({ length: n }, (_, i) => ({ address: addr(from + i), chain: 'namada', label: `t${i}`, category: 'watch', source: 'user', author: other, updated_at: updated, created_at: created })));
  const userTags = (db: ReturnType<typeof testD1>) => (db.raw.prepare("SELECT COUNT(*) n FROM labels WHERE source = 'user'").get() as { n: number }).n;
  it('concurrent new tags never pass the day\'s cap together: the insert counts it', async () => {
    const db = testD1();
    fill(db, TAGS_PER_DAY - 1, NOW - 60_000);
    const tokens = await Promise.all(Array.from({ length: 20 }, (_, i) => signedIn(db, addr(9000 + i))));
    const res = await Promise.all(tokens.map((t, i) => post(db, t, { address: addr(100 + i), label: `new ${i}`, category: 'watch' })));
    expect(res.filter((r) => r.status === 200)).toHaveLength(1);
    expect(userTags(db)).toBe(TAGS_PER_DAY);
  });
  it('a re-saved tag keeps its first-write time: re-saving never renews its place in the day, and an edit is never counted', async () => {
    const db = testD1();
    // the whole day's allowance written 23 h ago and re-saved just now
    fill(db, TAGS_PER_DAY, NOW - 23 * 3_600_000, NOW - 1000);
    const t = await signedIn(db);
    expect((await post(db, t, { address: addr(1), label: 'new', category: 'watch' })).status).toBe(400);
    // 2 h later the first writes are past 24 h: a new tag is taken, though every row was re-saved within the day
    db.raw.prepare("UPDATE labels SET created_at = created_at - 2 * 3600000 WHERE source = 'user'").run();
    expect((await post(db, t, { address: addr(1), label: 'new', category: 'watch' })).status).toBe(200);
    // the day full again: editing one's own tag still goes through, and keeps its first-write time
    fill(db, TAGS_PER_DAY, NOW - 60_000, NOW - 60_000, 6000);
    const before = db.raw.prepare('SELECT created_at FROM labels WHERE address = ?').get(addr(1)) as { created_at: number };
    expect((await post(db, t, { address: addr(1), label: 'renamed', category: 'bot' })).status).toBe(200);
    expect((db.raw.prepare('SELECT label, created_at FROM labels WHERE address = ?').get(addr(1)) as any)).toEqual({ label: 'renamed', created_at: before.created_at });
  });
  it('a count that cannot run fails the write (500), never admits the tag', async () => {
    const db = testD1();
    const t = await signedIn(db);
    const prepare = db.prepare;
    (db as any).prepare = (sql: string) => (/labels_user_created/.test(sql) && /INSERT/.test(sql) ? { bind: () => ({ run: () => Promise.reject(new Error('D1_ERROR: simulated')) }) } : prepare(sql));
    const res = await post(db, t, { address: addr(2), label: 'x', category: 'watch' });
    expect(res.status).toBe(500);
    (db as any).prepare = prepare;
    expect(userTags(db)).toBe(0);
  });
  it('the cron\'s pool label replaces a tag a wallet wrote first on that address, and the tag\'s author goes', async () => {
    const db = testD1();
    const t = await signedIn(db);
    const P = 'osmo1' + 'q'.repeat(58);
    expect((await post(db, t, { address: P, label: 'my favourite', category: 'whale' })).status).toBe(200);
    const s = stmt.label(P, 'osmosis', 'Pool #3999', 'pool', 'auto', null, NOW);
    db.raw.prepare(s.sql).run(...(s.params as any[]));
    expect(db.raw.prepare('SELECT label, category, source, author FROM labels WHERE address = ?').get(P)).toEqual({ label: 'Pool #3999', category: 'pool', source: 'auto', author: null });
    // any other curated label still never replaces a tag
    const q = 'osmo1' + 'z'.repeat(38);
    expect((await post(db, t, { address: q, label: 'mine', category: 'watch' })).status).toBe(200);
    const g = stmt.label(q, 'osmosis', 'Somebody', 'exchange', 'auto', null, NOW);
    db.raw.prepare(g.sql).run(...(g.params as any[]));
    expect((db.raw.prepare('SELECT source FROM labels WHERE address = ?').get(q) as any).source).toBe('user');
  });
});

// ------------------------------------------------------------------ B1, C6: Discord
describe('B1/C6: Discord posts name no one, render no hidden link, and fan out within bounds', () => {
  const KEY = base64.encode(new Uint8Array(32).fill(9));
  const user = (address: string, webhookUrl: string): StoredSettings => {
    const s: StoredSettings = { address, notifications: defaultPrefs(), channels: { discord: { enabled: true, webhookUrl } }, createdAt: NOW, updatedAt: NOW };
    s.notifications.rules.big_swap = { on: true, thresholdNam: 1 };
    return s;
  };
  const sell = (n: number): Flow => ({ id: `osmosis:SR${n}:0`, chain: 'osmosis', height: n, ts: NOW, txHash: `SR${n}`, kind: 'sell', from: 'osmo1yl6hdjhmkf37639730gffanpzndzdpmhxy9ep3', to: null, amount: 12, meta: null });
  it('every body carries allowed_mentions: none, and outsiders\' text cannot carry a masked link', async () => {
    const f = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', f);
    const post: ForumPost = { id: 990001, topicId: 1, topicTitle: 'Hello [x](https://evil.invalid)', topicSlug: 't', postNumber: 2, url: 'https://forum.namada.net/t/t/1/2', username: 'u', displayName: '[claim](https://evil.invalid)', avatarUrl: null, createdAt: '2026-01-01T00:00:00Z', excerpt: 'Claim your NAM: [namada.trade/claim](https://evil.invalid/c)', isNewTopic: false };
    await sendDiscordForumAlert('https://discord.com/api/webhooks/9/zzz', post, undefined);
    expect(f).toHaveBeenCalledTimes(1);
    const body = JSON.parse((f.mock.calls[0] as any)[1].body);
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.embeds[0].description).not.toContain('](https://evil');
    expect(body.embeds[0].description).toContain('[Read on forum.namada.net](https://forum.namada.net/t/t/1/2)');
    expect(body.embeds[0].title).not.toContain('](https://evil');
    expect(JSON.stringify(body.embeds[0])).not.toContain('](https://evil');
    expect(plainMd('a [b](c) d')).toBe('a [b] (c) d');
  });
  it('a free-text bridge receiver stays inside its code span, is marked as not an address, and is never a link', () => {
    for (const to of ['`**FAKE**` [a](http://e.v)@everyone', '[a](http://e.v)', 'http://e.v/aaaa']) {
      const body = buildFlowDiscordBody({ ...sell(1), kind: 'ibc_out', to, toLabel: 'tag [x](http://e.v)' } as Flow, {});
      const e = body.embeds[0];
      const line1 = String(e.description).split('\n')[0];
      expect(line1.split('`').length - 1).toBe(2);
      expect(line1).toContain('(not an address)');
      expect(line1).not.toContain('](http');
      // the sender is the bridge's own account, which stands for the other end: named as such, not as free text
      expect(line1).toMatch(/^From a sender on Osmosis this record does not name to `/);
      // no page on the site and no title link for text that is not an address: the record on an explorer stands
      expect(e.url).toBe('https://www.mintscan.io/osmosis/tx/SR1');
      expect(JSON.stringify(e)).not.toContain('activity?addr=');
      expect(JSON.stringify(e)).not.toMatch(/\]\(http:\/\/e\.v/);
    }
  });
  it('one post per webhook however many users share it; the claim is made before any post', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => { calls.push(String(u)); return new Response(null, { status: 204 }); }));
    const db = testD1();
    configureAlerts(KEY);
    const url = 'https://discord.com/api/webhooks/1/shared';
    for (let i = 0; i < 3; i++) await saveSettings(db as any, KEY, user(`tnam1qshare${i}${'q'.repeat(33)}`, url));
    await saveSettings(db as any, KEY, user(`tnam1qalone${'q'.repeat(34)}`, 'https://discord.com/api/webhooks/2/alone'));
    await sendDiscordWhaleAlert(undefined, sell(1), db as any, 10000);
    expect(calls.filter((u) => u === url)).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(db.raw.prepare("SELECT COUNT(*) n FROM kv WHERE key = 'alert:flow:osmosis:SR1:0'").get().n).toBe(1);
    expect(POST_CONCURRENCY).toBeLessThanOrEqual(6);
    expect(FANOUT_DEADLINE_MS).toBeLessThanOrEqual(20_000);
  });
  it('a webhook that keeps failing is left alone, and the posts not sent are recorded', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => { calls.push(String(u)); return new Response(null, { status: 404 }); }));
    const db = testD1();
    configureAlerts(KEY);
    const url = 'https://discord.com/api/webhooks/3/gone';
    await saveSettings(db as any, KEY, user(`tnam1qgone${'q'.repeat(35)}`, url));
    for (let n = 10; n < 10 + BACKOFF_AFTER; n++) await sendDiscordWhaleAlert(undefined, sell(n), db as any, 10000);
    expect(calls).toHaveLength(BACKOFF_AFTER);
    await sendDiscordWhaleAlert(undefined, sell(99), db as any, 10000);
    expect(calls).toHaveLength(BACKOFF_AFTER);
    const skipped = JSON.parse(db.raw.prepare("SELECT value FROM kv WHERE key = 'alerts.skipped'").get().value);
    expect(skipped.total).toBe(1);
    expect(skipped.last.what).toContain('osmosis:SR99:0');
  });
});

// ------------------------------------------------------------------ C7: parsers never throw on a node's shapes
describe('C7: a shape the parsers do not expect reads as nothing, never as an unreadable block', () => {
  const blk = (events: any[]) => ({ height: 1, ts: NOW, events });
  it('appliedUnbonds and attrs() survive null batches, odd keys and missing attributes', () => {
    const applied = (attributes: any) => ({ type: 'tx/applied', attributes });
    expect(appliedUnbonds(blk([applied([{ key: 'hash', value: 'AB' }, { key: 'batch', value: 'null' }])]))).toEqual([]);
    expect(appliedUnbonds(blk([applied([{ key: 'batch', value: '{"X":{"Ok":{"changed_keys":5}}}' }])]))).toEqual([]);
    expect(appliedUnbonds(blk([applied([{ key: 'batch', value: '{"X":{"Ok":{"changed_keys":[null,{"segments":7}]}}}' }])]))).toEqual([]);
    expect(appliedUnbonds(blk([applied([{ key: 'hash', value: 5 }, { key: 'batch', value: '[]' }])]))).toEqual([]);
    expect(appliedUnbonds(blk([{ type: 'tx/applied' }, null]))).toEqual([]);
    expect(() => parseNamadaBlock(blk([{ type: 'token/transfer' }, { type: 'token/transfer', attributes: [{ key: 'x', value: 5 }] }]) as any, null)).not.toThrow();
  });
});

// ------------------------------------------------------------------ C8/C9: the live scan's reads fail over
describe('C8/C9: the live scan asks the next node when one is down or answers without a result', () => {
  const status = { result: { sync_info: { latest_block_height: '8316540', latest_block_time: '2026-10-19T00:00:00Z', catching_up: false, earliest_block_height: '1' } } };
  it('the head comes from the second node when the first refuses', async () => {
    const f = vi.fn(async (u: string) => (String(u).includes('5elementsnodes') ? Promise.reject(new Error('refused')) : new Response(JSON.stringify(status), { status: 200 })));
    vi.stubGlobal('fetch', f);
    const st = await namadaStatusAny(LIVE_READ);
    expect(st.provider).toBe('Papadritta');
    expect(st.height).toBe(8316540);
    expect(f).toHaveBeenCalledTimes(2);
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('down'))));
    await expect(namadaStatusAny(LIVE_READ)).rejects.toThrow();
  });
  it('an answer without a result is no answer: the next node is asked', async () => {
    const f = vi.fn(async (u: string) => new Response(JSON.stringify(String(u).includes('5elementsnodes') ? {} : { result: { txs_results: [{ events: [{ type: 'x', attributes: [] }] }] } }), { status: 200 }));
    vi.stubGlobal('fetch', f);
    const b = await blockResults(7, NOW, LIVE_READ);
    expect(b.events).toHaveLength(1);
    expect(f).toHaveBeenCalledTimes(2);
    expect(LIVE_READ).toEqual({ timeoutMs: 10000, retries: 0 });
  });
});

// ------------------------------------------------------------------ C10: live feed admission
describe('C10: the live feed admits a bounded number of sockets', () => {
  it('refuses at the global cap and at the per-address cap', () => {
    // per client: an IPv4 address here (IPv6 by its /64 and /48: test/client-key.test.ts)
    const c = clientOf('203.0.113.7');
    expect(admitSocket(0, c, 0)).toBe('ok');
    expect(admitSocket(MAX_SOCKETS - 1, c, 0)).toBe('ok');
    expect(admitSocket(MAX_SOCKETS, c, 0)).toBe('full');
    expect(admitSocket(10, c, MAX_SOCKETS_PER_IPV4 - 1)).toBe('ok');
    expect(admitSocket(10, c, MAX_SOCKETS_PER_IPV4)).toBe('ip');
    expect(MAX_SOCKETS).toBeLessThanOrEqual(1000);
    expect(MAX_SOCKETS_PER_IPV4).toBeGreaterThanOrEqual(8);
  });
});

// ------------------------------------------------------------------ HYG: kv sweeps
describe('HYG: the sweep drops old alert claims through the index, and keeps live rows', async () => {
  it('old alert rows go, new ones and live sessions stay; the delete is a key range search', async () => {
    const db = testD1();
    const live = (await createSession(db as any, A, 'namada', 'namada')) as Session;
    insert(db, 'kv', [
      { key: 'alert:flow:old', value: '1', updated_at: NOW - ALERT_CLAIM_KEEP_MS - D },
      { key: 'alert:flow:new', value: '1', updated_at: NOW },
    ]);
    await sweepAuth(db as any);
    expect(db.raw.prepare("SELECT key FROM kv WHERE key LIKE 'alert:%'").all().map((r: any) => r.key)).toEqual(['alert:flow:new']);
    expect(db.raw.prepare("SELECT COUNT(*) n FROM kv WHERE key = ?").get(`session:${hex.encode(sha256(new TextEncoder().encode(live.token)))}`).n).toBe(1);
    const plan = db.raw.prepare("EXPLAIN QUERY PLAN DELETE FROM kv WHERE (key >= 'alert:' AND key < 'alert;') AND updated_at < 0").all() as any[];
    expect(plan[0].detail).toMatch(/^SEARCH/);
  });
});

// ------------------------------------------------------------------ E1 (partial), B5: addresses and generated SQL
describe('E1/B5: only real addresses link accounts; generated SQL keeps every byte', () => {
  it('a string that only looks like an address fails the checksum', () => {
    expect(isRealAddress(NAMADA.internal.masp)).toBe('namada');
    expect(isRealAddress('tnam1qrk5pyvtzxjmykcqmhglssshdjf3njac2qvqmlse')).toBe('namada');
    expect(isRealAddress('osmo1yl6hdjhmkf37639730gffanpzndzdpmhxy9ep3')).toBe('osmosis');
    expect(isRealAddress('tnam1' + 'q'.repeat(40))).toBeNull();
    expect(isRealAddress('osmo1' + 'q'.repeat(38))).toBeNull();
    expect(isRealAddress('')).toBeNull();
  });
  it('a value with a line break round-trips through the generated .sql text and cannot split a statement', () => {
    const db = testD1();
    const sql = inlineSql({ sql: 'SELECT ? v', params: ["x';\nDROP TABLE flows;--"] });
    expect(sql.split(/;\s*\n/)).toHaveLength(1);
    expect(db.raw.prepare(sql.slice(0, -1)).get().v).toBe("x';\nDROP TABLE flows;--");
    expect(inlineSql({ sql: 'SELECT ? v', params: ['plain'] })).toBe("SELECT 'plain' v;");
  });
});

// ------------------------------------------------------------------ Audit Round 2: cache-busting, stream caps, established accounts, webhook test cooldown
describe('Audit Round 2: high-cardinality cache-busters, stream caps, established accounts, and webhook cooldown', () => {
  it('high-cardinality query variants (?minNam=, ?page=>1, non-standard ?limit=, custom alert thresholds) are gated by REPLAY_LIMITER on cache miss', () => {
    expect(isReplay(new URL('https://namada.trade/api/flows?minNam=123.45'))).toBe(true);
    expect(isReplay(new URL('https://namada.trade/api/holders?page=2'))).toBe(true);
    expect(isReplay(new URL('https://namada.trade/api/holders?limit=17'))).toBe(true);
    expect(isReplay(new URL('https://namada.trade/api/alerts/recent?ibcInventory=999'))).toBe(true);
    expect(isReplay(new URL('https://namada.trade/api/alerts/rules?whale=100'))).toBe(false);
    expect(isReplay(new URL('https://namada.trade/api/alerts/rules?unlock=100'))).toBe(true);
    // Default landing queries are not classified as replay
    expect(isReplay(new URL('https://namada.trade/api/flows?chain=namada&limit=50'))).toBe(false);
    expect(isReplay(new URL('https://namada.trade/api/holders?chain=namada&page=1&limit=25'))).toBe(false);
  });

  it('Namada established accounts (tnam1q8..., discriminant 1) can sign in when their on-chain public key matches', async () => {
    const sk = ed25519.utils.randomSecretKey();
    const pkBorsh = new Uint8Array([0, ...ed25519.getPublicKey(sk)]);
    // Real established address (discriminant 1) from balance_listing.json
    const estAddr = 'tnam1q80ajrpqzv0vz9sl5ye22rprjt3k3q0cqy4lwywe';
    const message = loginMessage(estAddr, 'c'.repeat(32));
    const sig = '00' + hex.encode(ed25519.sign(sha256(new TextEncoder().encode(message)), sk));
    // Without an on-chain revealed key matching pkBorsh, an established account is rejected; so is one when the indexer is down (never assumed)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ publicKey: null }), { status: 200, headers: { 'content-type': 'application/json' } })));
    expect(await verifyNamada(estAddr, message, hex.encode(pkBorsh), sig)).toMatch(/does not belong/);
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('down'))));
    expect(await verifyNamada(estAddr, message, hex.encode(pkBorsh), sig)).toMatch(/does not belong/);
    // an internal address (discriminant 2) never signs in
    expect(await verifyNamada(NAMADA.internal.pos, loginMessage(NAMADA.internal.pos, 'c'.repeat(32)), hex.encode(pkBorsh), sig)).toMatch(/does not belong/);
    // When the on-chain key matches pkBorsh, sign-in succeeds
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ publicKey: hex.encode(pkBorsh) }), { status: 200, headers: { 'content-type': 'application/json' } })));
    expect(await verifyNamada(estAddr, message, hex.encode(pkBorsh), sig)).toBeNull();
  });

  it('fetchText aborts responses that exceed maxBytes before exhausting isolate memory', async () => {
    const big = new Uint8Array(2048);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(big, { status: 200, headers: { 'content-length': '2048' } })));
    await expect(fetchText('https://rpc.example/abci_query', { maxBytes: 1024 })).rejects.toThrow(/response too large/);
  });

  it('POST /api/me/settings/test enforces a 30-second cooldown per address', async () => {
    const db = testD1();
    const key = base64.encode(new Uint8Array(32).fill(9));
    const s = (await createSession(db as any, A, 'namada', 'namada')) as Session;
    const auth = { Authorization: `Bearer ${s.token}` };
    await saveSettings(db as any, key, {
      address: A,
      notifications: defaultPrefs(),
      channels: { discord: { enabled: true, webhookUrl: 'https://discord.com/api/webhooks/1234567890/abcdefghijk' } },
      createdAt: NOW,
      updatedAt: NOW,
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    const r1 = await app.request('/api/me/settings/test', { method: 'POST', headers: auth }, env(db, { SETTINGS_KEY: key }));
    expect(r1.status).toBe(200);
    const r2 = await app.request('/api/me/settings/test', { method: 'POST', headers: auth }, env(db, { SETTINGS_KEY: key }));
    expect(r2.status).toBe(429);
  });
});

// ------------------------------------------------------------------ Review 3 (2026-10-20): one query read two ways, keys no page asks for, Object's members
describe('C1/C14 (review 3): the key, the limiters and the route read one query the same way; values no page sends are refused or limited', () => {
  /** The real app over the stand-in behind the real cachedApi, a Map cache, and three limiters that refuse every call. */
  function world() {
    const db = testD1();
    const H = 3_600_000;
    insert(db, 'flows', Array.from({ length: 60 }, (_, i) => ({
      id: `osmosis:H${i}:0`, chain: 'osmosis', height: 1000 + i, ts: NOW - (i + 1) * H, tx_hash: `H${String(i).padStart(8, '0')}`,
      kind: i % 2 ? 'buy' : 'sell', from_addr: `osmo1${'q'.repeat(38)}${i % 10}`, to_addr: `osmo1${'p'.repeat(38)}${i % 10}`, amount_num: 100 + i,
    })));
    const e = edge();
    const limited: string[] = [];
    const refuse = (name: string) => ({ limit: async ({ key }: { key: string }) => { limited.push(`${name} ${key}`); return { success: false }; } });
    const envL = { DB: db, HEAVY_LIMITER: refuse('heavy'), REPLAY_LIMITER: refuse('replay'), SEARCH_LIMITER: refuse('search') } as any;
    const seen: string[] = [];
    const fetchApp = (r: Request, en: any, c: any) => { seen.push(r.url); return app.fetch(r, en, c); };
    const get = async (p: string) => {
      const r = await cachedApi(new Request(`https://namada.trade${p}`, { headers: { 'cf-connecting-ip': '203.0.113.5' } }), envL, e.ctx, fetchApp);
      await e.settle();
      return r;
    };
    return { get, limited, seen };
  }

  it('a parameter name spelled with a percent sign is not found: it can neither store a false answer under the visitors\' key nor slip past a limiter', async () => {
    const w = world();
    for (const p of ['/api/flows?%6bind=sell&kind=buy', '/api/flows?%73earch=&search=x', '/api/flows?%70age=1&page=900', '/api/holders?%63hain=namada&chain=osmosis', '/api/series?%6bey=price.usd&key=price.pool_1h']) {
      const r = await w.get(p);
      expect(r.status, p).toBe(404);
      expect(r.headers.get('cache-control')).toBe('no-store');
    }
    expect(w.seen).toEqual([]);
    expect(w.limited).toEqual([]);
    // the visitors' spelling is answered for what it asks: sells only
    const r = await w.get('/api/flows?kind=sell&limit=50');
    expect(r.status).toBe(200);
    const kinds = new Set(((await r.json()) as { flows: { kind: string }[] }).flows.map((f) => f.kind));
    expect([...kinds]).toEqual(['sell']);
  });

  it('the route runs on the key\'s own URL: only the parameters the key holds, each once, as the key decoded them', async () => {
    const w = world();
    await w.get('/api/flows?kind=sell&kind=buy&limit=50&r=12345');
    expect(w.seen).toEqual(['https://namada.trade/api/flows?kind=sell&limit=50']);
  });

  it('a series from a day the Trade page does not ask for today, or with a `to`, is limited on a miss; the five windows it sends are not', () => {
    const now = Date.now();
    const day = (d: number) => new Date(now - d * D).toISOString().slice(0, 10);
    for (const d of [30, 90, 365, 1200, 14]) expect(isReplay(new URL(`https://namada.trade/api/series?key=price.swap_1h&from=${day(d)}&step=1h`)), `${d} days`).toBe(false);
    expect(isReplay(new URL(`https://namada.trade/api/series?key=price.swap_1h&from=${day(31)}`))).toBe(false); // the day either side (a clock a little off)
    expect(isReplay(new URL('https://namada.trade/api/series?key=price.pool_1h&from=2020-01-01&step=1d'))).toBe(true);
    expect(isReplay(new URL(`https://namada.trade/api/series?key=price.pool_1h&from=${day(200)}&step=1d`))).toBe(true);
    expect(isReplay(new URL(`https://namada.trade/api/series?key=price.pool_1h&from=${day(30)}&to=2027-01-01`))).toBe(true);
    expect(isReplay(new URL('https://namada.trade/api/series?key=price.pool_1h&from=1577836800000'))).toBe(true);
    expect(isReplay(new URL('https://namada.trade/api/series?key=price.usd'))).toBe(false); // the route's own default window
  });

  it('the tape at any length but the one the page asks for, and a page number spelled any other way, are limited on a miss', () => {
    expect(isReplay(new URL('https://namada.trade/api/series/trades?limit=60'))).toBe(false);
    expect(isReplay(new URL('https://namada.trade/api/series/trades'))).toBe(false);
    for (const l of ['-1', '10', '61', '060']) expect(isReplay(new URL(`https://namada.trade/api/series/trades?limit=${l}`)), l).toBe(true);
    for (const pg of ['-5', '0', '0.3', '01', '2']) {
      expect(isReplay(new URL(`https://namada.trade/api/flows?page=${pg}`)), pg).toBe(true);
      expect(isReplay(new URL(`https://namada.trade/api/holders?chain=namada&page=${pg}`)), pg).toBe(true);
    }
    expect(isReplay(new URL('https://namada.trade/api/flows?page=1'))).toBe(false);
  });

  it('switches, chains, sorts and `count` spelled any other way than the app sends them are refused (a 400 is never cached)', async () => {
    const db = testD1();
    const status = async (p: string) => (await app.request(p, {}, env(db))).status;
    for (const p of ['/api/flows?count=b1', '/api/flows?chain=zz1', '/api/flows?chain=Namada', '/api/flows?whale=t1', '/api/flows?arb=f1', '/api/flows?pairs=two',
      '/api/holders?by=r1', '/api/holders?chain=all%20', '/api/holders?chain=NAMADA', '/api/export/holders?chain=namada&by=x']) expect(await status(p), p).toBe(400);
    // the app's own spellings (web/src/api.ts flowsParams, holdersParams)
    for (const p of ['/api/flows?count=none', '/api/flows?chain=osmosis&whale=true&arb=false&pairs=one', '/api/flows', '/api/flows?chain=all',
      '/api/holders?chain=all', '/api/holders?chain=namada&by=liquid', '/api/holders?chain=osmosis&by=bonded&page=1', '/api/holders?chain=namada&by=total']) expect(await status(p), p).toBe(200);
  });

  it('?category=__proto__ and ?category=constructor are categories nothing has (total 0, the narrow read), never Object\'s members', async () => {
    const db = testD1();
    insert(db, 'holders', [{ chain: 'namada', address: A, balance: '1', balance_num: 10, total_num: 10, updated_at: NOW, verified_at: NOW, verified_src: 'x' }]);
    insert(db, 'kv', [{ key: 'holders.counts', value: JSON.stringify({ at: NOW, byChain: { namada: { all: 1, byCategory: {}, none: 1, under1Nam: 0 }, osmosis: { all: 0, byCategory: {}, none: 0, under1Nam: 0 }, all: { all: 1, byCategory: {}, none: 1, under1Nam: 0 } } }), updated_at: NOW }]);
    for (const c of ['__proto__', 'constructor', 'tostring']) {
      const r = await app.request(`/api/holders?chain=namada&category=${c}`, {}, env(db));
      expect(r.status, c).toBe(200);
      const j = (await r.json()) as { total: unknown; holders: unknown[] };
      expect(j.total, c).toBe(0);
      expect(j.holders).toEqual([]);
    }
    const { category_plain } = await import('../shared/labels');
    expect(category_plain('constructor')).toBe('Constructor');
  });
});

// ------------------------------------------------------------------ Group D (review of 2026-10-22): `?at=` read as the routes read it
describe('D: an `at` the routes answer live is the live copy, under no replay budget', () => {
  const u = (s: string) => new URL(`https://namada.trade${s}`);
  /** The Osmosis quote service, answered empty; the URLs it was asked for. */
  function quoteService() {
    const asked: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (r: RequestInfo | URL) => {
      const s = String(r instanceof Request ? r.url : r);
      asked.push(s);
      return new Response(s.includes('/tokens/prices') ? '{}' : '[]', { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    return asked;
  }
  it('is keyed and limited as the live read; a past time keeps its own key, written as the route reads it', () => {
    for (const v of ['x1', 'x2', '0', '-1', 'Infinity', 'NaN', '', '1e99', String(Date.now() + D)]) {
      expect(cacheKeyUrl(u(`/api/overview?at=${encodeURIComponent(v)}`)), v).toBe('https://namada.trade/api/overview');
      expect(isReplay(u(`/api/overview?at=${encodeURIComponent(v)}`)), v).toBe(false);
      expect(rewoundAt(u(`/api/overview?at=${encodeURIComponent(v)}`)), v).toBeNull();
    }
    expect(cacheKeyUrl(u('/api/overview?at=1792500000000'))).toBe('https://namada.trade/api/overview?at=1792500000000');
    expect(cacheKeyUrl(u('/api/overview?at=1.7925e12'))).toBe('https://namada.trade/api/overview?at=1792500000000');
    expect(isReplay(u('/api/overview?at=1792500000000'))).toBe(true);
    expect(cacheKeyUrl(u('/api/flows?chain=namada&at=-1'))).toBe('https://namada.trade/api/flows?chain=namada');
    expect(cacheKeyUrl(u('/api/series/volume?at=soon'))).toBe('https://namada.trade/api/series/volume');
  });
  it('answers every spelling from one live copy: one live read of the quote service, no replay budget spent', async () => {
    const e = edge();
    const asked = quoteService();
    const limiter = { limit: vi.fn(async () => ({ success: false })) };
    const db = testD1();
    const fetchApp = (r: Request, en: any, c: any) => app.fetch(r, en, c);
    for (const v of ['x1', 'x2', '0', '-1', String(Date.now() + D)]) {
      const r = await cachedApi(new Request(`https://namada.trade/api/overview?at=${v}`, { headers: { 'cf-connecting-ip': '1.2.3.4' } }), env(db, { REPLAY_LIMITER: limiter }), e.ctx, fetchApp);
      expect(r.status, v).toBe(200);
      expect(((await r.json()) as any).asOf, v).toBeNull();
      await e.settle();
    }
    // the price list, the router's 1,000 NAM quote (the list gives NAM no price: sources/sqs.ts fetchNamPrice) and the pools
    expect(asked).toHaveLength(3);
    expect(asked.filter((s) => s.includes('/router/custom-direct-quote'))).toHaveLength(1);
    expect([...e.store.keys()]).toEqual(['https://namada.trade/api/overview']);
    expect(limiter.limit).not.toHaveBeenCalled();
    // a time in the past is a rewound read: its own copy, under the replay budget, and no quote-service call
    const past = Date.now() - 3_600_000;
    expect((await cachedApi(new Request(`https://namada.trade/api/overview?at=${past}`, { headers: { 'cf-connecting-ip': '1.2.3.4' } }), env(db, { REPLAY_LIMITER: limiter }), e.ctx, fetchApp)).status).toBe(429);
    const ok = await cachedApi(new Request(`https://namada.trade/api/overview?at=${past}`), env(db), e.ctx, fetchApp);
    expect(((await ok.json()) as any).asOf).toBe(past);
    expect(asked).toHaveLength(3);
  });
});
