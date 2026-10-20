// The overlays host (F1): one sheet at a time (Sources, Address, Sign in, Account) plus the
// search palette. Sheets come from web/src/screens/sheets (S7) and load on first use
// (React.lazy). A sheet component is mounted only while open and opens itself on mount
// (contract in CONTRACT.md); this host returns focus to the control that opened it.
//
// URL state: ?addr=<address> opens the Address sheet (and is written while it is open, so
// the link can be shared); ?pair=<code> opens Sign in on the pair-code step (N5). Both use
// replaceState, never a history entry.
import React, { createContext, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { PartBoundary } from './LoadFailed';
import { dropParams, navCount, putParam, useLocation } from './router';

export type SheetRequest =
  | { kind: 'sources' }
  | { kind: 'address'; address: string }
  | { kind: 'signin'; code?: string | null }
  | { kind: 'account' };

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
  openAddress: (address: string) => void;
  openSignIn: (code?: string | null) => void;
}

const noop = () => {};
const OverlaysCtx = createContext<OverlaysValue>({
  sheet: null, openSheet: noop, closeSheet: noop, palette: null, openPalette: noop, closePalette: noop, togglePalette: noop,
  openSources: noop, openAddress: noop, openSignIn: noop,
});

/** Open and close sheets and the palette from anywhere. */
export const useOverlays = (): OverlaysValue => useContext(OverlaysCtx);

// ---- lazy pieces --------------------------------------------------------------------------
const loadSheets = () => import('../screens/sheets');
const SourcesSheet = lazy(() => loadSheets().then((m) => ({ default: m.SourcesSheet })));
const AddressSheet = lazy(() => loadSheets().then((m) => ({ default: m.AddressSheet })));
const SignInSheet = lazy(() => loadSheets().then((m) => ({ default: m.SignInSheet })));
const AccountSheet = lazy(() => loadSheets().then((m) => ({ default: m.AccountSheet })));
export const loadPalette = () => import('./Palette');
const Palette = lazy(loadPalette);
/** Start downloading search's code (on hover or focus of its buttons); a failure shows when it is opened. */
export const prefetchPalette = () => {
  loadPalette().catch(() => {});
};

const RECENT_KEY = 'nt.recentAddr';
/** Recently opened addresses (this browser only), newest first. */
export function readRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 5) : [];
  } catch {
    return [];
  }
}
function pushRecent(a: string) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([a, ...readRecent().filter((x) => x !== a)].slice(0, 5)));
  } catch {
    /* not stored */
  }
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
      pushRecent(req.address);
      putParam('addr', req.address);
    } else {
      dropParams('addr');
    }
  }, []);
  const closeSheet = useCallback(() => {
    const cur = sheetRef.current;
    setSheet(null);
    if (cur?.kind === 'address') dropParams('addr');
    if (cur?.kind === 'signin') dropParams('pair');
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

  // ?addr= and ?pair= open their sheets (on load, and when Back brings such a URL)
  useEffect(() => {
    const q = new URLSearchParams(loc.search);
    const addr = q.get('addr');
    const pair = q.get('pair');
    setSheet((cur) => {
      if (addr && !(cur?.kind === 'address' && cur.address === addr)) return { kind: 'address', address: addr };
      if (!addr && cur?.kind === 'address') return null;
      if (pair && cur?.kind !== 'signin') return { kind: 'signin', code: pair };
      return cur;
    });
  }, [loc.search]);

  const value = useMemo<OverlaysValue>(
    () => ({
      sheet, openSheet, closeSheet, palette, openPalette, closePalette, togglePalette,
      openSources: () => openSheet({ kind: 'sources' }),
      openAddress: (address: string) => openSheet({ kind: 'address', address }),
      openSignIn: (code?: string | null) => openSheet({ kind: 'signin', code: code ?? null }),
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
          {sheet?.kind === 'address' ? <AddressSheet key={sheet.address} address={sheet.address} onClose={closeSheet} /> : null}
          {sheet?.kind === 'signin' ? <SignInSheet code={sheet.code ?? null} onClose={closeSheet} /> : null}
          {sheet?.kind === 'account' ? <AccountSheet onClose={closeSheet} /> : null}
        </Suspense>
      </PartBoundary>
      <PartBoundary onClose={closePalette} resetKey={palette ? 'open' : null}>
        <Suspense fallback={null}>{palette ? <Palette focus={palette.focus ?? 'search'} onClose={closePalette} /> : null}</Suspense>
      </PartBoundary>
    </OverlaysCtx.Provider>
  );
}
