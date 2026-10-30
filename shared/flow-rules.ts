// Rules about flows and links that the Worker and the web app must apply the same way (one definition,
// so a list the server filters and a list the client filters never disagree).
import type { Flow } from './types';

type FlowLike = Pick<Flow, 'kind'> & { meta?: Record<string, unknown> | null };
type CrossingLike = Pick<Flow, 'kind' | 'chain' | 'from' | 'to' | 'amount' | 'ts'> & { meta?: Record<string, unknown> | null };

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

/** The packet sequence a bridge record carries (both chains' records of one crossing carry the same one), or null. */
const sequenceOf = (f: CrossingLike): string | null => {
  const s = f.meta?.packetSequence;
  return typeof s === 'string' || typeof s === 'number' ? String(s) : null;
};

/**
 * Each bridge crossing once. A crossing is recorded on both chains: sent (ibc_out) on one, received (ibc_in) on the
 * other. The receiving record is left out when the sending record of the same transfer is in the list: another
 * chain, the same receiver and amount, within 15 minutes, and either the same sender or the same packet sequence (a
 * withdrawal from the shielded pool is sent by the pool on Namada while the packet, and so Osmosis's record, names
 * the refund address). Order is kept. The server's ?pairs=one (worker/src/flows-query.ts RECEIVED_TWIN) is the same
 * rule over the whole table.
 */
export function onePerCrossing<T extends CrossingLike>(rows: readonly T[]): T[] {
  const sent = rows.filter((f) => f.kind === 'ibc_out');
  return rows.filter(
    (f) =>
      !(
        f.kind === 'ibc_in' &&
        sent.some((p) => p.chain !== f.chain && p.to === f.to && Math.abs(p.amount - f.amount) < 1e-6 && Math.abs(p.ts - f.ts) <= CROSSING_PAIR_MS
          && (p.from === f.from || (sequenceOf(p) !== null && sequenceOf(p) === sequenceOf(f))))
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
 * safe href: only http(s) URLs pass; `javascript:`, `data:`, `vbscript:` and anything unparsable give null, and so
 * does one whose written form does not parse again (Node writes a host such as "рф日本xn--.xyz" as "xn--xn---…" and
 * then refuses it; workerd takes it back): callers parse the answer again (the proposal card reads its host), and that
 * must not throw on any runtime.
 */
export function safeHttpUrl(x: unknown): string | null {
  if (typeof x !== 'string') return null;
  const s = x.trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return new URL(u.toString()).toString();
  } catch {
    return null;
  }
}

/**
 * Four numbers with dots between ("45.67.89.10", "0x2d.0x43.0x59.0x0a", "45.0x.89.10"), not after or before a letter or
 * a number. No i flag: under it a mark that case-folds to a letter (U+0345 to ι) would count as one.
 */
const FOUR_NUMBERS = /(?<![\p{L}\p{N}_]|\p{N}\.)(?:0[xX][0-9a-fA-F]*|\d+)(?:\.(?:0[xX][0-9a-fA-F]*|\d+)){3}(?![\p{L}\p{N}_]|\.[\p{L}\p{N}])/gu;
/**
 * Whether a word (text between spaces) holds a host written as four numbers, as a browser's address bar reads one:
 * the word in the form a host parser reads it (NFKC folds "４５．６７" and "㊺" to "45.67" and "45", the marks that show
 * nothing are taken out, and a blank Hangul filler is read both as the space it shows and as the nothing a host
 * parser makes of it), wherever the host starts ("IP:45.67.89.10/claim", "http:/45.67.89.10", "here...45.67.89.10"),
 * but not inside a longer number ("v1.2.3.4", the end of "1.2.3.4.5"), and only when the URL parser takes it as one
 * ("1.500.000.000" and "045.089.0.1" are none). A link X makes of none (twitter-text 3.1.0), but a reader can type it
 * into a browser, so a public post carries no word that holds one.
 */
export function holdsNumericHost(word: string): boolean {
  const folded = word.normalize('NFKC').replace(/[。｡]/g, '.');
  return [' ', ''].some((filler) => {
    const view = folded.replace(/[ᅟᅠㅤﾠ]/g, filler).replace(/[\p{Default_Ignorable_Code_Point}\p{Cf}]/gu, '');
    for (const m of view.matchAll(FOUR_NUMBERS)) {
      try {
        if (/^\d+\.\d+\.\d+\.\d+$/.test(new URL(`http://${m[0]}/`).hostname)) return true;
      } catch { /* not a host */ }
    }
    return false;
  });
}

// ---------------------------------------------------------------- how a move's price was set

/**
 * How a move's dollar price was set, from meta.priceSource: 'execution', a trade's own USDC per NAM; 'swap_1h', the
 * median of that hour's trades; 'spot', the Osmosis quote stored for the move's minute; 'pool_1h', the pool's hourly
 * close (metric price.pool_1h from the Osmosis data API, the hour named by meta.priceAt), which
 * scripts/repair-pool-hour-prices.ts sets on a move recorded while no quote was stored; 'unstated', a price whose
 * basis the row does not say; 'none', no price.
 */
export type PriceHow = 'execution' | 'swap_1h' | 'spot' | 'pool_1h' | 'unstated' | 'none';
type PricedLike = Pick<Flow, 'kind' | 'amount' | 'priceUsd' | 'counterDenom' | 'counterAmount'> & { meta?: Record<string, unknown> | null };

/** How the move's dollar price was set: from meta.priceSource, or a USDC trade's own price. The moves list and its CSV use this one rule. */
export function priceHowOf(f: PricedLike): PriceHow {
  const s = f.meta?.priceSource;
  if (s === 'execution' || s === 'swap_1h' || s === 'spot' || s === 'pool_1h') return s;
  if (f.priceUsd == null) return 'none';
  // a USDC trade's own price is its USDC amount divided by its NAM amount
  if ((f.kind === 'buy' || f.kind === 'sell') && f.counterDenom === 'USDC' && f.counterAmount && f.amount > 0) {
    const own = f.counterAmount / f.amount;
    if (Math.abs(own - f.priceUsd) <= own * 1e-6) return 'execution';
  }
  return 'unstated';
}

/** The hour a pool-close price is the close of: meta.priceAt, the time of the stored price.pool_1h row it was read from; null otherwise. */
export function priceAtOf(f: { meta?: Record<string, unknown> | null }): number | null {
  if (f.meta?.priceSource !== 'pool_1h') return null;
  const at = f.meta.priceAt;
  return typeof at === 'number' && Number.isFinite(at) && at > 0 ? at : null;
}

const two = (n: number) => String(n).padStart(2, '0');
/** "18:00 UTC" */
export const hourUtcWords = (at: number): string => `${two(new Date(at).getUTCHours())}:${two(new Date(at).getUTCMinutes())} UTC`;
/**
 * "hour ending 19:00 UTC" for the price.pool_1h row stamped 18:00: the row holds the pool's price at the close of the
 * hour it is stamped with, so it is named by the hour's end, as the Trade page names a pool close.
 */
export const hourEndingWords = (at: number): string => `hour ending ${hourUtcWords(at + 3_600_000)}`;

/** "the pool’s close for the hour ending 19:00 UTC (Osmosis app data)": a pool-close price, named by its hour's end. */
export const poolHourWords = (at: number | null): string => `the pool’s close for the ${at != null ? `${hourEndingWords(at)} ` : 'hour '}(Osmosis app data)`;

/**
 * The NAM size of the route the Osmosis router quoted, for a move priced at a quote read as that route's spot (the
 * quote service's price list gave NAM no price: worker/src/price-how.ts). The live hub stamps it (meta.priceRoute)
 * beside meta.priceSource 'spot'; null for any other move.
 */
export function priceRouteOf(f: { meta?: Record<string, unknown> | null }): number | null {
  const r = f.meta?.priceRoute;
  return f.meta?.priceSource === 'spot' && typeof r === 'number' && Number.isFinite(r) && r > 0 ? r : null;
}

/**
 * How a move's price was set, in plain words, as the moves list says it after "Price: $0.000944 per NAM," and the CSV
 * export's price_basis column carries it. Empty for a move without a price. `route`: the route size of a quote read
 * as a route's spot (priceRouteOf).
 */
export function priceBasisWords(how: PriceHow, at: number | null, route: number | null = null): string {
  switch (how) {
    case 'execution': return 'from this trade itself';
    case 'swap_1h': return 'the median of that hour’s trades';
    case 'spot': return route != null ? `the Osmosis route quote for selling ${route.toLocaleString('en-US')} NAM when the move was recorded` : 'the Osmosis quote when the move was recorded';
    case 'pool_1h': return `${poolHourWords(at)}, as no Osmosis quote was stored for that minute`;
    case 'unstated': return 'recorded with the move; how it was set is not stated';
    default: return '';
  }
}

/** The short words for a price's basis: the trades tape, the moves list and a Discord alert's figures. */
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

/**
 * A price's source as a Discord alert names it: `long` inside a sentence ("Worth $1,678 at $0.001119 a NAM, the Osmosis
 * quote for that minute"), `short` in a parenthesis or under a figure ("Osmosis quote"). The quote's words are the
 * ones the settle sentence uses ("the Osmosis OSMO quote for that minute", web/src/lib/settle.ts); a route's spot is
 * named as the site's price stamp names it ("Osmosis route quote, 1,000 NAM", web/src/lib/prov.ts plainSource); a pool
 * close and an hour's median are priceBasisWords'. Empty for a move without a price.
 */
export function priceSourceWords(how: PriceHow, at: number | null, route: number | null = null): { long: string; short: string } {
  switch (how) {
    case 'spot': return route != null
      ? { long: `the Osmosis route quote for that minute (the route for selling ${route.toLocaleString('en-US')} NAM)`, short: `Osmosis route quote, ${route.toLocaleString('en-US')} NAM` }
      : { long: 'the Osmosis quote for that minute', short: 'Osmosis quote' };
    case 'pool_1h': return { long: priceBasisWords('pool_1h', at), short: priceShort('pool_1h', at) };
    case 'swap_1h': return { long: priceBasisWords('swap_1h', at), short: PRICE_SHORT.swap_1h };
    case 'execution': return { long: 'the trade’s own price', short: PRICE_SHORT.execution };
    case 'unstated': return { long: 'the stored price for that minute (source not stated)', short: 'stored price, source not stated' };
    default: return { long: '', short: '' };
  }
}
