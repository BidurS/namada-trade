// worker/cron-hung-rpc-no-deadline: a Namada node that accepts requests and never answers must cost one status read,
// not 46 s per address. The real runCron against the sqlite D1 stand-in and a stubbed network.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { runCron, batchHealthOk, TICK_DEADLINE_MS, STAKE_PER_TICK } from '../worker/src/cron';
import { RpcBreaker, delegationsAt, QUICK } from '../worker/src/sources/namada';
import { testD1, insert } from './d1-sqlite';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const u256 = (n: bigint) => { const b = new Uint8Array(32); let v = n; for (let i = 0; i < 32; i++) { b[i] = Number(v & 0xffn); v >>= 8n; } return btoa(String.fromCharCode(...b)); };
const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });

/** How the stubbed network behaves: `hung` requests are accepted and never answered (only the caller's abort ends them). */
interface Net { hung: (url: string) => boolean; slowMs?: (url: string) => number; answer?: (url: string) => Response | undefined }

function network(net: Net | ((url: string) => boolean)) {
  const n: Net = typeof net === 'function' ? { hung: net } : net;
  const calls: string[] = [];
  const f = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (n.hung(url)) {
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    }
    let res: Response;
    const custom = n.answer?.(url);
    if (custom) res = custom;
    else if (url.includes('/status')) res = json({ result: { sync_info: { latest_block_height: '8316540', latest_block_time: new Date().toISOString(), catching_up: false, earliest_block_height: '1' } } });
    else if (url.includes('abci_query')) {
      const path = decodeURIComponent(url.split('path=')[1] ?? '');
      // An address without a self-bond gets code 1 ("Cannot find bond"), as the real nodes answer.
      if (path.includes('/vp/pos/bond/')) res = json({ result: { response: { code: 1, info: 'RPC error: Cannot find bond', value: null, height: '1' } } });
      else {
        const value = path.includes('/shell/epoch') ? btoa(String.fromCharCode(155, 10, 0, 0, 0, 0, 0, 0)) : path.includes('delegations_at') ? null : u256(path.includes('total_stake') ? 267180094223579n : 1000000n);
        res = json({ result: { response: { code: 0, value, height: '8316540' } } });
      }
    } else if (url.includes('denom_owners')) {
      res = json({ denom_owners: [{ address: 'osmo1aaa', balance: { amount: '3000000' } }, { address: 'osmo1bbb', balance: { amount: '7000000' } }], pagination: { next_key: null, total: '0' } });
    } else if (url.includes('supply/by_denom')) {
      res = json({ amount: { denom: 'x', amount: '10000000' } });
    } else res = new Response('not here', { status: 404 });
    const d = n.slowMs?.(url) ?? 0;
    if (!d) return Promise.resolve(res);
    // A slow answer, which the caller's abort (its timeout, the tick's deadline) also ends, as a real fetch.
    return new Promise<Response>((resolve, reject) => {
      const t = setTimeout(() => resolve(res), d);
      init?.signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); });
    });
  });
  vi.stubGlobal('fetch', f);
  return calls;
}

/** Run a tick under fake timers from `start`; returns how long it took in virtual time. */
async function virtualTick(env: any, start: number) {
  vi.useFakeTimers({ now: start, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  let done = false;
  let err: unknown = null;
  runCron(env).catch((e) => { err = e; }).finally(() => { done = true; });
  for (let i = 0; !done && i < 4000; i++) await vi.advanceTimersByTimeAsync(250);
  const ms = Date.now() - start;
  vi.useRealTimers();
  if (err) throw err;
  expect(done).toBe(true);
  return ms;
}

// 22:41:05 UTC: not a 10-minute holder sync; 22:40:05: one.
const PLAIN = Date.parse('2026-10-17T22:41:05Z');
const SYNC = Date.parse('2026-10-17T22:40:05Z');

function seeded(start: number) {
  const db = testD1();
  insert(db, 'stakes', Array.from({ length: STAKE_PER_TICK }, (_, i) => ({ address: `tnam1qstaker${String(i).padStart(3, '0')}`, estimated_num: 1000 + i, updated_at: start })));
  insert(db, 'holders', Array.from({ length: 50 }, (_, i) => ({ chain: 'namada', address: `tnam1qholder${String(i).padStart(3, '0')}`, balance: '1', balance_num: 1, updated_height: 1, updated_at: start - 86400000, verified_at: start - 86400000 })));
  insert(db, 'holders', [{ chain: 'osmosis', address: 'osmo1zzz', balance: '5000000', balance_num: 5, updated_at: start - 600000, verified_at: start - 600000 }]);
  return db;
}
const healthOf = (db: any) => JSON.parse(db.raw.prepare("SELECT value FROM kv WHERE key='source.health'").get().value);
const metricKeys = (db: any) => (db.raw.prepare('SELECT key FROM metrics').all() as { key: string }[]).map((r) => r.key);
const verifiedStakes = (db: any) => db.raw.prepare('SELECT COUNT(*) n FROM stakes WHERE verified_at IS NOT NULL').get().n;
/** Spendable balances the W13 refresh read this tick (holders, and stakers that had no holder row yet). */
const refreshed = (db: any) => db.raw.prepare("SELECT COUNT(*) n FROM holders WHERE chain='namada' AND (address LIKE 'tnam1qholder%' OR address LIKE 'tnam1qstaker%') AND verified_src IS NOT NULL AND updated_height > 1").get().n;
const locked = (db: any) => db.raw.prepare("SELECT COUNT(*) n FROM kv WHERE key='cron.lock'").get().n;

describe('a hung Namada node', () => {
  it('is left out after its status read: the tick finishes, verifies stakes and refreshes balances on the other node', async () => {
    const db = testD1();
    const now = PLAIN; // not a 10-minute window, so the stake list is exactly the 30 seeded
    insert(db, 'stakes', Array.from({ length: 30 }, (_, i) => ({ address: `tnam1qstaker${i}`, estimated_num: 1000 + i, updated_at: now })));
    insert(db, 'holders', Array.from({ length: 10 }, (_, i) => ({ chain: 'namada', address: `tnam1qholder${i}`, balance: '1', balance_num: 1, updated_height: 1, updated_at: now - 86400000, verified_at: now - 86400000 })));
    const calls = network((url) => url.includes('5elementsnodes'));
    const took = await virtualTick({ DB: db, KEPLR_KEY: '' }, now);
    expect(took).toBeLessThan(20000); // one 6 s status timeout, not 15 batches × 2 × 46 s
    expect(calls.filter((u) => u.includes('5elementsnodes') && u.includes('abci_query'))).toHaveLength(0);
    expect(verifiedStakes(db)).toBe(30);
    expect(db.raw.prepare("SELECT value FROM metrics WHERE key='supply.total_stake'").get().value).toBeCloseTo(267180094.223579, 6);
    const health = healthOf(db);
    expect(health['Namada RPC 5ElementsNodes'].ok).toBe(false);
    expect(health['Namada RPC (balance refresh)']).toMatchObject({ ok: true });
    expect(health['Namada RPC (stake verification)'].note).toMatch(/^30 addresses verified/);
    // the lock is released at the end
    expect(locked(db)).toBe(0);
  });

  it('that answers its status and hangs on every query costs one timeout per read in flight, then the other node answers everything', async () => {
    const db = seeded(PLAIN);
    const calls = network((url) => url.includes('5elementsnodes') && url.includes('abci_query'));
    const ms = await virtualTick({ DB: db, KEPLR_KEY: 'k' }, PLAIN);
    expect(ms).toBeLessThan(15000); // one 8 s timeout on the hung node, not 15 s × 3 per read
    // only the seven supply reads asked it; after they failed it was asked last for the rest of the tick
    expect(calls.filter((u) => u.includes('5elementsnodes') && u.includes('abci_query')).length).toBeLessThanOrEqual(7);
    expect(metricKeys(db)).toEqual(expect.arrayContaining(['supply.total', 'supply.total_stake', 'supply.masp_shielded', 'epoch', 'supply.osmosis']));
    expect(verifiedStakes(db)).toBe(STAKE_PER_TICK);
    expect(refreshed(db)).toBe(50);
    const h = healthOf(db);
    expect(h['Namada RPC (stake verification)']).toMatchObject({ ok: true });
    expect(h['Namada RPC (balance refresh)']).toMatchObject({ ok: true });
    // its status answered, but the Sources sheet says its reads did not
    expect(h['Namada RPC 5ElementsNodes'].ok).toBe(false);
    expect(h['Namada RPC 5ElementsNodes'].note).toMatch(/got no answer this tick/);
    expect(h['Namada RPC Papadritta'].ok).toBe(true);
    expect(locked(db)).toBe(0);
  });

  it('that answers every query in 9 s (past the 8 s quick timeout) falls over once and the tick still does everything', async () => {
    const db = seeded(PLAIN);
    network({ hung: () => false, slowMs: (u) => (u.includes('5elementsnodes') && u.includes('abci_query') ? 9000 : 0) });
    const ms = await virtualTick({ DB: db, KEPLR_KEY: 'k' }, PLAIN);
    expect(ms).toBeLessThan(15000);
    expect(verifiedStakes(db)).toBe(STAKE_PER_TICK);
    expect(refreshed(db)).toBe(50);
  });

  it('when every node hangs on queries, the tick ends at its deadline and says what did not run', async () => {
    const db = seeded(PLAIN);
    network((url) => url.includes('abci_query'));
    const ms = await virtualTick({ DB: db, KEPLR_KEY: 'k' }, PLAIN);
    expect(ms).toBeLessThanOrEqual(TICK_DEADLINE_MS + 1000);
    const h = healthOf(db);
    expect(h['Namada RPC (minted supply)'].ok).toBe(false);
    expect(h['Namada RPC (stake verification)']).toMatchObject({ ok: false, note: expect.stringMatching(/epoch could not be read/) });
    expect(h['Namada RPC (balance refresh)'].ok).toBe(false);
    expect(verifiedStakes(db)).toBe(0);
    expect(refreshed(db)).toBe(0);
    // what does not depend on the nodes still landed
    expect(metricKeys(db)).toContain('supply.osmosis');
    expect(locked(db)).toBe(0);
  });

  it('slow stake reads cannot take the balance refresh\'s turn (time is kept for it), and their health is not ok', async () => {
    const db = seeded(PLAIN);
    network((url) => url.includes('abci_query') && decodeURIComponent(url).includes('delegations_at'));
    const ms = await virtualTick({ DB: db, KEPLR_KEY: 'k' }, PLAIN);
    expect(ms).toBeLessThanOrEqual(TICK_DEADLINE_MS + 1000);
    const h = healthOf(db);
    expect(h['Namada RPC (stake verification)'].ok).toBe(false);
    expect(h['Namada RPC (stake verification)'].note).toMatch(/^0 addresses verified this tick, \d+ failed, \d+ left for the next tick/);
    // the refresh ran in the time kept for it
    expect(refreshed(db)).toBe(50);
    expect(h['Namada RPC (balance refresh)']).toMatchObject({ ok: true });
  });

  it('a self-bond read that gets no answer fails the address: its delegations alone are never written as its stake', async () => {
    const db = seeded(PLAIN);
    network((url) => url.includes('abci_query') && decodeURIComponent(url).includes('/vp/pos/bond/'));
    await virtualTick({ DB: db, KEPLR_KEY: 'k' }, PLAIN);
    expect(verifiedStakes(db)).toBe(0);
    expect(healthOf(db)['Namada RPC (stake verification)'].ok).toBe(false);
  });
});

describe('a hung Keplr', () => {
  it('costs its own timeout beside the Namada reads, never the Namada reads themselves', async () => {
    const db = seeded(PLAIN);
    network((url) => url.includes('api.keplr.app'));
    const ms = await virtualTick({ DB: db, KEPLR_KEY: 'k' }, PLAIN);
    expect(ms).toBeLessThan(25000); // 10 s × 2 attempts on the supply read, run beside everything else
    expect(metricKeys(db)).toEqual(expect.arrayContaining(['supply.total', 'supply.total_stake', 'epoch']));
    expect(metricKeys(db)).not.toContain('supply.osmosis');
    expect(verifiedStakes(db)).toBe(STAKE_PER_TICK);
    expect(refreshed(db)).toBe(50);
    expect(healthOf(db)['Keplr Osmosis REST (supply)'].ok).toBe(false);
  });

  it('at a 10-minute holder sync: the list fails, nobody on Osmosis is zeroed, and Namada is unaffected', async () => {
    const db = seeded(SYNC);
    network((url) => url.includes('api.keplr.app'));
    const ms = await virtualTick({ DB: db, KEPLR_KEY: 'k' }, SYNC);
    expect(ms).toBeLessThan(25000);
    expect(verifiedStakes(db)).toBe(STAKE_PER_TICK);
    expect(refreshed(db)).toBe(50);
    expect(healthOf(db)['Keplr Osmosis REST (holders)'].ok).toBe(false);
    expect(db.raw.prepare("SELECT balance_num FROM holders WHERE chain='osmosis' AND address='osmo1zzz'").get().balance_num).toBe(5);
  });

  it('a holder list that answers slowly page after page is cut at the deadline and never trusted', async () => {
    const db = seeded(SYNC);
    // every page answers after 9 s and says there is another page
    network({
      hung: () => false,
      slowMs: (u) => (u.includes('denom_owners') ? 9000 : 0),
      answer: (u) => (u.includes('denom_owners') ? json({ denom_owners: [{ address: 'osmo1aaa', balance: { amount: '1' } }], pagination: { next_key: 'more' } }) : undefined),
    });
    const ms = await virtualTick({ DB: db, KEPLR_KEY: 'k' }, SYNC);
    expect(ms).toBeLessThanOrEqual(TICK_DEADLINE_MS + 1000);
    expect(healthOf(db)['Keplr Osmosis REST (holders)'].ok).toBe(false);
    expect(db.raw.prepare("SELECT balance_num FROM holders WHERE chain='osmosis' AND address='osmo1zzz'").get().balance_num).toBe(5);
    // the Namada phases did not wait for it
    expect(verifiedStakes(db)).toBe(STAKE_PER_TICK);
    expect(refreshed(db)).toBe(50);
  });
});

describe('a hung indexer', () => {
  it('runs beside the other reads and does not hold up the tick', async () => {
    const db = seeded(PLAIN);
    network((url) => url.includes('indexer.namada.net'));
    const ms = await virtualTick({ DB: db, KEPLR_KEY: 'k' }, PLAIN);
    expect(ms).toBeLessThanOrEqual(TICK_DEADLINE_MS + 1000);
    expect(verifiedStakes(db)).toBe(STAKE_PER_TICK);
    expect(refreshed(db)).toBe(50);
    expect(healthOf(db)['Namada indexer (indexer.namada.net)'].ok).toBe(false);
  });
});

describe('batch health', () => {
  it('is ok only when something was written (or nothing was due) and fewer than half the reads failed', () => {
    expect(batchHealthOk(0, 0, 0, 0)).toBe(true); // nothing due
    expect(batchHealthOk(120, 120, 120, 0)).toBe(true);
    expect(batchHealthOk(120, 0, 0, 0)).toBe(false); // the time limit left every address
    expect(batchHealthOk(50, 0, 16, 16)).toBe(false); // every read failed
    expect(batchHealthOk(50, 0, 50, 0)).toBe(false); // every answer was refused (older than a recorded transfer)
    expect(batchHealthOk(50, 40, 50, 10)).toBe(true);
    expect(batchHealthOk(50, 20, 50, 30)).toBe(false);
  });
});

describe('the per-tick node breaker', () => {
  it('asks a node that failed last, and an error code is an answer, not a failure', async () => {
    const b = new RpcBreaker();
    const rpcs = [{ provider: 'A', url: 'https://a.example' }, { provider: 'B', url: 'https://b.example' }];
    expect(b.order(rpcs).map((r) => r.provider)).toEqual(['A', 'B']);
    b.failed('A');
    expect(b.order(rpcs).map((r) => r.provider)).toEqual(['B', 'A']);
    // a node that answers "Cannot find bond" (code 1) is not counted as failing
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url.split('/abci_query')[0]);
      const path = decodeURIComponent(url.split('path=')[1] ?? '');
      return json({ result: { response: path.includes('/vp/pos/bond/') ? { code: 1, info: 'RPC error: Cannot find bond', value: null, height: '1' } : { code: 0, value: null, height: '9' } } });
    }));
    const d = await delegationsAt('tnam1qxyz', 2675, { ...QUICK, rpcs, breaker: b });
    expect(d.bondedNam).toBe(0);
    expect(d.provider).toBe('B');
    expect(seen).toEqual(['https://b.example', 'https://b.example']);
    expect(b.failures('B')).toBe(0);
  });
});
