// The path router (F1). No router library (build-plan 2): the URL is the state, read through a
// tiny external store; navigation is real <a href> with preventDefault for plain left clicks.
//
// Rules (system.md 3, seo-requirements Must 2 and 5, build-plan 6):
// - Paths come from shared/routes.ts (ROUTES, ROUTE_ALIASES, classifyPath).
// - Normalising (old #/… links, aliases, case, trailing slash) uses replaceState, never pushState.
// - ?at= (Rewind) survives every navigation and every redirect unless the caller drops it.
// - Unknown paths render the not-found view; they are never rewritten to another route.
// - document.title follows the RouteDef (fullTitle), "Page not found · NamadaTrade" otherwise; a screen may
//   add a detail for its own path ("Holders, page 3 · NamadaTrade", setTitleDetail).
// - Every history entry carries { scrollY } in history.state (written when scrolling stops and before every
//   push), so Back and Forward restore the scroll offset as well as the URL (nav-search-plan 2.4).
import { useSyncExternalStore, type MouseEvent as ReactMouseEvent } from 'react';
import { ROUTES, ROUTE_ALIASES, SITE, classifyPath, fullTitle, legacyHashTarget, type RouteDef, type RouteId } from '../../../shared/routes';

export type { RouteDef, RouteId };

/** What the outlet renders: a route, the dev-only kit demo, or the not-found view. */
export type ViewId = RouteId | 'notfound' | 'ui-demo';

export interface Loc {
  path: string;
  search: string;
  hash: string;
}

export interface Match {
  view: ViewId;
  /** The RouteDef, or null for not-found and the demo. */
  route: RouteDef | null;
  path: string;
  /** Query parameters of the current URL (a fresh copy; read-only use). */
  params: URLSearchParams;
  /** Rewind time from ?at= (unix ms), or null when live. */
  at: number | null;
}

const DEMO_PATH = '/__ui';

const readLoc = (): Loc => ({ path: location.pathname, search: location.search, hash: location.hash });

let current: Loc = readLoc();
const subs = new Set<() => void>();

function emit() {
  const next = readLoc();
  if (next.path === current.path && next.search === current.search && next.hash === current.hash) return;
  current = next;
  subs.forEach((f) => f());
}

/**
 * Parse ?at=: a positive unix-ms time in the past, rounded; anything else is live. A time at or after
 * now is live too: the server answers it with current figures (worker/src/api.ts asOfParam), so a
 * "Rewound to 2286" label over live numbers would be false. normalizeUrl removes such an `at`.
 */
export function parseAt(search: string, now = Date.now()): number | null {
  const raw = new URLSearchParams(search).get('at');
  if (!raw) return null;
  const n = Math.round(Number(raw));
  return Number.isFinite(n) && n > 0 && n < now ? n : null;
}

/** An `at` in the URL that parseAt does not accept (not a number, not positive, or in the future). */
const badAt = (search: string): boolean => new URLSearchParams(search).has('at') && parseAt(search) == null;

/**
 * Bring the address bar to its canonical form with replaceState: an old #/view link becomes its
 * path (query kept), an alias or a mis-cased or slashed path becomes the canonical path (query kept).
 * Returns true when the URL changed.
 */
export function normalizeUrl(boot = false): boolean {
  let changed = false;
  if (location.hash && isOldHash(location.hash, boot)) {
    const legacy = legacyHashTarget(location.hash);
    if (legacy) {
      // the hash carries its own query (#/blind?at=…); otherwise keep the page's query
      const target = legacy.includes('?') ? legacy : legacy + location.search;
      history.replaceState(history.state, '', target);
      changed = true;
    }
  }
  const action = classifyPath(location.pathname);
  if (action.kind === 'redirect' && action.to !== location.pathname) {
    history.replaceState(history.state, '', action.to + location.search + location.hash);
    changed = true;
  }
  if (badAt(location.search)) {
    // a future or unreadable ?at= shows live figures: the address bar says so too (no rewind label)
    const u = new URL(location.href);
    u.searchParams.delete('at');
    history.replaceState(history.state, '', `${u.pathname}${u.search}${u.hash}`);
    changed = true;
  }
  if (changed) emit();
  return changed;
}

/** View ids of the old UI's hash routes (#/trade, #tape …). */
const OLD_VIEW_IDS = ['trade', 'pressure', 'blind', 'tape', 'alerts', 'settings'];
/**
 * An old hash route: always "#/view"; a bare "#view" only on first load and only for the old
 * view ids and aliases, so an in-page anchor (#holders on a section) is never taken for a route.
 */
function isOldHash(hash: string, boot: boolean): boolean {
  if (hash.startsWith('#/')) return true;
  if (!boot) return false;
  const seg = hash.slice(1).split('?')[0].toLowerCase();
  return OLD_VIEW_IDS.includes(seg) || seg in ROUTE_ALIASES;
}

/** The view for a path (after normalising). */
export function matchPath(path: string, search = ''): Match {
  const params = new URLSearchParams(search);
  const at = parseAt(search);
  if (import.meta.env.DEV && path === DEMO_PATH) return { view: 'ui-demo', route: null, path, params, at };
  const action = classifyPath(path);
  if (action.kind === 'route') return { view: action.route.id, route: action.route, path, params, at };
  return { view: 'notfound', route: null, path, params, at };
}

// ---- the store -----------------------------------------------------------------------------
export function subscribe(cb: () => void): () => void {
  subs.add(cb);
  return () => subs.delete(cb);
}
export const getLocation = (): Loc => current;

let started = false;
/** Called once by main.tsx before the first render: normalise, then follow Back, Forward and pasted hashes. */
export function startRouter() {
  if (started) return;
  started = true;
  normalizeUrl(true);
  current = readLoc();
  try {
    history.scrollRestoration = 'manual';
  } catch {
    /* an old browser: its own restoration stays */
  }
  seenY = window.scrollY;
  window.addEventListener('scroll', onScroll, { passive: true });
  // a reload keeps history.state: come back to where the reader was
  const y0 = savedY();
  if (y0 != null && y0 > 0) restoreScroll(y0);
  window.addEventListener('popstate', () => {
    window.clearTimeout(saveT);
    const before = current.path;
    normalizeUrl();
    // Back and Forward to another page: the outlet announces it (and gives focus to the page if focus
    // was lost with the old one); a change of query or hash only is not a new page
    if (location.pathname !== before) lastNav = 'pop';
    emit();
    // an entry never scrolled has no offset saved: it was at the top
    const y = savedY() ?? (location.pathname !== before ? 0 : null);
    if (y != null) restoreScroll(y);
  });
  window.addEventListener('hashchange', () => {
    if (normalizeUrl()) emit();
  });
  document.addEventListener('click', interceptAnchors);
}

// ---- scroll position per history entry ------------------------------------------------------
/** The scroll offset as of the last scroll event (a scroll a click starts has not fired yet when it pushes). */
let seenY = 0;
let saveT = 0;
let restoring: (() => void) | null = null;
const SAVE_MS = 100;
/** How long a restore keeps placing the page while its rows load (they arrive from the network). */
const RESTORE_MS = 6_000;

const savedY = (): number | null => {
  const y = (history.state as { scrollY?: unknown } | null)?.scrollY;
  return typeof y === 'number' && Number.isFinite(y) && y >= 0 ? y : null;
};
/** Write the offset into the current entry (the state is merged: nothing else in it is lost). */
function saveScroll(y: number) {
  try {
    const st = history.state && typeof history.state === 'object' ? history.state : {};
    history.replaceState({ ...st, scrollY: Math.round(y) }, '');
  } catch {
    /* Safari throttles replaceState: the next save catches up */
  }
}
function onScroll() {
  seenY = window.scrollY;
  if (restoring) return;
  window.clearTimeout(saveT);
  saveT = window.setTimeout(() => saveScroll(window.scrollY), SAVE_MS);
}

/**
 * Place the page at `y` once the content is tall enough, and keep it there while the page's lists load
 * (`[aria-busy="true"]` in main); stop at once when the reader scrolls, taps or types.
 */
export function restoreScroll(y: number) {
  restoring?.();
  const t0 = performance.now();
  let raf = 0;
  let calm = 0;
  const stop = () => {
    cancelAnimationFrame(raf);
    for (const ev of STOP_EVENTS) window.removeEventListener(ev, stop, true);
    if (restoring === stop) restoring = null;
    seenY = window.scrollY;
    saveScroll(window.scrollY);
  };
  const tick = () => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    if (Math.abs(window.scrollY - y) > 1 && max >= y - 1) window.scrollTo({ top: y, left: 0, behavior: 'instant' as ScrollBehavior });
    const busy = !!document.querySelector('main [aria-busy="true"], main .skel__b');
    calm = Math.abs(window.scrollY - y) <= 1 && !busy ? calm + 1 : 0;
    if (calm >= 3 || performance.now() - t0 > RESTORE_MS) stop();
    else raf = requestAnimationFrame(tick);
  };
  restoring = stop;
  for (const ev of STOP_EVENTS) window.addEventListener(ev, stop, { capture: true, passive: true });
  raf = requestAnimationFrame(tick);
}
const STOP_EVENTS = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;

/** A new history entry: the offset the reader leaves is kept in the entry they leave. */
function pushEntry(next: string, y: number) {
  window.clearTimeout(saveT);
  restoring?.();
  saveScroll(seenY);
  history.pushState({ scrollY: Math.round(y) }, '', next);
}

// ---- navigation ----------------------------------------------------------------------------
export interface NavOptions {
  /** replaceState instead of pushState. */
  replace?: boolean;
  /** Keep the current ?at= when `to` has none (default true). */
  keepAt?: boolean;
  /** Scroll to the top when the path changes (default true). */
  scroll?: boolean;
}

let lastNav: 'push' | 'pop' | null = null;
/**
 * How the page last changed, read once: 'push' right after a client-side navigation to another path
 * (the outlet moves focus to the new page and announces it), 'pop' after Back or Forward to another
 * path (announced; focus moves only if it was lost), null on first load and for same-path changes.
 */
export const consumeUserNav = (): 'push' | 'pop' | null => {
  const v = lastNav;
  lastNav = null;
  return v;
};

let navs = 0;
/** Counts navigate() calls that changed the URL or moved to a #target (overlays: do not pull focus back after one). */
export const navCount = (): number => navs;

/** Scroll to the element a #hash names and move focus there (a same-path link to a section). */
function goToHash(hash: string) {
  let id = '';
  try {
    id = decodeURIComponent(hash.slice(1));
  } catch {
    return;
  }
  const el = id ? document.getElementById(id) : null;
  if (!el) return;
  el.scrollIntoView({ block: 'start' });
  if (!el.matches('a[href], button, input, select, textarea, [tabindex]')) el.setAttribute('tabindex', '-1');
  el.focus({ preventScroll: true });
}

/** The href for a path with the current ?at= carried over (when `to` has no `at` of its own). */
export function hrefFor(to: string, keepAt = true): string {
  const u = new URL(to, location.origin);
  if (keepAt && !u.searchParams.has('at')) {
    const at = parseAt(current.search);
    if (at) u.searchParams.set('at', String(at));
  }
  return u.origin === location.origin ? `${u.pathname}${u.search}${u.hash}` : u.href;
}

/** Navigate client-side. Off-site URLs load normally. */
export function navigate(to: string, opts: NavOptions = {}) {
  const { replace = false, keepAt = true, scroll = true } = opts;
  const u = new URL(to, location.href);
  if (u.origin !== location.origin) {
    location.assign(u.href);
    return;
  }
  const next = hrefFor(`${u.pathname}${u.search}${u.hash}`, keepAt);
  const now = `${location.pathname}${location.search}${location.hash}`;
  const pathChanged = new URL(next, location.origin).pathname !== location.pathname;
  if (next !== now) {
    navs++;
    if (replace) history.replaceState(history.state, '', next);
    else pushEntry(next, pathChanged && scroll ? 0 : window.scrollY);
    normalizeUrl();
    emit();
  }
  if (pathChanged) {
    lastNav = 'push';
    if (scroll) window.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior });
  } else if (u.hash) {
    // the same page and a #target: go there even when the URL already has that hash (a second
    // "Devices" from the Account sheet); the browser would not, since nothing changed
    if (next === now) navs++;
    requestAnimationFrame(() => goToHash(u.hash));
  }
}

/** Set or clear the Rewind time (pushState: Back returns to where you were). A future time is live (see parseAt). */
export function setAt(at: number | null) {
  const u = new URL(location.href);
  if (at && at < Date.now()) u.searchParams.set('at', String(Math.round(at)));
  else u.searchParams.delete('at');
  const next = `${u.pathname}${u.search}${u.hash}`;
  if (next === `${location.pathname}${location.search}${location.hash}`) return;
  pushEntry(next, window.scrollY);
  emit();
}

/** Drop query parameters that only open something (addr, pair) without a history entry. */
export function dropParams(...names: string[]) {
  const u = new URL(location.href);
  let changed = false;
  for (const n of names) if (u.searchParams.has(n)) { u.searchParams.delete(n); changed = true; }
  if (!changed) return;
  history.replaceState(history.state, '', `${u.pathname}${u.search}${u.hash}`);
  emit();
}

/** Write a query parameter without a history entry (e.g. ?addr= while the Address sheet is open). */
export function putParam(name: string, value: string) {
  const u = new URL(location.href);
  if (u.searchParams.get(name) === value) return;
  u.searchParams.set(name, value);
  history.replaceState(history.state, '', `${u.pathname}${u.search}${u.hash}`);
  emit();
}

/** Is this a click the browser should handle itself (new tab, new window, download, middle click)? */
export function isModifiedClick(e: MouseEvent | ReactMouseEvent): boolean {
  return e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;
}

/**
 * Document-level delegate: any plain left click on a same-origin <a href> that points at an app
 * route (or an alias of one) navigates client-side. Links to /api, files, other sites, targets
 * other than _self and downloads are left to the browser. <Link> handles its own clicks first.
 */
function interceptAnchors(e: MouseEvent) {
  if (isModifiedClick(e)) return;
  const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
  if (!a || a.hasAttribute('download') || (a.target && a.target !== '_self') || a.dataset.native !== undefined) return;
  const u = new URL(a.href, location.href);
  if (u.origin !== location.origin) return;
  if (u.pathname.startsWith('/api/') || u.pathname === '/ws') return;
  // same page, only a fragment: let the browser scroll
  if (u.pathname === location.pathname && u.search === location.search && u.hash) return;
  const action = classifyPath(u.pathname);
  const isDemo = import.meta.env.DEV && u.pathname === DEMO_PATH;
  if (action.kind === 'not_found' && !isDemo) return;
  e.preventDefault();
  navigate(`${u.pathname}${u.search}${u.hash}`, { keepAt: !u.searchParams.has('at') && a.dataset.dropAt === undefined });
}

// ---- hooks ---------------------------------------------------------------------------------
/** The current location; re-renders on every navigation. */
export function useLocation(): Loc {
  return useSyncExternalStore(subscribe, getLocation, getLocation);
}

let lastLoc: Loc | null = null;
let lastMatch: Match | null = null;
/** The current match (view, RouteDef, params, at), stable between navigations. */
export function useRoute(): Match {
  const loc = useLocation();
  if (loc !== lastLoc || !lastMatch) {
    lastLoc = loc;
    lastMatch = matchPath(loc.path, loc.search);
  }
  return lastMatch;
}

let detail: { path: string; text: string } | null = null;
/**
 * A screen's detail in the title for its own path, such as a list page: setTitleDetail('/holders',
 * 'Holders, page 3') gives "Holders, page 3 · NamadaTrade"; null goes back to the route's own title. The H1
 * never changes. Set from an effect (the shell's title effect runs after the screen's, so both agree).
 */
export function setTitleDetail(path: string, text: string | null) {
  const next = text ? { path, text } : null;
  if (detail?.path === next?.path && detail?.text === next?.text) return;
  if (!next && detail && detail.path !== path) return;
  detail = next;
  if (location.pathname === path) document.title = titleFor(matchPath(location.pathname, location.search));
}

/** document.title for a match (fullTitle from shared/routes.ts, or a screen's detail for its path). */
export function titleFor(m: Match): string {
  if (m.route && detail && detail.path === m.path) return `${detail.text} · ${SITE.name}`;
  if (m.route) return fullTitle(m.route);
  if (m.view === 'ui-demo') return `UI kit · ${SITE.name}`;
  return `Page not found · ${SITE.name}`;
}

/** The route for an id (null when the table has no such id). */
export const routeOf = (id: RouteId): RouteDef | null => ROUTES.find((r) => r.id === id) ?? null;
