/**
 * Minimal borsh decoder for Namada wrapper transactions, enough to pull PoS `Unbond` data out of a block.
 *
 * Verified against mainnet block 6957587 (wrapper 0F8F36AA…, two unbonds in one batch):
 *   - CometBFT tx bytes are a protobuf envelope `0a <varint len> <borsh Tx>`.
 *   - Tx = Header { chain_id, expiration: Option<DateTimeUtc>, timestamp, batch: Vec<TxCommitments>, atomic, tx_type }
 *          + Vec<Section>. TxCommitments = code_hash ‖ data_hash ‖ memo_hash (3 × 32 bytes).
 *   - wrapper hash = sha256(0x06 ‖ header bytes)           (Section::Header(header).get_hash())
 *   - inner hash   = sha256(wrapper hash ‖ sha256(commitment bytes))   (compute_inner_tx_hash)
 *   - Data section hash = sha256(section bytes as serialised in the tx).
 *   - Code/ExtraData section hash = sha256(variant ‖ salt ‖ H ‖ tag) where H is the 32-byte wasm/memo hash
 *     (Commitment::Hash as-is, Commitment::Id(bytes) collapsed to sha256(bytes)); the Commitment tag byte is
 *     not hashed. Commitments reference these hashes.
 *   - Address (borsh) = enum tag + 20-byte hash: 0 Established, 1 Implicit, 2 Internal. The bech32m `tnam`
 *     raw form uses a different discriminant byte: 0 Implicit, 1 Established, 2 PoS, … (see rawDiscriminant).
 *   - Unbond = { validator: Address, amount: Uint (4 × u64 LE), source: Option<Address> }
 *
 * Anything this decoder does not understand is reported as undecodable, never guessed.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bech32m, base64, hex } from '@scure/base';

export interface TxCommitment {
  innerHash: string; // upper-case hex, equals the keys of the tx/applied `batch` attribute
  codeHash: string;
  dataHash: string;
  memoHash: string;
}

export interface DecodedTx {
  wrapperHash: string; // upper-case hex, equals the `hash` attribute of the tx/applied event
  commitments: TxCommitment[];
  /** section hash -> { tag, codeHash } for Code sections (tag is e.g. "tx_unbond.wasm", codeHash the wasm checksum) */
  codes: Map<string, { tag: string | null; codeHash: string }>;
  /** section hash -> raw data bytes for Data sections */
  data: Map<string, Uint8Array>;
  /** Section variants the decoder stopped at (sections after it are not read) */
  stoppedAt: string | null;
}

export interface UnbondData {
  validator: string;
  /** base units (1e-6 NAM) */
  amount: bigint;
  /** null = self-unbond (the validator unbonds its own stake) */
  source: string | null;
}

class Reader {
  o = 0;
  constructor(readonly b: Uint8Array) {}
  get left() { return this.b.length - this.o; }
  u8(): number { if (this.left < 1) throw new Error('eof'); return this.b[this.o++]; }
  u32(): number { if (this.left < 4) throw new Error('eof'); const v = new DataView(this.b.buffer, this.b.byteOffset + this.o, 4).getUint32(0, true); this.o += 4; return v; }
  u64(): bigint { if (this.left < 8) throw new Error('eof'); const v = new DataView(this.b.buffer, this.b.byteOffset + this.o, 8).getBigUint64(0, true); this.o += 8; return v; }
  bytes(n: number): Uint8Array { if (this.left < n) throw new Error('eof'); const v = this.b.subarray(this.o, this.o + n); this.o += n; return v; }
  vec(): Uint8Array { return this.bytes(this.u32()); }
  string(): string { return new TextDecoder().decode(this.vec()); }
  option<T>(f: () => T): T | null { const t = this.u8(); if (t === 0) return null; if (t !== 1) throw new Error(`bad option tag ${t}`); return f(); }
}

const H = (b: Uint8Array) => hex.encode(sha256(b)).toUpperCase();

/** borsh Address enum tag -> bech32m raw discriminant (namada_core::address::raw::Discriminant) */
function rawDiscriminant(tag: number, internalVariant: number | null): number {
  if (tag === 0) return 1; // Established
  if (tag === 1) return 0; // Implicit
  if (tag === 2 && internalVariant === 0) return 2; // Internal::PoS
  throw new Error(`unsupported address variant ${tag}/${internalVariant}`);
}

/** Decode a borsh `Address`. Only Established, Implicit and Internal::PoS are supported (the only ones that can appear in PoS txs). */
export function readAddress(r: Reader): string {
  const tag = r.u8();
  let variant: number | null = null;
  let hash: Uint8Array;
  if (tag === 2) {
    variant = r.u8();
    if (variant !== 0) throw new Error(`unsupported internal address variant ${variant}`);
    hash = new Uint8Array(20);
  } else {
    hash = r.bytes(20);
  }
  const raw = new Uint8Array(21);
  raw[0] = rawDiscriminant(tag, variant);
  raw.set(hash, 1);
  return bech32m.encode('tnam', bech32m.toWords(raw), 100);
}

/** Strip the CometBFT protobuf envelope (`0a <varint len> <bytes>`), if present. */
export function unwrapTxBytes(raw: Uint8Array): Uint8Array {
  if (raw[0] !== 0x0a) return raw;
  let i = 1, n = 0, s = 0;
  for (;;) {
    const c = raw[i++];
    n |= (c & 0x7f) << s;
    s += 7;
    if (c < 0x80) break;
    if (s > 35) throw new Error('bad varint');
  }
  if (i + n !== raw.length) throw new Error(`protobuf length ${n} does not match ${raw.length - i}`);
  return raw.subarray(i, i + n);
}

/** Read a Code { salt, code: Commitment, tag } body and return its section hash as referenced by TxCommitments. */
function readCode(r: Reader, variant: number): { tag: string | null; codeHash: string; sectionHash: string } {
  const salt = r.bytes(8);
  const ct = r.u8(); // Commitment: 0 Hash, 1 Id(Vec<u8>)
  let h: Uint8Array;
  if (ct === 0) h = r.bytes(32);
  else if (ct === 1) h = sha256(r.vec());
  else throw new Error(`bad commitment tag ${ct}`);
  const tagStart = r.o;
  const tag = r.option(() => r.string());
  const tagBytes = r.b.subarray(tagStart, r.o);
  const pre = new Uint8Array(1 + 8 + 32 + tagBytes.length);
  pre[0] = variant;
  pre.set(salt, 1);
  pre.set(h, 9);
  pre.set(tagBytes, 41);
  return { tag, codeHash: hex.encode(h).toUpperCase(), sectionHash: H(pre) };
}

export function decodeNamadaTx(rawTx: Uint8Array): DecodedTx {
  const tx = unwrapTxBytes(rawTx);
  const r = new Reader(tx);
  // ---- Header
  r.string(); // chain_id
  r.option(() => r.string()); // expiration
  r.string(); // timestamp
  const n = r.u32();
  const commitmentBytes: Uint8Array[] = [];
  for (let i = 0; i < n; i++) commitmentBytes.push(r.bytes(96));
  r.u8(); // atomic
  const txType = r.u8(); // 0 Raw, 1 Wrapper, 2 Protocol
  if (txType === 1) {
    r.bytes(32); // fee.amount_per_gas_unit.amount (Uint)
    r.u8(); // fee.amount_per_gas_unit.denom
    readAddress(r); // fee.token
    const pk = r.u8(); // 0 Ed25519(32) | 1 Secp256k1(33)
    if (pk === 0) r.bytes(32);
    else if (pk === 1) r.bytes(33);
    else throw new Error(`bad pk tag ${pk}`);
    r.u64(); // gas_limit
  } else if (txType !== 0) {
    throw new Error(`unsupported tx_type ${txType}`);
  }
  const headerEnd = r.o;
  const headerSec = new Uint8Array(headerEnd + 1);
  headerSec[0] = 6; // Section::Header
  headerSec.set(tx.subarray(0, headerEnd), 1);
  const wrapperHash = H(headerSec);
  const wrapperBytes = sha256(headerSec);

  const commitments: TxCommitment[] = commitmentBytes.map((c) => {
    const ch = sha256(c);
    const joined = new Uint8Array(64);
    joined.set(wrapperBytes, 0);
    joined.set(ch, 32);
    return {
      innerHash: H(joined),
      codeHash: hex.encode(c.subarray(0, 32)).toUpperCase(),
      dataHash: hex.encode(c.subarray(32, 64)).toUpperCase(),
      memoHash: hex.encode(c.subarray(64, 96)).toUpperCase(),
    };
  });

  // ---- Sections
  const out: DecodedTx = { wrapperHash, commitments, codes: new Map(), data: new Map(), stoppedAt: null };
  const nSec = r.u32();
  for (let i = 0; i < nSec; i++) {
    const start = r.o;
    const tag = r.u8();
    try {
      if (tag === 0) {
        r.bytes(8); // salt
        const data = r.vec();
        out.data.set(H(tx.subarray(start, r.o)), data);
      } else if (tag === 1 || tag === 2) {
        const code = readCode(r, tag);
        if (tag === 2) out.codes.set(code.sectionHash, { tag: code.tag, codeHash: code.codeHash });
      } else if (tag === 3) {
        // Authorization { targets: Vec<Hash>, signer: Signer, signatures: BTreeMap<u8, Signature> }
        const nt = r.u32();
        r.bytes(32 * nt);
        const st = r.u8();
        if (st === 0) readAddress(r);
        else if (st === 1) { const np = r.u32(); for (let k = 0; k < np; k++) { const pk = r.u8(); r.bytes(pk === 0 ? 32 : 33); } }
        else throw new Error(`bad signer tag ${st}`);
        const ns = r.u32();
        for (let k = 0; k < ns; k++) { r.u8(); const sg = r.u8(); r.bytes(sg === 0 ? 64 : 65); }
      } else {
        // MaspTx (4), MaspBuilder (5), Header (6): not needed and not decoded here.
        out.stoppedAt = `section ${i} variant ${tag}`;
        break;
      }
    } catch (e) {
      out.stoppedAt = `section ${i} variant ${tag}: ${String(e)}`;
      break;
    }
  }
  return out;
}

/** Decode the data of a `tx_unbond.wasm` inner tx. Throws if the bytes are not exactly an Unbond. */
export function decodeUnbond(data: Uint8Array): UnbondData {
  const r = new Reader(data);
  const validator = readAddress(r);
  let amount = 0n;
  for (let i = 0; i < 4; i++) amount |= r.u64() << BigInt(64 * i);
  const source = r.option(() => readAddress(r));
  if (r.left !== 0) throw new Error(`${r.left} trailing bytes after Unbond`);
  return { validator, amount, source };
}

export const txBytesFromBase64 = (b64: string): Uint8Array => base64.decode(b64);
