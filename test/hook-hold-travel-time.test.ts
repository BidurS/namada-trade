// Security review (2026-10-22), an honest burst to one hook when Discord's answers take time: the hold read the
// bucket's start as the answer's arrival here plus X-RateLimit-Reset-After less the bucket's period, and counted the
// site's own posts started since then (less BUCKET_SLACK_MS). Discord measures Reset-After when the post reaches it,
// so that start came out late by the time Discord spent on the post and the answer's way back: an honest watcher whose
// fifth post of a burst Discord answered in over about half a second was read as a bucket filled from elsewhere, held
// after three such bursts, and the rest of the window's alerts to it were recorded as not sent. The start is now read
// from the answered post's own start, so only the difference between two posts' ways to Discord is left for the
// slack. A hook filled from outside is still held. Discord's bucket is modelled at Discord's end, with each post's way
// there and its answer's way back moving the clock. Fetch is stubbed: nothing reaches Discord.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { base64 } from '@scure/base';
import { testD1 } from './d1-sqlite';
import { saveSettings, defaultPrefs, hookOkStmt, type StoredSettings } from '../worker/src/settings';
import { alarmBudget, configureAlerts, flushAlerts, testPostHeld, INVALID_WINDOW_MS, RATE_LIMITED_HOLD_AFTER, type PendingAlert } from '../worker/src/sources/discord';
import { memStorage } from './do-storage';
import type { Flow } from '../shared/types';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import { LiveHub, PENDING_PREFIX } from '../worker/src/live-hub';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });

const KEY = base64.encode(new Uint8Array(32).fill(61));
const WATCHED = 'osmo1latencywatchedaddressxxxxxxxxxxxxxxxxx';
let seq = 0;
const watchedMove = (): Flow => { const n = ++seq; return ({ id: `osmosis:LT${n}:0`, chain: 'osmosis', height: n, ts: Date.now(), txHash: `LT${n}`, kind: 'sell', from: WATCHED, to: null, amount: 500, meta: null }) as unknown as Flow; };
/** A 500 NAM sell of its own seller: a match for a rule at 1 NAM only. */
const smallSell = (): Flow => { const n = ++seq; return ({ id: `osmosis:LS${n}:0`, chain: 'osmosis', height: n, ts: Date.now(), txHash: `LS${n}`, kind: 'sell', from: `osmo1seller${String(n).padStart(6, '0')}${'x'.repeat(25)}`, to: null, amount: 500, meta: null }) as unknown as Flow; };
const hubOf = (db: unknown, storage: ReturnType<typeof memStorage>): any =>
  Object.assign(Object.create(LiveHub.prototype), { env: { DB: db, DISCORD_WEBHOOK_URL: undefined }, ctx: { storage }, pendingN: null, pendingPosts: null, pendingNoted: null, pendingSeq: 0 });
const kvJson = (db: ReturnType<typeof testD1>, key: string) => {
  const r = db.raw.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return r ? JSON.parse(r.value) : null;
};
const partsOf = async (storage: ReturnType<typeof memStorage>) => [...(await storage.list<PendingAlert>({ prefix: PENDING_PREFIX })).values()];
async function alarm(hub: any, db: ReturnType<typeof testD1>, flows: Flow[]) {
  vi.setSystemTime(Date.now() + 6_000);
  const b = alarmBudget(Date.now() + 142_000, true);
  await hub.sendPending(b);
  if (flows.length) await hub.alertFlows(flows, 10000, 10, b);
  await flushAlerts(db as any, b);
}
async function provenRow(db: ReturnType<typeof testD1>, address: string, url: string, T: number, prefs = defaultPrefs()) {
  const s: StoredSettings = { address, notifications: prefs, channels: { discord: { enabled: true, webhookUrl: url } }, createdAt: T - 3 * 86_400_000, updatedAt: T - 3 * 86_400_000 };
  expect(await saveSettings(db as any, KEY, s)).toBe(true);
  await hookOkStmt(db as any, KEY, s.address, url, T - 2 * 86_400_000).run();
}

/**
 * Discord's bucket for one webhook (5 posts every 2 s from the first post into an empty bucket), with its headers on
 * every answer, computed when the post reaches Discord (`out` ms after it leaves); the answer comes back `proc(i)` +
 * `back` ms after that. The clock is moved here, so the site sees each post's time on the way as Discord would give it.
 * `outside(start)`: posts from elsewhere already in a bucket that begins at `start` (a hook its owner fills).
 */
function discord(proc: (i: number) => number, out = 50, back = 50, outside: (start: number) => number = () => 0) {
  let start = -Infinity, used = 0, i = 0;
  const answers: number[] = [];
  const answer = async () => {
    vi.setSystemTime(Date.now() + out);
    const now = Date.now();
    if (now >= start + 2000) { start = now; used = outside(start); }
    const after = ((start + 2000 - now) / 1000).toFixed(3);
    let r: Response;
    if (used >= 5) {
      answers.push(429);
      r = new Response(JSON.stringify({ message: 'You are being rate limited.', retry_after: Number(after), global: false }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': String(Math.max(1, Math.ceil(Number(after)))), 'x-ratelimit-scope': 'user', 'x-ratelimit-limit': '5', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': after } });
    } else {
      used++;
      answers.push(204);
      r = new Response(null, { status: 204, headers: { 'x-ratelimit-limit': '5', 'x-ratelimit-remaining': String(5 - used), 'x-ratelimit-reset-after': after } });
    }
    vi.setSystemTime(Date.now() + proc(i++) + back);
    return r;
  };
  return { answer, answers };
}

async function run(proc: (i: number) => number, alarms: number, perAlarm: number, tag: string) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Math.floor(Date.UTC(2026, 9, 25, 8) / INVALID_WINDOW_MS) * INVALID_WINDOW_MS + 5_000);
  const db = testD1();
  configureAlerts(KEY, true);
  const T = Date.now();
  const HONEST = `https://discord.com/api/webhooks/9512/latency${tag}`;
  const p = defaultPrefs();
  p.watchlist = [WATCHED];
  await provenRow(db, `tnam1qlatency${tag}${'q'.repeat(30 - tag.length)}`, HONEST, T, p);
  const d = discord(proc);
  const taken: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => {
    if (String(u) !== HONEST) return new Response(null, { status: 204 });
    const r = await d.answer();
    if (r.status === 204) taken.push(String(JSON.parse(String(init?.body)).embeds[0].url));
    return r;
  }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const storage = memStorage();
  const hub = hubOf(db, storage);
  let offered = 0;
  for (let a = 0; a < alarms; a++) { await alarm(hub, db, Array.from({ length: perAlarm }, () => watchedMove())); offered += perAlarm; }
  for (let a = 0; a < 40 && (await partsOf(storage)).length; a++) await alarm(hub, db, []);
  const r = { offered, taken: taken.length, limited: d.answers.filter((x) => x === 429).length, held: await testPostHeld(HONEST, db as any, true), skipped: kvJson(db, 'alerts.skipped'), parts: (await partsOf(storage)).length };
  vi.restoreAllMocks();
  return r;
}

describe('Security review (2026-10-22), an honest burst to one hook when Discord\'s answers take time', () => {
  it('a watcher of a busy address, six of its moves an alarm for three alarms, every answer 0.25 s but the fifth of each burst 0.7 s: every move reaches the watcher, now or kept for a later alarm', { timeout: 60_000 }, async () => {
    // Posts are answered in 0.25 s (50 ms each way and 150 ms at Discord), so five posts fill the bucket in 1.3 s; the
    // fifth post of each alarm, the one Discord answers with nothing left, takes 600 ms at Discord.
    const r = await run((i) => (i % 5 === 4 ? 600 : 150), 3, 6, 'slow5');
    console.log(`slow fifth answer: ${r.taken} of ${r.offered} posted, ${r.limited} answered 429, held ${r.held}, parts left ${r.parts}, not sent ${JSON.stringify(r.skipped)}`);
    expect(r.held, 'the honest hook is never held as filled from elsewhere').not.toBe('limited');
    expect(r.skipped, 'nothing the watcher is entitled to is recorded as not sent').toBeNull();
    expect(r.taken).toBe(r.offered);
  });

  it('the same watcher over one window, six moves an alarm, answers 0.15 to 0.35 s with one in twenty at 0.7 s (seeded): every move reaches the watcher', { timeout: 120_000 }, async () => {
    let x = 12345;
    const rand = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
    const r = await run(() => (rand() < 0.05 ? 600 : 50 + Math.floor(rand() * 200)), 90, 6, 'seeded');
    console.log(`seeded latency: ${r.taken} of ${r.offered} posted, ${r.limited} answered 429, held ${r.held}, parts left ${r.parts}, not sent ${JSON.stringify(r.skipped)}`);
    expect(r.held, 'the honest hook is never held as filled from elsewhere').not.toBe('limited');
    expect(r.skipped, 'nothing the watcher is entitled to is recorded as not sent').toBeNull();
    expect(r.taken).toBe(r.offered);
  });

  it('thirty alarms of five moves, the request 50 ms to Discord and the answer 200 ms back, one in seven 600 ms: the hook is never held, and every move reaches it', { timeout: 120_000 }, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Math.floor(Date.UTC(2026, 9, 23, 21) / INVALID_WINDOW_MS) * INVALID_WINDOW_MS + 5_000);
    const db = testD1();
    configureAlerts(KEY, true);
    const T = Date.now();
    const HONEST = 'https://discord.com/api/webhooks/9700/latencywatch';
    const p = defaultPrefs();
    p.watchlist = [WATCHED];
    await provenRow(db, `tnam1qlatency${'q'.repeat(32)}`, HONEST, T, p);
    // Discord's bucket for the hook, kept at Discord's end: 5 posts in a period of 2 s from the first post that
    // reaches an empty bucket. The request takes 50 ms to reach it; the answer 200 ms to come back, one in seven 600 ms.
    let start = -Infinity, used = 0, calls = 0, limited = 0;
    const delivered = new Set<string>();
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) => {
      const i = calls++;
      const at = Date.now() + 50;
      if (at >= start + 2000) { start = at; used = 0; }
      const after = ((start + 2000 - at) / 1000).toFixed(3);
      vi.setSystemTime(at + (i % 7 === 6 ? 600 : 200));
      if (used >= 5) {
        limited++;
        return new Response(JSON.stringify({ message: 'You are being rate limited.', retry_after: Number(after), global: false }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': String(Math.max(1, Math.ceil(Number(after)))), 'x-ratelimit-scope': 'user', 'x-ratelimit-limit': '5', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': after } });
      }
      used++;
      delivered.add(String(JSON.parse(String(init?.body)).embeds[0].url));
      return new Response(null, { status: 204, headers: { 'x-ratelimit-limit': '5', 'x-ratelimit-remaining': String(5 - used), 'x-ratelimit-reset-after': after } });
    }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage = memStorage();
    const hub = hubOf(db, storage);
    // Thirty alarms six seconds apart, five moves of the watched address each (a busy stretch), then quiet alarms.
    let offered = 0, next = Date.now();
    for (let a = 0; a < 40; a++) {
      next += 6_000;
      vi.setSystemTime(Math.max(next, Date.now()));
      const flows = a < 30 ? Array.from({ length: 5 }, watchedMove) : [];
      offered += flows.length;
      const b = alarmBudget(Date.now() + 142_000, true);
      await hub.sendPending(b);
      if (flows.length) await hub.alertFlows(flows, 10000, 10, b);
      await flushAlerts(db as any, b);
    }
    const held = await testPostHeld(HONEST, db as any, true);
    console.log(`busy honest hook: ${delivered.size} of ${offered} moves delivered, ${limited} answered 429, held: ${held}, not sent ${JSON.stringify(kvJson(db, 'alerts.skipped'))}`);
    expect(held).not.toBe('limited');
    expect(delivered.size).toBe(offered);
  });

  for (const [name, outside] of [['every post of its bucket taken from elsewhere', 5], ['four of its five taken from elsewhere, so the site\'s post empties it', 4]] as const) {
    it(`a hook its owner fills from outside (${name}), with the same ways to Discord and back: it is still held within ${RATE_LIMITED_HOLD_AFTER} alarms, and the honest watcher beside it hears every move`, { timeout: 60_000 }, async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Math.floor(Date.UTC(2026, 9, 25, 10 + outside) / INVALID_WINDOW_MS) * INVALID_WINDOW_MS + 5_000);
      const db = testD1();
      configureAlerts(KEY, true);
      const T = Date.now();
      const FILLED = `https://discord.com/api/webhooks/9513/filled${outside}`;
      const HONEST = `https://discord.com/api/webhooks/9514/besidefilled${outside}`;
      const every = defaultPrefs();
      for (const rule of Object.values(every.rules)) { rule.on = true; rule.thresholdNam = 1; }
      await provenRow(db, `tnam1qfilled${outside}${'q'.repeat(31)}`, FILLED, T, every);
      const p = defaultPrefs();
      p.watchlist = [WATCHED];
      await provenRow(db, `tnam1qbesidefilled${outside}${'q'.repeat(26)}`, HONEST, T, p);
      // The owner's own posts are in each bucket of the hook before the site's: the site's post is answered 429, or
      // taken as the post that leaves the bucket empty.
      const filled = discord(() => 100, 50, 100, () => outside);
      const honest = discord(() => 100);
      const heard: string[] = [];
      vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => {
        if (String(u) === FILLED) return filled.answer();
        const r = await honest.answer();
        if (r.status === 204) heard.push(String(JSON.parse(String(init?.body)).embeds[0].url));
        return r;
      }));
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const storage = memStorage();
      const hub = hubOf(db, storage);
      let watched = 0;
      for (let a = 0; a < 8; a++) { await alarm(hub, db, [smallSell(), watchedMove()]); watched++; }
      for (let a = 0; a < 5 && (await partsOf(storage)).length; a++) await alarm(hub, db, []);
      console.log(`filled from outside (${outside} of 5): its answers ${JSON.stringify(filled.answers)}, held ${await testPostHeld(FILLED, db as any, true)}; the watcher heard ${heard.length} of ${watched}`);
      expect(await testPostHeld(FILLED, db as any, true), 'the hook filled from outside is held for the window').toBe('limited');
      expect(filled.answers.length, 'posted to at most once an alarm until it is held').toBeLessThanOrEqual(RATE_LIMITED_HOLD_AFTER);
      expect(heard.length, 'the honest watcher hears every move').toBe(watched);
      expect(await partsOf(storage)).toHaveLength(0);
    });
  }
});
