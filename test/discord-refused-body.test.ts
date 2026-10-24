// Security review (2026-10-22), Discord's 400 answers: a 400 is a body Discord refused (a field over its limit,
// the same body lost on every channel) only when its JSON error code is 50035, Invalid Form Body; only then is it
// recorded with the posts not sent (kv alerts.skipped, the "Discord alert delivery" health row). Any other 400 is
// the hook's own: a webhook made in a forum channel answers 220001 to every post that names no thread, whatever the
// body, and one user's hook of that kind must not turn the operator's row red while the operator's post went out.
// Such a 400 counts against that hook, as every failed post does, and the hook is left alone after BACKOFF_AFTER.
// No more than 4 KB of a 400 is read.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { base64 } from '@scure/base';
import { testD1, type TestD1 } from './d1-sqlite';
import { configureAlerts, sendDiscordWhaleAlert, sendDiscordForumAlert, BACKOFF_AFTER, DISCORD_INVALID_FORM_BODY } from '../worker/src/sources/discord';
import { saveSettings, defaultPrefs, type StoredSettings } from '../worker/src/settings';
import type { Flow, ForumPost } from '../shared/types';

afterEach(() => vi.unstubAllGlobals());

const NOW = Date.now();
const KEY = base64.encode(new Uint8Array(32).fill(7));
const user = (address: string, webhookUrl: string): StoredSettings => {
  const s: StoredSettings = { address, notifications: defaultPrefs(), channels: { discord: { enabled: true, webhookUrl } }, createdAt: NOW, updatedAt: NOW };
  s.notifications.rules.big_swap = { on: true, thresholdNam: 1 };
  return s;
};
const sell = (tag: string, n: number): Flow => ({ id: `osmosis:${tag}${n}:0`, chain: 'osmosis', height: n, ts: NOW, txHash: `${tag}${n}`, kind: 'sell', from: 'osmo1yl6hdjhmkf37639730gffanpzndzdpmhxy9ep3', to: null, amount: 20000, meta: null });
const json400 = (v: unknown) => new Response(JSON.stringify(v), { status: 400, headers: { 'content-type': 'application/json' } });
/** Discord's answer to a body with a field over its limit (as Discord writes it: message, code, errors). */
const INVALID_FORM = { message: 'Invalid Form Body', code: 50035, errors: { embeds: { 0: { description: { _errors: [{ code: 'BASE_TYPE_MAX_LENGTH', message: 'Must be 4096 or fewer in length.' }] } } } } };
/** Discord's answer to any post to a webhook made in a forum channel that names no thread_name or thread_id. */
const FORUM_CHANNEL = { message: 'Webhooks posted to forum channels must have a thread_name or thread_id', code: 220001 };
const skippedRow = (db: TestD1) => {
  const row = db.raw.prepare("SELECT value FROM kv WHERE key = 'alerts.skipped'").get() as { value: string } | undefined;
  return row ? JSON.parse(row.value) : null;
};

describe('a 400 from Discord counts as a refused body only when Discord says so (code 50035)', () => {
  it('a forum-channel user hook (220001) is not recorded, and the operator got the same body', async () => {
    const OP = 'https://discord.com/api/webhooks/11/operator', FORUM = 'https://discord.com/api/webhooks/12/forumchannel';
    const posted: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      if (String(u) === FORUM) return json400(FORUM_CHANNEL);
      posted.push(String(u));
      return new Response(null, { status: 204 });
    }));
    const db = testD1();
    configureAlerts(KEY);
    await saveSettings(db as any, KEY, user(`tnam1qforum${'q'.repeat(35)}`, FORUM));
    await sendDiscordWhaleAlert(OP, sell('FA', 1), db as any, 10000);
    expect(posted).toEqual([OP]);
    expect(skippedRow(db)).toBeNull();
  });

  it('a 400 that is not JSON (an HTML page in front of Discord) is the hook\'s, not a refused body', async () => {
    const HOOK = 'https://discord.com/api/webhooks/13/html';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html><body>400 Bad Request</body></html>', { status: 400, headers: { 'content-type': 'text/html' } })));
    const db = testD1();
    configureAlerts(KEY);
    await saveSettings(db as any, KEY, user(`tnam1qhtml${'q'.repeat(36)}`, HOOK));
    await sendDiscordWhaleAlert(undefined, sell('HT', 1), db as any, 10000);
    expect(skippedRow(db)).toBeNull();
  });

  it('a hook that answers 220001 to every post is left alone after BACKOFF_AFTER, recorded as skipped, never as refused', async () => {
    const FORUM = 'https://discord.com/api/webhooks/14/forumagain';
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => { calls.push(String(u)); return json400(FORUM_CHANNEL); }));
    const db = testD1();
    configureAlerts(KEY);
    await saveSettings(db as any, KEY, user(`tnam1qagain${'q'.repeat(35)}`, FORUM));
    for (let n = 1; n <= BACKOFF_AFTER; n++) await sendDiscordWhaleAlert(undefined, sell('FB', n), db as any, 10000);
    expect(calls).toHaveLength(BACKOFF_AFTER);
    expect(skippedRow(db)).toBeNull();
    await sendDiscordWhaleAlert(undefined, sell('FB', 99), db as any, 10000);
    expect(calls).toHaveLength(BACKOFF_AFTER);
    const rec = skippedRow(db);
    expect(rec).toMatchObject({ total: 1, last: { what: 'move osmosis:FB99:0', n: 1 } });
  });

  it('Invalid Form Body (50035) on every channel is recorded as refused by Discord, with how many', async () => {
    expect(DISCORD_INVALID_FORM_BODY).toBe(50035);
    const OP = 'https://discord.com/api/webhooks/15/operator', HOOK = 'https://discord.com/api/webhooks/16/user';
    vi.stubGlobal('fetch', vi.fn(async () => json400(INVALID_FORM)));
    const db = testD1();
    configureAlerts(KEY);
    await saveSettings(db as any, KEY, user(`tnam1qinval${'q'.repeat(35)}`, HOOK));
    await sendDiscordWhaleAlert(OP, sell('IF', 1), db as any, 10000);
    expect(skippedRow(db)).toMatchObject({ total: 2, last: { what: 'move osmosis:IF1:0 (2 refused by Discord)', n: 2 } });
  });

  it('a 50035 answer is read for its first 4 KB only, and still recognised when the rest is cut off', async () => {
    const HOOK = 'https://discord.com/api/webhooks/17/long';
    const enc = new TextEncoder();
    let pulled = 0, cancelled = false;
    const head = enc.encode('{"message": "Invalid Form Body", "code": 50035, "errors": {"content": {"_errors": [');
    const pad = enc.encode('{"code": "BASE_TYPE_MAX_LENGTH", "message": "Must be 2000 or fewer in length."}, '.repeat(12));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      // An answer that never ends: only what the reader asks for is produced.
      pull(c) { const chunk = pulled === 0 ? head : pad; pulled += chunk.length; c.enqueue(chunk); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }), { status: 400, headers: { 'content-type': 'application/json' } })));
    const db = testD1();
    configureAlerts(KEY);
    const post: ForumPost = { id: 990201, topicId: 1, topicTitle: 't', topicSlug: 't', postNumber: 2, url: 'https://forum.namada.net/t/t/1/2', username: 'u',
      displayName: null, avatarUrl: null, createdAt: new Date(NOW).toISOString(), excerpt: 'e', isNewTopic: false };
    await sendDiscordForumAlert(HOOK, post, db as any);
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThanOrEqual(4096 + pad.length);
    expect(skippedRow(db)).toMatchObject({ total: 1, last: { what: 'forum post 990201 (1 refused by Discord)', n: 1 } });
  });
});
