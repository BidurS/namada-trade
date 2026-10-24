// Security review (2026-10-22), Settings test posts and the shared test budget: the budget was 50 invalid answers a
// window, shared by every wallet, with no bound per wallet beyond a 30 s cooldown, so three free wallets each saving
// a made-up link and testing it every 30 s spent the budget early in every window, and every honest wallet's test of
// a working link was answered 429 and blamed ("paused for this link"). A wallet whose test was answered invalid now
// waits for the next window; a link with a recorded success tests without a unit of the shared budget; the budget is
// 500 (spending it takes 500 wallets with saved rows); when it is spent the answer says test posts are paused
// site-wide, not that the link is at fault; and a wallet whose row was saved today tests once past the spent budget
// anyway (the link is proven by the save, so the test post is no longer a gate, and the most such posts a window is
// the rows the site keeps at all, USER_ROWS_MAX, under Discord's limit with the alerts' ceiling). Fetch is stubbed:
// nothing reaches Discord.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { base64 } from '@scure/base';
import { testD1 } from './d1-sqlite';
import type { StoredSettings } from '../worker/src/settings';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const KEY = base64.encode(new Uint8Array(32).fill(23));
const WINDOW = 10 * 60_000;
const HONEST = 'https://discord.com/api/webhooks/702/honest';
const PROVEN = 'https://discord.com/api/webhooks/703/proven';
const OLD = 'https://discord.com/api/webhooks/704/old';
const addr = (tag: string, i: number) => `tnam1q${tag}${String(i).padStart(5, '0')}${'q'.repeat(30)}`;
const gone = () => new Response(JSON.stringify({ message: 'Unknown Webhook', code: 10015 }), { status: 404, headers: { 'content-type': 'application/json' } });

async function isolate() {
  vi.useFakeTimers({ toFake: ['Date'] });
  const T0 = (Math.floor(Date.now() / WINDOW) + 1) * WINDOW + 1000;
  vi.setSystemTime(T0);
  vi.resetModules();
  const d = await import('../worker/src/sources/discord');
  const s = await import('../worker/src/settings');
  const api = await import('../worker/src/api');
  const { createSession } = await import('../worker/src/auth');
  d.configureAlerts(KEY);
  const db = testD1();
  const env = { DB: db, SETTINGS_KEY: KEY } as any;
  const token = async (a: string) => ((await createSession(db as any, a, 'namada', 'namada')) as { token: string }).token;
  const test = (tok: string) => api.app.request('/api/me/settings/test', { method: 'POST', headers: { Authorization: `Bearer ${tok}` } }, env);
  const save = (tok: string, link: string, enabled = false) => api.app.request('/api/me/settings', { method: 'PUT', headers: { Authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify({ channels: { discord: { enabled, webhookUrl: link } } }) }, env);
  const units = () => JSON.parse((db.raw.prepare("SELECT value FROM kv WHERE key = 'alerts.invalid.test'").get() as any)?.value ?? 'null')?.n ?? 0;
  return { d, s, api, db, env, T0, token, test, save, units };
}

describe('Security review (2026-10-22), Settings test posts: a few wallets and the shared test budget', () => {
  it('three wallets testing made-up links every 30 s each wait for the next window after one invalid answer, and an honest wallet still tests its working link', { timeout: 120_000 }, async () => {
    const { d, s, api, db, token, test, save, units } = await isolate();
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      calls.push(String(u));
      if (String(u) === HONEST) return new Response(null, { status: 204 });
      return gone();
    }));
    const W = 3;
    const tokens: string[] = [];
    for (let i = 0; i < W; i++) tokens.push(await token(addr('few', i)));
    let k = 0;
    const answers: number[] = [];
    // Each wallet saves a fresh link (Discord off, so no channel place) and tests it, every 30 s, for 9 minutes.
    for (let round = 0; round < 18; round++) {
      for (let i = 0; i < W; i++) {
        const link = `https://discord.com/api/webhooks/${900000 + k++}/gone`;
        expect((await save(tokens[i], link)).status).toBe(200);
        const r = await test(tokens[i]);
        answers.push(r.status);
        if (round === 1 && i === 0) expect(((await r.json()) as any).error).toMatch(/wait for the next 10-minute window/);
      }
      vi.setSystemTime(Date.now() + 30_000);
    }
    // One post each, answered invalid: three units of the budget, and 429 for the rest of the window.
    expect(calls.filter((u) => u.includes('/gone'))).toHaveLength(W);
    expect(answers.filter((x) => x === 200)).toHaveLength(W);
    expect(units()).toBe(W);
    // An honest wallet saves a working link and tests it, in the same window.
    const a = addr('honest', 0);
    const row: StoredSettings = { address: a, notifications: s.defaultPrefs(), channels: { discord: { enabled: true, webhookUrl: HONEST } }, createdAt: Date.now(), updatedAt: Date.now() };
    expect(await s.saveSettings(db as any, KEY, row)).toBe(true);
    const r = await test(await token(a));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ success: true });
    // The next window: a waiting wallet may test again.
    vi.setSystemTime((Math.floor(Date.now() / WINDOW) + 1) * WINDOW + 1000);
    expect((await test(tokens[0])).status).toBe(200);
    expect(calls.filter((u) => u.includes('/gone'))).toHaveLength(W + 1);
    void api; void d;
  });

  it('a link with a recorded success tests while the shared budget is spent, taking no unit; a row saved today tests once anyway, then waits for the next window; an older row without a success is told test posts are paused site-wide, not that it is at fault', { timeout: 60_000 }, async () => {
    const { d, s, db, T0, token, test, units } = await isolate();
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => { calls.push(String(u)); return new Response(null, { status: 204 }); }));
    const proven = addr('proven', 0), fresh = addr('fresh', 0), old = addr('old', 0);
    for (const [a, link, at] of [[proven, PROVEN, T0], [fresh, HONEST, T0], [old, OLD, T0 - 2 * 86_400_000]] as const) {
      const row: StoredSettings = { address: a, notifications: s.defaultPrefs(), channels: { discord: { enabled: true, webhookUrl: link } }, createdAt: at, updatedAt: at };
      expect(await s.saveSettings(db as any, KEY, row)).toBe(true);
    }
    // One successful test post is recorded in the proven row.
    expect(await (await test(await token(proven))).json()).toEqual({ success: true });
    expect(await s.linkProven(db as any, KEY, proven, PROVEN)).toBe(true);
    expect(units()).toBe(0);
    // The shared budget is spent for the window (by other wallets, in other isolates).
    db.raw.prepare("INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES ('alerts.invalid.test', ?, ?)").run(JSON.stringify({ w: Math.floor(Date.now() / WINDOW), n: d.TEST_INVALID_BUDGET }), Date.now());
    vi.resetModules(); // a fresh isolate: the proof is the row's, not this isolate's memory
    const d2 = await import('../worker/src/sources/discord');
    d2.configureAlerts(KEY);
    const api2 = await import('../worker/src/api');
    const env = { DB: db, SETTINGS_KEY: KEY } as any;
    const test2 = (tok: string) => api2.app.request('/api/me/settings/test', { method: 'POST', headers: { Authorization: `Bearer ${tok}` } }, env);
    vi.setSystemTime(Date.now() + 31_000);
    expect(await (await test2(await token(proven))).json()).toEqual({ success: true });
    expect(units()).toBe(d.TEST_INVALID_BUDGET); // no unit taken, none given back
    // The row saved today: its test goes once, taking no unit, and the wallet then waits for the next window.
    const freshTok = await token(fresh);
    expect(await (await test2(freshTok)).json()).toEqual({ success: true });
    expect(calls.filter((u) => u === HONEST)).toHaveLength(1);
    expect(units()).toBe(d.TEST_INVALID_BUDGET);
    vi.setSystemTime(Date.now() + 31_000);
    const again = await test2(freshTok);
    expect(again.status).toBe(429);
    expect(((await again.json()) as any).error).toMatch(/wait for the next 10-minute window/);
    expect(calls.filter((u) => u === HONEST)).toHaveLength(1);
    // The row saved two days ago, with no success recorded: held, and told the hold is the site's.
    const held = await test2(await token(old));
    expect(held.status).toBe(429);
    const why = ((await held.json()) as any).error as string;
    expect(why).toBe(api2.TEST_SITE_BUSY);
    expect(why).toMatch(/site-wide/);
    expect(why).toMatch(/not at fault/);
    expect(calls.filter((u) => u === OLD)).toHaveLength(0);
    expect(d.TEST_INVALID_BUDGET).toBe(500);
    expect(d.TEST_INVALID_BUDGET + d.INVALID_CEILING).toBeLessThanOrEqual(2000); // a fifth of Discord's 10,000 in 10 minutes
    // The next window: the wallet saved today may test again.
    vi.setSystemTime((Math.floor(Date.now() / WINDOW) + 1) * WINDOW + 1000);
    expect((await test2(freshTok)).status).toBe(200);
  });
});
