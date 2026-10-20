// Holder rows: how fresh each one is (W2, owner decision 7), how spendable balances are kept current
// (the bulk index), and real 24-hour and 7-day changes from recorded balance readings.
//
// How a holder's spendable (liquid) balance is written:
// - Namada: the chain lists every NAM balance in one query (worker/src/sources/namada.ts allNamBalances),
//   which the listing run (cron.ts runListings, its own schedule) reads every BALANCE_LISTING_MS and reconciles
//   against the stored rows: only rows whose balance differs, or that are new, are written
//   (`listingBalanceStmts`, verified_src BALANCE_LISTING_SRC); stored rows the listing no longer has are zeroed.
//   A listing is applied only when it is from a current height and adds up to the chain's minted total (cron.ts
//   balanceGate). Between listings the LiveHub writes the post-balance of every NAM transfer it sees in a block
//   (`stmt.namadaBalance`, `updated_at` only). A row the listing left unchanged was confirmed by it: its reading
//   is as fresh as the listing (`confirmedAt`); an address with no row after a complete listing was listed with
//   no NAM (the API says so, rather than "not read yet").
//   Before 2026-10-20 the site knew 3,636 of the 64,373 addresses holding NAM and re-read 50 a minute.
// - Osmosis: the cron reads the full holder list from the Osmosis bank every 10 minutes.
// Chain reads are recorded in `balance_spans` (migration 0003), which is what the changes are computed
// from. Nothing is ever filled with 0 when unknown: a change is null until readings exist.
import type { Stmt } from './db';
import { INTERNAL_LABELS } from './config';
import { toNam } from './util';
import { LIQUID_STALE_MS } from '../../shared/holder-status';

const H = 3600000, D = 86400000;

/** verified_src of a holders row written (or confirmed) by the chain's full balance listing. */
export const BALANCE_LISTING_SRC = 'abci_prefix_listing';
/** verified_src of a stakes row written (or confirmed) by the chain's full bond listing. */
export const BOND_LISTING_SRC = 'bonds_listing';

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

/**
 * 1 while no bond listing has gone through completely (kv bond.listing `completeAt`), else NULL. One uncorrelated
 * subquery, evaluated once a statement.
 */
const NO_BOND_LISTING = `(SELECT CASE WHEN COUNT(*) = 0 THEN 1 END FROM kv WHERE key = 'bond.listing' AND json_extract(value, '$.completeAt') > 0)`;

/**
 * A stakes row's stake in NAM, for the holder list, its count and the top 10: the chain's figure (`bonded_num`)
 * when there is one; the estimate from the flow history only while no bond listing has ever gone through, because
 * once one has, an address it did not name has no bonds (the listing is every bond on the chain), and an estimate
 * from a bond flow the listing does not account for must not make a holder of it (on 2026-10-20 such a row put
 * a 332 million NAM estimate at rank 1). `col` is the stakes table's alias with its dot ('s.'), or ''.
 */
export const stakeNum = (col: string) => `COALESCE(${col}bonded_num, CASE WHEN ${NO_BOND_LISTING} THEN ${col}estimated_num END, 0)`;

/** Namada rows are the union of spendable holders and stakers; Osmosis rows have no stake. Protocol and pool accounts excluded. */
export const HOLDERS_UNION = `
  SELECT chain, address FROM holders WHERE balance_num > 0 AND ${notInternal('address')} AND ${notPool('holders.address')}
  UNION SELECT 'namada', address FROM stakes WHERE ${stakeNum('')} > 0 AND ${notInternal('address')}`;

/** Total NAM of the 10 largest Osmosis holders, protocol and pool accounts left out. */
export const OSMOSIS_TOP10_SQL = `SELECT SUM(balance_num) s, MIN(COALESCE(verified_at, updated_at)) at FROM (SELECT balance_num, verified_at, updated_at FROM holders
  WHERE chain='osmosis' AND ${notInternal('address')} AND ${notPool('holders.address')} ORDER BY balance_num DESC LIMIT 10)`;

/**
 * Holder counts per chain, with the same definition as the list, and when each chain's holder rows were last
 * written (`namada_at`, `osmosis_at`: the newest updated_at). For Namada the count is as of the last complete
 * balance listing when there is one (kv balance.listing, `listingTimes`), which the API prefers to namada_at.
 */
export const HOLDER_COUNTS_SQL = `SELECT SUM(CASE WHEN chain='namada' THEN 1 ELSE 0 END) namada, SUM(CASE WHEN chain='osmosis' THEN 1 ELSE 0 END) osmosis,
  (SELECT MAX(updated_at) FROM holders WHERE chain='namada') namada_at, (SELECT MAX(updated_at) FROM holders WHERE chain='osmosis') osmosis_at
  FROM (${HOLDERS_UNION})`;

/**
 * Namada holders whose whole holding (spendable + staked) is under 1 NAM: fee dust and test amounts, which the
 * count includes (every address with any NAM counts). Counted over the same union as the holder count, with the
 * same stake rule, so the two figures describe one population (a stake-only holder under 1 NAM counts here too).
 */
export const HOLDER_DUST_SQL = `SELECT COUNT(*) n FROM (${HOLDERS_UNION}) x
  LEFT JOIN holders h ON h.chain = 'namada' AND h.address = x.address LEFT JOIN stakes s ON s.address = x.address
  WHERE x.chain = 'namada' AND COALESCE(h.balance_num, 0) + ${stakeNum('s.')} < 1`;

/**
 * Total NAM of the 10 largest Namada holders (spendable + staked), and `at`: the oldest reading among them. Per
 * row the reading is the older of its spendable balance (the later of its chain read and its last transfer) and
 * its stake (chain read, else the estimate's time); a missing side is not counted (SQLite's MIN/MAX of a NULL is
 * NULL, so each case is spelled out). A row the balance listing confirmed (its verified_src) is as fresh as the
 * last complete listing, and a stake the bond listing confirmed as the last complete bond listing: parameters
 * ?1 and ?2 are those times (0 when there is none).
 */
export const NAMADA_TOP10_SQL = `SELECT SUM(t) s, MIN(rd) at FROM (SELECT t,
    CASE WHEN hs IS NULL THEN ss WHEN ss IS NULL THEN hs WHEN hs < ss THEN hs ELSE ss END rd
  FROM (SELECT COALESCE(h.balance_num,0) + ${stakeNum('s.')} t,
    CASE WHEN h.address IS NULL THEN NULL ELSE MAX(COALESCE(h.verified_at, 0), COALESCE(h.updated_at, 0), CASE WHEN h.verified_src = '${BALANCE_LISTING_SRC}' THEN ?1 ELSE 0 END) END hs,
    CASE WHEN s.address IS NULL THEN NULL ELSE MAX(COALESCE(s.verified_at, s.updated_at, 0), CASE WHEN s.verified_src = '${BOND_LISTING_SRC}' THEN ?2 ELSE 0 END) END ss
  FROM (SELECT address FROM holders WHERE chain='namada' UNION SELECT address FROM stakes) x
  LEFT JOIN holders h ON h.chain='namada' AND h.address = x.address LEFT JOIN stakes s ON s.address = x.address
  WHERE ${notInternal('x.address')} ORDER BY t DESC LIMIT 10))`;

// ---------------------------------------------------------------- the listings' confirmation times

/** When each chain listing last went through completely (kv balance.listing / bond.listing `completeAt`); null before the first. */
export interface ListingTimes { balance: number | null; bond: number | null }

export async function listingTimes(db: D1Database): Promise<ListingTimes> {
  const out: ListingTimes = { balance: null, bond: null };
  const rows = await db.prepare(`SELECT key, value FROM kv WHERE key IN ('balance.listing', 'bond.listing')`).all<{ key: string; value: string }>().catch(() => ({ results: [] as { key: string; value: string }[] }));
  for (const r of rows.results || []) {
    try {
      const at = Number((JSON.parse(r.value) as { completeAt?: number | null }).completeAt);
      if (Number.isFinite(at) && at > 0) out[r.key === 'balance.listing' ? 'balance' : 'bond'] = at;
    } catch {}
  }
  return out;
}

/**
 * When a reading was last confirmed by the chain. A row written by a listing (its verified_src) and not written
 * since was compared against every later listing and found unchanged, so it is as fresh as the last complete
 * listing; a row from any other source keeps its own time. Never earlier than the row's own time.
 */
export function confirmedAt(verifiedAt: number | null | undefined, src: string | null | undefined, listingSrc: string, listingAt: number | null): number | null {
  if (src === listingSrc && listingAt != null) return Math.max(verifiedAt ?? 0, listingAt);
  return verifiedAt ?? null;
}

// ---------------------------------------------------------------- the balance listing's writes

/** D1 accepts at most 100 bound parameters per query. */
export const D1_MAX_PARAMS = 100;

/** A balance the listing read at `height`, to write (new, or different from the stored row). */
export interface ListedBalance { address: string; balance: string }

/**
 * The listing's balances, several rows per statement (8 parameters each, 12 rows a statement). Guarded twice: a
 * row the LiveHub wrote from a later block (its updated_height is above the listing's height) keeps the newer
 * post-balance, and a read older than the row's chain read never re-stamps it (as stmt.verifiedBalance). The
 * guards make the write idempotent: the next tick's diff finds the row equal and skips it.
 */
export function listingBalanceStmts(rows: ListedBalance[], height: number, at: number, src = BALANCE_LISTING_SRC): Stmt[] {
  const out: Stmt[] = [];
  for (const part of chunks(rows, 0, 8)) {
    out.push({
      sql: `INSERT INTO holders (chain,address,balance,balance_num,updated_height,updated_at,verified_at,verified_src)
            VALUES ${part.map(() => '(?,?,?,?,?,?,?,?)').join(',')}
            ON CONFLICT(chain,address) DO UPDATE SET
              balance=excluded.balance, balance_num=excluded.balance_num, updated_height=excluded.updated_height,
              updated_at=excluded.updated_at, verified_at=excluded.verified_at, verified_src=excluded.verified_src
            WHERE excluded.updated_height >= CASE WHEN COALESCE(holders.updated_height, 0) > 1000000000 THEN 0 ELSE COALESCE(holders.updated_height, 0) END AND excluded.verified_at >= COALESCE(holders.verified_at, 0)`,
      params: part.flatMap((r) => ['namada', r.address, r.balance, toNam(r.balance), height, at, at, src]),
    });
  }
  return out;
}

/**
 * Stored Namada rows the listing does not have any more hold no NAM (the chain keeps a zero-valued key for an
 * emptied balance, so a missing key means the address never held NAM, or the stored row was wrong). The same
 * height guard as the writes; protocol accounts are never zeroed here (they are read every tick on their own).
 */
export function listingZeroStmts(addresses: string[], height: number, at: number, src = BALANCE_LISTING_SRC): Stmt[] {
  return chunks(addresses.filter((a) => !INTERNAL_ADDRS.includes(a)), 4).map((part) => ({
    sql: `UPDATE holders SET balance='0', balance_num=0, updated_height=?, updated_at=?, verified_at=?, verified_src=?
          WHERE chain='namada' AND balance_num > 0 AND (CASE WHEN COALESCE(updated_height, 0) > 1000000000 THEN 0 ELSE COALESCE(updated_height, 0) END) <= ?1 AND address IN (${part.map(() => '?').join(',')})`,
    params: [height, at, at, src, ...part],
  }));
}

/** Rows written by the Osmosis full list get verified_src 'keplr_rest' (see cron); kept here for the dropped-holder rule. */
export function osmosisDroppedStmt(at: number): Stmt {
  return {
    sql: `UPDATE holders SET balance='0', balance_num=0, updated_at=?, verified_at=?, verified_src='keplr_rest'
          WHERE chain='osmosis' AND balance_num > 0 AND COALESCE(verified_at, 0) < ?`,
    params: [at, at, at],
  };
}

// ---------------------------------------------------------------- balance spans

/**
 * Record the chain reads made at `at` (every holders row of `chain` with verified_at = at) in balance_spans:
 * a reading equal to the address's latest span, within SPAN_MAX_GAP_MS of it, extends that span; any other
 * reading opens a new one. Set-based: two statements however many addresses were read. Pass `addresses`
 * (at most 90) when they are known, so the statements touch only their rows instead of the whole chain.
 * Used for Osmosis (every row of the full list carries the list's time); Namada uses listingSpanStmts.
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

/**
 * The balance listing extends every unchanged span this often (one UPDATE over the whole chain, about 64,000
 * rows; within SPAN_MAX_GAP_MS so spans stay continuous while listings keep coming). Changed rows get a new span
 * at every listing, and the old span is closed at the previous listing's time, which had confirmed it.
 */
export const SPAN_EXTEND_MS = 5 * H;

/** The rows the balance listing at `height` confirmed: written by a listing and not by a later block. */
const CONFIRMED = (h: string) => `${h}.chain = 'namada' AND ${h}.verified_src = '${BALANCE_LISTING_SRC}' AND COALESCE(${h}.updated_height, 0) <= ?`;
const LATEST = `from_ts = (SELECT MAX(s2.from_ts) FROM balance_spans s2 WHERE s2.chain = balance_spans.chain AND s2.address = balance_spans.address)`;

/**
 * Span bookkeeping after a complete balance listing at `at` (answer height `height`), over every confirmed row:
 * 1. `prevAt` (the previous complete listing's time, which confirmed the old balances): the latest span of every
 *    row whose balance has changed since is closed there, if that time is within the gap rule of the span's end;
 * 2. when `extend`: every latest span still equal to the row's balance is extended to `at` (the 5-hourly sweep);
 * 3. every confirmed row whose latest span differs (or has none within the gap rule) opens a new span at `at`.
 * Internal accounts are not confirmed rows (their verified_src is the node that read them) and get no spans here.
 */
export function listingSpanStmts(at: number, height: number, prevAt: number | null, extend: boolean): Stmt[] {
  const out: Stmt[] = [];
  if (prevAt != null && prevAt < at) {
    out.push({
      sql: `UPDATE balance_spans SET to_ts = ?, reads = reads + 1
            WHERE chain = 'namada' AND to_ts < ? AND ? - to_ts <= ? AND ${LATEST}
              AND EXISTS (SELECT 1 FROM holders h WHERE ${CONFIRMED('h')} AND h.address = balance_spans.address AND h.balance != balance_spans.balance)`,
      params: [prevAt, prevAt, prevAt, SPAN_MAX_GAP_MS, height],
    });
  }
  if (extend) {
    out.push({
      sql: `UPDATE balance_spans SET to_ts = ?, reads = reads + 1
            WHERE chain = 'namada' AND to_ts < ? AND ? - to_ts <= ? AND ${LATEST}
              AND EXISTS (SELECT 1 FROM holders h WHERE ${CONFIRMED('h')} AND h.address = balance_spans.address AND h.balance = balance_spans.balance)`,
      params: [at, at, at, SPAN_MAX_GAP_MS, height],
    });
  }
  out.push({
    sql: `INSERT OR IGNORE INTO balance_spans (chain, address, from_ts, to_ts, balance, balance_num, reads)
          SELECT 'namada', h.address, ?, ?, h.balance, h.balance_num, 1 FROM holders h
          WHERE ${CONFIRMED('h')}
            AND NOT EXISTS (SELECT 1 FROM balance_spans s WHERE s.chain = 'namada' AND s.address = h.address AND s.balance = h.balance AND s.to_ts >= ?
                            AND s.from_ts = (SELECT MAX(s2.from_ts) FROM balance_spans s2 WHERE s2.chain = s.chain AND s2.address = s.address))`,
    params: [at, at, height, at - SPAN_MAX_GAP_MS],
  });
  return out;
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
