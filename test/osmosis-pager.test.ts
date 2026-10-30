// Osmosis history repair (2026-10-29), scripts/osmosis-pager.ts: the pager scripts/backfill-osmosis.ts reads the
// history through. The history before 2026-10-21 lacked at least 350 pool transactions; the old backfill paged newest
// first and left a query at its first failed page, and osmosis-rpc.publicnode.com answers from a deep index (blocks from
// 2026-08-10) and a shallow one (about 16 hours) behind one name, in runs of up to 27 answers of one index in a row
// (measured 2026-10-29), so no count of agreeing answers shows the deep one. Every read is a JSON-RPC batch of a /status
// and the call, which one index answers whole, and the /status names that index's first block. Here a node with both
// indexes (and, where a test says, a deeper one), answering from either as the test says: the pager reads oldest first,
// takes an answer only when its /status names the deep index's first block (another index's answer, refusal, or a deep
// node a block behind is asked again on a new connection, after a pause doubling from 250 ms to 4 s, 40 times at
// most), asks a failed read again after 1, 2, 4 and 8 s and stops the run naming the query and page at the fifth
// failure, finds a height's place by halving over pages of one transaction, and goes on from a page it is given. No
// network: fetch is stubbed.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OsmosisPager, PAGE_TRIES, PagerError, SHALLOW_PAUSE_MAX_MS, SHALLOW_TRIES, STATUS_READS, STATUS_READS_MAX } from '../scripts/osmosis-pager';

afterEach(() => vi.unstubAllGlobals());

const Q = "transfer.recipient='osmo1pool'";
const hashOf = (i: number) => i.toString(16).toUpperCase().padStart(64, '0');
/** 230 transactions of Q, at heights 1,000 to 3,290 (10 apart). */
const history = (n = 230) => Array.from({ length: n }, (_, i) => ({ hash: hashOf(i), height: String(1000 + 10 * i), tx_result: { code: 0, events: [] } }));
/** The deep index holds the blocks from 900, the shallow one those from 3,000, a deeper one (where a test says) from 500. */
const DEEP = 900, HORIZON = 3000;

type Who = 'deep' | 'shallow' | 'fail' | 'behind' | 'deeper' | 'single';
interface Call { method: string; params: Record<string, string> }
interface Node {
  deep: any[];
  /** Who answers the n-th request (from 0), for its call. */
  pick: (n: number, call: Call) => Who;
}
interface Sent { call: Call; fresh: boolean; who: Who }
/** A node over the indexes; every request recorded. */
function osmosis(node: Node) {
  const sent: Sent[] = [];
  vi.stubGlobal('fetch', vi.fn(async (u: string, init: RequestInit) => {
    expect(String(u)).toBe('https://rpc.test');
    expect(init.method).toBe('POST');
    const batch = JSON.parse(String(init.body));
    expect(batch.map((x: any) => x.id)).toEqual([0, 1]);
    expect(batch[0].method).toBe('status');
    const call: Call = batch[1];
    const who = node.pick(sent.length, call);
    sent.push({ call, fresh: (init.headers as Record<string, string>)?.Connection === 'close', who });
    if (who === 'fail') return new Response('<html>502 Bad Gateway</html>', { status: 502 });
    // a node refusing batches answers with one error, not an array
    if (who === 'single') return Response.json({ jsonrpc: '2.0', id: -1, error: { code: -32600, message: 'Invalid Request', data: 'batch request exceeds maximum (1) allowed number of requests' } });
    const first = who === 'shallow' ? HORIZON : who === 'deeper' ? 500 : DEEP;
    const list = who === 'shallow' ? node.deep.filter((t) => Number(t.height) >= HORIZON) : who === 'behind' ? node.deep.slice(0, -1) : node.deep;
    const status = { sync_info: { latest_block_height: '4000', earliest_block_height: String(first) } };
    const ok = (result: unknown) => Response.json([{ jsonrpc: '2.0', id: 0, result: status }, { jsonrpc: '2.0', id: 1, result }]);
    const refuse = (data: string) => Response.json([{ jsonrpc: '2.0', id: 0, result: status }, { jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'Internal error', data } }]);
    if (call.method === 'status') return ok(status);
    if (call.method === 'block') {
      const h = Number(call.params.height);
      if (h < first) return refuse(`height ${h} is not available, lowest height is ${first}`);
      return ok({ block: { header: { height: String(h), time: new Date(Date.UTC(2026, 7, 10) + h * 1000).toISOString() } } });
    }
    if (call.method === 'tx') {
      const hash = Buffer.from(call.params.hash, 'base64').toString('hex').toUpperCase();
      const t = list.find((x) => x.hash === hash);
      return t ? ok(t) : refuse(`tx (${hash}) not found`);
    }
    expect(call.method).toBe('tx_search');
    expect(call.params.order_by).toBe('asc');
    expect(call.params.query).toBe(Q);
    const page = Number(call.params.page), per = Number(call.params.per_page);
    const pages = Math.max(1, Math.ceil(list.length / per));
    if (page > pages) return refuse(`page should be within [1, ${pages}] range, given ${page}`);
    return ok({ txs: list.slice((page - 1) * per, page * per), total_count: String(list.length) });
  }));
  return sent;
}
const pauses: number[] = [];
const pager = () => { pauses.length = 0; return new OsmosisPager('https://rpc.test', { sleep: async (ms) => { pauses.push(ms); } }); };
/** A pager past its opening /status reads (an index each in turn), its pauses since then recorded. */
async function started() {
  const p = pager();
  await p.status();
  pauses.length = 0;
  return p;
}
const searches = (sent: Sent[]) => sent.filter((s) => s.call.method === 'tx_search');
const alternate = (n: number): Who => (n % 2 ? 'shallow' : 'deep');
async function readAll(p: OsmosisPager, from: number, to: number) {
  const out: any[] = [];
  await p.read(Q, from, to, (txs) => { out.push(...txs); });
  return out;
}

describe('the deep index only, known by the /status in the same request', () => {
  it('a node answering from either index in turn: every answer taken is the deep index\'s, and the range comes whole and in order', async () => {
    const deep = history();
    const sent = osmosis({ deep, pick: alternate });
    const p = await started();
    expect([p.deepFirst, p.horizon]).toEqual([DEEP, HORIZON]);
    const got = await readAll(p, 1500, 2600);
    expect(got.map((t) => t.hash)).toEqual(deep.filter((t) => Number(t.height) >= 1500 && Number(t.height) <= 2600).map((t) => t.hash));
    expect(await p.query(Q)).toEqual({ q: Q, total: 230, first: 1000 });
    // the shallow index's answers (a total of 30, or a page past its last) were asked again, never taken
    expect(p.stats.shallow).toBeGreaterThan(0);
    expect(p.stats.failed).toBe(0);
  });

  it('the shallow index\'s answer is asked again even when it agrees with the deep one\'s (a query whose history is all recent)', async () => {
    // every transaction lies above the shallow index's first block: both indexes give the same pages
    const deep = history().filter((t) => Number(t.height) >= HORIZON);
    const sent = osmosis({ deep, pick: alternate });
    const p = await started();
    expect((await readAll(p, 0, 99_999)).map((t) => t.hash)).toEqual(deep.map((t) => t.hash));
    // each read ends on the deep index's answer: the request after a shallow answer is the same call again
    const reads = searches(sent);
    expect(reads.filter((s) => s.who === 'shallow').length).toBeGreaterThan(0);
    for (let i = 0; i < reads.length - 1; i++) if (reads[i].who === 'shallow') expect(reads[i + 1].call).toEqual(reads[i].call);
    expect(reads.at(-1)!.who).toBe('deep');
  });

  it('a run of 27 shallow answers in a row (as measured over one kept connection) is waited out on new connections, the pauses doubling from 250 ms to 4 s', async () => {
    let k = 0;
    const sent = osmosis({ deep: history(), pick: (n, c) => (c.method === 'status' ? alternate(n) : k++ < 27 ? 'shallow' : 'deep') });
    const p = await started();
    expect(await p.query(Q)).toMatchObject({ total: 230, first: 1000 });
    expect(pauses.slice(0, 6)).toEqual([250, 500, 1000, 2000, 4000, 4000]);
    expect(pauses.length).toBe(27);
    expect(Math.max(...pauses)).toBe(SHALLOW_PAUSE_MAX_MS);
    const s = searches(sent);
    // the first try on the kept connection, every one after it on a new one
    expect(s[0].fresh).toBe(false);
    expect(s.slice(1).every((x) => x.fresh)).toBe(true);
  });

  it(`a read only other indexes keep answering stops the run after ${SHALLOW_TRIES} answers`, async () => {
    let k = 0;
    osmosis({ deep: history(), pick: (n, c) => (c.method === 'status' ? alternate(n) : k++ === 0 ? 'deep' : 'shallow') });
    const p = await started();
    await expect(readAll(p, 1500, 2000)).rejects.toThrow(/40 answers came from another index than the deep one \(first block 900\)/);
  });

  it('an index naming a first block below the deep one\'s stops the run: places counted on one index are not another\'s', async () => {
    let k = 0;
    osmosis({ deep: history(), pick: (n, c) => (c.method === 'status' ? alternate(n) : k++ === 3 ? 'deeper' : 'deep') });
    const p = await started();
    await expect(readAll(p, 1000, 99_999)).rejects.toThrow(/an index whose first block is 500 answered, below the deep index's 900; run again/);
  });

  it(`the opening /status reads go on, up to ${STATUS_READS_MAX}, while they all name one first block; the lowest is the deep index's`, async () => {
    // the first 9 answers are all the shallow index's: the reads go on until the deep one answers
    const sent = osmosis({ deep: history(), pick: (n) => (n < 9 ? 'shallow' : 'deep') });
    const p = pager();
    expect(await p.status()).toEqual({ head: 4000, deepFirst: DEEP, horizon: HORIZON });
    expect(sent.length).toBe(10);
    // with both seen at once, STATUS_READS
    const again = osmosis({ deep: history(), pick: alternate });
    await pager().status();
    expect(again.length).toBe(STATUS_READS);
    // one index only: STATUS_READS_MAX, and its block is taken as the deep one's
    const one = osmosis({ deep: history(), pick: () => 'deep' });
    expect(await pager().status()).toMatchObject({ deepFirst: DEEP, horizon: DEEP });
    expect(one.length).toBe(STATUS_READS_MAX);
  });

  it('a height\'s place is found by halving over pages of one transaction', async () => {
    const sent = osmosis({ deep: history(), pick: (n, c) => (c.method === 'status' ? alternate(n) : 'deep') });
    const p = await started();
    expect(await p.position(Q, 1000)).toBe(1);
    expect(await p.position(Q, 1001)).toBe(2);
    expect(await p.position(Q, 2005)).toBe(102); // 2,010 is the 102nd
    expect(await p.position(Q, 9999)).toBe(231); // past the last
    const ones = searches(sent).filter((s) => s.call.params.per_page === '1');
    // the oldest asked once, then at most 8 halvings for each of the 4 places
    expect(ones.length).toBeLessThanOrEqual(1 + 4 * 8);
  });

  it('transactions that come while the run reads are taken: the deep total grows', async () => {
    const deep = history(120);
    let k = 0;
    osmosis({ deep, pick: (n, c) => { if (c.method === 'tx_search' && ++k === 4) deep.push(...history(160).slice(120)); return c.method === 'status' ? alternate(n) : 'deep'; } });
    const p = await started();
    const got = await readAll(p, 1000, 99_999);
    expect(got.length).toBe(160);
    expect((await p.query(Q)).total).toBe(160);
  });

  it('a deep node a block behind (its total one short) is asked again, not taken', async () => {
    const deep = history();
    osmosis({ deep, pick: (n, c) => (c.method === 'status' ? alternate(n) : n % 3 === 0 ? 'behind' : 'deep') });
    const p = await started();
    const got = await readAll(p, 1000, 99_999);
    expect(got.map((t) => t.hash)).toEqual(deep.map((t) => t.hash));
    expect(p.stats.shallow).toBeGreaterThan(0);
  });

  it('a run stopped part way goes on from the page it is given, without finding its place again', async () => {
    const deep = history();
    const sent = osmosis({ deep, pick: (n, c) => (c.method === 'status' ? alternate(n) : 'deep') });
    const p = await started();
    const pages: number[] = [];
    const out: any[] = [];
    await p.read(Q, 1000, 99_999, (txs, page) => { pages.push(page); out.push(...txs); }, 4);
    expect(pages).toEqual([4, 5]);
    expect(out.map((t) => t.hash)).toEqual(deep.slice(150).map((t) => t.hash));
    // the oldest (the query's total) and the two pages: no halving
    expect(searches(sent).map((s) => `${s.call.params.page}/${s.call.params.per_page}`)).toEqual(['1/1', '4/50', '5/50']);
  });
});

describe('a failed read is asked again; one that keeps failing stops the run', () => {
  it('a page that fails four times is taken on its fifth read, after pauses of 1, 2, 4 and 8 s', async () => {
    let failures = 0;
    osmosis({ deep: history(), pick: (n, c) => (c.method === 'status' ? alternate(n) : c.params.page === '3' && c.params.per_page === '50' && failures++ < 4 ? 'fail' : 'deep') });
    const p = await started();
    const got = await readAll(p, 1000, 99_999);
    expect(got.length).toBe(230);
    expect(p.stats.failed).toBe(4);
    expect(pauses).toEqual([1000, 2000, 4000, 8000]);
  });

  it(`a page that fails ${PAGE_TRIES} times stops the run with the query and the page named, and nothing after it is read`, async () => {
    const sent = osmosis({ deep: history(), pick: (n, c) => (c.method === 'status' ? alternate(n) : c.params.page === '3' && c.params.per_page === '50' ? 'fail' : 'deep') });
    const p = await started();
    const seen: string[] = [];
    const run = p.read(Q, 1000, 99_999, (txs) => { seen.push(...txs.map((t) => t.hash)); });
    await expect(run).rejects.toThrow(PagerError);
    await expect(run).rejects.toThrow(/query "transfer\.recipient='osmo1pool'" page 3 \(50 a page\): 5 reads failed, the last: HTTP 502/);
    // pages 1 and 2 were handed on; page 4 was never asked for
    expect(seen.length).toBe(100);
    expect(searches(sent).some((s) => s.call.params.page === '4' && s.call.params.per_page === '50')).toBe(false);
  });

  it('a node that refuses the batch fails the read like any other failure, and the run stops naming it', async () => {
    osmosis({ deep: history(), pick: (n, c) => (c.method === 'status' ? alternate(n) : 'single') });
    const p = await started();
    await expect(p.query(Q)).rejects.toThrow(/5 reads failed, the last: HTTP 200, not a batch answer: Invalid Request batch request exceeds maximum/);
  });
});

describe('blocks and transactions by hash', () => {
  it('another index\'s "not available" and "not found" are asked again; a block it holds is taken from it', async () => {
    let k = 0;
    osmosis({ deep: history(), pick: (n, c) => (c.method === 'status' ? alternate(n) : k++ % 2 ? 'deep' : 'shallow') });
    const p = await started();
    // each read below starts on a shallow answer
    expect(await p.blockTime(1500)).toBe(Date.UTC(2026, 7, 10) + 1500 * 1000);
    expect((await p.tx(hashOf(3))).height).toBe('1030');
    expect(p.stats.shallow).toBe(2);
    // a block the shallow index holds is the same block: taken from the first answer
    expect(await p.blockTime(3500)).toBe(Date.UTC(2026, 7, 10) + 3500 * 1000);
    expect(p.stats.shallow).toBe(2);
    expect(p.stats.failed).toBe(0);
  });
});
