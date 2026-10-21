// Trade basics, the pure half (S2; docs/design/screener-plan.md 2.1 to 2.6, 3.5 and 3.9): how a chart range maps
// to a series request, what a series answer becomes on the chart, the price-change cells, the trades tape's
// groups, and the header's derived figures. No React, nothing invented (N2): a missing input gives null and the
// reason, never a stand-in; a step without a point stays empty (no candle, no filled hour).
import type {
  ExecutedVolume, Flow, PoolChangeWindow, PriceChange, PriceChangeWindow, PriceChangesResponse, Provenance,
  SeriesResponse, SeriesStep, TradeGroup, TradeRow, TradesResponse, VolumeWindow,
} from '../../../../shared/types';
import { SERIES_MAX_POINTS, SERIES_STEP_MS, TRADE_FOLD_MS, TRADE_FOLD_UNDER_NAM } from '../../../../shared/types';
import { DAY_MS, HISTORY_FETCH_DAYS, type HistoryRange } from '../../../../shared/history';
import { isBotFlow } from '../../../../shared/flow-rules';
import { priceHow } from '../../lib/flows';

const fin = (x: number | null | undefined): x is number => x != null && Number.isFinite(x);

// ---------------------------------------------------------------- the chart's requests

/** The ranges that draw the pool price from the Osmosis data API (screener-plan 2.6); the short ones draw our keys only. */
export const LONG_RANGES: readonly HistoryRange[] = ['90d', '1y', 'all'];
export const isLongRange = (r: HistoryRange) => LONG_RANGES.includes(r);

/** The finest step that keeps `days` within SERIES_MAX_POINTS: 30 and 90 days hourly, 1 year in 6-hour steps, "All" daily. */
export function seriesStepFor(days: number): SeriesStep {
  const span = days * DAY_MS;
  for (const s of ['1h', '6h', '1d'] as const) if (span / SERIES_STEP_MS[s] <= SERIES_MAX_POINTS) return s;
  return '1d';
}

/** "2026-10-20": a UTC day, the `from` a series request sends (one edge-cache entry per day, not per minute). */
export const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);

/**
 * The window a range asks /api/series for: from the UTC midnight `days` before the end (the screen filters to the
 * exact range), to the end the server takes by itself (now, or `at` under Rewind), at the finest step that fits.
 */
export function seriesWindow(range: HistoryRange, end: number): { days: number; from: string; step: SeriesStep; stepMs: number } {
  const days = HISTORY_FETCH_DAYS[range];
  const step = seriesStepFor(days);
  return { days, from: isoDay(end - days * DAY_MS), step, stepMs: SERIES_STEP_MS[step] };
}

// ---------------------------------------------------------------- a series answer on the chart

export interface Pt {
  t: number;
  v: number;
  /** the newest reading's own time in the step, when it is not the step's start (SeriesSample.at) */
  at?: number;
}
export interface BandPt {
  t: number;
  lo: number;
  hi: number;
}
/** One step of executed volume (screener-plan 2.6 BarPoint): NAM traded, its dollars when known, how many trades when known. */
export interface BarPt {
  t: number;
  nam: number;
  usd: number | null;
  n: number | null;
}

/** The answer's points as the chart draws them, oldest first; only a series in dollars per NAM goes on the price axis. */
export const pointsOf = (r: SeriesResponse | null | undefined): Pt[] =>
  (r?.points ?? []).filter((p) => fin(p.t) && fin(p.v)).map((p) => ({ t: p.t, v: p.v, ...(fin(p.at) ? { at: p.at } : {}) })).sort((a, b) => a.t - b.t);

/** The quoted price's lowest and highest reading in each step (the band); steps without both are left out. */
export const bandOf = (r: SeriesResponse | null | undefined): BandPt[] =>
  (r?.points ?? []).filter((p) => fin(p.t) && fin(p.lo) && fin(p.hi)).map((p) => ({ t: p.t, lo: p.lo as number, hi: p.hi as number })).sort((a, b) => a.t - b.t);

/** The pool steps in which no trade moved the pool (open = high = low = close): drawn as short marks, never a candle. */
export const flatOf = (r: SeriesResponse | null | undefined): number[] => (r?.points ?? []).filter((p) => p.flat === true && fin(p.t)).map((p) => p.t).sort((a, b) => a - b);

/** Hourly executed volume as bars: a step without a row had no trade and draws an empty slot. */
export const barsOf = (r: SeriesResponse | null | undefined): BarPt[] =>
  (r?.points ?? []).filter((p) => fin(p.t) && fin(p.v) && p.v >= 0).map((p) => ({ t: p.t, nam: p.v, usd: null, n: fin(p.n) ? p.n : null })).sort((a, b) => a.t - b.t);

/** A series is drawn on the price axis only when its unit is dollars per NAM (one axis per plot, system.md 7.2). */
export const onPriceAxis = (r: SeriesResponse | null | undefined) => !!r && r.unit === 'usd_per_nam';

/** When a series honestly starts, printed under the chart (screener-plan 3.9). `at` null: not known, with the reason. */
export interface SeriesStart {
  what: string;
  at: number | null;
  /** filled in once from stored rows before its writer shipped */
  backfilled: boolean;
  /** why the start is not known */
  why?: string;
}

/** The start of a series from its answer: the earliest source start, and whether any source was filled in once. */
export function startOf(what: string, r: SeriesResponse | null | undefined, why?: string): SeriesStart {
  if (!r) return { what, at: null, backfilled: false, why: why ?? 'this server does not say when it begins' };
  const at = fin(r.start) ? r.start : null;
  return { what, at, backfilled: r.sources.some((s) => s.backfilled), ...(at == null ? { why: why ?? 'the series has no reading yet' } : {}) };
}

/** Runs of points split where the next point is more than `maxGapMs` later: a line never crosses a stretch with no reading. */
export function runsOf<T extends { t: number }>(pts: T[], maxGapMs: number): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  for (const p of pts) {
    if (cur.length && p.t - cur[cur.length - 1].t > maxGapMs) {
      out.push(cur);
      cur = [];
    }
    cur.push(p);
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * Pairs of executed points that are adjacent steps (both steps traded): the only places the executed series is
 * joined by a line. A lone trade-hour is a dot, never part of a flat line (screener-plan 2.6).
 */
export function adjacentPairs(pts: Pt[], stepMs: number): [Pt, Pt][] {
  const out: [Pt, Pt][] = [];
  for (let i = 1; i < pts.length; i++) if (pts[i].t - pts[i - 1].t <= stepMs * 1.01) out.push([pts[i - 1], pts[i]]);
  return out;
}

/** Steps of [from, to) on the `stepMs` grid, and how many of them carry a bar (the empty slots are the rest). */
export function slotsOf(bars: BarPt[], from: number, to: number, stepMs: number): { slots: number; withBar: number; empty: number[] } {
  if (!(stepMs > 0) || !(to > from)) return { slots: 0, withBar: 0, empty: [] };
  const have = new Set(bars.filter((b) => b.t >= from && b.t < to).map((b) => Math.floor(b.t / stepMs)));
  const first = Math.ceil(from / stepMs);
  const last = Math.ceil(to / stepMs);
  const empty: number[] = [];
  for (let k = first; k < last; k++) if (!have.has(k)) empty.push(k * stepMs);
  const slots = Math.max(0, last - first);
  return { slots, withBar: slots - empty.length, empty };
}

// ---------------------------------------------------------------- price changes (screener-plan 2.1)

export const QUOTED_WINDOWS: readonly PriceChangeWindow[] = ['h1', 'h6', 'h24', 'd7', 'd30'];
export const POOL_WINDOWS: readonly PoolChangeWindow[] = ['d7', 'd30', 'y1'];
/** The window words on the cells and in sentences. */
export const WINDOW_WORD: Record<PriceChangeWindow | PoolChangeWindow | VolumeWindow, string> = {
  h1: '1 h',
  h6: '6 h',
  h24: '24 h',
  d7: '7 days',
  d30: '30 days',
  y1: '1 year',
};

export interface ChangeCell {
  window: PriceChangeWindow | PoolChangeWindow;
  word: string;
  change: PriceChange;
}

/**
 * The cells of one change row: windows whose base reading exists (a figure), and the windows not covered yet,
 * said in one sentence with the server's reason (never 0, never a guess). A window the answer lacks is "not covered".
 */
export function changeCells<W extends PriceChangeWindow | PoolChangeWindow>(map: Partial<Record<W, PriceChange>> | null | undefined, order: readonly W[]): { shown: ChangeCell[]; notYet: { words: string[]; notes: string[] } } {
  const shown: ChangeCell[] = [];
  const words: string[] = [];
  const notes: string[] = [];
  for (const w of order) {
    const c = map?.[w];
    if (c && fin(c.pct) && c.base && c.now) shown.push({ window: w, word: WINDOW_WORD[w], change: c });
    else {
      words.push(WINDOW_WORD[w]);
      const note = c?.note ?? c?.prov.note;
      if (note && !notes.includes(note)) notes.push(note);
    }
  }
  return { shown, notYet: { words, notes: joinRecordedSince(notes) } };
}

const RECORDED_SINCE = /^(The .+ has been recorded since [^,]+, so its) (.+) change is known from (.+)\.$/;

/**
 * "The quoted price has been recorded since 15 Oct 2026, so its 7-day change is known from 21 Oct 2026 and its
 * 30-day change from 12 Nov 2026." in place of the same opening said once per window.
 */
function joinRecordedSince(notes: string[]): string[] {
  const out: string[] = [];
  const parts = new Map<string, { at: number; tails: string[] }>();
  for (const n of notes) {
    const m = RECORDED_SINCE.exec(n);
    if (!m) { out.push(n); continue; }
    const p = parts.get(m[1]);
    if (p) p.tails.push(`its ${m[2]} change from ${m[3]}`);
    else { parts.set(m[1], { at: out.length, tails: [`${m[2]} change is known from ${m[3]}`] }); out.push(''); }
  }
  for (const [open, p] of parts) out[p.at] = `${open} ${listWords(p.tails)}.`;
  return out;
}

/** "1 h, 6 h and 24 h" */
export const listWords = (w: string[]) => (w.length <= 1 ? w.join('') : `${w.slice(0, -1).join(', ')} and ${w[w.length - 1]}`);

/** The base of a change came later than the window's start by more than a minute: say how much later. */
export const lateBase = (c: PriceChange) => (fin(c.baseLagMs) && c.baseLagMs >= 60_000 ? c.baseLagMs : null);

/** The quoted map of a changes answer; null when the answer is missing. */
export const quotedOf = (r: PriceChangesResponse | null | undefined) => r?.quoted ?? null;
export const poolOf = (r: PriceChangesResponse | null | undefined) => r?.pool ?? null;

// ---------------------------------------------------------------- the trades tape (screener-plan 2.5)

/** A tape row: a folded run of one maker's trades on one side (a single trade is a run of one), with its rows. */
export interface TapeGroup extends TradeGroup {
  key: string;
  rows: TradeRow[];
  /** every row came through the live stream after the page was fetched */
  live: boolean;
}

/** A trade from the live stream (an Osmosis buy or sell, bot round trips left out), in the tape's row shape; null otherwise. */
export function tradeOfFlow(f: Flow): TradeRow | null {
  if (f.chain !== 'osmosis' || (f.kind !== 'buy' && f.kind !== 'sell') || isBotFlow(f) || !fin(f.amount)) return null;
  const m = (f.meta ?? {}) as Record<string, unknown>;
  const maker = typeof m.trader === 'string' && m.trader ? m.trader : f.kind === 'buy' ? f.to : f.from;
  const how = priceHow(f);
  const priced = fin(f.priceUsd);
  const tsSource = typeof m.tsSource === 'string' ? m.tsSource : null;
  return {
    id: f.id,
    ts: f.ts,
    height: f.height,
    tsSource,
    kind: f.kind,
    nam: f.amount,
    counterSymbol: f.counterDenom ?? null,
    counterAmount: fin(f.counterAmount) ? f.counterAmount : null,
    priceUsd: priced ? (f.priceUsd as number) : null,
    priceSource: !priced ? null : how === 'execution' || how === 'swap_1h' || how === 'spot' ? how : 'unknown',
    valueUsd: fin(f.valueUsd) ? f.valueUsd : null,
    ...(priced ? {} : { priceNote: 'No price was recorded for this trade.' }),
    maker: maker ?? null,
    makerLabelPlain: (f.kind === 'buy' ? f.toLabelPlain : f.fromLabelPlain) ?? null,
    makerLabelSource: (f.kind === 'buy' ? f.toLabelSource : f.fromLabelSource) ?? null,
    makerLabelAuthor: (f.kind === 'buy' ? f.toLabelAuthor : f.fromLabelAuthor) ?? null,
    makerTrades: null,
    route: f.poolId ? f.poolId.split(',').map((p) => p.trim()).filter(Boolean) : [],
    txHash: f.txHash,
    ...(f.explorerHash ? { explorerHash: f.explorerHash } : {}),
    pattern: null,
  };
}

/** A group's sums from its rows (newest first): NAM, dollars over the priced rows, the average price over them. */
function sums(rows: TradeRow[]): Pick<TradeGroup, 'n' | 'nam' | 'usd' | 'unpriced' | 'avgPriceUsd' | 'firstTs' | 'lastTs'> {
  let nam = 0;
  let usd = 0;
  let pricedNam = 0;
  let unpriced = 0;
  for (const r of rows) {
    nam += r.nam;
    if (fin(r.valueUsd)) {
      usd += r.valueUsd;
      pricedNam += r.nam;
    } else unpriced++;
  }
  const priced = rows.length - unpriced;
  return {
    n: rows.length,
    nam,
    usd: priced ? usd : null,
    unpriced,
    avgPriceUsd: priced && pricedNam > 0 ? usd / pricedNam : null,
    firstTs: Math.min(...rows.map((r) => r.ts)),
    lastTs: Math.max(...rows.map((r) => r.ts)),
  };
}

const groupOf = (rows: TradeRow[], live: boolean): TapeGroup => ({
  key: rows[0].id,
  maker: rows[0].maker,
  kind: rows[0].kind,
  ids: rows.map((r) => r.id),
  rows,
  ...sums(rows),
  pattern: rows.find((r) => r.pattern)?.pattern ?? null,
  live,
});

/**
 * The fold rule, the server's (worker/src/series-api.ts foldTrades): consecutive rows by one maker on one side, each
 * under `underNam` NAM, within `foldMs` of the next, through a pool every row of the run went through.
 */
export interface FoldRule {
  foldMs: number;
  underNam: number;
}
/** The rule a page states (TradesResponse.foldMs and foldUnderNam), else the published one. */
export const foldRuleOf = (page: TradesResponse | null | undefined, fallback: Partial<FoldRule> = {}): FoldRule => ({
  foldMs: page?.foldMs ?? fallback.foldMs ?? TRADE_FOLD_MS,
  underNam: page?.foldUnderNam ?? page?.patternRule?.underNam ?? fallback.underNam ?? TRADE_FOLD_UNDER_NAM,
});

/** The pools every row of a run went through (the router picks each trade's route, so routes differ). */
const poolsOf = (run: TradeRow[]): Set<string> => {
  let common = new Set(run[0]?.route ?? []);
  for (const r of run.slice(1)) common = new Set(r.route.filter((p) => common.has(p)));
  return common;
};

/**
 * Can row `b` (older) continue `run` (newest first)? One maker (known), one side, both trades under the size bound,
 * within `foldMs` of the run's oldest row, and through a pool every row of the run went through.
 */
function continues(run: TradeRow[], b: TradeRow, rule: FoldRule): boolean {
  const a = run[run.length - 1];
  if (!a || !a.maker || a.maker !== b.maker || a.kind !== b.kind || !(a.ts - b.ts <= rule.foldMs) || a.ts < b.ts) return false;
  if (!(a.nam < rule.underNam && b.nam < rule.underNam)) return false;
  const pools = poolsOf(run);
  return b.route.some((p) => pools.has(p));
}

/** Consecutive rows (newest first) fold into one group by the rule (FoldRule); a single trade is a group of one. */
export function foldTrades(rows: TradeRow[], rule: FoldRule, live = false): TapeGroup[] {
  const out: TradeRow[][] = [];
  for (const r of rows) {
    const cur = out[out.length - 1];
    if (cur && continues(cur, r, rule)) cur.push(r);
    else out.push([r]);
  }
  return out.map((g) => groupOf(g, live));
}

/**
 * The server's groups for a page, with their rows. When a group names a row the page lacks, or a row is in no group,
 * the page is folded here by the same rule (the page's foldMs and foldUnderNam) instead, so no trade is dropped or
 * shown twice.
 */
export function groupsOfPage(r: TradesResponse): TapeGroup[] {
  const byId = new Map(r.rows.map((row) => [row.id, row]));
  const seen = new Set<string>();
  const out: TapeGroup[] = [];
  for (const g of r.groups ?? []) {
    const rows = g.ids.map((id) => byId.get(id)).filter((x): x is TradeRow => !!x);
    if (rows.length !== g.ids.length || !rows.length || rows.some((x) => seen.has(x.id))) return foldTrades(r.rows, foldRuleOf(r));
    rows.forEach((x) => seen.add(x.id));
    // the server's figures, with the rows' own when it sent none
    out.push({ ...groupOf(rows, false), ...g, key: rows[0].id, rows, live: false });
  }
  if (seen.size !== r.rows.length) return foldTrades(r.rows, foldRuleOf(r));
  return out;
}

/**
 * Joins two runs of groups (newer, then older): the newer list's last group takes the older list's first when the
 * two fold into one run by the rule, row by row (every row small, one maker and side, a pool all of them share).
 */
export function joinGroups(newer: TapeGroup[], older: TapeGroup[], rule: FoldRule): TapeGroup[] {
  if (!newer.length) return older;
  if (!older.length) return newer;
  const a = newer[newer.length - 1];
  const b = older[0];
  const rows = [...a.rows, ...b.rows];
  if (!continues(a.rows, b.rows[0], rule) || foldTrades(rows, rule).length !== 1) return [...newer, ...older];
  return [...newer.slice(0, -1), { ...groupOf(rows, a.live && b.live), pattern: a.pattern ?? b.pattern }, ...older.slice(1)];
}

/**
 * The tape: trades from the live stream newer than the page (folded here by the page's rule), then the page's
 * groups. Without a page (the server does not serve the tape yet, or it has not answered) the tape is the live
 * stream's trades alone, and `fromStream` says so.
 */
export function tapeOf(page: TradesResponse | null, liveFlows: Flow[], opts: Partial<FoldRule> & { maker?: string | null; max: number }): { groups: TapeGroup[]; streamed: number; fromStream: boolean } {
  const newest = page?.rows.reduce((m, r) => Math.max(m, r.ts), -Infinity) ?? -Infinity;
  const ids = new Set(page?.rows.map((r) => r.id) ?? []);
  const live = liveFlows
    .map(tradeOfFlow)
    .filter((r): r is TradeRow => !!r && !ids.has(r.id) && r.ts > newest && (!opts.maker || r.maker === opts.maker))
    .sort((a, b) => b.ts - a.ts || b.height - a.height);
  const rule = foldRuleOf(page, opts);
  const groups = joinGroups(foldTrades(live, rule, true), page ? groupsOfPage(page) : [], rule);
  return { groups: groups.slice(0, opts.max), streamed: live.length, fromStream: !page };
}

// ---------------------------------------------------------------- the header's derived figures (screener-plan 2.7)

/** All NAM at today's price: every NAM in existence at the quoted price. null when an input is missing. */
export const allNamValue = (total: number | null | undefined, price: number | null | undefined) => (fin(total) && fin(price) && total > 0 && price > 0 ? total * price : null);

/** Spendable NAM at today's price: NAM in ordinary accounts on Namada plus NAM on Osmosis, at the quoted price. */
export const spendableValue = (liquid: number | null | undefined, onOsmosis: number | null | undefined, price: number | null | undefined) =>
  fin(liquid) && fin(onOsmosis) && fin(price) && price > 0 ? (liquid + onOsmosis) * price : null;

/** The share of the pools' depth that traded in a window, percent; null without both figures. */
export const turnoverPct = (usd: number | null | undefined, depthUsd: number | null | undefined) => (fin(usd) && fin(depthUsd) && depthUsd > 0 ? (usd / depthUsd) * 100 : null);

/** How far the price now is above (+) or below (−) what a window's buyers paid on average, percent. */
export const vsPaidPct = (now: number | null | undefined, paid: number | null | undefined) => (fin(now) && fin(paid) && paid > 0 ? ((now - paid) / paid) * 100 : null);

/** The windows "What recent buyers paid" reads, in order (screener-plan 3.5a; the answer covers at most 30 days). */
export const PAID_WINDOWS: readonly VolumeWindow[] = ['h24', 'd7', 'd30'];

/** A window with at least one trade, and its average prices; null when the window is not covered. */
export const paidRow = (v: ExecutedVolume | null | undefined) => (v ? { buys: v.buys, sells: v.sells, buyers: v.buyers, sellers: v.sellers, buyNam: v.buyNam, sellNam: v.sellNam, buyPaid: v.buyVwapUsd, sellGot: v.sellVwapUsd, how: v.tradersHow } : null);

/** A rule's span in words: "10 minutes", "24 hours", "7 days" (the number and its unit joined by a no-break space). */
export function durationWords(ms: number): string {
  if (!(ms > 0) || !Number.isFinite(ms)) return 'a moment';
  const nb = '\u00a0';
  if (ms < 3_600_000) {
    const m = Math.max(1, Math.round(ms / 60_000));
    return m === 1 ? 'a minute' : `${m}${nb}minutes`;
  }
  if (ms < 2 * DAY_MS) {
    const h = Math.round(ms / 3_600_000);
    return h === 1 ? 'an hour' : `${h}${nb}hours`;
  }
  const d = Math.round(ms / DAY_MS);
  return `${d}${nb}days`;
}

/** A provenance whose status is no data, with the reason (for a figure whose route does not answer). */
export const missingProv = (source: string, note: string, plain?: string): Provenance & { plain?: string } => ({ source, at: null, status: 'missing', note, ...(plain ? { plain } : {}) });
