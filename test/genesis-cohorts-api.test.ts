// The genesis cohorts' reads (worker/src/series-api.ts, migration 0023) on the D1 stand-in: /api/series serves each
// allocation cohort's columns as a daily series stamped with the genesis file's digest and the listings; /api/series/cohorts
// serves the newest snapshot, the allocation table's provenance and the largest allocations with what each holds now and
// what left it, naming a recipient by its label when one exists and otherwise by its address and how many addresses it has
// since sent to (a floor when the onward read hit its cap); the empty, not-loaded and rewound states; the cache key; and every
// statement's plan. The large allocations' holdings are stamped with the holder index's own listing record, not the snapshot's.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { app } from '../worker/src/api';
import { testD1, insert, type TestD1 } from './d1-sqlite';
import { NAMADA } from '../worker/src/config';
import { CACHE_PARAMS, CACHEABLE_API } from '../worker/src/http';
import { SERIES_PARAMS } from '../worker/src/api-series';
import * as S from '../worker/src/series-api';
import { ALLOC_CATEGORIES, GENESIS_ALLOC_KV, GENESIS_DIGEST, GENESIS_URL } from '../shared/genesis';
import type { GenesisCohortsResponse, SeriesResponse, NotServedBody } from '../shared/types';

const H = 3_600_000, D = 86_400_000;
/** 7 Nov 2026 12:00 UTC: the halted chain's fifth day; the newest snapshot is of 3 Nov. */
const NOW = Date.UTC(2026, 10, 7, 12, 0);
const MASP = NAMADA.internal.masp, POS = NAMADA.internal.pos;
const pad = (i: number) => `tnam1q${String(i).padStart(39, '0')}`;
const WHALE = pad(1), FOUNDATION = pad(2), SMALL = pad(3), VALIDATOR = pad(10), UNLABELLED = pad(11), C = pad(12), E = pad(13), F = pad(14);
/** the listings the 3 Nov snapshot's holdings were read from */
const AS_OF = Date.UTC(2026, 10, 3, 0, 40), BAL_H = 8_517_945, BOND_H = 8_517_754;

/** The holder index's own listing record (kv balance.listing / bond.listing): the balance listing completed at `balance`, the bond listing at `bond`. */
function listings(db: TestD1, balance: number, bond: number) {
  insert(db, 'kv', [
    { key: 'balance.listing', value: JSON.stringify({ at: balance, completeAt: balance, height: BAL_H }), updated_at: balance },
    { key: 'bond.listing', value: JSON.stringify({ at: bond, completeAt: bond, height: BOND_H }), updated_at: bond },
  ]);
}

afterEach(() => { vi.useRealTimers(); });
const at = (t: number) => vi.useFakeTimers({ now: t, toFake: ['Date'] });
async function call<T = any>(db: TestD1, path: string): Promise<{ status: number; body: T }> {
  const res = await app.request(path, {}, { DB: db } as any);
  return { status: res.status, body: (await res.json()) as T };
}
const all = (db: TestD1, sql: string, ...p: unknown[]) => db.raw.prepare(sql).all(...p).map((r: any) => ({ ...r }));

function cohortRow(db: TestD1, day: string, category: string, r: { addrs: number; with: number; sp: number; st: number; out: number | null; alloc: number }, asOf = AS_OF) {
  insert(db, 'cohort_daily', [{ day, category, addrs: r.addrs, addrs_with_nam: r.with, spendable: r.sp, staked: r.st, as_of: asOf, shielded_out: r.out, alloc_nam: r.alloc, balance_height: BAL_H, bond_height: BOND_H }]);
}

/** The table, two snapshot days, the holder index (its listings completed at AS_OF and ten minutes later) and the flows of one backer of 20,000,000 NAM. */
function seed(db: TestD1) {
  insert(db, 'kv', [{ key: GENESIS_ALLOC_KV, value: JSON.stringify({ digest: GENESIS_DIGEST, url: GENESIS_URL, reviewedOn: '2026-10-19', writtenAt: NOW - 3 * D, n: 3 }), updated_at: NOW - 3 * D }]);
  listings(db, AS_OF, AS_OF + 10 * 60_000);
  insert(db, 'genesis_alloc', [
    { address: WHALE, amount_num: 20_000_000, category: 'backer' },
    { address: FOUNDATION, amount_num: 50_000_000, category: 'foundation' },
    { address: SMALL, amount_num: 100, category: 'public_completed' },
  ]);
  insert(db, 'labels', [
    { address: WHALE, chain: 'namada', label: 'Genesis: af_backers', category: 'backer', source: 'genesis', updated_at: 1 },
    { address: FOUNDATION, chain: 'namada', label: 'Anoma Foundation', category: 'foundation', source: 'genesis', updated_at: 1 },
    { address: VALIDATOR, chain: 'namada', label: 'Validator X', category: 'validator', source: 'valopers', updated_at: 1 },
  ]);
  insert(db, 'holders', [{ chain: 'namada', address: WHALE, balance: '5000000000000', balance_num: 5_000_000, updated_at: AS_OF, verified_at: AS_OF }]);
  insert(db, 'stakes', [{ address: WHALE, bonded_num: 1_000_000, delegations: '[]', updated_at: AS_OF }]);
  // two snapshot days: the backers held 6,000,000 of 20,000,000 on 3 Nov (30%), 7,000,000 on 2 Nov (35%)
  const prev = AS_OF - D;
  for (const [day, asOf, backerHeld] of [['2026-11-02', prev, 7_000_000], ['2026-11-03', AS_OF, 6_000_000]] as const) {
    cohortRow(db, day, 'alloc.backer', { addrs: 1, with: 1, sp: backerHeld - 1_000_000, st: 1_000_000, out: 100, alloc: 20_000_000 }, asOf);
    cohortRow(db, day, 'alloc.foundation', { addrs: 1, with: 0, sp: 0, st: 0, out: 0, alloc: 50_000_000 }, asOf);
    cohortRow(db, day, 'alloc.team', { addrs: 0, with: 0, sp: 0, st: 0, out: 0, alloc: 0 }, asOf);
    cohortRow(db, day, 'alloc.validators', { addrs: 0, with: 0, sp: 0, st: 0, out: 0, alloc: 0 }, asOf);
    cohortRow(db, day, 'alloc.ecosystem', { addrs: 0, with: 0, sp: 0, st: 0, out: 0, alloc: 0 }, asOf);
    cohortRow(db, day, 'alloc.public_completed', { addrs: 1, with: 0, sp: 0, st: 0, out: 10, alloc: 100 }, asOf);
    cohortRow(db, day, 'alloc.public_future', { addrs: 0, with: 0, sp: 0, st: 0, out: 0, alloc: 0 }, asOf);
    cohortRow(db, day, 'alloc.all', { addrs: 3, with: 1, sp: backerHeld - 1_000_000, st: 1_000_000, out: 110, alloc: 70_000_100 }, asOf);
  }
  // a row written from the labels (no 0023 columns) beside them
  insert(db, 'cohort_daily', [{ day: '2026-11-03', category: 'backer', addrs: 269, addrs_with_nam: 200, spendable: 1, staked: 2, as_of: AS_OF }]);
  let i = 0;
  const flow = (from: string, to: string, kind: string, nam: number, ts: number, meta: string | null = '{"innerTxHash":"X"}') =>
    insert(db, 'flows', [{ id: `namada:f${i++}`, chain: 'namada', height: 100 + i, ts, tx_hash: `H${i}`, kind, from_addr: from, to_addr: to, amount_num: nam, meta }]);
  flow(WHALE, MASP, 'shield', 60, NOW - 20 * D);
  flow(WHALE, MASP, 'shield', 40, NOW - 10 * D);
  flow(WHALE, MASP, 'shield', 5, NOW - 9 * D, '{"tokenSymbol":"USDC"}'); // another coin: not NAM
  flow(WHALE, VALIDATOR, 'transfer', 600, NOW - 15 * D);
  flow(WHALE, VALIDATOR, 'transfer', 400, NOW - 14 * D);
  flow(WHALE, UNLABELLED, 'transfer', 500, NOW - 12 * D);
  flow(WHALE, C, 'transfer', 20, NOW - 11 * D);
  flow(WHALE, E, 'transfer', 10, NOW - 11 * D);
  flow(WHALE, POS, 'bond', 1_000_000, NOW - 8 * D); // staking: not a plain transfer
  flow(WHALE, WHALE, 'transfer', 7, NOW - 8 * D); // to itself: not a recipient
  // the unlabelled recipient has since sent to two addresses (one of them twice), and sent to a third before it received
  flow(UNLABELLED, C, 'transfer', 100, NOW - 11 * D + H);
  flow(UNLABELLED, F, 'transfer', 100, NOW - 10 * D);
  flow(UNLABELLED, F, 'transfer', 50, NOW - 9 * D);
  flow(UNLABELLED, MASP, 'shield', 50, NOW - 9 * D); // into the pool: not counted among the addresses it sent to
  flow(UNLABELLED, E, 'transfer', 100, NOW - 13 * D);
}

describe('GET /api/series: an allocation cohort\'s column as a daily series', () => {
  it('serves the share held per day with the table and the listings in its stamp, old when no day since the snapshot was written', async () => {
    at(NOW);
    const db = testD1();
    seed(db);
    const { status, body } = await call<SeriesResponse>(db, `/api/series?key=cohort_daily.alloc.backer.held_share&from=2026-11-01`);
    expect(status).toBe(200);
    expect(body).toMatchObject({ key: 'cohort_daily.alloc.backer.held_share', unit: 'pct', agg: 'last', step: '1d', sparse: false });
    expect(body.points.map((p) => [p.t, p.v, p.at])).toEqual([[Date.UTC(2026, 10, 2), 35, AS_OF - D], [Date.UTC(2026, 10, 3), 30, AS_OF]]);
    expect(body.start).toBe(Date.UTC(2026, 10, 2));
    expect(body.prov.source).toBe(S.COHORT_SOURCE);
    expect(body.prov).toMatchObject({ at: AS_OF, status: 'stale' });
    // the series reads no kv row, so its note names no digest (the code's pinned one need not be the loaded table's): it points at the answer that states it
    expect(body.prov.note).toContain(`Allocations from the loaded allocation table (its digest is on /api/series/cohorts); holdings as of the chain listings completed 3 Nov 2026 00:40 UTC (balances at block ${BAL_H}, bonds at block ${BOND_H}); snapshot of 2026-11-03.`);
    expect(body.prov.note).not.toContain(GENESIS_DIGEST.slice(0, 12));
    expect(body.sources[0].startNote).toBe('The share of its NAM at genesis the cohort holds, spendable and staked, for early backers, once a day since 2 Nov 2026, from the allocation table, the holder index and the flow index; nothing earlier exists.');
    // the days since the snapshot are gaps with the writer's reason, not points
    expect(body.gaps.length).toBeGreaterThan(0);
    expect(body.gaps[0].why).toMatch(/^No snapshot was written for these days/);
    // the other columns
    const held = (await call<SeriesResponse>(db, `/api/series?key=cohort_daily.alloc.all.held&from=2026-11-01`)).body;
    expect(held.points.map((p) => p.v)).toEqual([7_000_000, 6_000_000]);
    expect(held.unit).toBe('nam');
    const out = (await call<SeriesResponse>(db, `/api/series?key=cohort_daily.alloc.public_completed.shielded_out&from=2026-11-01`)).body;
    expect(out.points.map((p) => p.v)).toEqual([10, 10]);
    const addrs = (await call<SeriesResponse>(db, `/api/series?key=cohort_daily.alloc.all.addrs&from=2026-11-01`)).body;
    expect(addrs.unit).toBe('count');
    expect(addrs.points.map((p) => p.v)).toEqual([3, 3]);
    // a share with no NAM at genesis is no point, never 0 or infinity
    const team = (await call<SeriesResponse>(db, `/api/series?key=cohort_daily.alloc.team.held_share&from=2026-11-01`)).body;
    expect(team.points).toEqual([]);
    expect(team.prov.status).toBe('missing');
  });

  it('refuses a cohort or a column it does not serve, naming the pattern', async () => {
    at(NOW);
    const db = testD1();
    for (const key of ['cohort_daily.alloc.other.held', 'cohort_daily.backer.held', 'cohort_daily.alloc.backer.nam']) {
      const { status, body } = await call<NotServedBody>(db, `/api/series?key=${key}`);
      expect(status, key).toBe(404);
      expect(body.reason).toContain('cohort_daily.alloc.<');
    }
  });
});

describe('GET /api/series/cohorts', () => {
  it('the newest snapshot, the table\'s provenance and the largest allocations with what each holds and what left it', async () => {
    at(NOW);
    const db = testD1();
    seed(db);
    const { status, body } = await call<GenesisCohortsResponse>(db, '/api/series/cohorts');
    expect(status).toBe(200);
    expect(body.day).toBe('2026-11-03');
    expect(body.listings).toEqual({ at: AS_OF, balanceHeight: BAL_H, bondHeight: BOND_H });
    expect(body.table).toEqual({ loaded: true, digest: GENESIS_DIGEST, reviewedOn: '2026-10-19', url: GENESIS_URL, allocations: 3, loadedAt: NOW - 3 * D, pinned: true });
    expect(body.cohorts.map((c) => c.cohort)).toEqual([...ALLOC_CATEGORIES, 'all']);
    const backer = body.cohorts.find((c) => c.cohort === 'backer')!;
    expect(backer).toEqual({ cohort: 'backer', plain: 'Early backers', addrs: 1, addrsWithNam: 1, spendableNam: 5_000_000, stakedNam: 1_000_000, heldNam: 6_000_000, shieldedOutNam: 100, allocNam: 20_000_000, heldSharePct: 30 });
    expect(body.cohorts.find((c) => c.cohort === 'team')!.heldSharePct).toBeNull();
    expect(body.cohorts.find((c) => c.cohort === 'all')).toMatchObject({ plain: 'Every genesis allocation', heldNam: 6_000_000, allocNam: 70_000_100, shieldedOutNam: 110 });
    // four days on: old, with the reason and the snapshot's facts
    expect(body.prov).toMatchObject({ source: S.COHORT_SOURCE, at: AS_OF, status: 'stale' });
    // the digest in the note is the loaded table's (kv genesis.alloc), the same the table block states
    expect(body.prov.note).toMatch(/^The newest snapshot is of 2026-11-03: no day since has had both chain listings complete\. Allocations from the loaded allocation table \(sha256 /);
    expect(body.prov.note).toContain(`(sha256 ${GENESIS_DIGEST.slice(0, 12)}…)`);
    // the largest allocations, largest first: the foundation's 50,000,000 (no holder row: holdings not read), then the backer
    expect(body.largeMinNam).toBe(15_000_000);
    expect(body.large.map((r) => r.address)).toEqual([FOUNDATION, WHALE]);
    const f = body.large[0];
    expect(f).toMatchObject({ labelPlain: 'Anoma Foundation', labelSource: 'genesis', cohort: 'foundation', allocNam: 50_000_000, spendableNam: null, stakedNam: null, shieldedOutNam: 0, shieldedMoves: 0, sentTo: [], sentToMore: { addrs: 0, nam: 0 }, movesRead: 0, movesCut: false });
    const w = body.large[1];
    expect(w).toMatchObject({ labelPlain: 'Early backers (genesis)', cohort: 'backer', allocNam: 20_000_000, spendableNam: 5_000_000, stakedNam: 1_000_000, shieldedOutNam: 100, shieldedMoves: 2, movesRead: 6, movesCut: false });
    // the recipients: the labelled one by its label (no onward count), the unlabelled one by its address with how many it has since sent to (two: C and F; E was before, the pool is not an address it sent to)
    expect(w.sentTo).toEqual([
      { address: VALIDATOR, labelPlain: 'Validator X', labelSource: 'valopers', nam: 1_000, moves: 2, sentOnTo: null, sentOnCut: false },
      { address: UNLABELLED, labelPlain: null, labelSource: null, nam: 500, moves: 1, sentOnTo: 2, sentOnCut: false },
      { address: C, labelPlain: null, labelSource: null, nam: 20, moves: 1, sentOnTo: 0, sentOnCut: false },
    ]);
    expect(w.sentToMore).toEqual({ addrs: 1, nam: 10 });
    // every address the answer names is one the page shows: the allocations, their named recipients
    const named = new Set([...body.large.map((r) => r.address), ...body.large.flatMap((r) => r.sentTo.map((s) => s.address))]);
    expect([...named].sort()).toEqual([FOUNDATION, WHALE, VALIDATOR, UNLABELLED, C].sort());
    expect(JSON.stringify(body)).not.toContain(MASP);
    expect(JSON.stringify(body)).not.toContain(E);
    // the holdings' stamp is the holder index's own listing record (the older of the two completions), not the snapshot's
    expect(body.holdingsProv).toMatchObject({ source: 'NamadaTrade holder index', at: AS_OF, status: 'stale' });
    expect(body.holdingsProv.note).toBe('Spendable and staked NAM as of the chain listings completed 3 Nov 2026 00:40 UTC.');
    expect(body.movesProv.source).toBeTruthy();
  });

  it('a recipient whose onward read hit its cap is marked: its count is a floor, judged on the rows read, not the distinct addresses', async () => {
    at(NOW);
    const db = testD1();
    seed(db);
    // the unlabelled recipient sends to one address COHORT_MOVES_MAX times after it received: the newest rows read are all those, so its
    // earlier recipient is past the cut and the count, 1, is a floor
    const rows = Array.from({ length: S.COHORT_MOVES_MAX }, (_, i) => ({
      id: `namada:on${i}`, chain: 'namada', height: 10_000 + i, ts: NOW - 8 * D + i * 60_000, tx_hash: `ON${i}`, kind: 'transfer', from_addr: UNLABELLED, to_addr: F, amount_num: 1, meta: '{"innerTxHash":"X"}',
    }));
    insert(db, 'flows', rows);
    const { body } = await call<GenesisCohortsResponse>(db, '/api/series/cohorts');
    const w = body.large.find((r) => r.address === WHALE)!;
    expect(w.sentTo.find((s) => s.address === UNLABELLED)).toEqual({ address: UNLABELLED, labelPlain: null, labelSource: null, nam: 500, moves: 1, sentOnTo: 1, sentOnCut: true });
    // the labelled recipient and the one that sent nothing on are not cut
    expect(w.sentTo.filter((s) => s.address !== UNLABELLED).map((s) => s.sentOnCut)).toEqual([false, false]);
  });

  it('says when the table is not loaded or no snapshot exists, and serves no large row under Rewind', async () => {
    at(NOW);
    const db = testD1();
    const empty = (await call<GenesisCohortsResponse>(db, '/api/series/cohorts')).body;
    expect(empty).toMatchObject({ day: null, cohorts: [], large: [], table: { loaded: false, pinned: false, digest: null } });
    expect(empty.prov).toMatchObject({ status: 'missing', note: 'The allocation table is not loaded, so no cohort can be counted.' });
    expect(empty.holdingsProv).toMatchObject({ status: 'missing', note: 'The allocation table is not loaded.' });
    // loaded, no snapshot yet, and no listing complete: the holdings are not read and say so
    insert(db, 'kv', [{ key: GENESIS_ALLOC_KV, value: JSON.stringify({ digest: 'abc', reviewedOn: '2026-10-19', writtenAt: NOW - H, n: 1 }), updated_at: NOW - H }]);
    insert(db, 'genesis_alloc', [{ address: WHALE, amount_num: 20_000_000, category: 'backer' }]);
    const none = (await call<GenesisCohortsResponse>(db, '/api/series/cohorts')).body;
    expect(none.table).toMatchObject({ loaded: true, pinned: false, digest: 'abc' });
    expect(none.prov).toMatchObject({ status: 'missing', note: 'No daily snapshot of the cohorts is written yet: one is written on a day both chain listings complete.' });
    expect(none.large.map((r) => r.address)).toEqual([WHALE]);
    expect(none.large[0]).toMatchObject({ spendableNam: null, stakedNam: null, sentTo: [] });
    expect(none.holdingsProv).toMatchObject({ status: 'missing', note: 'No complete chain listing is on record.' });
    // loaded, no snapshot yet, the holder index listed (the state right after the table is loaded on the halted chain): the
    // holdings are served under the index's own listing time, the older completion, not as missing
    listings(db, NOW - 3 * H, NOW - 2 * H);
    insert(db, 'holders', [{ chain: 'namada', address: WHALE, balance: '5000000000000', balance_num: 5_000_000, updated_at: NOW - 3 * H, verified_at: NOW - 3 * H }]);
    insert(db, 'stakes', [{ address: WHALE, bonded_num: 1_000_000, delegations: '[]', updated_at: NOW - 3 * H }]);
    const listed = (await call<GenesisCohortsResponse>(db, '/api/series/cohorts')).body;
    expect(listed.day).toBeNull();
    expect(listed.listings).toEqual({ at: null, balanceHeight: null, bondHeight: null });
    expect(listed.prov.status).toBe('missing');
    expect(listed.large[0]).toMatchObject({ address: WHALE, spendableNam: 5_000_000, stakedNam: 1_000_000 });
    expect(listed.holdingsProv).toEqual({ source: 'NamadaTrade holder index', at: NOW - 3 * H, status: 'live', note: 'Spendable and staked NAM as of the chain listings completed 7 Nov 2026 09:00 UTC.' });
    // rewound: the snapshot at or before then, no large rows (holdings are current)
    const db2 = testD1();
    seed(db2);
    const back = (await call<GenesisCohortsResponse>(db2, `/api/series/cohorts?at=${Date.UTC(2026, 10, 2, 12)}`)).body;
    expect(back.day).toBe('2026-11-02');
    expect(back.cohorts.find((c) => c.cohort === 'backer')!.heldNam).toBe(7_000_000);
    expect(back.prov.status).toBe('live');
    expect(back.large).toEqual([]);
    expect(back.holdingsProv).toMatchObject({ status: 'missing', note: 'Balances were not recorded over time; the large allocations are shown live only.' });
  });

  it('is cached at the edge on its one parameter, and its statements search an index or the primary key', () => {
    expect(SERIES_PARAMS['/api/series/cohorts']).toEqual(['at']);
    expect(CACHEABLE_API.test('/api/series/cohorts')).toBe(true);
    expect(CACHE_PARAMS['/api/series/cohorts']).toEqual(['at']);
    const db = testD1();
    const nParams = (sql: string) => { const nums = [...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1])); return nums.length ? Math.max(...nums) : (sql.match(/\?/g) ?? []).length; };
    const plan = (sql: string) => all(db, `EXPLAIN QUERY PLAN ${sql}`, ...Array.from({ length: nParams(sql) }, () => 1)).map((r) => r.detail).join(' | ');
    expect(plan(S.COHORT_RANGE_SQL)).toMatch(/SEARCH cohort_daily USING (COVERING INDEX sqlite_autoindex_cohort_daily_1|INDEX sqlite_autoindex_cohort_daily_1|PRIMARY KEY) \(category=\? AND day>\? AND day<\?\)/);
    expect(plan(S.COHORT_NEWEST_SQL)).toMatch(/SEARCH cohort_daily USING (COVERING INDEX sqlite_autoindex_cohort_daily_1|INDEX sqlite_autoindex_cohort_daily_1|PRIMARY KEY) \(category=\? AND day<\?\)/);
    expect(plan(S.COHORT_DAY_SQL)).toMatch(/SEARCH cohort_daily USING (COVERING INDEX sqlite_autoindex_cohort_daily_1|INDEX sqlite_autoindex_cohort_daily_1|PRIMARY KEY) \(category=\? AND day=\?\)/);
    expect(plan(S.COHORT_LARGE_SQL)).toMatch(/SEARCH g USING INDEX genesis_alloc_amount \(amount_num>\?\)/);
    expect(plan(S.COHORT_SHIELDED_SQL)).toMatch(/SEARCH f USING INDEX flows_from \(from_addr=\? AND ts<\?\)/);
    expect(plan(S.COHORT_TRANSFERS_SQL)).toMatch(/SEARCH f USING INDEX flows_from \(from_addr=\? AND ts<\?\)/);
    expect(plan(S.COHORT_SENT_ON_SQL)).toMatch(/SEARCH f USING INDEX flows_from \(from_addr=\? AND ts>\? AND ts<\?\)/);
    for (const sql of [S.COHORT_RANGE_SQL, S.COHORT_START_SQL, S.COHORT_NEWEST_SQL, S.COHORT_DAY_SQL, S.COHORT_LARGE_SQL, S.COHORT_SHIELDED_SQL, S.COHORT_TRANSFERS_SQL, S.COHORT_SENT_ON_SQL, S.labelsSql(3)]) {
      expect(plan(sql), sql).not.toMatch(/TEMP B-TREE/);
      expect(plan(sql), sql).not.toMatch(/\bSCAN (flows|f|holders|h|stakes|s|labels|l|genesis_alloc|g|cohort_daily)\b(?! USING)/);
    }
  });
});
