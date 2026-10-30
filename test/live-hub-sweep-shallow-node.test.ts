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
// read as before. The review of 2026-10-29 changed three things: the kept depth no longer gives way to the first
// answer after it has gone unseen (after a long outage that answer may be the deep backend's), only to twelve deeper
// answers in a row once it has gone unseen for a day; a depth under about an hour of blocks (a backend just synced
// from a snapshot) is not kept, so it cannot hold back every search; and the note reaches the cron's osmosis_index
// check, and goes with the next search that finishes.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import { LiveHub, OSMOSIS_DEPTH_FLOOR, OSMOSIS_DEPTH_KEEP_MS, OSMOSIS_DEPTH_RETIRE, nodeDepth } from '../worker/src/live-hub';
import { HubQuote } from '../worker/src/live-quote';
import { indexState } from '../worker/src/analytics';
import { runCron } from '../worker/src/cron';
import { NAM } from '../worker/src/config';
import { testD1, type TestD1 } from './d1-sqlite';

afterEach(() => vi.unstubAllGlobals());

const CURSOR = 1_000_000;
const HEAD = 1_100_000;
/** The shallow backend's earliest block: it holds the newest 50,000 (the deep one holds every block). */
const SHALLOW = 1_050_000;
const HOUR = 3_600_000;
type Key = 'swap' | 'transfer' | 'recv' | 'send';
/** `fresh`: a backend just synced from a snapshot, holding the newest 100 blocks only. */
type Backend = 'deep' | 'shallow' | 'fresh';
const FRESH = HEAD - 100;
const earliestOf = (b: Backend) => (b === 'deep' ? 1 : b === 'shallow' ? SHALLOW : FRESH);
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
      return Response.json({ result: { sync_info: { latest_block_height: String(HEAD), earliest_block_height: String(earliestOf(b)) } } });
    }
    if (url.pathname.endsWith('/block')) return Response.json({ result: { block: { header: { time: new Date(Date.now() - 60_000).toISOString() } } } });
    if (!url.pathname.endsWith('/tx_search')) throw new Error(`unexpected ${url}`);
    const q = url.searchParams.get('query') ?? '';
    const key: Key = q.includes('token_swapped') ? 'swap' : q.includes('transfer.amount') ? 'transfer' : q.includes('recv_packet') ? 'recv' : 'send';
    const per = Number(url.searchParams.get('per_page')), page = Number(url.searchParams.get('page'));
    const b = pick('search', n++);
    calls.search.push(`${b} ${key} ${page}`);
    const list = lists[key].filter((t) => Number(t.height) >= earliestOf(b));
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
    // the shallowest depth is kept (the deep backend's /status says nothing of the shallow one); the note goes with
    // the search that finished
    expect(done.depth.blocks).toBe(HEAD - SHALLOW);
    expect(again.shallow.note).toContain('it is asked again');
    expect(done.shallow).toBeUndefined();
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

  it('after an outage of eight days the kept depth still stands: a /status from the deep backend does not let the shallow one\'s short answer move the cursor', async () => {
    // the shallow backend was last seen eight days ago (the searches were down since), past OSMOSIS_DEPTH_KEEP_MS
    const seen = Date.now() - 8 * 24 * HOUR;
    expect(Date.now() - seen).toBeGreaterThan(OSMOSIS_DEPTH_KEEP_MS);
    const db = await seeded({ height: CURSOR, at: 1, depth: { blocks: HEAD - SHALLOW, at: seen } });
    const hub = hubOn(db);
    node((what) => (what === 'status' ? 'deep' : 'shallow'));
    await hub.sweepOsmosis();
    const c = cursorOf(db);
    expect(c.height).toBe(CURSOR);
    expect(stored(db, 'DD%')).toBe(0);
    expect(c.error).toMatch(/may not reach back to the cursor/);
    // the deep answer is counted towards retiring the kept depth, not taken
    expect(c.depth).toEqual({ blocks: HEAD - SHALLOW, at: seen, deeper: { blocks: HEAD - 1, n: 1 } });
    // the deep backend answers the searches: the missed transfer is written and the cursor moves past it
    node(() => 'deep');
    for (let i = 0; i < 4 && cursorOf(db).height !== HEAD; i++) await hub.sweepOsmosis();
    expect(stored(db, 'DD%')).toBe(1);
    expect(cursorOf(db).height).toBe(HEAD);
    expect(cursorOf(db).depth.blocks).toBe(HEAD - SHALLOW);
  });

  it('a backend just synced from a snapshot (100 blocks) holds no search back, and a tiny depth kept from before the floor is let go', async () => {
    // its /status is not taken as a depth: the search of the last 300 blocks, answered by the 16-hour backend, ends
    let db = await seeded({ height: HEAD - 300, at: 1 });
    let hub = hubOn(db);
    node((what) => (what === 'status' ? 'fresh' : 'shallow'));
    await hub.sweepOsmosis();
    expect(cursorOf(db).height).toBe(HEAD);
    expect(cursorOf(db).depth).toBeUndefined();
    expect(cursorOf(db).error).toBeUndefined();
    expect(stored(db, 'AA%')).toBe(10);
    // a cursor that kept 100 blocks as its depth: the 16-hour backend's /status replaces it, and the search ends
    db = await seeded({ height: HEAD - 300, at: 1, depth: { blocks: 100, at: Date.now() - HOUR } });
    hub = hubOn(db);
    node(() => 'shallow');
    await hub.sweepOsmosis();
    expect(cursorOf(db).height).toBe(HEAD);
    expect(cursorOf(db).depth.blocks).toBe(HEAD - SHALLOW);
    // and with it kept and no /status depth at all (a node that does not give it), it holds nothing either
    db = await seeded({ height: HEAD - 300, at: 1, depth: { blocks: 100, at: Date.now() - HOUR } });
    hub = hubOn(db);
    node(() => 'fresh');
    await hub.sweepOsmosis();
    expect(cursorOf(db).height).toBe(HEAD);
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

// ---------------------------------------------------------------- the tick (as test/bridge-pair-sequence.test.ts runs it)
const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));
const u256 = (n: bigint) => { const b = new Uint8Array(32); let v = n; for (let i = 0; i < 32; i++) { b[i] = Number(v & 0xffn); v >>= 8n; } return btoa(String.fromCharCode(...b)); };
function cronNetwork() {
  const BAL = fx('balance_listing.json'), BONDS = fx('bonds_listing.json');
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/ibc/')) return Promise.resolve(new Response('not here', { status: 404 }));
    if (url.includes('/status')) return Promise.resolve(Response.json({ result: { sync_info: { latest_block_height: '8458700', latest_block_time: new Date().toISOString(), catching_up: false, earliest_block_height: '1' } } }));
    if (url.includes('abci_query')) {
      const path = decodeURIComponent(url.split('path=')[1] ?? '');
      if (path.includes('/vp/pos/bond/')) return Promise.resolve(Response.json({ result: { response: { code: 1, info: 'RPC error: Cannot find bond', value: null, height: '1' } } }));
      const value = path.includes('/shell/epoch') ? btoa(String.fromCharCode(155, 10, 0, 0, 0, 0, 0, 0))
        : path.includes('/shell/prefix/') ? BAL.value
        : path.includes('/vp/pos/bonds_and_unbonds/to') ? BONDS.value
        : path.includes('delegations_at') ? null
        : path.includes('balance/minted') ? u256(BigInt(BAL.expected.minted))
        : u256(path.includes('total_stake') ? 75338381473000n : 1000000n);
      return Promise.resolve(Response.json({ result: { response: { code: 0, value, height: '8458700' } } }));
    }
    if (url.includes('denom_owners')) return Promise.resolve(Response.json({ denom_owners: [], pagination: { next_key: null, total: '0' } }));
    if (url.includes('supply/by_denom')) return Promise.resolve(Response.json({ amount: { denom: 'x', amount: '1000000' } }));
    return Promise.resolve(new Response('not here', { status: 404 }));
  }));
}
async function tick(env: any, start: number) {
  vi.useFakeTimers({ now: start, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  let done = false, err: unknown = null;
  runCron(env).catch((e) => { err = e; }).finally(() => { done = true; });
  for (let i = 0; !done && i < 4000; i++) await vi.advanceTimersByTimeAsync(250);
  vi.useRealTimers();
  if (err) throw err;
  expect(done).toBe(true);
}

describe('the note of a search the guard held, where the owner reads it', () => {
  it('indexState carries the cursor\'s error and the answers not taken, the cron\'s osmosis_index check puts them in its detail, and a search that finishes drops them', async () => {
    const db = await seeded({ height: CURSOR, at: 1 });
    const hub = hubOn(db);
    node(() => 'shallow');
    await hub.sweepOsmosis();
    const note = (await indexState(db as any, Date.now())).osmosisSweep?.note;
    expect(note).toMatch(/^The last catch-up search did not finish: a node answered from blocks that may not reach back to the cursor, and the next search asks again\. query "/);
    expect(note).toContain(`only from ${SHALLOW}, above block ${CURSOR + 1} where the range starts; it is asked again`);
    expect(note!.length).toBeLessThanOrEqual(1200);

    cronNetwork();
    await tick({ DB: db }, Date.now());
    const check = db.raw.prepare("SELECT status, detail FROM checks WHERE key='osmosis_index'").get() as { status: string; detail: string };
    expect(check.status).toBe('fail'); // no stream report, and the search's stamp is the one before the outage
    expect(JSON.parse(check.detail)).toMatchObject({ sweptToHeight: CURSOR, sweptAt: 1, sweepNote: note });

    node(() => 'deep');
    await hub.sweepOsmosis();
    const after = (await indexState(db as any, Date.now())).osmosisSweep;
    expect(after?.height).toBe(HEAD);
    expect(after?.note).toBeUndefined();
    cronNetwork();
    await tick({ DB: db }, Date.now());
    expect(JSON.parse((db.raw.prepare("SELECT detail FROM checks WHERE key='osmosis_index'").get() as { detail: string }).detail).sweepNote).toBeNull();
  });
});

describe('nodeDepth: the shallowest node a search has seen', () => {
  const NOW = Date.UTC(2026, 9, 29, 20);
  it('keeps the fewer blocks; a depth up to twice the kept one refreshes it; one far deeper leaves it as it was', () => {
    expect(nodeDepth(undefined, 73_526_601, '73431644', NOW)).toEqual({ blocks: 94_957, at: NOW });
    const kept = { blocks: 94_957, at: NOW - HOUR };
    expect(nodeDepth(kept, 73_526_700, '68229727', NOW)).toBe(kept); // the deep backend: 5.3 million blocks
    expect(nodeDepth(kept, 73_528_000, '73431644', NOW)).toEqual({ blocks: 94_957, at: NOW }); // the shallow one again, grown
    expect(nodeDepth(kept, 73_526_601, '73441644', NOW)).toEqual({ blocks: 84_957, at: NOW });
  });
  it('an answer without an earliest block, or a broken one, keeps what was kept', () => {
    const kept = { blocks: 94_957, at: NOW - HOUR };
    for (const e of [undefined, null, '', '0', '-5', '1e6', '73526602', 'abc', {}, 1.5]) expect(nodeDepth(kept, 73_526_601, e, NOW), String(e)).toBe(kept);
    expect(nodeDepth(kept, 73_526_601, 73_431_644, NOW)).toEqual({ blocks: 94_957, at: NOW });
    expect(nodeDepth(undefined, 73_526_601, undefined, NOW)).toBeUndefined();
  });
  it('a depth not seen for a day still stands: only OSMOSIS_DEPTH_RETIRE deeper answers in a row retire it, for the fewest blocks among them', () => {
    const old = { blocks: 94_957, at: NOW - OSMOSIS_DEPTH_KEEP_MS - 1 };
    // the first answer after an outage of more than a day comes from the deep backend: it is counted, not taken
    let d = nodeDepth(old, 73_526_601, '68229727', NOW);
    expect(d).toEqual({ blocks: 94_957, at: old.at, deeper: { blocks: 5_296_874, n: 1 } });
    // a /status without its earliest block counts for nothing
    expect(nodeDepth(d, 73_526_601, undefined, NOW)).toBe(d);
    for (let i = 2; i < OSMOSIS_DEPTH_RETIRE; i++) {
      d = nodeDepth(d, 73_526_601, i % 2 ? '68229727' : '73300000', NOW + i);
      expect(d?.blocks, String(i)).toBe(94_957);
      expect(d?.deeper?.n).toBe(i);
    }
    // the twelfth: the kept depth gives way to the shallowest of the twelve (a backend grown past twice the kept one)
    expect(nodeDepth(d, 73_526_601, '68229727', NOW + 99)).toEqual({ blocks: 226_601, at: NOW + 99 });
    // a node as shallow as the kept one, or up to twice it, seen in the count ends it: the kept one is current again
    expect(nodeDepth(d, 73_526_601, '73400000', NOW + 99)).toEqual({ blocks: 94_957, at: NOW + 99 });
    expect(nodeDepth(d, 73_526_601, '73450000', NOW + 99)).toEqual({ blocks: 76_601, at: NOW + 99 });
    // still current (seen within the day), a deeper answer is not even counted
    const fresh = { blocks: 94_957, at: NOW - OSMOSIS_DEPTH_KEEP_MS };
    expect(nodeDepth(fresh, 73_526_601, '68229727', NOW)).toBe(fresh);
  });
  it(`a depth under OSMOSIS_DEPTH_FLOOR (${OSMOSIS_DEPTH_FLOOR} blocks, about an hour) is not taken, and one kept from before the rule is let go`, () => {
    const kept = { blocks: 94_957, at: NOW - HOUR };
    // a backend synced from a snapshot a few minutes ago
    expect(nodeDepth(kept, 73_526_601, String(73_526_601 - 300), NOW)).toBe(kept);
    expect(nodeDepth(undefined, 73_526_601, String(73_526_601 - OSMOSIS_DEPTH_FLOOR + 1), NOW)).toBeUndefined();
    expect(nodeDepth(undefined, 73_526_601, String(73_526_601 - OSMOSIS_DEPTH_FLOOR), NOW)).toEqual({ blocks: OSMOSIS_DEPTH_FLOOR, at: NOW });
    const tiny = { blocks: 100, at: NOW - HOUR };
    expect(nodeDepth(tiny, 73_526_601, '73431644', NOW)).toEqual({ blocks: 94_957, at: NOW });
    expect(nodeDepth(tiny, 73_526_601, undefined, NOW)).toBeUndefined();
  });
});
