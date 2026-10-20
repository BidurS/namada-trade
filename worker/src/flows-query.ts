// The WHERE clause of GET /api/flows, as a pure function so its conditions can be tested (W1).
//
//   ?chain=osmosis|namada   ?kind=<FlowKind>|dex|ibc|native   ?whale=true (≥ 10,000 NAM)
//   ?minNam=<n>             at least n NAM; flows of other coins (shielded USDC, OSMO…) never count as NAM
//   ?arb=false              bot trades removed (shared/flow-rules.ts isBotFlow: round trips the Osmosis parser marks
//                           with meta.arb, and any kind 'other' row that is not a bridge refund)
//   ?search=<text>          address or transaction hash contains the text
//   ?pairs=one              each bridge crossing once: a crossing is recorded on both chains (sent on one, received
//                           on the other); the receiving chain's record is left out when the sending chain's record
//                           of the same transfer (same addresses and amount, within 15 minutes) is present
//   ?at=<ms>                nothing newer than this time (rewind)
// Newest first; `limit` stays clamped to 10…100 by the route.

export interface FlowsFilter {
  asOf: number;
  chain?: string | null;
  kind?: string | null;
  whale?: boolean;
  minNam?: number | null;
  excludeBots?: boolean;
  search?: string | null;
  onePerCrossing?: boolean;
}

/** Read the filter from query parameters (unknown or malformed values are ignored, never guessed). */
export function flowsFilterFromQuery(q: (k: string) => string | undefined, asOf: number): FlowsFilter {
  const min = Number(q('minNam'));
  return {
    asOf,
    chain: q('chain') || null,
    kind: q('kind') || null,
    whale: q('whale') === 'true',
    minNam: Number.isFinite(min) && min > 0 ? min : null,
    excludeBots: q('arb') === 'false',
    search: q('search') || null,
    onePerCrossing: q('pairs') === 'one',
  };
}

/** The receiving side of a crossing whose sending side is also recorded (see ?pairs=one). */
export const RECEIVED_TWIN = `(f.kind = 'ibc_in' AND EXISTS (SELECT 1 FROM flows p WHERE p.kind = 'ibc_out' AND p.chain != f.chain
  AND p.from_addr = f.from_addr AND p.to_addr = f.to_addr AND p.amount_num = f.amount_num AND p.ts BETWEEN f.ts - 900000 AND f.ts + 900000))`;

/** Not a bot trade, the same rule as shared/flow-rules.ts isBotFlow (bridge refunds are kind 'other' and stay). */
export const NOT_BOT = `((f.meta IS NULL OR f.meta NOT LIKE '%"arb":true%') AND (f.kind != 'other' OR f.meta LIKE '%"ibcTimeoutRefund":true%'))`;

/**
 * Not the older twin of a Namada transfer: an earlier parser build wrote some transfers under their inner hash
 * (id namada:<inner>:<i>, no meta.innerTxHash); the current one writes them under the wrapper hash with
 * meta.innerTxHash = <inner>. Where both exist the older row is left out. Migration 0004 deletes such rows and
 * a unique index stops new ones; this condition keeps the figures right before that runs. Backfilled rows
 * (meta.source) and current rows are never older twins, so the lookup runs only for the few rows left.
 */
export const NOT_LEGACY_TWIN = `NOT (f.chain = 'namada' AND (f.meta IS NULL OR (f.meta NOT LIKE '%"innerTxHash"%' AND f.meta NOT LIKE '%"source":%'))
  AND EXISTS (SELECT 1 FROM flows w WHERE w.ts BETWEEN f.ts - 60000 AND f.ts + 60000 AND w.chain = 'namada' AND w.height = f.height
              AND w.id != f.id AND json_extract(w.meta, '$.innerTxHash') = f.tx_hash))`;
/** A flow whose amount is another coin (shielding USDC, OSMO…) carries meta.tokenSymbol; NAM flows do not. */
export const NAM_AMOUNT = `(f.meta IS NULL OR f.meta NOT LIKE '%"tokenSymbol":%')`;

export function flowsWhere(f: FlowsFilter): { where: string; params: unknown[] } {
  const conditions: string[] = ['f.ts <= ?', NOT_LEGACY_TWIN];
  const params: unknown[] = [f.asOf];
  if (f.chain && f.chain !== 'all') { conditions.push('f.chain = ?'); params.push(f.chain); }
  if (f.kind && f.kind !== 'all') {
    if (f.kind === 'dex') conditions.push("f.kind IN ('buy','sell','lp_add','lp_remove')");
    else if (f.kind === 'ibc') conditions.push("f.kind IN ('ibc_in','ibc_out')");
    else if (f.kind === 'native') conditions.push("f.kind IN ('bond','withdraw','shield','unshield','rewards','pos_balance')");
    else { conditions.push('f.kind = ?'); params.push(f.kind); }
  }
  if (f.whale) conditions.push('f.amount_num >= 10000');
  if (f.minNam != null && f.minNam > 0) { conditions.push('f.amount_num >= ?', NAM_AMOUNT); params.push(f.minNam); }
  if (f.excludeBots) conditions.push(NOT_BOT);
  if (f.onePerCrossing) conditions.push(`NOT ${RECEIVED_TWIN}`);
  if (f.search) { conditions.push('(f.from_addr LIKE ? OR f.to_addr LIKE ? OR f.tx_hash LIKE ?)'); params.push(`%${f.search}%`, `%${f.search}%`, `%${f.search}%`); }
  return { where: `WHERE ${conditions.join(' AND ')}`, params };
}

/** Newest first; ties broken by block height so a page never reorders. */
export const FLOWS_ORDER = 'ORDER BY f.ts DESC, f.height DESC, f.id DESC';
