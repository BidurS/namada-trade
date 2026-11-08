// The week's shielded transactions as one sentence (the Shielded page's strip sheet on a phone, 2026-11-08): pure, no
// React, so a test can hold it (test/masp-activity.test.ts). The two daily series come from /api/series
// (masp.txs_daily, masp.txs_inside_daily); the screen fetches them (index.tsx useMaspActivity) and draws the bars.
import type { SeriesResponse } from '../../../../shared/types';
import { SHIELDED_WORDS } from '../../../../shared/copy';
import { fmtCount, fmtDayMonthYear } from '../../lib/format';
import type { Stamp } from '../../lib/prov';

const DAY = 86_400_000;

/** The two daily series as fetched: null while loading or failed (`failed` says which). */
export interface MaspActivitySeries { at: number | null; all: SeriesResponse | null; inside: SeriesResponse | null; failed: boolean }

/**
 * The week's sentence from the two series: the counted days among the 7 whole UTC days before the day of `end`,
 * summed, with how many of the 7 were counted when not all were, and the start of the record. The day of `end` is
 * left out because a day is counted only once the block follower has scanned past its end, so the current day never
 * has a point while it is current. Null while the series have not arrived or no day of the window is counted (the
 * sheet then says nothing: no 0 stands in).
 */
export function activityWeek(a: MaspActivitySeries, end: number): { text: string; stamp: Stamp } | null {
  if (!a.all || !a.inside) return null;
  const to = Math.floor(end / DAY) * DAY;
  const from = to - 7 * DAY;
  const days = a.all.points.filter((p) => p.t >= from && p.t < to);
  if (!days.length) return null;
  const insideBy = new Map(a.inside.points.map((p) => [p.t, p.v]));
  const txs = days.reduce((s, p) => s + p.v, 0);
  const inside = days.reduce((s, p) => s + (insideBy.get(p.t) ?? 0), 0);
  const parts = [SHIELDED_WORDS.activity(SHIELDED_WORDS.activityCount(fmtCount(txs), txs === 1), fmtCount(inside))];
  if (days.length < 7) parts.push(SHIELDED_WORDS.activityPartial(fmtCount(days.length)));
  if (a.all.start != null) parts.push(SHIELDED_WORDS.activitySince(fmtDayMonthYear(a.all.start)));
  return { text: parts.join(' '), stamp: a.all.prov as Stamp };
}
