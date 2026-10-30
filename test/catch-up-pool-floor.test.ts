// Merged stage 1 review (2026-10-29): the catch-up search's pool-address queries (osmosis-history) against the hub's
// other rules (hub-hygiene's breaker and shallow guard). Four ways they held the search back:
// - The probes ran before the stream's four queries, and every probe batch asked the public node again once Keplr had
//   refused a batch (the breaker then put the public node back first): with the public node accepting requests and
//   never answering, six batches of 25 s each filled the alarm's 150 s before any NAM query was read, at every search.
//   Now the stream's queries are read first, and a batch goes only to a node that failed nothing in the search and has
//   not refused a batch; the probes are then asked one by one.
// - An empty probe answer from the public node's shallow backend counted as "nothing above the floor", which the
//   shallow guard refuses for every other query: after a stall of the searches longer than that backend's 16 hours, a
//   USDC-only bid below its first block was passed over for good. Now an empty answer counts only when the index that
//   gave it is known to hold the range (its batch's /status names its first block) or the nodes are known to.
// - The pool queries' twelve pages a search went in a fixed order, and any pool query left unread held the cursor: with
//   seven pools each touched every five minutes the cursor never moved again, and the seventh pool's legs were never
//   read. Now the pool queries keep a floor of their own (the cursor's `poolsFrom`) and each search starts them where
//   the last one stopped (`poolsNext`); the cursor moves with the stream's queries.
// Fetch is stubbed: nothing reaches a node.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bech32 } from '@scure/base';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import { ALARM_DEADLINE_MS, LiveHub, OSMOSIS_POOL_SWEEP_PAGES, OSMOSIS_QUERIES } from '../worker/src/live-hub';
import { HubQuote } from '../worker/src/live-quote';
import { osmoAssets } from '../worker/src/parse/osmosis';
import { osmosisPoolQueries } from '../worker/src/sources/osmosis';
import { NAM, OSMOSIS } from '../worker/src/config';
import { testD1, type TestD1 } from './d1-sqlite';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const USDC = OSMOSIS.usdcDenom;
const P3008 = 'osmo1cf6jdap430ugk6c27cdm5stqkq7z3rkgfl5ps5nnw3d5409sw3vql4364c';
/** A pool account's address (32 bytes, as a pool's is). */
const addr = (i: number) => bech32.encode('osmo', bech32.toWords(new Uint8Array(32).fill(i + 1)), 90);
const isPoolQuery = (q: string) => q.startsWith('transfer.sender=') || q.startsWith('transfer.recipient=');

function hubOn(db: TestD1, poolAddrs: Map<string, string>, env: Record<string, unknown> = {}) {
  return Object.assign(Object.create(LiveHub.prototype), {
    env: { DB: db, ...env },
    seenOsmoTx: new Set<string>(), osmoRetryTx: new Map<string, number>(), osmoWriting: new Map(), osmoRetryFrom: null, osmoRetryGen: 0, osmoHeight: 0,
    sessions: new Set(), lastPriceUsd: null, needSweep: false,
    osmoCtx: { poolAddrs, priceUsd: null, assets: osmoAssets() },
    quote: new HubQuote(async () => null, async () => null),
    alertFlows: async () => {},
  }) as any;
}
async function seeded(cursor: Record<string, unknown>) {
  const db = testD1();
  await db.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('osmosis.cursor', ?, 0)").bind(JSON.stringify(cursor)).run();
  return db;
}
const cursorOf = (db: TestD1) => JSON.parse((db.raw.prepare("SELECT value FROM kv WHERE key='osmosis.cursor'").get() as any).value);
const legTxs = (db: TestD1) => (db.raw.prepare('SELECT COUNT(DISTINCT tx_hash) n FROM pool_legs').get() as any).n as number;

describe('a public node that accepts requests and never answers, and a Keplr node that refuses batches', () => {
  async function run(keplrBatch: 'array' | 'refused', pools: number) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const t0 = Date.now();
    const log: { at: number; who: string; what: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => {
      const url = String(u);
      const who = url.startsWith(OSMOSIS.publicRpc) ? 'public' : 'keplr';
      const post = init?.method === 'POST';
      log.push({ at: Date.now() - t0, who, what: post ? 'batch' : (new URL(url).searchParams.get('query') ?? new URL(url).pathname.split('/').pop() ?? '') });
      if (who === 'public') return new Promise<Response>((_, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))));
      if (post) {
        if (keplrBatch === 'refused') return new Response('method not allowed', { status: 405 });
        return Response.json(JSON.parse(String(init!.body)).map((c: any) => ({ jsonrpc: '2.0', id: c.id, result: { txs: [], total_count: '0' } })));
      }
      if (url.includes('/status')) return Response.json({ result: { sync_info: { latest_block_height: '1000400', latest_block_time: new Date(t0).toISOString() } } });
      return Response.json({ result: { txs: [], total_count: '0' } });
    }));
    const db = await seeded({ height: 1_000_000, at: 1 });
    const hub = hubOn(db, new Map(Array.from({ length: pools }, (_, i) => [addr(i), String(4000 + i)] as [string, string])), { KEPLR_KEY: 'k' });
    const deadline = new AbortController();
    setTimeout(() => deadline.abort('alarm deadline'), ALARM_DEADLINE_MS);
    let done = false;
    const p = hub.sweepOsmosis(deadline.signal).finally(() => { done = true; });
    for (let i = 0; i < 400 && !done; i++) await vi.advanceTimersByTimeAsync(1000);
    await p;
    const firstNam = log.find((l) => OSMOSIS_QUERIES.some((q) => l.what === `"${q}"`));
    return { t0, firstNamAt: firstNam ? firstNam.at : null, publicAsked: log.filter((l) => l.who === 'public').length, posts: log.filter((l) => l.what === 'batch').length, cursor: cursorOf(db), at: Date.now() - t0 };
  }

  it('Keplr refuses batches: the NAM queries are read 25 s in, the public node is asked once, the probes go to Keplr one by one, and the search finishes', async () => {
    const r = await run('refused', 26);
    expect(r.firstNamAt).toBe(25_000);
    // the /status that found it hung: no probe batch and no read waits on it again
    expect(r.publicAsked).toBe(1);
    // one batch refused, then none asked
    expect(r.posts).toBe(1);
    expect(r.cursor).toMatchObject({ height: 1_000_400, pools: 26, blockAt: r.t0 });
    expect(r.cursor.error).toBeUndefined();
    expect(r.at).toBeLessThan(30_000);
  });

  it('Keplr answers batches: the same, the probes in batches', async () => {
    const r = await run('array', 26);
    expect(r.firstNamAt).toBe(25_000);
    expect(r.publicAsked).toBe(1);
    expect(r.posts).toBe(Math.ceil(52 / 8));
    expect(r.cursor).toMatchObject({ height: 1_000_400 });
    expect(r.cursor.error).toBeUndefined();
  });
});

describe('an empty probe answer from an index that may not hold the range', () => {
  const CURSOR = 1_000_000, HEAD = 1_100_000, SHALLOW = 1_050_000;
  const hashOf = (p: string, i: number) => `${p}${String(i).padStart(64 - p.length, '0')}`;
  const xfer = (p: string, i: number, height: number) => ({
    hash: hashOf(p, i), height: String(height), tx: '',
    tx_result: { code: 0, events: [{ type: 'transfer', attributes: [{ key: 'recipient', value: `osmo1recv${i}` }, { key: 'sender', value: `osmo1send${i}` }, { key: 'amount', value: `${50 * 1e6}${NAM.osmoDenom}` }] }] },
  });
  // a USDC-only bid into the 3008 book, 30,000 blocks above the cursor and below the shallow backend's first block
  const bid = { hash: hashOf('BB', 1), height: String(CURSOR + 30_000), tx: '', tx_result: { code: 0, events: [{ type: 'transfer', attributes: [{ key: 'recipient', value: P3008 }, { key: 'sender', value: 'osmo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq9t' }, { key: 'amount', value: `5${USDC}` }] }] } };
  const lists: Record<string, any[]> = { [`transfer.recipient='${P3008}'`]: [bid, xfer('OLDP', 0, CURSOR - 5)] };
  // the stream's four queries: their newest transactions are below the cursor (read down to it by one page)
  const namList = (q: string) => [xfer('OLD', OSMOSIS_QUERIES.indexOf(q), CURSOR - 10_000 * (OSMOSIS_QUERIES.indexOf(q) + 1))];
  /** The probe batch from `batch`'s index (its /status names its first block), or refused; every GET from the deep one. */
  function node(batch: 'deep' | 'shallow' | 'refused') {
    const reads: { q: string; per: number }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => {
      const url = new URL(String(u));
      if (init?.method === 'POST' && batch === 'refused') return Response.json({ jsonrpc: '2.0', id: -1, error: { code: -32600, message: 'Invalid Request' } });
      if (init?.method === 'POST') {
        const first = batch === 'deep' ? 1 : SHALLOW;
        return Response.json(JSON.parse(String(init.body)).map((c: any) => {
          if (c.method === 'status') return { jsonrpc: '2.0', id: c.id, result: { sync_info: { latest_block_height: String(HEAD), earliest_block_height: String(first) } } };
          const list = (lists[c.params.query] ?? []).filter((t) => Number(t.height) >= first);
          return { jsonrpc: '2.0', id: c.id, result: { txs: list.slice(0, 1), total_count: String(list.length) } };
        }));
      }
      if (url.pathname.endsWith('/status')) return Response.json({ result: { sync_info: { latest_block_height: String(HEAD), earliest_block_height: '1' } } });
      if (url.pathname.endsWith('/block')) return Response.json({ result: { block: { header: { time: new Date(Date.now() - 60_000).toISOString() } } } });
      const q = (url.searchParams.get('query') ?? '').slice(1, -1);
      const per = Number(url.searchParams.get('per_page')), page = Number(url.searchParams.get('page'));
      reads.push({ q, per });
      const list = lists[q] ?? (isPoolQuery(q) ? [] : namList(q));
      return Response.json({ result: { txs: list.slice((page - 1) * per, page * per), total_count: String(list.length) } });
    }));
    return reads;
  }
  // an earlier search saw the shallow backend: its depth is kept with the cursor, so the nodes are known to hold blocks
  // only from SHALLOW, above the cursor
  const stalled = () => seeded({ height: CURSOR, at: 1, depth: { blocks: HEAD - SHALLOW, at: Date.now() } });

  it('answered by the deep index (its /status names block 1): the bid is read and its leg stored', async () => {
    const db = await stalled();
    node('deep');
    await hubOn(db, new Map([[P3008, '3008']])).sweepOsmosis();
    expect(legTxs(db)).toBe(1);
    expect(cursorOf(db)).toMatchObject({ height: HEAD });
    expect(cursorOf(db).poolsFrom).toBeUndefined();
  });

  it('answered by the shallow index: the pool queries keep their floor and are not walked, the cursor moves with the stream\'s queries, and the next probe from the deep index reads the bid', async () => {
    const db = await stalled();
    const reads = node('shallow');
    const hub = hubOn(db, new Map([[P3008, '3008']]));
    await hub.sweepOsmosis();
    const c = cursorOf(db);
    expect(c).toMatchObject({ height: HEAD, poolsFrom: { height: CURSOR, at: 1 } });
    expect(c.poolsFrom.note).toMatch(/2 answered with no transaction by an index whose first block is above where their range starts/);
    expect(c.error).toBeUndefined();
    expect(legTxs(db)).toBe(0);
    // a walk's pages could come from the same index: the query is left for the next probe
    expect(reads.filter((r) => isPoolQuery(r.q))).toEqual([]);
    // the next search, its probe answered by the deep index
    node('deep');
    await hub.sweepOsmosis();
    expect(legTxs(db)).toBe(1);
    expect(cursorOf(db)).toMatchObject({ height: HEAD });
    expect(cursorOf(db).poolsFrom).toBeUndefined();
  });

  it('a probe answer with a transaction is taken whatever index gave it (asked one by one, no /status): an index that holds its block holds every block above it', async () => {
    const db = await stalled();
    const was = { ...lists };
    // both of the pool's queries: their newest transaction is below the cursor
    lists[`transfer.recipient='${P3008}'`] = [xfer('OLDP', 0, CURSOR - 5)];
    lists[`transfer.sender='${P3008}'`] = [xfer('OLDS', 0, CURSOR - 7)];
    const reads = node('refused');
    await hubOn(db, new Map([[P3008, '3008']])).sweepOsmosis();
    expect(cursorOf(db)).toMatchObject({ height: HEAD });
    expect(cursorOf(db).poolsFrom).toBeUndefined();
    expect(reads.filter((r) => isPoolQuery(r.q)).map((r) => r.per)).toEqual([1, 1]);
    for (const k of Object.keys(lists)) delete lists[k];
    Object.assign(lists, was);
  });
});

describe('more pool queries with something new than the pages allow', () => {
  const CURSOR = 1_000_000;
  /** A swap of USDC for OSMO through pool i: USDC into the pool, OSMO out (both of the pool's queries match it). */
  let seq = 0;
  const swap = (pool: string, height: number) => ({
    hash: (seq++).toString(16).toUpperCase().padStart(64, '0'), height: String(height), tx: '',
    tx_result: { code: 0, events: [{ type: 'transfer', attributes: [
      { key: 'recipient', value: pool }, { key: 'sender', value: 'osmo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq9t' }, { key: 'amount', value: `5${USDC}` },
      { key: 'recipient', value: 'osmo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq9t' }, { key: 'sender', value: pool }, { key: 'amount', value: '7uosmo' },
    ] }] },
  });

  it(`seven pools each touched every five minutes (14 queries, ${OSMOSIS_POOL_SWEEP_PAGES} pages): the cursor moves at every search, and every pool's legs are stored`, async () => {
    const N = 7;
    const pools = new Map(Array.from({ length: N }, (_, i) => [addr(i), String(4000 + i)] as [string, string]));
    let head = CURSOR + 400;
    const byPool = new Map<string, any[]>();
    const listOf = (q: string) => { for (const [a] of pools) if (q.includes(a)) return byPool.get(a) ?? []; return []; };
    vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => {
      const url = new URL(String(u));
      const answer = (q: string, page: number, per: number) => { const list = isPoolQuery(q) ? listOf(q) : []; return { txs: list.slice((page - 1) * per, page * per), total_count: String(list.length) }; };
      if (init?.method === 'POST') {
        return Response.json(JSON.parse(String(init.body)).map((c: any) => c.method === 'status'
          ? { jsonrpc: '2.0', id: c.id, result: { sync_info: { latest_block_height: String(head), earliest_block_height: '1' } } }
          : { jsonrpc: '2.0', id: c.id, result: answer(c.params.query, Number(c.params.page), Number(c.params.per_page)) }));
      }
      if (url.pathname.endsWith('/status')) return Response.json({ result: { sync_info: { latest_block_height: String(head), latest_block_time: new Date(Date.now() - 1000).toISOString() } } });
      if (url.pathname.endsWith('/block')) return Response.json({ result: { block: { header: { time: new Date(Date.now() - 60_000).toISOString() } } } });
      const q = (url.searchParams.get('query') ?? '').slice(1, -1);
      return Response.json({ result: answer(q, Number(url.searchParams.get('page')), Number(url.searchParams.get('per_page'))) });
    }));
    const db = await seeded({ height: CURSOR, at: 1 });
    const hub = hubOn(db, pools);
    const asked = [...pools.keys()].flatMap(osmosisPoolQueries);
    const starts: (string | undefined)[] = [];
    for (let s = 0; s < 6; s++) {
      head += 350; // about five minutes of blocks
      for (const [a] of pools) byPool.set(a, [swap(a, head - 10), ...(byPool.get(a) ?? [])]);
      await hub.sweepOsmosis();
      const c = cursorOf(db);
      // the stream's queries were read down to the cursor: it moves, with the time of the head's block (the public
      // posts wait for it, public-posts.ts hourCovered)
      expect(c).toMatchObject({ height: head });
      expect(c.error).toBeUndefined();
      expect(c.blockAt).toBeGreaterThan(Date.now() - 60_000);
      // two of the fourteen queries are left each time, kept with their floor; the next search starts with them
      expect(c.poolsFrom).toMatchObject({ height: CURSOR });
      expect(c.poolsFrom.note).toMatch(/2 not read: the search's 12 pages for them were spent/);
      expect(asked).toContain(c.poolsNext);
      starts.push(c.poolsNext);
    }
    // the searches started their pool queries at different places
    expect(new Set(starts).size).toBeGreaterThan(1);
    // a quiet window: the queries left behind are read, the pool floor moves with the cursor
    head += 350;
    await hub.sweepOsmosis();
    expect(cursorOf(db).poolsFrom).toBeUndefined();
    expect(cursorOf(db).resume).toBeUndefined();
    expect(legTxs(db)).toBe(N * 6);
  });
});
