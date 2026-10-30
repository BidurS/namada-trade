// Merged stage 1 review (2026-10-29): the "Discord alert delivery" health row went not ok, with a new failedAt, at every
// post a subscriber's own link held (its bucket filled by posts from elsewhere, its own Retry-After, its backoff), and
// the operator's incidents (ops.ts) now judge that row like any outage: one outsider's webhook, flooded from curl or
// shared with a busy bot, opened "Discord alert delivery" for the owner and held /api/health at 503 for as long as it
// lasted and a day more. kv alerts.skipped now keeps the posts subscribers' links held apart from the site's own
// (AlertsSkipped `last.own`, `site`), and only the site's set the row not ok. Nothing reaches Discord.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { testD1 } from './d1-sqlite';
import { recordSkipped, type AlertsSkipped } from '../worker/src/sources/discord';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import { alertDeliveryRow, ALERT_DELIVERY_HEALTH } from '../worker/src/cron';
import { readHealth, runOps } from '../worker/src/ops';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const kvJson = (db: ReturnType<typeof testD1>, key: string) => {
  const r = db.raw.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return r ? JSON.parse(r.value) : null;
};
const H = 3_600_000;
const T = Date.UTC(2026, 9, 29, 12);

describe('posts a subscriber\'s own link held', () => {
  it('are on record apart from the site\'s, and never set the row not ok', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: T });
    const db = testD1();
    await recordSkipped(db as any, 1, 'move 1 (1 to links held for the window)', 1);
    let s: AlertsSkipped = kvJson(db, 'alerts.skipped');
    expect(s).toEqual({ total: 1, last: { what: 'move 1 (1 to links held for the window)', n: 1, at: T, own: 1 } });
    expect(alertDeliveryRow(s, T)).toEqual({ name: ALERT_DELIVERY_HEALTH, ok: true, at: T, note: expect.stringMatching(/^Subscribers' own links held 1 post\(s\) \(their own rate limits or backoff\), not the site's delivery: move 1/) });
    // the site's own: a post past the run's deadline. The row is not ok, from then.
    vi.setSystemTime(T + H);
    await recordSkipped(db as any, 3, 'move 2 (1 past the run\'s deadline)', 2);
    s = kvJson(db, 'alerts.skipped');
    expect(s.site).toEqual({ what: 'move 2 (1 past the run\'s deadline)', n: 1, at: T + H });
    expect(alertDeliveryRow(s, T + H)).toMatchObject({ ok: false, at: T + H, failedAt: T + H, note: '1 post(s) for move 2 (1 past the run\'s deadline) not sent; 4 in all' });
    // more held posts after it: the site's case stands, with its own time (no new failure), for a day
    vi.setSystemTime(T + 2 * H);
    await recordSkipped(db as any, 5, 'move 3 (5 to links held for the window)', 5);
    s = kvJson(db, 'alerts.skipped');
    expect(s.site).toEqual({ what: 'move 2 (1 past the run\'s deadline)', n: 1, at: T + H });
    expect(alertDeliveryRow(s, T + 2 * H)).toMatchObject({ ok: false, failedAt: T + H });
    expect(alertDeliveryRow(s, T + H + 24 * H)).toMatchObject({ ok: true });
  });

  it('a record written before they were counted apart counts whole as the site\'s, and is carried as such', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: T });
    const old: AlertsSkipped = { total: 7, last: { what: 'move 9', n: 2, at: T - H } };
    expect(alertDeliveryRow(old, T)).toMatchObject({ ok: false, failedAt: T - H });
    const db = testD1();
    db.raw.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('alerts.skipped', ?, 0)").run(JSON.stringify(old));
    await recordSkipped(db as any, 1, 'move 10', 1);
    const s: AlertsSkipped = kvJson(db, 'alerts.skipped');
    expect(s.site).toEqual({ what: 'move 9', n: 2, at: T - H });
    expect(alertDeliveryRow(s, T)).toMatchObject({ ok: false, failedAt: T - H });
  });

  it('a held link at every tick for an hour opens no incident and leaves /api/health answering 200', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: T });
    const db = testD1();
    const told: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) => { told.push(String(init?.body)); return new Response(null, { status: 204 }); }));
    const env = { DB: db, SEND_ALERTS: 'yes', DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/op' } as any;
    for (let k = 0; k < 15; k++) {
      vi.setSystemTime(T + k * 4 * 60_000);
      await recordSkipped(db as any, 1, `move ${k} (1 to links held for the window)`, 1);
      const row = alertDeliveryRow(kvJson(db, 'alerts.skipped'), Date.now());
      db.raw.prepare("INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES ('source.health', ?, ?)").run(JSON.stringify({ [ALERT_DELIVERY_HEALTH]: row }), Date.now());
      await runOps(env, Date.now());
    }
    expect(told.join('\n')).not.toContain(ALERT_DELIVERY_HEALTH);
    expect(Object.keys(kvJson(db, 'ops.incidents')?.open ?? {})).toEqual([]);
    const health = await readHealth(db as any, Date.now());
    expect(health.status).toBe(200);
    expect(health.body.failing).toEqual([]);
  });
});
