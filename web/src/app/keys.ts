// Keyboard (system.md 3): 1 to 6 switch tabs, "/" opens search, Ctrl or Cmd + K toggles it,
// Escape closes the top overlay (native <dialog> behaviour). Digits and "/" ignore any event
// with Meta, Ctrl or Alt held, so the browser's Cmd-1…5 tab switching passes through, and they
// do nothing while typing or while a sheet or the palette is open.
import { useEffect } from 'react';
import { TABS } from '../../../shared/routes';
import { navigate } from './router';

export interface KeyHandlers {
  openPalette: () => void;
  togglePalette: () => void;
}

const isTyping = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
};

/**
 * An open dialog or glossary card. Built once: a browser without the Popover API rejects
 * ':popover-open' with a SyntaxError, which would make every keydown throw (no shortcut would work).
 * There the cards open with .is-open instead (ui/Term.tsx).
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

/** Pure decision, exported for tests: what a keydown does. */
export function keyAction(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>, typing: boolean, overlay: boolean):
  | { kind: 'toggle-palette' }
  | { kind: 'open-palette' }
  | { kind: 'tab'; path: string }
  | null {
  if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') return { kind: 'toggle-palette' };
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  if (typing || overlay) return null;
  if (e.key === '/') return { kind: 'open-palette' };
  const tab = TABS.find((t) => t.key === e.key);
  return tab ? { kind: 'tab', path: tab.path } : null;
}

export function useGlobalKeys({ openPalette, togglePalette }: KeyHandlers) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const a = keyAction(e, isTyping(e.target), overlayOpen());
      if (!a) return;
      if (a.kind === 'toggle-palette') {
        // Ctrl/Cmd K inside the palette's own input closes it too
        e.preventDefault();
        togglePalette();
      } else if (a.kind === 'open-palette') {
        e.preventDefault();
        openPalette();
      } else {
        e.preventDefault();
        navigate(a.path);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openPalette, togglePalette]);
}
