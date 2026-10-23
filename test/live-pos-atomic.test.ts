// Atomic batches and the live PoS decoders: the inner txs of a wrapper whose header sets the atomic flag are committed
// together or not at all, so when one fails the chain drops the writes of every other, though their own results in the
// tx/applied event still read Ok with no rejecting validity predicate. A bond or an unbond in such a batch is not a
// row; it is reported in `undecoded` as "atomic batch not committed". The fixtures are real wrappers of two inner txs
// (block 7,852,270: a rewards claim and a bond; block 6,957,587: two unbonds), whose atomic byte is set to 1 here. That
// changes the wrapper hash and every inner hash, so the tx/applied event is rewritten with the new hashes (the
// decoder does not check signatures, so their targets are left as they are).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { base64 } from '@scure/base';
import { decodeNamadaTx, txBytesFromBase64, unwrapTxBytes } from '../worker/src/parse/namada-tx';
import { parseNamadaBonds } from '../worker/src/parse/namada-bond';
import { parseNamadaUnbonds } from '../worker/src/parse/namada-unbond';
import type { NamadaBlock } from '../worker/src/parse/namada';

const fx = (n: string) => JSON.parse(readFileSync(join(__dirname, 'fixtures', n), 'utf8'));
const eventsOf = (r: any) => [...(r.begin_block_events ?? []), ...(r.end_block_events ?? []), ...(r.finalize_block_events ?? []), ...((r.txs_results ?? []) as any[]).flatMap((t) => t.events ?? [])];
function block(h: number): NamadaBlock {
  const r = fx(`namada_block_${h}.json`).result;
  return { height: h, ts: Date.parse(fx(`namada_block_${h}_txs.json`).result.block.header.time), events: eventsOf(r) };
}
const txsOf = (h: number) => fx(`namada_block_${h}_txs.json`).result.block.data.txs as string[];

/** Where the header's atomic byte is: after chain_id, expiration, timestamp and the batch's commitments. */
function atomicAt(tx: Uint8Array): number {
  const dv = new DataView(tx.buffer, tx.byteOffset, tx.byteLength);
  let o = 0;
  const str = () => { o += 4 + dv.getUint32(o, true); };
  str(); // chain_id
  if (tx[o++] === 1) str(); // expiration: Option<DateTimeUtc>
  str(); // timestamp
  const n = dv.getUint32(o, true);
  return o + 4 + 96 * n;
}

type Batch = Record<string, any>;
/**
 * One wrapper of block `h` alone, as the chain gave it or with its atomic byte set, and its tx/applied event with the
 * hashes of the copy; `edit` changes the batch results, given the copy's inner hashes in commitment order.
 */
function wrapperOf(h: number, wrapper: string, atomic: boolean, edit?: (batch: Batch, inners: string[]) => void, code?: string) {
  const b64 = txsOf(h).find((t) => decodeNamadaTx(txBytesFromBase64(t)).wrapperHash === wrapper)!;
  const before = decodeNamadaTx(txBytesFromBase64(b64));
  expect(before.atomic).toBe(false);
  const tx = unwrapTxBytes(txBytesFromBase64(b64)).slice();
  const at = atomicAt(tx);
  expect(tx[at]).toBe(0);
  if (atomic) tx[at] = 1;
  const copy = base64.encode(tx);
  const after = decodeNamadaTx(txBytesFromBase64(copy));
  expect(after.atomic).toBe(atomic);
  expect(after.commitments).toHaveLength(before.commitments.length);
  const ev = block(h).events.find((e) => e.type === 'tx/applied' && e.attributes.some((a) => a.key === 'hash' && a.value.toUpperCase() === wrapper))!;
  const orig = JSON.parse(ev.attributes.find((a) => a.key === 'batch')!.value) as Batch;
  const batch: Batch = {};
  before.commitments.forEach((c, i) => {
    const k = Object.keys(orig).find((x) => x.toUpperCase() === c.innerHash)!;
    batch[after.commitments[i].innerHash] = orig[k];
  });
  const inners = after.commitments.map((c) => c.innerHash);
  edit?.(batch, inners);
  const attributes = ev.attributes.map((a) =>
    a.key === 'hash' ? { ...a, value: after.wrapperHash } : a.key === 'batch' ? { ...a, value: JSON.stringify(batch) } : a.key === 'code' && code != null ? { ...a, value: code } : a);
  const blk: NamadaBlock = { height: h, ts: block(h).ts, events: [{ type: 'tx/applied', attributes }] };
  return { blk, txs: [copy], inners, wrapper: after.wrapperHash };
}
const err = (batch: Batch, inner: string) => { batch[inner] = { Err: 'Gas error: Transaction gas exceeded the limit' }; };
const vpRejects = (batch: Batch, inner: string) => { batch[inner].Ok.vps_result.rejected_vps = ['tnam1qzt66rwk0uvqz3egqqeslsaw0rh9zpwccs8an36t']; };

// Block 7,852,270, wrapper 753D955F…: a rewards claim, then a bond of 129.238232 NAM; both applied (event code 0).
const BH = 7852270;
const BW = '753D955F90A48EC6F951A5F61E50F015E25A94B54982DE238945DB3B9B9D952F';
// Block 6,957,587, wrapper 0F8F36AA…: two unbonds in one batch, both applied.
const UH = 6957587;
const UW = '0F8F36AAE1B3428B0EF85E71E7535B92017FC464695C0698F186706CD49DFC55';

describe('a bond in an atomic batch', () => {
  it('controls: the wrapper as the chain gave it, and the same wrapper atomic with every result applied, give the bond', () => {
    for (const atomic of [false, true]) {
      const w = wrapperOf(BH, BW, atomic);
      const p = parseNamadaBonds(w.blk, w.txs, null);
      expect(p.flows.map((f) => [f.txHash, f.amount])).toEqual([[w.inners[1], 129.238232]]);
      expect(p.undecoded).toEqual([]);
    }
  });

  it('not atomic, its rewards claim failed: the bond is applied, as the chain applies the Ok results of such a batch', () => {
    const w = wrapperOf(BH, BW, false, (b, [claim]) => err(b, claim), '1');
    expect(parseNamadaBonds(w.blk, w.txs, null).flows.map((f) => f.amount)).toEqual([129.238232]);
  });

  it('atomic, its rewards claim failed: no bond row, reported as an atomic batch not committed', () => {
    const w = wrapperOf(BH, BW, true, (b, [claim]) => err(b, claim), '1');
    const p = parseNamadaBonds(w.blk, w.txs, null);
    expect(p.flows).toEqual([]);
    expect(p.undecoded).toEqual([{ wrapperHash: w.wrapper, innerHash: w.inners[1], reason: 'atomic batch not committed' }]);
  });

  it('atomic, the claim failed while the event\'s code still reads 0: no bond row', () => {
    const w = wrapperOf(BH, BW, true, (b, [claim]) => err(b, claim), '0');
    const p = parseNamadaBonds(w.blk, w.txs, null);
    expect(p.flows).toEqual([]);
    expect(p.undecoded.map((u) => u.reason)).toEqual(['atomic batch not committed']);
  });

  it('atomic, a validity predicate rejected the claim, or the claim has no result in the event: no bond row', () => {
    for (const edit of [(b: Batch, [claim]: string[]) => vpRejects(b, claim), (b: Batch, [claim]: string[]) => { delete b[claim]; }]) {
      const w = wrapperOf(BH, BW, true, edit);
      const p = parseNamadaBonds(w.blk, w.txs, null);
      expect(p.flows).toEqual([]);
      expect(p.undecoded.map((u) => u.reason)).toEqual(['atomic batch not committed']);
    }
  });

  it('atomic, every result Ok but the event\'s code is not 0: no bond row', () => {
    const w = wrapperOf(BH, BW, true, undefined, '1');
    expect(parseNamadaBonds(w.blk, w.txs, null).undecoded.map((u) => u.reason)).toEqual(['atomic batch not committed']);
  });
});

describe('an unbond in an atomic batch', () => {
  it('controls: two unbonds, as the chain gave them and atomic with both applied, give two rows', () => {
    for (const atomic of [false, true]) {
      const w = wrapperOf(UH, UW, atomic);
      const p = parseNamadaUnbonds(w.blk, w.txs, null);
      expect(p.flows.map((f) => f.txHash)).toEqual(w.inners);
      expect(p.undecoded).toEqual([]);
    }
  });

  it('not atomic, the second unbond failed: the first is applied', () => {
    const w = wrapperOf(UH, UW, false, (b, [, second]) => err(b, second), '1');
    expect(parseNamadaUnbonds(w.blk, w.txs, null).flows.map((f) => f.txHash)).toEqual([w.inners[0]]);
  });

  it('atomic, the second unbond failed or a validity predicate rejected it: no row of the first, reported', () => {
    for (const edit of [(b: Batch, [, second]: string[]) => err(b, second), (b: Batch, [, second]: string[]) => vpRejects(b, second)]) {
      const w = wrapperOf(UH, UW, true, edit);
      const p = parseNamadaUnbonds(w.blk, w.txs, null);
      expect(p.flows).toEqual([]);
      expect(p.undecoded).toEqual([{ wrapperHash: w.wrapper, innerHash: w.inners[0], reason: 'atomic batch not committed' }]);
    }
  });
});

describe('the atomic flag in the header', () => {
  it('is read as a borsh bool: a byte other than 0 or 1 is not a tx this decoder reads', () => {
    const tx = unwrapTxBytes(txBytesFromBase64(txsOf(UH)[0])).slice();
    tx[atomicAt(tx)] = 2;
    expect(() => decodeNamadaTx(tx)).toThrow(/bad atomic flag 2/);
  });
});
