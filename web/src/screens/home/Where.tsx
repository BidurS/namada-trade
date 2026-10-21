// "Where is all the NAM?" (system.md 9.1 item 3, 10 "Where all NAM is"): the lead sentence, the
// supply bar with a legend that sums to 100 %, the escrow notice exactly when the bridge cross-check
// is not ok, and one SourceLine for the panel.
import type { Check, Overview } from '../../../../shared/types';
import { Derived, Notice, Num, SkeletonBlock, SupplyBar, SourceLine, derive } from '../../ui/index';
import type { Stamp } from '../../lib/prov';
import { NBSP, fmtNamRule, fmtPctRule, fmtUsdWhole } from '../../lib/format';
import { NoData } from './bits';

export interface WhereProps {
  o: Overview | null;
  supplyP: Stamp | null;
  osmoP: Stamp | null;
  /** The share's stamp: a gap of a few NAM does not move a one-decimal share, so it does not carry the disagree mark (system.md 2, red flags). */
  osmoShareP?: Stamp | null;
  bridgeCheck: Check | null;
  /** The overview never answered: one line says the supply figures did not load (no skeleton that waits forever). */
  failed?: boolean;
  why?: string | null;
}

const share1 = (n: number) => fmtPctRule(n, 1);
const lowerFirst = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);
/** The gap is tiny: two decimals would print 0.01 %, so a share under 0.1 % keeps three. */
const gapPct = (n: number) => fmtPctRule(n, n < 0.1 ? 3 : 2);

export function Where({ o, supplyP, osmoP, osmoShareP, bridgeCheck, failed, why }: WhereProps) {
  const s = o?.supply;
  const nam = (v: number | null | undefined, p: Stamp | null, status?: 'disagree') => <Num v={v} prov={p} fmt={fmtNamRule} unit="NAM" showAge={false} status={status} />;
  const disagree = osmoP?.status === 'conflict';
  // `unstaking` absent = a server before 2026-10-18, whose `bonded` was the whole staking account (stake and
  // the NAM on its way out together), so nothing is left over for the segment.
  const unstaking = s?.unstaking === undefined ? 0 : s.unstaking;
  const parts = s ? [s.bonded, unstaking, s.pgf, s.shielded, s.transparentLiquid, s.osmosis] : [];
  const complete = parts.length === 6 && parts.every((v) => v != null && Number.isFinite(v) && v >= 0);
  const needsLook = bridgeCheck != null && bridgeCheck.status !== 'ok';

  return (
    <section className="sec" aria-labelledby="home-where" data-prov-scope="">
      <h2 id="home-where" className="h2">Where is all the NAM?</h2>
      {o && s && supplyP && osmoP ? (
        <>
          {s.osmosis != null && s.total != null ? (
            <p className="lead">
              Only{' '}
              <Derived as="b" inputs={[{ value: s.osmosis, prov: osmoShareP ?? osmoP }, { value: s.total, prov: supplyP }]} label="NAM on Osmosis / all NAM" name="Share of NAM on Osmosis" compute={(a, b) => (a / b) * 100} fmt={share1} showAge={false} />{' '}
              of NAM, <Num as="b" v={s.osmosis} prov={osmoP} fmt={fmtNamRule} unit="NAM" showAge={false} />, is held on Osmosis (wallets and pools), the one place it can be sold.
              {o.dex.liquidityUsd != null ? (
                <>
                  {' '}The pools there hold <Num as="b" v={o.dex.liquidityUsd} prov={o.dex.prov} fmt={fmtUsdWhole} showAge={false} />.
                </>
              ) : null}
            </p>
          ) : null}
          {complete ? (
            <SupplyBar
              segments={[
                { key: 'staked', name: 'Staked', short: 'Staked', nam: s.bonded, namNode: nam(s.bonded, supplyP), note: 'locked with validators, cannot be sold' },
                ...(s.unstaking === undefined ? [] : [{ key: 'unstaking' as const, name: 'Leaving staking', short: 'Leaving', nam: unstaking, namNode: nam(unstaking, supplyP), note: 'unstaking, ready to withdraw or unclaimed rewards; part can be withdrawn and sold now' }]),
                { key: 'pgf', name: 'Public funding', nam: s.pgf, namNode: nam(s.pgf, supplyP), note: 'held for public goods' },
                { key: 'shielded', name: 'Shielded', nam: s.shielded, namNode: nam(s.shielded, supplyP), note: 'total public, owners not' },
                { key: 'rest', name: 'Everything else spendable', short: 'Spendable', nam: s.transparentLiquid, namNode: nam(s.transparentLiquid, supplyP), note: 'could be bridged and sold' },
                { key: 'osmosis', name: 'On Osmosis', nam: s.osmosis, namNode: nam(s.osmosis, osmoP, disagree ? 'disagree' : undefined), note: 'held on Osmosis (wallets and pools)' },
              ]}
            />
          ) : (
            <NoData>Where the NAM sits is not shown: {(supplyP.status === 'missing' ? supplyP.note : osmoP.note) ?? 'a part of the split has no value right now.'}</NoData>
          )}
          {needsLook && s.ibcEscrow != null && s.osmosis != null ? (
            <Notice
              tone="warning"
              title={
                <>
                  Two sources,{' '}
                  <Derived inputs={[{ value: s.ibcEscrow, prov: supplyP }, { value: s.osmosis, prov: osmoP }]} label="escrow on Namada minus the Osmosis count" name="Gap between the two sources" compute={(a, b) => Math.abs(a - b)} fmt={fmtNamRule} showAge={false} />{' '}
                  NAM apart.
                </>
              }
            >
              <p>
                Namada holds <Num v={s.ibcEscrow} prov={supplyP} fmt={fmtNamRule} showAge={false} />{NBSP}NAM in its bridge escrow, for Osmosis and every other chain it bridges to. Osmosis counts{' '}
                <Num v={s.osmosis} prov={osmoP} fmt={fmtNamRule} showAge={false} />. The gap is{' '}
                <Derived inputs={[{ value: s.ibcEscrow, prov: supplyP }, { value: s.osmosis, prov: osmoP }]} label="gap / NAM on Osmosis" name="Gap as a share of NAM on Osmosis" compute={(a, b) => (Math.abs(a - b) / b) * 100} fmt={gapPct} showAge={false} /> of what
                is on Osmosis, and one of the cross-checks that needs a look.
              </p>
            </Notice>
          ) : null}
          <SourceLine
            items={[
              { label: 'Staked, leaving staking, public funding, shielded, spendable and all NAM', p: supplyP },
              { label: 'NAM on Osmosis', p: osmoP },
              { label: 'Money in the Osmosis pools', p: o.dex.prov },
              ...(needsLook ? [{ label: 'Bridge cross-check', p: derive([supplyP, osmoP], 'escrow on Namada compared with the Osmosis count') }] : []),
            ]}
            label="Where the supply figures come from"
          />
        </>
      ) : failed ? (
        <NoData>The supply figures did not load: {lowerFirst(why ?? 'The data service did not answer.')}</NoData>
      ) : (
        <>
          <p className="lead"><SkeletonBlock height={78} /></p>
          <SkeletonBlock height={120} className="where__barwait" />
          <SkeletonBlock height={300} className="where__legwait" />
        </>
      )}
    </section>
  );
}
