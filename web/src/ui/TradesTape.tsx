// TradesTape (F4, screener-plan 2.5): the newest NAM swaps on Osmosis, newest first, in the same role="table" grid
// rules as DataList (no <table>, no display: contents; cells are direct children of their row). Phones: a
// two-line row (the kind tag, and for a folded run "12 buys of about 351 NAM by the same address", with the
// signed NAM at the right; then the maker, which opens the Address sheet, the value at execution and the age).
// From an 880 px container the cells line up as columns. A folded run opens to its trades behind a disclosure.
//
// Words, never verdicts: "Repeated small buys" is a category tag that describes a pattern the server's rule found
// (the rule is printed under the tape by the screen), never a claim about intent. Buy and sell hues sit on the
// kind tag only. A trade without a price shows "—" with the reason, never a pool price standing in for its own; a
// price a repair took from the pool's hourly close, for a minute with no stored quote, says so with its hour.
//
// A trade's value is what it settled at for its trader when that is known (shared/settle.ts: every coin their balance
// changed by, fees and gas in, per NAM they gave or got), with the coins and rates in its details; else its recorded
// value with the price's basis.
import { useId, useState } from 'react';
import type { TradeGroup, TradeRow } from '../../../shared/types';
import { MINUS, NBSP, explorerTx, fmtAgo, fmtCoin, fmtCount, fmtDayClock, fmtNamRule, fmtUsdRule } from '../lib/format';
import { coinWord, priceShort } from '../lib/flows';
import { settleGasNote, settleWords } from '../lib/settle';
import { settleUsd } from '../../../shared/settle';
import { AddrName } from './ListBits';
import { Icon } from './Icon';
import { Tag } from './Tag';

/** A tape row: a folded run of one maker's trades on one side (a single trade is a run of one), with its rows. */
export interface TapeGroup extends TradeGroup {
  key: string;
  rows: TradeRow[];
  /** every row came through the live stream after the page was fetched */
  live: boolean;
}

export interface TradesTapeProps {
  groups: TapeGroup[];
  now: number;
  /** accessible name of the table */
  label: string;
  /** ids of rows that arrived through the stream after the first paint (they rise in once) */
  freshKeys?: ReadonlySet<string>;
  /** "Only this address": show one maker's trades (the screen re-asks with ?maker=) */
  onMaker?: (maker: string) => void;
  /** the maker the tape is filtered to (its rows then say so instead of offering the filter) */
  maker?: string | null;
}

const fin = (x: number | null | undefined): x is number => x != null && Number.isFinite(x);
const signed = (kind: 'buy' | 'sell', nam: number) => `${kind === 'buy' ? '+' : MINUS}${fmtNamRule(nam)}`;
const PATTERN_WORD = 'Repeated small buys';

/** "3 to 12 min ago" for a run; "12 min ago" for one trade. */
function spanAgo(g: TapeGroup, now: number): string {
  const newest = fmtAgo(g.lastTs, now);
  if (g.n === 1 || g.firstTs === g.lastTs) return newest;
  const oldest = fmtAgo(g.firstTs, now);
  if (oldest === newest) return newest;
  // "3 min ago" and "12 min ago" share their unit: "3 to 12 min ago"
  const a = newest.replace(/ ago$/, '');
  const b = oldest.replace(/ ago$/, '');
  const ua = a.split(NBSP)[1];
  const ub = b.split(NBSP)[1];
  return ua && ua === ub ? `${a.split(NBSP)[0]} to ${b} ago` : `${a} to ${b} ago`;
}

export function TradesTape({ groups, now, label, freshKeys, onMaker, maker }: TradesTapeProps) {
  return (
    <div className="tape" role="table" aria-label={label} aria-rowcount={groups.length + 1}>
      <div className="tape__head" role="row">
        <span role="columnheader">When</span>
        <span role="columnheader">What</span>
        <span role="columnheader" className="r">NAM</span>
        <span role="columnheader">Who</span>
        <span role="columnheader" className="r">Value at the trade</span>
        <span role="columnheader" className="r">Trades</span>
      </div>
      {groups.map((g) => (
        <TapeRow key={g.key} g={g} now={now} fresh={!!freshKeys?.has(g.key)} onMaker={onMaker} filtered={!!maker && g.maker === maker} />
      ))}
    </div>
  );
}

function TapeRow({ g, now, fresh, onMaker, filtered }: { g: TapeGroup; now: number; fresh: boolean; onMaker?: (m: string) => void; filtered: boolean }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const one = g.n === 1 ? g.rows[0] : null;
  const verb = g.kind === 'buy' ? (g.n === 1 ? 'buy' : 'buys') : g.n === 1 ? 'sell' : 'sells';
  const avgNam = g.n > 0 ? g.nam / g.n : null;
  const label = one ? one.makerLabelPlain : g.rows.find((r) => r.makerLabelPlain)?.makerLabelPlain ?? null;
  const src = one ?? g.rows.find((r) => r.makerLabelPlain) ?? g.rows[0];
  const trades = one?.makerTrades ?? g.rows.find((r) => r.makerTrades)?.makerTrades ?? null;
  const ago = spanAgo(g, now);
  const pattern = g.pattern === 'repeated_small_buys';

  return (
    <div className={`tr${fresh ? ' is-new' : ''}${open ? ' is-open' : ''}${g.n > 1 || pattern ? ' tr--fold' : ''}`} role="row" data-kind={g.kind} data-n={g.n}>
      <span className="tr__time" role="cell">
        <time dateTime={new Date(g.lastTs).toISOString()}>{ago}</time>
      </span>
      <span className="tr__what" role="cell">
        <Tag kind={g.kind} />
      </span>
      <span className="tr__nam" role="cell">
        <span data-num="" data-status="fresh">{signed(g.kind, g.nam)}</span>
        <span className="u"> NAM</span>
      </span>
      <span className="tr__who" role="cell">
        {g.maker ? (
          <AddrName address={g.maker} label={label} source={src?.makerLabelSource} author={src?.makerLabelAuthor} withAddr />
        ) : (
          <span>maker not recorded</span>
        )}
      </span>
      <span className="tr__val" role="cell">
        {fin(g.usd) ? (
          <>
            <span data-num="" data-status="fresh">{fmtUsdRule(g.usd)}</span>
            {g.n > 1 && fin(g.avgPriceUsd) ? <span className="tr__avg">, average <span data-num="">{fmtUsdRule(g.avgPriceUsd)}</span></span>
              : one?.settle ? <span className="tr__avg"> settled at <span data-num="">{fmtUsdRule(one.settle.usdPerNam)}</span></span>
              : one && fin(one.priceUsd) ? <span className="tr__avg"> at <span data-num="">{fmtUsdRule(one.priceUsd)}</span></span> : null}
            {g.unpriced > 0 ? <span className="tr__why"> ({fmtCount(g.unpriced)} without a price)</span> : null}
          </>
        ) : (
          <>
            <span data-num="" data-status="none">—</span>
            <span className="tr__why"> {one?.priceNote ?? 'No price was recorded for these trades.'}</span>
          </>
        )}
      </span>
      <span className="tr__act" role="cell">
        <button type="button" className="tr__tog" aria-expanded={open} aria-controls={`${id}t`} onClick={() => setOpen((o) => !o)}>
          {/* phones: the age opens the details (the time column is the wide layout's) */}
          <span className="tr__togN">{ago}<span className="sr-only">{g.n > 1 ? `, show the ${fmtCount(g.n)} trades` : ', details'}</span></span>
          <span className="tr__togW">{g.n > 1 ? <>{open ? 'Hide' : 'Show'} the <span data-num="">{fmtCount(g.n)}</span> trades</> : open ? 'Hide details' : 'Details'}</span>
          <Icon name="chev" className="ico" />
        </button>
      </span>
      {g.n > 1 || pattern ? (
        <span className="tr__fold" role="cell">
          {pattern ? <Tag cat={PATTERN_WORD} /> : null}
          {g.n > 1 ? (
            <span className="tr__foldT">
              <span data-num="">{fmtCount(g.n)}</span> {verb} of about <span data-num="">{fmtNamRule(avgNam)}</span>{NBSP}NAM by the same address
            </span>
          ) : null}
        </span>
      ) : null}
      {open ? (
        <div className="tr__more" id={`${id}t`} role="cell">
          <ul className="tr__list">
            {g.rows.map((r) => (
              <li key={r.id} className="tr__one">
                <span className="tr__oneT">
                  {fmtDayClock(r.ts)}
                  {r.tsSource === 'interpolated' || r.tsSource === 'extrapolated' ? <span className="tr__why"> (time estimated from nearby blocks)</span> : null}
                </span>
                <span className="tr__oneN"><span data-num="">{fmtNamRule(r.nam)}</span>{NBSP}NAM</span>
                <span className="tr__oneV">
                  {r.settle ? (
                    <>
                      <span data-num="">{fmtUsdRule(settleUsd(r.settle))}</span> settled at <span data-num="">{fmtUsdRule(r.settle.usdPerNam)}</span>
                      <span className="tr__why"> · {settleWords(r.settle)}{settleGasNote(r.settle) ? `. ${settleGasNote(r.settle)}` : ''}</span>
                    </>
                  ) : (
                    <>
                      {fin(r.valueUsd) ? <><span data-num="">{fmtUsdRule(r.valueUsd)}</span>{fin(r.priceUsd) ? <> at <span data-num="">{fmtUsdRule(r.priceUsd)}</span></> : null}</> : <><span data-num="" data-status="none">—</span> {r.priceNote ?? 'no price was recorded for this trade'}</>}
                      {/* a trade's own price needs no note; any other basis is said */}
                      {fin(r.priceUsd) && r.priceSource !== 'execution' ? <span className="tr__why"> · {priceShort(r.priceSource === 'swap_1h' || r.priceSource === 'spot' || r.priceSource === 'pool_1h' ? r.priceSource : 'unstated', r.priceAt)}</span> : null}
                      {fin(r.counterAmount) && coinWord(r.counterSymbol) ? <span className="tr__why"> · {r.kind === 'buy' ? 'paid' : 'got'} <span data-num="">{fmtCoin(r.counterAmount)}</span> {coinWord(r.counterSymbol)}</span> : null}
                    </>
                  )}
                  {r.route.length ? <span className="tr__why"> · through {r.route.length === 1 ? 'pool' : 'pools'} {r.route.map((p) => `#${p}`).join(', ')}</span> : null}
                </span>
                <a className="xrec" href={explorerTx('osmosis', r.explorerHash || r.txHash)} target="_blank" rel="noreferrer noopener" aria-label={`The record of this trade on an Osmosis explorer, block ${fmtCount(r.height)} (opens another site)`}>
                  <span>Record</span>
                  <Icon name="external" className="ico ico--inline" />
                </a>
              </li>
            ))}
          </ul>
          {trades ? (
            <p className="tr__why tr__counts">
              This address’s trades on record: <span data-num="">{fmtCount(trades.buys)}</span> {trades.buys === 1 ? 'buy' : 'buys'} and <span data-num="">{fmtCount(trades.sells)}</span> {trades.sells === 1 ? 'sell' : 'sells'}, bot round trips left out.
            </p>
          ) : null}
          {onMaker && g.maker && !filtered ? (
            <p className="tr__only">
              <button type="button" className="btn btn--secondary btn--sm" onClick={() => onMaker(g.maker!)}>Only this address’s trades</button>
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default TradesTape;
