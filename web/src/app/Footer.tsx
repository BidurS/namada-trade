// The footer (system.md 9.1 item 8, seo-requirements Must 9): black, the dial and wordmark,
// how current the data is, the data sources, the disclaimer sentence on every route, and the
// links: How we know (Sources sheet), Settings, API, then the explainer pages under the names they
// carry everywhere else (shared/routes.ts labels: Questions, Guides, Staking, Holders, NAM on Osmosis, Depth, How NAM
// trading works; EXPLAINER_ROUTES plus the depth page, seo-requirements "New pages": link from the footer).
// Then "Source code": the public repository (owner decision 4, SITE.repo), and "X", the site's account (SITE.x),
// each opening in a new tab.
import { ROUTES, SITE, type RouteId } from '../../../shared/routes';
import { Mark, Wordmark } from '../ui/Wordmark';
import { fmtAgo, fmtUtcLong } from '../lib/format';
import { Link } from './Link';
import { lazy, Suspense, useState } from 'react';
import { Icon } from '../ui/Icon';

const DonateSheet = lazy(() => import('./DonateSheet'));
import { useClock, useOverview } from './overview';
import { useOverlays } from './overlays';
import { useReplay } from './replay';

const LINK_IDS: RouteId[] = ['settings', 'faq', 'guides', 'staking', 'holders', 'osmosis', 'depth', 'learn'];
const LINKS: { to: string; label: string }[] = LINK_IDS.flatMap((id) => {
  const r = ROUTES.find((x) => x.id === id);
  return r ? [{ to: r.path, label: r.label }] : [];
});

export function Footer() {
  const { overview } = useOverview();
  const { at } = useReplay();
  const now = useClock();
  const { openSources } = useOverlays();
  const flowsAt = overview?.dex.coverage.at ?? null;
  const [coffee, setCoffee] = useState(false);

  const snap = at
    ? `Rewound to ${fmtUtcLong(at)}. Ages are measured from that moment.`
    : overview
      ? `Figures as of ${fmtUtcLong(overview.generatedAt)}.`
      : null;

  return (
    <footer className="band ground-ink foot">
      <div className="wrap foot__grid">
        <div className="foot__id">
          <Link className="foot__brand" to="/" aria-label="Namada Trade, home">
            <Mark />
            <Wordmark className="foot__word" />
          </Link>
          <p className="foot__snap">{snap ?? ' '}</p>
          <button type="button" className="foot__coffee" aria-haspopup="dialog" onClick={() => setCoffee(true)}>
            <Icon name="shield" />
            Buy me a coffee
            <span className="foot__coffee-sub">shielded NAM or ZEC</span>
          </button>
          {coffee ? <Suspense fallback={null}><DonateSheet onClose={() => setCoffee(false)} /></Suspense> : null}
        </div>
        <div className="foot__legal">
          <p>
            {SITE.provenance} Data: {SITE.dataSources}
            {flowsAt ? `; this site's own record of moves current as of ${fmtAgo(flowsAt, now)}.` : '.'}
          </p>
          <p>{SITE.disclaimer}</p>
        </div>
        <ul className="foot__links">
          <li>
            <button type="button" onClick={openSources}>How we know</button>
          </li>
          {LINKS.slice(0, 1).map((l) => (
            <li key={l.to}><Link to={l.to}>{l.label}</Link></li>
          ))}
          <li>
            <a href="/api/overview" data-native="" rel="nofollow" title="The figures behind the home page, as JSON">API</a>
          </li>
          {LINKS.slice(1).map((l) => (
            <li key={l.to}><Link to={l.to}>{l.label}</Link></li>
          ))}
          <li>
            <a href={SITE.repo} target="_blank" rel="noopener noreferrer" title="NamadaTrade on GitHub (MIT licence), opens in a new tab">Source code</a>
          </li>
          <li>
            <a href={SITE.x} target="_blank" rel="noopener noreferrer me" title="@namadatrade on X: big moves, votes and a daily recap; opens in a new tab">X</a>
          </li>
        </ul>
      </div>
    </footer>
  );
}
