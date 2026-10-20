// W2 (holder status, owner decision 7) and W13 (recorded chain reads of spendable balances, real 24 h / 7 d changes).
// The balance listing that feeds the readings since 2026-10-20 is in test/bulk-index.test.ts.
import { describe, it, expect } from 'vitest';
import {
  holderStatus, balanceAt, changeOver, spanStmts, listingBalanceStmts, osmosisDroppedStmt, pruneSpansStmt, liquidChanges,
  LIQUID_STALE_MS, SPAN_MAX_GAP_MS, type HolderStatusInput, type Span,
} from '../worker/src/holders';
import { app } from '../worker/src/api';
import { testD1, insert, runStmts, type TestD1 } from './d1-sqlite';
import type { HoldersResponse } from '../shared/types';

const H = 3600000, D = 86400000;
const NOW = Date.UTC(2026, 9, 17, 17, 0);
const POS = 'tnam1qgqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqc8j2fp';

const base: HolderStatusInput = { chain: 'namada', verifiedAt: NOW - H, hasLiquidRow: true, bondedRead: null, bondedVerifiedAt: null, bondedEstimated: null };

describe('holder status (owner decision 7)', () => {
  it('is live when the spendable balance was read from the chain within 6 hours', () => {
    expect(holderStatus(base, NOW)).toEqual({ status: 'live', statusNote: null });
    expect(holderStatus({ ...base, verifiedAt: NOW - LIQUID_STALE_MS }, NOW).status).toBe('live');
  });

  it('is stale when the spendable balance is older than 6 hours, never read, or has no row at all', () => {
    const old = holderStatus({ ...base, verifiedAt: NOW - LIQUID_STALE_MS - 1 }, NOW);
    expect(old.status).toBe('stale');
    expect(old.statusNote).toMatch(/more than 6 hours ago/);
    // production on 2026-10-17: every top row had verifiedAt 1792036784858, 2.55 days old
    expect(holderStatus({ ...base, verifiedAt: 1792036784858 }, 1792036784858 + 2.55 * D).status).toBe('stale');
    expect(holderStatus({ ...base, verifiedAt: null }, NOW)).toMatchObject({ status: 'stale' });
    expect(holderStatus({ ...base, hasLiquidRow: false, verifiedAt: null }, NOW).statusNote).toMatch(/not been read from the chain yet/);
  });

  it('a fresh chain read of the stake wins: a different estimate is not a row problem', () => {
    // rank 1 in the snapshot: chain 14,662,107 vs estimate 14,562,107
    const r = holderStatus({ ...base, bondedRead: 14662107.029992, bondedEstimated: 14562107.029992, bondedVerifiedAt: NOW - 2 * H }, NOW);
    expect(r).toEqual({ status: 'live', statusNote: null });
  });

  it('conflicts only without a chain read newer than 24 h and with more than 1 NAM between estimate and last reading', () => {
    const c = holderStatus({ ...base, bondedRead: 14662107.029992, bondedEstimated: 14562107.029992, bondedVerifiedAt: NOW - 25 * H }, NOW);
    expect(c.status).toBe('conflict');
    expect(c.statusNote).toBe('Staked NAM: the last chain reading (14,662,107 NAM) and the estimate from staking history (14,562,107 NAM) differ by 100,000 NAM, and the stake has not been read from the chain in the last 24 hours.');
    expect(holderStatus({ ...base, bondedRead: 100, bondedEstimated: 100.9, bondedVerifiedAt: NOW - 3 * D }, NOW).status).toBe('live');
    expect(holderStatus({ ...base, bondedRead: 100, bondedEstimated: 102, bondedVerifiedAt: null }, NOW).status).toBe('conflict');
    // conflict outranks an old spendable balance
    expect(holderStatus({ ...base, verifiedAt: null, bondedRead: 100, bondedEstimated: 102, bondedVerifiedAt: null }, NOW).status).toBe('conflict');
  });

  it('says so when the stake is only an estimate, without making the row old', () => {
    const r = holderStatus({ ...base, bondedEstimated: 5000 }, NOW);
    expect(r.status).toBe('live');
    expect(r.statusNote).toMatch(/estimated from staking history/);
  });

  it('Osmosis rows depend only on the age of the bank read', () => {
    expect(holderStatus({ ...base, chain: 'osmosis', verifiedAt: NOW - 10 * 60000, bondedRead: 1, bondedEstimated: 9 }, NOW).status).toBe('live');
  });
});

describe('balance spans: what a balance was, from chain reads', () => {
  const spans: Span[] = [
    { address: 'a', balance_num: 100, from_ts: NOW - 30 * H, to_ts: NOW - 20 * H },
    { address: 'a', balance_num: 150, from_ts: NOW - 19 * H, to_ts: NOW - 1 * H },
  ];
  it('knows a balance only inside a span', () => {
    expect(balanceAt(spans, NOW - 24 * H)).toBe(100);
    expect(balanceAt(spans, NOW - 19.5 * H)).toBeNull(); // between two different readings
    expect(balanceAt(spans, NOW - 31 * H)).toBeNull();   // before the first reading
    expect(changeOver(160, spans, NOW, D)).toBe(60);
    expect(changeOver(160, spans, NOW, 7 * D)).toBeNull(); // never 0 as a placeholder
    expect(changeOver(null, spans, NOW, D)).toBeNull();
  });
});

// ---------------------------------------------------------------- against the real schema and SQL

function holder(db: TestD1, chain: string, address: string, balance: string, extra: Record<string, unknown> = {}) {
  insert(db, 'holders', [{ chain, address, balance, balance_num: Number(balance) / 1e6, updated_height: 1, updated_at: NOW - 3 * D, ...extra }]);
}

/** A chain read of `address` at `at` (the listing's statement, one height per read here), then the span bookkeeping for that batch. */
async function readAt(db: TestD1, at: number, reads: [string, string, number][]) {
  await runStmts(db, reads.flatMap(([a, bal, h]) => listingBalanceStmts([{ address: a, balance: bal }], h, at, 'test')));
  await runStmts(db, spanStmts('namada', at));
}

const spansOf = (db: TestD1, a: string) => db.raw.prepare('SELECT from_ts, to_ts, balance_num, reads FROM balance_spans WHERE address = ? ORDER BY from_ts').all(a).map((r: any) => ({ ...r }));

describe('recording reads (W13)', () => {
  it('extends a span while the balance is unchanged and opens a new one when it changes or after a long gap', async () => {
    const db = testD1();
    holder(db, 'namada', 'tnam1a', '5000000');
    await readAt(db, NOW - 30 * H, [['tnam1a', '5000000', 100]]);
    await readAt(db, NOW - 29 * H, [['tnam1a', '5000000', 101]]);
    await readAt(db, NOW - 20 * H, [['tnam1a', '5000000', 102]]); // 9 h gap: nothing assumed across it
    await readAt(db, NOW - 19 * H, [['tnam1a', '7000000', 103]]); // changed
    await readAt(db, NOW - 14 * H, [['tnam1a', '7000000', 104]]);
    await readAt(db, NOW - 14 * H, [['tnam1a', '7000000', 104]]); // the same tick twice changes nothing
    expect(spansOf(db, 'tnam1a')).toEqual([
      { from_ts: NOW - 30 * H, to_ts: NOW - 29 * H, balance_num: 5, reads: 2 },
      { from_ts: NOW - 20 * H, to_ts: NOW - 20 * H, balance_num: 5, reads: 1 },
      { from_ts: NOW - 19 * H, to_ts: NOW - 14 * H, balance_num: 7, reads: 2 },
    ]);
    expect(SPAN_MAX_GAP_MS).toBe(6 * H);
  });

  it('never lets a read overwrite a newer post-balance from a block, and a stale read does not move spans', async () => {
    const db = testD1();
    holder(db, 'namada', 'tnam1b', '9000000', { updated_height: 500, updated_at: NOW - H });
    await readAt(db, NOW, [['tnam1b', '1000000', 499]]);
    const row = db.raw.prepare("SELECT balance, verified_at FROM holders WHERE address='tnam1b'").get();
    expect({ ...row }).toEqual({ balance: '9000000', verified_at: null });
    expect(spansOf(db, 'tnam1b')).toEqual([]);
  });

  it('Osmosis: a complete list zeroes the addresses that left it', async () => {
    const db = testD1();
    holder(db, 'osmosis', 'osmo1stay', '1000000', { verified_at: NOW });
    holder(db, 'osmosis', 'osmo1gone', '2000000', { verified_at: NOW - 10 * 60000 });
    await runStmts(db, [osmosisDroppedStmt(NOW)]);
    const rows = db.raw.prepare("SELECT address, balance_num, verified_at FROM holders WHERE chain='osmosis' ORDER BY address").all().map((r: any) => ({ ...r }));
    expect(rows).toEqual([{ address: 'osmo1gone', balance_num: 0, verified_at: NOW }, { address: 'osmo1stay', balance_num: 1, verified_at: NOW }]);
  });

  it('prunes spans that ended more than 31 days ago (the 30-day movers need a reading 30 days back)', async () => {
    const db = testD1();
    insert(db, 'balance_spans', [
      { chain: 'namada', address: 'x', from_ts: NOW - 33 * D, to_ts: NOW - 32 * D, balance: '1', balance_num: 1 },
      { chain: 'namada', address: 'x', from_ts: NOW - 31 * D, to_ts: NOW - 30.5 * D, balance: '2', balance_num: 2 },
      { chain: 'namada', address: 'x', from_ts: NOW - 10 * D, to_ts: NOW - 9 * D, balance: '3', balance_num: 3 },
    ]);
    await runStmts(db, [pruneSpansStmt(NOW)]);
    expect(db.raw.prepare('SELECT balance FROM balance_spans ORDER BY from_ts').all().map((r: any) => r.balance)).toEqual(['2', '3']);
  });

  it('computes 24 h and 7 d changes from spans, null where no reading covers the window start', async () => {
    const db = testD1();
    insert(db, 'balance_spans', [
      { chain: 'namada', address: 'tnam1c', from_ts: NOW - 26 * H, to_ts: NOW - 22 * H, balance: '4000000', balance_num: 4 },
      { chain: 'namada', address: 'tnam1d', from_ts: NOW - 8 * D, to_ts: NOW - 1 * H, balance: '0', balance_num: 0 },
    ]);
    const ch = await liquidChanges(db as any, 'namada', new Map([['tnam1c', 10], ['tnam1d', 0], ['tnam1e', 3]]), NOW);
    expect(ch.get('tnam1c')).toEqual({ d24: 6, d7: null });
    expect(ch.get('tnam1d')).toEqual({ d24: 0, d7: 0 }); // a measured zero is a real zero
    expect(ch.get('tnam1e')).toEqual({ d24: null, d7: null });
  });
});

describe('D1 limits', () => {
  it('splits address lists so no query binds more than 100 parameters', async () => {
    const db = testD1();
    const many = new Map(Array.from({ length: 150 }, (_, i) => [`tnam1many${i}`, i] as [string, number]));
    insert(db, 'balance_spans', [{ chain: 'namada', address: 'tnam1many149', from_ts: NOW - 2 * D, to_ts: NOW, balance: '1', balance_num: 100 }]);
    const ch = await liquidChanges(db as any, 'namada', many, NOW);
    expect(ch.size).toBe(150);
    expect(ch.get('tnam1many149')).toEqual({ d24: 49, d7: null });
    expect(() => spanStmts('namada', NOW, Array.from({ length: 91 }, (_, i) => `a${i}`))).toThrow();
  });
});

describe('GET /api/holders', () => {
  it('carries status, plain labels and changes that are real or null, never a 0 placeholder', async () => {
    const db = testD1();
    const now = Date.now();
    insert(db, 'holders', [
      { chain: 'namada', address: 'tnam1gen', balance: '40455316415892', balance_num: 40455316.415892, updated_height: 8281179, updated_at: now - 2.55 * D, verified_at: now - 2.55 * D },
      { chain: 'namada', address: 'tnam1fresh', balance: '1000000000', balance_num: 1000, updated_height: 9, updated_at: now - H, verified_at: now - H },
      { chain: 'namada', address: POS, balance: '341944179487922', balance_num: 341944179.487922, updated_height: 9, updated_at: now, verified_at: now },
    ]);
    insert(db, 'stakes', [{ address: 'tnam1gen', bonded_num: 14662107.029992, estimated_num: 14562107.029992, verified_at: now - 2 * H, updated_at: now }]);
    insert(db, 'labels', [
      { address: 'tnam1gen', chain: 'namada', label: 'Genesis: public_allocations_completed', category: 'genesis', source: 'genesis' },
      { address: 'tnam1fresh', chain: 'namada', label: 'Genesis: af_backers', category: 'backer', source: 'genesis' },
    ]);
    insert(db, 'balance_spans', [{ chain: 'namada', address: 'tnam1fresh', from_ts: now - 2 * D, to_ts: now - H, balance: '900000000', balance_num: 900 }]);
    insert(db, 'metrics', [{ ts: now - 60000, key: 'supply.total', value: 1149000000 }]);

    const res = await app.request('/api/holders?chain=namada&limit=10', {}, { DB: db } as any);
    const r = (await res.json()) as HoldersResponse;
    expect(r.total).toBe(2); // the staking account is not a holder
    const [gen, fresh] = r.holders;
    expect(gen).toMatchObject({
      address: 'tnam1gen', rank: 1, status: 'stale', bonded: 14662107.029992, bondedEstimated: 14562107.029992,
      label: 'Genesis: public_allocations_completed', label_plain: 'Public sale allocation (genesis)', category_plain: 'Genesis',
      change24h: null, change7d: null,
    });
    expect(gen.statusNote).toMatch(/more than 6 hours ago/);
    expect(fresh).toMatchObject({ address: 'tnam1fresh', status: 'live', statusNote: null, label_plain: 'Early backers (genesis)', category_plain: 'Backer', change24h: 100, change7d: null });

    const s = await app.request('/api/holders?search=early%20backers', {}, { DB: db } as any);
    expect(((await s.json()) as HoldersResponse).holders.map((h) => h.address)).toEqual(['tnam1fresh']);
  });
});
