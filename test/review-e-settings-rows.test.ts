// Security review (2026-10-22), saved alert settings rows: sign-ins are free (any fresh key is a new address), and a
// signed-in wallet's settings row was bounded only by each request's 16 KB body. Two PUTs left a sealed row of about
// 34 KB (a full watchlist, then a webhook link of about 16,300 characters), nothing capped how many such rows exist,
// and nothing ever deleted them, so free addresses could grow the one database every other write shares for good.
// These tests pin the bounds: the link's parts are bounded and the whole settings are at most SETTINGS_MAX_BYTES; at
// most USER_ROWS_MAX addresses have a row, counted by the insert itself, and an address that has one can always change
// it; a refused first save answers 503, is recorded, and shows on the health row; the test-post cooldown rows are
// swept and deleted with the account. All requests stay in-process: fetch is stubbed to fail.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base64 } from '@scure/base';
import { app, MAX_BODY_BYTES } from '../worker/src/api';
import { cachedApi } from '../worker/src/http';
import { adr36SignDoc, createSession, osmosisAddress, sweepAuth, WEBHOOK_TEST_KEEP_MS, type Session } from '../worker/src/auth';
import {
  applyUpdate, saveSettings, loadSettings, allDeliverable, defaultPrefs, userRowCount, noteSettingsRefused,
  DELIVERABLE_MAX, SETTINGS_FULL, SETTINGS_MAX_BYTES, USER_ROWS_MAX, WEBHOOK_URL_RE, type StoredSettings,
} from '../worker/src/settings';
import { settingsRowsHealth, SETTINGS_ROWS_HEALTH } from '../worker/src/cron';
import { testD1 } from './d1-sqlite';

const KEY = base64.encode(new Uint8Array(32));
const DAY = 86400000;
type DB = ReturnType<typeof testD1>;

/** 100 distinct watched addresses of the longest shape the watchlist takes (85 characters). */
const watch100 = () => Array.from({ length: 100 }, (_, i) => 'tnam1' + 'q'.repeat(79 - String(i).length) + String(i) + '0');
/** The longest link a 16 KB body could carry before: `{"channels":{"discord":{"webhookUrl":"…"}}}` of 16,384 bytes. */
const longUrl = () => 'https://discord.com/api/webhooks/1/' + 'a'.repeat(16307);
/** A link of the shape Discord gives out today: a 19-digit id and a 68-character token. */
const realUrl = (i = 0) => `https://discord.com/api/webhooks/1${String(i).padStart(18, '0')}/${'Ab3_-'.repeat(13)}xyz`;
const fresh = (address: string): StoredSettings => ({ address, notifications: defaultPrefs(), channels: { discord: { enabled: false, webhookUrl: null } }, createdAt: 0, updatedAt: 0 });
const addr = (i: number) => `osmo1${String(i).padStart(38, 'q')}`;

const rowLen = (d1: DB, address: string) => (d1.raw.prepare('SELECT length(value) n FROM kv WHERE key = ?').get(`user:${address}`) as { n: number } | undefined)?.n ?? 0;
const kvRow = (d1: DB, key: string) => d1.raw.prepare('SELECT value, updated_at FROM kv WHERE key = ?').get(key) as { value: string; updated_at: number } | undefined;

async function call(env: any, ip: string, method: string, path: string, body?: unknown, token?: string) {
  const text = body === undefined ? undefined : JSON.stringify(body);
  const headers: Record<string, string> = { 'cf-connecting-ip': ip, 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (text !== undefined) headers['content-length'] = String(new TextEncoder().encode(text).length);
  const r = await cachedApi(new Request(`https://namada.trade${path}`, { method, headers, body: text }), env, {} as any, (q, e, c) => app.fetch(q, e, c));
  return { status: r.status, json: (await r.json().catch(() => null)) as any, bytes: text ? new TextEncoder().encode(text).length : 0 };
}

/** A fresh Keplr identity signed in through the real nonce and login routes. */
async function signIn(env: any, ip: string): Promise<{ address: string; token: string }> {
  const sk = secp256k1.utils.randomSecretKey();
  const pub = secp256k1.getPublicKey(sk, true);
  const address = osmosisAddress(pub);
  const n = await call(env, ip, 'POST', '/api/auth/nonce', { address });
  const digest = sha256(new TextEncoder().encode(adr36SignDoc(address, new TextEncoder().encode(n.json.message))));
  const l = await call(env, ip, 'POST', '/api/auth/login', { address, nonce: n.json.nonce, pubkey: base64.encode(pub), signature: base64.encode(secp256k1.sign(digest, sk, { prehash: false })) });
  expect(l.status).toBe(200);
  return { address, token: l.json.session.token };
}

/** USER_ROWS_MAX rows of other addresses, written as saveSettings writes them. */
async function fill(d1: DB, n = USER_ROWS_MAX) {
  for (let i = 0; i < n; i++) expect(await saveSettings(d1 as any, KEY, { ...fresh(addr(i)), updatedAt: i })).toBe(true);
}

afterEach(() => vi.unstubAllGlobals());
const noNetwork = () => vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no network in this test'); }));

describe('one wallet\'s row is bounded, not only each request', () => {
  it('the link a 16 KB body could carry is refused; a link of the shape Discord gives out is kept', async () => {
    noNetwork();
    const d1 = testD1();
    const env = { DB: d1, SETTINGS_KEY: KEY } as any;
    const me = await signIn(env, '203.0.113.7');
    const big = await call(env, '203.0.113.7', 'PUT', '/api/me/settings', { channels: { discord: { webhookUrl: longUrl() } } }, me.token);
    expect(big.bytes).toBe(MAX_BODY_BYTES);
    expect(big.status).toBe(400);
    expect(big.json.error).toMatch(/not a Discord webhook/);
    expect(rowLen(d1, me.address)).toBe(0);
    // a 20-digit id and a 100-character token are the most each part takes
    expect(WEBHOOK_URL_RE.test(`https://discord.com/api/webhooks/${'9'.repeat(20)}/${'a'.repeat(100)}`)).toBe(true);
    expect(WEBHOOK_URL_RE.test(`https://discord.com/api/webhooks/${'9'.repeat(21)}/abc`)).toBe(false);
    expect(WEBHOOK_URL_RE.test(`https://discord.com/api/webhooks/1/${'a'.repeat(101)}`)).toBe(false);
    expect(WEBHOOK_URL_RE.test('https://discord.com/api/webhooks/123/abc_DEF-9')).toBe(true);
    const ok = await call(env, '203.0.113.7', 'PUT', '/api/me/settings', { channels: { discord: { enabled: true, webhookUrl: realUrl() } } }, me.token);
    expect(ok.status).toBe(200);
    expect(ok.json.settings.channels.discord.hasUrl).toBe(true);
    expect((await loadSettings(d1 as any, KEY, me.address))!.channels.discord.webhookUrl).toBe(realUrl());
  });

  it('the largest settings the checks allow fit SETTINGS_MAX_BYTES, and their sealed row stays under 14 KB', async () => {
    const d1 = testD1();
    const rules = Object.fromEntries(['ibc_inventory', 'unlock', 'big_swap', 'unshield', 'bond'].map((id) => [id, { on: true, thresholdNam: 1e12 }]));
    const longest = `https://discordapp.com/api/webhooks/${'9'.repeat(20)}/${'a'.repeat(100)}`;
    const a = applyUpdate(fresh(`osmo1${'q'.repeat(58)}`), { notifications: { rules, watchlist: watch100() } }) as StoredSettings;
    const b = applyUpdate(a, { notifications: { watchlistOn: true, forumAndGov: true, quietHoursUtc: { start: 23, end: 24 } }, channels: { discord: { enabled: true, webhookUrl: longest } } });
    expect(typeof b).toBe('object');
    const s = b as StoredSettings;
    expect(s.notifications.watchlist).toHaveLength(100);
    const plain = new TextEncoder().encode(JSON.stringify(s)).length;
    expect(plain).toBeLessThanOrEqual(SETTINGS_MAX_BYTES);
    expect(plain).toBeGreaterThan(9000);
    expect(await saveSettings(d1 as any, KEY, s)).toBe(true);
    expect(rowLen(d1, s.address)).toBeLessThan(14_000);
  });

  it('a field that would carry the settings past SETTINGS_MAX_BYTES is refused, so a later field cannot grow the row unseen', () => {
    const cur = fresh(addr(1)) as StoredSettings & { extra?: string };
    cur.extra = 'x'.repeat(SETTINGS_MAX_BYTES);
    expect(applyUpdate(cur, { notifications: { watchlistOn: false } })).toBe('these settings are too large to save');
  });
});

describe('at most USER_ROWS_MAX addresses have saved settings', () => {
  it('a new address past the cap is refused with a 503 and recorded; nothing of it is stored', async () => {
    noNetwork();
    const d1 = testD1();
    const env = { DB: d1, SETTINGS_KEY: KEY } as any;
    await fill(d1);
    const me = await signIn(env, '198.51.100.1');
    const r = await call(env, '198.51.100.1', 'PUT', '/api/me/settings', { notifications: { watchlist: [addr(3)] } }, me.token);
    expect(r.status).toBe(503);
    expect(r.json).toEqual({ error: SETTINGS_FULL });
    expect(rowLen(d1, me.address)).toBe(0);
    expect(await userRowCount(d1 as any)).toBe(USER_ROWS_MAX);
    expect(JSON.parse(kvRow(d1, 'settings.refused')!.value)).toMatchObject({ total: 1 });
    await call(env, '198.51.100.1', 'PUT', '/api/me/settings', { notifications: { watchlistOn: false } }, me.token);
    expect(JSON.parse(kvRow(d1, 'settings.refused')!.value).total).toBe(2);
  });

  it('an address that has a row always changes it at the cap, and Delete everything frees a place', async () => {
    noNetwork();
    const d1 = testD1();
    const env = { DB: d1, SETTINGS_KEY: KEY } as any;
    await fill(d1);
    const owner = (await createSession(d1 as any, addr(7), 'osmosis', 'keplr')) as Session;
    const ch = await call(env, '198.51.100.2', 'PUT', '/api/me/settings', { notifications: { watchlist: [addr(3)] } }, owner.token);
    expect(ch.status).toBe(200);
    expect((await loadSettings(d1 as any, KEY, addr(7)))!.notifications.watchlist).toEqual([addr(3)]);
    const me = await signIn(env, '198.51.100.3');
    expect((await call(env, '198.51.100.3', 'PUT', '/api/me/settings', { notifications: { watchlistOn: false } }, me.token)).status).toBe(503);
    expect((await call(env, '198.51.100.2', 'DELETE', '/api/me', undefined, owner.token)).status).toBe(200);
    expect(await userRowCount(d1 as any)).toBe(USER_ROWS_MAX - 1);
    expect((await call(env, '198.51.100.3', 'PUT', '/api/me/settings', { notifications: { watchlistOn: false } }, me.token)).status).toBe(200);
    expect(await userRowCount(d1 as any)).toBe(USER_ROWS_MAX);
  });

  it('first saves made together at one place left: exactly one is written', async () => {
    const d1 = testD1();
    await fill(d1, USER_ROWS_MAX - 1);
    const r = await Promise.all([0, 1, 2, 3, 4].map((i) => saveSettings(d1 as any, KEY, fresh(`osmo1${'z'.repeat(37)}${i}`))));
    expect(r.filter(Boolean)).toHaveLength(1);
    expect(await userRowCount(d1 as any)).toBe(USER_ROWS_MAX);
  });

  it('with no limiter in front (unbound, or failing open), free sign-ins still stop at the cap, each row under 14 KB', { timeout: 60_000 }, async () => {
    // Fetch fails here, so each save that turns a link on posts its connection notice once more after a second
    // (api.ts NOTICE_RETRY_MS) before saving the channel on with the note: five such saves take about five seconds.
    noNetwork();
    const d1 = testD1();
    const env = { DB: d1, SETTINGS_KEY: KEY } as any;
    await fill(d1, USER_ROWS_MAX - 5);
    const results: number[] = [];
    for (let i = 0; i < 12; i++) {
      const me = await signIn(env, `2001:db8::${i + 1}`);
      const a = await call(env, `2001:db8::${i + 1}`, 'PUT', '/api/me/settings', { notifications: { watchlist: watch100() } }, me.token);
      const b = await call(env, `2001:db8::${i + 1}`, 'PUT', '/api/me/settings', { channels: { discord: { enabled: true, webhookUrl: realUrl(i) } } }, me.token);
      results.push(a.status, b.status);
      if (a.status === 200) expect(rowLen(d1, me.address)).toBeLessThan(14_000);
    }
    expect(results.filter((s) => s === 200)).toHaveLength(10);
    expect(results.filter((s) => s === 503)).toHaveLength(14);
    expect(await userRowCount(d1 as any)).toBe(USER_ROWS_MAX);
    const total = d1.raw.prepare(`SELECT sum(length(value)) b FROM kv WHERE key >= 'user:' AND key < 'user;'`).get() as { b: number };
    expect(total.b).toBeLessThan(USER_ROWS_MAX * 14_000);
  });

  it('the dispatcher reads every row with Discord on: the channel cap is its read, and rows with Discord off take no channel\'s place', async () => {
    const d1 = testD1();
    expect(USER_ROWS_MAX).toBeGreaterThan(DELIVERABLE_MAX);
    // A link of its own for each row: rows that share a link are one channel (test/channel-places.test.ts).
    const on = (i: number) => applyUpdate(fresh(addr(i)), { channels: { discord: { enabled: true, webhookUrl: realUrl(i) } } }) as StoredSettings;
    for (let i = 0; i < DELIVERABLE_MAX + 3; i++) await saveSettings(d1 as any, KEY, on(i));
    expect(await userRowCount(d1 as any)).toBe(DELIVERABLE_MAX);
    expect((await allDeliverable(d1 as any, KEY)).length).toBe(DELIVERABLE_MAX);
    for (let i = 0; i < USER_ROWS_MAX - DELIVERABLE_MAX; i++) expect(await saveSettings(d1 as any, KEY, fresh(addr(10_000 + i)))).toBe(true);
    expect(await userRowCount(d1 as any)).toBe(USER_ROWS_MAX);
    expect((await allDeliverable(d1 as any, KEY)).length).toBe(DELIVERABLE_MAX);
  });
});

describe('the health row says when room runs out', () => {
  it('room without a number below 80%; the number from 80%; a refusal for a day', async () => {
    const d1 = testD1();
    const now = Date.UTC(2026, 9, 23, 12);
    const at = (h: Awaited<ReturnType<typeof settingsRowsHealth>>) => ({ ok: h.ok, note: h.note });
    await fill(d1, Math.ceil(USER_ROWS_MAX * 0.8) - 1);
    const room = await settingsRowsHealth(d1 as any, now);
    expect(room.name).toBe(SETTINGS_ROWS_HEALTH);
    expect(at(room)).toEqual({ ok: true, note: `Room for new wallets (under ${Math.ceil(USER_ROWS_MAX * 0.8)} of ${USER_ROWS_MAX} places taken).` });
    expect(room.note).not.toContain(String(Math.ceil(USER_ROWS_MAX * 0.8) - 1));
    expect(await saveSettings(d1 as any, KEY, fresh('osmo1near'))).toBe(true);
    expect(at(await settingsRowsHealth(d1 as any, now))).toEqual({ ok: false, note: `${Math.ceil(USER_ROWS_MAX * 0.8)} of ${USER_ROWS_MAX} places taken; new wallets are refused at ${USER_ROWS_MAX}.` });
    d1.raw.prepare(`DELETE FROM kv WHERE key = 'user:osmo1near'`).run();
    await noteSettingsRefused(d1 as any, now - 3600000);
    await noteSettingsRefused(d1 as any, now - 60000);
    const refused = await settingsRowsHealth(d1 as any, now);
    expect(refused.ok).toBe(false);
    expect(refused.at).toBe(now - 60000);
    expect(refused.note).toBe(`${Math.ceil(USER_ROWS_MAX * 0.8) - 1} of ${USER_ROWS_MAX} places taken; a new wallet's first save was refused (2 in all).`);
    expect((await settingsRowsHealth(d1 as any, now + DAY)).ok).toBe(true);
  });

  it('a count that fails is a row that is not ok, never "room"', async () => {
    const broken = { prepare: () => ({ first: async () => { throw new Error('D1 unavailable'); } }) } as any;
    const h = await settingsRowsHealth(broken, 1);
    expect(h.ok).toBe(false);
    expect(h.note).toMatch(/could not be counted/);
  });
});

describe('test-post cooldown rows do not outlive their use', () => {
  it('sweepAuth deletes the ones older than WEBHOOK_TEST_KEEP_MS and keeps a fresh one; saved settings are not swept', async () => {
    const d1 = testD1();
    const now = Date.now();
    d1.raw.prepare(`INSERT INTO kv (key,value,updated_at) VALUES ('webhook_test:osmo1old', '1', ?), ('webhook_test:osmo1new', ?, ?)`).run(now - WEBHOOK_TEST_KEEP_MS - 1000, String(now), now);
    await saveSettings(d1 as any, KEY, fresh(addr(1)));
    d1.raw.prepare(`UPDATE kv SET updated_at = ? WHERE key = ?`).run(now - 400 * DAY, `user:${addr(1)}`);
    await sweepAuth(d1 as any);
    expect(kvRow(d1, 'webhook_test:osmo1old')).toBeUndefined();
    expect(kvRow(d1, 'webhook_test:osmo1new')).toBeDefined();
    expect(rowLen(d1, addr(1))).toBeGreaterThan(0);
  });

  it('Delete everything deletes the address\'s cooldown row with its settings', async () => {
    noNetwork();
    const d1 = testD1();
    const env = { DB: d1, SETTINGS_KEY: KEY } as any;
    const me = await signIn(env, '198.51.100.9');
    expect((await call(env, '198.51.100.9', 'PUT', '/api/me/settings', { notifications: { watchlistOn: false } }, me.token)).status).toBe(200);
    d1.raw.prepare(`INSERT INTO kv (key,value,updated_at) VALUES (?, '1', 1)`).run(`webhook_test:${me.address}`);
    expect((await call(env, '198.51.100.9', 'DELETE', '/api/me', undefined, me.token)).status).toBe(200);
    expect(rowLen(d1, me.address)).toBe(0);
    expect(kvRow(d1, `webhook_test:${me.address}`)).toBeUndefined();
  });
});
