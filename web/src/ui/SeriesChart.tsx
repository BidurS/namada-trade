// SeriesChart: one NAM series over time (the shielded set on Shielded, staked NAM on Supply).
//
// The PriceChart grammar (system.md 7.2) for a NAM series with any set of windows (including
// "All"): container-measured SVG (ticks exactly 11 px), 1-2-5 ticks with the y labels in a left
// gutter, a takeaway title, press-and-drag or arrow keys into a fixed readout, a last-value pill,
// a Low / High / Last strip, a hidden text summary and one SourceLine. `tone="shielded"` draws in
// --shielded (the Shielded screen only); `ink` in the ground's ink. PriceChart stays the price
// chart (executed and quoted series, event markers).
import { useMemo, useState } from 'react';
import type { Stamp } from '../lib/prov';
import { Segmented } from './Segmented';
import { SourceLine } from './SourceLine';
import { useSize } from './useSize';
import { useUiNow } from './now';
import { lin, nearestIndex, niceTicks, pathOf, stepDecimals, takeaway } from './chartMath';
import { fmtAgo, fmtDayClock, fmtDayMonth, fmtNamRule } from '../lib/format';

export interface SeriesPoint { t: number; v: number }
export interface SeriesRange { value: string; label: string; /** window length; null = everything */ ms: number | null }

export interface SeriesChartProps {
  points: SeriesPoint[];
  /** Window end: now, or the rewound time. */
  end: number;
  ranges?: SeriesRange[];
  range?: string;
  onRange?: (r: string) => void;
  /** `shielded`: the line in --shielded (Shielded screen only); `ink`: the ground's ink. */
  tone: 'shielded' | 'ink';
  /** What the series is, for the title and the readout ("Shielded NAM"). */
  what: string;
  /** Sentence under the title: the unit and how often it was read. */
  unit: React.ReactNode;
  prov: Stamp | null;
  provLabel: string;
  headingId: string;
  level?: 2 | 3;
  className?: string;
}

const CHAR = 6.6; // JetBrains Mono at 11 px
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayMonthYear = (t: number) => `${fmtDayMonth(t)} ${new Date(t).getUTCFullYear()}`;
const monthYear = (t: number) => `${MON[new Date(t).getUTCMonth()]} ${new Date(t).getUTCFullYear()}`;

/** NAM tick label with as many decimals as the step needs: "50M", "341.65M", "980k". */
export function namTick(v: number, step: number): string {
  if (v === 0) return '0';
  const a = Math.max(Math.abs(v), Math.abs(step));
  const [div, suf] = a >= 1e9 ? [1e9, 'B'] : a >= 1e6 ? [1e6, 'M'] : a >= 1e3 ? [1e3, 'k'] : [1, ''];
  return `${(v / div).toFixed(stepDecimals(step / div))}${suf}`;
}
/** Compact NAM for the pill and titles: "50.7M". */
export const namShort = (v: number): string => {
  const a = Math.abs(v);
  if (a >= 1e9) return `${+(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${+(v / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${+(v / 1e3).toFixed(0)}k`;
  return fmtNamRule(v);
};

export function SeriesChart({ points, end, ranges, range, onRange, tone, what, unit, prov, provLabel, headingId, level = 2, className = '' }: SeriesChartProps) {
  const now = useUiNow();
  const [boxRef, { w, h }] = useSize<HTMLDivElement>();
  const [pick, setPick] = useState<number | null>(null);

  const all = useMemo(() => [...points].filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v) && p.t <= end).sort((a, b) => a.t - b.t), [points, end]);
  const win = ranges?.find((r) => r.value === range) ?? null;
  const tStart = win?.ms != null ? end - win.ms : all[0]?.t ?? end;
  const E = all.filter((p) => p.t >= tStart);
  const tEnd = Math.max(end, E[E.length - 1]?.t ?? end);
  const long = tEnd - tStart > 300 * 86_400_000;

  // ---------------- scales ----------------
  const vals = E.map((p) => p.v);
  const yT = vals.length ? niceTicks(Math.min(...vals), Math.max(...vals), { maxTicks: 5 }) : niceTicks(0, 1);
  const yLabels = yT.ticks.map((t) => namTick(t, yT.step));
  const L = Math.ceil(Math.max(...yLabels.map((s) => s.length)) * CHAR) + 14;
  const R = 10;
  const T = 14;
  const B = 26;
  const X = lin(tStart, tEnd, L, Math.max(L + 1, w - R));
  const Y = lin(yT.lo, yT.hi, Math.max(T + 1, h - B), T);
  const pts = E.map((p) => [X(p.t), Y(p.v)] as [number, number]);
  const xTicks = [tStart, tStart + (tEnd - tStart) / 2, tEnd];
  const xFmt = (t: number) => (long ? monthYear(t) : fmtDayMonth(t));

  // ---------------- words ----------------
  const first = E[0] ?? null;
  const last = E[E.length - 1] ?? null;
  const low = E.length ? E.reduce((a, b) => (b.v < a.v ? b : a)) : null;
  const high = E.length ? E.reduce((a, b) => (b.v > a.v ? b : a)) : null;
  const since = first ? (long || tEnd - first.t > 200 * 86_400_000 ? dayMonthYear(first.t) : fmtDayMonth(first.t)) : '';
  let heading = `No ${what.toLowerCase()} readings in this window`;
  if (first && last && E.length >= 2) {
    const pct = first.v > 0 ? ((last.v - first.v) / first.v) * 100 : null;
    heading = pct != null && Math.abs(pct) >= 100
      ? `${what} ${last.v > first.v ? 'up' : 'down'} from ${namShort(first.v)} to ${namShort(last.v)} since ${since}`
      : takeaway(first.v, last.v, since, what) ?? what;
  } else if (E.length === 1) heading = `${what}: one reading in this window`;
  const H = level === 3 ? 'h3' : 'h2';

  const sel = pick != null && E[pick] ? E[pick] : null;
  const shown = sel ?? last;
  const setFromX = (clientX: number, el: Element) => {
    if (!E.length) return;
    const r = el.getBoundingClientRect();
    setPick(nearestIndex(pts.map((p) => p[0]), clientX - r.left));
  };

  const pill = last && w > 0 ? (() => {
    const txt = namShort(last.v);
    const pw = txt.length * CHAR + 16;
    const [lx, ly] = [X(last.t), Y(last.v)];
    const px = Math.min(w - R - pw, Math.max(L, lx - pw - 6));
    const py = ly - 28 < T ? ly + 10 : ly - 28;
    return { txt, pw, px, py };
  })() : null;
  const cur = sel ? [X(sel.t), Y(sel.v)] : null;
  const lineCls = tone === 'shielded' ? 'c-shielded' : 'c-exec';
  const dotCls = tone === 'shielded' ? 'c-shielded-dot' : 'c-exec-dot';

  return (
    <section className={`chartsec ${className}`} aria-labelledby={headingId} data-prov-scope="">
      <div className="chartsec__top">
        <div className="chartsec__title">
          <H id={headingId} className="chartsec__h">{heading}</H>
          <p className="cap">{unit}</p>
        </div>
        {ranges && onRange && range ? <Segmented label="Chart range" variant="range" value={range} options={ranges.map((r) => ({ value: r.value, label: r.label }))} onChange={onRange} /> : null}
      </div>

      <p className="readout" aria-live="polite">
        {shown ? (
          <>
            <span className="readout__k">{sel ? 'Reading' : 'Last reading'}</span>{' '}
            <b data-num="" className="readout__v">{fmtNamRule(shown.v)}<span className="u"> NAM</span></b>{' '}
            <span className="readout__t">{fmtDayClock(shown.t)}</span>
          </>
        ) : (
          <span className="readout__k">No reading in this window.</span>
        )}
      </p>

      <div
        ref={boxRef}
        className="chart-box chart-box--sm"
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
            {pts.length > 2 ? (
              <g className="c-wipe">
                <path className={lineCls} d={pathOf(pts)} />
              </g>
            ) : null}
            {pts.length <= 60 ? pts.map(([x, y], i) => <circle key={i} className={dotCls} cx={x} cy={y} r={pts.length <= 2 ? 3.5 : 2} />) : null}
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

      <dl className="cstats cstats--3">
        <div><dt>Low</dt><dd data-num="">{low ? <>{fmtNamRule(low.v)}<small>{fmtDayMonth(low.t)}{long ? ` ${new Date(low.t).getUTCFullYear()}` : ''}</small></> : '—'}</dd></div>
        <div><dt>High</dt><dd data-num="">{high ? <>{fmtNamRule(high.v)}<small>{fmtDayMonth(high.t)}{long ? ` ${new Date(high.t).getUTCFullYear()}` : ''}</small></> : '—'}</dd></div>
        <div><dt>Last reading</dt><dd data-num="">{last ? <>{fmtNamRule(last.v)}<small>{fmtAgo(last.t, now)}</small></> : '—'}</dd></div>
      </dl>

      {prov ? <SourceLine items={[{ label: provLabel, p: prov }]} label="Where the readings come from" /> : null}

      {first && low && high && last ? (
        <p className="sr-only">
          {what}: first reading {fmtNamRule(first.v)} NAM, lowest {fmtNamRule(low.v)}, highest {fmtNamRule(high.v)}, last {fmtNamRule(last.v)}.
        </p>
      ) : null}
    </section>
  );
}

export default SeriesChart;
