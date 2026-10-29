// The depth hourly job (worker/src/depth/index.ts hourly, plan 1.3, 1.5 depth_hourly, 1.6, 1.7 and section 5's owners
// row) on the research's saved answers of 2026-10-29 (test/depth-minute-net.ts says which fixture answers which read;
// none reaches the network): the owners read (pool 3005's 19 real positions and the other pools' positions built from
// their saved ranges, the book's 43 orders over 34 ticks), the three invariants held and one broken, kv depth.owners
// grouped by owner, kv depth.params with the pools' own objects and their read times, the archive (a stub bucket: one
// gzipped object per live pool and one with the positions, under the cap, nothing without the binding), the rollup row
// of the closed hour (the last minute plus the extremes and the count), the retention delete's limit, the change rows
// of the hour after (a position withdrawn, an order filled in part, each with its owner), and the gates (the window, a
// listing tick, the closing stretch that skips the book, a late tick, the kill switch, the caps, the once-an-hour marker),
// and the review of 2026-10-29's findings: a tick total printed as a decimal compared and never thrown on, the hour's
// writes after the minute's on counters read again, kv depth.owners cut to its cap with the note, the rollup marker
// left alone by an hour at the cap so the closed hours catch up.
import { describe, it, expect, vi } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { testD1, d1Json, insert, runStmts, type TestD1 } from './d1-sqlite';
import { minute, hourly, hoursToRoll, inRangeCheck, tickStoreCheck, bookTotalsCheck, fitOwners, DEPTH_HEALTH, HOURLY_WINDOW, type DepthOwnersKv, type HourlyCtx, type MinuteCtx, type DepthStates } from '../worker/src/depth/index';
import { JOB_WINDOW_MS, JOB_CLOSING_MS, hoursToRoll as seriesHoursToRoll } from '../worker/src/series';
import { NAM_DEPTH, type DepthConfig } from '../worker/src/depth/config';
import { freshBudget } from '../worker/src/depth/budget';
import { HOURLY_ROLLUP_SQL, hourlyStmt, deleteOldMinutesStmts, type DepthHourlyRow } from '../worker/src/depth/sql';
import { archiveKey } from '../worker/src/depth/archive';
import { rangesFromTicks } from '../worker/src/depth/model';
import { decodeTickInfos } from '../worker/src/depth/proto';
import { INVARIANT_WORDS, OWNERS_NO_ARCHIVE, BOOK_NOT_READ_CLOSING, OWNERS_NO_MINUTE, type DepthChangeRow } from '../shared/depth';
import type { SourceHealth } from '../shared/types';
import { depthNetwork, bookKvFromFixture, paramsKvFromFixture, clStates, tickStoreValue, positionsOf, SQS_POOLS, BOOK, POSITIONS_3005, REF_HEIGHT, INVARIANT_CHAIN_BACKED_POOLS, type NetOptions, type ClState } from './depth-minute-net';
import { depthFixture, depthFixtureHeader } from './depth-fixtures';

const cfg = NAM_DEPTH;
const MIN = 60_000, H = 3_600_000;
/** The two minutes before the hour: 02:56:30 and 02:57:30 UTC on 29 Oct 2026, then the hour's first tick at 03:05:00. */
const T1 = Date.UTC(2026, 9, 29, 2, 56, 30);
const T2 = T1 + MIN;
const TH = Date.UTC(2026, 9, 29, 3, 5, 0);
const HOUR_CLOSED = Date.UTC(2026, 9, 29, 2, 0, 0);
const all = (db: TestD1, sql: string, ...p: unknown[]) => db.raw.prepare(sql).all(...p).map((r: any) => ({ ...r }));
const kv = <T = any>(db: TestD1, key: string): T | null => { const r = all(db, 'SELECT value FROM kv WHERE key = ?', key)[0]; return r ? JSON.parse(r.value) : null; };
const rowOf = (h: SourceHealth[], name: string) => h.filter((x) => x.name === name).pop();
const count = (db: TestD1, sql: string, ...p: unknown[]) => all(db, sql, ...p)[0].n as number;

/** The second minute's reading: pool 3368's last range withdrawn (a position event the minute diff records). */
const withdraw3368 = (st: Record<string, ClState>) => { st['3368'].ranges = st['3368'].ranges.slice(0, -1); };
/** The positions the hour reads: the real 19 of pool 3005 and one per saved range for the rest. */
const positionCount = (opts: NetOptions = {}) => { const st = clStates(); opts.mutate?.(st); return Object.values(positionsOf(st)).reduce((n, list) => n + list.length, 0); };
const ORDERS: number = BOOK.orders.length;
const LIVE_TICKS: number = BOOK.live_ticks.length;
const LIVE_GAMM = SQS_POOLS.filter((p: any) => p.type === 0 || p.type === 1).length;

interface Bucket { puts: { key: string; bytes: Uint8Array; opts: any }[]; put: (key: string, value: ArrayBuffer, opts: any) => Promise<unknown> }
const bucket = (): Bucket => { const b: Bucket = { puts: [], put: async (key, value, opts) => { b.puts.push({ key, bytes: new Uint8Array(value), opts }); return { key }; } }; return b; };
const unzip = (b: Uint8Array) => JSON.parse(gunzipSync(b).toString('utf8'));

/** Two steady minutes written (the second with pool 3368's last range withdrawn), as the hour finds the store. */
async function twoMinutes(db: TestD1 = testD1()) {
  insert(db, 'kv', [
    { key: 'depth.params', value: JSON.stringify(paramsKvFromFixture(T1 - MIN)), updated_at: T1 - MIN },
    { key: 'depth.book', value: JSON.stringify(bookKvFromFixture(T1 - MIN)), updated_at: T1 - MIN },
  ]);
  const run = async (now: number, net: NetOptions) => {
    const n = depthNetwork(net);
    let clock = now;
    const health: SourceHealth[] = [];
    return minute({ DB: db } as any, now, { health, fetch: n.fetch, clock: () => (clock += 100), pools: SQS_POOLS, poolsAt: now - 1500 } satisfies MinuteCtx);
  };
  const m1 = await run(T1, {});
  const m2 = await run(T2, { mutate: withdraw3368 });
  expect(m1.written && m2.written).toBe(true);
  return db;
}
async function runHour(db: TestD1, net: NetOptions = { mutate: withdraw3368 }, ctx: Partial<HourlyCtx> = {}, now = TH, r2: Bucket | null = bucket()) {
  const n = depthNetwork(net);
  const health: SourceHealth[] = [];
  let clock = now;
  const res = await hourly({ DB: db, ...(r2 ? { DEPTH_R2: r2 } : {}) } as any, now, { health, fetch: n.fetch, clock: () => (clock += 100), ...ctx });
  return { res, health, net: n, db, r2 };
}

describe('the owners read of a steady hour', () => {
  it('reads the positions in batches, the pools’ own objects, the parameters, the gateway’s ranges and the whole book: under the cap of sixty requests', async () => {
    const db = await twoMinutes();
    const { res, net, health } = await runHour(db);
    expect(res.skipped).toBeUndefined();
    const P = positionCount({ mutate: withdraw3368 });
    expect(res.positions).toBe(P);
    expect(res.orders).toBe(ORDERS);
    const posts = net.calls.filter((c) => c.method === 'POST');
    const paths = net.calls.filter((c) => c.method !== 'POST').map((c) => new URL(c.url).pathname);
    // the index of seven pools, their pool states and the reference pool's tick store: fifteen queries, ten a body; then the positions ten a body
    expect(posts).toHaveLength(2 + Math.ceil(P / 10));
    expect(JSON.parse(posts[0].body!)).toHaveLength(10);
    expect(paths.filter((p) => p.startsWith('/osmosis/gamm/v1beta1/pools/'))).toHaveLength(LIVE_GAMM);
    expect(paths.filter((p) => p === '/osmosis/concentratedliquidity/v1beta1/params')).toHaveLength(1);
    expect(paths.filter((p) => p === '/osmosis/concentratedliquidity/v1beta1/liquidity_per_tick_range')).toHaveLength(1);
    expect(paths.filter((p) => p.includes('/smart/'))).toHaveLength(1 + 1 + LIVE_TICKS); // the state, one page of ticks (34 live of 34 given), the orders of every live tick
    expect(res.requests).toBe(net.calls.length);
    expect(res.requests).toBeLessThanOrEqual(cfg.caps.hourlyRequests);
    expect(res.bytes).toBeGreaterThan(0);
    const owners = rowOf(health, DEPTH_HEALTH.owners)!;
    expect(owners.ok).toBe(true);
    expect(owners.note).toMatch(new RegExp(`^${P} positions in 7 of 7 pools at height ${REF_HEIGHT}, ${ORDERS} orders; 3 of 3 invariants held; ${res.requests} requests, \\d+ bytes; 16 archived$`));
    expect(rowOf(health, DEPTH_HEALTH.store)!.note).toContain('16 archive puts');
    // '7 pools' is what the job compared, not seven independent checks: on these fixtures only pool 3005 has the chain's own positions and
    // current_tick_liquidity (the header of test/depth-minute-net.ts); the six others hold by construction, so the invariant is tested
    // on 3005 alone, here and by the position dropped from its index below
    expect(INVARIANT_CHAIN_BACKED_POOLS).toEqual(['3005']);
    expect(kv<DepthOwnersKv>(db, 'depth.owners')!.positions.pools).toContain('3005');
  });

  it('kv depth.owners: every position and order grouped by owner, largest first, each item with its range, amounts, time and the chain’s own figure', async () => {
    const db = await twoMinutes();
    const { res } = await runHour(db);
    const o = kv<DepthOwnersKv>(db, 'depth.owners')!;
    expect(o.hour).toBe(TH - 5 * MIN);
    expect(o.height).toBe(REF_HEIGHT);
    expect(o.totals).toMatchObject({ positions: res.positions, orders: ORDERS });
    expect(o.positions).toMatchObject({ read: true, height: REF_HEIGHT });
    expect(o.positions.pools.sort()).toEqual(['3005', '3009', '3015', '3017', '3052', '3368', '3405']);
    expect(o.orders).toMatchObject({ read: true, height: REF_HEIGHT });
    expect(o.owners.length).toBeGreaterThan(10);
    expect(o.owners.map((x) => x.usd)).toEqual([...o.owners.map((x) => x.usd)].sort((a, b) => b - a));
    expect(Math.abs(o.owners.reduce((a, x) => a + x.share, 0) - 1)).toBeLessThan(1e-9);
    // the position the research checked by hand (chain.txt): 26,026,594,582 uNAM and 17,665,537 uUSDC in range
    const fixture = POSITIONS_3005.find((p: any) => p.position_id === '15392963');
    const owner = o.owners.find((x) => x.address === fixture.address)!;
    const item = owner.items.find((i) => i.id === '15392963')!;
    expect(owner.short).toBe(fixture.address); // the fixture's addresses are already short (anonymized by the research)
    expect(item).toMatchObject({ pool: '3005', kind: 'position', inRange: true, liquidity: '6353092755.962217234850521312' });
    expect(item.nam).toBeCloseTo(26026.594582, 6);
    expect(item.usd).toBeCloseTo(17.665537, 6);
    expect(item.loUsd).toBeCloseTo(0.00085, 10);
    expect(item.hiUsd).toBeCloseTo(0.00135, 10);
    expect(item.since).toBe(Number(fixture.join_time_unix) * 1000);
    expect(item.side).toBeUndefined();
    // a position above the price holds the base coin only: an ask
    const above = o.owners.flatMap((x) => x.items).find((i) => i.id === '15148276')!;
    expect(above).toMatchObject({ side: 'ask', inRange: false, usd: 0 });
    expect(above.nam).toBeCloseTo(61757, 3);
    // the book's owners: the two bidders and the eight askers of 2026-10-29, each order at its tick's price
    const bidder = o.owners.find((x) => x.address === 'owner#1')!;
    expect(bidder.orders).toBeGreaterThanOrEqual(2);
    const bid = bidder.items.find((i) => i.id === '996')!;
    expect(bid).toMatchObject({ pool: '3008', kind: 'order', side: 'bid', quantity: '25000000', remaining: 25, placed: 25, loUsd: 0.0001, hiUsd: 0.0001, usd: 25 });
    expect(bid.nam).toBeCloseTo(250000, 6);
    expect(bid.since).toBe(Math.floor(1793028216842887999 / 1e6));
    const ask = o.owners.flatMap((x) => x.items).find((i) => i.id === '993')!;
    expect(ask).toMatchObject({ side: 'ask', quantity: '200000000000', nam: 200000, loUsd: 0.00125 });
    expect(ask.usd).toBeCloseTo(250, 9);
    expect(o.invariants.inRange.ok && o.invariants.tickStore.ok && o.invariants.bookTotals.ok).toBe(true);
    expect(o.invariants.inRange.note).toContain(INVARIANT_WORDS.inRange);
    expect(o.invariants.tickStore.note).toBe(`${INVARIANT_WORDS.tickStore} (31 ranges)`);
    expect(o.invariants.bookTotals.note).toBe(`${INVARIANT_WORDS.bookTotals} (${LIVE_TICKS} ticks)`);
    expect(o.prov.length).toBe(res.requests);
    expect(o.notes).toEqual([]);
    expect(JSON.stringify(o).length).toBeLessThan(200_000);
  });

  it('kv depth.params keeps what governance alone changes with its read time: each weighted and stable pool’s own object and the concentrated-liquidity parameters', async () => {
    const db = await twoMinutes();
    await runHour(db);
    const p = kv(db, 'depth.params')!;
    expect(Object.keys(p.gamm).sort()).toEqual(['3007', '3062', '3367', '3398', '3402', '3439', '3454']);
    expect(p.gamm['3439']).toMatchObject({ pool: { pool_params: { swap_fee: '0.010000000000000000' } }, height: REF_HEIGHT });
    expect(p.gamm['3439'].url).toBe(`${cfg.hosts.rest}/osmosis/gamm/v1beta1/pools/3439`);
    expect(p.gamm['3439'].at).toBeGreaterThan(TH);
    expect(depthFixtureHeader('lcd_gamm_pool_3439.json')[0]).toContain('2026-10-29T02:13');
    expect(p.gamm['3398'].pool.scaling_factors).toEqual(['1', '1']);
    expect(p.clParams.value.authorized_tick_spacing).toEqual(['1', '10', '100', '1000']);
    expect(p.clParams.url).toContain('/concentratedliquidity/v1beta1/params');
    // the minute's own parameters stay
    expect(Object.keys(p.taker).length).toBeGreaterThan(0);
    expect(p.tokensAt).toBe(T1 - MIN);
  });

  it('the archive: one gzipped object per live pool and one with the positions and orders, under the keys of plan 1.6, counted in the budget', async () => {
    const db = await twoMinutes();
    const { res, r2 } = await runHour(db);
    expect(res.archived).toBe(16);
    expect(r2!.puts.map((p) => p.key).sort()).toEqual([...kv<any>(db, 'depth.states')!.pools.map((p: any) => archiveKey(p.id, TH - 5 * MIN)), archiveKey(null, TH - 5 * MIN)].sort());
    expect(archiveKey('3005', TH)).toBe('depth/raw/3005/2026/10/29/03.json.gz');
    expect(archiveKey(null, TH)).toBe('depth/positions/2026/10/29/03.json.gz');
    for (const p of r2!.puts) {
      expect([p.bytes[0], p.bytes[1]]).toEqual([0x1f, 0x8b]);
      expect(p.bytes.byteLength).toBeLessThan(cfg.caps.r2ObjectMax);
      expect(p.opts).toEqual({ httpMetadata: { contentType: 'application/json', contentEncoding: 'gzip' } });
    }
    const raw = unzip(r2!.puts.find((p) => p.key === archiveKey('3005', TH - 5 * MIN))!.bytes);
    expect(raw).toMatchObject({ pool: '3005', type: 'concentrated', height: REF_HEIGHT });
    expect(raw.cl.ranges).toHaveLength(31);
    expect(raw.cl.positions).toHaveLength(19);
    expect(raw.cl.state.wire.current_tick_liquidity).toBe('12182537984.214367314128069678');
    expect(raw.read.url).toBe(`${cfg.hosts.rpc}/`);
    const book = unzip(r2!.puts.find((p) => p.key === archiveKey('3008', TH - 5 * MIN))!.bytes);
    expect(book.book.ticks).toHaveLength(LIVE_TICKS);
    expect(Object.keys(book.book.orders)).toHaveLength(LIVE_TICKS);
    const positions = unzip(r2!.puts.find((p) => p.key === archiveKey(null, TH - 5 * MIN))!.bytes);
    expect(positions.positions).toHaveLength(res.positions);
    expect(positions.orders[0].pool).toBe('3008');
    expect(kv(db, 'depth.budget')).toMatchObject({ r2Puts: 16, r2Bytes: r2!.puts.reduce((a, p) => a + p.bytes.byteLength, 0) });
  });

  it('without the bucket binding nothing is archived and the row says so; an object over the cap is not written and named', async () => {
    const db = await twoMinutes();
    const { res, health } = await runHour(db, { mutate: withdraw3368 }, {}, TH, null);
    expect(res.archived).toBe(0);
    expect(res.archive).toEqual([]);
    expect(rowOf(health, DEPTH_HEALTH.owners)!.note).toMatch(/; not archived \(no bucket bound\)$/);
    expect(kv<DepthOwnersKv>(db, 'depth.owners')!.notes).toEqual([OWNERS_NO_ARCHIVE]);
    const db2 = await twoMinutes();
    const small: DepthConfig = { ...cfg, caps: { ...cfg.caps, r2ObjectMax: 400 } };
    const { res: r2res, r2 } = await runHour(db2, { mutate: withdraw3368 }, { cfg: small });
    expect(r2res.archived).toBeLessThan(16);
    expect(r2!.puts.every((p) => p.bytes.byteLength <= 400)).toBe(true);
    const skipped = r2res.archive.filter((a) => 'skipped' in a) as { key: string; skipped: string }[];
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped[0].skipped).toMatch(/^\d+ bytes, over the cap of 400: not written$/);
    expect(kv<DepthOwnersKv>(db2, 'depth.owners')!.notes.some((n) => n.startsWith('archive depth/'))).toBe(true);
  });
});

describe('the invariants', () => {
  it('a position missing from the index: the in-range liquidity no longer adds up, the owners row is not ok with the figures, console.error is called, nothing throws and the rest is written', async () => {
    const db = await twoMinutes();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { res, health } = await runHour(db, { mutate: withdraw3368, dropPositions: ['15392963'] });
      expect(res.skipped).toBeUndefined();
      expect(res.invariants!.inRange.ok).toBe(false);
      expect(res.invariants!.inRange.note).toMatch(/^not held for 3005: 7 in range sum \d+, the pool says 12182537984214367314128069678$/);
      expect(res.invariants!.tickStore.ok).toBe(true);
      expect(res.invariants!.bookTotals.ok).toBe(true);
      expect(err).toHaveBeenCalledWith('depth owners: in-range liquidity', expect.stringContaining('3005: 7 in range'));
      const row = rowOf(health, DEPTH_HEALTH.owners)!;
      expect(row.ok).toBe(false);
      expect(row.note).toContain('not held for 3005');
      expect(res.written).toBe(true);
      expect(kv<DepthOwnersKv>(db, 'depth.owners')!.invariants.inRange.ok).toBe(false);
      expect(count(db, 'SELECT COUNT(*) n FROM depth_hourly')).toBeGreaterThan(0);
    } finally { err.mockRestore(); }
  });

  it('the three checks on their own: the 19 positions against the pool, the tick store against the gateway, the ticks against their orders', () => {
    const pool = depthFixture<{ pool: any }>('verify-pool3005-now.json').pool;
    const positions = POSITIONS_3005.map((p: any) => ({ lower_tick: Number(p.lower_tick), upper_tick: Number(p.upper_tick), liquidity: `${p.liquidity.slice(0, -18)}.${p.liquidity.slice(-18)}` }));
    const c1 = inRangeCheck(positions, Number(pool.current_tick), pool.current_tick_liquidity);
    expect(c1).toMatchObject({ ok: true, n: 8, chain: '12182537984214367314128069678' });
    expect(inRangeCheck(positions.slice(1), Number(pool.current_tick), pool.current_tick_liquidity).ok).toBe(false);
    const st = clStates()['3005'];
    const walked = rangesFromTicks(decodeTickInfos(tickStoreValue('3005', st.ranges)));
    const served = depthFixture<{ liquidity: any[] }>('lcd_cl_liq_per_tick_3005.json').liquidity;
    expect(tickStoreCheck(walked, served)).toEqual({ ok: true, walked: 31, gateway: 31, firstDiff: null });
    expect(tickStoreCheck(walked.slice(1), served).firstDiff).toBe('30 ranges walked, 31 served');
    expect(tickStoreCheck(walked.map((r, i) => (i === 3 ? { ...r, liquidity_amount: '1' } : r)), served).firstDiff).toMatch(/^range 3: walked /);
    const ticks = BOOK.live_ticks.map((t: any) => ({ tick_id: t.tick_id, tick_state: { bid_values: { total_amount_of_liquidity: t.bid_liq }, ask_values: { total_amount_of_liquidity: t.ask_liq } } }));
    const orders = Object.fromEntries(BOOK.live_ticks.map((t: any) => [String(t.tick_id), { value: BOOK.orders.filter((o: any) => o.tick_id === t.tick_id).map((o: any) => ({ ...o, order_direction: o.side })), url: '', at: 0, height: null, bytes: 0, ms: 0, status: 200 }]));
    expect(bookTotalsCheck(ticks, orders as any)).toEqual({ ok: true, compared: LIVE_TICKS, notRead: 0, firstDiff: null });
    const { ['-36000000']: _, ...rest } = orders;
    expect(bookTotalsCheck(ticks, rest as any)).toMatchObject({ ok: true, compared: LIVE_TICKS - 1, notRead: 1 });
    expect(bookTotalsCheck(ticks, { ...orders, '-36000000': { ...orders['-36000000'], value: [] } } as any).firstDiff).toBe('tick -36000000 bid: total 25000000, orders 0');
  });

  it('a tick total printed as a decimal (the contract’s totals are decimal fields) is compared at 18 places and never thrown on: a fraction is a difference with the figures, a whole number with places holds', async () => {
    const at = (tick: number, side: string, total: string) => ({ tick_id: tick, tick_state: { bid_values: { total_amount_of_liquidity: side === 'bid' ? total : '0' }, ask_values: { total_amount_of_liquidity: side === 'ask' ? total : '0' } } });
    const bid = (q: string) => ({ '-36000000': { value: [{ order_id: 996, order_direction: 'bid', quantity: q }], url: '', at: 0, height: null, bytes: 0, ms: 0, status: 200 } });
    expect(() => bookTotalsCheck([at(-36000000, 'bid', '25000000.5')] as any, bid('25000000') as any)).not.toThrow();
    expect(bookTotalsCheck([at(-36000000, 'bid', '25000000.5')] as any, bid('25000000') as any).firstDiff).toBe('tick -36000000 bid: total 25000000.5, orders 25000000');
    expect(bookTotalsCheck([at(-36000000, 'bid', '25000000.000000000000000000')] as any, bid('25000000') as any)).toMatchObject({ ok: true, compared: 1 });
    expect(bookTotalsCheck([at(-36000000, 'bid', '25000000')] as any, bid('2.5e7') as any).firstDiff).toBe('tick -36000000 bid: order 996 quantity 2.5e7 is not a number');
    // through the hour: a half base unit on one tick's bid total is not held, the owners row says the figures, console.error is called, the rest is written
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const db = await twoMinutes();
      const { res, health } = await runHour(db, { mutate: withdraw3368, tickTotal: (tick, side, total) => (tick === -36000000 && side === 'bid' ? `${total}.5` : total) });
      expect(res.skipped).toBeUndefined();
      expect(res.written).toBe(true);
      expect(res.invariants!.bookTotals).toEqual({ ok: false, note: 'not held for 3008: tick -36000000 bid: total 25000000.5, orders 25000000' });
      expect(err).toHaveBeenCalledWith('depth owners: book totals', expect.stringContaining('25000000.5'));
      expect(rowOf(health, DEPTH_HEALTH.owners)).toMatchObject({ ok: false });
      expect(res.orders).toBe(ORDERS);
      // every total with eighteen places, as a decimal field prints a whole number: held
      const db2 = await twoMinutes();
      const whole = await runHour(db2, { mutate: withdraw3368, tickTotal: (_t, _s, total) => (total === '0' ? total : `${total}.000000000000000000`) });
      expect(whole.res.invariants!.bookTotals).toEqual({ ok: true, note: `${INVARIANT_WORDS.bookTotals} (${LIVE_TICKS} ticks)` });
      expect(err).toHaveBeenCalledTimes(1);
    } finally { err.mockRestore(); }
  });
});

describe('the writes beside the minute', () => {
  it('the hour’s writes wait for the minute of the same tick and go on kv depth.budget and depth.params read again: the minute’s rows are counted and its taker fees kept, the hour’s pool objects added', async () => {
    const db = await twoMinutes();
    // the taker fees are two hours old, so the minute at 03:05 reads three of them anew and writes depth.params in the same tick as the hour
    const stale = paramsKvFromFixture(TH - 2 * H);
    db.raw.prepare("UPDATE kv SET value = ? WHERE key = 'depth.params'").run(JSON.stringify({ ...stale, tokensAt: T1 - MIN }));
    const budgetBefore = kv<any>(db, 'depth.budget')!.rowsWritten as number;
    const n = depthNetwork({ mutate: withdraw3368 });
    let clock = TH;
    const minuteRun = minute({ DB: db } as any, TH, { health: [], fetch: n.fetch, clock: () => (clock += 100), pools: SQS_POOLS, poolsAt: TH - 1500 } satisfies MinuteCtx);
    const { res } = await runHour(db, { mutate: withdraw3368 }, { writeAfter: minuteRun });
    const m = await minuteRun;
    expect(m.written && res.written).toBe(true);
    const b = kv<any>(db, 'depth.budget')!;
    // the counter holds both jobs' rows: the minute's on top of the two before, the hour's (its seventeen rollup rows, kv depth.owners, depth.params, the two markers, its budget row) on top of the minute's
    expect(m.budget.rowsWritten).toBeGreaterThan(budgetBefore);
    expect(b.rowsWritten).toBe(res.budget.rowsWritten);
    expect(res.budget.rowsWritten).toBeGreaterThanOrEqual(m.budget.rowsWritten + res.hourlyRows + 5);
    expect(b.bytesIn).toBe(m.budget.bytesIn + res.bytes);
    expect(b.r2Puts).toBe(res.archived);
    const p = kv<any>(db, 'depth.params')!;
    const refreshed = Object.values<any>(p.taker).filter((t) => t.at >= TH);
    expect(refreshed).toHaveLength(cfg.read.takerReadsPerMinute);
    expect(Object.keys(p.gamm)).toHaveLength(LIVE_GAMM);
    expect(p.clParams.at).toBeGreaterThan(TH);
    expect(p.tokensAt).toBe(T1 - MIN);
  });

  it('kv depth.owners over its cap: the smallest owners’ items are left out until it fits, their totals and counts stay, the note goes first in the row and in the owners health row', async () => {
    const db = await twoMinutes();
    // the steady row is about 44 KB on these fixtures (14 KB of it the provenance list, 19 KB the items of 50 owners): a cap of 35 KB leaves the largest half their items
    const small: DepthConfig = { ...cfg, caps: { ...cfg.caps, ownersKvMax: 35_000 } };
    const { res, health } = await runHour(db, { mutate: withdraw3368 }, { cfg: small });
    expect(res.written).toBe(true);
    const row = all(db, 'SELECT value FROM kv WHERE key = ?', 'depth.owners')[0].value as string;
    expect(row.length).toBeLessThanOrEqual(35_000);
    const o = JSON.parse(row) as DepthOwnersKv;
    const full = await runHour(await twoMinutes(), { mutate: withdraw3368 });
    const whole = kv<DepthOwnersKv>(full.db, 'depth.owners')!;
    expect(o.owners).toHaveLength(whole.owners.length);
    expect(o.totals).toEqual(whole.totals);
    expect(o.owners.map((x) => [x.address, x.positions, x.orders, x.usd])).toEqual(whole.owners.map((x) => [x.address, x.positions, x.orders, x.usd]));
    const kept = o.owners.filter((x) => x.items.length > 0).length, cut = o.owners.length - kept;
    expect(kept).toBeGreaterThan(0);
    expect(cut).toBeGreaterThan(0);
    expect(o.owners.slice(0, kept).every((x) => x.items.length > 0)).toBe(true); // the largest keep their items
    expect(o.notes[0]).toBe(`kv depth.owners would be ${JSON.stringify({ ...whole, notes: [] }).length} bytes, over the cap of 35000: the items of ${cut} of ${o.owners.length} owners are left out (their totals and counts are kept)`);
    const h = rowOf(health, DEPTH_HEALTH.owners)!;
    expect(h.ok).toBe(false);
    expect(h.note).toContain(`kv depth.owners over its cap: the items of ${cut} of ${o.owners.length} owners left out`);
    // the steady row is under the plan's cap with every item
    expect(JSON.stringify(whole).length).toBeLessThan(cfg.caps.ownersKvMax);
    expect(cfg.caps.ownersKvMax).toBe(200_000);
    // on its own: a row that fits is unchanged with the notes in place; one that cannot fit even with no items loses its provenance list too
    const tiny: DepthOwnersKv = { ...whole, notes: [] };
    expect(fitOwners(tiny, ['a note'], 10_000_000)).toEqual({ text: JSON.stringify({ ...whole, notes: ['a note'] }), note: null, short: null });
    const r = fitOwners({ ...whole, notes: [] }, [], 3_000);
    expect(r.note).toMatch(/owners are left out \(their totals and counts are kept\); the provenance list is cut to ten reads$/);
    expect(JSON.parse(r.text).prov).toHaveLength(10);
  });
});

describe('the rollup, the retention delete and the change rows', () => {
  it('depth_hourly gets the closed hour’s last minute per pool with the extremes and the count; the statement is two primary-key searches', async () => {
    const db = await twoMinutes();
    const { res } = await runHour(db);
    expect(res.rolled).toEqual([HOUR_CLOSED]);
    const rows = all(db, 'SELECT * FROM depth_hourly WHERE hour = ? ORDER BY pool_id', HOUR_CLOSED);
    expect(rows).toHaveLength(17);
    expect(res.hourlyRows).toBe(17);
    const a = rows.find((r) => r.pool_id === 'all')!;
    const last = all(db, 'SELECT * FROM depth_minute WHERE pool_id = ? AND minute = ?', 'all', Math.floor(T2 / MIN) * MIN)[0];
    expect(a.n).toBe(2);
    expect(a.at).toBe(last.at);
    expect(a.sell_10k).toBe(last.sell_10k);
    expect(a.ref_usd).toBe(last.ref_usd);
    expect(a.heat_bid).toBe(last.heat_bid);
    const agg = all(db, 'SELECT MIN(sell_10k) lo, MAX(sell_10k) hi, MIN(bid_10) blo, MAX(bid_10) bhi FROM depth_minute WHERE pool_id = ?', 'all')[0];
    expect([a.sell_10k_lo, a.sell_10k_hi, a.bid_10_lo, a.bid_10_hi]).toEqual([agg.lo, agg.hi, agg.blo, agg.bhi]);
    // pool 3368 lost a range between the two minutes: its row is the second minute's figures
    const p = rows.find((r) => r.pool_id === '3368')!;
    expect(p.n).toBe(2);
    expect(p.sell_10k).toBe(all(db, 'SELECT sell_10k FROM depth_minute WHERE pool_id = ? AND minute = ?', '3368', Math.floor(T2 / MIN) * MIN)[0].sell_10k);
    // the unpriced pool's row: NULL figures, NULL extremes, the count
    const u = rows.find((r) => r.pool_id === '3020')!;
    expect(u).toMatchObject({ n: 2, sell_10k: null, sell_10k_lo: null, sell_10k_hi: null });
    const plan = all(db, `EXPLAIN QUERY PLAN ${HOURLY_ROLLUP_SQL}`, 'all', HOUR_CLOSED, HOUR_CLOSED + H, 'all').map((r) => r.detail as string);
    expect(plan.filter((d) => d.startsWith('SEARCH') && d.includes('USING INDEX sqlite_autoindex_depth_minute_1 (pool_id=? AND minute'))).toHaveLength(2);
    expect(plan.filter((d) => d.startsWith('SCAN'))).toEqual(['SCAN a']); // the co-routine's one row, never the table
    // the marker: a second call this hour does nothing
    expect(kv(db, 'depth.hourly')).toBe(TH - 5 * MIN);
    const again = await runHour(db, { mutate: withdraw3368 }, {}, TH + 2 * MIN);
    expect(again.res.skipped).toBe('done');
    expect(again.net.calls).toHaveLength(0);
  });

  it('a missed window: the closed hours since the last finished one are rolled, at most six back', () => {
    expect(hoursToRoll(null, TH - 5 * MIN)).toEqual([HOUR_CLOSED]);
    expect(hoursToRoll(HOUR_CLOSED + H, HOUR_CLOSED + 2 * H)).toEqual([HOUR_CLOSED + H]); // ran at 03:xx, now 04:xx: 03:00 closed since
    expect(hoursToRoll(HOUR_CLOSED - H, HOUR_CLOSED + H)).toEqual([HOUR_CLOSED - H, HOUR_CLOSED]);
    expect(hoursToRoll(HOUR_CLOSED - 20 * H, HOUR_CLOSED + H)).toHaveLength(6);
    expect(hoursToRoll(HOUR_CLOSED + H, HOUR_CLOSED + H)).toEqual([]);
  });

  it('the hourly row through D1’s own parameter path: a figure that is not finite is NULL, the count is kept, a row without one is refused', async () => {
    const db = d1Json();
    const row: DepthHourlyRow = { hour: HOUR_CLOSED, pool_id: 'x', at: T1, height: null, ref_usd: 0.001, spot_usd: NaN, bid: [1, NaN], ask: [], sell: [null, 2], buy: [], best_bid: null, best_ask: null, bid_usd: null, ask_nam: null, nam: null, counter: null, counter_usd: null, heat_bid: null, heat_ask: null, note: null, sell_10k_lo: -Infinity, sell_10k_hi: 3, bid_10_lo: null, bid_10_hi: NaN, n: 2 };
    await runStmts(db, [hourlyStmt(row)]);
    expect(all(db, 'SELECT spot_usd, bid_1, bid_2, sell_10k, sell_10k_lo, sell_10k_hi, bid_10_hi, n FROM depth_hourly')[0]).toEqual({ spot_usd: null, bid_1: 1, bid_2: null, sell_10k: 2, sell_10k_lo: null, sell_10k_hi: 3, bid_10_hi: null, n: 2 });
    expect(() => hourlyStmt({ ...row, n: 0 })).toThrow(/count/);
    expect(() => hourlyStmt({ ...row, ref_usd: NaN })).toThrow(/ref_usd/);
  });

  it('the retention delete removes minute rows older than the window, at most the limit a run shared over the pools, by primary-key range', async () => {
    const db = await twoMinutes();
    const old = T1 - cfg.caps.retentionMs - 86_400_000;
    const ids = ['all', '3005', '3368'];
    for (const id of ids) for (let i = 0; i < 5; i++) insert(db, 'depth_minute', [{ minute: old + i * MIN, pool_id: id, at: old + i * MIN, height: 1, ref_usd: 0.001 }]);
    const before = count(db, 'SELECT COUNT(*) n FROM depth_minute WHERE minute < ?', T1 - cfg.caps.retentionMs);
    expect(before).toBe(15);
    // the limit is shared over every pool with rows (29 of them in the newest answer): a limit of 29 is one row each
    const { res } = await runHour(db, { mutate: withdraw3368 }, { cfg: { ...cfg, caps: { ...cfg.caps, deleteLimit: 29 } } });
    expect(res.deleted).toBe(3);
    expect(count(db, 'SELECT COUNT(*) n FROM depth_minute WHERE minute < ?', T1 - cfg.caps.retentionMs)).toBe(12);
    for (const id of ids) expect(count(db, 'SELECT COUNT(*) n FROM depth_minute WHERE pool_id = ? AND minute < ?', id, T1 - cfg.caps.retentionMs)).toBe(4);
    expect(count(db, 'SELECT COUNT(*) n FROM depth_minute WHERE minute >= ?', T1 - MIN)).toBe(34);
    const stmts = deleteOldMinutesStmts(ids, T1 - cfg.caps.retentionMs, cfg.caps.deleteLimit);
    expect(stmts[0].params[2]).toBe(Math.floor(cfg.caps.deleteLimit / 3));
    const plan = all(db, `EXPLAIN QUERY PLAN ${stmts[0].sql}`, ...stmts[0].params).map((r) => r.detail as string);
    expect(plan.some((d) => d.startsWith('SEARCH depth_minute USING'))).toBe(true);
    expect(plan.some((d) => d.startsWith('SCAN'))).toBe(false);
    expect(cfg.caps.deleteLimit).toBe(5_000);
  });

  it('the minute writes the change rows of what moved since the minute before; the hour after writes the position withdrawn and the order filled, each with its owner', async () => {
    const db = await twoMinutes();
    // the second minute saw pool 3368's last range gone: one row, the range's amounts, no owner (a tick range has none), the pool's height
    const minuteRows = all(db, 'SELECT * FROM depth_changes ORDER BY ts, ref') as DepthChangeRow[] & Record<string, unknown>[];
    expect(minuteRows).toHaveLength(1);
    const gone = clStates()['3368'].ranges.at(-1)!;
    // the range sits above the pool's price, so it held the counter coin only: a bid, its value in USD, no base coin
    expect(minuteRows[0]).toMatchObject({ pool_id: '3368', ref: `rng:${gone.lower_tick}:${gone.upper_tick}`, kind: 'removed', side: 'bid', owner: null, height: REF_HEIGHT, nam: 0 });
    expect(minuteRows[0].usd as number).toBeGreaterThan(0);
    expect(minuteRows[0].ts).toBe(kv<DepthStates>(db, 'depth.states')!.at);
    // the first hour: a reading to compare the next against, no rows of its own
    const first = await runHour(db);
    expect(first.res.changes).toBe(0);
    // the hour after: a position above the price withdrawn (the index no longer lists it) and ask order 993 filled from 200,000 to 150,000 NAM
    const second = await runHour(db, { mutate: withdraw3368, dropPositions: ['15148276'], fillOrder: { id: 993, quantity: '150000000000' } }, {}, TH + H);
    expect(second.res.skipped).toBeUndefined();
    expect(second.res.invariants!.inRange.ok && second.res.invariants!.bookTotals.ok).toBe(true);
    expect(second.res.changes).toBe(2);
    const rows = all(db, 'SELECT * FROM depth_changes WHERE ts > ? ORDER BY ref', TH);
    expect(rows).toHaveLength(2);
    const withdrawn = POSITIONS_3005.find((p: any) => p.position_id === '15148276');
    expect(rows.find((r) => r.ref === 'pos:15148276')).toMatchObject({ pool_id: '3005', kind: 'removed', side: 'ask', owner: withdrawn.address, height: REF_HEIGHT, usd: 0 });
    expect(rows.find((r) => r.ref === 'pos:15148276')!.nam).toBeCloseTo(61757, 3);
    const filled = rows.find((r) => r.ref === 'ord:993')!;
    expect(filled).toMatchObject({ pool_id: '3008', kind: 'filled', side: 'ask', owner: 'owner#2', height: REF_HEIGHT, price_lo: 0.00125, price_hi: 0.00125 });
    expect(filled.nam).toBeCloseTo(50000, 6);
    expect(filled.usd).toBeCloseTo(62.5, 9);
    expect(rows.every((r) => r.ts === kv<DepthOwnersKv>(db, 'depth.owners')!.at)).toBe(true);
    const o = kv<DepthOwnersKv>(db, 'depth.owners')!;
    expect(o.totals.positions).toBe(first.res.positions - 1);
    expect(o.owners.flatMap((x) => x.items).find((i) => i.id === '993')!.quantity).toBe('150000000000');
    // the hour after rolls 03:00, which has no minute rows in this test: no hourly row for it, and none invented
    expect(second.res.rolled).toEqual([HOUR_CLOSED + H]);
    expect(second.res.hourlyRows).toBe(0);
    expect(count(db, 'SELECT COUNT(*) n FROM depth_hourly')).toBe(17);
  });
});

describe('the gates', () => {
  it('outside the window nothing is read, not even kv; on a listing tick the job waits unless the window is closing', async () => {
    const db = await twoMinutes();
    const q0 = db.queries;
    const out = await runHour(db, {}, {}, TH + 20 * MIN);
    expect(out.res.skipped).toBe('outside the window');
    expect(db.queries).toBe(q0);
    expect(out.net.calls).toHaveLength(0);
    const listing = await runHour(db, {}, { listingTick: true });
    expect(listing.res.skipped).toBe('listing tick');
    expect(listing.net.calls).toHaveLength(0);
    expect(HOURLY_WINDOW).toEqual({ ms: 15 * MIN, closingMs: 2 * MIN });
    // the window and the catch-up are series.ts's own, not a copy
    expect(HOURLY_WINDOW).toEqual({ ms: JOB_WINDOW_MS, closingMs: JOB_CLOSING_MS });
    expect(hoursToRoll).toBe(seriesHoursToRoll);
  });

  it('when the window is closing the positions are read and the book is not: the orders are not in the hour’s reading, the row says why, the invariant is not compared', async () => {
    const db = await twoMinutes();
    const { res, net, health } = await runHour(db, { mutate: withdraw3368 }, { listingTick: true }, TH + 8 * MIN + 30_000);
    expect(res.skipped).toBeUndefined();
    expect(res.positions).toBe(positionCount({ mutate: withdraw3368 }));
    expect(res.orders).toBe(0);
    expect(net.calls.filter((c) => c.url.includes('/smart/'))).toHaveLength(0);
    expect(res.invariants!.bookTotals).toEqual({ ok: null, note: `not compared: ${BOOK_NOT_READ_CLOSING}` });
    const o = kv<DepthOwnersKv>(db, 'depth.owners')!;
    expect(o.orders).toEqual({ at: null, height: null, read: false, why: BOOK_NOT_READ_CLOSING });
    expect(o.totals.orders).toBe(0);
    const row = rowOf(health, DEPTH_HEALTH.owners)!;
    expect(row.ok).toBe(false);
    expect(row.note).toContain(`0 orders (${BOOK_NOT_READ_CLOSING})`);
    expect(kv(db, 'depth.hourly')).toBe(TH - 5 * MIN);
    // the hour after reads the book again and compares no orders (the hour before had none read), the positions as usual
    const next = await runHour(db, { mutate: withdraw3368, fillOrder: { id: 993, quantity: '150000000000' } }, {}, TH + H);
    expect(next.res.orders).toBe(ORDERS);
    expect(next.res.changes).toBe(0);
    expect(kv<DepthOwnersKv>(db, 'depth.owners')!.orders.read).toBe(true);
  });

  it('on a tick already late, with the kill switch off, and with no stored minute: no request, the row says why', async () => {
    const db = await twoMinutes();
    const late = await runHour(db, { mutate: withdraw3368 }, { late: () => true });
    expect(late.res.skipped).toBe('late');
    expect(late.net.calls).toHaveLength(0);
    expect(rowOf(late.health, DEPTH_HEALTH.owners)!.note).toContain('Not run this tick');
    expect(kv(db, 'depth.hourly')).toBeNull(); // tried again on the next tick of the window
    insert(db, 'kv', [{ key: 'depth.on', value: '0', updated_at: TH }]);
    const off = await runHour(db, { mutate: withdraw3368 });
    expect(off.res.skipped).toBe('kill switch');
    expect(off.net.calls).toHaveLength(0);
    expect(count(db, 'SELECT COUNT(*) n FROM depth_hourly')).toBe(0);
    const fresh = await runHour(testD1());
    expect(fresh.res.skipped).toBeUndefined();
    expect(fresh.net.calls).toHaveLength(0);
    expect(fresh.res.positions).toBe(0);
    expect(rowOf(fresh.health, DEPTH_HEALTH.owners)).toMatchObject({ ok: false });
    expect(rowOf(fresh.health, DEPTH_HEALTH.owners)!.note).toContain('0 positions in 0 of 0 pools');
    expect(kv<DepthOwnersKv>(fresh.db, 'depth.owners')!.notes).toContain(OWNERS_NO_MINUTE);
    expect(kv(fresh.db, 'depth.hourly')).toBe(TH - 5 * MIN);
  });

  it('at the row cap nothing is read or inserted; the retention delete and the marker still go in and the row says so', async () => {
    const db = await twoMinutes();
    const old = T1 - cfg.caps.retentionMs - 86_400_000;
    insert(db, 'depth_minute', [{ minute: old, pool_id: 'all', at: old, height: 1, ref_usd: 0.001 }]);
    db.raw.prepare("UPDATE kv SET value = ? WHERE key = 'depth.budget'").run(JSON.stringify({ ...freshBudget(T1), rowsWritten: cfg.caps.rowsMonthMax }));
    const { res, net, health } = await runHour(db);
    expect(res.skipped).toBe('cap');
    expect(net.calls).toHaveLength(0);
    expect(res.deleted).toBe(1);
    expect(count(db, 'SELECT COUNT(*) n FROM depth_hourly')).toBe(0);
    expect(kv(db, 'depth.owners')).toBeNull();
    expect(kv(db, 'depth.hourly')).toBe(TH - 5 * MIN);
    expect(kv(db, 'depth.rolled')).toBeNull(); // the rollup of 02:00 is not done, so the marker is not advanced
    const row = rowOf(health, DEPTH_HEALTH.owners)!;
    expect(row.ok).toBe(false);
    expect(row.note).toMatch(/^1 old minute rows deleted; not read this hour: 5,000,000 rows written this month, at the cap/);
    expect(rowOf(health, DEPTH_HEALTH.store)!.ok).toBe(false);
  });

  it('an hour at the row cap advances the once-an-hour marker but not the rollup marker: the hour after rolls both closed hours into depth_hourly', async () => {
    const db = await twoMinutes();
    const clear = await runHour(db);
    expect(clear.res.rolled).toEqual([HOUR_CLOSED]);
    expect(kv(db, 'depth.rolled')).toBe(TH - 5 * MIN);
    // minute rows in 03:00 and 04:00, so each closed hour has something to roll
    for (const h of [HOUR_CLOSED + H, HOUR_CLOSED + 2 * H]) insert(db, 'depth_minute', [{ minute: h + 30 * MIN, pool_id: 'all', at: h + 30 * MIN, height: 1, ref_usd: 0.001, sell_10k: 9.9 }]);
    const budget = kv<any>(db, 'depth.budget')!;
    db.raw.prepare("UPDATE kv SET value = ? WHERE key = 'depth.budget'").run(JSON.stringify({ ...budget, rowsWritten: cfg.caps.rowsMonthMax }));
    const capped = await runHour(db, { mutate: withdraw3368 }, {}, TH + H);
    expect(capped.res.skipped).toBe('cap');
    expect(kv(db, 'depth.hourly')).toBe(TH + H - 5 * MIN);
    expect(kv(db, 'depth.rolled')).toBe(TH - 5 * MIN);
    expect(count(db, 'SELECT COUNT(*) n FROM depth_hourly WHERE hour = ?', HOUR_CLOSED + H)).toBe(0);
    // the month turns: the counter is fresh, inserts resume, and the two closed hours since the last rollup go in
    db.raw.prepare("UPDATE kv SET value = ? WHERE key = 'depth.budget'").run(JSON.stringify(budget));
    const after = await runHour(db, { mutate: withdraw3368 }, {}, TH + 2 * H);
    expect(after.res.skipped).toBeUndefined();
    expect(after.res.rolled).toEqual([HOUR_CLOSED + H, HOUR_CLOSED + 2 * H]);
    expect(all(db, 'SELECT hour, sell_10k, n FROM depth_hourly WHERE pool_id = ? AND hour > ? ORDER BY hour', 'all', HOUR_CLOSED)).toEqual([{ hour: HOUR_CLOSED + H, sell_10k: 9.9, n: 1 }, { hour: HOUR_CLOSED + 2 * H, sell_10k: 9.9, n: 1 }]);
    expect(kv(db, 'depth.rolled')).toBe(TH + 2 * H - 5 * MIN);
    // an hour whose inserts the gate refuses at the write (the counter reached the cap during the hour) leaves the rollup marker alone as well
    const db2 = await twoMinutes();
    const nearly: DepthConfig = { ...cfg, caps: { ...cfg.caps, rowsMonthMax: kv<any>(db2, 'depth.budget')!.rowsWritten + 5, rowsWarn: 1 } };
    const refused = await runHour(db2, { mutate: withdraw3368 }, { cfg: nearly });
    expect(refused.res.skipped).toBeUndefined();
    expect(refused.res.written).toBe(false);
    expect(kv(db2, 'depth.hourly')).toBe(TH - 5 * MIN);
    expect(kv(db2, 'depth.rolled')).toBeNull();
  });
});
