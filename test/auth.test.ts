import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base64, bech32m, hex } from '@scure/base';
import { adr36SignDoc, namadaImplicitAddress, osmosisAddress, verifyKeplr, verifyNamada, loginMessage } from '../worker/src/auth';

describe('Namada login', () => {
  it('derives the implicit address the chain uses (real vector from indexer.namada.net)', () => {
    const pk = bech32m.fromWords(bech32m.decode('tpknam1qzq3h7phn3tyv0mk5q2ancu0c3d685lzwaq60lh8pd8r44pf0s0xgau0ngm', 100).words);
    expect(namadaImplicitAddress(pk)).toBe('tnam1qrk5pyvtzxjmykcqmhglssshdjf3njac2qvqmlse');
  });

  it('accepts a valid ed25519 signature over sha256(message) and rejects a wrong address', async () => {
    const sk = ed25519.utils.randomSecretKey();
    const pub = ed25519.getPublicKey(sk);
    const pkBorsh = new Uint8Array([0, ...pub]);
    const address = namadaImplicitAddress(pkBorsh);
    const message = loginMessage(address, 'abc');
    const sig = ed25519.sign(sha256(new TextEncoder().encode(message)), sk);
    // extension returns the borsh-tagged signature as hex
    expect(await verifyNamada(address, message, hex.encode(pkBorsh), '00' + hex.encode(sig))).toBeNull();
    expect(await verifyNamada(address, message + 'x', hex.encode(pkBorsh), hex.encode(sig))).toMatch(/does not verify/);
    expect(await verifyNamada('tnam1qrk5pyvtzxjmykcqmhglssshdjf3njac2qvqmlse', message, hex.encode(pkBorsh), hex.encode(sig))).toMatch(/does not belong/);
  });
});

describe('Keplr (ADR-36) login', () => {
  it('verifies a signature over the amino sign doc and binds the key to the osmo1 address', () => {
    const sk = secp256k1.utils.randomSecretKey();
    const pub = secp256k1.getPublicKey(sk, true);
    const address = osmosisAddress(pub);
    expect(address.startsWith('osmo1')).toBe(true);
    const message = loginMessage(address, 'nonce1');
    const digest = sha256(new TextEncoder().encode(adr36SignDoc(address, new TextEncoder().encode(message))));
    const sig = secp256k1.sign(digest, sk, { prehash: false });
    const sigB64 = base64.encode(sig);
    expect(verifyKeplr(address, message, base64.encode(pub), sigB64)).toBeNull();
    expect(verifyKeplr(address, message + '!', base64.encode(pub), sigB64)).toMatch(/does not verify/);
    const other = secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true);
    expect(verifyKeplr(address, message, base64.encode(other), sigB64)).toMatch(/does not belong/);
  });

  it('builds the ADR-36 doc with sorted keys and empty chain id', () => {
    const doc = adr36SignDoc('osmo1abc', new TextEncoder().encode('hi'));
    expect(doc).toBe('{"account_number":"0","chain_id":"","fee":{"amount":[],"gas":"0"},"memo":"","msgs":[{"type":"sign/MsgSignData","value":{"data":"aGk=","signer":"osmo1abc"}}],"sequence":"0"}');
  });
});
