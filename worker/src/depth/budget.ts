// The depth store's caps (plan section 7, cost.txt section 6) and the kv depth.budget accounting. Each cap is checked
// BEFORE a write: C3 rows written this month (the counter resets on the first tick of a UTC month; the store row is not
// ok and the check warns at the warn mark; at the cap the depth rows and the kv answers stop while the deletes, the
// depth_budget check row and this kv counter go on: a few rows a minute past the cap, counted here, so the Status page
// keeps saying the store is stopped and why), C4 the database size (any statement's size_after past the cap stops
// inserts), C6 the archive puts (step S3 writes them; the counter is here),
// C8 the kill switch kv depth.on = '0', read first by the minute. C1, C2, C5 and C7 live where the pools are cut, the
// requests are counted, the delete runs and the routes read; the caps' figures are in config.ts DepthCaps.
import type { DepthCaps } from './config';
import { kvStmt, KV_KEYS } from './sql';
import { stmt, type Stmt } from '../db';
import { DEPTH_CHECK_TITLES } from '../../../shared/depth';
import type { SourceHealth } from '../../../shared/types';

export interface DepthBudget {
  /** The UTC month the counters are for, 'YYYY-MM'. */
  month: string;
  rowsWritten: number;
  rowsRead: number;
  r2Puts: number;
  r2Bytes: number;
  bytesIn: number;
  /** The last statement's size_after the database reported, bytes. */
  sizeAfter: number | null;
  lastCapHit: { at: number; what: string } | null;
  /** When the counters were last written. */
  at: number;
}

export const monthOf = (now: number): string => new Date(now).toISOString().slice(0, 7);

export const freshBudget = (now: number): DepthBudget => ({ month: monthOf(now), rowsWritten: 0, rowsRead: 0, r2Puts: 0, r2Bytes: 0, bytesIn: 0, sizeAfter: null, lastCapHit: null, at: now });

/** The stored counters for this month: the stored row when its month is this one, else a fresh one (the month reset). A row that does not parse starts fresh. */
export function budgetFor(prev: unknown, now: number): DepthBudget {
  const p = prev as Partial<DepthBudget> | null;
  if (!p || typeof p !== 'object' || p.month !== monthOf(now)) return freshBudget(now);
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return { month: p.month, rowsWritten: n(p.rowsWritten), rowsRead: n(p.rowsRead), r2Puts: n(p.r2Puts), r2Bytes: n(p.r2Bytes), bytesIn: n(p.bytesIn), sizeAfter: typeof p.sizeAfter === 'number' && Number.isFinite(p.sizeAfter) ? p.sizeAfter : null, lastCapHit: p.lastCapHit && typeof p.lastCapHit === 'object' ? p.lastCapHit : null, at: n(p.at) };
}

/** What stops at a cap and what goes on (the few rows that go on are counted). */
export const STOPPED_WORDS = 'inserts stopped; the deletes, the check row and this counter go on';

export interface BudgetGate {
  /** Whether inserts may go ahead. */
  writes: boolean;
  level: 'ok' | 'warn' | 'fail';
  /** Why writes stop or the store warns, in words; null when all is well. */
  why: string | null;
  /** Rows written this month as a share of the cap, percent. */
  pct: number;
}

/**
 * Checked before each write: `pending` is the rows the write would add. Writes stop at the row cap (C3) and past the
 * size cap (C4); the store warns at the warn mark. Deletes are never gated here.
 */
export function gate(b: DepthBudget, caps: DepthCaps, pending: number): BudgetGate {
  const pct = (b.rowsWritten / caps.rowsMonthMax) * 100;
  if (b.sizeAfter != null && b.sizeAfter > caps.d1SizeMax) return { writes: false, level: 'fail', why: `the database is ${(b.sizeAfter / 1e9).toFixed(2)} GB, past the ${(caps.d1SizeMax / 1e9).toFixed(0)} GB cap: ${STOPPED_WORDS}`, pct };
  if (b.rowsWritten >= caps.rowsMonthMax || b.rowsWritten + pending > caps.rowsMonthMax) return { writes: false, level: 'fail', why: `${b.rowsWritten.toLocaleString('en-US')} rows written this month, at the cap of ${caps.rowsMonthMax.toLocaleString('en-US')}: ${STOPPED_WORDS}`, pct };
  if (b.rowsWritten >= caps.rowsWarn) return { writes: true, level: 'warn', why: `${b.rowsWritten.toLocaleString('en-US')} rows written this month, ${pct.toFixed(0)} % of the cap of ${caps.rowsMonthMax.toLocaleString('en-US')}`, pct };
  return { writes: true, level: 'ok', why: null, pct };
}

/** What a D1 batch answers per statement, as far as the budget reads it. */
export interface WriteMeta { meta?: { rows_written?: number; rows_read?: number; changes?: number; size_after?: number } }

/** The counters after a batch: rows_written summed (D1's own count; `changes` when the stand-in gives only that), rows_read summed, the newest size_after kept. */
export function recordWrites(b: DepthBudget, results: readonly WriteMeta[] | null | undefined, now: number): DepthBudget {
  const next = { ...b, at: now };
  for (const r of results ?? []) {
    const m = r?.meta;
    if (!m) continue;
    next.rowsWritten += Number.isFinite(m.rows_written) ? Number(m.rows_written) : Number.isFinite(m.changes) ? Number(m.changes) : 0;
    next.rowsRead += Number.isFinite(m.rows_read) ? Number(m.rows_read) : 0;
    if (Number.isFinite(m.size_after)) next.sizeAfter = Number(m.size_after);
  }
  return next;
}
export const recordBytes = (b: DepthBudget, bytesIn: number): DepthBudget => ({ ...b, bytesIn: b.bytesIn + Math.max(0, bytesIn | 0) });
/** The kv depth.budget row itself, one row a minute: counted before it is written, since its own answer comes back after the counter is in it. */
export const withBudgetRow = (b: DepthBudget): DepthBudget => ({ ...b, rowsWritten: b.rowsWritten + 1 });
export const recordCapHit = (b: DepthBudget, what: string, at: number): DepthBudget => ({ ...b, lastCapHit: { at, what } });
/** An archive object written (C6, step S3). */
export const recordR2Put = (b: DepthBudget, bytes: number): DepthBudget => ({ ...b, r2Puts: b.r2Puts + 1, r2Bytes: b.r2Bytes + Math.max(0, bytes | 0) });

export const STORE_HEALTH = 'Osmosis depth (store)';

/** The store's health row: rows written this month against the cap, the database size, the archive puts; not ok from the warn mark (section 7). */
export function storeHealth(b: DepthBudget, caps: DepthCaps, now: number, extra?: string | null, used?: BudgetGate): SourceHealth {
  const g = used && !used.writes ? used : gate(b, caps, 0);
  const size = b.sizeAfter != null ? `${(b.sizeAfter / 1e9).toFixed(3)} GB` : 'size not reported';
  const note = [g.why ?? `${b.rowsWritten.toLocaleString('en-US')} rows written in ${b.month} (${g.pct.toFixed(1)} % of the cap)`, size, `${b.r2Puts} archive puts`, extra ?? ''].filter(Boolean).join('; ');
  return { name: STORE_HEALTH, ok: g.level === 'ok', at: now, note: note.slice(0, 160) };
}

/** The depth_budget check row: 'warn' from the warn mark, 'fail' when inserts stopped, with the figures in the detail. */
/** `used` is the gate this minute's write went through: a refused write fails the check even when the counter alone would only warn. */
export function budgetCheckStmt(b: DepthBudget, caps: DepthCaps, now: number, used?: BudgetGate): Stmt {
  const g = used && !used.writes ? used : gate(b, caps, 0);
  return stmt.check('depth_budget', g.level, DEPTH_CHECK_TITLES.depth_budget, {
    month: b.month, rowsWritten: b.rowsWritten, rowsMonthMax: caps.rowsMonthMax, pctOfCap: +g.pct.toFixed(2), rowsWarn: caps.rowsWarn,
    rowsRead: b.rowsRead, sizeAfter: b.sizeAfter, d1SizeMax: caps.d1SizeMax, r2Puts: b.r2Puts, r2Bytes: b.r2Bytes, bytesIn: b.bytesIn,
    lastCapHit: b.lastCapHit, why: g.why, writes: g.writes,
  }, now);
}

export const budgetKvStmt = (b: DepthBudget, now: number): Stmt => kvStmt(KV_KEYS.budget, b, now);

/** The kill switch (C8): kv depth.on holding '0' turns the minute off; anything else, or no row, leaves it on. */
export const killSwitchOff = (value: string | null | undefined): boolean => value != null && String(value).trim() === '0';
export const KILL_SWITCH_NOTE = 'Off by the kill switch (kv depth.on is 0): nothing read, nothing written this minute.';
