// HeatChart (depth plan 3.2, view 3 "Over time"; the chart rules of system.md 7.2): time across, price up on a log
// axis in USD per coin, and the colour of each cell the USD resting in that band of the reference price at that step,
// read from the stored heat rows. One hue in five steps (the site's --heat-1 ... --heat-5 tokens, validated as an
// ordinal ramp in both themes by test/depth-palette.test.ts); a band under the faintest step's floor is blank and the
// legend says so. The reference pool's own price is the hairline in --c-mark, drawn run by run so it breaks at every
// step with no stored column (verify.txt C2: a missing minute is a blank column, never bridged); the stored trades are
// dots in --c-ink-2 sized by their coins, with a shape and a legend, never a third hue.
//
// The cells are painted into a canvas pixel by pixel (a day of minute columns at 112 bands would be 160,000 SVG rects,
// which no phone draws in time; the paint is measured and the page test holds a week under 200 ms of main-thread time),
// one column computed per stored step and copied across the pixels it covers; the axes, the hairline, the dots and the
// cursor are SVG over it. Press and drag, or the arrow keys, read one cell into a fixed readout above the plot (the
// time, the band's prices and the USD in it), never a tooltip over the data. A column is named by its own stored time,
// never by its slot's start (the window's `from` is any millisecond, so a column stored at a whole minute or hour falls
// anywhere inside its slot); only a blank slot is named by its start. The band straddling the reference price holds
// bids and asks both: the cell is their sum and the readout says each side. Container-measured; a table view of the
// same columns, thinned to TABLE_ROWS_MAX rows with a sentence saying how many of how many are listed.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  HEAD_ASK_ALL, HEAD_ASK_MOST, HEAD_BID_ALL, HEAD_BID_MOST, HEAD_REF_PRICE, HEAD_TIME, HEAT_GROUP_LABEL, HEAT_LEGEND_LABEL, HEAT_NO_COLUMN, HEAT_READOUT_NONE, HEAT_TABLE_ALL, HEAT_TABLE_LABEL, KEY_GAP, axisPrice, heatAria, heatGapReadout, heatReadout, heatReadoutBlank, heatReadoutBoth, keyRef, keyTradesSized, legendBlank, legendStep, legendTop, tableThinned, tradeTitle,
} from '../../../shared/depth';
import { HEAT_STEPS, bandAt, bandValue, hairlineRuns, heatMax, heatPriceSpan, heatStepEdges, heatStepOf, slotColumns, type HeatColumn } from '../../../shared/depth-heat';
import { fmtCount, fmtDayClock, fmtDayMonth, fmtNamRule, fmtSig, fmtUsdRule, fmtUtcClock } from '../lib/format';
import { useSize } from './useSize';

export interface HeatChartTrade {
  id: string;
  t: number;
  kind: 'buy' | 'sell';
  price: number;
  usd: number;
  nam: number;
}
export interface HeatChartProps {
  /** The stored columns, decoded (shared/depth-heat.ts decodeHeat), in time order. */
  columns: HeatColumn[];
  /** The step each column stands for, and the window drawn: one slot per step, a slot with no column blank. */
  stepMs: number;
  from: number;
  to: number;
  /** The band edges as ratios of each column's reference (shared/depth.ts HEAT_EDGES). */
  edges: readonly number[];
  symbol: string;
  refPool: string;
  trades: HeatChartTrade[] | null;
  tradesDays: number;
  table?: boolean;
  /** The main-thread milliseconds the cells took to paint, after each paint. */
  onPainted?: (ms: number) => void;
  className?: string;
}

const TABLE_ROWS_MAX = 60;
/** The window is shorter than this: the x labels are clocks; else days. */
const DAY_MS = 86_400_000;

/** The ramp's colours as the ground paints them now (the canvas cannot read a CSS variable). */
function rampOf(el: HTMLElement): string[] {
  const cs = getComputedStyle(el);
  return Array.from({ length: HEAT_STEPS }, (_, i) => cs.getPropertyValue(`--heat-${i + 1}`).trim() || '#000000');
}
const hexRgb = (hex: string): [number, number, number] => {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

export function HeatChart(p: HeatChartProps) {
  const { columns, stepMs, from, to, edges, symbol, trades, onPainted } = p;
  const id = useId();
  const [boxRef, { w }] = useSize<HTMLDivElement>();
  // the ramp is read off the ground at paint time, so a theme change repaints (the shell flips data-theme on <html>)
  const [theme, setTheme] = useState(0);
  useEffect(() => {
    const mo = new MutationObserver(() => setTheme((n) => n + 1));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const H = w >= 640 ? 320 : 260;
  const L = 68, R = 12, T = 16, B = 30;
  const [pick, setPick] = useState<{ k: number; band: number } | null>(null);
  const [drag, setDrag] = useState(false);

  const slots = useMemo(() => slotColumns(columns, stepMs, from, to), [columns, stepMs, from, to]);
  const n = slots.length;
  const blank = slots.filter((s) => s == null).length;
  const max = useMemo(() => heatMax(columns), [columns]);
  const steps = useMemo(() => heatStepEdges(max), [max]);
  const span = useMemo(() => heatPriceSpan(columns), [columns]);
  const plotW = Math.max(1, w - L - R), plotH = Math.max(1, H - T - B);
  const slotW = plotW / Math.max(1, n);
  const X = (t: number) => L + ((t - from) / (to - from || 1)) * plotW;
  const lo = span?.lo ?? 1, hi = span?.hi ?? 2;
  const ly0 = Math.log(lo), ly1 = Math.log(hi);
  const Y = (price: number) => T + (1 - (Math.log(price) - ly0) / (ly1 - ly0 || 1)) * plotH;
  const priceAtY = (y: number) => Math.exp(ly0 + (1 - (y - T) / plotH) * (ly1 - ly0));
  // y ticks: 1-2-5 on the log axis
  const yTicks = useMemo(() => {
    if (!span) return [] as number[];
    const out: number[] = [];
    for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) for (const m of [1, 2, 5]) { const v = m * 10 ** e; if (v >= lo && v <= hi) out.push(v); }
    return out.length > 6 ? out.filter((_, i) => i % 2 === 0) : out;
  }, [span, lo, hi]);
  const xTicks = useMemo(() => {
    const k = w >= 640 ? 4 : 2;
    return Array.from({ length: k + 1 }, (_, i) => from + ((to - from) * i) / k);
  }, [from, to, w]);
  const xFmt = (t: number) => (to - from <= DAY_MS + 1 ? fmtUtcClock(t) : fmtDayMonth(t));

  // The cells: one painted column per slot, copied across the pixels it covers.
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || w <= 0 || !span || !steps) return;
    const t0 = performance.now();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.round(w * dpr), HH = Math.round(H * dpr);
    if (cv.width !== W || cv.height !== HH) { cv.width = W; cv.height = HH; }
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, W, HH);
    const ramp = rampOf(cv).map(hexRgb);
    const img = ctx.createImageData(W, HH);
    const data = img.data;
    const pT = Math.round(T * dpr), pB = Math.round((H - B) * dpr), pL = Math.round(L * dpr), pR = Math.round((w - R) * dpr);
    // the price of each pixel row, once
    const rowPrice = new Float64Array(pB - pT);
    for (let py = pT; py < pB; py++) rowPrice[py - pT] = priceAtY(py / dpr);
    // one painted column per slot, copied across its pixels
    const colCache = new Map<number, Uint8ClampedArray | null>();
    for (let px = pL; px < pR; px++) {
      const k = Math.min(n - 1, Math.floor(((px / dpr) - L) / slotW));
      let col = colCache.get(k);
      if (col === undefined) {
        const c = slots[k];
        if (!c) col = null;
        else {
          col = new Uint8ClampedArray((pB - pT) * 4);
          for (let r = 0; r < rowPrice.length; r++) {
            const b = bandAt(c, rowPrice[r], edges);
            if (b == null) continue;
            const st = heatStepOf(bandValue(c, b, edges).usd, steps);
            if (st == null) continue;
            const [cr, cg, cb] = ramp[st];
            col[r * 4] = cr; col[r * 4 + 1] = cg; col[r * 4 + 2] = cb; col[r * 4 + 3] = 255;
          }
        }
        colCache.set(k, col);
      }
      if (!col) continue;
      for (let r = 0; r < rowPrice.length; r++) {
        const o = ((pT + r) * W + px) * 4;
        data[o] = col[r * 4]; data[o + 1] = col[r * 4 + 1]; data[o + 2] = col[r * 4 + 2]; data[o + 3] = col[r * 4 + 3];
      }
    }
    ctx.putImageData(img, 0, 0);
    const ms = performance.now() - t0;
    try { performance.measure('depth-heat-paint', { start: t0, end: t0 + ms }); } catch { /* an older browser without the options form */ }
    onPainted?.(ms);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w, H, slots, steps, span, edges, theme, p.table]);

  // The hairline, run by run: never across a blank slot, each point at its column's own time.
  const refRuns = useMemo(() => hairlineRuns(columns, stepMs, from, to), [columns, stepMs, from, to]);
  const inWin = (t: HeatChartTrade) => t.t >= from && t.t < to && t.price >= lo && t.price <= hi;
  const visTrades = (trades ?? []).filter(inWin);
  const tradeR = (nam: number) => Math.max(2.5, Math.min(11, 2 + Math.sqrt(Math.max(0, nam)) / 40));

  // The readout: the slot under the pointer or the keys, named by its column's time (a blank slot by its start).
  const at = (clientX: number, clientY: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const x = clientX - r.left, y = clientY - r.top;
    if (!n) return null;
    const k = Math.max(0, Math.min(n - 1, Math.floor((x - L) / slotW)));
    const c = slots[k];
    const price = priceAtY(Math.max(T, Math.min(H - B, y)));
    const band = c ? bandAt(c, price, edges) : null;
    return { k, band: band ?? -1 };
  };
  const sel = pick && pick.k >= 0 && pick.k < n ? pick : null;
  const selCol = sel ? slots[sel.k] : null;
  // the slot's start places the cursor; the words name the column's own time
  const selT = sel ? from + sel.k * stepMs : null;
  const selClock = selCol ? fmtDayClock(selCol.t) : fmtDayClock(selT);
  const selVal = selCol && sel && sel.band >= 0 ? bandValue(selCol, sel.band, edges) : null;
  const selLo = selCol && sel && sel.band >= 0 ? selCol.refUsd * edges[sel.band] : null;
  const selHi = selCol && sel && sel.band >= 0 ? selCol.refUsd * edges[sel.band + 1] : null;
  const readout = sel && selT != null
    ? !selCol ? heatGapReadout(selClock)
      : selVal && steps && heatStepOf(selVal.usd, steps) != null && selLo != null && selHi != null
        ? selVal.side === 'both' ? heatReadoutBoth(selClock, fmtUsdRule(selVal.usd), fmtUsdRule(selVal.bid), fmtUsdRule(selVal.ask), fmtSig(selLo), fmtSig(selHi)) : heatReadout(selClock, selVal.side, fmtUsdRule(selVal.usd), fmtSig(selLo), fmtSig(selHi))
        : selLo != null && selHi != null ? heatReadoutBlank(selClock, fmtSig(selLo), fmtSig(selHi)) : heatGapReadout(selClock)
    : null;
  const move = (dk: number, db: number) => {
    if (!n) return;
    const cur = sel ?? { k: n - 1, band: Math.floor((edges.length - 2) / 2) };
    const k = Math.max(0, Math.min(n - 1, cur.k + dk));
    const band = Math.max(0, Math.min(edges.length - 2, (cur.band < 0 ? Math.floor((edges.length - 2) / 2) : cur.band) + db));
    setPick({ k, band });
  };

  const aria = heatAria(n, blank, fmtSig(lo), fmtSig(hi), symbol, visTrades.length);
  const every = Math.max(1, Math.ceil(n / TABLE_ROWS_MAX));
  const tableRows = useMemo(() => slots.map((c, k) => ({ c, k })).filter(({ k }) => k % every === 0 || k === n - 1), [slots, n, every]);
  const tableNote = every > 1 ? tableThinned(fmtCount(tableRows.length), fmtCount(n), fmtCount(every)) : HEAT_TABLE_ALL;
  /** The band holding most on a side of a column, and the side's total over the bands. */
  const most = (c: HeatColumn, side: 'bid' | 'ask') => {
    const arr = side === 'bid' ? c.bid : c.ask;
    let best = -1, bv = 0, total = 0;
    for (let i = 0; i < arr.length; i++) { total += arr[i]; if (arr[i] > bv) { bv = arr[i]; best = i; } }
    return { best, bv, total };
  };

  return (
    <figure className={`dph ${p.className ?? ''}`} aria-labelledby={`${id}c`}>
      <figcaption id={`${id}c`} className="sr-only">{aria}</figcaption>
      <p className="readout" aria-live="polite">
        {readout ? <span className="readout__t dph-readout">{readout}</span> : <span className="readout__k">{HEAT_READOUT_NONE}</span>}
      </p>
      {p.table ? (
        <div className="dp-table dph-table" role="table" aria-label={HEAT_TABLE_LABEL}>
          <p className="cap dph-table__note">{tableNote}</p>
          <div className="dp-trow dp-trow--head dph-trow" role="row">
            <span role="columnheader">{HEAD_TIME}</span>
            <span role="columnheader">{HEAD_REF_PRICE}</span>
            <span role="columnheader">{HEAD_BID_MOST}</span>
            <span role="columnheader">{HEAD_BID_ALL}</span>
            <span role="columnheader">{HEAD_ASK_MOST}</span>
            <span role="columnheader">{HEAD_ASK_ALL}</span>
          </div>
          {tableRows.map(({ c, k }) => {
            // a blank slot is named by its start; a column by its own stored time
            const t = c ? c.t : from + k * stepMs;
            if (!c) return <div key={k} className="dp-trow dph-trow dph-trow--gap" role="row"><span role="cell" data-num="">{fmtDayClock(t)}</span><span role="cell" className="dph-gapcell">{HEAT_NO_COLUMN}</span><span role="cell">—</span><span role="cell">—</span><span role="cell">—</span><span role="cell">—</span></div>;
            const b = most(c, 'bid'), a = most(c, 'ask');
            return (
              <div key={k} className="dp-trow dph-trow" role="row">
                <span role="cell" data-num="">{fmtDayClock(t)}</span>
                <span role="cell" data-num="">{fmtSig(c.refUsd)}</span>
                <span role="cell" data-num="">{b.best >= 0 && b.bv > 0 ? `${fmtSig(c.refUsd * edges[b.best])} – ${fmtSig(c.refUsd * edges[b.best + 1])}: ${fmtUsdRule(b.bv)}` : '—'}</span>
                <span role="cell" data-num="">{fmtUsdRule(b.total)}</span>
                <span role="cell" data-num="">{a.best >= 0 && a.bv > 0 ? `${fmtSig(c.refUsd * edges[a.best])} – ${fmtSig(c.refUsd * edges[a.best + 1])}: ${fmtUsdRule(a.bv)}` : '—'}</span>
                <span role="cell" data-num="">{fmtUsdRule(a.total)}</span>
              </div>
            );
          })}
        </div>
      ) : (
        <div
          className="chart-box dph-plot"
          ref={boxRef}
          style={{ height: H }}
          tabIndex={n ? 0 : -1}
          role="group"
          aria-label={HEAT_GROUP_LABEL}
          onPointerDown={(e) => { setDrag(true); setPick(at(e.clientX, e.clientY, e.currentTarget)); e.currentTarget.setPointerCapture?.(e.pointerId); }}
          onPointerMove={(e) => { if (drag || e.pointerType === 'mouse') setPick(at(e.clientX, e.clientY, e.currentTarget)); }}
          onPointerUp={() => setDrag(false)}
          onPointerCancel={() => setDrag(false)}
          onPointerLeave={() => { if (!drag) setPick(null); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight') { e.preventDefault(); move(1, 0); }
            else if (e.key === 'ArrowLeft') { e.preventDefault(); move(-1, 0); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); move(0, 1); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); move(0, -1); }
            else if (e.key === 'Home') { e.preventDefault(); setPick({ k: 0, band: sel?.band ?? -1 }); }
            else if (e.key === 'End') { e.preventDefault(); setPick({ k: n - 1, band: sel?.band ?? -1 }); }
            else if (e.key === 'Escape') setPick(null);
          }}
        >
          <canvas ref={canvasRef} className="dph-cells" style={{ width: w || 1, height: H }} aria-hidden="true" />
          {w > 0 && span ? (
            <svg width={w} height={H} viewBox={`0 0 ${w} ${H}`} role="img" aria-label={aria}>
              {yTicks.map((t) => (
                <g key={t}>
                  <line className="c-grid dph-grid" x1={L} x2={w - R} y1={Y(t)} y2={Y(t)} />
                  <text className="c-tick" x={L - 8} y={Y(t) + 4} textAnchor="end">{fmtSig(t, 4)}</text>
                </g>
              ))}
              <line className="c-axis" x1={L} x2={w - R} y1={H - B} y2={H - B} />
              {xTicks.map((t, i) => (
                <text key={i} className="c-tick" x={X(t)} y={H - B + 16} textAnchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'}>{xFmt(t)}</text>
              ))}
              <text className="c-tick" x={L} y={T - 4} textAnchor="start">{axisPrice(symbol, true)}</text>
              {refRuns.map((run, i) => (
                run.length > 1
                  ? <path key={i} className="dph-ref" d={run.map((q, j) => `${j ? 'L' : 'M'}${X(q.t).toFixed(1)} ${Y(q.v).toFixed(1)}`).join('')} />
                  : <line key={i} className="dph-ref" x1={X(run[0].t) - Math.max(1, slotW / 2)} x2={X(run[0].t) + Math.max(1, slotW / 2)} y1={Y(run[0].v)} y2={Y(run[0].v)} />
              ))}
              {visTrades.map((t) => (
                <circle key={t.id} className="dph-trade" cx={X(t.t)} cy={Y(t.price)} r={tradeR(t.nam)}>
                  <title>{tradeTitle(t.kind, fmtNamRule(t.nam), symbol, fmtSig(t.price), fmtUsdRule(t.usd), fmtDayClock(t.t))}</title>
                </circle>
              ))}
              {sel && selT != null ? (
                <g>
                  <rect className="dph-cursor" x={X(selT)} width={Math.max(2, slotW)} y={selHi != null ? Y(selHi) : T} height={selHi != null && selLo != null ? Math.max(2, Y(selLo) - Y(selHi)) : plotH} />
                  <line className="c-cursor" x1={X(selT) + slotW / 2} x2={X(selT) + slotW / 2} y1={T} y2={H - B} />
                </g>
              ) : null}
            </svg>
          ) : null}
        </div>
      )}
      <ul className="key dph-key" aria-label={HEAT_LEGEND_LABEL}>
        {steps ? (
          <>
            {Array.from({ length: HEAT_STEPS }, (_, i) => (
              <li key={i}><i className={`dph-sw dph-sw--${i + 1}`} />{i === HEAT_STEPS - 1 ? legendTop(fmtUsdRule(steps[i])) : legendStep(fmtUsdRule(steps[i]), fmtUsdRule(steps[i + 1]))}</li>
            ))}
            <li><i className="dph-sw dph-sw--blank" />{legendBlank(fmtUsdRule(steps[0]))}</li>
          </>
        ) : null}
        <li><i className="key__ln dph-key-ref" />{keyRef(p.refPool)}</li>
        {trades ? <li><i className="dph-key-trade" />{keyTradesSized(p.tradesDays, symbol)}</li> : null}
        <li><i className="dph-sw dph-sw--gap" />{KEY_GAP}</li>
      </ul>
    </figure>
  );
}

export default HeatChart;
