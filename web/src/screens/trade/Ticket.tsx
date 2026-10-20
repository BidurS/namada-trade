// The Trade ticket (system.md 9.2): the yellow band that answers the H1. It is first on phones and
// the sticky left column from 1024 px. Four honest states:
// - live: the Osmosis quote for exactly this amount ("Osmosis quote · now"), any amount typed;
// - table: the quote service is not answering, the figures come from the size table at a listed
//   size (or a labelled straight line between two listed sizes), the amount box is read-only;
// - down: neither answers, so there is no figure, only the reason and the last stored price;
// - rewind: live quotes are paused; the last trade price at that time is shown instead.
import type { Overview } from '../../../../shared/types';
import { BODY } from '../../../../shared/copy';
import { Field, Notice, Num, ProvChip, ProvDot, Segmented, SelectChip, SkeletonBlock, Tag, Term, derive } from '../../ui/index';
import type { Stamp } from '../../ui/index';
import { NBSP, fmtCoin, fmtNamRule, fmtPctSigned, fmtUsdRule, fmtUsdWhole, fmtCount } from '../../lib/format';
import type { Depth, Reading, Side, TicketMode } from './model';
import { refPrice } from './model';

const SIDES: { value: Side; label: string }[] = [
  { value: 'sell', label: 'Sell NAM for USDC' },
  { value: 'buy', label: 'Buy NAM with USDC' },
];

export interface TicketProps {
  /** The heading on the sell side (RouteDef.h1). */
  h1: string;
  /** The heading on the buy side (RouteDef.h1Alt). */
  h1Buy: string;
  side: Side;
  onSide: (s: Side) => void;
  text: string;
  amount: number | null;
  onType: (t: string) => void;
  onPick: (n: number) => void;
  sizes: number[];
  mode: TicketMode;
  /** The first live quote has not settled yet (the size table is shown meanwhile). */
  asking: boolean;
  reading: Reading;
  overview: Overview | null;
  depth: Depth | null;
}

export function Ticket({ h1, h1Buy, side, onSide, text, amount, onType, onPick, sizes, mode, asking, reading, overview, depth }: TicketProps) {
  const editable = mode === 'live' || mode === 'loading' || asking;
  const invalid = amount == null && text.trim() !== '';
  const ref = refPrice(overview);
  const fixedFigures = reading.kind === 'live' || reading.kind === 'table' || reading.kind === 'estimate';

  // ---- the label-row marker beside "Amount"
  const marker =
    mode === 'rewind' ? (
      <><i className="dot" data-status="none" aria-hidden="true" />live quotes paused</>
    ) : (mode === 'table' && !asking) || mode === 'down' ? (
      <><i className="dot" data-status="old" aria-hidden="true" />live quote not answering</>
    ) : asking ? (
      <><i className="dot" data-status="none" aria-hidden="true" />asking for a live quote</>
    ) : null;

  // ---- "Worth about $5.13": the reading's own figure, else the amount at the stored price
  const worthWord = side === 'sell' ? 'Worth about' : 'Value of about';
  const worth =
    fixedFigures && reading.worth != null ? (
      <Num v={reading.worth} prov={reading.stamp} fmt={fmtUsdRule} showAge={false} label="Worth of the amount" />
    ) : amount != null && ref ? (
      <Num v={ref.value != null ? amount * ref.value : null} prov={derive([ref.prov], 'amount x quoted price')} fmt={fmtUsdRule} showReason={false} label="Worth of the amount" />
    ) : null;

  const note =
    mode === 'table' && !asking
      ? 'Listed sizes only: other sizes cannot be quoted until the quote service answers.'
      : mode === 'down'
        ? 'No size can be quoted until the quote service answers. Picking a size asks it again.'
        : null;

  return (
    <>
      {/* data-prov-group: the ticket's figures (worth, average, quoted price, move) share the result's ProvChip */}
      <div className="ticket" id="tk-ticket" data-mode={mode} data-prov-group="">
        <p className="eyebrow">Trade · NAM on Osmosis</p>
        <h1 className="h1">{side === 'sell' ? h1 : h1Buy}</h1>
        <p className="sub">{BODY.trade.paras[0]}</p>
        <Segmented label="Side" block className="seg--side" value={side} onChange={onSide} options={SIDES} />
        <Field
          className="tk-field"
          label="Amount"
          state={marker}
          unit="NAM"
          value={text}
          onChange={onType}
          readOnly={!editable}
          hint={worth ? <>{worthWord} {worth}</> : <span className="tk-slot" aria-hidden="true" />}
          error={
            invalid ? (
              <Notice tone="danger" title="That is not an amount.">
                Amounts are numbers of NAM, written with digits.
              </Notice>
            ) : null
          }
          onBlur={() => {
            if (amount != null && text !== fmtNamRule(amount)) onType(fmtNamRule(amount));
          }}
        />
        <SelectChip
          layout="presets"
          label="Amount presets"
          value={amount != null && sizes.includes(amount) ? String(amount) : null}
          onChange={(v) => onPick(Number(v))}
          options={sizes.map((n) => ({ value: String(n), label: fmtNamRule(n) }))}
        />
        {note ? <p className="field__note tk-note">{note}</p> : null}

        <GetBlock side={side} mode={mode} reading={reading} overview={overview} />
      </div>
      {depth && depth.usd != null ? (
        <Notice tone="warning" className="notice--thin" title={<><Term id="thin-market">Thin market</Term>.</>}>
          {/* The pool figures carry their own stamp; the sale figures repeat the ticket's, under its ProvChip. */}
          <span data-prov-group="">
            The pools on Osmosis hold <Num v={depth.usd} prov={depth.stamp} fmt={fmtUsdWhole} showReason={false} /> in total
            {depth.count != null ? <>, across <Num v={depth.count} prov={depth.stamp} fmt={fmtCount} showAge={false} /> pools</> : null}
            {' '}<ProvDot p={depth.stamp} label="Money in the Osmosis pools" />.
          </span>
          {fixedFigures && reading.move != null ? (
            <span data-prov-ref="tk-ticket">
              {' '}
              {side === 'sell' ? 'A sale' : 'A purchase'} of <Num v={reading.n} fmt={fmtNamRule} />{NBSP}NAM already moves the price{' '}
              <Num v={reading.move} prov={reading.stamp} fmt={(n) => fmtPctSigned(n)} showAge={false} />.
            </span>
          ) : null}
        </Notice>
      ) : null}
    </>
  );
}

function GetBlock({ side, mode, reading, overview }: { side: Side; mode: TicketMode; reading: Reading; overview: Overview | null }) {
  const pending = reading.kind === 'pending';
  const figures = reading.kind === 'live' || reading.kind === 'table' || reading.kind === 'estimate';
  const verb = side === 'sell' ? 'You get' : 'You pay';

  // the marker after "You get"
  const kindMark =
    reading.kind === 'table' ? (
      <span className="field__state"><i className="dot" data-status="old" aria-hidden="true" />from the size table</span>
    ) : reading.kind === 'estimate' ? (
      <>
        <Tag cat="Estimate" term="estimate" />
        <span className="field__state">between <span data-num="">{fmtNamRule(reading.a)}</span> and <span data-num="">{fmtNamRule(reading.b)}</span>{NBSP}NAM</span>
      </>
    ) : null;

  // the sentence under the number
  const sentence = pending ? (
    <SkeletonBlock height={16} width="70%" />
  ) : figures ? (
    side === 'sell' ? (
      <>for <Num v={reading.nam} fmt={fmtNamRule} />{NBSP}NAM at an average <Num v={reading.avg} prov={reading.stamp} fmt={fmtUsdRule} showAge={false} showReason={false} /> each</>
    ) : (
      <>for about <Num v={reading.nam} prov={reading.stamp} fmt={fmtNamRule} showAge={false} showReason={false} />{NBSP}NAM at an average <Num v={reading.avg} prov={reading.stamp} fmt={fmtUsdRule} showAge={false} showReason={false} /> each</>
    )
  ) : (
    <span className="get__reason">{reading.reason}</span>
  );

  // the pair under the sentence
  const lastQuoted = overview ? { value: overview.price.usd.value, prov: { ...overview.price.usd.prov, plain: 'Osmosis quote' } as Stamp } : null;
  const lastTrade = overview ? overview.price.swap1h : null;
  const pairLeft =
    mode === 'rewind' ? (
      <><dt>Last trade price then</dt><dd>{lastTrade ? <Num v={lastTrade.value} prov={lastTrade.prov} fmt={fmtUsdRule} showAge label="Last trade price" /> : <SkeletonBlock height={26} width={110} />}</dd></>
    ) : figures ? (
      <><dt>Quoted price</dt><dd><Num v={reading.spot} prov={reading.stamp} fmt={fmtUsdRule} showAge={false} showReason={false} /></dd></>
    ) : pending ? (
      <><dt>Quoted price</dt><dd><SkeletonBlock height={26} width={110} /></dd></>
    ) : (
      <><dt>Last quoted price</dt><dd>{lastQuoted ? <Num v={lastQuoted.value} prov={lastQuoted.prov} fmt={fmtUsdRule} showAge showReason={false} label="Last quoted price" /> : <SkeletonBlock height={26} width={110} />}</dd></>
    );

  const why =
    reading.kind === 'table'
      ? 'These figures come from the size table, measured at the same moment, not from a live quote for your amount.'
      : reading.kind === 'estimate'
        ? 'These figures are a straight line between two rows of the size table, not a quote for your amount.'
        : null;

  // one polite announcement per new reading (the chip's age ticks every 5 s and must not be read out)
  const summary = pending
    ? ''
    : figures && reading.value != null
      ? `${verb} ${fmtCoin(reading.value)} USDC for ${side === 'buy' ? 'about ' : ''}${fmtNamRule(reading.nam)} NAM, price move ${fmtPctSigned(reading.move)}${reading.kind === 'estimate' ? ', an estimate' : reading.kind === 'table' ? ', from the size table' : ''}.`
      : `${verb}: no figure. ${reading.reason ?? ''}`;

  const derivedNam: Stamp | null = side === 'buy' && (reading.kind === 'table' || reading.kind === 'estimate') ? derive([reading.stamp], 'USDC paid / average price') : null;

  return (
    <div className="get" aria-busy={pending || undefined}>
      <p className="sr-only" aria-live="polite">{summary}</p>
      <p className="get__k">{verb} {kindMark}</p>
      <p className="get__v">
        {pending ? (
          <SkeletonBlock height={48} width={150} />
        ) : (
          <>
            <Num v={reading.value} prov={reading.stamp} fmt={(n) => fmtCoin(n)} showAge={false} showReason={false} label={verb} />
            {reading.value != null ? <span className="get__u">USDC</span> : null}
          </>
        )}
      </p>
      <p className="get__s">{sentence}</p>
      <dl className="pair">
        <div>{pairLeft}</div>
        <div>
          <dt><Term id="price-move">Price move</Term></dt>
          <dd className="pair__big">
            {pending ? <SkeletonBlock height={28} width={90} /> : <Num v={reading.move} prov={reading.stamp} fmt={(n) => fmtPctSigned(n)} showAge={false} showReason={false} label="Price move" />}
          </dd>
        </div>
      </dl>
      {why ? <p className="get__why">{why}</p> : null}
      <p className="get__prov">
        {pending ? <span className="tk-chipslot" aria-hidden="true" /> : <ProvChip p={reading.stamp} label={reading.kind === 'live' ? 'The live quote' : reading.kind === 'none' ? 'The quote' : 'The size table'} />}
      </p>
      {derivedNam ? (
        <p className="get__why get__why--sm">
          About how many NAM: derived from the USDC paid and the average price. <ProvDot p={derivedNam} label="About how many NAM" />
        </p>
      ) : null}
    </div>
  );
}

export default Ticket;

