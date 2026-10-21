// Round-3 verification of the group C fixes: a withdrawal from the shielded pool to Osmosis is recorded on Namada as
// sent by the pool (its packet now binds, so the row names the Osmosis receiver) and on Osmosis as sent by the refund
// address the packet names. The two records are one crossing: they carry the same packet sequence.
import { describe, it, expect } from 'vitest';
import { onePerCrossing, counterpartiesOf } from '../shared/flow-rules';
import { RECEIVED_TWIN } from '../worker/src/flows-query';
import { testD1, insert } from './d1-sqlite';
import type { Flow } from '../shared/types';

const MASP = 'tnam1pcqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzmefah';
const REFUND = 'tnam1qrefundxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const R = 'osmo1receiverxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const T = 1_792_000_000_000;
const flow = (over: Partial<Flow>): Flow => ({
  id: 'x', chain: 'namada', height: 1, ts: T, txHash: 'H', kind: 'ibc_out', from: MASP, to: R, amount: 30000,
  counterDenom: null, counterAmount: null, poolId: null, priceUsd: null, valueUsd: null, meta: {}, ...over,
} as Flow);

const sent = flow({ id: 'namada:H:0', chain: 'namada', kind: 'ibc_out', from: MASP, meta: { channel: 'channel-1', packetSequence: '8548' } });
const received = flow({ id: 'osmosis:O:ibc_in:3', chain: 'osmosis', kind: 'ibc_in', from: REFUND, ts: T + 60_000, meta: { channel: 'channel-98451', packetSequence: '8548' } });

describe('a shielded withdrawal to Osmosis is one crossing on the receiver\'s page', () => {
  it('onePerCrossing keeps the sending record only, by packet sequence when the senders differ', () => {
    expect(onePerCrossing([sent, received]).map((f) => f.id)).toEqual(['namada:H:0']);
    // the receiver's counterparties count 30,000 in once
    const c = counterpartiesOf([sent, received], R);
    expect(c.reduce((a, x) => a + x.inNam, 0)).toBe(30000);
  });
  it('another packet of the same amount to the same receiver is another crossing', () => {
    const other = { ...received, id: 'osmosis:O2:ibc_in:0', meta: { channel: 'channel-98451', packetSequence: '8549' } };
    expect(onePerCrossing([sent, other]).map((f) => f.id)).toEqual(['namada:H:0', 'osmosis:O2:ibc_in:0']);
  });
  it('the server rule (?pairs=one) leaves out the same receiving record', () => {
    const db = testD1();
    const row = (f: Flow) => ({ id: f.id, chain: f.chain, height: 1, ts: f.ts, tx_hash: f.txHash, kind: f.kind, from_addr: f.from, to_addr: f.to, amount_num: f.amount, meta: JSON.stringify(f.meta) });
    insert(db, 'flows', [row(sent), row(received)]);
    const ids = db.raw.prepare(`SELECT f.id FROM flows f WHERE NOT ${RECEIVED_TWIN} ORDER BY f.id`).all().map((r: any) => r.id);
    expect(ids).toEqual(['namada:H:0']);
  });
});
