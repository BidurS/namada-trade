// Review of 42971be..7f1dd3c, Supply page attribution (worker/src/analytics.ts pressure).
// 1. The Osmosis account whose sales count as a withdrawer's was read from the earliest withdrawal in the whole
//    unlock list, not the withdrawer's own, and any sale it made in the 7 days after a withdrawal counted, even one
//    made before any NAM crossed to it, or larger than what crossed. A sale now counts only up to the NAM the
//    withdrawer (or its burner) sent that account between the withdrawal and the sale.
// 2. A receiver's whole bridgedIn went to the cohort of its single largest Namada sender, so NAM from untagged
//    senders was counted as genesis NAM (and a larger untagged sender pushed a genesis sender's NAM out of it).
//    Each sender's own NAM into the receiver now goes to that sender's cohort.
import { describe, it, expect } from 'vitest';
import { pressure } from '../worker/src/analytics';
import { testD1, insert } from './d1-sqlite';
import { INTERNAL_ADDRESSES } from '../shared/alerts';

const NOW = Date.UTC(2026, 9, 18, 12, 0);
const H = 3600_000, D = 86400_000;
const POS = INTERNAL_ADDRESSES.pos;

const withdraw = (id: string, ts: number, to: string, nam: number) =>
  ({ id, chain: 'namada', height: 1, ts, tx_hash: id.toUpperCase(), kind: 'withdraw', from_addr: POS, to_addr: to, amount_num: nam, meta: null });
const crossing = (id: string, ts: number, from: string, to: string, nam: number) =>
  ({ id, chain: 'osmosis', height: 3, ts, tx_hash: id.toUpperCase(), kind: 'ibc_in', from_addr: from, to_addr: to, amount_num: nam, meta: null });
const sale = (id: string, ts: number, from: string, nam: number) =>
  ({ id, chain: 'osmosis', height: 5, ts, tx_hash: id.toUpperCase(), kind: 'sell', from_addr: from, to_addr: 'osmo1pool', amount_num: nam, meta: null });

describe('a sale counts as a withdrawer\'s only for NAM it sent that account between the withdrawal and the sale', () => {
  const W1 = 'tnam1qwone', W2 = 'tnam1qwtwo', O = 'osmo1oacct';

  it('(a) a crossing made before the withdrawer\'s own withdrawal does not count, even when another address withdrew earlier', async () => {
    const db = testD1();
    insert(db, 'flows', [
      withdraw('w1_tx', NOW - 25 * D, W1, 200_000),
      withdraw('w2_tx', NOW - 3 * D, W2, 400_000),
      crossing('z1', NOW - 13 * D, W2, O, 300_000), // ten days before W2's withdrawal
      sale('s1', NOW - 2 * D, O, 250_000),
    ]);
    const p = await pressure(db as any, NOW, false);
    expect(p.unlocks.find((u) => u.txHash === 'W2_TX')!.outcome).toEqual({ kind: 'liquid', amountNam: 400_000 });
    expect(p.unlocks.find((u) => u.txHash === 'W1_TX')!.outcome).toEqual({ kind: 'liquid', amountNam: 200_000 });
  });

  it('(a) control: the earlier withdrawer\'s own crossing after its withdrawal still counts its account\'s later sales', async () => {
    const db = testD1();
    insert(db, 'flows', [
      withdraw('w1_tx', NOW - 25 * D, W1, 200_000),
      withdraw('w2_tx', NOW - 3 * D, W2, 400_000),
      crossing('z0', NOW - 22 * D, W1, 'osmo1w1acct', 150_000), // 3 days after W1's withdrawal
      sale('s0', NOW - 21 * D, 'osmo1w1acct', 120_000),
    ]);
    const p = await pressure(db as any, NOW, false);
    expect(p.unlocks.find((u) => u.txHash === 'W1_TX')!.outcome).toEqual({ kind: 'sold', amountNam: 120_000 });
    expect(p.unlocks.find((u) => u.txHash === 'W2_TX')!.outcome).toEqual({ kind: 'liquid', amountNam: 400_000 });
  });

  it('(b) a sale made before any NAM crossed does not count, nor more than what crossed', async () => {
    const W = 'tnam1qwb', OB = 'osmo1ob';
    const db = testD1();
    insert(db, 'flows', [
      withdraw('w_tx', NOW - 6 * D, W, 400_000),
      sale('s1', NOW - 5 * D, OB, 250_000), // before the crossing
      crossing('c1', NOW - 1 * D, W, OB, 1),
    ]);
    let p = await pressure(db as any, NOW, false);
    expect(p.unlocks.find((u) => u.txHash === 'W_TX')!.outcome).toEqual({ kind: 'liquid', amountNam: 400_000 });
    // a sale after the 1 NAM crossing counts that 1 NAM, not the 250,000 it sold
    db.raw.prepare("UPDATE flows SET ts = ? WHERE id = 's1'").run(NOW - 1 * D + H);
    p = await pressure(db as any, NOW, false);
    expect(p.unlocks.find((u) => u.txHash === 'W_TX')!.outcome).toEqual({ kind: 'sold', amountNam: 1 });
  });

  it('several crossings back several sales, each NAM of a crossing at most once', async () => {
    const W = 'tnam1qwmulti', OM = 'osmo1omulti';
    const db = testD1();
    insert(db, 'flows', [
      withdraw('w_tx', NOW - 6 * D, W, 400_000),
      crossing('c1', NOW - 5 * D, W, OM, 100_000),
      sale('s1', NOW - 5 * D + H, OM, 80_000),
      sale('s2', NOW - 4 * D, OM, 80_000), // 20,000 of c1 left for it
      crossing('c2', NOW - 3 * D, W, OM, 50_000),
      sale('s3', NOW - 3 * D + H, OM, 90_000), // 50,000 of c2
    ]);
    const p = await pressure(db as any, NOW, false);
    expect(p.unlocks.find((u) => u.txHash === 'W_TX')!.outcome).toEqual({ kind: 'sold', amountNam: 150_000 });
  });

  it('the burner path: a burner\'s sale before its crossing, or after a crossing made before the transfer, does not count', async () => {
    const W = 'tnam1qwburn', B = 'tnam1qburner_x', OB = 'osmo1oburn';
    const db = testD1();
    insert(db, 'flows', [
      withdraw('w_tx', NOW - 6 * D, W, 400_000),
      { id: 'hop', chain: 'namada', height: 2, ts: NOW - 6 * D + H, tx_hash: 'HOP', kind: 'transfer', from_addr: W, to_addr: B, amount_num: 400_000, meta: null },
      sale('s1', NOW - 5 * D, OB, 250_000),
      crossing('c1', NOW - 1 * D, B, OB, 1),
    ]);
    let p = await pressure(db as any, NOW, false);
    expect(p.unlocks.find((u) => u.txHash === 'W_TX')!.outcome).toEqual({ kind: 'liquid', amountNam: 400_000 });

    // the burner's only crossing is before the transfer reached it (after an unrelated, earlier withdrawal)
    insert(db, 'flows', [withdraw('w0_tx', NOW - 25 * D, 'tnam1qwearly', 200_000)]);
    db.raw.prepare("UPDATE flows SET ts = ?, amount_num = 300000 WHERE id = 'c1'").run(NOW - 10 * D);
    p = await pressure(db as any, NOW, false);
    expect(p.unlocks.find((u) => u.txHash === 'W_TX')!.outcome).toEqual({ kind: 'liquid', amountNam: 400_000 });

    // control: a crossing after the transfer and before the sale is counted, at most what crossed
    db.raw.prepare("UPDATE flows SET ts = ?, amount_num = 100000 WHERE id = 'c1'").run(NOW - 5 * D - H);
    p = await pressure(db as any, NOW, false);
    expect(p.unlocks.find((u) => u.txHash === 'W_TX')!.outcome).toEqual({ kind: 'sold', amountNam: 100_000 });
  });
});

describe('each Namada sender\'s NAM goes to that sender\'s cohort, not the whole receiver to its largest sender\'s', () => {
  const A = 'osmo1shared_contract', G = 'tnam1qgenesis_pub';
  const genesisLabel = { address: G, chain: 'namada', label: 'Genesis: public_allocations_completed', category: 'genesis', source: 'genesis' };

  it('a shared receiver whose largest sender is tagged genesis: only that sender\'s NAM is genesis NAM', async () => {
    const db = testD1();
    insert(db, 'labels', [genesisLabel]);
    const rows: any[] = [crossing('g', NOW - 30 * H, G, A, 50_001)];
    for (let i = 0; i < 20; i++) rows.push({ ...crossing('t' + i, NOW - 20 * H + i, 'tnam1qsender' + i, A, 50_000), height: 10 + i });
    insert(db, 'flows', rows);
    const p = await pressure(db as any, NOW, false, 7);
    const e = p.onDeck.find((d) => d.address === A)!;
    expect(e).toMatchObject({ linkedNamada: G, linkedLabelSource: 'genesis', bridgedIn: 1_050_001 });
    expect(p.pipelineSummary!.cohorts).toEqual({ genesisBackersNam: 50_001, maspTurnstileNam: 0, burnerHopNam: 0, transparentNam: 1_000_000 });
  });

  it('a larger untagged sender does not push a genesis sender\'s NAM out of the genesis cohort', async () => {
    const db = testD1();
    insert(db, 'labels', [genesisLabel]);
    insert(db, 'flows', [crossing('g', NOW - 30 * H, G, A, 200_000), crossing('t', NOW - 20 * H, 'tnam1qbigger', A, 200_001)]);
    const p = await pressure(db as any, NOW, false, 7);
    expect(p.onDeck.find((d) => d.address === A)!.linkedNamada).toBe('tnam1qbigger');
    expect(p.pipelineSummary!.cohorts).toMatchObject({ genesisBackersNam: 200_000, transparentNam: 200_001 });
  });

  it('a sender that is not the largest is still read as a middle address, against its own crossing and amount', async () => {
    const db = testD1();
    const B = 'tnam1qburner_small', V = 'tnam1qvault_gen', R = 'tnam1qrelay_plain', U = 'tnam1qorigin_plain';
    insert(db, 'labels', [{ address: V, chain: 'namada', label: 'Genesis: early_backer', category: 'backer', source: 'genesis' }]);
    insert(db, 'flows', [
      crossing('t', NOW - 40 * H, 'tnam1qtop_plain', A, 400_000),
      // B got 300,000 from a genesis vault two hours before its own crossing (38 h after A's first arrival)
      { id: 'h1', chain: 'namada', height: 2, ts: NOW - 4 * H, tx_hash: 'H1', kind: 'transfer', from_addr: V, to_addr: B, amount_num: 300_000, meta: null },
      crossing('b', NOW - 2 * H, B, A, 300_000),
      // R got 90,000 from an untagged address the hour before its crossing
      { id: 'h2', chain: 'namada', height: 3, ts: NOW - 6 * H, tx_hash: 'H2', kind: 'transfer', from_addr: U, to_addr: R, amount_num: 90_000, meta: null },
      crossing('r', NOW - 5 * H, R, A, 90_000),
    ]);
    const p = await pressure(db as any, NOW, false, 7);
    expect(p.onDeck.find((d) => d.address === A)!).toMatchObject({ linkedNamada: 'tnam1qtop_plain', bridgedIn: 790_000 });
    expect(p.pipelineSummary!.cohorts).toEqual({ genesisBackersNam: 300_000, maspTurnstileNam: 0, burnerHopNam: 90_000, transparentNam: 400_000 });
  });

  it('NAM from a sender Osmosis did not record as a tnam1 address stays in the other-addresses part, so the parts add up to what crossed', async () => {
    const db = testD1();
    insert(db, 'labels', [genesisLabel]);
    insert(db, 'flows', [crossing('g', NOW - 30 * H, G, A, 100_000), crossing('n', NOW - 20 * H, null as any, A, 40_000)]);
    const p = await pressure(db as any, NOW, false, 7);
    const c = p.pipelineSummary!.cohorts;
    expect(c).toMatchObject({ genesisBackersNam: 100_000, transparentNam: 40_000 });
    expect(c.genesisBackersNam + c.maspTurnstileNam + c.burnerHopNam + c.transparentNam).toBe(p.onDeckTotals!.bridgedIn);
  });

  it('a receiver whose own tag says genesis keeps all it got in that cohort', async () => {
    const db = testD1();
    insert(db, 'labels', [{ address: A, chain: 'osmosis', label: 'Team treasury', category: 'team', source: 'auto' }]);
    insert(db, 'flows', [crossing('t', NOW - 20 * H, 'tnam1qplain', A, 70_000)]);
    const p = await pressure(db as any, NOW, false, 7);
    expect(p.pipelineSummary!.cohorts).toMatchObject({ genesisBackersNam: 70_000, transparentNam: 0 });
  });
});
