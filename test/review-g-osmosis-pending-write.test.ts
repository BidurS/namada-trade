// Security review (2026-10-22), Osmosis catch-up cursor and stream writes: the catch-up search never moves
// osmosis.cursor past a stream transaction whose rows are not yet known written.
//
// Before: a search that finished while a stream write was still running skipped the transaction as seen and moved
// the cursor to the head. When that write then threw, only the hub's memory (osmoRetryTx, osmoRetryFrom) knew to read
// it again; a restart of the Durable Object before the next search (a deploy, an eviction) emptied that memory, and
// the next search started above the transaction, so its flow, moves, address link and alert were lost for good.
// Now the cursor stays just below a stream transaction still being written, or whose write threw after the search
// began, so the first search after a restart reads it again.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { testD1 } from './d1-sqlite';
import { NAM } from '../worker/src/config';

// LiveHub is a Durable Object; only its Osmosis stream and catch-up search are exercised here, on instances made
// without the constructor (which would open sockets and fetch prices). A new instance over the same D1 is a restart.
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import { LiveHub, OSMOSIS_SWEEP_EVERY_MS } from '../worker/src/live-hub';
import { HubQuote } from '../worker/src/live-quote';

afterEach(() => vi.unstubAllGlobals());

// The real bridge receive test/fixtures/osmo_ibc_recv.json (1 NAM into Osmosis at height 72,463,305): one ibc_in
// flow, its moves and one address link.
const fx = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'osmo_ibc_recv.json'), 'utf8'))[0];
const HASH = String(fx.hash).toUpperCase();
const HEIGHT = Number(fx.height);
const HEAD = HEIGHT + 5;
const CURSOR = HEIGHT - 5;

/**
 * A D1 stand-in whose first `fails` batches throw (after `gate`, when given), the Osmosis node stubbed to answer the
 * receive at its height under the recv_packet query, the stream's message for it at `streamHeight`, and a maker of
 * hubs over them.
 */
async function world(gate?: Promise<void>, streamHeight = HEIGHT, fails = 1) {
  const real = testD1();
  let fail = fails;
  const db: any = {
    prepare: (s: string) => real.prepare(s),
    batch: async (st: any[]) => {
      if (fail-- > 0) { await gate; throw new Error('D1_ERROR: Network connection lost.'); }
      return real.batch(st);
    },
  };
  vi.stubGlobal('fetch', vi.fn(async (u: string) => {
    const url = String(u);
    if (url.endsWith('/status')) return Response.json({ result: { sync_info: { latest_block_height: String(HEAD) } } });
    if (url.includes('/tx_search')) return Response.json({ result: { txs: decodeURIComponent(url).includes('recv_packet') ? [fx] : [] } });
    if (url.includes(`/block?height=${HEIGHT}`)) return Response.json({ result: { block: { header: { time: '2026-10-20T00:00:00Z' } } } });
    throw new Error(`unexpected ${url}`);
  }));
  const hub = () => Object.assign(Object.create(LiveHub.prototype), {
    env: { DB: db },
    seenOsmoTx: new Set<string>(), osmoRetryTx: new Map<string, number>(), osmoWriting: new Map(), osmoRetryFrom: null, osmoRetryGen: 0, osmoHeight: 0,
    sessions: new Set(), lastPriceUsd: null,
    osmoCtx: { poolAddrs: new Map(), priceUsd: null, assets: new Map() },
    quote: new HubQuote(async () => null, async () => null),
  }) as any;
  await real.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('osmosis.cursor', ?, 0)").bind(JSON.stringify({ height: CURSOR, at: 1 })).run();
  const msg = { result: { data: { value: { TxResult: { height: String(streamHeight), result: { code: 0, events: fx.tx_result.events } } } }, events: { 'tx.hash': [fx.hash] } } };
  const rows = () => real.raw.prepare('SELECT COUNT(*) AS n FROM flows WHERE tx_hash = ?').get(HASH).n as number;
  const links = () => (real.raw.prepare('SELECT SUM(transfers) AS n FROM address_links').get().n ?? 0) as number;
  const cursor = () => JSON.parse(real.raw.prepare("SELECT value FROM kv WHERE key='osmosis.cursor'").get().value).height as number;
  return { hub, msg, rows, links, cursor };
}

describe('the catch-up cursor never passes a stream transaction not yet known written', () => {
  it('a search that finishes while the write runs keeps the cursor below it, and after a restart the write that threw is redone', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const w = await world(gate);
    const hub = w.hub();
    const streamed = hub.handleOsmosisMessage(w.msg).catch((e: unknown) => e);
    await hub.sweepOsmosis();
    expect(w.cursor()).toBe(HEIGHT - 1);
    release();
    expect(String(await streamed)).toMatch(/D1_ERROR/);
    expect(w.rows()).toBe(0);
    // the Durable Object restarts before the next search: its seen set and retry list are gone
    await w.hub().sweepOsmosis();
    expect(w.rows()).toBe(1);
    expect(w.links()).toBe(1);
    expect(w.cursor()).toBe(HEAD);
  });

  it('a write that throws after the search passed it keeps the cursor below it too', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const w = await world(gate);
    const hub = w.hub();
    const streamed = hub.handleOsmosisMessage(w.msg).catch((e: unknown) => e);
    // a bank send of 20,000 NAM the stream missed, two heights later, found after the receive: while the search reads
    // its block time the stream's write of the receive throws
    const missed = { hash: 'g58missed', height: String(HEIGHT + 2), tx_result: { code: 0, events: [{ type: 'transfer', attributes: [
      { key: 'recipient', value: 'osmo1g58recv' }, { key: 'sender', value: 'osmo1g58send' }, { key: 'amount', value: `20000000000${NAM.osmoDenom}` }, { key: 'msg_index', value: '0' },
    ] }] } };
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      const url = String(u);
      if (url.endsWith('/status')) return Response.json({ result: { sync_info: { latest_block_height: String(HEAD) } } });
      if (url.includes('/tx_search')) {
        const q = decodeURIComponent(url);
        return Response.json({ result: { txs: q.includes('recv_packet') ? [fx] : q.includes('send_packet') ? [missed] : [] } });
      }
      if (url.includes(`/block?height=${HEIGHT + 2}`)) { release(); await streamed; }
      if (url.includes('/block?height=')) return Response.json({ result: { block: { header: { time: '2026-10-20T00:00:00Z' } } } });
      throw new Error(`unexpected ${url}`);
    }));
    await hub.sweepOsmosis();
    expect(hub.osmoWriting.size).toBe(0);
    expect(hub.osmoRetryTx.has(HASH)).toBe(true);
    expect(w.rows()).toBe(0);
    expect(w.cursor()).toBe(HEIGHT - 1);
    await w.hub().sweepOsmosis();
    expect(w.rows()).toBe(1);
  });

  it('with nothing being written or retried the cursor moves to the head, as before', async () => {
    const w = await world(undefined, HEIGHT, 0);
    await w.hub().sweepOsmosis();
    expect(w.rows()).toBe(1);
    expect(w.cursor()).toBe(HEAD);
  });

  it('a write that runs longer than a search interval is not waited on', async () => {
    const w = await world(undefined, HEIGHT, 0);
    const hub = w.hub();
    hub.osmoWriting.set(HASH, { height: HEIGHT, since: Date.now() - OSMOSIS_SWEEP_EVERY_MS - 1000 });
    hub.seenOsmoTx.add(HASH);
    await hub.sweepOsmosis();
    expect(w.cursor()).toBe(HEAD);
  });

  it('a stream height below the cursor never moves the cursor back', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const w = await world(gate, 1);
    const hub = w.hub();
    const streamed = hub.handleOsmosisMessage(w.msg).catch((e: unknown) => e);
    await hub.sweepOsmosis();
    expect(w.cursor()).toBe(CURSOR);
    release();
    await streamed;
  });
});
