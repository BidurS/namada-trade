// Security review (2026-10-22), the subscribers the alert dispatcher reads: it read the 500 user: rows saved most
// recently and only then dropped those with Discord off, so newer rows (a sign-in is free and any save rewrites
// updated_at) left an earlier subscriber out of every move, forum and governance alert, with nothing in the health
// view. Now the read takes only rows with Discord on (plain `on` beside the sealed blob, partial index
// kv_user_deliverable, migration 0012), first saved first; the save that would turn on one channel more than
// DELIVERABLE_MAX is refused (409) instead; and any row the read leaves out is recorded in kv alerts.skipped.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { testD1, insert, type TestD1 } from './d1-sqlite';
import { saveSettings, readDeliverable, allDeliverable, deleteSettings, defaultPrefs, DELIVERABLE_MAX, CHANNELS_FULL, type StoredSettings } from '../worker/src/settings';
import { configureAlerts, sendDiscordForumAlert, sendDiscordWhaleAlert, UNSERVED_WHAT } from '../worker/src/sources/discord';
import { app } from '../worker/src/api';
import { createSession, type Session } from '../worker/src/auth';
import { settingsRowsHealth } from '../worker/src/cron';
import type { Flow, ForumPost } from '../shared/types';

const KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const OTHER_KEY = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=';
const OP = 'https://discord.com/api/webhooks/10/operator';
const VICTIM = 'osmo1' + 'v'.repeat(38);
const VICTIM_URL = 'https://discord.com/api/webhooks/1/victim';
let t = 1000;

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

type Discord = StoredSettings['channels']['discord'];
const OFF: Discord = { enabled: false, webhookUrl: null };
const fake = (i: number): Discord => ({ enabled: true, webhookUrl: `https://discord.com/api/webhooks/${900000 + i}/fake${i}` });
const row = (address: string, discord: Discord, forum = false): StoredSettings => {
  const n = defaultPrefs();
  n.forumAndGov = forum;
  n.rules.big_swap = { on: true, thresholdNam: 1 };
  return { address, notifications: n, channels: { discord }, createdAt: t, updatedAt: t };
};
const filler = (i: number) => 'osmo1' + String(i).padStart(38, 'q');
const post = (id: number) => ({ id, topicId: 1, topicTitle: 'x', postNumber: 2, username: 'u', displayName: null, excerpt: '', url: 'https://forum.namada.net/t/x/1', createdAt: '2026-10-22T00:00:00Z', isNewTopic: false }) as unknown as ForumPost;
const sell = (n: number) => ({ id: `osmosis:CAP${n}:0`, chain: 'osmosis', height: n, ts: 1, txHash: `CAP${n}`, kind: 'sell', from: 'osmo1yl6hdjhmkf37639730gffanpzndzdpmhxy9ep3', to: null, amount: 20000, meta: null }) as unknown as Flow;
const skipped = (db: TestD1) => {
  const r = db.raw.prepare("SELECT value FROM kv WHERE key = 'alerts.skipped'").get() as { value: string } | undefined;
  return r ? JSON.parse(r.value) : null;
};
const has = (db: TestD1, address: string) => !!db.raw.prepare('SELECT 1 FROM kv WHERE key = ?').get(`user:${address}`);
const addresses = async (db: TestD1) => (await allDeliverable(db as any, KEY)).map((u) => u.address);

/** The subscriber saves first, then `n` other identities each save once (at a later time). */
async function setup(n: number, discord: (i: number) => Discord) {
  const db = testD1();
  t = 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => t);
  await saveSettings(db as any, KEY, row(VICTIM, { enabled: true, webhookUrl: VICTIM_URL }, true));
  const stored: boolean[] = [];
  for (let i = 0; i < n; i++) { t = 2000 + i; stored.push(await saveSettings(db as any, KEY, row(filler(i), discord(i)))); }
  t = 100_000;
  configureAlerts(KEY);
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (u: string) => { calls.push(String(u)); return new Response(null, { status: 204 }); }));
  return { db, calls, stored };
}

describe('rows with Discord off never take a subscriber\'s place', () => {
  it('500 newer rows with Discord off: the earlier subscriber is still read and posted to, after the operator', async () => {
    expect(DELIVERABLE_MAX).toBe(500);
    const { db, calls, stored } = await setup(500, () => OFF);
    expect(stored).not.toContain(false);
    expect(await addresses(db)).toEqual([VICTIM]);
    await sendDiscordForumAlert(OP, post(9001), db as any);
    expect(calls).toEqual([OP, VICTIM_URL]);
    await sendDiscordWhaleAlert(undefined, sell(1), null, db as any, 10000);
    expect(calls).toContain(VICTIM_URL);
    expect(skipped(db)).toBeNull();
    // Only the subscriber's row is in the index the count and the read use.
    expect((db.raw.prepare("SELECT COUNT(*) n FROM kv INDEXED BY kv_user_deliverable WHERE key >= 'user:' AND key < 'user;' AND json_extract(value, '$.on') IS NOT 0").get() as { n: number }).n).toBe(1);
  });
});

describe('the cap is counted by the save that turns Discord on', () => {
  it('past DELIVERABLE_MAX channels a new one is refused and nothing written; re-saving keeps the earlier subscriber in', async () => {
    const { db, calls, stored } = await setup(DELIVERABLE_MAX, fake);
    // The subscriber plus 499 others fill the cap; the 500th other is refused and has no row.
    expect(stored.filter(Boolean)).toHaveLength(DELIVERABLE_MAX - 1);
    expect(stored[DELIVERABLE_MAX - 1]).toBe(false);
    expect(has(db, filler(DELIVERABLE_MAX - 1))).toBe(false);
    // Every other identity saves again, with Discord on: all are written, and none takes the subscriber's place.
    for (let i = 0; i < DELIVERABLE_MAX - 1; i++) { t = 200_000 + i; expect(await saveSettings(db as any, KEY, row(filler(i), fake(i)))).toBe(true); }
    t = 300_000;
    const read = await readDeliverable(db as any, KEY);
    expect(read.users).toHaveLength(DELIVERABLE_MAX);
    expect(read.users[0].address).toBe(VICTIM);
    expect(read.unserved).toBe(0);
    await sendDiscordWhaleAlert(undefined, sell(2), null, db as any, 10000);
    expect(calls).toContain(VICTIM_URL);
  });

  it('a channel turned off or a deleted account frees its place; a save with Discord off is never refused', async () => {
    const { db } = await setup(DELIVERABLE_MAX - 1, fake);
    t = 400_000;
    const late = 'osmo1' + 'l'.repeat(38);
    expect(await saveSettings(db as any, KEY, row(late, fake(7777)))).toBe(false);
    expect(await saveSettings(db as any, KEY, row(late, OFF))).toBe(true);
    expect(await saveSettings(db as any, KEY, row(filler(0), OFF))).toBe(true);
    expect(await saveSettings(db as any, KEY, row(late, fake(7777)))).toBe(true);
    expect(await saveSettings(db as any, KEY, row(filler(0), fake(0)))).toBe(false);
    await deleteSettings(db as any, filler(1));
    expect(await saveSettings(db as any, KEY, row(filler(0), fake(0)))).toBe(true);
  });

  it('PUT /api/me/settings answers 409 past the cap, saves the row with the channel off and posts nothing, and still takes a save with Discord off', async () => {
    const { db, calls } = await setup(DELIVERABLE_MAX - 1, fake);
    const env = { DB: db, SETTINGS_KEY: KEY } as any;
    const late = 'tnam1q' + 'l'.repeat(39);
    const s = (await createSession(db as any, late, 'namada', 'namada')) as Session;
    const put = (body: unknown) => app.request('/api/me/settings', { method: 'PUT', headers: { Authorization: `Bearer ${s.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }, env);
    const on = await put({ channels: { discord: { enabled: true, webhookUrl: 'https://discord.com/api/webhooks/5/late' } } });
    expect(on.status).toBe(409);
    const refused = (await on.json()) as { error: string; settings: { channels: { discord: { enabled: boolean; hasUrl: boolean } } } };
    expect(refused.error).toBe(CHANNELS_FULL);
    // Changed with the link proven at save (test/link-proven-at-save.test.ts): the row is saved with the channel off,
    // so the link is kept, and no connection notice is posted to a link the site cannot serve.
    expect(refused.settings.channels.discord).toMatchObject({ enabled: false, hasUrl: true });
    expect(has(db, late)).toBe(true);
    expect(calls).toHaveLength(0);
    expect(await addresses(db)).not.toContain(late);
    // The refusal is recorded apart from first saves past the row cap, and the health row says so for a day.
    expect(JSON.parse((db.raw.prepare("SELECT value FROM kv WHERE key = 'settings.refused'").get() as { value: string }).value)).toMatchObject({ total: 0, channels: 1 });
    expect(await settingsRowsHealth(db as any, Date.now())).toMatchObject({ ok: false, note: `${DELIVERABLE_MAX} of ${DELIVERABLE_MAX} Discord channels on; a save turning one more on was refused (1 in all).` });
    const off = await put({ notifications: { forumAndGov: true } });
    expect(off.status).toBe(200);
    expect(has(db, late)).toBe(true);
    // The subscriber, whose channel is on, can still change it.
    const v = (await createSession(db as any, VICTIM, 'osmosis', 'keplr')) as Session;
    const moved = await app.request('/api/me/settings', { method: 'PUT', headers: { Authorization: `Bearer ${v.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ channels: { discord: { webhookUrl: 'https://discord.com/api/webhooks/1/moved' } } }) }, env);
    expect(moved.status).toBe(200);
    expect((await addresses(db))[0]).toBe(VICTIM);
  });
});

describe('a row the read leaves out is recorded, never dropped unseen', () => {
  it('rows of the old shape past the cap: the first saved are served, the rest recorded in kv alerts.skipped', async () => {
    const db = testD1();
    t = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => t);
    for (let i = 0; i < DELIVERABLE_MAX - 1; i++) { t = 2000 + i; expect(await saveSettings(db as any, KEY, row(filler(i), fake(i)))).toBe(true); }
    // Two rows as the old code wrote them ({ blob, updatedAt }, no `on`, written after the 499 above): each counts as
    // on, so the site holds one row with Discord on more than the cap.
    for (const i of [0, 1]) {
      const old = { address: filler(9000 + i), notifications: defaultPrefs(), channels: { discord: fake(9000 + i) }, createdAt: 5000 + i, updatedAt: 5000 + i } as StoredSettings;
      const tmp = testD1();
      await saveSettings(tmp as any, KEY, old);
      const { blob } = JSON.parse((tmp.raw.prepare('SELECT value FROM kv WHERE key = ?').get(`user:${old.address}`) as { value: string }).value);
      insert(db, 'kv', [{ key: `user:${old.address}`, value: JSON.stringify({ blob, updatedAt: 5000 + i }), updated_at: 5000 + i }]);
    }
    t = 100_000;
    const read = await readDeliverable(db as any, KEY);
    expect(read.users).toHaveLength(DELIVERABLE_MAX);
    expect(read.unserved).toBe(1);
    // First saved first: the old-shape row saved last is the one left out.
    expect(read.users.map((u) => u.address)).toContain(filler(9000));
    expect(read.users.map((u) => u.address)).not.toContain(filler(9001));
    configureAlerts(KEY);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    await sendDiscordForumAlert(undefined, post(9002), db as any);
    expect(skipped(db)).toMatchObject({ total: 1, last: { what: UNSERVED_WHAT, n: 1 } });
  });

  it('rows that do not open under this key are recorded the same way', async () => {
    const { db } = await setup(0, OFF);
    for (let i = 0; i < 3; i++) await saveSettings(db as any, OTHER_KEY, row(filler(i), fake(i)));
    expect(await readDeliverable(db as any, KEY)).toMatchObject({ unserved: 3 });
    expect((await readDeliverable(db as any, KEY)).users.map((u) => u.address)).toEqual([VICTIM]);
    await sendDiscordForumAlert(undefined, post(9003), db as any);
    expect(skipped(db)).toMatchObject({ last: { what: UNSERVED_WHAT, n: 3 } });
  });
});

describe('the count and the read touch only the rows with Discord on', () => {
  it('every query on the user: range with `on` searches kv_user_deliverable, never the whole range', async () => {
    const db = testD1();
    const sqls: string[] = [];
    const prepare = db.prepare.bind(db);
    db.prepare = (sql: string) => { sqls.push(sql); return prepare(sql); };
    for (let i = 0; i < DELIVERABLE_MAX; i++) await saveSettings(db as any, KEY, row(filler(i), i % 2 ? OFF : fake(i)));
    await readDeliverable(db as any, KEY);
    const asked = [...new Set(sqls.filter((q) => q.includes("json_extract(value, '$.on') IS NOT 0") && q.includes("key >= 'user:'")))];
    expect(asked.length).toBeGreaterThanOrEqual(2);
    for (const q of asked) {
      const plan = (db.raw.prepare(`EXPLAIN QUERY PLAN ${q}`).all() as { detail: string }[]).map((r) => r.detail);
      const range = plan.filter((d) => / kv /.test(` ${d} `) && !/key=\?\)/.test(d));
      expect(range.length, q).toBeGreaterThan(0);
      // The rows with Discord on are found on the partial index. The only other range the save reads is its count of
      // every address (settings.ts USER_ROWS_MAX), on the primary key's index entries alone: never a value.
      expect(range.some((d) => /USING (COVERING )?INDEX kv_user_deliverable/.test(d)), q).toBe(true);
      for (const d of range) expect(d, q).toMatch(/USING (COVERING )?INDEX kv_user_deliverable|USING COVERING INDEX sqlite_autoindex_kv_1 \(key>\? AND key<\?\)/);
    }
  });
});
