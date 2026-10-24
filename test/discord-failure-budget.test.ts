// Security review (2026-10-22), webhook failure accounting: Discord restricts an address that makes more than 10,000
// invalid requests (401, 403 and 429 answers, a 429 of shared scope excepted) in 10 minutes, and asks that a webhook
// that answered 404 not be posted again; every alert, the operator's among them, leaves from the same addresses, and
// any signed-in wallet can save a link that only has to look like a Discord webhook. A hook Discord says is gone or
// has a wrong token is posted once and its channel turned off; a 429 is a pause for its Retry-After only (Discord's
// per-webhook limit answers it to honest hooks), while a user's hook that keeps answering 401, 403 or 404 is left alone
// like any failing hook; invalid answers are counted across isolates per window: past INVALID_BUDGET only the
// operator's channel, hooks that have worked and settled rows' hooks are posted, past INVALID_CEILING the operator's
// channel only, and what is held is recorded; the operator's channel goes first; the Settings test post is counted
// against a budget of its own. No network.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { base64 } from '@scure/base';
import { testD1, type TestD1 } from './d1-sqlite';
import { createSession, type Session } from '../worker/src/auth';
import type { StoredSettings } from '../worker/src/settings';
import type { Flow } from '../shared/types';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const KEY = base64.encode(new Uint8Array(32).fill(6));
// Each test starts 1 s into a window of its own, so no step crosses a window it does not mean to.
const WINDOW = 10 * 60_000;
let T0 = 0;
function clock() {
  vi.useFakeTimers({ toFake: ['Date'] });
  T0 = (Math.floor(Date.now() / WINDOW) + 1) * WINDOW + 1000;
  vi.setSystemTime(T0);
  return (ms: number) => vi.setSystemTime(T0 + ms);
}
/** A fresh copy of the dispatcher, as a new isolate has it (no record of any hook). */
async function isolate() {
  vi.resetModules();
  const d = await import('../worker/src/sources/discord');
  const s = await import('../worker/src/settings');
  d.configureAlerts(KEY);
  return { d, s };
}
const user = (s: typeof import('../worker/src/settings'), address: string, webhookUrl: string, updatedAt = T0): StoredSettings => {
  const u: StoredSettings = { address, notifications: s.defaultPrefs(), channels: { discord: { enabled: true, webhookUrl } }, createdAt: updatedAt, updatedAt };
  u.notifications.rules.big_swap = { on: true, thresholdNam: 1 };
  return u;
};
const addr = (tag: string, i: number) => `tnam1q${tag}${String(i).padStart(4, '0')}${'q'.repeat(30)}`;
let seq = 0;
const sell = (): Flow => { seq++; return { id: `osmosis:FB${seq}:0`, chain: 'osmosis', height: seq, ts: T0, txHash: `FB${seq}`, kind: 'sell', from: 'osmo1yl6hdjhmkf37639730gffanpzndzdpmhxy9ep3', to: null, amount: 20000, meta: null }; };
const discordJson = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const UNKNOWN_WEBHOOK = { message: 'Unknown Webhook', code: 10015 };
const INVALID_TOKEN = { message: 'Invalid Webhook Token', code: 50027 };
const MISSING_ACCESS = { message: 'Missing Access', code: 50001 };
const rateLimited = (sec: number, scope = 'user') => discordJson(429, { message: 'You are being rate limited.', retry_after: sec, global: false }, { 'retry-after': String(sec), 'x-ratelimit-scope': scope });
const blockPage = (status: number) => new Response('<html><body>Access denied</body></html>', { status, headers: { 'content-type': 'text/html' } });
const OP = 'https://discord.com/api/webhooks/100/operator';
const kvJson = (db: TestD1, key: string) => {
  const r = db.raw.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return r ? JSON.parse(r.value) : null;
};
const updatedAtCol = (db: TestD1, address: string) => (db.raw.prepare('SELECT updated_at FROM kv WHERE key = ?').get(`user:${address}`) as { updated_at: number }).updated_at;
/** A fetch stub that answers by URL and keeps every URL it was asked. */
function discord(answer: (url: string, nth: number) => Response) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (u: string) => { const url = String(u); calls.push(url); return answer(url, calls.filter((c) => c === url).length); }));
  return { calls, count: (url: string) => calls.filter((c) => c === url).length };
}

describe('a hook Discord says is gone or has a wrong token', () => {
  it('is posted once: its channel is turned off in its row, which keeps its place, and it is never posted again', async () => {
    const at = clock();
    const { d, s } = await isolate();
    const GONE = 'https://discord.com/api/webhooks/10/gone', TOKEN = 'https://discord.com/api/webhooks/11/wrongtoken', GOOD = 'https://discord.com/api/webhooks/12/good';
    const f = discord((url) => (url === GONE ? discordJson(404, UNKNOWN_WEBHOOK) : url === TOKEN ? discordJson(401, INVALID_TOKEN) : new Response(null, { status: 204 })));
    const db = testD1();
    for (const [i, url] of [GONE, TOKEN, GOOD].entries()) await s.saveSettings(db as any, KEY, user(s, addr('dead', i), url));
    const placed = updatedAtCol(db, addr('dead', 0));
    at(5);
    await d.sendDiscordWhaleAlert(OP, sell(), db as any, 10000);
    expect([f.count(OP), f.count(GONE), f.count(TOKEN), f.count(GOOD)]).toEqual([1, 1, 1, 1]);
    const gone = (await s.loadSettings(db as any, KEY, addr('dead', 0)))!;
    expect(gone.channels.discord).toEqual({ enabled: false, webhookUrl: GONE, stopped: { status: 404, at: T0 + 5 } });
    expect((await s.loadSettings(db as any, KEY, addr('dead', 1)))!.channels.discord.stopped).toEqual({ status: 401, at: T0 + 5 });
    expect((await s.loadSettings(db as any, KEY, addr('dead', 2)))!.channels.discord.enabled).toBe(true);
    expect(updatedAtCol(db, addr('dead', 0))).toBe(placed);
    expect(s.publicView(gone).channels.discord.stopped).toEqual({ status: 404, at: T0 + 5 });
    expect(kvJson(db, 'alerts.invalid')).toEqual({ w: Math.floor(T0 / WINDOW), n: 2 });
    // Later moves, past the users cache, the backoff and the window: the two are never posted again.
    for (let k = 1; k <= 4; k++) {
      at(k * (d.BACKOFF_MS + d.USERS_CACHE_MS));
      await d.sendDiscordWhaleAlert(OP, sell(), db as any, 10000);
    }
    expect([f.count(OP), f.count(GONE), f.count(TOKEN), f.count(GOOD)]).toEqual([5, 1, 1, 5]);
    // In a new isolate too: the row is off.
    const fresh = await isolate();
    await fresh.d.sendDiscordWhaleAlert(OP, sell(), db as any, 10000);
    expect(f.count(GONE)).toBe(1);
    // The owner saves a link: the stop is cleared and the channel is on.
    const next = fresh.s.applyUpdate(gone, { channels: { discord: { enabled: true, webhookUrl: 'https://discord.com/api/webhooks/13/new' } } }) as StoredSettings;
    expect(next.channels.discord).toEqual({ enabled: true, webhookUrl: 'https://discord.com/api/webhooks/13/new' });
  });

  it('a channel turned off this way frees its place under the channel cap, and the read no longer serves it', async () => {
    clock();
    const { d, s } = await isolate();
    const GONE = 'https://discord.com/api/webhooks/14/gone', GOOD = 'https://discord.com/api/webhooks/15/good';
    discord((url) => (url === GONE ? discordJson(404, UNKNOWN_WEBHOOK) : new Response(null, { status: 204 })));
    const db = testD1();
    await s.saveSettings(db as any, KEY, user(s, addr('free', 0), GONE));
    await s.saveSettings(db as any, KEY, user(s, addr('free', 1), GOOD));
    expect(await s.deliverableCount(db as any)).toBe(2);
    await d.sendDiscordWhaleAlert(undefined, sell(), db as any, 10000);
    expect(await s.deliverableCount(db as any)).toBe(1);
    expect((await s.readDeliverable(db as any, KEY)).users.map((u) => u.address)).toEqual([addr('free', 1)]);
  });

  it('a block page in front of Discord (HTML 401, 403 or 404) turns no channel off: it counts against the hook and the budget only', async () => {
    clock();
    const { d, s } = await isolate();
    const urls = [401, 403, 404].map((st) => `https://discord.com/api/webhooks/20/block${st}`);
    const f = discord((url) => blockPage(Number(url.slice(-3))));
    const db = testD1();
    for (const [i, url] of urls.entries()) await s.saveSettings(db as any, KEY, user(s, addr('blk', i), url));
    for (let n = 0; n < d.BACKOFF_AFTER + 2; n++) await d.sendDiscordWhaleAlert(undefined, sell(), db as any, 10000);
    for (const url of urls) expect(f.count(url)).toBe(d.BACKOFF_AFTER);
    for (let i = 0; i < 3; i++) expect((await s.loadSettings(db as any, KEY, addr('blk', i)))!.channels.discord).toEqual({ enabled: true, webhookUrl: urls[i] });
    expect(kvJson(db, 'alerts.invalid').n).toBe(3 * d.BACKOFF_AFTER);
  });

  it('turning a channel off never overwrites a save its owner made after the row was read', async () => {
    clock();
    const { d, s } = await isolate();
    const GONE = 'https://discord.com/api/webhooks/30/gone', FIXED = 'https://discord.com/api/webhooks/31/fixed';
    const db = testD1();
    const a = addr('cas', 0);
    // The owner saves a new link while the post to the old one is on its way.
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      if (String(u) === GONE) { await s.saveSettings(db as any, KEY, user(s, a, FIXED, T0 + 7)); return discordJson(404, UNKNOWN_WEBHOOK); }
      return new Response(null, { status: 204 });
    }));
    await s.saveSettings(db as any, KEY, user(s, a, GONE));
    await d.sendDiscordWhaleAlert(undefined, sell(), db as any, 10000);
    expect((await s.loadSettings(db as any, KEY, a))!.channels.discord).toEqual({ enabled: true, webhookUrl: FIXED });
  });
});

describe('a 429 answer', () => {
  it('is waited out for its Retry-After only, until a user hook has answered 429 to RATE_LIMITED_HOLD_AFTER posts in a row: it is then held for the window, since Discord\'s bucket refills in seconds and such a hook is being filled from outside', async () => {
    const at = clock();
    const { d, s } = await isolate();
    const RL = 'https://discord.com/api/webhooks/40/ratelimited';
    const f = discord(() => rateLimited(30));
    const db = testD1();
    await s.saveSettings(db as any, KEY, user(s, addr('rl', 0), RL));
    for (const t of [0, 1_000, 31_000, 62_000, 93_000, 124_000]) { at(t); await d.sendDiscordWhaleAlert(undefined, sell(), db as any, 10000); }
    // Posted at 0, 31 and 62 s (at 1 s it was waiting out the first Retry-After); the third 429 in a row holds the hook
    // for the window, so the posts at 93 and 124 s are recorded as not sent and never leave. A 429 never backs the hook
    // off (BACKOFF_AFTER is for failures), and a hook that takes a post now and then is held all the same (a later case).
    expect(d.RATE_LIMITED_HOLD_AFTER).toBe(3);
    expect(f.count(RL)).toBe(3);
    // The three posts answered 429 were not taken either: with the three never posted (one while the first pause ran, two
    // held), all six are on record as not sent (a dispatch that cannot keep a post for later records a hook's own 429
    // rather than losing it unseen).
    expect(kvJson(db, 'alerts.skipped').total).toBe(6);
    expect(kvJson(db, 'alerts.skipped').last.what).toMatch(/held for the window/);
    // Discord counts each 429 as an invalid request, so the window's budget does too; the hold caps what one hook costs.
    expect(kvJson(db, 'alerts.invalid').n).toBe(3);
    // The next window: the hook is posted once, answered 429, and held again at once (no success since).
    at(WINDOW + 5_000);
    for (const t of [0, 31_000, 62_000]) { at(WINDOW + 5_000 + t); await d.sendDiscordWhaleAlert(undefined, sell(), db as any, 10000); }
    expect(f.count(RL)).toBe(4);
    expect(kvJson(db, 'alerts.invalid')).toMatchObject({ n: 1 });
  });

  it('the operator\'s channel waits out its Retry-After only and is never backed off for 429s', async () => {
    const at = clock();
    const { d } = await isolate();
    const f = discord(() => rateLimited(30));
    const db = testD1();
    for (const t of [0, 1_000, 31_000, 62_000, 93_000, 124_000, 155_000]) { at(t); await d.sendDiscordWhaleAlert(OP, sell(), db as any, 10000); }
    expect(f.count(OP)).toBe(6);
  });

  it('a 429 of shared scope is waited out but not charged to the budget', async () => {
    clock();
    const { d, s } = await isolate();
    const SH = 'https://discord.com/api/webhooks/41/shared';
    discord(() => rateLimited(1, 'shared'));
    const db = testD1();
    await s.saveSettings(db as any, KEY, user(s, addr('sh', 0), SH));
    await d.sendDiscordWhaleAlert(undefined, sell(), db as any, 10000);
    expect(kvJson(db, 'alerts.invalid')).toBeNull();
  });

  it('a hook that answers success and 429 in turn, posted once every 2 s, is held at its RATE_LIMITED_HOLD_AFTER-th 429 of the window: one post every 2 s never fills Discord\'s bucket, so each 429 is counted, and the successes between do not reset the count', async () => {
    // This hook used to be posted all twenty times and cost the window ten invalid answers: a success reset the count,
    // so a hook its owner keeps filling from outside, letting a post through now and then, was never held.
    const at = clock();
    const { d, s } = await isolate();
    const ALT = 'https://discord.com/api/webhooks/42/alternate';
    const f = discord((_u, nth) => (nth % 2 ? new Response(null, { status: 204 }) : rateLimited(1)));
    const db = testD1();
    await s.saveSettings(db as any, KEY, user(s, addr('alt', 0), ALT));
    for (let k = 0; k < 20; k++) { at(k * 2_000); await d.sendDiscordWhaleAlert(undefined, sell(), db as any, 10000); }
    expect(f.count(ALT)).toBe(2 * d.RATE_LIMITED_HOLD_AFTER);
    expect(kvJson(db, 'alerts.invalid').n).toBe(d.RATE_LIMITED_HOLD_AFTER);
    expect(kvJson(db, 'alerts.skipped').last.what).toMatch(/held for the window/);
  });

  it('a hook that answers success and 403 in turn still stops at BACKOFF_AFTER such answers in a window', async () => {
    const at = clock();
    const { d, s } = await isolate();
    const ALT = 'https://discord.com/api/webhooks/43/alternate403';
    const f = discord((_u, nth) => (nth % 2 ? new Response(null, { status: 204 }) : discordJson(403, MISSING_ACCESS)));
    const db = testD1();
    await s.saveSettings(db as any, KEY, user(s, addr('alt', 1), ALT));
    for (let k = 0; k < 20; k++) { at(k * 2_000); await d.sendDiscordWhaleAlert(undefined, sell(), db as any, 10000); }
    expect(f.count(ALT)).toBe(2 * d.BACKOFF_AFTER);
    expect(kvJson(db, 'alerts.invalid').n).toBe(d.BACKOFF_AFTER);
  });
});

describe('the window\'s budget of invalid answers', () => {
  it('once spent, posts go to the operator, to hooks that have worked and to settled rows; the rest are held and recorded until the next window, in every isolate', async () => {
    const at = clock();
    const { d, s } = await isolate();
    const GOOD = 'https://discord.com/api/webhooks/50/good', SETTLED = 'https://discord.com/api/webhooks/52/settled';
    const bad = (i: number) => `https://discord.com/api/webhooks/51/bad${i}`;
    const N = d.INVALID_BUDGET + 50;
    expect(N + 2).toBeLessThanOrEqual(500);
    const f = discord((url) => (url === OP || url === GOOD || url === SETTLED ? new Response(null, { status: 204 }) : discordJson(403, MISSING_ACCESS)));
    const db = testD1();
    // A subscriber who saved a working link just now, and one whose row has not changed for a day and more.
    await s.saveSettings(db as any, KEY, user(s, addr('good', 0), GOOD));
    await s.saveSettings(db as any, KEY, user(s, addr('good', 1), SETTLED, T0 - d.SETTLED_MS - 1000));
    await d.sendDiscordWhaleAlert(OP, sell(), db as any, 10000);
    for (let i = 0; i < N; i++) await s.saveSettings(db as any, KEY, user(s, addr('bad', i), bad(i)));
    at(d.USERS_CACHE_MS + 1);
    f.calls.length = 0;
    await d.sendDiscordWhaleAlert(OP, sell(), db as any, 10000);
    // the operator first; then every subscriber in one rotation, the hooks that worked among them, and of the others
    // the budget's worth
    expect(f.calls[0]).toBe(OP);
    expect(f.calls).toContain(GOOD);
    expect(f.calls).toContain(SETTLED);
    expect(f.calls.length).toBe(3 + d.INVALID_BUDGET);
    const w = Math.floor(Date.now() / WINDOW);
    expect(kvJson(db, 'alerts.invalid')).toEqual({ w, n: d.INVALID_BUDGET });
    expect(kvJson(db, 'alerts.skipped').last).toMatchObject({ n: 50, what: expect.stringContaining('50 held: invalid-answer budget spent') });
    // The next move: the operator and the working hooks only.
    f.calls.length = 0;
    await d.sendDiscordWhaleAlert(OP, sell(), db as any, 10000);
    expect(f.calls.sort()).toEqual([OP, GOOD, SETTLED].sort());
    // Another isolate reads the same count: no bad hook is posted there; the two links that worked are, since their
    // rows record the success (okAt, written by the first alert's dispatch), which proves a link in every isolate
    // (changed with the link proven at save: before, the link saved just now was held there until it worked there).
    const other = await isolate();
    f.calls.length = 0;
    await other.d.sendDiscordWhaleAlert(OP, sell(), db as any, 10000);
    expect(f.calls.sort()).toEqual([OP, GOOD, SETTLED].sort());
    // The next window: the budget again, never more.
    at(WINDOW);
    f.calls.length = 0;
    await other.d.sendDiscordWhaleAlert(OP, sell(), db as any, 10000);
    expect(f.calls.filter((u) => u.includes('/51/'))).toHaveLength(d.INVALID_BUDGET);
  }, 60_000);

  it('once the ceiling is spent, only the operator\'s channel is posted, and what is held is recorded', async () => {
    clock();
    const { d, s } = await isolate();
    const GOOD = 'https://discord.com/api/webhooks/53/good', SETTLED = 'https://discord.com/api/webhooks/54/settled';
    const f = discord(() => new Response(null, { status: 204 }));
    const db = testD1();
    await s.saveSettings(db as any, KEY, user(s, addr('ceil', 0), GOOD));
    await s.saveSettings(db as any, KEY, user(s, addr('ceil', 1), SETTLED, T0 - d.SETTLED_MS - 1000));
    await d.sendDiscordWhaleAlert(OP, sell(), db as any, 10000);
    expect(f.calls.sort()).toEqual([OP, GOOD, SETTLED].sort());
    db.raw.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('alerts.invalid', ?, ?)").run(JSON.stringify({ w: Math.floor(T0 / WINDOW), n: d.INVALID_CEILING }), T0);
    f.calls.length = 0;
    await d.sendDiscordWhaleAlert(OP, sell(), db as any, 10000);
    expect(f.calls).toEqual([OP]);
    expect(kvJson(db, 'alerts.skipped').last).toMatchObject({ n: 2, what: expect.stringContaining('2 held') });
  });
});

describe('the Settings test post', () => {
  it('has a budget of its own: while it is spent the route answers 429 for a row not saved today, posts nothing and starts no cooldown', async () => {
    const at = clock();
    const { d, s } = await isolate();
    const { app } = await import('../worker/src/api');
    const TOKEN = 'https://discord.com/api/webhooks/60/wrongtoken';
    const f = discord(() => discordJson(401, INVALID_TOKEN));
    const db = testD1();
    const a = addr('test', 0);
    const sess = (await createSession(db as any, a, 'namada', 'namada')) as Session;
    // A row saved two days ago: one saved today posts once past the spent budget (test/test-post-wallet-window.test.ts).
    await s.saveSettings(db as any, KEY, user(s, a, TOKEN, T0 - 2 * 86_400_000));
    const press = () => app.request('/api/me/settings/test', { method: 'POST', headers: { Authorization: `Bearer ${sess.token}` } }, { DB: db, SETTINGS_KEY: KEY } as any);
    db.raw.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('alerts.invalid.test', ?, ?)").run(JSON.stringify({ w: Math.floor(T0 / WINDOW), n: d.TEST_INVALID_BUDGET }), T0);
    const held = await press();
    expect(held.status).toBe(429);
    expect(((await held.json()) as any).error).toMatch(/paused/);
    expect(f.calls).toEqual([]);
    expect(kvJson(db, `webhook_test:${a}`)).toBeNull();
    // The next window: one post, its invalid answer kept in the test posts' budget, never the alerts'; the link is
    // then left alone here.
    at(WINDOW);
    const sent = await press();
    expect(await sent.json()).toEqual({ success: false });
    expect(f.calls).toEqual([TOKEN]);
    expect(kvJson(db, 'alerts.invalid.test')).toEqual({ w: Math.floor((T0 + WINDOW) / WINDOW), n: 1 });
    expect(kvJson(db, 'alerts.invalid')).toBeNull();
    at(WINDOW + 31_000);
    expect((await press()).status).toBe(429);
    expect(f.calls).toEqual([TOKEN]);
  });

  it('spends nothing of the alerts\' budget: with the alerts\' budget spent, a test post to a new link still goes', async () => {
    clock();
    const { d, s } = await isolate();
    const { app } = await import('../worker/src/api');
    const NEW = 'https://discord.com/api/webhooks/61/newlink';
    const f = discord(() => new Response(null, { status: 204 }));
    const db = testD1();
    const a = addr('test', 1);
    const sess = (await createSession(db as any, a, 'namada', 'namada')) as Session;
    await s.saveSettings(db as any, KEY, user(s, a, NEW));
    db.raw.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('alerts.invalid', ?, ?)").run(JSON.stringify({ w: Math.floor(T0 / WINDOW), n: d.INVALID_BUDGET }), T0);
    const r = await app.request('/api/me/settings/test', { method: 'POST', headers: { Authorization: `Bearer ${sess.token}` } }, { DB: db, SETTINGS_KEY: KEY } as any);
    expect(await r.json()).toEqual({ success: true });
    expect(f.calls).toEqual([NEW]);
    // A valid answer gives its unit back.
    expect(kvJson(db, 'alerts.invalid.test')).toEqual({ w: Math.floor(T0 / WINDOW), n: 0 });
  });
});
