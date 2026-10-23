// Security review (2026-10-22), alerts off after a deploy made before the SEND_ALERTS secret: only a Worker whose
// SEND_ALERTS secret is yes posts alerts, and scripts/deploy-check.sh refuses to deploy without it, but a plain
// `npm run deploy` runs no such check. A Worker deployed before the secret was put posted nothing and gave no sign:
// the health view had no row until a post that would have reached the operator's channel was dropped (a move that
// matched only a user's rule recorded nothing), and the Settings test answered { success: false }, which the page
// read as Discord refusing the user's working link. Every cron tick of such a Worker now writes a not-ok "Discord
// alert delivery" row saying alerts are off, a tick the lock skips included, and the Settings test answers 503
// "Alerts are off on this server". Once the secret is put, the next tick replaces the row.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { base64 } from '@scure/base';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class { ctx: any; env: any; constructor(ctx: any, env: any) { this.ctx = ctx; this.env = env; } },
}));
import worker from '../worker/src/index';
import { runCron, takeTickLock } from '../worker/src/cron';
import { app } from '../worker/src/api';
import { createSession, type Session } from '../worker/src/auth';
import { saveSettings, defaultPrefs, type StoredSettings } from '../worker/src/settings';
import { testD1, insert, type TestD1 } from './d1-sqlite';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const KEY = base64.encode(new Uint8Array(32).fill(5));
const OP = 'https://discord.com/api/webhooks/1/op';
const U = 'https://discord.com/api/webhooks/2/user';
const A = 'tnam1qrollout' + 'q'.repeat(32);
const PLAIN = Date.parse('2026-10-17T22:41:05Z');
/** The Sources sheet's row for the alert posts (worker/src/cron.ts ALERT_DELIVERY_HEALTH). */
const ROW = 'Discord alert delivery';

/** Discord answers every post; every other producer is down, so a tick reads nothing and posts nothing. */
let posts: string[] = [];
function network() {
  posts = [];
  vi.stubGlobal('fetch', vi.fn(async (u: RequestInfo | URL) => {
    const url = String(u);
    if (url.startsWith('https://discord.com/')) { posts.push(url); return new Response(null, { status: 204 }); }
    return new Response('down', { status: 503 });
  }));
}

const user = (): StoredSettings => {
  const notifications = defaultPrefs();
  notifications.rules.big_swap = { on: true, thresholdNam: 1 };
  return { address: A, notifications, channels: { discord: { enabled: true, webhookUrl: U } }, createdAt: Date.now(), updatedAt: Date.now() };
};

/** One cron tick under fake timers from `start`, as the scheduled entry runs it. */
async function tick(env: any, start: number) {
  vi.useFakeTimers({ now: start, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  let done = false;
  runCron(env).catch(() => {}).finally(() => { done = true; });
  for (let i = 0; !done && i < 4000; i++) await vi.advanceTimersByTimeAsync(250);
  vi.useRealTimers();
  expect(done).toBe(true);
}
const kvJson = (db: TestD1, key: string) => {
  const v = (db.raw.prepare('SELECT value FROM kv WHERE key = ?').get(key) as any)?.value;
  return v ? JSON.parse(v) : null;
};
const deliveryRow = (db: TestD1) => kvJson(db, 'source.health')?.[ROW] ?? null;
/** What deploy-check.sh's "checks and health" list prints as not ok, from the same /api/integrity answer. */
async function notOkSources(db: TestD1) {
  const res = await app.request('/api/integrity', {}, { DB: db } as any);
  const d = (await res.json()) as { sources: { name: string; ok: boolean; note?: string }[] };
  return d.sources.filter((s) => !s.ok).map((s) => `${s.name} - ${s.note ?? ''}`);
}

describe('a Worker deployed before SEND_ALERTS is put', () => {
  it('the Settings test answers 503 "Alerts are off on this server", posts nothing and starts no cooldown; with the secret it posts', async () => {
    network();
    const db = testD1();
    const s = (await createSession(db as any, A, 'namada', 'namada')) as Session;
    await saveSettings(db as any, KEY, user());
    const env = { DB: db, DISCORD_WEBHOOK_URL: OP, SETTINGS_KEY: KEY } as any; // production's secrets before the rollout
    const ctx = { waitUntil() {}, passThroughOnException() {} } as any;
    const press = (e: any) => worker.fetch!(new Request('https://namada.trade/api/me/settings/test', {
      method: 'POST', headers: { Authorization: `Bearer ${s.token}`, 'content-type': 'application/json' }, body: '{}',
    }) as any, e, ctx);

    const off = await press(env);
    expect(off.status).toBe(503);
    expect(await off.json()).toEqual({ error: 'Alerts are off on this server' });
    expect(posts).toEqual([]);
    expect(kvJson(db, `webhook_test:${A}`)).toBeNull();

    // The owner puts the secret: the next press posts at once, with no cooldown left by the refused one.
    const on = await press({ ...env, SEND_ALERTS: 'yes' });
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ success: true });
    expect(posts).toEqual([U]);
  });

  it('every cron tick writes a not-ok "Discord alert delivery" row saying alerts are off, though no post was dropped', async () => {
    network();
    const db = testD1();
    await saveSettings(db as any, KEY, user());
    await tick({ DB: db, DISCORD_WEBHOOK_URL: OP, SETTINGS_KEY: KEY }, PLAIN);
    expect(posts).toEqual([]);
    expect(kvJson(db, 'alerts.skipped')).toBeNull(); // the row is not one a dropped post wrote
    const row = deliveryRow(db);
    expect(row).toMatchObject({ name: 'Discord alert delivery', ok: false, at: PLAIN });
    expect(row.note).toContain('Off on this Worker, SEND_ALERTS is not yes');
    expect(await notOkSources(db)).toContain(`Discord alert delivery - ${row.note}`);
  });

  it('a tick the lock skips writes the row too', async () => {
    network();
    const db = testD1();
    expect(await takeTickLock(db as any, 'another-tick', PLAIN - 1000)).toBe(true);
    await tick({ DB: db, DISCORD_WEBHOOK_URL: OP, SETTINGS_KEY: KEY }, PLAIN);
    const health = kvJson(db, 'source.health');
    expect(health.cron.note).toContain('Skipped');
    expect(health[ROW]).toMatchObject({ ok: false, at: PLAIN });
  });

  it('once the secret is put, the next tick replaces the row: on when no post not sent is on record, the posts not sent as before otherwise', async () => {
    network();
    const db = testD1();
    const env = { DB: db, DISCORD_WEBHOOK_URL: OP, SETTINGS_KEY: KEY };
    await tick(env, PLAIN);
    expect(deliveryRow(db).ok).toBe(false);

    await tick({ ...env, SEND_ALERTS: 'yes' }, PLAIN + 60_000);
    expect(deliveryRow(db)).toEqual({ name: 'Discord alert delivery', ok: true, at: PLAIN + 60_000, note: 'On: this Worker posts alerts, and no post not sent is on record.' });
    expect((await notOkSources(db)).filter((s) => s.startsWith('Discord alert delivery'))).toEqual([]);

    // Posts not sent are reported as they were before the gate (sources/discord.ts postAll records them).
    insert(db, 'kv', [{ key: 'alerts.skipped', value: JSON.stringify({ total: 3, last: { what: 'whale alert', n: 2, at: PLAIN + 90_000 } }), updated_at: PLAIN + 90_000 }]);
    await tick({ ...env, SEND_ALERTS: 'yes' }, PLAIN + 120_000);
    expect(deliveryRow(db)).toEqual({ name: 'Discord alert delivery', ok: false, at: PLAIN + 90_000, note: '2 post(s) for whale alert not sent; 3 in all' });
  });
});
