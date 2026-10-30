// Scale plan 2026-10-29, Stage 1 item 7: osmosis-rpc.publicnode.com answers each request from one of two backends,
// one holding about 16 hours of blocks (earliest 73,431,644) and one holding them since 2026-08-10 (earliest
// 68,229,727); on alternate requests its tx_search counted 123 and 3,913 swaps of pool 3005 (checked 2026-10-29). The
// catch-up search reads each query newest first and took a short page above its cursor as the end of the query, so
// after an outage of the searches longer than 16 hours, an answer from the shallow backend moved the cursor past every
// transaction below that backend's history, and the stream's losses there were never read. Now a short answer ends a
// query only when the nodes are known to hold the blocks it answers for: the search's one /status gives its node's
// earliest_block_height, the cursor keeps the shallowest depth seen (nodeDepth), and an answer for a range that begins
// below it is not taken: the cursor stays, the cursor's `shallow` note says why, and an answer that reaches below the
// cursor (the deep backend) finishes the query. A range inside the shallow depth (the searches every five minutes) is
// read as before.
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import { LiveHub, OSMOSIS_DEPTH_KEEP_MS, nodeDepth } from '../worker/src/live-hub';
import { HubQuote } from '../worker/src/live-quote';
import { NAM } from '../worker/src/config';
import { testD1, type TestD1 } from './d1-sqlite';

afterEach(() => vi.unstubAllGlobals());

const CURSOR = 1_000_000;
const HEAD = 1_100_000;
/** The shallow backend's earliest block: it holds the newest 50,000 (the deep one holds every block). */
const SHALLOW = 1_050_000;
const HOUR = 3_600_000;
type Key = 'swap' | 'transfer' | 'recv' | 'send';
type Backend = 'deep' | 'shallow';
const hashOf = (p: string, i: number) => `${p}${String(i).padStart(64 - p.length, '0')}`;

/** A 50 NAM bank transfer: one transfer flow. */
const xfer = (p: string, i: number, height: number) => ({
  hash: hashOf(p, i), height: String(height), tx: '',
  tx_result: { code: 0, events: [{ type: 'transfer', attributes: [{ key: 'recipient', value: `osmo1recv${i}` }, { key: 'sender', value: `osmo1send${i}` }, { key: 'amount', value: `${50 * 1e6}${NAM.osmoDenom}` }] }] },
});
/** Each query's transactions, newest first: ten recent transfers and one the stream missed 80,000 blocks back; and in every query one below the cursor. */
const lists: Record<Key, any[]> = {
  transfer: [...Array.from({ length: 10 }, (_, i) => xfer('AA', i, HEAD - 100 - i * 10)), xfer('DD', 0, 1_020_000), xfer('OLD', 0, CURSOR - 10_000)],
  swap: [xfer('OLD', 1, CURSOR - 20_000)],
  recv: [xfer('OLD', 2, CURSOR - 30_000)],
  send: [xfer('OLD', 3, CURSOR - 40_000)],
};

/** The public node: each request answered by the backend `pick` names (its /status and its tx_search as that backend's). */
function node(pick: (what: 'status' | 'search', n: number) => Backend) {
  const calls = { status: 0, search: [] as string[] };
  let n = 0;
  vi.stubGlobal('fetch', vi.fn(async (u: string) => {
    const url = new URL(String(u));
    if (url.pathname.endsWith('/status')) {
      calls.status++;
      const b = pick('status', n++);
      return Response.json({ result: { sync_info: { latest_block_height: String(HEAD), earliest_block_height: String(b === 'deep' ? 1 : SHALLOW) } } });
    }
    if (url.pathname.endsWith('/block')) return Response.json({ result: { block: { header: { time: new Date(Date.now() - 60_000).toISOString() } } } });
    if (!url.pathname.endsWith('/tx_search')) throw new Error(`unexpected ${url}`);
    const q = url.searchParams.get('query') ?? '';
    const key: Key = q.includes('token_swapped') ? 'swap' : q.includes('transfer.amount') ? 'transfer' : q.includes('recv_packet') ? 'recv' : 'send';
    const per = Number(url.searchParams.get('per_page')), page = Number(url.searchParams.get('page'));
    const b = pick('search', n++);
    calls.search.push(`${b} ${key} ${page}`);
    const list = lists[key].filter((t) => b === 'deep' || Number(t.height) >= SHALLOW);
    // past its last page a node answers an error, as CometBFT does
    if (page > 1 && (page - 1) * per >= list.length) return Response.json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error', data: `page should be within [1, ${Math.max(1, Math.ceil(list.length / per))}] range, given ${page}` } }, { status: 500 });
    return Response.json({ result: { txs: list.slice((page - 1) * per, page * per), total_count: String(list.length) } });
  }));
  return calls;
}
function hubOn(db: TestD1) {
  return Object.assign(Object.create(LiveHub.prototype), {
    env: { DB: db },
    seenOsmoTx: new Set<string>(), osmoRetryTx: new Map<string, number>(), osmoWriting: new Map(), osmoRetryFrom: null, osmoRetryGen: 0, osmoHeight: 0,
    sessions: new Set(), lastPriceUsd: null, needSweep: false,
    osmoCtx: { poolAddrs: new Map(), priceUsd: null, assets: new Map() },
    quote: new HubQuote(async () => null, async () => null),
  }) as any;
}
async function seeded(cursor: object) {
  const db = testD1();
  await db.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('osmosis.cursor', ?, 0)").bind(JSON.stringify(cursor)).run();
  return db;
}
const cursorOf = (db: TestD1) => JSON.parse((db.raw.prepare("SELECT value FROM kv WHERE key='osmosis.cursor'").get() as any).value);
const stored = (db: TestD1, like: string) => (db.raw.prepare('SELECT COUNT(DISTINCT tx_hash) AS n FROM flows WHERE tx_hash LIKE ?').get(like) as any).n as number;

describe('the catch-up search after an outage longer than the shallow backend holds', () => {
  it('the shallow backend\'s short answer does not move the cursor; the deep backend\'s answer writes the missed transfer and moves it', async () => {
    const db = await seeded({ height: CURSOR, at: 1 });
    const hub = hubOn(db);
    const calls = node(() => 'shallow');
    await hub.sweepOsmosis();
    const first = cursorOf(db);
    expect(calls.status).toBe(1);
    // what the shallow backend holds is written; the cursor and its stamp stay, and the note says why
    expect(stored(db, 'AA%')).toBe(10);
    expect(stored(db, 'DD%')).toBe(0);
    expect(first.height).toBe(CURSOR);
    expect(first.at).toBe(1);
    expect(first.depth.blocks).toBe(HEAD - SHALLOW);
    expect(first.error).toMatch(/may not reach back to the cursor/);
    expect(first.shallow.note).toContain(`query "transfer.amount CONTAINS '${NAM.osmoHash}'": the answer ended at block ${HEAD - 190}`);
    expect(first.shallow.note).toContain(`only from ${SHALLOW}, above block ${CURSOR + 1} where the range starts`);

    // a refused answer leaves no place to go on from (the page after it is past what the node holds): the next
    // search reads from the newest again, and the same answer again does not move the cursor either
    expect(first.resume).toBeUndefined();
    await hub.sweepOsmosis();
    const again = cursorOf(db);
    expect(again.height).toBe(CURSOR);
    expect(calls.status).toBe(2);
    expect(calls.search.filter((c) => c.includes(' 2'))).toEqual([]);

    // the deep backend answers: every query reaches below the cursor, the missed transfer is written, the cursor moves
    node(() => 'deep');
    await hub.sweepOsmosis();
    const done = cursorOf(db);
    expect(stored(db, 'DD%')).toBe(1);
    expect(stored(db, 'OLD%')).toBe(0); // below the cursor: looked at before
    expect(done.height).toBe(HEAD);
    expect(done.error).toBeUndefined();
    expect(done.resume).toBeUndefined();
    // the shallowest depth is kept (the deep backend's /status says nothing of the shallow one), and so is the last note
    expect(done.depth.blocks).toBe(HEAD - SHALLOW);
    expect(done.shallow).toEqual(again.shallow);
  });

  it('load balanced: a /status from the deep backend does not vouch for the shallow one that answers the search', async () => {
    // an earlier search's /status came from the shallow backend: its depth is kept with the cursor
    const seen = Date.now() - HOUR;
    const db = await seeded({ height: CURSOR, at: 1, depth: { blocks: HEAD - SHALLOW, at: seen } });
    const hub = hubOn(db);
    node((what) => (what === 'status' ? 'deep' : 'shallow'));
    await hub.sweepOsmosis();
    expect(cursorOf(db).height).toBe(CURSOR);
    expect(stored(db, 'DD%')).toBe(0);
    // the deep backend's depth is far more than twice the kept one: the kept one stands, as it was seen
    expect(cursorOf(db).depth).toEqual({ blocks: HEAD - SHALLOW, at: seen });

    // each request to either backend at random (a fixed seed): the cursor never passes the missed transfer before it
    // is written, and gets to the head once every query has had an answer that reaches below the cursor (a query
    // ended keeps a place, so each has to be ended once, not all four in one search)
    let seed = 7;
    const coin = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648 < 0.5);
    const calls = node(() => (coin() ? 'deep' : 'shallow'));
    let searches = 0;
    for (; searches < 20 && cursorOf(db).height !== HEAD; searches++) {
      await hub.sweepOsmosis();
      if (cursorOf(db).height >= 1_020_000) expect(stored(db, 'DD%')).toBe(1);
    }
    expect(cursorOf(db).height).toBe(HEAD);
    expect(stored(db, 'DD%')).toBe(1);
    expect(searches).toBeGreaterThan(1);
    console.log('searches to the head', searches, 'reads answered by the shallow backend', calls.search.filter((c) => c.startsWith('shallow')).length, 'of', calls.search.length);
    // one /status a search, never more
    expect(calls.status).toBe(searches);
    expect(calls.search.filter((c) => c.startsWith('shallow')).length).toBeGreaterThan(0);
  });

  it('a range inside what the shallow backend holds (searches every five minutes) is read as before', async () => {
    const db = await seeded({ height: HEAD - 200, at: 1 });
    const hub = hubOn(db);
    const calls = node(() => 'shallow');
    await hub.sweepOsmosis();
    const c = cursorOf(db);
    expect(c.height).toBe(HEAD);
    expect(c.error).toBeUndefined();
    expect(c.shallow).toBeUndefined();
    expect(stored(db, 'AA%')).toBe(10);
    expect(calls.status).toBe(1);
    expect(calls.search).toEqual(['shallow swap 1', 'shallow transfer 1', 'shallow recv 1', 'shallow send 1']);
  });

  it('a node that does not give its earliest block: nothing is known, and the search reads as before', async () => {
    const db = await seeded({ height: CURSOR, at: 1 });
    const hub = hubOn(db);
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      const url = new URL(String(u));
      if (url.pathname.endsWith('/status')) return Response.json({ result: { sync_info: { latest_block_height: String(HEAD) } } });
      if (url.pathname.endsWith('/block')) return Response.json({ result: { block: { header: { time: new Date(Date.now() - 60_000).toISOString() } } } });
      return Response.json({ result: { txs: [], total_count: '0' } });
    }));
    await hub.sweepOsmosis();
    const c = cursorOf(db);
    expect(c.height).toBe(HEAD);
    expect(c.depth).toBeUndefined();
  });
});

describe('nodeDepth: the shallowest node a search has seen', () => {
  const NOW = Date.UTC(2026, 9, 29, 20);
  it('keeps the fewer blocks; a depth up to twice the kept one refreshes it; one far deeper leaves it as it was', () => {
    expect(nodeDepth(undefined, 73_526_601, '73431644', NOW)).toEqual({ blocks: 94_957, at: NOW });
    const kept = { blocks: 94_957, at: NOW - HOUR };
    expect(nodeDepth(kept, 73_526_700, '68229727', NOW)).toBe(kept); // the deep backend: 5.3 million blocks
    expect(nodeDepth(kept, 73_528_000, '73431644', NOW)).toEqual({ blocks: 94_957, at: NOW }); // the shallow one again, pruned in a step
    expect(nodeDepth(kept, 73_526_601, '73441644', NOW)).toEqual({ blocks: 84_957, at: NOW });
  });
  it('a depth not seen for a week gives way to the next answer; an answer without an earliest block, or a broken one, keeps what was kept', () => {
    const old = { blocks: 94_957, at: NOW - OSMOSIS_DEPTH_KEEP_MS - 1 };
    expect(nodeDepth(old, 73_526_601, '68229727', NOW)).toEqual({ blocks: 5_296_874, at: NOW });
    expect(nodeDepth(old, 73_526_601, undefined, NOW)).toBeUndefined();
    const kept = { blocks: 94_957, at: NOW - HOUR };
    for (const e of [undefined, null, '', '0', '-5', '1e6', '73526602', 'abc', {}, 1.5]) expect(nodeDepth(kept, 73_526_601, e, NOW), String(e)).toBe(kept);
    expect(nodeDepth(kept, 73_526_601, 73_431_644, NOW)).toEqual({ blocks: 94_957, at: NOW });
  });
});
