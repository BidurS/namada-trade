// Security review (2026-10-22), what a copy of the database gives: the rows of the kv table (an export, Time Travel,
// a backup, a console read) hold nothing that pairs a device or ends a session. A pending pair code's row is keyed by
// an HMAC of the code under SETTINGS_KEY, never the code, and a session row's key sent as a bearer is refused without
// deleting the row it names.
import { describe, it, expect } from 'vitest';
import { base64, hex } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { app } from '../worker/src/api';
import { testD1, insert } from './d1-sqlite';
import { createSession, createPairCode, claimPairCode, pairKey, sessionFromRequest, logout, sweepAuth, tokenHash, type Session } from '../worker/src/auth';
import { saveSettings, defaultPrefs } from '../worker/src/settings';

const KEY = base64.encode(new Uint8Array(32).fill(7));
const OTHER_KEY = base64.encode(new Uint8Array(32).fill(8));
const env = (db: ReturnType<typeof testD1>, extra: Record<string, unknown> = { SETTINGS_KEY: KEY }) => ({ DB: db, ...extra } as any);
const A = 'tnam1q' + 'revjewer' + 'x'.repeat(31);
const W = 'tnam1q' + 'w'.repeat(39);
const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const bearer = (t: string) => ({ headers: { Authorization: `Bearer ${t}` } });
const req = (t: string) => new Request('https://namada.trade/api/auth/me', bearer(t));
const kvRows = (db: ReturnType<typeof testD1>) => db.raw.prepare('SELECT key, value FROM kv').all() as { key: string; value: string }[];
const pairRows = (db: ReturnType<typeof testD1>) => db.raw.prepare("SELECT key, value FROM kv WHERE key >= 'pair:' AND key < 'pair;'").all() as { key: string; value: string }[];
const count = (db: ReturnType<typeof testD1>, key: string) => (db.raw.prepare('SELECT COUNT(*) n FROM kv WHERE key = ?').get(key) as { n: number }).n;
const D = 86400000;

describe('a pending pair code is not in the database', () => {
  it('the row names no code, nothing read from the table claims, and the code shown still pairs once', async () => {
    const db = testD1();
    const s = (await createSession(db as any, A, 'namada', 'namada')) as Session;
    await saveSettings(db as any, KEY, { address: A, notifications: { ...defaultPrefs(), watchlist: [W] }, channels: { discord: { enabled: false, webhookUrl: null } }, createdAt: 1, updatedAt: 1 } as any);
    const made = await app.request('/api/auth/pair', { method: 'POST', ...bearer(s.token) }, env(db));
    expect(made.status).toBe(200);
    const { code } = (await made.json()) as { code: string };
    expect(code).toMatch(/^[0-9A-F]{8}$/);

    // The copy: one pair row, keyed by the keyed hash; neither the code nor its plain hash is anywhere in the table.
    const rows = pairRows(db);
    expect(rows.map((r) => r.key)).toEqual([pairKey(KEY, code)]);
    expect(rows[0].key).toMatch(/^pair:[0-9a-f]{64}$/);
    expect(pairKey(OTHER_KEY, code)).not.toBe(rows[0].key);
    const plain = hex.encode(sha256(new TextEncoder().encode(code)));
    for (const r of kvRows(db)) {
      expect(r.key.toUpperCase()).not.toContain(code);
      expect(r.value.toUpperCase()).not.toContain(code);
      expect(r.key).not.toContain(plain);
    }

    // Every string the row offers, sent as a code, pairs nothing (and an 8-hex cut of the key is not the code).
    const tries = [rows[0].key.slice(5), rows[0].key.slice(5, 13), JSON.parse(rows[0].value).by.slice(0, 8)];
    for (const t of tries) {
      const r = await app.request('/api/auth/pair/claim', json({ code: t }), env(db));
      expect(r.status, t).toBe(400);
    }
    expect(pairRows(db)).toHaveLength(1);

    // The phone, with the code it was shown: a 'pair' session that reads the settings, once.
    const claim = await app.request('/api/auth/pair/claim', json({ code: code.toLowerCase() }), env(db));
    expect(claim.status).toBe(200);
    const sess = ((await claim.json()) as any).session;
    expect([sess.via, sess.address]).toEqual(['pair', A]);
    const st = await app.request('/api/me/settings', bearer(sess.token), env(db));
    expect(((await st.json()) as any).settings.notifications.watchlist).toEqual([W]);
    expect(pairRows(db)).toHaveLength(0);
    expect((await app.request('/api/auth/pair/claim', json({ code }), env(db))).status).toBe(400);
  });

  it('a code made under one SETTINGS_KEY is not claimed under another', async () => {
    const db = testD1();
    const s = (await createSession(db as any, A, 'namada', 'namada')) as Session;
    const { code } = (await createPairCode(db as any, s, KEY)) as { code: string };
    expect((await claimPairCode(db as any, code, OTHER_KEY)).error).toMatch(/expired or already used/);
    expect((await claimPairCode(db as any, code, KEY)).session?.via).toBe('pair');
  });

  it('without SETTINGS_KEY no code is made or claimed (503), and no row is written', async () => {
    const db = testD1();
    const s = (await createSession(db as any, A, 'namada', 'namada')) as Session;
    const made = await app.request('/api/auth/pair', { method: 'POST', ...bearer(s.token) }, env(db, {}));
    expect(made.status).toBe(503);
    expect(pairRows(db)).toHaveLength(0);
    expect((await app.request('/api/auth/pair/claim', json({ code: 'ABABABAB' }), env(db, {}))).status).toBe(503);
    expect(() => pairKey('', 'ABABABAB')).toThrow(/SETTINGS_KEY/);
    await expect(createPairCode(db as any, s, '')).rejects.toThrow(/SETTINGS_KEY/);
    expect(pairRows(db)).toHaveLength(0);
  });

  it('a row left from before (pair:<CODE>) pairs nothing and goes with the sweep', async () => {
    const db = testD1();
    const s = (await createSession(db as any, A, 'namada', 'namada')) as Session;
    insert(db, 'kv', [{ key: 'pair:CDCDCDCD', value: JSON.stringify({ address: A, chain: 'namada', expiresAt: Date.now() + 600000, by: tokenHash(s.token) }), updated_at: Date.now() }]);
    expect((await claimPairCode(db as any, 'CDCDCDCD', KEY)).error).toMatch(/expired or already used/);
    expect(count(db, 'pair:CDCDCDCD')).toBe(1);
    db.raw.prepare("UPDATE kv SET value = json_set(value, '$.expiresAt', 1) WHERE key = 'pair:CDCDCDCD'").run();
    await sweepAuth(db as any);
    expect(count(db, 'pair:CDCDCDCD')).toBe(0);
  });
});

describe('a session row key sent as a bearer', () => {
  for (const via of ['namada', 'keplr', 'pair', 'api'] as const) {
    it(`is refused and leaves the live ${via} row it names`, async () => {
      const db = testD1();
      const s = (await createSession(db as any, A, 'namada', via)) as Session;
      const H = tokenHash(s.token);
      expect(await sessionFromRequest(db as any, req(H))).toBeNull();
      expect(count(db, `session:${H}`)).toBe(1);
      expect((await sessionFromRequest(db as any, req(s.token)))?.address).toBe(A);
    });
  }

  it('through GET /api/auth/me and POST /api/auth/logout, with the by field of a pair row, ends nothing', async () => {
    const db = testD1();
    const s = (await createSession(db as any, A, 'namada', 'namada')) as Session;
    await app.request('/api/auth/pair', { method: 'POST', ...bearer(s.token) }, env(db));
    const by = JSON.parse(pairRows(db)[0].value).by as string;
    expect(by).toBe(tokenHash(s.token));
    const me = await app.request('/api/auth/me', bearer(by), env(db));
    expect(((await me.json()) as any).session).toBeNull();
    const out = await app.request('/api/auth/logout', { method: 'POST', ...bearer(by) }, env(db));
    expect(out.status).toBe(200);
    expect(count(db, `session:${by}`)).toBe(1);
    expect(pairRows(db)).toHaveLength(1);
    expect((await sessionFromRequest(db as any, req(s.token)))?.address).toBe(A);
  });

  it('a row from before hashing is still refused and deleted by its own token, and only by it', async () => {
    const db = testD1();
    const t = 'a'.repeat(64);
    const legacy = { token: t, address: A, chain: 'namada', linked: null, via: 'keplr', createdAt: Date.now(), expiresAt: Date.now() + D };
    insert(db, 'kv', [{ key: `session:${t}`, value: JSON.stringify(legacy), updated_at: Date.now() }]);
    // a row at that key holding some other token is not this token's row
    const u = 'b'.repeat(64);
    insert(db, 'kv', [{ key: `session:${u}`, value: JSON.stringify({ ...legacy, token: 'c'.repeat(64) }), updated_at: Date.now() }]);
    expect(await sessionFromRequest(db as any, req(t))).toBeNull();
    expect(count(db, `session:${t}`)).toBe(0);
    expect(await sessionFromRequest(db as any, req(u))).toBeNull();
    expect(count(db, `session:${u}`)).toBe(1);
  });

  it('logout ends the caller\'s own row and its codes, and no other row', async () => {
    const db = testD1();
    const s = (await createSession(db as any, A, 'namada', 'namada')) as Session;
    const other = (await createSession(db as any, A, 'namada', 'keplr')) as Session;
    await createPairCode(db as any, s, KEY);
    await logout(db as any, s.token);
    expect(count(db, `session:${tokenHash(s.token)}`)).toBe(0);
    expect(pairRows(db)).toHaveLength(0);
    expect((await sessionFromRequest(db as any, req(other.token)))?.address).toBe(A);
  });
});
