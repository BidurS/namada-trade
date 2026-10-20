// OrderflowChart (Chart 1, Trade screen /trade, Decision D1):
// Live Signed Orderflow & Cumulative Volume Delta (CVD) vs. Price Absorption.
// Plots per-bucket aggressive buy volume (+buyNam above zero) and sell volume (-sellNam below zero),
// overlaid with the running Cumulative Volume Delta (CVD) trajectory and bucket VWAP price, plus
// live WebSocket swap ingestion from `liveFlows`.
import { useMemo, useState } from 'react';
import type { Flow, OrderflowBucket, OrderflowResponse } from '../../../shared/types';
import type { Stamp } from '../lib/prov';
import { fmtDayClock, fmtDayMonth, fmtNamRule, fmtNamSigned, fmtPctRule, fmtPctSigned, fmtUsdRule, fmtUtcClock } from '../lib/format';
import { lin, nearestIndex, niceTicks } from './chartMath';
import { useSize } from './useSize';
import { Segmented } from './Segmented';
import { SourceLine } from './SourceLine';
import { RANGES, type ChartRange } from './PriceChart';
import { namShort, namTick } from './SeriesChart';

const CHAR = 6.6;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthYear = (t: number) => `${MON[new Date(t).getUTCMonth()]} ${new Date(t).getUTCFullYear()}`;

const REGIME_LABELS: Record<OrderflowResponse['absorptionRegime'], { title: string; note: string }> = {
  bid_absorption: {
    title: 'Bid absorption',
    note: 'Net selling absorbed by limit/CL bids with minimal price drop',
  },
  ask_absorption: {
    title: 'Ask absorption',
    note: 'Net buying absorbed by overhead liquidity with muted price lift',
  },
  trend_up: {
    title: 'Buyer-driven lift',
    note: 'Positive cumulative volume delta lifting execution price',
  },
  trend_down: {
    title: 'Seller-driven pressure',
    note: 'Negative cumulative volume delta pressing execution price lower',
  },
  balanced: {
    title: 'Balanced two-way flow',
    note: 'Buy and sell volume roughly matched across the window',
  },
};

export interface OrderflowChartProps {
  data: OrderflowResponse;
  /** Live WebSocket flows so new Osmosis swaps update the rightmost bar and CVD in real time */
  liveFlows?: Flow[];
  range: ChartRange;
  onRange?: (r: ChartRange) => void;
  end?: number;
  cursorAt?: number | null;
  prov?: Stamp | null;
  headingId?: string;
  className?: string;
}

export function OrderflowChart({
  data,
  liveFlows = [],
  range,
  onRange,
  end,
  cursorAt,
  prov,
  headingId = 'h-orderflow',
  className = '',
}: OrderflowChartProps) {
  const [boxRef, { w, h }] = useSize<HTMLDivElement>();
  const [pick, setPick] = useState<number | null>(null);

  // Merge live WebSocket Osmosis swaps newer than `data.asOf` into the bucket series
  const buckets = useMemo<OrderflowBucket[]>(() => {
    const base = data.buckets.map((b) => ({ ...b }));
    const bMs = data.bucketMs || 3_600_000;
    const recentSwaps = liveFlows.filter(
      (f) => f.chain === 'osmosis' && (f.kind === 'buy' || f.kind === 'sell') && f.ts > data.asOf && !(f.meta as any)?.arb,
    );
    if (!recentSwaps.length) return base;

    const byTs = new Map<number, OrderflowBucket>(base.map((b) => [b.ts, b]));
    for (const s of recentSwaps) {
      const bTs = Math.floor(s.ts / bMs) * bMs;
      const cur = byTs.get(bTs) ?? { ts: bTs, buyNam: 0, sellNam: 0, netDeltaNam: 0, cvdNam: 0, vwapUsd: s.priceUsd ?? null, trades: 0 };
      if (s.kind === 'buy') cur.buyNam += s.amount;
      else cur.sellNam += s.amount;
      cur.netDeltaNam = cur.buyNam - cur.sellNam;
      cur.trades += 1;
      if (s.priceUsd && s.priceUsd > 0) cur.vwapUsd = s.priceUsd;
      byTs.set(bTs, cur);
    }
    const sorted = [...byTs.values()].sort((a, b) => a.ts - b.ts);
    let runningCvd = 0;
    for (const b of sorted) {
      runningCvd += b.netDeltaNam;
      b.cvdNam = runningCvd;
    }
    return sorted;
  }, [data.buckets, data.asOf, data.bucketMs, liveFlows]);

  const tEnd = end ?? Math.max(data.asOf, buckets[buckets.length - 1]?.ts ?? 0);
  const tStart = buckets[0]?.ts != null ? Math.min(buckets[0].ts, tEnd - 3_600_000) : tEnd - 86_400_000;
  const actualSpan = Math.max(3_600_000, tEnd - tStart);
  const longSpan = actualSpan > 200 * 86_400_000;

  // ---------------- scales ----------------
  const maxBar = useMemo(() => Math.max(1000, ...buckets.map((b) => Math.max(b.buyNam, b.sellNam, Math.abs(b.cvdNam)))), [buckets]);
  const yT = useMemo(() => niceTicks(-maxBar, maxBar, { maxTicks: 5 }), [maxBar]);
  const yLabels = yT.ticks.map((t) => (t === 0 ? '0' : `${t > 0 ? '+' : ''}${namTick(t, yT.step)}`));
  const L = Math.ceil(Math.max(...yLabels.map((s) => s.length)) * CHAR) + 14;
  const R = 10;
  const T = 18;
  const B = 26;
  const X = lin(tStart, tEnd, L, Math.max(L + 1, w - R));
  const Y = lin(yT.lo, yT.hi, Math.max(T + 1, h - B), T);
  const yZero = Y(0);

  const plotW = Math.max(1, w - L - R);
  const barW = Math.max(2, Math.min(14, Math.floor((plotW / Math.max(8, buckets.length)) * 0.68)));
  const cvdPts = buckets.map((b) => [X(b.ts), Y(b.cvdNam)] as [number, number]);
  const cvdPath = cvdPts.length > 1 ? cvdPts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ') : '';

  const xTicks = [tStart, tStart + actualSpan / 2, tEnd];
  const xFmt = (t: number) => (range === '24h' ? fmtUtcClock(t).replace(' UTC', '') : longSpan ? monthYear(t) : fmtDayMonth(t));

  const last = buckets[buckets.length - 1] ?? null;
  const sel = pick != null && buckets[pick] ? buckets[pick] : null;
  const shown = sel ?? last;

  const setFromX = (clientX: number, el: Element) => {
    if (!buckets.length) return;
    const r = el.getBoundingClientRect();
    setPick(nearestIndex(cvdPts.map((p) => p[0]), clientX - r.left));
  };

  const netCvd = last?.cvdNam ?? data.netCvdNam;
  const totalBuy = buckets.reduce((a, b) => a + b.buyNam, 0);
  const totalSell = buckets.reduce((a, b) => a + b.sellNam, 0);
  const grossVol = totalBuy + totalSell;
  const buyShare = grossVol > 0 ? (totalBuy / grossVol) * 100 : null;
  const regime = REGIME_LABELS[data.absorptionRegime] ?? REGIME_LABELS.balanced;

  const heading = buckets.length
    ? `Cumulative volume delta ${netCvd >= 0 ? '+' : ''}${namShort(netCvd)} NAM (${regime.title.toLowerCase()})`
    : 'No DEX swap orderflow in this window';

  const bucketHours = Math.max(1, Math.round((data.bucketMs || 3_600_000) / 3_600_000));
  const unitLine = `Signed Osmosis swap volume (${bucketHours >= 24 ? 'daily' : `${bucketHours}h`} bars, atomic arb excluded) and running Cumulative Volume Delta (CVD).`;

  const cur = sel ? [X(sel.ts), Y(sel.cvdNam)] : null;
  const atX = cursorAt != null && cursorAt >= tStart && cursorAt <= tEnd ? X(cursorAt) : null;
  const stamp = prov ?? (data.prov ? { ...data.prov, plain: 'Osmosis flow index' } : null);

  return (
    <section className={`chartsec ${className}`} aria-labelledby={headingId} data-prov-scope="">
      <div className="chartsec__top">
        <div className="chartsec__title">
          <h2 id={headingId} className="chartsec__h">{heading}</h2>
          <p className="cap">{unitLine}</p>
        </div>
        {onRange ? <Segmented label="Chart range" variant="range" value={range} options={RANGES} onChange={onRange} /> : null}
      </div>

      <p className="readout" aria-live="polite">
        {shown ? (
          <>
            <span className="readout__k">{sel ? 'Bucket CVD' : 'Running CVD'}</span>{' '}
            <b data-num="" className="readout__v">{fmtNamSigned(shown.cvdNam)}<span className="u"> NAM</span></b>{' '}
            <span className="readout__t">
              (buy <span data-num="">+{fmtNamRule(shown.buyNam)}</span> · sell <span data-num="">−{fmtNamRule(shown.sellNam)}</span>
              {shown.vwapUsd != null ? <> · VWAP <span data-num="">{fmtUsdRule(shown.vwapUsd)}</span></> : null} · {fmtDayClock(shown.ts)})
            </span>
          </>
        ) : (
          <span className="readout__k">No directional swaps recorded in this window.</span>
        )}
      </p>

      <div
        ref={boxRef}
        className="chart-box"
        tabIndex={buckets.length ? 0 : -1}
        role="group"
        aria-label={buckets.length ? `${heading}. Press and drag, or use the arrow keys, to inspect each orderflow bucket.` : heading}
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
          if (!buckets.length) return;
          const i = pick ?? buckets.length - 1;
          if (e.key === 'ArrowLeft') setPick(Math.max(0, i - 1));
          else if (e.key === 'ArrowRight') setPick(Math.min(buckets.length - 1, i + 1));
          else if (e.key === 'Home') setPick(0);
          else if (e.key === 'End') setPick(buckets.length - 1);
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
                <line className={t === 0 ? 'c-axis' : 'c-grid'} x1={L} x2={w - R} y1={Y(t)} y2={Y(t)} />
                <text className="c-tick" x={L - 8} y={Y(t) + 4} textAnchor="end">{yLabels[i]}</text>
              </g>
            ))}
            {xTicks.map((t, i) => (
              <text key={i} className="c-tick" x={X(t)} y={h - 6} textAnchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}>{xFmt(t)}</text>
            ))}
            {buckets.map((b, i) => {
              const x = X(b.ts) - barW / 2;
              const yBuy = Y(b.buyNam);
              const hBuy = Math.max(0, yZero - yBuy);
              const ySell = Y(-b.sellNam);
              const hSell = Math.max(0, ySell - yZero);
              return (
                <g key={b.ts} opacity={pick == null || pick === i ? 0.85 : 0.4}>
                  {hBuy > 0.5 ? <rect className="c-bar-buy" x={x} y={yBuy} width={barW} height={hBuy} rx={1} /> : null}
                  {hSell > 0.5 ? <rect className="c-bar-sell" x={x} y={yZero} width={barW} height={hSell} rx={1} /> : null}
                </g>
              );
            })}
            {atX != null ? <line className="c-at" x1={atX} x2={atX} y1={T} y2={h - B} /> : null}
            {cvdPts.length > 1 ? (
              <g className="c-wipe">
                <path className="c-exec" d={cvdPath} />
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
        <li><i className="key__sw key__sw--buy" />Aggressive buys (+NAM)</li>
        <li><i className="key__sw key__sw--sell" />Aggressive sells (−NAM)</li>
        <li><i className="key__ln" />Cumulative Volume Delta (CVD)</li>
      </ul>

      <dl className="cstats">
        <div>
          <dt>Net CVD</dt>
          <dd data-num="">
            {fmtNamSigned(netCvd)} NAM
            <small>{data.priceChangePct != null ? `VWAP ${fmtPctSigned(data.priceChangePct, 1)}` : 'Across window'}</small>
          </dd>
        </div>
        <div>
          <dt>Gross volume</dt>
          <dd data-num="">
            {fmtNamRule(grossVol)} NAM
            <small>{buckets.reduce((a, b) => a + b.trades, 0).toLocaleString('en-US')} non-arb swaps</small>
          </dd>
        </div>
        <div>
          <dt>Buyer share</dt>
          <dd data-num="">
            {buyShare != null ? fmtPctRule(buyShare, 1) : '—'}
            <small>+{namShort(totalBuy)} vs −{namShort(totalSell)}</small>
          </dd>
        </div>
        <div>
          <dt>Orderflow regime</dt>
          <dd>
            {regime.title}
            <small>{regime.note}</small>
          </dd>
        </div>
      </dl>

      {stamp ? <SourceLine items={[{ label: 'Osmosis swap orderflow & CVD', p: stamp }]} label="Where the orderflow chart comes from" /> : null}
    </section>
  );
}

export default OrderflowChart;
