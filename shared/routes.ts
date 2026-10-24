// Path routes shared by the UI (client routing) and the Worker (per-route <title>/meta, the
// server-rendered page, sitemap, redirects). Slugs are URLs people will link and search engines will
// index: change them only with a redirect in ROUTE_ALIASES.
import { SITE } from './site';
import { GUIDE_META, GUIDES_PATH, guidePath, type GuideSlug } from './guide-meta';

export { SITE };

/** A guide's route id: one per guide in shared/guide-meta.ts, all drawn by the one guide screen. */
export type GuideRouteId = `guide-${GuideSlug}`;

export type RouteId =
  | 'home' | 'trade' | 'supply' | 'shielded' | 'activity' | 'holders' | 'alerts' | 'settings'
  | 'staking' | 'osmosis' | 'learn' | 'faq' | 'guides' | GuideRouteId;

/** The six tabs, in this order everywhere (system.md section 3). */
export type TabId = 'home' | 'trade' | 'supply' | 'shielded' | 'activity' | 'alerts';

export interface RouteDef {
  path: string;
  id: RouteId;
  /** Short name for navigation, footer links and the server-rendered page's links. */
  label: string;
  /** The visible heading: the question the page answers. React renders exactly this as the one <h1>. */
  h1: string;
  /**
   * The heading when the page's main control is switched (Trade: the buy side, system.md 3). The page loads
   * with `h1`; the server-rendered page and the SEO gate check `h1`.
   */
  h1Alt?: string;
  /** <title> without the site suffix (at most 46 chars, so title + " · NamadaTrade" is at most 60). */
  title: string;
  /** Meta description, at most 155 chars, distinct per route. */
  description: string;
  /** false: noindex (private or user-specific) and left out of the sitemap. */
  index: boolean;
  /** Keyboard shortcut (tabs only). */
  key?: string;
  /** The tab this route lights up. Holders lights Activity; the SEO pages light none. */
  tab?: TabId;
  /** A guide: its slug (shared/guide-meta.ts); the text is in shared/guides.ts. */
  guide?: GuideSlug;
  /**
   * The day the page's text was last checked (YYYY-MM-DD), for a page with no live figure (the guides and their
   * list). A page that states live figures has none: its sitemap date is the time of its newest figure.
   */
  updated?: string;
}

export const ROUTES: RouteDef[] = [
  {
    path: '/', id: 'home', label: 'Home', tab: 'home', key: '1', index: true,
    h1: SITE.tagline,
    title: 'NAM price, holders, staking and Osmosis depth',
    description: SITE.description,
  },
  {
    path: '/trade', id: 'trade', label: 'Trade', tab: 'trade', key: '2', index: true,
    h1: 'What would I get if I sold NAM now?',
    h1Alt: 'What would I pay to buy NAM now?',
    title: 'Trade NAM: live quote and price move',
    description: 'What selling or buying NAM on Osmosis returns right now, how far your own order moves the price, how deep the pools are and what trades paid.',
  },
  {
    path: '/supply', id: 'supply', label: 'Supply', tab: 'supply', key: '3', index: true,
    h1: 'Is a big sale coming?',
    title: 'NAM supply: ready to sell, unstaking, movers',
    description: 'NAM that crossed to Osmosis and has not been sold, staked NAM being unlocked and when, the addresses buying and selling most, and votes in progress.',
  },
  {
    path: '/shielded', id: 'shielded', label: 'Shielded', tab: 'shielded', key: '4', index: true,
    h1: 'How much NAM can\'t be seen?',
    title: 'Namada shielded pool: how much NAM is private',
    description: 'How much NAM sits in Namada\'s shielded pool and what share of all NAM that is, how much moved in and out, and the largest moves out to personal addresses.',
  },
  {
    path: '/activity', id: 'activity', label: 'Activity', tab: 'activity', key: '5', index: true,
    h1: 'Every move, with its source',
    title: 'Every NAM transaction, with its source',
    description: 'Every swap, bridge crossing, staking and shielded move of NAM on Namada and Osmosis as it happens, with its transaction and the source of its price.',
  },
  {
    path: '/holders', id: 'holders', label: 'Holders', tab: 'activity', index: true,
    h1: 'Who holds NAM?',
    title: 'NAM holders: largest addresses and their share',
    description: 'The addresses holding the most NAM on Namada and Osmosis, spendable and staked, with the share the top ten hold. Protocol accounts are left out.',
  },
  {
    path: '/alerts', id: 'alerts', label: 'Alerts', tab: 'alerts', key: '6', index: true,
    h1: 'What should wake me up?',
    title: 'NAM alerts: big moves, unstaking, bridging',
    description: 'Recent NAM moves that crossed an alert size: bridged to Osmosis, unstaked, traded in size or moved out of the shielded pool. Alerts can go to Discord.',
  },
  {
    path: '/settings', id: 'settings', label: 'Settings', index: false,
    h1: 'Settings',
    title: 'Settings',
    description: 'Your alert rules, where alerts go, signed-in devices, keys for developers and your data.',
  },
  {
    path: '/staking', id: 'staking', label: 'Staking', index: true,
    h1: 'How does staking NAM work, and what does it earn?',
    title: 'Namada staking rate and unstaking wait now',
    description: 'The staking rate the network reports, how much NAM is staked and its share, and the unstaking wait from the chain\'s own settings, each with its time.',
  },
  {
    path: '/osmosis', id: 'osmosis', label: 'NAM on Osmosis', index: true,
    h1: 'NAM on Osmosis: pools, liquidity and what a trade costs',
    title: 'NAM on Osmosis: pools, liquidity, trade cost',
    description: 'How much money the NAM pools on Osmosis hold, how much NAM is there, what traded in the last day, and why a small order moves the price.',
  },
  {
    path: '/learn/how-nam-trading-works', id: 'learn', label: 'How NAM trading works', index: true,
    h1: 'How does NAM get from a Namada wallet to a sale?',
    title: 'How NAM trading works: from wallet to sale',
    description: 'The four steps between a Namada wallet and a sale of NAM: staked, unlocked, bridged to Osmosis and sold, and the public figures that describe each one.',
  },
  {
    path: '/faq', id: 'faq', label: 'Questions', index: true,
    h1: 'NAM questions, answered with sources',
    title: 'NAM questions: price, holders, sources',
    description: 'Why this NAM price differs from other sites, why shielded holders cannot be seen, how old each number is, and where the data comes from.',
  },
  {
    path: GUIDES_PATH, id: 'guides', label: 'Guides', index: true,
    h1: 'Namada guides, with their sources',
    title: 'Namada guides: staking, privacy, buying NAM',
    description: 'Plain guides to Namada and NAM: what it is, how to buy, stake and shield it, how governance works and where new NAM comes from, cited to Namada\'s docs.',
    updated: GUIDE_META.map((g) => g.updated).sort().reverse()[0],
  },
  ...GUIDE_META.map((g): RouteDef => ({
    path: guidePath(g.slug), id: `guide-${g.slug}`, label: g.label, index: true, guide: g.slug, updated: g.updated,
    h1: g.h1, title: g.title, description: g.description,
  })),
];

/** The six tabs in order, with their routes. */
export const TABS: { id: TabId; label: string; path: string; key: string }[] = ROUTES
  .filter((r): r is RouteDef & { key: string; tab: TabId } => !!r.key && r.tab === r.id)
  .map((r) => ({ id: r.tab, label: r.label, path: r.path, key: r.key }));

/** The SEO pages: footer and Home explainer links, not tabs. */
export const EXPLAINER_ROUTES: RouteDef[] = ROUTES.filter((r) => ['staking', 'osmosis', 'learn', 'faq', 'holders', 'guides'].includes(r.id));

/** The guides, in the order of shared/guide-meta.ts. */
export const GUIDE_ROUTES: RouteDef[] = ROUTES.filter((r) => !!r.guide);

/** Old hash routes and renamed slugs → current path (the Worker answers 301 and keeps the query, so ?at= survives). */
export const ROUTE_ALIASES: Record<string, string> = {
  blind: '/shielded', 'blind-spot': '/shielded',
  overview: '/', integrity: '/',
  pools: '/trade',
  flows: '/activity', tape: '/activity',
  intel: '/supply', pressure: '/supply',
  learn: '/learn/how-nam-trading-works',
  guide: GUIDES_PATH,
};

/** View ids of the old UI, so code that still passes them resolves to the renamed route. */
const LEGACY_IDS: Record<string, RouteId> = { pressure: 'supply', blind: 'shielded', tape: 'activity' };

/** A table's own entry only: "constructor" or "__proto__" in a URL is not an alias of anything. */
const own = <T>(table: Record<string, T>, key: string): T | undefined => (Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined);

/** The current path an old slug (one or more segments, lower case) moved to, or undefined. */
export const aliasOf = (seg: string): string | undefined => own(ROUTE_ALIASES, seg);

export const routeByPath = (path: string): RouteDef | undefined => ROUTES.find((r) => r.path === path);
export const routeById = (id: RouteId | string): RouteDef => ROUTES.find((r) => r.id === (own(LEGACY_IDS, id) ?? id)) ?? ROUTES[0];

/** The full <title> of a route: "NamadaTrade: …" on Home, "… · NamadaTrade" elsewhere. */
export const fullTitle = (r: RouteDef): string => (r.path === '/' ? `${SITE.name}: ${r.title}` : `${r.title} · ${SITE.name}`);

/** What the Worker does with a request path, as a pure function so it can be tested. */
export type PathAction =
  | { kind: 'route'; route: RouteDef }
  | { kind: 'redirect'; to: string }
  | { kind: 'not_found'; asset: boolean };

export function classifyPath(pathname: string): PathAction {
  if (pathname === '/index.html') return { kind: 'redirect', to: '/' };
  const exact = routeByPath(pathname);
  if (exact) return { kind: 'route', route: exact };
  // segments joined by single slashes, without leading or trailing slashes: "learn/how-nam-trading-works"
  const seg = pathname.split('/').filter(Boolean).join('/');
  const alias = aliasOf(seg.toLowerCase());
  if (alias) return { kind: 'redirect', to: alias };
  // /trade/, /Trade, //trade and /learn/How-NAM-Trading-Works/ → the canonical path
  const norm = '/' + seg.toLowerCase();
  if (norm !== pathname && routeByPath(norm)) return { kind: 'redirect', to: norm };
  // anything that looks like a file (or lives under /assets, or under a dot folder such as /.git or /.well-known)
  // that the static host did not have is a real 404
  return { kind: 'not_found', asset: pathname.startsWith('/assets/') || /\.[a-z0-9]{2,5}$/i.test(pathname) || /\/\./.test(pathname) };
}

/** The Location of a 301: the new path with the original query (so ?at= survives every redirect). */
export function redirectLocation(href: string, to: string): string {
  const u = new URL(href);
  u.pathname = to;
  u.hash = '';
  return u.toString();
}

/**
 * Old hash links (`/#/pressure?at=…`, `/#tape`) → the current path with the query kept, or null when the
 * hash is not an old route. For the client router: the server never sees the hash.
 */
export function legacyHashTarget(hash: string): string | null {
  const m = /^#\/?([A-Za-z-]+)(\?.*)?$/.exec(hash);
  if (!m) return null;
  const seg = m[1].toLowerCase();
  const path = aliasOf(seg) ?? ROUTES.find((r) => r.id === (own(LEGACY_IDS, seg) ?? seg) && r.path !== '/')?.path;
  return path ? path + (m[2] ?? '') : null;
}
