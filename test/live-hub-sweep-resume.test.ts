// Security review (2026-10-22), the catch-up search's page window: the search can only page a query from its newest
// transaction, at most OSMOSIS_SWEEP_PAGES pages of 50, and a search that stopped at the last page kept the cursor and
// recorded nothing of how far it had read. The next search read the same newest pages again and stopped at the same
// depth, so once any query had 200 matching transactions above the cursor the cursor never moved again: 201 small
// sends of another coin over the NAM channel (they make no row, but fill the pages) were enough, as was a day or two of
// failed searches (about 130 pool-3005 swaps and 600 NAM transfers matched a day on 2026-10-22). A NAM move the stream
// missed below that window was never written and the Osmosis index read stale for good. Now a search that stops above
// the cursor keeps, per query, the transaction it read down to and its place counted from the newest (osmosis.cursor
// `resume`), and the next search reads down to what it had seen, then goes on from that page, checking that the page
// it goes to holds that transaction or starts above its height, so nothing is passed over. The cursor and its stamp
// still move only when every query is read down to it.
//
// Also checked here: a transaction that makes no row is never read again by block (the search lets it go when it is
// read), and a transaction whose block time cannot be read is never passed by a place.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import { LiveHub, OSMOSIS_SWEEP_PAGES } from '../worker/src/live-hub';
import { HubQuote } from '../worker/src/live-quote';
import { NAM, OSMOSIS } from '../worker/src/config';
import { testD1, type TestD1 } from './d1-sqlite';

afterEach(() => vi.unstubAllGlobals());

const CURSOR = 1_000_000;
type Key = 'swap' | 'transfer' | 'recv' | 'send';
const hashOf = (p: string, i: number) => `${p}${String(i).padStart(64 - p.length, '0')}`;

/** A 50 NAM bank transfer: one transfer flow. */
const xfer = (i: number, height: number, p = 'BB') => ({
  hash: hashOf(p, i), height: String(height), tx: '',
  tx_result: { code: 0, events: [{ type: 'transfer', attributes: [{ key: 'recipient', value: `osmo1recv${i}` }, { key: 'sender', value: `osmo1send${i}` }, { key: 'amount', value: `${50 * 1e6}${NAM.osmoDenom}` }] }] },
});
/** A 1 uosmo IBC send to Namada on the NAM channel: it matches the send_packet query and makes no row. */
const dust = (i: number, height: number) => ({
  hash: hashOf('EE', i), height: String(height), tx: 'A'.repeat(800),
  tx_result: { code: 0, events: [
    { type: 'transfer', attributes: [{ key: 'recipient', value: 'osmo1escrow' }, { key: 'sender', value: 'osmo1dust' }, { key: 'amount', value: '1uosmo' }, { key: 'msg_index', value: '0' }] },
    { type: 'send_packet', attributes: [{ key: 'packet_src_channel', value: NAM.osmoChannel }, { key: 'packet_data', value: JSON.stringify({ amount: '1', denom: 'uosmo', receiver: 'tnam1x', sender: 'osmo1dust' }) }, { key: 'msg_index', value: '0' }] },
    { type: 'ibc_transfer', attributes: [{ key: 'sender', value: 'osmo1dust' }, { key: 'receiver', value: 'tnam1x' }, { key: 'amount', value: '1' }, { key: 'denom', value: 'uosmo' }, { key: 'msg_index', value: '0' }] },
  ] },
});
/** NAM leaving the transfer module with no packet events: balance moves, no flow row. */
const movesOnly = (i: number, height: number) => ({
  hash: hashOf('CC', i), height: String(height), tx: '',
  tx_result: { code: 0, events: [{ type: 'transfer', attributes: [{ key: 'recipient', value: `osmo1back${i}` }, { key: 'sender', value: OSMOSIS.transferModule }, { key: 'amount', value: `${5 * 1e6}${NAM.osmoDenom}` }] }] },
});
/** The real NAM bridge send the stream missed (fixture osmo_ibc_send.json), moved to `height`. */
const missed = (height: number) => {
  const t = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'osmo_ibc_send.json'), 'utf8'))[0];
  return { ...t, hash: hashOf('DD', 0), height: String(height) };
};

interface Chain {
  head: number;
  lists: Partial<Record<Key, any[]>>;
  /** A node a little behind: how many of the newest transactions of a query it does not have yet, for a page. */
  lag?: (key: Key, page: number) => number;
  /** Heights whose block cannot be read; a query that fails. */
  noBlock?: Set<number>;
  failing?: Key;
}
/** One Osmosis node over `chain`, newest first. Counts the tx_search reads per query and the block reads. */
function osmosis(chain: Chain) {
  const calls = { search: [] as string[], blocks: 0 };
  vi.stubGlobal('fetch', vi.fn(async (u: string) => {
    const url = new URL(String(u));
    if (url.pathname.endsWith('/status')) return Response.json({ result: { sync_info: { latest_block_height: String(chain.head) } } });
    if (url.pathname.endsWith('/block')) {
      calls.blocks++;
      if (chain.noBlock?.has(Number(url.searchParams.get('height')))) return new Response('no', { status: 500 });
      return Response.json({ result: { block: { header: { time: new Date(Date.now() - 60_000).toISOString() } } } });
    }
    if (!url.pathname.endsWith('/tx_search')) throw new Error(`unexpected ${url}`);
    const q = url.searchParams.get('query') ?? '';
    const key: Key = q.includes('token_swapped') ? 'swap' : q.includes('transfer.amount') ? 'transfer' : q.includes('recv_packet') ? 'recv' : 'send';
    const per = Number(url.searchParams.get('per_page')), page = Number(url.searchParams.get('page'));
    calls.search.push(`${key} ${page}`);
    if (chain.failing === key) return new Response('busy', { status: 500 });
    const list = (chain.lists[key] ?? []).slice(chain.lag?.(key, page) ?? 0);
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
async function seeded(cursor = { height: CURSOR, at: 1 }) {
  const db = testD1();
  await db.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('osmosis.cursor', ?, 0)").bind(JSON.stringify(cursor)).run();
  return db;
}
const cursorOf = (db: TestD1) => JSON.parse((db.raw.prepare("SELECT value FROM kv WHERE key='osmosis.cursor'").get() as any).value);
const stored = (db: TestD1, like: string) => (db.raw.prepare('SELECT COUNT(DISTINCT tx_hash) AS n FROM flows WHERE tx_hash LIKE ?').get(like) as any).n as number;
const perQuery = (calls: { search: string[] }, from: number, key: Key) => calls.search.slice(from).filter((c) => c.startsWith(`${key} `)).length;

describe('a query with more than the pages above the cursor', () => {
  it('201 sends that make no row above a NAM send the stream missed: the next search goes on below them and the cursor moves', async () => {
    const db = await seeded();
    const hub = hubOn(db);
    const chain: Chain = { head: CURSOR + 150, lists: { send: [...Array.from({ length: 201 }, (_, i) => dust(i, CURSOR + 149 - Math.floor(i / 2))), missed(CURSOR + 5)] } };
    const calls = osmosis(chain);
    await hub.sweepOsmosis();
    const first = cursorOf(db);
    console.log('after one search', JSON.stringify(first));
    // the first search stops at its pages: the cursor and its stamp stay, and it says it goes on
    expect(first.height).toBe(CURSOR);
    expect(first.at).toBe(1);
    expect(first.error).toMatch(/did not finish/);
    for (let n = 0; n < 2; n++) await hub.sweepOsmosis();
    const cur = cursorOf(db);
    console.log('after three searches', JSON.stringify(cur), 'missed send stored', stored(db, 'DD%'), 'send pages read', perQuery(calls, 0, 'send'));
    expect(stored(db, 'DD%')).toBe(1);
    expect(cur.height).toBe(CURSOR + 150);
    expect(cur.error).toBeUndefined();
    expect(cur.resume).toBeUndefined();
    expect(stored(db, 'EE%')).toBe(0);
  }, 120_000);

  it('a backlog of 1,000 NAM transfers after days of failed searches, with more coming: each written, and the cursor reaches the head', async () => {
    const db = await seeded();
    const hub = hubOn(db);
    const total = { n: 1000 };
    const list = Array.from({ length: 1000 }, (_, i) => xfer(i, CURSOR + 100_000 - i * 90));
    const chain: Chain = { head: CURSOR + 100_100, lists: { transfer: list } };
    const calls = osmosis(chain);
    let searches = 0;
    for (; searches < 20; searches++) {
      const from = calls.search.length;
      await hub.sweepOsmosis();
      // no search reads more than its pages of a query
      expect(perQuery(calls, from, 'transfer')).toBeLessThanOrEqual(OSMOSIS_SWEEP_PAGES);
      if (cursorOf(db).height === chain.head) break;
      // 20 more transfers before the next search, and the chain moves on
      chain.head += 150;
      list.unshift(...Array.from({ length: 20 }, (_, k) => xfer(total.n + k, chain.head - k)));
      total.n += 20;
    }
    console.log(`searches to the head: ${searches + 1}, written ${stored(db, 'BB%')} of ${total.n}`);
    expect(cursorOf(db).height).toBe(chain.head);
    expect(stored(db, 'BB%')).toBe(total.n);
    expect(searches + 1).toBeLessThanOrEqual(12);
  }, 120_000);

  it('a node a little behind answers the page gone on to: it is not taken, the page before it is read, and nothing is passed over', async () => {
    const db = await seeded();
    const hub = hubOn(db);
    const list = Array.from({ length: 300 }, (_, i) => xfer(i, CURSOR + 2000 - i));
    const chain: Chain = { head: CURSOR + 2100, lists: { transfer: list } };
    const calls = osmosis(chain);
    await hub.sweepOsmosis();
    // 40 new transfers; the pages after the first come from a node 60 transactions behind
    list.unshift(...Array.from({ length: 40 }, (_, k) => xfer(300 + k, CURSOR + 2140 - k)));
    chain.head = CURSOR + 2200;
    chain.lag = (key, page) => (key === 'transfer' && page > 1 ? 60 : 0);
    for (let n = 0; n < 6 && cursorOf(db).height !== chain.head; n++) await hub.sweepOsmosis();
    console.log('cursor', JSON.stringify(cursorOf(db)), 'written', stored(db, 'BB%'), 'reads', calls.search.filter((c) => c.startsWith('transfer')).join(','));
    expect(stored(db, 'BB%')).toBe(340);
    expect(cursorOf(db).height).toBe(chain.head);
  }, 120_000);

  it('a node that does not have the place\'s transactions: the place stands, and the next search goes on from it', async () => {
    const db = await seeded();
    const hub = hubOn(db);
    const list = Array.from({ length: 260 }, (_, i) => xfer(i, CURSOR + 2000 - i));
    const chain: Chain = { head: CURSOR + 2100, lists: { transfer: list } };
    osmosis(chain);
    await hub.sweepOsmosis();
    const place = cursorOf(db).resume;
    // a node that has only the newest 30 of them
    chain.lists = { transfer: list.slice(0, 30) };
    await hub.sweepOsmosis();
    expect(cursorOf(db).resume).toEqual(place);
    expect(cursorOf(db).height).toBe(CURSOR);
    chain.lists = { transfer: list };
    await hub.sweepOsmosis();
    expect(stored(db, 'BB%')).toBe(260);
    expect(cursorOf(db).height).toBe(chain.head);
  }, 120_000);

  it('210 matching transactions in one block: the search goes on inside the block and reaches the send below it', async () => {
    const db = await seeded();
    const hub = hubOn(db);
    const sends = [...Array.from({ length: 210 }, (_, i) => dust(i, CURSOR + 100)), ...Array.from({ length: 40 }, (_, i) => dust(300 + i, CURSOR + 99 - i)), missed(CURSOR + 5)];
    osmosis({ head: CURSOR + 150, lists: { send: sends } });
    for (let n = 0; n < 4 && cursorOf(db).height !== CURSOR + 150; n++) await hub.sweepOsmosis();
    expect(stored(db, 'DD%')).toBe(1);
    expect(cursorOf(db).height).toBe(CURSOR + 150);
  }, 120_000);

  it('a block time that cannot be read inside the backlog: no place passes that transaction, and it is written once its block is read', async () => {
    const db = await seeded();
    const hub = hubOn(db);
    const list = Array.from({ length: 250 }, (_, i) => xfer(i, CURSOR + 1000 - i));
    const chain: Chain = { head: CURSOR + 1100, lists: { transfer: list }, noBlock: new Set([CURSOR + 900]) };
    osmosis(chain);
    for (let n = 0; n < 3; n++) {
      await hub.sweepOsmosis();
      const cur = cursorOf(db);
      const place = Object.values(cur.resume ?? {}).find((p: any) => p.last) as any;
      expect(cur.height).toBe(CURSOR);
      expect(place.low).toBeGreaterThan(CURSOR + 900);
    }
    expect(stored(db, hashOf('BB', 100))).toBe(0);
    chain.noBlock = new Set();
    for (let n = 0; n < 4 && cursorOf(db).height !== chain.head; n++) await hub.sweepOsmosis();
    expect(stored(db, 'BB%')).toBe(250);
    expect(cursorOf(db).height).toBe(chain.head);
  }, 120_000);

  it('a node that answers a head far below the cursor: the cursor it moves down to is read up from again within a few searches', async () => {
    const db = await seeded({ height: 5000, at: 1 });
    const hub = hubOn(db);
    const chain: Chain = { head: 100, lists: { transfer: Array.from({ length: 250 }, (_, i) => xfer(i, 5050 - i)) } };
    osmosis(chain);
    await hub.sweepOsmosis();
    expect(cursorOf(db).height).toBe(100);
    chain.head = 5100;
    for (let n = 0; n < 3 && cursorOf(db).height !== 5100; n++) await hub.sweepOsmosis();
    expect(cursorOf(db).height).toBe(5100);
    expect(stored(db, 'BB%')).toBe(250);
  }, 120_000);

  it('contrast: 199 transfers above the cursor, one search finishes', async () => {
    const db = await seeded();
    osmosis({ head: CURSOR + 300, lists: { transfer: Array.from({ length: 199 }, (_, i) => xfer(i, CURSOR + 200 - i)) } });
    await hubOn(db).sweepOsmosis();
    expect(cursorOf(db).height).toBe(CURSOR + 300);
    expect(stored(db, 'BB%')).toBe(199);
  }, 120_000);
});

describe('transactions read again while the cursor is held', () => {
  it('sends that make no row are never read by block, by the same hub or after a restart', async () => {
    const db = await seeded();
    const sends = Array.from({ length: 60 }, (_, i) => dust(i, CURSOR + 960 - i));
    // a failing query holds the cursor
    const calls = osmosis({ head: CURSOR + 1000, lists: { send: sends }, failing: 'swap' });
    const hub = hubOn(db);
    await hub.sweepOsmosis();
    const first = calls.blocks;
    await hub.sweepOsmosis();
    const second = calls.blocks - first;
    await hubOn(db).sweepOsmosis();
    const restarted = calls.blocks - first - second;
    console.log(`block reads: first ${first}, second ${second}, after a restart ${restarted}; cursor ${JSON.stringify(cursorOf(db))}`);
    expect(cursorOf(db).height).toBe(CURSOR);
    expect([first, second, restarted]).toEqual([0, 0, 0]);
  }, 120_000);

  it('a transaction that makes moves and no flow is read by block once per hub, not once per search', async () => {
    const db = await seeded();
    const calls = osmosis({ head: CURSOR + 1000, lists: { transfer: [movesOnly(0, CURSOR + 900)] }, failing: 'swap' });
    const hub = hubOn(db);
    await hub.sweepOsmosis();
    const first = calls.blocks;
    await hub.sweepOsmosis();
    await hub.sweepOsmosis();
    const again = calls.blocks - first;
    await hubOn(db).sweepOsmosis();
    const restarted = calls.blocks - first - again;
    console.log(`moves-only block reads: first ${first}, two more searches ${again}, after a restart ${restarted}`);
    expect([first, again, restarted]).toEqual([1, 0, 1]);
  }, 120_000);
});
