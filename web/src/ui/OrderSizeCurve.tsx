// OrderSizeCurve (system.md 7.2; grafted from direction C): drag an order size and read what
// the pools' real quotes say. Log x over the quoted sizes, linear y from 0 to a nice maximum
// above the largest move (both sides as magnitudes; the readout carries the sign). Selling
// solid with filled dots, buying dashed with hollow dots. The slider snaps to a real quote;
// between two quotes the readout is a straight line between them with an Estimate tag naming
// both sizes; outside the quoted range it shows "—" and says it will not guess.
// The component never draws a number that the quotes and a straight line do not produce.
import { useId, useMemo, useState } from 'react';
import type { SlippageCurvePoint } from '../../../shared/types';
import type { Stamp } from '../lib/prov';
import { fmtCoin, fmtNamRule, fmtPctSigned, fmtUsdRule } from '../lib/format';
import { CurveQuote, SLIDER_MAX, curveAt, fromApi, logPos, normalise, sizeToSlider, sliderToSize } from './curveMath';
import { niceTicks, pathOf, tickLabel } from './chartMath';
import { useSize } from './useSize';
import { Segmented } from './Segmented';
import { Tag } from './Tag';
import { SourceLine } from './SourceLine';

export interface OrderSizeCurveProps {
  /** The size table: real quotes from the API (or already reduced CurveQuotes). */
  points: (SlippageCurvePoint | CurveQuote)[];
  /** Selected size in NAM (controlled). Omit to let the slider own it (explore mode). */
  value?: number;
  onChange?: (n: number) => void;
  /** Which side the readout reports. Both lines are always drawn. */
  side?: 'sell' | 'buy';
  /** explore: Home's "Drag an order size"; ticket: the Trade size block (same state as the amount). */
  mode?: 'explore' | 'ticket';
  /** Order size (NAM) where Concentrated Liquidity tick exhaustion causes a >2.5x jump in marginal slippage. */
  liquidityCliffNam?: number | null;
  /** Plain explanation of the Concentrated Liquidity tick cliff. */
  cliffNote?: string | null;
  /** The size table's stamp, for the SourceLine under the curve. */
  prov?: Stamp | null;
  /** Visually hidden caption (the visible heading is the screen's). */
  caption?: string;
  className?: string;
}

const isApi = (p: SlippageCurvePoint | CurveQuote): p is SlippageCurvePoint => 'amountNam' in p;

export function OrderSizeCurve({
  points,
  value,
  onChange,
  side = 'sell',
  mode = 'explore',
  liquidityCliffNam,
  cliffNote,
  prov,
  caption = 'Drag an order size',
  className = '',
}: OrderSizeCurveProps) {
  const P = useMemo(() => normalise(points.map((p) => (isApi(p) ? fromApi(p) : p))), [points]);
  const [curveView, setCurveView] = useState<'avg' | 'marginal'>('avg');

  // Compute marginal slice slippage (% impact on the incremental ΔNAM between tier i-1 and tier i)
  const marginalMap = useMemo(() => {
    const out = new Map<number, { marginalSellMove: number | null; marginalBuyMove: number | null; marginalSellUsd: number | null }>();
    const apiBySize = new Map<number, SlippageCurvePoint>();
    for (const p of points) if (isApi(p)) apiBySize.set(p.amountNam, p);

    let prevN = 0;
    let prevSellOut = 0;
    let prevBuyIn = 0;
    for (const p of P) {
      const api = apiBySize.get(p.n);
      const dN = p.n - prevN;
      const spot = p.worth != null && p.n > 0 ? p.worth / p.n : null;
      let mSellMove: number | null = api?.marginalSellImpactPct ?? null;
      let mSellUsd: number | null = api?.marginalSellUsd ?? null;
      if (mSellMove == null && dN > 0 && p.sellOut != null && spot && spot > 0) {
        const dUsdc = Math.max(0, p.sellOut - prevSellOut);
        mSellUsd = dUsdc / dN;
        mSellMove = Math.max(0, ((spot - mSellUsd) / spot) * 100);
      }
      let mBuyMove: number | null = null;
      if (dN > 0 && p.buyIn != null && spot && spot > 0) {
        const dBuyUsdc = Math.max(0, p.buyIn - prevBuyIn);
        const mBuyUsd = dBuyUsdc / dN;
        mBuyMove = Math.max(0, ((mBuyUsd - spot) / spot) * 100);
      }
      if (p.sellOut != null) prevSellOut = p.sellOut;
      if (p.buyIn != null) prevBuyIn = p.buyIn;
      prevN = p.n;
      out.set(p.n, { marginalSellMove: mSellMove ?? p.sellMove, marginalBuyMove: mBuyMove ?? p.buyMove, marginalSellUsd: mSellUsd });
    }
    return out;
  }, [P, points]);

  const sizes = P.map((p) => p.n);
  const lo = sizes[0] ?? null;
  const hi = sizes[sizes.length - 1] ?? null;
  const initial = sizes.find((n) => n >= 10_000) ?? sizes[Math.floor(sizes.length / 2)] ?? 0;
  const [own, setOwn] = useState<number>(initial);
  const n = value ?? own;
  const reading = curveAt(P, n);
  const id = useId();
  const [boxRef, { w }] = useSize<HTMLDivElement>();
  const H = w >= 480 ? 248 : 188;

  const set = (next: number) => {
    if (value === undefined) setOwn(next);
    onChange?.(next);
  };

  // ---------------- geometry (CSS px) ----------------
  const L = 34;
  const R = 12;
  const T = 12;
  const B = 26;
  const isMarginal = curveView === 'marginal';
  const maxMove = Math.max(
    0,
    ...P.map((p) => {
      const m = marginalMap.get(p.n);
      return Math.max(
        p.sellMove ?? 0,
        p.buyMove ?? 0,
        isMarginal ? (m?.marginalSellMove ?? 0) : 0,
        isMarginal ? (m?.marginalBuyMove ?? 0) : 0,
      );
    }),
  );
  const yT = niceTicks(0, maxMove > 0 ? maxMove * 1.02 : 1, { zero: true, maxTicks: 5 });
  const X = (s: number) => (lo && hi ? L + logPos(s, lo, hi) * (w - L - R) : L);
  const Y = (m: number) => T + (1 - m / (yT.hi || 1)) * (H - T - B);
  const sellPts = P.filter((p) => p.sellMove != null).map((p) => [X(p.n), Y(p.sellMove as number)] as [number, number]);
  const buyPts = P.filter((p) => p.buyMove != null).map((p) => [X(p.n), Y(p.buyMove as number)] as [number, number]);
  const mSellPts = P.filter((p) => marginalMap.get(p.n)?.marginalSellMove != null).map(
    (p) => [X(p.n), Y(marginalMap.get(p.n)!.marginalSellMove as number)] as [number, number],
  );
  // Step-function staircase path for Concentrated Liquidity tick boundaries
  const stepPathOf = (pts: [number, number][]) =>
    pts.length > 1
      ? pts.map(([x, y], i) => (i === 0 ? `M${x.toFixed(1)},${y.toFixed(1)}` : `H${x.toFixed(1)} V${y.toFixed(1)}`)).join(' ')
      : '';
  const cliffX = liquidityCliffNam && lo && hi && liquidityCliffNam >= lo && liquidityCliffNam <= hi ? X(liquidityCliffNam) : null;
  const short = (x: number) => (x >= 1000 ? `${fmtNamRule(x / 1000)}k`.replace('.00k', 'k') : fmtNamRule(x));
  // Every quoted size is labelled (the caption says "the dots are the N sizes"): the first anchored at
  // its start, the last at its end, the rest centred. A middle label that would touch its neighbour
  // (a very narrow plot) is left out; the first and the last always stay.
  const xLabels = (() => {
    const uniq = P.filter((p, i, a) => a.findIndex((q) => q.n === p.n) === i);
    if (uniq.length < 2) return uniq;
    const CH = 6.7; // 11 px mono, per character
    const PAD = 6;
    const span = (p: CurveQuote, a: 'start' | 'middle' | 'end'): [number, number] => {
      const x = X(p.n);
      const wd = short(p.n).length * CH;
      return a === 'start' ? [x, x + wd] : a === 'end' ? [x - wd, x] : [x - wd / 2, x + wd / 2];
    };
    const last = uniq[uniq.length - 1];
    const lastSpan = span(last, 'end');
    const out = [uniq[0]];
    let prevEnd = span(uniq[0], 'start')[1];
    for (const p of uniq.slice(1, -1)) {
      const [a, b] = span(p, 'middle');
      if (a - prevEnd >= PAD && lastSpan[0] - b >= PAD) {
        out.push(p);
        prevEnd = b;
      }
    }
    out.push(last);
    return out;
  })();

  const v = reading.kind === 'quote' ? reading.q : reading.kind === 'estimate' ? reading.v : null;
  const move = v ? (side === 'sell' ? v.sellMove : v.buyMove) : null;
  const activeTier = useMemo(() => {
    if (!P.length) return null;
    return P.find((p) => p.n >= n) ?? P[P.length - 1];
  }, [P, n]);
  const activeMarginal = activeTier ? marginalMap.get(activeTier.n) ?? null : null;
  const marginalMove = activeMarginal ? (side === 'sell' ? activeMarginal.marginalSellMove : activeMarginal.marginalBuyMove) : null;

  const cx = reading.kind === 'out' ? null : X(n);
  const shownMove = isMarginal ? (marginalMove ?? move) : move;
  const cy = shownMove != null ? Y(shownMove) : null;

  const get = v ? (side === 'sell' ? v.sellOut : v.buyIn) : null;
  const signedMove = shownMove == null ? null : side === 'sell' ? -shownMove : shownMove;
  const sliderVal = lo && hi ? sizeToSlider(Math.min(hi, Math.max(lo, n || lo)), lo, hi) : 0;

  const how =
    reading.kind === 'quote'
      ? `A real quote: the pools were asked about ${fmtNamRule(n)} NAM.${isMarginal && activeMarginal?.marginalSellUsd != null ? ` Incremental slice executes at ${fmtUsdRule(activeMarginal.marginalSellUsd)}/NAM.` : ''}`
      : reading.kind === 'estimate'
        ? `A straight line between the real ${fmtNamRule(reading.a.n)} and ${fmtNamRule(reading.b.n)} NAM quotes. The pools were not asked about ${fmtNamRule(n)} NAM.`
        : lo != null && hi != null
          ? `No quote covers ${fmtNamRule(n)} NAM. The pools were asked about ${fmtNamRule(lo)} to ${fmtNamRule(hi)} NAM, so no figure is shown.`
          : 'The size table is empty, so no figure is shown.';

  const aria = P.length
    ? `Price move by order size, log scale from ${fmtNamRule(lo)} to ${fmtNamRule(hi)} NAM. Selling solid, buying dashed. ${P.length} real quotes.`
    : 'Price move by order size: no quotes.';

  return (
    <div className={`curve-box ${className}`} data-mode={mode} data-prov-scope="">
      {mode === 'ticket' ? (
        <div className="curve__mode">
          <Segmented
            label="Slippage curve view"
            variant="range"
            value={curveView}
            onChange={(v) => setCurveView(v as 'avg' | 'marginal')}
            options={[
              { value: 'avg', label: 'Average impact' },
              { value: 'marginal', label: 'Marginal tick cliffs' },
            ]}
          />
          {cliffNote ? <span className="cap">{cliffNote}</span> : null}
        </div>
      ) : null}
      <figure className="curve" aria-labelledby={`${id}c`}>
        <figcaption id={`${id}c`} className="sr-only">{caption}</figcaption>
        <div className="curve__plot" ref={boxRef} style={{ height: H }}>
          {w > 0 && P.length ? (
            <svg width={w} height={H} viewBox={`0 0 ${w} ${H}`} role="img" aria-label={aria}>
              {yT.ticks.map((t) => (
                <g key={t}>
                  <line className="cv-grid" x1={L} x2={w - R} y1={Y(t)} y2={Y(t)} />
                  <text className="cv-tick" x={L - 8} y={Y(t) + 4} textAnchor="end">{tickLabel(t, yT.step, '%')}</text>
                </g>
              ))}
              <line className="cv-axis" x1={L} x2={w - R} y1={H - B} y2={H - B} />
              {xLabels.map((p, i) => (
                <text key={p.n} className="cv-tick" x={X(p.n)} y={H - 6} textAnchor={i === 0 ? 'start' : i === xLabels.length - 1 ? 'end' : 'middle'}>
                  {short(p.n)}
                </text>
              ))}
              {cliffX != null ? (
                <g>
                  <line className="c-evt" x1={cliffX} x2={cliffX} y1={T} y2={H - B} />
                  <text className="c-evtl" x={Math.min(w - R - 4, cliffX + 4)} y={T + 10} textAnchor={cliffX > w - 110 ? 'end' : 'start'}>
                    CL tick cliff
                  </text>
                </g>
              ) : null}
              {buyPts.length > 1 ? <path className="cv-buy" d={pathOf(buyPts)} /> : null}
              {buyPts.map(([x, y], i) => <circle key={`b${i}`} className="cv-db" cx={x} cy={y} r={w >= 480 ? 4 : 3.5} />)}
              {isMarginal && mSellPts.length > 1 ? (
                <g className="cv-wipe">
                  <path className="cv-sell" d={stepPathOf(mSellPts)} />
                  <path className="cv-buy" d={pathOf(sellPts)} />
                </g>
              ) : sellPts.length > 1 ? (
                <g className="cv-wipe">
                  <path className="cv-sell" d={pathOf(sellPts)} />
                </g>
              ) : null}
              {(isMarginal ? mSellPts : sellPts).map(([x, y], i) => (
                <circle key={`s${i}`} className="cv-ds" cx={x} cy={y} r={w >= 480 ? 4 : 3.5} />
              ))}
              {cx != null ? <line className="cv-cur" x1={cx} x2={cx} y1={T} y2={H - B} /> : null}
              {cx != null && cy != null ? <circle className="cv-curd" cx={cx} cy={cy} r={6} /> : null}
            </svg>
          ) : null}
        </div>
        <p className="curve__key">
          <span><i className="key__ln" />{isMarginal ? 'marginal slice impact (step)' : 'selling'}</span>
          <span><i className="key__ln key__ln--dash" />{isMarginal ? 'average impact' : 'buying'}</span>
          <span>{isMarginal ? 'Concentrated liquidity tick depth & marginal slippage' : 'Price move by order size'}</span>
        </p>
        <div className="curve__ctl">
          <label className="curve__lbl" htmlFor={`${id}r`}>Order size</label>
          <output className="curve__size" htmlFor={`${id}r`} data-num="">
            {n ? `${fmtNamRule(n)} NAM` : '—'}
          </output>
          <input
            id={`${id}r`}
            className="curve__rng"
            type="range"
            min={0}
            max={SLIDER_MAX}
            step={1}
            value={sliderVal}
            disabled={!P.length}
            aria-valuetext={`${fmtNamRule(n)} NAM${reading.kind === 'estimate' ? ', estimate' : reading.kind === 'quote' ? ', a real quote' : ''}`}
            onChange={(e) => set(sliderToSize(Number(e.target.value), sizes))}
            onKeyDown={(e) => {
              // Arrows step between the real quotes (a 1-unit step would snap straight back);
              // Page Up and Page Down move a tenth of the scale, through the estimates.
              if (!sizes.length) return;
              let next: number | null = null;
              if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = sizes.find((x) => x > n) ?? null;
              else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = [...sizes].reverse().find((x) => x < n) ?? null;
              else if (e.key === 'PageUp') next = sliderToSize(Math.min(SLIDER_MAX, sliderVal + 100), sizes);
              else if (e.key === 'PageDown') next = sliderToSize(Math.max(0, sliderVal - 100), sizes);
              else if (e.key === 'Home') next = sizes[0];
              else if (e.key === 'End') next = sizes[sizes.length - 1];
              else return;
              e.preventDefault();
              if (next != null && next !== n) set(next);
            }}
          />
        </div>
        <dl className="curve__read" aria-live="polite">
          <div>
            <dt>Worth</dt>
            <dd data-num="" data-status={v?.worth == null ? 'none' : undefined}>{v?.worth == null ? '—' : fmtUsdRule(v.worth)}</dd>
          </div>
          <div>
            <dt>{side === 'sell' ? 'You get' : 'You pay'}</dt>
            <dd data-num="" data-status={get == null ? 'none' : undefined}>
              {get == null ? '—' : <>{fmtCoin(get)}<span className="u"> USDC</span></>}
            </dd>
          </div>
          <div>
            <dt>{isMarginal ? 'Marginal slice move' : 'Price moves'}</dt>
            <dd data-num="" data-status={signedMove == null ? 'none' : undefined}>{signedMove == null ? '—' : fmtPctSigned(signedMove)}</dd>
          </div>
        </dl>
        <p className="curve__how">
          {reading.kind === 'estimate' ? <Tag cat="Estimate" term="estimate" /> : null}
          <span>{how}</span>
        </p>
        {P.length ? (
          <p className="curve__note">
            The dots are the {P.length} sizes the pools were asked about ({fmtNamRule(lo)} to {fmtNamRule(hi)} NAM). Between two dots the page draws a straight line between the two real quotes, so treat it as an estimate. The scale is logarithmic: equal steps are equal multiples.
          </p>
        ) : null}
      </figure>
      {prov ? <SourceLine items={[{ label: 'Size table', p: prov }]} label="Where the size table comes from" /> : null}
    </div>
  );
}

export default OrderSizeCurve;

/** Re-exported for screens that need the same reading as the curve (the ticket). */
export { curveAt, fromApi, sliderToSize, sizeToSlider };
export type { CurveQuote };
