// Rules about flows and links that the Worker and the web app must apply the same way (one definition,
// so a list the server filters and a list the client filters never disagree).
import type { Flow } from './types';

type FlowLike = Pick<Flow, 'kind'> & { meta?: Record<string, unknown> | null };
type CrossingLike = Pick<Flow, 'kind' | 'chain' | 'from' | 'to' | 'amount' | 'ts'>;

/** A flow whose amount is another coin than NAM (shielded USDC, OSMO…): it carries `meta.tokenSymbol`. */
/**
 * The hash a public explorer files this move under. namada.valopers.com indexes Namada transactions by the wrapper
 * (outer) hash. Rows imported from the Namada indexer keep the inner hash in tx_hash and the wrapper in
 * meta.wrapper, so their links used the inner hash and opened "404 Page not Found" (owner, 2026-10-18). Rows from
 * this site's block reader already store the wrapper hash. Osmosis hashes are used as they are.
 */
export const explorerHashOf = (f: { txHash: string; meta?: Record<string, unknown> | null }): string => {
  const w = f.meta?.wrapper;
  return typeof w === 'string' && /^[0-9a-fA-F]{64}$/.test(w) ? w.toUpperCase() : f.txHash;
};

export const isOtherCoin = (f: { meta?: Record<string, unknown> | null }): boolean => !!f.meta?.tokenSymbol;

/** A crossing's two records (sent on one chain, received on the other) are at most this far apart. */
export const CROSSING_PAIR_MS = 15 * 60_000;

/**
 * Each bridge crossing once. A crossing is recorded on both chains: sent (ibc_out) on one, received (ibc_in) on the
 * other. The receiving record is left out when the sending record of the same transfer is in the list: another
 * chain, the same addresses and amount, within 15 minutes. Order is kept. The server's ?pairs=one
 * (worker/src/flows-query.ts RECEIVED_TWIN) is the same rule over the whole table.
 */
export function onePerCrossing<T extends CrossingLike>(rows: readonly T[]): T[] {
  const sent = rows.filter((f) => f.kind === 'ibc_out');
  return rows.filter(
    (f) =>
      !(
        f.kind === 'ibc_in' &&
        sent.some((p) => p.chain !== f.chain && p.from === f.from && p.to === f.to && Math.abs(p.amount - f.amount) < 1e-6 && Math.abs(p.ts - f.ts) <= CROSSING_PAIR_MS)
      ),
  );
}

/** One other address an address moves NAM with: NAM in and out over the moves given, and how many moves. */
export interface CounterpartyTotals {
  address: string;
  label: string | null;
  label_plain: string | null;
  /** where the label came from ('user' for a wallet's own tag) and, for a tag, the start of its author's address */
  label_source: string | null;
  label_author: string | null;
  inNam: number;
  outNam: number;
  count: number;
}

/**
 * Who `address` moves NAM with, over `moves`: NAM only (other coins are left out) and each bridge crossing once,
 * so the totals agree with the moves listed beside them. Biggest total first. The Address sheet and
 * GET /api/address/:addr use this one definition.
 */
export function counterpartiesOf(moves: readonly Flow[], address: string): CounterpartyTotals[] {
  const m = new Map<string, CounterpartyTotals>();
  for (const f of onePerCrossing(moves.filter((x) => !isOtherCoin(x) && Number.isFinite(x.amount)))) {
    const out = f.from === address;
    const cp = out ? f.to : f.from;
    if (!cp || cp === address) continue;
    const cur = m.get(cp) ?? {
      address: cp,
      label: (out ? f.toLabel : f.fromLabel) ?? null,
      label_plain: (out ? f.toLabelPlain : f.fromLabelPlain) ?? null,
      label_source: (out ? f.toLabelSource : f.fromLabelSource) ?? null,
      label_author: (out ? f.toLabelAuthor : f.fromLabelAuthor) ?? null,
      inNam: 0, outNam: 0, count: 0,
    };
    if (out) cur.outNam += f.amount;
    else cur.inNam += f.amount;
    cur.count += 1;
    m.set(cp, cur);
  }
  return [...m.values()].sort((a, b) => b.inNam + b.outNam - (a.inNam + a.outNam));
}

/**
 * A refund of an Osmosis → Namada transfer whose packet timed out: the bridge returned the NAM to the sender on
 * Osmosis. Stored as kind 'other' with `meta.ibcTimeoutRefund` (worker/src/parse/osmosis.ts). Not a trade, and
 * the NAM never left Osmosis, so the matching send is not counted as bridged out.
 */
export const isIbcRefund = (f: FlowLike): boolean => f.kind === 'other' && f.meta?.ibcTimeoutRefund === true;

/**
 * A bot round trip: a swap the Osmosis parser marked `meta.arb` (bought and sold NAM in one transaction), or any
 * other kind 'other' row that is not a bridge refund. The server's `?arb=false` (worker/src/flows-query.ts
 * NOT_BOT) applies exactly this rule.
 */
export const isBotFlow = (f: FlowLike): boolean => f.meta?.arb === true || (f.kind === 'other' && !isIbcRefund(f));

/**
 * A link taken from on-chain or third-party text (a governance proposal's `discussions-to`, a forum URL) as a
 * safe href: only http(s) URLs pass; `javascript:`, `data:`, `vbscript:` and anything unparsable give null.
 */
export function safeHttpUrl(x: unknown): string | null {
  if (typeof x !== 'string') return null;
  const s = x.trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}
