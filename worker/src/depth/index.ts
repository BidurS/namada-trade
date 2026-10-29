// The depth minute job (plan section 1): every minute, inside its own phase of the cron tick, read the live pools'
// state from the chain (one JSON-RPC batch for the concentrated pools, the order book's state and live ticks, the
// chain's own estimate for the check), put every pool on the USD axis, write one depth_minute row per live pool and one
// for the aggregate with its heat bands, the minute's answer to kv depth.latest, the raw states to kv depth.states (the
// minute before to depth.prev, for the realised check), the three checks of plan section 5 and the health rows. Every
// figure comes from a read with its source and time or is NULL with the reason; the caps of plan section 7 are checked
// before each write (budget.ts); a failure here never ends the tick (cron.ts catches it).
//
// Nothing in this file names a coin or a pool: the configuration (config.ts) does, so another Worker runs the same job
// for another Osmosis token.
import type { Env } from '../util';
import { stmt, type Stmt } from '../db';
import { settleMetaOf, SETTLE_STABLES } from '../../../shared/settle';
import type { SourceHealth } from '../../../shared/types';
import {
  CURVE_POINTS_MAX, CURVE_POOL_POINTS_MAX, DEPTH_CHECK_TITLES, DEPTH_SOURCES, BOOK_LEG_LEFT_OUT, UNPRICED_NOT_READ, bookSource,
  type DepthChecks, type DepthCurve, type DepthLevel, type DepthPool, type DepthProv, type DepthRead, type DepthReadError, type DepthResponse, type DepthUnpriced, type DepthFill,
} from '../../../shared/depth';
import { NAM_DEPTH, type DepthConfig } from './config';
import {
  aggregate, aggregateOfCurves, balancerModel, buildGrid, clModel, clSellExact, executeBuy, executeBuyUsd, executeSell, heatAt, levelsOf, offsetsAt, orderbookModel, packF32,
  rangesFromTicks, stableswapModel, thinIndices, touchAt, usdPerRaw, withinAt, type Aggregate, type BookAsk, type BookBid, type ClPoolState, type ClRange, type PoolModel, type PricedPool, type WeightedAsset,
} from './model';
import { decodePool, decodeTickInfos, poolQuery, tickSubspaceQuery, type AbciQuery } from './proto';
import { counterDenoms, counterInfo, counterValueUsd, isDust, listPools, liveSet, pairOf, type CounterInfo, type ListedPool, type TakerFee, type TokenMeta } from './pools';
import { Requests, isOk, readBook, readClPoolLcd, readEstimate, readPoolList, readPriceList, readTakerFee, readTokenMeta, rpcBatch, type BookKv, type BookRead, type FetchLike, type Read, type ReadOk } from './read';
import { KV_KEYS, copyKvStmt, kvManySql, kvStmt, minuteStmt, type DepthMinuteRow } from './sql';
import { STORE_HEALTH, budgetCheckStmt, budgetFor, budgetKvStmt, gate, killSwitchOff, KILL_SWITCH_NOTE, recordBytes, recordCapHit, recordWrites, storeHealth, type DepthBudget } from './budget';

export const DEPTH_HEALTH = { pools: 'Osmosis depth (pools)', book: 'Osmosis depth (order book)', owners: 'Osmosis depth (owners)', store: STORE_HEALTH } as const;
/** The minute's own budget inside the tick (C2); cron.ts makes the phase signal from it. */
export const DEPTH_PHASE_MS = NAM_DEPTH.caps.phaseMs;
const MINUTE = 60_000;

export interface MinuteCtx {
  health: SourceHealth[];
  /** The phase's signal: reads end with it. */
  signal?: AbortSignal;
  late?: () => boolean;
  /** The quote service's pool list already read this tick (sources/sqs.ts fetchNamPools raw), to save the request. */
  pools?: unknown | null;
  poolsAt?: number;
  /** The direct quote the tick's price read made in the reference pool (check 2): base units out for `nam` whole coins. */
  routeOut?: { nam: number; amountOut: string; at: number } | null;
  /** Resolved when the tick's own batch is written: the depth writes go after it (plan 1.1). */
  writeAfter?: Promise<unknown>;
  fetch?: FetchLike;
  cfg?: DepthConfig;
  /** The clock the reads are stamped with (Date.now in the Worker; a test's fixed time). */
  clock?: () => number;
}

export interface MinuteResult {
  /** Why nothing was read or written, when so. */
  skipped?: string;
  rows: DepthMinuteRow[];
  latest: DepthResponse | null;
  /** The synchronous compute's time, milliseconds (the CPU the minute costs beyond its reads). */
  cpuMs: number;
  requests: number;
  bytes: number;
  written: boolean;
  budget: DepthBudget;
}

/** What the module keeps of its parameters between ticks (kv depth.params): taker fees by counter denom, token metadata with its read time. */
export interface DepthParamsKv {
  taker: Record<string, TakerFee>;
  tokens: Record<string, TokenMeta>;
  tokensAt: number | null;
  tokensUrl: string | null;
}
const freshParams = (): DepthParamsKv => ({ taker: {}, tokens: {}, tokensAt: null, tokensUrl: null });

/** One pool's raw state as read, enough to rebuild its model (kv depth.states this minute, depth.prev the minute before). */
export interface StoredPoolState {
  id: string;
  type: DepthPool['type'];
  counterDenom: string;
  counterUsd: number;
  counterDecimals: number;
  taker: number;
  spread: number;
  at: number;
  height: number | null;
  cl?: { pool: ClPoolState; ranges: ClRange[] };
  gamm?: { assets: WeightedAsset[] };
  stable?: { liquidity: { denom: string; amount: string }[]; scaling: (string | number)[] };
  book?: { bids: BookBid[]; asks: BookAsk[] };
}
export interface DepthStates {
  minute: number;
  /** The newest pool read of the minute. */
  at: number;
  ref: { pool: string; usd: number; height: number | null };
  pools: StoredPoolState[];
}

/** One realised comparison (check 3; kv depth.realised keeps the newest). */
export interface Realised {
  id: string;
  kind: 'buy' | 'sell';
  at: number;
  /** Whole base coins the trader gave (a sale) or got (a buy). */
  nam: number;
  predicted: number;
  settle: number;
  diffPct: number;
  route: string[];
  /** The stored minute the walk used. */
  minute: number;
}

/** The pool's model from its stored state. */
export function modelOfState(cfg: DepthConfig, s: StoredPoolState): PoolModel | null {
  try {
    if (s.cl) return clModel(s.cl.pool, s.cl.ranges, cfg.base.denom);
    if (s.gamm) return balancerModel(s.gamm.assets, s.spread, cfg.base.denom);
    if (s.stable) return stableswapModel(s.stable.liquidity, s.stable.scaling, s.spread, cfg.base.denom);
    if (s.book) return orderbookModel(s.book.bids, s.book.asks, s.spread);
  } catch { return null; }
  return null;
}
const pricedOfState = (cfg: DepthConfig, s: StoredPoolState): PricedPool | null => {
  const model = modelOfState(cfg, s);
  return model ? { id: s.id, type: s.type, model, counterUsd: s.counterUsd, counterDecimals: s.counterDecimals, taker: s.taker } : null;
};

const pct = (a: number, b: number) => (b === 0 ? NaN : (a / b - 1) * 100);
const sig = (x: number, d: number): number => (Number.isFinite(x) ? +x.toPrecision(d) : x);
const clockUtc = (ms: number): string => `${new Date(ms).toISOString().slice(11, 16)} UTC`;
const errOf = (r: Read<unknown> | null | undefined): string => (r && !isOk(r) ? r.error : 'no answer');
const readOf = (r: ReadOk<unknown>): DepthRead => ({ url: r.url, at: r.at, height: r.height, bytes: r.bytes, ms: r.ms, status: r.status });

/** D1 batches of 80 (as db.ts runBatch), with each statement's meta kept for the budget. */
async function batchWithMeta(db: D1Database, stmts: Stmt[]): Promise<{ meta?: Record<string, number> }[]> {
  const out: { meta?: Record<string, number> }[] = [];
  for (let i = 0; i < stmts.length; i += 80) {
    const res = await db.batch(stmts.slice(i, i + 80).map((s) => db.prepare(s.sql).bind(...s.params)));
    for (const r of res ?? []) out.push(r as { meta?: Record<string, number> });
  }
  return out;
}

/** A pool as the minute built it: what was listed, how its coin is priced, what was read and the model when it could be built. */
interface PoolBuild {
  listed: ListedPool;
  info: CounterInfo;
  model: PoolModel | null;
  read: DepthRead | DepthReadError;
  height: number | null;
  at: number;
  error: string | null;
  state: StoredPoolState | null;
  cl?: { currentTick: number; liquidity: number; ranges: number };
  book?: BookRead;
}

// ---------------------------------------------------------------------------------------------------- the realised check
export interface SwapLike { id: string; ts: number; kind: string; pool_id: string | null; meta: string | null }

/**
 * Check 3: each stored swap of the window whose route is pools only, walked on the newest stored states read before it
 * (the gross coins from meta.settle: for a sale the base coins the trader gave, verify.txt C1), against the trader's own
 * settle. A trade with a book leg, no settle record, a coin with no rate in its own transaction or no stored state
 * before it is left out with the reason.
 */
export function executedCheck(cfg: DepthConfig, swaps: SwapLike[], states: DepthStates[], kept: Realised[], now: number): { stmt: Stmt; kept: Realised[]; excluded: { id: string; why: string }[] } {
  const sorted = [...states].filter((s) => s && Array.isArray(s.pools)).sort((a, b) => a.at - b.at);
  const have = new Map(kept.map((r) => [r.id, r]));
  const excluded: { id: string; why: string }[] = [];
  const rate = (symbol: string, rates: Record<string, number> | undefined): number | null => (SETTLE_STABLES.includes(symbol) ? 1 : rates && rates[symbol] > 0 ? rates[symbol] : null);
  for (const s of swaps) {
    if (have.has(s.id)) continue;
    if (s.kind !== 'buy' && s.kind !== 'sell') continue;
    const route = (s.pool_id ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    if (!route.length) { excluded.push({ id: s.id, why: 'no pool on the stored row' }); continue; }
    if (route.some((id) => cfg.bookPoolIds.includes(id))) { excluded.push({ id: s.id, why: BOOK_LEG_LEFT_OUT }); continue; }
    let meta: Record<string, unknown> | null = null;
    try { meta = s.meta ? JSON.parse(s.meta) : null; } catch { meta = null; }
    const settle = settleMetaOf(meta);
    if (!settle) { excluded.push({ id: s.id, why: 'no settle record on the stored row' }); continue; }
    const st = [...sorted].reverse().find((x) => x.at <= s.ts);
    if (!st) { excluded.push({ id: s.id, why: 'no stored state read before the trade' }); continue; }
    const pools: PricedPool[] = [];
    let missing: string | null = null;
    for (const id of route) {
      const ps = st.pools.find((p) => p.id === id);
      const pp = ps ? pricedOfState(cfg, ps) : null;
      if (!pp) { missing = id; break; }
      pools.push(pp);
    }
    if (missing) { excluded.push({ id: s.id, why: `pool ${missing} is not in the stored minute` }); continue; }
    let usd = 0, noRate: string | null = null;
    for (const [symbol, amount] of Object.entries(settle.coins)) {
      if (!amount) continue;
      if (s.kind === 'sell' ? amount < 0 : amount > 0) continue; // the coin paid on a sale, got on a buy: the backrun's leftovers, not the trade
      const r = rate(symbol, settle.rates);
      if (r == null) { noRate = symbol; break; }
      usd += Math.abs(amount) * r;
    }
    if (noRate) { excluded.push({ id: s.id, why: `no rate for ${noRate} in the trade’s own transaction` }); continue; }
    const agg = aggregate(pools, buildGrid(st.ref.usd), cfg.base.decimals);
    let row: Realised | null = null;
    if (s.kind === 'sell') {
      const gross = -settle.nam;
      if (!(gross > 0) || !(usd > 0)) { excluded.push({ id: s.id, why: 'the settle record has no coins out' }); continue; }
      const fill = executeSell(agg, pools, gross);
      if (!fill.complete) { excluded.push({ id: s.id, why: 'the stored state could not fill the size' }); continue; }
      row = { id: s.id, kind: 'sell', at: s.ts, nam: gross, predicted: fill.usd, settle: usd, diffPct: pct(fill.usd, usd), route, minute: st.minute };
    } else {
      const got = settle.nam;
      if (!(got > 0) || !(usd > 0)) { excluded.push({ id: s.id, why: 'the settle record has no coins in' }); continue; }
      const fill = executeBuyUsd(agg, pools, usd);
      if (!fill.complete) { excluded.push({ id: s.id, why: 'the stored state could not fill the size' }); continue; }
      row = { id: s.id, kind: 'buy', at: s.ts, nam: got, predicted: fill.nam, settle: got, diffPct: pct(fill.nam, got), route, minute: st.minute };
    }
    if (!Number.isFinite(row.diffPct)) { excluded.push({ id: s.id, why: 'the comparison is not a number' }); continue; }
    have.set(s.id, row);
  }
  const all = [...have.values()].sort((a, b) => b.at - a.at).slice(0, cfg.checks.realisedKeep);
  const recent = all.filter((r) => r.at >= now - cfg.checks.executedIdleMs).slice(0, cfg.checks.executedKeep);
  const worst = recent.length ? Math.max(...recent.map((r) => Math.abs(r.diffPct))) : null;
  const status = worst == null ? 'idle' : worst <= cfg.checks.executedOkPct ? 'ok' : worst <= cfg.checks.executedWarnPct ? 'warn' : 'fail';
  const detail = {
    n: recent.length, within1pct: recent.filter((r) => Math.abs(r.diffPct) <= cfg.checks.executedOkPct).length, worstPct: worst, okPct: cfg.checks.executedOkPct, warnPct: cfg.checks.executedWarnPct,
    lastAt: recent[0]?.at ?? null, windowMs: cfg.checks.executedWindowMs, trades: recent, leftOut: excluded.slice(0, 20),
    note: status === 'idle' ? 'no trade the check could walk in the last day' : 'the known one-sided residual of one pool (verify.txt, about a tenth of a percent) is inside the tolerance',
  };
  return { stmt: stmt.check('depth_vs_executed', status, DEPTH_CHECK_TITLES.depth_vs_executed, detail, now), kept: all, excluded };
}

// ---------------------------------------------------------------------------------------------------- the minute
export async function minute(env: Env, now: number, ctx: MinuteCtx): Promise<MinuteResult> {
  const cfg = ctx.cfg ?? NAM_DEPTH;
  const caps = cfg.caps;
  const minuteStart = Math.floor(now / MINUTE) * MINUTE;
  const fetchFn: FetchLike = ctx.fetch ?? ((u, i) => fetch(u, i));
  const health = ctx.health;
  const pushHealth = (h: SourceHealth) => health.push({ ...h, note: h.note?.slice(0, 160) });

  // the kv rows the minute starts from, in one read
  const keys = [KV_KEYS.on, KV_KEYS.budget, KV_KEYS.book, KV_KEYS.params, KV_KEYS.states, KV_KEYS.prev, KV_KEYS.realised];
  const kv: Record<string, string> = {};
  try {
    const rows = await env.DB.prepare(kvManySql(keys)).bind(...keys).all<{ key: string; value: string }>();
    for (const r of rows.results ?? []) kv[r.key] = r.value;
  } catch (e) {
    pushHealth({ name: DEPTH_HEALTH.pools, ok: false, at: now, note: `the depth kv rows could not be read: ${String(e).slice(0, 100)}` });
    return { skipped: 'kv', rows: [], latest: null, cpuMs: 0, requests: 0, bytes: 0, written: false, budget: budgetFor(null, now) };
  }
  const parse = <T>(k: string): T | null => { try { return kv[k] ? (JSON.parse(kv[k]) as T) : null; } catch { return null; } };
  let budget = budgetFor(parse(KV_KEYS.budget), now);
  const done = (skipped: string, extra: Partial<MinuteResult> = {}): MinuteResult => ({ skipped, rows: [], latest: null, cpuMs: 0, requests: 0, bytes: 0, written: false, budget, ...extra });

  if (killSwitchOff(kv[KV_KEYS.on])) {
    pushHealth({ name: DEPTH_HEALTH.pools, ok: false, at: now, note: KILL_SWITCH_NOTE });
    pushHealth(storeHealth(budget, caps, now, 'off by the kill switch'));
    return done('kill switch');
  }
  if (ctx.late?.()) {
    pushHealth({ name: DEPTH_HEALTH.pools, ok: false, at: now, note: 'Not run this tick: the tick was late before the depth reads could start.' });
    pushHealth(storeHealth(budget, caps, now));
    return done('late');
  }
  const gate0 = gate(budget, caps, 0);
  if (!gate0.writes) {
    // inserts stopped (C3 / C4): nothing is read; the check row and the store row say so every minute
    budget = recordCapHit(budget, gate0.why ?? 'cap', now);
    await batchWithMeta(env.DB, [budgetCheckStmt(budget, caps, now, gate0), budgetKvStmt(budget, now)]).catch((e) => console.error('depth budget row', e));
    pushHealth({ name: DEPTH_HEALTH.pools, ok: false, at: now, note: `Not read this minute: ${gate0.why}` });
    pushHealth(storeHealth(budget, caps, now, null, gate0));
    return done('cap');
  }

  const req = new Requests(caps.requestsPerMinute, ctx.signal, fetchFn, cfg.read.timeoutMs, ctx.clock);
  const params: DepthParamsKv = { ...freshParams(), ...(parse<Partial<DepthParamsKv>>(KV_KEYS.params) ?? {}) };
  params.taker = params.taker ?? {}; params.tokens = params.tokens ?? {};
  let paramsChanged = false;

  // 1. the pool list: the tick's own read, else one request
  let rawList: unknown = ctx.pools ?? null;
  let listAt = ctx.poolsAt ?? now;
  let listRead: ReadOk<unknown> | null = null;
  if (!rawList) {
    const r = await readPoolList(req, cfg);
    if (!isOk(r)) {
      pushHealth({ name: DEPTH_HEALTH.pools, ok: false, at: now, note: `The pool list was not read (${r.error}): nothing written this minute.` });
      pushHealth(storeHealth(budget, caps, now));
      return done('pool list', { requests: req.made, bytes: req.bytes });
    }
    rawList = r.value; listAt = r.at; listRead = r;
  }
  const listed = listPools(cfg, rawList);
  const candidates = listed.filter((p) => p.sides !== 'empty' && !isDust(cfg, p));
  const denoms = counterDenoms(candidates);

  // 2. the counter coins: metadata (once a day), the price list (every minute), taker fees (a few a minute, kept an hour)
  const needMeta = denoms.filter((d) => !cfg.quoteCoins[d] && (!params.tokens[d] || params.tokensAt == null || now - params.tokensAt > cfg.read.metaMaxAgeMs));
  const needPrice = denoms.filter((d) => !cfg.quoteCoins[d]?.usdFixed);
  const takerAge = (d: string) => (params.taker[d] ? now - params.taker[d].at : Infinity);
  const needTaker = denoms.filter((d) => takerAge(d) > cfg.read.takerMaxAgeMs).sort((a, b) => takerAge(b) - takerAge(a)).slice(0, cfg.read.takerReadsPerMinute);
  const [metaRead, priceRead, takerReads] = await Promise.all([
    needMeta.length ? readTokenMeta(req, cfg, needMeta) : Promise.resolve(null),
    needPrice.length ? readPriceList(req, cfg, needPrice) : Promise.resolve(null),
    Promise.all(needTaker.map(async (d) => [d, await readTakerFee(req, cfg, d)] as const)),
  ]);
  if (metaRead && isOk(metaRead)) {
    for (const [d, m] of Object.entries(metaRead.value ?? {})) if (m && typeof m.decimals === 'number' && Number.isFinite(m.decimals)) params.tokens[d] = { symbol: String(m.symbol ?? d), decimals: m.decimals };
    params.tokensAt = metaRead.at; params.tokensUrl = metaRead.url; paramsChanged = true;
  }
  for (const [d, r] of takerReads) if (isOk(r)) { params.taker[d] = { fee: r.value, at: r.at, url: r.url }; paramsChanged = true; }
  const priceList = priceRead && isOk(priceRead) ? { value: priceRead.value, at: priceRead.at } : null;
  const counters: Record<string, CounterInfo> = {};
  for (const d of denoms) counters[d] = counterInfo(cfg, d, priceList, params.tokens[d] ?? null, params.taker[d] ?? null);
  const set = liveSet(cfg, listed, counters);

  // 3. the chain reads, together: the concentrated pools in one batch (chunked to the node's cap), each book, the estimate
  const clPools = set.live.filter((p) => p.type === 'concentrated');
  const bookPools = set.live.filter((p) => p.type === 'cosmwasm' && p.book);
  const queries: AbciQuery[] = clPools.flatMap((p) => [poolQuery(p.id), tickSubspaceQuery(p.id)]);
  const refListed = set.live.find((p) => p.id === cfg.refPoolId);
  const refCounter = refListed?.counterDenom ? counters[refListed.counterDenom] : undefined;
  const estimateSize = BigInt(cfg.sizes[0]) * 10n ** BigInt(cfg.base.decimals);
  const prevBook = parse<BookKv>(KV_KEYS.book);
  const [answers, books, estimate, swaps] = await Promise.all([
    queries.length ? rpcBatch(req, cfg, queries) : Promise.resolve([]),
    Promise.all(bookPools.map((p) => readBook(req, cfg, p.book!.contract, prevBook, now))),
    refListed?.type === 'concentrated' && refCounter?.denom ? readEstimate(req, cfg, cfg.refPoolId, estimateSize, refCounter.denom) : Promise.resolve(null),
    env.DB.prepare(`SELECT id, ts, kind, pool_id, meta FROM flows WHERE chain = 'osmosis' AND kind IN ('buy', 'sell') AND ts >= ? AND ts < ? ORDER BY ts DESC LIMIT 200`)
      .bind(now - cfg.checks.executedWindowMs, now + MINUTE).all<SwapLike>().then((r) => r.results ?? [], () => [] as SwapLike[]),
  ]);

  // 4. each pool's model from what was read
  const builds: PoolBuild[] = [];
  const fallback: ListedPool[] = [];
  for (const p of set.live) {
    const info = counters[p.counterDenom!];
    const b: PoolBuild = { listed: p, info, model: null, read: { error: 'not read', at: now }, height: null, at: listAt, error: null, state: null };
    const base = { id: p.id, type: p.type, counterDenom: p.counterDenom!, counterUsd: info.usd!, counterDecimals: info.decimals!, taker: info.taker!, spread: p.spread };
    try {
      if (p.type === 'concentrated') {
        const i = clPools.indexOf(p) * 2;
        const [ap, at] = [answers[i], answers[i + 1]];
        if (!ap || !at || ap.code !== 0 || at.code !== 0 || !isOk(ap.read)) {
          b.error = ap && !isOk(ap.read) ? ap.read.error : `chain node code ${ap?.code ?? -1}${ap?.log ? `: ${ap.log.slice(0, 60)}` : ''}${at && at.code !== 0 ? ` / ticks code ${at.code}` : ''}`;
          b.read = { error: b.error, at: ap?.read.at ?? now, url: ap?.read.url };
          fallback.push(p);
        } else {
          const wire = decodePool(ap.value);
          const pool: ClPoolState = { token0: wire.token0, token1: wire.token1, current_sqrt_price: wire.current_sqrt_price, current_tick: wire.current_tick, tick_spacing: wire.tick_spacing, exponent_at_price_one: wire.exponent_at_price_one, spread_factor: wire.spread_factor, current_tick_liquidity: wire.current_tick_liquidity };
          const ranges = rangesFromTicks(decodeTickInfos(at.value));
          const m = clModel(pool, ranges, cfg.base.denom);
          b.model = m; b.height = ap.height; b.at = ap.read.at; b.read = readOf(ap.read);
          b.cl = { currentTick: m.currentTick, liquidity: m.L, ranges: m.ranges };
          b.state = { ...base, spread: m.spread, at: b.at, height: b.height, cl: { pool, ranges } };
        }
      } else if (p.type === 'balancer' && p.gamm) {
        b.model = balancerModel(p.gamm.assets, p.gamm.swapFee, cfg.base.denom);
        b.read = listRead ? readOf(listRead) : { url: `${cfg.hosts.sqs}/pools?filter[denom]=${encodeURIComponent(cfg.base.denom)}`, at: listAt, height: null, bytes: 0, ms: 0, status: 200 };
        b.state = { ...base, spread: p.gamm.swapFee, at: listAt, height: null, gamm: { assets: p.gamm.assets } };
      } else if (p.type === 'stableswap' && p.stable) {
        b.model = stableswapModel(p.stable.liquidity, p.stable.scaling, p.stable.swapFee, cfg.base.denom);
        b.read = listRead ? readOf(listRead) : { url: `${cfg.hosts.sqs}/pools?filter[denom]=${encodeURIComponent(cfg.base.denom)}`, at: listAt, height: null, bytes: 0, ms: 0, status: 200 };
        b.state = { ...base, spread: p.stable.swapFee, at: listAt, height: null, stable: { liquidity: p.stable.liquidity, scaling: p.stable.scaling } };
      } else if (p.type === 'cosmwasm' && p.book) {
        const br = books[bookPools.indexOf(p)];
        b.book = br;
        if (!isOk(br.state) || !br.next) { b.error = !isOk(br.state) ? `book state: ${br.state.error}` : `book ticks: ${errOf(br.ticks)}`; b.read = { error: b.error, at: now, url: br.state.url }; }
        else {
          b.model = orderbookModel(br.bids, br.asks, p.spread);
          b.height = br.state.height; b.at = br.state.at; b.read = readOf(br.state);
          b.state = { ...base, at: b.at, height: b.height, book: { bids: br.bids, asks: br.asks } };
        }
      } else b.error = 'the quote service’s list gives this pool no reserves the module can model';
    } catch (e) {
      b.error = String((e as Error)?.message ?? e).slice(0, 100); b.model = null; b.state = null;
      if (p.type === 'concentrated') fallback.push(p);
    }
    builds.push(b);
  }
  // the gateway fallback (plan 1.2 c): at most a few pools, within the cap and the phase
  for (const p of fallback.slice(0, cfg.read.lcdFallbackPools)) {
    if (req.made >= req.max || ctx.signal?.aborted) break;
    const b = builds.find((x) => x.listed === p)!;
    const r = await readClPoolLcd(req, cfg, p.id);
    if (isOk(r.pool) && isOk(r.ranges)) {
      try {
        const m = clModel(r.pool.value, r.ranges.value, cfg.base.denom);
        b.model = m; b.error = null; b.height = r.pool.height; b.at = r.pool.at; b.read = readOf(r.pool);
        b.cl = { currentTick: m.currentTick, liquidity: m.L, ranges: m.ranges };
        b.state = { id: p.id, type: p.type, counterDenom: p.counterDenom!, counterUsd: b.info.usd!, counterDecimals: b.info.decimals!, taker: b.info.taker!, spread: m.spread, at: b.at, height: b.height, cl: { pool: r.pool.value, ranges: r.ranges.value } };
      } catch (e) { b.error = `gateway answer: ${String((e as Error)?.message ?? e).slice(0, 80)}`; }
    } else b.error = `${b.error}; gateway: ${errOf(isOk(r.pool) ? r.ranges : r.pool)}`;
  }

  // 5. the reference price: the reference pool's own spot
  const refBuild = builds.find((b) => b.listed.id === cfg.refPoolId);
  const refUsd = refBuild?.model?.spotRaw != null && refBuild.info.usd != null && refBuild.info.decimals != null ? refBuild.model.spotRaw * usdPerRaw({ counterUsd: refBuild.info.usd, counterDecimals: refBuild.info.decimals }, cfg.base.decimals) : null;
  const states: DepthStates[] = [parse<DepthStates>(KV_KEYS.prev), parse<DepthStates>(KV_KEYS.states)].filter((s): s is DepthStates => !!s);
  const realisedKept = parse<Realised[]>(KV_KEYS.realised) ?? [];
  const checkStmts: Stmt[] = [];

  const cpu0 = performance.now();
  // check 3 runs on the stored states whatever this minute read
  const executed = executedCheck(cfg, swaps, states, Array.isArray(realisedKept) ? realisedKept : [], now);
  checkStmts.push(executed.stmt);
  const realisedChanged = JSON.stringify(executed.kept) !== JSON.stringify(realisedKept);

  if (!(refUsd != null && refUsd > 0) || !refBuild) {
    const why = refBuild ? refBuild.error ?? (refBuild.info.why ?? 'its spot or its coin’s price is missing') : set.unpriced.find((u) => u.pool.id === cfg.refPoolId)?.why ?? 'not in the live set';
    checkStmts.push(stmt.check('depth_vs_chain_estimate', 'idle', DEPTH_CHECK_TITLES.depth_vs_chain_estimate, { note: `reference pool ${cfg.refPoolId} not read: ${why}` }, now));
    checkStmts.push(stmt.check('depth_vs_route_quote', 'idle', DEPTH_CHECK_TITLES.depth_vs_route_quote, { note: `reference pool ${cfg.refPoolId} not read: ${why}` }, now));
    const cpuMs = performance.now() - cpu0;
    budget = recordBytes(budget, req.bytes);
    await ctx.writeAfter;
    const results = await batchWithMeta(env.DB, [...checkStmts, budgetCheckStmt(budget, caps, now), ...(realisedChanged ? [kvStmt(KV_KEYS.realised, executed.kept, now)] : []), ...(paramsChanged ? [kvStmt(KV_KEYS.params, params, now)] : [])]).catch((e) => { console.error('depth checks', e); return null; });
    budget = recordWrites(budget, results, now);
    await env.DB.prepare(budgetKvStmt(budget, now).sql).bind(...budgetKvStmt(budget, now).params).run().catch(() => {});
    pushHealth({ name: DEPTH_HEALTH.pools, ok: false, at: now, note: `Reference pool ${cfg.refPoolId} not read (${why}): no depth row this minute. ${req.made} requests, ${req.bytes} bytes.` });
    pushHealth(storeHealth(budget, caps, now));
    return done('reference pool', { cpuMs, requests: req.made, bytes: req.bytes });
  }

  // 6. the aggregate and every figure of the minute
  const priced = builds.filter((b) => b.model && !b.error && b.info.usd != null && b.info.decimals != null && b.info.taker != null);
  const pricedPools: PricedPool[] = priced.map((b) => ({ id: b.listed.id, type: b.listed.type, model: b.model!, counterUsd: b.info.usd!, counterDecimals: b.info.decimals!, taker: b.info.taker! }));
  const grid = buildGrid(refUsd);
  const agg = aggregate(pricedPools, grid, cfg.base.decimals);
  const sells = cfg.sizes.map((n) => executeSell(agg, pricedPools, n));
  const buys = cfg.sizes.map((n) => executeBuy(agg, pricedPools, n));
  const touch = touchAt(agg, pricedPools, cfg.touchSize);
  const within = withinAt(agg, refUsd);
  const offsets = offsetsAt(agg, refUsd, cfg.offsetsPct);
  const heat = heatAt(agg, refUsd, cfg.heat.edges);
  const levels: DepthLevel[] = levelsOf(pricedPools, cfg.base.decimals);
  const heights = priced.map((b) => b.height).filter((h): h is number => h != null);
  const oneHeight = heights.length && heights.every((h) => h === heights[0]) ? heights[0] : null;
  const notRead = builds.filter((b) => b.error);
  const latestAt = Math.max(listAt, ...priced.map((b) => b.at));
  const fillUsd = (f: DepthFill) => (f.complete ? f.usd : null);
  const rows: DepthMinuteRow[] = [];
  const allNote = [
    notRead.length ? `pools not read: ${notRead.map((b) => `${b.listed.id} (${b.error})`).join(', ')}` : '',
    heights.length > 1 && oneHeight == null ? `pools read at heights ${Math.min(...heights)} to ${Math.max(...heights)}` : '',
    set.cut ? `${set.cut} priced pools cut by the cap of ${caps.poolsMax}` : '',
  ].filter(Boolean).join('; ');
  rows.push({
    minute: minuteStart, pool_id: 'all', at: latestAt, height: oneHeight ?? (heights.length ? Math.min(...heights) : null), ref_usd: refUsd, spot_usd: null,
    bid: offsets.bid, ask: offsets.ask, sell: sells.map(fillUsd), buy: buys.map(fillUsd), best_bid: touch.bestBidEff, best_ask: touch.bestAskEff,
    bid_usd: within.totalBidUsd, ask_nam: within.totalAskNam, nam: null, counter: null, counter_usd: null, heat_bid: packF32(heat.bid), heat_ask: packF32(heat.ask), note: allNote || null,
  });
  const pools: DepthPool[] = [];
  for (const b of builds) {
    const i = priced.indexOf(b);
    const whole = (v: number, dec: number | null) => (dec == null ? null : v / 10 ** dec);
    const counterWhole = whole(b.listed.counterBase, b.info.decimals);
    const counterValue = counterValueUsd(b.listed, b.info);
    const spotUsd = b.model?.spotRaw != null && b.info.usd != null && b.info.decimals != null ? b.model.spotRaw * usdPerRaw({ counterUsd: b.info.usd, counterDecimals: b.info.decimals }, cfg.base.decimals) : null;
    const own = i >= 0 ? aggregateOfCurves(grid, [agg.perPool[i]]) : null;
    const ownPools = [{ id: b.listed.id }];
    const ownSells = own ? cfg.sizes.map((n) => executeSell(own, ownPools, n)) : null;
    const ownBuys = own ? cfg.sizes.map((n) => executeBuy(own, ownPools, n)) : null;
    const ownTouch = own ? touchAt(own, ownPools, cfg.touchSize) : null;
    const ownWithin = own ? withinAt(own, refUsd) : null;
    const ownOffsets = own ? offsetsAt(own, refUsd, cfg.offsetsPct) : null;
    rows.push({
      minute: minuteStart, pool_id: b.listed.id, at: b.at, height: b.height, ref_usd: refUsd, spot_usd: spotUsd,
      bid: ownOffsets?.bid ?? [], ask: ownOffsets?.ask ?? [], sell: ownSells?.map(fillUsd) ?? [], buy: ownBuys?.map(fillUsd) ?? [],
      best_bid: ownTouch?.bestBidEff ?? null, best_ask: ownTouch?.bestAskEff ?? null, bid_usd: ownWithin?.totalBidUsd ?? null, ask_nam: ownWithin?.totalAskNam ?? null,
      nam: b.listed.baseBase / 10 ** cfg.base.decimals, counter: counterWhole, counter_usd: counterValue, heat_bid: null, heat_ask: null,
      note: b.error ? UNPRICED_NOT_READ(b.error) : null,
    });
    const pool: DepthPool = {
      id: b.listed.id, type: b.listed.type, pair: pairOf(cfg, b.listed, counters), counterDenom: b.listed.counterDenom!, counterSymbol: b.info.symbol, counterDecimals: b.info.decimals,
      counterUsd: b.info.usd, counterUsdHow: b.info.how, spotUsd, spread: b.model?.spread ?? b.listed.spread, taker: b.info.taker, sides: b.listed.sides,
      nam: b.listed.baseBase / 10 ** cfg.base.decimals, counter: counterWhole, counterValueUsd: counterValue, read: b.read,
    };
    if (b.cl) pool.cl = b.cl;
    if (b.book && isOk(b.book.state)) {
      const m = b.model as ReturnType<typeof orderbookModel> | null;
      pool.book = { bids: b.book.bids.map((x) => ({ price: x.price, amount: x.quote / 10 ** (b.info.decimals ?? 0), orders: x.orders ?? 0 })), asks: b.book.asks.map((x) => ({ price: x.price, amount: x.base / 10 ** cfg.base.decimals, orders: x.orders ?? 0 })), orders: Object.values(b.book.next?.ticks ?? {}).reduce((a, t) => a + (t.orders ?? 0), 0), bestBid: m?.bestBid ?? null, bestAsk: m?.bestAsk ?? null, state: { url: b.book.state.url, at: b.book.state.at } };
    }
    pools.push(pool);
  }
  // the unpriced pools: a row each with the reason and the list's balances, no read
  for (const { pool: p, why } of set.unpriced) {
    const c = p.counterDenom ? counters[p.counterDenom] : undefined;
    rows.push({ minute: minuteStart, pool_id: p.id, at: listAt, height: null, ref_usd: refUsd, spot_usd: null, bid: [], ask: [], sell: [], buy: [], best_bid: null, best_ask: null, bid_usd: null, ask_nam: null,
      nam: p.baseBase / 10 ** cfg.base.decimals, counter: c?.decimals != null ? p.counterBase / 10 ** c.decimals : null, counter_usd: counterValueUsd(p, c), heat_bid: null, heat_ask: null, note: why });
  }
  const unpriced: DepthUnpriced[] = [...set.unpriced, ...set.leftOut].map(({ pool: p, why }) => ({ id: p.id, pair: pairOf(cfg, p, counters), why }));

  // check 1: the reference pool's exact walk against the chain's own estimate, at the heights both were read at
  let checkEstimate: DepthChecks['estimate'] = null;
  const refState = refBuild.state?.cl;
  if (refState && refBuild.info.taker != null && estimate && isOk(estimate)) {
    const ours = clSellExact(refState.pool, refState.ranges, cfg.base.denom, estimateSize, refBuild.info.taker).amountOut;
    const diff = pct(Number(ours), Number(estimate.value));
    const sameHeight = estimate.height == null || refBuild.height == null || estimate.height === refBuild.height;
    const status = Math.abs(diff) <= cfg.checks.estimateOkPct ? 'ok' : Math.abs(diff) <= cfg.checks.estimateWarnPct ? 'warn' : 'fail';
    checkEstimate = { nam: cfg.sizes[0], chainUusdc: Number(estimate.value), ours: Number(ours), diffPct: diff, url: estimate.url, at: estimate.at, height: estimate.height };
    checkStmts.push(stmt.check('depth_vs_chain_estimate', status, DEPTH_CHECK_TITLES.depth_vs_chain_estimate, {
      pool: cfg.refPoolId, nam: cfg.sizes[0], chainOut: estimate.value.toString(), ours: ours.toString(), diffPct: diff, okPct: cfg.checks.estimateOkPct, warnPct: cfg.checks.estimateWarnPct,
      height: refBuild.height, estimateHeight: estimate.height, estimateAt: estimate.at, url: estimate.url, source: DEPTH_SOURCES.estimate,
      note: !sameHeight && status !== 'ok' ? 'the estimate and the pool state were read at different heights' : undefined,
    }, now));
  } else {
    checkStmts.push(stmt.check('depth_vs_chain_estimate', 'idle', DEPTH_CHECK_TITLES.depth_vs_chain_estimate, { pool: cfg.refPoolId, note: estimate ? `the estimate did not answer: ${errOf(estimate)}` : refState ? 'the estimate was not asked' : 'the reference pool’s exact state was not read this minute' }, now));
  }
  // check 2: the same walk against the direct quote the price read made this minute
  let checkRoute: DepthChecks['route'] = null;
  if (refState && refBuild.info.taker != null && ctx.routeOut && /^\d+$/.test(ctx.routeOut.amountOut)) {
    const size = BigInt(Math.round(ctx.routeOut.nam)) * 10n ** BigInt(cfg.base.decimals);
    const ours = clSellExact(refState.pool, refState.ranges, cfg.base.denom, size, refBuild.info.taker).amountOut;
    const diff = pct(Number(ours), Number(ctx.routeOut.amountOut));
    const status = Math.abs(diff) <= cfg.checks.routeOkPct ? 'ok' : Math.abs(diff) <= cfg.checks.routeOkPct * 10 ? 'warn' : 'fail';
    checkRoute = { nam: ctx.routeOut.nam, routerUsdc: Number(ctx.routeOut.amountOut), ours: Number(ours), diffPct: diff, at: ctx.routeOut.at };
    checkStmts.push(stmt.check('depth_vs_route_quote', status, DEPTH_CHECK_TITLES.depth_vs_route_quote, { pool: cfg.refPoolId, nam: ctx.routeOut.nam, routerOut: ctx.routeOut.amountOut, ours: ours.toString(), diffPct: diff, okPct: cfg.checks.routeOkPct, quoteAt: ctx.routeOut.at, height: refBuild.height, source: DEPTH_SOURCES.priceList }, now));
  } else {
    checkStmts.push(stmt.check('depth_vs_route_quote', 'idle', DEPTH_CHECK_TITLES.depth_vs_route_quote, { pool: cfg.refPoolId, note: refState ? 'the quote service was not asked a direct quote in the reference pool this minute' : 'the reference pool’s exact state was not read this minute' }, now));
  }

  // the minute's answer (kv depth.latest): the curve thinned, each pool's own further
  const refIndex = grid.findIndex((g) => g >= refUsd);
  const idx = thinIndices(grid.length, Math.max(0, refIndex), CURVE_POINTS_MAX);
  const pidx = thinIndices(grid.length, Math.max(0, refIndex), CURVE_POOL_POINTS_MAX);
  const pick = (a: ArrayLike<number>, ix: number[], d: number) => ix.map((i) => sig(a[i], d));
  const curve: DepthCurve = { price: pick(grid, idx, 6), bidUsd: pick(agg.bidUsd, idx, 6), bidNam: pick(agg.bidNam, idx, 6), askUsd: pick(agg.askUsd, idx, 6), askNam: pick(agg.askNam, idx, 6), perPool: {} };
  pricedPools.forEach((p, i) => { curve.perPool[p.id] = { bidUsd: pick(agg.perPool[i].bidUsd, pidx, 5), askUsd: pick(agg.perPool[i].askUsd, pidx, 5) }; });
  const realisedRecent = executed.kept.filter((r) => r.at >= now - cfg.checks.executedIdleMs).slice(0, cfg.checks.executedKeep);
  const prov: DepthProv[] = req.prov.slice(0, 60);
  const latest: DepthResponse = {
    at: minuteStart, generatedAt: now,
    ref: { pool: cfg.refPoolId, usd: refUsd, height: refBuild.height, at: refBuild.at, source: DEPTH_SOURCES.poolManager, status: 'live' },
    pools, unpriced,
    answer: { sizes: [...cfg.sizes], sell: sells.map(roundFill), buy: buys.map(roundFill) },
    touch, within, offsets,
    book: { levels: levels.map((l) => ({ ...l, loUsd: sig(l.loUsd, 7), hiUsd: sig(l.hiUsd, 7), nam: sig(l.nam, 7), counter: sig(l.counter, 7), counterUsd: sig(l.counterUsd, 7) })) },
    curve,
    checks: { estimate: checkEstimate, route: checkRoute, realised: { n: realisedRecent.length, within1pct: realisedRecent.filter((r) => Math.abs(r.diffPct) <= cfg.checks.executedOkPct).length, lastAt: realisedRecent[0]?.at ?? null } },
    prov, cost: { reads: req.made, bytes: req.bytes, ms: req.ms },
  };
  if (allNote) latest.note = allNote;
  const statesNow: DepthStates = { minute: minuteStart, at: latestAt, ref: { pool: cfg.refPoolId, usd: refUsd, height: refBuild.height }, pools: priced.map((b) => b.state!).filter(Boolean) };
  const cpuMs = performance.now() - cpu0;

  // 7. the writes, after the tick's own batch, each cap checked first
  const bookNext = books.find((b) => b.next)?.next ?? null;
  // written when a tick's totals, the live set or the best ticks moved; the stamp alone is no change
  const bookChanged = !!bookNext && JSON.stringify({ ...bookNext, at: 0 }) !== JSON.stringify(prevBook ? { ...prevBook, at: 0 } : null);
  const rowStmts: Stmt[] = [];
  const rowProblems: string[] = [];
  for (const r of rows) { try { rowStmts.push(minuteStmt(r)); } catch (e) { rowProblems.push(`${r.pool_id}: ${String((e as Error).message).slice(0, 60)}`); } }
  const kvStmts: Stmt[] = [kvStmt(KV_KEYS.latest, latest, now), copyKvStmt(KV_KEYS.states, KV_KEYS.prev), kvStmt(KV_KEYS.states, statesNow, now)];
  if (bookChanged) kvStmts.push(kvStmt(KV_KEYS.book, bookNext, now));
  if (paramsChanged) kvStmts.push(kvStmt(KV_KEYS.params, params, now));
  if (realisedChanged) kvStmts.push(kvStmt(KV_KEYS.realised, executed.kept, now));
  budget = recordBytes(budget, req.bytes);
  const pending = rowStmts.length + kvStmts.length + checkStmts.length + 1;
  const g = gate(budget, caps, pending);
  let written = false;
  await ctx.writeAfter;
  if (g.writes) {
    const results = await batchWithMeta(env.DB, [...rowStmts, ...kvStmts, ...checkStmts, budgetCheckStmt(budget, caps, now)]).catch((e) => { console.error('depth minute batch', e); rowProblems.push(`batch: ${String(e).slice(0, 80)}`); return null; });
    if (results) { budget = recordWrites(budget, results, now); written = true; }
  } else {
    budget = recordCapHit(budget, g.why ?? 'cap', now);
    await batchWithMeta(env.DB, [...checkStmts, budgetCheckStmt(budget, caps, now, g)]).catch((e) => console.error('depth checks', e));
  }
  const bk = budgetKvStmt(budget, now);
  await env.DB.prepare(bk.sql).bind(...bk.params).run().catch((e) => console.error('depth budget kv', e));

  // 8. the health rows
  const readPools = priced.filter((b) => b.listed.type !== 'cosmwasm').length, livePools = set.live.filter((b) => b.type !== 'cosmwasm').length;
  const poolsOk = notRead.filter((b) => b.listed.type !== 'cosmwasm').length === 0 && rowProblems.length === 0 && g.writes;
  pushHealth({ name: DEPTH_HEALTH.pools, ok: poolsOk, at: now, note: [
    `${readPools} of ${livePools} pools read${oneHeight != null ? ` at height ${oneHeight}` : heights.length > 1 ? ` at heights ${Math.min(...heights)} to ${Math.max(...heights)}` : ''}, ${req.bytes} bytes over ${req.made} requests in ${req.ms} ms`,
    !g.writes ? `not written: ${g.why}` : '', req.refused ? `${req.refused} requests over the cap of ${caps.requestsPerMinute}` : '', set.cut ? `${set.cut} cut by the cap of ${caps.poolsMax}` : '',
    rowProblems.length ? `rows not written: ${rowProblems.join('; ')}` : '', notRead.length ? `not read: ${notRead.map((b) => `${b.listed.id} (${b.error})`).join(', ')}` : '',
  ].filter(Boolean).join('; ') });
  pushHealth(storeHealth(budget, caps, now, null, g));
  for (const b of builds.filter((x) => x.book)) {
    const br = b.book!;
    const ok = isOk(br.state) && !!br.next;
    pushHealth({ name: DEPTH_HEALTH.book, ok, at: now, note: ok
      ? `${br.bids.length} bid levels, ${br.asks.length} ask levels${br.how === 'listed' ? ' (ticks listed anew)' : ''}, ${br.changed.length} changed; state at ${clockUtc((br.state as ReadOk<unknown>).at)}; ${bookSource(b.listed.id)}`
      : `not read: ${b.error ?? errOf(br.state)}` });
  }
  return { rows, latest, cpuMs, requests: req.made, bytes: req.bytes, written, budget };
}

const roundFill = (f: DepthFill): DepthFill => ({ ...f, usd: sig(f.usd, 7), avgPrice: f.avgPrice == null ? null : sig(f.avgPrice, 7), marginalPrice: sig(f.marginalPrice, 7), filledNam: sig(f.filledNam, 7), split: f.split.map((s) => ({ pool: s.pool, nam: sig(s.nam, 6), usd: sig(s.usd, 6) })) });
