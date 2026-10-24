// /staking: "How does staking NAM work, and what does it earn?" (seo-requirements "New pages").
// Band: the staked share (hero, ProvChip), the rate's caveat sentence, the staking rate and the
// unstaking wait (fact strip, one SourceLine). Evidence: what staking earns (validator
// commissions, live only), how long unstaking takes (NAM still in the wait), the words, and how
// much is staked (amount, all NAM, the recorded trend).
import type { ScreenProps } from '../../app/index';
import { useReplay } from '../../app/index';
import { BODY } from '../../../../shared/copy';
import { HeroNumber, Num, ProvChip, ProvDot, SkeletonBlock, Sparkline, Term, type Stamp } from '../../ui';
import { fetchIntel } from '../../api';
import { fmtDayMonth, fmtNamRule, fmtNamSigned, fmtPctRule, fmtUtcLong } from '../../lib/format';
import { Band, Dateline, Facts, Fig, FigList, GoLink, Hero, QSection, Related, Say, aprOf, fromOne, missing, noAnswer, ratio, unbondingOf, useLoad, useOv, usePressure } from './parts';

const copy = BODY.staking;
const days = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });
const pct1 = (n: number) => fmtPctRule(n, 1);
const hours1 = (n: number) => n.toFixed(1);
/** Commission as a percent: whole numbers stay whole ("5%"), otherwise up to two decimals. */
const pctTrim = (n: number) => `${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;

export function Staking({ route }: ScreenProps) {
  const { at, rewound } = useReplay();
  const { o, loading } = useOv();
  const pr = usePressure();
  // Validator commissions are current only (no history): not requested while rewound.
  const intel = useLoad('intel', () => fetchIntel(), { enabled: !rewound, everyMs: 300_000 });

  const supplyP: Stamp | null = o ? o.supply.prov : null;
  const share = ratio(o?.supply.bonded, o?.supply.total);
  const shareP = supplyP ? fromOne(supplyP, 'NAM staked divided by all NAM') : null;
  const wait = unbondingOf(pr, rewound);
  const apr = aprOf(pr, rewound);

  // What staking earns: the commission the largest validators keep (the indexer's list).
  const vals = (intel.data?.validators ?? []).filter((v) => Number.isFinite(v.commission));
  const valP: Stamp | null = rewound
    ? missing('indexer.namada.net', 'Validator commissions were not recorded over time.')
    : intel.loading
      ? null
      : intel.data
        ? { source: 'indexer.namada.net', at: intel.data.fetchedAt, status: vals.length ? 'live' : 'missing', note: vals.length ? 'The largest validators by stake, as the indexer lists them.' : 'The indexer listed no validators.' }
        : noAnswer('indexer.namada.net');
  const cMin = vals.length ? Math.min(...vals.map((v) => v.commission * 100)) : null;
  const cMax = vals.length ? Math.max(...vals.map((v) => v.commission * 100)) : null;

  const namCovP: Stamp | null = o ? o.namada.coverage : null;

  // The recorded trend of staked NAM (the readings the server holds, up to 14 days).
  const trend = (pr.data?.bondedTrend ?? []).map((r) => ({ t: r.ts, v: r.value }));
  const first = trend[0];
  const last = trend[trend.length - 1];
  const trendP: Stamp | null = supplyP && last ? { ...supplyP, at: last.t, derivedFrom: 'the first and the last reading of the chain\'s total stake that this site holds (the last reading of each 6 hours)' } : supplyP;

  return (
    <article className="seo seo--staking">
      <Hero
        eyebrow={<Dateline label="Staking" />}
        h1={route?.h1 ?? ''}
        sub={copy.paras[0]}
        fig={
          <HeroNumber
            size="48"
            label="Share staked"
            chip={loading ? <span className="skel__b skel__chip" aria-hidden="true" /> : <ProvChip p={shareP} label="Staked share of all NAM" />}
            value={<Fig loading={loading} h={48} w="4ch" v={share != null ? share * 100 : null} prov={shareP} fmt={pct1} />}
            sub="of all NAM is locked with validators."
          />
        }
      >
        <p className="seo-hero__more">{copy.paras[1]}</p>
        <Facts
          className="seo-facts"
          sourceLabel="Staking rate and unstaking wait"
          items={[
            {
              n: <Fig loading={pr.loading} v={apr.v} prov={apr.prov} fmt={pct1} showAge={false} />,
              label: 'Staking rate a year, before commission',
              scope: apr.prov ? { label: 'Staking rate', p: apr.prov } : undefined,
            },
            {
              n: <Fig loading={pr.loading} v={wait.v} prov={wait.prov} fmt={days} unit="days" showAge={false} />,
              label: 'Unstaking wait, set by the chain',
              scope: wait.prov ? { label: 'Unstaking wait', p: wait.prov } : undefined,
            },
          ]}
        />
      </Hero>

      <Band label="Staking, question by question">
        <QSection id="q-earn" h2={copy.sections![0].h2} paras={copy.sections![0].paras}>
          <FigList
            label="What validators keep"
            loading={intel.loading}
            rows={[
              { label: 'Lowest commission', note: vals.length ? <>among the <Num v={vals.length} /> largest validators by stake</> : 'among the largest validators by stake', value: <Fig loading={intel.loading} h={26} v={cMin} prov={valP} fmt={pctTrim} />, p: valP },
              { label: 'Highest commission', note: 'among the same validators', value: <Fig loading={intel.loading} h={26} v={cMax} prov={valP} fmt={pctTrim} showReason={false} />, p: valP },
            ]}
          />
        </QSection>

        <QSection id="q-wait" h2={copy.sections![1].h2} paras={copy.sections![1].paras}>
          {pr.data?.unbondingEpochs != null && pr.data.epochHours != null ? (
            <p className="seo-p seo-p--fig" data-prov-group="">
              <Fig v={pr.data.unbondingEpochs} prov={wait.prov} fmt={fmtNamRule} /> epochs (pipeline, unbonding and penalty window) of about{' '}
              <Fig v={pr.data.epochHours} prov={wait.prov} fmt={hours1} unit="h" />, the epoch length measured on the chain.{' '}
              <ProvDot p={wait.prov} label="the unstaking wait" />
            </p>
          ) : wait.params ? (
            <p className="seo-p seo-p--fig" data-prov-group="">
              <Fig v={wait.params.unbondingLength} prov={wait.prov} fmt={fmtNamRule} /> unbonding epochs and <Fig v={wait.params.pipelineLength} prov={wait.prov} fmt={fmtNamRule} /> pipeline epochs of{' '}
              <Fig v={wait.params.minEpochSec / 3600} prov={wait.prov} fmt={days} unit="h" /> each.{' '}
              <ProvDot p={wait.prov} label="the unstaking wait" />
            </p>
          ) : null}
          <FigList
            label="Unstaking that ended"
            loading={loading}
            rows={[
              {
                label: 'Unlocked in the last day',
                note: 'NAM whose wait ended and was withdrawn',
                value: <Fig loading={loading} h={26} v={o?.namada.withdrawn24h} prov={namCovP} fmt={fmtNamRule} unit="NAM" />,
                p: namCovP,
              },
              {
                label: 'Staked in the last day',
                note: 'new stakes, and restakes after unlocking',
                value: <Fig loading={loading} h={26} v={o?.namada.bonded24h} prov={namCovP} fmt={fmtNamRule} unit="NAM" />,
                p: namCovP,
              },
            ]}
          />
          <GoLink to="/supply">Every unstaking request and what followed</GoLink>
        </QSection>

        <QSection id="q-words" h2={copy.sections![2].h2} paras={copy.sections![2].paras}>
          <p className="seo-terms">
            <span>In the glossary:</span> <Term id="staked" /> <Term id="unstaking" /> <Term id="unlocked" />
          </p>
        </QSection>

        <QSection id="q-staked" h2={copy.sections![3].h2} paras={copy.sections![3].paras}>
          <FigList
            label="How much NAM is staked"
            loading={loading}
            rows={[
              { label: 'NAM staked with validators', value: <Fig loading={loading} h={26} v={o?.supply.bonded} prov={supplyP} fmt={fmtNamRule} unit="NAM" />, p: supplyP },
              ...(o?.supply.unstaking != null
                ? [{ label: 'NAM leaving staking', note: 'in the staking account but not staked: unstaking, ready to withdraw or unclaimed rewards', value: <Fig h={26} v={o.supply.unstaking} prov={supplyP} fmt={fmtNamRule} unit="NAM" />, p: supplyP }]
                : []),
              { label: 'All NAM in existence', value: <Fig loading={loading} h={26} v={o?.supply.total} prov={supplyP} fmt={fmtNamRule} unit="NAM" />, p: supplyP },
              {
                label: first && last ? `Change since ${fmtDayMonth(first.t)}` : 'Change over the recorded readings',
                note: 'staked NAM, over the readings this site holds',
                value: pr.loading ? <Fig loading h={26} v={null} /> : <Fig v={first && last && trend.length > 1 ? last.v - first.v : null} prov={trendP ?? noAnswer('Namada node')} fmt={fmtNamSigned} unit="NAM" />,
                p: trendP,
              },
            ]}
          >
            {pr.loading ? (
              <SkeletonBlock height={88} className="seo-spark" />
            ) : trend.length > 1 ? (
              <Sparkline
                className="seo-spark"
                points={trend}
                label={`Staked NAM, ${fmtNamRule(first.v)} NAM on ${fmtDayMonth(first.t)} to ${fmtNamRule(last.v)} NAM on ${fmtDayMonth(last.t)}`}
              >
                <span>Staked NAM, {fmtDayMonth(first.t)} to {fmtDayMonth(last.t)}</span>
              </Sparkline>
            ) : null}
          </FigList>
          {rewound && at ? <Say>{`Figures are as they were at ${fmtUtcLong(at)}.`}</Say> : null}
        </QSection>

        <Related paths={['/guides/how-to-stake-nam', '/supply', '/learn/how-nam-trading-works', '/osmosis', '/holders']} />
      </Band>
    </article>
  );
}
