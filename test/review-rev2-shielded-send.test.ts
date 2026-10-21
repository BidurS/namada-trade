// Review 2 of 7f1dd3c..50cb1ca, Namada parser: a shielded NAM withdrawal to Osmosis (the pool's NAM into the IBC
// escrow) carries its packet's channel and sequence like a transparent send, so its crossing is claimed once per
// channel with the Osmosis receive of the same packet.
//
// Before: a leg out of the pool took a packet only when the packet named the pool as its sender. The packet of a
// shielded withdrawal is sent from the transparent refund address the wallet picks (the indexer files these inner
// transactions, ibcUnshieldingTransfer, under that address), so the pool's leg bound no packet: it kept the escrow
// as its other end and had no meta.channel or meta.packetSequence, crossingOf gave null, and the operator channel
// heard of the crossing twice (once from each chain's record).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { base64 } from '@scure/base';
import { testD1 } from './d1-sqlite';
import { configureAlerts, crossingOf } from '../worker/src/sources/discord';
import { parseNamadaBlock } from '../worker/src/parse/namada';
import { normFromTxSearch, parseOsmosisTx } from '../worker/src/parse/osmosis';
import { NAMADA } from '../worker/src/config';
import type { Flow } from '../shared/types';

// LiveHub is a Durable Object; only its alert pass is exercised, on an instance made without its constructor.
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import { LiveHub } from '../worker/src/live-hub';

const I = NAMADA.internal;
const fx = (n: string) => JSON.parse(readFileSync(join(__dirname, 'fixtures', n), 'utf8'));
const KEY = base64.encode(new Uint8Array(32).fill(23));
afterEach(() => vi.unstubAllGlobals());

// Mainnet block 8,261,880 sends 1 NAM from REFUND to RECEIVER (send_packet channel-1, sequence 8548), and
// test/fixtures/osmo_ibc_recv.json is Osmosis receiving that packet. With the token leg's source set to the pool, the
// block is a shielded withdrawal: the NAM leaves the pool and the packet still names REFUND as its sender.
const REFUND = 'tnam1qr4wemkpjfycn7ts7297e8qecg2t6pf2vq2wulsa';
const RECEIVER = 'osmo137zwfeku64lzfg4laedyg628qnepqpgkahqyk3';
const INNER = 'D5515AF5989B700765B6DE2BE13D4D6B0DACE462C97B1F6002C54E376874C61A';
const ONE = '1000000';

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
const setAttr = (e: any, key: string, f: (v: string) => string) => ({ ...e, attributes: e.attributes.map((a: any) => (a.key === key ? { ...a, value: f(a.value) } : a)) });
/** Block 8,261,880 at `units` base units, its token leg leaving the shielded pool. */
const shieldedSend = (units: string) =>
  scaled(fx('namada_block_8261880.json').result.end_block_events, ONE, units).map((e: any) =>
    e.type === 'token/transfer' ? setAttr(e, 'source-accounts', (v) => v.split(`internal-address/${REFUND}`).join(`internal-address/${I.masp}`)) : e);
const sends = (events: any[], ts = 1) => parseNamadaBlock({ height: 8261880, ts, events }, null);
const osmoReceive = (ts: number, units: string): Flow[] => {
  const t = fx('osmo_ibc_recv.json')[0];
  const tx = normFromTxSearch({ ...t, tx_result: { ...t.tx_result, events: scaled(t.tx_result.events, ONE, units) } }, ts);
  return parseOsmosisTx(tx, { poolAddrs: new Map(), priceUsd: null, assets: new Map() }).flows.filter((f) => f.kind === 'ibc_in');
};

describe('a shielded NAM withdrawal to Osmosis is keyed on its packet', () => {
  it('the pool leg takes its inner transaction\'s packet: channel, sequence and the Osmosis receiver, as a transparent send', () => {
    const p = sends(shieldedSend('30000000000'));
    const out = p.flows.filter((f) => f.kind === 'ibc_out');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ from: I.masp, to: RECEIVER, amount: 30_000, meta: { channel: 'channel-1', packetSequence: '8548', escrow: I.ibc, innerTxHash: INNER } });
    // the crossing pairs with the Osmosis record of the same packet
    expect(crossingOf(out[0])).toBe('channel-1:8548');
    expect(crossingOf(osmoReceive(2, '30000000000')[0])).toBe('channel-1:8548');
    // a send links nothing (its receiver is text the sender chose), from the pool as from anyone
    expect(p.links).toEqual([]);
  });

  it('the operator channel hears of a 30,000 NAM shielded withdrawal once, from whichever record reaches it first', async () => {
    const calls: { url: string; body: any }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => {
      calls.push({ url: String(u), body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response(null, { status: 204 });
    }));
    const db = testD1();
    configureAlerts(KEY);
    const OP = 'https://discord.com/api/webhooks/301/op';
    const hub: any = Object.assign(Object.create(LiveHub.prototype), { env: { DISCORD_WEBHOOK_URL: OP, DB: db }, lastPriceUsd: null });
    const T = Date.UTC(2026, 9, 21, 12, 1);
    const send = sends(shieldedSend('30000000000'), T).flows.filter((f) => f.kind === 'ibc_out');
    const recv = osmoReceive(T + 20_000, '30000000000');
    // the Namada scan's pass, then the stream's (whale size 10,000; offered from 10 and 100 NAM)
    await hub.alertFlows(send, 10000, 10);
    await hub.alertFlows(recv, 10000, 100);
    expect(calls.filter((c) => c.url === OP).map((c) => c.body.embeds[0].title)).toEqual(['🌉 IBC Bridge Namada → Osmosis: 30,000 NAM']);
  });

  it('block 3,837,012 shape: the pool\'s fee unshield of the same inner transaction stays a flow of its own, the escrow leg takes the packet', () => {
    // The real token events of block 3,837,012 (scripts/out/history/masp_blocks): 0.145079 NAM from the pool to the gas
    // payer and 1 NAM from the pool into the escrow, one inner transaction. The cache keeps token and masp events only,
    // so the packet is 8,261,880's, moved to this inner transaction and sent from the indexer's source address for it.
    const inner = 'CF0791E3917CFAB16DAFC71C2F0EE92F84058404200BAEE0E732298018B6D45B';
    const wrapper = 'F73BF89ADEEF962FD8FABFD8886C330BF7B9009269CAAE7BC783D0041EBA26F6';
    const refund = 'tnam1qpqfsmj2quxnakfq0rn8y2tjcvtz26f8pyw4fq98';
    const gas = 'tnam1qq4ujk3h84c00w74lyf5nvsaeq6028994cd97hzh';
    const leg = (to: string, units: string) => ({
      type: 'token/transfer',
      attributes: [
        { key: 'hash', value: wrapper },
        { key: 'inner-tx-hash', value: inner },
        { key: 'source-accounts', value: JSON.stringify([[[`internal-address/${I.masp}`, 'tnam1q9gr66cvu4hrzm0sd5kmlnjje82gs3xlfg3v6nu7'], units]]) },
        { key: 'target-accounts', value: JSON.stringify([[[`internal-address/${to}`, 'tnam1q9gr66cvu4hrzm0sd5kmlnjje82gs3xlfg3v6nu7'], units]]) },
        { key: 'token-event-descriptor', value: 'transfer-from-wasm' },
      ],
    });
    const packet = setAttr(
      setAttr(fx('namada_block_8261880.json').result.end_block_events.find((e: any) => e.type === 'send_packet'), 'inner-tx-hash', () => inner),
      'packet_data', (v) => v.split(REFUND).join(refund),
    );
    const p = parseNamadaBlock({ height: 3837012, ts: 1, events: [packet, leg(gas, '145079'), leg(I.ibc, ONE)] }, null);
    expect(p.flows.map((f) => [f.kind, f.from, f.to, f.amount, f.meta?.packetSequence])).toEqual([
      ['unshield', I.masp, gas, 0.145079, undefined],
      ['ibc_out', I.masp, RECEIVER, 1, '8548'],
    ]);
  });

  it('the pool leg still takes no packet of another inner transaction, of another amount, or one already taken', () => {
    const other = sends(shieldedSend('30000000000').map((e: any) => (e.type === 'send_packet' ? setAttr(e, 'inner-tx-hash', () => 'AB'.repeat(32)) : e)));
    expect(other.flows.find((f) => f.kind === 'ibc_out')).toMatchObject({ from: I.masp, to: I.ibc });
    expect(other.flows.find((f) => f.kind === 'ibc_out')!.meta).not.toHaveProperty('packetSequence');
    const amount = sends(shieldedSend('30000000000').map((e: any) => (e.type === 'send_packet' ? setAttr(e, 'packet_data', (v) => v.split('"30000000000"').join('"29999999999"')) : e)));
    expect(amount.flows.find((f) => f.kind === 'ibc_out')).toMatchObject({ from: I.masp, to: I.ibc });
    // two pool legs of the same inner transaction and amount: one packet, one leg keyed on it
    const evs = shieldedSend('30000000000');
    const tt = evs.find((e: any) => e.type === 'token/transfer');
    const twice = sends([...evs, setAttr(tt, 'hash', () => 'CD'.repeat(32))]);
    expect(twice.flows.filter((f) => f.kind === 'ibc_out').map((f) => f.meta?.packetSequence ?? null)).toEqual(['8548', null]);
  });
});
