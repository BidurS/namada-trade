// The operator's incidents through the code that runs them (worker/src/ops.ts; review of 2026-10-29): test/ops-incidents
// called watchCronStall and runOps directly, so nothing proved that the live hub's alarm looks at the cron at all, or
// at most once a minute, nor that a cron tick that throws opens the cron's incident. And the tick's lock expires
// TICK_LOCK_MS after it was taken: a tick whose end ran past it could run its ops pass beside a later tick's, both
// telling the same lines. The tick now renews the lock before the pass (cron.ts holdTickLock) and leaves the pass to
// the later tick when it lost it. Fetch is stubbed: Discord answers 204, every other host is offline.
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class { ctx: any; env: any; constructor(ctx: any, env: any) { this.ctx = ctx; this.env = env; } },
}));
import { LiveHub } from '../worker/src/live-hub';
import { holdTickLock, takeTickLock, TICK_LOCK_MS } from '../worker/src/cron';
import { CRON_STALE_MS, INCIDENT_OPEN_TICKS, OPS_KV, OPS_STALL_KV, OPS_STALL_LOOK_MS, emptyOps } from '../worker/src/ops';
import { testD1, type TestD1 } from './d1-sqlite';
import { kvJson, sent, stubDiscord, tick } from './digest-net';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const T = Date.UTC(2026, 9, 29, 12, 0, 30);
const MIN = 60_000;
const NB = ' ';
let hook = 0;
const opUrl = () => `https://discord.com/api/webhooks/7800${++hook}/ops`;
const opTexts = (url: string) => sent.filter((p) => p.url === url && typeof p.json.content === 'string').map((p) => p.json.content as string);

class NeverOpens { addEventListener() {} send() {} close() {} }

/** Discord answers 204; every other host is offline, at once. */
function offline() {
  sent.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (u: RequestInfo | URL, init?: RequestInit) => {
    const url = String(u);
    if (!url.startsWith('https://discord.com/')) throw new TypeError(`offline: ${url}`);
    sent.push({ url, json: JSON.parse(String(init?.body)), files: [], form: false, at: Date.now() });
    return new Response(null, { status: 204 });
  }));
  vi.stubGlobal('WebSocket', NeverOpens);
}

/** Runs one alarm of the hub to its end in virtual time. */
async function alarmOnce(hub: any) {
  let done = false;
  const p = hub.alarm().finally(() => { done = true; });
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; !done && i < 600; i++) await vi.advanceTimersByTimeAsync(1000);
  expect(done, 'the alarm ended').toBe(true);
  await p;
}

describe("the live hub's alarm looks at the cron", () => {
  it('opens the incident of a cron with no completed tick for 10 min, once; looks again only a minute later', async () => {
    vi.useFakeTimers({ now: T, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    offline();
    const db = testD1();
    const url = opUrl();
    // the last completed tick, 11 minutes ago
    db.raw.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)').run(OPS_KV, JSON.stringify({ ...emptyOps(), lastTickAt: T - CRON_STALE_MS - MIN }), T);
    const ctx: any = { blockConcurrencyWhile: (f: () => Promise<unknown>) => f(), storage: { getAlarm: async () => 1, setAlarm: vi.fn(async () => {}) } };
    const hub = new LiveHub(ctx, { DB: db, KEPLR_KEY: 'dummy', SEND_ALERTS: 'yes', DISCORD_WEBHOOK_URL: url } as any) as any;
    await vi.advanceTimersByTimeAsync(0);

    await alarmOnce(hub);
    expect(opTexts(url)).toEqual([`Opened: Cron ticks: no tick has completed since 29 Oct 2026, 11:49${NB}UTC (11${NB}min); the live hub looked at 29 Oct 2026, 12:00${NB}UTC.`]);
    expect(kvJson(db, OPS_STALL_KV)).toMatchObject({ since: T - 11 * MIN, toldAt: T });

    // the row removed, so a look would open it again: the alarms of the next minute do not look
    db.raw.prepare('DELETE FROM kv WHERE key = ?').run(OPS_STALL_KV);
    const lookedAt = Date.now();
    while (Date.now() - lookedAt < OPS_STALL_LOOK_MS - 6000) { await vi.advanceTimersByTimeAsync(6000); await alarmOnce(hub); }
    expect(opTexts(url)).toHaveLength(1);
    expect(kvJson(db, OPS_STALL_KV)).toBeNull();
    // a minute after the last look, the next alarm looks
    await vi.advanceTimersByTimeAsync(Math.max(0, lookedAt + OPS_STALL_LOOK_MS - Date.now()));
    await alarmOnce(hub);
    expect(opTexts(url)).toHaveLength(2);
    expect(opTexts(url)[1]).toMatch(/^Opened: Cron ticks: no tick has completed since 29 Oct 2026, 11:49/);
  });
});

describe("the cron's tick", () => {
  it(`a tick that throws writes the cron's row; on the ${INCIDENT_OPEN_TICKS}th in a row the incident opens, and three good ticks resolve it`, { timeout: 120_000 }, async () => {
    stubDiscord();
    const db = testD1();
    const prepare = db.prepare.bind(db);
    let failing = true;
    // the tick's first statement (auth.ts sweepAuth) fails as D1 does when it is down: the whole tick fails
    (db as any).prepare = (sql: string) => {
      if (failing && sql.includes('kv_session_expiry')) throw new Error('D1_ERROR: simulated');
      return prepare(sql);
    };
    const url = opUrl();
    const env = { DB: db, SEND_ALERTS: 'yes', DISCORD_WEBHOOK_URL: url } as any;
    for (let i = 0; i < INCIDENT_OPEN_TICKS - 1; i++) await tick(env, T + i * MIN);
    expect(kvJson(db, 'source.health').cron).toMatchObject({ ok: false, note: 'Error: D1_ERROR: simulated' });
    expect(opTexts(url).filter((t) => t.includes('Opened: cron'))).toEqual([]);
    await tick(env, T + (INCIDENT_OPEN_TICKS - 1) * MIN);
    expect(opTexts(url).flatMap((t) => t.split('\n')).filter((l) => l.startsWith('Opened: cron:'))).toEqual([
      `Opened: cron: not ok since 29 Oct 2026, 12:00${NB}UTC (9${NB}min, at least 10 ticks in a row): Error: D1\\_ERROR: simulated.`,
    ]);
    expect(kvJson(db, OPS_KV).open.cron).toMatchObject({ told: true });
    // the cron's row stays as the last failed tick wrote it; good ticks write none, and count as good
    failing = false;
    for (let i = INCIDENT_OPEN_TICKS; i < INCIDENT_OPEN_TICKS + 3; i++) await tick(env, T + i * MIN);
    expect(kvJson(db, 'source.health').cron).toMatchObject({ ok: false });
    expect(opTexts(url).flatMap((t) => t.split('\n')).filter((l) => l.startsWith('Resolved: cron:'))).toEqual([
      `Resolved: cron: ok again since 29 Oct 2026, 12:10${NB}UTC (3 ticks in a row); not ok from 29 Oct 2026, 12:00${NB}UTC, for 10${NB}min.`,
    ]);
    expect(kvJson(db, OPS_KV).open.cron).toBeUndefined();
  });

  it('a tick whose lock a later tick took leaves the ops pass to that one: its gap is told once, by the tick that holds the lock', { timeout: 120_000 }, async () => {
    stubDiscord();
    const db = testD1();
    const url = opUrl();
    const env = { DB: db, SEND_ALERTS: 'yes', DISCORD_WEBHOOK_URL: url } as any;
    await tick(env, T);
    const first = kvJson(db, OPS_KV).lastTickAt;
    expect(opTexts(url)).toEqual([]);
    // half an hour later a tick runs past its lock's TICK_LOCK_MS, and a later tick takes the lock while it still reads
    const realFetch = globalThis.fetch;
    let stolen = false;
    vi.stubGlobal('fetch', vi.fn(async (u: RequestInfo | URL, init?: RequestInit) => {
      if (!stolen) { stolen = true; db.raw.prepare("UPDATE kv SET value = 'later', updated_at = ? WHERE key = 'cron.lock'").run(Date.now()); }
      return realFetch(u, init);
    }));
    await tick(env, T + 30 * MIN);
    expect(stolen).toBe(true);
    // it judged nothing and told nothing: the gap's line would otherwise go out from two passes
    expect(opTexts(url)).toEqual([]);
    expect(kvJson(db, OPS_KV).lastTickAt).toBe(first);
    // the later tick ends and lets the lock go; the next tick holds its own and tells the gap once
    db.raw.prepare("DELETE FROM kv WHERE key = 'cron.lock' AND value = 'later'").run();
    stubDiscord();
    await tick(env, T + 31 * MIN);
    // from the end of the first tick's pass, a few seconds after 12:00:30
    expect(first - T).toBeLessThan(MIN);
    expect(opTexts(url)).toEqual([`Opened: Cron ticks: no tick completed from 29 Oct 2026, 12:00${NB}UTC to 29 Oct 2026, 12:31${NB}UTC (30${NB}min); ticks complete again.`]);
  });

  it('holdTickLock renews the lock it holds, so no later tick takes it for TICK_LOCK_MS; it says when another took it', async () => {
    const db = testD1();
    expect(await takeTickLock(db as any, 'a', T)).toBe(true);
    expect(await holdTickLock(db as any, 'a', T + 80_000)).toBe(true);
    expect((db.raw.prepare("SELECT updated_at FROM kv WHERE key = 'cron.lock'").get() as any).updated_at).toBe(T + 80_000);
    // without the renewal the lock taken at T would have expired at T + 90 s
    expect(await takeTickLock(db as any, 'b', T + TICK_LOCK_MS + 10_000)).toBe(false);
    expect(await takeTickLock(db as any, 'b', T + 80_000 + TICK_LOCK_MS + 1)).toBe(true);
    expect(await holdTickLock(db as any, 'a', T + 80_000 + TICK_LOCK_MS + 2)).toBe(false);
    // a D1 that cannot answer runs unlocked, as takeTickLock does
    const broken: TestD1 = testD1();
    broken.exec('DROP TABLE kv');
    expect(await holdTickLock(broken as any, 'a', T)).toBe(true);
  });
});
