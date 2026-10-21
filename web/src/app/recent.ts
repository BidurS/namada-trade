// Recent (docs/design/nav-search-plan.md 3.6): what this browser opened from the site, newest and most used first, for
// the search palette's "Recent" group and its ranking. Kept in localStorage under `nt.recent` ONLY: never sent to the
// server or anywhere else (nothing here imports the API client; the privacy line in Settings stays true, and the
// N9 gate checks that no request leaves the site). "Clear recent" in the palette removes the key.
//
// Up to RECENT_MAX entries { kind, key, label?, opens, lastAt }:
//   address  an address opened (its sheet): key is the address, label its plain name when the opener knew it
//   search   a search run from the palette (Enter or a tap on a result found by typing): key is the text typed
//   view     a page chosen from the palette: key is its path, label its name
// Ranked by frecency, opens × 0.5^(days since lastAt / 7): one open a week ago weighs half of one today.
//
// The first build kept five addresses under `nt.recentAddr`; they are read once, moved here, and that key removed.
// Every read and write is in try/catch: a private window, a full quota or blocked storage just means no recents.

export type RecentKind = 'address' | 'search' | 'view';

export interface RecentEntry {
  kind: RecentKind;
  key: string;
  /** plain words for the entry (an address's name, a page's name); absent when not known */
  label?: string;
  /** how many times it was opened */
  opens: number;
  /** when it was last opened (unix ms) */
  lastAt: number;
}

/** The storage key (this browser only). */
export const RECENT_KEY = 'nt.recent';
/** The first build's key: five addresses, newest first. */
export const RECENT_LEGACY_KEY = 'nt.recentAddr';
/** Entries kept. */
export const RECENT_MAX = 20;
/** Entries the palette shows before anything is typed. */
export const RECENT_SHOWN = 5;
/** Frecency half-life, in days. */
export const RECENT_HALF_LIFE_DAYS = 7;

const DAY_MS = 86_400_000;
const KEY_MAX = 300;
const LABEL_MAX = 120;
const KINDS: readonly RecentKind[] = ['address', 'search', 'view'];

/** What the module reads and writes (localStorage in the browser; a stand-in in tests). */
export type RecentStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function browserStore(): RecentStore | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null; // a sandboxed frame throws on the getter itself
  }
}

const tidy = (s: string) => s.replace(/\s+/g, ' ').trim();
/** Two entries are the same when kind and key match; a search's key ignores case. */
const sameKey = (kind: RecentKind, a: string, b: string) => (kind === 'search' ? a.toLowerCase() === b.toLowerCase() : a === b);

function validKey(kind: RecentKind, key: string): boolean {
  if (!key || key.length > KEY_MAX) return false;
  if (kind === 'address') return /^(tnam1|osmo1)[0-9a-z]+$/.test(key);
  if (kind === 'view') return key.startsWith('/') && !key.startsWith('//');
  return true;
}

/** The entries in a stored value; anything malformed is dropped, never guessed. */
function clean(raw: unknown): RecentEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: RecentEntry[] = [];
  for (const v of raw) {
    if (!v || typeof v !== 'object') continue;
    const e = v as Record<string, unknown>;
    const kind = e.kind as RecentKind;
    if (!KINDS.includes(kind) || typeof e.key !== 'string') continue;
    const key = kind === 'search' ? tidy(e.key) : e.key.trim();
    if (!validKey(kind, key)) continue;
    const opens = typeof e.opens === 'number' && Number.isFinite(e.opens) && e.opens >= 1 ? Math.floor(e.opens) : 1;
    const lastAt = typeof e.lastAt === 'number' && Number.isFinite(e.lastAt) && e.lastAt > 0 ? e.lastAt : 0;
    if (!lastAt) continue;
    if (out.some((x) => x.kind === kind && sameKey(kind, x.key, key))) continue;
    const entry: RecentEntry = { kind, key, opens, lastAt };
    if (typeof e.label === 'string' && tidy(e.label)) entry.label = tidy(e.label).slice(0, LABEL_MAX);
    out.push(entry);
  }
  return out.slice(0, RECENT_MAX);
}

function write(store: RecentStore, list: RecentEntry[]) {
  try {
    store.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* not kept: quota or blocked storage */
  }
}

/**
 * Every entry, as stored (most recently written first). Reading the first build's `nt.recentAddr` moves its
 * addresses here once and removes that key.
 */
export function readRecent(store: RecentStore | null = browserStore(), now: number = Date.now()): RecentEntry[] {
  if (!store) return [];
  try {
    const raw = store.getItem(RECENT_KEY);
    if (raw != null) return clean(JSON.parse(raw));
    const legacy = store.getItem(RECENT_LEGACY_KEY);
    if (legacy == null) return [];
    const old = JSON.parse(legacy);
    const list = clean(
      (Array.isArray(old) ? old : [])
        .filter((a: unknown): a is string => typeof a === 'string')
        .slice(0, RECENT_SHOWN)
        // newest first, a minute apart, so the old order survives the ranking
        .map((a: string, i: number) => ({ kind: 'address', key: a.trim(), opens: 1, lastAt: now - i * 60_000 })),
    );
    write(store, list);
    try {
      store.removeItem(RECENT_LEGACY_KEY);
    } catch {
      /* the old key stays; it is read only while the new one is absent */
    }
    return list;
  } catch {
    return [];
  }
}

/** opens × 0.5^(days since lastAt / RECENT_HALF_LIFE_DAYS) */
export function frecency(e: Pick<RecentEntry, 'opens' | 'lastAt'>, now: number = Date.now()): number {
  const days = Math.max(0, now - e.lastAt) / DAY_MS;
  return e.opens * 0.5 ** (days / RECENT_HALF_LIFE_DAYS);
}

/** The `n` best entries by frecency (ties: the newer first). */
export function topRecent(list: readonly RecentEntry[], n: number = RECENT_SHOWN, now: number = Date.now()): RecentEntry[] {
  return [...list].sort((a, b) => frecency(b, now) - frecency(a, now) || b.lastAt - a.lastAt).slice(0, n);
}

/** The frecency of one thing (0 when it was never opened here): the ranking's last tier (section 4.6). */
export function recentScore(list: readonly RecentEntry[], kind: RecentKind, key: string, now: number = Date.now()): number {
  const e = list.find((x) => x.kind === kind && sameKey(kind, x.key, key));
  return e ? frecency(e, now) : 0;
}

/**
 * Count one open. A label replaces the stored one only when given (an open without a name keeps the name an earlier
 * open knew). When the list is full, the entry with the lowest frecency goes. Returns the new list.
 */
export function noteRecent(kind: RecentKind, key: string, opts: { label?: string | null; now?: number; store?: RecentStore | null } = {}): RecentEntry[] {
  const store = opts.store === undefined ? browserStore() : opts.store;
  const now = opts.now ?? Date.now();
  const k = kind === 'search' ? tidy(key) : key.trim();
  if (!store || !validKey(kind, k)) return store ? readRecent(store, now) : [];
  const list = readRecent(store, now);
  const i = list.findIndex((x) => x.kind === kind && sameKey(kind, x.key, k));
  const prev = i >= 0 ? list.splice(i, 1)[0] : null;
  const label = opts.label ? tidy(opts.label).slice(0, LABEL_MAX) : prev?.label;
  const entry: RecentEntry = { kind, key: k, opens: (prev?.opens ?? 0) + 1, lastAt: now };
  if (label) entry.label = label;
  let next = [entry, ...list];
  while (next.length > RECENT_MAX) {
    let worst = 1;
    for (let j = 2; j < next.length; j++) if (frecency(next[j], now) < frecency(next[worst], now)) worst = j;
    next = next.filter((_, j) => j !== worst);
  }
  write(store, next);
  return next;
}

/** "Clear recent": remove the key (and the first build's), so nothing is left on this browser. */
export function clearRecent(store: RecentStore | null = browserStore()) {
  if (!store) return;
  for (const k of [RECENT_KEY, RECENT_LEGACY_KEY]) {
    try {
      store.removeItem(k);
    } catch {
      /* blocked storage: nothing was kept either */
    }
  }
}
