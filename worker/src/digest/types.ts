// The shapes every digest figure is handed in: a value with its stamp (where it was read and when), or a "not read"
// with the reason and the last answer time. The owner's rules bind each: every number carries its source and its
// "as of" time (R1); a figure whose source was down says "not read" with the last reading's time, never 0 and never
// an old value shown as fresh (R2); nothing is estimated to fill a gap (R3). The message builder renders these; it
// never computes a figure of its own.
import type { Provenance } from '../../../shared/types';

export type DigestKind = 'daily' | 'weekly';

/** Where a figure was read and when. Assignable to shared/types.ts Provenance, so /api answers carry it unchanged. */
export interface Stamp extends Provenance {
  source: string;
  /** unix ms of the reading the figure is as of */
  at: number;
  /** the block the reading describes, when the source names one (a listing, a cursor) */
  height?: number | null;
  /** 'live' within the key's bound of the instant it stands for; 'stale' when older but still shown (a base reading) */
  status: 'live' | 'stale';
  note?: string;
}

/** A figure that could not be read: the reason and when the source last answered; no value, never a 0. */
export interface NotRead {
  notRead: true;
  source: string;
  /** when the source last answered (the last reading's time), or null when it never did */
  lastAt: number | null;
  /** a plain sentence the line prints after "not read —" */
  reason: string;
}

export type Figure<T> = { value: T; stamp: Stamp } | NotRead;

export const isNotRead = (x: unknown): x is NotRead => typeof x === 'object' && x !== null && (x as NotRead).notRead === true;

export function notRead(source: string, lastAt: number | null, reason: string): NotRead {
  return { notRead: true, source, lastAt, reason };
}

/** The reason of a section whose statement failed or did not run (spec section 1: never a missing section, never a 0). */
export const DB_NOT_ANSWERED = 'the database did not answer this read';

/** The value of a figure, or null when it is not read (for arithmetic over two figures). */
export const valueOf = <T>(f: Figure<T> | null | undefined): T | null => (f == null || isNotRead(f) ? null : f.value);

/** One statement's answer: its rows, or why it has none. A section that needs a failed answer is a NotRead. */
export type Answer<T> = { ok: true; rows: T[] } | { ok: false; error: string };

export const answered = <T>(rows: T[]): Answer<T> => ({ ok: true, rows });
export const failed = <T = never>(error: string): Answer<T> => ({ ok: false, error });
/** The answer of a statement that was not run because an answer it needed failed or was empty. */
export const NOT_RUN = 'not run';

/** Thrown inside a section when an answer it needs failed; the section becomes a NotRead with DB_NOT_ANSWERED. */
export class ReadFailed extends Error {
  constructor(readonly source: string, readonly detail: string) { super(`${source}: ${detail}`); }
}

/** The rows of an answer, or a ReadFailed the section's try turns into its NotRead. */
export function rowsOf<T>(a: Answer<T> | null | undefined, source: string): T[] {
  if (!a) throw new ReadFailed(source, NOT_RUN);
  if (!a.ok) throw new ReadFailed(source, a.error);
  return a.rows;
}

/** One row of the metrics table. */
export interface MetricRow { ts: number; value: number }

/** A reading taken from the metrics table, as D1 returned it. */
export type Reading = MetricRow;

/** A 24 h or 7 d change against a base reading, or why there is none. */
export type Change =
  /** the base reading in its window; `baseOff` when it is more than the key's bound before its instant, so the line names its time */
  | { kind: 'ok'; base: Reading; delta: number; pct: number | null; baseOff: boolean }
  /** no reading in [instant − BASE_WINDOW_MS, instant]: "(24 h change not read: no reading between HH:MM and HH:MM UTC yesterday)" */
  | { kind: 'no-base'; from: number; to: number; lastBefore: Reading | null }
  /** the series' first row is after the instant: "(no reading 24 h ago: series starts <first ts>)"; firstTs null when the series has no rows */
  | { kind: 'before-start'; firstTs: number | null };

/** A metrics-backed figure: the reading at T with its change against the base instant. */
export interface MetricFigure { value: number; at: number; change: Change }

/** The window a digest describes: the 24 h (or 7 × 24 h) to T. */
export interface DigestWindow {
  kind: DigestKind;
  /** T, the tick's now */
  now: number;
  /** the window's start: T − 24 h, or T − 7 d */
  from: number;
  /** the window's end, T */
  to: number;
  /** the base instant of every change: `from` */
  baseAt: number;
  /** the span ahead the pipeline and governance look at: 24 h, or 7 d */
  horizonMs: number;
  /** the weekly adds a 30 d price base */
  priceLongBaseAt: number | null;
}

export const HOUR_MS = 3600_000;
export const DAY_MS = 24 * HOUR_MS;
export const WEEK_MS = 7 * DAY_MS;

/** The windows of the two variants (spec settlements 5 and 13: one window, the 24 h or the 7 × 24 h to T). */
export function digestWindow(now: number, kind: DigestKind): DigestWindow {
  const span = kind === 'weekly' ? WEEK_MS : DAY_MS;
  return { kind, now, from: now - span, to: now, baseAt: now - span, horizonMs: span, priceLongBaseAt: kind === 'weekly' ? now - 30 * DAY_MS : null };
}

/** "HH:MM UTC" of a unix ms time, for the reasons of a NotRead. */
export function fmtClock(ms: number): string {
  return `${new Date(ms).toISOString().slice(11, 16)} UTC`;
}

/** "1 h 48 min" of a duration, for the reasons of a NotRead. */
export function fmtSpan(ms: number): string {
  const min = Math.round(Math.max(0, ms) / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h < 48) return m ? `${h} h ${m} min` : `${h} h`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

/** The "not read" reason of a reading older than its bound: "last answered 06:12 UTC, 1 h 48 min ago; the figure is not shown". */
export function staleReason(lastAt: number | null, now: number): string {
  if (lastAt == null) return 'never answered; the figure is not shown';
  return `last answered ${fmtClock(lastAt)}, ${fmtSpan(now - lastAt)} ago; the figure is not shown`;
}
