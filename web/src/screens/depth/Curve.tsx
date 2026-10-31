// View 2, THE BOOK as a curve (depth plan 3.2): the DepthChart over the minute's aggregate curve with the eight size
// marks and the stored trades of the last week, three windows (½× to 2× linear; ⅒× to 10× and everything resting on a
// log axis, said in the axis label), a table view, the key, the sentence saying how many trades fall in the view,
// and one SourceLine for the curve and the trades. Under 1024 px the lead is one sentence (the phone cut, owner 2026-10-30).
import { useMemo, useState } from 'react';
import type { DepthResponse } from '../../../../shared/depth';
import { CHART_VIEW, CURVE_H2, CURVE_LEAD_SHORT, CURVE_RANGES, CURVE_TRADES_DAYS, FLOW_INDEX_PLAIN, LABEL_PRICE_WINDOW, SOURCE_CURVE, SOURCE_STORED_TRADES, SOURCE_THE_CURVE, TABLE_VIEW, curveLead, tradesCut, tradesInView, tradesNone, tradesToggle } from '../../../../shared/depth';
import { FLOW_INDEX_SOURCE } from './data';
import { Button, DepthChart, Segmented, SourceLine, type Stamp } from '../../ui/index';
import type { TradesWeek } from './data';
import { curveWindow, perPoolCurves, poolName, poolsAtPrice, shortSize, sizeMarks, tradeMarks, type CurveRange } from './model';

export interface CurveProps {
  d: DepthResponse;
  symbol: string;
  stamp: Stamp;
  trades: { data: TradesWeek | null; error: string | null; loading: boolean };
  headingId: string;
}

export function Curve({ d, symbol, stamp, trades, headingId }: CurveProps) {
  const [range, setRange] = useState<CurveRange>('near');
  const [table, setTable] = useState(false);
  const [showTrades, setShowTrades] = useState(true);
  const win = useMemo(() => curveWindow(d, range), [d, range]);
  const per = useMemo(() => perPoolCurves(d), [d]);
  const marks = useMemo(() => sizeMarks(d).map((m) => ({ ...m, short: shortSize(m.nam) })), [d]);
  const tw = trades.data;
  const all = useMemo(() => (tw ? tradeMarks(tw.rows, tw.since) : []), [tw]);
  // the chart's y axis is sized to hold every trade priced inside the window (DepthChart), so this count is what is drawn
  const inView = all.filter((t) => t.price >= win.lo && t.price <= win.hi).length;
  const tradesStamp: Stamp | null = tw ? { ...tw.prov, plain: FLOW_INDEX_PLAIN } : trades.error ? { source: FLOW_INDEX_SOURCE, plain: FLOW_INDEX_PLAIN, at: null, status: 'missing', note: trades.error } : null;
  const tradesLine = tw
    ? all.length
      ? `${tradesInView(inView, all.length, CURVE_TRADES_DAYS)}${tw.cut ? ` (${tradesCut(all.length, CURVE_TRADES_DAYS)})` : ''}`
      : tradesNone(CURVE_TRADES_DAYS)
    : trades.error ?? null;

  return (
    <div className="dp-curve" data-prov-scope="">
      <h2 id={headingId} className="h2">{CURVE_H2}</h2>
      <p className="cap dp-lead"><span className="dp-long">{curveLead(symbol)}</span><span className="dp-short">{CURVE_LEAD_SHORT}</span></p>
      <div className="dp-ctl">
        <Segmented label={LABEL_PRICE_WINDOW} variant="range" value={range} onChange={setRange} options={CURVE_RANGES.map((r) => ({ value: r.value, label: r.label }))} />
        <Button size="sm" aria-pressed={table} onClick={() => setTable((v) => !v)}>{table ? CHART_VIEW : TABLE_VIEW}</Button>
        <Button size="sm" aria-pressed={showTrades} onClick={() => setShowTrades((v) => !v)}>{tradesToggle(CURVE_TRADES_DAYS)}</Button>
      </div>
      <DepthChart
        price={d.curve.price}
        bidUsd={d.curve.bidUsd}
        bidNam={d.curve.bidNam}
        askUsd={d.curve.askUsd}
        askNam={d.curve.askNam}
        refUsd={d.ref.usd}
        refPool={d.ref.pool}
        window={win}
        symbol={symbol}
        marks={marks}
        trades={showTrades && tw ? all : null}
        tradesDays={CURVE_TRADES_DAYS}
        poolsAt={(side, price) => poolsAtPrice(d, per, side, price)}
        poolName={(id) => poolName(d, id)}
        table={table}
      />
      {tradesLine ? <p className="cap dp-trades">{tradesLine}</p> : null}
      <SourceLine items={[{ label: SOURCE_THE_CURVE, p: stamp }, ...(tradesStamp ? [{ label: SOURCE_STORED_TRADES, p: tradesStamp }] : [])]} label={SOURCE_CURVE} />
    </div>
  );
}

export default Curve;
