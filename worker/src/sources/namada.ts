import { NAM, NAMADA } from '../config';
import { decodeU256LE, decodeU64LE, fetchJson, fetchText, withFailover, ReadCutError } from '../util';
import { bech32m } from '@scure/base';
import type { NamadaBlock } from '../parse/namada';

export type Rpc = { provider: string; url: string };
const RPCS: readonly Rpc[] = NAMADA.rpcs;

export async function namadaStatus(rpc: Rpc = RPCS[0], opts: { timeoutMs?: number; retries?: number } = {}) {
  const r = await fetchJson(`${rpc.url}/status`, { timeoutMs: opts.timeoutMs ?? 10000, retries: opts.retries ?? 1 });
  const s = r.result.sync_info;
  return {
    provider: rpc.provider,
    height: Number(s.latest_block_height),
    time: Date.parse(s.latest_block_time),
    catchingUp: Boolean(s.catching_up),
    earliest: Number(s.earliest_block_height),
  };
}

/** Status from every RPC (for the multi-source agreement check) */
export async function namadaStatusAll(opts: { timeoutMs?: number; retries?: number } = {}) {
  return Promise.all(RPCS.map((r) => namadaStatus(r, opts).catch((e) => ({ provider: r.provider, error: String(e) }))));
}

/**
 * The nodes in `RPCS` order whose status answered and that are not catching up (a node replaying blocks after a
 * restart answers queries from an old state: its listing would be applied as the chain's current one); all of
 * them when none answered.
 */
export function answeringRpcs(statuses: { provider: string; error?: string; catchingUp?: boolean }[]): readonly Rpc[] {
  const ok = RPCS.filter((r) => statuses.some((s) => s.provider === r.provider && !s.error && !s.catchingUp));
  return ok.length ? ok : RPCS;
}

/**
 * A read tried on each node in turn (a breaker's order when one is given): the first answer wins, and an answer
 * without the expected shape counts as no answer, so the next node is asked. Timeouts and retries are per node.
 */
async function rpcRead<T>(fn: (base: string) => Promise<T>, opts: ReadOpts): Promise<{ value: T; provider: string }> {
  const base = opts.rpcs?.length ? opts.rpcs : RPCS;
  const list = opts.breaker ? opts.breaker.order(base) : base;
  let lastErr: unknown;
  for (const r of list) {
    if (opts.signal?.aborted) break;
    try { return { value: await fn(r.url), provider: r.provider }; } catch (e) {
      lastErr = e;
      if (!opts.signal?.aborted) opts.breaker?.failed(r.provider);
    }
  }
  throw lastErr ?? new Error('deadline passed before any node answered');
}

/** The live scan's reads (live-hub.ts): one attempt per node, ten seconds; a block that times out is read again next tick. */
export const LIVE_READ: ReadOpts = { timeoutMs: 10000, retries: 0 };

/** The head from the first node that answers: a down node is never the reason the other is not asked. */
export async function namadaStatusAny(opts: ReadOpts = QUICK) {
  const list = opts.breaker ? opts.breaker.order(RPCS) : RPCS;
  let last: unknown;
  for (const r of list) {
    try { return await namadaStatus(r, opts); } catch (e) { last = e; opts.breaker?.failed(r.provider); }
  }
  throw last ?? new Error('no Namada node answered /status');
}

/** Block metas (height, time, num_txs) for up to 20 blocks. Scripts take the patient defaults (15 s, 3 attempts a node). */
export async function blockMetas(min: number, max: number, opts: ReadOpts = {}) {
  const { value } = await rpcRead(async (b) => {
    const v = await fetchJson(`${b}/blockchain?minHeight=${min}&maxHeight=${max}`, { timeoutMs: opts.timeoutMs ?? 15000, retries: opts.retries, signal: opts.signal });
    if (!Array.isArray(v?.result?.block_metas)) throw new Error(`blockchain ${min}-${max}: answer without block_metas`);
    return v;
  }, opts);
  return (value.result.block_metas as any[]).map((m) => ({
    height: Number(m.header.height),
    ts: Date.parse(m.header.time),
    numTxs: Number(m.num_txs),
  }));
}

export async function blockResults(height: number, ts: number, opts: ReadOpts = {}): Promise<NamadaBlock> {
  const { value } = await rpcRead(async (b) => {
    const v = await fetchJson(`${b}/block_results?height=${height}`, { timeoutMs: opts.timeoutMs ?? 30000, retries: opts.retries, signal: opts.signal });
    if (!v?.result || typeof v.result !== 'object') throw new Error(`block_results ${height}: answer without a result`);
    return v;
  }, opts);
  const r = value.result;
  const events = [
    ...(r.begin_block_events ?? []),
    ...(r.end_block_events ?? []),
    ...(r.finalize_block_events ?? []),
    ...((r.txs_results ?? []) as any[]).flatMap((t) => t.events ?? []),
  ];
  return { height, ts, events };
}

/** Raw txs of a block (base64, CometBFT protobuf envelope around the borsh Namada Tx) */
export async function blockTxs(height: number, opts: ReadOpts = {}): Promise<string[]> {
  const { value } = await rpcRead(async (b) => {
    const v = await fetchJson(`${b}/block?height=${height}`, { timeoutMs: opts.timeoutMs ?? 30000, retries: opts.retries, signal: opts.signal });
    if (!Array.isArray(v?.result?.block?.data?.txs)) throw new Error(`block ${height}: no txs array in /block response`);
    return v;
  }, opts);
  return value.result.block.data.txs as string[];
}

/** Heights (with block time) that emitted token/transfer events within [lo, hi] */
export async function transferHeights(lo: number, hi: number, page = 1, perPage = 100) {
  const q = encodeURIComponent(`"token/transfer.height>=${lo} AND token/transfer.height<=${hi}"`);
  const { value } = await withFailover(RPCS, (b) =>
    fetchJson(`${b}/block_search?query=${q}&page=${page}&per_page=${perPage}&order_by="asc"`, { timeoutMs: 120000, retries: 2 }),
  );
  const res = value.result;
  return {
    total: Number(res.total_count),
    blocks: (res.blocks as any[]).map((b) => ({
      height: Number(b.block.header.height),
      ts: Date.parse(b.block.header.time),
    })),
  };
}

/**
 * Options for a chain read. `rpcs`: the nodes to try, in order (the cron passes only the nodes whose status
 * answered this tick, so a node that accepts requests and never answers costs nothing after the first check).
 * `signal`: a deadline that ends the read and every retry. `timeoutMs` / `retries`: per node.
 */
export interface ReadOpts { rpcs?: readonly Rpc[]; timeoutMs?: number; retries?: number; signal?: AbortSignal; breaker?: RpcBreaker }

/** One attempt per node, a short timeout: for batches, so a slow node cannot stall them (≤ 2 requests a read). */
export const QUICK: ReadOpts = { timeoutMs: 8000, retries: 0 };

/**
 * The nodes that failed a read during one cron tick go to the back of the line for the rest of the tick. A node
 * can answer its status and then hang on every query (the status check cannot see that): without this, every read
 * of the tick would wait out its timeout on that node before asking the next one. A node is never dropped, only
 * tried later, so it still answers when the others fail. Answers with an error code are answers, not failures.
 */
export class RpcBreaker {
  private fails = new Map<string, number>();
  failed(provider: string) { this.fails.set(provider, (this.fails.get(provider) ?? 0) + 1); }
  failures(provider: string) { return this.fails.get(provider) ?? 0; }
  /** `list` with the nodes that failed least first (a stable sort: the preference order otherwise). */
  order(list: readonly Rpc[]): Rpc[] { return [...list].sort((a, b) => this.failures(a.provider) - this.failures(b.provider)); }
}

/** The node answered, with an error code: an answer about the query (no such bond, no such path), not a failure. */
export class AbciCodeError extends Error {
  readonly path: string;
  readonly code: number;
  constructor(path: string, code: number, info: string) { super(`abci ${path} code ${code}: ${info}`); this.path = path; this.code = code; }
}

async function abci(path: string, opts: ReadOpts = {}) {
  const run = (b: string) =>
    fetchJson(`${b}/abci_query?path=${encodeURIComponent(`"${path}"`)}`, { timeoutMs: opts.timeoutMs ?? 15000, retries: opts.retries, signal: opts.signal });
  const base = opts.rpcs?.length ? opts.rpcs : RPCS;
  const list = opts.breaker ? opts.breaker.order(base) : base;
  let value: any, provider = '';
  let lastErr: unknown;
  for (const r of list) {
    if (opts.signal?.aborted) break;
    try { value = await run(r.url); provider = r.provider; break; } catch (e) {
      lastErr = e;
      // A read cut by the tick's own deadline says nothing about the node.
      if (!opts.signal?.aborted) opts.breaker?.failed(r.provider);
    }
  }
  if (!provider) throw lastErr ?? new Error(`abci ${path}: deadline passed`);
  const resp = value?.result?.response;
  if (!resp) throw new Error(`abci ${path}: answer without a response`);
  if (resp.code && resp.code !== 0) throw new AbciCodeError(path, Number(resp.code), String(resp.info || resp.log || ''));
  return { value: resp.value as string | null, height: Number(resp.height || 0), provider };
}

/** What a listing read answers: the ABCI value with the node, height, bytes and time of the read. */
export interface ListingAnswer { value: string | null; height: number; provider: string; bytes: number; readMs: number }

/**
 * One multi-megabyte ABCI answer, read by streaming (util.ts fetchText) so a read cut short says how much arrived:
 * one attempt per node in `opts.rpcs` order, each with the whole `timeoutMs` for its stream. No breaker: a node
 * that streams slowly answers; it is not "no answer". When every node fails, the error names each node's outcome
 * ("5ElementsNodes: timeout: 4.2 MB of 12.0 MB arrived in 180 s (first byte after 5.8 s); Papadritta: …").
 */
async function abciListing(path: string, opts: ReadOpts = {}): Promise<ListingAnswer> {
  const base = opts.rpcs?.length ? opts.rpcs : RPCS;
  const list = opts.breaker ? opts.breaker.order(base) : base;
  const notes: string[] = [];
  for (const r of list) {
    if (opts.signal?.aborted) { notes.push(`${r.provider}: not asked, the deadline had passed`); break; }
    const t0 = Date.now();
    try {
      const { text, bytes } = await fetchText(`${r.url}/abci_query?path=${encodeURIComponent(`"${path}"`)}`, { timeoutMs: opts.timeoutMs ?? 180_000, signal: opts.signal });
      const resp = JSON.parse(text)?.result?.response;
      if (!resp) throw new Error('answer without a response');
      if (resp.code && resp.code !== 0) throw new AbciCodeError(path, Number(resp.code), String(resp.info || resp.log || ''));
      return { value: (resp.value as string | null) ?? null, height: Number(resp.height || 0), provider: r.provider, bytes, readMs: Date.now() - t0 };
    } catch (e) {
      if (!opts.signal?.aborted) opts.breaker?.failed(r.provider);
      notes.push(`${r.provider}: ${e instanceof ReadCutError ? e.message : String(e instanceof Error ? e.message : e).slice(0, 120)}`);
    }
  }
  throw new Error(notes.join('; ') || `abci ${path}: no node to ask`);
}

/** Live NAM balance (base units) of a Namada address */
export async function namBalance(owner: string, opts: ReadOpts = {}) {
  const r = await abci(`/shell/value/#${NAMADA.multitoken}/#${NAM.namadaToken}/balance/#${owner}`, opts);
  return { balance: decodeU256LE(r.value), height: r.height, provider: r.provider };
}

export async function namTotalSupply(opts: ReadOpts = {}) {
  const r = await abci(`/shell/value/#${NAMADA.multitoken}/#${NAM.namadaToken}/balance/minted`, opts);
  return { supply: decodeU256LE(r.value), provider: r.provider };
}

/**
 * The chain's own total stake (base units): what is bonded to validators at the current epoch. The PoS
 * account's NAM balance is larger: it also holds unbonding NAM, unbonds already withdrawable, and rewards not
 * yet claimed (on 2026-10-17: 341,964,111 NAM balance against 267,180,094 NAM total stake).
 */
export async function namTotalStake(opts: ReadOpts = {}) {
  const r = await abci('/vp/pos/total_stake', opts);
  return { stake: decodeU256LE(r.value), height: r.height, provider: r.provider };
}

export async function namadaEpoch(opts: ReadOpts = {}) {
  const r = await abci('/shell/epoch', opts);
  return decodeU64LE(r.value);
}

/** Borsh `Address` tag → bech32 discriminant (Established=1, Implicit=0, Internal=2). */
function borshAddress(b: Uint8Array): string {
  const disc = b[0] === 0 ? 1 : b[0] === 1 ? 0 : 2;
  return bech32m.encode('tnam', bech32m.toWords(new Uint8Array([disc, ...b.subarray(1, 21)])), 100);
}

function u256At(b: Uint8Array, o: number): bigint {
  let v = 0n;
  for (let k = 31; k >= 0; k--) v = (v << 8n) | BigInt(b[o + k]);
  return v;
}

/**
 * All bonds of an owner at an epoch: delegations (HashMap<Address, Amount>), self-bond included. Amounts are NAM.
 * Throws when the RPCs fail; never returns a guess. Checked on 2026-10-20 on three validators: delegations_at
 * already lists a validator's own bond (53 NAM for tnam1q82gt…, the same as /vp/pos/bond/<v>/<v>), so the
 * self-bond read below is only a guard for an answer that leaves it out; before this it was added on top, so
 * every validator's stake was counted twice by the per-address verification.
 */
export async function delegationsAt(owner: string, epoch: number, opts: ReadOpts = {}) {
  const r = await abci(`/vp/pos/delegations_at/${owner}/${epoch}`, opts);
  const b = r.value ? Uint8Array.from(atob(r.value), (c) => c.charCodeAt(0)) : new Uint8Array(4);
  const n = b.length >= 4 ? new DataView(b.buffer, b.byteOffset).getUint32(0, true) : 0;
  const out: { validator: string; amountNam: number }[] = [];
  let o = 4;
  for (let i = 0; i < n && o + 53 <= b.length; i++) {
    const validator = borshAddress(b.subarray(o, o + 21)); o += 21;
    const amt = u256At(b, o); o += 32;
    if (amt > 0n) out.push({ validator, amountNam: Number(amt) / 1e6 });
  }
  // The self-bond, when the list above left it out. An address with no self-bond gets an answer with code 1
  // ("Cannot find bond"): that is "none". A read that got no answer (a timeout, a hung node, the tick's deadline)
  // throws, so the delegations alone are never written as the address's whole stake.
  try {
    const sb = await abci(`/vp/pos/bond/${owner}/${owner}`, opts);
    if (sb.value && !out.some((d) => d.validator === owner)) {
      const v = decodeU256LE(sb.value);
      if (v > 0n) out.push({ validator: owner, amountNam: Number(v) / 1e6 });
    }
  } catch (e) {
    if (!(e instanceof AbciCodeError)) throw e;
  }
  return { epoch, delegations: out, bondedNam: out.reduce((a, d) => a + d.amountNam, 0), provider: r.provider, height: r.height };
}


// ---------------------------------------------------------------- the bulk index: every balance, every bond
//
// The site used to learn of a Namada address only from its own flow index (from block 7,682,174), a one-off
// import, and a per-validator pass: on 2026-10-19 it tracked 3,636 of the 64,373 addresses that hold NAM and
// read spendable balances 50 at a time. The chain lists everything in one ABCI query each (both checked on
// 2026-10-20 against rpc-namada.5elementsnodes.com, neither node compresses its answer):
// - every NAM balance: /shell/prefix/#<multitoken>/#<NAM>/balance, 90,783 keys, 9.0 MB borsh (12 MB JSON), ~3 s;
// - every bond: /vp/pos/bonds_and_unbonds/to (both parts empty), 30,271 source × validator entries, 4.0 MB, ~3 s.
// Both parsers read the answer byte for byte into typed arrays (no string building) and refuse a truncated or
// malformed answer whole, so nothing is ever half-applied. The listings are read on their own schedule (cron.ts
// runListings, every LISTING_CRON): a public node can take a minute or more to stream 12 MB, which no per-minute
// tick can wait for.

const B64 = new Int16Array(256).fill(-1);
for (let i = 0; i < 64; i++) B64['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.charCodeAt(i)] = i;

/** base64 → bytes straight into a Uint8Array (atob on a 12 MB answer would first build an 18 MB UTF-16 string). */
export function base64Bytes(s: string): Uint8Array {
  let n = s.length;
  while (n > 0 && s.charCodeAt(n - 1) === 61) n--; // '=' padding
  const out = new Uint8Array(Math.floor((n * 3) / 4));
  let acc = 0, bits = 0, o = 0;
  for (let i = 0; i < n; i++) {
    const v = B64[s.charCodeAt(i)];
    if (v < 0) throw new Error(`base64: bad character at ${i}`);
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 0xff; }
  }
  return o === out.length ? out : out.subarray(0, o);
}

/** The raw 21-byte form (bech32m payload) of a tnam address: [discriminant, 20 bytes]. */
function rawAddress(addr: string): Uint8Array {
  return bech32m.fromWords(bech32m.decode(addr as `${string}1${string}`, 100).words);
}
const MULTITOKEN_RAW = rawAddress(NAMADA.multitoken);
const NAM_RAW = rawAddress(NAM.namadaToken);
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Borsh `InternalAddress` variant → raw address discriminant (namada_core address::raw). Variants 4 (IbcToken), 8
 * (Erc20) and 9 (Nut) carry 20 more bytes; the others encode as the discriminant followed by 20 zero bytes, which
 * is why the protocol accounts read tnam1qgqqq… (PoS, 2), tnam1qcqqq… (IBC, 6), tnam1q5qqq… (governance, 5),
 * tnam1pyqqq… (multitoken, 9), tnam1pgqqq… (PGF, 10) and tnam1pcqqq… (MASP, 14). Checked against config.ts.
 */
const INTERNAL_DISCRIMINANT = [2, 3, 4, 6, 13, 5, 7, 8, 11, 12, 9, 10, 14, 15, 16];
const INTERNAL_WITH_HASH = new Set([4, 8, 9]);

/** A borsh reader over an ABCI answer. Every read past the end throws, so a cut answer is refused, never half-read. */
class Borsh {
  private p = 0;
  private readonly raw = new Uint8Array(21);
  private readonly view: DataView;
  private readonly b: Uint8Array;
  // no parameter properties: Node's type stripping (scripts/backfill-namada.ts imports this module) does not take them
  constructor(b: Uint8Array) { this.b = b; this.view = new DataView(b.buffer, b.byteOffset, b.byteLength); }
  get done() { return this.p === this.b.length; }
  get offset() { return this.p; }
  private take(n: number) {
    if (this.p + n > this.b.length) throw new Error(`borsh: value ends early at byte ${this.p}`);
    const s = this.b.subarray(this.p, this.p + n);
    this.p += n;
    return s;
  }
  u8() { return this.take(1)[0]; }
  u32() { const v = this.view.getUint32(this.p, true); this.p += 4; return v; }
  u64() {
    const lo = BigInt(this.view.getUint32(this.p, true));
    const hi = BigInt(this.view.getUint32(this.p + 4, true));
    this.p += 8;
    return Number((hi << 32n) | lo);
  }
  skip(n: number) { this.take(n); }
  /** token::Amount: 32 bytes little-endian, exact (base units). */
  amount(): bigint {
    const s = this.take(32);
    let v = 0n;
    for (let i = 31; i >= 0; i--) v = (v << 8n) | BigInt(s[i]);
    return v;
  }
  /** A borsh String (u32 length + UTF-8). */
  string() { return new TextDecoder().decode(this.take(this.u32())); }
  /**
   * Address, in its raw 21-byte form: tag 0 Established and 1 Implicit (+ 20 bytes; the raw discriminant is 1 for
   * established, 0 for implicit), tag 2 Internal (a variant byte, then 20 bytes for the three hashed variants).
   * The returned view is reused by the next call: copy or encode it before reading on.
   */
  addressRaw(): { raw: Uint8Array; internal: boolean } {
    const tag = this.u8();
    const raw = this.raw;
    if (tag === 0 || tag === 1) {
      raw[0] = tag === 0 ? 1 : 0;
      raw.set(this.take(20), 1);
      return { raw, internal: false };
    }
    if (tag !== 2) throw new Error(`borsh: unexpected address kind ${tag} at byte ${this.p - 1}`);
    const variant = this.u8();
    const disc = INTERNAL_DISCRIMINANT[variant];
    if (disc == null) throw new Error(`borsh: unknown internal address variant ${variant}`);
    raw[0] = disc;
    if (INTERNAL_WITH_HASH.has(variant)) raw.set(this.take(20), 1);
    else raw.fill(0, 1);
    return { raw, internal: true };
  }
  address() { const a = this.addressRaw(); return { address: encodeAddress(a.raw), internal: a.internal }; }
}
const encodeAddress = (raw: Uint8Array) => bech32m.encode('tnam', bech32m.toWords(raw), 100);

/** What one balance listing answer holds, decoded. */
export interface BalanceListing {
  /** every user (established or implicit) key the chain holds under the NAM balance prefix, in base units; zero
   *  balances included (26,404 of 90,777 on 2026-10-20), so a caller can tell "listed as 0" from "not listed" */
  entries: Map<string, string>;
  /** the protocol accounts (PoS, IBC escrow, MASP, PGF, governance…), base units: not holders, read separately */
  internal: Map<string, string>;
  /** the token's `balance/minted` key: the minted total, never a holder; null when the answer lacks it */
  minted: string | null;
  /** keys in the answer (entries + internal + the minted key) and the answer's decoded size */
  keys: number;
  bytes: number;
}

/**
 * Decode a /shell/prefix/#<multitoken>/#<NAM>/balance answer: borsh Vec<PrefixValue { key: Key { segments:
 * Vec<DbKeySeg> }, value: Vec<u8> }>, DbKeySeg 0 = AddressSeg(Address), 1 = StringSeg(String). Every key must be
 * exactly [multitoken, NAM, "balance", owner] (owner an address, or the string "minted") with a 32-byte Amount
 * value; anything else, and any answer that ends early or has bytes left over, throws.
 */
export function parseBalanceListing(value: string | null): BalanceListing {
  const bytes = base64Bytes(value ?? '');
  const b = new Borsh(bytes);
  const entries = new Map<string, string>();
  const internal = new Map<string, string>();
  let minted: string | null = null;
  const n = b.u32();
  for (let i = 0; i < n; i++) {
    const segs = b.u32();
    if (segs !== 4) throw new Error(`balance listing: key ${i} has ${segs} segments, not 4`);
    if (b.u8() !== 0 || !sameBytes(b.addressRaw().raw, MULTITOKEN_RAW)) throw new Error(`balance listing: key ${i} is not under the multitoken account`);
    if (b.u8() !== 0 || !sameBytes(b.addressRaw().raw, NAM_RAW)) throw new Error(`balance listing: key ${i} is not a NAM key`);
    if (b.u8() !== 1 || b.string() !== 'balance') throw new Error(`balance listing: key ${i} is not a balance key`);
    const tag = b.u8();
    let owner: { address: string; internal: boolean } | null = null;
    if (tag === 0) owner = b.address();
    else if (tag === 1) { const s = b.string(); if (s !== 'minted') throw new Error(`balance listing: key ${i} ends in "${s}"`); }
    else throw new Error(`balance listing: key ${i} has an unknown segment kind ${tag}`);
    if (b.u32() !== 32) throw new Error(`balance listing: key ${i} has a value that is not a 32-byte amount`);
    const amount = b.amount().toString();
    if (!owner) minted = amount;
    else if (owner.internal) internal.set(owner.address, amount);
    else entries.set(owner.address, amount);
  }
  if (!b.done) throw new Error(`balance listing: ${bytes.length - b.offset} unread bytes`);
  return { entries, internal, minted, keys: n, bytes: bytes.length };
}

/** What a listing read adds to the decoded answer: the node and height that answered, the read's time. */
export interface ListingRead { height: number; provider: string; readMs: number }

/** Every NAM balance on the chain in one query (see parseBalanceListing), with the node and height that answered. */
export async function allNamBalances(opts: ReadOpts = {}): Promise<BalanceListing & ListingRead> {
  const r = await abciListing(`/shell/prefix/#${NAMADA.multitoken}/#${NAM.namadaToken}/balance`, opts);
  if (!r.value) throw new Error(`balance listing: empty answer from ${r.provider}`);
  if (!(r.height > 0)) throw new Error(`balance listing: answer without a height from ${r.provider}`);
  return { ...parseBalanceListing(r.value), height: r.height, provider: r.provider, readMs: r.readMs };
}

/** One pending or withdrawable unbond decoded from /vp/pos/bonds_and_unbonds/to. */
export interface UnbondListingItem {
  validator: string;
  startEpoch: number;
  withdrawEpoch: number;
  amountBase: bigint;
  grossBase: bigint;
  slashedBase: bigint;
  amountNam: number;
}

/** One slash record decoded from /vp/pos/bonds_and_unbonds/to. */
export interface SlashListingItem {
  source: string;
  validator: string;
  epoch: number;
  block: number;
  kind: number;
  rateBase: bigint;
}

/**
 * One source's bonds and unbonds from the bond listing: the sum of its bond entries net of what was slashed from them
 * (base units; `grossBase` before the deduction, `slashedBase` the deduction), the per-validator split, and its
 * unbonds (both in-flight and withdrawable, net of slashing).
 */
export interface BondedSource {
  bondedBase: bigint;
  grossBase: bigint;
  slashedBase: bigint;
  unbondingBase: bigint;
  unbondGrossBase: bigint;
  unbondSlashedBase: bigint;
  delegations: { validator: string; amountNam: number }[];
  unbonds: UnbondListingItem[];
}

export interface BondListing {
  /** source address → its bonds and unbonds; sources whose bonds sum to 0 (unbonds only, or slashed whole) are listed with bondedBase 0n */
  sources: Map<string, BondedSource>;
  /** source × validator entries in the answer; the sum of every bond entry net of slashing, gross, and the slashed total; the decoded size */
  entries: number;
  totalBase: bigint;
  grossBase: bigint;
  slashedBase: bigint;
  /** sum of every unbond entry net of slashing (in-flight + withdrawable), gross, and slashed; counts of entries carrying unbonds/slashes */
  unbondingBase: bigint;
  unbondGrossBase: bigint;
  unbondSlashedBase: bigint;
  entriesWithUnbonds: number;
  entriesWithSlashes: number;
  slashes: SlashListingItem[];
  bytes: number;
}

/**
 * Decode a /vp/pos/bonds_and_unbonds/to answer (every bond on the chain; the per-validator variant
 * …/to/<validator> has the same layout): borsh HashMap<BondId { source, validator }, Detail { bonds: Vec<{ start
 * u64, amount Amount, slashed Option<Amount> }>, unbonds: Vec<{ start u64, withdraw u64, amount, slashed Option }>,
 * slashes: Vec<{ epoch u64, block u64, type u8, rate Amount }> }>, count first. A bond or unbond entry's `slashed`
 * is what a slash took from its `amount`, so net stake is amount − slashed (on 2026-10-20: 268,038,299 NAM gross, of
 * which 860,517 NAM slashed, against a total stake of 267,175,777 NAM; the 2,006 NAM left over are bonds still in
 * the pipeline, listed before they count). Throws on a cut or malformed answer.
 */
export function parseBondListing(value: string | null): BondListing {
  const bytes = base64Bytes(value ?? '');
  const b = new Borsh(bytes);
  const sources = new Map<string, {
    byValidator: Map<string, { gross: bigint; slashed: bigint }>;
    unbonds: UnbondListingItem[];
    uGross: bigint;
    uSlashed: bigint;
  }>();
  const slashes: SlashListingItem[] = [];
  const n = b.u32();
  let gross = 0n, slashed = 0n, unbondGross = 0n, unbondSlashed = 0n;
  let entriesWithUnbonds = 0, entriesWithSlashes = 0;
  for (let i = 0; i < n; i++) {
    const source = b.address();
    const validator = b.address();
    if (source.internal || validator.internal) throw new Error(`bond listing: entry ${i} names an internal address`);
    let g = 0n, sl = 0n;
    for (let k = b.u32(); k > 0; k--) { b.u64(); g += b.amount(); if (b.u8() === 1) sl += b.amount(); }
    if (sl > g) throw new Error(`bond listing: entry ${i} has more slashed than bonded`);

    let src = sources.get(source.address);
    if (!src) {
      src = { byValidator: new Map(), unbonds: [], uGross: 0n, uSlashed: 0n };
      sources.set(source.address, src);
    }

    const uCount = b.u32();
    if (uCount > 0) entriesWithUnbonds++;
    for (let k = uCount; k > 0; k--) {
      const startEpoch = b.u64();
      const withdrawEpoch = b.u64();
      const ug = b.amount();
      const usl = b.u8() === 1 ? b.amount() : 0n;
      if (usl > ug) throw new Error(`bond listing: entry ${i} has more slashed than unbonded`);
      const unet = ug - usl;
      src.uGross += ug;
      src.uSlashed += usl;
      unbondGross += ug;
      unbondSlashed += usl;
      if (unet > 0n) {
        src.unbonds.push({
          validator: validator.address,
          startEpoch,
          withdrawEpoch,
          amountBase: unet,
          grossBase: ug,
          slashedBase: usl,
          amountNam: Number(unet) / 1e6,
        });
      }
    }

    const sCount = b.u32();
    if (sCount > 0) entriesWithSlashes++;
    for (let k = sCount; k > 0; k--) {
      const epoch = b.u64();
      const block = b.u64();
      const kind = b.u8();
      const rateBase = b.amount();
      slashes.push({ source: source.address, validator: validator.address, epoch, block, kind, rateBase });
    }

    const v = src.byValidator.get(validator.address) ?? src.byValidator.set(validator.address, { gross: 0n, slashed: 0n }).get(validator.address)!;
    v.gross += g; v.slashed += sl;
    gross += g; slashed += sl;
  }
  if (!b.done) throw new Error(`bond listing: ${bytes.length - b.offset} unread bytes`);
  const out = new Map<string, BondedSource>();
  for (const [source, s] of sources) {
    let bondedBase = 0n, grossBase = 0n, slashedBase = 0n;
    const delegations: BondedSource['delegations'] = [];
    for (const [validator, v] of s.byValidator) {
      const net = v.gross - v.slashed;
      bondedBase += net; grossBase += v.gross; slashedBase += v.slashed;
      if (net > 0n) delegations.push({ validator, amountNam: Number(net) / 1e6 });
    }
    // sorted, so the same bonds always give the same JSON (the cron writes only rows whose JSON changed)
    delegations.sort((x, y) => (x.validator < y.validator ? -1 : x.validator > y.validator ? 1 : 0));
    s.unbonds.sort((x, y) => x.withdrawEpoch - y.withdrawEpoch || (x.validator < y.validator ? -1 : x.validator > y.validator ? 1 : 0));
    out.set(source, {
      bondedBase,
      grossBase,
      slashedBase,
      unbondingBase: s.uGross - s.uSlashed,
      unbondGrossBase: s.uGross,
      unbondSlashedBase: s.uSlashed,
      delegations,
      unbonds: s.unbonds,
    });
  }
  return {
    sources: out,
    entries: n,
    totalBase: gross - slashed,
    grossBase: gross,
    slashedBase: slashed,
    unbondingBase: unbondGross - unbondSlashed,
    unbondGrossBase: unbondGross,
    unbondSlashedBase: unbondSlashed,
    entriesWithUnbonds,
    entriesWithSlashes,
    slashes,
    bytes: bytes.length,
  };
}

/** Every bond on the chain in one query (see parseBondListing), with the node and height that answered. */
export async function allBonds(opts: ReadOpts = {}): Promise<BondListing & ListingRead> {
  const r = await abciListing('/vp/pos/bonds_and_unbonds/to', opts);
  if (!r.value) throw new Error(`bond listing: empty answer from ${r.provider}`);
  if (!(r.height > 0)) throw new Error(`bond listing: answer without a height from ${r.provider}`);
  return { ...parseBondListing(r.value), height: r.height, provider: r.provider, readMs: r.readMs };
}
