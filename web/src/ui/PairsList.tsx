// PairsList (F4, screener-plan 2.4): the NAM pools on Osmosis with their volume, in the DataList grid rules
// (role="table", no <table>, no display: contents; cells are direct children of their row). Phones: a row of
// four short lines (the pair and its depth; the pool number, kind and since when, with its share of all
// depth; the Osmosis data API's dollars traded in 24 h and 7 d, with the trades this site recorded through
// the pool; the coins inside and the fee). From a 720 px container the cells line up as an eight-column table.
//
// A pool's size is its coins at their own prices (worker/src/pool-sizes.ts), so both reserves stand beside it in
// coin units ("Inside": the NAM, then the other coin). A pool a side of which cannot be priced reads "—" with the
// reason in its size cell, and counts in no total.
//
// Two volume sources, never one figure: "Osmosis 24 h / 7 d" is the pair summary (priced side only, its own
// update time) and "Trades here, 24 h" is this site's own count from the swaps it recorded. A pool the summary
// does not list reads "—" with the reason; a column with the same reason in every row says it once, above the
// rows, instead of in each one. Nothing is filled in.
import type { PairRow, Provenance } from '../../../shared/types';
import { fmtCoinAmount, fmtCount, fmtDayMonthYear, fmtNamRule, fmtPctRule, fmtUsdWhole } from '../lib/format';
import { Num } from './Num';
import { counterName, oneSidedWords, poolSides, restOf } from '../../../shared/pool-sides';

export interface PairsListProps {
  /** the pools to list as rows, deepest first */
  pairs: PairRow[];
  /** the pools folded into the closing row */
  rest: PairRow[];
  /** the pools holding only one side: a row each, saying what they hold instead of a depth (shared/pool-sides.ts) */
  oneSided?: PairRow[];
  /** total depth over every pool (the share's denominator) */
  totalUsd: number;
  /** what the pair is called in words ("NAM / USDC") */
  pairName: (p: PairRow) => string;
  label: string;
}

const fin = (x: number | null | undefined): x is number => x != null && Number.isFinite(x);

/** The reason a column is empty in every row, when it is one reason; else null (each row then says its own). */
function columnNote(rows: PairRow[], pick: (p: PairRow) => { value: unknown; prov: Provenance }): string | null {
  if (!rows.length) return null;
  const notes = new Set<string>();
  for (const r of rows) {
    const s = pick(r);
    if (s.value != null) return null;
    notes.add(s.prov.note ?? 'not recorded');
  }
  return notes.size === 1 ? [...notes][0] : null;
}

const miss = (p: Provenance): Provenance => ({ ...p, status: 'missing' });

/** A size the pool list could not price: "—" with the reason it gives (never 0). */
const NOT_LISTED: Provenance = { source: 'Osmosis pool reserves', at: null, status: 'missing', note: 'the pool list does not name this pool now' };

/**
 * Both reserves in coin units, one line each (the NAM, then the other coin), as a pool's size is made from them. An
 * amount that is not known reads "—" with the reason.
 */
export function Inside({ nam, counter, coin }: { nam: number | null; counter: number | null; coin: string }) {
  return (
    <>
      <span className="inside__l"><Num v={nam} fmt={fmtNamRule} unit="NAM" showReason={false} /></span>
      <span className="inside__l">
        {counter != null && Number.isFinite(counter)
          ? <Num v={counter} fmt={fmtCoinAmount} unit={coin} showReason={false} />
          : <><Num v={null} prov={{ source: 'Osmosis pool reserves', at: null, status: 'missing', note: `the amount of ${coin} is not known` }} showReason={false} /> {coin}</>}
      </span>
    </>
  );
}

export function PairsList({ pairs, rest, oneSided = [], totalUsd, pairName, label }: PairsListProps) {
  const all = [...pairs, ...oneSided, ...rest];
  const osmoNote = columnNote(pairs, (p) => p.osmosis);
  const hereNote = columnNote(pairs, (p) => p.here24h);
  const top = Math.max(0, ...[...pairs, ...oneSided].map((p) => (fin(p.liquidityUsd) ? p.liquidityUsd : 0)));
  const { usd: restUsd, max: restMax, notPriced: restUnpriced } = restOf(rest);
  const restTrades = rest.reduce((a, p) => a + (p.here24h.value?.trades ?? 0), 0);
  const share = (p: PairRow) => (fin(p.liquidityUsd) && totalUsd > 0 ? (p.liquidityUsd / totalUsd) * 100 : null);

  return (
    <>
      {osmoNote || hereNote ? (
        <ul className="pa-notes">
          {osmoNote ? <li><span data-num="" data-status="none">—</span> Osmosis volume per pool: {osmoNote}</li> : null}
          {hereNote ? <li><span data-num="" data-status="none">—</span> Trades here per pool: {hereNote}</li> : null}
        </ul>
      ) : null}
      <div className="pa" role="table" aria-label={label} aria-rowcount={pairs.length + oneSided.length + (rest.length ? 2 : 1)} data-pairs={all.length}>
        <div className="pa__head" role="row">
          <span role="columnheader">Pool</span>
          <span role="columnheader" className="r">Depth</span>
          <span role="columnheader" className="r">Share</span>
          <span role="columnheader" className="r">Osmosis 24 h</span>
          <span role="columnheader" className="r">Osmosis 7 days</span>
          <span role="columnheader" className="r">Trades here, 24 h</span>
          <span role="columnheader" className="r">Inside</span>
          <span role="columnheader" className="r">Fee</span>
        </div>
        {[...pairs, ...oneSided].map((p) => {
          const o = p.osmosis.value;
          const here = p.here24h.value;
          const one = oneSidedWords(poolSides(p), p.counterSymbol);
          const bar = top > 0 && fin(p.liquidityUsd) ? p.liquidityUsd / top : null;
          return (
            <div key={p.poolId} className={`pa__row${one ? ' pa__row--one' : ''}`} role="row" data-pool={p.poolId}>
              <span className="pa__id" role="cell">
                <span className="pa__pair">{pairName(p)}</span>
                <span className="pa__sub">
                  <span className="mono">#{p.poolId}</span>
                  {p.type ? <> · {p.type}</> : null}
                  {fin(p.createdAt) ? <> · since <span data-num="">{fmtDayMonthYear(p.createdAt)}</span></> : null}
                  {one ? <> · {one.line}</> : null}
                </span>
              </span>
              <span className="pa__liq" role="cell">
                {fin(p.liquidityUsd) ? <Num v={p.liquidityUsd} fmt={fmtUsdWhole} /> : <Num v={null} prov={p.sizeProv ? miss(p.sizeProv) : NOT_LISTED} />}
              </span>
              <span className="pa__share" role="cell"><Num v={share(p)} fmt={(n) => fmtPctRule(n, 1)} unit="of all depth" showReason={false} /></span>
              <span className="pa__o24" role="cell">
                <span className="pa__w">Osmosis 24 h </span>
                {o ? <Num v={o.volume24hUsd} fmt={fmtUsdWhole} showReason={false} /> : <Num v={null} prov={miss(p.osmosis.prov)} showReason={!osmoNote} />}
              </span>
              <span className="pa__o7" role="cell">
                <span className="pa__w">7 days </span>
                {o ? <Num v={o.volume7dUsd} fmt={fmtUsdWhole} showReason={false} /> : <Num v={null} showReason={false} />}
              </span>
              <span className="pa__here" role="cell">
                {here ? (
                  <><Num v={here.trades} fmt={fmtCount} /><span className="pa__w"> {here.trades === 1 ? 'trade' : 'trades'} here, 24 h</span></>
                ) : (
                  <><Num v={null} prov={miss(p.here24h.prov)} showReason={!hereNote} /><span className="pa__w"> trades here</span></>
                )}
              </span>
              <span className="pa__nam" role="cell"><Inside nam={p.namReserve} counter={p.counterReserve} coin={counterName(p)} /></span>
              <span className="pa__fee" role="cell"><Num v={fin(p.spreadFactor) ? p.spreadFactor * 100 : null} fmt={(n) => fmtPctRule(n)} unit="fee" showReason={false} /></span>
              {bar != null ? <i className="pa__bar" style={{ ['--w' as string]: `${(Math.max(0, Math.min(1, bar)) * 100).toFixed(1)}%` }} aria-hidden="true" /> : null}
            </div>
          );
        })}
        {rest.length ? (
          <div className="pa__row pa__row--rest" role="row">
            <span role="cell">
              <b data-num="">{fmtCount(rest.length)}</b> more {rest.length === 1 ? 'pool' : 'pools'}
            </span>
            <span role="cell" className="r">
              <span data-num="">{fmtUsdWhole(restUsd)}</span> together, none above <span data-num="">{fmtUsdWhole(restMax)}</span>
              {restUnpriced > 0 ? <>; <span data-num="">{fmtCount(restUnpriced)}</span> of them not priced, so not counted</> : null}
              {restTrades > 0 ? <>, <span data-num="">{fmtCount(restTrades)}</span> {restTrades === 1 ? 'trade' : 'trades'} here in 24 h</> : null}
            </span>
          </div>
        ) : null}
      </div>
    </>
  );
}

export default PairsList;
