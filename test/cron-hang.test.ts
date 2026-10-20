// worker/cron-hung-rpc-no-deadline: a Namada node that accepts requests and never answers must cost one status read,
// not 46 s per address. The real runCron against the sqlite D1 stand-in and a stubbed network, the chain listings
// answered from the fixtures cut from real answers (test/fixtures/balance_listing.json, bonds_listing.json).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { runCron, batchHealthOk, TICK_DEADLINE_MS, LISTING_RESERVE_MS, type BalanceListingRecord, type BondListingRecord } from '../worker/src/cron';
import { RpcBreaker, delegationsAt, QUICK } from '../worker/src/sources/namada';
import { BALANCE_LISTING_SRC, BOND_LISTING_SRC } from '../worker/src/holders';
import { testD1, insert } from './d1-sqlite';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));
const BAL = fx('balance_listing.json');
const BONDS = fx('bonds_listing.json');
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
    else if (url.includes('/status')) res = json({ result: { sync_info: { latest_block_height: '8343400', latest_block_time: new Date().toISOString(), catching_up: false, earliest_block_height: '1' } } });
    else if (url.includes('abci_query')) {
      const path = decodeURIComponent(url.split('path=')[1] ?? '');
      // An address without a self-bond gets code 1 ("Cannot find bond"), as the real nodes answer.
      if (path.includes('/vp/pos/bond/')) res = json({ result: { response: { code: 1, info: 'RPC error: Cannot find bond', value: null, height: '1' } } });
      else {
        const value = path.includes('/shell/epoch') ? btoa(String.fromCharCode(155, 10, 0, 0, 0, 0, 0, 0))
          : path.includes('/shell/prefix/') ? BAL.value
          : path.includes('/vp/pos/bonds_and_unbonds/to') ? BONDS.value
          : path.includes('delegations_at') ? null
          : u256(path.includes('total_stake') ? 75501646677000n : 1000000n); // 0.3% under the fixture's bond sum
        res = json({ result: { response: { code: 0, value, height: '8343400' } } });
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

/** Fifty stale Namada rows the listing does not have (to be zeroed) and one Osmosis holder. */
function seeded(start: number) {
  const db = testD1();
  insert(db, 'holders', Array.from({ length: 50 }, (_, i) => ({ chain: 'namada', address: `tnam1qholder${String(i).padStart(3, '0')}`, balance: '1', balance_num: 0.000001, updated_height: 1, updated_at: start - 86400000, verified_at: start - 86400000, verified_src: BALANCE_LISTING_SRC })));
  insert(db, 'holders', [{ chain: 'osmosis', address: 'osmo1zzz', balance: '5000000', balance_num: 5, updated_at: start - 600000, verified_at: start - 600000 }]);
  return db;
}
const healthOf = (db: any) => JSON.parse(db.raw.prepare("SELECT value FROM kv WHERE key='source.health'").get().value);
const metricKeys = (db: any) => (db.raw.prepare('SELECT key FROM metrics').all() as { key: string }[]).map((r) => r.key);
const listedStakes = (db: any) => db.raw.prepare('SELECT COUNT(*) n FROM stakes WHERE verified_src = ? AND bonded_num > 0').get(BOND_LISTING_SRC).n;
const listedHolders = (db: any) => db.raw.prepare("SELECT COUNT(*) n FROM holders WHERE chain='namada' AND verified_src = ? AND balance_num > 0 AND updated_height > 1").get(BALANCE_LISTING_SRC).n;
const locked = (db: any) => db.raw.prepare("SELECT COUNT(*) n FROM kv WHERE key='cron.lock'").get().n;
const record = <T,>(db: any, key: string): T | null => { const r = db.raw.prepare('SELECT value FROM kv WHERE key = ?').get(key); return r ? JSON.parse(r.value) : null; };

describe('a tick with both listings due', () => {
  it('reads the bond listing first (never both in one tick), the balance listing the tick after; the coverage check passes', async () => {
    const db = seeded(PLAIN);
    network(() => false);
    const t1 = await virtualTick({ DB: db, KEPLR_KEY: 'k' }, PLAIN);
    expect(t1).toBeLessThan(5000);
    expect(listedStakes(db)).toBe(13);
    expect(listedHolders(db)).toBe(0);
    let h = healthOf(db);
    expect(h['Namada RPC (bond listing)']).toMatchObject({ ok: true });
    expect(h['Namada RPC (bond listing)'].note).toMatch(/^48 bond entries at height 8,343,400 .*13 addresses stake 75,728,153 NAM.*13 rows written$/);
    expect(h['Namada RPC (stake sample)']).toMatchObject({ ok: true });
    expect(h['Namada RPC (balance listing)']).toBeUndefined();
    const check = db.raw.prepare("SELECT status, detail FROM checks WHERE key='bonded_coverage'").get();
    expect(check.status).toBe('ok');
    expect(JSON.parse(check.detail)).toMatchObject({ coveragePct: '100.3%', stakers: 13, knownAddresses: 15, pendingAddresses: 0 });
    expect(record<BondListingRecord>(db, 'bond.listing')).toMatchObject({ completeAt: PLAIN, remaining: 0, written: 13 });

    const t2 = await virtualTick({ DB: db, KEPLR_KEY: 'k' }, PLAIN + 60000);
    expect(t2).toBeLessThan(5000);
    expect(listedHolders(db)).toBe(18);
    expect(db.raw.prepare("SELECT COUNT(*) n FROM holders WHERE address LIKE 'tnam1qholder%' AND balance_num = 0").get().n).toBe(50);
    expect(record<BalanceListingRecord>(db, 'balance.listing')).toMatchObject({ completeAt: PLAIN + 60000, written: 18, zeroed: 50, remaining: 0 });
    h = healthOf(db);
    expect(h['Namada RPC (balance listing)']).toMatchObject({ ok: true });
    expect(h['Namada RPC (balance listing)'].note).toMatch(/^28 balance keys at height 8,343,400 .*18 addresses hold 324,665 NAM; 18 rows written, 50 zeroed$/);
    expect(db.raw.prepare('SELECT COUNT(*) n FROM balance_spans').get().n).toBe(68);
    // the third tick finds both listings current: nothing is read again
    const calls = network(() => false);
    await virtualTick({ DB: db, KEPLR_KEY: 'k' }, PLAIN + 120000);
    expect(calls.filter((u) => decodeURIComponent(u).includes('/shell/prefix/') || decodeURIComponent(u).includes('bonds_and_unbonds/to'))).toHaveLength(0);
    expect(locked(db)).toBe(0);
  });
});

describe('a hung Namada node', () => {
  it('is left out after its status read: the tick finishes, lists the bonds and samples stakes on the other node', async () => {
    const db = seeded(PLAIN);
    const calls = network((url) => url.includes('5elementsnodes'));
    const took = await virtualTick({ DB: db, KEPLR_KEY: '' }, PLAIN);
    expect(took).toBeLessThan(20000); // one 6 s status timeout, not minutes
    expect(calls.filter((u) => u.includes('5elementsnodes') && u.includes('abci_query'))).toHaveLength(0);
    expect(listedStakes(db)).toBe(13);
    expect(db.raw.prepare("SELECT value FROM metrics WHERE key='supply.total_stake'").get().value).toBeCloseTo(75501646.677, 3);
    const health = healthOf(db);
    expect(health['Namada RPC 5ElementsNodes'].ok).toBe(false);
    expect(health['Namada RPC (bond listing)']).toMatchObject({ ok: true });
    // the stub answers delegations_at with nothing, so every sampled stake "differs": reported, never written to a row
    expect(health['Namada RPC (stake sample)'].note).toMatch(/^0 of 13 sampled stakes match the bond listing to the base unit, 13 differ/);
    expect(db.raw.prepare('SELECT COUNT(*) n FROM stakes WHERE verified_src = ? AND bonded_num > 0').get(BOND_LISTING_SRC).n).toBe(13);
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
    expect(listedStakes(db)).toBe(13);
    const h = healthOf(db);
    expect(h['Namada RPC (bond listing)']).toMatchObject({ ok: true });
    expect(h['Namada RPC (stake sample)']).toMatchObject({ ok: true });
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
    expect(listedStakes(db)).toBe(13);
    expect(healthOf(db)['Namada RPC (bond listing)']).toMatchObject({ ok: true });
  });

  it('when every node hangs on queries, the tick ends at its deadline and says what did not run', async () => {
    const db = seeded(PLAIN);
    network((url) => url.includes('abci_query'));
    const ms = await virtualTick({ DB: db, KEPLR_KEY: 'k' }, PLAIN);
    expect(ms).toBeLessThanOrEqual(TICK_DEADLINE_MS + 1000);
    const h = healthOf(db);
    expect(h['Namada RPC (minted supply)'].ok).toBe(false);
    // the bond listing (due first) was read for nothing: without the epoch its rows cannot be stamped
    expect(h['Namada RPC (bond listing)']).toMatchObject({ ok: false, note: expect.stringMatching(/epoch could not be read/) });
    expect(h['Namada RPC (stake sample)']).toMatchObject({ ok: false, note: expect.stringMatching(/epoch could not be read/) });
    expect(h['Namada RPC (balance listing)']).toBeUndefined();
    expect(listedStakes(db)).toBe(0);
    expect(listedHolders(db)).toBe(0);
    expect(record(db, 'balance.listing')).toBeNull();
    // what does not depend on the nodes still landed
    expect(metricKeys(db)).toContain('supply.osmosis');
    expect(locked(db)).toBe(0);
  });

  it('slow sample reads cannot take the balance listing\'s turn (time is kept for it), and their health is not ok', async () => {
    const db = seeded(PLAIN);
    network((url) => url.includes('abci_query') && decodeURIComponent(url).includes('delegations_at'));
    const t1 = await virtualTick({ DB: db, KEPLR_KEY: 'k' }, PLAIN);
    expect(t1).toBeLessThanOrEqual(TICK_DEADLINE_MS + 1000);
    let h = healthOf(db);
    expect(listedStakes(db)).toBe(13); // the bond listing ran before the sample
    expect(h['Namada RPC (stake sample)'].ok).toBe(false);
    expect(h['Namada RPC (stake sample)'].note).toMatch(/^0 of 0 sampled stakes match.*reads failed.*left for the next tick \(time limit\)/);
    // next tick: the sample is cut LISTING_RESERVE_MS before the deadline and the balance listing runs in the time kept
    const t2 = await virtualTick({ DB: db, KEPLR_KEY: 'k' }, PLAIN + 60000);
    expect(t2).toBeLessThanOrEqual(TICK_DEADLINE_MS + 1000);
    expect(t2).toBeGreaterThanOrEqual(TICK_DEADLINE_MS - LISTING_RESERVE_MS);
    expect(listedHolders(db)).toBe(18);
    h = healthOf(db);
    expect(h['Namada RPC (balance listing)']).toMatchObject({ ok: true });
  });

  it('a self-bond read that gets no answer fails the sampled address, and the listing\'s rows stay as they are', async () => {
    const db = seeded(PLAIN);
    network((url) => url.includes('abci_query') && decodeURIComponent(url).includes('/vp/pos/bond/'));
    await virtualTick({ DB: db, KEPLR_KEY: 'k' }, PLAIN);
    expect(listedStakes(db)).toBe(13);
    expect(healthOf(db)['Namada RPC (stake sample)'].ok).toBe(false);
    expect(db.raw.prepare('SELECT COUNT(*) n FROM stakes WHERE verified_src != ?').get(BOND_LISTING_SRC).n).toBe(0);
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
    expect(listedStakes(db)).toBe(13);
    expect(healthOf(db)['Keplr Osmosis REST (supply)'].ok).toBe(false);
  });

  it('at a 10-minute holder sync: the list fails, nobody on Osmosis is zeroed, and Namada is unaffected', async () => {
    const db = seeded(SYNC);
    network((url) => url.includes('api.keplr.app'));
    const ms = await virtualTick({ DB: db, KEPLR_KEY: 'k' }, SYNC);
    expect(ms).toBeLessThan(25000);
    expect(listedStakes(db)).toBe(13);
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
    expect(listedStakes(db)).toBe(13);
  });
});

describe('a hung indexer', () => {
  it('runs beside the other reads and does not hold up the tick', async () => {
    const db = seeded(PLAIN);
    network((url) => url.includes('indexer.namada.net'));
    const ms = await virtualTick({ DB: db, KEPLR_KEY: 'k' }, PLAIN);
    expect(ms).toBeLessThanOrEqual(TICK_DEADLINE_MS + 1000);
    expect(listedStakes(db)).toBe(13);
    expect(healthOf(db)['Namada indexer (indexer.namada.net)'].ok).toBe(false);
  });
});

describe('batch health', () => {
  it('is ok only when something was read (or nothing was due) and fewer than half the reads failed', () => {
    expect(batchHealthOk(0, 0, 0, 0)).toBe(true); // nothing due
    expect(batchHealthOk(120, 120, 120, 0)).toBe(true);
    expect(batchHealthOk(120, 0, 0, 0)).toBe(false); // the time limit left every address
    expect(batchHealthOk(50, 0, 16, 16)).toBe(false); // every read failed
    expect(batchHealthOk(50, 0, 50, 0)).toBe(false); // every answer was refused
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
