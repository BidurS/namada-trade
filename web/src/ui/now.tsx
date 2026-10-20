// The UI kit's clock and app hooks.
//
// Ages derive from `at` on render against one shared clock that ticks every 5 s (build-plan 6,
// "Ages tick"). Under Rewind the shell passes the rewound time as `now`, so every age is
// measured from that moment (system.md 8, Num "rewound"). The shell can also pass how a
// "Rewind to this time" link is built and followed (client-side navigation keeping ?at=).
import React, { createContext, useContext, useSyncExternalStore } from 'react';

export interface UiConfig {
  /** Fixed "now" (the rewound time). Unset or null: the live clock. */
  now?: number | null;
  /** href for "Rewind to this time". Default: the current path with ?at=<ms>. */
  rewindHref?: (at: number) => string;
  /** Client-side navigation for kit links (rewind, glossary). Default: the browser follows the href. */
  navigate?: (href: string) => void;
  /** Where "More in the glossary" points. Unset: the link is not shown. */
  glossaryHref?: string;
  /** Open the Address sheet for an address (the shell's overlays). Unset: address names are plain text. */
  openAddress?: (address: string) => void;
}

const UiCtx = createContext<UiConfig>({});

/** Wrap the app once (the shell owns where): <UiProvider value={{ now: asOf, navigate, rewindHref }}>. */
export const UiProvider: React.FC<{ value: UiConfig; children: React.ReactNode }> = ({ value, children }) => (
  <UiCtx.Provider value={value}>{children}</UiCtx.Provider>
);

export const useUiConfig = (): UiConfig => useContext(UiCtx);

// ---- one shared 5 s ticker -------------------------------------------------------------
let clock = Date.now();
const subs = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
const tick = () => {
  clock = Date.now();
  subs.forEach((f) => f());
};
const onVisible = () => {
  if (document.visibilityState === 'visible') tick();
};
function subscribe(cb: () => void): () => void {
  subs.add(cb);
  if (!timer) {
    clock = Date.now();
    timer = setInterval(tick, 5000);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
  }
  return () => {
    subs.delete(cb);
    if (!subs.size && timer) {
      clearInterval(timer);
      timer = undefined;
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
    }
  };
}
const snap = () => clock;

/** The wall clock, re-rendering every 5 s and when the tab becomes visible. The app's one ticker (the shell's useNow is this). */
export function useWallNow(): number {
  return useSyncExternalStore(subscribe, snap, snap);
}

/** "Now" for ages: the rewound time under Rewind, otherwise a clock that ticks every 5 s. */
export function useUiNow(): number {
  const cfg = useContext(UiCtx);
  const live = useWallNow();
  return cfg.now ?? live;
}

/**
 * Figures inside are current readings, also under Rewind (holder balances, address balances): their ages are
 * measured from the wall clock, not from the rewound time. Everything else in the kit config is kept.
 */
export function WallClock({ children }: { children: React.ReactNode }) {
  const cfg = useContext(UiCtx);
  return <UiCtx.Provider value={cfg.now == null ? cfg : { ...cfg, now: null }}>{children}</UiCtx.Provider>;
}

/** Default rewind link: same path, ?at=<ms>, other query parameters kept. */
export function defaultRewindHref(at: number): string {
  if (typeof location === 'undefined') return `/?at=${at}`;
  const u = new URL(location.href);
  u.searchParams.set('at', String(Math.round(at)));
  return `${u.pathname}${u.search}`;
}

/** onClick for a kit link: lets modified clicks through, otherwise navigates client-side when the shell provided a navigator. */
export function linkClick(cfg: UiConfig, href: string, after?: () => void) {
  return (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (!cfg.navigate || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    after?.();
    cfg.navigate(href);
  };
}
