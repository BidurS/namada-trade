// A third Namada node (2026-11-07, config.ts NAMADA.rpcs). That day both nodes configured until then, 5ElementsNodes and
// Papadritta, answered HTTP 502 for hours, and every Namada read of the live site failed with them: the epoch, the minted
// total, the four protocol balances and the listings, each health row saying "upstream unavailable (HTTP 502)". With
// Stake&Relax listed after the two, a tick in which the first two answer 502 to everything reads the chain from the third:
// its status is the one that answers (answeringRpcs), so every chain query of the tick goes to it and the two down nodes
// cost one status read each; the indexer's latest block is the second answer the listing head needs beside the one node
// up (listingHeads). The real runCron against the sqlite D1 stand-in and a stubbed network, the listings answered from the
// fixtures cut from real answers (test/fixtures/balance_listing.json, bonds_listing.json).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { runCron, MINT_RULE_KV, type BondListingRecord } from '../worker/src/cron';
import { NAMADA } from '../worker/src/config';
import { toNam } from '../worker/src/util';
import { testD1, type TestD1 } from './d1-sqlite';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));
const BAL = fx('balance_listing.json');
const BONDS = fx('bonds_listing.json');
const u256 = (n: bigint) => { const b = new Uint8Array(32); let v = n; for (let i = 0; i < 32; i++) { b[i] = Number(v & 0xffn); v >>= 8n; } return btoa(String.fromCharCode(...b)); };
const u64 = (n: number) => btoa(String.fromCharCode(n & 0xff, (n >> 8) & 0xff, 0, 0, 0, 0, 0, 0));
const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });

const [FIVE, PAPA, SAR] = NAMADA.rpcs.map((r) => new URL(r.url).host);
const HEAD = 8_343_400;

/** The first two nodes answer HTTP 502 to every request, as on 2026-11-07; Stake&Relax answers the head; the indexer agrees. */
function network() {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const host = new URL(url).host;
    if (host === FIVE || host === PAPA) return new Response('<html><body><h1>502 Bad Gateway</h1></body></html>', { status: 502, headers: { 'content-type': 'text/html' } });
    if (host === SAR) {
      if (url.includes('/status')) return json({ result: { node_info: { network: NAMADA.chainId }, sync_info: { latest_block_height: String(HEAD), latest_block_time: new Date().toISOString(), catching_up: false, earliest_block_height: '1' } } });
      if (url.includes('abci_query')) {
        const path = decodeURIComponent((url.split('path=')[1] ?? '').split('&')[0]).replace(/^"|"$/g, '');
        // An address without a self-bond gets code 1 ("Cannot find bond"), as the real nodes answer.
        if (path.includes('/vp/pos/bond/')) return json({ result: { response: { code: 1, info: 'RPC error: Cannot find bond', value: null, height: '1' } } });
        const value = path.includes('/shell/epoch') ? u64(2715)
          : path.includes('masp_epoch_multiplier') ? u64(4)
          : path.includes('/shell/prefix/') ? BAL.value
          : path.includes('/vp/pos/bonds_and_unbonds/to') ? BONDS.value
          : path.includes('delegations_at') ? null
          : path.includes('balance/minted') ? u256(BigInt(BAL.expected.minted))
          : u256(path.includes('total_stake') ? 75_338_381_473_000n : 1_000_000n);
        return json({ result: { response: { code: 0, value, height: String(HEAD) } } });
      }
      return new Response('not here', { status: 404 });
    }
    if (url.includes('indexer.namada.net') && url.includes('/chain/block/latest')) return json({ block: String(HEAD - 10) });
    if (url.includes('denom_owners')) return json({ denom_owners: [{ address: 'osmo14242424242424242424242424242424249gydw', balance: { amount: '3000000' } }], pagination: { next_key: null, total: '0' } });
    if (url.includes('supply/by_denom')) return json({ amount: { denom: 'x', amount: '10000000' } });
    return new Response('not here', { status: 404 });
  }));
  return calls;
}

/** Run a tick under fake timers from `start`. */
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

// 22:41:05 UTC: not a 10-minute holder sync
const PLAIN = Date.parse('2026-11-07T22:41:05Z');
const healthOf = (db: TestD1): Record<string, { ok: boolean; note?: string }> => JSON.parse((db.raw.prepare("SELECT value FROM kv WHERE key='source.health'").get() as any).value);
const metric = (db: TestD1, key: string, ts: number): number | null => (db.raw.prepare('SELECT value FROM metrics WHERE key = ? AND ts = ?').get(key, ts) as any)?.value ?? null;
const kv = <T,>(db: TestD1, key: string): T | null => { const r = db.raw.prepare('SELECT value FROM kv WHERE key = ?').get(key) as any; return r ? JSON.parse(r.value) : null; };

describe('the two nodes configured before 2026-11-07 answering HTTP 502, Stake&Relax answering the head', () => {
  it('the epoch, the minted total, the four protocol balances and the bond listing are read from Stake&Relax, and the health rows name it', async () => {
    expect(NAMADA.rpcs.map((r) => r.provider)).toEqual(['5ElementsNodes', 'Papadritta', 'StakeAndRelax']);
    const db = testD1();
    const calls = network();
    await virtualTick({ DB: db, KEPLR_KEY: 'k' }, PLAIN);

    // the node rows: the two down with their status, the third up with its height
    const h = healthOf(db);
    for (const name of ['Namada RPC 5ElementsNodes', 'Namada RPC Papadritta']) {
      expect(h[name], name).toMatchObject({ ok: false });
      expect(h[name].note, name).toMatch(/HTTP 502/);
    }
    expect(h['Namada RPC StakeAndRelax']).toMatchObject({ ok: true, note: `height ${HEAD}` });
    // the reads that failed on 2026-11-07, each ok
    for (const name of ['Namada RPC (epoch)', 'Namada RPC (minted supply)', 'Namada RPC (PoS balance)', 'Namada RPC (IBC escrow)', 'Namada RPC (MASP balance)', 'Namada RPC (PGF balance)', 'Namada RPC (total stake)']) {
      expect(h[name], name).toMatchObject({ ok: true });
    }

    // every chain query of the tick went to the node whose status answered; the two down were asked their status only
    const queries = calls.filter((u) => u.includes('abci_query') || u.includes('/blockchain') || u.includes('/block_results'));
    expect(queries.length).toBeGreaterThan(5);
    expect(queries.filter((u) => new URL(u).host !== SAR)).toEqual([]);
    for (const host of [FIVE, PAPA]) {
      const asked = calls.filter((u) => new URL(u).host === host);
      expect(asked.length, host).toBeGreaterThan(0);
      expect(asked.filter((u) => !u.endsWith('/status')), host).toEqual([]);
    }

    // the figures, stored at the tick from the chain's values: none missing, none 0 for a value the node gave
    expect(metric(db, 'supply.total', PLAIN)).toBe(toNam(BigInt(BAL.expected.minted)));
    for (const key of ['supply.pos_bonded', 'supply.ibc_escrow', 'supply.masp_shielded', 'supply.pgf']) expect(metric(db, key, PLAIN), key).toBe(1);
    expect(metric(db, 'supply.total_stake', PLAIN)).toBe(75_338_381.473);
    // the mint rule's first reading names the node and block the minted total and the epoch were read from
    expect(kv<{ anchor: { epoch: number; provider: string; height: number } }>(db, MINT_RULE_KV)).toMatchObject({ anchor: { epoch: 2715, provider: 'StakeAndRelax', height: HEAD } });

    // the bond listing, due on a first tick, is read from it on the head it and the indexer agree on, and its row names it
    expect(kv<BondListingRecord>(db, 'bond.listing')).toMatchObject({ completeAt: PLAIN, provider: 'StakeAndRelax', height: HEAD, remaining: 0 });
    expect(h['Namada RPC (bond listing)']).toMatchObject({ ok: true });
    expect(h['Namada RPC (bond listing)'].note).toContain('from StakeAndRelax');
  });
});
