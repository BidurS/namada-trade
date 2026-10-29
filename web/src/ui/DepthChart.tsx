// DepthChart (depth plan 3.2, view 2 "Curve"; the chart rules of system.md 7.2): price across in USD per coin,
// cumulative USD up, one y axis only. Left of the reference line the bid curve (the USD received selling down to a
// price), right of it the ask curve (the USD paid buying up to it), each in its validated hue (the site's --buy and
// --sell, depth plan 3.4) with a light fill; the eight size marks labelled ("10k → $9.92"); the stored trades of
// the last week as neutral diamonds in --c-ink-2 with a shape and a legend, never a third hue; the reference price
// as a hairline in --c-mark; the y axis is sized to hold every mark and every trade priced inside the window, so what
// the sentence under the chart counts is what is drawn. Log x on the wide ranges, said in the axis label. Press and drag, or the arrow keys,
// read the nearest curve point into a fixed readout above the plot (price, USD, coins, the pools at that price);
// never a tooltip over the data. Container-measured SVG (ticks exactly 11 px); a table view of the same points.
import { useId, useMemo, useState } from 'react';
import { AXIS_USD, CHART_GROUP_LABEL, NO_POINT_IN_WINDOW, READOUT_AT, READOUT_NONE, axisPrice, chartAria, chartSummary, keyAsks, keyBids, keyRef, keyTrades, readoutWords, sizeMark, tradeTitle } from '../../../shared/depth';
import { fmtCoin, fmtDayClock, fmtNamRule, fmtSig, fmtUsdRule } from '../lib/format';
import { niceTicks, pathOf, stackBoxes, tickLabel, type LabelBox } from './chartMath';
import { useSize } from './useSize';

export interface DepthChartMark {
  side: 'sell' | 'buy';
  nam: number;
  price: number;
  usd: number;
  /** "10k" */
  short: string;
}
export interface DepthChartTrade {
  id: string;
  t: number;
  kind: 'buy' | 'sell';
  price: number;
  usd: number;
  nam: number;
}
export interface DepthChartProps {
  /** The aggregate curve: prices ascending, each cumulative figure at that price. */
  price: number[];
  bidUsd: number[];
  bidNam: number[];
  askUsd: number[];
  askNam: number[];
  /** The reference price and the pool it is read from. */
  refUsd: number;
  refPool: string;
  /** The window drawn, and whether its x axis is a log scale (said in the axis label). */
  window: { lo: number; hi: number; log: boolean };
  symbol: string;
  marks: DepthChartMark[];
  /** The stored trades to draw (null: none loaded); the sentence under the key says how many fall in the window. */
  trades: DepthChartTrade[] | null;
  tradesDays: number;
  /** The pools whose figure grows at a price, for the readout. */
  poolsAt: (side: 'bid' | 'ask', price: number) => string[];
  poolName: (id: string) => string;
  /** The table view instead of the plot. */
  table?: boolean;
  className?: string;
}

const CHAR = 6.6;
const TABLE_ROWS_MAX = 60;
/** A mark's label sits this far from its dot, and the rows of stacked labels are this far apart. */
const LABEL_DX = 6, LABEL_DY = 6, ROW_H = 13;

export function DepthChart(p: DepthChartProps) {
  const { price, bidUsd, bidNam, askUsd, askNam, refUsd, window: win, symbol, marks, trades, poolsAt, poolName } = p;
  const id = useId();
  const [boxRef, { w }] = useSize<HTMLDivElement>();
  const H = w >= 640 ? 288 : 232;
  const L = 52, R = 12, T = 16, B = 30;
  const [pick, setPick] = useState<number | null>(null);
  const [drag, setDrag] = useState(false);

  // the points inside the window, by index into the curve
  const inWin = useMemo(() => {
    const out: number[] = [];
    for (let i = 0; i < price.length; i++) if (price[i] >= win.lo && price[i] <= win.hi) out.push(i);
    return out;
  }, [price, win.lo, win.hi]);
  const bidIdx = inWin.filter((i) => price[i] <= refUsd);
  const askIdx = inWin.filter((i) => price[i] >= refUsd);
  const inPrice = <T extends { price: number }>(xs: T[]) => xs.filter((m) => m.price >= win.lo && m.price <= win.hi);
  const visMarks = inPrice(marks);
  // the trades priced inside the window are all drawn: the axis grows to hold the largest of them
  const visTrades = inPrice(trades ?? []);
  const yMax = Math.max(0, ...bidIdx.map((i) => bidUsd[i]), ...askIdx.map((i) => askUsd[i]), ...visMarks.map((m) => m.usd), ...visTrades.map((t) => t.usd));
  const yT = niceTicks(0, yMax > 0 ? yMax * 1.04 : 1, { zero: true, maxTicks: 5 });
  const xf = win.log ? Math.log : (x: number) => x;
  const x0 = xf(win.lo), x1 = xf(win.hi);
  const X = (v: number) => L + ((xf(Math.min(win.hi, Math.max(win.lo, v))) - x0) / (x1 - x0 || 1)) * (w - L - R);
  const Y = (v: number) => T + (1 - v / (yT.hi || 1)) * (H - T - B);
  const bidPts = bidIdx.map((i) => [X(price[i]), Y(bidUsd[i])] as [number, number]);
  const askPts = askIdx.map((i) => [X(price[i]), Y(askUsd[i])] as [number, number]);
  const area = (pts: [number, number][]) => (pts.length > 1 ? `${pathOf(pts)}L${pts[pts.length - 1][0].toFixed(1)} ${Y(0).toFixed(1)}L${pts[0][0].toFixed(1)} ${Y(0).toFixed(1)}Z` : '');
  // x ticks: 1-2-5 on a linear axis, powers and halves on a log one
  const xTicks = useMemo(() => {
    if (!win.log) return niceTicks(win.lo, win.hi, { maxTicks: w >= 640 ? 6 : 4 }).ticks.filter((t) => t >= win.lo && t <= win.hi);
    const out: number[] = [];
    for (let e = Math.floor(Math.log10(win.lo)); e <= Math.ceil(Math.log10(win.hi)); e++) for (const m of [1, 2, 5]) { const v = m * 10 ** e; if (v >= win.lo && v <= win.hi) out.push(v); }
    return out.length > 7 ? out.filter((_, i) => i % 2 === 0) : out;
  }, [win.lo, win.hi, win.log, w]);
  // the reference line's label, placed first, so no mark label lands on it
  const refIn = refUsd >= win.lo && refUsd <= win.hi;
  const refText = `${keyRef(p.refPool)} ${fmtSig(refUsd)}`;
  const refEnd = refIn && X(refUsd) > w - 120;
  const refBox: LabelBox = refEnd ? { x0: X(refUsd) - 4 - refText.length * CHAR, x1: X(refUsd) - 4, y: T + 10 } : { x0: X(refUsd) + 4, x1: X(refUsd) + 4 + refText.length * CHAR, y: T + 10 };
  // a bid mark's label sits to its left, an ask mark's to its right, so the two marks of one size never share a spot; the plot's edges win.
  // The side is chosen first and the final box is stacked, so a label moved across its mark is checked against its neighbours where it lands.
  const markLabels = visMarks.map((m) => {
    const cx = X(m.price), cy = Y(m.usd);
    const text = sizeMark(m.short, fmtUsdRule(m.usd));
    const tw = text.length * CHAR;
    const left = m.side === 'sell' ? cx - LABEL_DX - tw >= L : cx + LABEL_DX + tw > w - R;
    const x0 = left ? cx - LABEL_DX - tw : cx + LABEL_DX;
    return { m, cx, cy, text, left, box: { x0, x1: x0 + tw, y: cy - LABEL_DY } };
  });
  const markRows = stackBoxes(markLabels.map((l) => l.box), ROW_H, 8, refIn ? [refBox] : []);

  // ---- the readout: the nearest curve point to a pointer or the picked index
  const nearest = (clientX: number, el: HTMLElement): number | null => {
    const r = el.getBoundingClientRect();
    const x = clientX - r.left;
    let best: number | null = null, bd = Infinity;
    for (const i of inWin) { const d = Math.abs(X(price[i]) - x); if (d < bd) { bd = d; best = i; } }
    return best;
  };
  const sel = pick != null && inWin.includes(pick) ? pick : null;
  const selSide: 'bid' | 'ask' | null = sel == null ? null : price[sel] <= refUsd ? 'bid' : 'ask';
  const selUsd = sel == null ? null : selSide === 'bid' ? bidUsd[sel] : askUsd[sel];
  const selNam = sel == null ? null : selSide === 'bid' ? bidNam[sel] : askNam[sel];
  const selPools = sel != null && selSide ? poolsAt(selSide, price[sel]) : [];
  const step = (dir: 1 | -1) => {
    if (!inWin.length) return;
    const k = sel == null ? (dir > 0 ? 0 : inWin.length - 1) : Math.max(0, Math.min(inWin.length - 1, inWin.indexOf(sel) + dir));
    setPick(inWin[k]);
  };

  const aria = chartAria(win.log ? 'log' : 'linear', fmtSig(win.lo), fmtSig(win.hi), symbol, visMarks.length, visTrades.length);
  const tableRows = useMemo(() => {
    const every = Math.max(1, Math.ceil(inWin.length / TABLE_ROWS_MAX));
    return inWin.filter((_, k) => k % every === 0 || k === inWin.length - 1);
  }, [inWin]);

  return (
    <figure className={`dp-chart ${p.className ?? ''}`} aria-labelledby={`${id}c`}>
      <figcaption id={`${id}c`} className="sr-only">{aria}</figcaption>
      <p className="readout" aria-live="polite">
        {sel != null && selSide && selUsd != null && selNam != null ? (
          <>
            <span className="readout__k">{READOUT_AT}</span>{' '}
            <b data-num="" className="readout__v">{fmtSig(price[sel])}</b>{' '}
            <span className="readout__t">{readoutWords(selSide, fmtUsdRule(selUsd), fmtNamRule(selNam), symbol)}{selPools.length ? ` · ${selPools.map(poolName).join(', ')}` : ''}</span>
          </>
        ) : (
          <span className="readout__k">{READOUT_NONE}</span>
        )}
      </p>
      {p.table ? (
        <div className="dp-table" role="table" aria-label={aria}>
          <div className="dp-trow dp-trow--head" role="row">
            <span role="columnheader">{axisPrice(symbol, false)}</span>
            <span role="columnheader">{keyBids(symbol)}</span>
            <span role="columnheader">{symbol}</span>
            <span role="columnheader">{keyAsks(symbol)}</span>
            <span role="columnheader">{symbol}</span>
          </div>
          {tableRows.map((i) => (
            <div key={i} className={`dp-trow${price[i] <= refUsd ? ' dp-trow--bid' : ' dp-trow--ask'}`} role="row">
              <span role="cell" data-num="">{fmtSig(price[i])}</span>
              <span role="cell" data-num="">{price[i] <= refUsd ? fmtUsdRule(bidUsd[i]) : '—'}</span>
              <span role="cell" data-num="">{price[i] <= refUsd ? fmtNamRule(bidNam[i]) : '—'}</span>
              <span role="cell" data-num="">{price[i] >= refUsd ? fmtUsdRule(askUsd[i]) : '—'}</span>
              <span role="cell" data-num="">{price[i] >= refUsd ? fmtNamRule(askNam[i]) : '—'}</span>
            </div>
          ))}
        </div>
      ) : (
        <div
          className="chart-box dp-chart__plot"
          ref={boxRef}
          style={{ height: H }}
          tabIndex={inWin.length ? 0 : -1}
          role="group"
          aria-label={CHART_GROUP_LABEL}
          onPointerDown={(e) => { setDrag(true); setPick(nearest(e.clientX, e.currentTarget)); e.currentTarget.setPointerCapture?.(e.pointerId); }}
          onPointerMove={(e) => { if (drag || e.pointerType === 'mouse') setPick(nearest(e.clientX, e.currentTarget)); }}
          onPointerUp={() => setDrag(false)}
          onPointerCancel={() => setDrag(false)}
          onPointerLeave={() => { if (!drag) setPick(null); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); step(1); }
            else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); step(-1); }
            else if (e.key === 'Home') { e.preventDefault(); setPick(inWin[0] ?? null); }
            else if (e.key === 'End') { e.preventDefault(); setPick(inWin[inWin.length - 1] ?? null); }
            else if (e.key === 'Escape') setPick(null);
          }}
        >
          {w > 0 && inWin.length ? (
            <svg width={w} height={H} viewBox={`0 0 ${w} ${H}`} role="img" aria-label={aria}>
              {yT.ticks.map((t) => (
                <g key={t}>
                  <line className="c-grid" x1={L} x2={w - R} y1={Y(t)} y2={Y(t)} />
                  <text className="c-tick" x={L - 8} y={Y(t) + 4} textAnchor="end">{tickLabel(t, yT.step, '').replace(/^/, '$')}</text>
                </g>
              ))}
              <line className="c-axis" x1={L} x2={w - R} y1={H - B} y2={H - B} />
              {xTicks.map((t, i) => (
                <text key={t} className="c-tick" x={X(t)} y={H - B + 16} textAnchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'}>{fmtSig(t, 4)}</text>
              ))}
              <text className="c-tick" x={w - R} y={H - 4} textAnchor="end">{axisPrice(symbol, win.log)}</text>
              <text className="c-tick" x={L} y={T - 4} textAnchor="start">{AXIS_USD}</text>
              {bidPts.length > 1 ? <path className="dpc-bid-area" d={area(bidPts)} /> : null}
              {askPts.length > 1 ? <path className="dpc-ask-area" d={area(askPts)} /> : null}
              {bidPts.length > 1 ? <path className="dpc-bid" d={pathOf(bidPts)} /> : null}
              {askPts.length > 1 ? <path className="dpc-ask" d={pathOf(askPts)} /> : null}
              {visTrades.map((t) => {
                const cx = X(t.price), cy = Y(t.usd);
                return <path key={t.id} className="dpc-trade" d={`M${cx} ${cy - 4}L${cx + 4} ${cy}L${cx} ${cy + 4}L${cx - 4} ${cy}Z`}><title>{tradeTitle(t.kind, fmtNamRule(t.nam), symbol, fmtSig(t.price), fmtUsdRule(t.usd), fmtDayClock(t.t))}</title></path>;
              })}
              {refIn ? (
                <g>
                  <line className="dpc-ref" x1={X(refUsd)} x2={X(refUsd)} y1={T} y2={H - B} />
                  <text className="c-evtl dpc-ref-l" x={refEnd ? X(refUsd) - 4 : X(refUsd) + 4} y={T + 10} textAnchor={refEnd ? 'end' : 'start'}>{refText}</text>
                </g>
              ) : null}
              {markLabels.map(({ m, cx, cy, text, left }, k) => (
                <g key={`${m.side}${m.nam}`}>
                  <circle className={m.side === 'sell' ? 'dpc-mark-bid' : 'dpc-mark-ask'} cx={cx} cy={cy} r={4} />
                  <text className="c-evtl dpc-mark-l" x={left ? cx - LABEL_DX : cx + LABEL_DX} y={cy - LABEL_DY - markRows[k] * ROW_H} textAnchor={left ? 'end' : 'start'}>{text}</text>
                </g>
              ))}
              {sel != null && selUsd != null ? (
                <g>
                  <line className="c-cursor" x1={X(price[sel])} x2={X(price[sel])} y1={T} y2={H - B} />
                  <circle className="c-cursor-dot" cx={X(price[sel])} cy={Y(selUsd)} r={5} />
                </g>
              ) : null}
            </svg>
          ) : null}
        </div>
      )}
      <ul className="key dp-key">
        <li><i className="key__ln dpc-key-bid" />{keyBids(symbol)}</li>
        <li><i className="key__ln dpc-key-ask" />{keyAsks(symbol)}</li>
        {trades ? <li><i className="dpc-key-trade" />{keyTrades(p.tradesDays)}</li> : null}
        <li><i className="key__ln key__ln--evt" />{keyRef(p.refPool)}</li>
      </ul>
      <p className="sr-only">
        {inWin.length ? chartSummary(fmtCoin(bidUsd[bidIdx[0] ?? 0] ?? 0), fmtSig(price[bidIdx[0] ?? 0] ?? win.lo), fmtCoin(askUsd[askIdx[askIdx.length - 1] ?? 0] ?? 0), fmtSig(price[askIdx[askIdx.length - 1] ?? 0] ?? win.hi)) : NO_POINT_IN_WINDOW}
      </p>
    </figure>
  );
}

export default DepthChart;
