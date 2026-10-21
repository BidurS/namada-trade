// The WHERE clause of GET /api/flows, as a pure function so its conditions can be tested (W1), and the page reads
// on the feed's order (nav-search-plan.md 2.2).
//
//   ?chain=osmosis|namada   ?kind=<FlowKind>|dex|ibc|native   ?whale=true (≥ 10,000 NAM; other coins never count)
//   ?minNam=<n>             at least n NAM; flows of other coins (shielded USDC, OSMO…) never count as NAM
//   ?arb=false              bot trades removed (shared/flow-rules.ts isBotFlow: round trips the Osmosis parser marks
//                           with meta.arb, and any kind 'other' row that is not a bridge refund)
//   ?search=<text>          address or transaction hash contains the text
//   ?pairs=one              each bridge crossing once: a crossing is recorded on both chains (sent on one, received
//                           on the other); the receiving chain's record is left out when the sending chain's record
//                           of the same transfer (same addresses and amount, within 15 minutes) is present
//   ?at=<ms>                nothing newer than this time (rewind)
//   ?since=<ms>             moves at or after this time
//   ?addr=<address>         either side is this whole address, or starts with these 8 or more characters
//   ?hash=<hex>             the record's hash starts with these 8 or more hex characters (any of the hashes it is filed under)
//   ?height=<n>             moves of this block
//   ?before=<cursor|ms>     the page after a row already shown (a cursor), or moves older than a time (a date jump)
// Newest first (FLOWS_ORDER); `limit` stays clamped to 10…100 by the route.
import { ADDRESS_PREFIX_MIN, HASH_PREFIX_MIN, HASH_MAX, isWholeAddress } from '../../shared/search-grammar';
import { prefixRange, parseBeforeParam, type BeforeParam } from '../../shared/paging';

export interface FlowsFilter {
  asOf: number;
  chain?: string | null;
  kind?: string | null;
  whale?: boolean;
  minNam?: number | null;
  excludeBots?: boolean;
  search?: string | null;
  onePerCrossing?: boolean;
  /** unix ms: moves at or after it */
  since?: number | null;
  /** a whole address, or an address start of ADDRESS_PREFIX_MIN characters or more: either side */
  addr?: string | null;
  /** HASH_PREFIX_MIN to HASH_MAX hex characters, upper case: the start of any hash the record is filed under */
  hash?: string | null;
  /** a block height */
  height?: number | null;
}

/** The earliest and latest time `since` may name (as shared/paging.ts parseBeforeParam reads a time). */
const TIME_MIN = Date.UTC(2020, 0, 1);
const TIME_MAX = Date.UTC(2100, 0, 1);
const ADDRESS_START = /^(tnam1|osmo1)[02-9ac-hj-np-z]+$/;

/** Read the filter from query parameters (unknown or malformed values of the first build's filters are ignored, never guessed). */
export function flowsFilterFromQuery(q: (k: string) => string | undefined, asOf: number): FlowsFilter {
  const min = Number(q('minNam'));
  const since = Number(q('since'));
  const addr = (q('addr') || '').trim().toLowerCase();
  const hash = (q('hash') || '').trim().toUpperCase();
  const height = Number(q('height'));
  return {
    asOf,
    chain: q('chain') || null,
    kind: q('kind') || null,
    whale: q('whale') === 'true',
    minNam: Number.isFinite(min) && min > 0 ? min : null,
    excludeBots: q('arb') === 'false',
    search: q('search') || null,
    onePerCrossing: q('pairs') === 'one',
    since: Number.isInteger(since) && since >= TIME_MIN && since < TIME_MAX ? since : null,
    addr: addr && ADDRESS_START.test(addr) && (addr.length >= ADDRESS_PREFIX_MIN || isWholeAddress(addr)) ? addr : null,
    hash: hash.length >= HASH_PREFIX_MIN && hash.length <= HASH_MAX && /^[0-9A-F]+$/.test(hash) ? hash : null,
    height: Number.isSafeInteger(height) && height > 0 ? height : null,
  };
}

/** The values the switches take: any other spelling is refused, never read as "off" (each would be a cache entry of its own). */
const FLOW_SWITCHES: Record<string, { value: string; words: string }> = {
  whale: { value: 'true', words: 'whale must be true, or left out.' },
  arb: { value: 'false', words: 'arb must be false (bot trades left out), or left out.' },
  pairs: { value: 'one', words: 'pairs must be one (each bridge crossing once), or left out.' },
};
const FLOW_CHAINS = ['all', 'namada', 'osmosis'];

/**
 * The narrowing filters of the cursor build (since, addr, hash, height) sent but not readable, and a chain or a
 * switch spelled any other way than the app sends it: the route refuses the request (400) with these words rather
 * than serve unfiltered rows as if they were filtered, or store one more copy of the same list under a new key (a 400
 * is never cached). null when all are fine.
 */
export function flowsFilterError(q: (k: string) => string | undefined): string | null {
  const chain = q('chain');
  if (chain && !FLOW_CHAINS.includes(chain)) return 'chain must be all, namada or osmosis.';
  for (const [k, sw] of Object.entries(FLOW_SWITCHES)) { const v = q(k); if (v && v !== sw.value) return sw.words; }
  const f = flowsFilterFromQuery(q, 0);
  if (q('since') && f.since == null) return 'since must be a time in unix milliseconds.';
  if (q('addr') && f.addr == null) return `addr must be a whole address, or the first ${ADDRESS_PREFIX_MIN} or more characters of one.`;
  if (q('hash') && f.hash == null) return `hash must be ${HASH_PREFIX_MIN} to ${HASH_MAX} hexadecimal characters of a record.`;
  if (q('height') && f.height == null) return 'height must be a block number.';
  return null;
}

/** The receiving side of a crossing whose sending side is also recorded (see ?pairs=one). */
export const RECEIVED_TWIN = `(f.kind = 'ibc_in' AND EXISTS (SELECT 1 FROM flows p WHERE p.kind = 'ibc_out' AND p.chain != f.chain
  AND p.from_addr = f.from_addr AND p.to_addr = f.to_addr AND p.amount_num = f.amount_num AND p.ts BETWEEN f.ts - 900000 AND f.ts + 900000))`;

/** Not a bot trade, the same rule as shared/flow-rules.ts isBotFlow (bridge refunds are kind 'other' and stay). */
export const NOT_BOT = `((f.meta IS NULL OR f.meta NOT LIKE '%"arb":true%') AND (f.kind != 'other' OR f.meta LIKE '%"ibcTimeoutRefund":true%'))`;

/**
 * Not the older twin of a Namada transfer: an earlier parser build wrote some transfers under their inner hash
 * (id namada:<inner>:<i>, no meta.innerTxHash); the current one writes them under the wrapper hash with
 * meta.innerTxHash = <inner>. Where both exist the older row is left out. Migration 0004 deletes such rows and
 * a unique index stops new ones; this condition keeps the figures right before that runs. Backfilled rows
 * (meta.source) and current rows are never older twins, so the lookup runs only for the few rows left.
 */
export const NOT_LEGACY_TWIN = `NOT (f.chain = 'namada' AND (f.meta IS NULL OR (f.meta NOT LIKE '%"innerTxHash"%' AND f.meta NOT LIKE '%"source":%'))
  AND EXISTS (SELECT 1 FROM flows w WHERE w.ts BETWEEN f.ts - 60000 AND f.ts + 60000 AND w.chain = 'namada' AND w.height = f.height
              AND w.id != f.id AND json_extract(w.meta, '$.innerTxHash') = f.tx_hash))`;
/** A flow whose amount is another coin (shielding USDC, OSMO…) carries meta.tokenSymbol; NAM flows do not. */
export const NAM_AMOUNT = `(f.meta IS NULL OR f.meta NOT LIKE '%"tokenSymbol":%')`;

/** The kinds of each group the list filters by. */
export const KIND_GROUPS: Record<string, readonly string[]> = {
  dex: ['buy', 'sell', 'lp_add', 'lp_remove'],
  ibc: ['ibc_in', 'ibc_out'],
  native: ['bond', 'withdraw', 'shield', 'unshield', 'rewards', 'pos_balance'],
};
const kindList = (k: readonly string[]) => k.map((x) => `'${x}'`).join(',');

/**
 * The hashes a record is filed under (migration 0008 indexes each: flows_hash, flows_hash_wrapper, flows_hash_inner),
 * each in upper case as the grammar and `?hash=` read what is typed. The wrapper is read upper-cased: rows imported
 * from the Namada indexer keep it in lower case (44,770 of 51,477 Namada rows on 2026-10-20), and the site shows it
 * upper-cased (shared/flow-rules.ts explorerHashOf), so the index is on upper(…) and so is this expression.
 */
export const HASH_COLUMNS = ['f.tx_hash', "upper(json_extract(f.meta, '$.wrapper'))", "json_extract(f.meta, '$.innerTxHash')"] as const;

/**
 * The conditions of a filter. `skipWindow` leaves out the time window (`since`; the cursor is the caller's), for the
 * newest match of any age (FlowsResponse.last).
 */
export function flowsConditions(f: FlowsFilter, skipWindow = false): { conds: string[]; params: unknown[] } {
  const conditions: string[] = ['f.ts <= ?', NOT_LEGACY_TWIN];
  const params: unknown[] = [f.asOf];
  if (f.chain && f.chain !== 'all') { conditions.push('f.chain = ?'); params.push(f.chain); }
  if (f.kind && f.kind !== 'all') {
    const g = KIND_GROUPS[f.kind];
    if (g) conditions.push(`f.kind IN (${kindList(g)})`);
    else { conditions.push('f.kind = ?'); params.push(f.kind); }
  }
  // A whale is 10,000 NAM: another coin's row (meta.tokenSymbol) is in that coin's units and never one.
  if (f.whale) conditions.push('f.amount_num >= 10000', NAM_AMOUNT);
  if (f.minNam != null && f.minNam > 0) { conditions.push('f.amount_num >= ?', NAM_AMOUNT); params.push(f.minNam); }
  if (f.excludeBots) conditions.push(NOT_BOT);
  if (f.onePerCrossing) conditions.push(`NOT ${RECEIVED_TWIN}`);
  if (f.search) { conditions.push('(f.from_addr LIKE ? OR f.to_addr LIKE ? OR f.tx_hash LIKE ?)'); params.push(`%${f.search}%`, `%${f.search}%`, `%${f.search}%`); }
  if (f.since != null && !skipWindow) { conditions.push('f.ts >= ?'); params.push(f.since); }
  if (f.addr) {
    if (isWholeAddress(f.addr)) { conditions.push('(f.from_addr = ? OR f.to_addr = ?)'); params.push(f.addr, f.addr); }
    else {
      const [lo, hi] = prefixRange(f.addr)!;
      conditions.push('((f.from_addr >= ? AND f.from_addr < ?) OR (f.to_addr >= ? AND f.to_addr < ?))');
      params.push(lo, hi, lo, hi);
    }
  }
  if (f.hash) {
    const [lo, hi] = prefixRange(f.hash)!;
    conditions.push(`(${HASH_COLUMNS.map((c) => `(${c} >= ? AND ${c} < ?)`).join(' OR ')})`);
    params.push(lo, hi, lo, hi, lo, hi);
  }
  if (f.height != null) { conditions.push('f.height = ?'); params.push(f.height); }
  return { conds: conditions, params };
}

export function flowsWhere(f: FlowsFilter): { where: string; params: unknown[] } {
  const { conds, params } = flowsConditions(f);
  return { where: `WHERE ${conds.join(' AND ')}`, params };
}

/** Newest first; ties broken by block height, then the row id, so a page never reorders (the moves cursor's order). */
export const FLOWS_ORDER = 'ORDER BY f.ts DESC, f.height DESC, f.id DESC';

/** The keyset condition of a page: rows after `c` in FLOWS_ORDER (a range on ts, then the rows of equal time filtered). */
export const AFTER_CURSOR = 'f.ts <= ? AND NOT (f.ts = ? AND (f.height > ? OR (f.height = ? AND f.id >= ?)))';

/** FLOWS_ORDER as a comparison, for rows put in order here (a page read by hash, block or address start). */
export function flowOrder(a: { ts: number; height: number; id: string }, b: { ts: number; height: number; id: string }): number {
  return b.ts - a.ts || b.height - a.height || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

/** Is row `r` after the position `before` in FLOWS_ORDER (strictly older, or a later row of the same time)? */
export function afterPosition(r: { ts: number; height: number; id: string }, before: BeforeParam | null): boolean {
  if (!before) return true;
  if (before.kind === 'time') return r.ts < before.ts;
  return flowOrder(before.cursor, r) < 0;
}

/**
 * How a page is read (each mode's EXPLAIN is pinned in test/paging.test.ts; none sorts in a temporary B-tree):
 * - 'rows': a record (hash) or a block (height), or an address start that matches few rows: every matching row is
 *   read on its own index (at most FEW_ROWS) and put in order here;
 * - 'address': a whole address: its sending rows on flows_from and its receiving rows on flows_to, each already in
 *   the feed's order, merged (UNION ALL), so a page reads at most twice its length;
 * - 'kind': one kind: flows_kind, in the feed's order for that kind;
 * - 'time': everything else walks flows_ts in the feed's order and stops at the page's last row.
 */
export type FlowsMode = 'rows' | 'address' | 'kind' | 'time';
/** The most rows the 'rows' mode reads; an address start that matches more is walked in time order instead. */
export const FEW_ROWS = 2000;

export function flowsMode(f: FlowsFilter): FlowsMode {
  if (f.hash || f.height != null) return 'rows';
  if (f.addr) return isWholeAddress(f.addr) ? 'address' : 'rows';
  if (f.kind && f.kind !== 'all' && !KIND_GROUPS[f.kind]) return 'kind';
  return 'time';
}

/** The index a 'kind' or 'time' page walks. */
export const modeIndex = (m: FlowsMode) => (m === 'kind' ? 'INDEXED BY flows_kind' : 'INDEXED BY flows_ts');

/**
 * The rows of one page in SQL, for the 'address', 'kind' and 'time' modes: `select` is the column list over `f`
 * (and its label joins, analytics.ts flowSelect), `before` the cursor or time, `limit` the rows asked plus one (the
 * extra row says there is a next page), `offset` an old `?page=` link's offset (head pages only).
 */
export function flowsPageSql(select: (hint: string) => string, f: FlowsFilter, mode: Exclude<FlowsMode, 'rows'>, before: BeforeParam | null, limit: number, offset: number): { sql: string; params: unknown[] } {
  const { conds, params } = flowsConditions(f);
  const key: string[] = [];
  const keyParams: unknown[] = [];
  if (before?.kind === 'cursor') { key.push(AFTER_CURSOR); const c = before.cursor; keyParams.push(c.ts, c.ts, c.height, c.height, c.id); }
  else if (before?.kind === 'time') { key.push('f.ts < ?'); keyParams.push(before.ts); }
  if (mode === 'address') {
    // Each side in the feed's order on its own index; a row from the address to itself is the sending side's.
    const a = f.addr!;
    const side = (hint: string, cond: string, p: unknown[]) => ({
      sql: `${select(hint)} WHERE ${[cond, ...conds, ...key].join(' AND ')}`,
      params: [...p, ...params, ...keyParams],
    });
    const from = side('INDEXED BY flows_from', 'f.from_addr = ?', [a]);
    const to = side('INDEXED BY flows_to', 'f.to_addr = ? AND f.from_addr IS NOT ?', [a, a]);
    return { sql: `${from.sql} UNION ALL ${to.sql} ORDER BY 4 DESC, 3 DESC, 1 DESC LIMIT ? OFFSET ?`, params: [...from.params, ...to.params, limit, offset] };
  }
  return {
    sql: `${select(modeIndex(mode))} WHERE ${[...conds, ...key].join(' AND ')} ${FLOWS_ORDER} LIMIT ? OFFSET ?`,
    params: [...params, ...keyParams, limit, offset],
  };
}

/**
 * The 'rows' mode's read: every row matching the record, the block or the address start (each on its index: the
 * hash indexes, flows_chain_height, flows_from / flows_to), with every other condition, at most FEW_ROWS + 1.
 */
export function flowsRowsSql(select: (hint: string) => string, f: FlowsFilter): { sql: string; params: unknown[] } {
  const { conds, params } = flowsConditions(f);
  // the block: one seek per chain on flows_chain_height (an equality on the chain is needed for the index)
  const extra = f.height != null && !(f.chain && f.chain !== 'all') ? ["f.chain IN ('namada','osmosis')"] : [];
  return { sql: `${select('')} WHERE ${[...conds, ...extra].join(' AND ')} LIMIT ?`, params: [...params, FEW_ROWS + 1] };
}

/**
 * The index a 'time' count reads. A count has no order, so it need not walk the page's index: a kind group reads
 * its kinds' ranges on flows_kind (`kind=? AND ts<?` per kind, a chain or not), a time window its range on flows_ts
 * (`ts>? AND ts<?`), one chain its rows on flows_chain_height (`chain=?`), and anything else walks flows_ts. On
 * production a count of the Osmosis trades read 2,768 rows on flows_chain_height and 55,231 on flows_ts (2026-10-20).
 */
export function timeCountIndex(f: FlowsFilter): string {
  if (f.kind && KIND_GROUPS[f.kind]) return 'INDEXED BY flows_kind';
  if (f.since != null) return 'INDEXED BY flows_ts';
  if (f.chain === 'namada' || f.chain === 'osmosis') return 'INDEXED BY flows_chain_height';
  return 'INDEXED BY flows_ts';
}

/**
 * The count of the head page (no `before`): 'address' and 'kind' count on the index their rows are read on, 'time'
 * on the index of its narrowest filter (timeCountIndex). For 'rows' the route counts the rows it read; this is for
 * the others.
 */
export function flowsCountSql(f: FlowsFilter, mode: Exclude<FlowsMode, 'rows'>): { sql: string; params: unknown[] } {
  const { conds, params } = flowsConditions(f);
  if (mode === 'address') {
    const a = f.addr!;
    return {
      sql: `SELECT (SELECT COUNT(*) FROM flows f INDEXED BY flows_from WHERE f.from_addr = ? AND ${conds.join(' AND ')})
             + (SELECT COUNT(*) FROM flows f INDEXED BY flows_to WHERE f.to_addr = ? AND f.from_addr IS NOT ? AND ${conds.join(' AND ')}) total`,
      params: [a, ...params, a, a, ...params],
    };
  }
  return { sql: `SELECT COUNT(*) total FROM flows f ${mode === 'time' ? timeCountIndex(f) : modeIndex(mode)} WHERE ${conds.join(' AND ')}`, params };
}

/**
 * The newest row matching every filter but the time window (FlowsResponse.last, asked only for an empty head page
 * with a window): the same index walk, stopped at the first match.
 */
export function flowsLastSql(f: FlowsFilter, mode: FlowsMode): { sql: string; params: unknown[] } {
  const { conds, params } = flowsConditions(f, true);
  if (mode === 'rows') return { sql: `SELECT f.id, f.ts, f.chain, f.height FROM flows f WHERE ${conds.join(' AND ')} LIMIT ?`, params: [...params, FEW_ROWS + 1] };
  if (mode === 'address') {
    const a = f.addr!;
    return {
      sql: `SELECT f.id, f.ts, f.chain, f.height FROM flows f INDEXED BY flows_from WHERE f.from_addr = ? AND ${conds.join(' AND ')}
            UNION ALL SELECT f.id, f.ts, f.chain, f.height FROM flows f INDEXED BY flows_to WHERE f.to_addr = ? AND f.from_addr IS NOT ? AND ${conds.join(' AND ')}
            ORDER BY 2 DESC, 4 DESC, 1 DESC LIMIT 1`,
      params: [a, ...params, a, a, ...params],
    };
  }
  return { sql: `SELECT f.id, f.ts, f.chain, f.height FROM flows f ${modeIndex(mode)} WHERE ${conds.join(' AND ')} ${FLOWS_ORDER} LIMIT 1`, params };
}

/**
 * The oldest move recorded for a chain filter ("The flow index starts on 3 Dec 2024"): the lowest block of each
 * chain on flows_chain_height (heights rise with time on a chain), one row read per chain.
 */
export const FIRST_TS_SQL = (chain: 'namada' | 'osmosis') => `(SELECT ts FROM flows INDEXED BY flows_chain_height WHERE chain = '${chain}' ORDER BY height ASC LIMIT 1)`;

export { parseBeforeParam };
