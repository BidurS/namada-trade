// Depth: what the base coin fetches at every price across every Osmosis pool that holds it, read from the chain's own
// state (each concentrated-liquidity pool's tick map, each weighted pool's reserves, the order book's resting orders)
// and merged into one ladder and one curve. This file holds what the Worker and the page share: the response types,
// the four sizes, the stored price offsets, the heat bands and every sentence the page says about the figures (no
// sentence here names a figure; the words are checked against test/banned-words.ts).
//
// Units: a "raw" price is counter base units per base-coin base unit inside one pool; the common axis is USD per
// whole base coin. Amounts in the response are whole coins; the model works in base units (worker/src/depth/model.ts).

/** The sizes answered each minute, in whole base coins: the executable figures of the Answer view. */
export const DEPTH_SIZES = [1_000, 10_000, 100_000, 1_000_000] as const;
/** The size the touch is read at, in whole base coins: the effective price of the first coins each way. */
export const DEPTH_TOUCH_SIZE = 100;
/** The price offsets stored per minute, in percent of the reference price, each side (bid_1 ... bid_50, ask_1 ... ask_50). */
export const DEPTH_OFFSETS_PCT = [1, 2, 5, 10, 25, 50] as const;
/** The heat bands of the time view: one band every HEAT_BAND_PCT percent upward from a quarter of the reference price. */
export const HEAT_BAND_PCT = 2.5;
export const HEAT_LO_RATIO = 0.25;
/**
 * The band count. The plan asked for 112 bands of 2½ % from a quarter of the reference to four times it, which no whole
 * count gives (ln 16 / ln 1.025 = 112.3): the count is kept (the stored heat row is float32[112]) and the top edge is
 * HEAT_TOP_RATIO, 3.97 times the reference, so every sentence about the bands says "almost four times" (HEAT_RANGE_WORDS)
 * and the heat answer carries its own edges. Recorded against owner decision 19.
 */
export const HEAT_BANDS = 112;
/** The 113 band edges as ratios of the reference price: HEAT_LO_RATIO x (1 + HEAT_BAND_PCT / 100)^k, k = 0 ... 112. */
export const HEAT_EDGES: readonly number[] = Array.from({ length: HEAT_BANDS + 1 }, (_, k) => HEAT_LO_RATIO * (1 + HEAT_BAND_PCT / 100) ** k);
/** The last edge: what the top band reaches (under four times the reference). */
export const HEAT_TOP_RATIO = HEAT_EDGES[HEAT_BANDS];
/** The aggregate curve's grid: steps of a quarter percent within four times the reference price each way, one percent beyond. */
export const GRID_FINE_STEP = 0.0025;
export const GRID_FINE_SPAN = 4;
export const GRID_COARSE_STEP = 0.01;
/** The curve served to the page is thinned to at most this many points a side. */
export const CURVE_POINTS_MAX = 400;
/** Each pool's own curve in the served answer is thinned further (sixteen pools at the aggregate's count would not fit the one stored row). */
export const CURVE_POOL_POINTS_MAX = 120;
/** The stored minute's answer (kv depth.latest) stays under this many bytes of JSON. */
export const DEPTH_LATEST_MAX_BYTES = 150_000;

export type DepthPoolType = 'concentrated' | 'balancer' | 'stableswap' | 'cosmwasm';
export type DepthSide = 'bid' | 'ask';

/**
 * One read behind a figure: where, when, at what height, and, when the module made the request itself, how big, how
 * long and with what status. A pool whose figures come from the pool list the tick had already read carries the list's
 * URL and time only: its size, time and status were not seen by the module, so they are left out rather than typed.
 */
export interface DepthRead {
  url: string;
  at: number;
  height: number | null;
  bytes?: number;
  ms?: number;
  status?: number | string;
}
export interface DepthReadError {
  error: string;
  at: number;
  url?: string;
}

export interface DepthSplit {
  pool: string;
  nam: number;
  usd: number;
}

/**
 * One executable figure: selling or buying `nam` whole coins across every priced pool, filled best price first. One
 * shape for both sides, so the quote route and the stored rows share it: `usd` is the USD out for a sale and the USD in
 * for a buy (plan section 2 spelled them usdOut and usdIn; the side says which, and the page's labels say it in words).
 */
export interface DepthFill {
  nam: number;
  /** USD out for a sale, USD in for a buy. */
  usd: number;
  avgPrice: number | null;
  marginalPrice: number;
  complete: boolean;
  filledNam: number;
  split: DepthSplit[];
}

export interface DepthTouch {
  bestBidEff: number | null;
  bestBidPool: string | null;
  bestAskEff: number | null;
  bestAskPool: string | null;
  sizeNam: number;
}

export interface DepthWithin {
  bidUsd10: number;
  bidUsd25: number;
  bidUsd50: number;
  askNam10: number;
  askNam25: number;
  askUsd10: number;
  totalBidUsd: number;
  totalAskNam: number;
}

/** USD resting within each offset of the reference price, one entry per DEPTH_OFFSETS_PCT, each side. */
export interface DepthOffsets {
  bid: number[];
  ask: number[];
}

/** A rung of the raw ladder: a tick range of a concentrated pool, a level of the book, or a weighted pool's reserves. */
export interface DepthLevel {
  pool: string;
  type: DepthPoolType;
  side: DepthSide | 'both';
  loUsd: number;
  hiUsd: number;
  nam: number;
  counter: number;
  counterUsd: number;
  positions?: number;
  orders?: number;
  spread: number;
  taker: number;
}

export interface DepthPoolCl {
  currentTick: number;
  liquidity: number;
  ranges: number;
  positions?: number;
}
export interface DepthBookLevel {
  price: number;
  /** Bids rest in the counter coin, asks in the base coin (whole coins). */
  amount: number;
  /** Orders resting at the tick, or null while the minute has not read them (the tick's orders are read only when its totals change, within the request cap). */
  orders: number | null;
}
export interface DepthPoolBook {
  bids: DepthBookLevel[];
  asks: DepthBookLevel[];
  /** Orders resting in the book, or null while any live tick's count is not read; `ordersUnknown` says how many ticks that is. */
  orders: number | null;
  ordersUnknown: number;
  bestBid: number | null;
  bestAsk: number | null;
  state: { url: string; at: number };
}

export interface DepthPool {
  id: string;
  type: DepthPoolType;
  pair: string;
  counterDenom: string;
  counterSymbol: string;
  /** Null when neither the configuration nor the quote service's metadata names the coin's decimals (the pool is then unpriced). */
  counterDecimals: number | null;
  /** USD per whole counter coin (plan section 2 named this and the pool's value both counterUsd; the value is counterValueUsd). */
  counterUsd: number | null;
  counterUsdHow: string;
  spotUsd: number | null;
  spread: number;
  taker: number | null;
  sides: 'both' | 'nam' | 'coin' | 'empty' | 'unknown';
  /** Whole coins; the counter is null when its decimals are not known. */
  nam: number;
  counter: number | null;
  /** The pool's counter coin at counterUsd, in USD. */
  counterValueUsd: number | null;
  /** When the two balances were read: the pool list's time, which is the tick's own read, not the chain read behind `read`. */
  balancesAt: number;
  read: DepthRead | DepthReadError;
  cl?: DepthPoolCl;
  book?: DepthPoolBook;
}

/** A listed pool that is not summed: unpriced, empty, dust, or cut by the pool cap; `why` says which. */
export interface DepthUnpriced {
  id: string;
  pair: string;
  why: string;
}

export interface DepthCurve {
  price: number[];
  bidUsd: number[];
  bidNam: number[];
  askUsd: number[];
  askNam: number[];
  perPool: Record<string, { bidUsd: number[]; askUsd: number[] }>;
}

export interface DepthChecks {
  /** Base units of the reference pool's counter coin: the chain's own estimate (`chainOut`) and ours for `nam` whole base coins. */
  estimate: { nam: number; chainOut: number; ours: number; diffPct: number; url: string; at: number; height: number | null } | null;
  /** The quote service's direct quote in the reference pool (`routerOut`, base units of its counter coin) and ours. */
  route: { nam: number; routerOut: number; ours: number; diffPct: number; at: number } | null;
  realised: { n: number; within1pct: number; lastAt: number | null };
}

export interface DepthProv {
  what: string;
  url: string;
  at: number;
  height: number | null;
  bytes: number;
  status: number | string;
}

export interface DepthRef {
  pool: string;
  usd: number;
  height: number | null;
  at: number;
  source: string;
  status?: 'live' | 'stale';
}

/** GET /api/depth: the whole minute's answer, served from the kv row the minute wrote. */
export interface DepthResponse {
  at: number;
  generatedAt: number;
  ref: DepthRef;
  pools: DepthPool[];
  unpriced: DepthUnpriced[];
  answer: { sizes: number[]; sell: DepthFill[]; buy: DepthFill[] };
  touch: DepthTouch;
  within: DepthWithin;
  offsets: DepthOffsets;
  book: { levels: DepthLevel[] };
  curve: DepthCurve;
  checks: DepthChecks;
  prov: DepthProv[];
  cost: { reads: number; bytes: number; ms: number };
  note?: string;
}

/** GET /api/depth/quote?side=&nam= : the exact walk of the stored curve for any size. */
export interface DepthQuoteResponse extends DepthFill {
  side: 'sell' | 'buy';
  vsRef: number | null;
  at: number;
  height: number | null;
  prov: DepthProv[];
}

export interface DepthHistoryPoint {
  t: number;
  at: number;
  height: number | null;
  refUsd: number;
  spotUsd: number | null;
  bid: (number | null)[];
  ask: (number | null)[];
  sell: (number | null)[];
  buy: (number | null)[];
  bestBid: number | null;
  bestAsk: number | null;
  bidUsd: number | null;
  askNam: number | null;
  note: string | null;
}
export interface DepthHistoryResponse {
  pool: string;
  step: '1m' | '1h';
  from: number;
  to: number;
  points: DepthHistoryPoint[];
  gaps: { from: number; to: number; why: string }[];
  start: number | null;
  prov: DepthProv[];
}

export interface DepthHeatResponse {
  bands: { edges: number[]; pct: number };
  columns: { t: number; refUsd: number; bid: string; ask: string; height: number | null }[];
  step: '1m' | '5m' | '1h';
  max: number;
  prov: DepthProv[];
}

export interface DepthOwnerItem {
  pool: string;
  kind: 'position' | 'order';
  id: string;
  side?: DepthSide;
  loUsd: number;
  hiUsd: number;
  nam: number;
  usd: number;
  since: number | null;
  remaining?: number;
  placed?: number;
  /** A position's liquidity as the chain gives it (an 18-decimal string), so two hours' readings compare exactly. */
  liquidity?: string;
  /** An order's remaining quantity in base units as the contract gives it (the coin the order rests in), for the same exact comparison. */
  quantity?: string;
  /** A position whose range holds the pool's price (it gives both coins), from the hourly read. */
  inRange?: boolean;
}
export interface DepthOwner {
  address: string;
  short: string;
  label: string | null;
  category: string | null;
  pools: string[];
  positions: number;
  orders: number;
  nam: number;
  usd: number;
  share: number;
  items: DepthOwnerItem[];
}
export interface DepthOwnersResponse {
  at: number;
  height: number | null;
  owners: DepthOwner[];
  totals: { nam: number; usd: number; positions: number; orders: number };
  prov: DepthProv[];
}

/**
 * One row of depth_changes: liquidity that appeared, left or filled, as the diff of two readings (worker/src/depth/diff.ts).
 * `ref` names what changed: a tick range of a concentrated pool ('rng:<lo>:<hi>', compared by its liquidity, which only a
 * position event moves), a weighted or stable pool's reserves ('res', a row only when both reserves moved the same way:
 * a swap moves them apart and is a trade, not a change of liquidity), a position ('pos:<id>') or an order ('ord:<id>'),
 * the last two from the hourly read with the owner. `nam` and `usd` are the size that changed: what was added, what left,
 * what filled, or how much the item grew or shrank by.
 */
export interface DepthChangeRow {
  ts: number;
  pool: string;
  ref: string;
  kind: 'added' | 'removed' | 'filled' | 'grew' | 'shrank';
  side: DepthSide | null;
  loUsd: number | null;
  hiUsd: number | null;
  nam: number | null;
  usd: number | null;
  owner: string | null;
  height: number | null;
}

// ---------------------------------------------------------------------------------------------------- the words
/** The sources a figure names, in plain words (the page never says the acronyms test/banned-words.ts forbids). */
export const DEPTH_SOURCES = {
  clStore: 'Osmosis chain node (concentrated-liquidity tick store)',
  poolManager: 'Osmosis chain node (pool manager)',
  gamm: 'Osmosis chain node (weighted and stable pools)',
  priceList: 'Osmosis quote service price list',
  takerFee: 'Osmosis chain node (taker fee of the pair)',
  estimate: 'Osmosis chain node (its own swap estimate)',
} as const;
/** The order book's source names its pool, which comes from the module's configuration (worker/src/depth/config.ts bookPoolIds), never from these words. */
export const bookSource = (poolId: string): string => `Osmosis order book contract (pool ${poolId})`;

/** The heat bands, said once under the time view: the band width and the span, which stops under four times the reference. */
export const HEAT_RANGE_WORDS = 'each band two and a half percent wide, from a quarter of the reference price to almost four times it';

/** What a "level" of a concentrated pool is, said once per view. */
export const CL_LEVEL_WORDS = 'a reading of the pool’s tick map: what its positions would give between two prices, not a resting order';

/** Why a pool is listed and not counted. */
export const UNPRICED_NO_PRICE = 'the quote service’s price list gives this coin no price, so the pool is listed and not counted';
export const UNPRICED_NO_TAKER = 'the pair’s taker fee was not read, so the pool is listed and not counted';
export const UNPRICED_NOT_READ = (why: string) => `not read this minute (${why}), so the pool is listed and not counted`;

/** How a pool in another coin was put on the USD axis. `coin` is the coin's symbol; `at` its price list time in words. */
export const counterUsdHow = (coin: string, usd: number, at: string): string =>
  `${coin} at the quote service’s price list, ${usd} USD, ${at}; converting ${coin} to USDC would cost another hop`;
export const USDC_AS_ONE = 'Noble USDC counted as one US dollar';

/** The rule for a book whose nearest bid sits far under the pools' price. */
export const SELL_INTO_POOLS = 'the order book’s nearest bid is under the pool price after fees: sell into the pools, not the book';

/** The honest start under the time view. */
export const HONEST_START = 'Depth has been recorded since the first stored minute; nothing on the chain gives earlier depth.';

/** Why a listed pool is not read: nothing inside, or too little to be worth a read every minute. */
export const UNPRICED_EMPTY = 'empty on both sides, so the pool is listed and not read';
/**
 * The dust floor as the module's configuration sets it (worker/src/depth/config.ts dust): a pool under `baseWhole` whole
 * base coins AND under a hundredth of a whole counter coin (a fixed number of base units before the coin's decimals are
 * read) is listed and not read. Both sides must be under the floor: a pool that holds one of the two is read.
 */
export const dustWords = (baseWhole: number, baseSymbol: string) => `holds under ${baseWhole} ${baseSymbol} and almost none of the other coin, so the pool is listed and not read`;
export const UNPRICED_NO_META = 'the quote service’s token metadata does not name this coin, so the pool is listed and not counted';
/** A pool past the cap on pools read a minute: `n` is the cap, from the configuration. */
export const cutByCap = (n: number) => `past the cap of ${n} pools read a minute (the largest by counter value are read), so the pool is listed and not read`;

/** The realised check leaves out a trade with an order-book leg, and says so. */
export const BOOK_LEG_LEFT_OUT = 'took part of its coins from an order-book order since gone: the book is not on the chain’s tick map and cannot be rebuilt';

/** The titles of the four checks on the Status page (checks table rows). */
export const DEPTH_CHECK_TITLES = {
  depth_vs_chain_estimate: 'Depth vs the chain’s own swap estimate (the reference pool, the smallest size)',
  depth_vs_route_quote: 'Depth vs the quote service’s direct quote in the reference pool',
  depth_vs_executed: 'Depth vs the trades that settled (walked on the minute before each)',
  depth_budget: 'Depth store within its caps (rows this month, database size, archive puts)',
} as const;

/** An empty side, and why it is possible. */
export const NO_BIDS = 'no bids: nothing is resting to buy into on this side, which a pool emptied of its counter coin or a book with no buy orders allows';
export const NO_ASKS = 'no asks: nothing is resting to sell into on this side';

/** The three facts the hourly owners job holds the chain's answers to (plan section 5); each is the note's words when it holds and when it does not. */
export const INVARIANT_WORDS = {
  inRange: 'the positions in range add up to the pool’s current liquidity',
  tickStore: 'the tick store walked equals the gateway’s liquidity per tick range',
  bookTotals: 'each tick’s total equals what its orders have left',
} as const;
/** The hourly owners job and what it left out, in words. */
export const OWNERS_NO_ARCHIVE = 'no archive bucket is bound, so the raw state was not archived';
export const BOOK_NOT_READ_CLOSING = 'the order book’s orders were not read: the hour’s window is closing';
export const OWNERS_NO_MINUTE = 'no stored minute yet, so there is no live set to read the owners of';

/** A read that did not answer this minute: the last reading is shown dimmed with this. */
export const notReadSince = (clock: string, why: string) => `not read since ${clock}, ${why}`;

/** Every fixed sentence above, for test/depth-words.test.ts: none may carry a figure. */
export const DEPTH_FIXED_WORDS: readonly string[] = [
  ...Object.values(DEPTH_SOURCES), ...Object.values(DEPTH_CHECK_TITLES), HEAT_RANGE_WORDS, CL_LEVEL_WORDS, UNPRICED_NO_PRICE, UNPRICED_NO_TAKER, UNPRICED_EMPTY, UNPRICED_NO_META,
  BOOK_LEG_LEFT_OUT, USDC_AS_ONE, SELL_INTO_POOLS, HONEST_START, NO_BIDS, NO_ASKS,
  ...Object.values(INVARIANT_WORDS), OWNERS_NO_ARCHIVE, BOOK_NOT_READ_CLOSING, OWNERS_NO_MINUTE,
];
/** The sentences built from a read or the configuration, with sample arguments: the only figures they carry are the ones passed in. */
export const DEPTH_BUILT_WORDS: readonly string[] = [
  bookSource('3008'), UNPRICED_NOT_READ('status 429'), counterUsdHow('OSMO', 0.0529, '02:56 UTC'), notReadSince('02:56 UTC', 'status 429'), cutByCap(40), dustWords(1, 'NAM'),
];
export const DEPTH_WORDS: readonly string[] = [...DEPTH_FIXED_WORDS, ...DEPTH_BUILT_WORDS];
