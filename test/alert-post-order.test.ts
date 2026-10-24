// Security review (2026-10-22), post order within one alert: the subscribers of an alert start at a place that differs
// per alert, so that what a window cuts is never always the same channels, but they were then sorted by tier (hooks
// that worked here, settled rows, the rest). A row saved within SETTLED_MS whose hook had not yet worked in this
// isolate was in the last tier on every alert, so once an alert had more subscribers than one window could post, that
// honest subscriber was the one cut, alert after alert, never posted, and so never leaving the last tier. The tiers
// now only choose who is held once the invalid-answer budget is spent; every other subscriber is posted in the
// rotation's order, and an alert's window is long enough for all its subscribers at Discord's pace.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { base64 } from '@scure/base';
import { testD1, type TestD1 } from './d1-sqlite';
import { configureAlerts, sendDiscordForumAlert } from '../worker/src/sources/discord';
import { saveSettings, defaultPrefs, type StoredSettings } from '../worker/src/settings';
import type { ForumPost } from '../shared/types';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const KEY = base64.encode(new Uint8Array(32).fill(8));
const OP = 'https://discord.com/api/webhooks/9/operator';
const NEW = 'https://discord.com/api/webhooks/77777/newsubscriber';
const N = 400;
const later = <T>(ms: number, v: () => T) => new Promise<T>((r) => setTimeout(() => r(v()), ms));
async function settle<T>(p: Promise<T>) {
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; !done && i < 40_000; i++) await vi.advanceTimersByTimeAsync(100);
  expect(done).toBe(true);
}
const post = (id: number): ForumPost => ({ id, topicId: 1, topicTitle: 't', topicSlug: 't', postNumber: 2, url: `https://forum.namada.net/t/t/1/${id}`, username: 'u', displayName: null, avatarUrl: null, createdAt: new Date().toISOString(), excerpt: 'e', isNewTopic: false });

describe('Security review (2026-10-22), post order: a subscriber saved today is not cut from every alert', () => {
  it('a new honest subscriber among 400 settled ones hears some of five forum alerts, as the others do', { timeout: 120_000 }, async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const now = Date.now();
    const db: TestD1 = testD1();
    configureAlerts(KEY);
    const mk = (address: string, url: string, at: number): StoredSettings => {
      const p = defaultPrefs();
      p.forumAndGov = true;
      return { address, notifications: p, channels: { discord: { enabled: true, webhookUrl: url } }, createdAt: at, updatedAt: at };
    };
    for (let i = 0; i < N; i++) await saveSettings(db as any, KEY, mk(`tnam1qold${String(i).padStart(5, '0')}${'q'.repeat(30)}`, `https://discord.com/api/webhooks/${1000 + i}/old`, now - 3 * 86400000));
    await saveSettings(db as any, KEY, mk(`tnam1qnew00000${'q'.repeat(30)}`, NEW, now - 3600000)); // saved an hour ago
    const posts: string[] = [];
    vi.stubGlobal('fetch', vi.fn((u: any) => { posts.push(String(u)); return later(300, () => new Response(null, { status: 204 })); }));
    for (let k = 0; k < 5; k++) await settle(sendDiscordForumAlert(OP, post(990000 + k), db as any));
    const heard = (url: string) => posts.filter((x) => x === url).length;
    const old = Array.from({ length: N }, (_, i) => heard(`https://discord.com/api/webhooks/${1000 + i}/old`));
    expect(heard(OP)).toBe(5);
    expect(heard(NEW)).toBeGreaterThan(0);
    // One window posts every channel of an alert at Discord's pace, so no settled subscriber is cut either.
    expect(heard(NEW)).toBe(5);
    expect(old.filter((x) => x !== 5)).toEqual([]);
  });
});
