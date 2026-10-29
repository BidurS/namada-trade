// Security review (2026-10-22), finite Osmosis figures: D1 sends bound parameters as JSON (the Worker's D1 binding
// without the d1_binding_jsrpc flag, which wrangler.jsonc does not set), so a figure that is not a finite number
// arrives as NULL, and metrics.value is NOT NULL: one such figure fails the hour's whole Osmosis batch (pool_hourly,
// the router's columns included, the pool prices and the marker) on every tick of the window and at the close. Two
// routes reached it from figures that are each finite as given: the summary's NAM pairs adding up past the largest
// number (each volume_24h 1e308), and a chart close so small that its dollar price, 1 / close, is Infinity (1e-309,
// kept by the 7-day answer for a week). hourly() writes a volume total only when it is finite and its health row
// says so; the pair chart leaves out a point whose dollar price is not finite (a gap, never an estimate);
// poolPriceStmts writes a point only when all its values are finite; pool_hourly's summary columns are finite or NULL.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { d1Json, insert, type TestD1 } from './d1-sqlite';
import { parsePairSummary, parsePairChart, type PairSummary, type PairChartPoint } from '../worker/src/sources/osmosis-data';
import { hourly, poolPriceStmts, poolHourlyStmts, summaryHealth, JOB_WINDOW_MS } from '../worker/src/series';
import { NAM } from '../worker/src/config';
import type { PoolInfo, SourceHealth } from '../shared/types';

const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));
const H = 3600000;
const all = (db: TestD1, sql: string, ...p: unknown[]) => db.raw.prepare(sql).all(...p).map((r: any) => ({ ...r }));
const metric = (db: TestD1, key: string) => all(db, 'SELECT ts, value FROM metrics WHERE key = ? ORDER BY ts', key);
const kv = (db: TestD1, key: string) => all(db, 'SELECT value FROM kv WHERE key = ?', key).map((r) => JSON.parse(r.value))[0];
const osmo = (i: number) => `osmo1${String(i).padStart(38, '0')}`;

const POOLS: PoolInfo[] = [
  { id: '3005', type: 'concentrated', address: osmo(9001), pair: 'NAM / USDC', counterDenom: 'ibc/x', counterSymbol: 'USDC', namReserve: 601_916, counterReserve: 214, liquidityUsd: 916, spreadFactor: 0.002 },
  { id: '3008', type: 'cosmwasm', address: osmo(9002), pair: 'NAM / USDC', counterDenom: 'ibc/y', counterSymbol: 'USDC', namReserve: 1000, counterReserve: 600, liquidityUsd: 654, spreadFactor: 0 },
];
const RAW = fx('osmosis-pair-summary.json');
const GOOD = parsePairSummary(RAW);
const PTS = fx('osmosis-pair-chart.json') as any[];
const CHART = parsePairChart(PTS)!;
const hour = Math.floor(CHART[CHART.length - 1].t / H) * H; // 19:00 UTC on 20 Oct 2026
const tick = hour + 3 * 60000, closing = hour + JOB_WINDOW_MS - 60000;
const isNam = (p: any) => p.base_address === NAM.osmoDenom || p.quote_address === NAM.osmoDenom;
/** The summary with every NAM pair's `field` replaced. */
const summaryWith = (over: Record<string, unknown>) => parsePairSummary({ ...RAW, data: RAW.data.map((p: any) => (isNam(p) ? { ...p, ...over } : p)) });
/** Every pool the hour's pool_hourly rows should name: the router's two and the summary's NAM pairs. */
const ALL_POOLS = [...new Set(['3005', '3008', ...GOOD.pairs.map((p) => p.poolId)])].sort((a, b) => Number(a) - Number(b));

function seeded() {
  const db = d1Json();
  insert(db, 'metrics', [1, 2, 3].map((v, i) => ({ ts: hour - H + i * 60000, key: 'price.usd', value: v })));
  return db;
}
const ctx = (summary: PairSummary, chart: PairChartPoint[]) => ({ pools: POOLS, poolsAt: tick, health: [] as SourceHealth[], listingTick: false,
  summary: async () => summary, chart: async () => chart });
const rowOf = (h: SourceHealth[], name: string) => h.filter((x) => x.name === name).pop();

describe('a summary whose NAM pairs add up past the largest number', () => {
  it('two pairs of volume_24h 1e308: the 24 h total is not written and the row says so; pool_hourly, the 7-day total, the pool prices and the marker are', async () => {
    const sum = summaryWith({ volume_24h: 1e308 });
    expect(sum.at).toBe(GOOD.at);
    expect(sum.volume24hUsd).toBe(Infinity);
    const db = seeded();
    const c = ctx(sum, CHART);
    const r = (await hourly({ DB: db } as any, tick, c))!;
    expect(rowOf(c.health, 'Series (hourly)')).toBeUndefined();
    expect(r.osmosisDone).toBe(true);
    expect(kv(db, 'jobs.hourly_osmosis')).toEqual({ hour, summary: true, chart: true });
    expect(all(db, 'SELECT pool_id FROM pool_hourly WHERE hour = ? ORDER BY CAST(pool_id AS INTEGER)', hour).map((x) => x.pool_id)).toEqual(ALL_POOLS);
    // each pair's own figure is finite and is kept as given
    expect(all(db, "SELECT volume_24h_usd_osmosis v FROM pool_hourly WHERE hour = ? AND pool_id = '3368'", hour)).toEqual([{ v: 1e308 }]);
    expect(metric(db, 'dex.volume_24h_usd_osmosis')).toEqual([]);
    expect(metric(db, 'dex.volume_7d_usd_osmosis')).toEqual([{ ts: GOOD.at, value: GOOD.volume7dUsd }]);
    expect(metric(db, 'price.pool_1h')).toHaveLength(168);
    expect(rowOf(c.health, 'Osmosis data API (summary)')).toMatchObject({ ok: false,
      note: '27 NAM pairs, updated 19:16 UTC. The pairs\' 24 h volumes add up to more than a number can hold, so that total was not written.' });
  });

  it('both totals past it, on a stale summary: neither is written and the row says both', async () => {
    const sum = summaryWith({ volume_24h: 1e308, volume_7d: 1e308 });
    const db = seeded();
    const c = ctx(sum, CHART);
    await hourly({ DB: db } as any, GOOD.at! + 3 * H - (GOOD.at! % H) + 3 * 60000, c);
    expect(rowOf(c.health, 'Series (hourly)')).toBeUndefined();
    expect(metric(db, 'dex.volume_24h_usd_osmosis')).toEqual([]);
    expect(metric(db, 'dex.volume_7d_usd_osmosis')).toEqual([]);
    expect(rowOf(c.health, 'Osmosis data API (summary)')!.note).toMatch(/h old, so the volumes are stored with that time\. The pairs' 24 h and 7-day volumes add up to more than a number can hold, so those totals were not written\.$/);
  });

  it('the summary row and the written totals are as before for finite figures', async () => {
    expect(summaryHealth(GOOD, GOOD.at! + 60000)).toEqual({ ok: true, note: '27 NAM pairs, updated 19:16 UTC' });
    const db = seeded();
    const c = ctx(GOOD, CHART);
    await hourly({ DB: db } as any, tick, c);
    expect(metric(db, 'dex.volume_24h_usd_osmosis')).toEqual([{ ts: GOOD.at, value: GOOD.volume24hUsd }]);
    expect(metric(db, 'dex.volume_7d_usd_osmosis')).toEqual([{ ts: GOOD.at, value: GOOD.volume7dUsd }]);
  });

  it('pool_hourly\'s summary columns are finite or NULL, whatever the summary handed in holds', () => {
    const bad: PairSummary = { ...GOOD, pairs: GOOD.pairs.map((p) => (p.poolId === '3005' ? { ...p, volume24hUsd: Infinity, volume7dUsd: NaN, liquidityUsd: -Infinity } : p)) };
    const row = poolHourlyStmts(hour, POOLS, tick, bad).find((s) => s.params[1] === '3005')!;
    expect(row.params.slice(7)).toEqual([null, null, null, GOOD.at]);
    expect(poolHourlyStmts(hour, POOLS, tick, GOOD)).toEqual(poolHourlyStmts(hour, POOLS, tick, { ...GOOD }));
  });
});

describe('a chart close whose dollar price is not finite', () => {
  const badPts = PTS.map((p, i) => (i === PTS.length - 3 ? { ...p, close: 1e-309 } : p));
  const droppedAt = PTS[PTS.length - 3].time * 1000;

  it('the pair chart leaves the point out (a gap), and keeps every other point as before', () => {
    const chart = parsePairChart(badPts)!;
    expect(chart).toHaveLength(CHART.length - 1);
    expect(chart.some((p) => p.t === droppedAt)).toBe(false);
    expect(chart).toEqual(CHART.filter((p) => p.t !== droppedAt));
    expect(chart.every((p) => [p.usd.open, p.usd.high, p.usd.low, p.usd.close].every(Number.isFinite))).toBe(true);
    // any of the four: a low that small makes the dollar high Infinity
    expect(parsePairChart(PTS.map((p, i) => (i === 3 ? { ...p, low: 5e-324 } : p)))).toHaveLength(CHART.length - 1);
  });

  it('two hours in a row: each writes its pool_hourly rows and the pool prices after the stored one, all but the gap', async () => {
    const chart = parsePairChart(badPts)!;
    const db = seeded();
    insert(db, 'metrics', [{ ts: hour - 5 * H, key: 'price.pool_1h', value: 0.0011 }]);
    const c = ctx(GOOD, chart);
    await hourly({ DB: db } as any, tick, c);
    await hourly({ DB: db } as any, closing, c);
    const c2 = ctx({ ...GOOD, at: GOOD.at! + H }, chart);
    await hourly({ DB: db } as any, tick + H, c2);
    expect([...c.health, ...c2.health].filter((h) => h.name === 'Series (hourly)')).toEqual([]);
    expect(all(db, 'SELECT hour FROM pool_hourly GROUP BY hour ORDER BY hour').map((r) => r.hour)).toEqual([hour, hour + H]);
    // the second hour also writes the first one's point, closed by then
    expect(metric(db, 'price.pool_1h').map((r) => r.ts)).toEqual([hour - 5 * H, hour - 4 * H, hour - 3 * H, hour - H, hour]);
    expect(droppedAt).toBe(hour - 2 * H);
  });

  it('poolPriceStmts writes a point only when every value is finite', () => {
    const p = CHART[CHART.length - 2];
    const stmts = poolPriceStmts([{ ...p, usd: { ...p.usd, high: Infinity } }, { ...CHART[CHART.length - 3] }], hour);
    expect(stmts.map((s) => s.params[0])).toEqual(Array(5).fill(CHART[CHART.length - 3].t));
    expect(poolPriceStmts([{ ...p, t: NaN }], hour)).toEqual([]);
    expect(poolPriceStmts(CHART, hour)).toHaveLength(168 * 5);
  });
});
