// Osmosis history repair (2026-10-29), scripts/osmosis-pager.ts: the pager scripts/backfill-osmosis.ts reads the
// history through. The history before 2026-10-21 lacked at least 350 pool transactions; the old backfill paged newest
// first and left a query at its first failed page, and osmosis-rpc.publicnode.com answers from a deep index (blocks from
// 2026-08-10) and a shallow one (about 16 hours) behind one name. Here a node with both indexes, answering from either
// as the test says: the pager reads oldest first, takes pages from the deep index only (a smaller total, or the shallow
// index's "page should be within" refusal, is asked again), asks a failed read again after 1, 2, 4 and 8 s and stops
// the run naming the query and page at the fifth failure, tells a query no answer showed deep, and finds a height's
// place by halving over pages of one transaction. No network: fetch is stubbed.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEEP_TRIES, OsmosisPager, PAGE_TRIES, PagerError, SHALLOW_TRIES } from '../scripts/osmosis-pager';

afterEach(() => vi.unstubAllGlobals());

const Q = "transfer.recipient='osmo1pool'";
const hashOf = (i: number) => i.toString(16).toUpperCase().padStart(64, '0');
/** 230 transactions of Q, at heights 1,000 to 3,290 (10 apart). */
const history = (n = 230) => Array.from({ length: n }, (_, i) => ({ hash: hashOf(i), height: String(1000 + 10 * i), tx_result: { code: 0, events: [] } }));
/** The shallow index holds the blocks from 3,000. */
const HORIZON = 3000;

type Who = 'deep' | 'shallow' | 'fail' | 'behind';
interface Node {
  deep: any[];
  /** Who answers the n-th request (from 0) for `path`. */
  pick: (n: number, url: URL) => Who;
}
/** A node over the two indexes; every request recorded. */
function osmosis(node: Node) {
  const calls: URL[] = [];
  const rpc = (result: unknown) => Response.json({ jsonrpc: '2.0', id: -1, result });
  const refuse = (data: string) => Response.json({ jsonrpc: '2.0', id: -1, error: { code: -32603, message: 'Internal error', data } }, { status: 500 });
  vi.stubGlobal('fetch', vi.fn(async (u: string) => {
    const url = new URL(String(u));
    const who = node.pick(calls.length, url);
    calls.push(url);
    if (who === 'fail') return new Response('<html>502 Bad Gateway</html>', { status: 502 });
    const list = who === 'shallow' ? node.deep.filter((t) => Number(t.height) >= HORIZON) : who === 'behind' ? node.deep.slice(0, -1) : node.deep;
    const first = who === 'shallow' ? HORIZON : 900;
    if (url.pathname === '/status') return rpc({ sync_info: { latest_block_height: '4000', earliest_block_height: String(first) } });
    if (url.pathname === '/block') {
      const h = Number(url.searchParams.get('height'));
      if (h < first) return refuse(`height ${h} is not available, lowest height is ${first}`);
      return rpc({ block: { header: { height: String(h), time: new Date(Date.UTC(2026, 7, 10) + h * 1000).toISOString() } } });
    }
    if (url.pathname === '/tx') {
      const hash = String(url.searchParams.get('hash')).slice(2);
      const t = list.find((x) => x.hash === hash);
      return t ? rpc(t) : refuse(`tx (${hash}) not found`);
    }
    if (url.pathname !== '/tx_search') throw new Error(`unexpected ${url}`);
    expect(url.searchParams.get('order_by')).toBe('"asc"');
    expect(url.searchParams.get('query')).toBe(`"${Q}"`);
    const page = Number(url.searchParams.get('page')), per = Number(url.searchParams.get('per_page'));
    const pages = Math.max(1, Math.ceil(list.length / per));
    if (page > pages) return refuse(`page should be within [1, ${pages}] range, given ${page}`);
    return rpc({ txs: list.slice((page - 1) * per, page * per), total_count: String(list.length) });
  }));
  return calls;
}
const pauses: number[] = [];
const pager = () => { pauses.length = 0; return new OsmosisPager('https://rpc.test', { sleep: async (ms) => { pauses.push(ms); } }); };
const searches = (calls: URL[]) => calls.filter((u) => u.pathname === '/tx_search');
async function readAll(p: OsmosisPager, from: number, to: number) {
  const out: any[] = [];
  await p.read(Q, from, to, (txs) => { out.push(...txs); });
  return out;
}

describe('the deep index only, oldest first', () => {
  it('a node answering from either index in turn: every page is the deep index\'s, and the range comes whole and in order', async () => {
    const deep = history();
    const calls = osmosis({ deep, pick: (n) => (n % 2 ? 'shallow' : 'deep') });
    const p = pager();
    const got = await readAll(p, 1500, 2600);
    expect(got.map((t) => t.hash)).toEqual(deep.filter((t) => Number(t.height) >= 1500 && Number(t.height) <= 2600).map((t) => t.hash));
    const st = await p.query(Q);
    expect(st).toMatchObject({ total: 230, deep: 'below', first: 1000 });
    expect(p.horizon).toBe(HORIZON);
    // the shallow index's answers (a total of 30, or a page past its last) were asked again, never taken
    expect(p.stats.shallow).toBeGreaterThan(0);
    expect(p.stats.failed).toBe(0);
    expect(searches(calls).every((u) => u.searchParams.get('order_by') === '"asc"')).toBe(true);
  });

  it('a query whose oldest transaction lies below the shallow index is shown deep at its first deep answer', async () => {
    let k = 0;
    const calls = osmosis({ deep: history(), pick: (n, u) => (u.pathname === '/status' ? (n % 2 ? 'shallow' : 'deep') : k++ < 4 ? 'shallow' : 'deep') });
    const p = pager();
    const st = await p.query(Q);
    // the 4 shallow answers of its oldest transaction, then the deep one, and no more
    expect(st).toMatchObject({ deep: 'below', total: 230, first: 1000 });
    expect(searches(calls).length).toBe(5);
  });

  it('a height\'s place is found by halving over pages of one transaction', async () => {
    const calls = osmosis({ deep: history(), pick: (n, u) => (u.pathname === '/status' && n % 2 ? 'shallow' : 'deep') });
    const p = pager();
    expect(await p.position(Q, 1000)).toBe(1);
    expect(await p.position(Q, 1001)).toBe(2);
    expect(await p.position(Q, 2005)).toBe(102); // 2,010 is the 102nd
    expect(await p.position(Q, 9999)).toBe(231); // past the last
    const ones = searches(calls).filter((u) => u.searchParams.get('per_page') === '1');
    // the oldest asked once, then at most 8 halvings for each of the 4 places
    expect(ones.length).toBeLessThanOrEqual(1 + 4 * 8);
  });

  it('transactions that come while the run reads are taken: the deep total grows', async () => {
    const deep = history(120);
    let n = 0;
    osmosis({ deep, pick: () => { if (++n === 12) deep.push(...history(160).slice(120)); return 'deep'; } });
    const p = pager();
    const got = await readAll(p, 1000, 99_999);
    expect(got.length).toBe(160);
    expect((await p.query(Q)).total).toBe(160);
  });

  it('a deep node a block behind (its total one short) is asked again, not taken', async () => {
    const deep = history();
    osmosis({ deep, pick: (n) => (n > 6 && n % 3 === 0 ? 'behind' : 'deep') });
    const p = pager();
    const got = await readAll(p, 1000, 99_999);
    expect(got.map((t) => t.hash)).toEqual(deep.map((t) => t.hash));
    expect(p.stats.shallow).toBeGreaterThan(0);
  });
});

describe('a failed read is asked again; one that keeps failing stops the run', () => {
  it('a page that fails four times is taken on its fifth read, after pauses of 1, 2, 4 and 8 s', async () => {
    const deep = history();
    let failures = 0;
    osmosis({ deep, pick: (_, u) => (u.searchParams.get('page') === '3' && u.searchParams.get('per_page') === '50' && failures++ < 4 ? 'fail' : 'deep') });
    const p = pager();
    const got = await readAll(p, 1000, 99_999);
    expect(got.length).toBe(230);
    expect(p.stats.failed).toBe(4);
    expect(pauses).toEqual([1000, 2000, 4000, 8000]);
  });

  it(`a page that fails ${PAGE_TRIES} times stops the run with the query and the page named, and nothing after it is read`, async () => {
    const calls = osmosis({ deep: history(), pick: (_, u) => (u.searchParams.get('page') === '3' && u.searchParams.get('per_page') === '50' ? 'fail' : 'deep') });
    const p = pager();
    const seen: string[] = [];
    const run = p.read(Q, 1000, 99_999, (txs) => { seen.push(...txs.map((t) => t.hash)); });
    await expect(run).rejects.toThrow(PagerError);
    await expect(run).rejects.toThrow(/query "transfer\.recipient='osmo1pool'" page 3 \(50 a page\): 5 reads failed, the last: HTTP 502/);
    // pages 1 and 2 were handed on; page 4 was never asked for
    expect(seen.length).toBe(100);
    expect(searches(calls).some((u) => u.searchParams.get('page') === '4' && u.searchParams.get('per_page') === '50')).toBe(false);
  });

  it(`a read only the shallow index keeps answering stops the run after ${SHALLOW_TRIES} answers`, async () => {
    // the deep index shows itself for the query's oldest transaction, then never answers again
    let k = 0;
    osmosis({ deep: history(), pick: (n, u) => (u.pathname === '/status' ? (n % 2 ? 'shallow' : 'deep') : k++ === 0 ? 'deep' : 'shallow') });
    const p = pager();
    await expect(readAll(p, 1500, 2000)).rejects.toThrow(/answers came from the shallow index or a node behind, none from the deep one/);
  });
});

describe('a query no answer showed deep', () => {
  it(`${DEEP_TRIES} answers of one total and none below the shallow index: agreed; a deeper answer after that stops the run`, async () => {
    let n = 0;
    const calls = osmosis({ deep: history(), pick: (_, u) => (u.pathname === '/status' ? 'shallow' : n++ < DEEP_TRIES ? 'shallow' : 'deep') });
    const p = pager();
    const st = await p.query(Q);
    expect(st).toMatchObject({ deep: 'agreed', total: 30, first: 3000 });
    expect(searches(calls).length).toBe(DEEP_TRIES);
    await expect(p.page(Q, 1)).rejects.toThrow(/a deeper index answered late/);
    // the deep index answers again: it is still there
    expect(await p.stillDeep(Q)).toBe(true);
  });

  it('a pool no transaction ever touched: agreed on 0, and its range is read as empty', async () => {
    osmosis({ deep: [], pick: (n, u) => (u.pathname === '/status' && n % 2 ? 'shallow' : 'deep') });
    const p = pager();
    expect(await readAll(p, 1000, 99_999)).toEqual([]);
    expect(await p.query(Q)).toMatchObject({ deep: 'agreed', total: 0, first: null });
    expect(await p.stillDeep(Q)).toBe(false);
  });

  it('two totals given without an answer below the shallow index (the /status answers named one first block): the larger is kept', async () => {
    let n = 0;
    // every /status answer is the deep node's, so nothing can lie below the first block they name
    osmosis({ deep: history(), pick: (_, u) => (u.pathname === '/status' ? 'deep' : n++ % 2 ? 'shallow' : 'deep') });
    const p = pager();
    const st = await p.query(Q);
    expect(st).toMatchObject({ deep: 'larger', total: 230 });
    expect(p.horizon).toBe(900);
  });
});

describe('blocks and transactions by hash', () => {
  it('the shallow index\'s "not available" and "not found" are asked again; the deep node\'s answer is taken', async () => {
    osmosis({ deep: history(), pick: (n) => (n % 2 ? 'shallow' : 'deep') });
    const p = pager();
    // request 0 is the deep node's, 1 the shallow's, and so on: each read below starts on a shallow answer
    await fetch('https://rpc.test/status');
    expect(await p.blockTime(1500)).toBe(Date.UTC(2026, 7, 10) + 1500 * 1000);
    expect((await p.tx(hashOf(3))).height).toBe('1030');
    expect(p.stats.shallow).toBe(2);
    expect(p.stats.failed).toBe(0);
  });
});
