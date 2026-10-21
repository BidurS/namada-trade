// The search palette (system.md 8 "Palette (search)"; docs/design/nav-search-plan.md 4.6 and 4.7): a modal dialog,
// full height on phones with the input at the top (16 px text, so iOS does not zoom) and the results scrolling under
// it, 640 px centred from 1024 px. "/" and Ctrl or Cmd K open it; Escape and a tap outside close it (a text selection
// dragged outside does not); focus returns to what opened it, or goes to the new page or the sheet the chosen item
// opens. Lazy-loaded.
//
// One box finds everything:
//   - local groups, computed on every keystroke before any request answers: Lists (the search grammar's filters as a
//     link to the moves or holders list, shared/search-grammar.ts), Views, Actions, the typed whole address, and
//     before typing Recent (this browser only, app/recent.ts) and a short list of views and actions;
//   - server groups from /api/search (Addresses, Records, Blocks, Names, Pools), 150 ms after typing pauses, each
//     request cancelled when the text changes (lib/useQuery.ts); a late answer for older text is never shown;
//   - the glossary as a plain list under the results (its rows are not actions, so they are not options);
//   - the Rewind row at the foot, where it was.
// Inside a group: exact match, then the start of the value, then its end, then a word start, then inside it; then
// how often and how lately it was opened here; ties keep the server's order. Nothing fuzzy on addresses or hashes.
// A scope prefix (@ addresses and names, # records and blocks, > actions, ? glossary) keeps only its groups; Tab
// turns it into a chip, Backspace in the empty box removes the chip.
// The input is an ARIA combobox over a listbox of groups (focus stays in the input, aria-activedescendant moves);
// one status line says "N results in M groups" once the results have stopped changing for half a second.
// A search that fails says so; it never reads as "nothing matches".
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { SearchGroup, SearchResponse, SearchResult } from '../../../shared/types';
import { ROUTES, TABS, type RouteId } from '../../../shared/routes';
import { HASH_PREFIX_MIN, INPUT_MAX, isWholeAddress, parse, removeToken, type ParsedChip, type ParsedField } from '../../../shared/search-grammar';
import { ApiError, searchGrouped } from '../api';
import { GLOSSARY, type GlossaryEntry } from '../lib/glossary';
import { explorerTx, fmtAddr, fmtCount, fmtPctSigned, fmtUtcLong } from '../lib/format';
import { kindInfo } from '../lib/kinds';
import { useQuery } from '../lib/useQuery';
import { Icon, type GridIconName } from '../ui/Icon';
import { useOverlays } from './overlays';
import { clearRecent, noteRecent, readRecent, recentScore, topRecent, type RecentEntry } from './recent';
import { useReplay, REWIND_WORDS } from './replay';
import { navigate } from './router';
import { useSession } from './session';
import { TAB_ICON } from './TabBar';
import { THEME_LABELS, useTheme, type ThemePref } from './theme';

// ---------------------------------------------------------------- the model (pure; exported for the shell spec)

/** The palette's groups. The server's are SearchGroup; the rest are computed here. */
export type GroupId = SearchGroup | 'recent' | 'lists' | 'views' | 'actions';

export const GROUP_TITLE: Record<GroupId, string> = {
  recent: 'Recent',
  addresses: 'Addresses',
  records: 'Records',
  blocks: 'Blocks',
  names: 'Names',
  pools: 'Pools',
  lists: 'Lists',
  views: 'Views',
  actions: 'Actions',
};

/** Group order while typing (section 4.6): what the text names first, then where to go, then what to do. */
export const TYPING_ORDER: readonly GroupId[] = ['addresses', 'records', 'blocks', 'names', 'pools', 'lists', 'views', 'actions'];
/** Group order before typing. */
export const IDLE_ORDER: readonly GroupId[] = ['recent', 'views', 'actions'];
/** The groups the server fills (each capped at GROUP_MAX). */
const SERVER_GROUPS = new Set<GroupId>(['addresses', 'records', 'blocks', 'names', 'pools']);

export type Scope = 'names' | 'records' | 'actions' | 'glossary';
/** The scope prefixes (section 3.3): the character typed first, what it keeps, and how the input describes it. */
export const SCOPES: Record<string, { scope: Scope; label: string; describe: string; groups: readonly GroupId[]; server: boolean }> = {
  '@': { scope: 'names', label: 'Addresses and names', describe: 'Searching addresses and names', groups: ['recent', 'addresses', 'names'], server: true },
  '#': { scope: 'records', label: 'Records and blocks', describe: 'Searching records and blocks', groups: ['records', 'blocks'], server: true },
  '>': { scope: 'actions', label: 'Actions', describe: 'Searching actions', groups: ['actions'], server: false },
  '?': { scope: 'glossary', label: 'Glossary', describe: 'Searching the glossary', groups: [], server: false },
};
const PREFIX_OF: Record<Scope, string> = { names: '@', records: '#', actions: '>', glossary: '?' };

/** Text needed before the server is asked (shorter text matches too much to be worth a request). */
export const SERVER_MIN_CHARS = 3;
/** The pause after typing before the server is asked (section 4.4). */
export const SERVER_DEBOUNCE_MS = 150;
/** An answer reused without a request for this long (the edge keeps /api/search for 15 s, section 4.5). */
export const SEARCH_STALE_MS = 15_000;
/** The status line speaks once the results have stopped changing for this long (section 4.7). */
export const SETTLE_MS = 500;
/** Page Down and Page Up move the active result this many rows. */
export const PAGE_STEP = 8;
/** Results kept per server group (the server's own default limit). */
export const GROUP_MAX = 6;

/** Split the typed text into a scope (from the chip, or a prefix typed first) and the text searched. */
export function splitScope(input: string, chip: Scope | null): { scope: Scope | null; text: string; typedPrefix: string | null } {
  if (chip) return { scope: chip, text: input.trim(), typedPrefix: null };
  const c = input.trimStart().charAt(0);
  const s = SCOPES[c];
  if (s) return { scope: s.scope, text: input.trimStart().slice(1).trim(), typedPrefix: c };
  return { scope: null, text: input.trim(), typedPrefix: null };
}

/** Match tiers: 0 exact, 1 start of the value, 2 its end, 3 a word start, 4 inside, NO_MATCH none. */
export const NO_MATCH = 9;
const TIER_OF_MATCH: Record<string, number> = { exact: 0, start: 1, end: 2, word: 3, contains: 4 };
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The best tier of `term` against any of `values` (case ignored). */
export function textTier(term: string, ...values: (string | null | undefined)[]): number {
  const t = term.trim().toLowerCase();
  if (!t) return NO_MATCH;
  const wordStart = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(t)}`, 'u');
  let best = NO_MATCH;
  for (const v of values) {
    if (!v) continue;
    const s = v.toLowerCase();
    if (s === t) return 0;
    if (s.startsWith(t)) best = Math.min(best, 1);
    else if (s.endsWith(t) && /^[0-9a-z]+$/.test(t)) best = Math.min(best, 2);
    else if (wordStart.test(s)) best = Math.min(best, 3);
    else if (s.includes(t)) best = Math.min(best, 4);
  }
  return best;
}

/** The group a server result belongs to. A server before nav step 5 sends no `group`: it is read from `type`, and two
 *  of its echoes are dropped, since they name nothing that exists: an address result for any tnam1… text, and a pool
 *  for any number (a block height of 5 or more digits is not a pool id). */
export function groupOfResult(r: SearchResult): SearchGroup | null {
  if (r.group) return r.group;
  switch (r.type) {
    case 'address': return isWholeAddress(r.value.toLowerCase()) ? 'addresses' : null;
    case 'tx': return 'records';
    case 'label':
    case 'validator': return 'names';
    case 'pool': return /^\d{1,4}$/.test(r.value) ? 'pools' : null;
    case 'block': return 'blocks';
    default: return null;
  }
}

/** A server result's tier: the server's own `match` when it says, otherwise read from its text here. */
export function resultTier(r: SearchResult, term: string): number {
  if (r.match && r.match in TIER_OF_MATCH) return TIER_OF_MATCH[r.match];
  const t = textTier(term, r.value, r.title, r.label_plain);
  return t === NO_MATCH ? TIER_OF_MATCH.contains : t;
}

/** Does an earlier answer still match the longer text typed since (kept on screen while the new one is asked)? */
export function stillMatches(r: SearchResult, term: string): boolean {
  const t = term.trim().toLowerCase();
  return [r.value, r.title, r.subtitle, r.label_plain].some((v) => !!v && v.toLowerCase().includes(t));
}

export interface ListRow {
  list: 'moves' | 'holders';
  label: string;
  href: string;
  /** what was typed but is not a filter there, in the grammar's words */
  leftOut: string[];
}

/** The fields each list takes as its own URL parameters (screens/activity/urlState.ts); the rest stay in ?q=. */
const LIST_PARAMS: Record<ListRow['list'], readonly ParsedField[]> = {
  moves: ['kind', 'chain', 'min', 'since', 'until', 'bots', 'crossings'],
  holders: ['what', 'chain', 'min', 'max'],
};
const DAY_MS = 86_400_000;
const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);
const applied = (c: ParsedChip) => c.fields.some((f) => f !== 'text');

function listRow(list: ListRow['list'], text: string, now: number): ListRow | null {
  const p = parse(text, { list, now });
  const shown = p.chips.filter(applied);
  if (!shown.length) return null;
  const own = LIST_PARAMS[list];
  const q = new URLSearchParams();
  if (list === 'moves') {
    if (p.kind) q.set('what', p.kind);
    if (p.chain) q.set('chain', p.chain);
    if (p.min != null) q.set('min', String(p.min));
    // a UTC midnight as its day (the list writes it so), a rolling time as unix ms
    if (p.since != null) q.set('since', p.since % DAY_MS === 0 ? new Date(p.since).toISOString().slice(0, 10) : String(p.since));
    if (p.until != null) q.set('before', String(p.until));
    if (p.bots) q.set('bots', 'off');
    if (p.crossings) q.set('crossings', 'both');
  } else {
    if (p.what) q.set('what', p.what);
    if (p.chain) q.set('chain', p.chain);
    if (p.min != null) q.set('min', String(p.min));
    if (p.max != null) q.set('max', String(p.max));
  }
  // the rest stays as typed in ?q=: identifiers (an address start or end, a record, a block) and free words, which the
  // list reads with the same grammar (`?addr=` is the Address sheet's parameter, so an address never goes there).
  // Words this list does not apply are left out of the link; the row says so.
  let rest = text;
  const moved = p.chips.filter((c) => !c.fields.length || c.fields.every((f) => own.includes(f)));
  for (const c of moved.sort((a, b) => b.span[0] - a.span[0])) rest = removeToken(rest, c);
  if (rest) q.set('q', rest);
  return {
    list,
    label: `${list === 'moves' ? 'Moves' : 'Holders'}: ${shown.map((c) => lowerFirst(c.label)).join(', ')}`,
    href: `${list === 'moves' ? '/activity' : '/holders'}?${q}`,
    leftOut: p.chips.filter((c) => !c.fields.length).map((c) => c.label),
  };
}

/**
 * The "Lists" rows (section 4.6): what the grammar read, as a link to the moves list and to the holders list, each
 * shown when at least one token that list applies was read. The list's own parameters follow its URL
 * (screens/activity/urlState.ts): filters as parameters, everything else in ?q=.
 */
export function listRows(text: string, now: number = Date.now()): ListRow[] {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return [];
  return [listRow('moves', t, now), listRow('holders', t, now)].filter((r): r is ListRow => r != null);
}

/** Is there anything in the text the server can look up (not only sizes, dates and options)? */
export function serverTerm(text: string): string | null {
  const t = text.trim();
  if (t.length < SERVER_MIN_CHARS) return null;
  const p = parse(t);
  const lookup = p.text.length > 0 || p.address != null || p.tail != null || p.hash != null || p.height != null || p.pool != null || p.kind != null || p.what != null || p.chain != null;
  return lookup ? t : null;
}

/** "N results in M groups" (one result, one group in the singular). */
export const countWords = (n: number, g: number): string => (n ? `${fmtCount(n)} ${n === 1 ? 'result' : 'results'} in ${fmtCount(g)} ${g === 1 ? 'group' : 'groups'}` : 'No results');

// ---------------------------------------------------------------- items

interface Item {
  id: string;
  group: GroupId;
  label: string;
  /** an address, short form, in mono under the label */
  addr?: string;
  /** the label is itself an address (set in mono) */
  mono?: boolean;
  sub?: string;
  icon?: GridIconName;
  hint?: string;
  tier: number;
  /** frecency on this browser */
  score: number;
  /** the source's order (the server's, the table's) */
  order: number;
  /** a search worth keeping in Recent when it is run */
  search?: boolean;
  run: () => void;
}

/** A dated moment worth rewinding to, from the build-time exports (web/src/generated, W4). */
export interface RewindPreset {
  at: number;
  label: string;
  note?: string;
}

/**
 * The Rewind presets (system.md 8): the three biggest price moves in docs/events.json and the
 * replay report's example (the first alert before the largest move out of the staking account, owner
 * decision 3). Every figure is a field of the generated exports; nothing is typed here.
 */
async function loadPresets(): Promise<RewindPreset[]> {
  try {
    const [{ PRICE_MOVES }, { PROOF }] = await Promise.all([import('../generated/events'), import('../generated/proof')]);
    const out: RewindPreset[] = [];
    const w = PROOF.rewindExample;
    if (w) out.push({ at: w.rewindAt, label: `The first alert before ${Math.round(w.amountNam / 1e6)} million NAM ${w.kind === 'withdraw' ? 'were withdrawn from staking' : 'moved out of the staking account in one transfer'}`, note: fmtUtcLong(w.rewindAt) });
    const biggest = [...PRICE_MOVES].sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct)).slice(0, 3);
    for (const m of biggest) {
      const hours = Math.round((m.t1 - m.t0) / 3_600_000);
      out.push({ at: m.t0, label: `Just before a ${fmtPctSigned(m.pct, 1)} price move over ${hours} h`, note: fmtUtcLong(m.t0) });
    }
    return out.sort((a, b) => a.at - b.at);
  } catch {
    return [];
  }
}

const ROUTE_ICON: Partial<Record<RouteId, GridIconName>> = { holders: 'activity', settings: 'account', staking: 'supply', osmosis: 'trade', learn: 'info', faq: 'info' };
const toUtcInput = (ms: number) => new Date(ms).toISOString().slice(0, 16);
const chainWord = (chain: string | undefined, value: string) => ((chain ?? (value.startsWith('osmo1') ? 'osmosis' : 'namada')) === 'osmosis' ? 'Osmosis address' : 'Namada address');
const upperFirst = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const byRank = (a: Item, b: Item) => a.tier - b.tier || b.score - a.score || a.order - b.order;

/** A first-build record ("sell 12345 NAM", "block 8294006 on namada · ABC…") in the site's words. */
function oldRecordWords(r: SearchResult): { label: string; sub?: string } {
  const m = /^([a-z_]+) ([\d,]+) NAM$/.exec(r.title ?? '');
  const label = m ? `${kindInfo(m[1], r.chain).word}, ${m[2]} NAM` : r.title;
  const sub = r.subtitle?.replace(/^block (\d+) on (namada|osmosis)/, (_, h: string, c: string) => `Block ${fmtCount(Number(h))} on ${c === 'osmosis' ? 'Osmosis' : 'Namada'}`);
  return { label, sub };
}

export default function Palette({ focus, onClose }: { focus: 'search' | 'rewind'; onClose: (opts?: { restore?: boolean }) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const rewindRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const { openSources, openSignIn, openSheet, openKeys } = useOverlays();
  const { at, rewound, setAt, backToNow } = useReplay();
  const { session, signOut } = useSession();
  const [themePref, , setTheme] = useTheme();

  const [q, setQ] = useState('');
  const [chip, setChip] = useState<Scope | null>(null);
  /** The result the keys moved to; null follows the top result (it resets whenever the text changes). */
  const [activeId, setActiveId] = useState<string | null>(null);
  const [recent, setRecent] = useState<RecentEntry[]>(() => readRecent());
  const [cleared, setCleared] = useState(false);
  /** Where the last press started and ended: the scrim closes only when both were on it. */
  const press = useRef({ down: false, up: false });
  const [presets, setPresets] = useState<RewindPreset[]>([]);
  const [when, setWhen] = useState(() => toUtcInput(at ?? Date.now() - 86_400_000));
  const [whenError, setWhenError] = useState<string | null>(null);
  const maxWhen = useMemo(() => toUtcInput(Date.now()), []);

  // open as a modal; Escape and close return focus to the opener (native dialog behaviour)
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (!d.open) {
      d.setAttribute('closedby', 'any'); // native light dismiss where supported (it tracks press and release)
      try {
        d.showModal();
      } catch {
        d.setAttribute('open', '');
      }
    }
    (focus === 'rewind' ? rewindRef.current : inputRef.current)?.focus();
    const onCancel = (e: Event) => {
      e.preventDefault();
      onClose();
    };
    d.addEventListener('cancel', onCancel);
    return () => {
      d.removeEventListener('cancel', onCancel);
      if (d.open) d.close();
    };
  }, [focus, onClose]);

  useEffect(() => {
    let alive = true;
    loadPresets().then((p) => alive && setPresets(p));
    return () => {
      alive = false;
    };
  }, []);

  const { scope, text, typedPrefix } = splitScope(q, chip);
  const scopeDef = scope ? SCOPES[PREFIX_OF[scope]] : null;

  // the server groups: current data (it does not take a rewound time), asked 150 ms after typing pauses; a newer
  // text cancels the request for the older one, and an answer for older text is never shown
  const sTerm = !scopeDef || scopeDef.server ? serverTerm(text) : null;
  const serverKey = sTerm ? `search:${sTerm}` : null;
  const query = useQuery<SearchResponse>(serverKey, (signal) => searchGrouped(sTerm!, { signal }), { debounceMs: SERVER_DEBOUNCE_MS, keepPrevious: true, staleMs: SEARCH_STALE_MS });
  const failed = !!serverKey && query.settled && query.error != null;
  // too many searches: the server's own words (section 4.5)
  const failReason = failed && query.error instanceof ApiError && query.error.status === 429 && query.error.reason ? query.error.reason.replace(/[.\s]+$/, '') : null;
  const prevTerm = query.previousKey?.slice('search:'.length) ?? null;
  // while the longer text is asked, the earlier answer's results that still match it stay (no flicker, nothing false)
  const results: SearchResult[] = useMemo(() => {
    if (!sTerm) return [];
    if (query.data) return query.data.results;
    if (query.busy && query.previous && prevTerm && sTerm.toLowerCase().startsWith(prevTerm.toLowerCase())) return query.previous.results.filter((r) => stillMatches(r, sTerm));
    return [];
  }, [sTerm, query.data, query.busy, query.previous, prevTerm]);

  const close = () => onClose();
  /** Close for an item that opens a sheet: the sheet returns focus to what opened search. */
  const handOff = () => onClose({ restore: false });
  const go = (path: string) => {
    close();
    navigate(path);
  };
  /** Open an address's sheet; its plain name, when known here, goes with it into Recent. */
  const openAddr = (address: string, label?: string | null) => {
    handOff();
    openSheet({ kind: 'address', address, label });
  };

  const items = useMemo<Item[]>(() => {
    const now = Date.now();
    const term = text;
    const typing = !!term || !!scope;
    const out: Item[] = [];
    const show = (g: GroupId) => (scopeDef ? scopeDef.groups.includes(g) : typing ? TYPING_ORDER.includes(g) : IDLE_ORDER.includes(g));
    const local = (...values: (string | undefined)[]) => (term ? textTier(term, ...values) : NO_MATCH - 1);

    // Recent: before typing, and under the @ scope with nothing typed yet (addresses only)
    if (show('recent') && !term) {
      const list = topRecent(scope === 'names' ? recent.filter((e) => e.kind === 'address') : recent, undefined, now);
      list.forEach((e, i) => {
        const base = { id: `r:${e.kind}:${e.key}`, group: 'recent' as const, tier: 0, score: 0, order: i };
        if (e.kind === 'address') out.push({ ...base, label: e.label ?? fmtAddr(e.key), mono: !e.label, addr: e.label ? fmtAddr(e.key) : undefined, sub: chainWord(undefined, e.key), icon: 'account', run: () => openAddr(e.key, e.label) });
        else if (e.kind === 'search') out.push({ ...base, label: `Search again: ${e.key}`, icon: 'search', run: () => { setChip(null); setQ(e.key); setActiveId(null); } });
        else out.push({ ...base, label: e.label ?? e.key, sub: 'Page', icon: 'arrow', run: () => { noteRecent('view', e.key, { label: e.label }); go(e.key); } });
      });
    }

    // Addresses: a whole address typed or pasted first, then the server's
    if (show('addresses')) {
      const a = term.toLowerCase();
      const fromServer = results.some((r) => groupOfResult(r) === 'addresses' && r.value.toLowerCase() === a);
      if (isWholeAddress(a) && !fromServer) out.push({ id: 'a:typed', group: 'addresses', label: fmtAddr(a), mono: true, sub: `Open this address on ${a.startsWith('osmo1') ? 'Osmosis' : 'Namada'}`, icon: 'account', tier: 0, score: Number.MAX_SAFE_INTEGER, order: -1, run: () => openAddr(a) });
    }

    // the server's groups (one row per thing: a second result for the same value in the same group is dropped)
    const seen = new Set<string>();
    results.forEach((r, i) => {
      const g = groupOfResult(r);
      if (!g || !show(g)) return;
      const id = `s:${g}:${r.value}`;
      if (seen.has(id)) return;
      seen.add(id);
      const fresh = !!r.group; // a server from nav step 5 on: its words are used as sent
      const base = { id, group: g, tier: resultTier(r, term), order: i, search: g !== 'addresses' && g !== 'names' };
      if (g === 'addresses' || g === 'names') {
        const name = r.label_plain || (r.title && r.title !== r.value && !r.title.startsWith(r.value) ? r.title : null);
        const sub = fresh
          ? r.subtitle
          : [r.category_plain ?? (r.type === 'validator' ? 'Validator' : undefined), chainWord(r.chain, r.value)].filter(Boolean).join(' · ');
        out.push({ ...base, label: name ?? fmtAddr(r.value), mono: !name, addr: name ? fmtAddr(r.value) : undefined, sub, icon: 'account', score: recentScore(recent, 'address', r.value, now), run: () => openAddr(r.value, name) });
      } else if (g === 'records') {
        const words = fresh ? { label: r.title, sub: r.subtitle } : oldRecordWords(r);
        const href = r.href ?? null;
        const ext = r.external ?? (href ? null : explorerTx(r.chain ?? 'namada', r.value));
        const how = href ? 'On the moves list' : 'On the explorer, in a new tab';
        out.push({
          ...base, label: words.label, sub: [words.sub, how].filter(Boolean).join(' · '), icon: href ? 'activity' : 'external', score: 0,
          run: () => {
            if (href) go(href);
            else if (ext) {
              close();
              window.open(ext, '_blank', 'noopener');
            }
          },
        });
      } else if (g === 'blocks') {
        const href = r.href ?? `/activity?height=${encodeURIComponent(r.value)}`;
        out.push({ ...base, label: r.title, sub: [r.subtitle, 'On the moves list'].filter(Boolean).join(' · '), icon: 'activity', score: 0, run: () => go(href) });
      } else {
        const href = r.href ?? '/trade';
        out.push({ ...base, label: r.title, sub: fresh ? r.subtitle : 'Pool depth and reserves, on the Trade page', icon: 'trade', score: 0, run: () => go(href) });
      }
    });

    // Lists: the grammar's filters as a filtered list
    if (show('lists') && term) {
      listRows(term, now).forEach((row, i) =>
        out.push({
          id: `l:${row.list}`, group: 'lists', label: row.label, icon: 'filter', tier: 0, score: 0, order: i, search: true,
          sub: [row.list === 'moves' ? 'The transactions list' : 'The holders list', row.leftOut.length ? `left out: ${row.leftOut.join('; ')}` : ''].filter(Boolean).join(', '),
          run: () => go(row.href),
        }),
      );
    }

    // Views: the six tabs first, then the other pages (those only when typed for)
    if (show('views')) {
      const view = (path: string, label: string, sub: string | undefined, icon: GridIconName, hint: string | undefined, i: number) => {
        const tier = local(label, sub);
        if (term && tier === NO_MATCH) return;
        // before typing the tabs keep their order (and their keys); while typing, pages opened here before rank higher
        out.push({ id: `v:${path}`, group: 'views', label, sub, icon, hint, tier, score: term ? recentScore(recent, 'view', path, now) : 0, order: i, run: () => { noteRecent('view', path, { label }); go(path); } });
      };
      TABS.forEach((t, i) => view(t.path, t.label, ROUTES.find((x) => x.id === t.id)?.h1, TAB_ICON[t.id], t.key, i));
      ROUTES.forEach((r, i) => {
        if (TABS.some((t) => t.id === r.id)) return;
        if (r.id === 'settings' && !session) return;
        if (!term && r.id !== 'holders') return;
        view(r.path, r.label, r.h1, ROUTE_ICON[r.id] ?? 'arrow', undefined, TABS.length + i);
      });
    }

    // Actions
    if (show('actions')) {
      const idle = !term && !scope;
      type A = { id: string; label: string; sub?: string; icon: GridIconName; idle?: boolean; run: () => void };
      const actions: A[] = [
        { id: 'x:sources', label: 'Where every number comes from', sub: 'Sources, ages and cross-checks', icon: 'check', idle: true, run: () => { handOff(); openSources(); } },
        ...(rewound ? [{ id: 'x:now', label: REWIND_WORDS.back, sub: at ? REWIND_WORDS.banner(at) : undefined, icon: 'rewind' as const, idle: true, run: () => { close(); backToNow(); } }] : []),
        ...(recent.length ? [{ id: 'x:clear', label: 'Clear recent', sub: 'Forget the addresses, searches and pages opened from search on this browser', icon: 'close' as const, idle: true, run: () => { clearRecent(); setRecent([]); setCleared(true); setActiveId(null); } }] : []),
        { id: 'x:keys', label: 'Keys', sub: 'Every keyboard shortcut and what it does', icon: 'info', idle: true, run: () => { handOff(); openKeys(); } },
        ...(session
          ? [
              { id: 'x:settings', label: 'Settings', sub: 'Alert rules, where alerts go, devices, your data', icon: 'account' as const, run: () => go('/settings') },
              { id: 'x:account', label: 'Account', sub: `Signed in as ${fmtAddr(session.address)}`, icon: 'account' as const, run: () => { handOff(); openSheet({ kind: 'account' }); } },
              { id: 'x:out', label: 'Sign out on this device', icon: 'close' as const, run: () => { close(); void signOut(); } },
            ]
          : [{ id: 'x:signin', label: 'Sign in with your Namada wallet', sub: 'To choose alerts and where they go. Nothing moves.', icon: 'account' as const, run: () => { handOff(); openSignIn(); } }]),
        ...(['dark', 'light', 'system'] as ThemePref[])
          .filter((p) => p !== themePref)
          .map((p) => ({ id: `x:theme:${p}`, label: p === 'system' ? 'Appearance: match my device' : `Appearance: ${THEME_LABELS[p].toLowerCase()}`, icon: 'info' as const, run: () => { setTheme(p); close(); } })),
      ];
      actions.forEach((a, i) => {
        if (idle && !a.idle) return;
        const tier = local(a.label, a.sub);
        if (term && tier === NO_MATCH) return;
        out.push({ id: a.id, group: 'actions', label: a.label, sub: a.sub, icon: a.icon, tier, score: 0, order: i, run: a.run });
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, scope, results, recent, session, rewound, at, themePref]);

  // groups in their order, each ranked and capped
  const groups = useMemo(() => {
    const order = text || scope ? TYPING_ORDER : IDLE_ORDER;
    const ids: GroupId[] = scope === 'names' && !text ? ['recent'] : [...order];
    return ids
      .map((g) => {
        const list = items.filter((i) => i.group === g).sort(byRank);
        return { id: g, items: SERVER_GROUPS.has(g) ? list.slice(0, GROUP_MAX) : list };
      })
      .filter((g) => g.items.length);
  }, [items, text, scope]);
  const runnable = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const activeItem = (activeId != null ? runnable.find((i) => i.id === activeId) : undefined) ?? runnable[0];
  const optionId = (i: Item) => `${listId}-o${runnable.indexOf(i)}`;

  // the glossary: words, not actions, so a plain list under the results
  const glossary: GlossaryEntry[] = useMemo(() => {
    if (scope === 'glossary') return text ? GLOSSARY.filter((g) => textTier(text, g.plain, g.expert, g.text) !== NO_MATCH) : GLOSSARY;
    if (scope || text.length < 2) return [];
    return GLOSSARY.filter((g) => textTier(text, g.plain, g.expert, g.text) !== NO_MATCH);
  }, [text, scope]);

  // a new text starts from the top result
  useEffect(() => {
    setActiveId(null);
    setCleared(false);
  }, [q, chip]);
  useEffect(() => {
    if (!activeItem) return;
    document.getElementById(optionId(activeItem))?.scrollIntoView({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeItem?.id]);

  // the status line: the count once the results have stopped changing for SETTLE_MS (per keystroke is noise)
  const settled = !serverKey || query.settled;
  const statusNow = (() => {
    if (!text && !scope) return cleared ? JSON.stringify(['Recent cleared.', '']) : '';
    const parts: string[] = [];
    // a failed search is never announced as "No results": the count is said only for what is listed
    if (scope !== 'glossary' && (!failed || runnable.length > 0)) parts.push(countWords(runnable.length, groups.length));
    if (glossary.length || scope === 'glossary') parts.push(`${fmtCount(glossary.length)} ${glossary.length === 1 ? 'word' : 'words'} in the glossary`);
    // the reason announced is the one the note under the results shows (the server's words on a refusal); it is
    // spoken here and seen there, never printed twice
    const fail = failed ? `${failReason ?? 'The search service did not answer'}; pages and words still work.` : '';
    const shown = parts.length ? `${parts.join(', and ')}.` : '';
    return shown || fail ? JSON.stringify([shown, fail]) : '';
  })();
  const [status, setStatus] = useState('');
  useEffect(() => {
    if (!statusNow) {
      setStatus('');
      return;
    }
    if (!settled) return;
    const t = setTimeout(() => setStatus(statusNow), SETTLE_MS);
    return () => clearTimeout(t);
  }, [statusNow, settled]);
  // what the line shows, and the failure it only speaks (the note under the results shows that one)
  const [statusShown, statusSpoken] = status ? (JSON.parse(status) as [string, string]) : ['', ''];

  const rawInput = chip ? `${PREFIX_OF[chip]}${q}` : q;
  const runItem = (i: Item) => {
    // a search run from here (Enter, or a tap on a result found by typing) is kept in this browser's Recent
    if (i.search && text) noteRecent('search', rawInput.trim());
    i.run();
  };
  const move = (to: number) => {
    if (!runnable.length) return;
    const n = Math.max(0, Math.min(runnable.length - 1, to));
    setActiveId(runnable[n].id);
  };
  const at0 = activeItem ? runnable.indexOf(activeItem) : -1;

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
    if (e.key === 'Escape') {
      // a search field would only clear itself on the first Escape; the palette closes at once
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      move(at0 + (e.key === 'ArrowDown' ? 1 : -1));
    } else if ((e.key === 'PageDown' || e.key === 'PageUp') && plain) {
      e.preventDefault();
      move(at0 + (e.key === 'PageDown' ? PAGE_STEP : -PAGE_STEP));
    } else if ((e.key === 'Home' || e.key === 'End') && plain && !e.shiftKey && runnable.length) {
      e.preventDefault();
      move(e.key === 'Home' ? 0 : runnable.length - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeItem) runItem(activeItem);
      else query.flush(); // nothing to run yet: ask the server now instead of after the pause
    } else if (e.key === 'Tab' && !e.shiftKey && plain && typedPrefix && !chip) {
      // accept the typed prefix as a chip
      e.preventDefault();
      setChip(SCOPES[typedPrefix].scope);
      setQ(q.trimStart().slice(1).trimStart());
    } else if (e.key === 'Backspace' && chip && !q && plain) {
      e.preventDefault();
      setChip(null);
    }
  };

  const submitRewind = (e: FormEvent) => {
    e.preventDefault();
    const t = Date.parse(`${when}:00Z`);
    if (!Number.isFinite(t)) return setWhenError('Pick a date and a time.');
    if (t > Date.now()) return setWhenError('Pick a time in the past.');
    setWhenError(null);
    close();
    setAt(t);
  };

  // the sentence under the results about the server's part: a failure is never "nothing matches"; when the text was
  // read as list filters, the Lists row is the answer and "no match" would add nothing
  const found = runnable.some((i) => i.id.startsWith('s:') || i.id === 'a:typed' || i.group === 'lists');
  const note = !sTerm || !settled
    ? null
    : failed
      ? `${failReason ?? 'The search service did not answer'}; pages and words still work.`
      : !found
        ? `No address, record or name matches “${sTerm}”.`
        : null;

  return (
    <dialog
      ref={ref}
      className="pal"
      aria-label="Search"
      onPointerDown={(e) => {
        press.current = { down: e.target === e.currentTarget, up: false };
      }}
      onPointerUp={(e) => {
        press.current.up = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        // a tap on the scrim: pressed and released there. A text selection dragged out of the box ends
        // with a click on the dialog too (the common ancestor), and must not close it.
        const p = press.current;
        press.current = { down: false, up: false };
        if (e.target === e.currentTarget && p.down && p.up) close();
      }}
    >
      <div className="pal__top">
        <div className="pal__head">
          <Icon name="search" />
          {chip ? (
            <span className="pal__scope">
              <span className="pal__scope-t">{SCOPES[PREFIX_OF[chip]].label}</span>
              <button
                type="button"
                className="pal__scope-x"
                aria-label={`Search everything again, not only ${SCOPES[PREFIX_OF[chip]].label.toLowerCase()}`}
                onClick={() => {
                  setChip(null);
                  inputRef.current?.focus();
                }}
              >
                <Icon name="close" />
              </button>
            </span>
          ) : null}
          <input
            ref={inputRef}
            className="pal__in"
            type="search"
            enterKeyHint="go"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder={chip ? 'Type to search' : 'An address, a name or a page'}
            aria-label="Search addresses, names, records, pages and words"
            aria-description={scopeDef ? scopeDef.describe : undefined}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={runnable.length > 0}
            aria-controls={listId}
            aria-activedescendant={activeItem ? optionId(activeItem) : undefined}
            value={q}
            maxLength={INPUT_MAX}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <button type="button" className="pal__x" aria-label="Close" onClick={close}>
            <Icon name="close" />
          </button>
        </div>
        {/* one polite line, spoken once the results have settled */}
        <p className="pal__status" role="status" aria-live="polite" data-on={text || scope || statusShown ? '' : undefined}>
          {statusShown}
          {statusSpoken ? <span className="sr-only">{statusShown ? ' ' : ''}{statusSpoken}</span> : null}
        </p>
      </div>

      <div className="pal__body">
        {!text && !scope ? <p className="pal__tip">Start with @ for addresses and names, # for records, &gt; for actions, ? for the glossary.</p> : null}
        <div id={listId} role="listbox" aria-label="Results" hidden={!runnable.length}>
          {groups.map((g) => {
            const hid = `${listId}-g-${g.id}`;
            return (
              <div key={g.id} role="group" aria-labelledby={hid} className="pal__g">
                <p id={hid} className="pal__gh">{GROUP_TITLE[g.id]}</p>
                <div className="pal__list">
                  {g.items.map((i) => (
                    <div
                      key={i.id}
                      id={optionId(i)}
                      role="option"
                      aria-selected={activeItem?.id === i.id}
                      aria-describedby={hid}
                      className="pal__opt"
                      onMouseDown={(e) => e.preventDefault() /* the input keeps focus */}
                      onClick={() => runItem(i)}
                      onMouseMove={() => activeItem?.id !== i.id && setActiveId(i.id)}
                    >
                      {i.icon ? <Icon name={i.icon} /> : null}
                      <span className="pal__ot">
                        <span className={i.mono ? 'pal__l pal__l--mono' : 'pal__l'}>{i.label}</span>
                        {i.addr || i.sub ? (
                          <span className="pal__s">
                            {i.addr ? <span className="pal__a">{i.addr}</span> : null}
                            {i.addr && i.sub ? ' · ' : null}
                            {i.sub ? (i.addr ? i.sub : upperFirst(i.sub)) : null}
                          </span>
                        ) : null}
                      </span>
                      {i.hint ? <kbd className="pal__k kbd-hint" aria-hidden="true">{i.hint}</kbd> : null}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        {note ? <p className="pal__note">{note}</p> : null}
        {scope === 'records' && !text ? <p className="pal__note">{`Type the first ${HASH_PREFIX_MIN} characters of a record, or a block number.`}</p> : null}

        {glossary.length ? (
          <section className="pal__g" aria-labelledby={`${listId}-gl`}>
            <p id={`${listId}-gl`} className="pal__gh">Glossary</p>
            <dl className="pal__gloss">
              {glossary.map((g) => (
                <div key={g.id} className="pal__gi">
                  <dt>
                    <span className="pal__l">{g.plain}</span>
                    <span className="pal__x2">{g.expert}</span>
                  </dt>
                  <dd className="pal__s">{g.text}</dd>
                </div>
              ))}
            </dl>
          </section>
        ) : null}

        <section className="pal__g" aria-labelledby={`${listId}-rw`}>
          <p id={`${listId}-rw`} className="pal__gh">Rewind</p>
          <form className="pal__rw" onSubmit={submitRewind}>
            <div className="pal__rwrow">
              <label className="pal__rwl">
                See every number as it was at (UTC)
                <input ref={rewindRef} className="pal__dt" type="datetime-local" step={60} max={maxWhen} value={when} onChange={(e) => setWhen(e.target.value)} required />
              </label>
              <button type="submit" className="pal__go">
                Rewind
                <Icon name="rewind" className="ico ico--btn" />
              </button>
            </div>
            {whenError ? <p className="pal__note" role="alert">{whenError}</p> : null}
            {presets.length ? (
              <div className="pal__pre" aria-label="Moments worth a look">
                {presets.map((p) => (
                  <button key={p.at} type="button" onClick={() => { close(); setAt(p.at); }}>
                    {p.label}
                    <small>{p.note ?? fmtUtcLong(p.at)}</small>
                  </button>
                ))}
              </div>
            ) : null}
          </form>
        </section>
      </div>
    </dialog>
  );
}
