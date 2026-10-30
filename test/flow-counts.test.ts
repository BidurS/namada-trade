// Stage 1 (scale plan item 6): the moves list's first page is counted from stored counts (migration 0017) plus the
// moves since their mark, exactly; the triggers mark the counts dirty for any write that could change them, the cron
// writes them whole or moves them on; every other count reads at most COUNT_MAX + 1 moves and says "more than" past it.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { testD1, insert, runStmts, type TestD1 } from './d1-sqlite';
import {
  COUNT_MAX, FLOW_SIZE_STEPS, KIND_GROUPS, TWIN_WINDOW_MS, flowsCountSql, flowsMode, storedCountSql, storedTotal,
  type FlowsFilter, type StoredCountRow,
} from '../worker/src/flows-query';
import { FLOW_COUNT_LAG_MS, FLOW_COUNT_STEP_MS, FLOW_RECOUNT_GAP_MS, refreshFlowCounts } from '../worker/src/flow-counts';
import { stmt } from '../worker/src/db';
import { app } from '../worker/src/api';
import type { Flow, FlowsResponse } from '../shared/types';

const MIGRATION = readFileSync(join(__dirname, '..', 'migrations', '0017_flow_counts.sql'), 'utf8');
const MIN = 60_000;
const H = 3_600_000;
const B32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const tn = (n: number) => `tnam1q${B32[n % 32]}${B32[Math.floor(n / 32) % 32]}${'q'.repeat(37)}`;
const os = (n: number) => `osmo1${B32[n % 32]}${B32[Math.floor(n / 32) % 32]}${'q'.repeat(36)}`;
const hex = (n: number) => n.toString(16).toUpperCase().padStart(64, '0');

type Row = Record<string, unknown>;
const KINDS = ['buy', 'sell', 'ibc_in', 'ibc_out', 'other', 'bond', 'transfer', 'lp_add', 'shield', 'unshield', 'withdraw', 'rewards'];
const AMOUNTS = [5, 500, 1_000, 1_500, 10_000, 15_000, 100_000, 150_000];

/**
 * A mix of every kind of row the counts tell apart, from `from` to `to` (unix ms): both chains, every kind, each size
 * step and its bounds, bot round trips, bridge refunds, another coin, crossings recorded on both chains (some across
 * any mark between), older Namada twins.
 */
function mix(from: number, to: number, n: number, seed = 1): Row[] {
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  const rows: Row[] = [];
  for (let i = 0; i < n; i++) {
    const ts = Math.round(from + ((to - from) * i) / n);
    const chain = i % 2 ? 'osmosis' : 'namada';
    const kind = KINDS[Math.floor(rnd() * KINDS.length)];
    const amount = AMOUNTS[Math.floor(rnd() * AMOUNTS.length)];
    const r = rnd();
    const meta = r < 0.1 ? { arb: true } : r < 0.18 ? { tokenSymbol: 'USDC' } : r < 0.24 && kind === 'other' ? { ibcTimeoutRefund: true } : r < 0.4 && chain === 'namada' ? { innerTxHash: hex(900_000 + i) } : r < 0.5 ? { source: 'indexer' } : null;
    const id = `${chain}:${hex(seed * 100_000 + i)}:0`;
    rows.push({ id, chain, height: seed * 100_000 + i, ts, tx_hash: hex(seed * 100_000 + i), kind, from_addr: chain === 'osmosis' ? os(i) : tn(i), to_addr: i % 3 ? tn(i + 1) : os(i + 1), amount_num: amount, meta: meta ? JSON.stringify(meta) : null });
    // a crossing: received on Osmosis, sent from Namada up to 14 minutes before or after (so some straddle a mark)
    if (i % 7 === 0) {
      const amt = AMOUNTS[i % AMOUNTS.length];
      const off = Math.round((rnd() - 0.5) * 28 * MIN);
      rows.push({ id: `osmosis:${hex(seed * 100_000 + 50_000 + i)}:ibc_in:0`, chain: 'osmosis', height: seed * 100_000 + 50_000 + i, ts, tx_hash: hex(seed * 100_000 + 50_000 + i), kind: 'ibc_in', from_addr: tn(i), to_addr: os(i + 7), amount_num: amt, meta: null });
      rows.push({ id: `namada:${hex(seed * 100_000 + 60_000 + i)}:0`, chain: 'namada', height: seed * 100_000 + 60_000 + i, ts: ts + off, tx_hash: hex(seed * 100_000 + 60_000 + i), kind: 'ibc_out', from_addr: tn(i), to_addr: os(i + 7), amount_num: amt, meta: JSON.stringify({ innerTxHash: hex(seed * 100_000 + 70_000 + i) }) });
    }
    // an older twin: the same transfer under its inner hash (no innerTxHash, no source) in the same block
    if (i % 11 === 0 && chain === 'namada') {
      const inner = hex(seed * 100_000 + 80_000 + i);
      rows.push({ id: `namada:${hex(seed * 100_000 + 90_000 + i)}:0`, chain: 'namada', height: seed * 100_000 + 85_000 + i, ts, tx_hash: hex(seed * 100_000 + 90_000 + i), kind: 'transfer', from_addr: tn(i), to_addr: tn(i + 2), amount_num: 2_000, meta: JSON.stringify({ innerTxHash: inner }) });
      rows.push({ id: `namada:${inner}:1`, chain: 'namada', height: seed * 100_000 + 85_000 + i, ts: ts + 1_000, tx_hash: inner, kind: 'transfer', from_addr: tn(i), to_addr: tn(i + 2), amount_num: 2_000, meta: null });
    }
  }
  return rows;
}

/** Every combination of the stored counts' columns (and a kind no row has). */
function filters(asOf: number): FlowsFilter[] {
  const out: FlowsFilter[] = [];
  const sizes: Partial<FlowsFilter>[] = [{}, { whale: true }, ...FLOW_SIZE_STEPS.map((m) => ({ minNam: m })), { whale: true, minNam: 1_000 }, { whale: true, minNam: 100_000 }];
  for (const chain of [null, 'namada', 'osmosis'])
    for (const kind of [null, ...Object.keys(KIND_GROUPS), 'buy', 'ibc_in', 'ibc_out', 'other', 'bond', 'nothing'])
      for (const onePerCrossing of [false, true])
        for (const excludeBots of [false, true])
          for (const s of sizes) out.push({ asOf, chain, kind, onePerCrossing, excludeBots, ...s });
  return out;
}

/** The count of a filter, every move read (the count before the stored counts). */
async function direct(db: TestD1, f: FlowsFilter): Promise<number> {
  const q = flowsCountSql(f, flowsMode(f) as 'time' | 'kind');
  return Number((await db.prepare(q.sql).bind(...q.params).first<{ total: number }>())!.total);
}
async function stored(db: TestD1, f: FlowsFilter): Promise<number | null> {
  const q = storedCountSql(f)!;
  return storedTotal(await db.prepare(q.sql).bind(...q.params).first<StoredCountRow>(), f.asOf);
}
const mark = (db: TestD1) => db.raw.prepare('SELECT mark, dirty, at FROM flow_count_mark WHERE id = 1').get() as { mark: number | null; dirty: number; at: number | null };

/** Every statement the route prepares. */
function spied(db: TestD1) {
  const seen: string[] = [];
  const wrapped = { ...db, prepare: (sql: string) => { seen.push(sql); return db.prepare(sql); }, batch: db.batch };
  return { wrapped, seen };
}
/** The full count of the moves list (every move read, with the crossing lookup), as flowsCountSql writes it. */
const isFullCount = (sql: string) => /^SELECT COUNT\(\*\) total FROM flows f INDEXED BY/.test(sql.trim());

describe('migration 0017: the stored counts and their triggers', () => {
  it('starts dirty with no mark; its window is the crossing window', () => {
    const db = testD1();
    expect(mark(db)).toEqual({ mark: null, dirty: 1, at: null });
    const margins = [...MIGRATION.replace(/--[^\n]*/g, '').matchAll(/m\.mark \+ (\d+)/g)].map((m) => Number(m[1]));
    expect(margins.length).toBeGreaterThanOrEqual(5);
    expect(new Set(margins)).toEqual(new Set([TWIN_WINDOW_MS]));
    const triggers = (db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'flows' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    expect(triggers).toEqual(['flow_counts_ad', 'flow_counts_au', 'flow_counts_bi']);
  });
});

describe('the stored count is exact for every filter it answers', () => {
  it('live: the stored counts up to the mark plus the moves since, for 840 combinations of chain, kind, crossings, bots and size', async () => {
    const now = Date.now();
    const db = testD1();
    insert(db, 'flows', mix(now - 8 * H, now - MIN, 700));
    expect(await refreshFlowCounts(db as any, now)).toBe('whole');
    const m = mark(db);
    expect(m.dirty).toBe(0);
    expect(m.mark).toBe(Math.floor((now - FLOW_COUNT_LAG_MS) / MIN) * MIN);
    // rows on both sides of the mark, and crossings across it
    expect((db.raw.prepare('SELECT COUNT(*) n FROM flows WHERE ts > ?').get(m.mark) as { n: number }).n).toBeGreaterThan(100);
    const fs = filters(now);
    expect(fs.length).toBe(840);
    for (const f of fs) expect(await stored(db, f), JSON.stringify(f)).toBe(await direct(db, f));
    // the default list (each crossing once) leaves out received twins and older twins: the mix has both
    expect(await direct(db, { asOf: now, onePerCrossing: true })).toBeLessThan(await direct(db, { asOf: now }));
    expect(await direct(db, { asOf: now })).toBeLessThan((db.raw.prepare('SELECT COUNT(*) n FROM flows').get() as { n: number }).n);
  });

  it('rewound: before the mark the moves after the rewound time are taken away; past COUNT_MAX of them it says nothing', async () => {
    const now = Date.now();
    const db = testD1();
    insert(db, 'flows', mix(now - 8 * H, now - MIN, 500));
    await refreshFlowCounts(db as any, now);
    for (const at of [now - 2.5 * H, now - 5 * H, now - 7.9 * H, now - 9 * H])
      for (const f of filters(at).filter((_, i) => i % 7 === 0)) expect(await stored(db, f), `${at} ${JSON.stringify(f)}`).toBe(await direct(db, f));
    // more than COUNT_MAX moves between the rewound time and the mark: not said (the route then counts, bounded)
    const r = { mark: mark(db).mark, dirty: 0, stored: 50_000, delta: COUNT_MAX + 1 };
    expect(storedTotal(r, now - 9 * H)).toBeNull();
    expect(storedTotal({ ...r, delta: COUNT_MAX }, now - 9 * H)).toBe(50_000 - COUNT_MAX);
    expect(storedTotal({ ...r, dirty: 1, delta: 0 }, now)).toBeNull();
    expect(storedTotal({ ...r, mark: null, delta: 0 }, now)).toBeNull();
    expect(storedTotal(null, now)).toBeNull();
  });

  it('only the filters that are its columns: a text search, a time window, an address, a record, a block or another size are counted on the moves', () => {
    const asOf = Date.now();
    expect(storedCountSql({ asOf })).not.toBeNull();
    for (const f of [{ search: 'abc' }, { since: asOf - H }, { addr: tn(1) }, { hash: 'ABCDEF12' }, { height: 5 }, { minNam: 5_000 }, { minNam: 1 }]) expect(storedCountSql({ asOf, ...f }), JSON.stringify(f)).toBeNull();
  });

  it('reads the moves since the mark on flows_ts, a range, and the counts table without a pass over the moves', () => {
    const db = testD1();
    const q = storedCountSql({ asOf: Date.now(), onePerCrossing: true, kind: 'dex' })!;
    const plan = (db.raw.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...q.params) as { detail: string }[]).map((r) => r.detail).join(' | ');
    expect(plan).toMatch(/SEARCH f USING INDEX flows_ts \(ts>\? AND ts<\?\)/);
    expect(plan).not.toMatch(/SCAN f\b/);
    expect(plan).not.toMatch(/SCAN flows\b/);
  });
});

describe('the triggers mark the counts dirty for every write that could change them, and only those', () => {
  const setup = async () => {
    const now = Date.now();
    const db = testD1();
    insert(db, 'flows', mix(now - 8 * H, now - 10 * MIN, 300));
    await refreshFlowCounts(db as any, now);
    const m = mark(db).mark!;
    const at = (ts: number, i: number, extra: Partial<Flow> = {}): Flow => ({ id: `osmosis:${hex(7_000_000 + i)}:0`, chain: 'osmosis', height: 7_000_000 + i, ts, txHash: hex(7_000_000 + i), kind: 'sell', from: os(900 + i), to: null, amount: 12_000, ...extra } as Flow);
    return { now, db, m, at };
  };
  const dirty = (db: TestD1) => mark(db).dirty === 1;
  const clean = (db: TestD1) => db.raw.exec('UPDATE flow_count_mark SET dirty = 0 WHERE id = 1');

  it('a move written as it happens (after mark + 15 minutes) leaves them clean and is counted live', async () => {
    const { now, db, m, at } = await setup();
    const before = await stored(db, { asOf: now, onePerCrossing: true });
    await runStmts(db, [stmt.flow(at(m + TWIN_WINDOW_MS + 1, 1)), stmt.flow(at(now - MIN, 2))]);
    expect(dirty(db)).toBe(false);
    expect(await stored(db, { asOf: now, onePerCrossing: true })).toBe(before! + 2);
    expect(await stored(db, { asOf: now, onePerCrossing: true })).toBe(await direct(db, { asOf: now, onePerCrossing: true }));
  });

  it('a move written up to mark + 15 minutes, or before the mark (a catch-up, a backfill), marks them dirty', async () => {
    const { db, m, at } = await setup();
    await runStmts(db, [stmt.flow(at(m + TWIN_WINDOW_MS, 1))]);
    expect(dirty(db)).toBe(true);
    clean(db);
    await runStmts(db, [stmt.flow(at(m - 3 * H, 2))]);
    expect(dirty(db)).toBe(true);
    clean(db);
    // INSERT OR IGNORE of a row already stored (a backfill run again): marked, a count again and nothing lost
    const row = db.raw.prepare('SELECT * FROM flows WHERE ts <= ? LIMIT 1').get(m) as Row;
    db.raw.prepare('INSERT OR IGNORE INTO flows (id, chain, height, ts, tx_hash, kind, amount_num) VALUES (?, ?, ?, ?, ?, ?, ?)').run(row.id, row.chain, row.height, row.ts, row.tx_hash, row.kind, row.amount_num);
    expect(dirty(db)).toBe(true);
  });

  it('a sending side written just after the mark that makes a received crossing before it a twin: dirty, and the count stays exact', async () => {
    const { now, db, m } = await setup();
    // a received crossing 5 minutes before the mark, not yet a twin (no sending side), so counted under pairs=one; it
    // marks the counts dirty (it is before the mark), and the tick writes them whole with it
    insert(db, 'flows', [{ id: 'osmosis:TWINRECV:ibc_in:0', chain: 'osmosis', height: 9_000_001, ts: m - 5 * MIN, tx_hash: 'TWINRECV', kind: 'ibc_in', from_addr: tn(5), to_addr: os(5), amount_num: 4_321, meta: null }]);
    expect(dirty(db)).toBe(true);
    expect(await refreshFlowCounts(db as any, now + FLOW_RECOUNT_GAP_MS)).toBe('whole');
    expect(dirty(db)).toBe(false);
    const f = { asOf: now, onePerCrossing: true };
    const n = await stored(db, f);
    // its sending side, 8 minutes later (3 minutes after the mark): the received row is now left out
    await runStmts(db, [stmt.flow({ id: 'namada:TWINSEND:0', chain: 'namada', height: 9_000_002, ts: m + 3 * MIN, txHash: 'TWINSEND', kind: 'ibc_out', from: tn(5), to: os(5), amount: 4_321, meta: { innerTxHash: 'X1' } } as Flow)]);
    expect(dirty(db)).toBe(true);
    // the route counts the moves itself while dirty: one more row and one row fewer, so the same number, exactly
    const r = (await (await app.request('/api/flows?pairs=one&limit=10', {}, { DB: db } as any)).json()) as FlowsResponse;
    expect(r.total).toBe(await direct(db, f));
    expect(r.total).toBe(n);
    // the next tick a gap on writes them whole and they answer again
    expect(await refreshFlowCounts(db as any, now + 2 * FLOW_RECOUNT_GAP_MS)).toBe('whole');
    expect(await stored(db, f)).toBe(await direct(db, f));
  });

  it('a row replaced (the same id, or a Namada row of the same block) whose old copy was in the window: dirty, even when the new one is later', async () => {
    const { now, db, m } = await setup();
    const old = db.raw.prepare("SELECT * FROM flows WHERE chain = 'osmosis' AND ts <= ? LIMIT 1").get(m) as Row;
    await runStmts(db, [stmt.flow({ id: String(old.id), chain: 'osmosis', height: Number(old.height), ts: now - MIN, txHash: String(old.tx_hash), kind: 'buy', from: os(1), to: null, amount: 9 } as Flow)]);
    expect(dirty(db)).toBe(true);
    clean(db);
    // the guard of migration 0004 replaces an older twin of the same block under another id
    const nam = db.raw.prepare("SELECT * FROM flows WHERE chain = 'namada' AND ts <= ? AND meta IS NULL LIMIT 1").get(m) as Row;
    await runStmts(db, [stmt.flow({ id: `namada:WRAPPERHASH:${String(nam.id).split(':')[2]}`, chain: 'namada', height: Number(nam.height), ts: now - MIN, txHash: 'WRAPPERHASH', kind: String(nam.kind), from: tn(1), to: tn(2), amount: 1, meta: { innerTxHash: String(nam.tx_hash) } } as Flow)]);
    expect(dirty(db)).toBe(true);
  });

  it('a delete in the window, or a change of a column the counts read: dirty; a price repair or a change after the window: clean', async () => {
    const { now, db, m } = await setup();
    const inWin = db.raw.prepare('SELECT id FROM flows WHERE ts <= ? LIMIT 1').get(m) as { id: string };
    db.raw.prepare('UPDATE flows SET price_usd = 0.01, value_usd = 1 WHERE id = ?').run(inWin.id);
    expect(dirty(db)).toBe(false);
    db.raw.prepare(`UPDATE flows SET meta = '{"arb":true}' WHERE id = ?`).run(inWin.id);
    expect(dirty(db)).toBe(true);
    clean(db);
    db.raw.prepare('DELETE FROM flows WHERE id = ?').run(inWin.id);
    expect(dirty(db)).toBe(true);
    clean(db);
    const late = db.raw.prepare('SELECT id FROM flows WHERE ts > ? ORDER BY ts DESC LIMIT 1').get(m + TWIN_WINDOW_MS) as { id: string };
    db.raw.prepare("UPDATE flows SET kind = 'buy' WHERE id = ?").run(late.id);
    db.raw.prepare('DELETE FROM flows WHERE id = ?').run(late.id);
    expect(dirty(db)).toBe(false);
    // a move pulled back into the window by a time repair
    const late2 = db.raw.prepare('SELECT id FROM flows WHERE ts > ? ORDER BY ts DESC LIMIT 1').get(m + TWIN_WINDOW_MS) as { id: string };
    db.raw.prepare('UPDATE flows SET ts = ? WHERE id = ?').run(m - H, late2.id);
    expect(dirty(db)).toBe(true);
    expect(await refreshFlowCounts(db as any, now + FLOW_RECOUNT_GAP_MS)).toBe('whole');
    for (const f of filters(now).filter((_, i) => i % 5 === 0)) expect(await stored(db, f), JSON.stringify(f)).toBe(await direct(db, f));
  });
});

describe('the cron keeps them: written whole when dirty, moved on by the hour, never past a write it did not see', () => {
  it('moves the mark on by the moves since it, and the counts are those a whole count gives', async () => {
    const t0 = Date.now() - 6 * H;
    const db = testD1();
    insert(db, 'flows', mix(t0 - 8 * H, t0 + 5 * H, 600));
    expect(await refreshFlowCounts(db as any, t0)).toBe('whole');
    const m0 = mark(db).mark!;
    // not due within the hour
    expect(await refreshFlowCounts(db as any, t0 + FLOW_COUNT_STEP_MS - MIN)).toBeNull();
    expect(mark(db).mark).toBe(m0);
    expect(await refreshFlowCounts(db as any, t0 + FLOW_COUNT_STEP_MS + MIN)).toBe('step');
    const m1 = mark(db).mark!;
    expect(m1).toBe(Math.floor((t0 + FLOW_COUNT_STEP_MS + MIN - FLOW_COUNT_LAG_MS) / MIN) * MIN);
    expect(mark(db).dirty).toBe(0);
    const stepped = db.raw.prepare('SELECT chain, kind, twin, bot, size, n FROM flow_counts ORDER BY 1, 2, 3, 4, 5').all();
    // the same counts as a whole count at the new mark
    const fresh = testD1();
    insert(fresh, 'flows', db.raw.prepare('SELECT * FROM flows').all() as Row[]);
    await refreshFlowCounts(fresh as any, t0 + FLOW_COUNT_STEP_MS + MIN);
    expect(fresh.raw.prepare('SELECT chain, kind, twin, bot, size, n FROM flow_counts ORDER BY 1, 2, 3, 4, 5').all()).toEqual(stepped);
    expect(mark(fresh).mark).toBe(m1);
    const now = Date.now();
    for (const f of filters(now).filter((_, i) => i % 3 === 0)) expect(await stored(db, f), JSON.stringify(f)).toBe(await direct(db, f));
  });

  it('a write that marks them dirty while the step is being written: the step adds nothing and the mark stays', async () => {
    const t0 = Date.now() - 6 * H;
    const db = testD1();
    insert(db, 'flows', mix(t0 - 8 * H, t0 + 5 * H, 300));
    await refreshFlowCounts(db as any, t0);
    const m0 = mark(db).mark!;
    const before = db.raw.prepare('SELECT SUM(n) n FROM flow_counts').get();
    // the write lands between the cron's read of the mark and its transaction
    const racing = { ...db, batch: async (stmts: any[]) => { db.raw.exec('UPDATE flow_count_mark SET dirty = 1 WHERE id = 1'); return db.batch(stmts); } };
    expect(await refreshFlowCounts(racing as any, t0 + 2 * H)).toBe('step');
    expect(mark(db)).toMatchObject({ mark: m0, dirty: 1 });
    expect(db.raw.prepare('SELECT SUM(n) n FROM flow_counts').get()).toEqual(before);
    // the next tick writes them whole
    expect(await refreshFlowCounts(db as any, t0 + 2 * H)).toBe('whole');
    expect(mark(db).dirty).toBe(0);
  });

  it('dirty again within FLOW_RECOUNT_GAP_MS of a write: not written whole until the gap has passed, so a catch-up costs one whole write a gap', async () => {
    const t0 = Date.now() - 6 * H;
    const db = testD1();
    insert(db, 'flows', mix(t0 - 8 * H, t0 + 5 * H, 200));
    // never written: at once
    expect(await refreshFlowCounts(db as any, t0)).toBe('whole');
    // a catch-up writing a move older than the mark on every tick for an hour
    const { wrapped, seen } = spied(db);
    const done: (string | null)[] = [];
    for (let k = 1; k <= 60; k++) {
      await runStmts(db, [stmt.flow({ id: `osmosis:${hex(8_000_000 + k)}:0`, chain: 'osmosis', height: 8_000_000 + k, ts: mark(db).mark! - H, txHash: hex(8_000_000 + k), kind: 'sell', from: os(k), to: null, amount: 3_000 } as Flow)]);
      done.push(await refreshFlowCounts(wrapped as any, t0 + k * MIN));
    }
    // one whole write a quarter hour (at 15, 30, 45 and 60 minutes), each from every move
    expect(done.map((d, i) => (d ? i + 1 : 0)).filter(Boolean)).toEqual([15, 30, 45, 60]);
    expect(done.filter((d) => d === 'whole')).toHaveLength(60 / (FLOW_RECOUNT_GAP_MS / MIN));
    expect(seen.filter((s) => /^INSERT INTO flow_counts/.test(s.trim()))).toHaveLength(4);
    // the last write came after the last move written, and counts as a whole count does
    expect(mark(db).dirty).toBe(0);
    for (const f of filters(Date.now()).filter((_, i) => i % 7 === 0)) expect(await stored(db, f), JSON.stringify(f)).toBe(await direct(db, f));
    // a single repair long after the last write: written at the next tick
    const at = mark(db).at!;
    db.raw.exec('UPDATE flow_count_mark SET dirty = 1 WHERE id = 1');
    expect(await refreshFlowCounts(db as any, at + FLOW_RECOUNT_GAP_MS - 1)).toBeNull();
    expect(await refreshFlowCounts(db as any, at + FLOW_RECOUNT_GAP_MS)).toBe('whole');
  });

  it('without the migration (no mark row) it does nothing and the list counts the moves itself', async () => {
    const db = testD1();
    db.raw.exec('DELETE FROM flow_count_mark');
    expect(await refreshFlowCounts(db as any, Date.now())).toBeNull();
    insert(db, 'flows', mix(Date.now() - 3 * H, Date.now() - MIN, 50));
    const r = (await (await app.request('/api/flows?pairs=one&limit=10', {}, { DB: db } as any)).json()) as FlowsResponse;
    expect(r.total).toBe(await direct(db, { asOf: Date.now(), onePerCrossing: true }));
  });
});

describe('GET /api/flows: the head page counts from the stored counts; any other count stops at COUNT_MAX', () => {
  it('the default page and its stored filters: exact, from the counts, with no full count of the moves', async () => {
    const now = Date.now();
    const db = testD1();
    insert(db, 'flows', mix(now - 8 * H, now - MIN, 400));
    await refreshFlowCounts(db as any, now);
    for (const qs of ['pairs=one', '', 'pairs=one&arb=false', 'chain=osmosis&kind=dex&pairs=one', 'kind=ibc&pairs=one', 'whale=true', 'minNam=100000&pairs=one', 'kind=sell&minNam=1000']) {
      const { wrapped, seen } = spied(db);
      const r = (await (await app.request(`/api/flows?${qs}&limit=10`, {}, { DB: wrapped } as any)).json()) as FlowsResponse;
      const f = { asOf: r.asOf!, ...Object.fromEntries(new URLSearchParams(qs)) } as any;
      const want = await direct(db, { asOf: r.asOf!, chain: f.chain, kind: f.kind, whale: f.whale === 'true', minNam: f.minNam ? Number(f.minNam) : null, excludeBots: f.arb === 'false', onePerCrossing: f.pairs === 'one' });
      expect(r.total, qs).toBe(want);
      expect(r.totalOver, qs).toBeUndefined();
      expect(seen.some((s) => /FROM flow_count_mark m/.test(s)), qs).toBe(true);
      expect(seen.some(isFullCount), qs).toBe(false);
    }
  });

  it('dirty while live: counted on the moves exactly, as before; rewound past the stored counts: bounded', async () => {
    const now = Date.now();
    const db = testD1();
    insert(db, 'flows', mix(now - 8 * H, now - MIN, 200));
    await refreshFlowCounts(db as any, now);
    db.raw.exec('UPDATE flow_count_mark SET dirty = 1 WHERE id = 1');
    const { wrapped, seen } = spied(db);
    const r = (await (await app.request('/api/flows?pairs=one&limit=10', {}, { DB: wrapped } as any)).json()) as FlowsResponse;
    expect(r.total).toBe(await direct(db, { asOf: r.asOf!, onePerCrossing: true }));
    expect(seen.some(isFullCount)).toBe(true);
    // rewound and dirty: a count of at most COUNT_MAX + 1 moves (here fewer, so exact)
    const at = now - 3 * H;
    const rw = (await (await app.request(`/api/flows?pairs=one&limit=10&at=${at}`, {}, { DB: db } as any)).json()) as FlowsResponse;
    expect(rw.total).toBe(await direct(db, { asOf: at, onePerCrossing: true }));
  });

  it('a filter the stored counts do not answer, over COUNT_MAX moves: total null, totalOver COUNT_MAX, the rows as before; at the bound: a count', async () => {
    const now = Date.now();
    const db = testD1();
    const many = Array.from({ length: COUNT_MAX + 30 }, (_, i) => ({ id: `osmosis:${hex(i)}:0`, chain: 'osmosis', height: 1_000 + i, ts: now - 2 * MIN - i * 1_000, tx_hash: hex(i), kind: 'sell', from_addr: os(i % 900), to_addr: null, amount_num: 6_000, meta: null }));
    insert(db, 'flows', many);
    await refreshFlowCounts(db as any, now);
    const { wrapped, seen } = spied(db);
    // a size the list does not offer, a time window: counted on the moves, at most COUNT_MAX + 1
    for (const qs of ['minNam=5000', `since=${now - 24 * H}`, `minNam=5000&since=${now - 24 * H}&pairs=one`]) {
      const r = (await (await app.request(`/api/flows?${qs}&limit=10`, {}, { DB: wrapped } as any)).json()) as FlowsResponse;
      expect(r.total, qs).toBeNull();
      expect(r.totalOver, qs).toBe(COUNT_MAX);
      expect(r.flows, qs).toHaveLength(10);
      expect(r.next, qs).toBeTruthy();
    }
    expect(seen.filter((s) => /COUNT\(\*\) total FROM \(SELECT 1 FROM flows f/.test(s)).length).toBe(3);
    expect(seen.some(isFullCount)).toBe(false);
    // the stored counts answer the same moves without a size: exact past COUNT_MAX
    const all = (await (await app.request('/api/flows?pairs=one&limit=10', {}, { DB: db } as any)).json()) as FlowsResponse;
    expect(all.total).toBe(COUNT_MAX + 30);
    // a narrower window under the bound: counted exactly
    const few = (await (await app.request(`/api/flows?minNam=5000&since=${now - 2 * MIN - 999 * 1_000}&limit=10`, {}, { DB: db } as any)).json()) as FlowsResponse;
    expect(few.total).toBe(1_000);
    // exactly COUNT_MAX matching is a count: a window holding the newest COUNT_MAX
    const at = (await (await app.request(`/api/flows?minNam=5000&since=${now - 2 * MIN - (COUNT_MAX - 1) * 1_000}&limit=10`, {}, { DB: db } as any)).json()) as FlowsResponse;
    expect(at.total).toBe(COUNT_MAX);
    expect(at.totalOver).toBeUndefined();
  });

  it('a whole address with more than COUNT_MAX moves: "more than" on the list, the exact count in the address report', async () => {
    const now = Date.now();
    const db = testD1();
    const hub = tn(3);
    insert(db, 'flows', Array.from({ length: COUNT_MAX + 5 }, (_, i) => ({ id: `namada:${hex(i)}:0`, chain: 'namada', height: 1_000 + i, ts: now - 2 * MIN - i * 1_000, tx_hash: hex(i), kind: 'shield', from_addr: i % 2 ? hub : tn(100 + (i % 50)), to_addr: i % 2 ? tn(100 + (i % 50)) : hub, amount_num: 10, meta: JSON.stringify({ source: 'indexer' }) })));
    const list = (await (await app.request(`/api/flows?addr=${hub}&limit=10`, {}, { DB: db } as any)).json()) as FlowsResponse;
    expect(list.total).toBeNull();
    expect(list.totalOver).toBe(COUNT_MAX);
    const report = (await (await app.request(`/api/address/${hub}`, {}, { DB: db } as any)).json()) as { totalFlowsCount: number };
    expect(report.totalFlowsCount).toBe(COUNT_MAX + 5);
    // the export: no count header past the bound, cut by whether more rows follow
    const csv = await app.request(`/api/export/flows?addr=${hub}`, {}, { DB: db } as any);
    expect(csv.headers.get('X-Total-Count')).toBeNull();
    expect(csv.headers.get('X-Truncated')).toBe('true');
    // its JSON says "more than COUNT_MAX", as /api/flows does, so it never reads as a text search, which is not counted
    const body = (await (await app.request(`/api/export/flows?addr=${hub}&format=json`, {}, { DB: db } as any)).json()) as { total: number | null; totalOver?: number; truncated: boolean };
    expect(body).toMatchObject({ total: null, totalOver: COUNT_MAX, truncated: true });
    const text = (await (await app.request('/api/export/flows?search=qqqqqqqq&format=json', {}, { DB: db } as any)).json()) as { total: number | null; totalOver?: number };
    expect(text.total).toBeNull();
    expect(text.totalOver).toBeUndefined();
  });
});
