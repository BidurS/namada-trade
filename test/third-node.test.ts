// Which Namada nodes a tick reads the chain from (config.ts NAMADA.rpcs, sources/namada.ts answeringRpcs).
//
// 1. Every node but one answering HTTP 502. On 2026-11-07 both nodes configured until then answered 502 for hours and
//    every Namada read of the live site failed with them: the epoch, the minted total, the four protocol balances and
//    the listings, each health row saying "upstream unavailable (HTTP 502)". With one more node listed, such a tick
//    reads the chain from the node whose status answers: every chain query goes to it, the nodes that are down cost
//    one status read each, and the indexer's latest block is the second answer the listing head needs beside it.
// 2. A node sitting at an old block while another is at the chain's head. A node can answer its status, say it is not
//    catching up, and be days behind: its answers are that old block's state. While any node's newest block is from
//    the last minutes, only such nodes are asked, wherever the one behind stands in the list.
// 3. No node's newest block from the last minutes (no block is being made): the answers are the newest there are, so
//    the nodes are asked in their listed order, as before.
//
// The tests name no node and count none: they hold for whichever nodes the list holds, as long as it holds two.
// The real runCron against the sqlite D1 stand-in and a stubbed network, the listings answered from the fixtures cut
// from real answers (test/fixtures/balance_listing.json, bonds_listing.json).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { runCron, MINT_RULE_KV, type BondListingRecord } from '../worker/src/cron';
import { NAMADA } from '../worker/src/config';
import { answeringRpcs, HEAD_MAX_AGE_MS, indexedRpcs, transferHeights } from '../worker/src/sources/namada';
import { toNam } from '../worker/src/util';
import { testD1, type TestD1 } from './d1-sqlite';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));
const BAL = fx('balance_listing.json');
const BONDS = fx('bonds_listing.json');
const u256 = (n: bigint) => { const b = new Uint8Array(32); let v = n; for (let i = 0; i < 32; i++) { b[i] = Number(v & 0xffn); v >>= 8n; } return btoa(String.fromCharCode(...b)); };
const u64 = (n: number) => btoa(String.fromCharCode(n & 0xff, (n >> 8) & 0xff, 0, 0, 0, 0, 0, 0));
const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });

const NODES = NAMADA.rpcs.map((r) => ({ provider: r.provider, host: new URL(r.url).host }));
/** The first and the last node of the list, whichever they are. */
const FIRST = NODES[0], LAST = NODES[NODES.length - 1];
const HEAD = 8_343_400;
const MIN = 60_000, DAY = 86_400_000;

/** What one node answers: its newest block, that block's time, and the state it answers queries from. */
interface NodeAnswers { height: number; blockTime: number; epoch: number; stakeBase: bigint }
const AT_HEAD = (blockTime: number): NodeAnswers => ({ height: HEAD, blockTime, epoch: 2715, stakeBase: 75_338_381_473_000n });
/** Days behind: an older block, an older epoch, another total stake. */
const BEHIND = (blockTime: number): NodeAnswers => ({ height: HEAD - 40_000, blockTime, epoch: 2680, stakeBase: 70_000_000_000_000n });

/** A node not named here answers HTTP 502 to every request, as on 2026-11-07; the indexer agrees with the head. */
function network(up: Record<string, NodeAnswers>) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const host = new URL(url).host;
    const node = up[host];
    if (NODES.some((n) => n.host === host) && !node) return new Response('<html><body><h1>502 Bad Gateway</h1></body></html>', { status: 502, headers: { 'content-type': 'text/html' } });
    if (node) {
      if (url.includes('/status')) return json({ result: { node_info: { network: NAMADA.chainId }, sync_info: { latest_block_height: String(node.height), latest_block_time: new Date(node.blockTime).toISOString(), catching_up: false, earliest_block_height: '1' } } });
      if (url.includes('abci_query')) {
        const path = decodeURIComponent((url.split('path=')[1] ?? '').split('&')[0]).replace(/^"|"$/g, '');
        // An address without a self-bond gets code 1 ("Cannot find bond"), as the real nodes answer.
        if (path.includes('/vp/pos/bond/')) return json({ result: { response: { code: 1, info: 'RPC error: Cannot find bond', value: null, height: '1' } } });
        const value = path.includes('/shell/epoch') ? u64(node.epoch)
          : path.includes('masp_epoch_multiplier') ? u64(4)
          : path.includes('/shell/prefix/') ? BAL.value
          : path.includes('/vp/pos/bonds_and_unbonds/to') ? BONDS.value
          : path.includes('delegations_at') ? null
          : path.includes('balance/minted') ? u256(BigInt(BAL.expected.minted))
          : u256(path.includes('total_stake') ? node.stakeBase : 1_000_000n);
        return json({ result: { response: { code: 0, value, height: String(node.height) } } });
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
/** The chain queries of a tick (everything but a status read), by the host they went to. */
const chainQueries = (calls: string[]) => calls.filter((u) => u.includes('abci_query') || u.includes('/blockchain') || u.includes('/block_results'));
const READS = ['Namada RPC (epoch)', 'Namada RPC (minted supply)', 'Namada RPC (PoS balance)', 'Namada RPC (IBC escrow)', 'Namada RPC (MASP balance)', 'Namada RPC (PGF balance)', 'Namada RPC (total stake)'];

describe('the nodes a tick reads the chain from', () => {
  it('the list holds at least two nodes, each with a name and an address of its own', () => {
    expect(NODES.length).toBeGreaterThanOrEqual(2);
    expect(new Set(NODES.map((n) => n.provider)).size).toBe(NODES.length);
    expect(new Set(NODES.map((n) => n.host)).size).toBe(NODES.length);
  });

  it('every node but one answering HTTP 502: the epoch, the minted total, the four protocol balances and the bond listing are read from the one that answers, and the health rows name it', async () => {
    const db = testD1();
    const calls = network({ [LAST.host]: AT_HEAD(PLAIN) });
    await virtualTick({ DB: db, KEPLR_KEY: 'k' }, PLAIN);

    // the node rows: the ones down with their status, the one up with its height
    const h = healthOf(db);
    for (const n of NODES.slice(0, -1)) {
      expect(h[`Namada RPC ${n.provider}`], n.provider).toMatchObject({ ok: false });
      expect(h[`Namada RPC ${n.provider}`].note, n.provider).toMatch(/HTTP 502/);
    }
    expect(h[`Namada RPC ${LAST.provider}`]).toMatchObject({ ok: true, note: `height ${HEAD}` });
    // the reads that failed on 2026-11-07, each ok
    for (const name of READS) expect(h[name], name).toMatchObject({ ok: true });

    // every chain query of the tick went to the node whose status answered; the ones down were asked their status only
    const queries = chainQueries(calls);
    expect(queries.length).toBeGreaterThan(5);
    expect(queries.filter((u) => new URL(u).host !== LAST.host)).toEqual([]);
    for (const n of NODES.slice(0, -1)) {
      const asked = calls.filter((u) => new URL(u).host === n.host);
      expect(asked.length, n.host).toBeGreaterThan(0);
      expect(asked.filter((u) => !u.endsWith('/status')), n.host).toEqual([]);
    }

    // the figures, stored at the tick from the chain's values: none missing, none 0 for a value the node gave
    expect(metric(db, 'supply.total', PLAIN)).toBe(toNam(BigInt(BAL.expected.minted)));
    for (const key of ['supply.pos_bonded', 'supply.ibc_escrow', 'supply.masp_shielded', 'supply.pgf']) expect(metric(db, key, PLAIN), key).toBe(1);
    expect(metric(db, 'supply.total_stake', PLAIN)).toBe(75_338_381.473);
    // the mint rule's first reading names the node and block the minted total and the epoch were read from
    expect(kv<{ anchor: { epoch: number; provider: string; height: number } }>(db, MINT_RULE_KV)).toMatchObject({ anchor: { epoch: 2715, provider: LAST.provider, height: HEAD } });

    // the bond listing, due on a first tick, is read from it on the head it and the indexer agree on, and its row names it
    expect(kv<BondListingRecord>(db, 'bond.listing')).toMatchObject({ completeAt: PLAIN, provider: LAST.provider, height: HEAD, remaining: 0 });
    expect(h['Namada RPC (bond listing)']).toMatchObject({ ok: true });
    expect(h['Namada RPC (bond listing)'].note).toContain(`from ${LAST.provider}`);
  });

  it('the first node in line sitting at an old block while another is at the head: nothing is read from the one behind', async () => {
    const db = testD1();
    // the first node answers its status, says it is not catching up, and its newest block is nine days old
    const calls = network({ [FIRST.host]: BEHIND(PLAIN - 9 * DAY), [LAST.host]: AT_HEAD(PLAIN - 20_000) });
    await virtualTick({ DB: db, KEPLR_KEY: 'k' }, PLAIN);

    // its status answered, so its row is ok and says where it stands; it was asked nothing else
    const h = healthOf(db);
    expect(h[`Namada RPC ${FIRST.provider}`]).toMatchObject({ ok: true, note: `height ${HEAD - 40_000}` });
    const queries = chainQueries(calls);
    expect(queries.length).toBeGreaterThan(5);
    expect(queries.filter((u) => new URL(u).host !== LAST.host)).toEqual([]);

    // every figure of the tick is the head's, never the old block's under this tick's time
    for (const name of READS) expect(h[name], name).toMatchObject({ ok: true });
    expect(metric(db, 'supply.total_stake', PLAIN)).toBe(75_338_381.473);
    expect(kv<{ anchor: { epoch: number; provider: string; height: number } }>(db, MINT_RULE_KV)).toMatchObject({ anchor: { epoch: 2715, provider: LAST.provider, height: HEAD } });
    expect(kv<BondListingRecord>(db, 'bond.listing')).toMatchObject({ completeAt: PLAIN, provider: LAST.provider, height: HEAD });
  });

  it('no node at a block from the last minutes: the nodes are asked in their listed order, as before', async () => {
    const db = testD1();
    // both answering nodes stand at the same block, made hours ago: there is no newer answer to prefer
    const old = PLAIN - 6 * 60 * MIN;
    const calls = network({ [FIRST.host]: { ...AT_HEAD(old), stakeBase: 75_338_381_473_000n }, [LAST.host]: AT_HEAD(old) });
    await virtualTick({ DB: db, KEPLR_KEY: 'k' }, PLAIN);

    const h = healthOf(db);
    for (const name of READS) expect(h[name], name).toMatchObject({ ok: true });
    // the first in line is asked first, so the single reads are its answers
    const queries = chainQueries(calls);
    expect(queries.length).toBeGreaterThan(5);
    expect(queries.filter((u) => new URL(u).host === FIRST.host).length).toBeGreaterThan(5);
    expect(metric(db, 'supply.total_stake', PLAIN)).toBe(75_338_381.473);
    expect(kv<{ anchor: { provider: string } }>(db, MINT_RULE_KV)).toMatchObject({ anchor: { provider: FIRST.provider } });
    // and a listing is not applied on a head no answer vouches for as current: its row says why
    expect(h['Namada RPC (bond listing)']).toMatchObject({ ok: false });
    expect(h['Namada RPC (bond listing)'].note).toMatch(/^Not read this tick: no two answers agree on the head/);
  });
});

describe('answeringRpcs: which nodes are asked, from their status answers', () => {
  const NOW = PLAIN;
  const st = (provider: string, over: object = {}) => ({ provider, height: HEAD, time: NOW - 10_000, catchingUp: false, network: NAMADA.chainId, ...over });
  const names = (l: readonly { provider: string }[]) => l.map((r) => r.provider);
  const ALL = NODES.map((n) => n.provider);

  it('all at a block from the last minutes: all of them, in the listed order', () => {
    expect(names(answeringRpcs(NODES.map((n) => st(n.provider)), NOW))).toEqual(ALL);
  });

  it('one at such a block and the first in line at an old one: only the one that is', () => {
    const statuses = NODES.map((n, i) => (i === 0 ? st(n.provider, { time: NOW - HEAD_MAX_AGE_MS - 1 }) : i === NODES.length - 1 ? st(n.provider) : { provider: n.provider, error: 'down' }));
    expect(names(answeringRpcs(statuses, NOW))).toEqual([LAST.provider]);
    // just inside the age, the first is one of them
    const inside = NODES.map((n, i) => (i === 0 ? st(n.provider, { time: NOW - HEAD_MAX_AGE_MS + 1_000 }) : i === NODES.length - 1 ? st(n.provider) : { provider: n.provider, error: 'down' }));
    expect(names(answeringRpcs(inside, NOW))).toEqual(NODES.length > 1 ? [...new Set([FIRST.provider, LAST.provider])] : [FIRST.provider]);
  });

  it('none at such a block: every node that answers, as without a time', () => {
    const stale = NODES.map((n) => st(n.provider, { time: NOW - 9 * DAY }));
    expect(names(answeringRpcs(stale, NOW))).toEqual(ALL);
    expect(names(answeringRpcs(stale))).toEqual(ALL);
    // a block time that is no time, or one from the future, is not a block from the last minutes
    expect(names(answeringRpcs(NODES.map((n, i) => st(n.provider, { time: i === 0 ? Number.NaN : NOW + 10 * MIN })), NOW))).toEqual(ALL);
  });

  it('a node that is catching up or names another chain is not asked, however new its block', () => {
    const statuses = NODES.map((n, i) => (i === 0 ? st(n.provider, { catchingUp: true }) : i === NODES.length - 1 ? st(n.provider) : st(n.provider, { network: 'another-chain' })));
    expect(names(answeringRpcs(statuses, NOW))).toEqual([LAST.provider]);
  });
});

describe('a node without an event index (Rpc.indexed false)', () => {
  const WITH = { provider: 'with an index', url: 'https://with-index.example' };
  const WITHOUT = { provider: 'without one', url: 'https://without-index.example', indexed: false };

  it('indexedRpcs keeps every node not marked, in order', () => {
    expect(indexedRpcs([WITHOUT, WITH, { ...WITH, provider: 'marked true', indexed: true }]).map((r) => r.provider)).toEqual(['with an index', 'marked true']);
    // no node of today's list is left out by it unless it is marked
    expect(indexedRpcs(NAMADA.rpcs)).toEqual(NAMADA.rpcs.filter((r) => (r as { indexed?: boolean }).indexed !== false));
  });

  it('is never asked for a search of the index, wherever it stands in the list; with no indexed node the search fails, it does not answer an empty page', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return json({ result: { total_count: '0', blocks: [] } });
    }));
    const r = await transferHeights(1, 9, 1, 100, [WITHOUT, WITH]);
    expect(r).toMatchObject({ total: 0, blocks: [] });
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => u.startsWith(WITH.url))).toBe(true);
    await expect(transferHeights(1, 9, 1, 100, [WITHOUT])).rejects.toThrow();
    expect(urls.some((u) => u.startsWith(WITHOUT.url))).toBe(false);
  });

  it('the history scan reads where the index starts only on the nodes that have one', () => {
    const src = readFileSync(new URL('../scripts/backfill-namada.ts', import.meta.url), 'utf8');
    expect(src).toContain('const floors = await Promise.all(indexedRpcs(NAMADA.rpcs).map(async (r) => {');
  });
});
