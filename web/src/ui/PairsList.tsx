// PairsList (F4, screener-plan 2.4): the NAM pools on Osmosis with their volume, in the DataList grid rules
// (role="table", no <table>, no display: contents; cells are direct children of their row). Phones: a row of
// four short lines (the pair and its depth; the pool number, kind and since when, with its share of all
// depth; the Osmosis data API's dollars traded in 24 h and 7 d, with the trades this site recorded through
// the pool; the NAM inside and the fee). From a 720 px container the cells line up as an eight-column table.
//
// Two volume sources, never one figure: "Osmosis 24 h / 7 d" is the pair summary (priced side only, its own
// update time) and "Trades here, 24 h" is this site's own count from the swaps it recorded. A pool the summary
// does not list reads "—" with the reason; a column with the same reason in every row says it once, above the
// rows, instead of in each one. Nothing is filled in.
import type { PairRow, Provenance } from '../../../shared/types';
import { fmtCount, fmtDayMonthYear, fmtNamRule, fmtPctRule, fmtUsdWhole } from '../lib/format';
import { Num } from './Num';

export interface PairsListProps {
  /** the pools to list as rows, deepest first */
  pairs: PairRow[];
  /** the pools folded into the closing row */
  rest: PairRow[];
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

export function PairsList({ pairs, rest, totalUsd, pairName, label }: PairsListProps) {
  const all = [...pairs, ...rest];
  const osmoNote = columnNote(pairs, (p) => p.osmosis);
  const hereNote = columnNote(pairs, (p) => p.here24h);
  const top = pairs[0]?.liquidityUsd ?? 0;
  const restUsd = rest.reduce((a, p) => a + (fin(p.liquidityUsd) ? p.liquidityUsd : 0), 0);
  const restMax = rest.reduce((a, p) => Math.max(a, fin(p.liquidityUsd) ? p.liquidityUsd : 0), 0);
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
      <div className="pa" role="table" aria-label={label} aria-rowcount={pairs.length + (rest.length ? 2 : 1)} data-pairs={all.length}>
        <div className="pa__head" role="row">
          <span role="columnheader">Pool</span>
          <span role="columnheader" className="r">Depth</span>
          <span role="columnheader" className="r">Share</span>
          <span role="columnheader" className="r">Osmosis 24 h</span>
          <span role="columnheader" className="r">Osmosis 7 days</span>
          <span role="columnheader" className="r">Trades here, 24 h</span>
          <span role="columnheader" className="r">NAM inside</span>
          <span role="columnheader" className="r">Fee</span>
        </div>
        {pairs.map((p) => {
          const o = p.osmosis.value;
          const here = p.here24h.value;
          const bar = top > 0 && fin(p.liquidityUsd) ? p.liquidityUsd / top : null;
          return (
            <div key={p.poolId} className="pa__row" role="row" data-pool={p.poolId}>
              <span className="pa__id" role="cell">
                <span className="pa__pair">{pairName(p)}</span>
                <span className="pa__sub">
                  <span className="mono">#{p.poolId}</span>
                  {p.type ? <> · {p.type}</> : null}
                  {fin(p.createdAt) ? <> · since <span data-num="">{fmtDayMonthYear(p.createdAt)}</span></> : null}
                </span>
              </span>
              <span className="pa__liq" role="cell">
                {fin(p.liquidityUsd) ? <Num v={p.liquidityUsd} fmt={fmtUsdWhole} /> : <Num v={null} prov={{ source: 'Osmosis SQS pools', at: null, status: 'missing', note: 'the router did not list this pool' }} />}
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
              <span className="pa__nam" role="cell"><Num v={p.namReserve} fmt={fmtNamRule} unit="NAM" showReason={false} /></span>
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
              {restTrades > 0 ? <>, <span data-num="">{fmtCount(restTrades)}</span> {restTrades === 1 ? 'trade' : 'trades'} here in 24 h</> : null}
            </span>
          </div>
        ) : null}
      </div>
    </>
  );
}

export default PairsList;
