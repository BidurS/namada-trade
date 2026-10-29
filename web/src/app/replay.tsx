// Rewind (N3): ?at=<unix ms> on every route. The URL is the single source of truth; this module
// reads it, offers setAt and the words the UI uses, and makes sure every /api request carries
// `at` while rewound (one wrapper for every fetch, build-plan 6).
//
// Exempt endpoints (no `at` support on the server today): /api/holders, /api/address/*,
// /api/search, /api/integrity (and the exports and account calls). The UI says so in words
// for those and never shows them as if dated. Live-only endpoints (/api/quote*, /api/pools, the depth
// minute and its quote) are not called at all while rewound; screens check `rewound` before calling them.
import React, { createContext, useContext, useMemo } from 'react';
import { parseAt, setAt as routerSetAt, useLocation } from './router';
import { fmtDayMonth, fmtUtcClock, fmtUtcLong } from '../lib/format';

/** Paths that do not take `at` (prefix match). */
export const REWIND_EXEMPT = ['/api/holders', '/api/address/', '/api/search', '/api/integrity', '/api/export/', '/api/me', '/api/auth', '/api/labels'] as const;
/** Paths that are live-only: not requested at all while rewound. */
/** `/api/depth` itself takes no `at` either (the page reads the stored minute from /api/depth/history while rewound), but as a prefix it would cover the history, so it is kept out of this list and never asked while rewound. */
export const REWIND_LIVE_ONLY = ['/api/quote', '/api/pools', '/api/depth/quote'] as const;

/** "/api/me" matches /api/me and /api/me/…, never /api/metrics. */
const under = (path: string, p: string): boolean => path === p.replace(/\/$/, '') || path.startsWith(p.endsWith('/') ? p : `${p}/`);
export const isRewindExempt = (path: string): boolean => REWIND_EXEMPT.some((p) => under(path, p));
export const isLiveOnly = (path: string): boolean => REWIND_LIVE_ONLY.some((p) => under(path, p));

/** The sentences the UI uses under Rewind (build-plan 6, owner decision 8). */
export const REWIND_WORDS = {
  /** The rewound banner, phone: short so it fits one line at 360 px with the normal gutter (owner decision 15).
   *  "Rewound · 30 Aug, 19:05 UTC"; the year is added only when it is not this year. */
  banner: (at: number) => {
    const y = new Date(at).getUTCFullYear();
    return `Rewound · ${fmtDayMonth(at)}${y !== new Date().getUTCFullYear() ? ` ${y}` : ''}, ${fmtUtcClock(at)}`;
  },
  /** The rewound banner, from 640 px: appended to `banner`. */
  bannerMore: 'Every number is as it was then; live prices are paused.',
  /** Holders, address balances, search: not recorded over time. */
  balances: (at: number) => `Balances were not recorded over time; these are current, not as of ${fmtUtcLong(at)}.`,
  /** The status pill when overview.checks is empty. */
  checks: 'Checks were not recorded then',
  /** Trade and the Home mini-ticket. */
  quotes: 'Live quotes are paused while rewound.',
  /** The header price under Rewind: the executed-swap price, labelled. */
  price: 'Last trade price at that time',
  back: 'Back to now',
} as const;

/** Add `at` to an /api URL when rewound and the endpoint takes it. Leaves other URLs alone. */
export function withAt(url: string, at: number | null): string {
  if (!at) return url;
  const u = new URL(url, location.origin);
  if (u.origin !== location.origin || !u.pathname.startsWith('/api/') || isRewindExempt(u.pathname) || u.searchParams.has('at')) return url;
  u.searchParams.set('at', String(at));
  return `${u.pathname}${u.search}`;
}

/**
 * Install the one wrapper: while the URL has ?at=, every same-origin GET to /api/ that takes `at`
 * gets it, whoever made the call (api.ts, a screen, a sheet); and every such GET revalidates
 * instead of trusting the browser cache. Called once in main.tsx.
 * In development a live-only request under Rewind logs a warning (it should not be made).
 */
export function installRewindFetch() {
  const w = window as Window & { __ntRewindFetch?: boolean };
  if (w.__ntRewindFetch) return;
  w.__ntRewindFetch = true;
  const orig = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      const at = parseAt(location.search);
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const u = new URL(raw, location.origin);
      if (method === 'GET' && u.origin === location.origin && u.pathname.startsWith('/api/')) {
        // Every reading is asked of the server, never answered from the browser cache: the edge
        // rewrites max-age to hours on a cache hit (zone Browser Cache TTL), which would freeze the
        // 20 s poll. no-cache revalidates each time; the edge still answers from its 15 s cache.
        if (!init?.cache) init = { ...init, cache: 'no-cache' };
        if (at) {
          if (import.meta.env.DEV && isLiveOnly(u.pathname)) console.warn(`[rewind] live-only request while rewound: ${u.pathname}`);
          const next = withAt(raw, at);
          if (next !== raw) input = input instanceof Request ? new Request(next, input) : next;
        }
      }
    } catch {
      /* never break a request over the wrapper */
    }
    return orig(input as RequestInfo, init);
  };
}

export interface ReplayValue {
  /** The rewound time (unix ms), or null when live. */
  at: number | null;
  rewound: boolean;
  /** Rewind to a time (pushState), or back to now with null. */
  setAt: (at: number | null) => void;
  backToNow: () => void;
}

const ReplayCtx = createContext<ReplayValue>({ at: null, rewound: false, setAt: routerSetAt, backToNow: () => routerSetAt(null) });

export function ReplayProvider({ children }: { children: React.ReactNode }) {
  const loc = useLocation();
  const at = parseAt(loc.search);
  const value = useMemo<ReplayValue>(() => ({ at, rewound: at != null, setAt: routerSetAt, backToNow: () => routerSetAt(null) }), [at]);
  return <ReplayCtx.Provider value={value}>{children}</ReplayCtx.Provider>;
}

/** { at, rewound, setAt, backToNow } */
export const useReplay = (): ReplayValue => useContext(ReplayCtx);
