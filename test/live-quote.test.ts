// The live hub's NAM quote (worker/src/live-quote.ts). On 2026-10-21 every Osmosis trade not priced by its own USDC
// stored no price from 19:20 UTC on: the hub asked the quote service every 6 s and got nothing back, while the
// cron's one read a minute was stored as price.usd. Now the hub asks at most every 30 s, takes the cron's stored
// minute when the service does not answer, never prices a move at a quote more than five minutes old, and prices a
// move found late at its own minute's quote.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import { LiveHub } from '../worker/src/live-hub';
import { HubQuote, QUOTE_ASK_EVERY_MS, QUOTE_STORED_EVERY_MS, storedQuoteReader } from '../worker/src/live-quote';
import { QUOTE_MATCH_MS } from '../worker/src/analytics';
import { osmoAssets } from '../worker/src/parse/osmosis';
import { NAM } from '../worker/src/config';
import { testD1, type TestD1 } from './d1-sqlite';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const T0 = Date.UTC(2026, 9, 22, 6, 0);
/** A quote whose service answers `answers` in turn (null: no answer) and whose stored minutes are `minutes`. */
function quoteOf(answers: (number | null)[], minutes: { usd: number; at: number }[] = []) {
  const asks: number[] = [], reads: number[] = [];
  let i = 0;
  const q = new HubQuote(
    async () => { asks.push(i); return answers[Math.min(i++, answers.length - 1)] ?? null; },
    async (ts) => { reads.push(ts); return [...minutes].filter((m) => m.at <= ts).sort((a, b) => b.at - a.at)[0] ?? null; },
  );
  return { q, asks, reads };
}
/** Alarm ticks every 6 s from `from` for `ms`. */
async function ticks(q: HubQuote, from: number, ms: number) {
  let last = null;
  for (let t = from; t <= from + ms; t += 6000) last = await q.refresh(t);
  return last;
}

describe('the hub\'s quote for new moves', () => {
  it('asks the quote service at most every 30 s, not every 6 s tick', async () => {
    const { q, asks, reads } = quoteOf([0.0008]);
    const last = await ticks(q, T0, 60_000);
    expect(asks).toHaveLength(3); // at 0, 30 and 60 s
    expect(reads).toHaveLength(0); // an answering service needs no stored quote
    expect(last).toEqual({ usd: 0.0008, at: T0 + 60_000, source: 'live' });
    expect(QUOTE_ASK_EVERY_MS).toBe(30_000);
  });

  it('when the service does not answer, takes the quote the cron stored for the minute, and the next minute\'s when it comes', async () => {
    const minutes = [{ usd: 0.00082, at: T0 - 40_000 }, { usd: 0.00083, at: T0 + 20_000 }];
    const { q, reads } = quoteOf([null], minutes);
    expect(await q.refresh(T0)).toEqual({ usd: 0.00082, at: T0 - 40_000, source: 'stored' });
    // read again at most every QUOTE_STORED_EVERY_MS (and after each unanswered ask), never on every tick
    const last = await ticks(q, T0 + 6000, 54_000);
    expect(reads.length).toBeLessThanOrEqual(1 + Math.ceil(60_000 / QUOTE_STORED_EVERY_MS) + 2);
    expect(last).toEqual({ usd: 0.00083, at: T0 + 20_000, source: 'stored' });
  });

  it('never prices a move at a quote more than five minutes old: one that answered once and then stopped expires', async () => {
    const { q } = quoteOf([0.0008, null]);
    expect((await q.refresh(T0))?.usd).toBe(0.0008);
    expect(await ticks(q, T0 + 6000, QUOTE_MATCH_MS - 6000)).toMatchObject({ usd: 0.0008 });
    expect(await q.refresh(T0 + QUOTE_MATCH_MS + 6000)).toBeNull();
    expect(q.current(T0 + QUOTE_MATCH_MS + 6000)).toBeNull();
  });

  it('a stored minute older than the last answer does not replace it; one older than five minutes is none', async () => {
    const { q } = quoteOf([0.0008, null], [{ usd: 0.5, at: T0 - 10_000 }]);
    await q.refresh(T0);
    expect(await q.refresh(T0 + 30_000)).toEqual({ usd: 0.0008, at: T0, source: 'live' });
    const old = quoteOf([null], [{ usd: 0.0009, at: T0 - QUOTE_MATCH_MS - 1 }]);
    expect(await old.q.refresh(T0)).toBeNull();
  });

  it('a move found late is priced at the quote stored for its own minute, never the current one', async () => {
    const minutes = [{ usd: 0.0011, at: T0 - 2 * 3_600_000 - 30_000 }, { usd: 0.0008, at: T0 - 20_000 }];
    const { q, reads } = quoteOf([0.0008], minutes);
    await q.refresh(T0);
    expect(await q.at(T0 - 5000, T0)).toBe(0.0008); // the stream's move: the current quote, no read
    expect(reads).toHaveLength(0);
    expect(await q.at(T0 - 2 * 3_600_000, T0)).toBe(0.0011);
    expect(reads).toEqual([T0 - 2 * 3_600_000]);
    // no stored minute within five minutes before the move: none
    expect(await q.at(T0 - 2 * 3_600_000 - 30_000 - QUOTE_MATCH_MS - 1, T0)).toBeNull();
  });
});

describe('the live hub prices new trades again', () => {
  const split = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'osmo_split_route_osmo.json'), 'utf8'));
  const msgOf = (tx: any) => ({ result: { data: { value: { TxResult: { height: String(tx.height), result: { code: 0, events: tx.tx_result.events } } } }, events: { 'tx.hash': [tx.hash] } } });
  const hubOf = (db: TestD1, ask: () => Promise<number | null>) => Object.assign(Object.create(LiveHub.prototype), {
    env: { DB: db }, seenOsmoTx: new Set<string>(), osmoRetryTx: new Map<string, number>(), osmoRetryFrom: null, osmoRetryGen: 0, osmoHeight: 0,
    sessions: new Set(), lastPriceUsd: null, osmoCtx: { poolAddrs: new Map(), priceUsd: null, assets: osmoAssets() },
    quote: new HubQuote(ask, storedQuoteReader(db as any)),
  });
  const row = (db: TestD1, id: string) => db.raw.prepare('SELECT price_usd, value_usd, meta FROM flows WHERE id = ?').get(id) as any;

  it('a sale paid in OSMO streamed while the service does not answer stores the cron\'s minute quote, said to be the quote', async () => {
    vi.useFakeTimers({ now: T0, toFake: ['Date'] });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    const db = testD1();
    db.raw.prepare('INSERT INTO metrics (ts, key, value) VALUES (?, ?, ?)').run(T0 - 40_000, 'price.usd', 0.00082);
    const hub: any = hubOf(db, async () => null);
    await hub.refreshQuote();
    expect(hub.osmoCtx.priceUsd).toBe(0.00082);
    await hub.handleOsmosisMessage(msgOf(split));
    const r = row(db, `osmosis:${split.hash}:swap`);
    expect(r.price_usd).toBe(0.00082);
    expect(r.value_usd).toBeCloseTo(0.00082 * 19796.328, 9);
    const meta = JSON.parse(r.meta);
    expect(meta.priceSource).toBe('spot');
    expect(meta.settle.nam).toBeCloseTo(-20000, 9);
  });

  it('with no quote within five minutes the trade stores no price (never an hours-old one)', async () => {
    vi.useFakeTimers({ now: T0, toFake: ['Date'] });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    const db = testD1();
    db.raw.prepare('INSERT INTO metrics (ts, key, value) VALUES (?, ?, ?)').run(T0 - QUOTE_MATCH_MS - 1000, 'price.usd', 0.0011);
    const hub: any = hubOf(db, async () => null);
    hub.lastPriceUsd = 0.0011;
    hub.osmoCtx.priceUsd = 0.0011; // what the hub held from hours before
    await hub.refreshQuote();
    expect(hub.osmoCtx.priceUsd).toBeNull();
    expect(hub.lastPriceUsd).toBeNull();
    await hub.handleOsmosisMessage(msgOf(split));
    const r = row(db, `osmosis:${split.hash}:swap`);
    expect(r.price_usd).toBeNull();
    expect(JSON.parse(r.meta).priceSource).toBeUndefined();
  });

  it('the catch-up search prices a transaction two hours old at its own minute\'s stored quote', async () => {
    vi.useFakeTimers({ now: T0, toFake: ['Date'] });
    const blockTs = T0 - 2 * 3_600_000;
    const events = [{ type: 'transfer', attributes: [{ key: 'recipient', value: 'osmo1lq9recv' }, { key: 'sender', value: 'osmo1lq9send' }, { key: 'amount', value: `${50_000 * 1e6}${NAM.osmoDenom}` }] }];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      const url = String(u);
      if (url.includes('discord.com')) return new Response(null, { status: 204 });
      if (url.endsWith('/status')) return Response.json({ result: { sync_info: { latest_block_height: '200' } } });
      if (url.includes('/tx_search')) return Response.json({ result: { txs: [{ hash: 'LQ9AAA', height: '100', tx_result: { code: 0, events } }] } });
      if (url.includes('/block?height=')) return Response.json({ result: { block: { header: { time: new Date(blockTs).toISOString() } } } });
      throw new Error(`unexpected ${url}`);
    }));
    const db = testD1();
    db.raw.prepare('INSERT INTO metrics (ts, key, value) VALUES (?, ?, ?)').run(blockTs - 30_000, 'price.usd', 0.0011);
    db.raw.prepare('INSERT INTO metrics (ts, key, value) VALUES (?, ?, ?)').run(T0 - 20_000, 'price.usd', 0.0008);
    await db.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('osmosis.cursor', ?, 0)").bind(JSON.stringify({ height: 50, at: 0 })).run();
    const hub: any = hubOf(db, async () => 0.0008);
    await hub.refreshQuote();
    expect(hub.osmoCtx.priceUsd).toBe(0.0008);
    await hub.sweepOsmosis();
    const r = db.raw.prepare("SELECT price_usd FROM flows WHERE tx_hash = 'LQ9AAA'").get() as any;
    expect(r.price_usd).toBe(0.0011);
  });
});
