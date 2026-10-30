// Scale plan 2026-10-29, Stage 1 item 7: the site has no analytics, so how many read it live was not known. The live
// hub now counts its open sockets each hour and writes the most it held at once to metrics (site.live_sockets,
// labelled with the hour's start) with the minutes of the hour the count covered (site.live_sockets.minutes): one
// batch an hour, at the first alarm after the hour ends, from the count it keeps in memory, so nothing of a reader is
// kept and nothing is written per socket. The hour's count so far is kept in the object's storage at most once a
// minute (and at once after a write), so a deploy mid-hour goes on counting the hour; a write D1 refuses is tried
// again by the next alarm; an hour written again never lowers its figure. /api/metrics/history serves both keys.
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class { ctx: any; env: any; constructor(ctx: any, env: any) { this.ctx = ctx; this.env = env; } },
}));
import { LiveHub, LIVE_SOCKETS_KEY, LIVE_SOCKETS_MINUTES_KEY, SOCKET_MARK_SAVE_MS, SOCKET_MARK_STORE, liveSocketStmts } from '../worker/src/live-hub';
import { app } from '../worker/src/api';
import { runStmts, testD1, type TestD1 } from './d1-sqlite';
import { memStorage, type MemStorage } from './do-storage';
import { stubHubSockets, type FakeSocket } from './hub-sockets';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const MIN = 60_000, HOUR = 3_600_000;
const T10 = Date.UTC(2026, 9, 29, 10);
const at = (h: number, m: number, s = 0) => T10 + (h - 10) * HOUR + m * MIN + s * 1000;

interface Rig { db: TestD1; storage: MemStorage; writes: number[]; puts: number[]; refuse: { n: number }; sockets: FakeSocket[] }

function rig(): Rig {
  const db = testD1();
  const storage = memStorage();
  const writes: number[] = [], puts: number[] = [];
  const refuse = { n: 0 };
  const batch = db.batch.bind(db);
  db.batch = async (stmts: any[]) => {
    if (stmts.some((s) => String(s.sql).includes('MAX(value, excluded.value)'))) {
      if (refuse.n > 0) { refuse.n--; throw new Error('D1_ERROR: the database is busy'); }
      writes.push(Date.now());
    }
    return batch(stmts);
  };
  const put = storage.put.bind(storage);
  storage.put = async (k: string, v: unknown) => { if (k === SOCKET_MARK_STORE) puts.push(Date.now()); return put(k, v); };
  const sockets = stubHubSockets();
  // the router and every node are out of reach: the hub's context fails at once, and nothing here needs it
  vi.stubGlobal('fetch', vi.fn(async (u: unknown) => { throw new TypeError(`offline: ${String(u)}`); }));
  return { db, storage, writes, puts, refuse, sockets };
}

/** A hub instance on the rig's storage, its constructor's storage read awaited. */
async function start(r: Rig) {
  let entered: Promise<unknown> | null = null;
  const ctx: any = { blockConcurrencyWhile: (f: () => Promise<unknown>) => (entered = f()), storage: r.storage };
  const hub = new LiveHub(ctx, { DB: r.db } as any) as any;
  await entered;
  return hub;
}
const open = async (hub: any, n: number) => {
  for (let i = 0; i < n; i++) {
    const res = await hub.fetch(new Request('https://namada.trade/ws', { headers: { Upgrade: 'websocket', 'cf-connecting-ip': `203.0.113.${i}` } }));
    expect(res.status).toBe(101);
  }
};
const closeSome = (r: Rig, hub: any, n: number) => {
  for (const s of r.sockets.filter((x) => hub.sessions.has(x)).slice(0, n)) s.fire('close');
};
/** The alarm's part: every 6 s from `from` to `to`, as the alarm does it. */
async function alarms(hub: any, from: number, to: number) {
  for (let t = from; t < to; t += 6000) {
    vi.setSystemTime(t);
    await hub.noteSockets(t);
  }
}
const rows = (db: TestD1) => db.raw.prepare("SELECT ts, key, value FROM metrics WHERE key LIKE 'site.live_sockets%' ORDER BY ts, key").all().map((x: any) => [x.ts, x.key, x.value]);

describe('the live feed\'s hourly count of open sockets', () => {
  it('one batch an hour, at the first alarm after it ends: the most open at once and the minutes counted; a socket leaving just after the hour began counts in the new one', async () => {
    vi.useFakeTimers({ now: at(10, 20), toFake: ['Date'] });
    const r = rig();
    const hub = await start(r);
    vi.setSystemTime(at(10, 21)); await open(hub, 3);
    await alarms(hub, at(10, 21), at(10, 30));
    vi.setSystemTime(at(10, 30)); closeSome(r, hub, 1);
    await alarms(hub, at(10, 30), at(10, 45));
    vi.setSystemTime(at(10, 45)); await open(hub, 4); // six open at once
    vi.setSystemTime(at(10, 50)); closeSome(r, hub, 5);
    await alarms(hub, at(10, 50, 1), at(10, 59, 59));
    expect(r.writes).toEqual([]); // the hour has not ended at the last alarm before it does
    await alarms(hub, at(11, 0, 4), at(11, 10));
    expect(r.writes).toEqual([at(11, 0, 4)]);
    expect(rows(r.db)).toEqual([[T10, LIVE_SOCKETS_KEY, 6], [T10, LIVE_SOCKETS_MINUTES_KEY, 40]]);

    vi.setSystemTime(at(11, 10)); await open(hub, 2); // three
    await alarms(hub, at(11, 10), at(11, 59, 58));
    // two readers leave a second after 12:00, before any alarm: they were open when the hour began
    vi.setSystemTime(at(12, 0, 1)); closeSome(r, hub, 2);
    await alarms(hub, at(12, 0, 3), at(13, 0, 3));
    await alarms(hub, at(13, 0, 3), at(13, 0, 4));
    expect(r.writes).toEqual([at(11, 0, 4), at(12, 0, 3), at(13, 0, 3)]);
    expect(rows(r.db)).toEqual([
      [T10, LIVE_SOCKETS_KEY, 6], [T10, LIVE_SOCKETS_MINUTES_KEY, 40],
      [T10 + HOUR, LIVE_SOCKETS_KEY, 3], [T10 + HOUR, LIVE_SOCKETS_MINUTES_KEY, 60],
      [T10 + 2 * HOUR, LIVE_SOCKETS_KEY, 3], [T10 + 2 * HOUR, LIVE_SOCKETS_MINUTES_KEY, 60],
    ]);
    // the storage took the count at most once a minute, except right after a write
    const gaps = r.puts.slice(1).map((t, i) => [t - r.puts[i], t] as const);
    for (const [gap, t] of gaps) if (!r.writes.includes(t)) expect(gap).toBeGreaterThanOrEqual(SOCKET_MARK_SAVE_MS);
    expect(r.puts.length).toBeLessThanOrEqual(3 * 60 + 3);
  });

  it('a deploy mid-hour goes on counting the hour from the storage; a write D1 refuses is written by the next alarm', async () => {
    vi.useFakeTimers({ now: at(10, 0), toFake: ['Date'] });
    const r = rig();
    const first = await start(r);
    vi.setSystemTime(at(10, 5)); await open(first, 5);
    await alarms(first, at(10, 5), at(10, 20));
    // the deploy: every socket goes, a new instance reads the stored count, two readers come back
    const second = await start(r);
    vi.setSystemTime(at(10, 21)); await open(second, 2);
    await alarms(second, at(10, 21), at(11, 0));
    r.refuse.n = 1;
    await alarms(second, at(11, 0), at(11, 0, 6));
    expect(r.writes).toEqual([]);
    expect(rows(r.db)).toEqual([]);
    await alarms(second, at(11, 0, 6), at(11, 0, 12));
    expect(r.writes).toEqual([at(11, 0, 6)]);
    expect(rows(r.db)).toEqual([[T10, LIVE_SOCKETS_KEY, 5], [T10, LIVE_SOCKETS_MINUTES_KEY, 60]]);

    // a restart before the storage took the write ends the stored hour again: written again, it is not lowered
    await runStmts(r.db, liveSocketStmts({ hour: T10, max: 2, from: at(10, 30) }));
    expect(rows(r.db)).toEqual([[T10, LIVE_SOCKETS_KEY, 5], [T10, LIVE_SOCKETS_MINUTES_KEY, 60]]);
  });

  it('a first count after the hour began says so, and a stored count that cannot be read starts one now', async () => {
    vi.useFakeTimers({ now: at(10, 45, 30), toFake: ['Date'] });
    const r = rig();
    r.storage.get = async () => { throw new Error('storage unavailable'); };
    const hub = await start(r);
    await open(hub, 1);
    await alarms(hub, at(10, 45, 30), at(11, 0, 5));
    expect(rows(r.db)).toEqual([[T10, LIVE_SOCKETS_KEY, 1], [T10, LIVE_SOCKETS_MINUTES_KEY, 15]]);
  });

  it('is served by /api/metrics/history, one point an hour', async () => {
    const db = testD1();
    await runStmts(db, [...liveSocketStmts({ hour: T10, max: 6, from: at(10, 20) }), ...liveSocketStmts({ hour: T10 + HOUR, max: 3, from: T10 + HOUR })]);
    const get = async (q: string) => (await app.request(`/api/metrics/history?${q}`, {}, { DB: db } as any)).json() as Promise<any>;
    const marks = await get(`key=${LIVE_SOCKETS_KEY}&hours=24&at=${at(12, 30)}`);
    expect(marks.history.map((p: any) => [p.ts, p.value])).toEqual([[T10, 6], [T10 + HOUR, 3]]);
    const minutes = await get(`key=${LIVE_SOCKETS_MINUTES_KEY}&hours=24&at=${at(12, 30)}`);
    expect(minutes.history.map((p: any) => [p.ts, p.value])).toEqual([[T10, 40], [T10 + HOUR, 60]]);
  });
});
