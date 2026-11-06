// The Namada halt of 2026-11-02: the words shown and posted (shared/halt.ts), the alerts' pause (sources/discord.ts
// sendsAlerts, ALERTS_PAUSED) and what it says in the health view, and the one notice posted once per place
// (worker/src/halt-notice.ts).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HALT, HALT_NOTICE } from '../shared/halt';
import { configureAlerts, sendsAlerts, alertsPausedIn, PAUSED_NOTE } from '../worker/src/sources/discord';
import { alertDeliveryOff } from '../worker/src/cron';
import { offOnPurpose } from '../worker/src/ops';
import { prepareDigests } from '../worker/src/digest/deliver';
import { repostNamada, xLength, xSafe } from '../worker/src/sources/x';
import { defaultPrefs, saveSettings, type StoredSettings } from '../worker/src/settings';
import { postHaltNotice, postsHaltNotice, HALT_NOTICE_TRIES } from '../worker/src/halt-notice';
import { testD1 } from './d1-sqlite';
import type { Env } from '../worker/src/util';

const HOOK = 'https://discord.com/api/webhooks/1/abc';
const KEY = 'DQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0=';
const X_KEYS = { X_API_KEY: 'k', X_API_SECRET: 's', X_ACCESS_TOKEN: '1-t', X_ACCESS_SECRET: 'a' };
const prodEnv = (db: D1Database, extra: Partial<Env> = {}): Env =>
  ({ DB: db, SEND_ALERTS: 'yes', ALERTS_PAUSED: HALT.id, SETTINGS_KEY: KEY, DISCORD_WEBHOOK_URL: HOOK, TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_OWNER_CHAT: '42', ...extra }) as Env;

type Answer = () => Response | Promise<Response>;
const ok204: Answer = () => new Response(null, { status: 204 });
const tgOk: Answer = () => Response.json({ ok: true, result: {} });
const xOk: Answer = () => Response.json({ data: { id: '99' } }, { status: 201 });
/** Answers Discord, Telegram and X as given, and records every call by host. */
function net(discord: Answer = ok204, telegram: Answer = tgOk, x: Answer = xOk) {
  const calls: { host: string; body: any }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const host = new URL(url).host;
    calls.push({ host, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (host === 'discord.com') return discord();
    if (host === 'api.telegram.org') return telegram();
    if (host === 'api.x.com') return x();
    return new Response('unexpected', { status: 500 });
  }));
  return calls;
}
const hosts = (calls: { host: string }[], h: string) => calls.filter((c) => c.host === h);

/** A subscriber with Telegram linked to `chat`, saved as the site saves one. */
async function subscriber(db: D1Database, chat: number, quiet: { start: number; end: number } | null = null) {
  const row: StoredSettings = {
    address: `tnam1qhalt${String(chat).padStart(5, '0')}${'q'.repeat(32)}`,
    notifications: { ...defaultPrefs(), quietHoursUtc: quiet },
    channels: { discord: { enabled: false, webhookUrl: null }, telegram: { enabled: true, chatId: chat, kind: 'private', title: null, linkedAt: 1 } },
    createdAt: 1,
    updatedAt: 1,
  };
  expect(await saveSettings(db, KEY, row)).toBe(true);
}

afterEach(() => { vi.unstubAllGlobals(); configureAlerts(undefined, true, false); });

describe('the halt words', () => {
  it('are the approved words, attributed', () => {
    expect(HALT.title).toBe('Namada is halted');
    expect(HALT.said).toBe('The Namada team says it has found the cause of the 2 November halt, is working on a fix and hopes to be ready to restart the network in the week of 9 November.');
    expect(HALT.source).toBe('Adrian Brink in the Namada Discord, 6 November 2026');
    expect(HALT.here).toBe('No new Namada data arrives while the network is halted; Osmosis prices and trades keep updating. Alerts on Discord, X and Telegram are paused until the network is back.');
    expect(HALT_NOTICE).toBe('Namada is halted. The Namada team says it has found the cause of the 2 November halt and is working on a fix (Adrian Brink, Namada Discord, 6 November). NamadaTrade alerts are paused until the network is back.');
  });

  it('the notice fits one post on X, carries no link and mentions no one', () => {
    expect(xLength(HALT_NOTICE)).toBeLessThanOrEqual(280);
    expect(xSafe(HALT_NOTICE)).toBe(HALT_NOTICE);
    expect(HALT_NOTICE).not.toMatch(/https?:|@|#/);
  });
});

describe('the pause', () => {
  it('holds every alert while ALERTS_PAUSED is set, and only then', () => {
    expect(sendsAlerts({ SEND_ALERTS: 'yes' })).toBe(true);
    expect(sendsAlerts({ SEND_ALERTS: 'yes', ALERTS_PAUSED: HALT.id })).toBe(false);
    expect(sendsAlerts({ ALERTS_PAUSED: HALT.id })).toBe(false);
    expect(alertsPausedIn({ SEND_ALERTS: 'yes', ALERTS_PAUSED: HALT.id })).toBe(true);
    expect(alertsPausedIn({ ALERTS_PAUSED: HALT.id })).toBe(false);
  });

  it('the alert delivery row says the alerts are paused, and reads as turned off on purpose', () => {
    const row = alertDeliveryOff({ SEND_ALERTS: 'yes', ALERTS_PAUSED: HALT.id }, 1)!;
    expect(row.note).toMatch(/paused \(ALERTS_PAUSED\)/);
    expect(offOnPurpose(row.note)).toBe(true);
    expect(alertDeliveryOff({}, 1)!.note).toMatch(/SEND_ALERTS is not yes/);
    expect(alertDeliveryOff({ SEND_ALERTS: 'yes' }, 1)).toBeNull();
  });

  it("the digest's row says the alerts are paused, and reads as turned off on purpose", async () => {
    configureAlerts(undefined, false, true);
    const run = await prepareDigests(testD1(), Date.UTC(2026, 10, 3, 12, 0), false);
    expect(run.rows.length).toBeGreaterThan(0);
    for (const r of run.rows) { expect(r.note).toBe(PAUSED_NOTE); expect(offOnPurpose(r.note)).toBe(true); }
    configureAlerts(undefined, false, false);
    const off = await prepareDigests(testD1(), Date.UTC(2026, 10, 3, 12, 0), false);
    expect(off.rows[0].note).toMatch(/SEND_ALERTS is not yes/);
  });

  it("a paused tick forgets where @namada's posts stood, so nothing posted during the pause is reposted after it", async () => {
    const db = testD1();
    await db.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('x.repost.since', '123', 1)").run();
    const calls = net();
    configureAlerts(undefined, false, true);
    expect(await repostNamada({ DB: db, ...X_KEYS })).toBe(0);
    expect(calls).toHaveLength(0);
    expect(await db.prepare("SELECT value FROM kv WHERE key = 'x.repost.since'").first()).toBeNull();
  });
});

describe('the one notice', () => {
  it('is posted only by production while this halt pauses the alerts', async () => {
    expect(postsHaltNotice({ SEND_ALERTS: 'yes', ALERTS_PAUSED: HALT.id })).toBe(true);
    expect(postsHaltNotice({ SEND_ALERTS: 'yes', ALERTS_PAUSED: 'another-pause' })).toBe(false);
    expect(postsHaltNotice({ ALERTS_PAUSED: HALT.id })).toBe(false);
    const calls = net();
    expect(await postHaltNotice(prodEnv(testD1(), { SEND_ALERTS: undefined, ...X_KEYS }))).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('goes once to the Discord channel, the X account and each Telegram chat, never twice', async () => {
    const db = testD1();
    await subscriber(db, 77);
    const calls = net();
    const e = prodEnv(db, { TELEGRAM_CHANNEL: '@namadatrade', ...X_KEYS });
    expect(await postHaltNotice(e)).toBe(5);
    const discord = hosts(calls, 'discord.com');
    expect(discord).toHaveLength(1);
    expect(discord[0].body.content).toBe(HALT_NOTICE);
    expect(discord[0].body.allowed_mentions).toEqual({ parse: [] });
    const x = hosts(calls, 'api.x.com');
    expect(x).toHaveLength(1);
    expect(x[0].body).toEqual({ text: HALT_NOTICE });
    const tg = hosts(calls, 'api.telegram.org');
    expect(tg.map((c) => String(c.body.chat_id)).sort()).toEqual(['42', '77', '@namadatrade']);
    expect(tg.every((c) => c.body.text === HALT_NOTICE && c.body.parse_mode == null)).toBe(true);
    // The next ticks post nothing again.
    expect(await postHaltNotice(e)).toBe(0);
    expect(calls).toHaveLength(5);
  });

  it("names Telegram chats in kv by a keyed digest only, and one chat named twice (the operator's and a subscriber's) hears it once", async () => {
    const db = testD1();
    await subscriber(db, 42);
    const calls = net();
    await postHaltNotice(prodEnv(db, { DISCORD_WEBHOOK_URL: undefined }));
    expect(hosts(calls, 'api.telegram.org')).toHaveLength(1);
    const keys = (await db.prepare("SELECT key FROM kv WHERE key LIKE 'halt:%'").all<{ key: string }>()).results.map((r) => r.key);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(new RegExp(`^halt:${HALT.id}:tg:[0-9a-f]{32}:1$`));
    // Under another settings key the same chat has another name: a copy of the database cannot be checked for a chat id.
    const db2 = testD1();
    net();
    await postHaltNotice(prodEnv(db2, { DISCORD_WEBHOOK_URL: undefined, SETTINGS_KEY: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=' }));
    const keys2 = (await db2.prepare("SELECT key FROM kv WHERE key LIKE 'halt:%'").all<{ key: string }>()).results.map((r) => r.key);
    expect(keys2[0]).not.toBe(keys[0]);
    // Without the key, no Telegram chat is posted to.
    const calls3 = net();
    await postHaltNotice(prodEnv(testD1(), { DISCORD_WEBHOOK_URL: undefined, SETTINGS_KEY: undefined }));
    expect(calls3).toHaveLength(0);
  });

  it("leaves a subscriber's chat inside their quiet hours for a later tick, unclaimed", async () => {
    const db = testD1();
    await subscriber(db, 77, { start: 0, end: 23 });
    const calls = net();
    await postHaltNotice(prodEnv(db, { DISCORD_WEBHOOK_URL: undefined, TELEGRAM_OWNER_CHAT: undefined }), Date.UTC(2026, 10, 3, 3, 0));
    expect(calls).toHaveLength(0);
    expect((await db.prepare("SELECT COUNT(*) n FROM kv WHERE key LIKE 'halt:%'").first<{ n: number }>())!.n).toBe(0);
    await postHaltNotice(prodEnv(db, { DISCORD_WEBHOOK_URL: undefined, TELEGRAM_OWNER_CHAT: undefined }), Date.UTC(2026, 10, 3, 23, 30));
    expect(hosts(calls, 'api.telegram.org')).toHaveLength(1);
  });

  it('tries a place again only when its answer proves the notice was not taken, at most HALT_NOTICE_TRIES times', async () => {
    const db = testD1();
    const calls = net(() => new Response('busy', { status: 503 }), () => Response.json({ ok: false, description: 'Forbidden: bot was blocked by the user' }, { status: 403 }));
    expect(await postHaltNotice(prodEnv(db))).toBe(0);
    expect(calls).toHaveLength(2);
    for (let i = 1; i < HALT_NOTICE_TRIES + 2; i++) await postHaltNotice(prodEnv(db));
    // Telegram refused (403): never again. Discord was busy (503): again, until HALT_NOTICE_TRIES claims.
    expect(hosts(calls, 'api.telegram.org')).toHaveLength(1);
    expect(hosts(calls, 'discord.com')).toHaveLength(HALT_NOTICE_TRIES);
    // A place taken on a later try is done.
    const db2 = testD1();
    let n = 0;
    const calls2 = net(() => (n++ === 0 ? new Response('busy', { status: 502 }) : new Response(null, { status: 204 })));
    await postHaltNotice(prodEnv(db2, { TELEGRAM_BOT_TOKEN: undefined }));
    expect(await postHaltNotice(prodEnv(db2, { TELEGRAM_BOT_TOKEN: undefined }))).toBe(1);
    await postHaltNotice(prodEnv(db2, { TELEGRAM_BOT_TOKEN: undefined }));
    expect(calls2).toHaveLength(2);
  });

  it('never posts again to Discord or Telegram after an answer that may have posted: no answer in time, a 500', async () => {
    const db = testD1();
    const calls = net(() => { throw new DOMException('timed out', 'TimeoutError'); }, () => new Response('oops', { status: 500 }));
    await postHaltNotice(prodEnv(db));
    for (let i = 0; i < 3; i++) await postHaltNotice(prodEnv(db));
    expect(hosts(calls, 'discord.com')).toHaveLength(1);
    expect(hosts(calls, 'api.telegram.org')).toHaveLength(1);
  });

  it('on X, tries no answer again (X refuses a text it already has) and stops at a refusal such as no credits', async () => {
    const db = testD1();
    let n = 0;
    const calls = net(ok204, tgOk, () => (n++ === 0 ? new Response('busy', { status: 503 }) : Response.json({ title: 'CreditsDepleted' }, { status: 402 })));
    const e = prodEnv(db, { DISCORD_WEBHOOK_URL: undefined, TELEGRAM_BOT_TOKEN: undefined, ...X_KEYS });
    for (let i = 0; i < 4; i++) await postHaltNotice(e);
    expect(hosts(calls, 'api.x.com')).toHaveLength(2);
  });

  it('two passes at once post once per place', async () => {
    const db = testD1();
    const calls = net();
    const e = prodEnv(db, { ...X_KEYS });
    await Promise.all([postHaltNotice(e), postHaltNotice(e)]);
    expect(hosts(calls, 'discord.com')).toHaveLength(1);
    expect(hosts(calls, 'api.x.com')).toHaveLength(1);
    expect(hosts(calls, 'api.telegram.org')).toHaveLength(1);
  });

  it('a claim never answered (a tick cut off mid-post) is never posted again', async () => {
    const db = testD1();
    await db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?1, ?2, ?3)').bind(`halt:${HALT.id}:discord:1`, JSON.stringify({ claimed: 1 }), 1).run();
    const calls = net();
    await postHaltNotice(prodEnv(db, { TELEGRAM_BOT_TOKEN: undefined }));
    expect(calls).toHaveLength(0);
  });

  it('leaves X out while its kill switch is off', async () => {
    const db = testD1();
    await db.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('x.on', '0', 1)").run();
    const calls = net();
    await postHaltNotice(prodEnv(db, { DISCORD_WEBHOOK_URL: undefined, TELEGRAM_BOT_TOKEN: undefined, ...X_KEYS }));
    expect(calls).toHaveLength(0);
  });
});
