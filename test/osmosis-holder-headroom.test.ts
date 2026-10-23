// Security review (2026-10-22), how far the Osmosis holder pass goes as owners are added: at the pace measured on
// 2026-10-23 (810 ms a page) a tick reads about 37 pages of 100 owners, so a pass of more than about 111,000 owners
// takes longer than the 30 minutes after which a pass going on was reported not ok, and from then on the public
// holders row read not ok during every pass that was going normally. The limit now scales with the last complete
// pass (twice its length, at most 6 hours), so a list that grows is not reported for its length alone, while one
// that never ends still is. The count's stamp is the start of the last pass that added up, until the next one
// completes; passes an hour or more apart wait holders x 2 / 1,000 minutes, so the stamp turns old for part of every
// cycle from about 155,000 owners (the notes said 280,000), as the pass record's description says.
import { describe, it, expect } from 'vitest';
import { nextOsmoPass, nextOsmoPassAt, osmoPassOverdueMs, OSMO_PASS_OVERDUE_MS, OSMO_PASS_OVERDUE_MAX_MS, type OsmoHolderPass } from '../worker/src/cron';
import { holderFiguresProv } from '../worker/src/api';
import type { HolderListRead } from '../worker/src/sources/osmosis';

const MIN = 60_000;
const START = Date.parse('2026-10-17T23:00:05Z');
/** The first 10-minute sync (now % 600000 < 60000) at or after t, as the cron's minute ticks meet it. */
const nextSync = (t: number) => { let m = Math.ceil((t - 5000) / MIN) * MIN + 5000; while (m % 600_000 >= 60_000) m += MIN; return m; };
/** About 37 pages of 100 owners a tick (14 pages in 11,327 ms on 2026-10-23, in the 30 s a slice has). */
const PER_TICK = 3700;

/**
 * Passes over lists of `sizes[i]` owners, one slice of PER_TICK owners a minute, each pass starting at the first sync
 * nextOsmoPassAt allows; every pass adds up. Returns each step's health and, for each completed pass, how old the
 * count's stamp (the last trusted pass's start) was just before it completed.
 */
function run(sizes: number[]) {
  let prev: OsmoHolderPass | null = null;
  let t = START;
  const steps: { at: number; ok: boolean; note: string | null }[] = [];
  const ages: number[] = [];
  for (const size of sizes) {
    let left = size;
    const stampBefore: number | null = prev?.trustedStartedAt ?? null;
    while (left > 0) {
      const n = Math.min(PER_TICK, left);
      left -= n;
      const read: HolderListRead = {
        holders: Array.from({ length: n }, () => ({ address: 'osmo1x', balance: '1', balanceNum: 1e-6 })),
        complete: left === 0, capped: false, pages: Math.ceil(n / 100), ...(left > 0 ? { nextKey: 'k' } : {}),
      };
      const step = nextOsmoPass(prev, read, BigInt(size), t, prev ? null : t);
      prev = step.pass;
      steps.push({ at: t, ok: step.ok, note: step.note });
      if (left > 0) t += MIN;
    }
    if (stampBefore != null) ages.push(t - stampBefore);
    t = nextSync(nextOsmoPassAt(prev));
  }
  return { steps, ages, last: prev! };
}

describe('a pass that is going normally is not reported for its length', () => {
  it('a list that grows from 100,000 to 220,000 owners: every pass is ok on every tick, though from 111,000 a pass takes over 30 minutes', () => {
    const { steps, last } = run([100_000, 120_000, 150_000, 180_000, 220_000]);
    expect(steps.length).toBeGreaterThan(200);
    expect(steps.filter((s) => !s.ok)).toEqual([]);
    expect(last.lastPassMs).toBe(Math.ceil(220_000 / PER_TICK - 1) * MIN);
  });

  it('the limit: 30 minutes after a short pass, twice the last complete pass after a long one, at most 6 hours', () => {
    expect(osmoPassOverdueMs(null)).toBe(OSMO_PASS_OVERDUE_MS);
    expect(osmoPassOverdueMs({ lastPassMs: 0 })).toBe(30 * MIN);
    expect(osmoPassOverdueMs({ lastPassMs: 41 * MIN })).toBe(82 * MIN);
    expect(osmoPassOverdueMs({ lastPassMs: 5 * 3600_000 })).toBe(OSMO_PASS_OVERDUE_MAX_MS);
  });

  it('a list that never ends is still reported: past twice the last complete pass', () => {
    // a complete pass of 100,000 owners took 27 minutes; then a pass that never completes
    let { last: prev } = run([100_000]);
    expect(prev.lastPassMs).toBe(27 * MIN);
    let t = nextSync(nextOsmoPassAt(prev));
    const start = t;
    const oks: boolean[] = [];
    for (let i = 0; i < 60; i++, t += MIN) {
      const step = nextOsmoPass(prev, { holders: [{ address: 'osmo1x', balance: '1', balanceNum: 1e-6 }], complete: false, capped: false, pages: 37, nextKey: `k${i}` }, 100_000n, t);
      prev = step.pass;
      oks.push(step.ok);
      if (!step.ok) expect(step.note).toMatch(/not complete after \d+ minutes/);
    }
    expect(oks.indexOf(false)).toBe(54);
    expect(prev.startedAt).toBe(start);
  });
});

describe('the Osmosis count stamp between complete, trusted passes', () => {
  const worst = (n: number) => Math.max(...run([n, n, n, n, n]).ages);
  it('stays current up to about 150,000 owners', () => {
    for (const n of [1_339, 10_000, 100_000, 150_000]) {
      const age = worst(n);
      expect({ n, live: holderFiguresProv(START, START, START + age).status }).toEqual({ n, live: 'live' });
    }
  });
  it('turns old for part of every cycle from about 155,000 to 160,000 owners: the gap between two pass starts and one pass together pass 6 hours', () => {
    expect(worst(155_000)).toBeLessThanOrEqual(360 * MIN);
    for (const n of [160_000, 180_000]) {
      const age = worst(n);
      expect({ n, status: holderFiguresProv(START, START, START + age).status }).toEqual({ n, status: 'stale' });
    }
  });
});
