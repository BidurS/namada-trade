// Depth (/depth), step S5: views 1 and 2 of the depth plan (section 3.2). Phone: the yellow answer band (view 1),
// then the black book band with two tabs, Levels and Curve (view 2). Desktop (1024 px up): the answer band, then the
// book band as a split, the ladder the sticky left 5/12 column and the curve on the right. Then (step S6) the black
// time band (view 3: the heat, the executable line, the change rows, the cost and what was left out) and the black
// owners band (view 4).
//
// The phone cut (owner, 2026-10-29: the phone view is not user friendly; the go for the rest of it on 2026-10-30): under
// 1024 px a segmented strip under the answer band shows one of the three evidence bands at a time (the book first), so
// the page is about five screens instead of fifteen; every band stays a labelled section in the DOM, and from 1024 px
// the strip is hidden and all three bands show as before.
//
// One shared state for the side and the size: the chips read the minute's own figures for the four stored sizes;
// any other size typed is walked on the stored minute by /api/depth/quote (debounced). The minute is fetched every
// DEPTH_REFRESH_MS and at once when the live stream delivers an Osmosis swap (depth plan section 4), with an "updated
// N s ago" age on the hero. Under Rewind the stored figures of that minute come from /api/depth/history (no split,
// said so), the field is off, and the ladder and the curve are not shown, since the minute's tick maps are not
// stored (said so). A server without the routes shows the reason, never a fault.
import { useMemo, useState } from 'react';
import type { ScreenProps } from '../../app/index';
import { useOverview, useReplay } from '../../app/index';
import { Notice, Segmented, SkeletonBlock } from '../../ui/index';
import { fmtNamRule, fmtUtcClock } from '../../lib/format';
import { ageOutStamps } from '../../lib/prov';
import { routeById } from '../../../../shared/routes';
import { BOOK_EYEBROW, BOOK_WAITS, DEPTH_ASKING, FETCHING_MINUTE, LABEL_BANDS, LABEL_BOOK_VIEW, OVER_EYEBROW, REWIND_NO_BOOK, REWIND_NO_MINUTE, SITE_SYMBOL, TAB_CURVE, TAB_LEVELS, WHO_EYEBROW, rewindMinute } from '../../../../shared/depth';
import { Answer } from './Answer';
import { Ladder } from './Ladder';
import { Curve } from './Curve';
import { Over } from './Over';
import { Who } from './Who';
import { quoteKey, useDepthChanges, useDepthHistoryAt, useDepthLatest, useDepthOwners, useDepthQuote, useTradesWeek } from './data';
import { refreshFailedNote } from '../home/data';
import { DEFAULT_SIZE, SIZES, depthStamp, parseAmount, pointAt, readingOfPoint, readingOfQuote, readingOfStored, type Reading, type Side } from './model';

const DEPTH = routeById('depth');
type BookView = 'levels' | 'curve';
type Band = 'book' | 'over' | 'who';

export default function DepthScreen({ route }: ScreenProps) {
  const { liveFlows } = useOverview();
  const { at, rewound } = useReplay();
  const live = !rewound;
  const symbol = SITE_SYMBOL;

  // ---- the one size state
  const [side, setSide] = useState<Side>('sell');
  const [text, setText] = useState(() => fmtNamRule(DEFAULT_SIZE));
  const [amount, setAmount] = useState<number | null>(DEFAULT_SIZE);
  const [immediate, setImmediate] = useState(true);
  const pick = (n: number) => { if (!(n > 0)) return; setImmediate(true); setAmount(n); setText(fmtNamRule(n)); };
  const type = (t: string) => { setImmediate(false); setText(t); setAmount(parseAmount(t)); };
  const onSide = (s: Side) => { setImmediate(true); setSide(s); };
  const [view, setView] = useState<BookView>('levels');
  const [band, setBand] = useState<Band>('book');
  // a class, not the hidden attribute (the reset's [hidden] rule is !important): from 1024 px every band shows
  const off = (b: Band) => (band !== b ? ' is-off' : '');

  // ---- data: the newest streamed Osmosis swap asks the minute again
  const swap = liveFlows.find((f) => f.chain === 'osmosis' && (f.kind === 'buy' || f.kind === 'sell'));
  const latest = useDepthLatest(live, live && swap ? swap.id : '');
  const d = latest.data;
  const stored = amount != null && SIZES.includes(amount);
  const quote = useDepthQuote(live && d != null && amount != null && !stored, side, stored ? null : amount, immediate, d?.at ?? null);
  const history = useDepthHistoryAt(at);
  const trades = useTradesWeek(at);
  // step S6: the change rows of the last month (the time view's longest window; the owners' "replaced this week" reads the same rows) and the hour's owners
  const changes = useDepthChanges(30, at);
  const owners = useDepthOwners(live);

  // a kept minute after a failed refresh reads old, with the time it was fetched
  const kept = d != null && latest.failedAt != null;
  const stamp = useMemo(() => (d ? (kept ? ageOutStamps(depthStamp(d), refreshFailedNote(latest.fetchedAt)) : depthStamp(d)) : null), [d, kept, latest.fetchedAt]);
  const past = useMemo(() => (at != null ? pointAt(history.data, at) : null), [history.data, at]);
  const pastWords = at != null && history.data && !past ? REWIND_NO_MINUTE : at != null && history.error ? history.error : null;

  const reading: Reading | null = useMemo(() => {
    if (amount == null) return null;
    if (rewound) {
      if (!past) return null;
      return readingOfPoint(past, side, amount, SIZES, rewindMinute(fmtUtcClock(past.at)));
    }
    if (!d) return null;
    if (stored) {
      const r = readingOfStored(d, side, amount);
      return r && stamp ? { ...r, stamp } : r;
    }
    if (quote && quote.key === quoteKey(side, amount)) {
      if (quote.quote) return readingOfQuote(quote.quote);
      return { kind: 'none', side, nam: amount, fill: null, vsRef: null, stamp: { ...depthStamp(d), status: 'missing', note: quote.error ?? undefined }, reason: quote.error ?? undefined };
    }
    return { kind: 'pending', side, nam: amount, fill: null, vsRef: null, stamp: { ...depthStamp(d), status: 'missing', note: DEPTH_ASKING } };
  }, [amount, rewound, past, side, d, stored, quote, stamp]);
  const asking = live && d != null && !stored && amount != null && reading?.kind === 'pending';

  const bookBody = rewound ? (
    <Notice tone="info" title={REWIND_NO_BOOK} />
  ) : d && stamp ? (
    <div className="dp-book" data-view={view}>
      {/* a class, not the hidden attribute: the reset's [hidden] rule is !important, and from 1024 px both columns show */}
      <div className={`dp-book__a${view !== 'levels' ? ' is-off' : ''}`}>
        <Ladder d={d} symbol={symbol} stamp={stamp} reading={reading} headingId="h-ladder" />
      </div>
      <div className={`dp-book__b${view !== 'curve' ? ' is-off' : ''}`}>
        <Curve d={d} symbol={symbol} stamp={stamp} trades={trades} headingId="h-curve" />
      </div>
    </div>
  ) : latest.error ? (
    <Notice tone="warning" title={latest.error}>{BOOK_WAITS}</Notice>
  ) : (
    <div className="dp-bookskel" aria-busy="true" role="status" aria-label={FETCHING_MINUTE}>
      <SkeletonBlock height={28} width="60%" />
      <SkeletonBlock height={44} width={280} />
      <SkeletonBlock height={520} />
    </div>
  );

  return (
    <div className="depth" data-rewound={rewound || undefined}>
      <section className="band ground-accent dp-answer" aria-labelledby="dp-h1">
        <div className="wrap">
          <Answer
            h1={(route ?? DEPTH).h1}
            symbol={symbol}
            d={d}
            stamp={stamp}
            failed={!d && latest.error ? latest.error : null}
            loading={latest.loading}
            retry={latest.retry}
            side={side}
            onSide={onSide}
            text={text}
            amount={amount}
            onType={type}
            onPick={pick}
            reading={reading}
            asking={!!asking}
            rewound={rewound}
            past={past}
            pastPool={history.data?.refPool ?? null}
            pastWords={pastWords}
            fetchedAt={latest.fetchedAt}
          />
        </div>
      </section>
      <div className="band ground-ink dp-stripband">
        <div className="wrap">
          <Segmented label={LABEL_BANDS} block className="dp-strip" value={band} onChange={setBand} options={[{ value: 'book', label: BOOK_EYEBROW }, { value: 'over', label: OVER_EYEBROW }, { value: 'who', label: WHO_EYEBROW }]} />
        </div>
      </div>
      <section className={`band ground-ink dp-bookband${off('book')}`} aria-labelledby="h-book">
        <div className="wrap">
          <p className="eyebrow dp-band__eyebrow">{BOOK_EYEBROW}</p>
          <h2 id="h-book" className="sr-only">{BOOK_EYEBROW}</h2>
          {!rewound && d ? (
            <Segmented label={LABEL_BOOK_VIEW} className="dp-tabs" value={view} onChange={setView} options={[{ value: 'levels', label: TAB_LEVELS }, { value: 'curve', label: TAB_CURVE }]} />
          ) : null}
          {bookBody}
        </div>
      </section>
      <section className={`band ground-ink dp-overband${off('over')}`} aria-labelledby="h-over">
        <div className="wrap">
          <p className="eyebrow dp-band__eyebrow">{OVER_EYEBROW}</p>
          <Over d={d} stamp={stamp} symbol={symbol} at={at} trades={trades} changes={changes} headingId="h-over" />
        </div>
      </section>
      <section className={`band ground-ink dp-whoband${off('who')}`} aria-labelledby="h-who">
        <div className="wrap">
          <p className="eyebrow dp-band__eyebrow">{WHO_EYEBROW}</p>
          <Who owners={owners} changes={changes} symbol={symbol} rewound={rewound} headingId="h-who" />
        </div>
      </section>
    </div>
  );
}
