// The four checks of the depth module (checks table rows), in a module of their own so the UI's provenance vocabulary
// (web/src/lib/prov.ts, in the initial bundle) can take the titles without the depth page's words: shared/depth.ts
// re-exports them, and the Worker reads them from there.

/** The titles of the four checks on the Status page (checks table rows). */
export const DEPTH_CHECK_TITLES = {
  depth_vs_chain_estimate: 'Depth vs the chain’s own swap estimate (the reference pool, the smallest size)',
  depth_vs_route_quote: 'Depth vs the quote service’s direct quote in the reference pool',
  depth_vs_executed: 'Depth vs the trades that settled (walked on the minute before each)',
  depth_budget: 'Depth store within its caps (rows this month, database size, archive puts)',
} as const;
export type DepthCheckKey = keyof typeof DEPTH_CHECK_TITLES;
