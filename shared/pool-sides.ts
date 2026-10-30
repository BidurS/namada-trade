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
