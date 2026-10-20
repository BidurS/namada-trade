// The not-found view (system.md 9.9, seo-requirements Must 5). The server already answers 404
// with noindex; this is the page a person sees: the H1, one plain sentence, the six main screens
// as real links (each with the question it answers), search, and the other pages.
import type { ScreenProps } from '../../app/index';
import { useOverlays } from '../../app/index';
import { NOT_FOUND } from '../../../../shared/copy';
import { ROUTES, TABS, routeByPath, type RouteDef } from '../../../../shared/routes';
import { Button } from '../../ui';
import { Band, Hero, PageLink } from './parts';

export function NotFound(_: ScreenProps) {
  const { openPalette } = useOverlays();
  const tabs = TABS.map((t) => routeByPath(t.path)).filter((r): r is RouteDef => !!r);
  const others = ROUTES.filter((r) => r.index && !TABS.some((t) => t.path === r.path));
  return (
    <article className="seo seo--nf">
      <Hero eyebrow={<p className="eyebrow seo-eyebrow">Not found</p>} h1={NOT_FOUND.h1} sub={NOT_FOUND.lead} />
      <Band label="Pages that exist">
        <nav aria-label="Main screens">
          <ul className="seo-links seo-links--tabs">
            {tabs.map((r, i) => (
              <li key={r.path}>
                <PageLink route={r} icon={TABS[i].id} />
              </li>
            ))}
          </ul>
        </nav>
        <div className="seo-nf__search">
          <Button variant="primary" icon="search" onClick={() => openPalette()} aria-haspopup="dialog">
            Search
          </Button>
          <p className="cap">Pages, addresses and words, in one box.</p>
        </div>
        <nav className="seo-rel" aria-labelledby="seo-nf-more">
          <h2 id="seo-nf-more" className="h3 seo-rel__h">More pages</h2>
          <ul className="seo-links">
            {others.map((r) => (
              <li key={r.path}>
                <PageLink route={r} />
              </li>
            ))}
          </ul>
        </nav>
      </Band>
    </article>
  );
}
