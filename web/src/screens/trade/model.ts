// Trade screen model (S2): pure functions, no React. Every figure the ticket prints comes from one
// reading: the live quote for the asked amount, a real row of the size table, or a straight line
// between two real rows (labelled Estimate). Nothing here invents a number (N2): a missing input
// gives null and the reason, never a stand-in.
import type { Overview, PoolInfo, PriceQuote, Provenance, QuoteCurveResponse, SlippageCurvePoint } from '../../../../shared/types';
import type { Stamp } from '../../lib/prov';
import { fmtNamRule } from '../../lib/format';

export type Side = 'sell' | 'buy';

/** Quick picks for the amount (input choices, not figures). With the live quote down the size table's own sizes are used. */
export const PRESET_SIZES = [1000, 5000, 10000, 25000, 50000, 100000];
/** The amount the ticket opens with (an input default, not a figure). */
export const DEFAULT_SIZE = 5000;

/** Quote error codes from worker/src/sources/sqs.ts. `no_route` means the service answered. */
export type QuoteCode = 'busy' | 'unavailable' | 'no_route' | 'no_price';

export interface QuoteResult {
  key: string;
  amount: number;
  side: Side;
  quote: PriceQuote | null;
  /** Plain reason from the worker (never a URL). */
  error: string | null;
  code: QuoteCode | null;
  /** When the page asked (unix ms). */
  askedAt: number;
}

export const quoteKey = (side: Side, amount: number) => `${side}:${amount}`;

/** Did the quote service answer? null: not known yet. */
export function serviceAnswered(r: QuoteResult | null): boolean | null {
  if (!r) return null;
  if (r.quote) return true;
  return r.code === 'no_route';
}

/** What the ticket can show. */
export type TicketMode = 'loading' | 'live' | 'table' | 'down' | 'rewind';

export interface Reading {
  /** live: the quote for this amount; table: a real size-table row; estimate: between two rows; none: no figure. */
  kind: 'live' | 'table' | 'estimate' | 'none' | 'pending';
  side: Side;
  /** NAM asked. */
  n: number;
  /** USDC received (sell) or paid (buy). */
  value: number | null;
  /** NAM sold (sell) or received (buy, "about"). */
  nam: number | null;
  /** Average dollars per NAM. */
  avg: number | null;
  /** The quoted (mid) price the move is measured against. */
  spot: number | null;
  /** Signed price move in percent: negative selling, positive buying. */
  move: number | null;
  /** Dollar value of n NAM at the quoted price. */
  worth: number | null;
  /** The provenance of every figure above. */
  stamp: Stamp;
  /** Estimate: the two real sizes the line was drawn between. */
  a?: number;
  b?: number;
  /** none: why there is no figure (plain words). */
  reason?: string;
}

const fin = (x: number | null | undefined): x is number => x != null && Number.isFinite(x);
const mix = (a: number | null | undefined, b: number | null | undefined, t: number): number | null => (fin(a) && fin(b) ? a + (b - a) * t : null);
const ratio = (a: number | null | undefined, b: number | null | undefined): number | null => (fin(a) && fin(b) && b !== 0 ? a / b : null);

/** The size table's stamp, named in plain words. */
export const tableStamp = (c: QuoteCurveResponse | null): Stamp =>
  c ? { ...c.prov, plain: 'Size table' } : { source: 'size table', plain: 'Size table', at: null, status: 'missing', note: 'The size table has not answered yet.' };

/** Points with both sides quoted at a positive size, smallest first. */
export function tablePoints(c: QuoteCurveResponse | null): SlippageCurvePoint[] {
  if (!c) return [];
  return [...c.curve].filter((p) => fin(p.amountNam) && p.amountNam > 0).sort((a, b) => a.amountNam - b.amountNam);
}

/** The ticket reading from a live quote. */
export function fromQuote(q: PriceQuote): Reading {
  const stamp: Stamp = { ...q.prov, plain: 'Osmosis quote' };
  const spot = fin(q.spotPriceUsd) ? q.spotPriceUsd : null;
  const move = fin(q.priceImpactPct) ? (q.side === 'sell' ? -Math.abs(q.priceImpactPct) : Math.abs(q.priceImpactPct)) : null;
  return q.side === 'sell'
    ? { kind: 'live', side: 'sell', n: q.amountNam, value: q.outAmount, nam: q.amountNam, avg: q.effectivePriceUsd, spot, move, worth: spot != null ? q.amountNam * spot : null, stamp }
    : { kind: 'live', side: 'buy', n: q.amountNam, value: q.inAmount, nam: q.outAmount, avg: q.effectivePriceUsd, spot, move, worth: spot != null ? q.amountNam * spot : null, stamp };
}

/**
 * The ticket reading from the size table: the real row at `n`, a straight line between the two
 * real rows around it (the same arithmetic as the order-size curve, so the curve readout and the
 * ticket print the same figures), or no figure outside the quoted sizes.
 */
export function fromTable(c: QuoteCurveResponse | null, n: number, side: Side): Reading {
  const P = tablePoints(c);
  const stamp = tableStamp(c);
  const spot = c && fin(c.spotUsd) ? c.spotUsd : null;
  const none = (reason: string): Reading => ({ kind: 'none', side, n, value: null, nam: null, avg: null, spot, move: null, worth: null, stamp, reason });
  if (!P.length) return none(c?.prov.note ?? 'The size table is empty.');
  const row = (p: SlippageCurvePoint) =>
    side === 'sell'
      ? { value: p.sellOutUsdc, nam: p.amountNam as number | null, avg: p.sellEffectiveUsd, move: fin(p.sellImpactPct) ? -Math.abs(p.sellImpactPct) : null }
      : { value: p.buyInUsdc, nam: ratio(p.buyInUsdc, p.buyEffectiveUsd), avg: p.buyEffectiveUsd, move: fin(p.buyImpactPct) ? Math.abs(p.buyImpactPct) : null };
  const exact = P.find((p) => p.amountNam === n);
  if (exact) {
    const r = row(exact);
    return { kind: 'table', side, n, ...r, spot, worth: fin(exact.usdSize) ? exact.usdSize : null, stamp };
  }
  for (let i = 0; i < P.length - 1; i++) {
    const a = P[i];
    const b = P[i + 1];
    if (n > a.amountNam && n < b.amountNam) {
      const t = (n - a.amountNam) / (b.amountNam - a.amountNam);
      const ra = row(a);
      const rb = row(b);
      const value = mix(ra.value, rb.value, t);
      const nam = side === 'sell' ? n : mix(ra.nam, rb.nam, t);
      const est: Stamp = { ...stamp, derivedFrom: `a straight line between the ${fmtNamRule(a.amountNam)} and ${fmtNamRule(b.amountNam)} NAM rows of the size table` };
      return {
        kind: 'estimate',
        side,
        n,
        value,
        nam,
        avg: ratio(value, nam),
        spot,
        move: mix(ra.move, rb.move, t),
        worth: mix(a.usdSize, b.usdSize, t),
        stamp: est,
        a: a.amountNam,
        b: b.amountNam,
      };
    }
  }
  return none(`The size table covers ${fmtNamRule(P[0].amountNam)} to ${fmtNamRule(P[P.length - 1].amountNam)} NAM; outside that range no figure is shown.`);
}

/** The reference price for "Worth about" when no reading has one: the quoted price, else the last trade price. */
export function refPrice(o: Overview | null): { value: number | null; prov: Stamp } | null {
  if (!o) return null;
  if (fin(o.price.usd.value)) return { value: o.price.usd.value, prov: { ...o.price.usd.prov, plain: 'Osmosis quote' } };
  if (fin(o.price.swap1h.value)) return { value: o.price.swap1h.value, prov: o.price.swap1h.prov };
  return { value: null, prov: o.price.usd.prov };
}

/** Money in the NAM pools and how many: the live pool list when it answered, else the overview's stored reading. */
export interface Depth {
  usd: number | null;
  count: number | null;
  stamp: Stamp;
  /** true: summed from the live pool list on this page. */
  fromList: boolean;
}

export function depthOf(pools: { pools: PoolInfo[]; prov: Provenance } | null, o: Overview | null): Depth | null {
  if (pools && pools.pools.length) {
    const usd = pools.pools.reduce((a, p) => a + (fin(p.liquidityUsd) ? p.liquidityUsd : 0), 0);
    return { usd, count: pools.pools.length, stamp: { ...pools.prov, plain: 'Osmosis pools' }, fromList: true };
  }
  if (o) return { usd: o.dex.liquidityUsd, count: fin(o.dex.pools) && o.dex.pools > 0 ? o.dex.pools : null, stamp: { ...o.dex.prov, plain: 'Osmosis pools' }, fromList: false };
  return null;
}

/** "NAM / coin 0FA923…", "NAM / allBTC": the counter coin in plain words (a pool from /api/pools or a pair from /api/series/pairs). */
export function pairName(p: { pair: string; counterSymbol?: string | null }): string {
  const parts = p.pair.split('/').map((s) => s.trim());
  const base = parts[0] || 'NAM';
  const sym = p.counterSymbol || parts.slice(1).join('/');
  let counter = sym;
  // a bridged coin's denomination hash: its first six characters, enough to tell two apart in a row
  if (/^ibc\//i.test(sym)) counter = `coin ${sym.length > 14 ? `${sym.slice(4, 10)}…` : sym.slice(4)}`;
  else if (/^factory\//i.test(sym)) counter = sym.split('/').pop() || sym;
  else if (!sym || /^unknown$/i.test(sym)) counter = 'unknown coin';
  return `${base} / ${counter}`;
}

/** Pools with at least this share of all depth get a row; the rest are summed in one line. */
export const POOL_ROW_SHARE = 0.005;
export const POOL_ROW_MAX = 12;

export function splitPools<T extends { liquidityUsd: number | null }>(list: T[]): { shown: T[]; rest: T[]; total: number } {
  const sorted = [...list].sort((a, b) => (b.liquidityUsd || 0) - (a.liquidityUsd || 0));
  const total = sorted.reduce((a, p) => a + (fin(p.liquidityUsd) ? p.liquidityUsd : 0), 0);
  const shown: T[] = [];
  const rest: T[] = [];
  for (const p of sorted) {
    if (shown.length < POOL_ROW_MAX && (shown.length === 0 || (total > 0 && (p.liquidityUsd || 0) / total >= POOL_ROW_SHARE))) shown.push(p);
    else rest.push(p);
  }
  return { shown, rest, total };
}

/** How a safe-size figure was made (shared/types.ts SafeClipInfo['how']). */
export type SafeHow = 'interpolated' | 'at_least' | 'below_smallest';

export interface SafeSize {
  /** NAM: the straight-line estimate ('interpolated'), the largest listed size ('at_least'), the smallest one ('below_smallest'). */
  n: number | null;
  /** null: no listed size has both sides quoted, so there is no figure. */
  how: SafeHow | null;
  /** The two listed sizes the straight line was drawn between ('interpolated'). */
  a?: number;
  b?: number;
  /** The smallest listed size and its worse-side price move ('below_smallest' says these). */
  smallestNam: number | null;
  smallestImpactPct: number | null;
}

/**
 * The safe-size figures (W6: the worse of buying or selling at every listed size), with how each was made, so
 * the words never claim more than the quotes support: "about N" only between two listed sizes, "at least" the
 * largest size when none reaches the limit, and "under" the smallest size when even it moves the price more
 * (never a figure scaled down from zero). A current server sends `safeClip1Pct` / `safeClip3Pct`; for an older
 * one (whose figure below the smallest size was scaled from zero) the same rule runs here over the size table.
 */
export function safeSize(c: QuoteCurveResponse | null, limitPct: 1 | 3): SafeSize {
  const none: SafeSize = { n: null, how: null, smallestNam: null, smallestImpactPct: null };
  if (!c) return none;
  const P = tablePoints(c).filter((p) => fin(p.sellImpactPct) && fin(p.buyImpactPct));
  if (!P.length) return none;
  const imp = (p: SlippageCurvePoint) => Math.max(p.sellImpactPct as number, p.buyImpactPct as number);
  const info = limitPct === 1 ? c.safeClip1Pct : c.safeClip3Pct;
  const smallestNam = info && fin(info.smallestNam) ? info.smallestNam : P[0].amountNam;
  const smallestImpactPct = info && fin(info.smallestImpactPct) ? info.smallestImpactPct : imp(P[0]);
  const reached = P.findIndex((p) => imp(p) >= limitPct);
  const how: SafeHow = info?.how ?? (reached === 0 ? 'below_smallest' : reached < 0 ? 'at_least' : 'interpolated');
  if (how === 'below_smallest') return { n: smallestNam, how, smallestNam, smallestImpactPct };
  if (how === 'at_least') {
    const n = info && fin(info.nam) ? info.nam : P[P.length - 1].amountNam;
    return { n, how, smallestNam, smallestImpactPct };
  }
  const server = info ? info.nam : limitPct === 1 ? c.maxSafeClip1PctNam : c.maxSafeClip3PctNam;
  const around = reached > 0 ? { a: P[reached - 1].amountNam, b: P[reached].amountNam } : {};
  return { n: fin(server) ? server : null, how, ...around, smallestNam, smallestImpactPct };
}

/** Parse a typed amount: "5,000", "5000", "12.5". null when it is not a positive number. */
export function parseAmount(text: string): number | null {
  const t = text.replace(/[,\s_]/g, '');
  if (!/^\d*\.?\d+$|^\d+\.$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The three biggest price moves (by size) as chart markers: label like "+35.7%", placed where the move ended. */
export function markerEvents(moves: { t1: number; pct: number }[], fmt: (pct: number) => string): { t: number; label: string }[] {
  return [...moves]
    .filter((m) => fin(m.t1) && fin(m.pct))
    .sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct))
    .map((m) => ({ t: m.t1, label: fmt(m.pct) }));
}
