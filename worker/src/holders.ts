// Holder rows: how fresh each one is (W2, owner decision 7), how spendable balances are kept current
// (the bulk index), the list on the stored totals (migration 0008: every row's stake and total, kept by triggers,
// walked on one index per order), the counts kept in kv, the label words names are found by, and real 24-hour and
// 7-day changes from recorded balance readings.
//
// How a holder's spendable (liquid) balance is written:
// - Namada: the chain lists every NAM balance in one query (worker/src/sources/namada.ts allNamBalances),
//   which the per-minute cron tick reads once every BALANCE_LISTING_MS (cron.ts runBalanceListing: the read starts
//   with the tick and gets LISTING_TIMEOUT_MS a node; never in the same tick as the bond listing) and reconciles
//   against the stored rows: only rows whose balance differs, or that are new, are written
//   (`listingBalanceStmts`, verified_src BALANCE_LISTING_SRC); stored rows the listing no longer has are zeroed.
//   A listing is applied only when its node is at the head, it is not older than the one applied, and it adds up
//   to the chain's minted total and to this tick's supply read (cron.ts balanceGate). Between listings the LiveHub writes the post-balance of every NAM transfer it sees in a block
//   (`stmt.namadaBalance`, `updated_at` only). A row the listing left unchanged was confirmed by it: its reading
//   is as fresh as the listing (`confirmedAt`); an address with no row after a complete listing was listed with
//   no NAM (the API says so, rather than "not read yet").
//   Before 2026-10-20 the site knew 3,636 of the 64,373 addresses holding NAM and re-read 50 a minute.
// - Osmosis: the cron reads the full holder list from the Osmosis bank every 10 minutes.
// Chain reads are recorded in `balance_spans` (migration 0003), which is what the changes are computed
// from. Nothing is ever filled with 0 when unknown: a change is null until readings exist.
import type { Stmt } from './db';
import type { HolderCountsKv } from '../../shared/types';
import { INTERNAL_LABELS } from './config';
import { toNam } from './util';
import { LIQUID_STALE_MS } from '../../shared/holder-status';
import { prefixRange } from '../../shared/paging';
import { labelSearchTerms, label_plain } from './labels';

const H = 3600000, D = 86400000;

/** verified_src of a holders row written (or confirmed) by the chain's full balance listing. */
export const BALANCE_LISTING_SRC = 'abci_prefix_listing';
/** verified_src of a stakes row written (or confirmed) by the chain's full bond listing. */
export const BOND_LISTING_SRC = 'bonds_listing';

/** Two readings of the same balance further apart than this start a new span (nothing is assumed across a gap). */
export const SPAN_MAX_GAP_MS = 6 * H;
/**
 * Spans that ended before this are deleted. 31 days since 2026-10-20 (was 8): the 30-day movers (screener-plan 3.1)
 * need a reading 30 days back, and spans are written on change only, so the longer keep costs storage, not writes.
 */
export const SPAN_KEEP_MS = 31 * D;


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
 * A holders row that holds a reading: written by a listing, a block or a chain read. Since migration 0008 a staker
 * with no spendable NAM has a row too (balance '0', never read: updated_at and verified_at NULL, so its stake is on
 * the stored totals' index); every query that asks "is there a spendable reading" asks this, not whether a row exists.
 */
export const HAS_READING = (h: string) => `(${h}updated_at IS NOT NULL OR ${h}verified_at IS NOT NULL)`;

/**
 * Total NAM of the 10 largest Namada holders (spendable + staked), and `at`: the oldest reading among them. Per
 * row the reading is the older of its spendable balance (the later of its chain read and its last transfer) and
 * its stake (chain read, else the estimate's time); a missing side is not counted (SQLite's MIN/MAX of a NULL is
 * NULL, so each case is spelled out). A row the balance listing confirmed (its verified_src) is as fresh as the
 * last complete listing, and a stake the bond listing confirmed as the last complete bond listing: parameters
 * ?1 and ?2 are those times (0 when there is none). The union form, before the stored totals (migration 0008): kept
 * as the reference NAMADA_TOP10_INDEX_SQL is tested against.
 */
export const NAMADA_TOP10_SQL = `SELECT SUM(t) s, MIN(rd) at FROM (SELECT t,
    CASE WHEN hs IS NULL THEN ss WHEN ss IS NULL THEN hs WHEN hs < ss THEN hs ELSE ss END rd
  FROM (SELECT COALESCE(h.balance_num,0) + ${stakeNum('s.')} t,
    CASE WHEN h.address IS NULL OR NOT ${HAS_READING('h.')} THEN NULL ELSE MAX(COALESCE(h.verified_at, 0), COALESCE(h.updated_at, 0), CASE WHEN h.verified_src = '${BALANCE_LISTING_SRC}' THEN ?1 ELSE 0 END) END hs,
    CASE WHEN s.address IS NULL THEN NULL ELSE MAX(COALESCE(s.verified_at, s.updated_at, 0), CASE WHEN s.verified_src = '${BOND_LISTING_SRC}' THEN ?2 ELSE 0 END) END ss
  FROM (SELECT address FROM holders WHERE chain='namada' UNION SELECT address FROM stakes) x
  LEFT JOIN holders h ON h.chain='namada' AND h.address = x.address LEFT JOIN stakes s ON s.address = x.address
  WHERE ${notInternal('x.address')} ORDER BY t DESC LIMIT 10))`;

/**
 * The holder list's rows as they were read before the stored totals (migration 0008): the union joined back to the
 * spendable row, the stake row and the label, one row per holder. No route reads it any more; it is the reference
 * the stored totals are tested against row for row (test/paging.test.ts), and its shape is HolderBaseRow's.
 */
export const HOLDERS_BASE = `
    SELECT x.chain, x.address, COALESCE(h.balance_num, 0) balance_num, ${HAS_READING('h.')} has_row, h.updated_at, h.verified_at, h.verified_src liquid_src,
           s.bonded_num, s.estimated_num, s.verified_at bonded_verified_at, s.verified_src bonded_src,
           COALESCE(h.balance_num, 0) + ${stakeNum('s.')} total_num, l.label, l.category,
           l.source label_source, l.author label_author
    FROM (${HOLDERS_UNION}) x
    LEFT JOIN holders h ON h.chain = x.chain AND h.address = x.address
    LEFT JOIN stakes s ON x.chain = 'namada' AND s.address = x.address
    LEFT JOIN labels l ON l.address = x.address`;

// ---------------------------------------------------------------- the list on the stored totals (migration 0008)
//
// Every holders row carries its stake (stake_num, the stakeNum rule) and its total (total_num), kept by the
// migration's triggers on every write; a staker with no spendable NAM has a row with no reading (HAS_READING). A page
// of the list is a walk of one index in the list's order, `ORDER BY <sort> DESC, address`, filtered on the index's own
// columns (the protocol accounts by address, the 28 pool labels as one list read once), so a page, a deep offset and a
// count read only index entries; the columns of the rows shown are read by primary key for those rows alone.
// chain = all is the merge of the two chains' walks (MERGE (UNION ALL)). Each walk names its index: without table
// statistics SQLite's planner prefers the primary key's equality on `chain` and sorts every row of the chain.

export type HolderChain = 'all' | 'namada' | 'osmosis';
/** total (spendable + staked), liquid (spendable), bonded (staked): HoldersBy */
export type HolderSort = 'total' | 'liquid' | 'bonded';
export const SORT_COL: Record<HolderSort, 'total_num' | 'balance_num' | 'stake_num'> = { total: 'total_num', liquid: 'balance_num', bonded: 'stake_num' };
/** Each sort's index (migration 0008): its leading columns are (chain, sort column DESC, address). */
export const SORT_INDEX: Record<HolderSort, 'holders_total' | 'holders_rank' | 'holders_stake'> = { total: 'holders_total', liquid: 'holders_rank', bonded: 'holders_stake' };
export const HOLDER_CHAINS_OF: Record<HolderChain, readonly ('namada' | 'osmosis')[]> = { all: ['namada', 'osmosis'], namada: ['namada'], osmosis: ['osmosis'] };

const INTERNAL_SQL = INTERNAL_ADDRS.map((a) => `'${a}'`).join(',');
/**
 * On the list (the same population as HOLDERS_UNION): holds NAM spendable or staked, is not a protocol account, is
 * not a pool. Index columns only (total_num and address are on every sort's index); the pools are one LIST SUBQUERY
 * over labels_cat, read once a statement. `+total_num`: checked on each entry, never taken as the range of a walk,
 * so a size or a rank's bound on the same column is the one the walk seeks to, and a search's rows are found on
 * their own index (SQLite picks one lower bound per column, and without statistics not the tighter one).
 */
export const LISTED = (h: string) => `+${h}total_num > 0 AND ${h}address NOT IN (${INTERNAL_SQL}) AND ${h}address NOT IN (SELECT lp.address FROM labels lp WHERE lp.category = 'pool')`;

/** A walk of the list: the chain, the order, a size range on the sort's figure, a category looked up per entry. */
export interface HolderWalk {
  chain: HolderChain;
  by: HolderSort;
  /** NAM on the sort's figure, inclusive */
  min?: number | null;
  max?: number | null;
  /** 'none': no label; a lower-case category: a label of that category (one primary-key lookup per entry walked) */
  category?: string | null;
}
/** A position in the list's order: the sort value and the address of a row (the holders cursor without its rank). */
export interface HolderPosition { value: number; address: string }

function walkConds(chain: 'namada' | 'osmosis', w: HolderWalk): { conds: string[]; params: unknown[] } {
  const col = `h.${SORT_COL[w.by]}`;
  const conds = ['h.chain = ?', LISTED('h.')];
  const params: unknown[] = [chain];
  if (w.min != null) { conds.push(`${col} >= ?`); params.push(w.min); }
  if (w.max != null) { conds.push(`${col} <= ?`); params.push(w.max); }
  if (w.category === 'none') conds.push('NOT EXISTS (SELECT 1 FROM labels l0 WHERE l0.address = h.address)');
  else if (w.category) { conds.push('EXISTS (SELECT 1 FROM labels l0 WHERE l0.address = h.address AND l0.category = ?)'); params.push(w.category); }
  return { conds, params };
}

/** The keyset condition: rows after `p` in the order (a range on the sort column, the tie group filtered). */
const afterCond = (col: string) => `${col} <= ? AND NOT (${col} = ? AND h.address <= ?)`;
/** The rows at or ahead of `p` in the order (its rank, when it is on the list): a range on the sort column, the tie group filtered. */
const aheadCond = (col: string) => `${col} >= ? AND NOT (${col} = ? AND h.address > ?)`;

/**
 * The keys of one page (chain, address, the sort value `v`), in the list's order: one walk per chain, merged for
 * chain = all. `after` continues behind a position, `offset` skips rows (numbered pages).
 */
export function walkKeysSql(w: HolderWalk, page: { after?: HolderPosition | null; limit: number; offset: number }): { sql: string; params: unknown[] } {
  const col = `h.${SORT_COL[w.by]}`;
  const arms = HOLDER_CHAINS_OF[w.chain].map((chain) => {
    const { conds, params } = walkConds(chain, w);
    if (page.after) { conds.push(afterCond(col)); params.push(page.after.value, page.after.value, page.after.address); }
    return { sql: `SELECT h.chain chain, h.address address, ${col} v FROM holders h INDEXED BY ${SORT_INDEX[w.by]} WHERE ${conds.join(' AND ')}`, params };
  });
  return { sql: `${arms.map((a) => a.sql).join(' UNION ALL ')} ORDER BY v DESC, address LIMIT ? OFFSET ?`, params: [...arms.flatMap((a) => a.params), page.limit, page.offset] };
}

/** How many rows the walk selects (the count of a size range or of a large category), or how many are at or ahead of `ahead`. */
export function walkCountSql(w: HolderWalk, ahead: HolderPosition | null = null): { sql: string; params: unknown[] } {
  const col = `h.${SORT_COL[w.by]}`;
  const arms = HOLDER_CHAINS_OF[w.chain].map((chain) => {
    const { conds, params } = walkConds(chain, w);
    if (ahead) { conds.push(aheadCond(col)); params.push(ahead.value, ahead.value, ahead.address); }
    return { sql: `(SELECT COUNT(*) FROM holders h INDEXED BY ${SORT_INDEX[w.by]} WHERE ${conds.join(' AND ')})`, params };
  });
  return { sql: `SELECT ${arms.map((a) => a.sql).join(' + ')} n`, params: arms.flatMap((a) => a.params) };
}

/**
 * Holders by category over a walk (the "What" chips' counts): one pass over the walk's entries with one sum per
 * category asked (no GROUP BY, so no sort), and the unlabelled ones. `cats` are lower-case categories.
 */
export function walkCategorySql(w: HolderWalk, cats: string[]): { sql: string; params: unknown[] } {
  const arms = HOLDER_CHAINS_OF[w.chain].map((chain) => {
    const { conds, params } = walkConds(chain, { ...w, category: null });
    return {
      sql: `SELECT COUNT(*) n, SUM(CASE WHEN l.address IS NULL THEN 1 ELSE 0 END) c_none${cats.map((_, i) => `, SUM(CASE WHEN l.category = ? THEN 1 ELSE 0 END) c${i}`).join('')}
            FROM holders h INDEXED BY ${SORT_INDEX[w.by]} LEFT JOIN labels l ON l.address = h.address WHERE ${conds.join(' AND ')}`,
      params: [...cats, ...params],
    };
  });
  return { sql: arms.map((a) => a.sql).join(' UNION ALL '), params: arms.flatMap((a) => a.params) };
}

/** The columns of a list row (HolderBaseRow's shape, plus the stored stake), over `holders h`, `stakes s` and `labels l`. */
export const HOLDER_ROW_COLS = `h.chain, h.address, h.balance_num, h.stake_num, h.total_num, ${HAS_READING('h.')} has_row, h.updated_at, h.verified_at, h.verified_src liquid_src,
       s.bonded_num, s.estimated_num, s.verified_at bonded_verified_at, s.verified_src bonded_src,
       l.label, l.category, l.source label_source, l.author label_author`;
const ROW_JOINS = `LEFT JOIN stakes s ON h.chain = 'namada' AND s.address = h.address LEFT JOIN labels l ON l.address = h.address`;

/**
 * One page of the list: the walk's keys (index entries only, however deep the page), then each shown row's columns
 * by primary key. The rows come back in the walk's order; holderOrder puts them in it again on the caller's side.
 */
export function holderPageSql(w: HolderWalk, page: { after?: HolderPosition | null; limit: number; offset: number }): { sql: string; params: unknown[] } {
  const k = walkKeysSql(w, page);
  return { sql: `SELECT ${HOLDER_ROW_COLS} FROM (${k.sql}) k JOIN holders h ON h.chain = k.chain AND h.address = k.address ${ROW_JOINS}`, params: k.params };
}

/** The most rows a search or a small category reads before it is put in order here (holderCandidatesSql). */
export const CANDIDATES_MAX = 10_000;

/**
 * The rows a narrow selection names (an address start, an address end, the addresses of a name or of a small
 * category), each on its own index, with every list condition: `cond` is over `h` and selects by its index, the
 * caller puts the rows in order. At most CANDIDATES_MAX + 1 (one more says the selection was too broad).
 */
export function holderCandidatesSql(cond: string, params: unknown[], chain: HolderChain): { sql: string; params: unknown[] } {
  const chains = HOLDER_CHAINS_OF[chain];
  return {
    sql: `SELECT ${HOLDER_ROW_COLS} FROM holders h ${ROW_JOINS} WHERE ${cond} AND h.chain IN (${chains.map(() => '?').join(',')}) AND ${LISTED('h.')} LIMIT ?`,
    params: [...params, ...chains, CANDIDATES_MAX + 1],
  };
}

/** The list's order on rows read here: the sort value descending, then the address as SQLite compares it (bytes). */
export function holderOrder(by: HolderSort) {
  const col = SORT_COL[by];
  return (a: Record<string, any>, b: Record<string, any>) => Number(b[col]) - Number(a[col]) || (a.address < b.address ? -1 : a.address > b.address ? 1 : 0);
}

/** Is row `r` after position `p` in the order? */
export function holderAfter(by: HolderSort, r: Record<string, any>, p: HolderPosition): boolean {
  const v = Number(r[SORT_COL[by]]);
  return v < p.value || (v === p.value && r.address > p.address);
}

// ---------------------------------------------------------------- names: the words of labels (migration 0008 label_tokens)
//
// A name is found by the start of any of its words. label_tokens holds every word of every label (the migration's
// label_words view is the one definition: lower-case ASCII letters, every punctuation mark a separator); a typed word
// reads one range of its primary key. The plain names the site shows are not stored: "early" (Early backers) finds
// `Genesis: af_backers` through labelSearchTerms, which maps a plain word to the raw fragment, read as that
// fragment's longest word and checked on the rows found. Nothing looser than a word start.

/** Every ASCII punctuation mark, tab, CR, LF and the typographic marks the migration's view replaces. */
const WORD_SEPARATORS = /[!-/:-@[-`{-~\t\n\r…·–—]/g;
/** The words of a text as label_tokens stores them (SQLite's lower() folds ASCII letters only, so this does too). */
export const labelWords = (s: string | null | undefined): string[] =>
  (s ?? '').replace(/[A-Z]/g, (ch) => ch.toLowerCase()).replace(WORD_SEPARATORS, ' ').split(' ').filter(Boolean);

/** What one typed word reads from label_tokens: its own range, and the exact words of the raw fragments it stands for. */
export interface WordKeys { word: string; range: [string, string]; exact: string[]; fragments: string[] }
export function wordKeys(word: string): WordKeys {
  const w = labelWords(word).join(' ');
  const fragments = labelSearchTerms(w).map((t) => t.toLowerCase()).filter((t) => t !== w && t !== w.replace(/\s+/g, '_'));
  const exact = [...new Set(fragments.map((f) => labelWords(f).sort((a, b) => b.length - a.length)[0]).filter((x): x is string => !!x))];
  return { word: w, range: prefixRange(w) ?? [w, w], exact, fragments };
}

/** The label_tokens condition of one word over an address column: the word's start, or one of its fragments' words. */
export function wordCond(k: WordKeys, col: string): { sql: string; params: unknown[] } {
  const alts = ['(t.token >= ? AND t.token < ?)', ...k.exact.map(() => 't.token = ?')];
  return { sql: `${col} IN (SELECT t.address FROM label_tokens t WHERE ${alts.join(' OR ')})`, params: [...k.range, ...k.exact] };
}

/** The most typed words a statement selects by (the rest are checked on the rows found, labelMatches). */
export const SQL_WORDS_MAX = 8;
/**
 * The words a statement selects by: each distinct word once, the longest first (the most selective), at most
 * SQL_WORDS_MAX, and only while their bound parameters (`cost` each) fit in `budget` (D1 takes 100 a statement: a
 * pasted sentence of 60 short words asked for 130 and was a 500). Every typed word is still checked on the rows
 * found (labelMatches with all the keys), so the answer is exactly what was typed, never looser.
 */
export function sqlWordKeys(keys: WordKeys[], budget: number, cost: (k: WordKeys) => number): WordKeys[] {
  const distinct = [...new Map(keys.map((k) => [k.word, k])).values()].sort((a, b) => b.word.length - a.word.length);
  const out: WordKeys[] = [];
  let used = 0;
  for (const k of distinct) {
    if (out.length >= SQL_WORDS_MAX) break;
    const c = cost(k);
    if (used + c > budget) continue;
    out.push(k);
    used += c;
  }
  return out;
}
/** The bound parameters of one wordCond. */
export const wordCondCost = (k: WordKeys) => 2 + k.exact.length;

/** Does a label match every typed word (a word start of its raw or plain words, or a fragment a word stands for)? */
export function labelMatches(label: string | null | undefined, address: string, source: string | null | undefined, keys: WordKeys[]): boolean {
  if (!label) return false;
  const raw = label.toLowerCase();
  const words = [...labelWords(label), ...labelWords(label_plain(label, address, source))];
  return keys.every((k) => {
    const parts = k.word.split(' ');
    return parts.every((p) => words.some((x) => x.startsWith(p))) || k.fragments.some((f) => raw.includes(f));
  });
}

/** How a label matched the typed text, for the ranking tiers: the whole name, its start, or a word start. */
export function labelMatch(label: string, address: string, source: string | null | undefined, text: string): 'exact' | 'start' | 'word' {
  const t = labelWords(text).join(' ');
  for (const n of [label, label_plain(label, address, source) ?? '']) {
    const w = labelWords(n).join(' ');
    if (w === t) return 'exact';
    if (w.startsWith(t)) return 'start';
  }
  return 'word';
}

// ---------------------------------------------------------------- the holder counts and figures, kept in kv (D1 read cost)
//
// The holder counts (per chain, per category, the unlabelled, those under 1 NAM) and the two top-10 sums change only
// when holder or stake rows are written: by a chain listing (hourly and every 40 minutes), the block follower between
// them, the Osmosis holder list every 10 minutes. The cron computes them on the stored totals' index after each
// complete listing (and at least hourly for Namada, every 15 minutes for Osmosis) into two kv rows: holders.figures
// (what the overview and the server-rendered page state) and holders.counts (HolderCountsKv: what /api/holders reads
// for its count and its "What" chips). Readers fall back to the queries themselves when a part is missing or older
// than HOLDER_FIGURES_SERVE_MS. Before 0008 the same figures took one 631,904-row pass of the union.

/** kv key of the stored holder figures. */
export const HOLDER_FIGURES_KV = 'holders.figures';
/** kv key of the stored holder counts (shared/types.ts HolderCountsKv). */
export const HOLDER_COUNTS_KV = 'holders.counts';
/** The shape of holders.figures since migration 0008 (a row written by the build before is read as missing). */
export const HOLDER_FIGURES_VERSION = 2;
/** The Namada part is recomputed when a chain listing completed after it, or when it is this old (the block follower's writes). */
export const NAMADA_FIGURES_REFRESH_MS = 60 * 60_000;
/** The Osmosis part (about 1,400 rows read) is recomputed when the holder list was written, or when it is this old. */
export const OSMOSIS_FIGURES_REFRESH_MS = 15 * 60_000;
/** A reader uses a part no older than this; past it (a stalled cron) it runs the queries itself. */
export const HOLDER_FIGURES_SERVE_MS = 2 * H;

/** One row of the list as D1 returns it (HOLDER_ROW_COLS; HOLDERS_BASE has the same columns but stake_num). */
export interface HolderBaseRow {
  chain: string; address: string; balance_num: number; stake_num?: number; has_row: number; updated_at: number | null; verified_at: number | null; liquid_src: string | null;
  bonded_num: number | null; estimated_num: number | null; bonded_verified_at: number | null; bonded_src: string | null; total_num: number;
  label: string | null; category: string | null; label_source: string | null; label_author: string | null;
}

export interface ChainFigures {
  /** when this part was computed */
  at: number;
  /** holders as the list counts them */
  holders: number;
  /** of them, those with under 1 NAM in all */
  under1: number;
  /** labelled holders per lower-case category */
  byCategory: Record<string, number>;
  /** holders without a label */
  none: number;
  /** the newest write of the chain's holder rows (Osmosis always; Namada only while no balance listing has completed) */
  rowsAt: number | null;
  /** NAMADA_TOP10_INDEX_SQL / OSMOSIS_TOP10_SQL */
  top10: { s: number | null; at: number | null } | null;
}
export interface HolderFigures {
  v: typeof HOLDER_FIGURES_VERSION;
  namada: (ChainFigures & { listed: ListingTimes }) | null;
  osmosis: ChainFigures | null;
}

/** One chain's holders and those under 1 NAM: the chain's range of holders_total, index entries only. */
export const CHAIN_COUNT_SQL = `SELECT COUNT(*) n, SUM(CASE WHEN h.total_num < 1 THEN 1 ELSE 0 END) u FROM holders h INDEXED BY holders_total WHERE h.chain = ? AND ${LISTED('h.')}`;
/**
 * One chain's labelled holders by category: the chain's labels by their address range (labels' primary key; an
 * address's prefix is its chain; CROSS JOIN keeps them the outer loop), each joined to its holder row by primary
 * key. The cron's only GROUP BY, over a few thousand labels.
 */
export const CHAIN_CATEGORY_SQL = `SELECT LOWER(l.category) c, COUNT(*) n FROM labels l CROSS JOIN holders h ON h.chain = ? AND h.address = l.address
  WHERE l.address >= ? AND l.address < ? AND ${LISTED('h.')} GROUP BY LOWER(l.category)`;
const CHAIN_PREFIX: Record<'namada' | 'osmosis', [string, string]> = { namada: ['tnam1', 'tnam2'], osmosis: ['osmo1', 'osmo2'] };
/** The newest write of a chain's holder rows (the chain's primary-key range). */
export const ROWS_AT_SQL = `SELECT MAX(updated_at) at FROM holders WHERE chain = ?`;

/**
 * NAMADA_TOP10_SQL on the stored totals: the first ten entries of holders_total on Namada (protocol accounts left
 * out, as the union form does), each joined to its row and its stake by primary key. ?1 and ?2 as there.
 */
export const NAMADA_TOP10_INDEX_SQL = `SELECT SUM(t) s, MIN(rd) at FROM (SELECT t,
    CASE WHEN hs IS NULL THEN ss WHEN ss IS NULL THEN hs WHEN hs < ss THEN hs ELSE ss END rd
  FROM (SELECT h.total_num t,
    CASE WHEN NOT ${HAS_READING('h.')} THEN NULL ELSE MAX(COALESCE(h.verified_at, 0), COALESCE(h.updated_at, 0), CASE WHEN h.verified_src = '${BALANCE_LISTING_SRC}' THEN ?1 ELSE 0 END) END hs,
    CASE WHEN s.address IS NULL THEN NULL ELSE MAX(COALESCE(s.verified_at, s.updated_at, 0), CASE WHEN s.verified_src = '${BOND_LISTING_SRC}' THEN ?2 ELSE 0 END) END ss
  FROM (SELECT h0.address FROM holders h0 INDEXED BY holders_total WHERE h0.chain = 'namada' AND +h0.total_num > 0 AND ${notInternal('h0.address')}
        ORDER BY h0.total_num DESC, h0.address LIMIT 10) k
  JOIN holders h ON h.chain = 'namada' AND h.address = k.address LEFT JOIN stakes s ON s.address = k.address))`;

async function chainFigures(db: D1Database, chain: 'namada' | 'osmosis', now: number, listed: ListingTimes): Promise<ChainFigures> {
  const [lo, hi] = CHAIN_PREFIX[chain];
  const [count, cats, top10, rowsAt] = await Promise.all([
    db.prepare(CHAIN_COUNT_SQL).bind(chain).first<{ n: number; u: number | null }>(),
    db.prepare(CHAIN_CATEGORY_SQL).bind(chain, lo, hi).all<{ c: string; n: number }>(),
    chain === 'namada'
      ? db.prepare(NAMADA_TOP10_INDEX_SQL).bind(listed.balance ?? 0, listed.bond ?? 0).first<{ s: number | null; at: number | null }>()
      : db.prepare(OSMOSIS_TOP10_SQL).first<{ s: number | null; at: number | null }>(),
    // Namada's figures are as of the last complete listing when there is one: the newest row write is read only without it.
    chain === 'osmosis' || listed.balance == null ? db.prepare(ROWS_AT_SQL).bind(chain).first<{ at: number | null }>() : Promise.resolve(null),
  ]);
  const byCategory: Record<string, number> = {};
  for (const r of cats.results || []) if (r.c) byCategory[r.c] = (byCategory[r.c] ?? 0) + Number(r.n);
  const holders = Number(count?.n ?? 0);
  const labelled = Object.values(byCategory).reduce((a, n) => a + n, 0);
  return {
    at: now, holders, under1: Number(count?.u ?? 0), byCategory, none: Math.max(0, holders - labelled), rowsAt: rowsAt?.at ?? null,
    top10: top10 ? { s: top10.s ?? null, at: top10.at ?? null } : null,
  };
}

/** The counts row (HolderCountsKv) of two parts, or null without both. */
export function holderCountsOf(f: HolderFigures | null): HolderCountsKv | null {
  if (!f?.namada || !f.osmosis) return null;
  const part = (p: ChainFigures) => ({ all: p.holders, byCategory: { ...p.byCategory }, none: p.none, under1Nam: p.under1 });
  const n = part(f.namada), o = part(f.osmosis);
  const byCategory: Record<string, number> = { ...n.byCategory };
  for (const [c, k] of Object.entries(o.byCategory)) byCategory[c] = (byCategory[c] ?? 0) + k;
  return {
    at: Math.min(f.namada.at, f.osmosis.at),
    byChain: { namada: n, osmosis: o, all: { all: n.all + o.all, byCategory, none: n.none + o.none, under1Nam: n.under1Nam + o.under1Nam } },
  };
}

/** Compute the parts asked for and store them, with the part that was not, and the counts row (one batch). */
export async function refreshHolderFigures(db: D1Database, now: number, parts: { namada: boolean; osmosis: boolean }, prev: HolderFigures | null = null): Promise<HolderFigures> {
  const out: HolderFigures = { v: HOLDER_FIGURES_VERSION, namada: prev?.namada ?? null, osmosis: prev?.osmosis ?? null };
  const listed = await listingTimes(db);
  const [namada, osmosis] = await Promise.all([
    parts.namada ? chainFigures(db, 'namada', now, listed) : Promise.resolve(null),
    parts.osmosis ? chainFigures(db, 'osmosis', now, listed) : Promise.resolve(null),
  ]);
  if (namada) out.namada = { ...namada, listed };
  if (osmosis) out.osmosis = osmosis;
  const counts = holderCountsOf(out);
  const put = 'INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)';
  await db.batch([
    db.prepare(put).bind(HOLDER_FIGURES_KV, JSON.stringify(out), now),
    ...(counts ? [db.prepare(put).bind(HOLDER_COUNTS_KV, JSON.stringify(counts), now)] : []),
  ]);
  return out;
}

/** The stored figures (one kv row), or null (none, unreadable, or written by the build before migration 0008). */
export async function readHolderFigures(db: D1Database): Promise<HolderFigures | null> {
  const r = await db.prepare('SELECT value FROM kv WHERE key = ?').bind(HOLDER_FIGURES_KV).first<{ value: string }>().catch(() => null);
  if (!r?.value) return null;
  try {
    const f = JSON.parse(r.value) as HolderFigures;
    return f && f.v === HOLDER_FIGURES_VERSION ? f : null;
  } catch { return null; }
}

/** The stored counts (one kv row) when they are no older than HOLDER_FIGURES_SERVE_MS, else null (the caller counts). */
export async function readHolderCounts(db: D1Database, now: number): Promise<HolderCountsKv | null> {
  const r = await db.prepare('SELECT value FROM kv WHERE key = ?').bind(HOLDER_COUNTS_KV).first<{ value: string }>().catch(() => null);
  if (!r?.value) return null;
  try {
    const c = JSON.parse(r.value) as HolderCountsKv;
    return c && Number.isFinite(c.at) && now - c.at < HOLDER_FIGURES_SERVE_MS && c.byChain?.all ? c : null;
  } catch { return null; }
}

/** The parts a reader may use now: each no older than HOLDER_FIGURES_SERVE_MS, else null. */
export function usableFigures(f: HolderFigures | null, now: number): HolderFigures {
  const ok = <T extends { at: number } | null>(p: T | undefined): T | null => (p && Number.isFinite(p.at) && now - p.at < HOLDER_FIGURES_SERVE_MS ? p : null);
  return { v: HOLDER_FIGURES_VERSION, namada: ok(f?.namada), osmosis: ok(f?.osmosis) };
}

/**
 * Which parts the cron should recompute this tick: Namada when there is none, when a chain listing completed after
 * it, or when it is NAMADA_FIGURES_REFRESH_MS old; Osmosis when there is none, when the holder list was written
 * this tick, when it is OSMOSIS_FIGURES_REFRESH_MS old, or with the Namada part (one moment for both).
 */
export function figuresDue(f: HolderFigures | null, listed: ListingTimes, now: number, osmosisWritten: boolean): { namada: boolean; osmosis: boolean } {
  const n = f?.namada, o = f?.osmosis;
  const listedAfter = Math.max(listed.balance ?? 0, listed.bond ?? 0) > (n?.at ?? 0);
  const namada = !n || listedAfter || now - n.at >= NAMADA_FIGURES_REFRESH_MS;
  return { namada, osmosis: namada || !o || osmosisWritten || now - o.at >= OSMOSIS_FIGURES_REFRESH_MS };
}

/** The list's count for a chain filter from usable figures, or null (a part missing: the caller counts itself). */
export function figuresCount(f: HolderFigures, chain: HolderChain): number | null {
  if (chain === 'namada') return f.namada ? f.namada.holders : null;
  if (chain === 'osmosis') return f.osmosis ? f.osmosis.holders : null;
  return f.namada && f.osmosis ? f.namada.holders + f.osmosis.holders : null;
}

/** The figures the overview and the server-rendered page show, from usable stored figures or, without them, the queries. */
export async function holderFigureValues(db: D1Database, now: number, listed: ListingTimes): Promise<{
  counts: { namada: number | null; osmosis: number | null; namada_at: number | null; osmosis_at: number | null } | null;
  top10Osmosis: { s: number | null; at: number | null } | null; top10Namada: { s: number | null; at: number | null } | null; dust: { n: number } | null; storedAt: number | null;
}> {
  const f = usableFigures(await readHolderFigures(db), now);
  // Each missing part is computed here on the index (about 65,000 index entries for Namada, 1,400 for Osmosis).
  const [n, o] = await Promise.all([
    f.namada ? Promise.resolve(f.namada) : chainFigures(db, 'namada', now, listed).catch(() => null),
    f.osmosis ? Promise.resolve(f.osmosis) : chainFigures(db, 'osmosis', now, listed).catch(() => null),
  ]);
  return {
    counts: n || o ? { namada: n?.holders ?? null, osmosis: o?.holders ?? null, namada_at: n?.rowsAt ?? null, osmosis_at: o?.rowsAt ?? null } : null,
    top10Osmosis: o?.top10 ?? null, top10Namada: n?.top10 ?? null, dust: n ? { n: n.under1 } : null,
    storedAt: f.namada && f.osmosis ? Math.min(f.namada.at, f.osmosis.at) : null,
  };
}

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
 * The listing's balances, several rows per statement (9 parameters each, 11 rows a statement). Guarded twice: a
 * row the LiveHub wrote from a later block (its updated_height is above the listing's height) keeps the newer
 * post-balance, and a read older than the row's chain read never re-stamps it (as stmt.verifiedBalance). The
 * guards make the write idempotent: the next tick's diff finds the row equal and skips it.
 */
export function listingBalanceStmts(rows: ListedBalance[], height: number, at: number, src = BALANCE_LISTING_SRC): Stmt[] {
  const out: Stmt[] = [];
  // first_seen (migration 0007) only on a new row that holds NAM; an existing row keeps its own (the update leaves it alone).
  for (const part of chunks(rows, 0, 9)) {
    out.push({
      sql: `INSERT INTO holders (chain,address,balance,balance_num,updated_height,updated_at,verified_at,verified_src,first_seen)
            VALUES ${part.map(() => '(?,?,?,?,?,?,?,?,?)').join(',')}
            ON CONFLICT(chain,address) DO UPDATE SET
              balance=excluded.balance, balance_num=excluded.balance_num, updated_height=excluded.updated_height,
              updated_at=excluded.updated_at, verified_at=excluded.verified_at, verified_src=excluded.verified_src
            WHERE excluded.updated_height >= COALESCE(holders.updated_height, 0) AND excluded.verified_at >= COALESCE(holders.verified_at, 0)`,
      params: part.flatMap((r) => ['namada', r.address, r.balance, toNam(r.balance), height, at, at, src, toNam(r.balance) > 0 ? at : null]),
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
          WHERE chain='namada' AND balance_num > 0 AND COALESCE(updated_height, 0) <= ?1 AND address IN (${part.map(() => '?').join(',')})`,
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
  // Over a whole chain the spans to extend are those that ended within the gap rule: a range on balance_spans_to
  // (SPANS_BY_END), not a pass over every span kept for 31 days. A short address list uses the primary key instead.
  return [
    {
      sql: `UPDATE balance_spans${addresses?.length ? '' : ` ${SPANS_BY_END}`} SET to_ts = ?, reads = reads + 1
            WHERE chain = ?${only('balance_spans.address')} AND to_ts >= ? AND to_ts < ?
              AND from_ts = (SELECT MAX(s2.from_ts) FROM balance_spans s2 WHERE s2.chain = balance_spans.chain AND s2.address = balance_spans.address)
              AND EXISTS (SELECT 1 FROM holders h WHERE h.chain = balance_spans.chain AND h.address = balance_spans.address
                          AND h.verified_at = ? AND h.balance = balance_spans.balance)`,
      params: [at, chain, ...list, at - SPAN_MAX_GAP_MS, at, at],
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

/**
 * The span UPDATEs walk balance_spans_to (migration 0003) over the spans that ended within SPAN_MAX_GAP_MS
 * (`to_ts >= ? AND to_ts < ?`). Written as `? - to_ts <= ?` the bound could not use the index, and each statement read
 * every span kept (219,277 rows and 0.75 s on 2026-10-20, growing with SPAN_KEEP_MS); without statistics SQLite's
 * planner would still pick the primary key on `chain`, hence the hint.
 */
export const SPANS_BY_END = 'INDEXED BY balance_spans_to';

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
      sql: `UPDATE balance_spans ${SPANS_BY_END} SET to_ts = ?, reads = reads + 1
            WHERE chain = 'namada' AND to_ts >= ? AND to_ts < ? AND ${LATEST}
              AND EXISTS (SELECT 1 FROM holders h WHERE ${CONFIRMED('h')} AND h.address = balance_spans.address AND h.balance != balance_spans.balance)`,
      params: [prevAt, prevAt - SPAN_MAX_GAP_MS, prevAt, height],
    });
  }
  if (extend) {
    out.push({
      sql: `UPDATE balance_spans ${SPANS_BY_END} SET to_ts = ?, reads = reads + 1
            WHERE chain = 'namada' AND to_ts >= ? AND to_ts < ? AND ${LATEST}
              AND EXISTS (SELECT 1 FROM holders h WHERE ${CONFIRMED('h')} AND h.address = balance_spans.address AND h.balance = balance_spans.balance)`,
      params: [at, at - SPAN_MAX_GAP_MS, at, height],
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
