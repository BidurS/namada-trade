// The NAM whose unstaking wait is over, by how long ago the wait ended (review item 5; owner, 2026-11-11: "Lets go
// ahead"). Counted from the chain's list of every unstaking request: the epochs since a wait ended, times the epoch
// length the site measures. The bands add up to the total, no age is stated without a measured epoch length, and
// nothing still in its wait is counted.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { WAIT_OVER_BANDS, epochWords, waitOverByAge } from '../shared/unbond-age';
import type { UnbondTermStructure } from '../shared/types';

const SIX_HOURS = 21_600;
const term = (buckets: [epoch: number, nam: number, count: number, passed?: boolean][], over: Partial<UnbondTermStructure> = {}): UnbondTermStructure => ({
  at: Date.UTC(2026, 10, 2), height: 8_517_986, currentEpoch: 2000, epochSec: SIX_HOURS, epochSecSource: 'measured over the last 69 epochs',
  withdrawableNowNam: buckets.filter((b) => b[3] !== false).reduce((a, b) => a + b[1], 0), inFlightNam: buckets.filter((b) => b[3] === false).reduce((a, b) => a + b[1], 0), totalUnbondingNam: buckets.reduce((a, b) => a + b[1], 0),
  buckets: buckets.map(([withdrawEpoch, amountNam, count, passed]) => ({ withdrawEpoch, estimatedAt: null, withdrawableNow: passed !== false, amountNam, count })),
  ...over,
});
// at six hours an epoch: four epochs a day
const daysAgo = (d: number) => 2000 - d * 4;

describe('the NAM past its unstaking wait, by how long ago the wait ended', () => {
  it('puts each passed epoch in its band by the epochs since, at the measured epoch length, and the bands add up', () => {
    const r = waitOverByAge(term([
      [daysAgo(1), 100, 2], [daysAgo(29), 50, 1],
      [daysAgo(30), 7, 1], [daysAgo(89), 3, 1],
      [daysAgo(90), 1000, 5], [daysAgo(364), 500, 4],
      [daysAgo(365), 9_000_000, 57], [daysAgo(480), 1, 1],
      // still in its wait: never counted
      [2010, 61_990, 30, false],
    ]))!;
    expect(r.bands.map((b) => [b.key, b.nam, b.count])).toEqual([['month', 150, 3], ['quarter', 10, 2], ['year', 1500, 9], ['older', 9_000_001, 58]]);
    expect(r.bands.map((b) => b.words)).toEqual(WAIT_OVER_BANDS.map((b) => b.words));
    expect(r.totalNam).toBe(150 + 10 + 1500 + 9_000_001);
    expect(r.count).toBe(72);
    expect(r).toMatchObject({ epochSec: SIX_HOURS, epochSecSource: 'measured over the last 69 epochs' });
  });

  it('the edges: under thirty days is the first band, thirty days exactly the second; an epoch not behind the list\'s own is just ended', () => {
    const edge = waitOverByAge(term([[2000 - 119, 1, 1], [2000 - 120, 2, 1]]))!;
    expect(edge.bands.map((b) => b.nam)).toEqual([1, 2, 0, 0]);
    // marked as passed at the list's own epoch, or after it: zero epochs ago, never a made-up age
    const now = waitOverByAge(term([[2000, 5, 1], [2003, 6, 1]]))!;
    expect(now.bands.map((b) => b.nam)).toEqual([11, 0, 0, 0]);
  });

  it('a longer epoch makes the same epochs older', () => {
    const twelve = waitOverByAge(term([[2000 - 100, 4, 1]], { epochSec: 2 * SIX_HOURS }))!;
    expect(twelve.bands.map((b) => b.nam)).toEqual([0, 4, 0, 0]);
    expect(waitOverByAge(term([[2000 - 100, 4, 1]]))!.bands.map((b) => b.nam)).toEqual([4, 0, 0, 0]);
  });

  it('states no age without a measured epoch length, and nothing when nothing is past its wait', () => {
    for (const epochSec of [null, undefined, 0, -1, Number.NaN]) expect(waitOverByAge(term([[1900, 5, 1]], { epochSec: epochSec as any })), String(epochSec)).toBeNull();
    expect(waitOverByAge(term([[2010, 5, 1, false]]))).toBeNull();
    expect(waitOverByAge(term([[1900, 0, 0]]))).toBeNull();
    expect(waitOverByAge(null)).toBeNull();
    expect(waitOverByAge(undefined)).toBeNull();
  });

  it('says the epoch length in words', () => {
    expect(epochWords(21_617)).toBe('about 6.0 hours');
    expect(epochWords(43_200)).toBe('about 12.0 hours');
    expect(epochWords(1_800)).toBe('about 30 minutes');
  });

  it('the Supply tab draws it only from the chain\'s own list, says the ages are counted, and judges no wallet', () => {
    const src = readFileSync(new URL('../web/src/screens/supply/Unlocks.tsx', import.meta.url), 'utf8');
    expect(src).toContain("const over = wall.fromChain && termStamp && termStamp.status !== 'missing' ? waitOverByAge(data.unbondTermStructure) : null;");
    // the epoch length is said once: in the words it was measured with when there are any, else as its length
    expect(src).toContain('The ages are counted, not read: the epochs since each wait ended, at {over.epochSecSource ?? `${epochWords(over.epochSec)} an epoch`}.');
    expect(src).toContain('Whether any of this NAM will be withdrawn is not known.');
    expect(src).toContain("{ label: 'NAM past its wait, by how long ago the wait ended', p: derive([termStamp], 'the epochs since each wait ended x the measured epoch length') }");
  });
});

import { app } from '../worker/src/api';
import { BOND_LISTING_SERIES_SOURCE, SERIES_KEYS } from '../worker/src/series-api';
import { testD1, insert } from './d1-sqlite';
import type { SeriesResponse } from '../shared/types';

describe('the two unstaking sums as served series', () => {
  const NOW = Date.UTC(2026, 10, 2, 12, 0);
  const H = 3_600_000;

  it('are served from the stored readings of each bond listing, as NAM, with the chain\'s listing as their source', () => {
    for (const key of ['stake.withdrawable_nam', 'stake.unbonding_nam']) {
      expect(SERIES_KEYS[key], key).toMatchObject({ unit: 'nam', agg: 'last', sparse: false, source: BOND_LISTING_SERIES_SOURCE });
    }
    expect(SERIES_KEYS['stake.withdrawable_nam'].startNote('1 Nov 2026')).toContain('whose unstaking wait is over and that was not withdrawn');
    expect(SERIES_KEYS['stake.unbonding_nam'].startNote('1 Nov 2026')).toContain('still in its unstaking wait');
  });

  it('GET /api/series answers each one\'s own readings, and no point for an hour with no listing', async () => {
    const db = testD1();
    insert(db, 'metrics', [
      { ts: NOW - 5 * H + 600_000, key: 'stake.withdrawable_nam', value: 36_500_000 },
      { ts: NOW - 2 * H + 600_000, key: 'stake.withdrawable_nam', value: 36_591_975.8 },
      { ts: NOW - 2 * H + 600_000, key: 'stake.unbonding_nam', value: 61_990 },
    ]);
    const get = async (key: string) => {
      const res = await app.request(`/api/series?key=${key}&step=1h&from=${NOW - 6 * H}&at=${NOW}`, {}, { DB: db } as any);
      expect(res.status, key).toBe(200);
      return (await res.json()) as SeriesResponse;
    };
    const over = await get('stake.withdrawable_nam');
    expect(over.points.map((p) => p.v)).toEqual([36_500_000, 36_591_975.8]);
    expect(over.unit).toBe('nam');
    const still = await get('stake.unbonding_nam');
    expect(still.points.map((p) => p.v)).toEqual([61_990]);
  });
});
