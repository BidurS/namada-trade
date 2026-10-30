// Security review (2026-10-22), a hook its owner keeps rate-limited and the pending list: a 429 paused a hook for its
// Retry-After only, the post it answered and every post that found the hook paused were handed back to the next alarm,
// and a part was let go only when every channel was posted, no row held its links, or the move was a day old.
// Discord's per-webhook bucket refills in about two seconds, so a hook that answers 429 to every post for minutes is
// being filled from outside: a wallet that saved a real webhook of its own server, set every rule at 1 NAM and posted
// to the webhook from outside at the bucket's rate made every post the site sent it answer 429, and each part kept
// for that hook was offered again at every alarm (its first post answered 429 once more, an invalid answer counted in
// the window's budget; the rest found the hook paused), written back unchanged, and kept for a day. With a few dozen
// such hooks the window's ceiling of invalid answers was spent inside the window at every alarm, so every honest post
// waited for the next window and every honest save that turned a link on was refused; and once the list held
// PENDING_POSTS_MAX posts of such parts, an honest post that any budget cut was recorded as not sent instead of kept.
// A user's hook that answers 429 to RATE_LIMITED_HOLD_AFTER posts in a row with no success between is now held for the
// window: its posts are recorded as not sent, cost the alarm nothing and never count against the ceiling again that
// window; it is held again at its first 429 of the next window until a post succeeds; and a part offered again is
// written back only when it changed. Fetch is stubbed: nothing reaches Discord.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { base64 } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { testD1 } from './d1-sqlite';
import { saveSettings, defaultPrefs, hookOkStmt, type StoredSettings } from '../worker/src/settings';
import { alarmBudget, configureAlerts, flushAlerts, INVALID_CEILING, INVALID_WINDOW_MS, RATE_LIMITED_HOLD_AFTER, type PendingAlert } from '../worker/src/sources/discord';
import { memStorage } from './do-storage';
import type { Flow } from '../shared/types';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import { LiveHub, PENDING_POSTS_MAX, PENDING_PREFIX } from '../worker/src/live-hub';
import { alertDeliveryRow } from '../worker/src/cron';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const KEY = base64.encode(new Uint8Array(32).fill(44));
const OP = 'https://discord.com/api/webhooks/301/operator';
const HONEST = 'https://discord.com/api/webhooks/9400/honest';
const HOOKS = 15;
const hook = (set: number, i: number) => `https://discord.com/api/webhooks/${9500000 + set * 1000 + i}/hammered${set}x${i}`;
const MASP = 'tnam1pcqnhjdcg9tqf2txl2em2pxm7sexlnr7ds7wfr72';
/** A 500 NAM sell: offered to the rules (100 NAM and up on Osmosis), a match for a rule at 1 NAM only, no whale. */
const smallSell = (n: number): Flow => ({ id: `osmosis:HM${n}:0`, chain: 'osmosis', height: n, ts: Date.now(), txHash: `HM${n}`, kind: 'sell', from: `osmo1seller${String(n).padStart(6, '0')}${'x'.repeat(25)}`, to: null, amount: 500, meta: null }) as unknown as Flow;
/** A 60,000 NAM unshield: a whale for the operator and a match for the default unshield rule. */
const unshield = (n: number): Flow => ({ id: `namada:HU${n}:0`, chain: 'namada', height: n, ts: Date.now(), txHash: `HU${n}`, kind: 'unshield', from: MASP, to: `tnam1qreceiver${String(n).padStart(4, '0')}${'z'.repeat(26)}`, amount: 60_000, meta: null }) as unknown as Flow;
const rateLimited = () => new Response(JSON.stringify({ message: 'You are being rate limited.', retry_after: 2, global: false }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '2', 'x-ratelimit-scope': 'user' } });
/** The channel digest the dispatcher stores in a part (discord.ts channelKey). */
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
/** `n` rows with every rule at 1 NAM, each a real webhook the save's notice took (okAt recorded) three days ago. */
async function hammered(db: ReturnType<typeof testD1>, set: number, T: number) {
  for (let i = 0; i < HOOKS; i++) {
    const s: StoredSettings = { address: `tnam1qhammer${set}${String(i).padStart(4, '0')}${'q'.repeat(29)}`, notifications: everyRule(), channels: { discord: { enabled: true, webhookUrl: hook(set, i) } }, createdAt: T - 3 * 86_400_000, updatedAt: T - 3 * 86_400_000 };
    expect(await saveSettings(db as any, KEY, s)).toBe(true);
    await hookOkStmt(db as any, KEY, s.address, hook(set, i), T - 2 * 86_400_000).run();
  }
}
const partsOf = async (storage: ReturnType<typeof memStorage>) => [...(await storage.list<PendingAlert>({ prefix: PENDING_PREFIX })).values()];

describe('Security review (2026-10-22), parts for a hook its owner keeps rate-limited', () => {
  it('fifteen such hooks: twenty moves make twenty parts, the hooks are held at their third 429 in a row, the parts drain within two more alarms with no write-back, the window costs the hooks three invalid answers each, and later windows one', { timeout: 120_000 }, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Math.floor(Date.UTC(2026, 9, 23, 9) / INVALID_WINDOW_MS) * INVALID_WINDOW_MS + 30_000);
    const db = testD1();
    configureAlerts(KEY, true);
    const T = Date.now();
    await hammered(db, 1, T);
    // The owner posts to each webhook from outside at the bucket's rate, so every post the site makes is answered 429.
    const posts: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => { posts.push(String(u)); return rateLimited(); }));
    const storage = memStorage();
    let puts = 0;
    const put = storage.put.bind(storage);
    storage.put = (k, v) => { puts++; return put(k, v); };
    const hub = hubOf(db, storage);
    // Twenty moves the rules match (natural chain activity, or the wallet's own 1 NAM moves), offered by one alarm.
    const first = alarmBudget(Date.now() + 142_000, true);
    await hub.alertFlows(Array.from({ length: 20 }, (_, i) => smallSell(i + 1)), 10000, 100, first);
    await flushAlerts(db as any, first);
    expect(await partsOf(storage)).toHaveLength(20);
    expect((await partsOf(storage)).every((p) => p.n === HOOKS && p.claims === 'all' && p.only?.length === HOOKS)).toBe(true);
    expect(posts).toHaveLength(HOOKS); // the first move's posts were answered 429; the rest found the hooks paused
    expect(kvJson(db, 'alerts.invalid').n).toBe(HOOKS);
    puts = 0;
    posts.length = 0;
    // Sixty-seven alarms, six seconds apart, each after the Retry-After is over.
    const perAlarm: number[] = [];
    const partsAfter: number[] = [];
    for (let k = 0; k < 67; k++) {
      vi.setSystemTime(Date.now() + 6_000);
      const b = alarmBudget(Date.now() + 142_000, true);
      await hub.sendPending(b);
      await flushAlerts(db as any, b);
      perAlarm.push(520 - b.posts);
      partsAfter.push((await partsOf(storage)).length);
    }
    const invalid = kvJson(db, 'alerts.invalid');
    const skipped = kvJson(db, 'alerts.skipped');
    // The second and third alarms post the first part's fifteen posts once more (429 again); at the third 429 in a row
    // each hook is held for the window, and from then on no post of the count goes to them.
    expect(perAlarm.slice(0, RATE_LIMITED_HOLD_AFTER - 1)).toEqual(Array(RATE_LIMITED_HOLD_AFTER - 1).fill(HOOKS));
    expect(perAlarm.slice(RATE_LIMITED_HOLD_AFTER - 1).every((n) => n === 0), 'a held hook costs the alarm nothing').toBe(true);
    // The parts drain: the ones found held are recorded as not sent and let go, within two alarms of the hold.
    expect(partsAfter[RATE_LIMITED_HOLD_AFTER]).toBe(0);
    expect(await partsOf(storage)).toHaveLength(0);
    expect(skipped.total).toBe(20 * HOOKS);
    expect(skipped.last.what).toMatch(/held for the window/);
    // every one of them held by the subscriber's own link: no post the site failed to send is on record, and the
    // health row stays ok (merged stage 1 review: it opened an operator incident and held /api/health at 503)
    expect(skipped.last.own).toBe(skipped.last.n);
    expect(skipped.site).toBeUndefined();
    expect(alertDeliveryRow(skipped, Date.now())).toMatchObject({ ok: true });
    expect(alertDeliveryRow(skipped, Date.now()).failedAt).toBeUndefined();
    // No part was written back unchanged.
    expect(puts, 'a part offered again is written back only when it changed').toBe(0);
    // Fifteen hooks times three answers: the hold caps what the hooks cost the window's budget.
    expect(invalid.n).toBe(HOOKS * RATE_LIMITED_HOLD_AFTER);
    expect(invalid.n).toBeLessThan(INVALID_CEILING);
    // The next window: the hold is over, each hook is posted once, answered 429 and held again at once (no success
    // since), so a window costs the hooks one invalid answer each from now on, whatever the alarms offer.
    posts.length = 0;
    vi.setSystemTime((Math.floor(Date.now() / INVALID_WINDOW_MS) + 1) * INVALID_WINDOW_MS + 6_000);
    for (let k = 0; k < 10; k++) {
      vi.setSystemTime(Date.now() + 6_000);
      const b = alarmBudget(Date.now() + 142_000, true);
      await hub.sendPending(b);
      await hub.alertFlows([smallSell(100 + k)], 10000, 100, b);
      await flushAlerts(db as any, b);
    }
    expect(posts).toHaveLength(HOOKS);
    expect(kvJson(db, 'alerts.invalid').n).toBe(HOOKS);
    expect(await partsOf(storage)).toHaveLength(0);
  });

  it('an honest subscriber beside fifteen such hooks, over twenty-five minutes of alarms: every move of theirs is posted in the alarm that offers it, the pending list stays a few parts, and the hooks cost each window a bounded count, never the ceiling', { timeout: 180_000 }, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Math.floor(Date.UTC(2026, 9, 23, 12) / INVALID_WINDOW_MS) * INVALID_WINDOW_MS + 60_000);
    const db = testD1();
    configureAlerts(KEY, true);
    const T = Date.now();
    const honest: StoredSettings = { address: `tnam1qhonest${'q'.repeat(34)}`, notifications: defaultPrefs(), channels: { discord: { enabled: true, webhookUrl: HONEST } }, createdAt: T - 3 * 86_400_000, updatedAt: T - 3 * 86_400_000 };
    expect(await saveSettings(db as any, KEY, honest)).toBe(true);
    await hookOkStmt(db as any, KEY, honest.address, HONEST, T - 2 * 86_400_000).run();
    await hammered(db, 2, T);
    const posts: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => { posts.push(String(u)); return String(u) === HONEST || String(u) === OP ? new Response(null, { status: 204 }) : rateLimited(); }));
    const storage = memStorage();
    const hub = hubOf(db, storage, OP);
    let honestMoves = 0;
    const partsSeen: number[] = [];
    const invalidByWindow = new Map<number, number>();
    // 250 alarms six seconds apart (25 minutes, two window turns): two small sells each (the hammered rules match
    // them, the honest subscriber's do not), and every tenth alarm a 60,000 NAM unshield the honest subscriber and the
    // operator hear of.
    for (let k = 0; k < 250; k++) {
      vi.setSystemTime(Date.now() + 6_000);
      const b = alarmBudget(Date.now() + 142_000, true);
      await hub.sendPending(b);
      const flows = [smallSell(1000 + 2 * k), smallSell(1001 + 2 * k)];
      if (k % 10 === 0) { honestMoves++; flows.push(unshield(100 + k)); }
      await hub.alertFlows(flows, 10000, 10, b);
      await flushAlerts(db as any, b);
      // On time: the honest post and the operator's went in the alarm that offered the move.
      expect(posts.filter((u) => u === HONEST), `alarm ${k}`).toHaveLength(honestMoves);
      expect(posts.filter((u) => u === OP), `alarm ${k}`).toHaveLength(honestMoves);
      partsSeen.push((await partsOf(storage)).length);
      const inv = kvJson(db, 'alerts.invalid');
      if (inv) invalidByWindow.set(inv.w, Math.max(inv.n, invalidByWindow.get(inv.w) ?? 0));
    }
    expect(honestMoves).toBe(25);
    // The list never holds more than the parts of the alarms before a hold (two a alarm), and is empty at the end.
    expect(Math.max(...partsSeen)).toBeLessThanOrEqual(2 * (RATE_LIMITED_HOLD_AFTER + 1));
    for (let k = 0; k < 3; k++) {
      vi.setSystemTime(Date.now() + 6_000);
      const b = alarmBudget(Date.now() + 142_000, true);
      await hub.sendPending(b);
      await flushAlerts(db as any, b);
    }
    expect(await partsOf(storage)).toHaveLength(0);
    // Three windows were touched; the first cost the hooks three answers each, the later ones one each.
    const windows = [...invalidByWindow.entries()].sort((a, b) => a[0] - b[0]);
    expect(windows.length).toBeGreaterThanOrEqual(3);
    expect(windows[0][1]).toBe(HOOKS * RATE_LIMITED_HOLD_AFTER);
    for (const [, n] of windows.slice(1)) expect(n).toBe(HOOKS);
    expect(Math.max(...windows.map(([, n]) => n))).toBeLessThan(INVALID_CEILING);
    // What was recorded as not sent names the hold, and the honest subscriber's posts were never among them.
    const skipped = kvJson(db, 'alerts.skipped');
    expect(skipped.last.what).toMatch(/held for the window/);
    expect(posts.filter((u) => u === HONEST)).toHaveLength(25);
  });

  it('one hammered hook and 50,000 parts of one post each: one alarm walks the list in seconds and writes nothing back; once the hook is held the list drains', { timeout: 300_000 }, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Math.floor(Date.UTC(2026, 9, 23, 15) / INVALID_WINDOW_MS) * INVALID_WINDOW_MS + 60_000);
    const db = testD1();
    configureAlerts(KEY, true);
    const T = Date.now();
    const s: StoredSettings = { address: `tnam1qhammer3${'q'.repeat(33)}`, notifications: everyRule(), channels: { discord: { enabled: true, webhookUrl: hook(3, 0) } }, createdAt: T - 3 * 86_400_000, updatedAt: T - 3 * 86_400_000 };
    expect(await saveSettings(db as any, KEY, s)).toBe(true);
    await hookOkStmt(db as any, KEY, s.address, hook(3, 0), T - 2 * 86_400_000).run();
    vi.stubGlobal('fetch', vi.fn(async () => rateLimited()));
    const storage = memStorage();
    const only = [channelKey(hook(3, 0))];
    for (let i = 0; i < PENDING_POSTS_MAX; i++) {
      const at = T - 20 * 3_600_000 + i * 1000;
      const p: PendingAlert = { flow: { ...smallSell(200_000 + i), ts: at }, at, n: 1, claims: 'all', only };
      await storage.put(`${PENDING_PREFIX}${String(at).padStart(14, '0')}:${String(i % 10_000).padStart(4, '0')}`, p);
    }
    let puts = 0;
    const put = storage.put.bind(storage);
    storage.put = (k, v) => { puts++; return put(k, v); };
    const hub = hubOf(db, storage);
    const started = performance.now();
    const b = alarmBudget(Date.now() + 142_000, true);
    await hub.sendPending(b);
    await flushAlerts(db as any, b);
    const walked = performance.now() - started;
    console.log(`one alarm's walk over ${PENDING_POSTS_MAX} one-post parts for one hammered hook took ${(walked / 1000).toFixed(1)} s in the test harness (memory storage), ${520 - b.posts} post(s) of the count, ${hub.pendingPosts} posts still pending, ${puts} write(s)`);
    expect(hub.pendingPosts).toBe(PENDING_POSTS_MAX);
    expect(puts).toBe(0);
    // About 3.5 s on its own, more under the whole suite's parallel load: seconds, never the alarm's deadline. Such a
    // list cannot build up any more (the hook is held at its third alarm), so this measures the walk, not a live case.
    expect(walked, 'an alarm\'s walk over the pending list leaves the scan its time').toBeLessThan(15_000);
    // Two more alarms: the hook's second and third 429 in a row, then the hold; the alarm after that drains the list.
    for (let k = 0; k < RATE_LIMITED_HOLD_AFTER; k++) {
      vi.setSystemTime(Date.now() + 6_000);
      const b2 = alarmBudget(Date.now() + 142_000, true);
      await hub.sendPending(b2);
      await flushAlerts(db as any, b2);
    }
    expect(hub.pendingPosts).toBe(0);
    expect(storage.size()).toBe(0);
    expect(kvJson(db, 'alerts.skipped').total).toBe(PENDING_POSTS_MAX);
    expect(kvJson(db, 'alerts.invalid').n).toBe(RATE_LIMITED_HOLD_AFTER);
  });
});
