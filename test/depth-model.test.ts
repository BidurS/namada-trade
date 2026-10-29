// The pool models and the aggregate against the chain's own answers and the prototype's verified minute (depth research,
// verify.txt sections 2 and 3, 2026-10-29 02:53-03:10 UTC):
//   - pool 3005 alone, selling 1,000 / 10,000 / 100,000 NAM: the exact walk equals the chain's estimate and the quote
//     service's direct quote to the base unit (verify-router.json, 02:59:47-48 UTC, heights 73,429,548-549), the Number
//     model within a base unit;
//   - the weighted pool 3439 and the stable pool 3398 from the gateway's answers (chain.txt section 3);
//   - the order book 3008 from its 34 live ticks: selling 1,000 NAM fetches 349,650 uUSDC, the quote service's own
//     custom-direct quote through pool 3008 (sqs_custom_quote_3008_sell.json);
//   - the aggregate over the prototype's 15 priced pools (proto_latest.json, 02:56 UTC): the 10,000 NAM sale is the
//     prototype's 9.924536 USDC, the eleven pools whose state the research saved rebuild the prototype's per-pool curves,
//     an unpriced pool is never summed, the fees are charged once, the offsets, the within figures, the touch, the heat
//     bands and their packing.
import { describe, it, expect } from 'vitest';
import {
  clModel, clSellExact, clBuyExact, balancerModel, stableswapModel, orderbookModel, tickToPrice, tickOfPrice,
  buildGrid, aggregate, aggregateOfCurves, executeSell, executeBuy, cumAt, offsetsAt, withinAt, touchAt, heatAt, packF32, unpackF32, thinIndices, levelsOf,
  type PricedPool, type Aggregate,
} from '../worker/src/depth/model';
import { DEPTH_OFFSETS_PCT, DEPTH_SIZES, HEAT_EDGES, HEAT_BANDS } from '../shared/depth';
import { depthFixture, depthFixtureHeader, NAM_DENOM, USDC_DENOM } from './depth-fixtures';

const BASE_DEC = 6;
const POOL_3005 = depthFixture<{ pool: any }>('verify-pool3005-now.json').pool;
const RANGES_3005 = depthFixture<{ liquidity: any[] }>('verify-ranges3005-now.json').liquidity;
const ROUTER = depthFixture<any>('verify-router.json');
const LATEST = depthFixture<any>('proto_latest.json');
const BOOK = depthFixture<any>('book_3008_full.json');
const GAMM_3439 = depthFixture<{ pool: any }>('lcd_gamm_pool_3439.json').pool;
const GAMM_3398 = depthFixture<{ pool: any }>('lcd_gamm_pool_3398.json').pool;
const TAKER_USDC = 0.001; // lcd_pm_taker_fee.json: trading_pair_takerfee NAM/USDC 0.001
const pct = (a: number, b: number) => (a / b - 1) * 100;

describe('pool 3005 alone: the single-pool walk is the chain’s to the base unit', () => {
  const sizes = [1000, 10000, 100000];
  it('the fixtures are the chain’s estimate and the direct quote at 02:59:47-48 UTC, height 73,429,548-549', () => {
    expect(ROUTER.estimateRaw.map((e: any) => e.token_out_amount)).toEqual(['1014160', '9909129', '74977024']);
    expect(ROUTER.directRaw.map((e: any) => e.amount_out)).toEqual(['1014160', '9909129', '74977024']);
    expect(ROUTER.estimateRaw.every((e: any) => e.status === 200 && e.height >= 73429548)).toBe(true);
    expect(POOL_3005.current_sqrt_price).toBe('0.031935379420358432301010285098659131');
    expect(RANGES_3005.length).toBe(31);
  });
  it.each(sizes)('selling %s NAM: the exact (BigInt) walk gives the chain’s uUSDC exactly, taker fee and spread charged once', (n) => {
    const r = clSellExact(POOL_3005, RANGES_3005, NAM_DENOM, BigInt(n) * 1_000_000n, TAKER_USDC);
    const chain = BigInt(ROUTER.estimateRaw[sizes.indexOf(n)].token_out_amount);
    expect(r.amountOut).toBe(chain);
    expect(r.unfilledIn).toBe(0n);
    expect(r.takerFee).toBe(BigInt(n) * 1_000n); // 0.1 % of the input
    // the net input that moved the price is the gross less the taker fee less the 0.2 % spread, to a base unit
    const net = Number(r.netIn);
    expect(Math.abs(net - n * 1e6 * 0.999 * 0.998)).toBeLessThanOrEqual(1);
  });
  it.each(sizes)('selling %s NAM: the Number model’s exact-in walk lands within one base unit of the chain', (n) => {
    const m = clModel(POOL_3005, RANGES_3005, NAM_DENOM);
    const out = m.sellIn(n * 1e6 * (1 - TAKER_USDC) * (1 - m.spread));
    const chain = Number(ROUTER.estimateRaw[sizes.indexOf(n)].token_out_amount);
    expect(Math.floor(out)).toBe(chain);
    expect(Math.abs(pct(out, chain))).toBeLessThan(1e-4);
  });
  it('the 100,000 NAM sale crosses seven ranges; the exact walk and the model agree on where the price ends', () => {
    const r = clSellExact(POOL_3005, RANGES_3005, NAM_DENOM, 100_000_000_000n, TAKER_USDC);
    expect(r.stepsCrossed).toBe(7);
    const endPrice = Number(r.sqrtAfter) / 1e36;
    expect(endPrice * endPrice).toBeLessThan(0.00102 * 0.5); // chain.txt 1c: 100,000 NAM moves the price 51.9 % down
    expect(endPrice * endPrice).toBeGreaterThan(0.00102 * 0.45);
  });
  it('buying with USDC walks the other way: 10 USDC buys about 9,541 NAM (chain.txt 1c), the taker fee on the USDC', () => {
    const r = clBuyExact(POOL_3005, RANGES_3005, NAM_DENOM, 10_000_000n, TAKER_USDC);
    expect(Number(r.amountOut) / 1e6).toBeGreaterThan(9500);
    expect(Number(r.amountOut) / 1e6).toBeLessThan(9600);
    expect(r.takerFee).toBe(10_000n);
    const m = clModel(POOL_3005, RANGES_3005, NAM_DENOM);
    expect(Math.abs(pct(m.buyIn(10e6 * 0.999 * 0.998), Number(r.amountOut)))).toBeLessThan(1e-4);
  });
  it('a sale larger than the whole bid side leaves input unfilled instead of inventing liquidity', () => {
    const r = clSellExact(POOL_3005, RANGES_3005, NAM_DENOM, 10n ** 19n, TAKER_USDC);
    expect(r.unfilledIn).toBeGreaterThan(0n);
    expect(r.stepsCrossed).toBe(RANGES_3005.filter((x) => Number(x.lower_tick) < -26980132).length);
    expect(Number(r.amountOut) / 1e6).toBeLessThanOrEqual(187.52); // the pool held 187.51 USDC
  });
  describe('the price in a gap of the tick map (no position holds the current tick): the walk starts at the next range’s edge, filling nothing across the gap', () => {
    // the pool as it is, with the one range that holds the current tick (-28,480,000 to -26,903,000) taken out: tick -26,980,132 is then in a gap
    const CT = -26_980_132;
    const inGap = RANGES_3005.filter((r) => !(Number(r.lower_tick) <= CT && CT < Number(r.upper_tick)));
    it('the fixture’s current tick sits in one range; without it the tick is in a gap from -28,480,000 to -26,903,000 (0.000852 to 0.001097 USDC per NAM)', () => {
      expect(RANGES_3005.length - inGap.length).toBe(1);
      expect(Math.max(...inGap.filter((r) => Number(r.upper_tick) <= CT).map((r) => Number(r.upper_tick)))).toBe(-28_480_000);
      expect(Math.min(...inGap.filter((r) => Number(r.lower_tick) > CT).map((r) => Number(r.lower_tick)))).toBe(-26_903_000);
      expect(tickToPrice(-28_480_000)).toBeCloseTo(0.000852, 9);
      expect(tickToPrice(-26_903_000)).toBeCloseTo(0.001097, 9);
    });
    it.each([1000, 10000])('selling %s NAM: the exact walk and the Number model agree to a base unit, and both give less than the full map does', (n) => {
      const r = clSellExact(POOL_3005, inGap, NAM_DENOM, BigInt(n) * 1_000_000n, TAKER_USDC);
      const m = clModel(POOL_3005, inGap, NAM_DENOM);
      const out = m.sellIn(n * 1e6 * (1 - TAKER_USDC) * (1 - m.spread));
      expect(r.unfilledIn).toBe(0n);
      expect(Math.abs(Number(r.amountOut) - out)).toBeLessThan(2);
      const full = clSellExact(POOL_3005, RANGES_3005, NAM_DENOM, BigInt(n) * 1_000_000n, TAKER_USDC);
      expect(r.amountOut).toBeLessThan(full.amountOut);
      // the first coins fetch the gap’s far edge price (0.000852 USDC per NAM at tick -28,480,000), not the pool’s own 0.00102
      expect(Number(r.amountOut) / (n * 1e6)).toBeLessThan(tickToPrice(-28_480_000));
      expect(Number(r.sqrtAfter) / 1e36).toBeLessThan(Math.sqrt(tickToPrice(-28_480_000)));
    });
    it('buying with 10 USDC walks up from the gap’s upper edge (tick -26,903,000) the same way', () => {
      const r = clBuyExact(POOL_3005, inGap, NAM_DENOM, 10_000_000n, TAKER_USDC);
      const m = clModel(POOL_3005, inGap, NAM_DENOM);
      expect(r.unfilledIn).toBe(0n);
      expect(Math.abs(Number(r.amountOut) - m.buyIn(10e6 * 0.999 * 0.998))).toBeLessThan(2);
      expect(r.amountOut).toBeLessThan(clBuyExact(POOL_3005, RANGES_3005, NAM_DENOM, 10_000_000n, TAKER_USDC).amountOut);
      expect(Number(r.sqrtAfter) / 1e36).toBeGreaterThan(Math.sqrt(tickToPrice(-26_903_000)));
      expect(Number(r.amountOut) / (10e6 * 0.999 * 0.998)).toBeLessThan(1 / tickToPrice(-26_903_000));
    });
    it('a map with nothing on the sell side fills nothing', () => {
      const above = RANGES_3005.filter((r) => Number(r.lower_tick) >= -26_903_000);
      const r = clSellExact(POOL_3005, above, NAM_DENOM, 1_000_000_000n, TAKER_USDC);
      expect(r.amountOut).toBe(0n);
      expect(r.unfilledIn).toBe(1_000_000_000n - r.takerFee);
    });
  });
  it('the Number model names the pool: spot, spread, 31 ranges, NAM as token0, the limits of its liquidity', () => {
    const m = clModel(POOL_3005, RANGES_3005, NAM_DENOM);
    expect(m.spotRaw).toBeCloseTo(0.0010198684587, 12);
    expect(m.spread).toBe(0.002);
    expect(m.ranges).toBe(31);
    expect(m.namIs0).toBe(true);
    expect(m.currentTick).toBe(-26980132);
    expect(m.minRaw).toBeCloseTo(1e-12, 20);
    expect(m.sellTo(m.spotRaw * 2)).toEqual({ namIn: 0, counterOut: 0 });
    expect(m.buyTo(m.spotRaw / 2)).toEqual({ counterIn: 0, namOut: 0 });
    expect(m.levels().length).toBe(31);
    expect(tickOfPrice(m.spotRaw)).toBe(-26980132);
  });
});

describe('the weighted and stable pools (chain.txt section 3)', () => {
  it('3439 (50/50, 1 % fee): spot 0.0010308 USDC per NAM; 990 NAM net gives 13.665 x 990 / (13,257 + 990) = 0.9496 USDC', () => {
    const assets = GAMM_3439.pool_assets.map((a: any) => ({ denom: a.token.denom, amount: a.token.amount, weight: a.weight }));
    const m = balancerModel(assets, Number(GAMM_3439.pool_params.swap_fee), NAM_DENOM);
    expect(m.Rc).toBe(13_665_263);
    expect(m.Rn).toBe(13_256_987_688);
    expect(m.wn).toBe(m.wc);
    expect(m.spotRaw).toBeCloseTo(0.0010308, 7);
    const closedForm = 13_665_263 * 990e6 / (13_256_987_688 + 990e6);
    expect(m.sellIn(990e6)).toBeCloseTo(closedForm, 3);
    expect(m.sellIn(990e6) / 1e6).toBeCloseTo(0.9496, 4);
    // the price after that sale is 13.4 % under the spot (chain.txt), and sellTo at that price asks for the same input
    const after = (m.Rc - m.sellIn(990e6)) / (m.Rn + 990e6);
    expect(pct(after, m.spotRaw)).toBeCloseTo(-13.4, 0);
    expect(m.sellTo(after).namIn).toBeCloseTo(990e6, -1);
    expect(m.buyIn(1e6)).toBeGreaterThan(0);
    expect(m.levels()).toEqual([{ lo: m.spotRaw, hi: m.spotRaw, nam: m.Rn, counter: m.Rc }]);
  });
  it('3398 (stableswap, scaling 1/1, 1 % fee) holds 3,340 uUSDC and 3,761,574 uNAM: nothing it gives exceeds its USDC', () => {
    const m = stableswapModel(GAMM_3398.pool_liquidity, GAMM_3398.scaling_factors, Number(GAMM_3398.pool_params.swap_fee), NAM_DENOM);
    expect(m.spotRaw).toBeGreaterThan(0);
    expect(m.sellIn(1e9)).toBeLessThanOrEqual(3340);
    expect(m.sellIn(1e9)).toBeGreaterThan(3000);
    const s = m.sellTo(m.spotRaw * 0.5);
    expect(s.namIn).toBeGreaterThan(0);
    expect(s.counterOut).toBeLessThanOrEqual(3340);
    expect(m.buyTo(m.spotRaw * 2).namOut).toBeLessThanOrEqual(3_761_574);
    // a sale pushed down to a price and the same input walked exactly give the same USDC
    expect(m.sellIn(s.namIn)).toBeCloseTo(s.counterOut, 3);
  });
});

/** The book from its live ticks: bids rest in uUSDC, asks in uNAM, the price from the tick (chain.txt section 2). */
const bookModel = () => orderbookModel(
  BOOK.live_ticks.filter((t: any) => Number(t.bid_liq) > 0).map((t: any) => ({ price: tickToPrice(t.tick_id), quote: Number(t.bid_liq) })),
  BOOK.live_ticks.filter((t: any) => Number(t.ask_liq) > 0).map((t: any) => ({ price: tickToPrice(t.tick_id), base: Number(t.ask_liq) })),
  0,
);
describe('the order book 3008 (book_3008_full.json, 02:15:43 UTC: 373 ticks, 34 live, 43 orders)', () => {
  it('best bid 0.00035, best ask 0.00125; 174.70 USDC of bids and 810,665 NAM of asks', () => {
    const m = bookModel();
    expect(m.bestBid).toBeCloseTo(0.00035, 12);
    expect(m.bestAsk).toBeCloseTo(0.00125, 12);
    expect(m.sellTo(0).counterOut).toBe(Number(BOOK.sides.bid.remaining_base_units));
    expect(m.buyTo(Infinity).namOut).toBe(Number(BOOK.sides.ask.remaining_base_units));
    expect(m.sellTo(0).counterOut / 1e6).toBeCloseTo(174.700606, 6);
  });
  it('selling 1,000 NAM: 999 NAM after the taker fee at 0.00035 is 349,650 uUSDC, the quote service’s custom-direct quote through 3008', () => {
    const quote = depthFixture<any>('sqs_custom_quote_3008_sell.json');
    expect(quote.amount_out).toBe('349650');
    expect(quote.route[0].pools[0].id).toBe(3008);
    expect(quote.route[0].pools[0].taker_fee).toBe('0.001000000000000000');
    expect(bookModel().sellIn(1000e6 * (1 - TAKER_USDC))).toBe(349_650);
    expect(bookModel().sellIn(1000e6 * (1 - TAKER_USDC)) / 1e6).toBe(0.34965);
  });
  it('100 USDC buys 79,920 NAM: 99.9 USDC at 0.00125 (chain.txt section 2)', () => {
    expect(bookModel().buyIn(100e6 * (1 - TAKER_USDC)) / 1e6).toBeCloseTo(79_920, 6);
  });
  it('an order fills at its own price, in full once the marginal price reaches it: sellTo and sellIn agree on every level', () => {
    const m = bookModel();
    for (const p of [0.00035, 0.0002, 0.0001]) { const s = m.sellTo(p); expect(m.sellIn(s.namIn)).toBeCloseTo(s.counterOut, 6); }
    expect(m.levels().filter((l) => l.side === 'bid').length).toBe(3);
    expect(m.levels().filter((l) => l.side === 'ask').length).toBe(31);
  });
});

// ------------------------------------------------------------------------------------- the aggregate on the prototype's minute
const ref: number = LATEST.refSpotUsd;
const poolOf = (id: string) => LATEST.pools.find((p: any) => p.id === id);
const priced = (id: string, model: PricedPool['model']): PricedPool => { const p = poolOf(id); return { id, type: p.type, model, counterUsd: p.counterUsd, counterDecimals: p.counterDecimals, taker: p.taker }; };
/** The eleven priced pools whose state the research saved at the same state as the prototype's minute. */
function rebuilt(): PricedPool[] {
  const cl = (id: string) => priced(id, clModel(depthFixture<any>(`verify-pool${id}-now.json`).pool, depthFixture<any>(`verify-ranges${id}-now.json`).liquidity, NAM_DENOM));
  const gammFromLatest = (id: string) => { const p = poolOf(id); return priced(id, balancerModel([{ denom: NAM_DENOM, amount: p.gamm.Rn, weight: p.gamm.wn }, { denom: p.counterDenom, amount: p.gamm.Rc, weight: p.gamm.wc }], p.spread, NAM_DENOM)); };
  return [
    cl('3005'), cl('3368'), cl('3009'),
    priced('3439', balancerModel(GAMM_3439.pool_assets.map((a: any) => ({ denom: a.token.denom, amount: a.token.amount, weight: a.weight })), Number(GAMM_3439.pool_params.swap_fee), NAM_DENOM)),
    priced('3398', stableswapModel(GAMM_3398.pool_liquidity, GAMM_3398.scaling_factors, Number(GAMM_3398.pool_params.swap_fee), NAM_DENOM)),
    priced('3008', bookModel()),
    ...['3402', '3367', '3062', '3454', '3007'].map(gammFromLatest),
  ];
}
const protoCurves = (ids: string[]) => ids.map((id) => LATEST.perPoolCurves.find((c: any) => c.id === id));

describe('the aggregate (proto_latest.json: the prototype’s minute at 02:56 UTC, 15 priced pools, pool 3005 at height 73,429,291)', () => {
  it('the fixture is that minute: ref 0.001019868 USD per NAM, 15 priced pools, 3020 unpriced for want of a price', () => {
    expect(depthFixtureHeader('proto_latest.json')[0]).toContain('02:56:03');
    expect(ref).toBeCloseTo(0.001019868458722253, 18);
    expect(LATEST.pricedIds.length).toBe(15);
    expect(LATEST.unpriced).toEqual([expect.objectContaining({ id: '3020', why: 'SQS price list gives this coin no price' })]);
    expect(LATEST.sells.map((s: any) => s.nam)).toEqual([...DEPTH_SIZES]);
  });
  it('the grid is the prototype’s: 2,978 points, a quarter percent apart within four times the reference, one percent beyond', () => {
    const g = buildGrid(ref);
    expect(g.length).toBe(LATEST.grid.price.length);
    expect(g.length).toBe(2978);
    g.forEach((p, i) => expect(Math.abs(pct(p, LATEST.grid.price[i]))).toBeLessThan(1e-3));
    const i = g.indexOf(ref);
    expect(g[i + 1] / g[i]).toBeCloseTo(1.0025, 10);
    expect(g[1] / g[0]).toBeCloseTo(1 / 0.99, 10);
  });
  it('summing the prototype’s 15 per-pool curves and walking them gives its eight executable figures: selling 10,000 NAM fetches 9.924536 USDC', () => {
    const agg = aggregateOfCurves(LATEST.grid.price, protoCurves(LATEST.pricedIds));
    const pools = LATEST.pricedIds.map((id: string) => ({ id }));
    const sell10k = executeSell(agg, pools, 10_000);
    expect(sell10k.usd).toBeCloseTo(9.924536, 3);
    expect(Math.abs(pct(sell10k.usd, LATEST.sells[1].usdOut))).toBeLessThan(0.01);
    expect(sell10k.complete).toBe(true);
    expect(sell10k.split[0].pool).toBe('3005');
    expect(sell10k.split.map((s) => s.pool)).toEqual(LATEST.sells[1].split.map((s: any) => s.id));
    LATEST.sells.forEach((s: any) => expect(Math.abs(pct(executeSell(agg, pools, s.nam).usd, s.usdOut))).toBeLessThan(0.01));
    LATEST.buys.forEach((b: any) => expect(Math.abs(pct(executeBuy(agg, pools, b.nam).usd, b.usdIn))).toBeLessThan(0.01));
    expect(executeSell(agg, pools, 1_000_000).split[0].pool).toBe('3008'); // the million-NAM sale is mostly the book's deep bids
  });
  it('the eleven pools with saved state rebuild the prototype’s per-pool curves on the grid (bid and ask, USD and NAM)', () => {
    const pools = rebuilt();
    const grid = buildGrid(ref);
    const agg = aggregate(pools, grid, BASE_DEC);
    const proto = protoCurves(pools.map((p) => p.id));
    const keys = ['bidNam', 'bidUsd', 'askNam', 'askUsd'] as const;
    pools.forEach((p, pi) => {
      let worst = 0;
      for (const k of keys) for (let i = 0; i < grid.length; i += 7) {
        const mine = agg.perPool[pi][k][i], theirs = proto[pi][k][i];
        if (theirs > 1e-3) worst = Math.max(worst, Math.abs(mine / theirs - 1)); else expect(mine).toBeLessThan(2e-3);
      }
      // the prototype stored five significant digits; the weighted pools' bisection adds its own 1e-6
      expect(worst, `pool ${p.id}`).toBeLessThan(1e-4);
    });
  });
  it('the whole aggregate (eleven rebuilt pools and the four small concentrated pools’ prototype curves) sells 10,000 NAM for 9.924536 USDC', () => {
    const pools = rebuilt();
    const grid = buildGrid(ref);
    const mine = aggregate(pools, grid, BASE_DEC);
    const rest = LATEST.pricedIds.filter((id: string) => !pools.some((p) => p.id === id));
    expect(rest.sort()).toEqual(['3015', '3017', '3052', '3405']);
    const merged = aggregateOfCurves(grid, [...mine.perPool, ...protoCurves(rest)]);
    const all = [...pools, ...rest.map((id: string) => ({ id }))];
    const s = executeSell(merged, all, 10_000);
    expect(s.usd).toBeCloseTo(9.924536, 3);
    expect(s.split.slice(0, 4).map((x) => x.pool)).toEqual(['3005', '3439', '3368', '3402']);
    expect(Math.abs(pct(executeSell(merged, all, 1_000).usd, 1.014940713783082))).toBeLessThan(0.01);
    expect(Math.abs(pct(executeSell(merged, all, 100_000).usd, 85.1993017158378))).toBeLessThan(0.01);
    expect(Math.abs(pct(executeBuy(merged, all, 10_000).usd, 10.386852248241361))).toBeLessThan(0.01);
  });
  it('the fees are charged once: pool 3005 alone on the USD axis sells 1,000 NAM for the chain’s 1.014160 USDC (the grid’s linear steps, a quarter percent apart, cost 0.012 % here; the exact walk is for the chain check)', () => {
    const pools = [rebuilt()[0]];
    const agg = aggregate(pools, buildGrid(ref), BASE_DEC);
    const s = executeSell(agg, pools, 1_000);
    expect(Math.abs(pct(s.usd, 1.01416))).toBeLessThan(0.05);
    // charging the spread or the taker fee twice would put it 0.1-0.2 % under
    expect(Math.abs(pct(s.usd, 1.01416 * (1 - 0.002)))).toBeGreaterThan(0.1);
    expect(Math.abs(pct(s.usd, 1.01416 * (1 - 0.001)))).toBeGreaterThan(0.05);
    expect(s.split.length).toBe(1);
    expect(s.split[0].pool).toBe('3005');
    expect(s.split[0].nam).toBeCloseTo(1000, 6);
    expect(s.split[0].usd).toBeCloseTo(1.01416, 3);
    // the bid curve's NAM is gross (what the trader pays), the USD is what comes out; the grid's first step under the
    // reference holds the effective price after both fees, so a one-NAM sale's marginal price is read within that step
    const touch = executeSell(agg, pools, 1);
    const eff = ref * (1 - 0.002) * (1 - 0.001);
    expect(touch.marginalPrice).toBeLessThanOrEqual(ref);
    expect(touch.marginalPrice).toBeGreaterThan(eff * (1 - 0.0025));
    // the first step under the reference (a quarter percent) is still above the effective spot (0.3 % of fees): nothing rests there
    expect(agg.bidNam[agg.grid.indexOf(ref)]).toBe(0);
    expect(agg.bidNam[agg.grid.indexOf(ref) - 1]).toBe(0);
    expect(agg.bidNam[agg.grid.indexOf(ref) - 2]).toBeGreaterThan(0);
  });
  it('an unpriced pool is never summed: with no USD price for its coin its curve is zero and the total is unchanged', () => {
    const pools = rebuilt();
    const grid = buildGrid(ref);
    const withPrice = aggregate(pools, grid, BASE_DEC);
    const unpriced = pools.map((p) => (p.id === '3368' ? { ...p, counterUsd: 0 } : p));
    const without = aggregate(unpriced, grid, BASE_DEC);
    const i3368 = pools.findIndex((p) => p.id === '3368');
    expect(without.perPool[i3368].bidUsd.every((v) => v === 0)).toBe(true);
    expect(withPrice.perPool[i3368].bidUsd[0]).toBeGreaterThan(0);
    expect(without.bidUsd[0]).toBeCloseTo(withPrice.bidUsd[0] - withPrice.perPool[i3368].bidUsd[0], 9);
  });
  it('a size beyond the last bid answers complete: false with what could be filled, never more', () => {
    const agg = aggregateOfCurves(LATEST.grid.price, protoCurves(LATEST.pricedIds));
    const pools = LATEST.pricedIds.map((id: string) => ({ id }));
    const s = executeSell(agg, pools, 1e9);
    expect(s.complete).toBe(false);
    expect(s.filledNam).toBeCloseTo(agg.bidNam[0], 6);
    expect(Math.abs(pct(s.usd, LATEST.within.totalBidUsd))).toBeLessThan(0.01);
    const b = executeBuy(agg, pools, 1e9);
    expect(b.complete).toBe(false);
    expect(Math.abs(pct(b.filledNam, LATEST.within.totalAskNam))).toBeLessThan(0.01);
  });
  describe('the figures stored each minute, from the prototype’s curves', () => {
    const agg: Aggregate = aggregateOfCurves(LATEST.grid.price, protoCurves(LATEST.pricedIds));
    const pools = LATEST.pricedIds.map((id: string) => ({ id }));
    it('the within figures are the prototype’s (USD of bids within 10 / 25 / 50 %, NAM for sale within 10 / 25 %)', () => {
      const w = withinAt(agg, ref);
      // the fixture's curves carry five significant digits a pool, so the sums agree to 0.01 %
      expect(Math.abs(pct(w.bidUsd10, LATEST.within.bidUsd10pct))).toBeLessThan(0.01);
      expect(Math.abs(pct(w.bidUsd25, LATEST.within.bidUsd25pct))).toBeLessThan(0.01);
      expect(Math.abs(pct(w.bidUsd50, LATEST.within.bidUsd50pct))).toBeLessThan(0.01);
      expect(Math.abs(pct(w.askNam10, LATEST.within.askNam10pct))).toBeLessThan(0.01);
      expect(Math.abs(pct(w.askNam25, LATEST.within.askNam25pct))).toBeLessThan(0.01);
      expect(Math.abs(pct(w.askUsd10, LATEST.within.askUsd10pct))).toBeLessThan(0.01);
      expect(Math.abs(pct(w.totalBidUsd, LATEST.within.totalBidUsd))).toBeLessThan(0.01);
    });
    it('the offsets at 1 / 2 / 5 / 10 / 25 / 50 % each side are monotone and the 10 % entries are the within figures', () => {
      const o = offsetsAt(agg, ref, DEPTH_OFFSETS_PCT);
      expect(o.bid.length).toBe(6);
      expect(o.bid[3]).toBeCloseTo(withinAt(agg, ref).bidUsd10, 9);
      expect(o.ask[3]).toBeCloseTo(withinAt(agg, ref).askUsd10, 9);
      for (let i = 1; i < 6; i++) { expect(o.bid[i]).toBeGreaterThanOrEqual(o.bid[i - 1]); expect(o.ask[i]).toBeGreaterThanOrEqual(o.ask[i - 1]); }
      expect(o.bid[5]).toBeCloseTo(cumAt(agg, 'bidUsd', ref * 0.5), 9);
    });
    it('the touch for 100 NAM: best bid 0.0010168 from pool 3005, best ask 0.00099267 from pool 3009 (the prototype’s)', () => {
      const t = touchAt(agg, pools, 100);
      expect(t.bestBidEff).toBeCloseTo(LATEST.bestBidEff, 7);
      expect(t.bestAskEff).toBeCloseTo(LATEST.bestAskEff, 7);
      expect(t.bestBidPool).toBe('3005');
      expect(t.bestAskPool).toBe('3009');
      expect(t.sizeNam).toBe(100);
    });
    it('a side holding fewer coins than the touch size has no touch: null each way, never the grid’s end', () => {
      // one pool’s curve scaled so that fifty NAM is all that rests on its larger side: under 100 NAM either way
      const small = protoCurves(['3005']).map((c: any) => { const k = 50 / Math.max(c.bidNam[0], c.askNam[c.askNam.length - 1]); return { bidNam: c.bidNam.map((v: number) => v * k), bidUsd: c.bidUsd.map((v: number) => v * k), askNam: c.askNam.map((v: number) => v * k), askUsd: c.askUsd.map((v: number) => v * k) }; });
      const thin = aggregateOfCurves(LATEST.grid.price, small);
      expect(thin.bidNam[0]).toBeLessThan(100);
      expect(thin.askNam[thin.askNam.length - 1]).toBeLessThan(100);
      const t = touchAt(thin, [{ id: '3005' }], 100);
      expect(t).toEqual({ bestBidEff: null, bestBidPool: null, bestAskEff: null, bestAskPool: null, sizeNam: 100 });
      // one coin can be filled: a price each way (under the reference for the bid, over it for the ask) and the pool
      const one = touchAt(thin, [{ id: '3005' }], 1);
      expect(one.bestBidEff).toBeGreaterThan(0);
      expect(one.bestBidEff).toBeLessThan(ref);
      expect(one.bestAskEff).toBeGreaterThan(ref);
      expect(one.bestBidPool).toBe('3005');
      expect(one.bestAskPool).toBe('3005');
      // an empty side alone: no bids, asks as before
      const noBids = aggregateOfCurves(LATEST.grid.price, [{ ...small[0], bidNam: small[0].bidNam.map(() => 0), bidUsd: small[0].bidUsd.map(() => 0) }]);
      expect(touchAt(noBids, [{ id: '3005' }], 1).bestBidEff).toBeNull();
      expect(touchAt(noBids, [{ id: '3005' }], 1).bestAskEff).toBe(one.bestAskEff);
    });
    it('the heat bands: 112 bands from a quarter to almost four times the reference, their USD summing to the curve between those prices, packed as float32', () => {
      expect(HEAT_EDGES.length).toBe(HEAT_BANDS + 1);
      expect(HEAT_EDGES[0]).toBe(0.25);
      expect(HEAT_EDGES[HEAT_BANDS]).toBeCloseTo(3.972, 3);
      const h = heatAt(agg, ref);
      expect(h.bid.length).toBe(112);
      const bidSum = h.bid.reduce((a, v) => a + v, 0);
      expect(bidSum).toBeCloseTo(cumAt(agg, 'bidUsd', ref * 0.25) - cumAt(agg, 'bidUsd', ref * HEAT_EDGES[112]), 2);
      const askSum = h.ask.reduce((a, v) => a + v, 0);
      expect(askSum).toBeCloseTo(cumAt(agg, 'askUsd', ref * HEAT_EDGES[112]) - cumAt(agg, 'askUsd', ref * 0.25), 2);
      const packed = packF32(h.bid);
      expect(packed.length).toBe(600); // 448 bytes of float32 in base64
      const back = unpackF32(packed);
      expect(back.length).toBe(112);
      back.forEach((v, i) => expect(v).toBe(h.bid[i]));
      expect(packed).toBe(btoa(String.fromCharCode(...new Uint8Array(h.bid.buffer))));
      // a long array packs too (a spread into fromCharCode would throw past its argument limit)
      const long = Float32Array.from({ length: 200_000 }, (_, i) => (i % 97) * 1.5);
      const back2 = unpackF32(packF32(long));
      expect(back2.length).toBe(200_000);
      expect(back2[199_999]).toBe(long[199_999]);
      expect(back2.every((v, i) => v === long[i])).toBe(true);
    });
    it('the curve is thinned to at most 400 points a side with the reference and both ends kept', () => {
      const refI = LATEST.grid.price.findIndex((p: number) => p >= ref);
      const idx = thinIndices(LATEST.grid.price.length, refI, 400);
      expect(idx[0]).toBe(0);
      expect(idx[idx.length - 1]).toBe(LATEST.grid.price.length - 1);
      expect(idx).toContain(refI);
      expect(idx.filter((i) => i <= refI).length).toBeLessThanOrEqual(400);
      expect(idx.filter((i) => i >= refI).length).toBeLessThanOrEqual(400);
    });
    it('the raw levels: pool 3005’s 31 ranges and the book’s 34 levels in USD per NAM, with the pool, fee and side', () => {
      const pools = rebuilt();
      const levels = levelsOf(pools, BASE_DEC, () => 0);
      const l3005 = levels.filter((l) => l.pool === '3005');
      expect(l3005.length).toBe(31);
      expect(l3005.every((l) => l.spread === 0.002 && l.taker === 0.001 && l.type === 'concentrated' && l.positions === 0)).toBe(true);
      const across = l3005.find((l) => l.loUsd < ref && ref < l.hiUsd);
      expect(across?.side).toBe('both');
      expect(across!.nam).toBeGreaterThan(0);
      expect(across!.counterUsd).toBeGreaterThan(0);
      const book = levels.filter((l) => l.pool === '3008');
      expect(book.length).toBe(34);
      expect(book.filter((l) => l.side === 'bid').map((l) => l.loUsd)).toEqual([0.00035, 0.0002, 0.0001].map((p) => expect.closeTo(p, 12)));
      expect(book.filter((l) => l.side === 'bid').reduce((a, l) => a + l.counterUsd, 0)).toBeCloseTo(174.700606, 6);
      expect(levels.filter((l) => l.pool === '3439')).toEqual([expect.objectContaining({ side: 'both', nam: expect.closeTo(13256.987688, 6), counter: expect.closeTo(13.665263, 6) })]);
    });
  });
});

describe('the USDC denom the fixtures carry is the one the models key the book on', () => {
  it('pool 3005 is NAM/USDC', () => {
    expect(POOL_3005.token0).toBe(NAM_DENOM);
    expect(POOL_3005.token1).toBe(USDC_DENOM);
  });
});
