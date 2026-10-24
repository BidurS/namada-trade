// Security review (2026-10-22), late alerts and the fan-out window: the Osmosis catch-up search alerts each
// transaction it finds as soon as it has read that transaction's block and written its rows, and every one of those
// alerts shared one fan-out window, timed from the search's first post. The time the search spent reading blocks and
// writing rows between two alerts counted against it, so once 15 s had passed every later subscriber post of the
// search was skipped, after its claim was taken, and the move never reached that subscriber: one honest subscriber
// and an ordinary node were enough. Each alert of the search now has a window of its own, and the alarm bounds them
// all by its post count and its own deadline instead.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { base64 } from '@scure/base';
import { testD1 } from './d1-sqlite';
import { saveSettings, defaultPrefs, type StoredSettings } from '../worker/src/settings';
import { configureAlerts } from '../worker/src/sources/discord';
import { NAM } from '../worker/src/config';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import { LiveHub } from '../worker/src/live-hub';
import { HubQuote } from '../worker/src/live-quote';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const KEY = base64.encode(new Uint8Array(32).fill(4));
const OP = 'https://discord.com/api/webhooks/301/operator';
const SUB = 'https://discord.com/api/webhooks/302/subscriber';
const WATCHED = 'osmo1watchedsenderaddressxxxxxxxxxxxxxxxxx';
const transfer = (i: number, nam: number) => ({
  type: 'transfer',
  attributes: [{ key: 'recipient', value: `osmo1zzrecv${i}` }, { key: 'sender', value: WATCHED }, { key: 'amount', value: `${nam * 1e6}${NAM.osmoDenom}` }, { key: 'msg_index', value: '0' }],
});

describe('Security review (2026-10-22), late alerts: each alert of the catch-up search has a fan-out window of its own', () => {
  it('an honest watchlist subscriber hears every move the catch-up search finds, however long the search reads blocks', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const T0 = Date.now();
    const db = testD1();
    const p = defaultPrefs();
    p.watchlistOn = true;
    p.watchlist = [WATCHED];
    const sub: StoredSettings = { address: `tnam1qhonest${'q'.repeat(33)}`, notifications: p, channels: { discord: { enabled: true, webhookUrl: SUB } }, createdAt: T0 - 3 * 86400000, updatedAt: T0 - 3 * 86400000 };
    expect(await saveSettings(db as any, KEY, sub)).toBe(true);
    configureAlerts(KEY, true);

    // The stream missed 30 transactions at 30 heights; each is a 20,000 NAM send from the watched address.
    const K = 30;
    const txs = Array.from({ length: K }, (_, i) => ({ hash: `LATEWIN${String(i).padStart(4, '0')}`, height: String(100 + i), tx_result: { code: 0, events: [transfer(i, 20_000)] } }));
    const posts: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      const url = String(u);
      if (url.includes('discord.com')) { posts.push(url); return new Response(null, { status: 204 }); }
      if (url.endsWith('/status')) return Response.json({ result: { sync_info: { latest_block_height: '200' } } });
      if (url.includes('/tx_search')) return Response.json({ result: { txs } });
      if (url.includes('/block?height=')) {
        // An ordinary public node: each block read answers in 700 ms (the search allows 25 s a read).
        vi.setSystemTime(Date.now() + 700);
        return Response.json({ result: { block: { header: { time: new Date().toISOString() } } } });
      }
      throw new Error(`unexpected ${url}`);
    }));
    const hub: any = Object.assign(Object.create(LiveHub.prototype), {
      env: { DB: db, DISCORD_WEBHOOK_URL: OP },
      seenOsmoTx: new Set<string>(), osmoRetryTx: new Map<string, number>(), osmoWriting: new Map(), osmoRetryFrom: null, osmoRetryGen: 0, osmoHeight: 0, sessions: new Set(), lastPriceUsd: null,
      osmoCtx: { poolAddrs: new Map(), priceUsd: null, assets: new Map() },
      quote: new HubQuote(async () => null, async () => null),
    });
    await db.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('osmosis.cursor', ?, 0)").bind(JSON.stringify({ height: 50, at: 0 })).run();

    await hub.sweepOsmosis();
    const claims = db.raw.prepare("SELECT COUNT(*) AS n FROM kv WHERE key LIKE 'alert:flow:osmosis:LATEWIN%'").get().n as number;
    const skipped = JSON.parse((db.raw.prepare("SELECT value FROM kv WHERE key = 'alerts.skipped'").get() as any)?.value ?? 'null');
    expect(claims).toBe(K); // every move was claimed, so none is ever offered again
    expect(posts.filter((x) => x === OP)).toHaveLength(K); // the operator heard every one
    expect(posts.filter((x) => x === SUB)).toHaveLength(K); // and so should the subscriber
  });
});
