// The depth diff (worker/src/depth/diff.ts, plan 1.5 depth_changes): two readings of the same things and the rows for
// what moved between them. The minute's readings are the stored states of pool 3005 (verify-pool3005-now.json and
// verify-ranges3005-now.json, 02:55 UTC on 29 Oct 2026) and weighted pool 3439 (sqs_pools_nam.json); the hour's are the
// positions of 3005 (rpc_cl_positions_3005.json) and the book's orders (book_3008_full.json). A range withdrawn, a range
// whose liquidity grew, a price that moved inside a range (no row: the liquidity did not), reserves that both grew or
// both shrank (a join or an exit) against a swap (no row), a position withdrawn with its owner, an order filled in part
// with its owner, a new order; equal readings give no rows; the row's statement and its primary key.
import { describe, it, expect } from 'vitest';
import { testD1, runStmts } from './d1-sqlite';
import { minuteItemsOf, ownerItemsOf, diffItems, type ChangeItem } from '../worker/src/depth/diff';
import { changeStmt } from '../worker/src/depth/sql';
import { positionItem, orderItem, groupOwners, type DepthStates, type StoredPoolState } from '../worker/src/depth/index';
import { NAM_DEPTH } from '../worker/src/depth/config';
import type { OrderRow, PositionRead } from '../worker/src/depth/read';
import { depthFixture, NAM_DENOM, USDC_DENOM } from './depth-fixtures';
import { POSITIONS_3005, BOOK, SQS_POOLS, REF_HEIGHT } from './depth-minute-net';
import type { ClRange } from '../worker/src/depth/model';

const cfg = NAM_DEPTH;
const T = Date.UTC(2026, 9, 29, 2, 56, 0);
const POOL = depthFixture<{ pool: any }>('verify-pool3005-now.json').pool;
const RANGES = depthFixture<{ liquidity: ClRange[] }>('verify-ranges3005-now.json').liquidity;
const CM_3439 = SQS_POOLS.find((p: any) => String(p.chain_model?.id) === '3439').chain_model;
/** The range the pool's price is in (-28,480,000 to -26,903,000 at tick -26,980,132): it gives both coins. */
const CUR = RANGES.find((r) => Number(r.lower_tick) <= Number(POOL.current_tick) && Number(POOL.current_tick) < Number(r.upper_tick))!;
const CUR_REF = `rng:${CUR.lower_tick}:${CUR.upper_tick}`;

const clState = (ranges: ClRange[] = RANGES, pool: any = POOL): StoredPoolState => ({
  id: '3005', type: 'concentrated', counterDenom: USDC_DENOM, counterUsd: 1, counterDecimals: 6, taker: 0.001, spread: 0.002, at: T, height: REF_HEIGHT,
  cl: { pool: { token0: pool.token0, token1: pool.token1, current_sqrt_price: pool.current_sqrt_price, current_tick: pool.current_tick, tick_spacing: pool.tick_spacing, exponent_at_price_one: pool.exponent_at_price_one, spread_factor: pool.spread_factor, current_tick_liquidity: pool.current_tick_liquidity }, ranges },
});
const gammState = (nam: string, usdc: string): StoredPoolState => ({
  id: '3439', type: 'balancer', counterDenom: USDC_DENOM, counterUsd: 1, counterDecimals: 6, taker: 0.001, spread: 0.01, at: T, height: null,
  gamm: { assets: CM_3439.pool_assets.map((a: any) => ({ denom: a.token.denom, amount: a.token.denom === NAM_DENOM ? nam : usdc, weight: a.weight })) },
});
const states = (...pools: StoredPoolState[]): DepthStates => ({ minute: T, at: T, ref: { pool: '3005', usd: 0.00102, height: REF_HEIGHT }, pools });

describe('the minute’s readings: tick ranges and reserves', () => {
  it('the items of a stored minute: one per range of a concentrated pool keyed by its liquidity, one per weighted pool keyed by its two reserves', () => {
    const items = minuteItemsOf(cfg, states(clState(), gammState('13256987688', '13665263')));
    expect(items.filter((i) => i.pool === '3005')).toHaveLength(31);
    const r = RANGES[10];
    const it = items.find((i) => i.ref === `rng:${r.lower_tick}:${r.upper_tick}`)!;
    expect(it.key).toBe(r.liquidity_amount);
    expect(it.owner).toBeNull();
    expect(it.loUsd).toBeLessThan(it.hiUsd!);
    expect(it.nam + it.usd).toBeGreaterThan(0);
    const inRange = items.find((i) => i.pool === '3005' && i.side === null)!;
    expect(inRange.ref).toBe(CUR_REF);
    expect(CUR_REF).toBe('rng:-28480000:-26903000');
    expect(items.filter((i) => i.pool === '3005' && i.side === 'bid').length + items.filter((i) => i.pool === '3005' && i.side === 'ask').length).toBe(30);
    const res = items.find((i) => i.pool === '3439')!;
    expect(res).toMatchObject({ ref: 'res', key: '13256987688|13665263', side: null, loUsd: null, hiUsd: null, nam: 13256.987688, usd: 13.665263, owner: null });
    expect(minuteItemsOf(cfg, null)).toEqual([]);
  });

  it('equal readings give no rows; a range withdrawn is removed at its amounts; a range whose liquidity doubled grew by the difference', () => {
    const a = minuteItemsOf(cfg, states(clState()));
    expect(diffItems(a, minuteItemsOf(cfg, states(clState())), T + 60_000, REF_HEIGHT)).toEqual([]);
    const last = RANGES[RANGES.length - 1];
    const gone = diffItems(a, minuteItemsOf(cfg, states(clState(RANGES.slice(0, -1)))), T + 60_000, REF_HEIGHT + 1);
    expect(gone).toHaveLength(1);
    const was = a.find((i) => i.ref === `rng:${last.lower_tick}:${last.upper_tick}`)!;
    expect(gone[0]).toEqual({ ts: T + 60_000, pool: '3005', ref: was.ref, kind: 'removed', side: 'ask', loUsd: was.loUsd, hiUsd: was.hiUsd, nam: was.nam, usd: was.usd, owner: null, height: REF_HEIGHT + 1 });
    const doubled = RANGES.map((r, i) => (i === 0 ? { ...r, liquidity_amount: (Number(r.liquidity_amount) * 2).toFixed(18) } : r));
    const grew = diffItems(a, minuteItemsOf(cfg, states(clState(doubled))), T + 60_000, REF_HEIGHT);
    expect(grew).toHaveLength(1);
    expect(grew[0]).toMatchObject({ ref: `rng:${RANGES[0].lower_tick}:${RANGES[0].upper_tick}`, kind: 'grew', side: 'bid' });
    const before = a.find((i) => i.ref === grew[0].ref)!;
    expect(grew[0].usd).toBeCloseTo(before.usd, 9); // twice the liquidity is twice the counter coin resting below the price
    expect(grew[0].nam).toBe(0);
    const back = diffItems(minuteItemsOf(cfg, states(clState(doubled))), a, T + 120_000, REF_HEIGHT);
    expect(back[0].kind).toBe('shrank');
    expect(diffItems([], a, T, REF_HEIGHT).every((r) => r.kind === 'added')).toBe(true);
  });

  it('a price that moved inside the range: the amounts shift between the two coins but the liquidity did not move, so no row', () => {
    const a = minuteItemsOf(cfg, states(clState()));
    const moved = { ...POOL, current_sqrt_price: String(Number(POOL.current_sqrt_price) * 1.001) };
    const b = minuteItemsOf(cfg, states(clState(RANGES, moved)));
    const cur = (items: ChangeItem[]) => items.find((i) => i.ref === CUR_REF)!;
    expect(cur(b).nam).not.toBe(cur(a).nam);
    expect(diffItems(a, b, T + 60_000, REF_HEIGHT)).toEqual([]);
  });

  it('reserves: a swap (one up, one down) is no row; both up is grew, both down is shrank, by the difference', () => {
    const a = minuteItemsOf(cfg, states(gammState('13256987688', '13665263')));
    expect(diffItems(a, minuteItemsOf(cfg, states(gammState('13356987688', '13565263'))), T + 60_000, null)).toEqual([]);
    const joined = diffItems(a, minuteItemsOf(cfg, states(gammState('14256987688', '14665263'))), T + 60_000, null);
    expect(joined).toHaveLength(1);
    expect(joined[0]).toMatchObject({ pool: '3439', ref: 'res', kind: 'grew', side: null, loUsd: null, hiUsd: null, owner: null, height: null });
    expect(joined[0].nam).toBeCloseTo(1000, 6);
    expect(joined[0].usd).toBeCloseTo(1, 6);
    const left = diffItems(a, minuteItemsOf(cfg, states(gammState('12256987688', '12665263'))), T + 60_000, null);
    expect(left[0]).toMatchObject({ kind: 'shrank' });
    expect(left[0].nam).toBeCloseTo(1000, 6);
  });
});

describe('the hour’s readings: positions and orders with their owners', () => {
  const wire = { token0: POOL.token0, token1: POOL.token1, exponent_at_price_one: POOL.exponent_at_price_one, current_tick: POOL.current_tick };
  const position = (p: any): PositionRead => ({
    position_id: String(p.position_id), address: p.address, pool_id: '3005', lower_tick: Number(p.lower_tick), upper_tick: Number(p.upper_tick), join_time: p.join_time_unix * 1000,
    liquidity: `${p.liquidity.slice(0, -18)}.${p.liquidity.slice(-18)}`, asset0: p.asset0, asset1: p.asset1, claimable_spread_rewards: [], claimable_incentives: [], height: REF_HEIGHT, at: T,
  });
  const bookState: StoredPoolState = { id: '3008', type: 'cosmwasm', counterDenom: USDC_DENOM, counterUsd: 1, counterDecimals: 6, taker: 0.001, spread: 0, at: T, height: REF_HEIGHT, book: { bids: [], asks: [] } };
  const order = (o: any, quantity = o.quantity): OrderRow => ({ tick_id: o.tick_id, order_id: o.order_id, order_direction: o.side, owner: o.owner, quantity, placed_quantity: o.placed_quantity, placed_at: o.placed_at_ns });
  const reading = (positions: PositionRead[], orders: OrderRow[]) => groupOwners([
    ...positions.map((p) => ({ owner: p.address, item: positionItem(cfg, clState(), wire, p) })),
    ...orders.map((o) => ({ owner: o.owner, item: orderItem(cfg, bookState, o) })),
  ]).owners;

  it('the items of a reading carry the owner and the chain’s own figure: a position’s liquidity, an order’s remaining quantity', () => {
    const items = ownerItemsOf(reading(POSITIONS_3005.map(position), BOOK.orders.map((o: any) => order(o))));
    expect(items.filter((i) => i.ref.startsWith('pos:'))).toHaveLength(19);
    expect(items.filter((i) => i.ref.startsWith('ord:'))).toHaveLength(43);
    const p = items.find((i) => i.ref === 'pos:15392963')!;
    expect(p).toMatchObject({ pool: '3005', side: null, key: '6353092755.962217234850521312', owner: POSITIONS_3005.find((x: any) => x.position_id === '15392963').address });
    expect(p.nam).toBeCloseTo(26026.594582, 6);
    const o = items.find((i) => i.ref === 'ord:993')!;
    expect(o).toMatchObject({ pool: '3008', side: 'ask', key: '200000000000', owner: 'owner#2', nam: 200000, loUsd: 0.00125, hiUsd: 0.00125 });
    expect(ownerItemsOf(null)).toEqual([]);
  });

  it('a position withdrawn, an order filled in part, a new order; equal readings give nothing', () => {
    const before = ownerItemsOf(reading(POSITIONS_3005.map(position), BOOK.orders.map((o: any) => order(o))));
    expect(diffItems(before, ownerItemsOf(reading(POSITIONS_3005.map(position), BOOK.orders.map((o: any) => order(o)))), T + 3_600_000, REF_HEIGHT)).toEqual([]);
    const after = ownerItemsOf(reading(
      POSITIONS_3005.filter((p: any) => p.position_id !== '15392963').map(position),
      [...BOOK.orders.map((o: any) => order(o, o.order_id === 993 ? '150000000000' : o.quantity)), order({ tick_id: -26000000, order_id: 1001, side: 'ask', owner: 'owner#9', quantity: '1000000000', placed_quantity: '1000000000', placed_at_ns: '1793206948076371190' })],
    ));
    const rows = diffItems(before, after, T + 3_600_000, REF_HEIGHT + 600).sort((a, b) => a.ref.localeCompare(b.ref));
    expect(rows.map((r) => `${r.ref} ${r.kind}`)).toEqual(['ord:1001 added', 'ord:993 filled', 'pos:15392963 removed']);
    const [added, filled, removed] = rows;
    expect(added).toMatchObject({ pool: '3008', side: 'ask', owner: 'owner#9', nam: 1000, loUsd: 0.002, height: REF_HEIGHT + 600 });
    expect(added.usd).toBeCloseTo(2, 9);
    expect(filled).toMatchObject({ pool: '3008', side: 'ask', owner: 'owner#2', nam: 50000 });
    expect(filled.usd).toBeCloseTo(62.5, 9);
    expect(removed).toMatchObject({ pool: '3005', side: null, owner: POSITIONS_3005.find((x: any) => x.position_id === '15392963').address, ts: T + 3_600_000 });
    expect(removed.nam).toBeCloseTo(26026.594582, 6);
    expect(removed.usd).toBeCloseTo(17.665537, 6);
    expect(removed.loUsd).toBeCloseTo(0.00085, 10);
  });
});

describe('the row', () => {
  it('changeStmt binds the row with its figures finite or NULL; (pool_id, ref, ts) is the key, so one reading of one thing is one row', async () => {
    const db = testD1();
    const row = { ts: T, pool: '3005', ref: CUR_REF, kind: 'grew', side: null, loUsd: 0.001, hiUsd: 0.0011, nam: NaN, usd: 2.5, owner: null, height: REF_HEIGHT };
    await runStmts(db, [changeStmt(row), changeStmt({ ...row, usd: 3 }), changeStmt({ ...row, ts: T + 1, kind: 'shrank', owner: 'osmo1…dk30' })]);
    const rows = db.raw.prepare('SELECT * FROM depth_changes ORDER BY ts').all();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ pool_id: '3005', ref: row.ref, kind: 'grew', side: null, price_lo: 0.001, price_hi: 0.0011, nam: null, usd: 3, owner: null, height: REF_HEIGHT });
    expect(rows[1]).toMatchObject({ kind: 'shrank', owner: 'osmo1…dk30' });
    expect(() => changeStmt({ ...row, ref: '' })).toThrow();
    expect(() => changeStmt({ ...row, ts: NaN })).toThrow();
    const plan = db.raw.prepare('EXPLAIN QUERY PLAN SELECT * FROM depth_changes WHERE ts >= ? AND ts < ? ORDER BY ts').all(T, T + 1).map((r: any) => r.detail as string);
    expect(plan.some((d) => d.includes('depth_changes_ts'))).toBe(true);
  });
});
