// What a NAM pool holds, read from its two reserves. A pool emptied on both sides holds nothing and is left out of the
// pool list and the pool count; a pool with one side empty is shown by what it holds, never as a "$0" pool. The words
// come from the read each time, never from a note here: pool 3008 (the NAM/USDC order book) held NAM and no USDC on
// 21 Oct 2026 and 174.70 USDC of bids beside its NAM on 29 Oct, and the router counts no NAM in a pool's liquidity,
// so a pool holding only NAM reads $0 in the router's list while it can still be bought from.

/** 'both': two sides to trade; 'nam': only NAM inside; 'coin': only the other coin; 'empty': nothing; 'unknown': a reserve not read. */
export type PoolSides = 'both' | 'nam' | 'coin' | 'empty' | 'unknown';

export function poolSides(p: { namReserve: number | null | undefined; counterReserve: number | null | undefined }): PoolSides {
  const nam = p.namReserve, coin = p.counterReserve;
  if (nam == null || coin == null || !Number.isFinite(nam) || !Number.isFinite(coin)) return 'unknown';
  if (nam > 0 && coin > 0) return 'both';
  if (nam > 0) return 'nam';
  if (coin > 0) return 'coin';
  return 'empty';
}

/** A pool worth listing: anything but a pool known to be empty on both sides. */
export const poolHoldsSomething = (p: { namReserve: number | null | undefined; counterReserve: number | null | undefined }): boolean => poolSides(p) !== 'empty';

/** The counter coin in plain words ("USDC", "coin 0FA923…", "allBTC"), as a row names it: a pool from /api/pools or a pair from /api/series/pairs. */
export function counterName(p: { pair: string; counterSymbol?: string | null }): string {
  const parts = p.pair.split('/').map((s) => s.trim());
  const sym = p.counterSymbol || parts.slice(1).join('/');
  // a bridged coin's denomination hash: its first six characters, enough to tell two apart in a row
  if (/^ibc\//i.test(sym)) return `coin ${sym.length > 14 ? `${sym.slice(4, 10)}…` : sym.slice(4)}`;
  if (/^factory\//i.test(sym)) return sym.split('/').pop() || sym;
  if (!sym || /^unknown$/i.test(sym)) return 'unknown coin';
  return sym;
}

/**
 * The pools that can be priced must hold at least this share of all the NAM in the pools for their sum to stand as the
 * money in the pools. A pool holding no NAM needs no NAM price, so in a minute with no NAM price the few USDC of an
 * emptied pool would otherwise be "the money in the pools" while 1.56 million NAM sat in the pools left out.
 */
export const TOTAL_NAM_SHARE_MIN = 0.9;

/** The money in the pools (worker/src/pool-sizes.ts poolsTotal, the Trade page's depth): see pricedTotal. */
export interface PricedTotal {
  /** the priced pools' sizes summed; null when no pool is priced or the priced ones hold under TOTAL_NAM_SHARE_MIN of the NAM */
  usd: number | null;
  priced: number;
  notPriced: number;
  /** the share (0 to 1) of all the NAM in the pools that sits in pools not priced; null when the pools hold no NAM */
  namLeftOut: number | null;
}

/**
 * The priced pools' sizes summed, when they hold at least TOTAL_NAM_SHARE_MIN of all the NAM in the pools (or the pools
 * hold no NAM at all); else not known, never the sum of the few that could be priced. The pools not priced are counted
 * and their share of the NAM is said beside the figure.
 */
export function pricedTotal(pools: { liquidityUsd: number | null | undefined; namReserve: number | null | undefined }[]): PricedTotal {
  const fin = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);
  const priced = pools.filter((p) => fin(p.liquidityUsd));
  const nam = pools.reduce((a, p) => a + (fin(p.namReserve) ? p.namReserve : 0), 0);
  const namPriced = priced.reduce((a, p) => a + (fin(p.namReserve) ? p.namReserve : 0), 0);
  const namLeftOut = nam > 0 ? Math.max(0, 1 - namPriced / nam) : null;
  const stands = priced.length > 0 && (namLeftOut == null || 1 - namLeftOut >= TOTAL_NAM_SHARE_MIN);
  return { usd: stands ? priced.reduce((a, p) => a + (p.liquidityUsd as number), 0) : null, priced: priced.length, notPriced: pools.length - priced.length, namLeftOut };
}

/** A share of the NAM in words: "3%", "0.58%", never "0%" for a share that is not nothing. */
const shareWords = (x: number) => { const pct = x * 100; return pct >= 10 ? `${Math.round(pct)}%` : pct === 0 ? '0%' : `${Number(pct.toPrecision(2))}%`; };

/** Why the money in the pools is not known (pricedTotal gave no total), in plain words. */
export function totalNotKnownWords(t: PricedTotal): string {
  if (!t.priced) return 'The money in the pools is not known: no pool can be priced.';
  return `The money in the pools is not known: the pools that can be priced hold ${shareWords(1 - (t.namLeftOut ?? 0))} of the NAM in the pools, under the ${Math.round(TOTAL_NAM_SHARE_MIN * 100)}% a total needs.`;
}

/** The NAM the pools not priced hold, in words, beside a total that stands ("The pools not priced hold 3% of the NAM in the pools."); '' when none. */
export function namLeftOutWords(t: PricedTotal): string {
  return t.notPriced && t.namLeftOut != null && t.namLeftOut > 0 ? `The pools not priced hold ${shareWords(t.namLeftOut)} of the NAM in the pools.` : '';
}

/** The pools of a summed line: their priced total, the largest priced one, and how many of them are not priced (no size, counted in no total). */
export function restOf(rest: { liquidityUsd: number | null }[]): { usd: number; max: number; notPriced: number } {
  const priced = rest.map((p) => p.liquidityUsd).filter((v): v is number => v != null && Number.isFinite(v));
  return { usd: priced.reduce((a, v) => a + v, 0), max: priced.reduce((a, v) => Math.max(a, v), 0), notPriced: rest.length - priced.length };
}

/**
 * A one-sided pool in words, for its own row: what stands in the depth column and the line under the pool's name.
 * `coin` is the other coin's name ("USDC"), or null when it has none a reader knows.
 */
export function oneSidedWords(sides: PoolSides, coin: string | null): { depth: string; line: string } | null {
  const other = coin ?? 'the other coin';
  if (sides === 'nam') return { depth: 'Only NAM inside', line: `no ${other} inside: it can be bought from, not sold into` };
  if (sides === 'coin') return { depth: `Only ${coin ?? 'the other coin'} inside`, line: 'no NAM inside: it can be sold into, not bought from' };
  return null;
}
