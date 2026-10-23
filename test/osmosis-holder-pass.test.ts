// Security review (2026-10-22), the Osmosis holder list past one tick: anyone can add owners to the bank's NAM list
// on Osmosis (a base unit sent to a fresh address; 300 owners held exactly one on 2026-10-23), and the list was read
// whole in one tick from the first page, at most 100 pages, inside the 45 s deadline. At the measured pace (14 pages
// in 11,327 ms) about 55 pages fit, so past about 5,500 owners every sync failed: no Osmosis row was refreshed, no
// holder who left was zeroed, and a list that fit in time but not in the cap refreshed only the first 10,000 while the
// count's stamp (the newest row write) called it current. The list is now read a slice a tick from the bank's next
// key (kv osmosis.holders.pass) until the bank says it is complete; only then, and only when the pass adds up to the
// supply, are the holders it did not name zeroed. A new pass waits until the last one's rows, at 1,000 a minute, have
// had their time, so added owners cannot raise how many rows D1 writes on average. The Osmosis count is as of the oldest reading
// it includes, so a holder no pass has re-read for 6 hours makes it old instead of live.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { bech32 } from '@scure/base';
import { runCron, TICK_DEADLINE_MS } from '../worker/src/cron';
import { readHolderFigures, refreshHolderFigures, HOLDER_COUNTS_SQL } from '../worker/src/holders';
import { app, holderFiguresProv } from '../worker/src/api';
import { NAM } from '../worker/src/config';
import { testD1, insert } from './d1-sqlite';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));
const BAL = fx('balance_listing.json');
const BONDS = fx('bonds_listing.json');
const u256 = (n: bigint) => { const b = new Uint8Array(32); let v = n; for (let i = 0; i < 32; i++) { b[i] = Number(v & 0xffn); v >>= 8n; } return btoa(String.fromCharCode(...b)); };
const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
/** A checksummed osmo1 wallet address, one per (page, i). */
const osmo = (page: number, i: number) => bech32.encode('osmo', bech32.toWords(Uint8Array.from({ length: 20 }, (_, k) => (k === 0 ? page : k === 1 ? i : k === 2 ? 0xa5 : (page * 7 + i * 13 + k) & 0xff))));

interface Net { slowMs?: (url: string) => number; answer?: (url: string) => Response | undefined; fail?: (url: string) => boolean }
/** The chain and the bank stubbed as in test/cron-hang.test.ts; `answer` serves the Keplr reads, `fail` makes a request fail. */
function network(n: Net) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (n.fail?.(url)) return Promise.reject(new Error('connection reset'));
    let res: Response;
    const custom = n.answer?.(url);
    if (custom) res = custom;
    else if (url.includes('/status')) res = json({ result: { sync_info: { latest_block_height: '8343400', latest_block_time: new Date().toISOString(), catching_up: false, earliest_block_height: '1' } } });
    else if (url.includes('abci_query')) {
      const path = decodeURIComponent(url.split('path=')[1] ?? '');
      if (path.includes('/vp/pos/bond/')) res = json({ result: { response: { code: 1, info: 'RPC error: Cannot find bond', value: null, height: '1' } } });
      else {
        const value = path.includes('/shell/epoch') ? btoa(String.fromCharCode(155, 10, 0, 0, 0, 0, 0, 0))
          : path.includes('/shell/prefix/') ? BAL.value
          : path.includes('/vp/pos/bonds_and_unbonds/to') ? BONDS.value
          : path.includes('delegations_at') ? null
          : path.includes('balance/minted') ? u256(BigInt(BAL.expected.minted))
          : u256(path.includes('total_stake') ? 75338381473000n : 1000000n);
        res = json({ result: { response: { code: 0, value, height: '8343400' } } });
      }
    } else res = new Response('not here', { status: 404 });
    const d = n.slowMs?.(url) ?? 0;
    if (!d) return Promise.resolve(res);
    return new Promise<Response>((resolve, reject) => {
      const t = setTimeout(() => resolve(res), d);
      init?.signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); });
    });
  }));
  return calls;
}
/** One tick under fake timers from `start`; returns how long it took in virtual time. */
async function virtualTick(env: any, start: number) {
  vi.useFakeTimers({ now: start, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  let done = false;
  let err: unknown = null;
  runCron(env).catch((e) => { err = e; }).finally(() => { done = true; });
  for (let i = 0; !done && i < 8000; i++) await vi.advanceTimersByTimeAsync(250);
  const ms = Date.now() - start;
  vi.useRealTimers();
  if (err) throw err;
  expect(done).toBe(true);
  return ms;
}

// 23:00:05 UTC: a 10-minute holder sync and the first of its hour.
const SYNC = Date.parse('2026-10-17T23:00:05Z');
const MIN = 60_000, H = 3600_000;
/** osmo1zzz held 5 NAM at the last sync; the bank no longer names it. */
function seeded(start: number) {
  const db = testD1();
  insert(db, 'holders', [{ chain: 'osmosis', address: 'osmo1zzz', balance: '5000000', balance_num: 5, updated_at: start - 10 * MIN, verified_at: start - 10 * MIN }]);
  return db;
}
const healthOf = (db: any) => JSON.parse(db.raw.prepare("SELECT value FROM kv WHERE key='source.health'").get().value)['Keplr Osmosis REST (holders)'];
const zzz = (db: any) => db.raw.prepare("SELECT balance_num, verified_at FROM holders WHERE chain='osmosis' AND address='osmo1zzz'").get();
const keplrRows = (db: any) => db.raw.prepare("SELECT COUNT(*) n FROM holders WHERE chain='osmosis' AND verified_src='keplr_rest' AND balance_num > 0").get().n;
const passOf = (db: any) => { const r = db.raw.prepare("SELECT value FROM kv WHERE key='osmosis.holders.pass'").get(); return r ? JSON.parse(r.value) : null; };
const keyOf = (u: string) => { const m = /pagination\.key=k(\d+)/.exec(u); return m ? Number(m[1]) : 0; };
const ownerPages = (calls: string[]) => calls.filter((u) => u.includes('denom_owners'));

/**
 * A bank list of `pages` full pages (page n asked with key k<n>), every owner holding `amount`; the supply is their
 * sum. Asked by address (balances/{address}/by_denom), the bank gives every owner's `amount`.
 */
function bank(pages: number, amount = '1000', supply = String(BigInt(pages * 100) * BigInt(amount))) {
  return (u: string) => {
    if (u.includes('supply/by_denom')) return json({ amount: { denom: 'x', amount: supply } });
    if (/\/cosmos\/bank\/v1beta1\/balances\/[^/?]+\/by_denom\?denom=/.test(u)) return json({ balance: { denom: NAM.osmoDenom, amount } });
    if (!u.includes('denom_owners')) return undefined;
    const p = keyOf(u);
    return json({ denom_owners: Array.from({ length: 100 }, (_, i) => ({ address: osmo(p, i), balance: { amount } })), pagination: { next_key: p + 1 < pages ? `k${p + 1}` : null, total: '0' } });
  };
}

describe('a holder list longer than one tick can read', () => {
  it('160 pages at the measured pace (810 ms a page): read a slice a tick from the next key, never from the first page again; zeroed only when complete', async () => {
    const db = seeded(SYNC);
    const env = { DB: db, KEPLR_KEY: 'k' };
    const calls = network({ answer: bank(160), slowMs: (u) => (u.includes('denom_owners') ? 810 : 0) });
    const slices: number[] = [];
    let t = SYNC;
    for (let tick = 0; tick < 8; tick++, t += MIN) {
      const before = ownerPages(calls).length;
      expect(await virtualTick(env, t)).toBeLessThanOrEqual(TICK_DEADLINE_MS + 1000);
      slices.push(ownerPages(calls).length - before);
      // each tick writes what it read (before, the deadline cut the read and nothing was written)
      expect(keplrRows(db)).toBeGreaterThan(0);
      const pass = passOf(db);
      if (pass?.key == null) break;
      // mid-pass: the slice's rows are written, the one who left is kept, the row says the list goes on
      expect(keplrRows(db)).toBe(pass.holders);
      expect(zzz(db).balance_num).toBe(5);
      expect(healthOf(db)).toMatchObject({ ok: true });
      expect(healthOf(db).note).toMatch(/the next tick goes on from the bank's next key/);
    }
    // the pass needed several ticks; the first page was asked once, every page at least once
    expect(slices.length).toBeGreaterThan(2);
    const asked = ownerPages(calls).map(keyOf);
    expect(asked.filter((k) => k === 0)).toHaveLength(1);
    expect(new Set(asked).size).toBe(160);
    // complete, adding up to the supply: osmo1zzz zeroed, every owner refreshed, the pass closed
    const h = healthOf(db);
    expect(h.ok).toBe(true);
    expect(h.note).toMatch(/^16000 holders, adding up to the supply within 0\.000% \(one pass of 160 pages over \d+ ticks since 23:00 UTC\)$/);
    expect(zzz(db).balance_num).toBe(0);
    expect(keplrRows(db)).toBe(16000);
    expect(passOf(db)).toMatchObject({ key: null, pages: 160, holders: 16000, completeAt: t, trustedAt: t, startedAt: SYNC });
    // the pass began in the hour's first sync: every slice recorded its readings as balance spans (osmo1zzz's zero too)
    expect(db.raw.prepare("SELECT COUNT(DISTINCT address) n FROM balance_spans WHERE chain='osmosis' AND balance_num > 0").get().n).toBe(16000);
    expect(db.raw.prepare("SELECT balance FROM balance_spans WHERE chain='osmosis' AND address='osmo1zzz'").get()).toEqual({ balance: '0' });
    // the figures count the 16,000 and are as of the pass's first slice, not its last
    const f = await readHolderFigures(db as any);
    expect(f!.osmosis).toMatchObject({ holders: 16000, rowsAt: SYNC });
    // every pass rewrites each holder's row (this one its span too), so the next one waits until 32,000 rows / 1,000 a
    // minute = 32 minutes after this one began: not the 23:10, 23:20 or 23:30 sync, the 23:40 one
    const was = ownerPages(calls).length;
    for (const m of [10, 20, 30]) await virtualTick(env, SYNC + m * MIN);
    expect(ownerPages(calls).length).toBe(was);
    await virtualTick(env, SYNC + 40 * MIN);
    expect(keyOf(ownerPages(calls)[was])).toBe(0);
    expect(passOf(db)).toMatchObject({ startedAt: SYNC + 40 * MIN });
  });

  it('a slice that fails keeps its key for the next tick; three in a row drop the pass, and a later sync starts again from the first page', async () => {
    const db = seeded(SYNC);
    const env = { DB: db, KEPLR_KEY: 'k' };
    network({ answer: bank(160) });
    await virtualTick(env, SYNC); // 100 fast pages: the most one tick reads
    expect(passOf(db)).toMatchObject({ key: 'k100', pages: 100, fails: 0 });
    let calls = network({ answer: bank(160), fail: (u) => u.includes('denom_owners') });
    await virtualTick(env, SYNC + MIN);
    expect(passOf(db)).toMatchObject({ key: 'k100', fails: 1 });
    expect(ownerPages(calls).every((u) => keyOf(u) === 100)).toBe(true);
    expect(healthOf(db).ok).toBe(false);
    await virtualTick(env, SYNC + 2 * MIN);
    await virtualTick(env, SYNC + 3 * MIN);
    expect(passOf(db)).toMatchObject({ key: null, fails: 3 });
    expect(healthOf(db).note).toMatch(/the pass is dropped and the next sync starts again from the first page/);
    expect(zzz(db).balance_num).toBe(5);
    // no pass going and not a sync minute: nothing asked
    calls = network({ answer: bank(160) });
    await virtualTick(env, SYNC + 4 * MIN);
    expect(ownerPages(calls)).toHaveLength(0);
    // a new pass starts from the first page, at the first sync after the dropped one's 20,000 rows (10,000 holders and
    // their spans) have had their 20 minutes
    await virtualTick(env, SYNC + 10 * MIN);
    expect(ownerPages(calls)).toHaveLength(0);
    await virtualTick(env, SYNC + 20 * MIN);
    expect(ownerPages(calls).length).toBeGreaterThan(0);
    expect(keyOf(ownerPages(calls)[0])).toBe(0);
    expect(passOf(db)).toMatchObject({ startedAt: SYNC + 20 * MIN, key: 'k100' });
  });

  it('a list that never ends (pages faster than the cap, a next key every time): not ok once the pass is 30 minutes old, and the count old after 6 hours', async () => {
    const db = seeded(SYNC);
    const env = { DB: db, KEPLR_KEY: 'k' };
    const endless = (u: string) => (u.includes('denom_owners')
      ? json({ denom_owners: Array.from({ length: 100 }, (_, i) => ({ address: osmo(keyOf(u) % 250, i), balance: { amount: keyOf(u) === 0 && i < 10 ? '10000000' : '1' } })), pagination: { next_key: `k${keyOf(u) + 1}` } })
      : u.includes('supply/by_denom') ? json({ amount: { denom: 'x', amount: '100000000' } }) : undefined);
    network({ answer: endless });
    await virtualTick(env, SYNC);
    expect(healthOf(db)).toMatchObject({ ok: true });
    await virtualTick(env, SYNC + 31 * MIN);
    expect(healthOf(db).ok).toBe(false);
    expect(healthOf(db).note).toMatch(/not complete after 31 minutes/);
    expect(zzz(db).balance_num).toBe(5);
    const later = SYNC + 7 * H;
    await virtualTick(env, later);
    const f = await readHolderFigures(db as any);
    // the count still includes osmo1zzz, whose reading is 7 h 10 min old: that is what the count is as of
    expect(f!.osmosis!.rowsAt).toBe(SYNC - 10 * MIN);
    expect(holderFiguresProv(f!.osmosis!.top10?.at, f!.osmosis!.rowsAt, later)).toMatchObject({ status: 'stale', at: SYNC - 10 * MIN });
  });

  it('as before: one page with no next key that adds up to the supply is one complete pass; the one who left is zeroed', async () => {
    const db = seeded(SYNC);
    network({ answer: bank(1) });
    await virtualTick({ DB: db, KEPLR_KEY: 'k' }, SYNC);
    expect(healthOf(db)).toMatchObject({ ok: true, note: '100 holders, adding up to the supply within 0.000%' });
    expect(zzz(db).balance_num).toBe(0);
    expect(passOf(db)).toMatchObject({ key: null, ticks: 1, completeAt: SYNC, trustedAt: SYNC });
  });
});

describe('the Osmosis count is as of the oldest reading it includes', () => {
  it('a holder no pass re-read for 7 hours (the list did not add up, so nobody was zeroed) makes the count old, not live', async () => {
    const now = SYNC + 7 * H;
    const db = testD1();
    // ten holders read just now (the top ten), and osmo1zzz's 7 h old reading, still counted
    insert(db, 'holders', Array.from({ length: 10 }, (_, i) => ({ chain: 'osmosis', address: osmo(0, i), balance: '10000000', balance_num: 10, updated_at: now, verified_at: now, verified_src: 'keplr_rest' })));
    insert(db, 'holders', [{ chain: 'osmosis', address: 'osmo1zzz', balance: '5000000', balance_num: 5, updated_at: SYNC - 10 * MIN, verified_at: SYNC - 10 * MIN }]);
    const f = await refreshHolderFigures(db as any, now, { namada: true, osmosis: true });
    expect(f.osmosis).toMatchObject({ holders: 11, rowsAt: SYNC - 10 * MIN, top10: { s: 100, at: now } });
    expect(db.raw.prepare(HOLDER_COUNTS_SQL).get().osmosis_at).toBe(SYNC - 10 * MIN);
    expect(holderFiguresProv(f.osmosis!.top10?.at, f.osmosis!.rowsAt, now).status).toBe('stale');
    // the overview says so
    vi.useFakeTimers({ now, toFake: ['Date'] });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    try {
      const ov: any = await (await app.request('/api/overview', {}, { DB: db } as any)).json();
      expect(ov.concentration.osmosisProv).toMatchObject({ status: 'stale', at: SYNC - 10 * MIN });
    } finally { vi.useRealTimers(); }
  });
});
