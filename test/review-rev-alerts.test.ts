// Review rev-alerts (fix2-alerts): a bridge crossing reaches each channel once, keyed on its packet; an Osmosis
// stream transaction whose write fails is read again by the catch-up search; the REST whale flag reads NAM only.
//
// Before: both records of a crossing (Namada's and Osmosis's) claimed one key for every channel together,
// alert:ibc:<from>:<to>:<rounded NAM>:<10-minute bucket>. The record that posted first took it for all of them, so
// the "NAM bridged to Osmosis" rule, which reads the Osmosis receive only, never fired when the Namada send posted
// first; two equal crossings of the same addresses in one bucket collapsed into one alert; and a crossing whose two
// records fell either side of a bucket boundary was posted twice.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { base64 } from '@scure/base';
import { testD1, insert } from './d1-sqlite';
import { configureAlerts, crossingOf } from '../worker/src/sources/discord';
import { saveSettings, defaultPrefs, type StoredSettings } from '../worker/src/settings';
import { parseNamadaBlock } from '../worker/src/parse/namada';
import { normFromTxSearch, parseOsmosisTx } from '../worker/src/parse/osmosis';
import { rowToFlow } from '../worker/src/analytics';
import { app } from '../worker/src/api';
import { NAM } from '../worker/src/config';
import type { Flow } from '../shared/types';

// LiveHub is a Durable Object; only its alert pass and its Osmosis stream and catch-up search are exercised here, on
// an instance made without its constructor (which would open sockets and fetch prices).
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import { LiveHub } from '../worker/src/live-hub';

type Hub = { alertFlows(flows: Flow[], threshold?: number, minNam?: number): Promise<void> };
const hubWith = (env: Record<string, unknown>): Hub => Object.assign(Object.create(LiveHub.prototype), { env, lastPriceUsd: null });

const KEY = base64.encode(new Uint8Array(32).fill(11));
const fx = (n: string) => JSON.parse(readFileSync(join(__dirname, 'fixtures', n), 'utf8'));

let calls: { url: string; body: any }[] = [];
const stubFetch = () => {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => {
    calls.push({ url: String(u), body: JSON.parse(String(init?.body ?? '{}')) });
    return new Response(null, { status: 204 });
  }));
};
afterEach(() => vi.unstubAllGlobals());
const titles = (url: string) => calls.filter((c) => c.url === url).map((c) => c.body.embeds[0].title as string);
const alertKeys = (db: ReturnType<typeof testD1>) =>
  db.raw.prepare("SELECT key FROM kv WHERE key LIKE 'alert:%' ORDER BY key").all().map((r: any) => r.key as string);

/** Raw events with a NAM amount of `from` base units read as `to`: the packet, its bank legs and the callback. */
const scaled = (events: any[], from: string, to: string) => events.map((e) => ({
  ...e,
  attributes: e.attributes.map((a: any) => {
    if (typeof a.value !== 'string') return a;
    if (a.key === 'amount' && a.value === from) return { ...a, value: to };
    if (a.key === 'packet_data' || a.key === 'source-accounts' || a.key === 'target-accounts') return { ...a, value: a.value.split(`"${from}"`).join(`"${to}"`) };
    return a;
  }),
}));
const ONE = '1000000';
const units = (nam: number) => String(nam * 1e6);

// The real crossing: mainnet Namada block 8261880 sends 1 NAM to osmo137zw… (send_packet channel-1, sequence 8548)
// and test/fixtures/osmo_ibc_recv.json is Osmosis receiving that packet. `seq` and `inner` make another packet of
// the same shape (the sending chain gives every packet of a channel its own sequence).
// The memory lock of the alert claims lives for the whole file, so each test names its own wrapper and inner hashes.
const SENDER = 'tnam1qr4wemkpjfycn7ts7297e8qecg2t6pf2vq2wulsa';
const WRAPPER = 'A0173FE3355215949DE0EF9FFDB70F3D4908A2419768AB0BC9094EC6E8217602';
const INNER = 'D5515AF5989B700765B6DE2BE13D4D6B0DACE462C97B1F6002C54E376874C61A';
const hex = (c: string) => c.repeat(64);
const sendEvents = (nam: number, seq: string, wrapper: string, inner: string) =>
  scaled(fx('namada_block_8261880.json').result.end_block_events, ONE, units(nam)).map((e: any) => ({
    ...e,
    attributes: e.attributes.map((a: any) => ({
      ...a,
      value: a.key === 'packet_sequence' ? seq : typeof a.value === 'string' ? a.value.split(WRAPPER).join(wrapper).split(INNER).join(inner) : a.value,
    })),
  }));
const namadaSends = (ts: number, events: any[]) => parseNamadaBlock({ height: 8261880, ts, events }, null).flows.filter((f) => f.kind === 'ibc_out');
const osmoReceive = (ts: number, nam: number, seq: string, hash: string) => {
  const t = fx('osmo_ibc_recv.json')[0];
  const events = scaled(t.tx_result.events, ONE, units(nam)).map((e: any) => (e.type === 'recv_packet'
    ? { ...e, attributes: e.attributes.map((a: any) => (a.key === 'packet_sequence' ? { ...a, value: seq } : a)) }
    : e));
  const tx = normFromTxSearch({ ...t, hash, tx_result: { ...t.tx_result, events } }, ts);
  return parseOsmosisTx(tx, { poolAddrs: new Map(), priceUsd: null, assets: new Map() }).flows.filter((f) => f.kind === 'ibc_in');
};
const subscriber = (name: string, url: string, watchlist: string[] = []): StoredSettings => ({
  address: `tnam1q${name.padEnd(39, 'q')}`, notifications: { ...defaultPrefs(), watchlist }, channels: { discord: { enabled: true, webhookUrl: url } }, createdAt: 1, updatedAt: 1,
});

describe('a bridge crossing reaches each channel once, from whichever record reaches it first', () => {
  const T = Date.UTC(2026, 9, 21, 12, 1); // mid-way through a ten-minute bucket, so the old key paired these records

  it('Namada send first: the operator hears of it once and the "NAM bridged to Osmosis" subscriber still gets the receive', async () => {
    stubFetch();
    const db = testD1();
    configureAlerts(KEY);
    const OP = 'https://discord.com/api/webhooks/91/op';
    const SUB = 'https://discord.com/api/webhooks/91/sub';
    await saveSettings(db as any, KEY, subscriber('sub91', SUB)); // default rules: ibc_inventory on at 25,000 NAM
    const hub = hubWith({ DISCORD_WEBHOOK_URL: OP, DB: db });
    // the packet as mainnet numbered it (sequence 8548), at 30,000 NAM
    const send = namadaSends(T, sendEvents(30_000, '8548', WRAPPER, INNER));
    const recv = osmoReceive(T + 20_000, 30_000, '8548', fx('osmo_ibc_recv.json')[0].hash);
    expect(send.map((f) => [f.from, f.to, f.amount])).toEqual(recv.map((f) => [f.from, f.to, f.amount]));
    // the Namada scan's pass, then the stream's (whale size 10,000; offered from 10 and 100 NAM)
    await hub.alertFlows(send, 10000, 10);
    await hub.alertFlows(recv, 10000, 100);
    expect(titles(OP)).toEqual(['🌉 IBC Bridge Namada → Osmosis: 30,000 NAM']);
    expect(titles(SUB)).toEqual(['[IBC_INVENTORY] 🌉 IBC Bridge Namada → Osmosis: 30,000 NAM']);
    // the crossing is claimed per channel on its packet, the channel by a digest: no webhook URL is ever stored
    const keys = alertKeys(db);
    expect(keys.filter((k) => k.startsWith('alert:ibc:'))).toHaveLength(2);
    for (const k of keys.filter((k) => k.startsWith('alert:ibc:'))) expect(k).toMatch(/^alert:ibc:channel-1:8548:[0-9a-f]{32}$/);
    expect(keys.some((k) => k.includes('discord') || k.includes('webhooks'))).toBe(false);
  });

  it("a watcher of the sender's own address hears of the crossing once, and does not keep it from the rule subscriber", async () => {
    stubFetch();
    const db = testD1();
    configureAlerts(KEY);
    const WATCH = 'https://discord.com/api/webhooks/92/watch';
    const SUB = 'https://discord.com/api/webhooks/92/sub';
    await saveSettings(db as any, KEY, subscriber('watch92', WATCH, [SENDER]));
    await saveSettings(db as any, KEY, subscriber('sub92', SUB));
    const hub = hubWith({ DB: db }); // no operator channel
    await hub.alertFlows(namadaSends(T, sendEvents(30_000, '9201', hex('A'), hex('B'))), 10000, 10);
    await hub.alertFlows(osmoReceive(T + 20_000, 30_000, '9201', hex('C')), 10000, 100);
    expect(titles(WATCH)).toEqual(['[WATCHLIST] 🌉 IBC Bridge Namada → Osmosis: 30,000 NAM']);
    expect(titles(SUB)).toEqual(['[IBC_INVENTORY] 🌉 IBC Bridge Namada → Osmosis: 30,000 NAM']);
  });

  it('Osmosis receive first: every channel hears of it once and the Namada send posts nothing more', async () => {
    stubFetch();
    const db = testD1();
    configureAlerts(KEY);
    const OP = 'https://discord.com/api/webhooks/93/op';
    const SUB = 'https://discord.com/api/webhooks/93/sub';
    await saveSettings(db as any, KEY, subscriber('sub93', SUB));
    const hub = hubWith({ DISCORD_WEBHOOK_URL: OP, DB: db });
    await hub.alertFlows(osmoReceive(T + 20_000, 30_000, '9301', hex('D')), 10000, 100);
    await hub.alertFlows(namadaSends(T, sendEvents(30_000, '9301', hex('E'), hex('F'))), 10000, 10);
    expect(titles(OP)).toHaveLength(1);
    expect(titles(SUB)).toHaveLength(1);
  });
});

describe('the pairing key is the packet both chains record', () => {
  it('two equal sends in one Namada batch are two packets and two posts; their two receives add none', async () => {
    stubFetch();
    const db = testD1();
    configureAlerts(KEY);
    const OP = 'https://discord.com/api/webhooks/94/op';
    const SUB = 'https://discord.com/api/webhooks/94/sub';
    await saveSettings(db as any, KEY, subscriber('sub94', SUB));
    const T = Date.UTC(2026, 9, 21, 12, 1);
    // one wrapper, two inner transactions, each 1,000,000 NAM to the same receiver: sequences 9401 and 9402
    const sends = namadaSends(T, [...sendEvents(1_000_000, '9401', hex('1'), hex('2')), ...sendEvents(1_000_000, '9402', hex('1'), hex('3'))]);
    expect(sends.map((f) => [f.amount, f.to])).toEqual([[1_000_000, 'osmo137zwfeku64lzfg4laedyg628qnepqpgkahqyk3'], [1_000_000, 'osmo137zwfeku64lzfg4laedyg628qnepqpgkahqyk3']]);
    const hub = hubWith({ DISCORD_WEBHOOK_URL: OP, DB: db });
    await hub.alertFlows(sends, 10000, 10);
    expect(titles(OP)).toEqual(['🌉 IBC Bridge Namada → Osmosis: 1,000,000 NAM', '🌉 IBC Bridge Namada → Osmosis: 1,000,000 NAM']);
    expect(sends.map(crossingOf)).toEqual(['channel-1:9401', 'channel-1:9402']);
    await hub.alertFlows([...osmoReceive(T + 30_000, 1_000_000, '9401', hex('4')), ...osmoReceive(T + 40_000, 1_000_000, '9402', hex('5'))], 10000, 100);
    expect(titles(OP)).toHaveLength(2);
    // the rule subscriber hears of each crossing from its Osmosis receive
    expect(titles(SUB)).toEqual(['[IBC_INVENTORY] 🌉 IBC Bridge Namada → Osmosis: 1,000,000 NAM', '[IBC_INVENTORY] 🌉 IBC Bridge Namada → Osmosis: 1,000,000 NAM']);
  });

  it("the two records of one crossing pair across a ten-minute boundary (send 5 s before it, receive 15 s after)", async () => {
    stubFetch();
    const db = testD1();
    const OP = 'https://discord.com/api/webhooks/95/op';
    const BOUNDARY = 600_000 * 2_987_000;
    const hub = hubWith({ DISCORD_WEBHOOK_URL: OP, DB: db });
    await hub.alertFlows(namadaSends(BOUNDARY - 5_000, sendEvents(31_000, '9501', hex('6'), hex('7'))), 10000, 10);
    await hub.alertFlows(osmoReceive(BOUNDARY + 15_000, 31_000, '9501', hex('8')), 10000, 100);
    expect(titles(OP)).toEqual(['🌉 IBC Bridge Namada → Osmosis: 31,000 NAM']);
  });

  it('each direction names its source channel and sequence; a record without its packet pairs with nothing', () => {
    // Osmosis → Namada: Osmosis sends on channel-98451 (osmo_ibc_send.json, sequence 1993) and Namada's record of a
    // receive (block 7153723, sequence 7904) names the same source channel
    const [osmoSend] = parseOsmosisTx(normFromTxSearch(fx('osmo_ibc_send.json')[0], 1), { poolAddrs: new Map(), priceUsd: null, assets: new Map() }).flows.filter((f) => f.kind === 'ibc_out');
    expect(crossingOf(osmoSend)).toBe(`${NAM.osmoChannel}:1993`);
    const r = fx('namada_block_7153723.json').result;
    const recv = parseNamadaBlock({ height: 7153723, ts: 1, events: [...(r.end_block_events ?? []), ...((r.txs_results ?? []) as any[]).flatMap((t) => t.events ?? [])] }, null).flows.find((f) => f.kind === 'ibc_in')!;
    expect(recv.meta).toMatchObject({ channel: NAM.namadaChannel, packetSequence: '7904' });
    expect(crossingOf(recv)).toBe(`${NAM.osmoChannel}:7904`);
    // no packet (no sequence, or not this channel pair), or another coin: no pairing key at all
    const [send] = namadaSends(1, sendEvents(30_000, '9601', hex('9'), hex('9')));
    expect(crossingOf(send)).toBe(`${NAM.namadaChannel}:9601`);
    expect(crossingOf({ ...send, meta: { ...send.meta, packetSequence: undefined } })).toBeNull();
    expect(crossingOf({ ...send, meta: { ...send.meta, channel: 'channel-5' } })).toBeNull();
    expect(crossingOf({ ...send, meta: { ...send.meta, tokenSymbol: 'USDC' } })).toBeNull();
  });

  it('records with no packet are each posted on their own id, never paired by addresses and amount', async () => {
    stubFetch();
    const db = testD1();
    const OP = 'https://discord.com/api/webhooks/97/op';
    const rec = (id: string, ts: number): Flow => ({ id, chain: 'osmosis', height: 1, ts, txHash: id, kind: 'ibc_in', from: SENDER, to: 'osmo1v97receiver', amount: 40_000, meta: null } as Flow);
    await hubWith({ DISCORD_WEBHOOK_URL: OP, DB: db }).alertFlows([rec('osmosis:V97A:ibc_in:1', 1000), rec('osmosis:V97B:ibc_in:1', 2000)], 10000, 100);
    expect(titles(OP)).toHaveLength(2);
  });
});

describe('an Osmosis stream transaction whose write fails is read again by the catch-up search', () => {
  // 1,000,000 NAM sent between two Osmosis accounts at height 100 (a plain bank send: one whale move)
  const events = [{ type: 'transfer', attributes: [{ key: 'recipient', value: 'osmo1v98recv' }, { key: 'sender', value: 'osmo1v98send' }, { key: 'amount', value: `${1_000_000 * 1e6}${NAM.osmoDenom}` }] }];
  const OP = 'https://discord.com/api/webhooks/98/op';

  /**
   * The hub over a D1 stand-in whose first batch fails (after `gate`, when given), the Osmosis node stubbed, and the
   * stream's message for transaction `hash` (its own per test: the alert claims' memory lock lives for the file).
   */
  function setup(hash: string, gate?: Promise<void>) {
    const msg = { result: { data: { value: { TxResult: { height: '100', result: { code: 0, events } } } }, events: { 'tx.hash': [hash] } } };
    const real = testD1();
    let fail = 1;
    const db: any = {
      prepare: (s: string) => real.prepare(s),
      batch: async (st: any[]) => {
        if (fail-- > 0) { await gate; throw new Error('D1_ERROR: Network connection lost.'); }
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
      seenOsmoTx: new Set<string>(), osmoRetryTx: new Map<string, number>(), osmoRetryFrom: null, osmoRetryGen: 0, osmoHeight: 0, sessions: new Set(), lastPriceUsd: null,
      osmoCtx: { poolAddrs: new Map(), priceUsd: null, assets: new Map() },
    });
    const rows = () => real.raw.prepare('SELECT COUNT(*) AS n FROM flows WHERE tx_hash = ?').get(hash.toUpperCase()).n as number;
    const cursor = () => JSON.parse(real.raw.prepare("SELECT value FROM kv WHERE key='osmosis.cursor'").get().value).height as number;
    return { real, hub, msg, posts, rows, cursor };
  }

  it('the next search writes it and alerts it as found late', async () => {
    const { real, hub, msg, posts, rows, cursor } = setup('v98aaa');
    await real.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('osmosis.cursor', ?, 0)").bind(JSON.stringify({ height: 50, at: 0 })).run();
    await expect(hub.handleOsmosisMessage(msg)).rejects.toThrow(/D1_ERROR/);
    expect(rows()).toBe(0);
    await hub.sweepOsmosis();
    expect(rows()).toBe(1);
    expect(posts).toHaveLength(1);
    expect(posts[0].embeds[0].title).toBe('🐋 Flow [TRANSFER]: 1,000,000 NAM');
    expect(posts[0].embeds[0].fields.some((f: any) => f.name === 'Found late')).toBe(true);
    expect(cursor()).toBe(200);
    expect(hub.osmoRetryFrom).toBeNull();
  });

  it('a search that ran while the write was in flight skipped it and moved the cursor past it: the next one still reads it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { real, hub, msg, posts, rows, cursor } = setup('v98bbb', gate);
    await real.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('osmosis.cursor', ?, 0)").bind(JSON.stringify({ height: 50, at: 0 })).run();
    const streamed = hub.handleOsmosisMessage(msg).catch((e: unknown) => e);
    // the write is in flight: the search sees the hash as seen, skips it, finishes and moves the cursor to 200
    await hub.sweepOsmosis();
    expect(cursor()).toBe(200);
    expect(rows()).toBe(0);
    release();
    expect(String(await streamed)).toMatch(/D1_ERROR/);
    // the next search reads from below the failed transaction's height, though the cursor is past it
    await hub.sweepOsmosis();
    expect(rows()).toBe(1);
    expect(posts).toHaveLength(1);
    expect(hub.osmoRetryFrom).toBeNull();
  });
});

describe('the REST whale flag and ?whale=true read NAM only', () => {
  const MASP = 'tnam1pcqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzmefah';
  const USER = 'tnam1qv99user0000000000000000000000000000000';
  const NOW = Date.UTC(2026, 9, 21, 12);
  const row = (id: string, ts: number, amount: number, meta: Record<string, unknown>) => ({
    id, chain: 'namada', height: 1, ts, tx_hash: id.toUpperCase(), kind: 'unshield', from_addr: MASP, to_addr: USER, amount_num: amount, meta: JSON.stringify(meta),
  });
  const osmo = row('v99osmo', NOW - 3_600_000, 60_000, { tokenSymbol: 'OSMO', descriptor: 'ibc-masp', innerTxHash: 'AA' }); // 60,000 OSMO
  const nam = row('v99nam', NOW - 7_200_000, 20_000, { descriptor: 'transfer-from-wasm', innerTxHash: 'BB' }); // 20,000 NAM

  it('a 60,000 OSMO row is not a whale; a 20,000 NAM row is', () => {
    expect(rowToFlow(osmo).whale).toBe(false);
    expect(rowToFlow(nam).whale).toBe(true);
  });

  it('GET /api/flows?whale=true and the export leave the other coin out', async () => {
    const db = testD1();
    insert(db, 'flows', [osmo, nam]);
    for (const path of [`/api/flows?whale=true&at=${NOW}`, `/api/flows?whale=true&kind=unshield&at=${NOW}`, `/api/export/flows?whale=true&format=json&at=${NOW}`]) {
      const res = await app.request(path, {}, { DB: db } as any);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { flows: Flow[] };
      expect(body.flows.map((f) => [f.id, f.whale])).toEqual([['v99nam', true]]);
    }
  });
});
