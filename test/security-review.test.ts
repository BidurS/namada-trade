// Security review (2026-10-19, docs/security-review.md): each block names the finding it guards.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base64, hex } from '@scure/base';
import { app, PAGE_MAX, TAGS_PER_AUTHOR, TAGS_PER_DAY, QUOTE_MAX_NAM, MAX_BODY_BYTES } from '../worker/src/api';
import { cachedApi, rateLimited, isHeavy, isReplay, cacheKeyUrl, CACHEABLE_API } from '../worker/src/http';
import { testD1, insert } from './d1-sqlite';
import {
  createSession, issueNonce, login, loginMessage, verifyNamada, namadaImplicitAddress, createPairCode, claimPairCode, sweepAuth, ALERT_CLAIM_KEEP_MS, type Session,
} from '../worker/src/auth';
import { assertLoginMessage } from '../shared/login';
import { chainOf, isRealAddress, HttpError, fetchText } from '../worker/src/util';
import { inlineSql } from '../worker/src/db';
import { configureAlerts, buildFlowDiscordBody, sendDiscordWhaleAlert, sendDiscordForumAlert, plainMd, BACKOFF_AFTER, FANOUT_DEADLINE_MS, POST_CONCURRENCY } from '../worker/src/sources/discord';
import { saveSettings, defaultPrefs, type StoredSettings } from '../worker/src/settings';
import { appliedUnbonds } from '../worker/src/parse/namada-unbond';
import { parseNamadaBlock } from '../worker/src/parse/namada';
import { namadaStatusAny, blockResults, LIVE_READ } from '../worker/src/sources/namada';
import { admitSocket, MAX_SOCKETS, MAX_SOCKETS_PER_IP } from '../worker/src/ws-admit';
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
      expect((await app.request('/api/auth/pair/claim', json(body), env(db))).status, body).toBe(400);
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
  it('a device shows one live code: a new one retires the old; a code pairs once even when two claims race', async () => {
    const db = testD1();
    const s = (await createSession(db as any, A, 'namada', 'namada')) as Session;
    const first = await createPairCode(db as any, s);
    const second = await createPairCode(db as any, s);
    expect('code' in first && 'code' in second).toBe(true);
    expect(db.raw.prepare("SELECT COUNT(*) n FROM kv WHERE key LIKE 'pair:%'").get().n).toBe(1);
    expect((await claimPairCode(db as any, (first as any).code)).error).toMatch(/expired or already used/);
    const code = (second as any).code as string;
    const [x, y] = await Promise.all([claimPairCode(db as any, code), claimPairCode(db as any, code)]);
    expect([x.session, y.session].filter(Boolean)).toHaveLength(1);
  });
  it('a colliding draw never overwrites another device\'s live code', async () => {
    const db = testD1();
    const sA = (await createSession(db as any, A, 'namada', 'namada')) as Session;
    const sB = (await createSession(db as any, 'osmo1' + 'b'.repeat(38), 'osmosis', 'keplr')) as Session;
    const spy = vi.spyOn(crypto, 'getRandomValues').mockImplementation(((arr: Uint8Array) => { arr.fill(0xab); return arr; }) as any);
    try {
      const a = await createPairCode(db as any, sA);
      expect(a).toEqual({ code: 'ABABABAB', expiresAt: expect.any(Number) });
      const b = await createPairCode(db as any, sB);
      expect('error' in b).toBe(true);
      expect(JSON.parse(db.raw.prepare("SELECT value FROM kv WHERE key = 'pair:ABABABAB'").get().value).address).toBe(A);
      const res = await app.request('/api/auth/pair', { method: 'POST', headers: { Authorization: `Bearer ${sB.token}` } }, env(db));
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
    insert(db, 'labels', Array.from({ length: TAGS_PER_DAY }, (_, i) => ({ address: addr(1000 + i), chain: 'namada', label: `t${i}`, category: 'watch', source: 'user', author: 'tnam1qotherxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', updated_at: NOW - 60000 })));
    const res = await post(db, t, { address: addr(1), label: 'one more', category: 'watch' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toMatch(/paused/);
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
    expect(body.embeds[0].description).toContain('[Read full post on forum.namada.net ↗](https://forum.namada.net/t/t/1/2)');
    expect(body.embeds[0].title).not.toContain('](https://evil');
    expect(body.embeds[0].fields[0].value).not.toContain('](https://evil');
    expect(plainMd('a [b](c) d')).toBe('a [b] (c) d');
  });
  it('a free-text bridge receiver stays inside its code span and is marked as not an address', () => {
    const body = buildFlowDiscordBody({ ...sell(1), kind: 'ibc_out', to: '`**FAKE**` [a](http://e.v)@everyone', toLabel: 'tag [x](http://e.v)' } as Flow, 0.001);
    const to = body.embeds[0].fields.find((x: any) => x.name === 'To')!.value as string;
    expect(to.split('`').length - 1).toBe(2);
    expect(to).toContain('(not an address)');
    expect(to).not.toContain('](http');
    const from = body.embeds[0].fields.find((x: any) => x.name === 'From')!.value as string;
    expect(from).not.toContain('(not an address)');
  });
  it('one post per webhook however many users share it; the claim is made before any post', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => { calls.push(String(u)); return new Response(null, { status: 204 }); }));
    const db = testD1();
    configureAlerts(KEY);
    const url = 'https://discord.com/api/webhooks/1/shared';
    for (let i = 0; i < 3; i++) await saveSettings(db as any, KEY, user(`tnam1qshare${i}${'q'.repeat(33)}`, url));
    await saveSettings(db as any, KEY, user(`tnam1qalone${'q'.repeat(34)}`, 'https://discord.com/api/webhooks/2/alone'));
    await sendDiscordWhaleAlert(undefined, sell(1), null, db as any, 10000);
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
    for (let n = 10; n < 10 + BACKOFF_AFTER; n++) await sendDiscordWhaleAlert(undefined, sell(n), null, db as any, 10000);
    expect(calls).toHaveLength(BACKOFF_AFTER);
    await sendDiscordWhaleAlert(undefined, sell(99), null, db as any, 10000);
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
    expect(admitSocket(0, 0)).toBe('ok');
    expect(admitSocket(MAX_SOCKETS - 1, 0)).toBe('ok');
    expect(admitSocket(MAX_SOCKETS, 0)).toBe('full');
    expect(admitSocket(10, MAX_SOCKETS_PER_IP - 1)).toBe('ok');
    expect(admitSocket(10, MAX_SOCKETS_PER_IP)).toBe('ip');
    expect(MAX_SOCKETS).toBeLessThanOrEqual(1000);
    expect(MAX_SOCKETS_PER_IP).toBeGreaterThanOrEqual(8);
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
    // Without an on-chain revealed key matching pkBorsh, an established account is rejected
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ publicKey: null }), { status: 200, headers: { 'content-type': 'application/json' } })));
    expect(await verifyNamada(estAddr, message, hex.encode(pkBorsh), sig)).toMatch(/does not belong/);
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
