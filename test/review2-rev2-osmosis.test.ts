// Second review of the review-rev Osmosis change (7f1dd3c..50cb1ca): each block names the confirmed finding it guards
// (security-audit run-2 fixes/review2-rev2-osmosis.json).
import { describe, it, expect } from 'vitest';
import { parseOsmosisTx, type NormTx, type OsmoCtx, type RawEvent } from '../worker/src/parse/osmosis';
import { NAM, OSMOSIS } from '../worker/src/config';
import { isNamWhale } from '../worker/src/sources/discord';
import type { Flow } from '../shared/types';

const USDC = OSMOSIS.usdcDenom;
const P = 'osmo1m459jtgn77tz8cffvthq5jh0erswxu9872mjd9qde546mslc6udq85we5r'; // pool 3005
const ctx: OsmoCtx = {
  poolAddrs: new Map([[P, '3005']]),
  priceUsd: 0.0008,
  assets: new Map([[USDC, { symbol: 'USDC', decimals: 6, stable: true }]]),
};
const ev = (type: string, a: Record<string, string>): RawEvent => ({ type, attributes: Object.entries(a).map(([key, value]) => ({ key, value })) });
const tx = (hash: string, events: RawEvent[]): NormTx => ({ height: 1, hash, code: 0, ts: 1, events });
const nam = (n: number) => `${Math.round(n * 1e6)}${NAM.osmoDenom}`;
const usdc = (n: number) => `${Math.round(n * 1e6)}${USDC}`;
const xfer = (from: string, to: string, amount: string, msg: string) => ev('transfer', { recipient: to, sender: from, amount, msg_index: msg });
const rows = (fs: Flow[]) => fs.map((f) => [f.kind, f.from, f.to, f.amount]);
const whales = (fs: Flow[]) => fs.filter((f) => isNamWhale(f, 10000)).length;

// ------------------------------------------------------------------ a non-signer trader who pays a cut
describe('a swap whose trader is not the signer and pays a cut is one swap row: only the cut is a transfer', () => {
  const RELAYER = 'osmo1relayer', HOOK = 'osmo1hooks', E = 'osmo1skipentry', A = 'osmo1skipadapter', U = 'osmo1user', AFF = 'osmo1affiliate';
  /** A relayer's MsgRecvPacket (msg 1) whose ibc-hooks call has Skip's adapter buy 50,000 NAM in 3005 and hand it to the entry point. */
  const skip = (hash: string, after: RawEvent[]) => tx(hash, [
    ev('tx', { fee: '1000uosmo', fee_payer: RELAYER }),
    ev('message', { action: '/ibc.core.client.v1.MsgUpdateClient', sender: RELAYER, msg_index: '0' }),
    ev('message', { action: '/ibc.core.channel.v1.MsgRecvPacket', sender: RELAYER, msg_index: '1' }),
    ev('recv_packet', { packet_dst_channel: 'channel-750', packet_data: JSON.stringify({ denom: 'uusdc', amount: '1000000000', sender: 'noble1x', receiver: E }), msg_index: '1' }),
    xfer(OSMOSIS.transferModule, HOOK, usdc(1000), '1'),
    ev('fungible_token_packet', { module: 'transfer', denom: 'uusdc', amount: '1000000000', success: 'true', msg_index: '1' }),
    xfer(HOOK, E, usdc(1000), '1'),
    xfer(E, A, usdc(1000), '1'),
    xfer(A, OSMOSIS.takerFeeCollector, usdc(1), '1'),
    xfer(A, P, usdc(999), '1'),
    xfer(P, A, nam(50000), '1'),
    ev('token_swapped', { module: 'concentratedliquidity', sender: A, pool_id: '3005', tokens_in: usdc(999), tokens_out: nam(50000), msg_index: '1' }),
    xfer(A, E, nam(50000), '1'),
    ...after,
  ]);

  it('S1: Skip pays its affiliate 125 NAM, then delivers 49,875 to an Osmosis account: one buy to that account, the cut a transfer, one whale', () => {
    const p = parseOsmosisTx(skip('C1', [xfer(E, AFF, nam(125), '1'), xfer(E, U, nam(49875), '1')]), ctx);
    expect(rows(p.flows)).toEqual([['buy', null, U, 50000], ['transfer', E, AFF, 125]]);
    expect(p.flows[0].meta).toEqual({ trader: U });
    expect(whales(p.flows)).toBe(1);
    // the NAM itself is still on every account it touched
    expect(p.moves).toContainEqual(expect.objectContaining({ address: U, delta: 49875 }));
    expect(p.moves).toContainEqual(expect.objectContaining({ address: AFF, delta: 125 }));
  });

  it('two affiliates: still one buy to the account the NAM went to, each cut a transfer', () => {
    const p = parseOsmosisTx(skip('C2', [xfer(E, AFF, nam(100), '1'), xfer(E, 'osmo1aff2', nam(25), '1'), xfer(E, U, nam(49875), '1')]), ctx);
    expect(rows(p.flows)).toEqual([['buy', null, U, 50000], ['transfer', E, AFF, 100], ['transfer', E, 'osmo1aff2', 25]]);
    expect(whales(p.flows)).toBe(1);
  });

  it('the trader pays the cut itself once the NAM is delivered: one buy, the cut a transfer from the trader', () => {
    const p = parseOsmosisTx(skip('C3', [xfer(E, U, nam(50000), '1'), xfer(U, AFF, nam(125), '1')]), ctx);
    expect(rows(p.flows)).toEqual([['buy', null, U, 50000], ['transfer', U, AFF, 125]]);
    expect(whales(p.flows)).toBe(1);
  });

  it('control: a send by someone else in the same message is still a transfer, and the buy is still the trader\'s', () => {
    const p = parseOsmosisTx(skip('C4', [xfer(E, AFF, nam(125), '1'), xfer(E, U, nam(49875), '1'), xfer('osmo1x', 'osmo1y', nam(700), '1')]), ctx);
    expect(rows(p.flows)).toEqual([['buy', null, U, 50000], ['transfer', E, AFF, 125], ['transfer', 'osmo1x', 'osmo1y', 700]]);
  });

  it('control: Skip with a cut sending the rest on to Namada is the buy, the cut and the bridge-out, as before', () => {
    const p = parseOsmosisTx(skip('C5', [
      xfer(E, AFF, nam(125), '1'),
      xfer(E, OSMOSIS.transferModule, nam(49875), '1'),
      ev('burn', { burner: OSMOSIS.transferModule, amount: nam(49875), msg_index: '1' }),
      ev('send_packet', { packet_src_channel: NAM.osmoChannel, packet_sequence: '9', packet_data: JSON.stringify({ denom: `transfer/${NAM.osmoChannel}/${NAM.namadaToken}`, amount: '49875000000', sender: E, receiver: 'tnam1x' }), msg_index: '1' }),
      ev('ibc_transfer', { sender: E, receiver: 'tnam1x', denom: NAM.osmoDenom, amount: '49875000000', msg_index: '1' }),
    ]), ctx);
    expect(rows(p.flows)).toEqual([['buy', null, RELAYER, 50000], ['ibc_out', E, 'tnam1x', 49875], ['transfer', E, AFF, 125]]);
  });

  it('control: two equal deliveries name no one trader: the buy stays the signer\'s', () => {
    const p = parseOsmosisTx(skip('C6', [xfer(E, AFF, nam(125), '1'), xfer(E, U, nam(24937.5), '1'), xfer(E, 'osmo1other', nam(24937.5), '1')]), ctx);
    expect(p.flows[0]).toMatchObject({ kind: 'buy', to: RELAYER, meta: { trader: RELAYER } });
  });

  it('control: the account changed most is not the trader when it and the cuts do not make up the swap', () => {
    // the signer buys 50,000 itself and sends 49,000 of it to a friend: the friend's 49,000 is not the swap's 50,000
    const S = 'osmo1signer', F = 'osmo1friend';
    const p = parseOsmosisTx(tx('C7', [
      ev('tx', { fee_payer: S }),
      ev('message', { action: '/osmosis.poolmanager.v1beta1.MsgSwapExactAmountIn', sender: S, msg_index: '0' }),
      xfer(S, OSMOSIS.takerFeeCollector, usdc(1), '0'),
      xfer(S, P, usdc(999), '0'),
      xfer(P, S, nam(50000), '0'),
      ev('token_swapped', { module: 'concentratedliquidity', sender: S, pool_id: '3005', tokens_in: usdc(999), tokens_out: nam(50000), msg_index: '0' }),
      xfer(S, F, nam(49000), '0'),
    ]), ctx);
    expect(rows(p.flows)).toEqual([['buy', null, S, 50000], ['transfer', S, F, 49000]]);
  });

  describe('an authz grantee selling the granter\'s NAM through a router', () => {
    const GR = 'osmo1grantee', G = 'osmo1granter', E2 = 'osmo1entry', R = 'osmo1router';
    const sell = (hash: string, fund: RawEvent[], toPool: number) => tx(hash, [
      ev('tx', { fee_payer: GR }),
      ev('message', { action: '/cosmos.authz.v1beta1.MsgExec', sender: GR, msg_index: '0' }),
      ...fund,
      xfer(R, OSMOSIS.takerFeeCollector, nam(20), '0'),
      xfer(R, P, nam(toPool), '0'),
      xfer(P, R, usdc(18), '0'),
      ev('token_swapped', { module: 'gamm', sender: R, pool_id: '3005', tokens_in: nam(toPool), tokens_out: usdc(18), msg_index: '0' }),
    ]);

    it('S5: the bot takes a 20 NAM service fee from the granter, then sells its 20,000: one sell from the granter, the fee a transfer, one whale', () => {
      const p = parseOsmosisTx(sell('A1', [xfer(G, GR, nam(20), '0'), xfer(G, E2, nam(20000), '0'), xfer(E2, R, nam(20000), '0')], 19980), ctx);
      expect(rows(p.flows)).toEqual([['sell', G, null, 19980], ['transfer', G, GR, 20]]);
      expect(p.flows[0].meta).toEqual({ trader: G });
      expect(whales(p.flows)).toBe(1);
    });

    it('the entry point keeps a 20 NAM cut of the granter\'s 20,000 before the router sells the rest: one sell from the granter, the cut a transfer', () => {
      const p = parseOsmosisTx(sell('A2', [xfer(G, E2, nam(20000), '0'), xfer(E2, 'osmo1aff', nam(20), '0'), xfer(E2, R, nam(19980), '0')], 19960), ctx);
      expect(rows(p.flows)).toEqual([['sell', G, null, 19960], ['transfer', E2, 'osmo1aff', 20]]);
      expect(whales(p.flows)).toBe(1);
    });
  });
});
