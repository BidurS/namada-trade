// Shielded (/shielded), S4: "How much NAM can't be seen?" (system.md 9.4; decision D5).
//
// Yellow field: the dateline, the H1, the page's first plain paragraph (shared/copy.ts), the
// share hero (48 px, ProvChip), the shielded bar (shielded, everything else, on Osmosis) with
// its key and one SourceLine. Beside it on desktop, below it on phones: the black chart panel
// with a view switch. "Total in the set" is the series chart in --shielded with a takeaway
// title; "Moved in and out" is FlowChart below: NAM into and out of the set in 6-hour slices
// (bars up and down over one NAM axis, flow.ts), the part of each slice's moves out that the
// server paired with a move in of the same amount within 24 hours marked, a fixed readout for
// press-and-drag or the arrow keys, a four-figure strip, a key, a hidden text summary and one
// SourceLine. Then, on black: Inside the shielded set (four facts and one SourceLine, then the
// share of the week's moves that were not in such a pair, with its own stamp), Largest moves
// out in 30 days (rows; a row whose move the server paired with a move in says so, with the
// server's confidence in words), and How to read this.
//
// Data: fetchBlindSpot(at) and the shell's overview, both rewound by the shell's fetch wrapper
// under ?at=. Nothing here is live-only. Live, the figures are refreshed every 2 minutes while the
// tab is visible and when it becomes visible again (supply/parts useLiveLoad); a refresh that fails
// keeps them, marked old with the reason. A server that does not send the slices or the pairs
// (one before 2026-10-20) leaves those figures as "—" with the reason, never a stand-in.
import { useMemo, useState } from 'react';
import type { BlindSpot, Flow, MaspPassthroughLink, MaspPulseBucket, Overview } from '../../../../shared/types';
import { BODY } from '../../../../shared/copy';
import type { ScreenProps } from '../../app/index';
import { useOverview, useReplay } from '../../app/index';
import { fetchBlindSpot } from '../../api';
import {
  Derived, EmptyState, Fact, HeroNumber, Notice, Num, ProvChip, ProvDot, ProvScope, Segmented, Skeleton, SkeletonBlock, SourceLine, SupplyBar, Tag, Term,
  derive, namShort, namTick, niceTicks, useUiNow, type FactItem, type ScopeItem, type Stamp,
} from '../../ui';
import { MINUS, NBSP, fmtAge, fmtAgo, fmtAddr, fmtCount, fmtDateline, fmtDayClock, fmtDayMonth, fmtNamRule, fmtNamSigned, fmtPctRule, fmtUsdRule, fmtUtcClock, fmtUtcLong } from '../../lib/format';
import { ageOutStamps, plainSource } from '../../lib/prov';
import { AddrName, RecordLink, useShowAll } from '../../ui';
import { isOld, oldRowsSentence, refreshFailedNote, refreshFailedSentence, useLiveLoad } from '../supply/parts';
import { SeriesChart, type SeriesRange } from '../../ui';
import { lin, nearestIndex } from '../../ui/chartMath';
import { useSize } from '../../ui/useSize';
import { FLOW_WINDOWS, FLOW_WINDOW_DEFAULT, PAIR, PAIR_WORDS, SERIES_DAYS, SLICE, flowSums, flowTakeaway, flowWindow, pairFor, slicesIn } from './flow';

const DAY = 86_400_000;
const RANGES: SeriesRange[] = [
  { value: '7d', label: '7d', ms: 7 * DAY },
  { value: '30d', label: '30d', ms: 30 * DAY },
  { value: '90d', label: '90d', ms: 90 * DAY },
  { value: '1y', label: '1y', ms: 365 * DAY },
  { value: 'all', label: 'All', ms: null },
];

/** One stamp for a figure made of several readings; when they share a source, say that source. */
function joinStamp(inputs: Stamp[], label: string): Stamp {
  const d = derive(inputs, label);
  const names = Array.from(new Set(inputs.map((p) => plainSource(p))));
  return names.length === 1 ? { ...d, plain: names[0] } : d;
}

/** The flow index's stamp for a figure this server did not send: "—" with the reason, never a stand-in. */
const notSent = (cov: Stamp, what: string, rewound: boolean): Stamp => ({
  ...cov,
  at: null,
  status: 'missing',
  note: rewound ? `The server did not send ${what} for that time.` : `This server does not send ${what} yet.`,
});

export default function ShieldedScreen({ route }: ScreenProps) {
  const { overview: o } = useOverview();
  const { at, rewound } = useReplay();
  const now = useUiNow();
  const [range, setRange] = useState('all');
  const [chartTab, setChartTab] = useState<'total' | 'flow'>('total');
  const [flowWin, setFlowWin] = useState(FLOW_WINDOW_DEFAULT);
  const load = useLiveLoad<BlindSpot>(at, 'blindspot', () => fetchBlindSpot(at));
  // after a failed refresh the figures stay, every stamp marked old with the reason
  const data = useMemo(
    () => (load.data && load.refreshFailedAt ? ageOutStamps(load.data, refreshFailedNote(load.fetchedAt)) : load.data),
    [load.data, load.refreshFailedAt, load.fetchedAt],
  );
  const err = load.failed ? 'The shielded figures did not load: the server did not answer.' : null;

  const lead = BODY.shielded.paras;
  const asOf = at ?? data?.asOf ?? o?.generatedAt ?? null;
  const sp = data?.shielded.prov ?? null;
  const totalStamp: Stamp | null = o?.supply.prov ?? null;
  const shareStamp = sp ? joinStamp(totalStamp ? [sp, totalStamp] : [sp], 'shielded NAM ÷ all NAM') : null;
  const visibleStamp: Stamp | null = shareStamp ? { ...shareStamp, derivedFrom: '100% − shielded share' } : null;
  const shielded = data?.shielded.value ?? null;
  const total = data?.total ?? o?.supply.total ?? null;
  const osmosis = o?.supply.osmosis ?? null;
  const rest = shielded != null && total != null ? total - shielded - (osmosis ?? 0) : null;
  const restName = osmosis != null ? 'Everything else' : 'Everything else, Osmosis included';
  const restStamp: Stamp | null = sp ? derive([sp, ...(totalStamp ? [totalStamp] : []), ...(o && osmosis != null ? [o.supply.osmosisProv] : [])], 'all NAM − shielded − on Osmosis') : null;

  // ---------------- the yellow field ----------------
  const bandScope: ScopeItem[] = [
    ...(sp ? [{ label: 'NAM in the shielded set', p: sp }] : []),
    ...(totalStamp ? [{ label: 'All NAM', p: totalStamp }] : []),
    ...(o ? [{ label: 'NAM held on Osmosis (wallets and pools)', p: o.supply.osmosisProv }] : []),
  ];

  const band = (
    <section className="ground-accent shd-band" aria-labelledby="shielded-h1" data-decision="D5">
      <div className="shd-band__in">
        <p className="eyebrow">Shielded{asOf != null ? <> · {fmtDateline(asOf)}</> : null}</p>
        <h1 id="shielded-h1" className="h1">{route?.h1}</h1>
        <p className="sub">{lead[0]}</p>
        <div className="shd-hero">
          {data ? (
            <HeroNumber
              size="48"
              label={<>Share of all NAM in the <Term id="shielded-set">shielded set</Term></>}
              chip={<ProvChip p={shareStamp} label="Shielded share of all NAM" />}
              value={<Num v={data.sharePct} prov={shareStamp} fmt={(n) => fmtPctRule(n, 1)} showAge={false} />}
              sub={data.sharePct != null ? <>of all NAM sits in the shielded set. The total is public; the owners are not.</> : undefined}
            />
          ) : err ? (
            <Notice tone="warning" title="No figures right now." live>{err}</Notice>
          ) : (
            <div aria-busy="true">
              <div className="hero-n__top"><p className="hero-n__label">Share of all NAM in the shielded set</p><span className="skel__b skel__chip" /></div>
              <SkeletonBlock height={48} width="40%" className="shd-gap" />
              <SkeletonBlock height={44} width="90%" className="shd-gap" />
            </div>
          )}
        </div>
        {load.refreshFailedAt && data ? (
          <p className="scope__old shd-refresh">
            <i className="dot" data-status="old" aria-hidden="true" />
            <span>{refreshFailedSentence(load.fetchedAt, now)}</span>
          </p>
        ) : null}
        <div className="shd-bar" data-prov-scope="">
          {data && rest != null ? (
            <>
              <SupplyBar
                legend={false}
                segments={[
                  { key: 'shielded', name: 'Shielded', nam: shielded },
                  { key: 'rest', name: restName, short: 'Everything else', nam: rest },
                  ...(osmosis != null ? [{ key: 'osmosis' as const, name: 'On Osmosis', nam: osmosis }] : []),
                ]}
              />
              <ul className="shd-key">
                <li><i className="sg sg--shielded shd-key__sw" aria-hidden="true" /><span className="shd-key__n">Shielded</span><span className="shd-key__v"><Num v={shielded} prov={sp} fmt={fmtNamRule} unit="NAM" showAge={false} /></span></li>
                <li><i className="sg sg--osmosis shd-key__sw" aria-hidden="true" /><span className="shd-key__n">On Osmosis, wallets and pools</span><span className="shd-key__v">{o ? <Num v={osmosis} prov={o.supply.osmosisProv} fmt={fmtNamRule} unit="NAM" showAge={false} /> : '—'}</span></li>
                <li><i className="sg sg--rest shd-key__sw" aria-hidden="true" /><span className="shd-key__n">{restName}</span><span className="shd-key__v"><Num v={rest} prov={restStamp} fmt={fmtNamRule} unit="NAM" showAge={false} /></span></li>
                <li className="shd-key__all"><span /><span className="shd-key__n">All NAM</span><span className="shd-key__v"><Num v={total} prov={totalStamp ?? sp} fmt={fmtNamRule} unit="NAM" showAge={false} /></span></li>
              </ul>
            </>
          ) : data ? (
            <p className="shd-bar__none">
              {rewound
                ? 'How much NAM was shielded, on Osmosis and in all was not recorded at that time, so the split cannot be drawn. The chart has the daily history of the shielded set.'
                : 'The supply split has no data right now, so it cannot be drawn.'}
            </p>
          ) : err ? null : (
            <div className="shd-bar__skel" aria-hidden="true">
              <SkeletonBlock height={108} />
              <SkeletonBlock height={160} />
            </div>
          )}
          {bandScope.length ? <SourceLine items={bandScope} label="Where the shielded share comes from" /> : <div className="shd-src-slot" />}
        </div>
      </div>
      <div className="ruler shd-band__ruler" aria-hidden="true" />
    </section>
  );

  // ---------------- the chart ----------------
  const trend = data?.trend ?? [];
  const firstDaily = trend[0]?.ts ?? null;
  // where the readings switch from one a day to the recent, more frequent ones (from the data itself)
  const switchAt = (() => {
    for (let i = 1; i < trend.length; i++) if (trend[i].ts - trend[i - 1].ts < 20 * 3_600_000) return trend[i - 1].ts;
    return null;
  })();
  const chart = (
    <section className="ground-ink shd-chart" aria-label="Shielded NAM over time" data-decision="D5">
      <div className="shd-chart__in">
        {data ? (
          <div className="shd-chart__mode">
            <Segmented
              label="Shielded chart view"
              value={chartTab}
              onChange={setChartTab}
              options={[
                { value: 'total', label: 'Total in the set' },
                { value: 'flow', label: 'Moved in and out' },
              ]}
            />
          </div>
        ) : null}
        {data && chartTab === 'flow' ? (
          <FlowChart
            key={data.pulseSeries ? 'slices' : 'none'}
            buckets={data.pulseSeries ?? null}
            end={data.asOf}
            cov={data.coverage}
            window={flowWin}
            onWindow={setFlowWin}
            rewound={rewound}
          />
        ) : data && trend.length ? (
          <SeriesChart
            points={trend.map((p) => ({ t: p.ts, v: p.value }))}
            end={data.asOf}
            ranges={RANGES}
            range={range}
            onRange={setRange}
            tone="shielded"
            what="Shielded NAM"
            headingId="shd-chart-h"
            unit={
              <>
                NAM in the shielded set: one reading a day{firstDaily != null ? <> from {fmtUtcLong(firstDaily).replace(/, \d\d:\d\d UTC$/, '')}</> : null}
                {switchAt != null ? <>, then several a day since {fmtUtcLong(switchAt).replace(/, \d\d:\d\d UTC$/, '')}</> : null}. The daily history was rebuilt from the chain&apos;s own recorded balances.
              </>
            }
            prov={sp}
            provLabel="Shielded NAM readings"
          />
        ) : data ? (
          <EmptyState title="No shielded-set readings recorded yet.">The chart appears once there are two readings.</EmptyState>
        ) : err ? null : (
          <div className="shd-chart__skel" aria-busy="true" aria-label="Fetching the shielded history">
            {/* the final heights of the chart's parts, so nothing moves when it arrives */}
            <span className="skel__b skel__block shd-sk shd-sk--mode" aria-hidden="true" />
            <span className="skel__b skel__block shd-sk shd-sk--top" aria-hidden="true" />
            <span className="skel__b skel__block shd-sk shd-sk--read" aria-hidden="true" />
            <span className="skel__b skel__block shd-sk shd-chart__box" aria-hidden="true" />
            <span className="skel__b skel__block shd-sk shd-sk--stats" aria-hidden="true" />
          </div>
        )}
      </div>
    </section>
  );

  return (
    <>
      <div className="shd-split">
        {band}
        {chart}
      </div>
      <div className="band ground-ink ipg-body">
        <div className="wrap">
          {data ? (
            <>
              <Inside data={data} overview={o} now={now} rewound={rewound} />
              <MovesOut data={data} overview={o} now={now} />
            </>
          ) : err ? (
            <section className="ipg-sec" aria-label="Shielded figures">
              <Notice tone="warning" title="The shielded lists did not load.">{err}</Notice>
            </section>
          ) : (
            <>
              <section className="ipg-sec" aria-label="Inside the shielded set">
                <h2 className="h2">Inside the shielded set</h2>
                <SkeletonBlock height={190} />
              </section>
              <section className="ipg-sec" aria-label="Largest moves out">
                <h2 className="h2">Largest moves out, last 30 days</h2>
                <SkeletonBlock height={52} />
                <Skeleton rows={6} heights={[88]} label="the largest moves out" />
              </section>
            </>
          )}
          <section className="ipg-sec ipg-about" aria-labelledby="shd-about-h">
            <h2 id="shd-about-h" className="h2">How to read this</h2>
            <p className="ipg-prose">{lead[1]}</p>
            {data && data.sharePct != null ? (
              <p className="ipg-prose" data-prov-group="">
                Any figure about who holds what describes only the visible{' '}
                <Num v={100 - data.sharePct} prov={visibleStamp} fmt={(n) => fmtPctRule(n, 1)} showAge={false} />{' '}
                of NAM. A large move out of the shielded set to a new address is the only public sign that a hidden holder is moving.{' '}
                <ProvDot p={visibleStamp} label="Visible share of NAM" />
              </p>
            ) : null}
          </section>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- inside the shielded set

function Inside({ data, overview: o, now, rewound }: { data: BlindSpot; overview: Overview | null; now: number; rewound: boolean }) {
  const cov = data.coverage;
  const sp = data.shielded.prov;
  const total = o?.supply.prov ?? null;
  const shareStamp = joinStamp(total ? [sp, total] : [sp], 'shielded NAM ÷ all NAM');
  const osmoStamp = o ? derive([o.supply.osmosisProv, o.supply.prov], 'NAM on Osmosis ÷ all NAM') : null;
  const net24 = data.shields24h - data.unshields24h;
  const net7 = data.shields7d - data.unshields7d;
  // the part of each side that moved straight from or to Osmosis, when the server sends it (a server before 2026-10-18 does not)
  const direct = (n: number | undefined, of: number, way: 'from' | 'to') =>
    n ? (n >= of - 0.005 ? <> (all of it straight {way} Osmosis)</> : <> (<span data-num="">{fmtNamRule(n)}</span> straight {way} Osmosis)</>) : null;
  const inOut = (i: number, out: number, bi?: number, bo?: number) => (
    <>in <span data-num="">{fmtNamRule(i)}</span>{direct(bi, i, 'from')} · out <span data-num="">{fmtNamRule(out)}</span>{direct(bo, out, 'to')}</>
  );
  // the net said in words, its size as the figure (never a sign the words then repeat)
  const netWords = (n: number, span: string) => (n >= 0 ? `more went in than came out, ${span}` : `more came out than went in, ${span}`);
  const bridged7 = data.bridgeIn7d != null && data.bridgeOut7d != null ? data.bridgeIn7d + data.bridgeOut7d : data.ibcShielded7d;
  const items: FactItem[] = [
    { n: <Num v={data.sharePct} prov={shareStamp} fmt={(n) => fmtPctRule(n, 2)} showAge={false} />, label: 'share of all NAM', scope: { label: 'Share of all NAM in the shielded set', p: shareStamp } },
    {
      n: o ? <Derived inputs={[{ value: o.supply.osmosis, prov: o.supply.osmosisProv }, { value: o.supply.total, prov: o.supply.prov }]} label="NAM on Osmosis ÷ all NAM" name="Share of all NAM on Osmosis" compute={(a, b) => (a / b) * 100} fmt={(n) => fmtPctRule(n, 2)} showAge={false} /> : <span data-num="" data-status="none">—</span>,
      label: 'on Osmosis, for comparison',
      scope: osmoStamp ? { label: 'Share of all NAM on Osmosis', p: osmoStamp } : undefined,
    },
    { n: <Num v={Math.abs(net24)} prov={cov} fmt={fmtNamRule} unit="NAM" showAge={false} />, label: <>{netWords(net24, `24${NBSP}h`)}<span className="shd-io">{inOut(data.shields24h, data.unshields24h, data.bridgeIn24h, data.bridgeOut24h)}</span></>, scope: { label: 'Moved in and out, 24 hours', p: cov } },
    { n: <Num v={Math.abs(net7)} prov={cov} fmt={fmtNamRule} unit="NAM" showAge={false} />, label: <>{netWords(net7, '7 days')}<span className="shd-io">{inOut(data.shields7d, data.unshields7d, data.bridgeIn7d, data.bridgeOut7d)}</span></>, scope: { label: 'Moved in and out, 7 days', p: cov } },
  ];
  // The share of the week's moves that were not in an in-and-out pair: the server's figure, computed from the
  // flow index; its own stamp, since the strip's SourceLine does not list it. "—" with the reason when not sent.
  const pairs = data.passthroughs7d;
  const stayed = data.stickySharePct7d;
  const stayedStamp: Stamp = stayed != null
    ? { ...cov, derivedFrom: 'NAM moved in or out in 7 days, less the moves out paired with a move in of the same amount within 24 hours' }
    : notSent(cov, 'this figure', rewound);
  return (
    <ProvScope as="section" className="ipg-sec" aria-labelledby="shd-in-h" data-decision="D5">
      <div className="ipg-sec__head">
        <h2 id="shd-in-h" className="h2">Inside the shielded set</h2>
        <p className="lead ipg-lead">
          <Num v={data.shielded.value} prov={sp} fmt={fmtNamRule} unit="NAM" showAge={false} /> sit in the shielded set. Moving NAM in or out is public; what happens inside is not.
          {' '}<Num v={bridged7} prov={cov} fmt={fmtNamRule} unit="NAM" showAge={false} /> moved straight between Osmosis and the shielded set in 7 days
          {data.lastBridgeAt != null ? <>, the last {fmtAgo(data.lastBridgeAt, now)}</> : null}.
        </p>
      </div>
      <Fact items={items} sourceLabel="Where the shielded figures come from" className="shd-facts" />
      <p className="ipg-prose shd-pairs" data-prov-group="">
        Some NAM goes in and <Term id="in-and-out-pair">comes out again in the same amount</Term>{` within ${PAIR.words}. Of what moved in or out in the last 7 days, the share that did not do that: `}
        <Num v={stayed ?? null} prov={stayedStamp} fmt={(n) => fmtPctRule(n, 1)} showAge={false} />
        {stayed != null && pairs ? (
          pairs.length === 0 ? <> (no such pair)</> : <> (<Num v={pairs.length} fmt={fmtCount} /> such {pairs.length === 1 ? 'pair' : 'pairs'})</>
        ) : null}
        {/* the missing reason ends with its own full stop */}
        {stayed != null ? '.' : null}{' '}
        <ProvDot p={stayedStamp} label="Share of the week's moves not paired with a move in" />
      </p>
    </ProvScope>
  );
}

// ---------------------------------------------------------------- largest moves out

const FIRST = 8;

function MovesOut({ data, overview: o, now }: { data: BlindSpot; overview: Overview | null; now: number }) {
  const { rewound } = useReplay();
  const priceWords = rewound ? 'then' : 'today';
  // moves out of the pool are Namada records: the Namada flow index's stamp when the server stamps each chain
  const cov = data.coverageByChain?.namada ?? data.coverage;
  const price = o?.price.usd ?? null;
  const valueStamp = price ? derive([cov, price.prov], 'amount × NAM price') : null;
  const [rows, more] = useShowAll(data.unshields, FIRST);
  const old = isOld(cov);
  const scope: ScopeItem[] = [
    { label: 'Moves out of the shielded set', p: cov },
    ...(valueStamp ? [{ label: rewound ? 'Dollar value at the price then' : "Dollar value at today's price", p: valueStamp }] : []),
    ...(data.passthroughs7d ? [{ label: `Moves out paired with a move in of the same amount within ${PAIR.words}`, p: data.coverage }] : []),
  ];
  return (
    <ProvScope as="section" className="ipg-sec" aria-labelledby="shd-out-h" data-decision="D5">
      <div className="ipg-sec__head">
        <h2 id="shd-out-h" className="h2">Largest moves out, last 30 days</h2>
        <p className="lead ipg-lead">The biggest single moves out of the shielded set to personal addresses, largest first. Moves to protocol accounts, such as staking, are left out.</p>
      </div>
      {data.unshields.length === 0 ? (
        <EmptyState title="Nothing left the shielded set for a personal address in 30 days.">Every such move would be listed here with its size, its destination and its record.</EmptyState>
      ) : (
        <div className={`xlist${old ? ' is-old' : ''}`}>
          {old ? (
            <p className="scope__old">
              <i className="dot" data-status="old" aria-hidden="true" />
              <span>{oldRowsSentence(cov, now)}</span>
            </p>
          ) : null}
          <div className="mor" role="table" aria-label="Largest moves out of the shielded set, last 30 days">
            <div className="mor__head" role="row">
              <span role="columnheader">When</span>
              <span role="columnheader">What</span>
              <span role="columnheader" className="r">NAM</span>
              <span role="columnheader" className="r">{rewound ? 'Worth then' : 'Worth today'}</span>
              <span role="columnheader">To</span>
              <span role="columnheader" className="r">Record</span>
            </div>
            {rows.map((f) => (
              <MoveOutRow key={f.id} f={f} now={now} price={price?.value ?? null} priceWords={priceWords} pair={pairFor(data.passthroughs7d, f.to, f.ts)} />
            ))}
          </div>
          {more}
        </div>
      )}
      <SourceLine items={scope} label="Where the moves come from" />
    </ProvScope>
  );
}

function MoveOutRow({ f, now, price, priceWords, pair }: { f: Flow; now: number; price: number | null; priceWords: string; pair?: MaspPassthroughLink }) {
  const name = f.toLabelPlain ?? null;
  const usd = price != null ? <Num v={f.amount * price} fmt={fmtUsdRule} /> : <span className="cap">no price</span>;
  return (
    <div className="mor__row" role="row">
      <span className="mor__when" role="cell">{fmtAgo(f.ts, now)}</span>
      <span className="mor__kind" role="cell"><Tag kind={f.kind} /></span>
      <span className="mor__amt" role="cell"><Num v={f.amount} fmt={fmtNamRule} unit="NAM" /></span>
      <span className="mor__usd" role="cell">{usd}</span>
      <span className="mor__to" role="cell">
        <span className="mor__tow">to </span>
        <AddrName address={f.to} label={name} source={f.toLabelSource} author={f.toLabelAuthor} />
        {name ? <span className="mono mor__addr">{fmtAddr(f.to)}</span> : null}
        {pair ? (
          // a link by amount and time, not a certainty: the dwell, how many moves in could be the one, the server's confidence
          <span className="mor__pt">
            <Tag look="ref" cat="May pair with a move in" />
            <span className="mor__ptx">
              the same amount went in <span data-num="">{fmtAge(pair.dwellMs)}</span> earlier
              {' · '}<span data-num="">{fmtCount(pair.anonymitySetK)}</span> {pair.anonymitySetK === 1 ? 'move in could be the one' : 'moves in could be the one'}
              {' · '}{PAIR_WORDS[pair.confidence]}
            </span>
          </span>
        ) : null}
      </span>
      <span className="mor__cap" role="cell">{fmtAgo(f.ts, now)} · worth {usd} {priceWords}</span>
      <span className="mor__rec" role="cell"><RecordLink chain="namada" hash={f.explorerHash || f.txHash} /></span>
    </div>
  );
}

// ---------------------------------------------------------------- moved in and out, in 6-hour slices

const CHAR = 6.6; // JetBrains Mono at 11 px
const clock = (t: number) => fmtUtcClock(t).replace(/\s?UTC$/, '');

/**
 * FlowChart: NAM moved into the shielded set (bars up) and out of it (bars down) in the server's slices, on
 * one NAM axis with 1-2-5 ticks in a left gutter (system.md 7.2): container-measured SVG, ticks 11 px, a
 * takeaway title, press-and-drag or the arrow keys into a fixed readout above the plot, a four-figure strip,
 * a key, a hidden text summary and one SourceLine. The part of a slice's moves out that the server paired with
 * a move in of the same amount within PAIR.ms is drawn inside the out bar, at its true share. Nothing is
 * padded or given a minimum height. Without the series (a server before 2026-10-20) the readout and the
 * SourceLine say so and the plot is not drawn.
 */
function FlowChart({ buckets, end, cov, window: winValue, onWindow, rewound }: {
  buckets: MaspPulseBucket[] | null;
  end: number;
  cov: Stamp;
  window: string;
  onWindow: (v: string) => void;
  rewound: boolean;
}) {
  const now = useUiNow();
  const [boxRef, { w, h }] = useSize<HTMLDivElement>();
  const [pick, setPick] = useState<number | null>(null);
  const win = flowWindow(winValue);
  const S = useMemo(() => (buckets ? slicesIn(buckets, end, win.ms) : []), [buckets, end, win.ms]);
  const sums = useMemo(() => flowSums(S), [S]);
  const missing = buckets == null;
  const seriesStamp: Stamp = missing
    ? {
        ...cov,
        at: null,
        status: 'missing',
        note: rewound
          ? 'The server did not send how much NAM moved in and out of the shielded set for that time, so there is no chart to draw.'
          : 'This server does not yet send how much NAM moved in and out of the shielded set, so there is no chart to draw.',
      }
    : cov;

  // ---------------- scales ----------------
  const tStart = end - win.ms;
  const tEnd = end;
  const maxIn = Math.max(0, ...S.map((b) => b.inNam));
  const maxOut = Math.max(0, ...S.map((b) => b.outNam));
  const yT = niceTicks(-maxOut, maxIn, { maxTicks: 5, zero: true });
  const yLabels = yT.ticks.map((t) => (t === 0 ? '0' : `${t > 0 ? '+' : MINUS}${namTick(Math.abs(t), yT.step)}`));
  const L = Math.ceil(Math.max(...yLabels.map((s) => s.length)) * CHAR) + 14;
  const R = 10;
  const T = 14;
  const B = 26;
  const X = lin(tStart, tEnd, L, Math.max(L + 1, w - R));
  const Y = lin(yT.lo, yT.hi, Math.max(T + 1, h - B), T);
  const y0 = Y(0);
  const bars = S.map((b) => {
    const x0 = Math.max(L, X(b.ts));
    const x1 = Math.min(w - R, X(b.ts + SLICE.ms));
    const span = Math.max(0, x1 - x0);
    return { x: x0, w: Math.max(0.5, span > 3 ? span - 1 : span), yIn: Y(b.inNam), yOut: Y(-b.outNam), yBack: Y(-Math.min(b.turnstileNam, b.outNam)) };
  });
  const centres = bars.map((b) => b.x + b.w / 2);
  const xTicks = [tStart, tStart + (tEnd - tStart) / 2, tEnd];

  // ---------------- words ----------------
  const take = flowTakeaway(sums, win.words);
  const heading = missing ? 'Moved in and out of the shielded set' : take.text;
  const last = S[S.length - 1] ?? null;
  // the latest span may still be running: its figures are so far, and it ends later
  const running = last != null && last.ts + SLICE.ms > now;
  const sel = pick != null && S[pick] ? S[pick] : null;
  const shown = sel ?? last;
  const shownRunning = shown != null && shown === last && running;
  const setFromX = (clientX: number, el: Element) => {
    if (!S.length) return;
    const r = el.getBoundingClientRect();
    setPick(nearestIndex(centres, clientX - r.left));
  };
  const cur = sel ? centres[pick as number] : null;
  const scope: ScopeItem[] = [
    { label: `NAM moved into and out of the shielded set, every ${SLICE.words}`, p: seriesStamp },
    { label: `Moves out paired with a move in of the same amount within ${PAIR.words}`, p: seriesStamp },
  ];

  return (
    <section className="chartsec shd-flow" aria-labelledby="shd-flow-h" data-prov-scope="">
      <div className="chartsec__top">
        <div className="chartsec__title">
          <h2 id="shd-flow-h" className="chartsec__h">
            {take.n != null && !missing ? <><Num v={take.n} fmt={namShort} /> {heading}</> : heading}
          </h2>
          {/* the unit line describes a chart: said only once there is one */}
          {missing ? null : (
            <p className="cap">
              {`NAM moved into the shielded set (bars up) and out of it (bars down), every ${SLICE.words}: `}
              <Num v={S.length} fmt={fmtCount} /> {S.length === 1 ? 'such period' : 'such periods'}{` had a move in this window (the server keeps ${SERIES_DAYS} days).`}
              {' '}{`The marked part of a down bar is NAM that had gone in during the ${PAIR.words} before, in the same amount, give or take `}<Num v={PAIR.tolerancePct} fmt={(n) => fmtPctRule(n, 1)} />.
            </p>
          )}
        </div>
        <Segmented label="Window" variant="range" value={win.value} options={FLOW_WINDOWS.map((r) => ({ value: r.value, label: r.label }))} onChange={onWindow} />
      </div>

      <p className="readout" aria-live="polite">
        {missing ? (
          <Num v={null} prov={seriesStamp} />
        ) : shown ? (
          <>
            <span className="readout__k">{sel && !shownRunning ? `Net in these ${SLICE.words}` : shownRunning ? `Net in the latest ${SLICE.words}, so far` : `Net in the latest ${SLICE.words}`}</span>{' '}
            <b data-num="" className="readout__v">{fmtNamSigned(shown.netNam)}<span className="u"> NAM</span></b>{' '}
            <span className="readout__t">{fmtDayMonth(shown.ts)}, {clock(shown.ts)} to {clock(shown.ts + SLICE.ms)} UTC</span>
            <span className="readout__d">
              in <span data-num="">{fmtNamRule(shown.inNam)}</span> · out <span data-num="">{fmtNamRule(shown.outNam)}</span>
              {shown.turnstileNam > 0 ? <> · of that, paired with a move in: <span data-num="">{fmtNamRule(shown.turnstileNam)}</span></> : null}
            </span>
          </>
        ) : (
          <span className="readout__k">No moves in or out in this window.</span>
        )}
      </p>

      {/* no slices: nothing to draw, and no scale is made up for it (the readout says so) */}
      {missing || !S.length ? null : (
        <div
          ref={boxRef}
          className="chart-box chart-box--sm"
          tabIndex={S.length ? 0 : -1}
          role="group"
          aria-label={S.length ? `${take.n != null ? `${namShort(take.n)} ` : ''}${heading}. Press and drag, or use the arrow keys, to read a slice.` : heading}
          onPointerDown={(e) => {
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            setFromX(e.clientX, e.currentTarget);
          }}
          onPointerMove={(e) => {
            if (e.pointerType === 'mouse' || e.buttons) setFromX(e.clientX, e.currentTarget);
          }}
          onPointerLeave={(e) => {
            if (e.pointerType === 'mouse') setPick(null);
          }}
          onPointerUp={(e) => {
            if (e.pointerType !== 'mouse') setPick(null);
          }}
          onPointerCancel={() => setPick(null)}
          onKeyDown={(e) => {
            if (!S.length) return;
            const i = pick ?? S.length - 1;
            if (e.key === 'ArrowLeft') setPick(Math.max(0, i - 1));
            else if (e.key === 'ArrowRight') setPick(Math.min(S.length - 1, i + 1));
            else if (e.key === 'Home') setPick(0);
            else if (e.key === 'End') setPick(S.length - 1);
            else if (e.key === 'Escape') setPick(null);
            else return;
            e.preventDefault();
          }}
          onBlur={() => setPick(null)}
        >
          {w > 0 && h > 0 ? (
            <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
              {yT.ticks.map((t, i) => (
                <g key={t}>
                  <line className={t === 0 ? 'c-axis' : 'c-grid'} x1={L} x2={w - R} y1={Y(t)} y2={Y(t)} />
                  <text className="c-tick" x={L - 8} y={Y(t) + 4} textAnchor="end">{yLabels[i]}</text>
                </g>
              ))}
              {xTicks.map((t, i) => (
                <text key={i} className="c-tick" x={X(t)} y={h - 6} textAnchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}>{fmtDayMonth(t)}</text>
              ))}
              {bars.map((b, i) => (
                <g key={S[i].ts}>
                  {S[i].inNam > 0 ? <rect className="shd-flow__in" x={b.x} y={b.yIn} width={b.w} height={Math.max(0, y0 - b.yIn)} /> : null}
                  {S[i].outNam > 0 ? <rect className="shd-flow__out" x={b.x} y={y0} width={b.w} height={Math.max(0, b.yOut - y0)} /> : null}
                  {S[i].turnstileNam > 0 ? <rect className="shd-flow__back" x={b.x} y={y0} width={b.w} height={Math.max(0, b.yBack - y0)} /> : null}
                </g>
              ))}
              {cur != null ? <line className="c-cursor" x1={cur} x2={cur} y1={T} y2={h - B} /> : null}
            </svg>
          ) : null}
        </div>
      )}

      {missing ? null : (
        <dl className="cstats">
          {/* the server sent the series: a window with no slices is a known zero, never "—" */}
          <div><dt>Moved in</dt><dd data-num="">{fmtNamRule(sums.in)}<small>NAM, {win.words}</small></dd></div>
          <div><dt>Moved out</dt><dd data-num="">{fmtNamRule(sums.out)}<small>NAM, {win.words}</small></dd></div>
          <div><dt>{`Of the moved out, paired with a move in within ${PAIR.words}`}</dt><dd data-num="">{fmtNamRule(sums.back)}<small>NAM, {win.words}</small></dd></div>
          <div>
            <dt>{`Busiest ${SLICE.words}`}</dt>
            <dd data-num="">
              {sums.mostIn && (!sums.mostOut || sums.mostIn.inNam >= sums.mostOut.outNam)
                ? <>{fmtNamRule(sums.mostIn.inNam)}<small>NAM in, {fmtDayClock(sums.mostIn.ts)}</small></>
                : sums.mostOut
                  ? <>{fmtNamRule(sums.mostOut.outNam)}<small>NAM out, {fmtDayClock(sums.mostOut.ts)}</small></>
                  : <>None<small>nothing moved, {win.words}</small></>}
            </dd>
          </div>
        </dl>
      )}

      {missing || !S.length ? null : (
        <ul className="key">
          <li className="key__i"><span className="key__sw shd-flow__sw--in" aria-hidden="true" />Moved in</li>
          <li className="key__i"><span className="key__sw shd-flow__sw--out" aria-hidden="true" />Moved out</li>
          <li className="key__i"><span className="key__sw shd-flow__sw--back" aria-hidden="true" />{`Of the moved out, the same amount had gone in during the ${PAIR.words} before`}</li>
        </ul>
      )}

      <SourceLine items={scope} label="Where the moves come from" />

      {S.length > 0 && last ? (
        <p className="sr-only">
          {`Moved into and out of the shielded set every ${SLICE.words} over ${win.words}: `}
          first {SLICE.words} from {fmtDayClock(S[0].ts)}, in {fmtNamRule(S[0].inNam)} NAM, out {fmtNamRule(S[0].outNam)} NAM;
          {sums.mostIn ? <> most moved in {fmtNamRule(sums.mostIn.inNam)} NAM on {fmtDayClock(sums.mostIn.ts)};</> : null}
          {sums.mostOut ? <> most moved out {fmtNamRule(sums.mostOut.outNam)} NAM on {fmtDayClock(sums.mostOut.ts)};</> : null}
          {' '}latest {SLICE.words} from {fmtDayClock(last.ts)}, in {fmtNamRule(last.inNam)} NAM, out {fmtNamRule(last.outNam)} NAM,{' '}
          {running ? <>still running, it ends at {clock(last.ts + SLICE.ms)} UTC.</> : <>ended {fmtAgo(last.ts + SLICE.ms, now)}.</>}
        </p>
      ) : null}
    </section>
  );
}
