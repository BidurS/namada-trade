// The trust checks of 2026-11-07 (worker/src/cron.ts, from maspLedgerCheck), on the D1 stand-in and in words:
// - masp_ledger: the shielded pool's day ledger, the daily digest's comparison as a row written once a day;
// - pos_remainder: the staking account's NAM outside bonds and unstaking between two complete bond listings;
// - bond_sources: no protocol account as a source in the chain's bond listing (the parser keeps such a source apart
//   instead of refusing the listing whole);
// and one real tick (runCron) that wires the three and masp_tx_coverage, with their states in kv.
// Each row is 'warn' at most, carries its cadence (everyMs), and says 'idle' with a plain reason while the chain gives
// it nothing new to judge (the halt).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  maspLedgerCheck, maspLedgerDue, readMaspDay, maspRewardRise, rewardEpochBetween, scanPosition, dayStartOf, keepReadings,
  MASP_LEDGER_EVERY_MS, MASP_LEDGER_RETRY_MS, MASP_LEDGER_KV, MASP_LEDGER_READINGS_KEPT,
  posRemainderNext, posRemainderDue, posRemainderReads, POS_REMAINDER_EVERY_MS, POS_REMAINDER_RETRY_MS, POS_REMAINDER_KV,
  bondSourcesCheck, BOND_SOURCES_EVERY_MS, runBondListing, runCron, BOND_LISTING_MS, MASP_COVERAGE_KV, MASP_COVERAGE_EVERY_MS,
  type BondListingRecord, type MaspRewardReading, type PosRemainderState, type MaspDay,
} from '../worker/src/cron';
import { parseBondListing } from '../worker/src/sources/namada';
import { MASP_INDEXER_HEALTH } from '../worker/src/sources/masp-indexer';
import { checkOf } from '../worker/src/api';
import { checkDetail, CHECK_TITLES } from '../web/src/lib/prov';
import { NAMADA } from '../worker/src/config';
import { BANNED } from './banned-words';
import { testD1, insert, type TestD1 } from './d1-sqlite';
import type { Check } from '../shared/types';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const H = 3600_000, MIN = 60_000, D = 24 * H;
const MASP = NAMADA.internal.masp;
const row = (db: TestD1, key: string) => {
  const r = db.raw.prepare('SELECT key, status, title, detail, checked_at FROM checks WHERE key = ?').get(key);
  return r ? { ...r, detail: JSON.parse(r.detail) } : null;
};
const kvJson = (db: TestD1, key: string) => { const r = db.raw.prepare('SELECT value FROM kv WHERE key = ?').get(key); return r ? JSON.parse(r.value) : null; };
/** A check's plain line from a statement the worker would write. */
const lineOf = (s: { params: unknown[] }) => checkDetail({ key: String(s.params[0]), status: s.params[1] as Check['status'], title: '', detail: JSON.parse(String(s.params[3])), checkedAt: Number(s.params[4]) });
const statusOf = (s: { params: unknown[] }) => s.params[1] as string;
const detailOf = (s: { params: unknown[] }) => JSON.parse(String(s.params[3])) as Record<string, unknown>;
/** The stale rule on a statement: checkOf over the row as stored. */
const servedAt = (s: { params: unknown[] }, at: number) => checkOf({ key: s.params[0], status: s.params[1], title: s.params[2], detail: s.params[3], checked_at: s.params[4] }, at).status;

// ---------------------------------------------------------------- masp_ledger

describe('masp_ledger: the shielded pool\'s day ledger', () => {
  const DAY = Date.UTC(2026, 10, 5); // 2026-11-05
  const NOW = DAY + D + 30_000; // 00:00:30 the day after
  const scanOk = { behind: false, lagBlocks: 0, note: '' };
  const metric = (ts: number, key: string, value: number) => ({ ts, key, value });
  const flow = (id: string, kind: string, ts: number, amount: number, dir: 'in' | 'out', meta: Record<string, unknown> | null = null) => ({
    id: `namada:${id}:0`, chain: 'namada', height: 8_500_000, ts, tx_hash: id, kind, amount_num: amount,
    from_addr: dir === 'out' ? MASP : 'tnam1qq6wus66shjjwhe48c3udfyrh05vq62s0ysy3flp', to_addr: dir === 'in' ? MASP : 'tnam1qq6wus66shjjwhe48c3udfyrh05vq62s0ysy3flp',
    meta: meta ? JSON.stringify(meta) : null,
  });
  /** A day with 500 NAM in, 300 NAM out and 0.85 NAM of fees (0.1 of it on a move of another coin): net +199.15. */
  function seedDay(db: TestD1, startNam: number, endNam: number, epochs: [number, number] | [null, null] = [2737, 2738]) {
    const rows = [metric(DAY - MIN, 'supply.masp_shielded', startNam), metric(DAY + D - MIN, 'supply.masp_shielded', endNam)];
    if (epochs[0] != null) rows.push(metric(DAY - MIN, 'epoch', epochs[0]), metric(DAY + D - MIN, 'epoch', epochs[1]!));
    insert(db, 'metrics', rows);
    insert(db, 'flows', [
      flow('A1', 'shield', DAY + 2 * H, 500, 'in', { innerTxHash: 'a1' }),
      flow('B1', 'unshield', DAY + 5 * H, 200, 'out', { innerTxHash: 'b1', maspFeeNam: 0.5 }),
      flow('C1', 'ibc_out', DAY + 9 * H, 100, 'out', { innerTxHash: 'c1', maspFeeNam: 0.25 }),
      flow('D1', 'unshield', DAY + 12 * H, 42, 'out', { innerTxHash: 'd1', tokenSymbol: 'USDC', maspFeeNam: 0.1 }),
    ]);
  }
  const judge = (day: MaspDay, over: Partial<Parameters<typeof maspLedgerCheck>[0]> = {}) => maspLedgerCheck({ day, scan: scanOk, multiplier: 4, rewards: [], ...over }, NOW);

  it('a day whose moves add up to its balance change passes, within 1 NAM, and the row says its day and cadence', async () => {
    const db = testD1();
    seedDay(db, 1_000_000, 1_000_000 + 199.15);
    const day = await readMaspDay(db, DAY);
    expect(day).toMatchObject({ day: '2026-11-05', start: { ts: DAY - MIN, nam: 1_000_000, epoch: 2737 }, end: { ts: DAY + D - MIN, epoch: 2738 } });
    expect(day.legs).toMatchObject({ shieldNam: 500, unshieldNam: 200, ibcOutNam: 100, ibcInNam: 0, moves: 4, otherKinds: [] });
    expect(day.legs!.feesNam).toBeCloseTo(0.85, 9);
    const s = judge(day);
    expect(statusOf(s)).toBe('ok');
    expect(detailOf(s)).toMatchObject({ everyMs: MASP_LEDGER_EVERY_MS, day: '2026-11-05', judged: true, rewardDay: false, inNam: 500, moves: 4, startEpoch: 2737, endEpoch: 2738 });
    expect(Math.abs(Number(detailOf(s).residualNam))).toBeLessThan(1e-6);
    expect(lineOf(s)).toBe("5 Nov 2026: 500.000000 NAM in and 300.850000 NAM out (0.850000 NAM of it the pool's fees); the pool's balance changed by 199.150000 NAM, exactly the net of its moves");
    // daily: current the next day, "no recent result" once a day is missed
    expect(servedAt(s, NOW + 25 * H)).toBe('ok');
    expect(servedAt(s, NOW + 2 * D + MIN)).toBe('stale');
    // within the tolerance: 0.4 NAM off is still a pass, said as the difference
    const near = judge(await readMaspDay((() => { const d2 = testD1(); seedDay(d2, 1_000_000, 1_000_000 + 199.15 + 0.4); return d2; })(), DAY));
    expect(statusOf(near)).toBe('ok');
    expect(lineOf(near)).toBe("5 Nov 2026: 500.000000 NAM in and 300.850000 NAM out (0.850000 NAM of it the pool's fees); the pool's balance changed by 199.550000 NAM, 0.400000 NAM more than the net of its moves");
  });

  it('a balance change the moves do not account for, on a day no shielded-reward epoch started, needs a look and names the residual', async () => {
    const db = testD1();
    seedDay(db, 1_000_000, 1_000_000 + 199.15 - 12.5);
    const s = judge(await readMaspDay(db, DAY));
    expect(statusOf(s)).toBe('warn');
    expect(detailOf(s)).toMatchObject({ judged: true, rewardDay: false });
    expect(Number(detailOf(s).residualNam)).toBeCloseTo(-12.5, 6);
    expect(lineOf(s)).toBe("5 Nov 2026: 500.000000 NAM in and 300.850000 NAM out (0.850000 NAM of it the pool's fees); the pool's balance changed by 186.650000 NAM, 12.500000 NAM less than the net of its moves; judged again tomorrow");
    // more than the moves, no reward epoch in (2737, 2738] with a multiplier of 4: a warn too
    const db2 = testD1();
    seedDay(db2, 1_000_000, 1_000_000 + 199.15 + 40_000);
    const s2 = judge(await readMaspDay(db2, DAY));
    expect(statusOf(s2)).toBe('warn');
    expect(lineOf(s2)).toMatch(/^5 Nov 2026: .*40,000\.000000 NAM more than the net of its moves; judged again tomorrow$/);
  });

  it('on a day a shielded-reward epoch started, a rise equal to the rise of the chain\'s total of shielded rewards is the reward credit: a pass that says so', async () => {
    const db = testD1();
    seedDay(db, 1_000_000, 1_000_000 + 199.15 + 40_000, [2739, 2740]);
    const day = await readMaspDay(db, DAY);
    const reading = (at: number, epoch: number, total: bigint): MaspRewardReading => ({ at, height: 8_500_000 + epoch, provider: 'A', epoch, totalBase: total.toString() });
    const T0 = 27_347_610_418_808n;
    const rewards = [reading(DAY + 20_000, 2739, T0), reading(NOW, 2740, T0 + 40_000_000_000n)];
    const s = judge(day, { rewards });
    expect(statusOf(s)).toBe('ok');
    expect(detailOf(s)).toMatchObject({ judged: true, rewardDay: true, rewardEpoch: 2740, rewardNam: 40_000, rewardBase: '40000000000', rewardReadings: { from: { epoch: 2739 }, to: { epoch: 2740 } } });
    expect(lineOf(s)).toBe("5 Nov 2026: 500.000000 NAM in and 300.850000 NAM out (0.850000 NAM of it the pool's fees); the pool's balance changed by 40,199.150000 NAM, 40,000.000000 NAM more than the net of its moves: the shielded rewards credited as epoch 2740 started, which the chain's total of shielded rewards puts at 40,000.000000 NAM");
    // the rewards total rose by less than the residual: not the credit alone
    const off = judge(day, { rewards: [reading(DAY + 20_000, 2739, T0), reading(NOW, 2740, T0 + 39_000_000_000n)] });
    expect(statusOf(off)).toBe('warn');
    expect(lineOf(off)).toBe("5 Nov 2026: 500.000000 NAM in and 300.850000 NAM out (0.850000 NAM of it the pool's fees); the pool's balance changed by 40,199.150000 NAM, 40,000.000000 NAM more than the net of its moves, on a day a shielded-reward epoch (2740) started whose rewards the chain's total of shielded rewards puts at 39,000.000000 NAM; judged again tomorrow");
    // no reading at both ends: a shielded-reward day, not judged
    const none = judge(day, { rewards: [reading(NOW, 2740, T0 + 40_000_000_000n)] });
    expect(statusOf(none)).toBe('idle');
    expect(detailOf(none)).toMatchObject({ judged: false, notJudged: 'reward-not-read', rewardDay: true, note: 'a shielded-reward day: not judged' });
    expect(lineOf(none)).toBe("5 Nov 2026: a shielded-reward day: not judged, the chain's total of shielded rewards was not read at both ends of the day");
    // whether a reward epoch started cannot be told without the multiplier: not judged either
    const unknown = judge(day, { multiplier: null, rewards });
    expect(statusOf(unknown)).toBe('idle');
    expect(lineOf(unknown)).toBe('5 Nov 2026: not judged, whether a shielded-reward epoch started in the day could not be told (the shielded-reward epoch length was not read)');
    // a shortfall is never rewards: a warn even on a reward day
    const db2 = testD1();
    seedDay(db2, 1_000_000, 1_000_000 + 199.15 - 3, [2739, 2740]);
    expect(statusOf(judge(await readMaspDay(db2, DAY), { rewards }))).toBe('warn');
  });

  it('the readings are placed by epoch: the rise is between the newest reading no reward epoch separates from each end of the day', () => {
    const r = (at: number, epoch: number | null, total: bigint): MaspRewardReading => ({ at, height: 1, provider: 'A', epoch, totalBase: total.toString() });
    // readings over four days; the day's epochs run 2739 to 2741 (2740 a reward epoch, 2744 the next)
    const rewards = [r(1, 2733, 100n), r(2, 2736, 200n), r(3, 2739, 300n), r(4, 2741, 350n), r(5, 2743, 350n), r(6, 2745, 400n)];
    const rise = maspRewardRise(rewards, 2739, 2741, 4)!;
    expect([rise.from.at, rise.to.at, rise.base]).toEqual([3, 5, 50n]);
    // a day from 2737: the reading at 2739 fits its start too (2740 is the first reward epoch after 2737)
    expect(maspRewardRise(rewards, 2737, 2741, 4)!.from.at).toBe(3);
    // a day from 2735: the readings at 2739 and 2736 are separated from its start by the reward epoch 2736, so the one at 2733 is taken
    const wide = maspRewardRise(rewards, 2735, 2741, 4)!;
    expect([wide.from.at, wide.to.at, wide.base]).toEqual([1, 5, 250n]);
    expect(maspRewardRise([r(5, 2743, 350n)], 2739, 2741, 4)).toBeNull();
    expect(maspRewardRise([r(3, null, 300n), r(5, 2743, 350n)], 2739, 2741, 4)).toBeNull();
    expect(rewardEpochBetween(2735, 2736, 4)).toBe(2736);
    expect(rewardEpochBetween(2736, 2739, 4)).toBeNull();
    expect(rewardEpochBetween(2731, 2740, 4)).toBe(2732);
    expect(rewardEpochBetween(2736, 2736, 4)).toBeNull();
    // the readings kept: the newest of each epoch, so a day tried again for hours keeps the day before's reading
    const kept = keepReadings([r(1, 2733, 100n), r(2, 2736, 200n)], r(3, 2736, 200n));
    expect(kept.map((x) => x.at)).toEqual([1, 3]);
    expect(keepReadings(Array.from({ length: 12 }, (_, i) => r(i, 2700 + i, 1n)), r(20, 2720, 1n)).map((x) => x.at)).toEqual([5, 6, 7, 8, 9, 10, 11, 20]);
    expect(keepReadings([r(1, 2733, 100n)], null)).toHaveLength(1);
    expect(MASP_LEDGER_READINGS_KEPT).toBe(8);
  });

  it('a day with no move and no change (the halt) is idle, and so is a day whose balance was not read at an end', async () => {
    const db = testD1();
    insert(db, 'metrics', [metric(DAY - MIN, 'supply.masp_shielded', 51_095_069.207009), metric(DAY + D - MIN, 'supply.masp_shielded', 51_095_069.207009), metric(DAY - MIN, 'epoch', 2738), metric(DAY + D - MIN, 'epoch', 2738)]);
    const s = judge(await readMaspDay(db, DAY));
    expect(statusOf(s)).toBe('idle');
    expect(detailOf(s)).toMatchObject({ judged: false, notJudged: 'nothing-happened', moves: 0, deltaNam: 0 });
    expect(lineOf(s)).toBe('5 Nov 2026: no move into or out of the shielded pool, and its balance did not change');
    const db2 = testD1();
    insert(db2, 'metrics', [metric(DAY + D - MIN, 'supply.masp_shielded', 1)]);
    const s2 = judge(await readMaspDay(db2, DAY));
    expect(statusOf(s2)).toBe('idle');
    expect(detailOf(s2)).toMatchObject({ notJudged: 'balance-not-read', startRead: false, endRead: true });
    expect(lineOf(s2)).toBe("5 Nov 2026: not judged, the pool's balance was not read at the start of the day");
    // a start row older than the base window is not a start
    const db3 = testD1();
    insert(db3, 'metrics', [metric(DAY - 3 * H, 'supply.masp_shielded', 1), metric(DAY + D - MIN, 'supply.masp_shielded', 1)]);
    expect((await readMaspDay(db3, DAY)).start).toBeNull();
  });

  it('with the block scan behind the day is not judged yet, and is tried again after 15 minutes; a day judged is not run again', async () => {
    const db = testD1();
    seedDay(db, 1_000_000, 1_000_000 + 199.15);
    const scan = scanPosition({ height: 8_500_000 }, 8_500_200);
    expect(scan).toMatchObject({ behind: true, lagBlocks: 200 });
    const s = judge(await readMaspDay(db, DAY), { scan });
    expect(statusOf(s)).toBe('idle');
    expect(detailOf(s)).toMatchObject({ notJudged: 'scan-behind', retry: true, scanLagBlocks: 200 });
    expect(lineOf(s)).toBe("5 Nov 2026: not judged yet, this site's block scan is 200 blocks behind the chain, so the day's moves are not all on record; tried again in 15 minutes");
    const stored = { checked_at: NOW, detail: detailOf(s) };
    expect(maspLedgerDue(stored, NOW + MIN)).toBe(false);
    expect(maspLedgerDue(stored, NOW + MASP_LEDGER_RETRY_MS)).toBe(true);
    const judged = { checked_at: NOW, detail: detailOf(judge(await readMaspDay(db, DAY))) };
    expect(maspLedgerDue(judged, NOW + 6 * H)).toBe(false);
    expect(maspLedgerDue(judged, NOW + D)).toBe(true); // the next day
    expect(maspLedgerDue(null, NOW)).toBe(true);
    // at the head (the halt: the cursor's time does not move, so only the lag counts) and without a head
    expect(scanPosition({ height: 8_517_986 }, 8_517_986).behind).toBe(false);
    expect(scanPosition({ height: 8_517_986 }, null).behind).toBe(true);
    expect(scanPosition(null, 8_517_986).behind).toBe(true);
    expect(dayStartOf(NOW)).toBe(DAY + D);
  });
});

// ---------------------------------------------------------------- pos_remainder

describe('pos_remainder: the staking account\'s NAM outside bonds and unstaking between two complete bond listings', () => {
  const T = Date.UTC(2026, 10, 2, 14, 0);
  const A_POS = 343_820_912_480_000n;
  const INFLATION = 19_961_144_868n;
  const rec = (over: Partial<BondListingRecord> = {}): BondListingRecord => ({
    at: T, completeAt: T, height: 8_516_000, epoch: 2738, provider: 'A', sources: 10, stakers: 10, totalNam: 269_402_168.82, bytes: 0, written: 0, zeroed: 0, remaining: 0, ticks: 1, durationMs: 0,
    bondedBase: '269402168820000', unbondingBase: '36653965820000', slashedBase: '860517000000', unbondSlashedBase: '0', ...over,
  });
  const reads = (posBase: bigint, inflationBase: bigint | null = null) => ({ posBase, inflationBase, provider: 'A' });
  const first = posRemainderNext(null, rec(), reads(A_POS), T);
  const next = (over: Partial<BondListingRecord>, r: Parameters<typeof posRemainderNext>[2], state: PosRemainderState = first.state) => posRemainderNext(state, rec({ at: T + BOND_LISTING_MS, completeAt: T + BOND_LISTING_MS, ...over }), r, T + BOND_LISTING_MS);

  it('the first complete listing is kept, not judged, with the account\'s NAM at its block', () => {
    expect(statusOf(first.row!)).toBe('idle');
    expect(detailOf(first.row!)).toMatchObject({ everyMs: POS_REMAINDER_EVERY_MS, judged: false, notJudged: 'first', height: 8_516_000 });
    expect(first.state).toMatchObject({ rowFor: T, failedAt: null, last: { height: 8_516_000, epoch: 2738, posBase: A_POS.toString(), bondedBase: '269402168820000' } });
    expect(lineOf(first.row!)).toBe('No earlier complete bond listing to compare with; the listing at block 8,516,000 is kept for the next');
    expect(posRemainderReads(null, rec())).toEqual({ inflation: false });
    expect(posRemainderReads(first.state, rec({ height: 8_516_500, epoch: 2739 }))).toEqual({ inflation: true });
    expect(posRemainderReads(first.state, rec({ height: 8_516_500, epoch: 2738 }))).toEqual({ inflation: false });
    expect(posRemainderReads(first.state, rec({ height: 8_516_500, epoch: 2740 }))).toBeNull();
    expect(posRemainderReads(first.state, rec())).toBeNull();
  });

  it('one epoch on, a rise within the staking inflation the chain recorded passes; five NAM over it needs a look, in the row\'s own words', () => {
    const ok = next({ height: 8_516_500, epoch: 2739 }, reads(A_POS + INFLATION, INFLATION));
    expect(statusOf(ok.row!)).toBe('ok');
    expect(detailOf(ok.row!)).toMatchObject({ judged: true, fromHeight: 8_516_000, toHeight: 8_516_500, epochStarted: true, riseBase: INFLATION.toString(), inflationBase: INFLATION.toString(), slashedRiseBase: '0', overBase: '0', remainderFromBase: '37764777840000' });
    expect(ok.state.last).toMatchObject({ height: 8_516_500, epoch: 2739, posBase: (A_POS + INFLATION).toString() });
    expect(lineOf(ok.row!)).toBe("Between the bond listings at blocks 8,516,000 and 8,516,500 the staking account's NAM outside bonds and unstaking rose by 19,961.144868 NAM, within the 19,961.144868 NAM of staking inflation the chain recorded as epoch 2739 started");
    // a rise of 1 NAM more is within the tolerance
    expect(statusOf(next({ height: 8_516_500, epoch: 2739 }, reads(A_POS + INFLATION + 1_000_000n, INFLATION)).row!)).toBe('ok');
    const over = next({ height: 8_516_500, epoch: 2739 }, reads(A_POS + INFLATION + 5_000_000n, INFLATION));
    expect(statusOf(over.row!)).toBe('warn');
    expect(detailOf(over.row!)).toMatchObject({ overBase: '5000000', riseBase: (INFLATION + 5_000_000n).toString(), allowedBase: INFLATION.toString() });
    expect(lineOf(over.row!)).toBe("NAM entered the staking account outside bonds and rewards: 5.000000 NAM between listings at blocks 8,516,000 and 8,516,500 (its NAM outside bonds and unstaking rose by 19,966.144868 NAM, 19,961.144868 NAM of it what staking inflation and slashing account for); read again at the next listing");
    // 40 minutes: current at 41 minutes, "no recent result" past 80
    expect(servedAt(ok.row!, T + BOND_LISTING_MS + 41 * MIN)).toBe('ok');
    expect(servedAt(ok.row!, T + BOND_LISTING_MS + 2 * BOND_LISTING_MS + MIN)).toBe('stale');
  });

  it('within an epoch the remainder may rise only by the NAM newly slashed; a fall is not judged; a bond or a withdrawal moves nothing', () => {
    // 2,000 NAM slashed off bonds: the bonds net fall, the slashed sum rises, the account's NAM stays
    const slashed = next({ height: 8_516_300, epoch: 2738, bondedBase: '269400168820000', slashedBase: '862517000000' }, reads(A_POS));
    expect(statusOf(slashed.row!)).toBe('ok');
    expect(lineOf(slashed.row!)).toBe("Between the bond listings at blocks 8,516,000 and 8,516,300 the staking account's NAM outside bonds and unstaking rose by 2,000.000000 NAM, within the 2,000.000000 NAM newly slashed");
    // the same rise with nothing slashed: NAM came from outside
    expect(statusOf(next({ height: 8_516_300, epoch: 2738 }, reads(A_POS + 2_000_000_000n)).row!)).toBe('warn');
    // a withdrawal: the unbonds and the account fall together
    const withdrawn = next({ height: 8_516_300, epoch: 2738, unbondingBase: '36643965820000' }, reads(A_POS - 10_000_000_000n));
    expect(statusOf(withdrawn.row!)).toBe('ok');
    expect(lineOf(withdrawn.row!)).toBe("Between the bond listings at blocks 8,516,000 and 8,516,300 the staking account's NAM outside bonds and unstaking rose by 0.000000 NAM, within the 1 NAM allowed: no epoch started between them and nothing was newly slashed");
    // rewards claimed: a fall, said as one
    const fell = next({ height: 8_516_300, epoch: 2738 }, reads(A_POS - 1_000_000_000n));
    expect(statusOf(fell.row!)).toBe('ok');
    expect(detailOf(fell.row!).riseBase).toBe('-1000000000');
    expect(lineOf(fell.row!)).toBe("Between the bond listings at blocks 8,516,000 and 8,516,300 the staking account's NAM outside bonds and unstaking fell by 1,000.000000 NAM (rewards claimed and withdrawals are not judged)");
  });

  it('nothing new (the halt), an older block, several epochs apart and a record without figures are idle with their reasons', () => {
    const same = next({ height: 8_516_000, epoch: 2738 }, null);
    expect(statusOf(same.row!)).toBe('idle');
    expect(detailOf(same.row!)).toMatchObject({ notJudged: 'same-block', fromHeight: 8_516_000 });
    expect(lineOf(same.row!)).toBe('The chain has not moved since the bond listing at block 8,516,000: nothing new to judge');
    expect(same.state.last).toEqual(first.state.last);
    expect(same.state.rowFor).toBe(T + BOND_LISTING_MS);
    const older = next({ height: 8_515_000, epoch: 2738 }, null);
    expect(lineOf(older.row!)).toBe('The listing at block 8,515,000 is older than the one compared last (block 8,516,000): not judged');
    const apart = next({ height: 8_517_000, epoch: 2740 }, reads(A_POS + 2n * INFLATION));
    expect(statusOf(apart.row!)).toBe('idle');
    expect(lineOf(apart.row!)).toBe("2 epochs started between the listings at blocks 8,516,000 and 8,517,000: not judged, the chain keeps only the last epoch's staking inflation");
    expect(apart.state.last).toMatchObject({ height: 8_517_000, epoch: 2740 }); // the second becomes the one compared next
    const bare = next({ height: 8_516_500, epoch: 2739, bondedBase: undefined }, null);
    expect(detailOf(bare.row!)).toMatchObject({ notJudged: 'no-figures' });
    expect(lineOf(bare.row!)).toBe('The last bond listing carries no figures for this check yet; the next listing does');
    for (const l of [lineOf(same.row!), lineOf(older.row!), lineOf(apart.row!), lineOf(bare.row!)]) expect(l, l ?? '').not.toMatch(BANNED);
  });

  it('a read that fails writes nothing, and the next try waits five minutes; a listing already written for is not due', () => {
    const failed = next({ height: 8_516_500, epoch: 2739 }, { error: 'timeout' });
    expect(failed.row).toBeNull();
    expect(failed.state).toMatchObject({ failedAt: T + BOND_LISTING_MS, rowFor: T, last: { height: 8_516_000 } });
    const r = rec({ at: T + BOND_LISTING_MS, completeAt: T + BOND_LISTING_MS, height: 8_516_500, epoch: 2739 });
    expect(posRemainderDue(failed.state, r, T + BOND_LISTING_MS + MIN)).toBe(false);
    expect(posRemainderDue(failed.state, r, T + BOND_LISTING_MS + POS_REMAINDER_RETRY_MS)).toBe(true);
    // the inflation not read when one epoch started: not judged this tick either
    expect(next({ height: 8_516_500, epoch: 2739 }, reads(A_POS + INFLATION, null)).row).toBeNull();
    expect(posRemainderDue(first.state, rec(), T + MIN)).toBe(false); // written for this listing already
    expect(posRemainderDue(first.state, rec({ remaining: 12, completeAt: T + BOND_LISTING_MS }), T + BOND_LISTING_MS)).toBe(false); // not complete
    expect(posRemainderDue(undefined, rec(), T)).toBe(true);
    expect(posRemainderDue(null, null, T)).toBe(false);
  });
});

// ---------------------------------------------------------------- bond_sources

const u32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const u64 = (n: number) => [...u32(n), 0, 0, 0, 0];
const amount = (v: bigint) => { const b: number[] = []; for (let i = 0; i < 32; i++) { b.push(Number(v & 255n)); v >>= 8n; } return b; };
/** A borsh Established address (tag 0 + 20 bytes). */
const established = (seed: number) => [0, ...Array.from({ length: 20 }, (_, i) => (seed * 7 + i * 13) & 255)];
/** A borsh Internal address: tag 2, then the enum variant (0 PoS, 12 Masp in parse/namada-tx.ts INTERNAL_ADDRESSES' order). */
const internal = (variant: number) => [2, variant];
type Entry = { source: number[]; validator: number[]; bonds: { start: number; amount: bigint; slashed?: bigint }[] };
const listingB64 = (entries: Entry[]) => {
  const bytes = [...u32(entries.length), ...entries.flatMap((e) => [
    ...e.source, ...e.validator,
    ...u32(e.bonds.length), ...e.bonds.flatMap((b) => [...u64(b.start), ...amount(b.amount), ...(b.slashed != null ? [1, ...amount(b.slashed)] : [0])]),
    ...u32(0), ...u32(0),
  ])];
  return btoa(String.fromCharCode(...bytes));
};

describe('bond_sources: no protocol account as a source in the bond listing', () => {
  const BONDS = JSON.parse(readFileSync(new URL('./fixtures/bonds_listing.json', import.meta.url), 'utf8'));
  const NOW = Date.UTC(2026, 9, 20, 12, 0);
  const env = (db: TestD1) => ({ DB: db } as any);
  const lister = (value: string = BONDS.value, height = 8343327) => async () => ({ ...parseBondListing(value), height, provider: 'TestNode' });

  it('the chain\'s own listing (15 sources, none internal) passes, with its block and cadence; the row is current at 41 minutes and stale past 80', async () => {
    const db = testD1();
    await runBondListing(env(db), [], NOW, 2690, {}, lister());
    const r = row(db, 'bond_sources')!;
    expect(r.status).toBe('ok');
    expect(r.checked_at).toBe(NOW);
    expect(r.detail).toEqual({ everyMs: BOND_SOURCES_EVERY_MS, height: 8343327, provider: 'TestNode', judged: true, sources: 15, internal: [] });
    const stored = db.raw.prepare("SELECT * FROM checks WHERE key = 'bond_sources'").get();
    expect(checkOf(stored, NOW + 41 * MIN).status).toBe('ok');
    expect(checkOf(stored, NOW + 2 * BOND_LISTING_MS + MIN).status).toBe('stale');
    expect(checkDetail(checkOf(stored, NOW))).toBe('None of the 15 sources in the bond listing at block 8,343,327 is a protocol account');
    expect(parseBondListing(BONDS.value).internalSources).toEqual([]);
  });

  it('a listing naming the staking account as a source: the parser keeps it apart (never a staker), the totals count it, and the row names it with its bonded NAM', async () => {
    const value = listingB64([
      { source: established(1), validator: established(9), bonds: [{ start: 2690, amount: 5_000_000_000n }] },
      { source: internal(0), validator: established(9), bonds: [{ start: 2691, amount: 1_000_000_000n, slashed: 250_000_000n }] },
    ]);
    const l = parseBondListing(value);
    expect([...l.sources.keys()]).toHaveLength(1);
    expect(l.sources.has(NAMADA.internal.pos)).toBe(false);
    expect(l.internalSources).toEqual([{ address: NAMADA.internal.pos, bondedBase: 750_000_000n, grossBase: 1_000_000_000n, slashedBase: 250_000_000n, unbondingBase: 0n }]);
    expect(l.totalBase).toBe(5_750_000_000n);
    expect(l.entries).toBe(2);
    const db = testD1();
    const rec = await runBondListing(env(db), [], NOW, 2690, {}, lister(value, 8_516_000));
    expect(rec).toMatchObject({ completeAt: NOW, stakers: 1 });
    expect(db.raw.prepare('SELECT COUNT(*) n FROM stakes WHERE address = ?').get(NAMADA.internal.pos).n).toBe(0);
    const r = row(db, 'bond_sources')!;
    expect(r.status).toBe('warn');
    expect(r.detail).toMatchObject({ judged: true, sources: 2, height: 8_516_000, internal: [{ address: NAMADA.internal.pos, bondedBase: '750000000', bondedNam: 750, unbondingBase: '0' }] });
    expect(checkDetail(checkOf(db.raw.prepare("SELECT * FROM checks WHERE key = 'bond_sources'").get(), NOW))).toBe(`A protocol account is listed as a staker in the bond listing at block 8,516,000: ${NAMADA.internal.pos} with 750.000000 NAM bonded`);
    // the same from the check alone, with a listing the gate would refuse (one internal source and nothing else)
    const alone = bondSourcesCheck({ ...parseBondListing(listingB64([{ source: internal(0), validator: established(9), bonds: [{ start: 2691, amount: 1_000_000_000n }] }])), height: 8_516_000, provider: 'TestNode' }, NOW);
    expect(statusOf(alone)).toBe('warn');
    expect(detailOf(alone)).toMatchObject({ sources: 1, internal: [{ address: NAMADA.internal.pos, bondedNam: 1000 }] });
    // a validator that is an internal address is still no listing at all
    expect(() => parseBondListing(listingB64([{ source: established(1), validator: internal(0), bonds: [] }]))).toThrow(/internal address as validator/);
  });

  it('a listing that could not be read is idle, never a pass', async () => {
    const db = testD1();
    await runBondListing(env(db), [], NOW, 2690, {}, async () => { throw new Error('5ElementsNodes: timeout; Papadritta: timeout'); });
    const r = row(db, 'bond_sources')!;
    expect(r.status).toBe('idle');
    expect(r.detail).toMatchObject({ everyMs: BOND_SOURCES_EVERY_MS, judged: false, notJudged: 'not-read', height: null });
    expect(checkDetail(checkOf(db.raw.prepare("SELECT * FROM checks WHERE key = 'bond_sources'").get(), NOW))).toBe('Not judged: the bond listing was not read at the last try');
  });
});

// ---------------------------------------------------------------- the words, and one real tick

describe('the four rows in words', () => {
  it('plain titles, free of the words the site does not show', () => {
    expect(CHECK_TITLES.masp_ledger).toBe("The shielded pool's NAM moves add up to its balance change");
    expect(CHECK_TITLES.pos_remainder).toBe("The staking account's balance moves only by staking, unstaking and rewards");
    expect(CHECK_TITLES.bond_sources).toBe('No protocol account appears as a staker');
    expect(CHECK_TITLES.masp_tx_coverage).toBe("Every shielded transaction the chain recorded is in this site's record");
    for (const key of ['masp_ledger', 'pos_remainder', 'bond_sources', 'masp_tx_coverage']) expect(CHECK_TITLES[key], key).not.toMatch(BANNED);
  });
});

const u256 = (n: bigint) => btoa(String.fromCharCode(...amount(n)));
const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
const u64b64 = (n: number) => btoa(String.fromCharCode(...u64(n)));
const asked: string[] = [];
/** Both nodes at one head (8,343,400, epoch 2715), every balance key 1 NAM, and the shielded-transaction indexer's two routes. */
function network(keys: Record<string, string> = {}) {
  asked.length = 0;
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    asked.push(url);
    if (url.includes('masp.namada.net')) {
      if (url.endsWith('/api/v1/height')) return Promise.resolve(json({ block_height: 8343000 }));
      if (url.includes('/api/v1/tx')) return Promise.resolve(json({ txs: [] }));
      return Promise.resolve(new Response('not here', { status: 404 }));
    }
    if (url.includes('/status')) return Promise.resolve(json({ result: { node_info: { network: NAMADA.chainId }, sync_info: { latest_block_height: '8343400', latest_block_time: new Date().toISOString(), catching_up: false, earliest_block_height: '1' } } }));
    if (url.includes('abci_query')) {
      const path = decodeURIComponent((url.split('path=')[1] ?? '').split('&')[0]).replace(/^"|"$/g, '');
      if (path.includes('/vp/pos/bond/')) return Promise.resolve(json({ result: { response: { code: 1, info: 'Cannot find bond', value: null, height: '1' } } }));
      const key = path.split('/').pop()!;
      const height = new URL(url).searchParams.get('height') ?? '8343400';
      if (keys[key]) return Promise.resolve(json({ result: { response: { code: 0, value: keys[key], height } } }));
      const value = path.includes('/shell/epoch') ? u64b64(2715)
        : path.includes('/shell/prefix/') || path.includes('delegations_at') || path.includes('bonds_and_unbonds') ? null
        : u256(path.includes('total_stake') ? 75_338_381_473_000n : 1_000_000n);
      return Promise.resolve(json({ result: { response: { code: 0, value, height } } }));
    }
    return Promise.resolve(new Response('not here', { status: 404 }));
  }));
}
async function tick(db: TestD1, at: number) {
  vi.useFakeTimers({ now: at, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  let done = false; let err: unknown = null;
  runCron({ DB: db, KEPLR_KEY: 'k' } as any).catch((e) => { err = e; }).finally(() => { done = true; });
  for (let i = 0; !done && i < 4000; i++) await vi.advanceTimersByTimeAsync(250);
  vi.useRealTimers();
  if (err) throw err;
  expect(done).toBe(true);
}
// 22:41:05 UTC: no holder sync, not the first minutes of an hour
const PLAIN = Date.parse('2026-10-17T22:41:05Z');

describe('the tick wires the four rows', () => {
  it('writes each row with its cadence and keeps its state in kv, and does not write them again before they are due', async () => {
    const db = testD1();
    const kvPut = (key: string, value: unknown, at = PLAIN - 5 * MIN) => db.raw.prepare('INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)').run(key, typeof value === 'string' ? value : JSON.stringify(value), at);
    // the block scan at the head, a complete bond listing at the head's block, and the day before as the halt would leave it: the same balance at both ends, no move
    kvPut('namada.cursor', '8343400');
    kvPut('bond.listing', { at: PLAIN - 5 * MIN, completeAt: PLAIN - 5 * MIN, height: 8343400, epoch: 2715, provider: '5ElementsNodes', sources: 15, stakers: 12, totalNam: 75_564_396.617851, bytes: 0, written: 0, zeroed: 0, remaining: 0, ticks: 1, durationMs: 0,
      bondedBase: '75564396617851', unbondingBase: '1000000', slashedBase: '163756000000', unbondSlashedBase: '0' });
    const yesterday = dayStartOf(PLAIN) - D;
    insert(db, 'metrics', [{ ts: yesterday - MIN, key: 'supply.masp_shielded', value: 1 }, { ts: yesterday + D - MIN, key: 'supply.masp_shielded', value: 1 }, { ts: yesterday - MIN, key: 'epoch', value: 2714 }, { ts: yesterday + D - MIN, key: 'epoch', value: 2715 }]);
    network({ masp_epoch_multiplier: u64b64(4) });
    await tick(db, PLAIN);
    // masp_ledger: the day before judged idle (nothing happened), and the chain's rewards total read at the head with the epoch
    expect(row(db, 'masp_ledger')).toMatchObject({ status: 'idle', checked_at: PLAIN, detail: { everyMs: MASP_LEDGER_EVERY_MS, day: '2026-10-16', notJudged: 'nothing-happened', scanLagBlocks: 0 } });
    expect(kvJson(db, MASP_LEDGER_KV)).toEqual({ rewards: [{ at: PLAIN, height: 8343400, provider: '5ElementsNodes', epoch: 2715, totalBase: '1000000' }] });
    expect(asked.some((u) => decodeURIComponent(u).includes(`#${MASP}/max_total_rewards`))).toBe(true);
    // pos_remainder: the first complete listing kept, with the account's NAM read at its own block
    expect(row(db, 'pos_remainder')).toMatchObject({ status: 'idle', checked_at: PLAIN, detail: { everyMs: POS_REMAINDER_EVERY_MS, notJudged: 'first', height: 8343400 } });
    expect(kvJson(db, POS_REMAINDER_KV)).toMatchObject({ rowFor: PLAIN - 5 * MIN, last: { height: 8343400, epoch: 2715, posBase: '1000000', bondedBase: '75564396617851' } });
    expect(asked.some((u) => u.includes('&height=8343400') && decodeURIComponent(u).includes(`balance/#${NAMADA.internal.pos}`))).toBe(true);
    // masp_tx_coverage: the first run sets the record's start at the scan's cursor, and the source's row is on the sheet
    expect(row(db, 'masp_tx_coverage')).toMatchObject({ status: 'idle', checked_at: PLAIN, detail: { everyMs: MASP_COVERAGE_EVERY_MS, notJudged: 'first-run', cursor: 8343400, indexerHeight: 8343000 } });
    expect(kvJson(db, MASP_COVERAGE_KV)).toEqual({ judgedTo: 8343400, at: PLAIN });
    const health = JSON.parse(db.raw.prepare("SELECT value FROM kv WHERE key='source.health'").get().value);
    expect(health[MASP_INDEXER_HEALTH]).toMatchObject({ ok: true });
    expect(health[MASP_INDEXER_HEALTH].note).toMatch(/^last block with a shielded transaction 8,343,000; nothing to compare this hour/);
    // every line reads plain
    for (const key of ['masp_ledger', 'pos_remainder', 'masp_tx_coverage']) {
      const line = checkDetail(checkOf(db.raw.prepare('SELECT * FROM checks WHERE key = ?').get(key), PLAIN));
      expect(line, key).toBeTruthy();
      expect(line, key).not.toMatch(BANNED);
    }
    // a minute later none is due: the rows keep their time
    network({ masp_epoch_multiplier: u64b64(4) });
    await tick(db, PLAIN + MIN);
    for (const key of ['masp_ledger', 'pos_remainder', 'masp_tx_coverage']) expect(row(db, key)!.checked_at, key).toBe(PLAIN);
    expect(asked.some((u) => u.includes('masp.namada.net'))).toBe(false);
    expect(asked.some((u) => u.includes('&height='))).toBe(false);
  });
});
