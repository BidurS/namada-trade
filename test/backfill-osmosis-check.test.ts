// Osmosis history repair (2026-10-29), scripts/backfill-osmosis.ts: how its report tells what the database lacks, and
// what its writing mode writes. Each transaction found is parsed as the hub parses it, the database is read for it by
// tx_hash only (through the moves primary key, flows_hash and pool_legs's primary key, read only), and it is judged
// per pool: a pool whose NAM it moves needs its NAM move at that pool's address; a pool whose other coins it moves (a
// swap's USDC or OSMO leg as much as a USDC-only withdrawal) needs its legs in pool_legs; a transaction with NAM rows of
// which nothing is stored is missing whole. The review of 2026-10-29 found a swap's USDC leg missing from pool_legs
// judged complete (the legs were judged only for a transaction that moved no NAM at the pool), and a transaction
// stored in part listed for a tool that writes no moves. No network: the transactions are fixtures (three swaps, the
// USDC-only withdrawal EBDEAC7A... from 3005 and a bid on the 3008 book), and the database is the SQLite stand-in with
// the migrations, read through scripts/d1-readonly.ts.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FILE_BYTES, judge, loadProgress, packFiles, repairRows, seenOf, seenToJson, storedOf, type Seen } from '../scripts/backfill-osmosis';
import { readOnlyD1, type Runner } from '../scripts/d1-readonly';
import { sqlStatements } from '../scripts/sql-statements';
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
const USDC_3005 = 'ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4';

/** wrangler's --json answer for one statement, from the stand-in (as test/d1-readonly.test.ts). */
const sqliteRunner = (db: TestD1): Runner => async (sql) => JSON.stringify([{ results: db.raw.prepare(sql).all().map((r: object) => ({ ...r })), success: true, meta: { rows_read: 1 } }]);
const parsed = (t: any) => parseOsmosisTx(normFromTxSearch(t, 1), ctx);

/** Queries 0 to 3 are the stream's four; then each pool's two (sender, recipient), in the order of `pools`. */
const poolQueryOf = new Map(pools.flatMap((p, i) => [[4 + 2 * i, p.address], [5 + 2 * i, p.address]] as [number, string][]));
const sender = (addr: string) => 4 + 2 * pools.findIndex((p) => p.address === addr);
const recipient = (addr: string) => sender(addr) + 1;

async function world() {
  const db = testD1();
  // the 3005 sell's NAM rows stored whole, as the hub wrote them before migration 0018: its USDC leg is not
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
const fxHeight = (prefix: string) => Number([sell3005, via3009, via3368, withdraw, bid].find((t) => t.hash.startsWith(prefix))!.height);

describe('what the database lacks, per pool', () => {
  it('a pool\'s NAM move stored, one stored in part, one missing whole, a swap\'s and a withdrawal\'s pool leg missing, a bid\'s stored', async () => {
    const { db, seen } = await world();
    const { db: ro, ran } = readOnlyD1(sqliteRunner(db), { pauseMs: 0 });
    const stored = await storedOf(ro, [...seen.keys()]);
    expect(stored.legs).not.toBeNull();
    const j = judge(seen, stored, pools, poolQueryOf);
    const per = Object.fromEntries(j.perPool.map((x) => [x.pool.id, { nam: x.nam, other: x.other }]));
    expect(per).toEqual({
      // the sell (found by the NAM query and 3005's sends) moves 3005's NAM and USDC, the withdrawal its USDC alone;
      // the swap through 3368 moves 3005 too, but only the pools whose queries found a transaction count it
      '3005': { nam: { chain: 1, stored: 1 }, other: { chain: 2, stored: 0, only: 1 } },
      '3008': { nam: { chain: 0, stored: 0 }, other: { chain: 1, stored: 1, only: 1 } },
      // found by both of 3368's queries: one transaction, its NAM and its other coin
      '3368': { nam: { chain: 1, stored: 0 }, other: { chain: 1, stored: 0, only: 0 } },
      '3009': { nam: { chain: 1, stored: 0 }, other: { chain: 1, stored: 0, only: 0 } },
    });
    expect(j.missing.map((m) => [m.s.hash.slice(0, 8), m.verdict, m.pools])).toEqual([
      ['7AB4C4B8', 'part', ['3368']],
      ['11E5437E', 'missing', ['3009']],
      // the review's case: the sell's NAM rows are stored and its 3005 USDC leg is not
      ['DF95296C', 'legs', ['3005']],
      ['EBDEAC7A', 'legs', ['3005']],
    ]);
    // three swaps make NAM rows; two of them have rows stored
    expect([j.rowsChain, j.rowsStored]).toEqual([3, 2]);
    // read only: the table check, then moves, flows and pool_legs for the hashes, one statement each
    expect(ran.map((r) => r.sql.split(' ').slice(0, 6).join(' '))).toEqual([
      'SELECT COUNT(*) AS n FROM sqlite_master',
      'SELECT tx_hash, address, idx, delta_num FROM',
      'SELECT DISTINCT tx_hash FROM flows WHERE',
      'SELECT DISTINCT tx_hash, address FROM pool_legs',
    ]);
    // each transaction's stored moves come back with their index and NAM
    expect(stored.moveRows.get(sell3005.hash)!.length).toBe(parsed(sell3005).moves.length);
  });

  it('a swap whose NAM rows and pool legs are both stored is not listed', async () => {
    const { db, seen } = await world();
    await runBatch(db as any, poolLegsOf(normFromTxSearch(sell3005, 1), ctx.poolAddrs).map(stmt.poolLeg));
    const { db: ro } = readOnlyD1(sqliteRunner(db), { pauseMs: 0 });
    const j = judge(seen, await storedOf(ro, [...seen.keys()]), pools, poolQueryOf);
    expect(j.missing.map((m) => m.s.hash.slice(0, 8))).not.toContain('DF95296C');
    expect(j.perPool.find((x) => x.pool.id === '3005')!.other).toEqual({ chain: 2, stored: 1, only: 1 });
  });

  it('before migration 0018 every transaction moving a pool\'s other coin is missing its legs, and the rest is judged as before', async () => {
    const { db, seen } = await world();
    db.exec('DROP TABLE pool_legs');
    const { db: ro, ran } = readOnlyD1(sqliteRunner(db), { pauseMs: 0 });
    const stored = await storedOf(ro, [...seen.keys()]);
    expect(stored.legs).toBeNull();
    const j = judge(seen, stored, pools, poolQueryOf);
    expect(j.missing.map((m) => [m.s.hash.slice(0, 8), m.verdict])).toEqual([['7AB4C4B8', 'part'], ['11E5437E', 'missing'], ['DF95296C', 'legs'], ['EBDEAC7A', 'legs'], ['C8735FE2', 'legs']].sort((a, b) => (fxHeight(a[0]) - fxHeight(b[0]))));
    expect(ran.some((r) => r.sql.includes('pool_legs WHERE'))).toBe(false);
  });

  it('every read goes through an index: the moves primary key, flows_hash, pool_legs\'s primary key', async () => {
    const { db } = await world();
    const plan = (sql: string) => db.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((r: any) => r.detail).join('; ');
    expect(plan(`SELECT tx_hash, address, idx, delta_num FROM moves WHERE chain = 'osmosis' AND tx_hash IN ('A','B')`)).toMatch(/USING (COVERING )?INDEX sqlite_autoindex_moves_1 \(chain=\? AND tx_hash=\?\)/);
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
  const moveRows = (db: TestD1) => db.raw.prepare('SELECT address, idx, delta_num FROM moves ORDER BY idx, address').all().map((x: any) => ({ ...x }));

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
    expect(db.raw.prepare('SELECT pool_id, denom, delta FROM pool_legs').all().map((x: any) => ({ ...x }))).toEqual([{ pool_id: '3005', denom: USDC_3005, delta: '-1740431' }]);
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

  it('a swap whose NAM rows are stored and whose USDC leg is not: the leg alone, and the NAM rows are as they were', async () => {
    const { db, seen } = await world();
    const before = { flows: db.raw.prepare('SELECT * FROM flows ORDER BY id').all(), moves: moveRows(db) };
    const r = repairRows(sell3005, TS, 'legs', ctx, pricing({ price: 0.002, source: 'swap_1h' }));
    expect([r.flows, r.moves, r.legs]).toEqual([0, 0, 1]);
    apply(db, r.sql);
    apply(db, r.sql);
    expect({ flows: db.raw.prepare('SELECT * FROM flows ORDER BY id').all(), moves: moveRows(db) }).toEqual(before);
    expect(db.raw.prepare(`SELECT pool_id, denom, delta FROM pool_legs WHERE tx_hash = ?`).all(sell3005.hash).map((x: any) => ({ ...x }))).toEqual([{ pool_id: '3005', denom: USDC_3005, delta: '-1740431' }]);
    // judged again, it is no longer listed
    const { db: ro } = readOnlyD1(sqliteRunner(db), { pauseMs: 0 });
    expect(judge(seen, await storedOf(ro, [...seen.keys()]), pools, poolQueryOf).missing.map((m) => m.s.hash)).not.toContain(sell3005.hash);
  });

  it('a transaction stored in part: the moves at the addresses none of its stored moves is at, and its legs; applied twice, the moves are the parser\'s', async () => {
    const { db } = await world();
    const { db: ro } = readOnlyD1(sqliteRunner(db), { pauseMs: 0 });
    const have = (await storedOf(ro, [via3368.hash])).moveRows.get(via3368.hash)!;
    const r = repairRows(via3368, TS, 'part', ctx, pricing({ price: 0.002, source: 'swap_1h' }), have);
    expect(r.differs).toBeUndefined();
    const want = parsed(via3368).moves;
    expect(r.moves).toBe(want.filter((m) => m.address === P3368).length);
    expect(r.flows).toBe(0);
    const flowsBefore = db.raw.prepare('SELECT * FROM flows ORDER BY id').all();
    apply(db, r.sql);
    apply(db, r.sql);
    expect(db.raw.prepare('SELECT address, idx, delta_num FROM moves WHERE tx_hash = ? ORDER BY idx, address').all(via3368.hash).map((x: any) => ({ ...x }))).toEqual(
      want.map((m) => ({ address: m.address, idx: m.idx, delta_num: m.delta })).sort((a, b) => a.idx - b.idx || (a.address < b.address ? -1 : 1)));
    expect(db.raw.prepare('SELECT * FROM flows ORDER BY id').all()).toEqual(flowsBefore);
    expect((db.raw.prepare('SELECT COUNT(*) n FROM pool_legs WHERE tx_hash = ?').get(via3368.hash) as any).n).toBe(r.legs);
  });

  it('a transaction stored otherwise than the parser reads it is not written, and says how', async () => {
    const { db } = await world();
    db.raw.prepare('UPDATE moves SET delta_num = delta_num + 1 WHERE tx_hash = ? AND rowid = (SELECT MIN(rowid) FROM moves WHERE tx_hash = ?)').run(via3368.hash, via3368.hash);
    const { db: ro } = readOnlyD1(sqliteRunner(db), { pauseMs: 0 });
    const have = (await storedOf(ro, [via3368.hash])).moveRows.get(via3368.hash)!;
    const r = repairRows(via3368, TS, 'part', ctx, pricing({ price: 0.002, source: 'swap_1h' }), have);
    expect(r.sql).toEqual([]);
    expect(r.differs).toMatch(/^a stored move \(osmo1.+, index \d+, -?[\d.]+ NAM\) the parser does not give$/);
  });
});

describe('the repair files', () => {
  const unit = (hash: string, n: number, bytes: number) => ({ hash, sql: Array.from({ length: n }, (_, i) => `INSERT OR IGNORE INTO kv (key, value, updated_at) VALUES ('${hash}-${i}', '${'x'.repeat(bytes)}', 0);`) });

  it('a transaction\'s statements are never split between two files, and each file is one batch of scripts/d1-apply.ts', () => {
    const units = Array.from({ length: 40 }, (_, i) => unit(`T${i}`, 1 + (i % 7), 1500 + 37 * i));
    const files = packFiles(units);
    expect(files.length).toBeGreaterThan(1);
    expect(files.flat()).toEqual(units.flatMap((u) => u.sql));
    // d1-apply sends a file's statements in one command while their bytes, each with 2 more, stay within MAX_BYTES
    const maxBytes = Number(/const MAX_BYTES = ([\d_]+);/.exec(readFileSync(join(__dirname, '..', 'scripts', 'd1-apply.ts'), 'utf8'))![1].replace(/_/g, ''));
    expect(FILE_BYTES).toBeLessThan(maxBytes);
    for (const f of files) {
      const stmts = sqlStatements(f.join('\n') + '\n');
      expect(stmts.reduce((a, s) => a + s.length + 2, 0)).toBeLessThanOrEqual(maxBytes);
      for (const u of units) {
        const inFile = u.sql.filter((s) => f.includes(s)).length;
        expect([0, u.sql.length]).toContain(inFile);
      }
    }
  });

  it('a transaction larger than a file stops the run, named', () => {
    expect(() => packFiles([unit('SMALL', 1, 10), unit('HUGE', 30, 3000)])).toThrow(/transaction HUGE: \d+ bytes of statements, more than one file holds/);
  });

  it('a bridge receive\'s link goes before its flow, in one file: applied twice it is counted once, where a cut between them would count it twice', () => {
    const recv = fx('osmo_ibc_recv.json')[0];
    const r = repairRows(recv, Date.UTC(2026, 9, 10), 'missing', ctx, { quoteFor: () => ({ price: null, source: 'unknown' }), minuteFrom: Infinity, mark: '2026-10-30' });
    const linkAt = r.sql.findIndex((x) => x.startsWith('INSERT INTO address_links'));
    expect(linkAt).toBeGreaterThanOrEqual(0);
    expect(linkAt).toBeLessThan(r.sql.findIndex((x) => /^INSERT OR REPLACE INTO flows /.test(x)));
    const files = packFiles([unit('BEFORE', 50, 1600), { hash: recv.hash, sql: r.sql }]);
    expect(files.filter((f) => f.some((x) => r.sql.includes(x))).length).toBe(1);
    const transfers = (db: TestD1) => (db.raw.prepare('SELECT COALESCE(SUM(transfers), 0) n FROM address_links').get() as any).n;
    const whole = testD1();
    for (let i = 0; i < 2; i++) for (const x of r.sql) whole.raw.exec(x);
    expect(transfers(whole)).toBe(1);
    // the link applied on its own, then the whole again: why packFiles never cuts a transaction
    const cut = testD1();
    cut.raw.exec(r.sql[linkAt]);
    for (const x of r.sql) cut.raw.exec(x);
    expect(transfers(cut)).toBe(2);
  });
});

describe('the progress a stopped run keeps', () => {
  it('each transaction read comes back as the run had it, and a file of another run, or a line cut short, is not read', async () => {
    const { seen } = await world();
    const head = { from: 1, to: 2, deepFirst: 900, queries: ['a', 'b'], poolAddrs: [P3005] };
    const lines = [JSON.stringify(head)];
    const byQuery = new Map<number, Seen[]>();
    for (const s of seen.values()) for (const q of s.found) (byQuery.get(q) ?? byQuery.set(q, []).get(q)!).push(s);
    for (const [q, list] of byQuery) lines.push(JSON.stringify({ q, page: 3, txs: list.map(seenToJson) }));
    lines.push(JSON.stringify({ q: 1, done: true, inRange: 1, total: 9 }));
    lines.push('{"q": 4, "page": 4, "txs": [{"hash"');
    const back = new Map<string, Seen>();
    const kept = loadProgress(lines.join('\n') + '\n', head, back)!;
    expect(back).toEqual(seen);
    expect(kept.done).toEqual(new Map([[1, { inRange: 1, total: 9 }]]));
    expect(kept.pages.get(4)).toBe(3);
    expect(loadProgress(lines.join('\n'), { ...head, to: 3 }, new Map())).toBeNull();
  });
});

