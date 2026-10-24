// From 16:36 UTC on 2026-10-23 to 02:56 UTC on 2026-10-24 the cron stored no NAM quote (price.usd), so the moves
// written then have no price. scripts/repair-pool-hour-prices.ts prices each such move at the pool's close the site
// stores for the hour that holds it (price.pool_1h), named in the row (meta.priceSource 'pool_1h', meta.priceAt), and
// scripts/rebuild-derived.ts --planned writes the trade-hours and days they are in as they stand once it is applied.
// Here: which moves it selects, the hour it reads, its guard, the words the site says it in, and the rebuild.
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { testD1, insert, type TestD1 } from './d1-sqlite';
import { app } from '../worker/src/api';
import { withQuotes, QUOTE_MATCH_MS } from '../worker/src/analytics';
import { evaluateFlow } from '../shared/alerts';
import { checkOnCopy, hourOf, ownPriced, planPoolHourPrices, plannedRow, poolHourSql, quoteBefore, REPAIRED, type Move, type Reading } from '../scripts/repair-pool-hour-prices';
import { rebuildDerived, type Read } from '../scripts/rebuild-derived';
import { priceAtOf, priceBasisWords, priceHowOf, poolHourWords } from '../shared/flow-rules';
import { priceHow, priceShort } from '../web/src/lib/flows';
import { tradeOfFlow } from '../web/src/screens/trade/series';
import { BANNED, lintFile, numLintFile } from '../scripts/copy-lint';
import type { Flow, TradesResponse } from '../shared/types';

const MIN = 60_000, H = 3_600_000;
const at = (h: number, m = 0, s = 0, ms = 0) => Date.UTC(2026, 9, 23, h, m, s, ms);
// The closes stored on production for these hours (price.pool_1h, read 2026-10-24 03:00 UTC).
const CLOSES = new Map([[at(16), 0.0009206810018765214], [at(17), 0.0009221033518478237], [at(18), 0.0009436839360969279], [at(19), 0.0009012831361742955], [at(20), 0.0009034403609220403]]);
// The last quote before the gap, 16:36:03.
const QUOTES: Reading[] = [{ ts: at(16, 36, 3), value: 0.000958614790331889 }];
const SETTLE = JSON.stringify({ trader: 'osmo1buyer', settle: { nam: 542.223359, coins: { OSMO: -10 }, gas: { OSMO: 0.087808 }, rates: { OSMO: 0.05055315148144126 } } });

const move = (o: Partial<Move> & { id: string; ts: number }): Move => ({
  chain: 'osmosis', height: 1, tx_hash: o.id.split(':')[1] ?? o.id, kind: 'buy', from_addr: null, to_addr: 'osmo1buyer', amount_num: 542.223359,
  counter_denom: null, counter_amount: null, pool_id: '3005,3009', price_usd: null, value_usd: null, meta: SETTLE, ...o,
});

describe('which moves the repair prices', () => {
  it('only moves without a price, in NAM, with no quote stored within 5 minutes before them', () => {
    const moves = [
      move({ id: 'osmosis:A:swap', ts: at(18, 6, 11) }),
      move({ id: 'osmosis:B:swap', ts: at(16, 39), kind: 'sell', from_addr: 'osmo1s', to_addr: null }), // the 16:36:03 quote is within 5 min
      move({ id: 'osmosis:C:swap', ts: at(18, 7), price_usd: 0.0009, value_usd: 0.48 }), // priced
      move({ id: 'namada:D:0', ts: at(18, 8), chain: 'namada', kind: 'unshield', meta: JSON.stringify({ tokenSymbol: 'OSMO' }) }), // another coin
      move({ id: 'namada:E:pos', ts: at(20, 49, 19), chain: 'namada', kind: 'bond', meta: '{}' }),
      move({ id: 'osmosis:F:swap', ts: at(18, 9), meta: JSON.stringify({ arb: true }), kind: 'other' }), // a bot round trip, priced as the cron does
    ];
    const plan = planPoolHourPrices(moves, QUOTES, CLOSES);
    expect(plan.priced.map((p) => [p.move.id, p.hour, p.price])).toEqual([
      ['osmosis:A:swap', at(18), 0.0009436839360969279],
      ['namada:E:pos', at(20), 0.0009034403609220403],
      ['osmosis:F:swap', at(18), 0.0009436839360969279],
    ]);
    expect(plan.priced[0].value).toBe(0.0009436839360969279 * 542.223359);
    expect(Object.fromEntries(plan.skipped.map((s) => [s.move.id, s.why]))).toEqual({
      'osmosis:B:swap': 'a quote is stored for its minute (2026-10-23 16:36:03): scripts/repair-quote-prices.ts prices it',
      'osmosis:C:swap': 'it has a price',
      'namada:D:0': 'a move of another coin, never priced as NAM',
    });
    expect(plan.left).toEqual([]);
  });

  it('a quote counts for 5 minutes at or before the move, when above 0; one after the move never does', () => {
    const q = (ts: number, value = 0.00095): Reading => ({ ts, value });
    const t = at(18, 30);
    expect(quoteBefore([q(t - QUOTE_MATCH_MS)], t)).toEqual(q(t - QUOTE_MATCH_MS));
    expect(quoteBefore([q(t - QUOTE_MATCH_MS - 1)], t)).toBeNull();
    expect(quoteBefore([q(t + 1)], t)).toBeNull();
    expect(quoteBefore([q(t - MIN), q(t - 30_000, 0)], t)).toBeNull(); // the newest reading is the minute's, and it is no price
    expect(quoteBefore([q(t - 3 * MIN), q(t - MIN), q(t + MIN)], t)).toEqual(q(t - MIN));
    expect(quoteBefore([], t)).toBeNull();
    // so a move 5 minutes after the last quote is the quote's, and one a millisecond later is the pool close's
    const plan = planPoolHourPrices([move({ id: 'osmosis:Q1:swap', ts: at(16, 41, 3) }), move({ id: 'osmosis:Q2:swap', ts: at(16, 41, 3, 1) })], QUOTES, CLOSES);
    expect(plan.skipped.map((s) => s.move.id)).toEqual(['osmosis:Q1:swap']);
    expect(plan.priced.map((p) => p.move.id)).toEqual(['osmosis:Q2:swap']);
  });

  it('a USDC trade through pool 3005 alone keeps the cron\'s rule (its own price), and is listed if it has none', () => {
    const own = move({ id: 'osmosis:U:swap', ts: at(18, 10), counter_denom: 'USDC', counter_amount: 0.5, pool_id: '3005', meta: '{}' });
    expect(ownPriced(own)).toBe(true);
    expect(ownPriced({ ...own, pool_id: '3005,3368' })).toBe(false);
    expect(ownPriced({ ...own, counter_denom: 'OSMO' })).toBe(false);
    expect(ownPriced({ ...own, kind: 'other', meta: JSON.stringify({ arb: true }) })).toBe(false);
    const plan = planPoolHourPrices([own], QUOTES, CLOSES);
    expect(plan.priced).toEqual([]);
    expect(plan.left[0].why).toContain('which the cron prices at its own USDC');
  });
});

describe('the hour it reads', () => {
  it('is the hour that holds the move: its start, the time of that hour\'s price.pool_1h row', () => {
    expect(hourOf(at(18))).toBe(at(18));
    expect(hourOf(at(18, 59, 59, 999))).toBe(at(18));
    expect(hourOf(at(17, 59, 59, 999))).toBe(at(17));
    const plan = planPoolHourPrices([move({ id: 'osmosis:X:swap', ts: at(18) }), move({ id: 'osmosis:Y:swap', ts: at(17, 59, 59, 999) })], QUOTES, CLOSES);
    expect(plan.priced.map((p) => [p.hour, p.price])).toEqual([[at(18), CLOSES.get(at(18))], [at(17), CLOSES.get(at(17))]]);
  });
  it('an hour with no close stored leaves the move without a price, listed with the hour; never a neighbour\'s close', () => {
    const plan = planPoolHourPrices([move({ id: 'osmosis:Z:swap', ts: at(21, 5) }), move({ id: 'osmosis:W:swap', ts: at(19, 5) })], QUOTES, new Map([...CLOSES, [at(19), 0]]));
    expect(plan.priced).toEqual([]);
    expect(plan.left.map((l) => [l.move.id, l.why])).toEqual([
      ['osmosis:Z:swap', 'no pool close is stored for the hour of 2026-10-23 21:00 UTC'],
      ['osmosis:W:swap', 'no pool close is stored for the hour of 2026-10-23 19:00 UTC'],
    ]);
  });
});

const flowRow = (m: Move) => ({ ...m });
const read = (db: TestD1): Read => (sql) => db.raw.prepare(sql).all().map((r: any) => ({ ...r }));

describe('the statements', () => {
  it('set the price, the value as the cron does and the three meta keys; a second apply changes nothing', () => {
    const db = testD1();
    const moves = [move({ id: 'osmosis:A:swap', ts: at(18, 6, 11) }), move({ id: 'namada:E:pos', ts: at(20, 49, 19), chain: 'namada', kind: 'bond', from_addr: 'tnam1a', to_addr: 'tnam1v', meta: '{"txKind":"bond"}' })];
    insert(db, 'flows', moves.map(flowRow));
    const plan = planPoolHourPrices(moves, QUOTES, CLOSES);
    const sql = plan.priced.map((p) => poolHourSql(p));
    expect(sql[0]).toBe(`UPDATE flows SET price_usd = 0.0009436839360969279, value_usd = 0.0009436839360969279 * amount_num, meta = json_set(COALESCE(meta, '{}'), '$.priceSource', 'pool_1h', '$.priceAt', ${at(18)}, '$.repaired', '2026-10-24') WHERE id = 'osmosis:A:swap' AND price_usd IS NULL AND json_extract(COALESCE(meta, '{}'), '$.tokenSymbol') IS NULL;`);
    const apply = () => sql.reduce((n, s) => n + Number(db.raw.prepare(s).run().changes), 0);
    expect(apply()).toBe(2);
    const a = db.raw.prepare(`SELECT * FROM flows WHERE id = 'osmosis:A:swap'`).get();
    expect(a.price_usd).toBe(0.0009436839360969279);
    expect(a.value_usd).toBe(0.0009436839360969279 * 542.223359);
    const meta = JSON.parse(a.meta);
    expect(meta).toEqual({ ...JSON.parse(SETTLE), priceSource: 'pool_1h', priceAt: at(18), repaired: REPAIRED });
    // kind, amount, ends and the settle record as they were
    expect([a.kind, a.amount_num, a.from_addr, a.to_addr]).toEqual(['buy', 542.223359, null, 'osmo1buyer']);
    expect(meta.settle).toEqual(JSON.parse(SETTLE).settle);
    const before = db.raw.prepare('SELECT * FROM flows ORDER BY id').all();
    expect(apply()).toBe(0);
    expect(db.raw.prepare('SELECT * FROM flows ORDER BY id').all()).toEqual(before);
  });

  it('a row priced, or turned into another coin, after the run is not changed', () => {
    const db = testD1();
    const m = move({ id: 'osmosis:A:swap', ts: at(18, 6, 11) });
    insert(db, 'flows', [flowRow(m), flowRow(move({ id: 'namada:O:1', ts: at(18, 7), chain: 'namada', kind: 'unshield', meta: '{}' }))]);
    const plan = planPoolHourPrices([m, move({ id: 'namada:O:1', ts: at(18, 7), chain: 'namada', kind: 'unshield', meta: '{}' })], QUOTES, CLOSES);
    db.raw.prepare(`UPDATE flows SET price_usd = 0.00095, value_usd = 0.51, meta = json_set(meta, '$.priceSource', 'spot') WHERE id = 'osmosis:A:swap'`).run();
    db.raw.prepare(`UPDATE flows SET meta = '{"tokenSymbol":"OSMO"}' WHERE id = 'namada:O:1'`).run();
    const before = db.raw.prepare('SELECT * FROM flows ORDER BY id').all();
    for (const p of plan.priced) expect(Number(db.raw.prepare(poolHourSql(p)).run().changes)).toBe(0);
    expect(db.raw.prepare('SELECT * FROM flows ORDER BY id').all()).toEqual(before);
  });

  it('the run\'s own check on a copy finds the first apply changes each planned row and the second nothing', () => {
    const moves = [move({ id: 'osmosis:A:swap', ts: at(18, 6, 11) }), move({ id: 'osmosis:B:swap', ts: at(16, 39) }), move({ id: 'osmosis:Z:swap', ts: at(21, 5) })];
    const plan = planPoolHourPrices(moves, QUOTES, CLOSES);
    expect(checkOnCopy(moves, plan, plan.priced.map((p) => poolHourSql(p)))).toEqual({ firstPass: 1, secondPass: 0, problems: [] });
    // a statement that wrote anything else is caught
    const bad = plan.priced.map((p) => poolHourSql(p).replace('SET price_usd', 'SET kind = \'sell\', price_usd'));
    expect(checkOnCopy(moves, plan, bad).problems).toContain('osmosis:A:swap: kind changed');
  });
});

describe('the words the site says it in', () => {
  const T = at(18, 6, 11);
  const f = (o: Partial<Flow> = {}): Flow => ({
    id: 'osmosis:A:swap', chain: 'osmosis', height: 1, ts: T, txHash: 'A', kind: 'buy', from: null, to: 'osmo1buyer', amount: 542.223359,
    counterDenom: null, counterAmount: null, poolId: '3005,3009', priceUsd: 0.0009436839360969279, valueUsd: 0.0009436839360969279 * 542.223359,
    meta: { trader: 'osmo1buyer', priceSource: 'pool_1h', priceAt: at(18), repaired: REPAIRED }, ...o,
  } as Flow);
  it('names the pool\'s hourly close and its hour, in the moves list, its CSV and the tape', () => {
    expect(priceHowOf(f())).toBe('pool_1h');
    expect(priceHow(f())).toBe('pool_1h');
    expect(priceAtOf(f())).toBe(at(18));
    // the row stamped 18:00 holds the close of the hour that ends at 19:00, and is named by that end
    expect(priceShort('pool_1h', at(18))).toBe("pool's hourly close, hour ending 19:00 UTC");
    expect(poolHourWords(at(18))).toBe('the pool’s close for the hour ending 19:00 UTC (Osmosis app data)');
    expect(priceBasisWords('pool_1h', at(18))).toBe('the pool’s close for the hour ending 19:00 UTC (Osmosis app data), as no Osmosis quote was stored for that minute');
    // another source's priceAt is not read as an hour
    expect(priceAtOf(f({ meta: { priceSource: 'spot', priceAt: at(18) } }))).toBeNull();
    // the others as the moves list has always said them
    expect(priceBasisWords('spot', null)).toBe('the Osmosis quote when the move was recorded');
    expect(priceBasisWords('execution', null)).toBe('from this trade itself');
    expect(priceBasisWords('none', null)).toBe('');
    expect(priceShort('spot', null)).toBe('quote at the time');
    const tape = tradeOfFlow(f())!;
    expect(tape).toMatchObject({ priceSource: 'pool_1h', priceAt: at(18) });
    for (const text of [priceShort('pool_1h', at(18)), priceBasisWords('pool_1h', at(18))]) for (const b of BANNED) expect(b.re.test(text), `${b.word} in ${text}`).toBe(false);
  });

  it('the source files that show it pass the copy lint', () => {
    const root = join(__dirname, '..', 'web', 'src');
    for (const file of ['ui/TxList.tsx', 'ui/TradesTape.tsx', 'screens/alerts/index.tsx'].map((x) => join(root, x))) {
      expect(lintFile(file)).toEqual([]);
      expect(numLintFile(file)).toEqual([]);
    }
  });

  it('the CSV export says it in price_basis, beside price_source; the tape\'s rows carry the hour', async () => {
    const db = testD1();
    const row = f();
    insert(db, 'flows', [{ id: row.id, chain: row.chain, height: 1, ts: row.ts, tx_hash: row.txHash, kind: row.kind, from_addr: null, to_addr: row.to, amount_num: row.amount, counter_denom: null, counter_amount: null, pool_id: row.poolId, price_usd: row.priceUsd, value_usd: row.valueUsd, meta: JSON.stringify(row.meta) }]);
    const csv = (await (await app.request('/api/export/flows?format=csv', {}, { DB: db } as any)).text()).trim().split('\n');
    const head = csv[0].split(',');
    expect(head.slice(-4)).toEqual(['price_source', 'settle_usd_per_nam', 'settle_usd', 'price_basis']);
    expect(csv[1]).toContain(',pool_1h,');
    expect(csv[1].trimEnd().endsWith(',"the pool’s close for the hour ending 19:00 UTC (Osmosis app data), as no Osmosis quote was stored for that minute"')).toBe(true);
    const trades = (await (await app.request('/api/series/trades?limit=10', {}, { DB: db } as any)).json()) as TradesResponse;
    expect(trades.rows[0]).toMatchObject({ priceSource: 'pool_1h', priceAt: at(18), priceUsd: 0.0009436839360969279 });
  });

  it('an alert hit with no settle price and no quote for its minute shows the row\'s pool close, with its hour', async () => {
    const big = f({ amount: 30_000, valueUsd: 0.0009436839360969279 * 30_000 });
    const db = testD1();
    const [hit] = await withQuotes(db as any, evaluateFlow(big), [big]);
    expect(hit.price).toEqual({ usd: 0.0009436839360969279, source: 'pool_1h', at: at(18) });
    // a quote stored for the minute comes first
    insert(db, 'metrics', [{ ts: T - MIN, key: 'price.usd', value: 0.00093 }]);
    const [quoted] = await withQuotes(db as any, evaluateFlow(big), [big]);
    expect(quoted.price).toEqual({ usd: 0.00093, source: 'quote', at: T - MIN });
    // a row without the source says no price is on record, as before
    const [none] = await withQuotes(testD1() as any, evaluateFlow({ ...big, meta: { trader: 'osmo1buyer' } }), [{ ...big, meta: { trader: 'osmo1buyer' } }]);
    expect(none.price).toBeNull();
  });
});

describe('the rebuild of what the moves are summed into', () => {
  // hour 18: a trade at its own USDC through pool 3005 and two quote-priced trades the gap left without a price; a
  // Namada move the same day
  const seed = (db: TestD1) => {
    insert(db, 'flows', [
      flowRow(move({ id: 'osmosis:OWN:swap', ts: at(18, 1), kind: 'sell', from_addr: 'osmo1seller', to_addr: null, amount_num: 1000, counter_denom: 'USDC', counter_amount: 0.93, pool_id: '3005', price_usd: 0.00093, value_usd: 0.93, meta: '{"trader":"osmo1seller","priceSource":"execution"}' })),
      flowRow(move({ id: 'osmosis:A:swap', ts: at(18, 6, 11) })),
      flowRow(move({ id: 'osmosis:B:swap', ts: at(18, 6, 29), amount_num: 540.068654 })),
      flowRow(move({ id: 'namada:E:pos', ts: at(20, 49, 19), chain: 'namada', kind: 'bond', from_addr: 'tnam1qa', to_addr: 'tnam1qv', amount_num: 1013.495862, meta: '{"txKind":"bond"}' })),
    ]);
  };
  const NOW = Date.UTC(2026, 9, 24, 3);
  it('with the planned rows, writes now what it writes once the repair is applied; the hour then has its dollar sum', () => {
    const db = testD1();
    seed(db);
    const moves = read(db)<Move>('SELECT * FROM flows WHERE price_usd IS NULL ORDER BY ts');
    const plan = planPoolHourPrices(moves, QUOTES, CLOSES);
    expect(plan.priced).toHaveLength(3);
    const before = rebuildDerived(read(db), { key: 'repaired', mark: REPAIRED, now: NOW, planned: plan.priced.map((p) => plannedRow(p)) });
    expect(before.hours.map((h) => [h.at, h.ids.length])).toEqual([[at(18), 2]]);
    expect(before.days.map((d) => d.ids.length)).toEqual([3]);
    expect(before.planned).toBe(3);
    // nothing was written by the rebuild itself, and without the planned rows nothing is marked yet
    expect(read(db)<{ n: number }>('SELECT COUNT(*) n FROM flows WHERE price_usd IS NULL')[0].n).toBe(3);
    expect(rebuildDerived(read(db), { key: 'repaired', mark: REPAIRED, now: NOW }).lines).toEqual([]);
    for (const p of plan.priced) db.raw.prepare(poolHourSql(p)).run();
    const after = rebuildDerived(read(db), { key: 'repaired', mark: REPAIRED, now: NOW });
    expect(after.lines).toEqual(before.lines);
    const usd = 0.93 + 0.0009436839360969279 * 542.223359 + 0.0009436839360969279 * 540.068654;
    const insert1 = (k: string) => before.lines.find((l) => l.startsWith('INSERT') && l.includes(`'${k}'`));
    expect(insert1('dex.swaps_1h.usd')).toBe(`INSERT OR REPLACE INTO metrics (ts,key,value) VALUES (${at(18)},'dex.swaps_1h.usd',${usd});`);
    // the day sums its rows in the order the database reads them
    const daily = /^INSERT OR REPLACE INTO metrics \(ts,key,value\) VALUES \((\d+),'dex.volume_usd_daily',([0-9.e-]+)\);$/.exec(insert1('dex.volume_usd_daily') ?? '');
    expect(Number(daily?.[1])).toBe(at(0));
    expect(Number(daily?.[2])).toBeCloseTo(usd, 12);
    // the listing names each derived row that holds them
    expect(before.listing).toContain(`  dex.swaps_1h.usd: stored none, written ${usd}`);
    expect(before.listing.some((l) => l.startsWith('  flow_edges_daily namada bond') && l.includes('(holds 1)'))).toBe(true);
    expect(before.listing.some((l) => l.startsWith('  activity_daily osmosis (holds 2)'))).toBe(true);
  });

  it('a planned row that has a price by then is read as stored, and a planned row without the mark is refused', () => {
    const db = testD1();
    seed(db);
    const moves = read(db)<Move>('SELECT * FROM flows WHERE price_usd IS NULL ORDER BY ts');
    const planned = planPoolHourPrices(moves, QUOTES, CLOSES).priced.map((p) => plannedRow(p));
    db.raw.prepare(`UPDATE flows SET price_usd = 0.001, value_usd = 0.54, meta = json_set(meta, '$.priceSource', 'spot') WHERE id = 'osmosis:B:swap'`).run();
    const r = rebuildDerived(read(db), { key: 'repaired', mark: REPAIRED, now: NOW, planned });
    expect(r.planned).toBe(2);
    const usd = 0.93 + 0.0009436839360969279 * 542.223359 + 0.54;
    expect(r.lines).toContain(`INSERT OR REPLACE INTO metrics (ts,key,value) VALUES (${at(18)},'dex.swaps_1h.usd',${usd});`);
    expect(() => rebuildDerived(read(db), { key: 'restored', mark: REPAIRED, now: NOW, planned })).toThrow('does not set restored = 2026-10-24');
  });

  it('the hour and the day still running are left to the cron', () => {
    const db = testD1();
    seed(db);
    const moves = read(db)<Move>('SELECT * FROM flows WHERE price_usd IS NULL ORDER BY ts');
    const planned = planPoolHourPrices(moves, QUOTES, CLOSES).priced.map((p) => plannedRow(p));
    const r = rebuildDerived(read(db), { key: 'repaired', mark: REPAIRED, now: at(18, 30), planned });
    expect([r.hours.length, r.days.length, r.lines.length]).toEqual([0, 0, 0]);
    expect(rebuildDerived(read(db), { key: 'repaired', mark: REPAIRED, now: at(19) + H, planned }).hours.map((h) => h.at)).toEqual([at(18)]);
  });
});
