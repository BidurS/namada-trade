// Depth, step S7: the daily digest's two depth lines (depth plan section 6) from depth_hourly, the store row's ok flip
// reaching the health log the operator embed reads (plan section 7), and the depth_budget check on the Sources sheet.
// Every row is seeded; nothing is fetched. The digest's worked example of 2026-10-23 predates the store, so the hours
// here are made for that day with figures of the fixtures' shape (10,000 NAM fetching about $9.92).
import { describe, expect, it } from 'vitest';
import { testD1, insert, type TestD1 } from './d1-sqlite';
import { seedCharts, seedSurvey, T } from './digest-survey';
import { figures } from './fixtures/digest-2026-10-23';
import { collectDigestReads, digestWindow, isNotRead, shapeDigestFigures, SOURCES, DEPTH_HOUR_NOT_STORED, type Depth } from '../worker/src/digest/figures';
import { toMessageFigures, readAndBuildDigest } from '../worker/src/digest/build';
import { buildDigest, MARK_ORDER, type Embed } from '../worker/src/digest/message';
import { readOperatorFigures } from '../worker/src/digest/operator';
import { HOURLY_BOUND_MS } from '../worker/src/digest/freshness';
import { SQL } from '../worker/src/digest/sql';
import type { Prepared } from '../worker/src/digest/waves';
import { mergeHealth, appendHealthLog } from '../worker/src/cron';
import { kvGetJson } from '../worker/src/db';
import { DEPTH_CAPS, NAM_DEPTH } from '../worker/src/depth/config';
import { AGGREGATE_POOL_ID } from '../worker/src/depth/sql';
import { freshBudget, storeHealth, budgetCheckStmt, STORE_HEALTH } from '../worker/src/depth/budget';
import { DEPTH_OFFSETS_PCT, DEPTH_QUOTABLE_SIZE, DEPTH_SIZES, OFFSET_10_INDEX } from '../shared/depth';
import { CHECK_TITLES, checkDetail } from '../web/src/lib/prov';
import { BANNED } from './banned-words';
import type { Env } from '../worker/src/util';

const H = 3_600_000, MIN = 60_000;
const field = (e: Embed, name: string): string => {
  const f = e.fields?.find((x) => x.name === name);
  if (!f) throw new Error(`no field ${name}`);
  return f.value;
};
const sources = (e: Embed): string[] => (e.fields ?? []).filter((f) => f.name.startsWith('Sources')).flatMap((f) => f.value.split(' · '));
const value = <V>(f: { value: V } | { notRead: true }): V => { if ('notRead' in f) throw new Error('not read'); return f.value; };

/** An aggregate hourly row: the hour's last minute at :59, selling 10,000 NAM fetching `sell`, bids within 10 % `bid`. */
const hourRow = (hour: number, sell: number | null, bid: number | null, over: Record<string, unknown> = {}) => ({
  hour, pool_id: AGGREGATE_POOL_ID, at: hour + 59 * MIN, height: 1_234_567 + (hour - T) / MIN, ref_usd: 0.00102, spot_usd: null,
  sell_10k: sell, bid_10: bid, sell_10k_lo: sell == null ? null : sell - 0.12, sell_10k_hi: sell == null ? null : sell + 0.09, n: 60, note: null, ...over,
});
/** The window's 24 hours to the one that closed before T (07:00, its last minute 07:59). */
const seedDay = (db: TestD1, over: (hour: number) => Record<string, unknown> = () => ({})) =>
  insert(db, 'depth_hourly', Array.from({ length: 24 }, (_, i) => { const hour = T - (24 - i) * H; return hourRow(hour, 9.92 - (23 - i) * 0.001, 507.29, over(hour)); }));

describe('the two depth lines of the price-and-trades section', () => {
  it('the newest closed hour of the aggregate row: what 10,000 NAM fetched with the window\'s lowest and highest, and the USD of bids within 10 %', async () => {
    const db = testD1();
    seedDay(db);
    const log: Prepared[] = [];
    const win = digestWindow(T, 'daily');
    const f = shapeDigestFigures(await collectDigestReads(db, win, log), win);
    const d = value(f.depth) as Depth;
    expect(d.sizeNam).toBe(10_000);
    expect(d.withinPct).toBe(10);
    const sell = value(d.sell);
    expect(sell.usd).toBeCloseTo(9.92, 6);
    expect(sell.hour).toBe(T - H);
    expect(sell.at).toBe(T - MIN);
    expect(sell.height).toBe(1_234_567 - 60);
    // the window's extremes are the hours' own lowest and highest, over the 24 hours that have a row
    expect(sell.window).toEqual({ lo: expect.closeTo(9.92 - 0.023 - 0.12, 6), hi: expect.closeTo(9.92 + 0.09, 6), hours: 24, stored: 24 });
    expect(value(d.bids)).toEqual({ usd: 507.29, hour: T - H, at: T - MIN, height: 1_234_567 - 60 });
    if (isNotRead(f.depth)) throw new Error('not read');
    expect(f.depth.stamp).toMatchObject({ source: SOURCES.depthStore, at: T - MIN, height: 1_234_567 - 60, status: 'live' });
    // both statements are one seek or range on the primary key (pool_id, hour): no scan, no sort
    const plans = log.filter((s) => /depth_hourly/.test(s.sql)).map((s) => (db.raw.prepare(`EXPLAIN QUERY PLAN ${s.sql}`).all(...s.params) as { detail: string }[]).map((p) => p.detail).join(' | '));
    expect(plans).toHaveLength(2);
    for (const p of plans) {
      expect(p).toMatch(/SEARCH depth_hourly USING INDEX sqlite_autoindex_depth_hourly_1 \(pool_id=\? AND hour[<>]/);
      expect(p).not.toMatch(/SCAN|TEMP B-TREE/);
    }
  });

  it('the column the line reads is the quotable size\'s and the offset is the 10 % one, by the configuration and not by a typed figure', () => {
    expect(NAM_DEPTH.quotableSize).toBe(10_000);
    expect(DEPTH_QUOTABLE_SIZE).toBe(DEPTH_SIZES[1]);
    expect(SQL.depthHour).toContain('sell_10k');
    expect(SQL.depthDay).toContain('sell_10k_lo');
    expect(DEPTH_OFFSETS_PCT[OFFSET_10_INDEX]).toBe(10);
    expect(SQL.depthHour).toContain('bid_10');
  });

  it('a window with hours that carry no figure (the reference pool not read): the lowest and highest are over the hours that do, and the line says how many of the stored hours', async () => {
    const db = testD1();
    // the ten oldest hours of the window have no sell figure; the newest hour and the thirteen before it do
    seedDay(db, (hour) => (hour < T - 14 * H ? { sell_10k: null, sell_10k_lo: null, sell_10k_hi: null, note: 'reference pool not read: 429' } : {}));
    const win = digestWindow(T, 'daily');
    const f = shapeDigestFigures(await collectDigestReads(db, win), win);
    const sell = value(value(f.depth).sell);
    // the lowest of the fourteen hours with a figure (the oldest of them, hour T - 14 H, sells at 9.92 - 0.013), not of the ten without one
    expect(sell.window).toEqual({ lo: expect.closeTo(9.92 - 0.013 - 0.12, 6), hi: expect.closeTo(9.92 + 0.09, 6), hours: 14, stored: 24 });
    const t = field(buildDigest(toMessageFigures(f, {}), T, 'daily').shared, 'Trades');
    expect(t).toMatch(/Selling 10,000 NAM across every pool fetched \$9\.92 at 07:59 UTC \(lowest \$9\.79, highest \$10\.01 over 14 of the 24 h's 24 stored hours\) [¹²³⁴⁵⁶⁷⁸⁹⁰]+\./);
    // every hour without a figure: no range at all, never a count of hours the extremes were not taken over
    const bare = testD1();
    seedDay(bare, () => ({ sell_10k_lo: null, sell_10k_hi: null }));
    const g = shapeDigestFigures(await collectDigestReads(bare, win), win);
    expect(value(value(g.depth).sell).window).toBeNull();
    expect(field(buildDigest(toMessageFigures(g, {}), T, 'daily').shared, 'Trades')).toMatch(/fetched \$9\.92 at 07:59 UTC [¹²³⁴⁵⁶⁷⁸⁹⁰]+\./);
  });

  it('the hour with no figure for one line: that line is not read with the row\'s note, the other is read', async () => {
    const db = testD1();
    seedDay(db, (hour) => (hour === T - H ? { sell_10k: null, sell_10k_lo: null, sell_10k_hi: null, note: 'reference pool not read: 429' } : {}));
    const win = digestWindow(T, 'daily');
    const f = shapeDigestFigures(await collectDigestReads(db, win), win);
    const d = value(f.depth) as Depth;
    expect(d.sell).toMatchObject({ notRead: true, source: SOURCES.depthStore, lastAt: T - MIN, reason: "the hour's row carries no figure for it (reference pool not read: 429)" });
    expect(value(d.bids).usd).toBe(507.29);
    const e = buildDigest(toMessageFigures(f, {}), T, 'daily').shared;
    const t = field(e, 'Trades');
    expect(t).toContain("Selling 10,000 NAM across every pool: not read — this site's depth store (every Osmosis pool holding NAM, read by the minute) last answered 07:59 UTC, 1 min ago (the hour's row carries no figure for it (reference pool not read: 429)); the figure is not shown.");
    // the mark's number follows the sources the day used (sixteen on an empty store, eighteen on the survey's rows below)
    expect(t).toMatch(/USD of bids within 10 % of the price: \$507\.29 at 07:59 UTC [¹²³⁴⁵⁶⁷⁸⁹⁰]+\./);
  });

  it('no hour stored: one not-read line, no figure; an hour older than its bound: not read with the hour\'s time', async () => {
    const empty = testD1();
    const win = digestWindow(T, 'daily');
    const none = shapeDigestFigures(await collectDigestReads(empty, win), win);
    const d = value(none.depth) as Depth;
    expect(d.sell).toMatchObject({ notRead: true, lastAt: null, reason: DEPTH_HOUR_NOT_STORED });
    expect(d.bids).toMatchObject({ notRead: true, lastAt: null, reason: DEPTH_HOUR_NOT_STORED });
    const e = buildDigest(toMessageFigures(none, {}), T, 'daily').shared;
    expect(field(e, 'Trades')).toContain("Depth: not read — no hour of this site's depth store is on record yet.");
    // nothing was read, so no Sources entry: the line names the store itself
    expect(sources(e).some((x) => /depth store/.test(x))).toBe(false);

    const old = testD1();
    insert(old, 'depth_hourly', [hourRow(T - HOURLY_BOUND_MS - H, 9.9, 500)]);
    const stale = shapeDigestFigures(await collectDigestReads(old, win), win);
    const s = value(stale.depth) as Depth;
    expect(s.sell).toMatchObject({ notRead: true, lastAt: T - HOURLY_BOUND_MS - MIN, reason: 'last answered 04:59 UTC, 3 h 1 min ago; the figure is not shown' });
    expect(field(buildDigest(toMessageFigures(stale, {}), T, 'daily').shared, 'Trades')).toContain('Depth: not read — this site\'s depth store (every Osmosis pool holding NAM, read by the minute) last answered 04:59 UTC, 3 h 1 min ago');
  });

  it('on the survey\'s rows with a day of hours: the two lines in the Trades field, each with the store\'s mark, the mark after the seventeen of section 7.1', async () => {
    const db = testD1();
    seedSurvey(db);
    seedCharts(db);
    seedDay(db);
    const b = await readAndBuildDigest(db, T, 'daily');
    const e = b.parts.body.shared;
    const t = field(e, 'Trades');
    expect(t).toContain("Selling 10,000 NAM across every pool fetched $9.92 at 07:59 UTC (lowest $9.78, highest $10.01 over the 24 h's 24 stored hours) ¹⁸.");
    expect(t).toContain('USD of bids within 10 % of the price: $507.29 at 07:59 UTC ¹⁸.');
    const s = sources(e);
    expect(s).toHaveLength(18);
    expect(s[17]).toBe(`¹⁸ ${SOURCES.depthStore}, hour to 07:59 UTC, block 1,234,507`);
    expect(SOURCES.depthStore).toBe("this site's depth store (every Osmosis pool holding NAM, read by the minute)");
    expect(MARK_ORDER.at(-1)).toBe('depthStore');
    for (const line of [...t.split('. ').filter((x) => /depth store|every pool|USD of bids/.test(x)), s[17]]) expect(line).not.toMatch(BANNED);
  });

  it('the weekly names its window; a figures set from before the store (no depth) prints nothing', () => {
    const fx = figures();
    expect(field(buildDigest(fx, T, 'daily').shared, 'Trades')).not.toContain('Depth');
    const withDepth = { ...fx, depth: { value: { sizeNam: 10_000, withinPct: 10, sell: { usd: 9.92, hour: T - H, at: T - MIN, height: null, window: { lo: 9.5, hi: 10.2, hours: 168, stored: 168 } }, bids: { usd: 507.29, hour: T - H, at: T - MIN, height: null } } } };
    const t = field(buildDigest(withDepth, T, 'weekly').shared, 'Trades');
    expect(t).toContain("Selling 10,000 NAM across every pool fetched $9.92 at 07:59 UTC (lowest $9.50, highest $10.20 over the 7 d's 168 stored hours) ¹⁸.");
    // a row without a block: the Sources entry names the hour alone
    expect(sources(buildDigest(withDepth, T, 'weekly').shared).at(-1)).toBe("¹⁸ this site's depth store (every Osmosis pool holding NAM, read by the minute), hour to 07:59 UTC");
  });
});

describe('the store row\'s ok flip reaches the health log the operator embed reads (plan section 7)', () => {
  it('mergeHealth appends the flip to kv source.health.log; the operator figures name the episode until the row is ok again', async () => {
    const db = testD1();
    const env = { DB: db } as unknown as Env;
    // the log keeps 48 h measured from the wall clock (appendHealthLog's now), so the flips here are timed from it
    const T = Math.floor(Date.now() / MIN) * MIN;
    const okRow = storeHealth(freshBudget(T - 2 * H), DEPTH_CAPS, T - 2 * H);
    expect(okRow.ok).toBe(true);
    await mergeHealth(env, [okRow]);
    // a row seen for the first time is no flip
    expect(await kvGetJson(db, 'source.health.log')).toBeNull();
    // 4,100,000 rows written: past the warn mark, the row is not ok and the flip is logged with its note
    const warm = { ...freshBudget(T - H), rowsWritten: 4_100_000, sizeAfter: 250_000_000, r2Puts: 17 };
    const notOk = storeHealth(warm, DEPTH_CAPS, T - H);
    expect(notOk).toMatchObject({ name: STORE_HEALTH, ok: false, at: T - H });
    await mergeHealth(env, [notOk]);
    const log = await kvGetJson<{ name: string; at: number; ok: boolean; note: string }[]>(db, 'source.health.log');
    expect(log).toHaveLength(1);
    expect(log![0]).toMatchObject({ name: STORE_HEALTH, at: T - H, ok: false });
    expect(log![0].note).toContain('4,100,000 rows written');
    // the digest's operator figures: the source not ok since the flip, the episode open
    const op = await readOperatorFigures(db, T, 'daily');
    const src = value(op.sources);
    expect(src.notOk.map((x) => x.name)).toContain(STORE_HEALTH);
    expect(src.episodes).toEqual([{ name: STORE_HEALTH, from: T - H, to: null, note: expect.stringContaining('4,100,000 rows written') }]);
    // the row ok again (a new month): the episode closes at the second flip
    await mergeHealth(env, [storeHealth(freshBudget(T), DEPTH_CAPS, T - 10 * MIN)]);
    const after = value((await readOperatorFigures(db, T, 'daily')).sources);
    expect(after.notOk.map((x) => x.name)).not.toContain(STORE_HEALTH);
    expect(after.episodes).toEqual([{ name: STORE_HEALTH, from: T - H, to: T - 10 * MIN, note: expect.stringContaining('4,100,000 rows written') }]);
    // appendHealthLog is the one writer: the entries keep their order and the newest 200
    await appendHealthLog(db, [{ name: STORE_HEALTH, at: T - 5 * MIN, ok: false, note: 'again' }], T);
    expect((await kvGetJson<unknown[]>(db, 'source.health.log'))!).toHaveLength(3);
  });
});

describe('the depth_budget check on the Status/Sources sheet', () => {
  it('has a plain title and a detail line of the check\'s own figures: rows against the cap, the database size, the archive puts, the stop reason', () => {
    for (const k of ['depth_budget', 'depth_vs_chain_estimate', 'depth_vs_route_quote', 'depth_vs_executed']) {
      expect(CHECK_TITLES[k], k).toBeTruthy();
      expect(CHECK_TITLES[k]).not.toMatch(BANNED);
    }
    const b = { ...freshBudget(T), rowsWritten: 1234, rowsRead: 99, sizeAfter: 250_000_000, r2Puts: 3 };
    const s = budgetCheckStmt(b, DEPTH_CAPS, T);
    const check = { key: String(s.params[0]), status: String(s.params[1]), title: String(s.params[2]), detail: JSON.parse(s.params[3] as string), checkedAt: T };
    // the month reads as every other date on the site does (shared/format.ts's three-letter months)
    expect(checkDetail(check)).toBe('1,234 of 5,000,000 rows written in Oct 2026 (0.0% of the cap), database 0.250 GB, 3 archive puts');
    expect(checkDetail({ ...check, detail: { ...check.detail, month: 'October' } })).toBe('1,234 of 5,000,000 rows written this month (0.0% of the cap), database 0.250 GB, 3 archive puts');
    const stopped = budgetCheckStmt({ ...b, rowsWritten: 5_000_000 }, DEPTH_CAPS, T);
    const line = checkDetail({ ...check, status: String(stopped.params[1]), detail: JSON.parse(stopped.params[3] as string) })!;
    expect(stopped.params[1]).toBe('fail');
    expect(line).toContain('5,000,000 of 5,000,000 rows written in Oct 2026 (100.0% of the cap), database 0.250 GB, 3 archive puts; 5,000,000 rows written this month, at the cap of 5,000,000');
    expect(line).not.toMatch(BANNED);
    // a detail without the figures (a check written by another build) gets no made-up line
    expect(checkDetail({ ...check, detail: {} })).toBeNull();
    expect(checkDetail({ ...check, detail: { rowsWritten: 10, rowsMonthMax: 100, sizeAfter: null } })).toBe('10 of 100 rows written this month, database size not reported');
  });
});
