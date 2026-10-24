// Security review (2026-10-22), Discord channel places: the cap on channels (DELIVERABLE_MAX) counted rows with
// Discord on, while the dispatcher posts once per link and turns a channel off only after Discord answers that its
// link is gone. A row with Discord on and every rule off is never posted to, so never answered and never turned off,
// and many rows sharing one link make one post or none: 500 free sign-ins with one shared link and every rule off
// held every place for good, and every later subscriber was refused (409 CHANNELS_FULL) with no expiry. Places are
// now counted by link (a keyed digest of the link beside `on`), and a place is held only by a proven link: the save
// that turns a link on posts a connection notice to it and turns the channel on only when Discord takes it
// (test/link-proven-at-save.test.ts), so a made-up link holds nothing and a row with Discord on holds its place for
// good. The read serves DELIVERABLE_MAX channels, first saved first. Fetch is stubbed: nothing reaches Discord.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { testD1, type TestD1 } from './d1-sqlite';
import { saveSettings, readDeliverable, deliverableCount, defaultPrefs, DELIVERABLE_MAX, type StoredSettings } from '../worker/src/settings';
import * as settings from '../worker/src/settings';
import { configureAlerts, sendDiscordForumAlert, sendDiscordWhaleAlert } from '../worker/src/sources/discord';
import { app } from '../worker/src/api';
import { createSession, type Session } from '../worker/src/auth';
import type { Flow, ForumPost } from '../shared/types';

const KEY = 'DQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0=';
const DAY = 86_400_000;
const SHARED = 'https://discord.com/api/webhooks/5000/shared';
const NEWCOMER = 'https://discord.com/api/webhooks/5001/newcomer';
const GOOD = 'https://discord.com/api/webhooks/5002/good';
let t = 0;

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const addr = (tag: string, i: number) => `tnam1q${tag}${String(i).padStart(5, '0')}${'q'.repeat(30)}`;
/** A row with Discord on and every rule, the watchlist and forum alerts off: nothing is ever posted to it. */
const silent = (address: string, webhookUrl: string): StoredSettings => {
  const n = defaultPrefs();
  for (const r of Object.values(n.rules)) r.on = false;
  n.watchlistOn = false;
  n.forumAndGov = false;
  return { address, notifications: n, channels: { discord: { enabled: true, webhookUrl } }, createdAt: t, updatedAt: t };
};
const active = (address: string, webhookUrl: string): StoredSettings => {
  const n = defaultPrefs();
  n.forumAndGov = true;
  n.rules.big_swap = { on: true, thresholdNam: 1 };
  return { address, notifications: n, channels: { discord: { enabled: true, webhookUrl } }, createdAt: t, updatedAt: t };
};
const post = (id: number) => ({ id, topicId: 1, topicTitle: 'x', postNumber: 2, username: 'u', displayName: null, excerpt: '', url: 'https://forum.namada.net/t/x/1', createdAt: '2026-10-22T00:00:00Z', isNewTopic: false }) as unknown as ForumPost;
const sell = (n: number) => ({ id: `osmosis:PLACE${n}:0`, chain: 'osmosis', height: n, ts: t, txHash: `PLACE${n}`, kind: 'sell', from: 'osmo1yl6hdjhmkf37639730gffanpzndzdpmhxy9ep3', to: null, amount: 20000, meta: null }) as unknown as Flow;
function discord() {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (u: string) => { calls.push(String(u)); return new Response(null, { status: 204 }); }));
  return calls;
}
const put = (db: TestD1, s: Session, body: unknown) =>
  app.request('/api/me/settings', { method: 'PUT', headers: { Authorization: `Bearer ${s.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }, { DB: db, SETTINGS_KEY: KEY } as any);

describe('Security review (2026-10-22), channel places are counted by link', () => {
  it('500 rows with Discord on, one shared link and every rule off: a newcomer saves Discord on, is served, and can save again after the alerts', { timeout: 60_000 }, async () => {
    const db = testD1();
    t = Date.UTC(2026, 9, 23, 9);
    vi.spyOn(Date, 'now').mockImplementation(() => t);
    configureAlerts(KEY);
    for (let i = 0; i < DELIVERABLE_MAX; i++) { t += 1; expect(await saveSettings(db as any, KEY, silent(addr('share', i), SHARED))).toBe(true); }
    t += 1000;
    const late = addr('late', 0);
    const s = (await createSession(db as any, late, 'namada', 'namada')) as Session;
    // The save posts the connection notice to the newcomer's link (one post), and turns the channel on.
    const calls = discord();
    const first = await put(db, s, { channels: { discord: { enabled: true, webhookUrl: NEWCOMER } }, notifications: { forumAndGov: true } });
    expect(first.status).toBe(200);
    expect(calls).toEqual([NEWCOMER]);
    for (let k = 0; k < 20; k++) {
      t += 20_000;
      await sendDiscordForumAlert(undefined, post(77000 + k), db as any);
      await sendDiscordWhaleAlert(undefined, sell(k), null, db as any, 10000);
    }
    // The shared link is never posted to; the newcomer hears every forum and whale alert (after the notice).
    expect(calls.filter((u) => u === SHARED)).toHaveLength(0);
    expect(calls.filter((u) => u === NEWCOMER)).toHaveLength(41);
    expect(await deliverableCount(db as any)).toBe(DELIVERABLE_MAX + 1);
    const again = await put(db, s, { notifications: { watchlistOn: false } });
    expect(again.status).toBe(200);
    expect((await readDeliverable(db as any, KEY)).users.map((u) => u.address)).toContain(late);
  });

  it('a channel with Discord on holds its place for good, however quiet; re-saving takes no extra place; the read serves DELIVERABLE_MAX channels first saved first and counts on the partial index', { timeout: 60_000 }, async () => {
    const db = testD1();
    t = Date.UTC(2026, 9, 23, 9);
    vi.spyOn(Date, 'now').mockImplementation(() => t);
    configureAlerts(KEY);
    // One subscriber whose alerts arrive, and DELIVERABLE_MAX - 1 channels nothing is ever posted to by an alert.
    expect(await saveSettings(db as any, KEY, active(addr('good', 0), GOOD))).toBe(true);
    for (let i = 0; i < DELIVERABLE_MAX - 1; i++) { t += 1; expect(await saveSettings(db as any, KEY, silent(addr('idle', i), `https://discord.com/api/webhooks/${600000 + i}/idle${i}`))).toBe(true); }
    t += 1000;
    expect(await saveSettings(db as any, KEY, active(addr('new', 0), NEWCOMER))).toBe(false);
    // Alerts reach the subscriber now and then over the month.
    const calls = discord();
    for (let day = 1; day <= 31; day += 3) {
      t = Date.UTC(2026, 9, 23, 9) + day * DAY;
      await sendDiscordWhaleAlert(undefined, sell(1000 + day), null, db as any, 10000);
    }
    expect(calls.filter((u) => u === GOOD).length).toBeGreaterThan(5);
    // A month and a day later the quiet channels still hold their places (a quiet channel is not a dead one; no
    // grace, no sweep): the newcomer is still refused, plainly.
    t = Date.UTC(2026, 9, 23, 9) + 31 * DAY + 1;
    expect(await saveSettings(db as any, KEY, active(addr('new', 0), NEWCOMER))).toBe(false);
    const placeCount = (settings as any).placeCount as ((db: D1Database) => Promise<number>) | undefined;
    expect(await placeCount?.(db as any)).toBe(DELIVERABLE_MAX);
    // Saving again, Discord still on with the same link, takes no extra place.
    expect(await saveSettings(db as any, KEY, { ...silent(addr('idle', 0), 'https://discord.com/api/webhooks/600000/idle0'), updatedAt: t })).toBe(true);
    expect(await placeCount?.(db as any)).toBe(DELIVERABLE_MAX);
    // A channel turned off frees its place, and the newcomer is taken.
    expect(await saveSettings(db as any, KEY, { ...silent(addr('idle', 1), 'https://discord.com/api/webhooks/600001/idle1'), channels: { discord: { enabled: false, webhookUrl: 'https://discord.com/api/webhooks/600001/idle1' } }, updatedAt: t })).toBe(true);
    expect(await saveSettings(db as any, KEY, active(addr('new', 0), NEWCOMER))).toBe(true);
    expect(await placeCount?.(db as any)).toBe(DELIVERABLE_MAX);
    // The read serves every channel, first saved first: DELIVERABLE_MAX channels, none left out (the newcomer and the
    // re-saved idle row were both first saved at `t`, so either may come last).
    const read = await readDeliverable(db as any, KEY);
    const served = read.users.map((u) => u.address);
    expect(served[0]).toBe(addr('good', 0));
    expect(served.slice(-2)).toContain(addr('new', 0));
    expect(served).toHaveLength(DELIVERABLE_MAX);
    expect(read.unserved).toBe(0);
    // The count of places reads the rows with Discord on from the partial index only.
    const q = "SELECT COUNT(DISTINCT COALESCE(json_extract(value, '$.hook'), key)) n FROM kv WHERE key >= 'user:' AND key < 'user;' AND json_extract(value, '$.on') IS NOT 0";
    const plan = (db.raw.prepare(`EXPLAIN QUERY PLAN ${q}`).all() as { detail: string }[]).map((r) => r.detail).join(' | ');
    expect(plan).toMatch(/USING (COVERING )?INDEX kv_user_deliverable/);
  });

  it('a Settings test post Discord takes records the success in the row (okAt), and the channel keeps its place for good', { timeout: 60_000 }, async () => {
    const db = testD1();
    const T0 = Date.UTC(2026, 9, 23, 9);
    t = T0;
    vi.spyOn(Date, 'now').mockImplementation(() => t);
    configureAlerts(KEY);
    const me = addr('tested', 0);
    expect(await saveSettings(db as any, KEY, silent(me, GOOD))).toBe(true);
    const placeCount = (settings as any).placeCount as ((db: D1Database) => Promise<number>) | undefined;
    t = T0 + 20 * DAY;
    discord();
    const s = (await createSession(db as any, me, 'namada', 'namada')) as Session;
    const r = await app.request('/api/me/settings/test', { method: 'POST', headers: { Authorization: `Bearer ${s.token}` } }, { DB: db, SETTINGS_KEY: KEY } as any);
    expect(await r.json()).toEqual({ success: true });
    expect(await settings.linkProven(db as any, KEY, me, GOOD)).toBe(true);
    t = T0 + 31 * DAY;
    expect(await placeCount?.(db as any)).toBe(1);
    // A channel with Discord on never gives its place up (a quiet channel is not a dead one).
    t = T0 + 400 * DAY;
    expect(await placeCount?.(db as any)).toBe(1);
  });

  it('a link stored beside the sealed settings is a keyed digest, never the link', async () => {
    const db = testD1();
    t = Date.UTC(2026, 9, 23, 9);
    vi.spyOn(Date, 'now').mockImplementation(() => t);
    await saveSettings(db as any, KEY, active(addr('plain', 0), GOOD));
    const v = JSON.parse((db.raw.prepare('SELECT value FROM kv WHERE key = ?').get(`user:${addr('plain', 0)}`) as { value: string }).value);
    expect(v.on).toBe(true);
    expect(typeof v.hook).toBe('string');
    expect(v.hook).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(v)).not.toContain('5002');
    expect(v.onAt).toBe(t);
  });
});
