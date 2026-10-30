// Group D: /api/alerts/recent reads at the site's own alert sizes and at most ALERTS_SINCE_MAX_MS back.
// Stage 1 (scale plan item 6): the app asks for one of three windows every reader shares, keeps the hits after its own
// last visit in the browser, and the search for the last alert walks at most LAST_ALERT_SCAN moves.
import { describe, it, expect, vi } from 'vitest';
import { testD1, insert, type TestD1 } from './d1-sqlite';
import { DEFAULT_THRESHOLDS } from '../shared/alerts';
import { ALERTS_READ_MAX, LAST_ALERT_SCAN, lastAlertBefore } from '../worker/src/analytics';
import { app, ALERTS_SINCE_MAX_MS } from '../worker/src/api';
import { cacheKeyUrl, isReplay } from '../worker/src/http';
import { fetchAlertsRecent } from '../web/src/api';
import type { AlertsRecentResponse } from '../shared/types';

const NOW = Date.UTC(2026, 9, 17, 12);
const D = 86_400_000;
const H = 3_600_000;
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

describe('GET /api/alerts/recent: one shared window per span, the reader’s own start kept in the browser (Stage 1)', () => {
  it('the windows: 24 hours left out, days=7 and days=31; any other spelling, or days with since, is refused unread', async () => {
    const db = testD1();
    insert(db, 'flows', [row('h3', NOW - 3 * D, 'namada', 'bond', 2_000_000), row('h20', NOW - 20 * D, 'namada', 'bond', 2_000_000)]);
    const at = async (qs: string) => (await (await get(db, `at=${NOW}${qs}`)).json()) as AlertsRecentResponse;
    expect((await at('')).since).toBe(NOW - D);
    expect((await at('&days=7')).since).toBe(NOW - 7 * D);
    expect((await at('&days=7')).hits.map((h) => h.flowId)).toEqual(['h3']);
    expect((await at('&days=31')).since).toBe(NOW - 31 * D);
    expect((await at('&days=31')).hits.map((h) => h.flowId)).toEqual(['h3', 'h20']);
    for (const bad of ['1', '2', '07', '7.0', '30', 'week', '-7']) {
      db.queries = 0;
      const r = await get(db, `at=${NOW}&days=${bad}`);
      expect(r.status, bad).toBe(400);
      expect(db.queries, bad).toBe(0);
    }
    expect((await get(db, `at=${NOW}&days=7&since=${NOW - D}`)).status).toBe(400);
  });

  it('a window is one cache key, never a rewound read; a since is still limited as one', () => {
    expect(isReplay(new URL('https://namada.trade/api/alerts/recent'))).toBe(false);
    expect(isReplay(new URL('https://namada.trade/api/alerts/recent?days=7'))).toBe(false);
    expect(isReplay(new URL('https://namada.trade/api/alerts/recent?days=31'))).toBe(false);
    expect(isReplay(new URL(`https://namada.trade/api/alerts/recent?since=${NOW - D}`))).toBe(true);
    expect(cacheKeyUrl(new URL('https://namada.trade/api/alerts/recent?days=7&r=1'))).toBe('https://namada.trade/api/alerts/recent?days=7');
  });

  it('the app sends no start: every tab with a last visit in the same span asks the same URL and keeps its own hits', async () => {
    const db = testD1();
    insert(db, 'flows', [row('h1', NOW - 2 * H, 'osmosis', 'sell', 20_000), row('h2', NOW - 10 * H, 'osmosis', 'sell', 20_000), row('h9', NOW - 9 * D, 'namada', 'bond', 2_000_000)]);
    const urls: string[] = [];
    // the server as the browser reaches it, every answer read at NOW (the app's own `at` is null: live)
    vi.stubGlobal('fetch', async (u: RequestInfo | URL) => {
      const url = new URL(String(u), 'https://namada.trade');
      urls.push(`${url.pathname}${url.search}`);
      return app.request(`${url.pathname}${url.search}${url.search ? '&' : '?'}at=${NOW}`, {}, { DB: db } as any);
    });
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    try {
      // three last visits in the last 24 hours: one URL, three answers
      const a = await fetchAlertsRecent(null, NOW - 3 * H);
      const b = await fetchAlertsRecent(null, NOW - 11 * H);
      const c = await fetchAlertsRecent(null, NOW - 20 * H);
      expect(a.hits.map((h) => h.flowId)).toEqual(['h1']);
      expect(b.hits.map((h) => h.flowId)).toEqual(['h1', 'h2']);
      expect(c.since).toBe(NOW - 20 * H);
      // a last visit 3 days ago: the 7-day window, from then on; 10 days ago: the 31-day window, the bond 9 days ago too
      expect((await fetchAlertsRecent(null, NOW - 3 * D)).hits.map((h) => h.flowId)).toEqual(['h1', 'h2']);
      expect((await fetchAlertsRecent(null, NOW - 10 * D)).hits.map((h) => h.flowId)).toEqual(['h1', 'h2', 'h9']);
      // 40 days ago: the window starts 31 days back, and the answer says so
      expect((await fetchAlertsRecent(null, NOW - 40 * D)).since).toBe(NOW - 31 * D);
      expect(urls.some((u) => /since=/.test(u))).toBe(false);
      expect(urls).toEqual(['/api/alerts/recent', '/api/alerts/recent', '/api/alerts/recent', '/api/alerts/recent?days=7', '/api/alerts/recent?days=31', '/api/alerts/recent?days=31']);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('the Alerts page\'s 24 hours and 7 days ask for that window, measured from their end, however late the request goes (a real clock)', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (u: RequestInfo | URL) => {
      const url = new URL(String(u), 'https://namada.trade');
      urls.push(`${url.pathname}${url.search}`);
      return new Response(JSON.stringify({ since: Date.now() - D, until: Date.now(), hits: [] }), { headers: { 'content-type': 'application/json' } });
    });
    try {
      // the page computes its window, then the request leaves a little later
      const end = Date.now() - 5;
      await fetchAlertsRecent(null, end - D, end);
      await fetchAlertsRecent(null, end - 7 * D, end);
      // a last visit has no end of its own: the span runs to now, so a visit just over a day ago gets the 7-day window
      await fetchAlertsRecent(null, end - D);
      // rewound, the span is measured from the rewind time
      await fetchAlertsRecent(NOW, NOW - D, Date.now());
      expect(urls).toEqual(['/api/alerts/recent', '/api/alerts/recent?days=7', '/api/alerts/recent?days=7', `/api/alerts/recent?at=${NOW}`]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('the window answered starts later than the page\'s by the moments between: the answer\'s since says where', async () => {
    const db = testD1();
    insert(db, 'flows', [row('edge', NOW - D + 2, 'osmosis', 'sell', 20_000), row('in', NOW - H, 'osmosis', 'sell', 20_000)]);
    vi.stubGlobal('fetch', async (u: RequestInfo | URL) => {
      const url = new URL(String(u), 'https://namada.trade');
      return app.request(`${url.pathname}${url.search}${url.search ? '&' : '?'}at=${NOW + 5}`, {}, { DB: db } as any);
    });
    try {
      // the page's window ends 5 ms before the server reads it: the hit 2 ms after the page's start is before the window's
      const r = await fetchAlertsRecent(null, NOW - D, NOW);
      expect(r.since).toBe(NOW + 5 - D);
      expect(r.hits.map((h) => h.flowId)).toEqual(['in']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a window holding more moves than one read takes starts after the oldest read, so its hits are all of [since, until)', async () => {
    const db = testD1();
    insert(db, 'flows', Array.from({ length: ALERTS_READ_MAX + 20 }, (_, i) => row(`s${i}`, NOW - H - i * 60_000, 'osmosis', 'sell', 20_000)));
    const body = (await (await get(db, `at=${NOW}&days=31`)).json()) as AlertsRecentResponse;
    const oldestRead = NOW - H - (ALERTS_READ_MAX - 1) * 60_000;
    expect(body.since).toBe(oldestRead + 1);
    expect(body.hits).toHaveLength(ALERTS_READ_MAX - 1);
    expect(body.hits.every((h) => h.ts >= body.since && h.ts < body.until)).toBe(true);
    // under the read's size the window is the one asked
    const few = testD1();
    insert(few, 'flows', [row('one', NOW - H, 'osmosis', 'sell', 20_000)]);
    expect(((await (await get(few, `at=${NOW}&days=31`)).json()) as AlertsRecentResponse).since).toBe(NOW - 31 * D);
  });
});

describe('the last alert of any age walks at most LAST_ALERT_SCAN moves (own audit 2026-10-29, Low 24)', () => {
  it('a search no move matches stops at the end of its walk and gives up (not known), never "none on record"', async () => {
    const db = testD1();
    // the walk's moves, all below every size, then a hit older than the walk reaches
    insert(db, 'flows', Array.from({ length: LAST_ALERT_SCAN + 50 }, (_, i) => row(`b${i}`, NOW - 1 - i * 60_000, 'osmosis', 'buy', 500)));
    insert(db, 'flows', [row('far', NOW - 1 - (LAST_ALERT_SCAN + 100) * 60_000, 'namada', 'bond', 2_000_000)]);
    const { wrapped, seen } = spied(db);
    expect(await lastAlertBefore(wrapped as any, NOW, DEFAULT_THRESHOLDS)).toBeUndefined();
    // a wallet's own sizes (the test message) that nothing reaches: the same bound
    expect(await lastAlertBefore(db as any, NOW, { ibcInventory: 1e15, unlock: 1e15, bigSwap: 1e15, unshield: 1e15, bond: 1e15 })).toBeUndefined();
    // every page is bounded below by the walk's end (NOT_BELOW) and none reads by an offset
    const pages = seen.filter((s) => /f\.amount_num >= \?/.test(s.sql));
    expect(pages.length).toBeGreaterThan(0);
    expect(pages.every((s) => /NOT \(f\.ts = \? AND \(f\.height < \?/.test(s.sql) && !/OFFSET/.test(s.sql))).toBe(true);
    // with a longer walk the old hit is found
    expect(await lastAlertBefore(db as any, NOW, DEFAULT_THRESHOLDS, 5, 100, LAST_ALERT_SCAN + 200)).toMatchObject({ flowId: 'far' });
  });

  it('fewer moves than the walk: the oldest is reached, so none found is null; the rules decide as before', async () => {
    const db = testD1();
    insert(db, 'flows', Array.from({ length: 300 }, (_, i) => row(`b${i}`, NOW - 1 - i * 60_000, 'osmosis', 'buy', 500)));
    expect(await lastAlertBefore(db as any, NOW, DEFAULT_THRESHOLDS)).toBeNull();
    insert(db, 'flows', [row('hit', NOW - 1 - 250 * 60_000 - 30_000, 'osmosis', 'sell', 20_000)]);
    expect(await lastAlertBefore(db as any, NOW, DEFAULT_THRESHOLDS)).toMatchObject({ flowId: 'hit' });
  });

  it('the pages walk the moves once: each goes on after the last row of the one before', async () => {
    const db = testD1();
    // 12 rejected candidates (unshields into a protocol account), then a hit, 5 to a page
    insert(db, 'flows', [
      row('hit', NOW - 10 * D, 'osmosis', 'buy', 50000),
      ...Array.from({ length: 12 }, (_, i) => ({ ...row(`rej${i}`, NOW - i * 60000, 'namada', 'unshield', 90000), to_addr: 'tnam1qgqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqc8j2fp' })),
    ]);
    const { wrapped, seen } = spied(db);
    expect(await lastAlertBefore(wrapped as any, NOW, DEFAULT_THRESHOLDS, 5, 5)).toMatchObject({ flowId: 'hit' });
    const pages = seen.filter((s) => /f\.amount_num >= \?/.test(s.sql));
    expect(pages).toHaveLength(3);
    // the second page starts after rej5, the fifth before NOW (rej0, at NOW itself, is not before it): its time, height and id
    expect(pages[1].params.slice(-6, -1)).toEqual([NOW - 5 * 60000, NOW - 5 * 60000, 1, 1, 'rej5']);
  });
});
