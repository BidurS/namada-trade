// Security review (2026-10-22), a Discord link is proven when it is saved: the save that turned a link on posted
// nothing to it, so a link held its place on a day's grace for a first test post, and an honest subscriber who saved
// a working link through the Settings page, was told alerts now go to the channel, and pressed no test button was
// turned off by the cron's sweep after one quiet day and heard nothing when the move came (the code deployed before
// the grace never turned a channel off); and a made-up link held a place for a day, a new one each day, so a wallet
// could hold places for good without a post ever reaching any of its links. The save now posts the connection notice
// (the test post's body) to a link it turns on, inside the request, under the test posts' budget and the wallet's
// cooldown: Discord taking it turns the channel on and records the success (okAt); an answer that blames the link (it
// is gone, its token is wrong, a 400, a 429 of user scope) saves the channel off and says why beside the switch, which
// posts the notice again; and an answer that says nothing of the link (no answer, a 5xx, a 429 of shared scope) has
// the notice posted once more after a short wait, and when that fails too the channel is saved on with a note that the
// notice has not reached it, so a Discord blip at the save costs the subscriber nothing (the dispatcher's first post,
// or the owner's test, proves or stops the link as any other). There is no grace, no sweep and no test-first refusal:
// a row with Discord on is a link that took a post, or one that answered nothing against itself twice; it holds its
// place for good, and a made-up link holds nothing. The Settings test button is a plain re-check. Fetch is stubbed:
// nothing reaches Discord. Each case uses links of its own: the dispatcher remembers a link's answers across the cases
// of one file.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { testD1, type TestD1 } from './d1-sqlite';
import { saveSettings, deleteSettings, placeCount, linkProven, readDeliverable, defaultPrefs, DELIVERABLE_MAX, CHANNELS_FULL, type StoredSettings } from '../worker/src/settings';
import { configureAlerts, sendDiscordWhaleAlert, TEST_INVALID_BUDGET } from '../worker/src/sources/discord';
import { app, SAVE_ALERTS_OFF, SAVE_LINK_PAUSED } from '../worker/src/api';
import { createSession, type Session } from '../worker/src/auth';
import type { Flow } from '../shared/types';

const KEY = 'DQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0=';
const DAY = 86_400_000;
const WATCHED = 'osmo1yl6hdjhmkf37639730gffanpzndzdpmhxy9ep3';
const SELLER = 'osmo1sellerxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const link = (tag: string) => `https://discord.com/api/webhooks/9100/${tag}`;
const madeUp = (i: number, day: number) => `https://discord.com/api/webhooks/${9200000 + i}/madeup${i}day${day}`;
let t = 0;

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const addr = (tag: string, i: number) => `tnam1q${tag}${String(i).padStart(5, '0')}${'q'.repeat(30)}`;
const env = (db: TestD1) => ({ DB: db, SETTINGS_KEY: KEY }) as any;
const put = (db: TestD1, s: Session, body: unknown) =>
  app.request('/api/me/settings', { method: 'PUT', headers: { Authorization: `Bearer ${s.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }, env(db));
const get = async (db: TestD1, s: Session) => ((await (await app.request('/api/me/settings', { headers: { Authorization: `Bearer ${s.token}` } }, env(db))).json()) as any).settings;
const testPost = (db: TestD1, s: Session) =>
  app.request('/api/me/settings/test', { method: 'POST', headers: { Authorization: `Bearer ${s.token}` } }, env(db));
/** Every rule, the watchlist and forum alerts off: nothing is ever posted to such a row by an alert. */
const allOff = { rules: { big_swap: { on: false }, ibc_inventory: { on: false }, unlock: { on: false }, unshield: { on: false }, bond: { on: false } }, watchlistOn: false, forumAndGov: false };
/** A subscriber who only wants to hear when one quiet address moves. */
const watchOnly = { rules: allOff.rules, watchlist: [WATCHED], watchlistOn: true, forumAndGov: false };
const moveFromWatched = (n: number): Flow => ({ id: `osmosis:QUIET${n}:0`, chain: 'osmosis', height: n, ts: t, txHash: `QUIET${n}`, kind: 'sell', from: WATCHED, to: null, amount: 500, meta: null }) as unknown as Flow;
const bigSell = (n: number): Flow => ({ id: `osmosis:BIG${n}:0`, chain: 'osmosis', height: n, ts: t, txHash: `BIG${n}`, kind: 'sell', from: SELLER, to: null, amount: 20_000, meta: null }) as unknown as Flow;
const gone = () => new Response(JSON.stringify({ message: 'Unknown Webhook', code: 10015 }), { status: 404, headers: { 'content-type': 'application/json' } });
const rateLimited = (sec: number, scope: 'user' | 'shared') => new Response(JSON.stringify({ message: 'You are being rate limited.', retry_after: sec, global: false }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': String(sec), 'x-ratelimit-scope': scope } });
/** A webhook made in a forum channel: Discord answers 400 to every post that names no thread. */
const forumChannel = () => new Response(JSON.stringify({ message: 'Webhooks posted to forum channels must have a thread_name or thread_id', code: 220001 }), { status: 400, headers: { 'content-type': 'application/json' } });
/** Discord as a stub: `answer` decides each post's answer; every post's link and body are kept. */
function discord(answer: (url: string) => Response | Promise<Response> = () => new Response(null, { status: 204 })) {
  const calls: { url: string; title: string }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    calls.push({ url: String(u), title: String(body.embeds?.[0]?.title ?? '') });
    return answer(String(u));
  }));
  return { calls, to: (url: string) => calls.filter((c) => c.url === url).length };
}
async function sessions(db: TestD1, tag: string, n: number) {
  const out: Session[] = [];
  for (let i = 0; i < n; i++) out.push((await createSession(db as any, addr(tag, i), 'namada', 'namada')) as Session);
  return out;
}
const signIn = async (db: TestD1, address: string) => (await createSession(db as any, address, 'namada', 'namada')) as Session;
function clock() {
  const db = testD1();
  t = Date.UTC(2026, 9, 23, 9);
  vi.spyOn(Date, 'now').mockImplementation(() => t);
  configureAlerts(KEY);
  return db;
}
/** A row with Discord on, saved as the dispatcher's own tests save them (not through the API). */
const active = (address: string, webhookUrl: string): StoredSettings => {
  const n = defaultPrefs();
  n.rules.big_swap = { on: true, thresholdNam: 1 };
  return { address, notifications: n, channels: { discord: { enabled: true, webhookUrl } }, createdAt: t, updatedAt: t };
};

describe('Security review (2026-10-22), a link is proven by the save that turns it on', () => {
  it('an honest watcher of one quiet address saves a working link and nothing else: the save posts the connection notice, the channel is on, and the move three days later reaches it', { timeout: 60_000 }, async () => {
    const db = clock();
    const HONEST = link('honest');
    const d = discord();
    const honest = await signIn(db, addr('hon', 0));
    // The page's save: the link with sending on, and nothing else. The notice is posted inside the request.
    const saved = await put(db, honest, { notifications: watchOnly, channels: { discord: { enabled: true, webhookUrl: HONEST } } });
    expect(saved.status).toBe(200);
    expect(d.calls).toEqual([{ url: HONEST, title: 'Discord channel connected' }]);
    const view = ((await saved.json()) as any).settings.channels.discord;
    expect(view).toMatchObject({ enabled: true, hasUrl: true, stopped: null });
    expect(await linkProven(db as any, KEY, addr('hon', 0), HONEST)).toBe(true);
    expect(await placeCount(db as any)).toBe(1);
    // A quiet day, then two more, with no test post and no cron sweep to run: the channel stays on and holds its place.
    t += 3 * DAY;
    expect((await get(db, honest)).channels.discord.enabled).toBe(true);
    expect((await readDeliverable(db as any, KEY)).users.map((u) => u.address)).toEqual([addr('hon', 0)]);
    await sendDiscordWhaleAlert(undefined, moveFromWatched(1), null, db as any, 10000);
    expect(d.to(HONEST)).toBe(2); // the notice, then the move
  });

  it('a subscriber on the default rules saves only the link: a day with nothing over a default threshold changes nothing, and the first 20,000 NAM sell reaches the channel', { timeout: 60_000 }, async () => {
    const db = clock();
    const DEFAULTS = link('defaults');
    const d = discord();
    const sub = await signIn(db, addr('def', 0));
    expect((await put(db, sub, { channels: { discord: { enabled: true, webhookUrl: DEFAULTS } } })).status).toBe(200);
    expect(d.to(DEFAULTS)).toBe(1);
    t += 2 * DAY;
    await sendDiscordWhaleAlert(undefined, bigSell(1), null, db as any, 10000);
    expect(d.to(DEFAULTS)).toBe(2);
  });

  it('made-up links hold no place: 500 identities save links Discord says are gone, each is saved with sending off and the reason, and a newcomer is admitted the same minute, on every day (the grace per row falls away with the grace)', { timeout: 120_000 }, async () => {
    const db = clock();
    const newcomer = (day: number) => link(`newcomer${day}`);
    const d = discord((url) => (url.includes('/newcomer') ? new Response(null, { status: 204 }) : gone()));
    const answers: { status: number; enabled: boolean; stopped: unknown }[] = [];
    const newcomers: number[] = [];
    for (let day = 0; day < 3; day++) {
      t = Date.UTC(2026, 9, 23, 9) + day * DAY;
      // One PUT per identity, a new made-up link each day: the notice is answered 404, so the row is saved with the
      // channel off and Discord's answer, and no place is taken, today or any day.
      const squatters = await sessions(db, 'sq', DELIVERABLE_MAX);
      for (let i = 0; i < squatters.length; i++) {
        t += 1;
        const r = await put(db, squatters[i], { notifications: allOff, channels: { discord: { enabled: true, webhookUrl: madeUp(i, day) } } });
        const v = ((await r.json()) as any).settings?.channels.discord;
        answers.push({ status: r.status, enabled: v?.enabled, stopped: v?.stopped });
      }
      expect(await placeCount(db as any)).toBe(day); // the newcomers of the earlier days only
      t += 60_000;
      const nc = await put(db, await signIn(db, addr('nc', day)), { notifications: { forumAndGov: true }, channels: { discord: { enabled: true, webhookUrl: newcomer(day) } } });
      newcomers.push(nc.status);
      expect(((await nc.json()) as any).settings.channels.discord.enabled).toBe(true);
    }
    expect(answers.every((a) => a.status === 200 && a.enabled === false)).toBe(true);
    expect(answers[0].stopped).toEqual({ status: 404, at: Date.UTC(2026, 9, 23, 9) + 1 });
    expect(newcomers).toEqual([200, 200, 200]);
    // Each made-up link was posted to once (the notice), and each newcomer's link once: 500 invalid answers a day spend
    // the test posts' budget for the window, which a row saved today posts past once.
    expect(d.calls.filter((c) => !c.url.includes('/newcomer'))).toHaveLength(3 * DELIVERABLE_MAX);
    expect(d.calls.filter((c) => c.url.includes('/newcomer'))).toHaveLength(3);
    expect(TEST_INVALID_BUDGET).toBe(DELIVERABLE_MAX);
    expect(await placeCount(db as any)).toBe(3);
  });

  it('a link Discord does not answer at the save (a 5xx, twice) is saved with sending on and a note that the notice has not reached the channel; the first alert proves the link and the note goes; a proven link is not posted to again when switched off and on', { timeout: 60_000 }, async () => {
    const db = clock();
    const SLOW = link('slow');
    let answer = () => new Response('<html>503</html>', { status: 503 });
    const d = discord(() => answer());
    const me = await signIn(db, addr('slow', 0));
    const first = await put(db, me, { notifications: watchOnly, channels: { discord: { enabled: true, webhookUrl: SLOW } } });
    expect(first.status).toBe(200);
    const v1 = ((await first.json()) as any).settings.channels.discord;
    // The notice was posted twice (once more after a short wait) and answered 503 both times: that says nothing of the
    // link, so the channel is on, with the note; the row holds a place and the dispatcher serves it.
    expect(v1).toMatchObject({ enabled: true, hasUrl: true, stopped: null, notice: { status: 503, at: t } });
    expect(d.to(SLOW)).toBe(2);
    expect(await placeCount(db as any)).toBe(1);
    expect(await linkProven(db as any, KEY, addr('slow', 0), SLOW)).toBe(false);
    expect((await get(db, me)).channels.discord).toMatchObject({ enabled: true, stopped: null, notice: { status: 503, at: t } });
    expect((await readDeliverable(db as any, KEY)).users.map((u) => u.address)).toEqual([addr('slow', 0)]);
    // Discord answers again: the move of the watched address reaches the channel, which proves the link, and the note
    // goes from the page.
    answer = () => new Response(null, { status: 204 });
    t += 60_000;
    await sendDiscordWhaleAlert(undefined, moveFromWatched(41), null, db as any, 10000);
    expect(d.to(SLOW)).toBe(3);
    expect(await linkProven(db as any, KEY, addr('slow', 0), SLOW)).toBe(true);
    expect((await get(db, me)).channels.discord).toMatchObject({ enabled: true, stopped: null, notice: null });
    // Off and on again: the link is proven, so nothing is posted and the channel is on.
    expect((await put(db, me, { channels: { discord: { enabled: false } } })).status).toBe(200);
    expect(await placeCount(db as any)).toBe(0);
    const again = await put(db, me, { channels: { discord: { enabled: true } } });
    expect(((await again.json()) as any).settings.channels.discord).toMatchObject({ enabled: true, stopped: null, notice: null });
    expect(d.to(SLOW)).toBe(3);
    expect(await placeCount(db as any)).toBe(1);
    t += 60_000;
    await sendDiscordWhaleAlert(undefined, moveFromWatched(42), null, db as any, 10000);
    expect(d.to(SLOW)).toBe(4);
  });

  it('the notice is posted once more only for an answer that says nothing of the link: no answer at all and a 429 of shared scope save the channel on with the note; a 400 and a 429 of user scope are not tried again and keep the channel off, the latter with the wallet waiting for the window', { timeout: 60_000 }, async () => {
    const db = clock();
    const NONE = link('noanswer'), SHARED = link('sharedlimit'), FORUM = link('forumchannel'), LIMITED = link('userlimit');
    const d = discord((url) => {
      if (url === NONE) throw new TypeError('fetch failed');
      if (url === SHARED) return rateLimited(2, 'shared');
      if (url === FORUM) return forumChannel();
      return rateLimited(2, 'user');
    });
    // No answer at all (the request itself fails): posted twice, saved on with the note (status 0).
    const none = await put(db, await signIn(db, addr('none', 0)), { channels: { discord: { enabled: true, webhookUrl: NONE } } });
    expect(none.status).toBe(200);
    expect(((await none.json()) as any).settings.channels.discord).toMatchObject({ enabled: true, stopped: null, notice: { status: 0, at: t } });
    expect(d.to(NONE)).toBe(2);
    // A 429 of shared scope (Discord's limit on the site's address, not on the link): the second post finds the link in
    // its Retry-After pause and is not made; the first answer stands, and the channel is saved on with the note.
    const shared = await put(db, await signIn(db, addr('shared', 0)), { channels: { discord: { enabled: true, webhookUrl: SHARED } } });
    expect(shared.status).toBe(200);
    expect(((await shared.json()) as any).settings.channels.discord).toMatchObject({ enabled: true, stopped: null, notice: { status: 429, at: t } });
    expect(d.to(SHARED)).toBe(1);
    expect(await placeCount(db as any)).toBe(2);
    // A webhook made in a forum channel answers 400 to every post: that is the link's own, so it is not tried again
    // and the channel stays off (such a row must never hold a place).
    const forum = await put(db, await signIn(db, addr('forum', 0)), { channels: { discord: { enabled: true, webhookUrl: FORUM } } });
    expect(forum.status).toBe(200);
    expect(((await forum.json()) as any).settings.channels.discord).toMatchObject({ enabled: false, stopped: { status: 400, at: t, reason: 'notice' }, notice: null });
    expect(d.to(FORUM)).toBe(1);
    // A 429 of user scope is an invalid answer Discord counts against the site: not tried again, the channel off, and
    // the wallet waits for the next window.
    const wallet = await signIn(db, addr('limited', 0));
    const limited = await put(db, wallet, { channels: { discord: { enabled: true, webhookUrl: LIMITED } } });
    expect(limited.status).toBe(200);
    expect(((await limited.json()) as any).settings.channels.discord).toMatchObject({ enabled: false, stopped: { status: 429, at: t, reason: 'notice' }, notice: null });
    expect(d.to(LIMITED)).toBe(1);
    t += 31_000;
    const wait = await put(db, wallet, { channels: { discord: { enabled: true } } });
    expect(wait.status).toBe(429);
    expect(((await wait.json()) as any).error).toMatch(/answered that the link tested last from this wallet is invalid/);
    expect(await placeCount(db as any)).toBe(2);
  });

  it('a link Discord says is gone at the save is saved with sending off and the answer, as the dispatcher records it; the same link is paused here and cannot be turned on, a new link can', { timeout: 60_000 }, async () => {
    const db = clock();
    const DEAD = link('dead'), NEXT = link('next');
    const d = discord((url) => (url === NEXT ? new Response(null, { status: 204 }) : gone()));
    const me = await signIn(db, addr('dead', 0));
    const r = await put(db, me, { channels: { discord: { enabled: true, webhookUrl: DEAD } } });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).settings.channels.discord).toMatchObject({ enabled: false, hasUrl: true, stopped: { status: 404, at: t } });
    expect(await placeCount(db as any)).toBe(0);
    // The switch: the link is paused here for a day (Discord asked that a gone webhook not be posted again), so nothing
    // is posted and nothing saved; the page keeps the switch off for a dead link and asks for a new one.
    t += 11 * 60_000;
    const on = await put(db, me, { channels: { discord: { enabled: true } } });
    expect(on.status).toBe(429);
    expect(((await on.json()) as any).error).toBe(SAVE_LINK_PAUSED);
    expect(d.to(DEAD)).toBe(1);
    expect((await get(db, me)).channels.discord).toMatchObject({ enabled: false, stopped: { status: 404 } });
    // A new link goes.
    const next = await put(db, me, { channels: { discord: { enabled: true, webhookUrl: NEXT } } });
    expect(((await next.json()) as any).settings.channels.discord).toMatchObject({ enabled: true, stopped: null });
    expect(d.to(NEXT)).toBe(1);
  });

  it('every channel taken: the save answers 409 CHANNELS_FULL with nothing posted, the row is saved with the channel off, and turning sending on once a place is free posts the notice then', { timeout: 60_000 }, async () => {
    const db = clock();
    const LATE = link('late');
    const d = discord();
    for (let i = 0; i < DELIVERABLE_MAX; i++) { t += 1; expect(await saveSettings(db as any, KEY, active(addr('fill', i), madeUp(i, 9)))).toBe(true); }
    const me = await signIn(db, addr('late', 0));
    const full = await put(db, me, { notifications: watchOnly, channels: { discord: { enabled: true, webhookUrl: LATE } } });
    expect(full.status).toBe(409);
    const body = (await full.json()) as any;
    expect(body.error).toBe(CHANNELS_FULL);
    expect(body.settings.channels.discord).toMatchObject({ enabled: false, hasUrl: true, stopped: null });
    expect(d.calls).toHaveLength(0); // nothing is posted to a link the site cannot serve
    const view = await get(db, me);
    expect(view.channels.discord).toMatchObject({ enabled: false, hasUrl: true });
    expect(view.notifications.watchlist).toEqual([WATCHED]); // the other changes were saved
    // A place is freed; the switch posts the notice and turns the channel on.
    await deleteSettings(db as any, addr('fill', 0));
    t += 31_000;
    const on = await put(db, me, { channels: { discord: { enabled: true } } });
    expect(on.status).toBe(200);
    expect(((await on.json()) as any).settings.channels.discord).toMatchObject({ enabled: true });
    expect(d.calls).toEqual([{ url: LATE, title: 'Discord channel connected' }]);
    expect(await placeCount(db as any)).toBe(DELIVERABLE_MAX);
  });

  it('a Worker that sends no alerts refuses to turn a link on and saves nothing; the notice is under the wallet\'s cooldown', { timeout: 60_000 }, async () => {
    const db = clock();
    const FIRST = link('first'), SECOND = link('second');
    const d = discord();
    const me = await signIn(db, addr('off', 0));
    configureAlerts(KEY, false);
    const off = await put(db, me, { channels: { discord: { enabled: true, webhookUrl: FIRST } } });
    expect(off.status).toBe(503);
    expect(((await off.json()) as any).error).toBe(SAVE_ALERTS_OFF);
    expect((await get(db, me)).channels.discord.hasUrl).toBe(false);
    expect(d.calls).toHaveLength(0);
    configureAlerts(KEY, true);
    expect((await put(db, me, { channels: { discord: { enabled: true, webhookUrl: FIRST } } })).status).toBe(200);
    // Another link ten seconds later: the notice waits for the cooldown, so nothing is saved; after it, it goes.
    t += 10_000;
    const soon = await put(db, me, { channels: { discord: { enabled: true, webhookUrl: SECOND } } });
    expect(soon.status).toBe(429);
    expect(((await soon.json()) as any).error).toMatch(/Wait 30 seconds/);
    expect((await get(db, me)).channels.discord.webhookUrlMasked).toContain(FIRST.slice(-4));
    t += 21_000;
    expect((await put(db, me, { channels: { discord: { enabled: true, webhookUrl: SECOND } } })).status).toBe(200);
    expect(d.calls.map((c) => c.url)).toEqual([FIRST, SECOND]);
  });

  it('the Settings test button is a plain re-check: it posts to the saved link and records the success, which clears the note of a notice that did not reach the channel, and changes nothing else', { timeout: 60_000 }, async () => {
    const db = clock();
    const CHECKED = link('checked');
    let answer = () => new Response(null, { status: 500 });
    const d = discord(() => answer());
    const me = await signIn(db, addr('test', 0));
    const r = await put(db, me, { notifications: watchOnly, channels: { discord: { enabled: true, webhookUrl: CHECKED } } });
    expect(((await r.json()) as any).settings.channels.discord).toMatchObject({ enabled: true, stopped: null, notice: { status: 500, at: t } });
    expect(d.to(CHECKED)).toBe(2);
    answer = () => new Response(null, { status: 204 });
    t += 31_000;
    expect(await (await testPost(db, me)).json()).toEqual({ success: true });
    expect(d.to(CHECKED)).toBe(3);
    // The link is proven, so the note goes; the channel was on all along, and nothing else changed.
    expect(await linkProven(db as any, KEY, addr('test', 0), CHECKED)).toBe(true);
    const view = await get(db, me);
    expect(view.channels.discord).toMatchObject({ enabled: true, stopped: null, notice: null });
    expect(view.notifications.watchlist).toEqual([WATCHED]);
    // A test post that fails leaves the row as it is.
    answer = () => new Response('<html>503</html>', { status: 503 });
    t += 31_000;
    expect(await (await testPost(db, me)).json()).toEqual({ success: false });
    expect((await get(db, me)).channels.discord).toMatchObject({ enabled: true, stopped: null, notice: null });
  });
});
