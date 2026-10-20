// "What changed in the last 24 hours" (system.md 9.1 item 2): alert hits in rule words (up to
// three, then "{n} more"), or the empty state with the alert size in dollars and the last hit with a
// rewind link; then Latest moves: six rows of 1,000 NAM or more, newest first, one SourceLine, dimmed
// once when the flow index is old. Rows that arrive through the live stream animate in; rows on load never do.
import { useMemo } from 'react';
import type { AlertRuleInfo, Flow, FlowsResponse, Overview, Provenance } from '../../../../shared/types';
import type { AlertsWithLast } from '../../api';
import { alertRules } from '../../../../shared/alerts';
import { DataList, EmptyState, MoveRow, Num, Skeleton, SourceLine, Tag, derive, useUiNow } from '../../ui/index';
import { ageOutStamps, type Stamp } from '../../lib/prov';
import { tagKindOf } from '../../lib/kinds';
import { NBSP, fmtAddr, fmtAge, fmtAgo, fmtCount, fmtNamRule, fmtNamSigned, fmtUsdRule, labelNeedsAddr } from '../../lib/format';
import { tagByline } from '../../../../shared/labels';
import { MOVES_MIN_NAM, MOVES_SHOWN, crossingWords, hitKind, hitPage, latestMoves, moveSign, partyOf, partyText, type Res } from './data';
import { MoreLink, NoData, OldLine } from './bits';

const PLAIN_RULE: Record<string, string> = Object.fromEntries(alertRules().map((r) => [r.id, r.title]));

export interface ChangedProps {
  o: Overview | null;
  at: number | null;
  alerts: Res<AlertsWithLast>;
  rules: Res<{ rules: AlertRuleInfo[] }>;
  flows: Res<FlowsResponse>;
  /** Streamed flows (live only), newest first, and which of them came through the stream. */
  liveFlows: Flow[];
  streamedIds: ReadonlySet<string>;
  priceP: Stamp | null;
  /** The overview never answered: the scopes say "no data" with the reason. */
  failed?: boolean;
  why?: string | null;
}

/** The flow index's coverage, as a stamp that says it is not known (the overview never answered). */
const noCoverage = (why: string | null | undefined): Stamp => ({ source: 'D1 flow index', plain: 'Flow index', at: null, status: 'missing', note: why ?? 'The data service did not answer.' });

export function Changed({ o, at, alerts, rules, flows, liveFlows, streamedIds, priceP, failed, why }: ChangedProps) {
  const now = useUiNow();
  const hits = alerts.data?.hits ?? [];
  const last = alerts.data?.last;
  const sizes = (rules.data?.rules ?? []).map((r) => r.thresholdNam).filter((n) => Number.isFinite(n) && n > 0);
  const minAlert = sizes.length ? Math.min(...sizes) : null;
  const price = o?.price.usd ?? null;
  // the hits' scope: the flow index's coverage, read old too when the hits themselves are a kept earlier answer
  const hitItems = o
    ? [{ label: 'Alert hits on Osmosis (the rules run on every recorded move)', p: o.dex.coverage as Stamp }, { label: 'Alert hits on Namada (the rules run on every recorded move)', p: o.namada.coverage as Stamp }]
    : failed
      ? [{ label: 'Alert hits (the rules run on every recorded move)', p: noCoverage(why) }]
      : null;
  const hitScope = hitItems && alerts.old && alerts.oldWhy ? ageOutStamps(hitItems, alerts.oldWhy) : hitItems;

  return (
    <section className="sec" aria-labelledby="home-changed">
      <h2 id="home-changed" className="h2">What changed in the last 24 hours</h2>

      {alerts.data != null && alerts.old ? <OldLine>{refreshedAgo('alert hits', alerts.fetchedAt, now)}</OldLine> : null}
      {alerts.data == null ? (
        alerts.error ? <NoData>Alert hits are not available right now: {alerts.error}</NoData> : <Skeleton rows={1} heights={[176]} label="alert hits" className="changed__wait" />
      ) : hits.length ? (
        <div className={`hits${alerts.old ? ' is-old' : ''}`} data-prov-scope="">
          <ol className="hits__list">
            {hits.slice(0, 3).map((h) => {
              const k = hitKind(h);
              return (
                <li key={`${h.ruleId}-${h.flowId}`} className="hit">
                  <span className="hit__t">{PLAIN_RULE[h.ruleId] ?? 'Alert'}</span>
                  <span className="hit__n" data-num="" data-status={alerts.old ? 'old' : 'fresh'}>{fmtNamRule(h.amountNam)}<span className="u">{NBSP}NAM</span></span>
                  <span className="hit__c">
                    {k ? <Tag kind={k} /> : null}
                    <span>{fmtAgo(h.ts, now)}{h.address ? <> · <span className="mono">{fmtAddr(h.address)}</span></> : null}</span>
                  </span>
                </li>
              );
            })}
          </ol>
          {hitScope ? <SourceLine items={hitScope} label="Where the alert hits come from" /> : null}
          {hits.length > 3 ? <p className="more"><MoreLink to="/alerts">{fmtCount(hits.length - 3)} more</MoreLink></p> : null}
        </div>
      ) : (
        <EmptyState
          title="Nothing crossed an alert size in 24 hours."
          last={
            last ? (
              <>
                <span>The last one:</span>
                {hitKind(last) ? <Tag kind={hitKind(last)!} /> : <Tag cat={PLAIN_RULE[last.ruleId] ?? 'Alert'} />}
                <span>{fmtNamRule(last.amountNam)}{NBSP}NAM, {fmtAgo(last.ts, now)}.</span>
              </>
            ) : last === null ? (
              // how far the search for the last one went (api.ts AlertsWithLast): only a full search may say "none on record"
              alerts.data.lastUnknown ? (
                <span>The last alert could not be read.</span>
              ) : alerts.data.lastSearchedMs ? (
                <span>No alert in the last {fmtCount(Math.round(alerts.data.lastSearchedMs / 86_400_000))}{NBSP}days.</span>
              ) : (
                <span>No earlier alert is on record.</span>
              )
            ) : null
          }
          rewindHref={last ? `${hitPage(last)}?at=${last.ts + 1}` : undefined}
        >
          {minAlert != null && price && priceP ? (
            <p>
              Alert sizes are small on purpose: at {at == null ? 'today’s' : 'that day’s'} price {fmtNamRule(minAlert)}{NBSP}NAM is{' '}
              <Num
                v={price.value != null ? minAlert * price.value : null}
                prov={derive([priceP], 'smallest alert size x NAM price')}
                label="Smallest alert size in dollars"
                fmt={fmtUsdRule}
                stamp="dot"
                showAge={false}
              />
            </p>
          ) : rules.error ? (
            <p>The alert sizes did not answer, so their dollar value is not shown.</p>
          ) : null}
        </EmptyState>
      )}

      <Moves o={o} flows={flows} liveFlows={liveFlows} streamedIds={streamedIds} live={at == null} failed={!!failed} why={why} />
    </section>
  );
}

function Moves({ o, flows, liveFlows, streamedIds, live, failed, why }: { o: Overview | null; flows: Res<FlowsResponse>; liveFlows: Flow[]; streamedIds: ReadonlySet<string>; live: boolean; failed: boolean; why?: string | null }) {
  const now = useUiNow();
  const rows = useMemo(() => latestMoves([...(live ? liveFlows.filter((f) => streamedIds.has(f.id)) : []), ...(flows.data?.flows ?? [])]).slice(0, MOVES_SHOWN), [flows.data, liveFlows, streamedIds, live]);

  const cov: Provenance[] = o ? [o.dex.coverage, o.namada.coverage] : [];
  const oldest = cov.length ? cov.reduce((a, p) => ((p.at ?? 0) < (a.at ?? 0) ? p : a)) : null;
  const indexOld = cov.length > 0 && cov.every((p) => p.status === 'stale');
  // the rows are a kept earlier answer (their refresh failed, or the page stopped refreshing): old, said once
  const kept = flows.data != null && !!flows.old;
  const isOld = indexOld || kept;
  const scopeCov = o ? [{ label: 'Moves on Osmosis', p: o.dex.coverage as Stamp }, { label: 'Moves on Namada', p: o.namada.coverage as Stamp }] : failed ? [{ label: 'Moves', p: noCoverage(why) }] : undefined;
  const scope = scopeCov && kept && flows.oldWhy ? ageOutStamps(scopeCov, flows.oldWhy) : scopeCov;

  return (
    <div className="tape">
      <div className="tape__h">
        <h3 className="h3">
          Latest moves <span className="h3__s">{fmtNamRule(MOVES_MIN_NAM)} NAM or more, newest first</span>
        </h3>
      </div>
      {flows.data == null && !rows.length ? (
        flows.error ? <NoData>Moves are not available right now: {flows.error}</NoData> : <Skeleton rows={MOVES_SHOWN} heights={[64]} label="the latest moves" />
      ) : (
        <>
          {kept ? <OldLine>{refreshedAgo('moves', flows.fetchedAt, now)}</OldLine> : indexOld && o ? <OldLine>{indexCheckedSentence(o, now)}</OldLine> : null}
          <DataList
            kind="moves"
            label="Latest moves of 1,000 NAM or more"
            old={isOld}
            scope={scope}
            scopeLabel="Where the moves come from"
          >
            {rows.length ? (
              rows.map((f, i) => <Move key={f.id} f={f} i={i} fresh={live && streamedIds.has(f.id)} now={now} old={isOld} />)
            ) : (
              <p className="tape__none" role="row"><span role="cell">No move of {fmtNamRule(MOVES_MIN_NAM)} NAM or more is on record{oldest?.at ? ` in the index up to ${fmtAge(now - oldest.at)} ago` : ''}.</span></p>
            )}
          </DataList>
        </>
      )}
      <p className="more">
        <MoreLink to="/activity">All activity</MoreLink>
      </p>
    </div>
  );
}

function Move({ f, i, fresh, now, old }: { f: Flow; i: number; fresh: boolean; now: number; old: boolean }) {
  const sign = moveSign(f);
  const where = crossingWords(f);
  const party = partyOf(f);
  const toward = f.kind === 'unshield' || f.kind === 'withdraw' ? 'to ' : f.kind === 'shield' ? 'from ' : f.kind === 'unbond' || f.kind === 'bond' ? 'by ' : '';
  return (
    <MoveRow
      no={i + 1}
      fresh={fresh}
      // a crossing is named by where the NAM went (lib/kinds.ts), the same word as on Activity
      tag={<Tag kind={tagKindOf(f.kind, f.chain)} />}
      amount={<Num v={sign ? sign * f.amount : f.amount} fmt={sign ? fmtNamSigned : fmtNamRule} unit="NAM" showAge={false} status={old ? 'old' : undefined} />}
      caption={
        <>
          {fmtAgo(f.ts, now)}
          {where ? <> · {where}</> : null}
          {/* a shared genesis label names many addresses, so its short address follows; a wallet's own tag says who wrote it */}
          {party.address ? (
            <>
              {' · '}{toward}<span className={party.label ? undefined : 'mono'}>{partyText(party)}</span>
              {labelNeedsAddr(party.address, party.label) ? <> <span className="mono">{fmtAddr(party.address)}</span></> : null}
              {party.label && tagByline(party.source, party.author) ? <> ({tagByline(party.source, party.author)})</> : null}
            </>
          ) : null}
          {f.valueUsd != null && Number.isFinite(f.valueUsd) ? <> · worth{NBSP}{f.valueUsd >= 1 ? <Num v={f.valueUsd} fmt={fmtUsdRule} showAge={false} status={old ? 'old' : undefined} /> : `under${NBSP}$1`}</> : null}
        </>
      }
    />
  );
}

/** "The latest refresh of the moves did not answer, so these are from 3 min ago and are shown dimmed." */
function refreshedAgo(what: string, fetchedAt: number | null | undefined, now: number): string {
  return fetchedAt != null
    ? `The latest refresh of the ${what} did not answer, so these are from ${fmtAgo(fetchedAt, now)} and are shown dimmed.`
    : `The latest refresh of the ${what} did not answer, so these are an earlier answer and are shown dimmed.`;
}

/** When the flow index last checked each chain (its coverage stamps), said once above a dimmed list. */
function indexCheckedSentence(o: Overview, now: number): string {
  const part = (name: string, p: Provenance) => (p.at != null ? `${name} ${fmtAgo(p.at, now)}` : `${name} at no recorded time`);
  return `The flow index last checked ${part('Osmosis', o.dex.coverage)} and ${part('Namada', o.namada.coverage)}, so these rows are shown dimmed.`;
}
