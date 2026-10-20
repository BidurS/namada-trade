// OrderSizeCurve math (system.md 7.2), pure and unit-tested in test/ui-curve.test.ts.
//
// - The x axis is logarithmic over the real quote sizes (1,000 to 100,000 NAM).
// - The slider has 1,000 units and snaps to a real quote within SNAP units (about 12).
// - At a real quote the readout IS the quote (the same object, no arithmetic).
// - Between two quotes it interpolates LINEARLY between those two quotes, says it is an
//   estimate and names the two sizes used.
// - Outside the quoted range it returns `out`: the page shows "—" and does not guess.
import type { SlippageCurvePoint } from '../../../shared/types';

export const SLIDER_MAX = 1000;
export const SNAP = 12;

/** One real quote, reduced to the fields the curve reads. */
export interface CurveQuote {
  n: number; // NAM
  worth: number | null; // dollar value of n NAM at the quoted price
  sellOut: number | null; // USDC received selling n NAM
  sellMove: number | null; // price move selling, percent, magnitude
  buyIn: number | null; // USDC paid buying n NAM worth
  buyMove: number | null; // price move buying, percent, magnitude
}

export const fromApi = (p: SlippageCurvePoint): CurveQuote => ({
  n: p.amountNam,
  worth: p.usdSize ?? null,
  sellOut: p.sellOutUsdc ?? null,
  sellMove: p.sellImpactPct == null ? null : Math.abs(p.sellImpactPct),
  buyIn: p.buyInUsdc ?? null,
  buyMove: p.buyImpactPct == null ? null : Math.abs(p.buyImpactPct),
});

/** Sorted, de-duplicated, positive sizes only. */
export function normalise(points: CurveQuote[]): CurveQuote[] {
  const seen = new Set<number>();
  return points
    .filter((p) => p && Number.isFinite(p.n) && p.n > 0)
    .sort((a, b) => a.n - b.n)
    .filter((p) => (seen.has(p.n) ? false : (seen.add(p.n), true)));
}

export type CurveReading =
  | { kind: 'quote'; n: number; q: CurveQuote }
  | { kind: 'estimate'; n: number; a: CurveQuote; b: CurveQuote; v: CurveQuote }
  | { kind: 'out'; n: number; lo: number | null; hi: number | null };

const mix = (a: number | null, b: number | null, t: number): number | null => (a == null || b == null ? null : a + (b - a) * t);

/** What the curve says about an order of `n` NAM. */
export function curveAt(points: CurveQuote[], n: number): CurveReading {
  const P = normalise(points);
  if (!P.length || !Number.isFinite(n)) return { kind: 'out', n, lo: P[0]?.n ?? null, hi: P[P.length - 1]?.n ?? null };
  const exact = P.find((p) => p.n === n);
  if (exact) return { kind: 'quote', n, q: exact };
  for (let i = 0; i < P.length - 1; i++) {
    const a = P[i];
    const b = P[i + 1];
    if (n > a.n && n < b.n) {
      const t = (n - a.n) / (b.n - a.n);
      return {
        kind: 'estimate',
        n,
        a,
        b,
        v: { n, worth: mix(a.worth, b.worth, t), sellOut: mix(a.sellOut, b.sellOut, t), sellMove: mix(a.sellMove, b.sellMove, t), buyIn: mix(a.buyIn, b.buyIn, t), buyMove: mix(a.buyMove, b.buyMove, t) },
      };
    }
  }
  return { kind: 'out', n, lo: P[0].n, hi: P[P.length - 1].n };
}

/** Position of a size on the log axis, 0..1 (clamped). */
export function logPos(n: number, lo: number, hi: number): number {
  if (!(lo > 0) || !(hi > lo) || !(n > 0)) return 0;
  return Math.min(1, Math.max(0, (Math.log(n) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))));
}

/** Slider units (0..1000) for a size. */
export const sizeToSlider = (n: number, lo: number, hi: number): number => Math.round(logPos(n, lo, hi) * SLIDER_MAX);

/**
 * Size for a slider position: snaps to a real quote within SNAP units; otherwise the log
 * position rounded to a readable size (10 NAM below 10,000, 100 NAM above).
 */
export function sliderToSize(s: number, sizes: number[]): number {
  const S = [...sizes].filter((x) => x > 0).sort((a, b) => a - b);
  if (!S.length) return 0;
  const lo = S[0];
  const hi = S[S.length - 1];
  for (const n of S) if (Math.abs(s - logPos(n, lo, hi) * SLIDER_MAX) <= SNAP) return n;
  const raw = Math.exp(Math.log(lo) + (Math.min(SLIDER_MAX, Math.max(0, s)) / SLIDER_MAX) * (Math.log(hi) - Math.log(lo)));
  const unit = raw >= 10_000 ? 100 : 10;
  return Math.min(hi, Math.max(lo, Math.round(raw / unit) * unit));
}
