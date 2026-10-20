// The bulk index (2026-10-20): every NAM balance and every bond from one chain answer each, reconciled against the
// stored rows. Parsers on fixtures cut from the real answers (test/fixtures/balance_listing.json,
// bonds_listing.json; `expected` is an independent Python decode), the listing runs on the D1 stand-in.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseBalanceListing, parseBondListing, base64Bytes } from '../worker/src/sources/namada';
import { NAMADA } from '../worker/src/config';
import {
  runBalanceListing, runBondListing, sampleStakes, bondedCoverageCheck, listingDue, balanceGate, bondGate,
  BALANCE_LISTING_MS, BOND_LISTING_MS, LISTING_WRITE_CAP, LISTING_RETRY_MS, SAMPLE_PER_TICK, RETIRED_HEALTH,
  type BalanceListingRecord, type BondListingRecord, type StakeSampleRecord,
} from '../worker/src/cron';
import {
  BALANCE_LISTING_SRC, BOND_LISTING_SRC, SPAN_EXTEND_MS, SPAN_MAX_GAP_MS, NAMADA_TOP10_SQL, HOLDER_DUST_SQL, listingTimes, confirmedAt,
} from '../worker/src/holders';
import { app } from '../worker/src/api';
import { testD1, insert, runStmts, type TestD1 } from './d1-sqlite';
import type { HoldersResponse, Overview, SourceHealth } from '../shared/types';

const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));
const BAL = fx('balance_listing.json');
const BONDS = fx('bonds_listing.json');
const H = 3600000, D = 86400000;
const NOW = Date.UTC(2026, 9, 20, 12, 0);
const ADDR = /^tnam1[02-9ac-hj-np-z]{40}$/;
const POS = NAMADA.internal.pos;
afterEach(() => vi.unstubAllGlobals());

// ---------------------------------------------------------------- the parsers

describe('the balance listing parser', () => {
  const l = parseBalanceListing(BAL.value);
  const e = BAL.expected;
  it('reads every key to the last byte: user keys, the internal accounts and the minted total apart', () => {
    expect(l.keys).toBe(e.keys);
    expect(l.entries.size).toBe(e.users);
    expect(l.minted).toBe(e.minted);
    expect([...l.internal.entries()].sort()).toEqual(Object.entries(e.internal).sort());
    expect(l.bytes).toBe(base64Bytes(BAL.value).length);
  });
  it('base units stay exact strings; zero balances are listed, so "listed as 0" and "not listed" differ', () => {
    let sum = 0n, holders = 0, zero = 0, under1 = 0;
    for (const v of l.entries.values()) {
      expect(v).toMatch(/^\d+$/);
      const b = BigInt(v);
      if (b === 0n) zero++;
      else { holders++; sum += b; if (b < 1_000_000n) under1++; }
    }
    expect({ holders, zero, under1, sum: sum.toString() }).toEqual({ holders: e.holders, zero: e.zero, under1: e.under1Nam, sum: e.sumBase });
    expect(Object.fromEntries(l.entries)).toEqual(e.users_);
  });
  it('the internal accounts are the protocol addresses of config.ts, never holders', () => {
    for (const a of [NAMADA.internal.pos, NAMADA.internal.ibc, NAMADA.internal.masp, NAMADA.internal.pgf, NAMADA.internal.governance]) {
      expect(l.internal.has(a), a).toBe(true);
      expect(l.entries.has(a)).toBe(false);
    }
    expect(l.internal.get(NAMADA.internal.pos)).toBe('342121957580800');
    expect(l.internal.get(NAMADA.internal.masp)).toBe('50812666690835');
  });
  it('every user address is a valid bech32m tnam address, established and implicit alike', () => {
    let est = 0, imp = 0;
    for (const a of l.entries.keys()) {
      expect(a).toMatch(ADDR);
      // the first bech32 character after "tnam1q" tells the discriminant: implicit (0) q, p, z, r; established (1) from 8
      if ('qpzr'.includes(a[6])) imp++; else est++;
    }
    expect({ est, imp }).toEqual({ est: e.established, imp: e.implicit });
  });
  it('a truncated or altered answer is refused whole, never half-read', () => {
    const bytes = base64Bytes(BAL.value);
    const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
    expect(() => parseBalanceListing(b64(bytes.subarray(0, bytes.length - 7)))).toThrow(/ends early/);
    expect(() => parseBalanceListing(b64(bytes.subarray(0, 300)))).toThrow();
    const extra = new Uint8Array(bytes.length + 3); extra.set(bytes);
    expect(() => parseBalanceListing(b64(extra))).toThrow(/unread bytes/);
    // byte 15: inside the NAM token address of the first key (count 4, segments 4, multitoken segment 3: tag, kind, variant)
    const wrongToken = new Uint8Array(bytes); wrongToken[15] ^= 1;
    expect(() => parseBalanceListing(b64(wrongToken))).toThrow(/not a NAM key/);
    expect(() => parseBalanceListing(null)).toThrow();
    expect(() => parseBalanceListing('@@@@')).toThrow(/base64/);
  });
});

describe('the bond listing parser', () => {
  const l = parseBondListing(BONDS.value);
  const e = BONDS.expected;
  it('sums every bond entry per source and per validator, exactly', () => {
    expect(l.entries).toBe(e.entries);
    expect(l.sources.size).toBe(e.sources);
    expect(l.totalBase.toString()).toBe(e.totalBase);
    let stakers = 0;
    for (const [src, b] of l.sources) {
      expect(src).toMatch(ADDR);
      expect(b.bondedBase.toString()).toBe(e.perSource[src].bondedBase);
      if (b.bondedBase > 0n) stakers++;
      const want = Object.entries(e.perSource[src].validators as Record<string, string>).filter(([, a]) => a !== '0').map(([v, a]) => ({ validator: v, amountNam: Number(BigInt(a)) / 1e6 })).sort((x, y) => (x.validator < y.validator ? -1 : 1));
      expect(b.delegations).toEqual(want);
    }
    expect(stakers).toBe(e.stakers);
  });
  it('a validator\'s self-bond is a delegation to itself; a source with only unbonds left is listed with 0', () => {
    for (const v of e.selfBonded) expect(l.sources.get(v)!.delegations.some((d) => d.validator === v && d.amountNam > 0)).toBe(true);
    const zero = [...l.sources].filter(([, b]) => b.bondedBase === 0n);
    expect(zero.length).toBe(e.sources - e.stakers);
    for (const [, b] of zero) expect(b.delegations).toEqual([]);
  });
  it('the per-validator answer has the same layout: 137 delegations, 4,394,385.374146 NAM (decoded independently)', () => {
    const { value } = fx('bonds_to_validator.json');
    const d = parseBondListing(value);
    expect(d.sources.size).toBe(137);
    expect(Number(d.totalBase) / 1e6).toBeCloseTo(4394385.374146, 3);
  });
  it('a truncated answer is refused', () => {
    const bytes = base64Bytes(BONDS.value);
    expect(() => parseBondListing(btoa(String.fromCharCode(...bytes.subarray(0, 2000))))).toThrow();
    expect(() => parseBondListing(btoa(String.fromCharCode(...bytes, 0)))).toThrow(/unread/);
  });
});

// ---------------------------------------------------------------- the listing runs on the real schema

type BalEnv = { DB: TestD1 };
const env = (db: TestD1) => ({ DB: db } as unknown as BalEnv as any);
const balLister = (height = 8343304, provider = 'TestNode') => async () => ({ ...parseBalanceListing(BAL.value), height, provider });
const bondLister = (height = 8343327, provider = 'TestNode') => async () => ({ ...parseBondListing(BONDS.value), height, provider });
const rows = (db: TestD1, sql: string) => db.raw.prepare(sql).all().map((r: any) => ({ ...r }));
const kv = <T,>(db: TestD1, key: string): T | null => { const r = db.raw.prepare('SELECT value FROM kv WHERE key = ?').get(key); return r ? JSON.parse(r.value) : null; };
const positive = Object.entries(BAL.expected.users_ as Record<string, string>).filter(([, v]) => v !== '0');
const FIRST = positive.map(([a]) => a).sort()[0];

describe('the balance listing run', () => {
  it('an empty table: every address holding NAM gets a row (not the zero keys, not the internal accounts), spans open, the record says so', async () => {
    const db = testD1();
    const health: SourceHealth[] = [];
    const rec = (await runBalanceListing(env(db), health, NOW, {}, balLister()))!;
    expect(rec).toMatchObject({ at: NOW, completeAt: NOW, height: 8343304, keys: 28, holders: 18, written: 18, zeroed: 0, remaining: 0, ticks: 1, spansAt: NOW, extendedAt: NOW });
    expect(rec.totalNam).toBeCloseTo(Number(BigInt(BAL.expected.sumBase)) / 1e6, 6);
    const hs = rows(db, "SELECT address, balance, balance_num, updated_height, verified_at, verified_src FROM holders WHERE chain='namada' ORDER BY address");
    expect(hs.length).toBe(18);
    for (const h of hs) {
      expect(h).toMatchObject({ updated_height: 8343304, verified_at: NOW, verified_src: BALANCE_LISTING_SRC });
      expect(h.balance).toBe(BAL.expected.users_[h.address]);
      expect(h.balance_num).toBeCloseTo(Number(BigInt(h.balance)) / 1e6, 9);
    }
    expect(hs.some((h) => h.address === POS)).toBe(false);
    expect(db.raw.prepare('SELECT COUNT(*) n FROM balance_spans').get().n).toBe(18);
    expect(health[0]).toMatchObject({ name: 'Namada RPC (balance listing)', ok: true });
    expect(health[0].note).toMatch(/^28 balance keys at height 8,343,304 \(0\.0 MB from TestNode\): 18 addresses hold 324,665 NAM; 18 rows written$/);
    expect(await listingTimes(db as any)).toEqual({ balance: NOW, bond: null });
  });

  it('a second run finds the index current and writes nothing; a changed row, a new row and a stale row are the only writes', async () => {
    const db = testD1();
    await runBalanceListing(env(db), [], NOW, {}, balLister());
    const again = (await runBalanceListing(env(db), [], NOW + H, {}, balLister(8343400)))!;
    expect(again).toMatchObject({ written: 0, zeroed: 0, remaining: 0, completeAt: NOW + H });
    // the balance of one address moved on chain (an older block than the next listing's height) …
    db.raw.prepare("UPDATE holders SET balance='123', balance_num=0.000123, updated_height=8343350 WHERE address=?").run(FIRST);
    // … one row was written by the old refresh with the right balance, so only its source differs …
    db.raw.prepare("UPDATE holders SET verified_src='5ElementsNodes' WHERE address=?").run(positive[1][0] < positive[2][0] ? positive[2][0] : positive[1][0]);
    // … and one stored holder is not in the listing at all
    insert(db, 'holders', [{ chain: 'namada', address: 'tnam1qgone', balance: '5000000', balance_num: 5, updated_height: 1, updated_at: NOW - D, verified_at: NOW - D, verified_src: BALANCE_LISTING_SRC }]);
    const third = (await runBalanceListing(env(db), [], NOW + 2 * H, {}, balLister(8343500)))!;
    expect(third).toMatchObject({ written: 2, zeroed: 1, remaining: 0 });
    expect(db.raw.prepare('SELECT balance, updated_height FROM holders WHERE address=?').get(FIRST)).toMatchObject({ balance: BAL.expected.users_[FIRST], updated_height: 8343500 });
    expect(db.raw.prepare("SELECT balance_num, verified_at, verified_src FROM holders WHERE address='tnam1qgone'").get()).toMatchObject({ balance_num: 0, verified_at: NOW + 2 * H, verified_src: BALANCE_LISTING_SRC });
    expect(db.raw.prepare("SELECT COUNT(*) n FROM holders WHERE verified_src != ?").get(BALANCE_LISTING_SRC).n).toBe(0);
  });

  it('never overwrites a post-balance the block follower wrote from a later block, and never zeroes a protocol account', async () => {
    const db = testD1();
    await runBalanceListing(env(db), [], NOW, {}, balLister(8343304));
    db.raw.prepare("UPDATE holders SET balance='777', balance_num=0.000777, updated_height=8343999, updated_at=? WHERE address=?").run(NOW + 60000, FIRST);
    insert(db, 'holders', [{ chain: 'namada', address: POS, balance: '342121957580800', balance_num: 342121957.5808, updated_height: 8343304, updated_at: NOW, verified_at: NOW, verified_src: '5ElementsNodes' }]);
    const rec = (await runBalanceListing(env(db), [], NOW + H, {}, balLister(8343500)))!;
    expect(rec).toMatchObject({ written: 0, zeroed: 0, remaining: 0 });
    expect(db.raw.prepare('SELECT balance, updated_height FROM holders WHERE address=?').get(FIRST)).toMatchObject({ balance: '777', updated_height: 8343999 });
    expect(db.raw.prepare('SELECT balance_num FROM holders WHERE address=?').get(POS).balance_num).toBeCloseTo(342121957.5808, 3);
  });

  it('a first run on an empty table is written over several ticks under the cap, zeroing and spans wait for the last, nothing is lost', async () => {
    const db = testD1();
    insert(db, 'holders', [{ chain: 'namada', address: 'tnam1qgone', balance: '5000000', balance_num: 5, updated_height: 1, updated_at: NOW - D, verified_at: NOW - D, verified_src: BALANCE_LISTING_SRC }]);
    const r1 = (await runBalanceListing(env(db), [], NOW, {}, balLister(), 5))!;
    expect(r1).toMatchObject({ written: 5, remaining: 13, zeroed: 0, completeAt: null, ticks: 1, spansAt: null });
    expect(listingDue(r1, BALANCE_LISTING_MS, NOW + 60000)).toBe(true); // rows left: due next tick, whatever the interval
    expect(db.raw.prepare("SELECT balance_num FROM holders WHERE address='tnam1qgone'").get().balance_num).toBe(5);
    expect(db.raw.prepare('SELECT COUNT(*) n FROM balance_spans').get().n).toBe(0);
    const r2 = (await runBalanceListing(env(db), [], NOW + 60000, {}, balLister(), 5))!;
    expect(r2).toMatchObject({ written: 5, remaining: 8, ticks: 2 });
    const r3 = (await runBalanceListing(env(db), [], NOW + 120000, {}, balLister(), 5))!;
    const r4 = (await runBalanceListing(env(db), [], NOW + 180000, {}, balLister(), 5))!;
    expect(r3).toMatchObject({ written: 5, remaining: 3, ticks: 3 });
    expect(r4).toMatchObject({ written: 3, remaining: 0, zeroed: 1, completeAt: NOW + 180000, ticks: 4, spansAt: NOW + 180000 });
    expect(db.raw.prepare("SELECT COUNT(*) n FROM holders WHERE chain='namada' AND balance_num > 0").get().n).toBe(18);
    expect(db.raw.prepare('SELECT COUNT(*) n FROM balance_spans').get().n).toBe(19); // 18 holders and the measured zero
    expect(listingDue(r4, BALANCE_LISTING_MS, NOW + 180000 + 30 * 60000)).toBe(false);
    expect(listingDue(r4, BALANCE_LISTING_MS, NOW + 180000 + BALANCE_LISTING_MS)).toBe(true);
    expect(LISTING_WRITE_CAP).toBe(3000);
  });

  it('spans: an unchanged balance is extended every 5 h, a change closes the old span at the previous listing and opens a new one', async () => {
    const db = testD1();
    await runBalanceListing(env(db), [], NOW, {}, balLister());
    await runBalanceListing(env(db), [], NOW + H, {}, balLister());
    await runBalanceListing(env(db), [], NOW + 2 * H, {}, balLister());
    const span = () => rows(db, 'SELECT from_ts, to_ts, balance, reads FROM balance_spans WHERE address = ? ORDER BY from_ts').filter(() => true);
    const spansOf = (a: string) => db.raw.prepare('SELECT from_ts, to_ts, balance, reads FROM balance_spans WHERE address = ? ORDER BY from_ts').all(a).map((r: any) => ({ ...r }));
    expect(spansOf(FIRST)).toEqual([{ from_ts: NOW, to_ts: NOW, balance: BAL.expected.users_[FIRST], reads: 1 }]); // not extended yet: within 5 h
    await runBalanceListing(env(db), [], NOW + SPAN_EXTEND_MS, {}, balLister());
    expect(spansOf(FIRST)).toEqual([{ from_ts: NOW, to_ts: NOW + SPAN_EXTEND_MS, balance: BAL.expected.users_[FIRST], reads: 2 }]);
    expect(kv<BalanceListingRecord>(db, 'balance.listing')!.extendedAt).toBe(NOW + SPAN_EXTEND_MS);
    // one more listing finds it unchanged (no sweep: under 5 h since the last); then the balance changes on chain
    await runBalanceListing(env(db), [], NOW + SPAN_EXTEND_MS + H, {}, balLister());
    expect(spansOf(FIRST)).toEqual([{ from_ts: NOW, to_ts: NOW + SPAN_EXTEND_MS, balance: BAL.expected.users_[FIRST], reads: 2 }]);
    const changed = { ...parseBalanceListing(BAL.value) };
    changed.entries = new Map(changed.entries); changed.entries.set(FIRST, '999000000');
    const t = NOW + SPAN_EXTEND_MS + 2 * H;
    await runBalanceListing(env(db), [], t, {}, async () => ({ ...changed, height: 8343900, provider: 'TestNode' }));
    expect(spansOf(FIRST)).toEqual([
      { from_ts: NOW, to_ts: NOW + SPAN_EXTEND_MS + H, balance: BAL.expected.users_[FIRST], reads: 3 }, // closed at the previous listing, which confirmed it
      { from_ts: t, to_ts: t, balance: '999000000', reads: 1 },
    ]);
    // a listing after a gap longer than the span rule opens new spans rather than assuming anything across it
    await runBalanceListing(env(db), [], t + SPAN_MAX_GAP_MS + H, {}, async () => ({ ...changed, height: 8344900, provider: 'TestNode' }));
    expect(spansOf(FIRST).length).toBe(3);
    expect(SPAN_EXTEND_MS).toBeLessThan(SPAN_MAX_GAP_MS);
    void span;
  });

  it('a listing that cannot be read leaves the rows as they were, says so, and is not tried again for 5 minutes', async () => {
    const db = testD1();
    const health: SourceHealth[] = [];
    const r = (await runBalanceListing(env(db), health, NOW, {}, async () => { throw new Error('abci: deadline passed'); }))!;
    expect(r).toMatchObject({ at: 0, completeAt: null, failedAt: NOW, error: 'Error: abci: deadline passed', remaining: 0 });
    expect(health[0]).toMatchObject({ name: 'Namada RPC (balance listing)', ok: false });
    expect(health[0].note).toMatch(/could not be read: Error: abci: deadline passed/);
    expect(db.raw.prepare('SELECT COUNT(*) n FROM holders').get().n).toBe(0);
    expect(listingDue(r, BALANCE_LISTING_MS, NOW + 60000)).toBe(false);
    expect(listingDue(r, BALANCE_LISTING_MS, NOW + LISTING_RETRY_MS)).toBe(true);
    expect(await listingTimes(db as any)).toEqual({ balance: null, bond: null });
    // a complete pass stays complete through a later failure, and the next success clears the failure
    await runBalanceListing(env(db), [], NOW + LISTING_RETRY_MS, {}, balLister());
    const f = (await runBalanceListing(env(db), [], NOW + 2 * H, {}, async () => { throw new Error('timeout'); }))!;
    expect(f).toMatchObject({ completeAt: NOW + LISTING_RETRY_MS, failedAt: NOW + 2 * H, error: 'Error: timeout', holders: 18 });
    expect((await listingTimes(db as any)).balance).toBe(NOW + LISTING_RETRY_MS);
    expect(listingDue(f, BALANCE_LISTING_MS, NOW + 2 * H + 60000)).toBe(false);
    const ok = (await runBalanceListing(env(db), [], NOW + 3 * H, {}, balLister()))!;
    expect(ok).toMatchObject({ failedAt: null, completeAt: NOW + 3 * H });
    expect(ok.error).toBeUndefined();
  });
});

describe('the bond listing run', () => {
  const e = BONDS.expected;
  const stakers = Object.entries(e.perSource as Record<string, { bondedBase: string }>).filter(([, v]) => v.bondedBase !== '0').map(([a]) => a).sort();
  it('writes every source with bonds to stakes (sum and sorted delegations), not the unbond-only ones', async () => {
    const db = testD1();
    const health: SourceHealth[] = [];
    const rec = (await runBondListing(env(db), health, NOW, 2690, {}, bondLister()))!;
    expect(rec).toMatchObject({ at: NOW, completeAt: NOW, height: 8343327, epoch: 2690, sources: 15, stakers: 12, written: 12, zeroed: 0, remaining: 0 });
    expect(rec.totalNam).toBeCloseTo(Number(BigInt(e.totalBase)) / 1e6, 6);
    const st = rows(db, 'SELECT address, bonded_num, delegations, verified_epoch, verified_height, verified_at, verified_src FROM stakes ORDER BY address');
    expect(st.map((r) => r.address)).toEqual(stakers);
    for (const r of st) {
      expect(r).toMatchObject({ verified_epoch: 2690, verified_height: 8343327, verified_at: NOW, verified_src: BOND_LISTING_SRC });
      expect(r.bonded_num).toBeCloseTo(Number(BigInt(e.perSource[r.address].bondedBase)) / 1e6, 9);
      const d = JSON.parse(r.delegations) as { validator: string; amountNam: number }[];
      expect(d.map((x) => x.validator)).toEqual([...d.map((x) => x.validator)].sort());
      expect(d.reduce((a, x) => a + x.amountNam, 0)).toBeCloseTo(r.bonded_num, 6);
    }
    expect(health[0]).toMatchObject({ name: 'Namada RPC (bond listing)', ok: true });
    expect(health[0].note).toMatch(/^48 bond entries at height 8,343,327 \(0\.0 MB from TestNode\): 12 addresses stake 75,564,397 NAM, bonds in the pipeline included; 12 rows written$/);
  });

  it('writes only what changed: a row from the old per-address read once (its source), a changed stake, and 0 for a staker the chain no longer lists', async () => {
    const db = testD1();
    await runBondListing(env(db), [], NOW, 2690, {}, bondLister());
    expect((await runBondListing(env(db), [], NOW + H, 2691, {}, bondLister()))!).toMatchObject({ written: 0, zeroed: 0, remaining: 0, completeAt: NOW + H });
    db.raw.prepare("UPDATE stakes SET verified_src='Papadritta' WHERE address=?").run(stakers[0]);
    db.raw.prepare('UPDATE stakes SET bonded_num = bonded_num + 1 WHERE address=?').run(stakers[1]);
    insert(db, 'stakes', [{ address: 'tnam1qleft', bonded_num: 42, delegations: '[]', verified_at: NOW - D, verified_epoch: 2600, verified_src: BOND_LISTING_SRC, updated_at: NOW - D }]);
    insert(db, 'stakes', [{ address: 'tnam1qestimateonly', estimated_num: 7, updated_at: NOW }]);
    const r = (await runBondListing(env(db), [], NOW + 2 * H, 2691, {}, bondLister()))!;
    expect(r).toMatchObject({ written: 2, zeroed: 1, remaining: 0 });
    expect(db.raw.prepare("SELECT bonded_num, verified_src, verified_epoch, verified_height FROM stakes WHERE address='tnam1qleft'").get()).toMatchObject({ bonded_num: 0, verified_src: BOND_LISTING_SRC, verified_epoch: 2691, verified_height: 8343327 });
    expect(db.raw.prepare("SELECT bonded_num, estimated_num FROM stakes WHERE address='tnam1qestimateonly'").get()).toMatchObject({ bonded_num: null, estimated_num: 7 });
    expect(db.raw.prepare('SELECT COUNT(*) n FROM stakes WHERE verified_src != ?').get(BOND_LISTING_SRC).n).toBe(0);
  });

  it('carries the rest over under the cap and keeps the pass open until it is done', async () => {
    const db = testD1();
    const r1 = (await runBondListing(env(db), [], NOW, 2690, {}, bondLister(), 10))!;
    expect(r1).toMatchObject({ written: 10, remaining: 2, completeAt: null, ticks: 1 });
    expect(listingDue(r1, BOND_LISTING_MS, NOW + 60000)).toBe(true);
    const r2 = (await runBondListing(env(db), [], NOW + 60000, 2690, {}, bondLister(), 10))!;
    expect(r2).toMatchObject({ written: 2, remaining: 0, completeAt: NOW + 60000, ticks: 2 });
    expect(db.raw.prepare('SELECT COUNT(*) n FROM stakes WHERE bonded_num > 0').get().n).toBe(12);
  });

  it('refuses listings that fail balanceGate or bondGate and heals timestamp-poisoned heights', async () => {
    const db = testD1();
    await runBalanceListing(env(db), [], NOW, {}, balLister(8343304));
    await runBondListing(env(db), [], NOW, 2690, {}, bondLister(8343327));
    // A listing whose sum does not match minted is refused by balanceGate without zeroing holders
    const badBal = { ...parseBalanceListing(BAL.value), minted: '999999999999999999', height: 8343400, provider: 'BadNode' };
    const rBad = (await runBalanceListing(env(db), [], NOW + H, {}, async () => badBal))!;
    expect(rBad.error).toMatch(/^Not applied: the balances in the listing add up to .*off the minted total/);
    expect(db.raw.prepare("SELECT COUNT(*) n FROM holders WHERE chain='namada' AND balance_num > 0").get().n).toBe(18);
    // Stale or future-spoofed heights are refused when headHeight is known
    expect(balanceGate({ ...parseBalanceListing(BAL.value), height: 8340000 }, 8343400).ok).toBe(false);
    expect(balanceGate({ ...parseBalanceListing(BAL.value), height: 8350000 }, 8343400).ok).toBe(false);
    expect(bondGate({ ...parseBondListing(BONDS.value), height: 8340000 }, 8343400).ok).toBe(false);
    expect(bondGate({ ...parseBondListing(BONDS.value), height: 8350000 }, 8343400).ok).toBe(false);
    // If a row in stakes or holders had a Unix timestamp accidentally stored in verified_height / updated_height, a real height heals it
    db.raw.prepare('UPDATE stakes SET bonded_num = 1, verified_height = ? WHERE address = ?').run(NOW, stakers[0]);
    await runBondListing(env(db), [], NOW + 2 * H, 2691, {}, bondLister(8343500));
    expect(db.raw.prepare('SELECT verified_height FROM stakes WHERE address = ?').get(stakers[0]).verified_height).toBe(8343500);
  });
});

// ---------------------------------------------------------------- the sample and the coverage check

const u256 = (n: bigint) => { const b = new Uint8Array(32); let v = n; for (let i = 0; i < 32; i++) { b[i] = Number(v & 0xffn); v >>= 8n; } return btoa(String.fromCharCode(...b)); };
const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });

describe('the stake sample and the coverage check', () => {
  it('re-reads stakers in address order against the listing, records a difference without touching the row, and rotates', async () => {
    const db = testD1();
    await runBondListing(env(db), [], NOW, 2690, {}, bondLister());
    const stakers = rows(db, 'SELECT address, bonded_num, delegations FROM stakes WHERE bonded_num > 0 ORDER BY address');
    const odd = stakers[2].address; // the chain says 1 NAM more (a bond still in the pipeline is listed, not yet counted)
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = decodeURIComponent(String(input).split('path=')[1] ?? '');
      const m = /delegations_at\/(tnam1\w+)\//.exec(path);
      if (m) {
        const row = stakers.find((r) => r.address === m[1])!;
        const ds = JSON.parse(row.delegations) as { validator: string; amountNam: number }[];
        // HashMap<Address, Amount>: count, then 21-byte addresses and 32-byte amounts
        const parts: number[] = [ds.length, 0, 0, 0];
        for (const d of ds) {
          const raw = new Uint8Array(21); raw[0] = 0; // tag + hash: the address bytes are not checked here
          const hash = Uint8Array.from(atob(u256(BigInt(Math.round(d.amountNam * 1e6)) + (row.address === odd && d === ds[0] ? 1_000_000n : 0n))), (c) => c.charCodeAt(0));
          parts.push(...raw, ...hash);
        }
        return json({ result: { response: { code: 0, value: btoa(String.fromCharCode(...parts)), height: '8343400' } } });
      }
      if (path.includes('/vp/pos/bond/')) return json({ result: { response: { code: 1, info: 'Cannot find bond', value: null, height: '1' } } });
      return new Response('not here', { status: 404 });
    }));
    const health: SourceHealth[] = [];
    const rec = (await sampleStakes(env(db), health, NOW + 60000, 2690, { timeoutMs: 1000, retries: 0 }))!;
    expect(rec).toMatchObject({ checked: 12, agreed: 11, failed: 0, cursor: '', passes: 1 });
    expect(rec.disagreements).toEqual([{ address: odd, listingNam: stakers[2].bonded_num, chainNam: stakers[2].bonded_num + 1, epoch: 2690, at: NOW + 60000 }]);
    // the row keeps the listing's figure and source (owner decision 7)
    expect(db.raw.prepare('SELECT bonded_num, verified_src FROM stakes WHERE address=?').get(odd)).toMatchObject({ bonded_num: stakers[2].bonded_num, verified_src: BOND_LISTING_SRC });
    expect(health[0]).toMatchObject({ name: 'Namada RPC (stake sample)', ok: true });
    expect(health[0].note).toBe('11 of 12 sampled stakes match the bond listing to the base unit, 1 differ (bonds still in the pipeline, or slashed); 1 full passes so far');
    expect(SAMPLE_PER_TICK).toBe(24);
  });

  it('the coverage check passes within 2% of the total stake once the listing is complete, and reports what the UI reads', async () => {
    const db = testD1();
    const bond = (await runBondListing(env(db), [], NOW, 2690, {}, bondLister()))!;
    const stakeNam = bond.totalNam / 1.003; // the listing runs 0.3% above the chain's total stake (pipeline bonds)
    const sample: StakeSampleRecord = { at: NOW, cursor: '', checked: 12, agreed: 11, failed: 0, passes: 1, disagreements: [{ address: 'tnam1qx', listingNam: 1, chainNam: 2, epoch: 2690, at: NOW }] };
    const ok = await bondedCoverageCheck(db as any, NOW + 60000, stakeNam, stakeNam * 1.28, bond, sample);
    await runStmts(db, [ok]);
    const c = db.raw.prepare("SELECT status, detail FROM checks WHERE key='bonded_coverage'").get();
    expect(c.status).toBe('ok');
    const d = JSON.parse(c.detail);
    expect(d).toMatchObject({ coveragePct: '100.3%', stakers: 12, knownAddresses: 15, pendingAddresses: 0, verifiedAddresses: 12, listingTotalNam: bond.totalNam, totalStakeNam: stakeNam, sampledDisagreements: 1, listingHeight: 8343327, listingEpoch: 2690 });
    expect(d.storedSumNam).toBeCloseTo(bond.totalNam, 3);
    expect(d.sampled.examples).toHaveLength(1);
    // 3% apart, or rows still to write, or no listing at all: needs a look, with the reason
    expect((await bondedCoverageCheck(db as any, NOW, stakeNam * 1.03, null, bond, sample)).params[1]).toBe('warn');
    const open = (await bondedCoverageCheck(db as any, NOW, stakeNam, null, { ...bond, remaining: 120 }, sample));
    expect(open.params[1]).toBe('warn');
    expect(JSON.parse(open.params[3] as string)).toMatchObject({ pendingAddresses: 120, note: '120 addresses are still being written.' });
    const none = await bondedCoverageCheck(db as any, NOW, stakeNam, null, null, null);
    expect(none.params[1]).toBe('warn');
    expect(JSON.parse(none.params[3] as string)).toMatchObject({ coveragePct: null, note: 'The bond listing has not been read yet.' });
    const failedFirst = await bondedCoverageCheck(db as any, NOW, stakeNam, null, { ...bond, at: 0, completeAt: null, failedAt: NOW, error: 'Error: timeout' }, null);
    expect(JSON.parse(failedFirst.params[3] as string)).toMatchObject({ coveragePct: null, note: 'The bond listing could not be read: Error: timeout' });
    // stale: older than three intervals
    expect((await bondedCoverageCheck(db as any, NOW + 3 * BOND_LISTING_MS + 1, stakeNam, null, bond, sample)).params[1]).toBe('warn');
  });
});

// ---------------------------------------------------------------- what the API makes of the records

describe('the API and the listings', () => {
  it('a row the listing confirmed is as fresh as the last complete listing; the count and the top 10 carry its time; dust is counted', async () => {
    const db = testD1();
    await runBalanceListing(env(db), [], NOW - 2 * D, {}, balLister());
    await runBondListing(env(db), [], NOW - 2 * D, 2690, {}, bondLister());
    // nothing moved for two days: the listings since found every row unchanged
    await runBalanceListing(env(db), [], NOW - 30 * 60000, {}, balLister(8350000));
    await runBondListing(env(db), [], NOW - 20 * 60000, 2698, {}, bondLister(8350100));
    expect(db.raw.prepare('SELECT MAX(verified_at) m FROM holders').get().m).toBe(NOW - 2 * D);
    expect(await listingTimes(db as any)).toEqual({ balance: NOW - 30 * 60000, bond: NOW - 20 * 60000 });
    expect(confirmedAt(NOW - 2 * D, BALANCE_LISTING_SRC, BALANCE_LISTING_SRC, NOW - 30 * 60000)).toBe(NOW - 30 * 60000);
    expect(confirmedAt(NOW - 2 * D, '5ElementsNodes', BALANCE_LISTING_SRC, NOW - 30 * 60000)).toBe(NOW - 2 * D);
    expect(confirmedAt(NOW - 60000, BALANCE_LISTING_SRC, BALANCE_LISTING_SRC, NOW - 30 * 60000)).toBe(NOW - 60000); // never earlier than the row's own time
    expect(confirmedAt(null, BALANCE_LISTING_SRC, BALANCE_LISTING_SRC, null)).toBeNull();

    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    try {
      const res = await app.request('/api/holders?chain=namada&limit=100', {}, { DB: db } as any);
      const r = (await res.json()) as HoldersResponse;
      expect(r.total).toBeGreaterThan(0);
      let liquid = 0, staked = 0;
      for (const h of r.holders) {
        // every row (both spendable and stake-only) has its spendable reading confirmed by the balance listing half an hour ago
        expect(h.verifiedAt).toBe(NOW - 30 * 60000);
        expect(h.status).toBe('live');
        if (h.balance > 0) liquid++;
        if (h.bonded != null && h.bondedVerifiedAt != null) { staked++; expect(h.bondedVerifiedAt).toBe(NOW - 20 * 60000); }
      }
      expect(liquid).toBe(18);
      expect(staked).toBe(12);
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
      insert(db, 'metrics', [{ ts: NOW - 60000, key: 'supply.total', value: 1147657323 }]);
      const o = (await (await app.request('/api/overview', {}, { DB: db } as any)).json()) as Overview;
      expect(o.concentration.namadaProv).toMatchObject({ at: NOW - 30 * 60000, status: 'live' });
      expect(o.namada.holders).toBe(r.total);
      expect(o.namada.holdersUnder1Nam).toBe(BAL.expected.under1Nam + 1);
      expect(db.raw.prepare(NAMADA_TOP10_SQL).get(NOW - 30 * 60000, NOW - 20 * 60000).at).toBe(NOW - 30 * 60000);
      expect(db.raw.prepare(NAMADA_TOP10_SQL).get(0, 0).at).toBe(NOW - 2 * D);
      expect(db.raw.prepare(HOLDER_DUST_SQL).get().n).toBe(BAL.expected.under1Nam + 1);
    } finally {
      vi.useRealTimers();
    }
  });
  it('the probes the listings replaced are dropped from the stored health', () => {
    expect(RETIRED_HEALTH).toEqual(['Namada RPC (balance refresh)', 'Namada RPC (stake verification)', 'Namada RPC (staker discovery)']);
  });
});
