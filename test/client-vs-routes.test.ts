// The Trade client's exact requests against the series routes being built (worker/src/series-api.ts) on the D1 stand-in:
// every query string the screen sends is accepted, and every answer goes through the screen's own adapters.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { app } from '../worker/src/api';
import { testD1 } from './d1-sqlite';
import { seriesParams, tradesParams } from '../web/src/api';
import { seriesWindow, pointsOf, bandOf, barsOf, flatOf, onPriceAxis, startOf, changeCells, QUOTED_WINDOWS, POOL_WINDOWS, groupsOfPage, tapeOf } from '../web/src/screens/trade/series';
import type { PairsResponse, PriceChangesResponse, SeriesResponse, TradesResponse, VolumeResponse } from '../shared/types';

const NOW = Date.UTC(2026, 9, 20, 22, 10);
const H = 3_600_000;
afterEach(() => vi.useRealTimers());
const call = async (db: any, path: string) => {
  const res = await app.request(path, {}, { DB: db } as any);
  return { status: res.status, body: (await res.json()) as any };
};

describe('the Trade client against the series routes (D1 stand-in)', () => {
  it('every chart request of every range is accepted, live and rewound, and the answers adapt', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const db = testD1();
    // a few rows so the answers are not all empty
    const ins = db.raw.prepare('INSERT OR REPLACE INTO metrics (ts, key, value) VALUES (?, ?, ?)');
    for (let i = 0; i < 48; i++) ins.run(NOW - i * H - 2000, 'price.usd', 0.0011 + i * 1e-6);
    for (const h of [2, 3, 9]) {
      const t = Math.floor(NOW / H) * H - h * H;
      ins.run(t, 'price.swap_1h', 0.00115);
      ins.run(t, 'dex.swaps_1h.nam', 500);
      ins.run(t, 'dex.swaps_1h.buy_nam', 400);
      ins.run(t, 'dex.swaps_1h.sell_nam', 100);
    }
    const seen: string[] = [];
    for (const asOf of [null, NOW - 3 * H]) {
      for (const range of ['24h', '30d', '90d', '1y', 'all'] as const) {
        const w = seriesWindow(range, asOf ?? NOW);
        const keys = ['price.swap_1h', 'price.usd', range === '90d' || range === '1y' || range === 'all' ? 'price.pool_1h' : 'dex.swaps_1h.nam'];
        for (const key of keys) {
          const path = `/api/series?${seriesParams({ key, from: w.from, step: w.step, asOf })}`;
          const r = await call(db, path);
          seen.push(`${r.status} ${path}`);
          expect(r.status, `${path}: ${JSON.stringify(r.body).slice(0, 200)}`).toBe(200);
          const s = r.body as SeriesResponse;
          expect(s.step).toBe(w.step);
          if (key === 'dex.swaps_1h.nam') {
            expect(s.unit).toBe('nam');
            expect(barsOf(s).every((b) => b.nam >= 0)).toBe(true);
          } else expect(onPriceAxis(s)).toBe(true);
          pointsOf(s);
          bandOf(s);
          flatOf(s);
          expect(startOf(key, s).what).toBe(key);
        }
      }
      // the daily bars of "How much trades against how little"
      for (const key of ['dex.swaps_1h.buy_nam', 'dex.swaps_1h.sell_nam']) {
        const from = new Date((asOf ?? NOW) - 14 * 86_400_000).toISOString().slice(0, 10);
        const r = await call(db, `/api/series?${seriesParams({ key, from, step: '1d', asOf })}`);
        expect(r.status).toBe(200);
      }
    }
    // the hourly volume over 24 h: 3 bars
    const w = seriesWindow('24h', NOW);
    const bars = barsOf((await call(db, `/api/series?${seriesParams({ key: 'dex.swaps_1h.nam', from: w.from, step: w.step })}`)).body);
    expect(bars.length).toBe(3);
    const band = bandOf((await call(db, `/api/series?${seriesParams({ key: 'price.usd', from: w.from, step: w.step })}`)).body);
    console.log(`chart requests accepted: ${seen.length}; quoted band steps from the stand-in: ${band.length}`);
  });

  it('the panels: changes, volume, pairs and the tape (with the maker filter) answer and adapt', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const db = testD1();
    const ch = await call(db, '/api/series/changes');
    expect(ch.status).toBe(200);
    const c = ch.body as PriceChangesResponse;
    const q = changeCells(c.quoted, QUOTED_WINDOWS);
    expect(q.shown.length + q.notYet.words.length).toBe(5);
    expect(changeCells(c.pool, POOL_WINDOWS).notYet.words.length).toBeGreaterThanOrEqual(0);
    const vol = await call(db, '/api/series/volume');
    expect(vol.status).toBe(200);
    expect(typeof (vol.body as VolumeResponse).definition).toBe('string');
    const pairs = await call(db, '/api/series/pairs');
    expect([200]).toContain(pairs.status);
    expect(Array.isArray((pairs.body as PairsResponse).pairs)).toBe(true);
    for (const qs of [tradesParams({ limit: 60 }), tradesParams({ limit: 60, maker: 'osmo1sqdwxh2tlvpmsh7rapjmtmyeg4pn4hu494v9mf' }), tradesParams({ limit: 60, asOf: NOW - H })]) {
      const t = await call(db, `/api/series/trades?${qs}`);
      expect(t.status, `${qs}: ${JSON.stringify(t.body).slice(0, 200)}`).toBe(200);
      const page = t.body as TradesResponse;
      expect(groupsOfPage(page).flatMap((g) => g.ids).length).toBe(page.rows.length);
      tapeOf(page, [], { foldMs: page.foldMs, max: 20 });
    }
  });
});
