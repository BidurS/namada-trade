// The NAM quote when the Osmosis quote service's price list gives NAM no price. From 16:36 UTC on 23 Oct 2026 the
// price list answered NAM with {} (NAM's pools fell under its liquidity floor after the 21 Oct sell-off) while it
// still priced OSMO and the other coins, and the cron stored no price.usd: the headline price, the live hub's quote,
// the price check, the series and the SEO price all went without one. fetchNamPrice now takes the spot price of the
// route the router quotes for selling ROUTE_REF_NAM NAM, and says so wherever the price is shown.
//
// The fixtures are the quote service's own answers at 02:24 UTC on 24 Oct 2026: the price list for NAM and the five
// quoted coins (sqs_prices_no_nam.json), and the router's quotes for 1, 100, 1,000 and 10,000 NAM against allUSDC
// (sqs_route_nam_<size>.json).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchNamPrice, quoteErrorText, quoteNamTrade, priceSourceName, routeSpotUrl, routeNoSpotText, routeOtherPoolsText, ROUTE_REF_NAM, type NamPriceHow } from '../worker/src/sources/sqs';
import { PRICE_HOW_KEY, PRICE_HOW_KEEP, PRICE_HEALTH_NAME, priceHealth, priceHowAt, priceHowStmt, livePriceProv, routeNote, storedPriceNote, storedPriceSource, type PriceHowLog } from '../worker/src/price-how';
import { HubQuote, askQuoteService } from '../worker/src/live-quote';
import { app } from '../worker/src/api';
import { kvGetJson } from '../worker/src/db';
import { NAM, OSMOSIS } from '../worker/src/config';
import { plainSource } from '../web/src/lib/prov';
import { BANNED } from '../scripts/copy-lint';
import { testD1, insert } from './d1-sqlite';
import type { Overview } from '../shared/types';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8');
const LIST_NO_NAM = fixture('sqs_prices_no_nam.json');
const ROUTE = (n: number) => fixture(`sqs_route_nam_${n}.json`);
/** in_base_out_quote_spot_price of the 1,000 NAM answer */
const SPOT = 0.000903440360921879;
/** The quote in pool 3005 alone, as SQS answered it at 16:14 UTC on 25 Oct (test/fixtures/sqs_direct_3005_nam_1000.json). */
const DIRECT = readFileSync(new URL('./fixtures/sqs_direct_3005_nam_1000.json', import.meta.url), 'utf8');

/**
 * The quote service: `list` answers /tokens/prices, `route` answers the quote in pool 3005 (a body, or a status to refuse
 * with), '[]' for the pool list. Returns the URLs asked.
 */
function sqs(opts: { list?: string | number; route?: string | number } = {}) {
  const asked: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    asked.push(url);
    const answer = (v: string | number | undefined) => (typeof v === 'number' ? new Response('refused', { status: v }) : new Response(v ?? '{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    if (url.includes('/tokens/prices')) return answer(opts.list ?? LIST_NO_NAM);
    if (url.includes('/router/custom-direct-quote') || url.includes('/router/quote')) return answer(opts.route ?? ROUTE(1000));
    if (url.includes('/pools')) return answer('[]');
    return new Response('not found', { status: 404 });
  }));
  return asked;
}

/** The answer SQS gave, with NAM priced as it was before 16:36 UTC on 23 Oct (the list path). */
const listWithNam = (usd: string) => JSON.stringify({ ...JSON.parse(LIST_NO_NAM), [NAM.osmoDenom]: { [OSMOSIS.allUsdc]: usd } });

const ROUTE_HOW: NamPriceHow = { how: 'route', refNam: 1000, routes: [[{ id: '3005', liquidityUsd: 165 }, { id: '3497', liquidityUsd: 2346179 }]], liquidityUsd: 165 };

describe('the answers SQS gave on 2026-10-24, as the reference size was chosen from them', () => {
  it('the price list answers NAM with {} and still prices the five quoted coins', () => {
    const list = JSON.parse(LIST_NO_NAM);
    expect(list[NAM.osmoDenom]).toEqual({});
    for (const d of Object.values(OSMOSIS.quotedCoins)) expect(parseFloat(list[d][OSMOSIS.allUsdc])).toBeGreaterThan(0);
  });

  it('1 NAM goes through dust pools, 100 NAM is split, 1,000 and 10,000 NAM take pool 3005 then 3497 at one spot', () => {
    const pools = (n: number) => JSON.parse(ROUTE(n)).route.map((r: any) => r.pools.map((p: any) => `${p.id} $${p.liquidity_cap}`));
    const spot = (n: number) => JSON.parse(ROUTE(n)).in_base_out_quote_spot_price;
    expect(pools(1)).toEqual([['3009 $17', '3515 $4']]);
    expect(pools(100)).toEqual([['3005 $165', '3497 $2346179'], ['3009 $17', '3576 $30']]);
    expect(pools(1000)).toEqual([['3005 $165', '3497 $2346179']]);
    expect(pools(10000)).toEqual(pools(1000));
    expect(spot(1000)).toBe('0.000903440360921879');
    expect(spot(10000)).toBe(spot(1000));
    expect(spot(1)).toBe('0.000954003607608017');
    expect(spot(100)).toBe('0.000918592550525163');
    // the answer's own liquidity_cap is the sum of its pools' (165 + 2,346,179), not the NAM side's depth
    expect(JSON.parse(ROUTE(1000)).liquidity_cap).toBe('2346344');
    // the token list of every answer gives NAM no liquidity
    for (const n of [1, 100, 1000, 10000]) expect(JSON.parse(ROUTE(n)).tokens.find((t: any) => t.denom === NAM.osmoDenom).liquidity_cap).toBe('0');
    expect(ROUTE_REF_NAM).toBe(1000);
  });
});

describe('fetchNamPrice when the price list gives NAM no price', () => {
  it('takes the spot of the route the router quotes for 1,000 NAM, with its pools and the thinnest one\'s liquidity; the coins keep the list\'s prices', async () => {
    const asked = sqs();
    const r = await fetchNamPrice();
    expect(r.usd).toBe(SPOT);
    expect(r.error).toBeUndefined();
    expect(r.how).toEqual(ROUTE_HOW);
    expect(r.osmoUsd).toBeCloseTo(0.047995208978719417, 15);
    expect(Object.keys(r.coinUsd!).sort()).toEqual(['ATOM', 'ETH', 'KYVE', 'OSMO', 'TIA']);
    expect(r.coinUsd!.ATOM).toBeCloseTo(1.689013500289676, 12);
    // one list read, then one quote: 1,000 NAM (1e9 base units) sold in pool 3005 alone, for its Noble USDC
    expect(asked).toHaveLength(2);
    expect(asked[1]).toBe(routeSpotUrl());
    expect(asked[1]).toBe(`${OSMOSIS.sqs}/router/custom-direct-quote?tokenIn=1000000000${encodeURIComponent(NAM.osmoDenom)}&tokenOutDenom=${encodeURIComponent(OSMOSIS.usdcDenom)}&poolID=3005`);
  });

  it('the list path is unchanged: a NAM price in the list is the price, and the router is not asked', async () => {
    const asked = sqs({ list: listWithNam('0.000921') });
    const r = await fetchNamPrice();
    expect(r.usd).toBe(0.000921);
    expect(r.how).toEqual({ how: 'list' });
    expect(r.coinUsd!.OSMO).toBeCloseTo(0.047995208978719417, 15);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('/tokens/prices');
  });

  it('a route answer with no spot, a zero, a negative or an unreadable spot gives no price: never a figure SQS did not give', async () => {
    const base = JSON.parse(ROUTE(1000));
    for (const spot of [undefined, '0', '0.000000000000000000', '-0.0009', 'NaN', 'abc', null]) {
      const body = { ...base };
      if (spot === undefined) delete body.in_base_out_quote_spot_price; else body.in_base_out_quote_spot_price = spot;
      sqs({ route: JSON.stringify(body) });
      const r = await fetchNamPrice();
      expect(r.usd, String(spot)).toBeNull();
      expect(r.how, String(spot)).toBeUndefined();
      expect(r.error).toBe(routeNoSpotText());
      // the coins are still the list's
      expect(r.coinUsd!.OSMO).toBeGreaterThan(0);
    }
    sqs({ route: '[]' });
    expect((await fetchNamPrice()).usd).toBeNull();
  });

  it('both paths failing: the list has no NAM price and the router refuses; the note says the service is not answering', async () => {
    vi.useFakeTimers();
    const asked = sqs({ route: 403 });
    const p = fetchNamPrice();
    await vi.runAllTimersAsync();
    const r = await p;
    expect(r.usd).toBeNull();
    expect(r.error).toBe(quoteErrorText('busy'));
    expect(asked.filter((u) => u.includes('/router/custom-direct-quote'))).toHaveLength(3); // sqsGet's three tries
    sqs({ route: 500 });
    const q = fetchNamPrice();
    await vi.runAllTimersAsync();
    expect((await q).error).toBe(quoteErrorText('unavailable'));
  });

  it('a price list that does not answer is not followed by the router: the service is not answering', async () => {
    vi.useFakeTimers();
    const asked = sqs({ list: 503 });
    const p = fetchNamPrice();
    await vi.runAllTimersAsync();
    const r = await p;
    expect(r.usd).toBeNull();
    expect(r.error).toBe(quoteErrorText('unavailable'));
    expect(asked.some((u) => u.includes('/router/'))).toBe(false);
    // nor is an answer that is not the list's object of coins
    for (const body of ['null', '[]']) {
      const seen = sqs({ list: body });
      expect((await fetchNamPrice()).usd, body).toBeNull();
      expect(seen.some((u) => u.includes('/router/')), body).toBe(false);
    }
  });

  it('the quote in pool 3005 alone, as SQS answers it, is taken: its one route is the pool itself', async () => {
    sqs({ route: DIRECT });
    const r = await fetchNamPrice();
    expect(r.usd).toBeCloseTo(0.000970156293556628, 15);
    expect(r.how).toEqual({ how: 'route', refNam: 1000, routes: [[{ id: '3005', liquidityUsd: 178 }]], liquidityUsd: 178 });
  });

  it('a route through any pool but 3005 and the transmuter gives no price: the 1 NAM and 100 NAM answers SQS gave', async () => {
    // (the quote now asks pool 3005 alone, so an answer through other pools would be the service's mistake; it is refused the same way)
    sqs({ route: ROUTE(1) });
    const one = await fetchNamPrice();
    expect(one.usd).toBeNull();
    expect(one.how).toBeUndefined();
    expect(one.error).toBe(routeOtherPoolsText(['3009', '3515']));
    expect(one.error).toBe('The Osmosis quote service\'s price list gives NAM no price, and its quote for selling 1,000 NAM in pool 3005 came back through pools 3009, 3515 instead, so no price is taken from it.');
    sqs({ route: ROUTE(100) });
    const hundred = await fetchNamPrice();
    expect(hundred.usd).toBeNull();
    expect(hundred.error).toBe(routeOtherPoolsText(['3009', '3576']));
    sqs({ route: ROUTE(10000) });
    expect((await fetchNamPrice()).usd).toBe(SPOT);
  });

  it('a visitor\'s budget pays for the router call: none left is busy, and the router is not asked', async () => {
    const asked = sqs();
    let left = 1;
    const r = await fetchNamPrice(1, async () => left-- > 0);
    expect(r.usd).toBe(SPOT);
    const none = await fetchNamPrice(1, async () => false);
    expect(none.usd).toBeNull();
    expect(none.error).toBe(quoteErrorText('busy'));
    expect(asked.filter((u) => u.includes('/router/'))).toHaveLength(1);
  });
});

describe('the provenance of a route price', () => {
  it('names the route and its size; the site says it in plain words, and the list keeps \'Osmosis SQS\'', () => {
    expect(priceSourceName(ROUTE_HOW)).toBe('Osmosis SQS route spot, 1,000 NAM');
    expect(priceSourceName({ how: 'list' })).toBe('Osmosis SQS');
    expect(priceSourceName(null)).toBe('Osmosis SQS');
    expect(plainSource({ source: 'Osmosis SQS route spot, 1,000 NAM' })).toBe('Osmosis route quote, 1,000 NAM');
    expect(plainSource({ source: storedPriceSource(ROUTE_HOW) })).toBe('Osmosis route quote, 1,000 NAM');
    expect(storedPriceSource(null)).toBe('Osmosis SQS (stored)');
    expect(plainSource({ source: storedPriceSource(null) })).toBe('Osmosis quote');
    expect(plainSource({ source: 'Osmosis SQS' })).toBe('Osmosis quote');
  });

  it('the note says why, the size, the pools with their liquidity and the thinnest pool, with no word the site bans', () => {
    const at = Date.UTC(2026, 9, 24, 2, 24);
    const live = livePriceProv({ at, how: ROUTE_HOW });
    expect(live).toEqual({
      source: 'Osmosis SQS route spot, 1,000 NAM', at, status: 'live',
      note: 'The Osmosis quote service\'s price list gives NAM no price, so the price is the spot price of the pool it quotes for selling 1,000 NAM: pool 3005 ($165 besides its NAM), then pool 3497 ($2,346,179). The service counts no NAM in a pool\'s liquidity, as it gives NAM no price.',
    });
    expect(livePriceProv({ at, how: { how: 'list' } })).toEqual({ source: 'Osmosis SQS', at, status: 'live' });
    const stored = storedPriceNote({ ...ROUTE_HOW, since: Date.UTC(2026, 9, 23, 16, 37) })!;
    expect(stored).toBe('The Osmosis quote service\'s price list gave NAM no price, so the price is the spot price of the pool it quoted for selling 1,000 NAM: pool 3005 ($165 besides its NAM), then pool 3497 ($2,346,179) (liquidity as read at 2026-10-23 16:37 UTC). The service counts no NAM in a pool\'s liquidity, as it gives NAM no price.');
    expect(storedPriceNote({ how: 'list', since: at })).toBeUndefined();
    const split = routeNote({ how: 'route', refNam: 1000, routes: [[{ id: '3005', liquidityUsd: 165 }, { id: '3497', liquidityUsd: 2346179 }], [{ id: '3009', liquidityUsd: 17 }, { id: '3576', liquidityUsd: 4.2 }]], liquidityUsd: 4.2 });
    expect(split).toContain('selling 1,000 NAM: pool 3005 ($165 besides its NAM), then pool 3497 ($2,346,179); and pool 3009 ($17 besides its NAM), then pool 3576 ($4.20).');
    for (const text of [live.note!, stored, split]) for (const b of BANNED) expect(b.re.test(text), `${b.word} in ${text}`).toBe(false);
  });
});

describe('the health row of the price', () => {
  it('ok when the route gives a price, its note saying so; ok with no note for the list; the reason when neither works', () => {
    const at = 1;
    expect(priceHealth({ usd: SPOT, at, how: ROUTE_HOW })).toEqual({ name: PRICE_HEALTH_NAME, ok: true, at, note: routeNote(ROUTE_HOW) });
    expect(priceHealth({ usd: SPOT, at, how: ROUTE_HOW }).note).toContain('price list gives NAM no price');
    expect(priceHealth({ usd: SPOT, at, how: ROUTE_HOW }).note).toContain('selling 1,000 NAM: pool 3005 ($165 besides its NAM), then pool 3497 ($2,346,179)');
    expect(priceHealth({ usd: 0.00092, at, how: { how: 'list' } })).toEqual({ name: 'Osmosis SQS (price)', ok: true, at });
    expect(priceHealth({ usd: null, at, error: quoteErrorText('no_price') })).toEqual({ name: 'Osmosis SQS (price)', ok: false, at, note: quoteErrorText('no_price') });
  });

  it('from the answers SQS gave: the route row is ok; both failing keeps the not-answering note', async () => {
    sqs();
    const h = priceHealth(await fetchNamPrice());
    expect(h.ok).toBe(true);
    expect(h.note).toBe(routeNote(ROUTE_HOW));
    sqs({ route: JSON.stringify({ ...JSON.parse(ROUTE(1000)), in_base_out_quote_spot_price: '0' }) });
    const down = priceHealth(await fetchNamPrice());
    expect(down).toMatchObject({ ok: false, note: routeNoSpotText() });
  });
});

describe('price.how: the way the price was read, written only when it changes', () => {
  const T = Date.UTC(2026, 9, 23, 16, 37);
  const run = async (db: ReturnType<typeof testD1>, how: NamPriceHow, at: number) => {
    const prev = await kvGetJson<PriceHowLog>(db as any, PRICE_HOW_KEY);
    const s = priceHowStmt(prev, how, at);
    if (s) await db.prepare(s.sql).bind(...s.params).run();
    return s != null;
  };

  it('a first reading is written; the same way again is not, even as the liquidity moves; another way or other pools is', async () => {
    const db = testD1();
    expect(await run(db, { how: 'list' }, T - 60_000)).toBe(true);
    expect(await run(db, { how: 'list' }, T)).toBe(false);
    expect(await run(db, ROUTE_HOW, T + 60_000)).toBe(true);
    expect(await run(db, { ...ROUTE_HOW, routes: [[{ id: '3005', liquidityUsd: 164.2 }, { id: '3497', liquidityUsd: 2346000 }]], liquidityUsd: 164.2 }, T + 120_000)).toBe(false);
    expect(await run(db, { ...ROUTE_HOW, routes: [[{ id: '3009', liquidityUsd: 17 }, { id: '3515', liquidityUsd: 4 }]], liquidityUsd: 4 }, T + 180_000)).toBe(true);
    expect(await run(db, { how: 'list' }, T + 240_000)).toBe(true);
    const log = (await kvGetJson<PriceHowLog>(db as any, PRICE_HOW_KEY))!;
    expect(log.log.map((e) => [e.how, e.since])).toEqual([['list', T - 60_000], ['route', T + 60_000], ['route', T + 180_000], ['list', T + 240_000]]);
    // the way each stored minute was read
    expect(priceHowAt(log, T - 120_000)).toBeNull();
    expect(priceHowAt(log, T)?.how).toBe('list');
    expect(priceHowAt(log, T + 120_000)).toMatchObject({ how: 'route', liquidityUsd: 165, since: T + 60_000 });
    expect(priceHowAt(log, T + 200_000)).toMatchObject({ how: 'route', liquidityUsd: 4 });
    expect(priceHowAt(log, T + 240_000)?.how).toBe('list');
    expect(priceHowAt(null, T)).toBeNull();
  });

  it('no price, no write; an unreadable row starts a new log; the log keeps its newest changes', () => {
    expect(priceHowStmt(null, undefined, T)).toBeNull();
    const fresh = priceHowStmt({ log: 'junk' } as any, ROUTE_HOW, T)!;
    expect(JSON.parse(fresh.params[1] as string)).toEqual({ log: [{ ...ROUTE_HOW, since: T }] });
    let log: PriceHowLog = { log: [] };
    const n = PRICE_HOW_KEEP + 10;
    for (let i = 0; i < n; i++) log = JSON.parse(priceHowStmt(log, i % 2 ? ROUTE_HOW : { how: 'list' }, T + i)!.params[1] as string);
    expect(log.log).toHaveLength(PRICE_HOW_KEEP);
    expect(log.log[PRICE_HOW_KEEP - 1].since).toBe(T + n - 1);
  });
});

describe('the readers name the route', () => {
  const env = (db: ReturnType<typeof testD1>) => ({ DB: db } as any);

  it('the headline price is the minute the cron stored, asked of no quote service: the route it was read from, with its note, fresh', async () => {
    const asked = sqs();
    const now = Date.now();
    const db = testD1();
    insert(db, 'metrics', [{ ts: now - 40_000, key: 'price.usd', value: SPOT }]);
    insert(db, 'kv', [{ key: PRICE_HOW_KEY, value: JSON.stringify({ log: [{ ...ROUTE_HOW, since: now - 1_800_000 }] }), updated_at: now - 1_800_000 }]);
    const o = (await (await app.request('/api/overview', {}, env(db))).json()) as Overview;
    expect(asked).toEqual([]);
    expect(o.price.usd.value).toBe(SPOT);
    expect(o.price.usd.prov).toEqual({ source: 'Osmosis SQS route spot, 1,000 NAM (stored)', at: now - 40_000, status: 'live', note: storedPriceNote({ ...ROUTE_HOW, since: now - 1_800_000 }) });
  });

  it('the headline price, stored long ago: old past three minutes, with its age; the stored minute names the route it was read from; one read by the list keeps its name', async () => {
    const asked = sqs({ list: 503 });
    const now = Date.now();
    const db = testD1();
    insert(db, 'metrics', [{ ts: now - 10 * 60_000, key: 'price.usd', value: SPOT }]);
    insert(db, 'kv', [{ key: PRICE_HOW_KEY, value: JSON.stringify({ log: [{ how: 'list', since: now - 3_600_000 }, { ...ROUTE_HOW, since: now - 1_800_000 }] }), updated_at: now - 1_800_000 }]);
    const o = (await (await app.request('/api/overview', {}, env(db))).json()) as Overview;
    expect(asked).toEqual([]);
    expect(o.price.usd.value).toBe(SPOT);
    expect(o.price.usd.prov.source).toBe('Osmosis SQS route spot, 1,000 NAM (stored)');
    expect(o.price.usd.prov.status).toBe('stale');
    expect(o.price.usd.prov.note).toBe(`The newest stored quote is 10 min old. ${storedPriceNote({ ...ROUTE_HOW, since: now - 1_800_000 })}`);
    // rewound to a minute the list priced
    insert(db, 'metrics', [{ ts: now - 3_000_000, key: 'price.usd', value: 0.00095 }]);
    const r = (await (await app.request(`/api/overview?at=${now - 2_900_000}`, {}, env(db))).json()) as Overview;
    expect(r.price.usd.value).toBe(0.00095);
    expect(r.price.usd.prov).toEqual({ source: 'Osmosis SQS (stored)', at: now - 3_000_000, status: 'live' });
  });

  it('a visitor\'s quote measured against a stored route minute says so in its note', async () => {
    const store = new Map<string, Response>();
    vi.stubGlobal('caches', { default: { match: async (r: Request) => store.get(r.url)?.clone(), put: async (r: Request, res: Response) => { store.set(r.url, res); } } });
    const asked = sqs();
    const db = testD1();
    const at = Date.now() - 30_000;
    insert(db, 'metrics', [{ ts: at, key: 'price.usd', value: SPOT }]);
    insert(db, 'kv', [{ key: PRICE_HOW_KEY, value: JSON.stringify({ log: [{ ...ROUTE_HOW, since: at - 60_000 }] }), updated_at: at }]);
    const body = (await (await app.request('/api/quote?amount=1000&side=sell', {}, env(db))).json()) as any;
    expect(body.quote.spotPriceUsd).toBe(SPOT);
    expect(body.quote.prov.note).toBe(`spot from Osmosis SQS route spot, 1,000 NAM at ${new Date(at).toISOString()}`);
    expect(asked.some((u) => u.includes('/tokens/prices'))).toBe(false);
    // with no stored minute the quote reads the price itself, the same way
    const own = await quoteNamTrade(2000, 'sell');
    expect(own.quote!.spotPriceUsd).toBe(SPOT);
    expect(own.quote!.prov.note).toMatch(/^spot from Osmosis SQS route spot, 1,000 NAM at /);
  });

  it('the live hub prices moves from the route spot again, and keeps its source name and note for the stream', async () => {
    sqs();
    const q = new HubQuote(askQuoteService, async () => null);
    const t = Date.now();
    expect(await q.refresh(t)).toEqual({ usd: SPOT, at: t, source: 'live', priceSource: 'Osmosis SQS route spot, 1,000 NAM', priceNote: routeNote(ROUTE_HOW), routeNam: 1000 });
    expect(await q.at(t - 1000, t)).toBe(SPOT);
    // the list path streams its own name, with no note
    sqs({ list: listWithNam('0.000921') });
    expect(await askQuoteService()).toEqual({ usd: 0.000921, priceSource: 'Osmosis SQS', routeNam: null });
    // neither path: no answer, so the hub falls back to the stored minute
    sqs({ route: '{}' });
    expect(await askQuoteService()).toBeNull();
  });
});
