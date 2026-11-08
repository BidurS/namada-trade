// Activity inside the shielded pool as daily totals (builder G, 2026-11-08; migration 0024 masp_activity_daily): the
// daily job counts the shielded transactions the chain recorded per UTC day from this site's record of each block
// (masp_seen, now with the block's time) and classes them by the NAM legs at the pool in their block; /api/series
// serves the five counts; the shielded page says the week's count in one sentence on a phone and draws one bar a day
// on a desktop. Transactions by their (height, block_index, batch_index) tuple, never by event type; never users.
import { describe, it, expect } from 'vitest';
import { daily, isoDay } from '../worker/src/series';
import {
  maspActivityOf, maspActivityStmts, readMaspActivityDay, dayScanned, scannedOf, MASP_SEEN_DAY_SQL, MASP_SEEN_FIRST_SQL, MASP_LEGS_DAY_SQL, MASP_ACTIVITY_KEYS, SCANNED_KV,
  type LegDayRow, type SeenDayRow,
} from '../worker/src/masp-activity';
import { maspSeenOf, maspSeenStmts } from '../worker/src/masp-seen';
import { SERIES_KEYS, readSeries, MASP_ACTIVITY_SOURCE } from '../worker/src/series-api';
import { PLAIN_SOURCE, plainSource } from '../web/src/lib/prov';
import { SHIELDED_WORDS } from '../shared/copy';
import { INTERNAL_ADDRESSES } from '../shared/alerts';
import { BANNED } from '../scripts/copy-lint';
import { testD1, insert, runStmts, type TestD1 } from './d1-sqlite';
import type { SourceHealth } from '../shared/types';

const MASP = INTERNAL_ADDRESSES.masp;
const ESCROW = INTERNAL_ADDRESSES.ibc;
const A = 'tnam1qr4l8egaskk09460llz0qctac7sgemynpu8c7vvd';
const GAS = 'tnam1qq3t3lccqk4u69zjyaej63rrfpm4eha2v56llrku';
const D = 86_400_000, H = 3_600_000;
// 02:03 UTC on 9 Nov 2026: inside the daily job's window, past the flow index's hour
const NOW = Date.UTC(2026, 10, 9, 2, 3);
const TODAY = Date.UTC(2026, 10, 9);
const YESTERDAY = TODAY - D;
const all = (db: TestD1, sql: string, ...p: unknown[]) => db.raw.prepare(sql).all(...p).map((r: any) => ({ ...r }));
const env = (db: TestD1) => ({ DB: db } as any);
const rewards = async () => ({ total: 27_347_610_418_808n, height: 8_517_986, provider: 'StakeAndRelax' });

/** The legs of one block, as the day's read gives them. */
const leg = (height: number, kind: string, from: string | null, to: string | null, meta: Record<string, unknown> | null = null): LegDayRow =>
  ({ height, kind, from_addr: from, to_addr: to, meta: meta ? JSON.stringify(meta) : null });

describe('maspActivityOf: the day\'s classes by block', () => {
  // one block per class, a fee-only block and an other-coin block (both inside), a block with two transactions and a shield
  const seen: SeenDayRow[] = [{ height: 1, n: 1 }, { height: 2, n: 1 }, { height: 3, n: 1 }, { height: 4, n: 1 }, { height: 5, n: 1 }, { height: 6, n: 1 }, { height: 7, n: 2 }, { height: 8, n: 1 }];
  const legs: LegDayRow[] = [
    leg(1, 'shield', A, MASP),
    leg(2, 'unshield', MASP, A, { innerTxHash: 'U1', maspFeeNam: 0.2 }),
    leg(3, 'ibc_in', ESCROW, MASP, { shielded: true }),
    leg(4, 'ibc_out', MASP, ESCROW, { shielded: true }),
    // a shielded-to-shielded transaction paying its gas from the pool: the fee leg is not NAM moving out
    leg(5, 'masp_fee', MASP, GAS, { innerTxHash: 'F1' }),
    // another coin shielded: not a NAM leg
    leg(6, 'shield', A, MASP, { tokenSymbol: 'USDC (Noble)', tokenAddress: 'tnam1pkl64du8p2d240my5umxm24qhrjsvh42ruc98f97' }),
    leg(7, 'shield', A, MASP),
    // a leg in a block with no shielded transaction says nothing
    leg(9, 'shield', A, MASP),
  ];
  it('counts each transaction once and classes it by its block\'s NAM legs; a fee-only or other-coin block is inside', () => {
    expect(maspActivityOf(seen, legs)).toEqual({ txs: 9, namIn: 3, namOut: 1, bridge: 2, inside: 3, blocks: 8 });
  });
  it('a block with legs on several sides is in each class; no rows is all zero', () => {
    expect(maspActivityOf([{ height: 1, n: 1 }], [leg(1, 'shield', A, MASP), leg(1, 'unshield', MASP, A), leg(1, 'ibc_out', MASP, ESCROW)])).toEqual({ txs: 1, namIn: 1, namOut: 1, bridge: 1, inside: 0, blocks: 1 });
    expect(maspActivityOf([], [])).toEqual({ txs: 0, namIn: 0, namOut: 0, bridge: 0, inside: 0, blocks: 0 });
  });
  it('the day is counted only once the block follower\'s newest block is past its end', () => {
    expect(dayScanned({ height: 10, ts: TODAY, at: NOW }, TODAY)).toBe(true);
    expect(dayScanned({ height: 10, ts: TODAY - 1, at: NOW }, TODAY)).toBe(false);
    expect(dayScanned(null, TODAY)).toBe(false);
    expect(scannedOf({ height: 10, ts: TODAY, at: NOW })).toEqual({ height: 10, ts: TODAY, at: NOW });
    expect(scannedOf({ height: '10', ts: TODAY })).toBeNull();
  });
});

/** masp_seen rows (with the block's time) and the pool legs of two days, written as the hub writes them. */
async function seedDays(db: TestD1) {
  // yesterday: a shield block with one transaction, a fee-only block, a block with two transactions and an unshield
  const rows = [
    { height: 8_600_001, blockIndex: 0, batchIndex: 0, kind: 'transfer', ts: YESTERDAY + 2 * H },
    { height: 8_600_002, blockIndex: 0, batchIndex: 0, kind: 'fee-payment', ts: YESTERDAY + 3 * H },
    { height: 8_600_003, blockIndex: 0, batchIndex: 0, kind: 'transfer', ts: YESTERDAY + 4 * H },
    { height: 8_600_003, blockIndex: 1, batchIndex: 0, kind: 'fee-payment+transfer', ts: YESTERDAY + 4 * H },
    // the day before: one transaction over the bridge
    { height: 8_599_001, blockIndex: 0, batchIndex: 0, kind: 'transfer', ts: YESTERDAY - 5 * H },
    // a row from before migration 0024 carries no time and is never counted
    { height: 8_598_000, blockIndex: 0, batchIndex: 0, kind: 'transfer', ts: undefined },
  ];
  await runStmts(db, maspSeenStmts(rows));
  const flow = (id: string, height: number, ts: number, kind: string, from: string, to: string, meta: Record<string, unknown> | null = null) =>
    ({ id, chain: 'namada', height, ts, tx_hash: id, kind, from_addr: from, to_addr: to, amount_num: 10, meta: meta ? JSON.stringify(meta) : null });
  insert(db, 'flows', [
    flow('namada:S1:1', 8_600_001, YESTERDAY + 2 * H, 'shield', A, MASP),
    flow('namada:F1:1', 8_600_002, YESTERDAY + 3 * H, 'masp_fee', MASP, GAS, { innerTxHash: 'F1' }),
    flow('namada:U1:1', 8_600_003, YESTERDAY + 4 * H, 'unshield', MASP, A, { innerTxHash: 'U1' }),
    flow('namada:B1:1', 8_599_001, YESTERDAY - 5 * H, 'ibc_in', ESCROW, MASP, { shielded: true }),
  ]);
}

describe('the daily job: part \'shielded activity\'', () => {
  it('not the day\'s work while the block follower has not scanned past yesterday: nothing is written, never a 0, and the day finishes without it', async () => {
    const db = testD1();
    await seedDays(db);
    const health: SourceHealth[] = [];
    const r = (await daily(env(db), NOW, { health, maspRewards: rewards, validators: async () => [] }))!;
    expect(r.ran).toEqual(['flow index', 'shielded makeup', 'validator names']);
    expect(r.waiting.some((w) => w.startsWith('shielded activity'))).toBe(false);
    expect(all(db, 'SELECT * FROM masp_activity_daily')).toEqual([]);
    // the halt's shape: the newest block is days old; the same
    db.raw.prepare("INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)").run(SCANNED_KV, JSON.stringify({ height: 8_517_986, ts: Date.UTC(2026, 10, 2, 22, 49, 36), at: NOW }), NOW);
    const r2 = await daily(env(db), NOW + 60_000, { health, maspRewards: rewards, validators: async () => [] });
    expect(r2?.ran ?? []).toEqual([]);
    expect(all(db, 'SELECT * FROM masp_activity_daily')).toEqual([]);
    // the scan passes yesterday's end later in the day: the part is the day's work from then on and runs
    db.raw.prepare("INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)").run(SCANNED_KV, JSON.stringify({ height: 8_600_900, ts: TODAY + 10 * 60_000, at: NOW }), NOW);
    const r3 = (await daily(env(db), NOW + 4 * H, { health, maspRewards: rewards, validators: async () => [] }))!;
    expect(r3.ran).toEqual(['shielded activity']);
    expect(all(db, 'SELECT day, txs FROM masp_activity_daily ORDER BY day')).toEqual([{ day: isoDay(YESTERDAY - D), txs: 1 }, { day: isoDay(YESTERDAY), txs: 4 }]);
  });
  it('once the scan is past yesterday\'s end it counts yesterday and the day before, writes the rows and the five metrics, and is done for the day', async () => {
    const db = testD1();
    await seedDays(db);
    db.raw.prepare("INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)").run(SCANNED_KV, JSON.stringify({ height: 8_600_900, ts: TODAY + 10 * 60_000, at: NOW }), NOW);
    const health: SourceHealth[] = [];
    const r = (await daily(env(db), NOW, { health, maspRewards: rewards, validators: async () => [] }))!;
    expect(r.ran).toContain('shielded activity');
    expect(all(db, 'SELECT * FROM masp_activity_daily ORDER BY day')).toEqual([
      { day: isoDay(YESTERDAY - D), txs: 1, nam_in: 0, nam_out: 0, bridge: 1, inside: 0, blocks: 1, scanned_height: 8_600_900, scanned_ts: TODAY + 10 * 60_000, written_at: NOW },
      { day: isoDay(YESTERDAY), txs: 4, nam_in: 1, nam_out: 2, bridge: 0, inside: 1, blocks: 3, scanned_height: 8_600_900, scanned_ts: TODAY + 10 * 60_000, written_at: NOW },
    ]);
    const m = (key: string) => all(db, 'SELECT ts, value FROM metrics WHERE key = ? ORDER BY ts', key);
    expect(m(MASP_ACTIVITY_KEYS.txs)).toEqual([{ ts: YESTERDAY - D, value: 1 }, { ts: YESTERDAY, value: 4 }]);
    expect(m(MASP_ACTIVITY_KEYS.inside)).toEqual([{ ts: YESTERDAY - D, value: 0 }, { ts: YESTERDAY, value: 1 }]);
    expect(m(MASP_ACTIVITY_KEYS.namIn)).toEqual([{ ts: YESTERDAY - D, value: 0 }, { ts: YESTERDAY, value: 1 }]);
    expect(m(MASP_ACTIVITY_KEYS.namOut)).toEqual([{ ts: YESTERDAY - D, value: 0 }, { ts: YESTERDAY, value: 2 }]);
    expect(m(MASP_ACTIVITY_KEYS.bridge)).toEqual([{ ts: YESTERDAY - D, value: 1 }, { ts: YESTERDAY, value: 0 }]);
    // the row from before the time column is in the table and in no day
    expect(all(db, 'SELECT COUNT(*) n FROM masp_seen WHERE ts IS NULL')[0].n).toBe(1);
    // the next tick does the part no more
    const r2 = await daily(env(db), NOW + 60_000, { health, maspRewards: rewards, validators: async () => [] });
    expect(r2?.ran ?? []).not.toContain('shielded activity');
  });
  it('a day ending at or before the first recorded block is not written, so the days before the record (a halt\'s among them) are gaps alike, never 0', async () => {
    const db = testD1();
    // the record begins with one shielded transaction at 02:00 on 8 Nov (a row without a time is from before the record)
    await runStmts(db, maspSeenStmts([
      { height: 8_600_001, blockIndex: 0, batchIndex: 0, kind: 'transfer', ts: YESTERDAY + 2 * H },
      { height: 8_598_000, blockIndex: 0, batchIndex: 0, kind: 'transfer', ts: undefined },
    ]));
    const scanned = (ts: number) => db.raw.prepare("INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)").run(SCANNED_KV, JSON.stringify({ height: 8_600_900, ts, at: NOW }), NOW);
    const health: SourceHealth[] = [];
    // 8 Nov's job, the scan past 7 Nov's end: 7 and 6 Nov end before the first recorded block and are not written, not as 0
    scanned(YESTERDAY + 3 * H);
    const r1 = (await daily(env(db), NOW - D, { health, maspRewards: rewards, validators: async () => [] }))!;
    expect(r1.ran).toContain('shielded activity');
    expect(all(db, 'SELECT * FROM masp_activity_daily')).toEqual([]);
    expect(all(db, 'SELECT * FROM metrics WHERE key LIKE ?', 'masp.txs%')).toEqual([]);
    // 9 Nov's job, the scan past 8 Nov's end: 8 Nov, the first day the record covers, is written; 7 Nov is still not
    scanned(TODAY + 10 * 60_000);
    const r2 = (await daily(env(db), NOW, { health, maspRewards: rewards, validators: async () => [] }))!;
    expect(r2.ran).toContain('shielded activity');
    expect(all(db, 'SELECT day, txs, blocks FROM masp_activity_daily ORDER BY day')).toEqual([{ day: isoDay(YESTERDAY), txs: 1, blocks: 1 }]);
    expect(all(db, 'SELECT ts, value FROM metrics WHERE key = ? ORDER BY ts', MASP_ACTIVITY_KEYS.txs)).toEqual([{ ts: YESTERDAY, value: 1 }]);
    // the first read is the index's one seek
    expect(all(db, `EXPLAIN QUERY PLAN ${MASP_SEEN_FIRST_SQL}`).map((r) => r.detail).join(' | ')).toMatch(/masp_seen_ts/);
  });
  it('the day\'s reads search their indexes (masp_seen_ts; the pool\'s two address indexes by time), never a scan of flows', () => {
    const db = testD1();
    const plan = (sql: string, n: number) => all(db, `EXPLAIN QUERY PLAN ${sql}`, ...Array.from({ length: n }, () => 1)).map((r) => r.detail).join(' | ');
    expect(plan(MASP_SEEN_DAY_SQL, 2)).toMatch(/masp_seen_ts/);
    expect(plan(MASP_LEGS_DAY_SQL, 3)).toMatch(/SEARCH f USING INDEX flows_from \(from_addr=\? AND ts>\? AND ts<\?\)/);
    expect(plan(MASP_LEGS_DAY_SQL, 3)).toMatch(/SEARCH f USING INDEX flows_to \(to_addr=\? AND ts>\? AND ts<\?\)/);
    expect(plan(MASP_LEGS_DAY_SQL, 3)).not.toMatch(/SCAN f\b/);
  });
  it('readMaspActivityDay reads the two statements and counts; the statements carry the day\'s row and five metrics', async () => {
    const db = testD1();
    await seedDays(db);
    const a = await readMaspActivityDay(db, YESTERDAY);
    expect(a).toEqual({ txs: 4, namIn: 1, namOut: 2, bridge: 0, inside: 1, blocks: 3 });
    const stmts = maspActivityStmts(isoDay(YESTERDAY), a, { height: 1, ts: TODAY, at: NOW }, NOW);
    expect(stmts).toHaveLength(6);
    expect(stmts.slice(1).map((s) => s.params[1])).toEqual(Object.values(MASP_ACTIVITY_KEYS));
  });
});

describe('masp_seen rows carry the block\'s time (migration 0024)', () => {
  it('maspSeenOf takes the block\'s own time; the rows store it', async () => {
    const block = { height: 42, ts: YESTERDAY + H, events: [{ type: 'masp/fee-payment', attributes: [{ key: 'indexed-tx', value: JSON.stringify({ block_height: 42, block_index: 0, batch_index: 0 }) }] }] };
    const { seen } = maspSeenOf(block);
    expect(seen).toEqual([{ height: 42, blockIndex: 0, batchIndex: 0, kind: 'fee-payment', ts: YESTERDAY + H }]);
    const db = testD1();
    await runStmts(db, maspSeenStmts(seen));
    expect(all(db, 'SELECT height, block_index, batch_index, kind, ts FROM masp_seen')).toEqual([{ height: 42, block_index: 0, batch_index: 0, kind: 'fee-payment', ts: YESTERDAY + H }]);
    // written again: nothing changes
    await runStmts(db, maspSeenStmts(seen));
    expect(all(db, 'SELECT COUNT(*) n FROM masp_seen')[0].n).toBe(1);
  });
});

describe('/api/series serves the five counts', () => {
  it('each key is served as a daily count from this site\'s record, with its plain source word', () => {
    for (const key of Object.values(MASP_ACTIVITY_KEYS)) {
      expect(SERIES_KEYS[key]).toMatchObject({ unit: 'count', agg: 'sum', sparse: false, native: '1d', source: MASP_ACTIVITY_SOURCE, backfilled: false });
      expect(SERIES_KEYS[key].startNote('2026-11-20')).toContain('Earlier days are not counted.');
    }
    expect(PLAIN_SOURCE[MASP_ACTIVITY_SOURCE]).toBe('Shielded-transaction record');
    expect(plainSource({ source: MASP_ACTIVITY_SOURCE })).toBe('Shielded-transaction record');
  });
  it('the points are the days written; a day not counted is a gap, never 0; nothing yet says so', async () => {
    const db = testD1();
    const none = await readSeries(db, { key: MASP_ACTIVITY_KEYS.txs, step: '1d' }, NOW, false);
    expect(none.points).toEqual([]);
    expect(none.prov).toMatchObject({ status: 'missing', note: 'Nothing is recorded for this series yet.' });
    await seedDays(db);
    db.raw.prepare("INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)").run(SCANNED_KV, JSON.stringify({ height: 8_600_900, ts: TODAY + 10 * 60_000, at: NOW }), NOW);
    await daily(env(db), NOW, { health: [], maspRewards: rewards, validators: async () => [] });
    const s = await readSeries(db, { key: MASP_ACTIVITY_KEYS.txs, from: String(NOW - 5 * D), step: '1d' }, NOW + 3 * H, false);
    expect(s.points.map((p) => [p.t, p.v])).toEqual([[YESTERDAY - D, 1], [YESTERDAY, 4]]);
    expect(s.start).toBe(YESTERDAY - D);
    expect(s.unit).toBe('count');
    expect(s.sources[0].startNote).toMatch(/^Shielded transactions the chain recorded for each UTC day since 7 Nov 2026/);
    expect(s.prov).toMatchObject({ source: MASP_ACTIVITY_SOURCE, status: 'live' });
    // the days before the record began are not gaps; today is not due yet
    expect(s.gaps).toEqual([]);
  });
});

describe('the page\'s words (shared/copy.ts SHIELDED_WORDS)', () => {
  it('the phone\'s sentence is exact: transactions, never users', () => {
    expect(SHIELDED_WORDS.activity(SHIELDED_WORDS.activityCount('12', false), '9')).toBe('12 shielded transactions in 7 days, 9 entirely inside the pool.');
    expect(SHIELDED_WORDS.activity(SHIELDED_WORDS.activityCount('1', true), '0')).toBe('1 shielded transaction in 7 days, 0 entirely inside the pool.');
    expect(SHIELDED_WORDS.activityPartial('3')).toBe('3 of the 7 days are counted so far.');
    expect(SHIELDED_WORDS.activityPartial('1')).toBe('1 of the 7 days is counted so far.');
    expect(SHIELDED_WORDS.activitySince('20 Nov 2026')).toBe('Counted since 20 Nov 2026; earlier days are not counted.');
  });
  it('every word passes the copy lint\'s one shared gate and types no figure', () => {
    const words = [
      SHIELDED_WORDS.activity(SHIELDED_WORDS.activityCount('N', false), 'M'), SHIELDED_WORDS.activityScope, SHIELDED_WORDS.activitySince('D'), SHIELDED_WORDS.activityPartial('K'),
      SHIELDED_WORDS.activityHead, SHIELDED_WORDS.activityUnit, SHIELDED_WORDS.activityKey.all, SHIELDED_WORDS.activityKey.inside, SHIELDED_WORDS.activityNone,
    ];
    for (const w of words) {
      for (const b of BANNED) expect(w, `${b.word} in "${w}"`).not.toMatch(b.re);
      // the sentence with the week's span is the one figure the words carry (its window, not a count)
      if (w !== words[0] && w !== SHIELDED_WORDS.activityPartial('K')) expect(w).not.toMatch(/\d/);
    }
  });
});
