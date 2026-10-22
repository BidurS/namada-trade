// Site-wide words (the rules at the top of shared/copy.ts apply). Kept apart from the page text in
// copy.ts so the shell's first chunk (routes, titles, footer) does not carry every page's paragraphs.
export const SITE = {
  name: 'NamadaTrade',
  origin: 'https://namada.trade',
  /** Home H1 (system.md section 10). */
  tagline: 'What moved, who moved it, and what it costs to trade NAM.',
  /** Home meta description and the description in structured data. */
  description: 'NAM price, who holds it, how much is staked, shielded or on Osmosis, and what a trade costs. Every number shows its source and age.',
  /** Home hero sub-line (system.md section 10). */
  sub: 'NAM is the coin of the Namada network. Price, holders, who might sell, how much is shielded. Every number shows its source and age.',
  /** One sentence on every route (footer and the server-rendered page). */
  /** The public repository (owner decision 4, published 2026-10-20, MIT licence). */
  repo: 'https://github.com/BidurS/namada-trade',
  /** "Buy me a coffee": the maker's shielded payment address (owner, 2026-10-20). A shielded address does not
   *  reveal who owns it or what it holds; senders stay private when they pay from a shielded account. */
  donateShielded: 'znam13nhljeczcggkq4jqfn64mzdsp8d56wgt6t33ja5chzdfqjxnhghwrm2a6hs7tph5uffsj2rv379',
  /** "Buy me a coffee" in Zcash (owner, 2026-10-21): a mainnet unified address whose only receivers are Sapling and
   *  Orchard, both shielded, so a payment to it always lands shielded (test/donate-addresses.test.ts decodes it). */
  donateZcash: 'u1xpk2qkpfdu48myyvpm3rfqujkz94xfn0tsuwt3ql6mddutsvh92mt7g5h752xce7meeywx9gqad8m9g97ygz3x5jertlkj8kycv74wvh90v85ecxycakh24ggk077w8pzkg3xtw32nawyu00ns4ckeva7537f9f9navw5uhus5c5kxkd',
  disclaimer: 'NamadaTrade reports public on-chain and exchange data. It is not investment advice and is not affiliated with Namada or the Anoma Foundation.',
  /** Footer, first sentence; the view appends how current the flow records are. */
  provenance: 'Every number shows its source and age.',
  /** The data sources, in the words the footer uses. */
  dataSources: 'Osmosis router, Namada nodes, indexer.namada.net',
  /** Settings privacy section and footer (owner decision 5). Must stay true: gate G10 N9. */
  privacy: 'This site loads no analytics or advertising scripts, and its fonts are served from this site. Cloudflare, which hosts it, sees standard request data such as IP addresses.',
  /** Trade ticket and Home mini-ticket. */
  quoteNotOrder: 'An Osmosis quote, not an order. This site never trades for you.',
} as const;
