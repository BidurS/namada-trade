// The Ask chat's page-level state: open or closed, who opened it, whether the chat is there at all. Small on purpose,
// so the line on the page costs almost nothing; the panel itself is lazy-loaded the first time it opens. Nothing here
// (or in the thread) outlives the page: no storage of any kind.
import { useSyncExternalStore } from 'react';
import { ASK_SHOWN, type AskState } from '../../../../shared/ask-words';

interface Store { open: boolean; opened: boolean; state: AskState | null; hasThread: boolean }

let store: Store = { open: false, opened: false, state: null, hasThread: false };
let opener: HTMLElement | null = null;
let asked = false;
const subs = new Set<() => void>();
const set = (p: Partial<Store>) => { store = { ...store, ...p }; subs.forEach((f) => f()); };
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };

export const useAskStore = (): Store => useSyncExternalStore(subscribe, () => store);

/** Once per page load, and only with the flag on: whether to show the chat, and whether it is resting. */
export function loadAskState(): void {
  if (!ASK_SHOWN || asked) return;
  asked = true;
  fetch('/api/ask')
    .then((r) => (r.ok ? (r.json() as Promise<AskState>) : null))
    .then((s) => set({ state: s ?? { state: 'unavailable', text: '' } }))
    .catch(() => set({ state: { state: 'unavailable', text: '' } }));
}

export function openAsk(from: HTMLElement | null): void {
  opener = from;
  set({ open: true, opened: true });
}

/** Closes the chat and gives focus back to whatever opened it. */
export function closeAsk(): void {
  if (!store.open) return;
  set({ open: false });
  const r = opener;
  opener = null;
  // the line that opened it may be gone (the reader followed a page link): the page takes focus, never nothing
  (r && r.isConnected ? r : document.getElementById('main'))?.focus({ preventScroll: true });
}

export const setAskThread = (hasThread: boolean): void => { if (store.hasThread !== hasThread) set({ hasThread }); };
export const setAskResting = (text: string): void => set({ state: { state: 'resting', text } });
