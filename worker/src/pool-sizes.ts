// Pool sizes from reserves, and the Osmosis answers the cron stores for visitors (scale plan Stage 1, items 1 and 5).
//
// A pool's size was the public router's liquidity_cap (sources/sqs.ts), which counted NAM at nothing while the router
// gave NAM no price (23 Oct to 29 Oct 2026, and on and off since) and moves only in a block where the pool changes:
// pool 3005 read $999 at 13:00 UTC on 29 Oct and $151 at 14:00 with no trade between. It is now each side's coins at
// their own price: a pool the depth minute covers (worker/src/depth/index.ts, the same tick) takes the minute's NAM
// balance at the reference pool's own spot on the chain (ref_usd) plus the minute's counter value (counter_usd); any
// other pool takes the router's reserves, its NAM at the site's own price (this tick's price.usd) and its other coin at
// a price the code already has (Noble USDC and allUSDC as one dollar, the coins quoted each minute, a coin the depth
// minute priced). A side that holds coins and has no price leaves the pool "not priced" with the reason: never 0, never
// liquidity_cap (kept beside it as routerLiquidityUsd, for comparison only).
//
// The cron writes the sized list once a minute (kv osmosis.pools) and the size table it builds (kv quote.curve), so
// /api/overview, /api/pools, /api/series/pairs and /api/quote/curve read stored rows only and never call the router;
// each marks a row old past its age. Only a visitor's own quote (/api/quote) still asks the router.
import type { PoolInfo, Provenance, QuoteCurveResponse, SourceHealth } from '../../shared/types';
import type { DepthResponse } from '../../shared/depth';
import { USDC_AS_ONE } from '../../shared/depth';
import { OSMOSIS } from './config';
import { NAM_DEPTH } from './depth/config';
import { osmoAssets } from './parse/osmosis';
import { fmtClock } from './digest/types';
import { kvGetJson, runBatch, stmt, type Stmt } from './db';

/** The kv row of the sized pool list the cron writes each minute. */
export const POOLS_KEY = 'osmosis.pools';
/** The kv row of the size table the cron builds (sources/sqs.ts buildCurve). */
export const CURVE_KEY = 'quote.curve';
/** The stored pool list is old past this age (the stored pools' threshold the overview used before: ten minutes). */
export const POOLS_STALE_MS = 10 * 60_000;
/**
 * A stored minute figure (the price, the size table) is old past this age: the cron writes one a minute, so one missed
 * tick is not old and two are (the depth minute's own threshold, shared/depth.ts DEPTH_STALE_MS).
 */
export const MINUTE_STALE_MS = 3 * 60_000;

/** The technical source names (web/src/lib/prov.ts says them as "Osmosis pools"). */
export const POOLS_SOURCE = 'Osmosis pool reserves';
export const SIZE_SOURCE = { depth: `${POOLS_SOURCE} (depth minute)`, list: `${POOLS_SOURCE} (pool list)` } as const;

/** The NAM price a pool the depth minute does not cover is valued at: the site's own (this tick's price.usd), with its source and time. */
export interface SitePrice { usd: number; at: number; source: string }

/** What the cron stores each minute (kv osmosis.pools). */
export interface StoredPools {
  /** when the router's pool list behind the reserves was read */
  at: number;
  pools: PoolInfo[];
  /** the depth minute the covered pools came from, when one did */
  depth: { minute: number; at: number; height: number | null; refPool: string; refUsd: number } | null;
  /** the site's NAM price the other pools were valued at, when there was one */
  price: SitePrice | null;
  /** pools the router listed whose address is not a pool account's (sources/sqs.ts fetchNamPools refused) */
  refused?: number;
}

const fin = (x: number | null | undefined): x is number => x != null && Number.isFinite(x);
const usdWords = (v: number) => (v >= 1 ? `$${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : `$${Number(v.toPrecision(3))}`);
const coins = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: v >= 10_000 ? 0 : v >= 1 ? 2 : 6 });

/** The words of a pool that cannot be priced: what is missing, and that it is left out of the total. */
export const notPricedWords = (why: string) => `Not priced: ${why}, so the pool is left out of the total.`;
export const NO_NAM_PRICE = 'the site has no NAM price this minute';
export const noCoinPrice = (coin: string) => `no US dollar price is read for ${coin}`;
export const noCoinDecimals = (coin: string) => `the number of decimals of ${coin} is not known`;

/** A coin's US dollar price as the code already has it, and how it was found. */
interface CoinPrice { usd: number | null; how: string }

/**
 * A counter coin's price where the code already has one: Noble USDC and allUSDC count as one dollar (the depth module's
 * own rule, worker/src/depth/config.ts quoteCoins); a coin the cron quotes each minute (OSMOSIS.quotedCoins) takes this
 * tick's quote; a coin the depth minute priced in another pool takes that price. Anything else has none.
 */
function coinPrice(denom: string, coinUsd: Record<string, number>, coinAt: number | null, depth: DepthResponse | null): CoinPrice {
  if (NAM_DEPTH.quoteCoins[denom]?.usdFixed) return { usd: 1, how: USDC_AS_ONE };
  const quoted = Object.entries(OSMOSIS.quotedCoins).find(([, d]) => d === denom)?.[0];
  if (quoted && fin(coinUsd[quoted]) && coinUsd[quoted] > 0) return { usd: coinUsd[quoted], how: `${quoted} at the Osmosis quote, ${usdWords(coinUsd[quoted])}${coinAt != null ? ` at ${fmtClock(coinAt)}` : ''}` };
  const seen = depth?.pools.find((p) => p.counterDenom === denom && fin(p.counterUsd) && p.counterUsd > 0);
  return seen ? { usd: seen.counterUsd, how: seen.counterUsdHow } : { usd: null, how: '' };
}

/**
 * The decimals of a counter coin as the code already knows them (the depth module's quote coins, the coins the parser
 * names: worker/src/parse/osmosis.ts osmoAssets), else null: the router's list gives base units only.
 */
export function counterDecimals(denom: string): number | null {
  return NAM_DEPTH.quoteCoins[denom]?.decimals ?? osmoAssets().get(denom)?.decimals ?? null;
}

/** The coin's name in words for a note ("USDC", "OSMO"), never a raw denomination. */
const coinName = (p: Pick<PoolInfo, 'counterSymbol'>) => (!p.counterSymbol || p.counterSymbol === 'UNKNOWN' || p.counterSymbol.includes('/') || p.counterSymbol.endsWith('…') ? 'the other coin' : p.counterSymbol);

export interface SizeInput {
  /** the router's pool list this tick (sources/sqs.ts fetchNamPools): reserves, fee, type */
  pools: PoolInfo[];
  /** when the list was read */
  poolsAt: number;
  /** the depth minute of this tick, when it was written (MinuteResult.latest) */
  depth: DepthResponse | null;
  /** the site's NAM price this tick, when there is one */
  price: SitePrice | null;
  /** this tick's quotes of the other coins (fetchNamPrice coinUsd) and when they were read */
  coinUsd?: Record<string, number>;
  coinAt?: number | null;
}

/**
 * Every listed pool with its size from its reserves (see the head of this file), deepest first and the pools not priced
 * after them (most NAM first). A pool the depth minute covers takes the minute's balances and prices; any other pool
 * the router's reserves at the site's price and the coin's own price.
 */
export function sizePools(input: SizeInput): PoolInfo[] {
  const sized = input.pools.map((p) => fromDepth(input.depth, p) ?? fromList(input, p));
  return sized.sort((a, b) => (fin(b.liquidityUsd) ? b.liquidityUsd : -1) - (fin(a.liquidityUsd) ? a.liquidityUsd : -1) || b.namReserve - a.namReserve);
}

/** A pool the depth minute covers: the minute's NAM at the reference pool's own spot plus its counter value; else null. */
function fromDepth(depth: DepthResponse | null, p: PoolInfo): PoolInfo | null {
  const d = depth?.pools.find((x) => x.id === p.id);
  if (!depth || !d || !fin(d.counterValueUsd) || !fin(d.nam) || d.counter == null || !(depth.ref.usd > 0)) return null;
  const namUsd = d.nam * depth.ref.usd;
  const height = 'height' in d.read && d.read.height != null ? d.read.height : depth.ref.height;
  const sizeProv: Provenance = {
    source: SIZE_SOURCE.depth, at: d.balancesAt, height, status: 'live',
    note: `${coins(d.nam)} NAM at pool ${depth.ref.pool}'s own price on the chain, ${usdWords(depth.ref.usd)}${depth.ref.height != null ? ` at height ${depth.ref.height.toLocaleString('en-US')}` : ''}, plus ${coins(d.counter)} ${d.counterSymbol} (${d.counterUsdHow}), from the depth minute of ${fmtClock(depth.at)}.`,
  };
  return { ...p, namReserve: d.nam, counterReserve: d.counter, liquidityUsd: namUsd + d.counterValueUsd, namUsd, counterUsd: d.counterValueUsd, sizeProv };
}

/** Any other pool: the router's reserves, its NAM at the site's price and its other coin at that coin's price, or not priced. */
function fromList(input: SizeInput, p: PoolInfo): PoolInfo {
  const { price } = input;
  const c = coinPrice(p.counterDenom, input.coinUsd ?? {}, input.coinAt ?? null, input.depth);
  const counter = p.counterReserve;
  const why: string[] = [];
  // a side with nothing in it is worth nothing at any price
  const namUsd = p.namReserve === 0 ? 0 : price && price.usd > 0 ? p.namReserve * price.usd : (why.push(NO_NAM_PRICE), null);
  const counterUsd = counter === 0 ? 0
    : counter == null ? (why.push(noCoinDecimals(coinName(p))), null)
    : c.usd != null ? counter * c.usd : (why.push(noCoinPrice(coinName(p))), null);
  if (namUsd == null || counterUsd == null) {
    return { ...p, liquidityUsd: null, namUsd, counterUsd, sizeProv: { source: SIZE_SOURCE.list, at: input.poolsAt, status: 'missing', note: notPricedWords(why.join(' and ')) } };
  }
  const how = [
    p.namReserve > 0 && price ? `${coins(p.namReserve)} NAM at the site's NAM price, ${usdWords(price.usd)} at ${fmtClock(price.at)}` : '',
    counter != null && counter > 0 ? `${coins(counter)} ${coinName(p)} (${c.how})` : '',
  ].filter(Boolean).join(', plus ');
  const sizeProv: Provenance = { source: SIZE_SOURCE.list, at: input.poolsAt, status: 'live', ...(how ? { note: `${how}, from the Osmosis router's pool list read at ${fmtClock(input.poolsAt)}.` } : {}) };
  return { ...p, liquidityUsd: namUsd + counterUsd, namUsd, counterUsd, sizeProv };
}

/** The priced pools' total (null when none is priced), how many are in it, and the pools not priced, left out of it. */
export function poolsTotal(pools: PoolInfo[]): { usd: number | null; priced: number; notPriced: PoolInfo[] } {
  const priced = pools.filter((p) => fin(p.liquidityUsd));
  const notPriced = pools.filter((p) => !fin(p.liquidityUsd));
  return { usd: priced.length ? priced.reduce((a, p) => a + (p.liquidityUsd as number), 0) : null, priced: priced.length, notPriced };
}

/** The stored list's note: where the NAM side was priced, and the pools left out of the total with each one's reason. */
export function poolsNote(row: StoredPools): string {
  const t = poolsTotal(row.pools);
  const fromDepth = row.pools.filter((p) => p.sizeProv?.source === SIZE_SOURCE.depth).length;
  const parts: string[] = [];
  if (row.depth && fromDepth) parts.push(`${fromDepth} of ${row.pools.length} pools from the depth minute of ${fmtClock(row.depth.minute)}${row.depth.height != null ? ` (height ${row.depth.height.toLocaleString('en-US')})` : ''}, NAM at pool ${row.depth.refPool}'s own price of ${usdWords(row.depth.refUsd)}.`);
  if (row.pools.length > fromDepth && row.price) parts.push(`${row.pools.length - fromDepth === 1 ? 'One pool' : `${row.pools.length - fromDepth} pools`} from the router's pool list, NAM at the site's price of ${usdWords(row.price.usd)} at ${fmtClock(row.price.at)}.`);
  if (t.notPriced.length) parts.push(`Not priced, so left out of the total: ${t.notPriced.slice(0, 6).map((p) => `pool ${p.id}`).join(', ')}${t.notPriced.length > 6 ? ` and ${t.notPriced.length - 6} more` : ''}.`);
  return parts.join(' ');
}

/** The provenance of the stored list as a reader serves it: its read time and height, old past POOLS_STALE_MS. */
export function storedPoolsProv(row: StoredPools | null, now: number): Provenance {
  if (!row) return { source: POOLS_SOURCE, at: null, status: 'missing', note: 'The pool list has not been stored yet.' };
  const age = now - row.at;
  const note = poolsNote(row);
  const height = row.depth?.height ?? null;
  return age > POOLS_STALE_MS
    ? { source: POOLS_SOURCE, at: row.at, height, status: 'stale', note: [`The pool list was last read ${Math.round(age / 60_000)} min ago.`, note].filter(Boolean).join(' ') }
    : { source: POOLS_SOURCE, at: row.at, height, status: 'live', ...(note ? { note } : {}) };
}

/** The stored pool list (kv osmosis.pools), or null when none is stored or it cannot be read. */
export const readStoredPools = (db: D1Database): Promise<StoredPools | null> =>
  kvGetJson<StoredPools>(db, POOLS_KEY).then((r) => (r && Array.isArray(r.pools) && Number.isFinite(r.at) ? r : null), () => null);

/**
 * The metric stored beside each total: how many pools it counts. Its first row is also the minute the stored totals
 * (dex.liquidity_usd, dex.ref_pool_liquidity_usd, pool_hourly.liquidity_usd) became the pools' coins at their own
 * prices: the rows before it are the router's liquidity_cap, so a reading of a past figure says which it is.
 */
export const PRICED_KEY = 'dex.pools_priced';
/** The first stored minute of PRICED_KEY: one seek on the metrics key. */
export const PRICED_FROM_SQL = `SELECT MIN(ts) AS t FROM metrics WHERE key = '${PRICED_KEY}'`;
/** What a stored pool size was at `at`, said for a reading that reaches before the switch (`from`: PRICED_FROM_SQL's answer; null when none is stored yet). */
export const routerCapNote = (from: number | null) => from == null
  ? 'Every stored reading so far is the Osmosis router\'s own figure, which counts NAM at nothing while it gives NAM no price.'
  : `Readings before ${new Date(from).toISOString().slice(0, 16).replace('T', ' ')} UTC are the Osmosis router's own figure, which counted NAM at nothing while it gave NAM no price; from then on, the pools' coins at their own prices.`;

/** The statements that store the sized list and its totals (dex.liquidity_usd, dex.ref_pool_liquidity_usd, dex.pools_priced). */
export function storedPoolsStmts(row: StoredPools, now: number): Stmt[] {
  const t = poolsTotal(row.pools);
  const ref = row.pools.find((p) => p.id === OSMOSIS.refPoolId);
  const out: Stmt[] = [stmt.kvSet(POOLS_KEY, JSON.stringify(row), now)];
  // A total stands only when a pool is priced; how many pools it counts is stored beside it, so a past minute says it too.
  if (t.usd != null) out.push(stmt.metric(now, 'dex.liquidity_usd', t.usd), stmt.metric(now, PRICED_KEY, t.priced));
  if (ref && fin(ref.liquidityUsd)) out.push(stmt.metric(now, 'dex.ref_pool_liquidity_usd', ref.liquidityUsd));
  return out;
}

// ---------------------------------------------------------------- the stored size table

/** The size table as a reader serves it: the stored one, old past MINUTE_STALE_MS; with none stored, an empty table that says so. */
export function storedCurve(row: QuoteCurveResponse | null, now: number): QuoteCurveResponse {
  if (!row || !Array.isArray(row.curve)) {
    return {
      spotUsd: null, poolsCount: 0, totalLiquidityUsd: null, refPoolLiquidityUsd: null, maxSafeClip1PctNam: null, maxSafeClip3PctNam: null,
      safeClip1Pct: null, safeClip3Pct: null, liquidityCliffNam: null, cliffNote: null, curve: [],
      prov: { source: 'Osmosis SQS', at: null, status: 'missing', note: 'The size table has not been built yet: the site builds it once a minute.' },
    };
  }
  const at = row.prov?.at ?? null;
  if (at != null && now - at > MINUTE_STALE_MS && row.prov.status === 'live') {
    return { ...row, prov: { ...row.prov, status: 'stale', note: [row.prov.note, `The size table was last built ${Math.round((now - at) / 60_000)} min ago.`].filter(Boolean).join(' ') } };
  }
  return row;
}

/** The stored size table (kv quote.curve), or null. */
export const readStoredCurve = (db: D1Database): Promise<QuoteCurveResponse | null> => kvGetJson<QuoteCurveResponse>(db, CURVE_KEY).catch(() => null);

/** The size table's pool figures from the tick's sized pools (the router's own answer gave liquidity_cap). */
export function curveWithPools(c: QuoteCurveResponse, pools: PoolInfo[]): QuoteCurveResponse {
  const t = poolsTotal(pools);
  const ref = pools.find((p) => p.id === OSMOSIS.refPoolId);
  return { ...c, poolsCount: pools.length, totalLiquidityUsd: t.usd, refPoolLiquidityUsd: ref && fin(ref.liquidityUsd) ? ref.liquidityUsd : null };
}

// ---------------------------------------------------------------- the cron's writes

/** The health row of the size table the cron builds. */
export const CURVE_HEALTH_NAME = 'Osmosis SQS (size table)';

export interface StorePoolsInput {
  now: number;
  /** the tick's sized pools (sizePools); empty when the router's list did not answer */
  pools: PoolInfo[];
  poolsAt: number;
  depth: DepthResponse | null;
  price: SitePrice | null;
  refused?: number;
}

/**
 * The tick's write of the sized pool list (kv osmosis.pools) and its totals, after the depth minute: written only when
 * the router's list answered, so a failed read leaves the last list, which its readers mark old.
 */
export async function storePools(db: D1Database, x: StorePoolsInput): Promise<void> {
  if (!x.pools.length) return;
  const row: StoredPools = {
    at: x.poolsAt, pools: x.pools, price: x.price,
    depth: x.depth ? { minute: x.depth.at, at: x.depth.ref.at, height: x.depth.ref.height, refPool: x.depth.ref.pool, refUsd: x.depth.ref.usd } : null,
    ...(x.refused ? { refused: x.refused } : {}),
  };
  await runBatch(db, storedPoolsStmts(row, x.now));
}

export interface StoreCurveInput {
  now: number;
  /** the size table built this tick (sources/sqs.ts buildCurve), or null with `why` */
  curve: QuoteCurveResponse | null;
  /** every size quoted on both sides (sources/sqs.ts curveComplete), and how many sizes the table asks */
  complete: boolean;
  sizes: number;
  why?: string;
  /** the tick's sized pools, for the table's pool figures */
  pools: PoolInfo[];
}

/**
 * The tick's write of the size table (kv quote.curve): when every size was quoted, or when some were and the stored
 * table is older than MINUTE_STALE_MS (one refused size never replaces a fresh whole table; an empty table is never
 * written, the stored one ages instead). The health row says how the table went.
 */
export async function storeCurve(db: D1Database, x: StoreCurveInput): Promise<SourceHealth> {
  if (!x.curve || !x.curve.curve.length) {
    return { name: CURVE_HEALTH_NAME, ok: false, at: x.now, note: `Not built this tick: ${x.why ?? 'no size was quoted'}. The stored table stands, with its own time.` };
  }
  let write = x.complete;
  if (!write) {
    const prev = await db.prepare('SELECT updated_at FROM kv WHERE key = ?').bind(CURVE_KEY).first<{ updated_at: number }>().catch(() => null);
    write = !prev || !(x.now - Number(prev.updated_at) <= MINUTE_STALE_MS);
  }
  if (write) await runBatch(db, [stmt.kvSet(CURVE_KEY, JSON.stringify(curveWithPools(x.curve, x.pools)), x.now)]);
  if (x.complete) return { name: CURVE_HEALTH_NAME, ok: true, at: x.now };
  const quoted = x.curve.curve.filter((p) => p.sellImpactPct != null && p.buyImpactPct != null).length;
  return { name: CURVE_HEALTH_NAME, ok: false, at: x.now, note: `${quoted} of ${x.sizes} sizes quoted on both sides${write ? '' : '; the stored table, built under three minutes ago, was kept'}.` };
}
