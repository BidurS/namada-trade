// Keyboard (system.md 3, nav-search-plan 3.3): every binding is in SHORTCUTS below, the one place the words
// and the keys are kept together. 1 to 6 switch tabs, "/" opens search (on the two lists, where their own search
// field is on screen, it focuses that field instead), Ctrl or Cmd + K toggles search, "?" opens the Keys sheet, Escape
// closes the top overlay (native <dialog> behaviour); on the two lists (Holders, Transactions) j and k walk the
// rows, Enter opens the row, [ and ] change the page. Single keys ignore any event with Meta, Ctrl or Alt held
// (so the browser's Cmd-1…5 tab switching passes through), and do nothing while typing in a field or while a
// sheet or the palette is open.
import { useEffect, useRef } from 'react';
import { TABS } from '../../../shared/routes';
import { navigate } from './router';

export interface KeyHandlers {
  openPalette: () => void;
  togglePalette: () => void;
}

/** Where a key does something: on every page, on the two lists, or in search. */
export type KeyWhere = 'everywhere' | 'lists' | 'search';
/** Every key binding, in words (the keyboard hint under the lists is rendered from this table). */
export const SHORTCUTS: readonly { keys: readonly string[]; does: string; where: KeyWhere }[] = [
  { keys: ['1', '6'], does: 'switch view', where: 'everywhere' },
  { keys: ['/'], does: 'search; on the two lists, their own search field', where: 'everywhere' },
  { keys: ['Ctrl K'], does: 'open or close search', where: 'everywhere' },
  { keys: ['Esc'], does: 'close the open sheet', where: 'everywhere' },
  { keys: ['?'], does: 'this list of keys', where: 'everywhere' },
  { keys: ['j', 'k'], does: 'next and previous row', where: 'lists' },
  { keys: ['Enter'], does: 'open the row', where: 'lists' },
  { keys: ['[', ']'], does: 'previous and next page', where: 'lists' },
  { keys: ['↓', '↑'], does: 'next and previous result', where: 'search' },
  { keys: ['Home', 'End'], does: 'first and last result', where: 'search' },
  { keys: ['PgDn', 'PgUp'], does: 'eight results down and up', where: 'search' },
  { keys: ['Enter'], does: 'open the result', where: 'search' },
  { keys: ['@'], does: 'only addresses and names', where: 'search' },
  { keys: ['#'], does: 'only records and blocks', where: 'search' },
  { keys: ['>'], does: 'only actions', where: 'search' },
  { keys: ['Tab'], does: 'keep the typed @, # or > as a chip', where: 'search' },
  { keys: ['Backspace'], does: 'remove the chip from the empty box', where: 'search' },
];

const isTyping = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
};

let slashTarget: HTMLElement | null = null;
/**
 * A list page registers its own search field (the field, or the element around it): "/" then focuses it instead of
 * opening search, while it is on screen (below 1024 px the field is inside the closed Filter sheet, and "/" opens
 * search as everywhere else). Ctrl or Cmd K still opens search.
 */
export function useSlashTarget(ref: { readonly current: HTMLElement | null }) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    slashTarget = el;
    return () => {
      if (slashTarget === el) slashTarget = null;
    };
  }, [ref]);
}
/** The registered field's input, when it is in the page and drawn (an element with no boxes is hidden). */
const slashField = (): HTMLInputElement | HTMLElement | null => {
  const el = slashTarget;
  if (!el || !el.isConnected) return null;
  const input = el instanceof HTMLInputElement ? el : el.querySelector('input');
  const f = (input ?? el) as HTMLElement;
  return f.getClientRects().length > 0 ? f : null;
};

/** Input types that take no typed text: a list key pressed on one of them is not typing. */
const NOT_TEXT = new Set(['radio', 'checkbox', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image']);
/** Typing in a text field (a radio or a checkbox is not one: a list key still works there). */
export const isTextEntry = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  if (el.tagName === 'INPUT') return !NOT_TEXT.has(((el as HTMLInputElement).type || 'text').toLowerCase());
  return el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
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
export function keyAction(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>, typing: boolean, overlay: boolean, slashField = false):
  | { kind: 'toggle-palette' }
  | { kind: 'open-palette' }
  | { kind: 'focus-search' }
  | { kind: 'tab'; path: string }
  | null {
  if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') return { kind: 'toggle-palette' };
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  if (typing || overlay) return null;
  if (e.key === '/') return slashField ? { kind: 'focus-search' } : { kind: 'open-palette' };
  const tab = TABS.find((t) => t.key === e.key);
  return tab ? { kind: 'tab', path: tab.path } : null;
}

export function useGlobalKeys({ openPalette, togglePalette }: KeyHandlers) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const field = slashField();
      const a = keyAction(e, isTyping(e.target), overlayOpen(), !!field);
      if (!a) return;
      if (a.kind === 'toggle-palette') {
        // Ctrl/Cmd K inside the palette's own input closes it too
        e.preventDefault();
        togglePalette();
      } else if (a.kind === 'open-palette') {
        e.preventDefault();
        openPalette();
      } else if (a.kind === 'focus-search') {
        e.preventDefault();
        field!.focus();
        if (field instanceof HTMLInputElement) field.select();
      } else {
        e.preventDefault();
        navigate(a.path);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openPalette, togglePalette]);
}

// ---- the two lists (Holders, Transactions) ---------------------------------------------------
export type ListKey =
  | { kind: 'row'; step: 1 | -1 }
  | { kind: 'edge'; to: 'first' | 'last' }
  | { kind: 'open' }
  | { kind: 'page'; step: 1 | -1 };

/**
 * Pure decision, exported for tests: what a keydown does on a list page. `onRow`: focus is on a row itself
 * (Enter, the arrows, Home and End act only then, so they keep their usual meaning elsewhere).
 * `j`, `k`, `[` and `]` work from anywhere on the page, except while typing or with an overlay open.
 */
export function listKeyAction(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey'>, typing: boolean, overlay: boolean, onRow: boolean): ListKey | null {
  if (e.metaKey || e.ctrlKey || e.altKey || typing || overlay) return null;
  switch (e.key) {
    case 'j': return { kind: 'row', step: 1 };
    case 'k': return { kind: 'row', step: -1 };
    case '[': return { kind: 'page', step: -1 };
    case ']': return { kind: 'page', step: 1 };
    case 'ArrowDown': return onRow ? { kind: 'row', step: 1 } : null;
    case 'ArrowUp': return onRow ? { kind: 'row', step: -1 } : null;
    case 'Home': return onRow ? { kind: 'edge', to: 'first' } : null;
    case 'End': return onRow ? { kind: 'edge', to: 'last' } : null;
    case 'Enter': return onRow ? { kind: 'open' } : null;
    default: return null;
  }
}

/**
 * The list keys while a list is on screen. `rowSel` names a row (".hrow", ".tx"); `handle` gets the action and
 * the row that has focus (or holds it), and returns true when it acted (the key's default is then prevented).
 */
export function useListKeys(rowSel: string, handle: (a: ListKey, row: HTMLElement | null) => boolean) {
  const ref = useRef(handle);
  ref.current = handle;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const t = e.target instanceof Element ? e.target : null;
      const row = (t?.closest(rowSel) as HTMLElement | null) ?? null;
      const a = listKeyAction(e, isTextEntry(e.target), overlayOpen(), !!row && row === t);
      if (a && ref.current(a, row)) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rowSel]);
}
