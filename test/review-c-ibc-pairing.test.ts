// Review run 2, group C (parse.namada.ibcPackets/unbound-packet-pairing): a Namada bridge record takes its other end
// from the packet of its own inner transaction (same inner-tx-hash, NAM, the leg's amount, a callback that did not
// fail), never from another sender's packet that happens to name the same receiver. No such packet: no source and
// no address link are made up.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseNamadaBlock } from '../worker/src/parse/namada';
import { NAMADA } from '../worker/src/config';

const fx = (n: string) => JSON.parse(readFileSync(join(__dirname, 'fixtures', n), 'utf8'));
const block = (h: number) => {
  const r = fx(`namada_block_${h}.json`).result;
  return { height: h, ts: 1, events: [...(r.end_block_events ?? [])] as any[] };
};
const MASP = NAMADA.internal.masp;
const SENDER = 'osmo19v0z78d8gv02t4cfqvmtklppu4rmpp5ek3q9a8'; // the real sender of block 7,153,723
const S2 = 'osmo137zwfeku64lzfg4laedyg628qnepqpgkahqyk3'; // someone else on Osmosis
const X = 'tnam1qr4wemkpjfycn7ts7297e8qecg2t6pf2vq2wulsa';
const setAttr = (e: any, key: string, value: string) => ({ ...e, attributes: e.attributes.map((a: any) => (a.key === key ? { ...a, value } : a)) });

/** Block 7,153,723 (a NAM receipt into the pool), its receiver replaced by `receiver` when given. */
function recvBlock(receiver?: string) {
  const b = block(7153723);
  if (receiver) b.events = b.events.map((e: any) => ({ ...e, attributes: e.attributes.map((a: any) => ({ ...a, value: String(a.value).split(MASP).join(receiver) })) }));
  return b;
}
/** Another inner transaction's channel-1 receive to `receiver`: 1 uosmo from S2, no token event of its own. */
function otherRecv(b: ReturnType<typeof block>, receiver: string, data: Record<string, string> = {}) {
  const real = b.events.find((e: any) => e.type === 'recv_packet');
  let e = setAttr(real, 'inner-tx-hash', 'AA'.repeat(32));
  e = setAttr(e, 'packet_data', JSON.stringify({ amount: '1', denom: 'uosmo', receiver, sender: S2, ...data }));
  return e;
}

describe('a Namada receive is paired with the packet of its own inner transaction', () => {
  it('transparent receive: an earlier unrelated packet to the same receiver is not the source and links nothing', () => {
    const b = recvBlock(X);
    b.events.unshift(otherRecv(b, X));
    const p = parseNamadaBlock(b, null);
    const f = p.flows.find((x) => x.kind === 'ibc_in')!;
    expect(f.from).toBe(SENDER);
    expect(f.to).toBe(X);
    expect(p.links).toEqual([{ osmo: SENDER, namada: X, amount: 4.682433, ts: 1 }]);
  });

  it('the same with an unrelated NAM packet of the same amount from another inner transaction', () => {
    const b = recvBlock(X);
    const real = JSON.parse(b.events.find((e: any) => e.type === 'recv_packet').attributes.find((a: any) => a.key === 'packet_data').value);
    b.events.unshift(otherRecv(b, X, { amount: real.amount, denom: real.denom }));
    const p = parseNamadaBlock(b, null);
    expect(p.flows.find((x) => x.kind === 'ibc_in')!.from).toBe(SENDER);
    expect(p.links.map((l) => l.osmo)).toEqual([SENDER]);
  });

  it('receive into the shielded pool: the unrelated packet to the pool is not the source', () => {
    const b = recvBlock();
    b.events.unshift(otherRecv(b, MASP));
    const p = parseNamadaBlock(b, null);
    const f = p.flows.find((x) => x.to === MASP)!;
    expect(f.kind).toBe('ibc_in');
    expect(f.from).toBe(SENDER);
    expect(p.links).toHaveLength(0);
  });

  it('the transfer\'s own packet missing: the escrow stays the source and no link is written', () => {
    const b = recvBlock(X);
    const unrelated = otherRecv(b, X);
    b.events = [unrelated, ...b.events.filter((e: any) => e.type !== 'recv_packet')];
    const p = parseNamadaBlock(b, null);
    const f = p.flows.find((x) => x.kind === 'ibc_in')!;
    expect(f.from).toBe(NAMADA.internal.ibc);
    expect(f.meta).not.toHaveProperty('escrow');
    expect(p.links).toEqual([]);
  });

  it('a receive whose ICS-20 callback reported failure in the same inner transaction is not a source', () => {
    const b = recvBlock(X);
    b.events = b.events.map((e: any) => (e.type === 'fungible_token_packet' ? setAttr(e, 'success', 'false') : e));
    const p = parseNamadaBlock(b, null);
    expect(p.flows.find((x) => x.kind === 'ibc_in')!.from).toBe(NAMADA.internal.ibc);
    expect(p.links).toEqual([]);
  });

  it('a send is paired with its own packet, not with another inner transaction\'s send from the same account', () => {
    const b = block(8261880);
    const real = b.events.find((e: any) => e.type === 'send_packet');
    const pd = JSON.parse(real.attributes.find((a: any) => a.key === 'packet_data').value);
    let other = setAttr(real, 'inner-tx-hash', 'BB'.repeat(32));
    other = setAttr(other, 'packet_data', JSON.stringify({ ...pd, receiver: 'osmo1yl6hdjhmkf37639730gffanpzndzdpmhxy9ep3' }));
    b.events.unshift(other);
    const p = parseNamadaBlock(b, null);
    const f = p.flows.find((x) => x.kind === 'ibc_out')!;
    expect(f.from).toBe(X);
    expect(f.to).toBe('osmo137zwfeku64lzfg4laedyg628qnepqpgkahqyk3');
  });

  it('an IBC shielding of another coin takes the packet of its own inner transaction, not the batch\'s first', () => {
    const W = 'CD'.repeat(32);
    const pkt = (inner: string, sender: string) => ({
      type: 'recv_packet',
      attributes: [
        { key: 'hash', value: W },
        { key: 'inner-tx-hash', value: inner },
        { key: 'packet_dst_channel', value: 'channel-1' },
        { key: 'packet_data', value: JSON.stringify({ amount: '5000000', denom: 'uosmo', receiver: MASP, sender }) },
      ],
    });
    const mint = {
      type: 'token/mint',
      attributes: [
        { key: 'token-event-descriptor', value: 'ibc' },
        { key: 'token-address', value: 'tnam1p5z8ruwyu7ha8urhq2l0dhpk2f5dv3ts7uyf2n75' },
        { key: 'target-account', value: `internal-address/${MASP}` },
        { key: 'amount', value: '5000000' },
        { key: 'hash', value: W },
        { key: 'inner-tx-hash', value: 'EE'.repeat(32) },
      ],
    };
    const p = parseNamadaBlock({ height: 2, ts: 1, events: [pkt('DD'.repeat(32), S2), pkt('EE'.repeat(32), SENDER), mint] }, null);
    expect(p.flows).toHaveLength(1);
    expect(p.flows[0]).toMatchObject({ kind: 'shield', from: SENDER, to: MASP, amount: 5, meta: { tokenSymbol: 'OSMO' } });
    // no inner hash on the mint: no packet is bound, the escrow stands for the other end
    const noInner = { ...mint, attributes: mint.attributes.filter((a) => a.key !== 'inner-tx-hash') };
    expect(parseNamadaBlock({ height: 2, ts: 1, events: [pkt('DD'.repeat(32), S2), noInner] }, null).flows[0].from).toBe(NAMADA.internal.ibc);
  });
});
