// /guides: the guides, each as a row with its question and what it covers (the same list the server renders
// into #root, worker/src/seo.ts guideListHtml), then the explainer pages that show live figures.
import type { ScreenProps } from '../../app/index';
import { BODY } from '../../../../shared/copy';
import { GUIDE_ROUTES } from '../../../../shared/routes';
import { Link } from '../../app/index';
import { Icon } from '../../ui';
import { Band, Hero, Related } from './parts';

const copy = BODY.guides;

export function Guides({ route }: ScreenProps) {
  return (
    <article className="seo seo--guides">
      <Hero eyebrow={<p className="eyebrow seo-eyebrow">Guides</p>} h1={route?.h1 ?? ''} sub={copy.paras[0]}>
        {copy.paras.slice(1).map((p, i) => <p key={i} className="seo-hero__more">{p}</p>)}
      </Hero>
      <Band label="Every guide">
        <ul className="seo-glist">
          {GUIDE_ROUTES.map((g) => (
            <li key={g.path}>
              <Link to={g.path} className="seo-glist__a">
                <h2 className="seo-glist__h">{g.h1}</h2>
                <p className="seo-glist__d">{g.description}</p>
                <Icon name="arrow" className="ico seo-link__a" />
              </Link>
            </li>
          ))}
        </ul>
        <Related paths={['/learn/how-nam-trading-works', '/staking', '/osmosis', '/shielded', '/faq']} title="Pages with live figures" />
      </Band>
    </article>
  );
}
