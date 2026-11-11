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
import { PAUSE_GAP_MS } from '../worker/src/digest/operator';
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

describe('days on which the alerts were paused', () => {
  // a Worker that sends alerts, paused: its entry sets both (worker/src/index.ts), a test sets both by hand
  const pausedTick = async (db: TestD1, at: number) => { configureAlerts(KEY, false, true); await tick({ ...env(db), ALERTS_PAUSED: 'paused' }, at); };
  const sendingTick = async (db: TestD1, at: number) => { configureAlerts(KEY, true, false); await tick(env(db), at); };
  const operatorTexts = () => sent.flatMap((p) => (p.json.embeds ?? []) as any[]).filter((e) => e?.title === 'Operator').map((e) => String(e.description ?? ''));
  const operatorText = () => operatorTexts()[0] ?? '';
  const stretches = (db: TestD1): { from: number; to: number }[] => kvJson(db, 'digest.paused')?.stretches ?? [];
  const integrityRow = async (db: TestD1) => {
    const res = await app.request('/api/integrity', {}, { DB: db } as any);
    return ((await res.json()) as { sources: { name: string; ok: boolean; note?: string }[] }).sources.find((x) => x.name === DIGEST_HEALTH);
  };

  it('the pause lifted before 08:00: the day before had runs, each held, so its row says alerts were paused and is ok; the next digest says the same', { timeout: 240_000 }, async () => {
    const db = seeded();
    await sendingTick(db, T - DAY); // 22 Oct 08:00: sent
    // 23 Oct: every run held, to the end of the day
    for (const at of [T - 10 * MIN, T, T + 7 * H, T + 16 * H - 5 * MIN]) await pausedTick(db, at);
    expect(kvKeys(db, 'alert:digest:daily:2026-10-23%')).toEqual([]);
    expect(row(db)).toMatchObject({ ok: false });
    // held runs ten minutes apart are one stretch; hours apart, stretches of their own, each kept
    expect(stretches(db)).toEqual([{ from: T - 10 * MIN, to: T }, { from: T + 7 * H, to: T + 7 * H }, { from: T + 16 * H - 5 * MIN, to: T + 16 * H - 5 * MIN }]);

    await sendingTick(db, T + DAY - 3 * H); // 24 Oct 05:00: the pause is lifted
    // the row the held runs left does not stand on: the day is said as held, and the row is ok
    expect(row(db)).toMatchObject({ ok: true, note: 'No digest on 23 Oct: alerts were paused. The next one is due at 08:00 UTC.' });
    expect(await integrityRow(db)).toMatchObject({ ok: true, note: 'No digest on 23 Oct: alerts were paused. The next one is due at 08:00 UTC.' });

    sent.length = 0;
    await sendingTick(db, T + DAY); // 24 Oct 08:00
    expect(digestTitles()).toEqual(['NAM daily digest · Sat 24 Oct 2026, 08:00 UTC']);
    const op = operatorText();
    expect(op).toContain('No digest was sent on 23 Oct: alerts were paused.');
    expect(op).not.toContain('no run between');
    // the window holds paused time: its claims are counted as claims, the line says a claim taken then was held, and
    // the posts not sent for another reason are said apart
    // (the stretch that ended as the window began is not in it: two of the three reach into these 24 hours)
    expect(op).toContain('Alerts in the 24 h: 0 claimed. Alerts were paused from 23:55 UTC yesterday to 23:55 UTC yesterday (the last of 2 such stretches in the window): a claim taken while paused was held, not posted. Apart from that: none not sent on record.');
    expect(op).not.toMatch(/Alerts in the 24 h: \d+ posted/);
    expect(op).not.toContain('no alert post was held back');
  });

  it('the pause lifted after 08:00: the day\'s digest goes on the first run after it, and the day before is named as held, not as a day with no run', { timeout: 240_000 }, async () => {
    const db = seeded();
    await sendingTick(db, T - DAY); // 22 Oct 08:00: sent
    for (const at of [T, T + 15 * H + 55 * MIN, T + DAY, T + DAY + 90 * MIN]) await pausedTick(db, at); // held through 24 Oct 09:30
    expect(row(db)).toMatchObject({ ok: false });
    expect(row(db).note).not.toContain('No digest on');

    sent.length = 0;
    await sendingTick(db, T + DAY + 2 * H); // 24 Oct 10:00
    expect(digestTitles()).toHaveLength(1);
    expect(digestTitles()[0]).toMatch(/^NAM daily digest · Sat 24 Oct 2026/);
    expect(operatorText()).toContain('No digest was sent on 23 Oct: alerts were paused.');
    expect(operatorText()).not.toContain('no run between');
    // the first digest after the pause, built before this tick's rows replace the held runs': no row of the pause's own
    expect(operatorText()).not.toContain('(ALERTS_PAUSED)');
    expect(kvKeys(db, 'alert:digest:daily:2026-10-23%')).toEqual([]);
  });

  it('a pause that ended before the day did, with no run after it, and a pause that began after the day ended: the day is still a day with no run', { timeout: 240_000 }, async () => {
    const db = seeded();
    await sendingTick(db, T - DAY);
    await pausedTick(db, T - 30 * MIN); // 23 Oct 07:30, held; then nothing until the next day
    await sendingTick(db, T + DAY - H); // 24 Oct 07:00
    expect(row(db)).toMatchObject({ ok: false, note: 'No digest on 23 Oct: no run between 08:00 and 24:00 UTC.' });

    // no run at all on the 23rd, then a held run on the 24th at 01:00: the stretch begins after the day ended. (An
    // older stretch is on record, as it is on any database that has been paused before: only the first record of all
    // is taken back to the first skipped digest.)
    const other = seeded();
    resetDigestMemory();
    other.raw.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('digest.paused', ?, 0)").run(JSON.stringify({ stretches: [{ from: T - 30 * DAY, to: T - 29 * DAY }] }));
    await sendingTick(other, T - DAY);
    await pausedTick(other, T + 17 * H); // 24 Oct 01:00
    resetDigestMemory();
    await sendingTick(other, T + DAY - H); // 24 Oct 07:00
    expect(row(other)).toMatchObject({ ok: false, note: 'No digest on 23 Oct: no run between 08:00 and 24:00 UTC.' });
  });

  it('paused, lifted and sending for hours, paused again: two stretches, and the hours between are not said as paused', { timeout: 240_000 }, async () => {
    const db = seeded();
    await sendingTick(db, T - DAY); // 22 Oct 08:00: sent
    for (const at of [T - DAY + H, T - DAY + H + 10 * MIN]) await pausedTick(db, at); // 22 Oct 09:00 to 09:10
    await sendingTick(db, T - DAY + 4 * H); // 22 Oct 12:00: sending again
    for (const at of [T - DAY + 7 * H, T - DAY + 7 * H + 10 * MIN]) await pausedTick(db, at); // 22 Oct 15:00 to 15:10
    expect(stretches(db)).toEqual([{ from: T - DAY + H, to: T - DAY + H + 10 * MIN }, { from: T - DAY + 7 * H, to: T - DAY + 7 * H + 10 * MIN }]);

    sent.length = 0;
    await sendingTick(db, T); // 23 Oct 08:00
    const op = operatorText();
    // the newest stretch is named with its own start, and that there were two
    expect(op).toMatch(/Alerts were paused from 15:00 UTC yesterday to 15:10 UTC yesterday \(the last of 2 such stretches in the window\)/);
    expect(op).not.toContain('from 09:00 UTC yesterday to 15:10');
  });

  it('paused, then sending for a few minutes, then paused again: the run that sent closes the stretch, so the minutes it sent are not counted as paused', { timeout: 240_000 }, async () => {
    const db = seeded();
    await sendingTick(db, T - DAY); // 22 Oct 08:00: sent
    await pausedTick(db, T - 10 * H); // 22 Oct 14:00, held
    resetDigestMemory(); // another isolate, as after a deploy
    await sendingTick(db, T - 10 * H + 15 * MIN); // 14:15: sending (the pause lifted); the runs before it were held
    expect(stretches(db)).toEqual([{ from: T - 10 * H, to: T - 10 * H + 15 * MIN, closed: true }]);
    resetDigestMemory();
    await pausedTick(db, T - 10 * H + 30 * MIN); // 14:30: held again, within PAUSE_GAP_MS of the first
    expect(stretches(db)).toEqual([{ from: T - 10 * H, to: T - 10 * H + 15 * MIN, closed: true }, { from: T - 10 * H + 30 * MIN, to: T - 10 * H + 30 * MIN }]);
  });

  it('production\'s own start: the last digest nine days old and no record of the pause; held runs, the pause lifted before 08:00, then the daily and the weekly', { timeout: 420_000 }, async () => {
    const db = seeded();
    // as production holds it: the last daily sent on 14 Oct and the last weekly on the Monday before it, nothing
    // recorded of the pause since
    db.raw.prepare("INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES ('digest.last', ?, 0)").run(JSON.stringify({ key: 'alert:digest:daily:2026-10-14', at: T - 9 * DAY + 3 * MIN, targets: 1, posted: 1, skipped: 0, waiting: 0, lastAt: T - 9 * DAY + 3 * MIN }));
    db.raw.prepare("INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES ('digest.last.weekly', ?, 0)").run(JSON.stringify({ key: 'alert:digest:weekly:2026-W42', at: T - 11 * DAY + 3 * MIN, targets: 1, posted: 1, skipped: 0, waiting: 0, lastAt: T - 11 * DAY + 3 * MIN }));
    db.raw.prepare("DELETE FROM kv WHERE key LIKE 'alert:digest:daily:2026-10-1%' OR key LIKE 'alert:digest:daily:2026-10-2%'").run();
    // the first held run after the deploy (23 Oct 23:55): the stretch starts where the first skipped digest was due
    await pausedTick(db, T + 16 * H - 5 * MIN);
    expect(stretches(db)).toEqual([{ from: T - 8 * DAY, to: T + 16 * H - 5 * MIN }]);
    // lifted on 24 Oct at 05:00: the day before is said as held, and the row is ok
    await sendingTick(db, T + DAY - 3 * H);
    expect(row(db)).toMatchObject({ ok: true, note: 'No digest on 23 Oct: alerts were paused. The next one is due at 08:00 UTC.' });
    expect(stretches(db).at(-1)?.closed).toBe(true);

    sent.length = 0;
    await sendingTick(db, T + DAY); // Sat 24 Oct 08:00: the first daily after the pause
    const daily = operatorText();
    expect(daily).toContain('No digest was sent on 23 Oct: alerts were paused.');
    expect(daily).toMatch(/Alerts were paused from before this window to 23:55 UTC yesterday: a claim taken while paused was held, not posted\./);
    expect(daily).not.toContain('no run between');

    await sendingTick(db, T + 2 * DAY); // Sun 25 Oct 08:00
    sent.length = 0;
    await sendingTick(db, T + 3 * DAY); // Mon 26 Oct 08:00: the daily and the first weekly
    const weekly = operatorTexts().find((d) => d.includes('Alerts in the 7 d')) ?? '';
    expect(weekly).toContain('No digest was sent on 19 Oct, 20 Oct, 21 Oct, 22 Oct, 23 Oct: alerts were paused.');
    expect(weekly).not.toContain('no run between');
    expect(weekly).toMatch(/Alerts in the 7 d: \d+ claimed/);
  });

  it('the weekly: days that ended inside a stretch are named as held, a day with no run as a day with no run, each once', { timeout: 300_000 }, async () => {
    const db = seeded();
    // Monday 26 Oct 2026 08:00 UTC is three days after T (Friday 23 Oct)
    const MON = T + 3 * DAY;
    await sendingTick(db, T - DAY); // Thu 22 Oct: sent
    await pausedTick(db, T + 16 * H - 5 * MIN); // Fri 23 Oct 23:55: held to the end of the day
    await pausedTick(db, T + DAY + 16 * H - 5 * MIN); // Sat 24 Oct 23:55: held to the end of the day
    // Sun 25 Oct: no run at all
    sent.length = 0;
    await sendingTick(db, MON);
    const weekly = operatorTexts().find((d) => d.includes('Alerts in the 7 d')) ?? '';
    expect(weekly).toContain('No digest was sent on 23 Oct, 24 Oct: alerts were paused. No digest was sent on 25 Oct (no run between 08:00 and 24:00 UTC).');
  });

  it('a held run is recorded at most every ten minutes in an isolate; the first record of all starts where the first skipped digest was due; a Worker without SEND_ALERTS records nothing', async () => {
    const db = testD1();
    configureAlerts(KEY, false, true);
    const t0 = T + 2 * H;
    await prepareDigests(db as any, t0, false);
    expect(stretches(db)).toEqual([{ from: t0, to: t0 }]); // no digest on record: the stretch starts at this run
    await prepareDigests(db as any, t0 + 9 * MIN, false);
    expect(stretches(db)).toEqual([{ from: t0, to: t0 }]);
    await prepareDigests(db as any, t0 + 10 * MIN, false);
    expect(stretches(db)).toEqual([{ from: t0, to: t0 + 10 * MIN }]);
    // another isolate records its own first run, and the stretch goes on
    resetDigestMemory();
    await prepareDigests(db as any, t0 + 11 * MIN, false);
    expect(stretches(db)).toEqual([{ from: t0, to: t0 + 11 * MIN }]);
    // a held run more than PAUSE_GAP_MS after the newest one starts a stretch of its own, and the older one is kept
    resetDigestMemory();
    const later = t0 + 11 * MIN + PAUSE_GAP_MS + MIN;
    await prepareDigests(db as any, later, false);
    expect(stretches(db)).toEqual([{ from: t0, to: t0 + 11 * MIN }, { from: later, to: later }]);

    // the first record of all, with the last daily digest more than a day old: a digest was skipped the day after
    // it, so the stretch starts at the hour that one was due (never at the last digest itself: its day's posts went)
    const old = testD1();
    resetDigestMemory();
    old.raw.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('digest.last', ?, 0)").run(JSON.stringify({ key: 'alert:digest:daily:2026-10-14', at: T - 9 * DAY + 3 * MIN, targets: 1, posted: 1, skipped: 0, waiting: 0, lastAt: T - 9 * DAY + 3 * MIN }));
    await prepareDigests(old as any, t0, false);
    expect(stretches(old)).toEqual([{ from: T - 8 * DAY, to: t0 }]);
    // with the last digest under a day old no digest was skipped: the stretch starts at this run
    const recent = testD1();
    resetDigestMemory();
    recent.raw.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('digest.last', ?, 0)").run(JSON.stringify({ key: 'alert:digest:daily:2026-10-23', at: T, targets: 1, posted: 1, skipped: 0, waiting: 0, lastAt: T }));
    await prepareDigests(recent as any, t0, false);
    expect(stretches(recent)).toEqual([{ from: t0, to: t0 }]);

    // not paused, and not sending: nothing is recorded
    const other = testD1();
    resetDigestMemory();
    configureAlerts(KEY, false, false);
    await prepareDigests(other as any, t0, false);
    expect(kvJson(other, 'digest.paused')).toBeNull();
  });
});

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

    // a new isolate: nothing in memory, so it asks the database for the period, finds it done, and looks once for a
    // stretch of the pause left open (closePaused, once an isolate); its next run asks nothing
    resetDigestMemory();
    const before = db.queries;
    const run = await prepareDigests(db as any, T + 2 * MIN, true);
    expect(run.jobs).toEqual([]);
    expect(db.queries - before).toBe(2);
    const again = db.queries;
    expect((await prepareDigests(db as any, T + 3 * MIN, true)).jobs).toEqual([]);
    expect(db.queries - again).toBe(0);

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
