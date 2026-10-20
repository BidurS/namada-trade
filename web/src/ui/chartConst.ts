// Chart rules shared by PriceChart and OrderflowChart. Every number a chart's words depend on lives
// here, never in JSX (N2): the components render words from these values.

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** A window is "sparse" when fewer than this share of its spans holds a point. */
export const SPARSE_SHARE = 0.5;

/** A quoted-price line with fewer points than this says how few it has. */
export const FEW_POINTS = 10;

/**
 * The server keeps one executed-swap median per hour for price history up to this many days
 * (worker/src/api.ts historyBucketMs); a longer request comes back thinned to one point per 6 hours or per
 * day, and some of its points are hourly medians backfilled from the swaps themselves. So only up to here
 * can the chart count the hours without a trade; beyond it a gap is not an hour without a trade.
 */
export const HOURLY_HISTORY_DAYS = 31;

/** Plain words for a span length: "hour", "2 hours", "6 hours", "day", "7 days". */
export function spanWords(ms: number): string {
  if (!(ms > 0) || !Number.isFinite(ms)) return 'span';
  if (ms >= DAY_MS) {
    const d = Math.round(ms / DAY_MS);
    return d === 1 ? 'day' : `${d} days`;
  }
  const h = Math.max(1, Math.round(ms / HOUR_MS));
  return h === 1 ? 'hour' : `${h} hours`;
}

/** The plural for counting spans: "hours", "6-hour spans", "days". */
export function spansWords(ms: number): string {
  if (!(ms > 0) || !Number.isFinite(ms)) return 'spans';
  if (ms >= DAY_MS) {
    const d = Math.round(ms / DAY_MS);
    return d === 1 ? 'days' : `${d}-day spans`;
  }
  const h = Math.max(1, Math.round(ms / HOUR_MS));
  return h === 1 ? 'hours' : `${h}-hour spans`;
}
