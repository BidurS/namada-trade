import { NAM, NAMADA } from '../config';
import { decodeU256LE, decodeU64LE, fetchJson, withFailover } from '../util';
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

/** The nodes in `RPCS` order whose status answered, for a circuit breaker; all of them when none answered. */
export function answeringRpcs(statuses: { provider: string; error?: string }[]): readonly Rpc[] {
  const ok = RPCS.filter((r) => statuses.some((s) => s.provider === r.provider && !s.error));
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
  constructor(public path: string, public code: number, info: string) { super(`abci ${path} code ${code}: ${info}`); }
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

/** Live NAM balance (base units) of a Namada address */
export async function namBalance(owner: string, opts: ReadOpts = {}) {
  const r = await abci(`/shell/value/#${NAMADA.multitoken}/#${NAM.namadaToken}/balance/#${owner}`, opts);
  return { balance: decodeU256LE(r.value), height: r.height, provider: r.provider };
}

/**
 * The same read for the cron's rolling refresh: one attempt per node (no retries) and a short timeout, so a
 * batch of addresses costs at most two requests each and a slow node cannot stall the tick.
 */
export async function namBalanceQuick(owner: string, opts: ReadOpts = {}) {
  return namBalance(owner, { ...QUICK, ...opts });
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
 * All bonds of an owner at an epoch: delegations (HashMap<Address, Amount>) plus, if the owner is a
 * validator, its self-bond. Amounts are NAM. Throws when the RPCs fail; never returns a guess.
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
  // Self-bond (validators bonding to themselves are not "delegations"). An address with no self-bond gets an
  // answer with code 1 ("Cannot find bond"): that is "none". A read that got no answer (a timeout, a hung node,
  // the tick's deadline) throws, so the delegations alone are never written as the address's whole stake.
  try {
    const sb = await abci(`/vp/pos/bond/${owner}/${owner}`, opts);
    if (sb.value) {
      const v = decodeU256LE(sb.value);
      if (v > 0n) out.push({ validator: owner, amountNam: Number(v) / 1e6 });
    }
  } catch (e) {
    if (!(e instanceof AbciCodeError)) throw e;
  }
  return { epoch, delegations: out, bondedNam: out.reduce((a, d) => a + d.amountNam, 0), provider: r.provider, height: r.height };
}

// ---------------------------------------------------------------- staker discovery
//
// The site used to learn of a staker only from its own flow index (from block 7,682,174) or the holder list, so
// genesis and early delegators were never read: on 2026-10-19 it tracked 862 of the chain's 21,443 delegators and
// "Staked NAM is traced address by address" stopped at 87.3%. The chain lists every delegation to a validator in
// one query (/vp/pos/bonds_and_unbonds/to/<validator>, about 18 KB for 137 delegators, 414 KB for the largest).

/** A borsh reader over an ABCI value (base64). */
class Borsh {
  private p = 0;
  constructor(private readonly b: Uint8Array) {}
  get done() { return this.p === this.b.length; }
  private take(n: number) {
    if (this.p + n > this.b.length) throw new Error('borsh: value ends early');
    const s = this.b.subarray(this.p, this.p + n);
    this.p += n;
    return s;
  }
  u8() { return this.take(1)[0]; }
  u32() { const s = this.take(4); return (s[0] | (s[1] << 8) | (s[2] << 16) | (s[3] << 24)) >>> 0; }
  skip(n: number) { this.take(n); }
  /** token::Amount: 32 bytes little-endian; returned in NAM (6 decimals), exact enough for sums of stakes. */
  amountNam() {
    const s = this.take(32);
    let v = 0n;
    for (let i = 31; i >= 0; i--) v = (v << 8n) | BigInt(s[i]);
    return Number(v) / 1e6;
  }
  /** Address: borsh tag 0 Established, 1 Implicit (+ 20 bytes). The bech32m payload's first byte is 1 for
   *  established and 0 for implicit. Internal addresses (tag 2) never stake and stop the read. */
  address() {
    const tag = this.u8();
    if (tag !== 0 && tag !== 1) throw new Error(`borsh: unexpected address kind ${tag}`);
    const hash = this.take(20);
    return bech32m.encode('tnam', bech32m.toWords(new Uint8Array([tag === 0 ? 1 : 0, ...hash])), 100);
  }
}
const b64bytes = (v: string | null) => (v ? Uint8Array.from(atob(v), (c) => c.charCodeAt(0)) : new Uint8Array());

/** Every validator address the chain knows (HashSet<Address>). */
export async function validatorAddresses(opts: ReadOpts = {}): Promise<string[]> {
  return parseAddressSet((await abci('/vp/pos/validator/addresses', opts)).value);
}
export function parseAddressSet(value: string | null): string[] {
  const b = new Borsh(b64bytes(value));
  const out: string[] = [];
  for (let i = b.u32(); i > 0; i--) out.push(b.address());
  if (!b.done) throw new Error('validator addresses: unread bytes');
  return out;
}

/**
 * Every address with a bond or an unbond at `validator` (BondsAndUnbondsDetails: HashMap<BondId, Detail> with
 * bonds {start, amount, slashed?}, unbonds {start, withdraw, amount, slashed?}, slashes {epoch, height, type, rate}),
 * with the sum of its bond entries in NAM. The sum includes bonds still in the pipeline, so it is a lead for the
 * stake verifier (delegationsAt), never shown as the staked figure itself.
 */
export async function delegatorsOf(validator: string, opts: ReadOpts = {}): Promise<Map<string, number>> {
  return parseDelegators((await abci(`/vp/pos/bonds_and_unbonds/to/${validator}`, opts)).value);
}
export function parseDelegators(value: string | null): Map<string, number> {
  const b = new Borsh(b64bytes(value));
  const out = new Map<string, number>();
  for (let n = b.u32(); n > 0; n--) {
    const source = b.address();
    b.address(); // the validator itself
    let bonded = 0;
    for (let k = b.u32(); k > 0; k--) { b.skip(8); bonded += b.amountNam(); if (b.u8() === 1) b.skip(32); }
    for (let k = b.u32(); k > 0; k--) { b.skip(16); b.skip(32); if (b.u8() === 1) b.skip(32); }
    for (let k = b.u32(); k > 0; k--) { b.skip(16); b.u8(); b.skip(32); }
    out.set(source, (out.get(source) ?? 0) + bonded);
  }
  if (!b.done) throw new Error('delegators: unread bytes');
  return out;
}
