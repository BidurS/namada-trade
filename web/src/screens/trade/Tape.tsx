// "The latest trades" (S2, screener-plan 2.5): the trades tape, full width under the pools, black. The newest NAM
// swaps on Osmosis (bot round trips left out), with the trades the live stream brings in on top, and runs of one
// address's trades on one side folded into one row ("12 buys of about 351 NAM by the same address"). Each maker
// opens the Address sheet; "Only this address's trades" filters the tape to one maker; the whole record is one
// link away on the Activity tab. Under Rewind the tape is as of that time and nothing streams in.
//
// On a server that does not serve the tape yet, the rows are the live stream's trades alone (the newest moves
// fetched at page load and every one since), and the panel says so: the full record is "—" with NOT_SERVED.
import { useEffect, useMemo, useRef } from 'react';
import type { Flow } from '../../../../shared/types';
import { NOT_SERVED } from '../../../../shared/types';
import { hrefFor, streamStamp, useOverview } from '../../app/index';
import { ArrowLink, Button, EmptyState, Notice, Num, ProvScope, Skeleton, SourceLine, Tag, useUiNow, type Stamp } from '../../ui/index';
import type { ScopeItem } from '../../ui/index';
import { TradesTape } from '../../ui/TradesTape';
import { NBSP, fmtAddr, fmtCount, fmtNamRule } from '../../lib/format';
import type { HistoryLoad } from './data';
import type { TradesResponse } from '../../../../shared/types';
import { durationWords, foldRuleOf, tapeOf } from './series';

/** The most rows the tape shows (screener-plan 4.2: 20 rows, grouped). */
export const TAPE_ROWS = 20;
/** Where the whole record of trades lives (the Activity tab, trades only, bots left out). */
export const ALL_TRADES_HREF = '/activity?what=dex&bots=off';

export interface TapeProps {
  load: HistoryLoad<TradesResponse>;
  rewound: boolean;
  maker: string | null;
  onMaker: (m: string | null) => void;
}

export function Tape({ load, rewound, maker, onMaker }: TapeProps) {
  const now = useUiNow();
  const { liveFlows, stream, streamedIds } = useOverview();
  const page = load.data;
  const flows: Flow[] = rewound ? [] : liveFlows;
  const fold = foldRuleOf(page);
  const tape = useMemo(() => tapeOf(page, flows, { ...foldRuleOf(page), maker, max: TAPE_ROWS }), [page, flows, maker]);
  const fresh = useMemo(() => new Set(tape.groups.filter((g) => g.live && g.rows.some((r) => streamedIds.has(r.id))).map((g) => g.key)), [tape.groups, streamedIds]);

  const pageStamp: Stamp | null = page ? { ...page.prov, plain: 'Flow index' } : null;
  const liveStamp: Stamp | null = rewound ? null : streamStamp(stream, now);
  const unserved: Stamp | null = !page && !load.loading ? { source: 'D1 flow index (trades tape)', plain: 'Flow index', at: null, status: 'missing', note: load.unserved ? NOT_SERVED : load.error ?? NOT_SERVED } : null;
  const scope: ScopeItem[] = [
    ...(pageStamp ? [{ label: 'Recorded trades', p: pageStamp }] : unserved ? [{ label: 'Recorded trades', p: unserved }] : []),
    ...(liveStamp && (tape.streamed > 0 || !page) ? [{ label: 'Trades from the live stream', p: liveStamp }] : []),
  ];
  const rule = page?.patternRule;
  const anyPattern = tape.groups.some((g) => g.pattern);

  // "Only this address's trades" and "Show every address" each unmount the button just pressed (the row is filtered,
  // the line goes): focus moves to what took its place, the line's own button or the tape's heading, never to the
  // page's start. Only when focus was in the tape or lost, so a maker set from elsewhere never takes it.
  const secRef = useRef<HTMLElement>(null);
  // the maker last acted on (not a first-render flag: a development double run of the effect would read as a change)
  const lastMaker = useRef(maker);
  useEffect(() => {
    if (lastMaker.current === maker) return;
    lastMaker.current = maker;
    const sec = secRef.current;
    const active = document.activeElement;
    if (!sec || !(active == null || active === document.body || sec.contains(active))) return;
    const target = maker ? sec.querySelector<HTMLElement>('.tk-maker button') : sec.querySelector<HTMLElement>('#h-tape');
    target?.focus();
  }, [maker]);

  let body;
  if (load.loading && !tape.groups.length) {
    body = <Skeleton rows={6} heights={[72]} label="the latest trades" />;
  } else if (!tape.groups.length) {
    body = (
      <EmptyState title={page ? (maker ? 'No trade by this address on record.' : 'No trade on record yet.') : 'No trade has streamed in since this page opened.'}>
        {page
          ? maker
            ? 'The tape lists this address’s swaps of NAM on Osmosis, newest first.'
            : 'The tape lists swaps of NAM on Osmosis, newest first.'
          : rewound
            ? 'The tape as it was then is not served by this server yet, and nothing streams while rewound.'
            : 'The full record of trades is not served by this server yet, so the tape shows only the trades the live stream brings.'}
      </EmptyState>
    );
  } else {
    body = (
      <TradesTape
        groups={tape.groups}
        now={now}
        label={maker ? `Trades by ${fmtAddr(maker)}, newest first` : 'The latest NAM trades on Osmosis, newest first'}
        freshKeys={fresh}
        onMaker={(m) => onMaker(m)}
        maker={maker}
      />
    );
  }

  return (
    <div className="band ground-ink tk-tape">
      <div className="wrap">
        <section className="tk-sec" aria-labelledby="h-tape" ref={secRef}>
          <h2 id="h-tape" className="h2" tabIndex={-1}>The latest trades</h2>
          <p className="sub tk-body">
            Swaps of NAM on Osmosis, newest first, with bot round trips left out. One address’s trades on the same side, each under{' '}
            {fmtNamRule(fold.underNam)}{NBSP}NAM, within {durationWords(fold.foldMs)} of the next and through a pool they all went
            through, are folded into one row; a bigger trade always has a row of its own.
          </p>
          {maker ? (
            <p className="tk-maker">
              <Tag cat={<>Only trades by <span className="mono">{fmtAddr(maker)}</span></>} />
              <Button size="sm" onClick={() => onMaker(null)}>Show every address</Button>
            </p>
          ) : null}
          <ProvScope className="tk-scope" old={!!pageStamp && pageStamp.status === 'stale'} oldSentence={pageStamp?.note ? <>The record of trades reads old: {pageStamp.note}</> : null}>
            {!page && !load.loading ? (
              <p className="cap tk-tape__note">
                <Num v={null} prov={unserved} label="The record of trades" />
                {rewound ? null : <> Shown instead: the newest moves fetched when the site opened and every trade the live stream has brought since.</>}
              </p>
            ) : null}
            {!page && load.error && !load.unserved ? (
              <p className="tk-retry">
                <Button size="sm" onClick={load.retry}>Try again</Button>
              </p>
            ) : null}
            {load.error && !load.unserved && page ? (
              <Notice tone="warning" title="The latest refresh of the trades did not answer." action={<Button size="sm" onClick={load.retry}>Try again</Button>}>
                The rows are the ones fetched before it, and the live stream still adds new trades.
              </Notice>
            ) : null}
            {body}
            {rule && anyPattern ? (
              <p className="cap tk-rule">
                <Tag cat="Repeated small buys" /> marks an address with at least <span data-num="">{fmtCount(rule.minBuys)}</span> buys of under{' '}
                <span data-num="">{fmtNamRule(rule.underNam)}</span>{NBSP}NAM each within {durationWords(rule.windowMs)}. It describes a pattern in the record, not why the trades were made.
              </p>
            ) : null}
            <p className="tk-all">
              <ArrowLink href={hrefFor(ALL_TRADES_HREF)}>All trades on the Activity tab</ArrowLink>
            </p>
            {scope.length ? <SourceLine items={scope} label="Where the trades come from" /> : null}
          </ProvScope>
        </section>
      </div>
    </div>
  );
}

export default Tape;
