// TxList: the transaction feed (system.md 9.5; the Activity tab). The same role="table" grid rules as
// DataList (no <table>, no display: contents): below an 880 px container each move is a two-line row
// (kind tag and signed NAM; from → to and the value), and the age opens a third line with the time
// and price source and the record; from 880 px the cells line up as a 7-column table with sticky
// column heads. Rows that arrived through the stream (`streamedIds`) animate in once.
import { useId, useRef, useState } from 'react';
import type { Flow } from '../../../shared/types';
import { kindSign } from '../lib/kinds';
import { MINUS, fmtAddr, fmtAgo, fmtCoin, fmtCount, fmtNamRule, fmtUsdRule, fmtUtcLong, explorerTxOf, labelNeedsAddr } from '../lib/format';
import { chainWord, coinWord, dayHm, priceHow, priceShort, tagOf, timeEstimated, type PriceHow } from '../lib/flows';
import { priceAtOf, priceBasisWords, priceRouteOf } from '../../../shared/flow-rules';
import { flowSettle, settleGasNote, settleWords } from '../lib/settle';
import { settleUsd, type Settle } from '../../../shared/settle';
import { tagByline } from '../../../shared/labels';
import { Icon } from './Icon';
import { Tag } from './Tag';

export interface TxListProps {
  rows: Flow[];
  now: number;
  streamedIds?: ReadonlySet<string>;
  /** An address button was pressed: the address, and the move it is on (the screen says where the sheet came from). */
  onAddr: (a: string, f: Flow) => void;
  busy?: boolean;
  /**
   * Every move the filters select, when that is known (the rows on screen are one page of them): the table then says
   * `aria-rowcount` = total + 1 (the head row) and each row its place, so a screen reader hears "row 52 of 53,935".
   * null: the length is not known (-1). Absent: the rows on screen are the whole list.
   */
  total?: number | null;
  /** The place in the whole list of the move before the first row here (page 3 of 50: 100). */
  offset?: number;
}

export function TxList({ rows, now, streamedIds, onAddr, busy, total, offset = 0 }: TxListProps) {
  const paged = total !== undefined;
  const rowCount = !paged ? rows.length + 1 : total == null ? -1 : Math.max(total, offset + rows.length) + 1;
  return (
    <div className={`txl${busy ? ' is-busy' : ''}`} role="table" aria-label="NAM moves, newest first" aria-rowcount={rowCount}>
      <div className="txl__head" role="row" aria-rowindex={paged ? 1 : undefined}>
        <span role="columnheader">Time (UTC)</span>
        <span role="columnheader">What</span>
        <span role="columnheader" className="r">NAM</span>
        <span role="columnheader" className="r">Value</span>
        <span role="columnheader">From and to</span>
        <span role="columnheader">Time and price source</span>
        <span role="columnheader" className="r">Record</span>
      </div>
      {rows.map((f, i) => (
        <TxRow key={f.id} f={f} now={now} isNew={!!streamedIds?.has(f.id)} onAddr={onAddr} rowIndex={paged ? offset + i + 2 : undefined} />
      ))}
    </div>
  );
}

function Who({ addr, label, byline, poolId, onAddr }: { addr: string | null; label: string | null | undefined; byline?: string | null; poolId?: string | null; onAddr: (a: string) => void }) {
  if (!addr) {
    const first = poolId?.split(',')[0]?.trim();
    return <span className="tx__pool">{first ? `pool #${first}` : 'pool'}</span>;
  }
  const short = (
    <>
      {/* rows (phones) use a shorter form so both sides fit on one line; the table uses the usual one */}
      <span className="tx__as">{`${addr.slice(0, 8)}…${addr.slice(-4)}`}</span>
      <span className="tx__al">{fmtAddr(addr)}</span>
    </>
  );
  return (
    <>
      {/* No aria-label: the name is the words on screen (WCAG 2.5.3) plus the full address for screen readers. */}
      <button type="button" className={`tx__addr${label ? '' : ' mono'}`} title={addr} onClick={() => onAddr(addr)}>
        {label ?? short}
        <span className="sr-only">{label && byline ? `, ${byline.toLowerCase()}` : ''}: open address {addr}</span>
      </button>
      {/* A label keeps its short address beside it: a genesis label names thousands of addresses, so the label
          alone cannot tell a seller from the largest holder (lib/format labelNeedsAddr; a protocol account's name
          is one address and stays alone). Its own flex item, so on phones it wraps under the name with the arrow
          after it; hidden from screen readers, which hear the full address in the button. */}
      {labelNeedsAddr(addr, label) ? <span className="tx__la" aria-hidden="true">{short}</span> : null}
      {/* A name a signed-in wallet typed is not a curated label: it says who wrote it (shared/labels tagByline). */}
      {label && byline ? <span className="tx__by" aria-hidden="true">{byline}</span> : null}
    </>
  );
}

function TxRow({ f, now, isNew, onAddr, rowIndex }: { f: Flow; now: number; isNew: boolean; onAddr: (a: string, f: Flow) => void; rowIndex?: number }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const tk = tagOf(f);
  const sign = kindSign(tk);
  const nam = fmtNamRule(f.amount);
  const signed = sign > 0 ? `+${nam}` : sign < 0 && nam !== '0' ? `${MINUS}${nam}` : nam;
  const how = priceHow(f);
  // a trade's value is what it settled at for its trader when that is known (as on the trades tape)
  const settle = flowSettle(f);
  const fromL = f.fromLabelPlain ?? null;
  const toL = f.toLabelPlain ?? null;
  const age = fmtAgo(f.ts, now);
  const ref = useRef<HTMLDivElement>(null);

  return (
    <div ref={ref} className={`tx${isNew ? ' is-new' : ''}${open ? ' is-open' : ''}`} role="row" data-kind={f.kind} aria-rowindex={rowIndex}>
      <span className="tx__time" role="cell">
        <time dateTime={new Date(f.ts).toISOString()}>{dayHm(f.ts)}</time>
        <span className="tx__ago">{age}</span>
      </span>
      <span className="tx__what" role="cell">
        <Tag kind={tk} />
        {/* phones: the age opens line 3, the time and price source */}
        <button type="button" className="tx__tog" aria-expanded={open} aria-controls={`${id}d`} aria-label={`${age}. Time and price source`} onClick={() => setOpen((o) => !o)}>
          <span className="tx__ago">{age}</span>
          <Icon name="chev" className="ico" />
        </button>
      </span>
      <span className="tx__nam" role="cell">
        <span data-num="" data-status="fresh">{signed}</span>
        <span className="u"> NAM</span>
      </span>
      <span className="tx__val" role="cell">
        {settle ? (
          <span data-num="" data-status="fresh">{fmtUsdRule(settleUsd(settle))}</span>
        ) : f.valueUsd != null && Number.isFinite(f.valueUsd) ? (
          <span data-num="" data-status="fresh">{fmtUsdRule(f.valueUsd)}</span>
        ) : (
          <>
            <span data-num="" data-status="none">—</span>
            <span className="tx__why">no price</span>
          </>
        )}
      </span>
      <span className="tx__who" role="cell">
        <Who addr={f.from} label={fromL} byline={tagByline(f.fromLabelSource, f.fromLabelAuthor)} poolId={f.poolId} onAddr={(a) => onAddr(a, f)} />
        <Icon name="arrow" className="ico tx__arrow" />
        <Who addr={f.to} label={toL} byline={tagByline(f.toLabelSource, f.toLabelAuthor)} poolId={f.poolId} onAddr={(a) => onAddr(a, f)} />
      </span>
      <span className="tx__src" role="cell">
        <span className="tx__srcw">
          <span>{timeEstimated(f) ? 'Estimated time' : 'Block time'}</span>
          <span>{settle ? 'settle price' : priceShort(how, priceAtOf(f))}</span>
          {/* the words a Discord alert of this move carries in its title (owner decision 14) */}
          {foundLateOf(f) ? <span>found late</span> : null}
        </span>
      </span>
      <span className="tx__rec" role="cell">
        <a className="tx__reclink" href={explorerTxOf(f)} target="_blank" rel="noreferrer noopener" aria-label={`The record of this move on a ${chainWord(f.chain)} explorer, block ${fmtCount(f.height)} (opens another site)`}>
          <span>{fmtCount(f.height)}</span>
          <Icon name="external" className="ico ico--inline" />
        </a>
      </span>
      {open ? (
        <div className="tx__more" id={`${id}d`} role="cell">
          <Detail f={f} how={how} settle={settle} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Why a move was found late, in the words of its Discord alert (owner decision 14): the live feed missed it and the
 * catch-up search found it (meta.via 'catch-up search'), or the live scan read its block late (meta.via 'late scan');
 * null for a move read live.
 */
const foundLateOf = (f: Flow): string | null => {
  const via = (f.meta as Record<string, unknown> | null | undefined)?.via;
  return via === 'catch-up search' ? 'the live feed missed this move' : via === 'late scan' ? 'the live scan was behind and read this move late' : null;
};

/** Line 3 on phones: when, how the price was set, what it traded against, and the record. */
function Detail({ f, how, settle }: { f: Flow; how: PriceHow; settle: Settle | null }) {
  const coin = coinWord(f.counterDenom);
  const pools = f.poolId ? f.poolId.split(',').map((p) => `#${p.trim()}`).join(', ') : null;
  const price = f.priceUsd != null ? `${fmtUsdRule(f.priceUsd)} per NAM` : null;
  const gasNote = settle ? settleGasNote(settle) : '';
  const priceText = settle ? `Settled at ${fmtUsdRule(settle.usdPerNam)} a NAM: ${settleWords(settle)}.${gasNote ? ` ${gasNote}` : ''}`
    : how === 'execution' ? `Price: ${price}, from this trade itself.`
    : how === 'swap_1h' ? `Price: ${price}, the median of that hour’s trades.`
    : how === 'spot' ? `Price: ${price}, ${priceBasisWords('spot', null, priceRouteOf(f))}.`
    : how === 'pool_1h' ? `Price: ${price}, ${priceBasisWords(how, priceAtOf(f))}.`
    : how === 'unstated' ? `Price: ${price}, recorded with the move; how it was set is not stated.`
    : 'No price was recorded for this move, so it has no dollar value.';
  return (
    <>
      <span>
        {timeEstimated(f) ? 'Time: estimated from nearby blocks, ' : 'Time: from the block, '}
        {fmtUtcLong(f.ts)}.
        {foundLateOf(f) ? ` Found late: ${foundLateOf(f)}; its alert says so.` : null}
      </span>
      <span>{priceText}</span>
      {coin && f.counterAmount != null ? (
        <span>
          {f.kind === 'buy' ? 'Paid' : f.kind === 'sell' ? 'Received' : 'Traded against'} {fmtCoin(f.counterAmount)} {coin}
          {pools ? `, through pool${pools.includes(',') ? 's' : ''} ${pools}` : ''}.
        </span>
      ) : pools ? (
        <span>Pool{pools.includes(',') ? 's' : ''} {pools}.</span>
      ) : null}
      <a className="link tx__morelink" href={explorerTxOf(f)} target="_blank" rel="noreferrer noopener">
        <span>{chainWord(f.chain)} record, block {fmtCount(f.height)}</span>
        <Icon name="external" className="ico ico--inline" />
      </a>
    </>
  );
}
