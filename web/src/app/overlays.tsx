// The overlays host (F1): one sheet at a time (Sources, Address, Sign in, Account) plus the
// search palette. Sheets come from web/src/screens/sheets (S7) and load on first use
// (React.lazy). A sheet component is mounted only while open and opens itself on mount
// (contract in CONTRACT.md); this host returns focus to the control that opened it.
//
// URL state: ?addr=<address> opens the Address sheet (and is written while it is open, so
// the link can be shared); #pair=<code> opens Sign in on the pair-code step (N5). Both use
// replaceState, never a history entry. The pairing link carries its code in the fragment, which
// a browser never sends, so the code stays out of the Worker's request logs; a link printed
// before that (?pair=<code>) still opens the sheet.
//
// `?` opens the Keys sheet (nav-search-plan 3.3) with the same guards as every single key in app/keys.ts: not while
// typing in a field, not while a dialog or a popover is open, not with Meta, Ctrl or Alt. An address opened here is
// counted in this browser's recents (app/recent.ts, localStorage only, never sent).
import React, { createContext, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { isTextEntry } from './keys';
import { PartBoundary } from './LoadFailed';
import { noteRecent } from './recent';
import { dropParams, navCount, navigate, putParam, useLocation } from './router';
import type { AddressOrigin } from '../screens/activity/sheetOrigin';

export type SheetRequest =
  | { kind: 'sources' }
  /** `label`: the address's plain name when the opener knows it (kept with the recent entry, nothing else) */
  | { kind: 'address'; address: string; label?: string | null; origin?: AddressOrigin | null }
  | { kind: 'signin'; code?: string | null }
  | { kind: 'account' }
  | { kind: 'keys' };

export interface PaletteRequest {
  /** Open with the Rewind row focused (the header Rewind button). */
  focus?: 'search' | 'rewind';
}

export interface OverlaysValue {
  sheet: SheetRequest | null;
  openSheet: (req: SheetRequest) => void;
  closeSheet: () => void;
  palette: PaletteRequest | null;
  openPalette: (req?: PaletteRequest) => void;
  /**
   * Close search. Focus returns to the control that opened it, unless `restore: false` (the chosen
   * item navigated, and the page takes focus, or it opened a sheet, which keeps the opener itself).
   */
  closePalette: (opts?: { restore?: boolean }) => void;
  togglePalette: () => void;
  // shorthands
  openSources: () => void;
  /** `label`: the plain name when known (Recent); `origin`: the list row it was opened from (the sheet's eyebrow) */
  openAddress: (address: string, opts?: { label?: string | null; origin?: AddressOrigin | null }) => void;
  openSignIn: (code?: string | null) => void;
  /** The Keys sheet (also the `?` key). */
  openKeys: () => void;
}

const noop = () => {};
const OverlaysCtx = createContext<OverlaysValue>({
  sheet: null, openSheet: noop, closeSheet: noop, palette: null, openPalette: noop, closePalette: noop, togglePalette: noop,
  openSources: noop, openAddress: noop, openSignIn: noop, openKeys: noop,
});

/** Open and close sheets and the palette from anywhere. */
export const useOverlays = (): OverlaysValue => useContext(OverlaysCtx);

// ---- lazy pieces --------------------------------------------------------------------------
const loadSheets = () => import('../screens/sheets');
const SourcesSheet = lazy(() => loadSheets().then((m) => ({ default: m.SourcesSheet })));
const AddressSheet = lazy(() => loadSheets().then((m) => ({ default: m.AddressSheet })));
const SignInSheet = lazy(() => loadSheets().then((m) => ({ default: m.SignInSheet })));
const AccountSheet = lazy(() => loadSheets().then((m) => ({ default: m.AccountSheet })));
const KeysSheet = lazy(() => import('./KeysSheet'));
export const loadPalette = () => import('./Palette');
const Palette = lazy(loadPalette);
/** Start downloading search's code (on hover or focus of its buttons); a failure shows when it is opened. */
export const prefetchPalette = () => {
  loadPalette().catch(() => {});
};

/**
 * An open dialog or glossary card (the guard of app/keys.ts). Built once: a browser without the Popover API rejects
 * ':popover-open' with a SyntaxError.
 */
const OVERLAY_SEL = (() => {
  try {
    if (typeof CSS !== 'undefined' && CSS.supports('selector(:popover-open)')) return 'dialog[open], [popover]:popover-open, .pop.is-open';
  } catch {
    /* CSS.supports without selector() */
  }
  return 'dialog[open], .pop.is-open';
})();
const overlayOpen = (): boolean => {
  try {
    return !!document.querySelector(OVERLAY_SEL);
  } catch {
    return !!document.querySelector('dialog[open]');
  }
};

/** The pairing code of a #pair=<code> fragment, or null. */
function pairFromFragment(hash: string): string | null {
  if (!hash.startsWith('#')) return null;
  try {
    return new URLSearchParams(hash.slice(1)).get('pair') || null;
  } catch {
    return null;
  }
}

/** Drop a #pair=<code> fragment without a history entry, as dropParams drops ?pair=. */
function dropPairFragment() {
  if (!pairFromFragment(location.hash)) return;
  navigate(`${location.pathname}${location.search}`, { replace: true, scroll: false });
}

export function OverlaysProvider({ children }: { children: React.ReactNode }) {
  const loc = useLocation();
  const [sheet, setSheet] = useState<SheetRequest | null>(null);
  const [palette, setPalette] = useState<PaletteRequest | null>(null);
  const opener = useRef<HTMLElement | null>(null);

  const remember = () => {
    const a = document.activeElement as HTMLElement | null;
    // a sheet opened from search returns focus to what opened search, not to the closing search box
    if (a?.closest?.('dialog.pal')) return;
    opener.current = a && a !== document.body ? a : null;
  };
  const restore = () => {
    const el = opener.current;
    opener.current = null;
    // After the sheet unmounts and the dialog has released focus. A link inside the sheet that
    // navigates (Account → Devices) calls onClose and then navigate(): the new page (or its #target)
    // takes focus then, so the opener does not take it back.
    const nav = navCount();
    if (el?.isConnected) requestAnimationFrame(() => {
      if (navCount() === nav) el.focus({ preventScroll: true });
    });
  };

  const sheetRef = useRef<SheetRequest | null>(null);
  sheetRef.current = sheet;

  const openSheet = useCallback((req: SheetRequest) => {
    remember();
    setPalette(null);
    setSheet(req);
    if (req.kind === 'address') {
      noteRecent('address', req.address, { label: req.label });
      putParam('addr', req.address);
    } else {
      dropParams('addr');
    }
  }, []);
  const closeSheet = useCallback(() => {
    const cur = sheetRef.current;
    setSheet(null);
    if (cur?.kind === 'address') dropParams('addr');
    if (cur?.kind === 'signin') {
      dropParams('pair');
      dropPairFragment();
    }
    restore();
  }, []);
  const paletteRef = useRef<PaletteRequest | null>(null);
  paletteRef.current = palette;
  const openPalette = useCallback((req: PaletteRequest = {}) => {
    remember();
    setPalette(req);
  }, []);
  const closePalette = useCallback((opts: { restore?: boolean } = {}) => {
    setPalette(null);
    // restore: false keeps the opener for the sheet the chosen item opens (openSheet keeps it too)
    if (opts.restore !== false) restore();
  }, []);
  const togglePalette = useCallback(() => {
    if (paletteRef.current) closePalette();
    else openPalette();
  }, [openPalette, closePalette]);

  // `?` opens the Keys sheet; a handler that ran first (a later keys.ts binding) prevents the default and wins
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.key !== '?' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTextEntry(e.target) || overlayOpen()) return;
      e.preventDefault();
      openSheet({ kind: 'keys' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openSheet]);

  // ?addr= and #pair= (or an old ?pair=) open their sheets (on load, and when Back brings such a URL)
  useEffect(() => {
    const q = new URLSearchParams(loc.search);
    const addr = q.get('addr');
    const pair = pairFromFragment(loc.hash) ?? q.get('pair');
    setSheet((cur) => {
      if (addr && !(cur?.kind === 'address' && cur.address === addr)) return { kind: 'address', address: addr };
      if (!addr && cur?.kind === 'address') return null;
      if (pair && cur?.kind !== 'signin') return { kind: 'signin', code: pair };
      return cur;
    });
  }, [loc.search, loc.hash]);

  const value = useMemo<OverlaysValue>(
    () => ({
      sheet, openSheet, closeSheet, palette, openPalette, closePalette, togglePalette,
      openSources: () => openSheet({ kind: 'sources' }),
      openAddress: (address: string, opts?: { label?: string | null; origin?: AddressOrigin | null }) => openSheet({ kind: 'address', address, label: opts?.label ?? null, origin: opts?.origin ?? null }),
      openSignIn: (code?: string | null) => openSheet({ kind: 'signin', code: code ?? null }),
      openKeys: () => openSheet({ kind: 'keys' }),
    }),
    [sheet, openSheet, closeSheet, palette, openPalette, closePalette, togglePalette],
  );

  return (
    <OverlaysCtx.Provider value={value}>
      {children}
      {/* each overlay under its own boundary: a chunk that did not load (an old tab after a deploy) or a
          sheet that throws shows a small notice with Reload, never a blank app */}
      <PartBoundary onClose={closeSheet} resetKey={sheet ? `${sheet.kind}:${sheet.kind === 'address' ? sheet.address : ''}` : null}>
        <Suspense fallback={null}>
          {sheet?.kind === 'sources' ? <SourcesSheet onClose={closeSheet} /> : null}
          {sheet?.kind === 'address' ? <AddressSheet key={sheet.address} address={sheet.address} origin={sheet.origin ?? null} onClose={closeSheet} /> : null}
          {sheet?.kind === 'signin' ? <SignInSheet code={sheet.code ?? null} onClose={closeSheet} /> : null}
          {sheet?.kind === 'account' ? <AccountSheet onClose={closeSheet} /> : null}
          {sheet?.kind === 'keys' ? <KeysSheet onClose={closeSheet} /> : null}
        </Suspense>
      </PartBoundary>
      <PartBoundary onClose={closePalette} resetKey={palette ? 'open' : null}>
        <Suspense fallback={null}>{palette ? <Palette focus={palette.focus ?? 'search'} onClose={closePalette} /> : null}</Suspense>
      </PartBoundary>
    </OverlaysCtx.Provider>
  );
}
