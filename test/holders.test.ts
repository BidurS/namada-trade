// W2 (holder status, owner decision 7) and W13 (recorded chain reads of spendable balances, real 24 h / 7 d changes).
// The balance listing that feeds the readings since 2026-10-20 is in test/bulk-index.test.ts.
import { describe, it, expect, vi } from 'vitest';
import {
  holderStatus, balanceAt, changeOver, spanStmts, listingBalanceStmts, osmosisDroppedStmt, pruneSpansStmt, liquidChanges,
  LIQUID_STALE_MS, SPAN_MAX_GAP_MS, BOND_LISTING_SRC, type HolderStatusInput, type Span,
} from '../worker/src/holders';
import { stmt } from '../worker/src/db';
import { app } from '../worker/src/api';
import { testD1, insert, runStmts, type TestD1 } from './d1-sqlite';
import type { HoldersResponse, AddressReport } from '../shared/types';

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

// ---------------------------------------------------------------- the stored totals (migration 0008, nav-search-plan.md 2.1, 4.3)
describe('GET /api/holders on the stored totals: sizes, groups, searches, both ranks', () => {
  const B32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const tn = (n: number, end = 'qqqq') => `tnam1q${B32[n % 32]}${B32[Math.floor(n / 32) % 32]}${'q'.repeat(33)}${end}`;
  const T0 = Date.now();
  async function seeded() {
    const db = testD1();
    // 60 holders: totals 1,000 to 60,000 NAM; tn(5) and tn(6) stake; tn(70) only stakes
    await runStmts(db, listingBalanceStmts(Array.from({ length: 60 }, (_, i) => ({ address: tn(i, i === 9 ? 'kj4m' : 'qqqq'), balance: String((i + 1) * 1_000_000_000) })), 100, T0 - H));
    await runStmts(db, stmt.stakesVerified([{ address: tn(5), bondedNam: 100_000, delegations: [] }, { address: tn(6), bondedNam: 2_000, delegations: [] }, { address: tn(70), bondedNam: 30_500, delegations: [] }], 2690, 100, T0 - H, BOND_LISTING_SRC));
    insert(db, 'kv', [
      { key: 'balance.listing', value: JSON.stringify({ completeAt: T0 - H }), updated_at: T0 },
      { key: 'bond.listing', value: JSON.stringify({ completeAt: T0 - H }), updated_at: T0 },
    ]);
    await runStmts(db, [
      stmt.label(tn(10), 'namada', 'Anoma Foundation', 'foundation', 'genesis', null, 1),
      stmt.label(tn(11), 'namada', 'Genesis: af_backers', 'backer', 'genesis', null, 1),
      stmt.label(tn(12), 'namada', 'Genesis: af_backers', 'backer', 'genesis', null, 1),
      stmt.label(tn(13), 'namada', 'Genesis: public_allocations_completed', 'genesis', 'genesis', null, 1),
      stmt.label(tn(70), 'namada', 'Zondax', 'validator', 'valopers', null, 1),
    ]);
    insert(db, 'metrics', [{ ts: T0 - 60000, key: 'supply.total', value: 1149000000 }]);
    return db;
  }
  const api = async (db: TestD1, qs: string, status = 200) => {
    const res = await app.request(`/api/holders?${qs}`, {}, { DB: db } as any);
    expect(res.status, qs).toBe(status);
    return (await res.json()) as HoldersResponse & { error?: string };
  };

  it('a stake-only holder is ranked by its stake, and its spendable NAM is the listing\'s confirmed 0', async () => {
    const db = await seeded();
    const r = await api(db, 'chain=namada&limit=100');
    expect(r.total).toBe(61);
    const z = r.holders.find((h) => h.address === tn(70))!;
    expect(z).toMatchObject({ balance: 0, bonded: 30_500, total: 30_500, verifiedAt: T0 - H, label_plain: 'Zondax', rank: 32 }); // 30 holders of 31,000 to 60,000 NAM and the 106,000 NAM staker are ahead
    expect(z.statusNote).toMatch(/The chain lists no spendable NAM for this address\./);
    expect(r.holders[0]).toMatchObject({ address: tn(5), total: 106_000, rank: 1 });
    expect(r.asOf).toBeGreaterThan(0);
    expect(r.categories).toEqual({ total: 61, counts: [{ category: 'none', n: 56 }, { category: 'backer', n: 2 }, { category: 'foundation', n: 1 }, { category: 'genesis', n: 1 }, { category: 'validator', n: 1 }] });
  });

  it('min and max on the sort\'s figure; a size that is not an amount is refused', async () => {
    const db = await seeded();
    const r = await api(db, 'chain=namada&limit=100&min=30000&max=40000');
    expect(r.holders.map((h) => h.total)).toEqual([40_000, 39_000, 38_000, 37_000, 36_000, 35_000, 34_000, 33_000, 32_000, 31_000, 30_500, 30_000]);
    expect(r.total).toBe(12);
    expect(r.categories!.total).toBe(12);
    expect((await api(db, 'chain=namada&by=bonded&min=1000')).holders.map((h) => h.address)).toEqual([tn(5), tn(70), tn(6)]);
    expect((await api(db, 'chain=namada&min=lots', 400)).error).toMatch(/min must be an amount/);
    expect((await api(db, 'chain=namada&min=50000&max=10')).total).toBe(0);
  });

  it('groups: a small one read from its labels, a large or unlabelled one walked; the search text\'s words join them', async () => {
    const db = await seeded();
    expect((await api(db, 'chain=namada&category=backer')).holders.map((h) => h.address)).toEqual([tn(12), tn(11)]);
    expect((await api(db, 'chain=namada&category=none&limit=10')).holders.map((h) => h.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect((await api(db, 'chain=namada&category=none&limit=10')).total).toBe(56);
    expect((await api(db, 'chain=namada&search=early%20backers')).holders.map((h) => h.address)).toEqual([tn(12), tn(11)]);
    expect((await api(db, 'chain=namada&search=foundation')).holders.map((h) => h.address)).toEqual([tn(10)]);
    expect((await api(db, 'chain=namada&category=genesis&search=foundation')).total).toBe(0); // two different groups: nothing
    expect((await api(db, 'chain=osmosis&search=anoma')).total).toBe(0);
  });

  it('searches: an address start, an address end, a name\'s word start, a run of address characters, each read on its own index', async () => {
    const db = await seeded();
    const start = await api(db, `chain=all&search=${tn(9).slice(0, 8)}`);
    expect(start.holders.every((h) => h.address.startsWith(tn(9).slice(0, 8)))).toBe(true);
    expect(start.total).toBe(start.holders.length);
    expect(start.countsAt).toBeNull();
    expect((await api(db, 'chain=all&search=kj4m')).holders.map((h) => h.address)).toEqual([tn(9, 'kj4m')]);
    expect((await api(db, 'chain=all&search=zond')).holders.map((h) => h.address)).toEqual([tn(70)]);
    expect((await api(db, 'chain=all&search=zond%20%3E40k')).holders).toEqual([]); // and a size: Zondax holds 30,500
    // nine address characters with a digit from inside an address (eight would read as its end): found anywhere in it
    const run = await api(db, `chain=all&search=${tn(9, 'kj4m').slice(-10, -1)}`);
    expect(run.holders.map((h) => h.address)).toEqual([tn(9, 'kj4m')]);
    // letters only (a name's shape, as "knowable"): read as a name, never as part of an address
    expect((await api(db, `chain=all&search=${tn(9, 'kj4m').slice(6, 14)}`)).holders).toEqual([]);
  });

  it('the address sheet: No. N by total NAM and No. M by spendable NAM, as the two lists rank it', async () => {
    const db = await seeded();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    try {
      const rep = async (a: string) => (await (await app.request(`/api/address/${a}`, {}, { DB: db } as any)).json()) as AddressReport;
      const total = (await api(db, 'chain=namada&limit=100')).holders;
      const spendable = (await api(db, 'chain=namada&by=liquid&limit=100')).holders;
      for (const a of [tn(5), tn(6), tn(70), tn(30)]) {
        const r = await rep(a);
        expect(r.rankTotal, a).toBe(total.find((h) => h.address === a)!.rank);
        expect(r.rank, a).toBe(a === tn(70) ? null : spendable.find((h) => h.address === a)!.rank);
      }
      expect((await rep(POS)).rankTotal).toBeNull(); // a protocol account is not a holder
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('the export: the same rows, order and sizes', async () => {
    const db = await seeded();
    const j = (await (await app.request('/api/export/holders?format=json&chain=namada&min=50000', {}, { DB: db } as any)).json()) as { total: number; holders: { address: string; totalNam: number }[] };
    expect(j.holders.map((h) => h.address)).toEqual((await api(db, 'chain=namada&min=50000')).holders.map((h) => h.address));
    expect(j.total).toBe(12);
  });
});
