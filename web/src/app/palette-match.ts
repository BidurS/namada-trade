// The search box's text matching, apart from its React component (Palette.tsx) so a test can read it without the
// shell: how well a typed text matches a value (textTier), and the plain words a reader types that name something
// the site calls otherwise (wordRows over shared/search-words.ts). Pure: no React, no router, nothing from the page.
import { SEARCH_WORDS, type SearchWord } from '../../../shared/search-words';

/** Match tiers: 0 exact, 1 start of the value, 2 its end, 3 a word start, 4 inside, NO_MATCH none. */
export const NO_MATCH = 9;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The best tier of `term` against any of `values` (case ignored). */
export function textTier(term: string, ...values: (string | null | undefined)[]): number {
  const t = term.trim().toLowerCase();
  if (!t) return NO_MATCH;
  const wordStart = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(t)}`, 'u');
  let best = NO_MATCH;
  for (const v of values) {
    if (!v) continue;
    const s = v.toLowerCase();
    if (s === t) return 0;
    if (s.startsWith(t)) best = Math.min(best, 1);
    else if (s.endsWith(t) && /^[0-9a-z]+$/.test(t)) best = Math.min(best, 2);
    else if (wordStart.test(s)) best = Math.min(best, 3);
    else if (s.includes(t)) best = Math.min(best, 4);
  }
  return best;
}

/** Text needed before a plain-word row is listed: one letter is inside most words, as it is for the glossary list. */
export const WORDS_MIN_CHARS = 2;

/** A plain-word row a typed text found, with how well it matched (the tier of textTier). */
export interface WordRow {
  word: SearchWord;
  tier: number;
}

/**
 * The plain-word rows a typed text finds (shared/search-words.ts): each row whose words, or whose own label, the text
 * matches, with the best tier, in the table's order (the search box ranks them with the pages it lists). `listed` is
 * the pages already listed for the same text: a row with the path and the label of one of them would say the same
 * thing twice, so it is left out. While the site is rewound, a row whose page shows the thing only as it is now is
 * left out too. Nothing is found for no text, or for less than WORDS_MIN_CHARS characters.
 */
export function wordRows(term: string, listed: readonly { path: string; label: string }[] = [], rewound = false): WordRow[] {
  const t = term.trim();
  if (t.length < WORDS_MIN_CHARS) return [];
  const out: WordRow[] = [];
  for (const word of SEARCH_WORDS) {
    if (rewound && word.liveOnly) continue;
    const tier = textTier(t, ...word.words, word.label);
    if (tier === NO_MATCH) continue;
    if (listed.some((v) => v.path === word.path && v.label === word.label)) continue;
    out.push({ word, tier });
  }
  return out;
}
