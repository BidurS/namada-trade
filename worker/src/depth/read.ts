// The depth reads (plan 1.2): every outside answer the minute uses, each returned as { value, url, at, height, bytes,
// ms, status } or { error, url, at }, counted against the minute's request cap (C2) and ended by the phase's signal.
// Hosts and paths are the ones the research read on 2026-10-29 (chain.txt): the chain node's JSON-RPC for one batch of
// abci queries at one height, the REST gateway for the fallback, the estimate, the taker fees and the order book's
// smart queries, the quote service for the pool list, the price list and the token metadata. Nothing here names a
// coin or a pool: the configuration passes them in.
import type { DepthConfig } from './config';
import { batchBody, decodePosition, decodePositionIndex, parseBatch, positionByIdQuery, positionIndexQuery, type AbciAnswer, type AbciQuery, type PositionWire } from './proto';
import { tickToPrice, type BookAsk, type BookBid, type ClPoolState, type ClRange } from './model';
import { bytesToBase64 } from '../util';
import type { DepthProv } from '../../../shared/depth';

export interface ReadOk<T> { value: T; url: string; at: number; height: number | null; bytes: number; ms: number; status: number }
export interface ReadErr { error: string; url: string; at: number; ms: number; status?: number }
export type Read<T> = ReadOk<T> | ReadErr;
export const isOk = <T>(r: Read<T> | null | undefined): r is ReadOk<T> => !!r && 'value' in r;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** The minute's request ledger: the cap, what was made, the bytes and the provenance list the answer carries. */
export class Requests {
  made = 0;
  refused = 0;
  bytes = 0;
  ms = 0;
  readonly prov: DepthProv[] = [];
  constructor(readonly max: number, readonly signal: AbortSignal | undefined, readonly fetchFn: FetchLike, readonly timeoutMs: number, readonly clock: () => number = Date.now) {}
  /** True when one more request may be made; false once the cap is reached (counted, so the health row can say so). */
  take(): boolean {
    if (this.made >= this.max) { this.refused++; return false; }
    this.made++;
    return true;
  }
  record(what: string, r: Read<unknown>) {
    this.ms += r.ms;
    if (isOk(r)) { this.bytes += r.bytes; this.prov.push({ what, url: r.url, at: r.at, height: r.height, bytes: r.bytes, status: r.status }); }
    else this.prov.push({ what, url: r.url, at: r.at, height: null, bytes: 0, status: r.status ?? r.error.slice(0, 40) });
  }
}

const CAP_REFUSED = 'not asked: the minute’s request cap was reached';
const te = new TextEncoder();
const heightOf = (res: Response): number | null => { const h = Number(res.headers.get('grpc-metadata-x-cosmos-block-height')); return Number.isFinite(h) && h > 0 ? h : null; };

/** One GET or POST, its body read as text and counted; the gateway's block-height header kept when sent. */
export async function readText(req: Requests, what: string, url: string, init?: RequestInit): Promise<Read<string>> {
  const at = req.clock();
  if (!req.take()) { const r: ReadErr = { error: CAP_REFUSED, url, at, ms: 0 }; req.record(what, r); return r; }
  const t0 = performance.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort('timeout'), req.timeoutMs);
  const onAbort = () => ctrl.abort('phase end');
  if (req.signal?.aborted) ctrl.abort('phase end'); else req.signal?.addEventListener('abort', onAbort);
  let r: Read<string>;
  try {
    const res = await req.fetchFn(url, { ...init, signal: ctrl.signal, headers: { Accept: 'application/json', ...(init?.headers ?? {}) } });
    const text = await res.text();
    const ms = Math.round(performance.now() - t0);
    r = res.ok ? { value: text, url, at, height: heightOf(res), bytes: te.encode(text).length, ms, status: res.status } : { error: `status ${res.status}`, url, at, ms, status: res.status };
  } catch (e) {
    r = { error: ctrl.signal.aborted ? String(ctrl.signal.reason ?? 'aborted') : String((e as Error)?.message ?? e).slice(0, 120), url, at, ms: Math.round(performance.now() - t0) };
  } finally {
    clearTimeout(timer);
    req.signal?.removeEventListener('abort', onAbort);
  }
  req.record(what, r);
  return r;
}

export async function readJson<T>(req: Requests, what: string, url: string, init?: RequestInit): Promise<Read<T>> {
  const r = await readText(req, what, url, init);
  if (!isOk(r)) return r;
  try { return { ...r, value: JSON.parse(r.value) as T }; } catch { return { error: 'not JSON', url: r.url, at: r.at, ms: r.ms, status: r.status }; }
}

// ---------------------------------------------------------------------------------------------------- the chain node (JSON-RPC)
export interface BatchAnswer extends AbciAnswer { read: Read<unknown> }

/**
 * Every query in as few POSTs as the node allows (config.read.rpcBatchMax a body), sent together; each answer carries
 * its POST's read record, so a pool's height is the height its batch answered at. A POST that fails gives every query
 * in it the error.
 */
export async function rpcBatch(req: Requests, cfg: DepthConfig, queries: AbciQuery[]): Promise<BatchAnswer[]> {
  const chunks: AbciQuery[][] = [];
  for (let i = 0; i < queries.length; i += cfg.read.rpcBatchMax) chunks.push(queries.slice(i, i + cfg.read.rpcBatchMax));
  const answers = await Promise.all(chunks.map(async (chunk) => {
    const r = await readText(req, `chain node: ${chunk.length} queries in one batch`, `${cfg.hosts.rpc}/`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: batchBody(chunk) });
    if (!isOk(r)) return chunk.map((): BatchAnswer => ({ code: -1, height: null, log: r.error, value: new Uint8Array(0), read: r }));
    try {
      return parseBatch(r.value, chunk.length).map((a): BatchAnswer => ({ ...a, read: r }));
    } catch (e) {
      const err: ReadErr = { error: `batch answer unreadable: ${String((e as Error)?.message ?? e).slice(0, 80)}`, url: r.url, at: r.at, ms: r.ms, status: r.status };
      return chunk.map((): BatchAnswer => ({ code: -1, height: null, log: err.error, value: new Uint8Array(0), read: err }));
    }
  }));
  return answers.flat();
}

/** A position as the hourly read keeps it: the chain's answer with the POST's height and time. */
export interface PositionRead extends PositionWire { height: number | null; at: number }

/**
 * The positions of the concentrated pools (plan 1.3 a): the pool-to-position index of each pool in one batch (beside
 * `extra` queries the caller wants at the same height), then PositionById in batches of the node's size. A pool whose
 * index did not answer is named in `missing` with the reason; a position that did not decode likewise.
 */
export async function readPositions(req: Requests, cfg: DepthConfig, poolIds: string[], extra: AbciQuery[] = []): Promise<{ positions: PositionRead[]; extra: BatchAnswer[]; missing: { pool: string; why: string }[]; indexHeight: number | null; ids: Record<string, string[]> }> {
  const answers = await rpcBatch(req, cfg, [...poolIds.map((id) => positionIndexQuery(id)), ...extra]);
  const missing: { pool: string; why: string }[] = [];
  const ids: Record<string, string[]> = {};
  let indexHeight: number | null = null;
  poolIds.forEach((pool, i) => {
    const a = answers[i];
    if (!a || a.code !== 0 || !isOk(a.read)) { missing.push({ pool, why: a && !isOk(a.read) ? a.read.error : `chain node code ${a?.code ?? -1}${a?.log ? `: ${a.log.slice(0, 60)}` : ''}` }); return; }
    try { ids[pool] = decodePositionIndex(a.value); indexHeight = indexHeight ?? a.height; } catch (e) { missing.push({ pool, why: `index unreadable: ${String((e as Error)?.message ?? e).slice(0, 60)}` }); }
  });
  const want = Object.entries(ids).flatMap(([pool, list]) => list.map((id) => ({ pool, id })));
  const byId = want.length ? await rpcBatch(req, cfg, want.map((w) => positionByIdQuery(w.id))) : [];
  const positions: PositionRead[] = [];
  want.forEach((w, i) => {
    const a = byId[i];
    if (!a || a.code !== 0 || !isOk(a.read) || !a.value.length) { missing.push({ pool: w.pool, why: `position ${w.id}: ${a && !isOk(a.read) ? a.read.error : a?.log || 'no value'}` }); return; }
    try { positions.push({ ...decodePosition(a.value), height: a.height, at: a.read.at }); } catch (e) { missing.push({ pool: w.pool, why: `position ${w.id} unreadable: ${String((e as Error)?.message ?? e).slice(0, 60)}` }); }
  });
  return { positions, extra: answers.slice(poolIds.length), missing, indexHeight, ids };
}

// ---------------------------------------------------------------------------------------------------- the REST gateway
const enc = encodeURIComponent;

/** The gateway's liquidity per tick range of one pool (the hourly invariant's one read). */
export async function readTickRanges(req: Requests, cfg: DepthConfig, poolId: string): Promise<Read<ClRange[]>> {
  const r = await readJson<{ liquidity: ClRange[] }>(req, `pool ${poolId} ranges (gateway)`, `${cfg.hosts.rest}/osmosis/concentratedliquidity/v1beta1/liquidity_per_tick_range?pool_id=${poolId}`);
  return isOk(r) ? { ...r, value: Array.isArray(r.value?.liquidity) ? r.value.liquidity : [] } : r;
}

/** A weighted or stable pool's own object from the chain (plan 1.3 c): weights, swap fee, scaling factors, as the gateway serves it. */
export interface GammPoolWire {
  '@type'?: string;
  id?: string;
  pool_params?: { swap_fee?: string; exit_fee?: string };
  pool_assets?: { token: { denom: string; amount: string }; weight: string }[];
  pool_liquidity?: { denom: string; amount: string }[];
  scaling_factors?: string[];
  total_weight?: string;
}
export async function readGammPool(req: Requests, cfg: DepthConfig, poolId: string): Promise<Read<GammPoolWire>> {
  const r = await readJson<{ pool: GammPoolWire }>(req, `pool ${poolId} parameters (gateway)`, `${cfg.hosts.rest}/osmosis/gamm/v1beta1/pools/${poolId}`);
  if (!isOk(r)) return r;
  return r.value?.pool ? { ...r, value: r.value.pool } : { error: 'no pool in the answer', url: r.url, at: r.at, ms: r.ms, status: r.status };
}
/** The concentrated-liquidity module's parameters (tick spacings, spread factors), which governance alone changes. */
export async function readClParams(req: Requests, cfg: DepthConfig): Promise<Read<Record<string, unknown>>> {
  const r = await readJson<{ params: Record<string, unknown> }>(req, 'concentrated-liquidity parameters (gateway)', `${cfg.hosts.rest}/osmosis/concentratedliquidity/v1beta1/params`);
  if (!isOk(r)) return r;
  return r.value?.params ? { ...r, value: r.value.params } : { error: 'no params in the answer', url: r.url, at: r.at, ms: r.ms, status: r.status };
}

/** A concentrated pool from the gateway, the fallback of plan 1.2 c: the pool object and its liquidity per tick range (two GETs). */
export async function readClPoolLcd(req: Requests, cfg: DepthConfig, poolId: string): Promise<{ pool: Read<ClPoolState>; ranges: Read<ClRange[]> }> {
  const [pool, ranges] = await Promise.all([
    readJson<{ pool: ClPoolState }>(req, `pool ${poolId} (gateway)`, `${cfg.hosts.rest}/osmosis/poolmanager/v1beta1/pools/${poolId}`),
    readJson<{ liquidity: ClRange[] }>(req, `pool ${poolId} ranges (gateway)`, `${cfg.hosts.rest}/osmosis/concentratedliquidity/v1beta1/liquidity_per_tick_range?pool_id=${poolId}`),
  ]);
  return {
    pool: isOk(pool) ? (pool.value?.pool ? { ...pool, value: pool.value.pool } : { error: 'no pool in the answer', url: pool.url, at: pool.at, ms: pool.ms, status: pool.status }) : pool,
    ranges: isOk(ranges) ? { ...ranges, value: Array.isArray(ranges.value?.liquidity) ? ranges.value.liquidity : [] } : ranges,
  };
}

/** The chain's own estimate for selling `amountBase` base units of the base coin in one pool (check 1). Base units of the counter coin. */
export async function readEstimate(req: Requests, cfg: DepthConfig, poolId: string, amountBase: bigint, outDenom: string): Promise<Read<bigint>> {
  const url = `${cfg.hosts.rest}/osmosis/poolmanager/v1beta1/${poolId}/estimate/single_pool_swap_exact_amount_in?pool_id=${poolId}&token_in=${amountBase}${enc(cfg.base.denom)}&token_out_denom=${enc(outDenom)}`;
  const r = await readJson<{ token_out_amount?: string }>(req, `chain estimate, pool ${poolId}`, url);
  if (!isOk(r)) return r;
  try { return { ...r, value: BigInt(r.value.token_out_amount ?? '') }; } catch { return { error: 'no token_out_amount', url: r.url, at: r.at, ms: r.ms, status: r.status }; }
}

/** The pair's taker fee (plan 1.2, kept an hour in kv depth.params). */
/**
 * A pair's taker fee, each way: the chain's fee depends on the coin put in (trading_pair_takerfee's denom_0). Read on
 * 2026-10-31 on two nodes: NAM in for OSMO 0.002, OSMO in for NAM 0.008 (a buy through 3368 or 3402 paid 0.8% of its
 * OSMO, the chain's own transfers to the taker-fee collector), NAM against Noble USDC 0.001 both ways. `sell` is NAM in
 * (the bid side), `buy` the counter coin in (the ask side). Two requests; a failed selling read is the read's error, a
 * failed buying read leaves `buy` null with its error, so the selling fee is kept.
 */
export async function readTakerFee(req: Requests, cfg: DepthConfig, counterDenom: string): Promise<Read<{ sell: number; buy: number | null; urlBuy: string; buyError?: string }>> {
  const one = async (d0: string, d1: string, what: string) => {
    const url = `${cfg.hosts.rest}/osmosis/poolmanager/v1beta1/trading_pair_takerfee?denom_0=${enc(d0)}&denom_1=${enc(d1)}`;
    const r = await readJson<{ taker_fee?: string }>(req, what, url);
    if (!isOk(r)) return r;
    const fee = Number(r.value.taker_fee);
    return Number.isFinite(fee) && fee >= 0 && fee < 1 ? { ...r, value: fee } : ({ error: 'no taker_fee', url: r.url, at: r.at, ms: r.ms, status: r.status } as ReadErr);
  };
  const sell = await one(cfg.base.denom, counterDenom, 'taker fee, selling');
  if (!isOk(sell)) return sell;
  const buy = await one(counterDenom, cfg.base.denom, 'taker fee, buying');
  if (!isOk(buy)) return { ...sell, value: { sell: sell.value, buy: null, urlBuy: buy.url, buyError: buy.error } };
  return { ...sell, value: { sell: sell.value, buy: buy.value, urlBuy: buy.url } };
}

// ---------------------------------------------------------------------------------------------------- the quote service
export async function readPoolList(req: Requests, cfg: DepthConfig): Promise<Read<unknown>> {
  return readJson<unknown>(req, 'pool list', `${cfg.hosts.sqs}/pools?filter[denom]=${enc(cfg.base.denom)}`);
}
export type PriceList = Record<string, Record<string, string | number>>;
export async function readPriceList(req: Requests, cfg: DepthConfig, denoms: string[]): Promise<Read<PriceList>> {
  const r = await readJson<PriceList>(req, 'price list', `${cfg.hosts.sqs}/tokens/prices?base=${denoms.map(enc).join(',')}`);
  if (isOk(r) && (!r.value || typeof r.value !== 'object' || Array.isArray(r.value))) return { error: 'not a price list', url: r.url, at: r.at, ms: r.ms, status: r.status };
  return r;
}
export type TokenMetaList = Record<string, { symbol?: string; decimals?: number }>;
export async function readTokenMeta(req: Requests, cfg: DepthConfig, denoms: string[]): Promise<Read<TokenMetaList>> {
  return readJson<TokenMetaList>(req, 'token metadata', `${cfg.hosts.sqs}/tokens/metadata?denoms=${denoms.map(enc).join(',')}`);
}

// ---------------------------------------------------------------------------------------------------- the order book contract
/**
 * One smart query of a contract through the gateway: the message base64 in the path, the answer's `data`. With `height`
 * the query is answered at that block (the gateway's x-cosmos-block-height request header; the public node served the
 * last 60 heights on 2026-10-30 and refused 120 back), so reads that must agree with each other, as the hourly book's
 * do, come from one state.
 */
export async function smartQuery<T>(req: Requests, cfg: DepthConfig, contract: string, msg: unknown, what: string, height: number | null = null): Promise<Read<T>> {
  const url = `${cfg.hosts.rest}/cosmwasm/wasm/v1/contract/${contract}/smart/${enc(bytesToBase64(te.encode(JSON.stringify(msg))))}`;
  const r = await readJson<{ data: T }>(req, what, url, height != null ? { headers: { 'x-cosmos-block-height': String(height) } } : undefined);
  if (!isOk(r)) return r;
  return { ...r, value: r.value?.data as T };
}
/** The contract's answer to orders_by_tick: the orders listed and the count of all the tick's orders in the bounds asked. */
interface OrdersWire { orders: OrderRow[]; count?: number }
/**
 * Every order resting at one tick, orders_by_tick in pages of `pageSize` from the last order id on until the list holds
 * the contract's `count` (the page cap is the contract's `limit`, so a tick with more orders than one page needs more
 * reads): a list that stays short of the count is an error, never a tick read as whole, since the fill check and the
 * owners list are only right when every order is there. The last page's read is the one returned, its height included;
 * when a height was asked for, pages answered at different heights (a gateway that did not keep to the pin) are an
 * error naming them, since the list would then describe no one state; the minute's unpinned reads take a block between
 * two pages as ordinary.
 */
export async function readTickOrders(req: Requests, cfg: DepthConfig, contract: string, tick: number, height: number | null = null, pageSize = 200): Promise<Read<OrderRow[]>> {
  const all: OrderRow[] = [];
  let start: number | null = null, firstHeight: number | null = null;
  for (let page = 0; page < 50; page++) {
    const r = await smartQuery<OrdersWire>(req, cfg, contract, { orders_by_tick: { tick_id: tick, ...(start != null ? { start_from: start } : {}), limit: pageSize } }, `order book orders at tick ${tick}${page ? `, page ${page + 1}` : ''}`, height);
    if (!isOk(r)) return r;
    // pages at different heights are an error only when a height was asked for; the minute reads unpinned, where a block between two pages is ordinary
    if (firstHeight == null) firstHeight = r.height;
    else if (height != null && r.height != null && r.height !== firstHeight) return { error: `tick ${tick}: its orders were read across heights ${firstHeight} and ${r.height}`, url: r.url, at: r.at, ms: r.ms, status: r.status };
    const got: OrderRow[] = Array.isArray(r.value?.orders) ? r.value.orders : Array.isArray(r.value) ? (r.value as unknown as OrderRow[]) : [];
    all.push(...got);
    const count = typeof r.value?.count === 'number' ? r.value.count : null;
    // the count is of the orders from start_from on, so the page's count plus what came before is the whole
    const whole = count == null ? got.length < pageSize : got.length >= count;
    if (whole) return { ...r, value: all };
    if (got.length < pageSize) return { error: `tick ${tick}: a page listed ${got.length} orders of ${count} counted`, url: r.url, at: r.at, ms: r.ms, status: r.status };
    start = Number(got[got.length - 1].order_id) + 1;
  }
  return { error: `tick ${tick}: more than 50 pages of orders`, url: '', at: req.clock(), ms: 0 };
}

export interface BookState { quote_denom: string; base_denom: string; current_tick: number; next_bid_tick: number; next_ask_tick: number }
/**
 * One side of a tick as the contract keeps it (sumtree-orderbook TickValues, decimal fields): the liquidity resting,
 * which a swap lowers at once, and the effective total amount swapped (ETAS), the running count of what has been
 * filled at the tick, which a swap raises by the same amount. An order's own `etas` is the tick's count when it was
 * placed, so its fill is the tick's count since, less whatever cancelled orders placed before it held (the unrealized
 * cancels, get_unrealized_cancels), capped at its quantity; the contract's claim_order does this sum, and lazily, so
 * an order's `quantity` is what has not been claimed, not what is left to fill.
 */
export interface TickValues { total_amount_of_liquidity: string; effective_total_amount_swapped?: string; cumulative_total_value?: string; cumulative_realized_cancels?: string; last_tick_sync_etas?: string }
export interface TickRow { tick_id: number; tick_state: { ask_values: TickValues; bid_values: TickValues } }
export interface OrderRow { tick_id: number; order_id: number; order_direction: 'bid' | 'ask'; owner: string; quantity: string; placed_quantity: string; placed_at: string; etas?: string }
/** A tick's cancelled liquidity the contract has not yet realized into its ETAS, each side, as get_unrealized_cancels gives it. */
export interface TickCancels { ask: string; bid: string }

/** What the minute keeps of the book between ticks (kv depth.book): the live ticks and each one's last totals and order count. */
export interface BookKv {
  contract: string;
  /** tick id (as a string key) to the tick's last totals in base units; `orders` is the count read last, absent when not read yet. */
  ticks: Record<string, { bid: string; ask: string; orders?: number }>;
  /** When the live set was listed with all_ticks. */
  listedAt: number;
  at: number;
  /** The book's next bid and ask ticks as orderbook_state last gave them: a new best tick the set does not hold means an order arrived, and the set is listed again. */
  next?: { bid: number | null; ask: number | null };
}

export interface BookRead {
  state: Read<BookState>;
  ticks: Read<TickRow[]> | null;
  /** The orders read this minute, by tick id. */
  orders: Record<string, Read<OrderRow[]>>;
  next: BookKv | null;
  bids: BookBid[];
  asks: BookAsk[];
  /** How the live set was found this minute. */
  how: 'listed' | 'by id' | 'not read';
  /** Ticks whose totals changed since the last minute. */
  changed: number[];
}

/** The whole book as the hourly job reads it (plan 1.3 b): every live tick from all_ticks, and every order resting at them. */
export interface BookFullRead {
  state: Read<BookState>;
  /** The live ticks (a side's total above zero), or the error of the page that failed. */
  ticks: Read<TickRow[]>;
  pages: number;
  /** Each live tick's orders, by tick id; a tick whose read failed carries the error. */
  orders: Record<string, Read<OrderRow[]>>;
  /** Live ticks whose orders were not asked for, the request cap reached. */
  notAsked: number[];
  /** Every live tick's unrealized cancels, by tick id, from one get_unrealized_cancels query; null when there was no live set to ask about. */
  cancels: Read<Record<string, TickCancels>> | null;
  /** The height every read after orderbook_state was asked at (the state's own), so the ticks, the cancels and the orders describe one state; null when the state read gave none. */
  height: number | null;
}

/**
 * The book in full: orderbook_state, then at the state's height (smartQuery's `height`) all_ticks in pages until a
 * short page, the live ticks' unrealized cancels in one query, then every live tick's orders (readTickOrders),
 * `parallel` ticks at a time, as far as the request cap allows. A list cut by the cap is an error, never a live set.
 * The cancels come before the orders because the fill check and the owners' quantities left need them for every tick;
 * when the cancels query is the last request the cap allows, every tick's orders are left unasked and named in notAsked.
 * One height for all the reads is what makes the fill check's identity hold (a swap between two reads would move a
 * tick's total and count without the orders, or the cancels, following): the gateway kept the last 60 heights on
 * 2026-10-30 and the whole read takes seconds, so a pinned read that fails is an error like any other and the hour
 * keeps the hour before's orders.
 */
export async function readBookFull(req: Requests, cfg: DepthConfig, contract: string, parallel = 6): Promise<BookFullRead> {
  const out: BookFullRead = { state: { error: 'not asked', url: '', at: req.clock(), ms: 0 }, ticks: { error: 'not asked', url: '', at: req.clock(), ms: 0 }, pages: 0, orders: {}, notAsked: [], cancels: null, height: null };
  out.state = await smartQuery<BookState>(req, cfg, contract, { orderbook_state: {} }, 'order book state');
  const height = isOk(out.state) ? out.state.height : null;
  out.height = height;
  // no height to pin to (the state read failed, or answered without the header): the book is not read this hour, since
  // its reads could then describe different states and the owners' quantities left would be built from them
  if (height == null) { out.ticks = { error: isOk(out.state) ? 'not asked: the book state’s answer carried no height to read the book at' : `not asked: the book state was not read (${out.state.error})`, url: out.state.url, at: req.clock(), ms: 0 }; return out; }
  const listed = await listAllTicks(req, cfg, contract, height);
  out.pages = listed.pages;
  if (listed.ticks) out.ticks = listed.ticks;
  if (!listed.live) return out;
  const live = listed.live;
  if (req.made >= req.max) { out.cancels = { error: 'not asked: the request cap was reached', url: '', at: req.clock(), ms: 0 }; out.notAsked.push(...live.map((t) => t.tick_id)); return out; }
  out.cancels = await readTickCancels(req, cfg, contract, live.map((t) => t.tick_id), height);
  for (let i = 0; i < live.length; i += parallel) {
    const chunk = live.slice(i, i + parallel);
    if (req.made >= req.max) { out.notAsked.push(...live.slice(i).map((t) => t.tick_id)); break; }
    await Promise.all(chunk.map(async (t) => {
      if (req.made >= req.max) { out.notAsked.push(t.tick_id); return; }
      out.orders[String(t.tick_id)] = await readTickOrders(req, cfg, contract, t.tick_id, height);
    }));
  }
  return out;
}

/**
 * The unrealized cancels of the ticks named, one get_unrealized_cancels query: an answer that is not the list asked
 * for, or that leaves a tick out, is an error, so the fill check never reads a missing tick as zero cancels.
 */
export async function readTickCancels(req: Requests, cfg: DepthConfig, contract: string, tickIds: number[], height: number | null = null): Promise<Read<Record<string, TickCancels>>> {
  type Wire = { ticks: { tick_id: number; unrealized_cancels: { ask_unrealized_cancels: string; bid_unrealized_cancels: string } }[] };
  const r = await smartQuery<Wire>(req, cfg, contract, { get_unrealized_cancels: { tick_ids: tickIds } }, 'order book unrealized cancels', height);
  if (!isOk(r)) return r;
  const rows = Array.isArray(r.value?.ticks) ? r.value.ticks : null;
  if (!rows) return { error: 'unrealized cancels: not a tick list', url: r.url, at: r.at, ms: r.ms, status: r.status };
  const value: Record<string, TickCancels> = {};
  for (const t of rows) {
    const c = t?.unrealized_cancels;
    if (typeof c?.ask_unrealized_cancels !== 'string' || typeof c?.bid_unrealized_cancels !== 'string') return { error: `unrealized cancels: tick ${String(t?.tick_id)} has no figures`, url: r.url, at: r.at, ms: r.ms, status: r.status };
    value[String(t.tick_id)] = { ask: c.ask_unrealized_cancels, bid: c.bid_unrealized_cancels };
  }
  const missing = tickIds.filter((id) => !(String(id) in value));
  if (missing.length) return { error: `unrealized cancels: ${missing.length} of ${tickIds.length} ticks not answered (${missing.slice(0, 3).join(', ')})`, url: r.url, at: r.at, ms: r.ms, status: r.status };
  return { ...r, value };
}

export const liq = (v: TickValues | undefined): string => { const n = Number(v?.total_amount_of_liquidity ?? 0); return Number.isFinite(n) && n > 0 ? String(v!.total_amount_of_liquidity) : '0'; };

/** What listing the whole tick list gave: the live ticks (a side's total above zero) when the list completed, else null with the read that ended it. */
export interface TickListing {
  live: TickRow[] | null;
  /** The last page's read with the live ticks as its value, or the error of the page that failed, or the cut list as an error; null when no page was asked. */
  ticks: Read<TickRow[]> | null;
  pages: number;
}

/**
 * The contract's whole tick list, all_ticks a page at a time until a short page, as far as the request cap allows (the
 * minute's discovery and the hour's book read share it). A list cut by the cap is an error, never a live set, and so
 * is, when a height was asked for, a list whose pages were answered at different heights (a gateway that did not keep
 * to the pin); the minute's unpinned listing takes a block between two pages as ordinary.
 */
export async function listAllTicks(req: Requests, cfg: DepthConfig, contract: string, height: number | null = null): Promise<TickListing> {
  const all: TickRow[] = [];
  let start: number | null = null, complete = false, last: Read<{ ticks: TickRow[] }> | null = null, pages = 0, firstHeight: number | null = null;
  for (let page = 0; page < 20; page++) {
    const r: Read<{ ticks: TickRow[] }> = await smartQuery<{ ticks: TickRow[] }>(req, cfg, contract, { all_ticks: { start_from: start, limit: cfg.read.bookPageSize } }, `order book ticks, page ${page + 1}`, height);
    last = r; pages++;
    if (!isOk(r)) break;
    if (firstHeight == null) firstHeight = r.height;
    else if (height != null && r.height != null && r.height !== firstHeight) return { live: null, ticks: { error: `the tick list was read across heights ${firstHeight} and ${r.height}`, url: r.url, at: r.at, ms: r.ms, status: r.status }, pages };
    const got: TickRow[] = Array.isArray(r.value?.ticks) ? r.value.ticks : [];
    all.push(...got.filter((t) => start === null || t.tick_id !== start));
    if (got.length < cfg.read.bookPageSize) { complete = true; break; }
    start = got[got.length - 1].tick_id;
  }
  if (!last) return { live: null, ticks: null, pages };
  if (!isOk(last)) return { live: null, ticks: last, pages };
  if (!complete) return { live: null, ticks: { error: 'the tick list was cut by the request cap', url: last.url, at: last.at, ms: last.ms, status: last.status }, pages };
  const live = all.filter((t) => liq(t.tick_state?.bid_values) !== '0' || liq(t.tick_state?.ask_values) !== '0');
  return { live, ticks: { ...last, value: live }, pages };
}

/**
 * The book each minute (plan 1.2 e): orderbook_state, then the live ticks by id when the known set is fresh and holds
 * the book's best ticks, else the whole tick list in pages (the discovery the hourly job repeats), then orders_by_tick
 * only for ticks whose totals changed, as far as the request cap allows. Bids rest in the counter coin, asks in the base
 * coin, at the tick's price (the same tick math as the concentrated pools, exponent -6).
 */
export async function readBook(req: Requests, cfg: DepthConfig, contract: string, known: BookKv | null, now: number): Promise<BookRead> {
  const out: BookRead = { state: { error: 'not asked', url: '', at: now, ms: 0 }, ticks: null, orders: {}, next: null, bids: [], asks: [], how: 'not read', changed: [] };
  out.state = await smartQuery<BookState>(req, cfg, contract, { orderbook_state: {} }, 'order book state');
  const have = known && known.contract === contract ? known : null;
  const stateNext = isOk(out.state) ? { bid: out.state.value?.next_bid_tick ?? null, ask: out.state.value?.next_ask_tick ?? null } : null;
  // a best tick that moved to one the set does not hold is new liquidity (the state's next tick can also be an emptied tick, which the set rightly lacks: only a move counts)
  const moved = (side: 'bid' | 'ask') => !!have && !!stateNext && stateNext[side] != null && stateNext[side] !== (have.next?.[side] ?? null) && have.ticks[String(stateNext[side])] == null;
  const fresh = !!have && now - have.listedAt < cfg.read.bookDiscoveryMaxAgeMs && isOk(out.state) && !moved('bid') && !moved('ask');
  let rows: TickRow[] | null = null;
  if (fresh && have) {
    const ids = Object.keys(have.ticks).map(Number);
    if (ids.length) {
      out.ticks = await smartQuery<{ ticks: TickRow[] }>(req, cfg, contract, { ticks_by_id: { tick_ids: ids } }, 'order book ticks by id').then((r) => (isOk(r) ? { ...r, value: Array.isArray(r.value?.ticks) ? r.value.ticks : [] } : r));
      if (isOk(out.ticks)) { rows = out.ticks.value; out.how = 'by id'; }
    } else { rows = []; out.how = 'by id'; }
  } else {
    // list every tick, a page at a time, as far as the cap allows; a cut list is not kept as the live set
    const listed = await listAllTicks(req, cfg, contract);
    if (listed.ticks) out.ticks = listed.ticks;
    if (listed.live) { rows = listed.live; out.how = 'listed'; }
  }
  if (!rows) return out;
  const next: BookKv = { contract, ticks: {}, listedAt: out.how === 'listed' ? now : have?.listedAt ?? now, at: now, next: stateNext ?? have?.next };
  for (const t of rows) {
    const bid = liq(t.tick_state?.bid_values), ask = liq(t.tick_state?.ask_values);
    if (bid === '0' && ask === '0') continue;
    const prev = have?.ticks[String(t.tick_id)];
    const entry: BookKv['ticks'][string] = { bid, ask };
    if (prev && prev.bid === bid && prev.ask === ask && prev.orders != null) entry.orders = prev.orders;
    else out.changed.push(t.tick_id);
    next.ticks[String(t.tick_id)] = entry;
  }
  // orders only where the totals moved (0 most minutes), a request a page (one page holds a tick of 200 orders or fewer), within the cap
  for (const tick of out.changed) {
    if (req.made >= req.max) break;
    out.orders[String(tick)] = await readTickOrders(req, cfg, contract, tick);
    if (isOk(out.orders[String(tick)])) next.ticks[String(tick)].orders = (out.orders[String(tick)] as ReadOk<OrderRow[]>).value.length;
  }
  for (const [id, t] of Object.entries(next.ticks)) {
    const tick = Number(id), price = tickToPrice(tick);
    if (t.bid !== '0') out.bids.push({ price, quote: Number(t.bid), orders: t.orders });
    if (t.ask !== '0') out.asks.push({ price, base: Number(t.ask), orders: t.orders });
  }
  out.next = next;
  return out;
}
