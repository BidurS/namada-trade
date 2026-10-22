// "Buy me a coffee" addresses (shared/site.ts): each must be a valid mainnet address of its chain, and shielded, so a
// typo in an edit can never send someone's gift to an address nobody owns, or to a public (transparent) one.
import { describe, it, expect } from 'vitest';
import { bech32m } from '@scure/base';
import { blake2b } from '@noble/hashes/blake2.js';
import { SITE } from '../shared/site';

/** ZIP 316 unified address: bech32m, then F4Jumble undone, then the padding and the receivers (type, length, bytes). */
function zcashReceivers(address: string): { hrp: string; padding: boolean; receivers: number[] } {
  const dec = bech32m.decode(address as `${string}1${string}`, 2000);
  const jumbled = Uint8Array.from(bech32m.fromWords(dec.words));
  const enc = new TextEncoder();
  const pers = (tag: string, i: number, j = 0) => { const p = new Uint8Array(16); p.set(enc.encode(tag)); p[13] = i; p[14] = j & 0xff; p[15] = j >> 8; return p; };
  const xor = (a: Uint8Array, b: Uint8Array) => a.map((v, k) => v ^ b[k]);
  const H = (i: number, u: Uint8Array, len: number) => blake2b(u, { dkLen: len, personalization: pers('UA_F4Jumble_H', i) });
  const G = (i: number, u: Uint8Array, len: number) => {
    const out = new Uint8Array(len);
    for (let j = 0, o = 0; o < len; j++, o += 64) out.set(blake2b(u, { dkLen: 64, personalization: pers('UA_F4Jumble_G', i, j) }).subarray(0, Math.min(64, len - o)), o);
    return out;
  };
  const lL = Math.min(64, Math.floor(jumbled.length / 2)), lR = jumbled.length - lL;
  const c = jumbled.subarray(0, lL), d = jumbled.subarray(lL);
  const y = xor(c, H(1, d, lL)); const x = xor(d, G(1, y, lR)); const a = xor(y, H(0, x, lL)); const b = xor(x, G(0, a, lR));
  const raw = new Uint8Array([...a, ...b]);
  const pad = new Uint8Array(16); pad.set(enc.encode(dec.prefix));
  const padding = raw.subarray(raw.length - 16).every((v, k) => v === pad[k]);
  const body = raw.subarray(0, raw.length - 16);
  const receivers: number[] = [];
  for (let o = 0; o < body.length;) {
    const t = body[o++]; const l = body[o++]; // every receiver type and length here is under 0xfd (one byte)
    receivers.push(t); o += l;
    if (o > body.length) throw new Error('receiver runs past the end');
  }
  return { hrp: dec.prefix, padding, receivers };
}

describe('donation addresses', () => {
  it('the NAM address is a shielded Namada payment address (bech32m, znam)', () => {
    const dec = bech32m.decode(SITE.donateShielded as `${string}1${string}`, 200);
    expect(dec.prefix).toBe('znam');
  });
  it('the Zcash address is a mainnet unified address with shielded receivers only (Sapling 2, Orchard 3)', () => {
    const ua = zcashReceivers(SITE.donateZcash);
    expect(ua.hrp).toBe('u');
    expect(ua.padding).toBe(true);
    expect(ua.receivers.length).toBeGreaterThan(0);
    for (const t of ua.receivers) expect([2, 3]).toContain(t);
  });
  it('one changed character is caught', () => {
    const bad = SITE.donateZcash.slice(0, 40) + (SITE.donateZcash[40] === 'q' ? 'p' : 'q') + SITE.donateZcash.slice(41);
    expect(() => zcashReceivers(bad)).toThrow();
  });
});
