// The addresses active a day, stored since the daily writer shipped (series.ts dayAggregates writes
// active.namada_daily and active.osmosis_daily) and served by nothing until now. GET /api/series serves both, one
// series a chain: each chain's count is that chain's own record, so the route gives two figures and adds nothing.
import { describe, it, expect } from 'vitest';
import { app } from '../worker/src/api';
import { SERIES_KEYS } from '../worker/src/series-api';
import { testD1, insert } from './d1-sqlite';
import type { SeriesResponse } from '../shared/types';

const D = 86_400_000;
const NOW = Date.UTC(2026, 10, 10, 12, 0);
const day = (n: number) => Date.UTC(2026, 10, 10 - n);

describe('the addresses active a day', () => {
  it('are two served series, a count a day, each chain on its own', () => {
    for (const key of ['active.namada_daily', 'active.osmosis_daily']) {
      expect(SERIES_KEYS[key], key).toMatchObject({ unit: 'count', native: '1d', sparse: false, source: 'D1 flow index (daily)' });
    }
    // only the Osmosis count rests on the stored Osmosis record
    expect(SERIES_KEYS['active.namada_daily'].osmosisRecord).toBe(false);
    expect(SERIES_KEYS['active.osmosis_daily'].osmosisRecord).toBe(true);
    expect(SERIES_KEYS['active.namada_daily'].startNote('1 Sep 2026')).toContain('Addresses on Namada that sent or received NAM');
    expect(SERIES_KEYS['active.osmosis_daily'].startNote('1 Sep 2026')).toContain('Addresses on Osmosis that sent or received NAM');
  });

  it('GET /api/series answers the stored days of one chain, and only that chain\'s', async () => {
    const db = testD1();
    insert(db, 'metrics', [
      { ts: day(3), key: 'active.namada_daily', value: 41 },
      { ts: day(2), key: 'active.namada_daily', value: 37 },
      { ts: day(1), key: 'active.namada_daily', value: 52 },
      { ts: day(2), key: 'active.osmosis_daily', value: 9 },
      { ts: day(1), key: 'active.osmosis_daily', value: 12 },
    ]);
    const get = async (key: string) => {
      const res = await app.request(`/api/series?key=${key}&step=1d&from=${day(5)}&at=${NOW}`, {}, { DB: db } as any);
      expect(res.status, key).toBe(200);
      return (await res.json()) as SeriesResponse;
    };
    const namada = await get('active.namada_daily');
    expect(namada.points.map((p) => [p.t, p.v])).toEqual([[day(3), 41], [day(2), 37], [day(1), 52]]);
    const osmosis = await get('active.osmosis_daily');
    expect(osmosis.points.map((p) => [p.t, p.v])).toEqual([[day(2), 9], [day(1), 12]]);
    expect(namada.points.every((p) => p.t % D === 0)).toBe(true);
  });

  it('a chain with no stored day answers no point, never a zero', async () => {
    const res = await app.request(`/api/series?key=active.namada_daily&step=1d&from=${day(5)}&at=${NOW}`, {}, { DB: testD1() } as any);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SeriesResponse;
    expect(body.points).toEqual([]);
    expect(body.prov.status).not.toBe('live');
  });
});
