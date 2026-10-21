// W1: GET /api/flows?minNam=&arb=false — newest first, bots removed, at least N NAM, limit clamp kept.
import { describe, it, expect } from 'vitest';
import { flowsWhere, flowsFilterFromQuery, NOT_BOT, NAM_AMOUNT, NOT_LEGACY_TWIN, FLOWS_ORDER } from '../worker/src/flows-query';
import { app } from '../worker/src/api';
import { testD1, insert } from './d1-sqlite';
import type { FlowsResponse } from '../shared/types';

const T = Date.UTC(2026, 9, 17, 12, 0);
const M = 60000;

const flow = (id: string, minsAgo: number, kind: string, amount: number, extra: Record<string, unknown> = {}) => ({
  id, chain: 'osmosis', height: 1000 - minsAgo, ts: T - minsAgo * M, tx_hash: id.toUpperCase(), kind,
  from_addr: 'osmo1from', to_addr: 'osmo1to', amount_num: amount, meta: null, ...extra,
});

function seed() {
  const db = testD1();
  insert(db, 'flows', [
    flow('a', 1, 'sell', 2500),
    flow('b', 2, 'other', 50000, { meta: JSON.stringify({ arb: true }) }),           // bot round trip
    flow('c', 3, 'buy', 999.99),                                                     // under 1,000 NAM
    flow('d', 4, 'shield', 5000, { chain: 'namada', meta: JSON.stringify({ tokenSymbol: 'USDC', descriptor: 'ibc-masp' }) }), // 5,000 USDC, not NAM
    flow('e', 5, 'ibc_in', 1000, { meta: JSON.stringify({ channel: 'channel-98451' }) }), // exactly 1,000
    flow('f', 6, 'bond', 12000, { chain: 'namada', meta: JSON.stringify({ arb: false }) }),
    flow('g', -5, 'sell', 9000),                                                     // after the rewind time
    ...Array.from({ length: 30 }, (_, i) => flow(`z${i}`, 100 + i, 'sell', 1500)),
  ]);
  return db;
}

describe('the flows filter', () => {
  it('reads minNam and arb=false from the query and ignores junk', () => {
    const q = (o: Record<string, string>) => (k: string) => o[k];
    expect(flowsFilterFromQuery(q({ minNam: '1000', arb: 'false' }), T)).toMatchObject({ minNam: 1000, excludeBots: true });
    expect(flowsFilterFromQuery(q({ minNam: 'abc', arb: 'true' }), T)).toMatchObject({ minNam: null, excludeBots: false });
    expect(flowsFilterFromQuery(q({ minNam: '-5' }), T)).toMatchObject({ minNam: null, excludeBots: false });
    expect(flowsFilterFromQuery(q({}), T)).toMatchObject({ minNam: null, excludeBots: false, whale: false });
  });

  it('builds exactly the conditions asked for', () => {
    const w = flowsWhere({ asOf: T, minNam: 1000, excludeBots: true });
    expect(w.where).toBe(`WHERE f.ts <= ? AND ${NOT_LEGACY_TWIN} AND f.amount_num >= ? AND ${NAM_AMOUNT} AND ${NOT_BOT}`);
    expect(w.params).toEqual([T, 1000]);
    expect(flowsWhere({ asOf: T }).where).toBe(`WHERE f.ts <= ? AND ${NOT_LEGACY_TWIN}`);
    const all = flowsWhere({ asOf: T, chain: 'namada', kind: 'ibc', whale: true, search: 'tnam1x' });
    expect(all.where).toContain("f.kind IN ('ibc_in','ibc_out')");
    expect(all.params).toEqual([T, 'namada', '%tnam1x%', '%tnam1x%', '%tnam1x%']);
  });
});

describe('GET /api/flows', () => {
  const get = async (db: ReturnType<typeof testD1>, qs: string) => {
    const res = await app.request(`/api/flows?${qs}`, {}, { DB: db } as any);
    expect(res.status).toBe(200);
    return (await res.json()) as FlowsResponse;
  };

  it('Home "Latest moves": newest first, bots removed, at least 1,000 NAM, other coins never counted as NAM', async () => {
    const db = seed();
    const r = await get(db, `minNam=1000&arb=false&limit=6&at=${T}`);
    expect(r.flows.slice(0, 6).map((f) => f.id)).toEqual(['a', 'e', 'f', 'z0', 'z1', 'z2']);
    expect(r.total).toBe(3 + 30);
    for (let i = 1; i < r.flows.length; i++) expect(r.flows[i - 1].ts).toBeGreaterThanOrEqual(r.flows[i].ts);
  });

  it('keeps bot trades and small moves when not asked to drop them', async () => {
    const r = await get(seed(), `at=${T}&limit=100`);
    expect(r.flows.map((f) => f.id)).toEqual(expect.arrayContaining(['b', 'c', 'd']));
    expect(r.flows.map((f) => f.id)).not.toContain('g'); // newer than the rewind time
  });

  it('keeps the limit clamp (10 to 100) and pages', async () => {
    const db = seed();
    expect((await get(db, `minNam=1000&arb=false&limit=6&at=${T}`)).limit).toBe(10);
    expect((await get(db, `limit=500&at=${T}`)).limit).toBe(100);
    const p2 = await get(db, `minNam=1000&arb=false&limit=10&page=2&at=${T}`);
    expect(p2.page).toBe(2);
    expect(p2.flows[0].id).toBe('z7');
  });

  it('pairs=one shows each bridge crossing once: the sending chain\'s record, or the receiving one when it is alone', async () => {
    const db = seed();
    const pair = { from_addr: 'osmo1sqdwx', to_addr: 'tnam1qq6wus', amount_num: 15000 };
    insert(db, 'flows', [
      flow('sent', 0.5, 'ibc_out', 15000, pair),                                // Osmosis → Namada, sending side
      flow('recv', 0.2, 'ibc_in', 15000, { ...pair, chain: 'namada' }),         // the same transfer, received
      flow('alone', 0.1, 'ibc_in', 15000, { ...pair, chain: 'namada', amount_num: 15001 }), // no sending record
    ]);
    const one = await get(db, `minNam=1000&arb=false&pairs=one&at=${T}`);
    expect(one.flows.slice(0, 3).map((f) => f.id)).toEqual(['alone', 'sent', 'a']);
    const both = await get(db, `minNam=1000&arb=false&at=${T}`);
    expect(both.flows.slice(0, 3).map((f) => f.id)).toEqual(['alone', 'recv', 'sent']);
  });

  it('gives each row the plain label words beside the raw ones', async () => {
    const db = seed();
    insert(db, 'flows', [flow('pos', 0.5, 'withdraw', 200000, { chain: 'namada', from_addr: 'tnam1qgqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqc8j2fp', to_addr: 'tnam1user' })]);
    const r = await get(db, `minNam=1000&arb=false&at=${T}`);
    const w = r.flows.find((f) => f.id === 'pos')!;
    expect(w.fromLabel).toBe('Namada PoS account (staked + unstaking + unclaimed rewards)');
    expect(w.fromLabelSource).toBe('auto');
    expect(w.fromLabelPlain).toBe('Staking account (staked and unstaking NAM)');
    expect(w.toLabelPlain).toBeNull();
  });
});

// ---------------------------------------------------------------- the cursor build (nav-search-plan.md 2.2)
describe('GET /api/flows: keyset pages, dates, addresses, records, blocks', () => {
  const NAM = (n: number) => `tnam1q${'qpzry9x8gf2tvdw0s3jn54khce6mua7l'[n % 32]}${'q'.repeat(39)}`;
  const HEX = (n: number) => `${n.toString(16).toUpperCase().padStart(4, '0')}${'C'.repeat(60)}`;
  /** 137 moves with many equal times and blocks; hashes in every place a record keeps one. */
  function many() {
    const db = testD1();
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < 137; i++) {
      rows.push({
        id: `namada:${HEX(i)}:${i % 3}`, chain: i % 5 ? 'namada' : 'osmosis', height: 8_000_000 - Math.floor(i / 3), ts: T - Math.floor(i / 7) * M,
        tx_hash: HEX(i), kind: i % 6 ? 'transfer' : 'sell', from_addr: NAM(i % 4), to_addr: NAM((i + 1) % 4), amount_num: 100 + i,
        meta: i === 40 ? JSON.stringify({ wrapper: 'ABCDEF01' + 'A'.repeat(56) }) : i === 41 ? JSON.stringify({ innerTxHash: 'FEDCBA98' + 'B'.repeat(56), source: 'x' }) : null,
      });
    }
    insert(db, 'flows', rows);
    return db;
  }
  const get = async (db: ReturnType<typeof testD1>, qs: string, status = 200) => {
    const res = await app.request(`/api/flows?${qs}`, {}, { DB: db } as any);
    expect(res.status, qs).toBe(status);
    return (await res.json()) as FlowsResponse & { error?: string };
  };
  const ref = (db: ReturnType<typeof testD1>, where = '1 = 1', ...p: unknown[]) => db.raw.prepare(`SELECT id FROM flows f WHERE ${where} ${FLOWS_ORDER}`).all(...p).map((r: any) => r.id);

  it('walking by next gives every row once in the feed order; the count is on the head page only (null behind the cursor)', async () => {
    const db = many();
    const ids: string[] = [];
    let before: string | null = null;
    let pages = 0;
    for (; pages < 50; pages++) {
      const r = await get(db, `at=${T}&limit=25${before ? `&before=${before}` : ''}`);
      if (pages === 0) { expect(r.total).toBe(137); expect(r.firstTs).toBe(T - Math.floor(136 / 7) * M); } else { expect(r.total).toBeNull(); expect(r.page).toBe(1); expect(r.firstTs).toBeUndefined(); }
      expect(r.asOf).toBe(T);
      ids.push(...r.flows.map((f) => f.id));
      before = r.next ?? null;
      if (!before) break;
    }
    expect(ids).toEqual(ref(db));
    expect(new Set(ids).size).toBe(137);
    expect(pages).toBe(5);
    // an old ?page= link still pages by offset
    expect((await get(db, `at=${T}&limit=25&page=2`)).flows.map((f) => f.id)).toEqual(ref(db).slice(25, 50));
  });

  it('a date jump: moves strictly older than the time; since: at or after it; both together', async () => {
    const db = many();
    const t = T - 5 * M;
    expect((await get(db, `at=${T}&limit=100&before=${t}`)).flows.map((f) => f.id)).toEqual(ref(db, 'f.ts < ?', t));
    const since = await get(db, `at=${T}&limit=100&since=${T - 3 * M}`);
    expect(since.flows.map((f) => f.id)).toEqual(ref(db, 'f.ts >= ?', T - 3 * M));
    expect(since.total).toBe(since.flows.length);
    expect((await get(db, `at=${T}&limit=100&since=${T - 9 * M}&before=${t}`)).flows.map((f) => f.id)).toEqual(ref(db, 'f.ts >= ? AND f.ts < ?', T - 9 * M, t));
    // nothing that early: the oldest recorded move is sent for "The flow index starts on …"
    const early = await get(db, `at=${T}&before=${T - 30 * M}`);
    expect(early.flows).toEqual([]);
    expect(early.firstTs).toBe(T - 19 * M);
  });

  it('a whole address (either side, each move once) and an address start, paged the same way', async () => {
    const db = many();
    const a = NAM(1);
    const whole = await get(db, `at=${T}&limit=100&addr=${a}`);
    expect(whole.flows.map((f) => f.id)).toEqual(ref(db, 'f.from_addr = ? OR f.to_addr = ?', a, a));
    expect(whole.total).toBe(whole.flows.length);
    const p1 = await get(db, `at=${T}&limit=10&addr=${a}`);
    const p2 = await get(db, `at=${T}&limit=10&addr=${a}&before=${p1.next}`);
    expect([...p1.flows, ...p2.flows].map((f) => f.id)).toEqual(whole.flows.slice(0, 20).map((f) => f.id));
    const start = await get(db, `at=${T}&limit=100&addr=${a.slice(0, 8)}`);
    expect(start.flows.map((f) => f.id)).toEqual(ref(db, 'substr(f.from_addr, 1, 8) = ? OR substr(f.to_addr, 1, 8) = ?', a.slice(0, 8), a.slice(0, 8)));
  });

  it('a record by the start of any hash it is filed under, a block, and the newest match of any age for an empty window', async () => {
    const db = many();
    expect((await get(db, `at=${T}&hash=${HEX(7).slice(0, 8)}`)).flows.map((f) => f.id)).toEqual([`namada:${HEX(7)}:1`]);
    expect((await get(db, `at=${T}&hash=${HEX(7)}`)).flows.map((f) => f.id)).toEqual([`namada:${HEX(7)}:1`]); // a whole hash
    expect((await get(db, `at=${T}&hash=abcdef01`)).flows.map((f) => f.id)).toEqual([`namada:${HEX(40)}:1`]); // the explorer's (wrapper) hash, typed in lower case
    expect((await get(db, `at=${T}&hash=FEDCBA98`)).flows.map((f) => f.id)).toEqual([`namada:${HEX(41)}:2`]); // the inner hash
    const block = await get(db, `at=${T}&height=7999990`);
    expect(block.flows.map((f) => f.id)).toEqual(ref(db, 'f.height = 7999990'));
    expect(block.total).toBe(3);
    // nothing in the window: the newest matching move of any age, for "The last one was …"
    const empty = await get(db, `at=${T}&kind=sell&since=${T + 1}`);
    expect(empty.flows).toEqual([]);
    expect(empty.last).toMatchObject({ id: ref(db, "f.kind = 'sell'")[0] });
    expect((await get(db, `at=${T}&kind=pgf`)).last).toBeNull();
  });

  it('count=none leaves the count out (rows only); malformed narrowing filters are refused, a malformed cursor is the head page', async () => {
    const db = many();
    const rows = await get(db, `at=${T}&limit=10&count=none`);
    expect(rows.total).toBeNull();
    expect(rows.flows).toHaveLength(10);
    expect((await get(db, `addr=tnam1q`, 400)).error).toMatch(/addr must be/);
    expect((await get(db, `hash=XYZ12345`, 400)).error).toMatch(/hash must be/);
    expect((await get(db, `since=yesterday`, 400)).error).toMatch(/since must be/);
    expect((await get(db, `height=-4`, 400)).error).toMatch(/height must be/);
    const junk = await get(db, `at=${T}&limit=10&before=not-a-cursor`);
    expect(junk.total).toBe(137);
    expect(junk.flows.map((f) => f.id)).toEqual(ref(db).slice(0, 10));
  });

  it('the export applies the same filters', async () => {
    const db = many();
    const r = await app.request(`/api/export/flows?format=json&at=${T}&addr=${NAM(2)}`, {}, { DB: db } as any);
    const j = (await r.json()) as { total: number; flows: { id: string }[] };
    expect(j.flows.map((f) => f.id)).toEqual(ref(db, 'f.from_addr = ? OR f.to_addr = ?', NAM(2), NAM(2)));
    expect(j.total).toBe(j.flows.length);
  });
});
