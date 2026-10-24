// Security review (2026-10-22), a block page that lasts through a cron run's forum alert: every subscriber post is
// answered 429 with none of Discord's headers. The cron's dispatch cannot keep a post for later and the alert's claim
// is taken, so each subscriber post not taken is lost; the question here is only whether the loss is on record (kv
// alerts.skipped, which the "Discord alert delivery" health row reads). Fetch is stubbed: nothing reaches Discord.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { base64 } from '@scure/base';
import { testD1, type TestD1 } from './d1-sqlite';
import type { StoredSettings } from '../worker/src/settings';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });

const KEY = base64.encode(new Uint8Array(32).fill(53));
const OP = 'https://discord.com/api/webhooks/306/operator';
const SUBS = 30;
const blockPage = () => new Response('<html><title>Access denied</title>error code: 1015</html>', { status: 429, headers: { 'content-type': 'text/html' } });
const ok = () => new Response(null, { status: 204 });
const kvJson = (db: TestD1, key: string) => {
  const r = db.raw.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return r ? JSON.parse(r.value) : null;
};
const forumPost = (id: number) => ({ id, topicId: 7, topicTitle: 't', topicSlug: 't', postNumber: 2, url: `https://forum.namada.net/t/t/7/${id}`, username: 'u', displayName: null, avatarUrl: null, createdAt: new Date().toISOString(), excerpt: 'e', isNewTopic: false });

describe('Security review (2026-10-22), a block page through a cron run\'s forum alert', () => {
  it('every subscriber post the block answers is lost with the claim taken, and each such loss is on record after one retry each', { timeout: 120_000 }, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 9, 23, 21, 0, 5));
    vi.resetModules();
    const d = await import('../worker/src/sources/discord');
    const s = await import('../worker/src/settings');
    d.configureAlerts(KEY, true);
    const db = testD1();
    const T = Date.now();
    for (let i = 0; i < SUBS; i++) {
      const url = `https://discord.com/api/webhooks/${9700 + i}/blockall${i}`;
      const p = s.defaultPrefs();
      p.forumAndGov = true;
      const row: StoredSettings = { address: `tnam1qblockall${String(i).padStart(3, '0')}${'q'.repeat(29)}`, notifications: p, channels: { discord: { enabled: true, webhookUrl: url } }, createdAt: T - 3 * 86_400_000, updatedAt: T - 3 * 86_400_000 };
      expect(await s.saveSettings(db as any, KEY, row)).toBe(true);
      await s.hookOkStmt(db as any, KEY, row.address, url, T - 2 * 86_400_000).run();
    }
    let subPosts = 0, opPosts = 0;
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      if (String(u) === OP) { opPosts++; return ok(); }
      subPosts++;
      return blockPage();
    }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const run = d.alertBudget(Date.now());
    const r = await d.sendDiscordForumAlert(OP, forumPost(990177), db as any, run);
    await d.flushAlerts(db as any, run);
    const skipped = kvJson(db, 'alerts.skipped');
    expect(opPosts).toBe(1);
    expect(kvJson(db, 'alert:forum:post:990177'), 'the claim is taken').not.toBeNull();
    // Not one subscriber was reached and no later run posts the alert: the record should say so.
    expect(skipped?.total ?? 0, 'subscribers not reached are on record').toBeGreaterThanOrEqual(SUBS);
  });
});
