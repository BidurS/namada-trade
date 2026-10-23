// Follow-up to the history backfill's two-node rule (2026-10-23): the 6,704 shielded-pool rows the masp step wrote on
// 2026-10-16 (meta.source 'namada-rpc-block-results') came from one archive node each and carry no meta.blockBy.
// scripts/stamp-block-agreement.ts reads their heights from two nodes again and stamps the rows of the blocks two
// nodes agree on, changing nothing else. Its pure parts: the key two answers are compared by, the comparison of a
// stored row with the current parser's reading of the agreed block, and the stamp statement, which is idempotent and
// leaves a row changed since it was read alone.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { testD1, insert } from './d1-sqlite';
import { sqlStatements } from '../scripts/sql-statements';
import { allEventsKey, blockEvents, compareRow, compareRows, nodeOrder, stampSql, stampable, SOURCE, type StoredRow } from '../scripts/stamp-block-agreement';
import { parseNamadaBlock } from '../worker/src/parse/namada';
import { NAMADA } from '../worker/src/config';
import type { Flow } from '../shared/types';

const MASP = NAMADA.internal.masp, ESCROW = NAMADA.internal.ibc;
const FIVE = 'https://rpc-namada.5elementsnodes.com', PAPA = 'https://rpc.papadritta.com', POLK = 'https://namada-rpc.polkachu.com';
// Block 4,707,359, one of the 4,657: a 10.1 NAM source leg the masp step wrote as one shield of 10.1 NAM into the pool;
// the parser reads 10 NAM shielded and a 0.1 NAM side output to another account.
const B4707359 = JSON.parse(readFileSync(new URL('./fixtures/namada_block_4707359.json', import.meta.url), 'utf8'));
const INNER = '1D49FAC502FACBC26B209FF438C43D71033B91FD1863BAABE14323CE710E4CA3';
const WRAPPER = 'DFE3007F915A378E822BEF607E175145219A4ABFD196DEFBF47F62018C39A091';
const SHIELDER = 'tnam1qpqfsmj2quxnakfq0rn8y2tjcvtz26f8pyw4fq98';

/** A row as the masp step wrote it (id namada:<inner>:c<i>, the inner hash as tx_hash, the wrapper in meta, no blockBy). */
const row = (o: Partial<StoredRow> & { tx_hash: string; kind: string; amount_num: number }, meta: Record<string, unknown> = {}): StoredRow => ({
  id: `namada:${o.tx_hash}:c0`, height: 4707359, ts: 1760000000000, from_addr: SHIELDER, to_addr: MASP,
  meta: JSON.stringify({ source: SOURCE, descriptor: 'transfer-from-wasm', wrapper: WRAPPER, tsSource: 'block', ...meta }),
  ...o,
});
const flow = (o: Partial<Flow> & { kind: Flow['kind']; amount: number }): Flow =>
  ({ id: `namada:${WRAPPER}:5`, chain: 'namada', height: 4707359, ts: 1, txHash: WRAPPER, from: MASP, to: 'tnam1qrecipient', priceUsd: null, valueUsd: null, ...o, meta: { descriptor: 'transfer-from-wasm', innerTxHash: INNER, ...(o.meta ?? {}) } });

describe('the key two answers are compared by', () => {
  it('is every event of the answer, attribute order and index flags aside', () => {
    const evs = blockEvents(B4707359)!;
    expect(evs.map((e) => e.type)).toEqual(['masp/transfer', 'token/transfer', 'tx/applied']);
    const shuffled = { result: { ...B4707359.result, end_block_events: B4707359.result.end_block_events.map((e: any) => ({ ...e, attributes: [...e.attributes].reverse().map((a: any) => ({ ...a, index: !a.index })) })) } };
    expect(allEventsKey(blockEvents(shuffled)!)).toBe(allEventsKey(evs));
    const forged = JSON.parse(JSON.stringify(B4707359));
    forged.result.end_block_events[1].attributes.find((a: any) => a.key === 'source-accounts').value = forged.result.end_block_events[1].attributes.find((a: any) => a.key === 'source-accounts').value.replace('10100000', '10100001');
    expect(allEventsKey(blockEvents(forged)!)).not.toBe(allEventsKey(evs));
    // the parser's begin_block_events and the transactions' events count too, not only token/ and masp/ events
    const moreTx = { result: { ...B4707359.result, txs_results: [{ events: [{ type: 'tx/applied', attributes: [{ key: 'code', value: '0' }] }] }] } };
    expect(allEventsKey(blockEvents(moreTx)!)).not.toBe(allEventsKey(evs));
  });
  it('an answer without a result or without any event is none', () => {
    expect(blockEvents({ error: { code: -32603 } })).toBeNull();
    expect(blockEvents({ result: { txs_results: [] } })).toBeNull();
    expect(blockEvents(null)).toBeNull();
  });
  it('the nodes are asked from a different one each height', () => {
    expect(nodeOrder([FIVE, PAPA, POLK], 0)).toEqual([FIVE, PAPA, POLK]);
    expect(nodeOrder([FIVE, PAPA, POLK], 4)).toEqual([PAPA, POLK, FIVE]);
    expect(nodeOrder([], 3)).toEqual([]);
  });
});

describe('a stored row against the current parser', () => {
  it('the split shield of block 4,707,359 differs by its amount, and a transaction the block does not hold is not in it', () => {
    const flows = parseNamadaBlock({ height: 4707359, ts: 1, events: blockEvents(B4707359)! }, null).flows;
    const stored = row({ tx_hash: INNER, kind: 'shield', amount_num: 10.1 });
    const c = compareRows([stored, row({ tx_hash: 'F'.repeat(64), kind: 'shield', amount_num: 1 })], flows);
    expect(c.get(stored.id)!.verdict).toBe('differs');
    expect(c.get(stored.id)!.detail).toMatch(/^amount 10.1 -> 10 \(the parser's other NAM rows of this transaction: transfer 0.1 …w4fq98->…jnmzup\)$/);
    expect(c.get(`namada:${'F'.repeat(64)}:c0`)).toEqual({ verdict: 'not in block', detail: 'the agreed block holds no event of this transaction' });
    expect(stampable(c.get(stored.id)!)).toBe(true);
    expect(stampable(c.get(`namada:${'F'.repeat(64)}:c0`)!)).toBe(false);
    // no address in a detail: an end is its last six characters
    expect(c.get(stored.id)!.detail).not.toContain('tnam1');
  });
  it('the same leg is the same; the end the parser resolves from the packet is the same but the ends', () => {
    const fee = row({ tx_hash: INNER, kind: 'unshield', amount_num: 0.149071, from_addr: MASP, to_addr: 'tnam1qgaspayer000000000000000000000000yh272v' });
    const out = row({ id: `namada:${INNER}:c1`, tx_hash: INNER, kind: 'ibc_out', amount_num: 349.468721, from_addr: MASP, to_addr: ESCROW }, { shielded: true });
    const flows = [
      flow({ id: `namada:${WRAPPER}:5`, kind: 'unshield', amount: 0.149071, to: 'tnam1qgaspayer000000000000000000000000yh272v' }),
      flow({ id: `namada:${WRAPPER}:6`, kind: 'ibc_out', amount: 349.468721, to: 'osmo1receiver', meta: { escrow: ESCROW, channel: 'channel-1', packetSequence: '1281' } }),
    ];
    const c = compareRows([fee, out], flows);
    expect(c.get(fee.id)).toEqual({ verdict: 'same', detail: '' });
    expect(c.get(out.id)).toEqual({ verdict: 'same but the ends', detail: "to …vtr7x4 -> …ceiver (the packet's receiver, sequence 1281)" });
    // a deposit the other way: the stored escrow is the sender's end
    const dep = row({ tx_hash: INNER, kind: 'ibc_in', amount_num: 14.492792, from_addr: ESCROW, to_addr: MASP });
    expect(compareRow(dep, [flow({ kind: 'ibc_in', amount: 14.492792, from: 'osmo1sender', to: MASP, meta: { escrow: ESCROW, packetSequence: '6338' } })]))
      .toEqual({ verdict: 'same but the ends', detail: "from …vtr7x4 -> …sender (the packet's sender, sequence 6338)" });
    // an ibc_out whose parser row keeps another end than the packet's resolution differs
    expect(compareRow(out, [flow({ kind: 'ibc_out', amount: 349.468721, to: 'osmo1receiver' })]).verdict).toBe('differs');
  });
  it('a fee leg the parser keeps as maspFeeNam is fee folded; a kind, wrapper or end that differs is reported', () => {
    const fee = row({ tx_hash: INNER, kind: 'unshield', amount_num: 0.1, from_addr: MASP, to_addr: 'tnam1qgaspayer' });
    const main = flow({ kind: 'unshield', amount: 9.9, to: 'tnam1qrecipient', meta: { maspFeeNam: 0.1 } });
    expect(compareRow(fee, [main])).toEqual({ verdict: 'fee folded', detail: "the parser keeps this 0.1 NAM leg as the pool's fee (maspFeeNam) on its unshield 9.9 …zmefah->…ipient" });
    const other = row({ tx_hash: INNER, kind: 'unshield', amount_num: 9.9, from_addr: MASP, to_addr: 'tnam1qrecipient' });
    expect(compareRow(other, [flow({ kind: 'transfer', amount: 9.9, from: 'tnam1qsomeone', to: 'tnam1qrecipient' })]))
      .toEqual({ verdict: 'differs', detail: 'kind unshield -> transfer; from …zmefah -> …omeone' });
    expect(compareRow(other, [flow({ kind: 'unshield', amount: 9.9, txHash: 'A'.repeat(64) })])).toEqual({ verdict: 'differs', detail: 'wrapper DFE3007F -> AAAAAAAA' });
    // a transaction the parser reads as another coin's transfer, with no NAM leg
    expect(compareRow(other, [flow({ kind: 'unshield', amount: 5, meta: { tokenSymbol: 'OSMO' } })]).detail).toMatch(/^the parser reads this transaction as unshield 5 OSMO …zmefah->…ipient: no NAM leg left for this row$/);
  });
  it('two stored rows never stand on one leg', () => {
    const a = row({ tx_hash: INNER, kind: 'unshield', amount_num: 1, from_addr: MASP, to_addr: 'tnam1qx' });
    const b = row({ id: `namada:${INNER}:c1`, tx_hash: INNER, kind: 'unshield', amount_num: 1, from_addr: MASP, to_addr: 'tnam1qx' });
    const c = compareRows([a, b], [flow({ kind: 'unshield', amount: 1, to: 'tnam1qx' })]);
    expect(c.get(a.id)!.verdict).toBe('same');
    expect(c.get(b.id)!.verdict).toBe('differs');
  });
});

describe('the stamp', () => {
  const stored = row({ tx_hash: INNER, kind: 'shield', amount_num: 10.1 });
  const stamped = () => d1.raw.prepare('SELECT meta, amount_num FROM flows WHERE id = ?').get(stored.id);
  const d1 = testD1();
  insert(d1, 'flows', [{ id: stored.id, chain: 'namada', height: stored.height, ts: stored.ts, tx_hash: stored.tx_hash, kind: stored.kind, from_addr: stored.from_addr, to_addr: stored.to_addr, amount_num: stored.amount_num, meta: stored.meta }]);

  it('sets blockBy to the two nodes as a JSON array, keeps every other key, and is one statement for db:apply', () => {
    const sql = stampSql(stored, [FIVE, PAPA]);
    expect(sqlStatements(sql)).toHaveLength(1);
    expect(d1.raw.prepare(sqlStatements(sql)[0]).run().changes).toBe(1);
    expect(JSON.parse(stamped().meta)).toEqual({ source: SOURCE, descriptor: 'transfer-from-wasm', wrapper: WRAPPER, tsSource: 'block', blockBy: [FIVE, PAPA] });
    expect(stamped().amount_num).toBe(10.1);
  });
  it('is idempotent: a row already stamped is left alone', () => {
    expect(d1.raw.prepare(sqlStatements(stampSql(stored, [FIVE, PAPA]))[0]).run().changes).toBe(0);
    expect(d1.raw.prepare(sqlStatements(stampSql(stored, [PAPA, POLK]))[0]).run().changes).toBe(0);
    expect(JSON.parse(stamped().meta).blockBy).toEqual([FIVE, PAPA]);
  });
  it('a row changed since it was read is left alone', () => {
    const other = row({ id: `namada:${INNER}:c1`, tx_hash: INNER, kind: 'unshield', amount_num: 0.1, from_addr: MASP, to_addr: 'tnam1qgaspayer' });
    insert(d1, 'flows', [{ id: other.id, chain: 'namada', height: other.height, ts: other.ts, tx_hash: other.tx_hash, kind: other.kind, from_addr: other.from_addr, to_addr: other.to_addr, amount_num: 0.2, meta: other.meta }]);
    expect(d1.raw.prepare(stampSql(other, [FIVE, PAPA])).run().changes).toBe(0); // the amount is not as read
    d1.raw.prepare('UPDATE flows SET amount_num = 0.1, meta = json_set(meta, \'$.rederived\', \'2026-10-22\') WHERE id = ?').run(other.id);
    expect(d1.raw.prepare(stampSql(other, [FIVE, PAPA])).run().changes).toBe(0); // the meta is not as read
    d1.raw.prepare('UPDATE flows SET meta = ? WHERE id = ?').run(other.meta, other.id);
    expect(d1.raw.prepare(stampSql(other, [FIVE, PAPA])).run().changes).toBe(1);
  });
  it('needs two nodes', () => {
    expect(() => stampSql(stored, [FIVE])).toThrow(/2 must agree/);
  });
});
