// Activity (S5): words that are data, not copy. Kept in a .ts module, out of the TSX the copy lint reads.
//
// TECH: technical source names. They appear only in a provenance sheet, under "How it is computed"
// (the allowlisted place for operator words); the stamp itself shows the plain word (lib/prov.ts).
export const TECH = {
  namadaBalances: 'Namada RPC (balance reads)',
  namadaStakes: 'Namada RPC (stake reads)',
  osmosisBalances: 'Osmosis chain (bank balances)',
  stakeEstimate: 'bond/unbond history (estimate)',
  holderIndex: 'NamadaTrade holder index',
} as const;

/**
 * Sentences with counts or sizes in them (the N2 lint keeps typed figures out of TSX; these are definitions, not
 * figures): the hint under each list's search field, and the holders search's empty state.
 */
export const SEARCH_HINT = {
  holders: 'Addresses by their start or end, names, groups such as foundation, and sizes such as >1m',
  moves: 'Addresses by their start, records, blocks, and words such as sell >100k last 7 days',
} as const;
export const SEARCH_PLACEHOLDER = {
  holders: 'tnam1…, …kj4m, a name, >1m',
  moves: 'tnam1…, a record, sell >100k 7d',
} as const;
export const HOLDER_SEARCH_EMPTY = 'The search looks at the start and the end of addresses and at names. Try the first ten characters of the address, its last four, or a name.';
