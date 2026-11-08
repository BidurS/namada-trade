// Genesis cohorts (the Supply page, 2026-11-07; migration 0023): what the addresses funded at genesis hold now, by
// cohort, against what they were allocated. From 1024 px this section shows the one sentence, the cohorts' share held
// over time (a small chart from cohort_daily, one line per cohort), a table of the cohorts, and the allocations of
// 15,000,000 NAM or more with what each holds now and what left it, in the flow index's words: "moved into the shielded
// pool", "sent to <address>" with the recipient's label when one exists, else its address and how many addresses it has
// since sent to. Never a link to any shielded exit, never a reason. A phone shows the sentence alone, inside the
// since-genesis section (SinceGenesis.tsx), so this section renders only when `wide`. Every figure arrives from
// /api/series/cohorts with its stamp; nothing here is typed.
import { useEffect, useMemo, useState } from 'react';
import type { GenesisCohortsResponse, GenesisLargeAllocation, SeriesResponse } from '../../../../shared/types';
import { COHORT_WORDS } from '../../../../shared/copy';
import { ALLOC_PLAIN, type AllocCategory } from '../../../../shared/genesis';
import { fetchSeries } from '../../api';
import { AddrName, Num, ProvDot, ProvScope, SourceLine, derive, useSize, type ScopeItem, type Stamp } from '../../ui';
import { lin, niceTicks, pathOf } from '../../ui/chartMath';
import { fmtCount, fmtDayMonth, fmtNamRule, fmtPctRule } from '../../lib/format';
import { CHART_COHORTS, chartKey, cohortLineParts, tableStamp } from './cohorts';

const pct0 = (x: number) => fmtPctRule(x, 0);
const pct1 = (x: number) => fmtPctRule(x, 1);
const COHORT_CLASS: Record<AllocCategory, string> = {
  backer: 'sp-coh__c--backer', foundation: 'sp-coh__c--foundation', team: 'sp-coh__c--team', validators: 'sp-coh__c--validators',
  ecosystem: 'sp-coh__c--ecosystem', public_completed: 'sp-coh__c--public', public_future: 'sp-coh__c--future',
};

export function GenesisCohorts({ data, failed, at }: { data: GenesisCohortsResponse | null; failed: boolean; /** the rewound time, null when live */ at: number | null }) {
  if (!data) {
    return failed ? (
      <section className="ipg-sec ipg-col--full sp-coh" aria-labelledby="sp-coh-h">
        <h2 id="sp-coh-h" className="h2">{COHORT_WORDS.heading}</h2>
        <p className="cap">The genesis cohorts did not load: the server did not answer.</p>
      </section>
    ) : null;
  }
  const answer = cohortLineParts(data);
  const p = answer.parts;
  const line = p ? COHORT_WORDS.line(pct0(p.allPct), pct0(p.backersPct), pct0(p.foundationPct), pct0(p.teamPct), pct0(p.publicPct), fmtNamRule(p.shieldedNam)) : null;
  const stamp: Stamp = data.prov;
  const table = tableStamp(data.table);
  const scope: ScopeItem[] = [
    { label: COHORT_WORDS.scope.cohorts, p: stamp },
    { label: COHORT_WORDS.scope.table, p: table },
    ...(data.large.length ? [{ label: COHORT_WORDS.scope.holdings, p: data.holdingsProv }, { label: COHORT_WORDS.scope.moves, p: data.movesProv }] : []),
  ];
  return (
    <ProvScope as="section" className="ipg-sec ipg-col--full sp-coh" aria-labelledby="sp-coh-h">
      <div className="ipg-sec__head">
        <h2 id="sp-coh-h" className="h2">{COHORT_WORDS.heading}</h2>
        <p className="lead ipg-lead">{COHORT_WORDS.lead}</p>
      </div>
      <p className="ipg-prose" data-prov-group="">
        {line ?? <Num v={null} prov={{ ...stamp, status: 'missing', note: answer.why ?? stamp.note }} label={COHORT_WORDS.heading} />}{' '}
        <ProvDot p={line ? stamp : { ...stamp, status: 'missing', note: answer.why ?? stamp.note }} label={COHORT_WORDS.heading} />
      </p>
      {data.table.loaded ? <CohortChart at={at} snapshot={stamp} /> : null}
      {data.cohorts.length ? <CohortTable rows={data.cohorts} /> : null}
      {data.large.length ? <LargeTable rows={data.large} minNam={data.largeMinNam} /> : data.table.loaded && at != null ? <p className="cap">{COHORT_WORDS.large.rewound}</p> : null}
      <SourceLine items={scope} label="Where the genesis cohort figures come from" />
    </ProvScope>
  );
}

// ---------------------------------------------------------------- the cohorts over time

interface Line { cohort: AllocCategory; points: { t: number; v: number }[]; prov: Stamp | null }

/** The share held per cohort, once a day over the last 30 days (the series' default window), one request per cohort; `at` is the rewound time. */
function useCohortLines(at: number | null): { lines: Line[] | null; failed: boolean } {
  const [st, setSt] = useState<{ at: number | null; lines: Line[] | null; failed: boolean }>({ at, lines: null, failed: false });
  useEffect(() => {
    const ctl = new AbortController();
    Promise.all(CHART_COHORTS.map((c) => fetchSeries({ key: chartKey(c), step: '1d', asOf: at }, { signal: ctl.signal }).then((s: SeriesResponse) => ({ cohort: c, points: s.points.map((x) => ({ t: x.t, v: x.v })), prov: s.prov as Stamp }))))
      .then((lines) => { if (!ctl.signal.aborted) setSt({ at, lines, failed: false }); }, () => { if (!ctl.signal.aborted) setSt({ at, lines: null, failed: true }); });
    return () => ctl.abort();
  }, [at]);
  return st.at === at ? { lines: st.lines, failed: st.failed } : { lines: null, failed: false };
}

const CHART_H = 160, GUTTER = 44, PAD_T = 8, PAD_B = 20;

function CohortChart({ at, snapshot }: { at: number | null; snapshot: Stamp }) {
  const { lines, failed } = useCohortLines(at);
  const [ref, { w }] = useSize<HTMLDivElement>();
  const drawn = useMemo(() => (lines ?? []).filter((l) => l.points.length > 0), [lines]);
  const all = drawn.flatMap((l) => l.points);
  const t0 = all.length ? Math.min(...all.map((x) => x.t)) : 0, t1 = all.length ? Math.max(...all.map((x) => x.t)) : 1;
  const ticks = all.length ? niceTicks(0, Math.max(1, ...all.map((x) => x.v)), { maxTicks: 4, zero: true }) : null;
  const X = lin(t0, t1 === t0 ? t0 + 1 : t1, GUTTER + 4, Math.max(GUTTER + 8, w - 8));
  const Y = ticks ? lin(ticks.lo, ticks.hi, CHART_H - PAD_B, PAD_T) : (v: number) => v;
  const chartStamp = derive([snapshot, ...drawn.map((l) => l.prov).filter((x): x is Stamp => !!x)], 'the daily snapshot’s share held per cohort');
  const summary = drawn.map((l) => `${ALLOC_PLAIN[l.cohort]} ${pct1(l.points[l.points.length - 1].v)} on ${fmtDayMonth(l.points[l.points.length - 1].t)}`).join(', ');
  return (
    <div className="sp-coh__chart" role="group" aria-labelledby="sp-coh-chart-h">
      <p id="sp-coh-chart-h" className="sp-coh__what">{COHORT_WORDS.chart.what} <ProvDot p={chartStamp} label={COHORT_WORDS.chart.what} /></p>
      <p className="cap">{COHORT_WORDS.chart.unit}</p>
      <div className="sp-coh__plot" ref={ref}>
        {w > 0 && drawn.length && ticks ? (
          <svg width={w} height={CHART_H} viewBox={`0 0 ${w} ${CHART_H}`} role="img" aria-label={`${COHORT_WORDS.chart.what}: ${summary}`}>
            {ticks.ticks.map((v) => (
              <g key={v}>
                <line className="sp-coh__grid" x1={GUTTER} x2={w} y1={Y(v)} y2={Y(v)} />
                <text className="sp-coh__tick" x={GUTTER - 6} y={Y(v) + 4} textAnchor="end">{pct0(v)}</text>
              </g>
            ))}
            <text className="sp-coh__tick" x={GUTTER + 4} y={CHART_H - 4}>{fmtDayMonth(t0)}</text>
            {t1 > t0 ? <text className="sp-coh__tick" x={w - 8} y={CHART_H - 4} textAnchor="end">{fmtDayMonth(t1)}</text> : null}
            {drawn.map((l) => {
              const pts = l.points.map((x) => [X(x.t), Y(x.v)] as [number, number]);
              return pts.length > 1
                ? <path key={l.cohort} className={`sp-coh__line ${COHORT_CLASS[l.cohort]}`} d={pathOf(pts)} />
                : <circle key={l.cohort} className={`sp-coh__dot ${COHORT_CLASS[l.cohort]}`} cx={pts[0][0]} cy={pts[0][1]} r={3} />;
            })}
          </svg>
        ) : (
          <p className="cap sp-coh__empty">{failed ? 'The series did not load.' : lines ? COHORT_WORDS.chart.empty : null}</p>
        )}
      </div>
      {drawn.length ? (
        <ul className="sp-coh__legend">
          {drawn.map((l) => (
            <li key={l.cohort} className="sp-coh__li">
              <i className={`sp-coh__sw ${COHORT_CLASS[l.cohort]}`} aria-hidden="true" />
              <span className="sp-coh__name">{ALLOC_PLAIN[l.cohort]}</span>
              <span className="sp-coh__v"><Num v={l.points[l.points.length - 1].v} fmt={pct1} /></span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- the cohorts

function CohortTable({ rows }: { rows: GenesisCohortsResponse['cohorts'] }) {
  const c = COHORT_WORDS.columns;
  return (
    <div className="sp-coh__tbl" role="table" aria-label={COHORT_WORDS.heading}>
      <div className="sp-coh__row sp-coh__row--head" role="row">
        <span role="columnheader">{c.cohort}</span>
        <span role="columnheader" className="r">{c.addrs}</span>
        <span role="columnheader" className="r">{c.alloc}</span>
        <span role="columnheader" className="r">{c.held}</span>
        <span role="columnheader" className="r">{c.share}</span>
        <span role="columnheader" className="r">{c.shielded}</span>
      </div>
      {rows.map((r) => (
        <div key={r.cohort} className={`sp-coh__row${r.cohort === 'all' ? ' sp-coh__row--all' : ''}`} role="row">
          <span role="cell">{r.plain}</span>
          <span role="cell" className="r"><Num v={r.addrs} fmt={fmtCount} /></span>
          <span role="cell" className="r"><Num v={r.allocNam} fmt={fmtNamRule} /></span>
          <span role="cell" className="r"><Num v={r.heldNam} fmt={fmtNamRule} /></span>
          <span role="cell" className="r"><Num v={r.heldSharePct} fmt={pct1} status={r.heldSharePct == null ? 'none' : undefined} showReason={false} /></span>
          <span role="cell" className="r"><Num v={r.shieldedOutNam} fmt={fmtNamRule} showReason={false} /></span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- the largest allocations

function LargeTable({ rows, minNam }: { rows: GenesisLargeAllocation[]; minNam: number }) {
  const W = COHORT_WORDS.large;
  return (
    <div className="sp-coh__large">
      <h3 className="h3">{W.heading(fmtNamRule(minNam))}</h3>
      <p className="cap">{W.lead}</p>
      <div className="sp-coh__ltbl" role="table" aria-label={W.heading(fmtNamRule(minNam))}>
        <div className="sp-coh__lrow sp-coh__lrow--head" role="row">
          <span role="columnheader">{COHORT_WORDS.columns.cohort}</span>
          <span role="columnheader">{W.holds}</span>
          <span role="columnheader">{W.left}</span>
        </div>
        {rows.map((r) => <LargeRow key={r.address} r={r} />)}
      </div>
    </div>
  );
}

function LargeRow({ r }: { r: GenesisLargeAllocation }) {
  const W = COHORT_WORDS.large;
  const plain = ALLOC_PLAIN[r.cohort as AllocCategory] ?? r.cohort;
  const left = r.shieldedOutNam > 0 || r.sentTo.length > 0;
  return (
    <div className="sp-coh__lrow" role="row">
      <span role="cell" className="sp-coh__who">
        <span className="sp-coh__addr"><AddrName address={r.address} label={r.labelPlain} withAddr source={r.labelSource} /></span>
        <span className="sp-coh__sub">{plain} · {W.atGenesis(fmtNamRule(r.allocNam))}</span>
      </span>
      <span role="cell" className="sp-coh__holds">
        {r.spendableNam != null && r.stakedNam != null ? (
          <>
            <span><Num v={r.spendableNam} fmt={fmtNamRule} unit="NAM" /> {W.spendable}</span>
            <span><Num v={r.stakedNam} fmt={fmtNamRule} unit="NAM" /> {W.staked}</span>
          </>
        ) : (
          <span className="cap">{W.notIndexed}</span>
        )}
      </span>
      <span role="cell" className="sp-coh__left">
        {!left ? <span className="cap">{W.none}</span> : null}
        {r.shieldedOutNam > 0 ? <span>{W.shielded(fmtNamRule(r.shieldedOutNam), `${fmtCount(r.shieldedMoves)} ${r.shieldedMoves === 1 ? 'move' : 'moves'}`)}</span> : null}
        {r.sentTo.map((s) => (
          <span key={s.address} className="sp-coh__sent">
            <Num v={s.nam} fmt={fmtNamRule} unit="NAM" /> {W.sentTo} <AddrName address={s.address} label={s.labelPlain} withAddr source={s.labelSource} className="xaddr--sm" />
            {s.sentOnTo != null ? <span className="sp-coh__on"> ({W.sentOn(`${fmtCount(s.sentOnTo)} ${s.sentOnTo === 1 ? 'address' : 'addresses'}`, s.sentOnCut)})</span> : null}
          </span>
        ))}
        {r.sentToMore.addrs > 0 ? <span className="cap">{W.more(fmtNamRule(r.sentToMore.nam), `${fmtCount(r.sentToMore.addrs)} ${r.sentToMore.addrs === 1 ? 'address' : 'addresses'}`)}</span> : null}
        {r.movesCut ? <span className="cap">{W.cut(fmtCount(r.movesRead))}</span> : null}
      </span>
    </div>
  );
}
