// The depth module's own pool list (owner decision 25: its own list, generic over the base coin). The quote service's
// /pools?filter[denom]=<base> answer names every pool that holds the base coin with its type, its two balances, its
// spread and, for a weighted or stable pool, the chain's own pool object (weights, swap fee, scaling factors). From it:
// what each pool holds (the holds-something rule of shared/pool-sides.ts), which pools are dust (plan 1.2 a's live
// rule, from the research prototype), which counter coins need a price, a symbol and decimals, and the live set the
// minute reads, cut at the pool cap by counter value with the cut said. Nothing here names a coin: the base coin, the
// quote coins and the caps come from the DepthConfig passed in.
import type { DepthConfig } from './config';
import { quoteCoinOf } from './config';
import type { WeightedAsset } from './model';
import { poolSides, type PoolSides } from '../../../shared/pool-sides';
import { USDC_AS_ONE, UNPRICED_EMPTY, UNPRICED_NO_META, UNPRICED_NO_PRICE, UNPRICED_NO_TAKER, counterUsdHow, cutByCap, dustWords, type DepthPoolType } from '../../../shared/depth';
import { fmtClock } from '../digest/types';

/** One pool of the quote service's list, as the module keeps it before any chain read. Amounts are base units (Number: the balances fit). */
export interface ListedPool {
  id: string;
  type: DepthPoolType;
  address: string;
  counterDenom: string | null;
  baseBase: number;
  counterBase: number;
  /** The pool's own fee on the coin in, as the list gives it. */
  spread: number;
  sides: PoolSides;
  /** A weighted pool's assets and fee, from the chain's pool object the list carries. */
  gamm?: { assets: WeightedAsset[]; swapFee: number };
  /** A stable pool's reserves, scaling factors and fee. */
  stable?: { liquidity: { denom: string; amount: string }[]; scaling: (string | number)[]; swapFee: number };
  /** An order book's contract address. */
  book?: { contract: string };
}

const TYPE_NAMES: Record<number, DepthPoolType> = { 0: 'balancer', 1: 'stableswap', 2: 'concentrated', 3: 'cosmwasm' };

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** The list's pools, in the order given. A pool the module cannot read (an unknown type, no id) is left out. */
export function listPools(cfg: DepthConfig, raw: unknown): ListedPool[] {
  const list: any[] = Array.isArray(raw) ? raw : Array.isArray((raw as any)?.data) ? (raw as any).data : [];
  const out: ListedPool[] = [];
  for (const p of list) {
    const cm = p?.chain_model ?? {};
    const id = String(cm.id ?? cm.pool_id ?? p?.id ?? '');
    const type = TYPE_NAMES[Number(p?.type)];
    if (!id || !type) continue;
    const balances: { denom: string; amount: string }[] = Array.isArray(p?.balances) ? p.balances : [];
    const baseBal = balances.find((b) => b.denom === cfg.base.denom);
    const counterBal = balances.find((b) => b.denom !== cfg.base.denom);
    const baseBase = num(baseBal?.amount), counterBase = num(counterBal?.amount);
    const pool: ListedPool = {
      id, type, address: String(cm.address ?? cm.contract_address ?? ''), counterDenom: counterBal?.denom ?? null, baseBase, counterBase,
      spread: num(p?.spread_factor ?? cm.spread_factor),
      sides: poolSides({ namReserve: baseBase, counterReserve: counterBase }),
    };
    if (type === 'balancer' && Array.isArray(cm.pool_assets)) {
      pool.gamm = { assets: cm.pool_assets.map((a: any) => ({ denom: String(a?.token?.denom ?? ''), amount: String(a?.token?.amount ?? '0'), weight: String(a?.weight ?? '0') })), swapFee: num(cm.pool_params?.swap_fee ?? p?.spread_factor) };
    }
    if (type === 'stableswap' && Array.isArray(cm.pool_liquidity)) {
      pool.stable = { liquidity: cm.pool_liquidity.map((c: any) => ({ denom: String(c?.denom ?? ''), amount: String(c?.amount ?? '0') })), scaling: Array.isArray(cm.scaling_factors) ? cm.scaling_factors : [], swapFee: num(cm.pool_params?.swap_fee ?? p?.spread_factor) };
    }
    if (type === 'cosmwasm' && cm.contract_address) pool.book = { contract: String(cm.contract_address) };
    out.push(pool);
  }
  return out;
}

/**
 * A pool under the dust floor on both sides: nothing a minute's read would change (plan 1.2 a; config.dust). The
 * counter side is measured in whole coins when the coin's decimals are known (`counterDecimals`), else in base units.
 */
export const isDust = (cfg: DepthConfig, p: ListedPool, counterDecimals: number | null = null): boolean =>
  p.baseBase < cfg.dust.baseWhole * 10 ** cfg.base.decimals
  && p.counterBase < (counterDecimals != null ? cfg.dust.counterWhole * 10 ** counterDecimals : cfg.dust.counterUnits);

/** The counter coins the live candidates trade against, each once, in the order first seen. */
export const counterDenoms = (pools: ListedPool[]): string[] => [...new Set(pools.map((p) => p.counterDenom).filter((d): d is string => !!d))];

/** What the quote service's metadata says of a coin. */
export interface TokenMeta { symbol: string; decimals: number }
/** A pair's taker fee as read from the chain, with its time. */
export interface TakerFee { fee: number; at: number; url: string }

/** Everything the aggregate needs to know of a counter coin, and the words for how its price was found. */
export interface CounterInfo {
  denom: string;
  symbol: string;
  decimals: number | null;
  /** USD per whole coin, or null with `why` saying what is missing. */
  usd: number | null;
  how: string;
  /** When the price was read (the price list's read time), or null for a coin worth a dollar by construction. */
  usdAt: number | null;
  taker: number | null;
  takerAt: number | null;
  /** Why the coin's pools are unpriced, or null when the coin is priced. */
  why: string | null;
}

/**
 * A counter coin on the USD axis: a configured coin worth a dollar is one; any other coin takes the price list's
 * figure (in the configured quote, read as USD) with the sentence that says so; its symbol and decimals come from the
 * configuration or the metadata read. `priceList` is the list's answer ({ denom: { quote: "price" } }) with its read
 * time, or null when it did not answer.
 */
export function counterInfo(cfg: DepthConfig, denom: string, priceList: { value: Record<string, Record<string, string | number>>; at: number } | null, meta: TokenMeta | null, taker: TakerFee | null): CounterInfo {
  const known = quoteCoinOf(cfg, denom);
  const symbol = known?.symbol ?? meta?.symbol ?? (denom.startsWith('ibc/') ? `${denom.slice(0, 10)}…` : denom.split('/').pop() ?? denom);
  const decimals = known?.decimals ?? (meta && Number.isFinite(meta.decimals) ? meta.decimals : null);
  let usd: number | null = null, how = '', usdAt: number | null = null;
  if (known?.usdFixed) { usd = 1; how = USDC_AS_ONE; }
  else if (priceList) {
    const v = Number(priceList.value?.[denom]?.[cfg.priceListQuote]);
    if (Number.isFinite(v) && v > 0) { usd = v; usdAt = priceList.at; how = counterUsdHow(symbol, v, fmtClock(priceList.at)); }
  }
  const why = usd == null ? UNPRICED_NO_PRICE : decimals == null ? UNPRICED_NO_META : taker == null ? UNPRICED_NO_TAKER : null;
  return { denom, symbol, decimals, usd, how, usdAt, taker: taker?.fee ?? null, takerAt: taker?.at ?? null, why };
}

export interface LiveSet {
  /** The pools read this minute, largest counter value first; the book pools always among them. */
  live: ListedPool[];
  /** Pools that hold something but are not summed: their counter coin unpriced, or no metadata, or no taker fee yet. Each gets a row with the reason. */
  unpriced: { pool: ListedPool; why: string }[];
  /** Pools empty on both sides, dust, or cut by the cap: listed in the answer with the reason, never read. */
  leftOut: { pool: ListedPool; why: string }[];
  /** How many priced pools the cap cut. */
  cut: number;
}

/** The pool's counter coin in USD, for the cap's order. */
export const counterValueUsd = (p: ListedPool, c: CounterInfo | undefined): number | null => (c && c.usd != null && c.decimals != null ? (p.counterBase / 10 ** c.decimals) * c.usd : null);

/**
 * Which pools the minute reads: those that hold something and are not dust, whose counter coin is priced with known
 * decimals and a taker fee, the book pools always, the rest cut at the cap by counter value (largest first) with the
 * cut said (cap C1). A pool that holds something but cannot be priced gets a row with the reason, not a read.
 */
export function liveSet(cfg: DepthConfig, pools: ListedPool[], counters: Record<string, CounterInfo>): LiveSet {
  const unpriced: LiveSet['unpriced'] = [], leftOut: LiveSet['leftOut'] = [], candidates: ListedPool[] = [];
  for (const p of pools) {
    if (p.sides === 'empty') { leftOut.push({ pool: p, why: UNPRICED_EMPTY }); continue; }
    const c = p.counterDenom ? counters[p.counterDenom] : undefined;
    if (isDust(cfg, p, c?.decimals ?? null)) { leftOut.push({ pool: p, why: dustWords(cfg.dust.baseWhole, cfg.base.symbol) }); continue; }
    if (!c || c.why) { unpriced.push({ pool: p, why: c?.why ?? UNPRICED_NO_PRICE }); continue; }
    candidates.push(p);
  }
  candidates.sort((a, b) => (counterValueUsd(b, counters[b.counterDenom!]) ?? 0) - (counterValueUsd(a, counters[a.counterDenom!]) ?? 0));
  const books = candidates.filter((p) => cfg.bookPoolIds.includes(p.id));
  const rest = candidates.filter((p) => !cfg.bookPoolIds.includes(p.id));
  const room = Math.max(0, cfg.caps.poolsMax - books.length);
  const live = [...rest.slice(0, room), ...books];
  const cutPools = rest.slice(room);
  for (const p of cutPools) leftOut.push({ pool: p, why: cutByCap(cfg.caps.poolsMax) });
  return { live, unpriced, leftOut, cut: cutPools.length };
}

/** The pair's name as the page shows it. */
export const pairOf = (cfg: DepthConfig, p: ListedPool, counters: Record<string, CounterInfo>): string => `${cfg.base.symbol} / ${p.counterDenom ? counters[p.counterDenom]?.symbol ?? p.counterDenom : 'nothing'}`;
