// The platform pages that are words first (docs/design/platform-plan.md, release A): /methodology, /privacy and
// /terms. Band: the question and its first answer, with the day the text was last checked against the code.
// Evidence: one section per question of the page's copy (shared/copy.ts BODY, the same sentences the
// server-rendered page states), and under a section the figures its copy names, each with its own stamp and one
// SourceLine for the section. No figure is typed: a section without a live figure is words only.
import type { ScreenProps } from '../../app/index';
import type { Overview } from '../../../../shared/types';
import { BODY, type FactKey } from '../../../../shared/copy';
import { fmtPriceNode, type Stamp } from '../../ui';
import { fmtNamRule, fmtUsdRule } from '../../lib/format';
import { Band, Fig, FigList, Hero, QSection, Related, useOv, type FigRow } from './parts';

/** The figures a words-first page may state, each from the overview with the stamp the overview gives it. */
function figRow(key: FactKey, o: Overview | null, loading: boolean): FigRow | null {
  const nam = (label: string, v: number | null | undefined, p: Stamp | null): FigRow => ({ label, value: <Fig loading={loading} h={26} v={v} prov={p} fmt={fmtNamRule} unit="NAM" />, p });
  switch (key) {
    case 'price': return { label: 'Price of one NAM, quoted on Osmosis', value: <Fig loading={loading} h={26} v={o?.price.usd.value} prov={o ? o.price.usd.prov : null} fmt={fmtPriceNode} />, p: o ? o.price.usd.prov : null };
    case 'supply': return nam('All NAM in existence', o?.supply.total, o ? o.supply.prov : null);
    case 'staked': return nam('Staked with validators', o?.supply.bonded, o ? o.supply.prov : null);
    case 'shielded': return nam('In the shielded pool', o?.supply.shielded, o ? o.supply.prov : null);
    case 'osmosis': return nam('Held on Osmosis, wallets and pools', o?.supply.osmosis, o ? o.supply.osmosisProv : null);
    case 'depth': return { label: 'Money in the Osmosis pools', value: <Fig loading={loading} h={26} v={o?.dex.liquidityUsd} prov={o ? o.dex.prov : null} fmt={fmtUsdRule} />, p: o ? o.dex.prov : null };
    case 'volume': return nam('Bought and sold on Osmosis, last 24 hours', o?.dex.volume24hNam, o ? o.dex.coverage : null);
    default: return null;
  }
}

export function PlainPage({ route, id, label, related }: ScreenProps & { id: string; label: string; related: string[] }) {
  const copy = BODY[id];
  const { o, loading } = useOv();
  const sections = copy.sections ?? [];
  return (
    <article className={`seo seo--plain seo--${id}`}>
      <Hero
        eyebrow={<p className="eyebrow seo-eyebrow">{label}{route?.updated ? <> · text checked against the code on {route.updated}</> : null}</p>}
        h1={route?.h1 ?? ''}
        sub={copy.paras[0]}
      />
      <Band label={label}>
        {copy.paras.slice(1).map((p, i) => <p key={i} className="seo-p seo-plain__lead">{p}</p>)}
        {sections.map((s, i) => {
          const rows = (s.facts ?? []).map((k) => figRow(k, o, loading)).filter((r): r is FigRow => !!r);
          return (
            <QSection key={s.h2} id={`${id}-${i + 1}`} h2={s.h2} paras={s.paras}>
              {rows.length ? <FigList label={s.h2} loading={loading} rows={rows} /> : null}
            </QSection>
          );
        })}
        <Related paths={related} />
      </Band>
    </article>
  );
}

export function Methodology(props: ScreenProps) {
  return <PlainPage {...props} id="methodology" label="Methodology" related={['/status', '/developers', '/faq', '/trade', '/holders', '/shielded']} />;
}

export function Privacy(props: ScreenProps) {
  return <PlainPage {...props} id="privacy" label="Privacy" related={['/settings', '/terms', '/faq', '/developers']} />;
}

export function Terms(props: ScreenProps) {
  return <PlainPage {...props} id="terms" label="Terms" related={['/privacy', '/methodology', '/developers', '/faq']} />;
}
