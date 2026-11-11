// The phone cut of Trade (platform plan, release E; owner-decisions row 42): under 1024 px the evidence under the
// answer (the ticket and the token header) shows one band at a time behind a segmented strip, the price first. This
// file names the four bands, in the strip's order, and says which band an element of the page sits in, so a link to
// a part that is not shown (a pasted /trade#h-pools, an in-page link) shows its band first.
//
// Pure, no React. The strip's labels are the bands' own heading words ("Price paid in trades", "How size moves the
// price", the pools, "The latest trades"), one word each so four fit a 320 px phone.

export type Band = 'price' | 'size' | 'pools' | 'trades';

/** The strip's choices, in its order. The first is the one shown when the page opens. */
export const BANDS: { value: Band; label: string }[] = [
  { value: 'price', label: 'Price' },
  { value: 'size', label: 'Size' },
  { value: 'pools', label: 'Pools' },
  { value: 'trades', label: 'Trades' },
];
export const FIRST_BAND: Band = 'price';

const isBand = (s: string | undefined): s is Band => BANDS.some((b) => b.value === s);

/**
 * The band of each heading id, for a target that is not in the DOM yet when the link is followed (the price chart's
 * heading comes with its history, the daily bars' with theirs). A target that is in the DOM is read from the DOM.
 */
const HEADING_BAND: Record<string, Band> = {
  'h-chart': 'price', 'h-flow': 'price', 'h-buyers': 'price', 'h-turn': 'price', 'h-daily': 'price',
  'h-ladder': 'size',
  'h-pools': 'pools',
  'h-tape': 'trades',
};

/** The element id a URL fragment names ("#h-pools" → "h-pools"); null for none or one that cannot be decoded. */
export function hashId(hash: string): string | null {
  if (!hash || hash === '#') return null;
  try {
    return decodeURIComponent(hash.replace(/^#/, '')) || null;
  } catch {
    return null;
  }
}

/** The band an element id sits in: its nearest [data-band] ancestor, else the heading table; null when it is in no band. */
export function bandOfId(id: string | null, doc: Pick<Document, 'getElementById'> | null = typeof document === 'undefined' ? null : document): Band | null {
  if (!id) return null;
  const at = doc?.getElementById(id)?.closest<HTMLElement>('[data-band]')?.dataset.band;
  if (isBand(at)) return at;
  return HEADING_BAND[id] ?? null;
}
