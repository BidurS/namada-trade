// Security review (2026-10-22), Osmosis holder passes trusted on the list's own sum: a pass read over several ticks
// was trusted when the list it read added up to the supply, before the slice that completes it read its largest
// earlier readings again by address. Two moves between its slices, one from an address read early to one read late
// and one from a late address to an early one the pass read before it received, cancel in the list's sum: the pass
// was trusted, the re-read then took the early sender's NAM out of the rows, the early receiver was in none, and the
// figures read live while the rows missed the moved NAM, pass after pass. Now the rows themselves are added up after
// the reads by address, and the pass is trusted (its start becomes the figures' stamp, and its row ok) only when they
// still add up to the supply; the zeroing the bank confirmed by address stays as it was.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { bech32 } from '@scure/base';
import { runCron, osmosisRowsCheck } from '../worker/src/cron';
import { readHolderFigures } from '../worker/src/holders';
import { app, holderFiguresProv } from '../worker/src/api';
import { NAM } from '../worker/src/config';
import { testD1 } from './d1-sqlite';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));
const BAL = fx('balance_listing.json');
const BONDS = fx('bonds_listing.json');
const u256 = (n: bigint) => { const b = new Uint8Array(32); let v = n; for (let i = 0; i < 32; i++) { b[i] = Number(v & 0xffn); v >>= 8n; } return btoa(String.fromCharCode(...b)); };
const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
/** A checksummed osmo1 wallet address, one per (page, i). */
const osmo = (page: number, i: number) => bech32.encode('osmo', bech32.toWords(Uint8Array.from({ length: 20 }, (_, k) => (k === 0 ? page : k === 1 ? i : k === 2 ? 0xa5 : (page * 7 + i * 13 + k) & 0xff))));

/** The chain stubbed as in test/osmosis-holder-moves.test.ts; `answer` serves the Keplr reads, `slowMs` delays one. */
function network(answer: (url: string) => Response | undefined, slowMs: (url: string) => number = () => 0) {
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    let res: Response;
    const custom = answer(url);
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
    const d = slowMs(url);
    if (!d) return Promise.resolve(res);
    return new Promise<Response>((resolve, reject) => {
      const t = setTimeout(() => resolve(res), d);
      init?.signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); });
    });
  }));
}
async function virtualTick(env: any, start: number) {
  vi.useFakeTimers({ now: start, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  let done = false;
  let err: unknown = null;
  runCron(env).catch((e) => { err = e; }).finally(() => { done = true; });
  for (let i = 0; !done && i < 8000; i++) await vi.advanceTimersByTimeAsync(250);
  vi.useRealTimers();
  if (err) throw err;
  expect(done).toBe(true);
}

const SYNC = Date.parse('2026-10-17T23:00:05Z');
const MIN = 60_000, H = 3600_000;
const keyOf = (u: string) => { const m = /pagination\.key=k(\d+)/.exec(u); return m ? Number(m[1]) : 0; };
const balanceOf = (u: string) => { const m = /\/cosmos\/bank\/v1beta1\/balances\/([^/?]+)\/by_denom\?denom=/.exec(u); return m ? decodeURIComponent(m[1]) : null; };
const passOf = (db: any) => { const r = db.raw.prepare("SELECT value FROM kv WHERE key='osmosis.holders.pass'").get(); return r ? JSON.parse(r.value) : null; };
const healthOf = (db: any) => JSON.parse(db.raw.prepare("SELECT value FROM kv WHERE key='source.health'").get().value)['Keplr Osmosis REST (holders)'];
const rowOf = (db: any, a: string) => db.raw.prepare("SELECT balance_num, verified_at FROM holders WHERE chain='osmosis' AND address=?").get(a);
const rowsSum = (db: any) => BigInt(db.raw.prepare("SELECT CAST(SUM(CAST(balance AS INTEGER)) AS TEXT) s FROM holders WHERE chain='osmosis' AND balance_num > 0").get().s);

// 50 pages of 100 owners at 810 ms a page: two ticks a pass. Everyone holds EACH, except A (first page) and C (last
// page), who hold X each, and D (first page), who holds nothing until the move. The supply never changes.
const PAGES = 50, EACH = 3800n, X = 2_000_000n;
const A = osmo(0, 0), D = osmo(0, 1), B = osmo(PAGES - 1, 0), C = osmo(PAGES - 1, 1);
const SUPPLY = BigInt(PAGES * 100 - 4) * EACH + EACH + 2n * X;
/** The bank: its balances (`bal`, EACH where not set), its list in address pages, its supply and its balance of one address. */
function bank(bal: Map<string, bigint>) {
  const amountAt = (a: string) => bal.get(a) ?? EACH;
  return (u: string) => {
    if (u.includes('supply/by_denom')) return json({ amount: { denom: 'x', amount: String(SUPPLY) } });
    const one = balanceOf(u);
    if (one) return json({ balance: { denom: NAM.osmoDenom, amount: String(amountAt(one)) } });
    if (!u.includes('denom_owners')) return undefined;
    const p = keyOf(u);
    const owners = Array.from({ length: 100 }, (_, i) => ({ address: osmo(p, i), balance: { amount: String(amountAt(osmo(p, i))) } })).filter((o) => o.balance.amount !== '0');
    return json({ denom_owners: owners, pagination: { next_key: p + 1 < PAGES ? `k${p + 1}` : null, total: '0' } });
  };
}
const slow = (u: string) => (u.includes('denom_owners') ? 810 : 0);
/** X moves from `from` to `to` (a transfer: the supply does not change). */
const send = (bal: Map<string, bigint>, from: string, to: string) => { bal.set(from, (bal.get(from) ?? EACH) - X); bal.set(to, (bal.get(to) ?? EACH) + X); };
/** One pass of two ticks; `between` runs after the first slice. */
async function twoTickPass(env: any, db: any, at: number, between: () => void = () => {}) {
  await virtualTick(env, at);
  expect(passOf(db).key).not.toBeNull();
  between();
  await virtualTick(env, at + MIN);
  expect(passOf(db).key).toBeNull();
}
async function overview(db: any, now: number) {
  vi.useFakeTimers({ now, toFake: ['Date'] });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
  try { return ((await (await app.request('/api/overview', {}, { DB: db } as any)).json()) as any).concentration; } finally { vi.useRealTimers(); }
}

describe('two moves between the slices of one pass that cancel in the list\'s sum', () => {
  it('the pass is not trusted once its rows, after the reads by address, miss the moved NAM: the figures keep the last trusted pass, and read old 6 hours on', async () => {
    const db = testD1();
    const env = { DB: db, KEPLR_KEY: 'k' };
    const bal = new Map<string, bigint>([[A, X], [C, X], [D, 0n]]);
    network(bank(bal), slow);
    // an honest pass first: trusted, and its row says so as before
    await twoTickPass(env, db, SYNC);
    expect(healthOf(db)).toMatchObject({ ok: true });
    expect(healthOf(db).note).toMatch(/^4999 holders, adding up to the supply within 0\.000% \(one pass of 50 pages over 2 ticks since 23:00 UTC\)$/);
    expect(passOf(db)).toMatchObject({ trustedStartedAt: SYNC, trustedAt: SYNC + MIN });

    // the next pass, an hour on: after its first slice A sends X to B and C sends X to D
    const P2 = SYNC + H;
    await twoTickPass(env, db, P2, () => { send(bal, A, B); send(bal, C, D); });
    // the re-read zeroed A, C was zeroed once the bank said it holds none, and D (read before it received) has no row
    expect(rowOf(db, A).balance_num).toBe(0);
    expect(rowOf(db, C).balance_num).toBe(0);
    expect(rowOf(db, D)).toBeUndefined();
    expect(rowsSum(db)).toBe(SUPPLY - X);
    // the list added up, the rows do not: not trusted, the stamps stay at the last trusted pass, and the row says why
    expect(healthOf(db).ok).toBe(false);
    expect(healthOf(db).note).toMatch(/adding up to the supply within 0\.000% \(one pass of 50 pages over 2 ticks since 00:00 UTC\); after the reads by address the rows add up to 8\.70% away from the supply, so the pass is not taken as current/);
    expect(passOf(db)).toMatchObject({ startedAt: P2, completeAt: P2 + MIN, lastPassMs: MIN, trustedStartedAt: SYNC, trustedAt: SYNC + MIN });
    let f = await readHolderFigures(db as any);
    expect(f!.osmosis).toMatchObject({ rowsAt: SYNC, top10: { at: SYNC } });

    // the next pass that adds up, rows and all, is trusted again (D holds X and is read)
    await twoTickPass(env, db, P2 + H);
    expect(healthOf(db).ok).toBe(true);
    expect(passOf(db)).toMatchObject({ trustedStartedAt: P2 + H });
    expect(rowsSum(db)).toBe(SUPPLY);

    // the moves made on every pass: D (early) sends X to C (late), and B (late) sends X to A (early, read before it
    // received). Six hours after the last trusted pass the figures read old, though every pass's list added up.
    const P4 = P2 + 7 * H;
    await twoTickPass(env, db, P4, () => { send(bal, D, C); send(bal, B, A); });
    expect(healthOf(db).ok).toBe(false);
    expect(passOf(db)).toMatchObject({ trustedStartedAt: P2 + H });
    expect(rowsSum(db)).toBe(SUPPLY - X);
    f = await readHolderFigures(db as any);
    const now = P4 + 2 * MIN;
    expect(holderFiguresProv(f!.osmosis!.top10?.at, f!.osmosis!.rowsAt, now)).toMatchObject({ status: 'stale', at: P2 + H });
    const c = await overview(db, now);
    expect(c.osmosisProv).toMatchObject({ status: 'stale', at: P2 + H });
  }, 60_000);
});

describe('osmosisRowsCheck', () => {
  it('trusts rows within 0.5% of the supply, with no note; not otherwise, nor without a sum or a supply', () => {
    expect(osmosisRowsCheck(1000n, 1000n)).toEqual({ trust: true, note: null });
    expect(osmosisRowsCheck(1005n, 1000n)).toEqual({ trust: true, note: null });
    expect(osmosisRowsCheck(994n, 1000n)).toMatchObject({ trust: false, note: expect.stringMatching(/rows add up to 0\.60% away from the supply/) });
    expect(osmosisRowsCheck(null, 1000n)).toMatchObject({ trust: false, note: expect.stringMatching(/could not be added up/) });
    expect(osmosisRowsCheck(1000n, null)).toMatchObject({ trust: false });
    expect(osmosisRowsCheck(1000n, 0n)).toMatchObject({ trust: false });
  });
});
