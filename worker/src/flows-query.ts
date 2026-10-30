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
import { ADDRESS_PREFIX_MIN, HASH_PREFIX_MIN, HASH_MAX, INPUT_MAX, isWholeAddress } from '../../shared/search-grammar';
import { prefixRange, parseBeforeParam, type BeforeParam, type FlowCursor } from '../../shared/paging';

/**
 * The most entries of its index one text search (`?search=`) reads per request in the 'time' and 'kind' modes; the
 * answer's `next` goes on from where it stopped. A `LIKE '%…%'` no index serves walked all 56,402 flows twice for a
 * term that matches nothing (the page, then the head count: 112,804 rows read, about 252 ms of D1 time, 2026-10-22).
 * 10,000 entries reached back to 1 Jan 2026 that day: the window's end (a covering read, 10,000 rows, 2.4 ms) and the
 * page inside it (10,001 rows, 23.5 ms).
 */
export const SEARCH_SCAN = 10_000;
/**
 * Can this text be part of an address or a record? Addresses are lower-case bech32, at most 63 characters, records
 * upper-case hex, 64 (no other character in any of the 56,402 flows, 2026-10-22); LIKE ignores ASCII case. A space,
 * a LIKE wildcard (`%`, `_`) or any other character is in none: such text selects nothing, without a walk.
 */
export const searchCanMatch = (s: string): boolean => s.length <= HASH_MAX && /^[0-9a-z]+$/i.test(s);

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
  // read as sent: another spelling of the same start (upper case, a space, a '+') is refused by flowsFilterError, never
  // read as that start under a cache key of its own (the app lower-cases what is typed: shared/search-grammar.ts)
  const addr = q('addr') || '';
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
  if (q('addr') && f.addr == null) return `addr must be a whole address, or the first ${ADDRESS_PREFIX_MIN} or more characters of one, in lower case.`;
  if (q('hash') && f.hash == null) return `hash must be ${HASH_PREFIX_MIN} to ${HASH_MAX} hexadecimal characters of a record.`;
  if (q('height') && f.height == null) return 'height must be a block number.';
  if ((q('search') ?? '').length > INPUT_MAX) return `search must be at most ${INPUT_MAX} characters.`;
  return null;
}

/**
 * How far apart in time the two records of one bridge crossing are matched (RECEIVED_TWIN), and so how far one move's
 * place in a count can reach to other moves: migration 0017's triggers mark the stored counts dirty for a write this
 * close to their mark (test/flow-counts.test.ts holds the two to one figure). The older-twin check reaches a minute.
 */
export const TWIN_WINDOW_MS = 900_000;

/** The receiving side of a crossing whose sending side is also recorded (see ?pairs=one). */
export const RECEIVED_TWIN = `(f.kind = 'ibc_in' AND EXISTS (SELECT 1 FROM flows p WHERE p.kind = 'ibc_out' AND p.chain != f.chain
  AND p.to_addr = f.to_addr AND p.amount_num = f.amount_num AND p.ts BETWEEN f.ts - ${TWIN_WINDOW_MS} AND f.ts + ${TWIN_WINDOW_MS}
  AND (p.from_addr = f.from_addr OR CAST(json_extract(p.meta, '$.packetSequence') AS TEXT) = CAST(json_extract(f.meta, '$.packetSequence') AS TEXT))))`;

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

/** Rows at or after `floor` in FLOWS_ORDER (not older than it): the end of the window a text search reads. */
export const NOT_BELOW = 'f.ts >= ? AND NOT (f.ts = ? AND (f.height < ? OR (f.height = ? AND f.id < ?)))';

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
export function flowsPageSql(select: (hint: string) => string, f: FlowsFilter, mode: Exclude<FlowsMode, 'rows'>, before: BeforeParam | null, limit: number, offset: number, floor: FlowCursor | null = null): { sql: string; params: unknown[] } {
  const { conds, params } = flowsConditions(f);
  const key: string[] = [];
  const keyParams: unknown[] = [];
  if (before?.kind === 'cursor') { key.push(AFTER_CURSOR); const c = before.cursor; keyParams.push(c.ts, c.ts, c.height, c.height, c.id); }
  else if (before?.kind === 'time') { key.push('f.ts < ?'); keyParams.push(before.ts); }
  if (floor) { key.push(NOT_BELOW); keyParams.push(floor.ts, floor.ts, floor.height, floor.height, floor.id); }
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
 * The end of a text search's window: the SEARCH_SCAN-th entry of the index the page walks, from its position (the
 * head, a cursor or a date), and the entry after it if there is one. Only the index's own columns are read (a covering
 * read); the time window (`since`) and, in 'kind' mode, the kind are the range of that read. Fewer than two rows: the
 * walk reaches the oldest move inside the window, so it is not cut.
 */
export function scanFloorSql(f: FlowsFilter, mode: 'time' | 'kind', before: BeforeParam | null): { sql: string; params: unknown[] } {
  const conds = ['f.ts <= ?'];
  const params: unknown[] = [f.asOf];
  if (mode === 'kind') { conds.push('f.kind = ?'); params.push(f.kind); }
  if (f.since != null) { conds.push('f.ts >= ?'); params.push(f.since); }
  if (before?.kind === 'cursor') { conds.push(AFTER_CURSOR); const c = before.cursor; params.push(c.ts, c.ts, c.height, c.height, c.id); }
  else if (before?.kind === 'time') { conds.push('f.ts < ?'); params.push(before.ts); }
  return { sql: `SELECT f.ts, f.height, f.id FROM flows f ${modeIndex(mode)} WHERE ${conds.join(' AND ')} ${FLOWS_ORDER} LIMIT 2 OFFSET ?`, params: [...params, SEARCH_SCAN - 1] };
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
 * The most moves a count reads when the stored counts do not answer it (flowsCountSql with `cap`): past it the head page
 * says "more than COUNT_MAX" (FlowsResponse.totalOver), the pager's words for a count not known
 * (docs/design/nav-search-plan.md 2.3). Unbounded, a filtered count read every move it selects, a hub address every
 * move it made.
 */
export const COUNT_MAX = 10_000;

/**
 * The count of the head page (no `before`): 'address' and 'kind' count on the index their rows are read on, 'time'
 * on the index of its narrowest filter (timeCountIndex). For 'rows' the route counts the rows it read; this is for
 * the others. With `cap`, at most cap + 1 moves are read: a `total` above `cap` says "more than", not a count.
 */
export function flowsCountSql(f: FlowsFilter, mode: Exclude<FlowsMode, 'rows'>, cap = 0): { sql: string; params: unknown[] } {
  const { conds, params } = flowsConditions(f);
  if (mode === 'address') {
    const a = f.addr!;
    if (cap > 0) {
      return {
        sql: `SELECT COUNT(*) total FROM (SELECT 1 FROM flows f INDEXED BY flows_from WHERE f.from_addr = ? AND ${conds.join(' AND ')}
              UNION ALL SELECT 1 FROM flows f INDEXED BY flows_to WHERE f.to_addr = ? AND f.from_addr IS NOT ? AND ${conds.join(' AND ')} LIMIT ?)`,
        params: [a, ...params, a, a, ...params, cap + 1],
      };
    }
    return {
      sql: `SELECT (SELECT COUNT(*) FROM flows f INDEXED BY flows_from WHERE f.from_addr = ? AND ${conds.join(' AND ')})
             + (SELECT COUNT(*) FROM flows f INDEXED BY flows_to WHERE f.to_addr = ? AND f.from_addr IS NOT ? AND ${conds.join(' AND ')}) total`,
      params: [a, ...params, a, a, ...params],
    };
  }
  const index = mode === 'time' ? timeCountIndex(f) : modeIndex(mode);
  if (cap > 0) return { sql: `SELECT COUNT(*) total FROM (SELECT 1 FROM flows f ${index} WHERE ${conds.join(' AND ')} LIMIT ?)`, params: [...params, cap + 1] };
  return { sql: `SELECT COUNT(*) total FROM flows f ${index} WHERE ${conds.join(' AND ')}`, params };
}

// ---------------------------------------------------------------- the stored counts (migration 0017)
//
// flow_counts holds the moves up to flow_count_mark.mark by chain, kind, crossing twin, bot trade and size step; the
// cron writes it (worker/src/flow-counts.ts) and the triggers mark it dirty when a write could change it. A head page
// whose filters are only those columns is counted as the stored count plus the moves after the mark, counted live
// (storedCountSql): exact, and a read of the moves of the last hours instead of all of them.

/**
 * The NAM sizes the stored counts keep (flow_counts.size: 1 from the first, 2 from the second, 3 from the third, 0
 * below them or in another coin): the sizes the moves list offers (web/src/screens/activity/Transactions.tsx SIZES)
 * and the whale size (10,000, ?whale=true). Any other `minNam` is counted on the moves.
 */
export const FLOW_SIZE_STEPS = [1_000, 10_000, 100_000] as const;
const WHALE_STEP = FLOW_SIZE_STEPS.indexOf(10_000) + 1;
/** A move's size step (flow_counts.size), over `f`: as `amount_num >= step AND NAM_AMOUNT` reads it. */
const SIZE_STEP = `CASE WHEN NOT ${NAM_AMOUNT} THEN 0 ${FLOW_SIZE_STEPS.map((v, i) => [v, i + 1] as const).reverse().map(([v, k]) => `WHEN f.amount_num >= ${v} THEN ${k}`).join(' ')} ELSE 0 END`;

/**
 * The stored counts' rows of the moves in (from, to] (from null: every move up to `to`): one row per chain, kind, twin,
 * bot and size step, the older twins left out (NOT_LEGACY_TWIN), as every list leaves them out. `extra` is added to the
 * WHERE (the cron's guard that the counts were not marked dirty since it read them).
 */
export function flowCountGroupsSql(from: number | null, to: number, extra: { sql: string; params: unknown[] } | null = null): { sql: string; params: unknown[] } {
  const conds = [...(from != null ? ['f.ts > ?'] : []), 'f.ts <= ?', NOT_LEGACY_TWIN, ...(extra ? [extra.sql] : [])];
  return {
    // a step reads the moves of its range on flows_ts; the whole count reads every move, as the planner chooses
    sql: `SELECT f.chain chain, f.kind kind, CASE WHEN ${RECEIVED_TWIN} THEN 1 ELSE 0 END twin, CASE WHEN ${NOT_BOT} THEN 0 ELSE 1 END bot, ${SIZE_STEP} size, COUNT(*) n
          FROM flows f${from != null ? ' INDEXED BY flows_ts' : ''} WHERE ${conds.join(' AND ')} GROUP BY 1, 2, 3, 4, 5`,
    params: [...(from != null ? [from] : []), to, ...(extra?.params ?? [])],
  };
}

/** The mark's row in SQL (one row, migration 0017). */
const MARK = '(SELECT mark FROM flow_count_mark WHERE id = 1)';

/**
 * The count of a head page from the stored counts, or null when its filters are not the stored counts' columns (a
 * text search, a time window, an address, a record, a block, or a size the list does not offer). One statement, so the
 * mark, the counts and the moves since the mark are read as of one moment: the stored count of the filter's groups and
 * the moves between the mark and `asOf` with every condition of the list, at most COUNT_MAX + 1 of them (storedTotal
 * adds them when `asOf` is after the mark, takes them away when a rewound `asOf` is before it).
 */
export function storedCountSql(f: FlowsFilter): { sql: string; params: unknown[] } | null {
  if (f.search || f.since != null || f.addr || f.hash || f.height != null) return null;
  let size = f.whale ? WHALE_STEP : 0;
  if (f.minNam != null) {
    const k = (FLOW_SIZE_STEPS as readonly number[]).indexOf(f.minNam);
    if (k < 0) return null;
    size = Math.max(size, k + 1);
  }
  const g: string[] = [];
  const gp: unknown[] = [];
  if (f.chain && f.chain !== 'all') { g.push('c.chain = ?'); gp.push(f.chain); }
  if (f.kind && f.kind !== 'all') {
    const grp = KIND_GROUPS[f.kind];
    if (grp) g.push(`c.kind IN (${kindList(grp)})`);
    else { g.push('c.kind = ?'); gp.push(f.kind); }
  }
  if (f.onePerCrossing) g.push('c.twin = 0');
  if (f.excludeBots) g.push('c.bot = 0');
  if (size) { g.push('c.size >= ?'); gp.push(size); }
  // the list's conditions without its first, the time bound (f.ts <= asOf): the range from the mark replaces it
  const { conds, params } = flowsConditions(f);
  return {
    sql: `SELECT m.mark mark, m.dirty dirty,
            (SELECT COALESCE(SUM(c.n), 0) FROM flow_counts c${g.length ? ` WHERE ${g.join(' AND ')}` : ''}) stored,
            (SELECT COUNT(*) FROM (SELECT 1 FROM flows f INDEXED BY flows_ts WHERE f.ts > MIN(?, ${MARK}) AND f.ts <= MAX(?, ${MARK}) AND ${conds.slice(1).join(' AND ')} LIMIT ?)) delta
          FROM flow_count_mark m WHERE m.id = 1`,
    params: [...gp, f.asOf, f.asOf, ...params.slice(1), COUNT_MAX + 1],
  };
}

/** A row of storedCountSql. */
export interface StoredCountRow { mark: number | null; dirty: number; stored: number; delta: number }

/**
 * The head page's count from storedCountSql's row, as of `asOf`: the stored count plus the moves after the mark (or
 * minus those after `asOf`, for a rewound read before the mark). null when it cannot be said exactly: no row (the
 * migration not applied), the counts marked dirty or never written, or more than COUNT_MAX moves between the mark and
 * `asOf`. The caller then counts the moves (flowsCountSql).
 */
export function storedTotal(r: StoredCountRow | null | undefined, asOf: number): number | null {
  if (!r || Number(r.dirty) !== 0 || r.mark == null) return null;
  const delta = Number(r.delta);
  if (delta > COUNT_MAX) return null;
  return asOf >= Number(r.mark) ? Number(r.stored) + delta : Number(r.stored) - delta;
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
