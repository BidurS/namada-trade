// Activity inside the shielded pool as daily totals (builder G of the halt release, 2026-11-08; migration 0024
// masp_activity_daily). From masp_seen (one row per shielded transaction the chain recorded, by block, transaction and
// batch index, with the block's time) and the flows (the NAM legs touching the pool, by block), the daily job counts
// per UTC day: shielded transactions in all; of them, in a block with NAM into the pool (a shield), out of it (an
// unshield), over the bridge either way (an ibc_in or ibc_out row at the pool), and in a block with no NAM leg
// touching the pool at all (entirely inside the pool, in another coin, or paying a fee from the pool and nothing else:
// a shielded-to-shielded transaction paying gas from the pool emits only masp/fee-payment and a masp_fee row, which is
// a fee, not NAM moving out). Transactions are counted by their (height, block_index, batch_index) tuple, never by
// event type. The classes are read per block: the index names no transaction's legs. No note counts, no nullifiers,
// nothing per address.
//
// A day is counted only once the block follower has scanned past its end (kv namada.scanned, written by the live hub
// with its newest block's height and time): a day it has not finished is not written, never written as 0. While the
// chain is halted the newest block stays at the halt, so no day after it is written and the part says so.
import type { Stmt } from './db';
import { stmt } from './db';
import { NAMADA } from './config';
import { NOT_LEGACY_TWIN } from './flows-query';
import { safeParseJson } from './analytics';

/** The block follower's newest scanned block (live-hub.ts scanNamada): its height, its own time and when it was written. */
export const SCANNED_KV = 'namada.scanned';
export interface Scanned { height: number; ts: number; at: number }
export const scannedOf = (raw: unknown): Scanned | null => {
  const s = raw as Scanned | null;
  return s && typeof s === 'object' && Number.isInteger(s.height) && s.height > 0 && Number.isFinite(s.ts) && Number.isFinite(s.at) ? { height: s.height, ts: s.ts, at: s.at } : null;
};

const MASP = NAMADA.internal.masp;

/** The shielded transactions of one UTC day by block (masp_seen_ts index): ?1 the day's start, ?2 its end (unix ms). */
export const MASP_SEEN_DAY_SQL = `SELECT height, COUNT(*) n FROM masp_seen WHERE ts >= ?1 AND ts < ?2 GROUP BY height`;
/**
 * The NAM legs touching the pool in one UTC day (the pool on either end: the planner reads flows_from and flows_to by
 * the pool's address and the day's time range, test/masp-activity.test.ts holds the plan; older twins left out; the
 * coin told from meta in code). A part of the 4 to 515 Namada rows a day on production (2026-10-20).
 */
export const MASP_LEGS_DAY_SQL = `SELECT f.height, f.kind, f.from_addr, f.to_addr, f.meta FROM flows f
  WHERE f.ts >= ?1 AND f.ts < ?2 AND f.chain = 'namada' AND (f.from_addr = ?3 OR f.to_addr = ?3) AND ${NOT_LEGACY_TWIN}`;

export interface SeenDayRow { height: number; n: number }
export interface LegDayRow { height: number; kind: string; from_addr: string | null; to_addr: string | null; meta: string | null }

/** One day's counts (masp_activity_daily). */
export interface MaspActivity { txs: number; namIn: number; namOut: number; bridge: number; inside: number; blocks: number }

/**
 * The day's counts from its shielded transactions by block and the NAM legs at the pool by block. A leg counts only
 * when it is NAM (no meta.tokenSymbol) and of the kind named: 'shield' into the pool, 'unshield' out of it, 'ibc_in'
 * or 'ibc_out' at the pool; a 'masp_fee' row and every other kind say nothing. A transaction is in every class its
 * block has a leg for; it is `inside` when its block has none.
 */
export function maspActivityOf(seen: SeenDayRow[], legs: LegDayRow[]): MaspActivity {
  const byBlock = new Map<number, { in: boolean; out: boolean; bridge: boolean }>();
  for (const l of legs) {
    const meta = typeof l.meta === 'string' ? (safeParseJson(l.meta, {}) as Record<string, unknown> | null) ?? {} : {};
    if (meta.tokenSymbol != null) continue;
    const b = byBlock.get(Number(l.height)) ?? byBlock.set(Number(l.height), { in: false, out: false, bridge: false }).get(Number(l.height))!;
    if (l.kind === 'shield' && l.to_addr === MASP) b.in = true;
    else if (l.kind === 'unshield' && l.from_addr === MASP) b.out = true;
    else if ((l.kind === 'ibc_in' && l.to_addr === MASP) || (l.kind === 'ibc_out' && l.from_addr === MASP)) b.bridge = true;
  }
  const a: MaspActivity = { txs: 0, namIn: 0, namOut: 0, bridge: 0, inside: 0, blocks: 0 };
  for (const r of seen) {
    const n = Number(r.n) || 0;
    if (!n) continue;
    a.txs += n;
    a.blocks += 1;
    const b = byBlock.get(Number(r.height));
    if (b?.in) a.namIn += n;
    if (b?.out) a.namOut += n;
    if (b?.bridge) a.bridge += n;
    if (!b?.in && !b?.out && !b?.bridge) a.inside += n;
  }
  return a;
}

export const ACTIVITY_DAY_SQL = `INSERT OR REPLACE INTO masp_activity_daily (day, txs, nam_in, nam_out, bridge, inside, blocks, scanned_height, scanned_ts, written_at) VALUES (?,?,?,?,?,?,?,?,?,?)`;

/** The metrics keys of the day's counts, which /api/series serves (series-api.ts SERIES_KEYS). */
export const MASP_ACTIVITY_KEYS = {
  txs: 'masp.txs_daily',
  namIn: 'masp.txs_nam_in_daily',
  namOut: 'masp.txs_nam_out_daily',
  bridge: 'masp.txs_bridge_daily',
  inside: 'masp.txs_inside_daily',
} as const;

/** The statements for one day: its row and its five metrics rows at the day's start. */
export function maspActivityStmts(day: string, a: MaspActivity, scanned: Scanned, now: number): Stmt[] {
  const ts = Date.parse(`${day}T00:00:00Z`);
  return [
    { sql: ACTIVITY_DAY_SQL, params: [day, a.txs, a.namIn, a.namOut, a.bridge, a.inside, a.blocks, scanned.height, scanned.ts, now] },
    stmt.metric(ts, MASP_ACTIVITY_KEYS.txs, a.txs),
    stmt.metric(ts, MASP_ACTIVITY_KEYS.namIn, a.namIn),
    stmt.metric(ts, MASP_ACTIVITY_KEYS.namOut, a.namOut),
    stmt.metric(ts, MASP_ACTIVITY_KEYS.bridge, a.bridge),
    stmt.metric(ts, MASP_ACTIVITY_KEYS.inside, a.inside),
  ];
}

/** Read one UTC day's shielded transactions and pool legs and count them. */
export async function readMaspActivityDay(db: D1Database, dayStartMs: number): Promise<MaspActivity> {
  const end = dayStartMs + 86_400_000;
  const [seen, legs] = await Promise.all([
    db.prepare(MASP_SEEN_DAY_SQL).bind(dayStartMs, end).all<SeenDayRow>(),
    db.prepare(MASP_LEGS_DAY_SQL).bind(dayStartMs, end, MASP).all<LegDayRow>(),
  ]);
  return maspActivityOf(seen.results || [], legs.results || []);
}

/** Whether the block follower has scanned the whole of the day ending at `dayEndMs`: its newest block's own time is at or past it. */
export const dayScanned = (scanned: Scanned | null, dayEndMs: number): boolean => !!scanned && scanned.ts >= dayEndMs;
