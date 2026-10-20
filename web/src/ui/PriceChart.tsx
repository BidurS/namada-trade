// PriceChart (system.md 7.2): the Trade chart block. Custom SVG measured in CSS px with
// ResizeObserver (ticks are always 11 px), 1-2-5 ticks (4 to 5 on y) with the y labels in a
// left gutter outside the plot, the executed price solid in ink, the quoted price dashed in
// ink-3 (never buy/sell colours), dashed event markers with labels of 12 characters or fewer
// above the plot, a last-value pill in --c-mark, press-and-drag (or arrow keys) reading the
// nearest executed point into a fixed readout above the plot, a visible Low/High/Last/Quoted
// strip, sparse data said in words, one SourceLine naming each series with its own age, and a
// visually hidden text fallback (first, lowest, highest, last). Two points draw as dots.
//
// Each executed point is the median price of one hour's swaps. Up to the 30-day range the
// server sends every such hour, so the chart can count the hours without a trade; on 90d, 1y
// and All it thins the series (chartConst.ts HOURLY_HISTORY_DAYS), so the chart says how many
// points it joins and that a gap is not an hour without a trade, never a count it cannot know.
import React, { useMemo, useState } from 'react';
import type { Stamp } from '../lib/prov';
import { fmtAgo, fmtDayClock, fmtDayMonth, fmtUsdRule, fmtUtcClock } from '../lib/format';
import { hoursWithData, lin, nearestIndex, niceTicks, pathOf, stackLabels, takeaway, tickLabel } from './chartMath';
import { DAY_MS, FEW_POINTS, HOUR_MS, HOURLY_HISTORY_DAYS, SPARSE_SHARE, spanWords } from './chartConst';
import { useSize } from './useSize';
import { Segmented } from './Segmented';
import { SourceLine } from './SourceLine';
import { useUiNow } from './now';
import { Price } from './Num';

export type ChartRange = '24h' | '7d' | '30d' | '90d' | '1y' | 'all';
export interface SeriesPoint {
  t: number;
  v: number;
}
export interface ChartEvent {
  t: number;
  /** 12 characters or fewer ("+35.7%"); longer labels are cut. */
  label: string;
}

export interface PriceChartProps {
  series: { executed: SeriesPoint[]; quoted?: SeriesPoint[] };
  events?: ChartEvent[];
  range: ChartRange;
  onRange?: (r: ChartRange) => void;
  /** The window end (now, or the rewound time). Default: the last point. */
  end?: number;
  /** A cursor at the rewound time (?at=). */
  cursorAt?: number | null;
  /** Stamps for the SourceLine: executed swaps and the quoted price. */
  prov?: { executed?: Stamp | null; quoted?: Stamp | null };
  /** Heading id/level; the title is the takeaway computed from the series unless given. */
  title?: string;
  headingId?: string;
  level?: 2 | 3;
  /** `shielded`: one series in --shielded, the unit and stats say NAM (Shielded screen). */
  variant?: 'price' | 'shielded';
  /** Unit sentence after the title (default: the unit, what a point is, and the count). */
  unit?: React.ReactNode;
  /**
   * The server's point spacing when the screen knows it (the history answer's bucketMs). Without it the
   * chart takes a range up to HOURLY_HISTORY_DAYS as hourly and a longer one as thinned.
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

export function PriceChart({ series, events = [], range, onRange, end, cursorAt, prov, title, headingId, level = 2, variant = 'price', unit, bucketMs, className = '' }: PriceChartProps) {
  const now = useUiNow();
  const [boxRef, { w, h }] = useSize<HTMLDivElement>();
  const [pick, setPick] = useState<number | null>(null);

  const exec = useMemo(() => [...(series.executed ?? [])].filter((p) => Number.isFinite(p.v) && Number.isFinite(p.t)).sort((a, b) => a.t - b.t), [series.executed]);
  const quoted = useMemo(() => [...(series.quoted ?? [])].filter((p) => Number.isFinite(p.v) && Number.isFinite(p.t)).sort((a, b) => a.t - b.t), [series.quoted]);
  const tEnd = end ?? Math.max(exec[exec.length - 1]?.t ?? 0, quoted[quoted.length - 1]?.t ?? 0, 0);
  const earliest = Math.min(exec[0]?.t ?? Infinity, quoted[0]?.t ?? Infinity);
  const spanMs = RANGE_MS[range];
  const tStart = spanMs != null ? tEnd - spanMs : Number.isFinite(earliest) ? Math.min(earliest, tEnd - 86_400_000) : tEnd - 30 * 86_400_000;
  const actualSpan = Math.max(86_400_000, tEnd - tStart);
  const E = exec.filter((p) => p.t >= tStart && p.t <= tEnd);
  const Q = quoted.filter((p) => p.t >= tStart && p.t <= tEnd);
  const isPrice = variant === 'price';
  const fmtV = (v: number) => (isPrice ? fmtUsdRule(v) : `${Math.round(v).toLocaleString('en-US')} NAM`);

  // ---------------- scales ----------------
  const all = [...E, ...Q].map((p) => p.v);
  const yT = all.length ? niceTicks(Math.min(...all), Math.max(...all), { maxTicks: 5 }) : niceTicks(0, 1);
  const yLabels = yT.ticks.map((t) => (isPrice ? tickLabel(t, yT.step) : compactNam(t)));
  const L = Math.ceil(Math.max(...yLabels.map((s) => s.length)) * CHAR) + 14;
  const R = 10;
  const evIn = events.filter((e) => e.t >= tStart && e.t <= tEnd).slice(0, 3);
  const X = lin(tStart, tEnd, L, Math.max(L + 1, w - R));
  const evRows = stackLabels(evIn.map((e) => ({ x: X(e.t), text: e.label.slice(0, 12) })), CHAR);
  const T = 26 + Math.max(0, ...evRows) * 14;
  const B = 26;
  const Y = lin(yT.lo, yT.hi, Math.max(T + 1, h - B), T);
  const ePts = E.map((p) => [X(p.t), Y(p.v)] as [number, number]);
  const qPts = Q.map((p) => [X(p.t), Y(p.v)] as [number, number]);
  const xTicks = [tStart + actualSpan * (1 / 24), tStart + actualSpan / 2, tEnd];
  const longSpan = actualSpan > 200 * 86_400_000;
  const xFmt = (t: number) => (range === '24h' ? fmtUtcClock(t).replace(' UTC', '') : longSpan ? monthYear(t) : fmtDayMonth(t));

  // ---------------- readout ----------------
  const last = E[E.length - 1] ?? null;
  const sel = pick != null && E[pick] ? E[pick] : null;
  const shown = sel ?? last;
  const setFromX = (clientX: number, el: Element) => {
    if (!E.length) return;
    const r = el.getBoundingClientRect();
    setPick(nearestIndex(ePts.map((p) => p[0]), clientX - r.left));
  };

  // ---------------- words ----------------
  const first = E[0] ?? null;
  const low = E.length ? E.reduce((a, b) => (b.v < a.v ? b : a)) : null;
  const high = E.length ? E.reduce((a, b) => (b.v > a.v ? b : a)) : null;
  const lastQ = Q[Q.length - 1] ?? null;
  const heading = title ?? takeaway(first?.v, last?.v, fmtDayMonth(first?.t), isPrice ? 'Price paid in trades' : 'Shielded NAM') ?? (E.length ? (isPrice ? 'Price paid in trades' : 'Shielded NAM') : isPrice ? 'No trades in this window' : 'No readings in this window');
  const hours = Math.max(1, Math.round(actualSpan / HOUR_MS));
  const withTrades = hoursWithData(E.map((p) => p.t));
  // every hour with a trade is a point only while the server sends the series hour by hour
  const hourly = bucketMs != null ? bucketMs <= HOUR_MS : spanMs != null && spanMs <= HOURLY_HISTORY_DAYS * DAY_MS;
  const H = level === 3 ? 'h3' : 'h2';
  const unitLine = unit ?? (isPrice ? (
    <>USDC paid per NAM in real trades: each point is the middle price of one hour’s trades, <span data-num="">{E.length}</span> {E.length === 1 ? 'point' : 'points'}.</>
  ) : (
    <>NAM in the shielded set, <span data-num="">{E.length}</span> {E.length === 1 ? 'reading' : 'readings'}.</>
  ));
  const fewQuoted = Q.length && Q.length < FEW_POINTS ? <>, and the quoted line has only <span data-num="">{Q.length}</span> {Q.length === 1 ? 'point' : 'points'} so far</> : null;

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
            <span className="readout__k">{sel ? (isPrice ? 'Trade price' : 'Reading') : isPrice ? 'Last trade' : 'Last reading'}</span>{' '}
            <b data-num="" className="readout__v">{isPrice ? <Price v={shown.v} /> : fmtV(shown.v)}</b>{' '}
            <span className="readout__t">{fmtDayClock(shown.t)}</span>
          </>
        ) : (
          <span className="readout__k">{isPrice ? 'No trade in this window.' : 'No reading in this window.'}</span>
        )}
      </p>

      <div
        ref={boxRef}
        className={`chart-box${isPrice ? '' : ' chart-box--sm'}`}
        tabIndex={E.length ? 0 : -1}
        role="group"
        aria-label={E.length ? `${heading}. Press and drag, or use the arrow keys, to read a point.` : heading}
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
          if (!E.length) return;
          const i = pick ?? E.length - 1;
          if (e.key === 'ArrowLeft') setPick(Math.max(0, i - 1));
          else if (e.key === 'ArrowRight') setPick(Math.min(E.length - 1, i + 1));
          else if (e.key === 'Home') setPick(0);
          else if (e.key === 'End') setPick(E.length - 1);
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
                <line className="c-evt" x1={X(e.t)} x2={X(e.t)} y1={T - 6} y2={h - B} />
                <text className="c-evtl" x={X(e.t) + 4} y={14 + evRows[i] * 14} textAnchor={X(e.t) + 4 + e.label.slice(0, 12).length * CHAR > w ? 'end' : 'start'}>{e.label.slice(0, 12)}</text>
              </g>
            ))}
            {atX != null ? <line className="c-at" x1={atX} x2={atX} y1={T} y2={h - B} /> : null}
            {isPrice && qPts.length > 1 ? <path className="c-quote" d={pathOf(qPts)} /> : null}
            {isPrice ? qPts.map(([x, y], i) => <circle key={`q${i}`} className="c-quote-dot" cx={x} cy={y} r={2.5} />) : null}
            {ePts.length > 2 ? (
              <g className="c-wipe">
                <path className={isPrice ? 'c-exec' : 'c-shielded'} d={pathOf(ePts)} />
              </g>
            ) : null}
            {ePts.length <= 60 ? ePts.map(([x, y], i) => <circle key={`e${i}`} className={isPrice ? 'c-exec-dot' : 'c-shielded-dot'} cx={x} cy={y} r={ePts.length <= 2 ? 3.5 : 2} />) : null}
            {pill && !sel ? (
              <g className="c-pill">
                <rect x={pill.px} y={pill.py} width={pill.pw} height={20} rx={10} />
                <text x={pill.px + pill.pw / 2} y={pill.py + 14} textAnchor="middle">{pill.txt}</text>
              </g>
            ) : null}
            {cur ? (
              <>
                <line className="c-cursor" x1={cur[0]} x2={cur[0]} y1={T} y2={h - B} />
                <circle className="c-cursor-dot" cx={cur[0]} cy={cur[1]} r={5} />
              </>
            ) : null}
          </svg>
        ) : null}
      </div>

      <ul className="key">
        <li><i className="key__ln" />{isPrice ? 'Price paid in trades' : 'Shielded NAM'}</li>
        {isPrice && Q.length ? <li><i className="key__ln key__ln--dash" />Price the pools quote, recorded since <span data-num="">{fmtDayMonth(quoted[0]?.t)}</span></li> : null}
        {/* each marker is a move between two hours that had trades (generated/events.ts), not always one hour apart */}
        {evIn.length ? <li><i className="key__ln key__ln--evt" />Dashed lines: the {evIn.length === 1 ? 'biggest move' : `${evIn.length} biggest moves`} from one hour with trades to the next</li> : null}
      </ul>

      <dl className="cstats">
        <div><dt>Low</dt><dd data-num="">{low ? <>{fmtV(low.v)}<small>{fmtDayMonth(low.t)}</small></> : '—'}</dd></div>
        <div><dt>High</dt><dd data-num="">{high ? <>{fmtV(high.v)}<small>{fmtDayMonth(high.t)}</small></> : '—'}</dd></div>
        <div><dt>{isPrice ? 'Last trade price' : 'Last reading'}</dt><dd data-num="">{last ? <>{fmtV(last.v)}<small>{fmtAgo(last.t, now)}</small></> : '—'}</dd></div>
        {isPrice ? <div><dt>Pools quote now</dt><dd data-num="">{lastQ ? <>{fmtV(lastQ.v)}<small>{fmtAgo(lastQ.t, now)}</small></> : '—'}</dd></div> : null}
      </dl>

      {isPrice && E.length ? (
        <p className="cap">
          {lastQ ? 'A quote is what the pools offer now; a trade price is what someone actually paid. ' : null}
          {hourly ? (
            withTrades < hours * SPARSE_SHARE ? (
              <>Trades are sparse: only <span data-num="">{withTrades}</span> of the <span data-num="">{hours}</span> hours since {fmtDayMonth(tStart)} had one, so the line joins the hours that did{fewQuoted}.</>
            ) : (
              <><span data-num="">{withTrades}</span> of the <span data-num="">{hours}</span> hours since {fmtDayMonth(tStart)} had a trade{fewQuoted}.</>
            )
          ) : (
            <>At this range the server keeps {bucketMs != null && bucketMs > HOUR_MS ? `at most one point per ${spanWords(bucketMs)}` : 'fewer points'}: the line joins the <span data-num="">{E.length}</span> since {fmtDayMonth(first?.t)}, and a gap is not an hour without a trade{fewQuoted}.</>
          )}
          {E.length <= 2 ? ' With this few points the dots are shown without a line.' : ''}
          {/* an old stamp says why, in the chart's own words */}
          {prov?.executed?.status === 'stale' && prov.executed.at != null ? <> The trade line reads old: its last hour with a trade began {fmtAgo(prov.executed.at, now)}.</> : null}
        </p>
      ) : null}

      {/* the stamps arrive with the overview: until then the line's height is held, so nothing shifts when they land */}
      {scope.length ? <SourceLine items={scope} label={isPrice ? 'Where the chart comes from' : 'Where the readings come from'} /> : <p className="src src--wait" aria-hidden="true" />}

      {first && low && high && last ? (
        <p className="sr-only">
          First {isPrice ? 'executed price' : 'reading'} {fmtV(first.v)}, lowest {fmtV(low.v)}, highest {fmtV(high.v)}, last {fmtV(last.v)}.
        </p>
      ) : null}
    </section>
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
