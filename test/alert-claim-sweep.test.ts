// Security review (2026-10-22), alert-claim sweep: the cron's sweep deleted alert claims older than 30 days on kv's
// key range alone, so every tick read every claim kept (2,778 rows a run in production to delete none, 1,163 runs a
// day) and each claim a posted move adds was read again on every tick for its 30 days. The delete now names migration
// 0011's claim-time index and reads only the claims it deletes, however many are kept; a failed delete is logged and
// the claims it would have deleted go on the next tick that can delete them.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { testD1, insert, type TestD1 } from './d1-sqlite';
import { sweepAuth, ALERT_CLAIM_KEEP_MS } from '../worker/src/auth';
import { sendDiscordWhaleAlert } from '../worker/src/sources/discord';
import { NAM } from '../worker/src/config';
import type { Flow } from '../shared/types';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const D = 86400000;
const HOOK = 'https://discord.com/api/webhooks/1/sweep-test';
const alertKeys = (db: TestD1) => (db.raw.prepare("SELECT key FROM kv WHERE key >= 'alert:' AND key < 'alert;' ORDER BY key").all() as { key: string }[]).map((r) => r.key);
const has = (db: TestD1, key: string) => (db.raw.prepare('SELECT COUNT(*) n FROM kv WHERE key = ?').get(key) as { n: number }).n === 1;

/** The statements sweepAuth prepares, each with the parameters it was bound to. */
async function sweepStatements(db: TestD1) {
  const seen: { sql: string; params: unknown[] }[] = [];
  const spy = new Proxy(db, {
    get(t, p) {
      if (p !== 'prepare') return (t as any)[p];
      return (sql: string) => {
        const rec = { sql, params: [] as unknown[] };
        seen.push(rec);
        const s = t.prepare(sql);
        return new Proxy(s, {
          get(st, q) {
            if (q === 'bind') return (...a: unknown[]) => { rec.params = a; return st.bind(...a); };
            const v = (st as any)[q];
            return typeof v === 'function' ? v.bind(st) : v;
          },
        });
      };
    },
  });
  await sweepAuth(spy as any);
  return seen;
}

/**
 * The rows a DELETE reads: the same FROM (and index) and WHERE as a counting SELECT whose first term counts each row
 * the search hands it. Its plan is checked to be the DELETE's own.
 */
function rowsRead(db: TestD1, sql: string, params: unknown[]) {
  let n = 0;
  db.raw.function('sweep_visit', { deterministic: false }, (_rowid: unknown) => { n++; return 1; });
  const counted = sql.replace(/^DELETE FROM kv/, 'SELECT COUNT(*) c FROM kv').replace(' WHERE ', ' WHERE sweep_visit(rowid) AND ');
  const plan = (q: string) => (db.raw.prepare(`EXPLAIN QUERY PLAN ${q}`).all(...params) as { detail: string }[]).map((r) => r.detail);
  expect(plan(counted)).toEqual(plan(sql));
  n = 0;
  const matched = (db.raw.prepare(counted).get(...params) as { c: number }).c;
  return { read: n, matched, plan: plan(sql).join(' | ') };
}

describe('the alert-claim sweep reads the expired claims only', () => {
  it('5,000 claims inside the 30 days and 103 past them: the delete reads 103 rows and deletes them', async () => {
    const db = testD1();
    const now = Date.now();
    const expired = now - ALERT_CLAIM_KEEP_MS - D;
    // A day old: past the day any move can still be alerted for, inside the keep time.
    insert(db, 'kv', Array.from({ length: 5000 }, (_, i) => ({ key: `alert:flow:namada:K${i}:t:0`, value: '1', updated_at: now - D })));
    insert(db, 'kv', [{ key: 'alert:flow:osmosis:NEW:x:0', value: '1', updated_at: now }, { key: 'alert:ibc:channel-1:7:ab12', value: '1', updated_at: now }]);
    insert(db, 'kv', Array.from({ length: 100 }, (_, i) => ({ key: `alert:flow:osmosis:OLD${i}:x:0`, value: '1', updated_at: expired })));
    // Every claim kind the alert paths write (sources/discord.ts), past the keep time.
    insert(db, 'kv', [
      { key: 'alert:ibc:channel-1:9:cd34', value: '1', updated_at: expired },
      { key: 'alert:forum:post:42', value: '1', updated_at: expired },
      { key: 'alert:gov:prop:5:passed', value: '1', updated_at: expired },
    ]);
    // Rows beside the alert range, as old: never the sweep's.
    insert(db, 'kv', [
      { key: 'alerts.skipped', value: '{"total":1}', updated_at: expired },
      { key: 'alert', value: 'x', updated_at: expired },
      { key: 'holders.marks', value: '{}', updated_at: expired },
      { key: 'user:tnam1sweeptest', value: '{}', updated_at: expired },
    ]);

    // The statement as sweepAuth sends it, measured on the rows as they are before it runs.
    const probe = testD1();
    const stmts = await sweepStatements(probe);
    const del = stmts.find((s) => s.sql.includes(`'alert:'`));
    expect(del, 'sweepAuth sends an alert-claim delete').toBeTruthy();
    const m = rowsRead(db, del!.sql, del!.params);
    expect(m.plan).toMatch(/^SEARCH kv USING INDEX kv_alert_claim_time \(updated_at<\?\)$/);
    expect(m.matched).toBe(103);
    expect(m.read).toBe(103);

    expect(alertKeys(db)).toHaveLength(5105);
    await sweepAuth(db as any);
    const left = alertKeys(db);
    expect(left).toHaveLength(5002);
    expect(left.some((k) => /OLD|cd34|forum|gov/.test(k))).toBe(false);
    for (const k of ['alert:flow:osmosis:NEW:x:0', 'alert:ibc:channel-1:7:ab12', 'alert:flow:namada:K0:t:0', 'alert:flow:namada:K4999:t:0']) expect(has(db, k)).toBe(true);
    for (const k of ['alerts.skipped', 'alert', 'holders.marks', 'user:tnam1sweeptest']) expect(has(db, k)).toBe(true);
  });

  it('the claims the alert path writes are in the index: a posted move and its crossing are swept once expired', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    const db = testD1();
    const crossing: Flow = {
      id: 'osmosis:SWEEPTX:recv:0', chain: 'osmosis', kind: 'ibc_in', txHash: 'SWEEPTX', amount: 20000, from: 'tnam1sender', to: 'osmo1receiver',
      ts: Date.now(), height: 1, priceUsd: null, valueUsd: null, meta: { channel: NAM.osmoChannel, packetSequence: '991' },
    };
    await sendDiscordWhaleAlert(HOOK, crossing, db as any, 10000);
    const claimed = alertKeys(db);
    expect(claimed).toHaveLength(2);
    expect(claimed[0]).toBe('alert:flow:osmosis:SWEEPTX:recv:0');
    expect(claimed[1]).toMatch(/^alert:ibc:/);
    const indexed = (db.raw.prepare("SELECT COUNT(*) n FROM kv INDEXED BY kv_alert_claim_time WHERE key >= 'alert:' AND key < 'alert;' AND updated_at < ?").get(Date.now() + 1) as { n: number }).n;
    expect(indexed).toBe(2);
    await sweepAuth(db as any);
    expect(alertKeys(db)).toHaveLength(2);
    db.raw.prepare('UPDATE kv SET updated_at = ? WHERE key >= ? AND key < ?').run(Date.now() - ALERT_CLAIM_KEEP_MS - 1000, 'alert:', 'alert;');
    await sweepAuth(db as any);
    expect(alertKeys(db)).toEqual([]);
  });

  it('without the index the delete fails visibly, the rest of the sweep runs, and the claims go once it is back', async () => {
    const db = testD1();
    const now = Date.now();
    db.raw.exec('DROP INDEX kv_alert_claim_time');
    insert(db, 'kv', [
      { key: 'alert:flow:namada:GONE:t:0', value: '1', updated_at: now - ALERT_CLAIM_KEEP_MS - D },
      { key: `session:${'e'.repeat(64)}`, value: JSON.stringify({ address: 'tnam1sweeptest', chain: 'namada', kind: 'namada', expiresAt: now - 1000 }), updated_at: now - D },
    ]);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(sweepAuth(db as any)).resolves.toBeUndefined();
    expect(err.mock.calls.some((c) => String(c[0]).includes('alert claims'))).toBe(true);
    expect(has(db, `session:${'e'.repeat(64)}`)).toBe(false);
    expect(has(db, 'alert:flow:namada:GONE:t:0')).toBe(true);
    db.raw.exec(readFileSync(join(__dirname, '..', 'migrations', '0011_alert_claim_time.sql'), 'utf8'));
    await sweepAuth(db as any);
    expect(has(db, 'alert:flow:namada:GONE:t:0')).toBe(false);
  });
});
