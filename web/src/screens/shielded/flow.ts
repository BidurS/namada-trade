// Shielded (S4), decision D5: the "Moved in and out" chart's constants and pure helpers (no React, no DOM).
//
// The server (worker/src/analytics.ts blindSpot) sends `pulseSeries`: NAM moved into and out of the shielded
// set in 6-hour slices over the last 30 days. Each slice also carries the part of its moves out that the
// server paired with a move in of the same amount (within half a percent) made no more than 24 hours earlier
// (`turnstileNam`, from matchMaspPassthroughs), and `passthroughs7d` lists those pairs for the last 7 days with
// the server's own confidence in each link. The slice length, the pairing rule and the windows are stated
// here, once, because the response does not carry them yet (the worker's `pulseBucketMs`, `windowMs` and
// `maxRelDiff` defaults); the screen never types them into JSX.
import type { MaspPassthroughLink, MaspPulseBucket } from '../../../../shared/types';
import type { SeriesRange } from '../../ui';

const H = 3_600_000;
const DAY = 24 * H;

/** One slice of the in-and-out series (the server's pulseBucketMs). */
export const SLICE = { hours: 6, ms: 6 * H, words: '6 hours' } as const;

/** The pairing rule: a move out of the same amount, within the tolerance, this long after a move in at most. */
export const PAIR = { hours: 24, ms: 24 * H, words: '24 hours', tolerancePct: 0.5 } as const;

/** How far back the server's slices go, in days. */
export const SERIES_DAYS = 30;

export interface FlowWindow extends SeriesRange {
  ms: number;
  days: number;
  /** The window in running text ("7 days"). */
  words: string;
}

/** The windows the chart offers; the longest is the whole series. */
export const FLOW_WINDOWS: FlowWindow[] = [
  { value: '7d', label: '7d', ms: 7 * DAY, days: 7, words: '7 days' },
  { value: '14d', label: '14d', ms: 14 * DAY, days: 14, words: '14 days' },
  { value: '30d', label: '30d', ms: SERIES_DAYS * DAY, days: SERIES_DAYS, words: `${SERIES_DAYS} days` },
];
export const FLOW_WINDOW_DEFAULT = FLOW_WINDOWS[FLOW_WINDOWS.length - 1].value;

export const flowWindow = (value: string): FlowWindow => FLOW_WINDOWS.find((r) => r.value === value) ?? FLOW_WINDOWS[FLOW_WINDOWS.length - 1];

/** The slices that overlap the window ending at `end`, oldest first; nothing is added or padded. */
export function slicesIn(buckets: MaspPulseBucket[], end: number, windowMs: number): MaspPulseBucket[] {
  const start = end - windowMs;
  return buckets
    .filter((b) => Number.isFinite(b.ts) && b.ts + SLICE.ms > start && b.ts <= end)
    .sort((a, b) => a.ts - b.ts);
}

export interface FlowSums {
  /** NAM moved in over the window. */
  in: number;
  /** NAM moved out over the window. */
  out: number;
  /** The part of `out` the server paired with a move in of the same amount within PAIR.ms. */
  back: number;
  net: number;
  /** The slice with the most NAM moved in, and the one with the most moved out (null when nothing moved). */
  mostIn: MaspPulseBucket | null;
  mostOut: MaspPulseBucket | null;
}

export function flowSums(slices: MaspPulseBucket[]): FlowSums {
  const s: FlowSums = { in: 0, out: 0, back: 0, net: 0, mostIn: null, mostOut: null };
  for (const b of slices) {
    s.in += b.inNam;
    s.out += b.outNam;
    s.back += b.turnstileNam;
    if (b.inNam > 0 && (!s.mostIn || b.inNam > s.mostIn.inNam)) s.mostIn = b;
    if (b.outNam > 0 && (!s.mostOut || b.outNam > s.mostOut.outNam)) s.mostOut = b;
  }
  s.net = s.in - s.out;
  return s;
}

/**
 * The chart's takeaway title. `n` is the figure the screen renders (through Num) in front of `text`;
 * null when the sentence has no figure. "29,425 NAM more moved in than out over 7 days".
 */
export function flowTakeaway(sums: FlowSums, windowWords: string): { n: number | null; text: string } {
  if (sums.in === 0 && sums.out === 0) return { n: null, text: `Nothing moved in or out over ${windowWords}` };
  if (sums.net > 0) return { n: sums.net, text: `NAM more moved in than out over ${windowWords}` };
  if (sums.net < 0) return { n: -sums.net, text: `NAM more moved out than in over ${windowWords}` };
  return { n: null, text: `The same amount moved in and out over ${windowWords}` };
}

/** The server's confidence in a pair, in words a holder can read (it is a link by amount and time, never a certainty). */
export const PAIR_WORDS: Record<MaspPassthroughLink['confidence'], string> = {
  high: 'a close match',
  medium: 'a likely match',
  low: 'a loose match',
};

/** The pair, if any, whose move out is this row (same destination, within a minute). */
export const pairFor = (pairs: MaspPassthroughLink[] | undefined, to: string | null, ts: number): MaspPassthroughLink | undefined =>
  to ? pairs?.find((p) => p.outTo === to && Math.abs(p.outTs - ts) < 60_000) : undefined;
