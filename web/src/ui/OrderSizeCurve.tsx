// OrderSizeCurve (system.md 7.2; grafted from direction C): drag an order size and read what
// the pools' real quotes say. Log x over the quoted sizes, linear y from 0 to a nice maximum
// above the largest move (both sides as magnitudes; the readout carries the sign). Selling
// solid with filled dots, buying dashed with hollow dots. The slider snaps to a real quote;
// between two quotes the readout is a straight line between them with an Estimate tag naming
// both sizes; outside the quoted range it shows "—" and says it will not guess.
// The component never draws a number that the quotes and a straight line do not produce.
//
// The ticket's curve has a second view, "Each slice": the price move of the NAM between one
// listed size and the next, on its own (the server's slice figures when it sent them, else the
// same arithmetic over the size table's own rows: what the pools pay for the extra NAM against
// the quoted price, as trade/jump.ts does). The three readout figures then all describe that
// slice. When the server marks the size above which selling starts to cost much more per extra
// NAM, a dashed vertical marks it and the key says what it is; the screen prints the sentence.
import React, { useId, useMemo, useState } from 'react';
import type { SlippageCurvePoint } from '../../../shared/types';
import type { Stamp } from '../lib/prov';
import { fmtCoin, fmtNamRule, fmtPctRule, fmtPctSigned, fmtUsdRule } from '../lib/format';

const fmtPct2 = (n: number) => fmtPctRule(n, 2);
import { CurveQuote, SLIDER_MAX, curveAt, fromApi, logPos, normalise, sizeToSlider, sliderToSize } from './curveMath';
import { niceTicks, pathOf, tickLabel } from './chartMath';
import { useSize } from './useSize';
import { Segmented } from './Segmented';
import { Tag } from './Tag';
import { Term } from './Term';
import { SourceLine } from './SourceLine';

export interface OrderSizeCurveProps {
  /** The size table: real quotes from the API (or already reduced CurveQuotes). */
  points: (SlippageCurvePoint | CurveQuote)[];
  /** Selected size in NAM (controlled). Omit to let the slider own it (explore mode). */
  value?: number;
  onChange?: (n: number) => void;
  /** Which side the readout reports. Both lines are always drawn. */
  side?: 'sell' | 'buy';
  /** explore: Home's "Drag an order size"; ticket: the Trade size block (same state as the amount), with the slice view. */
  mode?: 'explore' | 'ticket';
  /** The listed size the server marked: above it each extra NAM sold gets a much lower price. Drawn as a dashed vertical. */
  liquidityCliffNam?: number | null;
  /** The server's own sentence about that mark. Not printed: it carries typed figures and expert words; the screen says it from fields. */
  cliffNote?: string | null;
  /** The size table's stamp, for the SourceLine under the curve. */
  prov?: Stamp | null;
  /** Visually hidden caption (the visible heading is the screen's). */
  caption?: string;
  className?: string;
}

type View = 'avg' | 'slice';

/** One slice of the size table: the NAM between the listed size before (`from`, 0 for the first) and `n`. */
interface Slice {
  n: number;
  from: number;
  /** Price per NAM the pools pay (selling) or ask (buying) for this slice alone. */
  sellUsd: number | null;
  buyUsd: number | null;
  /** How far selling or buying this slice on its own moves the price, percent, magnitude. */
  sellMove: number | null;
  buyMove: number | null;
}

const isApi = (p: SlippageCurvePoint | CurveQuote): p is SlippageCurvePoint => 'amountNam' in p;
const fin = (x: number | null | undefined): x is number => x != null && Number.isFinite(x);

/**
 * The slices of the size table, by their upper size. The server's figures when it sent them
 * (marginalSellUsd, marginalSellImpactPct, marginalBuyUsd); otherwise the same arithmetic over the
 * rows: the USDC difference between two listed sizes over their NAM difference, against the quoted
 * price (worth / size). Nothing is invented: a row without the needed quote gives null.
 */
function slicesOf(points: (SlippageCurvePoint | CurveQuote)[], P: CurveQuote[]): Map<number, Slice> {
  const api = new Map<number, SlippageCurvePoint>();
  for (const p of points) if (isApi(p)) api.set(p.amountNam, p);
  const out = new Map<number, Slice>();
  let prev: CurveQuote | null = null;
  for (const p of P) {
    const a = api.get(p.n);
    const spot = fin(p.worth) && p.n > 0 ? p.worth / p.n : null;
    const dN = p.n - (prev?.n ?? 0);
    const sU = a?.marginalSellUsd;
    const sM = a?.marginalSellImpactPct;
    const bU = a?.marginalBuyUsd;
    let sellUsd: number | null = fin(sU) ? sU : null;
    if (sellUsd == null && dN > 0 && fin(p.sellOut) && (prev == null || fin(prev.sellOut))) sellUsd = Math.max(0, (p.sellOut - (prev?.sellOut ?? 0)) / dN);
    let sellMove: number | null = fin(sM) ? sM : null;
    if (sellMove == null && sellUsd != null && spot != null && spot > 0) sellMove = Math.max(0, ((spot - sellUsd) / spot) * 100);
    let buyUsd: number | null = fin(bU) ? bU : null;
    if (buyUsd == null && dN > 0 && fin(p.buyIn) && (prev == null || fin(prev.buyIn))) buyUsd = Math.max(0, (p.buyIn - (prev?.buyIn ?? 0)) / dN);
    const buyMove = buyUsd != null && spot != null && spot > 0 ? Math.max(0, ((buyUsd - spot) / spot) * 100) : null;
    out.set(p.n, { n: p.n, from: prev?.n ?? 0, sellUsd, buyUsd, sellMove, buyMove });
    prev = p;
  }
  return out;
}

export function OrderSizeCurve({ points, value, onChange, side = 'sell', mode = 'explore', liquidityCliffNam, prov, caption = 'Drag an order size', className = '' }: OrderSizeCurveProps) {
  const P = useMemo(() => normalise(points.map((p) => (isApi(p) ? fromApi(p) : p))), [points]);
  const slices = useMemo(() => slicesOf(points, P), [points, P]);
  const slicesOk = P.some((p) => slices.get(p.n)?.sellMove != null || slices.get(p.n)?.buyMove != null);
  const [viewPick, setViewPick] = useState<View>('avg');
  const view: View = mode === 'ticket' && slicesOk ? viewPick : 'avg';
  const isSlice = view === 'slice';

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
  const sliceList = P.map((p) => slices.get(p.n)).filter((s): s is Slice => !!s);
  const maxMove = isSlice
    ? Math.max(0, ...sliceList.map((s) => Math.max(s.sellMove ?? 0, s.buyMove ?? 0)))
    : Math.max(0, ...P.map((p) => Math.max(p.sellMove ?? 0, p.buyMove ?? 0)));
  const yT = niceTicks(0, maxMove > 0 ? maxMove * 1.02 : 1, { zero: true, maxTicks: 5 });
  const X = (s: number) => (lo && hi ? L + logPos(s, lo, hi) * (w - L - R) : L);
  const Y = (m: number) => T + (1 - m / (yT.hi || 1)) * (H - T - B);
  // the two lines: the whole order's average move, or each slice's own move, never both
  const sellPts = isSlice
    ? sliceList.filter((s) => s.sellMove != null).map((s) => [X(s.n), Y(s.sellMove as number)] as [number, number])
    : P.filter((p) => p.sellMove != null).map((p) => [X(p.n), Y(p.sellMove as number)] as [number, number]);
  const buyPts = isSlice
    ? sliceList.filter((s) => s.buyMove != null).map((s) => [X(s.n), Y(s.buyMove as number)] as [number, number])
    : P.filter((p) => p.buyMove != null).map((p) => [X(p.n), Y(p.buyMove as number)] as [number, number]);
  const jump = fin(liquidityCliffNam) && lo != null && hi != null && liquidityCliffNam >= lo && liquidityCliffNam <= hi ? liquidityCliffNam : null;
  const jumpX = jump != null ? X(jump) : null;
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

  // ---------------- the whole order (average) reading ----------------
  const v = reading.kind === 'quote' ? reading.q : reading.kind === 'estimate' ? reading.v : null;
  const move = v ? (side === 'sell' ? v.sellMove : v.buyMove) : null;
  const get = v ? (side === 'sell' ? v.sellOut : v.buyIn) : null;
  const signedMove = move == null ? null : side === 'sell' ? -move : move;

  // ---------------- the slice reading: the slice the set size falls in ----------------
  const holder = n > 0 && hi != null && n <= hi ? (P.find((p) => p.n >= n) ?? null) : null;
  const slice = holder ? (slices.get(holder.n) ?? null) : null;
  const sliceNam = slice ? slice.n - slice.from : null;
  const sliceUsd = slice ? (side === 'sell' ? slice.sellUsd : slice.buyUsd) : null;
  const sliceMove = slice ? (side === 'sell' ? slice.sellMove : slice.buyMove) : null;
  const sliceGet = sliceUsd != null && sliceNam != null ? sliceUsd * sliceNam : null;
  const signedSlice = sliceMove == null ? null : side === 'sell' ? -sliceMove : sliceMove;
  // the whole order up to the slice's top, so the reader sees why the part moves more than the whole
  const wholeAtTop = holder ? (side === 'sell' ? holder.sellMove : holder.buyMove) : null;
  const sliceWhy: React.ReactNode = isSlice && slice && slice.from > 0 && sliceMove != null && wholeAtTop != null && sliceNam != null && sliceMove > wholeAtTop
    ? (
      <>
        The last <span data-num="">{fmtNamRule(sliceNam)}</span> NAM of a <span data-num="">{fmtNamRule(slice.n)}</span> NAM order moves the price{' '}
        <span data-num="">{fmtPct2(sliceMove)}</span>, more than the <span data-num="">{fmtPct2(wholeAtTop)}</span> the whole order averages, because each extra NAM{' '}
        {side === 'sell' ? 'sells at a lower' : 'is bought at a higher'} price.
      </>
    )
    : null;

  const shownMove = isSlice ? sliceMove : move;
  const cx = reading.kind === 'out' ? null : X(n);
  const cy = shownMove != null ? Y(shownMove) : null;
  const sliderVal = lo && hi ? sizeToSlider(Math.min(hi, Math.max(lo, n || lo)), lo, hi) : 0;

  const how = isSlice
    ? reading.kind === 'out'
      ? lo != null && hi != null
        ? `No quote covers ${fmtNamRule(n)} NAM. The pools were asked about ${fmtNamRule(lo)} to ${fmtNamRule(hi)} NAM, so no figure is shown.`
        : 'The size table is empty, so no figure is shown.'
      : slice && sliceMove != null
        ? slice.from === 0
          ? `The first ${fmtNamRule(slice.n)} NAM on its own: a real quote.`
          : `The slice from ${fmtNamRule(slice.from)} to ${fmtNamRule(slice.n)} NAM on its own, from the two real quotes around it.`
        : slice
          ? `The size table has no figure for the slice from ${fmtNamRule(slice.from)} to ${fmtNamRule(slice.n)} NAM, so none is shown.`
          : 'The size table is empty, so no figure is shown.'
    : reading.kind === 'quote'
      ? `A real quote: the pools were asked about ${fmtNamRule(n)} NAM.`
      : reading.kind === 'estimate'
        ? `A straight line between the real ${fmtNamRule(reading.a.n)} and ${fmtNamRule(reading.b.n)} NAM quotes. The pools were not asked about ${fmtNamRule(n)} NAM.`
        : lo != null && hi != null
          ? `No quote covers ${fmtNamRule(n)} NAM. The pools were asked about ${fmtNamRule(lo)} to ${fmtNamRule(hi)} NAM, so no figure is shown.`
          : 'The size table is empty, so no figure is shown.';

  const aria = P.length
    ? `${isSlice ? 'Price move of each slice on its own' : 'Price move by order size'}, log scale from ${fmtNamRule(lo)} to ${fmtNamRule(hi)} NAM. Selling solid, buying dashed. ${P.length} real quotes.${
        jump != null ? ` A dashed vertical marks ${fmtNamRule(jump)} NAM: above it each extra NAM sold gets a much lower price.` : ''
      }`
    : 'Price move by order size: no quotes.';

  return (
    <div className={`curve-box ${className}`} data-mode={mode} data-prov-scope="">
      {mode === 'ticket' ? (
        <div className="curve__mode">
          <Segmented
            label="What the curve shows"
            variant="range"
            value={view}
            onChange={(x) => setViewPick(x as View)}
            options={[
              { value: 'avg', label: 'Whole order' },
              { value: 'slice', label: 'Each slice', disabled: !slicesOk },
            ]}
          />
          {!slicesOk ? <p className="cap">The size table gave no figure for any slice on its own, so that view is off.</p> : null}
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
              {jumpX != null && jump != null ? (
                <g>
                  <line className="c-evt" x1={jumpX} x2={jumpX} y1={T} y2={H - B} />
                  <text className="c-evtl" x={jumpX > w - 110 ? jumpX - 4 : jumpX + 4} y={T + 10} textAnchor={jumpX > w - 110 ? 'end' : 'start'}>
                    above {short(jump)}
                  </text>
                </g>
              ) : null}
              {buyPts.length > 1 ? <path className="cv-buy" d={pathOf(buyPts)} /> : null}
              {buyPts.map(([x, y], i) => <circle key={`b${i}`} className="cv-db" cx={x} cy={y} r={w >= 480 ? 4 : 3.5} />)}
              {sellPts.length > 1 ? (
                <g className="cv-wipe" key={view}>
                  <path className="cv-sell" d={pathOf(sellPts)} />
                </g>
              ) : null}
              {sellPts.map(([x, y], i) => <circle key={`s${i}`} className="cv-ds" cx={x} cy={y} r={w >= 480 ? 4 : 3.5} />)}
              {cx != null ? <line className="cv-cur" x1={cx} x2={cx} y1={T} y2={H - B} /> : null}
              {cx != null && cy != null ? <circle className="cv-curd" cx={cx} cy={cy} r={6} /> : null}
            </svg>
          ) : null}
        </div>
        <p className="curve__key">
          <span><i className="key__ln" />selling</span>
          <span><i className="key__ln key__ln--dash" />buying</span>
          {jump != null ? <span><i className="key__ln key__ln--evt" />dashed vertical: above this size each extra NAM sold gets a much lower price</span> : null}
          <span>
            {isSlice ? (
              <>
                <Term id="slice">Each slice</Term> on its own: the NAM between one listed size and the next
              </>
            ) : (
              'Price move by order size'
            )}
          </span>
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
        {isSlice ? (
          <dl className="curve__read" aria-live="polite">
            <div>
              <dt>{slice && slice.from > 0 ? <><Term id="slice">Slice</Term> from {fmtNamRule(slice.from)} to {fmtNamRule(slice.n)}</> : slice ? <>The first <Term id="slice">slice</Term>, up to {fmtNamRule(slice.n)}</> : <Term id="slice">Slice</Term>}</dt>
              <dd data-num="" data-status={sliceNam == null ? 'none' : undefined}>
                {sliceNam == null ? '—' : <>{fmtNamRule(sliceNam)}<span className="u"> NAM</span></>}
              </dd>
            </div>
            <div>
              <dt>{side === 'sell' ? 'You get for that slice' : 'You pay for that slice'}</dt>
              <dd data-num="" data-status={sliceGet == null ? 'none' : undefined}>
                {sliceGet == null ? '—' : <>{fmtCoin(sliceGet)}<span className="u"> USDC</span></>}
              </dd>
            </div>
            <div>
              <dt>Price move for that slice</dt>
              <dd data-num="" data-status={signedSlice == null ? 'none' : undefined}>{signedSlice == null ? '—' : fmtPctSigned(signedSlice)}</dd>
            </div>
          </dl>
        ) : (
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
              <dt>Price moves</dt>
              <dd data-num="" data-status={signedMove == null ? 'none' : undefined}>{signedMove == null ? '—' : fmtPctSigned(signedMove)}</dd>
            </div>
          </dl>
        )}
        <p className="curve__how">
          {!isSlice && reading.kind === 'estimate' ? <Tag cat="Estimate" term="estimate" /> : null}
          <span>
            {how}
            {isSlice && slice && sliceUsd != null ? (
              <>
                {' '}
                {side === 'sell' ? 'The pools pay' : 'The pools ask'} <span data-num="">{fmtUsdRule(sliceUsd)}</span> per NAM for it.
              </>
            ) : null}
            {sliceWhy ? <> {sliceWhy}</> : null}
          </span>
        </p>
        {P.length ? (
          <p className="curve__note">
            The dots are the {P.length} sizes the pools were asked about ({fmtNamRule(lo)} to {fmtNamRule(hi)} NAM). Between two dots the page draws a straight line between the two real quotes, so treat it as an estimate. Along the bottom each step is a multiple, not a fixed amount: {P.map((p) => short(p.n)).join(', ')}.
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
