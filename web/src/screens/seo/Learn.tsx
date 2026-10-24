// /learn/how-nam-trading-works: "How does NAM get from a Namada wallet to a sale?"
// The yellow band is the path itself (system.md 9.1 item 5, on this page the one yellow field):
// four steps on a rail (Staked, Unlocked, Bridged, Sold), each an H2 question answered in its
// first sentence, with its one real number and a ProvDot. Evidence band: the three figures that
// describe a trade before it happens (fact strip, one SourceLine), then related pages.
import type { CSSProperties, ReactNode } from 'react';
import type { ScreenProps } from '../../app/index';
import { REWIND_WORDS, useReplay } from '../../app/index';
import { BODY } from '../../../../shared/copy';
import type { QuoteCurveResponse } from '../../../../shared/types';
import { Num, ProvDot, Term, type Stamp } from '../../ui';
import { fetchQuoteCurve } from '../../api';
import { NBSP, fmtNamRule, fmtPctRule, fmtPctSigned, fmtUsdRule } from '../../lib/format';
import { Band, Dateline, Fig, FigList, Hero, QSection, Related, fromOne, missing, noAnswer, ratio, unbondingOf, useLoad, useOv, usePressure } from './parts';

const copy = BODY.learn;
const days = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });
const pct1 = (n: number) => fmtPctRule(n, 1);

function Ring() {
  return (
    <span className="seo-step__ring" aria-hidden="true">
      <svg viewBox="0 0 28 28">
        <circle className="r0" cx="14" cy="14" r="11.5" fill="none" stroke="currentColor" strokeWidth="2.5" />
        <circle className="r1" cx="14" cy="14" r="6" fill="currentColor" />
      </svg>
    </span>
  );
}

interface StepProps {
  n: number;
  /** Glossary entry for the step word (plain word first, expert term on tap). */
  term?: string;
  word: string;
  id: string;
  h2: string;
  paras: string[];
  fig: ReactNode;
  caption: ReactNode;
  p: Stamp | null;
  what: string;
  loading: boolean;
}

function Step({ n, term, word, id, h2, paras, fig, caption, p, what, loading }: StepProps) {
  return (
    // data-prov-group: the step's figure and its ProvDot (in the note under it) go together
    <li className="seo-step" data-prov-group="" style={{ ['--i' as string]: n - 1 } as CSSProperties}>
      <Ring />
      <div className="seo-step__body">
        <p className="seo-step__k">
          <span className="seo-step__i">{n}</span>
          {term ? <Term id={term}>{word}</Term> : <span>{word}</span>}
        </p>
        <h2 id={id} className="seo-step__h">{h2}</h2>
        {paras.map((t, i) => (
          <p key={i} className="seo-step__copy">{t}</p>
        ))}
        <p className="seo-step__fig">{fig}</p>
        <p className="seo-step__note">
          <span>{caption}</span>
          {loading ? <span className="skel__b seo-skel-dot" aria-hidden="true" /> : <ProvDot p={p} label={what} wrap />}
        </p>
      </div>
    </li>
  );
}

export function Learn({ route }: ScreenProps) {
  const { rewound } = useReplay();
  const { o, loading } = useOv();
  const pr = usePressure();
  // The price move for an order size is live only: not requested under Rewind.
  const curve = useLoad<QuoteCurveResponse>('curve', () => fetchQuoteCurve(), { enabled: !rewound, everyMs: 60_000 });
  const [s1, s2, s3, s4, s5] = copy.sections!;

  const supplyP: Stamp | null = o ? o.supply.prov : null;
  const share = ratio(o?.supply.bonded, o?.supply.total);
  const shareP = supplyP ? fromOne(supplyP, 'NAM staked divided by all NAM') : null;
  const wait = unbondingOf(pr, rewound);
  const flowP: Stamp | null = pr.loading ? null : pr.data ? pr.data.coverage : noAnswer('Flow index');
  const covP: Stamp | null = o ? o.dex.coverage : null;
  const dexP: Stamp | null = o ? o.dex.prov : null;

  // The largest listed size whose sale was quoted (the size comes from the table, never typed).
  const sold = [...(curve.data?.curve ?? [])].filter((c) => c.sellImpactPct != null).sort((a, b) => b.amountNam - a.amountNam)[0] ?? null;
  const curveP: Stamp | null = rewound
    ? missing('Osmosis quote', REWIND_WORDS.quotes, 'Size table')
    : curve.loading
      ? null
      : curve.data
        ? sold
          ? { ...curve.data.prov, plain: 'Size table' }
          : { ...curve.data.prov, plain: 'Size table', status: 'missing', note: 'No sale size was quoted.' }
        : noAnswer('Osmosis quote', 'Size table');
  const readyP: Stamp | null = flowP ? fromOne(flowP, pr.data ? `NAM that crossed to Osmosis in the last ${pr.data.windowDays} days, minus what was sold or sent back` : 'NAM that crossed to Osmosis, minus what was sold or sent back') : null;

  return (
    <article className="seo seo--learn">
      <Hero eyebrow={<Dateline label="Learn" />} h1={route?.h1 ?? ''} sub={copy.paras[0]} className="seo-hero--path">
        <ol className="seo-steps" aria-label="The four steps from a wallet to a sale">
          <Step
            n={1} term="staked" word="Staked" id="q-staked" h2={s1.h2} paras={s1.paras}
            fig={<Fig loading={loading} v={share != null ? share * 100 : null} prov={shareP} fmt={pct1} showAge={false} />}
            caption="of all NAM is staked"
            p={shareP} what="Staked share of all NAM" loading={loading}
          />
          <Step
            n={2} term="unlocked" word="Unlocked" id="q-unlocked" h2={s2.h2} paras={s2.paras}
            fig={<Fig loading={pr.loading} v={wait.v} prov={wait.prov} fmt={days} unit="days" showAge={false} />}
            caption="the unstaking wait"
            p={wait.prov} what="Unstaking wait" loading={pr.loading}
          />
          <Step
            n={3} term="bridged" word="Bridged" id="q-bridged" h2={s3.h2} paras={s3.paras}
            fig={<Fig loading={pr.loading} v={pr.data?.ibcIn7d} prov={flowP} fmt={fmtNamRule} unit="NAM" showAge={false} />}
            caption={pr.data ? `crossed to Osmosis in the last ${pr.data.windowDays} days` : 'crossed to Osmosis'}
            p={flowP} what="NAM that crossed to Osmosis" loading={pr.loading}
          />
          <Step
            n={4} word="Sold" id="q-sold" h2={s4.h2} paras={s4.paras}
            fig={<Fig loading={loading} v={o?.dex.sellNam24h} prov={covP} fmt={fmtNamRule} unit="NAM" showAge={false} />}
            caption="sold on Osmosis in the last day"
            p={covP} what="NAM sold on Osmosis in the last day" loading={loading}
          />
        </ol>
      </Hero>

      <Band label="Before a trade">
        <QSection id="q-before" h2={s5.h2} paras={s5.paras}>
          <FigList
            label="Three figures before a trade"
            loading={loading || pr.loading}
            rows={[
              {
                label: 'Money in the NAM pools',
                note: 'what every order trades against',
                value: <Fig loading={loading} h={26} v={o?.dex.liquidityUsd} prov={dexP} fmt={fmtUsdRule} />,
                p: dexP,
              },
              {
                label: 'Price move for a sale',
                note: sold ? <>when selling <Num v={sold.amountNam} fmt={fmtNamRule} />{NBSP}NAM, from the size table</> : 'the largest sale in the size table',
                value: <Fig loading={curve.loading} h={26} v={sold?.sellImpactPct != null ? -sold.sellImpactPct : null} prov={curveP} fmt={(n) => fmtPctSigned(n)} />,
                p: curveP,
              },
              {
                label: 'Ready to sell on Osmosis',
                labelNode: <Term id="ready-to-sell">Ready to sell</Term>,
                note: pr.data ? `crossed in the last ${pr.data.windowDays} days, not sold or sent back` : 'crossed recently, not sold or sent back',
                value: <Fig loading={pr.loading} h={26} v={pr.data?.onDeckTotal} prov={readyP} fmt={fmtNamRule} unit="NAM" />,
                p: readyP,
              },
            ]}
          />
        </QSection>
        <Related paths={['/guides/how-to-buy-nam', '/staking', '/osmosis', '/supply', '/trade', '/shielded']} />
      </Band>
    </article>
  );
}
