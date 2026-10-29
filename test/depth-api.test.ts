// The depth API (worker/src/api-depth.ts, depth plan section 2, step S4) on the sqlite stand-in: the newest minute as
// the real minute job stored it on the research's saved answers of 2026-10-29 (test/depth-minute-net.ts; nothing reaches
// the network), stale after three minutes; the quote walked on the stored minute for any size against the minute's own
// answers and the chain's figure for pool 3005; the history by primary-key range with gaps listed and the 43,200 cap; the
// heat at the three windows; the owners with the labels table's words joined in one statement; the changes paged by
// keyset with ties on one millisecond never cut, one pool's on its own index; the parameter allow-list against the edge
// cache key; the cache headers through cachedApi; and EXPLAIN QUERY PLAN of every statement (SEARCH on the primary key
// or one of the two change indexes, no SCAN of a table), as test/series-api.test.ts asserts for the series routes.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from '../worker/src/api';
import { testD1, insert, type TestD1 } from './d1-sqlite';
import * as A from '../worker/src/api-depth';
import { DEPTH_PARAMS } from '../worker/src/api-depth';
import { CACHE_PARAMS, CACHEABLE_API, cachedApi, cacheKeyUrl, edgeCacheOf, isReplay, quoteNamKey } from '../worker/src/http';
import { minute, hourly, type DepthStates, type DepthOwnersKv } from '../worker/src/depth/index';
import { NAM_DEPTH } from '../worker/src/depth/config';
import { aggregate, packF32, unpackF32 } from '../worker/src/depth/model';
import { changeStmt } from '../worker/src/depth/sql';
import { depthNetwork, bookKvFromFixture, paramsKvFromFixture, SQS_POOLS, REF_HEIGHT } from './depth-minute-net';
import { category_plain } from '../shared/labels';
import { fmtAddr, fmtUtcClock, fmtUtcLong } from '../shared/format';
import { BANNED } from './banned-words';
import { NOT_SERVED, type NotServedBody } from '../shared/types';
import {
  DEPTH_NOT_STORED, DEPTH_STALE_WORDS, OWNERS_NOT_STORED, minuteRowsKept, GAP_MINUTE, GAP_HOUR, HEAT_HOW, HEAT_BANDS, HEAT_EDGES, QUOTE_HOW_STATES, QUOTE_HOW_CURVE, quoteIncomplete, historyCut, HISTORY_ROWS_MAX, CHANGES_LIMIT_MAX, roundQuoteNam,
  type DepthResponse, type DepthQuoteResponse, type DepthHistoryResponse, type DepthHeatResponse, type DepthOwnersApiResponse, type DepthChangesResponse, type DepthChangeRow,
} from '../shared/depth';

const cfg = NAM_DEPTH;
const MIN = 60_000, H = 3_600_000, D = 86_400_000;
/** The minute the fixtures were read: 02:56:30 UTC on 29 Oct 2026 (test/depth-minute.test.ts T); the hour's first tick at 03:05. */
const T1 = Date.UTC(2026, 9, 29, 2, 56, 30);
const MINUTE = Math.floor(T1 / MIN) * MIN;
const TH = Date.UTC(2026, 9, 29, 3, 5, 0);
/** A whole minute of the same day, for the seeded tables. */
const NOW = Date.UTC(2026, 9, 29, 12, 0);

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const at = (t: number) => vi.useFakeTimers({ now: t, toFake: ['Date'] });
const all = (db: TestD1, sql: string, ...p: unknown[]) => db.raw.prepare(sql).all(...p).map((r: any) => ({ ...r }));
const kv = <T = any>(db: TestD1, key: string): T | null => { const r = all(db, 'SELECT value FROM kv WHERE key = ?', key)[0]; return r ? JSON.parse(r.value) : null; };

async function call<T = any>(db: TestD1 | any, path: string): Promise<{ status: number; body: T; cache: string | null; queries: number }> {
  if (typeof db.queries === 'number') db.queries = 0;
  const res = await app.request(path, {}, { DB: db } as any);
  return { status: res.status, body: (await res.json()) as T, cache: res.headers.get('cache-control'), queries: db.queries };
}
const pct = (a: number, b: number) => Math.abs(a / b - 1) * 100;

/** The real minute job on the fixtures, as test/depth-minute.test.ts runs it: kv depth.latest and depth.states as the Worker stores them. */
async function storedMinute(db: TestD1 = testD1(), now = T1) {
  if (!kv(db, 'depth.params')) insert(db, 'kv', [{ key: 'depth.params', value: JSON.stringify(paramsKvFromFixture(now - MIN)), updated_at: now - MIN }]);
  if (!kv(db, 'depth.book')) insert(db, 'kv', [{ key: 'depth.book', value: JSON.stringify(bookKvFromFixture(now - MIN)), updated_at: now - MIN }]);
  const n = depthNetwork({});
  let clock = now;
  const res = await minute({ DB: db } as any, now, { health: [], fetch: n.fetch, clock: () => (clock += 100), pools: SQS_POOLS, poolsAt: now - 1500 });
  expect(res.written).toBe(true);
  return db;
}
/** Two minutes and the hour after them (test/depth-hourly.test.ts): kv depth.owners as the hourly job stores it. */
async function storedHour(db: TestD1 = testD1()) {
  await storedMinute(db, T1);
  await storedMinute(db, T1 + MIN);
  const n = depthNetwork({});
  let clock = TH;
  const res = await hourly({ DB: db } as any, TH, { health: [], fetch: n.fetch, clock: () => (clock += 100) });
  expect(res.written).toBe(true);
  return db;
}

/** Minute rows of one pool in [from, to), one a minute, skipping the minutes in `skip`; the figures are the minute's index, so a row can be told from its neighbour. */
function seedMinutes(db: TestD1, pool: string, from: number, to: number, skip: (m: number) => boolean = () => false, heat = false) {
  db.raw.exec('BEGIN');
  const st = db.raw.prepare('INSERT OR REPLACE INTO depth_minute (minute, pool_id, at, height, ref_usd, spot_usd, bid_10, sell_10k, best_bid, bid_usd, heat_bid, heat_ask, note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  let n = 0;
  for (let m = from; m < to; m += MIN) {
    if (skip(m)) continue;
    const i = (m - from) / MIN;
    const bands = heat ? packF32(Float32Array.from({ length: HEAT_BANDS }, (_, k) => (k === 10 ? i : k))) : null;
    st.run(m, pool, m + 2_000, 73_000_000 + i, 0.001 + 1e-9 * i, pool === 'all' ? null : 0.001, 26 + i, 9.9, 0.00101, 500 + i, bands, bands, i % 7 === 0 ? 'balances from the pool list' : null);
    n++;
  }
  db.raw.exec('COMMIT');
  return n;
}
function seedHours(db: TestD1, pool: string, from: number, to: number, skip: (h: number) => boolean = () => false, heat = false) {
  db.raw.exec('BEGIN');
  const st = db.raw.prepare('INSERT OR REPLACE INTO depth_hourly (hour, pool_id, at, height, ref_usd, bid_10, sell_10k, heat_bid, heat_ask, sell_10k_lo, sell_10k_hi, n) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  let n = 0;
  for (let h = from; h < to; h += H) {
    if (skip(h)) continue;
    const i = (h - from) / H;
    const bands = heat ? packF32(Float32Array.from({ length: HEAT_BANDS }, (_, k) => (k === 20 ? 1000 + i : 1))) : null;
    st.run(h, pool, h + 59 * MIN + 2_000, 73_100_000 + i, 0.001, 30 + i, 9.8, bands, bands, 9.7, 9.9, 60);
    n++;
  }
  db.raw.exec('COMMIT');
  return n;
}

// ================================================================ GET /api/depth
describe('GET /api/depth: the newest stored minute', () => {
  it('serves kv depth.latest as the minute wrote it, from one row read: the 15 priced pools, the answers, the curve, every read in prov', async () => {
    const db = await storedMinute();
    at(T1 + MIN);
    const { status, body, queries } = await call<DepthResponse>(db, '/api/depth');
    expect(status).toBe(200);
    expect(queries).toBe(1);
    const stored = kv<DepthResponse>(db, 'depth.latest')!;
    expect(body.at).toBe(MINUTE);
    expect(body.ref).toEqual({ ...stored.ref, status: 'live' });
    expect(body.ref.height).toBe(REF_HEIGHT);
    expect(body.pools).toHaveLength(15);
    expect(body.answer).toEqual(stored.answer);
    expect(body.curve).toEqual(stored.curve);
    expect(body.prov).toHaveLength(6);
    expect(body.prov.every((p) => p.url && p.at && p.status === 200)).toBe(true);
    expect(body.note).toBe(stored.note);
  });

  it('is live up to three minutes after its minute and stale past that, said in the note with the clock it was written at', async () => {
    const db = await storedMinute();
    at(MINUTE + 3 * MIN);
    expect((await call<DepthResponse>(db, '/api/depth')).body.ref.status).toBe('live');
    vi.setSystemTime(MINUTE + 3 * MIN + 1);
    const { body } = await call<DepthResponse>(db, '/api/depth');
    expect(body.ref.status).toBe('stale');
    expect(body.note).toContain(DEPTH_STALE_WORDS);
    expect(body.note).toContain(`(written ${fmtUtcClock(MINUTE)})`);
    expect(fmtUtcClock(MINUTE)).toMatch(/^02:56\sUTC$/);
    expect(DEPTH_STALE_WORDS).toBe('the newest stored minute is older than three minutes');
  });

  it('with no stored minute: a 404 in the NotServedBody shape, never cached; a parameter is refused', async () => {
    const r = await call<NotServedBody>(testD1(), '/api/depth');
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: NOT_SERVED, reason: DEPTH_NOT_STORED, endpoint: '/api/depth' });
    expect(r.cache).toBe('no-store');
    const p = await call<NotServedBody>(testD1(), '/api/depth?at=1');
    expect(p.status).toBe(400);
    expect(p.body.error).toBe('at is not a parameter of this route; it takes none.');
    expect(p.cache).toBe('no-store');
  });
});

// ================================================================ GET /api/depth/quote
describe('GET /api/depth/quote: any size walked on the stored minute', () => {
  it('the four stored sizes each way come back as the minute answered them (within a hundredth of a percent), the split by pool exact, from one statement', async () => {
    const db = await storedMinute();
    at(T1 + MIN);
    const stored = kv<DepthResponse>(db, 'depth.latest')!;
    for (const side of ['sell', 'buy'] as const) {
      for (const [i, size] of stored.answer.sizes.entries()) {
        const { status, body, queries } = await call<DepthQuoteResponse>(db, `/api/depth/quote?side=${side}&nam=${size}`);
        expect(status).toBe(200);
        expect(queries).toBe(1);
        const want = stored.answer[side][i];
        expect(pct(body.usd, want.usd), `${side} ${size}`).toBeLessThan(0.01);
        expect(body.complete).toBe(true);
        expect(body.nam).toBe(size);
        expect(body.split.reduce((a, s) => a + s.nam, 0)).toBeCloseTo(size, 0);
        expect(body.split.reduce((a, s) => a + s.usd, 0) / body.usd).toBeCloseTo(1, 4);
        expect(body.split[0].pool).toBe(want.split[0].pool);
        expect(body.how).toBe(QUOTE_HOW_STATES);
        expect(body.at).toBe(MINUTE);
        expect(body.height).toBe(REF_HEIGHT);
        expect(body.prov).toEqual(stored.prov);
        expect(body.ref.status).toBe('live');
      }
    }
  });

  it('worked out independently: 1,000 NAM into pool 3005 alone fetches 1.014160 USDC (the chain’s own estimate, test/fixtures/depth/verify-router.json) within a hundredth of a percent; 10,000 NAM across every pool 9.924536 USDC (the research prototype’s figure) within five hundredths; the whole sale fetches at least the one pool’s, under the reference; a buy costs at least the touch', async () => {
    const db = await storedMinute();
    at(T1 + MIN);
    const latest = kv<DepthResponse>(db, 'depth.latest')!, states = kv<DepthStates>(db, 'depth.states')!;
    // the route's own walk, held to the one pool the chain's estimate covers: the models rebuilt from the stored states, pool 3005 kept alone
    const { pools } = A.quoteAggregate(cfg, latest, states);
    const only = pools.filter((p) => p.id === '3005');
    expect(only).toHaveLength(1);
    const alone = A.walkQuote(cfg, aggregate(only, A.curveGridOf(latest), cfg.base.decimals), only, 'sell', 1000);
    expect(alone.complete).toBe(true);
    expect(pct(alone.usd, 1.014160)).toBeLessThan(0.01);
    expect(alone.split).toEqual([expect.objectContaining({ pool: '3005' })]);
    const sell = (await call<DepthQuoteResponse>(db, '/api/depth/quote?side=sell&nam=1000')).body;
    expect(sell.usd).toBeGreaterThanOrEqual(1.01416);
    expect(sell.usd).toBeLessThan(1000 * sell.ref.usd);
    expect(sell.avgPrice!).toBeLessThan(sell.ref.usd);
    expect(sell.avgPrice!).toBeLessThanOrEqual(latest.touch.bestBidEff! * (1 + 1e-6));
    expect(sell.vsRef!).toBeLessThan(0);
    expect(sell.vsRef!).toBeCloseTo((sell.avgPrice! / sell.ref.usd - 1) * 100, 3);
    expect(sell.split[0].pool).toBe('3005');
    // the first 1,000 NAM bought come under the reference on these fixtures: the order book's asks rest below pool 3005's spot
    const buy = (await call<DepthQuoteResponse>(db, '/api/depth/quote?side=buy&nam=1000')).body;
    expect(buy.avgPrice!).toBeGreaterThanOrEqual(latest.touch.bestAskEff! * (1 - 1e-6));
    expect(buy.marginalPrice).toBeGreaterThanOrEqual(buy.avgPrice!);
    expect(buy.vsRef!).toBeCloseTo((buy.avgPrice! / buy.ref.usd - 1) * 100, 3);
    // the touch (the minute's own figure for the first 100 NAM each way: the marginal price linear across a quarter-percent
    // step of the full grid) is what a quote of 100 NAM reaches, within a tenth of a percent (the quote's step is finer)
    const touchSell = (await call<DepthQuoteResponse>(db, `/api/depth/quote?side=sell&nam=${latest.touch.sizeNam}`)).body;
    const touchBuy = (await call<DepthQuoteResponse>(db, `/api/depth/quote?side=buy&nam=${latest.touch.sizeNam}`)).body;
    expect(pct(touchSell.marginalPrice, latest.touch.bestBidEff!)).toBeLessThan(0.1);
    expect(pct(touchBuy.marginalPrice, latest.touch.bestAskEff!)).toBeLessThan(0.1);
    expect(touchSell.split[0].pool).toBe(latest.touch.bestBidPool);
    expect(touchBuy.split[0].pool).toBe(latest.touch.bestAskPool);
    // more sold fetches more in all but less per coin; the prototype's own figure for 10,000 NAM over its fifteen pool curves (S1's tolerance)
    const ten = (await call<DepthQuoteResponse>(db, '/api/depth/quote?side=sell&nam=10000')).body;
    expect(pct(ten.usd, 9.924536)).toBeLessThan(0.05);
    expect(ten.usd).toBeGreaterThan(sell.usd);
    expect(ten.avgPrice!).toBeLessThan(sell.avgPrice!);
    expect(ten.marginalPrice).toBeLessThan(ten.avgPrice!);
  });

  it('the size is rounded to three significant digits (one edge copy per rounded size); the answer carries the size answered and no "size asked", which the edge key never passes on', async () => {
    const db = await storedMinute();
    at(T1 + MIN);
    const { body } = await call<DepthQuoteResponse>(db, '/api/depth/quote?side=sell&nam=12345');
    expect(body.nam).toBe(12300);
    expect(body).not.toHaveProperty('asked');
    expect(body.filledNam).toBe(12300);
    expect(roundQuoteNam(12345)).toBe(12300);
    expect(roundQuoteNam(1)).toBe(1);
    expect(roundQuoteNam(9_999_999)).toBe(10_000_000);
    expect(quoteNamKey('12345')).toBe('12300');
    expect(quoteNamKey('1e3')).toBe('1000');
    expect(quoteNamKey('0')).toBe('0'); // refused by the route, never stored: kept as written
    expect(quoteNamKey('abc')).toBe('abc');
    expect(cacheKeyUrl(new URL('https://namada.trade/api/depth/quote?nam=12345&side=sell&r=1'))).toBe('https://namada.trade/api/depth/quote?nam=12300&side=sell');
  });

  it('a size past the asks answers complete false with what can be filled and the words; the bids hold ten million NAM on these fixtures', async () => {
    const db = await storedMinute();
    at(T1 + MIN);
    const buy = (await call<DepthQuoteResponse>(db, '/api/depth/quote?side=buy&nam=10000000')).body;
    expect(buy.complete).toBe(false);
    expect(buy.filledNam).toBeCloseTo(kv<DepthResponse>(db, 'depth.latest')!.within.totalAskNam, -1);
    expect(buy.note).toBe(quoteIncomplete('buy', '1,726,372', 'NAM'));
    expect(buy.note).toBe('only 1,726,372 NAM can be bought before the last ask is used');
    const sell = (await call<DepthQuoteResponse>(db, '/api/depth/quote?side=sell&nam=10000000')).body;
    expect(sell.complete).toBe(true);
    expect(sell.note).toBeUndefined();
    expect(quoteIncomplete('sell', '12', 'NAM')).toBe('only 12 NAM can be sold before the last bid is used');
  });

  it('without the stored states the stored aggregate curve alone is walked: the figure within a tenth of a percent, the split empty and said', async () => {
    const db = await storedMinute();
    at(T1 + MIN);
    const exact = (await call<DepthQuoteResponse>(db, '/api/depth/quote?side=sell&nam=10000')).body;
    db.raw.prepare("DELETE FROM kv WHERE key = 'depth.states'").run();
    const { body } = await call<DepthQuoteResponse>(db, '/api/depth/quote?side=sell&nam=10000');
    expect(body.how).toBe(QUOTE_HOW_CURVE);
    expect(body.split).toEqual([]);
    expect(pct(body.usd, exact.usd)).toBeLessThan(0.1);
    // the states of another minute are not this minute's: the curve alone again
    const db2 = await storedMinute();
    const st = kv<DepthStates>(db2, 'depth.states')!;
    db2.raw.prepare("UPDATE kv SET value = ? WHERE key = 'depth.states'").run(JSON.stringify({ ...st, minute: st.minute - MIN }));
    expect((await call<DepthQuoteResponse>(db2, '/api/depth/quote?side=sell&nam=10000')).body.how).toBe(QUOTE_HOW_CURVE);
  });

  it('the models rebuilt from the states reproduce the stored curve at every one of its points; the grid is rebuilt from the reference at full precision and held to the stored prices', async () => {
    const db = await storedMinute();
    const latest = kv<DepthResponse>(db, 'depth.latest')!, states = kv<DepthStates>(db, 'depth.states')!;
    const grid = A.curveGridOf(latest);
    expect(grid).not.toBe(latest.curve.price);
    expect(grid).toHaveLength(latest.curve.price.length);
    expect(grid.map((g) => +g.toPrecision(6))).toEqual(latest.curve.price);
    expect(grid).toContain(latest.ref.usd);
    expect(A.curveGridOf({ ...latest, ref: { ...latest.ref, usd: latest.ref.usd * 1.001 } })).toBe(latest.curve.price); // another reference: the stored prices themselves
    const { agg, pools, how } = A.quoteAggregate(cfg, latest, states);
    expect(how).toBe(QUOTE_HOW_STATES);
    expect(pools).toHaveLength(15);
    expect(agg.grid).toEqual(grid);
    for (let i = 0; i < grid.length; i++) {
      // the stored curve is rounded to six significant digits; the ask side is empty below the lowest ask
      const close = (a: number, b: number) => (a === 0 && b === 0 ? 0 : pct(a, b));
      expect(close(agg.bidUsd[i], latest.curve.bidUsd[i])).toBeLessThan(1e-3);
      expect(close(agg.askNam[i], latest.curve.askNam[i])).toBeLessThan(1e-3);
    }
  });

  it('refuses what it cannot answer as asked, in plain words, never cached: the side, a size outside 1 to 10,000,000, a parameter it does not take, no stored minute', async () => {
    const db = await storedMinute();
    at(T1 + MIN);
    for (const [q, words] of [
      ['side=hold&nam=10', 'side must be sell or buy.'], ['nam=10', 'side must be sell or buy.'],
      ['side=sell&nam=0', 'nam must be a number of NAM from 1 to 10,000,000.'], ['side=sell&nam=10000001', 'nam must be a number of NAM from 1 to 10,000,000.'],
      ['side=sell&nam=abc', 'nam must be a number of NAM from 1 to 10,000,000.'], ['side=sell', 'nam must be a number of NAM from 1 to 10,000,000.'],
      ['side=sell&nam=10&at=5', 'at is not a parameter of this route; it takes side, nam.'],
    ] as const) {
      const r = await call<NotServedBody>(db, `/api/depth/quote?${q}`);
      expect(r.status, q).toBe(400);
      expect(r.body).toEqual({ error: words, reason: words, endpoint: '/api/depth/quote' });
      expect(r.cache).toBe('no-store');
    }
    const none = await call<NotServedBody>(testD1(), '/api/depth/quote?side=sell&nam=10');
    expect(none.status).toBe(404);
    expect(none.body.reason).toBe(DEPTH_NOT_STORED);
  });
});

// ================================================================ GET /api/depth/history
describe('GET /api/depth/history: the stored rows by primary-key range', () => {
  const OUTAGE = [NOW - 10 * H, NOW - 10 * H + 20 * MIN] as const;
  it('the default: the aggregate’s last day at one-minute steps, one point per stored minute, a 20-minute outage one gap, the minute rows’ rule said, two primary-key statements', async () => {
    at(NOW);
    const db = testD1();
    const n = seedMinutes(db, 'all', NOW - 2 * D, NOW, (m) => m >= OUTAGE[0] && m < OUTAGE[1]);
    expect(n).toBe(2 * 1440 - 20);
    const { status, body, queries } = await call<DepthHistoryResponse>(db, '/api/depth/history');
    expect(status).toBe(200);
    expect(queries).toBe(2);
    expect(body).toMatchObject({ pool: 'all', step: '1m', from: NOW - D, to: NOW, asOf: NOW, start: NOW - 2 * D, cut: false });
    // the reference pool the rows' price is read from is the configuration's, named so a rewound page can say "Pool 3005 price"
    expect(body.refPool).toBe(cfg.refPoolId);
    expect(body.refPool).toBe('3005');
    expect(body.points).toHaveLength(1440 - 20);
    expect(body.points[0].t).toBe(NOW - D);
    expect(body.points[body.points.length - 1].t).toBe(NOW - MIN);
    expect(body.gaps).toEqual([{ from: OUTAGE[0], to: OUTAGE[1], why: GAP_MINUTE }]);
    // the retention in the words is the configuration's, not a typed figure
    expect(body.note).toContain(minuteRowsKept(30));
    expect(cfg.caps.retentionMs).toBe(30 * D);
    expect(minuteRowsKept(30)).toBe('minute rows are kept 30 days; before that, ask for hours');
    expect(minuteRowsKept(7)).toBe('minute rows are kept 7 days; before that, ask for hours');
    // each point carries the row's own figures, finite or null, and its note
    const p = body.points.find((x) => x.t === NOW - D + 2 * MIN)!;
    const i = (NOW - D + 2 * MIN - (NOW - 2 * D)) / MIN;
    expect(i % 7).toBe(0);
    expect(p).toMatchObject({ at: p.t + 2_000, height: 73_000_000 + i, refUsd: 0.001 + 1e-9 * i, spotUsd: null, bidUsd: 500 + i, note: 'balances from the pool list' });
    expect(p.bid).toEqual([null, null, null, 26 + i, null, null]);
    expect(p.sell).toEqual([null, 9.9, null, null]);
    expect(p.ask).toHaveLength(6);
    expect(p.buy).toHaveLength(4);
    expect(body.prov).toHaveLength(1);
    // a stored read's provenance: no URL (nothing outside was asked), the table and the key range, the newest row's own time and height; no banned word anywhere in it
    expect(body.prov[0]).toEqual({ what: 'depth_minute rows of pool all: 1420 of 1440 steps', url: null, table: 'depth_minute', key: { pool_id: 'all', from: NOW - D, to: NOW, limit: 43200 }, at: NOW - MIN + 2_000, height: 73_000_000 + 2 * 1440 - 1, bytes: expect.any(Number), status: 'stored' });
    expect(JSON.stringify(body.prov)).not.toMatch(BANNED);
    expect(body.note).not.toMatch(BANNED);
  });

  it('a minute with no row is a gap, never a point between its neighbours; the last two minutes are not yet due', async () => {
    at(NOW);
    const db = testD1();
    const hole = NOW - 30 * MIN;
    seedMinutes(db, '3005', NOW - H, NOW - MIN, (m) => m === hole); // the newest minute not written yet
    const { body } = await call<DepthHistoryResponse>(db, `/api/depth/history?pool=3005&from=${NOW - H}`);
    expect(body.points.map((p) => p.t)).not.toContain(hole);
    expect(body.points.some((p) => p.t > hole - MIN && p.t < hole + MIN)).toBe(false);
    expect(body.gaps).toEqual([{ from: hole, to: hole + MIN, why: GAP_MINUTE }]);
    expect(body.start).toBe(NOW - H);
    expect(body.recordedSince).toBe(NOW - H);
  });

  it('recordedSince is the earlier of the first minute row and the first hourly row at either step: after the minute rows’ retention the one-minute window still names the first recording, while its own start is the retention’s edge', async () => {
    at(NOW);
    const db = testD1();
    // the hourly rows begin forty days back (kept forever); the minute rows only thirty (the retention delete took the rest)
    seedHours(db, 'all', NOW - 40 * D, NOW - H);
    seedMinutes(db, 'all', NOW - 30 * D, NOW);
    const minutes = (await call<DepthHistoryResponse>(db, '/api/depth/history')).body;
    expect(minutes.start).toBe(NOW - 30 * D);
    expect(minutes.recordedSince).toBe(NOW - 40 * D);
    expect(minutes.gaps).toEqual([]);
    const hours = (await call<DepthHistoryResponse>(db, `/api/depth/history?step=1h&from=${NOW - 2 * D}`)).body;
    expect(hours.start).toBe(NOW - 40 * D);
    expect(hours.recordedSince).toBe(NOW - 40 * D);
    // the minute rows alone (the first hour has not closed yet): the one start there is
    const young = testD1();
    seedMinutes(young, 'all', NOW - 30 * MIN, NOW);
    expect((await call<DepthHistoryResponse>(young, '/api/depth/history')).body.recordedSince).toBe(NOW - 30 * MIN);
    expect((await call<DepthHistoryResponse>(young, '/api/depth/history?step=1h')).body).toMatchObject({ start: null, recordedSince: NOW - 30 * MIN, points: [] });
  });

  it('hours read the hourly rows; a missing hour is a gap once its writer is due; a window before the start says when it starts', async () => {
    at(NOW);
    const db = testD1();
    const miss = NOW - 20 * H;
    seedHours(db, 'all', NOW - 3 * D, NOW - H, (h) => h === miss);
    const { body, queries } = await call<DepthHistoryResponse>(db, `/api/depth/history?step=1h&from=${NOW - 2 * D}`);
    expect(queries).toBe(2);
    expect(body.step).toBe('1h');
    expect(body.points).toHaveLength(48 - 1 - 1); // the missing hour and the current one (not written until its close)
    expect(body.gaps).toEqual([{ from: miss, to: miss + H, why: GAP_HOUR }]);
    expect(body.note).toBeNull();
    expect(body.start).toBe(NOW - 3 * D);
    const early = (await call<DepthHistoryResponse>(db, `/api/depth/history?step=1h&from=${NOW - 10 * D}&to=${NOW - 5 * D}`)).body;
    expect(early.points).toEqual([]);
    expect(early.gaps).toEqual([]);
    expect(early.note).toBe(`stored from ${fmtUtcLong(NOW - 3 * D)}`);
    expect(fmtUtcLong(NOW - 3 * D)).toMatch(/^26 Oct 2026, 12:00\sUTC$/);
  });

  it('a missing hour is a gap once fifteen minutes have passed since its close, not an hour later', async () => {
    const db = testD1();
    seedHours(db, 'all', NOW - 2 * D, NOW - H); // the newest row is the hour from 10:00; the hour from 11:00 closed at 12:00 and has no row
    const missing = NOW - H;
    expect(A.HISTORY_GRACE_MS['1h']).toBe(15 * MIN);
    at(NOW + 10 * MIN); // ten minutes after the close: the rollup is not yet due
    const early = (await call<DepthHistoryResponse>(db, `/api/depth/history?step=1h&from=${NOW - D}`)).body;
    expect(early.points.map((p) => p.t)).not.toContain(missing);
    expect(early.gaps).toEqual([]);
    vi.setSystemTime(NOW + 20 * MIN); // twenty minutes after: due, and a gap
    const late = (await call<DepthHistoryResponse>(db, `/api/depth/history?step=1h&from=${NOW - D}`)).body;
    expect(late.gaps).toEqual([{ from: missing, to: missing + H, why: GAP_HOUR }]);
    // the hour under way (from 12:00) is never a gap, however long past its start
    vi.setSystemTime(NOW + 59 * MIN);
    expect((await call<DepthHistoryResponse>(db, `/api/depth/history?step=1h&from=${NOW - D}`)).body.gaps).toEqual([{ from: missing, to: missing + H, why: GAP_HOUR }]);
  });

  it('the cap: one statement reads at most 43,200 rows, the answer says it stops at the cap and lists no gap past the last row', async () => {
    at(NOW);
    const db = testD1();
    const from = NOW - 43_260 * MIN;
    seedMinutes(db, '3009', from, NOW);
    const { body } = await call<DepthHistoryResponse>(db, `/api/depth/history?pool=3009&from=${from}`);
    expect(body.points).toHaveLength(HISTORY_ROWS_MAX);
    expect(HISTORY_ROWS_MAX).toBe(43_200);
    expect(cfg.caps.historyRowsMax).toBe(43_200);
    expect(body.cut).toBe(true);
    expect(body.note).toContain(historyCut(43_200));
    expect(body.gaps).toEqual([]);
    expect(body.points[body.points.length - 1].t).toBe(from + (HISTORY_ROWS_MAX - 1) * MIN);
    expect(A.HISTORY_MINUTE_SQL).toMatch(/LIMIT \?4$/);
    // a window that holds exactly the cap (a whole retention of minutes) is complete, not cut: one row past the cap is asked for to tell the two apart
    const whole = testD1();
    const from2 = NOW - HISTORY_ROWS_MAX * MIN;
    expect(seedMinutes(whole, '3009', from2, NOW)).toBe(43_200);
    const full = (await call<DepthHistoryResponse>(whole, `/api/depth/history?pool=3009&from=${from2}`)).body;
    expect(full.points).toHaveLength(HISTORY_ROWS_MAX);
    expect(full.cut).toBe(false);
    expect(full.note).not.toContain('cap');
    expect(full.note).toBe(minuteRowsKept(30));
    expect(full.gaps).toEqual([]);
  });

  it('under Rewind nothing after the rewound time is read and the window ends there', async () => {
    const db = testD1();
    seedMinutes(db, 'all', NOW - D, NOW);
    at(NOW);
    const back = NOW - 6 * H;
    const { body } = await call<DepthHistoryResponse>(db, `/api/depth/history?at=${back}`);
    expect(body.asOf).toBe(back);
    expect(body.to).toBe(back);
    expect(body.from).toBe(back - D);
    expect(body.points[body.points.length - 1].t).toBe(back - MIN);
    expect(body.points.every((p) => p.t < back)).toBe(true);
  });

  it('nothing stored: no point, no gap, no start, the reason; refusals in plain words, never cached', async () => {
    at(NOW);
    const db = testD1();
    const { body } = await call<DepthHistoryResponse>(db, '/api/depth/history?pool=3005');
    expect(body).toMatchObject({ points: [], gaps: [], start: null, recordedSince: null, cut: false });
    expect(body.note).toContain('nothing is stored for pool 3005 at this step');
    for (const [q, words] of [
      ['step=5m', 'step must be 1m or 1h.'], ['pool=abc', 'pool must be a pool id or all (every pool summed).'], ['from=x', 'from must be a unix time in milliseconds or a day (YYYY-MM-DD).'],
      [`from=${NOW}&to=${NOW - H}`, 'from must be before to.'], ['days=1', 'days is not a parameter of this route; it takes pool, from, to, step, at.'], ['from=2026-13-40', 'from is not a day.'],
    ] as const) {
      const r = await call<NotServedBody>(db, `/api/depth/history?${q}`);
      expect(r.status, q).toBe(400);
      expect(r.body.error).toBe(words);
      expect(r.cache).toBe('no-store');
    }
    // a day is read as its UTC start, `to` as its end
    const day = (await call<DepthHistoryResponse>(db, '/api/depth/history?from=2026-10-27&to=2026-10-27')).body;
    expect(day.from).toBe(Date.UTC(2026, 9, 27));
    expect(day.to).toBe(Date.UTC(2026, 9, 28));
  });
});

// ================================================================ GET /api/depth/heat
describe('GET /api/depth/heat: the aggregate’s heat bands', () => {
  it('a day: one column per stored minute with the bands as stored, the largest band over every column, the 113 edges; a missing minute has no column', async () => {
    at(NOW);
    const db = testD1();
    const hole = NOW - 100 * MIN;
    seedMinutes(db, 'all', NOW - 2 * D, NOW, (m) => m === hole, true);
    const { status, body, queries } = await call<DepthHeatResponse>(db, '/api/depth/heat?days=1');
    expect(status).toBe(200);
    expect(queries).toBe(1);
    expect(body).toMatchObject({ days: 1, step: '1m', from: NOW - D, to: NOW, asOf: NOW, how: HEAT_HOW['1m'] });
    expect(body.bands.edges).toEqual([...HEAT_EDGES]);
    expect(body.bands.edges).toHaveLength(113);
    expect(body.bands.pct).toBe(2.5);
    expect(body.columns).toHaveLength(1439);
    expect(body.columns.some((c) => c.t === hole)).toBe(false);
    const last = body.columns[body.columns.length - 1];
    expect(last.t).toBe(NOW - MIN);
    const bid = unpackF32(last.bid);
    expect(bid).toHaveLength(HEAT_BANDS);
    expect(bid[10]).toBe(2 * 1440 - 1); // the seeded value: the minute's index, in band 10
    expect(body.max).toBe(2 * 1440 - 1);
    expect(body.prov[0]).toMatchObject({ what: 'depth_minute rows of the aggregate: 1439 columns', status: 'stored' });
  });

  it('a week: the last minute of each five (2,016 columns at most); a month: the hourly rows; a day or a window not served is refused; the default is a week', async () => {
    at(NOW);
    const db = testD1();
    seedMinutes(db, 'all', NOW - 8 * D, NOW, () => false, true);
    seedHours(db, 'all', NOW - 40 * D, NOW, () => false, true);
    const week = (await call<DepthHeatResponse>(db, '/api/depth/heat?days=7')).body;
    expect(week.step).toBe('5m');
    expect(week.columns).toHaveLength(2016);
    expect(week.columns.every((c) => (c.t / MIN) % 5 === 4)).toBe(true);
    expect(week.how).toBe(HEAT_HOW['5m']);
    expect(cfg.caps.heatRowsMax).toBe(2016);
    expect((await call<DepthHeatResponse>(db, '/api/depth/heat')).body.step).toBe('5m');
    const month = (await call<DepthHeatResponse>(db, '/api/depth/heat?days=30')).body;
    expect(month.step).toBe('1h');
    expect(month.columns).toHaveLength(720);
    expect(month.max).toBe(1000 + 40 * 24 - 1);
    expect(month.prov[0].what).toBe('depth_hourly rows of the aggregate: 720 columns');
    for (const q of ['days=2', 'days=0', 'days=x']) {
      const r = await call<NotServedBody>(db, `/api/depth/heat?${q}`);
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('days must be one of 1, 7, 30.');
    }
  });

  it('a stored row without bands is left out and counted in the words', async () => {
    at(NOW);
    const db = testD1();
    seedMinutes(db, 'all', NOW - H, NOW, () => false, true);
    seedMinutes(db, 'all', NOW - 3 * MIN, NOW - MIN, () => false, false);
    const { body } = await call<DepthHeatResponse>(db, '/api/depth/heat?days=1');
    expect(body.columns).toHaveLength(58);
    expect(body.how).toBe(`${HEAT_HOW['1m']}; 2 stored rows carry no bands and are left out`);
  });
});

// ================================================================ GET /api/depth/owners
describe('GET /api/depth/owners: the hour’s owners with today’s labels', () => {
  it('kv depth.owners as the hour wrote it, each owner’s label and category from the labels table in the same statement, the address shortened as the holders list shows it', async () => {
    const db = await storedHour();
    const stored = kv<DepthOwnersKv>(db, 'depth.owners')!;
    expect(stored.owners.length).toBeGreaterThan(10);
    expect(stored.owners.every((o) => o.label === null && o.category === null)).toBe(true);
    const first = stored.owners[0].address, third = stored.owners[2].address;
    insert(db, 'labels', [
      { address: first, chain: 'osmosis', label: 'Market maker A', category: 'whale', source: 'auto' },
      { address: third, chain: 'osmosis', label: 'Genesis: af_backers', category: 'backer', source: 'genesis' },
    ]);
    const { status, body, queries } = await call<DepthOwnersApiResponse>(db, '/api/depth/owners');
    expect(status).toBe(200);
    expect(queries).toBe(1);
    expect(body.owners).toHaveLength(stored.owners.length);
    expect(body.owners[0]).toMatchObject({ address: first, short: fmtAddr(first), label: 'Market maker A', category: category_plain('whale', 'Market maker A') });
    expect(body.owners[2]).toMatchObject({ address: third, label: 'Early backers (genesis)', category: category_plain('backer', 'Genesis: af_backers') });
    expect(body.owners[1].label).toBeNull();
    expect(body.labelled).toBe(2);
    expect(body.owners.map((o) => ({ ...o, label: null, category: null }))).toEqual(stored.owners);
    expect(body.totals).toEqual(stored.totals);
    expect(body.totals.positions + body.totals.orders).toBe(stored.owners.reduce((n, o) => n + o.items.length, 0));
    expect(body).toMatchObject({ at: stored.at, height: stored.height, hour: stored.hour, positions: stored.positions, orders: stored.orders, invariants: stored.invariants, notes: stored.notes });
    expect(body.invariants.inRange.ok).toBe(true);
    expect(body.prov).toEqual(stored.prov);
    expect(body.prov.length).toBeGreaterThan(5);
  });

  it('with no stored hour: a 404 in the NotServedBody shape; a parameter is refused', async () => {
    const r = await call<NotServedBody>(testD1(), '/api/depth/owners');
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: NOT_SERVED, reason: OWNERS_NOT_STORED, endpoint: '/api/depth/owners' });
    expect((await call<NotServedBody>(testD1(), '/api/depth/owners?page=2')).status).toBe(400);
  });
});

// ================================================================ GET /api/depth/changes
describe('GET /api/depth/changes: keyset pages, newest first', () => {
  const BASE = NOW - MIN;
  /** 450 rows over 300 milliseconds: every third millisecond holds three rows (one minute's diff shares one ts), the rest one. */
  function seedChanges(db: TestD1): DepthChangeRow[] {
    const rows: DepthChangeRow[] = [];
    for (let i = 0; i < 300; i++) {
      const ts = BASE - i * 1000;
      const mk = (pool: string, ref: string, kind: DepthChangeRow['kind']): DepthChangeRow => ({ ts, pool, ref, kind, side: 'bid', loUsd: 0.0009, hiUsd: 0.001, nam: 100 + i, usd: 0.1, owner: i % 2 ? `owner#${i % 11}` : null, height: 73_000_000 + i });
      rows.push(mk('3005', `rng:-27000000:-26900000`, 'grew'));
      if (i % 3 === 0) rows.push(mk('3368', 'pos:15392963', 'shrank'), mk('3005', 'pos:1', 'added'));
    }
    db.raw.exec('BEGIN');
    for (const r of rows) { const s = changeStmt(r); db.raw.prepare(s.sql).run(...s.params); }
    db.raw.exec('COMMIT');
    return rows.sort((a, b) => b.ts - a.ts || (b.pool < a.pool ? -1 : b.pool > a.pool ? 1 : 0) || (b.ref < a.ref ? -1 : b.ref > a.ref ? 1 : 0));
  }
  async function pages(db: TestD1, q: string, limit: number) {
    const got: DepthChangeRow[] = [];
    let next: string | null = null, n = 0, queries = 0;
    do {
      const r: { body: DepthChangesResponse; queries: number } = await call<DepthChangesResponse>(db, `/api/depth/changes?${q}${next ? `&before=${encodeURIComponent(next)}` : ''}`);
      expect(r.body.limit).toBe(limit);
      expect(r.body.rows.length).toBeLessThanOrEqual(limit);
      got.push(...r.body.rows);
      next = r.body.next;
      queries += r.queries;
      n++;
    } while (next);
    return { got, n, queries };
  }

  it('pages through every row exactly once in (ts, pool, ref) order; ties on one millisecond are never cut; the cursor is the last row', async () => {
    at(NOW);
    const db = testD1();
    const want = seedChanges(db);
    expect(want).toHaveLength(500);
    const { got, n, queries } = await pages(db, 'limit=200', 200);
    expect(got).toEqual(want);
    expect(n).toBe(3);
    expect(queries).toBe(1 + 2 + 2); // one statement for the head page, two (the tie and the older rows, one batch) for each page behind a cursor; no page ends inside a millisecond at 200
    // page lengths that end inside a millisecond's three rows, and one shorter than them: the millisecond is read whole, nothing is lost or repeated
    for (const limit of [7, 2, 1]) {
      const small = await pages(db, `limit=${limit}`, limit);
      expect(small.got, `limit ${limit}`).toEqual(want);
      expect(small.n, `limit ${limit}`).toBe(Math.ceil(500 / limit));
    }
    const head = (await call<DepthChangesResponse>(db, '/api/depth/changes')).body;
    expect(head.limit).toBe(CHANGES_LIMIT_MAX);
    expect(CHANGES_LIMIT_MAX).toBe(200);
    expect(head.rows).toHaveLength(200);
    expect(head.next).toBe(A.changesCursor(head.rows[199]));
    expect(head.rows[0]).toEqual(want[0]);
    expect(head.prov[0]).toMatchObject({ what: 'depth_changes rows: 200', status: 'stored', at: want[0].ts, height: want[0].height });
  });

  it('one pool’s rows only, in the same order; a malformed cursor or page length is refused, never ignored', async () => {
    at(NOW);
    const db = testD1();
    const want = seedChanges(db).filter((r) => r.pool === '3368');
    expect(want).toHaveLength(100);
    const { got } = await pages(db, 'pool=3368&limit=30', 30);
    expect(got).toEqual(want);
    for (const [q, words] of [
      ['before=zz..', 'before must be a cursor from a previous page.'], [`before=${btoa('[1,2]')}`, 'before must be a cursor from a previous page.'],
      ['limit=0', 'limit must be a whole number from 1 to 200.'], ['limit=201', 'limit must be a whole number from 1 to 200.'], ['limit=x', 'limit must be a whole number from 1 to 200.'],
      ['pool=x', 'pool must be a pool id; leave it out for every pool’s changes (a change belongs to one pool, so there is no all).'],
      ['pool=all', 'pool must be a pool id; leave it out for every pool’s changes (a change belongs to one pool, so there is no all).'],
      ['at=5', 'at is not a parameter of this route; it takes pool, before, limit.'],
    ] as const) {
      const r = await call<NotServedBody>(db, `/api/depth/changes?${q}`);
      expect(r.status, q).toBe(400);
      expect(r.body.error).toBe(words);
      expect(r.cache).toBe('no-store');
    }
    expect((await call<DepthChangesResponse>(testD1(), '/api/depth/changes')).body).toMatchObject({ rows: [], next: null });
    // a pool with no rows: an empty page from one statement, read on the (pool_id, ts) index and not a walk of the other pools' rows (the plan below)
    const none = await call<DepthChangesResponse>(db, '/api/depth/changes?pool=9999');
    expect(none.body).toMatchObject({ pool: '9999', rows: [], next: null });
    expect(none.queries).toBe(1);
    expect(none.body.prov[0]).toMatchObject({ what: 'depth_changes rows of pool 9999: 0', url: null, table: 'depth_changes', key: { pool_id: '9999', before: NOW, limit: 200 } });
  });
});

// ================================================================ the mount, the parameters and the edge cache
describe('the mount, the parameter allow-list and the edge cache key', () => {
  it('an unknown path under the mount is a 404 in the NotServedBody shape; the series routes are unaffected', async () => {
    const r = await call<NotServedBody>(testD1(), '/api/depth/nope');
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: NOT_SERVED, reason: 'No such depth route.', endpoint: '/api/depth/nope' });
    expect(r.cache).toBe('no-store');
    expect((await call(testD1(), '/api/series/pairs')).status).toBe(200);
  });

  it('every parameter a route reads is listed in DEPTH_PARAMS and read only through params(); every route is cached at the edge with exactly those parameters in its key', () => {
    const src = readFileSync(join(__dirname, '..', 'worker', 'src', 'api-depth.ts'), 'utf8');
    expect([...src.matchAll(/c\.req\.query\(/g)]).toHaveLength(1);
    expect([...src.matchAll(/c\.req\.queries\(/g)]).toHaveLength(1);
    expect(src).toMatch(/function params<R extends Route>[\s\S]*?c\.req\.query\(k\)/);
    const used = [...src.matchAll(/params\(c, '([^']+)'\)/g)].map((m) => m[1]);
    expect(new Set(used)).toEqual(new Set(Object.keys(DEPTH_PARAMS)));
    const mounted = [...src.matchAll(/depth\.get\('([^']+)'/g)].map((m) => `/api/depth${m[1] === '/' ? '' : m[1]}`);
    expect(new Set(mounted)).toEqual(new Set(Object.keys(DEPTH_PARAMS)));
    for (const [route, ps] of Object.entries(DEPTH_PARAMS)) {
      expect(CACHEABLE_API.test(route), route).toBe(true);
      expect(CACHE_PARAMS[route], route).toEqual([...ps]);
    }
    expect(Object.keys(DEPTH_PARAMS)).toEqual(['/api/depth', '/api/depth/quote', '/api/depth/history', '/api/depth/heat', '/api/depth/owners', '/api/depth/changes']);
  });

  it('the key keeps the listed parameters only, sorted; a window of its own, a changes cursor or page length is a high-cardinality read; the defaults are not', () => {
    const u = (p: string) => new URL(`https://namada.trade${p}`);
    expect(cacheKeyUrl(u('/api/depth?r=5'))).toBe('https://namada.trade/api/depth');
    expect(cacheKeyUrl(u('/api/depth/history?step=1h&pool=3005&x=1'))).toBe('https://namada.trade/api/depth/history?pool=3005&step=1h');
    expect(cacheKeyUrl(u(`/api/depth/history?at=${NOW}`), NOW + 1)).toBe(`https://namada.trade/api/depth/history?at=${NOW}`);
    const PAST = Date.UTC(2026, 9, 20); // a time behind the clock this test runs at
    for (const p of ['/api/depth', '/api/depth/quote?side=sell&nam=1000', '/api/depth/history', '/api/depth/history?pool=3005&step=1h', '/api/depth/heat', '/api/depth/heat?days=30', '/api/depth/owners', '/api/depth/changes', '/api/depth/changes?pool=3005&limit=200']) expect(isReplay(u(p)), p).toBe(false);
    for (const p of [`/api/depth/history?from=${NOW - H}`, `/api/depth/history?to=${NOW}`, `/api/depth/history?at=${PAST}`, `/api/depth/heat?at=${PAST}`, '/api/depth/heat?days=3', '/api/depth/changes?before=abc', '/api/depth/changes?limit=50']) expect(isReplay(u(p)), p).toBe(true);
  });

  it('through cachedApi: the stored copy’s lifetime per route (the minute and its quotes 30 s, the heat a minute, the owners five), X-Robots-Tag noindex, the browser lifetime 5 s', async () => {
    const store = new Map<string, Response>();
    const pending: Promise<unknown>[] = [];
    vi.stubGlobal('caches', { default: { match: async (r: Request) => store.get(r.url)?.clone(), put: async (r: Request, res: Response) => { store.set(r.url, res); } } });
    const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as any;
    const db = await storedMinute();
    at(T1 + MIN);
    const fetchApp = (r: Request) => app.request(r, {}, { DB: db } as any);
    const lifetimes: [string, number][] = [['/api/depth', 30], ['/api/depth/quote?side=sell&nam=1000', 30], ['/api/depth/history', 30], ['/api/depth/heat', 60], ['/api/depth/changes', 30]];
    for (const [p, s] of lifetimes) {
      const res = await cachedApi(new Request(`https://namada.trade${p}`), {} as any, ctx, fetchApp);
      expect(res.status, p).toBe(200);
      expect(res.headers.get('x-robots-tag'), p).toBe('noindex');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('cache-control'), p).toBe('public, max-age=5');
      await Promise.all(pending);
      const stored = store.get(cacheKeyUrl(new URL(`https://namada.trade${p}`)));
      expect(stored, p).toBeDefined();
      expect(stored!.headers.get('cache-control'), p).toBe(`public, max-age=5, s-maxage=${s}, stale-while-revalidate=30`);
    }
    expect(edgeCacheOf(new URL('https://namada.trade/api/depth/owners'))).toBe('public, max-age=5, s-maxage=300, stale-while-revalidate=30');
    // the quote's key is the rounded size: the second request is served from the first's copy
    const calls = store.size;
    const again = await cachedApi(new Request('https://namada.trade/api/depth/quote?side=sell&nam=1000.4'), {} as any, ctx, fetchApp);
    expect(again.status).toBe(200);
    expect(store.size).toBe(calls);
    expect((await again.json() as DepthQuoteResponse).nam).toBe(1000);
    // a refusal is not stored
    const bad = await cachedApi(new Request('https://namada.trade/api/depth/quote?side=hold&nam=1'), {} as any, ctx, fetchApp);
    expect(bad.status).toBe(400);
    expect(bad.headers.get('cache-control')).toBe('no-store');
    expect(bad.headers.get('x-robots-tag')).toBe('noindex');
    await Promise.all(pending);
    expect(store.size).toBe(calls);
  });
});

// ================================================================ query plans
describe('query plans: every statement the routes run', () => {
  const nParams = (sql: string) => { const nums = [...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1])); return nums.length ? Math.max(...nums) : (sql.match(/\?/g) ?? []).length; };
  const plan = (db: TestD1, sql: string) => all(db, `EXPLAIN QUERY PLAN ${sql}`, ...Array.from({ length: nParams(sql) }, () => 1)).map((r) => r.detail).join(' | ');
  const statements: [string, string][] = [
    ['LATEST_SQL', A.LATEST_SQL], ['LATEST_AND_STATES_SQL', A.LATEST_AND_STATES_SQL],
    ['HISTORY_MINUTE_SQL', A.HISTORY_MINUTE_SQL], ['HISTORY_HOUR_SQL', A.HISTORY_HOUR_SQL], ['HISTORY_START_SQL', A.HISTORY_START_SQL],
    ['HEAT_MINUTE_SQL', A.HEAT_MINUTE_SQL], ['HEAT_FIVE_SQL', A.HEAT_FIVE_SQL], ['HEAT_HOUR_SQL', A.HEAT_HOUR_SQL], ['OWNERS_SQL', A.OWNERS_SQL],
    ...[false, true].flatMap((pool) => [false, true].map((tie): [string, string] => [`changesSql(pool ${pool}, tie ${tie})`, A.changesSql({ pool, tie })])),
  ];

  it('each is a SEARCH on the primary key, the key index or the ts index: no temporary B-tree, no SCAN of a table', () => {
    const db = testD1();
    for (const [name, sql] of statements) {
      const p = plan(db, sql);
      expect(p, name).toMatch(/SEARCH/);
      expect(p, name).not.toMatch(/TEMP B-TREE/);
      expect(p, name).not.toMatch(/\bSCAN (depth_minute|depth_hourly|depth_changes|kv|labels|k|l)\b/);
    }
    expect(plan(db, A.HISTORY_MINUTE_SQL)).toBe('SEARCH depth_minute USING INDEX sqlite_autoindex_depth_minute_1 (pool_id=? AND minute>? AND minute<?)');
    expect(plan(db, A.HISTORY_HOUR_SQL)).toBe('SEARCH depth_hourly USING INDEX sqlite_autoindex_depth_hourly_1 (pool_id=? AND hour>? AND hour<?)');
    // the two starts: each the left edge of its table's primary key, in one statement
    expect(plan(db, A.HISTORY_START_SQL)).toContain('SEARCH depth_minute USING COVERING INDEX sqlite_autoindex_depth_minute_1 (pool_id=?)');
    expect(plan(db, A.HISTORY_START_SQL)).toContain('SEARCH depth_hourly USING COVERING INDEX sqlite_autoindex_depth_hourly_1 (pool_id=?)');
    expect(plan(db, A.HEAT_FIVE_SQL)).toBe('SEARCH depth_minute USING INDEX sqlite_autoindex_depth_minute_1 (pool_id=? AND minute>? AND minute<?)');
    expect(plan(db, A.HEAT_HOUR_SQL)).toBe('SEARCH depth_hourly USING INDEX sqlite_autoindex_depth_hourly_1 (pool_id=? AND hour>? AND hour<?)');
    // the owners: the kv row by key, the addresses out of its JSON, each label by the table's primary key
    expect(plan(db, A.OWNERS_SQL)).toMatch(/SEARCH kv USING INDEX sqlite_autoindex_kv_1 \(key=\?\)[\s\S]*SEARCH k USING INDEX sqlite_autoindex_kv_1 \(key=\?\) \| SCAN j VIRTUAL TABLE INDEX \d+: \| SEARCH l USING INDEX sqlite_autoindex_labels_1 \(address=\?\)/);
    // the changes: every pool on the ts index; one pool on the (pool_id, ts) index of migration 0015, so a pool with few rows never walks the others' rows and nothing is sorted
    expect(plan(db, A.changesSql({ pool: false, tie: false }))).toBe('SEARCH depth_changes USING INDEX depth_changes_ts (ts<?)');
    expect(plan(db, A.changesSql({ pool: false, tie: true }))).toBe('SEARCH depth_changes USING INDEX depth_changes_ts (ts=?)');
    expect(plan(db, A.changesSql({ pool: true, tie: false }))).toBe('SEARCH depth_changes USING INDEX depth_changes_pool_ts (pool_id=? AND ts<?)');
    expect(plan(db, A.changesSql({ pool: true, tie: true }))).toBe('SEARCH depth_changes USING INDEX depth_changes_pool_ts (pool_id=? AND ts=?)');
  });

  it('how many statements each route sends (one round trip each)', async () => {
    at(NOW);
    const db = testD1();
    seedMinutes(db, 'all', NOW - H, NOW, () => false, true);
    const count = async (path: string) => (await call(db, path)).queries;
    expect(await count('/api/depth/history')).toBe(2); // the range and the start, one batch
    expect(await count('/api/depth/heat?days=1')).toBe(1);
    expect(await count('/api/depth/changes')).toBe(1);
    expect(await count(`/api/depth/changes?before=${A.changesCursor({ ts: NOW, pool: '3005', ref: 'res' })}`)).toBe(2); // the tie and the older rows, one batch
  });
});
