// Security review (2026-10-22), the Osmosis summary's update time: hourly() (worker/src/series.ts) uses the data
// API's last_update_at only from seven days before the tick to an hour after it. A time in another unit
// (milliseconds, microseconds: past the Date range, where formatting it used to throw before the hour's pool_hourly
// rows and marker) or in 1970 is handled as an answer without an update time: nothing is stored at it, the health
// row names it, the read is asked again in the window, and at the close the hour's pool_hourly rows are written with
// the router's columns and the hour is let go. A stale summary inside the range is stored at its own time, as before.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { testD1, insert, type TestD1 } from './d1-sqlite';
import { parsePairSummary, parsePairChart, type PairSummary } from '../worker/src/sources/osmosis-data';
import { hourly, summaryTimeProblem, JOB_WINDOW_MS, OSMOSIS_SUMMARY_AHEAD_MS, OSMOSIS_SUMMARY_MAX_AGE_MS } from '../worker/src/series';
import { readPairs, readSeries } from '../worker/src/series-api';
import type { PoolInfo, SourceHealth } from '../shared/types';

const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));
const H = 3600000, D = 86400000;
const env = (db: TestD1) => ({ DB: db } as any);
const all = (db: TestD1, sql: string, ...p: unknown[]) => db.raw.prepare(sql).all(...p).map((r: any) => ({ ...r }));
const metric = (db: TestD1, key: string) => all(db, 'SELECT ts, value FROM metrics WHERE key = ? ORDER BY ts', key);
const kv = (db: TestD1, key: string) => all(db, 'SELECT value FROM kv WHERE key = ?', key).map((r) => JSON.parse(r.value))[0];
const osmo = (i: number) => `osmo1${String(i).padStart(38, '0')}`;

const POOLS: PoolInfo[] = [
  { id: '3005', type: 'concentrated', address: osmo(9001), pair: 'NAM / USDC', counterDenom: 'ibc/x', counterSymbol: 'USDC', namReserve: 601_916, counterReserve: 214, liquidityUsd: 916, spreadFactor: 0.002 },
  { id: '3008', type: 'cosmwasm', address: osmo(9002), pair: 'NAM / USDC', counterDenom: 'ibc/y', counterSymbol: 'USDC', namReserve: 1000, counterReserve: 600, liquidityUsd: 654, spreadFactor: 0 },
];
/** The summary answer read on 2026-10-20 (last_update_at 1792523803, 19:16:43 UTC) with its update time replaced. */
const RAW = fx('osmosis-pair-summary.json');
const withUpdate = (lastUpdateAt: number): PairSummary => parsePairSummary({ ...RAW, last_update_at: lastUpdateAt });
const CHART = parsePairChart(fx('osmosis-pair-chart.json'))!;
const hour = Math.floor(CHART[CHART.length - 1].t / H) * H; // 19:00 UTC on 20 Oct 2026
const tick = hour + 3 * 60000, closing = hour + JOB_WINDOW_MS - 60000;

function seeded() {
  const db = testD1();
  insert(db, 'metrics', [1, 2, 3].map((v, i) => ({ ts: hour - H + i * 60000, key: 'price.usd', value: v })));
  return db;
}
function counted(summary: PairSummary) {
  const n = { summary: 0, chart: 0 };
  const c = { pools: POOLS, poolsAt: tick, health: [] as SourceHealth[], listingTick: false,
    summary: async () => { n.summary++; return summary; }, chart: async () => { n.chart++; return CHART; } };
  return { c, n };
}
const summaryNote = (h: SourceHealth[]) => h.filter((x) => x.name === 'Osmosis data API (summary)').pop()!;

describe('the Osmosis summary\'s update time', () => {
  it('in microseconds (past the Date range): the job resolves, stores nothing at it, asks again, and lets the hour go at the close with the router\'s columns', async () => {
    const db = seeded();
    const bad = withUpdate(1792523803 * 1e6);
    expect(bad.at).toBeGreaterThan(8.64e15);
    const { c, n } = counted(bad);
    const r = (await hourly(env(db), tick, c))!;
    expect(r).toMatchObject({ osmosisDone: false, summaryAt: null, rolled: [hour - H] });
    expect(summaryNote(c.health)).toMatchObject({ ok: false, note: expect.stringMatching(/^Not read \(the answer's update time \d+ is ahead of this tick\); asked again on the next tick/) });
    expect(metric(db, 'dex.volume_24h_usd_osmosis')).toEqual([]);
    expect(metric(db, 'dex.volume_7d_usd_osmosis')).toEqual([]);
    expect(all(db, 'SELECT COUNT(*) n FROM pool_hourly')[0].n).toBe(0);
    expect(metric(db, 'price.pool_1h')).toHaveLength(168); // the chart part is written beside it
    expect(kv(db, 'jobs.hourly')).toBe(hour);
    expect(kv(db, 'jobs.hourly_osmosis')).toEqual({ hour, chart: true });
    // the next tick asks for the summary only; the closing tick lets the hour go
    await hourly(env(db), tick + 60000, c);
    const close = (await hourly(env(db), closing, c))!;
    expect(close.osmosisDone).toBe(true);
    expect(n).toEqual({ summary: 3, chart: 1 });
    expect(all(db, 'SELECT pool_id, at, liquidity_usd, osmosis_at FROM pool_hourly ORDER BY pool_id')).toEqual([
      { pool_id: '3005', at: tick, liquidity_usd: 916, osmosis_at: null }, { pool_id: '3008', at: tick, liquidity_usd: 654, osmosis_at: null }]);
    expect(summaryNote(c.health).note).toMatch(/^Not read this hour \(the answer's update time \d+ is ahead of this tick\); the window closed/);
    expect(await hourly(env(db), closing + 30000, c)).toBeNull();
  });

  it('in milliseconds (a year far ahead): nothing is stored at it, so the Osmosis figures are never shown as live', async () => {
    const db = seeded();
    const { c } = counted(withUpdate(1792523803000));
    await hourly(env(db), tick, c);
    expect(summaryNote(c.health)).toMatchObject({ ok: false, note: expect.stringMatching(/update time \+0\d+-.* is ahead of this tick/) });
    await hourly(env(db), closing, c);
    expect(metric(db, 'dex.volume_24h_usd_osmosis')).toEqual([]);
    expect(all(db, 'SELECT COUNT(*) n FROM pool_hourly WHERE osmosis_at IS NOT NULL')[0].n).toBe(0);
    const pairs = await readPairs(db as any, closing + 60000, { pools: [], at: 0 });
    expect(pairs.osmosisProv.status).toBe('missing');
  });

  it('in 1970: nothing is stored at it, so it never becomes the series\' start', async () => {
    const db = seeded();
    insert(db, 'metrics', [{ ts: hour - H + 120000, key: 'dex.volume_24h_usd_osmosis', value: 42 }]);
    const { c } = counted(withUpdate(5));
    await hourly(env(db), tick, c);
    expect(summaryNote(c.health).note).toMatch(/update time 1970-01-01T00:00:05\.000Z is over 7 days old/);
    expect(metric(db, 'dex.volume_24h_usd_osmosis')).toEqual([{ ts: hour - H + 120000, value: 42 }]);
    const s = await readSeries(db as any, { key: 'dex.volume_24h_usd_osmosis' }, tick + 60000, false);
    expect(s.start).toBe(hour - H + 120000);
  });

  it('inside the range nothing changes: a stale summary is stored at its own time and flagged, a fresh one is ok', async () => {
    const db = seeded();
    const at = tick - 3 * H; // 3 h old: the producer stopped updating
    const { c } = counted(withUpdate(at / 1000));
    const r = (await hourly(env(db), tick, c))!;
    expect(r).toMatchObject({ osmosisDone: true, summaryAt: at });
    expect(metric(db, 'dex.volume_24h_usd_osmosis')).toEqual([{ ts: at, value: withUpdate(at / 1000).volume24hUsd }]);
    expect(summaryNote(c.health)).toMatchObject({ ok: false, note: expect.stringMatching(/3\.0 h old, so the volumes are stored with that time/) });
    expect(all(db, 'SELECT COUNT(*) n FROM pool_hourly WHERE osmosis_at = ?', at)[0].n).toBe(27);
    // the fixture's own time, 13.7 min after this tick's clock, is inside the hour allowed ahead
    const db2 = seeded();
    const fresh = counted(withUpdate(1792523803));
    expect((await hourly(env(db2), tick, fresh.c))!.summaryAt).toBe(1792523803000);
    expect(summaryNote(fresh.c.health).ok).toBe(true);
  });

  it('the range\'s edges, and no update time can make the check throw', () => {
    const now = tick;
    expect(summaryTimeProblem(now + OSMOSIS_SUMMARY_AHEAD_MS, now)).toBeNull();
    expect(summaryTimeProblem(now + OSMOSIS_SUMMARY_AHEAD_MS + 1, now)).toMatch(/ahead of this tick/);
    expect(summaryTimeProblem(now - OSMOSIS_SUMMARY_MAX_AGE_MS, now)).toBeNull();
    expect(summaryTimeProblem(now - OSMOSIS_SUMMARY_MAX_AGE_MS - 1, now)).toMatch(/over 7 days old/);
    expect(OSMOSIS_SUMMARY_MAX_AGE_MS).toBe(7 * D);
    // last_update_at 1e306 parses to Infinity; 1e16 to a time past the Date range
    expect(summaryTimeProblem(parsePairSummary({ data: [], last_update_at: 1e306 }).at!, now)).toBe('the answer\'s update time Infinity is ahead of this tick');
    expect(summaryTimeProblem(parsePairSummary({ data: [], last_update_at: 1e16 }).at!, now)).toBe('the answer\'s update time 10000000000000000000 is ahead of this tick');
  });
});
