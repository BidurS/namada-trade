// Security review (2026-10-22), a 429 that limits the site's address, not one hook: Discord answers 429 of global scope
// (X-RateLimit-Global, the limit on the address the Worker posts from, which it may share with other tenants) and a
// block page in front of Discord answers 429 with none of Discord's headers, to every post the site makes, whoever owns
// the hook. Both counted toward the hold for a hook kept rate-limited as a 429 of the hook's own bucket did, so after a
// few seconds of such a limit every honest subscriber's hook was held for the rest of the window and its alerts were
// recorded as not sent once Discord answered again; and the connection notice a save posts, answered so, saved the
// channel off and told the wallet its link was invalid. Such a 429 now pauses the whole dispatch: the subscribers'
// posts left are handed back to the next alarm, the operator's channel waits a short Retry-After out in place, the
// answer still counts as an invalid one, each hook's count toward the hold is left as its own answers made it, and at
// a save it is a blip of Discord's, as no answer is. Fetch is stubbed: nothing reaches Discord. Each case loads the dispatcher afresh, as a
// new isolate has it: a limit on the address is the isolate's to remember.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { base64 } from '@scure/base';
import { testD1, type TestD1 } from './d1-sqlite';
import type { StoredSettings } from '../worker/src/settings';
import type { PendingAlert } from '../worker/src/sources/discord';
import { createSession, type Session } from '../worker/src/auth';
import { memStorage } from './do-storage';
import type { Flow } from '../shared/types';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });

const KEY = base64.encode(new Uint8Array(32).fill(48));
const WINDOW = 10 * 60_000;
const OP = 'https://discord.com/api/webhooks/304/operator';
const MASP = 'tnam1pcqnhjdcg9tqf2txl2em2pxm7sexlnr7ds7wfr72';
let seq = 0;
/** A 60,000 NAM unshield: a whale for the operator and a match for the default unshield rule. */
const unshield = (): Flow => { seq++; return { id: `namada:SL${seq}:0`, chain: 'namada', height: seq, ts: Date.now(), txHash: `SL${seq}`, kind: 'unshield', from: MASP, to: `tnam1qreceiver${String(seq).padStart(4, '0')}${'z'.repeat(26)}`, amount: 60_000, meta: null } as unknown as Flow; };
const ok = () => new Response(null, { status: 204 });
/** Discord's limit on the site's address: scope global, X-RateLimit-Global true. */
const globalLimited = () => new Response(JSON.stringify({ message: 'You are being rate limited.', retry_after: 1, global: true }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '1', 'x-ratelimit-global': 'true', 'x-ratelimit-scope': 'global' } });
/** A 429 in front of Discord with none of its headers but a Retry-After. */
const bareLimited = () => new Response('<html>rate limited</html>', { status: 429, headers: { 'content-type': 'text/html', 'retry-after': '1' } });
/** Cloudflare's block page in front of discord.com: a 429 with no scope and no Retry-After. */
const blockPage = () => new Response('<html><title>Access denied | discord.com used Cloudflare to restrict access</title>error code: 1015</html>', { status: 429, headers: { 'content-type': 'text/html' } });
const userLimited = () => new Response(JSON.stringify({ message: 'You are being rate limited.', retry_after: 2, global: false }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '2', 'x-ratelimit-scope': 'user' } });
const kvJson = (db: TestD1, key: string) => {
  const r = db.raw.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return r ? JSON.parse(r.value) : null;
};

/** A fresh copy of the dispatcher, the settings and the hub, as a new isolate has them. */
async function fresh() {
  vi.resetModules();
  const d = await import('../worker/src/sources/discord');
  const s = await import('../worker/src/settings');
  const h = await import('../worker/src/live-hub');
  d.configureAlerts(KEY, true);
  return { d, s, h };
}
type Fresh = Awaited<ReturnType<typeof fresh>>;
/** Starts the fake clock `ms` into a window of the day's hour `hour`. */
function clockAt(hour: number, ms = 5_000) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Math.floor(Date.UTC(2026, 9, 23, hour) / WINDOW) * WINDOW + ms);
}
/** A proven row on the default rules (the save's notice taken two days ago). */
async function honestRow(m: Fresh, db: TestD1, tag: string, url: string) {
  const T = Date.now();
  const s: StoredSettings = { address: `tnam1q${tag}${'q'.repeat(39 - tag.length)}`, notifications: m.s.defaultPrefs(), channels: { discord: { enabled: true, webhookUrl: url } }, createdAt: T - 3 * 86_400_000, updatedAt: T - 3 * 86_400_000 };
  expect(await m.s.saveSettings(db as any, KEY, s)).toBe(true);
  await m.s.hookOkStmt(db as any, KEY, s.address, url, T - 2 * 86_400_000).run();
}
const hubOf = (m: Fresh, db: unknown, storage: ReturnType<typeof memStorage>, op?: string): any =>
  Object.assign(Object.create(m.h.LiveHub.prototype), { env: { DB: db, DISCORD_WEBHOOK_URL: op }, ctx: { storage }, pendingN: null, pendingPosts: null, pendingNoted: null, pendingSeq: 0 });
/** One alarm `gap` ms after the last: the pending list first, then `flows`, then the dispatch's records. */
async function alarm(m: Fresh, hub: any, db: TestD1, flows: Flow[], gap = 6_000) {
  vi.setSystemTime(Date.now() + gap);
  const b = m.d.alarmBudget(Date.now() + 142_000, true);
  await hub.sendPending(b);
  if (flows.length) await hub.alertFlows(flows, 10000, 10, b);
  await flushAlerts(m, db, b);
}
const flushAlerts = (m: Fresh, db: TestD1, b: any) => m.d.flushAlerts(db as any, b);
const partsOf = async (storage: ReturnType<typeof memStorage>) => [...(await storage.list<PendingAlert>({ prefix: 'alerts.pending:' })).values()];
/** Every post Discord took, by link: the move's link in the embed and whether it says it waited. */
function delivered() {
  const took = new Map<string, { tx: string; late: boolean }[]>();
  const note = (url: string, init?: RequestInit) => {
    const e = JSON.parse(String(init?.body ?? '{}')).embeds?.[0];
    const list = took.get(url) ?? [];
    list.push({ tx: String(e?.url), late: !!e?.fields?.some((f: { name: string }) => f.name === 'Found late') });
    took.set(url, list);
  };
  return { took, note };
}

describe('Security review (2026-10-22), a 429 that limits the site\'s address', () => {
  for (const [name, limited] of [['of global scope', globalLimited], ['with none of Discord\'s headers', bareLimited]] as const) {
    it(`a 12 s limit ${name} from mid-dispatch, then Discord answering again: every honest subscriber gets every alert (marked found late where it waited), nothing is held, and the pending list drains`, { timeout: 60_000 }, async () => {
      clockAt(name.startsWith('of') ? 9 : 10);
      const m = await fresh();
      const db = testD1();
      const subs = [0, 1, 2].map((i) => `https://discord.com/api/webhooks/${9420 + i}/sitelimit${name.length}x${i}`);
      for (const [i, url] of subs.entries()) await honestRow(m, db, `sitelimit${name.length}${i}`, url);
      // The limit starts at the third post Discord is sent and lasts twelve seconds.
      let calls = 0, from: number | null = null, answered429 = 0;
      const d = delivered();
      vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => {
        if (++calls === 3) from = Date.now();
        if (from != null && Date.now() < from + 12_000) { answered429++; return limited(); }
        d.note(String(u), init);
        return ok();
      }));
      const storage = memStorage();
      const hub = hubOf(m, db, storage);
      const offered: string[] = [];
      // Six alarms six seconds apart, three unshields each, then quiet alarms until the list is empty.
      for (let a = 0; a < 6; a++) {
        const flows = [unshield(), unshield(), unshield()];
        offered.push(...flows.map((f) => f.txHash));
        await alarm(m, hub, db, flows);
      }
      for (let a = 0; a < 5 && (await partsOf(storage)).length; a++) await alarm(m, hub, db, []);
      console.log(`limit ${name}: ${answered429} answered 429, ${[...d.took.values()].map((l) => `${l.length} posts (${l.filter((x) => x.late).length} late)`).join(', ')}`);
      for (const url of subs) {
        const got = d.took.get(url) ?? [];
        expect(got.map((x) => x.tx.split('/').pop()!.toUpperCase()).sort(), `every alert reached ${url.slice(-12)} once`).toEqual(offered.map((x) => x.toUpperCase()).sort());
        expect(got.some((x) => x.late), 'the alerts that waited say so').toBe(true);
        expect(await m.d.testPostHeld(url, db as any, true)).toBe(false);
      }
      expect(await partsOf(storage)).toHaveLength(0);
      expect(kvJson(db, 'alerts.skipped'), 'nothing recorded as not sent').toBeNull();
      // Each such answer is still an invalid one, as Discord counts it; a halted alarm makes few of them.
      expect(kvJson(db, 'alerts.invalid').n).toBe(answered429);
      expect(answered429).toBeLessThanOrEqual(6);
    });
  }

  for (const [name, limited, tag] of [['global scope', globalLimited, 'GA'], ['no scope header', bareLimited, 'GB']] as const) {
    it(`an honest proven hook whose first three answers are 429s of ${name} gets every one of six alerts once Discord answers again: posted or kept, none recorded as not sent`, { timeout: 60_000 }, async () => {
      clockAt(tag === 'GA' ? 11 : 12, 30_000);
      const m = await fresh();
      const db = testD1();
      const url = `https://discord.com/api/webhooks/94${tag === 'GA' ? '31' : '32'}/honest${tag}`;
      await honestRow(m, db, `honest${tag.toLowerCase()}`, url);
      let answers = 0;
      const took: string[] = [];
      vi.stubGlobal('fetch', vi.fn(async (u: string) => {
        if (String(u) !== url) return ok();
        if (++answers <= 3) return limited();
        took.push(String(u));
        return ok();
      }));
      const storage = memStorage();
      const hub = hubOf(m, db, storage, OP);
      for (let k = 0; k < 6; k++) await alarm(m, hub, db, [unshield()]);
      expect(took.length + (await partsOf(storage)).length, 'posted or kept').toBe(6);
      expect(kvJson(db, 'alerts.skipped'), 'nothing the honest subscriber is entitled to is recorded as not sent').toBeNull();
    });
  }

  it('a limit of global scope of about twenty seconds, then the rest of the window: the honest subscriber hears every later move', { timeout: 120_000 }, async () => {
    clockAt(13);
    const m = await fresh();
    const db = testD1();
    const url = 'https://discord.com/api/webhooks/9433/honestglobal';
    await honestRow(m, db, 'honestglobal', url);
    const windowEnd = (Math.floor(Date.now() / WINDOW) + 1) * WINDOW;
    let limitedNow = true;
    const posts: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => { posts.push(String(u)); return limitedNow ? globalLimited() : ok(); }));
    const storage = memStorage();
    const hub = hubOf(m, db, storage);
    for (let k = 0; k < 3; k++) await alarm(m, hub, db, [unshield()]);
    const during = posts.length;
    limitedNow = false;
    let later = 0;
    while (Date.now() + 6_000 < windowEnd - 60_000) await alarm(m, hub, db, later < 20 ? (later++, [unshield()]) : []);
    console.log(`global scope: ${during} posts in the episode, ${posts.length - during} after, for ${later} later moves and 3 kept`);
    expect(posts.length - during, 'the three kept moves and every later one posted').toBe(later + 3);
    expect(kvJson(db, 'alerts.skipped')).toBeNull();
  });

  it('a Cloudflare block page (429, no scope, no Retry-After) for about three minutes, then the rest of the window: the honest subscriber hears every move, the kept ones once its short pause is over', { timeout: 120_000 }, async () => {
    clockAt(14);
    const m = await fresh();
    const db = testD1();
    const url = 'https://discord.com/api/webhooks/9434/honestblock';
    await honestRow(m, db, 'honestblock', url);
    const windowEnd = (Math.floor(Date.now() / WINDOW) + 1) * WINDOW;
    let limitedNow = true;
    const posts: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => { posts.push(String(u)); return limitedNow ? blockPage() : ok(); }));
    const storage = memStorage();
    const hub = hubOf(m, db, storage);
    for (let k = 0; k < 3; k++) await alarm(m, hub, db, [unshield()], 61_000);
    const during = posts.length;
    limitedNow = false;
    let later = 0;
    while (Date.now() + 6_000 < windowEnd - 60_000) await alarm(m, hub, db, later < 20 ? (later++, [unshield()]) : []);
    console.log(`block page: ${during} posts in the episode, ${posts.length - during} after, for ${later} later moves and 3 kept`);
    expect(posts.length - during).toBe(later + 3);
    expect(await partsOf(storage)).toHaveLength(0);
    expect(kvJson(db, 'alerts.skipped')).toBeNull();
  });

  it('the operator\'s channel waits a short Retry-After of global scope out in place and is posted once more, while the subscribers\' posts of the alarm wait for the next one', { timeout: 60_000 }, async () => {
    clockAt(15);
    const m = await fresh();
    const db = testD1();
    const url = 'https://discord.com/api/webhooks/9435/honestop';
    await honestRow(m, db, 'honestop', url);
    // The first two posts (the operator's and the subscriber's, sent together) are answered 429 of global scope.
    const answers: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      const limitedNow = answers.length < 2;
      answers.push(`${String(u) === OP ? 'op' : 'sub'}:${limitedNow ? 429 : 204}`);
      return limitedNow ? globalLimited() : ok();
    }));
    const storage = memStorage();
    const hub = hubOf(m, db, storage, OP);
    // Two moves in one alarm: the first move's operator post waits the second out and is posted once more; its
    // subscriber's post is handed back, and the second move's subscriber part waits whole; the operator hears both.
    await alarm(m, hub, db, [unshield(), unshield()]);
    expect(answers).toEqual(['op:429', 'sub:429', 'op:204', 'op:204']);
    expect(await partsOf(storage)).toHaveLength(2);
    await alarm(m, hub, db, []);
    expect(answers).toEqual(['op:429', 'sub:429', 'op:204', 'op:204', 'sub:204', 'sub:204']);
    expect(await partsOf(storage)).toHaveLength(0);
    expect(kvJson(db, 'alerts.skipped')).toBeNull();
  });

  it('a limit on the address leaves each hook\'s count toward the hold as it was: a hook with two 429s of its own bucket counted, then a global limit, is held at its next such 429, and its kept parts are let go, recorded', { timeout: 60_000 }, async () => {
    clockAt(16);
    const m = await fresh();
    const db = testD1();
    const url = 'https://discord.com/api/webhooks/9436/clearcount';
    await honestRow(m, db, 'clearcount', url);
    const plan: (() => Response)[] = [userLimited, userLimited, globalLimited, userLimited, ok, ok];
    vi.stubGlobal('fetch', vi.fn(async () => (plan.shift() ?? ok)()));
    const storage = memStorage();
    const hub = hubOf(m, db, storage);
    for (let k = 0; k < 4; k++) await alarm(m, hub, db, [unshield()]);
    expect(plan, 'the fourth answer was the third 429 of its own bucket').toEqual([ok, ok]);
    expect(await m.d.testPostHeld(url, db as any, true)).toBe('limited');
    for (let k = 0; k < 3; k++) await alarm(m, hub, db, []);
    expect(await partsOf(storage)).toHaveLength(0);
    expect(kvJson(db, 'alerts.skipped').last.what).toContain('to links held for the window');
  });

  it('a forum alert offered while Discord limits the site\'s address waits for the next run with its claim untaken, and that run posts it', { timeout: 60_000 }, async () => {
    clockAt(17);
    const m = await fresh();
    const db = testD1();
    const url = 'https://discord.com/api/webhooks/9437/forumsub';
    await honestRow(m, db, 'forumsub', url);
    const row = (await m.s.loadSettings(db as any, KEY, `tnam1qforumsub${'q'.repeat(31)}`))!;
    row.notifications.forumAndGov = true;
    expect(await m.s.saveSettings(db as any, KEY, row)).toBe(true);
    // A move's subscriber post is answered 429 of global scope: the address is limited for the next second.
    const answers: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => { answers.push(String(u)); return answers.length === 1 ? globalLimited() : ok(); }));
    await m.d.sendDiscordWhaleAlert(undefined, unshield(), db as any, 10000);
    const post = { id: 990001, topicId: 1, topicTitle: 't', topicSlug: 't', postNumber: 2, url: 'https://forum.namada.net/t/t/1/990001', username: 'u', displayName: null, avatarUrl: null, createdAt: new Date().toISOString(), excerpt: 'e', isNewTopic: false };
    const run1 = m.d.alertBudget(Date.now());
    expect(await m.d.sendDiscordForumAlert(OP, post, db as any, run1)).toBe('waiting');
    expect(run1.paused).toBe(true);
    expect(kvJson(db, 'alert:forum:post:990001')).toBeNull();
    // The move's post, sent by a dispatch that cannot keep it for later, is posted once more after the short pause.
    expect(answers).toEqual([url, url, OP]);
    // The next run, after the limit: the subscriber is posted, the operator is not posted again.
    vi.setSystemTime(Date.now() + 60_000);
    const run2 = m.d.alertBudget(Date.now());
    expect(await m.d.sendDiscordForumAlert(OP, post, db as any, run2)).toBe('done');
    expect(answers).toEqual([url, url, OP, url]);
  });
});

describe('Security review (2026-10-22), a save while Discord limits the site\'s address', () => {
  const env = (db: TestD1) => ({ DB: db, SETTINGS_KEY: KEY }) as any;
  for (const [name, limited] of [['of global scope', globalLimited], ['with none of Discord\'s headers', bareLimited]] as const) {
    it(`a connection notice answered 429 ${name} is the blip the retry is for: the channel is saved on with the note, the wallet is not told its link is invalid, and its test post once Discord answers again proves the link`, { timeout: 60_000 }, async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.UTC(2026, 9, 23, name.startsWith('of') ? 18 : 19));
      const { d } = await fresh();
      const { app } = await import('../worker/src/api');
      const db = testD1();
      const url = `https://discord.com/api/webhooks/9440/savelimit${name.length}`;
      let limitedNow = true;
      const posts: string[] = [];
      vi.stubGlobal('fetch', vi.fn(async (u: string) => { posts.push(String(u)); return limitedNow ? limited() : ok(); }));
      const wallet = (await createSession(db as any, `tnam1qsavelimit${name.length}${'q'.repeat(29)}`, 'namada', 'namada')) as Session;
      const auth = { Authorization: `Bearer ${wallet.token}` };
      const res = await app.request('/api/me/settings', { method: 'PUT', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ channels: { discord: { enabled: true, webhookUrl: url } } }) }, env(db));
      expect(res.status).toBe(200);
      const view = ((await res.json()) as any).settings.channels.discord;
      expect(view).toMatchObject({ enabled: true, stopped: null, notice: { status: 429 } });
      expect(posts.length).toBeGreaterThanOrEqual(1);
      // Discord answers again; the wallet's test post goes (it does not wait for the next window) and proves the link.
      limitedNow = false;
      vi.setSystemTime(Date.now() + 31_000);
      const tp = await app.request('/api/me/settings/test', { method: 'POST', headers: auth }, env(db));
      expect(tp.status).toBe(200);
      expect(await tp.json()).toEqual({ success: true });
      const after = ((await (await app.request('/api/me/settings', { headers: auth }, env(db))).json()) as any).settings.channels.discord;
      expect(after).toMatchObject({ enabled: true, stopped: null, notice: null });
      expect(d.alertsOn()).toBe(true);
    });
  }
});
