// The two dates this site's own record starts from, which the shielded page, the alert cards and the address sheet
// name in words. Dates, not figures: a sentence formats them (shared/format.ts fmtDayMonthYear), and no figure that
// depends on them is typed anywhere.
//
// - shieldedMoves: the first move into or out of the shielded pool in the flow index (worker/src/series.ts SERIES_META,
//   "transfers and shielding 13 Jun 2025"; supply.masp_shielded.daily starts the same day). The pool's ledger
//   (series.ts maspMakeup) and "the largest move out on this site's record" count from here.
// - everyBalance: the first complete listing of every Namada balance this site made (migration 0007's first balance
//   listing, 20 Oct 2026 UTC): holders.first_seen is set from that listing on, so an address first seen after it was
//   first seen by this site, and an address without the mark was already there.
export const RECORD_SINCE = {
  shieldedMoves: Date.UTC(2025, 5, 13),
  everyBalance: Date.UTC(2026, 9, 20),
} as const;
