// Shielded (/shielded), S4: "How much NAM can't be seen?" (system.md 9.4; decision D5).
//
// Yellow field: the dateline, the H1, the page's first plain paragraph (shared/copy.ts), the
// share hero (48 px, ProvChip), the shielded bar (shielded, everything else, on Osmosis) with
// its key and one SourceLine. Beside it on desktop, below it on phones: the series chart in
// --shielded with a takeaway title. Then, on black: Inside the shielded set (four facts and one
// SourceLine), Largest moves out in 30 days (rows), and How to read this.
//
// Data: fetchBlindSpot(at) and the shell's overview, both rewound by the shell's fetch wrapper
// under ?at=. Nothing here is live-only. Live, the figures are refreshed every 2 minutes while the
// tab is visible and when it becomes visible again (supply/parts useLiveLoad); a refresh that fails
// keeps them, marked old with the reason.
import { useMemo, useState } from 'react';
import type { BlindSpot, Flow, MaspPassthroughLink, MaspPulseBucket, Overview } from '../../../../shared/types';
import { BODY } from '../../../../shared/copy';
import type { ScreenProps } from '../../app/index';
import { useOverview, useReplay } from '../../app/index';
import { fetchBlindSpot } from '../../api';
import {
  Derived, EmptyState, Fact, HeroNumber, Notice, Num, ProvChip, ProvDot, ProvScope, Segmented, Skeleton, SkeletonBlock, SourceLine, SupplyBar, Tag, Term,
  derive, namShort, useUiNow, type FactItem, type ScopeItem, type Stamp,
} from '../../ui';
import { fmtAgo, fmtAddr, fmtDateline, fmtDayClock, fmtDayMonth, fmtNamRule, fmtNamSigned, fmtPctRule, fmtUsdRule, fmtUtcLong } from '../../lib/format';
import { ageOutStamps, plainSource } from '../../lib/prov';
import { AddrName, RecordLink, useShowAll } from '../../ui';
import { isOld, oldRowsSentence, refreshFailedNote, refreshFailedSentence, useLiveLoad } from '../supply/parts';
import { SeriesChart, type SeriesRange } from '../../ui';

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

export default function ShieldedScreen({ route }: ScreenProps) {
  const { overview: o } = useOverview();
  const { at, rewound } = useReplay();
  const now = useUiNow();
  const [range, setRange] = useState('all');
  const [chartTab, setChartTab] = useState<'total' | 'pulse'>('total');
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
  const pulse = data?.pulseSeries ?? [];
  const firstDaily = trend[0]?.ts ?? null;
  // where the readings switch from one a day to the recent, more frequent ones (from the data itself)
  const switchAt = (() => {
    for (let i = 1; i < trend.length; i++) if (trend[i].ts - trend[i - 1].ts < 20 * 3_600_000) return trend[i - 1].ts;
    return null;
  })();
  const chart = (
    <section className="ground-ink shd-chart" aria-label="Shielded NAM over time" data-decision="D5">
      <div className="shd-chart__in">
        {data && pulse.length > 0 ? (
          <div className="shd-chart__mode">
            <Segmented
              label="Shielded chart view"
              value={chartTab}
              onChange={setChartTab}
              options={[
                { value: 'total', label: 'Total in set' },
                { value: 'pulse', label: 'Net flow pulse & turnstile' },
              ]}
            />
          </div>
        ) : null}
        {chartTab === 'pulse' && data && pulse.length > 0 ? (
          <MaspPulseChart
            buckets={pulse}
            stickySharePct7d={data.stickySharePct7d}
            passthroughCount={data.passthroughs7d?.length ?? 0}
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
              <Inside data={data} overview={o} now={now} />
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

function Inside({ data, overview: o, now }: { data: BlindSpot; overview: Overview | null; now: number }) {
  const cov = data.coverage;
  const sp = data.shielded.prov;
  const total = o?.supply.prov ?? null;
  const shareStamp = joinStamp(total ? [sp, total] : [sp], 'shielded NAM ÷ all NAM');
  const osmoStamp = o ? derive([o.supply.osmosisProv, o.supply.prov], 'NAM on Osmosis ÷ all NAM') : null;
  const net24 = data.shields24h - data.unshields24h;
  const net7 = data.shields7d - data.unshields7d;
  // the bridge part of each side, when the server sends it (a server before 2026-10-18 does not)
  const viaBridge = (n: number | undefined) => (n ? <> (<span data-num="">{fmtNamRule(n)}</span> over the bridge)</> : null);
  const inOut = (i: number, out: number, bi?: number, bo?: number) => (
    <>in <span data-num="">{fmtNamRule(i)}</span>{viaBridge(bi)} · out <span data-num="">{fmtNamRule(out)}</span>{viaBridge(bo)}</>
  );
  const bridged7 = data.bridgeIn7d != null && data.bridgeOut7d != null ? data.bridgeIn7d + data.bridgeOut7d : data.ibcShielded7d;
  const items: FactItem[] = [
    { n: <Num v={data.sharePct} prov={shareStamp} fmt={(n) => fmtPctRule(n, 2)} showAge={false} />, label: 'share of all NAM', scope: { label: 'Share of all NAM in the shielded set', p: shareStamp } },
    {
      n: o ? <Derived inputs={[{ value: o.supply.osmosis, prov: o.supply.osmosisProv }, { value: o.supply.total, prov: o.supply.prov }]} label="NAM on Osmosis ÷ all NAM" name="Share of all NAM on Osmosis" compute={(a, b) => (a / b) * 100} fmt={(n) => fmtPctRule(n, 2)} showAge={false} /> : <span data-num="" data-status="none">—</span>,
      label: 'on Osmosis, for comparison',
      scope: osmoStamp ? { label: 'Share of all NAM on Osmosis', p: osmoStamp } : undefined,
    },
    { n: <Num v={net24} prov={cov} fmt={fmtNamSigned} unit="NAM" showAge={false} />, label: <>moved in, net, 24 h<span className="shd-io">{inOut(data.shields24h, data.unshields24h, data.bridgeIn24h, data.bridgeOut24h)}</span></>, scope: { label: 'Moved in and out, 24 hours', p: cov } },
    { n: <Num v={net7} prov={cov} fmt={fmtNamSigned} unit="NAM" showAge={false} />, label: <>moved in, net, 7 days<span className="shd-io">{inOut(data.shields7d, data.unshields7d, data.bridgeIn7d, data.bridgeOut7d)}</span></>, scope: { label: 'Moved in and out, 7 days', p: cov } },
  ];
  return (
    <ProvScope as="section" className="ipg-sec" aria-labelledby="shd-in-h" data-decision="D5">
      <div className="ipg-sec__head">
        <h2 id="shd-in-h" className="h2">Inside the shielded set</h2>
        <p className="lead ipg-lead">
          <Num v={data.shielded.value} prov={sp} fmt={fmtNamRule} unit="NAM" showAge={false} /> sit in the shielded set. Moving NAM in or out is public; what happens inside is not.
          {' '}<Num v={bridged7} prov={cov} fmt={fmtNamRule} unit="NAM" showAge={false} /> crossed the bridge straight into or out of it in 7 days
          {data.lastBridgeAt != null ? <>, the last {fmtAgo(data.lastBridgeAt, now)}</> : null}.
          {data.stickySharePct7d != null ? (
            <> Over the last 7 days, <strong data-num="">{fmtPctRule(data.stickySharePct7d, 1)}</strong> of shielded inflows stayed in the pool rather than exiting within 24 hours{data.passthroughs7d?.length ? <> ({data.passthroughs7d.length} fast turnstile {data.passthroughs7d.length === 1 ? 'passthrough' : 'passthroughs'} detected)</> : null}.</>
          ) : null}
        </p>
      </div>
      <Fact items={items} sourceLabel="Where the shielded figures come from" className="shd-facts" />
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
            {rows.map((f) => {
              const pt = data.passthroughs7d?.find(
                (p) => p.outTo === f.to && Math.abs(p.outTs - f.ts) < 60_000,
              );
              return <MoveOutRow key={f.id} f={f} now={now} price={price?.value ?? null} priceWords={priceWords} passthrough={pt} />;
            })}
          </div>
          {more}
        </div>
      )}
      <SourceLine items={scope} label="Where the moves come from" />
    </ProvScope>
  );
}

function MoveOutRow({ f, now, price, priceWords, passthrough }: { f: Flow; now: number; price: number | null; priceWords: string; passthrough?: MaspPassthroughLink }) {
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
        {passthrough ? (
          <span className="mor__pt">
            <Tag look="ref" cat={<>Turnstile &lt;24h ({(passthrough.dwellMs / 3_600_000).toFixed(1)}h dwell · k={passthrough.anonymitySetK})</>} />
          </span>
        ) : null}
      </span>
      <span className="mor__cap" role="cell">{fmtAgo(f.ts, now)} · worth {usd} {priceWords}</span>
      <span className="mor__rec" role="cell"><RecordLink chain="namada" hash={f.explorerHash || f.txHash} /></span>
    </div>
  );
}

function MaspPulseChart({
  buckets,
  stickySharePct7d,
  passthroughCount,
}: {
  buckets: MaspPulseBucket[];
  stickySharePct7d?: number | null;
  passthroughCount: number;
}) {
  const [pulseDays, setPulseDays] = useState<7 | 14 | 30>(30);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const sliceCount = Math.max(4, Math.round((pulseDays * 24) / 6));
  const vis = buckets.slice(-sliceCount);
  const maxBar = Math.max(1, ...vis.map((b) => Math.max(b.inNam, b.outNam)));
  const totalIn = vis.reduce((s, b) => s + b.inNam, 0);
  const totalOut = vis.reduce((s, b) => s + b.outNam, 0);
  const totalTurnstile = vis.reduce((s, b) => s + b.turnstileNam, 0);
  const netDelta = totalIn - totalOut;
  const active = hoverIdx != null && vis[hoverIdx] ? vis[hoverIdx] : vis[vis.length - 1];

  return (
    <div className="chart chart--shielded shd-pulse">
      <div className="chart__head">
        <div>
          <h2 id="shd-chart-h" className="chart__t">
            {netDelta >= 0 ? 'Net shielding inflow' : 'Net unshielding outflow'} of {namShort(Math.abs(netDelta))} NAM over {pulseDays} days
          </h2>
          <p className="chart__u">
            6-hour MASP flow pulse: <strong data-num="">{fmtNamRule(totalIn)} NAM</strong> shielded in vs.{' '}
            <strong data-num="">{fmtNamRule(totalOut)} NAM</strong> unshielded out
            {totalTurnstile > 0 ? (
              <>, including <strong data-num="">{fmtNamRule(totalTurnstile)} NAM</strong> in matched &lt;24h turnstile passthroughs</>
            ) : null}
            {stickySharePct7d != null ? <> · 7d sticky share: <strong data-num="">{fmtPctRule(stickySharePct7d, 1)}</strong> ({passthroughCount} fast exits)</> : null}.
          </p>
        </div>
        <div className="seg" role="group" aria-label="Pulse window">
          {([7, 14, 30] as const).map((d) => (
            <button
              key={d}
              type="button"
              className="seg__btn"
              aria-pressed={pulseDays === d}
              onClick={() => {
                setPulseDays(d);
                setHoverIdx(null);
              }}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      {active ? (
        <div className="shd-pulse__readout" aria-live="polite">
          <span className="shd-pulse__when">{fmtDayClock(active.ts)} (6h bucket)</span>
          <span className="shd-pulse__stats">
            In: <strong data-num="">+{fmtNamRule(active.inNam)} NAM</strong> · Out: <strong data-num="">−{fmtNamRule(active.outNam)} NAM</strong> · Net:{' '}
            <strong data-num="">{fmtNamSigned(active.netNam)} NAM</strong>
            {active.turnstileNam > 0 ? <> · &lt;24h turnstile: <strong data-num="">{fmtNamRule(active.turnstileNam)} NAM</strong></> : null}
          </span>
        </div>
      ) : null}

      <div className="shd-pulse__plot" role="img" aria-label={`MASP 6-hour inflow and outflow pulse over ${pulseDays} days`}>
        <div className="shd-pulse__zero" aria-hidden="true" />
        <div className="shd-pulse__bars">
          {vis.map((b, i) => {
            const inPct = Math.min(100, (b.inNam / maxBar) * 100);
            const outPct = Math.min(100, (b.outNam / maxBar) * 100);
            const turnPct = b.outNam > 0 ? Math.min(100, (b.turnstileNam / b.outNam) * 100) : 0;
            return (
              <button
                key={b.ts}
                type="button"
                className={`shd-pulse__col${hoverIdx === i ? ' is-active' : ''}`}
                onMouseEnter={() => setHoverIdx(i)}
                onFocus={() => setHoverIdx(i)}
                onMouseLeave={() => setHoverIdx(null)}
                aria-label={`${fmtDayMonth(b.ts)}: +${fmtNamRule(b.inNam)} in, -${fmtNamRule(b.outNam)} out`}
              >
                <span className="shd-pulse__half shd-pulse__half--up">
                  {b.inNam > 0 ? <span className="shd-pulse__bar shd-pulse__bar--in" style={{ height: `${Math.max(4, inPct).toFixed(1)}%` }} /> : null}
                </span>
                <span className="shd-pulse__half shd-pulse__half--down">
                  {b.outNam > 0 ? (
                    <span className="shd-pulse__bar shd-pulse__bar--out" style={{ height: `${Math.max(4, outPct).toFixed(1)}%` }}>
                      {b.turnstileNam > 0 ? <span className="shd-pulse__turn" style={{ height: `${Math.max(15, turnPct).toFixed(1)}%` }} /> : null}
                    </span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="chart__foot">
        <div className="key">
          <span className="key__i">
            <span className="key__sw shd-pulse__sw--in" />
            <span>Shielded inflow (+NAM)</span>
          </span>
          <span className="key__i">
            <span className="key__sw shd-pulse__sw--out" />
            <span>Unshielded outflow (−NAM)</span>
          </span>
          <span className="key__i">
            <span className="key__sw shd-pulse__sw--turn" />
            <span>&lt;24h turnstile passthrough</span>
          </span>
        </div>
      </div>
    </div>
  );
}
