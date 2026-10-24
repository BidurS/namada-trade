// Security review (2026-10-22), the LiveHub's post count: a LiveHub pass bounded its subscribers' posts by a time
// window only (fanoutBudget had no post count), while the cron counts its own posts against the per-invocation
// subrequest limit (RUN_ALERT_POSTS). With 500 subscribers whose rules match every move and a Discord answering in
// 40 ms, eight matching moves on one shared budget made 2,138 posts, and each move read and wrote the shared records
// (alerts.invalid, alerts.skipped) again. One LiveHub dispatch now has one post count (LIVE_ALERT_POSTS): an alarm's
// Namada scan and catch-up search share it, posts past it wait for the next alarm in the hub's own storage (live-hub.ts
// PendingAlert; a budget used outside the hub records them as the cron does), and the shared records are read and
// written once a dispatch. Fetch is stubbed: nothing reaches Discord.
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class { ctx: any; env: any; constructor(ctx: any, env: any) { this.ctx = ctx; this.env = env; } },
}));
import { base64 } from '@scure/base';
import { LiveHub, PENDING_PREFIX } from '../worker/src/live-hub';
import * as discord from '../worker/src/sources/discord';
import { configureAlerts, fanoutBudget, sendDiscordWhaleAlert, type PendingAlert } from '../worker/src/sources/discord';
import { saveSettings, defaultPrefs, type StoredSettings } from '../worker/src/settings';
import { NAM, NAMADA } from '../worker/src/config';
import { testD1, type TestD1 } from './d1-sqlite';
import { memStorage } from './do-storage';
import type { Flow } from '../shared/types';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const KEY = base64.encode(new Uint8Array(32).fill(12));
const MASP = NAMADA.internal.masp;
const H = 8_000_000;
const BLOCK_MS = 6826;
const OSMO_HEAD = 1_000_500;
const POST_MS = 40;
/** The cron's own count of posts a run may make: one LiveHub dispatch is held to no more (LIVE_ALERT_POSTS, and the operator's post of each move). */
const POSTS_MAX = 600;
const WATCHED = 'osmo1watchedsenderaddressxxxxxxxxxxxxxxxxx';
const later = <T>(ms: number, v: () => T) => new Promise<T>((r) => setTimeout(() => r(v()), ms));
const kv = (db: TestD1, key: string) => (db.raw.prepare('SELECT value FROM kv WHERE key = ?').get(key) as any)?.value ?? null;
const skippedTotal = (db: TestD1) => { const v = kv(db, 'alerts.skipped'); return v ? JSON.parse(v).total as number : 0; };

/** `n` subscribers, each with a link of its own, whose rules match every unshield and every move of WATCHED. */
async function seedUsers(db: TestD1, n: number) {
  for (let i = 0; i < n; i++) {
    const p = defaultPrefs();
    for (const r of Object.values(p.rules)) r.on = false;
    p.rules.unshield = { on: true, thresholdNam: 1 };
    p.watchlistOn = true;
    p.watchlist = [WATCHED];
    const s: StoredSettings = { address: `tnam1qposts${String(i).padStart(6, '0')}${'q'.repeat(28)}`, notifications: p, channels: { discord: { enabled: true, webhookUrl: `https://discord.com/api/webhooks/${3000 + i}/t` } }, createdAt: 1, updatedAt: 1 + i };
    await saveSettings(db as any, KEY, s);
  }
}

/** Every query's text and its bound values, to count the reads and writes of the shared records. */
function logQueries(db: TestD1) {
  const log: { sql: string; params: unknown[] }[] = [];
  const prepare = db.prepare.bind(db);
  db.prepare = (sql: string) => {
    const st: any = prepare(sql);
    const bind = st.bind.bind(st);
    st.bind = (...p: unknown[]) => { log.push({ sql, params: p }); return bind(...p); };
    return st;
  };
  const reads = (key: string) => log.filter((q) => /^\s*SELECT/i.test(q.sql) && q.params.includes(key)).length;
  const writes = (key: string) => log.filter((q) => /^\s*(INSERT|UPDATE)/i.test(q.sql) && q.params.includes(key)).length;
  return { reads, writes };
}

/** Drive a promise to settle in virtual time, 100 ms at a step. */
async function settle<T>(p: Promise<T>, capSeconds = 4000): Promise<void> {
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; !done && i < capSeconds * 10; i++) await vi.advanceTimersByTimeAsync(100);
  expect(done, 'settled').toBe(true);
}

const unshieldFlows = (prefix: string, k: number): Flow[] =>
  Array.from({ length: k }, (_, i) => ({ id: `namada:${prefix}${i}:0`, chain: 'namada', height: H, ts: Date.now(), txHash: `${prefix}${i}`, kind: 'unshield', from: MASP, to: `tnam1qrecv${String(i).padStart(4, '0')}${'z'.repeat(29)}`, amount: 20 } as Flow));

const unshieldEvent = (hash: string, n: number) => ({
  type: 'token/transfer',
  attributes: [
    { key: 'token-event-descriptor', value: 'transfer-from-wasm' },
    { key: 'hash', value: hash },
    { key: 'source-accounts', value: JSON.stringify([[[`internal-address/${MASP}`, NAM.namadaToken], String(n * 20_000_000)]]) },
    { key: 'target-accounts', value: JSON.stringify(Array.from({ length: n }, (_, k) => [[`internal-address/tnam1qposts${String(k).padStart(4, '0')}${'z'.repeat(30)}`, NAM.namadaToken], '20000000'])) },
  ],
});
const transfer = (i: number) => ({
  type: 'transfer',
  attributes: [{ key: 'recipient', value: `osmo1postsrecv${i}` }, { key: 'sender', value: WATCHED }, { key: 'amount', value: `${20_000 * 1e6}${NAM.osmoDenom}` }, { key: 'msg_index', value: '0' }],
});

describe('Security review (2026-10-22), the LiveHub\'s post count', () => {
  it('eight matching moves on one dispatch\'s budget, 500 subscribers, Discord at 40 ms: at most the count of posts, the shared records read and written once', { timeout: 120_000 }, async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const db = testD1();
    const N = 500, K = 8;
    await seedUsers(db, N);
    configureAlerts(KEY);
    const posts: string[] = [];
    vi.stubGlobal('fetch', vi.fn((u: any) => { posts.push(String(u)); return later(POST_MS, () => new Response(null, { status: 204 })); }));
    const q = logQueries(db);
    // A budget used outside the hub (no pending list): what the count cuts is recorded as not sent.
    const budget = fanoutBudget();
    await settle((async () => {
      for (const f of unshieldFlows('POSTS', K)) await sendDiscordWhaleAlert(undefined, f, db as any, 10000, budget);
      await (discord as any).flushAlerts?.(db, budget);
    })());
    expect(posts.length).toBeLessThanOrEqual(POSTS_MAX);
    // Every target is accounted for: posted, or recorded as not sent.
    expect(posts.length + skippedTotal(db)).toBe(K * N);
    expect(q.reads('alerts.invalid')).toBeLessThanOrEqual(1);
    expect(q.writes('alerts.skipped')).toBeLessThanOrEqual(1);
  });

  it('an alarm\'s Namada scan and catch-up search share one count: eight matching legs and eight matching Osmosis moves, at most the count of posts', { timeout: 120_000 }, async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const T0 = Date.now();
    const db = testD1();
    const N = 400, K = 8;
    await seedUsers(db, N);
    await db.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('namada.cursor', ?, 0)").bind(String(H - 1)).run();
    await db.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('osmosis.cursor', ?, 0)").bind(JSON.stringify({ height: 1_000_000, at: 0 })).run();
    const txs = Array.from({ length: K }, (_, i) => ({ hash: `POSTSOSMO${String(i).padStart(4, '0')}`, height: String(1_000_100 + i), tx_result: { code: 0, events: [transfer(i)] } }));
    const discordPosts: string[] = [];
    vi.stubGlobal('fetch', vi.fn((input: any) => {
      const url = String(input);
      if (url.startsWith('https://discord.com/')) { discordPosts.push(url); return later(POST_MS, () => new Response(null, { status: 204 })); }
      if (url.includes('sqs.osmosis.zone')) return Promise.resolve(new Response('no', { status: 404 }));
      const u = new URL(url);
      if (u.host === 'rpc-namada.5elementsnodes.com' || u.host === 'rpc.papadritta.com') {
        const head = H + Math.floor((Date.now() - T0) / BLOCK_MS);
        if (u.pathname === '/status') return Promise.resolve(Response.json({ result: { node_info: { network: NAMADA.chainId }, sync_info: { latest_block_height: String(head), latest_block_time: new Date().toISOString(), catching_up: false, earliest_block_height: '1' } } }));
        if (u.pathname === '/blockchain') {
          const lo = Number(u.searchParams.get('minHeight')), hi = Number(u.searchParams.get('maxHeight'));
          const metas = [];
          for (let h = hi; h >= lo; h--) metas.push({ header: { chain_id: NAMADA.chainId, height: String(h), time: new Date(T0 + (h - H) * BLOCK_MS).toISOString() }, num_txs: '0' });
          return Promise.resolve(Response.json({ result: { block_metas: metas } }));
        }
        if (u.pathname === '/block_results') {
          const h = Number(u.searchParams.get('height'));
          return Promise.resolve(Response.json({ result: { height: String(h), txs_results: h === H ? [{ code: 0, events: [unshieldEvent('P4'.repeat(32), K)] }] : null } }));
        }
        if (u.pathname === '/block') return Promise.resolve(new Response('no', { status: 503 }));
      }
      if (u.host === 'osmosis-rpc.publicnode.com') {
        if (u.pathname.endsWith('/status')) return Promise.resolve(Response.json({ result: { sync_info: { latest_block_height: String(OSMO_HEAD) } } }));
        if (u.pathname.endsWith('/tx_search')) return Promise.resolve(Response.json({ result: { txs } }));
        if (u.pathname.endsWith('/block')) return Promise.resolve(Response.json({ result: { block: { header: { time: new Date().toISOString() } } } }));
        return Promise.resolve(new Response('no', { status: 404 }));
      }
      return Promise.reject(new TypeError(`offline: ${url}`));
    }));
    vi.stubGlobal('WebSocket', class { addEventListener() {} send() {} close() {} });
    const storage = memStorage();
    const ctx: any = { blockConcurrencyWhile: (f: () => Promise<unknown>) => f(), storage };
    const hub = new LiveHub(ctx, { DB: db, SETTINGS_KEY: KEY, SEND_ALERTS: 'yes', KEPLR_KEY: '' } as any) as any;
    await vi.advanceTimersByTimeAsync(0);
    await settle(hub.alarm());
    expect(discordPosts.length).toBeLessThanOrEqual(POSTS_MAX);
    // The search ran to its end and offered its moves; the scan alerted its legs; every target is accounted for:
    // posted, or kept for the next alarm (changed with the pending list: before, the rest was recorded as not sent).
    expect(JSON.parse(kv(db, 'osmosis.cursor')).height).toBe(OSMO_HEAD);
    expect(Number(kv(db, 'namada.cursor'))).toBeGreaterThanOrEqual(H);
    expect(db.raw.prepare("SELECT COUNT(*) n FROM kv WHERE key LIKE 'alert:flow:namada:%'").get().n).toBeGreaterThan(0);
    const kept = [...(await storage.list<PendingAlert>({ prefix: PENDING_PREFIX })).values()];
    expect(discordPosts.length + kept.reduce((n, p) => n + p.n, 0)).toBe(2 * K * N);
    expect(skippedTotal(db)).toBe(0);
    // The next alarms send what was kept, first, until nothing is left.
    const first = discordPosts.length;
    for (let i = 0; i < 20 && (await storage.list({ prefix: PENDING_PREFIX })).size; i++) {
      await vi.advanceTimersByTimeAsync(6000);
      await settle(hub.alarm());
    }
    expect((await storage.list({ prefix: PENDING_PREFIX })).size).toBe(0);
    expect(discordPosts.length).toBe(2 * K * N);
    expect(discordPosts.length).toBeGreaterThan(first);
    expect(skippedTotal(db)).toBe(0);
  });
});
