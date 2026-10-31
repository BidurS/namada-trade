// Review of the review C Osmosis change (42971be..7f1dd3c): each block names the confirmed finding it guards
// (security review, 2026-10-21).
import { describe, it, expect } from 'vitest';
import { parseOsmosisTx, type NormTx, type OsmoCtx, type RawEvent } from '../worker/src/parse/osmosis';
import { NAM, OSMOSIS } from '../worker/src/config';
import { isNamWhale } from '../worker/src/sources/discord';
import type { Flow } from '../shared/types';

const USDC = OSMOSIS.usdcDenom;
const P = 'osmo1m459jtgn77tz8cffvthq5jh0erswxu9872mjd9qde546mslc6udq85we5r'; // pool 3005
const SP = 'osmo1n6mm8p4dzd9fe3aly9uzfxx963zxf3ah8vurl4lqm5ggnk0q2vuskr0rtv'; // its spread account
const P3368 = 'osmo1h6zkrf476ha3csjmgf6eneh3p43ltmjlppvyzpmpyfxts0zk3k0s288e7l';
const S3368 = 'osmo1r0wmz495qty98wp7fuwn5g0zwnktuy0meqcw656y5zxnnufusr3sqfqeal';
const ctx: OsmoCtx = {
  poolAddrs: new Map([[P, '3005'], [P3368, '3368'], ['osmo1pool9', '9']]),
  priceUsd: 0.0008,
  assets: new Map([[USDC, { symbol: 'USDC', decimals: 6, stable: true }], ['uosmo', { symbol: 'OSMO', decimals: 6 }]]),
};
const ev = (type: string, a: Record<string, string>): RawEvent => ({ type, attributes: Object.entries(a).map(([key, value]) => ({ key, value })) });
const tx = (hash: string, events: RawEvent[]): NormTx => ({ height: 1, hash, code: 0, ts: 1, events });
const nam = (n: number) => `${Math.round(n * 1e6)}${NAM.osmoDenom}`;
const usdc = (n: number) => `${Math.round(n * 1e6)}${USDC}`;
const osmo = (n: number) => `${Math.round(n * 1e6)}uosmo`;
const xfer = (from: string, to: string, amount: string, msg?: string) => ev('transfer', { recipient: to, sender: from, amount, ...(msg !== undefined ? { msg_index: msg } : {}) });
const rows = (fs: Flow[]) => fs.map((f) => [f.kind, f.from, f.to, f.amount]);

// ------------------------------------------------------------------ non-signer trader (Skip / ibc-hooks, authz, a keeper-run vault)
describe('a swap whose trader is not the signer is one swap row: its delivery or funding leg is not a transfer too', () => {
  const RELAYER = 'osmo1relayer', HOOK = 'osmo1hooks', E = 'osmo1skipentry', A = 'osmo1skipadapter', U = 'osmo1user';
  /** A relayer's MsgRecvPacket whose ibc-hooks call has Skip's adapter buy 50,000 NAM in 3005 and hand it to the entry point. */
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

  it('Skip delivers the 50,000 NAM it bought to an Osmosis account: one buy to that account, one whale post', () => {
    const p = parseOsmosisTx(skip('S1', [xfer(E, U, nam(50000), '1')]), ctx);
    expect(rows(p.flows)).toEqual([['buy', null, U, 50000]]);
    // the trade's NAM legs ride along (meta.legs, 2026-10-31: the depth check compares a trade at its NAM pools)
    expect(p.flows[0].meta).toEqual({ trader: U, legs: expect.any(Array) });
    expect(p.flows.filter((f) => isNamWhale(f, 10000))).toHaveLength(1);
    // the NAM itself is still on every account it touched
    expect(p.moves).toContainEqual(expect.objectContaining({ address: U, delta: 50000 }));
  });

  it('control: a send by someone else in the same message is still a transfer', () => {
    const p = parseOsmosisTx(skip('S2', [xfer(E, U, nam(50000), '1'), xfer('osmo1x', 'osmo1y', nam(70000), '1')]), ctx);
    expect(rows(p.flows)).toEqual([['buy', null, U, 50000], ['transfer', 'osmo1x', 'osmo1y', 70000]]);
  });

  it('control: Skip sending the NAM on to Namada is the buy and its bridge-out, as before', () => {
    const p = parseOsmosisTx(skip('S3', [
      xfer(E, OSMOSIS.transferModule, nam(50000), '1'),
      ev('burn', { burner: OSMOSIS.transferModule, amount: nam(50000), msg_index: '1' }),
      ev('send_packet', { packet_src_channel: NAM.osmoChannel, packet_sequence: '9', packet_data: JSON.stringify({ denom: `transfer/${NAM.osmoChannel}/${NAM.namadaToken}`, amount: '50000000000', sender: E, receiver: 'tnam1x' }), msg_index: '1' }),
      ev('ibc_transfer', { sender: E, receiver: 'tnam1x', denom: NAM.osmoDenom, amount: '50000000000', msg_index: '1' }),
    ]), ctx);
    expect(p.flows.map((f) => f.kind)).toEqual(['buy', 'ibc_out']);
  });

  it('an authz grantee selling the granter\'s 20,000 NAM through a router: one sell from the granter', () => {
    const GR = 'osmo1grantee', G = 'osmo1granter', E2 = 'osmo1entry', R = 'osmo1router';
    const p = parseOsmosisTx(tx('AZ', [
      ev('tx', { fee_payer: GR }),
      ev('message', { action: '/cosmos.authz.v1beta1.MsgExec', sender: GR, msg_index: '0' }),
      xfer(G, E2, nam(20000), '0'),
      xfer(E2, R, nam(20000), '0'),
      xfer(R, OSMOSIS.takerFeeCollector, nam(20), '0'),
      xfer(R, P, nam(19980), '0'),
      xfer(P, R, usdc(18), '0'),
      ev('token_swapped', { module: 'gamm', sender: R, pool_id: '3005', tokens_in: nam(19980), tokens_out: usdc(18), msg_index: '0' }),
    ]), ctx);
    expect(rows(p.flows)).toEqual([['sell', G, null, 19980]]);
    expect(p.flows[0].meta).toEqual({ trader: G, legs: expect.any(Array) });
  });

  it('a keeper running a vault\'s buy for its owner: one buy to the owner', () => {
    const K = 'osmo1keeper', V = 'osmo1vault', O = 'osmo1owner';
    const p = parseOsmosisTx(tx('D1', [
      ev('tx', { fee_payer: K }),
      ev('message', { action: '/cosmwasm.wasm.v1.MsgExecuteContract', sender: K, msg_index: '0' }),
      xfer(V, OSMOSIS.takerFeeCollector, usdc(1), '0'),
      xfer(V, P, usdc(999), '0'),
      xfer(P, V, nam(50000), '0'),
      ev('token_swapped', { sender: V, pool_id: '3005', tokens_in: usdc(999), tokens_out: nam(50000), msg_index: '0' }),
      xfer(V, O, nam(50000), '0'),
    ]), ctx);
    expect(rows(p.flows)).toEqual([['buy', null, O, 50000]]);
  });
});

// ------------------------------------------------------------------ exact-out taker fee after token_swapped
describe('an exact-out swap pays its NAM taker fee after token_swapped, and that fee is the swap\'s, not a transfer', () => {
  const S = 'osmo1seller';
  const head = [ev('tx', { fee_payer: S })];

  it('exact-out sell of 9,980 NAM in 3005: one sell, no transfer to the taker-fee collector', () => {
    const p = parseOsmosisTx(tx('XO', [
      ...head,
      ev('message', { action: '/osmosis.poolmanager.v1beta1.MsgSwapExactAmountOut', sender: S, msg_index: '0' }),
      xfer(S, P, nam(9980), '0'),
      xfer(S, SP, nam(20), '0'),
      xfer(P, S, usdc(9), '0'),
      ev('token_swapped', { module: 'gamm', sender: S, pool_id: '3005', tokens_in: nam(9980), tokens_out: usdc(9), msg_index: '0' }),
      xfer(S, OSMOSIS.takerFeeCollector, nam(10), '0'),
    ]), ctx);
    expect(rows(p.flows)).toEqual([['sell', S, null, 9980]]);
    expect(p.flows[0]).toMatchObject({ counterDenom: 'USDC', counterAmount: 9 });
    expect(p.moves).toContainEqual(expect.objectContaining({ address: OSMOSIS.takerFeeCollector, delta: 10 }));
  });

  it('control: the same trade in exact-in order is the same single row', () => {
    const p = parseOsmosisTx(tx('XI', [
      ...head,
      ev('message', { action: '/osmosis.poolmanager.v1beta1.MsgSwapExactAmountIn', sender: S, msg_index: '0' }),
      xfer(S, OSMOSIS.takerFeeCollector, nam(10), '0'),
      xfer(S, P, nam(9980), '0'),
      xfer(S, SP, nam(20), '0'),
      xfer(P, S, usdc(9), '0'),
      ev('token_swapped', { module: 'gamm', sender: S, pool_id: '3005', tokens_in: nam(9980), tokens_out: usdc(9), msg_index: '0' }),
    ]), ctx);
    expect(rows(p.flows)).toEqual([['sell', S, null, 9980]]);
  });

  it('exact-out USDC -> NAM -> OSMO, NAM the second hop\'s input: one row, no transfer', () => {
    const p = parseOsmosisTx(tx('XM', [
      ...head,
      ev('message', { action: '/osmosis.poolmanager.v1beta1.MsgSwapExactAmountOut', sender: S, msg_index: '0' }),
      xfer(S, P, usdc(10), '0'),
      xfer(P, S, nam(10010), '0'),
      ev('token_swapped', { module: 'gamm', sender: S, pool_id: '3005', tokens_in: usdc(10), tokens_out: nam(10010), msg_index: '0' }),
      xfer(S, OSMOSIS.takerFeeCollector, usdc(0.01), '0'),
      xfer(S, 'osmo1pool9', nam(10000), '0'),
      xfer('osmo1pool9', S, osmo(5), '0'),
      ev('token_swapped', { module: 'gamm', sender: S, pool_id: '9', tokens_in: nam(10000), tokens_out: osmo(5), msg_index: '0' }),
      xfer(S, OSMOSIS.takerFeeCollector, nam(10), '0'),
    ]), ctx);
    expect(p.flows.map((f) => f.kind)).toEqual(['other']);
  });
});

// ------------------------------------------------------------------ ProtoRev's post-handler legs pooled with the user's swap
describe('the post-handler\'s swaps (ProtoRev\'s backrun, no msg_index) are never part of the signer\'s swap row', () => {
  const PR = 'osmo17qdmjdumw4xawam4g46gtwzle5rd4zwyfqvvza', U = 'osmo12laa7fnv79602cqyzjrc3ah257pdkzyfjcfer4';
  const m0 = (msg = true) => (msg ? { msg_index: '0' } : {});
  /** tx D5163D96... at height 72033673: the user sells 49,850.1 NAM into 3005 (exact-in). */
  const user = (msg = true) => [
    ev('tx', { fee_payer: U }),
    ev('message', { action: '/osmosis.poolmanager.v1beta1.MsgSwapExactAmountIn', sender: U, ...m0(msg) }),
    ev('transfer', { recipient: OSMOSIS.takerFeeCollector, sender: U, amount: nam(50), ...m0(msg) }),
    ev('transfer', { recipient: P, sender: U, amount: nam(49850.1), ...m0(msg) }),
    ev('transfer', { recipient: SP, sender: U, amount: nam(99.9), ...m0(msg) }),
    ev('transfer', { recipient: U, sender: P, amount: usdc(39.08), ...m0(msg) }),
    ev('token_swapped', { module: 'concentratedliquidity', sender: U, pool_id: '3005', tokens_in: nam(49850.1), tokens_out: usdc(39.08), ...m0(msg) }),
  ];
  /** ProtoRev's backrun in the post-handler: USDC -> NAM (3005) -> OSMO (3368) -> USDC (1464). */
  const backrun = [
    xfer(PR, P, usdc(8.1)),
    xfer(P, PR, nam(10261.499867)),
    ev('token_swapped', { module: 'concentratedliquidity', sender: PR, pool_id: '3005', tokens_in: usdc(8.1), tokens_out: nam(10261.499867) }),
    xfer(PR, P3368, nam(10004.962371)),
    xfer(PR, S3368, nam(256.537496)),
    xfer(P3368, PR, osmo(40)),
    ev('token_swapped', { module: 'concentratedliquidity', sender: PR, pool_id: '3368', tokens_in: nam(10004.962371), tokens_out: osmo(40) }),
    xfer(PR, 'osmo1poolosmousdc', osmo(40)),
    xfer('osmo1poolosmousdc', PR, usdc(8.2)),
    ev('token_swapped', { module: 'gamm', sender: PR, pool_id: '1464', tokens_in: osmo(40), tokens_out: usdc(8.2) }),
    ev('protorev_backrun', { user_pool_id: '3005' }),
  ];
  const sellRow = (f: Flow) => [f.id, f.kind, f.from, f.amount, f.counterDenom, f.counterAmount, f.poolId];

  it('a backrun after the user\'s sell leaves the sell its own coin, price and pool; the backrun is its own row', () => {
    const alone = parseOsmosisTx(tx('U1', user()), ctx).flows;
    const p = parseOsmosisTx(tx('U1', [...user(), ...backrun]), ctx);
    const [mine, post, ...rest] = p.flows;
    expect(sellRow(mine)).toEqual(['osmosis:U1:swap', 'sell', U, 49850.1, 'USDC', 39.08, '3005']);
    expect(mine.priceUsd).toBeCloseTo(39.08 / 49850.1, 12);
    expect(mine).toEqual(alone[0]);
    expect(post).toMatchObject({ id: 'osmosis:U1:post_swap', kind: 'other', from: PR, to: null, poolId: '3005,3368', meta: { arb: true, postHandler: true } });
    expect(post.amount).toBeCloseTo(10261.499867, 6);
    // its pool legs are the backrun's swaps, not liquidity or transfers
    expect(rest).toEqual([]);
  });

  it('a backrun after a swap that moved no NAM is the transaction\'s swap row, named for the post-handler, not the signer', () => {
    const p = parseOsmosisTx(tx('U2', [
      ev('tx', { fee_payer: U }),
      ev('message', { action: '/osmosis.poolmanager.v1beta1.MsgSwapExactAmountIn', sender: U, msg_index: '0' }),
      xfer(U, 'osmo1poolosmousdc', osmo(100), '0'),
      xfer('osmo1poolosmousdc', U, usdc(20), '0'),
      ev('token_swapped', { module: 'gamm', sender: U, pool_id: '1464', tokens_in: osmo(100), tokens_out: usdc(20), msg_index: '0' }),
      ...backrun,
    ]), ctx);
    expect(p.flows.map((f) => [f.id, f.kind, f.from])).toEqual([['osmosis:U2:swap', 'other', PR]]);
  });

  it('control: a transaction from before msg_index cannot tell them apart and keeps one swap row', () => {
    const p = parseOsmosisTx(tx('U3', [...user(false), ...backrun]), ctx);
    expect(p.flows.map((f) => f.id)).toEqual(['osmosis:U3:swap']);
  });
});

// ------------------------------------------------------------------ a pool is never a settled pass-through
describe('a deposit into the pool the NAM was just bought from is liquidity, whatever its size', () => {
  const U = 'osmo1user', Z = 'osmo1zap';
  const zap = (hash: string, deposit: RawEvent[], before: RawEvent[] = []) => tx(hash, [
    ev('tx', { fee_payer: U }),
    ev('message', { action: '/cosmwasm.wasm.v1.MsgExecuteContract', sender: U, msg_index: '0' }),
    xfer(U, Z, usdc(20), '0'),
    ...before,
    xfer(Z, OSMOSIS.takerFeeCollector, usdc(0.01), '0'),
    xfer(Z, P, usdc(9.99), '0'),
    xfer(P, Z, nam(11000), '0'),
    ev('token_swapped', { module: 'concentratedliquidity', sender: Z, pool_id: '3005', tokens_in: usdc(9.99), tokens_out: nam(11000), msg_index: '0' }),
    ...deposit,
    ev('create_position', { pool_id: '3005', sender: Z, msg_index: '0' }),
  ]);

  it('a zap buying 11,000 NAM and depositing exactly 11,000: the buy and an lp_add of 11,000', () => {
    const p = parseOsmosisTx(zap('Z1', [xfer(Z, P, `${nam(11000)},${usdc(10)}`, '0')]), ctx);
    expect(p.flows.map((f) => [f.kind, f.amount, f.poolId])).toEqual([['buy', 11000, '3005'], ['lp_add', 11000, '3005']]);
    // control: one NAM less was recorded before too
    const q = parseOsmosisTx(zap('Z2', [xfer(Z, P, `${nam(10999)},${usdc(10)}`, '0')]), ctx);
    expect(q.flows.map((f) => [f.kind, f.amount])).toEqual([['buy', 11000], ['lp_add', 10999]]);
  });

  it('a vault that withdraws 5,000 NAM, buys 11,000 and deposits all 16,000: both its liquidity legs are recorded', () => {
    const p = parseOsmosisTx(zap('Z3', [xfer(Z, P, nam(16000), '0')], [xfer(P, Z, nam(5000), '0'), ev('withdraw_position', { pool_id: '3005', msg_index: '0' })]), ctx);
    expect(p.flows.map((f) => [f.kind, f.amount])).toEqual([['buy', 11000], ['lp_add', 16000], ['lp_remove', 5000]]);
  });
});
