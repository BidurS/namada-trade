import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeNamadaTx, decodeUnbond, txBytesFromBase64, unwrapTxBytes } from '../worker/src/parse/namada-tx';
import { appliedUnbonds, blockHasUnbond, parseNamadaUnbonds } from '../worker/src/parse/namada-unbond';
import type { NamadaBlock } from '../worker/src/parse/namada';
import { NAMADA } from '../worker/src/config';

const fx = (n: string) => JSON.parse(readFileSync(join(__dirname, 'fixtures', n), 'utf8'));

/** block_results + /block for mainnet height 6957587: one wrapper with two applied unbonds in its batch. */
const H = 6957587;
const WRAPPER = '0F8F36AAE1B3428B0EF85E71E7535B92017FC464695C0698F186706CD49DFC55';
const INNER_A = 'D08EBA2CB404E2D6DFD3EF31B0076022F9CA1F0B5B7B888C33F9C5AD20568DB0'; // 50 NAM
const INNER_B = '5B172361C945A404F0F14F2BDF22765B6073A5E080DB2476569A2FF4E6623C3B'; // 100 NAM
const DELEGATOR = 'tnam1qp2wt2gjjcqwey2esvae46g6nr9ullzc8v9ydaq8';
const VAL_A = 'tnam1q8jrrf8s22cwd22yxhwc38tlvahplh2wyqjzl9gx';
const VAL_B = 'tnam1qy7fms2m4kpx5khvp4x7r3pr8e4xdqghpsrsd0pn';

function block(h: number, file = `namada_block_${h}.json`): NamadaBlock {
  const r = fx(file).result;
  const blk = fx(`${file.replace('.json', '')}_txs.json`).result.block;
  return {
    height: h,
    ts: Date.parse(blk.header.time),
    events: [...(r.begin_block_events ?? []), ...(r.end_block_events ?? []), ...(r.finalize_block_events ?? []), ...((r.txs_results ?? []) as any[]).flatMap((t) => t.events ?? [])],
  };
}
const txsOf = (h: number) => fx(`namada_block_${h}_txs.json`).result.block.data.txs as string[];

describe('namada tx decoder', () => {
  it('derives the wrapper and inner hashes the chain reports', () => {
    const [raw] = txsOf(H);
    const tx = decodeNamadaTx(txBytesFromBase64(raw));
    expect(tx.wrapperHash).toBe(WRAPPER);
    expect(tx.commitments.map((c) => c.innerHash).sort()).toEqual([INNER_A, INNER_B].sort());
    // every commitment points at a decoded Data section and a Code section tagged as the unbond wasm
    for (const c of tx.commitments) {
      expect(tx.data.has(c.dataHash)).toBe(true);
      expect(tx.codes.get(c.codeHash)?.tag).toBe('tx_unbond.wasm');
    }
    expect(tx.stoppedAt).toBeNull();
  });

  it('decodes Unbond { validator, amount, source } with bech32m addresses', () => {
    const [raw] = txsOf(H);
    const tx = decodeNamadaTx(txBytesFromBase64(raw));
    const a = tx.commitments.find((c) => c.innerHash === INNER_A)!;
    const u = decodeUnbond(tx.data.get(a.dataHash)!);
    expect(u).toEqual({ validator: VAL_A, amount: 50_000_000n, source: DELEGATOR });
    const b = tx.commitments.find((c) => c.innerHash === INNER_B)!;
    expect(decodeUnbond(tx.data.get(b.dataHash)!)).toEqual({ validator: VAL_B, amount: 100_000_000n, source: DELEGATOR });
  });

  it('strips the protobuf envelope and rejects malformed data', () => {
    const raw = txBytesFromBase64(txsOf(H)[0]);
    expect(raw[0]).toBe(0x0a);
    expect(unwrapTxBytes(raw).length).toBe(raw.length - 3);
    expect(() => decodeUnbond(new Uint8Array([0, 1, 2]))).toThrow();
    expect(() => decodeUnbond(new Uint8Array(80))).toThrow(/trailing|unsupported/);
  });
});

describe('live unbond flows', () => {
  it('prefilters on the tx/applied changed keys', () => {
    expect(blockHasUnbond(block(H))).toBe(true);
    const applied = appliedUnbonds(block(H));
    expect(applied.map((a) => a.innerHash).sort()).toEqual([INNER_A, INNER_B].sort());
    expect(applied[0].wrapperHash).toBe(WRAPPER);
    expect(applied.find((a) => a.innerHash === INNER_A)!.unbondKeys).toEqual([{ source: DELEGATOR, validator: VAL_A }]);
  });

  it('ignores a PoS withdraw, which deletes unbond keys but is tagged tx_withdraw.wasm', () => {
    const b = block(8251377);
    expect(blockHasUnbond(b)).toBe(true); // prefilter fires (changed keys mention unbond) ...
    const p = parseNamadaUnbonds(b, txsOf(8251377), null);
    expect(p.flows).toEqual([]); // ... but no flow and no decode error: the code tag decides
    expect(p.undecoded).toEqual([]);
    expect(p.skipped).toEqual({ 'tx_withdraw.wasm': 2 });
  });

  it('decodes a current-protocol unbond (block 8300328, 2026-10-16) exactly as the indexer reports it', () => {
    const b = block(8300328);
    expect(b.ts).toBe(Date.parse('2026-10-16T16:18:51.977977563Z'));
    const p = parseNamadaUnbonds(b, txsOf(8300328), null);
    expect(p.undecoded).toEqual([]);
    expect(p.skipped).toEqual({});
    expect(p.flows).toHaveLength(1);
    // indexer.namada.net /chain/history for the delegator: kind unbond, amount 500000000, same inner/wrapper ids
    expect(p.flows[0]).toMatchObject({
      id: 'namada:E01A82EDBD9A069A075F37D6D4699D6BEC97C43AF8F332754EB0D7675AF7D771:pos',
      txHash: 'E01A82EDBD9A069A075F37D6D4699D6BEC97C43AF8F332754EB0D7675AF7D771',
      height: 8300328,
      ts: b.ts,
      kind: 'unbond',
      from: NAMADA.internal.pos,
      to: 'tnam1qzt66rwk0uvqz3egqqeslsaw0rh9zpwccs8an36t',
      amount: 500,
      priceUsd: null,
      valueUsd: null,
      meta: {
        validator: 'tnam1q8sjkutd5kqwcc555wr77p9fjn66nuuqfuzzc3yc',
        wrapper: 'C2D8DCE7A5392B758ABCCE02E25FA401224F4A0D738E78A3959CE220437D94B8',
        tsSource: 'block',
        source: 'namada-rpc',
        // tx_unbond.wasm checksum from indexer.namada.net /chain/parameters (checksums.current)
        code: '36E774350B865752C9D309D518223ABF0A60374BAE15A1F73DFE4721B5887048',
      },
    });
  });

  it('emits one unbond flow per applied inner tx with the exact block time and backfill id scheme', () => {
    const b = block(H);
    expect(b.ts).toBe(Date.parse('2026-06-17T16:24:26.115441785Z'));
    const p = parseNamadaUnbonds(b, txsOf(H), 0.0005);
    expect(p.undecoded).toEqual([]);
    expect(p.flows).toHaveLength(2);
    const a = p.flows.find((f) => f.txHash === INNER_A)!;
    expect(a).toMatchObject({
      id: `namada:${INNER_A}:pos`,
      chain: 'namada',
      height: H,
      ts: b.ts,
      kind: 'unbond',
      from: NAMADA.internal.pos,
      to: DELEGATOR,
      amount: 50,
      priceUsd: 0.0005,
      valueUsd: 0.025,
      meta: { source: 'namada-rpc', txKind: 'unbond', validator: VAL_A, wrapper: WRAPPER, tsSource: 'block', code: '36E774350B865752C9D309D518223ABF0A60374BAE15A1F73DFE4721B5887048', priceSource: 'spot' },
    });
    expect(a.meta).not.toHaveProperty('selfUnbond');
    const bFlow = p.flows.find((f) => f.txHash === INNER_B)!;
    expect(bFlow.amount).toBe(100);
    expect(bFlow.meta).toMatchObject({ validator: VAL_B });
    // no price known -> no value invented
    const np = parseNamadaUnbonds(b, txsOf(H), null);
    expect(np.flows[0].priceUsd).toBeNull();
    expect(np.flows[0].valueUsd).toBeNull();
    expect(np.flows[0].meta).not.toHaveProperty('priceSource');
  });

  it('skips inner txs that were not applied (Err) and reports undecodable ones instead of guessing', () => {
    const b = block(H);
    // flip inner A to Err in the batch attribute
    const ev = b.events.find((e) => e.type === 'tx/applied')!;
    const batchAttr = ev.attributes.find((x) => x.key === 'batch')!;
    const batch = JSON.parse(batchAttr.value);
    batch[INNER_A] = { Err: 'rejected' };
    batchAttr.value = JSON.stringify(batch);
    const p = parseNamadaUnbonds(b, txsOf(H), null);
    expect(p.flows.map((f) => f.txHash)).toEqual([INNER_B]);
    expect(p.undecoded).toEqual([]);

    // tx bytes missing -> nothing emitted, both reported
    const q = parseNamadaUnbonds(block(H), [], null);
    expect(q.flows).toEqual([]);
    expect(q.undecoded.map((u) => u.innerHash).sort()).toEqual([INNER_A, INNER_B].sort());
    expect(q.undecoded[0].reason).toMatch(/not found/);
  });
});
