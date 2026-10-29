// The depth math, ported from the research prototype (scratchpad depth/proto/lib.mjs, verified against the chain on
// 2026-10-29: verify.txt) and typed. Four pool models answer the same two questions on a grid of raw prices (counter
// base units per base-coin base unit): sellTo(p), the base coin a pool takes in and the counter it gives out when its
// price is pushed down to p, and buyTo(p), the counter it takes in and the base coin it gives out when pushed up to p.
// A model's "in" amounts are what moves the pool's price: the amount after the pair's taker fee and the pool's own
// spread, both charged once on the coin paid in (verify.txt correction 1: tokens_in in the chain's own event is already
// net of both, so a replay charges nothing again). The aggregate puts every pool on one axis, USD per whole base coin,
// keyed by the EFFECTIVE price (what the next coin fetches after fees), so filling every pool down to one effective
// price is the same as walking all pools in the order the best price gives.
//
// Two arithmetics: the single-pool walk of a concentrated pool is done in BigInt at the chain's own scales (sqrt prices
// at 36 decimals, liquidity at 18, rounding each step the way x/concentrated-liquidity does) so the chain-estimate check
// can hold 0.01 %; the display curve is Number, whose worst error the research measured at 9.7e-6 relative.
import { decToScaled } from './proto';
import { base64Bytes, bytesToBase64 } from '../util';
import type { DepthFill, DepthLevel, DepthOffsets, DepthPoolType, DepthSplit, DepthTouch, DepthWithin } from '../../../shared/depth';
import { HEAT_EDGES } from '../../../shared/depth';
// the grid and its thinning are shared with the page (shared/depth-grid.ts), which rebuilds the grid from the stored reference
import { buildGrid, thinIndices } from '../../../shared/depth-grid';

// ---------------------------------------------------------------------------------------------------- tick math
/** x/concentrated-liquidity/math/tick.go: every power of ten is split into 9 x 10^(-exponent_at_price_one) equal additive steps; tick 0 is price 1. */
export const ticksPerDecade = (exp: number): number => 9 * 10 ** -exp;

export function tickToPrice(tick: number, exp = -6): number {
  if (tick === 0) return 1;
  const per = ticksPerDecade(exp);
  const geo = Math.floor(tick / per);
  return 10 ** geo + (tick - geo * per) * 10 ** (exp + geo);
}
/** The (real-valued) tick of a price; `tickOfPrice` floors it to the tick the chain would report. */
export function priceToTick(price: number, exp = -6): number {
  if (price === 1) return 0;
  const per = ticksPerDecade(exp);
  const geo = Math.floor(Math.log10(price) + 1e-12);
  return geo * per + (price - 10 ** geo) / 10 ** (exp + geo);
}
export const tickOfPrice = (price: number, exp = -6): number => Math.floor(priceToTick(price, exp) + 1e-6);

/** BigDec's scale: 36 decimals, the chain's sqrt prices. */
export const BIG_ONE = 10n ** 36n;
/** Dec's scale: 18 decimals, the chain's liquidity and amounts. */
export const DEC_ONE = 10n ** 18n;
const pow10 = (n: number): bigint => 10n ** BigInt(n);

export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error('sqrt of a negative');
  if (n < 2n) return n;
  // Newton from above: start at a power of two no smaller than the root, so every step moves down to the floor
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}
/** A tick's price as an exact BigInt at 36 decimals (the additive formula is exact in decimal). */
export function tickToPriceScaled(tick: number, exp = -6): bigint {
  const per = ticksPerDecade(exp);
  const geo = Math.floor(tick / per);
  const delta = BigInt(tick - geo * per);
  const e1 = 36 + geo, e2 = 36 + exp + geo;
  if (e2 < 0) throw new Error(`tick ${tick} is finer than 36 decimals`);
  return pow10(e1) + delta * pow10(e2);
}
/** A tick's sqrt price at 36 decimals, rounded down. */
export const tickToSqrtScaled = (tick: number, exp = -6): bigint => isqrt(tickToPriceScaled(tick, exp) * BIG_ONE);

// ---------------------------------------------------------------------------------------------------- shapes read from the chain
/** A concentrated pool as the REST gateway and proto.ts decodePool give it (decimal strings). */
export interface ClPoolState {
  token0: string;
  token1: string;
  current_sqrt_price: string;
  current_tick: string | number;
  tick_spacing?: string | number;
  exponent_at_price_one: string | number;
  spread_factor: string | number;
  current_tick_liquidity?: string;
}
/** One range of liquidity_per_tick_range, or one rebuilt from the tick store (rangesFromTicks). */
export interface ClRange {
  lower_tick: string | number;
  upper_tick: string | number;
  liquidity_amount: string;
}
/** The tick store walked with liquidity_net gives liquidity_per_tick_range: a range between consecutive initialized ticks with the running sum (18-decimal exact). Ranges with no liquidity are left out, as the gateway leaves them out. */
export function rangesFromTicks(ticks: { tick: number; liquidity_net: string }[]): ClRange[] {
  const sorted = [...ticks].sort((a, b) => a.tick - b.tick);
  const out: ClRange[] = [];
  let L = 0n;
  for (let i = 0; i < sorted.length - 1; i++) {
    L += decToScaled(sorted[i].liquidity_net, 18);
    if (L > 0n) out.push({ lower_tick: sorted[i].tick, upper_tick: sorted[i + 1].tick, liquidity_amount: decString(L, 18) });
  }
  return out;
}
/** A scaled BigInt as a decimal string with every digit of its scale. */
export const decString = (v: bigint, scale: number): string => {
  const neg = v < 0n; const d = (neg ? -v : v).toString().padStart(scale + 1, '0');
  return `${neg ? '-' : ''}${d.slice(0, d.length - scale)}.${d.slice(d.length - scale)}`;
};

/** The amounts a position holds: token0 above the current price, token1 below, both inside its range (chain.txt 1c). Base units, Number. */
export function positionAmounts(L: number, lowerTick: number, upperTick: number, sqrtP: number, exp = -6): { amt0: number; amt1: number } {
  const sa = Math.sqrt(tickToPrice(lowerTick, exp)), sb = Math.sqrt(tickToPrice(upperTick, exp));
  if (sqrtP <= sa) return { amt0: L * (sb - sa) / (sa * sb), amt1: 0 };
  if (sqrtP >= sb) return { amt0: 0, amt1: L * (sb - sa) };
  return { amt0: L * (sb - sqrtP) / (sqrtP * sb), amt1: L * (sqrtP - sa) };
}

// ---------------------------------------------------------------------------------------------------- the exact walk (BigInt)
const mulRoundUp = (a: bigint, b: bigint) => { const p = a * b; return p % BIG_ONE === 0n ? p / BIG_ONE : p / BIG_ONE + 1n; };
const mulTrunc = (a: bigint, b: bigint) => (a * b) / BIG_ONE;
const mulRound = (a: bigint, b: bigint) => (a * b + BIG_ONE / 2n) / BIG_ONE;
const quoRoundUp = (a: bigint, b: bigint) => { const n = a * BIG_ONE; return n % b === 0n ? n / b : n / b + 1n; };
const quoTrunc = (a: bigint, b: bigint) => (a * BIG_ONE) / b;
/** token0 between two sqrt prices: L x (sb - sa) / (sa x sb). */
const amount0Delta = (L: bigint, sa: bigint, sb: bigint, roundUp: boolean): bigint => {
  const [lo, hi] = sa < sb ? [sa, sb] : [sb, sa];
  const diff = hi - lo;
  return roundUp ? quoRoundUp(quoRoundUp(mulRoundUp(L, diff), lo), hi) : quoTrunc(quoTrunc(mulTrunc(L, diff), lo), hi);
};
/** token1 between two sqrt prices: L x (sb - sa). */
const amount1Delta = (L: bigint, sa: bigint, sb: bigint, roundUp: boolean): bigint => {
  const diff = sa < sb ? sb - sa : sa - sb;
  return roundUp ? mulRoundUp(L, diff) : mulTrunc(L, diff);
};
/** The sqrt price after `amountIn` of token0 goes in: L x sqrtP / (L + amountIn x sqrtP), rounded up. */
const nextSqrtFromAmount0In = (sqrtP: bigint, L: bigint, amountIn: bigint): bigint => (amountIn === 0n ? sqrtP : quoRoundUp(mulRoundUp(L, sqrtP), L + mulRound(amountIn, sqrtP)));
/** The sqrt price after `amountIn` of token1 goes in: sqrtP + amountIn / L, rounded down. */
const nextSqrtFromAmount1In = (sqrtP: bigint, L: bigint, amountIn: bigint): bigint => sqrtP + quoTrunc(amountIn, L);

export interface ExactSwapResult {
  /** Base units of the coin out, truncated as the chain truncates. */
  amountOut: bigint;
  /** What moved the price: the input after the taker fee and the spread. */
  netIn: bigint;
  takerFee: bigint;
  spreadFee: bigint;
  /** The input the pool could not place (no liquidity left in that direction). */
  unfilledIn: bigint;
  sqrtAfter: bigint;
  stepsCrossed: number;
}

/**
 * One exact-in swap in a concentrated pool, step by step as x/concentrated-liquidity does it: the taker fee first
 * (rounded up), then per range the spread on what that range takes, amounts rounded against the trader. `zeroForOne`
 * is token0 in, token1 out (the price falls). `amountIn` is the gross amount (what the trader pays), 18-decimal
 * BigDec amounts internally, the answer truncated to base units. Pass `taker` and `spread` as decimal strings or numbers.
 */
export function clSwapExactIn(pool: ClPoolState, ranges: ClRange[], zeroForOne: boolean, amountIn: bigint, opts: { taker?: string | number; spread?: string | number; netAlready?: boolean } = {}): ExactSwapResult {
  const exp = Number(pool.exponent_at_price_one);
  const spread = decToScaled(String(opts.spread ?? pool.spread_factor), 36);
  const taker = decToScaled(String(opts.taker ?? 0), 36);
  const R = ranges.map((r) => ({ lo: Number(r.lower_tick), hi: Number(r.upper_tick), L: decToScaled(r.liquidity_amount, 18) * pow10(18) })).filter((r) => r.L > 0n).sort((a, b) => a.lo - b.lo);
  let sqrtP = decToScaled(pool.current_sqrt_price, 36);
  const ct = Number(pool.current_tick);
  // the range the price is in now; with no range there, the next one in the swap's direction, and the walk starts at
  // that range's near boundary: the gap between the pool's price and the range holds no liquidity, so nothing is
  // filled across it (a walk started from the pool's own price would credit the gap with the range's liquidity)
  let i = R.findIndex((r) => r.lo <= ct && ct < r.hi);
  if (i < 0) {
    if (zeroForOne) { for (let k = R.length - 1; k >= 0; k--) if (R[k].hi <= ct) { i = k; break; } }
    else i = R.findIndex((r) => r.lo > ct);
    if (i >= 0) {
      const edge = zeroForOne ? tickToSqrtScaled(R[i].hi, exp) : tickToSqrtScaled(R[i].lo, exp);
      if (zeroForOne ? edge < sqrtP : edge > sqrtP) sqrtP = edge;
    }
  }
  const takerFee = opts.netAlready ? 0n : (amountIn * taker + BIG_ONE - 1n) / BIG_ONE;
  let remaining = (amountIn - takerFee) * BIG_ONE; // BigDec
  const spreadNow = opts.netAlready ? 0n : spread;
  let out = 0n, netIn = 0n, spreadFee = 0n, steps = 0;
  while (remaining > 0n && i >= 0 && i < R.length) {
    const r = R[i];
    const L = r.L;
    const target = zeroForOne ? tickToSqrtScaled(r.lo, exp) : tickToSqrtScaled(r.hi, exp);
    // a range the price has already left in this direction gives nothing: step over it
    if (zeroForOne ? target >= sqrtP : target <= sqrtP) { i += zeroForOne ? -1 : 1; continue; }
    const lessSpread = mulTrunc(remaining, BIG_ONE - spreadNow);
    let inFull = zeroForOne ? amount0Delta(L, target, sqrtP, true) : amount1Delta(L, sqrtP, target, true);
    let next: bigint;
    if (lessSpread >= inFull) next = target;
    else next = zeroForOne ? nextSqrtFromAmount0In(sqrtP, L, lessSpread) : nextSqrtFromAmount1In(sqrtP, L, lessSpread);
    const reached = next === target;
    const stepIn = reached ? inFull : (zeroForOne ? amount0Delta(L, next, sqrtP, true) : amount1Delta(L, sqrtP, next, true));
    const stepOut = zeroForOne ? amount1Delta(L, next, sqrtP, false) : amount0Delta(L, sqrtP, next, false);
    const charge = reached ? quoRoundUp(mulRoundUp(stepIn, spreadNow), BIG_ONE - spreadNow) : remaining - stepIn;
    remaining -= stepIn + charge;
    if (remaining < 0n) remaining = 0n;
    netIn += stepIn; spreadFee += charge; out += stepOut; sqrtP = next; steps++;
    if (reached) {
      // crossing the boundary: the neighbour range in this direction, or a gap to it (nothing happens over a gap)
      const j = i + (zeroForOne ? -1 : 1);
      if (j < 0 || j >= R.length) { i = j; break; }
      sqrtP = zeroForOne ? tickToSqrtScaled(R[j].hi, exp) : tickToSqrtScaled(R[j].lo, exp);
      if (zeroForOne ? sqrtP > next : sqrtP < next) sqrtP = next;
      i = j;
    } else break;
  }
  return { amountOut: out / BIG_ONE, netIn: netIn / BIG_ONE, takerFee, spreadFee: spreadFee / BIG_ONE, unfilledIn: remaining / BIG_ONE, sqrtAfter: sqrtP, stepsCrossed: steps };
}

/** Selling `amountIn` gross base coin into a concentrated pool: the counter coin out, to the base unit. */
export function clSellExact(pool: ClPoolState, ranges: ClRange[], baseDenom: string, amountIn: bigint, taker: string | number): ExactSwapResult {
  return clSwapExactIn(pool, ranges, pool.token0 === baseDenom, amountIn, { taker });
}
/** Buying with `amountIn` gross counter coin: the base coin out. */
export function clBuyExact(pool: ClPoolState, ranges: ClRange[], baseDenom: string, amountIn: bigint, taker: string | number): ExactSwapResult {
  return clSwapExactIn(pool, ranges, pool.token0 !== baseDenom, amountIn, { taker });
}

// ---------------------------------------------------------------------------------------------------- the pool models (Number)
export interface RawLevel {
  lo: number;
  hi: number;
  nam: number;
  counter: number;
  side?: 'bid' | 'ask';
  loTick?: number;
  hiTick?: number;
  L?: number;
  orders?: number;
}
export interface PoolModel {
  kind: 'cl' | 'balancer' | 'stableswap' | 'orderbook';
  /** counter per base coin, base-unit ratio; null for an empty book */
  spotRaw: number | null;
  /** the pool's own fee on the coin in */
  spread: number;
  minRaw: number | null;
  maxRaw: number | null;
  /** Push the price down to pRaw by selling base coin: the net base coin the pool takes and the counter it gives. */
  sellTo(pRaw: number): { namIn: number; counterOut: number };
  /** Push the price up to pRaw by buying base coin: the net counter the pool takes and the base coin it gives. */
  buyTo(pRaw: number): { counterIn: number; namOut: number };
  /** The counter out for a NET base-coin input (after the taker fee and the spread). */
  sellIn(namNet: number): number;
  /** The base coin out for a NET counter input. */
  buyIn(counterNet: number): number;
  levels(): RawLevel[];
}
export interface ClModel extends PoolModel {
  kind: 'cl';
  spotRaw: number;
  tickSpacing: number;
  exp: number;
  currentTick: number;
  L: number;
  ranges: number;
  namIs0: boolean;
}

/** Concentrated liquidity: `ranges` as liquidity_per_tick_range gives them (or rangesFromTicks), `pool` as poolmanager serves it. */
export function clModel(pool: ClPoolState, ranges: ClRange[], baseDenom: string): ClModel {
  const exp = Number(pool.exponent_at_price_one);
  const sp = Number(pool.current_sqrt_price);
  const ct = Number(pool.current_tick);
  const namIs0 = pool.token0 === baseDenom;
  const R = ranges.map((r) => ({ lo: Number(r.lower_tick), hi: Number(r.upper_tick), L: Number(r.liquidity_amount), sa: Math.sqrt(tickToPrice(Number(r.lower_tick), exp)), sb: Math.sqrt(tickToPrice(Number(r.upper_tick), exp)) })).filter((r) => r.L > 0).sort((a, b) => a.lo - b.lo);
  // move the price down to sqrt target: token0 in, token1 out
  const down = (st: number) => { let in0 = 0, out1 = 0; for (const r of R) { if (r.sa >= sp) continue; const hi = Math.min(r.sb, sp), lo = Math.max(r.sa, st); if (lo >= hi) continue; in0 += r.L * (1 / lo - 1 / hi); out1 += r.L * (hi - lo); } return { in0, out1 }; };
  const up = (st: number) => { let in1 = 0, out0 = 0; for (const r of R) { if (r.sb <= sp) continue; const lo = Math.max(r.sa, sp), hi = Math.min(r.sb, st); if (lo >= hi) continue; in1 += r.L * (hi - lo); out0 += r.L * (1 / lo - 1 / hi); } return { in1, out0 }; };
  // exact-in walks: token0 in (price down) and token1 in (price up), range by range
  const downIn = (amt0: number) => { let left = amt0, out1 = 0; for (let k = R.length - 1; k >= 0 && left > 0; k--) { const r = R[k]; if (r.sa >= sp) continue; const hi = Math.min(r.sb, sp); const cap = r.L * (1 / r.sa - 1 / hi); if (left >= cap) { out1 += r.L * (hi - r.sa); left -= cap; } else { const s2 = r.L * hi / (r.L + left * hi); out1 += r.L * (hi - s2); left = 0; } } return out1; };
  const upIn = (amt1: number) => { let left = amt1, out0 = 0; for (let k = 0; k < R.length && left > 0; k++) { const r = R[k]; if (r.sb <= sp) continue; const lo = Math.max(r.sa, sp); const cap = r.L * (r.sb - lo); if (left >= cap) { out0 += r.L * (1 / lo - 1 / r.sb); left -= cap; } else { const s2 = lo + left / r.L; out0 += r.L * (1 / lo - 1 / s2); left = 0; } } return out0; };
  const spotRaw = namIs0 ? sp * sp : 1 / (sp * sp);
  return {
    kind: 'cl', spotRaw, spread: Number(pool.spread_factor), tickSpacing: Number(pool.tick_spacing ?? 0), exp, currentTick: ct, L: Number(pool.current_tick_liquidity ?? 0), ranges: R.length, namIs0,
    minRaw: R.length ? (namIs0 ? R[0].sa ** 2 : 1 / R[R.length - 1].sb ** 2) : spotRaw,
    maxRaw: R.length ? (namIs0 ? R[R.length - 1].sb ** 2 : 1 / R[0].sa ** 2) : spotRaw,
    sellTo(pRaw) { if (pRaw >= spotRaw) return { namIn: 0, counterOut: 0 }; if (namIs0) { const r = down(Math.sqrt(pRaw)); return { namIn: r.in0, counterOut: r.out1 }; } const r = up(Math.sqrt(1 / pRaw)); return { namIn: r.in1, counterOut: r.out0 }; },
    buyTo(pRaw) { if (pRaw <= spotRaw) return { counterIn: 0, namOut: 0 }; if (namIs0) { const r = up(Math.sqrt(pRaw)); return { counterIn: r.in1, namOut: r.out0 }; } const r = down(Math.sqrt(1 / pRaw)); return { counterIn: r.in0, namOut: r.out1 }; },
    sellIn(namNet) { return namIs0 ? downIn(namNet) : upIn(namNet); },
    buyIn(counterNet) { return namIs0 ? upIn(counterNet) : downIn(counterNet); },
    levels() {
      return R.map((r) => {
        let amt0 = 0, amt1 = 0;
        if (sp <= r.sa) amt0 = r.L * (r.sb - r.sa) / (r.sa * r.sb); else if (sp >= r.sb) amt1 = r.L * (r.sb - r.sa); else { amt0 = r.L * (r.sb - sp) / (sp * r.sb); amt1 = r.L * (sp - r.sa); }
        const p0 = r.sa ** 2, p1 = r.sb ** 2;
        return namIs0 ? { lo: p0, hi: p1, loTick: r.lo, hiTick: r.hi, L: r.L, nam: amt0, counter: amt1 } : { lo: 1 / p1, hi: 1 / p0, loTick: r.lo, hiTick: r.hi, L: r.L, nam: amt1, counter: amt0 };
      });
    },
  };
}

export interface WeightedAsset {
  denom: string;
  amount: string | number;
  weight: string | number;
}
export interface BalancerModel extends PoolModel {
  kind: 'balancer';
  spotRaw: number;
  Rn: number;
  Rc: number;
  wn: number;
  wc: number;
}
/** Weighted (balancer) pool: out = R_out x (1 - (R_in / (R_in + in_net))^(w_in / w_out)); the swap fee comes off the input first. */
export function balancerModel(assets: WeightedAsset[], swapFee: number, baseDenom: string): BalancerModel {
  const n = assets.find((a) => a.denom === baseDenom), c = assets.find((a) => a.denom !== baseDenom);
  if (!n || !c) throw new Error('a weighted pool needs the base coin and one other');
  const Rn = Number(n.amount), Rc = Number(c.amount), wn = Number(n.weight), wc = Number(c.weight);
  const spotRaw = (Rc / wc) / (Rn / wn);
  const priceAfterSell = (x: number) => { const Rc2 = Rc * (Rn / (Rn + x)) ** (wn / wc); return (Rc2 / wc) / ((Rn + x) / wn); };
  const priceAfterBuy = (y: number) => { const Rn2 = Rn * (Rc / (Rc + y)) ** (wc / wn); return ((Rc + y) / wc) / (Rn2 / wn); };
  const solve = (fn: (v: number) => number, target: number, decreasing: boolean) => { let lo = 0, hi = 1; while ((decreasing ? fn(hi) > target : fn(hi) < target) && hi < 1e30) hi *= 2; for (let i = 0; i < 100; i++) { const m = (lo + hi) / 2; if (decreasing ? fn(m) > target : fn(m) < target) lo = m; else hi = m; } return (lo + hi) / 2; };
  const outForIn = (x: number) => Rc - Rc * (Rn / (Rn + x)) ** (wn / wc);
  const namForIn = (y: number) => Rn - Rn * (Rc / (Rc + y)) ** (wc / wn);
  return {
    kind: 'balancer', spotRaw, spread: swapFee, Rn, Rc, wn, wc, minRaw: 0, maxRaw: Infinity,
    sellTo(pRaw) { if (pRaw >= spotRaw || Rc === 0 || Rn === 0) return { namIn: 0, counterOut: 0 }; const x = solve(priceAfterSell, pRaw, true); return { namIn: x, counterOut: outForIn(x) }; },
    buyTo(pRaw) { if (pRaw <= spotRaw || Rc === 0 || Rn === 0) return { counterIn: 0, namOut: 0 }; const y = solve(priceAfterBuy, pRaw, false); return { counterIn: y, namOut: namForIn(y) }; },
    sellIn: (x) => (Rc === 0 || Rn === 0 ? 0 : outForIn(x)),
    buyIn: (y) => (Rc === 0 || Rn === 0 ? 0 : namForIn(y)),
    levels: () => (Rn > 0 || Rc > 0 ? [{ lo: spotRaw, hi: spotRaw, nam: Rn, counter: Rc }] : []),
  };
}

export interface StableswapModel extends PoolModel {
  kind: 'stableswap';
  spotRaw: number;
}
/** Osmosis stableswap (x/gamm/pool-models/stableswap): x y (x^2 + y^2) = k on the scaled reserves. */
export function stableswapModel(liquidity: { denom: string; amount: string | number }[], scaling: (string | number)[], swapFee: number, baseDenom: string): StableswapModel {
  const ni = liquidity.findIndex((a) => a.denom === baseDenom), ci = ni === 0 ? 1 : 0;
  if (ni < 0 || liquidity.length < 2) throw new Error('a stable pool needs the base coin and one other');
  const sx = Number(scaling[ni] || 1), sy = Number(scaling[ci] || 1);
  const x0 = Number(liquidity[ni].amount) / sx, y0 = Number(liquidity[ci].amount) / sy;
  const k = x0 * y0 * (x0 * x0 + y0 * y0);
  const marg = (x: number, y: number) => (y * (3 * x * x + y * y)) / (x * (x * x + 3 * y * y)); // counter per base coin
  const yOf = (x: number) => { let lo = 0, hi = y0 * 4 + 1; for (let i = 0; i < 200; i++) { const m = (lo + hi) / 2; if (x * m * (x * x + m * m) < k) lo = m; else hi = m; } return (lo + hi) / 2; };
  const xOf = (y: number) => { let lo = 0, hi = x0 * 4 + 1; for (let i = 0; i < 200; i++) { const m = (lo + hi) / 2; if (m * y * (m * m + y * y) < k) lo = m; else hi = m; } return (lo + hi) / 2; };
  const spotRaw = marg(x0, y0) * (sx / sy);
  const solveSell = (target: number) => { let lo = 0, hi = x0; while (marg(x0 + hi, yOf(x0 + hi)) * (sx / sy) > target && hi < x0 * 1e6) hi *= 2; for (let i = 0; i < 100; i++) { const m = (lo + hi) / 2; if (marg(x0 + m, yOf(x0 + m)) * (sx / sy) > target) lo = m; else hi = m; } return (lo + hi) / 2; };
  const solveBuy = (target: number) => { let lo = 0, hi = y0; while (marg(xOf(y0 + hi), y0 + hi) * (sx / sy) < target && hi < y0 * 1e6) hi *= 2; for (let i = 0; i < 100; i++) { const m = (lo + hi) / 2; if (marg(xOf(y0 + m), y0 + m) * (sx / sy) < target) lo = m; else hi = m; } return (lo + hi) / 2; };
  const empty = x0 === 0 || y0 === 0;
  return {
    kind: 'stableswap', spotRaw, spread: swapFee, minRaw: 0, maxRaw: Infinity,
    sellTo(pRaw) { if (pRaw >= spotRaw || empty) return { namIn: 0, counterOut: 0 }; const dx = solveSell(pRaw); return { namIn: dx * sx, counterOut: (y0 - yOf(x0 + dx)) * sy }; },
    buyTo(pRaw) { if (pRaw <= spotRaw || empty) return { counterIn: 0, namOut: 0 }; const dy = solveBuy(pRaw); return { counterIn: dy * sy, namOut: (x0 - xOf(y0 + dy)) * sx }; },
    sellIn: (namNet) => (empty ? 0 : (y0 - yOf(x0 + namNet / sx)) * sy),
    buyIn: (counterNet) => (empty ? 0 : (x0 - xOf(y0 + counterNet / sy)) * sx),
    levels: () => (empty ? [] : [{ lo: spotRaw, hi: spotRaw, nam: x0 * sx, counter: y0 * sy }]),
  };
}

/** A bid level of the book: counter base units resting at a price; an ask level: base-coin base units resting. */
export interface BookBid { price: number; quote: number; orders?: number }
export interface BookAsk { price: number; base: number; orders?: number }
export interface OrderbookModel extends PoolModel {
  kind: 'orderbook';
  bestBid: number | null;
  bestAsk: number | null;
}
/** The sumtree order book: an order fills at its own price, in full when the marginal price reaches it. No spread today (read as 0). */
export function orderbookModel(bids: BookBid[], asks: BookAsk[], swapFee = 0): OrderbookModel {
  const B = bids.filter((b) => b.quote > 0).sort((a, b) => b.price - a.price), A = asks.filter((a) => a.base > 0).sort((a, b) => a.price - b.price);
  return {
    kind: 'orderbook', spotRaw: null, spread: swapFee, bestBid: B[0]?.price ?? null, bestAsk: A[0]?.price ?? null,
    minRaw: B.length ? B[B.length - 1].price : null, maxRaw: A.length ? A[A.length - 1].price : null,
    sellTo(pRaw) { let namIn = 0, counterOut = 0; for (const b of B) { if (b.price < pRaw) break; namIn += b.quote / b.price; counterOut += b.quote; } return { namIn, counterOut }; },
    buyTo(pRaw) { let counterIn = 0, namOut = 0; for (const a of A) { if (a.price > pRaw) break; counterIn += a.base * a.price; namOut += a.base; } return { counterIn, namOut }; },
    sellIn(namNet) { let left = namNet, out = 0; for (const b of B) { if (left <= 0) break; const cap = b.quote / b.price; if (left >= cap) { out += b.quote; left -= cap; } else { out += left * b.price; left = 0; } } return out; },
    buyIn(counterNet) { let left = counterNet, out = 0; for (const a of A) { if (left <= 0) break; const cap = a.base * a.price; if (left >= cap) { out += a.base; left -= cap; } else { out += left / a.price; left = 0; } } return out; },
    levels: () => [...B.map((b) => ({ lo: b.price, hi: b.price, nam: 0, counter: b.quote, orders: b.orders, side: 'bid' as const })), ...A.map((a) => ({ lo: a.price, hi: a.price, nam: a.base, counter: 0, orders: a.orders, side: 'ask' as const }))],
  };
}

// ---------------------------------------------------------------------------------------------------- the aggregate
/** A pool the aggregate may sum: its model, its counter coin's USD price and decimals, the pair's taker fee. */
export interface PricedPool {
  id: string;
  type: DepthPoolType;
  model: PoolModel;
  /** USD per whole counter coin */
  counterUsd: number;
  counterDecimals: number;
  taker: number;
}
/** Multiply a raw price by this to get USD per whole base coin. */
export const usdPerRaw = (p: { counterUsd: number; counterDecimals: number }, baseDecimals: number): number => p.counterUsd * 10 ** (baseDecimals - p.counterDecimals);
/** The fee factor on the coin in: a pool's spread and the pair's taker fee, charged once. */
export const feeFactor = (p: { model: { spread: number }; taker: number }): number => (1 - p.model.spread) * (1 - p.taker);

/** The price grid and its thinning for the page live in shared/depth-grid.ts (the page rebuilds the grid); re-exported for the module's callers. */
export { buildGrid, thinIndices };

export interface PoolCurve {
  bidNam: Float64Array;
  bidUsd: Float64Array;
  askNam: Float64Array;
  askUsd: Float64Array;
}
export interface Aggregate extends PoolCurve {
  grid: number[];
  perPool: PoolCurve[];
}
const curve = (n: number): PoolCurve => ({ bidNam: new Float64Array(n), bidUsd: new Float64Array(n), askNam: new Float64Array(n), askUsd: new Float64Array(n) });

/**
 * Every pool on the USD axis. At grid price q (USD per whole base coin, the EFFECTIVE price after fees) the bid side
 * holds the gross base coin that can be sold down to q and the USD it fetches; the ask side the base coin that can be
 * bought up to q and the gross USD it costs. Per pool and summed. A pool with no USD price is skipped (never summed).
 */
export function aggregate(pools: PricedPool[], grid: number[], baseDecimals: number): Aggregate {
  const n = grid.length;
  const all = curve(n);
  const perPool = pools.map(() => curve(n));
  const baseUnit = 10 ** baseDecimals;
  pools.forEach((p, pi) => {
    const k = usdPerRaw(p, baseDecimals);
    if (!(k > 0)) return;
    const fee = feeFactor(p);
    const cUnit = 10 ** p.counterDecimals;
    const pp = perPool[pi];
    for (let i = 0; i < n; i++) {
      const q = grid[i];
      // sell side: effective q = pRaw x k x fee  ->  pRaw = q / (k x fee)
      const s = p.model.sellTo(q / (k * fee));
      const gNam = s.namIn / fee / baseUnit, usd = s.counterOut * p.counterUsd / cUnit;
      pp.bidNam[i] = gNam; pp.bidUsd[i] = usd; all.bidNam[i] += gNam; all.bidUsd[i] += usd;
      // buy side: effective cost q = pRaw x k / fee -> pRaw = q x fee / k
      const b = p.model.buyTo(q * fee / k);
      const gUsd = b.counterIn / fee * p.counterUsd / cUnit, nam = b.namOut / baseUnit;
      pp.askNam[i] = nam; pp.askUsd[i] = gUsd; all.askNam[i] += nam; all.askUsd[i] += gUsd;
    }
  });
  return { grid, ...all, perPool };
}
/** An aggregate from curves already computed (the per-pool arrays of a stored minute): the sum and the same walk. */
export function aggregateOfCurves(grid: number[], curves: { bidNam: ArrayLike<number>; bidUsd: ArrayLike<number>; askNam: ArrayLike<number>; askUsd: ArrayLike<number> }[]): Aggregate {
  const n = grid.length;
  const all = curve(n);
  const perPool = curves.map((c) => {
    const pc: PoolCurve = { bidNam: Float64Array.from(c.bidNam), bidUsd: Float64Array.from(c.bidUsd), askNam: Float64Array.from(c.askNam), askUsd: Float64Array.from(c.askUsd) };
    for (let i = 0; i < n; i++) { all.bidNam[i] += pc.bidNam[i]; all.bidUsd[i] += pc.bidUsd[i]; all.askNam[i] += pc.askNam[i]; all.askUsd[i] += pc.askUsd[i]; }
    return pc;
  });
  return { grid, ...all, perPool };
}

function splitAt(agg: Aggregate, pools: { id: string }[], i0: number, side: 'bid' | 'ask', t: number, i1 = i0): DepthSplit[] {
  const kn = side === 'bid' ? 'bidNam' : 'askNam', ku = side === 'bid' ? 'bidUsd' : 'askUsd';
  return pools.map((p, pi) => { const pp = agg.perPool[pi]; const nam = pp[kn][i0] + t * (pp[kn][i1] - pp[kn][i0]); const usd = pp[ku][i0] + t * (pp[ku][i1] - pp[ku][i0]); return { pool: p.id, nam, usd }; }).filter((x) => x.nam > 1e-9).sort((a, b) => b.nam - a.nam);
}
/** Selling `nam` whole base coins: walk the bid side (prices descending) to where the cumulative base coin reaches the size; linear between grid points. */
export function executeSell(agg: Aggregate, pools: { id: string }[], nam: number): DepthFill {
  const { grid, bidNam, bidUsd } = agg; const n = grid.length;
  let hiI = -1;
  for (let i = n - 1; i >= 0; i--) if (bidNam[i] >= nam) { hiI = i; break; }
  if (hiI < 0) return { nam, filledNam: bidNam[0], usd: bidUsd[0], marginalPrice: grid[0], avgPrice: bidNam[0] ? bidUsd[0] / bidNam[0] : null, complete: false, split: splitAt(agg, pools, 0, 'bid', 1) };
  const i1 = hiI, i0 = Math.min(hiI + 1, n - 1);
  const a = bidNam[i0], b = bidNam[i1]; const t = b > a ? (nam - a) / (b - a) : 1;
  const usd = bidUsd[i0] + t * (bidUsd[i1] - bidUsd[i0]); const price = grid[i0] + t * (grid[i1] - grid[i0]);
  return { nam, filledNam: nam, usd, marginalPrice: price, avgPrice: usd / nam, complete: true, split: splitAt(agg, pools, i0, 'bid', t, i1) };
}
/** Buying `nam` whole base coins: walk the ask side (prices ascending). */
export function executeBuy(agg: Aggregate, pools: { id: string }[], nam: number): DepthFill {
  const { grid, askNam, askUsd } = agg; const n = grid.length;
  let loI = -1;
  for (let i = 0; i < n; i++) if (askNam[i] >= nam) { loI = i; break; }
  if (loI < 0) { const i = n - 1; return { nam, filledNam: askNam[i], usd: askUsd[i], marginalPrice: grid[i], avgPrice: askNam[i] ? askUsd[i] / askNam[i] : null, complete: false, split: splitAt(agg, pools, i, 'ask', 1) }; }
  const i1 = loI, i0 = Math.max(loI - 1, 0);
  const a = askNam[i0], b = askNam[i1]; const t = b > a ? (nam - a) / (b - a) : 1;
  const usd = askUsd[i0] + t * (askUsd[i1] - askUsd[i0]); const price = grid[i0] + t * (grid[i1] - grid[i0]);
  return { nam, filledNam: nam, usd, marginalPrice: price, avgPrice: usd / nam, complete: true, split: splitAt(agg, pools, i0, 'ask', t, i1) };
}
/** Buying with `usd` of the counter value: walk the ask side (prices ascending) to where the cumulative USD reaches the budget; `nam` is the base coin bought, `usd` the budget. */
export function executeBuyUsd(agg: Aggregate, pools: { id: string }[], usd: number): DepthFill {
  const { grid, askNam, askUsd } = agg; const n = grid.length;
  let loI = -1;
  for (let i = 0; i < n; i++) if (askUsd[i] >= usd) { loI = i; break; }
  if (loI < 0) { const i = n - 1; return { nam: askNam[i], filledNam: askNam[i], usd: askUsd[i], marginalPrice: grid[i], avgPrice: askNam[i] ? askUsd[i] / askNam[i] : null, complete: false, split: splitAt(agg, pools, i, 'ask', 1) }; }
  const i1 = loI, i0 = Math.max(loI - 1, 0);
  const a = askUsd[i0], b = askUsd[i1]; const t = b > a ? (usd - a) / (b - a) : 1;
  const nam = askNam[i0] + t * (askNam[i1] - askNam[i0]); const price = grid[i0] + t * (grid[i1] - grid[i0]);
  return { nam, filledNam: nam, usd, marginalPrice: price, avgPrice: nam > 0 ? usd / nam : null, complete: true, split: splitAt(agg, pools, i0, 'ask', t, i1) };
}
/** A cumulative value at a price, linear between grid points. */
export function cumAt(agg: Aggregate, key: 'bidNam' | 'bidUsd' | 'askNam' | 'askUsd', price: number): number {
  const g = agg.grid, v = agg[key];
  if (price <= g[0]) return v[0];
  if (price >= g[g.length - 1]) return v[g.length - 1];
  let lo = 0, hi = g.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (g[m] <= price) lo = m; else hi = m; }
  const t = (price - g[lo]) / (g[hi] - g[lo]);
  return v[lo] + t * (v[hi] - v[lo]);
}

/** USD resting within each offset of the reference price: selling down to ref x (1 - p %), buying up to ref x (1 + p %). */
export const offsetsAt = (agg: Aggregate, ref: number, pcts: readonly number[]): DepthOffsets => ({
  bid: pcts.map((p) => cumAt(agg, 'bidUsd', ref * (1 - p / 100))),
  ask: pcts.map((p) => cumAt(agg, 'askUsd', ref * (1 + p / 100))),
});
/** The within figures of the Answer view. */
export const withinAt = (agg: Aggregate, ref: number): DepthWithin => ({
  bidUsd10: cumAt(agg, 'bidUsd', ref * 0.9), bidUsd25: cumAt(agg, 'bidUsd', ref * 0.75), bidUsd50: cumAt(agg, 'bidUsd', ref * 0.5),
  askNam10: cumAt(agg, 'askNam', ref * 1.1), askNam25: cumAt(agg, 'askNam', ref * 1.25), askUsd10: cumAt(agg, 'askUsd', ref * 1.1),
  totalBidUsd: agg.bidUsd[0], totalAskNam: agg.askNam[agg.askNam.length - 1],
});
/** The touch: the effective price of the first `sizeNam` coins each way and the pool that gives most of them. A side that cannot fill the size has no touch (null, the page says NO_BIDS / NO_ASKS): an incomplete fill's marginal price is the grid's end, not a price anything rests at. */
export function touchAt(agg: Aggregate, pools: { id: string }[], sizeNam: number): DepthTouch {
  const s = executeSell(agg, pools, sizeNam), b = executeBuy(agg, pools, sizeNam);
  return { bestBidEff: s.complete ? s.marginalPrice : null, bestBidPool: s.complete ? s.split[0]?.pool ?? null : null, bestAskEff: b.complete ? b.marginalPrice : null, bestAskPool: b.complete ? b.split[0]?.pool ?? null : null, sizeNam };
}
/** USD resting in each heat band (edges as ratios of the reference price), bid side and ask side. */
export function heatAt(agg: Aggregate, ref: number, edges: readonly number[] = HEAT_EDGES): { bid: Float32Array; ask: Float32Array } {
  const n = edges.length - 1;
  const bid = new Float32Array(n), ask = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = ref * edges[i], b = ref * edges[i + 1];
    bid[i] = Math.max(0, cumAt(agg, 'bidUsd', a) - cumAt(agg, 'bidUsd', b));
    ask[i] = Math.max(0, cumAt(agg, 'askUsd', b) - cumAt(agg, 'askUsd', a));
  }
  return { bid, ask };
}
/** A float32 array as base64 (little-endian), the form the heat bands are stored in. */
export const packF32 = (a: Float32Array): string => {
  const b = new Uint8Array(a.length * 4);
  const dv = new DataView(b.buffer);
  a.forEach((v, i) => dv.setFloat32(i * 4, v, true));
  return bytesToBase64(b);
};
export const unpackF32 = (s: string): Float32Array => {
  const b = base64Bytes(s);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return Float32Array.from({ length: b.length >> 2 }, (_, i) => dv.getFloat32(i * 4, true));
};
/** Every pool's raw levels on the USD axis: a concentrated pool's ranges, the book's levels, a weighted pool's reserves. */
export function levelsOf(pools: PricedPool[], baseDecimals: number, positionsInRange?: (poolId: string, loTick: number, hiTick: number) => number): DepthLevel[] {
  const out: DepthLevel[] = [];
  const baseUnit = 10 ** baseDecimals;
  for (const p of pools) {
    const k = usdPerRaw(p, baseDecimals);
    const cUnit = 10 ** p.counterDecimals;
    for (const l of p.model.levels()) {
      const side = l.side ?? (l.nam > 0 && l.counter > 0 ? 'both' : l.nam > 0 ? 'ask' : 'bid');
      const lvl: DepthLevel = { pool: p.id, type: p.type, side, loUsd: l.lo * k, hiUsd: l.hi * k, nam: l.nam / baseUnit, counter: l.counter / cUnit, counterUsd: (l.counter / cUnit) * p.counterUsd, spread: p.model.spread, taker: p.taker };
      if (p.type === 'concentrated' && positionsInRange && l.loTick != null && l.hiTick != null) lvl.positions = positionsInRange(p.id, l.loTick, l.hiTick);
      if (l.orders != null) lvl.orders = l.orders;
      out.push(lvl);
    }
  }
  return out;
}
