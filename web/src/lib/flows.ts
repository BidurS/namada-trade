// The flow-list rules of GET /api/flows (worker/src/flows-query.ts) for rows the server did not filter:
// streamed rows (the live feed merges them on top of a filtered page) and, through lib/compat.ts, pages
// from a server that predates W1.
import type { Flow } from '../../../shared/types';
import { hourEndingWords, isBotFlow, isIbcRefund, isOtherCoin, onePerCrossing, priceHowOf, type PriceHow } from '../../../shared/flow-rules';
import { tagKindOf, type TagKind } from './kinds';
import { fmtDayMonth } from './format';

export interface FlowRules {
  /** at least this many NAM; flows of other coins never count */
  minNam?: number;
  /** false: bot round trips removed */
  arb?: boolean;
  /** 'one': each bridge crossing once */
  pairs?: 'one';
}


/**
 * A bot round trip (the Osmosis parser marks them with meta.arb), or an unclassified flow that is not a bridge
 * timeout refund. The same rule as the server's ?arb=false (shared/flow-rules.ts).
 */
export const isBot = (f: Flow) => isBotFlow(f);
/** A flow whose amount is another coin (shielded USDC, OSMO…): it carries meta.tokenSymbol. */
export const otherCoin = (f: Flow) => isOtherCoin(f);

/**
 * True when a page contains a row the asked-for filter would have removed: the server predates W1. For
 * ?pairs=one that is a crossing's receiving record next to its sending record on the same page (a pair
 * split across a page boundary cannot be seen; a current server never sends either).
 */
export function serverIgnoredFlowFilter(rows: Flow[], q: FlowRules): boolean {
  if (q.minNam != null && q.minNam > 0 && rows.some((f) => f.amount < q.minNam! || otherCoin(f))) return true;
  if (q.arb === false && rows.some(isBot)) return true;
  if (q.pairs === 'one' && applyFlowRules(rows, { pairs: 'one' }).length < rows.length) return true;
  return false;
}

/**
 * The server's rules over a list: at least `minNam` NAM and no other coin, no bot round trips, a bridge crossing
 * once (the receiving record is dropped when the sending record of the same transfer is in the list: same
 * addresses and amount, within 15 minutes). Order is kept.
 */
export function applyFlowRules(rows: Flow[], q: FlowRules): Flow[] {
  let out = rows;
  if (q.minNam != null && q.minNam > 0) out = out.filter((f) => Number.isFinite(f.amount) && f.amount >= q.minNam! && !otherCoin(f));
  if (q.arb === false) out = out.filter((f) => !isBot(f));
  // the same rule as the server's ?pairs=one and the Address sheet (shared/flow-rules.ts)
  if (q.pairs === 'one') out = onePerCrossing(out);
  return out;
}

/** Newest first, de-duplicated by id (a streamed row and the same row in a fetched page). */
export function mergeFlows(...lists: Flow[][]): Flow[] {
  const byId = new Map<string, Flow>();
  for (const list of lists) for (const f of list) if (f && !byId.has(f.id)) byId.set(f.id, f);
  return [...byId.values()].sort((a, b) => b.ts - a.ts || b.height - a.height);
}

// ---------------------------------------------------------------- words for a row (the transaction list, its CSV)

const meta = (f: Flow) => (f.meta ?? {}) as Record<string, unknown>;

export const chainWord = (c: string) => (c === 'osmosis' ? 'Osmosis' : 'Namada');
/**
 * The tag a row shows: a bridge timeout refund is "Bridge refund"; a bot round trip is "Bot trade" whatever its
 * kind; a bridge record says where the NAM went.
 */
export const tagOf = (f: Flow): TagKind => (isIbcRefund(f) ? 'bridgeRefund' : isBot(f) ? 'bot' : tagKindOf(f.kind, f.chain));
/** The other coin of a trade in words ("USDC"; a raw denom is "another coin"). */
export const coinWord = (d: string | null | undefined) => (!d ? null : d.startsWith('ibc/') ? 'another coin' : d);

export type { PriceHow };
/** How the move's dollar price was set: from meta.priceSource, or a USDC trade's own price (shared/flow-rules.ts, as the CSV says it). */
export const priceHow = (f: Flow): PriceHow => priceHowOf(f);
export const PRICE_SHORT: Record<PriceHow, string> = {
  execution: "trade's own price",
  swap_1h: 'hourly median price',
  spot: 'quote at the time',
  pool_1h: "pool's hourly close",
  unstated: 'price basis not stated',
  none: 'no price',
};
/** The short words for a price's basis; a pool close says its hour ("pool's hourly close, hour ending 19:00 UTC"). */
export const priceShort = (how: PriceHow, at: number | null | undefined): string =>
  how === 'pool_1h' && at != null ? `${PRICE_SHORT.pool_1h}, ${hourEndingWords(at)}` : PRICE_SHORT[how];
/** The time was estimated from nearby blocks (older Osmosis rows). */
export const timeEstimated = (f: Flow) => meta(f).tsSource === 'interpolated' || meta(f).tsSource === 'extrapolated';

const p2 = (n: number) => String(n).padStart(2, '0');
/** "17 Oct 10:00" (a column head says UTC once). */
export const dayHm = (ts: number) => {
  const d = new Date(ts);
  return `${fmtDayMonth(ts)} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
};
