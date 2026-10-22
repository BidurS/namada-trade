// Security review (2026-10-22), request cost: an address start that matches more than FEW_ROWS moves. Its head page is walked in
// time order and never counted on flows_ts (a count there reads every stored move: 56,402 rows for the MASP's start
// on 2026-10-22); only the spelling the app sends is read; an address is a high-cardinality read (REPLAY_LIMITER).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { app } from '../worker/src/api';
import { cachedApi, isReplay, limiterFor } from '../worker/src/http';
import { FEW_ROWS, FLOWS_ORDER } from '../worker/src/flows-query';
import { testD1, insert } from './d1-sqlite';
import type { FlowsResponse } from '../shared/types';

const T = Date.UTC(2026, 9, 22, 12);
const MASP = 'tnam1pcqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzmefah';
const START = MASP.slice(0, 13); // 'tnam1pcqqqqqq'
const B32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const tn = (n: number) => `tnam1q${B32[n % 32]}${B32[Math.floor(n / 32) % 32]}${B32[Math.floor(n / 1024) % 32]}${'q'.repeat(36)}`;

/** 2,100 shields into the MASP (more than FEW_ROWS), 3,000 Osmosis sells by others; every prepared SQL recorded. */
function seeded() {
  const db = testD1();
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < 2100; i++) rows.push({ id: `namada:m${i}:0`, chain: 'namada', height: 9_000_000 + i, ts: T - (5100 - i) * 1000, tx_hash: `M${i}`, kind: 'shield', from_addr: tn(i), to_addr: MASP, amount_num: 1, meta: JSON.stringify({ source: 'test' }) });
  for (let i = 0; i < 3000; i++) rows.push({ id: `osmosis:o${i}:0`, chain: 'osmosis', height: 50_000_000 + i, ts: T - (3000 - i) * 1000, tx_hash: `O${i}`, kind: 'sell', from_addr: 'osmo1from', to_addr: 'osmo1to', amount_num: 1, meta: null });
  insert(db, 'flows', rows);
  const sql: string[] = [];
  const prepare = db.prepare.bind(db);
  (db as any).prepare = (s: string) => { sql.push(s); return prepare(s); };
  return { db, sql };
}
const get = async (db: ReturnType<typeof testD1>, q: string, status = 200) => {
  const res = await app.request(`/api/flows?${q}`, {}, { DB: db } as any);
  expect(res.status, q).toBe(status);
  return (await res.json()) as FlowsResponse & { error?: string };
};
const masp = (db: ReturnType<typeof testD1>, limit: number) =>
  db.raw.prepare(`SELECT f.id FROM flows f WHERE f.to_addr = ? ${FLOWS_ORDER} LIMIT ?`).all(MASP, limit).map((r: any) => r.id);

afterEach(() => vi.unstubAllGlobals());

describe('an address start over FEW_ROWS', () => {
  it('the head page: the newest rows in order, "more than FEW_ROWS", and no count on flows_ts', async () => {
    const { db, sql } = seeded();
    const r = await get(db, `at=${T}&limit=25&addr=${START}`);
    expect(r.flows.map((f) => f.id)).toEqual(masp(db, 25));
    expect(r.total).toBeNull();
    expect(r.totalOver).toBe(FEW_ROWS);
    expect(r.next).not.toBeNull();
    expect(sql.filter((s) => /COUNT\(\*\)/.test(s))).toEqual([]);
    // the next page by its cursor: the same rows the reference order gives
    const p2 = await get(db, `at=${T}&limit=25&addr=${START}&before=${r.next}`);
    expect(p2.flows.map((f) => f.id)).toEqual(masp(db, 50).slice(25));
    // rows only (count=none): no count and no bound
    const rows = await get(db, `at=${T}&limit=25&addr=${START}&count=none`);
    expect(rows.total).toBeNull();
    expect(rows.totalOver).toBeUndefined();
  });

  it('a start of fewer matches, and a whole address, are still counted exactly', async () => {
    const { db } = seeded();
    const few = await get(db, `at=${T}&addr=${tn(5).slice(0, 12)}`);
    expect(few.total).toBe(db.raw.prepare('SELECT COUNT(*) n FROM flows WHERE substr(from_addr, 1, 12) = ?').get(tn(5).slice(0, 12)).n);
    expect(few.totalOver).toBeUndefined();
    const whole = await get(db, `at=${T}&addr=${MASP}`);
    expect(whole.total).toBe(2100);
    expect(whole.totalOver).toBeUndefined();
  });

  it('the export (HEAVY_LIMITER) still counts it', async () => {
    const { db } = seeded();
    const res = await app.request(`/api/export/flows?format=json&at=${T}&addr=${START}`, {}, { DB: db } as any);
    const j = (await res.json()) as { total: number; flows: unknown[] };
    expect(j.total).toBe(2100);
    expect(j.flows).toHaveLength(2100);
  });

  it('only the spelling the app sends: upper case, a space or a "+" is refused', async () => {
    const { db, sql } = seeded();
    for (const a of [START.toUpperCase(), `T${START.slice(1)}`, `+${START}`, `%20${START}`, `${START}%20`, `${START}%09`]) {
      expect((await get(db, `at=${T}&addr=${a}`, 400)).error, a).toMatch(/addr must be .* in lower case/);
    }
    expect(sql).toEqual([]); // refused before any read
  });

  it('an address is a high-cardinality read: REPLAY_LIMITER on a cache miss, not on a hit', async () => {
    for (const a of [START, MASP]) {
      expect(isReplay(new URL(`https://namada.trade/api/flows?addr=${a}`)), a).toBe(true);
      expect(limiterFor(new URL(`https://namada.trade/api/flows?addr=${a}`)), a).toBeNull();
    }
    // the list's other head pages are not
    for (const p of ['/api/flows', '/api/flows?limit=25', '/api/flows?count=none&limit=50', '/api/holders?addr=x']) expect(isReplay(new URL(`https://namada.trade${p}`)), p).toBe(false);
    const store = new Map<string, Response>();
    vi.stubGlobal('caches', { default: { match: async (r: Request) => store.get(r.url)?.clone(), put: async (r: Request, res: Response) => { store.set(r.url, res); } } });
    const ctx = { waitUntil: (p: Promise<unknown>) => p } as any;
    const deny = { limit: vi.fn(async () => ({ success: false })) };
    const fetchApp = vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    const req = new Request(`https://namada.trade/api/flows?addr=${START}`, { headers: { 'cf-connecting-ip': '1.2.3.4' } });
    expect((await cachedApi(req, { REPLAY_LIMITER: deny } as any, ctx, fetchApp)).status).toBe(429);
    expect(deny.limit).toHaveBeenCalledWith({ key: '1.2.3.4:/api/flows' });
    expect(fetchApp).not.toHaveBeenCalled();
    // once stored, the same key is served without the limiter
    await cachedApi(req, {} as any, ctx, fetchApp);
    expect((await cachedApi(req, { REPLAY_LIMITER: deny } as any, ctx, fetchApp)).status).toBe(200);
    expect(deny.limit).toHaveBeenCalledTimes(1);
  });
});
