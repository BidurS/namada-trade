// The network of the depth minute tests: a fetch that answers every read of worker/src/depth/read.ts from the saved
// answers in test/fixtures/depth/ (the research's reads of 2026-10-29), and nothing else. No test reaches the network.
//
// What answers what:
//   - the chain node's JSON-RPC batch: each Query/Pool and tick store from the pool's saved state, re-encoded with the
//     module's own encoders (test/depth-proto.test.ts holds them to the node's raw bytes), every answer at one height,
//     the prototype's reference height 73,429,291 (proto_latest.json refHeight, pool 3005 read 02:56:05 UTC);
//   - pools 3005, 3009 and 3368 from verify-pool*-now.json / verify-ranges*-now.json (02:55-02:57 UTC); the four small
//     concentrated pools 3052, 3015, 3017 and 3405, whose tick maps the research did not save, from the prototype's
//     levels (proto_latest.json: each range's prices and amounts at seven significant digits) and the quote service's
//     copy of the pool object (sqs_pools_nam.json chain_model), so their liquidity is the prototype's to about 1e-6;
//   - the quote service's price list from the prototype's counter prices (proto_latest.json pools[].counterUsd, read
//     02:56:04 UTC), its token metadata from proto_token_meta.json, its pool list from sqs_pools_nam.json;
//   - the gateway: the taker fees from proto_latest.json takerByDenom (02:56:05 UTC), the estimate from
//     lcd_pm_estimate_3005.json (1,014,160 for 1,000 NAM; the pool's state did not move between 02:19 and 02:59 UTC:
//     verify-router.json), the order book's state from sq_3008_orderbook_state.json and its ticks and orders from
//     book_3008_full.json in the contract's own answer shapes (all_ticks / ticks_by_id: { ticks: [{ tick_id,
//     tick_state: { bid_values, ask_values } }] }; orders_by_tick: { orders, count }), the fallback pool reads for 3005
//     from lcd_pm_pool_3005.json and lcd_cl_liq_per_tick_3005.json.
import { depthFixture, NAM_DENOM } from './depth-fixtures';
import { encodePair, encodePoolResponse, encodeTickInfo, tickKey, pbDecode, type ClPoolWire } from '../worker/src/depth/proto';
import { decString, priceToTick, tickToPrice, type ClRange } from '../worker/src/depth/model';
import { decToScaled } from '../worker/src/depth/proto';
import { bytesToBase64, base64Bytes } from '../worker/src/util';
import { OSMOSIS } from '../worker/src/config';
import type { FetchLike } from '../worker/src/depth/read';
import type { BookKv } from '../worker/src/depth/read';
import type { DepthParamsKv } from '../worker/src/depth/index';

export const REF_HEIGHT = 73429291;
export const LATEST = depthFixture<any>('proto_latest.json');
/** The four small pools' levels (see the header): the trimmed proto_latest.json left the levels out. */
export const LEVELS: any[] = depthFixture<{ levels: any[] }>('proto_latest_levels.json').levels;
export const SQS_POOLS = depthFixture<{ data: any[] }>('sqs_pools_nam.json').data;
export const BOOK = depthFixture<any>('book_3008_full.json');
export const TOKEN_META = depthFixture<{ readAt: string; url: string; tokens: Record<string, { symbol: string; decimals: number }> }>('proto_token_meta.json');
export const BOOK_STATE = depthFixture<{ data: any }>('sq_3008_orderbook_state.json').data;
export const ESTIMATE = depthFixture<{ token_out_amount: string }>('lcd_pm_estimate_3005.json');
export const BOOK_CONTRACT: string = SQS_POOLS.find((p) => p.type === 3).chain_model.contract_address;

const td = new TextDecoder();
const concat = (...parts: Uint8Array[]): Uint8Array => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

/** A concentrated pool's state as the node would answer it: the pool object and its ranges. */
export interface ClState { wire: Omit<ClPoolWire, 'typeUrl'>; ranges: ClRange[] }

const chainModelOf = (id: string) => SQS_POOLS.find((p) => String(p.chain_model?.id ?? p.chain_model?.pool_id) === id)?.chain_model;
const wireOf = (pool: any): Omit<ClPoolWire, 'typeUrl'> => ({
  id: String(pool.id), address: String(pool.address), token0: pool.token0, token1: pool.token1, current_tick_liquidity: String(pool.current_tick_liquidity), current_sqrt_price: String(pool.current_sqrt_price),
  current_tick: String(pool.current_tick), tick_spacing: String(pool.tick_spacing), exponent_at_price_one: String(pool.exponent_at_price_one), spread_factor: String(pool.spread_factor),
  last_liquidity_update: pool.last_liquidity_update ? Date.parse(pool.last_liquidity_update) : null,
});

/** The four small pools' ranges from the prototype's levels and the quote service's pool object (see the header). */
function rangesFromLevels(id: string, cm: any): ClRange[] {
  const p = LATEST.pools.find((x: any) => x.id === id);
  const k = p.counterUsd * 10 ** (6 - p.counterDecimals);
  const namIs0 = cm.token0 === NAM_DENOM;
  const sp = Number(cm.current_sqrt_price);
  const spacing = Number(cm.tick_spacing);
  const snap = (t: number) => Math.round(t / spacing) * spacing;
  const out: ClRange[] = [];
  for (const l of LEVELS.filter((x: any) => x.pool === id)) {
    const loRaw = l.loUsd / k, hiRaw = l.hiUsd / k;
    const lo = snap(namIs0 ? priceToTick(loRaw) : priceToTick(1 / hiRaw)), hi = snap(namIs0 ? priceToTick(hiRaw) : priceToTick(1 / loRaw));
    const sa = Math.sqrt(tickToPrice(lo)), sb = Math.sqrt(tickToPrice(hi));
    const amt0 = (namIs0 ? l.nam * 1e6 : l.counter * 10 ** p.counterDecimals), amt1 = namIs0 ? l.counter * 10 ** p.counterDecimals : l.nam * 1e6;
    let L: number;
    if (sp <= sa) L = (amt0 * sa * sb) / (sb - sa);
    else if (sp >= sb) L = amt1 / (sb - sa);
    else L = amt1 > amt0 * sp ? amt1 / (sp - sa) : (amt0 * sp * sb) / (sb - sp);
    out.push({ lower_tick: lo, upper_tick: hi, liquidity_amount: decString(BigInt(Math.round(L * 1e6)) * 10n ** 12n, 18) });
  }
  return out.sort((a, b) => Number(a.lower_tick) - Number(b.lower_tick));
}

/** Every concentrated pool of the live set: the saved state where the research kept one, the prototype's levels for the rest. */
export function clStates(): Record<string, ClState> {
  const out: Record<string, ClState> = {};
  for (const id of ['3005', '3009', '3368']) {
    const pool = depthFixture<{ pool: any }>(`verify-pool${id}-now.json`).pool;
    out[id] = { wire: wireOf(pool), ranges: depthFixture<{ liquidity: ClRange[] }>(`verify-ranges${id}-now.json`).liquidity };
  }
  for (const id of ['3052', '3015', '3017', '3405']) {
    const cm = chainModelOf(id);
    out[id] = { wire: wireOf(cm), ranges: rangesFromLevels(id, cm) };
  }
  return out;
}

/** A tick store value for a pool's ranges: one TickInfo per boundary with the liquidity_net of the ranges it starts and ends. */
export function tickStoreValue(poolId: string, ranges: ClRange[]): Uint8Array {
  const net = new Map<number, bigint>(), gross = new Map<number, bigint>();
  for (const r of ranges) {
    const L = decToScaled(r.liquidity_amount, 18);
    for (const [t, sign] of [[Number(r.lower_tick), 1n], [Number(r.upper_tick), -1n]] as const) { net.set(t, (net.get(t) ?? 0n) + sign * L); gross.set(t, (gross.get(t) ?? 0n) + L); }
  }
  // consecutive ranges share a boundary: its net is the difference, as the chain stores it; a boundary whose net is zero and gross is zero would not exist
  const ticks = [...net.keys()].sort((a, b) => a - b);
  return concat(...ticks.map((t) => encodePair(tickKey(poolId, t), encodeTickInfo(decString(gross.get(t)!, 18), decString(net.get(t)!, 18)))));
}

const json = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
const b64 = (b: Uint8Array) => bytesToBase64(b);

/** The book's live ticks in the contract's answer shape. */
const tickRows = () => BOOK.live_ticks.map((t: any) => ({ tick_id: t.tick_id, tick_state: { bid_values: { total_amount_of_liquidity: t.bid_liq, effective_total_amount_swapped: t.bid_swapped }, ask_values: { total_amount_of_liquidity: t.ask_liq, effective_total_amount_swapped: t.ask_swapped } } }));
const ordersAt = (tick: number) => BOOK.orders.filter((o: any) => o.tick_id === tick).map((o: any) => ({ tick_id: o.tick_id, order_id: o.order_id, order_direction: o.side, owner: o.owner, quantity: o.quantity, placed_quantity: o.placed_quantity, placed_at: o.placed_at_ns, etas: o.etas, claim_bounty: o.claim_bounty }));

/** kv depth.book as a minute that had listed the ticks would leave it: every live tick's totals and its order count. */
export function bookKvFromFixture(at: number): BookKv {
  const ticks: BookKv['ticks'] = {};
  for (const t of BOOK.live_ticks) ticks[String(t.tick_id)] = { bid: Number(t.bid_liq) > 0 ? t.bid_liq : '0', ask: Number(t.ask_liq) > 0 ? t.ask_liq : '0', orders: ordersAt(t.tick_id).length };
  return { contract: BOOK_CONTRACT, ticks, listedAt: at, at, next: { bid: BOOK_STATE.next_bid_tick, ask: BOOK_STATE.next_ask_tick } };
}
/** kv depth.params as a minute that had read every taker fee and the token metadata would leave it. */
export function paramsKvFromFixture(at: number): DepthParamsKv {
  const taker: DepthParamsKv['taker'] = {};
  for (const [d, t] of Object.entries<any>(LATEST.takerByDenom)) if (t.fee != null) taker[d] = { fee: t.fee, at, url: t.url };
  const tokens: DepthParamsKv['tokens'] = {};
  for (const [d, m] of Object.entries(TOKEN_META.tokens)) tokens[d] = { symbol: m.symbol, decimals: m.decimals };
  return { taker, tokens, tokensAt: at, tokensUrl: TOKEN_META.url };
}
/** The price list the prototype's minute saw: every counter coin's USD from proto_latest.json, keyed as the service keys it. */
export function priceListFromFixture(denoms: string[]): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const d of denoms) {
    const p = LATEST.pools.find((x: any) => x.counterDenom === d && x.counterUsd != null);
    if (p) out[d] = { [OSMOSIS.allUsdc]: String(p.counterUsd) };
  }
  return out;
}

export interface NetOptions {
  /** A request that never answers until its signal aborts (the phase's end). */
  hang?: (url: string, body: string | null) => boolean;
  /** Pools whose tick store the node answers with code 18 (state not available), so the gateway fallback runs. */
  failTicks?: string[];
  /** A status for a URL, in place of the fixture's answer. */
  status?: (url: string) => number | undefined;
  height?: number;
}
export interface Net { fetch: FetchLike; calls: { url: string; body: string | null; method: string }[]; posts: () => number }

/** The fetch of the tests, answering from the fixtures as the header says. */
export function depthNetwork(opts: NetOptions = {}): Net {
  const states = clStates();
  const height = opts.height ?? REF_HEIGHT;
  const calls: Net['calls'] = [];
  const hangUntilAbort = (init?: RequestInit) => new Promise<Response>((_, reject) => { const s = init?.signal; if (s?.aborted) reject(new Error('aborted')); else s?.addEventListener('abort', () => reject(new Error(`aborted: ${String(s.reason)}`))); });
  const fetchFn: FetchLike = async (url, init) => {
    const body = typeof init?.body === 'string' ? init.body : null;
    calls.push({ url, body, method: init?.method ?? 'GET' });
    if (opts.hang?.(url, body)) return hangUntilAbort(init);
    const st = opts.status?.(url);
    if (st && st !== 200) return new Response('no', { status: st });
    const u = new URL(url);
    // the chain node's JSON-RPC batch
    if (u.origin === OSMOSIS.publicRpc && init?.method === 'POST') {
      const reqs: any[] = JSON.parse(body ?? '[]');
      return json(reqs.map((q) => {
        const data = Uint8Array.from((q.params.data as string).match(/../g)!.map((h: string) => parseInt(h, 16)));
        const ok = (value: Uint8Array) => ({ jsonrpc: '2.0', id: q.id, result: { response: { code: 0, log: '', height: String(height), value: b64(value) } } });
        const fail = (code: number, log: string) => ({ jsonrpc: '2.0', id: q.id, result: { response: { code, log, height: String(height), value: null } } });
        if (q.params.path === '/osmosis.poolmanager.v1beta1.Query/Pool') {
          const id = String(pbDecode(data).find((f) => f.f === 1)?.v ?? '');
          return states[id] ? ok(encodePoolResponse(states[id].wire)) : fail(18, `pool ${id}: no saved state`);
        }
        if (q.params.path === '/store/concentratedliquidity/subspace' && data[0] === 0x01) {
          const id = String(new DataView(data.buffer, data.byteOffset + 1, 8).getBigUint64(0));
          if (opts.failTicks?.includes(id)) return fail(18, 'failed to load state; version mismatch on immutable IAVL tree');
          return states[id] ? ok(tickStoreValue(id, states[id].ranges)) : fail(18, `pool ${id}: no saved state`);
        }
        return fail(6, 'unknown query path');
      }));
    }
    if (u.origin === OSMOSIS.sqs) {
      if (u.pathname === '/pools') return json({ data: SQS_POOLS });
      if (u.pathname === '/tokens/prices') return json(priceListFromFixture((u.searchParams.get('base') ?? '').split(',')));
      if (u.pathname === '/tokens/metadata') { const asked = (u.searchParams.get('denoms') ?? '').split(','); return json(Object.fromEntries(asked.filter((d) => TOKEN_META.tokens[d]).map((d) => [d, TOKEN_META.tokens[d]]))); }
      return new Response('not here', { status: 404 });
    }
    if (u.origin === OSMOSIS.publicRest) {
      const hh = { 'grpc-metadata-x-cosmos-block-height': String(height) };
      if (u.pathname.endsWith('/trading_pair_takerfee')) { const t = LATEST.takerByDenom[u.searchParams.get('denom_1') ?? '']; return t?.fee != null ? json({ taker_fee: t.fee.toFixed(18) }, hh) : new Response('not found', { status: 404 }); }
      if (u.pathname.includes('/estimate/single_pool_swap_exact_amount_in')) return json(ESTIMATE, hh);
      if (u.pathname === '/osmosis/poolmanager/v1beta1/pools/3005') return json(depthFixture('lcd_pm_pool_3005.json'), hh);
      if (u.pathname === '/osmosis/concentratedliquidity/v1beta1/liquidity_per_tick_range' && u.searchParams.get('pool_id') === '3005') return json(depthFixture('lcd_cl_liq_per_tick_3005.json'), hh);
      const smart = u.pathname.match(/\/cosmwasm\/wasm\/v1\/contract\/([^/]+)\/smart\/(.+)$/);
      if (smart) {
        if (smart[1] !== BOOK_CONTRACT) return new Response('not found', { status: 404 });
        const msg = JSON.parse(td.decode(base64Bytes(decodeURIComponent(smart[2]))));
        if (msg.orderbook_state) return json({ data: BOOK_STATE }, hh);
        if (msg.all_ticks) { const rows = tickRows(); const from = msg.all_ticks.start_from; const i = from == null ? 0 : rows.findIndex((r: any) => r.tick_id === from); return json({ data: { ticks: rows.slice(i < 0 ? 0 : i, (i < 0 ? 0 : i) + msg.all_ticks.limit) } }, hh); }
        if (msg.ticks_by_id) { const want = new Set<number>(msg.ticks_by_id.tick_ids); return json({ data: { ticks: tickRows().filter((r: any) => want.has(r.tick_id)) } }, hh); }
        if (msg.orders_by_tick) { const orders = ordersAt(msg.orders_by_tick.tick_id); return json({ data: { orders, count: orders.length } }, hh); }
        return json({ code: 3, message: 'Error parsing into type sumtree_orderbook::msg::QueryMsg' });
      }
      return new Response('not here', { status: 404 });
    }
    return new Response('not here', { status: 404 });
  };
  return { fetch: fetchFn, calls, posts: () => calls.filter((c) => c.method === 'POST').length };
}
