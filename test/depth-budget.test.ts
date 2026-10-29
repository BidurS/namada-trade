// The depth store's caps (plan section 7; worker/src/depth/budget.ts, pools.ts, read.ts): C1 the pool cap with the cut
// said and the book always kept, C2 the request cap, C3 the rows-a-month counter across ticks with the month reset, the
// warn at 80 % and the stop at the cap with deletes going on, C4 the database size, C5 the retention delete's limit, C6
// the archive counters, C7 the read caps as constants, C8 the kill switch. The minute itself is run on the fixtures of
// test/depth-minute-net.ts for the caps that change what it writes.
import { describe, it, expect } from 'vitest';
import { testD1, insert, type TestD1 } from './d1-sqlite';
import { minute, DEPTH_HEALTH } from '../worker/src/depth/index';
import { NAM_DEPTH, DEPTH_CAPS, type DepthConfig } from '../worker/src/depth/config';
import { budgetFor, freshBudget, gate, monthOf, recordWrites, recordBytes, recordR2Put, recordCapHit, storeHealth, budgetCheckStmt, killSwitchOff, STORE_HEALTH, type DepthBudget } from '../worker/src/depth/budget';
import { counterInfo, counterDenoms, listPools, liveSet, isDust } from '../worker/src/depth/pools';
import { Requests, readText } from '../worker/src/depth/read';
import { deleteOldMinutesStmt } from '../worker/src/depth/sql';
import { cutByCap, UNPRICED_DUST, UNPRICED_EMPTY, UNPRICED_NO_PRICE, DEPTH_CHECK_TITLES } from '../shared/depth';
import type { SourceHealth } from '../shared/types';
import { depthNetwork, bookKvFromFixture, paramsKvFromFixture, priceListFromFixture, SQS_POOLS, TOKEN_META } from './depth-minute-net';

const cfg = NAM_DEPTH;
const T = Date.UTC(2026, 9, 29, 2, 56, 30);
const MINUTE = Math.floor(T / 60000) * 60000;
const all = (db: TestD1, sql: string, ...p: unknown[]) => db.raw.prepare(sql).all(...p).map((r: any) => ({ ...r }));
const kv = <T = any>(db: TestD1, key: string): T | null => { const r = all(db, 'SELECT value FROM kv WHERE key = ?', key)[0]; return r ? JSON.parse(r.value) : null; };
const check = (db: TestD1, key: string) => { const r = all(db, 'SELECT status, detail FROM checks WHERE key = ?', key)[0]; return r ? { status: r.status, detail: JSON.parse(r.detail) } : null; };
const rowOf = (h: SourceHealth[], name: string) => h.filter((x) => x.name === name).pop();

function seeded(budget?: Partial<DepthBudget>) {
  const db = testD1();
  const before = T - 60_000;
  insert(db, 'kv', [
    { key: 'depth.params', value: JSON.stringify(paramsKvFromFixture(before)), updated_at: before },
    { key: 'depth.book', value: JSON.stringify(bookKvFromFixture(before)), updated_at: before },
    ...(budget ? [{ key: 'depth.budget', value: JSON.stringify({ ...freshBudget(before), ...budget }), updated_at: before }] : []),
  ]);
  return db;
}
async function run(db: TestD1, over: Partial<DepthConfig> = {}, now = T) {
  const n = depthNetwork();
  const health: SourceHealth[] = [];
  let clock = now;
  const res = await minute({ DB: db } as any, now, { health, fetch: n.fetch, clock: () => (clock += 100), pools: SQS_POOLS, poolsAt: now - 1500, cfg: { ...cfg, ...over } });
  return { res, health, net: n };
}
/** The counters of the fixture's minute, as pools.ts prices them. */
function counters() {
  const listed = listPools(cfg, SQS_POOLS);
  const denoms = counterDenoms(listed.filter((p) => p.sides !== 'empty' && !isDust(cfg, p)));
  const params = paramsKvFromFixture(T - 60_000);
  const prices = { value: priceListFromFixture(denoms), at: T - 1000 };
  return { listed, info: Object.fromEntries(denoms.map((d) => [d, counterInfo(cfg, d, prices, params.tokens[d] ?? null, params.taker[d] ?? null)])) };
}

describe('C1: the pool cap', () => {
  it('the live set is the priced pools largest by counter value, cut at the cap with the cut said; the book always counts; the rest are unpriced, empty or dust with the reason', () => {
    const { listed, info } = counters();
    const full = liveSet(cfg, listed, info);
    expect(full.live).toHaveLength(15);
    expect(full.cut).toBe(0);
    expect(full.unpriced.map((u) => u.pool.id)).toEqual(['3020']);
    expect(full.unpriced[0].why).toBe(UNPRICED_NO_PRICE);
    expect(full.leftOut.filter((x) => x.why === UNPRICED_EMPTY).map((x) => x.pool.id).sort()).toEqual(['3016', '3021']);
    expect(full.leftOut.filter((x) => x.why === UNPRICED_DUST)).toHaveLength(10);
    // largest counter value first: pool 3005's 187 USDC, then the OSMO pool 3368, the book last among the live
    expect(full.live.slice(0, 2).map((p) => p.id)).toEqual(['3005', '3368']);
    expect(full.live[full.live.length - 1].id).toBe('3008');
    const capped = liveSet({ ...cfg, caps: { ...cfg.caps, poolsMax: 3 } }, listed, info);
    expect(capped.live.map((p) => p.id)).toEqual(['3005', '3368', '3008']); // two by value and the book, which the cap does not count against
    expect(capped.cut).toBe(12);
    expect(capped.leftOut.filter((x) => x.why === cutByCap(3))).toHaveLength(12);
    expect(cutByCap(3)).toContain('past the cap of 3 pools read a minute');
  });
  it('a minute under a cap of three writes three pool rows and the aggregate, lists the cut pools with the reason, and the health row says how many were cut', async () => {
    const db = seeded();
    const { res, health } = await run(db, { caps: { ...cfg.caps, poolsMax: 3 } });
    expect(res.rows.map((r) => r.pool_id)).toEqual(['all', '3005', '3368', '3008', '3020']);
    expect(res.rows[0].note).toBe(`12 priced pools cut by the cap of 3`);
    expect(res.latest!.unpriced.filter((u) => u.why === cutByCap(3))).toHaveLength(12);
    expect(rowOf(health, DEPTH_HEALTH.pools)!.note).toContain('12 cut by the cap of 3');
    expect(all(db, 'SELECT COUNT(*) n FROM depth_minute')[0].n).toBe(5);
  });
});

describe('C2: the request cap', () => {
  it('the ledger refuses a request past the cap and records the refusal in the provenance list', async () => {
    const req = new Requests(2, undefined, async () => new Response('{}', { status: 200 }), 1000, () => T);
    expect(req.take()).toBe(true);
    expect(req.take()).toBe(true);
    expect(req.take()).toBe(false);
    expect(req.refused).toBe(1);
    const r = await readText(req, 'one more', 'https://example.invalid/x');
    expect('error' in r && r.error).toContain('request cap');
    expect(req.prov.pop()).toMatchObject({ what: 'one more', bytes: 0, at: T });
  });
  it('a minute under a cap of four makes four requests and says the pools the batch could not ask for were not read', async () => {
    const db = seeded();
    const { res, health, net } = await run(db, { caps: { ...cfg.caps, requestsPerMinute: 4 } });
    expect(net.calls).toHaveLength(4);
    expect(res.requests).toBe(4);
    const note = rowOf(health, DEPTH_HEALTH.pools)!.note!;
    expect(note).toContain('requests over the cap of 4');
    expect(res.rows.filter((r) => r.note?.includes('request cap')).length).toBeGreaterThan(0);
    expect(cfg.caps.requestsPerMinute).toBe(12);
    expect(cfg.caps.phaseMs).toBe(10_000);
  });
});

describe('C3: rows a month', () => {
  it('the counter is kept across ticks and starts again on the first tick of a UTC month; a row that does not parse starts fresh', () => {
    const oct = Date.UTC(2026, 9, 31, 23, 59, 30), nov = Date.UTC(2026, 10, 1, 0, 0, 30);
    expect(monthOf(oct)).toBe('2026-10');
    expect(monthOf(nov)).toBe('2026-11');
    const b = recordWrites(freshBudget(oct), [{ meta: { rows_written: 17, rows_read: 3, size_after: 200_000_000 } }, { meta: { changes: 4 } }, {}], oct);
    expect(b).toMatchObject({ month: '2026-10', rowsWritten: 21, rowsRead: 3, sizeAfter: 200_000_000 });
    expect(budgetFor(b, oct + 10_000).rowsWritten).toBe(21);
    expect(budgetFor(b, nov)).toMatchObject({ month: '2026-11', rowsWritten: 0, rowsRead: 0, sizeAfter: null });
    expect(budgetFor('nonsense', oct)).toEqual(freshBudget(oct));
    expect(budgetFor({ month: '2026-10', rowsWritten: 'many' }, oct).rowsWritten).toBe(0);
    expect(recordBytes(b, 1234).bytesIn).toBe(1234);
  });
  it('the gate: ok under the warn mark, warn from 4,000,000, stopped at 5,000,000 counting the rows about to be written', () => {
    const b = freshBudget(T);
    expect(gate(b, DEPTH_CAPS, 30)).toMatchObject({ writes: true, level: 'ok', why: null });
    expect(gate({ ...b, rowsWritten: 3_999_999 }, DEPTH_CAPS, 30).level).toBe('ok');
    const warn = gate({ ...b, rowsWritten: 4_000_000 }, DEPTH_CAPS, 30);
    expect(warn).toMatchObject({ writes: true, level: 'warn' });
    expect(warn.why).toContain('80 % of the cap of 5,000,000');
    const stop = gate({ ...b, rowsWritten: 4_999_980 }, DEPTH_CAPS, 30);
    expect(stop).toMatchObject({ writes: false, level: 'fail' });
    expect(stop.why).toContain('inserts stopped, deletes go on');
    expect(gate({ ...b, rowsWritten: 4_999_980 }, DEPTH_CAPS, 20).writes).toBe(true);
    expect(DEPTH_CAPS.rowsMonthMax).toBe(5_000_000);
    expect(DEPTH_CAPS.rowsWarn).toBe(4_000_000);
  });
  it('at 80 %: the rows are still written, the store row is not ok and the check warns with the figures', async () => {
    const db = seeded({ rowsWritten: 4_100_000 });
    const { res, health } = await run(db);
    expect(res.written).toBe(true);
    expect(all(db, 'SELECT COUNT(*) n FROM depth_minute')[0].n).toBe(17);
    const store = rowOf(health, STORE_HEALTH)!;
    expect(store.ok).toBe(false);
    expect(store.note).toMatch(/^4,100,0\d\d rows written this month, 82 % of the cap of 5,000,000; size not reported; 0 archive puts$/);
    const c = check(db, 'depth_budget')!;
    expect(c.status).toBe('warn');
    expect(c.detail).toMatchObject({ month: '2026-10', rowsMonthMax: 5_000_000, rowsWarn: 4_000_000, writes: true });
    expect(c.detail.rowsWritten).toBe(4_100_000); // the check row goes in the batch it counts, so it carries the count before it
    expect(kv(db, 'depth.budget').rowsWritten).toBe(4_100_000 + 23);
  });
  it('at the cap: nothing is read, no depth row or kv answer is written, the check fails, the health row says so, and the retention delete still runs', async () => {
    const db = seeded({ rowsWritten: 5_000_000 });
    insert(db, 'depth_minute', [{ minute: MINUTE - 40 * 86_400_000, pool_id: 'all', at: T, ref_usd: 0.001 }]);
    const { res, health, net } = await run(db);
    expect(res.skipped).toBe('cap');
    expect(net.calls).toHaveLength(0);
    expect(all(db, 'SELECT COUNT(*) n FROM depth_minute WHERE minute = ?', MINUTE)[0].n).toBe(0);
    expect(kv(db, 'depth.latest')).toBeNull();
    expect(check(db, 'depth_budget')!.status).toBe('fail');
    expect(check(db, 'depth_budget')!.detail.lastCapHit).toMatchObject({ at: T });
    expect(rowOf(health, DEPTH_HEALTH.pools)!.note).toMatch(/^Not read this minute: 5,000,000 rows written this month, at the cap of 5,000,000: inserts stopped, deletes go on$/);
    expect(rowOf(health, STORE_HEALTH)!.ok).toBe(false);
    const s = deleteOldMinutesStmt(MINUTE - cfg.caps.retentionMs, cfg.caps.deleteLimit);
    expect(db.raw.prepare(s.sql).run(...s.params).changes).toBe(1);
    expect(cfg.caps.deleteLimit).toBe(5_000);
    expect(cfg.caps.retentionMs).toBe(30 * 86_400_000);
  });
  it('the cap reached by the rows about to be written: the minute reads, then writes only its check rows and says why', async () => {
    const db = seeded({ rowsWritten: 4_999_990 });
    const { res, health, net } = await run(db);
    expect(res.skipped).toBeUndefined();
    expect(res.written).toBe(false);
    expect(net.calls.length).toBeGreaterThan(0);
    expect(all(db, 'SELECT COUNT(*) n FROM depth_minute')[0].n).toBe(0);
    expect(kv(db, 'depth.latest')).toBeNull();
    expect(check(db, 'depth_vs_chain_estimate')!.status).toBe('ok');
    expect(check(db, 'depth_budget')!.status).toBe('fail');
    expect(rowOf(health, DEPTH_HEALTH.pools)!.ok).toBe(false);
    expect(rowOf(health, DEPTH_HEALTH.pools)!.note).toContain('not written: 4,999,990 rows written this month, at the cap');
  });
});

describe('C4: the database size', () => {
  it('a size_after past 4 GB stops inserts whatever the row count; under it the rows go on', () => {
    const b = { ...freshBudget(T), sizeAfter: 4_000_000_001 };
    const g = gate(b, DEPTH_CAPS, 1);
    expect(g).toMatchObject({ writes: false, level: 'fail' });
    expect(g.why).toContain('4.00 GB, past the 4 GB cap');
    expect(gate({ ...b, sizeAfter: 3_999_999_999 }, DEPTH_CAPS, 1).writes).toBe(true);
    expect(DEPTH_CAPS.d1SizeMax).toBe(4_000_000_000);
    expect(storeHealth(b, DEPTH_CAPS, T).ok).toBe(false);
    expect(storeHealth(b, DEPTH_CAPS, T).note).toContain('4.000 GB');
  });
  it('a minute whose stored size is past the cap writes nothing but its check rows', async () => {
    const db = seeded({ sizeAfter: 4_500_000_000 });
    const { res } = await run(db);
    expect(res.skipped).toBe('cap');
    expect(all(db, 'SELECT COUNT(*) n FROM depth_minute')[0].n).toBe(0);
    expect(check(db, 'depth_budget')).toMatchObject({ status: 'fail', detail: { sizeAfter: 4_500_000_000, writes: false } });
  });
});

describe('C6 and C7: the archive and the read caps', () => {
  it('the archive counters and the constants the later steps hold to', () => {
    const b = recordR2Put(recordR2Put(freshBudget(T), 500), 700);
    expect(b).toMatchObject({ r2Puts: 2, r2Bytes: 1200 });
    expect(storeHealth(b, DEPTH_CAPS, T).note).toContain('2 archive puts');
    expect(DEPTH_CAPS.r2ObjectMax).toBe(1_000_000);
    expect(DEPTH_CAPS.historyRowsMax).toBe(43_200);
    expect(DEPTH_CAPS.heatRowsMax).toBe(2_016);
    expect(DEPTH_CAPS.hourlyMs).toBe(15_000);
    expect(DEPTH_CAPS.hourlyRequests).toBe(60);
    expect(recordCapHit(b, 'rows', T).lastCapHit).toEqual({ at: T, what: 'rows' });
  });
  it('the check row and the store row name the same figures', () => {
    const b = { ...freshBudget(T), rowsWritten: 1234, rowsRead: 99, sizeAfter: 250_000_000, r2Puts: 3 };
    const s = budgetCheckStmt(b, DEPTH_CAPS, T);
    expect(s.params.slice(0, 3)).toEqual(['depth_budget', 'ok', DEPTH_CHECK_TITLES.depth_budget]);
    expect(JSON.parse(s.params[3] as string)).toMatchObject({ rowsWritten: 1234, rowsRead: 99, sizeAfter: 250_000_000, r2Puts: 3, pctOfCap: 0.02, writes: true });
    expect(storeHealth(b, DEPTH_CAPS, T)).toEqual({ name: STORE_HEALTH, ok: true, at: T, note: '1,234 rows written in 2026-10 (0.0 % of the cap); 0.250 GB; 3 archive puts' });
  });
});

describe('C8: the kill switch', () => {
  it('kv depth.on holding 0 turns the minute off; anything else leaves it on', () => {
    expect(killSwitchOff('0')).toBe(true);
    expect(killSwitchOff(' 0 ')).toBe(true);
    expect(killSwitchOff('1')).toBe(false);
    expect(killSwitchOff('')).toBe(false);
    expect(killSwitchOff(null)).toBe(false);
    expect(killSwitchOff(undefined)).toBe(false);
    expect(killSwitchOff('00')).toBe(false);
  });
  it('the token metadata fixture names the counter coins the live set needs, so the first minute can price them', () => {
    const { listed } = counters();
    const denoms = counterDenoms(listed.filter((p) => p.sides !== 'empty' && !isDust(cfg, p)));
    for (const d of denoms) if (!cfg.quoteCoins[d]) expect(TOKEN_META.tokens[d], d).toBeTruthy();
  });
});
