// Security review (2026-10-22), the catch-up place and a transaction not yet indexed in the newest block: a search
// that did not finish keeps, per query, the place the next one goes on from (osmosis.cursor `resume`), and that place
// must never cover a transaction it did not look at.
//
// A search went on from the last search's place while the only new transaction was a stream transaction in the newest
// block whose write was running (it then threw), and the node's index did not give it yet. Nothing above the place's
// top was read, so the held block cut no row there; the place written kept its last but took this search's head as
// top, and so covered the block of a transaction never read. On the same hub the next search dropped that place (its
// retry list held the block) and started the catch-up again from the newest; after a restart the transaction could be
// passed over for good. Now the place gone on from is written back, its top below that block.
//
// A transaction of the place's own region read again and not written (no block time, no quote, the deadline) was let
// through as the place's own, so the place written went on past it, though such a one shows the place was wrong
// about it: the search that took its block as top did not get it from the node's index. Now the place is cut at it
// and is not written back.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testD1 } from './d1-sqlite';
import { NAM } from '../worker/src/config';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import { LiveHub } from '../worker/src/live-hub';
import { HubQuote } from '../worker/src/live-quote';

afterEach(() => vi.unstubAllGlobals());

const CURSOR = 1_000_000;
const Q = `transfer.amount CONTAINS '${NAM.osmoHash}'`;
const POOL = "token_swapped.pool_id='3005'";
const hashOf = (p: string, i: number) => `${p}${String(i).padStart(64 - p.length, '0')}`;
/** A 50 NAM bank transfer: one transfer flow. */
const xfer = (i: number, height: number, p = 'BB') => ({
  hash: hashOf(p, i), height: String(height), tx: '',
  tx_result: { code: 0, events: [{ type: 'transfer', attributes: [{ key: 'recipient', value: `osmo1recv${p}${i}` }, { key: 'sender', value: `osmo1send${p}${i}` }, { key: 'amount', value: `${50 * 1e6}${NAM.osmoDenom}` }] }] },
});
/** The stream's copy of transaction `t`. */
const streamed = (t: any) => ({ result: { data: { value: { TxResult: { height: t.height, result: { code: 0, events: t.tx_result.events } } } }, events: { 'tx.hash': [t.hash] } } });

interface Chain {
  head: number;
  /** The NAM transfer query's transactions, newest first. */
  list: any[];
  /** The pool query's transactions, newest first (none when not given). */
  pool?: any[];
  /** Hashes the node's tx index does not give yet. */
  unindexed?: Set<string>;
  /** Heights whose block read answers no time. */
  noTime?: Set<number>;
}

/**
 * The node over `chain` (a page past the end answers HTTP 500, as CometBFT does), and a D1 stand-in whose next batch,
 * once `failNext` is called, waits for the gate and then throws (a transient D1 error): the stream's write.
 */
async function world(chain: Chain) {
  const real = testD1();
  let fail = 0;
  let gate: Promise<void> | undefined;
  const db: any = {
    failNext: (g: Promise<void>) => { fail = 1; gate = g; },
    prepare: (s: string) => real.prepare(s),
    batch: async (st: any[]) => {
      if (fail-- > 0) { await gate; throw new Error('D1_ERROR: Network connection lost.'); }
      return real.batch(st);
    },
  };
  await real.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('osmosis.cursor', ?, 0)").bind(JSON.stringify({ height: CURSOR, at: 1 })).run();
  vi.stubGlobal('fetch', vi.fn(async (u: string) => {
    const url = new URL(String(u));
    if (url.pathname.endsWith('/status')) return Response.json({ result: { sync_info: { latest_block_height: String(chain.head) } } });
    if (url.pathname.endsWith('/block')) {
      if (chain.noTime?.has(Number(url.searchParams.get('height')))) return Response.json({ result: { block: { header: {} } } });
      return Response.json({ result: { block: { header: { time: new Date(Date.now() - 60_000).toISOString() } } } });
    }
    const q = url.searchParams.get('query') ?? '';
    const per = Number(url.searchParams.get('per_page')), page = Number(url.searchParams.get('page'));
    const all = q.includes('transfer.amount') ? chain.list : q.includes('token_swapped') ? chain.pool ?? [] : [];
    const l = all.filter((t) => !chain.unindexed?.has(t.hash));
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
  const stored = (p = 'BB') => (real.raw.prepare('SELECT COUNT(DISTINCT tx_hash) AS n FROM flows WHERE tx_hash LIKE ?').get(`${p}%`) as any).n as number;
  const cursor = () => JSON.parse((real.raw.prepare("SELECT value FROM kv WHERE key='osmosis.cursor'").get() as any).value);
  return { hub, rows, stored, cursor, db };
}

const gated = () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  return { gate, release };
};
async function toHead(w: Awaited<ReturnType<typeof world>>, hub: any, chain: Chain, most: number) {
  for (let n = 0; n < most && w.cursor().height !== chain.head; n++) await hub.sweepOsmosis();
}

/** 1,000 transfers above the cursor, 90 blocks apart, and 60 below it: a catch-up of several searches. */
const deep = (p = 'BB', from = 0) => [
  ...Array.from({ length: 1000 }, (_, i) => xfer(from + i, CURSOR + 100_000 - i * 90, p)),
  ...Array.from({ length: 60 }, (_, i) => xfer(from + 5000 + i, CURSOR - i, p)),
];

describe('a place, and a stream transaction in the newest block not yet indexed', () => {
  /**
   * A first search leaves a place 200 deep. Five minutes on, the only new transfer is in the newest block and
   * streamed; its write runs through the next search and then throws, and the node's index does not give it yet when
   * that search reads the newest page.
   */
  async function setup() {
    const chain: Chain = { head: CURSOR + 100_100, list: deep() };
    const { gate, release } = gated();
    const w = await world(chain);
    const hub = w.hub();
    await hub.sweepOsmosis();
    const p0 = w.cursor().resume?.[Q];
    expect(p0.n).toBe(200);
    const r = xfer(9000, CURSOR + 100_200);
    chain.list.unshift(r);
    chain.head = CURSOR + 100_200;
    chain.unindexed = new Set([r.hash]);
    w.db.failNext(gate);
    const write = hub.handleOsmosisMessage(streamed(r)).catch((e: unknown) => e);
    await hub.sweepOsmosis();
    const p1 = w.cursor().resume?.[Q];
    console.log('place before', JSON.stringify(p0), 'after', JSON.stringify(p1));
    release();
    expect(String(await write)).toMatch(/D1_ERROR/);
    chain.unindexed = undefined;
    return { chain, w, hub, r, p0, p1 };
  }

  it('the place written ends below the block of the stream transaction not yet known written', async () => {
    const { r, p0, p1 } = await setup();
    // The place gone on from is written back: its top is below the block, which the search did not read.
    expect(p1).toEqual(p0);
    expect(p1.top < Number(r.height) || p1.low > Number(r.height)).toBe(true);
  }, 120_000);

  it('the same hub: the next search goes on from the place, writes the transaction, and the catch-up keeps its progress', async () => {
    const { w, hub, chain, r, p1 } = await setup();
    await hub.sweepOsmosis();
    const p2 = w.cursor().resume?.[Q];
    console.log('same hub, next place', JSON.stringify(p2));
    expect(w.rows(r.hash)).toBe(1);
    expect(p2.n).toBeGreaterThan(p1.n);
    expect(p2.low).toBeLessThan(p1.low);
    await toHead(w, hub, chain, 20);
    expect(w.cursor().height).toBe(chain.head);
    expect(w.stored()).toBe(1001);
  }, 120_000);

  it('a restart, and the next search cannot read the transaction\'s block time: the transaction is still written', async () => {
    const { w, chain, r } = await setup();
    const again = w.hub();
    // 60 transfers in the five minutes before the next search, above the stream transaction's block
    chain.list.unshift(...Array.from({ length: 60 }, (_, k) => xfer(9100 + k, CURSOR + 100_300 - k)));
    chain.head = CURSOR + 100_300;
    chain.noTime = new Set([Number(r.height)]);
    await again.sweepOsmosis();
    console.log('after a restart', JSON.stringify(w.cursor().resume?.[Q]));
    chain.noTime = undefined;
    await toHead(w, again, chain, 20);
    console.log('end', JSON.stringify(w.cursor()), 'stream transaction rows', w.rows(r.hash), 'stored', w.stored());
    expect(w.cursor().height).toBe(chain.head);
    expect(w.rows(r.hash)).toBe(1);
    expect(w.stored()).toBe(1061);
  }, 120_000);

  it('a walk that goes on from the place down to the floor: the place written still ends below the block', async () => {
    // The pool query's backlog keeps the search from finishing; the transfer query has 200 transfers above the cursor,
    // so the first search leaves it a place whose last is the lowest of them, and the next one reads it to the floor.
    const transfers = [...Array.from({ length: 200 }, (_, i) => xfer(i, CURSOR + 99_000 - i * 10)), ...Array.from({ length: 60 }, (_, i) => xfer(5000 + i, CURSOR - i))];
    const chain: Chain = { head: CURSOR + 100_100, list: transfers, pool: deep('CC', 0) };
    const { gate, release } = gated();
    const w = await world(chain);
    const hub = w.hub();
    await hub.sweepOsmosis();
    const p0 = w.cursor().resume?.[Q];
    expect(p0.n).toBe(200);
    const r = xfer(9000, CURSOR + 100_200);
    chain.list.unshift(r);
    chain.head = CURSOR + 100_200;
    chain.unindexed = new Set([r.hash]);
    w.db.failNext(gate);
    const write = hub.handleOsmosisMessage(streamed(r)).catch((e: unknown) => e);
    await hub.sweepOsmosis();
    const p1 = w.cursor().resume?.[Q];
    console.log('read to the floor: place before', JSON.stringify(p0), 'after', JSON.stringify(p1));
    release();
    expect(String(await write)).toMatch(/D1_ERROR/);
    chain.unindexed = undefined;
    expect(p1.top).toBeLessThan(Number(r.height));
    await toHead(w, hub, chain, 20);
    expect(w.cursor().height).toBe(chain.head);
    expect(w.rows(r.hash)).toBe(1);
    expect(w.stored()).toBe(201);
    expect(w.stored('CC')).toBe(1000);
  }, 120_000);
});

describe('a transaction of the place\'s own region read again and not written', () => {
  it('a transfer the node did not give at the head the place took as top, then its block time unreadable: the place is cut at it, and it is written', async () => {
    // A transfer in the head block of the first search that the node's index did not give yet: the place that search
    // writes takes that head as top.
    const t = xfer(7000, CURSOR + 100_100);
    const chain: Chain = { head: CURSOR + 100_100, list: [t, ...deep()], unindexed: new Set([t.hash]) };
    const w = await world(chain);
    const hub = w.hub();
    await hub.sweepOsmosis();
    const p0 = w.cursor().resume?.[Q];
    expect(p0.top).toBe(Number(t.height));
    expect(p0.n).toBe(200);
    // The index gives it now, 60 transfers came above it, and the next search cannot read its block time.
    chain.unindexed = undefined;
    chain.list.unshift(...Array.from({ length: 60 }, (_, k) => xfer(8000 + k, CURSOR + 100_160 - k)));
    chain.head = CURSOR + 100_200;
    chain.noTime = new Set([Number(t.height)]);
    await hub.sweepOsmosis();
    const p1 = w.cursor().resume?.[Q];
    console.log('place before', JSON.stringify(p0), 'after', JSON.stringify(p1));
    expect(w.rows(t.hash)).toBe(0);
    // The place ends at the newest transfer read before it, not past it.
    expect(p1.low).toBeGreaterThan(Number(t.height));
    expect(p1.n).toBe(60);
    chain.noTime = undefined;
    await toHead(w, hub, chain, 20);
    console.log('end', JSON.stringify(w.cursor()), 'transfer rows', w.rows(t.hash), 'stored', w.stored());
    expect(w.cursor().height).toBe(chain.head);
    expect(w.rows(t.hash)).toBe(1);
    expect(w.stored()).toBe(1061);
  }, 120_000);
});
