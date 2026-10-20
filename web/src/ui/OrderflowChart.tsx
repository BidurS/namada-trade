// OrderflowChart: what was bought and sold on Osmosis over a window (the Trade screen's second
// chart). Two plots share one x axis and each has its own y axis (never a dual axis, system.md 7.2):
// above, bars of NAM bought (up from zero) and NAM sold (down from zero) per span; below, the running
// total of bought minus sold since the start of the window. The server leaves bot trades out. Swaps
// from the live stream newer than the index's time are added to the last spans, and the SourceLine
// then names both sources with their own ages. Words are plain first with the expert term on tap
// (glossary "net-bought", "average-price"); every figure is in the section's scope; no label judges
// the flow, the chart says what happened. Press and drag, or the arrow keys, read one bar at a time
// into the readout above the plot; the plot never dims the other bars.
import { useMemo, useState } from 'react';
import type { Flow, OrderflowBucket, OrderflowResponse } from '../../../shared/types';
import type { Stamp } from '../lib/prov';
import { fmtCount, fmtDayClock, fmtDayMonth, fmtNamRule, fmtNamSigned, fmtPctRule, fmtPctSigned, fmtUsdRule, fmtUtcClock } from '../lib/format';
import { lin, nearestIndex, niceTicks } from './chartMath';
import { DAY_MS, HOUR_MS, SPARSE_SHARE, spanWords, spansWords } from './chartConst';
import { useSize } from './useSize';
import { Segmented } from './Segmented';
import { SourceLine } from './SourceLine';
import { Term } from './Term';
import { Num } from './Num';
import { RANGES, RANGE_MS, type ChartRange } from './PriceChart';
import { namShort, namTick } from './SeriesChart';

const CHAR = 6.6; // JetBrains Mono at 11 px
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthYear = (t: number) => `${MON[new Date(t).getUTCMonth()]} ${new Date(t).getUTCFullYear()}`;

/**
 * The server's reading of the whole fetched window (OrderflowResponse.absorptionRegime), said as what
 * happened. Shown only when the chart shows that whole window; the figures it rests on are in the strip.
 */
const WINDOW_WORDS: Record<OrderflowResponse['absorptionRegime'], string> = {
  bid_absorption: 'More NAM was sold than bought over this window, and the average price changed little.',
  ask_absorption: 'More NAM was bought than sold over this window, and the average price changed little.',
  trend_up: 'More NAM was bought than sold over this window, and the average price rose.',
  trend_down: 'More NAM was sold than bought over this window, and the average price fell.',
  balanced: 'Buying and selling were roughly matched over this window.',
};

/** A series that came without its stamp: its age is not known, and the line says so. */
const NO_STAMP: Stamp = { source: 'D1 flow index', plain: 'Flow index', at: null, status: 'missing', note: 'The series came without its time stamp, so its age is not known.' };

/** A signed NAM tick label with the true minus. */
const signedTick = (t: number, step: number) => (t === 0 ? '0' : t > 0 ? `+${namTick(t, step)}` : `−${namTick(-t, step)}`);

export interface OrderflowChartProps {
  data: OrderflowResponse;
  /** Flows from the live stream: Osmosis swaps newer than `data.asOf` are added to the last spans. */
  liveFlows?: Flow[];
  range: ChartRange;
  onRange?: (r: ChartRange) => void;
  /** The window end (now, or the rewound time). Default: the index's time, or the last span. */
  end?: number;
  /** A cursor at the rewound time (?at=). */
  cursorAt?: number | null;
  /** The series' stamp (the screen may age it out after a failed refresh). Default: the response's. */
  prov?: Stamp | null;
  headingId?: string;
  className?: string;
}

export function OrderflowChart({ data, liveFlows = [], range, onRange, end, cursorAt, prov, headingId = 'h-flow', className = '' }: OrderflowChartProps) {
  const [boxRef, { w, h }] = useSize<HTMLDivElement>();
  const [pick, setPick] = useState<number | null>(null);
  // The span of a bar: the server's bucketMs; without it, the largest step all the bars' times share (never an
  // assumed hour). With fewer than two bars and no bucketMs the span is not known, and no words depend on it.
  const spanKnownMs = useMemo(() => {
    if (data.bucketMs > 0) return data.bucketMs;
    const ts = [...new Set(data.buckets.map((b) => b.ts).filter((t) => Number.isFinite(t)))].sort((a, b) => a - b);
    const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
    let g = 0;
    for (let i = 1; i < ts.length; i++) g = gcd(g, Math.round((ts[i] - ts[i - 1]) / 60_000));
    return g > 0 ? g * 60_000 : null;
  }, [data.bucketMs, data.buckets]);
  const spanKnown = spanKnownMs != null;
  const bMs = spanKnownMs ?? HOUR_MS;
  const spanW = spanWords(bMs);
  const perSpan = spanKnown ? ` per ${spanW}` : '';

  // ---------------- the series: the index, plus swaps from the live stream newer than its time ----------------
  const live = useMemo(() => {
    const swaps = liveFlows.filter((f) => f.chain === 'osmosis' && (f.kind === 'buy' || f.kind === 'sell') && f.ts > data.asOf && !(f.meta as { arb?: boolean } | undefined)?.arb);
    return { swaps, count: swaps.length, newest: swaps.reduce((a, f) => Math.max(a, f.ts), 0) };
  }, [liveFlows, data.asOf]);

  const all = useMemo<OrderflowBucket[]>(() => {
    const base = data.buckets.map((b) => ({ ...b }));
    if (!live.swaps.length) return base;
    const byTs = new Map(base.map((b) => [b.ts, b]));
    // a span the index did not have yet gets its average price from the priced live swaps; a span it had keeps the server's
    const priced = new Map<number, { usd: number; nam: number }>();
    for (const s of live.swaps) {
      const t = Math.floor(s.ts / bMs) * bMs;
      const had = byTs.has(t);
      const cur = byTs.get(t) ?? { ts: t, buyNam: 0, sellNam: 0, netDeltaNam: 0, cvdNam: 0, vwapUsd: null, trades: 0 };
      if (s.kind === 'buy') cur.buyNam += s.amount;
      else cur.sellNam += s.amount;
      cur.netDeltaNam = cur.buyNam - cur.sellNam;
      cur.trades += 1;
      if (!had && s.priceUsd && s.priceUsd > 0 && s.amount > 0) {
        const p = priced.get(t) ?? { usd: 0, nam: 0 };
        p.usd += s.priceUsd * s.amount;
        p.nam += s.amount;
        priced.set(t, p);
        cur.vwapUsd = p.usd / p.nam;
      }
      byTs.set(t, cur);
    }
    return [...byTs.values()].sort((a, b) => a.ts - b.ts);
  }, [data.buckets, live.swaps, bMs]);

  // ---------------- the window: the picked range inside the fetched one ----------------
  const tEnd = end ?? Math.max(data.asOf, all[all.length - 1]?.ts ?? 0);
  const fetchedStart = data.asOf - (data.hours > 0 ? data.hours : 24 * 30) * HOUR_MS;
  const spanMs = RANGE_MS[range];
  const tStart = spanMs != null ? Math.max(fetchedStart, tEnd - spanMs) : fetchedStart;
  /** The chart shows the whole fetched window (so the server's reading of it applies). */
  const whole = spanMs == null || tEnd - spanMs <= fetchedStart + bMs;
  const actualSpan = Math.max(bMs, tEnd - tStart);
  const longSpan = actualSpan > 200 * DAY_MS;

  // the running total restarts at the window's start
  const buckets = useMemo(() => {
    let run = 0;
    return all
      .filter((b) => b.ts + bMs > tStart && b.ts <= tEnd)
      .map((b) => {
        run += b.netDeltaNam;
        return { ...b, cvdNam: run };
      });
  }, [all, bMs, tStart, tEnd]);

  // ---------------- figures (sums over the shown spans) ----------------
  const totalBuy = buckets.reduce((a, b) => a + b.buyNam, 0);
  const totalSell = buckets.reduce((a, b) => a + b.sellNam, 0);
  const gross = totalBuy + totalSell;
  const net = totalBuy - totalSell;
  const trades = buckets.reduce((a, b) => a + b.trades, 0);
  const buyShare = gross > 0 ? (totalBuy / gross) * 100 : null;
  const pricedSpans = buckets.filter((b) => b.vwapUsd != null && b.vwapUsd > 0);
  const firstPx = pricedSpans[0]?.vwapUsd ?? null;
  const lastPx = pricedSpans[pricedSpans.length - 1]?.vwapUsd ?? null;
  const priceChange = firstPx != null && lastPx != null && firstPx > 0 ? ((lastPx - firstPx) / firstPx) * 100 : null;
  const slots = Math.max(1, Math.round(actualSpan / bMs));
  const withSwaps = new Set(buckets.map((b) => Math.floor(b.ts / bMs))).size;

  // ---------------- scales: one y axis per plot ----------------
  const maxBuy = Math.max(0, ...buckets.map((b) => b.buyNam));
  const maxSell = Math.max(0, ...buckets.map((b) => b.sellNam));
  const yA = niceTicks(-maxSell, maxBuy, { maxTicks: 5 });
  const runs = buckets.map((b) => b.cvdNam);
  const yB = niceTicks(Math.min(0, ...runs), Math.max(0, ...runs), { maxTicks: 3 });
  const labA = yA.ticks.map((t) => signedTick(t, yA.step));
  const labB = yB.ticks.map((t) => signedTick(t, yB.step));
  const L = Math.ceil(Math.max(...[...labA, ...labB].map((s) => s.length)) * CHAR) + 14;
  const R = 10;
  const T = 16;
  const B = 24;
  const G = 26; // the gap between the plots holds the lower plot's name
  const plotH = Math.max(40, h - T - B - G);
  const topH = Math.round(plotH * 0.6);
  const botTop = T + topH + G;
  const X = lin(tStart, tEnd, L, Math.max(L + 1, w - R));
  const YA = lin(yA.lo, yA.hi, T + topH, T);
  const YB = lin(yB.lo, yB.hi, h - B, botTop);
  const zeroA = YA(0);

  const plotW = Math.max(1, w - L - R);
  const barW = Math.max(2, Math.min(14, Math.floor((plotW / Math.max(8, slots)) * 0.68)));
  const mid = (b: OrderflowBucket) => X(b.ts + bMs / 2);
  const runPts = buckets.map((b) => [mid(b), YB(b.cvdNam)] as [number, number]);
  const runPath = runPts.length > 1 ? runPts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ') : '';

  const xTicks = [tStart, tStart + actualSpan / 2, tEnd];
  const xFmt = (t: number) => (range === '24h' ? fmtUtcClock(t).replace(' UTC', '') : longSpan ? monthYear(t) : fmtDayMonth(t));

  // ---------------- readout ----------------
  const last = buckets[buckets.length - 1] ?? null;
  const sel = pick != null && buckets[pick] ? buckets[pick] : null;
  const shown = sel ?? last;
  const setFromX = (clientX: number, el: Element) => {
    if (!buckets.length) return;
    const r = el.getBoundingClientRect();
    setPick(nearestIndex(runPts.map((p) => p[0]), clientX - r.left));
  };
  const when = (b: OrderflowBucket) => (bMs >= DAY_MS ? fmtDayMonth(b.ts) : fmtDayClock(b.ts));

  // ---------------- words ----------------
  const since = fmtDayMonth(tStart);
  const headingText = !buckets.length
    ? 'No swaps recorded in this window'
    : net > 0
      ? `${namShort(net)} NAM more bought than sold since ${since}`
      : net < 0
        ? `${namShort(-net)} NAM more sold than bought since ${since}`
        : `As much NAM bought as sold since ${since}`;
  const heading = !buckets.length ? (
    headingText
  ) : net > 0 ? (
    <>
      <Num v={net} fmt={namShort} /> NAM more bought than sold since {since}
    </>
  ) : net < 0 ? (
    <>
      <Num v={-net} fmt={namShort} /> NAM more sold than bought since {since}
    </>
  ) : (
    headingText
  );
  const unitLine = `NAM bought and sold on Osmosis${perSpan}, bot trades left out, and the running total of bought minus sold.`;

  // ---------------- stamps ----------------
  const indexStamp: Stamp = prov ?? (data.prov ? { ...data.prov, plain: 'Flow index' } : NO_STAMP);
  const liveStamp: Stamp | null = live.count
    ? { source: 'live stream', plain: 'Live stream', at: live.newest, status: 'live', note: `${fmtCount(live.count)} ${live.count === 1 ? 'swap' : 'swaps'} from the live stream, newer than the index, ${live.count === 1 ? 'is' : 'are'} added to the last spans.` }
    : null;
  const scope = [
    { label: `NAM bought and sold${perSpan}, and the running total`, p: indexStamp },
    ...(liveStamp ? [{ label: 'Swaps since the index was read', p: liveStamp }] : []),
  ];

  const cur = sel ? [mid(sel), YB(sel.cvdNam)] : null;
  const atX = cursorAt != null && cursorAt >= tStart && cursorAt <= tEnd ? X(cursorAt) : null;
  const first = buckets[0] ?? null;
  const lowRun = buckets.length ? Math.min(...runs) : null;
  const highRun = buckets.length ? Math.max(...runs) : null;

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
            <span className="readout__k">{sel ? 'Bought minus sold, up to this span' : 'Bought minus sold so far'}</span>{' '}
            <b data-num="" className="readout__v">
              {fmtNamSigned(shown.cvdNam)}
              <span className="u"> NAM</span>
            </b>{' '}
            <span className="readout__t">
              (bought <span data-num="">{fmtNamRule(shown.buyNam)}</span> · sold <span data-num="">{fmtNamRule(shown.sellNam)}</span>
              {shown.vwapUsd != null ? <> · average price <span data-num="">{fmtUsdRule(shown.vwapUsd)}</span></> : null} · {when(shown)})
            </span>
          </>
        ) : (
          <span className="readout__k">No swap recorded in this window.</span>
        )}
      </p>

      {/* no swaps: nothing to draw, and no scale is made up for it (the heading and the readout say so) */}
      {buckets.length ? (
      <div
        ref={boxRef}
        className="chart-box chart-box--two"
        tabIndex={buckets.length ? 0 : -1}
        role="group"
        aria-label={buckets.length ? `${headingText}. Press and drag, or use the arrow keys, to read each bar.` : headingText}
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
            {/* the upper plot: bought up, sold down, per span */}
            <text className="c-tick" x={L} y={T - 5}>bought and sold{perSpan}</text>
            {yA.ticks.map((t, i) => (
              <g key={`a${t}`}>
                <line className={t === 0 ? 'c-axis' : 'c-grid'} x1={L} x2={w - R} y1={YA(t)} y2={YA(t)} />
                <text className="c-tick" x={L - 8} y={YA(t) + 4} textAnchor="end">{labA[i]}</text>
              </g>
            ))}
            {buckets.map((b, i) => {
              const x = mid(b) - barW / 2;
              const yBuy = YA(b.buyNam);
              const hBuy = Math.max(0, zeroA - yBuy);
              const ySell = YA(-b.sellNam);
              const hSell = Math.max(0, ySell - zeroA);
              const on = pick === i ? ' is-pick' : '';
              return (
                <g key={b.ts}>
                  {hBuy > 0.5 ? <rect className={`c-bar-buy${on}`} x={x} y={yBuy} width={barW} height={hBuy} rx={1} /> : null}
                  {hSell > 0.5 ? <rect className={`c-bar-sell${on}`} x={x} y={zeroA} width={barW} height={hSell} rx={1} /> : null}
                </g>
              );
            })}
            {/* the lower plot: the running total of bought minus sold */}
            <text className="c-tick" x={L} y={botTop - 7}>bought minus sold, running total</text>
            {yB.ticks.map((t, i) => (
              <g key={`b${t}`}>
                <line className={t === 0 ? 'c-axis' : 'c-grid'} x1={L} x2={w - R} y1={YB(t)} y2={YB(t)} />
                <text className="c-tick" x={L - 8} y={YB(t) + 4} textAnchor="end">{labB[i]}</text>
              </g>
            ))}
            {runPts.length > 1 ? (
              <g className="c-wipe">
                <path className="c-exec" d={runPath} />
              </g>
            ) : null}
            {runPts.length <= 2 ? runPts.map(([x, y], i) => <circle key={`r${i}`} className="c-exec-dot" cx={x} cy={y} r={3.5} />) : null}
            {xTicks.map((t, i) => (
              <text key={`x${i}`} className="c-tick" x={X(t)} y={h - 6} textAnchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}>{xFmt(t)}</text>
            ))}
            {atX != null ? <line className="c-at" x1={atX} x2={atX} y1={T} y2={h - B} /> : null}
            {cur ? (
              <>
                <line className="c-cursor" x1={cur[0]} x2={cur[0]} y1={T} y2={h - B} />
                <circle className="c-cursor-dot" cx={cur[0]} cy={cur[1]} r={5} />
              </>
            ) : null}
          </svg>
        ) : null}
      </div>
      ) : null}

      {buckets.length ? (
        <ul className="key">
          <li><i className="key__sw key__sw--buy" />NAM bought{perSpan}</li>
          <li><i className="key__sw key__sw--sell" />NAM sold{perSpan}</li>
          <li><i className="key__ln" /><Term id="net-bought">Bought minus sold</Term>, running total</li>
        </ul>
      ) : null}

      <dl className="cstats">
        <div>
          <dt><Term id="net-bought">Bought minus sold</Term></dt>
          <dd data-num="">
            {fmtNamSigned(net)} NAM
            <small>since {since}</small>
          </dd>
        </div>
        <div>
          <dt>NAM bought and sold</dt>
          <dd data-num="">
            {fmtNamRule(gross)} NAM
            <small><span data-num="">{fmtCount(trades)}</span> {trades === 1 ? 'swap' : 'swaps'}, bot trades left out</small>
          </dd>
        </div>
        <div>
          <dt>Share bought</dt>
          <dd data-num="" data-status={buyShare == null ? 'none' : undefined}>
            {buyShare == null ? '—' : fmtPctRule(buyShare, 1)}
            <small>{buyShare == null ? 'no swap in this window' : <>bought <span data-num="">{namShort(totalBuy)}</span>, sold <span data-num="">{namShort(totalSell)}</span></>}</small>
          </dd>
        </div>
        <div>
          <dt><Term id="average-price">Average price</Term> change</dt>
          <dd data-num="" data-status={priceChange == null ? 'none' : undefined}>
            {priceChange == null ? '—' : fmtPctSigned(priceChange, 1)}
            <small>{priceChange == null ? 'no span with a priced swap' : 'first priced span to the last'}</small>
          </dd>
        </div>
      </dl>

      {buckets.length ? (
        <p className="cap">
          {whole ? `${WINDOW_WORDS[data.absorptionRegime] ?? WINDOW_WORDS.balanced} ` : ''}
          {!spanKnown ? null : withSwaps < slots * SPARSE_SHARE ? (
            <>Swaps are sparse: only <span data-num="">{fmtCount(withSwaps)}</span> of the <span data-num="">{fmtCount(slots)}</span> {spansWords(bMs)} since {since} had one, so the bars have gaps.</>
          ) : (
            <><span data-num="">{fmtCount(withSwaps)}</span> of the <span data-num="">{fmtCount(slots)}</span> {spansWords(bMs)} since {since} had a swap.</>
          )}
        </p>
      ) : null}

      <SourceLine items={scope} label="Where this chart comes from" />

      {first && last && lowRun != null && highRun != null ? (
        <p className="sr-only">
          Running total of bought minus sold: first {fmtNamSigned(first.cvdNam)} NAM, lowest {fmtNamSigned(lowRun)} NAM, highest {fmtNamSigned(highRun)} NAM, last {fmtNamSigned(last.cvdNam)} NAM.
        </p>
      ) : null}
    </section>
  );
}

export default OrderflowChart;
