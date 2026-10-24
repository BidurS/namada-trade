// Security review (2026-10-22), the invalid-answer budget and a link proven in its row: the dispatcher held a hook it
// had not itself posted to with success, on a row saved within a day, once INVALID_BUDGET invalid answers were counted
// in the window, and read no proof from the row (`okAt`, written by a Settings test post, by the save's connection
// notice, or by another isolate's alert). So 250 free identities with made-up links and every rule at 1 NAM, answered
// 404 by the first offered move of a window, had every honest subscriber whose row was saved or changed within the day
// held for the rest of the window on every move, test post or not, and so was any hook whose last answer here was a
// timeout. The row's okAt now proves a link in every isolate, and the hold applies only to links first turned on
// within a day with no success recorded anywhere. Fetch is stubbed: nothing reaches Discord.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { testD1 } from './d1-sqlite';
import { saveSettings, defaultPrefs, hookOkStmt, type StoredSettings } from '../worker/src/settings';
import { alarmBudget, configureAlerts, flushAlerts, INVALID_BUDGET, INVALID_WINDOW_MS } from '../worker/src/sources/discord';
import { memStorage } from './do-storage';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import { LiveHub, PENDING_PREFIX } from '../worker/src/live-hub';
import type { Flow } from '../shared/types';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const KEY = 'DQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0=';
const OP = 'https://discord.com/api/webhooks/301/operator';
const HONEST = 'https://discord.com/api/webhooks/9100/honest';
const fake = (i: number) => `https://discord.com/api/webhooks/${9300000 + i}/madeup${i}`;
const MASP = 'tnam1pcqnhjdcg9tqf2txl2em2pxm7sexlnr7ds7wfr72';
const unshield = (n: number, ts: number): Flow => ({ id: `namada:UN${n}:0`, chain: 'namada', height: n, ts, txHash: `UN${n}`, kind: 'unshield', from: MASP, to: `tnam1qreceiver${String(n).padStart(4, '0')}${'z'.repeat(26)}`, amount: 60_000, meta: null }) as unknown as Flow;
/** A 15,000 NAM bond: a whale for the operator, a match for a rule at 1 NAM, no match for the default bond rule. */
const bond = (n: number, ts: number): Flow => ({ id: `namada:BD${n}:0`, chain: 'namada', height: n, ts, txHash: `BD${n}`, kind: 'bond', from: `tnam1qstaker${String(n).padStart(4, '0')}${'z'.repeat(28)}`, to: 'tnam1qvalidator', amount: 15_000, meta: null }) as unknown as Flow;

describe('Security review (2026-10-22), a link proven in its row is not held for other links\' answers', () => {
  it('after 250 made-up links are answered 404 in a window, a day-old subscriber whose row records a successful post is posted to on the next move of the window, in a hub that never posted to it', { timeout: 120_000 }, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // The start of a window, so the whole test stays in one.
    vi.setSystemTime(Math.floor(Date.UTC(2026, 9, 23, 9) / INVALID_WINDOW_MS) * INVALID_WINDOW_MS + 60_000);
    const db = testD1();
    configureAlerts(KEY, true);
    const T = Date.now();
    // The honest subscriber: saved an hour ago, the default rules, and a Settings test post (or the save's notice) that
    // Discord took half an hour ago, recorded in the row.
    const honest: StoredSettings = { address: `tnam1qhonest${'q'.repeat(34)}`, notifications: defaultPrefs(), channels: { discord: { enabled: true, webhookUrl: HONEST } }, createdAt: T - 3_600_000, updatedAt: T - 3_600_000 };
    expect(await saveSettings(db as any, KEY, honest)).toBe(true);
    expect(Number((await hookOkStmt(db as any, KEY, honest.address, HONEST, T - 1_800_000).run()).meta?.changes)).toBe(1);
    // 250 free identities: made-up links, every rule at 1 NAM (saved directly, as a row with Discord on and no post).
    for (let i = 0; i < INVALID_BUDGET; i++) {
      const p = defaultPrefs();
      for (const r of Object.values(p.rules)) { r.on = true; r.thresholdNam = 1; }
      const s: StoredSettings = { address: `tnam1qmadeup${String(i).padStart(4, '0')}${'q'.repeat(30)}`, notifications: p, channels: { discord: { enabled: true, webhookUrl: fake(i) } }, createdAt: T - 60_000, updatedAt: T - 60_000 };
      expect(await saveSettings(db as any, KEY, s)).toBe(true);
    }
    const posts: { url: string; tx: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => {
      const url = String(u);
      const body = JSON.parse(String(init?.body));
      posts.push({ url, tx: String(body.embeds[0].description).slice(5, 8) });
      if (url === OP || url === HONEST) return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ message: 'Unknown Webhook', code: 10015 }), { status: 404, headers: { 'content-type': 'application/json' } });
    }));
    const storage = memStorage();
    const hub: any = Object.assign(Object.create(LiveHub.prototype), { env: { DB: db, DISCORD_WEBHOOK_URL: OP }, ctx: { storage }, pendingN: null, pendingPosts: null, pendingNoted: null, pendingSeq: 0 });
    // The first offered move of the window, a 15,000 NAM bond: the 250 made-up links are posted to and answered 404;
    // the honest subscriber's default rules do not match it, so the hub has not posted to its link.
    const b1 = alarmBudget(Date.now() + 142_000, true);
    await hub.alertFlows([bond(1, Date.now())], 10000, 10, b1);
    await flushAlerts(db as any, b1);
    expect(posts.filter((x) => x.tx === 'BD1' && x.url !== OP && x.url !== HONEST).length).toBe(INVALID_BUDGET);
    expect(posts.filter((x) => x.url === HONEST)).toHaveLength(0);
    expect(JSON.parse((db.raw.prepare("SELECT value FROM kv WHERE key = 'alerts.invalid'").get() as any).value).n).toBe(INVALID_BUDGET);
    // A later move of the same window, a 60,000 NAM unshield, on the next alarm (the users are read again): only the
    // honest subscriber matches now, the made-up links having been turned off.
    vi.setSystemTime(Date.now() + 20_000);
    const b2 = alarmBudget(Date.now() + 142_000, true);
    await hub.alertFlows([unshield(2, Date.now())], 10000, 10, b2);
    await flushAlerts(db as any, b2);
    expect(posts.filter((x) => x.tx === 'UN2' && x.url === OP)).toHaveLength(1);
    // The next alarm of the window offers whatever was kept.
    vi.setSystemTime(Date.now() + 20_000);
    const b3 = alarmBudget(Date.now() + 142_000, true);
    await hub.sendPending(b3);
    await flushAlerts(db as any, b3);
    const pending = (await storage.list({ prefix: PENDING_PREFIX })).size;
    // Nothing of the honest subscriber's answers made the budget spent, and its link is proven in its row: posted.
    expect({ honestPostsOfMove2: posts.filter((x) => x.tx === 'UN2' && x.url === HONEST).length, pending }).toEqual({ honestPostsOfMove2: 1, pending: 0 });
  });
});
