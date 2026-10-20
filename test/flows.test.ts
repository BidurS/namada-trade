// W1: GET /api/flows?minNam=&arb=false — newest first, bots removed, at least N NAM, limit clamp kept.
import { describe, it, expect } from 'vitest';
import { flowsWhere, flowsFilterFromQuery, NOT_BOT, NAM_AMOUNT, NOT_LEGACY_TWIN } from '../worker/src/flows-query';
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
