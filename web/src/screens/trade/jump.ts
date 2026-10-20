// Where selling starts to cost much more per extra NAM: the server marks one listed size of the size table
// (QuoteCurveResponse.liquidityCliffNam, the rule in shared/size-table.ts), and the screen says it with the
// figures that justify it: the price move of the slice just above that size against the slice just below.
// Pure functions, no React, nothing invented (N2): a slice's move is the server's marginalSellImpactPct when
// it sent one, else the same arithmetic over the size table's own rows (what the pools pay for the extra NAM,
// against the quoted price); when neither is possible the move is null and the page prints "—".
import type { QuoteCurveResponse, SlippageCurvePoint } from '../../../../shared/types';
import { tablePoints } from './model';

const fin = (x: number | null | undefined): x is number => x != null && Number.isFinite(x);

/** One slice of the size table: selling the NAM between two listed sizes. `fromNam` is 0 for the first slice. */
export interface Slice {
  fromNam: number;
  toNam: number;
  /** How far selling this slice on its own moves the price, percent (positive). */
  movePct: number | null;
}

export interface Jump {
  /** The listed size the server marked: above it each extra NAM sold gets a much lower price. */
  aboveNam: number;
  /** The slice just below the mark. */
  before: Slice;
  /** The slice just above the mark, the one that jumps. */
  after: Slice;
}

/** The sell-side price move of the slice from `a` to `b` (a null `a` is the slice from nothing). */
function sliceMove(a: SlippageCurvePoint | null, b: SlippageCurvePoint, spotUsd: number | null): number | null {
  if (fin(b.marginalSellImpactPct)) return b.marginalSellImpactPct;
  const fromNam = a?.amountNam ?? 0;
  const fromUsdc = a?.sellOutUsdc ?? 0;
  if (!fin(spotUsd) || spotUsd <= 0 || !fin(b.sellOutUsdc) || (a && !fin(a.sellOutUsdc))) return null;
  const dNam = b.amountNam - fromNam;
  if (!(dNam > 0)) return null;
  const perNam = Math.max(0, (b.sellOutUsdc - fromUsdc) / dNam);
  return Math.max(0, ((spotUsd - perNam) / spotUsd) * 100);
}

/** The marked size with its two slices; null when the server marked none, or the mark is not a listed size with a slice above it. */
export function jumpOf(c: QuoteCurveResponse | null): Jump | null {
  if (!c || !fin(c.liquidityCliffNam)) return null;
  const P = tablePoints(c);
  const i = P.findIndex((p) => p.amountNam === c.liquidityCliffNam);
  if (i < 0 || i + 1 >= P.length) return null;
  const spot = fin(c.spotUsd) ? c.spotUsd : null;
  const below = i > 0 ? P[i - 1] : null;
  return {
    aboveNam: P[i].amountNam,
    before: { fromNam: below?.amountNam ?? 0, toNam: P[i].amountNam, movePct: sliceMove(below, P[i], spot) },
    after: { fromNam: P[i].amountNam, toNam: P[i + 1].amountNam, movePct: sliceMove(P[i], P[i + 1], spot) },
  };
}
