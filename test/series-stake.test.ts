// Who stakes and with whom, as served series (review item 6; owner, 2026-11-11: "Lets go ahead"). The hourly writer has
// stored these at every complete listing of the chain's bonds since the listing shipped (series.ts stakeListingStmts)
// and the daily digest states two of them; /api/series now answers each one's own readings. A count is a count, a
// share is a percent of the chain's total stake, and a listing read with no total has no share: a gap, never 0.
import { describe, it, expect } from 'vitest';
import { app } from '../worker/src/api';
import { BOND_LISTING_SERIES_SOURCE, SERIES_KEYS, STAKE_SHARE_GAP } from '../worker/src/series-api';
import { stakeListingStmts, stakeStructure } from '../worker/src/series';
import { testD1, insert } from './d1-sqlite';
import type { SeriesResponse } from '../shared/types';

const NOW = Date.UTC(2026, 10, 2, 12, 0);
const H = 3_600_000;
const COUNTS = ['stake.validators', 'stake.stakers', 'stake.stakers_1m_plus'] as const;
const SHARES = ['stake.top10_pct', 'stake.share_1m_plus'] as const;

describe('the staking counts and shares as served series', () => {
  it('each is served from the bond listing\'s own readings: the counts as counts, the shares as percent', () => {
    for (const key of COUNTS) expect(SERIES_KEYS[key], key).toMatchObject({ unit: 'count', agg: 'last', sparse: false, native: '1h', source: BOND_LISTING_SERIES_SOURCE, backfilled: false });
    for (const key of SHARES) expect(SERIES_KEYS[key], key).toMatchObject({ unit: 'pct', agg: 'last', sparse: false, native: '1h', source: BOND_LISTING_SERIES_SOURCE, gapWhy: STAKE_SHARE_GAP });
    expect(SERIES_KEYS['stake.validators'].startNote('1 Nov 2026')).toBe('Validators with NAM staked to them, counted at each complete listing of the chain\'s bonds since 1 Nov 2026. No listing of every bond exists before then.');
    expect(SERIES_KEYS['stake.stakers'].startNote('1 Nov 2026')).toContain('Addresses with NAM staked, counted at each complete listing');
    expect(SERIES_KEYS['stake.stakers_1m_plus'].startNote('1 Nov 2026')).toContain('Addresses with 1,000,000 NAM or more staked');
    expect(SERIES_KEYS['stake.top10_pct'].startNote('1 Nov 2026')).toContain('staked with the ten validators holding the most, in percent');
    expect(SERIES_KEYS['stake.share_1m_plus'].startNote('1 Nov 2026')).toContain('staked by addresses with 1,000,000 NAM or more staked, in percent');
    // a share says what its missing point means
    for (const key of SHARES) expect(SERIES_KEYS[key].startNote('1 Nov 2026'), key).toContain('A listing read when the chain\'s total stake was not read has no share.');
  });

  it('every key served here is one the writer stores, under the same name', () => {
    const listing = { sources: new Map([['tnam1qa', { bondedBase: 2_000_000_000_000n, delegations: [{ validator: 'tnam1qv', amountNam: 2_000_000 }] }]]) } as any;
    const written = stakeListingStmts(NOW, stakeStructure(listing, 4_000_000), { unbondingNam: 0, withdrawableNam: 0 } as any).map((s) => s.params[1]);
    for (const key of [...COUNTS, ...SHARES]) expect(written, key).toContain(key);
  });

  it('GET /api/series answers each one\'s own readings; a listing with no total leaves a share without a point, not a 0', async () => {
    const db = testD1();
    const at = (h: number) => NOW - h * H + 600_000;
    insert(db, 'metrics', [
      // two listings: the older one read in a tick with no total stake, so it stored the counts and no share
      { ts: at(5), key: 'stake.validators', value: 245 }, { ts: at(5), key: 'stake.stakers', value: 65_100 }, { ts: at(5), key: 'stake.stakers_1m_plus', value: 31 },
      { ts: at(2), key: 'stake.validators', value: 246 }, { ts: at(2), key: 'stake.stakers', value: 65_204 }, { ts: at(2), key: 'stake.stakers_1m_plus', value: 32 },
      { ts: at(2), key: 'stake.top10_pct', value: 41.25 }, { ts: at(2), key: 'stake.share_1m_plus', value: 58.5 },
    ]);
    const get = async (key: string) => {
      const res = await app.request(`/api/series?key=${key}&step=1h&from=${NOW - 6 * H}&at=${NOW}`, {}, { DB: db } as any);
      expect(res.status, key).toBe(200);
      return (await res.json()) as SeriesResponse;
    };
    expect((await get('stake.validators')).points.map((p) => p.v)).toEqual([245, 246]);
    expect((await get('stake.stakers')).points.map((p) => p.v)).toEqual([65_100, 65_204]);
    expect((await get('stake.stakers_1m_plus')).points.map((p) => p.v)).toEqual([31, 32]);
    const top = await get('stake.top10_pct');
    expect(top.unit).toBe('pct');
    expect(top.points.map((p) => p.v)).toEqual([41.25]);
    expect(top.points.some((p) => p.v === 0)).toBe(false);
    expect((await get('stake.share_1m_plus')).points.map((p) => p.v)).toEqual([58.5]);
  });
});
