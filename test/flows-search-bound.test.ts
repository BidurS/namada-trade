// Group D (security review, lead GET-api-flows:search-like-count-fullscan): /api/flows?search= walked the whole flows
// table twice for a term that matches nothing (the page, then the head count), with no check on the text. A text search
// now reads at most SEARCH_SCAN entries of its index per request and goes on by `next`; text no address or record can
// hold is answered without a walk; a text search is never counted by a second walk. On the D1 stand-in, 20,000 flows;
// LIKE is counted by the calls made with the search's own pattern.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { testD1 } from './d1-sqlite';
import { app } from '../worker/src/api';
import { SEARCH_SCAN, scanFloorSql, flowsPageSql, flowsFilterFromQuery } from '../worker/src/flows-query';
import { flowSelect } from '../worker/src/analytics';
import { fetchFlowsPage, SEARCH_READS } from '../web/src/api';

const SCAN = 10_000;
const N = 20_000;
const T0 = Date.UTC(2025, 0, 1);
const NOW = Date.UTC(2026, 9, 22);
const B32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const HEX = '0123456789ABCDEF';
let seed = 7;
const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
const pick = (s: string, n: number) => Array.from({ length: n }, () => s[Math.floor(rnd() * s.length)]).join('');

function seeded() {
  seed = 7;
  const db = testD1();
  const addrs = Array.from({ length: 3000 }, (_, i) => (i % 3 ? `tnam1${pick(B32, 40)}` : `osmo1${pick(B32, 38)}`));
  const ins = db.raw.prepare('INSERT INTO flows (id, chain, height, ts, tx_hash, kind, from_addr, to_addr, amount_num, meta) VALUES (?,?,?,?,?,?,?,?,?,?)');
  db.raw.exec('BEGIN');
  for (let i = 0; i < N; i++) {
    const chain = i % 4 === 0 ? 'osmosis' : 'namada';
    const hash = pick(HEX, 64);
    // runs of 7 moves at one time (a block), so a window can end inside one
    ins.run(`${chain}:${hash}:${i}`, chain, 1000 + i, T0 + Math.floor(i / 7) * 60_000, hash, ['buy', 'sell', 'transfer', 'bond', 'ibc_out', 'shield'][i % 6],
      addrs[(i * 7) % 3000], addrs[(i * 13 + 1) % 3000], 10 + (i % 500), chain === 'namada' ? '{"source":"indexer"}' : null);
  }
  db.raw.exec('COMMIT');
  const like = { n: 0, term: '' };
  const re = (p: string) => new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.')}$`, 'is');
  db.raw.function('like', { varargs: true }, (pattern: string | null, value: string | null) => {
    if (pattern == null || value == null) return null;
    if (like.term && pattern === `%${like.term}%`) like.n++;
    return re(pattern).test(value) ? 1 : 0;
  });
  const reference = (t: string) => db.raw.prepare(`SELECT id FROM flows WHERE ts <= ? AND (from_addr LIKE ? OR to_addr LIKE ? OR tx_hash LIKE ?) ORDER BY ts DESC, height DESC, id DESC`)
    .all(NOW, `%${t}%`, `%${t}%`, `%${t}%`).map((r: any) => r.id as string);
  return { db, addrs, like, reference };
}
const get = async (db: any, url: string) => {
  const res = await app.request(url, {}, { DB: db } as any);
  return { status: res.status, body: (await res.json()) as any };
};
/** At most this many LIKE calls with the search's pattern: three columns of each entry the walk reads. */
const BOUND = 3 * (SCAN + 7);
afterEach(() => vi.unstubAllGlobals());

describe('a text search reads at most SEARCH_SCAN moves a request', () => {
  it('a term no move holds: one window, then `next` from where it stopped; no head count', async () => {
    expect(SEARCH_SCAN).toBe(SCAN);
    const { db, like } = seeded();
    like.term = 'zzqqzzqq';
    const r = await get(db, `/api/flows?search=zzqqzzqq&pairs=one&page=1&limit=50&at=${NOW}`);
    expect(r.status).toBe(200);
    expect(r.body.flows).toEqual([]);
    expect(r.body.total).toBeNull(); // not known: the window did not reach the oldest move
    expect(r.body.next).toEqual(expect.any(String));
    expect(like.n).toBeLessThanOrEqual(BOUND); // was 120,000 (6 a row: the page walk and the count)
    like.n = 0;
    const r2 = await get(db, `/api/flows?search=zzqqzzqq&pairs=one&limit=50&at=${NOW}&before=${r.body.next}`);
    expect(r2.body.flows).toEqual([]);
    expect(r2.body.next).toBeNull(); // the second window reached the oldest move
    expect(like.n).toBeLessThanOrEqual(BOUND);
  });

  it('walking `next` gives every match once, in order; a dense term fills its page and is not counted', async () => {
    const { db, addrs, like, reference } = seeded();
    for (const term of [addrs[5].slice(-6), 'tnam1', '00']) {
      const all = reference(term);
      const seen: string[] = [];
      let before = '';
      for (let i = 0; i < 2000; i++) {
        like.n = 0;
        like.term = term;
        const r = await get(db, `/api/flows?search=${term}&limit=50&at=${NOW}${before ? `&before=${before}` : ''}`);
        expect(like.n, term).toBeLessThanOrEqual(BOUND);
        if (!before && all.length > 50) expect(r.body.total, term).toBeNull();
        seen.push(...r.body.flows.map((f: any) => f.id));
        if (!r.body.next) break;
        before = r.body.next;
      }
      expect(seen, term).toEqual(all);
    }
  });

  it('a text search in one kind walks flows_kind the same way; the window end and the page are index reads', async () => {
    const f = flowsFilterFromQuery((k) => ({ search: 'kj4m', kind: 'sell' } as Record<string, string>)[k], NOW);
    const { db } = seeded();
    const plan = (q: { sql: string; params: unknown[] }) => db.raw.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...q.params).map((r: any) => r.detail).join(' | ');
    expect(plan(scanFloorSql(f, 'kind', null))).toMatch(/SEARCH f USING COVERING INDEX flows_kind \(kind=\? AND ts<\?\)/);
    const t = flowsFilterFromQuery((k) => ({ search: 'kj4m' } as Record<string, string>)[k], NOW);
    expect(plan(scanFloorSql(t, 'time', null))).toMatch(/SEARCH f USING COVERING INDEX flows_ts \(ts<\?\)/);
    const page = plan(flowsPageSql(flowSelect, t, 'time', null, 51, 0, { ts: T0, height: 1, id: 'x' }));
    expect(page).toMatch(/SEARCH f USING INDEX flows_ts \(ts>\? AND ts<\?\)/);
    expect(page).not.toMatch(/TEMP B-TREE/);
  });
});

describe('text no address or record can hold, and what the app never sends', () => {
  it('is answered at once: a space, a LIKE wildcard, punctuation, more than 64 characters', async () => {
    const { db, like } = seeded();
    for (const s of ['a b', '_', '%', 'tnam1-x', '…kj4m', 'x'.repeat(65)]) {
      like.term = s;
      like.n = 0;
      const q0 = db.queries;
      const r = await get(db, `/api/flows?search=${encodeURIComponent(s)}&page=1&limit=50&at=${NOW}`);
      expect(r.status, s).toBe(200);
      expect(r.body.flows, s).toEqual([]); // "_" listed every move before
      expect(r.body.total, s).toBe(0);
      expect(r.body.last, s).toBeNull();
      expect(like.n, s).toBe(0); // "a b" made 120,000 LIKE calls before
      expect(db.queries - q0, s).toBeLessThanOrEqual(1); // the flow index's first move only
    }
  });

  it('refused: text longer than the search field takes; a text search by page number without a position', async () => {
    const { db } = seeded();
    expect((await get(db, `/api/flows?search=${'a'.repeat(301)}`)).status).toBe(400);
    expect((await get(db, `/api/flows?search=kj4m&page=2&limit=50`)).status).toBe(400);
    expect((await get(db, `/api/flows?search=${'a'.repeat(300)}`)).status).toBe(200);
  });

  it('the export of a text search walks once, never twice, and says when it is cut', async () => {
    const { db, like } = seeded();
    like.term = 'zzqqzzqq';
    const r = await get(db, `/api/export/flows?search=zzqqzzqq&format=json&at=${NOW}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ count: 0, total: 0, truncated: false });
    expect(like.n).toBeLessThanOrEqual(3 * N); // was 6 a row
    like.term = 'tnam1';
    like.n = 0;
    const d = await get(db, `/api/export/flows?search=tnam1&format=json&limit=100&at=${NOW}`);
    expect(d.body).toMatchObject({ count: 100, total: null, truncated: true });
  });
});

describe('the moves list reads a text search page by page as one walk would give it (web/src/api.ts fetchFlowsPage)', () => {
  it('the head page of a sparse term: its rows and its count; page 3 by number without a cursor', async () => {
    const { db, addrs, reference } = seeded();
    let requests = 0;
    vi.stubGlobal('fetch', (url: string) => { requests++; return app.request(url, {}, { DB: db } as any); });
    for (const term of [addrs[5].slice(-6), 'tnam1', 'zzqqzzqq']) {
      const all = reference(term);
      requests = 0;
      const p1 = await fetchFlowsPage({ search: term, page: 1, limit: 50, asOf: NOW });
      expect(requests).toBeLessThanOrEqual(SEARCH_READS);
      expect(p1.flows.map((f) => f.id), term).toEqual(all.slice(0, 50));
      expect(p1.total, term).toBe(all.length <= 50 ? all.length : null);
      expect(p1.next == null, term).toBe(all.length <= 50);
      const p3 = await fetchFlowsPage({ search: term, page: 3, limit: 50, asOf: NOW });
      expect(p3.flows.map((f) => f.id), term).toEqual(all.slice(100, 150));
    }
  });
});
