// View 2, THE BOOK as levels (depth plan 3.2): asks above, bids below, the reference price as the fixed middle row,
// bands of ½ / 1 / 2½ % of the reference price read off the minute's cumulative curves (model.ts ladderOf, the
// research prototype's rule), each row with the price band at significant digits, what rests in it (NAM and USD,
// both), its distance from the price, a cumulative bar behind it (the bid hue one way, the ask hue the other) and
// chips naming its pools with their fee. Rows further than LADDER_FOLD_PCT from the price are folded, and so are the
// rows between LADDER_MID_PCT and it, each fold a button that says what it hides. The band the picked size's last
// coin fills in is marked. A row tap opens a Sheet (never a hover box off the page edge): the pools in the band with
// each one's NAM, USD and tick ranges or orders, and what selling down to (or buying up to) the band comes to.
// Table view: every band in order with its cumulative figure, no bars, nothing folded.
import { Fragment, useMemo, useState } from 'react';
import type { DepthResponse } from '../../../../shared/depth';
import {
  CHART_VIEW, HEAD_CUM, HEAD_FROM, LABEL_LEVEL_WIDTH, LADDER_H2, LADDER_TABLE_LABEL, RESERVES_WORDS, SOURCE_EVERY_LEVEL, SOURCE_LEVELS, HEAD_POOLS, HEAD_RESTING, LADDER_BAND_PCTS, LADDER_FOLD_PCT, LADDER_MID_PCT, TABLE_VIEW, bandHead, bandWidthLabel, bestWords, bookChip, buyUpWords, crossedWords, distFromPrice, foldFar, foldMid, hideFold, ladderLead,
  markedBand as markedWords, openBandAria, ordersWords, poolFeeChip, rangesWords, refRowWords, sellDownWords, sheetTitle, spreadWords, takerOnEvery,
} from '../../../../shared/depth';
import { Button, Segmented, Sheet, SourceLine, type Stamp } from '../../ui/index';
import { NBSP, fmtCount, fmtNamRule, fmtPctRule, fmtPctSigned, fmtSig, fmtUsdRule } from '../../lib/format';
import { cumToBand, isBook, isFar, isMid, ladderOf, markedBand, poolName, takerPct, touchSpread, type Band, type BandPool, type Reading } from './model';

/** What a pool's share of a band is read from, in words: its tick ranges, its orders, or its reserves (a weighted or stable pool has no ticks). */
const kindWords = (p: BandPool): string => (p.kind === 'orders' ? ordersWords(p.orders) : p.kind === 'ranges' ? rangesWords(p.ranges) : RESERVES_WORDS);

export interface LadderProps {
  d: DepthResponse;
  symbol: string;
  stamp: Stamp;
  reading: Reading | null;
  headingId: string;
}

type Width = '0.5' | '1' | '2.5';
const WIDTHS: { value: Width; label: string }[] = LADDER_BAND_PCTS.map((w) => ({ value: String(w) as Width, label: bandWidthLabel(fmtPctRule(w, w % 1 ? 1 : 0)) }));

const amountOf = (b: Band, symbol: string) => (b.side === 'ask' ? `${fmtNamRule(b.nam)} ${symbol}` : fmtUsdRule(b.usd));
const sum = (rows: Band[], side: 'ask' | 'bid', symbol: string) => (side === 'ask' ? `${fmtNamRule(rows.reduce((a, r) => a + r.nam, 0))} ${symbol}` : fmtUsdRule(rows.reduce((a, r) => a + r.usd, 0)));

export function Ladder({ d, symbol, stamp, reading, headingId }: LadderProps) {
  const [width, setWidth] = useState<Width>('1');
  const [table, setTable] = useState(false);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [sheet, setSheet] = useState<Band | null>(null);
  const ladder = useMemo(() => ladderOf(d, Number(width)), [d, width]);
  const marked = useMemo(() => markedBand(ladder, reading), [ladder, reading]);
  const spread = touchSpread(d);
  const taker = takerPct(d);
  const toggle = (k: string) => setOpen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const shown = (k: string) => table || open.has(k);
  const pct = (x: number) => fmtPctSigned(x, Math.abs(x) < 10 ? 1 : 0);
  const fold = fmtPctRule(LADDER_FOLD_PCT, 0), mid = fmtPctRule(LADDER_MID_PCT, 0);

  const row = (b: Band) => {
    const isAsk = b.side === 'ask';
    const w = Math.min(100, (b.cum / (isAsk ? ladder.maxCumAsk : ladder.maxCumBid) || 0) * 100);
    const mark = marked === b;
    return (
      <div key={`${b.side}${b.lo}`} className={`dp-lrow dp-lrow--${b.side}${mark ? ' is-mark' : ''}`} role="row" aria-selected={mark || undefined}>
        {!table ? <i className="dp-lrow__bar" style={{ width: `${w.toFixed(1)}%` }} aria-hidden="true" /> : null}
        <span className="dp-lrow__band" role="cell">
          <span data-num="">{fmtSig(b.lo)}</span><span className="dp-lrow__to">{NBSP}–{NBSP}</span><span data-num="">{fmtSig(b.hi)}</span>
          <button type="button" className="dp-lrow__open" aria-label={openBandAria(b.side, fmtSig(b.lo), fmtSig(b.hi), amountOf(b, symbol), pct(b.dist))} onClick={() => setSheet(b)} />
        </span>
        <span className="dp-lrow__rest" role="cell">
          <b data-num="">{amountOf(b, symbol)}</b>
          <small data-num="">{isAsk ? fmtUsdRule(b.usd) : `${fmtNamRule(b.nam)} ${symbol}`}</small>
        </span>
        {table ? <span className="dp-lrow__cum" role="cell" data-num="">{isAsk ? `${fmtNamRule(b.cum)} ${symbol}` : fmtUsdRule(b.cum)}</span> : null}
        <span className="dp-lrow__dist" role="cell" data-num="">{pct(b.dist)}</span>
        <span className="dp-lrow__pools" role="cell">
          {b.pools.slice(0, 3).map((p) => (
            <span key={p.id} className="dp-chip">{isBook(p.type) ? bookChip(poolName(d, p.id)) : poolFeeChip(poolName(d, p.id), fmtPctRule(p.feePct, p.feePct % 1 ? 2 : 0))}</span>
          ))}
          {b.pools.length > 3 ? <span className="dp-chip dp-chip--n">+{b.pools.length - 3}</span> : null}
          {mark ? <span className="dp-lrow__mark">{markedWords(fmtNamRule(reading!.nam), symbol)}</span> : null}
        </span>
      </div>
    );
  };
  const foldRow = (key: string, side: 'ask' | 'bid', rows: Band[], words: string, hide: string) =>
    rows.length ? (
      <Fragment key={key}>
        {!table ? (
          <button type="button" className="dp-fold" aria-expanded={shown(key)} onClick={() => toggle(key)}>
            <span className="dp-fold__t" aria-hidden="true">{shown(key) ? '▾' : '▸'}</span>
            {shown(key) ? hideFold(side, hide) : words}
          </button>
        ) : null}
        {shown(key) ? rows.map(row) : null}
      </Fragment>
    ) : null;

  const farA = ladder.asks.filter(isFar), midA = ladder.asks.filter(isMid), nearA = ladder.asks.filter((b) => !isFar(b) && !isMid(b));
  const farB = ladder.bids.filter(isFar), midB = ladder.bids.filter(isMid), nearB = ladder.bids.filter((b) => !isFar(b) && !isMid(b));
  const t = d.touch;
  const refWords = (
    <>
      <b>{refRowWords(d.ref.pool, fmtSig(d.ref.usd))}</b>
      {t.bestBidEff != null && t.bestBidPool ? <> · {bestWords('bid', fmtCount(t.sizeNam), symbol, fmtSig(t.bestBidEff), poolName(d, t.bestBidPool))}</> : null}
      {t.bestAskEff != null && t.bestAskPool ? <> · {bestWords('ask', fmtCount(t.sizeNam), symbol, fmtSig(t.bestAskEff), poolName(d, t.bestAskPool))}</> : null}
      {spread != null && t.bestBidPool && t.bestAskPool ? (
        <> · {spread < 0 ? crossedWords(fmtCount(t.sizeNam), symbol, fmtPctRule(-spread, 2), poolName(d, t.bestAskPool), poolName(d, t.bestBidPool)) : spreadWords(fmtPctSigned(spread, 2))}</>
      ) : null}
    </>
  );
  const total = ladder.asks.length + ladder.bids.length + 1;

  return (
    <div className="dp-ladder" data-prov-scope="" data-view={table ? 'table' : 'ladder'}>
      <h2 id={headingId} className="h2">{LADDER_H2}</h2>
      <p className="cap dp-lead">{ladderLead(symbol)}</p>
      <div className="dp-ctl">
        <Segmented label={LABEL_LEVEL_WIDTH} variant="range" value={width} onChange={setWidth} options={WIDTHS} />
        <Button size="sm" aria-pressed={table} onClick={() => setTable((v) => !v)}>{table ? CHART_VIEW : TABLE_VIEW}</Button>
      </div>
      <div className="dp-rows" role="table" aria-label={LADDER_TABLE_LABEL} aria-rowcount={total}>
        <div className="dp-lrow dp-lrow--head" role="row">
          <span role="columnheader">{bandHead(symbol)}</span>
          <span role="columnheader">{HEAD_RESTING}</span>
          {table ? <span role="columnheader">{HEAD_CUM}</span> : null}
          <span role="columnheader">{HEAD_FROM}</span>
          <span role="columnheader">{HEAD_POOLS}</span>
        </div>
        {foldRow('fa', 'ask', farA, foldFar('ask', farA.length, fold, fmtSig(farA[0]?.hi ?? 0), sum(farA, 'ask', symbol)), `above +${fold}`)}
        {foldRow('ma', 'ask', midA, foldMid('ask', midA.length, mid, fold, sum(midA, 'ask', symbol)), `between +${mid} and +${fold}`)}
        {nearA.map(row)}
        <div className="dp-lrow dp-lrow--ref" role="row"><span role="cell">{refWords}</span></div>
        {nearB.map(row)}
        {foldRow('mb', 'bid', midB, foldMid('bid', midB.length, mid, fold, sum(midB, 'bid', symbol)), `between −${mid} and −${fold}`)}
        {foldRow('fb', 'bid', farB, foldFar('bid', farB.length, fold, fmtSig(farB[farB.length - 1]?.lo ?? 0), sum(farB, 'bid', symbol)), `below −${fold}`)}
      </div>
      <SourceLine items={[{ label: SOURCE_EVERY_LEVEL, p: stamp }]} label={SOURCE_LEVELS} />
      {sheet ? (
        <Sheet
          open
          onClose={() => setSheet(null)}
          title={sheetTitle(sheet.side, fmtSig(sheet.lo), fmtSig(sheet.hi))}
          lead={sheet.side === 'bid' ? sellDownWords(fmtSig(sheet.lo), fmtUsdRule(cumToBand(d, sheet))) : buyUpWords(fmtSig(sheet.hi), fmtUsdRule(cumToBand(d, sheet)))}
        >
          <ul className="dp-sheet__pools">
            {sheet.pools.map((p) => (
              <li key={p.id}>
                <span className="dp-chip">{isBook(p.type) ? bookChip(poolName(d, p.id)) : poolFeeChip(poolName(d, p.id), fmtPctRule(p.feePct, p.feePct % 1 ? 2 : 0))}</span>
                <span data-num="">{fmtNamRule(p.nam)} {symbol}</span>
                <span data-num="">{fmtUsdRule(p.usd)}</span>
                <span className="cap">{kindWords(p)}</span>
              </li>
            ))}
          </ul>
          {taker != null ? <p className="cap">{takerOnEvery(fmtPctRule(taker, taker % 1 ? 2 : 0))}.</p> : null}
          {marked === sheet && reading ? <p className="cap">{markedWords(fmtNamRule(reading.nam), symbol)}.</p> : null}
          <p className="cap">{distFromPrice(pct(sheet.dist))} · {ladderLead(symbol)}</p>
        </Sheet>
      ) : null}
    </div>
  );
}

export default Ladder;
