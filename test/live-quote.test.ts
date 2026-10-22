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
    // a stored minute exists, but more than five minutes before the move: none
    expect(await q.at(T0 - 2 * 3_600_000 - 30_000 + QUOTE_MATCH_MS + 1, T0)).toBeNull();
    expect(await q.at(T0 - 2 * 3_600_000 - 30_000 + QUOTE_MATCH_MS, T0)).toBe(0.0011);
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

  it('a stream move is priced at the quote\'s age when it arrives, not at what the last tick held', async () => {
    // review, 2026-10-22: a slow alarm tick (a long catch-up search) held a 4 min 50 s old stored quote past five minutes
    vi.useFakeTimers({ now: T0, toFake: ['Date'] });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    const db = testD1();
    db.raw.prepare('INSERT INTO metrics (ts, key, value) VALUES (?, ?, ?)').run(T0 - 290_000, 'price.usd', 0.00082);
    const hub: any = hubOf(db, async () => null);
    await hub.refreshQuote();
    expect(hub.osmoCtx.priceUsd).toBe(0.00082);
    vi.setSystemTime(T0 + 120_000);
    await hub.handleOsmosisMessage(msgOf(split));
    expect(row(db, `osmosis:${split.hash}:swap`).price_usd).toBeNull();
  });

  it('only the hub\'s own answers are broadcast as the live price; the stored minute is not', async () => {
    vi.useFakeTimers({ now: T0, toFake: ['Date'] });
    const db = testD1();
    db.raw.prepare('INSERT INTO metrics (ts, key, value) VALUES (?, ?, ?)').run(T0 - 50_000, 'price.usd', 0.00082);
    const sent: any[] = [];
    let answer: number | null = null;
    const hub: any = hubOf(db, async () => answer);
    hub.sessions = new Set([{ send: (m: string) => sent.push(JSON.parse(m)) }]);
    await hub.refreshQuote();
    expect(hub.lastPriceUsd).toBe(0.00082);
    expect(sent).toEqual([]);
    answer = 0.0009;
    vi.setSystemTime(T0 + QUOTE_ASK_EVERY_MS);
    await hub.refreshQuote();
    expect(sent).toEqual([{ type: 'price', usd: 0.0009, at: T0 + QUOTE_ASK_EVERY_MS }]);
  });

  it('every alarm tick keeps the quote: over ten minutes with the service silent, each stream move gets the newest stored minute', async () => {
    // review, 2026-10-22: no test drove the alarm, so removing its refresh brought the incident back unnoticed
    vi.useFakeTimers({ now: T0, toFake: ['Date'] });
    const db = testD1();
    for (let m = -1; m <= 10; m++) db.raw.prepare('INSERT INTO metrics (ts, key, value) VALUES (?, ?, ?)').run(T0 + m * 60_000 + 2000, 'price.usd', 0.0008 + m * 1e-6);
    const hub: any = hubOf(db, async () => null);
    Object.assign(hub, { ctx: { storage: { setAlarm: async () => {} } }, isPollingNamada: false, lastLiveReport: 0, lastSweep: Infinity, needSweep: false,
      scanNamada: async () => {}, sweepOsmosis: async () => {}, ensureOsmosisWs: () => {} });
    for (let t = T0; t <= T0 + 10 * 60_000; t += 6000) {
      vi.setSystemTime(t);
      await hub.alarm();
      // the newest minute stored by now (one is stored 2 s into each minute); it is read at most QUOTE_STORED_EVERY_MS late
      const newest = 0.0008 + Math.floor((t - T0 - 2000) / 60_000) * 1e-6;
      expect(hub.quote.current(t)?.usd, `at +${(t - T0) / 1000} s`).toBeDefined();
      expect(Math.abs(hub.quote.current(t).usd - newest)).toBeLessThanOrEqual(1e-6 + 1e-12);
    }
  });

  it('a whale found late with no quote for its minute is alerted without a dollar value, as its row has none', async () => {
    vi.useFakeTimers({ now: T0, toFake: ['Date'] });
    const blockTs = T0 - 3_600_000;
    const events = [{ type: 'transfer', attributes: [{ key: 'recipient', value: 'osmo1lq8recv' }, { key: 'sender', value: 'osmo1lq8send' }, { key: 'amount', value: `${50_000 * 1e6}${NAM.osmoDenom}` }] }];
    const posts: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => {
      const url = String(u);
      if (url.includes('discord.com')) { posts.push(JSON.parse(String(init?.body ?? '{}'))); return new Response(null, { status: 204 }); }
      if (url.endsWith('/status')) return Response.json({ result: { sync_info: { latest_block_height: '200' } } });
      if (url.includes('/tx_search')) return Response.json({ result: { txs: [{ hash: 'LQ8AAA', height: '100', tx_result: { code: 0, events } }] } });
      if (url.includes('/block?height=')) return Response.json({ result: { block: { header: { time: new Date(blockTs).toISOString() } } } });
      throw new Error(`unexpected ${url}`);
    }));
    const db = testD1();
    await db.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('osmosis.cursor', ?, 0)").bind(JSON.stringify({ height: 50, at: 0 })).run();
    const hub: any = hubOf(db, async () => 0.0008);
    hub.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/77/op';
    await hub.refreshQuote();
    await hub.sweepOsmosis();
    expect((db.raw.prepare("SELECT price_usd FROM flows WHERE tx_hash = 'LQ8AAA'").get() as any).price_usd).toBeNull();
    expect(posts).toHaveLength(1);
    expect(JSON.stringify(posts[0])).not.toContain('$');
  });

  it('a transaction whose minute\'s quote cannot be read is left for the next search, never stored unpriced', async () => {
    vi.useFakeTimers({ now: T0, toFake: ['Date'] });
    const blockTs = T0 - 3_600_000;
    const events = [{ type: 'transfer', attributes: [{ key: 'recipient', value: 'osmo1lq7recv' }, { key: 'sender', value: 'osmo1lq7send' }, { key: 'amount', value: `${5_000 * 1e6}${NAM.osmoDenom}` }] }];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      const url = String(u);
      if (url.endsWith('/status')) return Response.json({ result: { sync_info: { latest_block_height: '200' } } });
      if (url.includes('/tx_search')) return Response.json({ result: { txs: [{ hash: 'LQ7AAA', height: '100', tx_result: { code: 0, events } }] } });
      if (url.includes('/block?height=')) return Response.json({ result: { block: { header: { time: new Date(blockTs).toISOString() } } } });
      throw new Error(`unexpected ${url}`);
    }));
    const db = testD1();
    await db.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('osmosis.cursor', ?, 0)").bind(JSON.stringify({ height: 50, at: 0 })).run();
    let down = true;
    const reader = storedQuoteReader(db as any);
    const hub: any = hubOf(db, async () => null);
    hub.quote = new HubQuote(async () => null, async (ts) => { if (down) throw new Error('D1_ERROR'); return reader(ts); });
    db.raw.prepare('INSERT INTO metrics (ts, key, value) VALUES (?, ?, ?)').run(blockTs - 30_000, 'price.usd', 0.0011);
    await hub.sweepOsmosis();
    const count = () => (db.raw.prepare("SELECT COUNT(*) AS n FROM flows WHERE tx_hash = 'LQ7AAA'").get() as any).n;
    expect(count()).toBe(0);
    down = false;
    await hub.sweepOsmosis();
    expect((db.raw.prepare("SELECT price_usd FROM flows WHERE tx_hash = 'LQ7AAA'").get() as any).price_usd).toBe(0.0011);
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
