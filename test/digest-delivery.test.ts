// Daily digest (2026-10-23), when it is sent: the cron's tick sends the day's digest on its first run at or after
// 08:00 UTC (the survey's stored rows seeded, so the digest is the one production's rows give), claimed once under
// alert:digest:daily:<UTC date> whatever the ticks, the isolates or the deploys; a tick at or after 08:00 that comes
// late sends it with the late note; a day with no run between 08:00 and midnight gets no digest later, and the next
// day's health row and operator embed say so; the weekly goes on Mondays under the ISO week's key; a Worker whose
// SEND_ALERTS is not yes builds nothing, claims nothing and says so on the "Daily digest" row, and a sending Worker on
// the same database sends it on its next tick; a build that fails in its header sends nothing and claims nothing.
// fetch is stubbed before any tick: Discord answers 204 and every other host 503, so nothing reaches Discord.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { base64 } from '@scure/base';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class { ctx: any; env: any; constructor(ctx: any, env: any) { this.ctx = ctx; this.env = env; } },
}));
import { app } from '../worker/src/api';
import { configureAlerts, alertBudget, resetClaimMemory } from '../worker/src/sources/discord';
import { DIGEST_HEALTH, prepareDigests, resetDigestMemory, sendDigests } from '../worker/src/digest/deliver';
import { testD1, type TestD1 } from './d1-sqlite';
import { seedCharts, seedSurvey, T } from './digest-survey';
import { kvJson, kvKeys, sent, stubDiscord, textOf, tick, titlesOf } from './digest-net';

const KEY = base64.encode(new Uint8Array(32).fill(41));
const OP = 'https://discord.com/api/webhooks/41/operator';
const MIN = 60_000, H = 60 * MIN, DAY = 24 * H;
const env = (db: TestD1, sends = true) => ({ DB: db, DISCORD_WEBHOOK_URL: OP, SETTINGS_KEY: KEY, ...(sends ? { SEND_ALERTS: 'yes' } : {}) }) as any;
const row = (db: TestD1) => kvJson(db, 'source.health')?.[DIGEST_HEALTH] ?? null;
const digestTitles = () => sent.flatMap(titlesOf).filter((t) => t.startsWith('NAM '));

function seeded(): TestD1 {
  const db = testD1();
  seedSurvey(db);
  seedCharts(db);
  return db;
}

beforeEach(() => { resetDigestMemory(); resetClaimMemory(); configureAlerts(KEY, true); stubDiscord(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('the 08:00 UTC trigger and the claim', () => {
  it('ticks at 07:58, 07:59, 08:00 and 08:01 send one digest, at 08:00, to the operator, with no late note', { timeout: 120_000 }, async () => {
    const db = seeded();
    for (const t of [T - 2 * MIN, T - MIN]) await tick(env(db), t);
    expect(sent).toEqual([]);
    expect(kvKeys(db, 'alert:digest:%')).toEqual([]);

    await tick(env(db), T);
    expect(digestTitles()).toEqual(['NAM daily digest · Fri 23 Oct 2026, 08:00 UTC']);
    expect(sent.every((p) => p.url === OP)).toBe(true);
    const first = sent[0];
    // the digest's first message carries its pictures as a form; the operator's own embed is in one of its messages
    expect(first.form).toBe(true);
    expect(first.files.map((f) => f.field)).toEqual(first.files.map((_, i) => `files[${i}]`));
    expect(first.files.every((f) => f.type === 'image/png' && f.size > 0)).toBe(true);
    expect(sent.flatMap(titlesOf)).toContain('Operator');
    expect(textOf(first)).toContain('The 24 h to <t:1792742400:f>.');
    expect(textOf(first)).not.toContain('min late)');
    expect(kvKeys(db, 'alert:digest:%')).toEqual(['alert:digest:daily:2026-10-23', 'alert:digest:daily:2026-10-23:op']);
    expect(kvJson(db, 'digest.last')).toMatchObject({ key: 'alert:digest:daily:2026-10-23', at: T, targets: 1, posted: 1, skipped: 0, waiting: 0 });
    expect(row(db)).toMatchObject({ ok: true, note: 'Digest 2026-10-23 sent 23 Oct 08:00 UTC to 1 of 1 channel.' });
    const n = sent.length;

    await tick(env(db), T + MIN);
    expect(sent.length).toBe(n);
  });

  it('a fresh isolate after the send makes one primary-key read and builds nothing; two isolates at once post each channel once', { timeout: 120_000 }, async () => {
    const db = seeded();
    await tick(env(db), T);
    const n = sent.length;
    expect(n).toBeGreaterThan(0);

    // a new isolate: nothing in memory, so it asks the database once and finds the period done
    resetDigestMemory();
    const before = db.queries;
    const run = await prepareDigests(db as any, T + 2 * MIN, true);
    expect(run.jobs).toEqual([]);
    expect(db.queries - before).toBe(1);

    // two isolates (two copies of the modules, each with its own memory) on a new day, at the same time
    const fresh = seeded();
    vi.resetModules();
    const a = await import('../worker/src/digest/deliver');
    const da = await import('../worker/src/sources/discord');
    vi.resetModules();
    const b = await import('../worker/src/digest/deliver');
    const dbb = await import('../worker/src/sources/discord');
    da.configureAlerts(KEY, true);
    dbb.configureAlerts(KEY, true);
    stubDiscord();
    vi.useFakeTimers({ now: T, toFake: ['Date'] });
    const once = async (m: typeof a, d: typeof da) => {
      const r = await m.prepareDigests(fresh as any, T, true);
      await m.sendDigests(fresh as any, OP, r, d.alertBudget(), []);
    };
    await Promise.all([once(a, da), once(b, dbb)]);
    vi.useRealTimers();
    expect(digestTitles()).toEqual(['NAM daily digest · Fri 23 Oct 2026, 08:00 UTC']);
    expect(kvKeys(fresh, 'alert:digest:%')).toEqual(['alert:digest:daily:2026-10-23', 'alert:digest:daily:2026-10-23:op']);
  });
});

describe('a late run and a missed day', () => {
  it('down from 07:40 to 13:02: the 13:02 tick sends it with the late note and the 24 h to 13:02 UTC', { timeout: 120_000 }, async () => {
    const db = seeded();
    await tick(env(db), T - 20 * MIN);
    expect(sent).toEqual([]);
    const at = T + 5 * H + 2 * MIN;
    await tick(env(db), at);
    expect(digestTitles()).toEqual(['NAM daily digest · Fri 23 Oct 2026, 13:02 UTC']);
    const d = sent[0].json.embeds[0].description as string;
    expect(d).toContain(`The 24 h to <t:${at / 1000}:f>.`);
    expect(d).toContain('Sent at 13:02 UTC, the first run at or after 08:00 UTC in which it could be sent (5 h 2 min late).');
    expect(row(db)).toMatchObject({ ok: true, note: 'Digest 2026-10-23 sent 23 Oct 13:02 UTC, 5 h 2 min after 08:00 UTC to 1 of 1 channel.' });
  });

  it('a day with no run after 08:00 gets no digest later; the next day says so on the health row and in the operator embed', { timeout: 180_000 }, async () => {
    const db = seeded();
    await tick(env(db), T - DAY); // 22 Oct 08:00: sent
    expect(kvKeys(db, 'alert:digest:daily:%')).toEqual(['alert:digest:daily:2026-10-22', 'alert:digest:daily:2026-10-22:op']);
    await tick(env(db), T - 20 * MIN); // 23 Oct 07:40, then nothing until the next day
    await tick(env(db), T + DAY - H); // 24 Oct 07:00
    expect(kvKeys(db, 'alert:digest:daily:2026-10-23%')).toEqual([]);
    expect(row(db)).toMatchObject({ ok: false, note: 'No digest on 23 Oct: no run between 08:00 and 24:00 UTC.' });
    const res = await app.request('/api/integrity', {}, { DB: db } as any);
    const sources = ((await res.json()) as { sources: { name: string; ok: boolean; note?: string }[] }).sources;
    expect(sources.find((s) => s.name === DIGEST_HEALTH)).toMatchObject({ ok: false, note: 'No digest on 23 Oct: no run between 08:00 and 24:00 UTC.' });

    sent.length = 0;
    await tick(env(db), T + DAY); // 24 Oct 08:00
    expect(digestTitles()).toEqual(['NAM daily digest · Sat 24 Oct 2026, 08:00 UTC']);
    const operator = sent.flatMap((p) => p.json.embeds as any[]).find((e) => e.title === 'Operator');
    expect(operator.description).toContain('No digest was sent on 23 Oct (no run between 08:00 and 24:00 UTC).');
    expect(row(db)).toMatchObject({ ok: true, note: 'Digest 2026-10-24 sent 24 Oct 08:00 UTC to 1 of 1 channel.' });
    // the 23rd is never asked again
    expect(kvKeys(db, 'alert:digest:daily:2026-10-23%')).toEqual([]);
  });
});

describe('the weekly on Mondays', () => {
  it('Monday 26 Oct 08:00 sends the daily, then the weekly under 2026-W44; Tuesday sends the daily only, with Monday\'s daily record intact', { timeout: 180_000 }, async () => {
    const db = seeded();
    const MON = Date.UTC(2026, 9, 26, 8);
    await tick(env(db), MON);
    expect(digestTitles()).toEqual(['NAM daily digest · Mon 26 Oct 2026, 08:00 UTC', 'NAM weekly digest · 7 days to Mon 26 Oct 2026, 08:00 UTC']);
    expect(kvKeys(db, 'alert:digest:%')).toEqual([
      'alert:digest:daily:2026-10-26', 'alert:digest:daily:2026-10-26:op', 'alert:digest:weekly:2026-W44', 'alert:digest:weekly:2026-W44:op',
    ]);
    expect(kvJson(db, 'digest.last')).toMatchObject({ key: 'alert:digest:daily:2026-10-26', posted: 1, targets: 1 });
    expect(kvJson(db, 'digest.last.weekly')).toMatchObject({ key: 'alert:digest:weekly:2026-W44', posted: 1, targets: 1 });
    // the daily before the weekly: every post of the daily went first
    const weeklyAt = sent.findIndex((p) => titlesOf(p)[0]?.startsWith('NAM weekly'));
    expect(sent.slice(0, weeklyAt).every((p) => !titlesOf(p)[0]?.startsWith('NAM weekly'))).toBe(true);

    sent.length = 0;
    await tick(env(db), MON + DAY);
    expect(digestTitles()).toEqual(['NAM daily digest · Tue 27 Oct 2026, 08:00 UTC']);
    expect(kvKeys(db, 'alert:digest:weekly:%').filter((k) => !k.startsWith('alert:digest:weekly:2026-W44'))).toEqual([]);
    const operator = sent.flatMap((p) => p.json.embeds as any[]).find((e) => e.title === 'Operator');
    expect(operator.description).toContain("Yesterday's digest reached 1 of 1 channel");
  });
});

describe('a Worker that does not send alerts', () => {
  it('builds nothing, claims nothing and records no post as not sent; its row says why; a sending Worker sends it on its next tick', { timeout: 120_000 }, async () => {
    const db = seeded();
    configureAlerts(KEY, false);
    await tick(env(db, false), T);
    expect(sent).toEqual([]);
    expect(kvKeys(db, 'alert:digest:%')).toEqual([]);
    expect(kvJson(db, 'alerts.skipped')).toBeNull();
    expect(kvJson(db, 'digest.last')).toBeNull();
    expect(row(db)).toMatchObject({ ok: false, note: 'Not sent: SEND_ALERTS is not yes on this Worker, so no digest is claimed or posted.' });

    configureAlerts(KEY, true);
    await tick(env(db), T + MIN);
    expect(digestTitles()).toEqual(['NAM daily digest · Fri 23 Oct 2026, 08:01 UTC']);
    expect(textOf(sent[0])).not.toContain('late)');
    expect(row(db)).toMatchObject({ ok: true });
  });
});

describe('a build that fails in its header', () => {
  it('sends nothing and claims nothing; the row says it was not built; the next run tries again', async () => {
    const db = seeded();
    db.exec('ALTER TABLE metrics RENAME TO metrics_away');
    vi.useFakeTimers({ now: T, toFake: ['Date'] });
    const health: any[] = [];
    await sendDigests(db as any, OP, await prepareDigests(db as any, T, true), alertBudget(), health);
    expect(sent).toEqual([]);
    expect(kvKeys(db, 'alert:digest:%')).toEqual([]);
    expect(health).toHaveLength(1);
    expect(health[0]).toMatchObject({ name: DIGEST_HEALTH, ok: false });
    expect(health[0].note).toMatch(/^Digest 2026-10-23: not built: digest: the epoch could not be read/);

    db.exec('ALTER TABLE metrics_away RENAME TO metrics');
    vi.setSystemTime(T + MIN);
    const again: any[] = [];
    await sendDigests(db as any, OP, await prepareDigests(db as any, T + MIN, true), alertBudget(), again);
    vi.useRealTimers();
    expect(digestTitles()).toEqual(['NAM daily digest · Fri 23 Oct 2026, 08:01 UTC']);
    expect(again.at(-1)).toMatchObject({ name: DIGEST_HEALTH, ok: true, note: 'Digest 2026-10-23 sent 23 Oct 08:01 UTC to 1 of 1 channel.' });
  });
});
