// The NAM whose unstaking wait is over and that was not withdrawn, by how long ago the wait ended.
//
// The chain's list of every unstaking request (UnbondTermStructure, served by GET /api/pressure) gives, for each
// epoch a wait ends in, the NAM and the number of requests, and says which epochs have passed. NAM past its wait
// can be withdrawn and moved at any time; how long it has sat there is what this adds. An epoch that has passed
// carries no time of its own in the list (its `estimatedAt` is the listing's time), so the age is counted: the
// epochs since the wait ended, times the epoch length the site measures. Epochs have not always been that long, so
// every age is "about", and the page says the epoch length and where it was measured. Without a measured epoch
// length there are no ages: the total stands alone and the page says why.
import type { UnbondTermStructure } from './types';

const DAY_SEC = 86_400;

/** The bands, youngest first: a wait that ended less than `underDays` ago (and no less than the band before). */
export const WAIT_OVER_BANDS = [
  { key: 'month', underDays: 30, words: 'under 30 days ago' },
  { key: 'quarter', underDays: 90, words: '30 to 90 days ago' },
  { key: 'year', underDays: 365, words: '90 days to a year ago' },
  { key: 'older', underDays: Number.POSITIVE_INFINITY, words: 'over a year ago' },
] as const;
export type WaitOverBandKey = (typeof WAIT_OVER_BANDS)[number]['key'];

export interface WaitOverBand { key: WaitOverBandKey; words: string; nam: number; count: number }
export interface WaitOverByAge {
  /** NAM past its wait and not withdrawn, of every size: the sum of the passed epochs (the list's own `withdrawableNowNam` when they agree to a millionth) */
  totalNam: number;
  count: number;
  /** the four bands, youngest first, each with its NAM and its requests; they add up to the totals */
  bands: WaitOverBand[];
  /** the epoch length the ages are counted with, in seconds, and where it was measured */
  epochSec: number;
  epochSecSource: string | null;
}

/**
 * The passed epochs of the list by age, or null when the list has no measured epoch length (then no age can be
 * stated) or holds nothing past its wait. An epoch at or after the list's current epoch that is marked as passed is
 * counted as just ended (zero epochs ago): the list says it can be withdrawn, and no age is made up for it.
 */
export function waitOverByAge(term: UnbondTermStructure | null | undefined): WaitOverByAge | null {
  if (!term || !(typeof term.epochSec === 'number' && Number.isFinite(term.epochSec) && term.epochSec > 0)) return null;
  const passed = term.buckets.filter((b) => b.withdrawableNow && Number.isFinite(b.amountNam) && b.amountNam > 0);
  if (!passed.length) return null;
  const bands: WaitOverBand[] = WAIT_OVER_BANDS.map((b) => ({ key: b.key, words: b.words, nam: 0, count: 0 }));
  for (const b of passed) {
    const days = (Math.max(0, term.currentEpoch - b.withdrawEpoch) * term.epochSec) / DAY_SEC;
    const band = bands[WAIT_OVER_BANDS.findIndex((x) => days < x.underDays)];
    band.nam += b.amountNam;
    band.count += Number.isFinite(b.count) ? b.count : 0;
  }
  return {
    totalNam: bands.reduce((a, b) => a + b.nam, 0),
    count: bands.reduce((a, b) => a + b.count, 0),
    bands,
    epochSec: term.epochSec,
    epochSecSource: term.epochSecSource ?? null,
  };
}

/** "about 6.0 hours": the epoch length in words, for the line that says how the ages were counted. */
export const epochWords = (sec: number): string => {
  const h = sec / 3600;
  return h >= 1 ? `about ${h.toFixed(1)} hours` : `about ${Math.round(sec / 60)} minutes`;
};
