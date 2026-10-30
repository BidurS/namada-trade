// The operator's incidents (scale plan, Stage 1 item 4; worker/src/ops.ts): nothing told the owner of a failure while
// it lasted, only the 08:00 UTC digest. A name not ok on 10 ticks in a row, its bad state read afresh on two of them,
// opens an incident, told once to the operator's Discord channel (and the owner's Telegram chat when TELEGRAM_OWNER_CHAT
// is set); reminders after 1, 2, 4 ... hours while it stays, at most a day apart; ok on 3 ticks in a row resolves it,
// told once. A name that flips between ticks opens nothing, nor does one failed read of a source read every 10 minutes,
// nor one failure of a row that stays not ok for a day after it (its time moved by the successes since). A check that
// only needs a look ('warn'), a row turned off on purpose, the depth module's names while its kill switch is off and the
// names on the quiet list (kv ops.quiet) open nothing (review of 2026-10-29: a stream share above 5% and depth.on = '0'
// held /api/health at 503 and sent a reminder every hour). kv ops.alerts.on '0' and a Worker without SEND_ALERTS post
// nothing; a message that reached no channel is tried on the next tick. A cron that stops is seen by the live hub's look
// (watchCronStall), and the first tick after the gap takes it over; a gap the hub did not see is opened by that tick.
// GET /api/health answers 200 or 503 from two kv rows, 15 s at the edge. Fetch is stubbed: nothing reaches Discord or
// Telegram.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { base64 } from '@scure/base';
import { testD1, insert, type TestD1 } from './d1-sqlite';
import { app } from '../worker/src/api';
import { cachedApi, cacheKeyUrl } from '../worker/src/http';
import { configureAlerts } from '../worker/src/sources/discord';
import { alertDeliveryOff } from '../worker/src/cron';
import { KILL_SWITCH_NOTE } from '../worker/src/depth/budget';
import { DEPTH_HEALTH } from '../worker/src/depth/index';
import {
  judge, runOps, watchCronStall, healthAnswer, fitLines, letGo, offOnPurpose, quietOf, readMark, remindDue, DEPTH_NAMES, CRON_TICKS, CRON_STALE_MS,
  INCIDENT_OPEN_TICKS, INCIDENT_RESOLVE_TICKS, OPS_KV, OPS_QUIET_KV, OPS_REMIND_MAX_MS, OPS_STALL_KV, OPS_SWITCH_KV, HEALTH_TICK_MAX_AGE_MS,
  type OpsState,
} from '../worker/src/ops';

const KEY = base64.encode(new Uint8Array(32).fill(29));
const T0 = Date.UTC(2026, 9, 29, 10, 0);
const MIN = 60_000, H = 60 * MIN;
const NB = ' ';
const EPOCH = 'Namada RPC (epoch)';

interface Post { url: string; body: any; at: number }
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
    if (url.startsWith('https://discord.com/')) { posts.push({ url, body, at: Date.now() }); return discord(); }
    if (url.startsWith('https://api.telegram.org/')) { posts.push({ url, body, at: Date.now() }); return telegram(); }
    return new Response('down', { status: 503 });
  }));
}
const discordPosts = () => posts.filter((p) => p.url.startsWith('https://discord.com/'));
const textsOf = (ps = discordPosts()) => ps.map((p) => p.body.content as string);

const env = (db: TestD1, extra: Record<string, unknown> = {}) => ({ DB: db, SEND_ALERTS: 'yes', DISCORD_WEBHOOK_URL: opUrl(), ...extra }) as any;
type Row = { ok: boolean; note?: string; at?: number; failedAt?: number };
const setHealth = (db: TestD1, rows: Record<string, Row>, at: number) => {
  const map = Object.fromEntries(Object.entries(rows).map(([name, r]) => [name, { name, ok: r.ok, at: r.at ?? at, ...(r.note ? { note: r.note } : {}), ...(r.failedAt != null ? { failedAt: r.failedAt } : {}) }]));
  db.raw.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('source.health', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(map), at);
};
const state = (db: TestD1): OpsState | null => {
  const v = (db.raw.prepare('SELECT value FROM kv WHERE key = ?').get(OPS_KV) as { value: string } | undefined)?.value;
  return v ? JSON.parse(v) : null;
};
/** One tick's ops pass at `at`, as the cron's finally runs it. */
async function tickAt(e: any, at: number, health?: Record<string, Row>) {
  vi.setSystemTime(at);
  if (health) setHealth(e.DB, health, at);
  return runOps(e, at);
}
const DOWN = { [EPOCH]: { ok: false, note: 'Error: HTTP 503 for https://rpc.example.invalid/abci_query: <html>down</html>' }, 'Namada RPC Papadritta': { ok: true, note: 'height 8,460,000' } };
const UP = { [EPOCH]: { ok: true, note: 'epoch 412' }, 'Namada RPC Papadritta': { ok: true, note: 'height 8,460,001' } };
const getHealth = async (db: TestD1) => { const r = await app.request('/api/health', {}, { DB: db } as any); return { status: r.status, body: (await r.json()) as any }; };

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

  it('is not told again while it stays; reminded 1 h after the open, then after 2, 4, 8, 16 h, then once a day', async () => {
    net();
    const db = testD1();
    const e = env(db);
    for (let i = 0; i <= 9; i++) await tickAt(e, T0 + i * MIN, DOWN);
    expect(discordPosts()).toHaveLength(1);
    const OPEN = T0 + 9 * MIN;
    // a tick every five minutes for 80 h after the open (no gap: the cron's gap is over ten minutes)
    for (let t = OPEN + 5 * MIN; t <= OPEN + 80 * H; t += 5 * MIN) await tickAt(e, t, DOWN);
    const texts = textsOf();
    expect(texts[1]).toBe(`Still open: Namada RPC (epoch): not ok since 29 Oct 2026, 10:00${NB}UTC (1.2${NB}h): Error: upstream unavailable (HTTP 503).`);
    expect(texts.slice(1).every((t) => t.startsWith(`Still open: Namada RPC (epoch): not ok since 29 Oct 2026, 10:00${NB}UTC`))).toBe(true);
    // 1, 3, 7, 15 and 31 h after the open (each wait twice the last), then a day apart: 7 reminders in 80 h, not 80
    expect(discordPosts().slice(1).map((p) => (p.at - OPEN) / H)).toEqual([1, 3, 7, 15, 31, 55, 79]);
    expect(state(db)).toMatchObject({ remindedAt: OPEN + 79 * H, reminds: 7 });
    expect(OPS_REMIND_MAX_MS).toBe(24 * H);
    expect(remindDue(OPEN, 3, OPEN + 8 * H - 1)).toBe(false);
    expect(remindDue(OPEN, 3, OPEN + 8 * H)).toBe(true);
    expect(remindDue(OPEN, 40, OPEN + 24 * H)).toBe(true);
    expect(remindDue(null, 0, OPEN)).toBe(true);
  });

  it('a new incident starts the waits again: its open is told at once, and the next reminder, of both, an hour later', async () => {
    net();
    const db = testD1();
    const e = env(db);
    const PAPA = 'Namada RPC Papadritta';
    for (let i = 0; i <= 9; i++) await tickAt(e, T0 + i * MIN, DOWN);
    const OPEN = T0 + 9 * MIN;
    for (let t = OPEN + 5 * MIN; t <= OPEN + 3 * H; t += 5 * MIN) await tickAt(e, t, DOWN);
    expect(state(db)!.reminds).toBe(2);
    // a second source goes down at 13:14 and opens on its tenth tick
    const both = { ...DOWN, [PAPA]: { ok: false, note: 'no answer in 10 s' } };
    let t = OPEN + 3 * H + 5 * MIN;
    for (let i = 0; i < INCIDENT_OPEN_TICKS; i++, t += 5 * MIN) await tickAt(e, t, both);
    expect(textsOf().at(-1)).toMatch(/^Opened: Namada RPC Papadritta: not ok since 29 Oct 2026, 13:14/);
    expect(state(db)!.reminds).toBe(0);
    const opened = discordPosts().at(-1)!.at;
    for (; t <= opened + H; t += 5 * MIN) await tickAt(e, t, both);
    expect(discordPosts().at(-1)!.at).toBe(opened + H);
    expect(textsOf().at(-1)!.split('\n').map((l) => l.slice(0, 34))).toEqual(['Still open: Namada RPC (epoch): no', 'Still open: Namada RPC Papadritta:']);
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

  it('one failure of a row that stays not ok for a day after it opens nothing, though successes since move its time; a second failure does', async () => {
    // the review's case (2026-10-29): one undecoded unbond at 10:00 keeps the decoder's row not ok for 24 h, its time
    // the last decode, which moved every 20 minutes; it opened at 10:20, reminded every hour and held the probe at 503
    net();
    const db = testD1();
    const e = env(db);
    const UNB = 'Namada RPC (live unbond decode)';
    const latched = (failedAt: number, lastAt: number) => ({ ...UP, [UNB]: { ok: false, at: lastAt, failedAt, note: 'block 8458000: abcd1234: unknown tx shape' } });
    let lastAt = T0;
    for (let m = 0; m <= 23 * 60; m++) {
      if (m > 0 && m % 20 === 0) lastAt = T0 + m * MIN;
      await tickAt(e, T0 + m * MIN, latched(T0, lastAt));
    }
    expect(discordPosts()).toHaveLength(0);
    expect(state(db)!.watch[UNB]).toMatchObject({ since: T0, bad: 23 * 60 + 1, reads: 1 });
    expect(await getHealth(db)).toMatchObject({ status: 200, body: { failing: [UNB], incidents: [] } });
    // a second undecoded unbond at 09:00 the next day: a new failure, and so the incident
    const second = T0 + 23 * H;
    await tickAt(e, second + MIN, latched(second, lastAt));
    expect(textsOf()).toEqual([`Opened: ${UNB}: not ok since 29 Oct 2026, 10:00${NB}UTC (23${NB}h, at least 10 ticks in a row): block 8458000: abcd1234: unknown tx shape.`]);
    // the mark of a row that says when it failed is that time alone; any other row's is its time and words
    expect(readMark({ name: UNB, ok: false, at: lastAt, failedAt: second, note: 'x' })).toBe(readMark({ name: UNB, ok: false, at: lastAt + H, failedAt: second, note: 'y' }));
    expect(readMark({ name: EPOCH, ok: false, at: T0, note: 'x' })).not.toBe(readMark({ name: EPOCH, ok: false, at: T0, note: 'y' }));
  });

  it("the alert delivery row's words change as alerts wait in the hub; one post not sent is still one failure", async () => {
    net();
    const db = testD1();
    const e = env(db);
    const DEL = 'Discord alert delivery';
    for (let m = 0; m <= 90; m++) {
      const waiting = m % 3 ? ` ${m} alert part(s), ${m} post(s), wait in the live hub's pending list.` : '';
      await tickAt(e, T0 + m * MIN, { ...UP, [DEL]: { ok: false, at: T0, failedAt: T0, note: `2 post(s) for whale alert not sent; 3 in all.${waiting}` } });
    }
    expect(discordPosts()).toHaveLength(0);
    expect(state(db)!.watch[DEL]).toMatchObject({ reads: 1 });
  });

  it('a check that fails opens with its own title, one past its window as "no recent result"; one that only needs a look opens nothing', async () => {
    net();
    const db = testD1();
    const e = env(db);
    insert(db, 'checks', [
      { key: 'osmosis_index', status: 'fail', title: "This site's Osmosis flow index: live stream and catch-up search", detail: '{}', checked_at: T0 },
      { key: 'rpc_consensus', status: 'ok', title: 'Namada RPC agreement', detail: '{}', checked_at: T0 - 20 * MIN },
      { key: 'bridge_records_paired', status: 'warn', title: 'Every bridge crossing is on record on both chains', detail: '{}', checked_at: T0 },
      // 17% found late (29 Oct), hourly: it needs a look, for days on end, and is no outage
      { key: 'osmosis_stream_share', status: 'warn', title: 'Osmosis moves found by the catch-up search', detail: JSON.stringify({ everyMs: H }), checked_at: T0 - 50 * MIN },
    ]);
    for (let i = 0; i <= 9; i++) {
      db.raw.prepare("UPDATE checks SET checked_at = ? WHERE key IN ('osmosis_index', 'bridge_records_paired')").run(T0 + i * MIN);
      await tickAt(e, T0 + i * MIN, UP);
    }
    const [text] = textsOf();
    expect(text.split('\n')).toEqual([
      `Opened: check osmosis\\_index: failing since 29 Oct 2026, 10:00${NB}UTC (9${NB}min, at least 10 ticks in a row): This site's Osmosis flow index: live stream and catch-up search.`,
      `Opened: check rpc\\_consensus: with no recent result since 29 Oct 2026, 10:00${NB}UTC (9${NB}min, at least 10 ticks in a row): last run 29 Oct 2026, 09:40${NB}UTC; Namada RPC agreement.`,
    ]);
    expect(Object.keys(state(db)!.open).sort()).toEqual(['check:osmosis_index', 'check:rpc_consensus']);
    expect(state(db)!.watch).toEqual({});
    // both pass again; the two warn checks go on for four hours of ticks, the hourly one run each hour: never an
    // incident, and the probe is green once the others are resolved
    db.raw.prepare("UPDATE checks SET status = 'ok' WHERE key = 'osmosis_index'").run();
    for (let m = 10; m <= 4 * 60; m++) {
      db.raw.prepare("UPDATE checks SET checked_at = ? WHERE key IN ('osmosis_index', 'bridge_records_paired', 'rpc_consensus')").run(T0 + m * MIN);
      if (m % 60 === 0) db.raw.prepare("UPDATE checks SET checked_at = ? WHERE key = 'osmosis_stream_share'").run(T0 + m * MIN);
      await tickAt(e, T0 + m * MIN, UP);
    }
    expect(textsOf().slice(1).flatMap((t) => t.split('\n')).map((l) => l.slice(0, 33))).toEqual(['Resolved: check osmosis\\_index: o', 'Resolved: check rpc\\_consensus: o']);
    expect(state(db)).toMatchObject({ open: {}, watch: {} });
    expect(await getHealth(db)).toMatchObject({ status: 200, body: { failing: [], incidents: [] } });
  });

  it('a health row turned off on purpose (the depth kill switch, a Worker that does not send alerts) opens nothing', () => {
    expect(offOnPurpose(KILL_SWITCH_NOTE)).toBe(true);
    expect(offOnPurpose(alertDeliveryOff({}, T0)!.note)).toBe(true);
    for (const n of ['Offline: no node answered', 'Error: HTTP 503', 'the depth kv rows could not be read: Off', undefined]) expect(offOnPurpose(n)).toBe(false);
    const rows = {
      [DEPTH_HEALTH.pools]: { name: DEPTH_HEALTH.pools, ok: false, at: T0, note: KILL_SWITCH_NOTE },
      'Discord alert delivery': alertDeliveryOff({}, T0)!,
      [EPOCH]: { name: EPOCH, ok: false, at: T0, note: 'Offline: no node answered' },
    };
    expect([...judge(rows, [], T0, T0).keys()]).toEqual([EPOCH]);
  });

  it("with the depth module's kill switch off (kv depth.on '0'), its rows and its four checks gone quiet open nothing, and an open one is let go unsaid", async () => {
    net();
    const db = testD1();
    const e = env(db);
    expect(DEPTH_NAMES).toEqual([...Object.values(DEPTH_HEALTH), 'check:depth_vs_chain_estimate', 'check:depth_vs_route_quote', 'check:depth_vs_executed', 'check:depth_budget']);
    const depthChecks = ['depth_vs_chain_estimate', 'depth_vs_route_quote', 'depth_vs_executed', 'depth_budget'];
    insert(db, 'checks', depthChecks.map((key) => ({ key, status: 'ok', title: key, detail: '{}', checked_at: T0 })));
    // the store row was failing before the switch went off, and opened
    const store = { [DEPTH_HEALTH.store]: { ok: false, note: 'rows written past the warn mark' } };
    for (let i = 0; i <= 9; i++) {
      db.raw.prepare('UPDATE checks SET checked_at = ?').run(T0 + i * MIN);
      await tickAt(e, T0 + i * MIN, { ...UP, ...store });
    }
    expect(textsOf()).toHaveLength(1);
    expect(state(db)!.open[DEPTH_HEALTH.store]).toBeDefined();
    // the owner turns depth off at 10:10: the minute writes the kill switch's rows and no check from then on
    insert(db, 'kv', [{ key: 'depth.on', value: '0', updated_at: T0 + 10 * MIN }]);
    const off = { ...UP, ...store, [DEPTH_HEALTH.pools]: { ok: false, note: KILL_SWITCH_NOTE }, [DEPTH_HEALTH.owners]: { ok: false, note: KILL_SWITCH_NOTE } };
    for (let m = 10; m <= 3 * 60; m++) await tickAt(e, T0 + m * MIN, off);
    expect(textsOf()).toHaveLength(1);
    expect(state(db)).toMatchObject({ open: {}, watch: {}, closing: [] });
    expect(await getHealth(db)).toMatchObject({ status: 200, body: { failing: [], incidents: [] } });
    // back on, and still not written: the quiet checks are incidents again, after their ten ticks
    db.raw.prepare("DELETE FROM kv WHERE key = 'depth.on'").run();
    for (let m = 3 * 60 + 1; m <= 3 * 60 + 10; m++) await tickAt(e, T0 + m * MIN, UP);
    expect(textsOf()[1].split('\n').map((l) => l.slice(0, 40))).toEqual([...depthChecks].sort().map((k) => `Opened: check ${k.replace(/_/g, '\\_')}: with no recent result`.slice(0, 40)));
    expect(letGo(null, '1')).toEqual(new Set());
    expect(letGo(null, ' 0 ')).toEqual(new Set(DEPTH_NAMES));
  });

  it('a name on the quiet list (kv ops.quiet) opens nothing; one open when it is put there is let go unsaid; the cron is never quiet', async () => {
    net();
    const db = testD1();
    const e = env(db);
    for (let i = 0; i <= 9; i++) await tickAt(e, T0 + i * MIN, DOWN);
    expect(textsOf()).toHaveLength(1);
    expect((await getHealth(db)).status).toBe(503);
    // the owner knows the node is down for days: puts it on the list
    insert(db, 'kv', [{ key: OPS_QUIET_KV, value: JSON.stringify([EPOCH, 'check:indexer_lag']), updated_at: T0 + 10 * MIN }]);
    for (let m = 10; m <= 6 * 60; m++) await tickAt(e, T0 + m * MIN, DOWN);
    expect(textsOf()).toHaveLength(1);
    expect(state(db)).toMatchObject({ open: {}, watch: {}, closing: [] });
    expect(await getHealth(db)).toMatchObject({ status: 200, body: { failing: [], incidents: [] } });
    // taken off the list while still down: it opens again after its ten ticks
    db.raw.prepare('DELETE FROM kv WHERE key = ?').run(OPS_QUIET_KV);
    for (let m = 6 * 60 + 1; m <= 6 * 60 + 10; m++) await tickAt(e, T0 + m * MIN, DOWN);
    expect(textsOf()[1]).toMatch(/^Opened: Namada RPC \(epoch\): not ok since 29 Oct 2026, 16:01/);
    // anything but a list of names is no list, and the cron's own ticks are never let go
    for (const raw of [null, '', 'Namada RPC (epoch)', '{"a":1}', '[1, null]']) expect(quietOf(raw)).toEqual(new Set());
    expect(quietOf('[" Namada RPC (epoch) ", ""]')).toEqual(new Set([EPOCH]));
    expect(letGo(JSON.stringify([CRON_TICKS, EPOCH]), null)).toEqual(new Set([EPOCH]));
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
    expect(row).toEqual({ since: T0 + H, openedAt: T0 + H + 15 * MIN, toldAt: T0 + H + 15 * MIN, remindedAt: T0 + H + 15 * MIN, reminds: 0 });
  });

  it('the hub reminds of a cron that stays stopped as the ticks are reminded: 1 h after its open, then 2 h after that', async () => {
    net();
    const db = testD1();
    const e = env(db);
    await tickAt(e, T0, UP);
    for (let m = 11; m <= 4 * 60; m++) { vi.setSystemTime(T0 + m * MIN); await watchCronStall(e); }
    expect(discordPosts().map((p) => (p.at - T0) / MIN)).toEqual([11, 71, 191]);
    expect(textsOf()[2]).toBe(`Still open: Cron ticks: no tick has completed since 29 Oct 2026, 10:00${NB}UTC (3.2${NB}h).`);
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
