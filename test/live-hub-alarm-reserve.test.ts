// Security review (2026-10-22), the live hub's alarm deadline: the Namada scan and the Osmosis catch-up search shared
// one deadline, and the search started only while it had not passed. Namada nodes that answer, but slower than the
// chain makes blocks, kept the scan at the deadline on every alarm, and the search never ran: the Osmosis
// transactions the stream missed were not recovered while the Namada side stayed slow. A due search now keeps
// SWEEP_RESERVE_MS of the alarm for itself. The deadline also cut reads the scan took as a node's failure: a block's
// fee-payer read cut by it was written with the events-only fee reading for good, and an unbond read cut by it was
// recorded as a failed decode, which the cron showed as failing for 24 h. A read the deadline cuts now holds the block
// for the next alarm and records nothing.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class { ctx: any; env: any; constructor(ctx: any, env: any) { this.ctx = ctx; this.env = env; } },
}));
import { ALARM_DEADLINE_MS, LiveHub, SWEEP_RESERVE_MS } from '../worker/src/live-hub';
import { HubQuote } from '../worker/src/live-quote';
import { NAM, NAMADA } from '../worker/src/config';
import { testD1, type TestD1 } from './d1-sqlite';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const H = 8_000_000;
const BLOCK_MS = 6826;
const OSMO_HEAD = 1_000_500;
class NeverOpens { addEventListener() {} send() {} close() {} }
const later = <T>(ms: number, v: () => T) => new Promise<T>((r) => setTimeout(() => r(v()), ms));
const kv = (db: TestD1, key: string) => (db.raw.prepare('SELECT value FROM kv WHERE key = ?').get(key) as any)?.value ?? null;

describe('a slow Namada side and the Osmosis catch-up search', () => {
  it('the search still runs, and finishes, while the scan keeps reaching the deadline; every alarm stays bounded', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const T0 = Date.now();
    const log: string[] = [];
    vi.stubGlobal('fetch', vi.fn((input: any, init?: RequestInit) => {
      const url = String(input);
      log.push(url);
      if (url.includes('sqs.osmosis.zone')) return Promise.resolve(new Response('no', { status: 404 }));
      const u = new URL(url);
      if (u.host === 'rpc-namada.5elementsnodes.com' || u.host === 'rpc.papadritta.com') {
        const head = H + Math.floor((Date.now() - T0) / BLOCK_MS);
        if (u.pathname === '/status') return Promise.resolve(Response.json({ result: { node_info: { network: NAMADA.chainId }, sync_info: { latest_block_height: String(head), latest_block_time: new Date().toISOString(), catching_up: false } } }));
        if (u.pathname === '/blockchain') {
          const lo = Number(u.searchParams.get('minHeight')), hi = Number(u.searchParams.get('maxHeight'));
          const metas = [];
          for (let h = hi; h >= lo; h--) metas.push({ header: { chain_id: NAMADA.chainId, height: String(h), time: new Date(T0 + (h - H) * BLOCK_MS).toISOString() }, num_txs: '0' });
          return Promise.resolve(Response.json({ result: { block_metas: metas } }));
        }
        // answers inside LIVE_READ's 10 s, but slower than the chain makes blocks
        if (u.pathname === '/block_results') {
          return new Promise<Response>((resolve, reject) => {
            const t = setTimeout(() => resolve(Response.json({ result: { height: u.searchParams.get('height'), txs_results: null } })), 7000);
            init?.signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); });
          });
        }
      }
      if (u.host === 'osmosis-rpc.publicnode.com') {
        if (u.pathname === '/status') return Promise.resolve(Response.json({ result: { sync_info: { latest_block_height: String(OSMO_HEAD) } } }));
        if (u.pathname === '/tx_search') return Promise.resolve(Response.json({ result: { txs: [] } }));
      }
      return Promise.reject(new TypeError(`offline: ${url}`));
    }));
    vi.stubGlobal('WebSocket', NeverOpens);
    const db = testD1();
    await db.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('namada.cursor', ?, 0)").bind(String(H - 50)).run();
    await db.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('osmosis.cursor', ?, 0)").bind(JSON.stringify({ height: 1_000_000, at: 0 })).run();
    const ctx: any = { blockConcurrencyWhile: (f: () => Promise<unknown>) => f(), storage: { getAlarm: async () => 1, setAlarm: vi.fn(async () => {}) } };
    const hub = new LiveHub(ctx, { DB: db } as any) as any;
    await vi.advanceTimersByTimeAsync(0);

    let longest = 0;
    while (Date.now() - T0 < 15 * 60_000) {
      const t = Date.now();
      let done = false;
      const p = hub.alarm().finally(() => { done = true; });
      for (let i = 0; !done && i < 400; i++) await vi.advanceTimersByTimeAsync(1000);
      await p;
      longest = Math.max(longest, Date.now() - t);
      await vi.advanceTimersByTimeAsync(6000);
    }
    const searches = log.filter((u) => u.includes('publicnode') && u.includes('/tx_search')).length;
    expect(searches).toBeGreaterThan(0);
    expect(JSON.parse(kv(db, 'osmosis.cursor')).height).toBe(OSMO_HEAD);
    expect(longest).toBeLessThanOrEqual(ALARM_DEADLINE_MS + 2000);
    expect(SWEEP_RESERVE_MS).toBeLessThan(ALARM_DEADLINE_MS);
  }, 60_000);
});

const MASP = NAMADA.internal.masp;
const NAMT = NAM.namadaToken;
const fx = (n: string) => JSON.parse(readFileSync(join(__dirname, 'fixtures', n), 'utf8'));
type L = [string, string, string];
const acct = ([a, t, n]: L) => [[`internal-address/${a}`, t], n];
// The wrapper of mainnet block 6,957,587 (test/fixtures/namada_block_6957587_txs.json) names PAYER as its fee payer.
const W6957587 = '0F8F36AAE1B3428B0EF85E71E7535B92017FC464695C0698F186706CD49DFC55';
const PAYER = 'tnam1qp2wt2gjjcqwey2esvae46g6nr9ullzc8v9ydaq8';
const RCPT = 'tnam1qr8x5rly5mj8wly2ph0zqjkcqkju0g5jkggjn9k3';
/** Block 4,349,059's shape under that wrapper: the pool pays 0.0625 NAM to the gas payer and 0.000001 to a recipient. */
const poolTransfer = {
  type: 'token/transfer',
  attributes: [
    { key: 'hash', value: W6957587 },
    { key: 'inner-tx-hash', value: 'C'.repeat(64) },
    { key: 'source-accounts', value: JSON.stringify(([[MASP, NAMT, '62501']] as L[]).map(acct)) },
    { key: 'target-accounts', value: JSON.stringify(([[PAYER, NAMT, '62500'], [RCPT, NAMT, '1']] as L[]).map(acct)) },
    { key: 'post-balances', value: JSON.stringify([]) },
    { key: 'token-event-descriptor', value: 'transfer-from-wasm' },
  ],
};

/** Both Namada nodes at `height`; `/block` asks `block` for its answer, block_results answers `results`. */
function nodes(height: number, time: string, results: () => any, block: (init?: RequestInit) => Promise<Response>) {
  const asked: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => {
    const url = new URL(String(u));
    asked.push(url.pathname);
    if (url.pathname === '/status') return Response.json({ result: { node_info: { network: NAMADA.chainId }, sync_info: { latest_block_height: String(height), latest_block_time: new Date().toISOString(), catching_up: false, earliest_block_height: '1' } } });
    if (url.pathname === '/blockchain') return Response.json({ result: { block_metas: [{ header: { chain_id: NAMADA.chainId, height: String(height), time }, num_txs: '1' }] } });
    if (url.pathname === '/block_results') return Response.json(results());
    if (url.pathname === '/block') return block(init);
    throw new Error(`unexpected ${url}`);
  }));
  return asked;
}
const hubOf = (db: TestD1) => Object.assign(Object.create(LiveHub.prototype), {
  env: { DB: db }, sessions: new Set(), lastPriceUsd: null, namadaHeight: 0, quote: new HubQuote(async () => null, async () => null),
}) as any;
const hangs = (init?: RequestInit) => new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted'))));

describe('a read the alarm\'s own deadline cuts holds the block, and is no node\'s failure', () => {
  it('a fee-payer read cut by the deadline: the block waits, and the next scan writes the reading tied to the fee payer', async () => {
    const db = testD1();
    const B = 9_000_001;
    db.raw.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('namada.cursor', ?, 0)").run(String(B - 1));
    const deadline = new AbortController();
    nodes(B, '2026-10-21T08:00:00Z', () => {
      queueMicrotask(() => deadline.abort('alarm deadline')); // the deadline passes as the block's results come back
      return { result: { height: String(B), end_block_events: [poolTransfer] } };
    }, async () => Response.json({ result: { block: { data: { txs: fx('namada_block_6957587_txs.json').result.block.data.txs } } } }));
    const hub = hubOf(db);
    await hub.scanNamada(deadline.signal);
    expect(deadline.signal.aborted).toBe(true);
    expect(kv(db, 'namada.cursor')).toBe(String(B - 1));
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM flows").get()).toEqual({ n: 0 });

    await hub.scanNamada(new AbortController().signal);
    expect(kv(db, 'namada.cursor')).toBe(String(B));
    expect(db.raw.prepare('SELECT id, kind, to_addr, amount_num, meta FROM flows ORDER BY id').all().map((r: any) => [r.id, r.kind, r.to_addr, r.amount_num, JSON.parse(r.meta).maspFeeNam ?? null]))
      .toEqual([[`namada:${W6957587}:0`, 'unshield', RCPT, 0.000001, 0.0625]]);
  });

  it('an unbond block whose tx read the deadline cuts: no failure recorded, and the next scan decodes it', async () => {
    const db = testD1();
    const U = 6957587; // one wrapper with two applied unbonds
    const results = fx(`namada_block_${U}.json`);
    const txs = fx(`namada_block_${U}_txs.json`);
    db.raw.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('namada.cursor', ?, 0)").run(String(U - 1));
    const deadline = new AbortController();
    let cut = true;
    nodes(U, txs.result.block.header.time, () => results, async (init) => {
      if (!cut) return Response.json(txs);
      queueMicrotask(() => deadline.abort('alarm deadline')); // the deadline passes while the tx bytes are read
      return hangs(init);
    });
    const hub = hubOf(db);
    await hub.scanNamada(deadline.signal);
    expect(kv(db, 'namada.cursor')).toBe(String(U - 1));
    const first = JSON.parse(kv(db, 'namada.unbonds.live') ?? '{"decoded":0,"failures":[]}');
    expect(first.failures).toEqual([]);

    cut = false;
    await hub.scanNamada(new AbortController().signal);
    const after = JSON.parse(kv(db, 'namada.unbonds.live'));
    expect(kv(db, 'namada.cursor')).toBe(String(U));
    expect(after.decoded).toBe(2);
    expect(after.failures).toEqual([]);
  });

  it('a fee-payer read a node fails is still not worth holding the block: the events-only reading, as before', async () => {
    const db = testD1();
    const B = 9_000_001;
    db.raw.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('namada.cursor', ?, 0)").run(String(B - 1));
    nodes(B, '2026-10-21T08:00:00Z', () => ({ result: { height: String(B), end_block_events: [poolTransfer] } }), async () => new Response('down', { status: 502 }));
    await hubOf(db).scanNamada(new AbortController().signal);
    expect(kv(db, 'namada.cursor')).toBe(String(B));
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM flows').get()).toEqual({ n: 2 });
  });
});
