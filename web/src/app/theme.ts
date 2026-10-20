// Theme (F1): dark by default, light by <html data-theme="light">. The choice is stored in
// localStorage['nt.theme'] as 'dark', 'light' or 'system' ("Match my device"), read inside
// try/catch. index.html carries the same resolution as an inline script so the first paint is
// already right; this module keeps it in sync afterwards and follows the device under 'system'.
import { useSyncExternalStore } from 'react';

export type ThemePref = 'dark' | 'light' | 'system';
export type Theme = 'dark' | 'light';

const KEY = 'nt.theme';
const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : null;

export function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'dark';
  } catch {
    return 'dark';
  }
}

export const resolve = (p: ThemePref): Theme => (p === 'system' ? (mq?.matches ? 'light' : 'dark') : p);

let pref: ThemePref = readPref();
const subs = new Set<() => void>();

function apply() {
  const t = resolve(pref);
  // Dark is the attribute left unset ("Unset means dark" in tokens.css). Setting data-theme="dark"
  // would also raise the specificity of the dark token block above the responsive token rules
  // (--header-h, --gutter, --t-display at 640 and 1024 px), so they would never apply.
  if (t === 'light') document.documentElement.setAttribute('data-theme', 'light');
  else document.documentElement.removeAttribute('data-theme');
  // the browser chrome (address bar) follows the header, which is black in both themes
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#000000');
}

export function setThemePref(p: ThemePref) {
  pref = p;
  try {
    localStorage.setItem(KEY, p);
  } catch {
    /* not stored: the choice lasts for this page only */
  }
  apply();
  subs.forEach((f) => f());
}

let started = false;
/** Called once by main.tsx: re-apply (in case the inline script could not run) and follow the device. */
export function startTheme() {
  if (started) return;
  started = true;
  apply();
  mq?.addEventListener?.('change', () => {
    if (pref === 'system') {
      apply();
      subs.forEach((f) => f());
    }
  });
  // another tab changed the choice
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) {
      pref = readPref();
      apply();
      subs.forEach((f) => f());
    }
  });
}

const subscribe = (cb: () => void) => {
  subs.add(cb);
  return () => subs.delete(cb);
};
// the snapshot carries the resolved theme too, so a device switch under 'system' re-renders
const snap = () => `${pref}:${resolve(pref)}`;

/** [stored preference, the theme in use, set] */
export function useTheme(): [ThemePref, Theme, (p: ThemePref) => void] {
  const [p, t] = useSyncExternalStore(subscribe, snap, snap).split(':') as [ThemePref, Theme];
  return [p, t, setThemePref];
}

export const THEME_LABELS: Record<ThemePref, string> = { dark: 'Dark', light: 'Light', system: 'Match my device' };
