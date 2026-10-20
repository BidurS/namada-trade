// Holder rows: how fresh each one is (W2, owner decision 7), how liquid balances are kept current
// (W13), and real 24-hour and 7-day changes from recorded balance readings.
//
// How a holder's spendable (liquid) balance is written:
// - Namada: the LiveHub writes the post-balance of every NAM transfer it sees in a block
//   (`stmt.namadaBalance`, `updated_at` only), and the cron re-reads a rolling batch of addresses
//   straight from the chain every tick (`refreshLiquidBalances`, sets `verified_at`). Before W13 only
//   the 2026-10-15 backfill and the protocol accounts were ever read from the chain, so balances of
//   addresses that did not move kept that date.
// - Osmosis: the cron reads the full holder list from the Osmosis bank every 10 minutes.
// Each chain read is also recorded in `balance_spans` (migration 0003), which is what the changes
// are computed from. Nothing is ever filled with 0 when unknown: a change is null until readings exist.
import type { Stmt } from './db';
import { INTERNAL_LABELS } from './config';
import { toNam } from './util';
import { LIQUID_STALE_MS } from '../../shared/holder-status';

const H = 3600000, D = 86400000;

/**
 * Addresses re-read from the chain per cron tick, and how many at once. ≤ 2 requests each (one per node, no
 * retries). Six at once: a Worker keeps at most six connections open, and a seventh request waits in a queue
 * while its own timeout runs.
 */
export const LIQUID_PER_TICK = 50;
export const LIQUID_CONCURRENCY = 6;
/** The refresh stops starting new reads after this long, so a slow node cannot run into the next tick. */
export const LIQUID_TIME_BUDGET_MS = 20_000;

/** Two readings of the same balance further apart than this start a new span (nothing is assumed across a gap). */
export const SPAN_MAX_GAP_MS = 6 * H;
/** Spans that ended before this are deleted (nothing older than 7 days is ever asked for). */
export const SPAN_KEEP_MS = 8 * D;


// ---------------------------------------------------------------- status (W2): shared/holder-status.ts

export { holderStatus, LIQUID_STALE_MS, BONDED_FRESH_MS, CONFLICT_NAM, type HolderStatusInput } from '../../shared/holder-status';

// ---------------------------------------------------------------- the holder list

/** Protocol accounts are not holders (shared by the list, its count, the overview and the server-rendered page). */
export const INTERNAL_ADDRS = Object.keys(INTERNAL_LABELS);
const notInternal = (col: string) => `${col} NOT IN (${INTERNAL_ADDRS.map((a) => `'${a}'`).join(',')})`;

/**
 * Pool accounts hold NAM on behalf of the people who added it, as protocol accounts do: not holders. Every pool
 * the Osmosis quote service lists is labelled category 'pool' by the cron (and the backfill), so the label is
 * the test. The Osmosis denominators (supply.osmosis) still include what the pools hold.
 */
export const notPool = (col: string) => `NOT EXISTS (SELECT 1 FROM labels lp WHERE lp.address = ${col} AND lp.category = 'pool')`;

/** Namada rows are the union of spendable holders and stakers; Osmosis rows have no stake. Protocol and pool accounts excluded. */
export const HOLDERS_UNION = `
  SELECT chain, address FROM holders WHERE balance_num > 0 AND ${notInternal('address')} AND ${notPool('holders.address')}
  UNION SELECT 'namada', address FROM stakes WHERE COALESCE(bonded_num, estimated_num, 0) > 0 AND ${notInternal('address')}`;

/** Total NAM of the 10 largest Osmosis holders, protocol and pool accounts left out. */
export const OSMOSIS_TOP10_SQL = `SELECT SUM(balance_num) s, MIN(COALESCE(verified_at, updated_at)) at FROM (SELECT balance_num, verified_at, updated_at FROM holders
  WHERE chain='osmosis' AND ${notInternal('address')} AND ${notPool('holders.address')} ORDER BY balance_num DESC LIMIT 10)`;

/**
 * Holder counts per chain, with the same definition as the list, and when each chain's holder rows were last
 * written (`namada_at`, `osmosis_at`: the newest updated_at), so a count is stamped with its data's time.
 */
export const HOLDER_COUNTS_SQL = `SELECT SUM(CASE WHEN chain='namada' THEN 1 ELSE 0 END) namada, SUM(CASE WHEN chain='osmosis' THEN 1 ELSE 0 END) osmosis,
  (SELECT MAX(updated_at) FROM holders WHERE chain='namada') namada_at, (SELECT MAX(updated_at) FROM holders WHERE chain='osmosis') osmosis_at
  FROM (${HOLDERS_UNION})`;

/**
 * Total NAM of the 10 largest Namada holders (spendable + staked), and `at`: the oldest reading among them. Per
 * row the reading is the older of its spendable balance (the later of its chain read and its last transfer) and
 * its stake (chain read, else the estimate's time); a missing side is not counted (SQLite's MIN/MAX of a NULL is
 * NULL, so each case is spelled out).
 */
export const NAMADA_TOP10_SQL = `SELECT SUM(t) s, MIN(rd) at FROM (SELECT t,
    CASE WHEN hs IS NULL THEN ss WHEN ss IS NULL THEN hs WHEN hs < ss THEN hs ELSE ss END rd
  FROM (SELECT COALESCE(h.balance_num,0) + COALESCE(s.bonded_num, s.estimated_num, 0) t,
    CASE WHEN h.address IS NULL THEN NULL WHEN COALESCE(h.verified_at, 0) > COALESCE(h.updated_at, 0) THEN h.verified_at ELSE h.updated_at END hs,
    CASE WHEN s.address IS NULL THEN NULL ELSE COALESCE(s.verified_at, s.updated_at) END ss
  FROM (SELECT address FROM holders WHERE chain='namada' UNION SELECT address FROM stakes) x
  LEFT JOIN holders h ON h.chain='namada' AND h.address = x.address LEFT JOIN stakes s ON s.address = x.address
  WHERE ${notInternal('x.address')} ORDER BY t DESC LIMIT 10))`;

// ---------------------------------------------------------------- the rolling refresh (W13)

/**
 * The Namada addresses to re-read this tick, including stakers that have no holder row yet. Rows that are
 * old (never read, or read more than LIQUID_STALE_MS ago) come first, largest holding (spendable + staked)
 * first, so after a gap the rows people look at are fresh again within a tick or two; then rows that are
 * still fresh, read longest ago first (a round robin). Protocol accounts are read every tick elsewhere.
 * Parameters: the stale cut-off (now − LIQUID_STALE_MS), then the limit.
 */
export const LIQUID_DUE_SQL = `
  SELECT address FROM (
    SELECT h.address, h.verified_at v, h.balance_num + COALESCE(s.bonded_num, s.estimated_num, 0) b
      FROM holders h LEFT JOIN stakes s ON s.address = h.address WHERE h.chain = 'namada'
    UNION ALL
    SELECT s.address, NULL, COALESCE(s.bonded_num, s.estimated_num, 0) FROM stakes s
     WHERE COALESCE(s.bonded_num, s.estimated_num, 0) > 0
       AND NOT EXISTS (SELECT 1 FROM holders h WHERE h.chain = 'namada' AND h.address = s.address)
  ) WHERE ${notInternal('address')} AND address LIKE 'tnam1%'
  ORDER BY (COALESCE(v, 0) >= ?) ASC, CASE WHEN COALESCE(v, 0) >= ?1 THEN v END ASC, b DESC, address
  LIMIT ?`;

/**
 * A spendable balance read from the chain at `height`. Ignored when the row already holds a newer
 * post-balance (a transfer the LiveHub saw after the block this read answered for), so a read never
 * overwrites a newer figure; the address then stays first in line for the next tick.
 */
export function liquidReadStmt(chain: string, address: string, balance: string, height: number, at: number, src: string): Stmt {
  return {
    sql: `INSERT INTO holders (chain,address,balance,balance_num,updated_height,updated_at,verified_at,verified_src)
          VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT(chain,address) DO UPDATE SET
            balance=excluded.balance, balance_num=excluded.balance_num, updated_height=excluded.updated_height,
            updated_at=excluded.updated_at, verified_at=excluded.verified_at, verified_src=excluded.verified_src
          WHERE excluded.updated_height >= COALESCE(holders.updated_height, 0)`,
    params: [chain, address, balance, toNam(balance), height, at, at, src],
  };
}

/**
 * Osmosis: after a complete read of every holder (all verified at `at`), an address that is no longer in
 * the list holds no NAM there. Without this its last balance would be shown forever.
 */
export function osmosisDroppedStmt(at: number): Stmt {
  return {
    sql: `UPDATE holders SET balance='0', balance_num=0, updated_at=?, verified_at=?, verified_src='keplr_rest'
          WHERE chain='osmosis' AND balance_num > 0 AND COALESCE(verified_at, 0) < ?`,
    params: [at, at, at],
  };
}

// ---------------------------------------------------------------- balance spans (W13)

/** D1 accepts at most 100 bound parameters per query. */
export const D1_MAX_PARAMS = 100;

/**
 * Record the chain reads made at `at` (every holders row of `chain` with verified_at = at) in balance_spans:
 * a reading equal to the address's latest span, within SPAN_MAX_GAP_MS of it, extends that span; any other
 * reading opens a new one. Set-based: two statements however many addresses were read. Pass `addresses`
 * (at most 90) when they are known, so the statements touch only their rows instead of the whole chain.
 */
export function spanStmts(chain: string, at: number, addresses?: string[]): Stmt[] {
  if (addresses && addresses.length > D1_MAX_PARAMS - 10) throw new Error('spanStmts: too many addresses for one statement');
  const only = (col: string) => (addresses?.length ? ` AND ${col} IN (${addresses.map(() => '?').join(',')})` : '');
  const list = addresses?.length ? addresses : [];
  return [
    {
      sql: `UPDATE balance_spans SET to_ts = ?, reads = reads + 1
            WHERE chain = ?${only('balance_spans.address')} AND to_ts < ? AND ? - to_ts <= ?
              AND from_ts = (SELECT MAX(s2.from_ts) FROM balance_spans s2 WHERE s2.chain = balance_spans.chain AND s2.address = balance_spans.address)
              AND EXISTS (SELECT 1 FROM holders h WHERE h.chain = balance_spans.chain AND h.address = balance_spans.address
                          AND h.verified_at = ? AND h.balance = balance_spans.balance)`,
      params: [at, chain, ...list, at, at, SPAN_MAX_GAP_MS, at],
    },
    {
      sql: `INSERT OR IGNORE INTO balance_spans (chain, address, from_ts, to_ts, balance, balance_num, reads)
            SELECT h.chain, h.address, ?, ?, h.balance, h.balance_num, 1 FROM holders h
            WHERE h.chain = ?${only('h.address')} AND h.verified_at = ?
              AND NOT EXISTS (SELECT 1 FROM balance_spans s WHERE s.chain = h.chain AND s.address = h.address AND s.to_ts >= ?)`,
      params: [at, at, chain, ...list, at, at],
    },
  ];
}

/** Split a list so each query stays under D1's bound-parameter limit (`reserve` for the query's other parameters). */
export function chunks<T>(list: T[], reserve: number, per = 1): T[][] {
  const size = Math.max(1, Math.floor((D1_MAX_PARAMS - reserve) / per));
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export function pruneSpansStmt(now: number): Stmt {
  return { sql: 'DELETE FROM balance_spans WHERE to_ts < ?', params: [now - SPAN_KEEP_MS] };
}

export interface Span { address: string; balance_num: number; from_ts: number; to_ts: number }

/**
 * The balance at `t`: the value of the span that contains it (read equal on both sides of `t`, at most
 * SPAN_MAX_GAP_MS apart). Null when `t` falls before the first reading, in a gap, or between two different
 * readings: the balance changed around then and the exact value is not known.
 */
export function balanceAt(spans: Span[], t: number): number | null {
  for (const s of spans) if (s.from_ts <= t && t <= s.to_ts) return s.balance_num;
  return null;
}

/** Change over the window: the current balance minus the balance `ms` ago, or null when that is not known. */
export function changeOver(current: number | null, spans: Span[], now: number, ms: number): number | null {
  if (current == null) return null;
  const base = balanceAt(spans, now - ms);
  return base == null ? null : current - base;
}

/**
 * 24-hour and 7-day changes for a set of addresses on one chain, from balance_spans. `current` is the
 * spendable balance now (the holders row). Addresses without readings at the window start get null.
 */
export async function liquidChanges(db: D1Database, chain: string, current: Map<string, number | null>, now: number): Promise<Map<string, { d24: number | null; d7: number | null }>> {
  const out = new Map<string, { d24: number | null; d7: number | null }>();
  const addrs = [...current.keys()];
  for (const a of addrs) out.set(a, { d24: null, d7: null });
  if (!addrs.length) return out;
  const t24 = now - D, t7 = now - 7 * D;
  const parts = await Promise.all(chunks(addrs, 5).map((part) => db.prepare(`SELECT address, balance_num, from_ts, to_ts FROM balance_spans
      WHERE chain = ? AND address IN (${part.map(() => '?').join(',')}) AND ((from_ts <= ? AND to_ts >= ?) OR (from_ts <= ? AND to_ts >= ?))`)
    .bind(chain, ...part, t24, t24, t7, t7).all<Span>().catch(() => ({ results: [] as Span[] }))));
  const by = new Map<string, Span[]>();
  for (const s of parts.flatMap((p) => p.results || [])) (by.get(s.address) ?? by.set(s.address, []).get(s.address)!).push(s);
  for (const a of addrs) {
    const spans = by.get(a) ?? [];
    out.set(a, { d24: changeOver(current.get(a) ?? null, spans, now, D), d7: changeOver(current.get(a) ?? null, spans, now, 7 * D) });
  }
  return out;
}
