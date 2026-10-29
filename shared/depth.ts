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
/** The size the page opens with and the two quotable lines name (ux-principles 14): the second of the four, answered by every stored minute. */
export const DEPTH_QUOTABLE_SIZE: (typeof DEPTH_SIZES)[number] = 10_000;
/** The size the touch is read at, in whole base coins: the effective price of the first coins each way. */
export const DEPTH_TOUCH_SIZE = 100;
/** The price offsets stored per minute, in percent of the reference price, each side (bid_1 ... bid_50, ask_1 ... ask_50). */
export const DEPTH_OFFSETS_PCT = [1, 2, 5, 10, 25, 50] as const;
/** The index of the ten- and the fifty-percent offset in DEPTH_OFFSETS_PCT: the page's "within 10%" labels and the stored within.*10 / *50 figures are tied by these, never by a typed position. */
export const OFFSET_10_INDEX: number = DEPTH_OFFSETS_PCT.indexOf(10);
export const OFFSET_50_INDEX: number = DEPTH_OFFSETS_PCT.indexOf(50);
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

/**
 * One read behind a figure. A read of an outside source carries its `url`; a read of the Worker's own stored rows
 * (the API's history, heat and changes) carries no URL but the `table` and the `key` range it read, with `status`
 * 'stored' and `at` and `height` the newest row's own.
 */
export interface DepthProv {
  what: string;
  url: string | null;
  at: number;
  height: number | null;
  bytes: number;
  status: number | string;
  table?: string;
  key?: Record<string, string | number>;
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

/**
 * GET /api/depth/quote?side=&nam= : the exact walk of the stored minute for any size. `nam` is the size answered: the
 * size asked rounded to three significant digits (QUOTE_NAM_DIGITS), which is also the edge cache's key for the quote
 * (worker/src/http.ts quoteNamKey), so the route only ever sees the rounded size and the size as typed is the page's to
 * keep, never this answer's. `ref` is the minute's
 * reference, `vsRef` the fill's average price against it in percent. `how` says what was walked: the pool models rebuilt
 * from the stored states on the stored curve's own grid (the split by pool exact), or the stored aggregate curve alone
 * when the states were not stored (then the split is empty and `note` says so). An incomplete fill carries `note`.
 */
export interface DepthQuoteResponse extends DepthFill {
  side: 'sell' | 'buy';
  ref: DepthRef;
  vsRef: number | null;
  at: number;
  height: number | null;
  how: string;
  note?: string;
  prov: DepthProv[];
}
/** The quote size is rounded to this many significant digits (the edge cache keeps one copy per rounded size and side). */
export const QUOTE_NAM_DIGITS = 3;
export const QUOTE_NAM_MIN = 1;
export const QUOTE_NAM_MAX = 10_000_000;
export const roundQuoteNam = (nam: number): number => Number(nam.toPrecision(QUOTE_NAM_DIGITS));
/** The newest stored minute is served as stale past this age (plan section 2). */
export const DEPTH_STALE_MS = 3 * 60_000;

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
  /** An hourly row only: the hour's lowest and highest figure for the quotable size sold and for the USD bid within ten percent, and how many minutes it rolled up. */
  hour?: { sellLo: number | null; sellHi: number | null; bidLo: number | null; bidHi: number | null; n: number };
}
export interface DepthHistoryResponse {
  pool: string;
  /** The reference pool of the configuration whose rows these are (each point's refUsd is that pool's own spot), so a rewound page can name it. */
  refPool: string;
  step: '1m' | '1h';
  from: number;
  to: number;
  asOf: number;
  points: DepthHistoryPoint[];
  /** Steps in [from, to) with no stored row, merged into runs; never filled in. */
  gaps: { from: number; to: number; why: string }[];
  /** The first stored step of this pool at this step (the gap arithmetic runs from it), or null when nothing is stored. */
  start: number | null;
  /**
   * When depth was first recorded for this pool: the earlier of the first minute row and the first hourly row, read
   * at every step. The minute rows are kept for a retention and the hourly rows forever, so after the retention a
   * one-minute window's `start` is the retention's edge while this stays the first recording. Null when nothing is stored.
   */
  recordedSince: number | null;
  /** The row cap (plan C7): true when the window held more rows than the cap and the answer stops at the cap. */
  cut: boolean;
  note: string | null;
  prov: DepthProv[];
}
/** GET /api/depth/history reads at most this many rows in its one statement (plan C7, worker/src/depth/config.ts caps.historyRowsMax says the same). */
export const HISTORY_ROWS_MAX = 43_200;
/** The default history window: the last day at one-minute steps. */
export const HISTORY_DEFAULT_MS = 86_400_000;

export interface DepthHeatResponse {
  days: number;
  from: number;
  to: number;
  asOf: number;
  bands: { edges: number[]; pct: number };
  /** One column per stored step: the bands as stored (base64 float32[112], USD per band, relative to that step's reference). A step with no row has no column. */
  columns: { t: number; refUsd: number; bid: string; ask: string; height: number | null }[];
  step: '1m' | '5m' | '1h';
  /** The largest band value over every column, for the colour scale. */
  max: number;
  /** How the columns were picked, in words. */
  how: string;
  prov: DepthProv[];
}
/** The heat windows served, in days, and the step each is read at. */
export const HEAT_DAYS: Record<number, '1m' | '5m' | '1h'> = { 1: '1m', 7: '5m', 30: '1h' };
export const HEAT_DEFAULT_DAYS = 7;

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
/** GET /api/depth/owners: kv depth.owners with each owner's label as the labels table has it now, and the hour's own notes. */
export interface DepthOwnersApiResponse extends DepthOwnersResponse {
  hour: number;
  positions: { at: number | null; height: number | null; read: boolean; pools: string[]; why?: string };
  orders: { at: number | null; height: number | null; read: boolean; why?: string };
  /** The three facts the hourly job holds the chain's answers to, as it found them. */
  invariants: Record<'inRange' | 'tickStore' | 'bookTotals', { ok: boolean | null; note: string }>;
  notes: string[];
  /** Owners whose label came from the labels table this request. */
  labelled: number;
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
/** GET /api/depth/changes: a page of depth_changes, newest first, keyset on (ts, pool_id, ref); `next` is the cursor of the page after, null at the end. */
export interface DepthChangesResponse {
  pool: string | null;
  rows: DepthChangeRow[];
  next: string | null;
  limit: number;
  prov: DepthProv[];
}
export const CHANGES_LIMIT_MAX = 200;

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

/** The titles of the four checks on the Status page live in shared/depth-checks.ts (the UI's initial bundle takes them from there) and are re-exported here. */
import { DEPTH_CHECK_TITLES } from './depth-checks';
export { DEPTH_CHECK_TITLES, type DepthCheckKey } from './depth-checks';

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

/** The API's own sentences (worker/src/api-depth.ts). */
export const DEPTH_NOT_STORED = 'No depth minute has been stored yet.';
export const OWNERS_NOT_STORED = 'No hourly reading of the position and order owners has been stored yet.';
export const DEPTH_STALE_WORDS = 'the newest stored minute is older than three minutes';
/** The minute rows' retention, said whenever a history at one-minute steps is asked: `days` from the configuration's caps.retentionMs. */
export const minuteRowsKept = (days: number) => `minute rows are kept ${days} days; before that, ask for hours`;
export const GAP_MINUTE = 'no row was stored for these minutes (the pool was not read, or nothing was written that minute); nothing is filled in';
export const GAP_HOUR = 'no row was stored for these hours; nothing is filled in';
export const HEAT_HOW: Record<'1m' | '5m' | '1h', string> = {
  '1m': 'one column per stored minute of the aggregate',
  '5m': 'one column per five minutes: the last minute of each five as stored, a missing one left blank',
  '1h': 'one column per stored hour: the hour’s last minute, from the hourly rows',
};
export const QUOTE_HOW_STATES = 'the pool models rebuilt from the minute’s stored states, walked on the stored curve’s own grid and again between the two grid prices the fill fell between';
export const QUOTE_HOW_CURVE = 'the stored aggregate curve alone: the minute’s states were not stored, so the split by pool is empty';
/** An incomplete fill: `filled` is the fill's own figure, `symbol` the base coin's from the configuration. */
export const quoteIncomplete = (side: 'sell' | 'buy', filled: string, symbol: string) =>
  side === 'sell' ? `only ${filled} ${symbol} can be sold before the last bid is used` : `only ${filled} ${symbol} can be bought before the last ask is used`;
/** The history answer stopped at the row cap: `n` is the cap, from the configuration. */
export const historyCut = (n: number) => `the window held more than ${n} rows, so the answer stops at the cap; ask a shorter window or hours`;
/** The `what` of a stored read's provenance line: the table, the pool and the counts are the read's own. */
export const historyRowsWords = (table: string, pool: string, rows: number, steps: number) => `${table} rows of pool ${pool}: ${rows} of ${steps} steps`;
export const heatRowsWords = (table: string, columns: number) => `${table} rows of the aggregate: ${columns} columns`;
export const changesRowsWords = (pool: string | null, rows: number) => `depth_changes rows${pool ? ` of pool ${pool}` : ''}: ${rows}`;

// ---------------------------------------------------------------------------------------------------- the page's words
// Every sentence the depth page (web/src/screens/depth) and the two quotable lines on Home and Trade say, with the base
// coin's symbol, the pool and every figure passed in from the reading or the configuration: nothing here types a figure.
/** The ladder folds the rows further than this from the reference price (percent), and the rows between LADDER_MID_PCT and it. */
export const LADDER_FOLD_PCT = 50;
export const LADDER_MID_PCT = 10;
/** The ladder's band widths, in percent of the reference price (the segmented control's three options). */
export const LADDER_BAND_PCTS = [0.5, 1, 2.5] as const;
/** The stored trades drawn over the curve: this many days back (the series route's own rows). */
export const CURVE_TRADES_DAYS = 7;
/** The page asks the minute again this often (the edge keeps it DEPTH_EDGE_SECONDS), and at once after a swap arrives on the live stream. */
export const DEPTH_REFRESH_MS = 60_000;
/** A quoted size typed into the field is asked after this pause; a chip asks at once. */
export const QUOTE_DEBOUNCE_MS = 400;

/** The base coin's symbol as the page says it (the module's configuration names it for the Worker: worker/src/depth/config.ts base.symbol). */
export const SITE_SYMBOL = 'NAM';
/** The router's direct quote and this page's walk agree within this percent (the check's own tolerance is the configuration's; this is the words' cut). */
export const ROUTER_AGREE_PCT = 0.01;
export const DEPTH_EYEBROW = 'If I trade now';
export const BOOK_EYEBROW = 'The book';
export const LADDER_H2 = 'Asks above the price, bids below, each level naming its pools';
export const CURVE_H2 = 'What rests at each price, both sides, every pool together';
export const HEAD_CUM = 'Cumulative';
export const factAskUsdWithin = (pct: string) => `USD asked within ${pct}`;
export const NOT_STORED_PER_MINUTE = 'not stored per minute';
export const BOOK_WAITS = 'The ladder and the curve are drawn from the minute, so they are not shown until it answers.';
export const ANSWER_WAITS = 'No figure can be shown until the minute answers.';
export const ASKING_SIZE = 'asking for this size';
export const SOURCE_LEVELS = 'Where the levels come from';
export const SOURCE_CURVE = 'Where the curve comes from';
export const depthLead = (symbol: string) =>
  `One answer in money, from the chain’s own state of every pool holding ${symbol}: the concentrated-liquidity tick maps, the weighted and stable pools’ reserves and the order book’s resting orders, filled in the order the best price gives, after each pool’s fee and the chain’s taker fee.`;
export const sideLabel = (side: 'sell' | 'buy', symbol: string) => (side === 'sell' ? `Sell ${symbol}` : `Buy ${symbol}`);
/** 'pool 3005' or 'order book 3008': how a pool is named everywhere on the page. */
export const poolWord = (id: string, type: DepthPoolType | null | undefined) => (type === 'cosmwasm' ? `order book ${id}` : `pool ${id}`);
/** The hero's sentence: the exact figure, the side and the size. */
export const heroWords = (side: 'sell' | 'buy', usd: string, nam: string, symbol: string) =>
  side === 'sell' ? `${usd} USD for selling ${nam} ${symbol} now` : `${usd} USD to buy ${nam} ${symbol} now`;
export const THROUGH = 'through';
/** One split chip: 'pool 3005 9,242 NAM (92%)'. */
export const splitWords = (pool: string, nam: string, symbol: string, pct: string) => `${pool} ${nam} ${symbol} (${pct})`;
export const andMore = (n: number) => `and ${n} more`;
export const FACT_AVG = 'Average price';
export const factMarginal = (symbol: string) => `Last ${symbol} filled at`;
export const factRef = (pool: string) => `Pool ${pool} price`;
/** The reference row's label while the pool's id is not yet known (a rewound strip before the history answers). */
export const FACT_REF_UNNAMED = 'Reference pool price';
export const factTouch = (side: 'sell' | 'buy', n: string, symbol: string) => (side === 'sell' ? `Best bid for ${n} ${symbol}` : `Best ask for ${n} ${symbol}`);
export const factBidWithin = (pct: string) => `USD bid within ${pct} of price`;
export const factAskWithin = (pct: string, symbol: string) => `${symbol} for sale within ${pct}`;
export const vsRefWords = (pct: string, pool: string) => `${pct} vs pool ${pool}’s price`;
export const heightClock = (height: string, clock: string) => `height ${height}, ${clock}`;
export const afterFees = (pool: string) => `${pool}, after fees`;
export const withinAllWords = (all: string, far: string, farPct: string) => `all venues; ${all} in all, ${far} within ${farPct}`;
export const toTakeAll = (usd: string) => `${usd} to take it all`;
/** The router's own answer for the smallest size in the reference pool alone (the minute's check), beside this page's. */
export const routerSays = (usd: string, nam: string, symbol: string, pool: string, clock: string) =>
  `Osmosis’s router says ${usd} USD for selling ${nam} ${symbol} through ${pool} alone (${clock})`;
export const routerOurs = (usd: string) => `this page’s math gives ${usd} USD for the same sale`;
export const ROUTER_AGREE = 'The two agree.';
export const routerDiffer = (pct: string) => `The two differ by ${pct}.`;
export const ROUTER_IDLE = 'The router was not asked a quote in the reference pool this minute, so there is nothing to compare.';
/** When not to act, computed from the reading (verify.txt C3: never typed). */
export const cliffWords = (above: string, symbol: string, sizeA: string, pctA: string, sizeB: string, pctB: string) =>
  `Above the first ${above} ${symbol} each extra ${symbol} fetches less: selling ${sizeA} averages ${pctA}, ${sizeB} averages ${pctB}.`;
export const cliffBuyWords = (above: string, symbol: string, sizeA: string, pctA: string, sizeB: string, pctB: string) =>
  `Above the first ${above} ${symbol} each extra ${symbol} costs more: buying ${sizeA} averages ${pctA}, ${sizeB} averages ${pctB}.`;
export const bookBidUnder = (pct: string, book: string) => `The ${book}’s nearest bid is ${pct} under the pool price after fees: sell into the pools, not the book.`;
/** The reading's share of what rests on its side: the bids' USD selling (`total` is a USD figure), the asks' coins buying (`total` is a coin figure with its symbol, since an ask side's USD would be read off the curve's far tail at prices that will never trade). */
export const marketWords = (side: 'sell' | 'buy', total: string, nam: string, symbol: string, share: string) =>
  side === 'sell' ? `This is a ${total} market on the bid side: selling ${nam} ${symbol} takes ${share} of it.` : `This is a ${total} market on the ask side: buying ${nam} ${symbol} takes ${share} of it.`;
export const ladderLead = (symbol: string) => `Asks above the price, bids below, each level naming its pools; distance is from the reference pool’s price. A level of a concentrated pool is ${CL_LEVEL_WORDS}; the order book’s levels are real orders. Prices in USD per ${symbol}.`;
export const bandHead = (symbol: string) => `Price band, USD per ${symbol}`;
export const HEAD_RESTING = 'Resting';
export const HEAD_FROM = 'From price';
export const HEAD_POOLS = 'Where';
export const bandWidthLabel = (pct: string) => `${pct} levels`;
export const refRowWords = (pool: string, price: string) => `Pool ${pool} price ${price}`;
export const bestWords = (side: 'bid' | 'ask', n: string, symbol: string, price: string, pool: string) => `best ${side} for ${n} ${symbol} ${price} (${pool})`;
export const spreadWords = (pct: string) => `that spread is ${pct} after fees`;
export const crossedWords = (n: string, symbol: string, pct: string, askPool: string, bidPool: string) =>
  `crossed across pools: ${n} ${symbol} is ${pct} cheaper to buy in ${askPool} than it fetches in ${bidPool}, after fees`;
export const foldFar = (side: 'ask' | 'bid', count: number, pct: string, price: string, amount: string) =>
  side === 'ask' ? `${count} more ask levels above +${pct}, up to ${price} (${amount})` : `${count} more bid levels below −${pct}, down to ${price} (${amount})`;
export const foldMid = (side: 'ask' | 'bid', count: number, from: string, to: string, amount: string) =>
  side === 'ask' ? `${count} ask levels between +${from} and +${to} (${amount})` : `${count} bid levels between −${from} and −${to} (${amount})`;
export const hideFold = (side: 'ask' | 'bid', what: string) => `hide the ${side}s ${what}`;
export const poolFeeChip = (pool: string, feePct: string) => `${pool} · ${feePct} fee`;
export const bookChip = (pool: string) => `${pool} · limit order, no fee`;
export const rangesWords = (n: number) => `${n} tick ${n === 1 ? 'range' : 'ranges'}`;
export const ordersWords = (n: number) => `${n} ${n === 1 ? 'order' : 'orders'}`;
/** A weighted or stable pool's share of a band comes from its reserves (one point on the price axis), not from tick ranges or orders. */
export const RESERVES_WORDS = 'from its reserves';
export const sideWord = (side: 'ask' | 'bid') => (side === 'ask' ? 'Asks' : 'Bids');
/** A ladder row's open button, for a screen reader: the side, the band, what rests and the distance. */
export const openBandAria = (side: 'ask' | 'bid', lo: string, hi: string, amount: string, dist: string) => `${sideWord(side)} from ${lo} to ${hi}: ${amount}, ${dist} from the price. Open the band.`;
export const sheetTitle = (side: 'ask' | 'bid', lo: string, hi: string) => `${sideWord(side)} ${lo} – ${hi}`;
export const distFromPrice = (pct: string) => `${pct} from the price`;
export const LADDER_TABLE_LABEL = 'Every level, both sides, every pool together';
export const SOURCE_EVERY_LEVEL = 'Every level';
export const LABEL_LEVEL_WIDTH = 'Level width';
export const takerOnEvery = (pct: string) => `plus the ${pct} taker fee on every swap`;
export const sellDownWords = (price: string, usd: string) => `selling down to ${price} fetches ${usd} in all`;
export const buyUpWords = (price: string, usd: string) => `buying up to ${price} costs ${usd} in all`;
export const markedBand = (nam: string, symbol: string) => `the last ${nam} ${symbol} of the picked size fills here`;
export const curveLead = (symbol: string) =>
  `Price across, in USD per ${symbol}; cumulative USD up. Left of the pool price: the USD you would receive selling down to that price. Right: what it would cost to buy up to it. The stored trades of the last week sit on the same axes, so quoted and realised can be compared.`;
export const CURVE_RANGES = [
  { value: 'near', label: '½× to 2×' },
  { value: 'wide', label: '⅒× to 10×' },
  { value: 'all', label: 'Everything resting' },
] as const;
export const axisPrice = (symbol: string, log: boolean) => `USD per ${symbol}${log ? ', log scale' : ''}`;
export const AXIS_USD = 'cumulative USD';
export const keyBids = (symbol: string) => `Bids: USD received selling ${symbol}`;
export const keyAsks = (symbol: string) => `Asks: USD paid buying ${symbol}`;
export const keyTrades = (days: number) => `Stored trade of the last ${days} days: its settle price and value`;
export const keyRef = (pool: string) => `Pool ${pool} price`;
export const sizeMark = (size: string, usd: string) => `${size} → ${usd}`;
export const tradesInView = (n: number, total: number, days: number) => `${n} of the ${total} stored trades of the last ${days} days fall in this view`;
export const tradesNone = (days: number) => `no stored trade in the last ${days} days`;
export const tradesCut = (n: number, days: number) => `the newest ${n} stored trades of the last ${days} days`;
export const readoutWords = (side: 'bid' | 'ask', usd: string, nam: string, symbol: string) =>
  side === 'bid' ? `${usd} received selling ${nam} ${symbol} down to here` : `${usd} paid buying ${nam} ${symbol} up to here`;
export const READOUT_AT = 'at';
/** The readout's pools line names the pools whose figure grows at the price, the largest first, at most so many by name (fewer when the
 *  width holds fewer, DepthChart), and counts the rest ("pool 3005, pool 3368, pool 3015 and 10 more"): one complete line whatever the
 *  price, so the readout keeps one height and the plot never moves. */
export const READOUT_POOLS_NAMED = 3;
export const readoutPools = (names: string[], more: number) => (more > 0 ? `${names.join(', ')} and ${more} more` : names.join(', '));
export const READOUT_NONE = 'Press or use the arrow keys to read the curve at a price.';
/** The chart's own words: the figure's caption, the plot's group label, a trade's title, the summary for a screen reader. */
export const chartAria = (scale: 'log' | 'linear', lo: string, hi: string, symbol: string, marks: number, trades: number) =>
  `Cumulative USD by price, ${scale} scale from ${lo} to ${hi} USD per ${symbol}: the bid curve left of the pool price, the ask curve right of it, ${marks} size marks and ${trades} stored trades.`;
export const CHART_GROUP_LABEL = 'The curve. Arrow keys read it point by point.';
export const tradeTitle = (kind: 'buy' | 'sell', nam: string, symbol: string, price: string, usd: string, clock: string) => `${kind === 'buy' ? 'Bought' : 'Sold'} ${nam} ${symbol} at ${price}, ${usd}, ${clock}`;
export const chartSummary = (bidUsd: string, lo: string, askUsd: string, hi: string) => `Bids: ${bidUsd} USD down to ${lo}. Asks: ${askUsd} USD up to ${hi}.`;
export const NO_POINT_IN_WINDOW = 'No point in this window.';
export const LABEL_PRICE_WINDOW = 'Price window';
export const tradesToggle = (days: number) => `${days}-day trades`;
export const SOURCE_THE_CURVE = 'The curve';
export const SOURCE_STORED_TRADES = 'Stored trades';
export const FLOW_INDEX_PLAIN = 'Flow index';
export const TRADES_FAILED = 'The stored trades did not answer.';
export const TRADES_NO_PAGE = 'no page answered';
/** `ago` is the running-text age (shared/format.ts fmtAgo: 'just now', '32 s ago'). */
export const updatedAgo = (ago: string) => `updated ${ago}`;
export const readingOf = (clock: string) => `reading of ${clock}`;
export const TABLE_VIEW = 'Table view';
export const CHART_VIEW = 'Chart view';
/** Rewind. */
export const REWIND_NO_SPLIT = 'The split by pool was not stored, so it is not shown for a past minute.';
export const REWIND_NO_BOOK = 'The ladder and the curve are built from the minute’s own tick maps, which are not stored, so they are not shown for a past minute. The stored figures of that minute are above.';
export const rewindMinute = (clock: string) => `the stored minute of ${clock}`;
export const REWIND_NO_MINUTE = 'No depth minute was stored around that time.';
export const REWIND_FIELD_OFF = 'Only the stored sizes can be read for a past minute.';
/** The page's own failure words (never a URL). */
export const DEPTH_UNSERVED = 'This server does not serve the depth routes yet.';
export const DEPTH_FAILED = 'The depth reading did not answer.';
export const QUOTE_FAILED = 'The quote for this size did not answer.';
export const DEPTH_ASKING = 'Asking now.';
/** The answer band's labels and small sentences. */
export const HERO_GET = 'You get';
export const HERO_PAY = 'You pay';
export const heroVerb = (side: 'sell' | 'buy') => (side === 'sell' ? HERO_GET : HERO_PAY);
export const MINUTE_NOT_ANSWERED = 'The minute has not answered yet.';
export const SPLIT_LABEL = 'Which pools fill it';
export const NOT_AMOUNT = 'That is not an amount.';
export const amountsAre = (symbol: string) => `Amounts are numbers of ${symbol}, written with digits.`;
export const MINUTE_FIGURES = 'The minute’s figures';
export const STORED_MINUTE_FIGURES = 'The stored minute’s figures';
export const FETCHING_MINUTE = 'Fetching the minute';
export const TAB_LEVELS = 'Levels';
export const TAB_CURVE = 'Curve';
export const LABEL_SIDE = 'Side';
export const LABEL_SIZE = 'Size';
export const LABEL_AMOUNT = 'Amount';
export const LABEL_BOOK_VIEW = 'Book view';
export const TRY_AGAIN = 'Try again';
/** The quotable line's labels (Home and Trade). */
export const LINE_SELL_LABEL = 'Selling the quoted size across every pool';
export const LINE_BID_LABEL = 'USD of bids within the quoted distance of the price';
export const LINE_DOT_LABEL = 'The depth minute';
export const LINE_SOURCE = 'Osmosis depth';
/** The two quotable lines (Home, Trade and the server-rendered page): the figures and the time come from the minute. */
export const sellQuotableLead = (nam: string, symbol: string) => `Selling ${nam} ${symbol} now fetches`;
export const SELL_QUOTABLE_TAIL = 'across every Osmosis pool';
export const sellQuotable = (nam: string, symbol: string, usd: string) => `${sellQuotableLead(nam, symbol)} ${usd} ${SELL_QUOTABLE_TAIL}`;
export const bidQuotableTail = (pct: string) => `of bids within ${pct} of the price`;
export const bidQuotable = (usd: string, pct: string) => `${usd} ${bidQuotableTail(pct)}`;
export const DEPTH_LINK = 'Every bid and ask';
export const DEPTH_SOURCE_LABEL = 'Where the depth comes from';
export const DEPTH_PLAIN_SOURCE = 'Osmosis chain';
/** The plain words of each read's `what`, for the SourceLine; the raw `what` stays in the sheet. */
export const provLabel = (what: string) => what;

// ---------------------------------------------------------------------------------------------------- views 3 and 4 (step S6)
/** The time view. */
export const OVER_EYEBROW = 'Over time';
export const OVER_H2 = 'Where the liquidity rested, minute by minute';
export const overLead = (symbol: string) =>
  `Time across, price up in USD per ${symbol}. The colour is the USD resting in each band of the reference price, from the stored minutes; the reference pool’s own price is the line, and a stored trade is a dot sized by its ${symbol}. A minute with no stored row is a blank column and the line breaks there; nothing is filled in.`;
export const LABEL_WINDOW = 'Window';
/** The three windows are input choices (as a chart's 24h / 7d / 30d), not figures; the value is the days asked of the heat route. */
export const HEAT_RANGES = [
  { value: '1', label: '24 h' },
  { value: '7', label: '7 d' },
  { value: '30', label: '30 d' },
] as const;
export const HEAT_STEP_WORDS: Record<'1m' | '5m' | '1h', string> = { '1m': 'minute', '5m': 'five minutes', '1h': 'hour' };
/** 'one column per five minutes, 288 of them, 3 blank' */
export const columnsWords = (n: number, step: string, blank: number) => `one column per ${step}, ${n} of them${blank ? `, ${blank} blank` : ''}`;
export const PHONE_FIVE = 'On a narrow screen the day is drawn in five-minute columns, the last stored minute of each five.';
export const HEAT_LEGEND_LABEL = 'USD resting in a band';
export const legendStep = (lo: string, hi: string) => `${lo} – ${hi}`;
export const legendTop = (lo: string) => `${lo} and above`;
export const legendBlank = (floor: string) => `under ${floor}: blank`;
export const KEY_GAP = 'A blank column: no minute stored';
export const keyTradesSized = (days: number, symbol: string) => `Stored trade of the last ${days} days, sized by its ${symbol}; bot round trips are left out by the flow index`;
export const heatReadout = (clock: string, side: 'bid' | 'ask', usd: string, lo: string, hi: string) =>
  side === 'bid' ? `${clock}: ${usd} resting to buy between ${lo} and ${hi}` : `${clock}: ${usd} for sale between ${lo} and ${hi}`;
export const heatReadoutBlank = (clock: string, lo: string, hi: string) => `${clock}: nothing above the floor between ${lo} and ${hi}`;
/** The band straddling the reference price holds both sides: the sum, then each side's own figure. */
export const heatReadoutBoth = (clock: string, usd: string, bid: string, ask: string, lo: string, hi: string) =>
  `${clock}: ${usd} resting on both sides between ${lo} and ${hi}: ${bid} to buy under the reference price, ${ask} for sale above it`;
export const heatGapReadout = (clock: string) => `${clock}: no minute stored`;
export const HEAT_READOUT_NONE = 'Press or use the arrow keys to read a band at a time.';
export const HEAT_GROUP_LABEL = 'The bands over time. Left and right move in time, up and down in price.';
export const heatAria = (n: number, blank: number, lo: string, hi: string, symbol: string, trades: number) =>
  `USD resting per price band over time: ${n} columns, ${blank} blank, prices from ${lo} to ${hi} USD per ${symbol}, ${trades} stored trades.`;
export const HEAT_TABLE_LABEL = 'The columns listed: the reference price and the band holding most on each side';
/** The table lists at most so many rows; it says which: 'every column listed', or '60 of 1,440 columns listed, one in 24, and the last'. */
export const HEAT_TABLE_ALL = 'every column listed';
export const tableThinned = (shown: string, n: string, every: string) => `${shown} of ${n} columns listed, one in ${every}, and the last`;
export const HEAD_TIME = 'Time';
export const HEAD_REF_PRICE = 'Reference price';
export const HEAD_BID_MOST = 'Largest bid band';
export const HEAD_ASK_MOST = 'Largest ask band';
export const HEAD_BID_ALL = 'Bids in the bands';
export const HEAD_ASK_ALL = 'Asks in the bands';
export const HEAT_NO_COLUMN = 'no minute stored';
export const HEAT_WAITS = 'The time view is drawn from the stored minutes, so it is not shown until they answer.';
export const HEAT_NONE = 'No minute is stored in this window.';
/** The honest start, with the first stored minute's date (the history answer's recordedSince: the earlier of the first minute row and the first hourly row, so the retention's edge is never named as the start). */
export const recordedSince = (when: string) => `Depth has been recorded since ${when}; nothing on the chain gives earlier depth.`;
/** The gaps the history answer lists for the window, under the executable line: the count, the longest in words (fmtAge), and when it began. */
export const gapsWords = (n: number, longest: string, began: string) => `${n} ${n === 1 ? 'stretch' : 'stretches'} of this window ${n === 1 ? 'has' : 'have'} no stored row and ${n === 1 ? 'is' : 'are'} drawn blank; the longest, ${longest}, began ${began}`;
export const GAPS_NONE = 'Every step of this window up to the newest due has a stored row.';
/** The executable line under the heat. */
export const execH2 = (nam: string, symbol: string) => `What selling ${nam} ${symbol} fetched, each stored minute`;
export const execUnit = (symbol: string) => `USD out for the quotable size of ${symbol}, every stored minute; shaded: the lowest and highest of each hour`;
export const execTakeaway = (nam: string, symbol: string, last: string, lo: string, hi: string) => `Selling ${nam} ${symbol} fetched ${last} at the last stored minute, between ${lo} and ${hi} over the window`;
export const execOne = (nam: string, symbol: string, last: string) => `Selling ${nam} ${symbol} fetched ${last} at the one stored minute in the window`;
export const EXEC_NONE = 'No stored minute in this window.';
export const KEY_BAND_HOUR = 'Shaded: the lowest and highest of each hour';
export const KEY_EXEC = 'The USD fetched, each stored minute';
export const EXEC_LOW = 'Low';
export const EXEC_HIGH = 'High';
export const EXEC_LAST = 'Last stored minute';
export const EXEC_READING = 'Reading';
export const EXEC_READOUT_NONE = 'Press or use the arrow keys to read a minute.';
export const EXEC_GROUP_LABEL = 'The line. Arrow keys read it minute by minute.';
export const execGapReadout = (clock: string) => `${clock}: no minute stored`;
export const SOURCE_OVER = 'Where the time view comes from';
export const SOURCE_HEAT = 'The heat bands';
export const SOURCE_EXEC = 'The stored minutes';
export const SOURCE_HOURS = 'The stored hours';
export const SOURCE_CHANGES = 'The change rows';
/** The change rows in the window. */
export const CHANGES_H3 = 'What moved';
export const changesInWindow = (n: number) => `${n} changes of resting liquidity in this window`;
/** The read stopped at its page cap inside the window: the count is a floor, never the window's count. */
export const changesAtLeast = (n: number) => `at least ${n} changes of resting liquidity in this window: the read stopped at the newest ${n}`;
export const changesListed = (n: number) => `the newest ${n} are listed`;
export const CHANGES_NONE = 'No change of resting liquidity was recorded in this window.';
export const CHANGES_LEAD = 'Each row is the difference between two readings of the chain: a tick range or the reserves of a pool each minute, a position or an order each hour with the address that holds it.';
export const CHANGE_VERBS: Record<DepthChangeRow['kind'], string> = { added: 'added to', removed: 'withdrawn from', filled: 'filled in', grew: 'grew in', shrank: 'shrank in' };
/** A position's range in words: the two prices, or, for a position whose range spans every price the pool can reach, the whole range. */
export const rangeWords = (lo: string, hi: string) => `${lo} – ${hi}`;
export const FULL_RANGE = 'the whole price range';
export const positionWhat = (id: string, range: string) => `position ${id} (${range})`;
export const orderWhat = (id: string, side: 'bid' | 'ask' | null, price: string) => `${side ? `${side} ` : ''}order ${id} at ${price}`;
export const rangeWhat = (lo: string, hi: string) => `a tick range ${lo} – ${hi}`;
export const RESERVES_WHAT = 'the pool’s reserves';
/** '28 Oct, 14:49 UTC: position 15533107 (0.000902 – 0.000923) withdrawn from pool 3005 by osmo1…: 201,000 NAM, $190' */
export const changeWords = (clock: string, what: string, verb: string, pool: string, owner: string | null, size: string) => `${clock}: ${what} ${verb} ${pool}${owner ? ` by ${owner}` : ''}: ${size}`;
export const sizeWords = (nam: string, symbol: string, usd: string) => `${nam} ${symbol}, ${usd}`;
/** The same sentence in pieces, so the owner can be the address control: head, then BY_WORD and the owner, then the size after a colon. */
export const changeHead = (clock: string, what: string, verb: string, pool: string) => `${clock}: ${what} ${verb} ${pool}`;
export const BY_WORD = 'by';
export const CHANGE_NO_SIZE = 'size not stored';
/** The cost and what was left out, under the time view. */
export const COST_LABEL = 'What a minute costs';
export const minuteCostWords = (reads: number, kb: string, ms: string) => `${reads} requests, ${kb} read, ${ms} of reading, for the newest minute`;
export const COST_CAPS = 'The caps the minute runs under are the Worker’s configuration; the Sources sheet carries the store’s row against them.';
export const LEFT_OUT_LABEL = 'Left out, and why';
export const LEFT_OUT_NONE = 'Every listed pool was read and priced this minute.';
export const leftOutPool = (pool: string, pair: string, why: string) => `${pool} (${pair}): ${why}`;
export const notReadPool = (pool: string, pair: string, why: string) => `${pool} (${pair}): not read this minute (${why}); its last reading is not counted`;
/** A pair whose counter coin has no symbol in the quote service's metadata is named in words, never by its raw denomination. */
export const pairUnnamed = (symbol: string) => `${symbol} / a coin the metadata does not name`;
export const leftOutNamada = (symbol: string) => `The Namada side: ${symbol} on its own chain has no pool or order book to read, so only Osmosis is counted.`;
/** Who holds it. */
export const WHO_EYEBROW = 'Who holds it';
export const WHO_H2 = 'The addresses whose positions and orders are the liquidity';
export const whoLead = (symbol: string) =>
  `Every concentrated-liquidity position and every resting order, grouped by the address that holds it, from the hourly read of the chain; the largest share of the USD resting first. A position gives both coins inside its range and ${symbol} alone above it; an order rests in one coin at one price.`;
export const HEAD_OWNER = 'Owner';
export const headResting = (symbol: string) => `${symbol} resting`;
export const HEAD_USD_RESTING = 'USD resting';
export const HEAD_SHARE = 'Share';
export const HEAD_HOLDS = 'Holds';
export const HEAD_SINCE = 'Since';
export const positionsWords = (n: number) => `${n} ${n === 1 ? 'position' : 'positions'}`;
export const holdsWords = (positions: number, orders: number) => [positions ? positionsWords(positions) : '', orders ? ordersWords(orders) : ''].filter(Boolean).join(', ');
export const replacedWords = (n: number) => `replaced ${n} ${n === 1 ? 'time' : 'times'} this week`;
export const itemPosition = (id: string, range: string, nam: string, symbol: string, usd: string, inRange: boolean) =>
  `position ${id}: ${range}, ${nam} ${symbol} and ${usd}${inRange ? ', holding the price' : ''}`;
export const itemOrder = (id: string, side: 'bid' | 'ask' | null, price: string, remaining: string, placed: string, unit: string) =>
  `${side ? `${side} ` : ''}order ${id} at ${price}: ${remaining} of ${placed} ${unit} left`;
/** A bid order's quantities are the counter coin's, priced as USD (the hero's rule, counterUsdHow); an ask order's are the base coin's, whose symbol the configuration gives. */
export const ORDER_BID_UNIT = 'USD';
export const ownersTotals = (n: number, positions: number, orders: number, usd: string) => `${n} owners, ${positions} positions and ${orders} orders, ${usd} resting`;
export const ownersLabelled = (n: number) => `${n} labelled through the labels table`;
export const OWNERS_NONE_LABELLED = 'none labelled';
export const ownersReadAt = (clock: string, height: string) => `read ${clock}, height ${height}`;
export const OWNERS_SOURCE_LABEL = 'Where the owners come from';
export const SOURCE_OWNERS = 'The hourly read';
export const OWNERS_REWIND = 'The owners are read once an hour and kept as the newest hour only, so they are not shown for a past moment.';
export const OWNERS_WAITS = 'The owners cannot be listed until the hourly read answers.';
export const ITEMS_LABEL = 'Each position and order';
export const INVARIANTS_LABEL = 'The hour’s own checks';
export const INV_OK = 'holds';
export const INV_NOT = 'does not hold';
export const INV_NONE = 'not checked';
export const ORDERS_CARRIED = 'the orders are the hour before’s reading';
export const openOwnerAria = (name: string) => `${name}: each position and order`;

/** Every fixed sentence above, for test/depth-words.test.ts: none may carry a figure. */
export const DEPTH_FIXED_WORDS: readonly string[] = [
  ...Object.values(DEPTH_SOURCES), ...Object.values(DEPTH_CHECK_TITLES), HEAT_RANGE_WORDS, CL_LEVEL_WORDS, UNPRICED_NO_PRICE, UNPRICED_NO_TAKER, UNPRICED_EMPTY, UNPRICED_NO_META,
  BOOK_LEG_LEFT_OUT, USDC_AS_ONE, SELL_INTO_POOLS, HONEST_START, NO_BIDS, NO_ASKS,
  ...Object.values(INVARIANT_WORDS), OWNERS_NO_ARCHIVE, BOOK_NOT_READ_CLOSING, OWNERS_NO_MINUTE,
  DEPTH_NOT_STORED, OWNERS_NOT_STORED, DEPTH_STALE_WORDS, GAP_MINUTE, GAP_HOUR, ...Object.values(HEAT_HOW), QUOTE_HOW_STATES, QUOTE_HOW_CURVE,
  DEPTH_EYEBROW, BOOK_EYEBROW, LADDER_H2, CURVE_H2, HEAD_CUM, NOT_STORED_PER_MINUTE, BOOK_WAITS, ANSWER_WAITS, ASKING_SIZE, SOURCE_LEVELS, SOURCE_CURVE, THROUGH, FACT_AVG, ROUTER_AGREE, ROUTER_IDLE, HEAD_RESTING, HEAD_FROM, HEAD_POOLS, AXIS_USD, READOUT_AT, READOUT_NONE, TABLE_VIEW, CHART_VIEW,
  REWIND_NO_SPLIT, REWIND_NO_BOOK, REWIND_NO_MINUTE, REWIND_FIELD_OFF, DEPTH_UNSERVED, DEPTH_FAILED, QUOTE_FAILED, DEPTH_ASKING, DEPTH_LINK, DEPTH_SOURCE_LABEL, DEPTH_PLAIN_SOURCE,
  RESERVES_WORDS, LADDER_TABLE_LABEL, SOURCE_EVERY_LEVEL, LABEL_LEVEL_WIDTH, CHART_GROUP_LABEL, NO_POINT_IN_WINDOW, LABEL_PRICE_WINDOW, SOURCE_THE_CURVE, SOURCE_STORED_TRADES, FLOW_INDEX_PLAIN, TRADES_FAILED, TRADES_NO_PAGE,
  HERO_GET, HERO_PAY, MINUTE_NOT_ANSWERED, SPLIT_LABEL, NOT_AMOUNT, MINUTE_FIGURES, STORED_MINUTE_FIGURES, FETCHING_MINUTE, TAB_LEVELS, TAB_CURVE, LABEL_SIDE, LABEL_SIZE, LABEL_AMOUNT, LABEL_BOOK_VIEW, TRY_AGAIN,
  LINE_SELL_LABEL, LINE_BID_LABEL, LINE_DOT_LABEL, LINE_SOURCE, FACT_REF_UNNAMED,
  // step S6: the time view, the change rows, the cost line and the owners
  OVER_EYEBROW, OVER_H2, LABEL_WINDOW, ...Object.values(HEAT_STEP_WORDS), PHONE_FIVE, HEAT_LEGEND_LABEL, KEY_GAP, HEAT_READOUT_NONE, HEAT_GROUP_LABEL, HEAT_TABLE_LABEL, HEAT_TABLE_ALL, GAPS_NONE, HEAD_TIME, HEAD_REF_PRICE, HEAD_BID_MOST, HEAD_ASK_MOST, HEAD_BID_ALL, HEAD_ASK_ALL, HEAT_NO_COLUMN, HEAT_WAITS, HEAT_NONE,
  EXEC_NONE, KEY_BAND_HOUR, KEY_EXEC, EXEC_LOW, EXEC_HIGH, EXEC_LAST, EXEC_READING, EXEC_READOUT_NONE, EXEC_GROUP_LABEL, SOURCE_OVER, SOURCE_HEAT, SOURCE_EXEC, SOURCE_HOURS, SOURCE_CHANGES,
  CHANGES_H3, CHANGES_NONE, CHANGES_LEAD, ...Object.values(CHANGE_VERBS), RESERVES_WHAT, CHANGE_NO_SIZE, BY_WORD, COST_LABEL, COST_CAPS, LEFT_OUT_LABEL, LEFT_OUT_NONE,
  WHO_EYEBROW, WHO_H2, HEAD_OWNER, HEAD_USD_RESTING, HEAD_SHARE, HEAD_HOLDS, HEAD_SINCE, OWNERS_NONE_LABELLED, OWNERS_SOURCE_LABEL, SOURCE_OWNERS, OWNERS_REWIND, OWNERS_WAITS, ITEMS_LABEL, INVARIANTS_LABEL, INV_OK, INV_NOT, INV_NONE, ORDERS_CARRIED, FULL_RANGE, ORDER_BID_UNIT,
];
/** The sentences built from a read or the configuration, with sample arguments: the only figures they carry are the ones passed in. */
export const DEPTH_BUILT_WORDS: readonly string[] = [
  bookSource('3008'), UNPRICED_NOT_READ('status 429'), counterUsdHow('OSMO', 0.0529, '02:56 UTC'), notReadSince('02:56 UTC', 'status 429'), cutByCap(40), dustWords(1, 'NAM'),
  quoteIncomplete('sell', '1,234,567', 'NAM'), quoteIncomplete('buy', '1,234,567', 'NAM'), historyCut(43200), minuteRowsKept(30),
  historyRowsWords('depth_minute', 'all', 1420, 1440), heatRowsWords('depth_hourly', 720), changesRowsWords('3005', 200), changesRowsWords(null, 200),
];
/** The page's sentences with sample arguments (the figures are the arguments and nothing else), checked the same way. */
export const DEPTH_PAGE_WORDS: readonly string[] = [
  depthLead('NAM'), sideLabel('sell', 'NAM'), sideLabel('buy', 'NAM'), poolWord('3005', 'concentrated'), poolWord('3008', 'cosmwasm'), heroWords('sell', '9.922965', '10,000', 'NAM'), heroWords('buy', '10.2', '10,000', 'NAM'),
  splitWords('pool 3005', '9,242', 'NAM', '92%'), andMore(3), factMarginal('NAM'), factRef('3005'), factTouch('sell', '100', 'NAM'), factTouch('buy', '100', 'NAM'), factBidWithin('10%'), factAskWithin('10%', 'NAM'),
  vsRefWords('−2.7%', '3005'), heightClock('73,428,670', '02:47 UTC'), afterFees('pool 3005'), withinAllWords('$506.80', '$121.53', '50%'), toTakeAll('$39.76'),
  routerSays('1.014160', '1,000', 'NAM', 'pool 3005', '02:47 UTC'), routerOurs('1.014160'), routerDiffer('0.14%'),
  cliffWords('1,000', 'NAM', '100,000', '−16.6%', '1,000,000', '−67.7%'), cliffBuyWords('1,000', 'NAM', '100,000', '+16.6%', '1,000,000', '+67.7%'), bookBidUnder('65.7%', 'order book 3008'), marketWords('sell', '$506.80', '10,000', 'NAM', '2%'), marketWords('buy', '1,726,372 NAM', '10,000', 'NAM', '0.58%'),
  ladderLead('NAM'), bandHead('NAM'), bandWidthLabel('1%'), refRowWords('3005', '0.0010199'), bestWords('bid', '100', 'NAM', '0.0010168', 'pool 3005'), bestWords('ask', '100', 'NAM', '0.0009886', 'pool 3009'), spreadWords('−2.77%'), crossedWords('100', 'NAM', '2.77%', 'pool 3009', 'pool 3005'),
  foldFar('ask', 1171, '50%', '198.57', '1,322,018 NAM'), foldFar('bid', 12, '50%', '0.0000001', '$12.40'), foldMid('ask', 31, '10%', '50%', '371,945 NAM'), foldMid('bid', 4, '10%', '50%', '$95.10'), hideFold('ask', 'above +50%'),
  poolFeeChip('pool 3005', '0.2%'), bookChip('order book 3008'), rangesWords(1), rangesWords(3), ordersWords(1), ordersWords(2), takerOnEvery('0.1%'), sellDownWords('0.0010098', '$1.41'), buyUpWords('0.0010301', '$2.12'), markedBand('10,000', 'NAM'),
  curveLead('NAM'), axisPrice('NAM', true), axisPrice('NAM', false), keyBids('NAM'), keyAsks('NAM'), keyTrades(7), keyRef('3005'), sizeMark('10k', '$9.92'), tradesInView(387, 389, 7), tradesNone(7), tradesCut(300, 7),
  readoutWords('bid', '$9.92', '10,000', 'NAM'), readoutWords('ask', '$10.37', '10,000', 'NAM'), readoutPools(['pool 3005', 'pool 3368', 'pool 3015'], 10), readoutPools(['pool 3005'], 0), updatedAgo('12 s ago'), readingOf('02:56 UTC'), rewindMinute('02:56 UTC'),
  sellQuotable('10,000', 'NAM', '$9.92'), bidQuotable('$26.43', '10%'), sellQuotableLead('10,000', 'NAM'), bidQuotableTail('10%'), factAskUsdWithin('10%'),
  sideWord('ask'), sideWord('bid'), openBandAria('bid', '0.0010098', '0.0010199', '$1.41', '−1.0%'), sheetTitle('ask', '0.0010199', '0.0010301'), distFromPrice('−1.0%'),
  chartAria('linear', '0.00051', '0.00204', 'NAM', 8, 3), chartAria('log', '0.000102', '0.0102', 'NAM', 8, 4), tradeTitle('buy', '400', 'NAM', '0.001025', '$0.41', '28 Oct, 02:56 UTC'), tradeTitle('sell', '10,000', 'NAM', '0.00099', '$9.90', '28 Oct, 02:56 UTC'),
  chartSummary('506.80', '0.0000001', '1,083,780', '201.59'), tradesToggle(7), heroVerb('sell'), heroVerb('buy'), amountsAre('NAM'),
  // step S6
  overLead('NAM'), columnsWords(288, 'five minutes', 3), columnsWords(1440, 'minute', 0), legendStep('$0.03', '$0.11'), legendTop('$4.21'), legendBlank('$0.03'), keyTradesSized(7, 'NAM'),
  heatReadout('28 Oct, 02:40 UTC', 'bid', '$12.40', '0.0010050', '0.0010301'), heatReadout('28 Oct, 02:40 UTC', 'ask', '$12.40', '0.0010050', '0.0010301'), heatReadoutBlank('28 Oct, 02:40 UTC', '0.0010050', '0.0010301'), heatGapReadout('28 Oct, 02:40 UTC'),
  heatReadoutBoth('28 Oct, 02:40 UTC', '$5.45', '$0.18', '$5.27', '0.0010163', '0.0010417'), tableThinned('60', '1,440', '24'), gapsWords(1, '20 min', '28 Oct, 02:40 UTC'), gapsWords(2, '1.2 h', '28 Oct, 02:40 UTC'), changesAtLeast(1000),
  heatAria(288, 3, '0.00025', '0.0041', 'NAM', 4), recordedSince('26 Oct 2026, 12:00 UTC'), execH2('10,000', 'NAM'), execUnit('NAM'), execTakeaway('10,000', 'NAM', '$9.92', '$9.80', '$9.95'), execOne('10,000', 'NAM', '$9.92'), execGapReadout('28 Oct, 02:40 UTC'),
  changesInWindow(12), changesListed(200), positionWhat('15533107', rangeWords('0.000902', '0.000923')), positionWhat('14599704', FULL_RANGE), orderWhat('140', 'ask', '1.0'), orderWhat('140', null, '1.0'), rangeWhat('0.00090', '0.00092'),
  changeWords('28 Oct, 14:49 UTC', 'position 15533107 (0.000902 – 0.000923)', 'withdrawn from', 'pool 3005', 'osmo1…9l27', '201,000 NAM, $190'), changeWords('28 Oct, 14:49 UTC', 'the pool’s reserves', 'grew in', 'pool 3439', null, '990 NAM, $1.02'), sizeWords('201,000', 'NAM', '$190'), changeHead('28 Oct, 14:49 UTC', 'order 140 at 1.0', 'filled in', 'order book 3008'),
  minuteCostWords(6, '57.5 KB', '1.2 s'), leftOutPool('pool 3020', 'NAM / UM', UNPRICED_NO_PRICE), notReadPool('pool 3368', 'NAM / OSMO', 'status 429'), leftOutNamada('NAM'), pairUnnamed('NAM'),
  whoLead('NAM'), headResting('NAM'), positionsWords(1), positionsWords(4), holdsWords(4, 10), holdsWords(0, 1), replacedWords(1), replacedWords(3), itemPosition('14599704', FULL_RANGE, '156,566', 'NAM', '$159.67', true), itemPosition('15533107', rangeWords('0.000902', '0.000923'), '201,000', 'NAM', '$190', false),
  itemOrder('140', 'ask', '1.0', '221', '221', 'NAM'), ownersTotals(50, 49, 43, '$916,851'), ownersLabelled(3), ownersReadAt('03:05 UTC', '73,429,291'), openOwnerAria('osmo1…9l27'),
  // the curve's three windows and the heat's are input choices (as a chart's 24h / 7d / 30d), not figures
  ...CURVE_RANGES.map((r) => r.label),
  ...HEAT_RANGES.map((r) => r.label),
];
export const DEPTH_WORDS: readonly string[] = [...DEPTH_FIXED_WORDS, ...DEPTH_BUILT_WORDS, ...DEPTH_PAGE_WORDS];
