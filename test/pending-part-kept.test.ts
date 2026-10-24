// Security review (2026-10-22), the alerts' pending list and a part offered again: a part kept for the next alarm
// was sent "to the subscribers that still match the move then", and a part with nobody to send to now was deleted as
// if nobody matched any more. So a kept alert was lost when its subscriber was in quiet hours at the moment the part
// came up (the move happened outside them), and when the settings read failed at that moment (a D1 blip: every part
// resumed in that alarm was deleted). Before the pending list the post was made at the offer. "Nothing to send now"
// is now told from "nothing left": a part is put back unchanged when the settings could not be read (and the alarm's
// resume stops there), a channel in its quiet hours is kept in the part until they end, a move offered under a
// deferring budget while the read failed is kept as a part, and a part is let go only when every channel was posted,
// no row holds its links any more, or the move is past the hub's age limit. Fetch is stubbed: nothing reaches Discord.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { base64 } from '@scure/base';
import { testD1, type TestD1 } from './d1-sqlite';
import { saveSettings, defaultPrefs, type StoredSettings } from '../worker/src/settings';
import { alarmBudget, configureAlerts, flushAlerts, sendDiscordWhaleAlert, type PendingAlert } from '../worker/src/sources/discord';
import { memStorage } from './do-storage';
import type { Flow } from '../shared/types';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import { LiveHub, PENDING_PREFIX } from '../worker/src/live-hub';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const KEY = base64.encode(new Uint8Array(32).fill(31));
const OP = 'https://discord.com/api/webhooks/301/operator';
const WATCHED = 'osmo1watchedsenderaddressxxxxxxxxxxxxxxxxx';
const SUB = 'https://discord.com/api/webhooks/7101/sub';
const move = (n: number, ts = Date.now()): Flow => ({ id: `osmosis:PK${n}:0`, chain: 'osmosis', height: n, ts, txHash: `PK${n}`, kind: 'sell', from: WATCHED, to: null, amount: 20_000, meta: null }) as unknown as Flow;
const watcher = (address: string, quietHoursUtc: { start: number; end: number } | null = null): StoredSettings => {
  const p = defaultPrefs();
  p.watchlist = [WATCHED];
  p.quietHoursUtc = quietHoursUtc;
  return { address, notifications: p, channels: { discord: { enabled: true, webhookUrl: SUB } }, createdAt: Date.now() - 3 * 86_400_000, updatedAt: Date.now() - 3 * 86_400_000 };
};
function discord() {
  const posts: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (u: string) => { posts.push(String(u)); return new Response(null, { status: 204 }); }));
  return posts;
}
const hubOf = (db: unknown, storage: ReturnType<typeof memStorage>, op?: string): any =>
  Object.assign(Object.create(LiveHub.prototype), { env: { DB: db, DISCORD_WEBHOOK_URL: op }, ctx: { storage }, pendingN: null, pendingPosts: null, pendingNoted: null, pendingSeq: 0 });
const pending = async (storage: ReturnType<typeof memStorage>) => [...(await storage.list<PendingAlert>({ prefix: PENDING_PREFIX })).values()];
/** A D1 stand-in whose settings read (readDeliverable's query) fails while `down()` is true, and answers everything else. */
function flaky(db: TestD1, down: () => boolean) {
  return new Proxy(db, {
    get(target, k) {
      if (k === 'prepare') return (sql: string) => {
        if (/WITH r AS/.test(sql) && down()) {
          const failing = { all: async () => { throw new Error('D1_ERROR: storage caused object reset'); }, bind: () => failing };
          return failing;
        }
        return target.prepare(sql);
      };
      return (target as any)[k];
    },
  }) as unknown as TestD1;
}

describe('Security review (2026-10-22), a kept alert and the moment it is offered again', () => {
  it('a part resumed while the settings cannot be read is put back unchanged and the resume stops; the alarm after the blip sends it', { timeout: 60_000 }, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const db = testD1();
    configureAlerts(KEY, true);
    expect(await saveSettings(db as any, KEY, watcher(`tnam1qwatchrf${'q'.repeat(33)}`))).toBe(true);
    const posts = discord();
    // An alarm whose count is spent: the move's subscribers wait whole for the next alarm.
    const spent = alarmBudget(Date.now() + 142_000, true);
    spent.posts = 0;
    const part = await sendDiscordWhaleAlert(undefined, move(1), db as any, 10000, spent);
    await flushAlerts(db as any, spent);
    expect(part).toMatchObject({ n: 1, claims: 'none' });
    expect(posts).toHaveLength(0);
    const storage = memStorage();
    await storage.put(`${PENDING_PREFIX}${String(part!.at).padStart(14, '0')}:0000`, part);
    await storage.put(`${PENDING_PREFIX}${String(part!.at + 1).padStart(14, '0')}:0001`, { ...part, flow: move(2) });
    // The next alarm: D1 does not answer the dispatcher's settings read (a transient error), and answers everything else.
    let down = true;
    const reads = { n: 0 };
    const hub = hubOf(flaky(db, () => { reads.n++; return down; }), storage);
    const b1 = alarmBudget(Date.now() + 142_000, true);
    await hub.sendPending(b1);
    await flushAlerts(db as any, b1);
    expect(posts).toHaveLength(0);
    expect(await pending(storage)).toHaveLength(2); // both parts are still kept
    expect(reads.n).toBe(1); // the resume stopped at the first part: every part would fail the same way
    expect(db.raw.prepare("SELECT value FROM kv WHERE key = 'alerts.skipped'").get(), 'nothing recorded as not sent: the parts wait').toBeUndefined();
    // The alarm after that: D1 answers again, and the subscriber hears both moves.
    vi.setSystemTime(Date.now() + 160_000);
    down = false;
    const b2 = alarmBudget(Date.now() + 142_000, true);
    await hub.sendPending(b2);
    await flushAlerts(db as any, b2);
    expect(posts.filter((u) => u === SUB)).toHaveLength(2);
    expect(await pending(storage)).toHaveLength(0);
  });

  it('a part resumed inside the subscriber\'s quiet hours is kept until they end, then sent', { timeout: 60_000 }, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 9, 23, 21, 50)); // 21:50 UTC
    const db = testD1();
    configureAlerts(KEY, true);
    expect(await saveSettings(db as any, KEY, watcher(`tnam1qwatchqh${'q'.repeat(33)}`, { start: 22, end: 23 }))).toBe(true);
    const posts = discord();
    // 21:50: the move is offered outside the quiet hours, in an alarm whose count is spent, so the post waits.
    const spent = alarmBudget(Date.now() + 142_000, true);
    spent.posts = 0;
    const part = await sendDiscordWhaleAlert(undefined, move(10), db as any, 10000, spent);
    await flushAlerts(db as any, spent);
    expect(part).toMatchObject({ n: 1, claims: 'none' });
    const storage = memStorage();
    await storage.put(`${PENDING_PREFIX}${String(part!.at).padStart(14, '0')}:0000`, part);
    const hub = hubOf(db, storage);
    // 22:05: the backlog reaches this part inside the quiet hours: not posted (right), and kept.
    vi.setSystemTime(Date.UTC(2026, 9, 23, 22, 5));
    const b1 = alarmBudget(Date.now() + 142_000, true);
    await hub.sendPending(b1);
    await flushAlerts(db as any, b1);
    expect(posts).toHaveLength(0);
    const kept = await pending(storage);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ n: 1, claims: 'none' });
    expect(kept[0].only).toHaveLength(1);
    // 23:05: the quiet hours are over.
    vi.setSystemTime(Date.UTC(2026, 9, 23, 23, 5));
    const b2 = alarmBudget(Date.now() + 142_000, true);
    await hub.sendPending(b2);
    await flushAlerts(db as any, b2);
    expect(posts.filter((u) => u === SUB)).toHaveLength(1);
    expect(await pending(storage)).toHaveLength(0);
  });

  it('a move at 21:58 UTC whose operator post went at once is kept through quiet hours of 22:00 to 07:00 and reaches the subscriber the next morning', { timeout: 60_000 }, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 9, 23, 21, 58));
    const db = testD1();
    configureAlerts(KEY, true);
    const T = Date.now();
    expect(await saveSettings(db as any, KEY, watcher(`tnam1qquiet${'q'.repeat(35)}`, { start: 22, end: 7 }))).toBe(true);
    const posts = discord();
    const storage = memStorage();
    const hub = hubOf(db, storage, OP);
    // The alarm's count went to earlier alerts: the operator is posted, the subscriber's part waits.
    const spent = alarmBudget(Date.now() + 142_000, true);
    spent.posts = 0;
    await hub.alertFlows([move(3, T)], 10000, 100, spent);
    await flushAlerts(db as any, spent);
    expect(posts).toEqual([OP]);
    expect(await pending(storage)).toHaveLength(1);
    // The next alarm, three minutes later: the subscriber's quiet hours have begun.
    vi.setSystemTime(Date.UTC(2026, 9, 23, 22, 1));
    const next = alarmBudget(Date.now() + 142_000, true);
    await hub.sendPending(next);
    await flushAlerts(db as any, next);
    expect(posts.filter((u) => u === SUB)).toHaveLength(0);
    expect(await pending(storage)).toHaveLength(1);
    // The first alarm after the quiet hours: the move is nine hours old, well within the day a late alert may be.
    vi.setSystemTime(Date.UTC(2026, 9, 24, 7, 1));
    const morning = alarmBudget(Date.now() + 142_000, true);
    await hub.sendPending(morning);
    await flushAlerts(db as any, morning);
    expect(posts.filter((u) => u === SUB)).toHaveLength(1);
    expect(await pending(storage)).toHaveLength(0);
  });

  it('a move offered under a deferring budget while the settings cannot be read is kept as a part, the operator posted at once; the next alarm sends it', { timeout: 60_000 }, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const db = testD1();
    configureAlerts(KEY, true);
    expect(await saveSettings(db as any, KEY, watcher(`tnam1qblip${'q'.repeat(36)}`))).toBe(true);
    const posts = discord();
    const storage = memStorage();
    let down = true;
    const hub = hubOf(flaky(db, () => down), storage, OP);
    const budget = alarmBudget(Date.now() + 142_000, true);
    await hub.alertFlows([move(4)], 10000, 100, budget);
    await flushAlerts(db as any, budget);
    expect(posts).toEqual([OP]);
    const kept = await pending(storage);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ claims: 'flow', n: 0 });
    expect(db.raw.prepare("SELECT value FROM kv WHERE key = 'alerts.skipped'").get()).toBeUndefined();
    vi.setSystemTime(Date.now() + 20_000);
    down = false;
    const next = alarmBudget(Date.now() + 142_000, true);
    await hub.sendPending(next);
    await flushAlerts(db as any, next);
    expect(posts).toEqual([OP, SUB]);
    expect(await pending(storage)).toHaveLength(0);
  });

  it('a part is let go when no row holds its link any more (the owner removed the link), and when its move is past the age limit', { timeout: 60_000 }, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const db = testD1();
    configureAlerts(KEY, true);
    const a = `tnam1qgone${'q'.repeat(36)}`;
    expect(await saveSettings(db as any, KEY, watcher(a))).toBe(true);
    const posts = discord();
    const spent = alarmBudget(Date.now() + 142_000, true);
    spent.posts = 0;
    const part = await sendDiscordWhaleAlert(undefined, move(5), db as any, 10000, spent);
    await flushAlerts(db as any, spent);
    const storage = memStorage();
    await storage.put(`${PENDING_PREFIX}${String(part!.at).padStart(14, '0')}:0000`, part);
    // The owner removes the link; the users are read again after the cache.
    const off = watcher(a);
    off.channels.discord = { enabled: false, webhookUrl: null };
    expect(await saveSettings(db as any, KEY, off)).toBe(true);
    vi.setSystemTime(Date.now() + 20_000);
    const hub = hubOf(db, storage);
    const b1 = alarmBudget(Date.now() + 142_000, true);
    await hub.sendPending(b1);
    await flushAlerts(db as any, b1);
    expect(posts).toHaveLength(0);
    expect(await pending(storage)).toHaveLength(0);
    // A part whose move is older than a day is let go and recorded.
    const old = { ...part!, flow: move(6, Date.now() - 25 * 3_600_000), at: Date.now() - 25 * 3_600_000 };
    await storage.put(`${PENDING_PREFIX}${String(old.at).padStart(14, '0')}:0001`, old);
    const b2 = alarmBudget(Date.now() + 142_000, true);
    await hub.sendPending(b2);
    await flushAlerts(db as any, b2);
    expect(await pending(storage)).toHaveLength(0);
    expect(JSON.parse((db.raw.prepare("SELECT value FROM kv WHERE key = 'alerts.skipped'").get() as any).value).last.what).toMatch(/waited past 24 h/);
  });

  it('a channel whose quiet hours cover the move itself is dropped on resume as the direct path drops it, never kept a day and recorded as not sent', { timeout: 60_000 }, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 9, 23, 12));
    const db = testD1();
    configureAlerts(KEY, true);
    // A watcher whose quiet hours are the whole day (applyUpdate allows 0 to 24), and another watcher of the same
    // address with no quiet hours on a link of its own, whose post is what makes the part.
    const ALLDAY = 'https://discord.com/api/webhooks/7201/allday';
    const OTHER = 'https://discord.com/api/webhooks/7202/other';
    const quiet = watcher(`tnam1qallday${'q'.repeat(34)}`, { start: 0, end: 24 });
    quiet.channels.discord.webhookUrl = ALLDAY;
    expect(await saveSettings(db as any, KEY, quiet)).toBe(true);
    const other = watcher(`tnam1qother${'q'.repeat(35)}`);
    other.channels.discord.webhookUrl = OTHER;
    expect(await saveSettings(db as any, KEY, other)).toBe(true);
    const posts = discord();
    // Offered directly: the all-day channel is in quiet hours, so it is not posted and not kept; the other is posted.
    const direct = alarmBudget(Date.now() + 142_000, true);
    expect(await sendDiscordWhaleAlert(undefined, move(21, Date.now()), db as any, 10000, direct)).toBeNull();
    await flushAlerts(db as any, direct);
    expect(posts).toEqual([OTHER]);
    posts.length = 0;
    // Another move offered in an alarm whose count is spent: the other watcher's post waits, so the part is kept whole.
    const spent = alarmBudget(Date.now() + 142_000, true);
    spent.posts = 0;
    const part = await sendDiscordWhaleAlert(undefined, move(22, Date.now()), db as any, 10000, spent);
    await flushAlerts(db as any, spent);
    expect(part).toMatchObject({ n: 1, claims: 'none' });
    const storage = memStorage();
    await storage.put(`${PENDING_PREFIX}${String(part!.at).padStart(14, '0')}:0000`, part);
    const hub = hubOf(db, storage);
    vi.setSystemTime(Date.now() + 6_000);
    const b1 = alarmBudget(Date.now() + 142_000, true);
    await hub.sendPending(b1);
    await flushAlerts(db as any, b1);
    // The other watcher is posted; the all-day channel is dropped, since the move itself fell inside its quiet hours
    // (as every move does for this subscriber), and nothing is kept or recorded.
    expect(posts).toEqual([OTHER]);
    expect(await pending(storage), 'no part is kept for a channel whose quiet hours cover the move').toHaveLength(0);
    vi.setSystemTime(Date.now() + 25 * 3_600_000);
    const b2 = alarmBudget(Date.now() + 142_000, true);
    await hub.sendPending(b2);
    await flushAlerts(db as any, b2);
    expect(posts).toEqual([OTHER]);
    expect(db.raw.prepare("SELECT value FROM kv WHERE key = 'alerts.skipped'").get(), 'nothing recorded as not sent for a subscriber who never wanted it').toBeUndefined();
  });
});
