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
  /** The site's X account (owner, 2026-10-29), linked from the footer; it posts the site's own alerts (worker/src/sources/x.ts). */
  x: 'https://x.com/namadatrade',
  /** "Buy me a coffee": the maker's shielded payment address (owner, 2026-10-20). A shielded address does not
   *  reveal who owns it or what it holds; senders stay private when they pay from a shielded account. */
  donateShielded: 'znam13nhljeczcggkq4jqfn64mzdsp8d56wgt6t33ja5chzdfqjxnhghwrm2a6hs7tph5uffsj2rv379',
  /** "Buy me a coffee" in Zcash (owner, 2026-10-21): a mainnet unified address whose only receivers are Sapling and
   *  Orchard, both shielded, so a payment to it always lands shielded (test/donate-addresses.test.ts decodes it). */
  donateZcash: 'u1xpk2qkpfdu48myyvpm3rfqujkz94xfn0tsuwt3ql6mddutsvh92mt7g5h752xce7meeywx9gqad8m9g97ygz3x5jertlkj8kycv74wvh90v85ecxycakh24ggk077w8pzkg3xtw32nawyu00ns4ckeva7537f9f9navw5uhus5c5kxkd',
  /**
   * The site's Telegram bot (worker/src/telegram-bot.ts), which sends each subscriber's alerts to their own chat or
   * group, and the public channel of the site's own alerts, without its @ (null until the owner makes it; the Worker's
   * TELEGRAM_CHANNEL names the same channel for sending).
   */
  telegram: { bot: 'NamadaTrade_bot', channel: null as string | null },
  disclaimer: 'NamadaTrade reports public on-chain and exchange data. It is not investment advice and is not affiliated with Namada or the Anoma Foundation.',
  /**
   * What the site never does, said where people who borrow its name are met (plan Stage 1, identity basics): the
   * footer's line beside its link to the official links, and the second paragraph of the questions page's
   * "Which links are NamadaTrade's own?". Must stay true: the bot writes only to chats that linked themselves
   * (worker/src/telegram-bot.ts), and the only signature asked for is the sign-in, which moves nothing.
   */
  neverAsks: 'NamadaTrade never sends a direct message first, never asks for a seed phrase and has no support staff.',
  /** Footer, first sentence; the view appends how current the flow records are. */
  provenance: 'Every number shows its source and age.',
  /** The data sources, in the words the footer uses. */
  dataSources: 'Osmosis router, Namada nodes, indexer.namada.net',
  /** Settings privacy section and footer (owner decision 5). Must stay true: gate G10 N9. */
  privacy: 'This site loads no analytics or advertising scripts, and its fonts are served from this site. Cloudflare, which hosts it, sees standard request data such as IP addresses.',
  /** Trade ticket and Home mini-ticket. */
  quoteNotOrder: 'An Osmosis quote, not an order. This site never trades for you.',
  /**
   * Ownership tokens of the search engines' webmaster tools (public by design: they sit in every page's <head>
   * and in the two files worker/src/hosts.ts answers). Removing one unverifies the site.
   */
  verify: {
    /** Google Search Console: the meta tag's content, and the HTML file's name. */
    google: 'y8MMHleNrKmUJyxHkUw0Dan_z39wLvq4SD_G2FmiEJo',
    googleFile: 'google759de8fb39112be6.html',
    /** Bing Webmaster Tools: msvalidate.01, and the <user> of /BingSiteAuth.xml. */
    bing: '241A8F4305CDCFD2D9EAEA30B9EF8E3F',
  },
} as const;
