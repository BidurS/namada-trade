// Review of 42971be..7f1dd3c, Namada parser:
// 1. The NAM fee the shielded pool pays for a transfer of another coin (block 8,294,006) is NAM leaving the pool and
//    is counted in the pool's daily outflow, as the same fee on a NAM unshield is.
// 2. Only a gas payer's leg is ever filed as the pool's fee, and a shield's side output is a transfer of its own: no
//    leg of an event is kept out of the flows except the pool's fee.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseNamadaBlock, type NamadaParsed } from '../worker/src/parse/namada';
import { dayAggregates, type DayFlowRow } from '../worker/src/series';
import { NAM, NAMADA } from '../worker/src/config';

const I = NAMADA.internal;
const MASP = I.masp;
const NAMT = NAM.namadaToken;
const OSMO = 'tnam1p5z8ruwyu7ha8urhq2l0dhpk2f5dv3ts7uyf2n75';
const USER = 'tnam1qq6wus66shjjwhe48c3udfyrh05vq62s0ysy3flp';
const GAS = 'tnam1qrx2535e248p02ha8n7w2n76y4xjacu2ncucqhvw'; // the gas payer of block 8,288,955

type L = [string, string, string]; // account, token, base units
const ev = (hash: string, src: L[], dst: L[]) => ({
  type: 'token/transfer',
  attributes: [
    { key: 'token-event-descriptor', value: 'transfer-from-wasm' },
    { key: 'hash', value: hash },
    { key: 'inner-tx-hash', value: hash.replace(/A/g, 'C') },
    { key: 'source-accounts', value: JSON.stringify(src.map(([a, t, n]) => [[`internal-address/${a}`, t], n])) },
    { key: 'target-accounts', value: JSON.stringify(dst.map(([a, t, n]) => [[`internal-address/${a}`, t], n])) },
  ],
});
const parse = (e: ReturnType<typeof ev>) => parseNamadaBlock({ height: 8294006, ts: 1000, events: [e] }, null);
const rowsOf = (p: NamadaParsed): DayFlowRow[] =>
  p.flows.map((f) => ({ id: f.id, chain: f.chain, ts: f.ts, kind: f.kind, from_addr: f.from, to_addr: f.to, amount_num: f.amount, value_usd: f.valueUsd, meta: JSON.stringify(f.meta) }));
/** What the pool's NAM balance lost in the event, from the balance moves (the chain's own legs). */
const poolOut = (p: NamadaParsed) => -p.moves.filter((m) => m.address === MASP && m.delta < 0).reduce((s, m) => s + m.delta, 0);

describe('the pool\'s NAM fee next to another coin is pool outflow', () => {
  it('block 8,294,006 (OSMO unshield, the pool pays the gas payer 0.084159 NAM): masp.out_daily is 0.084159', () => {
    const p = parse(ev('AE'.repeat(32), [[MASP, NAMT, '84159'], [MASP, OSMO, '20000000']], [[USER, OSMO, '20000000'], [GAS, NAMT, '84159']]));
    expect(poolOut(p)).toBeCloseTo(0.084159, 9);
    expect(dayAggregates(rowsOf(p), []).metrics['masp.out_daily']).toBeCloseTo(poolOut(p), 9);
    // kept on the OSMO row under the key pool accounting reads, the same key as on a NAM unshield
    expect(p.flows).toHaveLength(1);
    expect(p.flows[0].meta).toMatchObject({ tokenSymbol: 'OSMO', maspFeeNam: 0.084159 });
  });

  it('the same fee on a NAM unshield gives the same reading (10 NAM out plus the fee)', () => {
    const p = parse(ev('AF'.repeat(32), [[MASP, NAMT, '10084159']], [[USER, NAMT, '10000000'], [GAS, NAMT, '84159']]));
    expect(dayAggregates(rowsOf(p), []).metrics['masp.out_daily']).toBeCloseTo(poolOut(p), 9);
    expect(poolOut(p)).toBeCloseTo(10.084159, 9);
  });

  it('an older row\'s feeNam (every NAM source of the event, whoever sent it) is never read as the pool\'s fee', () => {
    const legacy: DayFlowRow = { id: 'namada:OLD:0', chain: 'namada', ts: 1000, kind: 'unshield', from_addr: MASP, to_addr: USER, amount_num: 20, value_usd: null, meta: JSON.stringify({ tokenSymbol: 'OSMO', feeNam: 1_000_000.084159 }) };
    expect(dayAggregates([legacy], []).metrics['masp.out_daily']).toBe(0);
  });
});

describe('only the pool paying a gas payer is a fee; every other leg is a flow', () => {
  it('block 4,707,359 (10.1 NAM from one account: 10 shielded, 0.1 to another account): the 0.1 is a transfer of its own', () => {
    const r = JSON.parse(readFileSync(new URL('./fixtures/namada_block_4707359.json', import.meta.url), 'utf8')).result;
    const p = parseNamadaBlock({ height: 4707359, ts: 1, events: [...(r.end_block_events ?? [])] }, null);
    const X = 'tnam1qpqfsmj2quxnakfq0rn8y2tjcvtz26f8pyw4fq98';
    const T = 'tnam1qrxsru5rdu4he400xny6p779fcw7xuftsgjnmzup';
    const base = 'namada:DFE3007F915A378E822BEF607E175145219A4ABFD196DEFBF47F62018C39A091:1';
    expect(p.flows.map((f) => [f.id, f.kind, f.from, f.to, f.amount])).toEqual([
      [base, 'shield', X, MASP, 10],
      [`${base}:1`, 'transfer', X, T, 0.1],
    ]);
    expect(p.flows[0].meta).not.toHaveProperty('otherNam');
    // every NAM leg of the event is in the flows
    expect(p.flows.reduce((s, f) => s + f.amount, 0)).toBeCloseTo(-p.moves.filter((m) => m.delta < 0).reduce((s, m) => s + m.delta, 0), 9);
  });

  it('block 4,622,311 shape (11 NAM: 10 shielded, 1 to another account): the receiver has its 1 NAM flow', () => {
    const p = parse(ev('A2'.repeat(32), [[USER, NAMT, '11000000']], [[MASP, NAMT, '10000000'], [GAS, NAMT, '1000000']]));
    expect(p.flows.map((f) => [f.kind, f.from, f.to, f.amount])).toEqual([['shield', USER, MASP, 10], ['transfer', USER, GAS, 1]]);
  });

  it('a shielded bridge send of 0.05 NAM next to a 0.1 NAM pool leg: the escrow leg is the bridge send, no leg is a fee', () => {
    const p = parse(ev('A3'.repeat(32), [[MASP, NAMT, '150000']], [[GAS, NAMT, '100000'], [I.ibc, NAMT, '50000']]));
    const out = p.flows.find((f) => f.to === I.ibc)!;
    expect(out).toMatchObject({ kind: 'ibc_out', from: MASP, amount: 0.05 });
    expect(p.flows.some((f) => f.meta?.maspFeeNam != null)).toBe(false);
    expect(p.flows.reduce((s, f) => s + f.amount, 0)).toBeCloseTo(poolOut(p), 9);
  });

  it('2 NAM from the pool into the staking account next to a 100 NAM unshield is a flow of its own, not the pool\'s fee', () => {
    const p = parse(ev('A4'.repeat(32), [[MASP, NAMT, '102000000']], [[USER, NAMT, '100000000'], [I.pos, NAMT, '2000000']]));
    // the staking account's balance moved by a wasm transfer is 'pos_balance' (classify)
    expect(p.flows.map((f) => [f.kind, f.to, f.amount])).toEqual([['unshield', USER, 100], ['pos_balance', I.pos, 2]]);
    expect(p.flows[0].meta).not.toHaveProperty('maspFeeNam');
  });

  it('next to another coin, a pool NAM leg into the bridge escrow is a bridge send, not the pool\'s fee', () => {
    const p = parse(ev('A5'.repeat(32), [[MASP, NAMT, '50000'], [MASP, OSMO, '1000000']], [[I.ibc, OSMO, '1000000'], [I.ibc, NAMT, '50000']]));
    const nam = p.flows.filter((f) => !f.meta?.tokenSymbol);
    expect(nam).toHaveLength(1);
    expect(nam[0]).toMatchObject({ kind: 'ibc_out', from: MASP, to: I.ibc, amount: 0.05 });
    const osmo = p.flows.find((f) => f.meta?.tokenSymbol)!;
    expect(osmo.meta).not.toHaveProperty('maspFeeNam');
    expect(osmo.meta?.feeNam).toBeUndefined();
  });

  it('the gas payer\'s leg of an unshield is still the pool\'s fee (blocks 8,288,955 and 7,011,473)', () => {
    const p = parse(ev('A6'.repeat(32), [[MASP, NAMT, '14700144159']], [[USER, NAMT, '14700000000'], [GAS, NAMT, '144159']]));
    expect(p.flows).toHaveLength(1);
    expect(p.flows[0]).toMatchObject({ kind: 'unshield', to: USER, amount: 14700, meta: { maspFeeNam: 0.144159 } });
  });
});
