// The depth reads (plan 1.2): every outside answer the minute uses, each returned as { value, url, at, height, bytes,
// ms, status } or { error, url, at }, counted against the minute's request cap (C2) and ended by the phase's signal.
// Hosts and paths are the ones the research read on 2026-10-29 (chain.txt): the chain node's JSON-RPC for one batch of
// abci queries at one height, the REST gateway for the fallback, the estimate, the taker fees and the order book's
// smart queries, the quote service for the pool list, the price list and the token metadata. Nothing here names a
// coin or a pool: the configuration passes them in.
import type { DepthConfig } from './config';
import { batchBody, parseBatch, type AbciAnswer, type AbciQuery } from './proto';
import type { BookAsk, BookBid, ClPoolState, ClRange } from './model';
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

// ---------------------------------------------------------------------------------------------------- the REST gateway
const enc = encodeURIComponent;

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
export async function readTakerFee(req: Requests, cfg: DepthConfig, counterDenom: string): Promise<Read<number>> {
  const url = `${cfg.hosts.rest}/osmosis/poolmanager/v1beta1/trading_pair_takerfee?denom_0=${enc(cfg.base.denom)}&denom_1=${enc(counterDenom)}`;
  const r = await readJson<{ taker_fee?: string }>(req, 'taker fee', url);
  if (!isOk(r)) return r;
  const fee = Number(r.value.taker_fee);
  return Number.isFinite(fee) && fee >= 0 && fee < 1 ? { ...r, value: fee } : { error: 'no taker_fee', url: r.url, at: r.at, ms: r.ms, status: r.status };
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
/** One smart query of a contract through the gateway: the message base64 in the path, the answer's `data`. */
export async function smartQuery<T>(req: Requests, cfg: DepthConfig, contract: string, msg: unknown, what: string): Promise<Read<T>> {
  const url = `${cfg.hosts.rest}/cosmwasm/wasm/v1/contract/${contract}/smart/${enc(bytesToBase64(te.encode(JSON.stringify(msg))))}`;
  const r = await readJson<{ data: T }>(req, what, url);
  if (!isOk(r)) return r;
  return { ...r, value: r.value?.data as T };
}

export interface BookState { quote_denom: string; base_denom: string; current_tick: number; next_bid_tick: number; next_ask_tick: number }
interface TickValues { total_amount_of_liquidity: string; effective_total_amount_swapped?: string }
export interface TickRow { tick_id: number; tick_state: { ask_values: TickValues; bid_values: TickValues } }
export interface OrderRow { tick_id: number; order_id: number; order_direction: 'bid' | 'ask'; owner: string; quantity: string; placed_quantity: string; placed_at: string }

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

const liq = (v: TickValues | undefined): string => { const n = Number(v?.total_amount_of_liquidity ?? 0); return Number.isFinite(n) && n > 0 ? String(v!.total_amount_of_liquidity) : '0'; };
const tickPrice = (tick: number, exp = -6): number => { if (tick === 0) return 1; const per = 9 * 10 ** -exp; const geo = Math.floor(tick / per); return 10 ** geo + (tick - geo * per) * 10 ** (exp + geo); };

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
    const all: TickRow[] = [];
    let start: number | null = null, complete = false, last: Read<unknown> | null = null;
    for (let page = 0; page < 20; page++) {
      const r: Read<{ ticks: TickRow[] }> = await smartQuery<{ ticks: TickRow[] }>(req, cfg, contract, { all_ticks: { start_from: start, limit: cfg.read.bookPageSize } }, `order book ticks, page ${page + 1}`);
      last = r;
      if (!isOk(r)) break;
      const got: TickRow[] = Array.isArray(r.value?.ticks) ? r.value.ticks : [];
      all.push(...got.filter((t) => start === null || t.tick_id !== start));
      if (got.length < cfg.read.bookPageSize) { complete = true; break; }
      start = got[got.length - 1].tick_id;
    }
    if (complete && last && isOk(last)) { rows = all.filter((t) => liq(t.tick_state?.bid_values) !== '0' || liq(t.tick_state?.ask_values) !== '0'); out.how = 'listed'; out.ticks = { ...last, value: rows }; }
    else if (last) out.ticks = isOk(last) ? { error: 'the tick list was cut by the request cap', url: last.url, at: last.at, ms: last.ms, status: last.status } : last;
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
  // orders only where the totals moved (0 most minutes), one request a tick, within the cap
  for (const tick of out.changed) {
    if (req.made >= req.max) break;
    const r = await smartQuery<{ orders: OrderRow[] }>(req, cfg, contract, { orders_by_tick: { tick_id: tick, limit: 200 } }, `order book orders at tick ${tick}`);
    out.orders[String(tick)] = isOk(r) ? { ...r, value: Array.isArray(r.value?.orders) ? r.value.orders : Array.isArray(r.value) ? (r.value as unknown as OrderRow[]) : [] } : r;
    if (isOk(out.orders[String(tick)])) next.ticks[String(tick)].orders = (out.orders[String(tick)] as ReadOk<OrderRow[]>).value.length;
  }
  for (const [id, t] of Object.entries(next.ticks)) {
    const tick = Number(id), price = tickPrice(tick);
    if (t.bid !== '0') out.bids.push({ price, quote: Number(t.bid), orders: t.orders });
    if (t.ask !== '0') out.asks.push({ price, base: Number(t.ask), orders: t.orders });
  }
  out.next = next;
  return out;
}
