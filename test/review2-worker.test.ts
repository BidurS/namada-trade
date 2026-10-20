// Review 2 (2026-10-17), worker fixes: each block names the finding it guards.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from '../worker/src/api';
import { testD1, insert, runStmts } from './d1-sqlite';
import {
  chainCoverage, combinedCoverage, metricSeries, timedOutSends, ibcRowOf, allocateFollowUps, unbondingWait, withdrawEpochs, measureEpochSec,
  maspLegs, blindSpot, pressure, cachedChainParams, type IndexState,
} from '../worker/src/analytics';
import { NOT_LEGACY_TWIN, NOT_BOT } from '../worker/src/flows-query';
import { normFromTxSearch, parseOsmosisTx, type OsmoCtx } from '../worker/src/parse/osmosis';
import { quoteBuyFor, safeClip, BUY_TOLERANCE } from '../worker/src/sources/sqs';
import { fetchOsmosisHolderList } from '../worker/src/sources/osmosis';
import { refreshLiquidBalances, osmosisListCheck, unpairedCrossings, takeTickLock, releaseTickLock } from '../worker/src/cron';
import { stmt } from '../worker/src/db';
import { osmosisDroppedStmt, HOLDER_COUNTS_SQL, OSMOSIS_TOP10_SQL, NAMADA_TOP10_SQL } from '../worker/src/holders';
import { cachedApi, inlineScriptHashes, pagePolicies, BROWSER_CACHE, cacheKeyUrl, rateLimited } from '../worker/src/http';
import { createSession, sessionFromRequest, revokeAllSessions, listSessions, tokenHash, MAX_SESSIONS, MAX_API_KEYS } from '../worker/src/auth';
import { csvText, csvCell } from '../worker/src/api';
import { isBotFlow, isIbcRefund, safeHttpUrl } from '../shared/flow-rules';
import { category_plain, label_plain } from '../shared/labels';
import { BODY } from '../shared/copy';
import type { ChainParams, Overview, SlippageCurvePoint } from '../shared/types';

const H = 3600000, D = 86400000, M = 60000;
const NOW = Date.now();
const MASP = 'tnam1pcqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzmefah';
const ESCROW = 'tnam1qcqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqvtr7x4';
const POS = 'tnam1qgqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqc8j2fp';
const fx = (n: string) => JSON.parse(readFileSync(join(__dirname, 'fixtures', n), 'utf8'));
const env = (db: ReturnType<typeof testD1>) => ({ DB: db } as any);
afterEach(() => vi.unstubAllGlobals());

const flowRow = (o: Record<string, unknown>) => ({ chain: 'namada', height: 1, ts: NOW - H, tx_hash: 'H', kind: 'transfer', from_addr: null, to_addr: null, amount_num: 1, meta: null, ...o });

// ------------------------------------------------------------------ data/staked-is-pos-balance
describe('staked is the chain\'s total stake, not the staking account balance', () => {
  it('sends total stake as bonded, the rest of the staking account as unstaking, and no fallback when total stake is missing', async () => {
    const db = testD1();
    const t = NOW - 2 * M;
    insert(db, 'metrics', [
      { ts: t, key: 'supply.total', value: 1147000000 }, { ts: t, key: 'supply.pos_bonded', value: 341964111 },
      { ts: t, key: 'supply.total_stake', value: 267180094.22 },
    ]);
    const o = (await (await app.request(`/api/overview?at=${NOW - M}`, {}, env(db))).json()) as Overview;
    expect(o.supply.bonded).toBe(267180094.22);
    expect(o.supply.posBalance).toBe(341964111);
    expect(o.supply.unstaking).toBeCloseTo(74784016.78, 2);
    const db2 = testD1();
    insert(db2, 'metrics', [{ ts: t, key: 'supply.total', value: 1147000000 }, { ts: t, key: 'supply.pos_bonded', value: 341964111 }]);
    const o2 = (await (await app.request(`/api/overview?at=${NOW - M}`, {}, env(db2))).json()) as Overview;
    expect(o2.supply.bonded).toBeNull(); // never the staking account's balance in its place
    expect(o2.supply.unstaking).toBeNull();
  });

  it('the staked trend is the total stake series', async () => {
    const db = testD1();
    insert(db, 'metrics', [
      { ts: NOW - 3 * H, key: 'supply.pos_bonded', value: 341000000 }, { ts: NOW - 3 * H, key: 'supply.total_stake', value: 267000000 },
    ]);
    const p = await pressure(db as any, NOW, false);
    expect(p.bondedTrend.map((x) => x.value)).toEqual([267000000]);
  });
});

// ------------------------------------------------------------------ data/unshield-recipient-wrong (twins)
describe('one row per Namada transfer event', () => {
  const legacy = flowRow({ id: 'namada:INNER1:7', tx_hash: 'INNER1', height: 8290136, kind: 'unshield', from_addr: MASP, to_addr: 'tnam1feepayer', amount_num: 40000.144159, meta: '{"descriptor":"transfer-from-wasm"}' });
  const current = flowRow({ id: 'namada:WRAP1:7', tx_hash: 'WRAP1', height: 8290136, kind: 'unshield', from_addr: MASP, to_addr: 'tnam1qq6wus66', amount_num: 40000, meta: '{"descriptor":"transfer-from-wasm","innerTxHash":"INNER1","maspFeeNam":0.144159}' });

  it('the unique index makes the current parser\'s row replace the older twin (INSERT OR REPLACE)', async () => {
    const db = testD1();
    insert(db, 'flows', [legacy]);
    const f = { id: 'namada:WRAP1:7', chain: 'namada' as const, height: 8290136, ts: NOW - H, txHash: 'WRAP1', kind: 'unshield' as const, from: MASP, to: 'tnam1qq6wus66', amount: 40000, meta: { innerTxHash: 'INNER1' } };
    await runStmts(db, [stmt.flow(f)]);
    const rows = db.raw.prepare("SELECT id, to_addr FROM flows WHERE chain='namada'").all().map((r: any) => ({ ...r }));
    expect(rows).toEqual([{ id: 'namada:WRAP1:7', to_addr: 'tnam1qq6wus66' }]);
  });

  it('before the migration runs, the older twin is left out of every flow query', async () => {
    const db = testD1();
    db.exec('DROP INDEX flows_namada_event');
    insert(db, 'flows', [legacy, current, flowRow({ id: 'namada:SOLO:1', tx_hash: 'SOLO', kind: 'unshield', from_addr: MASP, to_addr: 'tnam1other', amount_num: 5 })]);
    const ids = db.raw.prepare(`SELECT f.id FROM flows f WHERE ${NOT_LEGACY_TWIN} ORDER BY f.id`).all().map((r: any) => r.id);
    expect(ids).toEqual(['namada:SOLO:1', 'namada:WRAP1:7']);
    const b = await blindSpot(db as any, NOW, false);
    expect(b.unshields24h).toBeCloseTo(40005, 6); // 40,000 once, not twice
    expect(b.unshields.map((f) => f.to)).toEqual(['tnam1qq6wus66', 'tnam1other']);
  });

  it('migration 0004 deletes existing twins (same block, inner hash and event index) and keeps everything else', () => {
    const db = testD1();
    db.exec('DROP INDEX flows_namada_event');
    insert(db, 'flows', [legacy, current, flowRow({ id: 'namada:INNER1:8', tx_hash: 'INNER1', height: 8290136, kind: 'transfer', amount_num: 3 })]);
    const sql = readFileSync(join(__dirname, '..', 'migrations', '0004_flow_dedupe_user_tags.sql'), 'utf8');
    const del = sql.slice(sql.indexOf('DELETE FROM flows'), sql.indexOf(';', sql.indexOf('DELETE FROM flows')) + 1);
    db.exec(del);
    const ids = db.raw.prepare('SELECT id FROM flows ORDER BY id').all().map((r: any) => r.id);
    expect(ids).toEqual(['namada:INNER1:8', 'namada:WRAP1:7']);
  });
});

// ------------------------------------------------------------------ data/ibc-refunds-counted-as-outflow
describe('bridge sends that timed out are not counted as bridged out', () => {
  const ctx: OsmoCtx = { poolAddrs: new Map(), priceUsd: 0.001, assets: new Map() };

  it('the refund names the address that got the NAM back and the packet, not the relayer', () => {
    const p = parseOsmosisTx(normFromTxSearch(fx('osmo_ibc_timeout.json'), NOW), ctx);
    const r = p.flows.find((f) => f.kind === 'other')!;
    expect(r.to).toBe('osmo1mpgtkc7aym9f3k8ll7hahtu7rvpdjc95e6m5tg');
    expect(r.amount).toBeCloseTo(140233.513862, 6);
    expect(r.meta).toMatchObject({ ibcTimeoutRefund: true, packetSequence: '1991', refundReceiver: 'osmo1mpgtkc7aym9f3k8ll7hahtu7rvpdjc95e6m5tg' });
    expect(isIbcRefund(r)).toBe(true);
    expect(isBotFlow(r)).toBe(false); // a refund is not a bot trade
  });

  it('one transaction timing out two packets gives two refunds of their own amounts (not the sum twice)', () => {
    const p = parseOsmosisTx(normFromTxSearch(fx('osmo_ibc_timeout_two.json'), NOW), ctx);
    const r = p.flows.filter((f) => f.kind === 'other').map((f) => [f.to, f.amount, f.meta?.packetSequence]);
    expect(r).toEqual([['osmo10u0s7mc3skvjcadx4y3hs8yxcy5vr9ezewqzud', 36.789678, '7982'], ['osmo1d5hq49fenfj8rtlyz8ckya44jxagv0f7lmdtl4', 23439.601769, '7983']]);
  });

  it('a bridge send carries its packet sequence', () => {
    const p = parseOsmosisTx(normFromTxSearch(fx('osmo_ibc_send_masp.json'), NOW), ctx);
    const out = p.flows.find((f) => f.kind === 'ibc_out')!;
    expect(out.amount).toBe(20000);
    expect(out.to).toBe(MASP);
    expect(out.meta).toMatchObject({ packetSequence: '8003' });
  });

  it('matches refunds to sends by packet, or for older rows by amount and time', () => {
    const outs = [
      { id: 'o1', ts: 100, from: 'osmo1a', to: 'tnam1x', amount: 140233, seq: '1991' },
      { id: 'o2', ts: 200, from: 'osmo1a', to: 'tnam1x', amount: 140233, seq: null },
      { id: 'o3', ts: 300, from: 'osmo1b', to: 'tnam1x', amount: 500, seq: null },
    ];
    const refunds = [
      { id: 'r1', ts: 150, from: null, to: 'osmo1a', amount: 140233, seq: '1991', receiverKnown: true },
      { id: 'r2', ts: 250, from: null, to: 'osmo1relayer', amount: 140233, seq: null }, // stored before the fix: relayer as receiver
    ];
    expect([...timedOutSends(outs, refunds)].sort()).toEqual(['o1', 'o2']);
    expect(ibcRowOf({ id: 'x', ts: 1, from_addr: 'a', to_addr: 'b', amount_num: 2, meta: '{"packetSequence":"9","refundReceiver":"b"}' })).toMatchObject({ seq: '9', receiverKnown: true });
  });

  it('pressure and the overview leave refunded sends out; the server bot rule is the client\'s', async () => {
    const db = testD1();
    const o = (id: string, ts: number, kind: string, amount: number, meta: unknown, from = 'osmo1a', to = 'tnam1x') => ({ id, chain: 'osmosis', height: 1, ts, tx_hash: id, kind, from_addr: from, to_addr: to, amount_num: amount, meta: meta ? JSON.stringify(meta) : null });
    insert(db, 'flows', [
      o('send1', NOW - 5 * H, 'ibc_out', 140233, { packetSequence: '1991' }),
      o('refund1', NOW - 4 * H, 'other', 140233, { ibcTimeoutRefund: true, packetSequence: '1991', refundReceiver: 'osmo1a' }, 'osmo1yl6hdjhmkf37639730gffanpzndzdpmhxy9ep3', 'osmo1a'),
      o('send2', NOW - 3 * H, 'ibc_out', 1000, { packetSequence: '8000' }),
      o('arb', NOW - 2 * H, 'other', 50, { arb: true }),
    ]);
    const p = await pressure(db as any, NOW, false);
    expect(p.ibcOut7d).toBe(1000);
    expect(p.ibcRefunded7d).toBe(140233);
    const ids = db.raw.prepare(`SELECT id FROM flows f WHERE ${NOT_BOT} ORDER BY id`).all().map((r: any) => r.id);
    expect(ids).toEqual(['refund1', 'send1', 'send2']);
  });
});

// ------------------------------------------------------------------ data/buy-ladder-you-pay, ux/buy-side-pay-mislabelled
describe('a buy quote is for the NAM size asked', () => {
  it('adjusts the USDC until the NAM out is within 0.5% of the size, and reports the real quote it found', async () => {
    // A pool where X USDC buys 1000·X·(1 − X/400) NAM: 100 USDC buys 75,000, so 100,000 NAM needs more.
    const pool = (usdc: number) => 1000 * usdc * (1 - usdc / 400);
    const calls: number[] = [];
    const call = async (inBase: string) => { const u = Number(inBase) / 1e6; calls.push(u); return { inBase, out: pool(u), impactPct: 0, feePct: 0.2, route: ['Pool #1 (CL)'] }; };
    const r = await quoteBuyFor(50000, 0.001, NOW, call as any);
    const q = r.quote!;
    expect(Math.abs(q.outAmount - 50000) / 50000).toBeLessThanOrEqual(BUY_TOLERANCE);
    expect(q.inAmount).toBeGreaterThan(50); // 50,000 NAM costs more than 50,000 × spot
    expect(q.effectivePriceUsd).toBeCloseTo(q.inAmount / q.outAmount, 12);
    expect(calls.length).toBeLessThanOrEqual(4);
    expect(calls[0]).toBeCloseTo(50, 6); // first guess: size × spot
  });

  it('a router that never comes close still gives one real quote (the closest), never a made-up one', async () => {
    const call = async (inBase: string) => ({ inBase, out: 10, impactPct: 50, feePct: 0, route: [] });
    const q = (await quoteBuyFor(1000, 0.001, NOW, call as any)).quote!;
    expect(q.outAmount).toBe(10);
    expect(q.prov.note).toMatch(/closest the router came/);
  });
});

// ------------------------------------------------------------------ data/safe-size-extrapolated
describe('safe size is never scaled down from zero', () => {
  const pt = (amountNam: number, imp: number): SlippageCurvePoint => ({ amountNam, usdSize: amountNam / 1000, buyImpactPct: imp, sellImpactPct: imp / 2, buyEffectiveUsd: 0.001, sellEffectiveUsd: 0.001, sellOutUsdc: 1, buyInUsdc: 1 });
  it('below the smallest quoted size it says so, with that size and its move', () => {
    expect(safeClip([pt(1000, 3.14), pt(5000, 6)], 1)).toEqual({ nam: null, how: 'below_smallest', smallestNam: 1000, smallestImpactPct: 3.14 });
  });
  it('between two sizes it interpolates; beyond the largest it is "at least"', () => {
    expect(safeClip([pt(1000, 0.46), pt(5000, 1.2)], 1)).toMatchObject({ how: 'interpolated', nam: 3919 });
    expect(safeClip([pt(1000, 0.1), pt(5000, 0.2)], 1)).toMatchObject({ how: 'at_least', nam: 5000 });
  });
});

// ------------------------------------------------------------------ data/flow-index-age-is-last-move, ux/sources-note-same-chain
describe('how current a flow index is comes from its scanner, not from the newest move', () => {
  const st = (o: Partial<IndexState> = {}): IndexState => ({ lastMove: { osmosis: NOW - 61 * M, namada: NOW - 1.7 * H }, namadaCursor: { height: 8316539, at: NOW - 2000 }, namadaHead: { height: 8316540, at: NOW - 20000 }, osmosisLive: { connected: true, since: NOW - D, lastMsgAt: NOW - 61 * M, height: 72700000, at: NOW - 30000 }, osmosisSweep: { height: 72700010, at: NOW - 2 * M }, ...o });
  it('a quiet chain with a current scanner is live, and its note names only its own chain', () => {
    const n = chainCoverage(st(), 'namada', NOW, false);
    expect(n.status).toBe('live');
    expect(n.at).toBe(NOW - 2000);
    expect(n.note).toMatch(/Last Namada move 1\.7 h ago/);
    expect(n.note).not.toMatch(/Osmosis/);
    const o = chainCoverage(st(), 'osmosis', NOW, false);
    expect(o.status).toBe('live');
    expect(o.note).toMatch(/Last Osmosis move 1\.0 h ago/);
    expect(o.note).not.toMatch(/Namada/);
  });
  it('a scanner that stopped or fell behind is old', () => {
    expect(chainCoverage(st({ namadaCursor: { height: 8316539, at: NOW - 10 * M } }), 'namada', NOW, false).status).toBe('stale');
    expect(chainCoverage(st({ namadaHead: { height: 8316600, at: NOW } }), 'namada', NOW, false).status).toBe('stale');
    expect(chainCoverage(st({ osmosisLive: null, osmosisSweep: { height: 1, at: NOW - 20 * M } }), 'osmosis', NOW, false).status).toBe('stale');
    expect(chainCoverage(st({ osmosisLive: { connected: false, since: null, lastMsgAt: null, height: null, at: NOW } }), 'osmosis', NOW, false)).toMatchObject({ status: 'live', at: NOW - 2 * M });
  });
  it('both together are the older and worse of the two', () => {
    const c = combinedCoverage(chainCoverage(st(), 'osmosis', NOW, false), chainCoverage(st({ namadaCursor: { height: 1, at: NOW - H } }), 'namada', NOW, false));
    expect(c.status).toBe('stale');
    expect(c.at).toBe(NOW - H);
  });
});

// ------------------------------------------------------------------ data/bucket-averages-as-readings, ux/chart-6h-buckets-mislabelled
describe('a chart point is a reading, never an average', () => {
  it('each bucket gives its last reading with that reading\'s time, plus its low, high and count', async () => {
    const db = testD1();
    const b = Math.floor(NOW / (6 * H)) * 6 * H - 6 * H;
    insert(db, 'metrics', [{ ts: b + H, key: 'price.usd', value: 0.0011 }, { ts: b + 2 * H, key: 'price.usd', value: 0.0009 }, { ts: b + 3 * H, key: 'price.usd', value: 0.0010055 }]);
    const s = await metricSeries(db as any, 'price.usd', b, b + 6 * H, 6 * H);
    expect(s).toEqual([{ ts: b + 3 * H, value: 0.0010055, lo: 0.0009, hi: 0.0011, n: 3 }]);
  });
  it('30 days of a price comes back hourly (one point per swap hour)', async () => {
    const db = testD1();
    insert(db, 'metrics', Array.from({ length: 63 }, (_, i) => ({ ts: NOW - (i * 10 + 1) * H, key: 'price.swap_1h', value: 0.001 + i * 1e-6 })));
    const r = (await (await app.request('/api/metrics/history?key=price.swap_1h&hours=720', {}, env(db))).json()) as any;
    expect(r.bucketMs).toBe(H);
    expect(r.history).toHaveLength(63);
  });
});

// ------------------------------------------------------------------ data/unbonding-wait-wrong
describe('the unstaking wait counts every epoch and uses the measured epoch length', () => {
  const p: ChainParams = { unbondingLength: 53, pipelineLength: 2, cubicSlashingWindowLength: 1, minEpochSec: 21600, epochSec: 6.48 * 3600, apr: 0.1, fetchedAt: NOW };
  it('56 epochs of the measured length', () => {
    expect(withdrawEpochs(p)).toBe(56);
    const w = unbondingWait(p)!;
    expect(w.epochs).toBe(56);
    expect(w.days).toBeCloseTo((56 * 6.48) / 24, 6); // 15.12 days: the indexer's 21 Sep unbond became withdrawable after 15.11
    expect(unbondingWait({ ...p, epochSec: 100 })!.epochSec).toBe(21600); // never below the chain's minimum
  });
  it('measures the epoch from the minute readings, only across changes the readings saw closely', async () => {
    const db = testD1();
    const t0 = NOW - 3 * D;
    // epochs 2664..2670 start every 6.5 h; readings every minute, except a 10 h gap inside 2668..2669
    const rows: { ts: number; key: string; value: number }[] = [];
    for (let t = t0; t < t0 + 6 * 6.5 * H + 30 * M; t += M) {
      if (t > t0 + 4.2 * 6.5 * H && t < t0 + 4.2 * 6.5 * H + 10 * H) continue;
      rows.push({ ts: t, key: 'epoch', value: 2664 + Math.floor((t - t0) / (6.5 * H)) });
    }
    insert(db, 'metrics', rows);
    const m = await measureEpochSec(db as any, NOW, 21600, null);
    expect(m.sec).toBeCloseTo(6.5 * 3600, -2);
    expect(m.note).toMatch(/measured over the last 3 epochs/);
  });
  it('an unbond the indexer lists gets its withdraw time; others get the measured estimate', async () => {
    const db = testD1();
    insert(db, 'kv', [
      { key: 'chain.params', value: JSON.stringify(p), updated_at: 1 },
      { key: 'unbond.withdraw', value: JSON.stringify({ at: NOW, byAddress: { tnam1qa: [{ validator: 'tnam1qval', amountNam: 200000, withdrawEpoch: 2630, withdrawTime: NOW + 5 * D }] } }), updated_at: 1 },
    ]);
    insert(db, 'flows', [
      flowRow({ id: 'namada:U1:pos', tx_hash: 'U1', kind: 'unbond', from_addr: POS, to_addr: 'tnam1qa', amount_num: 200000, ts: NOW - 9 * D, meta: JSON.stringify({ validator: 'tnam1qval', source: 'namada-rpc' }) }),
      flowRow({ id: 'namada:U2:pos', tx_hash: 'U2', kind: 'unbond', from_addr: POS, to_addr: 'tnam1qb', amount_num: 300000, ts: NOW - 2 * D, meta: JSON.stringify({ validator: 'tnam1qval', source: 'namada-rpc' }) }),
    ]);
    const pr = await pressure(db as any, NOW, false);
    const u1 = pr.unlocks.find((u) => u.txHash === 'U1')!, u2 = pr.unlocks.find((u) => u.txHash === 'U2')!;
    expect(u1).toMatchObject({ liquidAt: NOW + 5 * D, liquidAtSource: 'indexer' });
    expect(u2.liquidAtSource).toBe('estimate');
    expect(u2.liquidAt).toBeCloseTo(NOW - 2 * D + 56 * 6.48 * H, -3);
  });

  it('counts every unstaking request still in its wait, of any size, beside the list of the large ones', async () => {
    const db = testD1();
    insert(db, 'kv', [{ key: 'chain.params', value: JSON.stringify(p), updated_at: 1 }]);
    const waitMs = 56 * (6.48 * 3600) * 1000;
    const rpc = JSON.stringify({ source: 'namada-rpc' });
    insert(db, 'flows', [
      flowRow({ id: 'namada:S1:pos', tx_hash: 'S1', kind: 'unbond', from_addr: POS, to_addr: 'tnam1qs1', amount_num: 37489.25, ts: NOW - 2 * D, meta: rpc }),
      flowRow({ id: 'namada:S2:pos', tx_hash: 'S2', kind: 'unbond', from_addr: POS, to_addr: 'tnam1qs2', amount_num: 6017, ts: NOW - 2 * H, meta: rpc }),
      flowRow({ id: 'namada:S3:pos', tx_hash: 'S3', kind: 'unbond', from_addr: POS, to_addr: 'tnam1qs3', amount_num: 50000, ts: NOW - waitMs - H, meta: rpc }), // its wait is over
      flowRow({ id: 'namada:S4:pos', tx_hash: 'S4', kind: 'unbond', from_addr: POS, to_addr: 'tnam1qs4', amount_num: 1000, ts: NOW + H, meta: rpc }), // after asOf
      flowRow({ id: 'namada:B1:pos', tx_hash: 'B1', kind: 'bond', from_addr: 'tnam1qs5', to_addr: POS, amount_num: 9000, ts: NOW - D, meta: rpc }),
    ]);
    const pr = await pressure(db as any, NOW, false);
    expect(pr.unlocks).toEqual([]); // every one under UNLOCKS_MIN_NAM: none in the list
    expect(pr.unbondingAll?.n).toBe(2);
    expect(pr.unbondingAll?.nam).toBeCloseTo(43506.25, 6);
    expect(pr.unbondingAll?.from).toBeCloseTo(NOW - waitMs, -1);
    // no chain parameters: the wait is not known, so there is no count (never a 0)
    expect((await pressure(testD1() as any, NOW, false)).unbondingAll).toBeNull();
  });

  it('request paths read the cached parameters and never call the indexer', async () => {
    const db = testD1();
    const fetchSpy = vi.fn(() => new Promise<Response>(() => {})); // an indexer that never answers
    vi.stubGlobal('fetch', fetchSpy);
    insert(db, 'kv', [{ key: 'chain.params', value: JSON.stringify({ ...p, fetchedAt: 1700000000000 }), updated_at: 1 }]);
    const c = await cachedChainParams(db as any);
    expect(c?.fetchedAt).toBe(1700000000000);
    const pr = await pressure(db as any, NOW, false);
    expect(pr.unbondingEpochs).toBe(56);
    expect(pr.unbondingProv?.status).toBe('stale');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------ data/unlock-outcome-repeated
describe('a later restake is shared out over the withdrawals, never counted twice', () => {
  it('four withdrawals and one 2,584,920 NAM restake: each gets at most its own amount, oldest first', () => {
    const w = [524754, 500000, 500000, 500000].map((amount, i) => ({ key: `w${i}`, ts: 1000 + i, amount }));
    const a = allocateFollowUps(w, [{ kind: 'rebonded', ts: 2000, amount: 2584920, windowMs: 48 * H }]);
    expect([...a.values()].map((x) => x.rebonded)).toEqual([524754, 500000, 500000, 500000]);
    const b = allocateFollowUps(w, [{ kind: 'rebonded', ts: 2000, amount: 700000, windowMs: 48 * H }]);
    expect([...b.values()].map((x) => x.rebonded ?? 0)).toEqual([524754, 175246, 0, 0]);
  });
});

// ------------------------------------------------------------------ data/shielded-moved-in-misses-ibc, ux/shielded-24h-excludes-bridge
describe('the shielded pool counts every leg into and out of it, once', () => {
  it('bridge deposits into the pool count as moved in; an Osmosis-only record is added; NAM only', async () => {
    const db = testD1();
    const n = (id: string, h: number, kind: string, from: string, to: string, amount: number, meta: unknown = null) => flowRow({ id, tx_hash: id, ts: NOW - h * H, kind, from_addr: from, to_addr: to, amount_num: amount, meta: meta ? JSON.stringify(meta) : null });
    insert(db, 'flows', [
      n('in1', 1.8, 'ibc_in', 'osmo1sqdwx', MASP, 20000), n('in2', 7.9, 'ibc_in', 'osmo1sqdwx', MASP, 20000), n('in3', 11, 'ibc_in', 'osmo1sqdwx', MASP, 20000),
      n('old', 30, 'shield', ESCROW, MASP, 14630), // an older build's record of a bridge deposit
      n('out', 2, 'unshield', MASP, 'tnam1user', 0.23),
      n('usdc', 3, 'shield', 'tnam1user', MASP, 5000, { tokenSymbol: 'USDC' }), // not NAM
      { ...n('o1', 1.8, 'ibc_out', 'osmo1sqdwx', MASP, 20000), chain: 'osmosis', id: 'osmo-o1' },    // the same crossing seen on Osmosis
      { ...n('o2', 33, 'ibc_out', 'osmo1other', MASP, 25000), chain: 'osmosis', id: 'osmo-o2' },     // only on Osmosis
    ]);
    const b = await blindSpot(db as any, NOW, false);
    expect(b.shields24h).toBe(60000);
    expect(b.bridgeIn24h).toBe(60000);
    expect(b.unshields24h).toBeCloseTo(0.23, 6);
    expect(b.shields7d).toBe(60000 + 14630 + 25000);
    expect(b.bridgeIn7d).toBe(60000 + 14630 + 25000);
    expect(b.lastBridgeAt).toBe(NOW - 1.8 * H);
  });
  it('pairs a Namada record with its Osmosis twin by amount and time, and by address when Namada knows it', () => {
    const legs = maspLegs(
      [{ kind: 'ibc_in', ts: 1000, from_addr: ESCROW, to_addr: MASP, amount_num: 5 }],
      [{ id: 'a', ts: 1200, from: 'osmo1x', to: MASP, amount: 5, seq: null }, { id: 'b', ts: 1300, from: 'osmo1y', to: MASP, amount: 5, seq: null }],
      [],
    );
    expect(legs.map((l) => [l.dir, l.amount])).toEqual([['in', 5], ['in', 5]]); // one Namada record, one extra from Osmosis
  });
});

// ------------------------------------------------------------------ data/osmosis-index-gaps
describe('bridge crossings are checked on both chains', () => {
  it('finds a crossing recorded on Namada only (older than 30 minutes)', () => {
    const nam = [{ id: 'n1', kind: 'ibc_in', ts: NOW - 8 * H, from_addr: 'osmo1sqdwx', to_addr: MASP, amount_num: 20000 }, { id: 'n2', kind: 'ibc_in', ts: NOW - 5 * M, from_addr: 'osmo1s', to_addr: MASP, amount_num: 1 }];
    const osm = [{ id: 'o9', kind: 'ibc_out', ts: NOW - 9 * H, from_addr: 'osmo1z', to_addr: 'tnam1z', amount_num: 7 }];
    const u = unpairedCrossings(nam, osm, NOW);
    expect(u.namadaOnly.map((r) => r.id)).toEqual(['n1']);
    expect(u.osmosisOnly.map((r) => r.id)).toEqual(['o9']);
  });
});

// ------------------------------------------------------------------ data/osmosis-holders-include-pools
describe('pool accounts are not holders', () => {
  it('leaves labelled pools out of the count and the top 10', async () => {
    const db = testD1();
    insert(db, 'holders', [
      { chain: 'osmosis', address: 'osmo1pool', balance: '629264000000', balance_num: 629264, verified_at: NOW, updated_at: NOW },
      { chain: 'osmosis', address: 'osmo1user', balance: '1000000', balance_num: 1, verified_at: NOW, updated_at: NOW },
    ]);
    insert(db, 'labels', [{ address: 'osmo1pool', chain: 'osmosis', label: 'Osmosis Pool #3008 (NAM / USDC)', category: 'pool', source: 'auto' }]);
    expect(db.raw.prepare(HOLDER_COUNTS_SQL).get().osmosis).toBe(1);
    expect(db.raw.prepare(OSMOSIS_TOP10_SQL).get().s).toBe(1);
  });
});

// ------------------------------------------------------------------ worker/refresh-health-false-green
describe('the balance-refresh health says what landed', () => {
  const seed = () => {
    const db = testD1();
    insert(db, 'holders', ['tnam1a', 'tnam1b'].map((a) => ({ chain: 'namada', address: a, balance: '1', balance_num: 1, updated_height: 1000, updated_at: NOW - D, verified_at: NOW - D })));
    return db;
  };
  it('every read failed: not ok', async () => {
    const health: any[] = [];
    await refreshLiquidBalances(env(seed()), health, async () => { throw new Error('timeout'); });
    expect(health[0]).toMatchObject({ ok: false });
  });
  it('every read lost to a newer post-balance: not ok, and named', async () => {
    const health: any[] = [];
    const r = await refreshLiquidBalances(env(seed()), health, async () => ({ balance: 5n, height: 900, provider: 'Stuck' }));
    expect(r).toMatchObject({ read: 2, landed: 0, rejected: 2 });
    expect(health[0].ok).toBe(false);
    expect(health[0].note).toMatch(/2 reads older than a transfer already recorded/);
  });
  it('a lagging node\'s answer is retried on the other node', async () => {
    const health: any[] = [];
    const seen: string[] = [];
    const read = async (_a: string, o?: any) => { const p = o?.rpcs?.[0]?.provider ?? 'A'; seen.push(p); return { balance: 7n, height: p === 'A' ? 1500 : 2000, provider: p }; };
    const r = await refreshLiquidBalances(env(seed()), health, read, { rpcs: [{ provider: 'A', url: 'a' }, { provider: 'B', url: 'b' }], headHeight: 2001 });
    expect(r.landed).toBe(2);
    expect(seen).toContain('B');
  });
  it('the due list failing is reported, not hidden', async () => {
    const db = seed();
    db.exec('DROP TABLE stakes');
    const health: any[] = [];
    await refreshLiquidBalances(env(db), health, async () => ({ balance: 1n, height: 1, provider: 'x' }));
    expect(health[0]).toMatchObject({ ok: false });
    expect(health[0].note).toMatch(/could not be loaded/);
  });
});

// ------------------------------------------------------------------ worker/public-cron-tick-and-osmosis-zero-race
describe('no public cron trigger, and an older run cannot zero holders', () => {
  it('GET /api/cron/tick is gone', async () => {
    expect((await app.request('/api/cron/tick', {}, env(testD1()))).status).toBe(404);
  });
  it('an older read never re-stamps a row a newer run wrote', async () => {
    const db = testD1();
    const tA = NOW - 100, tB = NOW;
    await runStmts(db, [stmt.verifiedBalance('osmosis', 'osmo1h', '5', null, tB, 'keplr_rest')]); // run B (newer) first
    await runStmts(db, [stmt.verifiedBalance('osmosis', 'osmo1h', '5', null, tA, 'keplr_rest')]); // run A (older) finishes later
    await runStmts(db, [osmosisDroppedStmt(tB)]);                                                // B's "missing from the list" step
    expect(db.raw.prepare("SELECT balance, verified_at FROM holders WHERE address='osmo1h'").get()).toMatchObject({ balance: '5', verified_at: tB });
  });
  it('a second tick while one is running is skipped', async () => {
    const db = testD1();
    expect(await takeTickLock(db as any, 'a', NOW)).toBe(true);
    expect(await takeTickLock(db as any, 'b', NOW + 1000)).toBe(false);
    await releaseTickLock(db as any, 'a');
    expect(await takeTickLock(db as any, 'b', NOW + 2000)).toBe(true);
  });
});

// ------------------------------------------------------------------ worker/osmosis-complete-detection
describe('an Osmosis holder list is trusted only when complete and adding up to the supply', () => {
  it('a 200 page without pagination is not the last page', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ denom_owners: [{ address: 'osmo1a', balance: { amount: '5' } }] }), { status: 200 })));
    const r = await fetchOsmosisHolderList('k');
    expect(r.complete).toBe(false);
  });
  it('the sum must match the supply', () => {
    const h = [{ balance: '19926988411823' }];
    expect(osmosisListCheck(h, true, 19926988411823n).trust).toBe(true);
    expect(osmosisListCheck(h, true, 30000000000000n).trust).toBe(false);
    expect(osmosisListCheck(h, false, 19926988411823n, true).note).toMatch(/page cap/);
  });
});

// ------------------------------------------------------------------ worker/edge-cache-hit-max-age, seo/api-json-crawlable-from-footer
describe('API responses: browser lifetime and noindex', () => {
  it('an edge hit reaches the browser with max-age=5, never the stored 4 h', async () => {
    const stored = new Response('{}', { headers: { 'cache-control': 'public, max-age=14400, s-maxage=15' } });
    vi.stubGlobal('caches', { default: { match: async () => stored, put: async () => {} } });
    const res = await cachedApi(new Request('https://namada.trade/api/pools'), {} as any, { waitUntil: () => {} } as any, () => new Response('x'));
    expect(res.headers.get('cache-control')).toBe(BROWSER_CACHE);
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
  });
  it('uncached and error answers are noindex too', async () => {
    vi.stubGlobal('caches', { default: { match: async () => undefined, put: async () => {} } });
    const res = await cachedApi(new Request('https://namada.trade/api/me/settings'), {} as any, { waitUntil: () => {} } as any, () => new Response('no', { status: 401 }));
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
  });
});

// ------------------------------------------------------------------ security/unauthenticated-heavy-endpoints
describe('heavy requests', () => {
  it('a random parameter does not get past the edge cache; the ones a route reads still count', () => {
    expect(cacheKeyUrl(new URL('https://namada.trade/api/overview?r=123'))).toBe('https://namada.trade/api/overview');
    expect(cacheKeyUrl(new URL('https://namada.trade/api/flows?r=1&minNam=1000&arb=false&page=2'))).toBe('https://namada.trade/api/flows?arb=false&minNam=1000&page=2');
    expect(cacheKeyUrl(new URL('https://namada.trade/api/holders?chain=osmosis&x=1'))).toBe('https://namada.trade/api/holders?chain=osmosis');
  });
  it('exports, search and address reports are limited per client address; other reads are not', async () => {
    const limiter = { limit: vi.fn(async () => ({ success: false })) };
    const r = await rateLimited(new Request('https://namada.trade/api/export/flows', { headers: { 'cf-connecting-ip': '1.2.3.4' } }), { HEAVY_LIMITER: limiter } as any);
    expect(r?.status).toBe(429);
    expect(await rateLimited(new Request('https://namada.trade/api/flows?search=tnam1'), { HEAVY_LIMITER: limiter } as any)).not.toBeNull();
    expect(await rateLimited(new Request('https://namada.trade/api/overview'), { HEAVY_LIMITER: limiter } as any)).toBeNull();
    expect(await rateLimited(new Request('https://namada.trade/api/search?q=x'), {} as any)).toBeNull(); // no binding: not limited
  });
});

// ------------------------------------------------------------------ security/no-csp-frame-ancestors
describe('page security policy', () => {
  it('hashes the inline theme script (not JSON-LD or external scripts) and forbids framing', async () => {
    const html = '<script>var a=1;</script><script type="application/ld+json">{}</script><script type="module" src="/x.js"></script>';
    const h = await inlineScriptHashes(html);
    expect(h).toHaveLength(1);
    expect(h[0]).toMatch(/^'sha256-[A-Za-z0-9+/=]+'$/);
    const p = pagePolicies(h, new URL('https://namada.trade/trade'));
    expect(p.enforce).toContain("frame-ancestors 'none'");
    expect(p.scripts).toContain(`script-src 'self' ${h[0]}`);
    expect(p.scripts).toContain('connect-src \'self\' wss://namada.trade');
  });
});

// ------------------------------------------------------------------ worker/exports-silently-truncated, csv injection, chain header
describe('exports', () => {
  const seed = () => {
    const db = testD1();
    insert(db, 'holders', Array.from({ length: 2300 }, (_, i) => ({ chain: 'namada', address: `tnam1h${String(i).padStart(5, '0')}`, balance: String(i + 1), balance_num: i + 1, updated_at: NOW, verified_at: NOW })));
    insert(db, 'labels', [{ address: 'tnam1h02299', chain: 'namada', label: '=HYPERLINK("https://x.invalid","Claim")', category: 'watch', source: 'user', author: 'tnam1author' }]);
    return db;
  };
  it('every holder by default, with the total in a header', async () => {
    const res = await app.request('/api/export/holders?chain=namada&format=json', {}, env(seed()));
    const j = (await res.json()) as any;
    expect(j.count).toBe(2300);
    expect(j.truncated).toBe(false);
    expect(res.headers.get('x-total-count')).toBe('2300');
  });
  it('a cut file says so in its headers and name', async () => {
    const res = await app.request('/api/export/holders?chain=namada&limit=100', {}, env(seed()));
    expect(res.headers.get('x-truncated')).toBe('true');
    expect(res.headers.get('content-disposition')).toMatch(/first-100-of-2300/);
  });
  it('a label written as a formula is text in the CSV', async () => {
    const csv = await (await app.request('/api/export/holders?chain=namada&search=tnam1h02299', {}, env(seed()))).text();
    expect(csv).toContain(`"'=HYPERLINK(""https://x.invalid"",""Claim"")"`);
    expect(csvText('-5')).toBe("'-5");
    expect(csvCell(-5)).toBe('-5'); // numbers stay numbers
  });
  it('an unknown chain is refused, so the file name only ever holds a known word', async () => {
    expect((await app.request('/api/export/holders?chain=x%22%3B%20filename*%3DUTF-8%27%27report.html', {}, env(seed()))).status).toBe(400);
    expect((await app.request('/api/holders?chain=bogus', {}, env(seed()))).status).toBe(400);
    expect((await app.request('/api/export/holders?format=html', {}, env(seed()))).status).toBe(400);
  });
});

// ------------------------------------------------------------------ security/label-overwrite
describe('user tags never replace curated labels', () => {
  const signedIn = async (db: ReturnType<typeof testD1>, address = 'tnam1qreviewerxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx') => (await createSession(db as any, address, 'namada', 'namada')).token;
  const post = (db: any, token: string, body: unknown) => app.request('/api/labels', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }, env(db));
  const GEN = 'tnam1q8nm4ar7aua8035du0m8x6amfe4407uzvqtfs6lm';
  it('a genesis name stays; the answer is 409', async () => {
    const db = testD1();
    insert(db, 'labels', [{ address: GEN, chain: 'namada', label: 'Anoma Foundation', category: 'foundation', source: 'genesis' }]);
    const res = await post(db, await signedIn(db), { address: GEN, label: 'review test tag', category: 'watch' });
    expect(res.status).toBe(409);
    expect(db.raw.prepare('SELECT label, source FROM labels WHERE address = ?').get(GEN)).toMatchObject({ label: 'Anoma Foundation', source: 'genesis' });
  });
  it('a tag lands on an unlabelled address, only its author changes it, curated categories and formulas are refused', async () => {
    const db = testD1();
    const A = 'tnam1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq', t1 = await signedIn(db), t2 = await signedIn(db, 'tnam1qotherxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
    expect((await post(db, t1, { address: A, label: 'my whale', category: 'whale' })).status).toBe(200);
    expect((await post(db, t1, { address: A, label: 'my whale 2', category: 'whale' })).status).toBe(200);
    expect((await post(db, t2, { address: A, label: 'not yours', category: 'watch' })).status).toBe(409);
    expect((await post(db, t1, { address: A, label: 'x', category: 'cex' })).status).toBe(400);
    expect((await post(db, t1, { address: A, label: '=1+1', category: 'watch' })).status).toBe(400);
    expect(db.raw.prepare('SELECT label, source FROM labels WHERE address = ?').get(A)).toMatchObject({ label: 'my whale 2', source: 'user' });
  });
  it('a user tag is shown as typed (never in the genesis wording) and says where it came from', () => {
    expect(label_plain('Genesis: af_backers', 'tnam1x', 'user')).toBe('Genesis: af_backers');
    expect(label_plain('Genesis: af_backers', 'tnam1x', 'genesis')).toBe('Early backers (genesis)');
  });
});

// ------------------------------------------------------------------ security/plaintext-tokens, delete-leaves-sessions, apikey-pair-escalation
describe('sessions', () => {
  const A = 'tnam1qsessionxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const req = (token: string, path = '/api/auth/me', init: RequestInit = {}) => new Request(`https://namada.trade${path}`, { ...init, headers: { Authorization: `Bearer ${token}` } });
  it('the database holds only a hash of each token', async () => {
    const db = testD1();
    const s = await createSession(db as any, A, 'namada', 'namada');
    const rows = db.raw.prepare("SELECT key, value FROM kv WHERE key LIKE 'session:%'").all();
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe(`session:${tokenHash(s.token)}`);
    expect(rows[0].value).not.toContain(s.token);
    expect((await sessionFromRequest(db as any, req(s.token)))?.address).toBe(A);
    // the key column is not a working token
    expect(await sessionFromRequest(db as any, req(rows[0].key.slice(8)))).toBeNull();
  });
  it('a session stored before hashing is refused and deleted (a copy of the database from before could hold its token)', async () => {
    const db = testD1();
    const token = 'a'.repeat(64);
    insert(db, 'kv', [{ key: `session:${token}`, value: JSON.stringify({ token, address: A, chain: 'namada', linked: null, via: 'keplr', createdAt: NOW, expiresAt: NOW + D }), updated_at: NOW }]);
    expect(await listSessions(db as any, A, token)).toHaveLength(0);
    expect(await sessionFromRequest(db as any, req(token))).toBeNull();
    expect(db.raw.prepare('SELECT COUNT(*) n FROM kv WHERE key = ?').get(`session:${token}`).n).toBe(0);
  });
  it('"delete everything" ends every session and key of the address, however many', async () => {
    const db = testD1();
    const tokens: string[] = [];
    for (let i = 0; i < 53; i++) tokens.push(((await createSession(db as any, A, 'namada', 'pair')) as any).token);
    for (let i = 0; i < MAX_API_KEYS; i++) tokens.push(((await createSession(db as any, A, 'namada', 'api')) as any).token);
    // the cap ends the oldest devices (never leaving one valid and unlisted) and does not count keys
    const listed = await listSessions(db as any, A, tokens[52]);
    expect(listed.filter((x) => x.via !== 'api')).toHaveLength(MAX_SESSIONS);
    expect(listed.filter((x) => x.via === 'api')).toHaveLength(MAX_API_KEYS);
    let ended = 0;
    for (const t of tokens.slice(0, 53)) if (!(await sessionFromRequest(db as any, req(t)))) ended++;
    expect(ended).toBe(53 - MAX_SESSIONS);
    await revokeAllSessions(db as any, A);
    for (const t of tokens) expect(await sessionFromRequest(db as any, req(t))).toBeNull();
  });
  it('an API key cannot pair a device', async () => {
    const db = testD1();
    const k = await createSession(db as any, A, 'namada', 'api');
    const res = await app.request('/api/auth/pair', { method: 'POST', headers: { Authorization: `Bearer ${k.token}` } }, env(db));
    expect(res.status).toBe(403);
  });
});

// ------------------------------------------------------------------ security/proposal-url-xss
describe('links from on-chain text', () => {
  it('only http(s) passes', () => {
    for (const bad of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', ' javascript:alert(1)', 'data:text/html,x', 'vbscript:x', 'forum.namada.net/t/1', '', null, 42]) expect(safeHttpUrl(bad), String(bad)).toBeNull();
    expect(safeHttpUrl('https://forum.namada.net/t/x/1')).toBe('https://forum.namada.net/t/x/1');
  });
  it('pressure never sends a script link, even from an old cached proposal', async () => {
    const db = testD1();
    insert(db, 'kv', [{ key: 'intel.cache', value: JSON.stringify({ proposals: [{ id: 1, title: 't', status: 'pending', discussionsUrl: 'javascript:void(0)' }], topics: [], latestPosts: [], validators: [], fetchedAt: NOW }), updated_at: NOW }]);
    const p = await pressure(db as any, NOW, false);
    expect(p.proposals[0].discussionsUrl).toBeNull();
  });
});

// ------------------------------------------------------------------ security/owner-donation-identity
describe('donation addresses', () => {
  it('none are published unless the operator saved them', async () => {
    const r = (await (await app.request('/api/donation', {}, env(testD1()))).json()) as any;
    expect(r).toEqual({ transparentAddress: null, osmosisAddress: null, shieldedAddress: null });
  });
});

// ------------------------------------------------------------------ ux/learn-most-nam-staked, ux/heliax-foundation-tag
describe('copy and tags', () => {
  it('the learn page does not say most NAM is staked', () => {
    const all = JSON.stringify(BODY);
    expect(all).not.toMatch(/Most NAM is staked/);
    expect(all).not.toMatch(/fixed number of epochs/);
  });
  it('Heliax gets no "Foundation" tag; the Anoma Foundation keeps it', () => {
    expect(category_plain('foundation', 'Heliax')).toBeNull();
    expect(category_plain('foundation', 'Anoma Foundation')).toBe('Foundation');
  });
});

// ------------------------------------------------------------------ seo/ssr-holder-facts-stamped-now
describe('holder facts carry their data\'s time', () => {
  it('the top 10 is as old as its oldest reading; counts carry the newest write per chain', () => {
    const db = testD1();
    insert(db, 'holders', [
      { chain: 'namada', address: 'tnam1a', balance: '1', balance_num: 100, updated_at: NOW - 67 * H, verified_at: NOW - 67 * H },
      { chain: 'namada', address: 'tnam1b', balance: '1', balance_num: 50, updated_at: NOW - H, verified_at: null },
      { chain: 'osmosis', address: 'osmo1a', balance: '1', balance_num: 5, updated_at: NOW - 5 * M, verified_at: NOW - 5 * M },
    ]);
    insert(db, 'stakes', [{ address: 'tnam1a', bonded_num: 10, verified_at: NOW - 2 * H, updated_at: NOW - M }]);
    expect(db.raw.prepare(NAMADA_TOP10_SQL).get().at).toBe(NOW - 67 * H);
    expect(db.raw.prepare(HOLDER_COUNTS_SQL).get()).toMatchObject({ namada_at: NOW - H, osmosis_at: NOW - 5 * M });
  });
});
