// Every bridge channel and what each chain holds through it (docs/design/platform-plan.md, release B). The decoders
// are held to the chain's own bytes: test/fixtures/ibc_channels.json is the node's answer at block 8,517,986 (the
// channel listing, the connection listing and each client's state, as served on 2026-11-10), and to listings made
// here byte by byte for the cases the chain does not have today. The pass is run on a test database with its two
// readers replaced, so no test asks a node; the two readers themselves are run against a stubbed network.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { IBC_CHANNELS_MAX, IBC_CLIENT_READS_MAX, IBC_LISTING_MAX_BYTES, ibcChannels, parseIbcChannelList, parseIbcChannels, parseIbcConnections, parseIbcClientChain, type IbcChannel } from '../worker/src/sources/namada';
import {
  ACCOUNT_STALE_MS, BRIDGE_CHAINS, BRIDGES_KV, BRIDGE_HEALTH, CHANNELS_EVERY_MS, CHANNELS_MAX_ROWS, CHANNELS_RETRY_MS, HELD_EVERY_MS, HELD_STALE_MS,
  bridgeSums, bridgesAnswer, chainOf, listRefusal, osmosisRow, readHeld, readable, runBridges, voucherDenom,
} from '../worker/src/bridges';
import { kvGetJson, kvSet } from '../worker/src/db';
import { bridgeCheck, ibcConservation } from '../worker/src/cron';
import { STUCK_PACKETS_KV } from '../worker/src/ibc-stuck';
import { bridgeFacts } from '../worker/src/seo';
import { app } from '../worker/src/api';
import { NAM, NAMADA } from '../worker/src/config';
import { checkDetail, CHECK_TITLES } from '../web/src/lib/prov';
import { testD1, insert } from './d1-sqlite';
import type { BridgesRecord, BridgesResponse, Check, SourceHealth } from '../shared/types';

afterEach(() => { vi.unstubAllGlobals(); });

const FX = JSON.parse(readFileSync(new URL('./fixtures/ibc_channels.json', import.meta.url), 'utf8')) as {
  height: number; channels: string; connections: string; clientStates: Record<string, string>;
  expected: { channel: string; counterpartyChannel: string; connection: string; client: string; chainId: string }[];
};
const NOW = Date.UTC(2026, 10, 10, 6, 0);
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const raw = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));

// A listing made by hand, in the chain's own layout (checked against the fixture's first key below):
// borsh Vec<{ key: [the bridge account, text segments…], value: bytes }>, each value one protobuf message.
const cat = (...parts: (Uint8Array | number[])[]) => Uint8Array.from(parts.flatMap((p) => [...p]));
const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
const text = (s: string) => new TextEncoder().encode(s);
const seg = (s: string) => cat([1], u32(text(s).length), text(s));
const entry = (path: string[], value: Uint8Array) => cat(u32(path.length + 1), [0, 2, 3], ...path.map(seg), u32(value.length), value);
const listing = (entries: Uint8Array[]) => b64(cat(u32(entries.length), ...entries));
/** One length-delimited protobuf field (a length under 128). */
const pb = (f: number, body: Uint8Array | string) => { const b = typeof body === 'string' ? text(body) : body; return cat([(f << 3) | 2, b.length], b); };
const channelEnd = (o: { state?: number; port?: string; channel?: string; hops?: string[] }) => cat(
  [0x08, o.state ?? 3, 0x10, 1],
  o.port != null || o.channel != null ? pb(3, cat(o.port != null ? pb(1, o.port) : [], o.channel != null ? pb(2, o.channel) : [])) : [],
  ...(o.hops ?? ['connection-0']).map((h) => pb(4, h)),
);
const chanKey = (id: string) => ['channelEnds', 'ports', 'transfer', 'channels', id];
const one = (id: string, o: Parameters<typeof channelEnd>[0]) => entry(chanKey(id), channelEnd(o));
const TENDERMINT = '/ibc.lightclients.tendermint.v1.ClientState';
const clientState = (kind: string, chainId: string, between: number[] = []) => b64(cat(pb(1, kind), between, pb(2, pb(1, chainId))));

describe('the chain\'s channels, decoded from its own state', () => {
  it('reads all eight channels of the mainnet answer, each with the other side\'s channel and its connection', () => {
    const ends = parseIbcChannels(FX.channels);
    expect(ends.map((e) => e.channel)).toEqual(FX.expected.map((e) => e.channel));
    for (const [i, e] of ends.entries()) {
      expect(e).toMatchObject({ open: true, counterpartyPort: 'transfer', counterpartyChannel: FX.expected[i].counterpartyChannel, connection: FX.expected[i].connection });
    }
  });

  it('reads each connection\'s client and passes over the key that is not a connection', () => {
    const clientOf = parseIbcConnections(FX.connections);
    for (const e of FX.expected) expect(clientOf.get(e.connection)).toBe(e.client);
    expect([...clientOf.keys()].every((k) => /^connection-\d+$/.test(k))).toBe(true);
  });

  it('reads the chain each client follows', () => {
    for (const e of FX.expected) expect(parseIbcClientChain(FX.clientStates[e.client])).toBe(e.chainId);
  });

  it('refuses a cut answer, bytes left over and a key that is not a channel, and never reads past the end', () => {
    const whole = raw(FX.channels);
    for (const cut of [0, 3, 4, 40, whole.length - 1]) expect(() => parseIbcChannels(b64(whole.subarray(0, cut))), `cut at ${cut}`).toThrow();
    const extra = new Uint8Array(whole.length + 1); extra.set(whole);
    expect(() => parseIbcChannels(b64(extra))).toThrow(/unread/);
    // a count far larger than the answer could hold: it runs out of bytes, it does not allocate
    const huge = whole.slice(); huge[0] = 0xff; huge[1] = 0xff; huge[2] = 0xff; huge[3] = 0x7f;
    expect(() => parseIbcChannels(b64(huge))).toThrow();
    // the connection listing is not a channel listing
    expect(() => parseIbcChannels(FX.connections)).toThrow(/not a transfer channel's/);
    expect(() => parseIbcClientChain('')).toThrow();
    expect(() => parseIbcClientChain(b64(Uint8Array.of(0x12, 0x7f, 0x0a)))).toThrow();
  });

  it('a listing made here in the chain\'s layout is read as the chain\'s own is', () => {
    const first = FX.expected[0];
    const value = channelEnd({ port: 'transfer', channel: first.counterpartyChannel, hops: [first.connection] });
    const made = raw(listing([one(first.channel, { port: 'transfer', channel: first.counterpartyChannel, hops: [first.connection] })]));
    const chain = raw(FX.channels);
    // byte for byte the chain's first key, and the chain's first value as far as the fields this site reads (the
    // chain's goes on to the channel's version, so its length differs)
    const keyEnd = made.length - value.length - 4;
    expect([...made.subarray(4, keyEnd)]).toEqual([...chain.subarray(4, keyEnd)]);
    expect([...value]).toEqual([...chain.subarray(keyEnd + 4, keyEnd + 4 + value.length)]);
    expect(parseIbcChannels(b64(made))).toEqual([{ channel: first.channel, open: true, counterpartyPort: 'transfer', counterpartyChannel: first.counterpartyChannel, connection: first.connection }]);
  });

  it('passes over a channel whose handshake never finished, and lists one that is no longer open as not open', () => {
    const got = parseIbcChannels(listing([
      one('channel-0', { port: 'transfer', channel: 'channel-5' }),
      // started by anyone, never answered: it names the other side's port and no channel there
      one('channel-1', { state: 1, port: 'transfer' }),
      one('channel-2', { state: 4, port: 'transfer', channel: 'channel-9' }),
    ]));
    expect(got.map((c) => [c.channel, c.open])).toEqual([['channel-0', true], ['channel-2', false]]);
  });

  it('refuses an open channel that names no other side, a channel listed twice, and a listing too long to be one', () => {
    expect(() => parseIbcChannels(listing([one('channel-0', { port: 'transfer' })]))).toThrow(/open and names no channel/);
    const same = one('channel-0', { port: 'transfer', channel: 'channel-5' });
    expect(() => parseIbcChannels(listing([same, same]))).toThrow(/listed twice/);
    expect(() => parseIbcChannels(listing([entry(chanKey('not a channel'), channelEnd({ port: 'transfer', channel: 'channel-5' }))]))).toThrow(/not a transfer channel's/);
    const many = Array.from({ length: IBC_CHANNELS_MAX + 1 }, (_, i) => one(`channel-${i}`, { port: 'transfer', channel: `channel-${i}` }));
    expect(() => parseIbcChannels(listing(many))).toThrow(/more than this site reads/);
    expect(parseIbcChannels(listing(many.slice(0, IBC_CHANNELS_MAX)))).toHaveLength(IBC_CHANNELS_MAX);
    // an answer far longer than a listing is refused before it is walked
    expect(() => parseIbcChannels(b64(new Uint8Array(IBC_LISTING_MAX_BYTES + 1)))).toThrow(/more than this site reads/);
    expect(() => parseIbcConnections(b64(new Uint8Array(IBC_LISTING_MAX_BYTES + 1)))).toThrow(/more than this site reads/);
  });

  it('a channel whose other side is named in a form this site does not read is left out and counted, and costs the list nothing', () => {
    // the port and the channel are what the voucher's name is made from: nothing but the characters they may have
    const contract = `wasm.${'a'.repeat(63)}`;
    const got = parseIbcChannelList(listing([
      one('channel-0', { port: 'trans/fer', channel: 'channel-5' }),
      one('channel-1', { port: 'transfer', channel: 'channel-5/x' }),
      one('channel-2', { port: contract, channel: 'channel-7' }),
      one('channel-3', { port: 'transfer', channel: 'channel-9' }),
    ]));
    expect(got.passed).toBe(2);
    expect(got.ends.map((c) => [c.channel, c.counterpartyPort])).toEqual([['channel-2', contract], ['channel-3', 'transfer']]);
    // a channel left out is still a channel: listed twice is a malformed answer
    const odd = one('channel-0', { port: 'trans/fer', channel: 'channel-5' });
    expect(() => parseIbcChannelList(listing([odd, odd]))).toThrow(/listed twice/);
  });

  it('a channel over more than one connection, or none, is listed with no connection, so no chain is read for it', () => {
    const got = parseIbcChannels(listing([
      one('channel-0', { port: 'transfer', channel: 'channel-5', hops: ['connection-0', 'connection-1'] }),
      one('channel-1', { port: 'transfer', channel: 'channel-6', hops: [] }),
    ]));
    expect(got.map((c) => c.connection)).toEqual([null, null]);
  });

  it('a connection listed twice, or one that names no client, is a malformed answer', () => {
    const conn = (id: string, client: string) => entry(['connections', id], pb(1, client));
    expect(parseIbcConnections(listing([conn('connection-0', '07-tendermint-1'), entry(['connections', 'counter'], Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0))]))).toEqual(new Map([['connection-0', '07-tendermint-1']]));
    expect(() => parseIbcConnections(listing([conn('connection-0', '07-tendermint-1'), conn('connection-0', '07-tendermint-2')]))).toThrow(/listed twice/);
    expect(() => parseIbcConnections(listing([conn('connection-0', 'not a client')]))).toThrow(/names no client/);
  });

  it('reads a chain id only from the kind of client that has one, and only a name a chain id can be', () => {
    expect(parseIbcClientChain(clientState(TENDERMINT, 'osmosis-1'))).toBe('osmosis-1');
    expect(() => parseIbcClientChain(clientState('/ibc.lightclients.solomachine.v3.ClientState', 'osmosis-1'))).toThrow(/not a kind of client/);
    expect(() => parseIbcClientChain(clientState(TENDERMINT, 'two words'))).toThrow(/names no chain/);
    expect(() => parseIbcClientChain(clientState(TENDERMINT, '<b>x</b>'))).toThrow(/names no chain/);
    expect(() => parseIbcClientChain(b64(pb(1, TENDERMINT)))).toThrow(/names no chain/);
  });

  it('a message field is read within the message: a number too long, a length past the end and an unknown kind of field all throw', () => {
    // a fixed-width field this site has no use for is stepped over whole
    expect(parseIbcClientChain(clientState(TENDERMINT, 'osmosis-1', [0x19, 1, 2, 3, 4, 5, 6, 7, 8, 0x25, 1, 2, 3, 4]))).toBe('osmosis-1');
    expect(() => parseIbcClientChain(clientState(TENDERMINT, 'osmosis-1', [0x19, 1, 2, 3]))).toThrow();
    // ten bytes are the most a number takes: an eleventh is refused, not shifted in
    expect(() => parseIbcClientChain(b64(cat([0x08], Array(10).fill(0xff), [0x01])))).toThrow(/runs past the end/);
    expect(() => parseIbcClientChain(b64(Uint8Array.of(0x08, 0xff)))).toThrow(/runs past the end/);
    expect(() => parseIbcClientChain(b64(Uint8Array.of(0x0a, 0x7f, 0x41)))).toThrow(/runs past the end/);
    // a length of 2^63 and more
    expect(() => parseIbcClientChain(b64(cat([0x0a], Array(9).fill(0xff), [0x01])))).toThrow(/runs past the end/);
    for (const kind of [3, 4, 6, 7]) expect(() => parseIbcClientChain(b64(Uint8Array.of(0x08 | kind))), `kind ${kind}`).toThrow(/unknown wire type/);
    // a value made of very many small fields is refused, not held in memory
    expect(() => parseIbcClientChain(b64(cat(...Array.from({ length: 65 }, () => [0x08, 0x01]))))).toThrow(/more fields/);
    expect(() => parseIbcClientChain(b64(cat(pb(1, TENDERMINT), ...Array.from({ length: 62 }, () => [0x18, 0x01]), pb(2, pb(1, 'osmosis-1')))))).not.toThrow();
  });
});

describe('the channel reader, against a node', () => {
  const NODE = [{ provider: 'TestNode', url: 'https://node.test' }];
  const answer = (value: string | null) => new Response(JSON.stringify({ result: { response: { code: 0, value, height: String(FX.height) } } }), { status: 200, headers: { 'content-type': 'application/json' } });
  const stub = (clientState: (id: string) => Response | null) => {
    const asked: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const path = decodeURIComponent(url.split('path=')[1] ?? '');
      asked.push(path);
      const bridge = `#${NAMADA.internal.ibc}`;
      if (path === `"/shell/prefix/${bridge}/channelEnds/ports/transfer/channels"`) return answer(FX.channels);
      if (path === `"/shell/prefix/${bridge}/connections"`) return answer(FX.connections);
      const m = /^"\/shell\/value\/([^/]+)\/clients\/([a-z0-9-]+)\/clientState"$/.exec(path);
      if (m && m[1] === bridge) return clientState(m[2]) ?? answer(FX.clientStates[m[2]] ?? null);
      return new Response('not here', { status: 404 });
    }));
    return asked;
  };

  it('asks for the two listings and then one client state per chain, each by the key the chain keeps it under', async () => {
    const asked = stub(() => null);
    const r = await ibcChannels({ rpcs: NODE, retries: 0 });
    expect(r.height).toBe(FX.height);
    expect(r.provider).toBe('TestNode');
    expect(r.channels.map((c) => ({ channel: c.channel, counterpartyChannel: c.counterpartyChannel, connection: c.connection, client: c.client, chainId: c.chainId }))).toEqual(FX.expected);
    // two listings, then the eight clients the channels rest on (never the four no channel uses)
    expect(asked).toHaveLength(2 + FX.expected.length);
    expect(asked.slice(2).sort()).toEqual(FX.expected.map((e) => `"/shell/value/#${NAMADA.internal.ibc}/clients/${e.client}/clientState"`).sort());
  });

  it('a client state that cannot be read leaves its channel listed with no chain, and one of another kind names none', async () => {
    const noble = FX.expected.find((e) => e.chainId === 'noble-1')!, nym = FX.expected.find((e) => e.chainId === 'nyx')!;
    stub((id) => (id === noble.client ? new Response('bad gateway', { status: 502 }) : id === nym.client ? answer(clientState('/ibc.lightclients.wasm.v1.ClientState', 'nyx')) : null));
    const r = await ibcChannels({ rpcs: NODE, retries: 0 });
    expect(r.channels).toHaveLength(FX.expected.length);
    const by = new Map(r.channels.map((c) => [c.channel, c]));
    expect(by.get(noble.channel)).toMatchObject({ client: noble.client, chainId: null });
    expect(by.get(nym.channel)).toMatchObject({ client: nym.client, chainId: null });
    expect(r.channels.filter((c) => c.chainId == null)).toHaveLength(2);
  });

  it('asks for a bounded number of client states: the channels past them are listed with no chain', async () => {
    const n = IBC_CLIENT_READS_MAX + 6;
    const chans = listing(Array.from({ length: n }, (_, i) => one(`channel-${i}`, { port: 'transfer', channel: `channel-${500 + i}`, hops: [`connection-${i}`] })));
    const conns = listing(Array.from({ length: n }, (_, i) => entry(['connections', `connection-${i}`], pb(1, `07-tendermint-${i}`))));
    let clientReads = 0, atOnce = 0, most = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = decodeURIComponent(String(input).split('path=')[1] ?? '');
      if (path.includes('channelEnds')) return answer(chans);
      if (path.endsWith('/connections"')) return answer(conns);
      clientReads++; atOnce++; most = Math.max(most, atOnce);
      await new Promise((r) => setTimeout(r, 1));
      atOnce--;
      return answer(clientState(TENDERMINT, 'celestia'));
    }));
    const r = await ibcChannels({ rpcs: NODE, retries: 0 });
    expect(r.channels).toHaveLength(n);
    expect(clientReads).toBe(IBC_CLIENT_READS_MAX);
    expect(most).toBeLessThanOrEqual(8);
    expect(r.channels.filter((c) => c.chainId === 'celestia')).toHaveLength(IBC_CLIENT_READS_MAX);
    expect(r.channels.slice(IBC_CLIENT_READS_MAX).every((c) => c.chainId === null)).toBe(true);
    expect(r.passed).toBe(0);
  });

  it('a listing that cannot be read is a failed read, not an empty list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad gateway', { status: 502 })));
    await expect(ibcChannels({ rpcs: NODE, retries: 0 })).rejects.toThrow();
  });
});

describe('the voucher a chain issues for NAM', () => {
  it('is the name Osmosis gives NAM for the channel the chain itself lists', async () => {
    const osmosis = FX.expected.find((e) => e.chainId === 'osmosis-1')!;
    expect(osmosis.counterpartyChannel).toBe(NAM.osmoChannel);
    expect(await voucherDenom('transfer', osmosis.counterpartyChannel, NAM.namadaToken)).toBe(NAM.osmoDenom);
  });

  it('differs for every channel', async () => {
    const all = await Promise.all(FX.expected.map((e) => voucherDenom('transfer', e.counterpartyChannel, NAM.namadaToken)));
    // Penumbra and Nym both call their side channel-13: the same voucher name on two different chains
    expect(new Set(all).size).toBe(new Set(FX.expected.map((e) => e.counterpartyChannel)).size);
    for (const d of all) expect(d).toMatch(/^ibc\/[0-9A-F]{64}$/);
  });

  it('has a place on the list for every chain the mainnet channels lead to', () => {
    for (const e of FX.expected) expect(BRIDGE_CHAINS[e.chainId], e.chainId).toBeDefined();
    expect(BRIDGE_CHAINS['penumbra-1'].rest).toBeNull();
    for (const [id, c] of Object.entries(BRIDGE_CHAINS)) {
      if (c.rest) { expect(c.rest.length, id).toBeGreaterThanOrEqual(2); for (const u of c.rest) expect(u).toMatch(/^https:\/\/[a-z0-9.-]+(\/[a-z0-9-]+)?$/); }
      else expect(c.why, id).toBeTruthy();
    }
  });

  it('a chain id is looked up as a name on the list, never as a word every object answers to', () => {
    for (const id of ['constructor', 'toString', '__proto__', 'hasOwnProperty', '', null]) {
      expect(chainOf(id), String(id)).toBeUndefined();
      expect(readable({ chainId: id, counterpartyPort: 'transfer' }), String(id)).toBe(false);
    }
    expect(chainOf('noble-1')?.name).toBe('Noble');
    expect(readable({ chainId: 'noble-1', counterpartyPort: 'transfer' })).toBe(true);
    expect(readable({ chainId: 'penumbra-1', counterpartyPort: 'transfer' })).toBe(false);
    // only a channel that ends at the other chain's own coin transfers gives NAM a voucher there
    expect(readable({ chainId: 'noble-1', counterpartyPort: 'wasm.abc' })).toBe(false);
  });
});

describe('one chain\'s answer for the voucher\'s total', () => {
  const DENOM = 'ibc/C7110DEC66869DAE9BE9C3C60F4B5313B16A2204AE020C3B0527DD6B322386A3';
  const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
  const answers = (o: unknown) => { const f = vi.fn(async (_input: RequestInfo | URL) => json(o)); vi.stubGlobal('fetch', f); return f; };

  it('asks the chain\'s node for the total of that one voucher, and takes a whole number of base units', async () => {
    const f = answers({ amount: { denom: DENOM, amount: '22772725670429' } });
    expect(await readHeld('https://chain.test', DENOM)).toBe(22_772_725_670_429n);
    expect(String(f.mock.calls[0][0])).toBe(`https://chain.test/cosmos/bank/v1beta1/supply/by_denom?denom=${encodeURIComponent(DENOM)}`);
    answers({ amount: { denom: DENOM, amount: '0' } });
    expect(await readHeld('https://chain.test', DENOM)).toBe(0n);
  });

  it('refuses an answer about another coin, one with no total and one whose total is not a whole number', async () => {
    const bad: unknown[] = [
      { amount: { denom: 'uosmo', amount: '5' } },
      { amount: { denom: DENOM } },
      { amount: { denom: DENOM, amount: 5 } },
      { amount: { denom: DENOM, amount: '-5' } },
      { amount: { denom: DENOM, amount: '5.5' } },
      { amount: { denom: DENOM, amount: '1e9' } },
      { amount: { denom: DENOM, amount: '' } },
      { amount: { denom: DENOM, amount: '1'.repeat(41) } },
      { amount: null },
      {},
      null,
      { code: 12, message: 'Not Implemented' },
    ];
    for (const o of bad) {
      answers(o);
      await expect(readHeld('https://chain.test', DENOM), JSON.stringify(o)).rejects.toThrow(/names no total/);
    }
  });
});

const CHANNELS: IbcChannel[] = FX.expected.map((e) => ({ channel: e.channel, open: true, counterpartyPort: 'transfer', counterpartyChannel: e.counterpartyChannel, connection: e.connection, client: e.client, chainId: e.chainId }));
const channels = async () => ({ channels: CHANNELS, height: FX.height, provider: 'TestNode' });
const ALL = ['Stride', 'Osmosis', 'Cosmos Hub', 'Celestia', 'Penumbra', 'Noble', 'Nym', 'Neutron'];

describe('one pass over the channels', () => {
  it('lists every channel, reads every chain that can be read and says why the others have no figure', async () => {
    const db = testD1();
    const health: SourceHealth[] = [];
    const asked: string[] = [];
    const rec = await runBridges({ DB: db as any }, health, NOW, { deps: { channels, held: async (rest, denom) => { asked.push(rest); return denom === NAM.osmoDenom ? 22_772_725_670_429n : 0n; } } });
    expect(rec?.rows.map((r) => r.chain)).toEqual(ALL);
    const by = new Map(rec!.rows.map((r) => [r.chainId, r]));
    expect(by.get('osmosis-1')!.held).toEqual({ value: 22_772_725.670429, prov: { source: 'Osmosis node', at: NOW, status: 'live' } });
    expect(by.get('noble-1')!.held).toEqual({ value: 0, prov: { source: 'Noble node', at: NOW, status: 'live' } });
    // Penumbra: listed, never asked, no figure, the reason said
    expect(by.get('penumbra-1')!.held).toEqual({ value: null, prov: { source: 'Penumbra', at: null, status: 'missing', note: BRIDGE_CHAINS['penumbra-1'].why } });
    // one request per readable chain: the first node of each answered
    expect(asked.sort()).toEqual(Object.values(BRIDGE_CHAINS).filter((c) => c.rest).map((c) => c.rest![0]).sort());
    expect(await kvGetJson<BridgesRecord>(db as any, BRIDGES_KV)).toEqual(rec);
    expect(rec).toMatchObject({ at: NOW, channelsAt: NOW, triedAt: NOW, height: FX.height, provider: 'TestNode' });
    expect(health).toEqual([
      { name: BRIDGE_HEALTH.channels, ok: true, at: NOW, note: `8 channels at block ${FX.height.toLocaleString('en-US')} from TestNode` },
      { name: BRIDGE_HEALTH.held, ok: true, at: NOW, note: '7 of 7 chains answered; not readable: Penumbra' },
    ]);
    const sums = bridgeSums(rec, NOW);
    expect(sums.heldNam).toBeCloseTo(22_772_725.670429, 6);
    expect(sums.heldAt).toBe(NOW);
    expect(sums.otherNam).toBe(0);
    expect(sums.otherRead).toEqual(['Stride', 'Cosmos Hub', 'Celestia', 'Noble', 'Nym', 'Neutron']);
    expect(sums.unread).toEqual(['Penumbra']);
    // a figure read too long ago stands for nothing now: every chain is unread, and the sums are null, not zero
    expect(bridgeSums(rec, NOW + HELD_STALE_MS)).toMatchObject({ unread: ['Penumbra'] });
    expect(sums.heldKept).toBe(false);
    expect(bridgeSums(rec, NOW + HELD_STALE_MS + 1)).toEqual({ heldNam: null, heldAt: null, heldKept: false, otherNam: null, otherRead: [], unread: ALL });
    expect(bridgeSums(null, NOW)).toEqual({ heldNam: null, heldAt: null, heldKept: false, otherNam: null, otherRead: [], unread: [] });
  });

  it('asks the second node when the first fails, and keeps the last figure with its own time when both fail', async () => {
    const db = testD1();
    const first = await runBridges({ DB: db as any }, [], NOW, { deps: { channels, held: async (rest) => { if (rest === BRIDGE_CHAINS['noble-1'].rest![0]) throw new Error('HTTP 502 for https://example.invalid/x'); return 5_000_000n; } } });
    expect(first!.rows.find((r) => r.chainId === 'noble-1')!.held).toEqual({ value: 5, prov: { source: 'Noble node', at: NOW, status: 'live' } });

    const nobleDown = (n: bigint) => async (rest: string) => { if (BRIDGE_CHAINS['noble-1'].rest!.includes(rest)) throw new Error('HTTP 502 for https://example.invalid/x'); return n; };
    const later = NOW + HELD_EVERY_MS;
    const health: SourceHealth[] = [];
    const second = await runBridges({ DB: db as any }, health, later, { deps: { channels, held: nobleDown(7_000_000n) } });
    const noble = second!.rows.find((r) => r.chainId === 'noble-1')!;
    // the figure of the last good read, dated then, marked old, with why; never today's date on yesterday's figure
    expect(noble.held).toEqual({ value: 5, prov: { source: 'Noble node', at: NOW, status: 'stale', note: 'Noble did not answer at the last reading (upstream unavailable (HTTP 502)).' } });
    expect(second!.rows.find((r) => r.chainId === 'stride-1')!.held).toEqual({ value: 7, prov: { source: 'Stride node', at: later, status: 'live' } });
    // another chain's node silent is said, and is no fault of this site's; the figure of ten minutes ago still
    // stands in the sums, which say that a part of them was kept
    expect(health).toEqual([{ name: BRIDGE_HEALTH.held, ok: true, at: later, note: '6 of 7 chains answered; no answer from Noble; not readable: Penumbra' }]);
    expect(bridgeSums(second, later).otherRead).toContain('Noble');
    expect(bridgeSums(second, later).heldKept).toBe(true);
    // between two turns nothing is asked and the stored record stands
    const between: SourceHealth[] = [];
    const same = await runBridges({ DB: db as any }, between, later + 60_000, { deps: { channels, held: async () => { throw new Error('must not be asked'); } } });
    expect(same).toEqual(second);
    expect(between).toEqual([]);
    // still no answer once the figure is too old to stand for now: the row is out of the sums, and said in the note
    const third = NOW + HELD_STALE_MS + HELD_EVERY_MS;
    const late: SourceHealth[] = [];
    const rec = await runBridges({ DB: db as any }, late, third, { deps: { channels, held: nobleDown(9_000_000n) } });
    expect(rec!.rows.find((r) => r.chainId === 'noble-1')!.held).toMatchObject({ value: 5, prov: { at: NOW, status: 'stale' } });
    expect(late).toEqual([{ name: BRIDGE_HEALTH.held, ok: true, at: third, note: '6 of 7 chains answered; no answer from Noble; not readable: Penumbra' }]);
    expect(bridgeSums(rec, third).unread).toEqual(['Penumbra', 'Noble']);
    expect(bridgeSums(rec, third).otherRead).not.toContain('Noble');
    expect(bridgeSums(rec, third).heldKept).toBe(false);
    // no chain answering at all is likelier a fault on this side: the source is not well
    const none: SourceHealth[] = [];
    await runBridges({ DB: db as any }, none, third + HELD_EVERY_MS, { deps: { channels, held: async () => { throw new Error('timeout'); } } });
    expect(none).toEqual([{ name: BRIDGE_HEALTH.held, ok: false, at: third + HELD_EVERY_MS, note: '0 of 7 chains answered; no answer from Stride, Osmosis, Cosmos Hub, Celestia, Noble, Nym, Neutron; not readable: Penumbra' }]);
  });

  it('a chain never read has no figure, and a chain that is not on the list says so', async () => {
    const db = testD1();
    const odd: IbcChannel[] = [...CHANNELS.slice(0, 2), { channel: 'channel-8', open: true, counterpartyPort: 'transfer', counterpartyChannel: 'channel-5', connection: 'connection-9', client: '07-tendermint-12', chainId: 'newchain-1' }, { channel: 'channel-9', open: false, counterpartyPort: 'transfer', counterpartyChannel: 'channel-6', connection: null, client: null, chainId: null }];
    const health: SourceHealth[] = [];
    const rec = await runBridges({ DB: db as any }, health, NOW, { deps: { channels: async () => ({ channels: odd, height: 1, provider: 'TestNode' }), held: async () => { throw new Error('timeout'); } } });
    for (const r of rec!.rows) expect(r.held.value, r.channel).toBeNull();
    expect(rec!.rows[0].held.prov).toEqual({ source: 'Stride node', at: null, status: 'missing', note: 'Stride did not answer at the last reading (timeout).' });
    // the chain's id is a node's word and is not put into a sentence; the row carries it as its own field
    expect(rec!.rows[2]).toMatchObject({ chainId: 'newchain-1', chain: null, held: { value: null, prov: { source: 'the other chain', at: null, status: 'missing', note: "No public node of this channel's chain is on this site's list, so what it holds is not read." } } });
    expect(rec!.rows[3].held.prov.note).toBe('The chain this channel leads to could not be read from Namada.');
    expect(rec!.rows[3].open).toBe(false);
    // a chain this site has no name for is named by its channel wherever names go into a sentence
    expect(bridgeSums(rec, NOW)).toEqual({ heldNam: null, heldAt: null, heldKept: false, otherNam: null, otherRead: [], unread: ['Stride', 'Osmosis', 'channel-8', 'channel-9'] });
    // a channel with no chain: the list is not whole, so it does not count as read and is tried again soon; the
    // list itself was read, so its source is well
    expect(rec!.channelsAt).toBe(0);
    expect(health[0]).toEqual({ name: BRIDGE_HEALTH.channels, ok: true, at: NOW, note: '4 channels at block 1 from TestNode; the chain of 1 could not be read, so the list is read again soon' });
    expect(health[1]).toMatchObject({ name: BRIDGE_HEALTH.held, ok: false, note: '0 of 2 chains answered; no answer from Stride, Osmosis' });
  });

  it('takes Osmosis from the tick\'s own reading and asks no node for it', async () => {
    const db = testD1();
    const asked: string[] = [];
    const rec = await runBridges({ DB: db as any }, [], NOW, { deps: { channels, osmosis: { nam: 22_772_726, at: NOW - 30_000 }, held: async (rest) => { asked.push(rest); return 0n; } } });
    expect(rec!.rows.find((r) => r.chainId === 'osmosis-1')!.held).toEqual({ value: 22_772_726, prov: { source: 'Osmosis node', at: NOW - 30_000, status: 'live' } });
    expect(asked.some((u) => BRIDGE_CHAINS['osmosis-1'].rest!.includes(u))).toBe(false);
    expect(bridgeSums(rec, NOW).heldAt).toBe(NOW - 30_000);
  });

  it('two channels to one chain are two rows, each named with its channel, and only NAM\'s own Osmosis voucher is the tick\'s reading', async () => {
    const db = testD1();
    const two: IbcChannel[] = [...CHANNELS, { channel: 'channel-8', open: true, counterpartyPort: 'transfer', counterpartyChannel: 'channel-200000', connection: 'connection-1', client: '07-tendermint-2', chainId: 'osmosis-1' }];
    const asked: string[] = [];
    const rec = await runBridges({ DB: db as any }, [], NOW, { deps: { channels: async () => ({ channels: two, height: 2, provider: 'TestNode' }), osmosis: { nam: 100, at: NOW }, held: async (rest, denom) => { asked.push(`${rest} ${denom}`); return 3_000_000n; } } });
    const second = rec!.rows[8];
    expect(second.denom).not.toBe(NAM.osmoDenom);
    expect(second.held).toEqual({ value: 3, prov: { source: 'Osmosis node', at: NOW, status: 'live' } });
    expect(asked).toContain(`${BRIDGE_CHAINS['osmosis-1'].rest![0]} ${second.denom}`);
    const sums = bridgeSums(rec, NOW);
    // the second channel's NAM is NAM on a chain other than through NAM's own Osmosis voucher: it is in the others' sum
    expect(sums.otherRead).toEqual(['Stride', 'Cosmos Hub', 'Celestia', 'Noble', 'Nym', 'Neutron', 'Osmosis (channel-8)']);
    expect(sums.otherNam).toBe(6 * 3 + 3);
    expect(sums.heldNam).toBe(100 + 7 * 3);
    expect(bridgeSums(rec, NOW + HELD_STALE_MS + 1).unread).toContain('Osmosis (channel-1)');
  });

  it('keeps the stored list when the channel read fails, and reads nothing while no list was ever read', async () => {
    const db = testD1();
    const health: SourceHealth[] = [];
    expect(await runBridges({ DB: db as any }, health, NOW, { deps: { channels: async () => { throw new Error('abci: no node answered'); } } })).toBeNull();
    expect(health).toEqual([{ name: BRIDGE_HEALTH.channels, ok: false, at: NOW, note: 'The channel list could not be read: abci: no node answered' }]);
    // the failed attempt is remembered: the next one waits its turn, whatever the tick
    let asks = 0;
    const counted = async () => { asks++; return channels(); };
    const soon: SourceHealth[] = [];
    expect(await runBridges({ DB: db as any }, soon, NOW + 60_000, { deps: { channels: counted, held: async () => 1_000_000n } })).toBeNull();
    expect(await runBridges({ DB: db as any }, soon, NOW + CHANNELS_RETRY_MS - 1, { deps: { channels: counted, held: async () => 1_000_000n } })).toBeNull();
    expect(asks).toBe(0);
    expect(soon).toEqual([]);
    const start = NOW + CHANNELS_RETRY_MS;
    const read = await runBridges({ DB: db as any }, [], start, { deps: { channels: counted, held: async () => 1_000_000n } });
    expect(asks).toBe(1);
    expect(read).toMatchObject({ at: start, channelsAt: start, triedAt: start });
    const later = start + CHANNELS_EVERY_MS;
    const down: SourceHealth[] = [];
    const rec = await runBridges({ DB: db as any }, down, later, { deps: { channels: async () => { throw new Error('abci: no node answered'); }, held: async () => 2_000_000n } });
    expect(rec!.rows).toHaveLength(8);
    expect(rec).toMatchObject({ channelsAt: start, triedAt: later });
    expect(down[0]).toMatchObject({ name: BRIDGE_HEALTH.channels, ok: false });
    expect(rec!.rows.find((r) => r.chainId === 'celestia')!.held).toEqual({ value: 2, prov: { source: 'Celestia node', at: later, status: 'live' } });
    // and the failed re-read waits too: a minute later the list is not asked for again
    asks = 0;
    await runBridges({ DB: db as any }, [], later + 60_000, { deps: { channels: counted, held: async () => 2_000_000n } });
    expect(asks).toBe(0);
  });

  it('refuses a list that lacks a channel on record, and an empty one: the chain never removes a channel', async () => {
    const db = testD1();
    const first = await runBridges({ DB: db as any }, [], NOW, { deps: { channels, held: async () => 1_000_000n } });
    const later = NOW + CHANNELS_EVERY_MS;
    for (const [short, why] of [[CHANNELS.slice(0, 7), 'the answer lacks 1 of the channels on record'], [[], 'the chain listed no channel']] as const) {
      const health: SourceHealth[] = [];
      const rec = await runBridges({ DB: db as any }, health, later, { deps: { channels: async () => ({ channels: [...short], height: 9, provider: 'ShortNode' }), held: async () => 1_000_000n } });
      expect(health[0]).toEqual({ name: BRIDGE_HEALTH.channels, ok: false, at: later, note: `The channel list could not be read: ${why}` });
      expect(rec!.rows.map((r) => r.channel)).toEqual(first!.rows.map((r) => r.channel));
      expect(rec).toMatchObject({ channelsAt: NOW, height: FX.height, provider: 'TestNode' });
      // the record is as it was but for the attempt's time, so each loop's read is due again only by the clock
      await kvSet(db as any, BRIDGES_KV, first);
    }
  });

  it('a channel whose chain could not be read this time keeps the chain it had, and a new one without a chain is read again soon', async () => {
    const db = testD1();
    await runBridges({ DB: db as any }, [], NOW, { deps: { channels, held: async () => 1_000_000n } });
    const later = NOW + CHANNELS_EVERY_MS;
    const blank = CHANNELS.map((c) => (c.chainId === 'noble-1' ? { ...c, client: null, chainId: null } : c));
    const health: SourceHealth[] = [];
    const rec = await runBridges({ DB: db as any }, health, later, { deps: { channels: async () => ({ channels: blank, height: FX.height + 5, provider: 'TestNode' }), held: async () => 4_000_000n } });
    expect(rec!.rows.find((r) => r.channel === 'channel-5')).toMatchObject({ chainId: 'noble-1', chain: 'Noble', held: { value: 4, prov: { status: 'live', at: later } } });
    expect(rec).toMatchObject({ channelsAt: later, height: FX.height + 5 });
    expect(health[0]).toMatchObject({ name: BRIDGE_HEALTH.channels, ok: true });
    // a new channel whose chain cannot be read: listed with no figure, and the list is tried again after the short
    // wait, not a whole interval later
    const fresh: IbcChannel = { channel: 'channel-8', open: true, counterpartyPort: 'transfer', counterpartyChannel: 'channel-77', connection: 'connection-20', client: '07-tendermint-30', chainId: null };
    const next = later + CHANNELS_EVERY_MS;
    const again = await runBridges({ DB: db as any }, [], next, { deps: { channels: async () => ({ channels: [...CHANNELS, fresh], height: FX.height + 9, provider: 'TestNode' }), held: async () => 4_000_000n } });
    expect(again!.rows.find((r) => r.channel === 'channel-8')).toMatchObject({ chainId: null, chain: null, held: { value: null, prov: { status: 'missing', note: 'The chain this channel leads to could not be read from Namada.' } } });
    expect(again!.channelsAt).toBe(later);
    let asks = 0;
    const counted = async () => { asks++; return { channels: [...CHANNELS, { ...fresh, chainId: 'celestia' }], height: FX.height + 12, provider: 'TestNode' }; };
    await runBridges({ DB: db as any }, [], next + CHANNELS_RETRY_MS - 1, { deps: { channels: counted, held: async () => 4_000_000n } });
    expect(asks).toBe(0);
    const whole = await runBridges({ DB: db as any }, [], next + CHANNELS_RETRY_MS, { deps: { channels: counted, held: async () => 4_000_000n } });
    expect(asks).toBe(1);
    expect(whole).toMatchObject({ channelsAt: next + CHANNELS_RETRY_MS });
    expect(whole!.rows.find((r) => r.channel === 'channel-8')).toMatchObject({ chainId: 'celestia', chain: 'Celestia', held: { value: 4 } });
  });

  it('refuses a list that gives a channel on record another other side or another chain: neither ever changes', async () => {
    const db = testD1();
    const first = await runBridges({ DB: db as any }, [], NOW, { deps: { channels, held: async () => 1_000_000n } });
    const later = NOW + CHANNELS_EVERY_MS;
    const cases: [IbcChannel[], string][] = [
      [CHANNELS.map((c) => (c.chainId === 'noble-1' ? { ...c, counterpartyChannel: 'channel-999' } : c)), 'the answer names another other side for a channel on record'],
      [CHANNELS.map((c) => (c.chainId === 'noble-1' ? { ...c, counterpartyPort: 'wasm.abc' } : c)), 'the answer names another other side for a channel on record'],
      // Noble's channel said to lead to the Cosmos Hub: its figure would be shown under the wrong name
      [CHANNELS.map((c) => (c.chainId === 'noble-1' ? { ...c, chainId: 'stride-1' } : c)), 'the answer names another chain for a channel on record'],
    ];
    for (const [list, why] of cases) {
      const health: SourceHealth[] = [];
      const rec = await runBridges({ DB: db as any }, health, later, { deps: { channels: async () => ({ channels: list, height: 9, provider: 'OtherNode' }), held: async () => 2_000_000n } });
      expect(health[0], why).toEqual({ name: BRIDGE_HEALTH.channels, ok: false, at: later, note: `The channel list could not be read: ${why}` });
      expect(rec!.rows.map((r) => [r.channel, r.chainId, r.counterpartyPort, r.counterpartyChannel])).toEqual(first!.rows.map((r) => [r.channel, r.chainId, r.counterpartyPort, r.counterpartyChannel]));
      expect(rec!.rows.find((r) => r.chainId === 'noble-1')!.held).toEqual({ value: 2, prov: { source: 'Noble node', at: later, status: 'live' } });
      await kvSet(db as any, BRIDGES_KV, first);
    }
  });

  it('holds the first list to what is known: Osmosis must be in it, and nothing else may claim its voucher or share an other side', async () => {
    const noOsmosis = CHANNELS.filter((c) => c.chainId !== 'osmosis-1');
    expect(listRefusal(CHANNELS, [])).toBeNull();
    expect(listRefusal(noOsmosis, [])).toBe('the answer lacks the channel to Osmosis');
    expect(listRefusal([], [])).toBe('the chain listed no channel');
    // Osmosis's channel number on another of Namada's channels is not Namada's channel to Osmosis
    expect(listRefusal(CHANNELS.map((c) => (c.chainId === 'osmosis-1' ? { ...c, channel: 'channel-9' } : c)), [])).toBe('the answer lacks the channel to Osmosis');
    const claim: IbcChannel = { channel: 'channel-8', open: true, counterpartyPort: 'transfer', counterpartyChannel: NAM.osmoChannel, connection: 'connection-1', client: '07-tendermint-2', chainId: 'osmosis-1' };
    expect(listRefusal([...CHANNELS, claim], [])).toBe('the answer names a second channel to the same other side');
    // even when the real channel's chain could not be read this time
    expect(listRefusal([...CHANNELS.map((c) => (c.chainId === 'osmosis-1' ? { ...c, chainId: null } : c)), claim], [])).toBe('the answer names a second channel to the same other side');
    expect(listRefusal([...CHANNELS, { ...claim, counterpartyChannel: 'channel-136', chainId: 'noble-1' }], [])).toBe('the answer names a second channel to the same other side');
    // the same channel number on two different chains is two other sides (Penumbra's and Nym's are both channel-13)
    expect(CHANNELS.filter((c) => c.counterpartyChannel === 'channel-13').map((c) => c.chainId)).toEqual(['penumbra-1', 'nyx']);
    // and the same number as Osmosis's on a chain that is not Osmosis is that chain's own channel: its voucher has the
    // same name, and it is asked of that chain, never given Osmosis's figure
    const twin: IbcChannel = { ...claim, chainId: 'noble-1' };
    expect(listRefusal([...CHANNELS, twin], [])).toBeNull();

    const db = testD1();
    const health: SourceHealth[] = [];
    expect(await runBridges({ DB: db as any }, health, NOW, { deps: { channels: async () => ({ channels: noOsmosis, height: 4, provider: 'TestNode' }), held: async () => 0n } })).toBeNull();
    expect(health).toEqual([{ name: BRIDGE_HEALTH.channels, ok: false, at: NOW, note: 'The channel list could not be read: the answer lacks the channel to Osmosis' }]);
    expect(await kvGetJson<BridgesRecord>(db as any, BRIDGES_KV)).toEqual({ at: 0, channelsAt: 0, triedAt: NOW, height: 0, provider: '', rows: [] });
    expect((await bridgesAnswer(db as any, NOW)).beyondNam).toBeNull();

    const asked: string[] = [];
    const rec = await runBridges({ DB: db as any }, [], NOW + CHANNELS_RETRY_MS, { deps: { channels: async () => ({ channels: [...CHANNELS, twin], height: 5, provider: 'TestNode' }), osmosis: { nam: 100, at: NOW + CHANNELS_RETRY_MS }, held: async (rest, denom) => { asked.push(`${rest} ${denom}`); return 7_000_000n; } } });
    const row = rec!.rows[8];
    expect(row.denom).toBe(NAM.osmoDenom);
    expect(osmosisRow(row)).toBe(false);
    expect(row.held).toEqual({ value: 7, prov: { source: 'Noble node', at: NOW + CHANNELS_RETRY_MS, status: 'live' } });
    expect(asked).toContain(`${BRIDGE_CHAINS['noble-1'].rest![0]} ${NAM.osmoDenom}`);
    expect(rec!.rows.filter(osmosisRow).map((r) => [r.channel, r.held.value])).toEqual([['channel-1', 100]]);
    // it is NAM on another chain, counted with the others, never taken for Osmosis's
    expect(bridgeSums(rec, NOW + CHANNELS_RETRY_MS).otherRead).toContain('Noble (channel-8)');
  });

  it('a channel that does not end at the other chain\'s coin transfers is listed with no figure, and never asked for', async () => {
    const db = testD1();
    const contract: IbcChannel = { channel: 'channel-8', open: true, counterpartyPort: `wasm.${'a'.repeat(63)}`, counterpartyChannel: 'channel-40', connection: 'connection-5', client: '07-tendermint-6', chainId: 'noble-1' };
    const asked: string[] = [];
    const rec = await runBridges({ DB: db as any }, [], NOW, { deps: { channels: async () => ({ channels: [...CHANNELS, contract], height: 6, provider: 'TestNode', passed: 2 }), held: async (_rest, denom) => { asked.push(denom); return 0n; } } });
    const row = rec!.rows[8];
    expect(row.held).toEqual({ value: null, prov: { source: 'Noble', at: null, status: 'missing', note: "This channel does not end at the other chain's own coin transfers, so no total of NAM is read for it." } });
    expect(asked).not.toContain(row.denom);
    expect(readable(row)).toBe(false);
    expect(bridgeSums(rec, NOW).unread).toEqual(['Penumbra', 'Noble (channel-8)']);
  });

  it('says in the list\'s note how many channels were left out as unreadable', async () => {
    const db = testD1();
    const health: SourceHealth[] = [];
    await runBridges({ DB: db as any }, health, NOW, { deps: { channels: async () => ({ channels: CHANNELS, height: 6, provider: 'TestNode', passed: 2 }), held: async () => 0n } });
    expect(health[0]).toEqual({ name: BRIDGE_HEALTH.channels, ok: true, at: NOW, note: '8 channels at block 6 from TestNode; 2 whose other side is named in a form this site does not read are left out' });
  });

  it('does nothing while the record cannot be read: the guards rest on it', async () => {
    const db = testD1();
    const first = await runBridges({ DB: db as any }, [], NOW, { deps: { channels, held: async () => 1_000_000n } });
    let down = true;
    const flaky = { ...db, prepare: (sql: string) => { if (down && /\bkv\b/.test(sql) && /^\s*SELECT/i.test(sql)) throw new Error('D1_ERROR: simulated'); return db.prepare(sql); } };
    const later = NOW + CHANNELS_EVERY_MS;
    const health: SourceHealth[] = [];
    await expect(runBridges({ DB: flaky as any }, health, later, { deps: { channels: async () => { throw new Error('abci: no node answered'); }, held: async () => 9_000_000n } })).rejects.toThrow(/simulated/);
    expect(health).toEqual([]);
    down = false;
    expect(await kvGetJson<BridgesRecord>(db as any, BRIDGES_KV)).toEqual(first);
  });

  it('keeps the first channels of a list longer than it keeps, and says how many it left', async () => {
    const db = testD1();
    const extra = CHANNELS_MAX_ROWS - CHANNELS.length + 3;
    const long: IbcChannel[] = [...CHANNELS, ...Array.from({ length: extra }, (_, i): IbcChannel => ({ channel: `channel-${100 + i}`, open: true, counterpartyPort: 'transfer', counterpartyChannel: `channel-${1000 + i}`, connection: 'connection-3', client: '07-tendermint-4', chainId: 'celestia' }))];
    const health: SourceHealth[] = [];
    const rec = await runBridges({ DB: db as any }, health, NOW, { deps: { channels: async () => ({ channels: long, height: 3, provider: 'TestNode' }), held: async () => 0n } });
    expect(rec!.rows).toHaveLength(CHANNELS_MAX_ROWS);
    expect(rec!.rows.at(-1)!.channel).toBe(`channel-${100 + extra - 3 - 1}`);
    expect(health[0].note).toBe(`${CHANNELS_MAX_ROWS + 3} channels at block 3 from TestNode; 3 more are not kept`);
    // the same long list read again holds every channel on record: it is not taken for a short answer
    const again: SourceHealth[] = [];
    await runBridges({ DB: db as any }, again, NOW + CHANNELS_EVERY_MS, { deps: { channels: async () => ({ channels: long, height: 4, provider: 'TestNode' }), held: async () => 0n } });
    expect(again[0]).toMatchObject({ name: BRIDGE_HEALTH.channels, ok: true });
  });

  it('a pass cut by the tick\'s deadline blames no chain: it keeps what answered before the cut and leaves the rest as it stood', async () => {
    const db = testD1();
    const first = await runBridges({ DB: db as any }, [], NOW, { deps: { channels, held: async () => 1_000_000n } });
    const later = NOW + HELD_EVERY_MS;
    // cut while the chains are being asked: Stride had answered, the others had not
    const mid = new AbortController();
    const health: SourceHealth[] = [];
    const stride = BRIDGE_CHAINS['stride-1'].rest!;
    const cut = await runBridges({ DB: db as any }, health, later, { signal: mid.signal, deps: { channels, held: async (rest) => { if (stride.includes(rest)) return 3_000_000n; mid.abort(); throw new Error('deadline passed'); } } });
    expect(health).toEqual([]);
    expect(cut!.rows.find((r) => r.chainId === 'stride-1')!.held).toEqual({ value: 3, prov: { source: 'Stride node', at: later, status: 'live' } });
    // every other row is as it stood: its figure, its time, and no word of a chain that did not answer
    for (const r of cut!.rows.filter((x) => x.chainId !== 'stride-1')) expect(r, r.channel).toEqual(first!.rows.find((x) => x.channel === r.channel));
    // the holdings stay due: the next tick reads them, and does not ask for the list again
    expect(cut).toMatchObject({ at: NOW, channelsAt: NOW, triedAt: NOW });
    expect(await kvGetJson<BridgesRecord>(db as any, BRIDGES_KV)).toEqual(cut);
    const next = await runBridges({ DB: db as any }, [], later + 60_000, { deps: { channels: async () => { throw new Error('must not be asked'); }, held: async () => 5_000_000n } });
    expect(next).toMatchObject({ at: later + 60_000 });
    expect(next!.rows.find((r) => r.chainId === 'noble-1')!.held).toEqual({ value: 5, prov: { source: 'Noble node', at: later + 60_000, status: 'live' } });

    // cut while the channel list is being read: nothing changes but the attempt's time, so the list waits its turn
    await kvSet(db as any, BRIDGES_KV, first);
    const early = new AbortController();
    const due = NOW + CHANNELS_EVERY_MS;
    const cut2 = await runBridges({ DB: db as any }, health, due, { signal: early.signal, deps: { channels: async () => { early.abort(); throw new Error('deadline passed'); }, held: async () => { throw new Error('must not be asked'); } } });
    expect(cut2).toEqual(first);
    expect(health).toEqual([]);
    expect(await kvGetJson<BridgesRecord>(db as any, BRIDGES_KV)).toEqual({ ...first, triedAt: due });
    let asks = 0;
    await runBridges({ DB: db as any }, [], due + 60_000, { deps: { channels: async () => { asks++; return channels(); }, held: async () => 1_000_000n } });
    expect(asks).toBe(0);
  });

  it('a first pass cut after the list was read keeps the list, with every chain not read yet', async () => {
    const db = testD1();
    const ctl = new AbortController();
    const health: SourceHealth[] = [];
    const cut = await runBridges({ DB: db as any }, health, NOW, { signal: ctl.signal, deps: { channels, held: async () => { ctl.abort(); throw new Error('deadline passed'); } } });
    // the list's own row stands (the list was read); no row about the chains
    expect(health.map((h) => h.name)).toEqual([BRIDGE_HEALTH.channels]);
    expect(cut).toMatchObject({ at: 0, channelsAt: NOW, triedAt: NOW, height: FX.height });
    expect(cut!.rows.map((r) => r.chain)).toEqual(ALL);
    expect(cut!.rows.find((r) => r.chainId === 'noble-1')!.held).toEqual({ value: null, prov: { source: 'Noble node', at: null, status: 'missing', note: 'Not read yet.' } });
    expect(bridgeSums(cut, NOW)).toMatchObject({ heldNam: null, otherNam: null, unread: ALL });
    // the next tick reads the chains and does not ask for the list again
    let asks = 0;
    const next = await runBridges({ DB: db as any }, [], NOW + 60_000, { deps: { channels: async () => { asks++; return channels(); }, held: async () => 2_000_000n } });
    expect(asks).toBe(0);
    expect(next).toMatchObject({ at: NOW + 60_000, channelsAt: NOW });
    expect(next!.rows.find((r) => r.chainId === 'noble-1')!.held).toEqual({ value: 2, prov: { source: 'Noble node', at: NOW + 60_000, status: 'live' } });
  });
});

describe('the answer the page reads', () => {
  // the pass at NOW; the tick's own minute readings half a minute later (MIN), one transfer's status read a little
  // before them; the answer asked at ASK
  const MIN = NOW + 30_000, ASK = NOW + 60_000;
  const packet = (over: Record<string, unknown> = {}) => ({ innerTx: 'AA', nam: 1614, verifiedAt: NOW + 15_000, ...over });
  const seed = async (opts: { osmosis?: boolean; packets?: Record<string, unknown>[] } = {}) => {
    const db = testD1();
    await runBridges({ DB: db as any }, [], NOW, { deps: { channels, held: async (_rest, denom) => (denom === NAM.osmoDenom ? 22_772_000_000_000n : 0n) } });
    // the tick's own minute readings of the bridge account and of Osmosis, and one transfer known to be stuck
    insert(db, 'metrics', [
      { ts: MIN, key: 'supply.ibc_escrow', value: 22_815_646.541081 },
      ...(opts.osmosis === false ? [] : [{ ts: MIN, key: 'supply.osmosis', value: 22_772_725.670429 }]),
    ]);
    await kvSet(db as any, STUCK_PACKETS_KV, { at: MIN, packets: opts.packets ?? [packet()], dropped: [] });
    return db;
  };

  it('sets the account against the chains read and the stuck transfers, and names the chain with no figure', async () => {
    const db = await seed();
    const a = await bridgesAnswer(db as any, ASK);
    expect(a.asOf).toBe(ASK);
    expect(a.account).toEqual({ value: 22_815_646.541081, prov: { source: 'Namada node', at: MIN, status: 'live' } });
    expect(a.channels).toHaveLength(8);
    // Osmosis's row carries the minute reading the home page states, not the pass's ten-minute one
    expect(a.channels.find((c) => c.chainId === 'osmosis-1')!.held).toEqual({ value: 22_772_725.670429, prov: { source: 'Osmosis node', at: MIN, status: 'live' } });
    // the sum is as old as its oldest part: the other chains, read by the pass
    expect(a.held.prov).toEqual({ source: "each chain's own node", at: NOW, status: 'live' });
    expect(a.held.value).toBeCloseTo(22_772_725.670429, 6);
    expect(a.unread).toEqual(['Penumbra']);
    // the stuck transfers: dated by the oldest reading of a transfer's status
    expect(a.stuck).toEqual({ value: 1614, prov: { source: 'Namada indexer', at: NOW + 15_000, status: 'live' } });
    expect(a.beyondNam).toBeCloseTo(22_815_646.541081 - 22_772_725.670429 - 1614, 4);
    expect(a.prov).toEqual({ source: 'Namada node', at: NOW, status: 'live', height: FX.height });
    // the pass's own reading of Osmosis stands while it is the newer of the two
    const older = await bridgesAnswer(db as any, NOW);
    expect(older.account.value).toBeNull();
    expect(older.channels.find((c) => c.chainId === 'osmosis-1')!.held).toEqual({ value: 22_772_000, prov: { source: 'Osmosis node', at: NOW, status: 'live' } });
  });

  it('states nothing left over while a chain that can be read has no current figure', async () => {
    // Osmosis's own minute reading is missing and the pass's is too old: Osmosis holds nearly all of it, and a
    // remainder made without it would call that NAM unaccounted for
    const db = await seed({ osmosis: false });
    const later = NOW + HELD_STALE_MS + 60_000;
    insert(db, 'metrics', [{ ts: later - 30_000, key: 'supply.ibc_escrow', value: 22_815_646.541081 }]);
    await kvSet(db as any, STUCK_PACKETS_KV, { at: later - 30_000, packets: [packet({ verifiedAt: later - 30_000 })], dropped: [] });
    // the other chains are read again; Osmosis does not answer
    await runBridges({ DB: db as any }, [], later, { deps: { channels, held: async (rest) => { if (BRIDGE_CHAINS['osmosis-1'].rest!.includes(rest)) throw new Error('timeout'); return 0n; } } });
    const a = await bridgesAnswer(db as any, later);
    expect(a.account.prov.status).toBe('live');
    expect(a.stuck.prov.status).toBe('live');
    expect(a.channels.find((c) => c.chainId === 'osmosis-1')!.held).toMatchObject({ value: 22_772_000, prov: { at: NOW, status: 'stale' } });
    expect(a.held).toEqual({ value: 0, prov: { source: "each chain's own node", at: later, status: 'live' } });
    expect(a.unread).toEqual(['Osmosis', 'Penumbra']);
    expect(a.beyondNam).toBeNull();
  });

  it('states nothing left over while a channel\'s chain is not known, and says a stuck transfer\'s reading is old', async () => {
    const db = await seed({ packets: [packet({ stale: true, verifiedAt: NOW - 3 * 3600_000 })] });
    const a = await bridgesAnswer(db as any, ASK);
    // a transfer whose status could not be read again still counts, as it does in the cross-check; its stamp says so
    expect(a.stuck).toEqual({ value: 1614, prov: { source: 'Namada indexer', at: NOW - 3 * 3600_000, status: 'stale', note: 'Not read again in its usual time.' } });
    expect(a.beyondNam).toBeCloseTo(22_815_646.541081 - 22_772_725.670429 - 1614, 4);
    // a channel with no chain may hold NAM nobody has read
    const rec = (await kvGetJson<BridgesRecord>(db as any, BRIDGES_KV))!;
    await kvSet(db as any, BRIDGES_KV, { ...rec, rows: rec.rows.map((r) => (r.chainId === 'noble-1' ? { ...r, chainId: null, chain: null, held: { value: null, prov: { source: 'the other chain', at: null, status: 'missing', note: 'x' } } } : r)) });
    const b = await bridgesAnswer(db as any, ASK);
    expect(b.unread).toEqual(['Penumbra', 'channel-5']);
    expect(b.beyondNam).toBeNull();
  });

  it('gives no figure for what is left when a part was not read, and marks an old reading old', async () => {
    const db = await seed();
    // the bridge account's reading has aged past its usual time: served with its own time, marked old, and the
    // remainder, which would be made from it, is not stated
    const late = await bridgesAnswer(db as any, MIN + ACCOUNT_STALE_MS + 1);
    expect(late.account).toEqual({ value: 22_815_646.541081, prov: { source: 'Namada node', at: MIN, status: 'stale', note: 'Not read again in its usual time.' } });
    expect(late.stuck.prov).toMatchObject({ status: 'stale', at: NOW + 15_000 });
    expect((await bridgesAnswer(db as any, MIN + ACCOUNT_STALE_MS)).beyondNam).not.toBeNull();
    expect(late.beyondNam).toBeNull();
    // every chain's figure is past its usual time too: each row keeps its figure with its own time, marked old, and
    // none of them counts in the sum
    const old = await bridgesAnswer(db as any, MIN + HELD_STALE_MS + 1);
    const noble = old.channels.find((c) => c.chainId === 'noble-1')!;
    expect(noble.held).toEqual({ value: 0, prov: { source: 'Noble node', at: NOW, status: 'stale', note: 'Not read again in its usual time.' } });
    expect(old.channels.find((c) => c.chainId === 'osmosis-1')!.held).toMatchObject({ value: 22_772_725.670429, prov: { at: MIN, status: 'stale' } });
    expect(old.held).toEqual({ value: null, prov: { source: "each chain's own node", at: null, status: 'missing', note: 'No chain has a current figure.' } });
    expect(old.unread).toEqual(ALL);
    expect(old.beyondNam).toBeNull();
    // the channel list's own stamp ages on its own clock
    expect(old.prov.status).toBe('live');
    expect((await bridgesAnswer(db as any, NOW + 2 * CHANNELS_EVERY_MS + 1)).prov).toMatchObject({ at: NOW, status: 'stale', height: FX.height });
    // nothing stored at all: an empty list and a stamp that says the list was never read; no figure anywhere, and
    // no stuck list written yet is not "no NAM stuck"
    const empty = await bridgesAnswer(testD1() as any, NOW);
    expect(empty).toEqual({
      asOf: NOW,
      account: { value: null, prov: { source: 'Namada node', at: null, status: 'missing', note: 'The bridge account has not been read.' } },
      channels: [],
      held: { value: null, prov: { source: "each chain's own node", at: null, status: 'missing', note: 'No chain has a current figure.' } },
      unread: [],
      stuck: { value: null, prov: { source: 'Namada indexer', at: null, status: 'missing', note: 'No list of stuck transfers has been written yet.' } },
      beyondNam: null,
      prov: { source: 'Namada node', at: null, status: 'missing', note: 'The channel list has not been read yet.' },
    });
  });

  it('a sum with a figure kept from an earlier reading says so, and so does what is left', async () => {
    const db = await seed();
    const later = NOW + HELD_EVERY_MS;
    insert(db, 'metrics', [{ ts: later, key: 'supply.ibc_escrow', value: 22_815_646.541081 }, { ts: later, key: 'supply.osmosis', value: 22_772_725.670429 }]);
    await kvSet(db as any, STUCK_PACKETS_KV, { at: later, packets: [packet({ verifiedAt: later })], dropped: [] });
    await runBridges({ DB: db as any }, [], later, { deps: { channels, osmosis: { nam: 22_772_725.670429, at: later }, held: async (rest) => { if (BRIDGE_CHAINS['noble-1'].rest!.includes(rest)) throw new Error('timeout'); return 0n; } } });
    const a = await bridgesAnswer(db as any, later);
    expect(a.channels.find((c) => c.chainId === 'noble-1')!.held.prov).toMatchObject({ at: NOW, status: 'stale' });
    expect(a.held.value).toBeCloseTo(22_772_725.670429, 6);
    expect(a.held.prov).toEqual({ source: "each chain's own node", at: NOW, status: 'stale', note: 'A chain in this sum did not answer at its last reading; its figure is the one before.' });
    // still stated: every part is a real reading within its time; the page's stamp of it follows the oldest part
    expect(a.beyondNam).toBeCloseTo(22_815_646.541081 - 22_772_725.670429 - 1614, 4);
  });

  it('states nothing left over unless Osmosis is among the chains read', async () => {
    const db = await seed();
    const rec = (await kvGetJson<BridgesRecord>(db as any, BRIDGES_KV))!;
    expect((await bridgesAnswer(db as any, ASK)).beyondNam).not.toBeNull();
    // a record with no row for Namada's channel to Osmosis (no pass writes one; a record is still only stored data)
    await kvSet(db as any, BRIDGES_KV, { ...rec, rows: rec.rows.filter((r) => !osmosisRow(r)) });
    const a = await bridgesAnswer(db as any, ASK);
    expect(a.held).toMatchObject({ value: 0, prov: { status: 'live' } });
    expect(a.beyondNam).toBeNull();
    // nor does the minute reading of Osmosis go to a row that only shares its voucher's name
    await kvSet(db as any, BRIDGES_KV, { ...rec, rows: rec.rows.map((r) => (osmosisRow(r) ? { ...r, channel: 'channel-9' } : r)) });
    const b = await bridgesAnswer(db as any, ASK);
    expect(b.channels.find((c) => c.channel === 'channel-9')!.held).toMatchObject({ value: 22_772_000, prov: { at: NOW } });
    expect(b.beyondNam).toBeNull();
  });

  it('a list with no transfer in it is no NAM stuck, dated by the list', async () => {
    const db = await seed({ packets: [] });
    const a = await bridgesAnswer(db as any, ASK);
    expect(a.stuck).toEqual({ value: 0, prov: { source: 'Namada indexer', at: MIN, status: 'live' } });
    expect(a.beyondNam).toBeCloseTo(22_815_646.541081 - 22_772_725.670429, 4);
  });

  it('a list read while a channel had no chain is stamped as not read whole', async () => {
    const db = testD1();
    const blank = CHANNELS.map((c) => (c.chainId === 'noble-1' ? { ...c, client: null, chainId: null } : c));
    await runBridges({ DB: db as any }, [], NOW, { deps: { channels: async () => ({ channels: blank, height: 7, provider: 'TestNode' }), held: async () => 0n } });
    const a = await bridgesAnswer(db as any, NOW);
    expect(a.channels).toHaveLength(8);
    expect(a.prov).toEqual({ source: 'Namada node', at: null, status: 'missing', note: 'The channel list has not been read whole yet.', height: 7 });
  });

  it('is served at /api/bridges', async () => {
    const db = await seed();
    const res = await app.request('/api/bridges', {}, { DB: db } as any);
    expect(res.status).toBe(200);
    const body = (await res.json()) as BridgesResponse;
    expect(body.channels.map((c) => c.channel)).toEqual(FX.expected.map((e) => e.channel));
    expect(Object.keys(body).sort()).toEqual(['account', 'asOf', 'beyondNam', 'channels', 'held', 'prov', 'stuck', 'unread']);
    expect(Object.keys(body.channels[0]).sort()).toEqual(['chain', 'chainId', 'channel', 'counterpartyChannel', 'counterpartyPort', 'denom', 'held', 'open']);
  });
});

describe('the bridge cross-check with the other chains read', () => {
  it('counts NAM on another chain on the chains\' side, and leaves the gap against Osmosis as it was', () => {
    // the figures of 2026-11-10: the account over Osmosis by 42,920.87, of which 1,614 is in a stuck transfer
    const before = ibcConservation(22_815_646.541081, 22_772_725.670429, 1614);
    const none = ibcConservation(22_815_646.541081, 22_772_725.670429, 1614, 0);
    expect(none).toEqual(before);
    expect(none.over).toBe('escrow');
    expect(none.driftNam).toBeCloseTo(41_306.870652, 4);
    // were that NAM held on another chain that is read, the check would pass, and rawGapNam would still say what it said
    const found = ibcConservation(22_815_646.541081, 22_772_725.670429, 1614, 41_306.870652);
    expect(found).toMatchObject({ status: 'ok', over: null });
    expect(found.rawGapNam).toBeCloseTo(none.rawGapNam, 6);
    // more NAM on the chains read than the account holds is the finding the check exists for
    expect(ibcConservation(1_000_000, 900_000, 0, 200_000)).toMatchObject({ over: 'osmosis' });
  });

  it('a fault stands only on the tick\'s own two readings: the other chains\' older figures can ask for a look, no more', () => {
    // the account and Osmosis agree; another chain's node reports more NAM than the account could hold for it
    const withOthers = ibcConservation(1_000_000, 1_000_000, 0, 50_000);
    expect(withOthers).toMatchObject({ status: 'fail', over: 'osmosis' });
    expect(bridgeCheck(1_000_000, 1_000_000, 0, 50_000)).toEqual({ ...withOthers, status: 'warn' });
    // Osmosis alone over the account is a fault with or without the others
    expect(bridgeCheck(1_000_000, 1_020_000, 0, 0)).toMatchObject({ status: 'fail', over: 'osmosis' });
    expect(bridgeCheck(1_000_000, 1_020_000, 0, 50_000)).toMatchObject({ status: 'fail', over: 'osmosis' });
    // no other chain read is nothing taken off: the check as it was
    expect(bridgeCheck(11_624, 10, 1614, null)).toEqual(ibcConservation(11_624, 10, 1614));
    expect(bridgeCheck(1_624, 10, 1614, 0)).toMatchObject({ status: 'ok', over: null });
    // and the others can only explain the account's side, never excuse Osmosis's
    expect(bridgeCheck(21_624, 10, 1614, 20_000)).toMatchObject({ status: 'ok', over: null });
  });
});

describe('the bridge check in plain words, with the other chains read', () => {
  const c = (detail: Record<string, unknown>, status: Check['status'] = 'warn'): Check => ({ key: 'ibc_conservation', status, title: '', detail, checkedAt: 0 });
  const six = ['Stride', 'Cosmos Hub', 'Celestia', 'Noble', 'Nym', 'Neutron'];

  it('the title names both sides without naming one chain', () => {
    expect(CHECK_TITLES.ibc_conservation).toBe('NAM locked at the Namada bridge matches NAM on the chains it bridges to');
  });
  it('the bridge holding more names the chains read and the chain that is not', () => {
    expect(checkDetail(c({ driftNam: 41_306.87, stuckNam: 0, stuckPackets: [], over: 'escrow', otherChainsRead: six, otherChainsUnread: ['Penumbra'] }))).toBe(
      'The Namada bridge holds 41,307 NAM more than Osmosis and the 6 other chains read hold; Penumbra is not read, so the difference may be NAM sent there');
    expect(checkDetail(c({ driftNam: 500, stuckNam: 0, stuckPackets: [], over: 'escrow', otherChainsRead: ['Stride'], otherChainsUnread: ['Penumbra', 'Noble', 'Nym'] }))).toBe(
      'The Namada bridge holds 500 NAM more than Osmosis and the 1 other chain read hold; Penumbra, Noble and Nym are not read, so the difference may be NAM sent there');
    expect(checkDetail(c({ driftNam: 500, stuckNam: 0, stuckPackets: [], over: 'escrow', otherChainsRead: [...six, 'Penumbra'], otherChainsUnread: [] }))).toBe(
      'The Namada bridge holds 500 NAM more than Osmosis and the 7 other chains read hold; every other chain the bridge has a channel to was read');
  });
  it('with a channel list and no other chain read, it says which are not read', () => {
    expect(checkDetail(c({ driftNam: 500, stuckNam: 0, stuckPackets: [], over: 'escrow', otherChainsRead: [], otherChainsUnread: ['Stride', 'Penumbra'] }))).toBe(
      'The Namada bridge holds 500 NAM more than Osmosis counts; Stride and Penumbra are not read, so the difference may be NAM sent there');
  });
  it('with no channel list yet, and for a result from before the other chains were read, it reads as it did', () => {
    const was = 'The Namada bridge holds 500 NAM more than Osmosis counts; the bridge holds NAM for every chain and only Osmosis is read, so the difference may be NAM sent to another chain';
    expect(checkDetail(c({ driftNam: 500, stuckNam: 0, stuckPackets: [], over: 'escrow', otherChainsRead: null, otherChainsUnread: null }))).toBe(was);
    expect(checkDetail(c({ driftNam: 500, stuckNam: 0, stuckPackets: [], over: 'escrow' }))).toBe(was);
  });
  it('the chains counting more is said of all the chains read, with no other chain offered as the reason', () => {
    expect(checkDetail(c({ driftNam: -19_990, stuckNam: 0, stuckPackets: [], over: 'osmosis', otherChainsRead: six, otherChainsUnread: ['Penumbra'] }, 'fail'))).toBe(
      'Osmosis and the 6 other chains read count 19,990 NAM more than the Namada bridge holds');
    expect(checkDetail(c({ driftNam: 0.2, stuckNam: 0, stuckPackets: [], over: null, otherChainsRead: six, otherChainsUnread: ['Penumbra'] }, 'ok'))).toBe('Equal');
  });
  it('a name that is not text is never put in the sentence', () => {
    expect(checkDetail(c({ driftNam: 500, stuckNam: 0, stuckPackets: [], over: 'escrow', otherChainsRead: ['Stride', 7, null, { x: 1 }], otherChainsUnread: [null, 'Penumbra'] }))).toBe(
      'The Namada bridge holds 500 NAM more than Osmosis and the 1 other chain read hold; Penumbra is not read, so the difference may be NAM sent there');
  });
});

describe('the figures the served bridges page states', () => {
  it('states the account and the chains read, each only when it was read', async () => {
    const db = testD1();
    const rec = await runBridges({ DB: db as any }, [], NOW, { deps: { channels, held: async (_r, denom) => (denom === NAM.osmoDenom ? 22_772_725_670_429n : 0n) } });
    const f = bridgeFacts({ ts: NOW - 30_000, value: 22_815_646.541081 }, rec, NOW);
    expect(f.bridgeAccount).toEqual({ text: "In Namada's bridge account, for every channel: 22,815,647 NAM", at: NOW - 30_000, source: 'Namada nodes' });
    expect(f.bridgeHeld).toEqual({ text: 'Held by the 7 chains read: 22,772,726 NAM', at: NOW, source: "each chain's own node" });
    expect(bridgeFacts(null, null, NOW)).toEqual({});
    // a record whose every figure is too old to stand for now states no sum
    expect(bridgeFacts(null, rec, NOW + HELD_STALE_MS + 1).bridgeHeld).toBeUndefined();
  });
});
