// The 20 newest stored Osmosis trades of 28 Oct 2026 (verify-d1-trades-hops.json, 03:34-15:14 UTC) replayed on the
// pools' rebuilt states (verify-replay.json: each swap hop's sqrt price before it, found by undoing every later hop from
// the state read at 02:55-02:57 UTC on 29 Oct; pool 3005's tick map put back from its position events,
// verify-ev-*.json). The depth research measured this with the prototype (verify.txt section 1, verify-proto-walk.json):
// 74 hops within 0.115 %, 17 of 20 trades within 0.04 % of the trader's own settle; the two that took most of their NAM
// from an order-book ask since gone cannot be rebuilt (the book is not on the chain's tick map), and one trade's stored
// settle nets a sell-back made in the same transaction. The same holds for the exact BigInt walk here.
//
// Correction C1 of verify.txt is carried in: a token_swapped event's tokens_in is already net of the taker fee and the
// pool's spread (the walk charges nothing again), and a stored sell's amount_num is the sum of the hops' net inputs,
// not the NAM the trader sold (that is meta.settle.nam).
import { describe, it, expect } from 'vitest';
import { clSwapExactIn, clModel, decString, tickOfPrice, buildGrid, aggregate, executeSell, type ClRange, type PricedPool } from '../worker/src/depth/model';
import { decToScaled } from '../worker/src/depth/proto';
import { depthFixture, NAM_DENOM } from './depth-fixtures';

const REPLAY = depthFixture<any>('verify-replay.json');
const TRADES = depthFixture<any[]>('verify-d1-trades-hops.json');
const WALK = depthFixture<any>('verify-proto-walk.json');
const POOL_IDS = ['3005', '3368', '3009'] as const;
type PoolId = (typeof POOL_IDS)[number];
const NOW: Record<PoolId, { pool: any; ranges: ClRange[] }> = Object.fromEntries(POOL_IDS.map((id) => [id, { pool: depthFixture<any>(`verify-pool${id}-now.json`).pool, ranges: depthFixture<any>(`verify-ranges${id}-now.json`).liquidity }])) as any;
/** The pair's taker fee, from the prototype's own read of trading_pair_takerfee (proto_latest.json takerByDenom): 0.001 for NAM/USDC, 0.002 for NAM/OSMO. */
const TAKER: Record<PoolId, number> = { '3005': 0.001, '3368': 0.002, '3009': 0.002 };
const pct = (a: number, b: number) => (a / b - 1) * 100;

/** Pool 3005's position events of 28 Oct (create_position and withdraw_position, newest first), from the chain's tx_search answers. */
interface PositionEvent { height: number; index: number; positionId: string; liquidity: bigint; lo: number; hi: number }
function positionEvents(): PositionEvent[] {
  const out: PositionEvent[] = [];
  for (const file of ['verify-ev-create_position-3005.json', 'verify-ev-withdraw_position-3005.json']) {
    for (const tx of depthFixture<any>(file).result.txs) {
      for (const e of tx.tx_result.events) {
        if (e.type !== 'create_position' && e.type !== 'withdraw_position') continue;
        const a: Record<string, string> = Object.fromEntries(e.attributes.map((x: any) => [x.key, x.value]));
        if (a.pool_id !== '3005') continue;
        out.push({ height: Number(tx.height), index: Number(tx.index), positionId: a.position_id, liquidity: decToScaled(a.liquidity, 18), lo: Number(a.lower_tick), hi: Number(a.upper_tick) });
      }
    }
  }
  return out.sort((a, b) => b.height - a.height || b.index - a.index);
}
const EVENTS = positionEvents();

/** The pool's tick map as it was just before the transaction at (height, index): the ranges read now, with every later position event undone. */
function rangesAt(id: PoolId, height: number, index: number): ClRange[] {
  const net = new Map<number, bigint>();
  const add = (t: number, v: bigint) => net.set(t, (net.get(t) ?? 0n) + v);
  for (const r of NOW[id].ranges) { const L = decToScaled(r.liquidity_amount, 18); add(Number(r.lower_tick), L); add(Number(r.upper_tick), -L); }
  if (id === '3005') for (const e of EVENTS) if (e.height > height || (e.height === height && e.index >= index)) { add(e.lo, -e.liquidity); add(e.hi, e.liquidity); }
  const ticks = [...net.keys()].sort((a, b) => a - b);
  const out: ClRange[] = [];
  let L = 0n;
  for (let k = 0; k < ticks.length - 1; k++) { L += net.get(ticks[k])!; if (L > 0n) out.push({ lower_tick: ticks[k], upper_tick: ticks[k + 1], liquidity_amount: decString(L, 18) }); }
  return out;
}
/** The pool as it stood before a hop: the state read now with the hop's own sqrt price before it. */
const stateBefore = (id: PoolId, hop: any) => ({ ...NOW[id].pool, current_sqrt_price: hop.sqrt_before_by_in, current_tick: String(tickOfPrice(Number(hop.sqrt_before_by_in) ** 2, Number(NOW[id].pool.exponent_at_price_one))) });
/** What the exact walk gives for a hop's net input at its rebuilt state. */
function predictHop(id: PoolId, hop: any): { out: bigint; unfilled: bigint } {
  const sell = hop.direction === 'sell NAM';
  const zeroForOne = sell === (NOW[id].pool.token0 === NAM_DENOM);
  const r = clSwapExactIn(stateBefore(id, hop), rangesAt(id, hop.height, hop.index), zeroForOne, BigInt(hop.tokens_in), { netAlready: true });
  return { out: r.amountOut, unfilled: r.unfilledIn };
}
const hopsOf = (id: PoolId): any[] => REPLAY.pools[id].hops_newest_first;

describe('the rebuilt states (verify-replay.json)', () => {
  it('three pools, 74 hops since height 73,334,008; each pool’s ranges now sum to its current_tick_liquidity', () => {
    expect(POOL_IDS.map((id) => hopsOf(id).length)).toEqual([51, 14, 9]);
    for (const id of POOL_IDS) {
      expect(REPLAY.pools[id].L_check.equal).toBe(true);
      expect(REPLAY.pools[id].current_sqrt_price).toBe(NOW[id].pool.current_sqrt_price);
      const m = clModel(NOW[id].pool, NOW[id].ranges, NAM_DENOM);
      const inRange = NOW[id].ranges.find((r) => Number(r.lower_tick) <= m.currentTick && m.currentTick < Number(r.upper_tick));
      expect(inRange?.liquidity_amount).toBe(NOW[id].pool.current_tick_liquidity);
    }
    expect(NOW['3005'].pool.token0).toBe(NAM_DENOM);
    expect(NOW['3009'].pool.token0).toBe(NAM_DENOM);
    expect(NOW['3368'].pool.token1).toBe(NAM_DENOM); // NAM is token1 of the OSMO pool
  });
  it('pool 3005’s seven position events of 28 Oct come from the chain’s own transactions: 15533107 (201 billion of liquidity between 0.000902 and 0.000923) created at 73,378,729 and withdrawn at 73,379,662', () => {
    expect(EVENTS.length).toBe(7);
    const created = EVENTS.find((e) => e.positionId === '15533107' && e.liquidity > 0n), gone = EVENTS.find((e) => e.positionId === '15533107' && e.liquidity < 0n);
    expect(created).toMatchObject({ height: 73378729, lo: -27980000, hi: -27770000 });
    expect(gone).toMatchObject({ height: 73379662 });
    expect(created!.liquidity + gone!.liquidity).toBe(0n);
    expect(decString(created!.liquidity, 18)).toBe('201127817700.520466858152597717');
    expect(EVENTS.map((e) => e.height)).toEqual([73379662, 73378729, 73378683, 73363038, 73363008, 73362971, 73344479]);
  });
  it('undoing the events puts position 15533107 back into the map between its creation and its withdrawal, and not outside', () => {
    const during = rangesAt('3005', 73379031, 0), before = rangesAt('3005', 73378729, 0), after = rangesAt('3005', 73379662, 1);
    const lAt = (rs: ClRange[], tick: number) => rs.find((r) => Number(r.lower_tick) <= tick && tick < Number(r.upper_tick))?.liquidity_amount ?? '0';
    expect(Number(lAt(during, -27_900_000))).toBeGreaterThan(201_000_000_000);
    expect(Number(lAt(before, -27_900_000))).toBeLessThan(20_000_000_000);
    expect(Number(lAt(after, -27_900_000))).toBeLessThan(20_000_000_000);
    expect(after.map((r) => r.liquidity_amount)).toEqual(NOW['3005'].ranges.map((r) => r.liquidity_amount));
  });
});

describe('every hop walked exactly on its rebuilt state (verify.txt: 3005 within 0.0004 %, 3009 within 0.00003 %, 3368 a uniform 0.098-0.115 % left unexplained)', () => {
  const bounds: Record<PoolId, number> = { '3005': 0.0004, '3009': 0.00003, '3368': 0.115 };
  it.each(POOL_IDS)('pool %s', (id) => {
    const diffs = hopsOf(id).map((h) => { const p = predictHop(id, h); expect(p.unfilled, `${h.hash} at ${h.height}`).toBe(0n); return pct(Number(p.out), h.tokens_out_actual); });
    const worst = Math.max(...diffs.map(Math.abs));
    expect(worst).toBeLessThanOrEqual(bounds[id] * 1.05);
    expect(diffs.every((d) => Math.abs(d) < 1)).toBe(true);
    if (id === '3368') {
      // the residual is one-sided and uniform: every sale under-predicted, every buy over-predicted
      const sells = hopsOf(id).map((h, i) => [h.direction, diffs[i]] as const).filter(([d]) => d === 'sell NAM').map(([, v]) => v);
      const buys = hopsOf(id).map((h, i) => [h.direction, diffs[i]] as const).filter(([d]) => d === 'buy NAM').map(([, v]) => v);
      expect(sells.every((v) => v < -0.09 && v > -0.11)).toBe(true);
      expect(buys.every((v) => v > 0.1 && v < 0.12)).toBe(true);
    }
  });
  it('the exact walk and the prototype’s Number walk agree hop by hop within 0.001 % (verify-proto-walk.json)', () => {
    for (const id of POOL_IDS) for (const h of hopsOf(id)) {
      const row = WALK.hopRows.find((r: any) => r.pool === id && r.hash === h.hash && r.height === h.height && r.tokens_in === h.tokens_in);
      expect(row).toBeTruthy();
      expect(Math.abs(pct(Number(predictHop(id, h).out), row.proto_out))).toBeLessThan(0.001);
    }
  });
  it('the six 10 USDC buys of 14:38:58-14:39:40 UTC walked the price through position 15533107 and come back to 1e-7 %', () => {
    const six = ['C69D6D', '337CB7', 'E3DD92', '341A6D', 'B82AC3', '8E01CB'];
    for (const prefix of six) {
      const h = hopsOf('3005').find((x) => x.hash.startsWith(prefix) && x.direction === 'buy NAM');
      expect(h.tokens_in).toBe(9_970_020); // 10 USDC x 0.999 x 0.998: C1, the event's tokens_in is net of both fees
      expect(Math.abs(pct(Number(predictHop('3005', h).out), h.tokens_out_actual))).toBeLessThan(1e-6);
    }
  });
});

/** The hops of a transaction in the trader's own direction (ProtoRev's backrun hops in the same transaction go the other way). */
const legsOf = (t: any) => POOL_IDS.flatMap((id) => hopsOf(id).filter((h) => h.hash === t.hash && (t.kind === 'buy') === (h.direction === 'buy NAM')).map((h) => ({ id, hop: h })));
/** The trader's OSMO to USD rate from the transaction's own OSMO/USDC hop, as the settle values it (config.ts ratePools). */
const osmoUsdOf = (t: any): number | null => {
  const h = t.hops.find((x: any) => (x.inDenom === 'OSMO' && /USDC|factory\/osmo147h/.test(x.outDenom)) || (x.outDenom === 'OSMO' && /USDC|factory\/osmo147h/.test(x.inDenom)));
  return h ? (h.inDenom === 'OSMO' ? h.out / h.in : h.in / h.out) : null;
};
const BOOK_LEG = 'took most of its NAM from an order-book ask since gone: the book is not on the chain’s tick map and cannot be rebuilt';
interface TradeRow { hash: string; kind: string; poolId: string; predicted: number | null; actual: number | null; diffPct: number | null; excluded?: string }
function replayTrade(t: any): TradeRow {
  const base = { hash: t.hash, kind: t.kind, poolId: t.pool_id };
  if (t.pool_id.split(',').includes('3008')) return { ...base, predicted: null, actual: null, diffPct: null, excluded: BOOK_LEG };
  const legs = legsOf(t);
  if (!legs.length) return { ...base, predicted: null, actual: null, diffPct: null, excluded: 'no rebuilt leg' };
  const pred = legs.map((l) => ({ ...l, out: Number(predictHop(l.id, l.hop).out) }));
  let predicted: number, actual: number;
  if (t.kind === 'buy') { predicted = pred.reduce((a, l) => a + l.out, 0) / 1e6; actual = t.settle.nam; }
  else {
    const osmoUsd = osmoUsdOf(t);
    const toUsd = (id: PoolId, v: number) => (id === '3005' ? v / 1e6 : osmoUsd ? (v / 1e6) * osmoUsd : NaN);
    predicted = pred.reduce((a, l) => a + toUsd(l.id, l.out), 0);
    actual = pred.reduce((a, l) => a + toUsd(l.id, l.hop.tokens_out_actual), 0);
  }
  return { ...base, predicted, actual, diffPct: pct(predicted, actual) };
}

describe('the 20 stored trades against the trader’s own settle', () => {
  const rows = TRADES.map(replayTrade);
  it('20 trades, 28 Oct 03:34-15:14 UTC, eight sells and twelve buys', () => {
    expect(TRADES.length).toBe(20);
    expect(TRADES.filter((t) => t.kind === 'sell').length).toBe(8);
    expect(TRADES[0].ts_utc).toBe('2026-10-28T15:14:48Z');
    expect(TRADES[TRADES.length - 1].ts_utc < TRADES[0].ts_utc).toBe(true);
  });
  it('the two trades routed through the order book are left out with the reason, not counted as misses', () => {
    const out = rows.filter((r) => r.excluded === BOOK_LEG);
    expect(out.map((r) => r.hash.slice(0, 6)).sort()).toEqual(['6A870D', 'F34513']);
    expect(out.every((r) => r.poolId.includes('3008'))).toBe(true);
    // what the book gave them is exactly input / price with no fee: 89,910,000 uUSDC at 0.001 -> 89,910,000,000 uNAM
    const big = TRADES.find((t) => t.hash.startsWith('6A870D')).hops.find((h: any) => h.pool === '3008');
    expect(big.out / big.in).toBe(1000);
    expect(big.inDenom).toBe('USDC');
  });
  it('17 of the 18 rebuilt trades land within 0.04 % (verify.txt: 17 of 20 overall)', () => {
    const rebuilt = rows.filter((r) => r.diffPct != null);
    expect(rebuilt.length).toBe(18);
    const within = rebuilt.filter((r) => Math.abs(r.diffPct!) <= 0.04);
    expect(within.length).toBe(17);
    expect(within.map((r) => r.hash.slice(0, 6)).sort()).toEqual(['016520', '0FF2D1', '1097B1', '1CA838', '2C574C', '337CB7', '341A6D', '3D6DAF', '844EE4', '8E01CB', '944B93', '9C07F7', 'A09712', 'B82AC3', 'C69D6D', 'E3DD92', 'FADE44']);
    // the research's own per-trade figures, within 0.001 % of ours
    for (const r of rebuilt) {
      const theirs = WALK.tradeRows.find((x: any) => x.hash === r.hash);
      expect(Math.abs(r.diffPct! - theirs.diff_pct)).toBeLessThan(0.001);
    }
  });
  it('B80F3C is the one rebuilt trade outside 1 %: +3.33 % against its stored settle, which nets a 336 NAM buy and its 335 NAM sell-back made in the same transaction; against its buy legs it is within 0.04 %', () => {
    const t = TRADES.find((x) => x.hash.startsWith('B80F3C'));
    const r = rows.find((x) => x.hash === t.hash)!;
    expect(r.diffPct).toBeCloseTo(3.33, 1);
    const sellBack = t.hops.find((h: any) => h.pool === '3005' && h.inDenom === 'NAM');
    expect(sellBack.in / 1e6).toBeCloseTo(335.29, 1);
    const legs = legsOf(t);
    const predicted = legs.reduce((a, l) => a + Number(predictHop(l.id, l.hop).out), 0), actual = legs.reduce((a, l) => a + l.hop.tokens_out_actual, 0);
    expect(Math.abs(pct(predicted, actual))).toBeLessThan(0.04);
    const extraBuy = t.hops.find((h: any) => h.pool === '3368' && h.out === 335_958_429);
    expect(extraBuy).toBeTruthy();
    expect(actual / 1e6 - t.settle.nam).toBeCloseTo(extraBuy.out / 1e6, 6);
  });
  it('C1: a sell’s stored amount_num is the sum of the hops’ net NAM inputs; the NAM sold is the settle’s, and the gross from each leg’s fees adds back to it', () => {
    const spread: Record<string, number> = Object.fromEntries(POOL_IDS.map((id) => [id, Number(NOW[id].pool.spread_factor)]));
    for (const t of TRADES.filter((x) => x.kind === 'sell')) {
      // the trader's own route ends where the backrun starts buying NAM back
      const firstBuyBack = t.hops.findIndex((h: any) => h.outDenom === 'NAM');
      const own = (firstBuyBack < 0 ? t.hops : t.hops.slice(0, firstBuyBack)).filter((h: any) => h.inDenom === 'NAM');
      const netSum = own.reduce((a: number, h: any) => a + h.in, 0) / 1e6;
      expect(netSum).toBeCloseTo(t.nam, 6);
      expect(t.nam).not.toBeCloseTo(-t.settle.nam, 0);
      const gross = own.reduce((a: number, h: any) => a + h.in / ((1 - TAKER[h.pool as PoolId]) * (1 - spread[h.pool])), 0) / 1e6;
      expect(gross).toBeCloseTo(-t.settle.nam, 3);
    }
    const first = TRADES.find((x) => x.hash.startsWith('0FF2D1'));
    expect(first.nam).toBe(9946.068);
    expect(first.settle.nam).toBe(-10000);
  });
  it('the aggregate (the page’s own answer) for the two routed sells of 10,000 NAM, the three pools at their rebuilt states and OSMO at the transaction’s own hop: 0FF2D1 -0.020 % and 1097B1 +0.105 % against the settle, the research’s figures', () => {
    // verify-proto-walk.mjs: every pool with a hop in the transaction at its state before that hop, ref = pool 3005's spot, a pool with no hop left out
    const routed = TRADES.filter((t) => t.kind === 'sell' && t.pool_id.includes(','));
    expect(routed.map((t) => t.hash.slice(0, 6))).toEqual(['0FF2D1', '1097B1']);
    const rows = routed.map((t) => {
      const osmoHop = t.hops.find((h: any) => h.inDenom === 'OSMO' && /USDC|factory\/osmo147h/.test(h.outDenom));
      const osmoUsd = osmoHop.out / osmoHop.in;
      const pools: PricedPool[] = [];
      for (const id of POOL_IDS) {
        const h = hopsOf(id).find((x) => x.hash === t.hash && x.direction === 'sell NAM') ?? hopsOf(id).find((x) => x.hash === t.hash);
        if (!h) continue;
        pools.push({ id, type: 'concentrated', model: clModel(stateBefore(id, h), rangesAt(id, h.height, h.index), NAM_DENOM), counterUsd: id === '3005' ? 1 : osmoUsd, counterDecimals: 6, taker: TAKER[id] });
      }
      const ref = pools.find((p) => p.id === '3005')!.model.spotRaw!; // USDC per NAM, six decimals each: the raw price is the USD price
      const agg = aggregate(pools, buildGrid(ref), 6);
      const gross = Math.round(-t.settle.nam);
      const fill = executeSell(agg, pools, gross);
      return { hash: t.hash, gross, pools: pools.map((p) => p.id), fill, settleUsd: t.settle.coins.allUSDC as number, osmoUsd };
    });
    expect(rows.map((r) => r.gross)).toEqual([10000, 10000]);
    expect(rows.map((r) => r.pools)).toEqual([['3005', '3368'], ['3005', '3368', '3009']]);
    for (const r of rows) {
      const theirs = WALK.aggRows.find((x: any) => x.hash === r.hash);
      expect(r.fill.complete).toBe(true);
      expect(r.osmoUsd).toBeCloseTo(theirs.osmoUsdFromTx, 12);
      expect(r.settleUsd).toBe(theirs.settleUsd);
      // the module's curve and the prototype's agree to 0.01 % (the weighted-pool bisection and five stored digits apart)
      expect(Math.abs(pct(r.fill.usd, theirs.prototypeAggregateUsd))).toBeLessThan(0.01);
      expect(r.fill.split.map((s) => s.pool)).toEqual(theirs.prototypeSplit.map((s: any) => s.id));
      r.fill.split.forEach((s, i) => expect(Math.abs(pct(s.nam, theirs.prototypeSplit[i].nam))).toBeLessThan(0.05));
    }
    const diff = rows.map((r) => pct(r.fill.usd, r.settleUsd));
    expect(diff[0]).toBeCloseTo(-0.020, 2);
    expect(diff[1]).toBeCloseTo(0.105, 2);
    expect(rows[0].fill.usd).toBeCloseTo(10.338743, 3);
    expect(rows[1].fill.usd).toBeCloseTo(9.124401, 3);
    expect(WALK.aggRows.map((x: any) => +x.diffVsSettlePct.toFixed(3))).toEqual([-0.02, 0.105]);
  });
});
