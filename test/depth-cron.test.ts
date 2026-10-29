// The depth phase inside the cron tick (worker/src/cron.ts phase 1b, depth plan 1.1), on the real runCron against the
// sqlite D1 stand-in and a stubbed network: the depth reads are answered from the research's saved answers of
// 2026-10-29 (test/depth-minute-net.ts), every other producer answers 404. Three ticks: a steady one, whose depth rows
// go in a batch of their own after the metrics batch and whose health rows reach kv source.health through the tick's
// merge; one whose depth minute throws, which costs the tick nothing but the depth row; and one already late when the
// phase would start, which makes no depth request and says so.
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
vi.mock('../worker/src/depth/index', async (importOriginal) => {
  const m = await importOriginal<typeof import('../worker/src/depth/index')>();
  return { ...m, minute: vi.fn(m.minute) };
});
import * as depth from '../worker/src/depth/index';
import { runCron, TICK_DEADLINE_MS } from '../worker/src/cron';
import { OSMOSIS } from '../worker/src/config';
import { testD1, insert, type TestD1 } from './d1-sqlite';
import { depthNetwork, bookKvFromFixture, paramsKvFromFixture, SQS_POOLS, REF_HEIGHT } from './depth-minute-net';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.mocked(depth.minute).mockClear(); });

/** 02:56:05 UTC on 29 Oct 2026, not a holder-sync minute. */
const T = Date.UTC(2026, 9, 29, 2, 56, 5);
const DEPTH_HOSTS = [OSMOSIS.publicRpc, OSMOSIS.publicRest, OSMOSIS.sqs];

/** The depth hosts answer from the fixtures; everything else is 404. `onPoolList` runs when the quote service's pool list is asked. */
function network(onPoolList?: () => void) {
  const n = depthNetwork();
  const calls: { url: string; method: string }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET' });
    if (url.includes('/pools?filter[denom]=')) onPoolList?.();
    if (DEPTH_HOSTS.some((h) => url.startsWith(h))) return n.fetch(url, init);
    return new Response('not here', { status: 404 });
  }));
  return calls;
}

/** A database as the minute before would have left it (a steady depth minute), with the order of every batch's first statement recorded. */
function seeded() {
  const db = testD1();
  const before = T - 60_000;
  insert(db, 'kv', [
    { key: 'depth.params', value: JSON.stringify(paramsKvFromFixture(before)), updated_at: before },
    { key: 'depth.book', value: JSON.stringify(bookKvFromFixture(before)), updated_at: before },
  ]);
  const batches: string[] = [];
  const batch = db.batch.bind(db);
  db.batch = async (stmts) => { batches.push(stmts[0]?.sql ?? ''); return batch(stmts); };
  return { db, batches };
}

async function tick(db: TestD1, start = T) {
  vi.useFakeTimers({ now: start, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  let done = false, err: unknown = null;
  runCron({ DB: db, KEPLR_KEY: '' } as any).catch((e) => { err = e; }).finally(() => { done = true; });
  for (let i = 0; !done && i < 4000; i++) await vi.advanceTimersByTimeAsync(250);
  vi.useRealTimers();
  if (err) throw err;
  expect(done).toBe(true);
}
const healthOf = (db: TestD1) => JSON.parse(db.raw.prepare("SELECT value FROM kv WHERE key='source.health'").get().value);
const count = (db: TestD1, sql: string) => db.raw.prepare(sql).get().n as number;

describe('the depth phase of the cron tick', () => {
  it('a steady tick: the minute runs on the pool list the tick read, its rows go in a batch of their own after the metrics batch, and its three health rows are merged', async () => {
    const { db, batches } = seeded();
    const calls = network();
    await tick(db);
    expect(vi.mocked(depth.minute)).toHaveBeenCalledTimes(1);
    const ctx = vi.mocked(depth.minute).mock.calls[0][2];
    expect(Array.isArray(ctx.pools) && (ctx.pools as unknown[]).length).toBe(SQS_POOLS.length); // the list as the tick read it: no second request for it
    expect(ctx.signal).toBeInstanceOf(AbortSignal);
    expect(ctx.writeAfter).toBeInstanceOf(Promise);
    expect(calls.filter((c) => c.url.startsWith(`${OSMOSIS.sqs}/pools?filter[denom]=`))).toHaveLength(1);
    expect(count(db, 'SELECT COUNT(*) n FROM depth_minute')).toBe(17);
    expect(count(db, "SELECT COUNT(*) n FROM kv WHERE key IN ('depth.latest', 'depth.states', 'depth.budget')")).toBe(3);
    // the depth batch is written after the tick's metrics batch (plan 1.1), never inside it
    const metricsAt = batches.findIndex((s) => s.startsWith('INSERT OR REPLACE INTO metrics'));
    const depthAt = batches.findIndex((s) => s.startsWith('INSERT OR REPLACE INTO depth_minute'));
    expect(metricsAt).toBeGreaterThanOrEqual(0);
    expect(depthAt).toBeGreaterThan(metricsAt);
    const h = healthOf(db);
    expect(h[depth.DEPTH_HEALTH.pools]).toMatchObject({ ok: true });
    expect(h[depth.DEPTH_HEALTH.pools].note).toMatch(new RegExp(`^14 of 14 pools read at height ${REF_HEIGHT}, \\d+ bytes over 6 requests`));
    expect(h[depth.DEPTH_HEALTH.book]).toMatchObject({ ok: true });
    expect(h[depth.DEPTH_HEALTH.store]).toMatchObject({ ok: true });
    expect(h['Osmosis SQS (pools)']).toMatchObject({ ok: true });
    expect(count(db, "SELECT COUNT(*) n FROM kv WHERE key='cron.lock'")).toBe(0);
  });

  it('a depth minute that throws: the tick keeps its metrics, its checks and its other health rows, and the depth row says what broke', async () => {
    const { db } = seeded();
    network();
    vi.mocked(depth.minute).mockRejectedValueOnce(new Error('the depth minute broke'));
    await tick(db);
    expect(count(db, 'SELECT COUNT(*) n FROM depth_minute')).toBe(0);
    expect(count(db, "SELECT COUNT(*) n FROM metrics WHERE key = 'dex.pool_count'")).toBe(1);
    expect(count(db, 'SELECT COUNT(*) n FROM checks')).toBeGreaterThan(0);
    const h = healthOf(db);
    expect(h[depth.DEPTH_HEALTH.pools]).toMatchObject({ ok: false, note: 'Error: the depth minute broke' });
    expect(h['Osmosis SQS (pools)']).toMatchObject({ ok: true });
    expect(h['Namada RPC (minted supply)']).toMatchObject({ ok: false }); // the stubbed network answers the Namada nodes 404: read, recorded, not hidden by the depth failure
    expect(Object.keys(h).length).toBeGreaterThan(10);
    expect(count(db, "SELECT COUNT(*) n FROM kv WHERE key='cron.lock'")).toBe(0);
  });

  it('a tick already late when the phase would start: no depth request, no row, the health row says it was not run', async () => {
    const { db } = seeded();
    // the clock passes the tick's deadline while the pool list is being read, so the phase finds the tick late
    const calls = network(() => vi.setSystemTime(Date.now() + TICK_DEADLINE_MS));
    await tick(db);
    expect(vi.mocked(depth.minute)).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.method === 'POST' && c.url.startsWith(OSMOSIS.publicRpc))).toHaveLength(0);
    expect(calls.filter((c) => c.url.includes('/estimate/') || c.url.includes('/smart/'))).toHaveLength(0);
    expect(count(db, 'SELECT COUNT(*) n FROM depth_minute')).toBe(0);
    const h = healthOf(db);
    expect(h[depth.DEPTH_HEALTH.pools]).toMatchObject({ ok: false, note: 'Not run this tick: the tick was already late when the depth phase would have started.' });
    expect(count(db, "SELECT COUNT(*) n FROM kv WHERE key='cron.lock'")).toBe(0);
  });
});
