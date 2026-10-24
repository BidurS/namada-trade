// Security review (2026-10-22), one channel's share of the alerts' pending list: the list holds at most
// PENDING_POSTS_MAX subscriber posts across its parts, and past it a part is recorded as not sent instead of kept, so
// hooks whose posts keep waiting without ever being held (a 429 of shared scope is neither counted nor invalid; their
// parts are let go only at the 24 h age limit) could fill it within hours, and from then on an honest post that any
// budget cut deferred was lost. Each channel now has a share of the list (PENDING_CHANNEL_MAX posts): past it, that
// channel's post of a part is recorded as not sent and the rest of the part is kept, so the other channels' posts are
// untouched; a channel's posts that are sent or let go give its share back. Fetch is stubbed: nothing reaches Discord.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { base64 } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { testD1 } from './d1-sqlite';
import { saveSettings, defaultPrefs, hookOkStmt, type StoredSettings } from '../worker/src/settings';
import { alarmBudget, configureAlerts, flushAlerts, INVALID_WINDOW_MS, type PendingAlert } from '../worker/src/sources/discord';
import { memStorage } from './do-storage';
import type { Flow } from '../shared/types';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import { LiveHub, PENDING_CHANNEL_MAX, PENDING_POSTS_MAX, PENDING_PREFIX, LATE_ALERT_MAX_AGE_MS } from '../worker/src/live-hub';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });

const KEY = base64.encode(new Uint8Array(32).fill(63));
const MASP = 'tnam1pcqnhjdcg9tqf2txl2em2pxm7sexlnr7ds7wfr72';
const channelKey = (url: string) => bytesToHex(sha256(new TextEncoder().encode(url))).slice(0, 32);
let seq = 0;
const smallSell = (): Flow => { const n = ++seq; return { id: `osmosis:CS${n}:0`, chain: 'osmosis', height: n, ts: Date.now(), txHash: `CS${n}`, kind: 'sell', from: `osmo1seller${String(n).padStart(6, '0')}${'x'.repeat(25)}`, to: null, amount: 500, meta: null } as unknown as Flow; };
/** A 60,000 NAM unshield: a match for the default unshield rule and for a rule at 1 NAM. */
const unshield = (): Flow => { const n = ++seq; return { id: `namada:CU${n}:0`, chain: 'namada', height: n, ts: Date.now(), txHash: `CU${n}`, kind: 'unshield', from: MASP, to: `tnam1qreceiver${String(n).padStart(4, '0')}${'z'.repeat(26)}`, amount: 60_000, meta: null } as unknown as Flow; };
const sharedLimited = () => new Response(JSON.stringify({ message: 'You are being rate limited.', retry_after: 20, global: false }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '20', 'x-ratelimit-scope': 'shared' } });
const ok = () => new Response(null, { status: 204 });
const hubOf = (db: unknown, storage: ReturnType<typeof memStorage>): any =>
  Object.assign(Object.create(LiveHub.prototype), { env: { DB: db }, ctx: { storage }, pendingN: null, pendingPosts: null, pendingNoted: null, pendingSeq: 0 });
const kvJson = (db: ReturnType<typeof testD1>, key: string) => {
  const r = db.raw.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return r ? JSON.parse(r.value) : null;
};
const partsOf = async (storage: ReturnType<typeof memStorage>) => [...(await storage.list<PendingAlert>({ prefix: PENDING_PREFIX })).values()];
async function provenRow(db: ReturnType<typeof testD1>, address: string, url: string, T: number, prefs = defaultPrefs()) {
  const s: StoredSettings = { address, notifications: prefs, channels: { discord: { enabled: true, webhookUrl: url } }, createdAt: T - 3 * 86_400_000, updatedAt: T - 3 * 86_400_000 };
  expect(await saveSettings(db as any, KEY, s)).toBe(true);
  await hookOkStmt(db as any, KEY, s.address, url, T - 2 * 86_400_000).run();
}
/** One alarm six seconds after the last; `cut`: the alarm's deadline has passed, so every subscriber part waits whole. */
async function alarm(hub: any, db: ReturnType<typeof testD1>, flows: Flow[], cut = false) {
  vi.setSystemTime(Date.now() + 6_000);
  const b = alarmBudget(cut ? Date.now() - 1 : Date.now() + 142_000, true);
  await hub.sendPending(b);
  if (flows.length) await hub.alertFlows(flows, 10000, 10, b);
  await flushAlerts(db as any, b);
}

describe('Security review (2026-10-22), one channel\'s share of the alerts\' pending list', () => {
  it('a channel at its share beside three honest channels: its post of each new part is recorded as not sent, the honest channels\' kept posts are all delivered, and the share comes back once its parts are let go', { timeout: 300_000 }, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Math.floor(Date.UTC(2026, 9, 24, 6) / INVALID_WINDOW_MS) * INVALID_WINDOW_MS + 5_000);
    const db = testD1();
    configureAlerts(KEY, true);
    const T = Date.now();
    const FULL = 'https://discord.com/api/webhooks/9800/sharefull';
    const every = defaultPrefs();
    for (const r of Object.values(every.rules)) { r.on = true; r.thresholdNam = 1; }
    await provenRow(db, `tnam1qsharefull${'q'.repeat(31)}`, FULL, T, every);
    const honest = [0, 1, 2].map((i) => `https://discord.com/api/webhooks/${9801 + i}/sharehonest${i}`);
    for (const [i, url] of honest.entries()) await provenRow(db, `tnam1qsharehonest${i}${'q'.repeat(28)}`, url, T);
    const took = new Map<string, number>();
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      const url = String(u);
      if (url === FULL) return sharedLimited();
      took.set(url, (took.get(url) ?? 0) + 1);
      return ok();
    }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The full channel's share is taken: PENDING_CHANNEL_MAX parts of one post each, kept for it alone.
    const storage = memStorage();
    for (let i = 0; i < PENDING_CHANNEL_MAX; i++) {
      const at = Date.now() - PENDING_CHANNEL_MAX + i;
      await storage.put(`${PENDING_PREFIX}${String(at).padStart(14, '0')}:${String(i % 10_000).padStart(4, '0')}`, { flow: smallSell(), at, n: 1, claims: 'all', only: [channelKey(FULL)] } satisfies PendingAlert);
    }
    const hub = hubOf(db, storage);
    // An alarm past its deadline: three unshields' subscriber parts wait whole, each for all four channels.
    const moves = [unshield(), unshield(), unshield()];
    await alarm(hub, db, moves, true);
    const kept = (await partsOf(storage)).filter((p) => p.flow.kind === 'unshield');
    expect(kept, 'every honest part is kept').toHaveLength(3);
    for (const p of kept) {
      expect(p.only!.sort(), 'the honest channels, not the full one').toEqual(honest.map(channelKey).sort());
      expect(p.n).toBe(3);
    }
    const skipped = kvJson(db, 'alerts.skipped');
    expect(skipped.total, 'the full channel\'s post of each part is recorded as not sent').toBe(3);
    expect(skipped.last.what).toContain('past its share of the pending list');
    expect(hub.pendingPosts).toBe(PENDING_CHANNEL_MAX + 9);
    // The next alarms: every honest channel hears every unshield (marked found late), the full channel's parts stay.
    for (let a = 0; a < 3; a++) await alarm(hub, db, []);
    for (const url of honest) expect(took.get(url), `every unshield reached ${url.slice(-12)}`).toBe(moves.length);
    expect((await partsOf(storage)).filter((p) => p.flow.kind === 'unshield')).toHaveLength(0);
    expect(hub.pendingPosts).toBe(PENDING_CHANNEL_MAX);
    expect(kvJson(db, 'alerts.skipped').total, 'nothing else recorded').toBe(3);
    // A day on, the full channel's parts are let go at the age limit, and its share is free again.
    vi.setSystemTime(Date.now() + LATE_ALERT_MAX_AGE_MS);
    await alarm(hub, db, []);
    expect(await partsOf(storage)).toHaveLength(0);
    const next = unshield();
    await alarm(hub, db, [next], true);
    const again = await partsOf(storage);
    expect(again).toHaveLength(1);
    expect(again[0].only).toContain(channelKey(FULL));
    expect(again[0].n).toBe(4);
    expect(PENDING_CHANNEL_MAX).toBe(2_000);
    expect(PENDING_CHANNEL_MAX * 25).toBe(PENDING_POSTS_MAX);
  });
});
