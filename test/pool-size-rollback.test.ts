// Merged stage 1 review (2026-10-29), deploy safety: the series said how a pool size was measured with one switch time,
// the first minute stored with dex.pools_priced, and called every reading after it the pools' coins at their own prices.
// A rolled-back Worker (afe8a1b) stores dex.liquidity_usd every minute from the router's liquidity_cap, which counts NAM
// at nothing, and pool_hourly from it, with no dex.pools_priced: after a deploy, a rollback and a deploy again, its
// minutes were served as reserves-based (900 against 2,000 in the review's run) with no note. The first minute this
// code stores after such a stretch now records it (kv dex.router_runs), and the readers name it; the pairs list's
// fallback to the stored hour refuses an hour of the stretch, and an amount an older writer stored in its own units.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { testD1, insert, type TestD1 } from './d1-sqlite';
import { readPairs, readSeries } from '../worker/src/series-api';
import { PRICED_KEY, ROUTER_RUNS_KEY, routerRunStmt, routerRunsNote, storePools } from '../worker/src/pool-sizes';
import { runBatch } from '../worker/src/db';
import type { PoolInfo } from '../shared/types';

afterEach(() => { vi.useRealTimers(); });

const MIN = 60_000, H = 3_600_000;
const NOW = Date.UTC(2026, 10, 2, 12);
const deployAt = NOW - 6 * H, rollbackAt = NOW - 4 * H, forwardAt = NOW - 2 * H;
const kv = (db: TestD1, key: string) => (db.raw.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
const pool: PoolInfo = { id: '3005', type: 'concentrated', address: '', pair: 'NAM / USDC', counterDenom: 'ibc/498A', counterSymbol: 'USDC', namReserve: 1_000_000, counterReserve: 200, liquidityUsd: 2_000, counterUsd: 200, spreadFactor: 0.002 } as PoolInfo;

/** The minutes from `from` to `to`: this code's (the total and dex.pools_priced) or an earlier version's (the router's figure alone). */
function minutes(db: TestD1, from: number, to: number, ours: boolean) {
  db.raw.exec('BEGIN');
  const ins = db.raw.prepare('INSERT INTO metrics (ts, key, value) VALUES (?, ?, ?)');
  for (let t = from; t < to; t += MIN) {
    ins.run(t, 'dex.liquidity_usd', ours ? 2_000 : 900);
    if (ours) ins.run(t, PRICED_KEY, 3);
  }
  db.raw.exec('COMMIT');
}

describe('a stretch an earlier version stored after the switch', () => {
  it('is recorded by the first minute this code stores after it, once', async () => {
    const db = testD1();
    minutes(db, deployAt, rollbackAt, true);
    minutes(db, rollbackAt, forwardAt, false);
    expect(await routerRunStmt(db as any, forwardAt)).not.toBeNull();
    await storePools(db as any, { now: forwardAt, pools: [pool], poolsAt: forwardAt, depth: null, price: null });
    expect(JSON.parse(kv(db, ROUTER_RUNS_KEY)!)).toEqual([{ after: rollbackAt - MIN, to: forwardAt - MIN }]);
    // this code's next minutes add nothing
    minutes(db, forwardAt + MIN, NOW, true);
    expect(await routerRunStmt(db as any, NOW)).toBeNull();
    // a second rollback later is a second run
    minutes(db, NOW, NOW + 30 * MIN, false);
    await runBatch(db as any, [(await routerRunStmt(db as any, NOW + 30 * MIN))!]);
    expect(JSON.parse(kv(db, ROUTER_RUNS_KEY)!)).toEqual([{ after: rollbackAt - MIN, to: forwardAt - MIN }, { after: NOW - MIN, to: NOW + 29 * MIN }]);
  });

  it('is named in the stamp of a window that holds it, and only then', async () => {
    const db = testD1();
    minutes(db, NOW - 8 * H, deployAt, false);
    minutes(db, deployAt, rollbackAt, true);
    minutes(db, rollbackAt, forwardAt, false);
    await storePools(db as any, { now: forwardAt, pools: [pool], poolsAt: forwardAt, depth: null, price: null });
    minutes(db, forwardAt + MIN, NOW, true);
    const words = routerRunsNote([{ after: rollbackAt - MIN, to: forwardAt - MIN }], 0, Infinity);
    expect(words).toBe('The readings stored after 2 Nov 2026 07:59 UTC and up to 2 Nov 2026 09:59 UTC are the Osmosis router\'s own figure, stored by an earlier version of the site, which counted NAM at nothing while it gave NAM no price.');
    const over = await readSeries(db as any, { key: 'dex.liquidity_usd', from: String(deployAt + H), to: String(NOW), step: '1m' }, NOW, false);
    expect(over.points.some((p) => p.v === 900)).toBe(true);
    expect(over.prov.note).toContain(words);
    const after = await readSeries(db as any, { key: 'dex.liquidity_usd', from: String(forwardAt + H), to: String(NOW), step: '1m' }, NOW, false);
    expect(after.prov.note ?? '').not.toContain('earlier version');
    // a pool's stored hours: an hour the earlier version stored is named too
    insert(db, 'pool_hourly', [
      { hour: rollbackAt, pool_id: '3005', at: rollbackAt + 5 * MIN, liquidity_usd: 900, nam_reserve: 1_000_000, counter_reserve: 200, spread: 0.002 },
      { hour: forwardAt + H, pool_id: '3005', at: forwardAt + H + 5 * MIN, liquidity_usd: 2_000, nam_reserve: 1_000_000, counter_reserve: 200, spread: 0.002 },
    ]);
    const hours = await readSeries(db as any, { key: 'pool_hourly.3005.liquidity_usd', from: String(deployAt), to: String(NOW) }, NOW, false);
    expect(hours.prov.note).toContain(words);
  });

  it('the pairs list\'s stored hour: an hour of the stretch gives no size and no amount of the other coin; an hour of this code gives both', async () => {
    const db = testD1();
    minutes(db, deployAt, rollbackAt, true);
    minutes(db, rollbackAt, forwardAt, false);
    await storePools(db as any, { now: forwardAt, pools: [pool], poolsAt: forwardAt, depth: null, price: null });
    // the earlier version's hour: its size is the router's, its 0.00215 allBTC was 2,150 base units over a million
    // (the stored hour read is the reference pool's newest, 3005's)
    insert(db, 'pool_hourly', [
      { hour: rollbackAt + H, pool_id: '3005', at: rollbackAt + H + 5 * MIN, liquidity_usd: 900, nam_reserve: 1_000_000, counter_reserve: 200, spread: 0.002 },
      { hour: rollbackAt + H, pool_id: '3017', at: rollbackAt + H + 5 * MIN, liquidity_usd: 0, nam_reserve: 820, counter_reserve: 0.00215, spread: 0.002 },
    ]);
    let r = await readPairs(db as any, rollbackAt + 2 * H, null);
    const old = r.pairs.find((p) => p.poolId === '3017')!;
    expect(old.liquidityUsd).toBeNull();
    expect(old.counterReserve).toBeNull();
    expect(old.sizeProv?.note).toMatch(/is the Osmosis router's own figure/);
    insert(db, 'pool_hourly', [
      { hour: NOW - H, pool_id: '3005', at: NOW - H + 5 * MIN, liquidity_usd: 2_000, nam_reserve: 1_000_000, counter_reserve: 200, spread: 0.002 },
      { hour: NOW - H, pool_id: '3017', at: NOW - H + 5 * MIN, liquidity_usd: 2.43, nam_reserve: 820, counter_reserve: 0.0000215, spread: 0.002 },
    ]);
    r = await readPairs(db as any, NOW, null);
    const ours = r.pairs.find((p) => p.poolId === '3017')!;
    expect(ours.liquidityUsd).toBe(2.43);
    expect(ours.counterReserve).toBe(0.0000215);
  });
});
