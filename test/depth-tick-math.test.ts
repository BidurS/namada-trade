// The concentrated-liquidity tick math against pool 3005's own state (depth research, chain.txt section 1c, read
// 2026-10-29 02:12-02:17 UTC): 9,000,000 ticks per power of ten, the round trip of the pool's spot, the 19 positions'
// amounts re-derived from their liquidity and ticks, the in-range liquidity adding up to current_tick_liquidity, and the
// tick store walked with liquidity_net giving liquidity_per_tick_range to the last digit.
import { describe, it, expect } from 'vitest';
import { tickToPrice, priceToTick, tickOfPrice, tickToPriceScaled, tickToSqrtScaled, isqrt, positionAmounts, rangesFromTicks, BIG_ONE } from '../worker/src/depth/model';
import { scaledToDec, decToScaled } from '../worker/src/depth/proto';
import { depthFixture } from './depth-fixtures';

/** poolmanager Query/Pool for 3005 over the chain node, height 73,426,608 (Dec and BigDec as integer strings on the wire). */
const POOL = depthFixture<Record<string, string>>('rpc_pm_pool_3005.json');
/** The 19 PositionById answers of the pool-to-position index (height 73,426,639; owners anonymized by the research). */
const POSITIONS = depthFixture<any[]>('rpc_cl_positions_3005.json');
/** The tick store under 0x01|3005: 32 TickInfo records (height 73,426,642). */
const TICKS = depthFixture<{ key_hex: string; tick_key_hex: string; liquidity_gross: string; liquidity_net: string }[]>('rpc_store_subspace_ticks_3005.json');
/** liquidity_per_tick_range for 3005 over the REST gateway (3,241 bytes, 02:12:33 UTC). */
const RANGES = depthFixture<{ liquidity: { liquidity_amount: string; lower_tick: string; upper_tick: string }[] }>('lcd_cl_liq_per_tick_3005.json');

const sqrtP = Number(POOL.current_sqrt_price) / 1e36;
const curTick = Number(POOL.current_tick);
const tickOfKey = (hex: string) => Number(BigInt.asIntN(64, BigInt('0x' + hex)));

describe('tick to price and back (chain.txt 1c)', () => {
  it('tick 0 is price 1 and each decade has 9,000,000 ticks', () => {
    expect(tickToPrice(0)).toBe(1);
    expect(tickToPrice(-9_000_000)).toBeCloseTo(0.1, 15);
    expect(tickToPrice(9_000_000)).toBe(10);
    expect(tickToPrice(-27_000_000)).toBeCloseTo(0.001, 15);
    expect(tickToPrice(-33_500_000)).toBeCloseTo(0.00035, 15);
  });
  it('the pool’s current tick -26,980,132 is price 0.001019868, and the spot squared rounds back to that tick', () => {
    expect(tickToPrice(curTick)).toBeCloseTo(0.001019868, 12);
    expect(curTick).toBe(-26_980_132);
    expect(Math.round(priceToTick(0.001019868))).toBe(-26_980_132);
    expect(tickOfPrice(sqrtP * sqrtP)).toBe(-26_980_132);
    // the spot lies inside [tick, tick + 1)
    expect(sqrtP * sqrtP).toBeGreaterThanOrEqual(tickToPrice(curTick));
    expect(sqrtP * sqrtP).toBeLessThan(tickToPrice(curTick + 1));
  });
  it('the exact (BigInt) price of a tick is the decimal the formula gives, and its sqrt at 36 decimals squares back under the price', () => {
    expect(scaledToDec(tickToPriceScaled(-26_980_132).toString(), 36)).toBe('0.001019868000000000000000000000000000');
    expect(tickToPriceScaled(0)).toBe(BIG_ONE);
    expect(tickToPriceScaled(-108_000_000)).toBe(decToScaled('0.000000000001', 36));
    expect(tickToPriceScaled(342_000_000)).toBe(10n ** 38n * BIG_ONE);
    const s = tickToSqrtScaled(-27_000_000);
    expect(s * s <= decToScaled('0.001', 36) * BIG_ONE).toBe(true);
    expect((s + 1n) * (s + 1n) > decToScaled('0.001', 36) * BIG_ONE).toBe(true);
    expect(isqrt(10n ** 72n)).toBe(10n ** 36n);
    expect(isqrt(99n)).toBe(9n);
  });
});

describe('the 19 positions of pool 3005 re-derived from liquidity and ticks', () => {
  it('every amount above 1,000 base units lands within 1e-5 of the chain’s own figure (chain.txt: worst 9.7e-6)', () => {
    let worst = 0;
    for (const p of POSITIONS) {
      const L = Number(p.liquidity) / 1e18;
      const { amt0, amt1 } = positionAmounts(L, Number(p.lower_tick), Number(p.upper_tick), sqrtP);
      const r0 = Number(p.asset0.amount), r1 = Number(p.asset1.amount);
      if (r0 > 1000) worst = Math.max(worst, Math.abs(amt0 - r0) / r0);
      if (r1 > 1000) worst = Math.max(worst, Math.abs(amt1 - r1) / r1);
      if (r0 <= 1000) expect(Math.abs(amt0 - r0)).toBeLessThan(2);
      if (r1 <= 1000) expect(Math.abs(amt1 - r1)).toBeLessThan(2);
    }
    expect(POSITIONS.length).toBe(19);
    expect(worst).toBeLessThan(1e-5);
  });
  it('position 15392963 (0.00085 to 0.00135) holds 26,026,594,582 uNAM and 17,665,537 uUSDC, the formula a base unit under each (the chain rounds up)', () => {
    const p = POSITIONS.find((x) => x.position_id === '15392963');
    expect(p.lower_tick).toBe('-28500000');
    expect(p.upper_tick).toBe('-26650000');
    expect(tickToPrice(-28_500_000)).toBeCloseTo(0.00085, 15);
    expect(tickToPrice(-26_650_000)).toBeCloseTo(0.00135, 15);
    const { amt0, amt1 } = positionAmounts(Number(p.liquidity) / 1e18, -28_500_000, -26_650_000, sqrtP);
    expect(p.asset0.amount).toBe('26026594582');
    expect(p.asset1.amount).toBe('17665537');
    expect(Math.abs(amt0 - 26_026_594_582)).toBeLessThanOrEqual(1);
    expect(Math.abs(amt1 - 17_665_537)).toBeLessThanOrEqual(1);
  });
  it('a position above the price holds only NAM (14929388: 6,984,506,562 uNAM, 0 uUSDC)', () => {
    const p = POSITIONS.find((x) => x.position_id === '14929388');
    const { amt0, amt1 } = positionAmounts(Number(p.liquidity) / 1e18, Number(p.lower_tick), Number(p.upper_tick), sqrtP);
    expect(p.asset0.amount).toBe('6984506562');
    expect(Math.abs(amt0 - 6_984_506_562)).toBeLessThanOrEqual(1);
    expect(amt1).toBe(0);
    expect(p.asset1.amount).toBe('0');
  });
  it('the eight in-range positions’ liquidity sums to current_tick_liquidity exactly (18-decimal integers)', () => {
    const inRange = POSITIONS.filter((p) => Number(p.lower_tick) <= curTick && curTick < Number(p.upper_tick));
    const sum = inRange.reduce((a, p) => a + BigInt(p.liquidity), 0n);
    expect(inRange.length).toBe(8);
    expect(sum.toString()).toBe(POOL.current_tick_liquidity);
    expect(POOL.current_tick_liquidity).toBe('12182537984214367314128069678');
  });
});

describe('the tick store walked with liquidity_net equals liquidity_per_tick_range', () => {
  it('32 initialized ticks give the gateway’s 31 ranges, every liquidity string equal to the last digit', () => {
    const ticks = TICKS.map((t) => ({ tick: tickOfKey(t.tick_key_hex), liquidity_net: scaledToDec(t.liquidity_net, 18) }));
    expect(ticks.length).toBe(32);
    const walked = rangesFromTicks(ticks);
    const given = RANGES.liquidity;
    expect(walked.length).toBe(31);
    expect(given.length).toBe(31);
    walked.forEach((w, i) => {
      expect(String(w.lower_tick)).toBe(given[i].lower_tick);
      expect(String(w.upper_tick)).toBe(given[i].upper_tick);
      expect(w.liquidity_amount).toBe(given[i].liquidity_amount);
    });
  });
  it('the range the current tick is in carries current_tick_liquidity', () => {
    const r = RANGES.liquidity.find((x) => Number(x.lower_tick) <= curTick && curTick < Number(x.upper_tick));
    expect(r?.liquidity_amount).toBe(scaledToDec(POOL.current_tick_liquidity, 18));
    expect(r?.liquidity_amount).toBe('12182537984.214367314128069678');
  });
  it('the tick keys are int64 big-endian two’s complement: fffffffff9900d00 is -108,000,000 and the one key with a 0x06 sort byte is 342,000,000', () => {
    expect(tickOfKey('fffffffff9900d00')).toBe(-108_000_000);
    const positive = TICKS.filter((t) => t.key_hex.slice(18, 20) === '06');
    expect(positive.length).toBe(1);
    expect(tickOfKey(positive[0].tick_key_hex)).toBe(342_000_000);
    expect(TICKS.filter((t) => t.key_hex.slice(18, 20) === '05').every((t) => tickOfKey(t.tick_key_hex) < 0)).toBe(true);
  });
});
