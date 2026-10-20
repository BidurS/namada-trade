// The series writers (worker/src/series.ts, series-sql.ts; docs/design/screener-plan.md 5 and 7) on the D1 stand-in
// with every migration applied (0007 included): each writer's SQL and arithmetic on a seed whose answers are worked
// out here independently, the jobs' gating (once an hour, once a day, a gap stays a gap), and the plans of the reads.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { testD1, insert, runStmts, type TestD1 } from './d1-sqlite';
import { NAMADA } from '../worker/src/config';
import { parseBondListing, parseBalanceListing } from '../worker/src/sources/namada';
import { parsePairSummary, parsePairChart } from '../worker/src/sources/osmosis-data';
import { buildUnbondTermStructure } from '../worker/src/analytics';
import { BOND_LISTING_SRC, BALANCE_LISTING_SRC, listingBalanceStmts } from '../worker/src/holders';
import { stmt } from '../worker/src/db';
import { runBalanceListing } from '../worker/src/cron';
import {
  hourly, daily, swapHourStmts, medianOf, hoursToRoll, rollupStmts, poolHourlyStmts, poolPriceStmts, dayAggregates, sideCategory,
  holderListingStats, unbondQueue, stakeStructure, bondListingSeries, parseValidatorList, isoDay, JOB_WINDOW_MS, type SwapRow, type DayFlowRow,
} from '../worker/src/series';
import { SERIES_READS, ROLLUP_HOUR_SQL, ROLLUP_KEYS, DAY_FLOWS_SQL, SWAP_HOUR_SQL, BUCKETS } from '../worker/src/series-sql';
import type { PoolInfo, SourceHealth } from '../shared/types';

const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));
const H = 3600000, D = 86400000;
const POS = NAMADA.internal.pos, MASP = NAMADA.internal.masp, IBC = NAMADA.internal.ibc;
const env = (db: TestD1) => ({ DB: db } as any);
const all = (db: TestD1, sql: string, ...p: unknown[]) => db.raw.prepare(sql).all(...p).map((r: any) => ({ ...r }));
const metric = (db: TestD1, key: string) => all(db, 'SELECT ts, value FROM metrics WHERE key = ? ORDER BY ts', key);
const pad = (i: number, n = 38) => String(i).padStart(n, '0');
const tnam = (i: number) => `tnam1q${pad(i)}`;
const osmo = (i: number) => `osmo1${pad(i)}`;

// ---------------------------------------------------------------- the seed

/** 01:05 UTC on 21 Oct 2026: inside the job window, past DAY_FLOWS_FROM_HOUR. */
const NOW = Date.UTC(2026, 9, 21, 1, 5);
const SIZES = [0.4, 7, 650, 4200, 55_000, 420_000, 3_300_000, 21_000_000];

interface Seed { db: TestD1; spendable: Map<string, number>; staked: Map<string, number>; osmo: Map<string, number>; labels: Map<string, string> }

function seed(): Seed {
  const db = testD1();
  const spendable = new Map<string, number>(), staked = new Map<string, number>(), osmoBal = new Map<string, number>(), labels = new Map<string, string>();
  // 300 Namada addresses with spendable NAM, 30 rows at 0 (emptied earlier), 10 stake-only addresses
  for (let i = 0; i < 330; i++) {
    const bal = i < 300 ? SIZES[i % SIZES.length] * (1 + (i % 7) / 10) : 0;
    if (bal > 0) spendable.set(tnam(i), bal);
    insert(db, 'holders', [{ chain: 'namada', address: tnam(i), balance: String(Math.round(bal * 1e6)), balance_num: bal, updated_height: 1, updated_at: NOW - 2 * H, verified_at: NOW - 2 * H, verified_src: BALANCE_LISTING_SRC }]);
  }
  for (let i = 0; i < 70; i++) {
    const a = i < 60 ? tnam(i * 5) : tnam(1000 + i);
    const b = 1000 * (i + 1) + (i % 3 === 0 ? 2_000_000 : 0);
    staked.set(a, b);
    insert(db, 'stakes', [{ address: a, bonded_num: b, delegations: '[]', estimated_num: b + 999, verified_at: NOW - 3 * H, verified_src: BOND_LISTING_SRC, updated_at: NOW - 3 * H }]);
  }
  // a stakes row with only an estimate: not a holder once a bond listing has gone through
  insert(db, 'stakes', [{ address: tnam(2000), bonded_num: null, estimated_num: 332_386_683, updated_at: NOW - 3 * H }]);
  // the protocol accounts hold NAM but are not holders
  for (const a of [POS, MASP, IBC, NAMADA.internal.pgf]) insert(db, 'holders', [{ chain: 'namada', address: a, balance: '1', balance_num: 100_000_000, updated_height: 1, updated_at: NOW, verified_at: NOW, verified_src: 'node' }]);
  // 30 genesis labels: 10 backers, 5 foundation, 15 other genesis; two of the backers are not in holders at all
  for (let i = 0; i < 30; i++) {
    const a = i < 2 ? tnam(5000 + i) : tnam(i * 9);
    const cat = i < 10 ? 'backer' : i < 15 ? 'foundation' : 'genesis';
    labels.set(a, cat);
    insert(db, 'labels', [{ address: a, chain: 'namada', label: `Genesis: ${cat}`, category: cat, source: 'genesis', updated_at: 1 }]);
  }
  // a user tag claiming a curated category is still a user
  insert(db, 'labels', [{ address: tnam(3), chain: 'namada', label: 'my backer', category: 'backer', source: 'user', updated_at: 1, author: 'tnam1qauthor' }]);
  // Osmosis: 100 holders, 2 pools (labelled, not holders)
  for (let i = 0; i < 100; i++) {
    const bal = SIZES[(i + 3) % SIZES.length] / 10;
    osmoBal.set(osmo(i), bal);
    insert(db, 'holders', [{ chain: 'osmosis', address: osmo(i), balance: String(Math.round(bal * 1e6)), balance_num: bal, updated_at: NOW - 10 * 60000, verified_at: NOW - 10 * 60000, verified_src: 'keplr_rest' }]);
  }
  for (const p of [osmo(9001), osmo(9002)]) {
    insert(db, 'holders', [{ chain: 'osmosis', address: p, balance: '600000000000', balance_num: 600_000, updated_at: NOW - 10 * 60000, verified_at: NOW - 10 * 60000, verified_src: 'keplr_rest' }]);
    insert(db, 'labels', [{ address: p, chain: 'osmosis', label: 'Osmosis Pool', category: 'pool', source: 'auto', updated_at: 1 }]);
  }
  insert(db, 'kv', [
    { key: 'balance.listing', value: JSON.stringify({ at: NOW - H, completeAt: NOW - H }), updated_at: NOW },
    { key: 'bond.listing', value: JSON.stringify({ at: NOW - 2 * H, completeAt: NOW - 2 * H }), updated_at: NOW },
  ]);
  return { db, spendable, staked, osmo: osmoBal, labels };
}

const bucketOf = (t: number) => (t >= 1e7 ? '10m+' : t >= 1e6 ? '1m-10m' : t >= 1e5 ? '100k-1m' : t >= 1e4 ? '10k-100k' : t >= 1e3 ? '1k-10k' : t >= 1 ? '1-1k' : 'under1');
const VALIDATORS = [{ address: 'tnam1qval1', name: 'One', commission: '0.05', state: 'consensus', email: 'secret@example.com' }, { address: 'tnam1qval2', name: '<decommissioned>', commission: '0.2', state: 'jailed' }];

// ---------------------------------------------------------------- daily: the snapshots

describe('daily(): the holder snapshots', () => {
  it('writes one row per non-empty size line per chain that reconciles with the seed: spendable to the holders, staked to the bond listing', async () => {
    const s = seed();
    const health: SourceHealth[] = [];
    const r = (await daily(env(s.db), NOW, { health, validators: async () => VALIDATORS }))!;
    expect(r.ran).toEqual(['snapshot namada', 'snapshot osmosis', 'flow index', 'validator names']);
    const rows = all(s.db, "SELECT * FROM holder_cohorts_daily WHERE chain = 'namada' ORDER BY bucket");
    // independent: the union of spendable and staked, per bucket
    const want = new Map<string, { holders: number; nam: number; spendable: number; staked: number }>();
    for (const a of new Set([...s.spendable.keys(), ...s.staked.keys()])) {
      const sp = s.spendable.get(a) ?? 0, st = s.staked.get(a) ?? 0, b = bucketOf(sp + st);
      const w = want.get(b) ?? want.set(b, { holders: 0, nam: 0, spendable: 0, staked: 0 }).get(b)!;
      w.holders++; w.nam += sp + st; w.spendable += sp; w.staked += st;
    }
    expect(rows.map((x) => x.bucket).sort()).toEqual([...want.keys()].sort());
    for (const x of rows) {
      const w = want.get(x.bucket)!;
      expect(x).toMatchObject({ day: '2026-10-21', holders: w.holders, as_of: NOW - 2 * H });
      expect(x.spendable).toBeCloseTo(w.spendable, 6);
      expect(x.staked).toBeCloseTo(w.staked, 6);
      expect(x.nam).toBeCloseTo(w.nam, 6);
    }
    const tot = (k: string) => rows.reduce((a, x) => a + x[k], 0);
    expect(tot('spendable')).toBeCloseTo([...s.spendable.values()].reduce((a, b) => a + b, 0), 4);
    expect(tot('staked')).toBeCloseTo([...s.staked.values()].reduce((a, b) => a + b, 0), 4);
    expect(tot('holders')).toBe(new Set([...s.spendable.keys(), ...s.staked.keys()]).size);
    // Osmosis: the 100 holders, the pools left out, staked a true 0
    const o = all(s.db, "SELECT * FROM holder_cohorts_daily WHERE chain = 'osmosis'");
    expect(o.reduce((a, x) => a + x.holders, 0)).toBe(100);
    expect(o.reduce((a, x) => a + x.spendable, 0)).toBeCloseTo([...s.osmo.values()].reduce((a, b) => a + b, 0), 6);
    expect(o.every((x) => x.staked === 0 && x.as_of === NOW - 10 * 60000)).toBe(true);
    expect(BUCKETS).toEqual(['10m+', '1m-10m', '100k-1m', '10k-100k', '1k-10k', '1-1k', 'under1']);
  });

  it('cohort_daily: each genesis category is the labelled join; "none" is every other holder; a user tag is not a cohort', async () => {
    const s = seed();
    await daily(env(s.db), NOW, { health: [], validators: async () => VALIDATORS });
    const rows = Object.fromEntries(all(s.db, 'SELECT * FROM cohort_daily').map((r) => [r.category, r]));
    for (const cat of ['backer', 'foundation', 'genesis']) {
      const addrs = [...s.labels].filter(([, c]) => c === cat).map(([a]) => a);
      const sp = addrs.reduce((a, x) => a + (s.spendable.get(x) ?? 0), 0), st = addrs.reduce((a, x) => a + (s.staked.get(x) ?? 0), 0);
      expect(rows[cat].addrs).toBe(addrs.length);
      expect(rows[cat].addrs_with_nam).toBe(addrs.filter((x) => (s.spendable.get(x) ?? 0) + (s.staked.get(x) ?? 0) > 0).length);
      expect(rows[cat].spendable).toBeCloseTo(sp, 6);
      expect(rows[cat].staked).toBeCloseTo(st, 6);
    }
    expect(rows.backer.addrs).toBe(10);
    const holders = new Set([...s.spendable.keys(), ...s.staked.keys()]);
    const none = [...holders].filter((a) => !s.labels.has(a));
    expect(rows.none.addrs).toBe(none.length);
    expect(rows.none.spendable).toBeCloseTo(none.reduce((a, x) => a + (s.spendable.get(x) ?? 0), 0), 6);
    // labelled + none spendable = every holder's spendable (the cohorts reconcile with the size lines)
    expect(rows.backer.spendable + rows.foundation.spendable + rows.genesis.spendable + rows.none.spendable).toBeCloseTo([...s.spendable.values()].reduce((a, b) => a + b, 0), 4);
  });

  it('runs once a day: a second call does nothing, a call outside the window does nothing, and a rerun after the marker is cleared writes the same rows', async () => {
    const s = seed();
    await daily(env(s.db), NOW, { health: [], validators: async () => VALIDATORS });
    const snap = all(s.db, 'SELECT * FROM holder_cohorts_daily ORDER BY chain, bucket');
    expect(await daily(env(s.db), NOW + 60000, { health: [], validators: async () => VALIDATORS })).toBeNull();
    expect(await daily(env(s.db), NOW + JOB_WINDOW_MS, { health: [] })).toBeNull();
    s.db.raw.prepare("DELETE FROM kv WHERE key = 'jobs.daily'").run();
    await daily(env(s.db), NOW + 2 * 60000, { health: [], validators: async () => VALIDATORS });
    expect(all(s.db, 'SELECT * FROM holder_cohorts_daily ORDER BY chain, bucket')).toEqual(snap);
  });

  it('waits while a listing is older than 6 h, says so, and a day it never caught stays a gap', async () => {
    const s = seed();
    s.db.raw.prepare("UPDATE kv SET value = ? WHERE key = 'bond.listing'").run(JSON.stringify({ at: NOW - 7 * H, completeAt: NOW - 7 * H }));
    const health: SourceHealth[] = [];
    const r = (await daily(env(s.db), NOW, { health, validators: async () => VALIDATORS }))!;
    expect(r.waiting[0]).toMatch(/^snapshot namada: the older listing is 7\.0 h old/);
    expect(all(s.db, "SELECT * FROM holder_cohorts_daily WHERE chain = 'namada'")).toHaveLength(0);
    expect(health.find((h) => h.name === 'Series (daily snapshot)')).toMatchObject({ ok: false });
    // the next day, with fresh listings: that day's rows only; the 21st is not filled in
    const next = NOW + D;
    s.db.raw.prepare("UPDATE kv SET value = ? WHERE key IN ('bond.listing', 'balance.listing')").run(JSON.stringify({ at: next - H, completeAt: next - H }));
    s.db.raw.prepare("UPDATE holders SET verified_at = ? WHERE chain = 'osmosis'").run(next - 60000);
    await daily(env(s.db), next, { health: [], validators: async () => VALIDATORS });
    expect(all(s.db, "SELECT DISTINCT day FROM holder_cohorts_daily WHERE chain = 'namada'").map((x) => x.day)).toEqual(['2026-10-22']);
  });

  it('keeps the validator list to name, commission and state (no contact fields), without a placeholder name', () => {
    const l = parseValidatorList(VALIDATORS, 5);
    expect(l).toEqual({ at: 5, validators: [{ address: 'tnam1qval1', name: 'One', commission: 0.05, state: 'consensus' }, { address: 'tnam1qval2', name: null, commission: 0.2, state: 'jailed' }] });
    expect(JSON.stringify(l)).not.toContain('secret');
  });
});

// ---------------------------------------------------------------- daily: the flow index

const T = Date.UTC(2026, 9, 20, 12);
const A = tnam(1), B = tnam(2), C = tnam(4), X = tnam(7), G1 = tnam(9 * 3); // tnam(27) is a backer label (i = 3)
const POOL = osmo(9001);
const f = (id: string, chain: string, kind: string, from: string | null, to: string | null, nam: number, extra: Partial<DayFlowRow> & { meta?: any } = {}): DayFlowRow & { height: number; tx_hash: string } => ({
  id, chain, ts: T, height: 100, tx_hash: id.toUpperCase(), kind, from_addr: from, to_addr: to, amount_num: nam, value_usd: null, ...extra,
  meta: extra.meta === undefined ? { source: 'test' } : extra.meta,
});
const DAY_FLOWS = [
  f('n1', 'namada', 'transfer', A, B, 1000),
  f('n2', 'namada', 'transfer', G1, C, 5000),
  f('n3', 'namada', 'bond', A, POS, 2000),
  f('n4', 'namada', 'pos_balance', POS, X, 331_386_682, { meta: { descriptor: 'transfer-from-wasm', innerTxHash: 'I4' } }),
  f('n5', 'namada', 'pos_balance', X, POS, 331_386_682, { meta: { descriptor: 'transfer-from-wasm', innerTxHash: 'I5' }, ts: T + 60000 }),
  f('n6', 'namada', 'shield', A, MASP, 300),
  f('n7', 'namada', 'unshield', MASP, B, 200, { meta: { source: 'test', maspFeeNam: 0.5 } }),
  f('n8', 'namada', 'shield', A, MASP, 10, { meta: { source: 'test', tokenSymbol: 'USDC' } }),
  f('n9', 'namada', 'ibc_out', A, osmo(50), 700),
  f('o1', 'osmosis', 'ibc_in', A, osmo(50), 700),
  f('o2', 'osmosis', 'buy', POOL, osmo(51), 1000, { value_usd: 1.2, meta: { trader: osmo(51) } }),
  f('o3', 'osmosis', 'buy', POOL, osmo(51), 1000, { value_usd: 1.1, meta: { trader: osmo(51) }, ts: T + H }),
  f('o4', 'osmosis', 'sell', osmo(52), POOL, 500, { value_usd: 0.6, meta: { trader: osmo(52) } }),
  f('o5', 'osmosis', 'buy', POOL, osmo(53), 9000, { value_usd: 9, meta: { arb: true } }),
  f('o6', 'osmosis', 'ibc_out', osmo(54), tnam(60), 900, { meta: { packetSequence: '77' } }),
  f('o7', 'osmosis', 'ibc_out', osmo(55), tnam(61), 400, { meta: { packetSequence: '78' } }),
];
const REFUND = f('r1', 'osmosis', 'other', osmo(56), osmo(54), 900, { ts: T + D, meta: { ibcTimeoutRefund: true, packetSequence: '77' } });

describe('dayAggregates / the daily flow index', () => {
  const rowsWithLabels = DAY_FLOWS.map((r) => ({ ...r, meta: JSON.stringify(r.meta), from_label_cat: r.from_addr === G1 ? 'backer' : r.from_addr === POOL ? 'pool' : null, from_label_src: r.from_addr === G1 ? 'genesis' : r.from_addr === POOL ? 'auto' : null, to_label_cat: r.to_addr === POOL ? 'pool' : null, to_label_src: r.to_addr === POOL ? 'auto' : null }));
  const refunds = [{ ...REFUND, meta: JSON.stringify(REFUND.meta) }];

  it('counts each flow once on its own chain, keeps the staking account transfers as their own kind, bots as "bot", and leaves out the refunded send, its refund and other coins', () => {
    const a = dayAggregates(rowsWithLabels, refunds);
    const e = Object.fromEntries(a.edges.map((x) => [`${x.chain} ${x.kind} ${x.from_cat}>${x.to_cat}`, [x.n, x.nam, x.usd]]));
    expect(e).toEqual({
      'namada transfer user>user': [1, 1000, null],
      'namada transfer backer>user': [1, 5000, null],
      'namada bond user>pos': [1, 2000, null],
      'namada pos_balance pos>user': [1, 331_386_682, null],
      'namada pos_balance user>pos': [1, 331_386_682, null],
      'namada shield user>masp': [1, 300, null],
      'namada unshield masp>user': [1, 200, null],
      'namada ibc_out user>osmosis': [1, 700, null],
      'osmosis ibc_in namada>user': [1, 700, null],
      'osmosis buy pool>user': [2, 2000, 2.3],
      'osmosis sell user>pool': [1, 500, 0.6],
      'osmosis bot pool>user': [1, 9000, 9],
      'osmosis ibc_out user>namada': [1, 400, null],
    });
    expect(a.edges.reduce((s, x) => s + x.n, 0)).toBe(DAY_FLOWS.length - 2); // the other coin and the refunded send
  });

  it('activity: addresses of the row\'s chain only, protocol and pool accounts and bots left out', () => {
    const a = dayAggregates(rowsWithLabels, refunds);
    const by = Object.fromEntries(a.activity.map((x) => [x.chain, x]));
    expect(by.namada).toEqual({ chain: 'namada', flows: 8, senders: 3, receivers: 3, active: 5, nam: 1000 + 5000 + 2000 + 2 * 331_386_682 + 300 + 200 + 700, trades: 0, traders: 0 });
    expect(by.osmosis).toEqual({ chain: 'osmosis', flows: 5, senders: 2, receivers: 2, active: 4, nam: 700 + 2000 + 500 + 400, trades: 3, traders: 2 });
    expect(a.metrics).toEqual({
      'active.namada_daily': 5, 'active.osmosis_daily': 4, 'masp.in_daily': 300, 'masp.out_daily': 200.5,
      'dex.volume_nam_daily': 2500, 'dex.volume_usd_daily': expect.closeTo(2.9, 9), 'dex.traders_daily': 2, 'dex.hours_with_trades_daily': 2,
      'bridge.in_daily': 400, 'bridge.out_daily': 700, 'bridge.refunded_daily': 900,
    });
  });

  it('dollar volume is written only when every trade of the day has a value at execution', () => {
    const rows = rowsWithLabels.map((r) => (r.id === 'o3' ? { ...r, value_usd: null } : r));
    expect(dayAggregates(rows, refunds).metrics['dex.volume_usd_daily']).toBeUndefined();
    expect(dayAggregates(rows, refunds).edges.find((x) => x.kind === 'buy')!.usd).toBeNull();
  });

  it('a side: protocol accounts by their own category, curated labels, the other chain, else user; a user tag is a user', () => {
    expect(sideCategory(POS, null, null, 'namada')).toBe('pos');
    expect(sideCategory(MASP, 'masp', 'auto', 'namada')).toBe('masp');
    expect(sideCategory(A, 'backer', 'user', 'namada')).toBe('user');
    expect(sideCategory(A, 'validator', 'valopers', 'namada')).toBe('user');
    expect(sideCategory(osmo(1), null, null, 'namada')).toBe('osmosis');
    expect(sideCategory(A, null, null, 'osmosis')).toBe('namada');
    expect(sideCategory(null, null, null, 'osmosis')).toBe('unknown');
  });

  it('daily() writes the two closed days from the stored rows (labels joined in SQL), replaces a day whole, and the shielded pool\'s daily value', async () => {
    const s = seed();
    expect(s.labels.get(G1)).toBe('backer');
    insert(s.db, 'flows', DAY_FLOWS.map((r) => ({ ...r, meta: JSON.stringify(r.meta) })));
    insert(s.db, 'flows', [{ ...REFUND, meta: JSON.stringify(REFUND.meta), height: 100, tx_hash: 'R1' }]);
    // a stale edge from an earlier build of the 20th must not survive
    insert(s.db, 'flow_edges_daily', [{ day: '2026-10-20', chain: 'namada', kind: 'withdraw', from_cat: 'pos', to_cat: 'user', n: 1, nam: 331_386_682, usd: null }]);
    insert(s.db, 'metrics', [{ ts: Date.UTC(2026, 9, 20, 23, 58), key: 'supply.masp_shielded', value: 50_812_000 }, { ts: Date.UTC(2026, 9, 20, 23, 59), key: 'supply.masp_shielded', value: 50_812_667 }, { ts: Date.UTC(2026, 9, 21, 0, 0), key: 'supply.masp_shielded', value: 1 }]);
    await daily(env(s.db), NOW, { health: [], validators: async () => VALIDATORS });
    const edges = all(s.db, "SELECT chain, kind, from_cat, to_cat, n, nam FROM flow_edges_daily WHERE day = '2026-10-20' ORDER BY chain, kind, from_cat, to_cat");
    expect(edges.find((x) => x.kind === 'withdraw')).toBeUndefined();
    expect(edges.find((x) => x.kind === 'transfer' && x.from_cat === 'backer')).toMatchObject({ n: 1, nam: 5000 });
    expect(edges).toHaveLength(13);
    expect(all(s.db, "SELECT chain, active FROM activity_daily WHERE day = '2026-10-20' ORDER BY chain")).toEqual([{ chain: 'namada', active: 5 }, { chain: 'osmosis', active: 4 }]);
    // the 19th had no flow: its activity is a recorded 0 (the index covered the day), not a missing row
    expect(all(s.db, "SELECT chain, flows FROM activity_daily WHERE day = '2026-10-19' ORDER BY chain")).toEqual([{ chain: 'namada', flows: 0 }, { chain: 'osmosis', flows: 0 }]);
    expect(metric(s.db, 'supply.masp_shielded.daily')).toEqual([{ ts: Date.UTC(2026, 9, 20), value: 50_812_667 }]);
    expect(metric(s.db, 'bridge.refunded_daily').find((m) => m.ts === Date.UTC(2026, 9, 20))!.value).toBe(900);
  });

  it('waits for 01:00 UTC before writing the day', async () => {
    const s = seed();
    const r = (await daily(env(s.db), Date.UTC(2026, 9, 21, 0, 5), { health: [], validators: async () => VALIDATORS }))!;
    expect(r.waiting).toContain('flow index: from 1:00 UTC');
    expect(all(s.db, 'SELECT * FROM activity_daily')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- hourly

const swap = (ts: number, kind: string, nam: number, usdc: number | null, pool: string | null, extra: Partial<SwapRow> = {}): SwapRow => ({
  id: `s${ts}${nam}`, ts, kind, amount_num: nam, counter_denom: usdc == null ? 'OSMO' : 'USDC', counter_amount: usdc, pool_id: pool, value_usd: usdc, from_addr: kind === 'sell' ? 'osmo1s' : POOL, to_addr: kind === 'buy' ? 'osmo1b' : POOL, meta: null, ...extra,
});

describe('swapHourStmts', () => {
  const h = Date.UTC(2026, 9, 20, 9);
  const rows = [
    swap(h + 50 * 60000, 'buy', 100, 0.13, '3005'),
    swap(h + 5 * 60000, 'sell', 200, 0.22, '3005', { from_addr: 'osmo1s2' }),
    swap(h + 20 * 60000, 'buy', 1000, 1.2, '3005'),
    swap(h + 30 * 60000, 'buy', 400, 0.3, '3005,3368'),   // routed: not in the price
    swap(h + 31 * 60000, 'buy', 10, 0.012, '3005'),       // under 50 NAM: not in the price
    swap(h + 32 * 60000, 'sell', 300, null, '3368'),       // NAM/OSMO, no value at execution
    swap(h + 40 * 60000, 'buy', 5000, 6, '3005', { meta: JSON.stringify({ arb: true }) }),
    swap(h + H + 1, 'buy', 77, 0.1, '3005'),               // the next hour
  ];
  const m = (st: ReturnType<typeof swapHourStmts>) => Object.fromEntries(st.map((s) => [s.params[1], s.params[2]]));

  it('price.swap_1h is the inline median cron.ts phase 3 has always written, on the same rows, to the bit', () => {
    // cron.ts phase 3 before 2026-10-20, verbatim, on the rows its SQL selects (SINGLE_POOL_USDC_SWAP)
    const sel = rows.filter((r) => r.counter_denom === 'USDC' && r.amount_num >= 50 && (r.counter_amount ?? 0) > 0 && r.pool_id && !r.pool_id.includes(',') && r.ts >= h && r.ts < h + H);
    const px = sel.map((s) => s.counter_amount! / s.amount_num).sort((a, b) => a - b);
    const old = px.length % 2 ? px[px.length >> 1] : (px[px.length / 2 - 1] + px[px.length / 2]) / 2;
    const k = m(swapHourStmts(rows, h));
    expect(k['price.swap_1h']).toBe(old);
    expect(k['price.swap_1h']).toBe(medianOf(px));
    expect(k['price.swap_1h.n']).toBe(4); // three single-pool trades and the arb (the price rule never left bots out)
    expect(swapHourStmts(rows, h).every((s) => s.params[0] === h)).toBe(true);
  });

  it('OHLC in time order and VWAP over the same swaps; volume over every trade with bots out; dollars only when every trade is priced', () => {
    const k = m(swapHourStmts(rows, h));
    expect(k['price.swap_1h.open']).toBeCloseTo(0.22 / 200, 12);
    expect(k['price.swap_1h.close']).toBeCloseTo(0.13 / 100, 12);
    expect(k['price.swap_1h.high']).toBeCloseTo(0.13 / 100, 12);
    expect(k['price.swap_1h.low']).toBeCloseTo(0.22 / 200, 12);
    expect(k['price.swap_1h.vwap']).toBeCloseTo((0.13 + 0.22 + 1.2 + 6) / (100 + 200 + 1000 + 5000), 12);
    expect(k['dex.swaps_1h.n']).toBe(6);
    expect(k['dex.swaps_1h.nam']).toBe(100 + 200 + 1000 + 400 + 10 + 300);
    expect(k['dex.swaps_1h.buy_nam']).toBe(1510);
    expect(k['dex.swaps_1h.sell_nam']).toBe(500);
    expect(k['dex.swaps_1h.buyers']).toBe(1);
    expect(k['dex.swaps_1h.sellers']).toBe(2);
    expect(k['dex.swaps_1h.usd']).toBeUndefined(); // the NAM/OSMO sell has no value at execution
    expect(k['dex.swaps_1h.buy_vwap']).toBeCloseTo((0.13 + 1.2 + 0.3 + 0.012) / 1510, 12);
    expect(k['dex.swaps_1h.sell_vwap']).toBeCloseTo(0.22 / 200, 12);
  });

  it('an hour without a trade writes nothing; an hour with only routed trades writes volume but no price', () => {
    expect(swapHourStmts(rows, h - H)).toEqual([]);
    const k = m(swapHourStmts([swap(h + 1, 'buy', 400, 0.3, '3005,3368')], h));
    expect(k['price.swap_1h']).toBeUndefined();
    expect(k['dex.swaps_1h.usd']).toBe(0.3);
  });
});

describe('hourly rollups', () => {
  it('<key>.1h is the last minute reading of the hour, .lo and .hi its extremes; a key without readings gets nothing', async () => {
    const db = testD1();
    const h = Date.UTC(2026, 9, 20, 9);
    insert(db, 'metrics', [3, 1, 4, 1, 5, 2].map((v, i) => ({ ts: h + i * 9 * 60000 + 17, key: 'price.usd', value: v / 1000 })));
    insert(db, 'metrics', [{ ts: h - 1, key: 'price.usd', value: 9 }, { ts: h + H, key: 'price.usd', value: 9 }, { ts: h + 60000, key: 'supply.total_stake', value: 267_175_777 }]);
    const rows = (await db.prepare(ROLLUP_HOUR_SQL).bind(...ROLLUP_KEYS, h, h + H).all<any>()).results;
    await runStmts(db, rollupStmts(rows, h));
    expect(Object.fromEntries(all(db, "SELECT key, value FROM metrics WHERE key LIKE '%.1h%' AND ts = ?", h).map((r) => [r.key, r.value]))).toEqual({
      'price.usd.1h': 0.002, 'price.usd.1h.lo': 0.001, 'price.usd.1h.hi': 0.005,
      'supply.total_stake.1h': 267_175_777, 'supply.total_stake.1h.lo': 267_175_777, 'supply.total_stake.1h.hi': 267_175_777,
    });
  });

  it('catches up on at most six closed hours; the first run rolls the hour just closed', () => {
    const h = Date.UTC(2026, 9, 20, 9);
    expect(hoursToRoll(null, h)).toEqual([h - H]);
    expect(hoursToRoll(h - H, h)).toEqual([h - H]);
    expect(hoursToRoll(h - 3 * H, h)).toEqual([h - 3 * H, h - 2 * H, h - H]);
    expect(hoursToRoll(h - 30 * H, h)).toHaveLength(6);
    expect(hoursToRoll(h, h)).toEqual([]);
  });
});

const POOLS: PoolInfo[] = [
  { id: '3005', type: 'concentrated', address: osmo(9001), pair: 'NAM / USDC', counterDenom: 'ibc/x', counterSymbol: 'USDC', namReserve: 601_916, counterReserve: 214, liquidityUsd: 916, spreadFactor: 0.002 },
  { id: '3008', type: 'cosmwasm', address: osmo(9002), pair: 'NAM / USDC', counterDenom: 'ibc/y', counterSymbol: 'USDC', namReserve: 1000, counterReserve: 600, liquidityUsd: 654, spreadFactor: 0 },
];
const SUMMARY = parsePairSummary(fx('osmosis-pair-summary.json'));
const CHART = parsePairChart(fx('osmosis-pair-chart.json'))!;

describe('pool_hourly and the pool price', () => {
  it('one row per pool the router lists or the summary names; the summary\'s columns only where it lists the pool', async () => {
    const db = testD1();
    const hour = Date.UTC(2026, 9, 20, 19);
    await runStmts(db, poolHourlyStmts(hour, POOLS, hour + 60000, SUMMARY));
    const rows = all(db, 'SELECT * FROM pool_hourly ORDER BY CAST(pool_id AS INTEGER)');
    expect(rows).toHaveLength(28); // the 27 NAM pairs of the summary and 3008, which the summary does not list
    expect(rows.find((r) => r.pool_id === '3005')).toMatchObject({ hour, at: hour + 60000, liquidity_usd: 916, nam_reserve: 601_916, counter_reserve: 214, spread: 0.002, volume_24h_usd_osmosis: 34.098059, volume_7d_usd_osmosis: 427.48607200000004, liquidity_usd_osmosis: 209.277765, osmosis_at: 1792523803000, trades: null, nam: null });
    expect(rows.find((r) => r.pool_id === '3008')).toMatchObject({ liquidity_usd: 654, volume_24h_usd_osmosis: null, osmosis_at: null });
    expect(rows.find((r) => r.pool_id === '3368')).toMatchObject({ at: null, liquidity_usd: null, nam_reserve: null, osmosis_at: 1792523803000 });
    // the summary unread: the router's columns only, nothing invented for the rest
    const none = poolHourlyStmts(hour, POOLS, hour, null);
    expect(none).toHaveLength(2);
    expect(none[0].params.slice(7)).toEqual([null, null, null, null]);
  });

  it('the pool price of the closed and the current hour, in dollars per NAM, flat hours flagged', () => {
    const last = CHART[CHART.length - 1].t;
    const st = poolPriceStmts(CHART, last);
    expect(st).toHaveLength(10);
    const at = (t: number, k: string) => st.find((s) => s.params[0] === t && s.params[1] === k)!.params[2];
    const p = CHART[CHART.length - 1];
    expect(at(last, 'price.pool_1h')).toBe(1 / p.raw.close);
    expect(at(last, 'price.pool_1h.high')).toBe(1 / p.raw.low);
    expect(at(last, 'price.pool_1h.flat')).toBe(p.flat ? 1 : 0);
    expect(st.every((s) => s.params[0] === last || s.params[0] === last - H)).toBe(true);
  });
});

describe('hourly()', () => {
  const hour = Math.floor(CHART[CHART.length - 1].t / H) * H; // 19:00 UTC on 20 Oct 2026, the chart's last point
  const ctx = (over: Partial<Parameters<typeof hourly>[2]> = {}) => ({ pools: POOLS, poolsAt: hour + 3 * 60000, health: [] as SourceHealth[], listingTick: false, summary: async () => SUMMARY, chart: async () => CHART, ...over });
  const seeded = () => {
    const db = testD1();
    insert(db, 'metrics', [1, 2, 3].map((v, i) => ({ ts: hour - H + i * 60000, key: 'price.usd', value: v })));
    insert(db, 'flows', [{ id: 'sw1', chain: 'osmosis', height: 1, ts: hour - 30 * 60000, tx_hash: 'SW1', kind: 'buy', from_addr: POOL, to_addr: osmo(1), amount_num: 1000, counter_denom: 'USDC', counter_amount: 1.1, pool_id: '3005', value_usd: 1.1, meta: null }]);
    insert(db, 'holders', [{ chain: 'osmosis', address: osmo(1), balance: '5', balance_num: 5, verified_at: hour - 5 * 60000, verified_src: 'keplr_rest' }]);
    return db;
  };

  it('once in the hour: rollups and the trade-hour of the closed hour, pool_hourly, the Osmosis volumes at the summary\'s own time, the pool price, holders.osmosis', async () => {
    const db = seeded();
    const c = ctx();
    const r = (await hourly(env(db), hour + 3 * 60000, c))!;
    expect(r).toMatchObject({ hour, rolled: [hour - H], summaryAt: 1792523803000, chartPoints: 169 });
    expect(metric(db, 'price.usd.1h')).toEqual([{ ts: hour - H, value: 3 }]);
    expect(metric(db, 'price.swap_1h')).toEqual([{ ts: hour - H, value: 0.0011 }]);
    expect(metric(db, 'dex.volume_24h_usd_osmosis')).toEqual([{ ts: 1792523803000, value: SUMMARY.volume24hUsd }]);
    expect(metric(db, 'price.pool_1h').map((x) => x.ts)).toEqual([hour - H, hour]);
    expect(metric(db, 'holders.osmosis')).toEqual([{ ts: hour - 5 * 60000, value: 1 }]);
    expect(all(db, 'SELECT COUNT(*) n FROM pool_hourly WHERE hour = ?', hour)[0].n).toBe(28);
    expect(c.health.map((x) => [x.name, x.ok])).toEqual([['Osmosis data API (summary)', true], ['Osmosis data API (pairs)', true]]);
    expect(await hourly(env(db), hour + 4 * 60000, ctx())).toBeNull();
    expect(await hourly(env(db), hour + JOB_WINDOW_MS + 1, ctx())).toBeNull();
  });

  it('waits for a tick without a chain listing, unless the window is closing; outside the window it reads nothing', async () => {
    const db = seeded();
    const q0 = db.queries;
    expect(await hourly(env(db), hour + 20 * 60000, ctx())).toBeNull();
    expect(db.queries).toBe(q0);
    expect(await hourly(env(db), hour + 3 * 60000, ctx({ listingTick: true }))).toBeNull();
    expect(await hourly(env(db), hour + 13 * 60000, ctx({ listingTick: true }))).not.toBeNull();
  });

  it('an Osmosis read that fails writes nothing for that source and says so; the rest is written', async () => {
    const db = seeded();
    insert(db, 'metrics', [{ ts: 1, key: 'dex.volume_24h_usd_osmosis', value: 42 }]);
    const c = ctx({ summary: async () => { throw new Error('timeout'); }, chart: async () => null });
    await hourly(env(db), hour + 3 * 60000, c);
    expect(metric(db, 'dex.volume_24h_usd_osmosis')).toEqual([{ ts: 1, value: 42 }]);
    expect(metric(db, 'price.pool_1h')).toEqual([]);
    expect(c.health.find((x) => x.name === 'Osmosis data API (summary)')).toMatchObject({ ok: false, note: expect.stringMatching(/^Not read this hour \(Error: timeout\)/) });
    expect(c.health.find((x) => x.name === 'Osmosis data API (pairs)')).toMatchObject({ ok: false, note: 'pool 3005: no series' });
    expect(all(db, 'SELECT osmosis_at FROM pool_hourly').every((r) => r.osmosis_at === null)).toBe(true);
    expect(metric(db, 'price.usd.1h')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- the listing hooks

describe('the balance listing\'s holder keys', () => {
  const PREV = NOW - H;
  it('added: first seen since the previous listing; emptied: held NAM then, or moved since, and holds none now; neither for the first listing', () => {
    const entries = new Map([['a1', '5000000'], ['a2', '1000000'], ['a3', '0'], ['a6', '3000000'], ['a7', '0'], [POS, '9']]);
    const stored = [
      { address: 'a1', balance_num: 5, first_seen: null, updated_at: PREV - D },
      { address: 'a3', balance_num: 2, first_seen: null, updated_at: PREV - D },     // emptied at this listing
      { address: 'a4', balance_num: 0, first_seen: PREV - D, updated_at: PREV + 60000 }, // emptied by a block since, not listed
      { address: 'a5', balance_num: 0, first_seen: null, updated_at: PREV - D },     // empty already at the previous listing
      { address: 'a6', balance_num: 3, first_seen: PREV + 60000, updated_at: PREV + 60000 }, // first seen since (a block)
      { address: 'a7', balance_num: 0, first_seen: PREV + 60000, updated_at: PREV + 120000 }, // came and went between listings
    ];
    const stakers = new Map([['a1', 10], ['s1', 0.5], [POS, 5]]);
    expect(holderListingStats(entries, stored, stakers, PREV)).toEqual({ holders: 4, under1: 1, userNam: 9, added: 2, emptied: 2 });
    expect(holderListingStats(entries, stored, stakers, null)).toMatchObject({ added: null, emptied: null, holders: 4 });
  });

  it('runBalanceListing writes the keys and a listings row at each complete pass, and first_seen only on the rows it creates', async () => {
    const BAL = fx('balance_listing.json');
    const db = testD1();
    const lister = (height: number) => async () => ({ ...parseBalanceListing(BAL.value), height, provider: 'TestNode' });
    insert(db, 'holders', [{ chain: 'namada', address: 'tnam1qold', balance: '5000000', balance_num: 5, updated_height: 1, updated_at: NOW - D, verified_at: NOW - D, verified_src: BALANCE_LISTING_SRC }]);
    await runBalanceListing(env(db), [], NOW, {}, lister(8343304));
    expect(metric(db, 'holders.namada')).toEqual([{ ts: NOW, value: 18 }]);
    expect(metric(db, 'holders.namada.new_1h')).toEqual([]); // the first listing: no previous one to compare with
    expect(all(db, 'SELECT * FROM listings')).toEqual([{ at: NOW, kind: 'balance', height: 8343304, provider: 'TestNode' }]);
    expect(all(db, "SELECT COUNT(*) n FROM holders WHERE chain = 'namada' AND first_seen = ?", NOW)[0].n).toBe(18);
    expect(all(db, "SELECT first_seen FROM holders WHERE address = 'tnam1qold'")[0].first_seen).toBeNull();
    await runBalanceListing(env(db), [], NOW + H, {}, lister(8343400));
    expect(metric(db, 'holders.namada.new_1h')).toEqual([{ ts: NOW + H, value: 0 }]);
    // tnam1qold was zeroed by the first listing (before it, so it is not counted again)
    expect(metric(db, 'holders.namada.gone_1h')).toEqual([{ ts: NOW + H, value: 0 }]);
    expect(all(db, "SELECT COUNT(*) n FROM holders WHERE chain = 'namada' AND first_seen = ?", NOW)[0].n).toBe(18);
    expect(all(db, 'SELECT COUNT(*) n FROM listings')[0].n).toBe(2);
  });

  it('first_seen: set when a row is created holding NAM, never by an update, never on an empty row', async () => {
    const db = testD1();
    await runStmts(db, [stmt.namadaBalance({ address: 'tnam1qa', balance: '0', height: 5 }, 100), stmt.namadaBalance({ address: 'tnam1qb', balance: '7', height: 5 }, 100)]);
    await runStmts(db, [stmt.namadaBalance({ address: 'tnam1qa', balance: '9', height: 6 }, 200), stmt.namadaBalance({ address: 'tnam1qb', balance: '8', height: 6 }, 200)]);
    await runStmts(db, listingBalanceStmts([{ address: 'tnam1qb', balance: '8' }, { address: 'tnam1qc', balance: '3' }], 7, 300, 'test'));
    expect(all(db, 'SELECT address, first_seen FROM holders ORDER BY address')).toEqual([{ address: 'tnam1qa', first_seen: null }, { address: 'tnam1qb', first_seen: 100 }, { address: 'tnam1qc', first_seen: 300 }]);
  });
});

describe('the bond listing\'s rows', () => {
  const BONDS = fx('bonds_listing.json');
  const listing = { ...parseBondListing(BONDS.value), height: 8343327, provider: 'TestNode' };
  const EPOCH = 2685;

  it('the unbond queue by withdraw epoch matches the term structure built from the same listing', () => {
    const q = unbondQueue(listing, EPOCH);
    const { termStructure } = buildUnbondTermStructure(listing, listing.height, EPOCH, NOW, 21600);
    expect(q.rows.map((r) => [r.epoch, r.n])).toEqual(termStructure.buckets.map((b) => [b.withdrawEpoch, b.count]));
    q.rows.forEach((r, i) => expect(r.nam).toBeCloseTo(termStructure.buckets[i].amountNam, 6));
    expect(q.withdrawableNam).toBeCloseTo(termStructure.withdrawableNowNam, 6);
    expect(q.unbondingNam).toBeCloseTo(termStructure.inFlightNam, 6);
    expect(q.rows.length).toBeGreaterThan(0);
  });

  it('shares use the chain\'s total stake as the one denominator; without it they are not written', () => {
    const stakeNam = 100_000_000;
    const st = stakeStructure(listing, stakeNam);
    const vals = [...st.byValidator.values()].map((v) => v.stake).sort((a, b) => b - a);
    expect(st.top10Pct).toBeCloseTo((vals.slice(0, 10).reduce((a, b) => a + b, 0) / stakeNam) * 100, 9);
    let c = 0, third = 0; for (const v of vals) { c += v; third++; if (c >= stakeNam / 3) break; }
    expect(st.thirdCount).toBe(c >= stakeNam / 3 ? third : null);
    expect(st.stakers).toBe(BONDS.expected.stakers);
    const none = stakeStructure(listing, null);
    expect([none.top10Pct, none.thirdCount, none.share1mPlus]).toEqual([null, null, null]);
  });

  it('bondListingSeries: keys every listing, the queue only when it changed, validator_daily once a UTC day, a listings row each time', async () => {
    const db = testD1();
    const named = [...listing.sources.values()].find((x) => x.delegations.length)!.delegations[0].validator;
    insert(db, 'kv', [{ key: 'validators.names', value: JSON.stringify({ at: NOW - H, validators: [{ address: named, name: 'Named', commission: 0.05, state: 'consensus' }] }), updated_at: 1 }]);
    const a = await bondListingSeries(db as any, NOW, listing, EPOCH, 267_175_777);
    expect(a.queueChanged).toBe(true);
    const q = all(db, 'SELECT * FROM unbond_queue ORDER BY withdraw_epoch');
    expect(q.length).toBe(a.queue.rows.length);
    expect(q.every((r) => r.listed_at === NOW && r.height === 8343327)).toBe(true);
    const vd = all(db, 'SELECT * FROM validator_daily');
    expect(vd.length).toBe(a.validatorsWritten);
    expect(vd.filter((r) => r.name === 'Named')).toEqual([expect.objectContaining({ validator: named, commission: 0.05, state: 'consensus', names_at: NOW - H })]);
    expect(vd.filter((r) => r.name == null).every((r) => r.names_at == null && r.commission == null)).toBe(true);
    expect(vd.reduce((s, r) => s + r.stake, 0)).toBeCloseTo(Number(BigInt(BONDS.expected.totalBase)) / 1e6, 4);
    const b = await bondListingSeries(db as any, NOW + 40 * 60000, listing, EPOCH, 267_175_777);
    expect(b).toMatchObject({ queueChanged: false, validatorsWritten: 0 });
    expect(all(db, 'SELECT listed_at FROM unbond_queue').every((r) => r.listed_at === NOW)).toBe(true);
    expect(metric(db, 'stake.validators').map((x) => x.ts)).toEqual([NOW, NOW + 40 * 60000]);
    expect(all(db, "SELECT COUNT(*) n FROM listings WHERE kind = 'bond'")[0].n).toBe(2);
    // the next UTC day: validator_daily again
    const c = await bondListingSeries(db as any, NOW + D, listing, EPOCH, 267_175_777);
    expect(c.validatorsWritten).toBe(a.validatorsWritten);
    expect(all(db, 'SELECT DISTINCT day FROM validator_daily ORDER BY day').map((r) => r.day)).toEqual([isoDay(NOW), isoDay(NOW + D)]);
  });
});

// ---------------------------------------------------------------- the reads' plans

describe('query plans', () => {
  const plan = (db: TestD1, sql: string, n: number) => all(db, `EXPLAIN QUERY PLAN ${sql}`, ...Array.from({ length: n }, () => 1)).map((r) => r.detail).join(' | ');
  const params = (sql: string) => (sql.match(/\?/g) ?? []).length;

  it('every range read the API will serve is a primary-key or index search, never a temporary B-tree', () => {
    const db = testD1();
    for (const [name, sql] of Object.entries(SERIES_READS)) {
      const p = plan(db, sql, params(sql));
      expect(p, name).toMatch(/SEARCH/);
      expect(p, name).toMatch(/USING (INDEX|PRIMARY KEY|INTEGER PRIMARY KEY|COVERING INDEX)/);
      expect(p, name).not.toMatch(/TEMP B-TREE/);
    }
  });

  it('the cron\'s range reads search an index and never scan flows', () => {
    const db = testD1();
    const r = plan(db, ROLLUP_HOUR_SQL.replace(/\?\d/g, '?'), 6);
    expect(r).toMatch(/SEARCH metrics USING INDEX/);
    for (const sql of [DAY_FLOWS_SQL, SWAP_HOUR_SQL]) {
      const p = plan(db, sql, params(sql));
      expect(p).toMatch(/SEARCH f(lows)? USING INDEX/);
      expect(p).not.toMatch(/SCAN f(lows)?\b(?! USING)/);
    }
  });
});
