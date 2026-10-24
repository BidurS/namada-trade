// Security review (2026-10-22), a channel saved on while its connection notice did not reach it: when Discord answers
// the notice nothing against the link (no answer, a 5xx, a 429 of shared or global scope), the save keeps the channel
// on with a note, and no later answer turned such a row off. A webhook made in a forum channel, which answers 400 to
// every post, saved during such a blip, kept a channel place for good with no post ever reaching it, and so did a link
// no alert was ever sent to. Such a row is now on trial: the first answer of the dispatcher or of the Settings test
// post that blames the link (a 400 that is not Invalid Form Body, a 401, 403 or 404 in Discord's own words, or a 429 of
// user scope counted toward the hold) turns it off, the cron's tick posts the notice again to one no post reached
// within a day (once a day, turning it off when Discord refuses it, or after three days of answers that say nothing
// either), and a row whose first post Discord takes is proven and keeps its place. A save that keeps the channel on
// with the same link posts nothing and keeps the note, so the trial cannot be left by saving again. Fetch is stubbed:
// nothing reaches Discord.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { testD1, type TestD1 } from './d1-sqlite';
import { placeCount, linkProven, readDeliverable, hookOkStmt, stopChannelStmt, loadSettings, NOTICE_TRIAL_MS, type StoredSettings } from '../worker/src/settings';
import { configureAlerts, sendDiscordWhaleAlert } from '../worker/src/sources/discord';
import { app } from '../worker/src/api';
import { runCron } from '../worker/src/cron';
import { createSession, type Session } from '../worker/src/auth';
import { deliveryView } from '../web/src/screens/settings/delivery';
import type { Flow } from '../shared/types';

const KEY = 'DQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0=';
const DAY = 86_400_000;
const HOUR = 3_600_000;
let t = 0;
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const addr = (tag: string, i: number) => `tnam1q${tag}${String(i).padStart(5, '0')}${'q'.repeat(30)}`;
const env = (db: TestD1, extra: Record<string, unknown> = {}) => ({ DB: db, SETTINGS_KEY: KEY, ...extra }) as any;
const put = (db: TestD1, s: Session, body: unknown) =>
  app.request('/api/me/settings', { method: 'PUT', headers: { Authorization: `Bearer ${s.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }, env(db));
const view = async (db: TestD1, s: Session) => ((await (await app.request('/api/me/settings', { headers: { Authorization: `Bearer ${s.token}` } }, env(db))).json()) as any).settings.channels.discord;
const testPost = (db: TestD1, s: Session) => app.request('/api/me/settings/test', { method: 'POST', headers: { Authorization: `Bearer ${s.token}` } }, env(db));
const SELLER = 'osmo1sellerxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const bigSell = (n: number): Flow => ({ id: `osmosis:NT${n}:0`, chain: 'osmosis', height: n, ts: t, txHash: `NT${n}`, kind: 'sell', from: SELLER, to: null, amount: 20_000, meta: null }) as unknown as Flow;
/** The default rules with the big swap rule at 10,000 NAM: a 20,000 NAM sell matches. */
const bigSwaps = { rules: { big_swap: { on: true, thresholdNam: 10_000 } } };
/** Every rule, the watchlist and forum alerts off: no alert is ever posted to such a row. */
const allOff = { rules: { big_swap: { on: false }, ibc_inventory: { on: false }, unlock: { on: false }, unshield: { on: false }, bond: { on: false } }, watchlistOn: false, forumAndGov: false };
const sharedLimit = () => new Response(JSON.stringify({ message: 'You are being rate limited.', retry_after: 2, global: false }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '2', 'x-ratelimit-scope': 'shared' } });
const unavailable = () => new Response('<html>503</html>', { status: 503 });
const forumChannel = () => new Response(JSON.stringify({ message: 'Webhooks posted to forum channels must have a thread_name or thread_id', code: 220001 }), { status: 400, headers: { 'content-type': 'application/json' } });
const gone = () => new Response(JSON.stringify({ message: 'Unknown Webhook', code: 10015 }), { status: 404, headers: { 'content-type': 'application/json' } });
const ok = () => new Response(null, { status: 204 });
/** Discord as a stub: `answer` decides each post's answer by link; every other request of the cron's tick is answered 404. */
function network(answer: (url: string) => Response) {
  const posts: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (u: string) => {
    const url = String(u);
    if (url.startsWith('https://discord.com/api/webhooks/')) { posts.push(url); return answer(url); }
    return new Response('not here', { status: 404 });
  }));
  return { posts, to: (url: string) => posts.filter((p) => p === url).length };
}
function clock() {
  const db = testD1();
  t = Date.UTC(2026, 9, 23, 9);
  vi.spyOn(Date, 'now').mockImplementation(() => t);
  configureAlerts(KEY, true);
  return db;
}
const signIn = async (db: TestD1, address: string) => (await createSession(db as any, address, 'namada', 'namada')) as Session;

describe('Security review (2026-10-22), a channel saved on while its connection notice did not reach it is on trial', () => {
  it('a forum-channel webhook (400 220001 to every post) saved while Discord answered the notice a 429 of shared scope is turned off at the first alert\'s answer, gives its place up, and the Settings page says why', { timeout: 60_000 }, async () => {
    const db = clock();
    const FORUM = 'https://discord.com/api/webhooks/9150/forumsquat';
    let atSave = true;
    const d = network(() => (atSave ? sharedLimit() : forumChannel()));
    const me = await signIn(db, addr('fsq', 0));
    const r = await put(db, me, { notifications: bigSwaps, channels: { discord: { enabled: true, webhookUrl: FORUM } } });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).settings.channels.discord).toMatchObject({ enabled: true, stopped: null, notice: { status: 429, at: t } });
    expect(await placeCount(db as any)).toBe(1);
    const savedAt = t;
    atSave = false;
    // The first alert the row's rules match: Discord refuses the post (the link's own 400), and the trial ends.
    t += HOUR;
    await sendDiscordWhaleAlert(undefined, bigSell(1), db as any, 1e9);
    expect(d.to(FORUM)).toBe(2);
    expect(await placeCount(db as any), 'a link no post reached holds no place').toBe(0);
    expect((await readDeliverable(db as any, KEY)).users).toEqual([]);
    const v = await view(db, me);
    expect(v).toMatchObject({ enabled: false, notice: null, stopped: { status: 400, at: t, reason: 'notice', savedAt } });
    const page = deliveryView(v);
    expect(page.state).toBe('notice');
    expect(page.notice!.title).toBe('No post has reached this channel');
    expect(page.notice!.text).toContain('Discord answered 400 to a post to it');
    expect(page.switchDisabled).toBe(false);
    // Thirty days of alerts after: nothing is posted to it again, and its place stays free.
    for (let k = 0; k < 120; k++) { t += DAY / 4; await sendDiscordWhaleAlert(undefined, bigSell(100 + k), db as any, 1e9); }
    expect(d.to(FORUM)).toBe(2);
    expect(await placeCount(db as any)).toBe(0);
  });

  it('one no post was ever sent to, saved while Discord answered the notice 503 twice, keeps its place for a day; past it the cron\'s tick posts the notice again, once a day, and turns it off after three days of 503s; a Worker that sends no alerts posts and turns off nothing', { timeout: 120_000 }, async () => {
    const db = clock();
    const QUIET = 'https://discord.com/api/webhooks/9151/neverposted';
    const d = network(() => unavailable());
    const me = await signIn(db, addr('quiet', 0));
    const r = await put(db, me, { notifications: allOff, channels: { discord: { enabled: true, webhookUrl: QUIET } } });
    expect(((await r.json()) as any).settings.channels.discord).toMatchObject({ enabled: true, notice: { status: 503, at: t } });
    expect(d.to(QUIET)).toBe(2);
    const savedAt = t;
    // A day less an hour later: still on.
    t = savedAt + DAY - HOUR;
    await runCron(env(db, { SEND_ALERTS: 'yes' }));
    expect(await placeCount(db as any)).toBe(1);
    // Past the day, on a Worker that sends no alerts (a copy of the database): still on.
    t = savedAt + DAY + HOUR;
    await runCron(env(db));
    expect(await placeCount(db as any)).toBe(1);
    expect(d.to(QUIET), 'a Worker that sends no alerts posted nothing').toBe(2);
    // Past the day, on the Worker that sends alerts: the notice is posted again, and the trial goes on.
    t += 60_000;
    await runCron(env(db, { SEND_ALERTS: 'yes' }));
    expect(d.to(QUIET), 'the tick posted the notice once').toBe(3);
    expect(await placeCount(db as any)).toBe(1);
    // Two more days of such answers: turned off, visibly.
    for (let k = 0; k < 2; k++) { t += DAY + 60_000; await runCron(env(db, { SEND_ALERTS: 'yes' })); }
    expect(d.to(QUIET)).toBe(5);
    expect(await placeCount(db as any)).toBe(0);
    const v = await view(db, me);
    expect(v).toMatchObject({ enabled: false, notice: null, stopped: { status: 503, reason: 'notice', savedAt, tries: 3 } });
    expect(deliveryView(v).notice!.text).toContain('the notice was posted again on 3 days and did not reach it either');
    expect(NOTICE_TRIAL_MS).toBe(DAY);
  });

  it('an honest link saved during the same blip is proven by its first post and keeps its place: the note goes and the cron\'s tick leaves it on', { timeout: 120_000 }, async () => {
    const db = clock();
    const HONEST = 'https://discord.com/api/webhooks/9152/honesttrial';
    let answer = unavailable;
    const d = network(() => answer());
    const me = await signIn(db, addr('honest', 0));
    const r = await put(db, me, { notifications: bigSwaps, channels: { discord: { enabled: true, webhookUrl: HONEST } } });
    expect(((await r.json()) as any).settings.channels.discord).toMatchObject({ enabled: true, notice: { status: 503 } });
    answer = ok;
    t += HOUR;
    await sendDiscordWhaleAlert(undefined, bigSell(500), db as any, 1e9);
    expect(d.to(HONEST)).toBe(3);
    expect(await linkProven(db as any, KEY, addr('honest', 0), HONEST)).toBe(true);
    expect(await view(db, me)).toMatchObject({ enabled: true, stopped: null, notice: null });
    t += DAY + HOUR;
    await runCron(env(db, { SEND_ALERTS: 'yes' }));
    expect(await placeCount(db as any)).toBe(1);
    expect(await view(db, me)).toMatchObject({ enabled: true, stopped: null, notice: null });
    // Its later posts go as any proven link's.
    t += HOUR;
    await sendDiscordWhaleAlert(undefined, bigSell(501), db as any, 1e9);
    expect(d.to(HONEST)).toBe(4);
  });

  it('the Settings test post that Discord refuses ends the trial as an alert would; saving again with the channel on and the same link keeps the note and the day it counts from', { timeout: 120_000 }, async () => {
    const db = clock();
    const GONE = 'https://discord.com/api/webhooks/9153/gonetrial', FORUM = 'https://discord.com/api/webhooks/9154/forumtrial';
    let atSave = true;
    network((url) => (atSave ? unavailable() : url === GONE ? gone() : forumChannel()));
    const a = await signIn(db, addr('tgone', 0)), b = await signIn(db, addr('tforum', 0));
    await put(db, a, { notifications: allOff, channels: { discord: { enabled: true, webhookUrl: GONE } } });
    const savedB = t;
    await put(db, b, { notifications: allOff, channels: { discord: { enabled: true, webhookUrl: FORUM } } });
    expect(await placeCount(db as any)).toBe(2);
    atSave = false;
    // The owner of the first link sends a test: Discord says the webhook is gone, and the channel is turned off as
    // the dispatcher turns a dead link off.
    t += 31_000;
    expect(await (await testPost(db, a)).json()).toEqual({ success: false });
    expect(await view(db, a)).toMatchObject({ enabled: false, notice: null, stopped: { status: 404 } });
    expect(await placeCount(db as any)).toBe(1);
    // The owner of the second saves again with the channel on and the same link: nothing is posted, the note stays.
    const again = await put(db, b, { channels: { discord: { enabled: true, webhookUrl: FORUM } } });
    expect(((await again.json()) as any).settings.channels.discord).toMatchObject({ enabled: true, notice: { status: 503, at: savedB } });
    // A day after the first save the tick posts the notice again, however often it was saved since, and Discord's
    // refusal turns it off.
    t = savedB + DAY + 60_000;
    await runCron(env(db, { SEND_ALERTS: 'yes' }));
    expect(await view(db, b)).toMatchObject({ enabled: false, notice: null, stopped: { status: 400, at: t, reason: 'notice', savedAt: savedB } });
    expect(await placeCount(db as any)).toBe(0);
  });

  it('a stop that ends a trial writes only while the row still records no successful post: a success another isolate recorded meanwhile keeps the channel on', { timeout: 60_000 }, async () => {
    const db = clock();
    const RACE = 'https://discord.com/api/webhooks/9155/racetrial';
    network(() => unavailable());
    const me = await signIn(db, addr('race', 0));
    await put(db, me, { notifications: allOff, channels: { discord: { enabled: true, webhookUrl: RACE } } });
    const row = (await loadSettings(db as any, KEY, addr('race', 0))) as StoredSettings;
    expect(row.channels.discord.notice).toBeTruthy();
    const stop = await stopChannelStmt(db as any, KEY, row, 400, t, 'notice');
    await hookOkStmt(db as any, KEY, row.address, RACE, t).run();
    const res = await stop.run();
    expect(Number(res.meta?.changes ?? 0)).toBe(0);
    expect(await placeCount(db as any)).toBe(1);
    t += DAY + HOUR;
    await runCron(env(db, { SEND_ALERTS: 'yes' }));
    expect(await placeCount(db as any)).toBe(1);
  });
});
