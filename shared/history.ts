// Chart history ranges, shared by every screen that draws a stored series over time (the Trade price chart,
// the record of what was bought and sold, the staked-NAM trend): how many days each range fetches, and the
// one cap behind "All". "All" is a cap, not everything: it is the most days a history request asks for at
// once, so a chart that runs into it says so. The worker's replay cache lists the same windows in hours
// (worker/src/http.ts ORDERFLOW_HOURS: 28800 h is 1,200 days), so every range here is one it has an answer for.

export const DAY_MS = 86_400_000;
export const DAY_HOURS = 24;

/** The chart ranges a reader can pick (the UI kit's ChartRange has the same members). */
export type HistoryRange = '24h' | '7d' | '30d' | '90d' | '1y' | 'all';

/** How far back "All" reaches: the most days asked for at once. */
export const HISTORY_ALL_DAYS = 1200;

/**
 * Days fetched for each range. The three short ranges share one 30-day fetch (switching between them makes
 * no request); the long ones fetch deeper history.
 */
export const HISTORY_FETCH_DAYS: Record<HistoryRange, number> = { '24h': 30, '7d': 30, '30d': 30, '90d': 90, '1y': 365, all: HISTORY_ALL_DAYS };

export const historyFetchHours = (range: HistoryRange): number => HISTORY_FETCH_DAYS[range] * DAY_HOURS;

/**
 * The days "How much trades against how little" draws on the Trade page (screener-plan 3.5b): its series request
 * starts this many days back. The worker's replay rule (worker/src/http.ts seriesFromDays) lists it beside the
 * ranges above, so the request the page sends is never limited.
 */
export const DAILY_DAYS = 14;

/**
 * Did an "All" answer run into the cap? True when the series' earliest point sits within `slackMs` of the
 * window's start (its end minus the cap), so there may be older readings the request did not ask for. False
 * when the series starts later than that: the record itself begins there, and "All" shows all of it.
 */
export function historyCapReached(earliestTs: number | null | undefined, endTs: number, slackMs = 2 * DAY_MS): boolean {
  if (earliestTs == null || !Number.isFinite(earliestTs) || !Number.isFinite(endTs)) return false;
  return earliestTs - (endTs - HISTORY_ALL_DAYS * DAY_MS) <= slackMs;
}
