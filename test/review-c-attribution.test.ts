// Review run 2, group C (worker/src/analytics.ts:pressure:linked-origin-from-directionless-address-links).
// address_links keeps one row per (osmo1, tnam1) pair for both bridge directions: an Osmosis account that sends
// NAM to a Namada wallet it chooses writes the same kind of row as a Namada wallet that sent NAM to it. pressure()
// read the pair with the most volume as the receiver's Namada origin, so an Osmosis account could make any wallet,
// a genesis wallet included, the shown source of its NAM (and put its NAM in the genesis cohort) by bridging a
// little more NAM to that wallet than any one sender ever bridged to it. The same rows named the Osmosis account
// whose sales were counted as a withdrawer's. Both now come from Osmosis's own records of crossings from Namada.
import { describe, it, expect } from 'vitest';
import { pressure } from '../worker/src/analytics';
import { stmt } from '../worker/src/db';
import { testD1, insert } from './d1-sqlite';
import { INTERNAL_ADDRESSES } from '../shared/alerts';

const NOW = Date.UTC(2026, 9, 18, 12, 0);
const H = 3600_000, D = 86400_000;
const POS = INTERNAL_ADDRESSES.pos;

const A = 'osmo1recv_a';
const T1 = 'tnam1qsender_one', T2 = 'tnam1qsender_two';
const G = 'tnam1qgenesis_fdn';

const link = (db: any, l: { osmo: string; namada: string; amount: number; ts: number }) => {
  const s = stmt.link(l);
  return db.prepare(s.sql).bind(...s.params).run();
};

/** A receives 300,000 NAM from two Namada senders in the window; `aToG` adds A's own send of NAM to genesis wallet G. */
async function fixture(aToG: { ts: number } | null) {
  const db = testD1();
  insert(db, 'labels', [{ address: G, chain: 'namada', label: 'Genesis: Anoma Foundation', category: 'foundation', source: 'genesis' }]);
  insert(db, 'flows', [
    { id: 'o1', chain: 'osmosis', height: 1, ts: NOW - 20 * H, tx_hash: 'O1', kind: 'ibc_in', from_addr: T1, to_addr: A, amount_num: 150_000, meta: null },
    { id: 'o2', chain: 'osmosis', height: 2, ts: NOW - 19 * H, tx_hash: 'O2', kind: 'ibc_in', from_addr: T2, to_addr: A, amount_num: 150_000, meta: null },
  ]);
  // The links the parsers write for those two crossings (parse/osmosis.ts recv_packet: {osmo: receiver, namada: sender}).
  await link(db, { osmo: A, namada: T1, amount: 150_000, ts: NOW - 20 * H });
  await link(db, { osmo: A, namada: T2, amount: 150_000, ts: NOW - 19 * H });
  if (aToG) {
    // A sends 150,001 NAM from Osmosis to G: Osmosis records A's send, Namada the receipt, and parse/namada.ts writes
    // the link {osmo: packet sender A, namada: receiver G} into the same table (test/parsers.test.ts pins that shape).
    insert(db, 'flows', [
      { id: 'og', chain: 'osmosis', height: 3, ts: aToG.ts, tx_hash: 'OG', kind: 'ibc_out', from_addr: A, to_addr: G, amount_num: 150_001, meta: null },
      { id: 'ng', chain: 'namada', height: 3, ts: aToG.ts, tx_hash: 'NG', kind: 'ibc_in', from_addr: A, to_addr: G, amount_num: 150_001, meta: JSON.stringify({ innerTxHash: 'ng' }) },
    ]);
    await link(db, { osmo: A, namada: G, amount: 150_001, ts: aToG.ts });
  }
  return db;
}

describe('a bridge receiver\'s Namada origin comes only from NAM that crossed from Namada to it', () => {
  it('A sending NAM to a genesis wallet does not make that wallet the origin of A\'s NAM, nor its NAM genesis NAM', async () => {
    const db = await fixture({ ts: NOW - 2 * D });
    const p = await pressure(db as any, NOW, false, 7);
    const e = p.onDeck.find((d) => d.address === A)!;
    expect(e.bridgedIn).toBe(300_000);
    expect([T1, T2]).toContain(e.linkedNamada);
    expect(e.linkedNamada).toBe(T1); // the two sent the same; the earlier crossing is named
    expect(e.linkedLabel).toBeNull();
    expect(e.linkedLabelSource).toBeNull();
    expect(p.pipelineSummary!.cohorts.genesisBackersNam).toBe(0);
    expect(p.pipelineSummary!.cohorts.transparentNam).toBe(300_000);
  });

  it('the same when A sent NAM to the genesis wallet long before the window (the link table counts all time)', async () => {
    const p = await pressure((await fixture({ ts: NOW - 60 * D })) as any, NOW, false, 7);
    const e = p.onDeck.find((d) => d.address === A)!;
    expect([T1, T2]).toContain(e.linkedNamada);
    expect(p.pipelineSummary!.cohorts.genesisBackersNam).toBe(0);
    expect(p.pipelineSummary!.cohorts.transparentNam).toBe(300_000);
  });

  it('control: without the send to G the answer is the same', async () => {
    const p = await pressure((await fixture(null)) as any, NOW, false, 7);
    expect(p.onDeck.find((d) => d.address === A)!.linkedNamada).toBe(T1);
    expect(p.pipelineSummary!.cohorts.genesisBackersNam).toBe(0);
  });

  it('a genesis wallet that really bridged the NAM is still named, and its NAM is genesis NAM', async () => {
    const db = await fixture(null);
    insert(db, 'flows', [{ id: 'o3', chain: 'osmosis', height: 4, ts: NOW - 10 * H, tx_hash: 'O3', kind: 'ibc_in', from_addr: G, to_addr: A, amount_num: 200_000, meta: null }]);
    await link(db, { osmo: A, namada: G, amount: 200_000, ts: NOW - 10 * H });
    const p = await pressure(db as any, NOW, false, 7);
    const e = p.onDeck.find((d) => d.address === A)!;
    expect(e).toMatchObject({ linkedNamada: G, linkedLabel: 'Genesis: Anoma Foundation', linkedLabelSource: 'genesis', bridgedIn: 500_000 });
    expect(p.pipelineSummary!.cohorts.genesisBackersNam).toBe(500_000);
  });
});

describe('the Osmosis account whose sales are counted as a withdrawer\'s is one the withdrawer sent NAM to', () => {
  const W = 'tnam1qbig_withdrawer', O = 'osmo1stranger';
  const seed = () => {
    const db = testD1();
    insert(db, 'flows', [
      { id: 'w1', chain: 'namada', height: 1, ts: NOW - 3 * D, tx_hash: 'W_TX', kind: 'withdraw', from_addr: POS, to_addr: W, amount_num: 400_000, meta: null },
      { id: 's1', chain: 'osmosis', height: 5, ts: NOW - 2 * D, tx_hash: 'SELL', kind: 'sell', from_addr: O, to_addr: 'osmo1pool', amount_num: 250_000, meta: null },
    ]);
    return db;
  };

  it('an Osmosis account that sent NAM to the withdrawer does not turn the withdrawal into a sale', async () => {
    const db = seed();
    // O sends 1 NAM from Osmosis to W: the link table gets {osmo: O, namada: W}.
    insert(db, 'flows', [
      { id: 'x1', chain: 'osmosis', height: 2, ts: NOW - 4 * D, tx_hash: 'X1', kind: 'ibc_out', from_addr: O, to_addr: W, amount_num: 1, meta: null },
      { id: 'x2', chain: 'namada', height: 2, ts: NOW - 4 * D, tx_hash: 'X2', kind: 'ibc_in', from_addr: O, to_addr: W, amount_num: 1, meta: JSON.stringify({ innerTxHash: 'x2' }) },
    ]);
    await link(db, { osmo: O, namada: W, amount: 1, ts: NOW - 4 * D });
    const p = await pressure(db as any, NOW, false);
    expect(p.unlocks.find((u) => u.txHash === 'W_TX')!.outcome).toEqual({ kind: 'liquid', amountNam: 400_000 });
  });

  it('control: when the withdrawer sent NAM to that account after withdrawing, its sales are counted', async () => {
    const db = seed();
    // three days after the withdrawal, past the 48 h a send back is counted as "bridged out"
    insert(db, 'flows', [{ id: 'y1', chain: 'osmosis', height: 2, ts: NOW - 3 * D + 60 * H, tx_hash: 'Y1', kind: 'ibc_in', from_addr: W, to_addr: O, amount_num: 300_000, meta: null }]);
    await link(db, { osmo: O, namada: W, amount: 300_000, ts: NOW - 3 * D + 60 * H });
    db.raw.prepare("UPDATE flows SET ts = ? WHERE id = 's1'").run(NOW - 3 * D + 61 * H);
    const p = await pressure(db as any, NOW, false);
    expect(p.unlocks.find((u) => u.txHash === 'W_TX')!.outcome).toEqual({ kind: 'sold', amountNam: 250_000 });
  });

  it('a crossing made before the withdrawal cannot have carried the withdrawn NAM: that account\'s later sales are not counted', async () => {
    const db = seed();
    insert(db, 'flows', [{ id: 'z1', chain: 'osmosis', height: 2, ts: NOW - 4 * D, tx_hash: 'Z1', kind: 'ibc_in', from_addr: W, to_addr: O, amount_num: 300_000, meta: null }]);
    await link(db, { osmo: O, namada: W, amount: 300_000, ts: NOW - 4 * D });
    const p = await pressure(db as any, NOW, false);
    expect(p.unlocks.find((u) => u.txHash === 'W_TX')!.outcome).toEqual({ kind: 'liquid', amountNam: 400_000 });
  });
});
