// The plain words a reader types into the search box (web/src/app/Palette.tsx), each with the site's own name for the
// thing and the page that shows it. The public review of 2026-11-10 found that "price", "volume" and "market cap"
// found nothing there: the Views group matched only a page's label and its heading.
//
// A row:
//   words  what a reader types, lower case. They are match keys only and are never rendered, so they may be terms
//          the site does not write ("market cap", "ibc", "masp", "apr").
//   label  the site's own name for the thing, exactly as the destination prints it. test/search-words.test.ts pins
//          each label to the text of its screen or of shared/copy.ts, so a renamed heading fails there.
//   where  where on the site that is, in a few words. A row that names a whole page says so.
//   path   a route path of shared/routes.ts. No fragment: the router opens a page at its top, and follows a fragment
//          only inside the page already shown (web/src/app/router.ts navigate).
//
// A row is listed only while something is typed, in the Views group, and is left out when it would repeat a page
// already listed for the same text (the same path and label): web/src/app/palette-match.ts wordRows.

export interface SearchWord {
  /** Stable id: the row's option in the search box is `w:<id>`. */
  id: string;
  /** What a reader types for it, lower case. Never rendered. */
  words: readonly string[];
  /** The site's own name for it, as the destination prints it. */
  label: string;
  /** Where that is, in a few words. */
  where: string;
  /** The route that shows it. */
  path: string;
  /** The page shows it only as it is now, not on a rewound page: the row is left out while the site is rewound. */
  liveOnly?: true;
}

/** What a row that names a whole page says for `where`. */
const PAGE = 'On its own page';

export const SEARCH_WORDS: readonly SearchWord[] = [
  { id: 'price', words: ['price', 'nam price', 'usd', 'dollar', 'worth', 'cost', 'how much'], label: 'NAM price, as the pools quote it', where: 'On Trade', path: '/trade' },
  { id: 'volume', words: ['volume', 'trading volume', 'traded', 'turnover'], label: 'Traded, 24 h', where: 'On Trade', path: '/trade' },
  // what other sites call market cap: the site's own phrase says what it counts (shared/copy.ts VALUE_WORDS)
  { id: 'all-nam', words: ['market cap', 'marketcap', 'mcap', 'market capitalization', 'market capitalisation', 'fdv', 'fully diluted', 'valuation'], label: 'All NAM at today’s price', where: 'On Trade', path: '/trade' },
  // current figures: the Supply page leaves the section out while rewound (web/src/screens/supply/index.tsx)
  { id: 'new-nam', words: ['total supply', 'max supply', 'inflation', 'issuance', 'emission', 'emissions', 'minted', 'new nam', 'tokenomics'], label: 'NAM since genesis', where: 'On Supply', path: '/supply', liveOnly: true },
  { id: 'pool-depth', words: ['liquidity', 'tvl', 'pool depth', 'pool size', 'reserves'], label: 'Pool depth', where: 'On Trade', path: '/trade' },
  { id: 'price-move', words: ['slippage', 'price impact', 'impact', 'order size', 'quote', 'swap'], label: 'Price move', where: 'On Trade', path: '/trade' },
  { id: 'book', words: ['order book', 'orderbook', 'bids', 'asks', 'limit orders'], label: 'The book', where: 'On Depth', path: '/depth' },
  { id: 'staking-rate', words: ['apr', 'apy', 'yield', 'rewards', 'staking rewards', 'interest', 'earn'], label: 'Staking rate a year, before commission', where: 'On Staking', path: '/staking' },
  { id: 'validators', words: ['validator', 'operators', 'node operators', 'commission', 'delegate', 'delegation', 'voting power'], label: 'Validators', where: PAGE, path: '/validators' },
  { id: 'holders', words: ['whales', 'rich list', 'richlist', 'top holders', 'largest holders', 'biggest holders', 'distribution', 'wallets'], label: 'Holders', where: PAGE, path: '/holders' },
  { id: 'bridges', words: ['ibc', 'bridge', 'channels', 'cross-chain', 'cross chain', 'other chains'], label: 'Bridges', where: PAGE, path: '/bridges' },
  { id: 'unstaking', words: ['unbonding', 'unbond', 'unlock', 'unlocks', 'unlock schedule', 'unstaking', 'unstake', 'restake'], label: 'Unstaking and restaking', where: 'On Supply', path: '/supply' },
  { id: 'shielded', words: ['masp', 'shielded pool', 'shielded nam', 'private', 'privacy', 'hidden'], label: 'Shielded', where: PAGE, path: '/shielded' },
  { id: 'votes', words: ['governance', 'proposal', 'proposals', 'voting', 'pgf', 'public funding', 'public goods'], label: 'Votes', where: PAGE, path: '/governance' },
  { id: 'api', words: ['api', 'json', 'developer', 'developers', 'docs', 'documentation', 'openapi', 'endpoints'], label: 'API', where: PAGE, path: '/developers' },
  { id: 'download', words: ['csv', 'download', 'export', 'spreadsheet', 'excel'], label: 'Download page data', where: 'On Activity', path: '/activity' },
  { id: 'status', words: ['uptime', 'health', 'sources', 'data sources', 'cross-check', 'cross-checks', 'accuracy', 'outdated'], label: 'Status', where: PAGE, path: '/status' },
  { id: 'alerts', words: ['alert', 'notification', 'notifications', 'notify', 'discord'], label: 'Alerts', where: PAGE, path: '/alerts' },
];
