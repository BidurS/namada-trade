// Paging helpers shared by the Worker and the web UI (docs/design/nav-search-plan.md 2.1, 2.2 and 5): the rows-per-page
// choices, the opaque list cursors, and the index range of an address or record start. Pure: no I/O, no clock.
//
// Cursors are base64url(JSON array). They are opaque to readers (the URL carries them as `?after=` on Holders and
// `?before=` on Activity) and only the Worker makes them; a cursor that does not decode to the expected shape is
// ignored (the head page is served), never guessed at.

/**
 * The rows-per-page choices on both lists, smallest first. The same values as web/src/screens/activity/paging.ts
 * PAGE_SIZES (test/paging.test.ts holds the two equal until that module re-exports these).
 */
export const PAGE_SIZES = [25, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZES)[number];
/** Rows per page when `?size=` is absent. */
export const PAGE_SIZE: PageSize = 50;
/** The `limit` the list routes accept (worker/src/api.ts clamps to this range). */
export const LIMIT_MIN = 10;
export const LIMIT_MAX = 100;
/** `?limit=` as the list routes read it: a whole number clamped to LIMIT_MIN…LIMIT_MAX, PAGE_SIZE when absent or unreadable. */
export function clampLimit(raw: string | null | undefined): number {
  const n = raw == null || raw === '' ? NaN : Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return PAGE_SIZE;
  return Math.min(LIMIT_MAX, Math.max(LIMIT_MIN, n));
}

/** The longest cursor read: anything longer is not one of ours (and is not parsed at all). */
export const CURSOR_MAX_LENGTH = 400;

export type CursorPart = string | number;

// ---------------------------------------------------------------- base64url without Buffer (Workers, browsers, Node)

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s) || s.length % 4 === 1) return null;
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

/** An opaque cursor: base64url of the JSON array of `parts` (strings and finite numbers only). */
export function encodeCursor(parts: readonly CursorPart[]): string {
  for (const p of parts) {
    if (typeof p === 'number' ? !Number.isFinite(p) : typeof p !== 'string') throw new Error('cursor parts are strings and finite numbers');
  }
  return toBase64Url(JSON.stringify(parts));
}

/**
 * The parts of a cursor made by encodeCursor, or null for anything else: absent, too long, not base64url, not
 * JSON, not a non-empty array of strings and finite numbers. A null cursor means "the head page", never an error.
 */
export function decodeCursor(raw: string | null | undefined): CursorPart[] | null {
  if (!raw || raw.length > CURSOR_MAX_LENGTH) return null;
  const text = fromBase64Url(raw);
  if (text == null) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(v) || v.length === 0 || v.length > 8) return null;
  for (const p of v) if (!(typeof p === 'string' || (typeof p === 'number' && Number.isFinite(p)))) return null;
  return v as CursorPart[];
}

// ---------------------------------------------------------------- the two list cursors

/** A bech32 address as the holder index stores it (lowercase), within any chain's length. */
const ADDRESS_RE = /^(tnam1|osmo1)[02-9ac-hj-np-z]{6,90}$/;
const ROW_ID_RE = /^[\x21-\x7e]{1,200}$/;

/**
 * Holders keyset position (`?after=`, HoldersResponse.next): the last row of the previous page in the list's order
 * (`ORDER BY <sort column> DESC, address`): its sort value (total, spendable or staked NAM), its address, and the
 * rank it was printed with, so the next page's ranks continue from it (rank + i + 1).
 */
export interface HolderCursor {
  value: number;
  address: string;
  rank: number;
}

export const encodeHolderCursor = (c: HolderCursor): string => encodeCursor([c.value, c.address, c.rank]);

/** A holders cursor, or null when `raw` is not one (the route then serves `page`, or the head page). */
export function decodeHolderCursor(raw: string | null | undefined): HolderCursor | null {
  const p = decodeCursor(raw);
  if (!p || p.length !== 3) return null;
  const [value, address, rank] = p;
  if (typeof value !== 'number' || value < 0) return null;
  if (typeof address !== 'string' || !ADDRESS_RE.test(address)) return null;
  if (typeof rank !== 'number' || !Number.isInteger(rank) || rank < 1) return null;
  return { value, address, rank };
}

/**
 * Moves keyset position (`?before=`, FlowsResponse.next): the last row of the previous page in the feed's order
 * (`ORDER BY f.ts DESC, f.height DESC, f.id DESC`, flows-query.ts FLOWS_ORDER).
 */
export interface FlowCursor {
  ts: number;
  height: number;
  id: string;
}

export const encodeFlowCursor = (c: FlowCursor): string => encodeCursor([c.ts, c.height, c.id]);

/** A moves cursor, or null when `raw` is not one. */
export function decodeFlowCursor(raw: string | null | undefined): FlowCursor | null {
  const p = decodeCursor(raw);
  if (!p || p.length !== 3) return null;
  const [ts, height, id] = p;
  if (typeof ts !== 'number' || !Number.isInteger(ts) || ts <= 0) return null;
  if (typeof height !== 'number' || !Number.isInteger(height) || height < 0) return null;
  if (typeof id !== 'string' || !ROW_ID_RE.test(id)) return null;
  return { ts, height, id };
}

/** The earliest and latest time a plain `?before=<unix ms>` may name (2020 to 2100): outside it is not a time. */
const TIME_MIN = Date.UTC(2020, 0, 1);
const TIME_MAX = Date.UTC(2100, 0, 1);

/**
 * `?before=` on /api/flows and /api/series/trades: a moves cursor (the rows after one already shown), or a plain
 * unix-ms time (a date jump: rows strictly older than it), or null (absent or neither: the head page).
 */
export type BeforeParam = { kind: 'cursor'; cursor: FlowCursor } | { kind: 'time'; ts: number };

export function parseBeforeParam(raw: string | null | undefined): BeforeParam | null {
  if (!raw) return null;
  if (/^\d{11,14}$/.test(raw)) {
    const ts = Number(raw);
    return ts >= TIME_MIN && ts < TIME_MAX ? { kind: 'time', ts } : null;
  }
  const cursor = decodeFlowCursor(raw);
  return cursor ? { kind: 'cursor', cursor } : null;
}

// ---------------------------------------------------------------- prefix ranges

/**
 * The half-open range [lo, hi) of every string that starts with `prefix`, for an index range read
 * (`col >= lo AND col < hi`) on a BINARY column: SQLite uses an index for `LIKE 'x%'` only on a NOCASE column, and
 * the address and hash columns are BINARY. `hi` is the prefix with its last character incremented
 * (`prefixRange('tnam1qz')` is `['tnam1qz', 'tnam1q{']`); bech32 (lowercase letters and digits) and upper-case hex
 * stay inside printable ASCII. Null for an empty prefix (it would select everything).
 */
export function prefixRange(prefix: string): [string, string] | null {
  let p = prefix;
  while (p.length > 0) {
    const last = p.charCodeAt(p.length - 1);
    if (last < 0xffff) return [prefix, p.slice(0, -1) + String.fromCharCode(last + 1)];
    p = p.slice(0, -1);
  }
  return null;
}
