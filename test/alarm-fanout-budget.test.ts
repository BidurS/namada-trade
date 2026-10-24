// Security review (2026-10-22), alert fan-out inside the live hub's single-flight alarm: the alarm awaited each
// matching move's Discord fan-out one after another, and the only bound was per move (FANOUT_DEADLINE_MS, measured
// from each move's own first post). So enough matching moves in one pass — which a signed-in wallet can make its own
// low-threshold rule match cheaply — held the alarm far past its own deadline (ALARM_DEADLINE_MS), starving the
// Osmosis catch-up search that was due in the same invocation and delaying the next Namada block scan. Each dispatch
// now has one budget across its alerts: an alarm's Namada scan and catch-up search share one post count
// (LIVE_ALERT_POSTS) and the alarm's own deadline, each alert with a window of its own, and a live stream message has
// one window across its moves and the same count; the operator's own channel is served first and is never dropped
// for a window, a count or a deadline. What the count, the window or the deadline cuts is not dropped either: the hub
// keeps it in its own storage and the next alarm sends it first, marked found late (live-hub.ts PendingAlert); a
// budget used outside the hub records it with the posts not sent.
//
// The posts sent are the faithful, harness-independent signal of the bound: a dispatch makes at most its count of
// posts whatever the number of moves, where the per-move bound admitted every subscriber PER move. (The awaited
// virtual time is also measured, but only as a ratio between a small and a large move count at the same subscriber
// count: vi.useFakeTimers makes each AES settings decrypt and each AbortSignal.timeout cost virtual time, so an
// absolute virtual-time bound would track the subscriber count, not the fix.)
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class { ctx: any; env: any; constructor(ctx: any, env: any) { this.ctx = ctx; this.env = env; } },
}));
import { base64 } from '@scure/base';
import { ALARM_DEADLINE_MS, LiveHub, PENDING_PREFIX } from '../worker/src/live-hub';
import { FANOUT_DEADLINE_MS, LIVE_ALERT_POSTS, alarmBudget, fanoutBudget, flushAlerts, windowFor, configureAlerts, sendDiscordWhaleAlert, type PendingAlert } from '../worker/src/sources/discord';
import { saveSettings, defaultPrefs, type StoredSettings } from '../worker/src/settings';
import { NAM, NAMADA } from '../worker/src/config';
import { testD1, type TestD1 } from './d1-sqlite';
import { memStorage } from './do-storage';
import type { Flow } from '../shared/types';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const KEY = base64.encode(new Uint8Array(32).fill(9));
const MASP = NAMADA.internal.masp;
const H = 8_000_000;
const BLOCK_MS = 6826;
const OSMO_HEAD = 1_000_500;
const N = 400; // dummy subscribers, each with its own Discord webhook
const POST_MS = 300; // each stubbed Discord post; POST_CONCURRENCY run in parallel

class NeverOpens { addEventListener() {} send() {} close() {} }
const later = <T>(ms: number, v: () => T) => new Promise<T>((r) => setTimeout(() => r(v()), ms));
const kv = (db: TestD1, key: string) => (db.raw.prepare('SELECT value FROM kv WHERE key = ?').get(key) as any)?.value ?? null;
const skipped = (db: TestD1) => { const v = kv(db, 'alerts.skipped'); return v ? JSON.parse(v) : null; };

async function seedUsers(db: TestD1, n = N) {
  for (let i = 0; i < n; i++) {
    const p = defaultPrefs();
    for (const r of Object.values(p.rules)) r.on = false;
    p.rules.unshield = { on: true, thresholdNam: 1 }; // the lowest the API allows: matches every unshield
    const s: StoredSettings = { address: `tnam1qdummy${String(i).padStart(6, '0')}${'q'.repeat(28)}`, notifications: p, channels: { discord: { enabled: true, webhookUrl: `https://discord.com/api/webhooks/${1000 + i}/t` } }, createdAt: 1, updatedAt: 1 + i };
    await saveSettings(db as any, KEY, s);
  }
}

const unshieldEvent = (hash: string, n: number, tag: string) => ({
  type: 'token/transfer',
  attributes: [
    { key: 'token-event-descriptor', value: 'transfer-from-wasm' },
    { key: 'hash', value: hash },
    { key: 'source-accounts', value: JSON.stringify([[[`internal-address/${MASP}`, NAM.namadaToken], String(n * 20_000_000)]]) },
    { key: 'target-accounts', value: JSON.stringify(Array.from({ length: n }, (_, k) => [[`internal-address/tnam1q${tag}${String(k).padStart(4, '0')}${'z'.repeat(30)}`, NAM.namadaToken], '20000000'])) },
  ],
});

function producers(T0: number, log: string[], discord: string[], eventsAt: Map<number, any[]>, late?: string[]) {
  return vi.fn((input: any, init?: RequestInit) => {
    const url = String(input);
    log.push(url);
    if (url.startsWith('https://discord.com/')) {
      discord.push(url);
      late?.push(JSON.parse(String(init?.body)).embeds[0].fields.find((f: any) => f.name === 'Found late')?.value ?? '');
      return later(POST_MS, () => new Response(null, { status: 204 }));
    }
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
        const ev = eventsAt.get(h);
        return Promise.resolve(Response.json({ result: { height: String(h), txs_results: ev ? [{ code: 0, events: ev }] : null } }));
      }
      if (u.pathname === '/block') return Promise.resolve(new Response('no', { status: 503 }));
    }
    if (u.host === 'osmosis-rpc.publicnode.com') {
      if (u.pathname.endsWith('/status')) return Promise.resolve(Response.json({ result: { sync_info: { latest_block_height: String(OSMO_HEAD) } } }));
      if (u.pathname.endsWith('/tx_search')) return Promise.resolve(Response.json({ result: { txs: [] } }));
      return Promise.resolve(new Response('no', { status: 404 }));
    }
    return Promise.reject(new TypeError(`offline: ${url}`));
  });
}

/** Drive a promise to settle in virtual time, 100 ms at a step; returns the virtual ms elapsed. */
async function settle<T>(p: Promise<T>, capSeconds = 4000): Promise<{ v: T; ms: number }> {
  const t = Date.now();
  let done = false; let v!: T;
  p.then((x) => { v = x; done = true; }, () => { done = true; });
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; !done && i < capSeconds * 10; i++) await vi.advanceTimersByTimeAsync(100);
  expect(done, 'settled').toBe(true);
  return { v, ms: Date.now() - t };
}

function newHub(db: TestD1, eventsAt: Map<number, any[]>, keplr = '') {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const T0 = Date.now();
  const log: string[] = [], discord: string[] = [], late: string[] = [];
  vi.stubGlobal('fetch', producers(T0, log, discord, eventsAt, late));
  vi.stubGlobal('WebSocket', NeverOpens);
  const storage = memStorage();
  const setAlarm = vi.spyOn(storage, 'setAlarm');
  const ctx: any = { blockConcurrencyWhile: (f: () => Promise<unknown>) => f(), storage };
  const hub = new LiveHub(ctx, { DB: db, SETTINGS_KEY: KEY, SEND_ALERTS: 'yes', KEPLR_KEY: keplr } as any) as any;
  const pending = async () => [...(await storage.list<PendingAlert>({ prefix: PENDING_PREFIX })).values()];
  return { hub, log, discord, late, setAlarm, storage, pending, T0, headNow: () => H + Math.floor((Date.now() - T0) / BLOCK_MS) };
}

const unshieldFlows = (prefix: string, k: number): Flow[] =>
  Array.from({ length: k }, (_, i) => ({ id: `namada:${prefix}${i}:0`, chain: 'namada', height: H, ts: Date.now(), txHash: `${prefix}${i}`, kind: 'unshield', from: MASP, to: `tnam1qrecv${String(i).padStart(4, '0')}${'z'.repeat(29)}`, amount: 20 } as Flow));

describe('Security review (2026-10-22), alert fan-out budget: one budget across a dispatch, not one per move', () => {
  it('the posts of one alertFlows pass are capped by its post count whatever the number of matching moves, and its first move reaches every subscriber', { timeout: 120_000 }, async () => {
    const db = testD1();
    await seedUsers(db);
    const K = 8;
    const { hub, discord, late, pending } = newHub(db, new Map());
    await vi.advanceTimersByTimeAsync(0);
    await settle(hub.alertFlows(unshieldFlows('WA', K), 10000, 10));
    // One pass makes at most LIVE_ALERT_POSTS posts; a per-move bound would have admitted every subscriber K times.
    expect(discord.length).toBeLessThanOrEqual(LIVE_ALERT_POSTS);
    // One window posts every channel of an alert: the first move reached all N subscribers.
    expect(new Set(discord.slice(0, N)).size).toBe(N);
    // Every target is accounted for: posted now, or kept for the next alarm (changed with the pending list: before, the
    // rest was recorded as not sent); nothing is recorded as not sent.
    const kept = await pending();
    expect(kept.length).toBeGreaterThan(0);
    expect(discord.length + kept.reduce((n, p) => n + p.n, 0)).toBe(K * N);
    expect(skipped(db)).toBeNull();
    // The next alarm sends the kept parts first, marked as having waited, until every subscriber has heard every move.
    const sent = discord.length;
    for (let alarms = 0; (await pending()).length && alarms < 8; alarms++) {
      const budget = alarmBudget(Date.now() + ALARM_DEADLINE_MS, true);
      await settle(hub.sendPending(budget));
      await flushAlerts(db as any, budget);
    }
    expect(discord.length).toBe(K * N);
    expect(new Set(late.slice(sent))).toEqual(new Set([expect.stringMatching(/^This alert waited for a later run; it happened <t:\d+:f>/)]));
    expect(late.slice(0, sent).every((x) => x === '')).toBe(true);
    expect(skipped(db)).toBeNull();
  });

  it('the awaited time of alertFlows does not grow with the number of moves (one window, not K)', { timeout: 120_000 }, async () => {
    const one = testD1(); await seedUsers(one);
    const a = newHub(one, new Map()); await vi.advanceTimersByTimeAsync(0);
    const single = (await settle(a.hub.alertFlows(unshieldFlows('K1', 1), 10000, 10))).ms;
    vi.useRealTimers(); vi.unstubAllGlobals();

    const many = testD1(); await seedUsers(many);
    const b = newHub(many, new Map()); await vi.advanceTimersByTimeAsync(0);
    const batch = (await settle(b.hub.alertFlows(unshieldFlows('K8', 8), 10000, 10))).ms;
    // Same subscriber count, eight times the moves: under the fix both run one window and one post count, so the time
    // grows far less than the moves; a per-move window would make eight moves about eight times as long. The fake
    // clock also counts the settings reads (each decrypt's real time passes as virtual time while settle steps the
    // clock), which makes up most of a single move's measured time and grows with the cache's refreshes, so the ratio
    // stays well under the per-move bound rather than near 1.
    expect(batch).toBeLessThanOrEqual(single * 3);
    expect(single).toBeGreaterThan(FANOUT_DEADLINE_MS); // the single move really did run a full window of posts
  });

  it('a block with many matching unshield legs no longer starves the Osmosis catch-up search due the same tick', { timeout: 120_000 }, async () => {
    const db = testD1();
    await seedUsers(db);
    const K = 8;
    const eventsAt = new Map<number, any[]>([[H, [unshieldEvent('R2'.repeat(32), K, 'c')]]]);
    await db.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('namada.cursor', ?, 0)").bind(String(H - 1)).run();
    await db.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('osmosis.cursor', ?, 0)").bind(JSON.stringify({ height: 1_000_000, at: 0 })).run();
    const { hub, log } = newHub(db, eventsAt);
    await vi.advanceTimersByTimeAsync(0);
    const { ms } = await settle(hub.alarm());
    const osmoStarted = log.filter((u) => u.includes('osmosis-rpc.publicnode.com') && u.endsWith('/status')).length;
    expect(ms).toBeLessThanOrEqual(ALARM_DEADLINE_MS); // the whole alarm fits its own deadline
    expect(osmoStarted).toBeGreaterThan(0); // the due catch-up search ran
    expect(JSON.parse(kv(db, 'osmosis.cursor')).height).toBe(OSMO_HEAD); // and finished
    expect(Number(kv(db, 'namada.cursor'))).toBeGreaterThanOrEqual(H); // the scan wrote its cursor
    expect(kv(db, 'namada.scan')).toBeNull(); // no block recorded as not scanned
  });

  it('the operator channel is served first and is not dropped when the shared window, or the alarm\'s deadline, is already spent', { timeout: 60_000 }, async () => {
    const db = testD1();
    await seedUsers(db);
    const { discord } = newHub(db, new Map());
    await vi.advanceTimersByTimeAsync(0);
    configureAlerts(KEY);
    const operator = 'https://discord.com/api/webhooks/9/op';
    const whale = (id: string): Flow => ({ id: `namada:${id}:0`, chain: 'namada', height: H, ts: Date.now(), txHash: id, kind: 'unshield', from: MASP, to: `tnam1qopw${'z'.repeat(34)}`, amount: 60000 } as Flow);
    // A stream message's window opened in the past: every subscriber post is already past it.
    const window = fanoutBudget();
    window.opened = Date.now() - windowFor(N) - 1000;
    await settle(sendDiscordWhaleAlert(operator, whale('OP1'), db as any, 10000, window));
    await flushAlerts(db as any, window);
    expect(discord.filter((u) => u === operator)).toHaveLength(1); // operator heard, window spent or not
    expect(discord.filter((u) => u.includes('/api/webhooks/1'))).toHaveLength(0); // every subscriber post skipped
    expect(skipped(db).total).toBe(N); // and recorded for the health view
    // An alarm whose deadline has passed: the same.
    const late = alarmBudget(Date.now() - 1);
    await settle(sendDiscordWhaleAlert(operator, whale('OP2'), db as any, 10000, late));
    await flushAlerts(db as any, late);
    expect(discord.filter((u) => u === operator)).toHaveLength(2);
    expect(discord.filter((u) => u.includes('/api/webhooks/1'))).toHaveLength(0);
    expect(skipped(db).total).toBe(2 * N);
  });
});
