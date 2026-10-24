// Security review (2026-10-22), late alerts and the alarm's post count: the catch-up search's alerts share the
// alarm's count of LIVE_ALERT_POSTS posts, and a subscriber post past it was cut for good after the move's claim was
// taken, so the move never reached that subscriber (the cron holds such an alert for its next run; the hub had no
// such path). A move's subscribers the count cuts are now kept in the hub's own storage (live-hub.ts PendingAlert)
// and sent first by the next alarm, marked found late, under that alarm's count; the move is claimed in parts, the
// operator's at once and the subscribers' when their posts start. Fetch is stubbed: nothing reaches Discord.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { base64 } from '@scure/base';
import { testD1 } from './d1-sqlite';
import { saveSettings, defaultPrefs, type StoredSettings } from '../worker/src/settings';
import { alarmBudget, configureAlerts, flushAlerts, LIVE_ALERT_POSTS } from '../worker/src/sources/discord';
import { NAM } from '../worker/src/config';
import { memStorage } from './do-storage';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import { LiveHub, PENDING_PREFIX } from '../worker/src/live-hub';
import { HubQuote } from '../worker/src/live-quote';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const KEY = base64.encode(new Uint8Array(32).fill(22));
const OP = 'https://discord.com/api/webhooks/301/operator';
const WATCHED = 'osmo1watchedsenderaddressxxxxxxxxxxxxxxxxx';
const transfer = (i: number, nam: number) => ({
  type: 'transfer',
  attributes: [{ key: 'recipient', value: `osmo1zzrecv${i}` }, { key: 'sender', value: WATCHED }, { key: 'amount', value: `${nam * 1e6}${NAM.osmoDenom}` }, { key: 'msg_index', value: '0' }],
});

describe('Security review (2026-10-22), late alerts: the catch-up search and the alarm post count', () => {
  it('120 honest watchers of one address hear each of the 8 moves the catch-up search finds: what one alarm cannot post, the next alarms do, marked found late', { timeout: 60_000 }, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const T0 = Date.now();
    const db = testD1();
    const S = 120;
    for (let i = 0; i < S; i++) {
      const p = defaultPrefs();
      p.watchlistOn = true;
      p.watchlist = [WATCHED];
      const sub: StoredSettings = { address: `tnam1qwatch${String(i).padStart(4, '0')}${'q'.repeat(30)}`, notifications: p, channels: { discord: { enabled: true, webhookUrl: `https://discord.com/api/webhooks/${7000 + i}/w` } }, createdAt: T0 - 3 * 86400000, updatedAt: T0 - 3 * 86400000 };
      expect(await saveSettings(db as any, KEY, sub)).not.toBe(false);
    }
    configureAlerts(KEY, true);
    const K = 8;
    const txs = Array.from({ length: K }, (_, i) => ({ hash: `CNT${String(i).padStart(4, '0')}`, height: String(100 + i), tx_result: { code: 0, events: [transfer(i, 20_000)] } }));
    const posts: { url: string; tx: string; late: string | null }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => {
      const url = String(u);
      if (url.includes('discord.com')) {
        const body = JSON.parse(String(init?.body));
        posts.push({ url, tx: String(/\/tx\/(\w+)\)/.exec(String(body.embeds[0].description))?.[1] ?? ''), late: body.embeds[0].fields.find((f: any) => f.name === 'Found late')?.value ?? null });
        vi.setSystemTime(Date.now() + 50);
        return new Response(null, { status: 204 });
      }
      if (url.endsWith('/status')) return Response.json({ result: { sync_info: { latest_block_height: '200' } } });
      if (url.includes('/tx_search')) return Response.json({ result: { txs } });
      if (url.includes('/block?height=')) { vi.setSystemTime(Date.now() + 700); return Response.json({ result: { block: { header: { time: new Date().toISOString() } } } }); }
      throw new Error(`unexpected ${url}`);
    }));
    const storage = memStorage();
    const hub: any = Object.assign(Object.create(LiveHub.prototype), {
      env: { DB: db, DISCORD_WEBHOOK_URL: OP }, ctx: { storage },
      seenOsmoTx: new Set<string>(), osmoRetryTx: new Map<string, number>(), osmoWriting: new Map(), osmoRetryFrom: null, osmoRetryGen: 0, osmoHeight: 0, sessions: new Set(), lastPriceUsd: null,
      pendingN: null, pendingSeq: 0,
      osmoCtx: { poolAddrs: new Map(), priceUsd: null, assets: new Map() },
      quote: new HubQuote(async () => null, async () => null),
    });
    await db.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('osmosis.cursor', ?, 0)").bind(JSON.stringify({ height: 50, at: 0 })).run();
    await hub.sweepOsmosis();
    const claims = db.raw.prepare("SELECT COUNT(*) AS n FROM kv WHERE key LIKE 'alert:flow:osmosis:CNT%'").get().n as number;
    expect(claims).toBe(K); // every move was claimed: none is offered again
    expect(posts.filter((x) => x.url === OP)).toHaveLength(K);
    // One alarm posts at most its count; the rest of the subscribers wait in the hub's storage, nothing is recorded as
    // not sent.
    const first = posts.length;
    expect(posts.filter((x) => x.url !== OP).length).toBeLessThanOrEqual(LIVE_ALERT_POSTS);
    expect(first).toBeLessThanOrEqual(LIVE_ALERT_POSTS + K); // the operator's post of every move goes at once, never cut
    expect(first).toBeLessThan(K * S + K);
    expect((await storage.list({ prefix: PENDING_PREFIX })).size).toBeGreaterThan(0);
    expect(db.raw.prepare("SELECT value FROM kv WHERE key = 'alerts.skipped'").get()).toBeUndefined();
    // The next alarms send them first, in order, each under its own count, until the list is empty.
    let alarms = 0;
    while ((await storage.list({ prefix: PENDING_PREFIX })).size && alarms < 10) {
      alarms++;
      const budget = alarmBudget(Date.now() + 142_000, true);
      await hub.sendPending(budget);
      await flushAlerts(db as any, budget);
    }
    expect(alarms).toBeGreaterThan(0);
    expect(posts.filter((x) => x.url !== OP)).toHaveLength(K * S); // every watcher hears every move
    const last = `https://discord.com/api/webhooks/${7000 + 5}/w`;
    expect(posts.filter((x) => x.url === last)).toHaveLength(K);
    expect(new Set(posts.filter((x) => x.url !== OP).map((x) => `${x.url} ${x.tx}`)).size).toBe(K * S); // once each, never twice
    // Every post says the move was found late, with the time it happened (the catch-up search's own marking; a move
    // from the live stream that waits says it waited, test/alarm-fanout-budget.test.ts).
    for (const x of posts) expect(x.late).toMatch(/^The live feed missed this move; it happened <t:\d+:f>/);
    expect(db.raw.prepare("SELECT value FROM kv WHERE key = 'alerts.skipped'").get()).toBeUndefined();
    expect(claims).toBe(K);
  });
});
