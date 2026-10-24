// Security review (2026-10-22), a forum or governance alert and a settings read that fails: the cron's forum and
// governance alerts have a way to wait for the next run ('waiting': the caller keeps its cursor before the post, and
// the operator's part is posted under a claim of its own), but a settings read that failed was answered as an empty
// match: the operator was posted, the alert was 'done', the cursor moved past it, and every subscriber lost it. The
// deployed code lost it the same way (getUsers returned [] on a failed read); it was the one alert kind the deferral
// work did not cover. A failed read is now kept apart from an empty match: after the operator's post the alert waits,
// the run's later alerts wait in order (the budget closes as admit closes it), and the next run posts the subscribers
// only. Fetch is stubbed: nothing reaches Discord.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { base64 } from '@scure/base';
import { testD1, type TestD1 } from './d1-sqlite';
import { saveSettings, defaultPrefs, type StoredSettings } from '../worker/src/settings';
import { alertBudget, configureAlerts, flushAlerts, sendDiscordForumAlert, sendDiscordGovAlert, UNREAD_WHAT } from '../worker/src/sources/discord';
import type { ForumPost, GovernanceProposal } from '../shared/types';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const KEY = base64.encode(new Uint8Array(32).fill(42));
const OP = 'https://discord.com/api/webhooks/301/operator';
const SUB = 'https://discord.com/api/webhooks/7301/forumsub';
const post = (id: number): ForumPost => ({ id, topicId: 10, topicTitle: 'A topic', username: 'someone', displayName: null, url: 'https://forum.namada.net/t/a-topic/10', excerpt: 'words', postNumber: 1, isNewTopic: true, createdAt: Date.now() }) as unknown as ForumPost;
const proposal = (id: number): GovernanceProposal => ({ id, title: 'A proposal', status: 'voting', type: 'default', startEpoch: 1, endEpoch: 2, yayNam: 0, nayNam: 0, abstainNam: 0, abstract: 'words', discussionsUrl: null }) as unknown as GovernanceProposal;
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
const kvJson = (db: TestD1, key: string) => {
  const r = db.raw.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return r ? JSON.parse(r.value) : null;
};
async function subscriber(db: TestD1, tag: string) {
  const p = defaultPrefs();
  p.forumAndGov = true;
  const sub: StoredSettings = { address: `tnam1q${tag}${'q'.repeat(40 - tag.length)}`, notifications: p, channels: { discord: { enabled: true, webhookUrl: SUB } }, createdAt: Date.now() - 3 * 86_400_000, updatedAt: Date.now() - 3 * 86_400_000 };
  expect(await saveSettings(db as any, KEY, sub)).toBe(true);
}

describe('Security review (2026-10-22), a forum or governance alert offered while the settings cannot be read', () => {
  it('a forum post: the operator is posted and the alert waits; the next run, with the read answering, posts the subscriber and not the operator again', { timeout: 60_000 }, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const db = testD1();
    configureAlerts(KEY, true);
    await subscriber(db, 'forum');
    const posts: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => { posts.push(String(u)); return new Response(null, { status: 204 }); }));
    let down = true;
    const fdb = flaky(db, () => down);
    const run1 = alertBudget(Date.now());
    const first = await sendDiscordForumAlert(OP, post(1), fdb as any, run1);
    await flushAlerts(db as any, run1);
    expect(posts).toEqual([OP]);
    // The alert waits for the next run, as one whose subscribers do not fit does: the cron keeps its cursor before this
    // post and offers it again; the read that failed is on record.
    expect(first, 'the alert waits though no subscriber could be read').toBe('waiting');
    expect(run1).toMatchObject({ waiting: 1, closed: true, unread: true });
    expect(kvJson(db, 'alerts.skipped')?.last.what).toBe(UNREAD_WHAT);
    // A later alert of the same run waits in order (its operator post still goes).
    expect(await sendDiscordForumAlert(OP, post(2), fdb as any, run1)).toBe('waiting');
    expect(posts).toEqual([OP, OP]);
    // The next run, with D1 answering: offered again, the subscriber hears it and the operator is not posted again.
    vi.setSystemTime(Date.now() + 60_000);
    down = false;
    const run2 = alertBudget(Date.now());
    expect(await sendDiscordForumAlert(OP, post(1), db as any, run2)).toBe('done');
    await flushAlerts(db as any, run2);
    expect(posts.filter((u) => u === SUB), 'the subscriber hears the post on the next run').toHaveLength(1);
    expect(posts.filter((u) => u === OP), 'the operator is not posted again').toHaveLength(2);
  });

  it('a governance proposal waits the same way, and an alert nobody subscribed to is still done at once when the read answers', { timeout: 60_000 }, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const db = testD1();
    configureAlerts(KEY, true);
    await subscriber(db, 'gov');
    const posts: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => { posts.push(String(u)); return new Response(null, { status: 204 }); }));
    let down = true;
    const fdb = flaky(db, () => down);
    const run1 = alertBudget(Date.now());
    expect(await sendDiscordGovAlert(OP, proposal(7), true, fdb as any, run1)).toBe('waiting');
    await flushAlerts(db as any, run1);
    expect(posts).toEqual([OP]);
    vi.setSystemTime(Date.now() + 60_000);
    down = false;
    const run2 = alertBudget(Date.now());
    expect(await sendDiscordGovAlert(OP, proposal(7), true, db as any, run2)).toBe('done');
    await flushAlerts(db as any, run2);
    expect(posts).toEqual([OP, SUB]);
    // The read answers and matches nobody (the subscriber turned forum alerts off): done, nothing waits.
    const p = defaultPrefs();
    p.forumAndGov = false;
    const off: StoredSettings = { address: `tnam1qgov${'q'.repeat(37)}`, notifications: p, channels: { discord: { enabled: true, webhookUrl: SUB } }, createdAt: Date.now() - 3 * 86_400_000, updatedAt: Date.now() };
    expect(await saveSettings(db as any, KEY, off)).toBe(true);
    vi.setSystemTime(Date.now() + 60_000);
    const run3 = alertBudget(Date.now());
    expect(await sendDiscordGovAlert(OP, proposal(8), true, db as any, run3)).toBe('done');
    expect(run3.waiting).toBe(0);
    expect(posts).toEqual([OP, SUB, OP]);
  });
});
