// Review rev2-alerts (fix3-alerts): an Osmosis stream transaction whose failed write left rows stored is still read
// again by the catch-up search, written whole and alerted once; a bridge crossing's per-channel claims, when a later
// claim batch fails, never re-open the channels D1 already refused.
//
// Before: the stream wrote a transaction in runBatch's 80-statement batches, each committed on its own, so a write
// that failed on its second batch left every flow and some moves stored; a D1 batch can also commit and lose its
// answer. Either way the stream threw before alerting, and the catch-up search skipped the hash because rows of it
// were in `flows`: the whale was never posted, and the moves after the first batch were lost for good.
// claimEach, when a claim batch after the first threw, returned every key as claimed, including those D1 had refused
// in the first batch, so a crossing's second record was posted again to channels that had heard of it.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { base64 } from '@scure/base';
import { testD1 } from './d1-sqlite';
import { saveSettings, defaultPrefs, type StoredSettings } from '../worker/src/settings';
import { NAM } from '../worker/src/config';
import type { Flow } from '../shared/types';

// LiveHub is a Durable Object; only its Osmosis stream and catch-up search are exercised here, on an instance made
// without its constructor (which would open sockets and fetch prices).
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import { LiveHub } from '../worker/src/live-hub';

afterEach(() => vi.unstubAllGlobals());
const fx = (n: string) => JSON.parse(readFileSync(join(__dirname, 'fixtures', n), 'utf8'));

describe('an Osmosis stream transaction whose failed write left rows stored is written whole and alerted once', () => {
  const OP = 'https://discord.com/api/webhooks/201/op';
  /** A bank send of `nam` NAM between two Osmosis accounts (one flow, two moves, no address link). */
  const transfer = (i: number, nam: number) => ({
    type: 'transfer',
    attributes: [{ key: 'recipient', value: `osmo1r2recv${i}` }, { key: 'sender', value: `osmo1r2send${i}` }, { key: 'amount', value: `${nam * 1e6}${NAM.osmoDenom}` }, { key: 'msg_index', value: '0' }],
  });
  /**
   * The real crossing test/fixtures/osmo_ibc_recv.json (1 NAM, sequence 8548) read as `nam` NAM in packet `seq`: one
   * flow, three moves, one address link (each test its own packet: the crossing claims' memory lock lives for the file).
   */
  const ibcReceive = (nam: number, seq: string) => fx('osmo_ibc_recv.json')[0].tx_result.events.map((e: any) => ({
    ...e,
    attributes: e.attributes.map((a: any) => {
      if (e.type === 'recv_packet' && a.key === 'packet_sequence') return { ...a, value: seq };
      if (a.key === 'amount' && a.value === '1000000') return { ...a, value: String(nam * 1e6) };
      if (a.key === 'amount' && a.value === `1000000${NAM.osmoDenom}`) return { ...a, value: `${nam * 1e6}${NAM.osmoDenom}` };
      if (a.key === 'packet_data') return { ...a, value: a.value.split('"1000000"').join(`"${nam * 1e6}"`) };
      return a;
    }),
  }));

  /**
   * The hub over a D1 stand-in whose batch call number n fails as `fail[n]` says ('lost': nothing written; 'committed':
   * written, then the answer lost), the Osmosis node stubbed, and the stream's message for transaction `hash` at
   * height 100 (its own per test: the alert claims' memory lock lives for the file). The cursor starts at 50.
   */
  async function setup(hash: string, events: any[], fail: Record<number, 'lost' | 'committed'>) {
    const msg = { result: { data: { value: { TxResult: { height: '100', result: { code: 0, events } } } }, events: { 'tx.hash': [hash] } } };
    const real = testD1();
    let n = 0;
    const db: any = {
      prepare: (s: string) => real.prepare(s),
      batch: async (st: any[]) => {
        const how = fail[++n];
        if (how === 'committed') await real.batch(st);
        if (how) throw new Error('D1_ERROR: Network connection lost.');
        return real.batch(st);
      },
    };
    const posts: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => {
      const url = String(u);
      if (url.includes('discord.com')) { posts.push(JSON.parse(String(init?.body ?? '{}'))); return new Response(null, { status: 204 }); }
      if (url.endsWith('/status')) return Response.json({ result: { sync_info: { latest_block_height: '200' } } });
      if (url.includes('/tx_search')) return Response.json({ result: { txs: [{ hash, height: '100', tx_result: { code: 0, events } }] } });
      if (url.includes('/block?height=')) return Response.json({ result: { block: { header: { time: new Date().toISOString() } } } });
      throw new Error(`unexpected ${url}`);
    }));
    const hub: any = Object.assign(Object.create(LiveHub.prototype), {
      env: { DB: db, DISCORD_WEBHOOK_URL: OP },
      seenOsmoTx: new Set<string>(), osmoRetryTx: new Set<string>(), osmoRetryFrom: null, osmoRetryGen: 0, osmoHeight: 0, sessions: new Set(), lastPriceUsd: null,
      osmoCtx: { poolAddrs: new Map(), priceUsd: null, assets: new Map() },
    });
    await real.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('osmosis.cursor', ?, 0)").bind(JSON.stringify({ height: 50, at: 0 })).run();
    const count = (table: string) => real.raw.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE tx_hash = ?`).get(hash.toUpperCase()).n as number;
    const flowClaims = () => real.raw.prepare("SELECT COUNT(*) AS n FROM kv WHERE key LIKE ?").get(`alert:flow:osmosis:${hash.toUpperCase()}:%`).n as number;
    const cursor = () => JSON.parse(real.raw.prepare("SELECT value FROM kv WHERE key='osmosis.cursor'").get().value).height as number;
    return { real, hub, msg, posts, count, flowClaims, cursor };
  }

  it('30 transfers of 20,000 NAM whose write fails on its second batch: every row is stored and each whale posted once', async () => {
    // the reviewer's case: 30 flows and 60 moves are 90 statements, more than one 80-statement batch
    const { hub, msg, posts, count, flowClaims, cursor } = await setup('r2a001', Array.from({ length: 30 }, (_, i) => transfer(i, 20_000)), { 2: 'lost' });
    await hub.handleOsmosisMessage(msg).catch(() => {});
    await hub.sweepOsmosis();
    expect(count('flows')).toBe(30);
    expect(count('moves')).toBe(60);
    expect(posts).toHaveLength(30);
    expect(new Set(posts.map((p) => p.embeds[0].title))).toEqual(new Set(['🐋 Flow [TRANSFER]: 20,000 NAM']));
    expect(flowClaims()).toBe(30);
    expect(cursor()).toBe(200);
    expect(hub.osmoRetryFrom).toBeNull();
  });

  it('one 1,000,000 NAM transfer whose write committed and then threw: the next search alerts it as found late', async () => {
    const { hub, msg, posts, count, cursor } = await setup('r2b001', [transfer(0, 1_000_000)], { 1: 'committed' });
    await expect(hub.handleOsmosisMessage(msg)).rejects.toThrow(/D1_ERROR/);
    expect(count('flows')).toBe(1);
    expect(posts).toHaveLength(0);
    await hub.sweepOsmosis();
    expect(count('flows')).toBe(1);
    expect(count('moves')).toBe(2);
    expect(posts).toHaveLength(1);
    expect(posts[0].embeds[0].title).toBe('🐋 Flow [TRANSFER]: 1,000,000 NAM');
    expect(posts[0].embeds[0].fields.some((f: any) => f.name === 'Found late')).toBe(true);
    expect(cursor()).toBe(200);
    expect(hub.osmoRetryFrom).toBeNull();
    expect(hub.osmoRetryTx.size).toBe(0);
    // a later search posts nothing more
    await hub.sweepOsmosis();
    expect(posts).toHaveLength(1);
  });

  it('30 transfers whose write committed and then threw: all 60 moves are stored and each whale posted once', async () => {
    const { hub, msg, posts, count, flowClaims } = await setup('r2c001', Array.from({ length: 30 }, (_, i) => transfer(i, 20_000)), { 1: 'committed' });
    await expect(hub.handleOsmosisMessage(msg)).rejects.toThrow(/D1_ERROR/);
    await hub.sweepOsmosis();
    expect(count('flows')).toBe(30);
    expect(count('moves')).toBe(60);
    expect(posts).toHaveLength(30);
    expect(flowClaims()).toBe(30);
    expect(hub.osmoRetryFrom).toBeNull();
  });

  it('a 30,000 NAM bridge receive whose write committed and then threw is alerted, and its address link counted once', async () => {
    const { real, hub, msg, posts, count } = await setup('r2d001', ibcReceive(30_000, '20401'), { 1: 'committed' });
    const link = () => real.raw.prepare('SELECT transfers, volume_num FROM address_links WHERE osmo_addr = ? AND namada_addr = ?')
      .get('osmo137zwfeku64lzfg4laedyg628qnepqpgkahqyk3', 'tnam1qr4wemkpjfycn7ts7297e8qecg2t6pf2vq2wulsa');
    await expect(hub.handleOsmosisMessage(msg)).rejects.toThrow(/D1_ERROR/);
    expect({ ...link() }).toEqual({ transfers: 1, volume_num: 30_000 });
    await hub.sweepOsmosis();
    expect(count('flows')).toBe(1);
    expect(posts.map((p) => p.embeds[0].title)).toEqual(['🌉 IBC Bridge Namada → Osmosis: 30,000 NAM']);
    // the rows were all stored by the write that threw: the search alerts them without writing them again
    expect({ ...link() }).toEqual({ transfers: 1, volume_num: 30_000 });
  });

  it("another subscription's copy arriving after the write threw leaves it to the search: the link is counted once", async () => {
    const { real, hub, msg, posts } = await setup('r2e001', ibcReceive(30_000, '20501'), { 1: 'committed' });
    const link = () => real.raw.prepare('SELECT transfers FROM address_links WHERE osmo_addr = ?').get('osmo137zwfeku64lzfg4laedyg628qnepqpgkahqyk3').transfers;
    await expect(hub.handleOsmosisMessage(msg)).rejects.toThrow(/D1_ERROR/);
    await hub.handleOsmosisMessage(msg);
    expect(link()).toBe(1);
    await hub.sweepOsmosis();
    expect(link()).toBe(1);
    expect(posts).toHaveLength(1);
  });

  it("a search whose own write of it fails is not the end: the next search still alerts it", async () => {
    // the stream's write stores nothing; the first search's write commits and loses its answer
    const { hub, msg, posts, count } = await setup('r2f001', [transfer(0, 1_000_000)], { 1: 'lost', 2: 'committed' });
    await expect(hub.handleOsmosisMessage(msg)).rejects.toThrow(/D1_ERROR/);
    expect(count('flows')).toBe(0);
    await expect(hub.sweepOsmosis()).rejects.toThrow(/D1_ERROR/);
    expect(count('flows')).toBe(1);
    expect(posts).toHaveLength(0);
    await hub.sweepOsmosis();
    expect(count('moves')).toBe(2);
    expect(posts).toHaveLength(1);
    expect(hub.osmoRetryFrom).toBeNull();
  });
});

describe('a crossing claimed per channel: a later claim batch that fails never re-opens a channel D1 refused', () => {
  const KEY = base64.encode(new Uint8Array(32).fill(23));
  const NOW = Date.now();

  it('the receive of a 30,000 NAM crossing 91 channels heard of posts only to the channels of the batch that failed', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => { calls.push(String(u)); return new Response(null, { status: 204 }); }));
    const db = testD1();
    const OSMO = 'osmo1r2receiverxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    const TNAM = 'tnam1r2senderxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    // 90 subscribers watching the receiver, plus the operator: 91 channels, claimed in batches of 80 and 11
    for (let i = 0; i < 90; i++) {
      const s: StoredSettings = {
        address: `tnam1qr${String(i).padStart(3, '0')}${'q'.repeat(31)}`, notifications: { ...defaultPrefs(), watchlist: [OSMO] },
        channels: { discord: { enabled: true, webhookUrl: `https://discord.com/api/webhooks/2${i}/w` } }, createdAt: NOW, updatedAt: NOW + i,
      };
      await saveSettings(db as any, KEY, s);
    }
    const OP = 'https://discord.com/api/webhooks/op/r2';
    const base = { height: 1, ts: NOW, from: TNAM, to: OSMO, amount: 30_000 } as const;
    const send = { ...base, id: 'namada:R2SEND:ibc_out:0', chain: 'namada', txHash: 'R2SEND', kind: 'ibc_out', meta: { channel: NAM.namadaChannel, packetSequence: '2042' } } as Flow;
    const recv = { ...base, id: 'osmosis:R2RECV:ibc_in:0', chain: 'osmosis', txHash: 'R2RECV', kind: 'ibc_in', meta: { channel: NAM.osmoChannel, packetSequence: '2042' } } as Flow;

    // the Namada send reaches every channel
    vi.resetModules();
    const first = await import('../worker/src/sources/discord');
    first.configureAlerts(KEY);
    await first.sendDiscordWhaleAlert(OP, send, null, db as any, 10_000);
    expect(calls).toHaveLength(91);
    const heard = new Set(calls);

    // the Osmosis receive, in another isolate (no memory lock), its second claim batch failing
    vi.resetModules();
    const second = await import('../worker/src/sources/discord');
    second.configureAlerts(KEY);
    let n = 0;
    const realBatch = db.batch.bind(db);
    (db as any).batch = async (s: any[]) => { if (++n === 2) throw new Error('D1 transient'); return realBatch(s); };
    calls.length = 0;
    await second.sendDiscordWhaleAlert(OP, recv, null, db as any, 10_000);
    // the 80 channels D1 refused in the first batch (the operator's among them) hear nothing again; the 11 of the
    // batch that failed are unknown and count as claimed (a repeat post is better than a lost alert)
    expect(calls).not.toContain(OP);
    expect(calls).toHaveLength(11);
    expect(calls.every((u) => heard.has(u))).toBe(true);
  });
});
