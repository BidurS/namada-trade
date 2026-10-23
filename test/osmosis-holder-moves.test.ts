// Security review (2026-10-22), Osmosis holders that move NAM between the slices of one pass: a pass of the bank's
// holder list read over several ticks reads each address once, at its own minute. A holder that sends its NAM from an
// address read in an early slice to one read in a later slice is read at both, so the count and the top ten counted
// the same NAM twice; the pass does not add up and zeroes nobody, yet every row it wrote carried a fresh reading and
// the figures said live, pass after pass, for two transfers a pass. The other way round, an address the pass read
// before it received NAM, missing from the list and within the 0.5% the check allows, was zeroed while the bank held
// NAM there. Now the Osmosis figures are stamped no later than the start of the last pass that added up to the supply
// (kv osmosis.holders.pass trustedStartedAt), the slice that completes a pass of several ticks reads its ten largest
// earlier readings again by address, and a holder the list stopped naming is zeroed only once the bank, asked by
// address, says it holds none (at most 20 a pass; the rest wait for the next).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { bech32 } from '@scure/base';
import { runCron, OSMO_DROP_RECHECK_MAX } from '../worker/src/cron';
import { readHolderFigures } from '../worker/src/holders';
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

/** The chain stubbed as in test/osmosis-holder-pass.test.ts; `answer` serves the Keplr reads, `slowMs` delays one. */
function network(answer: (url: string) => Response | undefined, slowMs: (url: string) => number = () => 0) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
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
  return calls;
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
/** The address a bank balance read (balances/{address}/by_denom) asks about, or null. */
const balanceOf = (u: string) => { const m = /\/cosmos\/bank\/v1beta1\/balances\/([^/?]+)\/by_denom\?denom=/.exec(u); return m ? decodeURIComponent(m[1]) : null; };
const balanceAnswer = (amount: bigint) => json({ balance: { denom: NAM.osmoDenom, amount: String(amount) } });
const passOf = (db: any) => { const r = db.raw.prepare("SELECT value FROM kv WHERE key='osmosis.holders.pass'").get(); return r ? JSON.parse(r.value) : null; };
const healthOf = (db: any) => JSON.parse(db.raw.prepare("SELECT value FROM kv WHERE key='source.health'").get().value)['Keplr Osmosis REST (holders)'];
const rowOf = (db: any, a: string) => db.raw.prepare("SELECT balance_num, verified_at FROM holders WHERE chain='osmosis' AND address=?").get(a);

// 50 pages of 100 owners (5,000 owners: about 3,700 more than on 2026-10-23), each holding 3,800 base units, except
// the first owner, a top holder with 2 NAM (9.5% of the supply, as the largest Osmosis holder held on 2026-10-23).
// `state.moved`: the top holder has sent its 2 NAM to the first owner of the last page (its own second address).
const PAGES = 50, EACH = 3800n, BIG = 2_000_000n;
const SUPPLY = BigInt(PAGES * 100 - 1) * EACH + BIG;
const TOP = osmo(0, 0), SECOND = osmo(PAGES - 1, 0);
/** The bank at `state`: its list, its supply and its balance of any one address. */
function bank(state: { moved: boolean }) {
  const amountAt = (a: string) => (a === TOP ? (state.moved ? 0n : BIG) : a === SECOND ? EACH + (state.moved ? BIG : 0n) : EACH);
  return (u: string) => {
    if (u.includes('supply/by_denom')) return json({ amount: { denom: 'x', amount: String(SUPPLY) } });
    const one = balanceOf(u);
    if (one) return balanceAnswer(amountAt(one));
    if (!u.includes('denom_owners')) return undefined;
    const p = keyOf(u);
    const owners = Array.from({ length: 100 }, (_, i) => ({ address: osmo(p, i), balance: { amount: String(amountAt(osmo(p, i))) } }))
      .filter((o) => o.balance.amount !== '0');
    return json({ denom_owners: owners, pagination: { next_key: p + 1 < PAGES ? `k${p + 1}` : null, total: '0' } });
  };
}
const slow = (u: string) => (u.includes('denom_owners') ? 810 : 0);
/** One pass of two ticks at the measured pace (810 ms a page), the top holder moving between them when `move`. */
async function twoTickPass(env: any, db: any, at: number, state: { moved: boolean }, move: boolean) {
  state.moved = false;
  await virtualTick(env, at);
  expect(passOf(db).key).not.toBeNull(); // the pass needed a second tick
  state.moved = move;
  await virtualTick(env, at + MIN);
  expect(passOf(db).key).toBeNull();
  state.moved = false;
}
async function overviewProv(db: any, now: number) {
  vi.useFakeTimers({ now, toFake: ['Date'] });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
  try {
    const ov: any = await (await app.request('/api/overview', {}, { DB: db } as any)).json();
    return ov.concentration;
  } finally { vi.useRealTimers(); }
}

describe('a holder that moves between two slices of one pass', () => {
  it('is counted once (the earlier slices\' largest readings are read again by address), and an untrusted pass does not make the figures current', async () => {
    const db = testD1();
    const env = { DB: db, KEPLR_KEY: 'k' };
    const state = { moved: false };
    network(bank(state), slow);
    await twoTickPass(env, db, SYNC, state, true);
    // the pass does not add up (the 2 NAM read twice) and says so in its row; nobody is zeroed
    expect(healthOf(db).ok).toBe(false);
    expect(healthOf(db).note).toMatch(/away from the supply/);
    // the top holder's first address, read in the first slice, was read again when the pass completed: it holds none
    expect(rowOf(db, TOP)).toEqual({ balance_num: 0, verified_at: SYNC + MIN });
    expect(rowOf(db, SECOND).balance_num).toBeCloseTo(Number(EACH + BIG) / 1e6, 9);
    const f = await readHolderFigures(db as any);
    expect(f!.osmosis!.holders).toBe(4999);
    expect(f!.osmosis!.top10!.s).toBeCloseTo((Number(BIG) + 10 * Number(EACH)) / 1e6, 9);
    // no pass has added up yet: the figures are not called current
    const now = SYNC + 2 * MIN;
    expect(holderFiguresProv(f!.osmosis!.top10?.at, f!.osmosis!.rowsAt, now).status).not.toBe('live');
    const c = await overviewProv(db, now);
    expect(c.osmosisProv.status).not.toBe('live');
  });

  it('after a pass that added up, a pass that does not keeps the figures at that pass\'s start: old 6 hours on, though every row was read again', async () => {
    const db = testD1();
    const env = { DB: db, KEPLR_KEY: 'k' };
    const state = { moved: false };
    network(bank(state), slow);
    await twoTickPass(env, db, SYNC, state, false);
    expect(healthOf(db).ok).toBe(true);
    expect(passOf(db)).toMatchObject({ trustedStartedAt: SYNC, trustedAt: SYNC + MIN });
    let f = await readHolderFigures(db as any);
    expect(f!.osmosis).toMatchObject({ holders: 5000, rowsAt: SYNC, top10: { at: SYNC } });
    // seven hours on, the holder moves its NAM between the slices of the next pass, and on every pass after
    const later = SYNC + 7 * H;
    await twoTickPass(env, db, later, state, true);
    expect(healthOf(db).ok).toBe(false);
    expect(passOf(db)).toMatchObject({ trustedStartedAt: SYNC, startedAt: later });
    f = await readHolderFigures(db as any);
    // every counted row was read in the last pass, but none since a pass added up: the stamp is that pass's start
    expect(db.raw.prepare("SELECT MIN(verified_at) m FROM holders WHERE chain='osmosis' AND balance_num > 0").get().m).toBe(later);
    expect(f!.osmosis).toMatchObject({ rowsAt: SYNC, top10: { at: SYNC } });
    expect(holderFiguresProv(f!.osmosis!.top10?.at, f!.osmosis!.rowsAt, later + 2 * MIN)).toMatchObject({ status: 'stale', at: SYNC });
    const c = await overviewProv(db, later + 2 * MIN);
    expect(c.osmosisProv).toMatchObject({ status: 'stale', at: SYNC });
    // and the moved NAM is counted once
    expect(c.osmosisTop10Pct).toBeLessThan(10);
    // the next pass that adds up makes them current again
    network(bank(state), slow);
    await twoTickPass(env, db, later + 7 * H, state, false);
    f = await readHolderFigures(db as any);
    expect(f!.osmosis).toMatchObject({ rowsAt: later + 7 * H, top10: { at: later + 7 * H } });
  }, 30_000);
});

describe('a holder that receives NAM behind the cursor', () => {
  it('is not zeroed by the pass that completes: the bank, asked by address, says it holds NAM, and that is written', async () => {
    const db = testD1();
    const env = { DB: db, KEPLR_KEY: 'k' };
    // Y (first page) held 0.5 NAM at the last pass and had sold out when this pass read the first page; X (last page)
    // sends it 0.05 NAM between the slices. The pass misses 0.05 NAM (0.2% of the supply): trusted.
    const Y = osmo(0, 1), X = osmo(PAGES - 1, 2), W = 50_000n;
    insert(db, 'holders', [{ chain: 'osmosis', address: Y, balance: '500000', balance_num: 0.5, updated_at: SYNC - 10 * MIN, verified_at: SYNC - 10 * MIN, verified_src: 'keplr_rest' }]);
    const state = { moved: false };
    const supply = BigInt(PAGES * 100 - 1) * EACH + 200_000n;
    const amountAt = (a: string) => (a === Y ? (state.moved ? W : 0n) : a === X ? EACH + 200_000n - (state.moved ? W : 0n) : EACH);
    network((u: string) => {
      if (u.includes('supply/by_denom')) return json({ amount: { denom: 'x', amount: String(supply) } });
      const one = balanceOf(u);
      if (one) return balanceAnswer(amountAt(one));
      if (!u.includes('denom_owners')) return undefined;
      const p = keyOf(u);
      const owners = Array.from({ length: 100 }, (_, i) => ({ address: osmo(p, i), balance: { amount: String(amountAt(osmo(p, i))) } }))
        .filter((o) => o.balance.amount !== '0');
      return json({ denom_owners: owners, pagination: { next_key: p + 1 < PAGES ? `k${p + 1}` : null, total: '0' } });
    }, slow);
    await virtualTick(env, SYNC);
    expect(passOf(db).key).not.toBeNull();
    state.moved = true;
    await virtualTick(env, SYNC + MIN);
    expect(healthOf(db).ok).toBe(true);
    expect(healthOf(db).note).toMatch(/1 not named by the list holds NAM by the bank's balance read by address, so it was written at that balance/);
    expect(rowOf(db, Y)).toEqual({ balance_num: 0.05, verified_at: SYNC + MIN });
  });
});

describe('a holder the list stopped naming', () => {
  /** One complete page of 100 owners holding the supply, beside `gone` stored rows the list no longer names. */
  function setup(gone: string[], bankSays: (a: string) => bigint | 'fail') {
    const db = testD1();
    insert(db, 'holders', gone.map((a, i) => ({ chain: 'osmosis', address: a, balance: String(1_000_000 + i), balance_num: (1_000_000 + i) / 1e6, updated_at: SYNC - 10 * MIN, verified_at: SYNC - 10 * MIN, verified_src: 'keplr_rest' })));
    const calls = network((u) => {
      if (u.includes('supply/by_denom')) return json({ amount: { denom: 'x', amount: '100000' } });
      const one = balanceOf(u);
      if (one) { const v = bankSays(one); return v === 'fail' ? new Response('no', { status: 404 }) : balanceAnswer(v); }
      if (u.includes('denom_owners')) return json({ denom_owners: Array.from({ length: 100 }, (_, i) => ({ address: osmo(1, i), balance: { amount: '1000' } })), pagination: { next_key: null } });
      return undefined;
    });
    return { db, calls };
  }

  it('is zeroed when the bank says by address it holds none, as before', async () => {
    const A = osmo(9, 1);
    const { db, calls } = setup([A], () => 0n);
    await virtualTick({ DB: db, KEPLR_KEY: 'k' }, SYNC);
    expect(healthOf(db)).toMatchObject({ ok: true, note: '100 holders, adding up to the supply within 0.000%' });
    expect(rowOf(db, A)).toEqual({ balance_num: 0, verified_at: SYNC });
    expect(calls.filter((u) => balanceOf(u) === A)).toHaveLength(1);
    // a single-tick pass reads nothing else by address
    expect(calls.filter((u) => balanceOf(u) != null)).toHaveLength(1);
    expect((await readHolderFigures(db as any))!.osmosis).toMatchObject({ holders: 100, rowsAt: SYNC });
  });

  it('is kept, and the row says so, when the bank does not answer by address; the next pass asks again', async () => {
    const A = osmo(9, 1);
    const { db } = setup([A], () => 'fail');
    await virtualTick({ DB: db, KEPLR_KEY: 'k' }, SYNC);
    expect(healthOf(db).note).toMatch(/1 not named by the list was not zeroed: neither Keplr's REST nor Osmosis's public REST answered the balance read by address in this tick's time, so the next pass asks again/);
    expect(rowOf(db, A)).toEqual({ balance_num: 1, verified_at: SYNC - 10 * MIN });
    // the 1 NAM kept is ten times the supply: the rows the pass leaves do not add up, so it is not taken as current
    expect(healthOf(db).ok).toBe(false);
    expect(healthOf(db).note).toMatch(/after the reads by address the rows add up to 1000\.00% away from the supply, so the pass is not taken as current/);
    expect(passOf(db)).toMatchObject({ completeAt: SYNC, trustedStartedAt: SYNC - 10 * MIN, trustedAt: null });
    // the count includes it, so its stamp is its own old reading
    expect((await readHolderFigures(db as any))!.osmosis).toMatchObject({ holders: 101, rowsAt: SYNC - 10 * MIN });
    network((u) => {
      if (u.includes('supply/by_denom')) return json({ amount: { denom: 'x', amount: '100000' } });
      if (balanceOf(u)) return balanceAnswer(0n);
      if (u.includes('denom_owners')) return json({ denom_owners: Array.from({ length: 100 }, (_, i) => ({ address: osmo(1, i), balance: { amount: '1000' } })), pagination: { next_key: null } });
      return undefined;
    });
    await virtualTick({ DB: db, KEPLR_KEY: 'k' }, SYNC + 10 * MIN);
    expect(rowOf(db, A)).toEqual({ balance_num: 0, verified_at: SYNC + 10 * MIN });
    expect(healthOf(db)).toMatchObject({ ok: true, note: '100 holders, adding up to the supply within 0.000%' });
    expect(passOf(db)).toMatchObject({ trustedStartedAt: SYNC + 10 * MIN, trustedAt: SYNC + 10 * MIN });
  });

  it(`at most ${OSMO_DROP_RECHECK_MAX} are asked about a pass, the largest first; the rest are kept for the next passes`, async () => {
    const gone = Array.from({ length: OSMO_DROP_RECHECK_MAX + 5 }, (_, i) => osmo(20, i));
    const { db, calls } = setup(gone, () => 0n);
    await virtualTick({ DB: db, KEPLR_KEY: 'k' }, SYNC);
    const asked = calls.map(balanceOf).filter((a): a is string => a != null);
    // the largest (the last inserted) first
    expect(new Set(asked)).toEqual(new Set(gone.slice(5)));
    expect(gone.slice(5).every((a) => rowOf(db, a).balance_num === 0)).toBe(true);
    expect(gone.slice(0, 5).every((a) => rowOf(db, a).balance_num > 0)).toBe(true);
    expect(healthOf(db).note).toMatch(new RegExp(`more than ${OSMO_DROP_RECHECK_MAX} were not named by the list`));
  });

  it('a stored row whose address is not an Osmosis address is zeroed without asking: the bank holds nothing there', async () => {
    const { db, calls } = setup(['osmo1zzz'], () => 7n);
    await virtualTick({ DB: db, KEPLR_KEY: 'k' }, SYNC);
    expect(rowOf(db, 'osmo1zzz')).toEqual({ balance_num: 0, verified_at: SYNC });
    expect(calls.filter((u) => balanceOf(u) != null)).toHaveLength(0);
  });
});

describe('the first pass after this build', () => {
  it('the rows the last build read stand as the last trusted reading: a first pass that does not add up leaves the stamp there', async () => {
    const db = testD1();
    const env = { DB: db, KEPLR_KEY: 'k' };
    // the last build's list, read 10 minutes ago; no pass record yet
    const OLD = SYNC - 10 * MIN;
    insert(db, 'holders', Array.from({ length: 100 }, (_, i) => ({ chain: 'osmosis', address: osmo(1, i), balance: '1000', balance_num: 0.001, updated_at: OLD, verified_at: OLD, verified_src: 'keplr_rest' })));
    const list = (supply: string) => (u: string) => {
      if (u.includes('supply/by_denom')) return json({ amount: { denom: 'x', amount: supply } });
      if (u.includes('denom_owners')) return json({ denom_owners: Array.from({ length: 100 }, (_, i) => ({ address: osmo(1, i), balance: { amount: '1000' } })), pagination: { next_key: null } });
      return undefined;
    };
    network(list('200000'));
    await virtualTick(env, SYNC);
    expect(healthOf(db).ok).toBe(false);
    expect(passOf(db)).toMatchObject({ trustedStartedAt: OLD, trustedAt: null });
    expect((await readHolderFigures(db as any))!.osmosis).toMatchObject({ rowsAt: OLD, top10: { at: OLD } });
    // a pass that adds up: the stamp is its start, as it was before the passes
    network(list('100000'));
    await virtualTick(env, SYNC + 10 * MIN);
    expect(passOf(db)).toMatchObject({ trustedStartedAt: SYNC + 10 * MIN });
    expect((await readHolderFigures(db as any))!.osmosis).toMatchObject({ rowsAt: SYNC + 10 * MIN, top10: { at: SYNC + 10 * MIN } });
  });
});
