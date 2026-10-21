// Security review run-2, group A (2026-10-21): revocation of sessions, pair codes and API keys, and the legacy
// plaintext alert settings. Each block names the lead it guards.
import { describe, it, expect } from 'vitest';
import { app, FULL_SESSION_ONLY } from '../worker/src/api';
import { testD1, insert } from './d1-sqlite';
import {
  createSession, createPairCode, claimPairCode, sessionFromRequest, listSessions, logout, revokeSession, revokeAllSessions,
  touchSession, sweepAuth, tokenHash, PARENT_ENDED, type Session,
} from '../worker/src/auth';
import { loadSettings, saveSettings, defaultPrefs } from '../worker/src/settings';

const A = 'tnam1qrevokexxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const env = (db: ReturnType<typeof testD1>) => ({ DB: db } as any);
const req = (token: string) => new Request('https://namada.trade/api/auth/me', { headers: { Authorization: `Bearer ${token}` } });
const as = (token: string, method: string, path: string) => app.request(path, { method, headers: { Authorization: `Bearer ${token}` } }, env(testDb));
let testDb: ReturnType<typeof testD1>;
const device = async (via: 'namada' | 'keplr' | 'pair' = 'namada') => (await createSession(testDb as any, A, 'namada', via)) as Session;
const key = async () => (await createSession(testDb as any, A, 'namada', 'api')) as Session;
const row = (k: string) => testDb.raw.prepare('SELECT value FROM kv WHERE key = ?').get(k) as { value: string } | undefined;
const idOf = (s: Session) => tokenHash(s.token).slice(0, 8);

describe('A1: a pair code lives only as long as the device that made it', () => {
  it('logout of the making device deletes its codes, and a code it made cannot pair afterwards', async () => {
    testDb = testD1();
    const s = await device();
    const { code } = (await createPairCode(testDb as any, s)) as { code: string };
    await logout(testDb as any, s.token);
    expect(row(`pair:${code}`)).toBeUndefined();
    expect((await claimPairCode(testDb as any, code)).session).toBeUndefined();
  });
  it('Revoke of the making device and Delete everything both end its codes', async () => {
    testDb = testD1();
    const s = await device();
    const other = await device('keplr');
    const { code } = (await createPairCode(testDb as any, s)) as { code: string };
    expect(await revokeSession(testDb as any, A, idOf(s))).toBe(true);
    expect(row(`pair:${code}`)).toBeUndefined();
    const { code: code2 } = (await createPairCode(testDb as any, other)) as { code: string };
    await revokeAllSessions(testDb as any, A);
    expect(row(`pair:${code2}`)).toBeUndefined();
    expect((await claimPairCode(testDb as any, code2)).session).toBeUndefined();
  });
  it('a code whose maker was ended while the code row stayed (a revoke racing createPairCode) pairs nothing', async () => {
    testDb = testD1();
    const s = await device();
    const { code } = (await createPairCode(testDb as any, s)) as { code: string };
    // the maker's row goes, the code row is left behind
    testDb.raw.prepare('DELETE FROM kv WHERE key = ?').run(`session:${tokenHash(s.token)}`);
    const r = await claimPairCode(testDb as any, code);
    expect(r).toEqual({ error: PARENT_ENDED });
    expect(row(`pair:${code}`)).toBeUndefined();
    expect((await listSessions(testDb as any, A, s.token)).length).toBe(0);
  });
  it('a live maker still pairs, once', async () => {
    testDb = testD1();
    const s = await device();
    const { code } = (await createPairCode(testDb as any, s)) as { code: string };
    const r = await claimPairCode(testDb as any, code);
    expect(r.session?.via).toBe('pair');
    expect((await claimPairCode(testDb as any, code)).session).toBeUndefined();
  });
});

describe('A2: the "last used" touch never writes back a deleted session', () => {
  it('touch after a logout leaves no row; touch on a live row only sets lastUsedAt', async () => {
    testDb = testD1();
    const s = await device();
    const k = `session:${tokenHash(s.token)}`;
    const before = JSON.parse(row(k)!.value);
    await touchSession(testDb as any, k, 123);
    const after = JSON.parse(row(k)!.value);
    expect(after).toEqual({ ...before, lastUsedAt: 123 });
    await logout(testDb as any, s.token);
    await touchSession(testDb as any, k, 456);
    expect(row(k)).toBeUndefined();
    expect(await sessionFromRequest(testDb as any, req(s.token))).toBeNull();
  });
  it('a request that read the session before its revoke cannot bring it back with its touch', async () => {
    testDb = testD1();
    const s = await device();
    const k = `session:${tokenHash(s.token)}`;
    // the read happens, the touch is due (no lastUsedAt yet), then the revoke lands before the touch is written
    const seen = await sessionFromRequest(testDb as any, req(s.token));
    expect(seen?.address).toBe(A);
    testDb.raw.prepare('DELETE FROM kv WHERE key = ?').run(k);
    await touchSession(testDb as any, k, Date.now());
    expect(row(k)).toBeUndefined();
  });
});

describe('A3: a key or pairing made from a session ended meanwhile does not survive', () => {
  it('createSession with a parent that is gone deletes the new row and refuses', async () => {
    testDb = testD1();
    const s = await device();
    const parent = tokenHash(s.token);
    testDb.raw.prepare('DELETE FROM kv WHERE key = ?').run(`session:${parent}`);
    const r = await createSession(testDb as any, A, 'namada', 'api', null, parent);
    expect(r).toEqual({ error: PARENT_ENDED });
    expect((testDb.raw.prepare("SELECT COUNT(*) n FROM kv WHERE key LIKE 'session:%'").get() as any).n).toBe(0);
  });
  it('a parent that is an API key, belongs to another address or has expired is not a parent', async () => {
    testDb = testD1();
    const k = await key();
    expect(await createSession(testDb as any, A, 'namada', 'api', null, tokenHash(k.token))).toEqual({ error: PARENT_ENDED });
    const other = (await createSession(testDb as any, 'tnam1qotherxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', 'namada', 'namada')) as Session;
    expect(await createSession(testDb as any, A, 'namada', 'api', null, tokenHash(other.token))).toEqual({ error: PARENT_ENDED });
    const old = await device();
    testDb.raw.prepare("UPDATE kv SET value = json_set(value, '$.expiresAt', 1) WHERE key = ?").run(`session:${tokenHash(old.token)}`);
    expect(await createSession(testDb as any, A, 'namada', 'api', null, tokenHash(old.token))).toEqual({ error: PARENT_ENDED });
  });
  it('POST /api/me/apikey from a live device still makes a key, which then works', async () => {
    testDb = testD1();
    const s = await device();
    const res = await as(s.token, 'POST', '/api/me/apikey');
    expect(res.status).toBe(200);
    const { token } = (await res.json()) as { token: string };
    expect((await sessionFromRequest(testDb as any, req(token)))?.via).toBe('api');
  });
});

describe('A4: an API key cannot lock its owner out', () => {
  it('a key cannot end a signed-in or paired device, nor delete the account', async () => {
    testDb = testD1();
    const s = await device();
    const p = await device('pair');
    const k = await key();
    for (const target of [s, p]) {
      const res = await as(k.token, 'DELETE', `/api/me/sessions/${idOf(target)}`);
      expect(res.status).toBe(403);
      expect(((await res.json()) as any).error).toBe(FULL_SESSION_ONLY.revokeDevice);
      expect(await sessionFromRequest(testDb as any, req(target.token))).not.toBeNull();
    }
    const del = await as(k.token, 'DELETE', '/api/me');
    expect(del.status).toBe(403);
    expect(((await del.json()) as any).error).toBe(FULL_SESSION_ONLY.deleteAll);
    expect(await sessionFromRequest(testDb as any, req(s.token))).not.toBeNull();
  });
  it('a key can still end API keys and itself; a signed-in device can end the key and delete everything', async () => {
    testDb = testD1();
    const s = await device();
    const k1 = await key();
    const k2 = await key();
    expect((await as(k1.token, 'DELETE', `/api/me/sessions/${idOf(k2)}`)).status).toBe(200);
    expect(await sessionFromRequest(testDb as any, req(k2.token))).toBeNull();
    const k3 = await key();
    expect((await as(s.token, 'DELETE', `/api/me/sessions/${idOf(k3)}`)).status).toBe(200);
    expect(await sessionFromRequest(testDb as any, req(k3.token))).toBeNull();
    expect((await as(k1.token, 'POST', '/api/auth/logout')).status).toBe(200);
    expect(await sessionFromRequest(testDb as any, req(k1.token))).toBeNull();
    const k4 = await key();
    expect((await as(s.token, 'DELETE', '/api/me')).status).toBe(200);
    expect(await sessionFromRequest(testDb as any, req(k4.token))).toBeNull();
    expect(await sessionFromRequest(testDb as any, req(s.token))).toBeNull();
  });
  it('an id prefix that matches a device and a key at once is refused for a key, ending neither', async () => {
    testDb = testD1();
    const s = await device();
    const k = await key();
    // the shortest id shared by both rows: their common hash prefix, or none (then the test checks the single device)
    const hs = tokenHash(s.token), hk = tokenHash(k.token);
    let common = 0;
    while (common < 64 && hs[common] === hk[common]) common++;
    const id = common >= 8 ? hs.slice(0, common) : hs.slice(0, 8);
    expect(await revokeSession(testDb as any, A, id, true)).toBe('forbidden');
    expect(await sessionFromRequest(testDb as any, req(s.token))).not.toBeNull();
  });
});

describe('A5, A6: plaintext alert settings from before sign-in are never adopted, and are swept', () => {
  const SECRET = Buffer.alloc(32, 7).toString('base64');
  it('a webhook:user row is not read as the address\'s settings, and the sweep deletes it', async () => {
    testDb = testD1();
    insert(testDb, 'kv', [{ key: `webhook:user:${A}`, value: JSON.stringify({ webhookUrl: 'https://example.invalid/hook', watchAddresses: ['tnam1qx'], alertWhales: true }), updated_at: 1 }]);
    expect(await loadSettings(testDb as any, SECRET, A)).toBeNull();
    expect(row(`user:${A}`)).toBeUndefined();
    await sweepAuth(testDb as any);
    expect(row(`webhook:user:${A}`)).toBeUndefined();
  });
  it('sealed settings still load, and the sweep leaves them and the test cooldown rows alone', async () => {
    testDb = testD1();
    const s = { address: A, notifications: defaultPrefs(), channels: { discord: { enabled: false, webhookUrl: null } }, createdAt: 1, updatedAt: 2 };
    await saveSettings(testDb as any, SECRET, s);
    insert(testDb, 'kv', [{ key: `webhook_test:${A}`, value: String(Date.now()), updated_at: Date.now() }]);
    await sweepAuth(testDb as any);
    expect(await loadSettings(testDb as any, SECRET, A)).toEqual(s);
    expect(row(`webhook_test:${A}`)).toBeDefined();
  });
});
