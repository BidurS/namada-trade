// The trades the executed price counts, and the words for the hours that had one.
//
// The Trade tab counts "hours with a trade" in three places, and each counts something different: the price line
// counts hours that had a trade it takes its price from (the rule below), the average-price panel counts hours with
// any buy or sell, and the volume bars count hours with a bar. Under the same words the three figures read as one
// figure with three values. Each place therefore says what it counts, in the words kept here, and the rule's own
// number is the one the Worker applies (worker/src/series.ts singlePoolUsdc, worker/src/cron.ts SINGLE_POOL_USDC_SWAP).

/** The smallest trade, in NAM, the executed price takes a price from. */
export const PRICE_TRADE_MIN_NAM = 50;

/** A trade the executed price takes a price from: against USDC, through one pool trusted for the price, of at least PRICE_TRADE_MIN_NAM. */
export const PRICE_TRADE_WORDS = `a NAM / USDC trade of at least ${PRICE_TRADE_MIN_NAM} NAM through one pool`;

/** What the price line's count of hours counts, after the count ("130 of the 720 hours since 11 Oct had ..."). */
export const PRICE_HOURS_HAD = `had ${PRICE_TRADE_WORDS}, the trades this line takes its price from`;

/** What the average-price panel's count of hours counts, after the count ("227 of the last 720 hours had ..."). */
export const ANY_TRADE_HOURS_HAD = 'had a buy or a sell of any size, bot round trips left out';
