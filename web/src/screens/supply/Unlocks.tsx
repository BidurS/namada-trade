// Unstaking and restaking (decision D3): large staking moves of the last 30 days with what each
// one led to, as a plain outcome tag ("Sellable in 3.2 days", "Wait over since 4 Oct", "Withdrawn
// 5 Oct", "Restaked, not a sale", "Moved to Osmosis", "Sold on Osmosis", "Shielded", "Still
// spendable"). Unstaked NAM that can be withdrawn now, or soon, is listed first (unbonds.ts); the
// Supply band links here with the Unstaking filter on.
//
// Under the list, a chart with two views (a Segmented): "Next N days" (UnstakeDays: NAM whose
// unstaking wait ends on each coming day, from the chain's own list of every request when the server
// read it, split by what each listed address did with what it unlocked before) and "Staked NAM over
// time" (SeriesChart). The day chart is a measured SVG with no controls in it; one row per day under
// it carries every figure in words, so nothing needs hover and no tap target is narrower than 44 px.
// It has its own ProvScope and SourceLine. Nothing is folded: NAM whose wait ends after the last day
// shown, or whose day is not known, is said in a sentence; NAM whose wait is already over is a
// sentence above the chart, not a bar.
import { useEffect, useMemo, useState } from 'react';
import type { Overview, Pressure, UnlockEntry } from '../../../../shared/types';
import { SELLS_MOST_CUT, SELLS_MOST_PCT } from '../../../../shared/supply-thresholds';
import { DAY_MS, HISTORY_ALL_DAYS, historyCapReached } from '../../../../shared/history';
import { fetchMetricHistory } from '../../api';
import { plainSource, unbondingStamp, type Stamp } from '../../lib/prov';
import { AddrName, Button, Notice, Num, ProvScope, RecordLink, Segmented, SkeletonBlock, SourceLine, Tag, Term, YouTag, derive, namTick, niceTicks, useShowAll, useSize, useUiNow, type ScopeItem, type SeriesRange } from '../../ui';
import { lin } from '../../ui/chartMath';
import { NBSP, fmtAddr, fmtAge, fmtCount, fmtDayClock, fmtDayMonth, fmtNamRule, fmtNamSigned, fmtPctRule, fmtUtcLong } from '../../lib/format';
import { isOld, oldRowsSentence } from './parts';
import { spendableFirst, type UnbondState } from './unbonds';
import { SeriesChart } from '../../ui';

const FIRST = 10;
/** The window the server lists staking moves over (Pressure.unlocksWindowDays; 30 on servers that do not send it). */
export const windowWords = (p: Pressure) => `the last ${p.unlocksWindowDays ?? 30}${NBSP}days`;

export type UnlockFilter = 'all' | 'out' | 'in';
/** The id the Supply band links to (with the Unstaking filter on). */
export const UNLOCKS_ID = 'unstaking';

/** A wait in days for running text: whole days ("about 14 days"); the exact figure is in the source sheet. */
const fmtDays = (n: number) => fmtCount(n);

/**
 * The plain outcome of one staking move, as a tag plus an optional detail sentence. `shared`: how many
 * restaked withdrawals of this address in the list carry the same restake total (it is one figure for them all).
 */
function outcomeOf(u: UnlockEntry, asOf: number, st: UnbondState | undefined, shared: number, waitWords: React.ReactNode): { tag: string; strong: boolean; detail?: React.ReactNode } | null {
  if (u.kind === 'bond') return null;
  if (u.kind === 'unbond') {
    if (!st || st.kind === 'unknown') return { tag: 'Wait not known', strong: false };
    // where the end of the wait comes from: the chain's own list, the indexer's withdraw time, or the request time + the measured wait
    const src = u.liquidAtSource === 'consensus'
      ? <> (the chain&rsquo;s own list gives the <Term id="epoch">epoch</Term> it ends in; the time comes from the measured epoch length)</>
      : u.liquidAtSource === 'indexer' ? <> (the end of the wait from the Namada indexer)</>
      : u.liquidAtSource === 'estimate' ? <> (estimate: the request time + {waitWords})</> : null;
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
    case 'bridged_out': return { tag: 'Moved to Osmosis', strong: true, detail: <>Then moved {amt}{ofIt} to Osmosis.</> };
    case 'sold': return { tag: 'Sold on Osmosis', strong: true, detail: <>Then sold {amt}{ofIt} on Osmosis.</> };
    case 'shielded': return { tag: 'Shielded', strong: false, detail: <>Then moved {amt}{ofIt} into the shielded set.</> };
    case 'liquid': return { tag: 'Still spendable', strong: true, detail: <>Not staked, moved or sold in the 48 h after unlocking.</> };
    default: return null;
  }
}

const KIND_SIGN: Record<UnlockEntry['kind'], 1 | -1> = { bond: 1, unbond: -1, withdraw: -1 };

// The staked-NAM chart's ranges. "All" asks for the most days a history request reaches (shared/history.ts),
// and the chart says so when the answer runs into that cap.
type StakeRange = '14d' | '30d' | '90d' | '1y' | 'all';
const RANGE_DAYS: Record<Exclude<StakeRange, 'all'>, number> = { '14d': 14, '30d': 30, '90d': 90, '1y': 365 };
const STAKE_RANGES: { id: StakeRange; label: string; days: number; ms: number | null }[] = [
  ...(Object.entries(RANGE_DAYS) as [Exclude<StakeRange, 'all'>, number][]).map(([id, days]) => ({ id, label: id, days, ms: days * DAY_MS })),
  { id: 'all', label: 'All', days: HISTORY_ALL_DAYS, ms: null },
];
const STAKE_SERIES_RANGES: SeriesRange[] = STAKE_RANGES.map((r) => ({ value: r.id, label: r.label, ms: r.ms }));
const SHORTEST_MS = RANGE_DAYS['14d'] * DAY_MS;

// ---------------------------------------------------------------- the coming days

/** What a listed address did with what it unlocked before, in the list's window. */
type Group = 'sold' | 'kept' | 'none';

interface WallDay {
  /** 1 = within a day from now, 2 = one to two days from now, … */
  day: number;
  /** the end of the day's span (now + day × 24 h) */
  end: number;
  total: number;
  /** listed requests of addresses that sold or moved to Osmosis at least SELLS_MOST_CUT of what they unlocked before */
  sold: number;
  /** listed requests of addresses that restaked or kept the rest */
  kept: number;
  /** listed requests of addresses with no earlier unlock in the list, and NAM the chain lists beyond the listed requests */
  none: number;
  /** unstaking requests */
  n: number;
}

interface Wall {
  days: WallDay[];
  /** how many days the chart runs: the unstaking wait rounded up, or the last day with a request when the wait is not known */
  horizon: number;
  /** NAM whose wait ends after the horizon */
  later: number;
  /** NAM in its wait whose day is not known (the chain lists it, the epoch length was not read) */
  noDay: number;
  total: number;
  /** the day totals come from the chain's own list of every request */
  fromChain: boolean;
  /** NAM whose wait is over and that has not been withdrawn, from the chain's own list; null when it was not read */
  nowNam: number | null;
}

function wallOf(data: Pressure, states: Map<UnlockEntry, UnbondState>): Wall {
  const asOf = data.asOf;
  // what each address did with what it unlocked in the list's window (each withdrawal's own follow-up)
  const unlocked = new Map<string, number>();
  const soldOut = new Map<string, number>();
  for (const u of data.unlocks) {
    if (u.kind !== 'withdraw' || !u.outcome) continue;
    unlocked.set(u.address, (unlocked.get(u.address) ?? 0) + u.amountNam);
    if (u.outcome.kind === 'sold' || u.outcome.kind === 'bridged_out') soldOut.set(u.address, (soldOut.get(u.address) ?? 0) + Math.min(u.outcome.amountNam, u.amountNam));
  }
  const groupOf = (a: string): Group => {
    const un = unlocked.get(a);
    if (!un) return 'none';
    return (soldOut.get(a) ?? 0) / un >= SELLS_MOST_CUT ? 'sold' : 'kept';
  };
  const dayOf = (t: number) => Math.max(1, Math.ceil((t - asOf) / DAY_MS));

  const listed = new Map<number, Record<Group, number> & { n: number }>();
  for (const u of data.unlocks) {
    if (u.kind !== 'unbond') continue;
    const st = states.get(u);
    if (st?.kind !== 'waiting') continue;
    const d = dayOf(st.liquidAt);
    const b = listed.get(d) ?? { sold: 0, kept: 0, none: 0, n: 0 };
    b[groupOf(u.address)] += u.amountNam;
    b.n += 1;
    listed.set(d, b);
  }
  const term = data.unbondTermStructure ?? null;
  const chain = new Map<number, { nam: number; n: number }>();
  let noDay = 0;
  if (term) {
    for (const b of term.buckets) {
      if (b.withdrawableNow) continue;
      if (b.estimatedAt == null) {
        noDay += b.amountNam;
        continue;
      }
      const d = dayOf(b.estimatedAt);
      const c = chain.get(d) ?? { nam: 0, n: 0 };
      c.nam += b.amountNam;
      c.n += b.count;
      chain.set(d, c);
    }
  }
  const lastDay = Math.max(0, ...listed.keys(), ...chain.keys());
  // the wait in whole days, rounded as the page prints it ("about 14 days"): a request made in the last minutes
  // whose wait runs a fraction past that is counted under "more ends its wait after that", never a near-empty extra day
  const horizon = data.unbondingDays != null ? Math.max(1, Math.round(data.unbondingDays)) : lastDay;
  const days: WallDay[] = [];
  let later = 0;
  for (let d = 1; d <= Math.max(horizon, lastDay); d++) {
    const l = listed.get(d) ?? { sold: 0, kept: 0, none: 0, n: 0 };
    const c = chain.get(d);
    const lsum = l.sold + l.kept + l.none;
    // the chain lists every request; the listed ones are the large ones with an address. When the two place a
    // request on different days (an estimate errs late by at most one epoch), the larger figure of the day stands.
    const total = c ? Math.max(c.nam, lsum) : lsum;
    if (d > horizon) {
      later += total;
      continue;
    }
    days.push({ day: d, end: asOf + d * DAY_MS, total, sold: l.sold, kept: l.kept, none: l.none + (total - lsum), n: c ? Math.max(c.n, l.n) : l.n });
  }
  return { days, horizon, later, noDay, total: days.reduce((a, b) => a + b.total, 0), fromChain: !!term, nowNam: term ? term.withdrawableNowNam : null };
}

/**
 * The scope row for the ends of the wait the chain's bond listing (or the indexer, while no listing completes) gave,
 * with their age: when they are not current the server does not use them, and every row says it is an estimate. The
 * stamp is the server's as it is: its source names who wrote the times (analytics.ts UNBOND_WITHDRAW_SOURCE), and the
 * label says whose list it is.
 */
export function withdrawEndScope(p: Stamp | null | undefined): { label: string; p: Stamp } | null {
  if (!p) return null;
  const fromIndexer = plainSource(p) === 'Namada indexer';
  return { label: fromIndexer ? 'End of each wait: the Namada indexer’s list of unstaking requests' : 'End of each wait: the chain’s own list of unstaking requests', p };
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
  const waitWords: React.ReactNode = data.unbondingEpochs != null && data.epochHours != null
    ? <><Num v={data.unbondingEpochs} fmt={fmtCount} /> <Term id="epoch">epochs</Term> of about <Num v={data.epochHours} fmt={(n) => n.toFixed(1)} unit="h" /></>
    : data.unbondingDays != null ? <><Num v={data.unbondingDays} fmt={fmtDays} unit="days" /></> : 'the unstaking wait';

  // staked NAM over the selected window (14d from Pressure.bondedTrend, or 30d/90d/1y/All from /api/metrics/history)
  const [chartTab, setChartTab] = useState<'days' | 'stake'>('days');
  const [stakeRange, setStakeRange] = useState<StakeRange>('14d');
  // The longer ranges' answer, kept with the range it answers: a series is only ever drawn under its own range,
  // never the 14-day trend (or the previous range's answer) standing in under the one picked.
  const [long, setLong] = useState<{ range: StakeRange; rows: { ts: number; value: number }[] | null; error: string | null } | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (stakeRange === '14d') {
      setLong(null);
      return;
    }
    let alive = true;
    setLong({ range: stakeRange, rows: null, error: null });
    const days = STAKE_RANGES.find((r) => r.id === stakeRange)?.days ?? RANGE_DAYS['30d'];
    fetchMetricHistory('supply.total_stake', days * 24, data.asOf).then(
      (rows) => {
        if (alive) setLong({ range: stakeRange, rows, error: rows.length ? null : 'The server sent no staked-NAM readings for that range.' });
      },
      () => {
        if (alive) setLong({ range: stakeRange, rows: null, error: 'The server did not answer for that range.' });
      },
    );
    return () => {
      alive = false;
    };
  }, [stakeRange, data.asOf, retry]);

  const longOwn = stakeRange !== '14d' && long?.range === stakeRange ? long : null;
  const longWait = stakeRange !== '14d' && (!longOwn || (longOwn.rows == null && longOwn.error == null));
  const longError = longOwn?.error ?? null;
  const trend = stakeRange === '14d' ? data.bondedTrend : longOwn?.rows && !longOwn.error ? longOwn.rows : [];
  const tFirst = trend[0]?.ts ?? null;
  // The record began inside the shortest range: no longer range can show more, so no range is offered and the
  // chart starts at the first reading.
  const recFirst = data.bondedTrend[0]?.ts ?? null;
  const shortRecord = recFirst != null && recFirst - (data.asOf - SHORTEST_MS) > DAY_MS;
  const capHit = stakeRange === 'all' && historyCapReached(tFirst, data.asOf);
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

  const wall = useMemo(() => wallOf(data, states), [data, states]);
  const hasWall = wall.total > 0 || (wall.nowNam ?? 0) > 0;
  const hasTrend = data.bondedTrend.length > 0;

  const endScope = withdrawEndScope(data.unbondWithdrawProv);
  const scope = [
    { label: 'Staking, unstaking and unlocking moves', p: cov },
    { label: 'Unstaking wait', p: waitStamp },
    ...(endScope ? [endScope] : []),
  ];

  return (
    <ProvScope as="section" id={UNLOCKS_ID} className="ipg-sec ipg-col--full ul-sec" aria-labelledby="ul-h" data-decision="D3">
      <div className="ipg-sec__head">
        <h2 id="ul-h" className="h2">Unstaking and restaking</h2>
        <p className="lead ipg-lead">
          {data.unlocksMinNam ? <>The staking moves of {fmtNamRule(data.unlocksMinNam)}{NBSP}NAM or more in {UNLOCK_WINDOW_WORDS}.</> : <>The largest staking moves of {UNLOCK_WINDOW_WORDS}.</>}{' '}
          <Term id="unstaking">Unstaking</Term> takes about{' '}
          <Num v={data.unbondingDays} prov={waitStamp} fmt={fmtDays} unit="days" showReason={false} />: staked NAM becomes spendable that long after the request. A restake is NAM staked again after unlocking; it is not a sale.
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

      {hasWall || hasTrend ? (
        <div className="ul-chart">
          {hasWall && hasTrend ? (
            <div className="ul-chart__mode">
              <Segmented
                label="Staking chart view"
                value={chartTab}
                onChange={setChartTab}
                options={[
                  { value: 'days', label: <span>Next <Num v={wall.horizon} fmt={fmtCount} /> days</span> },
                  { value: 'stake', label: 'Staked NAM over time' },
                ]}
              />
            </div>
          ) : null}
          {chartTab === 'days' && hasWall ? (
            <UnstakeDays wall={wall} data={data} cov={cov} waitStamp={waitStamp} />
          ) : stakeRange !== '14d' && (longWait || longError) ? (
            <section className="chartsec ul-stake-miss" aria-labelledby="ul-chart-h" aria-busy={longWait || undefined}>
              <h3 id="ul-chart-h" className="chartsec__h">Staked NAM over time</h3>
              <Segmented label="Range" variant="range" value={stakeRange} options={STAKE_SERIES_RANGES.map((r) => ({ value: r.value, label: r.label }))} onChange={(v) => setStakeRange(v as StakeRange)} />
              {longWait ? (
                <SkeletonBlock height={208} />
              ) : (
                <Notice tone="warning" title={`— ${longError}`} action={<Button size="sm" onClick={() => setRetry((n) => n + 1)}>Try again</Button>}>
                  No readings are drawn for this range until it answers; the shortest range still shows the readings this site recorded.
                </Notice>
              )}
            </section>
          ) : trend.length ? (
            <SeriesChart
              points={trend.map((p) => ({ t: p.ts, v: p.value }))}
              end={data.asOf}
              tone="ink"
              what="Staked NAM"
              level={3}
              headingId="ul-chart-h"
              {...(shortRecord ? {} : { ranges: STAKE_SERIES_RANGES, range: stakeRange, onRange: (v: string) => setStakeRange(v as StakeRange) })}
              unit={
                <>
                  NAM staked with validators (the chain&rsquo;s total stake), {trend.length} readings recorded by this site{tFirst != null ? <> since {fmtUtcLong(tFirst)}</> : null}.
                  {shortRecord ? <> This site started recording it then, so the chart shows only those <Num v={(data.asOf - (recFirst as number)) / DAY_MS} fmt={(n) => n.toFixed(1)} unit="days" />; a node keeps too little history to read earlier readings back.</> : null}
                  {capHit ? <> &ldquo;All&rdquo; reaches back <Num v={HISTORY_ALL_DAYS} fmt={fmtCount} unit="days" />, the most one request asks for; older readings may exist.</> : null}
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

// ---------------------------------------------------------------- the day chart

const CHAR = 6.6; // JetBrains Mono at 11 px
const GROUPS: { g: Group; cls: string }[] = [
  { g: 'sold', cls: 'ul-days__f--sold' },
  { g: 'kept', cls: 'ul-days__f--kept' },
  { g: 'none', cls: 'ul-days__f--none' },
];

function UnstakeDays({ wall, data, cov, waitStamp }: { wall: Wall; data: Pressure; cov: Stamp; waitStamp: Stamp | null }) {
  const [boxRef, { w, h }] = useSize<HTMLDivElement>();
  const days = wall.days;
  const termStamp: Stamp | null = data.unbondTermStructureProv ? { ...data.unbondTermStructureProv, plain: 'Namada node' } : null;
  const splitStamp = derive(waitStamp ? [cov, waitStamp] : [cov], `what each listed address did with what it unlocked before, cut at ${fmtPctRule(SELLS_MOST_PCT, 0)}`);
  const scope: ScopeItem[] = [
    ...(wall.fromChain && termStamp ? [{ label: 'NAM whose wait ends each day: the chain’s own list of every unstaking request', p: termStamp }] : []),
    { label: wall.fromChain ? 'Which addresses: the large unstaking requests and what each address did with earlier unlocks' : 'NAM whose wait ends each day: the large unstaking requests, and what each address did with earlier unlocks', p: splitStamp },
    { label: 'Unstaking wait (the days the chart runs)', p: waitStamp },
  ];
  const minWords = data.unlocksMinNam ? <>of <Num v={data.unlocksMinNam} fmt={fmtNamRule} unit="NAM" /> or more</> : <>listed above</>;

  // ---------------- scales (a measured SVG: ticks are exactly 11 px at every width)
  const max = Math.max(0, ...days.map((d) => d.total));
  const yT = niceTicks(0, max > 0 ? max : 1, { zero: true, maxTicks: 5 });
  const yLabels = yT.ticks.map((t) => namTick(t, yT.step));
  const L = Math.ceil(Math.max(...yLabels.map((s) => s.length)) * CHAR) + 12;
  const R = 6;
  const T = 10;
  const B = 24;
  const n = Math.max(1, days.length);
  const band = Math.max(0, (w - L - R) / n);
  const barW = band * 0.7;
  const Y = lin(yT.lo, yT.hi, Math.max(T + 1, h - B), T);
  const xLabel = (d: number) => `+${d}d`;
  const labelW = Math.max(...days.map((d) => xLabel(d.day).length), 1) * CHAR + 8;
  const every = band > 0 ? Math.max(1, Math.ceil(labelW / band)) : n;
  const withNam = days.filter((d) => d.total > 0);
  const empty = days.length - withNam.length;
  const parts = (d: WallDay) => [
    d.sold > 0 ? <span key="s"><i className="ul-days__sw ul-days__f--sold" aria-hidden="true" /><Num v={d.sold} fmt={fmtNamRule} /> from addresses that sold or moved most before</span> : null,
    d.kept > 0 ? <span key="k"><i className="ul-days__sw ul-days__f--kept" aria-hidden="true" /><Num v={d.kept} fmt={fmtNamRule} /> from addresses that restaked or kept most</span> : null,
    d.none > 0 ? <span key="n"><i className="ul-days__sw ul-days__f--none" aria-hidden="true" /><Num v={d.none} fmt={fmtNamRule} /> with no earlier unlock on record</span> : null,
  ].filter(Boolean);
  const summary = withNam.length
    ? `NAM whose unstaking wait ends each day: ${withNam.map((d) => `${xLabel(d.day)} ${fmtNamRule(d.total)} NAM`).join(', ')}; no NAM on the other days.`
    : 'No unstaking wait ends in the coming days.';

  return (
    <ProvScope as="section" className="chartsec ul-days" aria-labelledby="ul-days-h">
      <div className="chartsec__title">
        <h3 id="ul-days-h" className="chartsec__h">
          {days.length ? <>NAM whose unstaking wait ends each day for the next <Num v={wall.horizon} fmt={fmtCount} /> days</> : 'No unstaking wait ends in the coming days'}
        </h3>
        <p className="cap">
          The <Term id="unstaking-days">unstaking that ends each day</Term>: <Num v={wall.total} fmt={fmtNamRule} unit="NAM" /> in all,{' '}
          {wall.fromChain ? (
            <>
              from the chain&rsquo;s own list of every unstaking request, <Term id="read-from-chain">read from the chain itself</Term>. The colours say what each address did with what it <Term id="unlocked">unlocked</Term> in {windowWords(data)}; only the requests {minWords} have an address here.
            </>
          ) : (
            <>counting only the unstaking requests {minWords}: the chain&rsquo;s own list of every request was not read. The colours say what each address did with what it <Term id="unlocked">unlocked</Term> in {windowWords(data)}.</>
          )}
          {data.unbondingDays == null ? <> The unstaking wait was not read, so the chart runs to the last day with a request.</> : null}
        </p>
      </div>

      {wall.nowNam != null && wall.nowNam > 0 ? (
        <p className="cap ul-days__now">
          Not in the chart: <Num v={wall.nowNam} fmt={fmtNamRule} unit="NAM" /> on the chain&rsquo;s list has already finished its wait and has not been withdrawn, from requests of every size and age. It can be withdrawn and moved at any time.
        </p>
      ) : null}

      <ul className="key ul-days__key">
        <li className="key__i"><i className="key__sw ul-days__f--sold" aria-hidden="true" /><span><Term id="sold-before">Addresses that sold or moved to Osmosis</Term> at least <Num v={SELLS_MOST_PCT} fmt={(x) => fmtPctRule(x, 0)} /> of what they unlocked before</span></li>
        <li className="key__i"><i className="key__sw ul-days__f--kept" aria-hidden="true" /><span><Term id="kept-staked">Addresses that restaked or kept</Term> most of it</span></li>
        <li className="key__i"><i className="key__sw ul-days__f--none" aria-hidden="true" /><span>No earlier unlock on record, or a request without an address here</span></li>
      </ul>

      <div ref={boxRef} className="ul-days__box" role="img" aria-label={summary} hidden={!days.length}>
        {w > 0 && h > 0 ? (
          <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
            {yT.ticks.map((t, i) => (
              <g key={t}>
                <line className="c-grid" x1={L} x2={w - R} y1={Y(t)} y2={Y(t)} />
                <text className="c-tick" x={L - 8} y={Y(t) + 4} textAnchor="end">{yLabels[i]}</text>
              </g>
            ))}
            {days.map((d, i) => {
              const x = L + i * band + (band - barW) / 2;
              let base = 0;
              return (
                <g key={d.day}>
                  {GROUPS.map(({ g, cls }) => {
                    const v = d[g];
                    if (!(v > 0)) return null;
                    const y0 = Y(base);
                    const y1 = Y(base + v);
                    base += v;
                    return <rect key={g} className={cls} x={x} y={y1} width={barW} height={Math.max(0, y0 - y1)} />;
                  })}
                  {d.day % every === 0 ? (
                    <text className="c-tick" x={L + i * band + band / 2} y={h - 6} textAnchor="middle">{xLabel(d.day)}</text>
                  ) : null}
                </g>
              );
            })}
          </svg>
        ) : null}
      </div>

      {withNam.length ? (
        <ul className="ul-days__list" aria-label="Each day with NAM whose wait ends">
          {withNam.map((d) => (
            <li key={d.day} className="ul-days__row">
              <span className="ul-days__when">{xLabel(d.day)}<span className="ul-days__by">by {fmtDayClock(d.end)}</span></span>
              <span className="ul-days__amt"><Num v={d.total} fmt={fmtNamRule} unit="NAM" /></span>
              <span className="ul-days__how">
                <span><Num v={d.n} fmt={fmtCount} /> {d.n === 1 ? 'request' : 'requests'}</span>
                {parts(d)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="cap">
        {empty > 0 ? <>No unstaking wait ends on the other <Num v={empty} fmt={fmtCount} /> {empty === 1 ? 'day' : 'days'}. </> : null}
        {wall.later > 0 ? <><Num v={wall.later} fmt={fmtNamRule} unit="NAM" /> more ends its wait after that. </> : null}
        {wall.noDay > 0 ? <><Num v={wall.noDay} fmt={fmtNamRule} unit="NAM" /> still in its wait has no known day: the <Term id="epoch">epoch</Term> length was not read. </> : null}
        Each day is a span of 24 hours from now.
      </p>
      <SourceLine items={scope} label="Where the unstaking days come from" />
    </ProvScope>
  );
}

function UnlockRow({ u, asOf, st, shared, waitWords, mine }: { u: UnlockEntry; asOf: number; st: UnbondState | undefined; shared: number; waitWords: React.ReactNode; mine: boolean }) {
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
