// Security review (2026-10-22), late scan alerts and the alarm's deadline: a Namada scan that is behind reads blocks
// until the alarm's deadline (ALARM_DEADLINE_MS) and sent its alerts only after its reads. Its alerts share the
// alarm's budget, whose deadline is ALARM_DEADLINE_MS less WEBHOOK_TIMEOUT_MS, so every subscriber post of such an
// alarm started after the deadline and was cut, while the operator was posted, the move claimed and the cursor
// already past the block: the move never reached a subscriber. Each block's moves are now alerted right after its
// rows are written, as the catch-up search's are, so the alerts go out throughout the alarm, and a subscriber post
// the deadline or the count would cut waits for the next alarm instead (live-hub.ts PendingAlert). Fetch is stubbed:
// nothing reaches Discord.
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class { ctx: any; env: any; constructor(ctx: any, env: any) { this.ctx = ctx; this.env = env; } },
}));
import { base64 } from '@scure/base';
import { LiveHub, PENDING_PREFIX } from '../worker/src/live-hub';
import { saveSettings, defaultPrefs, type StoredSettings } from '../worker/src/settings';
import { NAM, NAMADA } from '../worker/src/config';
import { testD1, type TestD1 } from './d1-sqlite';
import { memStorage } from './do-storage';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const KEY = base64.encode(new Uint8Array(32).fill(21));
const MASP = NAMADA.internal.masp;
const H = 8_000_000;
const BLOCK_MS = 6826;
const BEHIND = 2000;
const OP = 'https://discord.com/api/webhooks/9/op';
const SUB = 'https://discord.com/api/webhooks/5001/sub';
const later = <T>(ms: number, v: () => T) => new Promise<T>((r) => setTimeout(() => r(v()), ms));
const kv = (db: TestD1, key: string) => (db.raw.prepare('SELECT value FROM kv WHERE key = ?').get(key) as any)?.value ?? null;

const unshield = (hash: string, nam: number) => ({
  type: 'token/transfer',
  attributes: [
    { key: 'token-event-descriptor', value: 'transfer-from-wasm' },
    { key: 'hash', value: hash },
    { key: 'source-accounts', value: JSON.stringify([[[`internal-address/${MASP}`, NAM.namadaToken], String(nam * 1_000_000)]]) },
    { key: 'target-accounts', value: JSON.stringify([[[`internal-address/tnam1qlate0000${'z'.repeat(30)}`, NAM.namadaToken], String(nam * 1_000_000)]]) },
  ],
});

async function settle<T>(p: Promise<T>, capSeconds = 4000) {
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; !done && i < capSeconds * 10; i++) await vi.advanceTimersByTimeAsync(100);
  expect(done, 'settled').toBe(true);
}

/** One alarm of a hub whose scan is BEHIND blocks behind a head both nodes agree on, with `moves` unshields of 60,000 NAM just above the cursor. */
async function run(sweepDue: boolean, extra = 0, moves = 1) {
  const db = testD1();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const T0 = Date.now();
  // One honest subscriber with the default rules (unshield of 50,000 NAM or more), saved three days ago, and `extra`
  // more like it.
  const s: StoredSettings = { address: `tnam1qhonestlate${'q'.repeat(30)}`, notifications: defaultPrefs(), channels: { discord: { enabled: true, webhookUrl: SUB } }, createdAt: T0 - 3 * 86_400_000, updatedAt: T0 - 3 * 86_400_000 };
  expect(await saveSettings(db as any, KEY, s)).not.toBe(false);
  for (let i = 0; i < extra; i++) {
    const x: StoredSettings = { address: `tnam1qhonestmore${String(i).padStart(4, '0')}${'q'.repeat(26)}`, notifications: defaultPrefs(), channels: { discord: { enabled: true, webhookUrl: `https://discord.com/api/webhooks/${6000 + i}/more` } }, createdAt: T0 - 3 * 86_400_000, updatedAt: T0 - 3 * 86_400_000 };
    expect(await saveSettings(db as any, KEY, x)).not.toBe(false);
  }
  const moveAt = H - BEHIND + 3;
  const eventsAt = new Map<number, any[]>(Array.from({ length: moves }, (_, m) => [moveAt + m, [unshield((extra ? 'LS' + m : 'LA').padEnd(64, 'A'), 60_000)]]));
  await db.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('namada.cursor', ?, 0)").bind(String(H - BEHIND)).run();
  await db.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('osmosis.cursor', ?, 0)").bind(JSON.stringify({ height: 1_000_000, at: 0 })).run();
  const posts: string[] = [];
  vi.stubGlobal('fetch', vi.fn((input: any) => {
    const url = String(input);
    if (url.startsWith('https://discord.com/')) { posts.push(url); return later(300, () => new Response(null, { status: 204 })); }
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
        // An ordinary node: each block's results answer in 100 ms, so 2,000 blocks take longer than one alarm.
        const h = Number(u.searchParams.get('height'));
        const ev = eventsAt.get(h);
        return later(100, () => Response.json({ result: { height: String(h), txs_results: ev ? [{ code: 0, events: ev }] : null } }));
      }
      if (u.pathname === '/block') return Promise.resolve(new Response('no', { status: 503 }));
    }
    if (u.host === 'osmosis-rpc.publicnode.com') {
      if (u.pathname.endsWith('/status')) return Promise.resolve(Response.json({ result: { sync_info: { latest_block_height: '1000000' } } }));
      if (u.pathname.endsWith('/tx_search')) return Promise.resolve(Response.json({ result: { txs: [] } }));
      return Promise.resolve(new Response('no', { status: 404 }));
    }
    return Promise.reject(new TypeError(`offline: ${url}`));
  }));
  vi.stubGlobal('WebSocket', class { addEventListener() {} send() {} close() {} });
  const storage = memStorage();
  const ctx: any = { blockConcurrencyWhile: (f: () => Promise<unknown>) => f(), storage };
  const hub = new LiveHub(ctx, { DB: db, SETTINGS_KEY: KEY, SEND_ALERTS: 'yes', DISCORD_WEBHOOK_URL: OP } as any) as any;
  await vi.advanceTimersByTimeAsync(0);
  if (!sweepDue) { hub.needSweep = false; hub.lastSweep = Date.now(); }
  await settle(hub.alarm());
  const cursor = Number(kv(db, 'namada.cursor'));
  const pending = (await storage.list({ prefix: PENDING_PREFIX })).size;
  return { posts, cursor, moveAt, pending, skipped: JSON.parse(kv(db, 'alerts.skipped') ?? 'null'), claims: db.raw.prepare("SELECT COUNT(*) n FROM kv WHERE key LIKE 'alert:flow:%'").get().n as number };
}

describe('Security review (2026-10-22), late scan alerts: a scan behind reads to the alarm deadline and alerts each block as it goes', () => {
  it('an alarm with no catch-up search due: the honest subscriber hears the late move the scan read, in the same alarm', { timeout: 120_000 }, async () => {
    const r = await run(false);
    expect(r.cursor).toBeGreaterThan(r.moveAt); // the scan read past the move, so it is never read again
    expect(r.posts.filter((u) => u === OP)).toHaveLength(1); // the operator heard it
    expect(r.posts.filter((u) => u === SUB)).toHaveLength(1); // and so did the subscriber
    expect(r.claims).toBe(1);
    expect(r.skipped).toBeNull(); // nothing recorded as not sent
    expect(r.pending).toBe(0); // and nothing left waiting
  });
  it('an alarm with a catch-up search due: 100 honest subscribers hear both late moves the scan read', { timeout: 120_000 }, async () => {
    const r = await run(true, 99, 2);
    expect(r.posts.filter((u) => u === OP)).toHaveLength(2);
    expect(r.posts.filter((u) => u !== OP)).toHaveLength(200);
    expect(r.skipped).toBeNull();
    expect(r.pending).toBe(0);
  });
});
