// The operator's incidents (scale plan, Stage 1 item 4; worker/src/ops.ts): nothing told the owner of a failure while
// it lasted, only the 08:00 UTC digest. A name not ok on 10 ticks in a row, its bad state read afresh on two of them,
// opens an incident, told once to the operator's Discord channel (and the owner's Telegram chat when TELEGRAM_OWNER_CHAT
// is set); one reminder an hour at most while it stays; ok on 3 ticks in a row resolves it, told once. A name that flips
// between ticks opens nothing, nor does one failed read of a source read every 10 minutes. kv ops.alerts.on
// '0' and a Worker without SEND_ALERTS post nothing; a message that reached no channel is tried on the next tick. A cron
// that stops is seen by the live hub's look (watchCronStall), and the first tick after the gap takes it over; a gap the
// hub did not see is opened by that tick. GET /api/health answers 200 or 503 from two kv rows, 15 s at the edge.
// Fetch is stubbed: nothing reaches Discord or Telegram.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { base64 } from '@scure/base';
import { testD1, insert, type TestD1 } from './d1-sqlite';
import { app } from '../worker/src/api';
import { cachedApi, cacheKeyUrl } from '../worker/src/http';
import { configureAlerts } from '../worker/src/sources/discord';
import {
  judge, runOps, watchCronStall, healthAnswer, fitLines, CRON_TICKS, CRON_STALE_MS, INCIDENT_OPEN_TICKS, INCIDENT_RESOLVE_TICKS, OPS_KV, OPS_REMIND_MS,
  OPS_STALL_KV, OPS_SWITCH_KV, HEALTH_TICK_MAX_AGE_MS, type OpsState,
} from '../worker/src/ops';

const KEY = base64.encode(new Uint8Array(32).fill(29));
const T0 = Date.UTC(2026, 9, 29, 10, 0);
const MIN = 60_000, H = 60 * MIN;
const NB = ' ';
const EPOCH = 'Namada RPC (epoch)';

interface Post { url: string; body: any }
let posts: Post[] = [];
let hook = 0;
/** A fresh operator link per test: the dispatcher's backoff is kept per link in the isolate. */
const opUrl = () => `https://discord.com/api/webhooks/7700${++hook}/ops`;
/** Discord answers `discord` (204), Telegram `telegram` (ok); every post is kept. */
function net(discord: () => Response = () => new Response(null, { status: 204 }), telegram: () => Response = () => Response.json({ ok: true, result: {} })) {
  posts = [];
  vi.stubGlobal('fetch', vi.fn(async (u: RequestInfo | URL, init?: RequestInit) => {
    const url = String(u);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (url.startsWith('https://discord.com/')) { posts.push({ url, body }); return discord(); }
    if (url.startsWith('https://api.telegram.org/')) { posts.push({ url, body }); return telegram(); }
    return new Response('down', { status: 503 });
  }));
}
const discordPosts = () => posts.filter((p) => p.url.startsWith('https://discord.com/'));
const textsOf = (ps = discordPosts()) => ps.map((p) => p.body.content as string);

const env = (db: TestD1, extra: Record<string, unknown> = {}) => ({ DB: db, SEND_ALERTS: 'yes', DISCORD_WEBHOOK_URL: opUrl(), ...extra }) as any;
const setHealth = (db: TestD1, rows: Record<string, { ok: boolean; note?: string; at?: number }>, at: number) => {
  const map = Object.fromEntries(Object.entries(rows).map(([name, r]) => [name, { name, ok: r.ok, at: r.at ?? at, ...(r.note ? { note: r.note } : {}) }]));
  db.raw.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('source.health', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(map), at);
};
const state = (db: TestD1): OpsState | null => {
  const v = (db.raw.prepare('SELECT value FROM kv WHERE key = ?').get(OPS_KV) as { value: string } | undefined)?.value;
  return v ? JSON.parse(v) : null;
};
/** One tick's ops pass at `at`, as the cron's finally runs it. */
async function tickAt(e: any, at: number, health?: Record<string, { ok: boolean; note?: string; at?: number }>) {
  vi.setSystemTime(at);
  if (health) setHealth(e.DB, health, at);
  return runOps(e, at);
}
const DOWN = { [EPOCH]: { ok: false, note: 'Error: HTTP 503 for https://rpc.example.invalid/abci_query: <html>down</html>' }, 'Namada RPC Papadritta': { ok: true, note: 'height 8,460,000' } };
const UP = { [EPOCH]: { ok: true, note: 'epoch 412' }, 'Namada RPC Papadritta': { ok: true, note: 'height 8,460,001' } };

beforeEach(() => { configureAlerts(KEY, true); vi.useFakeTimers({ now: T0, toFake: ['Date'] }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('an incident opens after 10 bad ticks in a row, is told once, reminded at most hourly and resolved after 3 good ticks', () => {
  it(`opens on the ${INCIDENT_OPEN_TICKS}th tick, never before, with the site's own words and no upstream answer`, async () => {
    net();
    const db = testD1();
    const e = env(db);
    for (let i = 0; i < INCIDENT_OPEN_TICKS - 1; i++) {
      await tickAt(e, T0 + i * MIN, DOWN);
      expect(discordPosts(), `tick ${i + 1}`).toHaveLength(0);
      expect(state(db)!.watch[EPOCH]).toMatchObject({ since: T0, bad: i + 1 });
    }
    await tickAt(e, T0 + 9 * MIN, DOWN);
    expect(textsOf()).toEqual([`Opened: Namada RPC (epoch): not ok since 29 Oct 2026, 10:00${NB}UTC (9${NB}min, at least 10 ticks in a row): Error: upstream unavailable (HTTP 503).`]);
    const p = discordPosts()[0];
    expect(p.url).toBe(e.DISCORD_WEBHOOK_URL);
    expect(p.body).toMatchObject({ username: 'NamadaTrade', allowed_mentions: { parse: [] } });
    expect(p.body.embeds).toBeUndefined();
    expect(JSON.stringify(p.body)).not.toMatch(/https:\/\/rpc|<html>|down</);
    expect(state(db)!.open[EPOCH]).toMatchObject({ since: T0, openedAt: T0 + 9 * MIN, told: true, good: 0 });
    expect(state(db)!.watch[EPOCH]).toBeUndefined();
  });

  it('is not told again while it stays; one reminder after an hour, listing it, then none for another hour', async () => {
    net();
    const db = testD1();
    const e = env(db);
    for (let i = 0; i <= 9; i++) await tickAt(e, T0 + i * MIN, DOWN);
    expect(discordPosts()).toHaveLength(1);
    // a minute a tick for two hours after the open
    for (let m = 10; m <= 9 + 2 * 60; m++) await tickAt(e, T0 + m * MIN, DOWN);
    const texts = textsOf();
    expect(texts).toHaveLength(3);
    expect(texts[1]).toBe(`Still open: Namada RPC (epoch): not ok since 29 Oct 2026, 10:00${NB}UTC (1.2${NB}h): Error: upstream unavailable (HTTP 503).`);
    expect(texts[2]).toMatch(/^Still open: Namada RPC \(epoch\): not ok since 29 Oct 2026, 10:00 UTC \(2\.2 h\)/);
    // the reminders came exactly OPS_REMIND_MS apart, from the open
    expect(state(db)!.remindedAt).toBe(T0 + 9 * MIN + 2 * OPS_REMIND_MS);
  });

  it(`resolves on the ${INCIDENT_RESOLVE_TICKS}rd good tick in a row, told once; a bad tick between good ones starts the count again`, async () => {
    net();
    const db = testD1();
    const e = env(db);
    for (let i = 0; i <= 9; i++) await tickAt(e, T0 + i * MIN, DOWN);
    expect(discordPosts()).toHaveLength(1);
    await tickAt(e, T0 + 10 * MIN, UP);
    await tickAt(e, T0 + 11 * MIN, UP);
    await tickAt(e, T0 + 12 * MIN, DOWN);
    await tickAt(e, T0 + 13 * MIN, UP);
    await tickAt(e, T0 + 14 * MIN, UP);
    expect(discordPosts()).toHaveLength(1);
    expect(state(db)!.open[EPOCH]).toMatchObject({ good: 2, okSince: T0 + 13 * MIN });
    await tickAt(e, T0 + 15 * MIN, UP);
    expect(textsOf().slice(1)).toEqual([`Resolved: Namada RPC (epoch): ok again since 29 Oct 2026, 10:13${NB}UTC (3 ticks in a row); not ok from 29 Oct 2026, 10:00${NB}UTC, for 13${NB}min.`]);
    expect(state(db)!.open).toEqual({});
    expect(state(db)!.closing).toEqual([]);
    for (let m = 16; m < 90; m++) await tickAt(e, T0 + m * MIN, UP);
    expect(discordPosts()).toHaveLength(2);
  });

  it('a source read every 10 minutes: one failed read left on the sheet for ten ticks opens nothing; a second failed read in a row does', async () => {
    net();
    const db = testD1();
    const e = env(db);
    const HOLDERS = 'Keplr Osmosis REST (holders)';
    const failed = (at: number) => ({ ...UP, [HOLDERS]: { ok: false, note: 'Error: upstream unavailable (HTTP 503)', at } });
    // read at 10:00, failed; the row stays as it was until the next read at 10:10, which succeeds
    await tickAt(e, T0, failed(T0));
    for (let m = 1; m < 10; m++) await tickAt(e, T0 + m * MIN);
    expect(state(db)!.watch[HOLDERS]).toMatchObject({ bad: 10, reads: 1 });
    await tickAt(e, T0 + 10 * MIN, { ...UP, [HOLDERS]: { ok: true, note: '1,204 holders read' } });
    expect(discordPosts()).toHaveLength(0);
    expect(state(db)!.watch[HOLDERS]).toBeUndefined();
    // failed at 11:00 and again at 11:10: open at the second failed read
    for (let m = 11; m < 60; m++) await tickAt(e, T0 + m * MIN);
    await tickAt(e, T0 + H, failed(T0 + H));
    for (let m = 1; m < 10; m++) await tickAt(e, T0 + H + m * MIN);
    expect(discordPosts()).toHaveLength(0);
    await tickAt(e, T0 + H + 10 * MIN, failed(T0 + H + 10 * MIN));
    expect(textsOf()).toEqual([`Opened: Keplr Osmosis REST (holders): not ok since 29 Oct 2026, 11:00${NB}UTC (10${NB}min, at least 10 ticks in a row): Error: upstream unavailable (HTTP 503).`]);
  });

  it('a name that flips between ticks (osmosis_index flipped 124 times in 9.6 h on 2026-10-29) opens nothing', async () => {
    net();
    const db = testD1();
    const e = env(db);
    for (let i = 0; i < 124; i++) await tickAt(e, T0 + i * MIN, i % 2 ? UP : DOWN);
    expect(discordPosts()).toHaveLength(0);
    expect(state(db)!.open).toEqual({});
  });

  it('a check not ok opens with its status and its own title; a check whose last run is past its window opens as "no recent result"', async () => {
    net();
    const db = testD1();
    const e = env(db);
    insert(db, 'checks', [
      { key: 'osmosis_index', status: 'warn', title: "This site's Osmosis flow index: live stream and catch-up search", detail: '{}', checked_at: T0 },
      { key: 'rpc_consensus', status: 'ok', title: 'Namada RPC agreement', detail: '{}', checked_at: T0 - 20 * MIN },
      { key: 'osmosis_stream_share', status: 'ok', title: 'Osmosis moves found by the catch-up search', detail: JSON.stringify({ everyMs: H }), checked_at: T0 - 50 * MIN },
    ]);
    for (let i = 0; i <= 9; i++) {
      db.raw.prepare("UPDATE checks SET checked_at = ? WHERE key = 'osmosis_index'").run(T0 + i * MIN);
      await tickAt(e, T0 + i * MIN, UP);
    }
    const [text] = textsOf();
    expect(text.split('\n')).toEqual([
      `Opened: check osmosis\\_index: warn since 29 Oct 2026, 10:00${NB}UTC (9${NB}min, at least 10 ticks in a row): This site's Osmosis flow index: live stream and catch-up search.`,
      `Opened: check rpc\\_consensus: with no recent result since 29 Oct 2026, 10:00${NB}UTC (9${NB}min, at least 10 ticks in a row): last run 29 Oct 2026, 09:40${NB}UTC; Namada RPC agreement.`,
    ]);
    // the hourly check is current for twice its cadence
    expect(state(db)!.open['check:osmosis_stream_share']).toBeUndefined();
  });

  it("the cron's own row counts only on the tick that wrote it (a failed tick's row stays until a skipped one replaces it)", () => {
    const failed = { cron: { name: 'cron', ok: false, at: T0, note: 'Error: D1_ERROR: simulated' } };
    expect(judge(failed, [], T0, T0 + 30_000).get('cron')).toEqual({ what: 'not ok', words: 'Error: D1_ERROR: simulated', seen: `${T0}|Error: D1_ERROR: simulated` });
    expect(judge(failed, [], T0 + MIN, T0 + MIN + 30_000).has('cron')).toBe(false);
  });

  it('a message longer than one post keeps whole lines and says how many more', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `Opened: source ${i}: not ok since 29 Oct 2026, 10:00 UTC: ${'x'.repeat(100)}.`);
    const text = fitLines(lines);
    expect(text.length).toBeLessThanOrEqual(1900);
    const out = text.split('\n');
    expect(out.at(-1)).toBe(`And ${30 - (out.length - 1)} more (the Sources sheet lists them).`);
    expect(out.slice(0, -1)).toEqual(lines.slice(0, out.length - 1));
  });
});

describe('where the messages go, and what stops them', () => {
  it('the owner\'s Telegram chat (TELEGRAM_OWNER_CHAT) gets the same lines through the bot, escaped as text; Telegram alone is enough', async () => {
    net();
    const db = testD1();
    const e = env(db, { TELEGRAM_BOT_TOKEN: '123:test-token', TELEGRAM_OWNER_CHAT: ' 5550009 ' });
    const odd = { ...DOWN, [EPOCH]: { ok: false, note: 'no node answered <b>' } };
    for (let i = 0; i <= 9; i++) await tickAt(e, T0 + i * MIN, odd);
    const tg = posts.filter((p) => p.url.startsWith('https://api.telegram.org/'));
    expect(tg).toHaveLength(1);
    expect(tg[0].url).toBe('https://api.telegram.org/bot123:test-token/sendMessage');
    expect(tg[0].body).toMatchObject({ chat_id: '5550009', parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    expect(tg[0].body.reply_markup).toBeUndefined();
    expect(tg[0].body.text).toBe(`Opened: Namada RPC (epoch): not ok since 29 Oct 2026, 10:00${NB}UTC (9${NB}min, at least 10 ticks in a row): no node answered &lt;b&gt;.`);
    expect(discordPosts()).toHaveLength(1);

    const db2 = testD1();
    const tgOnly = { DB: db2, SEND_ALERTS: 'yes', TELEGRAM_BOT_TOKEN: '123:test-token', TELEGRAM_OWNER_CHAT: '5550009' } as any;
    posts = [];
    for (let i = 0; i <= 9; i++) await tickAt(tgOnly, T0 + i * MIN, DOWN);
    expect(posts.map((p) => p.url)).toEqual(['https://api.telegram.org/bot123:test-token/sendMessage']);
    expect(state(db2)!.open[EPOCH].told).toBe(true);
  });

  it("kv ops.alerts.on = '0' stops every post; the incident is still kept, and told once the switch is removed", async () => {
    net();
    const db = testD1();
    const e = env(db);
    insert(db, 'kv', [{ key: OPS_SWITCH_KV, value: '0', updated_at: T0 }]);
    for (let i = 0; i <= 20; i++) await tickAt(e, T0 + i * MIN, DOWN);
    expect(posts).toHaveLength(0);
    expect(state(db)!.open[EPOCH]).toMatchObject({ told: false });
    const health = await app.request('/api/health', {}, { DB: db } as any);
    expect(health.status).toBe(503);
    expect(((await health.json()) as any).incidents).toEqual([EPOCH]);
    db.raw.prepare('DELETE FROM kv WHERE key = ?').run(OPS_SWITCH_KV);
    await tickAt(e, T0 + 21 * MIN, DOWN);
    expect(textsOf()).toEqual([`Opened: Namada RPC (epoch): not ok since 29 Oct 2026, 10:00${NB}UTC (21${NB}min, at least 10 ticks in a row): Error: upstream unavailable (HTTP 503).`]);
    await tickAt(e, T0 + 22 * MIN, DOWN);
    expect(discordPosts()).toHaveLength(1);
    // the JSON of '0' is the switch too
    for (const raw of ['"0"', ' 0 ']) {
      db.raw.prepare('INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)').run(OPS_SWITCH_KV, raw, T0);
      for (let m = 23; m <= 25; m++) await tickAt(e, T0 + m * MIN, UP);
    }
    expect(discordPosts()).toHaveLength(1);
  });

  it('a Worker whose SEND_ALERTS is not yes posts nothing, ever, and still keeps the incidents', async () => {
    net();
    const db = testD1();
    const e = { DB: db, DISCORD_WEBHOOK_URL: opUrl(), TELEGRAM_BOT_TOKEN: '123:test-token', TELEGRAM_OWNER_CHAT: '5550009' } as any;
    for (let i = 0; i <= 9 + 2 * 60; i++) await tickAt(e, T0 + i * MIN, DOWN);
    expect(posts).toHaveLength(0);
    expect(state(db)!.open[EPOCH]).toMatchObject({ told: false });
    vi.setSystemTime(T0 + 3 * H);
    expect(await watchCronStall(e)).toBe('stalled');
    expect(posts).toHaveLength(0);
  });

  it('a message no channel took is tried again on the next tick, and told once', async () => {
    let fail = true;
    net(() => (fail ? new Response('{"message":"busy"}', { status: 500 }) : new Response(null, { status: 204 })));
    const db = testD1();
    const e = env(db);
    for (let i = 0; i <= 9; i++) await tickAt(e, T0 + i * MIN, DOWN);
    expect(discordPosts()).toHaveLength(1);
    expect(state(db)!.open[EPOCH].told).toBe(false);
    fail = false;
    await tickAt(e, T0 + 10 * MIN, DOWN);
    await tickAt(e, T0 + 11 * MIN, DOWN);
    expect(discordPosts()).toHaveLength(2);
    expect(textsOf()[1]).toMatch(/^Opened: Namada RPC \(epoch\): not ok since 29 Oct 2026, 10:00 UTC \(10 min/);
    expect(state(db)!.open[EPOCH].told).toBe(true);
  });
});

describe("the cron's own ticks", () => {
  it('the hub opens the incident once the last completed tick is 10 min old, once per gap, reminds hourly; the first ticks after it take it over and resolve it', async () => {
    net();
    const db = testD1();
    const e = env(db);
    await tickAt(e, T0, UP);
    expect(state(db)!.lastTickAt).toBe(T0);
    vi.setSystemTime(T0 + 5 * MIN);
    expect(await watchCronStall(e)).toBe('fresh');
    vi.setSystemTime(T0 + CRON_STALE_MS);
    expect(await watchCronStall(e)).toBe('fresh');
    vi.setSystemTime(T0 + 11 * MIN);
    expect(await watchCronStall(e)).toBe('stalled');
    expect(textsOf()).toEqual([`Opened: Cron ticks: no tick has completed since 29 Oct 2026, 10:00${NB}UTC (11${NB}min); the live hub looked at 29 Oct 2026, 10:11${NB}UTC.`]);
    for (let m = 12; m < 71; m++) { vi.setSystemTime(T0 + m * MIN); await watchCronStall(e); }
    expect(discordPosts()).toHaveLength(1);
    vi.setSystemTime(T0 + 71 * MIN);
    await watchCronStall(e);
    expect(textsOf()[1]).toBe(`Still open: Cron ticks: no tick has completed since 29 Oct 2026, 10:00${NB}UTC (1.2${NB}h).`);
    // the probe sees it
    const probe = await app.request('/api/health', {}, { DB: db } as any);
    expect(probe.status).toBe(503);
    expect(await probe.json()).toEqual({ ok: false, lastTickAt: T0, lastTickAgeMs: 71 * MIN, failing: [], incidents: [CRON_TICKS] });

    // the cron is back at 11:20: told already, so nothing is said until it has completed three ticks
    await tickAt(e, T0 + 80 * MIN, UP);
    expect(discordPosts()).toHaveLength(2);
    expect(db.raw.prepare('SELECT 1 FROM kv WHERE key = ?').get(OPS_STALL_KV)).toBeUndefined();
    expect(state(db)!.open[CRON_TICKS]).toMatchObject({ since: T0, told: true, good: 1, okSince: T0 + 80 * MIN });
    vi.setSystemTime(T0 + 80 * MIN + 30_000);
    expect(await watchCronStall(e)).toBe('fresh');
    await tickAt(e, T0 + 81 * MIN, UP);
    expect(discordPosts()).toHaveLength(2);
    await tickAt(e, T0 + 82 * MIN, UP);
    expect(textsOf()[2]).toBe(`Resolved: Cron ticks: ok again since 29 Oct 2026, 11:20${NB}UTC (3 ticks in a row); no tick completed from 29 Oct 2026, 10:00${NB}UTC, for 1.3${NB}h.`);
    expect(state(db)!.open).toEqual({});
    for (let m = 83; m < 100; m++) await tickAt(e, T0 + m * MIN, UP);
    expect(discordPosts()).toHaveLength(3);
    const ok = await app.request('/api/health', {}, { DB: db } as any);
    expect(ok.status).toBe(200);
  });

  it('a gap the hub did not see (the hub down too) is opened by the first tick after it and resolved two ticks later', async () => {
    net();
    const db = testD1();
    const e = env(db);
    await tickAt(e, T0, UP);
    await tickAt(e, T0 + 30 * MIN, UP);
    expect(textsOf()).toEqual([`Opened: Cron ticks: no tick completed from 29 Oct 2026, 10:00${NB}UTC to 29 Oct 2026, 10:30${NB}UTC (30${NB}min); ticks complete again.`]);
    await tickAt(e, T0 + 31 * MIN, UP);
    await tickAt(e, T0 + 32 * MIN, UP);
    expect(textsOf()[1]).toBe(`Resolved: Cron ticks: ok again since 29 Oct 2026, 10:30${NB}UTC (3 ticks in a row); no tick completed from 29 Oct 2026, 10:00${NB}UTC, for 30${NB}min.`);
    // a gap of ten minutes or less is no gap
    await tickAt(e, T0 + 42 * MIN, UP);
    expect(discordPosts()).toHaveLength(2);
  });

  it('a second gap while the first is still resolving keeps the one incident, counts its good ticks again and resolves it once', async () => {
    net();
    const db = testD1();
    const e = env(db);
    await tickAt(e, T0, UP);
    await tickAt(e, T0 + 30 * MIN, UP);
    await tickAt(e, T0 + 31 * MIN, UP);
    expect(discordPosts()).toHaveLength(1);
    await tickAt(e, T0 + 60 * MIN, UP);
    expect(state(db)!.open[CRON_TICKS]).toMatchObject({ since: T0, told: true, good: 1, okSince: T0 + 60 * MIN });
    await tickAt(e, T0 + 61 * MIN, UP);
    expect(discordPosts()).toHaveLength(1);
    await tickAt(e, T0 + 62 * MIN, UP);
    expect(textsOf()).toHaveLength(2);
    expect(textsOf()[1]).toMatch(/^Resolved: Cron ticks: ok again since 29 Oct 2026, 11:00 UTC \(3 ticks in a row\)/);
  });

  it('the hub judges nothing before the first tick has written its record, and never twice for one gap', async () => {
    net();
    const db = testD1();
    const e = env(db);
    vi.setSystemTime(T0 + H);
    expect(await watchCronStall(e)).toBe('unknown');
    await tickAt(e, T0 + H, UP);
    vi.setSystemTime(T0 + H + 15 * MIN);
    await watchCronStall(e);
    await watchCronStall(e);
    expect(discordPosts()).toHaveLength(1);
    const row = JSON.parse((db.raw.prepare('SELECT value FROM kv WHERE key = ?').get(OPS_STALL_KV) as { value: string }).value);
    expect(row).toEqual({ since: T0 + H, openedAt: T0 + H + 15 * MIN, toldAt: T0 + H + 15 * MIN, remindedAt: T0 + H + 15 * MIN });
  });
});

describe('GET /api/health', () => {
  const get = async (db: TestD1) => { const r = await app.request('/api/health', {}, { DB: db } as any); return { status: r.status, body: (await r.json()) as any }; };

  it('503 with no tick on record; 200 after a completed tick; names only, no note', async () => {
    net();
    const db = testD1();
    expect(await get(db)).toEqual({ status: 503, body: { ok: false, lastTickAt: null, lastTickAgeMs: null, failing: [], incidents: [] } });
    const e = env(db);
    await tickAt(e, T0, UP);
    vi.setSystemTime(T0 + 20_000);
    expect(await get(db)).toEqual({ status: 200, body: { ok: true, lastTickAt: T0, lastTickAgeMs: 20_000, failing: [], incidents: [] } });
    // a name not ok for three ticks is failing, not yet an incident: still 200
    for (let i = 1; i <= 3; i++) await tickAt(e, T0 + i * MIN, DOWN);
    const r = await get(db);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, lastTickAt: T0 + 3 * MIN, lastTickAgeMs: 0, failing: [EPOCH], incidents: [] });
    expect(JSON.stringify(r.body)).not.toMatch(/upstream|Error|503/);
  });

  it('503 once the last completed tick is older than 5 min, and while an incident is open', async () => {
    net();
    const db = testD1();
    const e = env(db);
    await tickAt(e, T0, UP);
    vi.setSystemTime(T0 + HEALTH_TICK_MAX_AGE_MS);
    expect((await get(db)).status).toBe(200);
    vi.setSystemTime(T0 + HEALTH_TICK_MAX_AGE_MS + 1);
    expect(await get(db)).toMatchObject({ status: 503, body: { ok: false, lastTickAgeMs: HEALTH_TICK_MAX_AGE_MS + 1 } });
    for (let i = 1; i <= 10; i++) await tickAt(e, T0 + 5 * MIN + i * MIN, DOWN);
    expect(await get(db)).toMatchObject({ status: 503, body: { ok: false, lastTickAgeMs: 0, failing: [EPOCH], incidents: [EPOCH] } });
    // ok again: failing at once, open until it is resolved
    await tickAt(e, T0 + 16 * MIN, UP);
    expect(await get(db)).toMatchObject({ status: 503, body: { failing: [], incidents: [EPOCH] } });
    await tickAt(e, T0 + 17 * MIN, UP);
    await tickAt(e, T0 + 18 * MIN, UP);
    expect(await get(db)).toMatchObject({ status: 200, body: { ok: true, failing: [], incidents: [] } });
    expect(healthAnswer(null, null, T0).status).toBe(503);
  });

  it('is kept at the edge for 15 s, its 503 too, and read with one statement of two kv rows by key', async () => {
    net();
    const store = new Map<string, Response>();
    const pending: Promise<unknown>[] = [];
    vi.stubGlobal('caches', { default: { match: async (r: Request) => store.get(r.url)?.clone(), put: async (r: Request, res: Response) => { store.set(r.url, res); } } });
    const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as any;
    const db = testD1();
    let calls = 0;
    const fetchApp = (r: Request) => { calls++; return app.request(r, {}, { DB: db } as any); };
    const before = db.queries;
    const first = await cachedApi(new Request('https://namada.trade/api/health?r=1'), {} as any, ctx, fetchApp);
    expect(db.queries - before).toBe(1);
    expect(first.status).toBe(503);
    expect(first.headers.get('cache-control')).toBe('public, max-age=5');
    await Promise.all(pending);
    const stored = store.get(cacheKeyUrl(new URL('https://namada.trade/api/health')));
    expect(stored?.status).toBe(503);
    expect(stored!.headers.get('cache-control')).toBe('public, max-age=5, s-maxage=15, stale-while-revalidate=30');
    const again = await cachedApi(new Request('https://namada.trade/api/health?r=2'), {} as any, ctx, fetchApp);
    expect(again.status).toBe(503);
    expect(calls).toBe(1);
    const src = (await import('node:fs')).readFileSync((await import('node:path')).join(__dirname, '..', 'worker', 'src', 'ops.ts'), 'utf8');
    expect(src).toContain("SELECT key, value FROM kv WHERE key IN ('${OPS_KV}', '${OPS_STALL_KV}')");
  });
});
