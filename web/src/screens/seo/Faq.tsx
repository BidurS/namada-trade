// /faq: "NAM questions, answered with sources". Band: the two figures the page refers to (the
// price and the shielded share, one SourceLine). Evidence: one <details> per question, open by
// default so every answer is visible text (seo-requirements Must 3) and each can be folded
// away; the H2 is the question and the answer's first sentence answers it. Where a figure makes
// the answer concrete it sits under the text with its own source line.
import type { ReactNode } from 'react';
import type { ScreenProps } from '../../app/index';
import { REWIND_WORDS, useOverlays, useReplay } from '../../app/index';
import { BODY, SITE } from '../../../../shared/copy';
import { Button, Icon, Num, derive, fmtPriceNode, type Stamp } from '../../ui';
import { fmtNamRule, fmtPctRule, fmtPctSigned } from '../../lib/format';
import { Band, Dateline, Facts, Fig, FigList, GoLink, Hero, Related, Say, fromOne, missing, ratio, useOv } from './parts';

const copy = BODY.faq;
const pct1 = (n: number) => fmtPctRule(n, 1);

const STATES: { status: 'fresh' | 'old' | 'none' | 'disagree'; word: string; text: string }[] = [
  { status: 'fresh', word: 'Fresh', text: 'Read within its usual refresh.' },
  { status: 'old', word: 'Old', text: 'Older than its usual refresh: shown dimmed, with its age.' },
  { status: 'none', word: 'No data', text: 'Could not be read: a dash and the reason, never a guess.' },
  { status: 'disagree', word: 'Sources disagree', text: 'Two sources give different values: a wavy underline, and both are in its source sheet.' },
];

function Q({ id, h2, paras, children }: { id: string; h2: string; paras: string[]; children?: ReactNode }) {
  return (
    <details className="seo-q" open>
      <summary className="seo-q__s">
        <h2 id={id} className="seo-q__h">{h2}</h2>
        <Icon name="chev" className="ico seo-q__i" />
      </summary>
      <div className="seo-q__b">
        {paras.map((p, i) => (
          <p key={i} className={i === 0 ? 'seo-answer' : 'seo-p'}>{p}</p>
        ))}
        {children}
      </div>
    </details>
  );
}

export function Faq({ route }: ScreenProps) {
  const { rewound } = useReplay();
  const { openSources } = useOverlays();
  const { o, loading } = useOv();
  const [qPrice, qShielded, qAge, qData, qBuy, qNot] = copy.sections!;

  const priceP: Stamp | null = o ? o.price.usd.prov : null;
  const tradeP: Stamp | null = o ? o.price.swap1h.prov : null;
  const supplyP: Stamp | null = o ? o.supply.prov : null;
  const covP: Stamp | null = o ? o.namada.coverage : null;
  const shieldShare = ratio(o?.supply.shielded, o?.supply.total);
  const shieldP = supplyP ? fromOne(supplyP, 'NAM in the shielded pool divided by all NAM') : null;
  const gap = o && o.price.usd.value != null && o.price.swap1h.value ? ((o.price.usd.value - o.price.swap1h.value) / o.price.swap1h.value) * 100 : null;
  const gapP = priceP && tradeP ? derive([priceP, tradeP], 'quoted price compared with the last trade price') : null;

  // Cross-checks: not recorded over time, so under Rewind there are none to count.
  const checks = o?.checks ?? [];
  const passing = checks.filter((c) => c.status === 'ok').length;
  const checkAt = checks.length ? Math.max(...checks.map((c) => c.checkedAt)) : null;
  const checkP: Stamp | null = !o
    ? null
    : rewound
      ? missing('cross-check', `${REWIND_WORDS.checks}.`, 'Cross-checks')
      : checks.length
        ? { source: 'cross-check', plain: 'Cross-checks', at: checkAt, status: 'live', derivedFrom: 'checks that pass, of all checks' }
        : missing('cross-check', 'No cross-check has run yet.', 'Cross-checks');

  return (
    <article className="seo seo--faq">
      <Hero eyebrow={<Dateline label="Questions" />} h1={route?.h1 ?? ''} sub={copy.paras[0]}>
        <Facts
          className="seo-facts"
          sourceLabel="Figures on this page"
          items={[
            { n: <Fig loading={loading} v={o?.price.usd.value} prov={priceP} fmt={fmtPriceNode} showAge={false} />, label: 'Price of one NAM, quoted on Osmosis', scope: priceP ? { label: 'Price of one NAM', p: priceP } : undefined },
            { n: <Fig loading={loading} v={shieldShare != null ? shieldShare * 100 : null} prov={shieldP} fmt={pct1} showAge={false} />, label: 'of all NAM is in the shielded pool', scope: shieldP ? { label: 'Shielded share of all NAM', p: shieldP } : undefined },
          ]}
        />
      </Hero>

      <Band label="Questions and answers" className="seo-band--faq">
        <div className="seo-qs">
          <Q id="q-price" h2={qPrice.h2} paras={qPrice.paras}>
            <FigList
              label="Two prices of NAM"
              loading={loading}
              rows={[
                { label: 'Quoted price', note: 'what the Osmosis router quotes now', value: <Fig loading={loading} h={26} v={o?.price.usd.value} prov={priceP} fmt={fmtPriceNode} />, p: priceP },
                { label: 'Last trade price', note: 'what real trades paid, hourly median', value: <Fig loading={loading} h={26} v={o?.price.swap1h.value} prov={tradeP} fmt={fmtPriceNode} />, p: tradeP },
                { label: 'Gap between the two', value: <Fig loading={loading} h={26} v={gap} prov={gapP} fmt={(n) => fmtPctSigned(n)} />, p: gapP },
              ]}
            />
            <GoLink to="/trade">Quotes and trades side by side</GoLink>
          </Q>

          <Q id="q-shielded" h2={qShielded.h2} paras={qShielded.paras}>
            <FigList
              label="The shielded pool"
              loading={loading}
              rows={[
                { label: 'NAM in the shielded pool', value: <Fig loading={loading} h={26} v={o?.supply.shielded} prov={supplyP} fmt={fmtNamRule} unit="NAM" />, p: supplyP },
                { label: 'Moved in, last day', value: <Fig loading={loading} h={26} v={o?.namada.shielded24h} prov={covP} fmt={fmtNamRule} unit="NAM" />, p: covP },
                { label: 'Moved out, last day', value: <Fig loading={loading} h={26} v={o?.namada.unshielded24h} prov={covP} fmt={fmtNamRule} unit="NAM" />, p: covP },
              ]}
            />
            <GoLink to="/shielded">The shielded pool over time</GoLink>
          </Q>

          <Q id="q-age" h2={qAge.h2} paras={qAge.paras}>
            <ul className="seo-states" aria-label="The four states of a figure">
              {STATES.map((s) => (
                <li key={s.status} className="seo-state">
                  <i className="dot" data-status={s.status} aria-hidden="true" />
                  <span className="seo-state__w">{s.word}</span>
                  <span className="seo-state__t">{s.text}</span>
                </li>
              ))}
            </ul>
          </Q>

          <Q id="q-data" h2={qData.h2} paras={qData.paras}>
            <FigList
              label="Cross-checks"
              loading={loading}
              rows={[
                {
                  label: 'Cross-checks that pass now',
                  value: loading ? <Fig loading h={26} v={null} /> : checkP && checkP.status !== 'missing' ? <><Num v={passing} prov={checkP} /> <span className="u">of</span> <Num v={checks.length} prov={checkP} /></> : <Num v={null} prov={checkP} />,
                  p: checkP,
                },
              ]}
            />
            <Button variant="secondary" onClick={openSources} aria-haspopup="dialog" className="seo-btn">How we know</Button>
          </Q>

          <Q id="q-buy" h2={qBuy.h2} paras={qBuy.paras}>
            <GoLink to="/trade">What a purchase of a given size costs now</GoLink>
          </Q>

          <Q id="q-not" h2={qNot.h2} paras={qNot.paras}>
            <p className="seo-p">{SITE.privacy}</p>
          </Q>
        </div>
        {rewound ? <Say>{REWIND_WORDS.bannerMore}</Say> : null}
        <Related paths={['/trade', '/shielded', '/staking', '/osmosis', '/learn/how-nam-trading-works']} />
      </Band>
    </article>
  );
}
