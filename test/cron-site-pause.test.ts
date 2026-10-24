// Security review (2026-10-22), a limit on the site's address in the middle of a cron run's forum or governance
// alert: a block page in front of discord.com answers one post with 429 and none of Discord's headers and no
// Retry-After, which was read as a pause of 60 s. The cron's dispatch cannot keep a post for later, and every
// subscriber not yet posted had that pause outlast its in-place wait, so each was recorded as not sent with the
// alert's claim already taken: no later run posted them, where deployed code posted each and let its own answer
// decide. A subscriber of such a dispatch is now posted anyway once a pause outlasts its wait (its own answer decides,
// and a limit that is still there answers again and is counted), and a 429 that names no Retry-After is a short pause.
// Fetch is stubbed: nothing reaches Discord. Each case loads the dispatcher afresh, as a new isolate has it: a limit on
// the address is the isolate's to remember.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { base64 } from '@scure/base';
import { testD1, type TestD1 } from './d1-sqlite';
import type { StoredSettings } from '../worker/src/settings';
import type { PendingAlert } from '../worker/src/sources/discord';
import { memStorage } from './do-storage';
import type { Flow } from '../shared/types';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });

const KEY = base64.encode(new Uint8Array(32).fill(52));
const OP = 'https://discord.com/api/webhooks/305/operator';
const SUBS = 30;
const MASP = 'tnam1pcqnhjdcg9tqf2txl2em2pxm7sexlnr7ds7wfr72';
/** Cloudflare's block page in front of discord.com: a 429 with no scope and no Retry-After. */
const blockPage = () => new Response('<html><title>Access denied</title>error code: 1015</html>', { status: 429, headers: { 'content-type': 'text/html' } });
/** A 429 in front of Discord with none of its headers and a Retry-After of 30 s: longer than any wait in place. */
const longLimited = () => new Response('<html>rate limited</html>', { status: 429, headers: { 'content-type': 'text/html', 'retry-after': '30' } });
const ok = () => new Response(null, { status: 204 });
const kvJson = (db: TestD1, key: string) => {
  const r = db.raw.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return r ? JSON.parse(r.value) : null;
};
const forumPost = (id: number) => ({ id, topicId: 7, topicTitle: 't', topicSlug: 't', postNumber: 2, url: `https://forum.namada.net/t/t/7/${id}`, username: 'u', displayName: null, avatarUrl: null, createdAt: new Date().toISOString(), excerpt: 'e', isNewTopic: false });

async function fresh() {
  vi.resetModules();
  const d = await import('../worker/src/sources/discord');
  const s = await import('../worker/src/settings');
  const h = await import('../worker/src/live-hub');
  d.configureAlerts(KEY, true);
  return { d, s, h };
}
type Fresh = Awaited<ReturnType<typeof fresh>>;
async function forumRows(m: Fresh, db: TestD1, tag: string) {
  const T = Date.now();
  const urls = Array.from({ length: SUBS }, (_, i) => `https://discord.com/api/webhooks/${9600 + i}/${tag}${i}`);
  for (const [i, url] of urls.entries()) {
    const p = m.s.defaultPrefs();
    p.forumAndGov = true;
    const row: StoredSettings = { address: `tnam1q${tag}${String(i).padStart(3, '0')}${'q'.repeat(36 - tag.length)}`, notifications: p, channels: { discord: { enabled: true, webhookUrl: url } }, createdAt: T - 3 * 86_400_000, updatedAt: T - 3 * 86_400_000 };
    expect(await m.s.saveSettings(db as any, KEY, row)).toBe(true);
    await m.s.hookOkStmt(db as any, KEY, row.address, url, T - 2 * 86_400_000).run();
  }
  return urls;
}

describe('Security review (2026-10-22), a limit on the site\'s address in a cron run\'s forum alert', () => {
  it('one header-less 429 with no Retry-After: the alert\'s other subscribers are still posted', { timeout: 60_000 }, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 9, 23, 20, 0, 5));
    const m = await fresh();
    const db = testD1();
    await forumRows(m, db, 'forumbp');
    let calls = 0;
    const took: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      if (++calls === 3) return blockPage();
      took.push(String(u));
      return ok();
    }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const run = m.d.alertBudget(Date.now());
    const r = await m.d.sendDiscordForumAlert(OP, forumPost(990077), db as any, run);
    await m.d.flushAlerts(db as any, run);
    const subsTook = took.filter((u) => u !== OP).length;
    console.log(`run answer ${r}; posts made ${calls}; subscribers posted ${subsTook} of ${SUBS}; claim ${JSON.stringify(kvJson(db, 'alert:forum:post:990077'))}; not sent ${JSON.stringify(kvJson(db, 'alerts.skipped'))}`);
    // One subscriber's post drew the 429 and is posted once more after the short pause: every subscriber is posted.
    expect(subsTook).toBe(SUBS);
    expect(kvJson(db, 'alerts.skipped'), 'no subscriber recorded as not sent for the site\'s pause').toBeNull();
  });

  it('a header-less 429 whose Retry-After outlasts every wait in place, Discord answering again at once: every other subscriber is posted, its own answer deciding', { timeout: 60_000 }, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 9, 23, 20, 10, 5));
    const m = await fresh();
    const db = testD1();
    await forumRows(m, db, 'forumlong');
    let calls = 0;
    const took: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      if (++calls === 2) return longLimited();
      took.push(String(u));
      return ok();
    }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const run = m.d.alertBudget(Date.now());
    const started = performance.now();
    expect(await m.d.sendDiscordForumAlert(OP, forumPost(990078), db as any, run)).toBe('done');
    await m.d.flushAlerts(db as any, run);
    expect(took.filter((u) => u !== OP)).toHaveLength(SUBS - 1);
    expect(took).toContain(OP);
    // The one post whose pause outlasts what the alert can wait is lost with the claim taken, and is on record.
    expect(kvJson(db, 'alerts.skipped')?.total).toBe(1);
    expect(kvJson(db, 'alerts.skipped')?.last?.what).toContain('answered rate-limited');
    expect(kvJson(db, 'alerts.invalid').n, 'the 429 is still an invalid answer').toBe(1);
    expect(performance.now() - started, 'nothing waited the 30 s out').toBeLessThan(10_000);
    // A later alert of the same run, while the limit stands: it waits for the next run, its claim untaken.
    expect(await m.d.sendDiscordForumAlert(OP, forumPost(990079), db as any, run)).toBe('waiting');
    expect(kvJson(db, 'alert:forum:post:990079')).toBeNull();
  });

  it('a block page with no Retry-After in a LiveHub alarm is a short pause: the next alarm, six seconds on, posts what was kept', { timeout: 60_000 }, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 9, 23, 20, 20, 5));
    const m = await fresh();
    const db = testD1();
    const T = Date.now();
    const url = 'https://discord.com/api/webhooks/9650/shortpause';
    const row: StoredSettings = { address: `tnam1qshortpause${'q'.repeat(30)}`, notifications: m.s.defaultPrefs(), channels: { discord: { enabled: true, webhookUrl: url } }, createdAt: T - 3 * 86_400_000, updatedAt: T - 3 * 86_400_000 };
    expect(await m.s.saveSettings(db as any, KEY, row)).toBe(true);
    await m.s.hookOkStmt(db as any, KEY, row.address, url, T - 2 * 86_400_000).run();
    let calls = 0;
    const took: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      if (++calls === 1) return blockPage();
      took.push(String(u));
      return ok();
    }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage = memStorage();
    const hub: any = Object.assign(Object.create(m.h.LiveHub.prototype), { env: { DB: db }, ctx: { storage }, pendingN: null, pendingPosts: null, pendingNoted: null, pendingSeq: 0 });
    const flow = { id: 'namada:SP1:0', chain: 'namada', height: 1, ts: Date.now(), txHash: 'SP1', kind: 'unshield', from: MASP, to: `tnam1qreceiver0001${'z'.repeat(26)}`, amount: 60_000, meta: null } as unknown as Flow;
    const alarm = async (flows: Flow[]) => {
      vi.setSystemTime(Date.now() + 6_000);
      const b = m.d.alarmBudget(Date.now() + 142_000, true);
      await hub.sendPending(b);
      if (flows.length) await hub.alertFlows(flows, 10000, 10, b);
      await m.d.flushAlerts(db as any, b);
    };
    await alarm([flow]);
    expect(took).toHaveLength(0);
    expect([...(await storage.list<PendingAlert>({ prefix: 'alerts.pending:' })).values()]).toHaveLength(1);
    await alarm([]);
    expect(took, 'posted at the next alarm').toEqual([url]);
    expect([...(await storage.list<PendingAlert>({ prefix: 'alerts.pending:' })).values()]).toHaveLength(0);
    expect(kvJson(db, 'alerts.skipped')).toBeNull();
  });
});
