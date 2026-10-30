// Pool sizes from reserves, and the Osmosis answers visitors read from what the cron stored (scale plan Stage 1, items
// 1 and 5; worker/src/pool-sizes.ts). A pool's size was the router's liquidity_cap, which counted NAM at nothing while
// the router gave NAM no price: pool 3005 read $151 at 14:00 UTC on 29 Oct 2026 while it held 982,189.503942 NAM and
// 158.59 USDC (the pool completeness check of that day, at 20:18 UTC: the Osmosis app's $1,018 is that NAM at
// $0.000873861 plus the USDC, each coin rounded up to the dollar). It is now each side's coins at their own price, from
// the depth minute where it covers the pool and from the router's reserves elsewhere; a side that holds coins and has
// no price leaves the pool not priced, with the reason, never 0. The overview, the pool list, the pairs list and the
// size table read the cron's stored rows and ask the router nothing; the size table is built once a minute, one size at
// a time. No test reaches the network.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { app } from '../worker/src/api';
import { testD1, insert, type TestD1 } from './d1-sqlite';
import { OSMOSIS } from '../worker/src/config';
import {
  POOLS_KEY, CURVE_KEY, POOLS_STALE_MS, MINUTE_STALE_MS, SIZE_SOURCE, PRICED_KEY, CURVE_HEALTH_NAME,
  sizePools, poolsTotal, storedPoolsStmts, storedPoolsProv, storedTotalProv, storedCurve, storeCurve, storePools, curveWithPools, counterDecimals, notPricedWords, NO_NAM_PRICE, noCoinPrice, noCoinDecimals,
  NOT_READ, type StoredPools,
} from '../worker/src/pool-sizes';
import { fetchNamPools } from '../worker/src/sources/sqs';
import { readFileSync } from 'node:fs';
import { buildCurve, curveComplete, CURVE_TIERS, CURVE_CALLS_MAX } from '../worker/src/sources/sqs';
import { USDC_AS_ONE, type DepthResponse, type DepthPool } from '../shared/depth';
import type { Overview, PairsResponse, PoolInfo, QuoteCurveResponse } from '../shared/types';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

/** 20:18 UTC on 29 Oct 2026, the completeness check's reading. */
const T = Date.UTC(2026, 9, 29, 20, 18);
const MIN = 60_000;
const USDC = OSMOSIS.usdcDenom;
const OSMO = 'uosmo';

/** A pool as the router's list gives it (sources/sqs.ts fetchNamPools): whole coins, no size of its own, its liquidity_cap kept. */
const listed = (id: string, counterDenom: string, counterSymbol: string, nam: number, counter: number | null, cap: number | null): PoolInfo => ({
  id, type: 'concentrated', address: '', pair: `NAM / ${counterSymbol}`, counterDenom, counterSymbol, namReserve: nam, counterReserve: counter,
  liquidityUsd: null, routerLiquidityUsd: cap, spreadFactor: 0.002,
});

/** A depth minute (shared/depth.ts DepthResponse) holding the given pools, its reference pool 3005 at `refUsd`. */
function depthMinute(refUsd: number, pools: Partial<DepthPool>[]): DepthResponse {
  return {
    at: T - 18_000, generatedAt: T - 10_000,
    ref: { pool: '3005', usd: refUsd, height: 73_489_118, at: T - 15_000, source: 'Osmosis chain node (pool manager)', status: 'live' },
    pools: pools.map((p) => ({
      type: 'concentrated', pair: 'NAM / USDC', counterDenom: USDC, counterSymbol: 'USDC', counterDecimals: 6, counterUsd: 1, counterUsdHow: USDC_AS_ONE,
      spotUsd: refUsd, spread: 0.002, taker: 0.001, sides: 'both', balancesAt: T - 16_000, read: { url: 'https://osmosis-rpc.example/abci', at: T - 15_000, height: 73_489_118 }, ...p,
    })) as DepthPool[],
    unpriced: [],
  } as unknown as DepthResponse;
}

describe('a pool\'s size from its reserves', () => {
  it('a pool the depth minute covers: the minute\'s NAM at the reference pool\'s own spot plus its counter value, with the minute and height, never the router\'s $151', () => {
    const d = depthMinute(0.000873861, [{ id: '3005', nam: 982_189.503942, counter: 158.59, counterValueUsd: 158.59 }]);
    // the router's own list, read the same minute, gives other balances and a liquidity_cap that counts the NAM as nothing
    const [p] = sizePools({ pools: [listed('3005', USDC, 'USDC', 900_000, 150, 151)], poolsAt: T - 20_000, depth: d, price: { usd: 0.0009, at: T - 20_000, source: 'Osmosis SQS' } });
    expect(p.liquidityUsd).toBeCloseTo(982_189.503942 * 0.000873861 + 158.59, 9);
    expect(p.namUsd).toBeCloseTo(982_189.503942 * 0.000873861, 9);
    expect(p).toMatchObject({ namReserve: 982_189.503942, counterReserve: 158.59, counterUsd: 158.59, routerLiquidityUsd: 151 });
    expect(p.sizeProv).toMatchObject({ source: SIZE_SOURCE.depth, at: T - 16_000, height: 73_489_118, status: 'live' });
    expect(p.sizeProv!.note).toBe('From the depth minute of 20:17 UTC: 982,190 NAM at pool 3005\'s own price on the chain ($0.000874 at height 73,489,118) plus 158.59 USDC (Noble USDC counted as one US dollar); the balances as the router\'s pool list gave them at 20:17 UTC.');
  });

  it('a pool it does not cover: the router\'s reserves, NAM at the site\'s price and the other coin at a price the code already has', () => {
    const price = { usd: 0.0009, at: T - 20_000, source: 'Osmosis SQS' };
    // the depth minute priced OSMO in pool 3368; pool 3009's OSMO takes that price when this tick's quote has none
    const d = depthMinute(0.000873861, [{ id: '3368', counterDenom: OSMO, counterSymbol: 'OSMO', counterUsd: 0.0529, counterUsdHow: 'OSMO at the quote service’s price list, 0.0529 USD, 20:17 UTC', nam: 100_000, counter: 1_000, counterValueUsd: 52.9 }]);
    const pools = sizePools({
      pools: [listed('3020', USDC, 'USDC', 2_000, 10, 10), listed('3009', OSMO, 'OSMO', 10_000, 200, 10.58), listed('3008', USDC, 'USDC', 910_154.558525, 0, 0)],
      poolsAt: T - 20_000, depth: d, price, coinUsd: {}, coinAt: null,
    });
    const by = new Map(pools.map((p) => [p.id, p]));
    expect(by.get('3020')!.liquidityUsd).toBeCloseTo(2_000 * 0.0009 + 10, 12);
    expect(by.get('3020')!.sizeProv).toMatchObject({ source: SIZE_SOURCE.list, at: T - 20_000, status: 'live' });
    expect(by.get('3020')!.sizeProv!.note).toBe('2,000 NAM at the site\'s NAM price, $0.0009 at 20:17 UTC, plus 10 USDC (Noble USDC counted as one US dollar), from the Osmosis router\'s pool list read at 20:17 UTC.');
    expect(by.get('3009')!.liquidityUsd).toBeCloseTo(10_000 * 0.0009 + 200 * 0.0529, 12);
    expect(by.get('3009')!.sizeProv!.note).toContain('200 OSMO (OSMO at the quote service’s price list, 0.0529 USD, 20:17 UTC)');
    // pool 3008 held NAM and no USDC on 25 Oct: the router read $0, its NAM is worth its NAM
    expect(by.get('3008')!.liquidityUsd).toBeCloseTo(910_154.558525 * 0.0009, 9);
    expect(by.get('3008')!.counterUsd).toBe(0);
    // this tick's own quote of a coin comes before the depth minute's
    const [q] = sizePools({ pools: [listed('3009', OSMO, 'OSMO', 10_000, 200, 10.58)], poolsAt: T, depth: d, price, coinUsd: { OSMO: 0.05 }, coinAt: T - 20_000 });
    expect(q.liquidityUsd).toBeCloseTo(9 + 10, 12);
    expect(q.sizeProv!.note).toContain('200 OSMO (OSMO at the Osmosis quote, $0.05 at 20:17 UTC)');
  });

  it('a side that holds coins and has no price leaves the pool not priced, with the reason: never 0, never liquidity_cap', () => {
    const pools = sizePools({
      pools: [
        listed('3005', USDC, 'USDC', 650_386.95, 164.63, 165),
        listed('3402', 'ibc/0FA923…', 'ibc/0FA923…', 5_000, null, 3),
        listed('3016', 'factory/osmo1x/alloyed/allBTC', 'factory/osmo1x/alloyed/allBTC', 300, 0.1, 0.4),
        listed('3999', USDC, 'USDC', 0, 12, 12),
      ],
      poolsAt: T, depth: null, price: null, coinUsd: {},
    });
    const by = new Map(pools.map((p) => [p.id, p]));
    for (const id of ['3005', '3402', '3016']) {
      expect(by.get(id)!.liquidityUsd, id).toBeNull();
      expect(by.get(id)!.sizeProv!.status, id).toBe('missing');
    }
    expect(by.get('3005')!.sizeProv!.note).toBe(notPricedWords(NO_NAM_PRICE));
    expect(by.get('3005')!.counterUsd).toBe(164.63);
    expect(by.get('3402')!.sizeProv!.note).toBe(notPricedWords(`${NO_NAM_PRICE} and ${noCoinDecimals('the other coin')}`));
    expect(by.get('3016')!.sizeProv!.note).toBe(notPricedWords(`${NO_NAM_PRICE} and ${noCoinPrice('the other coin')}`));
    // a pool holding no NAM needs no NAM price: its USDC is its size
    expect(by.get('3999')).toMatchObject({ liquidityUsd: 12, namUsd: 0, counterUsd: 12 });
    // the router's figure is kept beside it, for comparison only
    expect(by.get('3005')!.routerLiquidityUsd).toBe(165);
    // priced first by size, then the pools not priced by the NAM inside
    expect(pools.map((p) => p.id)).toEqual(['3999', '3005', '3402', '3016']);
    // the pool with no NAM is the only one priced: its 12 USDC is not the money in pools holding 655,686.95 NAM
    const t = poolsTotal(pools);
    expect(t).toMatchObject({ usd: null, priced: 1, namLeftOut: 1 });
    expect(t.why).toBe('The money in the pools is not known: the pools that can be priced hold 0% of the NAM in the pools, under the 90% a total needs.');
    expect(t.notPriced.map((p) => p.id)).toEqual(['3005', '3402', '3016']);
    expect(poolsTotal(pools.slice(1))).toMatchObject({ usd: null, why: 'The money in the pools is not known: no pool can be priced.' });
  });

  it('a minute with no NAM price over the real pool list: no total is stored, and the overview says the figure is not known, never $0.000661', async () => {
    // the router's list of 29 Oct 2026 (test/fixtures/depth/sqs_pools_nam.json): 3008 and 3005 hold 1.56 million NAM;
    // 3010 holds 0.000661 USDC and 0.000747 NAM, here emptied of its NAM (a pool with no NAM needs no NAM price); no
    // depth minute, no NAM price
    const raw = JSON.parse(readFileSync(new URL('./fixtures/depth/sqs_pools_nam.json', import.meta.url), 'utf8').split('\n').filter((l) => !l.startsWith('//')).join('\n'));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(raw), { headers: { 'content-type': 'application/json' } })));
    const list = await fetchNamPools();
    vi.unstubAllGlobals();
    const emptied = list.pools.map((p) => (p.id === '3010' ? { ...p, namReserve: 0 } : p));
    const pools = sizePools({ pools: emptied, poolsAt: T, depth: null, price: null, coinUsd: {} });
    expect(pools.find((p) => p.id === '3010')).toMatchObject({ liquidityUsd: 0.000661, namReserve: 0 });
    const row: StoredPools = { at: T, pools, depth: null, price: null };
    const t = poolsTotal(pools);
    expect(t.usd).toBeNull();
    expect(t.priced).toBeGreaterThan(0);
    // no dex.liquidity_usd, no dex.pools_priced: the list alone
    expect(storedPoolsStmts(row, T).map((s) => s.params[0] === POOLS_KEY ? POOLS_KEY : s.params[1])).toEqual([POOLS_KEY]);
    // the overview's stamp of the total is missing, with the rule's words and the missing NAM price
    const p = storedTotalProv(row, T + MIN);
    expect(p.status).toBe('missing');
    expect(p.note).toMatch(/^The money in the pools is not known: the pools that can be priced hold 0% of the NAM in the pools, under the 90% a total needs\. The site has no NAM price this minute\. /);
    const db = testD1();
    insert(db, 'kv', [{ key: POOLS_KEY, value: JSON.stringify(row), updated_at: T }]);
    insert(db, 'metrics', [{ ts: T, key: 'price.usd', value: 0.0009 }, { ts: T, key: 'dex.pool_count', value: pools.length }]);
    const o = (await (await app.request('/api/overview', {}, { DB: db } as any)).json()) as Overview;
    expect(o.dex.liquidityUsd).toBeNull();
    expect(o.dex.prov.status).toBe('missing');
    expect(o.dex.pricedPools).toBe(t.priced);
  });

  it('a coin the router\'s list gives in base units only takes the decimals the depth module read (kv depth.params tokens), and its reason is then the price', () => {
    const um = 'ibc/0FA9232B262B89E77D1335D54FB1E1F506A92A7E4B51524B400DC69C68D28372';
    const p: PoolInfo = { ...listed('3020', um, 'ibc/0FA923…', 41_180, null, 45), counterBase: '9000000' };
    const price = { usd: 0.0009, at: T - 20_000, source: 'Osmosis SQS' };
    // no decimals known: not priced, as before
    const [a] = sizePools({ pools: [p], poolsAt: T, depth: null, price });
    expect(a.sizeProv!.note).toBe(notPricedWords(noCoinDecimals('the other coin')));
    expect(a.counterReserve).toBeNull();
    // the depth module's metadata names six decimals: 9 coins inside, not priced for want of a price (the reason it has)
    const [b] = sizePools({ pools: [p], poolsAt: T, depth: null, price, tokens: { [um]: { symbol: 'UM', decimals: 6 } } });
    expect(b.counterReserve).toBe(9);
    expect(b.sizeProv!.note).toBe(notPricedWords(noCoinPrice('the other coin')));
    // the base units are never stored
    expect('counterBase' in a || 'counterBase' in b).toBe(false);
    expect(counterDecimals(um, { [um]: { decimals: 6 } })).toBe(6);
    expect(counterDecimals(um, { [um]: { decimals: -1 } })).toBeNull();
  });

  it('the other coin\'s decimals are the code\'s own: Noble USDC 6, allETH 18, a coin it does not name none', () => {
    expect(counterDecimals(USDC)).toBe(6);
    expect(counterDecimals(OSMOSIS.allUsdc)).toBe(6);
    expect(counterDecimals(OSMO)).toBe(6);
    expect(counterDecimals(OSMOSIS.quotedCoins.ETH)).toBe(18);
    expect(counterDecimals('ibc/0FA9232B262B89E77D1335D54FB1E1F506A92A7E4B51524B400DC69C68D28372')).toBeNull();
  });
});

describe('the stored pool list', () => {
  const price = { usd: 0.0009, at: T - 20_000, source: 'Osmosis SQS' };
  const rowOf = (pools: PoolInfo[], at = T - 20_000): StoredPools => ({ at, pools: sizePools({ pools, poolsAt: at, depth: null, price: pools.length ? price : null }), depth: null, price });

  it('stores the list with its total, the priced count beside it, and the reference pool; no total when nothing is priced', () => {
    const row = rowOf([listed('3005', USDC, 'USDC', 1_000_000, 100, 101), listed('3402', 'ibc/0FA923…', 'ibc/0FA923…', 5_000, null, 3)]);
    const stmts = storedPoolsStmts(row, T);
    expect(stmts.map((s) => [s.params[0], s.params[1]])).toEqual([[POOLS_KEY, JSON.stringify(row)], [T, 'dex.liquidity_usd'], [T, PRICED_KEY], [T, 'dex.ref_pool_liquidity_usd']]);
    expect(stmts[1].params[2]).toBeCloseTo(1_000, 9);
    expect(stmts[2].params[2]).toBe(1);
    const none = storedPoolsStmts({ ...row, pools: row.pools.map((p) => ({ ...p, liquidityUsd: null })) }, T);
    expect(none.map((s) => s.params[1])).toEqual([JSON.stringify({ ...row, pools: row.pools.map((p) => ({ ...p, liquidityUsd: null })) })]);
  });

  it('is fresh for ten minutes, then old with its age; says where the NAM was priced and which pools are left out', () => {
    const row = rowOf([listed('3005', USDC, 'USDC', 1_000_000, 100, 101), listed('3402', 'ibc/0FA923…', 'ibc/0FA923…', 5_000, null, 3)]);
    expect(storedPoolsProv(row, T)).toEqual({ source: 'Osmosis pool reserves', at: T - 20_000, height: null, status: 'live', note: '2 pools from the router\'s pool list, NAM at the site\'s price of $0.0009 at 20:17 UTC. Not priced, so left out of the total: pool 3402. The pools not priced hold 0.5% of the NAM in the pools.' });
    expect(storedPoolsProv(row, T - 20_000 + POOLS_STALE_MS).status).toBe('live');
    const old = storedPoolsProv(row, T - 20_000 + POOLS_STALE_MS + MIN);
    expect(old.status).toBe('stale');
    expect(old.note).toMatch(/^The pool list was last read 11 min ago\. /);
    expect(storedPoolsProv(null, T)).toEqual({ source: 'Osmosis pool reserves', at: null, status: 'missing', note: 'The pool list has not been stored yet.' });
    expect(storedPoolsProv(null, T, true)).toEqual({ source: 'Osmosis pool reserves', at: null, status: 'missing', note: NOT_READ });
  });

  it('the write leaves the last list when the router\'s did not answer', async () => {
    const db = testD1();
    await storePools(db, { now: T, pools: [], poolsAt: T, depth: null, price: null });
    expect(db.raw.prepare('SELECT COUNT(*) n FROM kv').get().n).toBe(0);
    await storePools(db, { now: T, pools: rowOf([listed('3005', USDC, 'USDC', 1_000_000, 100, 101)]).pools, poolsAt: T - 20_000, depth: null, price });
    expect(JSON.parse(db.raw.prepare('SELECT value FROM kv WHERE key = ?').get(POOLS_KEY).value).pools[0].id).toBe('3005');
    expect(db.raw.prepare("SELECT value FROM metrics WHERE key = 'dex.liquidity_usd'").get().value).toBeCloseTo(1_000, 9);
  });
});

/** A size table point as the router would quote it: the sale's and the buy's move grow with the size. */
const point = (amountNam: number) => ({ amountNam, usdSize: amountNam * 0.0009, buyImpactPct: amountNam / 1e4, sellImpactPct: amountNam / 1e4, buyEffectiveUsd: 0.0009, sellEffectiveUsd: 0.0009, sellOutUsdc: amountNam * 0.0009, buyInUsdc: amountNam * 0.0009, buyOutNam: amountNam, buyExact: true });
const table = (at: number, sizes: readonly number[] = CURVE_TIERS): QuoteCurveResponse => ({
  spotUsd: 0.0009, poolsCount: 0, totalLiquidityUsd: null, refPoolLiquidityUsd: null, maxSafeClip1PctNam: null, maxSafeClip3PctNam: null, curve: sizes.map(point),
  prov: { source: 'Osmosis SQS', at, status: 'live' },
});

describe('the stored size table', () => {
  it('is served as stored, old past three minutes with its age, and missing with the reason before any is stored', () => {
    expect(storedCurve(table(T - MIN), T)).toEqual(table(T - MIN));
    const old = storedCurve(table(T - MINUTE_STALE_MS - MIN), T);
    expect(old.prov).toEqual({ source: 'Osmosis SQS', at: T - MINUTE_STALE_MS - MIN, status: 'stale', note: 'The size table was last built 4 min ago.' });
    expect(old.curve).toHaveLength(CURVE_TIERS.length);
    const none = storedCurve(null, T);
    expect(none.curve).toEqual([]);
    expect(none.prov).toMatchObject({ status: 'missing', at: null, note: 'The size table has not been built yet: the site builds it once a minute.' });
  });

  it('a whole table replaces the stored one; a part replaces only one older than three minutes; an empty one never', async () => {
    const db = testD1();
    const stored = () => db.raw.prepare('SELECT value, updated_at FROM kv WHERE key = ?').get(CURVE_KEY) as { value: string; updated_at: number } | undefined;
    const pools = sizePools({ pools: [listed('3005', USDC, 'USDC', 1_000_000, 100, 101)], poolsAt: T, depth: null, price: { usd: 0.0009, at: T, source: 'Osmosis SQS' } });
    expect(await storeCurve(db, { now: T, curve: table(T), complete: true, sizes: CURVE_TIERS, pools })).toEqual({ name: CURVE_HEALTH_NAME, ok: true, at: T });
    // the table's pool figures are the tick's sized pools, never the router's
    expect(JSON.parse(stored()!.value)).toEqual(curveWithPools(table(T), pools));
    expect(JSON.parse(stored()!.value).totalLiquidityUsd).toBeCloseTo(1_000, 9);
    // one size refused a minute later: the whole table of a minute ago stays
    const part = table(T + MIN, CURVE_TIERS.slice(0, 4));
    expect(await storeCurve(db, { now: T + MIN, curve: part, complete: false, sizes: CURVE_TIERS, pools })).toEqual({ name: CURVE_HEALTH_NAME, ok: false, at: T + MIN, note: '4 of 6 sizes quoted on both sides; the stored table, built under three minutes ago, was kept.' });
    expect(stored()!.updated_at).toBe(T);
    // once the stored one is older than three minutes, the part is the newest answer
    const later = T + MINUTE_STALE_MS + MIN;
    expect((await storeCurve(db, { now: later, curve: table(later, CURVE_TIERS.slice(0, 4)), complete: false, sizes: CURVE_TIERS, pools })).note).toBe('4 of 6 sizes quoted on both sides.');
    expect(stored()!.updated_at).toBe(later);
    // the part written says in its stamp which sizes it lacks
    expect(JSON.parse(stored()!.value).prov).toEqual({ source: 'Osmosis SQS', at: later, status: 'live', note: 'The 50,000 and 100,000 NAM sizes were not quoted on both sides when the table was built.' });
    expect(await storeCurve(db, { now: later + MIN, curve: null, complete: false, sizes: CURVE_TIERS, pools, why: 'the NAM price was not read' }))
      .toEqual({ name: CURVE_HEALTH_NAME, ok: false, at: later + MIN, note: 'Not built this tick: the NAM price was not read. The stored table stands, with its own time.' });
    expect(stored()!.updated_at).toBe(later);
    // a tick whose pool list did not answer while the quotes did: its pool figures are not known, never "0 pools"
    // (merged stage 1 review)
    const next = later + 5 * MIN;
    await storeCurve(db, { now: next, curve: table(next), complete: true, sizes: CURVE_TIERS, pools: [] });
    expect(JSON.parse(stored()!.value)).toMatchObject({ poolsCount: null, totalLiquidityUsd: null, refPoolLiquidityUsd: null });
    expect(storedCurve(null, next).poolsCount).toBeNull();
  });

  it('a table in which no size was quoted on both sides is never written, however old the stored one is', async () => {
    // the router refuses the cron's quotes (403) while its price list still answers: every size is listed with no quote
    const db = testD1();
    const stored = () => db.raw.prepare('SELECT value, updated_at FROM kv WHERE key = ?').get(CURVE_KEY) as { value: string; updated_at: number } | undefined;
    await storeCurve(db, { now: T, curve: table(T), complete: true, sizes: CURVE_TIERS, pools: [] });
    const refused: QuoteCurveResponse = { ...table(T + 10 * MIN), curve: CURVE_TIERS.map((n) => ({ ...point(n), buyImpactPct: null, sellImpactPct: null, buyEffectiveUsd: null, sellEffectiveUsd: null, sellOutUsdc: null, buyInUsdc: null, buyOutNam: null, buyExact: false })) };
    expect(await storeCurve(db, { now: T + 10 * MIN, curve: refused, complete: false, sizes: CURVE_TIERS, pools: [] }))
      .toEqual({ name: CURVE_HEALTH_NAME, ok: false, at: T + 10 * MIN, note: 'Not built this tick: no size was quoted on both sides. The stored table stands, with its own time.' });
    expect(stored()!.updated_at).toBe(T);
    // read ten minutes on, the stored table is old with its age, never fresh dashes
    expect(storedCurve(JSON.parse(stored()!.value), T + 10 * MIN).prov.status).toBe('stale');
  });
});

describe('the size table the cron builds', () => {
  /** The router quoting every size one percent per 100,000 NAM off the spot, with the most calls in flight at once. */
  function router(delayMs = 5) {
    const seen = { calls: 0, inFlight: 0, most: 0, urls: [] as string[] };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.urls.push(url);
      seen.calls++; seen.inFlight++; seen.most = Math.max(seen.most, seen.inFlight);
      // a call in flight when the phase ends is aborted, as a real fetch is
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('aborted', 'AbortError')); }, { once: true });
      }).finally(() => { seen.inFlight--; });
      const u = new URL(url);
      const m = /^(\d+)(.*)$/.exec(u.searchParams.get('tokenIn') ?? '')!;
      const inBase = Number(m[1]), sell = decodeURIComponent(m[2]) !== USDC;
      const nam = sell ? inBase / 1e6 : inBase / 1e6 / 0.0009;
      const out = sell ? nam * 0.0009 * (1 - nam / 1e7) : nam * (1 - nam / 1e7);
      return new Response(JSON.stringify({ amount_out: String(Math.round(out * 1e6)), route: [{ pools: [{ id: 3005, type: 2 }] }], price_impact: String(-nam / 1e7), effective_fee: '0.002' }), { headers: { 'content-type': 'application/json' } });
    }));
    return seen;
  }

  it('quotes every size sold and bought against the tick\'s own price, never more than two calls at once, within its call bound', async () => {
    const seen = router();
    const c = await buildCurve({ usd: 0.0009, at: T, how: { how: 'list' } });
    expect(c.curve.map((p) => p.amountNam)).toEqual([...CURVE_TIERS]);
    expect(curveComplete(c)).toBe(true);
    expect(c.prov).toEqual({ source: 'Osmosis SQS', at: T, status: 'live' });
    expect(seen.most).toBeLessThanOrEqual(2);
    expect(seen.calls).toBeLessThanOrEqual(CURVE_CALLS_MAX);
    expect(seen.urls.every((u) => u.startsWith(`${OSMOSIS.sqs}/router/quote?`))).toBe(true);
    // the pool figures are set when the cron stores it, from the sized pools
    expect(c).toMatchObject({ poolsCount: null, totalLiquidityUsd: null, refPoolLiquidityUsd: null });
  });

  it('a size not reached before the phase ends is not listed, never estimated; with no price nothing is asked', async () => {
    router(40);
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort('phase end'), 100);
    const c = await buildCurve({ usd: 0.0009, at: T, how: { how: 'list' } }, ctrl.signal);
    expect(c.curve.length).toBeLessThan(CURVE_TIERS.length);
    expect(curveComplete(c)).toBe(false);
    // a size whose quotes the phase's end cut is left out, never listed with a side it did not quote
    expect(c.curve.every((p) => p.sellImpactPct != null && p.buyImpactPct != null)).toBe(true);
    for (const ms of [30, 55, 70, 90, 130]) {
      router(25);
      const cut = new AbortController();
      setTimeout(() => cut.abort('phase end'), ms);
      const part = await buildCurve({ usd: 0.0009, at: T, how: { how: 'list' } }, cut.signal);
      expect(part.curve.every((p) => p.sellImpactPct != null && p.buyImpactPct != null), `cut at ${ms} ms`).toBe(true);
    }
    const seen = router();
    const none = await buildCurve({ usd: null, at: T, error: 'The Osmosis quote service is not answering.' });
    expect(seen.calls).toBe(0);
    expect(none.curve).toEqual([]);
    expect(none.prov).toEqual({ source: 'Osmosis SQS', at: null, status: 'missing', note: 'The Osmosis quote service is not answering.' });
  });
});

describe('what visitors read: the stored rows, never the router', () => {
  /** Every outside request is recorded and refused: none should be made. */
  function noNetwork() {
    const asked: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => { asked.push(String(input)); return new Response('no outside request', { status: 500 }); }));
    return asked;
  }
  function seeded(now: number) {
    const db = testD1();
    const price = { usd: 0.0009, at: now - 30_000, source: 'Osmosis SQS' };
    const d = depthMinute(0.00088, [{ id: '3005', nam: 1_000_000, counter: 120, counterValueUsd: 120 }]);
    const pools = sizePools({ pools: [listed('3005', USDC, 'USDC', 999_000, 119, 151), listed('3368', OSMO, 'OSMO', 50_000, 400, 20), listed('3402', 'ibc/0FA923…', 'ibc/0FA923…', 5_000, null, 3)], poolsAt: now - 30_000, depth: d, price, coinUsd: { OSMO: 0.05 }, coinAt: now - 30_000 });
    const row: StoredPools = { at: now - 30_000, pools, depth: { minute: d.at, at: d.ref.at, height: d.ref.height, refPool: '3005', refUsd: 0.00088 }, price };
    insert(db, 'kv', [
      { key: POOLS_KEY, value: JSON.stringify(row), updated_at: now - 30_000 },
      { key: CURVE_KEY, value: JSON.stringify(curveWithPools(table(now - 40_000), pools)), updated_at: now - 40_000 },
    ]);
    insert(db, 'metrics', [{ ts: now - 30_000, key: 'price.usd', value: 0.0009 }, { ts: now - 30_000, key: 'dex.pool_count', value: 3 }]);
    return { db, pools };
  }
  const get = async <T,>(db: TestD1, path: string) => (await (await app.request(path, {}, { DB: db } as any)).json()) as T;

  it('the overview: its pools from the stored list (each pool\'s coins at their own prices), its price the stored minute; nothing asked of the quote service', async () => {
    const now = Date.now();
    const { db, pools } = seeded(now);
    const asked = noNetwork();
    const o = await get<Overview>(db, '/api/overview');
    expect(asked.filter((u) => u.startsWith(OSMOSIS.sqs))).toEqual([]);
    expect(asked).toEqual([]);
    expect(o.dex.liquidityUsd).toBeCloseTo(1_000_000 * 0.00088 + 120 + 50_000 * 0.0009 + 400 * 0.05, 9);
    expect(o.dex.refPoolLiquidityUsd).toBeCloseTo(1_000_000 * 0.00088 + 120, 9);
    expect(o.dex.pools).toBe(3);
    expect(o.dex.prov).toEqual(storedPoolsProv({ at: now - 30_000, pools, depth: { minute: T - 18_000, at: T - 15_000, height: 73_489_118, refPool: '3005', refUsd: 0.00088 }, price: { usd: 0.0009, at: now - 30_000, source: 'Osmosis SQS' } }, o.generatedAt));
    expect(o.dex.prov.note).toContain('Not priced, so left out of the total: pool 3402.');
    expect(o.price.usd).toEqual({ value: 0.0009, prov: { source: 'Osmosis SQS (stored)', at: now - 30_000, status: 'live' } });
  });

  it('the pool list and the size table: the stored rows as written, the router never asked', async () => {
    const now = Date.now();
    const { db, pools } = seeded(now);
    const asked = noNetwork();
    const p = await get<{ pools: PoolInfo[]; prov: any }>(db, '/api/pools');
    expect(p.pools).toEqual(pools);
    expect(p.pools.find((x) => x.id === '3005')!.sizeProv!.source).toBe(SIZE_SOURCE.depth);
    expect(p.pools.find((x) => x.id === '3368')!.sizeProv!.source).toBe(SIZE_SOURCE.list);
    expect(p.pools.find((x) => x.id === '3402')!.liquidityUsd).toBeNull();
    expect(p.prov).toMatchObject({ source: 'Osmosis pool reserves', at: now - 30_000, height: 73_489_118, status: 'live' });
    const c = await get<QuoteCurveResponse>(db, '/api/quote/curve');
    expect(c.curve).toHaveLength(CURVE_TIERS.length);
    expect(c.poolsCount).toBe(3);
    expect(c.prov).toEqual({ source: 'Osmosis SQS', at: now - 40_000, status: 'live' });
    const pairs = await get<PairsResponse>(db, '/api/series/pairs');
    expect(pairs.pairs.map((x) => x.poolId)).toEqual(['3005', '3368', '3402']);
    expect(asked).toEqual([]);
  });

  it('nothing stored yet: each says so, and still asks no one', async () => {
    const db = testD1();
    const asked = noNetwork();
    const p = await get<{ pools: PoolInfo[]; prov: any }>(db, '/api/pools');
    expect(p).toEqual({ pools: [], prov: { source: 'Osmosis pool reserves', at: null, status: 'missing', note: 'The pool list has not been stored yet.' } });
    const c = await get<QuoteCurveResponse>(db, '/api/quote/curve');
    expect(c.curve).toEqual([]);
    expect(c.prov.status).toBe('missing');
    const o = await get<Overview>(db, '/api/overview');
    expect(o.dex.liquidityUsd).toBeNull();
    expect(o.dex.prov).toMatchObject({ status: 'missing', note: 'The pool list has not been stored yet.' });
    expect(o.price.usd.value).toBeNull();
    expect(asked).toEqual([]);
  });

  it('under Rewind the stored totals of the time; a total stored before the pools were sized says it was the router\'s own figure', async () => {
    const now = Date.now();
    const db = testD1();
    noNetwork();
    insert(db, 'metrics', [
      { ts: now - 3 * 3_600_000, key: 'dex.liquidity_usd', value: 151 }, // the router's liquidity_cap, before the change
      { ts: now - 3_600_000, key: 'dex.liquidity_usd', value: 1_016.9 }, { ts: now - 3_600_000, key: PRICED_KEY, value: 5 },
    ]);
    const before = await get<Overview>(db, `/api/overview?at=${now - 2 * 3_600_000}`);
    expect(before.dex.liquidityUsd).toBe(151);
    expect(before.dex.prov).toEqual({ source: 'Osmosis SQS pools (stored)', at: now - 3 * 3_600_000, status: 'live', note: 'Stored then as the Osmosis router\'s own figure, which counted NAM at nothing while it gave NAM no price.' });
    const after = await get<Overview>(db, `/api/overview?at=${now - 30 * MIN}`);
    expect(after.dex.liquidityUsd).toBe(1_016.9);
    expect(after.dex.prov).toEqual({ source: 'Osmosis pool reserves (stored)', at: now - 3_600_000, status: 'live', note: 'This total counts the 5 pools that could be priced then.' });
    expect(after.dex.pricedPools).toBeNull();
    expect(before.dex.pricedPools).toBeNull();
  });

  it('under Rewind the total says how many pools it left out, and the Trade page can count them', async () => {
    const now = Date.now();
    const db = testD1();
    noNetwork();
    insert(db, 'metrics', [
      { ts: now - 3_600_000, key: 'dex.liquidity_usd', value: 2_004 }, { ts: now - 3_600_000, key: PRICED_KEY, value: 15 }, { ts: now - 3_600_000, key: 'dex.pool_count', value: 26 },
    ]);
    const o = await get<Overview>(db, `/api/overview?at=${now - 30 * MIN}`);
    expect(o.dex).toMatchObject({ liquidityUsd: 2_004, pools: 26, pricedPools: 15 });
    expect(o.dex.prov).toEqual({ source: 'Osmosis pool reserves (stored)', at: now - 3_600_000, status: 'live', note: '11 of the 26 pools could not be priced and are left out of this total.' });
    // live, before a list is stored: the last stored total says the same
    const live = await get<Overview>(db, '/api/overview');
    expect(live.dex.pricedPools).toBe(15);
    expect(live.dex.prov.note).toBe('The pool list has not been stored yet, so this is the last stored total. 11 of the 26 pools could not be priced and are left out of this total.');
  });

  it('a stored list that cannot be read is said so, not as one never stored', async () => {
    const db = testD1();
    noNetwork();
    insert(db, 'kv', [{ key: POOLS_KEY, value: '{"at": "x"', updated_at: Date.now() }]);
    const p = await get<{ pools: PoolInfo[]; prov: any }>(db, '/api/pools');
    expect(p).toEqual({ pools: [], prov: { source: 'Osmosis pool reserves', at: null, status: 'missing', note: NOT_READ } });
    const o = await get<Overview>(db, '/api/overview');
    expect(o.dex.prov.note).toBe(NOT_READ);
    const pairs = await get<PairsResponse>(db, '/api/series/pairs');
    expect(pairs.prov.note).toBe('The stored pool list could not be read, and no pool reading is stored.');
  });
});
