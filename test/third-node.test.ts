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
import { answeringRpcs, HEAD_MAX_AGE_MS, indexedRpcs, namTotalStake, NO_NODE_AT_HEAD, READ_MAX_SLOW_NODES, transferHeights } from '../worker/src/sources/namada';
import { blocksSeenKv, resetBlocksSeenMemory } from '../worker/src/blocks-seen';
import { HALT } from '../shared/halt';
import { toNam } from '../worker/src/util';
import { testD1, type TestD1 } from './d1-sqlite';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); resetBlocksSeenMemory(); });

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
/** Behind: an older block and an older epoch, with a total stake that is simply another number (an arbitrary one), so a figure read from it is told apart. */
const BEHIND = (blockTime: number): NodeAnswers => ({ height: HEAD - 40_000, blockTime, epoch: 2680, stakeBase: 12_345_678_000_000n });

/** A node not named here answers HTTP 502 to every request, as on 2026-11-07; the indexer agrees with the head. */
/**
 * `posts`: every post to Discord or Telegram, with its body (both are taken). `o.queriesFail`: nodes that answer their
 * status and refuse every query at once (HTTP 502). `o.indexer`: the indexer's newest block (default HEAD - 10).
 */
function network(up: Record<string, NodeAnswers>, posts: { url: string; body: any }[] = [], o: { queriesFail?: Set<string>; indexer?: number } = {}) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const host = new URL(url).host;
    // a post to Discord is taken, and kept with its body for the tests that look at what left
    if (host === 'discord.com') { posts.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null }); return new Response(null, { status: 204 }); }
    if (host === 'api.telegram.org') { posts.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null }); return json({ ok: true, result: {} }); }
    const node = up[host];
    if (NODES.some((n) => n.host === host) && !node) return new Response('<html><body><h1>502 Bad Gateway</h1></body></html>', { status: 502, headers: { 'content-type': 'text/html' } });
    if (node) {
      if (url.includes('/status')) return json({ result: { node_info: { network: NAMADA.chainId }, sync_info: { latest_block_height: String(node.height), latest_block_time: new Date(node.blockTime).toISOString(), catching_up: false, earliest_block_height: '1' } } });
      if (url.includes('abci_query') && o.queriesFail?.has(host)) return new Response('<html>502 Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } });
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
    if (url.includes('indexer.namada.net') && url.includes('/chain/block/latest')) return json({ block: String(o.indexer ?? HEAD - 10) });
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
    // the first node answers its status, says it is not catching up, and its newest block is days old (an arbitrary number of them)
    const calls = network({ [FIRST.host]: BEHIND(PLAIN - 3 * DAY), [LAST.host]: AT_HEAD(PLAIN - 20_000) });
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

  it('the day\'s own chain reads, made in the first minutes of an hour, ask the same nodes: nothing is read from the one behind there either', async () => {
    const db = testD1();
    // 23:13:05 UTC: inside the hourly window in which the daily job reads the shielded pool's running total of rewards
    const IN_WINDOW = Date.parse('2026-11-07T23:13:05Z');
    const calls = network({ [FIRST.host]: BEHIND(IN_WINDOW - 3 * DAY), [LAST.host]: AT_HEAD(IN_WINDOW - 20_000) });
    await virtualTick({ DB: db, KEPLR_KEY: 'k' }, IN_WINDOW);
    // the read was made this tick, of the node at the head
    const rewards = calls.filter((u) => decodeURIComponent(u).includes('max_total_rewards'));
    expect(rewards.length).toBeGreaterThan(0);
    expect(rewards.every((u) => new URL(u).host === LAST.host)).toBe(true);
    // and the node behind was asked its status and nothing else, the whole tick
    const behind = calls.filter((u) => new URL(u).host === FIRST.host);
    expect(behind.length).toBeGreaterThan(0);
    expect(behind.filter((u) => !u.endsWith('/status'))).toEqual([]);
  });

  it('no node at a block from the last minutes: the nodes are asked in their listed order, as before', async () => {
    const db = testD1();
    // both answering nodes stand at the same block, made hours ago: there is no newer answer to prefer. The last
    // node's total stake is another number here, so the figure stored says which node the read was made of.
    const old = PLAIN - 6 * 60 * MIN;
    const calls = network({ [FIRST.host]: AT_HEAD(old), [LAST.host]: { ...AT_HEAD(old), stakeBase: 12_345_678_000_000n } });
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

describe('the live scan\'s row in a tick: the newest scanned block is read beside the scan\'s notes', () => {
  const NAME = 'Namada RPC (live block scan)';
  const note = { height: HEAD - 5, at: PLAIN - 10 * MIN, note: `${NO_NODE_AT_HEAD} (a node: no answer)`, kind: 'head' };
  const seed = (db: TestD1, scannedAt: number | null) => {
    db.raw.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('namada.scan', ?, 0)").run(JSON.stringify({ failures: [note] }));
    if (scannedAt != null) db.raw.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('namada.scanned', ?, 0)").run(JSON.stringify({ height: HEAD, ts: scannedAt, at: scannedAt }));
  };

  it('a block scanned after the note: the row is ok and names the block', async () => {
    const db = testD1();
    seed(db, PLAIN - 2 * MIN);
    network({ [LAST.host]: AT_HEAD(PLAIN) });
    await virtualTick({ DB: db, KEPLR_KEY: 'k' }, PLAIN);
    expect(healthOf(db)[NAME]).toMatchObject({ ok: true, note: `block ${HEAD} scanned after the last note about the chain's head (22:31 UTC)` });
  });

  it('no block scanned since: the row is the note', async () => {
    for (const scannedAt of [null, PLAIN - 30 * MIN]) {
      const db = testD1();
      seed(db, scannedAt);
      network({ [LAST.host]: AT_HEAD(PLAIN) });
      await virtualTick({ DB: db, KEPLR_KEY: 'k' }, PLAIN);
      expect(healthOf(db)[NAME], String(scannedAt)).toMatchObject({ ok: false, note: note.note });
    }
  });
});

describe('a paused Worker that sees blocks being made: one line to the operator, and nothing else leaves', () => {
  const HOOK = 'https://discord.com/api/webhooks/7/operator';
  const PAUSE = 'a pause';
  const paused = (db: TestD1, over: object = {}) => ({ DB: db, KEPLR_KEY: 'k', SEND_ALERTS: 'yes', ALERTS_PAUSED: PAUSE, DISCORD_WEBHOOK_URL: HOOK, ...over });
  const outward = (calls: string[]) => calls.filter((u) => /discord\.com|telegram\.org|twitter\.com|api\.x\.com/.test(new URL(u).host));
  const record = (db: TestD1, pause = PAUSE) => kv<{ before?: number; tries?: number; toldAt?: number | null }>(db, blocksSeenKv(pause));
  /** The ticks before blocks were made again: every node at the same old block, so the height they stand at is kept. */
  const stood = async (db: TestD1, env: object, at = PLAIN - 5 * MIN) => {
    network({ [FIRST.host]: AT_HEAD(at - 3 * DAY), [LAST.host]: AT_HEAD(at - 3 * DAY) });
    await virtualTick(env, at);
  };

  it('every node at an old block: nothing is posted, and the height they stand at is kept', async () => {
    const db = testD1();
    const posts: { url: string; body: any }[] = [];
    const calls = network({ [FIRST.host]: AT_HEAD(PLAIN - 3 * DAY), [LAST.host]: AT_HEAD(PLAIN - 3 * DAY) }, posts);
    await virtualTick(paused(db), PLAIN);
    expect(posts).toEqual([]);
    expect(outward(calls)).toEqual([]);
    expect(record(db)).toEqual({ before: HEAD });
  });

  it('two nodes with blocks from the last minutes: the line is posted once, in the first such tick, and never again', async () => {
    const db = testD1();
    const posts: { url: string; body: any }[] = [];
    const calls = network({ [FIRST.host]: AT_HEAD(PLAIN - 20_000), [LAST.host]: AT_HEAD(PLAIN - 30_000) }, posts);
    await virtualTick(paused(db), PLAIN);
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe(HOOK);
    expect(posts[0].body.content).toBe(`Namada nodes report new blocks: block ${HEAD.toLocaleString('en-US')}, made 2026-11-07 22:40 UTC, read on 2 nodes. The halt bar and the alert pause on this site are still on.`);
    expect(posts[0].body.allowed_mentions).toEqual({ parse: [] });
    // nothing else left the Worker for Discord, Telegram or X: no alert, no digest, no other operator message
    expect(outward(calls)).toEqual([HOOK]);

    const again = network({ [FIRST.host]: AT_HEAD(PLAIN + MIN - 20_000), [LAST.host]: AT_HEAD(PLAIN + MIN - 20_000) }, posts);
    await virtualTick(paused(db), PLAIN + MIN);
    expect(posts).toHaveLength(1);
    expect(outward(again)).toEqual([]);
  });

  it('one node with a new block: the line only when the indexer is past the height the nodes stood at, and it says so', async () => {
    const db = testD1();
    await stood(db, paused(db));
    expect(record(db)?.before).toBe(HEAD);
    const posts: { url: string; body: any }[] = [];
    // one node at a new block, the other still at the old one, the indexer still at the old height: one witness
    const a = network({ [FIRST.host]: AT_HEAD(PLAIN - 3 * DAY), [LAST.host]: { ...AT_HEAD(PLAIN - 20_000), height: HEAD + 5 } }, posts, { indexer: HEAD });
    await virtualTick(paused(db), PLAIN);
    expect(posts).toEqual([]);
    expect(outward(a)).toEqual([]);
    // the indexer has passed it: two witnesses
    network({ [FIRST.host]: AT_HEAD(PLAIN - 3 * DAY), [LAST.host]: { ...AT_HEAD(PLAIN + MIN - 20_000), height: HEAD + 12 } }, posts, { indexer: HEAD + 3 });
    await virtualTick(paused(db), PLAIN + MIN);
    expect(posts.map((p) => p.body.content)).toEqual([`A Namada node reports new blocks: block ${(HEAD + 12).toLocaleString('en-US')}, made 2026-11-07 22:41 UTC, read on 1 node and the network indexer. The halt bar and the alert pause on this site are still on.`]);
  });

  it('with the settings production has (the pause\'s own name, the owner\'s chat, the channel, X): only the operator\'s webhook and the owner\'s chat are posted to', async () => {
    const db = testD1();
    // what production holds: the pause's notice already taken on Discord, and X switched off
    db.raw.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, 0)').run(`halt:${HALT.id}:discord:1`, JSON.stringify({ ok: true, status: 204, at: 1 }));
    db.raw.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('x.on', '0', 0)").run();
    const env = paused(db, {
      ALERTS_PAUSED: HALT.id, TELEGRAM_BOT_TOKEN: 'bot-token', TELEGRAM_OWNER_CHAT: '4242', TELEGRAM_CHANNEL: '@a-channel',
      X_API_KEY: 'x', X_API_SECRET: 'x', X_ACCESS_TOKEN: 'x', X_ACCESS_SECRET: 'x',
    });
    const posts: { url: string; body: any }[] = [];
    const calls = network({ [FIRST.host]: AT_HEAD(PLAIN - 20_000), [LAST.host]: AT_HEAD(PLAIN - 20_000) }, posts);
    await virtualTick(env, PLAIN);
    expect(outward(calls)).toEqual([HOOK, 'https://api.telegram.org/botbot-token/sendMessage']);
    expect(posts[1].body.chat_id).toBe('4242');
    expect(posts.every((p) => String(p.body?.content ?? p.body?.text ?? '').includes('report new blocks'))).toBe(true);
    expect(record(db, HALT.id)).toMatchObject({ tries: 1, toldAt: PLAIN });
  });

  it('a Worker that is not paused posts no such line', async () => {
    const db = testD1();
    const posts: { url: string; body: any }[] = [];
    network({ [FIRST.host]: AT_HEAD(PLAIN - 20_000), [LAST.host]: AT_HEAD(PLAIN - 20_000) }, posts);
    await virtualTick({ DB: db, KEPLR_KEY: 'k', SEND_ALERTS: 'yes', DISCORD_WEBHOOK_URL: HOOK }, PLAIN);
    expect(posts.filter((p) => String(p.body?.content ?? '').includes('report new blocks'))).toEqual([]);
    expect(record(db)).toBeNull();
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
    const stale = NODES.map((n) => st(n.provider, { time: NOW - 3 * DAY }));
    expect(names(answeringRpcs(stale, NOW))).toEqual(ALL);
    expect(names(answeringRpcs(stale))).toEqual(ALL);
    // a block time that is no time, or one from the future, is not a block from the last minutes
    expect(names(answeringRpcs(NODES.map((n, i) => st(n.provider, { time: i === 0 ? Number.NaN : NOW + 10 * MIN })), NOW))).toEqual(ALL);
  });

  it('a block from the last minutes seen only on a node that is catching up, the others at an older block: no node is asked that tick', () => {
    const statuses = NODES.map((n, i) => (i === 0 ? st(n.provider, { catchingUp: true }) : st(n.provider, { time: NOW - 3 * DAY })));
    expect(answeringRpcs(statuses, NOW)).toEqual([]);
    // with no node that would be asked, the list is as before: a node that is catching up is better than none
    expect(names(answeringRpcs(NODES.map((n) => st(n.provider, { catchingUp: true })), NOW))).toEqual(ALL);
    // and a recent block on a node of another chain says nothing about this one
    const other = NODES.map((n, i) => (i === 0 ? st(n.provider, { network: 'another-chain' }) : st(n.provider, { time: NOW - 3 * DAY })));
    expect(names(answeringRpcs(other, NOW))).toEqual(ALL.slice(1));
  });

  it('a node that is catching up or names another chain is not asked, however new its block', () => {
    const statuses = NODES.map((n, i) => (i === 0 ? st(n.provider, { catchingUp: true }) : i === NODES.length - 1 ? st(n.provider) : st(n.provider, { network: 'another-chain' })));
    expect(names(answeringRpcs(statuses, NOW))).toEqual([LAST.provider]);
  });
});

describe('how many nodes one read asks', () => {
  const many = ['a', 'b', 'c', 'd', 'e'].map((x) => ({ provider: x, url: `https://node-${x}.example` }));
  const host = (r: { url: string }) => new URL(r.url).host;

  it('every node, in order, when the first ones refuse at once: the last node of a longer list is reached', async () => {
    const asked: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const h = new URL(String(input)).host;
      asked.push(h);
      return h === 'node-e.example' ? json({ result: { response: { code: 0, value: u256(75_338_381_473_000n), height: '1' } } }) : new Response('down', { status: 502 });
    }));
    await expect(namTotalStake({ rpcs: many, retries: 0, timeoutMs: 1000 })).resolves.toMatchObject({ provider: 'e' });
    expect(asked).toEqual(many.map(host));
  });

  it('at most READ_MAX_SLOW_NODES nodes that hang: a read that hangs on every node takes that many timeouts, however many nodes the list holds', async () => {
    const asked: string[] = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      asked.push(new URL(String(input)).host);
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    }));
    await expect(namTotalStake({ rpcs: many, retries: 0, timeoutMs: 60 })).rejects.toThrow();
    expect(asked).toEqual(many.slice(0, READ_MAX_SLOW_NODES).map(host));
  });

  it('a tick whose first nodes answer their status and refuse every query at once: its first reads reach the last node, and the figures are read', async () => {
    const db = testD1();
    const up = Object.fromEntries(NODES.map((n) => [n.host, AT_HEAD(PLAIN - 20_000)]));
    network(up, [], { queriesFail: new Set(NODES.slice(0, -1).map((n) => n.host)) });
    await virtualTick({ DB: db, KEPLR_KEY: 'k' }, PLAIN);
    const h = healthOf(db);
    for (const name of READS) expect(h[name], name).toMatchObject({ ok: true });
    expect(metric(db, 'supply.total_stake', PLAIN)).toBe(75_338_381.473);
    expect(kv<{ anchor: { provider: string } }>(db, MINT_RULE_KV)).toMatchObject({ anchor: { provider: LAST.provider } });
  });
});

describe('a node without an event index (Rpc.indexed false)', () => {
  const WITH = { provider: 'with an index', url: 'https://with-index.example' };
  const WITHOUT = { provider: 'without one', url: 'https://without-index.example', indexed: false };

  it('indexedRpcs keeps every node not marked, in order', () => {
    expect(indexedRpcs([WITHOUT, WITH, { ...WITH, provider: 'marked true', indexed: true }]).map((r) => r.provider)).toEqual(['with an index', 'marked true']);
    // the list always keeps a node to search: the history scan cannot run on a list with none
    expect(indexedRpcs(NAMADA.rpcs).length).toBeGreaterThan(0);
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
