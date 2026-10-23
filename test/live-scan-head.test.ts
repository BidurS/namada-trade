// Security review (2026-10-22), live scan head: the LiveHub followed the first node that answered /status, whatever
// chain it named, while it was catching up, and with any height. A node on another network at 40,000,000 that served
// blocks there moved the cursor to 40,000,000: the scan then stopped until the chain passed it, and the holder rows
// those blocks touched kept that height above every listing. Now the scan reads every node's status, follows only
// nodes on this chain, not catching up, with a newest block from the last five minutes and agreeing within 100
// blocks, reads the blocks from those nodes only, refuses a block of another chain, and moves a cursor found above
// the head back below it.
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import { LiveHub } from '../worker/src/live-hub';
import { HubQuote } from '../worker/src/live-quote';
import * as namada from '../worker/src/sources/namada';
import { NAM, NAMADA } from '../worker/src/config';
import { testD1, type TestD1 } from './d1-sqlite';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const HOLDER = 'tnam1qq6wus66shjjwhe48c3udfyrh05vq62s0ysy3flp';
const SENDER = 'tnam1qr4l8egaskk09460llz0qctac7sgemynpu8c7vvd';
const acct = (a: string, n: string) => [[`internal-address/${a}`, NAM.namadaToken], n];
const transfer = (post: string) => ({
  type: 'token/transfer',
  attributes: [
    { key: 'hash', value: 'AB'.repeat(32) },
    { key: 'inner-tx-hash', value: 'CD'.repeat(32) },
    { key: 'source-accounts', value: JSON.stringify([acct(SENDER, '1000000')]) },
    { key: 'target-accounts', value: JSON.stringify([acct(HOLDER, '1000000')]) },
    { key: 'post-balances', value: JSON.stringify([acct(HOLDER, post)]) },
    { key: 'token-event-descriptor', value: 'transfer-from-wasm' },
  ],
});

interface NodeSpec { height: number; catchingUp?: boolean; network?: string; down?: boolean; blockAgeMs?: number; events?: Record<number, any[]> }
/** The two configured nodes behind one fetch stub, as CometBFT answers; every request is logged as "node path". */
function chain(spec: { five: NodeSpec; papa: NodeSpec }) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (u: string) => {
    const url = new URL(String(u));
    const who = url.host.includes('5elementsnodes') ? 'five' : 'papa';
    const n = spec[who];
    calls.push(`${who} ${url.pathname}${url.search}`);
    if (n.down) throw new Error('refused');
    const network = n.network ?? NAMADA.chainId;
    if (url.pathname === '/status') {
      return Response.json({ result: { node_info: { network }, sync_info: { latest_block_height: String(n.height), latest_block_time: new Date(Date.now() - (n.blockAgeMs ?? 0)).toISOString(), catching_up: !!n.catchingUp, earliest_block_height: '1' } } });
    }
    if (url.pathname === '/blockchain') {
      const lo = Number(url.searchParams.get('minHeight')), hi = Math.min(Number(url.searchParams.get('maxHeight')), n.height);
      if (lo > hi) return Response.json({ error: { code: -32603, message: 'Internal error', data: `min height ${lo} can't be greater than max height ${n.height}` } });
      const metas = [];
      for (let h = hi; h >= lo; h--) metas.push({ header: { chain_id: network, height: String(h), time: new Date().toISOString() }, num_txs: '0' });
      return Response.json({ result: { last_height: String(n.height), block_metas: metas } });
    }
    if (url.pathname === '/block_results') {
      const h = Number(url.searchParams.get('height'));
      if (h > n.height) return Response.json({ error: { code: -32603, message: 'Internal error', data: `height ${h} must be less than or equal to the current blockchain height ${n.height}` } });
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
const notes = (db: TestD1): string[] => JSON.parse((db.raw.prepare("SELECT value FROM kv WHERE key = 'namada.scan'").get() as any)?.value ?? '{"failures":[]}').failures.map((f: any) => f.note);
const setCursor = (db: TestD1, v: string) => db.raw.prepare("INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES ('namada.cursor', ?, 0)").run(v);
const blockReads = (calls: string[], who?: string) => calls.filter((c) => !c.endsWith('/status') && (!who || c.startsWith(who)));

describe('the live scan follows only nodes at this chain\'s head', () => {
  it('a node on another network at 40,000,000 is neither followed nor read: the other node\'s head is', async () => {
    const db = testD1();
    setCursor(db, '8300000');
    const calls = chain({ five: { height: 40_000_000, network: 'other-chain-1', events: { 8_300_005: [transfer('5000000')], 39_999_951: [transfer('5000000')] } }, papa: { height: 8_300_010 } });
    await hubOf(db).scanNamada();
    expect(cursor(db)).toBe('8300010');
    expect(blockReads(calls, 'five')).toEqual([]);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM holders WHERE chain = 'namada'").get()).toEqual({ n: 0 });
    expect(notes(db)).toEqual([]); // the other node is at the head: nothing stopped
  });

  it('a cursor above the head is moved back below it, said so, and the scan goes on from there', async () => {
    const db = testD1();
    setCursor(db, '40000000');
    const calls = chain({ five: { height: 8_300_010 }, papa: { height: 8_300_010 } });
    await hubOf(db).scanNamada();
    expect(cursor(db)).toBe('8300010');
    expect(blockReads(calls).some((c) => c.includes('/block_results?height=8299961'))).toBe(true);
    expect(notes(db)).toEqual(['the scan\'s cursor 40000000 was 31699990 blocks above the head 8300010: the scan restarts at block 8299961, and blocks it missed before then are not scanned']);
  });

  it('a cursor a few blocks above a node\'s head waits for it, as before (no reset within 100 blocks)', async () => {
    const db = testD1();
    setCursor(db, '8300050');
    const calls = chain({ five: { height: 8_300_010 }, papa: { height: 8_300_010 } });
    await hubOf(db).scanNamada();
    expect(cursor(db)).toBe('8300050');
    expect(blockReads(calls)).toEqual([]);
    expect(notes(db)).toEqual([]);
  });

  it('a first node catching up is passed over for the second: no stall, and no jump later', async () => {
    const db = testD1();
    setCursor(db, '8300000');
    const calls = chain({ five: { height: 8_299_000, catchingUp: true }, papa: { height: 8_300_040 } });
    await hubOf(db).scanNamada();
    expect(cursor(db)).toBe('8300040');
    expect(blockReads(calls, 'five')).toEqual([]);
    expect(notes(db)).toEqual([]);
  });

  it('a node whose newest block is ten minutes old is not at the head, whatever catching_up says', async () => {
    const db = testD1();
    setCursor(db, '8300000');
    const calls = chain({ five: { height: 8_299_000, blockAgeMs: 10 * 60_000 }, papa: { height: 8_300_040 } });
    await hubOf(db).scanNamada();
    expect(cursor(db)).toBe('8300040');
    expect(blockReads(calls, 'five')).toEqual([]);
  });

  it('two nodes on this chain that disagree by more than 100 blocks: the lowest head, read from its node, and one note', async () => {
    const db = testD1();
    setCursor(db, '8300000');
    const spec = { five: { height: 40_000_000 }, papa: { height: 8_300_010 } };
    const calls = chain(spec);
    const hub = hubOf(db);
    await hub.scanNamada();
    expect(cursor(db)).toBe('8300010');
    expect(blockReads(calls, 'five')).toEqual([]);
    expect(notes(db)).toEqual(['the Namada nodes disagree on the head (5ElementsNodes 40000000, Papadritta 8300010): the scan follows Papadritta, the lowest not far below its cursor, and neither moves back nor jumps']);
    spec.papa.height = 8_300_020;
    await hub.scanNamada();
    expect(cursor(db)).toBe('8300020');
    expect(notes(db)).toHaveLength(1); // the same kind of note at most every ten minutes
  });

  it('no node at the head: nothing is read, the cursor stays, and the note is not repeated every tick', async () => {
    const db = testD1();
    setCursor(db, '8300000');
    const calls = chain({ five: { height: 8_300_100, catchingUp: true }, papa: { height: 8_300_100, network: 'other-chain-1' } });
    const hub = hubOf(db);
    await hub.scanNamada();
    await hub.scanNamada();
    expect(blockReads(calls)).toEqual([]);
    expect(cursor(db)).toBe('8300000');
    expect(notes(db)).toEqual([`no Namada node is at the chain's head (5ElementsNodes: catching up; Papadritta: names another network than ${NAMADA.chainId})`]);
  });

  it('both nodes down: the scan throws as before (the alarm logs it) and records no note', async () => {
    const db = testD1();
    setCursor(db, '8300000');
    chain({ five: { height: 1, down: true }, papa: { height: 1, down: true } });
    await expect(hubOf(db).scanNamada()).rejects.toThrow(/no Namada node answered/);
    expect(cursor(db)).toBe('8300000');
    expect(notes(db)).toEqual([]);
  });

  it('two nodes at the head: the lower head, the first node read first; a node a little ahead is never the only source of a block', async () => {
    const db = testD1();
    setCursor(db, '8300000');
    const calls = chain({ five: { height: 8_300_003, events: { 8_300_002: [transfer('7000000')] } }, papa: { height: 8_300_004, events: { 8_300_002: [transfer('7000000')] } } });
    await hubOf(db).scanNamada();
    expect(cursor(db)).toBe('8300003');
    expect(db.raw.prepare("SELECT balance, updated_height FROM holders WHERE chain = 'namada' AND address = ?").get(HOLDER)).toEqual({ balance: '7000000', updated_height: 8_300_002 });
    expect(blockReads(calls, 'papa')).toEqual([]); // block 8,300,004 waits until both nodes have it
    expect(notes(db)).toEqual([]);
  });

  it('a scan more than 50 blocks behind reads on from its cursor: every block read, none jumped, no note', async () => {
    const db = testD1();
    setCursor(db, '8300000');
    const calls = chain({ five: { height: 8_300_100 }, papa: { height: 8_300_100 } });
    await hubOf(db).scanNamada();
    expect(cursor(db)).toBe('8300100');
    const read = blockReads(calls).filter((c) => c.includes('/block_results')).map((c) => Number(c.split('height=')[1]));
    expect(read).toEqual(Array.from({ length: 100 }, (_, i) => 8_300_001 + i));
    expect(notes(db)).toEqual([]);
  });
});

describe('the block reads refuse a block of another chain', () => {
  it('an answer whose header names another chain counts as no answer: the next node is asked', async () => {
    const calls = chain({ five: { height: 8_300_010, network: 'other-chain-1' }, papa: { height: 8_300_010 } });
    const metas = await namada.blockMetas(8_300_001, 8_300_002, namada.LIVE_READ);
    expect(metas.map((m) => m.height).sort()).toEqual([8_300_001, 8_300_002]);
    expect(calls.map((c) => c.split(' ')[0])).toEqual(['five', 'papa']);
  });
});

describe('chainHead', () => {
  const NOW = Date.UTC(2026, 9, 22, 12);
  const st = (provider: string, o: Partial<namada.NodeStatus> = {}): namada.NodeStatus => ({ provider, network: NAMADA.chainId, height: 8_300_000, time: NOW - 7000, catchingUp: false, ...o });
  it('refuses a height that is not one and a newest block from the future', () => {
    expect(namada.chainHead([st('5ElementsNodes', { height: 2e9 }), st('Papadritta', { time: NOW + 3_600_000 })], NOW))
      .toEqual({ height: null, rpcs: [], note: "no Namada node is at the chain's head (5ElementsNodes: an invalid height; Papadritta: newest block not from the last 5 minutes)", agreed: false, byNodes: false, disputed: false });
  });
  it('one node at the head is enough; a node with no answer is left out of the reads', () => {
    const h = namada.chainHead([{ provider: '5ElementsNodes', error: 'timeout' }, st('Papadritta')], NOW);
    expect(h).toEqual({ height: 8_300_000, rpcs: [NAMADA.rpcs[1]], note: null, agreed: false, byNodes: false, disputed: false }); // one answer: followed, never agreed
  });
  it('a lone node above the bound (as far as the chain can have gone since an agreed head) is not followed', () => {
    const lone = [{ provider: '5ElementsNodes', error: 'down' }, st('Papadritta', { height: 8_305_000 })];
    expect(namada.chainHead(lone, NOW, 8_300_000, null, 8_300_150)).toMatchObject({ height: null, agreed: false });
    expect(namada.chainHead(lone, NOW, 8_300_000, null, 8_305_000)).toMatchObject({ height: 8_305_000, agreed: false });
    expect(namada.headBound({ height: 8_300_000, at: NOW - 60_000 }, NOW)).toBe(8_300_000 + 12 + 100);
    expect(namada.headBound(null, NOW)).toBeNull();
  });
  it('nodes within 100 blocks agree: the lower head (a height both say the chain has reached), both nodes read', () => {
    expect(namada.chainHead([st('5ElementsNodes'), st('Papadritta', { height: 8_300_100 })], NOW)).toEqual({ height: 8_300_000, rpcs: [...NAMADA.rpcs], note: null, agreed: true, byNodes: true, disputed: false });
    expect(namada.HEAD_AGREE_BLOCKS).toBe(100);
    expect(namada.HEAD_MAX_AGE_MS).toBe(5 * 60_000);
  });
});
