// GET /api/address/:addr reads a bounded number of holder index entries however deep the address sits, and its
// answer is kept at the edge by its path alone (security review, 2026-10-22).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { app } from '../worker/src/api';
import { cachedApi, cacheKeyUrl } from '../worker/src/http';
import {
  refreshHolderFigures, readChainMarks, placeOn, marksSql, HOLDER_MARKS_KV, MARK_GAP, RANK_WALK_MAX, INTERNAL_ADDRS,
} from '../worker/src/holders';
import { testD1, insert, type TestD1 } from './d1-sqlite';
import type { AddressReport } from '../shared/types';

const NOW = Date.UTC(2026, 9, 22, 12, 0);
const N = 20_000;
const POS = 'tnam1qgqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqc8j2fp';
const B32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
/** The i-th made-up Namada address (45 characters, in the bech32 alphabet, increasing with i). */
const tn = (i: number, lead = 'q') => { let s = ''; for (let k = 0, n = i; k < 8; k++, n = Math.floor(n / 32)) s = B32[n % 32] + s; return `tnam1q${lead}${'q'.repeat(30)}${s}`; };
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

/**
 * N Namada holders: balances in groups of five equal values, the last 3,000 at 0.000001 (one tie group, ordered by
 * address); every 40th also stakes (so the two orders differ), 50 stake only (balance 0); a protocol account ahead of
 * everyone and a pool-labelled address, both off the list.
 */
function seed(): TestD1 {
  const db = testD1();
  db.exec('BEGIN');
  const h = db.raw.prepare('INSERT INTO holders (chain, address, balance, balance_num, updated_at) VALUES (?, ?, ?, ?, ?)');
  const s = db.raw.prepare('INSERT INTO stakes (address, bonded_num, delegations, verified_at, verified_src, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
  for (let i = 0; i < N; i++) {
    const bal = i >= N - 3000 ? 0.000001 : Math.floor((N - i) / 5) + 1;
    h.run('namada', tn(i), String(bal), bal, NOW - 3600_000);
    if (i % 40 === 0) s.run(tn(i), 777.5, '[]', NOW - 3600_000, 'test', NOW - 3600_000);
  }
  for (let i = 0; i < 50; i++) s.run(tn(i, 'z'), 5 + i, '[]', NOW - 3600_000, 'test', NOW - 3600_000);
  h.run('namada', POS, '1e9', 1e9, NOW);
  db.exec('COMMIT');
  insert(db, 'labels', [{ address: tn(10), chain: 'namada', label: 'A pool', category: 'pool', source: 'auto' }]);
  return db;
}

/** The two orders as the holder list ranks them, computed here from the rows (listed: NAM held, not protocol, not a pool). */
function places(db: TestD1) {
  const rows = (db.raw.prepare("SELECT address, balance_num b, total_num t FROM holders WHERE chain = 'namada' AND total_num > 0").all() as any[])
    .filter((r) => !INTERNAL_ADDRS.includes(r.address) && r.address !== tn(10));
  const order = (k: 'b' | 't') => [...rows].sort((x, y) => y[k] - x[k] || (x.address < y.address ? -1 : 1));
  const byTotal = new Map(order('t').map((r, i) => [r.address, i + 1]));
  const byLiquid = new Map(order('b').map((r, i) => [r.address, i + 1]));
  return { rows: order('t'), byTotal, byLiquid };
}

/** Every statement the route prepares, with its parameters. */
function record(db: TestD1) {
  const seen: { sql: string; params: unknown[] }[] = [];
  const prepare = db.prepare.bind(db);
  db.prepare = (sql: string) => {
    const st = prepare(sql);
    const bind = st.bind.bind(st);
    (st as any).bind = (...p: unknown[]) => { seen.push({ sql, params: p }); return bind(...p); };
    return st;
  };
  return seen;
}
const report = async (db: TestD1, a: string) => (await (await app.request(`/api/address/${a}`, {}, { DB: db } as any)).json()) as AddressReport;
const holderWalks = (seen: { sql: string; params: unknown[] }[]) => seen.filter((s) => /INDEXED BY holders_(total|rank)\b/.test(s.sql));

describe('the address report reads a bounded part of the holder index', () => {
  it('the bottom of a 20,000-holder list: both places exact, each from its mark, each walk at most RANK_WALK_MAX entries', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const db = seed();
    await refreshHolderFigures(db as any, NOW, { namada: true, osmosis: true });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 }))); // every live read falls back to the stored rows
    const { rows, byTotal, byLiquid } = places(db);
    const bottom = rows[rows.length - 1].address;
    expect(byTotal.get(bottom)).toBeGreaterThan(19_000);
    const seen = record(db);
    const r = await report(db, bottom);
    expect(r.rankTotal).toBe(byTotal.get(bottom));
    expect(r.rank).toBe(byLiquid.get(bottom));
    const walks = holderWalks(seen);
    expect(walks.length).toBe(2);
    for (const w of walks) {
      // a range of the index from the mark down to the address, cut off one entry past the bound: never a count from the top
      expect(w.sql).toMatch(/^SELECT COUNT\(\*\) n FROM \(SELECT 1 FROM holders h INDEXED BY holders_(total|rank) WHERE .* LIMIT \?\)$/s);
      expect(w.params[w.params.length - 1]).toBe(RANK_WALK_MAX + 1);
      const plan = (db.raw.prepare(`EXPLAIN QUERY PLAN ${w.sql}`).all(...w.params) as any[]).map((p) => p.detail).join(' | ');
      expect(plan).toMatch(/COVERING INDEX holders_(total|rank) \(chain=\? AND (total_num|balance_num)>\? AND (total_num|balance_num)<\?\)/);
      const inner = w.sql.replace(/^SELECT COUNT\(\*\) n FROM \(/, '').replace(/\)$/, '');
      expect((db.raw.prepare(inner).all(...w.params) as any[]).length).toBeLessThanOrEqual(MARK_GAP);
    }
  });

  it('every place from the marks equals the list\'s, across marks, tie groups, stakers and the stake-only', async () => {
    const db = seed();
    await refreshHolderFigures(db as any, NOW, { namada: true, osmosis: true });
    const marks = await readChainMarks(db as any, 'namada', NOW);
    expect(marks!.marks.total.length).toBe(Math.floor((N + 50 - 1) / MARK_GAP)); // 20,049 listed
    const { rows, byTotal, byLiquid } = places(db);
    for (const [i, r] of rows.entries()) {
      if (i % 7 !== 0 && i % MARK_GAP > 1 && i % MARK_GAP < MARK_GAP - 1 && i < rows.length - 5) continue; // every 7th, each side of every mark, the end
      expect(await placeOn(db as any, 'namada', 'total', { value: r.t, address: r.address }, marks), r.address).toBe(byTotal.get(r.address));
      if (r.b > 0) expect(await placeOn(db as any, 'namada', 'liquid', { value: r.b, address: r.address }, marks), r.address).toBe(byLiquid.get(r.address));
    }
    // an address the list does not hold, by its live balance: one more than the holders with more (the old COUNT(*) + 1)
    for (const v of [1e9, 4000.5, 2001, 2000.99, 0.000001, 0.0000005]) {
      const more = (db.raw.prepare("SELECT COUNT(*) n FROM holders WHERE chain='namada' AND balance_num > ? AND address NOT IN (?, ?)").get(v, POS, tn(10)) as any).n;
      const got = await placeOn(db as any, 'namada', 'liquid', { value: v, address: '' }, marks);
      expect(got == null ? null : got + 1, String(v)).toBe(more + 1);
    }
    // the marks are built in one walk of each index in its order: no sort
    for (const by of ['total', 'liquid'] as const) {
      const q = marksSql('namada', by);
      expect((db.raw.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...q.params) as any[]).map((p) => p.detail).join(' | ')).not.toMatch(/TEMP B-TREE/);
    }
    expect(JSON.parse((db.raw.prepare('SELECT value FROM kv WHERE key = ?').get(HOLDER_MARKS_KV) as any).value)).toMatchObject({ v: 1, gap: MARK_GAP });
  });

  it('without marks (a new database, a stalled cron) the first RANK_WALK_MAX places are exact and no deeper place is given', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const db = seed();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    const { rows, byTotal, byLiquid } = places(db);
    const top = rows[0].address, deep = rows[rows.length - 1].address;
    expect(await report(db, top)).toMatchObject({ rankTotal: byTotal.get(top), rank: byLiquid.get(top) });
    const seen = record(db);
    expect(await report(db, deep)).toMatchObject({ rankTotal: null, rank: null }); // the sheet shows no rank line, not "Not ranked"
    for (const w of holderWalks(seen)) expect(w.params[w.params.length - 1]).toBe(RANK_WALK_MAX + 1);
  });

  it('rows written after the marks: a place moves only by the rows that crossed its mark; a walk past its bound gives no place', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const db = seed();
    await refreshHolderFigures(db as any, NOW, { namada: true, osmosis: true });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    const { rows } = places(db);
    const p = rows[1399]; // place 1,400: its mark is the one at 1,000
    expect((await report(db, p.address)).rankTotal).toBe(1400);
    // 20 holders from the top drop to just above it: still ahead of it, but now behind the mark they were counted in
    for (let i = 0; i < 20; i++) db.raw.prepare("UPDATE holders SET balance_num = ? WHERE chain = 'namada' AND address = ?").run(p.t + 0.25, rows[i].address);
    const moved = (await report(db, p.address)).rankTotal!;
    expect(moved - 1400).toBeGreaterThanOrEqual(0);
    expect(moved - 1400).toBeLessThanOrEqual(20);
    // RANK_WALK_MAX new holders land between the mark and it: no place, never a wrong one
    db.exec('BEGIN');
    for (let i = 0; i < RANK_WALK_MAX; i++) db.raw.prepare('INSERT INTO holders (chain, address, balance, balance_num, updated_at) VALUES (?, ?, ?, ?, ?)').run('namada', tn(i, 'y'), 'x', p.t + 0.1, NOW);
    db.exec('COMMIT');
    expect(await report(db, p.address)).toMatchObject({ rankTotal: null, rank: null });
    // the next build places it again, exactly
    await refreshHolderFigures(db as any, NOW + 60_000, { namada: true, osmosis: true });
    const { byTotal } = places(db);
    expect((await report(db, p.address)).rankTotal).toBe(byTotal.get(p.address));
  });
});

describe('the address report is kept at the edge by its path alone', () => {
  function edge() {
    const store = new Map<string, Response>();
    const pending: Promise<unknown>[] = [];
    vi.stubGlobal('caches', { default: { match: async (r: Request) => store.get(r.url)?.clone(), put: async (r: Request, res: Response) => { store.set(r.url, res); } } });
    const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as any;
    const calls: Request[] = [];
    const fetchApp = (r: Request) => { calls.push(r); return new Response('{"a":1}', { status: r.url.includes('/api/address/tnam1') || r.url.includes('/api/address/osmo1') ? 200 : 400, headers: { 'content-type': 'application/json' } }); };
    return { store, ctx, calls, fetchApp, settle: () => Promise.all(pending) };
  }
  it('a repeat, or the same path with any query, is served from the copy; the route is asked with no query', async () => {
    const e = edge();
    const a = tn(5);
    for (const q of ['', '?r=1', '?at=1792000000000&r=2']) {
      const r = await cachedApi(new Request(`https://namada.trade/api/address/${a}${q}`), {} as any, e.ctx, e.fetchApp);
      await e.settle();
      expect(r.status).toBe(200);
      expect(r.headers.get('cache-control')).toBe('public, max-age=5');
    }
    expect(e.calls.map((c) => c.url)).toEqual([`https://namada.trade/api/address/${a}`]);
    expect(cacheKeyUrl(new URL(`https://namada.trade/api/address/${a}?x=1`))).toBe(`https://namada.trade/api/address/${a}`);
    await cachedApi(new Request(`https://namada.trade/api/address/${tn(6)}`), {} as any, e.ctx, e.fetchApp);
    expect(e.calls).toHaveLength(2); // another address is its own answer
    // a path that is not an address is answered by the route each time and never stored
    for (let i = 0; i < 2; i++) await cachedApi(new Request('https://namada.trade/api/address/nope'), {} as any, e.ctx, e.fetchApp);
    await e.settle();
    expect(e.calls).toHaveLength(4);
    expect([...e.store.keys()].every((k) => /\/api\/address\/(tnam1|osmo1)/.test(k))).toBe(true);
  });
});
