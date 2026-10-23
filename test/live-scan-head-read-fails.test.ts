// Security review (2026-10-22), live scan head: a failed read of the last agreed head (kv namada.head) after a restart
// was kept as "no head ever agreed", so with the indexer out a lone node far ahead had no bound. A failed read is now
// read again on the next tick, and the scan follows no lone node until it has.
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import { LiveHub } from '../worker/src/live-hub';
import { HubQuote } from '../worker/src/live-quote';
import { NAMADA } from '../worker/src/config';
import { testD1, type TestD1 } from './d1-sqlite';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

interface NodeSpec { height: number; down?: boolean }
function chain(spec: { five: NodeSpec; papa: NodeSpec }, calls: string[]) {
  vi.stubGlobal('fetch', vi.fn(async (u: string) => {
    const url = new URL(String(u));
    const who = url.host.includes('5elementsnodes') ? 'five' : 'papa';
    const n = spec[who];
    calls.push(`${who} ${url.pathname}${url.search}`);
    if (n.down) throw new Error('refused');
    if (url.pathname === '/status') return Response.json({ result: { node_info: { network: NAMADA.chainId }, sync_info: { latest_block_height: String(n.height), latest_block_time: new Date().toISOString(), catching_up: false, earliest_block_height: '1' } } });
    if (url.pathname === '/blockchain') {
      const lo = Number(url.searchParams.get('minHeight')), hi = Math.min(Number(url.searchParams.get('maxHeight')), n.height);
      if (lo > hi) return Response.json({ error: { code: -32603, message: 'Internal error' } });
      const metas = [];
      for (let h = hi; h >= lo; h--) metas.push({ header: { chain_id: NAMADA.chainId, height: String(h), time: new Date().toISOString() }, num_txs: '0' });
      return Response.json({ result: { last_height: String(n.height), block_metas: metas } });
    }
    if (url.pathname === '/block_results') return Response.json({ result: { height: url.searchParams.get('height'), end_block_events: [] } });
    throw new Error(`unexpected ${url}`);
  }));
}
/** env.DB whose first read of kv 'namada.head' fails (D1_ERROR: Network connection lost.), the rest as testD1. */
function flaky(db: TestD1, fail = true) {
  let failed = !fail;
  return new Proxy(db as any, {
    get(t, p) {
      if (p !== 'prepare') return (t as any)[p];
      return (sql: string) => {
        const s = t.prepare(sql);
        return new Proxy(s, { get(st, q) {
          if (q !== 'bind') return typeof st[q] === 'function' ? st[q].bind(st) : st[q];
          return (...args: unknown[]) => {
            const b = st.bind(...args);
            if (!failed && /FROM kv WHERE key=\?/.test(sql) && args[0] === 'namada.head') {
              failed = true;
              return { first: async () => { throw new Error('D1_ERROR: Network connection lost.'); } };
            }
            return b;
          };
        } });
      };
    },
  });
}
const H = 8_300_000;

describe('a restart while 5ElementsNodes and the indexer are out, and one D1 read of namada.head fails', () => {
  it('the lone node is still held to the bound of the stored agreed head', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.UTC(2026, 9, 22, 12, 0, 0);
    vi.setSystemTime(t0);
    const db = testD1();
    db.raw.prepare("INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES ('namada.cursor', ?, 0)").run(String(H));
    // the previous instance's last agreed head, 30 s before the restart; no fresh indexer_lag row (the indexer is down)
    db.raw.prepare("INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES ('namada.head', ?, 0)").run(JSON.stringify({ height: H, at: t0 - 30_000 }));
    const hub = Object.assign(Object.create(LiveHub.prototype), {
      env: { DB: flaky(db) }, sessions: new Set(), lastPriceUsd: null, namadaHeight: 0, quote: new HubQuote(async () => null, async () => null),
    }) as any;
    const spec = { five: { height: H, down: true }, papa: { height: H + 300_000 } };
    const calls: string[] = [];
    for (let i = 0; i < 10; i++) {
      vi.setSystemTime(t0 + i * 6500);
      chain(spec, calls);
      await hub.scanNamada();
    }
    const cur = Number((db.raw.prepare("SELECT value FROM kv WHERE key='namada.cursor'").get() as any).value);
    console.log('cursor after 10 ticks', cur, 'papa block reads', calls.filter((c) => c.startsWith('papa') && !c.endsWith('/status')).length);
    expect(cur).toBeLessThanOrEqual(H + 120);
  });
});

describe('control: the same restart with the read answering 5ElementsNodes and the indexer are out, and one D1 read of namada.head fails', () => {
  it('the lone node is still held to the bound of the stored agreed head', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.UTC(2026, 9, 22, 12, 0, 0);
    vi.setSystemTime(t0);
    const db = testD1();
    db.raw.prepare("INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES ('namada.cursor', ?, 0)").run(String(H));
    // the previous instance's last agreed head, 30 s before the restart; no fresh indexer_lag row (the indexer is down)
    db.raw.prepare("INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES ('namada.head', ?, 0)").run(JSON.stringify({ height: H, at: t0 - 30_000 }));
    const hub = Object.assign(Object.create(LiveHub.prototype), {
      env: { DB: flaky(db, false) }, sessions: new Set(), lastPriceUsd: null, namadaHeight: 0, quote: new HubQuote(async () => null, async () => null),
    }) as any;
    const spec = { five: { height: H, down: true }, papa: { height: H + 300_000 } };
    const calls: string[] = [];
    for (let i = 0; i < 10; i++) {
      vi.setSystemTime(t0 + i * 6500);
      chain(spec, calls);
      await hub.scanNamada();
    }
    const cur = Number((db.raw.prepare("SELECT value FROM kv WHERE key='namada.cursor'").get() as any).value);
    console.log('cursor after 10 ticks', cur, 'papa block reads', calls.filter((c) => c.startsWith('papa') && !c.endsWith('/status')).length);
    expect(cur).toBeLessThanOrEqual(H + 120);
  });
});
