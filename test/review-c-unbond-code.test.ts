// Review run 2, group C (parse.namada-unbond/code-tag-discriminator): a live unbond is recognised by the code the inner
// transaction ran (the tx_unbond.wasm checksum), not by the tag the signer wrote on its Code section. The real tx of
// block 6,957,587 (two unbonds, 50 and 100 NAM) is re-encoded with a different tag, its section hash and the header
// commitments recomputed the way the chain hashes them (parse/namada-tx.ts), so the chain's own hashes still bind.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '@noble/hashes/sha2.js';
import { base64, hex } from '@scure/base';
import { decodeNamadaTx, decodeUnbond, txBytesFromBase64, unwrapTxBytes } from '../worker/src/parse/namada-tx';
import { parseNamadaUnbonds, UNBOND_CODE_HASHES } from '../worker/src/parse/namada-unbond';
import type { NamadaBlock } from '../worker/src/parse/namada';
import { NAMADA } from '../worker/src/config';

const fx = (n: string) => JSON.parse(readFileSync(join(__dirname, 'fixtures', n), 'utf8'));
const H = 6957587;
const DELEGATOR = 'tnam1qp2wt2gjjcqwey2esvae46g6nr9ullzc8v9ydaq8';
const VAL_A = 'tnam1q8jrrf8s22cwd22yxhwc38tlvahplh2wyqjzl9gx';
const VAL_B = 'tnam1qy7fms2m4kpx5khvp4x7r3pr8e4xdqghpsrsd0pn';
const UNBOND_CODE = '36E774350B865752C9D309D518223ABF0A60374BAE15A1F73DFE4721B5887048';
const raw = () => unwrapTxBytes(txBytesFromBase64(fx(`namada_block_${H}_txs.json`).result.block.data.txs[0]));

const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((s, x) => s + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
const find = (b: Uint8Array, n: Uint8Array) => { for (let i = 0; i + n.length <= b.length; i++) if (n.every((v, k) => b[i + k] === v)) return i; return -1; };
const tagBytes = (tag: string | null) => {
  if (tag === null) return new Uint8Array([0]);
  const t = new TextEncoder().encode(tag);
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, t.length, true);
  return cat(new Uint8Array([1]), len, t);
};

/**
 * The fixture tx with its Code section's tag (and optionally its wasm hash) replaced. The Code section is
 * `02 ‖ salt(8) ‖ 00 ‖ H(32) ‖ tag`; its hash, sha256(02 ‖ salt ‖ H ‖ tag), is what both commitments reference.
 */
function recode(tag: string | null, code: Uint8Array = hex.decode(UNBOND_CODE.toLowerCase())): string {
  const tx = raw();
  const old = tagBytes('tx_unbond.wasm');
  const at = find(tx, cat(hex.decode(UNBOND_CODE.toLowerCase()), old));
  expect(at).toBeGreaterThan(10);
  expect(tx[at - 1]).toBe(0); // Commitment::Hash
  expect(tx[at - 10]).toBe(2); // Section::Code
  const salt = tx.slice(at - 9, at - 1);
  const oldHash = sha256(cat(new Uint8Array([2]), salt, hex.decode(UNBOND_CODE.toLowerCase()), old));
  const newTag = tagBytes(tag);
  const newHash = sha256(cat(new Uint8Array([2]), salt, code, newTag));
  let out = cat(tx.slice(0, at), code, newTag, tx.slice(at + 32 + old.length));
  // every reference to the old section hash (the header commitments, the signatures' targets) now names the new one
  if (hex.encode(oldHash) !== hex.encode(newHash)) for (let i = find(out, oldHash); i >= 0; i = find(out, oldHash)) out.set(newHash, i);
  return base64.encode(out);
}

/** block_results for the re-encoded tx: its wrapper hash, both inner txs applied with their unbond keys. */
function blockFor(b64: string): NamadaBlock {
  const tx = decodeNamadaTx(txBytesFromBase64(b64));
  const key = (validator: string) => ({ segments: [{ AddressSeg: NAMADA.internal.pos }, { StringSeg: 'unbond' }, { AddressSeg: DELEGATOR }, { AddressSeg: validator }] });
  const batch: Record<string, unknown> = {};
  for (const c of tx.commitments) {
    const u = decodeUnbond(tx.data.get(c.dataHash)!);
    batch[c.innerHash] = { Ok: { changed_keys: [key(u.validator)] } };
  }
  return { height: H, ts: Date.parse('2026-06-17T16:24:26.115441785Z'), events: [{ type: 'tx/applied', attributes: [{ key: 'hash', value: tx.wrapperHash }, { key: 'batch', value: JSON.stringify(batch) }] }] };
}
const run = (b64: string) => parseNamadaUnbonds(blockFor(b64), [b64], null);
const amounts = (p: ReturnType<typeof run>) => p.flows.map((f) => [f.meta?.validator, f.amount]).sort();

describe('a live unbond is decided by the code it ran', () => {
  it('harness control: re-encoding with the tag it already has gives the two unbonds', () => {
    const b64 = recode('tx_unbond.wasm');
    expect(b64).toBe(base64.encode(raw()));
    const p = run(b64);
    expect(amounts(p)).toEqual([[VAL_A, 50], [VAL_B, 100]]);
  });

  it('an unbond with no tag on its Code section is still recorded, 50 and 100 NAM', () => {
    const p = run(recode(null));
    expect(p.skipped).toEqual({});
    expect(p.undecoded).toEqual([]);
    expect(amounts(p)).toEqual([[VAL_A, 50], [VAL_B, 100]]);
    expect(p.flows.every((f) => f.kind === 'unbond' && f.to === DELEGATOR && f.meta?.code === UNBOND_CODE)).toBe(true);
  });

  it('an unbond whose signer wrote another tag is still recorded: the checksum decides', () => {
    const p = run(recode('tx_withdraw.wasm'));
    expect(p.skipped).toEqual({});
    expect(amounts(p)).toEqual([[VAL_A, 50], [VAL_B, 100]]);
  });

  it('untagged code that is not a known unbond checksum is reported, never decoded on a guess or dropped unseen', () => {
    const p = run(recode(null, sha256(new TextEncoder().encode('not tx_unbond.wasm'))));
    expect(p.flows).toEqual([]);
    expect(p.skipped).toEqual({});
    expect(p.undecoded).toHaveLength(2);
    expect(p.undecoded[0].reason).toMatch(/untagged code .* is not a known tx_unbond\.wasm checksum/);
  });

  it('the known checksum is the one the chain ran for the recorded unbonds', () => {
    expect([...UNBOND_CODE_HASHES]).toEqual([UNBOND_CODE]);
  });
});
