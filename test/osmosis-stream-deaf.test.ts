// The Osmosis stream's lost subscriptions (worker/src/live-hub.ts openedOsmosisWs, sweepOsmosisWith, osmoDeafAt). On
// 2026-10-30 the stream-share check stood at 8.12% (22 of 271 Osmosis moves of the day found by the catch-up search):
// every one of the late moves matched the stream's own queries (a swap in pool 3005, or NAM moved), so the socket was
// open and delivering nothing. A node that ends a subscription says so in a message with an error and keeps the
// socket open; the hub dropped any message that was not a transaction, and nothing ever closed a deaf socket. Now an
// error message closes it, and so does the catch-up search writing a move the open socket should have delivered; the
// close handler opens a new socket with every query.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testD1 } from './d1-sqlite';
import { NAM } from '../worker/src/config';
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import { LiveHub, osmoDeafAt, OSMOSIS_DEAF_GRACE_MS, OSMOSIS_KEEPALIVE_MS } from '../worker/src/live-hub';
import { HubQuote } from '../worker/src/live-quote';
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const MIN = 60_000;
/** A socket stand-in: its listeners, what was sent, and whether it was closed (a close calls the close listeners, as a real one does). */
function fakeWs() {
  const on: Record<string, ((e: any) => unknown)[]> = {};
  const ws = {
    sent: [] as string[], closed: 0,
    addEventListener: (t: string, f: (e: any) => unknown) => { (on[t] ??= []).push(f); },
    send: (s: string) => { ws.sent.push(s); },
    close: () => { ws.closed++; for (const f of on.close ?? []) f({}); },
    fire: async (t: string, e: any) => { for (const f of on[t] ?? []) await f(e); },
  };
  return ws;
}
const hubOver = (db: any, extra: Record<string, unknown> = {}) => Object.assign(Object.create(LiveHub.prototype), {
  env: { DB: db }, seenOsmoTx: new Set<string>(), osmoRetryTx: new Map<string, number>(), osmoWriting: new Map(), osmoRetryFrom: null, osmoRetryGen: 0, osmoHeight: 0,
  sessions: new Set(), lastPriceUsd: null, needSweep: false, osmoDrops: { error: 0, deaf: 0, lastAt: null, closes: 0, lastClose: null },
  osmoCtx: { poolAddrs: new Map(), priceUsd: null, assets: new Map() }, quote: new HubQuote(async () => null, async () => null), ...extra,
}) as any;

describe('a socket that delivers nothing is closed', () => {
  it('a move counts against the open socket only when it opened well before the move and the move is not still on its way', () => {
    const now = Date.UTC(2026, 9, 30, 18, 30);
    const ts = now - 20 * MIN;
    expect(osmoDeafAt(ts - 60 * MIN, true, ts, now)).toBe(ts);
    expect(osmoDeafAt(ts - OSMOSIS_DEAF_GRACE_MS, true, ts, now)).toBe(ts);
    expect(osmoDeafAt(ts - OSMOSIS_DEAF_GRACE_MS + 1, true, ts, now)).toBe(null); // just reconnected: the move may have come in the gap
    expect(osmoDeafAt(ts - 60 * MIN, true, now - OSMOSIS_DEAF_GRACE_MS + 1, now)).toBe(null); // the move may still be on its way
    expect(osmoDeafAt(ts - 60 * MIN, false, ts, now)).toBe(null); // no socket open
    expect(osmoDeafAt(null, true, ts, now)).toBe(null);
  });

  it('a node’s error message on the socket closes it (the close handler reconnects), and a transaction message still goes on', async () => {
    vi.useFakeTimers();
    const hub = hubOver(testD1());
    const ws = fakeWs();
    hub.openedOsmosisWs(ws);
    expect(ws.sent).toHaveLength(4);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await ws.fire('message', { data: JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) });
    expect(ws.closed).toBe(0);
    // a close from the node is counted with its code, its reason and how long the socket was open
    const other = fakeWs();
    hub.osmoWs = null;
    hub.openedOsmosisWs(other);
    vi.advanceTimersByTime(42_000);
    await other.fire('close', { code: 1006, reason: '' });
    expect(hub.osmoDrops).toMatchObject({ closes: 1, lastClose: { code: 1006, reason: '', openMs: 42_000 } });
    expect(hub.osmoWs).toBe(null);
    const third = fakeWs();
    hub.openedOsmosisWs(third);
    await third.fire('message', { data: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'Server error', data: 'subscription was cancelled (reason: client is not pulling messages fast enough)' } }) });
    expect(third.closed).toBe(1);
    expect(hub.osmoDrops.error).toBe(1);
    expect(hub.osmoWs).toBe(null);
    expect(hub.needSweep).toBe(true);
  });

  it('the socket is kept alive with a health request every 15 s, and the requests stop once it closes or is let go (2026-10-31: idle sockets were cut after about 29 s)', async () => {
    vi.useFakeTimers();
    const hub = hubOver(testD1());
    const ws = fakeWs();
    hub.openedOsmosisWs(ws);
    expect(ws.sent).toHaveLength(4); // the subscriptions
    vi.advanceTimersByTime(OSMOSIS_KEEPALIVE_MS * 3);
    const pings = ws.sent.slice(4).map((m) => JSON.parse(m));
    expect(pings).toEqual(Array(3).fill({ jsonrpc: '2.0', method: 'health', id: 'keepalive', params: {} }));
    // CometBFT's answer to it is no move and no error: the socket stays
    await ws.fire('message', { data: JSON.stringify({ jsonrpc: '2.0', id: 'keepalive', result: {} }) });
    expect(ws.closed).toBe(0);
    await ws.fire('close', { code: 1006, reason: '' });
    vi.advanceTimersByTime(OSMOSIS_KEEPALIVE_MS * 3);
    expect(ws.sent).toHaveLength(7);
    // a socket the hub let go stops too, even if no close event ever comes
    const other = fakeWs();
    hub.osmoWs = null;
    hub.openedOsmosisWs(other);
    hub.osmoWs = null;
    vi.advanceTimersByTime(OSMOSIS_KEEPALIVE_MS * 3);
    expect(other.sent).toHaveLength(4);
  });

  it('an error a node gives one subscribe (not a cancelled subscription) is logged and the socket kept, so it never loops (review of 2026-10-30)', async () => {
    vi.useFakeTimers();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const hub = hubOver(testD1());
      const ws = fakeWs();
      hub.openedOsmosisWs(ws);
      await ws.fire('message', { data: JSON.stringify({ jsonrpc: '2.0', id: 3, error: { code: -32603, message: 'Internal error', data: 'max_subscriptions_per_client 3 reached' } }) });
      expect(ws.closed).toBe(0);
      expect(hub.osmoWs).toBe(ws);
      expect(hub.osmoDrops.error).toBe(0);
    } finally { err.mockRestore(); }
  });

  it('the catch-up search writing a move the open socket should have delivered closes it; a socket opened after the move is left open', async () => {
    const now = Date.now();
    const blockTime = now - 15 * MIN;
    const tx = { hash: 'DEAF'.padEnd(64, '0'), height: '1000100', tx: '', tx_result: { code: 0, events: [{ type: 'transfer', attributes: [{ key: 'recipient', value: 'osmo1recv' }, { key: 'sender', value: 'osmo1send' }, { key: 'amount', value: `${50 * 1e6}${NAM.osmoDenom}` }] }] } };
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      const url = new URL(String(u));
      if (url.pathname.endsWith('/status')) return Response.json({ result: { sync_info: { latest_block_height: '1000200' } } });
      if (url.pathname.endsWith('/block')) return Response.json({ result: { block: { header: { time: new Date(blockTime).toISOString() } } } });
      const q = url.searchParams.get('query') ?? '';
      const l = q.includes('transfer.amount') ? [tx] : [];
      return Response.json({ result: { txs: Number(url.searchParams.get('page')) === 1 ? l : [], total_count: String(l.length) } });
    }));
    // the socket open long before the move, then open only after it, then open long before but the stream did deliver it and its write failed (osmoRetryTx): only the first is deaf
    for (const [since, closes, retried] of [[blockTime - 60 * MIN, true, false], [blockTime + MIN, false, false], [blockTime - 60 * MIN, false, true]] as const) {
      const db = testD1();
      await db.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('osmosis.cursor', ?, 0)").bind(JSON.stringify({ height: 1000000, at: 1 })).run();
      const ws = fakeWs();
      const hub = hubOver(db, { osmoWs: ws, osmoSince: since, ...(retried ? { osmoRetryTx: new Map([[tx.hash, 1000100]]), osmoRetryFrom: 1000100 } : {}) });
      await hub.sweepOsmosis();
      expect((db as any).raw.prepare('SELECT COUNT(*) n FROM flows WHERE tx_hash = ?').get(tx.hash).n).toBe(1);
      expect(ws.closed).toBe(closes ? 1 : 0);
      expect(hub.osmoDrops.deaf).toBe(closes ? 1 : 0);
    }
  });
});
