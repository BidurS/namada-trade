// Merged stage 1 review (2026-10-29), deploy safety: the two cron-stall checks looked only at kv ops.incidents'
// lastTickAt, which only this code's ops pass writes. A rolled-back Worker (afe8a1b) completes its ticks without it, so
// after a rollback of more than CRON_STALE_MS and a deploy again, the hub's first look and the first tick read the
// rollback as a cron that had stopped: "Opened: Cron ticks: no tick has completed since ..." to the operator, a
// "Resolved" after it, and /api/health at 503 between, all false. A minute the tick stores whatever its version (the NAM
// price, the supply) now counts as a tick that ran; a cron that stopped stores neither. Fetch is stubbed: Discord answers
// 204, every other host is offline.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CRON_TICKS, OPS_KV, OPS_STALL_KV, TICK_MARK_SQL, emptyOps, runOps, watchCronStall } from '../worker/src/ops';
import { testD1, type TestD1 } from './d1-sqlite';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const T = Date.UTC(2026, 10, 2, 12, 0, 30);
const MIN = 60_000, H = 3_600_000;
const kvJson = (db: TestD1, key: string) => { const r = db.raw.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined; return r ? JSON.parse(r.value) : null; };
function setup(rolledBack: boolean) {
  const told: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (u: RequestInfo | URL, init?: RequestInit) => {
    if (!String(u).startsWith('https://discord.com/')) throw new TypeError('offline');
    told.push(String(JSON.parse(String(init?.body)).content));
    return new Response(null, { status: 204 });
  }));
  const db = testD1();
  // this code's last tick two hours ago; then, rolled back, the earlier version ran a tick every minute
  db.raw.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)').run(OPS_KV, JSON.stringify({ ...emptyOps(), lastTickAt: T - 2 * H }), T - 2 * H);
  if (rolledBack) {
    const ins = db.raw.prepare('INSERT INTO metrics (ts, key, value) VALUES (?, ?, ?)');
    for (let t = T - 2 * H + MIN; t < T; t += MIN) { ins.run(t, 'price.usd', 0.0009); ins.run(t, 'supply.total', 1e9); }
  }
  const env = { DB: db, SEND_ALERTS: 'yes', DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/ops' } as any;
  return { db, env, told };
}

describe('the cron-stall checks after a rollback and a deploy again', () => {
  it('the hub\'s look: ticks of the earlier version count, so nothing is opened or told', async () => {
    const { db, env, told } = setup(true);
    expect(await watchCronStall(env, T)).toBe('fresh');
    expect(kvJson(db, OPS_STALL_KV)).toBeNull();
    expect(told).toEqual([]);
  });

  it('the first tick: no gap is opened, resolved or told', async () => {
    vi.useFakeTimers({ now: T + 5_000, toFake: ['Date'] });
    const { db, env, told } = setup(true);
    const s = await runOps(env, T, T + 5_000);
    expect(s?.open[CRON_TICKS]).toBeUndefined();
    expect(told.join('\n')).not.toContain(CRON_TICKS);
    expect(kvJson(db, OPS_KV).lastTickAt).toBeGreaterThanOrEqual(T);
  });

  it('a cron that stopped stores no minute: the look opens it and the first tick after the gap takes it over', async () => {
    const { db, env, told } = setup(false);
    expect(await watchCronStall(env, T)).toBe('stalled');
    expect(told[0]).toMatch(/^Opened: Cron ticks: no tick has completed since /);
    const s = await runOps(env, T, T + 5_000);
    expect(s?.open[CRON_TICKS]).toMatchObject({ what: 'stopped', since: T - 2 * H });
  });

  it('the tick\'s own minute is not counted for it, and the mark reads one seek on each key', () => {
    const { db } = setup(true);
    db.raw.prepare('INSERT INTO metrics (ts, key, value) VALUES (?, ?, ?)').run(T, 'price.usd', 0.0009);
    // the newest minute before the tick's own (T): the earlier version's last, a minute before
    expect((db.raw.prepare(TICK_MARK_SQL).get(T) as { t: number }).t).toBe(T - MIN);
    const plan = (db.raw.prepare(`EXPLAIN QUERY PLAN ${TICK_MARK_SQL}`).all(T) as { detail: string }[]).map((r) => r.detail).join(' | ');
    expect(plan).not.toMatch(/SCAN metrics/);
  });
});
