// Skeleton (system.md 8): row-shaped blocks at the FINAL heights (so nothing shifts when data
// arrives, CLS under 0.1), six to eight rows, one 1.2 s shimmer (static under reduced motion).
// Never a waiting word (banned by the copy lint): the region is aria-busy with a plain label for screen readers.

export interface SkeletonProps {
  /** Number of rows (default 6). */
  rows?: number;
  /** Row heights in px; the last value repeats (holders 64, ladder 72, pools 68, moves 64, legend 60). */
  heights?: number[];
  /** What is being fetched, for screen readers ("holders"). */
  label?: string;
  /** A reserved 24 px chip slot above the rows. */
  chip?: boolean;
  className?: string;
}

export function Skeleton({ rows = 6, heights = [64], label = 'figures', chip, className = '' }: SkeletonProps) {
  return (
    <div className={`skel ${className}`} aria-busy="true" role="status" aria-label={`Fetching ${label}`}>
      {chip ? <span className="skel__b skel__chip" aria-hidden="true" /> : null}
      {Array.from({ length: rows }, (_, i) => {
        const h = heights[Math.min(i, heights.length - 1)];
        return (
          <div key={i} className="skel__row" style={{ minHeight: h }} aria-hidden="true">
            <span className="skel__b skel__b--w60" />
            <span className="skel__b skel__b--n" />
            {h >= 56 ? <span className="skel__b skel__b--sm skel__b--w40" /> : null}
          </div>
        );
      })}
    </div>
  );
}

/** One block of a fixed size (chart areas, hero figures). */
export function SkeletonBlock({ height, width, className = '' }: { height: number; width?: number | string; className?: string }) {
  return <span className={`skel__b skel__block ${className}`} style={{ height, width }} aria-hidden="true" />;
}

export default Skeleton;
