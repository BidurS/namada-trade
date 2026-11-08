// The shielded pool's fee as a kind of its own ('masp_fee', 2026-11-07). A shielded transaction that pays its gas from
// the pool moves one NAM leg out of it, to the account that paid gas, and the chain marks the inner transaction with a
// masp/fee-payment event; the parser used to file that leg as an unshield to the gas payer (fee detection ran only when
// the pool paid more than one target). Fixtures: block_results and /block of 8,515,250 (one such fee, 0.175 NAM) and of
// 8,510,819 (an unshield of 15,000,000 NAM with its fee leg), as namada-rpc.stakeandrelax.net served them on 2026-11-07;
// namada-rpc.polkachu.com gave the same events for both (checked when the fixtures were taken).
//
// Also here: the pool's own NAM after each inner transaction on every flow that touches it (meta.maspPostNam), the kind
// in every place kinds are enumerated, the public answers without meta.maspFeeNam (a gas setting of the wallet that
// built the transaction), and the re-file script's rule on the same fixtures.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseNamadaBlock, MASP_FEE_CAP_NAM, type NamadaBlock } from '../worker/src/parse/namada';
import { feePayersOf } from '../worker/src/parse/namada-tx';
import { NAM, NAMADA } from '../worker/src/config';
import { KINDS, FLOW_TO_TAG, kindInfo, kindSign, tagKindOf } from '../shared/kinds';
import { moveTitle, pastWords, partyPreposition, tagOfFlow } from '../shared/flow-words';
import { KIND_CHIP, parse } from '../shared/search-grammar';
import { evaluateFlow, DEFAULT_THRESHOLDS } from '../shared/alerts';
import { offeredForAlerts } from '../worker/src/sources/discord';
import { publicWho, type PublicMove } from '../worker/src/public-posts';
import { KIND_GROUPS, NOT_FEE, flowsConditions, storedCountSql } from '../worker/src/flows-query';
import { publicMeta, rowToFlow, blindSpot } from '../worker/src/analytics';
import { dayAggregates, type DayFlowRow } from '../worker/src/series';
import { shapeMasp, instantKey } from '../worker/src/digest/figures';
import { SQL } from '../worker/src/digest/sql';
import { answered } from '../worker/src/digest/types';
import { digestWindow } from '../worker/src/digest/types';
import { app } from '../worker/src/api';
import { testD1, insert } from './d1-sqlite';
import { sqlStatements } from '../scripts/sql-statements';
import { verdictOf, blockFromResults, sameEvents, edgePlans, renderMigration, FIRST_BLOCK, DEFAULT_NODES, type StoredRow } from '../scripts/refile-masp-fees';
import type { Flow, FlowsResponse } from '../shared/types';

const MASP = NAMADA.internal.masp;
const POS = NAMADA.internal.pos;
const NAMT = NAM.namadaToken;
const fx = (n: string) => JSON.parse(readFileSync(join(__dirname, 'fixtures', n), 'utf8'));
const txsOf = (h: number) => fx(`namada_block_${h}_txs.json`).result.block.data.txs as string[];
const timeOf = (h: number) => Date.parse(fx(`namada_block_${h}_txs.json`).result.block.header.time);
const blockOf = (h: number): NamadaBlock => blockFromResults(fx(`namada_block_${h}.json`), h, timeOf(h));

// block 8,515,250: one wrapper, one inner transaction, the pool's one leg of 0.175 NAM to the account that paid gas
const W1 = '6C67558472A9EF53484E30899B36D2F65213403E0A7B4F970017278FFB2B60FA';
const I1 = '3925B58ECFB9D75E533ED5D12CB4DEB5ACDCC3F9707848FEC644816ABB3D3170';
const GAS1 = 'tnam1qq3t3lccqk4u69zjyaej63rrfpm4eha2v56llrku';
const POST1 = '31593419065539';
// block 8,510,819: the pool paid two targets, 0.134937 NAM to the gas payer and 15,000,000 NAM to the recipient
const W2 = 'FE56A2F79DEB8D2D6BC9A800FFF913487F5971019A575ED61BE9FB311F2C197C';
const I2 = '85DE92A26A13DB5ACB2846F5862F5991AA7F5F49EB4BF53D453301CF79CD5FF8';
const GAS2 = 'tnam1qzjg8tswc9j02emdnmmft02lmdafss8cvgpqm8as';
const RCPT2 = 'tnam1qzsulcx3lzusdg98pmt5y460z59leazhy5xpe6d3';
const POST2 = '31564969658039';

type L = [string, string, string]; // account, token, base units
const acct = ([a, t, n]: L) => [[`internal-address/${a}`, t], n];
const transfer = (hash: string, inner: string, src: L[], dst: L[], post: L[] = []) => ({
  type: 'token/transfer',
  attributes: [
    { key: 'hash', value: hash }, { key: 'inner-tx-hash', value: inner },
    { key: 'source-accounts', value: JSON.stringify(src.map(acct)) }, { key: 'target-accounts', value: JSON.stringify(dst.map(acct)) },
    { key: 'post-balances', value: JSON.stringify(post.map(acct)) }, { key: 'token-event-descriptor', value: 'transfer-from-wasm' },
  ],
});
const feePayment = (hash: string, inner: string, height = 1) => ({
  type: 'masp/fee-payment',
  attributes: [{ key: 'hash', value: hash }, { key: 'height', value: String(height) }, { key: 'indexed-tx', value: JSON.stringify({ block_height: height, block_index: 0, batch_index: 0 }) }, { key: 'inner-tx-hash', value: inner }, { key: 'section', value: '{"MaspSection":[1]}' }],
});
const USER = 'tnam1qr4l8egaskk09460llz0qctac7sgemynpu8c7vvd';
const OTHER = 'tnam1qr8x5rly5mj8wly2ph0zqjkcqkju0g5jkggjn9k3';
const WX = 'AB'.repeat(32), IX = 'CD'.repeat(32);

describe('the parser on block 8,515,250: one leg out of the pool, a masp/fee-payment event', () => {
  it('without the wrapper: the leg is the fee, a flow of kind masp_fee from the pool to the gas payer, and the wrapper is wanted', () => {
    const p = parseNamadaBlock(blockOf(8515250), null);
    expect(p.flows).toHaveLength(1);
    const [f] = p.flows;
    expect(f).toMatchObject({ id: `namada:${W1}:1`, txHash: W1, kind: 'masp_fee', from: MASP, to: GAS1, amount: 0.175, chain: 'namada', height: 8515250 });
    expect(f.meta).toMatchObject({ descriptor: 'transfer-from-wasm', innerTxHash: I1, maspPostNam: POST1 });
    expect(f.meta).not.toHaveProperty('maspFeeNam');
    expect(p.feePayerWanted).toEqual([W1]);
    // the pool's outflow is whole in the moves and the post-balance is the chain's
    expect(p.moves.filter((m) => m.address === MASP).reduce((s, m) => s + m.delta, 0)).toBeCloseTo(-0.175, 9);
    expect(p.balances.find((b) => b.address === MASP)?.balance).toBe(POST1);
  });

  it('with the wrapper: its fee payer is the gas payer, so the reading is the same and settled', () => {
    const payers = feePayersOf(txsOf(8515250));
    expect(payers.get(W1)).toBe(GAS1);
    const p = parseNamadaBlock(blockOf(8515250), null, payers);
    expect(p.flows.map((f) => [f.kind, f.to, f.amount])).toEqual([['masp_fee', GAS1, 0.175]]);
    expect(p.feePayerWanted).toEqual([]);
  });

  it('a wrapper that names another account as its fee payer: the leg is a receipt, an unshield to that account', () => {
    const p = parseNamadaBlock(blockOf(8515250), null, new Map([[W1, OTHER]]));
    expect(p.flows.map((f) => [f.kind, f.to, f.amount])).toEqual([['unshield', GAS1, 0.175]]);
    expect(p.flows[0].meta).toMatchObject({ maspPostNam: POST1 });
    expect(p.feePayerWanted).toEqual([]);
  });

  it('the same transfer without the masp/fee-payment event is an unshield, as it was read before', () => {
    const b = blockOf(8515250);
    const p = parseNamadaBlock({ ...b, events: b.events.filter((e) => e.type !== 'masp/fee-payment') }, null);
    expect(p.flows.map((f) => [f.kind, f.to, f.amount])).toEqual([['unshield', GAS1, 0.175]]);
    expect(p.feePayerWanted).toEqual([]);
  });

  it('a priced block prices the fee at the block\'s quote like any other leg', () => {
    const p = parseNamadaBlock(blockOf(8515250), 0.0009);
    expect(p.flows[0]).toMatchObject({ kind: 'masp_fee', priceUsd: 0.0009 });
    expect(p.flows[0].valueUsd).toBeCloseTo(0.175 * 0.0009, 12);
  });
});

describe('the parser on block 8,510,819: an unshield with its fee leg', () => {
  it('one unshield of 15,000,000 NAM to the recipient, the gas payer\'s 0.134937 NAM kept as maspFeeNam, the pool\'s post-balance on it', () => {
    for (const payers of [undefined, feePayersOf(txsOf(8510819))]) {
      const p = parseNamadaBlock(blockOf(8510819), null, payers);
      expect(p.flows).toHaveLength(1);
      expect(p.flows[0]).toMatchObject({ id: `namada:${W2}:1`, kind: 'unshield', from: MASP, to: RCPT2, amount: 15_000_000 });
      expect(p.flows[0].meta).toMatchObject({ innerTxHash: I2, maspPostNam: POST2 });
      expect(p.flows[0].meta?.maspFeeNam).toBeCloseTo(0.134937, 9);
      expect(p.flows.some((f) => f.kind === 'masp_fee')).toBe(false);
    }
    expect(feePayersOf(txsOf(8510819)).get(W2)).toBe(GAS2);
  });
});

describe('the rule\'s edges (synthetic events in the chain\'s shape)', () => {
  const one = (dst: L, withEvent = true, post: L[] = [[MASP, NAMT, '1000']]) => {
    const events: any[] = [transfer(WX, IX, [[MASP, NAMT, dst[2]]], [dst], post)];
    if (withEvent) events.unshift(feePayment(WX, IX));
    return parseNamadaBlock({ height: 1, ts: 1, events }, null);
  };
  it('above the cap: an unshield, event or not', () => {
    const over = String(BigInt(MASP_FEE_CAP_NAM) * 1_000_000n + 1n);
    expect(one([USER, NAMT, over]).flows.map((f) => f.kind)).toEqual(['unshield']);
    expect(one([USER, NAMT, over]).feePayerWanted).toEqual([]);
  });
  it('at the cap exactly: a fee', () => {
    expect(one([USER, NAMT, String(BigInt(MASP_FEE_CAP_NAM) * 1_000_000n)]).flows.map((f) => f.kind)).toEqual(['masp_fee']);
  });
  it('to a protocol account (the staking account pays no gas): the kind of that account, never a fee', () => {
    expect(one([POS, NAMT, '100000']).flows.map((f) => [f.kind, f.to])).toEqual([['pos_balance', POS]]);
  });
  it('the event of another inner transaction does not make this leg a fee', () => {
    const events = [feePayment(WX, 'EF'.repeat(32)), transfer(WX, IX, [[MASP, NAMT, '100000']], [[USER, NAMT, '100000']])];
    expect(parseNamadaBlock({ height: 1, ts: 1, events }, null).flows.map((f) => f.kind)).toEqual(['unshield']);
  });
  it('the pool paying more than one target with the event keeps the older rule: the one fee-sized target is maspFeeNam on the unshield', () => {
    const events = [feePayment(WX, IX), transfer(WX, IX, [[MASP, NAMT, '20000100000']], [[USER, NAMT, '20000000000'], [OTHER, NAMT, '100000']])];
    const p = parseNamadaBlock({ height: 1, ts: 1, events }, null);
    expect(p.flows.map((f) => [f.kind, f.to, f.amount])).toEqual([['unshield', USER, 20000]]);
    expect(p.flows[0].meta?.maspFeeNam).toBeCloseTo(0.1, 9);
  });
});

describe('maspPostNam: the pool\'s own NAM after the inner transaction, on every flow that touches it', () => {
  it('a shield carries it; a transfer that never touched the pool does not; the chain\'s string is kept as written', () => {
    const events = [transfer(WX, IX, [[USER, NAMT, '5000000']], [[MASP, NAMT, '5000000']], [[MASP, NAMT, '123456789012345'], [USER, NAMT, '1']]),
      transfer('CD'.repeat(32), 'EF'.repeat(32), [[USER, NAMT, '7']], [[OTHER, NAMT, '7']], [[USER, NAMT, '0'], [OTHER, NAMT, '7']])];
    const p = parseNamadaBlock({ height: 1, ts: 1, events }, null);
    expect(p.flows.map((f) => [f.kind, f.meta?.maspPostNam])).toEqual([['shield', '123456789012345'], ['transfer', undefined]]);
  });
  it('an inner transaction with two events: every pool leg carries the balance after all of them, never one event\'s own', () => {
    const events = [
      transfer(WX, IX, [[MASP, NAMT, '1000000']], [[USER, NAMT, '1000000']], [[MASP, NAMT, '900'], [USER, NAMT, '1000000']]),
      transfer(WX, IX, [[OTHER, NAMT, '2000000']], [[MASP, NAMT, '2000000']], [[MASP, NAMT, '2000900'], [OTHER, NAMT, '0']]),
    ];
    const p = parseNamadaBlock({ height: 1, ts: 1, events }, null);
    expect(p.flows.map((f) => [f.kind, f.meta?.maspPostNam])).toEqual([['unshield', '2000900'], ['shield', '2000900']]);
  });
  it('an event without a post-balance of the pool gives none (never 0 or a stand-in)', () => {
    const p = parseNamadaBlock({ height: 1, ts: 1, events: [transfer(WX, IX, [[MASP, NAMT, '5']], [[USER, NAMT, '5']], [[USER, NAMT, '5']])] }, null);
    expect(p.flows[0].meta).not.toHaveProperty('maspPostNam');
  });
  it('a crossing through the pool (escrow legs) carries it on the pool leg', () => {
    const events = [transfer(WX, IX, [[MASP, NAMT, '300']], [[NAMADA.internal.ibc, NAMT, '300']], [[MASP, NAMT, '77'], [NAMADA.internal.ibc, NAMT, '300']])];
    const p = parseNamadaBlock({ height: 1, ts: 1, events }, null);
    expect(p.flows.map((f) => [f.kind, f.meta?.maspPostNam])).toEqual([['ibc_out', '77']]);
  });
});

describe('the kind everywhere kinds are enumerated', () => {
  const fee: Flow = { id: 'namada:F:1', chain: 'namada', height: 1, ts: 1, txHash: 'F', kind: 'masp_fee', from: MASP, to: GAS1, amount: 0.175, meta: { innerTxHash: I1 } } as Flow;
  it('the tag: "Shielded pool fee", expert "MASP fee payment", the shield hue, no market sign', () => {
    expect(FLOW_TO_TAG.masp_fee).toBe('maspFee');
    expect(KINDS.maspFee).toMatchObject({ word: 'Shielded pool fee', expert: 'MASP fee payment', hue: 'shield' });
    expect(kindInfo('masp_fee')).toBe(KINDS.maspFee);
    expect(tagKindOf('masp_fee', 'namada')).toBe('maspFee');
    expect(tagOfFlow(fee)).toBe('maspFee');
    expect(kindSign('maspFee')).toBe(0);
  });
  it('the words name a fee, never NAM moved out of the shielded set', () => {
    expect(moveTitle(fee)).toMatch(/^0\.18 NAM paid from the shielded pool as a transaction fee$/); // the site's amount rule rounds the fee
    expect(moveTitle({ ...fee, amount: 1.5 })).toMatch(/^1\.50? NAM paid from the shielded pool as a transaction fee$/);
    expect(pastWords(fee, true, '0.175 NAM')).toBe('received 0.175 NAM from the shielded pool as a transaction fee');
    expect(pastWords(fee, false, '0.175 NAM')).toBe('paid 0.175 NAM from the shielded pool as a transaction fee');
    expect(partyPreposition('masp_fee')).toBe('to ');
    for (const w of [moveTitle(fee), pastWords(fee, true, '1 NAM'), KINDS.maspFee.word, KIND_CHIP.masp_fee]) expect(w).not.toMatch(/shielded set|unshield/i);
  });
  it('the search grammar: a chip, and "fees" read as the kind', () => {
    expect(KIND_CHIP.masp_fee).toBe('Shielded pool fees only');
    const r = parse('fees', { now: Date.UTC(2026, 10, 7), list: 'moves' });
    expect(r.kind).toBe('masp_fee');
    expect(r.chips.map((c) => c.label)).toContain('Shielded pool fees only');
  });
  it('in no group of the moves list; the public post and the card name it as the pool\'s fee', () => {
    for (const g of Object.values(KIND_GROUPS)) expect(g).not.toContain('masp_fee');
    expect(publicWho({ kind: 'masp_fee', who: 'tnam1qq3t3l…llrku', other: 'the shielded pool', pools: [], alsoCoins: null, refund: false } as unknown as PublicMove)).toBe('To tnam1qq3t3l…llrku, the shielded pool\'s fee for a transaction');
  });
  it('a fee is never an alert: no rule at any threshold, and the live pass never offers it', () => {
    const big = { ...fee, amount: 60_000 } as Flow; // above every threshold, were it an unshield
    expect(evaluateFlow(big, DEFAULT_THRESHOLDS)).toEqual([]);
    expect(evaluateFlow({ ...big, kind: 'unshield' } as Flow, DEFAULT_THRESHOLDS).map((h) => h.ruleId)).toEqual(['unshield']);
    expect(offeredForAlerts(fee, 0)).toBe(false);
    expect(offeredForAlerts(big, 10)).toBe(false);
    expect(offeredForAlerts({ ...fee, kind: 'unshield' } as Flow, 10_000)).toBe(true);
  });
});

describe('the lists leave the fee rows out unless the row itself is asked for', () => {
  const T = Date.UTC(2026, 10, 2, 18, 0);
  const rows = () => [
    { id: `namada:${W1}:1`, chain: 'namada', height: 8515250, ts: T - 60_000, tx_hash: W1, kind: 'masp_fee', from_addr: MASP, to_addr: GAS1, amount_num: 0.175, meta: JSON.stringify({ descriptor: 'transfer-from-wasm', innerTxHash: I1, maspPostNam: POST1 }) },
    { id: `namada:${W2}:1`, chain: 'namada', height: 8510819, ts: T - 120_000, tx_hash: W2, kind: 'unshield', from_addr: MASP, to_addr: RCPT2, amount_num: 15_000_000, meta: JSON.stringify({ descriptor: 'transfer-from-wasm', innerTxHash: I2, maspFeeNam: 0.134937, maspPostNam: POST2 }) },
    { id: 'namada:T1:0', chain: 'namada', height: 8510000, ts: T - 180_000, tx_hash: 'T1', kind: 'transfer', from_addr: USER, to_addr: GAS1, amount_num: 3, meta: JSON.stringify({ innerTxHash: 'T1I' }) },
  ];
  it('flowsConditions: NOT_FEE for the feed and its groups, not for a kind, an address, a record, a block or a text', () => {
    expect(flowsConditions({ asOf: T }).conds).toContain(NOT_FEE);
    expect(flowsConditions({ asOf: T, chain: 'namada', whale: true, excludeBots: true, onePerCrossing: true }).conds).toContain(NOT_FEE);
    expect(flowsConditions({ asOf: T, kind: 'all' }).conds).toContain(NOT_FEE);
    for (const f of [{ kind: 'masp_fee' }, { kind: 'native' }, { kind: 'unshield' }, { addr: GAS1 }, { hash: W1 }, { height: 8515250 }, { search: 'llrku' }]) {
      expect(flowsConditions({ asOf: T, ...f } as any).conds, JSON.stringify(f)).not.toContain(NOT_FEE);
    }
    expect(storedCountSql({ asOf: T })?.sql).toContain("c.kind != 'masp_fee'");
    expect(storedCountSql({ asOf: T, kind: 'unshield' })?.sql).not.toContain("c.kind != 'masp_fee'");
  });
  it('GET /api/flows: the default list and the native group leave the fee out and count without it; ?kind=masp_fee and ?addr= list it', async () => {
    const db = testD1();
    insert(db, 'flows', rows());
    const list = async (qs: string) => (await (await app.request(`/api/flows?at=${T}${qs}`, {}, { DB: db } as any)).json()) as FlowsResponse;
    const all = await list('');
    expect(all.flows.map((f) => f.kind)).toEqual(['unshield', 'transfer']);
    expect(all.total).toBe(2);
    expect((await list('&kind=native')).flows.map((f) => f.kind)).toEqual(['unshield']);
    const fees = await list('&kind=masp_fee');
    expect(fees.flows.map((f) => [f.kind, f.to, f.amount])).toEqual([['masp_fee', GAS1, 0.175]]);
    expect(fees.total).toBe(1);
    expect((await list(`&addr=${GAS1}`)).flows.map((f) => f.kind)).toEqual(['masp_fee', 'transfer']);
  });
});

describe('the pool\'s sums add the fee back', () => {
  const T = Date.UTC(2026, 10, 2, 18, 0);
  const row = (id: string, kind: string, from: string, to: string, amount: number, meta: Record<string, unknown> | null = null, ts = T): DayFlowRow =>
    ({ id, chain: 'namada', ts, kind, from_addr: from, to_addr: to, amount_num: amount, value_usd: null, meta: meta ? JSON.stringify(meta) : null });
  it('dayAggregates: masp.out_daily holds the fee row and the unshield\'s folded fee; the fee is its own edge', () => {
    const agg = dayAggregates([row('a', 'masp_fee', MASP, GAS1, 0.175), row('b', 'unshield', MASP, RCPT2, 15_000_000, { maspFeeNam: 0.134937 }), row('c', 'shield', USER, MASP, 3)], []);
    expect(agg.metrics['masp.out_daily']).toBeCloseTo(15_000_000.309937, 6);
    expect(agg.metrics['masp.in_daily']).toBe(3);
    expect(agg.edges.map((e) => [e.kind, e.from_cat, e.to_cat, e.n])).toEqual(expect.arrayContaining([['masp_fee', 'masp', 'user', 1], ['unshield', 'masp', 'user', 1]]));
  });
  it('the digest: the fee rows are fees, not unshieldings, in the pool\'s out figure', async () => {
    const db = testD1();
    insert(db, 'flows', [
      { id: 'a', chain: 'namada', height: 1, ts: T - 3_600_000, tx_hash: 'A', kind: 'masp_fee', from_addr: MASP, to_addr: GAS1, amount_num: 0.175, meta: JSON.stringify({ innerTxHash: 'AI' }) },
      { id: 'b', chain: 'namada', height: 2, ts: T - 7_200_000, tx_hash: 'B', kind: 'unshield', from_addr: MASP, to_addr: RCPT2, amount_num: 15_000_000, meta: JSON.stringify({ innerTxHash: 'BI', maspFeeNam: 0.134937 }) },
      { id: 'c', chain: 'namada', height: 3, ts: T - 7_300_000, tx_hash: 'C', kind: 'unshield', from_addr: MASP, to_addr: USER, amount_num: 20, meta: JSON.stringify({ innerTxHash: 'CI' }) },
    ]);
    const win = digestWindow(T, 'daily');
    const outs = (await db.prepare(SQL.maspOut).bind(MASP, win.from, win.to).all<any>()).results;
    expect(outs.map((r: any) => [r.kind, r.n]).sort()).toEqual([['masp_fee', 1], ['unshield', 2]]);
    // the pool's balance at the window's ends: it fell by exactly the out figure, so the digest's balance check matches
    const instants = { [instantKey('supply.masp_shielded', win.now)]: answered([{ ts: win.now, value: 31_564_969.658039 }]), [instantKey('supply.masp_shielded', win.baseAt)]: answered([{ ts: win.baseAt, value: 31_564_969.658039 + 15_000_020.309937 }]) };
    const reads = { instants, exact: {}, firstTs: {}, maspIn: answered([]), maspOut: answered(outs), maspFees: answered([{ n: 0, fee_nam: 0 }]) } as any;
    const anchors = { namada: { partial: null, stamp: { source: 'test', at: T } } } as any;
    const m = shapeMasp(reads, win, anchors);
    if (!('value' in m)) throw new Error('not read');
    expect(m.value.out.unshield).toEqual({ n: 2, nam: 15_000_020 });
    expect(m.value.out.feesNam).toBeCloseTo(0.309937, 9);
    expect(m.value.out.total).toBeCloseTo(15_000_020.309937, 6);
    expect(m.value.in.total).toBe(0);
    expect('value' in m.value.balance && m.value.balance.value.matches).toBe(true);
  });
  it('the shielded page\'s figures (blindSpot): the fee counts as NAM out of the pool, and the largest moves out list no fee', async () => {
    const db = testD1();
    insert(db, 'flows', [
      { id: 'a', chain: 'namada', height: 1, ts: T - 3_600_000, tx_hash: 'A', kind: 'masp_fee', from_addr: MASP, to_addr: GAS1, amount_num: 0.175, meta: JSON.stringify({ innerTxHash: 'AI' }) },
      { id: 'c', chain: 'namada', height: 3, ts: T - 7_300_000, tx_hash: 'C', kind: 'unshield', from_addr: MASP, to_addr: USER, amount_num: 20, meta: JSON.stringify({ innerTxHash: 'CI', maspFeeNam: 0.1 }) },
    ]);
    const bs = await blindSpot(db as any, T, false);
    expect(bs.unshields24h).toBeCloseTo(20.175, 9);
    expect(bs.unshields.map((f) => f.kind)).toEqual(['unshield']);
  });
});

describe('public answers never carry the gas setting (meta.maspFeeNam)', () => {
  const T = Date.UTC(2026, 10, 2, 18, 0);
  const stored = { id: `namada:${W2}:1`, chain: 'namada', height: 8510819, ts: T - 120_000, tx_hash: W2, kind: 'unshield', from_addr: MASP, to_addr: RCPT2, amount_num: 15_000_000, meta: JSON.stringify({ descriptor: 'transfer-from-wasm', innerTxHash: I2, maspFeeNam: 0.134937, maspPostNam: POST2, priceSource: 'spot' }) };
  it('publicMeta drops the key and keeps every other; rowToFlow applies it; the store keeps the key', () => {
    expect(publicMeta({ a: 1, maspFeeNam: 0.1 })).toEqual({ a: 1 });
    expect(publicMeta(null)).toBeNull();
    const m = { innerTxHash: I2, maspPostNam: POST2 };
    expect(publicMeta(m)).toBe(m); // nothing to drop: the same object
    const f = rowToFlow(stored);
    expect(f.meta).toEqual({ descriptor: 'transfer-from-wasm', innerTxHash: I2, maspPostNam: POST2, priceSource: 'spot' });
    expect(JSON.parse(stored.meta).maspFeeNam).toBe(0.134937);
  });
  it('GET /api/flows, /api/blindspot and /api/address answer without the key while the row holds it', async () => {
    const db = testD1();
    insert(db, 'flows', [stored]);
    for (const path of [`/api/flows?at=${T}`, `/api/flows?at=${T}&addr=${RCPT2}`, `/api/blindspot?at=${T}`, `/api/address/${RCPT2}`]) {
      const res = await app.request(path, {}, { DB: db } as any);
      expect(res.status, path).toBe(200);
      const text = await res.text();
      expect(text, path).not.toContain('maspFeeNam');
      if (path.startsWith('/api/flows')) expect(text, path).toContain(POST2); // the pool's post-balance stays public
      if (path.startsWith('/api/blindspot')) expect(JSON.parse(text).unshields.map((f: Flow) => f.id)).toEqual([stored.id]);
    }
    expect(db.raw.prepare("SELECT json_extract(meta, '$.maspFeeNam') v FROM flows").get()).toEqual({ v: 0.134937 });
  });
});

describe('the re-file script\'s rule on the fixtures (scripts/refile-masp-fees.ts)', () => {
  const stored = (h: number, id: string, to: string, amount: number, meta: Record<string, unknown>): StoredRow => ({ id, height: h, ts: timeOf(h), to_addr: to, amount_num: amount, value_usd: null, meta: JSON.stringify(meta) });
  const row1 = stored(8515250, `namada:${W1}:1`, GAS1, 0.175, { descriptor: 'transfer-from-wasm', innerTxHash: I1 });
  it('two nodes agree on a block by its token and MASP events; the fixture block agrees with itself and not with another', () => {
    expect(sameEvents(fx('namada_block_8515250.json'), fx('namada_block_8515250.json'))).toBe(true);
    expect(sameEvents(fx('namada_block_8515250.json'), fx('namada_block_8510819.json'))).toBe(false);
    expect(sameEvents({ result: { end_block_events: [] } }, { result: { end_block_events: [] } })).toBe(false);
    expect(DEFAULT_NODES).toEqual(['https://namada-rpc.stakeandrelax.net', 'https://namada-rpc.polkachu.com']);
    expect(FIRST_BLOCK).toBe(7_682_174);
  });
  it('block 8,515,250: the stored unshield row is a fee, with the event\'s indexed-tx; without the event, or with another payer, it stays', () => {
    const b = blockOf(8515250);
    expect(verdictOf(row1, b, feePayersOf(txsOf(8515250)))).toEqual({ kind: 'masp_fee', indexedTx: '{"block_height":8515250,"block_index":0,"batch_index":0}', innerTxHash: I1 });
    expect(verdictOf(row1, b, undefined).kind).toBe('masp_fee');
    expect(verdictOf(row1, b, new Map([[W1, OTHER]]))).toEqual({ kind: 'unshield', reason: 'the wrapper names another account as its fee payer' });
    expect(verdictOf(row1, { ...b, events: b.events.filter((e) => e.type !== 'masp/fee-payment') }, undefined)).toEqual({ kind: 'unshield', reason: 'no masp/fee-payment event for its inner transaction' });
  });
  it('block 8,510,819: a small target of a transfer with two targets stays an unshield (its fee is on the row)', () => {
    // were the gas payer's leg stored as a row of its own, the two targets keep it an unshield
    const r = stored(8510819, `namada:${W2}:1:1`, GAS2, 0.134937, { descriptor: 'transfer-from-wasm', innerTxHash: I2 });
    const v = verdictOf(r, blockOf(8510819), feePayersOf(txsOf(8510819)));
    expect(v.kind).toBe('unshield');
    expect(v.kind === 'unshield' && v.reason).toMatch(/^the pool paid 2 targets/);
  });
  it('the migration it renders moves the daily edges once and re-files the rows once: applied twice, the second pass changes nothing', () => {
    const db = testD1();
    const day = '2026-11-02', ts = Date.UTC(2026, 10, 2, 17, 35);
    insert(db, 'flows', [
      { id: row1.id, chain: 'namada', height: 8515250, ts, tx_hash: W1, kind: 'unshield', from_addr: MASP, to_addr: GAS1, amount_num: 0.175, value_usd: null, meta: row1.meta },
      { id: 'namada:K:1', chain: 'namada', height: 8515300, ts: ts + 60_000, tx_hash: 'K', kind: 'unshield', from_addr: MASP, to_addr: USER, amount_num: 20, value_usd: 0.02, meta: JSON.stringify({ innerTxHash: 'KI' }) },
    ]);
    insert(db, 'flow_edges_daily', [{ day, chain: 'namada', kind: 'unshield', from_cat: 'masp', to_cat: 'user', n: 2, nam: 20.175, usd: null }]);
    const edgeRows = [
      { id: row1.id, ts, to_addr: GAS1, amount_num: 0.175, value_usd: null, to_cat: null, to_src: null },
      { id: 'namada:K:1', ts: ts + 60_000, to_addr: USER, amount_num: 20, value_usd: 0.02, to_cat: null, to_src: null },
    ];
    const plans = edgePlans(edgeRows, new Set([row1.id]), [{ day, kind: 'unshield', to_cat: 'user', n: 2, nam: 20.175, usd: null }]);
    expect(plans).toEqual([{ day, toCat: 'user', guardId: row1.id, stored: { day, kind: 'unshield', to_cat: 'user', n: 2, nam: 20.175, usd: null }, remaining: { n: 1, nam: 20, usd: 0.02 }, moved: { n: 1, nam: 0.175, usd: null } }]);
    const sql = renderMigration({ refiled: [{ row: row1, verdict: { kind: 'masp_fee', indexedTx: '{"block_height":8515250,"block_index":0,"batch_index":0}', innerTxHash: I1 } }], left: [], edges: plans, nodes: DEFAULT_NODES, today: '2026-11-07' });
    expect(sql).toContain(`UPDATE flows SET kind = 'masp_fee' WHERE id = '${row1.id}' AND kind = 'unshield';`);
    expect(sql).toContain('indexed-tx {"block_height":8515250,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com');
    expect(sql).not.toMatch(/CREATE TRIGGER/i);
    expect(sqlStatements(sql).length).toBe(3);
    const state = () => ({
      kinds: db.raw.prepare('SELECT id, kind FROM flows ORDER BY id').all().map((r: any) => [r.id, r.kind]),
      edges: db.raw.prepare('SELECT kind, from_cat, to_cat, n, nam, usd FROM flow_edges_daily WHERE day = ? ORDER BY kind').all(day).map((r: any) => ({ ...r })),
    });
    db.raw.exec(sql);
    const once = state();
    expect(once.kinds).toEqual([[row1.id, 'masp_fee'], ['namada:K:1', 'unshield']]);
    expect(once.edges).toEqual([
      { kind: 'masp_fee', from_cat: 'masp', to_cat: 'user', n: 1, nam: 0.175, usd: null },
      { kind: 'unshield', from_cat: 'masp', to_cat: 'user', n: 1, nam: 20, usd: 0.02 },
    ]);
    db.raw.exec(sql);
    expect(state()).toEqual(once);
    // nothing to re-file renders nothing
    expect(renderMigration({ refiled: [], left: [], edges: [], nodes: DEFAULT_NODES, today: '2026-11-07' })).toBe('');
  });
  it('the committed migration, when present: every row statement guarded, a comment per row with its block, indexed-tx and the two nodes, no trigger', () => {
    const path = join(__dirname, '..', 'migrations', '0022_masp_fee_refile.sql');
    if (!existsSync(path)) return;
    const text = readFileSync(path, 'utf8');
    const stmts = sqlStatements(text);
    const updates = stmts.filter((s) => /^UPDATE flows SET kind = 'masp_fee'/.test(s));
    expect(updates.length).toBeGreaterThan(0);
    for (const u of updates) expect(u).toMatch(/^UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:[0-9A-F]+:\d+(:\d+)?' AND kind = 'unshield'$/);
    const comments = text.split('\n').filter((l) => /^-- block [\d,]+, [\d.]+ NAM, indexed-tx \{"block_height":\d+,"block_index":\d+,"batch_index":\d+\}; the same events from https:\/\/namada-rpc\.stakeandrelax\.net and https:\/\/namada-rpc\.polkachu\.com$/.test(l));
    expect(comments.length).toBe(updates.length);
    expect(text).not.toMatch(/CREATE TRIGGER/i);
    expect(text).toMatch(/Rows before block 7,682,174 are out of scope/);
    for (const s of stmts.filter((s) => /flow_edges_daily/.test(s))) expect(s).toMatch(/EXISTS \(SELECT 1 FROM flows WHERE id = 'namada:[0-9A-F:]+' AND kind = 'unshield'\)/);
  });
});
