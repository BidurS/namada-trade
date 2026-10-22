// Group D: /api/alerts/recent reads at the site's own alert sizes and at most ALERTS_SINCE_MAX_MS back.
import { describe, it, expect } from 'vitest';
import { testD1, insert, type TestD1 } from './d1-sqlite';
import { DEFAULT_THRESHOLDS } from '../shared/alerts';
import { lastAlertBefore } from '../worker/src/analytics';
import { app, ALERTS_SINCE_MAX_MS } from '../worker/src/api';
import type { AlertsRecentResponse } from '../shared/types';

const NOW = Date.UTC(2026, 9, 17, 12);
const D = 86_400_000;
const CAP = ALERTS_SINCE_MAX_MS;
const row = (id: string, ts: number, chain: string, kind: string, amount: number) => ({
  id, chain, height: 1, ts, tx_hash: id.toUpperCase(), kind, from_addr: chain === 'osmosis' ? 'osmo1a' : 'tnam1qgqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqc8j2fp', to_addr: 'tnam1qxuser', amount_num: amount, meta: null,
});

/** Every statement the route prepares, with what it was bound to. */
function spied(db: TestD1) {
  const seen: { sql: string; params: unknown[] }[] = [];
  const wrapped = { ...db, prepare: (sql: string) => { const s = db.prepare(sql); return { ...s, sql, bind: (...p: unknown[]) => { seen.push({ sql, params: p }); return s.bind(...p); } } as any; }, batch: db.batch };
  return { wrapped, seen };
}
const get = async (db: any, qs: string) => app.request(`/api/alerts/recent?${qs}`, {}, { DB: db } as any) as Promise<Response>;

describe('GET /api/alerts/recent: bounded work per request (group D)', () => {
  it('refuses a caller alert size (400, no D1 read), on each of the five', async () => {
    const db = testD1();
    // 5,000 flows below every size, and nothing an alert: the walk the review saw (every flow on flows_ts)
    insert(db, 'flows', Array.from({ length: 5000 }, (_, i) => row(`f${i}`, NOW - 1 - i * 60_000, 'osmosis', 'buy', 500)));
    for (const k of Object.keys(DEFAULT_THRESHOLDS)) {
      db.queries = 0;
      const r = await get(db, `at=${NOW}&${k}=1e12`);
      expect(r.status, k).toBe(400);
      expect(db.queries, k).toBe(0);
    }
    // the app's own request (no size) is answered as before
    expect((await get(db, `at=${NOW}`)).status).toBe(200);
  });

  it('reads at most ALERTS_SINCE_MAX_MS back and says from when; an older hit is still `last`', async () => {
    const db = testD1();
    insert(db, 'flows', [row('old', NOW - 40 * D, 'namada', 'bond', 2_999_716)]);
    const { wrapped, seen } = spied(db);
    const body = (await (await get(wrapped, `at=${NOW}&since=1`)).json()) as AlertsRecentResponse;
    expect(body.since).toBe(NOW - CAP);
    expect(body.hits).toEqual([]);
    expect(body.last).toMatchObject({ flowId: 'old' }); // the empty state's "The last one: …"
    const window = seen.find((s) => /f\.ts >= \? AND f\.ts < \?/.test(s.sql))!;
    expect(window.params[0]).toBe(NOW - CAP);
    // a newer hit inside the window is listed, the old one is not
    insert(db, 'flows', [row('recent', NOW - 10 * D, 'namada', 'bond', 2_000_000)]);
    const busy = (await (await get(db, `at=${NOW}&since=1`)).json()) as AlertsRecentResponse;
    expect(busy.hits.map((h) => h.flowId)).toEqual(['recent']);
  });

  it('answers the windows the app sends exactly as asked (24 h default, 7 days, the 30-day fallback, a recent last visit)', async () => {
    const db = testD1();
    insert(db, 'flows', [row('h', NOW - 20 * D, 'namada', 'bond', 2_000_000)]);
    expect(((await (await get(db, `at=${NOW}`)).json()) as AlertsRecentResponse).since).toBe(NOW - D);
    for (const since of [NOW - 7 * D, NOW - 30 * D, NOW - 30 * D - 3_600_000, NOW - 5 * 3_600_000 + 123]) {
      const b = (await (await get(db, `at=${NOW}&since=${since}`)).json()) as AlertsRecentResponse;
      expect(b.since).toBe(since);
    }
    const wide = (await (await get(db, `at=${NOW}&since=${NOW - 30 * D}`)).json()) as AlertsRecentResponse;
    expect(wide.hits.map((h) => h.flowId)).toEqual(['h']);
  });

  it('a rule switched off (an unreachable size) is still never the last one (moved from the API test to the search itself)', async () => {
    const db = testD1();
    insert(db, 'flows', [row('old', NOW - 16 * D, 'namada', 'bond', 2_999_716), row('sell', NOW - 3_600_000, 'osmosis', 'sell', 20_000)]);
    expect(await lastAlertBefore(db as any, NOW, { ...DEFAULT_THRESHOLDS, bigSwap: Number.MAX_SAFE_INTEGER })).toMatchObject({ flowId: 'old' });
  });
});
