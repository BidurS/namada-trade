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
