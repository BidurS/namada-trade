// /api/series (worker/src/api-series.ts, worker/src/series-api.ts; docs/design/screener-plan.md 2.1 to 2.7, 2.12 and
// 3.9) on the D1 stand-in with every migration applied: each route on seeded data whose answers are worked out here
// independently of the route's code, the empty and missing states, the refusals, the edge-cache parameter list, and
// the plan of every statement the routes run (SEARCH on an index, no TEMP B-TREE, no SCAN of a table).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from '../worker/src/api';
import { testD1, insert, type TestD1 } from './d1-sqlite';
import { SERIES_PARAMS } from '../worker/src/api-series';
import { CACHE_PARAMS, CACHEABLE_API } from '../worker/src/http';
import * as S from '../worker/src/series-api';
import { NAM, OSMOSIS } from '../worker/src/config';
import { decodeFlowCursor, encodeFlowCursor } from '../shared/paging';
import { fmtDay } from '../shared/search-grammar';
import type { SeriesResponse, PriceChangesResponse, VolumeResponse, PairsResponse, TradesResponse, NotServedBody, TradeRow, ValuesResponse } from '../shared/types';
import { TRADE_FOLD_MS } from '../shared/types';

const H = 3_600_000, D = 86_400_000, MIN = 60_000;
/** 22:10 UTC on 20 Oct 2026 (the day this was built), whole minute. */
const NOW = Date.UTC(2026, 9, 20, 22, 10);
const HOUR = Math.floor(NOW / H) * H;

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const at = (t: number) => vi.useFakeTimers({ now: t, toFake: ['Date'] });

async function call<T = any>(db: TestD1 | any, path: string): Promise<{ status: number; body: T; cache: string | null }> {
  const res = await app.request(path, {}, { DB: db } as any);
  return { status: res.status, body: (await res.json()) as T, cache: res.headers.get('cache-control') };
}

/** Insert many metrics rows in one transaction. */
function metrics(db: TestD1, rows: [number, string, number][]) {
  db.raw.exec('BEGIN');
  const st = db.raw.prepare('INSERT OR REPLACE INTO metrics (ts, key, value) VALUES (?, ?, ?)');
  for (const [ts, key, value] of rows) st.run(ts, key, value);
  db.raw.exec('COMMIT');
}
const all = (db: TestD1, sql: string, ...p: unknown[]) => db.raw.prepare(sql).all(...p).map((r: any) => ({ ...r }));

// ================================================================ the quoted price, minute by minute

/** The quoted price: a reading at 2 s past each minute from 17 Oct 2026 22:10 to 22:09 today, with holes. */
const Q_START_MIN = NOW - 3 * D;
const OUTAGE = [NOW - 10 * H, NOW - 10 * H + 20 * MIN] as const; // 20 minutes without a reading
const JITTER = NOW - 5 * H; // one minute skipped (a slow tick), not a gap
const qv = (m: number) => 0.001 + 1e-7 * ((m / MIN) % 97);

function seedQuoted(db: TestD1, rollupUpTo = HOUR - H) {
  const rows: [number, string, number][] = [];
  const minutes: { ts: number; v: number }[] = [];
  for (let m = Q_START_MIN; m <= NOW - MIN; m += MIN) {
    if ((m >= OUTAGE[0] && m < OUTAGE[1]) || m === JITTER) continue;
    rows.push([m + 2000, 'price.usd', qv(m)]);
    minutes.push({ ts: m + 2000, v: qv(m) });
  }
  // the hourly rollups the cron writes (series.ts rollupStmts), for the closed hours before `rollupUpTo`
  const byHour = new Map<number, { ts: number; v: number }[]>();
  for (const x of minutes) { const h = Math.floor(x.ts / H) * H; (byHour.get(h) ?? byHour.set(h, []).get(h)!).push(x); }
  for (const [h, xs] of byHour) {
    if (h >= rollupUpTo) continue;
    rows.push([h, 'price.usd.1h', xs[xs.length - 1].v], [h, 'price.usd.1h.lo', Math.min(...xs.map((x) => x.v))], [h, 'price.usd.1h.hi', Math.max(...xs.map((x) => x.v))]);
  }
  metrics(db, rows);
  return { minutes, byHour };
}

describe('GET /api/series: a minute series and its hourly rollups', () => {
  it('1-minute steps: one point per minute with a reading, a 20-minute outage is a gap, a single skipped minute is not', async () => {
    at(NOW);
    const db = testD1();
    seedQuoted(db);
    const { status, body } = await call<SeriesResponse>(db, `/api/series?key=price.usd&from=${NOW - 12 * H}&step=1m`);
    expect(status).toBe(200);
    expect(body.step).toBe('1m');
    expect(body.stepMs).toBe(MIN);
    expect(body.unit).toBe('usd_per_nam');
    expect(body.agg).toBe('last');
    expect(body.sparse).toBe(false);
    expect(body.coverage).toEqual({ steps: 720, withPoint: 720 - 20 - 1 });
    expect(body.points).toHaveLength(699);
    expect(body.gaps).toEqual([{ from: OUTAGE[0], to: OUTAGE[1], why: expect.stringMatching(/no reading/i) }]);
    // each point is that minute's reading, at the minute's start
    const p = body.points.find((x) => x.t === NOW - 2 * H)!;
    expect(p.v).toBe(qv(NOW - 2 * H));
    expect(body.points.every((x, i, a) => i === 0 || x.t > a[i - 1].t)).toBe(true);
    expect(body.start).toBe(Q_START_MIN + 2000);
    expect(body.sources).toHaveLength(1);
    expect(body.sources[0]).toMatchObject({ source: 'Osmosis SQS (stored)', start: Q_START_MIN + 2000, backfilled: false, from: NOW - 12 * H, to: NOW - MIN });
    expect(body.sources[0].startNote).toContain(fmtDay(Q_START_MIN));
    expect(body.prov).toMatchObject({ source: 'Osmosis SQS (stored)', at: NOW - MIN + 2000, status: 'live' });
  });

  it('1-hour steps read the rollups, and the hours not rolled up yet from their minute readings', async () => {
    at(NOW);
    const db = testD1();
    // the hourly job has not run for 21:00 yet: rollups up to 20:00
    const { byHour } = seedQuoted(db, HOUR - H);
    const { body } = await call<SeriesResponse>(db, '/api/series?key=price.usd');
    expect(body.step).toBe('1h'); // 30 days: the finest step within 3,000 points
    expect(body.to).toBe(NOW);
    expect(body.from).toBe(NOW - 30 * D);
    const hours = [...byHour.keys()].sort((a, b) => a - b);
    expect(body.points.map((p) => p.t)).toEqual(hours);
    for (const h of hours) {
      const xs = byHour.get(h)!, p = body.points.find((x) => x.t === h)!;
      expect(p.v).toBe(xs[xs.length - 1].v);
      expect(p.lo).toBe(Math.min(...xs.map((x) => x.v)));
      expect(p.hi).toBe(Math.max(...xs.map((x) => x.v)));
      expect(p.n).toBeUndefined(); // the rollup keeps no count of its readings
    }
    // the current hour comes from its minute readings, so the newest point is the newest reading, and it carries that
    // reading's own time (the chart's "Pools quote now" age reads it, not the hour's start)
    expect(body.points[body.points.length - 1].t).toBe(HOUR);
    expect(body.points[body.points.length - 1].at).toBe(NOW - MIN + 2000);
    expect(body.points[0].at).toBeUndefined(); // a rolled-up hour is keyed at its start: no time of its own is sent
    expect(body.prov).toMatchObject({ at: NOW - MIN + 2000, status: 'live' });
    expect(body.gaps).toEqual([]);
    const first = Math.floor((Q_START_MIN + 2000) / H);
    expect(body.coverage).toEqual({ steps: Math.floor((NOW - 1) / H) - first + 1, withPoint: hours.length });
  });

  it('the start is the first minute reading, or a rollup hour before it when minute rows are gone; no point lies before it', async () => {
    at(NOW);
    const db = testD1();
    seedQuoted(db);
    const first = Q_START_MIN + 2000;
    expect((await call<SeriesResponse>(db, '/api/series?key=price.usd')).body.start).toBe(first);
    // the minute readings of the first day removed: the rollups still hold those hours
    db.raw.prepare(`DELETE FROM metrics WHERE key = 'price.usd' AND ts < ?`).run(Q_START_MIN + D);
    const r = (await call<SeriesResponse>(db, '/api/series?key=price.usd')).body;
    expect(r.start).toBe(Math.floor(first / H) * H);
    expect(r.points[0].t).toBeGreaterThanOrEqual(r.start!);
    expect(r.coverage.withPoint).toBe(r.points.length);
  });

  it('6-hour steps thin the hours: the last of each step, its lowest and highest reading', async () => {
    at(NOW);
    const db = testD1();
    const { byHour } = seedQuoted(db);
    const { body } = await call<SeriesResponse>(db, `/api/series?key=price.usd&step=6h&from=${NOW - 3 * D}`);
    expect(body.step).toBe('6h');
    const want = new Map<number, { v: number; lo: number; hi: number; last: number }>();
    for (const [h, xs] of [...byHour.entries()].sort((a, b) => a[0] - b[0])) {
      const b = Math.floor(h / (6 * H)) * 6 * H;
      const w = want.get(b) ?? { v: 0, lo: Infinity, hi: -Infinity, last: 0 };
      w.v = xs[xs.length - 1].v; w.lo = Math.min(w.lo, ...xs.map((x) => x.v)); w.hi = Math.max(w.hi, ...xs.map((x) => x.v));
      want.set(b, w);
    }
    expect(body.points.map((p) => ({ t: p.t, v: p.v, lo: p.lo, hi: p.hi }))).toEqual([...want.entries()].map(([t, w]) => ({ t, v: w.v, lo: w.lo, hi: w.hi })));
  });

  it('under Rewind nothing after the rewound time is read, and the stamp is as of then', async () => {
    at(NOW);
    const db = testD1();
    seedQuoted(db);
    const asOf = NOW - 2 * D + 17 * MIN;
    const { body } = await call<SeriesResponse>(db, `/api/series?key=price.usd&step=1m&from=${asOf - 3 * H}&at=${asOf}`);
    expect(body.to).toBe(asOf);
    expect(body.asOf).toBe(asOf);
    expect(Math.max(...body.points.map((p) => p.t))).toBeLessThanOrEqual(asOf);
    expect(body.prov.status).toBe('live');
    expect(body.prov.at).toBeLessThanOrEqual(asOf);
  });
});

// ================================================================ hourly series: executed price, pool price, volume

describe('GET /api/series: hourly series', () => {
  it('the executed price is sparse: a point only for hours with a trade, its own low, high and count; no gaps', async () => {
    at(NOW);
    const db = testD1();
    const hours = [HOUR - 2 * H, HOUR - 5 * H, HOUR - 20 * H];
    const rows: [number, string, number][] = [[HOUR - 8 * D, 'price.swap_1h', 0.0009], [HOUR - 8 * D, 'price.swap_1h.n', 1]];
    hours.forEach((h, i) => rows.push([h, 'price.swap_1h', 0.0011 + i * 1e-5], [h, 'price.swap_1h.low', 0.00105], [h, 'price.swap_1h.high', 0.0012 + i * 1e-5], [h, 'price.swap_1h.n', 3 + i]));
    metrics(db, rows);
    insert(db, 'kv', [{ key: 'jobs.hourly', value: String(HOUR), updated_at: HOUR + 60_000 }]);
    const from = NOW - D;
    const { body } = await call<SeriesResponse>(db, `/api/series?key=price.swap_1h&from=${from}`);
    expect(body.step).toBe('1h');
    expect(body.sparse).toBe(true);
    expect(body.gaps).toEqual([]);
    expect(body.points).toEqual([...hours].reverse().map((h) => {
      const i = hours.indexOf(h);
      return { t: h, v: 0.0011 + i * 1e-5, lo: 0.00105, hi: 0.0012 + i * 1e-5, n: 3 + i };
    }));
    expect(body.coverage).toEqual({ steps: Math.floor((NOW - 1) / H) - Math.floor(from / H) + 1, withPoint: 3 });
    expect(body.start).toBe(HOUR - 8 * D);
    expect(body.sources[0].backfilled).toBe(true);
    expect(body.prov).toMatchObject({ status: 'live', at: HOUR - 2 * H });
    // the writer has stopped: the newest point may not be the newest trade-hour, and the stamp says so
    db.raw.prepare(`UPDATE kv SET value = ? WHERE key = 'jobs.hourly'`).run(String(HOUR - 5 * H));
    const old = (await call<SeriesResponse>(db, `/api/series?key=price.swap_1h&from=${from}`)).body;
    expect(old.prov.status).toBe('stale');
    expect(old.prov.note).toBe(`Trades are counted up to ${fmtDay(HOUR - 5 * H)} ${new Date(HOUR - 5 * H).toISOString().slice(11, 16)} UTC; the hourly writer has not run since, so newer trades are not counted yet.`);
  });

  it('the pool price: flat hours flagged, a coarser step flat only when every hour in it was, missing hours a gap', async () => {
    at(NOW);
    const db = testD1();
    const start = Math.floor((NOW - 3 * D) / (6 * H)) * 6 * H; // a 6-hour boundary
    const missing = new Set([HOUR - 12 * H, HOUR - 11 * H, HOUR - 10 * H]);
    const flatBucket = start + 6 * H; // every hour of this step is flat
    const rows: [number, string, number][] = [];
    const hourly: { t: number; c: number; flat: boolean }[] = [];
    for (let h = start; h <= HOUR - H; h += H) {
      if (missing.has(h)) continue;
      const flat = (h >= flatBucket && h < flatBucket + 6 * H) || (h / H) % 3 === 0;
      const c = 0.001 + ((h / H) % 11) * 1e-5;
      hourly.push({ t: h, c, flat });
      rows.push([h, 'price.pool_1h', c], [h, 'price.pool_1h.low', c * 0.99], [h, 'price.pool_1h.high', c * 1.01], [h, 'price.pool_1h.open', c], [h, 'price.pool_1h.flat', flat ? 1 : 0]);
    }
    metrics(db, rows);
    const r1 = (await call<SeriesResponse>(db, `/api/series?key=price.pool_1h&from=${start}`)).body;
    expect(r1.step).toBe('1h');
    expect(r1.points.map((p) => [p.t, p.v, p.flat])).toEqual(hourly.map((x) => [x.t, x.c, x.flat]));
    expect(r1.points[0]).toMatchObject({ lo: hourly[0].c * 0.99, hi: hourly[0].c * 1.01 });
    expect(r1.gaps).toEqual([{ from: HOUR - 12 * H, to: HOUR - 9 * H, why: expect.stringMatching(/Osmosis app/) }]);
    expect(r1.sources[0].source).toBe('Osmosis data API');
    expect(r1.sources[0].startNote).toMatch(/not trades/);
    expect(r1.prov).toMatchObject({ at: HOUR - H, status: 'live' });

    const r6 = (await call<SeriesResponse>(db, `/api/series?key=price.pool_1h&from=${start}&step=6h`)).body;
    for (const p of r6.points) {
      const inStep = hourly.filter((x) => x.t >= p.t && x.t < p.t + 6 * H);
      expect(p.v).toBe(inStep[inStep.length - 1].c);
      expect(p.n).toBe(inStep.length);
      if (inStep.some((x) => !x.flat)) expect(p.flat).toBe(false);
      else if (inStep.length === 6) expect(p.flat).toBe(true);
      else expect(p.flat).toBeUndefined();
    }
    expect(r6.points.find((p) => p.t === flatBucket)!.flat).toBe(true);
    // a 6-hour step keeps the time of its newest hour when that is not the step's start
    for (const p of r6.points) {
      const inStep = hourly.filter((x) => x.t >= p.t && x.t < p.t + 6 * H);
      const newest = inStep[inStep.length - 1].t;
      if (newest === p.t) expect(p.at).toBeUndefined();
      else expect(p.at).toBe(newest);
    }
  });

  it('an hour is a gap only once its writer is due (the first minutes of the next hour); a long range picks a coarser step', async () => {
    at(NOW); // 22:10: the 21:00 pool hour is written by 22:15, so it is not missing yet; 20:00 is
    const db = testD1();
    const rows: [number, string, number][] = [];
    for (let h = HOUR - 400 * D; h <= HOUR - 3 * H; h += H) rows.push([h, 'price.pool_1h', 0.001]);
    metrics(db, rows);
    const r = (await call<SeriesResponse>(db, `/api/series?key=price.pool_1h&from=${NOW - D}`)).body;
    expect(r.gaps).toEqual([{ from: HOUR - 2 * H, to: HOUR - H, why: expect.any(String) }]);
    const y = (await call<SeriesResponse>(db, `/api/series?key=price.pool_1h&from=${NOW - 365 * D}`)).body;
    expect(y.step).toBe('6h'); // 8,760 hours would pass 3,000 points
    expect(y.stepMs).toBe(6 * H);
    expect(y.points.length).toBeLessThanOrEqual(3000);
    expect(y.points.every((p) => p.t % (6 * H) === 0)).toBe(true);
  });

  it('volume per hour adds up at a coarser step; a step without a trade has no point', async () => {
    at(NOW);
    const db = testD1();
    const vals = new Map<number, number>([[HOUR - H, 400], [HOUR - 2 * H, 250], [HOUR - 9 * H, 1000], [HOUR - 30 * H, 5]]);
    metrics(db, [...vals].map(([t, v]): [number, string, number] => [t, 'dex.swaps_1h.nam', v]));
    const { body } = await call<SeriesResponse>(db, `/api/series?key=dex.swaps_1h.nam&step=6h&from=${NOW - 2 * D}`);
    expect(body.agg).toBe('sum');
    expect(body.unit).toBe('nam');
    const want = new Map<number, number>();
    for (const [t, v] of vals) { const b = Math.floor(t / (6 * H)) * 6 * H; want.set(b, (want.get(b) ?? 0) + v); }
    expect(body.points.map((p) => [p.t, p.v])).toEqual([...want].sort((a, b) => a[0] - b[0]));
    expect(body.points.every((p) => p.lo === undefined && p.hi === undefined)).toBe(true);
  });
});

describe('GET /api/series: one pool\'s stored hours (pool_hourly)', () => {
  it('a pool column by the hour: the router\'s reading at its own time, the Osmosis app\'s at its own; a missing hour is a gap', async () => {
    at(NOW);
    const db = testD1();
    const rows: Record<string, unknown>[] = [];
    for (let h = HOUR - 5 * H; h <= HOUR; h += H) {
      if (h === HOUR - 3 * H) continue; // the job did not run that hour
      const osmo = h !== HOUR - 4 * H; // the summary was not read that hour
      rows.push({ hour: h, pool_id: '3005', at: h + 3000, liquidity_usd: 900 + h / H % 7, nam_reserve: 600000, counter_reserve: 209, spread: 0.002,
        volume_24h_usd_osmosis: osmo ? 4 + h / H % 3 : null, volume_7d_usd_osmosis: osmo ? 420 : null, liquidity_usd_osmosis: osmo ? 209 : null, osmosis_at: osmo ? h - 300_000 : null });
    }
    rows.push({ hour: HOUR, pool_id: '3368', at: HOUR + 3000, liquidity_usd: 170 });
    insert(db, 'pool_hourly', rows);
    const liq = (await call<SeriesResponse>(db, `/api/series?key=pool_hourly.3005.liquidity_usd&from=${HOUR - 5 * H}`)).body;
    expect(liq).toMatchObject({ key: 'pool_hourly.3005.liquidity_usd', step: '1h', unit: 'usd', agg: 'last', sparse: false, start: HOUR - 5 * H });
    expect(liq.points.map((p) => [p.t, p.v])).toEqual(rows.filter((r) => r.pool_id === '3005').map((r) => [r.hour, r.liquidity_usd]));
    expect(liq.gaps).toEqual([{ from: HOUR - 3 * H, to: HOUR - 2 * H, why: expect.stringMatching(/router/) }]);
    expect(liq.prov).toMatchObject({ source: 'Osmosis SQS pools (stored)', at: HOUR + 3000, status: 'live' });
    const vol = (await call<SeriesResponse>(db, `/api/series?key=pool_hourly.3005.volume_24h_usd_osmosis&from=${HOUR - 5 * H}`)).body;
    expect(vol.points.map((p) => p.t)).toEqual([HOUR - 5 * H, HOUR - 2 * H, HOUR - H, HOUR]);
    expect(vol.gaps).toEqual([{ from: HOUR - 4 * H, to: HOUR - 2 * H, why: expect.stringMatching(/Osmosis app/) }]);
    expect(vol.prov).toMatchObject({ source: 'Osmosis data API', at: HOUR - 300_000 });
    expect(vol.sources[0].startNote).toMatch(/per-pool readings were not kept before/);
    for (const k of ['pool_hourly.3005.spread', 'pool_hourly.abc.liquidity_usd', 'pool_hourly.3005']) expect((await call(db, `/api/series?key=${k}`)).status, k).toBe(404);
    const none = (await call<SeriesResponse>(db, '/api/series?key=pool_hourly.4242.liquidity_usd')).body;
    expect(none).toMatchObject({ points: [], start: null, prov: { status: 'missing' } });
  });
});

describe('GET /api/series: empty, missing and refused', () => {
  it('a series with nothing recorded: no point, no start, the reason', async () => {
    at(NOW);
    const { status, body } = await call<SeriesResponse>(testD1(), '/api/series?key=holders.namada');
    expect(status).toBe(200);
    expect(body).toMatchObject({ points: [], start: null, gaps: [], coverage: { steps: 0, withPoint: 0 } });
    expect(body.prov).toMatchObject({ status: 'missing', at: null, note: 'Nothing is recorded for this series yet.' });
    expect(body.sources[0].startNote).toBe('Nothing is recorded for this series yet.');
  });

  it('a range before the series starts says when it starts; nothing is drawn before it', async () => {
    at(NOW);
    const db = testD1();
    seedQuoted(db);
    const { body } = await call<SeriesResponse>(db, `/api/series?key=price.usd&from=2026-10-01&to=2026-10-10`);
    expect(body.points).toEqual([]);
    expect(body.prov.note).toBe(`Nothing in this range: the series starts on ${fmtDay(Q_START_MIN)}.`);
    expect(body.from).toBe(Date.UTC(2026, 9, 1));
    expect(body.to).toBe(Date.UTC(2026, 9, 11)); // `to` as a day is the end of that day
  });

  it('refuses what it cannot answer as asked, in plain words, never cached', async () => {
    at(NOW);
    const db = testD1();
    const cases: [string, number, RegExp][] = [
      ['/api/series', 400, /key is required/],
      ['/api/series?key=price.nope', 404, /No such series/],
      ['/api/series?key=price.usd&from=yesterday', 400, /from must be a time/],
      ['/api/series?key=price.usd&from=2026-02-30', 400, /from must be a time/],
      [`/api/series?key=price.usd&from=${NOW - D}&to=${NOW - 2 * D}`, 400, /before/],
      ['/api/series?key=price.usd&step=1m', 400, /43,200 points.*3,000/],
      ['/api/series?key=price.usd&step=2h', 400, /step must be one of/],
      ['/api/series?key=price.usd&from=2019-12-31', 400, /from must be a time/],
    ];
    for (const [path, status, re] of cases) {
      const r = await call<NotServedBody>(db, path);
      expect(r.status, path).toBe(status);
      expect(r.body.error, path).toMatch(re);
      expect(r.body.endpoint).toBe('/api/series');
      expect(r.cache).toBe('no-store');
    }
    // a step finer than the key's own cadence is raised to it, not refused
    expect((await call<SeriesResponse>(db, `/api/series?key=price.pool_1h&step=1m&from=${NOW - D}`)).body.step).toBe('1h');
    expect((await call<NotServedBody>(db, '/api/series?key=price.nope')).body.reason).toMatch(/Served keys: .*price\.usd/);
  });

  it('a database failure is a 500 in the same shape, never cached', async () => {
    at(NOW);
    const broken = { ...testD1(), prepare: () => { throw new Error('D1_ERROR: overloaded'); } };
    for (const p of ['/api/series?key=price.usd', '/api/series/changes', '/api/series/volume', '/api/series/trades', '/api/series/values']) {
      const r = await call<NotServedBody>(broken, p);
      expect(r.status, p).toBe(500);
      expect(r.cache).toBe('no-store');
      expect(r.body.error).toBe('Something went wrong on our side.');
      expect(JSON.stringify(r.body)).not.toMatch(/D1_ERROR/);
    }
  });
});

// ================================================================ price changes

describe('GET /api/series/changes', () => {
  /** 26 hours of the quoted price, a minute apart (2 s past each minute), and four pool-price hours. */
  function seedChanges(db: TestD1, hole?: [number, number]) {
    const rows: [number, string, number][] = [];
    for (let m = NOW - 26 * H; m <= NOW - MIN; m += MIN) if (!hole || m < hole[0] || m >= hole[1]) rows.push([m + 2000, 'price.usd', qv(m)]);
    const ph = HOUR - H;
    rows.push([ph, 'price.pool_1h', 0.0012], [ph - 7 * D, 'price.pool_1h', 0.001], [ph - 30 * D, 'price.pool_1h', 0.0008], [ph - 365 * D, 'price.pool_1h', 0.002]);
    metrics(db, rows);
  }

  it('each change from the first reading at or after the window\'s start, with that base; too young a record is null with the date it is known from', async () => {
    at(NOW);
    const db = testD1();
    seedChanges(db);
    const { status, body } = await call<PriceChangesResponse>(db, '/api/series/changes');
    expect(status).toBe(200);
    const nowAt = NOW - MIN + 2000, nowV = qv(NOW - MIN);
    for (const [w, ms] of [['h1', H], ['h6', 6 * H], ['h24', D]] as const) {
      const c = body.quoted[w];
      const baseM = NOW - MIN - ms;
      expect(c.now).toEqual({ at: nowAt, value: nowV });
      expect(c.base).toEqual({ at: baseM + 2000, value: qv(baseM) });
      expect(c.baseLagMs).toBe(0);
      expect(c.pct).toBeCloseTo(((nowV - qv(baseM)) / qv(baseM)) * 100, 10);
      expect(c.prov).toMatchObject({ source: 'Osmosis SQS (stored)', at: nowAt, status: 'live' });
    }
    const first = NOW - 26 * H + 2000;
    // known once the first reading is within 5% of the window after its start (PRICE_BASE_MAX_LAG_SHARE): 8.4 hours for 7 days
    expect(body.quoted.d7).toMatchObject({ pct: null, base: null, note: `The quoted price has been recorded since ${fmtDay(first)}, so its 7-day change is known from ${fmtDay(first + 7 * D - 0.05 * 7 * D)}.` });
    expect(body.quoted.d30.pct).toBeNull();
    // the pool price, kept apart, with its own source; each reading is its hour's close (the hour keyed ph closes at ph + 1 h)
    const ph = HOUR - H;
    expect(body.pool.d7).toMatchObject({ pct: expect.closeTo(20, 9), base: { at: ph - 7 * D + H, value: 0.001 }, now: { at: ph + H, value: 0.0012 } });
    expect(body.pool.d30.pct).toBeCloseTo(50, 9);
    expect(body.pool.y1.pct).toBeCloseTo(-40, 9);
    expect(body.pool.y1.prov).toMatchObject({ source: 'Osmosis data API', status: 'live', at: ph + H });
  });

  it('a pool-price hour counts from its close: under Rewind inside an hour, that hour (closed later) is not read', async () => {
    at(NOW);
    const db = testD1();
    seedChanges(db);
    const ph = HOUR - H;
    // rewound to 21:40, inside the hour keyed 21:00 (its close, 22:00, came after it): the newest close is the hour keyed 20:00, if any
    metrics(db, [[ph - H, 'price.pool_1h', 0.0011]]);
    const asOf = ph + 40 * MIN;
    const { body } = await call<PriceChangesResponse>(db, `/api/series/changes?at=${asOf}`);
    expect(body.pool.d7.now).toEqual({ at: ph, value: 0.0011 });
    expect(body.pool.d7.prov).toMatchObject({ status: 'live', at: ph });
    // the base is the first close at or after now − 7 days: the hour keyed ph − 7 d (closing at ph − 7 d + 1 h)
    expect(body.pool.d7.base).toEqual({ at: ph - 7 * D + H, value: 0.001 });
  });

  it('a gap in the readings longer than 5% of the window makes that change null, with the reason and the late base', async () => {
    at(NOW);
    const db = testD1();
    const holeFrom = NOW - MIN - 6 * H; // the 6-hour window starts inside a 20-minute hole
    seedChanges(db, [holeFrom, holeFrom + 20 * MIN]);
    const { body } = await call<PriceChangesResponse>(db, '/api/series/changes');
    expect(body.quoted.h6.pct).toBeNull();
    expect(body.quoted.h6.baseLagMs).toBe(20 * MIN);
    expect(body.quoted.h6.base).toEqual({ at: holeFrom + 20 * MIN + 2000, value: qv(holeFrom + 20 * MIN) });
    expect(body.quoted.h6.note).toMatch(/20 minutes later \(a gap in the readings\)/);
    expect(body.quoted.h1.pct).not.toBeNull();
    expect(body.quoted.h24.pct).not.toBeNull(); // 20 minutes is under 5% of a day
  });

  it('nothing recorded: every change null with the reason, the stamps missing', async () => {
    at(NOW);
    const { body } = await call<PriceChangesResponse>(testD1(), '/api/series/changes');
    for (const c of [...Object.values(body.quoted), ...Object.values(body.pool)]) {
      expect(c.pct).toBeNull();
      expect(c.prov.status).toBe('missing');
      expect(c.note).toMatch(/No (quoted|pool) price is recorded/);
    }
  });
});

// ================================================================ volume

interface SeedTrade { id: string; ts: number; height: number; kind: 'buy' | 'sell' | 'other'; maker: string; nam: number; usd: number | null; arb?: boolean; route?: string; counter?: string; counterAmount?: number | null; price?: number | null; meta?: Record<string, unknown> }
const osmo = (i: number) => `osmo1${String(i).padStart(38, '0')}`;

function insertTrades(db: TestD1, ts: SeedTrade[]) {
  db.raw.exec('BEGIN');
  const st = db.raw.prepare(`INSERT INTO flows (id, chain, height, ts, tx_hash, kind, from_addr, to_addr, amount_num, counter_denom, counter_amount, pool_id, price_usd, value_usd, meta)
    VALUES (?, 'osmosis', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const t of ts) {
    const meta = t.meta ?? (t.arb ? { arb: true } : { trader: t.maker });
    const price = t.price !== undefined ? t.price : t.usd != null ? t.usd / t.nam : null;
    st.run(t.id, t.height, t.ts, t.id.split(':')[1] ?? t.id, t.kind, t.kind === 'buy' ? null : t.maker, t.kind === 'buy' ? t.maker : null, t.nam,
      t.counter ?? 'USDC', t.counterAmount !== undefined ? t.counterAmount : t.usd, t.route ?? '3005', price, t.usd, JSON.stringify(meta));
  }
  db.raw.exec('COMMIT');
}

function volumeSeed(firstAgo = 35 * D): SeedTrade[] {
  const out: SeedTrade[] = [];
  for (let i = 0; NOW - MIN - i * 50 * MIN > NOW - firstAgo; i++) {
    const nam = 100 + (i % 13) * 37;
    out.push({ id: `osmosis:B${i}:swap`, ts: NOW - MIN - i * 50 * MIN, height: 9_000_000 - i, kind: 'buy', maker: osmo(i % 4), nam, usd: i >= 40 && i % 17 === 5 ? null : nam * (0.001 + (i % 7) * 1e-5) });
  }
  for (let i = 0; NOW - 7 * MIN - i * 187 * MIN > NOW - firstAgo; i++) {
    const nam = 500 + (i % 5) * 100;
    out.push({ id: `osmosis:S${i}:swap`, ts: NOW - 7 * MIN - i * 187 * MIN, height: 8_000_000 - i, kind: 'sell', maker: osmo(10 + (i % 3)), nam, usd: nam * 0.00105 });
  }
  // bot round trips: never volume
  out.push({ id: 'osmosis:ARB1:swap', ts: NOW - 2 * H, height: 1, kind: 'other', maker: osmo(99), nam: 50_000, usd: 50, arb: true });
  out.push({ id: 'osmosis:ARB2:swap', ts: NOW - 3 * H, height: 2, kind: 'buy', maker: osmo(98), nam: 70_000, usd: 70, arb: true });
  return out;
}

/** The window's figures computed here from the seed, independently of executedVolume. */
function expectedVolume(seed: SeedTrade[], ms: number) {
  const inW = seed.filter((t) => !t.arb && (t.kind === 'buy' || t.kind === 'sell') && t.ts > NOW - ms && t.ts <= NOW);
  const b = inW.filter((t) => t.kind === 'buy'), s = inW.filter((t) => t.kind === 'sell');
  const sumN = (xs: SeedTrade[]) => xs.reduce((a, t) => a + t.nam, 0);
  const sumU = (xs: SeedTrade[]) => xs.reduce((a, t) => a + (t.usd ?? 0), 0);
  const priced = (xs: SeedTrade[]) => xs.filter((t) => t.usd != null);
  const vw = (xs: SeedTrade[]) => (priced(xs).length ? sumU(priced(xs)) / sumN(priced(xs)) : null);
  return {
    nam: sumN(inW), buyNam: sumN(b), sellNam: sumN(s), buys: b.length, sells: s.length,
    usd: inW.every((t) => t.usd != null) ? sumU(inW) : null, usdPriced: sumU(priced(inW)), unpriced: inW.length - priced(inW).length,
    buyers: new Set(b.map((t) => t.maker)).size, sellers: new Set(s.map((t) => t.maker)).size,
    vwapUsd: vw(inW), buyVwapUsd: vw(b), sellVwapUsd: vw(s),
    hoursWithTrade: new Set(inW.map((t) => Math.floor((NOW - t.ts) / H))).size, hours: ms / H,
  };
}

describe('GET /api/series/volume', () => {
  it('every window from the trades themselves: NAM, both sides, dollars at execution, distinct makers, hours with a trade; bots left out', async () => {
    at(NOW);
    const db = testD1();
    const seed = volumeSeed();
    insertTrades(db, seed);
    metrics(db, [[NOW - 20 * MIN, 'dex.volume_24h_usd_osmosis', 3], [NOW - 20 * MIN, 'dex.volume_7d_usd_osmosis', 40]]);
    const { status, body } = await call<VolumeResponse>(db, '/api/series/volume');
    expect(status).toBe(200);
    expect(body.definition).toBe(S.VOLUME_DEFINITION);
    expect(body.definition).toMatch(/not at today's price/);
    expect(body.start).toBe(Math.min(...seed.filter((t) => !t.arb && t.kind !== 'other').map((t) => t.ts)));
    for (const [w, ms] of [['h1', H], ['h6', 6 * H], ['h24', D], ['d7', 7 * D], ['d30', 30 * D]] as const) {
      const v = body.windows[w]!;
      const e = expectedVolume(seed, ms);
      expect(v, w).toMatchObject({ window: w, from: NOW - ms, to: NOW, tradersHow: 'distinct', buys: e.buys, sells: e.sells, buyers: e.buyers, sellers: e.sellers, unpriced: e.unpriced, hoursWithTrade: e.hoursWithTrade, hours: e.hours });
      for (const k of ['nam', 'buyNam', 'sellNam', 'usdPriced'] as const) expect(v[k], `${w} ${k}`).toBeCloseTo(e[k], 6);
      for (const k of ['usd', 'vwapUsd', 'buyVwapUsd', 'sellVwapUsd'] as const) {
        if (e[k] == null) expect(v[k], `${w} ${k}`).toBeNull(); else expect(v[k], `${w} ${k}`).toBeCloseTo(e[k]!, 12);
      }
    }
    expect(body.windows.d30!.unpriced).toBeGreaterThan(0);
    expect(body.windows.d30!.usd).toBeNull(); // a trade without a value: no dollar total, never a partial one passed off as whole
    expect(body.windows.h24!.usd).not.toBeNull();
    expect(body.osmosis).toMatchObject({ value: { usd24h: 3, usd7d: 40 }, prov: { source: 'Osmosis data API', at: NOW - 20 * MIN, status: 'live' } });
    expect(body.osmosisDefinition).toMatch(/counts in both/);
    expect(body.disagree).toBe(true); // ours is far from 3 dollars
  });

  it('agrees within 25%, and a window older than the record is null with the reason', async () => {
    at(NOW);
    const db = testD1();
    const seed = volumeSeed(10 * D);
    insertTrades(db, seed);
    const ours = expectedVolume(seed, D).usd!;
    metrics(db, [[NOW - 20 * MIN, 'dex.volume_24h_usd_osmosis', ours * 1.2], [NOW - 20 * MIN, 'dex.volume_7d_usd_osmosis', 40]]);
    const { body } = await call<VolumeResponse>(db, '/api/series/volume');
    expect(body.disagree).toBe(false);
    expect(body.windows.d7).not.toBeNull();
    expect(body.windows.d30).toBeNull();
    expect(body.prov.note).toContain(`Trades are recorded since ${fmtDay(body.start!)}`);
  });

  it('nothing recorded: every window null, the Osmosis figure missing with the reason', async () => {
    at(NOW);
    const { body } = await call<VolumeResponse>(testD1(), '/api/series/volume');
    expect(Object.values(body.windows).every((w) => w === null)).toBe(true);
    expect(body.start).toBeNull();
    expect(body.osmosis).toMatchObject({ value: null, prov: { status: 'missing' } });
    expect(body.prov.note).toMatch(/No trade is recorded yet/);
    expect(body.disagree).toBe(false);
  });
});

// ================================================================ pairs

const sqsPool = (id: string, type: number, counter: string, nam: number, cnt: number, liq: number, spread: number, cosmwasm = false) => ({
  chain_model: cosmwasm ? { pool_id: id, contract_address: `osmo1pool${id}` } : { id, address: `osmo1pool${id}` }, type,
  balances: [{ denom: NAM.osmoDenom, amount: String(Math.round(nam * 1e6)) }, { denom: counter, amount: String(Math.round(cnt * 1e6)) }],
  liquidity_cap: String(liq), spread_factor: String(spread),
});
const SQS = [
  sqsPool('3005', 2, OSMOSIS.usdcDenom, 606004.9, 209.66, 901, 0.002),
  sqsPool('3008', 3, 'factory/osmo1x/alloyed/allNAM', 603698.3, 33.3, 654, 0, true),
  sqsPool('3368', 0, 'uosmo', 100000, 2000, 170, 0.002),
  sqsPool('9999', 0, 'ibc/ABCDEF0123456789', 10, 1, 5, 0.003),
];
function stubSqs(answer: unknown, status = 200) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    expect(String(url)).toContain(`${OSMOSIS.sqs}/pools`);
    return new Response(JSON.stringify(answer), { status, headers: { 'content-type': 'application/json' } });
  }));
}
function seedPoolHours(db: TestD1) {
  const row = (hour: number, id: string, o: Partial<S.StoredPoolHour>) => ({ hour, pool_id: id, at: null, liquidity_usd: null, nam_reserve: null, counter_reserve: null, spread: null, volume_24h_usd_osmosis: null, volume_7d_usd_osmosis: null, liquidity_usd_osmosis: null, osmosis_at: null, ...o });
  const oAt = NOW - 25 * MIN;
  insert(db, 'pool_hourly', [
    // the hour before: other values, never served
    row(HOUR - H, '3005', { at: HOUR - H + 3000, liquidity_usd: 800, nam_reserve: 1, counter_reserve: 1, spread: 0.002, volume_24h_usd_osmosis: 99, volume_7d_usd_osmosis: 99, liquidity_usd_osmosis: 99, osmosis_at: oAt - H }),
    row(HOUR, '3005', { at: HOUR + 3000, liquidity_usd: 900, nam_reserve: 606000, counter_reserve: 209, spread: 0.002, volume_24h_usd_osmosis: 4.73, volume_7d_usd_osmosis: 420.64, liquidity_usd_osmosis: 209.66, osmosis_at: oAt }),
    row(HOUR, '3008', { at: HOUR + 3000, liquidity_usd: 650, nam_reserve: 603000, counter_reserve: 33, spread: 0 }),
    row(HOUR, '3368', { at: HOUR + 3000, liquidity_usd: 160, nam_reserve: 99000, counter_reserve: 1990, spread: 0.002, volume_24h_usd_osmosis: 6.03, volume_7d_usd_osmosis: 137.17, liquidity_usd_osmosis: 95.35, osmosis_at: oAt }),
    // listed by the Osmosis summary only (the router did not list it that hour)
    row(HOUR, '3017', { volume_24h_usd_osmosis: 0, volume_7d_usd_osmosis: 0.26, liquidity_usd_osmosis: 1.68, osmosis_at: oAt }),
    // a pool last seen long ago is not in the newest hour
    row(HOUR - 40 * D, '2000', { at: HOUR - 40 * D, liquidity_usd: 1e6, osmosis_at: HOUR - 40 * D, volume_24h_usd_osmosis: 1e6 }),
  ]);
}

describe('GET /api/series/pairs', () => {
  it('the router\'s live depth beside the Osmosis app\'s stored hour, deepest first; every missing figure says why', async () => {
    at(NOW);
    const db = testD1();
    seedPoolHours(db);
    stubSqs(SQS);
    const { status, body } = await call<PairsResponse>(db, '/api/series/pairs');
    expect(status).toBe(200);
    expect(body.pairs.map((p) => p.poolId)).toEqual(['3005', '3008', '3368', '9999', '3017']);
    const [p3005, p3008, p3368, p9999, p3017] = body.pairs;
    expect(p3005).toMatchObject({ pair: 'NAM/USDC', counterSymbol: 'USDC', type: 'concentrated', liquidityUsd: 901, namReserve: 606004.9, spreadFactor: 0.002, createdAt: null });
    expect(p3005.osmosis).toEqual({ value: { volume24hUsd: 4.73, volume7dUsd: 420.64, liquidityUsd: 209.66 }, prov: { source: 'Osmosis data API', at: NOW - 25 * MIN, status: 'live' } });
    expect(p3005.here24h.value).toBeNull();
    expect(p3005.here24h.prov.note).toMatch(/cannot be split/);
    expect(p3008).toMatchObject({ pair: 'NAM/another coin', counterSymbol: null, type: 'cosmwasm', liquidityUsd: 654 });
    expect(p3008.osmosis).toMatchObject({ value: null, prov: { status: 'missing', note: 'Osmosis does not list this pool\'s volume.' } });
    expect(p3368).toMatchObject({ pair: 'NAM/OSMO', liquidityUsd: 170 });
    expect(p9999.osmosis.prov.note).toMatch(/Not recorded yet/);
    expect(p9999.counterSymbol).toBeNull();
    // the router did not list 3017: its depth is unknown (null), never the summary's figure in its place
    expect(p3017).toMatchObject({ liquidityUsd: null, namReserve: null, type: null });
    expect(p3017.osmosis.value).toEqual({ volume24hUsd: 0, volume7dUsd: 0.26, liquidityUsd: 1.68 });
    expect(body.pairs.some((p) => p.poolId === '2000')).toBe(false);
    expect(body.prov).toMatchObject({ source: 'Osmosis SQS pools', status: 'live' });
    expect(body.osmosisProv).toMatchObject({ at: NOW - 25 * MIN, status: 'live' });
    expect(body.osmosisTotals.volume24hUsd).toBeCloseTo(4.73 + 6.03 + 0, 9);
    expect(body.osmosisTotals.volume7dUsd).toBeCloseTo(420.64 + 137.17 + 0.26, 9);
  });

  it('when the router does not answer: depth from the stored hour, marked old with the reason', async () => {
    at(NOW);
    const db = testD1();
    seedPoolHours(db);
    stubSqs({ message: 'nope' }, 400);
    const { body } = await call<PairsResponse>(db, '/api/series/pairs');
    expect(body.prov).toMatchObject({ source: 'Osmosis SQS pools (stored)', at: HOUR + 3000, status: 'stale' });
    expect(body.prov.note).toMatch(/did not answer/);
    expect(body.pairs[0]).toMatchObject({ poolId: '3005', liquidityUsd: 900, namReserve: 606000, counterSymbol: null });
    expect(body.pairs.find((p) => p.poolId === '3017')!.liquidityUsd).toBeNull();
  });

  it('nothing stored and no router: no pool, both stamps missing', async () => {
    at(NOW);
    stubSqs({}, 400);
    const { body } = await call<PairsResponse>(testD1(), '/api/series/pairs');
    expect(body.pairs).toEqual([]);
    expect(body.prov.status).toBe('missing');
    expect(body.osmosisProv.status).toBe('missing');
    expect(body.osmosisTotals).toEqual({ volume24hUsd: null, volume7dUsd: null, liquidityUsd: null });
  });
});

// ================================================================ the trades tape

/** 137 trades in groups of up to four on one millisecond, heights shared in pairs, both sides, five makers; and bots. */
function tapeSeed(): SeedTrade[] {
  const out: SeedTrade[] = [];
  const base = NOW - 10 * MIN;
  for (let i = 0; i < 137; i++) {
    const ts = base - Math.floor(i / 4) * 47_000 - (i % 4 === 3 ? 1 : 0);
    const kind = i % 5 === 0 ? 'sell' : 'buy';
    const nam = 100 + ((i * 37) % 3000);
    out.push({ id: `osmosis:${(i * 7919).toString(16).padStart(6, '0')}:swap`, ts, height: 5_000_000 - Math.floor(i / 2), kind, maker: osmo(i % 5), nam, usd: i % 23 === 7 ? null : nam * 0.001, route: i % 3 ? '3005,3368' : '3005' });
  }
  out.push({ id: 'osmosis:ffff01:swap', ts: base, height: 5_000_000, kind: 'buy', maker: osmo(1), nam: 999, usd: 1, arb: true });
  out.push({ id: 'osmosis:ffff02:swap', ts: base - 47_000, height: 4_999_998, kind: 'other', maker: osmo(2), nam: 5000, usd: 5, arb: true });
  return out;
}
const feed = (a: { ts: number; height: number; id: string }, b: { ts: number; height: number; id: string }) => b.ts - a.ts || b.height - a.height || (a.id < b.id ? 1 : -1);

/** Every page of the tape: `first` is the first page's `before` (a time jump); later pages send the cursor. */
async function walk(db: TestD1, q: string, limit: number, first: string | null = null) {
  const ids: string[] = [];
  const pages: TradesResponse[] = [];
  let before: string | null = first;
  for (let n = 0; n < 100; n++) {
    const r: { status: number; body: TradesResponse } = await call<TradesResponse>(db, `/api/series/trades?limit=${limit}${q}${before ? `&before=${before}` : ''}`);
    expect(r.status).toBe(200);
    pages.push(r.body);
    ids.push(...r.body.rows.map((x) => x.id));
    if (!r.body.next) break;
    before = r.body.next;
  }
  return { ids, pages };
}

describe('GET /api/series/trades', () => {
  it('pages through every trade exactly once in feed order, ties on one millisecond never cut; bots left out', async () => {
    at(NOW);
    const db = testD1();
    const seed = tapeSeed();
    insertTrades(db, seed);
    const want = seed.filter((t) => !t.arb && t.kind !== 'other').sort(feed).map((t) => t.id);
    for (const limit of [10, 11, 25, 100]) {
      const { ids, pages } = await walk(db, '', limit);
      expect(ids, `limit ${limit}`).toEqual(want);
      expect(pages.slice(0, -1).every((p) => p.rows.length === limit)).toBe(true);
      expect(pages[pages.length - 1].next).toBeNull();
      // the cursor is the page's last row
      const c = decodeFlowCursor(pages[0].next)!;
      expect(c.id).toBe(pages[0].rows[pages[0].rows.length - 1].id);
    }
    const head = (await call<TradesResponse>(db, '/api/series/trades')).body;
    expect(head.rows).toHaveLength(50); // the default page
    expect(head.firstTs).toBe(Math.min(...seed.filter((t) => t.kind !== 'other').map((t) => t.ts)));
    expect(head.foldMs).toBe(TRADE_FOLD_MS);
    expect(head.patternRule).toEqual({ minBuys: 20, underNam: 2000, windowMs: D });
    expect(head.prov.source).toBe('D1 flow index');
  });

  it('min, maker and a time jump narrow the rows exactly; malformed filters are refused, never ignored', async () => {
    at(NOW);
    const db = testD1();
    const seed = tapeSeed().filter((t) => !t.arb);
    insertTrades(db, seed);
    const real = seed.filter((t) => t.kind !== 'other');
    expect((await walk(db, '&min=1500', 20)).ids).toEqual(real.filter((t) => t.nam >= 1500).sort(feed).map((t) => t.id));
    expect((await walk(db, `&maker=${osmo(2)}`, 10)).ids).toEqual(real.filter((t) => t.maker === osmo(2)).sort(feed).map((t) => t.id));
    expect((await walk(db, `&maker=${osmo(2)}&min=1000`, 10)).ids).toEqual(real.filter((t) => t.maker === osmo(2) && t.nam >= 1000).sort(feed).map((t) => t.id));
    const jump = NOW - 10 * MIN - 9 * 47_000;
    expect((await walk(db, '', 30, String(jump))).ids).toEqual(real.filter((t) => t.ts < jump).sort(feed).map((t) => t.id));
    // a Namada address made no trade: nothing is read for it
    const tnam = `tnam1q${'0'.repeat(39)}`;
    const db2 = testD1(); insertTrades(db2, seed); db2.queries = 0;
    expect((await call<TradesResponse>(db2, `/api/series/trades?maker=${tnam}`)).body.rows).toEqual([]);
    for (const bad of ['maker=osmo1short', 'min=lots', 'min=-5']) {
      const r = await call<NotServedBody>(db, `/api/series/trades?${bad}`);
      expect(r.status, bad).toBe(400);
      expect(r.cache).toBe('no-store');
    }
    // an unreadable cursor is the head page (shared/paging.ts), never an error
    expect((await call<TradesResponse>(db, '/api/series/trades?before=garbage&limit=10')).body.rows[0].id).toBe(real.sort(feed)[0].id);
  });

  it('each row: its own price and how it was set, a missing price said, the maker\'s recorded trades counted', async () => {
    at(NOW);
    const db = testD1();
    const seed = tapeSeed();
    seed.push({ id: 'osmosis:aaaa01:swap', ts: NOW - MIN, height: 6_000_000, kind: 'buy', maker: osmo(7), nam: 1000, usd: 1.1, counter: 'OSMO', counterAmount: 5, price: 0.0011, meta: { trader: osmo(7), priceSource: 'swap_1h', tsSource: 'interpolated' } });
    seed.push({ id: 'osmosis:aaaa02:swap', ts: NOW - 2 * MIN, height: 5_999_999, kind: 'sell', maker: osmo(7), nam: 500, usd: null, counter: 'OSMO', counterAmount: 2, price: null });
    insertTrades(db, seed);
    insert(db, 'labels', [{ address: osmo(7), chain: 'osmosis', label: 'Some desk', category: 'watch', source: 'user', author: 'osmo1author000000000000', updated_at: 1 }]);
    const { body } = await call<TradesResponse>(db, '/api/series/trades?limit=100');
    const a = body.rows.find((r) => r.id === 'osmosis:aaaa01:swap')!;
    expect(a).toMatchObject({ kind: 'buy', nam: 1000, priceUsd: 0.0011, priceSource: 'swap_1h', valueUsd: 1.1, tsSource: 'interpolated', maker: osmo(7), makerLabelPlain: 'Some desk', makerLabelSource: 'user', makerTrades: { buys: 1, sells: 1 }, route: ['3005'], counterSymbol: 'OSMO' });
    expect(a.makerLabelAuthor).toMatch(/^osmo1author0…$/);
    const b = body.rows.find((r) => r.id === 'osmosis:aaaa02:swap')!;
    expect(b).toMatchObject({ priceUsd: null, priceSource: null, valueUsd: null, priceNote: 'No price was recorded for this trade.' });
    // a USDC trade's own price is "execution"
    const u = body.rows.find((r) => r.counterSymbol === 'USDC' && r.priceUsd != null)!;
    expect(u.priceSource).toBe('execution');
    // makerTrades: every recorded buy and sell of that maker, bots left out
    for (const r of body.rows.filter((x) => x.maker !== osmo(7))) {
      const mine = seed.filter((t) => t.maker === r.maker && !t.arb);
      expect(r.makerTrades).toEqual({ buys: mine.filter((t) => t.kind === 'buy').length, sells: mine.filter((t) => t.kind === 'sell').length });
    }
  });

  it('under Rewind no trade after the rewound time is listed or counted', async () => {
    at(NOW);
    const db = testD1();
    const seed = tapeSeed();
    insertTrades(db, seed);
    const asOf = NOW - 10 * MIN - 20 * 47_000;
    const { ids } = await walk(db, `&at=${asOf}`, 40);
    expect(ids).toEqual(seed.filter((t) => !t.arb && t.kind !== 'other' && t.ts <= asOf).sort(feed).map((t) => t.id));
    const head = (await call<TradesResponse>(db, `/api/series/trades?at=${asOf}`)).body;
    for (const r of head.rows) {
      const mine = seed.filter((t) => t.maker === r.maker && !t.arb && t.ts <= asOf);
      expect(r.makerTrades).toEqual({ buys: mine.filter((t) => t.kind === 'buy').length, sells: mine.filter((t) => t.kind === 'sell').length });
    }
  });

  it('on real trades: one maker\'s run of small buys in a shared pool folds into one row; big trades stand alone; the pattern is described', async () => {
    const fx = JSON.parse(readFileSync(new URL('./fixtures/series-trades.json', import.meta.url), 'utf8')).rows as any[];
    at(1792534262261);
    const db = testD1();
    insert(db, 'flows', fx);
    const { body } = await call<TradesResponse & { foldUnderNam: number }>(db, '/api/series/trades?limit=100');
    expect(body.rows.map((r) => r.id)).toEqual([...fx].sort((a, b) => b.ts - a.ts || b.height - a.height || (a.id < b.id ? 1 : -1)).map((r) => r.id));
    expect(body.foldUnderNam).toBe(2000);
    // groups cover every row once, in order
    expect(body.groups.flatMap((g) => g.ids)).toEqual(body.rows.map((r) => r.id));
    const byId = new Map(body.rows.map((r) => [r.id, r]));
    for (const g of body.groups) {
      const rs = g.ids.map((id) => byId.get(id)!);
      expect(g.n).toBe(rs.length);
      expect(g.nam).toBeCloseTo(rs.reduce((a, r) => a + r.nam, 0), 6);
      expect(new Set(rs.map((r) => `${r.maker}|${r.kind}`)).size).toBe(1);
      if (g.n > 1) {
        expect(rs.every((r) => r.nam < 2000)).toBe(true);
        expect(rs.slice(1).every((r, i) => rs[i].ts - r.ts <= TRADE_FOLD_MS)).toBe(true);
        const shared = rs.reduce<string[]>((acc, r) => acc.filter((p) => r.route.includes(p)), rs[0].route);
        expect(shared.length).toBeGreaterThan(0);
      }
      expect(g.lastTs).toBe(rs[0].ts);
      expect(g.firstTs).toBe(rs[rs.length - 1].ts);
      const priced = rs.filter((r) => r.valueUsd != null);
      expect(g.avgPriceUsd).toBeCloseTo(priced.reduce((a, r) => a + r.valueUsd!, 0) / priced.reduce((a, r) => a + r.nam, 0), 12);
    }
    // the busiest maker's 18 buys within 16 minutes, six routes, all through pool 3005: two runs (a 10.5-minute pause)
    const bot = 'osmo1vkyae7qe2xqtp3u00t32jg0d4wzcs8c60mlrl4';
    const burst = body.groups.filter((g) => g.maker === bot && g.firstTs >= 1792442086758 && g.lastTs <= 1792443025356);
    expect(burst.map((g) => g.n)).toEqual([8, 10]);
    expect(new Set(burst.flatMap((g) => g.ids).map((id) => byId.get(id)!.route.join(','))).size).toBe(6);
    // a sale of 2,000 NAM or more is never folded
    for (const r of body.rows.filter((x) => x.nam >= 2000)) expect(body.groups.find((g) => g.ids.includes(r.id))!.n).toBe(1);
    // the pattern: 20 or more buys under 2,000 NAM by that maker in the 24 h up to the trade (counted here from the fixture)
    for (const r of body.rows) {
      const n = fx.filter((f) => f.kind === 'buy' && f.to_addr === r.maker && f.amount_num < 2000 && f.ts >= r.ts - D && f.ts <= r.ts).length;
      expect(r.pattern, r.id).toBe(n >= 20 ? 'repeated_small_buys' : null);
    }
    expect(body.rows.some((r) => r.pattern === 'repeated_small_buys')).toBe(true);
  });

  it('nothing recorded: no rows, no cursor, no start', async () => {
    at(NOW);
    const { body } = await call<TradesResponse>(testD1(), '/api/series/trades');
    expect(body).toMatchObject({ rows: [], groups: [], next: null, firstTs: null });
  });
});

// ================================================================ values

describe('GET /api/series/values', () => {
  const seedValues = (db: TestD1, osmoAt: number | null = NOW - 30_000) => metrics(db, [
    [NOW - 30_000, 'price.usd', 0.0011664], [NOW - 30_000, 'supply.total', 1_147_657_323], [NOW - 30_000, 'supply.liquid', 645_713_820],
    ...(osmoAt != null ? [[osmoAt, 'supply.osmosis', 19_757_918] as [number, string, number]] : []),
    [NOW - 2 * D, 'price.usd', 0.0009],
  ]);

  it('all NAM and spendable NAM at today\'s price, each with its definition and inputs; never called market cap', async () => {
    at(NOW);
    const db = testD1();
    seedValues(db);
    const { status, body } = await call<ValuesResponse>(db, '/api/series/values');
    expect(status).toBe(200);
    expect(body.fdv.value).toBeCloseTo(1_147_657_323 * 0.0011664, 6);
    expect(body.spendable.value).toBeCloseTo((645_713_820 + 19_757_918) * 0.0011664, 6);
    expect(body.fdv.prov).toEqual({ source: 'derived', at: NOW - 30_000, status: 'live' });
    expect(body.spendable.inputs.map((i) => i.name)).toEqual(['NAM in ordinary accounts on Namada', 'NAM on Osmosis', 'Quoted price (dollars per NAM)']);
    for (const f of [body.fdv, body.spendable]) {
      expect(`${f.label} ${f.definition}`).not.toMatch(/market cap|marketcap/i);
      expect(f.definition).not.toMatch(/\d/);
    }
    expect(body.fdv.label).toBe('All NAM at today’s price');
    expect(body.spendable.label).toBe('Spendable NAM at today’s price');
  });

  it('an old input makes the figure old; a missing one leaves it unshown with the reason', async () => {
    at(NOW);
    const db = testD1();
    seedValues(db, NOW - 20 * MIN);
    const old = (await call<ValuesResponse>(db, '/api/series/values')).body;
    expect(old.spendable.prov).toMatchObject({ status: 'stale', at: NOW - 20 * MIN });
    expect(old.fdv.prov.status).toBe('live');
    const db2 = testD1();
    seedValues(db2, null);
    const none = (await call<ValuesResponse>(db2, '/api/series/values')).body;
    expect(none.spendable).toMatchObject({ value: null, prov: { status: 'missing', note: 'NAM on Osmosis is not recorded yet, so this figure is not shown.' } });
    expect(none.fdv.value).not.toBeNull();
    // Rewound: the readings as of then
    const back = (await call<ValuesResponse>(db, `/api/series/values?at=${NOW - D}`)).body;
    expect(back.fdv.value).toBeNull();
    expect(back.fdv.prov.note).toMatch(/at that time/);
  });
});

// ================================================================ the routes, the cache key, the plans

describe('the mount, the parameters and the edge cache key', () => {
  it('an unknown path under the mount is a 404 in the NotServedBody shape; the other routes are unaffected', async () => {
    const r = await call<NotServedBody>(testD1(), '/api/series/nope');
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'This figure is not served yet.', reason: 'No such series route.', endpoint: '/api/series/nope' });
    expect(r.cache).toBe('no-store');
    expect((await call(testD1(), '/api/alerts/rules')).status).toBe(200);
  });

  it('every parameter a route reads is listed in SERIES_PARAMS and read only through params(); a cached route lists them in CACHE_PARAMS', () => {
    const src = readFileSync(join(__dirname, '..', 'worker', 'src', 'api-series.ts'), 'utf8');
    // c.req.query appears once, inside params()
    expect([...src.matchAll(/c\.req\.query\(/g)]).toHaveLength(1);
    expect(src).toMatch(/function params<R extends Route>[\s\S]*?c\.req\.query\(k\)/);
    const used = [...src.matchAll(/params\(c, '([^']+)'\)/g)].map((m) => m[1]);
    expect(new Set(used)).toEqual(new Set(Object.keys(SERIES_PARAMS)));
    const mounted = [...src.matchAll(/seriesApp\.get\('([^']+)'/g)].map((m) => `/api/series${m[1] === '/' ? '' : m[1]}`);
    expect(new Set(mounted)).toEqual(new Set(Object.keys(SERIES_PARAMS)));
    for (const [route, ps] of Object.entries(SERIES_PARAMS)) {
      if (!CACHEABLE_API.test(route)) continue; // not cached at the edge yet (worker/src/http.ts)
      for (const p of ps) expect(CACHE_PARAMS[route], `${route} reads ?${p}`).toContain(p);
    }
  });
});

describe('query plans: every statement the routes run', () => {
  const nParams = (sql: string) => { const nums = [...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1])); return nums.length ? Math.max(...nums) : (sql.match(/\?/g) ?? []).length; };
  const plan = (db: TestD1, sql: string) => all(db, `EXPLAIN QUERY PLAN ${sql}`, ...Array.from({ length: nParams(sql) }, () => 1)).map((r) => r.detail).join(' | ');
  const statements: [string, string][] = [
    ['rangeSql(1)', S.rangeSql(1)], ['rangeSql(3)', S.rangeSql(3)], ['rangeSql(5)', S.rangeSql(5)], ['START_SQL', S.START_SQL],
    ['CHANGES_NOW_SQL', S.CHANGES_NOW_SQL], ['firstAtOrAfterSql(8)', S.firstAtOrAfterSql(8)],
    ['VOLUME_ROWS_SQL', S.VOLUME_ROWS_SQL], ['VOLUME_META_SQL', S.VOLUME_META_SQL], ['PAIRS_STORED_SQL', S.PAIRS_STORED_SQL],
    ...(['buy', 'sell'] as const).flatMap((k) => [false, true].flatMap((maker) => [false, true].flatMap((min) => [false, true].map((tie): [string, string] => [`tradesSql(${k}, maker ${maker}, min ${min}, tie ${tie})`, S.tradesSql(k, { maker, min, tie })])))),
    ['makerCountSql(buy, 3)', S.makerCountSql('buy', 3)], ['makerCountSql(sell, 3)', S.makerCountSql('sell', 3)], ['smallBuysSql(3)', S.smallBuysSql(3)],
    ['TRADES_START_SQL', S.TRADES_START_SQL], ['VALUES_SQL', S.VALUES_SQL], ['POOL_RANGE_SQL', S.POOL_RANGE_SQL], ['POOL_START_SQL', S.POOL_START_SQL],
  ];

  it('each is a SEARCH on an index or primary key: no temporary B-tree, no SCAN of a table', () => {
    const db = testD1();
    for (const [name, sql] of statements) {
      const p = plan(db, sql);
      expect(p, name).toMatch(/SEARCH/);
      expect(p, name).not.toMatch(/TEMP B-TREE/);
      expect(p, name).not.toMatch(/\bSCAN (flows|f|metrics|holders|balance_spans|pool_hourly|p|labels|l|kv|stakes)\b(?! USING)/);
    }
    // the trades read uses the index it names, in its order (no sort): the one the planner would not pick alone
    expect(plan(db, S.tradesSql('buy', { maker: false, min: false, tie: false }))).toMatch(/SEARCH f USING INDEX flows_kind \(kind=\? AND ts<\?\)/);
    expect(plan(db, S.tradesSql('buy', { maker: true, min: true, tie: false }))).toMatch(/SEARCH f USING INDEX flows_to \(to_addr=\? AND ts<\?\)/);
    expect(plan(db, S.tradesSql('sell', { maker: true, min: false, tie: true }))).toMatch(/SEARCH f USING INDEX flows_from \(from_addr=\? AND ts=\?\)/);
    expect(plan(db, S.rangeSql(3))).toMatch(/SEARCH metrics USING INDEX sqlite_autoindex_metrics_1 \(key=\? AND ts>\? AND ts<\?\)/);
    expect(plan(db, S.PAIRS_STORED_SQL)).toMatch(/SEARCH p USING INDEX sqlite_autoindex_pool_hourly_1 \(pool_id=\? AND hour=\?\)/);
    expect(plan(db, S.POOL_RANGE_SQL)).toMatch(/SEARCH pool_hourly USING INDEX sqlite_autoindex_pool_hourly_1 \(pool_id=\? AND hour>\? AND hour<\?\)/);
  });

  it('how many statements each route sends (one round trip each, run side by side)', async () => {
    at(NOW);
    const db = testD1();
    insertTrades(db, tapeSeed());
    seedQuoted(db);
    const count = async (path: string) => { db.queries = 0; await call(db, path); return db.queries; };
    expect(await count('/api/series?key=price.usd')).toBe(3); // range, tail, start
    expect(await count(`/api/series?key=price.usd&step=1m&from=${NOW - H}`)).toBe(2);
    expect(await count('/api/series/changes')).toBe(3); // the two price reads and price.how, side by side
    expect(await count('/api/series/volume')).toBe(4); // two sides, meta, coverage
    expect(await count('/api/series/values')).toBe(1);
    // head page: 2 sides (+1 each for the last millisecond whole), start, coverage, 2 maker counts, small buys
    expect(await count('/api/series/trades?limit=10')).toBe(9);
  });
});

describe('fold and pattern rules on their own', () => {
  const row = (o: Partial<TradeRow>): TradeRow => ({ id: 'x', ts: 0, height: 1, tsSource: null, kind: 'buy', nam: 100, counterSymbol: 'USDC', counterAmount: 0.1, priceUsd: 0.001, priceSource: 'execution', valueUsd: 0.1, maker: osmo(1), makerLabelPlain: null, makerTrades: null, route: ['3005'], txHash: 'h', pattern: null, ...o });

  it('a run breaks on another maker, the other side, a pause over 10 minutes, a trade of 2,000 NAM or more, or no shared pool', () => {
    const t0 = NOW;
    const rows = [
      row({ id: 'a', ts: t0 }), row({ id: 'b', ts: t0 - MIN, route: ['3005', '3368'] }), row({ id: 'c', ts: t0 - 2 * MIN, route: ['3368'] }), // c: shares no pool with {3005}
      row({ id: 'd', ts: t0 - 3 * MIN, route: ['3368'] }),
      row({ id: 'e', ts: t0 - 4 * MIN, route: ['3368'], maker: osmo(2) }),
      row({ id: 'f', ts: t0 - 5 * MIN, route: ['3368'], kind: 'sell' }),
      row({ id: 'g', ts: t0 - 6 * MIN, route: ['3368'], kind: 'sell' }),
      row({ id: 'h', ts: t0 - 6 * MIN - TRADE_FOLD_MS - 1, route: ['3368'], kind: 'sell' }),
      row({ id: 'i', ts: t0 - 30 * MIN, route: ['3368'], kind: 'sell', nam: 2000 }),
      row({ id: 'j', ts: t0 - 31 * MIN, route: ['3368'], kind: 'sell', valueUsd: null, priceUsd: null }),
      row({ id: 'k', ts: t0 - 32 * MIN, route: ['3368'], kind: 'sell', valueUsd: 0.3, nam: 200 }),
    ];
    const g = S.foldTrades(rows);
    expect(g.map((x) => x.ids)).toEqual([['a', 'b'], ['c', 'd'], ['e'], ['f', 'g'], ['h'], ['i'], ['j', 'k']]);
    expect(g[6]).toMatchObject({ n: 2, nam: 300, usd: 0.3, unpriced: 1, avgPriceUsd: 0.3 / 200 });
    expect(g[2].avgPriceUsd).toBeCloseTo(0.001, 12);
  });

  it('the pattern counts the maker\'s small buys in the 24 hours up to and including the trade', () => {
    const buys = Array.from({ length: 20 }, (_, i) => NOW - i * H);
    const p = S.patternsOf([row({ ts: NOW }), row({ ts: NOW - H }), row({ ts: NOW, maker: osmo(3) })], new Map([[osmo(1), buys]]));
    expect(p).toEqual(['repeated_small_buys', null, null]);
  });
});
