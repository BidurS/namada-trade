// "Who holds NAM" (system.md 9.1 item 4, 10 "Who holds NAM"): the lead, the age sentence (and
// "No balance here changed in the last 7 days." only when every 7-day change is a real zero from a
// balance read in the last 6 hours: a list read days ago cannot say what changed since, so it says the
// changes are not known), ten two-line rows with no chip per row, a category tag only when it adds
// information, the row that differs from its scope carrying its own mark, one SourceLine, and the link
// to every holder.
import type { Holder, HoldersResponse, Overview } from '../../../../shared/types';
import { LIQUID_STALE_MS } from '../../../../shared/holder-status';
import { DataList, HolderRow, Num, ProvDot, Skeleton, Tag, derive } from '../../ui/index';
import type { Stamp } from '../../lib/prov';
import { REWIND_WORDS, useNow, useOverlays } from '../../app/index';
import { fmtAddr, fmtAge, fmtAgo, fmtCount, fmtNamRule, fmtPctRule } from '../../lib/format';
import { holderName, holderTag, isUserTag } from '../../lib/holder';
import type { Res } from './data';
import { MoreLink, NoData, OldLine } from './bits';

export interface HoldersProps {
  o: Overview | null;
  at: number | null;
  holders: Res<HoldersResponse>;
  supplyP: Stamp | null;
  /**
   * The stamp of the holder count and the top-10 share: the age of the balances behind them
   * (activity/holderStamp.ts, the same rule and so the same age as /holders), never the flow index's.
   */
  countP: Stamp | null;
  /** The overview never answered: the share is said to be not available (no skeleton that waits forever). */
  failed?: boolean;
}

const ageSpan = (ats: number[], now: number): string => {
  const young = fmtAge(now - Math.max(...ats));
  const old = fmtAge(now - Math.min(...ats));
  return young === old ? old : `${young} to ${old}`;
};

/**
 * What the list can say about 7-day changes (Home shows no change column). A zero counts only when the
 * balance was read from the chain in the last 6 hours (owner decision 7): an older reading cannot show
 * what changed since it. `null` says nothing (some balance did change, or there are no rows).
 */
export function sevenDaySentence(rows: Pick<Holder, 'change7d' | 'verifiedAt'>[], now: number): string | null {
  if (!rows.length || rows.some((h) => h.change7d != null && h.change7d !== 0)) return null;
  const known = rows.filter((h) => h.change7d === 0 && h.verifiedAt != null && now - h.verifiedAt <= LIQUID_STALE_MS).length;
  if (known === rows.length) return 'No balance here changed in the last 7 days.';
  if (!known) return 'Changes over 7 days are not known for these balances.';
  return `${fmtCount(known)} of these balances did not change in the last 7 days; for the other ${fmtCount(rows.length - known)} the change is not known.`;
}

export function Holders({ o, at, holders, supplyP, countP, failed }: HoldersProps) {
  const wall = useNow(); // holder balances are current even under Rewind: their age is measured from the wall clock
  const { openAddress } = useOverlays();
  const rows = holders.data?.holders ?? [];
  const status = rows.map((h) => h.status);
  const balancesOld = rows.length > 0 && status.every((s) => s === 'stale' || s === 'conflict');
  // the rows are a kept earlier answer (their refresh failed, or the page stopped refreshing): old as well
  const kept = rows.length > 0 && !!holders.old;
  const listOld = balancesOld || kept;
  const reads = rows.map((h) => h.verifiedAt ?? h.updatedAt).filter((t): t is number => t != null);
  const stakeReads = rows.map((h) => h.bondedVerifiedAt).filter((t): t is number => t != null);
  const balancesP: Stamp = {
    source: 'NamadaTrade holder index',
    plain: 'Holder index',
    at: reads.length ? Math.min(...reads) : null,
    status: !reads.length ? 'missing' : listOld ? 'stale' : 'live',
    note: balancesOld ? 'Spendable balances are re-read from the chain on a schedule; these were read longer ago than 6 hours.' : kept ? holders.oldWhy : undefined,
  };
  const stakeP: Stamp = { source: 'Namada nodes', plain: 'Namada nodes', at: stakeReads.length ? Math.min(...stakeReads) : null, status: stakeReads.length ? 'live' : 'missing' };
  const top10P = supplyP && o && countP ? derive([countP, supplyP], 'the ten largest balances / all NAM') : null;
  // A list whose balances were all read longer ago than 6 hours folds the 7-day words into its one age sentence.
  const spendOld = rows.length > 0 && rows.every((h) => h.verifiedAt == null || wall - h.verifiedAt > LIQUID_STALE_MS);
  const foldIn = balancesOld && spendOld && reads.length > 0;
  const sentence7 = foldIn ? null : sevenDaySentence(rows, wall);
  const top = rows.length ? Math.max(...rows.map((h) => h.total)) : 0;

  return (
    <section className="sec" aria-labelledby="home-who" data-prov-scope="">
      <h2 id="home-who" className="h2">Who holds NAM</h2>
      {(o && o.concentration.namadaTop10Pct == null) || (!o && failed) ? (
        <>
          <p className="lead">Protocol accounts are excluded. Shielded NAM cannot be attributed to anyone.</p>
          <NoData>The share the ten biggest holders own is {o && at != null ? 'not recorded for that moment' : 'not available right now'}.</NoData>
        </>
      ) : (
        <p className="lead">
          The 10 biggest holders own{' '}
          {o && top10P ? <Num as="b" v={o.concentration.namadaTop10Pct} prov={top10P} fmt={(n) => fmtPctRule(n, 1)} showAge={false} /> : <b className="skel__b holders__pwait" aria-hidden="true" />} of NAM on Namada.
          Protocol accounts are excluded. Shielded NAM cannot be attributed to anyone.
        </p>
      )}

      {holders.data == null ? (
        holders.error ? <NoData>The holder list is not available right now: {holders.error}</NoData> : <Skeleton rows={10} heights={[64]} label="the ten biggest holders" />
      ) : (
        <>
          <div className="hl__sentence">
            {at != null ? <OldLine>{REWIND_WORDS.balances(at)}</OldLine> : null}
            {sentence7 ? <p>{sentence7}</p> : null}
            {kept && !balancesOld ? (
              <OldLine>The latest refresh of the holder list did not answer, so it is the list fetched {fmtAgo(holders.fetchedAt, wall)}, and it is shown dimmed.</OldLine>
            ) : listOld && reads.length ? (
              <OldLine>Balances were last checked {ageSpan(reads, wall)} ago, so they are shown dimmed{foldIn ? ' and their changes over 7 days are not known' : ''}.</OldLine>
            ) : null}
          </div>
          <DataList
            kind="holders"
            label="Ten biggest NAM holders"
            old={listOld}
            scope={[
              { label: 'Spendable balances', p: balancesP },
              { label: 'Staked NAM, read from the chain', p: stakeP },
              ...(supplyP ? [{ label: 'Share of all NAM', p: derive([balancesP, supplyP], 'balance / all NAM') }] : []),
              ...(top10P ? [{ label: 'Share held by the ten biggest', p: top10P }] : []),
              ...(o && countP ? [{ label: 'Holders on Namada', p: countP }] : []),
            ]}
            scopeLabel="Where the holder figures come from"
          >
            {rows.map((h, i) => (
              <Row key={h.address} h={h} st={status[i]} listOld={listOld} top={top} onOpen={() => openAddress(h.address)} />
            ))}
          </DataList>
        </>
      )}
      <p className="more">
        <MoreLink to="/holders">
          {o && countP ? <>All <Num v={o.namada.holders} fmt={fmtCount} showAge={false} prov={countP} /> holders</> : 'All holders'}
        </MoreLink>
      </p>
    </section>
  );
}

function Row({ h, st, listOld, top, onOpen }: { h: Holder; st: string; listOld: boolean; top: number; onOpen: () => void }) {
  const name = holderName(h);
  const tag = holderTag(h);
  const linked = h.linked?.length ?? 0;
  const differ = st === 'conflict' && h.bonded != null && h.bondedEstimated != null;
  const rowOld = !listOld && st === 'stale';
  const mark: Stamp | null = differ
    ? {
        source: 'Namada nodes',
        plain: 'Namada nodes',
        at: h.bondedVerifiedAt,
        status: 'conflict',
        note: h.statusNote ?? 'The stake has no recent reading from the chain, and the estimate from staking history differs from the last reading.',
        extra: [
          ['Staked, read from the chain', `${fmtNamRule(h.bonded)} NAM`],
          ['Staked, estimated from history', `${fmtNamRule(h.bondedEstimated)} NAM`],
        ],
      }
    : null;
  return (
    <HolderRow
      rank={h.rank}
      name={
        <button type="button" className="hrow__open" aria-haspopup="dialog" onClick={onOpen} aria-label={`${name ?? fmtAddr(h.address)}: open this address`}>
          {name ?? fmtAddr(h.address)}
        </button>
      }
      sub={
        <>
          {name ? fmtAddr(h.address) : 'no label'}
          {linked ? ` · +${fmtCount(linked)} linked on Osmosis` : ''}
        </>
      }
      // a wallet's own tag: its byline, without the ring of a curated category
      tags={tag ? <Tag cat={tag} ring={!isUserTag(h)} /> : null}
      // in a list that is old as a whole the figures say so too (dimmed once by the list, no underline per row)
      total={<Num v={h.total} fmt={fmtNamRule} unit="NAM" status={rowOld || listOld ? 'old' : undefined} showAge={false} />}
      share={<Num v={h.pctSupply} fmt={(n) => fmtPctRule(n, 2)} unit="of supply" status={listOld ? 'old' : undefined} showAge={false} />}
      exception={mark && h.bonded != null && h.bondedEstimated != null ? <ProvDot p={mark} label="Staked NAM, two readings" text={`staked figures differ by ${fmtNamRule(Math.abs(h.bonded - h.bondedEstimated))} NAM`} wrap /> : null}
      bar={top > 0 ? h.total / top : null}
    />
  );
}
