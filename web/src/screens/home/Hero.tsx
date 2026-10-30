// Home hero (system.md 9.1 item 1, 10 "Eyebrow" to "Fact strip"): the yellow field with the
// dateline, the H1, the definition of NAM, the price as "One NAM costs" with its ProvChip and the
// 24 h pill, the two actions, the fact strip with its one SourceLine, and the ruler edge. From
// 640 px a 30-day executed-price sparkline sits under the price.
import type { Overview } from '../../../../shared/types';
import { SITE } from '../../../../shared/copy';
import { Link } from '../../app/index';
import { Derived, Fact, HeroNumber, Icon, Num, ProvChip, ProvDot, SNum, SkeletonBlock, Sparkline, fmtPriceNode } from '../../ui/index';
import type { Stamp } from '../../lib/prov';
import { fmtCount, fmtDateline, fmtDayMonth, fmtPctRule, fmtPctSigned, fmtUsdRule } from '../../lib/format';
import type { Res } from './data';
import { withOsmosisGap } from '../../../../shared/osmosis-gap';

export interface HeroProps {
  o: Overview | null;
  h1: string;
  at: number | null;
  spark: Res<{ ts: number; value: number }[]>;
  onSources: () => void;
  /** Supply stamps with plain reasons (see index.tsx). */
  supplyP: Stamp | null;
  osmoP: Stamp | null;
  /** The holder count's stamp: the age of the balances behind it (activity/holderStamp.ts), never the flow index's. */
  holdersP: Stamp | null;
  /** The overview never answered (useOverviewFailed): the em dash and "no data" where the skeletons would wait. */
  failed: boolean;
  /** Why, in plain words (the shell's bar under the header says it too). */
  why: string | null;
  /** The sparkline is requested and shown only from 640 px (index.tsx useMinWidth): below that nothing waits for it. */
  wide: boolean;
}

/** A stamp for a figure the overview would have sent, when it never answered. */
export const noOverview = (src: Pick<Stamp, 'source' | 'plain'>, why: string | null): Stamp => ({ ...src, at: null, status: 'missing', note: why ?? 'The data service did not answer.' });

const share1 = (n: number) => fmtPctRule(n, 1);

export function Hero({ o, h1, at, spark, onSources, supplyP, osmoP, holdersP, failed, why, wide }: HeroProps) {
  const price = o?.price.usd ?? null;
  const when = at ?? o?.generatedAt ?? null;
  const rewound = at != null;

  const pts = (spark.data ?? []).filter((r) => Number.isFinite(r.value) && r.value > 0).map((r) => ({ t: r.ts, v: r.value }));
  // The executed price's stamp comes with the overview. When the overview never answered, the line still carries a
  // stamp: the time of its last hourly price, marked old (whether the history is current is not checked).
  const lastPt = pts.length ? pts[pts.length - 1] : null;
  const lastP: Stamp | null =
    o?.price.swap1h.prov ??
    (lastPt
      ? { source: 'executed NAM/USDC swaps (hourly median)', plain: 'Executed swaps', at: lastPt.t, status: 'stale', note: 'The overview did not load, so whether this price history is current is not checked; the time is its last hourly price.' }
      : null);
  // the 30 days are counted from the stored Osmosis record: a first price before it is complete says so (shared/osmosis-gap.ts)
  const execP: Stamp | null = lastP && pts.length ? withOsmosisGap(lastP, pts[0].t) : lastP;

  return (
    <section className="band ground-accent hero" aria-labelledby="home-h1">
      <div className="wrap">
        <div className="hero__grid">
          <div className="hero__lead">
            <p className="eyebrow">
              NAM on Osmosis{when != null ? <> · {fmtDateline(when)}</> : failed ? null : <> · <span className="skel__b hero__wait" aria-hidden="true" /></>}
            </p>
            <h1 id="home-h1" className="h1">{h1}</h1>
            <p className="sub">{SITE.sub}</p>
          </div>

          <div className="price">
            {/* data-prov-group: the figures here share the price's ProvChip (or the line's ProvDot) as their own control */}
            <div data-prov-group="">
            {price ? (
              <HeroNumber
                label={rewound ? 'One NAM cost' : 'One NAM costs'}
                chip={<ProvChip p={price.prov} label="NAM price" />}
                value={<SNum s={price} fmt={fmtPriceNode} showAge={false} />}
                delta={{ v: o?.price.change24h, since: 'since this time yesterday', reason: rewound ? 'no figure for the day before' : 'no figure for this time yesterday' }}
              />
            ) : failed ? (
              <HeroNumber
                label={rewound ? 'One NAM cost' : 'One NAM costs'}
                chip={<ProvChip p={noOverview({ source: 'Osmosis SQS', plain: 'Osmosis quote' }, why)} label="NAM price" />}
                value={<Num v={null} prov={noOverview({ source: 'Osmosis SQS', plain: 'Osmosis quote' }, why)} showReason={false} />}
                delta={{ v: null, reason: 'no figure, the price did not load' }}
              />
            ) : (
              <div className="hero-n hero-n--display" aria-busy="true">
                <div className="hero-n__top">
                  <p className="hero-n__label">{rewound ? 'One NAM cost' : 'One NAM costs'}</p>
                  <span className="skel__b skel__chip" aria-hidden="true" />
                </div>
                <p className="hero-n__v"><SkeletonBlock height={64} width="8ch" className="hero__pwait" /></p>
                <p className="hero-n__meta"><span className="skel__b hero__dwait" aria-hidden="true" /></p>
              </div>
            )}
            </div>
            <div className="hero__spark" data-prov-group="">
              {pts.length >= 2 ? (
                <Sparkline points={pts} label={`Executed price, ${fmtUsdRule(pts[0].v)} on ${fmtDayMonth(pts[0].t)} to ${fmtUsdRule(pts[pts.length - 1].v)} on ${fmtDayMonth(pts[pts.length - 1].t)}`}>
                  {execP ? (
                    <>
                      <Derived
                        inputs={[{ value: pts[0].v, prov: execP }, { value: pts[pts.length - 1].v, prov: execP }]}
                        label="first and last hourly price of the 30 days"
                        name="Change in the executed price"
                        compute={(a, b) => ((b - a) / a) * 100}
                        fmt={(n) => fmtPctSigned(n, 0)}
                        showAge={false}
                      />
                      <span>since {fmtDayMonth(pts[0].t)}, executed price</span>
                      <ProvDot p={execP} label="Executed price" />
                    </>
                  ) : null}
                </Sparkline>
              ) : spark.error ? (
                <p className="spark__c"><i className="dot" data-status="none" aria-hidden="true" /> The 30-day price history did not answer.</p>
              ) : spark.data != null ? (
                // the history answered with fewer than two hourly prices: said, not a skeleton that waits forever
                <p className="spark__c"><i className="dot" data-status="none" aria-hidden="true" /> Too few executed trades in the last 30 days to draw the price.</p>
              ) : wide ? (
                <SkeletonBlock height={96} />
              ) : null}
            </div>
          </div>

          <div className="actions">
            <Link to="/trade" className="btn btn--primary">
              See what a trade costs
              <Icon name="arrow" className="ico ico--btn" />
            </Link>
            <button type="button" className="btn btn--secondary" aria-haspopup="dialog" onClick={onSources}>
              How we know
            </button>
          </div>
        </div>

        {o ? (
          <Fact
            className="hero__facts"
            sourceLabel="Where the three figures come from"
            items={[
              // the count is stamped with the age of the balances behind it (the same rule and age as /holders)
              holdersP
                ? { n: <Num v={o.namada.holders} prov={holdersP} fmt={fmtCount} showAge={false} />, label: 'holders on Namada', scope: { label: 'Holders on Namada', p: holdersP } }
                : { n: <span className="skel__b hero__fwait" aria-hidden="true" />, label: 'holders on Namada' },
              {
                n: <Derived inputs={[{ value: o.supply.shielded, prov: supplyP! }, { value: o.supply.total, prov: supplyP! }]} label="shielded NAM / all NAM" name="Share of NAM that is shielded" compute={(a, b) => (a / b) * 100} fmt={share1} showAge={false} showReason={false} />,
                label: 'shielded',
                scope: { label: 'Share of NAM that is shielded', p: supplyP },
              },
              {
                n: <Derived inputs={[{ value: o.supply.osmosis, prov: osmoP! }, { value: o.supply.total, prov: supplyP! }]} label="NAM on Osmosis / all NAM" name="Share of NAM on Osmosis" compute={(a, b) => (a / b) * 100} fmt={share1} showAge={false} showReason={false} />,
                label: 'on Osmosis',
                scope: { label: 'Share of NAM on Osmosis', p: osmoP },
              },
            ]}
          />
        ) : failed ? (
          <Fact
            className="hero__facts"
            sourceLabel="Where the three figures come from"
            items={[
              { label: 'holders on Namada', what: 'Holders on Namada', p: noOverview({ source: 'NamadaTrade holder index', plain: 'Holder index' }, why) },
              { label: 'shielded', what: 'Share of NAM that is shielded', p: noOverview({ source: 'Namada RPC abci_query', plain: 'Namada node' }, why) },
              { label: 'on Osmosis', what: 'Share of NAM on Osmosis', p: noOverview({ source: 'Osmosis bank', plain: 'Osmosis supply' }, why) },
            ].map(({ label, what, p }) => ({ n: <Num v={null} prov={p} showReason={false} />, label, scope: { label: what, p } }))}
          />
        ) : (
          <div className="scope-facts hero__facts" aria-busy="true">
            <ul className="facts">
              {['holders on Namada', 'shielded', 'on Osmosis'].map((l) => (
                <li key={l} className="fact">
                  <span className="fact__n"><span className="skel__b hero__fwait" aria-hidden="true" /></span>
                  <span className="fact__l">{l}</span>
                </li>
              ))}
            </ul>
            <p className="src"><span className="srcb srcb--wait" aria-hidden="true"><i className="dot" data-status="none" /><span className="skel__b hero__swait" /></span></p>
          </div>
        )}
      </div>
      <div className="ruler" aria-hidden="true" />
    </section>
  );
}
