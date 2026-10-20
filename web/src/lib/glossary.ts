// Glossary: plain word first, the expert term on tap (brief section 4 plus the six additions
// in system.md 8, "Glossary term"). This file is on the copy-lint allowlist: the expert rows
// may name MASP, IBC, SQS and similar terms; nothing else on the page may.
//
// No figures here (N2): where a definition depends on a chain value (the unstaking wait), the
// screen prints the figure with its own stamp next to the term.

export interface GlossaryEntry {
  /** Stable id (used by <Term id>, the palette's Glossary group and tag popovers). */
  id: string;
  /** The plain word shown on the page. */
  plain: string;
  /** The precise or expert term, shown under the plain word in the popover. */
  expert: string;
  /** One sentence in plain words. */
  text: string;
}

export const GLOSSARY: GlossaryEntry[] = [
  { id: 'staked', plain: 'Staked', expert: 'Bonded', text: 'Locked with a validator. Staked NAM cannot be sold.' },
  { id: 'unstaking', plain: 'Unstaking', expert: 'Unbonding', text: 'The wait, set by the chain, before staked NAM can be spent.' },
  { id: 'unlocked', plain: 'Unlocked', expert: 'Withdrawn, liquid', text: 'Finished unstaking. It can now be bridged and sold.' },
  { id: 'staking-account', plain: 'Staking account balance', expert: 'Internal transfer', text: "The staking account's balance holds staked NAM, NAM on its way out and unclaimed rewards; normally only the chain's own staking logic moves it." },
  { id: 'shielded-set', plain: 'Shielded set', expert: 'MASP, the Multi-Asset Shielded Pool', text: 'The total inside is public; who owns it is not.' },
  { id: 'bridged', plain: 'Bridged', expert: 'IBC transfer', text: 'Moved between Namada and Osmosis. NAM has to cross before it can be sold.' },
  { id: 'ready-to-sell', plain: 'Ready to sell', expert: 'Inventory on deck', text: 'NAM that crossed to Osmosis and has not been sold or sent back.' },
  { id: 'pool', plain: 'Pool', expert: 'Liquidity pool', text: 'A shared pot of NAM and another coin that anyone can trade against.' },
  { id: 'price-move', plain: 'Price move', expert: 'Price impact', text: 'How far your own order pushes the price.' },
  { id: 'quoted-price', plain: 'Quoted price', expert: 'SQS mid price', text: 'What the exchange shows before any order is placed.' },
  { id: 'last-trade-price', plain: 'Last trade price', expert: 'Executed price', text: 'What real trades actually paid.' },
  { id: 'bot-trade', plain: 'Bot trade', expert: 'Arbitrage', text: 'Round trips made for a tiny profit. They are left out of buyer and seller counts.' },
  { id: 'rewind', plain: 'Rewind', expert: 'Replay, the ?at= time', text: 'Every number as it was at a past moment.' },
  { id: 'data-states', plain: 'Fresh, old, no data, sources disagree', expert: 'Provenance status', text: 'How far to trust a number right now.' },
  { id: 'holder', plain: 'Holder', expert: 'Address with a balance', text: 'An address holding spendable or staked NAM. Protocol accounts are left out.' },
  // the six added by the design system
  { id: 'size-table', plain: 'Size table', expert: 'Quote ladder', text: 'Six order sizes the Osmosis router quotes at the same moment.' },
  { id: 'cross-check', plain: 'Cross-check', expert: 'Integrity check', text: 'Two sources compared. It passes or needs a look.' },
  { id: 'latest-moves', plain: 'Latest moves', expert: 'Large flows, newest first', text: 'The newest single moves of 1,000 NAM or more.' },
  { id: 'estimate', plain: 'Estimate', expert: 'Linear interpolation', text: 'A straight line between two real quotes.' },
  { id: 'thin-market', plain: 'Thin market', expert: 'Low liquidity', text: 'Pools so small that your own order moves the price.' },
  // the Trade charts: what was bought and sold (OrderflowChart) and the size table's slices (OrderSizeCurve)
  { id: 'net-bought', plain: 'Bought minus sold', expert: 'Cumulative volume delta (CVD)', text: 'NAM bought minus NAM sold on Osmosis, added up from the start of the window. Bot trades are left out.' },
  { id: 'average-price', plain: 'Average price', expert: 'Volume-weighted average price (VWAP)', text: 'The price paid across every swap in a span, weighted by the size of each swap.' },
  { id: 'slice', plain: 'Slice', expert: 'Marginal order, the incremental tier', text: 'The NAM between one listed size and the next. Its price move is what that extra NAM costs on its own, not the whole order.' },
  { id: 'jump', plain: 'Jump', expert: 'Concentrated-liquidity tick boundary', text: 'A listed size above which each extra NAM sold gets a much lower price, because the pools hold less at that price.' },
  // Settings, "Where alerts go"
  {
    id: 'channel-link',
    plain: 'Discord channel link',
    expert: 'Discord calls it a webhook URL',
    text: 'In Discord, open the channel’s settings, then Integrations, then Webhooks. Make a new one and copy its URL. Anyone with the link can post to the channel, so it is stored encrypted and never shown again.',
  },
  // Shielded: a move out that matches a recent move in; the source words on the stamps
  { id: 'in-and-out-pair', plain: 'In-and-out pair', expert: 'Shielded-pool passthrough (turnstile)', text: 'A move out of the shielded set of the same amount, give or take half a percent, within 24 hours of a move in. A link by amount and time, not proof that the same owner made both.' },
  { id: 'flow-index', plain: 'Flow index', expert: 'This site\u2019s own database of indexed moves', text: 'The record of moves this site reads from Namada and Osmosis and stores itself. A stamp that says Flow index gives the time it last checked the chains.' },
  { id: 'derived', plain: 'Derived', expert: 'Computed from other stamped figures', text: 'A figure this site works out from other figures on the page, such as a share or a dollar value. Its sheet lists each input with its own source and age.' },
  // Supply: where NAM came from before it crossed, and the unstaking that ends each day
  { id: 'epoch', plain: 'Epoch', expert: 'Chain epoch', text: 'The chain\u2019s own clock step. The unstaking wait is counted in epochs; the page prints the measured length of one beside it, with its source.' },
  { id: 'unstaking-days', plain: 'Unstaking that ends each day', expert: 'Unbond maturity schedule (term structure, maturity wall)', text: 'NAM whose unstaking wait ends on each of the coming days. Once the wait ends, the NAM can be withdrawn and moved.' },
  { id: 'read-from-chain', plain: 'Read from the chain itself', expert: 'Consensus query (vp/pos/bonds_and_unbonds)', text: 'A figure taken straight from a Namada node\u2019s list of every bond and unstaking request, rather than from an indexer.' },
  { id: 'sold-before', plain: 'Sold or moved before', expert: 'Prior sell rate', text: 'The share of what an address unlocked earlier in the staking list that it sold on Osmosis or moved there soon after unlocking, from its own record. Addresses at or above the page\u2019s cut are counted here.' },
  { id: 'kept-staked', plain: 'Restaked or kept', expert: 'Sticky (restaked or held)', text: 'Addresses that unlocked NAM earlier and mostly staked it again, kept it or moved it into the shielded set, rather than selling it or moving it to Osmosis.' },
  { id: 'selling-estimate', plain: 'Selling estimate', expert: 'Dump hazard score (empirical Bayes)', text: 'An estimate of how much of what reaches an address it sells, made from its own sales on Osmosis in the window and the month before, and from whether its NAM likely came through a middle address. It describes past behaviour; it is not a forecast.' },
  { id: 'early-backers', plain: 'Early backers, team and genesis addresses', expert: 'Genesis allocation', text: 'Addresses whose tag says they were funded at the chain\u2019s start (the public sale, backers, contributors) or that they belong to the team or a foundation.' },
  { id: 'through-a-middle-address', plain: 'Through a middle address', expert: '2-hop attribution (relay or burner address)', text: 'The address that crossed had received the NAM from another Namada address within two days before. The page names that earlier address; matched by timing and amount, so a likely link, not a proven one.' },
  { id: 'other-public-addresses', plain: 'Other public addresses', expert: 'Transparent transfer', text: 'Crossed from a public Namada address that is not tagged as an early backer and did not come out of the shielded set or through a likely middle address.' },
];

export const GLOSSARY_BY_ID: Record<string, GlossaryEntry> = Object.fromEntries(GLOSSARY.map((g) => [g.id, g]));

export const glossaryEntry = (id: string): GlossaryEntry | undefined => GLOSSARY_BY_ID[id];
