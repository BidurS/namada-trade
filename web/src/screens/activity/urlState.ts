// Activity (S5): the URL is the state of both lists (docs/design/nav-search-plan.md 2.4, 3.5, 4.3).
//
// - Every filter, the sort, the text, the page and the rows per page live in the query string; React state mirrors
//   nothing. Defaults are left out so canonical links stay short; an unreadable value falls back to the default and
//   is cleaned from the address bar (replaceState), never guessed at. Every other parameter (?at=, ?addr=) is kept.
// - A parameter is written in place (URLSearchParams.set), so it keeps its position and the links stay stable.
// - The list field's text is read with the search grammar (shared/search-grammar.ts). While the reader types, the
//   text stays in ?q= and the list applies what it understood at once; on Enter (or leaving the field) the words that
//   are filters move out of the text into their own parameters (?what=sell&min=100000&since=2026-10-13) and become
//   chips. Identifiers (an address start or end, a record, a block) and free words stay in ?q=: `?addr=` is the
//   Address sheet's parameter (app/overlays.tsx), so an address filter can never live there.
// - Moves pages behind the first carry the server's position (?cursor=, FlowsResponse.next) next to ?page=, so a
//   page read by "›" costs the server an index seek instead of an offset walk and a count (positions below).
import { ADDRESS_PREFIX_MIN, INPUT_MAX, KIND_CHIP, fmtDay, isWholeAddress, parse, removeToken, type Parsed, type ParsedChip, type ParsedField, type ParsedKind } from '../../../../shared/search-grammar';
import { PAGE_SIZE, PAGE_SIZES, decodeFlowCursor, parseBeforeParam, type PageSize } from '../../../../shared/paging';
import type { HoldersBy } from '../../../../shared/types';
import { category_plain } from '../../../../shared/labels';

/** Parameters to set (a string) or remove (null). */
export type Patch = Record<string, string | null>;

/** A URL with parameters set or removed in place (a parameter keeps its position; a new one is added at the end). */
export function hrefWith(patch: Patch, base: string = location.href): string {
  const u = new URL(base, location.origin);
  for (const [k, v] of Object.entries(patch)) {
    if (v == null) u.searchParams.delete(k);
    else u.searchParams.set(k, v);
  }
  return `${u.pathname}${u.search}${u.hash}`;
}

// ---------------------------------------------------------------- values

const DAY = 86_400_000;
const TIME_MIN = Date.UTC(2020, 0, 1);
const TIME_MAX = Date.UTC(2100, 0, 1);

/** A NAM amount in the URL: a plain positive number ("100000", "2.5"); anything else is not one. */
function readAmount(raw: string | null): number | null {
  if (raw == null || !/^\d{1,15}(\.\d{1,6})?$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}
const writeAmount = (n: number | null): string | null => (n != null && n > 0 ? String(Math.round(n * 1e6) / 1e6) : null);

/** A time in the URL: YYYY-MM-DD (that UTC midnight) or unix ms (11 to 14 digits), between 2020 and 2100. */
function readTime(raw: string | null, now: number): number | null {
  if (raw == null) return null;
  let t: number | null = null;
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (d) {
    const v = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]));
    const back = new Date(v);
    if (back.getUTCFullYear() === Number(d[1]) && back.getUTCMonth() === Number(d[2]) - 1 && back.getUTCDate() === Number(d[3])) t = v;
  } else if (/^\d{11,14}$/.test(raw)) t = Number(raw);
  // a time to come is no window at all (a day ahead allowed: a reader east of UTC picks "tomorrow")
  return t != null && t >= TIME_MIN && t < TIME_MAX && t <= now + DAY ? t : null;
}
/** `since` as a day when it is a UTC midnight (short and readable), else unix ms (a rolling "last 24 h"). */
const writeSince = (t: number | null): string | null => (t == null ? null : t % DAY === 0 ? new Date(t).toISOString().slice(0, 10) : String(t));
/** `before` as unix ms, the form the date field has written since it shipped. */
const writeBefore = (t: number | null): string | null => (t == null ? null : String(t));

/** `?page=`: a whole number from 1. */
export function readPage(raw: string | null): number | null {
  if (raw == null || !/^\d{1,6}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 ? n : null;
}
/** `?size=`: one of PAGE_SIZES, written exactly. */
export function readSize(raw: string | null): PageSize | null {
  if (raw == null) return null;
  const n = Number(raw);
  return (PAGE_SIZES as readonly number[]).includes(n) && String(n) === raw ? (n as PageSize) : null;
}
/** `?q=`: the text, at most INPUT_MAX characters, spaces collapsed. */
const readQ = (raw: string | null): string => (raw ?? '').replace(/\s+/g, ' ').trim().slice(0, INPUT_MAX);

/** Read one parameter: its value, and the fix the address bar needs (absent when it is already canonical). */
function field<T>(params: URLSearchParams, name: string, read: (raw: string | null) => T | null, write: (v: T) => string | null, fallback: T, fix: Patch): T {
  const raw = params.get(name);
  if (raw == null) return fallback;
  const v = read(raw);
  if (v == null) {
    fix[name] = null;
    return fallback;
  }
  const canon = write(v);
  if (canon !== raw) fix[name] = canon;
  return v;
}

// ---------------------------------------------------------------- holders

export type HolderChain = 'namada' | 'osmosis' | 'all';
/** The URL's words for the sort; the API's are total, liquid, bonded. */
export type HolderSort = 'total' | 'spendable' | 'staked';
export const SORT_API: Record<HolderSort, HoldersBy> = { total: 'total', spendable: 'liquid', staked: 'bonded' };
export const SORT_URL: Record<HoldersBy, HolderSort> = { total: 'total', liquid: 'spendable', bonded: 'staked' };

export interface HolderUrl {
  chain: HolderChain;
  by: HolderSort;
  /** a raw category in lower case, 'none' (no label), or null (every holder) */
  what: string | null;
  q: string;
  /** NAM on the sort's figure: at least / at most */
  min: number | null;
  max: number | null;
  page: number;
  size: PageSize;
}
export const HOLDER_DEFAULT: HolderUrl = { chain: 'namada', by: 'total', what: null, q: '', min: null, max: null, page: 1, size: PAGE_SIZE };

/** A category in a link: `none`, or a word of the category alphabet that is not one of Object's own member names. */
const CATEGORY_RE = /^(?!(constructor|prototype|__proto__)$)(none|[a-z][a-z0-9_-]{0,31})$/;
const oneOf = <T extends string>(list: readonly T[]) => (raw: string | null): T | null => (list as readonly string[]).includes(raw ?? '') ? (raw as T) : null;

/** The holder list's state from the query string, and what the address bar needs cleaned. */
export function readHolderUrl(params: URLSearchParams): { url: HolderUrl; fix: Patch } {
  const fix: Patch = {};
  const d = HOLDER_DEFAULT;
  const chain = field(params, 'chain', oneOf(['namada', 'osmosis', 'all'] as const), (v) => (v === d.chain ? null : v), d.chain, fix);
  const by = field(params, 'by', oneOf(['total', 'spendable', 'staked'] as const), (v) => (v === d.by ? null : v), d.by, fix);
  const what = field<string | null>(params, 'what', (r) => (r != null && CATEGORY_RE.test(r.toLowerCase()) ? r.toLowerCase() : null), (v) => v, null, fix);
  const q = field(params, 'q', (r) => readQ(r) || null, (v) => v, '', fix);
  const min = field<number | null>(params, 'min', readAmount, writeAmount, null, fix);
  const max = field<number | null>(params, 'max', readAmount, writeAmount, null, fix);
  const page = field(params, 'page', readPage, (v) => (v === 1 ? null : String(v)), 1, fix);
  const size = field<PageSize>(params, 'size', readSize, (v) => (v === PAGE_SIZE ? null : String(v)), PAGE_SIZE, fix);
  return { url: { chain, by, what, q, min, max, page, size }, fix };
}

/** The parameters for a change to the holder list (defaults removed). */
export function holderPatch(p: Partial<HolderUrl>): Patch {
  const out: Patch = {};
  if ('chain' in p) out.chain = p.chain && p.chain !== HOLDER_DEFAULT.chain ? p.chain : null;
  if ('by' in p) out.by = p.by && p.by !== HOLDER_DEFAULT.by ? p.by : null;
  if ('what' in p) out.what = p.what ?? null;
  if ('q' in p) out.q = readQ(p.q ?? '') || null;
  if ('min' in p) out.min = writeAmount(p.min ?? null);
  if ('max' in p) out.max = writeAmount(p.max ?? null);
  if ('page' in p) out.page = p.page && p.page > 1 ? String(p.page) : null;
  if ('size' in p) out.size = p.size && p.size !== PAGE_SIZE ? String(p.size) : null;
  return out;
}

// ---------------------------------------------------------------- moves

export type MoveChain = 'all' | 'namada' | 'osmosis';
export const MOVE_KINDS = Object.keys(KIND_CHIP) as ParsedKind[];

export interface MoveUrl {
  chain: MoveChain;
  /** a kind, a group ('dex', 'ibc'), or null (every kind) */
  what: ParsedKind | null;
  /** at least this many NAM */
  min: number | null;
  /** bot round trips left out (?bots=off) */
  noBots: boolean;
  /** both chains' records of each bridge crossing (?crossings=both); otherwise each crossing once */
  both: boolean;
  q: string;
  /** moves at or after this time (unix ms) */
  since: number | null;
  /** moves strictly before this time (a UTC midnight: the date field, or the grammar's "before 1 Oct") */
  before: number | null;
  /** the server's position of this page (FlowsResponse.next of the page before); page 1 never has one */
  cursor: string | null;
  page: number;
  size: PageSize;
}
export const MOVE_DEFAULT: MoveUrl = { chain: 'all', what: null, min: null, noBots: false, both: false, q: '', since: null, before: null, cursor: null, page: 1, size: PAGE_SIZE };

export function readMoveUrl(params: URLSearchParams, now = Date.now()): { url: MoveUrl; fix: Patch } {
  const fix: Patch = {};
  const d = MOVE_DEFAULT;
  const chain = field(params, 'chain', oneOf(['all', 'namada', 'osmosis'] as const), (v) => (v === d.chain ? null : v), d.chain, fix);
  const what = field<ParsedKind | null>(params, 'what', (r) => (r && r !== 'all' && (MOVE_KINDS as string[]).includes(r) ? (r as ParsedKind) : null), (v) => v, null, fix);
  const min = field<number | null>(params, 'min', readAmount, writeAmount, null, fix);
  const noBots = field(params, 'bots', (r) => (r === 'off' ? true : null), () => 'off', false, fix);
  const both = field(params, 'crossings', (r) => (r === 'both' ? true : null), () => 'both', false, fix);
  const q = field(params, 'q', (r) => readQ(r) || null, (v) => v, '', fix);
  const since = field<number | null>(params, 'since', (r) => readTime(r, now), writeSince, null, fix);
  // ?before= is a day (the date field) or, in links made from the plan's first draft, a position: that moves to ?cursor=
  let before: number | null = null;
  let cursor: string | null = null;
  const rawBefore = params.get('before');
  if (rawBefore != null) {
    const b = parseBeforeParam(rawBefore);
    if (b?.kind === 'cursor') {
      cursor = rawBefore;
      fix.before = null;
      fix.cursor = rawBefore;
    } else {
      before = readTime(rawBefore, now);
      if (before == null) fix.before = null;
      else if (writeBefore(before) !== rawBefore) fix.before = writeBefore(before);
    }
  }
  if (cursor == null) cursor = field<string | null>(params, 'cursor', (r) => (decodeFlowCursor(r) ? r : null), (v) => v, null, fix);
  const page = field(params, 'page', readPage, (v) => (v === 1 ? null : String(v)), 1, fix);
  const size = field<PageSize>(params, 'size', readSize, (v) => (v === PAGE_SIZE ? null : String(v)), PAGE_SIZE, fix);
  // a position belongs to a page after the first
  if (cursor != null && page < 2) {
    cursor = null;
    fix.cursor = null;
  }
  return { url: { chain, what, min, noBots, both, q, since, before, cursor, page, size }, fix };
}

export function movePatch(p: Partial<MoveUrl>): Patch {
  const out: Patch = {};
  if ('chain' in p) out.chain = p.chain && p.chain !== MOVE_DEFAULT.chain ? p.chain : null;
  if ('what' in p) out.what = p.what ?? null;
  if ('min' in p) out.min = writeAmount(p.min ?? null);
  if ('noBots' in p) out.bots = p.noBots ? 'off' : null;
  if ('both' in p) out.crossings = p.both ? 'both' : null;
  if ('q' in p) out.q = readQ(p.q ?? '') || null;
  if ('since' in p) out.since = writeSince(p.since ?? null);
  if ('before' in p) out.before = writeBefore(p.before ?? null);
  if ('page' in p) out.page = p.page && p.page > 1 ? String(p.page) : null;
  if ('cursor' in p) out.cursor = p.cursor ?? null;
  if ('size' in p) out.size = p.size && p.size !== PAGE_SIZE ? String(p.size) : null;
  return out;
}

// ---------------------------------------------------------------- the text, read with the grammar

/** `q` with the given spans cut out (from the end, so the earlier offsets stay right). */
function cut(q: string, spans: [number, number][]): string {
  let s = q;
  for (const [a, b] of [...spans].sort((x, y) => y[0] - x[0])) s = `${s.slice(0, a)} ${s.slice(b)}`;
  return s.replace(/\s+/g, ' ').trim();
}

/** The fields each list moves out of the text into its own parameter. */
const LIFT: Record<'moves' | 'holders', readonly ParsedField[]> = {
  moves: ['kind', 'chain', 'min', 'since', 'until', 'bots', 'crossings'],
  holders: ['what', 'chain', 'min', 'max'],
};
const liftable = (c: ParsedChip, list: 'moves' | 'holders') => c.fields.length > 0 && c.fields.every((f) => LIFT[list].includes(f));

export interface TextRead {
  parsed: Parsed;
  /** the words no chip explains: searched as text */
  free: string[];
  /** chips whose field is a parameter of the list (they move out of the text on Enter) */
  lift: ParsedChip[];
  /** the text without those chips' words */
  rest: string;
}

/** Read a list field's text. `now` pins relative dates ("last 7 days"). */
export function readText(q: string, list: 'moves' | 'holders', now: number): TextRead {
  const parsed = parse(q, { list, now });
  const lift = parsed.chips.filter((c) => liftable(c, list));
  const rest = cut(q, lift.map((c) => c.span));
  const leftover = cut(q, parsed.chips.map((c) => c.span));
  const free = leftover ? parse(leftover, { list, now }).text : [];
  return { parsed, free, lift, rest };
}

/** The text without its free words (a free-text chip removed): the chips' own words, in the order typed. */
export const withoutFree = (q: string, t: TextRead): string => t.parsed.chips.map((c) => q.slice(c.span[0], c.span[1])).join(' ');

// ---------------------------------------------------------------- what a list applies, and its chips

export interface ListChip<U> {
  key: string;
  label: string;
  note?: string;
  /** it filters the list; false: understood but left out (the note says why) */
  applied: boolean;
  /** what removing it writes */
  remove: Partial<U>;
}

const nam = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 6 });
const pad2 = (n: number) => String(n).padStart(2, '0');
const dayOrTime = (t: number) => (t % DAY === 0 ? fmtDay(t) : `${fmtDay(t)} ${pad2(new Date(t).getUTCHours())}:${pad2(new Date(t).getUTCMinutes())} UTC`);

/** The chips of the text: one per understood token, and one for the free words (when there are any). */
function textChips<U extends { q: string }>(q: string, t: TextRead, freeWord: string, keep: (c: ParsedChip) => boolean): ListChip<U>[] {
  const out: ListChip<U>[] = [];
  t.parsed.chips.forEach((c, i) => {
    if (!keep(c)) return;
    out.push({ key: `q${i}:${c.token}`, label: c.label, note: c.note, applied: c.fields.length > 0, remove: { q: removeToken(q, c) } as Partial<U> });
  });
  if (t.free.length) out.push({ key: 'q:free', label: `${freeWord} “${t.free.join(' ')}”`, applied: true, remove: { q: withoutFree(q, t) } as Partial<U> });
  return out;
}

export interface MovesApplied {
  /** the filters as applied: the parameters, with what the text says on top (the reader typed it last) */
  eff: MoveUrl;
  addr: string | null;
  hash: string | null;
  height: number | null;
  /** the free text the server searches (`search=`, addresses and records containing it) */
  search: string;
  text: TextRead;
  chips: ListChip<MoveUrl>[];
  /** filters on (the Filter button's badge) */
  count: number;
}

export function movesApplied(url: MoveUrl, now: number): MovesApplied {
  const t = readText(url.q, 'moves', now);
  const p = t.parsed;
  const fromText = new Set(t.lift.flatMap((c) => c.fields));
  const eff: MoveUrl = {
    ...url,
    what: fromText.has('kind') ? p.kind : url.what,
    chain: fromText.has('chain') ? p.chain ?? url.chain : url.chain,
    min: fromText.has('min') ? p.min : url.min,
    since: fromText.has('since') ? p.since : url.since,
    before: fromText.has('until') ? p.until : url.before,
    noBots: fromText.has('bots') ? true : url.noBots,
    both: fromText.has('crossings') ? true : url.both,
  };
  const chips: ListChip<MoveUrl>[] = [];
  if (!fromText.has('chain') && url.chain !== 'all') chips.push({ key: 'chain', label: url.chain === 'namada' ? 'On Namada' : 'On Osmosis', applied: true, remove: { chain: 'all' } });
  if (!fromText.has('kind') && url.what) chips.push({ key: 'what', label: KIND_CHIP[url.what], applied: true, remove: { what: null } });
  if (!fromText.has('min') && url.min) chips.push({ key: 'min', label: `At least ${nam(url.min)} NAM`, applied: true, remove: { min: null } });
  if (!fromText.has('since') && url.since != null) chips.push({ key: 'since', label: `Since ${dayOrTime(url.since)}`, applied: true, remove: { since: null } });
  if (!fromText.has('until') && url.before != null) chips.push({ key: 'before', label: `Before ${dayOrTime(url.before)}`, applied: true, remove: { before: null } });
  if (!fromText.has('bots') && url.noBots) chips.push({ key: 'bots', label: 'Bot trades left out', applied: true, remove: { noBots: false } });
  if (!fromText.has('crossings') && url.both) chips.push({ key: 'crossings', label: 'Both records of each crossing', applied: true, remove: { both: false } });
  chips.push(...textChips<MoveUrl>(url.q, t, 'Address or record contains', () => true));
  const addr = p.address && (p.address.length >= ADDRESS_PREFIX_MIN || isWholeAddress(p.address)) ? p.address : null;
  return { eff, addr, hash: p.hash, height: p.height, search: p.text.join(' ').trim(), text: t, chips, count: chips.filter((c) => c.applied).length };
}

/** Enter in the moves field: the filter words move into their parameters; identifiers and free words stay. */
export function liftMoves(url: MoveUrl, now: number): Partial<MoveUrl> {
  const a = movesApplied(url, now);
  return { q: a.text.rest, what: a.eff.what, chain: a.eff.chain, min: a.eff.min, since: a.eff.since, before: a.eff.before, noBots: a.eff.noBots, both: a.eff.both };
}

export interface HoldersApplied {
  eff: HolderUrl;
  /** the text the server reads (`search=`): the address start or end and free words; the filter words go as parameters */
  search: string;
  text: TextRead;
  chips: ListChip<HolderUrl>[];
  count: number;
}

const whatLabel = (w: string) => (w === 'none' ? 'Without a label only' : w === 'backer' ? 'Early backers only' : `${category_plain(w) ?? w.charAt(0).toUpperCase() + w.slice(1)} only`);
const sortWord: Record<HolderSort, string> = { total: '', spendable: ' spendable', staked: ' staked' };

export function holdersApplied(url: HolderUrl, now: number): HoldersApplied {
  const t = readText(url.q, 'holders', now);
  const p = t.parsed;
  const fromText = new Set(t.lift.flatMap((c) => c.fields));
  const eff: HolderUrl = {
    ...url,
    what: fromText.has('what') ? p.what : url.what,
    chain: fromText.has('chain') ? p.chain ?? url.chain : url.chain,
    min: fromText.has('min') ? p.min : url.min,
    max: fromText.has('max') ? p.max : url.max,
  };
  const chips: ListChip<HolderUrl>[] = [];
  if (!fromText.has('chain') && url.chain !== 'namada') chips.push({ key: 'chain', label: url.chain === 'osmosis' ? 'On Osmosis' : 'On Namada and Osmosis', applied: true, remove: { chain: 'namada' } });
  if (!fromText.has('what') && url.what) chips.push({ key: 'what', label: whatLabel(url.what), applied: true, remove: { what: null } });
  if (!fromText.has('min') && url.min) chips.push({ key: 'min', label: `At least ${nam(url.min)} NAM${sortWord[url.by]}`, applied: true, remove: { min: null } });
  if (!fromText.has('max') && url.max) chips.push({ key: 'max', label: `At most ${nam(url.max)} NAM${sortWord[url.by]}`, applied: true, remove: { max: null } });
  chips.push(...textChips<HolderUrl>(url.q, t, 'Name or address contains', () => true));
  // the server reads the text itself (parse(…, { list: 'holders' })): it gets the identifiers and the free words, not
  // the filter words (sent as their own parameters) nor the words left out (nothing on the server would apply them)
  const dropped = p.chips.filter((c) => liftable(c, 'holders') || c.fields.length === 0).map((c) => c.span);
  const search = cut(url.q, dropped);
  return { eff, search, text: t, chips, count: chips.filter((c) => c.applied).length };
}

export function liftHolders(url: HolderUrl, now: number): Partial<HolderUrl> {
  const a = holdersApplied(url, now);
  return { q: a.text.rest, what: a.eff.what, chain: a.eff.chain, min: a.eff.min, max: a.eff.max };
}

// ---------------------------------------------------------------- each tab's last URL (the page tabs' links)

const lastSearch = new Map<string, string>();
/** Remember a list's query (without ?at= and ?addr=, which follow the page, not the list). Module memory: a reload starts clean. */
export function rememberList(path: string, search: string) {
  const q = new URLSearchParams(search);
  q.delete('at');
  q.delete('addr');
  const s = q.toString();
  lastSearch.set(path, s ? `?${s}` : '');
}
/** The path with the list's last query, for the page tab that leads back to it. */
export const listPath = (path: string): string => `${path}${lastSearch.get(path) ?? ''}`;

// ---------------------------------------------------------------- moves positions (the cursor of each page seen)

export interface Positions {
  /** the count of these filters, from the last page that carried it (the server counts only without a cursor) */
  total: number | null;
  exact: boolean;
  /** when that count was read */
  countedAt: number | null;
  /** what the server said of that count (FlowsResponse.totalNote) */
  totalNote: string | null;
  /** more than this many match (FlowsResponse.totalOver), from the last first page that said so instead of a count */
  over: number | null;
  /** the server's position for page n (page 1 is the head and has none) */
  cursors: Map<number, string>;
  /** the oldest move in the index for this chain (FlowsResponse.firstTs) */
  firstTs: number | null;
}

const MAX_KEYS = 24;
const positions = new Map<string, Positions>();
/** The positions of one query (filters and rows per page); kept for the tab's life, the 24 most recent queries. */
export function positionsOf(key: string): Positions {
  let p = positions.get(key);
  if (p) {
    positions.delete(key);
    positions.set(key, p);
    return p;
  }
  p = { total: null, exact: true, countedAt: null, totalNote: null, over: null, cursors: new Map(), firstTs: null };
  positions.set(key, p);
  while (positions.size > MAX_KEYS) positions.delete(positions.keys().next().value as string);
  return p;
}
