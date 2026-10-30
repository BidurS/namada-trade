// Osmosis history repair (2026-10-29), scripts/backfill-osmosis.ts: how its report tells what the database lacks. Each
// transaction found is parsed as the hub parses it, the database is read for it by tx_hash only (through the moves
// primary key, flows_hash and pool_legs's primary key, read only), and it is judged per pool: a pool whose NAM it moves
// needs its NAM move at that pool's address; a pool whose other coin alone it moves needs its leg in pool_legs; a
// transaction with NAM rows of which nothing is stored is missing whole. No network: the transactions are fixtures
// (three swaps, the USDC-only withdrawal EBDEAC7A... from 3005 and a bid on the 3008 book), and the database is the
// SQLite stand-in with the migrations, read through scripts/d1-readonly.ts.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { judge, repairRows, seenOf, storedOf, type Seen } from '../scripts/backfill-osmosis';
import { readOnlyD1, type Runner } from '../scripts/d1-readonly';
import { normFromTxSearch, osmoAssets, parseOsmosisTx, poolLegsOf, type OsmoCtx } from '../worker/src/parse/osmosis';
import { runBatch, stmt } from '../worker/src/db';
import { testD1, type TestD1 } from './d1-sqlite';

const fx = (f: string) => JSON.parse(readFileSync(join(__dirname, 'fixtures', f), 'utf8'));
const P3005 = 'osmo1m459jtgn77tz8cffvthq5jh0erswxu9872mjd9qde546mslc6udq85we5r';
const P3008 = 'osmo1cf6jdap430ugk6c27cdm5stqkq7z3rkgfl5ps5nnw3d5409sw3vql4364c';
const P3368 = 'osmo1h6zkrf476ha3csjmgf6eneh3p43ltmjlppvyzpmpyfxts0zk3k0s288e7l';
const P3009 = 'osmo1rcl39flt5ua3t92vtwj7xllj9u2ucmrsjdhl945jc25f6zxvnvns5rtv6l';
const ctx: OsmoCtx = { poolAddrs: new Map([[P3005, '3005'], [P3008, '3008'], [P3368, '3368'], [P3009, '3009']]), priceUsd: null, assets: osmoAssets() };
const pools = [...ctx.poolAddrs].map(([address, id]) => ({ id, address, pair: 'NAM / x' }));
const [sell3005, via3009, via3368] = fx('osmo_swap.json');
const withdraw = fx('osmo_pool3005_usdc_withdraw.json')[0];
const bid = fx('osmo_pool3008_bid.json')[0];

/** wrangler's --json answer for one statement, from the stand-in (as test/d1-readonly.test.ts). */
const sqliteRunner = (db: TestD1): Runner => async (sql) => JSON.stringify([{ results: db.raw.prepare(sql).all().map((r: object) => ({ ...r })), success: true, meta: { rows_read: 1 } }]);
const parsed = (t: any) => parseOsmosisTx(normFromTxSearch(t, 1), ctx);

/** Queries 0 to 3 are the stream's four; then each pool's two (sender, recipient), in the order of `pools`. */
const poolQueryOf = new Map(pools.flatMap((p, i) => [[4 + 2 * i, p.address], [5 + 2 * i, p.address]] as [number, string][]));
const sender = (addr: string) => 4 + 2 * pools.findIndex((p) => p.address === addr);
const recipient = (addr: string) => sender(addr) + 1;

async function world() {
  const db = testD1();
  // the 3005 sell stored whole, as the hub writes it
  const s = parsed(sell3005);
  await runBatch(db as any, [...s.flows.map(stmt.flow), ...s.moves.map(stmt.move)]);
  // the swap through 3368 stored in part: its flows and every move but the one at 3368's address
  const p = parsed(via3368);
  await runBatch(db as any, [...p.flows.map(stmt.flow), ...p.moves.filter((m) => m.address !== P3368).map(stmt.move)]);
  // the bid's leg stored in pool_legs; nothing of the swap through 3009 or of the withdrawal
  await runBatch(db as any, poolLegsOf(normFromTxSearch(bid, 1), ctx.poolAddrs).map(stmt.poolLeg));
  const seen = new Map<string, Seen>();
  seenOf(sell3005, ctx, 1, seen);
  seenOf(sell3005, ctx, sender(P3005), seen);
  seenOf(sell3005, ctx, 0, seen);
  seenOf(via3368, ctx, recipient(P3368), seen);
  seenOf(via3368, ctx, sender(P3368), seen);
  seenOf(via3009, ctx, recipient(P3009), seen);
  seenOf(withdraw, ctx, sender(P3005), seen);
  seenOf(bid, ctx, recipient(P3008), seen);
  return { db, seen };
}

describe('what the database lacks, per pool', () => {
  it('a pool\'s NAM move stored, one stored in part, one missing whole, a pool leg missing and one stored', async () => {
    const { db, seen } = await world();
    const { db: ro, ran } = readOnlyD1(sqliteRunner(db), { pauseMs: 0 });
    const stored = await storedOf(ro, [...seen.keys()]);
    expect(stored.legs).not.toBeNull();
    const j = judge(seen, stored, pools, poolQueryOf);
    const per = Object.fromEntries(j.perPool.map((x) => [x.pool.id, { nam: x.nam, other: x.other }]));
    expect(per).toEqual({
      // the sell (found by the NAM query and 3005's sends) and the swap through 3368 move 3005's NAM, but only the
      // pools whose queries found a transaction count it; the withdrawal moves only its USDC
      '3005': { nam: { chain: 1, stored: 1 }, other: { chain: 1, stored: 0 } },
      '3008': { nam: { chain: 0, stored: 0 }, other: { chain: 1, stored: 1 } },
      // found by both of 3368's queries: one transaction
      '3368': { nam: { chain: 1, stored: 0 }, other: { chain: 0, stored: 0 } },
      '3009': { nam: { chain: 1, stored: 0 }, other: { chain: 0, stored: 0 } },
    });
    expect(j.missing.map((m) => [m.s.hash.slice(0, 8), m.verdict, m.pools])).toEqual([
      ['7AB4C4B8', 'part', ['3368']],
      ['11E5437E', 'missing', ['3009']],
      ['EBDEAC7A', 'legs', ['3005']],
    ]);
    // three swaps make NAM rows; two of them have rows stored
    expect([j.rowsChain, j.rowsStored]).toEqual([3, 2]);
    // read only: the table check, then moves, flows and pool_legs for the hashes, one statement each
    expect(ran.map((r) => r.sql.split(' ').slice(0, 6).join(' '))).toEqual([
      'SELECT COUNT(*) AS n FROM sqlite_master',
      'SELECT tx_hash, address FROM moves WHERE',
      'SELECT DISTINCT tx_hash FROM flows WHERE',
      'SELECT DISTINCT tx_hash, address FROM pool_legs',
    ]);
  });

  it('before migration 0018 every transaction in a pool\'s other coin alone is missing, and the rest is judged as before', async () => {
    const { db, seen } = await world();
    db.exec('DROP TABLE pool_legs');
    const { db: ro, ran } = readOnlyD1(sqliteRunner(db), { pauseMs: 0 });
    const stored = await storedOf(ro, [...seen.keys()]);
    expect(stored.legs).toBeNull();
    const j = judge(seen, stored, pools, poolQueryOf);
    expect(j.missing.map((m) => [m.s.hash.slice(0, 8), m.verdict])).toEqual([['7AB4C4B8', 'part'], ['11E5437E', 'missing'], ['EBDEAC7A', 'legs'], ['C8735FE2', 'legs']].sort((a, b) => (fxHeight(a[0]) - fxHeight(b[0]))));
    expect(ran.some((r) => r.sql.includes('pool_legs WHERE'))).toBe(false);
  });

  it('every read goes through an index: the moves primary key, flows_hash, pool_legs\'s primary key', async () => {
    const { db } = await world();
    const plan = (sql: string) => db.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((r: any) => r.detail).join('; ');
    expect(plan(`SELECT tx_hash, address FROM moves WHERE chain = 'osmosis' AND tx_hash IN ('A','B')`)).toMatch(/USING (COVERING )?INDEX sqlite_autoindex_moves_1 \(chain=\? AND tx_hash=\?\)/);
    expect(plan(`SELECT DISTINCT tx_hash FROM flows WHERE tx_hash IN ('A','B')`)).toMatch(/USING (COVERING )?INDEX flows_hash \(tx_hash=\?\)/);
    expect(plan(`SELECT DISTINCT tx_hash, address FROM pool_legs WHERE chain = 'osmosis' AND tx_hash IN ('A','B')`)).toMatch(/USING (COVERING )?INDEX sqlite_autoindex_pool_legs_1 \(chain=\? AND tx_hash=\?\)/);
  });

  it('the database it reads refuses a write', async () => {
    const { db } = await world();
    const { db: ro } = readOnlyD1(sqliteRunner(db), { pauseMs: 0 });
    await expect(ro.prepare("DELETE FROM moves WHERE chain = 'osmosis'").all()).rejects.toThrow(/^refused/);
  });
});

describe('what the writing mode writes for a missing transaction', () => {
  const TS = Date.UTC(2026, 9, 10, 12, 0, 0);
  const pricing = (quote: { price: number | null; source: 'spot' | 'swap_1h' | 'unknown' }, minuteFrom = Infinity) => ({ quoteFor: () => quote, minuteFrom, mark: '2026-10-30' });
  const apply = (db: TestD1, sql: string[]) => { for (const s of sql) db.raw.exec(s); };
  const count = (db: TestD1) => ({
    flows: (db.raw.prepare('SELECT COUNT(*) n FROM flows').get() as any).n,
    moves: (db.raw.prepare('SELECT COUNT(*) n FROM moves').get() as any).n,
    legs: (db.raw.prepare('SELECT COUNT(*) n FROM pool_legs').get() as any).n,
    links: (db.raw.prepare('SELECT COALESCE(SUM(transfers), 0) n FROM address_links').get() as any).n,
  });

  it('a swap in 3005 at its block time: its own USDC price ("execution" before the minute quotes), its moves and pool legs, marked restored; applied twice, nothing changes', () => {
    const db = testD1();
    const r = repairRows(sell3005, TS, 'missing', ctx, pricing({ price: 0.002, source: 'swap_1h' }));
    apply(db, r.sql);
    const once = count(db);
    apply(db, r.sql);
    expect(count(db)).toEqual(once);
    expect(once).toMatchObject({ flows: r.flows, moves: r.moves, legs: r.legs });
    const want = parseOsmosisTx(normFromTxSearch(sell3005, TS), ctx);
    const f = db.raw.prepare('SELECT * FROM flows').get() as any;
    expect(f).toMatchObject({ id: want.flows[0].id, ts: TS, kind: 'sell', amount_num: want.flows[0].amount, counter_denom: 'USDC' });
    expect(f.price_usd).toBeCloseTo(want.flows[0].counterAmount! / want.flows[0].amount, 12);
    expect(JSON.parse(f.meta)).toMatchObject({ priceSource: 'execution', tsSource: 'block', via: 'history repair', restored: '2026-10-30' });
    expect(db.raw.prepare('SELECT address, idx, delta_num, ts FROM moves ORDER BY idx, address').all().map((x: any) => ({ ...x }))).toEqual(
      want.moves.map((m) => ({ address: m.address, idx: m.idx, delta_num: m.delta, ts: TS })).sort((a, b) => a.idx - b.idx || (a.address < b.address ? -1 : 1)));
    expect(db.raw.prepare('SELECT pool_id, denom, delta FROM pool_legs').all().map((x: any) => ({ ...x }))).toEqual([{ pool_id: '3005', denom: 'ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4', delta: '-1740431' }]);
  });

  it('a row with no price of its own takes the quote and says which; with none, no price and "unknown"', () => {
    const db = testD1();
    // the swap through 3368 and 3005 then 1212 and 678: its pools' coins are not one stable, so it is priced at the quote
    for (const [quote, price] of [[{ price: 0.0011, source: 'swap_1h' as const }, 0.0011], [{ price: null, source: 'unknown' as const }, null]] as const) {
      const r = repairRows(via3368, TS, 'missing', ctx, pricing(quote));
      db.raw.exec('DELETE FROM flows');
      apply(db, r.sql);
      let quoted = 0;
      for (const f of db.raw.prepare('SELECT price_usd, value_usd, amount_num, meta FROM flows').all() as any[]) {
        const m = JSON.parse(f.meta);
        if (m.priceSource === 'execution' || (m.priceSource == null && f.price_usd != null)) continue;
        quoted++;
        expect(f.price_usd).toBe(price);
        expect(f.value_usd).toBe(price == null ? null : price * f.amount_num);
        expect(m.priceSource).toBe(quote.source);
      }
      expect(quoted).toBeGreaterThan(0);
    }
  });

  it('a transaction in a pool\'s other coin alone: its pool legs and nothing else', () => {
    const db = testD1();
    const r = repairRows(withdraw, TS, 'legs', ctx, pricing({ price: 0.002, source: 'swap_1h' }));
    apply(db, r.sql);
    expect(count(db)).toEqual({ flows: 0, moves: 0, legs: 1, links: 0 });
    expect(db.raw.prepare('SELECT pool_id, delta, ts FROM pool_legs').get()).toMatchObject({ pool_id: '3005', delta: '-69912075', ts: TS });
  });
});

const fxHeight = (prefix: string) => Number([sell3005, via3009, via3368, withdraw, bid].find((t) => t.hash.startsWith(prefix))!.height);
