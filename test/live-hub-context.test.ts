// Own audit (2026-10-29), Low 14: the live hub's constructor read the pool addresses and the first quote from the
// Osmosis router inside blockConcurrencyWhile, which holds every request and the alarm until it returns, and the router
// is asked three times with a 15 s timeout each for the pools and three times again for the price. A router slow to
// answer held the whole hub: no socket was accepted and the Namada scan did not run. The constructor now waits on the
// object's own storage only; the router is read after it (the hub's context), and only Osmosis moves wait for it: a
// stream message waits and is then read with the pool addresses (a deposit to a pool stays liquidity) and with the
// time it came (the review of 2026-10-29 found it stamped with the time the wait ended), and the catch-up search
// starts once the context is read.
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class { ctx: any; env: any; constructor(ctx: any, env: any) { this.ctx = ctx; this.env = env; } },
}));
import { LiveHub } from '../worker/src/live-hub';
import { NAM, NAMADA, OSMOSIS } from '../worker/src/config';
import { testD1, type TestD1 } from './d1-sqlite';
import { stubHubSockets } from './hub-sockets';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const H = 8_000_000;
const BLOCK_MS = 6826;
const USDC = OSMOSIS.usdcDenom;
const CL_3005 = 'osmo1m459jtgn77tz8cffvthq5jh0erswxu9872mjd9qde546mslc6udq85we5r';
const pools = [{ type: 2, chain_model: { id: 3005, address: CL_3005 }, balances: [{ denom: USDC, amount: '155773361' }, { denom: NAM.osmoDenom, amount: '660434050388' }], liquidity_cap: '724', spread_factor: '0.002' }];

/** The router hangs until `release()`: then it answers the pools, and 404 for the price. Namada and Osmosis nodes answer. */
function producers(T0: number) {
  const held: { resolve: () => void }[] = [];
  const log: string[] = [];
  let open = false;
  const sqs = (url: string) => (url.includes('/pools?') ? Response.json(pools) : new Response('no', { status: 404 }));
  vi.stubGlobal('fetch', vi.fn((input: any, init?: RequestInit) => {
    const url = String(input);
    log.push(url);
    if (url.startsWith(OSMOSIS.sqs)) {
      if (open) return Promise.resolve(sqs(url));
      return new Promise<Response>((resolve, reject) => {
        held.push({ resolve: () => resolve(sqs(url)) });
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    const u = new URL(url);
    if (NAMADA.rpcs.some((r) => new URL(r.url).host === u.host)) {
      const head = H + Math.floor((Date.now() - T0) / BLOCK_MS);
      if (u.pathname === '/status') return Promise.resolve(Response.json({ result: { node_info: { network: NAMADA.chainId }, sync_info: { latest_block_height: String(head), latest_block_time: new Date().toISOString(), catching_up: false, earliest_block_height: '1' } } }));
      if (u.pathname === '/blockchain') {
        const lo = Number(u.searchParams.get('minHeight')), hi = Number(u.searchParams.get('maxHeight'));
        const metas = [];
        for (let h = hi; h >= lo; h--) metas.push({ header: { chain_id: NAMADA.chainId, height: String(h), time: new Date(T0 + (h - H) * BLOCK_MS).toISOString() }, num_txs: '0' });
        return Promise.resolve(Response.json({ result: { block_metas: metas } }));
      }
      if (u.pathname === '/block_results') return Promise.resolve(Response.json({ result: { height: u.searchParams.get('height'), txs_results: null } }));
    }
    if (u.host === new URL(OSMOSIS.publicRpc).host) {
      if (u.pathname === '/status') return Promise.resolve(Response.json({ result: { sync_info: { latest_block_height: '1000500', earliest_block_height: '1' } } }));
      if (u.pathname === '/tx_search') return Promise.resolve(Response.json({ result: { txs: [], total_count: '0' } }));
    }
    return Promise.reject(new TypeError(`offline: ${url}`));
  }));
  return { log, release: () => { open = true; for (const h of held.splice(0)) h.resolve(); } };
}

function hubOn(db: TestD1) {
  const store = new Map<string, unknown>();
  let entered: Promise<unknown> | null = null;
  const storage = {
    getAlarm: async () => null, setAlarm: vi.fn(async () => {}), list: async () => new Map(),
    get: async (k: string) => store.get(k), put: async (k: string, v: unknown) => { store.set(k, structuredClone(v)); },
  };
  const ctx: any = { blockConcurrencyWhile: (f: () => Promise<unknown>) => (entered = f()), storage };
  const hub = new LiveHub(ctx, { DB: db } as any) as any;
  return { hub, storage, entered: () => entered! };
}

/** A NAM deposit to pool 3005 as the stream delivers it: liquidity when the pool's address is known, else a transfer. */
const deposit = {
  result: {
    events: { 'tx.hash': ['CTX0000000000000000000000000000000000000000000000000000000000001'] },
    data: { value: { TxResult: { height: '1000600', result: { code: 0, events: [
      { type: 'tx', attributes: [{ key: 'fee_payer', value: 'osmo1lper' }] },
      { type: 'transfer', attributes: [{ key: 'recipient', value: CL_3005 }, { key: 'sender', value: 'osmo1lper' }, { key: 'amount', value: `50000000000${NAM.osmoDenom}` }] },
    ] } } } },
  },
};
/** The same deposit in another transaction (the stream's socket delivers it). */
const deposit2 = structuredClone(deposit);
deposit2.result.events['tx.hash'] = ['CTX0000000000000000000000000000000000000000000000000000000000002'];
const settled = (p: Promise<unknown>) => { let done = false; p.then(() => { done = true; }, () => { done = true; }); return () => done; };
const flowsOf = (db: TestD1) => db.raw.prepare("SELECT kind FROM flows WHERE chain = 'osmosis' ORDER BY id").all().map((r: any) => r.kind);
const timesOf = (db: TestD1) => db.raw.prepare("SELECT tx_hash, ts FROM flows WHERE chain = 'osmosis' ORDER BY tx_hash").all().map((r: any) => [r.tx_hash, r.ts]);
/** The hub's Osmosis socket: its listeners kept, so the test can deliver a message as the stream does. */
function osmosisSocket() {
  const on = new Map<string, (ev: any) => unknown>();
  return { on, ws: { addEventListener: (t: string, f: (ev: any) => unknown) => { on.set(t, f); }, send() {}, close() {} } };
}

describe('the live hub while the Osmosis router does not answer', () => {
  it('the constructor waits on its own storage only: sockets, the alarm and the Namada scan go on, and Osmosis moves wait for the pool addresses', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const T0 = Date.now();
    const net = producers(T0);
    stubHubSockets();
    const db = testD1();
    await db.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('namada.cursor', ?, 0)").bind(String(H - 3)).run();
    await db.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('osmosis.cursor', ?, 0)").bind(JSON.stringify({ height: 1_000_400, at: 1 })).run();
    const { hub, storage, entered } = hubOn(db);

    // blockConcurrencyWhile returns with the router still asked and unanswered: no timer had to run for it
    const out = settled(entered());
    await vi.advanceTimersByTimeAsync(0);
    expect(out()).toBe(true);
    expect(storage.setAlarm).toHaveBeenCalledTimes(1);
    expect(net.log.filter((u) => u.includes('/pools?')).length).toBe(1);

    // a socket is accepted
    const r = await hub.fetch(new Request('https://namada.trade/ws', { headers: { Upgrade: 'websocket', 'cf-connecting-ip': '203.0.113.7' } }));
    expect(r.status).toBe(101);
    expect(hub.sessions.size).toBe(1);

    // a stream message waits for the pool addresses, one handed in and one through the hub's Osmosis socket
    const arrived = Date.now();
    const msg = hub.handleOsmosisMessage(deposit);
    const read = settled(msg);
    const osmo = osmosisSocket();
    hub.openedOsmosisWs(osmo.ws);
    await vi.advanceTimersByTimeAsync(1000);
    const arrived2 = Date.now();
    const msg2 = osmo.on.get('message')!({ data: JSON.stringify(deposit2) }) as Promise<unknown>;
    await vi.advanceTimersByTimeAsync(0);
    expect(read()).toBe(false);
    expect(flowsOf(db)).toEqual([]);

    // the alarm runs the Namada scan to the head; the catch-up search waits, still due
    let done = false;
    const a = hub.alarm().finally(() => { done = true; });
    for (let i = 0; !done && i < 60; i++) await vi.advanceTimersByTimeAsync(500);
    await a;
    expect(done).toBe(true);
    expect((db.raw.prepare("SELECT value FROM kv WHERE key = 'namada.cursor'").get() as any).value).toBe(String(H));
    expect(net.log.filter((u) => u.includes('/tx_search'))).toEqual([]);
    expect(hub.needSweep).toBe(true);

    // the router answers: the messages are read with pool 3005's address (liquidity, not a transfer), each with the
    // time it came, not the time the router answered (the stream's moves carry no block time)
    expect(Date.now() - arrived2).toBeGreaterThanOrEqual(10_000);
    net.release();
    await vi.advanceTimersByTimeAsync(0);
    await msg;
    await msg2;
    expect(hub.osmoCtx.poolAddrs.get(CL_3005)).toBe('3005');
    expect(flowsOf(db)).toEqual(['lp_add', 'lp_add']);
    expect(timesOf(db)).toEqual([[deposit.result.events['tx.hash'][0], arrived], [deposit2.result.events['tx.hash'][0], arrived2]]);
    expect(hub.osmoLastMsgAt).toBe(arrived2);

    // and the next alarm runs the catch-up search
    done = false;
    const b = hub.alarm().finally(() => { done = true; });
    for (let i = 0; !done && i < 60; i++) await vi.advanceTimersByTimeAsync(500);
    await b;
    // the four OSMOSIS_QUERIES, and pool 3005's two address queries now that its address is known (osmosisPoolQueries)
    const searches = net.log.filter((u) => u.includes('/tx_search'));
    expect(searches.length).toBe(6);
    expect(searches.filter((u) => decodeURIComponent(u).includes(CL_3005)).length).toBe(2);
    expect(hub.needSweep).toBe(false);
  });
});
