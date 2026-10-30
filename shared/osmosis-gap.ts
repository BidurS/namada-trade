// The known hole in the stored Osmosis record (the pool completeness check of 2026-10-29): before 20 Oct 2026 22:00 UTC
// the stored history misses at least 350 pool transactions (before 10 Oct 06:47 UTC it holds only the transactions that
// swapped through pool 3005; then 14 on 15 Oct and one on 20 Oct), none of them in the moves or the trades. Since then
// every pool transaction is stored. Every Osmosis figure whose window reaches back before the cut-off carries the
// sentence in its stamp; no figure is changed for it. The cut-off and the words are here once, so the note can be
// removed in one place once the history is repaired (that repair writes to the production database and waits on the
// owner).

/** The first moment the stored Osmosis record is complete from: 20 Oct 2026 22:00 UTC. */
export const OSMOSIS_GAP_UNTIL = Date.UTC(2026, 9, 20, 22, 0);

/** The sentence every such stamp carries, in plain words. */
export const OSMOSIS_GAP_NOTE = 'The Osmosis record before 20 Oct 2026 22:00 UTC is missing at least 350 pool transactions.';

/** True when a window starting at `from` (unix ms) reaches back before the cut-off. */
export const reachesOsmosisGap = (from: number | null | undefined): boolean => from != null && Number.isFinite(from) && from < OSMOSIS_GAP_UNTIL;

/** The gap sentence and which windows reach back before the cut-off ("30-day", or "7-day and 30-day"). */
export const osmosisGapWindows = (words: string[]): string =>
  `${OSMOSIS_GAP_NOTE} The ${words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]} windows reach` : `${words[0]} window reaches`} back before then.`;

/** The gap sentence for figures counted over the whole record ("The makers' trade counts"). */
export const osmosisGapCounts = (what: string): string => `${OSMOSIS_GAP_NOTE} ${what} reach back before then.`;

/** A stamp's note with the gap sentence added when the window starting at `from` reaches back before the cut-off (each sentence once). */
export function withOsmosisGap<P extends { note?: string }>(prov: P, from: number | null | undefined): P {
  if (!reachesOsmosisGap(from) || prov.note?.includes(OSMOSIS_GAP_NOTE)) return prov;
  return { ...prov, note: [prov.note, OSMOSIS_GAP_NOTE].filter(Boolean).join(' ') };
}
