// PriceChart (system.md 7.2, screener-plan 2.6): the Trade chart block. Custom SVG measured in CSS px with
// ResizeObserver (ticks are always 11 px), 1-2-5 ticks (4 to 5 on y) with the y labels in a left gutter outside
// the plot, dashed event markers with labels of 12 characters or fewer above the plot, a last-value pill in
// --c-mark, press-and-drag (or arrow keys) reading the nearest point into a fixed readout above the plot, a
// visible Low/High/Last/Quoted strip, sparse data said in words, one SourceLine naming each series with its own
// age, the date each series honestly starts printed under the chart (screener-plan 3.9), and a visually hidden
// text fallback (first, lowest, highest, last).
//
// The series, never candles (no trades, no candle):
// - executed: the middle price of each hour's swaps, solid ink. Each is a dot; two dots are joined only when
//   they are adjacent steps (both hours traded), so one 105 NAM buy never reads as a flat line;
// - quoted: the price the pools quote, dashed --c-ink-3, broken where the record has no reading, with its
//   lowest and highest quote in each hour as a 12% --c-ink-3 band (24h, 7d, 30d);
// - pool: the Osmosis data API's pool price on 90d, 1y and All, a thin --c-ink-3 line labelled "pool price,
//   not trades", with the steps in which no trade moved the pool as short marks on the plot's floor;
// - bars: NAM traded in each hour, in a strip under the plot with its own y scale from zero (one axis per
//   plot, never a second axis on the price plot); an empty hour is an empty slot.
// All price series are dollars per NAM on one axis. Never buy or sell hues on a series.
//
// Up to the 30-day range (and 90 days when the series answer is hourly) every hour with a trade is a point, so
// the chart counts the hours without one; on a thinned range it says how many points it shows and that a gap
// is not an hour without a trade, never a count it cannot know.
import React, { useMemo, useState } from 'react';
import type { Stamp } from '../lib/prov';
import { fmtAgo, fmtCount, fmtDayClock, fmtDayMonth, fmtDayMonthYear, fmtNamRule, fmtUsdRule, fmtUtcClock } from '../lib/format';
import { hoursWithData, lin, nearestIndex, niceTicks, pathOf, stackLabels, takeaway, tickLabel } from './chartMath';
import { DAY_MS, FEW_POINTS, HOUR_MS, HOURLY_HISTORY_DAYS, SPARSE_SHARE, spanWords, spansWords } from './chartConst';
import { useSize } from './useSize';
import { Segmented } from './Segmented';
import { SourceLine } from './SourceLine';
import { useUiNow } from './now';
import { Price } from './Num';
import { BarsPlot, barsScale, type BarPoint } from './Bars';

export type ChartRange = '24h' | '7d' | '30d' | '90d' | '1y' | 'all';
export interface SeriesPoint {
  /** the start of the point's step */
  t: number;
  v: number;
  /** the newest reading's own time in the step, when it is not the step's start: ages and the last point's time read it */
  at?: number;
}
/** When a point's reading was taken: its own time, else the step's start. */
const readAt = (p: SeriesPoint) => (p.at != null && Number.isFinite(p.at) ? p.at : p.t);
export interface ChartEvent {
  t: number;
  /** 12 characters or fewer ("+35.7%"); longer labels are cut. */
  label: string;
}
export type { BarPoint };
/** The quoted price's lowest and highest reading in one step. */
export interface BandPoint {
  t: number;
  lo: number;
  hi: number;
}
/** When one series honestly starts (printed under the chart); `at` null: not known, `why` says so. */
export interface ChartStart {
  what: string;
  at: number | null;
  backfilled?: boolean;
  why?: string;
}

export interface PriceChartProps {
  /** executed, quoted and (long ranges) the pool price, each oldest first, dollars per NAM */
  series: { executed: SeriesPoint[]; quoted?: SeriesPoint[]; pool?: SeriesPoint[] };
  /** hourly executed volume under the plot; absent hours are drawn empty. Short ranges only. */
  bars?: BarPoint[] | null;
  /** the bars' step (default one hour) */
  barsStepMs?: number | null;
  /** why the bars are not drawn (the route does not answer): said in the key with "—" */
  barsMissing?: string | null;
  /** the quoted price's lo/hi per hour, drawn as a band. Short ranges only. */
  band?: BandPoint[];
  /** pool steps with open = high = low = close, drawn as short marks on the plot's floor */
  flatHours?: number[];
  /** the pool series' step (it says "one close per 6 hours") */
  poolStepMs?: number | null;
  /** why the pool price is not drawn on a long range: said in the key with "—" */
  poolMissing?: string | null;
  /** the date each series begins, printed under the chart */
  starts?: ChartStart[];
  /** the executed series' honest start: hours before it are not counted as hours without a trade */
  executedStart?: number | null;
  events?: ChartEvent[];
  range: ChartRange;
  onRange?: (r: ChartRange) => void;
  /** The window end (now, or the rewound time). Default: the last point. */
  end?: number;
  /** A cursor at the rewound time (?at=). */
  cursorAt?: number | null;
  /** Stamps for the SourceLine: executed swaps, the quoted price, the pool price and the hourly volume. */
  prov?: { executed?: Stamp | null; quoted?: Stamp | null; pool?: Stamp | null; bars?: Stamp | null };
  /** Heading id/level; the title is the takeaway computed from the series unless given. */
  title?: string;
  headingId?: string;
  level?: 2 | 3;
  /** `shielded`: one series in --shielded, the unit and stats say NAM (Shielded screen). */
  variant?: 'price' | 'shielded';
  /** Unit sentence after the title (default: the unit, what a point is, and the count). */
  unit?: React.ReactNode;
  /**
   * The server's point spacing when the screen knows it (the history answer's bucketMs or the series answer's
   * stepMs). Without it the chart takes a range up to HOURLY_HISTORY_DAYS as hourly and a longer one as thinned.
   */
  bucketMs?: number | null;
  className?: string;
}

export const RANGE_MS: Record<ChartRange, number | null> = {
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
  '90d': 90 * 86_400_000,
  '1y': 365 * 86_400_000,
  'all': null,
};
/** Six pills; under 640 px charts.css tightens their padding so they fit a 343 px column. */
export const RANGES: { value: ChartRange; label: string }[] = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: '90d', label: '90d' },
  { value: '1y', label: '1y' },
  { value: 'all', label: 'All' },
];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthYear = (t: number) => `${MON[new Date(t).getUTCMonth()]} ${new Date(t).getUTCFullYear()}`;

const CHAR = 6.6; // JetBrains Mono at 11 px: 0.6 em advance
/** The volume strip under the plot: its height and the gap above it (px). */
const BARS_H = 40;
const BARS_GAP = 18;
/** Executed dots are drawn up to this many points; above it (long thinned ranges) the adjacent pairs carry the series. */
const DOT_MAX = 600;

/** Runs of points split where the next is more than `gapMs` later: a line never crosses a stretch with no reading. */
function runs<T extends { t: number }>(pts: T[], gapMs: number): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  for (const p of pts) {
    if (cur.length && p.t - cur[cur.length - 1].t > gapMs) {
      out.push(cur);
      cur = [];
    }
    cur.push(p);
  }
  if (cur.length) out.push(cur);
  return out;
}

const clean = <T extends { t: number }>(list: T[] | undefined, ok: (p: T) => boolean) => [...(list ?? [])].filter((p) => Number.isFinite(p.t) && ok(p)).sort((a, b) => a.t - b.t);

export function PriceChart({
  series, bars, barsStepMs, barsMissing, band, flatHours, poolStepMs, poolMissing, starts, executedStart,
  events = [], range, onRange, end, cursorAt, prov, title, headingId, level = 2, variant = 'price', unit, bucketMs, className = '',
}: PriceChartProps) {
  const now = useUiNow();
  const [boxRef, { w, h }] = useSize<HTMLDivElement>();
  const [pick, setPick] = useState<number | null>(null);

  const exec = useMemo(() => clean(series.executed, (p) => Number.isFinite(p.v)), [series.executed]);
  const quoted = useMemo(() => clean(series.quoted, (p) => Number.isFinite(p.v)), [series.quoted]);
  const pool = useMemo(() => clean(series.pool, (p) => Number.isFinite(p.v)), [series.pool]);
  const bandPts = useMemo(() => clean(band, (p) => Number.isFinite(p.lo) && Number.isFinite(p.hi)), [band]);
  const barPts = useMemo(() => clean(bars ?? undefined, (b) => Number.isFinite(b.nam)), [bars]);
  const tEnd = end ?? Math.max(exec[exec.length - 1]?.t ?? 0, quoted[quoted.length - 1]?.t ?? 0, pool[pool.length - 1]?.t ?? 0, 0);
  const earliest = Math.min(exec[0]?.t ?? Infinity, quoted[0]?.t ?? Infinity, pool[0]?.t ?? Infinity);
  const spanMs = RANGE_MS[range];
  const tStart = spanMs != null ? tEnd - spanMs : Number.isFinite(earliest) ? Math.min(earliest, tEnd - 86_400_000) : tEnd - 30 * 86_400_000;
  const actualSpan = Math.max(86_400_000, tEnd - tStart);
  const inWin = <T extends { t: number }>(p: T) => p.t >= tStart && p.t <= tEnd;
  const E = exec.filter(inWin);
  const Q = quoted.filter(inWin);
  const P = pool.filter(inWin);
  const BD = bandPts.filter(inWin);
  const isPrice = variant === 'price';
  const fmtV = (v: number) => (isPrice ? fmtUsdRule(v) : `${Math.round(v).toLocaleString('en-US')} NAM`);
  const stepMs = bucketMs != null && bucketMs > 0 ? bucketMs : HOUR_MS;
  const bStep = barsStepMs != null && barsStepMs > 0 ? barsStepMs : HOUR_MS;
  const showBars = isPrice && bars != null;
  const flats = useMemo(() => (flatHours ?? []).filter((t) => Number.isFinite(t) && t >= tStart && t <= tEnd), [flatHours, tStart, tEnd]);
  const pStep = poolStepMs != null && poolStepMs > 0 ? poolStepMs : HOUR_MS;

  // ---------------- scales ----------------
  const all = [...E, ...Q, ...P].map((p) => p.v).concat(BD.flatMap((b) => [b.lo, b.hi]));
  const yT = all.length ? niceTicks(Math.min(...all), Math.max(...all), { maxTicks: 5 }) : niceTicks(0, 1);
  const yLabels = yT.ticks.map((t) => (isPrice ? tickLabel(t, yT.step) : compactNam(t)));
  const barsSc = showBars ? barsScale(barPts, tStart, tEnd, bStep) : null;
  const L = Math.ceil(Math.max(...yLabels.map((s) => s.length), barsSc ? barsSc.label.length : 0) * CHAR) + 14;
  const R = 10;
  const evIn = events.filter((e) => e.t >= tStart && e.t <= tEnd).slice(0, 3);
  const X = lin(tStart, tEnd, L, Math.max(L + 1, w - R));
  const evRows = stackLabels(evIn.map((e) => ({ x: X(e.t), text: e.label.slice(0, 12) })), CHAR);
  const T = 26 + Math.max(0, ...evRows) * 14;
  const B = 26;
  const plotBottom = Math.max(T + 1, h - B - (showBars ? BARS_H + BARS_GAP : 0));
  const Y = lin(yT.lo, yT.hi, plotBottom, T);
  const ePts = E.map((p) => [X(p.t), Y(p.v)] as [number, number]);
  const xTicks = [tStart + actualSpan * (1 / 24), tStart + actualSpan / 2, tEnd];
  const longSpan = actualSpan > 200 * 86_400_000;
  const xFmt = (t: number) => (range === '24h' ? fmtUtcClock(t).replace(' UTC', '') : longSpan ? monthYear(t) : fmtDayMonth(t));
  // the executed series is joined only between adjacent steps (both traded); the quoted and pool lines break at gaps
  const execPairs: [[number, number], [number, number]][] = [];
  // (a shielded series is a reading on a clock, not a trade: it keeps one line)
  for (let i = 1; i < E.length; i++) if (!isPrice || E[i].t - E[i - 1].t <= stepMs * 1.01) execPairs.push([[X(E[i - 1].t), Y(E[i - 1].v)], [X(E[i].t), Y(E[i].v)]]);
  const qGap = Math.max(2 * HOUR_MS, 2 * (bucketMs ?? HOUR_MS));
  const qRuns = runs(Q, qGap);
  const pRuns = runs(P, 2 * pStep);
  const bandRuns = runs(BD, 2 * HOUR_MS);

  // ---------------- readout: the executed points, or on a long range with the pool price, the pool's ----------------
  const readPool = P.length > 0 && (spanMs == null || spanMs > 31 * DAY_MS);
  const R0 = readPool ? P : E;
  const last = E[E.length - 1] ?? null;
  const sel = pick != null && R0[pick] ? R0[pick] : null;
  const shown = sel ?? (readPool ? null : last);
  const setFromX = (clientX: number, el: Element) => {
    if (!R0.length) return;
    const r = el.getBoundingClientRect();
    setPick(nearestIndex(R0.map((p) => X(p.t)), clientX - r.left));
  };
  const barAt = (t: number) => (showBars ? barPts.find((b) => Math.floor(b.t / bStep) === Math.floor(t / bStep)) ?? null : null);
  // A picked point of a step longer than an hour is the whole step (a 6-hour span, a UTC day), never one clock time;
  // the last point is read at its newest reading's own time (the last hour that traded, the latest quote).
  const pickedWhen = (p: SeriesPoint, step: number) =>
    step >= DAY_MS ? `${fmtDayMonthYear(p.t)}, the UTC day` : step > HOUR_MS ? `the ${spanWords(step)} from ${fmtDayClock(p.t)}` : fmtDayClock(readAt(p));

  // ---------------- words ----------------
  const first = E[0] ?? null;
  const low = E.length ? E.reduce((a, b) => (b.v < a.v ? b : a)) : null;
  const high = E.length ? E.reduce((a, b) => (b.v > a.v ? b : a)) : null;
  const lastQ = Q[Q.length - 1] ?? null;
  const heading = title ?? takeaway(first?.v, last?.v, fmtDayMonth(first?.t), isPrice ? 'Price paid in trades' : 'Shielded NAM') ?? (E.length ? (isPrice ? 'Price paid in trades' : 'Shielded NAM') : isPrice ? 'No trades in this window' : 'No readings in this window');
  // hours are counted from the window's start, or from the series' honest start when it begins later
  const countFrom = executedStart != null && Number.isFinite(executedStart) && executedStart > tStart ? executedStart : tStart;
  const hours = Math.max(1, Math.round((tEnd - countFrom) / HOUR_MS));
  const withTrades = hoursWithData(E.map((p) => p.t));
  // every hour with a trade is a point only while the server sends the series hour by hour
  const hourly = bucketMs != null ? bucketMs <= HOUR_MS : spanMs != null && spanMs <= HOURLY_HISTORY_DAYS * DAY_MS;
  const H = level === 3 ? 'h3' : 'h2';
  const poolWords = isPrice && P.length ? (
    <> The thin line is the pool price, not trades: one close per {spanWords(pStep)} from Osmosis app data, <span data-num="">{fmtCount(P.length)}</span> {P.length === 1 ? 'point' : 'points'}.</>
  ) : null;
  const unitLine = unit ?? (isPrice ? (
    <>USDC paid per NAM in real trades: each point is the middle price of one hour’s trades, <span data-num="">{E.length}</span> {E.length === 1 ? 'point' : 'points'}.{poolWords}</>
  ) : (
    <>NAM in the shielded set, <span data-num="">{E.length}</span> {E.length === 1 ? 'reading' : 'readings'}.</>
  ));
  const fewQuoted = Q.length && Q.length < FEW_POINTS ? <>, and the quoted line has only <span data-num="">{Q.length}</span> {Q.length === 1 ? 'point' : 'points'} so far</> : null;
  const joined = execPairs.length;

  // A drawn series always has its SourceLine: when its stamp has not come (it arrives with the overview),
  // the line says the stamp is missing rather than leaving the figures unsourced (N1).
  const executedStamp: Stamp | null = prov?.executed ?? (E.length ? {
    source: isPrice ? 'executed NAM/USDC swaps (hourly median)' : 'namada-rpc',
    at: null,
    status: 'missing',
    note: 'The time stamp of this series comes with the site overview, which has not arrived, so its age is not known.',
  } : null);
  const scope = [
    ...(executedStamp ? [{ label: isPrice ? 'Executed price (swaps)' : 'Shielded NAM', p: executedStamp }] : []),
    ...(prov?.quoted && isPrice ? [{ label: 'Quoted price', p: prov.quoted }] : []),
    ...(prov?.bars && isPrice && showBars ? [{ label: 'NAM traded per hour', p: prov.bars }] : []),
    ...(prov?.pool && isPrice && P.length ? [{ label: 'Pool price (not trades)', p: prov.pool }] : []),
  ];

  // last-value pill
  const pill = last && w > 0 ? (() => {
    const txt = isPrice ? fmtUsdRule(last.v).replace('$', '') : compactNam(last.v);
    const pw = txt.length * CHAR + 16;
    const [lx, ly] = [X(last.t), Y(last.v)];
    const px = Math.min(w - R - pw, Math.max(L, lx - pw - 6));
    const py = ly - 30 < T ? ly + 10 : ly - 30;
    return { txt, pw, px, py };
  })() : null;

  const cur = sel ? [X(sel.t), Y(sel.v)] : null;
  const atX = cursorAt != null && cursorAt >= tStart && cursorAt <= tEnd ? X(cursorAt) : null;
  const shownBar = shown && !readPool ? barAt(shown.t) : null;

  return (
    <section className={`chartsec ${className}`} aria-labelledby={headingId} data-prov-scope="">
      <div className="chartsec__top">
        <div className="chartsec__title">
          <H id={headingId} className="chartsec__h">{heading}</H>
          <p className="cap">{unitLine}</p>
        </div>
        {onRange ? <Segmented label="Chart range" variant="range" value={range} options={RANGES} onChange={onRange} /> : null}
      </div>

      <p className="readout" aria-live="polite">
        {shown ? (
          <>
            <span className="readout__k">{readPool ? 'Pool price, not a trade' : sel ? (isPrice ? 'Trade price' : 'Reading') : isPrice ? 'Last trade' : 'Last reading'}</span>{' '}
            <b data-num="" className="readout__v">{isPrice ? <Price v={shown.v} /> : fmtV(shown.v)}</b>{' '}
            <span className="readout__t">{sel ? pickedWhen(sel, readPool ? pStep : stepMs) : fmtDayClock(readAt(shown))}</span>
            {shownBar ? <span className="readout__t"> · <span data-num="">{fmtNamRule(shownBar.nam)}</span> NAM traded that hour</span> : null}
          </>
        ) : readPool && last ? (
          <>
            <span className="readout__k">Last trade</span>{' '}
            <b data-num="" className="readout__v"><Price v={last.v} /></b>{' '}
            <span className="readout__t">{fmtDayClock(readAt(last))}</span>
          </>
        ) : (
          <span className="readout__k">{isPrice ? 'No trade in this window.' : 'No reading in this window.'}</span>
        )}
      </p>

      <div
        ref={boxRef}
        className={`chart-box${isPrice ? '' : ' chart-box--sm'}${showBars ? ' chart-box--bars' : ''}`}
        tabIndex={R0.length ? 0 : -1}
        role="group"
        aria-label={R0.length ? `${heading}. Press and drag, or use the arrow keys, to read a point.` : heading}
        data-exec={E.length}
        data-joined={joined}
        data-pool={P.length}
        data-flat={flats.length}
        onPointerDown={(e) => {
          if (e.pointerType === 'mouse' && e.button !== 0) return;
          setFromX(e.clientX, e.currentTarget);
        }}
        onPointerMove={(e) => {
          if (e.pointerType === 'mouse' || e.buttons) setFromX(e.clientX, e.currentTarget);
        }}
        onPointerLeave={(e) => {
          if (e.pointerType === 'mouse') setPick(null);
        }}
        onPointerUp={(e) => {
          if (e.pointerType !== 'mouse') setPick(null);
        }}
        onPointerCancel={() => setPick(null)}
        onKeyDown={(e) => {
          if (!R0.length) return;
          const i = pick ?? R0.length - 1;
          if (e.key === 'ArrowLeft') setPick(Math.max(0, i - 1));
          else if (e.key === 'ArrowRight') setPick(Math.min(R0.length - 1, i + 1));
          else if (e.key === 'Home') setPick(0);
          else if (e.key === 'End') setPick(R0.length - 1);
          else if (e.key === 'Escape') setPick(null);
          else return;
          e.preventDefault();
        }}
        onBlur={() => setPick(null)}
      >
        {w > 0 && h > 0 ? (
          <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
            {yT.ticks.map((t, i) => (
              <g key={t}>
                <line className="c-grid" x1={L} x2={w - R} y1={Y(t)} y2={Y(t)} />
                <text className="c-tick" x={L - 8} y={Y(t) + 4} textAnchor="end">{yLabels[i]}</text>
              </g>
            ))}
            {xTicks.map((t, i) => (
              <text key={i} className="c-tick" x={X(t)} y={h - 6} textAnchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}>{xFmt(t)}</text>
            ))}
            {evIn.map((e, i) => (
              <g key={`${e.t}-${i}`}>
                <line className="c-evt" x1={X(e.t)} x2={X(e.t)} y1={T - 6} y2={plotBottom} />
                <text className="c-evtl" x={X(e.t) + 4} y={14 + evRows[i] * 14} textAnchor={X(e.t) + 4 + e.label.slice(0, 12).length * CHAR > w ? 'end' : 'start'}>{e.label.slice(0, 12)}</text>
              </g>
            ))}
            {atX != null ? <line className="c-at" x1={atX} x2={atX} y1={T} y2={showBars ? h - B : plotBottom} /> : null}
            {/* the quoted price's lowest and highest quote in each hour, under every line */}
            {isPrice ? bandRuns.map((run, i) => (run.length > 1 ? (
              <path key={`b${i}`} className="c-band" d={`${pathOf(run.map((p) => [X(p.t), Y(p.hi)] as [number, number]))}L${[...run].reverse().map((p) => `${X(p.t).toFixed(1)} ${Y(p.lo).toFixed(1)}`).join('L')}Z`} />
            ) : null)) : null}
            {/* the pool price (long ranges): a thin line, broken where the record has no reading */}
            {isPrice ? pRuns.map((run, i) => (run.length > 1 ? <path key={`p${i}`} className="c-pool" d={pathOf(run.map((p) => [X(p.t), Y(p.v)] as [number, number]))} /> : <circle key={`p${i}`} className="c-pool-dot" cx={X(run[0].t)} cy={Y(run[0].v)} r={1.5} />)) : null}
            {/* steps in which no trade moved the pool: a short mark under the plot's floor, never a candle */}
            {isPrice && flats.length ? (
              <g className="c-flats">
                {flats.map((t) => <line key={t} className="c-flat" x1={X(t)} x2={X(t)} y1={plotBottom + 2} y2={plotBottom + 7} />)}
              </g>
            ) : null}
            {isPrice ? qRuns.map((run, i) => (run.length > 1 ? <path key={`q${i}`} className="c-quote" d={pathOf(run.map((p) => [X(p.t), Y(p.v)] as [number, number]))} /> : null)) : null}
            {isPrice && Q.length <= 60 ? Q.map((p, i) => <circle key={`qd${i}`} className="c-quote-dot" cx={X(p.t)} cy={Y(p.v)} r={2.5} />) : null}
            {isPrice && Q.length > 60 ? qRuns.filter((r) => r.length === 1).map((r, i) => <circle key={`qs${i}`} className="c-quote-dot" cx={X(r[0].t)} cy={Y(r[0].v)} r={2.5} />) : null}
            {execPairs.length ? (
              <g className="c-wipe">
                {execPairs.map(([a, b], i) => <path key={`j${i}`} className={isPrice ? 'c-exec' : 'c-shielded'} d={`M${a[0].toFixed(1)} ${a[1].toFixed(1)}L${b[0].toFixed(1)} ${b[1].toFixed(1)}`} />)}
              </g>
            ) : null}
            {ePts.length <= DOT_MAX ? ePts.map(([x, y], i) => <circle key={`e${i}`} className={isPrice ? 'c-exec-dot' : 'c-shielded-dot'} cx={x} cy={y} r={ePts.length <= 2 ? 3.5 : ePts.length > 200 ? 1.5 : 2.25} />) : null}
            {showBars ? (
              <BarsPlot bars={barPts} x={X} from={tStart} to={tEnd} stepMs={bStep} top={plotBottom + BARS_GAP} height={BARS_H} left={L} right={w - R} start={executedStart ?? null} pickT={shown && !readPool ? shown.t : null} />
            ) : null}
            {pill && !sel ? (
              <g className="c-pill">
                <rect x={pill.px} y={pill.py} width={pill.pw} height={20} rx={10} />
                <text x={pill.px + pill.pw / 2} y={pill.py + 14} textAnchor="middle">{pill.txt}</text>
              </g>
            ) : null}
            {cur ? (
              <>
                <line className="c-cursor" x1={cur[0]} x2={cur[0]} y1={T} y2={showBars ? h - B : plotBottom} />
                <circle className="c-cursor-dot" cx={cur[0]} cy={cur[1]} r={5} />
              </>
            ) : null}
          </svg>
        ) : null}
      </div>

      <ul className="key">
        <li><i className="key__ln key__dot" />{isPrice ? `Price paid in trades: a dot per ${hourly ? 'hour' : spanWords(stepMs)} with trades, joined only where the next one traded too` : 'Shielded NAM'}</li>
        {isPrice && Q.length ? <li><i className="key__ln key__ln--dash" />Price the pools quote, recorded since <span data-num="">{fmtDayMonth(quoted[0]?.t)}</span></li> : null}
        {isPrice && BD.length > 1 ? <li><i className="key__sw key__sw--band" />Shaded: the lowest and highest quote in each hour</li> : null}
        {isPrice && P.length ? <li><i className="key__ln key__ln--pool" />Pool price, not trades (Osmosis app data)</li> : null}
        {isPrice && flats.length ? <li><i className="key__ln key__ln--flat" />Short marks under the plot: <span data-num="">{fmtCount(flats.length)}</span> {spansWords(pStep)} in which no trade moved the pool</li> : null}
        {isPrice && poolMissing ? <li className="key__miss"><span data-num="" data-status="none">—</span> Pool price: {poolMissing}</li> : null}
        {showBars ? <li><i className="key__sw key__sw--bar" />Bars under the chart: NAM traded in each hour; an empty slot is an hour without a trade</li> : null}
        {isPrice && !showBars && barsMissing ? <li className="key__miss"><span data-num="" data-status="none">—</span> NAM traded per hour: {barsMissing}</li> : null}
        {/* each marker is a move between two hours that had trades (generated/events.ts), not always one hour apart */}
        {evIn.length ? <li><i className="key__ln key__ln--evt" />Dashed lines: the {evIn.length === 1 ? 'biggest move' : `${evIn.length} biggest moves`} from one hour with trades to the next</li> : null}
      </ul>

      <dl className="cstats">
        <div><dt>Low</dt><dd data-num="">{low ? <>{fmtV(low.v)}<small>{fmtDayMonth(low.t)}</small></> : '—'}</dd></div>
        <div><dt>High</dt><dd data-num="">{high ? <>{fmtV(high.v)}<small>{fmtDayMonth(high.t)}</small></> : '—'}</dd></div>
        <div><dt>{isPrice ? 'Last trade price' : 'Last reading'}</dt><dd data-num="">{last ? <>{fmtV(last.v)}<small>{fmtAgo(readAt(last), now)}</small></> : '—'}</dd></div>
        {isPrice ? <div><dt>Pools quote now</dt><dd data-num="">{lastQ ? <>{fmtV(lastQ.v)}<small>{fmtAgo(readAt(lastQ), now)}</small></> : '—'}</dd></div> : null}
      </dl>

      {isPrice && E.length ? (
        <p className="cap">
          {lastQ ? 'A quote is what the pools offer now; a trade price is what someone actually paid. ' : null}
          {hourly ? (
            withTrades < hours * SPARSE_SHARE ? (
              <>Trades are sparse: only <span data-num="">{withTrades}</span> of the <span data-num="">{hours}</span> hours since {fmtDayMonth(countFrom)} had one, so each is a dot, joined to the next only when that hour traded too{fewQuoted}.</>
            ) : (
              <><span data-num="">{withTrades}</span> of the <span data-num="">{hours}</span> hours since {fmtDayMonth(countFrom)} had a trade{fewQuoted}.</>
            )
          ) : (
            <>At this range the server keeps {bucketMs != null && bucketMs > HOUR_MS ? `at most one point per ${spanWords(bucketMs)}` : 'fewer points'}: the chart shows the <span data-num="">{E.length}</span> since {fmtDayMonth(first?.t)}, joined only between neighbouring points, and a gap is not an hour without a trade{fewQuoted}.</>
          )}
          {E.length <= 2 ? ' With this few points the dots are shown without a line.' : ''}
          {/* an old stamp says why, in the chart's own words */}
          {prov?.executed?.status === 'stale' && prov.executed.at != null ? <> The trade line reads old: its last hour with a trade began {fmtAgo(prov.executed.at, now)}.</> : null}
        </p>
      ) : null}

      {isPrice && starts?.length ? <StartLine starts={starts} /> : null}

      {/* the stamps arrive with the overview: until then the line's height is held, so nothing shifts when they land */}
      {scope.length ? <SourceLine items={scope} label={isPrice ? 'Where the chart comes from' : 'Where the readings come from'} /> : <p className="src src--wait" aria-hidden="true" />}

      {first && low && high && last ? (
        <p className="sr-only">
          First {isPrice ? 'executed price' : 'reading'} {fmtV(first.v)}, lowest {fmtV(low.v)}, highest {fmtV(high.v)}, last {fmtV(last.v)}.
          {P.length ? ` Pool price, not trades: ${fmtCount(P.length)} points from ${fmtDayMonthYear(P[0].t)}, last ${fmtV(P[P.length - 1].v)}.` : ''}
          {showBars ? ` NAM traded: ${barPts.filter(inWin).length} hours with trades in the window.` : ''}
        </p>
      ) : null}
    </section>
  );
}

/**
 * "Recorded since: executed price 12 Aug 2026; quoted price 15 Oct 2026." Starts that are not known are grouped by
 * their reason ("executed price and quoted price: — this server does not say when it begins yet").
 */
function StartLine({ starts }: { starts: ChartStart[] }) {
  const known = starts.filter((s) => s.at != null);
  const unknown = new Map<string, string[]>();
  for (const s of starts) if (s.at == null) unknown.set(s.why ?? 'not known', [...(unknown.get(s.why ?? 'not known') ?? []), s.what]);
  const and = (w: string[]) => (w.length <= 1 ? w.join('') : `${w.slice(0, -1).join(', ')} and ${w[w.length - 1]}`);
  const parts: React.ReactNode[] = [
    ...known.map((s) => (
      <span key={s.what} className="c-starts__i">
        {s.what} <span data-num="">{fmtDayMonthYear(s.at)}</span>
        {s.backfilled ? ' (filled in once from stored trades)' : ''}
      </span>
    )),
    ...[...unknown.entries()].map(([why, what]) => (
      <span key={why} className="c-starts__i">
        {and(what)}: <span data-num="" data-status="none">—</span> {why}
      </span>
    )),
  ];
  return (
    <p className="cap c-starts">
      <span className="c-starts__k">Recorded since:</span>{' '}
      {parts.map((p, i) => (
        <React.Fragment key={i}>
          {p}
          {i < parts.length - 1 ? '; ' : '.'}
        </React.Fragment>
      ))}{' '}
      Nothing is drawn before a series begins.
    </p>
  );
}

/** "50.7M", "341.9M", "980k" for NAM axis ticks. */
export function compactNam(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return `${+(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${+(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${+(v / 1e3).toFixed(0)}k`;
  return `${Math.round(v)}`;
}

export default PriceChart;
