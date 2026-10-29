// Security review (2026-10-22), the Osmosis balance read by address: a holder the bank's list stopped naming is zeroed
// only once the bank, asked by address, says it holds none, and that read went to Keplr's REST proxy alone, on a route
// (bank balances by_denom) this project had not used before. Had Keplr refused it, no holder would ever have been
// zeroed again, with the holders row still ok. Now a failed Keplr read is asked again of Osmosis's public REST, which
// serves the route with the same answer shape (checked on 2026-10-23), a row it answers names it as its source, and
// the holders row says when neither answered.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { bech32 } from '@scure/base';
import { runCron, recheckOsmosisRows } from '../worker/src/cron';
import { fetchOsmosisBalanceBase } from '../worker/src/sources/osmosis';
import { NAM, OSMOSIS } from '../worker/src/config';
import { testD1, insert } from './d1-sqlite';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const osmo = (page: number, i: number) => bech32.encode('osmo', bech32.toWords(Uint8Array.from({ length: 20 }, (_, k) => (k === 0 ? page : k === 1 ? i : k === 2 ? 0xa5 : (page * 7 + i * 13 + k) & 0xff))));
const KEPLR = OSMOSIS.keplrRest;
const PUBLIC = OSMOSIS.publicRest;
const balanceOf = (u: string) => { const m = /\/cosmos\/bank\/v1beta1\/balances\/([^/?]+)\/by_denom\?denom=/.exec(u); return m ? decodeURIComponent(m[1]) : null; };
const answer = (amount: bigint | string, denom: string = NAM.osmoDenom) => json({ balance: { denom, amount: String(amount) } });

describe('fetchOsmosisBalanceBase', () => {
  const A = osmo(3, 3);
  function stub(keplr: () => Response | Promise<Response>, pub: () => Response | Promise<Response>) {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url.startsWith(KEPLR) ? 'keplr' : url.startsWith(PUBLIC) ? 'public' : url);
      return url.startsWith(KEPLR) ? keplr() : pub();
    }));
    return calls;
  }

  it('reads Keplr first and stops there when it answers', async () => {
    const calls = stub(() => answer(5n), () => answer(9n));
    expect(await fetchOsmosisBalanceBase('k', A, { retries: 0 })).toEqual({ base: 5n, src: 'keplr_rest' });
    expect(calls).toEqual(['keplr']);
  });

  it('asks Osmosis\'s public REST when Keplr refuses the route, does not answer, or answers with something else', async () => {
    for (const keplr of [() => json({ code: 12, message: 'Not Implemented' }, 501), () => new Response('not found', { status: 404 }), () => answer(5n, 'uosmo'), () => answer('5.5'), () => json({ nothing: true })]) {
      const calls = stub(keplr, () => answer(0n));
      expect(await fetchOsmosisBalanceBase('k', A, { retries: 0 })).toEqual({ base: 0n, src: 'osmosis_public_rest' });
      expect(calls).toEqual(['keplr', 'public']);
      // the same path on both
      const urls = (fetch as any).mock.calls.map((c: any[]) => String(c[0]));
      expect(urls.map(balanceOf)).toEqual([A, A]);
    }
  });

  it('throws a plain sentence when neither gives the bank\'s answer', async () => {
    stub(() => new Response('no', { status: 404 }), () => answer(1n, 'uosmo'));
    await expect(fetchOsmosisBalanceBase('k', A, { retries: 0 })).rejects.toThrow("neither Keplr's REST nor Osmosis's public REST gave the bank's balance by address");
  });

  it('a deadline ends both: the public REST is not asked once the signal has ended', async () => {
    const c = new AbortController();
    const calls = stub(() => { c.abort('deadline'); return new Response('late', { status: 503 }); }, () => answer(0n));
    await expect(fetchOsmosisBalanceBase('k', A, { retries: 0, signal: c.signal })).rejects.toThrow();
    expect(calls).toEqual(['keplr']);
  });
});

// ---------------------------------------------------------------- the tick that completes a pass
const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));
const BAL = fx('balance_listing.json');
const BONDS = fx('bonds_listing.json');
const u256 = (n: bigint) => { const b = new Uint8Array(32); let v = n; for (let i = 0; i < 32; i++) { b[i] = Number(v & 0xffn); v >>= 8n; } return btoa(String.fromCharCode(...b)); };
function network(custom: (url: string) => Response | undefined) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const c = custom(url);
    if (c) return c;
    if (url.includes('/status')) return json({ result: { sync_info: { latest_block_height: '8343400', latest_block_time: new Date().toISOString(), catching_up: false, earliest_block_height: '1' } } });
    if (url.includes('abci_query')) {
      const path = decodeURIComponent(url.split('path=')[1] ?? '');
      if (path.includes('/vp/pos/bond/')) return json({ result: { response: { code: 1, info: 'RPC error: Cannot find bond', value: null, height: '1' } } });
      const value = path.includes('/shell/epoch') ? btoa(String.fromCharCode(155, 10, 0, 0, 0, 0, 0, 0))
        : path.includes('/shell/prefix/') ? BAL.value
        : path.includes('/vp/pos/bonds_and_unbonds/to') ? BONDS.value
        : path.includes('delegations_at') ? null
        : path.includes('balance/minted') ? u256(BigInt(BAL.expected.minted))
        : u256(path.includes('total_stake') ? 75338381473000n : 1000000n);
      return json({ result: { response: { code: 0, value, height: '8343400' } } });
    }
    return new Response('not here', { status: 404 });
  }));
  return calls;
}
async function virtualTick(env: any, start: number) {
  vi.useFakeTimers({ now: start, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  let done = false;
  let err: unknown = null;
  runCron(env).catch((e) => { err = e; }).finally(() => { done = true; });
  for (let i = 0; !done && i < 4000; i++) await vi.advanceTimersByTimeAsync(250);
  vi.useRealTimers();
  if (err) throw err;
  expect(done).toBe(true);
}
const SYNC = Date.parse('2026-10-17T23:00:05Z');
const MIN = 60_000;
const healthOf = (db: any) => JSON.parse(db.raw.prepare("SELECT value FROM kv WHERE key='source.health'").get().value)['Keplr Osmosis REST (holders)'];
const rowOf = (db: any, a: string) => db.raw.prepare("SELECT balance_num, verified_at, verified_src FROM holders WHERE chain='osmosis' AND address=?").get(a);

describe('a holder the list stopped naming, when Keplr does not serve the balance read by address', () => {
  /** One complete page of 100 owners holding the supply, beside a stored row the list no longer names (a seller of 0.0001 NAM). */
  function setup(publicSays: (a: string) => Response) {
    const db = testD1();
    const A = osmo(9, 1);
    insert(db, 'holders', [{ chain: 'osmosis', address: A, balance: '100', balance_num: 0.0001, updated_at: SYNC - 10 * MIN, verified_at: SYNC - 10 * MIN, verified_src: 'keplr_rest' }]);
    const calls = network((u) => {
      if (u.includes('supply/by_denom')) return json({ amount: { denom: 'x', amount: '100000' } });
      if (balanceOf(u)) return u.startsWith(KEPLR) ? json({ code: 12, message: 'Not Implemented' }, 501) : publicSays(balanceOf(u)!);
      if (u.includes('denom_owners')) return json({ denom_owners: Array.from({ length: 100 }, (_, i) => ({ address: osmo(1, i), balance: { amount: '1000' } })), pagination: { next_key: null } });
      return undefined;
    });
    return { db, A, calls };
  }

  it('is zeroed on Osmosis\'s public REST\'s word that it holds none, and the row names that source', async () => {
    const { db, A, calls } = setup(() => answer(0n));
    await virtualTick({ DB: db, KEPLR_KEY: 'k' }, SYNC);
    expect(rowOf(db, A)).toEqual({ balance_num: 0, verified_at: SYNC, verified_src: 'osmosis_public_rest' });
    expect(calls.filter((u) => balanceOf(u) === A).map((u) => (u.startsWith(KEPLR) ? 'keplr' : u.startsWith(PUBLIC) ? 'public' : u))).toEqual(['keplr', 'keplr', 'public']);
    expect(healthOf(db)).toMatchObject({ ok: true, note: '100 holders, adding up to the supply within 0.000%' });
  });

  it('the largest readings of a pass\'s earlier slices: read again from the public REST, and the note says how many neither answered', async () => {
    const db = testD1();
    const B = osmo(2, 1), C = osmo(2, 2);
    insert(db, 'holders', [B, C].map((a) => ({ chain: 'osmosis', address: a, balance: '7000', balance_num: 0.007, updated_at: SYNC - MIN, verified_at: SYNC - MIN, verified_src: 'keplr_rest' })));
    network((u) => (balanceOf(u) ? (u.startsWith(KEPLR) ? new Response('no', { status: 404 }) : balanceOf(u) === B ? answer(3000n) : new Response('busy', { status: 503 })) : undefined));
    const r = await recheckOsmosisRows(db as any, 'k', SYNC, null, SYNC, { retries: 0 });
    expect(r).toMatchObject({ zeroed: 0, reread: 1, topUnanswered: 1 });
    expect(rowOf(db, B)).toEqual({ balance_num: 0.003, verified_at: SYNC, verified_src: 'osmosis_public_rest' });
    expect(rowOf(db, C)).toEqual({ balance_num: 0.007, verified_at: SYNC - MIN, verified_src: 'keplr_rest' });
    expect(r.note).toBe("1 of the largest readings of the earlier slices was not read again: neither Keplr's REST nor Osmosis's public REST answered the balance read by address in this tick's time");
  });

  it('is kept when neither answers, and the holders row says neither did', async () => {
    const { db, A } = setup(() => new Response('busy', { status: 503 }));
    await virtualTick({ DB: db, KEPLR_KEY: 'k' }, SYNC);
    expect(rowOf(db, A)).toEqual({ balance_num: 0.0001, verified_at: SYNC - 10 * MIN, verified_src: 'keplr_rest' });
    expect(healthOf(db).note).toMatch(/1 not named by the list was not zeroed: neither Keplr's REST nor Osmosis's public REST answered the balance read by address in this tick's time, so the next pass asks again/);
    // its 0.0001 NAM is 0.1% of the supply: the rows still add up, so the pass is trusted
    expect(healthOf(db).ok).toBe(true);
  });
});
