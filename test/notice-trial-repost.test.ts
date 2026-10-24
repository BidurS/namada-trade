// Security review (2026-10-22), a channel on trial that no alert matched for a day: a save whose connection notice
// Discord answered nothing against the link, twice (no answer, a 5xx, a 429 that is not the link's own), keeps the
// channel on with a note, and the cron's tick turned such a channel off a day later when no post had reached it. A
// working link whose owner's rules matched no move that day (the default rules on a quiet day, a watchlist whose
// addresses did not move, forum alerts only) was never posted to, so it was turned off for having been quiet, and its
// owner's next alert was not sent until the owner came back and switched it on. The tick now posts the connection
// notice once more instead (sources/discord.ts sweepNoticeChannels, through the test post and under the test posts'
// budget): Discord taking it proves the link, an answer that blames the link turns the channel off as before, and an
// answer that says nothing of it keeps the trial and is tried again the next day, the channel being turned off,
// visibly, only after NOTICE_TRIES_MAX such days. Fetch is stubbed: nothing reaches Discord.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { testD1, type TestD1 } from './d1-sqlite';
import { placeCount, saveSettings, defaultPrefs, linkProven, NOTICE_SWEEP_MAX, NOTICE_TRIES_MAX, NOTICE_TRIAL_MS, type StoredSettings } from '../worker/src/settings';
import { configureAlerts, sendDiscordWhaleAlert, INVALID_WINDOW_MS, TEST_INVALID_BUDGET } from '../worker/src/sources/discord';
import { app } from '../worker/src/api';
import { runCron } from '../worker/src/cron';
import { createSession, type Session } from '../worker/src/auth';
import { deliveryView } from '../web/src/screens/settings/delivery';
import type { Flow } from '../shared/types';

const KEY = 'DQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0=';
const DAY = 86_400_000;
const HOUR = 3_600_000;
const MASP = 'tnam1pcqnhjdcg9tqf2txl2em2pxm7sexlnr7ds7wfr72';
let t = 0;
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const addr = (tag: string, i: number) => `tnam1q${tag}${String(i).padStart(5, '0')}${'q'.repeat(30)}`;
const env = (db: TestD1, extra: Record<string, unknown> = {}) => ({ DB: db, SETTINGS_KEY: KEY, ...extra }) as any;
const put = (db: TestD1, s: Session, body: unknown) =>
  app.request('/api/me/settings', { method: 'PUT', headers: { Authorization: `Bearer ${s.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }, env(db));
const view = async (db: TestD1, s: Session) => ((await (await app.request('/api/me/settings', { headers: { Authorization: `Bearer ${s.token}` } }, env(db))).json()) as any).settings.channels.discord;
/** A 60,000 NAM unshield: a match for the default unshield rule (50,000 NAM). */
const unshield = (n: number): Flow => ({ id: `namada:QT${n}:0`, chain: 'namada', height: n, ts: t, txHash: `QT${n}`, kind: 'unshield', from: MASP, to: `tnam1qreceiver${String(n).padStart(4, '0')}${'z'.repeat(26)}`, amount: 60_000, meta: null }) as unknown as Flow;
/** Every rule, the watchlist and forum alerts off: no alert is ever posted to such a row. */
const allOff = { rules: { big_swap: { on: false }, ibc_inventory: { on: false }, unlock: { on: false }, unshield: { on: false }, bond: { on: false } }, watchlistOn: false, forumAndGov: false };
const unavailable = () => new Response('<html>503</html>', { status: 503 });
const ok = () => new Response(null, { status: 204 });
const forumChannel = () => new Response(JSON.stringify({ message: 'Webhooks posted to forum channels must have a thread_name or thread_id', code: 220001 }), { status: 400, headers: { 'content-type': 'application/json' } });
const gone = () => new Response(JSON.stringify({ message: 'Unknown Webhook', code: 10015 }), { status: 404, headers: { 'content-type': 'application/json' } });
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
const tick = (db: TestD1) => runCron(env(db, { SEND_ALERTS: 'yes' }));

describe('Security review (2026-10-22), a channel on trial that no alert matched for a day', () => {
  it('a working link on the default rules, saved while Discord answered the notice 503 twice, with no move its rules match for a day: its next match is still posted, with nothing asked of its owner', { timeout: 120_000 }, async () => {
    const db = clock();
    const HONEST = 'https://discord.com/api/webhooks/9161/quietday';
    let blip = true;
    const d = network(() => (blip ? unavailable() : ok()));
    const me = await signIn(db, addr('quiet', 0));
    const r = await put(db, me, { channels: { discord: { enabled: true, webhookUrl: HONEST } } });
    expect(((await r.json()) as any).settings.channels.discord).toMatchObject({ enabled: true, notice: { status: 503 } });
    blip = false;
    // A quiet day: no move at the default rules' sizes. The cron ticks as it does every minute; one tick past the day.
    t += DAY + HOUR;
    await tick(db);
    const v = await view(db, me);
    console.log(`after a quiet day: places ${await placeCount(db as any)}, channel ${JSON.stringify(v)}`);
    // The next move the default rules match.
    t += HOUR;
    const before = d.to(HONEST);
    await sendDiscordWhaleAlert(undefined, unshield(1), db as any, 1e9);
    const sent = d.to(HONEST) - before;
    expect(v.enabled, 'the honest channel is still on').toBe(true);
    expect(v.notice, 'the notice the tick posted reached it, so the note goes').toBeNull();
    expect(before, 'the tick posted the notice once').toBe(3);
    expect(await linkProven(db as any, KEY, addr('quiet', 0), HONEST)).toBe(true);
    expect(sent, 'the honest subscriber hears of the move').toBe(1);
  });

  it('an honest working link saved during a Discord blip, then a quiet day: it stays on and hears the next matching move', { timeout: 120_000 }, async () => {
    const db = clock();
    const HONEST = 'https://discord.com/api/webhooks/9160/honestquietday';
    let blip = true;
    const d = network(() => (blip ? unavailable() : ok()));
    const me = await signIn(db, `tnam1qquietday${'q'.repeat(31)}`);
    // The default rules (an unshield of 50,000 NAM or more, and the other defaults), a working link.
    const r = await put(db, me, { channels: { discord: { enabled: true, webhookUrl: HONEST } } });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).settings.channels.discord.enabled).toBe(true);
    // Discord is back a minute later; no move matches the default rules for a day.
    blip = false;
    t += DAY + HOUR;
    await tick(db);
    const after = await view(db, me);
    // The next matching move.
    t += HOUR;
    const before = d.to(HONEST);
    await sendDiscordWhaleAlert(undefined, unshield(2), db as any, 1e9);
    expect(after.enabled, 'the working link is still on').toBe(true);
    expect(d.to(HONEST) - before, 'the 60,000 NAM unshield reached the honest subscriber').toBe(1);
  });

  it('a webhook made in a forum channel (400 220001 to every post) is turned off at the notice the tick posts, gives its place up, and is posted nothing again', { timeout: 120_000 }, async () => {
    const db = clock();
    const FORUM = 'https://discord.com/api/webhooks/9162/forumrepost';
    let atSave = true;
    const d = network(() => (atSave ? unavailable() : forumChannel()));
    const me = await signIn(db, addr('frepost', 0));
    await put(db, me, { notifications: allOff, channels: { discord: { enabled: true, webhookUrl: FORUM } } });
    const savedAt = t;
    atSave = false;
    // Within the day: the tick posts nothing to it.
    t += DAY - HOUR;
    await tick(db);
    expect(d.to(FORUM)).toBe(2);
    expect(await placeCount(db as any)).toBe(1);
    // Past the day: the tick posts the notice once, Discord refuses it, and the channel is turned off.
    t += 2 * HOUR;
    await tick(db);
    expect(d.to(FORUM)).toBe(3);
    expect(await placeCount(db as any)).toBe(0);
    const v = await view(db, me);
    expect(v).toMatchObject({ enabled: false, notice: null, stopped: { status: 400, at: t, reason: 'notice', savedAt } });
    expect(deliveryView(v).notice!.text).toContain('Discord answered 400 to a post to it');
    for (let k = 0; k < 4; k++) { t += DAY; await tick(db); }
    expect(d.to(FORUM)).toBe(3);
  });

  it('a link Discord says is gone at the notice the tick posts is turned off as the dispatcher turns a dead link off', { timeout: 120_000 }, async () => {
    const db = clock();
    const GONE = 'https://discord.com/api/webhooks/9163/gonerepost';
    let atSave = true;
    const d = network(() => (atSave ? unavailable() : gone()));
    const me = await signIn(db, addr('grepost', 0));
    await put(db, me, { notifications: allOff, channels: { discord: { enabled: true, webhookUrl: GONE } } });
    atSave = false;
    t += DAY + HOUR;
    await tick(db);
    expect(d.to(GONE)).toBe(3);
    const v = await view(db, me);
    expect(v).toMatchObject({ enabled: false, notice: null, stopped: { status: 404, at: t } });
    expect(v.stopped.reason).toBeUndefined();
    expect(deliveryView(v).state).toBe('stopped');
    expect(await placeCount(db as any)).toBe(0);
  });

  it(`a link the notice cannot reach on any day (503 every time) keeps its place and is tried once a day; after ${NOTICE_TRIES_MAX} days of such answers it is turned off, visibly`, { timeout: 120_000 }, async () => {
    const db = clock();
    const DOWN = 'https://discord.com/api/webhooks/9164/downrepost';
    const d = network(() => unavailable());
    const me = await signIn(db, addr('drepost', 0));
    await put(db, me, { notifications: allOff, channels: { discord: { enabled: true, webhookUrl: DOWN } } });
    const savedAt = t;
    expect(d.to(DOWN)).toBe(2);
    const tries: number[] = [];
    for (let day = 1; day <= NOTICE_TRIES_MAX; day++) {
      t = savedAt + day * (DAY + HOUR);
      await tick(db);
      tries.push(t);
      expect(d.to(DOWN), `the tick of day ${day} posted the notice once`).toBe(2 + day);
      // Ticks within the day after a try post nothing.
      const tried = t;
      t = tried + HOUR;
      await tick(db);
      expect(d.to(DOWN), `no second post on day ${day}`).toBe(2 + day);
      t = tried;
      const v = await view(db, me);
      if (day < NOTICE_TRIES_MAX) {
        expect(v).toMatchObject({ enabled: true, stopped: null, notice: { status: 503, at: savedAt, tries: { n: day, status: 503, at: tried } } });
        expect(await placeCount(db as any)).toBe(1);
        expect(deliveryView(v).notice!.text).toContain(`The notice was posted again ${day === 1 ? 'once' : `${day} times`}, last on`);
      } else {
        expect(v).toMatchObject({ enabled: false, notice: null, stopped: { status: 503, at: tried, reason: 'notice', savedAt, tries: NOTICE_TRIES_MAX } });
        expect(await placeCount(db as any)).toBe(0);
        const page = deliveryView(v);
        expect(page.state).toBe('notice');
        expect(page.notice!.text).toContain(`posted again on ${NOTICE_TRIES_MAX} days`);
        expect(page.switchDisabled).toBe(false);
      }
    }
    expect(NOTICE_TRIAL_MS).toBe(DAY);
    expect(NOTICE_TRIES_MAX).toBe(3);
  });

  it('a link the notice could not reach on the first day but reaches on the second is proven: the note goes, it keeps its place, and its alerts go', { timeout: 120_000 }, async () => {
    const db = clock();
    const LATER = 'https://discord.com/api/webhooks/9165/laterrepost';
    let answer = unavailable;
    const d = network(() => answer());
    const me = await signIn(db, addr('lrepost', 0));
    await put(db, me, { channels: { discord: { enabled: true, webhookUrl: LATER } } });
    t += DAY + HOUR;
    await tick(db);
    expect(d.to(LATER)).toBe(3);
    expect((await view(db, me)).notice.tries.n).toBe(1);
    answer = ok;
    t += DAY + HOUR;
    await tick(db);
    expect(d.to(LATER)).toBe(4);
    expect(await view(db, me)).toMatchObject({ enabled: true, stopped: null, notice: null });
    expect(await linkProven(db as any, KEY, addr('lrepost', 0), LATER)).toBe(true);
    for (let k = 0; k < 4; k++) { t += DAY; await tick(db); }
    expect(d.to(LATER), 'a proven link is not posted the notice again').toBe(4);
    await sendDiscordWhaleAlert(undefined, unshield(3), db as any, 1e9);
    expect(d.to(LATER)).toBe(5);
  });

  it('a tick whose test posts\' budget is spent posts no notice and counts no try; the tick of the next window posts it', { timeout: 120_000 }, async () => {
    const db = clock();
    const HELD = 'https://discord.com/api/webhooks/9166/heldrepost';
    let answer = unavailable;
    const d = network(() => answer());
    const me = await signIn(db, addr('hrepost', 0));
    await put(db, me, { channels: { discord: { enabled: true, webhookUrl: HELD } } });
    answer = ok;
    t += DAY + HOUR;
    const w = Math.floor(t / INVALID_WINDOW_MS);
    db.raw.prepare('INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)').run('alerts.invalid.test', JSON.stringify({ w, n: TEST_INVALID_BUDGET }), t);
    await tick(db);
    expect(d.to(HELD)).toBe(2);
    expect(await view(db, me)).toMatchObject({ enabled: true, notice: { status: 503 } });
    expect((await view(db, me)).notice.tries).toBeUndefined();
    t = (w + 1) * INVALID_WINDOW_MS + 60_000;
    await tick(db);
    expect(d.to(HELD)).toBe(3);
    expect(await view(db, me)).toMatchObject({ enabled: true, notice: null });
  });

  it(`one tick posts the notice to at most ${NOTICE_SWEEP_MAX} channels on trial, oldest first; the next tick takes the rest`, { timeout: 120_000 }, async () => {
    const db = clock();
    const d = network(() => ok());
    const n = NOTICE_SWEEP_MAX + 2;
    const urls = Array.from({ length: n }, (_, i) => `https://discord.com/api/webhooks/${9170 + i}/boundrepost${i}`);
    const T = t;
    for (const [i, url] of urls.entries()) {
      const p = defaultPrefs();
      const s: StoredSettings = { address: addr('bound', i), notifications: p, channels: { discord: { enabled: true, webhookUrl: url, notice: { status: 503, at: T - 2 * DAY + i * 60_000 } } }, createdAt: T - 2 * DAY, updatedAt: T - 2 * DAY + i * 60_000 };
      expect(await saveSettings(db as any, KEY, s)).toBe(true);
    }
    await tick(db);
    expect(urls.map((u) => d.to(u))).toEqual(urls.map((_, i) => (i < NOTICE_SWEEP_MAX ? 1 : 0)));
    t += 60_000;
    await tick(db);
    expect(urls.map((u) => d.to(u))).toEqual(urls.map(() => 1));
    for (const [i, url] of urls.entries()) expect(await linkProven(db as any, KEY, addr('bound', i), url)).toBe(true);
    expect(await placeCount(db as any)).toBe(n);
  });
});
