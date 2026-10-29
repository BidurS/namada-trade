// Depth screen model (step S5): pure functions, no React. Every figure the page prints comes from the minute's answer
// (/api/depth), a quote walked on it (/api/depth/quote), the stored rows of a past minute (/api/depth/history) or the
// stored trades; nothing here invents a number (N2): a missing input gives null and the reason, never a stand-in.
// The ladder's bands are read off the minute's aggregate curve as the research prototype read them (proto/template.html
// renderLadder); each band's split by pool comes from the minute's raw levels (a tick range's coins spread over the part
// of it the band covers, a book order whole) and, for a weighted or stable pool, whose level is one point holding the
// whole reserves, from that pool's own curve in the answer (thinned to 120 points a side on the grid rebuilt here from the
// reference price with shared/depth-grid.ts), as shares of the band's own figure.
import type { DepthCurve, DepthFill, DepthHistoryPoint, DepthHistoryResponse, DepthLevel, DepthPool, DepthPoolType, DepthQuoteResponse, DepthResponse } from '../../../../shared/depth';
import { CURVE_POOL_POINTS_MAX, DEPTH_PLAIN_SOURCE, DEPTH_QUOTABLE_SIZE, DEPTH_SIZES, DEPTH_SOURCES, FULL_RANGE, LADDER_FOLD_PCT, LADDER_MID_PCT, poolWord, rangeWords } from '../../../../shared/depth';
import { fmtSig } from '../../../../shared/format';
import { buildGrid, cumOn, thinIndices } from '../../../../shared/depth-grid';
import { SIZE_SLICE_JUMP_FROM_ZERO_PCT, SIZE_SLICE_JUMP_MIN_PCT, SIZE_SLICE_JUMP_RATIO } from '../../../../shared/size-table';
import { tradeValue } from '../../../../shared/settle';
import type { TradeRow } from '../../../../shared/types';
import type { Stamp } from '../../lib/prov';
import { parseAmount } from '../../lib/format';

export type Side = 'sell' | 'buy';
/** The four stored sizes: the chips (input choices; the figures for them are in every stored minute). */
export const SIZES: number[] = [...DEPTH_SIZES];
/** The size the page opens with. */
export const DEFAULT_SIZE: number = DEPTH_QUOTABLE_SIZE;

const fin = (x: number | null | undefined): x is number => x != null && Number.isFinite(x);

// ---------------------------------------------------------------- stamps

/** The minute's stamp: the chain's own state, as of the minute it was read, old once the Worker says it is stale. */
export function depthStamp(d: DepthResponse): Stamp {
  return {
    source: d.ref.source || DEPTH_SOURCES.poolManager,
    plain: DEPTH_PLAIN_SOURCE,
    at: d.at,
    height: d.ref.height,
    status: d.ref.status === 'stale' ? 'stale' : 'live',
    note: d.note,
  };
}

/** The stamp of one read in the minute's provenance list (the SourceLine's rows). */
export const provStamp = (p: { what: string; url: string | null; at: number; height: number | null; status: number | string }): Stamp => ({
  source: p.url ?? p.what,
  plain: p.what,
  at: p.at,
  height: p.height,
  status: typeof p.status === 'number' && p.status >= 400 ? 'missing' : 'live',
});

// ---------------------------------------------------------------- the reading (hero)

export interface Reading {
  /** stored: one of the minute's four sizes; quote: walked on the minute for a typed size; past: a stored minute (rewind); pending; none. */
  kind: 'stored' | 'quote' | 'past' | 'pending' | 'none';
  side: Side;
  nam: number;
  fill: DepthFill | null;
  /** The average price against the reference, percent (negative selling, positive buying). */
  vsRef: number | null;
  stamp: Stamp;
  /** quote: how the Worker walked it (shared/depth.ts QUOTE_HOW_*). */
  how?: string;
  /** none, or an incomplete fill: why, in plain words. */
  reason?: string;
}

export const storedFill = (d: DepthResponse, side: Side, nam: number): DepthFill | null => {
  const i = d.answer.sizes.indexOf(nam);
  return i >= 0 ? (side === 'sell' ? d.answer.sell[i] : d.answer.buy[i]) ?? null : null;
};

export const vsRefOf = (avg: number | null | undefined, ref: number): number | null => (fin(avg) && ref > 0 ? (avg / ref - 1) * 100 : null);

export function readingOfStored(d: DepthResponse, side: Side, nam: number): Reading | null {
  const fill = storedFill(d, side, nam);
  if (!fill) return null;
  return { kind: 'stored', side, nam, fill, vsRef: vsRefOf(fill.avgPrice, d.ref.usd), stamp: depthStamp(d) };
}

export function readingOfQuote(q: DepthQuoteResponse): Reading {
  const stamp: Stamp = { source: q.ref.source, plain: DEPTH_PLAIN_SOURCE, at: q.at, height: q.height, status: q.ref.status === 'stale' ? 'stale' : 'live', note: q.note };
  const fill: DepthFill = { nam: q.nam, usd: q.usd, avgPrice: q.avgPrice, marginalPrice: q.marginalPrice, complete: q.complete, filledNam: q.filledNam, split: q.split };
  return { kind: 'quote', side: q.side, nam: q.nam, fill, vsRef: q.vsRef, stamp, how: q.how, reason: q.note };
}

/** The share of a fill each pool took, largest first, for the split chips. */
export const splitShares = (fill: DepthFill): { pool: string; nam: number; usd: number; pct: number }[] =>
  [...fill.split].sort((a, b) => b.nam - a.nam).map((s) => ({ ...s, pct: fill.filledNam > 0 ? (s.nam / fill.filledNam) * 100 : 0 }));

// ---------------------------------------------------------------- pools

export const poolOf = (d: DepthResponse, id: string): DepthPool | undefined => d.pools.find((p) => p.id === id);
export const poolName = (d: DepthResponse | null, id: string): string => poolWord(id, d ? poolOf(d, id)?.type ?? null : null);
export const isBook = (type: DepthPoolType | null | undefined) => type === 'cosmwasm';
/** The pool fee in percent (the book charges none: its levels are limit orders). */
export const poolFeePct = (p: DepthPool): number => (isBook(p.type) ? 0 : p.spread * 100);
/** The taker fee the chain charges on every swap, from the reference pool's reading (percent), or null when it was not read. */
export const takerPct = (d: DepthResponse): number | null => {
  const t = poolOf(d, d.ref.pool)?.taker ?? d.pools.find((p) => fin(p.taker))?.taker;
  return fin(t) ? t * 100 : null;
};

// ---------------------------------------------------------------- the router line (check 2)

export interface RouterLine {
  nam: number;
  routerUsd: number;
  oursUsd: number;
  diffPct: number;
  at: number;
  pool: string;
}
/** The minute's check against the quote service's direct quote in the reference pool: base units of its counter coin into whole coins. */
export function routerLine(d: DepthResponse): RouterLine | null {
  const r = d.checks.route;
  if (!r) return null;
  const dec = poolOf(d, d.ref.pool)?.counterDecimals;
  if (!fin(dec)) return null;
  const k = 10 ** dec;
  return { nam: r.nam, routerUsd: r.routerOut / k, oursUsd: r.ours / k, diffPct: r.diffPct, at: r.at, pool: d.ref.pool };
}

// ---------------------------------------------------------------- when not to act (computed, never typed)

export interface Cliff {
  /** The size above which each extra coin fetches much less (the lower size of the slice that jumps). */
  above: number;
  /** The two larger stored sizes and the average move of each (percent against the reference). */
  a: { nam: number; pct: number };
  b: { nam: number; pct: number } | null;
}
/**
 * The size-table rule (shared/size-table.ts) over the minute's four stored fills: the slice between two sizes moves
 * the price at least SIZE_SLICE_JUMP_RATIO times as much as the slice below it and at least SIZE_SLICE_JUMP_MIN_PCT
 * on its own (or SIZE_SLICE_JUMP_FROM_ZERO_PCT when the slice below moved nothing). Incomplete fills end the walk.
 */
export function cliffOf(d: DepthResponse, side: Side): Cliff | null {
  const ref = d.ref.usd;
  if (!(ref > 0)) return null;
  const fills = (side === 'sell' ? d.answer.sell : d.answer.buy).map((f, i) => ({ f, nam: d.answer.sizes[i] })).filter((x) => x.f && x.f.complete && fin(x.f.usd));
  if (fills.length < 2) return null;
  const slice = (i: number) => {
    const prev = i > 0 ? fills[i - 1] : null;
    const dN = fills[i].nam - (prev?.nam ?? 0);
    const dU = fills[i].f.usd - (prev?.f.usd ?? 0);
    if (!(dN > 0)) return null;
    const p = dU / dN;
    return Math.max(0, (side === 'sell' ? (ref - p) / ref : (p - ref) / ref) * 100);
  };
  for (let i = 1; i < fills.length; i++) {
    const below = slice(i - 1);
    const above = slice(i);
    if (below == null || above == null) continue;
    const jump = below === 0 ? above >= SIZE_SLICE_JUMP_FROM_ZERO_PCT : above >= below * SIZE_SLICE_JUMP_RATIO && above >= SIZE_SLICE_JUMP_MIN_PCT;
    if (!jump) continue;
    const pct = (x: { f: DepthFill }) => vsRefOf(x.f.avgPrice, ref) ?? 0;
    const a = fills[i];
    const b = fills[i + 1] ?? null;
    return { above: fills[i - 1].nam, a: { nam: a.nam, pct: pct(a) }, b: b ? { nam: b.nam, pct: pct(b) } : null };
  }
  return null;
}

export interface BookRule {
  bookId: string;
  /** The pool price after the reference pool's fee and the taker fee: what a sale into the pools fetches per coin at the touch. */
  afterUsd: number;
  /** How far under that after-fee price the book's nearest bid sits, percent (the sentence says "after fees", so the figure is measured there). */
  underPct: number;
}
/** The book's nearest bid against the pool price after fees (ux-principles 11): bestBid(book) < ref x (1 - spread - taker). */
export function bookRule(d: DepthResponse): BookRule | null {
  const book = d.pools.find((p) => isBook(p.type));
  if (!book) return null;
  const bids = d.book.levels.filter((l) => l.pool === book.id && l.side === 'bid');
  if (!bids.length) return null;
  const best = Math.max(...bids.map((l) => l.hiUsd));
  const taker = takerPct(d);
  const refPool = poolOf(d, d.ref.pool);
  const after = d.ref.usd * (1 - (refPool?.spread ?? 0) - (taker ?? 0) / 100);
  if (!(after > 0) || !(best < after)) return null;
  return { bookId: book.id, afterUsd: after, underPct: (1 - best / after) * 100 };
}

export interface MarketSize {
  /** What rests on the side the reading takes from: the bids' USD selling, the asks' coins buying. */
  total: number;
  unit: 'usd' | 'nam';
  /** The reading's share of it, percent (USD of USD selling, coins of coins buying). */
  share: number;
}
/**
 * The side's size in the terms the minute stores (within.totalBidUsd, within.totalAskNam). The ask side is measured
 * in coins: its USD would be read off the curve's far tail, where the weighted pools' constant-product asks run to the
 * grid's ceiling at prices that will never trade (a million dollars of asks against five hundred of bids on the
 * fixtures of 2026-10-29), so a share of it would print as zero.
 */
export function marketSize(d: DepthResponse, side: Side, fill: DepthFill | null): MarketSize | null {
  if (!fill) return null;
  if (side === 'sell') {
    const total = d.within.totalBidUsd;
    if (!fin(total) || total <= 0 || !fin(fill.usd)) return null;
    return { total, unit: 'usd', share: (fill.usd / total) * 100 };
  }
  const total = d.within.totalAskNam;
  if (!fin(total) || total <= 0 || !fin(fill.filledNam)) return null;
  return { total, unit: 'nam', share: (fill.filledNam / total) * 100 };
}

// ---------------------------------------------------------------- the per-pool curves on their own prices

export interface PoolCurve {
  price: number[];
  bidUsd: number[];
  askUsd: number[];
}
/**
 * Each pool's thinned curve (CURVE_POOL_POINTS_MAX points a side) on the prices the Worker kept: the grid rebuilt from
 * the reference price and thinned the same way (shared/depth-grid.ts). A pool whose arrays do not match that count (a
 * minute written by other code) is left out rather than placed on guessed prices. Read for the weighted and stable
 * pools only (their level is a point); a concentrated pool's ranges and the book's orders are read from the levels.
 */
export function perPoolCurves(d: DepthResponse): Map<string, PoolCurve> {
  const out = new Map<string, PoolCurve>();
  const ref = d.ref.usd;
  if (!(ref > 0)) return out;
  const grid = buildGrid(ref);
  const refIndex = Math.max(0, grid.findIndex((g) => g >= ref));
  const idx = thinIndices(grid.length, refIndex, CURVE_POOL_POINTS_MAX);
  const price = idx.map((i) => grid[i]);
  for (const [id, c] of Object.entries(d.curve.perPool)) {
    if (c.bidUsd.length !== price.length || c.askUsd.length !== price.length) continue;
    out.set(id, { price, bidUsd: c.bidUsd, askUsd: c.askUsd });
  }
  return out;
}
/** What a pool's own curve holds between two prices on a side. */
const curveBetween = (pc: PoolCurve, side: 'bid' | 'ask', a: number, b: number): number =>
  Math.max(0, side === 'bid' ? cumOn(pc.price, pc.bidUsd, a) - cumOn(pc.price, pc.bidUsd, b) : cumOn(pc.price, pc.askUsd, b) - cumOn(pc.price, pc.askUsd, a));
/** A weighted or stable pool: its level is one point holding the whole reserves, so its share of a band is read from its curve. */
const pointPool = (t: DepthPoolType) => t === 'balancer' || t === 'stableswap';

// ---------------------------------------------------------------- the ladder

export interface BandPool {
  id: string;
  type: DepthPoolType;
  nam: number;
  usd: number;
  /** What the pool's share is read from: a concentrated pool's tick ranges, the book's orders, a weighted or stable pool's reserves (one point on the price axis). */
  kind: 'ranges' | 'orders' | 'reserves';
  /** A concentrated pool's tick ranges touching the band; the book's orders in it (the minute's raw levels). Zero for a pool read from its reserves. */
  ranges: number;
  orders: number;
  feePct: number;
}
export interface Band {
  side: 'ask' | 'bid';
  lo: number;
  hi: number;
  nam: number;
  usd: number;
  /** Cumulative from the reference outward: NAM on the ask side, USD on the bid side. */
  cum: number;
  /** Distance from the reference price, percent (the far edge of the band). */
  dist: number;
  pools: BandPool[];
}
export interface Ladder {
  /** Asks, furthest first (the top of the ladder), nearest the reference last. */
  asks: Band[];
  /** Bids, nearest the reference first. */
  bids: Band[];
  maxCumAsk: number;
  maxCumBid: number;
}

const GRID_LO = 1e-7, GRID_HI = 200;

/** The share of a level inside [a, b): a range by price width, a point level (a book order) whole when it sits inside. */
export function overlap(l: { loUsd: number; hiUsd: number }, a: number, b: number): number {
  if (!(l.hiUsd > l.loUsd)) return l.loUsd >= a && l.loUsd < b ? 1 : 0;
  const lo = Math.max(l.loUsd, a), hi = Math.min(l.hiUsd, b);
  return hi > lo ? (hi - lo) / (l.hiUsd - l.loUsd) : 0;
}

/** The ladder's bands at `widthPct` percent of the reference, read off the minute's cumulative curves (the prototype's rule). */
export function ladderOf(d: DepthResponse, widthPct: number): Ladder {
  const ref = d.ref.usd;
  const w = widthPct / 100;
  const c: DepthCurve = d.curve;
  const levels = d.book.levels;
  const per = perPoolCurves(d);
  const empty: Ladder = { asks: [], bids: [], maxCumAsk: 0, maxCumBid: 0 };
  if (!(ref > 0) || !(w > 0) || !c.price.length) return empty;
  const cum = (key: keyof Omit<DepthCurve, 'perPool'>, p: number) => cumOn(c.price, c[key], p);
  const poolsIn = (side: 'ask' | 'bid', a: number, b: number, bandNam: number, bandUsd: number): BandPool[] => {
    const by = new Map<string, BandPool>();
    for (const l of levels) {
      if (!(l.side === 'both' || l.side === side)) continue;
      const p = poolOf(d, l.pool);
      const pc = pointPool(l.type) ? per.get(l.pool) : undefined;
      const f = pc ? 1 : overlap(l, a, b);
      if (!(f > 0)) continue;
      // what the level holds on this side: a bid level's counter coin (in USD), an ask level's base coins at the band's prices; a point pool from its curve
      const usd = pc ? curveBetween(pc, side, a, b) : side === 'bid' ? f * l.counterUsd : f * l.nam * ((a + b) / 2);
      if (!(usd > 0)) continue;
      const kind: BandPool['kind'] = isBook(l.type) ? 'orders' : pointPool(l.type) ? 'reserves' : 'ranges';
      const row = by.get(l.pool) ?? { id: l.pool, type: p?.type ?? l.type, nam: 0, usd: 0, kind, ranges: 0, orders: 0, feePct: p ? poolFeePct(p) : isBook(l.type) ? 0 : l.spread * 100 };
      row.usd += usd;
      if (kind === 'orders') row.orders += l.orders ?? 1; else if (kind === 'ranges') row.ranges += 1;
      by.set(l.pool, row);
    }
    const out = [...by.values()].sort((x, y) => y.usd - x.usd);
    // the pools' figures are their shares of the band's own figure (the aggregate curve's), never a second total
    const sum = out.reduce((n, r) => n + r.usd, 0);
    for (const r of out) { const share = sum > 0 ? r.usd / sum : 0; r.usd = share * bandUsd; r.nam = share * bandNam; }
    return out;
  };
  const asks: Band[] = [];
  let cumA = 0;
  const maxK = Math.ceil(Math.log(GRID_HI / ref) / Math.log(1 + w));
  for (let k = 1; k <= maxK; k++) {
    const a = ref * (1 + w) ** (k - 1), b = ref * (1 + w) ** k;
    const nam = cum('askNam', b) - cum('askNam', a);
    if (!(nam > 1e-6)) continue;
    const usd = Math.max(0, cum('askUsd', b) - cum('askUsd', a));
    cumA += nam;
    asks.push({ side: 'ask', lo: a, hi: b, nam, usd, cum: cumA, dist: (b / ref - 1) * 100, pools: poolsIn('ask', a, b, nam, usd) });
  }
  asks.reverse();
  const bids: Band[] = [];
  let cumB = 0;
  const minK = Math.ceil(Math.log(ref / GRID_LO) / Math.log(1 + w));
  for (let k = 1; k <= minK; k++) {
    const b = ref / (1 + w) ** (k - 1), a = ref / (1 + w) ** k;
    const usd = cum('bidUsd', a) - cum('bidUsd', b);
    if (!(usd > 1e-6)) continue;
    const nam = Math.max(0, cum('bidNam', a) - cum('bidNam', b));
    cumB += usd;
    bids.push({ side: 'bid', lo: a, hi: b, nam, usd, cum: cumB, dist: (a / ref - 1) * 100, pools: poolsIn('bid', a, b, nam, usd) });
  }
  return { asks, bids, maxCumAsk: cumA, maxCumBid: cumB };
}

export const isFar = (b: Band) => Math.abs(b.dist) > LADDER_FOLD_PCT;
export const isMid = (b: Band) => !isFar(b) && Math.abs(b.dist) > LADDER_MID_PCT;

/** The band the picked reading's last coin filled in (its marginal price), on the reading's side. */
export function markedBand(ladder: Ladder, reading: Reading | null): Band | null {
  const f = reading?.fill;
  if (!f || !fin(f.marginalPrice) || !f.complete) return null;
  const rows = reading!.side === 'sell' ? ladder.bids : ladder.asks;
  return rows.find((b) => f.marginalPrice >= b.lo && f.marginalPrice < b.hi) ?? null;
}

/** What selling down to (bids) or buying up to (asks) a band's far edge comes to in all, from the curve. */
export function cumToBand(d: DepthResponse, b: Band): number {
  return b.side === 'bid' ? cumOn(d.curve.price, d.curve.bidUsd, b.lo) : cumOn(d.curve.price, d.curve.askUsd, b.hi);
}

/** The reference row's spread: the touch's best bid and ask after fees, percent (negative: crossed across pools). */
export function touchSpread(d: DepthResponse): number | null {
  const t = d.touch;
  return fin(t.bestBidEff) && fin(t.bestAskEff) && t.bestBidEff > 0 ? (t.bestAskEff / t.bestBidEff - 1) * 100 : null;
}

// ---------------------------------------------------------------- the curve

export type CurveRange = 'near' | 'wide' | 'all';
/** The price window of each range, and whether it is drawn on a log axis (said in the axis label). */
export function curveWindow(d: DepthResponse, range: CurveRange): { lo: number; hi: number; log: boolean } {
  const ref = d.ref.usd;
  const p = d.curve.price;
  if (range === 'near') return { lo: ref / 2, hi: ref * 2, log: false };
  if (range === 'wide') return { lo: ref / 10, hi: ref * 10, log: true };
  return { lo: p[0] ?? ref / 10, hi: p[p.length - 1] ?? ref * 10, log: true };
}

export interface SizeMark {
  side: Side;
  nam: number;
  price: number;
  usd: number;
}
/** The eight size marks: each complete stored fill at the price its last coin filled, with its USD. */
export function sizeMarks(d: DepthResponse): SizeMark[] {
  const out: SizeMark[] = [];
  d.answer.sizes.forEach((nam, i) => {
    for (const side of ['sell', 'buy'] as const) {
      const f = (side === 'sell' ? d.answer.sell : d.answer.buy)[i];
      if (f && f.complete && fin(f.marginalPrice) && fin(f.usd)) out.push({ side, nam, price: f.marginalPrice, usd: f.usd });
    }
  });
  return out;
}

export interface TradeMark {
  id: string;
  t: number;
  kind: 'buy' | 'sell';
  price: number;
  usd: number;
  nam: number;
}
/** The stored trades as marks: each at its settle price (else its recorded price) and its value; a trade with neither is left out. */
export function tradeMarks(rows: TradeRow[], since: number): TradeMark[] {
  const out: TradeMark[] = [];
  for (const r of rows) {
    if (r.ts < since) continue;
    const v = tradeValue(r);
    const price = r.settle?.usdPerNam ?? r.priceUsd;
    if (!v || !fin(price) || !(price > 0) || !(v.usd > 0)) continue;
    out.push({ id: r.id, t: r.ts, kind: r.kind, price, usd: v.usd, nam: v.nam });
  }
  return out;
}

/** The pools with a level at a price (within a band of two and a half percent around it), the largest first: the readout's "pools at that price". */
export function poolsAtPrice(d: DepthResponse, per: Map<string, PoolCurve>, side: 'bid' | 'ask', price: number): string[] {
  const a = price * 0.9875, b = price * 1.0125;
  const by = new Map<string, number>();
  for (const l of d.book.levels) {
    if (!(l.side === 'both' || l.side === side)) continue;
    const pc = pointPool(l.type) ? per.get(l.pool) : undefined;
    const f = pc ? 1 : overlap(l, a, b);
    if (!(f > 0)) continue;
    const usd = pc ? curveBetween(pc, side, a, b) : side === 'bid' ? f * l.counterUsd : f * l.nam * price;
    if (usd > 0) by.set(l.pool, (by.get(l.pool) ?? 0) + usd);
  }
  return [...by.entries()].sort((x, y) => y[1] - x[1]).map((x) => x[0]);
}

// ---------------------------------------------------------------- rewind: the stored minute

/** The newest stored point at or before `at`, or null. */
export function pointAt(h: DepthHistoryResponse | null, at: number): DepthHistoryPoint | null {
  if (!h) return null;
  let best: DepthHistoryPoint | null = null;
  for (const p of h.points) if (p.t <= at && (!best || p.t > best.t)) best = p;
  return best;
}

/** The reading of a stored minute for one of the stored sizes: the USD and the average; the marginal price and the split were not stored. */
export function readingOfPoint(p: DepthHistoryPoint, side: Side, nam: number, sizes: readonly number[], stampNote: string): Reading | null {
  const i = sizes.indexOf(nam);
  if (i < 0) return null;
  const usd = (side === 'sell' ? p.sell : p.buy)[i];
  const stamp: Stamp = { source: DEPTH_SOURCES.poolManager, plain: DEPTH_PLAIN_SOURCE, at: p.at, height: p.height, status: 'live', note: stampNote };
  if (!fin(usd)) return { kind: 'none', side, nam, fill: null, vsRef: null, stamp: { ...stamp, status: 'missing', note: p.note ?? stampNote }, reason: p.note ?? stampNote };
  const avg = usd / nam;
  return { kind: 'past', side, nam, fill: { nam, usd, avgPrice: avg, marginalPrice: NaN, complete: true, filledNam: nam, split: [] }, vsRef: vsRefOf(avg, p.refUsd), stamp };
}

/** Levels of one pool inside a band, for the sheet's list (the raw levels of the minute). */
export const levelsIn = (d: DepthResponse, pool: string, b: Band): DepthLevel[] =>
  d.book.levels.filter((l) => l.pool === pool && l.hiUsd > b.lo && l.loUsd < b.hi && (l.side === 'both' || l.side === b.side));

/** A typed amount is parsed as the Trade ticket parses it (shared/format.ts). */
export { parseAmount };

/** A range in words: the two prices at significant digits, or the whole range when the position spans every price the pool can reach (the chain's own extremes). */
export const priceRange = (lo: number | null, hi: number | null): string => (lo != null && hi != null && lo <= 1e-9 && hi >= 1e9 ? FULL_RANGE : rangeWords(lo != null ? fmtSig(lo) : '—', hi != null ? fmtSig(hi) : '—'));

/** "10k", "1M" for a chip or a mark. */
export const shortSize = (n: number): string => (n >= 1e6 ? `${+(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)}k` : String(n));
