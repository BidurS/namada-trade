// Security review (2026-10-22), live scan head on one node's word: when the two Namada nodes disagreed, the scan
// followed the lower one alone. One node on this chain answering a fresh but low height, while the other node was at
// the head, moved an honest cursor back, made itself the only source of the blocks read, held the scan while the
// other node served blocks, and on agreement the jump called blocks that had been scanned "not scanned". The cursor
// reset read blocks again, and each re-read counted an address link a second time. Now only a head two answers agree
// on (two nodes, or one node and the indexer's latest block as the cron stored it) moves the cursor back or jumps; on
// one node's word the scan follows the lowest node not far below its cursor, at most SCAN_MAX_LAG blocks a tick; a
// link is counted only with a flow not stored yet; and each node's /status has a short timeout of its own.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import { LiveHub, LIVE_STATUS_MS, SCAN_MAX_LAG } from '../worker/src/live-hub';
import { HubQuote } from '../worker/src/live-quote';
import { chainHead, HEAD_VOTE_MAX_AGE_MS, type NodeStatus } from '../worker/src/sources/namada';
import { NAMADA } from '../worker/src/config';
import { testD1, type TestD1 } from './d1-sqlite';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const X = 'tnam1qr4wemkpjfycn7ts7297e8qecg2t6pf2vq2wulsa';
const OSMO = 'osmo19v0z78d8gv02t4cfqvmtklppu4rmpp5ek3q9a8';
/** Block 7,153,723 (a NAM receipt from Osmosis), its receiver made a transparent account: one receive, one address link. */
const recvEvents = () => JSON.parse(readFileSync(join(__dirname, 'fixtures', 'namada_block_7153723.json'), 'utf8')).result.end_block_events
  .map((e: any) => ({ ...e, attributes: e.attributes.map((a: any) => ({ ...a, value: String(a.value).split(NAMADA.internal.masp).join(X) })) }));

interface NodeSpec { height: number; down?: boolean; statusOnly?: boolean; events?: Record<number, any[]> }
/** The two configured nodes, as CometBFT answers; every request is logged as "node path?query". */
function chain(spec: { five: NodeSpec; papa: NodeSpec }) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (u: string) => {
    const url = new URL(String(u));
    const who = url.host.includes('5elementsnodes') ? 'five' : 'papa';
    const n = spec[who];
    calls.push(`${who} ${url.pathname}${url.search}`);
    if (n.down) throw new Error('refused');
    if (url.pathname === '/status') {
      return Response.json({ result: { node_info: { network: NAMADA.chainId }, sync_info: { latest_block_height: String(n.height), latest_block_time: new Date().toISOString(), catching_up: false, earliest_block_height: '1' } } });
    }
    if (n.statusOnly) return Response.json({ error: { code: -32603, message: 'Internal error' } });
    if (url.pathname === '/blockchain') {
      const lo = Number(url.searchParams.get('minHeight')), hi = Math.min(Number(url.searchParams.get('maxHeight')), n.height);
      if (lo > hi) return Response.json({ error: { code: -32603, message: 'Internal error' } });
      const metas = [];
      for (let h = hi; h >= lo; h--) metas.push({ header: { chain_id: NAMADA.chainId, height: String(h), time: new Date().toISOString() }, num_txs: '0' });
      return Response.json({ result: { last_height: String(n.height), block_metas: metas } });
    }
    if (url.pathname === '/block_results') {
      const h = Number(url.searchParams.get('height'));
      if (h > n.height) return Response.json({ error: { code: -32603, message: 'Internal error' } });
      return Response.json({ result: { height: String(h), end_block_events: n.events?.[h] ?? [] } });
    }
    throw new Error(`unexpected ${url}`);
  }));
  return calls;
}

const hubOf = (db: TestD1) => Object.assign(Object.create(LiveHub.prototype), {
  env: { DB: db }, sessions: new Set(), lastPriceUsd: null, namadaHeight: 0, quote: new HubQuote(async () => null, async () => null),
}) as any;
const cursor = (db: TestD1) => (db.raw.prepare("SELECT value FROM kv WHERE key = 'namada.cursor'").get() as any)?.value;
const setCursor = (db: TestD1, v: string) => db.raw.prepare("INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES ('namada.cursor', ?, 0)").run(v);
const notes = (db: TestD1): string[] => JSON.parse((db.raw.prepare("SELECT value FROM kv WHERE key = 'namada.scan'").get() as any)?.value ?? '{"failures":[]}').failures.map((f: any) => f.note);
const link = (db: TestD1) => db.raw.prepare('SELECT transfers, volume_num FROM address_links WHERE osmo_addr = ? AND namada_addr = ?').get(OSMO, X) as any;
const blockReads = (calls: string[], who: string) => calls.filter((c) => c.startsWith(who) && !c.endsWith('/status'));
/** The indexer's latest block as the cron stores it (cron.ts, checks 'indexer_lag'). */
const vote = (db: TestD1, indexerHeight: number, at = Date.now(), lagBlocks = 0) =>
  db.raw.prepare("INSERT OR REPLACE INTO checks (key, status, title, detail, checked_at) VALUES ('indexer_lag', 'ok', 'indexer', ?, ?)")
    .run(JSON.stringify({ indexerHeight, rpcHeight: indexerHeight + lagBlocks, lagBlocks }), at);

describe('one node\'s fresh low height never moves an honest cursor back', () => {
  it('a node 300,000 blocks low: no rewind, no block read from it, the link counted once, no false "not scanned" note', async () => {
    const db = testD1();
    setCursor(db, '8299950');
    const events = { 8_299_990: recvEvents() };
    const spec = { five: { height: 8_300_000, events }, papa: { height: 8_300_000, events } };
    chain(spec);
    const hub = hubOf(db);
    await hub.scanNamada();
    expect(cursor(db)).toBe('8300000');
    expect(link(db).transfers).toBe(1);

    spec.five.height = 8_000_000; spec.papa.height = 8_300_003;
    const calls = chain(spec);
    await hub.scanNamada();
    expect(cursor(db)).toBe('8300003');
    expect(blockReads(calls, 'five')).toEqual([]);
    expect(blockReads(calls, 'papa').length).toBeGreaterThan(0);

    spec.five.height = 8_300_010; spec.papa.height = 8_300_010;
    chain(spec);
    await hub.scanNamada();
    expect(cursor(db)).toBe('8300010');
    expect(link(db).transfers).toBe(1);
    expect(notes(db).filter((n) => /not scanned/.test(n))).toEqual([]);
  });

  it('a node 150 blocks low: the scan reads on from the other node, never scans a block twice, and jumps nothing later', async () => {
    const db = testD1();
    setCursor(db, '8299800');
    const events = { 8_299_830: recvEvents() };
    const spec = { five: { height: 8_299_850, events }, papa: { height: 8_299_850, events } };
    chain(spec);
    const hub = hubOf(db);
    for (const h of [8_299_850, 8_299_900, 8_299_950, 8_300_000]) {
      spec.five.height = h; spec.papa.height = h;
      await hub.scanNamada();
    }
    expect(cursor(db)).toBe('8300000');
    expect(link(db).transfers).toBe(1);

    spec.five.height = 8_300_010; spec.papa.height = 8_299_860;
    const calls = chain(spec);
    await hub.scanNamada();
    expect(cursor(db)).toBe('8300010');
    expect(blockReads(calls, 'papa')).toEqual([]);
    expect(blockReads(calls, 'five').some((c) => c.includes('height=8299'))).toBe(false); // nothing below the cursor again

    spec.five.height = 8_300_020; spec.papa.height = 8_300_020;
    chain(spec);
    await hub.scanNamada();
    expect(cursor(db)).toBe('8300020');
    expect(link(db).transfers).toBe(1);
    expect(notes(db).filter((n) => /not scanned|restarts/.test(n))).toEqual([]);
  });

  it('a node that answers its /status low and serves no block moves nothing', async () => {
    const db = testD1();
    setCursor(db, '8300000');
    chain({ five: { height: 8_300_010 }, papa: { height: 8_299_800, statusOnly: true } });
    await hubOf(db).scanNamada();
    expect(cursor(db)).toBe('8300010');
    expect(notes(db).filter((n) => /restarts|not scanned/.test(n))).toEqual([]);
  });
});

describe('a node low but near the cursor, while the other reads on', () => {
  it('with the indexer\'s latest block agreeing with the node at the head, the scan follows it: no stall, no blocks jumped', async () => {
    const db = testD1();
    setCursor(db, '8300100');
    const spec = { five: { height: 8_300_100 }, papa: { height: 8_300_030 } };
    let calls = chain(spec);
    const hub = hubOf(db);
    for (let h = 8_300_140; h <= 8_300_200; h += 10) {
      spec.five.height = h;
      vote(db, h - 2);
      calls = chain(spec);
      await hub.scanNamada();
      expect(cursor(db)).toBe(String(h - 2)); // no higher than the vote, which is a little behind the chain
      expect(blockReads(calls, 'papa')).toEqual([]);
    }
    spec.papa.height = 8_300_200;
    chain(spec);
    await hub.scanNamada();
    expect(cursor(db)).toBe('8300200');
    expect(notes(db).filter((n) => /not scanned/.test(n))).toEqual([]);
    expect(notes(db)[0]).toBe('the Namada nodes disagree on the head (5ElementsNodes 8300140, Papadritta 8300030): the scan follows 5ElementsNodes, which the indexer\'s latest block agrees with');
  });

  it('with no second answer it waits on the lower node: it neither moves back nor reads from it (accepted: nothing tells the nodes apart)', async () => {
    const db = testD1();
    setCursor(db, '8300100');
    const calls = chain({ five: { height: 8_300_140 }, papa: { height: 8_300_030 } });
    const hub = hubOf(db);
    await hub.scanNamada();
    expect(cursor(db)).toBe('8300100');
    expect(blockReads(calls, 'papa')).toEqual([]);
    expect(blockReads(calls, 'five')).toEqual([]);
  });

  it('a vote stored more than three minutes ago, or by an indexer then far from the nodes\' head, is not a second answer', async () => {
    expect(HEAD_VOTE_MAX_AGE_MS).toBe(3 * 60_000);
    for (const v of [{ at: Date.now() - 3 * 60_000 - 1000, lag: 0 }, { at: Date.now(), lag: 400 }]) {
      const db = testD1();
      setCursor(db, '8300100');
      vote(db, 8_300_138, v.at, v.lag);
      chain({ five: { height: 8_300_140 }, papa: { height: 8_300_030 } });
      await hubOf(db).scanNamada();
      expect(cursor(db), JSON.stringify(v)).toBe('8300100');
    }
  });
});

describe('the cursor reset reads blocks again without counting them twice', () => {
  it('both nodes agree far below a cursor written too high: it restarts below the head, and the link is still counted once', async () => {
    const db = testD1();
    setCursor(db, '8299950');
    const events = { 8_299_970: recvEvents() };
    const spec = { five: { height: 8_300_000, events }, papa: { height: 8_300_000, events } };
    chain(spec);
    const hub = hubOf(db);
    await hub.scanNamada();
    const once = link(db);
    expect(once.transfers).toBe(1);
    setCursor(db, '40000000');
    spec.five.height = 8_300_010; spec.papa.height = 8_300_010;
    const calls = chain(spec);
    await hub.scanNamada();
    expect(cursor(db)).toBe('8300010');
    expect(calls.some((c) => c.includes('/block_results?height=8299970'))).toBe(true); // read again
    expect(link(db)).toEqual(once);
  });

  it('a lone node far ahead is followed only as far as the chain can have gone since the last agreed head, 50 blocks a tick, jumping nothing; both nodes agreeing later restart it, counting nothing twice', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const db = testD1();
    setCursor(db, '8299980');
    const events = { 8_299_990: recvEvents() };
    const spec = { five: { height: 8_300_000, events } as NodeSpec, papa: { height: 8_300_000, events } as NodeSpec };
    chain(spec);
    const hub = hubOf(db);
    await hub.scanNamada(); // both nodes agree on 8,300,000: the last agreed head
    expect(link(db).transfers).toBe(1);

    spec.papa.down = true; spec.five.height = 8_300_200;
    chain(spec);
    await hub.scanNamada();
    expect(cursor(db)).toBe('8300000'); // 8,300,200 is past 8,300,000 + 100 a moment after the agreed head
    expect(notes(db).at(-1)).toBe('the only Namada node at the head (5ElementsNodes 8300200) is above 8300100, past where the chain can be by the last agreed head and the indexer\'s latest block, and no second answer agrees with it: the scan waits');
    vi.setSystemTime(Date.now() + 10 * 60_000); // 120 blocks a 5 s block could have made since
    chain(spec);
    for (const want of ['8300050', '8300100', '8300150', '8300200']) {
      await hub.scanNamada();
      expect(cursor(db)).toBe(want);
    }
    expect(notes(db).filter((n) => /not scanned/.test(n))).toEqual([]);

    spec.papa.down = false; spec.five.height = 8_300_010; spec.papa.height = 8_300_010;
    chain(spec);
    await hub.scanNamada();
    expect(cursor(db)).toBe('8300010');
    expect(link(db).transfers).toBe(1);
    vi.useRealTimers();
  });

  it('a lone node far below a cursor written too high waits; the indexer agreeing with it does not move the cursor back, both nodes agreeing does', async () => {
    const db = testD1();
    setCursor(db, '40000000');
    const spec = { five: { height: 8_300_010 } as NodeSpec, papa: { height: 1, down: true } as NodeSpec };
    const calls = chain(spec);
    const hub = hubOf(db);
    await hub.scanNamada();
    expect(cursor(db)).toBe('40000000');
    expect(blockReads(calls, 'five')).toEqual([]);
    expect(notes(db)).toEqual(['the only Namada node at the head (5ElementsNodes 8300010) is more than 100 blocks below the scan\'s cursor 40000000, and no second answer agrees with it: the scan waits']);
    // One node and the indexer can both be behind by as much (a node stuck behind, an indexer lagging as far): they
    // never move the cursor back.
    vote(db, 8_300_000);
    await hub.scanNamada();
    expect(cursor(db)).toBe('40000000');
    expect(notes(db).at(-1)).toBe('the scan\'s cursor 40000000 is 31700000 blocks above the head 8300000, which only one node and the indexer give: it is moved back only on a head both nodes agree on, and the scan waits');
    spec.papa = { height: 8_300_010 };
    chain(spec);
    await hub.scanNamada();
    expect(cursor(db)).toBe('8300010');
    expect(notes(db).at(-1)).toBe('the scan\'s cursor 40000000 was 31699990 blocks above the head 8300010: the scan restarts at block 8299961, and blocks it missed before then are not scanned');
  });
});

describe('a node that hangs on /status', () => {
  it('holds the scan of the other node\'s blocks for at most LIVE_STATUS_MS (3 s), not a block read\'s ten seconds', async () => {
    vi.useFakeTimers();
    const db = testD1();
    setCursor(db, '8300000');
    vi.stubGlobal('fetch', vi.fn((u: string, init?: RequestInit) => {
      const url = new URL(String(u));
      if (!url.host.includes('5elementsnodes')) return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
      if (url.pathname === '/status') return Promise.resolve(Response.json({ result: { node_info: { network: NAMADA.chainId }, sync_info: { latest_block_height: '8300001', latest_block_time: new Date().toISOString(), catching_up: false } } }));
      if (url.pathname === '/blockchain') return Promise.resolve(Response.json({ result: { block_metas: [{ header: { chain_id: NAMADA.chainId, height: '8300001', time: new Date().toISOString() }, num_txs: '0' }] } }));
      if (url.pathname === '/block_results') return Promise.resolve(Response.json({ result: { height: '8300001', end_block_events: [] } }));
      return Promise.reject(new Error('unexpected'));
    }));
    const t0 = Date.now();
    let done = false;
    const p = hubOf(db).scanNamada().finally(() => { done = true; });
    for (let i = 0; !done && i < 40; i++) await vi.advanceTimersByTimeAsync(250);
    await p;
    expect(cursor(db)).toBe('8300001');
    expect(Date.now() - t0).toBeLessThanOrEqual(3000 + 250);
    expect(LIVE_STATUS_MS).toBe(3000);
  });
});

describe('chainHead with the cursor and a vote', () => {
  const NOW = Date.UTC(2026, 9, 22, 12);
  const st = (provider: string, height: number): NodeStatus => ({ provider, network: NAMADA.chainId, height, time: NOW - 7000, catchingUp: false });
  it('two nodes within 100 blocks agree; one node alone does not, unless the vote, moved on by the blocks since, is near it', () => {
    expect(chainHead([st('5ElementsNodes', 8_300_000), st('Papadritta', 8_300_050)], NOW, 8_299_990).agreed).toBe(true);
    expect(chainHead([st('5ElementsNodes', 8_300_000)], NOW, 8_299_990).agreed).toBe(false);
    // stored 170 s ago at 8,299,880: about 24 blocks since, so 8,300,000 is within 100 of it
    expect(chainHead([st('5ElementsNodes', 8_300_000)], NOW, 8_299_990, { height: 8_299_880, at: NOW - 170_000 }).agreed).toBe(true);
    expect(chainHead([st('5ElementsNodes', 8_300_000)], NOW, 8_299_990, { height: 8_299_880, at: NOW - 10_000 }).agreed).toBe(false);
    expect(chainHead([st('5ElementsNodes', 8_300_000)], NOW, 8_299_990, { height: 8_300_000, at: NOW - HEAD_VOTE_MAX_AGE_MS - 1 }).agreed).toBe(false);
  });
  it('nodes that disagree with no vote: the lowest node not more than 100 below the cursor, read from it alone', () => {
    const h = chainHead([st('5ElementsNodes', 40_000_000), st('Papadritta', 8_300_010)], NOW, 8_300_000);
    expect([h.height, h.rpcs.map((r) => r.provider), h.agreed]).toEqual([8_300_010, ['Papadritta'], false]);
    const low = chainHead([st('5ElementsNodes', 8_300_010), st('Papadritta', 8_000_000)], NOW, 8_300_000);
    expect([low.height, low.rpcs.map((r) => r.provider), low.agreed]).toEqual([8_300_010, ['5ElementsNodes'], false]);
    expect(SCAN_MAX_LAG).toBe(50);
  });
});
