// Security review (2026-10-22), a hook its owner fills from outside but lets a post through now and then: a user's hook
// was held for the window at its third 429 of user scope in a row, and any success set the count back to nothing. A
// wallet with thirty proven webhooks of its own server, every rule at 1 NAM, posting to each from outside so that two
// of every three posts the site made were answered 429 and the third was taken, was never held: each alarm still cost
// one invalid answer per hook, the window's ceiling of invalid answers was spent about half-way into every window,
// from then on every honest post waited for the next window and an honest save that turned a link on was refused, and
// the pending list grew by thousands of posts a window toward its bound, past which honest posts are lost. A 429 of
// user scope now counts toward the hold only when the site's own posts to that hook in the bucket's period were fewer
// than the bucket's limit, the count is kept per window and a success does not reset it, and every answer's
// X-RateLimit headers are read, successes included, so a hook whose bucket is known empty waits for it to refill and
// the site's own pace never draws an honest 429. Fetch is stubbed: nothing reaches Discord.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { base64 } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { testD1 } from './d1-sqlite';
import { saveSettings, defaultPrefs, hookOkStmt, type StoredSettings } from '../worker/src/settings';
import { alarmBudget, configureAlerts, flushAlerts, testPostHeld, INVALID_CEILING, INVALID_WINDOW_MS, RATE_LIMITED_HOLD_AFTER, type PendingAlert } from '../worker/src/sources/discord';
import { memStorage } from './do-storage';
import type { Flow } from '../shared/types';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import { LiveHub, PENDING_POSTS_MAX, PENDING_PREFIX } from '../worker/src/live-hub';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });

const KEY = base64.encode(new Uint8Array(32).fill(47));
const OP = 'https://discord.com/api/webhooks/303/operator';
const HOOKS = 30;
const MASP = 'tnam1pcqnhjdcg9tqf2txl2em2pxm7sexlnr7ds7wfr72';
const WATCHED = 'osmo1burstwatchedaddressxxxxxxxxxxxxxxxxxxx';
/** A 500 NAM sell: offered to the rules (100 NAM and up on Osmosis), a match for a rule at 1 NAM only, no whale. */
const smallSell = (n: number, tag = 'WS'): Flow => ({ id: `osmosis:${tag}${n}:0`, chain: 'osmosis', height: n, ts: Date.now(), txHash: `${tag}${n}`, kind: 'sell', from: `osmo1seller${String(n).padStart(6, '0')}${'x'.repeat(25)}`, to: null, amount: 500, meta: null }) as unknown as Flow;
/** A 60,000 NAM unshield: a whale for the operator and a match for the default unshield rule. */
const unshield = (n: number, tag = 'WU'): Flow => ({ id: `namada:${tag}${n}:0`, chain: 'namada', height: n, ts: Date.now(), txHash: `${tag}${n}`, kind: 'unshield', from: MASP, to: `tnam1qreceiver${String(n).padStart(4, '0')}${'z'.repeat(26)}`, amount: 60_000, meta: null }) as unknown as Flow;
/** A move of the watched address (a 500 NAM sell): a match for its watcher only. */
const watchedMove = (n: number): Flow => ({ id: `osmosis:WB${n}:0`, chain: 'osmosis', height: n, ts: Date.now(), txHash: `WB${n}`, kind: 'sell', from: WATCHED, to: null, amount: 500, meta: null }) as unknown as Flow;
/** Discord's 429 for a hook's own bucket with a Retry-After and scope user only, no bucket headers. */
const userLimited = () => new Response(JSON.stringify({ message: 'You are being rate limited.', retry_after: 2, global: false }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '2', 'x-ratelimit-scope': 'user' } });
const ok = () => new Response(null, { status: 204 });
const channelKey = (url: string) => bytesToHex(sha256(new TextEncoder().encode(url))).slice(0, 32);
const everyRule = () => {
  const p = defaultPrefs();
  for (const r of Object.values(p.rules)) { r.on = true; r.thresholdNam = 1; }
  return p;
};
const hubOf = (db: unknown, storage: ReturnType<typeof memStorage>, op?: string): any =>
  Object.assign(Object.create(LiveHub.prototype), { env: { DB: db, DISCORD_WEBHOOK_URL: op }, ctx: { storage }, pendingN: null, pendingPosts: null, pendingNoted: null, pendingSeq: 0 });
const kvJson = (db: ReturnType<typeof testD1>, key: string) => {
  const r = db.raw.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return r ? JSON.parse(r.value) : null;
};
const partsOf = async (storage: ReturnType<typeof memStorage>) => [...(await storage.list<PendingAlert>({ prefix: PENDING_PREFIX })).values()];
/** A proven row (the save's notice taken two days ago) for `url`, on the default rules or `prefs`. */
async function provenRow(db: ReturnType<typeof testD1>, address: string, url: string, T: number, prefs = defaultPrefs()) {
  const s: StoredSettings = { address, notifications: prefs, channels: { discord: { enabled: true, webhookUrl: url } }, createdAt: T - 3 * 86_400_000, updatedAt: T - 3 * 86_400_000 };
  expect(await saveSettings(db as any, KEY, s)).toBe(true);
  await hookOkStmt(db as any, KEY, s.address, url, T - 2 * 86_400_000).run();
}
/** One alarm six seconds after the last: the pending list first, then `flows`, then the dispatch's records. */
async function alarm(hub: any, db: ReturnType<typeof testD1>, flows: Flow[]) {
  vi.setSystemTime(Date.now() + 6_000);
  const b = alarmBudget(Date.now() + 142_000, true);
  await hub.sendPending(b);
  if (flows.length) await hub.alertFlows(flows, 10000, 10, b);
  await flushAlerts(db as any, b);
}
/**
 * Discord's bucket for one webhook, as a stub: `limit` posts in a period that starts at the first post into an empty
 * bucket, then 429 of user scope (with Retry-After and the bucket's headers) until it refills. `headers`: whether a
 * post Discord takes says the bucket's state too (X-RateLimit-Limit, -Remaining, -Reset-After), as Discord's does.
 */
function bucket(limit = 5, periodMs = 2000, headers = true) {
  let start = -Infinity, used = 0;
  const answers: number[] = [];
  const answer = () => {
    const now = Date.now();
    if (now >= start + periodMs) { start = now; used = 0; }
    const after = (start + periodMs - now) / 1000;
    const state = { 'x-ratelimit-limit': String(limit), 'x-ratelimit-reset-after': after.toFixed(3) };
    if (used >= limit) {
      answers.push(429);
      return new Response(JSON.stringify({ message: 'You are being rate limited.', retry_after: after, global: false }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': String(Math.max(1, Math.ceil(after))), 'x-ratelimit-scope': 'user', ...state, 'x-ratelimit-remaining': '0' } });
    }
    used++;
    answers.push(204);
    return new Response(null, { status: 204, headers: headers ? { ...state, 'x-ratelimit-remaining': String(limit - used) } : {} });
  };
  return { answer, answers };
}

describe('Security review (2026-10-22), a hook its owner fills from outside but lets a post through now and then', () => {
  it('thirty hooks answering two 429s of user scope and then a success, over three windows beside an honest subscriber: each hook is held within the first window, the window\'s ceiling is never near, every honest alert goes in the alarm that offers it, the pending list stays a few parts, and an honest save is never refused', { timeout: 300_000 }, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Math.floor(Date.UTC(2026, 9, 23, 12) / INVALID_WINDOW_MS) * INVALID_WINDOW_MS + 5_000);
    const db = testD1();
    configureAlerts(KEY, true);
    const T = Date.now();
    const HONEST = 'https://discord.com/api/webhooks/9410/honestwin';
    await provenRow(db, `tnam1qhonestwin${'q'.repeat(31)}`, HONEST, T);
    const hookOf = (i: number) => `https://discord.com/api/webhooks/${9710000 + i}/gapwin${i}`;
    for (let i = 0; i < HOOKS; i++) await provenRow(db, `tnam1qgapwin${String(i).padStart(4, '0')}${'q'.repeat(30)}`, hookOf(i), T, everyRule());
    const count = new Map<string, number>();
    const honestPosts: number[] = [];
    let k = 0;
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      const url = String(u);
      if (url === OP) return ok();
      if (url === HONEST) { honestPosts.push(k); return ok(); }
      const c = (count.get(url) ?? 0) + 1;
      count.set(url, c);
      return c % 3 === 0 ? ok() : userLimited();
    }));
    const storage = memStorage();
    const hub = hubOf(db, storage, OP);
    const offered: number[] = [];
    const partsSeen: number[] = [];
    const invalidByWindow = new Map<number, number>();
    const saveHeld: (string | false)[] = [];
    const w0 = Math.floor(Date.now() / INVALID_WINDOW_MS);
    let postsInFirstWindow = 0;
    // 250 alarms six seconds apart (25 minutes, three windows): two small sells each, which the thirty rows match and
    // the honest subscriber's rules do not, and every tenth alarm a 60,000 NAM unshield the honest subscriber hears of.
    for (k = 0; k < 250; k++) {
      const flows = [smallSell(1000 + 2 * k), smallSell(1001 + 2 * k)];
      if (k % 10 === 0) { offered.push(k); flows.push(unshield(100 + k)); }
      await alarm(hub, db, flows);
      partsSeen.push((await partsOf(storage)).length);
      const inv = kvJson(db, 'alerts.invalid');
      if (inv) invalidByWindow.set(inv.w, Math.max(inv.n, invalidByWindow.get(inv.w) ?? 0));
      if (Math.floor(Date.now() / INVALID_WINDOW_MS) === w0) postsInFirstWindow = [...count.values()].reduce((s, n) => s + n, 0);
      if (k % 50 === 49) saveHeld.push(await testPostHeld(`https://discord.com/api/webhooks/9810/newcomer${k}`, db as any, false, true));
    }
    const windows = [...invalidByWindow.entries()].sort((a, b) => a[0] - b[0]);
    console.log(`thirty gapped hooks over 250 alarms: invalid answers by window ${JSON.stringify(windows.map(([, n]) => n))}, posts to them in the first window ${postsInFirstWindow}, most parts pending ${Math.max(...partsSeen)}, honest posts ${honestPosts.length} of ${offered.length}`);
    // Every honest alert went in the alarm that offered it, and so did the operator's.
    expect(honestPosts, 'every honest move posted in the alarm that offered it').toEqual(offered);
    // Each hook was held within the first window: at most its two 429s, its success and its third counted 429 there.
    expect(postsInFirstWindow).toBeLessThanOrEqual(HOOKS * (RATE_LIMITED_HOLD_AFTER + 1));
    // The first window cost the hooks at most three invalid answers each, each later window at most one: the ceiling
    // is never near.
    expect(windows.length).toBeGreaterThanOrEqual(3);
    expect(windows[0][1]).toBeLessThanOrEqual(HOOKS * RATE_LIMITED_HOLD_AFTER);
    for (const [, n] of windows.slice(1)) expect(n).toBeLessThanOrEqual(HOOKS);
    expect(Math.max(...windows.map(([, n]) => n))).toBeLessThan(INVALID_CEILING / 4);
    // The pending list holds only the parts of the alarms before the hold (two a alarm), and drains.
    expect(Math.max(...partsSeen)).toBeLessThanOrEqual(2 * (RATE_LIMITED_HOLD_AFTER + 2));
    for (let j = 0; j < 3; j++) await alarm(hub, db, []);
    expect(await partsOf(storage)).toHaveLength(0);
    // A newcomer's save was never held by the site's budget.
    expect(saveHeld).toEqual([false, false, false, false, false]);
  });

  it('the same hooks with the pending list near its bound (about fifteen hours of such windows before the fix): the list drains once the hooks are held, and every honest alert is sent in the alarm that offers it', { timeout: 600_000 }, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Math.floor(Date.UTC(2026, 9, 24, 3) / INVALID_WINDOW_MS) * INVALID_WINDOW_MS + 2_000);
    const db = testD1();
    configureAlerts(KEY, true);
    const T = Date.now();
    const HONEST = 'https://discord.com/api/webhooks/9411/honestfull';
    await provenRow(db, `tnam1qhonestful${'q'.repeat(31)}`, HONEST, T);
    const hookOf = (i: number) => `https://discord.com/api/webhooks/${9720000 + i}/gapfull${i}`;
    for (let i = 0; i < HOOKS; i++) await provenRow(db, `tnam1qgapfull${String(i).padStart(4, '0')}${'q'.repeat(29)}`, hookOf(i), T, everyRule());
    const count = new Map<string, number>();
    const honestPosts: number[] = [];
    let k = 0;
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      const url = String(u);
      if (url === OP) return ok();
      if (url === HONEST) { honestPosts.push(k); return ok(); }
      const c = (count.get(url) ?? 0) + 1;
      count.set(url, c);
      return c % 3 === 0 ? ok() : userLimited();
    }));
    // The list as such windows left it: parts of the wallet's hooks, close to the bound.
    const storage = memStorage();
    const only = Array.from({ length: HOOKS }, (_, i) => channelKey(hookOf(i)));
    const seeded = Math.floor((PENDING_POSTS_MAX - 200) / HOOKS);
    for (let i = 0; i < seeded; i++) {
      const at = T - 15 * 3_600_000 + i * 30_000;
      const p: PendingAlert = { flow: { ...smallSell(300_000 + i, 'WF'), ts: at }, at, n: HOOKS, claims: 'all', only };
      await storage.put(`${PENDING_PREFIX}${String(at).padStart(14, '0')}:${String(i % 10_000).padStart(4, '0')}`, p);
    }
    const hub = hubOf(db, storage, OP);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const offered: number[] = [];
    const end = (Math.floor(T / INVALID_WINDOW_MS) + 2) * INVALID_WINDOW_MS;
    for (k = 0; Date.now() + 6_000 < end; k++) {
      const flows = k % 4 === 0 ? [smallSell(700_000 + k, 'WF')] : [];
      if (k % 10 === 0 && k < 90) { offered.push(k); flows.push(unshield(70_000 + k, 'WH')); }
      await alarm(hub, db, flows);
    }
    const skipped = kvJson(db, 'alerts.skipped');
    const refusedKeep = errors.mock.calls.filter((c) => String(c[0]).includes('could not be kept for the next alarm')).length;
    console.log(`near-full list: honest posts ${honestPosts.length} of ${offered.length}; pending ${hub.pendingPosts}; parts the list refused ${refusedKeep}; not sent ${JSON.stringify(skipped)}`);
    expect(honestPosts, 'every honest alert was sent in the alarm that offered it').toEqual(offered);
    expect(refusedKeep, 'no part was refused by a full list').toBe(0);
    expect(hub.pendingPosts).toBeLessThan(HOOKS * 4);
  });

  it('thirty hooks whose owner fills each bucket from outside so the site\'s post is taken with nothing left (X-RateLimit-Remaining 0), two of the wallet\'s moves an alarm: each hook is held within the first window, the pending list stays a few parts, and every honest alert goes in the alarm that offers it', { timeout: 300_000 }, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Math.floor(Date.UTC(2026, 9, 23, 18) / INVALID_WINDOW_MS) * INVALID_WINDOW_MS + 5_000);
    const db = testD1();
    configureAlerts(KEY, true);
    const T = Date.now();
    const HONEST = 'https://discord.com/api/webhooks/9413/honestdrain';
    await provenRow(db, `tnam1qhonestdrn${'q'.repeat(31)}`, HONEST, T);
    const hookOf = (i: number) => `https://discord.com/api/webhooks/${9730000 + i}/drained${i}`;
    for (let i = 0; i < HOOKS; i++) await provenRow(db, `tnam1qdrained${String(i).padStart(4, '0')}${'q'.repeat(29)}`, hookOf(i), T, everyRule());
    // Each hook's bucket (5 posts every 2 s): the owner posts 4 times into it from outside just before the site's
    // first post, so that post is taken and leaves nothing; any later post in the same bucket is answered 429.
    const buckets = new Map<string, number>();
    const honestPosts: number[] = [];
    let k = 0, limitedAnswers = 0;
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      const url = String(u);
      if (url === OP) return ok();
      if (url === HONEST) { honestPosts.push(k); return ok(); }
      const now = Date.now();
      const start = buckets.get(url);
      const state = (s: number) => ({ 'x-ratelimit-limit': '5', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': ((s + 2000 - now) / 1000).toFixed(3) });
      if (start == null || now >= start + 2000) {
        buckets.set(url, now);
        return new Response(null, { status: 204, headers: state(now) });
      }
      limitedAnswers++;
      return new Response(JSON.stringify({ message: 'You are being rate limited.', retry_after: 2, global: false }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '2', 'x-ratelimit-scope': 'user', ...state(start) } });
    }));
    const storage = memStorage();
    const hub = hubOf(db, storage, OP);
    const offered: number[] = [];
    const partsSeen: number[] = [];
    // 90 alarms six seconds apart, inside one window: two small sells each, and every tenth an honest unshield.
    for (k = 0; k < 90; k++) {
      const flows = [smallSell(4000 + 2 * k, 'WD'), smallSell(4001 + 2 * k, 'WD')];
      if (k % 10 === 0) { offered.push(k); flows.push(unshield(400 + k, 'WE')); }
      await alarm(hub, db, flows);
      partsSeen.push((await partsOf(storage)).length);
    }
    const inv = kvJson(db, 'alerts.invalid');
    console.log(`thirty drained hooks: ${limitedAnswers} answered 429, invalid answers ${inv?.n ?? 0}, most parts pending ${Math.max(...partsSeen)}, parts at the end ${partsSeen[partsSeen.length - 1]}, honest posts ${honestPosts.length} of ${offered.length}`);
    expect(honestPosts).toEqual(offered);
    expect(Math.max(...partsSeen), 'the pending list stays a few parts').toBeLessThanOrEqual(2 * (RATE_LIMITED_HOLD_AFTER + 2));
    expect(partsSeen[partsSeen.length - 1]).toBe(0);
    expect(inv?.n ?? 0).toBeLessThan(INVALID_CEILING / 4);
    for (let i = 0; i < HOOKS; i++) expect(await testPostHeld(hookOf(i), db as any, true)).toBe('limited');
  });

  it('an honest hook that the site itself bursts past its bucket is never held, whether Discord\'s answers say the bucket\'s state or not: twelve moves of one batch, four alarms running, all reach the watcher, now or kept for a later alarm', { timeout: 120_000 }, async () => {
    for (const headers of [true, false]) {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Math.floor(Date.UTC(2026, 9, 23, 16, headers ? 0 : 30) / INVALID_WINDOW_MS) * INVALID_WINDOW_MS + 5_000);
      const db = testD1();
      configureAlerts(KEY, true);
      const T = Date.now();
      const HONEST = `https://discord.com/api/webhooks/9412/burst${headers ? 'headers' : 'bare'}`;
      const p = defaultPrefs();
      p.watchlist = [WATCHED];
      await provenRow(db, `tnam1qburst${headers ? 'hd' : 'br'}${'q'.repeat(30)}`, HONEST, T, p);
      const b = bucket(5, 2000, headers);
      const titles: string[] = [];
      vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => {
        if (String(u) !== HONEST) return ok();
        const r = b.answer();
        if (r.status === 204) titles.push(String(JSON.parse(String(init?.body)).embeds[0].url));
        return r;
      }));
      const storage = memStorage();
      const hub = hubOf(db, storage);
      let n = 0;
      // Four alarms in a row each offer twelve moves of the watched address (a busy batch), then quiet alarms.
      for (let a = 0; a < 4; a++) await alarm(hub, db, Array.from({ length: 12 }, () => watchedMove(++n + (headers ? 0 : 1000))));
      for (let a = 0; a < 12 && (await partsOf(storage)).length; a++) await alarm(hub, db, []);
      const limited = b.answers.filter((s) => s === 429).length;
      console.log(`burst (${headers ? 'bucket headers on every answer' : 'no headers on a success'}): ${titles.length} of ${n} posted, ${limited} answered 429, held: ${await testPostHeld(HONEST, db as any, true)}`);
      expect(titles, 'every move reached the watcher once').toHaveLength(48);
      expect(new Set(titles).size).toBe(48);
      expect(await partsOf(storage)).toHaveLength(0);
      expect(kvJson(db, 'alerts.skipped'), 'nothing recorded as not sent').toBeNull();
      expect(await testPostHeld(HONEST, db as any, true)).not.toBe('limited');
      // With the bucket's headers on every answer the site waits for the bucket and is never answered 429; without
      // them it bursts past and is, once a burst, and none of those 429s counts toward the hold.
      if (headers) expect(limited).toBe(0);
      else expect(limited).toBeGreaterThanOrEqual(RATE_LIMITED_HOLD_AFTER);
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
