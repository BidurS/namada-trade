// The one link from the Trade ticket to the place the trade can be made (owner decision 46, 2026-11-10).
//
// The site quotes and never trades: it has no wallet connection for trading, makes no order and passes nothing to
// the exchange. A reader who has read the quote still has to find the pair on Osmosis. This is that link and nothing
// more: plain text named for the pair, the Osmosis app's own page for it, opened in a new tab with no referrer and
// no handle back to this page. It carries no amount, no address and no side: only the pair. It is not a button and
// is not styled as one.

/** The Osmosis app's own page for the pair (checked on 2026-11-11: it opens with NAM as the coin given and USDC as the coin taken). */
export const OSMOSIS_PAIR_URL = 'https://app.osmosis.zone/?from=NAM&to=USDC';
/** The link's words: the pair and where it opens. */
export const OSMOSIS_PAIR_LINK = 'Open NAM / USDC on Osmosis';
/** Said beside it: what the link is and that this site still makes no trade. */
export const OSMOSIS_PAIR_NOTE = 'Opens the Osmosis app in a new tab. This site makes no trade and sends nothing with the link.';
