// Review C (2026-10-21), the Osmosis parser and the executed price: each block names the lead it guards
// (security review, 2026-10-21).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normFromTxSearch, parseOsmosisTx, shortDenom, type NormTx, type OsmoCtx, type RawEvent } from '../worker/src/parse/osmosis';
import { NAM, OSMOSIS } from '../worker/src/config';
import { stmt } from '../worker/src/db';
import { testD1, insert, runStmts } from './d1-sqlite';
import { SINGLE_POOL_USDC_SWAP, priceVsExecution, unpairedCrossings } from '../worker/src/cron';
import { swapHourStmts, type SwapRow } from '../worker/src/series';
import { SWAP_HOUR_SQL } from '../worker/src/series-sql';
import { priceSourceOf } from '../worker/src/series-api';
import { timedOutSends, ibcRowOf, pressure, osmosisNetIbc } from '../worker/src/analytics';
import type { Flow } from '../shared/types';

const fx = (n: string) => JSON.parse(readFileSync(join(__dirname, 'fixtures', n), 'utf8'));
const H = 3600000;
const USDC = OSMOSIS.usdcDenom;
const ctx: OsmoCtx = {
  poolAddrs: new Map(),
  priceUsd: 0.00087,
  assets: new Map([
    [USDC, { symbol: 'USDC', decimals: 6, stable: true }],
    ['uosmo', { symbol: 'OSMO', decimals: 6 }],
  ]),
};
const ev = (type: string, a: Record<string, string>): RawEvent => ({ type, attributes: Object.entries(a).map(([key, value]) => ({ key, value })) });
const tx = (hash: string, events: RawEvent[], ts = 1): NormTx => ({ height: 1, hash, code: 0, ts, events });
const attrOf = (e: RawEvent, k: string) => e.attributes.find((x) => x.key === k)?.value;
const setAttr = (e: RawEvent, k: string, v: string) => {
  const a = e.attributes.find((x) => x.key === k);
  if (a) a.value = v; else e.attributes.push({ key: k, value: v });
};
const nam = (n: number) => `${Math.round(n * 1e6)}${NAM.osmoDenom}`;
const usdc = (n: number) => `${Math.round(n * 1e6)}${USDC}`;
const rowOf = (f: Flow): SwapRow => ({
  id: f.id, ts: f.ts, kind: f.kind, amount_num: f.amount, counter_denom: f.counterDenom ?? null, counter_amount: f.counterAmount ?? null,
  pool_id: f.poolId ?? null, value_usd: f.valueUsd, from_addr: f.from, to_addr: f.to, meta: f.meta,
});
const metricsOf = (rows: SwapRow[], hour: number) => Object.fromEntries(swapHourStmts(rows, hour).map((s) => [s.params[1], s.params[2]]));

// ------------------------------------------------------------------ isSwap-gate-drops-transfer-and-lp-flows
describe('a NAM swap in a transaction no longer hides its other NAM moves', () => {
  const dust = (msg: string) => ev('token_swapped', { pool_id: '3005', tokens_in: nam(0.1), tokens_out: `87${USDC}`, msg_index: msg });

  it('a MsgSend of 1,000,000 NAM beside a 0.1 NAM swap is a transfer flow (the attacker input of the validation plan)', () => {
    const send = ev('transfer', { recipient: 'osmo1F', sender: 'osmo1V', amount: nam(1_000_000), msg_index: '0' });
    const p = parseOsmosisTx(tx('H', [send, dust('1')]), ctx);
    expect(p.moves).toContainEqual(expect.objectContaining({ address: 'osmo1V', delta: -1_000_000 }));
    expect(p.moves).toContainEqual(expect.objectContaining({ address: 'osmo1F', delta: 1_000_000 }));
    expect(p.flows.map((f) => f.id).sort()).toEqual(['osmosis:H:swap', 'osmosis:H:xfer:0']);
    expect(p.flows.find((f) => f.kind === 'transfer')).toMatchObject({ from: 'osmo1V', to: 'osmo1F', amount: 1_000_000 });
    expect(p.flows.find((f) => f.id.endsWith(':swap'))).toMatchObject({ kind: 'sell', amount: 0.1 });
    // control: the same send alone is the same transfer flow
    expect(parseOsmosisTx(tx('H', [send]), ctx).flows.map((f) => [f.id, f.amount])).toEqual([['osmosis:H:xfer:0', 1_000_000]]);
  });

  it('a pool exit beside a dust swap is still an lp_remove', () => {
    const lp: OsmoCtx = { ...ctx, poolAddrs: new Map([['osmo1POOL', '3005']]) };
    const exit = ev('transfer', { recipient: 'osmo1V', sender: 'osmo1POOL', amount: nam(500_000), msg_index: '0' });
    const p = parseOsmosisTx(tx('H', [exit, dust('1')]), lp);
    expect(p.flows.find((f) => f.kind === 'lp_remove')).toMatchObject({ amount: 500_000, poolId: '3005' });
    expect(parseOsmosisTx(tx('H', [exit]), lp).flows.find((f) => f.kind === 'lp_remove')).toMatchObject({ amount: 500_000 });
  });

  it('a send inside the swap message itself (authz, a contract) is recorded; the swap\'s own legs still are not', () => {
    const raw = fx('osmo_swap.json')[0];
    const events: any[] = raw.tx_result.events;
    const signer = 'osmo1f56eqgwm6zz73plfvwhamquugjr2ewnusveral';
    // after the MsgSwapExactAmountIn message event, before the swap's first bank leg: where an authz MsgExec puts an inner MsgSend
    const at = events.findIndex((e) => e.type === 'message' && attrOf(e, 'action')?.includes('MsgSwapExactAmountIn')) + 1;
    events.splice(at, 0, ev('transfer', { recipient: 'osmo1friend', sender: signer, amount: nam(1_000_000), msg_index: '0' }));
    const p = parseOsmosisTx(normFromTxSearch(raw, 1), { ...ctx, poolAddrs: new Map([['osmo1m459jtgn77tz8cffvthq5jh0erswxu9872mjd9qde546mslc6udq85we5r', '3005']]) });
    expect(p.flows.filter((f) => f.kind === 'transfer').map((f) => [f.from, f.to, f.amount])).toEqual([[signer, 'osmo1friend', 1_000_000]]);
    expect(p.flows.filter((f) => f.kind === 'lp_add' || f.kind === 'lp_remove')).toEqual([]);
    expect(p.flows.find((f) => f.id.endsWith(':swap'))).toMatchObject({ kind: 'sell', amount: 1994.004 });
  });

  it('the real swaps (direct, routed, a router contract) give one swap row and no transfer or LP row: nothing counted twice', () => {
    const pools: OsmoCtx = {
      ...ctx,
      poolAddrs: new Map([
        ['osmo1m459jtgn77tz8cffvthq5jh0erswxu9872mjd9qde546mslc6udq85we5r', '3005'],
        ['osmo1rcl39flt5ua3t92vtwj7xllj9u2ucmrsjdhl945jc25f6zxvnvns5rtv6l', '3009'],
        ['osmo1h6zkrf476ha3csjmgf6eneh3p43ltmjlppvyzpmpyfxts0zk3k0s288e7l', '3368'],
      ]),
    };
    const [direct, router, routed] = fx('osmo_swap.json').map((t: any) => parseOsmosisTx(normFromTxSearch(t, 1), pools));
    for (const p of [direct, router, routed]) expect(p.flows.map((f) => f.kind)).toEqual([expect.stringMatching(/^(buy|sell|other)$/)]);
    expect(direct.flows[0]).toMatchObject({ kind: 'sell', amount: 1994.004, counterDenom: 'USDC', counterAmount: 1.740431, poolId: '3005' });
    expect(direct.flows[0].priceUsd).toBeCloseTo(1.740431 / 1994.004, 12);
    expect(router.flows[0]).toMatchObject({ kind: 'other', meta: { arb: true } });
    expect(routed.flows[0]).toMatchObject({ kind: 'other', meta: { arb: true } });
  });

  it('a router that delivers the bought NAM through its entry contract is the swap, not a transfer; its affiliate cut is a transfer', () => {
    const U = 'osmo1user', E = 'osmo1entry', R = 'osmo1router', P = 'osmo1pool3005', A = 'osmo1affiliate';
    const legs = (deliver: RawEvent[]) => [
      ev('message', { action: '/cosmwasm.wasm.v1.MsgExecuteContract', sender: U, msg_index: '0' }),
      ev('transfer', { recipient: E, sender: U, amount: usdc(1), msg_index: '0' }),
      ev('transfer', { recipient: R, sender: E, amount: usdc(1), msg_index: '0' }),
      ev('transfer', { recipient: OSMOSIS.takerFeeCollector, sender: R, amount: usdc(0.001), msg_index: '0' }),
      ev('transfer', { recipient: P, sender: R, amount: usdc(0.999), msg_index: '0' }),
      ev('transfer', { recipient: R, sender: P, amount: nam(1150), msg_index: '0' }),
      ev('token_swapped', { module: 'gamm', sender: R, pool_id: '3005', tokens_in: usdc(0.999), tokens_out: nam(1150), msg_index: '0' }),
      ...deliver,
    ];
    const plain = parseOsmosisTx(tx('R1', legs([
      ev('transfer', { recipient: E, sender: R, amount: nam(1150), msg_index: '0' }),
      ev('transfer', { recipient: U, sender: E, amount: nam(1150), msg_index: '0' }),
    ])), { ...ctx, poolAddrs: new Map([[P, '3005']]) });
    expect(plain.flows.map((f) => [f.kind, f.to, f.amount])).toEqual([['buy', U, 1150]]);
    const cut = parseOsmosisTx(tx('R2', legs([
      ev('transfer', { recipient: A, sender: R, amount: nam(1.15), msg_index: '0' }),
      ev('transfer', { recipient: E, sender: R, amount: nam(1148.85), msg_index: '0' }),
      ev('transfer', { recipient: U, sender: E, amount: nam(1148.85), msg_index: '0' }),
    ])), { ...ctx, poolAddrs: new Map([[P, '3005']]) });
    expect(cut.flows.filter((f) => f.kind === 'transfer').map((f) => [f.from, f.to, f.amount])).toEqual([[R, A, 1.15]]);
  });
});

// ------------------------------------------------------------------ osmosis-executed-price-accepts-any-single-pool-usdc-swap
describe('only a swap in the trusted pool, against Noble USDC, sets the executed price', () => {
  const hour = Date.UTC(2026, 9, 20, 9);
  const ts = hour + 600000;
  const sell = (hash: string, pool: string, namIn: number, out: string) => parseOsmosisTx(tx(hash, [
    ev('message', { action: '/osmosis.poolmanager.v1beta1.MsgSwapExactAmountIn', sender: 'osmo1attacker' }),
    ev('token_swapped', { pool_id: pool, tokens_in: nam(namIn), tokens_out: out }),
  ], ts), ctx).flows[0];

  it('a pool anyone created, with real USDC or a factory coin named USDC, is a trade priced at the quote and kept out of price.swap_1h', async () => {
    const a = sell('A1', '999999', 50, '500000' + USDC);
    expect(a).toMatchObject({ kind: 'sell', amount: 50, counterDenom: 'USDC', counterAmount: 0.5, poolId: '999999', priceUsd: 0.00087 });
    const b = sell('B1', '9999', 50, '47600000000factory/osmo1abc/USDC');
    expect(b.counterDenom).not.toBe('USDC');
    expect(b.counterDenom).toBe('factory/osmo1abc…/USDC');
    expect(b).toMatchObject({ counterAmount: 47600, poolId: '9999', priceUsd: 0.00087 });
    const h1 = sell('C1', '3005', 100, '110000' + USDC), h2 = sell('C2', '3005', 200, '220000' + USDC);
    expect(h1.priceUsd).toBeCloseTo(0.0011, 12);

    const db = testD1();
    await runStmts(db, [a, b, h1, h2].map(stmt.flow));
    // and a row stored before the fix, when a factory coin was labelled 'USDC': the pool alone keeps it out
    insert(db, 'flows', [{ id: 'osmosis:OLD:swap', chain: 'osmosis', height: 1, ts, tx_hash: 'OLD', kind: 'sell', amount_num: 50, counter_denom: 'USDC', counter_amount: 47600, pool_id: '9999', price_usd: 952, value_usd: 47600 }]);
    const trusted = db.raw.prepare(`SELECT id FROM flows WHERE ${SINGLE_POOL_USDC_SWAP} AND ts >= ? AND ts < ? ORDER BY id`).all(hour, hour + H).map((r: any) => r.id);
    expect(trusted).toEqual(['osmosis:C1:swap', 'osmosis:C2:swap']);
    const rows = (await db.prepare(SWAP_HOUR_SQL).bind(hour, hour + H).all<SwapRow>()).results;
    expect(rows).toHaveLength(5);
    const k = metricsOf(rows, hour);
    expect(k['price.swap_1h']).toBeCloseTo(0.0011, 12);
    expect(k['price.swap_1h.n']).toBe(2);
    expect(k['price.swap_1h.high']).toBeCloseTo(0.0011, 12);
    expect(priceVsExecution(0.0011, { ts: hour, value: k['price.swap_1h'] as number }, null, hour + 60000)!.status).toBe('ok');
    // the tape: the foreign pool's row is not the trade's own price
    const tapeA = db.raw.prepare(`SELECT price_usd, counter_denom, counter_amount, amount_num FROM flows WHERE id = 'osmosis:A1:swap'`).get();
    expect(priceSourceOf(tapeA, {})).not.toBe('execution');
    const tapeC = db.raw.prepare(`SELECT price_usd, counter_denom, counter_amount, amount_num FROM flows WHERE id = 'osmosis:C1:swap'`).get();
    expect(priceSourceOf(tapeC, {})).toBe('execution');
    // negative control: a route through the trusted pool and another is still left out
    expect(metricsOf([{ ...rowOf(h1), pool_id: '3005,999999' }], hour)['price.swap_1h']).toBeUndefined();
  });

  it('a coin the asset map does not know never takes the USDC label', () => {
    expect(shortDenom('factory/osmo1abc/USDC')).toBe('factory/osmo1abc…/USDC');
    expect(shortDenom(OSMOSIS.allUsdc)).toBe('allUSDC');
    expect(shortDenom('uosmo')).toBe('OSMO');
  });
});

// ------------------------------------------------------------------ first-counter-over-net-swap-price
describe('a swap row\'s price comes only from legs that pair', () => {
  const H0 = Date.UTC(2026, 9, 20, 9);
  const two = (hash: string, e1: Record<string, string>, e2: Record<string, string>) => parseOsmosisTx(tx(hash, [
    ev('token_swapped', { pool_id: '3005', ...e1 }), ev('token_swapped', { pool_id: '3005', ...e2 }),
  ], H0 + 60000), ctx).flows.find((f) => f.id.endsWith(':swap'))!;

  it('sell 1,100 then buy 1,040 in pool 3005: a sell of 60 NAM with no counter coin and the quote as its price, never 0.55', () => {
    const f = two('A', { tokens_in: nam(1100), tokens_out: usdc(33) }, { tokens_in: usdc(31.2), tokens_out: nam(1040) });
    expect(f).toMatchObject({ kind: 'sell', counterDenom: null, counterAmount: null, poolId: '3005', priceUsd: 0.00087 });
    expect(f.amount).toBeCloseTo(60, 9);
    expect(f.meta?.arb).toBeUndefined();
    expect(metricsOf([rowOf(f)], H0)['price.swap_1h']).toBeUndefined();
  });

  it('two sells in pool 3005: 1,001 NAM for 30.03 USDC at 0.03, never 0.03 / 1,001', () => {
    const f = two('B', { tokens_in: nam(1), tokens_out: usdc(0.03) }, { tokens_in: nam(1000), tokens_out: usdc(30) });
    expect(f).toMatchObject({ kind: 'sell', amount: 1001, counterDenom: 'USDC' });
    expect(f.counterAmount).toBeCloseTo(30.03, 9);
    expect(f.priceUsd).toBeCloseTo(0.03, 12);
    expect(metricsOf([rowOf(f)], H0)['price.swap_1h']).toBeCloseTo(0.03, 12);
  });

  it('a round trip keeps the counter of its larger side, over that side\'s NAM', () => {
    const f = two('C', { tokens_in: nam(1000), tokens_out: usdc(30) }, { tokens_in: `5000000uosmo`, tokens_out: nam(990) });
    expect(f).toMatchObject({ kind: 'other', amount: 1000, counterDenom: 'USDC', counterAmount: 30, priceUsd: 0.00087, meta: { arb: true } });
  });
});

// ------------------------------------------------------------------ osmosis-recv-packet-tx-global-success-writes-failed-crossing
describe('a receive counts only when its own message says it succeeded', () => {
  const FAILED = { denom: NAM.namadaToken, amount: '5000000000', sender: 'tnam1qr4wemkpjfycn7ts7297e8qecg2t6pf2vq2wulsa', receiver: 'osmo19v0z78d8gv02t4cfqvmtklppu4rmpp5ek3q9a8' };
  const batch = (variant: 'false' | 'removed' | 'renamed' | 'true') => {
    const raw = fx('osmo_ibc_recv.json')[0];
    const events: RawEvent[] = raw.tx_result.events;
    const copies = events
      .filter((e) => attrOf(e, 'msg_index') === '1' && (['recv_packet', 'fungible_token_packet', 'write_acknowledgement'].includes(e.type) || (e.type === 'message' && attrOf(e, 'action'))))
      .map((e) => structuredClone(e));
    for (const e of copies) {
      setAttr(e, 'msg_index', '2');
      if (e.type === 'recv_packet' || e.type === 'write_acknowledgement') { setAttr(e, 'packet_sequence', '8549'); setAttr(e, 'packet_data', JSON.stringify(FAILED)); }
      if (e.type === 'fungible_token_packet') { setAttr(e, 'amount', FAILED.amount); setAttr(e, 'sender', FAILED.sender); setAttr(e, 'receiver', FAILED.receiver); setAttr(e, 'success', variant === 'true' ? 'true' : 'false'); }
    }
    const kept = variant === 'removed' ? copies.filter((e) => e.type !== 'fungible_token_packet') : copies;
    if (variant === 'renamed') for (const e of kept) if (e.type === 'fungible_token_packet') { e.type = 'ibccallbackerror-fungible_token_packet'; setAttr(e, 'success', 'true'); }
    events.push(...kept);
    return parseOsmosisTx(normFromTxSearch(raw, 1), ctx);
  };

  it('a refused NAM receive batched with a successful one writes no flow and no link (success=false, missing, renamed)', () => {
    for (const v of ['false', 'removed', 'renamed'] as const) {
      const p = batch(v);
      expect(p.flows.filter((f) => f.kind === 'ibc_in').map((f) => [f.to, f.amount]), v).toEqual([['osmo137zwfeku64lzfg4laedyg628qnepqpgkahqyk3', 1]]);
      expect(p.links.map((l) => l.osmo), v).toEqual(['osmo137zwfeku64lzfg4laedyg628qnepqpgkahqyk3']);
    }
  });

  it('control: when the second receive succeeds in its own message, both are recorded', () => {
    const p = batch('true');
    expect(p.flows.filter((f) => f.kind === 'ibc_in').map((f) => f.amount)).toEqual([1, 5000]);
    expect(p.links).toContainEqual({ osmo: FAILED.receiver, namada: FAILED.sender, amount: 5000, ts: 1, flowId: p.flows.find((f) => f.kind === 'ibc_in' && f.amount === 5000)!.id });
  });
});

// ------------------------------------------------------------------ ibc-transfer-channel-unchecked
describe('only a send on channel-98451 is a crossing to Namada, with its own packet sequence', () => {
  const offChannel = (msg = '0', seq = '50') => {
    const raw = fx('osmo_ibc_send.json')[0];
    const events: RawEvent[] = raw.tx_result.events;
    for (const e of events) {
      if (e.type === 'send_packet') { setAttr(e, 'packet_src_channel', 'channel-0'); setAttr(e, 'packet_dst_channel', 'channel-141'); setAttr(e, 'packet_sequence', seq); }
      if (e.type === 'transfer' && attrOf(e, 'recipient') === OSMOSIS.transferModule) setAttr(e, 'recipient', 'osmo1escrowtest');
      if (attrOf(e, 'msg_index') !== undefined) setAttr(e, 'msg_index', msg);
    }
    raw.tx_result.events = events.filter((e) => e.type !== 'burn');
    return raw;
  };
  const SENDER = 'osmo137zwfeku64lzfg4laedyg628qnepqpgkahqyk3';

  it('the NAM voucher sent over another channel is no bridge-out; its escrow leg is an ordinary transfer', () => {
    const p = parseOsmosisTx(normFromTxSearch(offChannel(), 1), ctx);
    expect(p.flows.filter((f) => f.kind === 'ibc_out')).toEqual([]);
    expect(p.flows.map((f) => [f.kind, f.from, f.to, f.amount])).toEqual([['transfer', SENDER, 'osmo1escrowtest', 1]]);
    // its timeout on that channel is no bridge refund either: the escrow paying back is an ordinary transfer
    const back = parseOsmosisTx(tx('T0', [
      ev('timeout_packet', { packet_src_channel: 'channel-0', packet_sequence: '50', msg_index: '0' }),
      ev('transfer', { recipient: SENDER, sender: 'osmo1escrowtest', amount: nam(1), msg_index: '0' }),
      ev('timeout', { refund_receiver: SENDER, refund_denom: `transfer/channel-0/${NAM.osmoDenom}`, refund_amount: '1000000', msg_index: '0' }),
    ]), ctx);
    expect(back.flows.filter((f) => f.meta?.ibcTimeoutRefund)).toEqual([]);
    expect(back.flows.map((f) => [f.kind, f.from, f.to])).toEqual([['transfer', 'osmo1escrowtest', SENDER]]);
  });

  it('beside a channel-98451 send in another message, the off-channel send borrows no sequence and a refund cancels the right row', () => {
    const raw = offChannel('0', '50');
    const real = fx('osmo_ibc_send.json')[0].tx_result.events.filter((e: RawEvent) => attrOf(e, 'msg_index') === '0');
    for (const e of real) { setAttr(e, 'msg_index', '1'); if (e.type === 'send_packet') setAttr(e, 'packet_sequence', '7'); }
    raw.tx_result.events.push(...real);
    const p = parseOsmosisTx(normFromTxSearch(raw, 100), ctx);
    const outs = p.flows.filter((f) => f.kind === 'ibc_out');
    expect(outs.map((f) => f.meta)).toEqual([{ memo: '', channel: NAM.osmoChannel, packetSequence: '7' }]);
    const rows = outs.map((f) => ({ id: f.id, ts: f.ts, from_addr: f.from, to_addr: f.to, amount_num: f.amount, meta: JSON.stringify(f.meta) }));
    const gone = timedOutSends(rows.map(ibcRowOf), [ibcRowOf({ id: 'r', ts: 200, from_addr: OSMOSIS.transferModule, to_addr: SENDER, amount_num: 1, meta: '{"packetSequence":"7","refundReceiver":"' + SENDER + '"}' })]);
    expect([...gone]).toEqual([outs[0].id]);
    // the one crossing is still judged against Namada when no refund came
    expect(unpairedCrossings([], rows.map((r) => ({ ...r, kind: 'ibc_out' })), 100 + 31 * 60000).osmosisOnly).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ ibc-send-error-ack-refund-not-recorded
describe('a send refused on Namada (an error acknowledgement) is recorded as refunded on Osmosis', () => {
  const NOW = Date.now();
  const RELAYER = 'osmo1yvejj22t78s2vfk7slty2d7fs5lkc8rnmszznw';
  /** The relayer's MsgAcknowledgement for the packet of test/fixtures/osmo_ibc_send.json[0], in ibc-go's event shape. */
  const ackTx = (outcome: 'error' | 'success', shape: 'v8' | 'v7' = 'v8', denom?: string) => {
    const send = fx('osmo_ibc_send.json')[0];
    const sp = Object.fromEntries(send.tx_result.events.find((e: RawEvent) => e.type === 'send_packet').attributes.map((a: any) => [a.key, a.value]));
    const pd = JSON.parse(sp.packet_data);
    const m = '1';
    const data = { module: 'transfer', sender: pd.sender, receiver: pd.receiver, denom: denom ?? pd.denom, amount: pd.amount, memo: '' };
    const ack = outcome === 'error' ? { acknowledgement: 'error:"ABCI code: 1: error handling packet: see events for details"' } : { acknowledgement: 'result:"\\001"' };
    const res = outcome === 'error' ? { error: 'invalid receiver address' } : { success: '\u0001' };
    const ftp = shape === 'v8'
      ? [ev('fungible_token_packet', { ...data, ...ack, ...res, msg_index: m })]
      : [ev('fungible_token_packet', { ...data, ...ack, msg_index: m }), ev('fungible_token_packet', { ...res, msg_index: m })];
    const refundLegs = outcome === 'error' ? [
      ev('coinbase', { minter: OSMOSIS.transferModule, amount: `${pd.amount}${NAM.osmoDenom}`, msg_index: m }),
      ev('transfer', { recipient: pd.sender, sender: OSMOSIS.transferModule, amount: `${pd.amount}${NAM.osmoDenom}`, msg_index: m }),
      ev('message', { sender: OSMOSIS.transferModule, msg_index: m }),
    ] : [];
    const events = [
      ev('transfer', { recipient: 'osmo17xpfvakm2amg962yls6f84z3kell8c5lczssa0', sender: RELAYER, amount: '40000uosmo' }),
      ev('message', { sender: RELAYER }),
      ev('message', { action: '/ibc.core.client.v1.MsgUpdateClient', sender: RELAYER, msg_index: '0' }),
      ev('message', { action: '/ibc.core.channel.v1.MsgAcknowledgement', sender: RELAYER, msg_index: m }),
      ev('acknowledge_packet', {
        packet_timeout_height: sp.packet_timeout_height, packet_timeout_timestamp: sp.packet_timeout_timestamp, packet_sequence: sp.packet_sequence,
        packet_src_port: sp.packet_src_port, packet_src_channel: sp.packet_src_channel, packet_dst_port: sp.packet_dst_port, packet_dst_channel: sp.packet_dst_channel,
        packet_channel_ordering: sp.packet_channel_ordering, connection_id: sp.connection_id, msg_index: m,
      }),
      ev('message', { module: 'ibc_channel', msg_index: m }),
      ...refundLegs,
      ...ftp,
    ];
    return { send, ack: { hash: 'ACK1993', height: '71463300', tx_result: { code: 0, events } }, pd };
  };

  it('the refund row carries the packet, the sender who got the NAM back and the reason; the send is then not counted as bridged out', async () => {
    const { send, ack, pd } = ackTx('error');
    const s = parseOsmosisTx(normFromTxSearch(send, NOW - 5 * H), ctx);
    const r = parseOsmosisTx(normFromTxSearch(ack, NOW - 4 * H), ctx);
    expect(r.flows).toHaveLength(1);
    expect(r.flows[0]).toMatchObject({
      kind: 'other', from: OSMOSIS.transferModule, to: pd.sender, amount: 1,
      meta: { ibcTimeoutRefund: true, refundReason: 'error_acknowledgement', packetSequence: '1993', refundReceiver: pd.sender, channel: NAM.osmoChannel },
    });
    expect(r.moves).toContainEqual(expect.objectContaining({ address: pd.sender, delta: 1 }));
    // the v7 shape (success / error in a second fungible_token_packet event) is the same refund
    expect(parseOsmosisTx(normFromTxSearch(ackTx('error', 'v7').ack, 1), ctx).flows.map((f) => f.meta?.refundReason)).toEqual(['error_acknowledgement']);

    const db = testD1();
    await runStmts(db, [...s.flows, ...r.flows].map(stmt.flow));
    const p = await pressure(db as any, NOW, false);
    expect(p.ibcOut7d).toBe(0);
    expect(p.ibcRefunded7d).toBe(1);
    expect(await osmosisNetIbc(db as any, NOW - 24 * H, NOW)).toBe(0);
    const ob = db.raw.prepare(`SELECT id, kind, ts, from_addr, to_addr, amount_num, meta FROM flows WHERE chain='osmosis' AND kind IN ('ibc_in','ibc_out')`).all();
    const orf = db.raw.prepare(`SELECT id, ts, from_addr, to_addr, amount_num, meta FROM flows WHERE chain='osmosis' AND kind='other' AND meta LIKE '%"ibcTimeoutRefund":true%'`).all();
    const gone = timedOutSends(ob.map(ibcRowOf), orf.map(ibcRowOf));
    expect(unpairedCrossings([], ob.filter((o: any) => !gone.has(o.id)), NOW).osmosisOnly).toEqual([]);
  });

  it('a result acknowledgement, or an error for another coin\'s packet, records nothing', () => {
    expect(parseOsmosisTx(normFromTxSearch(ackTx('success').ack, 1), ctx).flows).toEqual([]);
    expect(parseOsmosisTx(normFromTxSearch(ackTx('success', 'v7').ack, 1), ctx).flows).toEqual([]);
    expect(parseOsmosisTx(normFromTxSearch(ackTx('error', 'v8', 'transfer/channel-98451/tnam1other').ack, 1), ctx).flows.filter((f) => f.meta?.ibcTimeoutRefund)).toEqual([]);
  });
});
