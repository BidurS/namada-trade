// "How size moves the price" (system.md 9.2): the order-size curve and the size table as a ladder,
// both sharing the ticket's amount (two-way: drag the slider or tap a row and the ticket follows;
// type an amount and the curve's cursor moves). Yellow on phones, black beside the ticket from
// 1024 px (.g-accent-to-ink). One SourceLine for the whole block.
import type { ReactNode } from 'react';
import type { QuoteCurveResponse } from '../../../../shared/types';
import { BODY } from '../../../../shared/copy';
import { REWIND_WORDS } from '../../app/index';
import { DataList, LadderRow, Notice, Num, OrderSizeCurve, ProvScope, Skeleton, SkeletonBlock, SourceLine, useUiNow } from '../../ui/index';
import { fmtAgo, fmtCoin, fmtNamRule, fmtPctSigned, fmtUsdRule } from '../../lib/format';
import type { Side } from './model';
import { safeSize, tablePoints, tableStamp } from './model';
import { SafeFig, safeDerivedFrom, safeHowWords } from './Safe';

export interface SizeBlockProps {
  rewound: boolean;
  table: { data: QuoteCurveResponse | null; error: string | null; loading: boolean };
  amount: number | null;
  side: Side;
  onPick: (n: number) => void;
}

export function SizeBlock({ rewound, table, amount, side, onPick }: SizeBlockProps) {
  const now = useUiNow();
  const pts = tablePoints(table.data);
  const stamp = tableStamp(table.data);
  const one = safeSize(table.data, 1);
  const three = safeSize(table.data, 3);
  const safeP = { ...stamp, derivedFrom: `1%: ${safeDerivedFrom(one, '1%')}; 3%: ${safeDerivedFrom(three, '3%')}` };

  let body: ReactNode;
  if (rewound) {
    body = (
      <Notice tone="info" title="The size table is a live reading.">
        It was not recorded over time, so it is not shown while rewound. {REWIND_WORDS.quotes}
      </Notice>
    );
  } else if (table.loading && !table.data) {
    body = (
      <div className="tk-sizeskel" aria-busy="true">
        <SkeletonBlock height={248} className="tk-sizeskel__plot" />
        <Skeleton rows={6} heights={[72]} label="the size table" />
      </div>
    );
  } else if (!pts.length) {
    body = (
      <>
        <Notice tone="warning" title="The size table is empty.">
          {table.data?.prov.note ?? table.error ?? 'The Osmosis quote service sent no sizes.'} No order size can be shown until it answers.
        </Notice>
        <SourceLine items={[{ label: 'Size table', p: stamp }]} label="Where the size table comes from" />
      </>
    );
  } else {
    body = (
      <>
        <OrderSizeCurve
          points={pts}
          value={amount ?? 0}
          onChange={onPick}
          side={side}
          mode="ticket"
          caption="Price move by order size"
          liquidityCliffNam={table.data?.liquidityCliffNam}
          cliffNote={table.data?.cliffNote}
        />
        <DataList kind="ladder" label="Price move by order size" className="tk-ladder">
          {pts.map((p) => (
            <LadderRow
              key={p.amountNam}
              size={<Num v={p.amountNam} fmt={fmtNamRule} unit="NAM" />}
              pickLabel={`Quote ${fmtNamRule(p.amountNam)} NAM`}
              value={<Num v={p.usdSize} fmt={fmtUsdRule} showReason={false} />}
              sellGet={<Num v={p.sellOutUsdc} fmt={(n) => fmtCoin(n)} showReason={false} />}
              sellMove={<Num v={p.sellImpactPct == null ? null : -Math.abs(p.sellImpactPct)} fmt={(n) => fmtPctSigned(n)} showReason={false} />}
              buyPay={<Num v={p.buyInUsdc} fmt={(n) => fmtCoin(n)} showReason={false} />}
              buyMove={<Num v={p.buyImpactPct == null ? null : Math.abs(p.buyImpactPct)} fmt={(n) => fmtPctSigned(n)} showReason={false} />}
              selected={amount === p.amountNam}
              onPick={() => onPick(p.amountNam)}
            />
          ))}
        </DataList>
        {one.how || three.how ? (
          <p className="cap tk-safe">
            The largest order that moves the price 1% or less, buying or selling, is <SafeFig s={one} />; 3% or less, <SafeFig s={three} />. {safeHowWords([one, three])}
          </p>
        ) : null}
        <SourceLine items={[{ label: 'Size table', p: stamp }, { label: 'Largest order under 1% and 3%', p: safeP }]} label="Where the size table comes from" />
      </>
    );
  }

  return (
    <section className="band g-accent-to-ink ladder" aria-labelledby="h-ladder">
      <div className="wrap">
        <h2 id="h-ladder" className="h2">How size moves the price</h2>
        {pts.length && !rewound ? <p className="lead">Tap a size to quote it. Every dot is a real quote from the pools.</p> : null}
        <p className="sub tk-body">{BODY.trade.paras[1]}</p>
        <ProvScope
          className="tk-size"
          old={pts.length > 0 && !rewound && stamp.status === 'stale'}
          oldSentence={<>The size table did not answer just now. The curve and the rows are its last answer, from {fmtAgo(stamp.at, now)}, so they are shown dimmed.</>}
        >
          {body}
        </ProvScope>
      </div>
    </section>
  );
}

export default SizeBlock;
