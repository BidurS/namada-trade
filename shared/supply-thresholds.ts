// Cuts the Supply screen (/supply) shares with the server. One place, so the words on the page and the
// figure the server sends are made by the same rule.

/**
 * An address counts among "the addresses that sell most of what reaches them" when its share is at least
 * this (0 to 1). The server applies the same cut (worker/src/analytics.ts pressure(),
 * SupplyCohortBreakdown.highHazardRemainingNam: dumpHazardScore >= this); the page uses it twice:
 * - Ready to sell: an address's selling estimate (OnDeckEntry.dumpHazardScore) at or above it;
 * - the unstaking chart: an address that sold or moved to Osmosis at least this share of what it unlocked
 *   in the staking list's window (each withdrawal's own follow-up, UnlockEntry.outcome).
 * The worker imports it (worker/src/analytics.ts), so the page and the server cut at the same place.
 */
export const SELLS_MOST_CUT = 0.6;

/** The cut as a percent, for the page's words ("60%"). */
export const SELLS_MOST_PCT = SELLS_MOST_CUT * 100;
