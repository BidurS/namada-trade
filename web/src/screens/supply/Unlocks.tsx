// Unstaking and restaking (decision D3): large staking moves of the last 30 days with what each
// one led to, as a plain outcome tag ("Sellable in 3.2 days", "Wait over since 4 Oct", "Withdrawn
// 5 Oct", "Restaked, not a sale", "Moved to Osmosis", "Sold on Osmosis", "Shielded", "Still
// spendable"), then the staked-NAM chart. Unstaked NAM that can be withdrawn now, or soon, is listed
// first (unbonds.ts); the Supply band links here with the Unstaking filter on.
import { useEffect, useMemo, useState } from 'react';
import type { Overview, Pressure, UnlockEntry } from '../../../../shared/types';
import { fetchMetricHistory } from '../../api';
import { unbondingStamp, type Stamp } from '../../lib/prov';
import { AddrName, Num, ProvScope, RecordLink, Segmented, SourceLine, Tag, Term, YouTag, namShort, useShowAll, useUiNow, type SeriesRange } from '../../ui';
import { NBSP, fmtAge, fmtAddr, fmtDayClock, fmtDayMonth, fmtNamRule, fmtNamSigned, fmtUtcLong } from '../../lib/format';
import { isOld, oldRowsSentence } from './parts';
import { spendableFirst, type UnbondState } from './unbonds';
import { SeriesChart } from '../../ui';

const FIRST = 10;
/** The window the server lists staking moves over (Pressure.unlocksWindowDays; 30 on servers that do not send it). */
export const windowWords = (p: Pressure) => `the last ${p.unlocksWindowDays ?? 30}${NBSP}days`;

export type UnlockFilter = 'all' | 'out' | 'in';
/** The id the Supply band links to (with the Unstaking filter on). */
export const UNLOCKS_ID = 'unstaking';
const DAY = 86_400_000;

/**
 * The plain outcome of one staking move, as a tag plus an optional detail sentence. `shared`: how many
 * restaked withdrawals of this address in the list carry the same restake total (it is one figure for them all).
 */
function outcomeOf(u: UnlockEntry, asOf: number, st: UnbondState | undefined, shared: number, waitWords: string): { tag: string; strong: boolean; detail?: React.ReactNode } | null {
  if (u.kind === 'bond') return null;
  if (u.kind === 'unbond') {
    if (!st || st.kind === 'unknown') return { tag: 'Wait not known', strong: false };
    // where the end of the wait comes from: the indexer's own withdraw time, or the request time + the measured wait
    const src = u.liquidAtSource === 'indexer' ? ' (withdraw time from the Namada indexer)' : u.liquidAtSource === 'estimate' ? ` (estimate: ${waitWords})` : '';
    if (st.kind === 'waiting') return { tag: `Sellable in ${fmtAge(st.liquidAt - asOf)}`, strong: true, detail: <>The wait ends {fmtDayClock(st.liquidAt)}{src}.</> };
    if (st.kind === 'withdrawn') return { tag: `Withdrawn ${fmtDayMonth(st.withdrawnAt)}`, strong: false, detail: <>The wait ended {fmtDayMonth(st.liquidAt)}{src}; the withdrawal is listed here too.</> };
    return { tag: `Wait over since ${fmtDayMonth(st.liquidAt)}`, strong: true, detail: <>The wait ended {fmtDayMonth(st.liquidAt)}{src}. No withdrawal of it is recorded: it can be withdrawn and moved at any time.</> };
  }
  // withdraw: what the address did with the NAM in the next 48 h (sales: 7 days)
  const o = u.outcome;
  if (!o) return { tag: 'Unlocked, watched for 48 h', strong: true };
  const amt = <><span data-num="">{fmtNamRule(o.amountNam)}</span> NAM</>;
  // A server from 2026-10-18 on credits each withdrawal at most its own amount ("of it"); an older one could
  // credit an address's whole follow-up to every withdrawal, more than the row's own NAM.
  const ofIt = o.amountNam <= u.amountNam + 0.005 ? ' of it' : '';
  switch (o.kind) {
    // the server knows only that the same address staked again within 48 h, not with which validator
    case 'rebonded': return { tag: 'Restaked, not a sale', strong: false, detail: <>The same address staked {amt}{ofIt} again within 48 hours{shared > 1 ? <>, one total for its {shared} unlocks listed here</> : null}.</> };
    case 'bridged_out': return { tag: 'Moved to Osmosis', strong: true, detail: <>Then bridged {amt}{ofIt} to Osmosis.</> };
    case 'sold': return { tag: 'Sold on Osmosis', strong: true, detail: <>Then sold {amt}{ofIt} on Osmosis.</> };
    case 'shielded': return { tag: 'Shielded', strong: false, detail: <>Then moved {amt}{ofIt} into the shielded set.</> };
    case 'liquid': return { tag: 'Still spendable', strong: true, detail: <>Not staked, bridged or sold in the 48 h after unlocking.</> };
    default: return null;
  }
}

const KIND_SIGN: Record<UnlockEntry['kind'], 1 | -1> = { bond: 1, unbond: -1, withdraw: -1 };

type StakeRange = '14d' | '30d' | '90d' | '1y' | 'all';
const STAKE_RANGES: { id: StakeRange; label: string; hours: number; ms: number | null }[] = [
  { id: '14d', label: '14d', hours: 24 * 14, ms: 14 * DAY },
  { id: '30d', label: '30d', hours: 24 * 30, ms: 30 * DAY },
  { id: '90d', label: '90d', hours: 24 * 90, ms: 90 * DAY },
  { id: '1y', label: '1y', hours: 24 * 365, ms: 365 * DAY },
  { id: 'all', label: 'All', hours: 24 * 1200, ms: null },
];
const STAKE_SERIES_RANGES: SeriesRange[] = STAKE_RANGES.map((r) => ({ value: r.id, label: r.label, ms: r.ms }));

interface UnlockWallBucket {
  dayOffset: number;
  windowStartTs: number;
  windowEndTs: number;
  totalNam: number;
  highHazardNam: number;
  lowHazardNam: number;
  requestCount: number;
}

export function Unlocks({
  data,
  overview: o,
  isMine,
  filter,
  setFilter,
  states,
}: {
  data: Pressure;
  overview: Overview | null;
  isMine: (a: string | null | undefined) => boolean;
  filter: UnlockFilter;
  setFilter: (f: UnlockFilter) => void;
  /** what became of each unstaking request (unbonds.ts) */
  states: Map<UnlockEntry, UnbondState>;
}) {
  const now = useUiNow();
  // Namada staking records only: the Namada flow index's stamp when the server stamps each chain
  const cov = data.coverageByChain?.namada ?? data.coverage;
  const outs = data.unlocks.filter((u) => u.kind !== 'bond');
  const ins = data.unlocks.filter((u) => u.kind === 'bond');
  // unstaked NAM that can be withdrawn now, or soon, first; then the rest newest first
  const list = filter === 'in' ? ins : spendableFirst(filter === 'out' ? outs : data.unlocks, states);
  const firstN = filter === 'in' ? 0 : list.filter((u) => ['ready', 'waiting'].includes(states.get(u)?.kind ?? '')).length;
  const [rows, more] = useShowAll(list, Math.max(FIRST, firstN));
  const old = isOld(cov);
  // An older server credits the whole 48-hour restake to every withdrawal of the address, so one total (larger than
  // any one of those withdrawals) stands on several rows: say so on each. A newer server shares the restake out,
  // each withdrawal at most its own amount, and then no row is said to share.
  const sharesTotal = (u: UnlockEntry) => u.kind === 'withdraw' && u.outcome?.kind === 'rebonded' && u.outcome.amountNam > u.amountNam;
  const restakes = new Map<string, number>();
  for (const u of data.unlocks) if (sharesTotal(u)) restakes.set(`${u.address}|${u.outcome!.amountNam}`, (restakes.get(`${u.address}|${u.outcome!.amountNam}`) ?? 0) + 1);
  const sharedOf = (u: UnlockEntry) => (sharesTotal(u) ? restakes.get(`${u.address}|${u.outcome!.amountNam}`) ?? 1 : 1);

  // The unstaking wait comes from the chain's own settings, read through the Namada indexer.
  const waitStamp = unbondingStamp(data);
  const UNLOCK_WINDOW_WORDS = windowWords(data);
  const waitWords = data.unbondingEpochs != null && data.epochHours != null
    ? `${data.unbondingEpochs} epochs of about ${data.epochHours.toFixed(1)}${NBSP}h`
    : data.unbondingDays != null ? `the request time + ${data.unbondingDays.toFixed(2)}${NBSP}days` : 'the request time + the unstaking wait';

  // staked NAM over the selected window (14d from Pressure.bondedTrend, or 30d/90d/1y/All from /api/metrics/history)
  const [chartTab, setChartTab] = useState<'wall' | 'stake'>('wall');
  const [stakeRange, setStakeRange] = useState<StakeRange>('14d');
  const [longTrend, setLongTrend] = useState<{ ts: number; value: number }[] | null>(null);
  useEffect(() => {
    if (stakeRange === '14d') {
      setLongTrend(null);
      return;
    }
    let alive = true;
    const hrs = STAKE_RANGES.find((r) => r.id === stakeRange)?.hours ?? 24 * 30;
    fetchMetricHistory('supply.total_stake', hrs, data.asOf).then(
      (rows) => {
        if (alive && rows.length) setLongTrend(rows);
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [stakeRange, data.asOf]);

  const trend = stakeRange !== '14d' && longTrend && longTrend.length ? longTrend : data.bondedTrend;
  const tFirst = trend[0]?.ts ?? null;
  const shortHistory = stakeRange === '14d' && tFirst != null && tFirst - (data.asOf - 14 * DAY) > DAY;
  // fresh while the last reading came on the series' own schedule (within two of its usual gaps)
  const gaps = trend.slice(1).map((p, i) => p.ts - trend[i].ts).sort((a, b) => a - b);
  const usualGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;
  const lastTs = trend.length ? trend[trend.length - 1].ts : null;
  const onSchedule = usualGap != null && lastTs != null && data.asOf - lastTs <= 2 * usualGap;
  const trendStamp: Stamp | null = lastTs != null
    ? {
        source: o?.supply.prov.source && o.supply.prov.status !== 'missing' ? o.supply.prov.source : 'Namada nodes',
        at: lastTs,
        status: onSchedule ? 'live' : 'stale',
        note: onSchedule ? 'The chain\'s total stake as recorded by this site from a Namada node.' : 'The last reading is older than two of the usual gaps between readings.',
      }
    : null;
  // Build 15-day forward maturity wall buckets (0 = withdrawable now, 1..14 = upcoming days across the 56-epoch wait)
  const timeline = useMemo<UnlockWallBucket[]>(() => {
    const buckets: UnlockWallBucket[] = Array.from({ length: 15 }, (_, d) => ({
      dayOffset: d,
      windowStartTs: d === 0 ? data.asOf - 14 * DAY : data.asOf + (d - 1) * DAY,
      windowEndTs: d === 0 ? data.asOf : data.asOf + d * DAY,
      totalNam: 0,
      highHazardNam: 0,
      lowHazardNam: 0,
      requestCount: 0,
    }));
    // Identify addresses with historical dump/bridge outcomes or high onDeck dumpHazardScore
    const highHazardAddrs = new Set<string>();
    for (const u of data.unlocks) {
      if (u.kind === 'withdraw' && (u.outcome?.kind === 'sold' || u.outcome?.kind === 'bridged_out')) {
        highHazardAddrs.add(u.address);
      }
    }
    for (const od of data.onDeck) {
      if ((od.dumpHazardScore ?? 0) >= 0.5) {
        if (od.linkedNamada) highHazardAddrs.add(od.linkedNamada);
        if (od.hopOriginNamada?.address) highHazardAddrs.add(od.hopOriginNamada.address);
      }
    }
    for (const u of data.unlocks) {
      if (u.kind !== 'unbond') continue;
      const st = states.get(u);
      if (!st || st.kind === 'withdrawn' || st.kind === 'unknown') continue;
      const d = st.kind === 'ready' ? 0 : Math.max(1, Math.min(14, Math.ceil((st.liquidAt - data.asOf) / DAY)));
      const b = buckets[d];
      b.totalNam += u.amountNam;
      if (highHazardAddrs.has(u.address)) b.highHazardNam += u.amountNam;
      else b.lowHazardNam += u.amountNam;
      b.requestCount += 1;
    }
    // Also incorporate consensus ABCI unbond term structure buckets if present and higher than indexed large unbonds
    if (data.unbondTermStructure?.buckets?.length) {
      for (const cb of data.unbondTermStructure.buckets) {
        const d = cb.withdrawableNow || cb.estimatedAt == null
          ? 0
          : Math.max(1, Math.min(14, Math.ceil((cb.estimatedAt - data.asOf) / DAY)));
        const b = buckets[d];
        if (cb.amountNam > b.totalNam) {
          const diff = cb.amountNam - b.totalNam;
          b.totalNam += diff;
          b.lowHazardNam += diff;
          b.requestCount = Math.max(b.requestCount, cb.count);
        }
      }
    }
    return buckets;
  }, [data.unlocks, data.onDeck, data.unbondTermStructure, data.asOf, states]);
  const hasWall = timeline.some((b) => b.totalNam > 0);

  const scope = [
    { label: 'Staking, unstaking and unlocking moves', p: cov },
    { label: 'Unstaking wait', p: waitStamp },
  ];

  return (
    <ProvScope as="section" id={UNLOCKS_ID} className="ipg-sec ipg-col--full ul-sec" aria-labelledby="ul-h" data-decision="D3">
      <div className="ipg-sec__head">
        <h2 id="ul-h" className="h2">Unstaking and restaking</h2>
        <p className="lead ipg-lead">
          {data.unlocksMinNam ? <>The staking moves of {fmtNamRule(data.unlocksMinNam)}{NBSP}NAM or more in {UNLOCK_WINDOW_WORDS}.</> : <>The largest staking moves of {UNLOCK_WINDOW_WORDS}.</>}{' '}
          <Term id="unstaking">Unstaking</Term> takes about{' '}
          <Num v={data.unbondingDays} prov={waitStamp} fmt={(n) => n.toFixed(2)} unit="days" showReason={false} />: staked NAM becomes spendable that long after the request. A restake is NAM staked again after unlocking; it is not a sale.
        </p>
      </div>

      {data.unlocks.length ? (
        <Segmented
          label="Which staking moves"
          className="ul-filter"
          value={filter}
          onChange={(v) => setFilter(v)}
          options={[
            { value: 'all', label: <>All <span className="seg__n">{outs.length + ins.length}</span></> },
            { value: 'out', label: <>Unstaking <span className="seg__n">{outs.length}</span></> },
            { value: 'in', label: <>Staking <span className="seg__n">{ins.length}</span></> },
          ]}
        />
      ) : null}

      {firstN > 0 ? <p className="cap ul-order">Unstaked NAM that can be withdrawn now, or once its wait ends, is listed first; then every other move, newest first.</p> : null}

      {list.length === 0 ? (
        <p className="cap">{data.unlocks.length ? 'No moves of this kind in the window.' : `No large staking moves in ${UNLOCK_WINDOW_WORDS}.`}</p>
      ) : (
        <div className={`xlist${old ? ' is-old' : ''}`}>
          {old ? (
            <p className="scope__old">
              <i className="dot" data-status="old" aria-hidden="true" />
              <span>{oldRowsSentence(cov, now)}</span>
            </p>
          ) : null}
          <div className="ulr" role="table" aria-label={`Large staking moves, ${UNLOCK_WINDOW_WORDS}`}>
            <div className="ulr__head" role="row">
              <span role="columnheader">When</span>
              <span role="columnheader">What</span>
              <span role="columnheader" className="r">NAM</span>
              <span role="columnheader">Address</span>
              <span role="columnheader">Then</span>
              <span role="columnheader" className="r">Record</span>
            </div>
            {rows.map((u) => (
              <UnlockRow key={`${u.txHash}-${u.ts}-${u.kind}`} u={u} asOf={data.asOf} st={states.get(u)} shared={sharedOf(u)} waitWords={waitWords} mine={isMine(u.address)} />
            ))}
          </div>
          {more}
        </div>
      )}
      <SourceLine items={scope} label="Where the staking figures come from" />

      {hasWall || trend.length ? (
        <div className="ul-chart">
          {hasWall && trend.length ? (
            <div className="ul-chart__mode">
              <Segmented
                label="Staking chart view"
                value={chartTab}
                onChange={setChartTab}
                options={[
                  { value: 'wall', label: 'Upcoming unlock wall (14d)' },
                  { value: 'stake', label: 'Staked NAM history' },
                ]}
              />
            </div>
          ) : null}
          {chartTab === 'wall' && hasWall ? (
            <UnlockMaturityWallChart
              buckets={timeline}
              asOf={data.asOf}
              unbondingDays={data.unbondingDays}
              unbondingEpochs={data.unbondingEpochs}
              liquidityUsd={o?.dex.liquidityUsd ?? null}
              priceUsd={o?.price.usd.value ?? null}
            />
          ) : trend.length ? (
            <SeriesChart
              points={trend.map((p) => ({ t: p.ts, v: p.value }))}
              end={data.asOf}
              tone="ink"
              what="Staked NAM"
              level={3}
              headingId="ul-chart-h"
              ranges={STAKE_SERIES_RANGES}
              range={stakeRange}
              onRange={(v) => setStakeRange(v as StakeRange)}
              unit={
                <>
                  NAM staked with validators (the chain&rsquo;s total stake), {trend.length} readings recorded by this site{tFirst != null ? <> since {fmtUtcLong(tFirst)}</> : null}.
                  {shortHistory ? ' Earlier readings were not recorded, and a node keeps too little history to read them back.' : ''}
                </>
              }
              prov={trendStamp}
              provLabel="Staked NAM readings"
            />
          ) : null}
        </div>
      ) : null}
    </ProvScope>
  );
}

function UnlockMaturityWallChart({
  buckets,
  asOf,
  unbondingDays,
  unbondingEpochs,
  liquidityUsd,
  priceUsd,
}: {
  buckets: UnlockWallBucket[];
  asOf: number;
  unbondingDays?: number | null;
  unbondingEpochs?: number | null;
  liquidityUsd: number | null;
  priceUsd: number | null;
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const maxNam = Math.max(1, ...buckets.map((b) => b.totalNam));
  // Approximate 2% pool slippage absorption capacity in NAM (roughly ~1% of pool USD depth converted to NAM)
  const poolCapNam = liquidityUsd && priceUsd && priceUsd > 0 ? (liquidityUsd * 0.015) / priceUsd : null;
  const ceilingMax = poolCapNam != null && poolCapNam < maxNam * 1.4 ? Math.max(maxNam, poolCapNam * 1.1) : maxNam * 1.1;
  const totalUpcoming = buckets.reduce((s, b) => s + b.totalNam, 0);
  const totalHighHazard = buckets.reduce((s, b) => s + b.highHazardNam, 0);
  const active = hoverIdx != null ? buckets[hoverIdx] : buckets.find((b) => b.totalNam > 0) ?? buckets[0];

  return (
    <section className="chart chart--ink ul-wall" aria-labelledby="ul-wall-h">
      <div className="chart__head">
        <div>
          <h3 id="ul-wall-h" className="h3">56-epoch forward unlock term structure (Maturity wall)</h3>
          <p className="chart__u">
            <strong data-num="">{fmtNamRule(totalUpcoming)} NAM</strong> unlocking across {unbondingEpochs ?? 56} epochs (~{(unbondingDays ?? 14).toFixed(1)} days), split by wallet historical dump hazard (
            <strong data-num="">{fmtNamRule(totalHighHazard)} NAM</strong> from high-hazard sellers vs. sticky restakers).
          </p>
        </div>
      </div>

      {active ? (
        <div className="ul-wall__readout" aria-live="polite">
          <span className="ul-wall__when">
            {active.dayOffset === 0 ? 'Now (Wait over, ready to withdraw)' : `+${active.dayOffset}d (${fmtDayMonth(active.windowStartTs)} – ${fmtDayMonth(active.windowEndTs)})`}
          </span>
          <span className="ul-wall__stats">
            Total: <strong data-num="">{fmtNamRule(active.totalNam)} NAM</strong> · High dump hazard (≥50%):{' '}
            <strong data-num="">{fmtNamRule(active.highHazardNam)} NAM</strong> · Sticky / low hazard:{' '}
            <strong data-num="">{fmtNamRule(active.lowHazardNam)} NAM</strong> · {active.requestCount} {active.requestCount === 1 ? 'request' : 'requests'}
          </span>
        </div>
      ) : null}

      <div className="ul-wall__plot" role="img" aria-label="14-day forward unbonding maturity wall by dump hazard">
        {poolCapNam != null && poolCapNam <= ceilingMax ? (
          <div
            className="ul-wall__cap"
            style={{ bottom: `${Math.min(92, Math.max(8, (poolCapNam / ceilingMax) * 100)).toFixed(1)}%` }}
            title={`Est. daily Osmosis pool absorption before >2% slippage: ~${fmtNamRule(poolCapNam)} NAM`}
          >
            <span className="ul-wall__cap-lbl">Pool ~2% impact ceiling ({namShort(poolCapNam)} NAM)</span>
          </div>
        ) : null}
        <div className="ul-wall__bars">
          {buckets.map((b, i) => {
            const hPct = ceilingMax > 0 ? Math.min(100, (b.totalNam / ceilingMax) * 100) : 0;
            const highShare = b.totalNam > 0 ? (b.highHazardNam / b.totalNam) * 100 : 0;
            const isSel = hoverIdx === i;
            return (
              <button
                key={b.dayOffset}
                type="button"
                className={`ul-wall__col${isSel ? ' is-active' : ''}`}
                onMouseEnter={() => setHoverIdx(i)}
                onFocus={() => setHoverIdx(i)}
                onMouseLeave={() => setHoverIdx(null)}
                aria-label={`${b.dayOffset === 0 ? 'Ready now' : `Day +${b.dayOffset}`}: ${fmtNamRule(b.totalNam)} NAM (${fmtNamRule(b.highHazardNam)} high hazard)`}
              >
                <span className="ul-wall__bar-wrap">
                  {b.totalNam > 0 ? (
                    <span className="ul-wall__bar" style={{ height: `${Math.max(4, hPct).toFixed(1)}%` }}>
                      {b.highHazardNam > 0 ? (
                        <span className="ul-wall__seg ul-wall__seg--high" style={{ height: `${Math.max(10, highShare).toFixed(1)}%` }} />
                      ) : null}
                      {b.lowHazardNam > 0 ? (
                        <span className="ul-wall__seg ul-wall__seg--low" style={{ height: `${Math.max(0, 100 - highShare).toFixed(1)}%` }} />
                      ) : null}
                    </span>
                  ) : (
                    <span className="ul-wall__bar ul-wall__bar--zero" />
                  )}
                </span>
                <span className="ul-wall__x">{b.dayOffset === 0 ? 'Now' : `+${b.dayOffset}d`}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="chart__foot">
        <div className="key">
          <span className="key__i">
            <span className="key__sw ul-wall__sw--high" />
            <span>High dump-hazard wallet (≥50% historical bridge/sell rate)</span>
          </span>
          <span className="key__i">
            <span className="key__sw ul-wall__sw--low" />
            <span>Sticky staker / low hazard (&lt;50% dump rate)</span>
          </span>
          <span className="key__i">
            <span>As of {fmtDayClock(asOf)}</span>
          </span>
        </div>
      </div>
    </section>
  );
}

function UnlockRow({ u, asOf, st, shared, waitWords, mine }: { u: UnlockEntry; asOf: number; st: UnbondState | undefined; shared: number; waitWords: string; mine: boolean }) {
  const name = u.labelPlain ?? null;
  const out = outcomeOf(u, asOf, st, shared, waitWords);
  return (
    <div className="ulr__row" role="row">
      <span className="ulr__when" role="cell">{fmtDayClock(u.ts)}</span>
      <span className="ulr__kind" role="cell"><Tag kind={u.kind} /></span>
      <span className="ulr__amt" role="cell"><Num v={KIND_SIGN[u.kind] * u.amountNam} fmt={fmtNamSigned} unit="NAM" /></span>
      <span className="ulr__who" role="cell">
        <AddrName address={u.address} label={name} source={u.labelSource} author={u.labelAuthor} />
        {name ? <span className="mono ulr__addr">{fmtAddr(u.address)}</span> : null}
        {mine ? <YouTag /> : null}
      </span>
      <span className="ulr__then" role="cell">
        {out ? (
          <>
            <Tag cat={out.tag} look={out.strong ? 'ref' : 'cat'} />
            {out.detail ? <span className="ulr__detail">{out.detail}</span> : null}
          </>
        ) : (
          <span className="ulr__detail ulr__detail--bond">Locked with a validator.</span>
        )}
      </span>
      <span className="ulr__rec" role="cell"><RecordLink chain="namada" hash={u.explorerHash || u.txHash} /></span>
    </div>
  );
}
