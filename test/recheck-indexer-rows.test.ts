// The indexer-era re-check (scripts/recheck-indexer-rows.ts, 2026-11-07): a row the indexer import wrote is judged by
// its block's own tx/applied event, as two nodes give it, by the live decoders' rule (code 0, result Ok, no rejecting
// validity predicate). Fixtures are two blocks' block_results as the public nodes answered them on 2026-11-07, whole:
// block 8,202,488 (the bond migration 0020 took out: its result reads Ok and the staking validity predicate rejected
// it) and block 2,383,989 (a 1 NAM transfer the chain applied, the import's first transfer row).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { reduceBlock, blockKey, judge, duplicates, sqlForRow, stakeEstimateSql, sideCategory, dayOf, reduceTxs, txsKey, needsTxs, type Row, type ReducedBlock, type TxSummary } from '../scripts/recheck-indexer-rows';
import * as decoder from '../worker/src/parse/namada-tx';

const fixture = (name: string) => JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'));
const A = 'https://node-a.example', B = 'https://node-b.example';
const POS = 'tnam1qgqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqc8j2fp';
const AT = Date.parse('2026-11-07T00:00:00Z');

const rejectedBond: Row = {
  id: 'namada:8D515657565D2D26ABE13CCA578DACAF537B481F97FBEA556763D19195E77322:pos', height: 8202488, ts: Date.parse('2026-10-08T07:50:00Z'),
  tx_hash: '8D515657565D2D26ABE13CCA578DACAF537B481F97FBEA556763D19195E77322', kind: 'bond', from_addr: POS, to_addr: POS, amount_num: 0.00001,
  meta: '{"source":"namada-indexer","txKind":"bond"}',
};
const transfer: Row = {
  id: 'namada:E4BD730786BFF1D47F8917AA19A5CAD107F12C13C42A96FE0A2C27D8FEBF05F6:h0', height: 2383989, ts: 1749796924785,
  tx_hash: 'E4BD730786BFF1D47F8917AA19A5CAD107F12C13C42A96FE0A2C27D8FEBF05F6', kind: 'transfer',
  from_addr: 'tnam1qqrhwfj678xq07nfwmmxkvjgzzdr9ywamqqjn88x', to_addr: 'tnam1qrhxw5d73h9w059j4q7w939pqhs3tgxnkgjznzgg', amount_num: 1,
  meta: '{"source":"namada-indexer","txKind":"transparentTransfer","tsSource":"interpolated"}',
};

const pair = (name: string, h: number): ReducedBlock[] => [reduceBlock(fixture(name), h, A, AT)!, reduceBlock(fixture(name), h, B, AT)!];

describe('a block_results answer, reduced', () => {
  it('keeps each inner transaction\'s verdict and the staking keys it changed', () => {
    const b = reduceBlock(fixture('namada_block_results_8202488.json'), 8202488, A, AT)!;
    expect(b.empty).toBe(false);
    expect(b.applied).toHaveLength(1);
    const ev = b.applied[0];
    expect(ev.wrapper).toBe('E953E69AF1027AEF7BC467C9E86A400AE226744CCC10203A67C685EA5BF2CCCE');
    expect(ev.code).toBe('0');
    const res = ev.batch![rejectedBond.tx_hash];
    expect(res.ok).toBe(true);
    expect(res.rejected).toEqual([POS]);
    expect(res.posKeys).toEqual([`${POS}|tnam1q8s9kj30dhsnw5kvtf0mq2exgyup64l28sxn953p`]);
    expect(b.tokens).toEqual([]);
  });

  it('keeps the NAM legs of a token/transfer event by account', () => {
    const b = reduceBlock(fixture('namada_block_results_2383989.json'), 2383989, A, AT)!;
    expect(b.tokens).toHaveLength(1);
    expect(b.tokens[0].inner).toBe(transfer.tx_hash);
    expect(b.tokens[0].sources).toEqual({ [transfer.from_addr!]: 1 });
    expect(b.tokens[0].targets).toEqual({ [transfer.to_addr!]: 1 });
    expect(b.applied[0].batch![transfer.tx_hash]).toEqual({ ok: true, rejected: [], posKeys: [] });
  });

  it('is no block when the answer is another height or not an answer', () => {
    expect(reduceBlock(fixture('namada_block_results_2383989.json'), 2383990, A, AT)).toBeNull();
    expect(reduceBlock({ error: { code: -32603 } }, 2383989, A, AT)).toBeNull();
    expect(reduceBlock(null, 1, A, AT)).toBeNull();
  });

  it('two nodes agree when verdicts and legs are the same, whatever the order; a different verdict is a different block', () => {
    const [a, b] = pair('namada_block_results_8202488.json', 8202488);
    expect(blockKey(a)).toBe(blockKey(b));
    const other = structuredClone(b);
    other.applied[0].batch![rejectedBond.tx_hash].rejected = [];
    expect(blockKey(a)).not.toBe(blockKey(other));
  });
});

describe('the judgement', () => {
  it('a result the staking validity predicate rejected is not applied, though it reads Ok (block 8,202,488)', () => {
    const j = judge(rejectedBond, pair('namada_block_results_8202488.json', 8202488));
    expect(j.verdict).toEqual({ state: 'not_applied', reason: 'a validity predicate rejected it (1)' });
    expect(j.by).toEqual([A, B]);
    expect(j.sides).toBe('same'); // the row's delegator is the staking account, which the changed keys name
    expect(j.amount).toBeNull(); // a bond's amount is in the tx bytes, not compared here
  });

  it('a transfer the chain applied, with the event\'s NAM at the row\'s side', () => {
    const j = judge(transfer, pair('namada_block_results_2383989.json', 2383989));
    expect(j.verdict).toEqual({ state: 'applied' });
    expect(j.amount).toBe('same');
    const off = judge({ ...transfer, amount_num: 1.5 }, pair('namada_block_results_2383989.json', 2383989));
    expect(off.amount).toBe('differs');
    expect(off.eventAmount).toBe(1);
  });

  it('a result that is not Ok is not applied; a wrapper code other than 0 over an Ok result waits for the tx bytes', () => {
    const [a, b] = pair('namada_block_results_2383989.json', 2383989);
    const codeA = structuredClone(a), codeB = structuredClone(b);
    codeA.applied[0].code = '1'; codeB.applied[0].code = '1';
    expect(judge(transfer, [codeA, codeB]).verdict).toEqual({ state: 'batch_unread' });
    const errA = structuredClone(a), errB = structuredClone(b);
    errA.applied[0].batch![transfer.tx_hash].ok = false; errB.applied[0].batch![transfer.tx_hash].ok = false;
    expect(judge(transfer, [errA, errB]).verdict).toEqual({ state: 'not_applied', reason: 'the batch result is not Ok' });
  });

  it('a row the block does not name, a block the nodes differ on, and a block not read, each stay out of the deletes', () => {
    expect(judge({ ...transfer, tx_hash: 'AB'.repeat(32) }, pair('namada_block_results_2383989.json', 2383989)).verdict).toEqual({ state: 'not_in_block' });
    expect(judge(transfer, 'disagree').verdict).toEqual({ state: 'disagree' });
    expect(judge(transfer, null).verdict).toEqual({ state: 'unread' });
    expect(judge(transfer, [reduceBlock(fixture('namada_block_results_2383989.json'), 2383989, A, AT)!]).verdict).toEqual({ state: 'unread' });
  });

  it('a bond whose delegator no changed key names is marked, applied or not', () => {
    const j = judge({ ...rejectedBond, from_addr: 'tnam1qqrhwfj678xq07nfwmmxkvjgzzdr9ywamqqjn88x' }, pair('namada_block_results_8202488.json', 8202488));
    expect(j.sides).toBe('differs');
  });
});

// Block 737,716 (2025-02-01): one wrapper of two unbonds, not atomic; the second ran out of gas (Err), so the wrapper's
// code is 1 while the first's result reads Ok. The chain kept the first (14,075 NAM), as its tx bytes show.
describe('a batch whose code is not 0 though the row\'s own result is Ok: the tx bytes decide', () => {
  const H = 737716;
  const INNER = 'FD0800606D98DB48ABF270BCB20025F1FFB92C087263516DCC32FB73CDC271AD';
  const WRAPPER = 'B1E6D4F52EA7385731063A202E4AEC2954E950F5EB9812FD20D6657AEA94B925';
  const blocks = pair('namada_block_results_737716.json', H);
  const txs = (): TxSummary[] => [reduceTxs(fixture('namada_block_737716_txs.json'), H, A, decoder, AT)!, reduceTxs(fixture('namada_block_737716_txs.json'), H, B, decoder, AT)!];
  const stake = txs()[0].wrappers[WRAPPER].inners[INNER].stake!;
  const unbond: Row = { id: `namada:${INNER}:pos`, height: H, ts: Date.parse('2025-02-01T12:00:00Z'), tx_hash: INNER, kind: 'unbond', from_addr: POS, to_addr: stake.source, amount_num: 14075, meta: '{"source":"namada-indexer","txKind":"unbond"}' };

  it('the event alone says the row needs the tx bytes', () => {
    const ev = blocks[0].applied.find((e) => e.wrapper === WRAPPER)!;
    expect(ev.code).toBe('1');
    expect(ev.batch![INNER]).toEqual({ ok: true, rejected: [], posKeys: [`${stake.source}|${stake.validator}`] });
    expect(needsTxs(ev, ev.batch![INNER])).toBe(true);
    expect(Object.values(ev.batch!).filter((r) => !r.ok)).toHaveLength(1);
  });

  it('the tx bytes, reduced: the wrapper is not atomic and both unbonds decode with the code they ran', () => {
    const t = txs()[0];
    expect(t.nTxs).toBe(1);
    expect(t.decodeErrors).toBe(0);
    const w = t.wrappers[WRAPPER];
    expect(w.atomic).toBe(false);
    expect(Object.keys(w.inners)).toHaveLength(2);
    expect(w.inners[INNER].tag).toBe('tx_unbond.wasm');
    expect(stake.amount).toBe(14075);
    expect(stake.source).toMatch(/^tnam1/);
    expect(txsKey(txs()[0])).toBe(txsKey(txs()[1]));
    expect(reduceTxs(fixture('namada_block_737716_txs.json'), H + 1, A, decoder, AT)).toBeNull();
  });

  it('not atomic: applied, with the note, and the stored amount and delegator checked against the decoded request', () => {
    const j = judge(unbond, blocks, txs());
    expect(j.verdict).toEqual({ state: 'applied', note: "another inner transaction of its batch failed (the wrapper's code is 1); the batch is not atomic, so this one's writes stand" });
    expect(j.amount).toBe('same');
    expect(j.sides).toBe('same');
    const off = judge({ ...unbond, amount_num: 14000 }, blocks, txs());
    expect(off.amount).toBe('differs');
    expect(off.eventAmount).toBe(14075);
  });

  it('atomic: the chain dropped the whole batch, so the row is not applied', () => {
    const t = txs();
    t[0].wrappers[WRAPPER].atomic = true; t[1].wrappers[WRAPPER].atomic = true;
    expect(judge(unbond, blocks, t).verdict).toEqual({ state: 'not_applied', reason: "another inner transaction of its atomic batch failed (the wrapper's code is 1), so the chain dropped the whole batch" });
  });

  it('without the tx bytes the row is "batch not read", never not applied; nodes that differ on them are a disagreement', () => {
    expect(judge(unbond, blocks).verdict).toEqual({ state: 'batch_unread' });
    expect(judge(unbond, blocks, [txs()[0]]).verdict).toEqual({ state: 'batch_unread' });
    expect(judge(unbond, blocks, 'disagree').verdict).toEqual({ state: 'disagree' });
    const other = txs();
    other[1].wrappers[WRAPPER].atomic = true;
    expect(txsKey(other[0])).not.toBe(txsKey(other[1]));
  });
});

describe('rows recorded twice', () => {
  const row = (id: string, height: number, kind: string, hash: string, amount = 5): Row => ({ id, height, ts: 0, tx_hash: hash, kind, from_addr: 'tnam1from', to_addr: 'tnam1to', amount_num: amount, meta: null });
  it('the same inner transaction, kind, ends and amount twice is one repeat; a bridge leg repeated within 20 blocks is a relay repeat', () => {
    const d = duplicates([
      row('namada:AA:h0', 100, 'transfer', 'AA'), row('namada:AA:c0', 100, 'transfer', 'AA'),
      row('namada:BB:h0', 200, 'ibc_in', 'BB'), row('namada:CC:h0', 215, 'ibc_in', 'CC'), row('namada:DD:h0', 240, 'ibc_in', 'DD'),
      row('namada:EE:h0', 300, 'ibc_in', 'EE', 7),
    ]);
    expect(d).toEqual([
      { kept: 'namada:AA:c0', dropped: 'namada:AA:h0', kind: 'transfer', height: 100, amount: 5, why: 'same inner tx' },
      { kept: 'namada:BB:h0', dropped: 'namada:CC:h0', kind: 'ibc_in', height: 215, amount: 5, why: 'relay repeat' },
    ]);
  });
  it('two legs of one transaction to different receivers are not repeats', () => {
    expect(duplicates([row('namada:AA:h0', 100, 'transfer', 'AA'), { ...row('namada:AA:h1', 100, 'transfer', 'AA'), to_addr: 'tnam1other' }])).toEqual([]);
  });
});

describe('the SQL for a row the chain did not apply', () => {
  it('is what migration 0020 wrote: the day\'s counts and NAM less the row while it exists, the empty edge gone, the row deleted', () => {
    const labels = new Map<string, { category: string; source: string }>();
    expect(dayOf(rejectedBond.ts)).toBe('2026-10-08');
    expect(sideCategory(POS, undefined)).toBe('pos');
    expect(sideCategory('tnam1qqrhwfj678xq07nfwmmxkvjgzzdr9ywamqqjn88x', undefined)).toBe('user');
    expect(sideCategory('tnam1qqrhwfj678xq07nfwmmxkvjgzzdr9ywamqqjn88x', { category: 'genesis', source: 'genesis' })).toBe('genesis');
    expect(sideCategory('tnam1qqrhwfj678xq07nfwmmxkvjgzzdr9ywamqqjn88x', { category: 'genesis', source: 'user' })).toBe('user');
    const id = rejectedBond.id;
    expect(sqlForRow(rejectedBond, labels)).toEqual([
      `UPDATE activity_daily SET flows = flows - 1, nam = nam - (SELECT amount_num FROM flows WHERE id = '${id}') WHERE day = '2026-10-08' AND chain = 'namada' AND EXISTS (SELECT 1 FROM flows WHERE id = '${id}');`,
      `UPDATE flow_edges_daily SET n = n - 1, nam = nam - (SELECT amount_num FROM flows WHERE id = '${id}') WHERE day = '2026-10-08' AND chain = 'namada' AND kind = 'bond' AND from_cat = 'pos' AND to_cat = 'pos' AND EXISTS (SELECT 1 FROM flows WHERE id = '${id}');`,
      `DELETE FROM flow_edges_daily WHERE day = '2026-10-08' AND chain = 'namada' AND kind = 'bond' AND from_cat = 'pos' AND to_cat = 'pos' AND n <= 0;`,
      `DELETE FROM flows WHERE id = '${id}';`,
    ]);
    expect(stakeEstimateSql(POS)).toBe(`UPDATE stakes SET estimated_num = (SELECT SUM(CASE WHEN kind = 'bond' THEN amount_num ELSE -amount_num END) FROM flows WHERE chain = 'namada' AND ((kind = 'bond' AND from_addr = stakes.address) OR (kind = 'unbond' AND to_addr = stakes.address))) WHERE address = '${POS}';`);
  });
});
