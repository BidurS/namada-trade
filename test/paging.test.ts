// shared/paging.ts (docs/design/nav-search-plan.md 2.1, 2.2, 6): the page sizes, the opaque cursors (round trip, and a
// malformed one is ignored, never guessed at), prefixRange, and the keyset rules the cursors stand for, walked on the
// D1 stand-in with the real migrations: every row exactly once, in the list's order, with index range reads.
import { describe, it, expect } from 'vitest';
import {
  PAGE_SIZES, PAGE_SIZE, LIMIT_MIN, LIMIT_MAX, CURSOR_MAX_LENGTH, clampLimit,
  encodeCursor, decodeCursor, encodeHolderCursor, decodeHolderCursor, encodeFlowCursor, decodeFlowCursor,
  parseBeforeParam, prefixRange, type FlowCursor,
} from '../shared/paging';
import * as activityPaging from '../web/src/screens/activity/paging';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  FLOWS_ORDER, FIRST_TS_SQL, flowsMode, flowsPageSql, flowsCountSql, flowsLastSql, flowsRowsSql, type FlowsFilter, type FlowsMode,
} from '../worker/src/flows-query';
import {
  HOLDERS_BASE, HOLDER_COUNTS_SQL, HOLDER_DUST_SQL, NAMADA_TOP10_SQL, NAMADA_TOP10_INDEX_SQL, CHAIN_COUNT_SQL, CHAIN_CATEGORY_SQL, BOND_LISTING_SRC,
  holderPageSql, walkKeysSql, walkCountSql, walkCategorySql, holderCandidatesSql, holderOrder, wordCond, wordKeys, refreshHolderFigures,
  listingBalanceStmts, listingZeroStmts, osmosisDroppedStmt,
} from '../worker/src/holders';
import { stmt } from '../worker/src/db';
import { STAKE_ESTIMATES_SQL } from '../worker/src/cron';
import { flowSelect } from '../worker/src/analytics';
import { app } from '../worker/src/api';
import type { HoldersResponse } from '../shared/types';
import { testD1, insert, runStmts } from './d1-sqlite';

const POS = 'tnam1qgqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqc8j2fp';
const b64 = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

describe('every migration can be opened by the sqlite3 that ships with macOS', () => {
  // Its parser stack is fixed: on 2026-10-20 a view nesting 39 replace() calls in one expression overflowed it, and a
  // database whose schema holds such a statement cannot be read at all there ("malformed database schema"), which
  // would break reading a local copy or an export with the stock sqlite3. It overflowed between 25 and 30 nested
  // calls; statements here stay at 24 parentheses deep or less (string literals and comments not counted).
  it('no statement nests parentheses more than 24 deep', () => {
    const dir = join(__dirname, '..', 'migrations');
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql'))) {
      const s = readFileSync(join(dir, f), 'utf8').replace(/--[^\n]*/g, '').replace(/'(?:[^']|'')*'/g, "''");
      let depth = 0;
      let most = 0;
      for (const c of s) {
        if (c === '(') most = Math.max(most, ++depth);
        else if (c === ')') depth--;
      }
      expect(most, f).toBeLessThanOrEqual(24);
    }
  });
});

describe('page sizes', () => {
  it('are the Activity screen\'s, with the same default', () => {
    expect([...PAGE_SIZES]).toEqual([...activityPaging.PAGE_SIZES]);
    expect(PAGE_SIZE).toBe(activityPaging.PAGE_SIZE);
  });

  it('every size is a limit the API accepts', () => {
    for (const s of PAGE_SIZES) expect(clampLimit(String(s))).toBe(s);
  });

  it('clampLimit: whole numbers clamped to 10…100, the default for anything unreadable', () => {
    expect(clampLimit(null)).toBe(PAGE_SIZE);
    expect(clampLimit('')).toBe(PAGE_SIZE);
    expect(clampLimit('abc')).toBe(PAGE_SIZE);
    expect(clampLimit('12.5')).toBe(PAGE_SIZE);
    expect(clampLimit('1')).toBe(LIMIT_MIN);
    expect(clampLimit('5000')).toBe(LIMIT_MAX);
    expect(clampLimit('-3')).toBe(LIMIT_MIN);
    expect(clampLimit('25')).toBe(25);
  });
});

describe('cursors', () => {
  it('round-trip strings and numbers, URL-safe (no + / =)', () => {
    const parts = [1_234_567.891, POS, 3, 'namada:ABC:0', 'é€🙂'];
    const c = encodeCursor(parts);
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(c)).toEqual(parts);
    expect(decodeCursor(encodeCursor([0]))).toEqual([0]);
  });

  it('refuses parts that are not strings or finite numbers', () => {
    expect(() => encodeCursor([NaN])).toThrow();
    expect(() => encodeCursor([Infinity])).toThrow();
    expect(() => encodeCursor([{} as unknown as string])).toThrow();
  });

  it('a malformed cursor is null (the head page), whatever it is', () => {
    const bad = [
      null, undefined, '', 'not base64!', 'a', '====', b64('not json'), b64('{"a":1}'), b64('[]'), b64('[[1]]'), b64('[null]'),
      b64('[1,2,3,4,5,6,7,8,9]'), b64('"x"'), b64('[1e999]'), 'A'.repeat(CURSOR_MAX_LENGTH + 4),
      // invalid UTF-8 inside valid base64
      b64(String.fromCharCode(0xff, 0xfe)),
    ];
    for (const raw of bad) expect(decodeCursor(raw as string | null | undefined)).toBeNull();
  });

  it('holders: [sort value, address, rank]', () => {
    const c = { value: 14_662_107.03, address: POS, rank: 50 };
    expect(decodeHolderCursor(encodeHolderCursor(c))).toEqual(c);
    expect(decodeHolderCursor(encodeCursor([1, POS]))).toBeNull(); // no rank
    expect(decodeHolderCursor(encodeCursor([-1, POS, 1]))).toBeNull();
    expect(decodeHolderCursor(encodeCursor([1, 'tnam1qbad', 1]))).toBeNull(); // b is not an address character
    expect(decodeHolderCursor(encodeCursor([1, "x' OR 1=1 --", 1]))).toBeNull();
    expect(decodeHolderCursor(encodeCursor([1, POS, 0]))).toBeNull();
    expect(decodeHolderCursor(encodeCursor([1, POS, 1.5]))).toBeNull();
    expect(decodeHolderCursor(encodeFlowCursor({ ts: 1, height: 1, id: 'x' }))).toBeNull();
  });

  it('moves: [ts, height, id]', () => {
    const c: FlowCursor = { ts: 1_792_420_320_000, height: 8_294_006, id: 'namada:6C1989AB:0' };
    expect(decodeFlowCursor(encodeFlowCursor(c))).toEqual(c);
    expect(decodeFlowCursor(encodeCursor([1.5, 1, 'x']))).toBeNull();
    expect(decodeFlowCursor(encodeCursor([1, -1, 'x']))).toBeNull();
    expect(decodeFlowCursor(encodeCursor([1, 1, '']))).toBeNull();
    expect(decodeFlowCursor(encodeCursor([1, 1, 'a b']))).toBeNull();
  });

  it('?before= is a cursor or a plain time, else nothing', () => {
    const c: FlowCursor = { ts: 1_792_420_320_000, height: 8_294_006, id: 'osmosis:AB:1' };
    expect(parseBeforeParam(encodeFlowCursor(c))).toEqual({ kind: 'cursor', cursor: c });
    expect(parseBeforeParam('1790000000000')).toEqual({ kind: 'time', ts: 1_790_000_000_000 });
    for (const raw of [null, '', '0', '123', '99999999999999', 'yesterday', encodeHolderCursor({ value: 1, address: POS, rank: 1 })]) expect(parseBeforeParam(raw)).toBeNull();
  });
});

describe('prefixRange', () => {
  it('is the prefix and the prefix with its last character incremented', () => {
    expect(prefixRange('tnam1qz')).toEqual(['tnam1qz', 'tnam1q{']);
    expect(prefixRange('A1B2C3D4')).toEqual(['A1B2C3D4', 'A1B2C3D5']);
    expect(prefixRange('A1B2C3DF')).toEqual(['A1B2C3DF', 'A1B2C3DG']);
    expect(prefixRange('')).toBeNull();
    expect(prefixRange('a￿')).toEqual(['a￿', 'b']);
  });

  it('selects exactly the strings that start with it (bech32 and hex)', () => {
    const pool = ['tnam1qz', 'tnam1qz0', 'tnam1qzzz', 'tnam1qy9', 'tnam1q{', 'tnam1r', 'tnam1q', 'tnam1qza'];
    const [lo, hi] = prefixRange('tnam1qz')!;
    expect(pool.filter((s) => s >= lo && s < hi).sort()).toEqual(pool.filter((s) => s.startsWith('tnam1qz')).sort());
  });

  it('is an index range on the D1 stand-in: the holders primary key and flows_from', () => {
    const db = testD1();
    const [lo, hi] = prefixRange('tnam1qz')!;
    const plan = (sql: string, ...p: unknown[]) => (db.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...p) as { detail: string }[]).map((r) => r.detail).join(' | ');
    const h = plan('SELECT address FROM holders WHERE chain = ? AND address >= ? AND address < ? LIMIT 6', 'namada', lo, hi);
    expect(h).toMatch(/SEARCH holders USING (COVERING )?INDEX sqlite_autoindex_holders_1 \(chain=\? AND address>\? AND address<\?\)/);
    const f = plan('SELECT id FROM flows WHERE from_addr >= ? AND from_addr < ?', lo, hi);
    expect(f).toMatch(/SEARCH flows USING (COVERING )?INDEX flows_from \(from_addr>\? AND from_addr<\?\)/);
    expect(`${h} ${f}`).not.toMatch(/SCAN|TEMP B-TREE/);
  });
});

describe('the keyset rules the cursors stand for, walked on the stand-in', () => {
  it('moves: walking by FlowsResponse.next gives every row once, newest first, ties by height then id', async () => {
    const db = testD1();
    const T = Date.UTC(2026, 9, 20);
    const rows: Record<string, unknown>[] = [];
    // 137 rows with many equal times and equal heights, so the tie-breaks are exercised
    for (let i = 0; i < 137; i++) {
      const ts = T - Math.floor(i / 7) * 60_000;
      rows.push({ id: `namada:${String(1000 + i)}:${i % 3}`, chain: i % 4 ? 'namada' : 'osmosis', height: 8_000_000 - Math.floor(i / 3), ts, tx_hash: `H${i}`, kind: 'transfer', from_addr: POS, to_addr: POS, amount_num: i });
    }
    insert(db, 'flows', rows);
    const all = (db.raw.prepare(`SELECT id FROM flows f ${FLOWS_ORDER}`).all() as { id: string }[]).map((r) => r.id);
    const AFTER = 'f.ts <= ? AND NOT (f.ts = ? AND (f.height > ? OR (f.height = ? AND f.id >= ?)))';
    const seen: string[] = [];
    let before: string | null = null;
    for (let guard = 0; guard < 50; guard++) {
      const c = before ? decodeFlowCursor(before) : null;
      const where = c ? `WHERE ${AFTER}` : '';
      const params = c ? [c.ts, c.ts, c.height, c.height, c.id] : [];
      const limit = 25;
      const page = (await db.prepare(`SELECT id, ts, height FROM flows f ${where} ${FLOWS_ORDER} LIMIT ?`).bind(...params, limit + 1).all<{ id: string; ts: number; height: number }>()).results;
      const shown = page.slice(0, limit);
      seen.push(...shown.map((r) => r.id));
      const last = shown[shown.length - 1];
      before = page.length > limit ? encodeFlowCursor({ ts: last.ts, height: last.height, id: last.id }) : null;
      if (!before) break;
    }
    expect(seen).toEqual(all);
    expect(new Set(seen).size).toBe(137);
    // the range is served by flows_ts; the tie-break filters within equal times
    const plan = (db.raw.prepare(`EXPLAIN QUERY PLAN SELECT id FROM flows f INDEXED BY flows_ts WHERE ${AFTER} ${FLOWS_ORDER} LIMIT 26`).all(T, T, 1, 1, 'x') as { detail: string }[]).map((r) => r.detail).join(' | ');
    expect(plan).toMatch(/SEARCH f USING (COVERING )?INDEX flows_ts \(ts<\?\)/);
  });

  it('holders: walking by HoldersResponse.next gives every row once in the list order, and ranks continue', async () => {
    const db = testD1();
    const rows: Record<string, unknown>[] = [];
    const B32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
    for (let i = 0; i < 113; i++) {
      const addr = `tnam1q${B32[i % 32]}${B32[Math.floor(i / 32) % 32]}${'q'.repeat(37)}`;
      rows.push({ chain: 'namada', address: addr, balance: '0', balance_num: [5, 5, 5, 1000, 12.5, 0.5][i % 6] * (1 + Math.floor(i / 30)) });
    }
    insert(db, 'holders', rows);
    const ORDER = 'ORDER BY balance_num DESC, address';
    const all = (db.raw.prepare(`SELECT address FROM holders WHERE chain = 'namada' ${ORDER}`).all() as { address: string }[]).map((r) => r.address);
    const seen: { address: string; rank: number }[] = [];
    let after: string | null = null;
    for (let guard = 0; guard < 50; guard++) {
      const c = after ? decodeHolderCursor(after) : null;
      const where = c ? 'AND balance_num <= ? AND NOT (balance_num = ? AND address <= ?)' : '';
      const params = c ? [c.value, c.value, c.address] : [];
      const limit = 10;
      const page = (await db.prepare(`SELECT address, balance_num FROM holders WHERE chain = 'namada' ${where} ${ORDER} LIMIT ?`).bind(...params, limit + 1).all<{ address: string; balance_num: number }>()).results;
      const shown = page.slice(0, limit);
      const base = c ? c.rank : 0;
      shown.forEach((r, i) => seen.push({ address: r.address, rank: base + i + 1 }));
      const last = shown[shown.length - 1];
      after = page.length > limit ? encodeHolderCursor({ value: last.balance_num, address: last.address, rank: base + shown.length }) : null;
      if (!after) break;
    }
    expect(seen.map((s) => s.address)).toEqual(all);
    expect(seen.map((s) => s.rank)).toEqual(all.map((_, i) => i + 1));
  });
});

// ---------------------------------------------------------------- the stored totals (migration 0008, nav-search-plan.md 2.1)
//
// holders.stake_num and total_num are kept by triggers. Each real writer statement is run here against them, the
// backfill is checked row for row against the union the list read before (HOLDERS_BASE), every page, count and search
// query's plan is pinned to an index with no temporary B-tree, and walking the list by cursor or by page through the
// API gives every row once with ranks that continue.

const B32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
/** A whole Namada address (40 data characters) or Osmosis address (38), distinct per n and valid bech32 characters. */
const tn = (n: number) => `tnam1q${B32[n % 32]}${B32[Math.floor(n / 32) % 32]}${B32[Math.floor(n / 1024) % 32]}${'q'.repeat(36)}`;
const os = (n: number) => `osmo1${B32[n % 32]}${B32[Math.floor(n / 32) % 32]}${'q'.repeat(36)}`;
const T0 = Date.UTC(2026, 9, 21, 10, 0);
const H_ = 3_600_000;
type Row = Record<string, any>;
const rowOf = (db: ReturnType<typeof testD1>, chain: string, address: string): Row | undefined => {
  const r = db.raw.prepare('SELECT chain, address, balance, balance_num, stake_num, total_num, updated_at, verified_at, verified_src, first_seen FROM holders WHERE chain = ? AND address = ?').get(chain, address);
  return r ? { ...r } : undefined;
};
const planOf = (db: ReturnType<typeof testD1>, q: { sql: string; params: unknown[] }) =>
  (db.raw.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...q.params) as { detail: string }[]).map((r) => r.detail).join(' | ');

describe('the triggers keep stake_num and total_num on every real writer statement', () => {
  it('a block post-balance (stmt.namadaBalance): a new row takes its stake, a later one moves the total, an older one changes nothing', async () => {
    const db = testD1();
    await runStmts(db, stmt.stakesVerified([{ address: tn(1), bondedNam: 500, delegations: [] }], 2690, 100, T0, BOND_LISTING_SRC));
    // the staker had no spendable row: the trigger gave it one with no reading
    expect(rowOf(db, 'namada', tn(1))).toMatchObject({ balance: '0', balance_num: 0, stake_num: 500, total_num: 500, updated_at: null, verified_at: null, verified_src: null, first_seen: null });
    await runStmts(db, [stmt.namadaBalance({ address: tn(1), balance: '7000000', height: 200 } as any, T0 + 1)]);
    // its first NAM: the total, and first_seen as a new row would get it
    expect(rowOf(db, 'namada', tn(1))).toMatchObject({ balance_num: 7, stake_num: 500, total_num: 507, updated_at: T0 + 1, first_seen: T0 + 1 });
    await runStmts(db, [stmt.namadaBalance({ address: tn(1), balance: '9000000', height: 150 } as any, T0 + 2)]); // older block: refused by the guard
    expect(rowOf(db, 'namada', tn(1))).toMatchObject({ balance_num: 7, total_num: 507, updated_at: T0 + 1 });
    await runStmts(db, [stmt.namadaBalance({ address: tn(2), balance: '3000000', height: 201 } as any, T0 + 3)]); // a new holder, no stake
    expect(rowOf(db, 'namada', tn(2))).toMatchObject({ balance_num: 3, stake_num: 0, total_num: 3, first_seen: T0 + 3 });
  });

  it('a chain read (stmt.verifiedBalance), the Osmosis list and its zeroing (osmosisDroppedStmt): Osmosis has no stake', async () => {
    const db = testD1();
    await runStmts(db, [stmt.verifiedBalance('osmosis', os(1), '4000000', null, T0, 'keplr_rest'), stmt.verifiedBalance('osmosis', os(2), '1000000', null, T0, 'keplr_rest')]);
    expect(rowOf(db, 'osmosis', os(1))).toMatchObject({ balance_num: 4, stake_num: 0, total_num: 4 });
    await runStmts(db, [stmt.verifiedBalance('osmosis', os(1), '6000000', null, T0 - 1, 'keplr_rest')]); // an older read: refused
    expect(rowOf(db, 'osmosis', os(1))).toMatchObject({ balance_num: 4, total_num: 4 });
    await runStmts(db, [stmt.verifiedBalance('osmosis', os(1), '6000000', null, T0 + 10, 'keplr_rest'), osmosisDroppedStmt(T0 + 10)]);
    expect(rowOf(db, 'osmosis', os(1))).toMatchObject({ balance_num: 6, total_num: 6 });
    expect(rowOf(db, 'osmosis', os(2))).toMatchObject({ balance_num: 0, total_num: 0 });
    // an unchanged balance rewritten (the list every 10 minutes) writes no total
    const before = db.raw.prepare('SELECT total_changes() n').get().n;
    await runStmts(db, [stmt.verifiedBalance('osmosis', os(1), '6000000', null, T0 + 20, 'keplr_rest')]);
    expect(db.raw.prepare('SELECT total_changes() n').get().n - before).toBe(1); // the row itself, no trigger write
  });

  it('the balance listing (listingBalanceStmts, many rows a statement) and its zeroing (listingZeroStmts), height-guarded', async () => {
    const db = testD1();
    await runStmts(db, stmt.stakesVerified([{ address: tn(3), bondedNam: 20, delegations: [] }], 2690, 100, T0, BOND_LISTING_SRC));
    await runStmts(db, [stmt.namadaBalance({ address: tn(4), balance: '1000000', height: 900 } as any, T0)]);
    await runStmts(db, listingBalanceStmts([{ address: tn(3), balance: '5000000' }, { address: tn(4), balance: '8000000' }, { address: tn(5), balance: '2000000' }], 800, T0 + 5));
    expect(rowOf(db, 'namada', tn(3))).toMatchObject({ balance_num: 5, stake_num: 20, total_num: 25, first_seen: T0 + 5 });
    expect(rowOf(db, 'namada', tn(4))).toMatchObject({ balance_num: 1, total_num: 1 }); // the block follower's later post-balance stays
    expect(rowOf(db, 'namada', tn(5))).toMatchObject({ balance_num: 2, total_num: 2, first_seen: T0 + 5 });
    await runStmts(db, listingZeroStmts([tn(3), tn(4), tn(5)], 850, T0 + 6));
    expect(rowOf(db, 'namada', tn(3))).toMatchObject({ balance_num: 0, stake_num: 20, total_num: 20 });
    expect(rowOf(db, 'namada', tn(4))).toMatchObject({ balance_num: 1, total_num: 1 }); // newer than the listing: kept
    expect(rowOf(db, 'namada', tn(5))).toMatchObject({ balance_num: 0, total_num: 0 });
  });

  it('the bond listing (stmt.stakesVerified) and its zeroing, the estimates (STAKE_ESTIMATES_SQL) under the listing rule, a delete', async () => {
    const db = testD1();
    await runStmts(db, [stmt.namadaBalance({ address: tn(6), balance: '1000000', height: 10 } as any, T0)]);
    // before any bond listing the flow estimate counts (holders.ts stakeNum), and a negative one counts as 0
    insert(db, 'flows', [
      { id: 'b1', chain: 'namada', height: 1, ts: T0, tx_hash: 'B1', kind: 'bond', from_addr: tn(6), to_addr: 'v', amount_num: 300 },
      { id: 'b2', chain: 'namada', height: 1, ts: T0, tx_hash: 'B2', kind: 'unbond', from_addr: 'v', to_addr: tn(7), amount_num: 50 },
    ]);
    db.raw.prepare(STAKE_ESTIMATES_SQL).run(T0);
    expect(rowOf(db, 'namada', tn(6))).toMatchObject({ stake_num: 300, total_num: 301 });
    expect(rowOf(db, 'namada', tn(7))).toBeUndefined(); // an estimate of -50 makes no holder
    // the chain's figure replaces the estimate; a stake the listing no longer names is 0
    await runStmts(db, stmt.stakesVerified([{ address: tn(6), bondedNam: 250, delegations: [] }], 2690, 100, T0 + 1, BOND_LISTING_SRC));
    expect(rowOf(db, 'namada', tn(6))).toMatchObject({ stake_num: 250, total_num: 251 });
    await runStmts(db, stmt.stakesVerified([{ address: tn(6), bondedNam: 400, delegations: [] }], 2690, 90, T0 + 2, BOND_LISTING_SRC)); // older height: refused
    expect(rowOf(db, 'namada', tn(6))).toMatchObject({ stake_num: 250 });
    insert(db, 'kv', [{ key: 'bond.listing', value: JSON.stringify({ completeAt: T0 + 1 }), updated_at: T0 + 1 }]);
    // once a listing went through, a new estimate-only row does not count
    insert(db, 'flows', [{ id: 'b3', chain: 'namada', height: 2, ts: T0, tx_hash: 'B3', kind: 'bond', from_addr: tn(8), to_addr: 'v', amount_num: 900 }]);
    db.raw.prepare(STAKE_ESTIMATES_SQL).run(T0 + 3);
    expect(rowOf(db, 'namada', tn(8))).toBeUndefined();
    await runStmts(db, stmt.stakesVerified([{ address: tn(6), bondedNam: 0, delegations: [] }], 2690, 101, T0 + 4, BOND_LISTING_SRC));
    expect(rowOf(db, 'namada', tn(6))).toMatchObject({ stake_num: 0, total_num: 1 });
    await runStmts(db, stmt.stakesVerified([{ address: tn(6), bondedNam: 75, delegations: [] }], 2690, 102, T0 + 5, BOND_LISTING_SRC));
    db.raw.prepare('DELETE FROM stakes WHERE address = ?').run(tn(6));
    expect(rowOf(db, 'namada', tn(6))).toMatchObject({ stake_num: 0, total_num: 1 });
    // INSERT OR REPLACE into stakes never replaces the holder row (no conflict policy reaches the trigger's insert)
    db.raw.prepare('INSERT OR REPLACE INTO stakes (address, bonded_num, updated_at) VALUES (?, ?, ?)').run(tn(6), 12, T0 + 6);
    expect(rowOf(db, 'namada', tn(6))).toMatchObject({ balance_num: 1, stake_num: 12, total_num: 13, updated_at: T0 });
  });
});

describe('the backfill reproduces the union the list read before, row for row', () => {
  it('stakes, totals, membership, order and the figures are the same', () => {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (p: string) => any };
    const raw = new DatabaseSync(':memory:');
    const dir = join(__dirname, '..', 'migrations');
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files.filter((f) => f < '0008')) raw.exec(readFileSync(join(dir, f), 'utf8'));
    const ins = (t: string, r: Row) => raw.prepare(`INSERT INTO ${t} (${Object.keys(r).join(',')}) VALUES (${Object.keys(r).map(() => '?').join(',')})`).run(...Object.values(r));
    // 240 Namada rows (some empty), 30 stakers with no spendable row, 40 Osmosis rows, 2 pools, the protocol accounts, labels
    for (let i = 0; i < 240; i++) ins('holders', { chain: 'namada', address: tn(i), balance: '1', balance_num: i % 9 === 0 ? 0 : ((i * 37) % 101) * 1000 + (i % 7) / 10, updated_height: i, updated_at: T0 - i * 60000, verified_at: i % 3 ? T0 - H_ : null, verified_src: i % 3 ? 'abci_prefix_listing' : null });
    for (let i = 0; i < 60; i++) ins('stakes', { address: tn(i * 5), bonded_num: i % 4 ? ((i * 13) % 50) * 777 : null, estimated_num: i % 4 ? null : 12345 + i, verified_at: T0 - 2 * H_, verified_src: 'bonds_listing', updated_at: T0 });
    for (let i = 300; i < 330; i++) ins('stakes', { address: tn(i), bonded_num: 5000 + i, verified_at: T0 - 2 * H_, verified_src: 'bonds_listing', updated_at: T0 });
    for (let i = 0; i < 40; i++) ins('holders', { chain: 'osmosis', address: os(i), balance: '1', balance_num: (i % 11) * 900 + 0.5, updated_at: T0 - 5 * 60000, verified_at: T0 - 5 * 60000, verified_src: 'keplr_rest' });
    for (const p of [os(1), os(2)]) ins('labels', { address: p, chain: 'osmosis', label: 'Osmosis Pool #1 (NAM / USDC)', category: 'pool', source: 'auto', updated_at: 1 });
    ins('holders', { chain: 'namada', address: POS, balance: '1', balance_num: 3e8, updated_at: T0, verified_at: T0, verified_src: 'node' });
    ins('stakes', { address: POS, bonded_num: 10, updated_at: T0 });
    for (let i = 0; i < 25; i++) ins('labels', { address: tn(i * 7), chain: 'namada', label: i % 2 ? 'Genesis: af_backers' : 'Genesis: public_allocations_completed', category: i % 2 ? 'backer' : 'genesis', source: 'genesis', updated_at: 1 });
    const ref = (sql: string, ...p: unknown[]) => raw.prepare(sql).all(...p).map((r: Row) => ({ ...r }));
    // the stake rule in both states: before any bond listing (estimates count), then after one
    for (const listed of [false, true]) {
      if (listed) raw.prepare("INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES ('bond.listing', ?, 1)").run(JSON.stringify({ completeAt: T0 - H_ }));
      const before = ref(`${HOLDERS_BASE} ORDER BY total_num DESC, x.address`);
      const counts = raw.prepare(HOLDER_COUNTS_SQL).get();
      const dust = raw.prepare(HOLDER_DUST_SQL).get().n;
      const top10 = raw.prepare(NAMADA_TOP10_SQL).get(T0 - H_, T0 - 2 * H_);
      const copy = new DatabaseSync(':memory:');
      copy.exec(raw.prepare("SELECT group_concat(sql, ';\n') s FROM sqlite_master WHERE sql IS NOT NULL AND type = 'table'").get().s + ';');
      for (const t of ['holders', 'stakes', 'labels', 'kv']) for (const r of ref(`SELECT * FROM ${t}`)) copy.prepare(`INSERT INTO ${t} (${Object.keys(r).join(',')}) VALUES (${Object.keys(r).map(() => '?').join(',')})`).run(...Object.values(r));
      for (const f of files.filter((f) => f < '0008')) copy.exec(readFileSync(join(dir, f), 'utf8').replace(/^ALTER TABLE[^;]*;/gm, '').replace(/^(UPDATE|DELETE|INSERT)[\s\S]*?;$/gm, ''));
      copy.exec(readFileSync(join(dir, '0008_nav_search.sql'), 'utf8'));
      const walk = holderPageSql({ chain: 'all', by: 'total' }, { limit: 10_000, offset: 0 });
      const after = copy.prepare(walk.sql).all(...walk.params).map((r: Row) => ({ ...r })).sort(holderOrder('total'));
      const pick = (r: Row) => ({ chain: r.chain, address: r.address, balance_num: r.balance_num, total_num: r.total_num, has_row: r.has_row, bonded_num: r.bonded_num, estimated_num: r.estimated_num, label: r.label });
      expect(after.length).toBe(before.length);
      expect(after.map(pick)).toEqual(before.map(pick));
      expect(after.length).toBeGreaterThan(250);
      // the figures on the index equal the union's
      expect(copy.prepare(CHAIN_COUNT_SQL).get('namada')).toMatchObject({ n: counts.namada, u: dust });
      expect(copy.prepare(CHAIN_COUNT_SQL).get('osmosis').n).toBe(counts.osmosis);
      expect({ ...copy.prepare(NAMADA_TOP10_INDEX_SQL).get(T0 - H_, T0 - 2 * H_) }).toEqual({ ...top10 });
      // the stake each row stores is the list's stake (estimates only before a listing)
      for (const r of after.filter((x: Row) => x.chain === 'namada')) {
        expect(r.stake_num).toBeCloseTo(r.total_num - r.balance_num, 9);
      }
    }
  });
});

describe('every list, count and search query reads an index, never a temporary B-tree', () => {
  const NO_SORT = /TEMP B-TREE/;
  const db = testD1();
  const expectIndex = (q: { sql: string; params: unknown[] }, index: RegExp) => {
    const p = planOf(db, q);
    expect(p, q.sql).toMatch(index);
    expect(p, q.sql).not.toMatch(NO_SORT);
    expect(p, q.sql).not.toMatch(/\bSCAN (h|f|holders|flows|labels|l|t)\b/);
    return p;
  };
  const INDEX_OF = { total: /SEARCH h USING COVERING INDEX holders_total \(chain=\?/, liquid: /SEARCH h USING COVERING INDEX holders_rank \(chain=\?/, bonded: /SEARCH h USING COVERING INDEX holders_stake \(chain=\?/ };

  it('the holder pages: each sort, each chain (all is a merge), by page, by cursor, with a size, without a label, of a large category', () => {
    for (const by of ['total', 'liquid', 'bonded'] as const) {
      for (const chain of ['namada', 'osmosis', 'all'] as const) {
        const page = expectIndex(holderPageSql({ chain, by }, { limit: 51, offset: 50_000 }), INDEX_OF[by]);
        if (chain === 'all') expect(page).toMatch(/MERGE \(UNION ALL\)/);
        expect(page).toMatch(/SEARCH h USING INDEX sqlite_autoindex_holders_1 \(chain=\? AND address=\?\)/); // the rows shown, by primary key
        expectIndex(holderPageSql({ chain, by, min: 10, max: 1e6 }, { after: { value: 50, address: tn(1) }, limit: 51, offset: 0 }), INDEX_OF[by]);
        expectIndex(walkCountSql({ chain, by, min: 1000 }), INDEX_OF[by]);
        expectIndex(walkCountSql({ chain, by }, { value: 5, address: tn(1) }), INDEX_OF[by]);
        expectIndex(walkCategorySql({ chain, by, min: 1 }, ['genesis', 'backer']), INDEX_OF[by]);
      }
    }
    expect(expectIndex(walkKeysSql({ chain: 'namada', by: 'total', category: 'none' }, { limit: 51, offset: 0 }), INDEX_OF.total)).toMatch(/SEARCH l0 USING COVERING INDEX sqlite_autoindex_labels_1 \(address=\?\)/);
    expectIndex(walkKeysSql({ chain: 'namada', by: 'total', category: 'genesis' }, { limit: 51, offset: 0 }), INDEX_OF.total);
    // the stored counts: the chain's range of holders_total; the labelled ones from the chain's labels (the cron's only GROUP BY)
    expectIndex({ sql: CHAIN_COUNT_SQL, params: ['namada'] }, INDEX_OF.total);
    expect(planOf(db, { sql: CHAIN_CATEGORY_SQL, params: ['namada', 'tnam1', 'tnam2'] })).toMatch(/^SEARCH l USING INDEX sqlite_autoindex_labels_1 \(address>\? AND address<\?\) \| SEARCH h USING INDEX sqlite_autoindex_holders_1 \(chain=\? AND address=\?\)/);
    expectIndex({ sql: NAMADA_TOP10_INDEX_SQL, params: [0, 0] }, /SEARCH h0 USING COVERING INDEX holders_total \(chain=\?/);
  });

  it('a search or a small category reads only the rows it names, on their own index', () => {
    const cand = (cond: string, params: unknown[], chain: 'all' | 'namada' = 'all') => holderCandidatesSql(cond, params, chain);
    expectIndex(cand('h.address >= ? AND h.address < ?', ['tnam1qxyz', 'tnam1qxy{'], 'namada'), /SEARCH h USING INDEX sqlite_autoindex_holders_1 \(chain=\? AND address>\? AND address<\?\)/);
    expectIndex(cand('h.address = ?', [tn(1)]), /SEARCH h USING INDEX sqlite_autoindex_holders_1 \(chain=\? AND address=\?\)/);
    expectIndex(cand('substr(h.address, -4) = ? AND substr(h.address, ?) = ?', ['kj4m', -5, 'zkj4m']), /SEARCH h USING INDEX holders_tail \(<expr>=\?\)/);
    const named = wordCond(wordKeys('early'), 'h.address');
    expectIndex(cand(named.sql, named.params), /SEARCH t USING PRIMARY KEY \(token>\? AND token<\?\)/);
    expectIndex(cand('h.address IN (SELECT l1.address FROM labels l1 WHERE l1.category = ?)', ['backer']), /SEARCH l1 USING INDEX labels_cat \(category=\?\)/);
  });

  it('the moves pages: the head, a cursor, a date, one kind, a whole address (two ranges merged), and their counts', () => {
    const T = Date.UTC(2026, 9, 20);
    const cur = { kind: 'cursor' as const, cursor: { ts: T, height: 5, id: 'x' } };
    const TS = /SEARCH f USING INDEX flows_ts \(ts<\?\)/;
    const TS_WINDOW = /SEARCH f USING INDEX flows_ts \(ts>\? AND ts<\?\)/;
    // [filter, the page's index, the head count's index]: a page walks the feed's order; a count reads the index of its
    // narrowest filter (flows-query.ts timeCountIndex): a kind group its kinds' ranges, a window its range, one chain its
    // rows (on production the Osmosis trades' count read 2,768 rows on flows_chain_height and 55,231 on flows_ts)
    const cases: [FlowsFilter, RegExp, RegExp][] = [
      [{ asOf: T }, TS, TS],
      [{ asOf: T, onePerCrossing: true, minNam: 1000, excludeBots: true }, TS, TS],
      [{ asOf: T, chain: 'namada', kind: 'dex' }, TS, /SEARCH f USING INDEX flows_kind \(kind=\? AND ts<\?\)/],
      [{ asOf: T, kind: 'dex', excludeBots: true }, TS, /SEARCH f USING INDEX flows_kind \(kind=\? AND ts<\?\)/],
      [{ asOf: T, kind: 'ibc', since: T - 86_400_000 }, TS_WINDOW, /SEARCH f USING INDEX flows_kind \(kind=\? AND ts>\? AND ts<\?\)/],
      [{ asOf: T, chain: 'osmosis' }, TS, /SEARCH f USING INDEX flows_chain_height \(chain=\?\)/],
      [{ asOf: T, chain: 'osmosis', since: T - 86_400_000 }, TS_WINDOW, TS_WINDOW],
      [{ asOf: T, since: T - 86_400_000 }, TS_WINDOW, TS_WINDOW],
      [{ asOf: T, kind: 'sell', chain: 'osmosis' }, /SEARCH f USING INDEX flows_kind \(kind=\? AND ts<\?\)/, /SEARCH f USING INDEX flows_kind \(kind=\? AND ts<\?\)/],
      [{ asOf: T, addr: tn(1) }, /MERGE \(UNION ALL\).*SEARCH f USING INDEX flows_from \(from_addr=\? AND ts<\?\).*SEARCH f USING INDEX flows_to \(to_addr=\? AND ts<\?\)/, /SEARCH f USING INDEX flows_from/],
    ];
    for (const [f, index, countIndex] of cases) {
      const mode = flowsMode(f) as Exclude<FlowsMode, 'rows'>;
      for (const before of [null, cur, { kind: 'time' as const, ts: T - 1000 }]) expectIndex(flowsPageSql(flowSelect, f, mode, before, 51, 0), index);
      expectIndex(flowsCountSql(f, mode), countIndex);
      expectIndex(flowsLastSql(f, mode), mode === 'address' ? /SEARCH f USING INDEX flows_from/ : /SEARCH f USING INDEX flows_(ts|kind)/);
    }
  });

  it('a record (three hash indexes), a block, an address start: their rows on their own indexes', () => {
    const T = Date.UTC(2026, 9, 20);
    expect(flowsMode({ asOf: T, hash: 'A1B2C3D4' })).toBe('rows');
    expectIndex(flowsRowsSql(flowSelect, { asOf: T, hash: 'A1B2C3D4' }), /SEARCH f USING INDEX flows_hash \(tx_hash>\? AND tx_hash<\?\).*SEARCH f USING INDEX flows_hash_wrapper.*SEARCH f USING INDEX flows_hash_inner/);
    expectIndex(flowsRowsSql(flowSelect, { asOf: T, height: 8_294_006 }), /SEARCH f USING INDEX flows_chain_height \(chain=\? AND height=\?\)/);
    expectIndex(flowsRowsSql(flowSelect, { asOf: T, addr: 'tnam1qxyz' }), /SEARCH f USING INDEX flows_from \(from_addr>\? AND from_addr<\?\).*SEARCH f USING INDEX flows_to \(to_addr>\? AND to_addr<\?\)/);
    expectIndex({ sql: `SELECT ${FIRST_TS_SQL('osmosis')} t`, params: [] }, /SEARCH flows USING INDEX flows_chain_height \(chain=\?\)/);
  });
});

describe('walking the list through the API gives every row once, in order, with ranks that continue', () => {
  /** 260 Namada holders with many equal totals, 40 stakers with no spendable row, 40 Osmosis holders, a pool, the PoS account. */
  async function seeded() {
    const db = testD1();
    await runStmts(db, listingBalanceStmts(Array.from({ length: 260 }, (_, i) => ({ address: tn(i), balance: String(((i * 7) % 13) * 1_000_000 + (i % 4 === 0 ? 0 : 500_000)) })), 100, T0));
    await runStmts(db, stmt.stakesVerified(Array.from({ length: 80 }, (_, i) => ({ address: tn(i * 3 + (i < 40 ? 0 : 1000)), bondedNam: (i % 6) * 2.5, delegations: [] })), 2690, 100, T0, BOND_LISTING_SRC));
    await runStmts(db, Array.from({ length: 40 }, (_, i) => stmt.verifiedBalance('osmosis', os(i), String((i % 5) * 2_000_000 + 1), null, T0, 'keplr_rest')));
    insert(db, 'labels', [{ address: os(3), chain: 'osmosis', label: 'Osmosis Pool #3005 (NAM / USDC)', category: 'pool', source: 'auto', updated_at: 1 }]);
    await runStmts(db, [stmt.verifiedBalance('namada', POS, '300000000000000', 1, T0, 'node')]);
    return db;
  }
  const api = async (db: ReturnType<typeof testD1>, url: string) => {
    const res = await app.request(url, {}, { DB: db } as any);
    expect(res.status, url).toBe(200);
    return (await res.json()) as HoldersResponse;
  };

  it('by cursor and by page, for each order and chain, the same rows as the reference order', async () => {
    const db = await seeded();
    for (const by of ['total', 'liquid', 'bonded'] as const) {
      for (const chain of ['namada', 'osmosis', 'all'] as const) {
        const col = by === 'total' ? 'total_num' : by === 'liquid' ? 'balance_num' : 'stake_num';
        const all = db.raw.prepare(`SELECT address FROM holders WHERE total_num > 0 AND address != ? AND address != ? ${chain === 'all' ? '' : `AND chain = '${chain}'`} ORDER BY ${col} DESC, address`).all(POS, os(3)).map((r: any) => r.address);
        const seen: { address: string; rank: number }[] = [];
        let after: string | null = null;
        let first: HoldersResponse | null = null;
        for (let guard = 0; guard < 100; guard++) {
          const r = await api(db, `/api/holders?chain=${chain}&by=${by}&limit=25${after ? `&after=${after}` : ''}`);
          first ??= r;
          seen.push(...r.holders.map((h) => ({ address: h.address, rank: h.rank })));
          after = r.next ?? null;
          if (!after) break;
        }
        expect(seen.map((s) => s.address), `${by} ${chain}`).toEqual(all);
        expect(seen.map((s) => s.rank)).toEqual(all.map((_, i) => i + 1));
        expect(first!.total).toBe(all.length);
        // page n by offset is the rows after page n-1's cursor
        const p3 = await api(db, `/api/holders?chain=${chain}&by=${by}&limit=25&page=3`);
        expect(p3.holders.map((h) => h.address)).toEqual(all.slice(50, 75));
        expect(p3.holders.map((h) => h.rank)).toEqual(all.slice(50, 75).map((_, i) => 51 + i));
      }
    }
  });

  it('a crafted cursor cannot print a rank: the position is read again on the index', async () => {
    const db = await seeded();
    const p1 = await api(db, '/api/holders?chain=namada&limit=10');
    const c = decodeHolderCursor(p1.next)!;
    const forged = encodeHolderCursor({ ...c, rank: 1 });
    const p2 = await api(db, `/api/holders?chain=namada&limit=10&after=${forged}`);
    expect(p2.holders[0].rank).toBe(11);
    expect(p2.page).toBe(2);
  });

  it('a balance written between two cursor pages repeats or drops only a row that crossed the cursor', async () => {
    const db = await seeded();
    const p1 = await api(db, '/api/holders?chain=namada&limit=30');
    const tail = (await api(db, `/api/holders?chain=namada&limit=100&after=${p1.next}`)).holders.map((h) => h.address);
    const moved = tail[5];
    // a row behind the cursor grows past it: it is not on the next page any more; every other row still is
    await runStmts(db, [stmt.namadaBalance({ address: moved, balance: '99000000000000', height: 10_000 } as any, T0 + 1)]);
    const again = (await api(db, `/api/holders?chain=namada&limit=100&after=${p1.next}`)).holders.map((h) => h.address);
    expect(again).toEqual(tail.filter((a) => a !== moved).concat(again.slice(tail.length - 1)));
  });

  it('counts: from kv holders.counts when nothing narrows the list (countsAt), counted in the request otherwise', async () => {
    const db = await seeded();
    const plain = await api(db, '/api/holders?chain=namada&limit=10');
    expect(plain.countsAt).toBeNull(); // nothing stored yet
    await refreshHolderFigures(db as any, Date.now(), { namada: true, osmosis: true });
    const stored = await api(db, '/api/holders?chain=namada&limit=10');
    expect(stored.countsAt).not.toBeNull();
    expect(stored.total).toBe(plain.total);
    expect(stored.categories).toEqual(plain.categories);
    const sized = await api(db, '/api/holders?chain=namada&limit=10&min=5');
    expect(sized.countsAt).toBeNull();
    expect(sized.total).toBe(db.raw.prepare("SELECT COUNT(*) n FROM holders WHERE chain = 'namada' AND total_num >= 5 AND address != ?").get(POS).n);
    expect(sized.holders.every((h) => h.total >= 5)).toBe(true);
    const bySearch = await api(db, `/api/holders?chain=namada&limit=10&search=${tn(7).slice(0, 9)}`);
    expect(bySearch.countsAt).toBeNull();
    expect(bySearch.holders.every((h) => h.address.startsWith(tn(7).slice(0, 9)))).toBe(true);
    expect(stored.asOf).toBeGreaterThan(0);
  });
});
