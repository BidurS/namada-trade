// The executable line under the heat (depth plan 3.2, view 3): what selling the quotable size fetched at every stored
// minute of the window, in the SeriesChart grammar (system.md 7.2: container-measured SVG, 1-2-5 ticks in a left
// gutter, a takeaway title, press-and-drag or arrow keys into a fixed readout, a Low / High / Last strip, a hidden text
// summary) with the line in the ground's ink and, shaded behind it, the lowest and highest of each hour (the minute
// rows bucketed by the hour; the hourly rows' own lo and hi for the month). The line is drawn run by run and breaks at
// every step with no stored row (shared/depth-heat.ts bucketLine and runsOf; verify.txt C2): a bucket holding a missing
// minute is blank at every width, so a gap is never bridged, and the readout over a blank step says so. The Over view
// says the window's gaps in words under the line; the band's SourceLine is the Over view's.
import { useMemo, useState } from 'react';
import { EXEC_GROUP_LABEL, EXEC_HIGH, EXEC_LAST, EXEC_LOW, EXEC_NONE, EXEC_READING, EXEC_READOUT_NONE, KEY_BAND_HOUR, KEY_EXEC, execGapReadout, execOne, execTakeaway } from '../../../../shared/depth';
import { bandOf, lineRuns, runsOf, type LinePoint } from '../../../../shared/depth-heat';
import { useSize } from '../../ui/index';
import { lin, niceTicks, tickLabel } from '../../ui/chartMath';
import { fmtDayClock, fmtDayMonth, fmtUsdRule, fmtUtcClock } from '../../lib/format';

export interface ExecLineProps {
  /** Every step of the window: a stored minute's figure, or null where none was stored. */
  points: LinePoint[];
  stepMs: number;
  from: number;
  to: number;
  /** The hour's lowest and highest when the rows are hourly (each point's own); else the band is read off the minutes. */
  hourly: boolean;
  heading: string;
  nam: string;
  symbol: string;
  unit: string;
  headingId: string;
}

const CHAR = 6.6;
const HOUR_MS = 3_600_000;

export function ExecLine({ points, stepMs, from, to, hourly, heading, nam, symbol, unit, headingId }: ExecLineProps) {
  const [boxRef, { w, h }] = useSize<HTMLDivElement>();
  const [pick, setPick] = useState<number | null>(null);
  const stored = useMemo(() => points.filter((p) => p.v != null && Number.isFinite(p.v)) as (LinePoint & { v: number })[], [points]);

  // The drawn series: one bucket per two pixels at most; a bucket with no minute, or with a missing minute inside it, is a gap.
  const L0 = 56, R = 10, T = 14, B = 26;
  const nBuckets = Math.max(1, Math.floor((w - L0 - R) / 2));
  const runs = useMemo(() => lineRuns(points, from, to, nBuckets), [points, from, to, nBuckets]);
  const band = useMemo(() => (hourly ? points.filter((p) => p.lo != null && p.hi != null).map((p) => ({ t: p.t, lo: p.lo as number, hi: p.hi as number })) : bandOf(points, HOUR_MS)), [points, hourly]);
  const bandRuns = useMemo(() => runsOf(band.map((b) => ({ ...b, v: b.hi })), HOUR_MS * 1.5), [band]);

  // The scales: the y axis over the line and the band, 1-2-5 ticks, the gutter as wide as its widest label.
  const vals = [...stored.map((p) => p.v), ...band.map((b) => b.lo), ...band.map((b) => b.hi)];
  const yT = vals.length ? niceTicks(Math.min(...vals), Math.max(...vals), { maxTicks: 5 }) : niceTicks(0, 1);
  const yLabels = yT.ticks.map((t) => `$${tickLabel(t, yT.step)}`);
  const L = Math.ceil(Math.max(...yLabels.map((s) => s.length)) * CHAR) + 14;
  const X = lin(from, to, L, Math.max(L + 1, w - R));
  const Y = lin(yT.lo, yT.hi, Math.max(T + 1, h - B), T);
  const xTicks = [from, from + (to - from) / 2, to];
  const xFmt = (t: number) => (to - from <= 86_400_000 + 1 ? fmtUtcClock(t) : fmtDayMonth(t));
  const bandW = Math.max(1, X(from + HOUR_MS) - X(from));

  // The words: the takeaway from the stored minutes' own lowest, highest and last.
  const first = stored[0] ?? null;
  const last = stored[stored.length - 1] ?? null;
  const low = stored.length ? stored.reduce((a, b) => (b.v < a.v ? b : a)) : null;
  const high = stored.length ? stored.reduce((a, b) => (b.v > a.v ? b : a)) : null;
  const title = last && low && high ? (stored.length > 1 ? execTakeaway(nam, symbol, fmtUsdRule(last.v), fmtUsdRule(low.v), fmtUsdRule(high.v)) : execOne(nam, symbol, fmtUsdRule(last.v))) : EXEC_NONE;

  // The readout: the nearest step to the pointer, blank steps included.
  const sel = pick != null && points[pick] ? points[pick] : null;
  const setFromX = (clientX: number, el: Element) => {
    if (!points.length) return;
    const r = el.getBoundingClientRect();
    const t = from + ((clientX - r.left - L) / Math.max(1, w - L - R)) * (to - from);
    const k = Math.max(0, Math.min(points.length - 1, Math.round((t - from) / stepMs)));
    setPick(k);
  };
  const shown = sel ?? last;

  return (
    <section className="chartsec dp-exec" aria-labelledby={headingId}>
      <div className="chartsec__top">
        <div className="chartsec__title">
          <h3 id={headingId} className="chartsec__h">{heading}</h3>
          <p className="cap">{title}</p>
          <p className="cap">{unit}</p>
        </div>
      </div>
      <p className="readout" aria-live="polite">
        {shown ? (
          shown.v != null ? (
            <>
              <span className="readout__k">{sel ? EXEC_READING : EXEC_LAST}</span>{' '}
              <b data-num="" className="readout__v">{fmtUsdRule(shown.v)}</b>{' '}
              <span className="readout__t">{fmtDayClock(shown.t)}</span>
            </>
          ) : (
            <span className="readout__t dp-exec__gap">{execGapReadout(fmtDayClock(shown.t))}</span>
          )
        ) : (
          <span className="readout__k">{stored.length ? EXEC_READOUT_NONE : EXEC_NONE}</span>
        )}
      </p>
      <div
        ref={boxRef}
        className="chart-box chart-box--sm dp-exec__plot"
        tabIndex={points.length ? 0 : -1}
        role="group"
        aria-label={EXEC_GROUP_LABEL}
        onPointerDown={(e) => { if (e.pointerType === 'mouse' && e.button !== 0) return; setFromX(e.clientX, e.currentTarget); }}
        onPointerMove={(e) => { if (e.pointerType === 'mouse' || e.buttons) setFromX(e.clientX, e.currentTarget); }}
        onPointerLeave={(e) => { if (e.pointerType === 'mouse') setPick(null); }}
        onPointerUp={(e) => { if (e.pointerType !== 'mouse') setPick(null); }}
        onPointerCancel={() => setPick(null)}
        onKeyDown={(e) => {
          if (!points.length) return;
          const i = pick ?? points.length - 1;
          if (e.key === 'ArrowLeft') setPick(Math.max(0, i - 1));
          else if (e.key === 'ArrowRight') setPick(Math.min(points.length - 1, i + 1));
          else if (e.key === 'Home') setPick(0);
          else if (e.key === 'End') setPick(points.length - 1);
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
            {bandRuns.map((run, i) => (
              <path key={`b${i}`} className="c-band dp-exec__band" d={`${run.map((b, j) => `${j ? 'L' : 'M'}${X(b.t).toFixed(1)} ${Y(b.hi).toFixed(1)}`).join('')}L${(X(run[run.length - 1].t) + bandW).toFixed(1)} ${Y(run[run.length - 1].hi).toFixed(1)}L${(X(run[run.length - 1].t) + bandW).toFixed(1)} ${Y(run[run.length - 1].lo).toFixed(1)}${[...run].reverse().map((b) => `L${X(b.t).toFixed(1)} ${Y(b.lo).toFixed(1)}`).join('')}Z`} />
            ))}
            {runs.map((run, i) => (
              run.length > 1
                ? <path key={i} className="c-exec dp-exec__line" d={run.map((q, j) => `${j ? 'L' : 'M'}${X(q.t).toFixed(1)} ${Y(q.v as number).toFixed(1)}`).join('')} />
                : <circle key={i} className="c-exec-dot dp-exec__line" cx={X(run[0].t)} cy={Y(run[0].v as number)} r={2.5} />
            ))}
            {sel ? (
              <>
                <line className="c-cursor" x1={X(sel.t)} x2={X(sel.t)} y1={T} y2={h - B} />
                {sel.v != null ? <circle className="c-cursor-dot" cx={X(sel.t)} cy={Y(sel.v)} r={5} /> : null}
              </>
            ) : null}
          </svg>
        ) : null}
      </div>
      <ul className="key">
        <li><i className="key__ln" />{KEY_EXEC}</li>
        {band.length ? <li><i className="key__sw key__sw--band" />{KEY_BAND_HOUR}</li> : null}
      </ul>
      <dl className="cstats cstats--3">
        <div><dt>{EXEC_LOW}</dt><dd data-num="">{low ? <>{fmtUsdRule(low.v)}<small>{fmtDayClock(low.t)}</small></> : '—'}</dd></div>
        <div><dt>{EXEC_HIGH}</dt><dd data-num="">{high ? <>{fmtUsdRule(high.v)}<small>{fmtDayClock(high.t)}</small></> : '—'}</dd></div>
        <div><dt>{EXEC_LAST}</dt><dd data-num="">{last ? <>{fmtUsdRule(last.v)}<small>{fmtDayClock(last.t)}</small></> : '—'}</dd></div>
      </dl>
      {first && low && high && last ? <p className="sr-only">{title}</p> : null}
    </section>
  );
}

export default ExecLine;
