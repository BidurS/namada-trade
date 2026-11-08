// The timeline's date words (web/src/screens/shielded/Timeline.tsx): pure, no React, so a test can hold them.
import { fmtDayMonth, fmtDayMonthYear } from '../../lib/format';

const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`);

/** "2 Dec 2025"; a span "1 Sep to 14 Sep 2026", or with both years when they differ. */
export function incidentDays(r: { date: string; end?: string }): string {
  const a = dayMs(r.date);
  if (!r.end || r.end === r.date) return fmtDayMonthYear(a);
  const b = dayMs(r.end);
  return r.date.slice(0, 4) === r.end.slice(0, 4) ? `${fmtDayMonth(a)} to ${fmtDayMonthYear(b)}` : `${fmtDayMonthYear(a)} to ${fmtDayMonthYear(b)}`;
}
