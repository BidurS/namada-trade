// Merged stage 1 review (2026-10-29): Osmosis figures counted over the whole stored record that still carried no gap
// sentence (shared/osmosis-gap.ts), though the plan asks it of every Osmosis window reaching back before 20 Oct 2026
// 22:00 UTC: an Osmosis address's count of moves (pool 3368 misses 117 transactions before 10 Oct, 3008 25), the moves
// list's head-page count, the executed price served by /api/metrics/history, and the shielded pool's 30-day Osmosis
// coverage. Each now says so, its figures as stored; a window wholly after the cut-off says nothing. The real routes
// over the sqlite D1 stand-in; no test reaches the network.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { app } from '../worker/src/api';
import { testD1, type TestD1 } from './d1-sqlite';
import { OSMOSIS_GAP_NOTE, OSMOSIS_GAP_UNTIL, osmosisGapCounts } from '../shared/osmosis-gap';
import type { AddressReport, FlowsResponse } from '../shared/types';

// the address report's live reads of the chain fail at once: nothing reaches a node
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no network in this test'); })); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const H = 3_600_000, D = 86_400_000;
const CUT = OSMOSIS_GAP_UNTIL;
const TRADER = 'osmo1nn62s9hm7ns4lwqsl70y49xx5tpe0ft45evpvh';
const NAMADA = 'tnam1qpjppur46s3ja5uwzsyamxwzvtwnkeeycyl472u3';
const get = async <T,>(db: TestD1, path: string) => (await (await app.request(path, {}, { DB: db } as any)).json()) as T;
let n = 0;
function flow(db: TestD1, chain: 'osmosis' | 'namada', ts: number, from: string | null, to: string | null) {
  n++;
  db.raw.prepare(`INSERT INTO flows (id, chain, height, ts, tx_hash, kind, from_addr, to_addr, amount_num, price_usd, value_usd, meta) VALUES (?, ?, ?, ?, ?, 'transfer', ?, ?, 1000, 0.001, 1, '{}')`)
    .run(`${chain}:G${n}:0`, chain, 70_000_000 + n, ts, `G${n}`, from, to);
}

describe('counts over the whole stored record', () => {
  it('an Osmosis address whose moves reach back before the cut-off says so beside its count; one wholly after it, or a Namada address, does not', async () => {
    vi.useFakeTimers({ now: CUT + 9 * D, toFake: ['Date'] });
    const db = testD1();
    flow(db, 'osmosis', CUT - 20 * D, TRADER, null);
    flow(db, 'osmosis', CUT + 2 * D, null, TRADER);
    flow(db, 'osmosis', CUT + 3 * D, null, 'osmo16u4xsll7kwgs9w8z6zy86z3galv7le4ywv5qmm');
    flow(db, 'namada', CUT - 20 * D, NAMADA, null);
    const old = await get<AddressReport>(db, `/api/address/${TRADER}`);
    expect(old.totalFlowsCount).toBe(2);
    expect(old.flowsNote).toBe(osmosisGapCounts('This address\'s moves'));
    expect((await get<AddressReport>(db, '/api/address/osmo16u4xsll7kwgs9w8z6zy86z3galv7le4ywv5qmm')).flowsNote).toBeUndefined();
    expect((await get<AddressReport>(db, `/api/address/${NAMADA}`)).flowsNote).toBeUndefined();
  });

  it('an Osmosis address with more moves than the report reads: its older moves are asked of the address indexes', async () => {
    vi.useFakeTimers({ now: CUT + 9 * D, toFake: ['Date'] });
    const db = testD1();
    db.raw.exec('BEGIN');
    flow(db, 'osmosis', CUT - 5 * D, null, TRADER);
    for (let i = 0; i < 320; i++) flow(db, 'osmosis', CUT + H + i * 60_000, TRADER, null);
    db.raw.exec('COMMIT');
    const r = await get<AddressReport>(db, `/api/address/${TRADER}`);
    expect(r.totalFlowsCount).toBe(321);
    expect(r.flows.every((f) => f.ts >= CUT)).toBe(true);
    expect(r.flowsNote).toBe(osmosisGapCounts('This address\'s moves'));
  });

  it('the moves list\'s head-page count says so when its chain filter takes Osmosis moves and its window reaches back', async () => {
    vi.useFakeTimers({ now: CUT + 9 * D, toFake: ['Date'] });
    const db = testD1();
    flow(db, 'osmosis', CUT - 20 * D, TRADER, null);
    flow(db, 'osmosis', CUT + 2 * D, TRADER, null);
    flow(db, 'namada', CUT + D, NAMADA, null);
    const all = await get<FlowsResponse>(db, '/api/flows');
    expect(all.total).toBe(3);
    expect(all.totalNote).toBe(osmosisGapCounts('These moves'));
    expect((await get<FlowsResponse>(db, '/api/flows?chain=osmosis')).totalNote).toBe(osmosisGapCounts('These moves'));
    expect((await get<FlowsResponse>(db, '/api/flows?chain=namada')).totalNote).toBeUndefined();
    expect((await get<FlowsResponse>(db, `/api/flows?since=${CUT + D}`)).totalNote).toBeUndefined();
    // no count, no sentence about it
    expect((await get<FlowsResponse>(db, '/api/flows?count=none')).totalNote).toBeUndefined();
  });

  it('the executed price from /api/metrics/history over a window reaching back says so; the quoted price and a later window do not', async () => {
    vi.useFakeTimers({ now: CUT + 9 * D, toFake: ['Date'] });
    const db = testD1();
    db.raw.prepare("INSERT INTO metrics (key, ts, value) VALUES ('price.swap_1h', ?, 0.001)").run(CUT + D);
    expect((await get<{ note?: string }>(db, '/api/metrics/history?key=price.swap_1h&hours=720')).note).toBe(OSMOSIS_GAP_NOTE);
    expect((await get<{ note?: string }>(db, '/api/metrics/history?key=price.swap_1h&hours=24')).note).toBeUndefined();
    expect((await get<{ note?: string }>(db, '/api/metrics/history?key=price.usd&hours=720')).note).toBeUndefined();
  });

  it('the shielded pool\'s 30-day figures (/api/blindspot) carry it in their Osmosis coverage while the window reaches back', async () => {
    vi.useFakeTimers({ now: CUT + 9 * D, toFake: ['Date'] });
    const db = testD1();
    const r = await get<{ coverage: { note?: string }; coverageByChain: { osmosis: { note?: string }; namada: { note?: string } } }>(db, '/api/blindspot');
    expect(r.coverageByChain.osmosis.note).toContain(OSMOSIS_GAP_NOTE);
    expect(r.coverage.note).toContain(OSMOSIS_GAP_NOTE);
    expect(r.coverageByChain.namada.note ?? '').not.toContain(OSMOSIS_GAP_NOTE);
    vi.setSystemTime(CUT + 31 * D);
    const later = await get<{ coverageByChain: { osmosis: { note?: string } } }>(db, '/api/blindspot');
    expect(later.coverageByChain.osmosis.note ?? '').not.toContain(OSMOSIS_GAP_NOTE);
  });
});
