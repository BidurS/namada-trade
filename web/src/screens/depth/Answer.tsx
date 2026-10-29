// View 1, THE ANSWER (depth plan 3.2): the yellow ticket band that answers the H1 in money. Sell / Buy, the four
// stored sizes as chips and an amount field for any other size (quoted on the stored minute by /api/depth/quote,
// debounced; a chip reads the minute's own figure at once), the hero, the split by pool, a Fact strip, the router's
// own answer for the smallest size from the minute's check, the when-not-to-act sentences computed from the reading
// (verify.txt C3: never typed), a ProvChip on the hero and one SourceLine naming every read of the minute.
// Rewound: the stored figures of that minute from /api/depth/history (no split, said so); the field is off.
import type { ReactNode } from 'react';
import type { DepthHistoryPoint, DepthResponse } from '../../../../shared/depth';
import {
  ANSWER_WAITS, ASKING_SIZE, DEPTH_EYEBROW, DEPTH_OFFSETS_PCT, DEPTH_PLAIN_SOURCE, DEPTH_SOURCES, DEPTH_SOURCE_LABEL, DEPTH_TOUCH_SIZE, FACT_AVG, FACT_REF_UNNAMED, LABEL_AMOUNT, LABEL_SIDE, LABEL_SIZE, MINUTE_FIGURES, MINUTE_NOT_ANSWERED, NOT_AMOUNT, NOT_STORED_PER_MINUTE, OFFSET_10_INDEX, OFFSET_50_INDEX, REWIND_FIELD_OFF, REWIND_NO_SPLIT, ROUTER_AGREE, ROUTER_AGREE_PCT, ROUTER_IDLE, SPLIT_LABEL, STORED_MINUTE_FIGURES, THROUGH, TRY_AGAIN,
  afterFees, amountsAre, andMore, bookBidUnder, cliffBuyWords, cliffWords, depthLead, factAskUsdWithin, factAskWithin, factBidWithin, factMarginal, factRef, factTouch, heightClock, heroVerb, heroWords, marketWords, quoteIncomplete, readingOf, routerDiffer, routerOurs, routerSays, sideLabel, splitWords, toTakeAll, updatedAgo, vsRefWords, withinAllWords,
} from '../../../../shared/depth';
import { Button, Fact, Field, HeroNumber, Notice, Num, ProvChip, Segmented, SelectChip, SkeletonBlock, SourceLine, useUiNow, type ScopeItem, type Stamp } from '../../ui/index';
import { NBSP, fmtAgo, fmtCoin, fmtCount, fmtNamRule, fmtPctRule, fmtPctSigned, fmtSharePct, fmtSig, fmtUsdRule, fmtUtcClock } from '../../lib/format';
import { SIZES, bookRule, cliffOf, marketSize, poolName, provStamp, routerLine, splitShares, type Reading, type Side } from './model';

export interface AnswerProps {
  h1: string;
  symbol: string;
  d: DepthResponse | null;
  /** The minute's stamp, old once kept after a failed refresh. */
  stamp: Stamp | null;
  /** The page's own failure, in plain words (the minute never answered). */
  failed: string | null;
  loading: boolean;
  retry: () => void;
  side: Side;
  onSide: (s: Side) => void;
  text: string;
  amount: number | null;
  onType: (t: string) => void;
  onPick: (n: number) => void;
  reading: Reading | null;
  /** The quote for a typed size is on its way. */
  asking: boolean;
  rewound: boolean;
  /** Rewound: the stored minute read, or null while it loads; `past` false when none was stored around that time. */
  past: DepthHistoryPoint | null;
  /** Rewound: the reference pool the stored rows' price is read from (the history answer names it), or null until it answers. */
  pastPool: string | null;
  pastWords: string | null;
  /** When the minute shown was fetched (the "updated 12 s ago" age). */
  fetchedAt: number | null;
}

const SHOW_SPLIT = 8;

export function Answer(p: AnswerProps) {
  const { h1, symbol, d, stamp, side, reading, rewound } = p;
  const now = useUiNow();
  const sides = [
    { value: 'sell' as const, label: sideLabel('sell', symbol) },
    { value: 'buy' as const, label: sideLabel('buy', symbol) },
  ];
  const invalid = p.amount == null && p.text.trim() !== '';
  const editable = !rewound && d != null;
  const marker = rewound ? (
    <><i className="dot" data-status="none" aria-hidden="true" />{REWIND_FIELD_OFF}</>
  ) : p.asking ? (
    <><i className="dot" data-status="none" aria-hidden="true" />{ASKING_SIZE}</>
  ) : null;
  const pending = reading?.kind === 'pending' || (!reading && !p.failed && (p.loading || (rewound && p.past == null && !p.pastWords)));
  const fill = reading?.fill ?? null;
  const rstamp = reading?.stamp ?? stamp;
  const verb = heroVerb(side);
  const age = p.fetchedAt != null ? fmtAgo(p.fetchedAt, now) : null;

  // ---- the hero
  const hero = pending ? (
    <SkeletonBlock height={48} width={150} />
  ) : fill && rstamp ? (
    <Num v={fill.usd} prov={rstamp} fmt={fmtUsdRule} showAge={false} showReason={false} label={verb} />
  ) : (
    <Num v={null} prov={rstamp ?? { source: DEPTH_SOURCES.poolManager, plain: DEPTH_PLAIN_SOURCE, at: null, status: 'missing', note: reading?.reason ?? p.failed ?? p.pastWords ?? MINUTE_NOT_ANSWERED }} label={verb} />
  );
  const sub = pending ? (
    <SkeletonBlock height={16} width="70%" />
  ) : fill ? (
    <>
      {heroWords(side, fmtCoin(fill.usd, 6), fmtNamRule(fill.filledNam), symbol)}
      {!fill.complete ? <> ({reading?.reason ?? quoteIncomplete(side, fmtNamRule(fill.filledNam), symbol)})</> : null}
      {reading?.kind === 'past' ? <> · {readingOf(fmtUtcClock(reading.stamp.at))}</> : age ? <> · {updatedAgo(age)}</> : null}
    </>
  ) : null;

  // ---- the split as chips
  const shares = fill && fill.split.length ? splitShares(fill) : [];
  const split = reading?.kind === 'past' ? (
    <p className="cap dp-split__none">{REWIND_NO_SPLIT}</p>
  ) : shares.length ? (
    <ul className="dp-split" aria-label={SPLIT_LABEL}>
      <li className="dp-split__k">{THROUGH}</li>
      {shares.slice(0, SHOW_SPLIT).map((s) => (
        <li key={s.pool} className="dp-split__c"><span data-num="">{splitWords(poolName(d, s.pool), fmtNamRule(s.nam), symbol, fmtPctRule(s.pct, 0))}</span></li>
      ))}
      {shares.length > SHOW_SPLIT ? <li className="dp-split__k">{andMore(shares.length - SHOW_SPLIT)}</li> : null}
    </ul>
  ) : null;

  // ---- the fact strip: live from the minute, rewound from the stored row
  const facts = d && rstamp && !rewound ? liveFacts(d, rstamp, side, reading, symbol) : p.past && rstamp && rewound ? pastFacts(p.past, rstamp, side, reading, symbol, p.pastPool, d?.touch.sizeNam ?? DEPTH_TOUCH_SIZE) : null;

  // ---- the router line and the computed sentences (live only: the checks are the minute's)
  const router = d && !rewound ? routerLine(d) : null;
  const routerText = d && !rewound ? (
    router ? (
      <>
        <b>{routerSays(fmtCoin(router.routerUsd, 6), fmtNamRule(router.nam), symbol, poolName(d, router.pool), fmtUtcClock(router.at))}</b>; {routerOurs(fmtCoin(router.oursUsd, 6))}.{' '}
        {Math.abs(router.diffPct) <= ROUTER_AGREE_PCT ? ROUTER_AGREE : routerDiffer(fmtPctRule(Math.abs(router.diffPct), 3))}
      </>
    ) : (
      ROUTER_IDLE
    )
  ) : null;
  const say: ReactNode[] = [];
  if (d && !rewound) {
    const cliff = cliffOf(d, side);
    if (cliff) {
      const pct = (x: number) => fmtPctSigned(x, 1);
      const f = side === 'sell' ? cliffWords : cliffBuyWords;
      say.push(f(fmtNamRule(cliff.above), symbol, fmtNamRule(cliff.a.nam), pct(cliff.a.pct), cliff.b ? fmtNamRule(cliff.b.nam) : fmtNamRule(cliff.a.nam), cliff.b ? pct(cliff.b.pct) : pct(cliff.a.pct)));
    }
    const book = side === 'sell' ? bookRule(d) : null;
    if (book) say.push(bookBidUnder(fmtPctRule(book.underPct, 1), poolName(d, book.bookId)));
    const m = marketSize(d, side, fill);
    if (m && reading && reading.kind !== 'past') say.push(marketWords(side, m.unit === 'usd' ? fmtUsdRule(m.total) : `${fmtNamRule(m.total)} ${symbol}`, fmtNamRule(reading.nam), symbol, fmtSharePct(m.share)));
  }

  const reads: ScopeItem[] = d ? d.prov.map((x) => ({ label: x.what, p: provStamp(x) })) : [];
  const old = rstamp?.status === 'stale';

  return (
    <div className="dp-ticket" id="dp-ticket" data-prov-group="" data-mode={rewound ? 'rewind' : reading?.kind ?? 'loading'}>
      <p className="eyebrow">{DEPTH_EYEBROW}</p>
      <h1 className="h1">{h1}</h1>
      <p className="sub">{depthLead(symbol)}</p>
      <Segmented label={LABEL_SIDE} block className="seg--side" value={side} onChange={p.onSide} options={sides} />
      <SelectChip
        layout="presets"
        label={LABEL_SIZE}
        value={p.amount != null && SIZES.includes(p.amount) ? String(p.amount) : null}
        onChange={(v) => p.onPick(Number(v))}
        options={SIZES.map((n) => ({ value: String(n), label: fmtNamRule(n) }))}
      />
      <Field
        className="dp-field"
        label={LABEL_AMOUNT}
        state={marker}
        unit={symbol}
        value={p.text}
        onChange={p.onType}
        readOnly={!editable}
        error={invalid ? <Notice tone="danger" title={NOT_AMOUNT}>{amountsAre(symbol)}</Notice> : null}
        onBlur={() => {
          if (p.amount != null && p.text !== fmtNamRule(p.amount)) p.onType(fmtNamRule(p.amount));
        }}
      />
      {p.failed && !d ? (
        <Notice tone="warning" title={p.failed} action={<Button size="sm" onClick={p.retry}>{TRY_AGAIN}</Button>}>
          {ANSWER_WAITS}
        </Notice>
      ) : null}
      <div className={`get dp-get${old ? ' is-old' : ''}`} aria-busy={pending || undefined}>
        <HeroNumber
          size="48"
          label={verb}
          value={<>{hero}{fill && !pending ? <span className="u">{NBSP}USD</span> : null}</>}
          chip={pending ? <span className="dp-chipslot" aria-hidden="true" /> : rstamp ? <ProvChip p={rstamp} label={verb} /> : null}
          sub={sub}
        />
        {split}
      </div>
      {facts}
      {routerText ? <p className="dp-router">{routerText}</p> : null}
      {say.length ? (
        <div className="dp-say">
          {say.map((s, i) => <p key={i}>{s}</p>)}
        </div>
      ) : null}
      {reads.length ? <SourceLine items={reads} label={DEPTH_SOURCE_LABEL} /> : null}
    </div>
  );
}

/** The six figures of a live minute, each inside the strip's scope. */
function liveFacts(d: DepthResponse, stamp: Stamp, side: Side, reading: Reading | null, symbol: string): ReactNode {
  const fill = reading?.fill ?? null;
  const ref = d.ref.usd;
  const touch = side === 'sell' ? { price: d.touch.bestBidEff, pool: d.touch.bestBidPool } : { price: d.touch.bestAskEff, pool: d.touch.bestAskPool };
  const pct10 = fmtPctRule(DEPTH_OFFSETS_PCT[OFFSET_10_INDEX], 0);
  const pct50 = fmtPctRule(DEPTH_OFFSETS_PCT[OFFSET_50_INDEX], 0);
  const price = (v: number | null | undefined) => <Num v={v} fmt={(n) => fmtSig(n)} showReason={false} />;
  const scope: ScopeItem = { label: MINUTE_FIGURES, p: stamp };
  return (
    <Fact
      className="dp-facts"
      sourceLabel={DEPTH_SOURCE_LABEL}
      items={[
        { n: price(fill?.avgPrice), label: <>{FACT_AVG}<small className="fact__s">{fill?.avgPrice != null ? vsRefWords(fmtPctSigned((fill.avgPrice / ref - 1) * 100, 1), d.ref.pool) : ''}</small></>, scope },
        { n: price(fill?.marginalPrice), label: <>{factMarginal(symbol)}<small className="fact__s">{fill?.marginalPrice != null && Number.isFinite(fill.marginalPrice) ? vsRefWords(fmtPctSigned((fill.marginalPrice / ref - 1) * 100, 1), d.ref.pool) : ''}</small></> },
        { n: price(ref), label: <>{factRef(d.ref.pool)}<small className="fact__s">{heightClock(d.ref.height != null ? fmtCount(d.ref.height) : '—', fmtUtcClock(d.ref.at))}</small></> },
        { n: price(touch.price), label: <>{factTouch(side, fmtCount(d.touch.sizeNam), symbol)}<small className="fact__s">{touch.pool ? afterFees(poolName(d, touch.pool)) : ''}</small></> },
        { n: <Num v={d.within.bidUsd10} fmt={fmtUsdRule} showReason={false} />, label: <>{factBidWithin(pct10)}<small className="fact__s">{withinAllWords(fmtUsdRule(d.within.totalBidUsd), fmtUsdRule(d.within.bidUsd50), pct50)}</small></> },
        { n: <Num v={d.within.askNam10} fmt={fmtNamRule} unit={symbol} showReason={false} />, label: <>{factAskWithin(pct10, symbol)}<small className="fact__s">{toTakeAll(fmtUsdRule(d.within.askUsd10))}</small></> },
      ]}
    />
  );
}

/**
 * The figures a stored minute keeps (the offsets, the sizes, the touch, the reference), each with its own stamp. The
 * reference pool is the history answer's (`pool`; the live minute is never asked while rewound), the touch size the
 * configuration's as the live minute reports it.
 */
function pastFacts(pt: DepthHistoryPoint, stamp: Stamp, side: Side, reading: Reading | null, symbol: string, pool: string | null, touchSize: number): ReactNode {
  const fill = reading?.fill ?? null;
  const ref = pt.refUsd;
  const touch = side === 'sell' ? pt.bestBid : pt.bestAsk;
  const pct10 = fmtPctRule(DEPTH_OFFSETS_PCT[OFFSET_10_INDEX], 0);
  const notStored: Stamp = { ...stamp, status: 'missing', note: NOT_STORED_PER_MINUTE };
  const price = (v: number | null | undefined) => <Num v={v} fmt={(n) => fmtSig(n)} showReason={false} />;
  const scope: ScopeItem = { label: STORED_MINUTE_FIGURES, p: stamp };
  const refLabel = pool ? factRef(pool) : FACT_REF_UNNAMED;
  const vs = (pct: string) => (pool ? vsRefWords(pct, pool) : '');
  return (
    <Fact
      className="dp-facts"
      sourceLabel={DEPTH_SOURCE_LABEL}
      items={[
        { n: price(fill?.avgPrice), label: <>{FACT_AVG}<small className="fact__s">{fill?.avgPrice != null ? vs(fmtPctSigned((fill.avgPrice / ref - 1) * 100, 1)) : ''}</small></>, scope },
        { n: <Num v={null} prov={notStored} />, label: factMarginal(symbol) },
        { n: price(ref), label: <>{refLabel}<small className="fact__s">{heightClock(pt.height != null ? fmtCount(pt.height) : '—', fmtUtcClock(pt.at))}</small></> },
        { n: price(touch), label: factTouch(side, fmtCount(touchSize), symbol) },
        { n: <Num v={pt.bid[OFFSET_10_INDEX]} fmt={fmtUsdRule} showReason={false} />, label: factBidWithin(pct10) },
        { n: <Num v={pt.ask[OFFSET_10_INDEX]} fmt={fmtUsdRule} showReason={false} />, label: factAskUsdWithin(pct10) },
      ]}
    />
  );
}

export default Answer;
