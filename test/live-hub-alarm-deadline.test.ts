// Security review (2026-10-22), the live hub's alarm: the next Namada scan starts only when the alarm ends, and a scan
// more than SCAN_MAX_LAG blocks behind (about 341 s at 6.8 s a block) jumps the blocks between, whose flows, links
// and alerts the live path never writes. A catch-up search asked the Osmosis public node first on every read, 25 s
// each when it accepts connections and never answers, with no deadline: nine missed heights held the alarm 350 s and
// the next scan jumped two blocks. The search now asks a node that failed a read of it last, and the alarm's reads end
// at ALARM_DEADLINE_MS. The single-flight mark was a plain flag cleared only by its own run's finally, so a run that
// never ended would make every later alarm only re-arm: it now records when it was taken, an alarm after
// ALARM_LEASE_MS takes over and says so in the scan's health record, and a run's late end clears only its own mark.
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class { ctx: any; env: any; constructor(ctx: any, env: any) { this.ctx = ctx; this.env = env; } },
}));
import { ALARM_DEADLINE_MS, ALARM_LEASE_MS, LiveHub, SCAN_MAX_LAG } from '../worker/src/live-hub';
import { NAM } from '../worker/src/config';
import { testD1, type TestD1 } from './d1-sqlite';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const H = 8_000_000;
const BLOCK_MS = 6826; // two Namada block headers 50,000 blocks apart, 2026-10-18 and 2026-10-22: 6.82 s a block
const OSMO_HEAD = 1_000_500;

class NeverOpens { addEventListener() {} send() {} close() {} }

const later = <T>(ms: number, v: () => T) => new Promise<T>((r) => setTimeout(() => r(v()), ms));
const hangs = (init?: RequestInit) => new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));

interface Producers { publicnode: 'hangs' | 'answers'; keplrMs: number; txsFor: (q: string, page: number) => any[] }

/** Namada nodes, the quote service and the two Osmosis RPCs, with the Namada head moving one block every BLOCK_MS. */
function producers(T0: number, p: Producers, log: string[]) {
  return vi.fn((input: any, init?: RequestInit) => {
    const url = String(input);
    log.push(url);
    if (url.includes('sqs.osmosis.zone')) return Promise.resolve(new Response('no', { status: 404 }));
    const u = new URL(url);
    if (u.host === 'rpc-namada.5elementsnodes.com' || u.host === 'rpc.papadritta.com') {
      const head = H + Math.floor((Date.now() - T0) / BLOCK_MS);
      if (u.pathname === '/status') return Promise.resolve(Response.json({ result: { node_info: { network: 'namada.5f5de2dd1b88cba30586420' }, sync_info: { latest_block_height: String(head), latest_block_time: new Date().toISOString(), catching_up: false, earliest_block_height: '1' } } }));
      if (u.pathname === '/blockchain') {
        const lo = Number(u.searchParams.get('minHeight')), hi = Number(u.searchParams.get('maxHeight'));
        const metas = [];
        for (let h = hi; h >= lo; h--) metas.push({ header: { chain_id: 'namada.5f5de2dd1b88cba30586420', height: String(h), time: new Date(T0 + (h - H) * BLOCK_MS).toISOString() }, num_txs: '0' });
        return Promise.resolve(Response.json({ result: { block_metas: metas } }));
      }
      if (u.pathname === '/block_results') return Promise.resolve(Response.json({ result: { height: u.searchParams.get('height'), txs_results: null } }));
    }
    const osmosis = (path: string) => {
      if (path.endsWith('/status')) return Response.json({ result: { sync_info: { latest_block_height: String(OSMO_HEAD) } } });
      if (path.endsWith('/tx_search')) return Response.json({ result: { txs: p.txsFor(u.searchParams.get('query') ?? '', Number(u.searchParams.get('page'))) } });
      if (path.endsWith('/block')) return Response.json({ result: { block: { header: { time: new Date(Date.now() - 60_000).toISOString() } } } });
      return new Response('no', { status: 404 });
    };
    if (u.host === 'osmosis-rpc.publicnode.com') return p.publicnode === 'hangs' ? hangs(init) : Promise.resolve(osmosis(u.pathname));
    if (u.host === 'api.keplr.app') return p.keplrMs ? later(p.keplrMs, () => osmosis(u.pathname)) : Promise.resolve(osmosis(u.pathname));
    return Promise.reject(new TypeError(`offline: ${url}`));
  });
}

/** Runs one alarm to its end in virtual time, a second at a time; returns how long it took. */
async function alarmOnce(hub: any, cap = 1200) {
  const t = Date.now();
  let done = false;
  const p = hub.alarm().finally(() => { done = true; });
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; !done && i < cap; i++) await vi.advanceTimersByTimeAsync(1000);
  expect(done, 'the alarm ended').toBe(true);
  await p;
  return Date.now() - t;
}

function hubOn(db: TestD1, keplr: string) {
  const setAlarm = vi.fn(async (_t: number) => {});
  const ctx: any = { blockConcurrencyWhile: (f: () => Promise<unknown>) => f(), storage: { getAlarm: async () => 1, setAlarm } };
  return { hub: new LiveHub(ctx, { DB: db, KEPLR_KEY: keplr } as any) as any, setAlarm };
}

const kv = (db: TestD1, key: string) => (db.raw.prepare('SELECT value FROM kv WHERE key = ?').get(key) as any)?.value ?? null;
const scanNotes = (db: TestD1): string[] => {
  const v = kv(db, 'namada.scan');
  return v ? JSON.parse(v).failures.map((f: any) => f.note) : [];
};

async function setup(p: Producers) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const T0 = Date.now();
  const log: string[] = [];
  vi.stubGlobal('fetch', producers(T0, p, log));
  vi.stubGlobal('WebSocket', NeverOpens);
  const db = testD1();
  await db.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('namada.cursor', ?, 0)").bind(String(H)).run();
  await db.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('osmosis.cursor', ?, 0)").bind(JSON.stringify({ height: 1_000_000, at: 0 })).run();
  const { hub, setAlarm } = hubOn(db, 'dummy');
  await vi.advanceTimersByTimeAsync(0);
  return { T0, log, db, hub, setAlarm, headNow: () => H + Math.floor((Date.now() - T0) / BLOCK_MS) };
}

/** A 50 NAM transfer between two Osmosis accounts: a transaction that makes a row (one that makes none is let go unread). */
const ev = (i: number) => [{ type: 'transfer', attributes: [{ key: 'recipient', value: `osmo1dlrecv${i}` }, { key: 'sender', value: `osmo1dlsend${i}` }, { key: 'amount', value: `${50 * 1e6}${NAM.osmoDenom}` }] }];

describe('the live hub keeps the Namada scan on time when an Osmosis node hangs', () => {
  it('with every node answering, the public node is still asked first, the search completes and the alarm re-arms for 6 s', async () => {
    const one = [{ hash: 'CC'.padEnd(64, '0'), height: '1000050', tx_result: { code: 0, events: ev(0) } }];
    const s = await setup({ publicnode: 'answers', keplrMs: 0, txsFor: (q, page) => (q.includes('token_swapped') && page === 1 ? one : []) });
    s.db.raw.prepare('UPDATE kv SET value = ? WHERE key = ?').run(String(H - 3), 'namada.cursor');
    await alarmOnce(s.hub);
    // The search asked Keplr nothing (the stream's socket is opened with a fetch upgrade: not a search read).
    expect(s.log.filter((u) => u.includes('api.keplr.app') && !u.endsWith('/websocket'))).toEqual([]);
    expect(s.log.filter((u) => u.includes('publicnode')).length).toBe(6); // /status, four searches, one /block
    expect(JSON.parse(kv(s.db, 'osmosis.cursor')).height).toBe(OSMO_HEAD);
    expect(kv(s.db, 'namada.cursor')).toBe(String(H));
    expect(Math.abs(s.setAlarm.mock.calls.at(-1)![0] - (Date.now() + 6000))).toBeLessThanOrEqual(1000);
  });

  it('a public node that never answers costs the search one read, and the next scan jumps no blocks', async () => {
    // nine missed heights: before, fourteen 25 s waits on the public node held the alarm 350 s
    const nine = Array.from({ length: 9 }, (_, i) => ({ hash: `AA${String(i).padStart(62, '0')}`, height: String(1_000_001 + i), tx_result: { code: 0, events: ev(i) } }));
    const s = await setup({ publicnode: 'hangs', keplrMs: 0, txsFor: (q, page) => (q.includes('token_swapped') && page === 1 ? nine : []) });
    const ms = await alarmOnce(s.hub);
    expect(ms).toBeLessThanOrEqual(26_000);
    expect(s.log.filter((u) => u.includes('publicnode')).length).toBe(1);
    expect(s.log.filter((u) => u.includes('api.keplr.app') && u.includes('/block?height=')).length).toBe(9);
    expect(JSON.parse(kv(s.db, 'osmosis.cursor')).height).toBe(OSMO_HEAD);
    await vi.advanceTimersByTimeAsync(6000);
    await alarmOnce(s.hub);
    expect(scanNotes(s.db)).toEqual([]);
    expect(kv(s.db, 'namada.cursor')).toBe(String(s.headNow()));
  });

  it('a search longer than the alarm deadline stops at it, keeps its cursor, and the next searches finish it with no blocks jumped', async () => {
    // 149 missed heights, each a 50 NAM transfer, from a node that takes 2 s a read, the public node hanging
    const txs = Array.from({ length: 149 }, (_, i) => ({ hash: `BB${String(i).padStart(62, '0')}`, height: String(1_000_400 - i), tx_result: { code: 0, events: ev(i) } }));
    const s = await setup({ publicnode: 'hangs', keplrMs: 2000, txsFor: (q, page) => (q.includes('token_swapped') ? txs.slice((page - 1) * 50, page * 50) : []) });
    const stored = () => (s.db.raw.prepare("SELECT COUNT(DISTINCT tx_hash) AS n FROM flows WHERE chain = 'osmosis' AND tx_hash LIKE 'BB%'").get() as any).n;

    const first = await alarmOnce(s.hub);
    expect(first).toBeLessThanOrEqual(ALARM_DEADLINE_MS + 1000);
    const cut = JSON.parse(kv(s.db, 'osmosis.cursor'));
    expect(cut.height).toBe(1_000_000);
    expect(cut.error).toMatch(/did not finish/);
    expect(stored()).toBeGreaterThan(0);
    expect(stored()).toBeLessThan(149);

    let longest = first;
    for (let i = 0; i < 400 && JSON.parse(kv(s.db, 'osmosis.cursor')).height !== OSMO_HEAD; i++) {
      await vi.advanceTimersByTimeAsync(6000);
      longest = Math.max(longest, await alarmOnce(s.hub));
    }
    expect(JSON.parse(kv(s.db, 'osmosis.cursor')).height).toBe(OSMO_HEAD);
    expect(stored()).toBe(149);
    expect(longest).toBeLessThanOrEqual(ALARM_DEADLINE_MS + 1000);
    expect(longest).toBeLessThan((SCAN_MAX_LAG - 2) * BLOCK_MS);
    await vi.advanceTimersByTimeAsync(6000);
    await alarmOnce(s.hub);
    expect(scanNotes(s.db)).toEqual([]);
    expect(kv(s.db, 'namada.cursor')).toBe(String(s.headNow()));
  });
});

describe('the alarm\'s single-flight mark', () => {
  it('a run that never ends is taken over after the lease and recorded, and its late end leaves the newer run\'s mark alone', async () => {
    // Each Namada /status waits until the test ends it, whatever its signal: a chain the runtime left unsettled.
    const pending: { reject: (e: unknown) => void }[] = [];
    const f = vi.fn((input: any) => {
      const u = new URL(String(input));
      if (u.host.includes('namada') || u.host.includes('papadritta')) {
        if (u.pathname === '/status') return new Promise((_, reject) => pending.push({ reject }));
      }
      return Promise.reject(new TypeError('offline'));
    });
    vi.stubGlobal('fetch', f);
    const flush = () => new Promise((r) => setTimeout(r, 0));
    const db = testD1();
    const { hub, setAlarm } = hubOn(db, '');
    await flush();
    vi.useFakeTimers({ toFake: ['Date'] });
    const T0 = Date.now();

    // A scan asks every Namada node for its status at once (sources/namada.ts chainHead): two reads a run.
    const first = hub.alarm();
    await flush();
    expect(pending.length).toBe(2);
    await hub.alarm();
    vi.setSystemTime(T0 + ALARM_LEASE_MS - 1000);
    await hub.alarm();
    expect(pending.length).toBe(2); // within the lease: re-armed only
    expect(setAlarm).toHaveBeenCalledTimes(2);

    vi.setSystemTime(T0 + ALARM_LEASE_MS + 1000);
    const second = hub.alarm();
    await flush();
    expect(pending.length).toBe(4); // taken over: this alarm scans
    expect(scanNotes(db).some((n) => /never ended; the next one took over/.test(n))).toBe(true);

    // the first run ends at last; the second still holds the mark
    pending[0].reject(new TypeError('reset'));
    pending[1].reject(new TypeError('reset'));
    await first;
    const calls = pending.length;
    await hub.alarm();
    expect(pending.length).toBe(calls);

    // the second run ends and releases it: the next alarm scans again
    pending[2].reject(new TypeError('reset'));
    pending[3].reject(new TypeError('reset'));
    await second;
    expect(hub.alarmRun).toBeNull();
    const before = pending.length;
    const third = hub.alarm();
    await flush();
    expect(pending.length).toBe(before + 2);
    pending[before].reject(new TypeError('reset'));
    pending[before + 1].reject(new TypeError('reset'));
    await third;
    expect(hub.alarmRun).toBeNull();
  });
});
