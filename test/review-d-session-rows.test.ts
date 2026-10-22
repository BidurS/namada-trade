// Security review (2026-10-22): the cost of anonymous and signed-in requests. The session and API-key rows
// of one address are found on migration 0009's partial indexes, so a sign-in, a key, the devices list, a revoke
// and the cron's sweep cost that address's own rows (or the expired ones), never every session row on the site;
// and a failed read or delete of them is an error, never "this address has none".
import { describe, it, expect } from 'vitest';
import { app } from '../worker/src/api';
import { testD1, type TestD1 } from './d1-sqlite';
import { createSession, listSessions, revokeSession, revokeAllSessions, sweepAuth, tokenHash, MAX_API_KEYS, type Session } from '../worker/src/auth';

const A = 'tnam1qsessrowsxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const OTHERS = 10_000;
const DAY = 86_400_000;
const env = (db: TestD1) => ({ DB: db, SETTINGS_KEY: Buffer.alloc(32, 7).toString('base64') } as any);
const as = (db: TestD1, token: string, method: string, path: string) => app.request(path, { method, headers: { Authorization: `Bearer ${token}` } }, env(db));
const count = (db: TestD1, where: string, ...p: unknown[]) => (db.raw.prepare(`SELECT COUNT(*) n FROM kv WHERE ${where}`).get(...p) as { n: number }).n;
const ofA = "key >= 'session:' AND key < 'session;' AND json_extract(value, '$.address') = ?";

/** OTHERS session and key rows of other addresses, as createSession writes them; every 10th one expired. */
function crowded(): TestD1 {
  const db = testD1();
  const now = Date.now();
  const ins = db.raw.prepare('INSERT INTO kv (key,value,updated_at) VALUES (?,?,?)');
  db.exec('BEGIN');
  for (let i = 0; i < OTHERS; i++) {
    ins.run(`session:${tokenHash(`other-${i}`)}`, JSON.stringify({ address: `tnam1qother${i}`, chain: 'namada', linked: null, via: i % 3 ? 'api' : 'namada', createdAt: now - 2 * DAY, expiresAt: i % 10 ? now + DAY : now - 1, lastUsedAt: null }), now);
  }
  db.exec('COMMIT');
  return db;
}

/** The query plan of every statement `fn` prepares. */
async function plansOf(db: TestD1, fn: () => Promise<unknown>): Promise<{ sql: string; plan: string }[]> {
  const seen: string[] = [];
  const prepare = db.prepare;
  db.prepare = (sql: string) => { seen.push(sql); return prepare(sql); };
  try { await fn(); } finally { db.prepare = prepare; }
  return seen.map((sql) => ({ sql, plan: db.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((r: any) => r.detail).join(' | ') }));
}

/** Statements whose SQL matches `re` fail as D1 does when a query cannot run. */
function failing(db: TestD1, re: RegExp) {
  const prepare = db.prepare;
  const err = () => Promise.reject(new Error('D1_ERROR: simulated'));
  db.prepare = ((sql: string) => (re.test(sql) ? { bind() { return this; }, all: err, run: err, first: err } : prepare(sql))) as any;
}
/** sessionRows' and revokeAllSessions' statements, written either way (before 0009 and after). */
const BY_ADDRESS = /kv_session_addr|'session:'[^]*'\$\.address'/;

describe('D: the session rows of one address are read on an index, never by reading every session row', () => {
  it('sign-in, a new key, the devices list, revokes and the sweep never scan kv or the session key range', async () => {
    const db = crowded();
    const device = (await createSession(db as any, A, 'namada', 'namada')) as Session;
    const plans = await plansOf(db, async () => {
      await createSession(db as any, A, 'namada', 'keplr');
      const key = (await createSession(db as any, A, 'namada', 'api', null, tokenHash(device.token))) as Session;
      await listSessions(db as any, A, device.token);
      await revokeSession(db as any, A, tokenHash(key.token).slice(0, 8), true);
      await revokeSession(db as any, A, tokenHash(device.token).slice(0, 8));
      await revokeAllSessions(db as any, 'tnam1qother1');
      await sweepAuth(db as any);
    });
    const onKv = plans.filter((p) => /\bkv\b/.test(p.plan));
    expect(onKv.length).toBeGreaterThan(10);
    for (const p of onKv) {
      // no statement reads the whole table
      expect(p.plan, p.sql).not.toMatch(/SCAN kv\b/);
      // a statement on the session key range reads it through one of 0009's indexes, never as a range of the primary key
      if (/'session:'/.test(p.sql)) expect(p.plan, p.sql).toMatch(/USING INDEX kv_session_(addr|expiry|legacy)\b/);
    }
  });

  it('the indexed reads answer as before among OTHERS rows of other addresses', async () => {
    const db = crowded();
    const d1 = (await createSession(db as any, A, 'namada', 'namada')) as Session;
    const d2 = (await createSession(db as any, A, 'namada', 'keplr')) as Session;
    const k = (await createSession(db as any, A, 'namada', 'api', null, tokenHash(d1.token))) as Session;
    const listed = await listSessions(db as any, A, d1.token);
    expect(listed.map((x) => x.via).sort()).toEqual(['api', 'keplr', 'namada']);
    expect(listed.filter((x) => x.current)).toHaveLength(1);
    expect(await revokeSession(db as any, A, tokenHash(k.token).slice(0, 8), true)).toBe(true);
    expect(await revokeSession(db as any, A, tokenHash(d2.token).slice(0, 8), true)).toBe('forbidden');
    expect(await revokeSession(db as any, 'tnam1qother1', tokenHash(d2.token).slice(0, 8))).toBe(false); // another address's id ends nothing
    expect(await revokeSession(db as any, A, tokenHash(d2.token).slice(0, 8))).toBe(true);
    await revokeAllSessions(db as any, A);
    expect(count(db, ofA, A)).toBe(0);
    expect(count(db, "key >= 'session:' AND key < 'session;'")).toBe(OTHERS);
    // a legacy row (token in the value) and the expired rows go with the sweep; the live ones stay
    db.raw.prepare('INSERT INTO kv (key,value,updated_at) VALUES (?,?,?)').run(`session:${'c'.repeat(64)}`, JSON.stringify({ token: 'c'.repeat(64), address: A, via: 'api', createdAt: 1, expiresAt: Date.now() + DAY }), 1);
    await sweepAuth(db as any);
    expect(count(db, "key >= 'session:' AND key < 'session;'")).toBe(OTHERS - OTHERS / 10);
  });

  it('a value that is not JSON can still be written outside the session range (the indexes are partial)', async () => {
    const db = testD1();
    db.raw.prepare('INSERT OR REPLACE INTO kv (key,value,updated_at) VALUES (?,?,?)').run('webhook_test:x', 'not json', 1);
    expect(count(db, 'key = ?', 'webhook_test:x')).toBe(1);
  });
});

describe('D: a failed read or delete of the session rows is an error, never an empty answer', () => {
  it('a new key past MAX_API_KEYS is not made when the rows cannot be read', async () => {
    const db = testD1();
    const s = (await createSession(db as any, A, 'namada', 'keplr')) as Session;
    for (let i = 0; i < MAX_API_KEYS; i++) await createSession(db as any, A, 'namada', 'api');
    failing(db, BY_ADDRESS);
    const res = await as(db, s.token, 'POST', '/api/me/apikey');
    expect(res.status).toBe(500);
    expect(count(db, `${ofA} AND json_extract(value, '$.via') = 'api'`, A)).toBe(MAX_API_KEYS);
  });
  it('the devices list and the data export answer 500, not an empty list', async () => {
    const db = testD1();
    const s = (await createSession(db as any, A, 'namada', 'keplr')) as Session;
    failing(db, BY_ADDRESS);
    expect((await as(db, s.token, 'GET', '/api/me/sessions')).status).toBe(500);
    expect((await as(db, s.token, 'GET', '/api/me/export')).status).toBe(500);
  });
  it('Delete everything does not answer success when the sessions were not deleted', async () => {
    const db = testD1();
    const s = (await createSession(db as any, A, 'namada', 'keplr')) as Session;
    await createSession(db as any, A, 'namada', 'api');
    failing(db, BY_ADDRESS);
    const res = await as(db, s.token, 'DELETE', '/api/me');
    expect(res.status).toBe(500);
    expect(((await res.json()) as any).success).toBeUndefined();
  });
});
