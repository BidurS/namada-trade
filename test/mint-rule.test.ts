// The mint rule (2026-11-02, cron.ts mintRuleNext): the minted total of NAM may change only at an epoch's first block,
// and then by what the chain records there (the staking inflation in last_inflation_amount, public-funding inflation
// when its rates are above 0, shielded rewards on a shielded-reward epoch). This rule judges how the minted total
// itself changes, which supply_integrity does not. The row is 'warn' only for now.
// The backtest replays the 26,276 minute rows production stored for epochs 2664 to 2738
// (test/fixtures/mint_rule_backtest.json, whose note says how they were read).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  mintRuleNext, judgeMint, mintKeysWanted, mintKeysDue, mintKeysPhaseEnd, mintReadingOf, mintedEpochBefore, crossSourceShadow,
  MINT_RULE_HOLD_MS, MINT_RULE_UNJUDGED_MS, MINT_RULE_EVERY_MS, MINT_KEYS_RETRY_MS, MINT_KEYS_PHASE_MS, LISTING_RESERVE_MS, type MintReading, type MintRuleState,
} from '../worker/src/cron';
import type { MintKeys } from '../worker/src/sources/namada';

const BT = JSON.parse(readFileSync(new URL('./fixtures/mint_rule_backtest.json', import.meta.url), 'utf8')) as {
  ticks: number;
  epochs: [number, number, string][];
  steps: { epoch: number; mintedBeforeBase: string; mintedAfterBase: string; pgfBeforeBase: string }[];
  recorded: { epoch: number; height: number; lastInflationBase: string };
  standIn: { maxInflationRate: string; epochsPerYear: number; maspEpochMultiplier: number };
};

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 15, 4, 14);
const reading = (epoch: number, minted: bigint | string, height: number, at: number, extra: Partial<MintReading> = {}): MintReading =>
  ({ epoch, mintedBase: String(minted), height, provider: 'A', at, maspBase: null, posBase: null, ...extra });
const keys = (lastInflationBase: bigint, over: Partial<MintKeys> = {}): MintKeys =>
  ({ lastInflationBase, pgfRate: '0', stewardRate: '0', maspEpochMultiplier: 4, height: 0, provider: 'A', ...over });

/** The stand-in for an earlier step's last_inflation_amount (the fixture's note): the staking inflation at the cap. */
function atCap(mintedBefore: bigint, pgfBefore: bigint): bigint {
  const [whole, frac = ''] = BT.standIn.maxInflationRate.split('.');
  const scale = 10n ** BigInt(frac.length);
  const rate = BigInt(whole) * scale + BigInt(frac || '0');
  return ((mintedBefore - pgfBefore) * rate) / scale / BigInt(BT.standIn.epochsPerYear);
}

/** Run the rule over readings; `keysFor` answers when mintKeysWanted asks. */
function replay(readings: MintReading[], keysFor: (r: MintReading) => MintKeys | { error: string } | null, start: MintRuleState | null = null) {
  let state: MintRuleState | null = start;
  const out: { status: string; detail: Record<string, unknown>; asked: boolean }[] = [];
  for (const r of readings) {
    const asked = mintKeysWanted(state, r);
    const m = mintRuleNext(state, r, asked ? keysFor(r) : null, r.at);
    state = m.state;
    out.push({ status: m.status, detail: m.detail, asked });
  }
  return { state: state!, out };
}

describe('the backtest: the minute rows of epochs 2664 to 2738', () => {
  // the readings as the cron would have made them: one a minute, the minted total of the epoch each minute is in
  const readings: MintReading[] = [];
  let h = 8_300_000, at = T0;
  for (const [epoch, n, minted] of BT.epochs) for (let i = 0; i < n; i++) readings.push(reading(epoch, minted, (h += 8), (at += MIN)));
  const pgfBefore = new Map(BT.steps.map((s) => [s.epoch, BigInt(s.pgfBeforeBase)]));
  const recorded = (r: MintReading) => {
    const step = BT.steps.find((s) => s.epoch === r.epoch)!;
    return keys(r.epoch === BT.recorded.epoch ? BigInt(BT.recorded.lastInflationBase) : atCap(BigInt(step.mintedBeforeBase), pgfBefore.get(r.epoch)!));
  };

  it('the fixture is what its note says: 26,276 minutes, one minted total an epoch, 74 steps', () => {
    expect(readings).toHaveLength(BT.ticks);
    expect(BT.ticks).toBe(26_276);
    expect(BT.epochs).toHaveLength(75);
    expect(BT.steps).toHaveLength(74);
    // the stand-in for the last step is the chain's own record of it, to the base unit
    const last = BT.steps.at(-1)!;
    expect(last.epoch).toBe(BT.recorded.epoch);
    expect(atCap(BigInt(last.mintedBeforeBase), BigInt(last.pgfBeforeBase)).toString()).toBe(BT.recorded.lastInflationBase);
    expect(BigInt(last.mintedAfterBase) - BigInt(last.mintedBeforeBase)).toBe(BigInt(BT.recorded.lastInflationBase));
  });

  it('every minute fits: 26,201 unchanged within an epoch and 74 steps equal to the staking inflation, nothing broken', () => {
    const { state, out } = replay(readings, recorded);
    expect(out[0]).toMatchObject({ status: 'idle', detail: { verdict: 'first' } });
    const rest = out.slice(1);
    expect(rest.every((o) => o.status === 'ok')).toBe(true);
    expect(rest.filter((o) => o.detail.verdict === 'same')).toHaveLength(26_201);
    expect(rest.filter((o) => o.detail.verdict === 'step')).toHaveLength(74);
    // the chain's record was asked for exactly once an epoch step, on the first minute of each new epoch
    expect(out.filter((o) => o.asked)).toHaveLength(74);
    expect(state.broke).toBeNull();
    expect(state.lastStep).toMatchObject({ epoch: 2738, grewBase: '19961144868', stakingBase: '19961144868', shieldedBase: '0', fits: true, mintedBeforeBase: '1148734527288587' });
    expect(mintedEpochBefore(state)).toBe(1148734527288587n);
  });

  it('one base unit more at one step is a broken rule once the next minute does not fit either', () => {
    // epoch 2701 starts no shielded-reward epoch (2701 % 4 is 1): the extra unit has nowhere to come from
    const odd = readings.map((r) => (r.epoch === 2701 ? { ...r, mintedBase: (BigInt(r.mintedBase) + 1n).toString() } : r));
    const { out } = replay(odd, recorded);
    const first = odd.findIndex((r) => r.epoch === 2701);
    // the minute that waits keeps the last judgement's status: the row does not switch for it
    expect(out[first]).toMatchObject({ status: 'ok', detail: { verdict: 'pending' } });
    expect(out[first + 1]).toMatchObject({ status: 'warn', detail: { verdict: 'step-off' } });
    expect((out[first + 1].detail.broke as any).verdict).toMatchObject({ kind: 'step-off', step: { epoch: 2701, fits: false }, why: 'more than the staking inflation the chain recorded, at an epoch that credits no shielded rewards' });
    // the rest of epoch 2701 holds for the new reading, and the row stays 'warn'
    expect(out[first + 2]).toMatchObject({ status: 'warn', detail: { verdict: 'same' } });
    // the step out of 2701 is then one unit short of the staking inflation: broken again
    const next = odd.findIndex((r) => r.epoch === 2702);
    expect(out[next]).toMatchObject({ status: 'warn', detail: { verdict: 'pending' } });
    expect(out[next + 1]).toMatchObject({ status: 'warn', detail: { verdict: 'step-off' } });
    expect((out[next + 1].detail.broke as any).verdict).toMatchObject({ why: 'less than the staking inflation the chain recorded' });
    expect(out.filter((o) => o.detail.verdict === 'step-off')).toHaveLength(2);
    // a day after the last break the row passes again
    const dayOn = odd.findIndex((r) => r.at - odd[next + 1].at >= MINT_RULE_HOLD_MS);
    expect(out[dayOn - 1].status).toBe('warn');
    expect(out[dayOn].status).toBe('ok');
  });
});

describe('the rule, case by case', () => {
  const m0 = 1_148_734_527_288_587n;
  const inflation = 19_961_144_868n;

  it('the first reading is kept, and the next minute is judged against it', () => {
    const a = mintRuleNext(null, reading(2737, m0, 100, T0), null, T0);
    expect(a).toMatchObject({ status: 'idle', detail: { verdict: 'first', everyMs: MINT_RULE_EVERY_MS } });
    const b = mintRuleNext(a.state, reading(2737, m0, 108, T0 + MIN), null, T0 + MIN);
    expect(b).toMatchObject({ status: 'ok', detail: { verdict: 'same', epoch: 2737, height: 108 } });
  });

  it('a change within an epoch seen once is not counted when the next minute is back on the rule', () => {
    const { out, state } = replay([reading(2737, m0, 100, T0), reading(2737, m0 + 5n, 108, T0 + MIN), reading(2737, m0, 116, T0 + 2 * MIN)], () => null);
    expect(out.map((o) => [o.status, o.detail.verdict])).toEqual([['idle', 'first'], ['idle', 'pending'], ['ok', 'same']]);
    expect(out[2].detail.note).toBe('the reading at block 108 did not fit and this one does: it is not counted');
    expect(state.broke).toBeNull();
  });

  it('a change within an epoch seen twice breaks the rule, names both blocks and both nodes, and holds for a day', () => {
    const { out, state } = replay([reading(2737, m0, 100, T0), reading(2737, m0 + 5n, 108, T0 + MIN), reading(2737, m0 + 5n, 116, T0 + 2 * MIN, { provider: 'B' })], () => null);
    expect(out[2]).toMatchObject({ status: 'warn', detail: { verdict: 'changed', broke: { fromHeight: 100, toHeight: 116, fromEpoch: 2737, toEpoch: 2737, fromProvider: 'A', provider: 'B', verdict: { kind: 'changed', byBase: '5' } } } });
    const later = mintRuleNext(state, reading(2737, m0 + 5n, 124, T0 + 3 * MIN), null, T0 + 3 * MIN);
    expect(later).toMatchObject({ status: 'warn', detail: { verdict: 'same' } });
    const dayOn = mintRuleNext(later.state, reading(2737, m0 + 5n, 132, T0 + 2 * MIN + MINT_RULE_HOLD_MS), null, T0 + 2 * MIN + MINT_RULE_HOLD_MS);
    expect(dayOn).toMatchObject({ status: 'ok', detail: { verdict: 'same', broke: null } });
  });

  it('an epoch step equal to the staking inflation the chain recorded fits; one base unit less does not', () => {
    const a = reading(2737, m0, 100, T0);
    expect(judgeMint(a, reading(2738, m0 + inflation, 108, T0 + MIN), keys(inflation))).toMatchObject({ kind: 'step', step: { fits: true, shieldedBase: '0' } });
    expect(judgeMint(a, reading(2738, m0 + inflation - 1n, 108, T0 + MIN), keys(inflation))).toMatchObject({ kind: 'step-off', why: 'less than the staking inflation the chain recorded' });
  });

  it('on a shielded-reward epoch the rest is shielded rewards, up to the shielded pool\'s own rise over the same readings', () => {
    const a = reading(2739, m0, 100, T0, { maspBase: '31593419403039' });
    // 2740 % 4 == 0: a shielded-reward epoch
    const fits = judgeMint(a, reading(2740, m0 + inflation + 250n, 108, T0 + MIN, { maspBase: '31593419403289' }), keys(inflation));
    expect(fits).toMatchObject({ kind: 'step', step: { shieldedEpoch: true, shieldedBase: '250', maspRiseBase: '250', fits: true } });
    // more than the pool rose (a move out of the pool between the readings lowers its rise), or a pool not read with
    // both readings: the rest may still be shielded rewards, so the step is not judged exactly, never a broken rule
    const over = judgeMint(a, reading(2740, m0 + inflation + 251n, 108, T0 + MIN, { maspBase: '31593419403289' }), keys(inflation));
    expect(over).toMatchObject({ kind: 'shielded-unchecked', step: { shieldedEpoch: true, shieldedBase: '251', maspRiseBase: '250', fits: false } });
    const unread = judgeMint(a, reading(2740, m0 + inflation + 250n, 108, T0 + MIN), keys(inflation));
    expect(unread).toMatchObject({ kind: 'shielded-unchecked', step: { shieldedBase: '250', maspRiseBase: null } });
    // less than the staking inflation is broken whatever the epoch
    expect(judgeMint(a, reading(2740, m0 + inflation - 1n, 108, T0 + MIN, { maspBase: '31593419403289' }), keys(inflation))).toMatchObject({ kind: 'step-off', why: 'less than the staking inflation the chain recorded' });
    // the multiplier is the chain's: with 5, epoch 2740 is one too, 2741 is not
    expect(judgeMint(reading(2740, m0, 100, T0), reading(2741, m0 + inflation + 1n, 108, T0 + MIN, {}), keys(inflation, { maspEpochMultiplier: 5 }))).toMatchObject({ kind: 'step-off' });
  });

  it("shielded rewards the pool's rise cannot bound are said as not judged for a day, and never break the rule", () => {
    const a = mintRuleNext(null, reading(2739, m0, 100, T0, { maspBase: '1000' }), null, T0).state;
    // the pool lost NAM between the readings (a move out): its rise cannot bound the 250 base units
    const step = mintRuleNext(a, reading(2740, m0 + inflation + 250n, 108, T0 + MIN, { maspBase: '900' }), keys(inflation), T0 + MIN);
    expect(step).toMatchObject({ status: 'warn', detail: { verdict: 'shielded-unchecked', broke: null, unjudged: { fromHeight: 100, toHeight: 108, toEpoch: 2740, verdict: { kind: 'shielded-unchecked', step: { shieldedBase: '250', maspRiseBase: '-100' } } } } });
    expect(step.state.broke).toBeNull();
    expect(step.state.anchor?.height).toBe(108);
    // the epoch's later minutes are judged against the new reading, and the row says the span for a day
    const later = mintRuleNext(step.state, reading(2740, m0 + inflation + 250n, 116, T0 + 2 * MIN), null, T0 + 2 * MIN);
    expect(later).toMatchObject({ status: 'warn', detail: { verdict: 'same', broke: null, unjudged: { toHeight: 108 } } });
    const dayOn = mintRuleNext(later.state, reading(2740, m0 + inflation + 250n, 124, T0 + MIN + MINT_RULE_HOLD_MS), null, T0 + MIN + MINT_RULE_HOLD_MS);
    expect(dayOn).toMatchObject({ status: 'ok', detail: { verdict: 'same', unjudged: null } });
  });

  it("records, beside the rule, whether the staking account rose by the staking inflation (not judged)", () => {
    const a = reading(2737, m0, 100, T0, { posBase: '343820912480000' });
    const same = judgeMint(a, reading(2738, m0 + inflation, 108, T0 + MIN, { posBase: String(343820912480000n + inflation) }), keys(inflation));
    expect(same).toMatchObject({ kind: 'step', step: { posRiseBase: String(inflation), posRiseMatches: true, fits: true } });
    // a withdrawal in between moves it too: recorded, and the step still fits
    const moved = judgeMint(a, reading(2738, m0 + inflation, 108, T0 + MIN, { posBase: String(343820912480000n + inflation - 5_000_000n) }), keys(inflation));
    expect(moved).toMatchObject({ kind: 'step', step: { posRiseMatches: false, fits: true } });
    expect(judgeMint(a, reading(2738, m0 + inflation, 108, T0 + MIN), keys(inflation))).toMatchObject({ kind: 'step', step: { posRiseBase: null, posRiseMatches: null } });
  });

  it('public funding minting, or a gap of epochs, is never judged ok', () => {
    const a = mintRuleNext(null, reading(2737, m0, 100, T0), null, T0).state;
    const pgf = mintRuleNext(a, reading(2738, m0 + inflation + 7n, 108, T0 + MIN), keys(inflation, { pgfRate: '0.01' }), T0 + MIN);
    expect(pgf).toMatchObject({ status: 'warn', detail: { verdict: 'public-funding', pgfRate: '0.01', stewardRate: '0' } });
    const gap = mintRuleNext(a, reading(2739, m0 + 2n * inflation, 900, T0 + 13 * 3600_000), null, T0 + 13 * 3600_000);
    expect(gap).toMatchObject({ status: 'warn', detail: { verdict: 'gap', epochs: 2, unjudged: { fromHeight: 100, toHeight: 900 } } });
    // judged from the new reading on, and still 'warn' with the span in the detail while it is held, never 'ok'
    const next = mintRuleNext(gap.state, reading(2739, m0 + 2n * inflation, 908, T0 + 13 * 3600_000 + MIN), null, T0 + 13 * 3600_000 + MIN);
    expect(next).toMatchObject({ status: 'warn', detail: { verdict: 'same', unjudged: { fromHeight: 100, toHeight: 900, verdict: { kind: 'gap', epochs: 2 } } } });
    const idle = mintRuleNext(next.state, { why: 'different-blocks', note: 'x' }, null, T0 + 13 * 3600_000 + 2 * MIN);
    expect(idle.status).toBe('warn');
    // a day after the span the row passes again
    const dayOn = T0 + 13 * 3600_000 + MINT_RULE_HOLD_MS;
    expect(mintRuleNext(next.state, reading(2739, m0 + 2n * inflation, 916, dayOn), null, dayOn)).toMatchObject({ status: 'ok', detail: { unjudged: null } });
  });

  it('a step whose record could not be read waits, with the anchor kept, and is read again only after MINT_KEYS_RETRY_MS', () => {
    const a = mintRuleNext(null, reading(2737, m0, 100, T0), null, T0).state;
    const r1 = reading(2738, m0 + inflation, 108, T0 + MIN);
    expect(mintKeysWanted(a, r1)).toBe(true);
    expect(mintKeysDue(a, r1, T0 + MIN)).toBe('read');
    const miss = mintRuleNext(a, r1, { error: 'no node answered', tried: true }, T0 + MIN);
    expect(miss).toMatchObject({ status: 'idle', detail: { verdict: 'not-judged', why: 'step-not-read' } });
    expect(miss.state).toMatchObject({ keysFailedAt: T0 + MIN });
    expect(miss.state.anchor?.height).toBe(100);
    // the next minutes of the new epoch do not read the four keys again until the retry time
    const r2 = reading(2738, m0 + inflation, 116, T0 + 2 * MIN);
    expect(mintKeysDue(miss.state, r2, T0 + 2 * MIN)).toBe('wait');
    const wait = mintRuleNext(miss.state, r2, { error: 'the last read failed' }, T0 + 2 * MIN);
    expect(wait).toMatchObject({ detail: { verdict: 'not-judged', why: 'step-not-read' } });
    expect(wait.state.keysFailedAt).toBe(T0 + MIN);
    const r3 = reading(2738, m0 + inflation, 160, T0 + MIN + MINT_KEYS_RETRY_MS);
    expect(mintKeysDue(wait.state, r3, T0 + MIN + MINT_KEYS_RETRY_MS)).toBe('read');
    const read = mintRuleNext(wait.state, r3, keys(inflation), T0 + MIN + MINT_KEYS_RETRY_MS);
    expect(read).toMatchObject({ status: 'ok', detail: { verdict: 'step' } });
    expect(read.state.keysFailedAt).toBeNull();
    // a tick that ran out of time before reading made no read: the next one may try at once
    const late = mintRuleNext(a, r1, { error: 'the tick ran out of time before the step could be read' }, T0 + MIN);
    expect(mintKeysDue(late.state, r2, T0 + 2 * MIN)).toBe('read');
    // within the epoch nothing is wanted
    expect(mintKeysDue(read.state, reading(2738, m0 + inflation, 168, T0 + MIN + MINT_KEYS_RETRY_MS + MIN), T0 + MIN + MINT_KEYS_RETRY_MS + MIN)).toBeNull();
  });

  it('the reads of the record end MINT_KEYS_PHASE_MS on, and LISTING_RESERVE_MS before the deadline at the latest', () => {
    const deadline = T0 + 45_000;
    expect(mintKeysPhaseEnd(deadline, T0 + 5_000)).toBe(T0 + 5_000 + MINT_KEYS_PHASE_MS);
    expect(mintKeysPhaseEnd(deadline, T0 + 20_000)).toBe(deadline - LISTING_RESERVE_MS);
    expect(mintKeysPhaseEnd(deadline, deadline - LISTING_RESERVE_MS)).toBeNull();
    expect(mintKeysPhaseEnd(deadline, T0 + 40_000)).toBeNull();
  });

  it("a minute that cannot judge keeps the last judgement's status while it is recent, and is warn after", () => {
    const a = mintRuleNext(null, reading(2737, m0, 100, T0), null, T0).state;
    // before any judgement: idle
    expect(mintRuleNext(a, { why: 'different-blocks', note: 'x' }, null, T0 + MIN).status).toBe('idle');
    const b = mintRuleNext(a, reading(2737, m0, 108, T0 + MIN), null, T0 + MIN).state;
    const why = { why: 'minted-not-read' as const, note: 'the minted total was not read this tick' };
    expect(mintRuleNext(b, why, null, T0 + 2 * MIN)).toMatchObject({ status: 'ok', detail: { verdict: 'not-judged', why: 'minted-not-read', judgedAt: T0 + MIN } });
    expect(mintRuleNext(b, why, null, T0 + MIN + MINT_RULE_UNJUDGED_MS).status).toBe('warn');
    // an answer older than the anchor (a node behind) is not judged either
    expect(mintRuleNext(b, reading(2737, m0, 90, T0 + 2 * MIN), null, T0 + 2 * MIN)).toMatchObject({ status: 'ok', detail: { why: 'older' } });
    // so judged and not judged minutes in turn never switch the row (each switch is a line in the operator's log)
    const { out } = replay([reading(2737, m0, 100, T0), reading(2737, m0, 108, T0 + MIN), reading(2737, m0, 90, T0 + 2 * MIN), reading(2737, m0, 116, T0 + 3 * MIN), reading(2737, m0 + 1n, 124, T0 + 4 * MIN), reading(2737, m0, 132, T0 + 5 * MIN)], () => null);
    expect(out.slice(1).map((o) => o.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
  });

  it("a reading needs the minted total and the epoch from one node at one block; the pool's and the staking account's go with it only at that block", () => {
    const total = { supply: m0, height: 200, provider: 'A' };
    expect(mintReadingOf(null, { epoch: 2737, height: 200, provider: 'A' }, null, null, T0)).toMatchObject({ why: 'minted-not-read' });
    expect(mintReadingOf(total, null, null, null, T0)).toMatchObject({ why: 'epoch-not-read' });
    expect(mintReadingOf(total, { epoch: 2737, height: 201, provider: 'A' }, null, null, T0)).toMatchObject({ why: 'different-blocks' });
    expect(mintReadingOf(total, { epoch: 2737, height: 200, provider: 'B' }, null, null, T0)).toMatchObject({ why: 'different-blocks' });
    const r = mintReadingOf(total, { epoch: 2737, height: 200, provider: 'A' }, { balance: 5n, height: 199, provider: 'A' }, { balance: 7n, height: 200, provider: 'A' }, T0);
    expect(r).toEqual({ epoch: 2737, mintedBase: String(m0), height: 200, provider: 'A', at: T0, maspBase: null, posBase: '7' });
  });
});

describe('the cross-source rule recorded in shadow', () => {
  it('passes only an exact match with this epoch or the epoch before; the fail line stays at 1%', () => {
    const m = 1_148_754_488_433_455n, before = 1_148_734_527_288_587n;
    expect(crossSourceShadow(m, m, before)).toEqual({ status: 'ok', matched: 'this epoch' });
    expect(crossSourceShadow(before, m, before)).toEqual({ status: 'ok', matched: 'the epoch before' });
    expect(crossSourceShadow(m + 1n, m, before)).toEqual({ status: 'warn', matched: null });
    expect(crossSourceShadow(before, m, null)).toEqual({ status: 'warn', matched: null });
    expect(crossSourceShadow(m + m / 50n, m, before)).toEqual({ status: 'fail', matched: null });
  });
});
