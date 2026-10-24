// Security review (2026-10-22), a limit on the site's address and the hold for a hook kept rate-limited: a 429 of
// global scope, or with none of Discord's headers, cleared every hook's count toward the hold and moved each hook to
// the new window without the carry-over a hook held through the end of a window keeps. Such an answer is not counted
// against any hook, so the clearing closed nothing, and it let a wallet's hooks filled from outside escape the hold
// whenever the site's own posts to them reached Discord's limit for the site's address (50 requests a second, by
// address, for requests with no Authorization header, as a webhook post is): every alarm then halted on their parts,
// honest parts behind them starved, and the window's ceiling of invalid answers was spent. A limit on the address now
// only pauses the dispatch; each hook's count and window are its own answers' to keep. Fetch is stubbed: nothing
// reaches Discord.
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

const KEY = base64.encode(new Uint8Array(32).fill(51));
const HOOKS = 60;
const MASP = 'tnam1pcqnhjdcg9tqf2txl2em2pxm7sexlnr7ds7wfr72';
const smallSell = (n: number): Flow => ({ id: `osmosis:GR${n}:0`, chain: 'osmosis', height: n, ts: Date.now(), txHash: `GR${n}`, kind: 'sell', from: `osmo1seller${String(n).padStart(6, '0')}${'x'.repeat(25)}`, to: null, amount: 500, meta: null }) as unknown as Flow;
const unshield = (n: number): Flow => ({ id: `namada:GU${n}:0`, chain: 'namada', height: n, ts: Date.now(), txHash: `GU${n}`, kind: 'unshield', from: MASP, to: `tnam1qreceiver${String(n).padStart(4, '0')}${'z'.repeat(26)}`, amount: 60_000, meta: null }) as unknown as Flow;
const userLimited = () => new Response(JSON.stringify({ message: 'You are being rate limited.', retry_after: 2, global: false }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '2', 'x-ratelimit-scope': 'user', 'x-ratelimit-limit': '5', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '2' } });
const globalLimited = () => new Response(JSON.stringify({ message: 'You are being rate limited.', retry_after: 0.4, global: true }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '1', 'x-ratelimit-global': 'true', 'x-ratelimit-scope': 'global' } });
const ok = () => new Response(null, { status: 204, headers: { 'x-ratelimit-limit': '5', 'x-ratelimit-remaining': '4', 'x-ratelimit-reset-after': '2' } });
const everyRule = () => { const p = defaultPrefs(); for (const r of Object.values(p.rules)) { r.on = true; r.thresholdNam = 1; } return p; };
const hubOf = (db: unknown, storage: ReturnType<typeof memStorage>): any =>
  Object.assign(Object.create(LiveHub.prototype), { env: { DB: db }, ctx: { storage }, pendingN: null, pendingPosts: null, pendingNoted: null, pendingSeq: 0 });
const kvJson = (db: ReturnType<typeof testD1>, key: string) => {
  const r = db.raw.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return r ? JSON.parse(r.value) : null;
};
async function provenRow(db: ReturnType<typeof testD1>, address: string, url: string, T: number, prefs = defaultPrefs()) {
  const s: StoredSettings = { address, notifications: prefs, channels: { discord: { enabled: true, webhookUrl: url } }, createdAt: T - 3 * 86_400_000, updatedAt: T - 3 * 86_400_000 };
  expect(await saveSettings(db as any, KEY, s)).toBe(true);
  await hookOkStmt(db as any, KEY, s.address, url, T - 2 * 86_400_000).run();
}
async function alarm(hub: any, db: ReturnType<typeof testD1>, flows: Flow[], at: number) {
  vi.setSystemTime(at);
  const b = alarmBudget(Date.now() + 142_000, true);
  await hub.sendPending(b);
  if (flows.length) await hub.alertFlows(flows, 10000, 10, b);
  await flushAlerts(db as any, b);
}

describe('Security review (2026-10-22), a limit on the site\'s address and the hold for a hook kept rate-limited', () => {
  it('sixty hooks filled from outside, the site past Discord\'s 50 posts a second: the hooks are held, and the honest subscriber hears every unshield', { timeout: 300_000 }, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Math.floor(Date.UTC(2026, 9, 23, 12) / INVALID_WINDOW_MS) * INVALID_WINDOW_MS + 5_000;
    vi.setSystemTime(start);
    const db = testD1();
    configureAlerts(KEY, true);
    const T = Date.now();
    const HONEST = 'https://discord.com/api/webhooks/9510/honestreset';
    await provenRow(db, `tnam1qhonestrst${'q'.repeat(31)}`, HONEST, T);
    const hookOf = (i: number) => `https://discord.com/api/webhooks/${9520000 + i}/reset${i}`;
    for (let i = 0; i < HOOKS; i++) await provenRow(db, `tnam1qreset${String(i).padStart(4, '0')}${'q'.repeat(31)}`, hookOf(i), T, everyRule());
    // Each post takes 10 ms of the clock; Discord takes at most 50 of the site's posts in any one second.
    const perSecond = new Map<number, number>();
    let k = 0, globals = 0;
    const honestPosts: number[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      vi.setSystemTime(Date.now() + 10);
      const s = Math.floor(Date.now() / 1000);
      const n = (perSecond.get(s) ?? 0) + 1;
      perSecond.set(s, n);
      if (n > 50) { globals++; return globalLimited(); }
      if (String(u) === HONEST) { honestPosts.push(k); return ok(); }
      return userLimited();
    }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage = memStorage();
    const hub = hubOf(db, storage);
    const offered: number[] = [];
    // Sixty alarms six seconds apart (six minutes, inside one window): two small sells each, every tenth an unshield.
    for (k = 0; k < 60; k++) {
      const flows = [smallSell(1000 + 2 * k), smallSell(1001 + 2 * k)];
      if (k % 10 === 0) { offered.push(k); flows.push(unshield(100 + k)); }
      await alarm(hub, db, flows, start + 6_000 * (k + 1));
    }
    const parts = [...(await storage.list<PendingAlert>({ prefix: PENDING_PREFIX })).values()];
    const held = (await Promise.all(Array.from({ length: HOOKS }, (_, i) => testPostHeld(hookOf(i), db as any, true)))).filter((x) => x === 'limited').length;
    console.log(`honest posts at alarms ${JSON.stringify(honestPosts)} of ${JSON.stringify(offered)}; global 429s ${globals}; invalid ${kvJson(db, 'alerts.invalid')?.n}; hooks held ${held} of ${HOOKS}; parts pending ${parts.length}`);
    expect(held, 'the wallet\'s hooks are held for the window').toBe(HOOKS);
    expect(honestPosts.length, 'every honest unshield reached the honest subscriber').toBe(offered.length);
    expect(kvJson(db, 'alerts.invalid').n, 'the window\'s ceiling of invalid answers is not spent').toBeLessThan(500);
  });

  it('a hook held through the end of a window keeps its carry-over when the next window opens with a limit on the address: it is held again at its first such 429 there', { timeout: 60_000 }, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const w0 = Math.floor(Date.UTC(2026, 9, 23, 13) / INVALID_WINDOW_MS);
    vi.setSystemTime(w0 * INVALID_WINDOW_MS + 5_000);
    const db = testD1();
    configureAlerts(KEY, true);
    const T = Date.now();
    // The wallet's hook takes small sells only (its big swap rule at 1 NAM); the honest subscriber is on the default
    // rules, so a 60,000 NAM unshield reaches it alone.
    const FILLED = 'https://discord.com/api/webhooks/9530/carryfilled';
    const HONEST = 'https://discord.com/api/webhooks/9531/carryhonest';
    const swaps = defaultPrefs();
    for (const [id, r] of Object.entries(swaps.rules)) { r.on = id === 'big_swap'; r.thresholdNam = 1; }
    await provenRow(db, `tnam1qcarryfilled${'q'.repeat(29)}`, FILLED, T, swaps);
    await provenRow(db, `tnam1qcarryhonest${'q'.repeat(29)}`, HONEST, T);
    let globalNext = false;
    const answers: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      const who = String(u) === FILLED ? 'filled' : 'honest';
      if (globalNext) { globalNext = false; answers.push(`${who}:global`); return globalLimited(); }
      answers.push(`${who}:${who === 'filled' ? 429 : 204}`);
      return who === 'filled' ? userLimited() : ok();
    }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const hub = hubOf(db, memStorage());
    let at = Date.now();
    for (let k = 0; k < RATE_LIMITED_HOLD_AFTER; k++) await alarm(hub, db, [smallSell(2000 + k)], (at += 6_000));
    expect(await testPostHeld(FILLED, db as any, true), 'held in the first window').toBe('limited');
    // One more alarm of the window lets the parts kept for it go, recorded, so the next window starts with none.
    await alarm(hub, db, [], (at += 6_000));
    expect(answers.filter((a) => a.startsWith('filled'))).toHaveLength(RATE_LIMITED_HOLD_AFTER);
    // The next window opens with the honest subscriber's post answered 429 of global scope: the site's address, not
    // the hook, is limited, and the hook's count is left as its own answers made it.
    at = (w0 + 1) * INVALID_WINDOW_MS + 5_000;
    globalNext = true;
    await alarm(hub, db, [unshield(3000)], at);
    expect(answers.at(-1)).toBe('honest:global');
    // Its first 429 of the new window holds it again at once.
    await alarm(hub, db, [smallSell(3001)], (at += 6_000));
    expect(answers.at(-1)).toBe('filled:429');
    expect(await testPostHeld(FILLED, db as any, true), 'held again at its first such answer of the window').toBe('limited');
    // The honest subscriber's kept unshield is posted once the address is answered again.
    await alarm(hub, db, [], (at += 6_000));
    expect(answers.filter((a) => a === 'honest:204')).toHaveLength(1);
  });
});
