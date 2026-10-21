// Bars (F4, screener-plan 2.6 and 3.5b): NAM per step as bars, in two forms.
//
// BarsPlot draws into a parent chart's SVG with the parent's x scale and its own y scale from zero: the price
// chart's hourly volume strip under its plot (one axis per plot, never a second axis on the price plot,
// system.md 7.2). Bars are --c-ink-2 at 40% (never buy or sell hues on a series); a step without a trade is an
// empty slot, and where the slots are wide enough to see (6 px or more) each empty one carries a faint mark on
// the baseline, so the reader sees how many hours were empty instead of reading it in a caption.
//
// Bars is the same grammar as a standalone chart (daily or hourly bars, container-measured, 11 px ticks, the
// y labels in a left gutter, press and drag or the arrow keys read one bar into the readout above the plot, a
// visually hidden summary, one SourceLine). Its `stack` option splits each bar into bought and sold: the one
// place a series may carry the buy and sell hues, because each part is a buy or a sell (screener-plan 4.3).
import React, { useMemo, useState } from 'react';
import type { Stamp } from '../lib/prov';
import { fmtDayClock, fmtDayMonth, fmtDayMonthYear, fmtNamRule } from '../lib/format';
import { lin, nearestIndex, niceTicks } from './chartMath';
import { HOUR_MS } from './chartConst';
import { useSize } from './useSize';
import { SourceLine } from './SourceLine';
import { namTick } from './SeriesChart';

const CHAR = 6.6; // JetBrains Mono at 11 px
/** Empty slots are marked only where a slot is at least this wide (px); narrower, the bare baseline says it. */
export const SLOT_MARK_MIN_PX = 6;

export interface BarPoint {
  /** start of the step (unix ms) */
  t: number;
  /** NAM in the step */
  nam: number;
  usd?: number | null;
  /** trades in the step, when known */
  n?: number | null;
  /** bought and sold parts, for a stacked chart */
  stack?: { buy: number; sell: number } | null;
}

export interface BarsPlotProps {
  bars: BarPoint[];
  /** the parent's x scale (time to px) and the visible window */
  x: (t: number) => number;
  from: number;
  to: number;
  stepMs: number;
  /** the plot's top edge and height inside the parent SVG */
  top: number;
  height: number;
  /** where the y label goes (the parent's left gutter edge) and the plot's right edge */
  left: number;
  right: number;
  /** no slot before this time is "empty": the record had not begun (null: unknown, no slot is marked) */
  start?: number | null;
  /** the step to outline (the readout's) */
  pickT?: number | null;
}

/** The strip's y scale: zero to a 1-2-5 value above the largest bar in the window, and its one label ("2k NAM"). */
export function barsScale(bars: BarPoint[], from: number, to: number, stepMs: number): { hi: number; step: number; label: string } {
  const max = bars.filter((b) => b.t >= from - stepMs && b.t < to && Number.isFinite(b.nam)).reduce((m, b) => Math.max(m, b.nam), 0);
  const yT = niceTicks(0, max > 0 ? max : 1, { maxTicks: 2, zero: true });
  return { hi: yT.hi, step: yT.step, label: `${namTick(yT.hi, yT.step)} NAM` };
}

/** The hourly volume strip, drawn inside a parent chart's SVG. */
export function BarsPlot({ bars, x, from, to, stepMs, top, height, left, right, start, pickT }: BarsPlotProps) {
  const inWin = bars.filter((b) => b.t >= from - stepMs && b.t < to && Number.isFinite(b.nam));
  const sc = barsScale(bars, from, to, stepMs);
  const yT = { hi: sc.hi };
  const base = top + height;
  const Y = lin(0, yT.hi, base, top);
  const slotW = Math.max(0, x(from + stepMs) - x(from));
  const barW = Math.max(1, slotW - (slotW >= 4 ? 1 : 0));
  // empty slots, marked only where they can be seen and only after the record began
  const marks: number[] = [];
  if (slotW >= SLOT_MARK_MIN_PX && start != null) {
    const have = new Set(inWin.map((b) => Math.floor(b.t / stepMs)));
    for (let k = Math.ceil(Math.max(from, start) / stepMs); k * stepMs < to; k++) if (!have.has(k)) marks.push(k * stepMs);
  }
  const pickK = pickT != null ? Math.floor(pickT / stepMs) : null;
  return (
    <g className="c-bars" data-bars={inWin.length} data-empty={marks.length}>
      <line className="c-bars-base" x1={left} x2={right} y1={base + 0.5} y2={base + 0.5} />
      <line className="c-grid" x1={left} x2={right} y1={top + 0.5} y2={top + 0.5} />
      <text className="c-tick" x={left - 8} y={top + 4} textAnchor="end">{sc.label}</text>
      <text className="c-tick" x={left - 8} y={base + 4} textAnchor="end">{namTick(0, sc.step)}</text>
      {marks.map((t) => (
        <rect key={`s${t}`} className="c-slot" x={x(t) + 1} y={base - 2} width={Math.max(1, slotW - 2)} height={2} />
      ))}
      {inWin.map((b) => {
        const bx = Math.max(left, x(b.t));
        const hgt = Math.max(1, base - Y(b.nam));
        return <rect key={b.t} className={`c-bar${pickK === Math.floor(b.t / stepMs) ? ' is-pick' : ''}`} x={bx} y={base - hgt} width={Math.max(1, Math.min(barW, right - bx))} height={hgt} />;
      })}
    </g>
  );
}

// ---------------------------------------------------------------- the standalone chart

export interface BarsProps {
  bars: BarPoint[];
  /** the window drawn, [from, to) */
  from: number;
  to: number;
  stepMs: number;
  /** the series' honest start: no slot before it counts as empty, and the line under the chart prints it */
  start?: number | null;
  title: React.ReactNode;
  headingId?: string;
  level?: 2 | 3;
  /** the unit and what a bar is ("NAM traded per day, buys and sells stacked") */
  unit: React.ReactNode;
  /** the SourceLine items (one per series) */
  scope: { label: string; p: Stamp }[];
  /** what the start line says the series is ("Trades recorded") */
  startWhat?: string;
  /** split each bar into bought and sold */
  stacked?: boolean;
  className?: string;
}

const isDaily = (ms: number) => ms >= 86_400_000;

export function Bars({ bars, from, to, stepMs, start, title, headingId, level = 3, unit, scope, startWhat, stacked, className = '' }: BarsProps) {
  const [boxRef, { w, h }] = useSize<HTMLDivElement>();
  const [pick, setPick] = useState<number | null>(null);
  const B = useMemo(() => [...bars].filter((b) => Number.isFinite(b.t) && Number.isFinite(b.nam) && b.t >= from && b.t < to).sort((a, b) => a.t - b.t), [bars, from, to]);
  const max = B.reduce((m, b) => Math.max(m, stacked && b.stack ? Math.max(b.stack.buy, b.stack.sell, b.nam) : b.nam), 0);
  const yT = niceTicks(0, max > 0 ? max : 1, { maxTicks: 4, zero: true });
  const yLabels = yT.ticks.map((t) => namTick(t, yT.step));
  const L = Math.ceil(Math.max(...yLabels.map((s) => s.length)) * CHAR) + 14;
  const R = 10;
  const T = 8;
  const Bt = 26;
  const X = lin(from, to, L, Math.max(L + 1, w - R));
  const Y = lin(0, yT.hi, Math.max(T + 1, h - Bt), T);
  const base = Math.max(T + 1, h - Bt);
  const slotW = Math.max(0, X(from + stepMs) - X(from));
  const barW = Math.max(1, slotW - (slotW >= 4 ? 2 : 0));
  const daily = isDaily(stepMs);
  const xFmt = (t: number) => (daily ? fmtDayMonth(t) : fmtDayClock(t).replace(' UTC', ''));
  const slots = Math.max(0, Math.ceil(to / stepMs) - Math.ceil(Math.max(from, start ?? from) / stepMs));
  const sel = pick != null ? B[pick] ?? null : null;
  const shown = sel ?? B[B.length - 1] ?? null;
  const H = level === 2 ? 'h2' : 'h3';
  const setFromX = (clientX: number, el: Element) => {
    if (!B.length) return;
    const r = el.getBoundingClientRect();
    setPick(nearestIndex(B.map((b) => X(b.t) + barW / 2), clientX - r.left));
  };
  const total = B.reduce((a, b) => a + b.nam, 0);

  return (
    <section className={`chartsec bars ${className}`} aria-labelledby={headingId} data-prov-scope="">
      <div className="chartsec__top">
        <div className="chartsec__title">
          <H id={headingId} className="chartsec__h">{title}</H>
          <p className="cap">{unit}</p>
        </div>
      </div>
      <p className="readout" aria-live="polite">
        {shown ? (
          <>
            <span className="readout__k">{sel ? (daily ? 'That day' : 'That hour') : daily ? 'Latest day with trades' : 'Latest hour with trades'}</span>{' '}
            <b data-num="" className="readout__v">{fmtNamRule(shown.nam)} NAM</b>{' '}
            {stacked && shown.stack ? (
              <span className="readout__t">
                bought <span data-num="">{fmtNamRule(shown.stack.buy)}</span>, sold <span data-num="">{fmtNamRule(shown.stack.sell)}</span>
              </span>
            ) : null}{' '}
            <span className="readout__t">{daily ? fmtDayMonth(shown.t) : fmtDayClock(shown.t)}</span>
          </>
        ) : (
          <span className="readout__k">No trade in this window.</span>
        )}
      </p>
      <div
        ref={boxRef}
        className="chart-box chart-box--bars-only"
        tabIndex={B.length ? 0 : -1}
        role="group"
        aria-label={B.length ? `${typeof title === 'string' ? title : 'Bars'}. Press and drag, or use the arrow keys, to read a bar.` : 'No bars in this window'}
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
          if (!B.length) return;
          const i = pick ?? B.length - 1;
          if (e.key === 'ArrowLeft') setPick(Math.max(0, i - 1));
          else if (e.key === 'ArrowRight') setPick(Math.min(B.length - 1, i + 1));
          else if (e.key === 'Home') setPick(0);
          else if (e.key === 'End') setPick(B.length - 1);
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
            {[from, from + (to - from) / 2, to - stepMs].map((t, i) => (
              <text key={i} className="c-tick" x={i === 2 ? w - R : X(t)} y={h - 6} textAnchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}>{xFmt(t)}</text>
            ))}
            {B.map((b, i) => {
              const bx = X(b.t) + (slotW >= 4 ? 1 : 0);
              const picked = sel === b;
              if (stacked && b.stack) {
                const hb = Math.max(0, base - Y(b.stack.buy));
                const hs = Math.max(0, base - Y(b.stack.sell));
                return (
                  <g key={b.t} className={picked ? 'is-pick' : undefined}>
                    <rect className={`c-bar-buy${picked ? ' is-pick' : ''}`} x={bx} y={base - hb - hs} width={barW} height={hb} />
                    <rect className={`c-bar-sell${picked ? ' is-pick' : ''}`} x={bx} y={base - hs} width={barW} height={hs} />
                  </g>
                );
              }
              const hg = Math.max(1, base - Y(b.nam));
              return <rect key={b.t ?? i} className={`c-bar${picked ? ' is-pick' : ''}`} x={bx} y={base - hg} width={barW} height={hg} />;
            })}
          </svg>
        ) : null}
      </div>
      {stacked ? (
        <ul className="key">
          <li><i className="key__sw key__sw--buy" />Bought</li>
          <li><i className="key__sw key__sw--sell" />Sold</li>
        </ul>
      ) : null}
      <p className="cap">
        <span data-num="">{B.length}</span> of the <span data-num="">{slots}</span> {daily ? 'days' : 'hours'} shown had a trade; an empty slot is {daily ? 'a day' : 'an hour'} without one.
        {startWhat ? (
          start != null ? (
            <> {startWhat} since <span data-num="">{fmtDayMonthYear(start)}</span>.</>
          ) : (
            <> When the record begins is not known.</>
          )
        ) : null}
      </p>
      <SourceLine items={scope} label="Where the bars come from" />
      <p className="sr-only">
        {B.length} {daily ? 'days' : 'hours'} with trades, {fmtNamRule(total)} NAM in all{stepMs === HOUR_MS ? ', hour by hour' : ''}.
      </p>
    </section>
  );
}

export default Bars;
