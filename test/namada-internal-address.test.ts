// The live unbond decoder stopped on block 8,478,630 (2026-10-30 20:02 UTC) with "unsupported internal address
// variant 4": the block's one wrapper, a withdrawal, paid its fee in OSMO over IBC, and the header names the fee
// token as Internal::IbcToken, which the decoder (worker/src/parse/namada-tx.ts readAddress) did not read. Every
// internal address variant of Namada's enum is now read in its declaration order (crates/core/src/address.rs,
// raw.rs `Discriminant`). The fixtures are the block and its results as rpc-namada.5elementsnodes.com served them on
// 2026-10-30.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { base64 } from '@scure/base';
import { decodeNamadaTx, addressFromBorsh, INTERNAL_ADDRESSES } from '../worker/src/parse/namada-tx';
import { bech32m, hex } from '@scure/base';
import { parseNamadaUnbonds } from '../worker/src/parse/namada-unbond';
import { parseNamadaBonds } from '../worker/src/parse/namada-bond';
import type { NamadaBlock } from '../worker/src/parse/namada';

const fx = (n: string) => JSON.parse(readFileSync(join(__dirname, 'fixtures', n), 'utf8'));
const TXS: string[] = fx('namada_block_8478630_txs.json').result.block.data.txs;
const RESULTS = fx('namada_block_8478630.json').result;
const BLOCK: NamadaBlock = { height: 8478630, ts: Date.parse(fx('namada_block_8478630_txs.json').result.block.header.time), events: RESULTS.end_block_events };

describe('a fee paid in an IBC coin (block 8,478,630, 2026-10-30)', () => {
  it('the wrapper decodes: its hash is the tx/applied event’s, its one inner tx is the withdrawal the event applied', () => {
    expect(TXS).toHaveLength(1);
    const tx = decodeNamadaTx(base64.decode(TXS[0]));
    const applied = RESULTS.end_block_events.find((e: any) => e.type === 'tx/applied');
    const hash = applied.attributes.find((a: any) => a.key === 'hash').value;
    expect(tx.wrapperHash).toBe(hash);
    expect(tx.commitments.map((c) => c.innerHash)).toEqual(Object.keys(JSON.parse(applied.attributes.find((a: any) => a.key === 'batch').value)));
    expect(tx.commitments[0].innerHash.slice(0, 8)).toBe('60B4E5E9');
    expect([...tx.codes.values()].map((c) => c.tag)).toEqual(['tx_withdraw.wasm']);
    expect(tx.stoppedAt).toBe(null);
    expect(tx.feePayer).toMatch(/^tnam1q/);
  });

  it('the fee token is read as OSMO’s IBC token address, and every internal variant maps to Namada’s raw discriminant (review of 2026-10-30)', () => {
    const tx = base64.decode(TXS[0]);
    const h = hex.encode(tx);
    const at = h.indexOf('0204') / 2; // Address::Internal, InternalAddress::IbcToken, then its 20 bytes
    expect(at).toBeGreaterThan(0);
    expect(addressFromBorsh(tx.subarray(at, at + 22))).toBe('tnam1p5z8ruwyu7ha8urhq2l0dhpk2f5dv3ts7uyf2n75');
    // raw.rs Discriminant, by InternalAddress declaration order (address.rs): TempStorage 15, ReplayProtection 16
    expect(INTERNAL_ADDRESSES.map((v) => [v.name, v.raw])).toEqual([['PoS', 2], ['PosSlashPool', 3], ['Parameters', 4], ['Ibc', 6], ['IbcToken', 13], ['Governance', 5], ['EthBridge', 7], ['EthBridgePool', 8], ['Erc20', 11], ['Nut', 12], ['Multitoken', 9], ['Pgf', 10], ['Masp', 14], ['ReplayProtection', 16], ['TempStorage', 15]]);
    // a variant with no data is its raw discriminant and 20 zero bytes: the shielded pool's address
    expect(addressFromBorsh(Uint8Array.of(2, 12))).toBe('tnam1pcqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzmefah');
    expect(() => addressFromBorsh(Uint8Array.of(2, 15))).toThrow('unsupported internal address variant 15');
    expect(bech32m.decode('tnam1p5z8ruwyu7ha8urhq2l0dhpk2f5dv3ts7uyf2n75', 100).prefix).toBe('tnam');
  });

  it('the live decoders read the block: no request is left undecoded, and a withdrawal is neither an unbond nor a bond', () => {
    const u = parseNamadaUnbonds(BLOCK, TXS, null);
    expect(u.undecoded).toEqual([]);
    expect(u.flows).toEqual([]);
    const b = parseNamadaBonds(BLOCK, TXS, null);
    expect(b.undecoded).toEqual([]);
    expect(b.flows).toEqual([]);
  });
});
