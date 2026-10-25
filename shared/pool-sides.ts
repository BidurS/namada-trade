// What a NAM pool holds, read from its two reserves. A pool emptied on both sides holds nothing and is left out of the
// pool list and the pool count; a pool with one side empty is shown by what it holds, never as a "$0" pool: since
// 21 Oct 2026 pool 3008 holds about 910,000 NAM and no USDC, so it can be bought from but not sold into, and the
// router counts no NAM in a pool's liquidity, so its listed liquidity reads $0.

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
