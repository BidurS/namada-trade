// Security review (2026-10-22), what a wallet is told when its post must wait: a wallet whose connection notice went
// out past the spent test budget on a fresh row's allowance (and was taken) was told at its next save that Discord
// had answered its link invalid, since the wait for the window was stored without its reason; and a link in a short
// Retry-After pause (several wallets of one community saving the same shared link within two seconds, one notice
// answered 429) was answered as a link that failed or is gone, for a two-second pause. The reason now travels with
// the wait, a Retry-After pause is said as a short pause, and a link held for the window because Discord answered
// every post to it rate-limited for a while is said as that. Fetch is stubbed: nothing reaches Discord.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { testD1, type TestD1 } from './d1-sqlite';
import { defaultPrefs, type StoredSettings } from '../worker/src/settings';
import { configureAlerts, sendDiscordWhaleAlert, INVALID_WINDOW_MS, RATE_LIMITED_HOLD_AFTER, TEST_INVALID_BUDGET } from '../worker/src/sources/discord';
import { app, SAVE_LINK_SHORT_PAUSE, TEST_LINK_SHORT_PAUSE, SAVE_LINK_RATE_LIMITED, TEST_LINK_RATE_LIMITED, SAVE_LINK_PAUSED, testWalletOver, testWalletWaits } from '../worker/src/api';
import { createSession, type Session } from '../worker/src/auth';
import type { Flow } from '../shared/types';

const KEY = 'Dg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4=';
const WATCHED = 'osmo1yl6hdjhmkf37639730gffanpzndzdpmhxy9ep3';
const link = (tag: string) => `https://discord.com/api/webhooks/9300/${tag}`;
let t = 0;

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const addr = (tag: string) => `tnam1q${tag}${'q'.repeat(39 - tag.length)}`;
const env = (db: TestD1) => ({ DB: db, SETTINGS_KEY: KEY }) as any;
const put = (db: TestD1, s: Session, body: unknown) =>
  app.request('/api/me/settings', { method: 'PUT', headers: { Authorization: `Bearer ${s.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }, env(db));
const testPost = (db: TestD1, s: Session) =>
  app.request('/api/me/settings/test', { method: 'POST', headers: { Authorization: `Bearer ${s.token}` } }, env(db));
const error = async (r: Response) => ((await r.json()) as any).error as string;
const signIn = async (db: TestD1, address: string) => (await createSession(db as any, address, 'namada', 'namada')) as Session;
const watchOnly = { rules: { big_swap: { on: false }, ibc_inventory: { on: false }, unlock: { on: false }, unshield: { on: false }, bond: { on: false } }, watchlist: [WATCHED], watchlistOn: true, forumAndGov: false };
const moveFromWatched = (n: number): Flow => ({ id: `osmosis:WW${n}:0`, chain: 'osmosis', height: n, ts: t, txHash: `WW${n}`, kind: 'sell', from: WATCHED, to: null, amount: 500, meta: null }) as unknown as Flow;
const rateLimited = (sec: number, scope = 'user') => new Response(JSON.stringify({ message: 'You are being rate limited.', retry_after: sec, global: false }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': String(sec), 'x-ratelimit-scope': scope } });
/** Discord as a stub: `answer` decides each post's answer; every post's link is kept. */
function discord(answer: (url: string) => Response = () => new Response(null, { status: 204 })) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (u: string) => { calls.push(String(u)); return answer(String(u)); }));
  return { calls, to: (url: string) => calls.filter((c) => c === url).length };
}
function clock() {
  const db = testD1();
  t = Date.UTC(2026, 9, 23, 9); // the start of a 10-minute window
  vi.spyOn(Date, 'now').mockImplementation(() => t);
  configureAlerts(KEY);
  return db;
}

describe('Security review (2026-10-22), the reason a wallet waits travels with the wait', () => {
  it('a wallet whose notice went out past the spent test budget is told the budget is spent and its link is not at fault, by the save and by the test button', async () => {
    const db = clock();
    // The test posts' budget is spent for this window (a wave of made-up links from other wallets).
    db.raw.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('alerts.invalid.test', ?, ?)").run(JSON.stringify({ w: Math.floor(t / INVALID_WINDOW_MS), n: TEST_INVALID_BUDGET }), t);
    const d = discord();
    const me = await signIn(db, addr('over'));
    // A fresh row's notice goes once past the budget: Discord takes it and the channel is on.
    const first = await put(db, me, { notifications: watchOnly, channels: { discord: { enabled: true, webhookUrl: link('over1') } } });
    expect(first.status).toBe(200);
    expect(((await first.json()) as any).settings.channels.discord).toMatchObject({ enabled: true, stopped: null });
    expect(d.to(link('over1'))).toBe(1);
    // Within the window the wallet saves a second link, and presses the test button: both wait for the window, and the
    // words say why, never that the link was answered invalid.
    t += 31_000;
    const second = await put(db, me, { channels: { discord: { enabled: true, webhookUrl: link('over2') } } });
    expect(second.status).toBe(429);
    const words = await error(second);
    expect(words).toBe(testWalletOver(10));
    expect(words).not.toMatch(/invalid/);
    expect(words).toMatch(/not at fault/);
    const tp = await testPost(db, me);
    expect(tp.status).toBe(429);
    expect(await error(tp)).toBe(testWalletOver(10));
    expect(d.calls).toHaveLength(1);
    // A wallet whose notice was answered invalid is still told so.
    const other = await signIn(db, addr('invalid'));
    d.calls.length = 0;
    vi.stubGlobal('fetch', vi.fn(async () => rateLimited(2)));
    expect((await put(db, other, { channels: { discord: { enabled: true, webhookUrl: link('bad') } } })).status).toBe(200);
    t += 31_000;
    const again = await put(db, other, { channels: { discord: { enabled: true, webhookUrl: link('bad2') } } });
    expect(again.status).toBe(429);
    expect(await error(again)).toBe(testWalletWaits(9));
  });

  it('a link in a short Retry-After pause: another wallet saving the same link is asked to try again in a few seconds, and so is the test button; the link is not blamed', async () => {
    const db = clock();
    const SHARED = link('shared');
    let answer = () => new Response(null, { status: 204 });
    const d = discord(() => answer());
    const a = await signIn(db, addr('commone'));
    expect((await put(db, a, { notifications: watchOnly, channels: { discord: { enabled: true, webhookUrl: SHARED } } })).status).toBe(200);
    // An alert's post to the link is answered 429 with a two-second Retry-After: the link is paused here that long.
    answer = () => rateLimited(2);
    t += 60_000;
    await sendDiscordWhaleAlert(undefined, moveFromWatched(1), null, db as any, 10000);
    expect(d.to(SHARED)).toBe(2);
    // A second wallet of the community saves the same link within the pause.
    const b = await signIn(db, addr('commtwo'));
    const paused = await put(db, b, { channels: { discord: { enabled: true, webhookUrl: SHARED } } });
    expect(paused.status).toBe(429);
    const pausedWords = await error(paused);
    expect(pausedWords).toBe(SAVE_LINK_SHORT_PAUSE);
    expect(pausedWords).not.toBe(SAVE_LINK_PAUSED);
    // The first wallet's test button, within the pause.
    const tp = await testPost(db, a);
    expect(tp.status).toBe(429);
    expect(await error(tp)).toBe(TEST_LINK_SHORT_PAUSE);
    expect(d.to(SHARED)).toBe(2); // nothing was posted during the pause
    // After the pause, the second wallet's save goes.
    answer = () => new Response(null, { status: 204 });
    t += 3_000;
    expect((await put(db, b, { channels: { discord: { enabled: true, webhookUrl: SHARED } } })).status).toBe(200);
    expect(d.to(SHARED)).toBe(3);
  });

  it('a link Discord answered rate-limited to every post for a while is held for the window, and the save and the test button say so', async () => {
    const db = clock();
    const BUSY = link('busy');
    let answer = () => new Response(null, { status: 204 });
    const d = discord(() => answer());
    const a = await signIn(db, addr('busyone'));
    expect((await put(db, a, { notifications: watchOnly, channels: { discord: { enabled: true, webhookUrl: BUSY } } })).status).toBe(200);
    // Every alert's post is answered 429, each after the last pause ended: at the third in a row the link is held.
    answer = () => rateLimited(2);
    for (let i = 0; i < RATE_LIMITED_HOLD_AFTER; i++) {
      t += 60_000;
      await sendDiscordWhaleAlert(undefined, moveFromWatched(10 + i), null, db as any, 10000);
    }
    expect(d.to(BUSY)).toBe(1 + RATE_LIMITED_HOLD_AFTER);
    t += 60_000;
    await sendDiscordWhaleAlert(undefined, moveFromWatched(20), null, db as any, 10000);
    expect(d.to(BUSY)).toBe(1 + RATE_LIMITED_HOLD_AFTER); // held: not posted
    const b = await signIn(db, addr('busytwo'));
    const held = await put(db, b, { channels: { discord: { enabled: true, webhookUrl: BUSY } } });
    expect(held.status).toBe(429);
    expect(await error(held)).toBe(SAVE_LINK_RATE_LIMITED);
    const tp = await testPost(db, a);
    expect(tp.status).toBe(429);
    expect(await error(tp)).toBe(TEST_LINK_RATE_LIMITED);
    expect(d.to(BUSY)).toBe(1 + RATE_LIMITED_HOLD_AFTER);
  });
});

/** Unused import guard: the settings shape the tests save through the API. */
export type { StoredSettings };
export { defaultPrefs };
