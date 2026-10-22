// /api/metrics/history reads a bounded number of rows whatever a key's age (security review, 2026-10-22). A minute key at a bucket of an hour or more
// is read from its hourly rollups (series.ts rollupStmts) plus the minute readings the hourly job may not have
// rolled yet; a key /api/series does not serve, and an `hours` or `at` in a spelling the app never sends, is refused
// before any D1 read. The app's own requests (web/src/api.ts fetchMetricSeries) answer as before.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { app } from '../worker/src/api';
import { metricSeries } from '../worker/src/analytics';
import { testD1, type TestD1 } from './d1-sqlite';

const H = 3_600_000, D = 86_400_000, MIN = 60_000;
/** 16:30:07 UTC on 22 Oct 2026: the hourly job has rolled up to 14:00; 15:00 is closed but not rolled yet. */
const NOW = Date.UTC(2026, 9, 22, 16, 30, 7);
const HOUR = Math.floor(NOW / H) * H;
const ROLLED_BEFORE = HOUR - H;

afterEach(() => { vi.useRealTimers(); });
const clock = () => vi.useFakeTimers({ now: NOW, toFake: ['Date'] });

type Reading = [ts: number, value: number];
/** `count` minute readings of `key` ending `endsAt`, and the hourly job's rollups of each hour before ROLLED_BEFORE. */
function seed(db: TestD1, key: string, count: number, endsAt = NOW, base = 0.001): Reading[] {
  const rows: Reading[] = [];
  for (let i = count - 1; i >= 0; i--) rows.push([endsAt - i * MIN, base * (1 + ((i * 7919) % 1000) / 10_000)]);
  const byHour = new Map<number, Reading[]>();
  for (const r of rows) { const h = Math.floor(r[0] / H) * H; (byHour.get(h) ?? byHour.set(h, []).get(h)!).push(r); }
  db.raw.exec('BEGIN');
  const st = db.raw.prepare('INSERT INTO metrics (ts, key, value) VALUES (?, ?, ?)');
  for (const [ts, v] of rows) st.run(ts, key, v);
  for (const [h, rs] of byHour) {
    if (h >= ROLLED_BEFORE) continue;
    const vs = rs.map((r) => r[1]);
    st.run(h, `${key}.1h`, rs[rs.length - 1][1]);
    st.run(h, `${key}.1h.lo`, Math.min(...vs));
    st.run(h, `${key}.1h.hi`, Math.max(...vs));
  }
  db.raw.exec('COMMIT');
  return rows;
}

/** The D1 stand-in, noting each statement's text and the rows it hands back. */
function counted(db: TestD1) {
  const log: { sql: string; rows: number }[] = [];
  const wrap = (sql: string, s: any): any => ({
    bind: (...p: unknown[]) => wrap(sql, s.bind(...p)),
    all: async () => { const r = await s.all(); log.push({ sql, rows: r.results.length }); return r; },
    first: async (c?: string) => { const r = await s.first(c); log.push({ sql, rows: r == null ? 0 : 1 }); return r; },
    run: () => s.run(),
  });
  return { env: { DB: { prepare: (sql: string) => wrap(sql, db.prepare(sql)), batch: (x: any) => db.batch(x) } } as any, log };
}
const get = async (env: any, path: string) => {
  const res = await app.request(path, {}, env);
  return { status: res.status, body: (await res.json()) as any };
};
const metricsReads = (log: { sql: string; rows: number }[]) => log.filter((l) => /\bFROM metrics\b/.test(l.sql));
/** A statement that aggregates metrics rows in SQL reads more rows than it hands back; a plain range reads what it returns. */
const AGGREGATES = /\b(COUNT|MIN|MAX|SUM|AVG)\s*\(|GROUP BY/i;

describe('a metric history reads a bounded number of rows whatever the key\'s age', () => {
  it('100,000 minute readings over 28,800 hours (the app\'s All): rollups and at most 240 minute rows are read, none aggregated in SQL', async () => {
    clock();
    const db = testD1();
    const rows = seed(db, 'price.usd', 100_000);
    const { env, log } = counted(db);
    const r = await get(env, '/api/metrics/history?key=price.usd&hours=28800');
    expect(r.status).toBe(200);
    expect(r.body.bucketMs).toBe(D);

    // the answer: one point per UTC day, the day's last reading with its value, lowest and highest
    const days = new Map<number, Reading[]>();
    for (const x of rows) { const b = Math.floor(x[0] / D); (days.get(b) ?? days.set(b, []).get(b)!).push(x); }
    expect(r.body.history).toHaveLength(days.size);
    const ds = [...days.values()];
    r.body.history.forEach((p: any, i: number) => {
      const day = ds[i], last = day[day.length - 1], vs = day.map((x) => x[1]);
      expect(p.value).toBe(last[1]);
      expect(p.lo).toBe(Math.min(...vs));
      expect(p.hi).toBe(Math.max(...vs));
      // a rolled-up hour is labelled with its start (as /api/series labels it); an hour not rolled yet with its reading
      expect(p.ts).toBeGreaterThanOrEqual(Math.floor(last[0] / H) * H);
      expect(p.ts).toBeLessThanOrEqual(last[0]);
    });
    expect(r.body.history.at(-1)).toMatchObject({ ts: NOW, value: rows.at(-1)![1] });
    // what the route aggregated before: every reading (n adds up to 100,000)
    expect(r.body.history.reduce((a: number, p: any) => a + (p.n ?? 0), 0)).toBeLessThanOrEqual(240);

    // what it read: plain ranges only, 3 rows per rolled hour and the minute readings of the last hours
    const reads = metricsReads(log);
    for (const l of reads) expect(l.sql, l.sql).not.toMatch(AGGREGATES);
    const rolledHours = new Set(rows.map((x) => Math.floor(x[0] / H) * H).filter((h) => h < ROLLED_BEFORE)).size;
    expect(reads.reduce((a, l) => a + l.rows, 0)).toBeLessThanOrEqual(3 * rolledHours + 240);

    // and the answer does not depend on minute readings the rollups cover: deleting them changes nothing
    db.raw.prepare("DELETE FROM metrics WHERE key = 'price.usd' AND ts < ?").run(HOUR - 2 * H);
    expect((await get({ DB: db }, '/api/metrics/history?key=price.usd&hours=28800')).body).toEqual(r.body);
  });

  it('the app\'s own requests answer as before: same buckets, values, lows and highs', async () => {
    clock();
    const db = testD1();
    seed(db, 'price.usd', 50_000);
    seed(db, 'supply.total_stake', 40_000, NOW, 450_000_000);
    // staked NAM before supply.total_stake was recorded: stitched in from supply.pos_bonded
    seed(db, 'supply.pos_bonded', 3 * 1440, NOW - 40_000 * MIN, 300_000_000);
    db.raw.prepare("DELETE FROM metrics WHERE key LIKE 'supply.pos_bonded.1h%'").run();
    // the executed price: an hourly key, one row an hour with a trade
    db.raw.exec('BEGIN');
    for (let i = 1; i < 700; i += 3) db.raw.prepare("INSERT INTO metrics (ts, key, value) VALUES (?, 'price.swap_1h', ?)").run(HOUR - i * H, 0.001 + i * 1e-7);
    db.raw.exec('COMMIT');

    // the Trade page's history fallback and the Supply page's staked NAM (web/src/screens/trade/data.ts, supply/Unlocks.tsx)
    for (const [key, hours] of [['price.usd', 720], ['price.usd', 2160], ['price.usd', 28800], ['supply.total_stake', 720], ['supply.total_stake', 2160], ['supply.total_stake', 8760], ['supply.total_stake', 28800]] as const) {
      const r = await get({ DB: db }, `/api/metrics/history?key=${key}&hours=${hours}&at=${NOW - 5 * MIN}`);
      expect(r.status, `${key} ${hours}`).toBe(200);
      const asOf = NOW - 5 * MIN, from = asOf - hours * H, bucket = r.body.bucketMs;
      // reference: every minute reading of the window, as the route read it before
      let ref = await metricSeries(db as any, key, from, asOf, bucket);
      if (key === 'supply.total_stake' && hours > 24 * 14) {
        const first = r.body.history.find((p: any) => p.value >= 450_000_000)!.ts;
        ref = [...(await metricSeries(db as any, 'supply.pos_bonded', from, first - 1, bucket)).filter((p) => p.ts < first), ...ref.filter((p) => p.ts >= Math.floor(first / bucket) * bucket)];
      }
      expect(r.body.history.map((p: any) => [p.value, p.lo, p.hi]), `${key} ${hours}`).toEqual(ref.map((p) => [p.value, p.lo, p.hi]));
      r.body.history.forEach((p: any, i: number) => {
        expect(p.ts).toBeGreaterThanOrEqual(Math.floor(ref[i].ts / H) * H);
        expect(p.ts).toBeLessThanOrEqual(ref[i].ts);
      });
      // nothing after the rewound time
      expect(Math.max(...r.body.history.map((p: any) => p.ts))).toBeLessThanOrEqual(asOf);
    }
    // the home page's 30-day sparkline: an hourly key, read exactly as before
    const spark = await get({ DB: db }, '/api/metrics/history?key=price.swap_1h&hours=720');
    expect(spark.body.history).toEqual(await metricSeries(db as any, 'price.swap_1h', NOW - 720 * H, NOW, H));
  });

  it('keys it does not serve and spellings the app never sends are refused before any D1 read', async () => {
    clock();
    const db = testD1();
    const { env, log } = counted(db);
    for (const q of ['key=supply.pos_bonded&hours=28800', 'key=price.pool_1h&hours=28800', 'key=dex.swaps_1h.nam', 'key=supply.masp_shielded', 'key=epoch', 'key=constructor', 'key=__proto__', 'key=price.usd.1h']) {
      expect((await get(env, `/api/metrics/history?${q}`)).status, q).toBe(404);
    }
    for (const q of ['hours=0720', 'hours=720.0', 'hours=720abc', 'hours=%20720', 'hours=-1', 'hours=0', 'hours=28801', 'hours=1e3',
      'hours=720&at=1.7e12', 'hours=720&at=0x10', `hours=720&at=0${NOW - H}`, `hours=720&at=${NOW - H}.0`, 'hours=720&at=']) {
      expect((await get(env, `/api/metrics/history?key=price.usd&${q}`)).status, q).toBe(400);
    }
    expect(log).toEqual([]);
    // what the app sends is served
    for (const q of ['key=price.swap_1h&hours=720', `key=supply.total_stake&hours=28800&at=${NOW - H}`, 'key=price.usd', '']) {
      expect((await get({ DB: db }, `/api/metrics/history?${q}`)).status, q).toBe(200);
    }
  });
});
