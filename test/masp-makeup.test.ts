// The shielded pool as a ledger (2026-11-07, C4 and C5): the daily job computes into kv masp.makeup the NAM into the pool
// and out of it since 13 Jun 2025 from the flow index (every NAM leg touching the pool, the pool's fees counted as out),
// how the NAM came in (straight over the bridge against from Namada addresses), the chain's own running total of
// shielded rewards (the pool's max_total_rewards key, a must-exist read stored with its block and time; the last reading
// kept when it could not be read, null while it never was, never 0), and the pool's balance as last read. blindSpot
// serves the row as `makeup`, and the page's sentences take their figures from it. A failed read is asked once an hour.
import { describe, it, expect } from 'vitest';
import { daily, maspMakeupOf, readMaspMakeup, MAKEUP_IN_SQL, MAKEUP_OUT_SQL, MAKEUP_OTHER_FEES_SQL, type MakeupLegRow } from '../worker/src/series';
import { blindSpot, MASP_MAKEUP_KV } from '../worker/src/analytics';
import { INTERNAL_ADDRESSES } from '../shared/alerts';
import { RECORD_SINCE } from '../shared/record-since';
import { SHIELDED_WORDS } from '../shared/copy';
import { fmtDayMonthYear, fmtNamRule, fmtSharePct } from '../shared/format';
import { BANNED } from '../scripts/copy-lint';
import { testD1, insert } from './d1-sqlite';
import type { MaspMakeup, SourceHealth } from '../shared/types';

const MASP = INTERNAL_ADDRESSES.masp;
const ESCROW = INTERNAL_ADDRESSES.ibc;
const A = 'tnam1qr4l8egaskk09460llz0qctac7sgemynpu8c7vvd';
const B = 'tnam1qr8x5rly5mj8wly2ph0zqjkcqkju0g5jkggjn9k3';
const OSMO = 'osmo1nn62s9hm7ns4lwqsl70y49xx5tpe0ft45evpvh';
const GAS = 'tnam1qq3t3lccqk4u69zjyaej63rrfpm4eha2v56llrku';
const D = 86_400_000, H = 3_600_000;
// the third minute of 06:00 UTC: inside the daily job's window, after the flow index's hour
const NOW = Date.UTC(2026, 10, 7, 6, 3);
/** the rewards total as stakeandrelax answered it on 2026-11-07 at the halt's last block: 27,347,610.418808 NAM */
const REWARDS = { total: 27_347_610_418_808n, height: 8_517_986, provider: 'StakeAndRelax' };

let n = 0;
const row = (over: Record<string, unknown>) => ({ id: `namada:M${++n}:1`, chain: 'namada', height: 8_000_000 + n, ts: NOW - (n + 1) * D, tx_hash: `M${n}`, kind: 'shield', from_addr: A, to_addr: MASP, amount_num: 1, meta: null, ...over });
const meta = (m: Record<string, unknown>) => JSON.stringify(m);

/** The flows of every case: in by kind, out with fees of the three kinds, and rows the sums must leave out. */
const FLOWS = [
  row({ kind: 'shield', from_addr: A, amount_num: 1_000 }),
  row({ kind: 'shield', from_addr: B, amount_num: 2_000 }),
  row({ kind: 'ibc_in', from_addr: OSMO, amount_num: 500, meta: meta({ channel: 'channel-1' }) }),
  row({ kind: 'ibc_in', from_addr: ESCROW, amount_num: 250, meta: meta({ shielded: true }) }),
  row({ kind: 'unshield', from_addr: MASP, to_addr: A, amount_num: 300, meta: meta({ innerTxHash: 'U1', maspFeeNam: 0.2 }) }),
  row({ kind: 'ibc_out', from_addr: MASP, to_addr: ESCROW, amount_num: 100, meta: meta({ shielded: true }) }),
  row({ kind: 'masp_fee', from_addr: MASP, to_addr: GAS, amount_num: 0.05, meta: meta({ innerTxHash: 'F1' }) }),
  // the pool's NAM fee on a move of another coin: the row is the other coin's, its fee NAM
  row({ kind: 'unshield', from_addr: MASP, to_addr: OSMO, amount_num: 290, meta: meta({ innerTxHash: 'O1', tokenSymbol: 'OSMO', maspFeeNam: 0.01 }) }),
  // another coin shielded: not NAM
  row({ kind: 'shield', from_addr: A, amount_num: 9_999, meta: meta({ tokenSymbol: 'USDC' }) }),
  // before the record starts
  row({ kind: 'shield', from_addr: A, amount_num: 77_777, ts: RECORD_SINCE.shieldedMoves - H }),
];
/** an older twin of the unshield (the same block and event, filed under the inner hash): left out as everywhere */
const TWIN = { ...FLOWS[4], id: 'namada:U1:1', tx_hash: 'U1', meta: meta({ descriptor: 'transfer-from-wasm' }) };

describe('maspMakeupOf: the ledger from its parts', () => {
  const inRows: MakeupLegRow[] = [{ kind: 'shield', n: 2, nam: 3_000 }, { kind: 'ibc_in', n: 2, nam: 750 }];
  const outRows: MakeupLegRow[] = [{ kind: 'unshield', n: 1, nam: 300, fee_nam: 0.2 }, { kind: 'ibc_out', n: 1, nam: 100, fee_nam: 0 }, { kind: 'masp_fee', n: 1, nam: 0.05, fee_nam: 0 }];
  it('in by kind, out with every fee counted, the rewards as read with their block and time, the balance as read', () => {
    const m = maspMakeupOf(inRows, outRows, 0.01, { ...REWARDS, at: NOW }, { ts: NOW - 60_000, value: 3_377.76 }, NOW);
    expect(m).toEqual({
      at: NOW, since: RECORD_SINCE.shieldedMoves,
      in: { nam: 3_750, n: 4, shield: { nam: 3_000, n: 2 }, bridge: { nam: 750, n: 2 } },
      out: { nam: 400.26, n: 3, feesNam: 0.26 },
      rewards: { nam: 27_347_610.418808, base: '27347610418808', height: 8_517_986, provider: 'StakeAndRelax', at: NOW },
      balance: { nam: 3_377.76, at: NOW - 60_000 },
    } satisfies MaspMakeup);
    expect(m.out.nam).toBeCloseTo(300 + 0.2 + 100 + 0.05 + 0.01, 9);
  });
  it('a rewards total that was not read, or a balance never read, is null, never 0', () => {
    const m = maspMakeupOf(inRows, outRows, 0, null, null, NOW);
    expect(m.rewards).toBeNull();
    expect(m.balance).toBeNull();
    expect(m.in.nam).toBe(3_750);
    expect(maspMakeupOf([], [], 0, null, null, NOW)).toMatchObject({ in: { nam: 0, n: 0, shield: { nam: 0, n: 0 }, bridge: { nam: 0, n: 0 } }, out: { nam: 0, n: 0, feesNam: 0 } });
  });
});

describe('readMaspMakeup over the flow index', () => {
  it('sums every NAM leg touching the pool since the record starts, each once: another coin\'s rows and the older twin left out, the other coin\'s NAM fee counted', async () => {
    const db = testD1();
    // the unique index makes the current row replace its older twin (migration 0004); a twin is possible only without it
    db.exec('DROP INDEX flows_namada_event');
    insert(db, 'flows', [...FLOWS, TWIN]);
    insert(db, 'metrics', [{ ts: NOW - 120_000, key: 'supply.masp_shielded', value: 3_377 }, { ts: NOW + 60_000, key: 'supply.masp_shielded', value: 1 }]);
    const m = await readMaspMakeup(db as any, NOW, undefined, async () => REWARDS);
    expect(m.in).toEqual({ nam: 3_750, n: 4, shield: { nam: 3_000, n: 2 }, bridge: { nam: 750, n: 2 } });
    expect(m.out.n).toBe(3);
    expect(m.out.nam).toBeCloseTo(300 + 0.2 + 100 + 0.05 + 0.01, 9);
    expect(m.out.feesNam).toBeCloseTo(0.26, 9);
    expect(m.rewards).toEqual({ nam: 27_347_610.418808, base: '27347610418808', height: 8_517_986, provider: 'StakeAndRelax', at: NOW });
    expect(m.balance).toEqual({ nam: 3_377, at: NOW - 120_000 });
    expect(m.since).toBe(RECORD_SINCE.shieldedMoves);
    for (const sql of [MAKEUP_IN_SQL, MAKEUP_OUT_SQL, MAKEUP_OTHER_FEES_SQL]) expect(sql).toContain("f.chain = 'namada'");
  });
  it('a chain read that fails leaves the rewards null and the rest as read, when no row carried a reading', async () => {
    const db = testD1();
    insert(db, 'flows', FLOWS);
    const m = await readMaspMakeup(db as any, NOW, undefined, async () => { throw new Error('every node answered without a value'); });
    expect(m.rewards).toBeNull();
    expect(m.in.nam).toBe(3_750);
    expect(m.balance).toBeNull();
    const prev = maspMakeupOf([], [], 0, null, null, NOW - D);
    expect((await readMaspMakeup(db as any, NOW, undefined, async () => { throw new Error('down'); }, prev)).rewards).toBeNull();
  });
  it('a chain read that fails keeps the stored row\'s reading as it was (its own time, block and node); a read that succeeds replaces it', async () => {
    const db = testD1();
    insert(db, 'flows', FLOWS);
    const good = await readMaspMakeup(db as any, NOW - D, undefined, async () => REWARDS);
    expect(good.rewards?.at).toBe(NOW - D);
    const kept = await readMaspMakeup(db as any, NOW, undefined, async () => { throw new Error('down'); }, good);
    expect(kept.rewards).toEqual(good.rewards);
    expect(kept.rewards?.at).toBe(NOW - D);
    expect(kept.at).toBe(NOW);
    expect(kept.in.nam).toBe(3_750);
    const fresh = await readMaspMakeup(db as any, NOW, undefined, async () => ({ ...REWARDS, height: 8_517_990 }), good);
    expect(fresh.rewards).toEqual({ ...good.rewards, height: 8_517_990, at: NOW });
  });
});

describe('the daily job writes kv masp.makeup', () => {
  const env = (db: ReturnType<typeof testD1>) => ({ DB: db } as any);
  const job = (db: ReturnType<typeof testD1>, day = '2026-11-07', over: Record<string, unknown> = {}) => {
    // the other parts done for the day, so only the ledger runs
    db.raw.prepare('INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)').run('jobs.daily', JSON.stringify({ day, snapNamada: true, snapOsmosis: true, flows: true, names: true, ...over }), NOW);
  };
  const stored = (db: ReturnType<typeof testD1>) => JSON.parse(db.raw.prepare('SELECT value FROM kv WHERE key = ?').get(MASP_MAKEUP_KV)?.value ?? 'null') as MaspMakeup | null;
  const jobRow = (db: ReturnType<typeof testD1>) => JSON.parse(db.raw.prepare("SELECT value FROM kv WHERE key = 'jobs.daily'").get().value);
  const never = (calls: { n: number }) => async () => { calls.n++; throw new Error('not asked again'); };
  it('with the rewards total read: the row with the legs, the rewards (block and time) and the balance; the part is done for the day', async () => {
    const db = testD1();
    job(db);
    insert(db, 'flows', FLOWS);
    insert(db, 'metrics', [{ ts: NOW - 120_000, key: 'supply.masp_shielded', value: 3_377 }]);
    const health: SourceHealth[] = [];
    const r = await daily(env(db), NOW, { health, maspRewards: async () => REWARDS });
    expect(r?.ran).toEqual(['shielded makeup']);
    expect(r?.failed).toEqual([]);
    const m = stored(db)!;
    expect(m.rewards).toEqual({ nam: 27_347_610.418808, base: '27347610418808', height: 8_517_986, provider: 'StakeAndRelax', at: NOW });
    expect(m.in.nam).toBe(3_750);
    expect(m.balance).toEqual({ nam: 3_377, at: NOW - 120_000 });
    expect(jobRow(db).makeup).toBe(true);
    // done: a second tick in the window does nothing
    expect(await daily(env(db), NOW + 60_000, { health, maspRewards: async () => { throw new Error('not asked again'); } })).toBeNull();
    // served to the page
    const bs = await blindSpot(db as any, NOW + 60_000, false);
    expect(bs.makeup).toEqual(m);
  });
  it('with the read failing and no reading on record: the row is written without the rewards, the part waits and is asked again in the next hour\'s window', async () => {
    const db = testD1();
    job(db);
    insert(db, 'flows', FLOWS);
    const health: SourceHealth[] = [];
    const r = await daily(env(db), NOW, { health, maspRewards: async () => { throw new Error('down'); } });
    expect(r?.ran).toEqual([]);
    expect(r?.waiting.join(' ')).toContain('shielded makeup: the chain’s total of shielded rewards could not be read, so the ledger was written without it; asked again next hour');
    expect(stored(db)?.rewards).toBeNull();
    expect(stored(db)?.in.nam).toBe(3_750);
    expect(jobRow(db).makeup).toBeUndefined();
    expect(jobRow(db).makeupTried).toBe(Date.UTC(2026, 10, 7, 6));
    // a second tick in the same hour does not ask the chain again, and leaves the part undone
    const calls = { n: 0 };
    const same = await daily(env(db), NOW + 60_000, { health, maspRewards: never(calls) });
    expect(calls.n).toBe(0);
    expect(same?.ran).toEqual([]);
    expect(same?.waiting).toEqual(['shielded makeup: the chain’s total of shielded rewards was not read this hour; asked again next hour']);
    expect(jobRow(db).makeup).toBeUndefined();
    expect(stored(db)?.at).toBe(NOW);
    // the next hour's window: asked again, and done for the day
    const again = await daily(env(db), NOW + H, { health, maspRewards: async () => REWARDS });
    expect(again?.ran).toEqual(['shielded makeup']);
    expect(stored(db)?.rewards?.height).toBe(8_517_986);
    expect(stored(db)?.rewards?.at).toBe(NOW + H);
    expect(jobRow(db).makeup).toBe(true);
  });
  it('with the read failing after a good one: the stored reading stays as it was (its time unchanged), the legs are re-read, the part waits', async () => {
    const db = testD1();
    insert(db, 'flows', FLOWS);
    insert(db, 'metrics', [{ ts: NOW - D - 120_000, key: 'supply.masp_shielded', value: 3_300 }]);
    const health: SourceHealth[] = [];
    // yesterday's job read the total
    job(db, '2026-11-06');
    expect((await daily(env(db), NOW - D, { health, maspRewards: async () => REWARDS }))?.ran).toEqual(['shielded makeup']);
    const before = stored(db)!;
    expect(before.rewards?.at).toBe(NOW - D);
    // today's read fails: the row is rewritten with the legs and balance of today and yesterday's reading
    job(db, '2026-11-07');
    insert(db, 'metrics', [{ ts: NOW - 120_000, key: 'supply.masp_shielded', value: 3_377 }]);
    const r = await daily(env(db), NOW, { health, maspRewards: async () => { throw new Error('down'); } });
    expect(r?.ran).toEqual([]);
    expect(r?.waiting.join(' ')).toContain('written with the last reading; asked again next hour');
    const after = stored(db)!;
    expect(after.rewards).toEqual(before.rewards);
    expect(after.rewards?.at).toBe(NOW - D);
    expect(after.at).toBe(NOW);
    expect(after.balance).toEqual({ nam: 3_377, at: NOW - 120_000 });
    expect(jobRow(db).makeup).toBeUndefined();
    // served to the page as stored
    expect((await blindSpot(db as any, NOW + 60_000, false)).makeup).toEqual(after);
    // a good read in a later hour replaces it
    const again = await daily(env(db), NOW + 2 * H, { health, maspRewards: async () => ({ ...REWARDS, height: 8_517_990 }) });
    expect(again?.ran).toEqual(['shielded makeup']);
    expect(stored(db)?.rewards).toEqual({ ...before.rewards, height: 8_517_990, at: NOW + 2 * H });
  });
  it('the hour tried is kept when the validator list fails in the same tick, and neither is asked again that hour', async () => {
    const db = testD1();
    job(db, '2026-11-07', { names: false });
    insert(db, 'flows', FLOWS);
    const health: SourceHealth[] = [];
    const r = await daily(env(db), NOW, { health, maspRewards: async () => { throw new Error('down'); }, validators: async () => { throw new Error('down'); } });
    expect(r?.ran).toEqual([]);
    const hour = Date.UTC(2026, 10, 7, 6);
    expect(jobRow(db)).toMatchObject({ day: '2026-11-07', makeupTried: hour, namesTried: hour });
    expect(jobRow(db).makeup).toBeUndefined();
    expect(jobRow(db).names).toBe(false);
    const rewards = { n: 0 }, names = { n: 0 };
    const same = await daily(env(db), NOW + 60_000, { health, maspRewards: never(rewards), validators: never(names) });
    expect(rewards.n).toBe(0);
    expect(names.n).toBe(0);
    expect(same?.ran).toEqual([]);
  });
  it('blindSpot serves null while the row was never written', async () => {
    const db = testD1();
    expect((await blindSpot(db as any, NOW, false)).makeup).toBeNull();
  });
});

describe('the page\'s sentences', () => {
  const m: MaspMakeup = {
    at: NOW, since: RECORD_SINCE.shieldedMoves,
    in: { nam: 269_121_616.226, n: 4_572, shield: { nam: 232_583_488.675, n: 2_917 }, bridge: { nam: 36_538_127.551, n: 1_655 } },
    out: { nam: 264_876_452.4, n: 15_604, feesNam: 25_673.18 },
    rewards: { nam: 27_347_610.418808, base: '27347610418808', height: 8_517_986, provider: 'StakeAndRelax', at: NOW },
    balance: { nam: 31_618_418.748038, at: NOW - 60_000 },
  };
  it('the ledger and how NAM entered the pool, each figure formatted by the site\'s rules, the gap as a size', () => {
    const gap = Math.abs(m.in.nam - m.out.nam + m.rewards!.nam - m.balance!.nam);
    const s = SHIELDED_WORDS.makeup(fmtDayMonthYear(m.since), fmtNamRule(m.in.nam), fmtNamRule(m.out.nam), fmtNamRule(m.rewards!.nam), fmtNamRule(m.balance!.nam), fmtNamRule(gap));
    expect(s).toBe('Since 13 Jun 2025, 269,121,616 NAM was shielded and 264,876,452 NAM unshielded. Another 27,347,610 NAM was minted into the pool as shielded rewards, which no transaction shows. In − out + rewards = today’s 31,618,419 NAM, within 25,645 NAM.');
    const b = SHIELDED_WORDS.bridgeShare(fmtSharePct((m.in.bridge.nam / m.in.nam) * 100), `${m.in.bridge.n.toLocaleString('en-US')} crossings`);
    expect(b).toBe('Of all NAM ever shielded, 14% arrived straight over the bridge in 1,655 crossings; the rest came from Namada addresses.');
    for (const w of [s, b, ...Object.values(SHIELDED_WORDS.makeupRows), SHIELDED_WORDS.makeupScope, SHIELDED_WORDS.bridgeScope]) {
      for (const x of BANNED) expect(w, `${x.word} in "${w}"`).not.toMatch(x.re);
      expect(w).not.toMatch(/tnam1|osmo1/);
    }
  });
});
