// Stage 1 (scale plan item 6; own audit 2026-10-29, M2): /api/holders and its export never walk the whole holder index
// for a count. `min=0` is no size (the stored counts answer it); a size range is counted up to WALK_COUNT_MAX and says
// "more than" past it, its chips are not counted then; a cursor is placed by a count of at most WALK_COUNT_MAX entries,
// and one further down is refused with words, never placed by a guess.
import { describe, it, expect } from 'vitest';
import { testD1, insert, type TestD1 } from './d1-sqlite';
import { app } from '../worker/src/api';
import { refreshHolderFigures, WALK_COUNT_MAX } from '../worker/src/holders';
import { encodeHolderCursor } from '../shared/paging';
import type { HoldersResponse } from '../shared/types';

const B32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
/** A whole Namada address, distinct per n. */
const tn = (n: number) => `tnam1q${B32[n % 32]}${B32[Math.floor(n / 32) % 32]}${B32[Math.floor(n / 1024) % 32]}${'q'.repeat(36)}`;
/** More holders than one count reads: holder i holds i + 1 NAM. */
const N = WALK_COUNT_MAX + 50;

function seeded(): TestD1 {
  const db = testD1();
  insert(db, 'holders', Array.from({ length: N }, (_, i) => ({ chain: 'namada', address: tn(i), balance: String((i + 1) * 1e6), balance_num: i + 1, updated_at: Date.now() })));
  // a few labels, so the chips have something to count
  insert(db, 'labels', [0, 1, 2].map((i) => ({ address: tn(N - 1 - i), chain: 'namada', label: `Whale ${i}`, category: 'whale', source: 'auto' })));
  return db;
}

/** Every statement the routes prepare, with what it was bound to. */
function spied(db: TestD1) {
  const seen: { sql: string; params: unknown[] }[] = [];
  const wrapped = { ...db, prepare: (sql: string) => { const s = db.prepare(sql); return { ...s, sql, bind: (...p: unknown[]) => { seen.push({ sql, params: p }); return s.bind(...p); }, first: s.first.bind(s), all: s.all.bind(s) } as any; }, batch: db.batch };
  return { wrapped, seen };
}
const get = (db: unknown, path: string) => app.request(path, {}, { DB: db } as any) as Promise<Response>;
const json = async (db: unknown, path: string) => (await (await get(db, path)).json()) as HoldersResponse;
/** The statements that count a walk of the holder index (walkCountSql, walkCategorySql). */
const walkCounts = (seen: { sql: string }[]) => seen.filter((s) => /COUNT\(\*\) n/.test(s.sql) && /FROM holders h INDEXED BY/.test(s.sql));

describe('the holder list never walks the whole index for a count (own audit M2)', () => {
  it('min=0 is no size: the stored counts answer it, with no walk counted', async () => {
    const db = seeded();
    await refreshHolderFigures(db as any, Date.now(), { namada: true, osmosis: true });
    const plain = await json(db, '/api/holders?chain=namada&limit=10');
    const { wrapped, seen } = spied(db);
    const zero = await json(wrapped, '/api/holders?chain=namada&limit=10&min=0');
    expect(zero.countsAt).not.toBeNull();
    expect(zero.total).toBe(N);
    expect(zero.total).toBe(plain.total);
    expect(zero.categories).toEqual(plain.categories);
    expect(zero.holders.map((h) => h.address)).toEqual(plain.holders.map((h) => h.address));
    expect(walkCounts(seen)).toEqual([]);
    // a negative size is still refused
    expect((await get(db, '/api/holders?chain=namada&min=-1')).status).toBe(400);
  });

  it('a size range matching more than WALK_COUNT_MAX: "more than" (total null, totalOver), the chips not counted, the rows and next as before', async () => {
    const db = seeded();
    await refreshHolderFigures(db as any, Date.now(), { namada: true, osmosis: true });
    const { wrapped, seen } = spied(db);
    const r = await json(wrapped, '/api/holders?chain=namada&limit=10&min=1');
    expect(r.total).toBeNull();
    expect(r.totalOver).toBe(WALK_COUNT_MAX);
    expect(r.categories).toBeNull();
    expect(r.countsAt).toBeNull();
    expect(r.holders.map((h) => h.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(r.holders[0].address).toBe(tn(N - 1));
    expect(r.next).toBeTruthy();
    // every count of the walk reads at most WALK_COUNT_MAX + 1 entries
    const counts = walkCounts(seen);
    expect(counts.length).toBe(2);
    for (const q of counts) {
      expect(q.sql).toMatch(/LIMIT \?\)/);
      expect(q.params.at(-1)).toBe(WALK_COUNT_MAX + 1);
    }
  });

  it('a size range under the bound is counted exactly, chips included', async () => {
    const db = seeded();
    const r = await json(db, '/api/holders?chain=namada&limit=10&min=10000');
    // holders 10,000 to N hold that much or more
    expect(r.total).toBe(N - 9_999);
    expect(r.totalOver).toBeUndefined();
    expect(r.categories?.total).toBe(N - 9_999);
    expect(r.categories?.counts).toContainEqual({ category: 'whale', n: 3 });
    // exactly at the bound is still a count
    const at = await json(db, `/api/holders?chain=namada&limit=10&min=${N - WALK_COUNT_MAX + 1}`);
    expect(at.total).toBe(WALK_COUNT_MAX);
    const past = await json(db, `/api/holders?chain=namada&limit=10&min=${N - WALK_COUNT_MAX}`);
    expect(past.total).toBeNull();
    expect(past.totalOver).toBe(WALK_COUNT_MAX);
  });

  it('a size in the search text (the search limiter\'s path) is bounded the same way; a size of 0 there is no size', async () => {
    const db = seeded();
    await refreshHolderFigures(db as any, Date.now(), { namada: true, osmosis: true });
    const tiny = await json(db, `/api/holders?chain=namada&limit=10&search=${encodeURIComponent('>0.000001')}`);
    expect(tiny.total).toBeNull();
    expect(tiny.totalOver).toBe(WALK_COUNT_MAX);
    const zero = await json(db, `/api/holders?chain=namada&limit=10&search=${encodeURIComponent('>0')}`);
    expect(zero.total).toBe(N);
  });

  it('a cursor is placed by a bounded count: exact within WALK_COUNT_MAX, refused with words past it', async () => {
    const db = seeded();
    const p1 = await json(db, '/api/holders?chain=namada&limit=100&min=1');
    const p2 = await json(db, `/api/holders?chain=namada&limit=100&min=1&after=${p1.next}`);
    expect(p2.holders[0].rank).toBe(101);
    expect(p2.page).toBe(2);
    expect(p2.holders[0].address).toBe(tn(N - 101));
    // the default list too (no size, no stored counts needed for a cursor's place)
    const d2 = await json(db, `/api/holders?chain=namada&limit=100&after=${p1.next}`);
    expect(d2.holders[0].rank).toBe(101);
    // holder i holds i + 1 NAM, so WALK_COUNT_MAX + 1 entries are at or ahead of holder N - WALK_COUNT_MAX - 1: not placed
    const at = (i: number) => encodeHolderCursor({ value: i + 1, address: tn(i), rank: 1 });
    const r = await get(db, `/api/holders?chain=namada&limit=100&after=${at(N - WALK_COUNT_MAX - 1)}`);
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toMatch(/more than 10,000 holders down the list.*page number \(page=\)/);
    // one entry less deep (WALK_COUNT_MAX at or ahead): placed, at the rank its count gives, never the rank the URL carries
    const ok = await json(db, `/api/holders?chain=namada&limit=10&after=${at(N - WALK_COUNT_MAX)}`);
    expect(ok.holders[0].rank).toBe(WALK_COUNT_MAX + 1);
    expect(ok.holders[0].address).toBe(tn(N - WALK_COUNT_MAX - 1));
    // the same depth by page number still serves (an offset of the index, no count)
    expect((await json(db, `/api/holders?chain=namada&limit=100&page=101&min=1`)).holders[0].rank).toBe(10_001);
  });

  it('the export: past the bound no X-Total-Count, X-Truncated by whether more rows follow, no category tally read', async () => {
    const db = seeded();
    const { wrapped, seen } = spied(db);
    const r = await get(wrapped, '/api/export/holders?chain=namada&min=1&format=json');
    expect(r.status).toBe(200);
    expect(r.headers.get('X-Total-Count')).toBeNull();
    expect(r.headers.get('X-Truncated')).toBe('true');
    const body = (await r.json()) as { count: number; total: number | null; totalOver?: number; truncated: boolean };
    expect(body.count).toBe(10_000);
    expect(body.total).toBeNull();
    expect(body.totalOver).toBe(WALK_COUNT_MAX);
    expect(body.truncated).toBe(true);
    expect(seen.some((s) => /c_none/.test(s.sql))).toBe(false);
    const csv = await get(db, '/api/export/holders?chain=namada&min=1');
    expect(csv.headers.get('Content-Disposition')).toMatch(/namada-trade-holders-namada-first-10000-\d+\.csv/);
    expect(csv.headers.get('X-Total-Count')).toBeNull();
    // under the bound: counted, and the file says "of"
    const few = await get(db, '/api/export/holders?chain=namada&min=10000');
    expect(few.headers.get('X-Total-Count')).toBe(String(N - 9_999));
    expect(few.headers.get('X-Truncated')).toBe('false');
  });
});
