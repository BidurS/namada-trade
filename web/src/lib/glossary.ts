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
  // Settings, "Where alerts go"
  {
    id: 'channel-link',
    plain: 'Discord channel link',
    expert: 'Discord calls it a webhook URL',
    text: 'In Discord, open the channel’s settings, then Integrations, then Webhooks. Make a new one and copy its URL. Anyone with the link can post to the channel, so it is stored encrypted and never shown again.',
  },
];

export const GLOSSARY_BY_ID: Record<string, GlossaryEntry> = Object.fromEntries(GLOSSARY.map((g) => [g.id, g]));

export const glossaryEntry = (id: string): GlossaryEntry | undefined => GLOSSARY_BY_ID[id];
