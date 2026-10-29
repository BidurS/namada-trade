// The depth minute (worker/src/depth/index.ts minute) on the research's saved answers of 2026-10-29 (test/depth-minute-net.ts
// says which fixture answers which read; none reaches the network): the reads a steady minute makes (two batch POSTs,
// since the public node takes ten queries a body, the price list, the chain's estimate, the book's state and its ticks
// by id), the 17 rows written (15 priced pools, the one unpriced pool and 'all' with its heat bands), every REAL column
// finite or NULL with a note, the kv rows (depth.latest under its size, depth.states, depth.prev the minute after,
// depth.book, depth.params, depth.budget), the phase budget (a hanging batch stops the phase and the health row names the
// pools not read), the gateway fallback, nothing written when the tick is late or the kill switch is off, the three
// checks' rows, and the compute's time under 500 ms (plan 1.4).
import { describe, it, expect } from 'vitest';
import { testD1, insert, type TestD1 } from './d1-sqlite';
import { minute, modelOfState, executedCheck, DEPTH_HEALTH, type DepthStates, type MinuteCtx, type Realised } from '../worker/src/depth/index';
import { NAM_DEPTH } from '../worker/src/depth/config';
import { aggregate, buildGrid, executeSell, executeBuyUsd, unpackF32, type PricedPool } from '../worker/src/depth/model';
import { minuteStmt, DEPTH_MINUTE_COLUMNS, deleteOldMinutesStmt, type DepthMinuteRow } from '../worker/src/depth/sql';
import { DEPTH_LATEST_MAX_BYTES, CURVE_POINTS_MAX, CURVE_POOL_POINTS_MAX, HEAT_BANDS, UNPRICED_NO_PRICE, UNPRICED_NO_TAKER, UNPRICED_DUST, UNPRICED_EMPTY, BOOK_LEG_LEFT_OUT, type DepthResponse } from '../shared/depth';
import type { SourceHealth } from '../shared/types';
import { depthNetwork, bookKvFromFixture, paramsKvFromFixture, LATEST, SQS_POOLS, REF_HEIGHT, type NetOptions } from './depth-minute-net';
import { NAM_DENOM, depthFixtureHeader } from './depth-fixtures';

const cfg = NAM_DEPTH;
/** 02:56:30 UTC on 29 Oct 2026: half a minute after the prototype's minute (proto_latest.json at 02:56:03). */
const T = Date.UTC(2026, 9, 29, 2, 56, 30);
const MINUTE = Math.floor(T / 60000) * 60000;
const all = (db: TestD1, sql: string, ...p: unknown[]) => db.raw.prepare(sql).all(...p).map((r: any) => ({ ...r }));
const kv = <T = any>(db: TestD1, key: string): T | null => { const r = all(db, 'SELECT value FROM kv WHERE key = ?', key)[0]; return r ? JSON.parse(r.value) : null; };
const kvText = (db: TestD1, key: string): string | null => all(db, 'SELECT value FROM kv WHERE key = ?', key)[0]?.value ?? null;
const checks = (db: TestD1) => Object.fromEntries(all(db, 'SELECT key, status, detail FROM checks').map((r) => [r.key, { status: r.status, detail: JSON.parse(r.detail) }]));
const rowOf = (h: SourceHealth[], name: string) => h.filter((x) => x.name === name).pop();
const rows = (db: TestD1, m = MINUTE) => all(db, 'SELECT * FROM depth_minute WHERE minute = ? ORDER BY CASE pool_id WHEN \'all\' THEN 0 ELSE 1 END, CAST(pool_id AS INTEGER)', m);

/** A seeded database: the parameters and the book as the minute before would have left them, so this minute is a steady one. */
function seeded(opts: { params?: boolean; book?: boolean } = {}) {
  const db = testD1();
  const before = T - 60_000;
  if (opts.params !== false) insert(db, 'kv', [{ key: 'depth.params', value: JSON.stringify(paramsKvFromFixture(before)), updated_at: before }]);
  if (opts.book !== false) insert(db, 'kv', [{ key: 'depth.book', value: JSON.stringify(bookKvFromFixture(before)), updated_at: before }]);
  return db;
}
async function run(db: TestD1, net: NetOptions = {}, ctx: Partial<MinuteCtx> = {}, now = T) {
  const n = depthNetwork(net);
  const health: SourceHealth[] = [];
  let clock = now;
  const res = await minute({ DB: db } as any, now, { health, fetch: n.fetch, clock: () => (clock += 100), pools: SQS_POOLS, poolsAt: now - 1500, routeOut: { nam: 1000, amountOut: '1014160', at: now - 1000 }, ...ctx });
  return { res, health, net: n, db };
}
const pct = (a: number, b: number) => (a / b - 1) * 100;

describe('a steady minute on the saved answers', () => {
  it('reads two batch POSTs (sixteen queries, ten a body), the price list, the estimate, the book state and the ticks by id: six requests, under the cap of twelve', async () => {
    const { res, net, health } = await run(seeded());
    expect(res.skipped).toBeUndefined();
    const kinds = net.calls.map((c) => (c.method === 'POST' ? 'batch' : new URL(c.url).pathname.includes('/tokens/prices') ? 'prices' : c.url.includes('estimate') ? 'estimate' : c.url.includes('/smart/') ? 'book' : c.url));
    expect(kinds.filter((k) => k === 'batch')).toHaveLength(2);
    expect(JSON.parse(net.calls.find((c) => c.method === 'POST')!.body!)).toHaveLength(10);
    expect(kinds.filter((k) => k === 'prices')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'estimate')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'book')).toHaveLength(2);
    expect(net.calls).toHaveLength(6);
    expect(res.requests).toBe(6);
    expect(res.requests).toBeLessThanOrEqual(cfg.caps.requestsPerMinute);
    const pools = rowOf(health, DEPTH_HEALTH.pools)!;
    expect(pools.ok).toBe(true);
    expect(pools.note).toMatch(/^14 of 14 pools read at height 73429291, \d+ bytes over 6 requests/);
    expect(rowOf(health, DEPTH_HEALTH.book)).toMatchObject({ ok: true });
    expect(rowOf(health, DEPTH_HEALTH.book)!.note).toMatch(/^3 bid levels, 31 ask levels, 0 changed; state at 02:56 UTC; Osmosis order book contract \(pool 3008\)$/);
    expect(rowOf(health, DEPTH_HEALTH.store)).toMatchObject({ ok: true });
  });

  it('writes 17 rows: the aggregate with its heat bands, the 15 priced pools, and pool 3020 with the reason its coin has no price', async () => {
    const { db } = await run(seeded());
    const r = rows(db);
    expect(r).toHaveLength(17);
    expect(r.map((x) => x.pool_id)).toEqual(['all', ...LATEST.pricedIds.map(Number).sort((a: number, b: number) => a - b).map(String).filter((id: string) => id !== '3020'), '3020'].sort((a, b) => (a === 'all' ? -1 : b === 'all' ? 1 : Number(a) - Number(b))));
    const a = r[0];
    expect(a.pool_id).toBe('all');
    expect(a.height).toBe(REF_HEIGHT);
    expect(a.ref_usd).toBeCloseTo(0.001019868458722253, 12);
    expect(a.note).toBeNull();
    expect(unpackF32(a.heat_bid)).toHaveLength(HEAT_BANDS);
    expect(unpackF32(a.heat_ask)).toHaveLength(HEAT_BANDS);
    expect(Array.from(unpackF32(a.heat_bid)).reduce((s, v) => s + v, 0)).toBeGreaterThan(0);
    for (const p of r.slice(1)) { expect(p.heat_bid).toBeNull(); expect(p.heat_ask).toBeNull(); }
    const unpriced = r.find((x) => x.pool_id === '3020')!;
    expect(unpriced.note).toBe(UNPRICED_NO_PRICE);
    expect(unpriced.sell_10k).toBeNull();
    expect(unpriced.bid_10).toBeNull();
    expect(unpriced.nam).toBeCloseTo(41179.599789, 6); // the list's balance, a fact of the read
    expect(unpriced.counter).toBeCloseTo(3491.227565, 6);
    expect(unpriced.counter_usd).toBeNull();
    // the book's row: no spot (the book has no mid), its own bids and asks
    const book = r.find((x) => x.pool_id === '3008')!;
    expect(book.spot_usd).toBeNull();
    expect(book.bid_usd).toBeCloseTo(174.700606, 4);
    expect(book.ask_nam).toBeCloseTo(810665.411525, 3);
    expect(book.note).toBeNull();
  });

  it('the aggregate figures are the prototype’s minute within what the four re-derived small pools allow: 10,000 NAM sells for 9.9245 USDC, USD of bids within 10 % 26.88', async () => {
    const { db, res } = await run(seeded());
    const a = rows(db)[0];
    expect(Math.abs(pct(a.sell_10k, LATEST.sells[1].usdOut))).toBeLessThan(0.05);
    expect(Math.abs(pct(a.sell_1k, LATEST.sells[0].usdOut))).toBeLessThan(0.05);
    expect(Math.abs(pct(a.sell_100k, LATEST.sells[2].usdOut))).toBeLessThan(0.2);
    expect(Math.abs(pct(a.bid_10, LATEST.within.bidUsd10pct))).toBeLessThan(0.1);
    expect(Math.abs(pct(a.bid_usd, LATEST.within.totalBidUsd))).toBeLessThan(0.1);
    expect(Math.abs(pct(a.ask_nam, LATEST.within.totalAskNam))).toBeLessThan(0.1);
    expect(a.best_bid).toBeCloseTo(LATEST.bestBidEff, 7);
    expect(a.best_ask).toBeCloseTo(LATEST.bestAskEff, 7);
    // pool 3005 alone: its own row's 1,000 NAM sale is the chain's estimate (1.014160 USDC) within the grid's quarter-percent step (the exact walk is check 1's)
    const p = rows(db).find((x) => x.pool_id === '3005')!;
    expect(Math.abs(pct(p.sell_1k, 1.01416))).toBeLessThan(0.02);
    expect(p.spot_usd).toBeCloseTo(0.001019868458722253, 12);
    expect(p.height).toBe(REF_HEIGHT);
    expect(p.nam).toBeCloseTo(751550.946149, 3);
    expect(p.counter).toBeCloseTo(187.511006, 6);
    expect(p.counter_usd).toBeCloseTo(187.511006, 6);
    // a pool in OSMO: the counter's dollar value at the price list
    const osmoPool = rows(db).find((x) => x.pool_id === '3368')!;
    expect(osmoPool.counter_usd).toBeCloseTo(osmoPool.counter * 0.050703009615287474, 6);
    expect(res.latest!.pools.find((x) => x.id === '3368')!.counterUsdHow).toContain('OSMO at the quote service’s price list, 0.050703009615287474 USD, 02:56 UTC; converting OSMO to USDC would cost another hop');
  });

  it('every REAL column of every row is a finite number or NULL; the NOT NULL columns are set', async () => {
    const { db } = await run(seeded());
    for (const r of rows(db)) {
      for (const c of DEPTH_MINUTE_COLUMNS) {
        const v = r[c];
        if (c === 'pool_id' || c === 'heat_bid' || c === 'heat_ask' || c === 'note') continue;
        if (c === 'minute' || c === 'at' || c === 'ref_usd') expect(Number.isFinite(v), `${r.pool_id}.${c}`).toBe(true);
        else expect(v === null || Number.isFinite(v), `${r.pool_id}.${c} = ${v}`).toBe(true);
      }
      expect(r.minute).toBe(MINUTE);
    }
  });

  it('minuteStmt binds a figure that is not finite as NULL, and refuses a row whose minute, at or ref_usd is not finite', () => {
    const row: DepthMinuteRow = { minute: MINUTE, pool_id: 'x', at: T, height: NaN, ref_usd: 0.001, spot_usd: Infinity, bid: [1, NaN, -Infinity], ask: [], sell: [null, 2], buy: [], best_bid: NaN, best_ask: null, bid_usd: 3, ask_nam: Infinity, nam: 1, counter: null, counter_usd: NaN, heat_bid: null, heat_ask: null, note: 'n'.repeat(300) };
    const s = minuteStmt(row);
    expect(s.params.slice(3, 6)).toEqual([null, 0.001, null]);
    expect(s.params.slice(6, 12)).toEqual([1, null, null, null, null, null]);
    expect(s.params.slice(18, 22)).toEqual([null, 2, null, null]);
    expect(s.params.every((p) => p === null || typeof p === 'string' || Number.isFinite(p))).toBe(true);
    expect((s.params[s.params.length - 1] as string).length).toBe(160);
    expect(() => minuteStmt({ ...row, ref_usd: NaN })).toThrow(/ref_usd/);
    expect(() => minuteStmt({ ...row, at: Infinity })).toThrow();
  });

  it('kv: depth.latest holds the minute’s answer under 150 KB with the curve thinned, depth.states the raw states, depth.budget the rows written and the bytes read; depth.prev only from the second minute', async () => {
    const { db, res } = await run(seeded());
    const latestText = kvText(db, 'depth.latest')!;
    expect(latestText.length).toBeLessThan(DEPTH_LATEST_MAX_BYTES);
    const latest: DepthResponse = JSON.parse(latestText);
    expect(latest.at).toBe(MINUTE);
    expect(latest.ref).toMatchObject({ pool: '3005', height: REF_HEIGHT, status: 'live' });
    expect(latest.pools).toHaveLength(15);
    expect(latest.unpriced.map((u) => u.id).sort()).toEqual(['3006', '3010', '3011', '3012', '3016', '3018', '3019', '3020', '3021', '3022', '3023', '3037', '3263'].sort());
    expect(latest.unpriced.find((u) => u.id === '3020')!.why).toBe(UNPRICED_NO_PRICE);
    expect(latest.unpriced.find((u) => u.id === '3016')!.why).toBe(UNPRICED_EMPTY);
    expect(latest.unpriced.find((u) => u.id === '3019')!.why).toBe(UNPRICED_DUST);
    expect(latest.curve.price.length).toBeLessThanOrEqual(2 * CURVE_POINTS_MAX);
    expect(Object.keys(latest.curve.perPool)).toHaveLength(15);
    for (const c of Object.values(latest.curve.perPool)) expect(c.bidUsd.length).toBeLessThanOrEqual(2 * CURVE_POOL_POINTS_MAX);
    expect(latest.answer.sell[1].usd).toBeCloseTo(res.rows[0].sell[1]!, 5);
    expect(latest.prov.length).toBe(6);
    expect(latest.prov.every((p) => p.url && p.at && p.status === 200)).toBe(true);
    expect(latest.cost).toMatchObject({ reads: 6 });
    expect(latest.book.levels.length).toBeGreaterThan(60); // 31 ranges of 3005, 34 book levels, the rest
    const states = kv<DepthStates>(db, 'depth.states')!;
    expect(states.minute).toBe(MINUTE);
    expect(states.pools).toHaveLength(15);
    expect(states.pools.find((p) => p.id === '3005')!.cl!.ranges).toHaveLength(31);
    expect(states.pools.find((p) => p.id === '3008')!.book!.asks).toHaveLength(31);
    expect(kv(db, 'depth.prev')).toBeNull();
    const budget = kv(db, 'depth.budget')!;
    expect(budget.month).toBe('2026-10');
    expect(budget.rowsWritten).toBe(17 + 2 + 4); // the rows, the two kv rows written (latest, states; prev had nothing to copy, the book and the parameters did not change), the four check rows
    expect(budget.bytesIn).toBe(res.bytes);
    expect(kv(db, 'depth.book')!.listedAt).toBe(T - 60_000);
    // the second minute: depth.prev is the first minute's states, the book unchanged, the rows of both minutes kept
    const { db: db2 } = await run(db, {}, {}, T + 60_000);
    expect(kv<DepthStates>(db2, 'depth.prev')!.minute).toBe(MINUTE);
    expect(kv<DepthStates>(db2, 'depth.states')!.minute).toBe(MINUTE + 60_000);
    expect(all(db2, 'SELECT COUNT(*) n FROM depth_minute')[0].n).toBe(34);
    expect(kv(db2, 'depth.budget')!.rowsWritten).toBe(23 + 17 + 3 + 4); // then the rows, latest, the copy to prev, states, the checks
  });

  it('the compute stays under 500 ms (plan 1.4; measured around the synchronous part with performance.now)', async () => {
    const { res } = await run(seeded());
    expect(res.cpuMs).toBeGreaterThan(0);
    expect(res.cpuMs).toBeLessThan(500);
  });
});

describe('the first minute, with no parameters and no book known', () => {
  it('reads the token metadata, three taker fees (the rest next minutes), lists the book’s ticks and reads orders as far as the cap allows; pools whose taker fee is not yet read are unpriced with that reason', async () => {
    const { db, net, health } = await run(seeded({ params: false, book: false }));
    const paths = net.calls.map((c) => new URL(c.url).pathname);
    expect(paths.filter((p) => p === '/tokens/metadata')).toHaveLength(1);
    expect(paths.filter((p) => p.endsWith('/trading_pair_takerfee'))).toHaveLength(cfg.read.takerReadsPerMinute);
    expect(net.calls).toHaveLength(cfg.caps.requestsPerMinute);
    const params = kv(db, 'depth.params')!;
    expect(Object.keys(params.taker)).toHaveLength(3);
    expect(Object.keys(params.tokens).length).toBeGreaterThanOrEqual(5);
    const r = rows(db);
    const noTaker = r.filter((x) => x.note === UNPRICED_NO_TAKER).map((x) => x.pool_id);
    expect(noTaker.length).toBeGreaterThan(0);
    expect(r.filter((x) => x.note == null).length + noTaker.length + 1).toBe(17);
    const book = kv(db, 'depth.book');
    expect(book.listedAt).toBe(T);
    expect(Object.keys(book.ticks)).toHaveLength(34);
    expect(rowOf(health, DEPTH_HEALTH.book)!.note).toContain('(ticks listed anew)');
    expect(rowOf(health, DEPTH_HEALTH.pools)!.note).toContain(`over ${cfg.caps.requestsPerMinute} requests`);
    expect(net.calls.filter((c) => c.url.includes('/smart/')).length).toBeGreaterThanOrEqual(3); // the state, the list, at least one tick's orders before the cap
    // the pool rows that were read carry no note; the price list's coins are the same as the steady minute's
    expect(r.find((x) => x.pool_id === '3005')!.note).toBeNull();
  });
});

describe('the phase budget and the fallback', () => {
  it('a batch that hangs until the phase ends: its pools are not read, their rows say so, the aggregate leaves them out and the health row names them', async () => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort('phase end'), 40);
    const { db, health, res } = await run(seeded(), { hang: (url, body) => !!body && JSON.parse(body).length < 10 }, { signal: ctrl.signal });
    const r = rows(db);
    expect(r).toHaveLength(17);
    const missing = r.filter((x) => x.pool_id !== 'all' && x.note?.startsWith('not read this minute (phase end)'));
    expect(missing.map((x) => x.pool_id)).toHaveLength(2); // the second batch carries the last two of the seven concentrated pools (fourteen queries, ten a body)
    expect(missing.every((x) => x.sell_10k === null && x.height === null)).toBe(true);
    expect(r[0].note).toMatch(/^pools not read: /);
    const pools = rowOf(health, DEPTH_HEALTH.pools)!;
    expect(pools.ok).toBe(false);
    expect(pools.note).toContain('12 of 14 pools read');
    expect(pools.note).toContain('not read: ');
    expect(res.latest!.note).toBe(r[0].note);
    expect(res.latest!.pools.filter((p) => 'error' in p.read)).toHaveLength(2);
  });

  it('the node answering a pool’s tick store with code 18: the gateway fallback reads that pool (two GETs) and its row comes from the gateway at the same figures', async () => {
    const { db, net, health } = await run(seeded(), { failTicks: ['3005'] });
    const paths = net.calls.map((c) => new URL(c.url).pathname);
    expect(paths).toContain('/osmosis/poolmanager/v1beta1/pools/3005');
    expect(paths).toContain('/osmosis/concentratedliquidity/v1beta1/liquidity_per_tick_range');
    const p = rows(db).find((x) => x.pool_id === '3005')!;
    expect(p.note).toBeNull();
    expect(Math.abs(pct(p.sell_1k, 1.01416))).toBeLessThan(0.02);
    expect(rowOf(health, DEPTH_HEALTH.pools)!.ok).toBe(true);
    const latest = kv<DepthResponse>(db, 'depth.latest')!;
    expect((latest.pools.find((x) => x.id === '3005')!.read as any).url).toContain('/osmosis/poolmanager/v1beta1/pools/3005');
  });

  it('the reference pool not read at all: no depth row, the checks idle with the reason, the health row says nothing was written', async () => {
    const { db, health, res } = await run(seeded(), { failTicks: ['3005'], status: (url) => (url.includes('/pools/3005') ? 502 : undefined) });
    expect(res.skipped).toBe('reference pool');
    expect(rows(db)).toHaveLength(0);
    expect(kv(db, 'depth.latest')).toBeNull();
    const c = checks(db);
    expect(c.depth_vs_chain_estimate.status).toBe('idle');
    expect(c.depth_vs_route_quote.status).toBe('idle');
    expect(c.depth_vs_executed.status).toBe('idle');
    expect(rowOf(health, DEPTH_HEALTH.pools)).toMatchObject({ ok: false });
    expect(rowOf(health, DEPTH_HEALTH.pools)!.note).toMatch(/^Reference pool 3005 not read \(.*\): no depth row this minute/);
  });
});

describe('nothing written', () => {
  it('when the tick is late before the phase starts', async () => {
    const { db, net, health, res } = await run(seeded(), {}, { late: () => true });
    expect(res.skipped).toBe('late');
    expect(net.calls).toHaveLength(0);
    expect(rows(db)).toHaveLength(0);
    expect(all(db, "SELECT COUNT(*) n FROM kv WHERE key LIKE 'depth.%' AND key NOT IN ('depth.params', 'depth.book')")[0].n).toBe(0);
    expect(rowOf(health, DEPTH_HEALTH.pools)!.note).toContain('Not run this tick');
  });
  it('when the kill switch kv depth.on is 0: no read, no row, the health row says so', async () => {
    const db = seeded();
    insert(db, 'kv', [{ key: 'depth.on', value: '0', updated_at: T }]);
    const { net, health, res } = await run(db);
    expect(res.skipped).toBe('kill switch');
    expect(net.calls).toHaveLength(0);
    expect(rows(db)).toHaveLength(0);
    expect(all(db, 'SELECT COUNT(*) n FROM checks')[0].n).toBe(0);
    expect(rowOf(health, DEPTH_HEALTH.pools)!.note).toBe('Off by the kill switch (kv depth.on is 0): nothing read, nothing written this minute.');
    expect(rowOf(health, DEPTH_HEALTH.store)!.note).toContain('off by the kill switch');
    // '1' or no row leaves it on
    db.raw.prepare("UPDATE kv SET value = '1' WHERE key = 'depth.on'").run();
    expect((await run(db)).res.skipped).toBeUndefined();
  });
});

describe('the three checks', () => {
  it('check 1: the exact walk of pool 3005 for 1,000 NAM equals the chain’s own estimate, 1,014,160 base units, at one height: ok', async () => {
    const { db } = await run(seeded());
    const c = checks(db).depth_vs_chain_estimate;
    expect(c.status).toBe('ok');
    expect(c.detail).toMatchObject({ pool: '3005', nam: 1000, chainOut: '1014160', ours: '1014160', diffPct: 0, height: REF_HEIGHT, estimateHeight: REF_HEIGHT, okPct: 0.01 });
    expect(c.detail.url).toContain('/estimate/single_pool_swap_exact_amount_in');
    expect(depthFixtureHeader('lcd_pm_estimate_3005.json')[0]).toContain('02:19:22');
  });
  it('check 2: the same walk against the direct quote the price read made (1,014,160 for 1,000 NAM, verify-router.json): ok; idle when the router was not asked', async () => {
    const { db } = await run(seeded());
    expect(checks(db).depth_vs_route_quote).toMatchObject({ status: 'ok', detail: { nam: 1000, routerOut: '1014160', ours: '1014160', diffPct: 0 } });
    const { db: db2 } = await run(seeded(), {}, { routeOut: null });
    expect(checks(db2).depth_vs_route_quote.status).toBe('idle');
    expect(checks(db2).depth_vs_route_quote.detail.note).toContain('not asked a direct quote');
    // a quote off by a percent warns, by ten fails
    const { db: db3 } = await run(seeded(), {}, { routeOut: { nam: 1000, amountOut: '1004000', at: T } });
    expect(checks(db3).depth_vs_route_quote.status).toBe('fail');
    const { db: db4 } = await run(seeded(), {}, { routeOut: { nam: 1000, amountOut: '1013000', at: T } });
    expect(checks(db4).depth_vs_route_quote.status).toBe('warn');
  });

  it('check 3: the stored swaps of the last two minutes walked on the states of the minute before each; a book leg is left out with the reason; idle with no trade', async () => {
    const first = await run(seeded());
    expect(checks(first.db).depth_vs_executed.status).toBe('idle');
    const states = kv<DepthStates>(first.db, 'depth.states')!;
    // what the stored state says a 1,000 NAM sale through pool 3005 alone fetches, and what 2 USDC buys through 3005 and 3368
    const priced = (ids: string[]): PricedPool[] => ids.map((id) => { const s = states.pools.find((p) => p.id === id)!; return { id, type: s.type, model: modelOfState(cfg, s)!, counterUsd: s.counterUsd, counterDecimals: s.counterDecimals, taker: s.taker }; });
    const one = priced(['3005']);
    const sale = executeSell(aggregate(one, buildGrid(states.ref.usd), 6), one, 1000);
    expect(Math.abs(pct(sale.usd, 1.01416))).toBeLessThan(0.02);
    const two = priced(['3005', '3368']);
    const buy = executeBuyUsd(aggregate(two, buildGrid(states.ref.usd), 6), two, 2);
    expect(buy.complete).toBe(true);
    const ts = states.at + 20_000;
    const flow = (id: string, kind: 'buy' | 'sell', poolId: string, settle: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
      id: `osmosis:${id}:0`, chain: 'osmosis', height: 73429300, ts, tx_hash: id, kind, from_addr: 'osmo1test', to_addr: null, amount_num: 1, counter_denom: 'USDC', counter_amount: 1, pool_id: poolId, price_usd: null, value_usd: null, meta: JSON.stringify({ settle, ...extra }),
    });
    insert(first.db, 'flows', [
      flow('AAAA01', 'sell', '3005', { nam: -1000, coins: { USDC: sale.usd } }),                                   // on the curve: 0 %
      flow('AAAA02', 'sell', '3005', { nam: -1000, coins: { USDC: sale.usd * 1.02 } }),                            // 2 % better than the curve: warn
      flow('AAAA03', 'buy', '3005,3368', { nam: buy.nam, coins: { USDC: -1, OSMO: -(1 / 0.05) }, rates: { OSMO: 0.05 } }), // paid half in OSMO at the transaction's own rate
      flow('AAAA04', 'buy', '3005,3008', { nam: 500, coins: { USDC: -0.5 } }),                                     // a book leg: left out
      flow('AAAA05', 'sell', '3005', { nam: -10, coins: { TIA: 1 } }),                                             // a coin with no rate: left out
      { ...flow('AAAA06', 'sell', '3005', { nam: -10, coins: { USDC: 0.01 } }), meta: null },                      // no settle: left out
    ]);
    const second = await run(first.db, {}, {}, T + 60_000);
    const c = checks(second.db).depth_vs_executed;
    expect(c.status).toBe('warn');
    expect(c.detail.n).toBe(3);
    expect(c.detail.within1pct).toBe(2);
    const byId = Object.fromEntries((c.detail.trades as Realised[]).map((t) => [t.id, t]));
    expect(Math.abs(byId['osmosis:AAAA01:0'].diffPct)).toBeLessThan(1e-6);
    expect(byId['osmosis:AAAA02:0'].diffPct).toBeCloseTo(-1.9608, 3); // 1 / 1.02 - 1
    expect(byId['osmosis:AAAA03:0']).toMatchObject({ kind: 'buy', route: ['3005', '3368'], minute: MINUTE });
    expect(Math.abs(byId['osmosis:AAAA03:0'].diffPct)).toBeLessThan(1e-6);
    const leftOut = Object.fromEntries((c.detail.leftOut as { id: string; why: string }[]).map((x) => [x.id, x.why]));
    expect(leftOut['osmosis:AAAA04:0']).toBe(BOOK_LEG_LEFT_OUT);
    expect(leftOut['osmosis:AAAA05:0']).toContain('no rate for TIA');
    expect(leftOut['osmosis:AAAA06:0']).toContain('no settle record');
    expect(kv<Realised[]>(second.db, 'depth.realised')).toHaveLength(3);
    expect(second.res.latest!.checks.realised).toEqual({ n: 3, within1pct: 2, lastAt: ts });
    // the third minute keeps the comparisons (each trade compared once, on the state read before it) and does not compare them again
    const third = await run(second.db, {}, {}, T + 120_000);
    expect(checks(third.db).depth_vs_executed.detail.n).toBe(3);
    expect(kv<Realised[]>(third.db, 'depth.realised')!.map((r) => r.id).sort()).toEqual(['osmosis:AAAA01:0', 'osmosis:AAAA02:0', 'osmosis:AAAA03:0']);
  });

  it('executedCheck fails past 3 %, warns between 1 and 3, is ok under 1, and keeps the newest twenty', () => {
    const states: DepthStates = { minute: MINUTE, at: T, ref: { pool: '3005', usd: 0.001, height: 1 }, pools: [] };
    const kept: Realised[] = Array.from({ length: 25 }, (_, i) => ({ id: `k${i}`, kind: 'sell', at: T - i * 1000, nam: 1, predicted: 1, settle: 1, diffPct: i === 0 ? 3.5 : 0.1, route: ['3005'], minute: MINUTE }));
    const r = executedCheck(cfg, [], [states], kept, T);
    expect(r.stmt.params[1]).toBe('fail');
    expect((r.stmt.params[0])).toBe('depth_vs_executed');
    const detail = JSON.parse(r.stmt.params[3] as string);
    expect(detail.n).toBe(20);
    expect(r.kept).toHaveLength(25);
    const warn = executedCheck(cfg, [], [states], kept.map((k) => ({ ...k, diffPct: k.id === 'k0' ? 2 : 0.1 })), T);
    expect(warn.stmt.params[1]).toBe('warn');
    const ok = executedCheck(cfg, [], [states], kept.map((k) => ({ ...k, diffPct: 0.9 })), T);
    expect(ok.stmt.params[1]).toBe('ok');
    // a day old: idle
    expect(executedCheck(cfg, [], [states], kept.map((k) => ({ ...k, at: T - 86_400_001 })), T).stmt.params[1]).toBe('idle');
  });
});

describe('the retention delete (C5)', () => {
  it('removes at most the limit of rows older than the window, oldest first by the primary key', async () => {
    const db = seeded();
    insert(db, 'depth_minute', Array.from({ length: 12 }, (_, i) => ({ minute: MINUTE - (12 - i) * 86_400_000, pool_id: 'all', at: T, ref_usd: 0.001 })));
    const s = deleteOldMinutesStmt(MINUTE - 5 * 86_400_000, 4);
    expect(db.raw.prepare(s.sql).run(...s.params).changes).toBe(4);
    expect(all(db, 'SELECT COUNT(*) n FROM depth_minute WHERE minute < ?', MINUTE - 5 * 86_400_000)[0].n).toBe(3);
  });
});

describe('the pool list rule', () => {
  it('on the quote service’s list of 28 pools: 16 hold enough to read (15 priced, 3020 unpriced), 2 are empty on both sides and 10 are dust', async () => {
    const { res } = await run(seeded());
    const why = Object.fromEntries(res.latest!.unpriced.map((u) => [u.id, u.why]));
    expect(Object.keys(why)).toHaveLength(13);
    expect(Object.values(why).filter((w) => w === UNPRICED_EMPTY)).toHaveLength(2);
    expect(Object.values(why).filter((w) => w === UNPRICED_DUST)).toHaveLength(10);
    expect(why['3016']).toBe(UNPRICED_EMPTY);
    expect(why['3021']).toBe(UNPRICED_EMPTY);
    expect(res.latest!.pools.map((p) => p.id).sort()).toEqual([...LATEST.pricedIds].sort());
    expect(res.latest!.pools.find((p) => p.id === '3005')!.pair).toBe('NAM / USDC');
    expect(res.latest!.pools.find((p) => p.id === '3052')!.counterSymbol).toBe('stOSMO');
    expect(SQS_POOLS).toHaveLength(28);
    expect(NAM_DENOM).toBe(cfg.base.denom);
  });
});
