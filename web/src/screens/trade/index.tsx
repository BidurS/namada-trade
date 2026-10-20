// Trade (/trade), S2. system.md 9.2, reference docs/design/final/trade.html.
//
// Phone: yellow ticket → black chart block → yellow "How size moves the price" → black pools.
// Desktop (1024 px up): a split ground. Left 5/12 the sticky yellow ticket (own scroll when taller
// than the window); right 7/12 black: chart, then the size block. Pools full width below.
//
// One shared state for the order size: the amount box, the presets, the curve's slider and the
// ladder rows all set it. With the live quote answering any amount is quoted live; with it down
// only the size table's listed sizes (and straight-line estimates, labelled) are shown.
// Under Rewind no live quote, size table or pool request is made (N3, W12).
import { useMemo, useState } from 'react';
import type { ScreenProps } from '../../app/index';
import { REWIND_WORDS, useClock, useOverview, useReplay } from '../../app/index';
import { Button, Notice, PriceChart, ProvScope, SkeletonBlock, type ChartRange } from '../../ui/index';
import type { Stamp } from '../../ui/index';
import { fmtNamRule, fmtPctSigned, fmtUtcClock } from '../../lib/format';
import { ageOutStamps } from '../../lib/prov';
import { PRICE_MOVES } from '../../generated/events';
import type { Reading, Side, TicketMode } from './model';
import { DEFAULT_SIZE, PRESET_SIZES, depthOf, fromQuote, fromTable, markerEvents, parseAmount, quoteKey, serviceAnswered, tablePoints } from './model';
import { usePools, usePriceHistory, useQuote, useSizeTable } from './data';
import { Ticket } from './Ticket';
import { SizeBlock } from './SizeBlock';
import { Pools } from './Pools';
import { routeById } from '../../../../shared/routes';

const TRADE = routeById('trade')!;

const EVENTS = markerEvents(PRICE_MOVES, (p) => fmtPctSigned(p, 1));

export default function TradeScreen({ route }: ScreenProps) {
  const { overview } = useOverview();
  const { at, rewound } = useReplay();
  const clock = useClock();
  const live = !rewound;

  // ---- the one order-size state
  const [side, setSide] = useState<Side>('sell');
  const [text, setText] = useState(() => fmtNamRule(DEFAULT_SIZE));
  const [amount, setAmount] = useState<number | null>(DEFAULT_SIZE);
  const [immediate, setImmediate] = useState(true);
  const pick = (n: number) => {
    if (!(n > 0)) return;
    setImmediate(true);
    setAmount(n);
    setText(fmtNamRule(n));
  };
  const type = (t: string) => {
    setImmediate(false);
    setText(t);
    setAmount(parseAmount(t));
  };
  const onSide = (s: Side) => {
    setImmediate(true);
    setSide(s);
  };

  // ---- data (live-only requests are off under Rewind)
  const table = useSizeTable(live);
  const pools = usePools(live);
  const history = usePriceHistory(at);
  const { result } = useQuote(live, side, amount, immediate);
  const [range, setRange] = useState<ChartRange>('30d');

  const pts = tablePoints(table.data);
  const up = serviceAnswered(result);
  const mode: TicketMode = rewound ? 'rewind' : up === true ? 'live' : pts.length ? 'table' : up === false && !table.loading ? 'down' : 'loading';
  const asking = !rewound && up === null && pts.length > 0;

  const reading: Reading = useMemo(() => {
    const n = amount ?? 0;
    const none = (reason: string, stamp: Stamp): Reading => ({ kind: 'none', side, n, value: null, nam: null, avg: null, spot: null, move: null, worth: null, stamp, reason });
    const quoteStamp = (note: string): Stamp => ({ source: 'Osmosis quote', at: null, status: 'missing', note });
    if (mode === 'rewind') return none(REWIND_WORDS.quotes, quoteStamp(REWIND_WORDS.quotes));
    if (amount == null) return none('No amount entered.', quoteStamp('No amount entered.'));
    if (mode === 'live') {
      const key = quoteKey(side, amount);
      if (result && result.key === key) return result.quote ? fromQuote(result.quote) : none(result.error ?? 'No quote for this size.', quoteStamp(result.error ?? 'No quote for this size.'));
      return { ...none('', quoteStamp('Asking now.')), kind: 'pending' };
    }
    if (mode === 'table') return fromTable(table.data, amount, side);
    if (mode === 'down') {
      const why = result?.error ?? 'The Osmosis quote service is not answering.';
      return none(`${why} The size table is empty too, so no size can be quoted.`, quoteStamp(why));
    }
    return { ...none('', quoteStamp('Asking now.')), kind: 'pending' };
  }, [mode, amount, side, result, table.data]);

  // A kept series after a failed refresh: its stamps read old, with since when (never fresh beside a failure).
  const kept = history.data != null && history.failedAt != null;
  const chartProv = useMemo(() => {
    const p = { executed: overview?.price.swap1h.prov ?? null, quoted: overview ? { ...overview.price.usd.prov, plain: 'Osmosis quote' } : null };
    return kept ? ageOutStamps(p, `The latest refresh of the price history did not answer, so the chart is the history fetched at ${fmtUtcClock(history.fetchedAt)}.`) : p;
  }, [overview, kept, history.fetchedAt]);

  const depth = depthOf(pools.data, overview);
  const sizes = mode === 'table' || asking ? pts.map((p) => p.amountNam) : PRESET_SIZES;

  return (
    <div className="trade" data-decision="D1" data-mode={mode} data-rewound={rewound || undefined}>
      <div className="split">
        <div className="split__a ground-accent">
          <div className="split__stick">
            <Ticket
              h1={(route ?? TRADE).h1}
              h1Buy={(route ?? TRADE).h1Alt ?? (route ?? TRADE).h1}
              side={side}
              onSide={onSide}
              text={text}
              amount={amount}
              onType={type}
              onPick={pick}
              sizes={sizes}
              mode={mode}
              asking={asking}
              reading={reading}
              overview={overview}
              depth={depth}
            />
          </div>
        </div>
        <div className="split__b ground-ink">
          <div className="tk-chart">
            {history.data ? (
              <ProvScope old={kept} oldSentence={kept ? <>The latest refresh of the price history did not answer, so this is the history fetched at {fmtUtcClock(history.fetchedAt)}, and it is shown dimmed.</> : null}>
                <PriceChart
                  headingId="h-chart"
                  series={history.data}
                  events={EVENTS}
                  range={range}
                  onRange={setRange}
                  end={at ?? clock}
                  cursorAt={at}
                  prov={chartProv}
                />
              </ProvScope>
            ) : history.error ? (
              // a failed load is said as such, never as "no trades in this window"
              <section className="tk-chartfail" aria-labelledby="h-chart">
                <h2 id="h-chart" className="h2">The price history did not load</h2>
                <Notice tone="warning" title={history.error} action={<Button size="sm" onClick={history.retry}>Try again</Button>}>
                  The chart is not shown until it answers. The quote and the size table do not depend on it.
                </Notice>
              </section>
            ) : (
              <div className="tk-chartskel" aria-busy="true" aria-label="Fetching the price history">
                <SkeletonBlock height={56} width="70%" />
                <SkeletonBlock height={20} width="50%" />
                <SkeletonBlock height={28} width={220} />
                <SkeletonBlock height={208} className="tk-chartskel__plot" />
              </div>
            )}
          </div>
          <SizeBlock rewound={rewound} table={table} amount={amount} side={side} onPick={pick} />
        </div>
      </div>
      <Pools rewound={rewound} pools={pools} depth={depth} overview={overview} />
    </div>
  );
}
