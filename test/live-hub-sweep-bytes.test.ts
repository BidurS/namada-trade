// Security review (2026-10-22), the catch-up search's bytes: each of its reads was capped at FETCH_TEXT_MAX_BYTES,
// but the search kept every page's transactions until it ended, so a node answering sixteen pages just under the cap
// put about 264 MB in the 128 MB isolate. And a page past the cap, which is chain data both Osmosis nodes serve the
// same (anyone can make 50 transactions that match a query large), was refused by both on every search: the search
// never finished, osmosis.cursor froze, a transaction the stream missed below that page was never read, and each
// refusal sent the healthy node to the back of the line. Now the pages a search keeps share one byte budget (a page
// none of whose transactions it keeps gives its bytes back), a page every node refuses as too large is read again in
// pages of 10 and then of 1, a single transaction past the cap is skipped and named in the cursor, and an answer past
// the cap never sends a node to the back of the line.
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import { LiveHub, OSMOSIS_SWEEP_MAX_BYTES } from '../worker/src/live-hub';
import { HubQuote } from '../worker/src/live-quote';
import { NAM } from '../worker/src/config';
import { FETCH_TEXT_MAX_BYTES } from '../worker/src/util';
import { testD1, type TestD1 } from './d1-sqlite';

afterEach(() => vi.unstubAllGlobals());

const MiB = 1024 * 1024;
const CURSOR = 1_000_000;
const HEAD = 1_000_500;
const TRANSFER_Q = 'transfer.amount';

interface Tx { hash: string; height: number; pad?: number }
/** A 50 NAM bank transfer (one flow), padded with a field the parser never reads. */
const txJson = (t: Tx) => ({
  hash: t.hash, height: String(t.height), tx: 'A'.repeat(t.pad ?? 0),
  tx_result: { code: 0, events: [{ type: 'transfer', attributes: [{ key: 'recipient', value: `osmo1recv${t.hash.slice(0, 6)}` }, { key: 'sender', value: 'osmo1send' }, { key: 'amount', value: `${50 * 1e6}${NAM.osmoDenom}` }] }] },
});

/**
 * Both Osmosis nodes over one chain: the transfer query matches `txs` (newest first), the others nothing. A page is
 * the slice its page and per_page name, streamed in 1 MiB chunks with no Content-Length. `asked` logs "node query
 * per_page page" for every tx_search read; `blocks` counts the block-time reads, one for each transaction a search held.
 */
function osmosis(txs: Tx[], opts: { padOn?: string } = {}) {
  const asked: string[] = [];
  let blocks = 0;
  vi.stubGlobal('fetch', vi.fn(async (u: string) => {
    const url = new URL(String(u));
    const who = url.host.includes('publicnode') ? 'publicnode' : 'keplr';
    if (url.pathname.endsWith('/status')) return Response.json({ result: { sync_info: { latest_block_height: String(HEAD) } } });
    if (url.pathname.endsWith('/block')) { blocks++; return Response.json({ result: { block: { header: { time: new Date(Date.now() - 60_000).toISOString() } } } }); }
    if (!url.pathname.endsWith('/tx_search')) throw new Error(`unexpected ${url}`);
    const per = Number(url.searchParams.get('per_page')), page = Number(url.searchParams.get('page'));
    const transfer = (url.searchParams.get('query') ?? '').includes(TRANSFER_Q);
    asked.push(`${who} ${transfer ? 'transfer' : 'other'} ${per} ${page}`);
    const list = transfer ? txs : [];
    const part = list.slice((page - 1) * per, page * per);
    // a node padding its answer past the cap (opts.padOn): the other node answers the same page as it is
    const body = new TextEncoder().encode(JSON.stringify({ result: { txs: part.map(txJson), total_count: String(list.length) }, ...(who === opts.padOn ? { pad: 'P'.repeat(FETCH_TEXT_MAX_BYTES) } : {}) }));
    let o = 0;
    return new Response(new ReadableStream<Uint8Array>({
      pull(c) {
        if (o >= body.length) { c.close(); return; }
        c.enqueue(body.subarray(o, o + MiB)); o += MiB;
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  return { asked, blocks: () => blocks };
}

function hubOn(db: TestD1) {
  return Object.assign(Object.create(LiveHub.prototype), {
    env: { DB: db, KEPLR_KEY: 'dummy' },
    seenOsmoTx: new Set<string>(), osmoRetryTx: new Map<string, number>(), osmoWriting: new Map(), osmoRetryFrom: null, osmoRetryGen: 0, osmoHeight: 0,
    sessions: new Set(), lastPriceUsd: null, needSweep: false,
    osmoCtx: { poolAddrs: new Map(), priceUsd: null, assets: new Map() },
    quote: new HubQuote(async () => null, async () => null),
  }) as any;
}
const setup = async () => {
  const db = testD1();
  await db.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('osmosis.cursor', ?, 0)").bind(JSON.stringify({ height: CURSOR, at: 1 })).run();
  return { db, hub: hubOn(db), cursor: () => JSON.parse((db.raw.prepare("SELECT value FROM kv WHERE key='osmosis.cursor'").get() as any).value) };
};
const stored = (db: TestD1, hash: string) => (db.raw.prepare('SELECT COUNT(*) AS n FROM flows WHERE tx_hash = ?').get(hash) as any).n as number;
const hashOf = (p: string, i: number) => `${p}${String(i).padStart(64 - p.length, '0')}`;

describe('the pages a catch-up search keeps share one byte budget', () => {
  it('pages just under the cap: the search takes in at most its budget, stops there unfinished, and the next searches go on', async () => {
    // 180 transfers above the cursor, each at its own height and about 330 KB: a page of 50 is 16.5 MB, under the cap
    const PAD = 330_000;
    const txs = Array.from({ length: 180 }, (_, i) => ({ hash: hashOf('BB', i), height: HEAD - 1 - i, pad: PAD }));
    const s = await setup();
    const o = osmosis(txs);
    let before = 0;
    const held: number[] = [];
    for (let n = 0; n < 6 && s.cursor().height !== HEAD; n++) {
      await s.hub.sweepOsmosis();
      held.push(o.blocks() - before);
      before = o.blocks();
    }
    // what one search holds together, however many pages there are, is within its budget (before: all 180, 59 MB)
    expect(Math.max(...held) * PAD).toBeLessThanOrEqual(24 * MiB);
    expect(held[0]).toBeGreaterThan(0);
    expect(OSMOSIS_SWEEP_MAX_BYTES).toBe(24 * MiB);
    // and it still gets there: the pages already written give their bytes back
    expect(s.cursor().height).toBe(HEAD);
    expect(txs.every((t) => stored(s.db, t.hash) === 1)).toBe(true);
  }, 120_000);
});

describe('a page past the cap on every node', () => {
  it('is read again in pages of 10: the search finishes, and the transfer the stream missed below it is written', async () => {
    // 50 transfers of about 350 KB each (a 17.5 MB page), and under them the one the stream missed
    const big = Array.from({ length: 50 }, (_, i) => ({ hash: hashOf('CC', i), height: HEAD - 1 - i, pad: 350_000 }));
    const missed = { hash: hashOf('DD', 0), height: 1_000_100 };
    const s = await setup();
    const o = osmosis([...big, missed]);
    await s.hub.sweepOsmosis();
    expect(s.cursor()).toMatchObject({ height: HEAD });
    expect(s.cursor().error).toBeUndefined();
    expect(stored(s.db, missed.hash)).toBe(1);
    expect(big.every((t) => stored(s.db, t.hash) === 1)).toBe(true);
    const transfer = o.asked.filter((a) => a.includes(' transfer '));
    expect(transfer.slice(0, 3)).toEqual(['publicnode transfer 50 1', 'keplr transfer 50 1', 'publicnode transfer 10 1']);
    // no node is sent to the back of the line for chain data: the public node is still asked first, and answers
    expect(o.asked.filter((a) => a !== 'keplr transfer 50 1').every((a) => a.startsWith('publicnode'))).toBe(true);
  }, 120_000);

  it('a single transaction past the cap is skipped and named in the cursor; the query still answers and the search finishes', async () => {
    const txs: Tx[] = Array.from({ length: 8 }, (_, i) => ({ hash: hashOf('EE', i), height: HEAD - 1 - i }));
    txs.splice(3, 0, { hash: hashOf('FF', 0), height: HEAD - 3, pad: FETCH_TEXT_MAX_BYTES });
    const s = await setup();
    osmosis(txs);
    await s.hub.sweepOsmosis();
    const c = s.cursor();
    expect(c.height).toBe(HEAD);
    expect(c.skipped.map((x: any) => x.note)).toEqual([`query "transfer.amount CONTAINS '${NAM.osmoHash}'": the transaction after block ${HEAD - 3} was past the cap on every node and is not read`]);
    expect(txs.filter((t) => !t.pad).every((t) => stored(s.db, t.hash) === 1)).toBe(true);
    // named once, however many searches find it again
    await s.hub.sweepOsmosis();
    expect(s.cursor().skipped).toHaveLength(1);
  }, 120_000);

  it('a page only one node pads past the cap is the other node\'s answer: no split, no skip, and nobody sent to the back', async () => {
    const txs: Tx[] = Array.from({ length: 3 }, (_, i) => ({ hash: hashOf('AB', i), height: HEAD - 1 - i }));
    const s = await setup();
    const o = osmosis(txs, { padOn: 'publicnode' });
    await s.hub.sweepOsmosis();
    expect(s.cursor().height).toBe(HEAD);
    expect(s.cursor().skipped).toBeUndefined();
    expect(txs.every((t) => stored(s.db, t.hash) === 1)).toBe(true);
    // every page asked of the padding node first, then of the other: four queries, page 1 each, none split
    expect(o.asked.map((a) => a.replace(/ (transfer|other) /, ' '))).toEqual(Array.from({ length: 4 }, () => ['publicnode 50 1', 'keplr 50 1']).flat());
  }, 120_000);
});
