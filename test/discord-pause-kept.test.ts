// Security review (2026-10-22), a hook paused by Discord's Retry-After and the pending list: a 429 pauses the hook for
// its Retry-After, and every post to it during the pause was skipped and recorded, never handed back to a dispatch
// that keeps what it cannot send now, and the post the 429 answered was lost too. An honest hook that several moves
// of one batch match lost the moves after Discord's per-webhook bucket was empty, though the dispatch could keep them
// for the next alarm, a few seconds later. The pause is now kept apart from a hook's failure backoff: under a dispatch
// that sends later, a subscriber's post that a 429 answers, and one that finds the hook paused, are handed back for
// the next alarm; the operator's channel waits a short Retry-After out in place, within the alert's window, and is
// posted once more. Without such a dispatch a paused hook is skipped and recorded as before. Fetch is stubbed:
// nothing reaches Discord.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { base64 } from '@scure/base';
import { testD1 } from './d1-sqlite';
import { saveSettings, defaultPrefs, type StoredSettings } from '../worker/src/settings';
import { alarmBudget, configureAlerts, flushAlerts, sendDiscordWhaleAlert, type PendingAlert } from '../worker/src/sources/discord';
import type { Flow } from '../shared/types';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const KEY = base64.encode(new Uint8Array(32).fill(33));
const OP = 'https://discord.com/api/webhooks/301/operator';
const WATCHED = 'osmo1watchedsenderaddressxxxxxxxxxxxxxxxxx';
const SUB = 'https://discord.com/api/webhooks/7103/sub';
const move = (n: number): Flow => ({ id: `osmosis:RL${n}:0`, chain: 'osmosis', height: n, ts: Date.now(), txHash: `RL${n}`, kind: 'sell', from: WATCHED, to: null, amount: 20_000, meta: null }) as unknown as Flow;
const rateLimited = (sec: number) => new Response(JSON.stringify({ message: 'You are being rate limited.', retry_after: sec, global: false }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': String(sec), 'x-ratelimit-scope': 'user' } });

describe('Security review (2026-10-22), an honest hook under a Retry-After pause', () => {
  it('ten moves of one batch match one watcher: the posts Discord\'s bucket cannot take now are kept, not lost', { timeout: 60_000 }, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const db = testD1();
    configureAlerts(KEY, true);
    const p = defaultPrefs();
    p.watchlist = [WATCHED];
    const sub: StoredSettings = { address: `tnam1qwatchrl${'q'.repeat(33)}`, notifications: p, channels: { discord: { enabled: true, webhookUrl: SUB } }, createdAt: Date.now() - 3 * 86_400_000, updatedAt: Date.now() - 3 * 86_400_000 };
    expect(await saveSettings(db as any, KEY, sub)).toBe(true);
    // Discord's webhook bucket: 5 posts, then 429 with Retry-After 2 (scope user) until it refills.
    let taken = 0;
    const posts: number[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (taken < 5) { taken++; posts.push(200); return new Response(null, { status: 204 }); }
      posts.push(429);
      return rateLimited(2);
    }));
    const budget = alarmBudget(Date.now() + 142_000, true);
    const kept: PendingAlert[] = [];
    for (let i = 1; i <= 10; i++) {
      const left = await sendDiscordWhaleAlert(undefined, move(i), db as any, 10000, budget);
      if (left) kept.push(left);
    }
    await flushAlerts(db as any, budget);
    const ok = posts.filter((s) => s === 200).length;
    const waiting = kept.reduce((n, k) => n + k.n, 0);
    // Every move reaches the watcher now or waits for a later alarm: none is recorded as not sent, and the one post
    // the 429 answered is among those kept.
    expect(db.raw.prepare("SELECT value FROM kv WHERE key = 'alerts.skipped'").get(), 'nothing recorded as not sent').toBeUndefined();
    expect(ok).toBe(5);
    expect(posts.filter((s) => s === 429)).toHaveLength(1); // the sixth post was answered 429; the rest never left
    expect(ok + waiting, 'posted now or kept').toBe(10);
    expect(kept.every((k) => k.claims === 'all' && k.only?.length === 1)).toBe(true);
    // The next alarm, after the Retry-After: the kept parts are posted.
    vi.setSystemTime(Date.now() + 6_000);
    taken = 0;
    const next = alarmBudget(Date.now() + 142_000, true);
    let sent = 0;
    for (const k of kept) { const left = await sendDiscordWhaleAlert(undefined, k.flow, db as any, 10000, next, k); if (!left) sent++; }
    await flushAlerts(db as any, next);
    expect(sent).toBe(5);
    expect(posts.filter((s) => s === 200)).toHaveLength(10);
  });

  it('the operator\'s channel waits a short Retry-After out in place and is posted once more, within the alert\'s window', { timeout: 60_000 }, async () => {
    const db = testD1();
    configureAlerts(KEY, true);
    const answers: number[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => {
      answers.push(answers.length ? 204 : 429);
      return answers.length === 1 ? rateLimited(1) : new Response(null, { status: 204 });
    }));
    await sendDiscordWhaleAlert(OP, move(20), db as any, 10000);
    expect(answers).toEqual([429, 204]);
    expect(db.raw.prepare("SELECT value FROM kv WHERE key = 'alerts.skipped'").get()).toBeUndefined();
  });
});
