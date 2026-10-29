/* ============================================================================================
   NamadaTrade app shell (F1): providers, the route outlet and the overlays host.

   SCREEN CONTRACT (the same text, longer, is in web/src/app/CONTRACT.md)

   Files. Each screen owns ONE entry file that default-exports its screen component:
     screens/home/index.tsx      /            screens/trade/index.tsx     /trade
     screens/supply/index.tsx    /supply      screens/shielded/index.tsx  /shielded
     screens/activity/index.tsx  /activity and /holders (one component; props.view says which tab)
     screens/depth/index.tsx     /depth
     screens/alerts/index.tsx    /alerts      screens/settings/index.tsx  /settings
     screens/seo/index.tsx       named exports Staking, Osmosis, Learn, Faq, NotFound
     screens/sheets/index.tsx    named exports SourcesSheet, AddressSheet, SignInSheet, AccountSheet
   Every screen and the sheets are lazy-loaded (React.lazy); keep heavy imports inside them.

   Props.  export default function Screen({ view, route }: ScreenProps)
     view   'home' | 'trade' | … | 'holders' | 'notfound' (RouteId or 'notfound')
     route  the RouteDef from shared/routes.ts (null for not-found). Render exactly one
            <h1> equal to route.h1. The shell sets document.title; screens never do.

   Hooks (import from '../../app/index'):
     useOverview()  { overview, error, receivedAt, stream: { connected, lastAt }, liveFlows,
                      streamedIds, alerts: { count, since, hits }, refresh }
                    overview is /api/overview, polled every 20 s (as of ?at= under Rewind).
     useReplay()    { at, rewound, setAt(ms | null), backToNow() }. Every /api GET gets ?at=
                    automatically while rewound, except REWIND_EXEMPT (holders, address, search,
                    integrity): say REWIND_WORDS.balances(at) next to those. Do not call
                    REWIND_LIVE_ONLY endpoints (quote, pools) while rewound.
     useNow()       wall clock, ticks every 5 s.    useClock()  at ?? now (use it for ages).
     useRoute()     { view, route, path, params, at }    navigate(to, { replace?, keepAt? })
     <Link to="/trade">  a real <a href>; plain left clicks navigate client-side, ?at= kept.
                    Plain <a href="/supply"> also works (a document-level delegate), but
                    prefer Link.
     useOverlays()  { openSources(), openAddress(addr), openSignIn(code?), openSheet(req),
                      closeSheet(), openPalette({ focus? }) }
     useSession()   { session, setSession, signOut }      useTheme()  [pref, theme, setPref]

   Sheets (screens/sheets): each export is mounted only while open, receives onClose, and
   must open itself on mount (e.g. <Sheet open onClose={onClose} …>, ui/Sheet.tsx). The host
   returns focus to the opener. ?addr= opens AddressSheet, #pair= (or an older ?pair= link) opens SignInSheet.

   CSS: screens own styles/screens/<name>.css inside @layer components, using tokens.css and
   the --c-* ground tokens. Shell classes (.wrap .band .eyebrow .h1 .h2 .sub .lead .cap .mono
   .u .ico .gly .ruler) are in styles/components/shell.css.
   ============================================================================================ */
import React, { lazy, Suspense, useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { UiProvider, useUiConfig } from '../ui/now';
import { Footer } from './Footer';
import { Header } from './Header';
import { useGlobalKeys } from './keys';
import { AppBoundary } from './LoadFailed';
import { OverlaysProvider, useOverlays } from './overlays';
import { OverviewProvider } from './overview';
import { ReplayProvider, useReplay } from './replay';
import { RewindBanner } from './RewindBanner';
import { consumeUserNav, navigate, titleFor, useRoute, type RouteDef, type ViewId } from './router';
import { SessionProvider } from './session';
import { TabBar } from './TabBar';
import { UpdateBanner } from './UpdateBanner';
import { StaleBanner } from './StaleBanner';
import { GUIDE_ROUTES } from '../../../shared/routes';

export interface ScreenProps {
  view: ViewId;
  route: RouteDef | null;
}

type ScreenModule = { default: ComponentType<ScreenProps> };
type Loader = () => Promise<ScreenModule>;

const seo = () => import('../screens/seo');
const LOADERS: Partial<Record<ViewId, Loader>> = {
  home: () => import('../screens/home'),
  trade: () => import('../screens/trade'),
  depth: () => import('../screens/depth'),
  supply: () => import('../screens/supply'),
  shielded: () => import('../screens/shielded'),
  activity: () => import('../screens/activity'),
  alerts: () => import('../screens/alerts'),
  settings: () => import('../screens/settings'),
  staking: () => seo().then((m) => ({ default: m.Staking })),
  osmosis: () => seo().then((m) => ({ default: m.Osmosis })),
  learn: () => seo().then((m) => ({ default: m.Learn })),
  faq: () => seo().then((m) => ({ default: m.Faq })),
  notfound: () => seo().then((m) => ({ default: m.NotFound })),
  guides: () => seo().then((m) => ({ default: m.Guides })),
};
LOADERS.holders = LOADERS.activity;
// every guide is drawn by the one guide screen (one loader, so moving between guides keeps it mounted)
const guideLoader: Loader = () => seo().then((m) => ({ default: m.Guide }));
for (const r of GUIDE_ROUTES) LOADERS[r.id] = guideLoader;

// The kit's demo route, development only (web/src/ui/Demo.tsx, written by the UI kit team).
const DEMO = import.meta.env.DEV ? import.meta.glob<{ default?: ComponentType; Demo?: ComponentType }>('../ui/Demo.tsx') : {};
const demoLoader = DEMO['../ui/Demo.tsx'];
if (demoLoader) LOADERS['ui-demo'] = () => demoLoader().then((m) => ({ default: (m.default ?? m.Demo ?? (() => null)) as ComponentType<ScreenProps> }));

/**
 * One component per loader, fixed at first use (activity and holders share one, so switching tabs keeps it
 * mounted): the screen itself when its code was already in (the landing screen, see preloadView), else a
 * lazy one.
 */
const SCREENS = new Map<Loader, ComponentType<ScreenProps>>();
const loaderFor = (view: ViewId): Loader => LOADERS[view] ?? LOADERS.notfound!;
const lazyFor = (view: ViewId) => {
  const loader = loaderFor(view);
  let c = SCREENS.get(loader);
  if (!c) {
    c = lazy(loader);
    SCREENS.set(loader, c);
  }
  return c;
};

/**
 * Load the landing screen's code before the first render (main.tsx waits for this, at most `ms`), so the
 * server's readable text in #root is replaced by the real page, not by a skeleton with no heading:
 * React.lazy suspends once even when its module is already in, so the landing screen is used directly.
 * A failure resolves too; the lazy path then shows ScreenBoundary's notice.
 */
export function preloadView(view: ViewId, ms = 3000): Promise<void> {
  const loader = loaderFor(view);
  const done = loader().then(
    (m) => {
      if (!SCREENS.has(loader) && m?.default) SCREENS.set(loader, m.default);
    },
    () => {},
  );
  return Promise.race([done, new Promise<void>((r) => setTimeout(r, ms))]);
}

/** Skeleton while a screen's code arrives (no loading text, a fixed minimum height). */
function RouteWait() {
  return (
    <div className="wrap shell-wait" aria-busy="true" aria-label="Opening the page">
      <i /><i /><i /><i /><i /><i />
    </div>
  );
}

class ScreenBoundary extends React.Component<{ children: React.ReactNode; resetKey: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.failed) this.setState({ failed: false });
  }
  componentDidCatch(err: unknown) {
    console.error('screen failed', err);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="wrap oops" role="alert">
        <p className="h2">This part of the page did not load.</p>
        <p className="sub">A new version may have been deployed while the page was open.</p>
        <button type="button" onClick={() => location.reload()}>Reload the page</button>
      </div>
    );
  }
}

function Outlet() {
  const m = useRoute();
  const Screen = lazyFor(m.view);
  const mainRef = useRef<HTMLElement>(null);
  const [announce, setAnnounce] = useState('');

  useEffect(() => {
    document.title = titleFor(m);
    // After a client-side navigation: focus the page and announce it (not on first load). After Back
    // or Forward: announce it, and give the page focus only if focus went with the old page (so the
    // reader is not moved when focus is still somewhere sensible, such as the header).
    const how = consumeUserNav();
    if (how) {
      const a = document.activeElement;
      if (how === 'push' || !a || a === document.body || !a.isConnected) mainRef.current?.focus({ preventScroll: true });
      setAnnounce(document.title);
    }
  }, [m]);

  return (
    <main id="main" ref={mainRef} className="app__main" tabIndex={-1}>
      <ScreenBoundary resetKey={m.path}>
        <Suspense fallback={<RouteWait />}>
          <Screen view={m.view} route={m.route} />
        </Suspense>
      </ScreenBoundary>
      <p className="sr-only" aria-live="polite">{announce}</p>
    </main>
  );
}

function Shell() {
  const { openPalette, togglePalette } = useOverlays();
  useGlobalKeys({ openPalette: () => openPalette(), togglePalette });
  return (
    <div className="app">
      <a className="skip" href="#main">Skip to content</a>
      <Header />
      <RewindBanner />
      <UpdateBanner />
      <StaleBanner />
      <Outlet />
      <Footer />
      <TabBar />
    </div>
  );
}

/** The kit's clock, rewind links and navigation follow the shell. */
function KitBridge({ children }: { children: React.ReactNode }) {
  const { at } = useReplay();
  const value = useMemo(() => ({ now: at, navigate: (href: string) => navigate(href) }), [at]);
  return <UiProvider value={value}>{children}</UiProvider>;
}

/** Address names in kit lists open the shell's Address sheet. */
function KitOverlays({ children }: { children: React.ReactNode }) {
  const cfg = useUiConfig();
  const { openAddress } = useOverlays();
  const value = useMemo(() => ({ ...cfg, openAddress }), [cfg, openAddress]);
  return <UiProvider value={value}>{children}</UiProvider>;
}

export function App() {
  return (
    <AppBoundary>
      <ReplayProvider>
        <SessionProvider>
          <OverviewProvider>
            <KitBridge>
              <OverlaysProvider>
                <KitOverlays>
                  <Shell />
                </KitOverlays>
              </OverlaysProvider>
            </KitBridge>
          </OverviewProvider>
        </SessionProvider>
      </ReplayProvider>
    </AppBoundary>
  );
}
