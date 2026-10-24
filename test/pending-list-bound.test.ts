// Security review (2026-10-22), the pending list's size: the list was bounded by parts (1,000), because it was read
// whole at each alarm's start, so past it a move's subscribers that an alarm could not post were recorded with the
// posts not sent instead of kept, while the move's claim was taken; watchers of a busy address after an outage can
// reach that many moves in one search. The list is now bounded by the posts it holds across its parts
// (PENDING_POSTS_MAX, far more than parts), read in pages (PENDING_PAGE) only as far as the alarm's count lets it
// post, and the age limit is the only reason a part is let go. Fetch is stubbed: nothing reaches Discord.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { base64 } from '@scure/base';
import { testD1 } from './d1-sqlite';
import { saveSettings, defaultPrefs, type StoredSettings } from '../worker/src/settings';
import { alarmBudget, configureAlerts, flushAlerts } from '../worker/src/sources/discord';
import { memStorage } from './do-storage';
import type { Flow } from '../shared/types';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import { LiveHub, PENDING_PAGE, PENDING_POSTS_MAX, PENDING_PREFIX } from '../worker/src/live-hub';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const KEY = base64.encode(new Uint8Array(32).fill(34));
const WATCHED = 'osmo1watchedsenderaddressxxxxxxxxxxxxxxxxx';
const SUB = 'https://discord.com/api/webhooks/7104/sub';
const move = (n: number): Flow => ({ id: `osmosis:PM${n}:0`, chain: 'osmosis', height: n, ts: Date.now(), txHash: `PM${n}`, kind: 'sell', from: WATCHED, to: null, amount: 20_000, meta: null }) as unknown as Flow;
const hubOf = (db: unknown, storage: ReturnType<typeof memStorage>): any =>
  Object.assign(Object.create(LiveHub.prototype), { env: { DB: db, DISCORD_WEBHOOK_URL: undefined }, ctx: { storage }, pendingN: null, pendingPosts: null, pendingNoted: null, pendingSeq: 0 });

describe('Security review (2026-10-22), the pending list is bounded by posts and read in pages', () => {
  it('1,001 moves an alarm cannot post are all kept, none recorded as not sent; the next alarms read the list in pages, as far as they can post, and drain it', { timeout: 120_000 }, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const db = testD1();
    configureAlerts(KEY, true);
    const p = defaultPrefs();
    p.watchlist = [WATCHED];
    const sub: StoredSettings = { address: `tnam1qwatchpm${'q'.repeat(33)}`, notifications: p, channels: { discord: { enabled: true, webhookUrl: SUB } }, createdAt: Date.now() - 3 * 86_400_000, updatedAt: Date.now() - 3 * 86_400_000 };
    expect(await saveSettings(db as any, KEY, sub)).toBe(true);
    const posts: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => { posts.push(String(u)); return new Response(null, { status: 204 }); }));
    const storage = memStorage();
    const lists: { limit?: number; startAfter?: string }[] = [];
    const list = storage.list.bind(storage);
    storage.list = (opts) => { lists.push({ limit: opts?.limit, startAfter: opts?.startAfter }); return list(opts); };
    const hub = hubOf(db, storage);
    // An alarm whose count is spent (a backlog already waits), and 1,001 more moves this watcher matches.
    const N = 1001;
    const budget = alarmBudget(Date.now() + 142_000, true);
    budget.posts = 0;
    await hub.alertFlows(Array.from({ length: N }, (_, i) => move(i + 1)), 10000, 100, budget);
    await flushAlerts(db as any, budget);
    expect(db.raw.prepare("SELECT value FROM kv WHERE key = 'alerts.skipped'").get(), 'nothing recorded as not sent').toBeUndefined();
    expect((await list({ prefix: PENDING_PREFIX })).size).toBe(N);
    expect(hub.pendingN).toBe(N);
    expect(hub.pendingPosts).toBe(N);
    // Every read of the list is a page: never the whole list at once.
    expect(lists.every((l) => l.limit != null && l.limit <= PENDING_PAGE)).toBe(true);
    // An alarm with a count of 10 posts reads one page and posts 10 parts; the list is never read whole.
    lists.length = 0;
    vi.setSystemTime(Date.now() + 6_000);
    const small = alarmBudget(Date.now() + 142_000, true);
    small.posts = 10;
    await hub.sendPending(small);
    await flushAlerts(db as any, small);
    expect(posts).toHaveLength(10);
    expect(lists).toHaveLength(1);
    expect(lists[0].limit).toBe(PENDING_PAGE);
    expect((await list({ prefix: PENDING_PREFIX })).size).toBe(N - 10);
    // The alarms after it, each with the usual count, drain the list in order, reading page after page.
    let alarms = 0;
    while ((await list({ prefix: PENDING_PREFIX })).size && alarms < 10) {
      alarms++;
      vi.setSystemTime(Date.now() + 6_000);
      const b = alarmBudget(Date.now() + 142_000, true);
      await hub.sendPending(b);
      await flushAlerts(db as any, b);
    }
    expect(alarms).toBe(2); // 520 posts an alarm: 991 parts take two
    expect(posts).toHaveLength(N);
    expect(new Set(posts.map((_, i) => i)).size).toBe(N);
    expect(hub.pendingN).toBe(0);
    expect(hub.pendingPosts).toBe(0);
    expect(db.raw.prepare("SELECT value FROM kv WHERE key = 'alerts.skipped'").get()).toBeUndefined();
    expect(lists.some((l) => l.startAfter)).toBe(true); // the second page of an alarm follows the first's last key
  });

  it('past PENDING_POSTS_MAX posts a part is recorded as not sent, never kept unseen; a part counts at least one post', { timeout: 60_000 }, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const db = testD1();
    configureAlerts(KEY, true);
    const p = defaultPrefs();
    p.watchlist = [WATCHED];
    const sub: StoredSettings = { address: `tnam1qwatchpx${'q'.repeat(33)}`, notifications: p, channels: { discord: { enabled: true, webhookUrl: SUB } }, createdAt: Date.now() - 3 * 86_400_000, updatedAt: Date.now() - 3 * 86_400_000 };
    expect(await saveSettings(db as any, KEY, sub)).toBe(true);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    const storage = memStorage();
    const hub = hubOf(db, storage);
    // The list already holds the most posts it may (as counted), in parts of one post each.
    hub.pendingN = PENDING_POSTS_MAX;
    hub.pendingPosts = PENDING_POSTS_MAX;
    const budget = alarmBudget(Date.now() + 142_000, true);
    budget.posts = 0;
    await hub.alertFlows([move(50_001)], 10000, 100, budget);
    await flushAlerts(db as any, budget);
    expect((await storage.list({ prefix: PENDING_PREFIX })).size).toBe(0);
    const skipped = JSON.parse((db.raw.prepare("SELECT value FROM kv WHERE key = 'alerts.skipped'").get() as any).value);
    expect(skipped.last).toMatchObject({ n: 1, what: expect.stringContaining(`not kept for a later run: Error: the pending list holds ${PENDING_POSTS_MAX} posts`) });
    expect(PENDING_POSTS_MAX).toBe(50_000);
  });
});
