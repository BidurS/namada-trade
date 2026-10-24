// Trade (/trade), S2. system.md 9.2, reference docs/design/final/trade.html; the screener basics of
// docs/design/screener-plan.md section 2 placed per its 4.2.
//
// Phone: yellow ticket → black chart block (the token header: price with its stamp, its changes, what traded in
// 24 h, pool depth and the two value lines; then the price chart with its hourly volume bars and quoted band, the
// pool price on the long ranges, and the date each series begins) → what recent buyers paid → yellow "How size
// moves the price" → black pools with their volume → black "The latest trades" tape.
// Desktop (1024 px up): a split ground. Left 5/12 the sticky yellow ticket (own scroll when taller
// than the window); right 7/12 black: header, chart, buyers, then the size block. Pools and the tape full width below.
//
// The chart block is the price chart. Under it one button opens a second chart, what was bought and
// sold over the window (NAM bought and NAM sold per bucket, with the running difference); that record is
// fetched only while it is shown (N9), has its own range, and on a server that does not serve it yet it
// reads as missing with the reason, never as a fault. Each chart's "All" is a cap (shared/history.ts) and
// says so when the history runs into it.
//
// One shared state for the order size: the amount box, the presets, the curve's slider and the
// ladder rows all set it. With the live quote answering any amount is quoted live; with it down
// only the size table's listed sizes (and straight-line estimates, labelled) are shown.
// Under Rewind no live quote, size table or pool request is made (N3, W12).
import { useMemo, useState } from 'react';
import type { ScreenProps } from '../../app/index';
import { REWIND_WORDS, useClock, useOverview, useOverviewFailed, useReplay } from '../../app/index';
import { Button, Notice, Num, OrderflowChart, PriceChart, ProvScope, SkeletonBlock, type ChartRange } from '../../ui/index';
import type { Stamp } from '../../ui/index';
import { fmtCount, fmtNamRule, fmtPctSigned, fmtUtcClock } from '../../lib/format';
import { ageOutStamps } from '../../lib/prov';
import { PRICE_MOVES } from '../../generated/events';
import { HISTORY_ALL_DAYS, historyCapReached } from '../../../../shared/history';
import type { Reading, Side, TicketMode } from './model';
import { DEFAULT_SIZE, PRESET_SIZES, depthOf, fromQuote, fromTable, markerEvents, parseAmount, quoteKey, serviceAnswered, tablePoints } from './model';
import { useDailyTrades, useOrderflowHistory, usePairs, usePools, usePriceChanges, usePriceHistory, useQuote, useSizeTable, useTrades, useVolume } from './data';
import { Ticket } from './Ticket';
import { SizeBlock } from './SizeBlock';
import { Pools } from './Pools';
import { Head } from './Head';
import { Tape } from './Tape';
import { Buyers } from './Buyers';
import { routeById } from '../../../../shared/routes';

const TRADE = routeById('trade')!;

const EVENTS = markerEvents(PRICE_MOVES, (p) => fmtPctSigned(p, 1));

/** What the second chart is, in the words the button, the heading and the stamp use. */
const FLOW_WHAT = 'What was bought and sold';
/** The stamp of the record of what was bought and sold when the server does not serve it. */
const FLOW_UNSERVED: Stamp = {
  source: 'D1 flow index',
  plain: 'Flow index',
  at: null,
  status: 'missing',
  note: 'This server does not keep an hour-by-hour record of what was bought and sold yet, so there is no chart to draw.',
};

const skeleton = (label: string) => (
  // role="status": an aria-label on a plain div is not allowed (axe aria-prohibited-attr)
  <div className="tk-chartskel" role="status" aria-busy="true" aria-label={label}>
    <SkeletonBlock height={56} width="70%" />
    <SkeletonBlock height={20} width="50%" />
    <SkeletonBlock height={28} width={220} />
    <SkeletonBlock height={208} className="tk-chartskel__plot" />
  </div>
);

/** The sentence a chart prints when its "All" ran into the cap: the oldest readings are not drawn. */
const CapNote = ({ what }: { what: string }) => (
  <p className="cap tk-cap">
    “All” reaches back {fmtCount(HISTORY_ALL_DAYS)} days, the most this site asks for at once, so {what} older than that are not drawn.
  </p>
);

export default function TradeScreen({ route }: ScreenProps) {
  const { overview, liveFlows } = useOverview();
  const overviewFailed = useOverviewFailed();
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
  const [range, setRange] = useState<ChartRange>('30d');
  const [flowRange, setFlowRange] = useState<ChartRange>('30d');
  const [showFlow, setShowFlow] = useState(false);
  const table = useSizeTable(live);
  const pools = usePools(live);
  const history = usePriceHistory(at, range);
  const flow = useOrderflowHistory(at, flowRange, showFlow);
  const { result } = useQuote(live, side, amount, immediate);
  // the screener basics (screener-plan 2.1 to 2.5): each panel reads its own route and says "—" with the reason when it does not answer
  const changes = usePriceChanges(at);
  const volume = useVolume(at);
  const pairs = usePairs(live);
  const [maker, setMaker] = useState<string | null>(null);
  const trades = useTrades(at, maker);
  const daily = useDailyTrades(at);

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
    // the series answers carry their own stamps; the older read takes the overview's
    const sp = history.data?.prov ?? {};
    const p = {
      executed: sp.executed ?? overview?.price.swap1h.prov ?? null,
      quoted: sp.quoted ?? overview?.price.usd.prov ?? null,
      pool: sp.pool ? { ...sp.pool, plain: 'Osmosis app data' } : null,
      bars: sp.bars ? { ...sp.bars, plain: 'Executed swaps' } : null,
    };
    return kept ? ageOutStamps(p, `The latest refresh of the price history did not answer, so the chart is the history fetched at ${fmtUtcClock(history.fetchedAt)}.`) : p;
  }, [overview, kept, history.fetchedAt, history.data]);
  // "All" ran into the cap: the series starts where the request did, not where the record does
  const priceCapped = range === 'all' && history.data != null && historyCapReached(Math.min(history.data.executed[0]?.t ?? Infinity, history.data.quoted[0]?.t ?? Infinity, history.data.pool?.[0]?.t ?? Infinity), at ?? history.fetchedAt ?? clock);

  // the same for the record of what was bought and sold
  const flowKept = flow.data != null && flow.failedAt != null;
  const flowOldSentence = `The latest refresh of the record of what was bought and sold did not answer, so this is the record fetched at ${fmtUtcClock(flow.fetchedAt)}.`;
  const flowProv = useMemo<Stamp | null>(() => {
    // a record without its stamp falls back to the chart's own "its age is not known" stamp, never "time unknown · fresh"
    if (!flow.data?.prov) return null;
    const p: Stamp = { ...flow.data.prov, plain: 'Flow index' };
    return flowKept ? ageOutStamps(p, flowOldSentence) : p;
  }, [flow.data, flowKept, flowOldSentence]);
  const flowCapped = flowRange === 'all' && flow.data != null && historyCapReached(flow.data.buckets[0]?.ts, at ?? flow.data.asOf);

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
          <Head overview={overview} overviewFailed={overviewFailed} depth={depth} changes={changes} volume={volume} rewound={rewound} />
          <div className="tk-chart">
            {/* the chart's stamps come with the overview: it waits for them (or for the overview to fail) so no figure shows unsourced */}
            {history.data && (overview || overviewFailed) ? (
              <ProvScope old={kept} oldSentence={kept ? <>The latest refresh of the price history did not answer, so this is the history fetched at {fmtUtcClock(history.fetchedAt)}, and it is shown dimmed.</> : null}>
                <PriceChart
                  headingId="h-chart"
                  series={{ executed: history.data.executed, quoted: history.data.quoted, pool: history.data.pool ?? undefined }}
                  bars={history.data.bars}
                  barsStepMs={history.data.barsStepMs}
                  barsMissing={history.data.barsMissing}
                  band={history.data.band}
                  flatHours={history.data.flatHours}
                  poolStepMs={history.data.poolStepMs}
                  poolMissing={history.data.poolMissing}
                  starts={history.data.starts}
                  executedStart={history.data.executedStart}
                  events={EVENTS}
                  range={range}
                  onRange={setRange}
                  end={at ?? clock}
                  cursorAt={at}
                  prov={chartProv}
                  bucketMs={history.data.executedBucketMs}
                />
                {priceCapped ? <CapNote what="trades" /> : null}
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
              skeleton('Fetching the price history')
            )}

            {/* The second chart, opened on request: nothing is fetched for it until then. */}
            <div className="tk-more">
              <Button size="sm" aria-expanded={showFlow} onClick={() => setShowFlow((v) => !v)}>
                {showFlow ? 'Hide what was bought and sold' : 'Show what was bought and sold'}
              </Button>
            </div>
            {showFlow ? (
              <div className="tk-flow">
                {flow.data ? (
                  <ProvScope old={flowKept} oldSentence={flowKept ? <>{flowOldSentence} It is shown dimmed.</> : null}>
                    <OrderflowChart
                      headingId="h-flow"
                      data={flow.data}
                      liveFlows={liveFlows}
                      range={flowRange}
                      onRange={setFlowRange}
                      end={at ?? clock}
                      cursorAt={at}
                      prov={flowProv}
                    />
                    {flowCapped ? <CapNote what="moves" /> : null}
                  </ProvScope>
                ) : flow.unserved ? (
                  // the server has no such record (production before the deploy that adds it): missing, with the reason, not a fault
                  <section className="tk-chartmiss" aria-labelledby="h-flow">
                    <h2 id="h-flow" className="h2">{FLOW_WHAT}</h2>
                    <p className="tk-miss">
                      <Num v={null} prov={FLOW_UNSERVED} stamp="dot" label={FLOW_WHAT} as="b" />
                    </p>
                    <p className="cap">The price chart, the quote and the size table do not depend on it.</p>
                  </section>
                ) : flow.error ? (
                  <section className="tk-chartfail" aria-labelledby="h-flow">
                    <h2 id="h-flow" className="h2">The record of what was bought and sold did not load</h2>
                    <Notice tone="warning" title={flow.error} action={<Button size="sm" onClick={flow.retry}>Try again</Button>}>
                      The chart is not shown until it answers. The price chart, the quote and the size table do not depend on it.
                    </Notice>
                  </section>
                ) : (
                  skeleton('Fetching the record of what was bought and sold')
                )}
              </div>
            ) : null}
          </div>
          <Buyers volume={volume} daily={daily} overview={overview} depth={depth} rewound={rewound} />
          <SizeBlock rewound={rewound} table={table} amount={amount} side={side} onPick={pick} />
        </div>
      </div>
      <Pools rewound={rewound} pools={pools} pairs={live ? pairs : null} depth={depth} overview={overview} />
      <Tape load={trades} rewound={rewound} maker={maker} onMaker={setMaker} />
    </div>
  );
}
