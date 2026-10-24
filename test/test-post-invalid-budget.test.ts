// Security review (2026-10-22), Settings test posts and the invalid-answer budget: a test post read the window's count
// of invalid Discord answers, posted, and only then added its own answer, so test posts sent at the same moment all
// read the same count and nothing was reserved before posting. INVALID_CEILING + 1 signed-in wallets, each with a link
// that only has the shape of a webhook (Discord can stay off, so they take no channel place), sending one test post
// each at the same moment, were all posted, and their answers spent the alerts' ceiling: the next whale alert reached
// the operator only, and a subscriber whose row had been settled for two days was held for the rest of the window.
// A test post now takes one unit of a budget of its own before it is posted, by one statement that adds it only while
// the budget has room, and gives it back on a valid answer; the alerts' budget is never spent by test posts. A row
// saved today posts once past the spent budget (the save proves the link, so the test is no longer a gate; such a
// wallet then waits for the next window), so the most test posts a window is bounded by the rows the site keeps
// (settings.ts USER_ROWS_MAX), under Discord's limit with the alerts' ceiling. Fetch is stubbed: nothing reaches
// Discord.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { base64 } from '@scure/base';
import { testD1, type TestD1 } from './d1-sqlite';
import type { StoredSettings } from '../worker/src/settings';
import type { Flow } from '../shared/types';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const KEY = base64.encode(new Uint8Array(32).fill(11));
const WINDOW = 10 * 60_000;
const OP = 'https://discord.com/api/webhooks/700/operator';
const SETTLED = 'https://discord.com/api/webhooks/701/settled';
const fake = (i: number) => `https://discord.com/api/webhooks/${800000 + i}/gone${i}`;
const addr = (tag: string, i: number) => `tnam1q${tag}${String(i).padStart(5, '0')}${'q'.repeat(30)}`;
const kvJson = (db: TestD1, key: string) => {
  const r = db.raw.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return r ? JSON.parse(r.value) : null;
};

describe('Security review (2026-10-22), Settings test posts sent together', () => {
  it('INVALID_CEILING + 1 test posts at once to links Discord says are gone: rows saved today each post once, nothing of the alerts\' budget is spent, and the next alert still reaches a settled subscriber; rows older than a day stop at the test budget', { timeout: 120_000 }, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const T0 = (Math.floor(Date.now() / WINDOW) + 1) * WINDOW + 1000;
    vi.setSystemTime(T0);
    vi.resetModules();
    const d = await import('../worker/src/sources/discord');
    const s = await import('../worker/src/settings');
    const { app } = await import('../worker/src/api');
    const { createSession } = await import('../worker/src/auth');
    d.configureAlerts(KEY);
    const db = testD1();

    // A subscriber whose row has not changed for two days, whose rule matches the whale below.
    const p = s.defaultPrefs();
    p.rules.big_swap = { on: true, thresholdNam: 1 };
    const settled: StoredSettings = { address: addr('settled', 0), notifications: p, channels: { discord: { enabled: true, webhookUrl: SETTLED } }, createdAt: T0 - 2 * 86400000, updatedAt: T0 - 2 * 86400000 };
    expect(await s.saveSettings(db as any, KEY, settled)).toBe(true);

    // INVALID_CEILING + 1 wallets, each with a link saved two days ago and Discord off (a row saved today posts once
    // past the budget, below).
    const N = d.INVALID_CEILING + 1;
    const tokens: string[] = [];
    for (let i = 0; i < N; i++) {
      const a = addr('race', i);
      const row: StoredSettings = { address: a, notifications: s.defaultPrefs(), channels: { discord: { enabled: false, webhookUrl: fake(i) } }, createdAt: T0 - 2 * 86400000, updatedAt: T0 - 2 * 86400000 };
      expect(await s.saveSettings(db as any, KEY, row)).toBe(true);
      tokens.push(((await createSession(db as any, a, 'namada', 'namada')) as { token: string }).token);
    }

    // Discord answers each post after a short while, as it does, so the test posts sent together are all in flight
    // before the first answer comes back.
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      const url = String(u);
      calls.push(url);
      await new Promise((r) => setTimeout(r, 30));
      if (url === OP || url === SETTLED) return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ message: 'Unknown Webhook', code: 10015 }), { status: 404, headers: { 'content-type': 'application/json' } });
    }));
    const env = { DB: db, SETTINGS_KEY: KEY } as any;
    const answers = await Promise.all(tokens.map((t) => app.request('/api/me/settings/test', { method: 'POST', headers: { Authorization: `Bearer ${t}` } }, env)));
    const posted = calls.length;
    // Test posts stop at their own budget (raised from 50 to 500 with the per-wallet wait, so it no longer sits inside
    // INVALID_BUDGET; what matters is that the alerts' budget below is untouched).
    expect(posted).toBe(d.TEST_INVALID_BUDGET);
    expect(posted).toBeLessThan(N);
    expect(answers.filter((r) => r.status === 200)).toHaveLength(posted);
    expect(answers.filter((r) => r.status === 429)).toHaveLength(N - posted);
    // The alerts' budget is untouched.
    expect(kvJson(db, 'alerts.invalid')?.n ?? 0).toBeLessThan(d.INVALID_BUDGET);
    // Three wallets whose rows were saved today: each posts once past the spent budget, taking no unit, and then
    // waits for the next window; the alerts' budget is still untouched.
    const fresh: string[] = [];
    for (let i = 0; i < 3; i++) {
      const a = addr('fresh', i);
      const row: StoredSettings = { address: a, notifications: s.defaultPrefs(), channels: { discord: { enabled: false, webhookUrl: fake(5000 + i) } }, createdAt: T0, updatedAt: T0 };
      expect(await s.saveSettings(db as any, KEY, row)).toBe(true);
      fresh.push(((await createSession(db as any, a, 'namada', 'namada')) as { token: string }).token);
    }
    const once = await Promise.all(fresh.map((t) => app.request('/api/me/settings/test', { method: 'POST', headers: { Authorization: `Bearer ${t}` } }, env)));
    expect(once.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(calls.length).toBe(posted + 3);
    expect(kvJson(db, 'alerts.invalid.test').n).toBe(d.TEST_INVALID_BUDGET);
    vi.setSystemTime(Date.now() + 31_000);
    // The second try: the link Discord said is gone is paused here for a day, and the wallet waits for the next window
    // in any case; nothing more is posted.
    const twice = await app.request('/api/me/settings/test', { method: 'POST', headers: { Authorization: `Bearer ${fresh[0]}` } }, env);
    expect(twice.status).toBe(429);
    expect(calls.length).toBe(posted + 3);
    // The wallet's cooldown row holds the wait until the window turns, with its reason after the time (api.ts waitForWindow).
    const [waitFrom, waitWhy] = String((db.raw.prepare('SELECT value FROM kv WHERE key = ?').get(`webhook_test:${addr('fresh', 0)}`) as { value: string }).value).split(':');
    expect(Number(waitFrom)).toBe((Math.floor(Date.now() / WINDOW) + 1) * WINDOW - 30_000);
    expect(waitWhy).toBe('invalid');
    expect(kvJson(db, 'alerts.invalid')?.n ?? 0).toBeLessThan(d.INVALID_BUDGET);

    // A whale alert straight after: the operator and the settled subscriber both hear it.
    calls.length = 0;
    const whale: Flow = { id: 'osmosis:RACE1:0', chain: 'osmosis', height: 1, ts: T0, txHash: 'RACE1', kind: 'sell', from: 'osmo1yl6hdjhmkf37639730gffanpzndzdpmhxy9ep3', to: null, amount: 20000, meta: null } as Flow;
    await d.sendDiscordWhaleAlert(OP, whale, db as any, 10000);
    expect(calls).toContain(OP);
    expect(calls).toContain(SETTLED);
    expect(kvJson(db, 'alerts.skipped')).toBeNull();
  });
});
