// The depth module's own configuration. Depth is built generic (owner decision 25, 2026-10-29): everything that names
// the base coin, its reference pool, the coins it trades against and the caps lives here, so a second Worker for
// another Osmosis token runs the same module with another DepthConfig. Nothing else under worker/src/depth/ names NAM.
import { NAM, OSMOSIS } from '../config';
import { DEPTH_SIZES, DEPTH_OFFSETS_PCT, DEPTH_TOUCH_SIZE, HEAT_EDGES, HEAT_BAND_PCT } from '../../../shared/depth';

/** A coin a pool may hold against the base coin, as the module knows it before any read. */
export interface QuoteCoin {
  symbol: string;
  decimals: number;
  /** A coin worth 1 USD by construction (Noble USDC, the alloyed USDC): its price is not asked for. */
  usdFixed?: 1;
}

export interface DepthCaps {
  /** C1: pool rows a minute (the live set is cut by counter value, largest first, and the cut is said). */
  poolsMax: number;
  /** C2: the minute phase's budget inside the tick, and the outside requests it may make; none once the tick is late. */
  phaseMs: number;
  requestsPerMinute: number;
  /** C2: the hourly job's own budget and request count. */
  hourlyMs: number;
  hourlyRequests: number;
  /** C3: rows written a month; inserts stop at the cap, the store row is not ok at `rowsWarn`. */
  rowsMonthMax: number;
  rowsWarn: number;
  /** C4: when a statement's size_after passes this, inserts stop and deletes continue. */
  d1SizeMax: number;
  /** C5: minute rows kept this long; the hourly delete removes at most `deleteLimit` a run. */
  retentionMs: number;
  deleteLimit: number;
  /** C6: one object per live pool per hour; an object over this is not written and said. */
  r2ObjectMax: number;
  /** C7: rows one history answer may read, and rows one heat answer may read. */
  historyRowsMax: number;
  heatRowsMax: number;
  /** Plan 1.5: kv depth.owners stays under this many bytes of JSON; over it, the smallest owners' items are left out and the row says so. */
  ownersKvMax: number;
}

export interface DepthConfig {
  base: { denom: string; symbol: string; decimals: number };
  /** The pool whose own spot is the reference price and the common axis's anchor. */
  refPoolId: string;
  /** The order book pools that always count, as the book (owner decision 18); the page names them through shared/depth.ts bookSource. */
  bookPoolIds: readonly string[];
  /** The quote service's price list quotes in this denom; a price list entry is read as USD. */
  priceListQuote: string;
  quoteCoins: Readonly<Record<string, QuoteCoin>>;
  hosts: { rpc: string; rest: string; sqs: string };
  caps: DepthCaps;
  sizes: readonly number[];
  offsetsPct: readonly number[];
  touchSize: number;
  heat: { edges: readonly number[]; pct: number };
  /**
   * The floor under which a pool that holds something is listed as dust and not read: the research prototype's live
   * rule (proto/snapshot.mjs: at least one whole base coin, or at least a hundredth of a six-decimal counter coin),
   * which is what plan 1.2 a counted (16 live pools of 28 listed on 2026-10-29). Ten pools held a few hundred base
   * units of each coin that day; reading their tick maps every minute would cost requests for no depth. A pool is dust
   * only when BOTH sides are under the floor: under `baseWhole` whole base coins and under `counterWhole` whole counter
   * coins through the coin's decimals once they are known (the configuration's or the metadata read's); before they
   * are known, under `counterUnits` base units of it.
   */
  dust: { baseWhole: number; counterWhole: number; counterUnits: number };
  /** The `chain` the stored swaps carry in the flows table, for the realised check (plan section 5, check 3). */
  swapsChain: string;
  read: DepthReadRules;
  checks: DepthCheckRules;
}

/** How the minute reads (plan 1.2; the figures are the research's). */
export interface DepthReadRules {
  /** The most abci queries in one JSON-RPC batch POST: the public node answered ten in a body and refused more (proto/snapshot.mjs). */
  rpcBatchMax: number;
  /** When a batch fails, at most this many pools are read from the REST gateway instead (two GETs each) before the phase gives up. */
  lcdFallbackPools: number;
  /** Taker fees are read one pair at a time, at most this many a minute, and kept this long. */
  takerReadsPerMinute: number;
  takerMaxAgeMs: number;
  /** A counter coin's symbol and decimals from the quote service's metadata, kept this long. */
  metaMaxAgeMs: number;
  /** The book's live ticks are listed again (all_ticks, in pages) when the known set is older than this or the book's best tick is not in it. */
  bookDiscoveryMaxAgeMs: number;
  bookPageSize: number;
  /** A read's own timeout inside the phase. */
  timeoutMs: number;
}
/** The tolerances of plan section 5 (owner decision 24). */
export interface DepthCheckRules {
  estimateOkPct: number;
  estimateWarnPct: number;
  routeOkPct: number;
  executedOkPct: number;
  executedWarnPct: number;
  /** The stored swaps of this long before the tick are walked. */
  executedWindowMs: number;
  /** The newest comparisons the check keeps in its detail, and the kv row keeps. */
  executedKeep: number;
  realisedKeep: number;
  /** Idle after this long without a trade the check could walk. */
  executedIdleMs: number;
}

/** The caps of plan section 7 (cost.txt section 6 applied to this design), read 2026-10-29. */
export const DEPTH_CAPS: DepthCaps = {
  poolsMax: 40,
  phaseMs: 10_000,
  requestsPerMinute: 12,
  hourlyMs: 15_000,
  hourlyRequests: 60,
  rowsMonthMax: 5_000_000,
  rowsWarn: 4_000_000,
  d1SizeMax: 4_000_000_000,
  retentionMs: 30 * 86_400_000,
  deleteLimit: 5_000,
  r2ObjectMax: 1_000_000,
  historyRowsMax: 43_200,
  heatRowsMax: 2_016,
  ownersKvMax: 200_000,
};

export const DEPTH_READ_RULES: DepthReadRules = {
  rpcBatchMax: 10,
  lcdFallbackPools: 2,
  takerReadsPerMinute: 3,
  takerMaxAgeMs: 3_600_000,
  metaMaxAgeMs: 86_400_000,
  bookDiscoveryMaxAgeMs: 3_600_000,
  bookPageSize: 300,
  timeoutMs: 8_000,
};
export const DEPTH_CHECK_RULES: DepthCheckRules = {
  estimateOkPct: 0.01,
  estimateWarnPct: 0.1,
  routeOkPct: 0.05,
  executedOkPct: 1,
  executedWarnPct: 3,
  executedWindowMs: 120_000,
  executedKeep: 20,
  realisedKeep: 50,
  executedIdleMs: 86_400_000,
};

/** Depth for NAM on Osmosis: the configuration this Worker runs. */
export const NAM_DEPTH: DepthConfig = {
  base: { denom: NAM.osmoDenom, symbol: NAM.symbol, decimals: NAM.decimals },
  refPoolId: OSMOSIS.refPoolId,
  bookPoolIds: ['3008'],
  priceListQuote: OSMOSIS.allUsdc,
  quoteCoins: {
    [OSMOSIS.usdcDenom]: { symbol: 'USDC', decimals: 6, usdFixed: 1 },
    [OSMOSIS.allUsdc]: { symbol: 'USDC', decimals: 6, usdFixed: 1 },
    uosmo: { symbol: 'OSMO', decimals: 6 },
    // Every other counter coin (stOSMO, ATONE, BTC, UM, NYM ...) takes its symbol and decimals from the quote service's
    // token metadata read (plan 1.2 b); none is typed here.
  },
  hosts: { rpc: OSMOSIS.publicRpc, rest: OSMOSIS.publicRest, sqs: OSMOSIS.sqs },
  caps: DEPTH_CAPS,
  sizes: DEPTH_SIZES,
  offsetsPct: DEPTH_OFFSETS_PCT,
  touchSize: DEPTH_TOUCH_SIZE,
  heat: { edges: HEAT_EDGES, pct: HEAT_BAND_PCT },
  dust: { baseWhole: 1, counterWhole: 0.01, counterUnits: 10_000 },
  swapsChain: 'osmosis',
  read: DEPTH_READ_RULES,
  checks: DEPTH_CHECK_RULES,
};

/** What the module knows of a counter coin before any read: the configured entry, or null (the metadata read names the rest; a coin it does not name is unpriced). */
export const quoteCoinOf = (cfg: DepthConfig, denom: string): QuoteCoin | null => cfg.quoteCoins[denom] ?? null;
