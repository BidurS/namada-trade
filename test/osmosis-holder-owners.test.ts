// Security review (2026-10-22), the Osmosis holder list's owners: every page of Keplr REST's denom_owners_by_query
// is under the answer cap, but the list keeps what each page names until the last page is read, so 100 pages of
// owners with long made-up addresses could fill the cron's isolate. An owner is kept only when it is a checksummed
// osmo1 address (at most 85 characters) with a whole-number amount of at most 40 digits, and a page names at most
// the 100 owners asked for, so the list holds at most 10,000 short owners (about 1.5 MB). A page of any other kind
// is not the bank's answer and fails the whole read: nothing from it is written, nobody is zeroed, and the cron's
// health row says which rule the page broke (never what it named).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { bech32 } from '@scure/base';
import { fetchOsmosisHolderList, OSMOSIS_HOLDER_PAGES, OSMOSIS_HOLDER_PAGE_SIZE } from '../worker/src/sources/osmosis';
import { FETCH_JSON_MAX_BYTES } from '../worker/src/util';
import { runCron } from '../worker/src/cron';
import { testD1, insert } from './d1-sqlite';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

/** A checksummed osmo1 address of `bytes` bytes (20: a wallet, 43 characters; 32: a pool or contract, 63). */
const osmo = (seed: number, bytes = 20) => bech32.encode('osmo', bech32.toWords(Uint8Array.from({ length: bytes }, (_, i) => (seed * 31 + i * 7) & 0xff)));
const owner = (address: unknown, amount: unknown = '1000000') => ({ address, balance: { denom: 'ibc/C7110DEC66869DAE9BE9C3C60F4B5313B16A2204AE020C3B0527DD6B322386A3', amount } });
const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });

/** Serves `pages` in order (each a list of owners), a next key on all but the last; records each body's size. */
function serve(pages: unknown[][]) {
  const served: number[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: any) => {
    const url = String(input);
    if (!url.includes('denom_owners_by_query')) return new Response('no', { status: 404 });
    const i = served.length;
    const body = JSON.stringify({ denom_owners: pages[i] ?? [], pagination: { next_key: i < pages.length - 1 ? `k${i}` : null, total: '0' } });
    served.push(body.length);
    return new Response(body, { status: 200 });
  }));
  return served;
}
const read = () => fetchOsmosisHolderList('k', OSMOSIS_HOLDER_PAGES, { timeoutMs: 10_000, retries: 0 });
/** How a read ended, in a few words: its error, or how many holders it kept and in how many characters of address. */
const outcome = () => read().then((r) => `read ${r.holders.length} holders, ${r.holders.reduce((a, h) => a + h.address.length, 0)} characters of address`, (e) => String(e?.message ?? e));

describe('the Osmosis holder list keeps only the bank\'s owners', () => {
  it('100 pages of owners with 19.5 KB addresses, each page under the cap: the first page fails the read, nothing is kept', async () => {
    let page = 0;
    const served: number[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => {
      const owners = Array.from({ length: 100 }, (_, i) => owner(`osmo1p${page}i${i}_${'x'.repeat(19_500)}`, '1'));
      const body = JSON.stringify({ denom_owners: owners, pagination: { next_key: `k${page++}` } });
      served.push(body.length);
      return new Response(body, { status: 200 });
    }));
    expect(await outcome()).toBe("page 1 of the Osmosis holder list is not the bank's answer: an owner that is not an Osmosis address");
    expect(Math.max(...served)).toBeLessThan(FETCH_JSON_MAX_BYTES);
    expect(served).toHaveLength(1);
  });

  it('the bank\'s own answer (wallets and 32-byte accounts, a zero balance, a next key, then the last page) is read whole, as before', async () => {
    const p1 = [owner(osmo(1), '19926988411823'), owner(osmo(2, 32), '5'), owner(osmo(3), '0')];
    const p2 = [owner(osmo(4), '7000000')];
    const served = serve([p1, p2]);
    const r = await read();
    expect(served).toHaveLength(2);
    expect(r.complete).toBe(true);
    expect(r.capped).toBe(false);
    expect(r.holders.map((h) => [h.address, h.balance, h.balanceNum])).toEqual([
      [osmo(1), '19926988411823', 19926988.411823], [osmo(4), '7000000', 7], [osmo(2, 32), '5', 0.000005], [osmo(3), '0', 0],
    ]);
    // a full page of 100 is the bank's too
    serve([Array.from({ length: OSMOSIS_HOLDER_PAGE_SIZE }, (_, i) => owner(osmo(i)))]);
    expect((await read()).holders).toHaveLength(100);
  });

  it('a later page with an owner that is not an address fails the read, the pages before it included', async () => {
    const good = Array.from({ length: 100 }, (_, i) => owner(osmo(i)));
    const served = serve([good, [owner(osmo(500)), owner('osmo1notachecksum0000000000000000000000000')], [owner(osmo(600))]]);
    expect(await outcome()).toBe("page 2 of the Osmosis holder list is not the bank's answer: an owner that is not an Osmosis address");
    expect(served).toHaveLength(2);
  });

  it('any other owner fails it too: a Namada address, a long one, a bad checksum, no address, an amount that is not a whole number or is over 40 digits, no amount', async () => {
    const tooLong = 'osmo1' + 'q'.repeat(81);
    const badSum = osmo(7).slice(0, -1) + (osmo(7).endsWith('q') ? 'p' : 'q');
    const notAddress = [owner('tnam1qxgzrwqn9qny9fzd7xzqm6qs5vpk0kqpx5dvv5vg'), owner(tooLong), owner(badSum), owner(undefined), owner(42), { balance: { amount: '1' } }, null, 'osmo1'];
    const badAmount = [owner(osmo(7), '1.5'), owner(osmo(7), '-1'), owner(osmo(7), ''), owner(osmo(7), '1'.repeat(41)), owner(osmo(7), 1000), { address: osmo(7) }];
    for (const bad of notAddress) {
      serve([[owner(osmo(8)), bad]]);
      expect(await outcome(), JSON.stringify(bad)).toBe("page 1 of the Osmosis holder list is not the bank's answer: an owner that is not an Osmosis address");
    }
    for (const bad of badAmount) {
      serve([[owner(osmo(8)), bad]]);
      expect(await outcome(), JSON.stringify(bad)).toBe("page 1 of the Osmosis holder list is not the bank's answer: an owner whose amount is not a whole number of at most 40 digits");
    }
    // an amount of exactly 40 digits is the bank's
    serve([[owner(osmo(9), '9'.repeat(40))]]);
    expect((await read()).holders).toHaveLength(1);
  });

  it('a page naming more owners than the 100 asked for, or owners that are not a list, is not the bank\'s answer', async () => {
    serve([Array.from({ length: 101 }, (_, i) => owner(osmo(i)))]);
    expect(await outcome()).toBe("page 1 of the Osmosis holder list is not the bank's answer: 101 owners, of 100 asked for");
    vi.stubGlobal('fetch', vi.fn(async () => json({ denom_owners: 'osmo1aaaa', pagination: { next_key: null } })));
    expect(await outcome()).toBe("page 1 of the Osmosis holder list is not the bank's answer: its owners are not a list");
  });

  it('as before: a page with no owners and no next key is the end; a page without pagination stops the list, not complete', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ pagination: { next_key: null, total: '0' } })));
    expect(await read()).toEqual({ holders: [], complete: true, capped: false, pages: 1 });
    vi.stubGlobal('fetch', vi.fn(async () => json({ denom_owners: [owner(osmo(1))] })));
    expect(await read()).toMatchObject({ holders: [{ address: osmo(1) }], complete: false, capped: false });
  });
});

describe('the cron with a holder list that is not the bank\'s', () => {
  it('the health row is not ok and says why, nothing from the read is written, and the stored holder stands', async () => {
    const SYNC = Date.parse('2026-10-17T22:40:05Z');
    const db = testD1();
    insert(db, 'holders', [{ chain: 'osmosis', address: osmo(1), balance: '5000000', balance_num: 5, updated_at: SYNC - 600000, verified_at: SYNC - 600000 }]);
    vi.stubGlobal('fetch', vi.fn(async (input: any) => {
      const url = String(input);
      // a first page of the bank's shape and a second that names a made-up owner; the supply matches the first page
      if (url.includes('denom_owners')) return url.includes('pagination.key')
        ? json({ denom_owners: [owner(`osmo1${'x'.repeat(19_500)}`)], pagination: { next_key: null } })
        : json({ denom_owners: [owner(osmo(2), '10000000')], pagination: { next_key: 'k0' } });
      if (url.includes('supply/by_denom')) return json({ amount: { denom: 'x', amount: '10000000' } });
      return new Response('not here', { status: 404 });
    }));
    vi.useFakeTimers({ now: SYNC, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    let done = false;
    runCron({ DB: db, KEPLR_KEY: 'k' } as any).catch(() => {}).finally(() => { done = true; });
    for (let i = 0; !done && i < 4000; i++) await vi.advanceTimersByTimeAsync(250);
    vi.useRealTimers();
    expect(done).toBe(true);
    const health = JSON.parse((db.raw.prepare("SELECT value FROM kv WHERE key='source.health'").get() as { value: string }).value);
    expect(health['Keplr Osmosis REST (holders)']).toMatchObject({ ok: false, note: "Error: page 2 of the Osmosis holder list is not the bank's answer: an owner that is not an Osmosis address" });
    expect(db.raw.prepare("SELECT address, balance, verified_at FROM holders WHERE chain='osmosis'").all().map((r: any) => ({ ...r })))
      .toEqual([{ address: osmo(1), balance: '5000000', verified_at: SYNC - 600000 }]);
  });
});
