// "How NAM gets from a wallet to a sale" (system.md 9.1 item 5, 10 "How NAM reaches the market"): the
// second yellow field. A lead in plain words (BODY.home, second paragraph), four steps on a rail
// that draws as you scroll (Staked, Unlocked, Bridged, Sold), each with its one real number and a
// ProvDot, then the explore panel (drag an order size over the six real quotes; when the size table
// comes back empty it says so with its SourceLine, never a skeleton that waits forever), the shielded
// side note, and links to the explainer pages.
//
// The phone cut (platform plan, release E; owner-decisions row 42): under 1024 px the section shows its lead and its
// first step, and one closed line holds the other three steps, the explore panel, the side note and the links (all of
// it stays in the DOM: the size table is asked for once either way). From 1024 px the four steps are one list on one
// rail and nothing is folded, as before.
import { useEffect, useRef, type ReactNode } from 'react';
import type { Overview, Pressure, QuoteCurveResponse } from '../../../../shared/types';
import { BODY } from '../../../../shared/copy';
import { routeById } from '../../../../shared/routes';
import { REWIND_WORDS } from '../../app/index';
import { Derived, Icon, Notice, Num, OrderSizeCurve, ProvDot, SkeletonBlock, SourceLine, Term, useMinWidth } from '../../ui/index';
import type { Stamp } from '../../lib/prov';
import { fmtCount, fmtNamRule, fmtPctRule } from '../../lib/format';
import type { Res } from './data';
import { FOLD_UNDER_PX, MoreLink, NoData, PhoneFold, StepRing } from './bits';

export interface PathProps {
  o: Overview | null;
  supplyP: Stamp | null;
  pressure: Res<Pressure>;
  waitP: Stamp | null;
  curve: Res<QuoteCurveResponse>;
  curveP: Stamp | null;
  /** The listed size the fourth step quotes (the smallest alert size when the size table lists it). */
  stepSize: number | null;
  rewound: boolean;
  /** The overview never answered: "—" and "no data" where the staked figure would wait. */
  failed?: boolean;
  why?: string | null;
}

/** "13.75" days; whole days without decimals. */
export const daysText = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, ''));

const LEARN = ['learn', 'staking', 'osmosis', 'faq'] as const;
/** The closed line the rest of the path sits behind under 1024 px. */
const REST_OF_PATH = 'The next three steps, to the sale';

/**
 * The rail's length as CSS variables on the box (--rail-h for the vertical rail on phones, --rail-w for
 * the horizontal one from 900 px), so the travelling NAM moves by transform only and ends on the last ring.
 */
function useRailSize() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      el.style.setProperty('--rail-h', `${Math.max(0, Math.round(r.height - 28))}px`);
      el.style.setProperty('--rail-w', `${Math.max(0, Math.round(r.width - 14))}px`);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return ref;
}

/** A list of steps on its rail, with the NAM that travels it as you scroll (never a loop; hidden under reduced motion). */
function StepsBox({ start, children }: { start?: number; children: ReactNode }) {
  const railRef = useRailSize();
  return (
    <div className="steps-box" ref={railRef}>
      <span className="steps__nam" aria-hidden="true" />
      <ol className="steps" start={start}>{children}</ol>
    </div>
  );
}

export function Path({ o, supplyP, pressure, waitP, curve, curveP, stepSize, rewound, failed, why }: PathProps) {
  const wide = useMinWidth(FOLD_UNDER_PX);
  const s = o?.supply;
  const pr = pressure.data;
  const point = stepSize != null ? curve.data?.curve.find((p) => p.amountNam === stepSize) ?? null : null;
  const move = point?.sellImpactPct != null ? Math.abs(point.sellImpactPct) : null;
  const moveP: Stamp | null = rewound
    ? { source: 'size table', plain: 'Size table', at: null, status: 'missing', note: REWIND_WORDS.quotes }
    : curveP && point && move == null
      ? { ...curveP, status: 'missing', note: `The size table has no selling quote for ${fmtNamRule(stepSize)} NAM right now.` }
      : curveP;
  const pressP = pr?.coverage ?? null;
  // a request that never answered: the em dash carries a stamp that says so (never a skeleton that waits forever)
  const noSupplyP: Stamp | null = !o && failed ? { source: 'Namada RPC abci_query', plain: 'Namada node', at: null, status: 'missing', note: why ?? 'The data service did not answer.' } : null;
  const noPressP: Stamp | null = !pr && pressure.error ? { source: 'D1 flow index', plain: 'Flow index', at: null, status: 'missing', note: pressure.error } : null;
  const noWaitP: Stamp | null = !pr && pressure.error ? { source: 'Namada chain parameters', plain: 'Chain parameter', at: null, status: 'missing', note: pressure.error } : null;
  // The size table answered with no sizes (the quote service had no price), or never answered: nothing to drag.
  const emptyCurve = curve.data != null && !curve.data.curve.length;
  const noCurve = rewound || emptyCurve || (curve.data == null && curve.error != null);

  // ---- the four steps, each with its one real number
  const staked = (
    <li className="step" key="staked">
      <StepRing />
      <div className="step__body" data-prov-group="">
        <p className="step__k"><span className="step__i">1</span><Term id="staked">Staked</Term></p>
        <p className="step__copy">Staked NAM is locked with validators and can’t be sold.</p>
        <p className="step__fig">
          {o ? <Num v={s?.bonded} prov={supplyP} fmt={fmtNamRule} showAge={false} showReason={false} className="step__n" /> : noSupplyP ? <Num v={null} prov={noSupplyP} showReason={false} className="step__n" /> : <SkeletonBlock height={28} width="9ch" />}
          <span className="step__u">NAM</span>
        </p>
        <p className="step__note">
          {o && supplyP ? (
            <>
              {s?.bonded != null && s.total != null ? (
                <span>
                  <Derived inputs={[{ value: s.bonded, prov: supplyP }, { value: s.total, prov: supplyP }]} label="staked NAM / all NAM" name="Share of NAM that is staked" compute={(a, b) => (a / b) * 100} fmt={(n) => fmtPctRule(n, 1)} showAge={false} /> of all NAM
                </span>
              ) : (
                <span>{supplyP.note ?? 'Staked NAM has no value right now.'}</span>
              )}
              <ProvDot p={supplyP} label="Staked NAM" />
            </>
          ) : noSupplyP ? (
            <>
              <span>did not load</span>
              <ProvDot p={noSupplyP} label="Staked NAM" />
            </>
          ) : null}
        </p>
      </div>
    </li>
  );

  const unlocked = (
    <li className="step" key="unlocked">
      <StepRing />
      <div className="step__body" data-prov-group="">
        <p className="step__k"><span className="step__i">2</span><Term id="unlocked">Unlocked</Term></p>
        <p className="step__copy">
          Asking to unstake starts a wait of about {pr?.unbondingDays != null ? daysText(pr.unbondingDays) : '—'} days.
        </p>
        <p className="step__fig">
          {pr ? <Num v={pr.unbondingDays} prov={waitP} fmt={daysText} showAge={false} className="step__n" /> : noWaitP ? <Num v={null} prov={noWaitP} showReason={false} className="step__n" /> : <SkeletonBlock height={28} width="5ch" />}
          <span className="step__u">days</span>
        </p>
        <p className="step__note">
          <span>the unstaking wait</span>
          {pr ? <ProvDot p={waitP} label="Unstaking wait" /> : noWaitP ? <ProvDot p={noWaitP} label="Unstaking wait" /> : null}
        </p>
      </div>
    </li>
  );

  const bridged = (
    <li className="step" key="bridged">
      <StepRing />
      <div className="step__body" data-prov-group="">
        <p className="step__k"><span className="step__i">3</span><Term id="bridged">Bridged</Term></p>
        <p className="step__copy">To be sold, NAM crosses to Osmosis. Crossings usually come before sales.</p>
        <p className="step__fig">
          {pr ? <Num v={pr.ibcIn7d} prov={pressP} fmt={fmtNamRule} showAge={false} className="step__n" /> : noPressP ? <Num v={null} prov={noPressP} showReason={false} className="step__n" /> : <SkeletonBlock height={28} width="7ch" />}
          <span className="step__u">NAM</span>
        </p>
        <p className="step__note">
          <span>crossed to Osmosis in the last {pr ? fmtCount(pr.windowDays) : '—'} days</span>
          {pr ? <ProvDot p={pressP} label="NAM that crossed to Osmosis" /> : noPressP ? <ProvDot p={noPressP} label="NAM that crossed to Osmosis" /> : null}
        </p>
      </div>
    </li>
  );

  const sold = (
    <li className="step" key="sold">
      <StepRing />
      <div className="step__body" data-prov-group="">
        <p className="step__k"><span className="step__i">4</span>Sold</p>
        <p className="step__copy">
          On Osmosis, NAM trades in <Term id="thin-market">small pools</Term>.{' '}
          {stepSize != null && move != null ? <>An order of {fmtNamRule(stepSize)} NAM moves the price {fmtPctRule(move, 2)}. </> : null}
          {noCurve ? null : 'Drag the size below.'}
        </p>
        <p className="step__fig">
          {rewound || curve.data || curve.error ? (
            <Num v={rewound ? null : move} prov={moveP} fmt={(n) => fmtPctRule(n, 2)} showAge={false} showReason={false} className="step__n" />
          ) : (
            <SkeletonBlock height={28} width="5ch" />
          )}
          <span className="step__u">price move</span>
        </p>
        <p className="step__note">
          <span>{stepSize != null ? `selling ${fmtNamRule(stepSize)} NAM` : 'selling'}</span>
          {moveP ? <ProvDot p={moveP} label="Price move by order size" /> : null}
        </p>
      </div>
    </li>
  );

  return (
    <section className="band ground-accent path" aria-labelledby="home-path">
      <div className="wrap">
        <p className="eyebrow">Four steps</p>
        <h2 id="home-path" className="h2">How NAM gets from a wallet to a sale</h2>
        <p className="lead path__lead">{BODY.home.paras[1]}</p>

        {/* phones: the first step, then one closed line for the rest; from 1024 px the four steps on one rail */}
        <StepsBox>{wide ? [staked, unlocked, bridged, sold] : staked}</StepsBox>

        <PhoneFold label={REST_OF_PATH} className="path__fold">
          {wide ? null : <StepsBox start={2}>{[unlocked, bridged, sold]}</StepsBox>}

          <div className="explore" data-prov-scope="">
            <h3 className="h3 explore__t">Drag an order size</h3>
            {rewound ? (
              <NoData>{REWIND_WORDS.quotes} The size table is read live, so it is not shown for a past moment.</NoData>
            ) : curve.data?.curve.length ? (
              <OrderSizeCurve points={curve.data.curve} prov={curveP} caption="Price move by order size, from the six real quotes" />
            ) : emptyCurve ? (
              <>
                <Notice tone="warning" title="The size table is empty.">
                  {curve.error ?? curve.data?.prov.note ?? 'The Osmosis quote service sent no sizes.'} No order size can be shown until it answers.
                </Notice>
                <SourceLine items={[{ label: 'Size table', p: curveP }]} label="Where the size table comes from" />
              </>
            ) : curve.error ? (
              <NoData>The size table is not available right now: {curve.error}</NoData>
            ) : (
              <span className="skel__b skel__block explore__wait" aria-hidden="true" />
            )}
          </div>

          <p className="sidenote" data-prov-group="">
            <Icon name="shield" className="gly gly--lg" />
            <span>
              Shielded NAM sits in a pool whose total is public and whose owners are not:{' '}
              {o && supplyP ? (
                <Derived as="b" inputs={[{ value: s?.shielded, prov: supplyP }, { value: s?.total, prov: supplyP }]} label="shielded NAM / all NAM" name="Share of NAM that is shielded" compute={(a, b) => (a / b) * 100} fmt={(n) => fmtPctRule(n, 1)} showAge={false} showReason={false} />
              ) : (
                '—'
              )}{' '}
              of all NAM.
            </span>
            {o && supplyP ? <ProvDot p={supplyP} label="Shielded NAM" /> : null}
          </p>

          <nav className="path__more" aria-label="Explainers">
            <p className="path__more-t">Read more, in plain words</p>
            <ul>
              {LEARN.map((id) => {
                const r = routeById(id);
                return (
                  <li key={id}>
                    <MoreLink to={r.path}>{r.label}</MoreLink>
                  </li>
                );
              })}
            </ul>
          </nav>
        </PhoneFold>
      </div>
    </section>
  );
}
