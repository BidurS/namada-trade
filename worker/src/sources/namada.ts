import { NAM, NAMADA } from '../config';
import { decodeU256LE, decodeU64LE, fetchJson, fetchText, withFailover, ReadCutError, FETCH_TEXT_MAX_BYTES, base64Bytes } from '../util';
import { bech32m } from '@scure/base';
import type { NamadaBlock } from '../parse/namada';
import { INTERNAL_ADDRESSES } from '../parse/namada-tx';
// The base64 decoder lives in util.ts (the depth module reads the chain node's answers with it too); callers of this file keep their import.
export { base64Bytes };

/**
 * A node of the list. `indexed: false`: the node keeps blocks and answers queries but has no event index, so a search
 * of its index answers an empty page that would read as "no blocks": it is a witness of the head and a source of
 * blocks and state, and is never asked for a search (indexedRpcs).
 */
export type Rpc = { provider: string; url: string; indexed?: boolean };
const RPCS: readonly Rpc[] = NAMADA.rpcs;
/** The nodes of a list that have an event index: every node not marked `indexed: false`. */
export const indexedRpcs = (list: readonly Rpc[]): readonly Rpc[] => list.filter((r) => r.indexed !== false);

export async function namadaStatus(rpc: Rpc = RPCS[0], opts: { timeoutMs?: number; retries?: number; signal?: AbortSignal } = {}) {
  const r = await fetchJson(`${rpc.url}/status`, { timeoutMs: opts.timeoutMs ?? 10000, retries: opts.retries ?? 1, signal: opts.signal });
  const s = r.result.sync_info;
  return {
    provider: rpc.provider,
    /** the chain the node says it is on (node_info.network): chainHead follows only a node on NAMADA.chainId */
    network: String(r.result.node_info?.network ?? ''),
    height: Number(s.latest_block_height),
    time: Date.parse(s.latest_block_time),
    catchingUp: Boolean(s.catching_up),
    earliest: Number(s.earliest_block_height),
  };
}

/** Status from every RPC (for the multi-source agreement check) */
export async function namadaStatusAll(opts: { timeoutMs?: number; retries?: number; signal?: AbortSignal } = {}) {
  return Promise.all(RPCS.map((r) => namadaStatus(r, opts).catch((e) => ({ provider: r.provider, error: String(e) }))));
}

/**
 * A status that names another chain than this one (node_info.network): that node answers for that chain, so its
 * head, listings and balances are not this chain's. A status that names no chain is not counted as another's here
 * (the live scan's chainHead asks for the name).
 */
export const namesOtherChain = (s: { network?: string }): boolean => !!s.network && s.network !== NAMADA.chainId;

/**
 * The nodes in `RPCS` order whose status answered, on this chain, and that are not catching up (a node replaying
 * blocks after a restart answers queries from an old state: its listing would be applied as the chain's current
 * one). When none did, the nodes whose status does not name another chain (a status that timed out says nothing
 * against the node's answers); a node that names another chain is never asked, so when every node does the list
 * is empty and the reads that take it (abci) have no node to ask.
 *
 * With `now`: when at least one of those nodes has a newest block from the last HEAD_MAX_AGE_MS, only the nodes that
 * do are asked. A node can sit at an old block and say it is not catching up; its answers are that block's state,
 * and a figure read from it would be stored under this tick's time while another node is at the chain's head. When
 * no node's newest block is that new (no block is being made, or every clock is off), the list is as without `now`:
 * the nodes' answers are then the newest there are.
 */
export function answeringRpcs(statuses: { provider: string; error?: string; catchingUp?: boolean; network?: string; time?: number }[], now?: number): readonly Rpc[] {
  const statusOf = (r: Rpc) => statuses.find((s) => s.provider === r.provider);
  const ok = RPCS.filter((r) => { const s = statusOf(r); return !!s && !s.error && !s.catchingUp && !namesOtherChain(s); });
  if (now != null) {
    const fresh = ok.filter((r) => { const t = Number(statusOf(r)!.time); return t > now - HEAD_MAX_AGE_MS && t < now + 60_000; });
    if (fresh.length) return fresh;
  }
  return ok.length ? ok : RPCS.filter((r) => { const s = statusOf(r); return !s || !namesOtherChain(s); });
}

/** The head the chain listings are checked against this tick (listingHeads). */
export interface ListingHead {
  /** the lowest node height another answer agrees with; null when no two answers agree */
  head: number | null;
  /** the highest node height another answer agrees with (stored heights are set aside only above it); null with no head */
  top: number | null;
  /** two nodes agree on it (not one node and the indexer) */
  byNodes: boolean;
  /** when no two answers agree, what each one said (for the listing's health row and record); null otherwise */
  note: string | null;
}

/**
 * The head the chain listings are checked against (cron.ts heightGate), agreed on as the live scan's chainHead
 * agrees on one. The answers are the status of each node that names no other chain, is not catching up and gives a
 * height that is a height, and the indexer's latest block. The head is the lowest node height that another answer is
 * within HEAD_AGREE_BLOCKS of (the 100 blocks cron.ts MAX_LISTING_HEIGHT_DRIFT allows a listing behind it), a height
 * the answers say the chain has reached, so a node a little ahead never sets it; the indexer vouches for a node's
 * height but is never the head itself. `byNodes`: two nodes agree on it. With `now`, a node whose newest block is older
 * than HEAD_MAX_AGE_MS is not an answer either (as in chainHead): it is behind, whatever catching_up says. When no two answers agree there is no head: one
 * node's word is not checked against anything (a node far ahead would have its own listing applied there, a node
 * restored from an old snapshot would roll the rows back), so no listing is applied that tick. A node that says it
 * is catching up is not an answer, so two such nodes cannot vouch for each other. The note is kept short: the listing
 * record and the health row cut it at 160 characters after "Not applied: ", and with three nodes (2026-11-07) each
 * node's reason and the indexer's block must still fit.
 */
export function listingHeads(statuses: readonly { provider?: string; error?: string; height?: number; time?: number; catchingUp?: boolean; network?: string }[], indexerHeight?: number | null, now?: number): ListingHead {
  const isHeight = (h: unknown): h is number => Number.isInteger(h) && (h as number) > 0 && (h as number) <= MAX_HEAD_HEIGHT;
  const said: string[] = [];
  const nodes: number[] = [];
  for (const s of statuses) {
    const who = s.provider ?? 'a node';
    const t = Number(s.time);
    const stale = now != null && !(t > now - HEAD_MAX_AGE_MS && t < now + 60_000);
    const no = s.error ? 'no answer' : namesOtherChain(s) ? 'names another chain' : s.catchingUp ? 'catching up' : !isHeight(s.height) ? 'an invalid height'
      : stale ? `newest block over ${HEAD_MAX_AGE_MS / 60_000} min old` : null;
    if (no) said.push(`${who}: ${no}`);
    else { nodes.push(s.height as number); said.push(`${who} ${s.height}`); }
  }
  const indexer = isHeight(indexerHeight) ? indexerHeight : null;
  said.push(indexer != null ? `indexer ${indexer}` : 'indexer: no answer');
  const all = indexer != null ? [...nodes, indexer] : nodes;
  const agreed = nodes.filter((h, i) => all.some((o, j) => j !== i && Math.abs(h - o) <= HEAD_AGREE_BLOCKS));
  const byNodes = nodes.some((h, i) => nodes.some((o, j) => j !== i && Math.abs(h - o) <= HEAD_AGREE_BLOCKS));
  if (agreed.length) return { head: Math.min(...agreed), top: Math.max(...agreed), note: null, byNodes };
  return { head: null, top: null, note: `${NO_AGREED_HEAD} (${said.join('; ')})`, byNodes: false };
}

/** How listingHeads' note begins when no two answers agree on a head: no listing is read that tick (cron.ts recordListingFailure). */
export const NO_AGREED_HEAD = 'no two answers agree on the head';
/** How chainHead's note begins when no node is at the head: the scan waits then (cron.ts liveScanRow reads a note stored before notes had a kind by it). */
export const NO_NODE_AT_HEAD = "no Namada node is at the chain's head";
/** Two nodes at the chain's head are at most this many blocks apart (about twelve minutes of blocks); further apart, one of them is not at it. */
export const HEAD_AGREE_BLOCKS = 100;
/** A node whose newest block is older than this is not at the head, whatever catching_up says (Namada makes a block about every 7 s). */
export const HEAD_MAX_AGE_MS = 5 * 60_000;
/** A block height past this is not a height (the bound cron.ts MAX_REASONABLE_HEIGHT puts on a listing's height). */
const MAX_HEAD_HEIGHT = 1_000_000_000;
/** A vote counts only when it was stored this recently (the cron stores it every minute). */
export const HEAD_VOTE_MAX_AGE_MS = 3 * 60_000;
/** About how long Namada takes to make a block: a vote is moved on by the blocks made since it was stored. */
const HEAD_BLOCK_MS = 7000;
/**
 * Faster than the chain makes blocks (about one every 6.8 s): how far a head may have moved on since the last one two
 * answers agreed on, so an honest node is always within it (headBound).
 */
export const HEAD_BOUND_BLOCK_MS = 5000;

/** What chainHead reads of one node's status (namadaStatusAll's answer for it). */
export interface NodeStatus { provider: string; error?: string; network?: string; height?: number; time?: number; catchingUp?: boolean }
/** A third answer about the head: the indexer's latest block as the cron stored it (`height`), and when (`at`). */
export interface HeadVote { height: number; at: number }
export interface ChainHead {
  /** the height to follow; null when no node's answer shows it is at this chain's head, or none can be followed */
  height: number | null;
  /** the nodes the chain is read from: those whose answer shows they are at the head followed, in RPCS order */
  rpcs: Rpc[];
  /** why no node is followed, or that the nodes disagree on the head; null when the nodes followed agree */
  note: string | null;
  /** Two answers agree on the head within HEAD_AGREE_BLOCKS: two nodes, or one node and the vote (it is then kept as the last agreed head). */
  agreed: boolean;
  /**
   * Two nodes agree on the head (not one node and the vote): only such a head may move the scan's cursor back or let it
   * jump blocks. One node and the indexer can both be behind, or one node a little ahead of a lagging indexer.
   */
  byNodes: boolean;
  /** Two or more nodes counted and did not agree (honest nodes at the head never do): the head followed is the lowest. */
  disputed: boolean;
}

/**
 * The highest head one node's word may take the scan to: the last head two answers agreed on (`last`), moved on by a
 * block every HEAD_BOUND_BLOCK_MS since, and HEAD_AGREE_BLOCKS more. null when no head was ever agreed on.
 */
export function headBound(last: { height: number; at: number } | null, now: number): number | null {
  return last ? last.height + Math.max(0, Math.floor((now - last.at) / HEAD_BOUND_BLOCK_MS)) + HEAD_AGREE_BLOCKS : null;
}
/**
 * Where the honest chain is at least, by the last head two answers agreed on: moved on by a block every HEAD_BLOCK_MS
 * (a little slower than the chain), so an honest node is at or above it. null when no head was ever agreed on.
 */
export function headSince(last: { height: number; at: number } | null, now: number): number | null {
  return last ? last.height + Math.max(0, Math.floor((now - last.at) / HEAD_BLOCK_MS)) : null;
}

/**
 * The head the live scan follows, from every node's status. A node counts only when its answer shows it is at this
 * chain's head: it names NAMADA.chainId, is not catching up, gives a height that is a height, and its newest block
 * is from the last HEAD_MAX_AGE_MS. When two or more are within HEAD_AGREE_BLOCKS of another (agreed, byNodes), the
 * head is the LOWEST of them: a height every one of them says the chain has reached, so a node that says it is a
 * little ahead is never the only source of a block; a counted node far from every one of them is not at the head, is
 * not read from, and the note names it. Otherwise (no two nodes that near, or only one node counts) the
 * `vote` decides when it is from the last HEAD_VOTE_MAX_AGE_MS: the lowest node within HEAD_AGREE_BLOCKS of it,
 * allowing for the blocks made since, is followed as agreed, no higher than the vote itself. With no such vote
 * nothing says which node is right: the head is the lowest node at or above the scan's place less HEAD_AGREE_BLOCKS
 * and at or under `bound` (headBound: as far as the chain can have gone since the last agreed head), read only from
 * the nodes near it. The scan's place is its `cursor`, or `since` (headSince: where the last agreed head says the
 * honest chain is at least) when that is lower: a cursor one node's word moved on cannot leave the honest node out.
 * So a node far below can neither take the scan back nor hold it, and a node far above where the chain can be is
 * never followed. `loneBound` caps a node that is the only one counted (the live scan's: as far as the lower node of
 * the last disagreement has had time to reach). When no node is within those, the head is null and the scan waits.
 * The note says which happened.
 */
export function chainHead(statuses: NodeStatus[], now: number, cursor = 0, vote: HeadVote | null = null, bound: number | null = null, since: number | null = null, loneBound: number | null = null): ChainHead {
  const why: string[] = [];
  const at: { rpc: Rpc; height: number }[] = [];
  for (const r of RPCS) {
    const s = statuses.find((x) => x.provider === r.provider);
    const h = Number(s?.height), t = Number(s?.time);
    const no = !s ? 'no answer'
      : s.error ? 'no answer'
      : s.network !== NAMADA.chainId ? `names another network than ${NAMADA.chainId}`
      : s.catchingUp ? 'catching up'
      : !Number.isInteger(h) || h <= 0 || h > MAX_HEAD_HEIGHT ? 'an invalid height'
      : !(t > now - HEAD_MAX_AGE_MS && t < now + 60_000) ? `newest block not from the last ${HEAD_MAX_AGE_MS / 60_000} minutes`
      : null;
    if (no) why.push(`${r.provider}: ${no}`);
    else at.push({ rpc: r, height: h });
  }
  if (!at.length) return { height: null, rpcs: [], note: `${NO_NODE_AT_HEAD} (${why.join('; ')})`, agreed: false, byNodes: false, disputed: false };
  const names = (rpcs: Rpc[]) => rpcs.map((r) => r.provider).join(' and ');
  const split = at.length > 1 ? `the Namada nodes disagree on the head (${at.map((a) => `${a.rpc.provider} ${a.height}`).join(', ')})` : null;
  // The nodes within HEAD_AGREE_BLOCKS of another counted node agree on the head: the lowest of them, a height every
  // one of them says the chain has reached. A counted node far from every other (behind, with a newest block it says
  // is fresh, or far ahead) is not at the head: it is not read from, and the note names it. With two nodes this is
  // "both within HEAD_AGREE_BLOCKS of each other"; with three (since 2026-11-07) two agreeing nodes win over the third.
  const agreeing = at.filter((a, i) => at.some((o, j) => j !== i && Math.abs(a.height - o.height) <= HEAD_AGREE_BLOCKS));
  if (agreeing.length) {
    const h = Math.min(...agreeing.map((a) => a.height));
    const out = at.filter((a) => !agreeing.includes(a));
    const note = out.length ? `${split}: the scan follows ${names(agreeing.map((a) => a.rpc))}, which agree, and not ${names(out.map((a) => a.rpc))}` : null;
    return { height: h, rpcs: agreeing.map((a) => a.rpc), note, agreed: true, byNodes: true, disputed: false };
  }
  const near = (h: number) => at.filter((a) => Math.abs(a.height - h) <= HEAD_AGREE_BLOCKS).map((a) => a.rpc);
  // The vote, moved on by the blocks made since it was stored.
  const vh = Number(vote?.height), vt = Number(vote?.at);
  const voteNow = Number.isInteger(vh) && vh > 0 && vh <= MAX_HEAD_HEIGHT && vt > now - HEAD_VOTE_MAX_AGE_MS && vt < now + 60_000
    ? vh + Math.max(0, Math.floor((now - vt) / HEAD_BLOCK_MS)) : null;
  const vouched = voteNow == null ? [] : at.filter((a) => Math.abs(a.height - voteNow) <= HEAD_AGREE_BLOCKS);
  if (vouched.length) {
    // The vote is a little behind the chain (the indexer follows it): no higher than it, so a node up to
    // HEAD_AGREE_BLOCKS above it is never the only source of blocks the vote has not seen.
    const h = Math.min(...vouched.map((a) => a.height), voteNow!);
    return { height: h, rpcs: near(h), note: split && `${split}: the scan follows ${names(near(h))}, which the indexer's latest block agrees with`, agreed: true, byNodes: false, disputed: at.length > 1 };
  }
  const place = since != null ? Math.min(cursor, since) : cursor;
  const cap = at.length === 1 && loneBound != null ? (bound == null ? loneBound : Math.min(bound, loneBound)) : bound;
  const ok = at.filter((a) => a.height >= place - HEAD_AGREE_BLOCKS && (cap == null || a.height <= cap));
  if (!ok.length) {
    const above = cap != null && at.some((a) => a.height > cap);
    const where = above ? `above ${cap}, past where the chain can be by the last agreed head and the indexer's latest block` : `more than ${HEAD_AGREE_BLOCKS} blocks below the scan's cursor ${cursor}`;
    const why = split
      ? `${split}, none within reach (${where})`
      : `the only Namada node at the head (${at[0].rpc.provider} ${at[0].height}) is ${where}, and no second answer agrees with it`;
    return { height: null, rpcs: [], note: `${why}: the scan waits`, agreed: false, byNodes: false, disputed: at.length > 1 };
  }
  const h = Math.min(...ok.map((a) => a.height));
  return { height: h, rpcs: near(h), note: split && `${split}: the scan follows ${names(near(h))}, the lowest not far below its cursor, and neither moves back nor jumps`, agreed: false, byNodes: false, disputed: at.length > 1 };
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

/**
 * The status of the first node that answers: a down node is never the reason the next is not asked. Its height is
 * not checked against the chain or the other nodes; the live scan follows chainHead instead.
 */
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
    // Each header names its chain: an answer with a block of another chain counts as no answer, so the next node is asked.
    if ((v.result.block_metas as any[]).some((m) => m?.header?.chain_id !== NAMADA.chainId)) throw new Error(`blockchain ${min}-${max}: a block of another chain`);
    return v;
  }, opts);
  return (value.result.block_metas as any[]).map((m) => ({
    height: Number(m.header.height),
    ts: Date.parse(m.header.time),
    numTxs: Number(m.num_txs),
  }));
}

/**
 * A block's answers may be as large as a listing (util.ts FETCH_TEXT_MAX_BYTES, what the isolate is known to hold): the
 * chain allows 16 MiB blocks (consensus max_bytes on 2026-10-22), though its blocks are usually a few KB. A node whose
 * answer is past it fails the read and the next node is asked.
 */
const BLOCK_READ_MAX_BYTES = FETCH_TEXT_MAX_BYTES;

export async function blockResults(height: number, ts: number, opts: ReadOpts = {}): Promise<NamadaBlock> {
  const { value } = await rpcRead(async (b) => {
    const v = await fetchJson(`${b}/block_results?height=${height}`, { timeoutMs: opts.timeoutMs ?? 30000, retries: opts.retries, signal: opts.signal, maxBytes: BLOCK_READ_MAX_BYTES });
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
    const v = await fetchJson(`${b}/block?height=${height}`, { timeoutMs: opts.timeoutMs ?? 30000, retries: opts.retries, signal: opts.signal, maxBytes: BLOCK_READ_MAX_BYTES });
    if (!Array.isArray(v?.result?.block?.data?.txs)) throw new Error(`block ${height}: no txs array in /block response`);
    return v;
  }, opts);
  return value.result.block.data.txs as string[];
}

/** Heights (with block time) that emitted token/transfer events within [lo, hi]: a search of a node's event index, so only a node that has one is asked. */
export async function transferHeights(lo: number, hi: number, page = 1, perPage = 100, rpcs: readonly Rpc[] = RPCS) {
  const q = encodeURIComponent(`"token/transfer.height>=${lo} AND token/transfer.height<=${hi}"`);
  const { value } = await withFailover(indexedRpcs(rpcs), (b) =>
    fetchJson(`${b}/block_search?query=${q}&page=${page}&per_page=${perPage}&order_by="asc"`, { timeoutMs: 120000, retries: 2, maxBytes: BLOCK_READ_MAX_BYTES }),
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

/**
 * The node answered, with an error code: an answer about the query (no such bond, no such path), not a failure. `said`
 * is the path as the message names it (abci: its addresses cut, so a health note keeps the reason).
 */
export class AbciCodeError extends Error {
  readonly path: string;
  readonly code: number;
  constructor(path: string, code: number, info: string, said = path) { super(`abci ${said} code ${code}: ${info}`); this.path = path; this.code = code; }
}

/** What an ABCI answer's response holds (result.response). */
interface AbciResponse { code?: number | string; value?: string | null; height?: string | number; info?: string; log?: string }

/**
 * One ABCI query, asked of each node in turn (the breaker's order when one is given). `opts.rpcs` given empty (the
 * cron's answeringRpcs when every node names another chain) leaves no node to ask. `accept`, when given, is asked of
 * each node's response: a reason it gives refuses that node's answer as no answer, so the node is put last and the
 * next node is asked (an epoch answer that is not an epoch, namadaEpoch; a protocol balance without a value,
 * namProtocolBalance). `height`, when given, asks for the state at that block (Namada answers a key's value at a past
 * block within the nodes' state window, about 3,600 blocks; /shell/epoch does not take one), and an answer for
 * another block is refused at its node the same way.
 */
async function abci(path: string, opts: ReadOpts = {}, accept?: (resp: AbciResponse) => string | null, height?: number) {
  const at = height != null ? `&height=${height}` : '';
  const run = (b: string) =>
    fetchJson(`${b}/abci_query?path=${encodeURIComponent(`"${path}"`)}${at}`, { timeoutMs: opts.timeoutMs ?? 15000, retries: opts.retries, signal: opts.signal });
  const base = opts.rpcs ?? RPCS;
  const list = opts.breaker ? opts.breaker.order(base) : base;
  // the path as every error below names it, each address cut to its first ten characters (the protocol accounts stay
  // apart), so a health note's 160 characters keep the reason after a balance key's three addresses
  const said = path.replace(/tnam1[02-9ac-hj-np-z]{10,}/g, (a) => `${a.slice(0, 10)}…`);
  let value: any, provider = '';
  let lastErr: unknown;
  for (const r of list) {
    if (opts.signal?.aborted) break;
    try {
      const v = await run(r.url);
      // An answer without a response (a JSON-RPC error, a proxy's page) is no answer: the next node is asked, as
      // rpcRead and abciListing do. An answer with an error code is an answer and is returned as one below.
      if (!v?.result?.response) throw new Error(`abci ${said}: answer without a response`);
      const answered = Number(v.result.response.height || 0);
      const refused = accept?.(v.result.response) ?? (height != null && answered !== height ? `answered for block ${answered}, not ${height}` : null);
      if (refused) throw new Error(`abci ${said}: ${r.provider} ${refused}`);
      value = v; provider = r.provider; break;
    } catch (e) {
      lastErr = e;
      // A read cut by the tick's own deadline says nothing about the node.
      if (!opts.signal?.aborted) opts.breaker?.failed(r.provider);
    }
  }
  if (!provider) throw lastErr ?? new Error(list.length ? `abci ${said}: deadline passed` : `abci ${said}: no node on this chain to ask`);
  const resp = value.result.response;
  if (resp.code && resp.code !== 0) throw new AbciCodeError(path, Number(resp.code), String(resp.info || resp.log || ''), said);
  return { value: resp.value as string | null, height: Number(resp.height || 0), provider };
}

/** What a listing read answers: the ABCI value with the node, height, bytes and time of the read. */
export interface ListingAnswer { value: string | null; height: number; provider: string; bytes: number; readMs: number }

/**
 * The most a listing's value can decode to under the read's cap (util.ts FETCH_TEXT_MAX_BYTES): base64 carries 3 bytes
 * in 4 characters, so 12 MiB, about 127,100 balance keys of 99 bytes. On 2026-10-22 the balance listing decoded to
 * 8,989,296 bytes (90,802 keys, 71%) and the bond listing to 4,027,905. The cap is not raised: the read holds the
 * answer several times over, and the apply holds every key and every stored row (about 450 bytes of heap a key).
 */
export const LISTING_MAX_VALUE_BYTES = (FETCH_TEXT_MAX_BYTES / 4) * 3;

/** Every node asked answered past the read's cap: the chain's listing has outgrown the reader, and asking again will not change that. */
export class ListingTooLargeError extends Error {}

/**
 * One multi-megabyte ABCI answer, read by streaming (util.ts fetchText) so a read cut short says how much arrived:
 * one attempt per node, each with the whole `timeoutMs` for its stream, the nodes that failed a read this tick
 * asked last (the breaker's order). A node that streams slowly and is cut (ReadCutError) answers; it is not "no
 * answer" and is not marked failed; an HTTP error, a malformed answer or a dropped connection is. When every node
 * fails, the error names each node's outcome ("5ElementsNodes: timeout: 4.2 MB of 12.0 MB arrived in 180 s
 * (first byte after 5.8 s); Papadritta: …"). An answer past the read's cap is the chain's size, not the node's
 * failure: the node is not marked failed, and the next node is still asked (one node could pad its answer); when
 * every node asked answered past it, the error is a ListingTooLargeError.
 */
async function abciListing(path: string, opts: ReadOpts = {}): Promise<ListingAnswer> {
  const base = opts.rpcs?.length ? opts.rpcs : RPCS;
  const list = opts.breaker ? opts.breaker.order(base) : base;
  const notes: string[] = [];
  let tooLarge = 0;
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
      const cut = e instanceof ReadCutError && (e.message.startsWith('timeout') || e.message.startsWith('deadline'));
      const big = e instanceof ReadCutError && e.message.startsWith('response too large');
      if (big) tooLarge++;
      if (!cut && !big && !opts.signal?.aborted) opts.breaker?.failed(r.provider);
      notes.push(`${r.provider}: ${e instanceof ReadCutError ? e.message : String(e instanceof Error ? e.message : e).slice(0, 120)}`);
    }
  }
  const message = notes.join('; ') || `abci ${path}: no node to ask`;
  if (tooLarge > 0 && tooLarge === notes.length) throw new ListingTooLargeError(message);
  throw new Error(message);
}

/** The NAM balance key of an owner. */
const namBalanceKey = (owner: string) => `/shell/value/#${NAMADA.multitoken}/#${NAM.namadaToken}/balance/#${owner}`;

/**
 * Why an answer is not a value of `bytes` bytes, or null when it is: no value (Namada answers a key it holds nothing
 * for with code 0, no value and "No value found for key …", which decodes to 0), or a value of another length. An
 * error code is not judged here: abci throws it as an answer about the query.
 */
const notBytes = (bytes: number, what: string) => (resp: AbciResponse): string | null => {
  if (resp.code && Number(resp.code) !== 0) return null;
  if (!resp.value) return 'answered without a value';
  let n = -1;
  try { n = atob(resp.value).length; } catch { /* not base64 */ }
  return n === bytes ? null : `answered a value that is not ${what}`;
};
/** A token::Amount: 32 bytes little-endian. */
const notAnAmount = notBytes(32, 'an amount');

/**
 * Live NAM balance (base units) of a Namada address. A key with no value reads as 0: an address that never held NAM
 * has none. The protocol accounts and the minted total are read with namProtocolBalance and namTotalSupply instead.
 */
export async function namBalance(owner: string, opts: ReadOpts = {}) {
  const r = await abci(namBalanceKey(owner), opts);
  return { balance: decodeU256LE(r.value), height: r.height, provider: r.provider };
}

/**
 * The NAM balance (base units) of a protocol account (the staking account, the bridge escrow, the shielded pool,
 * public funding), which the chain always holds. An answer without a value, or with one that is not an amount, is
 * refused at its node, so the next node is asked; when every node answers so the read fails and the cron stores
 * the balance as not read, never as 0 (a 0 would raise the transparent NAM it derives from these four, cron.ts
 * supply.liquid, while the partition check still passed).
 */
export async function namProtocolBalance(owner: string, opts: ReadOpts = {}) {
  const r = await abci(namBalanceKey(owner), opts, notAnAmount);
  return { balance: decodeU256LE(r.value), height: r.height, provider: r.provider };
}

/**
 * The shielded pool's balance of a coin other than NAM (base units as the chain writes them, exact as a string), read
 * from the multitoken balance key with the coin's own token address in NAM's place (masp-coins.ts, the daily
 * confirmation of each coin kv masp.coins names). An answer without a value, or with one that is not an amount, is
 * refused at its node and the next node is asked, as for namProtocolBalance: the chain writes the key with the value 0
 * when a balance reaches 0 (block 6,966,497's transfer event reports the pool's post-balance '0' for Noble USDC), so an
 * answer with no value is a node without the key, not a 0 to store. When every node answers so the read fails, the
 * day's row keeps the hub's last post-balance with basis 'post-balance', and the coin is asked again next hour, never
 * every tick (series.ts daily(), part 'shielded coins').
 */
export async function maspCoinBalance(token: string, opts: ReadOpts = {}) {
  if (!/^tnam1[02-9ac-hj-np-z]{10,}$/.test(token)) throw new Error('masp coin balance: not a token address');
  const r = await abci(`/shell/value/#${NAMADA.multitoken}/#${token}/balance/#${NAMADA.internal.masp}`, opts, notAnAmount);
  return { base: decodeU256LE(r.value).toString(), height: r.height, provider: r.provider };
}

/**
 * The minted total of NAM (base units), with the node and block that answered. The chain always holds it, so an
 * answer without a value is refused at its node and the next node is asked, as for namProtocolBalance.
 */
export async function namTotalSupply(opts: ReadOpts = {}) {
  const r = await abci(`/shell/value/#${NAMADA.multitoken}/#${NAM.namadaToken}/balance/minted`, opts, notAnAmount);
  return { supply: decodeU256LE(r.value), height: r.height, provider: r.provider };
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

/**
 * Why an /shell/epoch response is not an epoch, or null when it is one: an error code, no value (it would decode to
 * 0, and the cron's health would call the read ok), or a value that is not 8 bytes (a borsh u64) of an epoch above 0.
 */
function notAnEpoch(resp: AbciResponse): string | null {
  if (resp.code && Number(resp.code) !== 0) return `answered code ${resp.code}${resp.info || resp.log ? `: ${String(resp.info || resp.log).slice(0, 80)}` : ''}`;
  if (!resp.value) return 'answered without a value';
  let bytes = -1;
  try { bytes = atob(resp.value).length; } catch { /* not base64 */ }
  if (bytes !== 8) return 'answered a value that is not an epoch';
  if (!(decodeU64LE(resp.value) > 0)) return 'answered epoch 0';
  return null;
}

/**
 * The chain's current epoch. A node whose answer is not an epoch (notAnEpoch) is refused at that node, so the next
 * node is asked: one node answering without a value must not leave the tick without an epoch (the bond listing and
 * the stake sample need it) while the other node has it.
 */
export async function namadaEpoch(opts: ReadOpts = {}) {
  return (await namadaEpochRead(opts)).epoch;
}

/**
 * The chain's current epoch as namadaEpoch reads it, with the node and block that answered: the cron's mint rule
 * judges a minted total only against an epoch read at the same block (/shell/epoch answers only for the latest block).
 */
export async function namadaEpochRead(opts: ReadOpts = {}) {
  const r = await abci('/shell/epoch', opts, notAnEpoch);
  return { epoch: decodeU64LE(r.value), height: r.height, provider: r.provider };
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
// malformed answer whole, so nothing is ever half-applied. The per-minute cron tick reads one listing at a time
// (the bond listing every BOND_LISTING_MS, the balance listing every BALANCE_LISTING_MS, never both in a tick):
// the read starts with the tick and has LISTING_TIMEOUT_MS a node (35 s; measured 2026-10-20: 3.5 s at best,
// 28 s and 45 s at worst), and a read that does not land backs off and is reported (cron.ts listingDue,
// listingOverdue).

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
// one table for both readers (parse/namada-tx.ts INTERNAL_ADDRESSES, from Namada's own enum): the one kept here had
// ReplayProtection and TempStorage's raw discriminants swapped (15 and 16), which no listing ever named
const INTERNAL_DISCRIMINANT = INTERNAL_ADDRESSES.map((v) => v.raw);
const INTERNAL_WITH_HASH = new Set(INTERNAL_ADDRESSES.flatMap((v, i) => (v.data ? [i] : [])));

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
  /** A borsh Vec<u8> (u32 length + the bytes): a view into the answer, bounds-checked like every read. */
  bytes() { return this.take(this.u32()); }
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
  /** keys in the answer (entries + internal + the minted key, each once: an answer that lists a key twice is refused) and the answer's decoded size */
  keys: number;
  bytes: number;
}

/**
 * Decode a /shell/prefix/#<multitoken>/#<NAM>/balance answer: borsh Vec<PrefixValue { key: Key { segments:
 * Vec<DbKeySeg> }, value: Vec<u8> }>, DbKeySeg 0 = AddressSeg(Address), 1 = StringSeg(String). Every key must be
 * exactly [multitoken, NAM, "balance", owner] (owner an address, or the string "minted") with a 32-byte Amount
 * value; anything else, and any answer that ends early or has bytes left over, throws. So does a key listed twice:
 * a prefix read of the chain's storage gives each key once, and an answer that repeats keys would carry a key count
 * the chain does not have (cron.ts balanceGate checks the next answers' counts against it).
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
    const into = !owner ? null : owner.internal ? internal : entries;
    if (into ? into.has(owner!.address) : minted != null) throw new Error(`balance listing: key ${i} (${owner ? owner.address : 'minted'}) is listed twice`);
    if (!into) minted = amount;
    else into.set(owner!.address, amount);
  }
  if (!b.done) throw new Error(`balance listing: ${bytes.length - b.offset} unread bytes`);
  return { entries, internal, minted, keys: entries.size + internal.size + (minted == null ? 0 : 1), bytes: bytes.length };
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
  /**
   * Entries whose source is an internal address (a protocol account: the staking account, the shielded pool, the
   * bridge escrow, public funding, governance, the multitoken account, or any other variant of Namada's enum), kept
   * apart from `sources` so no protocol account is ever written as a staker, and counted in the totals above as the
   * chain lists them. Empty on every listing read so far (v201.0.12 rejects bonds from internal addresses); the
   * bond_sources check (cron.ts bondSourcesCheck) says so, or names what it found. Sorted by address. Absent only
   * in a listing built without the parser.
   */
  internalSources?: InternalBondSource[];
}

/** A protocol account the bond listing names as a source, with its bonds net of slashing and its unbonds (base units). */
export interface InternalBondSource { address: string; bondedBase: bigint; grossBase: bigint; slashedBase: bigint; unbondingBase: bigint }

/**
 * Decode a /vp/pos/bonds_and_unbonds/to answer (every bond on the chain; the per-validator variant
 * …/to/<validator> has the same layout): borsh HashMap<BondId { source, validator }, Detail { bonds: Vec<{ start
 * u64, amount Amount, slashed Option<Amount> }>, unbonds: Vec<{ start u64, withdraw u64, amount, slashed Option }>,
 * slashes: Vec<{ epoch u64, block u64, type u8, rate Amount }> }>, count first. A bond or unbond entry's `slashed`
 * is what a slash took from its `amount`, so net stake is amount − slashed (on 2026-10-20: 268,038,299 NAM gross, of
 * which 860,517 NAM slashed, against a total stake of 267,175,777 NAM; the 2,006 NAM left over are bonds still in
 * the pipeline, listed before they count). Throws on a cut or malformed answer, on an internal address as validator,
 * and on a source × validator entry listed twice (the chain's map has each once; a repeat would only inflate the
 * counts the next answers are checked against, cron.ts bondGate). An internal address as source is read like any
 * other and kept in `internalSources`, never in `sources` (bond_sources check, 2026-11-07; before, such a listing
 * was refused whole, so the check could never have seen one).
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
  const internal = new Set<string>();
  const n = b.u32();
  let gross = 0n, slashed = 0n, unbondGross = 0n, unbondSlashed = 0n;
  let entriesWithUnbonds = 0, entriesWithSlashes = 0;
  for (let i = 0; i < n; i++) {
    const source = b.address();
    const validator = b.address();
    if (validator.internal) throw new Error(`bond listing: entry ${i} names an internal address as validator`);
    if (source.internal) internal.add(source.address);
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

    if (src.byValidator.has(validator.address)) throw new Error(`bond listing: entry ${i} (${source.address} to ${validator.address}) is listed twice`);
    src.byValidator.set(validator.address, { gross: g, slashed: sl });
    gross += g; slashed += sl;
  }
  if (!b.done) throw new Error(`bond listing: ${bytes.length - b.offset} unread bytes`);
  const out = new Map<string, BondedSource>();
  const internalSources: InternalBondSource[] = [];
  for (const [source, s] of sources) {
    let bondedBase = 0n, grossBase = 0n, slashedBase = 0n;
    const delegations: BondedSource['delegations'] = [];
    for (const [validator, v] of s.byValidator) {
      const net = v.gross - v.slashed;
      bondedBase += net; grossBase += v.gross; slashedBase += v.slashed;
      if (net > 0n) delegations.push({ validator, amountNam: Number(net) / 1e6 });
    }
    if (internal.has(source)) {
      internalSources.push({ address: source, bondedBase, grossBase, slashedBase, unbondingBase: s.uGross - s.uSlashed });
      continue;
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
  internalSources.sort((x, y) => (x.address < y.address ? -1 : x.address > y.address ? 1 : 0));
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
    internalSources,
  };
}

/** Every bond on the chain in one query (see parseBondListing), with the node and height that answered. */
export async function allBonds(opts: ReadOpts = {}): Promise<BondListing & ListingRead> {
  const r = await abciListing('/vp/pos/bonds_and_unbonds/to', opts);
  if (!r.value) throw new Error(`bond listing: empty answer from ${r.provider}`);
  if (!(r.height > 0)) throw new Error(`bond listing: answer without a height from ${r.provider}`);
  return { ...parseBondListing(r.value), height: r.height, provider: r.provider, readMs: r.readMs };
}

// ---------------------------------------------------------------- what the chain records of an epoch's mint
//
// The keys the cron's mint rule (cron.ts mintRuleNext) compares a step of the minted total with, read at the block it
// judges. In Namada's source (proof_of_stake rewards.rs apply_inflation, governance pgf/inflation.rs, the shell's
// finalize_block) the minted total changes only at an epoch's first block: by the staking inflation, which it writes
// to the staking account's last_inflation_amount; by the public-funding and steward inflation, each its rate × the
// effective supply ÷ epochs per year (both rates read 0 on 2026-11-02); and, when the epoch also starts a
// shielded-reward epoch (epoch % masp_epoch_multiplier == 0), by the shielded rewards credited to the shielded pool's
// own NAM. Each key answered rpc-namada.5elementsnodes.com at a past block on 2026-11-02.

/** Namada's parameters account (InternalAddress::Parameters), from the enum table both readers share. */
function parametersAddress(): string {
  const v = INTERNAL_ADDRESSES.find((a) => a.name === 'Parameters');
  if (!v) throw new Error('the internal address table has no Parameters account');
  const raw = new Uint8Array(21);
  raw[0] = v.raw;
  return encodeAddress(raw);
}

/** An error code from one node, refused there so the next node is asked (a node may not keep the block asked for). */
const orCode = (f: (resp: AbciResponse) => string | null) => (resp: AbciResponse): string | null =>
  resp.code && Number(resp.code) !== 0 ? `answered code ${resp.code}${resp.info || resp.log ? `: ${String(resp.info || resp.log).slice(0, 80)}` : ''}` : f(resp);
/** A borsh Dec (I256): 32 bytes. */
const notADec = notBytes(32, 'a decimal');
/** A borsh u64 above 0: 8 bytes. */
const notACount = (resp: AbciResponse): string | null => notBytes(8, 'a whole number')(resp) ?? (decodeU64LE(resp.value) > 0 ? null : 'answered 0');

/**
 * A borsh Dec (I256: 32 bytes little-endian, two's complement) with Namada's 12 decimal places (core dec.rs
 * POS_DECIMAL_PRECISION), as a decimal string ("0", "0.0275").
 */
export function decString(b64: string | null): string {
  let v = decodeU256LE(b64);
  const neg = v >> 255n === 1n;
  if (neg) v = (1n << 256n) - v;
  const s = v.toString().padStart(13, '0');
  const frac = s.slice(-12).replace(/0+$/, '');
  return `${neg ? '-' : ''}${s.slice(0, -12)}${frac ? `.${frac}` : ''}`;
}

/** What the chain records at a block about the mint at the start of that block's epoch (mintKeysAt). */
export interface MintKeys {
  /** the staking inflation minted at the epoch's first block (<staking account>/last_inflation_amount), base units */
  lastInflationBase: bigint;
  /** the public-funding and steward inflation rates (<public funding>/pgf_inflation_rate, steward_inflation_rate), decimals */
  pgfRate: string;
  stewardRate: string;
  /** epochs to a shielded-reward epoch (<parameters>/masp_epoch_multiplier) */
  maspEpochMultiplier: number;
  /** the block every key was read at, and the node that answered the inflation amount */
  height: number;
  provider: string;
}

/**
 * The mint keys at `height`, one after another (four single-key reads; the cron reads them only on a tick that sees
 * a new epoch). A node that answers for another block, with an error code (it no longer keeps the block) or with a
 * value of the wrong shape is refused there and the next node is asked; when no node answers, the read fails, and
 * the mint rule says the step was not read. Never a guess: every figure is the chain's.
 */
export async function mintKeysAt(height: number, opts: ReadOpts = {}): Promise<MintKeys> {
  const pgf = NAMADA.internal.pgf;
  const inflation = await abci(`/shell/value/#${NAMADA.internal.pos}/last_inflation_amount`, opts, orCode(notAnAmount), height);
  const pgfRate = await abci(`/shell/value/#${pgf}/pgf_inflation_rate`, opts, orCode(notADec), height);
  const stewardRate = await abci(`/shell/value/#${pgf}/steward_inflation_rate`, opts, orCode(notADec), height);
  const multiplier = await abci(`/shell/value/#${parametersAddress()}/masp_epoch_multiplier`, opts, orCode(notACount), height);
  return {
    lastInflationBase: decodeU256LE(inflation.value),
    pgfRate: decString(pgfRate.value),
    stewardRate: decString(stewardRate.value),
    maspEpochMultiplier: decodeU64LE(multiplier.value),
    height,
    provider: inflation.provider,
  };
}

// ---------------------------------------------------------------- single-key reads of the trust checks (2026-11-07)
//
// The pos_remainder check (cron.ts posRemainderNext) reads the staking account's NAM at the bond listing's own block,
// so a withdrawal between the listing and a read at the head never looks like a rise, and the staking inflation the
// chain recorded for that block's epoch. The masp_ledger check (cron.ts maspLedgerCheck) reads the chain's running
// total of shielded rewards and the shielded-reward epoch length at the head, once a day.

/**
 * A protocol account's NAM (base units) at `height`, as namProtocolBalance reads it at the head: an answer without a
 * value, with one that is not an amount, for another block or with an error code (a node that no longer keeps the
 * block: the nodes answer about 3,600 blocks back) is refused at its node and the next node is asked.
 */
export async function namProtocolBalanceAt(owner: string, height: number, opts: ReadOpts = {}) {
  const r = await abci(namBalanceKey(owner), opts, orCode(notAnAmount), height);
  return { balance: decodeU256LE(r.value), height: r.height, provider: r.provider };
}

/**
 * The staking inflation (base units) minted into the staking account at the first block of the epoch `height` is
 * in (<staking account>/last_inflation_amount, the key mintKeysAt reads), read at that block.
 */
export async function posLastInflationAt(height: number, opts: ReadOpts = {}) {
  const r = await abci(`/shell/value/#${NAMADA.internal.pos}/last_inflation_amount`, opts, orCode(notAnAmount), height);
  return { inflation: decodeU256LE(r.value), height: r.height, provider: r.provider };
}

/**
 * The chain's running total of the shielded rewards minted into the shielded pool (base units): the key under the
 * shielded pool's address that Namada's shielded-token storage names `max_total_rewards`, a token amount. Read at the
 * head only: the key is written without diffs, so a node answers it for no past block (2026-11-07, two public nodes:
 * 27,347,610.418808 NAM at the halt's last block, 8,517,986, and "No value found" 986 blocks back). The masp_ledger
 * check keeps its own daily readings and takes the rise between two of them.
 */
export async function maspTotalRewards(opts: ReadOpts = {}) {
  const r = await abci(`/shell/value/#${NAMADA.internal.masp}/max_total_rewards`, opts, notAnAmount);
  return { total: decodeU256LE(r.value), height: r.height, provider: r.provider };
}

/** Epochs to a shielded-reward epoch (<parameters>/masp_epoch_multiplier, the parameter mintKeysAt reads), at the head. */
export async function maspEpochMultiplier(opts: ReadOpts = {}) {
  const r = await abci(`/shell/value/#${parametersAddress()}/masp_epoch_multiplier`, opts, notACount);
  return { multiplier: decodeU64LE(r.value), height: r.height, provider: r.provider };
}

// ---------------------------------------------------------------- the bridge's channels (platform plan, release B)
//
// Namada's bridge is one account (NAMADA.internal.ibc) that holds every coin sent out over any channel. Which
// channels exist, and which chain each one leads to, is in the chain's own state under that account:
//   channelEnds/ports/transfer/channels/<channel>   a ChannelEnd: its state, the other side's port and channel, its connection
//                                                   (anyone may start a channel's handshake; only one that finished names its other side)
//   connections/<connection>                        a ConnectionEnd: the light client the connection rests on
//   clients/<client>/clientState                    an Any around that client's state, whose first field is the other chain's id
// each stored as the protobuf message itself. The first two are read as prefix listings (about 1 KB each on
// 2026-11-10, eight channels), the client states one key each (about 180 bytes): three reads plus one per chain.
// Checked against the node on 2026-11-10 at block 8,517,986 (test/fixtures/ibc_channels.json).

/** The most fields one message may have before it is refused (a channel has five, a client state about a dozen). */
const PB_FIELDS_MAX = 64;

/** The fields of one protobuf message, each read within the message's bytes: a field that runs past the end throws. */
function pbFields(buf: Uint8Array, what: string): { f: number; w: number; n: bigint; b: Uint8Array }[] {
  const out: { f: number; w: number; n: bigint; b: Uint8Array }[] = [];
  let i = 0;
  const varint = (): bigint => {
    let shift = 0n, v = 0n;
    for (;;) {
      if (i >= buf.length || shift > 63n) throw new Error(`${what}: a number runs past the end of the message`);
      const c = buf[i++];
      v |= BigInt(c & 0x7f) << shift;
      if (!(c & 0x80)) return v;
      shift += 7n;
    }
  };
  const NONE = new Uint8Array(0);
  while (i < buf.length) {
    // the messages read here have a handful of fields: a value made of very many is refused, not held in memory
    if (out.length >= PB_FIELDS_MAX) throw new Error(`${what}: more fields than a message of its kind has`);
    const key = varint();
    const f = Number(key >> 3n), w = Number(key & 7n);
    if (w === 0) out.push({ f, w, n: varint(), b: NONE });
    else if (w === 2) {
      const len = Number(varint());
      if (len > buf.length - i) throw new Error(`${what}: a field runs past the end of the message`);
      out.push({ f, w, n: 0n, b: buf.subarray(i, i + len) });
      i += len;
    } else if (w === 1 || w === 5) {
      const len = w === 1 ? 8 : 4;
      if (len > buf.length - i) throw new Error(`${what}: a field runs past the end of the message`);
      out.push({ f, w, n: 0n, b: buf.subarray(i, i + len) });
      i += len;
    } else throw new Error(`${what}: unknown wire type ${w}`);
  }
  return out;
}
const pbText = (fs: { f: number; w: number; b: Uint8Array }[], f: number): string | null => {
  const x = fs.find((y) => y.f === f && y.w === 2);
  return x ? new TextDecoder().decode(x.b) : null;
};

/** The ids the chain gives its channels, connections and clients: a word, a dash and a number (a client's has two parts), of bounded length. */
const IBC_ID = /^[a-z0-9]{1,32}(-[a-z0-9]{1,32}){0,3}-\d{1,10}$/;
/** A port's name on the other chain: what its voucher name is made from, so nothing but plain characters a port may have (a contract's port is `wasm.` and its address, 68 in all). */
const IBC_PORT = /^[A-Za-z0-9._+-]{1,128}$/;
/** The most transfer channels one listing may hold: an answer with more is refused, not walked. */
export const IBC_CHANNELS_MAX = 256;
/** The most bytes one listing under the bridge account may decode to: about fifty times the largest read (1 KB on 2026-11-10). A longer one is refused before it is walked. */
export const IBC_LISTING_MAX_BYTES = 64 * 1024;
/** The most client states one channel read asks for, and how many at once: the channels past these keep no chain. */
export const IBC_CLIENT_READS_MAX = 64;
const IBC_CLIENT_READS_AT_ONCE = 8;
/** The stored Any's type of the one kind of light client whose state this site reads the chain id from. */
const TENDERMINT_CLIENT = '/ibc.lightclients.tendermint.v1.ClientState';

/**
 * A prefix listing under the bridge account: every key as its string segments after the account, with the stored
 * bytes. borsh Vec<PrefixValue { key: Key { segments: Vec<DbKeySeg> }, value: Vec<u8> }>, as parseBalanceListing reads
 * it; the first segment must be the bridge account. Throws on a cut or malformed answer.
 */
function ibcPrefixEntries(value: string | null, what: string): { path: string[]; value: Uint8Array }[] {
  const bytes = base64Bytes(value ?? '');
  if (bytes.length > IBC_LISTING_MAX_BYTES) throw new Error(`${what}: ${bytes.length} bytes, more than this site reads`);
  const b = new Borsh(bytes);
  const out: { path: string[]; value: Uint8Array }[] = [];
  const n = b.u32();
  for (let i = 0; i < n; i++) {
    const segs = b.u32();
    if (segs < 2 || segs > 16) throw new Error(`${what}: key ${i} has ${segs} segments`);
    if (b.u8() !== 0 || b.address().address !== NAMADA.internal.ibc) throw new Error(`${what}: key ${i} is not under the bridge account`);
    const path: string[] = [];
    for (let k = 1; k < segs; k++) {
      if (b.u8() !== 1) throw new Error(`${what}: key ${i} has a segment that is not text`);
      path.push(b.string());
    }
    out.push({ path, value: b.bytes() });
  }
  if (!b.done) throw new Error(`${what}: ${bytes.length - b.offset} unread bytes`);
  return out;
}

/** One transfer channel as the chain's state names it. */
export interface IbcChannelEnd {
  /** Namada's id of the channel: channel-1. */
  channel: string;
  /** The channel is open on Namada's side (ChannelEnd.state 3). A channel in any other state carries no transfer. */
  open: boolean;
  /** The other chain's port and its id of the same channel: together with the coin's address they name the coin's voucher there. */
  counterpartyPort: string;
  counterpartyChannel: string;
  /** The connection the channel rests on (its one hop); null when the channel names none or more than one. */
  connection: string | null;
}

/**
 * Decode /shell/prefix/#<bridge>/channelEnds/ports/transfer/channels: every transfer channel that names its other
 * side, in the chain's own order, and how many were passed over because their other side is named in a form this
 * site does not read (`passed`: one odd channel must not cost the whole list). A channel whose handshake never
 * finished names no channel on the other chain: NAM cannot cross it and no voucher of it exists, so it is left out
 * and not counted (an open channel that names none is a malformed answer). Throws on a cut or malformed answer, a
 * key that is not a channel's, a channel listed twice, or more channels than IBC_CHANNELS_MAX.
 */
export function parseIbcChannelList(value: string | null): { ends: IbcChannelEnd[]; passed: number } {
  const entries = ibcPrefixEntries(value, 'channel listing');
  if (entries.length > IBC_CHANNELS_MAX) throw new Error(`channel listing: ${entries.length} channels, more than this site reads`);
  const out: IbcChannelEnd[] = [];
  const seen = new Set<string>();
  let passed = 0;
  for (const [i, e] of entries.entries()) {
    const p = e.path;
    if (p.length !== 5 || p[0] !== 'channelEnds' || p[1] !== 'ports' || p[2] !== 'transfer' || p[3] !== 'channels' || !IBC_ID.test(p[4])) throw new Error(`channel listing: key ${i} is not a transfer channel's`);
    if (seen.has(p[4])) throw new Error(`channel listing: ${p[4]} is listed twice`);
    seen.add(p[4]);
    const fs = pbFields(e.value, `channel ${p[4]}`);
    const open = (fs.find((x) => x.f === 1 && x.w === 0)?.n ?? 0n) === 3n;
    const cp = fs.find((x) => x.f === 3 && x.w === 2);
    const cfs = cp ? pbFields(cp.b, `channel ${p[4]} counterparty`) : [];
    const port = pbText(cfs, 1), chan = pbText(cfs, 2);
    if (!chan) {
      if (open) throw new Error(`channel listing: ${p[4]} is open and names no channel on the other side`);
      continue;
    }
    if (!port || !IBC_PORT.test(port) || !IBC_ID.test(chan)) { passed++; continue; }
    const hops = fs.filter((x) => x.f === 4 && x.w === 2).map((x) => new TextDecoder().decode(x.b));
    out.push({ channel: p[4], open, counterpartyPort: port, counterpartyChannel: chan, connection: hops.length === 1 && IBC_ID.test(hops[0]) ? hops[0] : null });
  }
  return { ends: out, passed };
}
/** The channels of parseIbcChannelList alone. */
export const parseIbcChannels = (value: string | null): IbcChannelEnd[] => parseIbcChannelList(value).ends;

/** Decode /shell/prefix/#<bridge>/connections: each connection's light client. Keys that are not a connection (the chain's counter) are passed over; a connection listed twice is a malformed answer. */
export function parseIbcConnections(value: string | null): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of ibcPrefixEntries(value, 'connection listing')) {
    const p = e.path;
    if (p.length !== 2 || p[0] !== 'connections' || !/^connection-\d{1,10}$/.test(p[1])) continue;
    const client = pbText(pbFields(e.value, p[1]), 1);
    if (!client || !IBC_ID.test(client)) throw new Error(`connection listing: ${p[1]} names no client`);
    if (out.has(p[1])) throw new Error(`connection listing: ${p[1]} is listed twice`);
    out.set(p[1], client);
  }
  return out;
}

/**
 * The id of the chain a light client follows: the first field of the client state inside the stored Any. Only the
 * one kind of client whose state has that field is read (TENDERMINT_CLIENT); any other kind, or a name that is not
 * a chain id's, throws.
 */
export function parseIbcClientChain(value: string | null): string {
  const any = pbFields(base64Bytes(value ?? ''), 'client state');
  if (pbText(any, 1) !== TENDERMINT_CLIENT) throw new Error('client state: not a kind of client this site reads');
  const inner = any.find((x) => x.f === 2 && x.w === 2);
  const chainId = inner ? pbText(pbFields(inner.b, 'client state'), 1) : null;
  if (!chainId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(chainId)) throw new Error('client state: it names no chain');
  return chainId;
}

/** A channel with the chain it leads to: `chainId` null when its connection or its client's state could not be read. */
export interface IbcChannel extends IbcChannelEnd { client: string | null; chainId: string | null }

const ibcKey = (rest: string) => `#${NAMADA.internal.ibc}/${rest}`;

/**
 * Every transfer channel of the chain with the chain each one leads to, read from one node at its newest block: the
 * channel listing, the connection listing, then one client state per channel's client (at most
 * IBC_CLIENT_READS_MAX of them, a few at a time). A channel whose client state cannot be read, or was not asked for,
 * keeps a null chain id (it is listed, and nothing is guessed for it); a failed listing throws. `passed`: the
 * channels left out because their other side is named in a form this site does not read.
 */
export async function ibcChannels(opts: ReadOpts = {}): Promise<{ channels: IbcChannel[]; height: number; provider: string; passed: number }> {
  const ch = await abci(`/shell/prefix/${ibcKey('channelEnds/ports/transfer/channels')}`, opts);
  const { ends, passed } = parseIbcChannelList(ch.value);
  const co = await abci(`/shell/prefix/${ibcKey('connections')}`, opts);
  const clientOf = parseIbcConnections(co.value);
  const clients = [...new Set(ends.map((e) => (e.connection ? clientOf.get(e.connection) ?? null : null)).filter((c): c is string => !!c))].slice(0, IBC_CLIENT_READS_MAX);
  // the client states a few together (a few hundred bytes each): the two listings above have shown the breaker which
  // node answers, so these go straight to it; one that fails leaves its channels listed without a chain
  const chainOf = new Map<string, string>();
  for (let i = 0; i < clients.length && !opts.signal?.aborted; i += IBC_CLIENT_READS_AT_ONCE) {
    await Promise.all(clients.slice(i, i + IBC_CLIENT_READS_AT_ONCE).map(async (c) => {
      try { chainOf.set(c, parseIbcClientChain((await abci(`/shell/value/${ibcKey(`clients/${c}/clientState`)}`, opts)).value)); } catch { /* listed without its chain */ }
    }));
  }
  const channels = ends.map((e): IbcChannel => {
    const client = e.connection ? clientOf.get(e.connection) ?? null : null;
    return { ...e, client, chainId: client ? chainOf.get(client) ?? null : null };
  });
  return { channels, height: ch.height, provider: ch.provider, passed };
}
