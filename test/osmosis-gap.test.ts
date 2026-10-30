// The known hole in the stored Osmosis record (scale plan Stage 1 item 2, the stamp part; shared/osmosis-gap.ts): before
// 20 Oct 2026 22:00 UTC the stored history misses at least 350 pool transactions (the pool completeness check of
// 2026-10-29). Every Osmosis figure whose window reaches back before then says so in its stamp, in one sentence kept in
// one place; a window wholly after it says nothing; no figure changes for it. The real routes over the sqlite D1
// stand-in; no test reaches the network.
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { app } from '../worker/src/api';
import { testD1, type TestD1 } from './d1-sqlite';
import { OSMOSIS_GAP_NOTE, OSMOSIS_GAP_UNTIL, osmosisGapCounts, osmosisGapWindows, reachesOsmosisGap, withOsmosisGap } from '../shared/osmosis-gap';
import { PRICED_KEY, routerCapNote } from '../worker/src/pool-sizes';
import type { OrderflowResponse, Overview, Pressure, SeriesResponse, TradesResponse, VolumeResponse } from '../shared/types';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const H = 3_600_000, D = 86_400_000;
const CUT = OSMOSIS_GAP_UNTIL;
/** The clock at `t` (a second call moves it). */
const at = (t: number) => { vi.useFakeTimers({ now: t, toFake: ['Date'] }); vi.setSystemTime(t); };
const get = async <T,>(db: TestD1, path: string) => (await (await app.request(path, {}, { DB: db } as any)).json()) as T;
const osmo = (i: number) => `osmo1${String(i).padStart(38, '0')}`;

/** Osmosis buys and sells, one every `everyH` hours from `from` to `to`, 1,000 NAM at $0.001 each, alternating sides and makers. */
function trades(db: TestD1, from: number, to: number, everyH = 12) {
  db.raw.exec('BEGIN');
  const st = db.raw.prepare(`INSERT INTO flows (id, chain, height, ts, tx_hash, kind, from_addr, to_addr, amount_num, counter_denom, counter_amount, pool_id, price_usd, value_usd, meta)
    VALUES (?, 'osmosis', ?, ?, ?, ?, ?, ?, 1000, 'USDC', 1, '3005', 0.001, 1, ?)`);
  let i = 0;
  for (let t = from; t <= to; t += everyH * H, i++) {
    const kind = i % 2 ? 'sell' : 'buy', maker = osmo(i % 3);
    st.run(`osmosis:T${i}:0`, 70_000_000 + i, t, `T${i}`, kind, kind === 'sell' ? maker : null, kind === 'buy' ? maker : null, JSON.stringify({ trader: maker }));
  }
  db.raw.exec('COMMIT');
  return i;
}

describe('the gap sentence', () => {
  it('is one sentence, said once, for a window starting before 20 Oct 2026 22:00 UTC only', () => {
    expect(CUT).toBe(Date.parse('2026-10-20T22:00:00Z'));
    expect(OSMOSIS_GAP_NOTE).toBe('The Osmosis record before 20 Oct 2026 22:00 UTC is missing at least 350 pool transactions.');
    expect(reachesOsmosisGap(CUT - 1)).toBe(true);
    expect(reachesOsmosisGap(CUT)).toBe(false);
    expect(reachesOsmosisGap(null)).toBe(false);
    const p = { source: 'x', at: 1, status: 'live' as const };
    expect(withOsmosisGap(p, CUT)).toBe(p);
    expect(withOsmosisGap(p, CUT - 1)).toEqual({ ...p, note: OSMOSIS_GAP_NOTE });
    expect(withOsmosisGap(withOsmosisGap({ ...p, note: 'Read at 12:00.' }, CUT - 1), CUT - D)).toEqual({ ...p, note: `Read at 12:00. ${OSMOSIS_GAP_NOTE}` });
    expect(osmosisGapWindows(['30-day'])).toBe(`${OSMOSIS_GAP_NOTE} The 30-day window reaches back before then.`);
    expect(osmosisGapWindows(['24-hour', '7-day', '30-day'])).toBe(`${OSMOSIS_GAP_NOTE} The 24-hour, 7-day and 30-day windows reach back before then.`);
    expect(osmosisGapCounts('The makers\' trade counts')).toBe(`${OSMOSIS_GAP_NOTE} The makers' trade counts reach back before then.`);
  });
});

describe('the executed volume windows (/api/series/volume)', () => {
  it('ten days after the cut-off the 30-day window says so, its figures as stored; 31 days after, none does', async () => {
    const db = testD1();
    const n = trades(db, CUT - 40 * D, CUT + 40 * D);
    expect(n).toBeGreaterThan(100);
    at(CUT + 10 * D);
    const v = await get<VolumeResponse>(db, '/api/series/volume');
    expect(v.prov.note).toContain(`${OSMOSIS_GAP_NOTE} The 30-day window reaches back before then.`);
    expect(v.prov.note!.split(OSMOSIS_GAP_NOTE)).toHaveLength(2);
    // no number moves: 60 trades of 1,000 NAM in the 30 days (one every 12 hours), the 7 days' 14
    expect(v.windows.d30).toMatchObject({ nam: 60_000, buys: 30, sells: 30, usd: 60 });
    expect(v.windows.d7).toMatchObject({ nam: 14_000 });
    at(CUT + 3 * D);
    expect((await get<VolumeResponse>(db, '/api/series/volume')).prov.note).toContain(`${OSMOSIS_GAP_NOTE} The 7-day and 30-day windows reach back before then.`);
    at(CUT + 31 * D);
    const late = await get<VolumeResponse>(db, '/api/series/volume');
    expect(late.prov.note ?? '').not.toContain(OSMOSIS_GAP_NOTE);
    expect(late.windows.d30).toMatchObject({ nam: 60_000 });
  });
});

describe('the other Osmosis windows', () => {
  it('the order flow (/api/orderflow): a 30-day window reaching back says so, a day after the cut-off does not', async () => {
    const db = testD1();
    trades(db, CUT - 40 * D, CUT + 40 * D);
    at(CUT + 10 * D);
    const month = await get<OrderflowResponse>(db, '/api/orderflow?hours=720');
    expect(month.prov.note).toContain(OSMOSIS_GAP_NOTE);
    const day = await get<OrderflowResponse>(db, '/api/orderflow?hours=24');
    expect(day.prov.note ?? '').not.toContain(OSMOSIS_GAP_NOTE);
    expect(day.grossVolumeNam).toBe(3_000);
  });

  it('the pressure page (/api/pressure): the window\'s own figures say so from the window\'s start, what each receiver has left from 30 days before it', async () => {
    const db = testD1();
    trades(db, CUT - 40 * D, CUT + 60 * D);
    // a 7-day window from 3 days after the cut-off: the movers count only its trades, the receivers' sells reach back
    at(CUT + 10 * D);
    const p = await get<Pressure>(db, '/api/pressure?days=7');
    expect(p.movers.length).toBeGreaterThan(0);
    expect(p.coverageByChain!.osmosis.note ?? '').not.toContain(OSMOSIS_GAP_NOTE);
    expect(p.coverage.note ?? '').not.toContain(OSMOSIS_GAP_NOTE);
    expect(p.onDeckProv!.note).toContain(OSMOSIS_GAP_NOTE);
    expect(p.coverageByChain!.namada.note ?? '').not.toContain(OSMOSIS_GAP_NOTE);
    // a window that starts before the cut-off: the movers' stamp says so too
    at(CUT + 2 * D);
    const early = await get<Pressure>(db, '/api/pressure?days=7');
    expect(early.coverageByChain!.osmosis.note).toContain(OSMOSIS_GAP_NOTE);
    expect(early.coverage.note).toContain(OSMOSIS_GAP_NOTE);
    // 30 days and a window after the cut-off: nothing reaches back
    at(CUT + 40 * D);
    const later = await get<Pressure>(db, '/api/pressure?days=7');
    expect(later.coverageByChain!.osmosis.note ?? '').not.toContain(OSMOSIS_GAP_NOTE);
    expect(later.onDeckProv!.note ?? '').not.toContain(OSMOSIS_GAP_NOTE);
  });

  it('the trades tape (/api/series/trades): a page reaching back says so; a recent page says its makers\' counts do, while the record starts before the cut-off', async () => {
    const db = testD1();
    trades(db, CUT - 40 * D, CUT + 10 * D);
    at(CUT + 10 * D + H);
    const head = await get<TradesResponse>(db, '/api/series/trades?limit=10');
    expect(head.rows.every((r) => r.ts >= CUT)).toBe(true);
    expect(head.prov.note).toContain(osmosisGapCounts('The makers\' trade counts'));
    const back = await get<TradesResponse>(db, `/api/series/trades?limit=10&before=${CUT + D}`);
    expect(back.rows.some((r) => r.ts < CUT)).toBe(true);
    expect(back.prov.note).toContain(OSMOSIS_GAP_NOTE);
    expect(back.prov.note).not.toContain('makers');
    // a record wholly after the cut-off says nothing
    const fresh = testD1();
    trades(fresh, CUT + D, CUT + 10 * D);
    expect((await get<TradesResponse>(fresh, '/api/series/trades?limit=10')).prov.note ?? '').not.toContain(OSMOSIS_GAP_NOTE);
  });

  it('the swap series (/api/series?key=dex.swaps_1h.nam): a range from before the cut-off says so, one after does not', async () => {
    const db = testD1();
    const rows: [number, string, number][] = [];
    for (let h = CUT - 5 * D; h < CUT + 5 * D; h += 6 * H) rows.push([h, 'dex.swaps_1h.nam', 1000]);
    db.raw.exec('BEGIN');
    const st = db.raw.prepare('INSERT INTO metrics (ts, key, value) VALUES (?, ?, ?)');
    for (const r of rows) st.run(...r);
    db.raw.exec('COMMIT');
    at(CUT + 5 * D);
    const wide = await get<SeriesResponse>(db, `/api/series?key=dex.swaps_1h.nam&from=${CUT - 3 * D}&step=1h`);
    expect(wide.prov.note).toContain(OSMOSIS_GAP_NOTE);
    const narrow = await get<SeriesResponse>(db, `/api/series?key=dex.swaps_1h.nam&from=${CUT + D}&step=1h`);
    expect(narrow.prov.note ?? '').not.toContain(OSMOSIS_GAP_NOTE);
    expect(narrow.points.length).toBeGreaterThan(0);
  });

  it('the executed price (/api/series?key=price.swap_1h), the hourly median of the stored swaps: a range from before the cut-off says so, its prices as stored', async () => {
    const db = testD1();
    db.raw.exec('BEGIN');
    const st = db.raw.prepare('INSERT INTO metrics (ts, key, value) VALUES (?, ?, ?)');
    for (let h = CUT - 5 * D; h < CUT + 5 * D; h += 6 * H) { st.run(h, 'price.swap_1h', 0.001); st.run(h, 'price.swap_1h.n', 3); }
    db.raw.exec('COMMIT');
    at(CUT + 5 * D);
    const wide = await get<SeriesResponse>(db, `/api/series?key=price.swap_1h&from=${CUT - 3 * D}&step=1h`);
    expect(wide.prov.note).toContain(OSMOSIS_GAP_NOTE);
    expect(wide.points.every((x) => x.v === 0.001)).toBe(true);
    const narrow = await get<SeriesResponse>(db, `/api/series?key=price.swap_1h&from=${CUT + D}&step=1h`);
    expect(narrow.prov.note ?? '').not.toContain(OSMOSIS_GAP_NOTE);
    expect(narrow.points.length).toBeGreaterThan(0);
  });

  it('the overview\'s last 24 hours under Rewind, when they reach back before the cut-off', async () => {
    const db = testD1();
    trades(db, CUT - 5 * D, CUT + 5 * D);
    at(CUT + 5 * D);
    const then = await get<Overview>(db, `/api/overview?at=${CUT + 12 * H}`);
    expect(then.dex.coverage.note).toContain(OSMOSIS_GAP_NOTE);
    const now = await get<Overview>(db, '/api/overview');
    expect(now.dex.coverage.note ?? '').not.toContain(OSMOSIS_GAP_NOTE);
  });
});

describe('a stored pool size reaching back before the pools were sized from their reserves', () => {
  it('the series of the pools\' total says which readings are the router\'s own figure', async () => {
    const db = testD1();
    const T = CUT + 20 * D;
    db.raw.exec('BEGIN');
    const st = db.raw.prepare('INSERT INTO metrics (ts, key, value) VALUES (?, ?, ?)');
    for (let m = T - 2 * H; m < T; m += 60_000) st.run(m, 'dex.liquidity_usd', m < T - H ? 151 : 1_016.9);
    db.raw.exec('COMMIT');
    at(T);
    const none = await get<SeriesResponse>(db, `/api/series?key=dex.liquidity_usd&from=${T - 2 * H}&step=1m`);
    expect(none.prov.note).toContain(routerCapNote(null));
    db.raw.prepare('INSERT INTO metrics (ts, key, value) VALUES (?, ?, ?)').run(T - H, PRICED_KEY, 5);
    const both = await get<SeriesResponse>(db, `/api/series?key=dex.liquidity_usd&from=${T - 2 * H}&step=1m`);
    expect(both.prov.note).toContain(routerCapNote(T - H));
    // the day and time as every other stamp writes them
    expect(routerCapNote(T - H)).toMatch(/^Readings before 9 Nov 2026 21:00 UTC are the Osmosis router's own figure/);
    const after = await get<SeriesResponse>(db, `/api/series?key=dex.liquidity_usd&from=${T - 30 * 60_000}&step=1m`);
    expect(after.prov.note ?? '').not.toContain('router');
  });
});

describe('the Trade page\'s "What recent buyers paid"', () => {
  let Buyers: ComponentType<any>;
  beforeAll(async () => {
    const g = globalThis as any;
    const noop = () => {};
    g.location ??= new URL('https://namada.trade/trade');
    g.history ??= { pushState: noop, replaceState: noop, state: null };
    g.window ??= g;
    g.addEventListener ??= noop;
    g.removeEventListener ??= noop;
    g.matchMedia ??= () => ({ matches: false, addEventListener: noop, removeEventListener: noop });
    g.localStorage ??= { getItem: () => null, setItem: noop, removeItem: noop };
    ({ Buyers } = await import('../web/src/screens/trade/Buyers'));
  });
  const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&');
  const load = (v: VolumeResponse) => ({ data: v, error: null, loading: false, fetchedAt: v.asOf, failedAt: null, unserved: false, retry: () => {} });

  it('says under the table which windows reach back before the cut-off; a later answer says nothing', async () => {
    const db = testD1();
    trades(db, CUT - 40 * D, CUT + 40 * D);
    at(CUT + 10 * D);
    const v = await get<VolumeResponse>(db, '/api/series/volume');
    const props = { daily: { data: null, error: null, loading: false, fetchedAt: null, failedAt: null, unserved: false, retry: () => {} }, overview: null, depth: null };
    const html = text(renderToStaticMarkup(createElement(Buyers, { ...props, volume: load(v) })));
    expect(html).toContain(`${OSMOSIS_GAP_NOTE} The 30-day window reaches back before then.`);
    at(CUT + 31 * D);
    const later = await get<VolumeResponse>(db, '/api/series/volume');
    expect(text(renderToStaticMarkup(createElement(Buyers, { ...props, volume: load(later) })))).not.toContain(OSMOSIS_GAP_NOTE);
  });
});
