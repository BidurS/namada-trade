// The depth jobs (plan section 1). The minute job: every minute, inside its own phase of the cron tick, read the live pools'
// state from the chain (one JSON-RPC batch for the concentrated pools, the order book's state and live ticks, the
// chain's own estimate for the check), put every pool on the USD axis, write one depth_minute row per live pool and one
// for the aggregate with its heat bands, the minute's answer to kv depth.latest, the raw states to kv depth.states (the
// minute before to depth.prev, for the realised check), the three checks of plan section 5 and the health rows. Every
// figure comes from a read with its source and time or is NULL with the reason; the caps of plan section 7 are checked
// before each write (budget.ts); a failure here never ends the tick (cron.ts catches it). The hourly job (plan 1.3, step
// S3): once an hour in the series window and never on a late tick, read the positions of every live concentrated pool
// and the whole order book with its orders (the owners), the pool parameters governance alone changes, hold the chain's
// answers to the three invariants of plan section 5, write kv depth.owners, the raw state of each live pool to the
// archive, the depth_hourly rollup of the closed hour, the depth_changes rows of what the hour's reading moved against
// the hour before's (diff.ts), and run the retention delete.
//
// Nothing in this file names a coin or a pool: the configuration (config.ts) does, so another Worker runs the same job
// for another Osmosis token.
import type { Env } from '../util';
import { runBatchMeta, stmt, type Stmt } from '../db';
import { fmtClock } from '../digest/types';
import { settleMetaOf, SETTLE_STABLES } from '../../../shared/settle';
import type { SourceHealth } from '../../../shared/types';
import {
  CURVE_POINTS_MAX, CURVE_POOL_POINTS_MAX, DEPTH_CHECK_TITLES, DEPTH_SOURCES, BOOK_LEG_LEFT_OUT, UNPRICED_NOT_READ, bookSource,
  INVARIANT_WORDS, OWNERS_NO_ARCHIVE, BOOK_NOT_READ_CLOSING, OWNERS_NO_MINUTE,
  type DepthChecks, type DepthCurve, type DepthLevel, type DepthPool, type DepthProv, type DepthRead, type DepthReadError, type DepthResponse, type DepthUnpriced, type DepthFill,
  type DepthOwner, type DepthOwnerItem, type DepthOwnersResponse, type DepthChangeRow,
} from '../../../shared/depth';
import { fmtAddr } from '../../../shared/format';
import { NAM_DEPTH, type DepthConfig } from './config';
import {
  aggregate, aggregateOfCurves, balancerModel, buildGrid, clModel, clSellExact, executeBuy, executeBuyUsd, executeSell, heatAt, levelsOf, offsetsAt, orderbookModel, packF32,
  decString, rangesFromTicks, stableswapModel, thinIndices, tickToPrice, touchAt, usdPerRaw, withinAt, type Aggregate, type BookAsk, type BookBid, type ClPoolState, type ClRange, type PoolModel, type PricedPool, type WeightedAsset,
} from './model';
import { decToScaled, decodePool, decodeTickInfos, poolQuery, tickSubspaceQuery, type AbciQuery, type ClPoolWire } from './proto';
import { counterDenoms, counterInfo, counterValueUsd, isDust, listPools, liveSet, pairOf, type CounterInfo, type ListedPool, type TakerFee, type TokenMeta } from './pools';
import {
  Requests, isOk, liq, readBook, readBookFull, readClParams, readClPoolLcd, readEstimate, readGammPool, readPoolList, readPositions, readPriceList, readTakerFee, readTickRanges, readTokenMeta, rpcBatch,
  type BookFullRead, type BookKv, type BookRead, type FetchLike, type GammPoolWire, type OrderRow, type PositionRead, type Read, type ReadOk, type TickRow,
} from './read';
import { KV_KEYS, changeStmt, copyKvStmt, deleteOldMinutesStmts, hourlyRollupStmt, hourlyRowOf, hourlyStmt, kvManySql, kvStmt, minuteStmt, swapsStmt, type DepthHourlyRow, type DepthMinuteRow, type HourlyRollupRead } from './sql';
import { STORE_HEALTH, budgetCheckStmt, budgetFor, budgetKvStmt, gate, killSwitchOff, KILL_SWITCH_NOTE, recordBytes, recordCapHit, recordR2Put, recordWrites, storeHealth, withBudgetRow, type DepthBudget } from './budget';
import { quoteCoinOf } from './config';
import { archiveKey, archiveObject, type ArchiveResult } from './archive';
import { diffItems, minuteItemsOf, ownerItemsOf, usdPerState, type ChangeItem } from './diff';
import { hoursToRoll, HOURLY_CATCH_UP, JOB_WINDOW_MS, JOB_CLOSING_MS } from '../series';

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
  /** depth_changes rows written this minute: what moved against the minute before (diff.ts). */
  changes: number;
  budget: DepthBudget;
}

/**
 * What the module keeps of its parameters between ticks (kv depth.params): taker fees by counter denom and token
 * metadata with their read times (the minute), and what governance alone changes, read once an hour (plan 1.3 c): each
 * weighted or stable pool's own object (weights, swap fee, scaling factors) and the concentrated-liquidity module's
 * parameters, each with the time and URL it was read at.
 */
export interface DepthParamsKv {
  taker: Record<string, TakerFee>;
  tokens: Record<string, TokenMeta>;
  tokensAt: number | null;
  tokensUrl: string | null;
  gamm?: Record<string, { pool: GammPoolWire; at: number; url: string; height: number | null }>;
  clParams?: { value: Record<string, unknown>; at: number; url: string; height: number | null } | null;
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
  /** The book's contract (so the hourly job reads the same book), its levels as read. */
  book?: { contract?: string; bids: BookBid[]; asks: BookAsk[] };
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
const errOf = (r: Read<unknown> | null | undefined): string => (r && !isOk(r) ? r.error : 'no answer');
const readOf = (r: ReadOk<unknown>): DepthRead => ({ url: r.url, at: r.at, height: r.height, bytes: r.bytes, ms: r.ms, status: r.status });
/** Writes the kv depth.budget row (counted as the one row it is) and returns the counters as written. */
async function writeBudget(db: D1Database, budget: DepthBudget, now: number): Promise<DepthBudget> {
  const b = withBudgetRow(budget);
  const bk = budgetKvStmt(b, now);
  await db.prepare(bk.sql).bind(...bk.params).run().catch((e) => console.error('depth budget kv', e));
  return b;
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
    // the settle record's base-coin field is named after this site's coin by the shared helper (shared/settle.ts); it is the trader's gross base coins
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
    note: status === 'idle' ? 'no trade the check could walk in the last day' : 'one pool is known to fill a tenth of a percent better than its tick map says, one way only (the research replay of 28 Oct 2026); that is inside the tolerance',
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
    return { skipped: 'kv', rows: [], latest: null, cpuMs: 0, requests: 0, bytes: 0, written: false, changes: 0, budget: budgetFor(null, now) };
  }
  const parse = <T>(k: string): T | null => { try { return kv[k] ? (JSON.parse(kv[k]) as T) : null; } catch { return null; } };
  let budget = budgetFor(parse(KV_KEYS.budget), now);
  const done = (skipped: string, extra: Partial<MinuteResult> = {}): MinuteResult => ({ skipped, rows: [], latest: null, cpuMs: 0, requests: 0, bytes: 0, written: false, changes: 0, budget, ...extra });

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
    const results = await runBatchMeta(env.DB, [budgetCheckStmt(budget, caps, now, gate0)]).catch((e) => { console.error('depth budget row', e); return null; });
    budget = await writeBudget(env.DB, recordWrites(budget, results, now), now);
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
  const decimalsKnown = (d: string | null): number | null => (d ? quoteCoinOf(cfg, d)?.decimals ?? params.tokens[d]?.decimals ?? null : null);
  const candidates = listed.filter((p) => p.sides !== 'empty' && !isDust(cfg, p, decimalsKnown(p.counterDenom)));
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
    (() => { const q = swapsStmt(cfg.swapsChain, now - cfg.checks.executedWindowMs, now + MINUTE); return env.DB.prepare(q.sql).bind(...q.params).all<SwapLike>().then((r) => r.results ?? [], () => [] as SwapLike[]); })(),
  ]);

  // 4. each pool's model from what was read. A weighted or stable pool's figures come from the pool list: the module's
  //    own read when it made one, else the list the tick handed in, whose size, time and status the module never saw.
  const listReadRecord = (): DepthRead => (listRead ? readOf(listRead) : { url: `${cfg.hosts.sqs}/pools?filter[denom]=${encodeURIComponent(cfg.base.denom)}`, at: listAt, height: null });
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
        b.read = listReadRecord();
        b.state = { ...base, spread: p.gamm.swapFee, at: listAt, height: null, gamm: { assets: p.gamm.assets } };
      } else if (p.type === 'stableswap' && p.stable) {
        b.model = stableswapModel(p.stable.liquidity, p.stable.scaling, p.stable.swapFee, cfg.base.denom);
        b.read = listReadRecord();
        b.state = { ...base, spread: p.stable.swapFee, at: listAt, height: null, stable: { liquidity: p.stable.liquidity, scaling: p.stable.scaling } };
      } else if (p.type === 'cosmwasm' && p.book) {
        const br = books[bookPools.indexOf(p)];
        b.book = br;
        if (!isOk(br.state) || !br.next) { b.error = !isOk(br.state) ? `book state: ${br.state.error}` : `book ticks: ${errOf(br.ticks)}`; b.read = { error: b.error, at: now, url: br.state.url }; }
        else {
          b.model = orderbookModel(br.bids, br.asks, p.spread);
          b.height = br.state.height; b.at = br.state.at; b.read = readOf(br.state);
          b.state = { ...base, at: b.at, height: b.height, book: { contract: p.book.contract, bids: br.bids, asks: br.asks } };
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
    const results = await runBatchMeta(env.DB, [...checkStmts, budgetCheckStmt(budget, caps, now), ...(realisedChanged ? [kvStmt(KV_KEYS.realised, executed.kept, now)] : []), ...(paramsChanged ? [kvStmt(KV_KEYS.params, params, now)] : [])]).catch((e) => { console.error('depth checks', e); return null; });
    budget = await writeBudget(env.DB, recordWrites(budget, results, now), now);
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
  const balancesNote = (at: number) => `balances from the pool list read at ${fmtClock(at)}`;
  const rows: DepthMinuteRow[] = [];
  const allNote = [
    notRead.length ? `pools not read: ${notRead.map((b) => `${b.listed.id} (${b.error})`).join(', ')}` : '',
    heights.length > 1 && oneHeight == null ? `pools read at heights ${Math.min(...heights)} to ${Math.max(...heights)}` : '',
    set.cut ? `${set.cut} priced pools cut by the cap of ${caps.poolsMax}` : '',
  ].filter(Boolean).join('; ');
  rows.push({
    minute: minuteStart, pool_id: 'all', at: latestAt, height: oneHeight, ref_usd: refUsd, spot_usd: null,
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
      // the balances are the pool list's, read by the tick before the chain read behind `at`: the row says when
      note: b.error ? UNPRICED_NOT_READ(b.error) : b.at !== listAt ? balancesNote(listAt) : null,
    });
    const pool: DepthPool = {
      id: b.listed.id, type: b.listed.type, pair: pairOf(cfg, b.listed, counters), counterDenom: b.listed.counterDenom!, counterSymbol: b.info.symbol, counterDecimals: b.info.decimals,
      counterUsd: b.info.usd, counterUsdHow: b.info.how, spotUsd, spread: b.model?.spread ?? b.listed.spread, taker: b.info.taker, sides: b.listed.sides,
      nam: b.listed.baseBase / 10 ** cfg.base.decimals, counter: counterWhole, counterValueUsd: counterValue, balancesAt: listAt, read: b.read,
    };
    if (b.cl) pool.cl = b.cl;
    if (b.book && isOk(b.book.state)) {
      const m = b.model as ReturnType<typeof orderbookModel> | null;
      // an order count the minute has not read is null, never 0; the total is known only when every live tick's count is
      const ticks = Object.values(b.book.next?.ticks ?? {});
      const ordersUnknown = ticks.filter((t) => t.orders == null).length;
      pool.book = {
        bids: b.book.bids.map((x) => ({ price: x.price, amount: x.quote / 10 ** (b.info.decimals ?? 0), orders: x.orders ?? null })),
        asks: b.book.asks.map((x) => ({ price: x.price, amount: x.base / 10 ** cfg.base.decimals, orders: x.orders ?? null })),
        orders: ordersUnknown ? null : ticks.reduce((a, t) => a + (t.orders ?? 0), 0), ordersUnknown,
        bestBid: m?.bestBid ?? null, bestAsk: m?.bestAsk ?? null, state: { url: b.book.state.url, at: b.book.state.at },
      };
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
    checkEstimate = { nam: cfg.sizes[0], chainOut: Number(estimate.value), ours: Number(ours), diffPct: diff, url: estimate.url, at: estimate.at, height: estimate.height };
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
    checkRoute = { nam: ctx.routeOut.nam, routerOut: Number(ctx.routeOut.amountOut), ours: Number(ours), diffPct: diff, at: ctx.routeOut.at };
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
  // what moved since the minute before (diff.ts): the ranges and reserves of the pools both minutes read, each row at
  // its pool's height this minute; nothing when there is no stored minute before this one
  const prevStates = parse<DepthStates>(KV_KEYS.states);
  const changes: DepthChangeRow[] = [];
  if (prevStates && Array.isArray(prevStates.pools)) {
    const both = new Set(statesNow.pools.map((p) => p.id).filter((id) => prevStates.pools.some((p) => p.id === id)));
    const heightOf = new Map(statesNow.pools.map((p) => [p.id, p.height]));
    for (const c of diffItems(minuteItemsOf(cfg, prevStates).filter((i) => both.has(i.pool)), minuteItemsOf(cfg, statesNow).filter((i) => both.has(i.pool)), latestAt, null)) changes.push({ ...c, height: heightOf.get(c.pool) ?? null });
  }
  const cpuMs = performance.now() - cpu0;

  // 7. the writes, after the tick's own batch, each cap checked first
  const bookNext = books.find((b) => b.next)?.next ?? null;
  // written when a tick's totals, the live set or the best ticks moved; the stamp alone is no change
  const bookChanged = !!bookNext && JSON.stringify({ ...bookNext, at: 0 }) !== JSON.stringify(prevBook ? { ...prevBook, at: 0 } : null);
  const rowStmts: Stmt[] = [];
  const rowProblems: string[] = [];
  for (const r of rows) { try { rowStmts.push(minuteStmt(r)); } catch (e) { rowProblems.push(`${r.pool_id}: ${String((e as Error).message).slice(0, 60)}`); } }
  for (const c of changes) { try { rowStmts.push(changeStmt(c)); } catch (e) { rowProblems.push(`change ${c.pool} ${c.ref}: ${String((e as Error).message).slice(0, 60)}`); } }
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
    const results = await runBatchMeta(env.DB, [...rowStmts, ...kvStmts, ...checkStmts, budgetCheckStmt(budget, caps, now)]).catch((e) => { console.error('depth minute batch', e); rowProblems.push(`batch: ${String(e).slice(0, 80)}`); return null; });
    if (results) { budget = recordWrites(budget, results, now); written = true; }
  } else {
    // past the cap the check rows still go in (plan C3: the check says 'fail' every minute), counted like every row
    budget = recordCapHit(budget, g.why ?? 'cap', now);
    const results = await runBatchMeta(env.DB, [...checkStmts, budgetCheckStmt(budget, caps, now, g)]).catch((e) => { console.error('depth checks', e); return null; });
    budget = recordWrites(budget, results, now);
  }
  budget = await writeBudget(env.DB, budget, now);

  // 8. the health rows
  const readPools = priced.filter((b) => b.listed.type !== 'cosmwasm').length, livePools = set.live.filter((b) => b.type !== 'cosmwasm').length;
  // ok when every live pool was read within the phase and the rows went in; the heights may differ (one POST per ten
  // queries, and the book's height is the gateway's), so the note says the heights and the 'all' row's height is NULL
  // when they differ (owner decision 25, build note)
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
    const ticks = Object.values(br.next?.ticks ?? {});
    const unknown = ticks.filter((t) => t.orders == null).length;
    const orders = unknown ? `orders not read for ${unknown} of ${ticks.length} ticks` : `${ticks.reduce((a, t) => a + (t.orders ?? 0), 0)} orders`;
    pushHealth({ name: DEPTH_HEALTH.book, ok, at: now, note: ok
      ? `${br.bids.length} bid levels, ${br.asks.length} ask levels, ${orders}${br.how === 'listed' ? ' (ticks listed anew)' : ''}, ${br.changed.length} changed; state at ${fmtClock((br.state as ReadOk<unknown>).at)}; ${bookSource(b.listed.id)}`
      : `not read: ${b.error ?? errOf(br.state)}` });
  }
  return { rows, latest, cpuMs, requests: req.made, bytes: req.bytes, written, changes: written ? changes.length : 0, budget };
}

const roundFill = (f: DepthFill): DepthFill => ({ ...f, usd: sig(f.usd, 7), avgPrice: f.avgPrice == null ? null : sig(f.avgPrice, 7), marginalPrice: sig(f.marginalPrice, 7), filledNam: sig(f.filledNam, 7), split: f.split.map((s) => ({ pool: s.pool, nam: sig(s.nam, 6), usd: sig(s.usd, 6) })) });

// ---------------------------------------------------------------------------------------------------- the hour
const HOUR = 3_600_000;
/** The series window the hourly jobs run in and its closing stretch: series.ts's own (JOB_WINDOW_MS, JOB_CLOSING_MS), so the two hours never diverge; a test passes its own through HourlyCtx.window. */
export const HOURLY_WINDOW = { ms: JOB_WINDOW_MS, closingMs: JOB_CLOSING_MS } as const;
/** The closed hours the rollup catches up on and the list of them: series.ts's own, the one rule for every hourly rollup. */
export { hoursToRoll, HOURLY_CATCH_UP };

export interface HourlyCtx {
  health: SourceHealth[];
  /** The tick's signal; the job ends its reads with its own budget (caps.hourlyMs) inside it. */
  signal?: AbortSignal;
  late?: () => boolean;
  /** A chain listing is being read this tick: the job waits for a quieter tick of the window, as series.ts does. */
  listingTick?: boolean;
  /** A test's window in place of the series window. */
  window?: { ms: number; closingMs: number };
  /** Resolved when the minute of the same tick has written (cron.ts passes the minute's promise): the hour's writes go after it, on counters read again, so neither job's kv write is lost. */
  writeAfter?: Promise<unknown>;
  fetch?: FetchLike;
  cfg?: DepthConfig;
  clock?: () => number;
}

/** One invariant's outcome: held, not held (a console.error and the owners row's note), or not compared with the reason. */
export interface InvariantResult {
  ok: boolean | null;
  note: string;
}
export interface HourlyInvariants {
  inRange: InvariantResult;
  tickStore: InvariantResult;
  bookTotals: InvariantResult;
}

/** kv depth.owners: the hour's positions and orders grouped by owner, with what each reading is and when it was made. */
export interface DepthOwnersKv extends DepthOwnersResponse {
  hour: number;
  positions: { at: number | null; height: number | null; read: boolean; pools: string[]; why?: string };
  /** The orders' reading; when the book was not read this hour, the hour before's orders are carried with their own time. */
  orders: { at: number | null; height: number | null; read: boolean; why?: string };
  invariants: HourlyInvariants;
  notes: string[];
}

export interface HourlyResult {
  skipped?: string;
  hour: number;
  positions: number;
  orders: number;
  requests: number;
  bytes: number;
  written: boolean;
  /** Archive objects written this hour. */
  archived: number;
  archive: ArchiveResult[];
  /** Closed hours rolled into depth_hourly, and the rows. */
  rolled: number[];
  hourlyRows: number;
  changes: number;
  deleted: number;
  invariants: HourlyInvariants | null;
  budget: DepthBudget;
}

const notCompared = (why: string): InvariantResult => ({ ok: null, note: `not compared: ${why}` });

/** Invariant 1 for one pool: the positions whose range holds the current tick, their liquidity summed at 18 decimals, against current_tick_liquidity. */
export function inRangeCheck(positions: { lower_tick: number; upper_tick: number; liquidity: string }[], currentTick: number, currentTickLiquidity: string): { ok: boolean; sum: string; chain: string; n: number } {
  const inRange = positions.filter((p) => p.lower_tick <= currentTick && currentTick < p.upper_tick);
  const sum = inRange.reduce((a, p) => a + decToScaled(p.liquidity, 18), 0n);
  const chain = decToScaled(currentTickLiquidity, 18);
  return { ok: sum === chain, sum: sum.toString(), chain: chain.toString(), n: inRange.length };
}
/** Invariant 2: the tick store walked (rangesFromTicks) against the gateway's liquidity_per_tick_range, range by range at 18 decimals. */
export function tickStoreCheck(walked: ClRange[], gateway: ClRange[]): { ok: boolean; walked: number; gateway: number; firstDiff: string | null } {
  if (walked.length !== gateway.length) return { ok: false, walked: walked.length, gateway: gateway.length, firstDiff: `${walked.length} ranges walked, ${gateway.length} served` };
  for (let i = 0; i < walked.length; i++) {
    const a = walked[i], b = gateway[i];
    if (Number(a.lower_tick) !== Number(b.lower_tick) || Number(a.upper_tick) !== Number(b.upper_tick) || decToScaled(String(a.liquidity_amount), 18) !== decToScaled(String(b.liquidity_amount), 18)) {
      return { ok: false, walked: walked.length, gateway: gateway.length, firstDiff: `range ${i}: walked ${a.lower_tick}..${a.upper_tick} ${a.liquidity_amount}, served ${b.lower_tick}..${b.upper_tick} ${b.liquidity_amount}` };
    }
  }
  return { ok: true, walked: walked.length, gateway: gateway.length, firstDiff: null };
}
/**
 * Invariant 3: each live tick's totals against the sum of its orders' remaining quantities, each side, compared at 18
 * decimal places (a tick's total is a decimal field of the contract, an order's quantity a whole number of base units).
 * A figure that is not a number is a difference with the figure named, never a thrown error.
 */
export function bookTotalsCheck(ticks: TickRow[], orders: Record<string, Read<OrderRow[]>>): { ok: boolean; compared: number; notRead: number; firstDiff: string | null } {
  let compared = 0, notRead = 0, firstDiff: string | null = null;
  const scaled = (v: string): bigint | null => { try { return decToScaled(v, 18); } catch { return null; } };
  for (const t of ticks) {
    const r = orders[String(t.tick_id)];
    if (!r || !isOk(r)) { notRead++; continue; }
    compared++;
    for (const side of ['bid', 'ask'] as const) {
      if (firstDiff) break;
      const totalText = liq(t.tick_state?.[`${side}_values`]);
      const total = scaled(totalText);
      if (total == null) { firstDiff = `tick ${t.tick_id} ${side}: total ${totalText} is not a number`; break; }
      let sum = 0n;
      for (const o of r.value.filter((o) => o.order_direction === side)) {
        const q = scaled(String(o.quantity ?? '0'));
        if (q == null) { firstDiff = `tick ${t.tick_id} ${side}: order ${String(o.order_id)} quantity ${String(o.quantity)} is not a number`; break; }
        sum += q;
      }
      if (!firstDiff && total !== sum) firstDiff = `tick ${t.tick_id} ${side}: total ${totalText}, orders ${decString(sum, 18).replace(/\.?0+$/, '')}`;
    }
  }
  return { ok: !firstDiff, compared, notRead, firstDiff };
}

/**
 * kv depth.owners under `max` bytes (plan 1.5): the items of the smallest owners are left out first, by halves (their
 * totals, counts and pools stay, so the list and the shares are whole), then the provenance list is cut; the note says
 * what was left out and goes first in the row's notes. Serialised once per step, with the notes in place.
 */
export function fitOwners(kv: DepthOwnersKv, notes: readonly string[], max: number): { text: string; note: string | null; short: string | null } {
  const ser = (extra: string | null) => { kv.notes = [...(extra ? [extra] : []), ...notes].slice(0, 20); return JSON.stringify(kv); };
  let text = ser(null);
  if (text.length <= max) return { text, note: null, short: null };
  const size = text.length, total = kv.owners.length, full = kv.owners;
  let keep = total, note = `kv depth.owners would be ${size} bytes, over the cap of ${max}`;
  while (text.length > max && keep > 0) {
    keep = Math.floor(keep / 2);
    kv.owners = full.map((o, i) => (i < keep ? o : { ...o, items: [] }));
    note = `kv depth.owners would be ${size} bytes, over the cap of ${max}: the items of ${total - keep} of ${total} owners are left out (their totals and counts are kept)`;
    text = ser(note);
  }
  if (text.length > max) { kv.prov = kv.prov.slice(0, 10); note += '; the provenance list is cut to ten reads'; text = ser(note); }
  // the health row's form, short enough to fit beside the hour's figures
  return { text, note, short: `kv depth.owners over its cap: the items of ${total - keep} of ${total} owners left out` };
}

/** A position as an owner's item: its range in USD (the pool's orientation decides which tick is the low price), its two amounts, whether it holds the price. */
export function positionItem(cfg: DepthConfig, s: StoredPoolState, pool: Pick<ClPoolWire, 'token0' | 'exponent_at_price_one' | 'current_tick'>, p: PositionRead): DepthOwnerItem {
  const k = usdPerState(s, cfg.base.decimals), exp = Number(pool.exponent_at_price_one), namIs0 = pool.token0 === cfg.base.denom;
  const lo = namIs0 ? tickToPrice(p.lower_tick, exp) : 1 / tickToPrice(p.upper_tick, exp);
  const hi = namIs0 ? tickToPrice(p.upper_tick, exp) : 1 / tickToPrice(p.lower_tick, exp);
  const amountOf = (denom: string) => Number((p.asset0?.denom === denom ? p.asset0 : p.asset1?.denom === denom ? p.asset1 : null)?.amount ?? 0);
  const nam = amountOf(cfg.base.denom) / 10 ** cfg.base.decimals;
  const counter = amountOf(s.counterDenom) / 10 ** s.counterDecimals;
  const tick = Number(pool.current_tick);
  const item: DepthOwnerItem = { pool: s.id, kind: 'position', id: p.position_id, loUsd: lo * k, hiUsd: hi * k, nam, usd: counter * s.counterUsd, since: p.join_time, liquidity: p.liquidity, inRange: p.lower_tick <= tick && tick < p.upper_tick };
  if (!item.inRange) item.side = p.upper_tick <= tick ? (namIs0 ? 'bid' : 'ask') : namIs0 ? 'ask' : 'bid';
  return item;
}
/** An order as an owner's item: an ask rests in the base coin, a bid in the counter coin, at the tick's price. */
export function orderItem(cfg: DepthConfig, s: StoredPoolState, o: OrderRow): DepthOwnerItem {
  const price = tickToPrice(o.tick_id) * usdPerState(s, cfg.base.decimals);
  const q = Number(o.quantity ?? 0), placed = Number(o.placed_quantity ?? 0);
  const whole = (v: number) => (o.order_direction === 'ask' ? v / 10 ** cfg.base.decimals : v / 10 ** s.counterDecimals);
  const nam = o.order_direction === 'ask' ? whole(q) : price > 0 ? (whole(q) * s.counterUsd) / price : 0;
  const usd = o.order_direction === 'ask' ? whole(q) * price : whole(q) * s.counterUsd;
  let since: number | null = null;
  try { since = o.placed_at ? Number(BigInt(o.placed_at) / 1_000_000n) : null; } catch { since = null; }
  return { pool: s.id, kind: 'order', id: String(o.order_id), side: o.order_direction, loUsd: price, hiUsd: price, nam, usd, since, remaining: whole(q), placed: whole(placed), quantity: String(o.quantity ?? '0') };
}
/** Items grouped by owner, largest in USD first, with each owner's share of the total. */
export function groupOwners(items: { owner: string; item: DepthOwnerItem }[]): { owners: DepthOwner[]; totals: DepthOwnersResponse['totals'] } {
  const by = new Map<string, DepthOwner>();
  for (const { owner, item } of items) {
    const o = by.get(owner) ?? { address: owner, short: fmtAddr(owner), label: null, category: null, pools: [], positions: 0, orders: 0, nam: 0, usd: 0, share: 0, items: [] };
    if (!o.pools.includes(item.pool)) o.pools.push(item.pool);
    if (item.kind === 'position') o.positions++; else o.orders++;
    o.nam += Number.isFinite(item.nam) ? item.nam : 0;
    o.usd += Number.isFinite(item.usd) ? item.usd : 0;
    o.items.push(item);
    by.set(owner, o);
  }
  const owners = [...by.values()].sort((a, b) => b.usd - a.usd || b.nam - a.nam);
  const totals = { nam: owners.reduce((a, o) => a + o.nam, 0), usd: owners.reduce((a, o) => a + o.usd, 0), positions: owners.reduce((a, o) => a + o.positions, 0), orders: owners.reduce((a, o) => a + o.orders, 0) };
  for (const o of owners) o.share = totals.usd > 0 ? o.usd / totals.usd : 0;
  return { owners, totals };
}

/**
 * The hourly job (plan 1.3, section 5's owners row and invariants, 1.6, 1.7). Self-gated like series.hourly: it looks
 * at kv only in the first `window.ms` of an hour, waits for a tick that reads no chain listing unless the window is
 * closing, runs once (kv depth.hourly is the hour it finished), never starts on a late tick and honours the kill switch.
 * Its reads run inside their own budget (caps.hourlyMs, caps.hourlyRequests): the positions and pool states of the
 * concentrated pools in batches, the weighted and stable pools' own objects and the concentrated-liquidity parameters,
 * the gateway's ranges of the reference pool (invariant 2), then the whole book with its orders, which is skipped when
 * the window is closing. Its writes wait for the minute of the same tick (ctx.writeAfter) and go on kv depth.budget and
 * depth.params read again, so the two jobs' counters add up instead of one overwriting the other. kv depth.rolled is
 * the hour whose rollup last went in: an hour spent at the row cap advances depth.hourly (the reads are not repeated)
 * but not depth.rolled, so the rollup catches up once inserts resume. A failure anywhere is a note, never a thrown
 * error; the tick's own work is not waited on.
 */
export async function hourly(env: Env, now: number, ctx: HourlyCtx): Promise<HourlyResult> {
  const cfg = ctx.cfg ?? NAM_DEPTH;
  const caps = cfg.caps;
  const window = ctx.window ?? HOURLY_WINDOW;
  const hour = Math.floor(now / HOUR) * HOUR;
  const health = ctx.health;
  const pushHealth = (h: SourceHealth) => health.push({ ...h, note: h.note?.slice(0, 160) });
  const none = (skipped: string, budget: DepthBudget, extra: Partial<HourlyResult> = {}): HourlyResult => ({ skipped, hour, positions: 0, orders: 0, requests: 0, bytes: 0, written: false, archived: 0, archive: [], rolled: [], hourlyRows: 0, changes: 0, deleted: 0, invariants: null, budget, ...extra });
  if (now % HOUR >= window.ms) return none('outside the window', budgetFor(null, now));
  const closing = now % HOUR >= window.ms - window.closingMs;
  if (ctx.listingTick && !closing) return none('listing tick', budgetFor(null, now));

  // the kv rows the hour starts from: the four small ones on every tick of the window, the readings only once the job runs
  const kv: Record<string, string> = {};
  const readKv = async (keys: string[]) => {
    const rows = await env.DB.prepare(kvManySql(keys)).bind(...keys).all<{ key: string; value: string }>();
    for (const r of rows.results ?? []) kv[r.key] = r.value;
  };
  const parse = <T>(k: string): T | null => { try { return kv[k] ? (JSON.parse(kv[k]) as T) : null; } catch { return null; } };
  try { await readKv([KV_KEYS.on, KV_KEYS.budget, KV_KEYS.hourly, KV_KEYS.rolled]); } catch (e) {
    pushHealth({ name: DEPTH_HEALTH.owners, ok: false, at: now, note: `the depth kv rows could not be read: ${String(e).slice(0, 100)}` });
    return none('kv', budgetFor(null, now));
  }
  let budget = budgetFor(parse(KV_KEYS.budget), now);
  const budget0 = budget;
  const last = parse<number>(KV_KEYS.hourly);
  const lastRolled = parse<number>(KV_KEYS.rolled);
  if (typeof last === 'number' && last >= hour) return none('done', budget);
  // Before any write: the minute of this tick has written (ctx.writeAfter), and the counters are read again with this
  // hour's own additions (bytes, archive puts, a cap hit) put on top of what the minute left, so neither write is lost.
  const settleWithMinute = async (): Promise<Partial<DepthParamsKv>> => {
    await ctx.writeAfter;
    try { await readKv([KV_KEYS.budget, KV_KEYS.params]); } catch (e) { console.error('depth hourly kv read before the writes', e); }
    const fresh = budgetFor(parse(KV_KEYS.budget), now);
    budget = {
      ...fresh, bytesIn: fresh.bytesIn + (budget.bytesIn - budget0.bytesIn), r2Puts: fresh.r2Puts + (budget.r2Puts - budget0.r2Puts), r2Bytes: fresh.r2Bytes + (budget.r2Bytes - budget0.r2Bytes),
      lastCapHit: budget.lastCapHit !== budget0.lastCapHit ? budget.lastCapHit : fresh.lastCapHit,
    };
    return parse<Partial<DepthParamsKv>>(KV_KEYS.params) ?? {};
  };
  if (killSwitchOff(kv[KV_KEYS.on])) { pushHealth({ name: DEPTH_HEALTH.owners, ok: false, at: now, note: KILL_SWITCH_NOTE }); return none('kill switch', budget); }
  if (ctx.late?.()) { pushHealth({ name: DEPTH_HEALTH.owners, ok: false, at: now, note: 'Not run this tick: the tick was late before the hourly depth reads could start; tried again on the next tick of the window.' }); return none('late', budget); }
  try { await readKv([KV_KEYS.states, KV_KEYS.latest, KV_KEYS.owners, KV_KEYS.params, KV_KEYS.book]); } catch (e) {
    pushHealth({ name: DEPTH_HEALTH.owners, ok: false, at: now, note: `the stored minute could not be read: ${String(e).slice(0, 100)}` });
    return none('kv', budget);
  }

  const states = parse<DepthStates>(KV_KEYS.states);
  const latest = parse<DepthResponse>(KV_KEYS.latest);
  const prevOwners = parse<DepthOwnersKv>(KV_KEYS.owners);
  const params: DepthParamsKv = { ...freshParams(), ...(parse<Partial<DepthParamsKv>>(KV_KEYS.params) ?? {}) };
  const bookKv = parse<BookKv>(KV_KEYS.book);
  const live: StoredPoolState[] = states && Array.isArray(states.pools) ? states.pools : [];
  // every pool with rows: the newest answer's pools and its unpriced list, and the aggregate
  const rowIds = [...new Set(['all', ...(latest?.pools ?? []).map((p) => p.id), ...(latest?.unpriced ?? []).map((u) => u.id)])];
  const notes: string[] = [];
  const result: HourlyResult = { hour, positions: 0, orders: 0, requests: 0, bytes: 0, written: false, archived: 0, archive: [], rolled: [], hourlyRows: 0, changes: 0, deleted: 0, invariants: null, budget };

  // the retention delete and the rollup go on whatever the caps say of inserts (C5; plan section 7)
  const deleteStmts = rowIds.length > 1 ? deleteOldMinutesStmts(rowIds, now - caps.retentionMs, caps.deleteLimit) : [];
  const gate0 = gate(budget, caps, 0);
  if (!gate0.writes) {
    budget = recordCapHit(budget, gate0.why ?? 'cap', now);
    await settleWithMinute();
    // the marker says the hour is done (its reads are not repeated at the cap); depth.rolled stays, so the rollup of this hour is caught up once inserts resume
    const results = await runBatchMeta(env.DB, [...deleteStmts, kvStmt(KV_KEYS.hourly, hour, now)]).catch((e) => { console.error('depth hourly deletes', e); return null; });
    budget = recordWrites(budget, results, now);
    result.deleted = (results ?? []).slice(0, deleteStmts.length).reduce((a, r) => a + Number(r?.meta?.changes ?? 0), 0);
    budget = await writeBudget(env.DB, budget, now);
    pushHealth({ name: DEPTH_HEALTH.owners, ok: false, at: now, note: `${result.deleted} old minute rows deleted; not read this hour: ${gate0.why}` });
    pushHealth(storeHealth(budget, caps, now, null, gate0));
    return { ...result, skipped: 'cap', budget };
  }

  // 1. the reads, inside their own budget
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort('hourly budget'), caps.hourlyMs);
  const onAbort = () => ctrl.abort('tick deadline');
  if (ctx.signal?.aborted) ctrl.abort('tick deadline'); else ctx.signal?.addEventListener('abort', onAbort);
  const req = new Requests(caps.hourlyRequests, ctrl.signal, ctx.fetch ?? ((u, i) => fetch(u, i)), cfg.read.timeoutMs, ctx.clock);
  const clPools = live.filter((s) => s.cl);
  const gammPools = live.filter((s) => s.gamm || s.stable);
  const bookPools = live.filter((s) => s.book);
  const ref = clPools.find((s) => s.id === cfg.refPoolId) ?? null;
  let positions: PositionRead[] = [], missing: { pool: string; why: string }[] = [], poolWire: Record<string, { wire: ClPoolWire; height: number | null; at: number }> = {}, refTicks: { ranges: ClRange[]; height: number | null } | null = null;
  let gammReads: [StoredPoolState, Read<GammPoolWire>][] = [], clParamsRead: Read<Record<string, unknown>> | null = null, refRanges: Read<ClRange[]> | null = null;
  const books: { pool: StoredPoolState; contract: string; read: BookFullRead }[] = [];
  let bookSkipped: string | null = null;
  try {
    if (!live.length) notes.push(OWNERS_NO_MINUTE);
    else {
      const extra: AbciQuery[] = [...clPools.map((s) => poolQuery(s.id)), ...(ref ? [tickSubspaceQuery(ref.id)] : [])];
      const [pos, gamm, clp, rr] = await Promise.all([
        clPools.length ? readPositions(req, cfg, clPools.map((s) => s.id), extra) : Promise.resolve(null),
        Promise.all(gammPools.map(async (s) => [s, await readGammPool(req, cfg, s.id)] as [StoredPoolState, Read<GammPoolWire>])),
        readClParams(req, cfg),
        ref ? readTickRanges(req, cfg, ref.id) : Promise.resolve(null),
      ]);
      gammReads = gamm; clParamsRead = clp; refRanges = rr;
      if (pos) {
        positions = pos.positions; missing = pos.missing;
        clPools.forEach((s, i) => {
          const a = pos.extra[i];
          if (a && a.code === 0 && isOk(a.read)) { try { poolWire[s.id] = { wire: decodePool(a.value), height: a.height, at: a.read.at }; } catch (e) { missing.push({ pool: s.id, why: `pool state unreadable: ${String((e as Error)?.message ?? e).slice(0, 60)}` }); } }
          else missing.push({ pool: s.id, why: `pool state: ${a && !isOk(a.read) ? a.read.error : `chain node code ${a?.code ?? -1}`}` });
        });
        const t = ref ? pos.extra[clPools.length] : null;
        if (t && t.code === 0 && isOk(t.read)) { try { refTicks = { ranges: rangesFromTicks(decodeTickInfos(t.value)), height: t.height }; } catch { refTicks = null; } }
      }
      // the book last, the heavy read, not when the window is closing (plan 1.3 b)
      if (bookPools.length) {
        if (closing) bookSkipped = BOOK_NOT_READ_CLOSING;
        else {
          for (const s of bookPools) {
            const contract = s.book?.contract ?? (bookKv?.contract || null);
            if (!contract) { notes.push(`pool ${s.id}: the book’s contract is not known yet`); continue; }
            if (ctrl.signal.aborted || req.made >= req.max) { bookSkipped = `the order book was not read: ${ctrl.signal.aborted ? String(ctrl.signal.reason) : 'the request cap was reached'}`; break; }
            books.push({ pool: s, contract, read: await readBookFull(req, cfg, contract) });
          }
        }
      }
    }
  } catch (e) {
    notes.push(`reads: ${String((e as Error)?.message ?? e).slice(0, 100)}`);
  } finally {
    clearTimeout(timer);
    ctx.signal?.removeEventListener('abort', onAbort);
  }
  budget = recordBytes(budget, req.bytes);
  const at = req.clock();

  // 2. the invariants (plan section 5): a failure is the note and a console.error, never a thrown error; a comparison
  //    that throws (an answer in a shape the check cannot read) is 'not compared' with the error
  const invariants: HourlyInvariants = { inRange: notCompared('no concentrated pool read'), tickStore: notCompared('the reference pool was not read'), bookTotals: notCompared('the order book was not read') };
  const guarded = (which: keyof HourlyInvariants, run: () => void) => { try { run(); } catch (e) { invariants[which] = notCompared(`the check failed: ${String((e as Error)?.message ?? e).slice(0, 80)}`); console.error(`depth owners: ${which}`, e); } };
  guarded('inRange', () => { if (clPools.length) {
    const failed: string[] = [], skipped: string[] = [];
    let compared = 0;
    for (const s of clPools) {
      const w = poolWire[s.id];
      const bad = missing.filter((m) => m.pool === s.id);
      if (!w || bad.length) { skipped.push(`${s.id} (${bad[0]?.why ?? 'no pool state'})`); continue; }
      const c = inRangeCheck(positions.filter((p) => p.pool_id === s.id), Number(w.wire.current_tick), w.wire.current_tick_liquidity);
      compared++;
      if (!c.ok) {
        const heights = [...new Set(positions.filter((p) => p.pool_id === s.id).map((p) => p.height))];
        failed.push(`${s.id}: ${c.n} in range sum ${c.sum}, the pool says ${c.chain}${heights.some((h) => h !== w.height) ? ` (positions at heights ${heights.join(', ')}, the pool at ${w.height})` : ''}`);
      }
    }
    invariants.inRange = failed.length ? { ok: false, note: `not held for ${failed.join('; ')}` } : compared ? { ok: true, note: `${INVARIANT_WORDS.inRange} (${compared} pools${skipped.length ? `; not compared: ${skipped.join(', ')}` : ''})` } : notCompared(skipped.join(', '));
    if (failed.length) console.error('depth owners: in-range liquidity', failed.join('; '));
  } });
  guarded('tickStore', () => { if (ref) {
    if (refTicks && refRanges && isOk(refRanges)) {
      const c = tickStoreCheck(refTicks.ranges, refRanges.value);
      invariants.tickStore = c.ok ? { ok: true, note: `${INVARIANT_WORDS.tickStore} (${c.walked} ranges)` } : { ok: false, note: `not held for pool ${ref.id}: ${c.firstDiff}${refTicks.height !== refRanges.height ? ` (store at height ${refTicks.height}, gateway at ${refRanges.height})` : ''}` };
      if (!c.ok) console.error('depth owners: tick store', invariants.tickStore.note);
    } else invariants.tickStore = notCompared(refRanges && !isOk(refRanges) ? `gateway: ${refRanges.error}` : 'the tick store did not answer');
  } });
  guarded('bookTotals', () => { if (books.length) {
    const fails: string[] = [];
    let compared = 0, notRead = 0;
    for (const b of books) {
      if (!isOk(b.read.ticks)) { fails.push(`${b.pool.id}: ticks not read (${b.read.ticks.error})`); continue; }
      const c = bookTotalsCheck(b.read.ticks.value, b.read.orders);
      compared += c.compared; notRead += c.notRead;
      if (!c.ok) fails.push(`${b.pool.id}: ${c.firstDiff}`);
    }
    invariants.bookTotals = fails.length ? { ok: false, note: `not held for ${fails.join('; ')}` } : compared ? { ok: true, note: `${INVARIANT_WORDS.bookTotals} (${compared} ticks${notRead ? `; ${notRead} ticks’ orders not read` : ''})` } : notCompared('no tick’s orders were read');
    if (fails.length) console.error('depth owners: book totals', fails.join('; '));
  } else if (bookSkipped) invariants.bookTotals = notCompared(bookSkipped); });
  result.invariants = invariants;

  // 3. the owners: this hour's positions, this hour's orders or the hour before's when the book was not read
  const positionPools = clPools.filter((s) => poolWire[s.id] && !missing.some((m) => m.pool === s.id)).map((s) => s.id);
  const items: { owner: string; item: DepthOwnerItem }[] = [];
  for (const p of positions) {
    const s = clPools.find((x) => x.id === p.pool_id);
    const w = poolWire[p.pool_id];
    if (!s || !w || !positionPools.includes(p.pool_id)) continue;
    try { items.push({ owner: p.address, item: positionItem(cfg, s, w.wire, p) }); } catch (e) { notes.push(`position ${p.position_id}: ${String((e as Error)?.message ?? e).slice(0, 60)}`); }
  }
  const bookRead = books.length > 0 && books.every((b) => isOk(b.read.ticks) && !b.read.notAsked.length && Object.values(b.read.orders).every((r) => isOk(r)));
  let orders = 0;
  if (bookRead) {
    for (const b of books) for (const r of Object.values(b.read.orders)) if (isOk(r)) for (const o of r.value) { items.push({ owner: o.owner, item: orderItem(cfg, b.pool, o) }); orders++; }
  } else if (prevOwners?.orders?.read || prevOwners?.orders?.at != null) {
    // the hour before's orders, with their own time, so the owners list keeps the book while this hour did not read it
    for (const o of prevOwners.owners ?? []) for (const it of o.items ?? []) if (it.kind === 'order') { items.push({ owner: o.address, item: it }); orders++; }
  }
  const bookWhy = !bookPools.length ? 'no order book in the live set' : bookSkipped ?? (books.length ? `the book answered in part: ${books.map((b) => (!isOk(b.read.ticks) ? b.read.ticks.error : b.read.notAsked.length ? `${b.read.notAsked.length} ticks’ orders not asked (the request cap)` : 'an order read failed')).join('; ')}` : 'not read');
  const bookHeight = books.map((b) => (isOk(b.read.state) ? b.read.state.height : null)).find((h) => h != null) ?? null;
  const grouped = groupOwners(items);
  const posHeights = [...new Set(positions.map((p) => p.height).filter((h): h is number => h != null))];
  const ownersKv: DepthOwnersKv = {
    at, height: posHeights.length === 1 ? posHeights[0] : null, owners: grouped.owners, totals: grouped.totals, prov: req.prov.slice(0, 80), hour,
    positions: { at: positions[0]?.at ?? null, height: posHeights.length === 1 ? posHeights[0] : null, read: positionPools.length === clPools.length && clPools.length > 0, pools: positionPools, ...(missing.length ? { why: missing.map((m) => `${m.pool}: ${m.why}`).join('; ').slice(0, 200) } : {}) },
    orders: bookRead ? { at: books[0]?.read.state.at ?? at, height: bookHeight, read: true } : { at: prevOwners?.orders?.at ?? null, height: prevOwners?.orders?.height ?? null, read: false, why: bookWhy },
    invariants, notes: [],
  };
  result.positions = items.filter((i) => i.item.kind === 'position').length;
  result.orders = orders;

  // 4. what moved since the hour before (diff.ts): positions of the pools both hours read in full, orders when both hours read the book
  const changes: DepthChangeRow[] = [];
  if (prevOwners && Array.isArray(prevOwners.owners)) {
    const prevItems = ownerItemsOf(prevOwners.owners), nextItems = ownerItemsOf(grouped.owners);
    const prevPools = new Set(prevOwners.positions?.pools ?? []);
    const posOk = (i: ChangeItem) => i.ref.startsWith('pos:') && prevPools.has(i.pool) && positionPools.includes(i.pool);
    const ordOk = (i: ChangeItem) => i.ref.startsWith('ord:') && bookRead && !!prevOwners.orders?.read;
    const heightOf = (pool: string) => poolWire[pool]?.height ?? (bookPools.some((b) => b.id === pool) ? bookHeight : null);
    for (const c of diffItems(prevItems.filter((i) => posOk(i) || ordOk(i)), nextItems.filter((i) => posOk(i) || ordOk(i)), at, null)) changes.push({ ...c, height: heightOf(c.pool) });
  }

  // 5. the parameters governance alone changes (plan 1.3 c), each with its read time; put onto the kv row read again before the writes
  const hourGamm: NonNullable<DepthParamsKv['gamm']> = {};
  let hourClParams: DepthParamsKv['clParams'] = null;
  for (const [s, r] of gammReads) if (isOk(r)) hourGamm[s.id] = { pool: r.value, at: r.at, url: r.url, height: r.height }; else notes.push(`pool ${s.id} parameters: ${r.error}`);
  if (clParamsRead && isOk(clParamsRead)) hourClParams = { value: clParamsRead.value, at: clParamsRead.at, url: clParamsRead.url, height: clParamsRead.height };
  else if (clParamsRead) notes.push(`concentrated-liquidity parameters: ${clParamsRead.error}`);
  const paramsChanged = Object.keys(hourGamm).length > 0 || hourClParams != null;
  const gammParamsOf = (id: string) => hourGamm[id] ?? params.gamm?.[id] ?? null;

  // 6. the archive (plan 1.6, C6): one object per live pool and one with the positions and orders, only when the bucket is bound
  const bucket = env.DEPTH_R2;
  if (!bucket) notes.push(OWNERS_NO_ARCHIVE);
  else if (live.length) {
    const readOfState = (s: StoredPoolState) => latest?.pools.find((p) => p.id === s.id)?.read ?? null;
    for (const s of live) {
      const raw: Record<string, unknown> = { pool: s.id, type: s.type, hour, minute: states!.minute, at: s.at, height: s.height, counterDenom: s.counterDenom, counterUsd: s.counterUsd, counterDecimals: s.counterDecimals, taker: s.taker, spread: s.spread, read: readOfState(s) };
      if (s.cl) raw.cl = { pool: s.cl.pool, ranges: s.cl.ranges, state: poolWire[s.id] ?? null, positions: positions.filter((p) => p.pool_id === s.id) };
      if (s.gamm) raw.gamm = { assets: s.gamm.assets, params: gammParamsOf(s.id) };
      if (s.stable) raw.stable = { liquidity: s.stable.liquidity, scaling: s.stable.scaling, params: gammParamsOf(s.id) };
      if (s.book) { const b = books.find((x) => x.pool.id === s.id); raw.book = { contract: s.book.contract ?? null, bids: s.book.bids, asks: s.book.asks, state: b && isOk(b.read.state) ? { value: b.read.state.value, url: b.read.state.url, at: b.read.state.at, height: b.read.state.height } : null, ticks: b && isOk(b.read.ticks) ? b.read.ticks.value : null, orders: b ? Object.fromEntries(Object.entries(b.read.orders).map(([t, r]) => [t, isOk(r) ? r.value : { error: r.error }])) : null, notRead: bookSkipped ?? (b ? null : 'not read') }; }
      const r = await archiveObject(bucket, archiveKey(s.id, hour), raw, caps.r2ObjectMax);
      result.archive.push(r);
      if ('bytes' in r) { budget = recordR2Put(budget, r.bytes); result.archived++; } else notes.push(`archive ${r.key}: ${r.skipped}`);
    }
    const r = await archiveObject(bucket, archiveKey(null, hour), { hour, at, positions, orders: books.map((b) => ({ pool: b.pool.id, contract: b.contract, ticks: isOk(b.read.ticks) ? b.read.ticks.value : null, orders: Object.fromEntries(Object.entries(b.read.orders).map(([t, o]) => [t, isOk(o) ? o.value : { error: o.error }])) })), missing, prov: req.prov }, caps.r2ObjectMax);
    result.archive.push(r);
    if ('bytes' in r) { budget = recordR2Put(budget, r.bytes); result.archived++; } else notes.push(`archive ${r.key}: ${r.skipped}`);
  }

  // 7. the rollup of the closed hour(s) (plan 1.5 depth_hourly): the hour's last minute row with its extremes and count
  const hourlyStmts: Stmt[] = [];
  const rolled = rowIds.length > 1 ? hoursToRoll(typeof lastRolled === 'number' ? lastRolled : null, hour) : [];
  let rollupFailed = false;
  for (const h of rolled) {
    try {
      const reads = await env.DB.batch(rowIds.map((id) => { const q = hourlyRollupStmt(id, h); return env.DB.prepare(q.sql).bind(...q.params); }));
      for (const r of reads) for (const row of ((r as { results?: HourlyRollupRead[] }).results ?? [])) {
        try { hourlyStmts.push(hourlyStmt(hourlyRowOf(row, h))); } catch (e) { notes.push(`hour row ${String(row.pool_id)}: ${String((e as Error)?.message ?? e).slice(0, 60)}`); }
      }
    } catch (e) { rollupFailed = true; notes.push(`rollup of ${new Date(h).toISOString().slice(11, 16)}: ${String((e as Error)?.message ?? e).slice(0, 80)}`); }
  }
  result.rolled = rolled;

  // 8. the writes, after the minute's and on the counters read again, each cap checked first: the inserts behind the
  //    gate, the deletes and the marker always, the rollup marker only when the rollup rows went in
  const changeStmts: Stmt[] = [];
  for (const c of changes) { try { changeStmts.push(changeStmt(c)); } catch (e) { notes.push(`change ${c.pool} ${c.ref}: ${String((e as Error)?.message ?? e).slice(0, 60)}`); } }
  const fit = fitOwners(ownersKv, notes, caps.ownersKvMax);
  // what is said after the kv row is serialised reaches the health row instead
  const lateNotes: string[] = fit.short ? [fit.short] : [];
  const storedParams = await settleWithMinute();
  const paramsNext: DepthParamsKv = { ...freshParams(), ...storedParams, gamm: { ...(storedParams.gamm ?? {}), ...hourGamm }, clParams: hourClParams ?? storedParams.clParams ?? null };
  const inserts: Stmt[] = [...hourlyStmts, ...changeStmts, kvStmt(KV_KEYS.owners, fit.text, now), ...(paramsChanged ? [kvStmt(KV_KEYS.params, paramsNext, now)] : [])];
  const g = gate(budget, caps, inserts.length + 3);
  const rolledMarker = g.writes && !rollupFailed ? [kvStmt(KV_KEYS.rolled, hour, now)] : [];
  const batch = g.writes ? [...inserts, ...deleteStmts, kvStmt(KV_KEYS.hourly, hour, now), ...rolledMarker] : [...deleteStmts, kvStmt(KV_KEYS.hourly, hour, now)];
  if (!g.writes) budget = recordCapHit(budget, g.why ?? 'cap', now);
  const results = await runBatchMeta(env.DB, batch).catch((e) => { console.error('depth hourly batch', e); lateNotes.push(`batch: ${String(e).slice(0, 80)}`); return null; });
  if (results) {
    budget = recordWrites(budget, results, now);
    result.written = g.writes;
    result.hourlyRows = g.writes ? hourlyStmts.length : 0;
    result.changes = g.writes ? changeStmts.length : 0;
    const from = g.writes ? inserts.length : 0;
    result.deleted = results.slice(from, from + deleteStmts.length).reduce((a, r) => a + Number(r?.meta?.changes ?? 0), 0);
  }
  budget = await writeBudget(env.DB, budget, now);
  result.requests = req.made; result.bytes = req.bytes; result.budget = budget;

  // 9. the health rows
  const held = Object.values(invariants).filter((i) => i.ok === true).length, notHeld = Object.values(invariants).filter((i) => i.ok === false);
  const ok = live.length > 0 && ownersKv.positions.read && bookRead && notHeld.length === 0 && !!results && g.writes && lateNotes.length === 0;
  const heightWords = ownersKv.height != null ? ` at height ${ownersKv.height}` : posHeights.length > 1 ? ` at heights ${Math.min(...posHeights)} to ${Math.max(...posHeights)}` : '';
  pushHealth({ name: DEPTH_HEALTH.owners, ok, at: now, note: [
    `${result.positions} positions in ${positionPools.length} of ${clPools.length} pools${heightWords}, ${orders} orders${bookRead ? '' : ` (${bookWhy})`}`,
    notHeld.length ? notHeld.map((i) => i.note).join('; ') : `${held} of 3 invariants held`,
    ...lateNotes,
    `${req.made} requests, ${req.bytes} bytes`, bucket ? `${result.archived} archived` : 'not archived (no bucket bound)',
    !g.writes ? `not written: ${g.why}` : '', missing.length ? `not read: ${missing.map((m) => `${m.pool} (${m.why})`).join(', ')}` : '',
  ].filter(Boolean).join('; ') });
  pushHealth(storeHealth(budget, caps, now, null, g));
  return result;
}
