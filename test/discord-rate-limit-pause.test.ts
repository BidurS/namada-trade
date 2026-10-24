// Security review (2026-10-22), an honest hook's rate limits: Discord limits each webhook to a few posts every couple
// of seconds and answers 429 with Retry-After past it. The dispatcher waited out the Retry-After, but it also counted
// each such 429 as an invalid answer of the hook and, at the third in a ten-minute window, left the hook alone until
// that window ended, whatever its Retry-After said, so a subscriber whose watched address made a few quick runs of
// moves lost every alert for the rest of the window, each one already claimed. A user's 429 is now a pause for its
// Retry-After only: it counts toward neither the per-window hold nor BACKOFF_AFTER (those stay for 401, 403 and 404).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { base64 } from '@scure/base';
import { testD1 } from './d1-sqlite';
import type { StoredSettings } from '../worker/src/settings';
import type { Flow } from '../shared/types';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const KEY = base64.encode(new Uint8Array(32).fill(5));
const WINDOW = 10 * 60_000;
const SUB = 'https://discord.com/api/webhooks/401/honest';
const WATCHED = 'osmo1yl6hdjhmkf37639730gffanpzndzdpmhxy9ep3';

/** Discord's per-webhook bucket as a stub: 5 posts in any 2 s, then 429 with Retry-After (whole seconds) and scope user. */
function bucket() {
  const accepted: number[] = [];
  const posts: { at: number; status: number }[] = [];
  vi.stubGlobal('fetch', vi.fn(async () => {
    const now = Date.now();
    const recent = accepted.filter((t) => t > now - 2000);
    if (recent.length >= 5) {
      const sec = Math.ceil((recent[0] + 2000 - now) / 1000);
      posts.push({ at: now, status: 429 });
      return new Response(JSON.stringify({ message: 'You are being rate limited.', retry_after: sec, global: false }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': String(sec), 'x-ratelimit-scope': 'user' } });
    }
    accepted.push(now);
    posts.push({ at: now, status: 204 });
    return new Response(null, { status: 204 });
  }));
  return posts;
}

describe('Security review (2026-10-22), an honest hook that Discord rate limits now and then', () => {
  it('is posted again once its Retry-After has passed, not held to the end of the window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const T0 = (Math.floor(Date.now() / WINDOW) + 1) * WINDOW + 1000;
    vi.setSystemTime(T0);
    vi.resetModules();
    const d = await import('../worker/src/sources/discord');
    const s = await import('../worker/src/settings');
    d.configureAlerts(KEY);
    const db = testD1();
    const p = s.defaultPrefs();
    p.watchlistOn = true;
    p.watchlist = [WATCHED];
    const u: StoredSettings = { address: `tnam1qwatcher${'q'.repeat(32)}`, notifications: p, channels: { discord: { enabled: true, webhookUrl: SUB } }, createdAt: T0 - 5 * 86400000, updatedAt: T0 - 5 * 86400000 };
    await s.saveSettings(db as any, KEY, u);
    const posts = bucket();
    let seq = 0;
    const move = (): Flow => { seq++; return { id: `osmosis:RL${seq}:0`, chain: 'osmosis', height: seq, ts: Date.now(), txHash: `RL${seq}`, kind: 'sell', from: WATCHED, to: null, amount: 500, meta: null } as Flow; };

    // Three runs of ten moves from the watched address, 250 ms apart, two minutes between runs.
    for (let run = 0; run < 3; run++) {
      for (let k = 0; k < 10; k++) {
        vi.setSystemTime(T0 + run * 120_000 + k * 250);
        await d.sendDiscordWhaleAlert(undefined, move(), null, db as any, 10000);
      }
    }
    const before = posts.length;
    // A minute after the last run: Discord's bucket is long since empty.
    vi.setSystemTime(T0 + 2 * 120_000 + 60_000);
    await d.sendDiscordWhaleAlert(undefined, move(), null, db as any, 10000);
    expect(posts.length - before).toBe(1);
  });
});
