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
};

/** What the module knows of a counter coin before any read: the configured entry, or null (the metadata read names the rest; a coin it does not name is unpriced). */
export const quoteCoinOf = (cfg: DepthConfig, denom: string): QuoteCoin | null => cfg.quoteCoins[denom] ?? null;
