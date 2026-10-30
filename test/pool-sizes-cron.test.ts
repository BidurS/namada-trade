// The cron tick's writes of what visitors read of Osmosis (worker/src/cron.ts 1c, 1d, 4b and 6c; worker/src/pool-sizes.ts),
// on the real runCron against the sqlite D1 stand-in. The depth reads are answered from the research's saved answers of
// 2026-10-29 (test/depth-minute-net.ts, as test/depth-cron.test.ts); the quote service's price list gives NAM a price
// here, and its router quotes every size of the size table; every other producer answers 404. One tick sizes every
// listed pool from its reserves (the pools the depth minute covers from that minute, at its height; the rest from the
// router's list at the tick's price), stores the list with its totals, and stores the size table it built one size at a
// time beside the rest of the tick.
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import { runCron } from '../worker/src/cron';
import { NAM, OSMOSIS } from '../worker/src/config';
import { CURVE_TIERS, CURVE_CALLS_MAX } from '../worker/src/sources/sqs';
import { CURVE_HEALTH_NAME, CURVE_KEY, POOLS_KEY, PRICED_KEY, SIZE_SOURCE, noCoinPrice, notPricedWords, poolsTotal, type StoredPools } from '../worker/src/pool-sizes';
import { testD1, insert, type TestD1 } from './d1-sqlite';
import { depthNetwork, bookKvFromFixture, paramsKvFromFixture, SQS_POOLS, REF_HEIGHT } from './depth-minute-net';
import type { QuoteCurveResponse } from '../shared/types';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

/** 02:56:05 UTC on 29 Oct 2026, not a holder-sync minute. */
const T = Date.UTC(2026, 9, 29, 2, 56, 5);
/** The NAM price the quote service's list gives here (pool 3005's spot that minute was 0.000903...; any figure does). */
const NAM_USD = 0.0009;
const DEPTH_HOSTS = [OSMOSIS.publicRpc, OSMOSIS.publicRest, OSMOSIS.sqs];

function network() {
  const n = depthNetwork();
  const quotes = { calls: 0, inFlight: 0, most: 0 };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const u = new URL(url);
    if (u.origin === OSMOSIS.sqs && u.pathname === '/tokens/prices') {
      const list = await (await n.fetch(url, init)).json() as Record<string, unknown>;
      return new Response(JSON.stringify({ ...list, [NAM.osmoDenom]: { [OSMOSIS.allUsdc]: String(NAM_USD) } }), { headers: { 'content-type': 'application/json' } });
    }
    if (u.origin === OSMOSIS.sqs && u.pathname === '/router/quote') {
      quotes.calls++; quotes.inFlight++; quotes.most = Math.max(quotes.most, quotes.inFlight);
      await new Promise((r) => setTimeout(r, 50));
      quotes.inFlight--;
      const m = /^(\d+)(.*)$/.exec(u.searchParams.get('tokenIn') ?? '')!;
      const sell = decodeURIComponent(m[2]) === NAM.osmoDenom;
      const nam = sell ? Number(m[1]) / 1e6 : Number(m[1]) / 1e6 / NAM_USD;
      const out = sell ? nam * NAM_USD * (1 - nam / 1e7) : nam * (1 - nam / 1e7);
      return new Response(JSON.stringify({ amount_out: String(Math.round(out * 1e6)), route: [{ pools: [{ id: 3005, type: 2 }] }], price_impact: String(-nam / 1e7), effective_fee: '0.002' }), { headers: { 'content-type': 'application/json' } });
    }
    if (DEPTH_HOSTS.some((h) => url.startsWith(h))) return n.fetch(url, init);
    return new Response('not here', { status: 404 });
  }));
  return quotes;
}

function seeded() {
  const db = testD1();
  const before = T - 60_000;
  insert(db, 'kv', [
    { key: 'depth.params', value: JSON.stringify(paramsKvFromFixture(before)), updated_at: before },
    { key: 'depth.book', value: JSON.stringify(bookKvFromFixture(before)), updated_at: before },
  ]);
  return db;
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
const kv = <T,>(db: TestD1, key: string): T => JSON.parse(db.raw.prepare('SELECT value FROM kv WHERE key = ?').get(key).value);
const metric = (db: TestD1, key: string) => db.raw.prepare('SELECT ts, value FROM metrics WHERE key = ?').get(key) as { ts: number; value: number } | undefined;

describe('the cron tick stores the Osmosis answers visitors read', () => {
  it('every listed pool sized from its reserves, the depth minute\'s pools at its reference height; the totals beside the list; the size table quoted one size at a time', async () => {
    const db = seeded();
    const quotes = network();
    await tick(db);

    const row = kv<StoredPools>(db, POOLS_KEY);
    const latest = kv<any>(db, 'depth.latest');
    expect(row.at).toBe(T);
    expect(row.depth).toMatchObject({ minute: latest.at, height: latest.ref.height, refPool: '3005', refUsd: latest.ref.usd });
    expect(row.price).toMatchObject({ usd: NAM_USD, source: 'Osmosis SQS' });
    // a pool the depth minute covers: its NAM at the reference pool's own spot plus its counter value, stamped with the
    // balances' time and the height of the spot the NAM is priced at
    const covered = row.pools.filter((p) => p.sizeProv?.source === SIZE_SOURCE.depth);
    expect(covered.length).toBe(latest.pools.length);
    for (const p of covered) {
      const d = latest.pools.find((x: any) => x.id === p.id);
      expect(p.liquidityUsd, p.id).toBeCloseTo(d.nam * latest.ref.usd + d.counterValueUsd, 9);
      expect(p.sizeProv, p.id).toMatchObject({ at: d.balancesAt, height: REF_HEIGHT, status: 'live' });
    }
    expect(latest.ref.height).toBe(REF_HEIGHT);
    // every other listed pool: the router's reserves at the tick's price, or not priced with the reason
    const rest = row.pools.filter((p) => p.sizeProv?.source === SIZE_SOURCE.list);
    expect(covered.length + rest.length).toBe(row.pools.length);
    for (const p of rest) expect(p.liquidityUsd == null ? p.sizeProv!.status : 'live', p.id).toBe(p.liquidityUsd == null ? 'missing' : 'live');
    expect(row.pools.every((p) => p.liquidityUsd !== 0 || (p.namReserve === 0 && p.counterReserve === 0))).toBe(true);
    // the totals are the stored list's own
    const t = poolsTotal(row.pools);
    expect(metric(db, 'dex.liquidity_usd')).toEqual({ ts: T, value: t.usd });
    expect(metric(db, PRICED_KEY)).toEqual({ ts: T, value: t.priced });
    expect(metric(db, 'dex.ref_pool_liquidity_usd')!.value).toBeCloseTo(row.pools.find((p) => p.id === '3005')!.liquidityUsd!, 9);
    expect(row.pools.length).toBeLessThanOrEqual(SQS_POOLS.length);

    // the size table: every size quoted on both sides, never more than two calls at once, within its bound
    const curve = kv<QuoteCurveResponse>(db, CURVE_KEY);
    expect(curve.curve.map((p) => p.amountNam)).toEqual([...CURVE_TIERS]);
    expect(curve.curve.every((p) => p.sellImpactPct != null && p.buyImpactPct != null)).toBe(true);
    expect(curve.prov).toEqual({ source: 'Osmosis SQS', at: T, status: 'live' });
    expect(curve).toMatchObject({ spotUsd: NAM_USD, poolsCount: row.pools.length, totalLiquidityUsd: t.usd });
    expect(quotes.most).toBeLessThanOrEqual(2);
    expect(quotes.calls).toBeGreaterThanOrEqual(2 * CURVE_TIERS.length);
    expect(quotes.calls).toBeLessThanOrEqual(CURVE_CALLS_MAX);
    // a coin the router's list gives in base units only takes the decimals the depth module read (kv depth.params
    // tokens): pool 3020's UM is 3,491.227565 coins, and the pool is not priced for want of a price, as the minute says
    const um = row.pools.find((p) => p.id === '3020')!;
    expect(um.counterReserve).toBeCloseTo(3_491.227565, 6);
    expect(um.sizeProv!.note).toBe(notPricedWords(noCoinPrice('the other coin')));
    expect(latest.unpriced.find((u: any) => u.id === '3020').why).toMatch(/gives this coin no price/);
    expect(row.pools.every((p) => !('counterBase' in p) && !p.sizeProv?.note?.includes('decimals'))).toBe(true);
    const health = kv<Record<string, any>>(db, 'source.health');
    expect(health[CURVE_HEALTH_NAME]).toMatchObject({ ok: true });
    expect(health['Osmosis SQS (pools)']).toMatchObject({ ok: true });
  });
});
