// The price grid of the depth curve and the way it is thinned for the page, shared by the Worker (which builds the
// curve every minute, worker/src/depth/model.ts) and the page (which rebuilds the grid from the stored reference price
// to place each pool's thinned curve on the same axis, web/src/screens/depth/model.ts). Pure functions, no chain types.
import { GRID_COARSE_STEP, GRID_FINE_SPAN, GRID_FINE_STEP } from './depth';

/** The aggregate grid in USD per whole base coin: steps of a quarter percent within four times the reference each way, one percent beyond, from 1e-7 to 200. */
export function buildGrid(center: number, { fineStep = GRID_FINE_STEP, fineSpan = GRID_FINE_SPAN, coarseStep = GRID_COARSE_STEP, lo = 1e-7, hi = 200 } = {}): number[] {
  const g = [center];
  let p = center;
  while (p > center / fineSpan) { p *= 1 - fineStep; g.push(p); }
  while (p > lo) { p *= 1 - coarseStep; g.push(p); }
  p = center;
  while (p < center * fineSpan) { p *= 1 + fineStep; g.push(p); }
  while (p < hi) { p *= 1 + coarseStep; g.push(p); }
  return g.sort((a, b) => a - b);
}

/** The indices kept when a grid of `n` points is thinned to at most `max` a side of the reference (both sides keep the reference and their far end). */
export function thinIndices(n: number, refIndex: number, max: number): number[] {
  const pick = (from: number, to: number) => { const len = to - from + 1; if (len <= max) return Array.from({ length: len }, (_, i) => from + i); const step = (len - 1) / (max - 1); return Array.from({ length: max }, (_, i) => Math.round(from + i * step)); };
  return [...new Set([...pick(0, refIndex), ...pick(refIndex, n - 1)])].sort((a, b) => a - b);
}

/** A cumulative curve read between its points: the value at `price` on the straight line between the two grid prices around it (clamped at the ends). */
export function cumOn(grid: ArrayLike<number>, values: ArrayLike<number>, price: number): number {
  const n = grid.length;
  if (!n) return 0;
  if (price <= grid[0]) return values[0];
  if (price >= grid[n - 1]) return values[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (grid[m] <= price) lo = m; else hi = m; }
  const t = (price - grid[lo]) / (grid[hi] - grid[lo] || 1);
  return values[lo] + Math.max(0, Math.min(1, t)) * (values[hi] - values[lo]);
}
