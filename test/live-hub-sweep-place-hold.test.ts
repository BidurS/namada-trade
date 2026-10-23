// Security review (2026-10-22), the catch-up search's resume place, stream writes and a lower head: a search that did
// not finish keeps, per query, the place the next one goes on from (osmosis.cursor `resume`).
//
// A place could pass a stream transaction whose write was still running when the search read it (the search let it
// go as seen) or whose write then threw. Only the hub's memory (osmoRetryTx) said to read it again, so after a restart
// (a deploy, an eviction) the next search trusted the place and went on below it, and the transaction's flow, moves,
// address link and alert were lost for good, though the cursor itself is kept below such a transaction
// (review-g-osmosis-pending-write.test.ts). Now a place ends above a stream transaction not yet known written, by its
// hash and by its block (the node's index may not give it yet), so the next search, or the first one after a restart,
// reads it again.
//
// A search whose /status head was a few blocks below the place's top (the other node answered, or a second search ran
// seconds after the first when the stream reconnected) dropped the place and wrote one from the newest 200 instead,
// so the catch-up started again from the top. Now a place whose top is above the head is gone on from.
//
// Also checked: more transactions than the search's pages above a place's top still give a place from the newest, so a
// burst never holds a query where it was.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testD1 } from './d1-sqlite';
import { NAM } from '../worker/src/config';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import { LiveHub, OSMOSIS_SWEEP_PAGES } from '../worker/src/live-hub';
import { HubQuote } from '../worker/src/live-quote';

afterEach(() => vi.unstubAllGlobals());

const CURSOR = 1_000_000;
const Q = `transfer.amount CONTAINS '${NAM.osmoHash}'`;
const hashOf = (p: string, i: number) => `${p}${String(i).padStart(64 - p.length, '0')}`;
/** A 50 NAM bank transfer: one transfer flow. */
const xfer = (i: number, height: number) => ({
  hash: hashOf('BB', i), height: String(height), tx: '',
  tx_result: { code: 0, events: [{ type: 'transfer', attributes: [{ key: 'recipient', value: `osmo1recv${i}` }, { key: 'sender', value: `osmo1send${i}` }, { key: 'amount', value: `${50 * 1e6}${NAM.osmoDenom}` }] }] },
});
/** The stream's copy of transaction `t`. */
const streamed = (t: any) => ({ result: { data: { value: { TxResult: { height: t.height, result: { code: 0, events: t.tx_result.events } } } }, events: { 'tx.hash': [t.hash] } } });

interface Chain {
  head: number;
  /** The NAM transfer query's transactions, newest first. */
  list: any[];
  /** Hashes the node's tx index does not give yet. */
  unindexed?: Set<string>;
  /** How many blocks below the head the node's /status answers. */
  statusLag?: number;
  /** Called on a block read, before it is answered. */
  onBlock?: () => Promise<void>;
}

/**
 * The node over `chain` (a page past the end answers HTTP 500, as CometBFT does), and a D1 stand-in whose first
 * `fails` batches wait for `gate` and then throw (a transient D1 error): the stream's write, when it goes first.
 */
async function world(chain: Chain, opts: { fails?: number; gate?: Promise<void> } = {}) {
  const real = testD1();
  let fail = opts.fails ?? 0;
  const db: any = {
    prepare: (s: string) => real.prepare(s),
    batch: async (st: any[]) => {
      if (fail-- > 0) { await opts.gate; throw new Error('D1_ERROR: Network connection lost.'); }
      return real.batch(st);
    },
  };
  await real.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('osmosis.cursor', ?, 0)").bind(JSON.stringify({ height: CURSOR, at: 1 })).run();
  const calls = { transferPages: 0 };
  vi.stubGlobal('fetch', vi.fn(async (u: string) => {
    const url = new URL(String(u));
    if (url.pathname.endsWith('/status')) return Response.json({ result: { sync_info: { latest_block_height: String(chain.head - (chain.statusLag ?? 0)) } } });
    if (url.pathname.endsWith('/block')) {
      await chain.onBlock?.();
      return Response.json({ result: { block: { header: { time: new Date(Date.now() - 60_000).toISOString() } } } });
    }
    const q = url.searchParams.get('query') ?? '';
    const per = Number(url.searchParams.get('per_page')), page = Number(url.searchParams.get('page'));
    const l = q.includes('transfer.amount') ? chain.list.filter((t) => !chain.unindexed?.has(t.hash)) : [];
    if (l.length) calls.transferPages++;
    const pages = Math.max(1, Math.ceil(l.length / per));
    if (page > pages) return Response.json({ jsonrpc: '2.0', id: -1, error: { code: -32603, message: 'Internal error', data: `page should be within [1, ${pages}] range, given ${page}` } }, { status: 500 });
    return Response.json({ result: { txs: l.slice((page - 1) * per, page * per), total_count: String(l.length) } });
  }));
  // A new hub over the same D1 is a restart: its seen set, retry list and writes in flight are gone.
  const hub = () => Object.assign(Object.create(LiveHub.prototype), {
    env: { DB: db },
    seenOsmoTx: new Set<string>(), osmoRetryTx: new Map<string, number>(), osmoWriting: new Map(), osmoRetryFrom: null, osmoRetryGen: 0, osmoHeight: 0,
    sessions: new Set(), lastPriceUsd: null, needSweep: false,
    osmoCtx: { poolAddrs: new Map(), priceUsd: null, assets: new Map() },
    quote: new HubQuote(async () => null, async () => null),
  }) as any;
  const rows = (hash: string) => (real.raw.prepare('SELECT COUNT(*) AS n FROM flows WHERE tx_hash = ?').get(hash) as any).n as number;
  const stored = () => (real.raw.prepare("SELECT COUNT(DISTINCT tx_hash) AS n FROM flows WHERE tx_hash LIKE 'BB%'").get() as any).n as number;
  const cursor = () => JSON.parse((real.raw.prepare("SELECT value FROM kv WHERE key='osmosis.cursor'").get() as any).value);
  return { hub, rows, stored, cursor, calls };
}

/** 300 NAM transfers above the cursor (more than one search's pages) and 60 below it. */
const backlog = () => [...Array.from({ length: 300 }, (_, i) => xfer(i, CURSOR + 2000 - i)), ...Array.from({ length: 60 }, (_, i) => xfer(1000 + i, CURSOR - i))];
const gated = () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  return { gate, release };
};
async function toHead(w: Awaited<ReturnType<typeof world>>, hub: any, chain: Chain, most = 6) {
  for (let n = 0; n < most && w.cursor().height !== chain.head; n++) await hub.sweepOsmosis();
}

describe('a place and a stream transaction not yet known written', () => {
  it('a write still running when the search ends, which then throws, and a restart: the transaction is read again and written', async () => {
    const chain: Chain = { head: CURSOR + 2100, list: backlog() };
    const { gate, release } = gated();
    const w = await world(chain, { fails: 1, gate });
    const hub = w.hub();
    // the stream's copy of the 61st newest; its write runs through the whole search
    const t = chain.list[60];
    const write = hub.handleOsmosisMessage(streamed(t)).catch((e: unknown) => e);
    await hub.sweepOsmosis();
    const place = w.cursor().resume?.[Q];
    console.log('after the first search', JSON.stringify(w.cursor()));
    expect(w.cursor().height).toBe(CURSOR);
    // the place ends above the transaction: at the 60th newest
    expect(place.last).toBe(chain.list[59].hash);
    expect(place.low).toBeGreaterThan(Number(t.height));
    release();
    expect(String(await write)).toMatch(/D1_ERROR/);
    expect(w.rows(t.hash)).toBe(0);
    const again = w.hub();
    await toHead(w, again, chain);
    console.log('after a restart', JSON.stringify(w.cursor()), 'the stream transaction rows', w.rows(t.hash));
    expect(w.cursor().height).toBe(chain.head);
    expect(w.rows(t.hash)).toBe(1);
    expect(w.stored()).toBe(300);
  }, 120_000);

  it('a write that throws while the search reads a block, and a restart: the transaction is read again and written', async () => {
    const chain: Chain = { head: CURSOR + 2100, list: backlog() };
    const { gate, release } = gated();
    const w = await world(chain, { fails: 1, gate });
    const hub = w.hub();
    const t = chain.list[60];
    const write = hub.handleOsmosisMessage(streamed(t)).catch((e: unknown) => e);
    // the stream's write throws during the search's first block read: when the place is cut the transaction is in
    // the retry list, no longer being written
    chain.onBlock = async () => { chain.onBlock = undefined; release(); await write; };
    await hub.sweepOsmosis();
    expect(hub.osmoWriting.size).toBe(0);
    expect(hub.osmoRetryTx.has(t.hash)).toBe(true);
    expect(w.cursor().resume?.[Q]?.low).toBeGreaterThan(Number(t.height));
    await toHead(w, w.hub(), chain);
    expect(w.cursor().height).toBe(chain.head);
    expect(w.rows(t.hash)).toBe(1);
  }, 120_000);

  it('the same hub: the next search goes on from the place and writes the transaction', async () => {
    const chain: Chain = { head: CURSOR + 2100, list: backlog() };
    const { gate, release } = gated();
    const w = await world(chain, { fails: 1, gate });
    const hub = w.hub();
    const t = chain.list[60];
    const write = hub.handleOsmosisMessage(streamed(t)).catch((e: unknown) => e);
    await hub.sweepOsmosis();
    release();
    expect(String(await write)).toMatch(/D1_ERROR/);
    await toHead(w, hub, chain);
    expect(w.cursor().height).toBe(chain.head);
    expect(w.rows(t.hash)).toBe(1);
    expect(w.stored()).toBe(300);
  }, 120_000);

  it('the 3rd newest, 48 more transfers before the next search, and a restart: the transaction is written', async () => {
    const chain: Chain = { head: CURSOR + 2001, list: backlog() };
    const { gate, release } = gated();
    const w = await world(chain, { fails: 1, gate });
    const hub = w.hub();
    const t = chain.list[2];
    const write = hub.handleOsmosisMessage(streamed(t)).catch((e: unknown) => e);
    await hub.sweepOsmosis();
    release();
    await write;
    chain.list.unshift(...Array.from({ length: 48 }, (_, k) => xfer(2000 + k, CURSOR + 2100 - k)));
    chain.head = CURSOR + 2101;
    await toHead(w, w.hub(), chain);
    console.log('end', JSON.stringify(w.cursor()), 'the stream transaction rows', w.rows(t.hash), 'transfers stored', w.stored());
    expect(w.cursor().height).toBe(chain.head);
    expect(w.rows(t.hash)).toBe(1);
    expect(w.stored()).toBe(348);
  }, 120_000);

  it('a stream transaction the node\'s index does not give yet: the place ends above its block, and after a restart it is written', async () => {
    // The newest block, at the head, holds two transfers the node's index does not give yet; the stream has the second.
    const older = Array.from({ length: 300 }, (_, i) => xfer(i, CURSOR + 1999 - i));
    const x = xfer(500, CURSOR + 2000), t = xfer(501, CURSOR + 2000);
    const chain: Chain = { head: CURSOR + 2000, list: [x, t, ...older], unindexed: new Set([x.hash, t.hash]) };
    const { gate, release } = gated();
    const w = await world(chain, { fails: 1, gate });
    const hub = w.hub();
    const write = hub.handleOsmosisMessage(streamed(t)).catch((e: unknown) => e);
    await hub.sweepOsmosis();
    release();
    expect(String(await write)).toMatch(/D1_ERROR/);
    // the index gives them now, 49 more transfers came, and the hub restarted: read from the place's top, the stream
    // transaction would be the 51st newest, past the first page
    chain.unindexed = undefined;
    chain.list.unshift(...Array.from({ length: 49 }, (_, k) => xfer(2000 + k, CURSOR + 2100 - k)));
    chain.head = CURSOR + 2101;
    await toHead(w, w.hub(), chain);
    console.log('end', JSON.stringify(w.cursor()), 'the stream transaction rows', w.rows(t.hash));
    expect(w.cursor().height).toBe(chain.head);
    expect(w.rows(t.hash)).toBe(1);
    expect(w.stored()).toBe(351);
  }, 120_000);

  it('a stream message without a height: the place ends above the transaction\'s hash, and after a restart it is written', async () => {
    const chain: Chain = { head: CURSOR + 2100, list: backlog() };
    const { gate, release } = gated();
    const w = await world(chain, { fails: 1, gate });
    const hub = w.hub();
    const t = chain.list[60];
    const msg = streamed(t);
    delete (msg.result.data.value.TxResult as any).height;
    const write = hub.handleOsmosisMessage(msg).catch((e: unknown) => e);
    await hub.sweepOsmosis();
    expect(w.cursor().resume?.[Q]?.last).toBe(chain.list[59].hash);
    release();
    expect(String(await write)).toMatch(/D1_ERROR/);
    await toHead(w, w.hub(), chain);
    expect(w.cursor().height).toBe(chain.head);
    expect(w.rows(t.hash)).toBe(1);
  }, 120_000);

  it('a stream write that stored its rows before the place was cut: the place reaches as deep as before', async () => {
    const chain: Chain = { head: CURSOR + 2100, list: backlog() };
    const w = await world(chain);
    const hub = w.hub();
    const t = chain.list[60];
    await hub.handleOsmosisMessage(streamed(t));
    expect(w.rows(t.hash)).toBe(1);
    await hub.sweepOsmosis();
    const place = w.cursor().resume?.[Q];
    expect(place.n).toBe(OSMOSIS_SWEEP_PAGES * 50);
    expect(place.last).toBe(chain.list[OSMOSIS_SWEEP_PAGES * 50 - 1].hash);
    await toHead(w, w.hub(), chain);
    expect(w.cursor().height).toBe(chain.head);
    expect(w.stored()).toBe(300);
  }, 120_000);
});

describe('a place and the head', () => {
  /**
   * A 1,000-transfer backlog (and the query's history below the cursor) read through search by search; `lagAt`: the
   * search whose /status is 3 blocks behind.
   */
  async function catchUp(lagAt: number | null) {
    const list = [...Array.from({ length: 1000 }, (_, i) => xfer(i, CURSOR + 100_000 - i * 90)), ...Array.from({ length: 60 }, (_, i) => xfer(5000 + i, CURSOR - i))];
    const chain: Chain = { head: CURSOR + 100_100, list };
    const w = await world(chain);
    const hub = w.hub();
    const depths: number[] = [];
    let searches = 0;
    for (; searches < 40 && w.cursor().height !== chain.head; searches++) {
      // the search at `lagAt` runs seconds after the one before (no new block), and its /status is 3 blocks behind
      chain.statusLag = searches === lagAt ? 3 : 0;
      if (searches !== lagAt && searches > 0) chain.head += 5;
      await hub.sweepOsmosis();
      depths.push(w.cursor().resume?.[Q]?.n ?? -1);
    }
    return { searches, depths, pages: w.calls.transferPages, stored: w.stored(), reached: w.cursor().height === chain.head };
  }

  it('a search whose head is a few blocks below the place\'s top goes on from the place: the catch-up keeps its progress', async () => {
    const calm = await catchUp(null);
    const lagged = await catchUp(4);
    console.log('calm  : searches', calm.searches, 'transfer pages', calm.pages, 'place n per search', calm.depths.join(','));
    console.log('lagged: searches', lagged.searches, 'transfer pages', lagged.pages, 'place n per search', lagged.depths.join(','));
    expect(lagged.depths[4]).toBeGreaterThanOrEqual(lagged.depths[3]);
    expect(lagged.searches).toBeLessThanOrEqual(calm.searches + 1);
    expect(lagged.reached).toBe(true);
    expect(lagged.stored).toBe(1000);
  }, 120_000);

  it('more transfers than the search\'s pages above the place\'s top: a place from the newest, and the catch-up still reaches the head', async () => {
    const chain: Chain = { head: CURSOR + 2100, list: backlog() };
    const w = await world(chain);
    const hub = w.hub();
    await hub.sweepOsmosis();
    expect(w.cursor().resume?.[Q]?.n).toBe(200);
    // a burst of 230 between two searches, then none
    chain.list.unshift(...Array.from({ length: 230 }, (_, k) => xfer(3000 + k, CURSOR + 2400 - k)));
    chain.head = CURSOR + 2500;
    await hub.sweepOsmosis();
    expect(w.cursor().resume?.[Q]?.top).toBe(chain.head);
    await toHead(w, hub, chain, 8);
    console.log('end', JSON.stringify(w.cursor()), 'transfers stored', w.stored());
    expect(w.cursor().height).toBe(chain.head);
    expect(w.stored()).toBe(530);
  }, 120_000);
});
