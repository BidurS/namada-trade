// The public read API as it is documented: the read routes the pages themselves call, each with what it answers,
// the parameters it reads and the top-level fields of its answer. The /developers page (web/src/screens/seo/
// Developers.tsx) and /openapi.json (worker/src/openapi.ts) are both drawn from this one list, so the page, the
// machine-readable document and the code cannot say three different things.
//
// What keeps it true:
// - `fields` of an answer with a type is written `{ … } satisfies Record<keyof T, string>`: a field added to or
//   removed from the type without its line here fails the typecheck.
// - test/platform-pages.test.ts holds every entry's parameters equal to the ones the route's edge copy is keyed on
//   (worker/src/http.ts CACHE_PARAMS), and every CACHE_PARAMS route to an entry here or to NOT_DOCUMENTED.
//
// Rules for the words (the rules at the top of shared/copy.ts apply): plain words, no figure typed, describe what
// the answer holds and never what to do with it. A bound or a default is never typed into a sentence: it goes in
// the parameter's `min`, `max` or `fallback`, which the test compares with the route's own constants (a default that
// is a moment counted from another parameter, as a range's start is, has no such place and is said in words). Imports are
// from shared/ only (types, and the constants a bound is read from).
import type {
  AddressReport, AlertRuleInfo, AlertsRecentResponse, BlindSpot, BridgesResponse, FlowsResponse, GenesisCohortsResponse, HealthAnswer, HoldersResponse,
  IntegrityResponse, IntelResponse, OrderflowResponse, Overview, PairsResponse, PoolInfo, Pressure, PriceChangesResponse, PriceQuote,
  Provenance, QuoteCurveResponse, SearchResponse, SeriesResponse, TradesResponse, ValidatorHistoryResponse, ValidatorsResponse, ValuesResponse, VolumeResponse,
} from './types';
import type {
  DepthChangesResponse, DepthHeatResponse, DepthHistoryResponse, DepthOwnersApiResponse, DepthQuoteResponse, DepthResponse,
} from './depth';
import { SERIES_STEP_MS, TRADES_LIMIT_MAX } from './types';
import { CHANGES_LIMIT_MAX, HEAT_DAYS, HEAT_DEFAULT_DAYS, QUOTE_NAM_MAX, QUOTE_NAM_MIN } from './depth';
import { ALERT_WINDOW_DAYS, DEFAULT_THRESHOLDS, type AlertThresholds } from './alerts';
import { DAY_HOURS, HISTORY_ALL_DAYS } from './history';
import { FLOW_TO_TAG } from './kinds';
import { SUMMARIES_SHOWN } from './proposal-summary';
import { CURSOR_MAX_LENGTH, LIMIT_MAX, LIMIT_MIN, PAGE_SIZE } from './paging';
import { ADDRESS_PREFIX_MIN, HASH_MAX, HASH_PREFIX_MIN, INPUT_MAX } from './search-grammar';
import { VALIDATOR_DAYS_MAX, VALIDATOR_HISTORY_DAYS } from './validators';

/**
 * A proposal's short summary is part of an answer only while the summaries are shown (shared/proposal-summary.ts
 * SUMMARIES_SHOWN): the reference says so then, and says nothing of it before.
 */
const SUMMARY_CLAUSE = SUMMARIES_SHOWN
  ? { inProgress: ' and, where one is written, a short summary', listed: ', with a short summary where one is written' }
  : { inProgress: '', listed: '' };

/** The groups the reference is read in, in this order. */
export type ApiGroup = 'market' | 'depth' | 'moves' | 'holders' | 'supply' | 'series' | 'alerts' | 'site';

export const API_GROUPS: { id: ApiGroup; title: string; lead: string }[] = [
  { id: 'market', title: 'Price and pools', lead: 'What NAM costs now, what a trade of a given size returns and what the pools hold.' },
  { id: 'depth', title: 'Depth', lead: 'What rests at every price for NAM on Osmosis, from the chain’s own state of every pool.' },
  { id: 'moves', title: 'Moves', lead: 'Every recorded move of NAM on Namada and Osmosis, and the search over them.' },
  { id: 'holders', title: 'Holders and addresses', lead: 'Who holds NAM, and what one address holds and did.' },
  { id: 'supply', title: 'Supply and the shielded pool', lead: 'What could reach the market, what is being unlocked and what sits in the shielded pool.' },
  { id: 'series', title: 'Series', lead: 'The stored history behind every chart, each series with the day its record begins.' },
  { id: 'alerts', title: 'Alerts and votes', lead: 'The moves that crossed an alert size, the sizes themselves, and the votes and forum posts the site reads.' },
  { id: 'site', title: 'The site itself', lead: 'The checks the site runs on its own figures and whether its last reading completed.' },
];

/** What kind of value a parameter takes; the page shows it as a word, /openapi.json as a schema. */
export type ApiParamType =
  | 'text'      // free text
  | 'whole'     // a whole number
  | 'number'    // a number, fractions allowed
  | 'time'      // a time in unix milliseconds
  | 'day'       // a UTC day, YYYY-MM-DD
  | 'when'      // a time in unix milliseconds, or a UTC day written YYYY-MM-DD
  | 'choice'    // one of `values`
  | 'address';  // a tnam1… or osmo1… address

export interface ApiParam {
  name: string;
  type: ApiParamType;
  /** The allowed values of a choice, as the route reads them. */
  values?: readonly string[];
  /** The route refuses the request (400) without it. */
  required?: true;
  /** The smallest and largest value the route takes (a number, a whole number or a count of characters for text). */
  min?: number;
  max?: number;
  /** The value used when the parameter is left out, as the route would read it; absent when leaving it out means "no filter". */
  fallback?: string;
  /** What it does, and the value used when it is left out. One or two sentences. */
  what: string;
}

export interface ApiEndpoint {
  /** The path, with a path parameter in braces: '/api/address/{address}'. */
  path: string;
  group: ApiGroup;
  /** A short name, as a heading. */
  title: string;
  /** What the answer holds, in one or two sentences. */
  what: string;
  /** The query parameters: exactly the ones the route reads (worker/src/http.ts CACHE_PARAMS). */
  params: ApiParam[];
  /** The parameter inside the path, when there is one. */
  pathParam?: ApiParam;
  /** The top-level fields of the JSON answer, each with what it holds. Empty for an answer that is not JSON. */
  fields: Record<string, string>;
  /** The answer is a file of rows, CSV unless `format=json` asks for the same rows as JSON; `fields` is then empty. */
  csv?: true;
  /** When the route answers "not found" instead, in words; absent on a route that never does. */
  notFound?: string;
}

/** `?at=`: the same words on every route that reads it. */
const AT: ApiParam = { name: 'at', type: 'time', what: 'Answers as of that moment (Rewind). Left out, or a time that is not in the past: now.' };

/** `?limit=` on the two lists (shared/paging.ts clampLimit). */
const LIST_LIMIT: ApiParam = { name: 'limit', type: 'whole', min: LIMIT_MIN, max: LIMIT_MAX, fallback: String(PAGE_SIZE), what: 'Rows per page. A whole number outside the range is read as the nearest end of it.' };

/** `?format=` on the two exports. */
const EXPORT_FORMAT: ApiParam = { name: 'format', type: 'choice', values: ['csv', 'json'], fallback: 'csv', what: 'The file as CSV, or the same rows as JSON. Any other value is refused.' };

// ---------------------------------------------------------------- market

const overviewFields = {
  generatedAt: 'When the answer was made.',
  network: 'While the Namada network is halted: the notice the site shows, with what the Namada team said, who said it and what it means here. Null when it is not halted.',
  asOf: 'The rewound moment every figure is as of, or null for a live answer.',
  price: 'The quoted NAM price from the Osmosis router and the hourly median of executed NAM for USDC trades, each with its stamp, and the change of the quoted price over the last day in percent.',
  supply: 'All NAM in existence and where it sits: staked, in the staking account but not staked, in public funding, in the shielded pool, in the bridge account, on Osmosis and in ordinary accounts on Namada, with stamps. A live answer adds the chain’s running total of shielded rewards and the staking inflation of the newest epoch read.',
  heads: 'The newest block the site has read on Osmosis and on Namada, each with its stamp, and the Namada epoch.',
  dex: 'The Osmosis side: the number of pools that hold NAM, the money in them, holders on Osmosis, the last day’s volume, buys and sells with bot trades left out, and the net NAM that crossed the bridge, with a stamp for the pools and one for the record of moves.',
  namada: 'The Namada side: holders, how many of them hold under one NAM, and over the last day the recorded moves and the NAM staked, withdrawn from staking, moved into the shielded pool and moved out of it, with the stamp of the record of moves.',
  concentration: 'The share of NAM the ten largest holders hold on each chain, in percent, each with the stamp of the balances behind it.',
  checks: 'The site’s cross-checks, each with its status, title, detail and the time it last ran. Empty under Rewind.',
  sources: 'Each outside source the site reads, with whether its last read answered and when. Empty under Rewind.',
} satisfies Record<keyof Overview, string>;

const poolsFields = {
  pools: 'Every pool on Osmosis that holds NAM: its id, its kind, its two coins and what it holds of each, its fee, its size in dollars and its share of the total.',
  prov: 'Where the list came from and when it was read (a stamp).',
} satisfies Record<keyof { pools: PoolInfo[]; prov: Provenance }, string>;

const quoteFields = {
  quote: 'The quote: the coins in and out, the reference price it is measured against, the price per NAM the trade would get, the price move and the fee in percent, the pools on the route and a stamp. Null when no quote could be made.',
  error: 'Why there is no quote, in plain words. Absent when there is one.',
  code: 'The same reason as one fixed word (busy, unavailable, no_route or no_price), when the Osmosis router gave no quote.',
} satisfies Record<keyof { quote: PriceQuote | null; error?: string; code?: string }, string>;

const quoteCurveFields = {
  spotUsd: 'The reference price the table is measured against, in dollars per NAM; null when there is none.',
  poolsCount: 'How many pools on Osmosis hold NAM; null when the pool list was not read.',
  totalLiquidityUsd: 'The money in the pools that can be priced, in dollars; null when none is priced.',
  refPoolLiquidityUsd: 'The money in the reference pool, in dollars.',
  maxSafeClip1PctNam: 'The trade size in NAM at which the price move reaches one percent on the worse of buying and selling: an estimate between the listed sizes. Null when no size has both sides quoted, or when the smallest size already moves the price more.',
  maxSafeClip3PctNam: 'The same at three percent.',
  safeClip1Pct: 'The one percent figure with how it was made: between two listed sizes, at least the largest listed size, or below the smallest.',
  safeClip3Pct: 'The same for the three percent figure.',
  liquidityCliffNam: 'The trade size in NAM above which the price of each further NAM jumps; null when it worsens smoothly across the listed sizes.',
  cliffNote: 'That jump in words; null when there is none.',
  curve: 'The size table: for each listed amount of NAM, what selling it returns and what buying it costs in USDC, the price per NAM each way and the price move in percent.',
  prov: 'Where the table came from and when it was built (a stamp).',
} satisfies Record<keyof QuoteCurveResponse, string>;

// ---------------------------------------------------------------- depth

const depthFields = {
  at: 'The start of the minute the reading is of.',
  generatedAt: 'When the reading was written.',
  ref: 'The reference price in dollars per NAM: the pool it is read from, its block and time, and whether the reading is live or old.',
  pools: 'Every pool read: its kind, its pair, the other coin’s price and how that price was set, its fees, what it holds of each coin and its own read with time and block. A concentrated pool adds its tick and liquidity, the order book its levels.',
  unpriced: 'The pools that are listed but not summed, each with the reason.',
  answer: 'What selling and what buying each of the fixed sizes returns across every priced pool, best price first: dollars, the average and the last price, whether the size fills, and the split by pool.',
  touch: 'The effective price of the first coins each way, with the pool that gives it and the size it is read at.',
  within: 'Dollars of bids and NAM of asks resting within fixed distances of the reference price, and each side’s total.',
  offsets: 'Dollars resting within each stored distance of the reference price, one list for bids and one for asks.',
  book: 'The raw ladder: every tick range of a concentrated pool, every level of the order book and every weighted pool’s reserves, each with its price range, its coins and its fees.',
  curve: 'The merged curve: a list of prices with the dollars and NAM of bids and of asks that add up to each, for every pool together and for each pool.',
  checks: 'How the site’s own walk of the pools compares with the chain’s own swap estimate, with the Osmosis router’s direct quote and with recent executed trades.',
  prov: 'One stamp for every read behind the minute: what was read, where, when, at what block and how many bytes.',
  cost: 'How many reads the minute made, their bytes and their time.',
  note: 'A remark on the minute when there is one, for example that the newest stored minute is old.',
} satisfies Record<keyof DepthResponse, string>;

const depthQuoteFields = {
  nam: 'The size answered, in NAM: the size asked, rounded.',
  usd: 'Dollars out for a sale, dollars in for a buy.',
  avgPrice: 'The average price of the fill in dollars per NAM; null when there is none.',
  marginalPrice: 'The price of the last NAM filled.',
  complete: 'Whether the pools fill the whole size.',
  filledNam: 'The NAM that does fill.',
  split: 'The fill by pool: NAM and dollars in each. Empty when only the merged curve was walked.',
  side: 'The side asked: sell or buy.',
  ref: 'The minute’s reference price, with its pool, block and time and whether it is live or old.',
  vsRef: 'The average price against the reference price, in percent; null when there is no average.',
  at: 'The minute the quote was walked on.',
  height: 'The block of that minute’s reference reading.',
  how: 'What was walked, in words: the pool models rebuilt from the minute’s stored states, or the stored merged curve alone.',
  note: 'Present when the size does not fill whole, with how much does.',
  prov: 'The stamps of the reads behind the minute.',
} satisfies Record<keyof DepthQuoteResponse, string>;

const depthHistoryFields = {
  pool: 'The pool the rows are of, or `all` for every pool summed.',
  refPool: 'The pool the reference price of each point is read from.',
  step: 'The step of the points: one minute or one hour.',
  from: 'The start of the range answered.',
  to: 'The end of the range answered, not included.',
  asOf: 'The moment the answer is as of.',
  points: 'One point per stored step, oldest first: the reference and spot price, the dollars resting within each stored distance on each side, what the fixed sizes sold and bought return, and the best bid and ask. An hourly point adds the hour’s lowest and highest figures.',
  gaps: 'Runs of steps with no stored row, each with the reason. Nothing is filled in.',
  start: 'The first stored step of this pool at this step; null when nothing is stored.',
  recordedSince: 'When depth was first recorded for this pool at any step; null when nothing is stored.',
  cut: 'True when the range held more rows than one answer takes and the answer stops there.',
  note: 'A remark in words when there is one: how long minute rows are kept, that the answer was cut, or where the stored rows start.',
  prov: 'The stamp of the read: the table and range read, and the newest row’s time and block.',
} satisfies Record<keyof DepthHistoryResponse, string>;

const depthHeatFields = {
  days: 'The length of the window in days.',
  from: 'The start of the window.',
  to: 'The end of the window.',
  asOf: 'The moment the answer is as of.',
  bands: 'The price bands: their edges as ratios of the reference price, and the width of a band in percent.',
  columns: 'One column per stored step: its time, its reference price, its block, and the dollars resting in each band on the bid side and on the ask side, as base64 of single-precision numbers, one per band. A step with no row has no column.',
  step: 'The step the window is read at: one minute, five minutes or one hour.',
  max: 'The largest band value over every column.',
  how: 'How the columns were picked, in words.',
  prov: 'The stamp of the read: the table and range read, and the newest row’s time and block.',
} satisfies Record<keyof DepthHeatResponse, string>;

const depthOwnersFields = {
  at: 'When the hour’s reading was taken.',
  height: 'The block it was read at; null when not known.',
  owners: 'Each address with a position or an order in the pools read: its positions and orders with their price ranges, the NAM and dollars in them, its share of the total and its label where the site has one.',
  totals: 'NAM, dollars, positions and orders over every owner.',
  prov: 'The stamps of the reads behind the hour.',
  hour: 'The hour the reading belongs to.',
  positions: 'The positions’ reading: its time and block, whether it was read, the pools it covers and, when it was not read, why.',
  orders: 'The orders’ reading: its time and block, whether it was read and, when it was not, why.',
  invariants: 'Three facts the hourly reading is held to, each with whether it held and a note.',
  notes: 'What the hour left out or could not read, in words.',
  labelled: 'How many of the owners carry a label.',
} satisfies Record<keyof DepthOwnersApiResponse, string>;

const depthChangesFields = {
  pool: 'The pool asked for, or null for every pool.',
  rows: 'The changes, newest first: when, in which pool, what changed, whether it was added, removed, filled, grew or shrank, its side, its price range, its NAM and dollars, the owner when known and the block.',
  next: 'The cursor of the page after; null at the end.',
  limit: 'The rows per page answered.',
  prov: 'The stamp of the read: the table and range read, and the newest row’s time and block.',
} satisfies Record<keyof DepthChangesResponse, string>;

// ---------------------------------------------------------------- moves

/** `?kind=`: the three groups the moves list reads (worker/src/flows-query.ts KIND_GROUPS), then every kind of move (shared/kinds.ts). */
const FLOW_KIND_VALUES: readonly string[] = ['all', 'dex', 'ibc', 'native', ...Object.keys(FLOW_TO_TAG)];

/** The filters the moves list and its export read alike (worker/src/flows-query.ts). */
const FLOW_CHAIN: ApiParam = { name: 'chain', type: 'choice', values: ['all', 'namada', 'osmosis'], fallback: 'all', what: 'The chain the moves were recorded on. Any other value is refused.' };
const FLOW_KIND: ApiParam = {
  name: 'kind', type: 'choice', values: FLOW_KIND_VALUES, fallback: 'all',
  what: 'One kind of move as a move’s own `kind` names it, or a group: the three group values stand, in the order listed, for trades and pool moves, for both records of a bridge crossing, and for the Namada kinds of staking, withdrawing from staking, staking rewards, staking account transfers and moves into and out of the shielded pool. Any other value matches no move; with every kind, the shielded pool’s fee rows are left out unless an address, a record, a block or a text is asked for.',
};
const FLOW_WHALE: ApiParam = { name: 'whale', type: 'choice', values: ['true'], what: 'Only moves of the site’s whale size or more, in NAM. Any other value is refused.' };
const FLOW_MIN_NAM: ApiParam = { name: 'minNam', type: 'number', what: 'Only moves of at least this many NAM; a move in another coin never counts. A value that is not a number above zero is ignored.' };
const FLOW_ARB: ApiParam = { name: 'arb', type: 'choice', values: ['false'], what: 'Leaves out bot trades. Any other value is refused.' };
const FLOW_PAIRS: ApiParam = { name: 'pairs', type: 'choice', values: ['one'], what: 'Lists each bridge crossing once: a crossing is recorded on both chains, and the receiving chain’s record is left out when the sending chain’s is there. Any other value is refused.' };
const FLOW_SEARCH: ApiParam = { name: 'search', type: 'text', max: INPUT_MAX, what: 'Only moves whose sender, receiver or record hash contains this text; text no address or hash can hold matches nothing. Longer text is refused.' };
const FLOW_SINCE: ApiParam = { name: 'since', type: 'time', what: 'Only moves at or after this time. A value that is not a time in unix milliseconds is refused.' };
const FLOW_ADDR: ApiParam = { name: 'addr', type: 'text', min: ADDRESS_PREFIX_MIN, what: 'Only moves with this address on either side: a whole address, or the first characters of one, in lower case. Anything else is refused.' };
const FLOW_HASH: ApiParam = { name: 'hash', type: 'text', min: HASH_PREFIX_MIN, max: HASH_MAX, what: 'Only the moves of the record whose hash starts with these hexadecimal characters. Anything else is refused.' };
const FLOW_HEIGHT: ApiParam = { name: 'height', type: 'whole', min: 1, what: 'Only the moves of this block. Anything that is not a block number is refused.' };

const flowsFields = {
  total: 'How many moves match the filters, counted on the first page only. Null behind a cursor, with `count=none`, and when more match than the route counts.',
  page: 'The page number answered; behind a cursor it stays at the first.',
  limit: 'The rows per page answered.',
  flows: 'The moves, newest first: chain, block, time, record hash, kind, sender and receiver with their labels, NAM and, for a trade, the other coin, the price and the value.',
  next: 'The cursor for the older rows; null on the last page. A text search can answer fewer rows than a page and still carry it.',
  asOf: 'When the page was read; with `at`, that moment.',
  firstTs: 'The time of the oldest recorded move for the chain asked. On the first page and on a jump to a date only.',
  totalNote: 'Present when the count takes Osmosis moves from before the stored Osmosis record is complete: a sentence that says so.',
  last: 'On an empty first page: the newest move that matches every filter but the time window, or null when none is recorded. Absent when it was not looked for.',
  totalOver: 'Present when more moves match than the route counts: the bound the count stopped at, with `total` null.',
} satisfies Record<keyof FlowsResponse, string>;

const searchFields = {
  results: 'Every group’s results in the order addresses, records, names, pools, blocks, best match first inside a group: what each is, its value, a title and subtitle in plain words, the site path that shows it and, where the subtitle states a figure, its stamp.',
  asOf: 'When the answer was read.',
  groups: 'For each group, how many results are listed and whether more matched than the limit.',
} satisfies Record<keyof SearchResponse, string>;

// ---------------------------------------------------------------- holders

/** The filters the holder list and its export read alike (worker/src/api.ts). */
const HOLDER_CHAIN: ApiParam = { name: 'chain', type: 'choice', values: ['all', 'namada', 'osmosis'], fallback: 'all', what: 'The chain the holders are on. Any other value is refused.' };
const HOLDER_BY: ApiParam = { name: 'by', type: 'choice', values: ['total', 'liquid', 'bonded'], fallback: 'total', what: 'The figure the list is ordered by: total, spendable or staked NAM. Any other value is refused.' };
const HOLDER_CATEGORY: ApiParam = { name: 'category', type: 'text', max: 24, what: 'One category of label, as the list’s own `categories` names them, or `none` for holders with no label. A value that is not letters and underscores is ignored.' };
const HOLDER_SEARCH: ApiParam = { name: 'search', type: 'text', max: INPUT_MAX, what: 'Narrows the list by text: the start or end of an address, words of a name, a chain, a group of holders or a size. Longer text is cut at the largest length.' };
const HOLDER_MIN: ApiParam = { name: 'min', type: 'number', min: 0, what: 'Only holders with at least this many NAM on the figure the list is ordered by. A value that is not an amount is refused.' };
const HOLDER_MAX: ApiParam = { name: 'max', type: 'number', min: 0, what: 'Only holders with at most this many NAM on the figure the list is ordered by. A value that is not an amount is refused.' };

const holdersFields = {
  total: 'How many holders the chain, category, size and search select. Null when more match than the route counts.',
  totalOver: 'Present when more holders match a size range than the route counts: the bound the count stopped at, with `total` null.',
  pagedTo: 'Present when more holders match than the route pages through: the rank the list is served to.',
  page: 'The page these rows are; behind a cursor, the page the cursor’s rank falls on.',
  limit: 'The rows per page answered.',
  holders: 'The holders in the list’s order: rank, chain, address, spendable and staked NAM, the total and its share of all NAM, the change of the spendable balance over a day and over a week, the label and where it came from, and whether the reading is fresh, old or in disagreement.',
  next: 'The cursor for the rows after the last one here; null on the last page served.',
  asOf: 'When the list was read: every rank is as of this time.',
  countsAt: 'When `total` and `categories` were counted; null when they were counted in this request.',
  categories: 'Holders by category over the same chain, size and search, the category filter itself left out: the total, and a count per category with `none` for no label. Null when not counted.',
} satisfies Record<keyof HoldersResponse, string>;

const addressFields = {
  address: 'The address asked for.',
  chain: 'The chain it is on: namada or osmosis.',
  label: 'The label the site has for it, as written and in plain words, with its category and where it came from. Null when it has none.',
  balance: 'Its spendable NAM with a stamp: a live read from the chain for a Namada address, the last stored reading when that fails and for an Osmosis address.',
  indexedBalance: 'The spendable NAM the holder list holds for it; null when the list has no reading.',
  staking: 'For a Namada address: NAM staked, the validators it is staked with and the amount with each, the estimate from its staking history and a stamp. Null when there is none.',
  rank: 'Its place among its chain’s holders by spendable NAM; null when not ranked.',
  rankTotal: 'Its place by total NAM, spendable and staked; null when not ranked.',
  change24h: 'The change of its spendable balance over the last day, from recorded chain reads; null when not known.',
  change7d: 'The same over the last seven days.',
  firstSeen: 'When the site first listed the address with NAM; null when the record carries no such time.',
  links: 'The addresses on the other chain it has exchanged NAM with over the bridge: for each, the number of transfers, their NAM and the time of the last.',
  totalFlowsCount: 'How many recorded moves the address is part of.',
  flowsNote: 'Present when the count and the list may be short: a sentence that says why.',
  flows: 'Its newest recorded moves, in the shape of the moves list.',
  counterparties: 'The addresses it moved NAM with over those moves: NAM in, NAM out and a count for each, with labels, each bridge crossing counted once.',
} satisfies Record<keyof AddressReport, string>;

const validatorsFields = {
  asOf: 'When the answer was made.',
  day: 'The UTC day the rows are of; null when no day is on record.',
  days: 'The newest days on record, newest first.',
  validators: 'Every validator with stake on that day, largest stake first: its address, the name the Namada indexer gives it, the NAM staked with it and that stake’s share of the day’s total as a fraction, the number of addresses staked with it, its commission as a fraction, its state in the indexer’s own word, and the change of its stake since the previous day on record. Name, commission and state are null where the indexer’s list did not have them; the change is null where the previous day has no row for the validator.',
  totalNam: 'The NAM staked with every validator on that day, added up; null when the day has no row.',
  count: 'How many validators have stake on that day; null when the day has no row.',
  third: 'The smallest number of validators, largest first, whose stake together is more than one third of the total: a statement of how the staked NAM is spread. Null when the day has no row.',
  twoThirds: 'The same for more than two thirds of the total.',
  prev: 'The previous day on record, which the change of each stake is measured against; null when there is none.',
  prov: 'The stamp of the stakes: the Namada node’s listing they were read from, its time and its block. Its note says so when no listing of a newer day is on record, and why when nothing could be read.',
  namesProv: 'The stamp of names, commission and state: when the indexer’s list was read. Its note says so when that list was not read for the day.',
} satisfies Record<keyof ValidatorsResponse, string>;

const validatorHistoryFields = {
  validator: 'The validator asked for.',
  name: 'The newest name the Namada indexer gave it among the days answered; null when none of them has one.',
  days: 'Its days on record, oldest first: the day, the NAM staked with it, the number of addresses staked with it, its commission as a fraction and its state in the indexer’s own word, the last two null where the indexer’s list did not have them.',
  prov: 'The stamp of the newest day answered: the Namada node’s listing it was read from, its time and its block.',
} satisfies Record<keyof ValidatorHistoryResponse, string>;

// ---------------------------------------------------------------- supply

const pressureFields = {
  asOf: 'The moment the answer is as of.',
  windowDays: 'The length of the window in days.',
  onDeck: 'The Osmosis addresses that received the most NAM over the bridge in the window: for each, what crossed, what it has since sold or sent back, what remains, and its label and linked Namada address where known.',
  onDeckTotal: 'The NAM that remains with those addresses, in all.',
  ibcIn7d: 'NAM bridged to Osmosis over the window, whatever its length.',
  ibcOut7d: 'NAM bridged back to Namada over the window, refunded sends left out.',
  unlocks: 'Recent staking moves of a set size or more on Namada: withdrawals, new stakes and requests to unstake, each with its address, NAM and time. A request carries when its NAM becomes withdrawable, a withdrawal what was done with the NAM after.',
  unlocksWindowDays: 'The number of days that list covers.',
  unlocksMinNam: 'The smallest move that list holds, in NAM.',
  unbondingAll: 'Every request to unstake still in its wait, of any size: the NAM, the number of requests and the time they are counted from. Null when the wait is not known or the count failed.',
  unbondingDays: 'The unstaking wait in days: an estimate from the measured length of an epoch. Null when not known.',
  unbondingEpochs: 'The unstaking wait in epochs.',
  epochHours: 'The measured length of an epoch in hours.',
  unbondingProv: 'When the chain settings behind the wait were read (a stamp).',
  chainParams: 'The chain’s staking settings as read; null when they could not be read.',
  unbondTermStructure: 'The schedule of NAM leaving staking, epoch by epoch, from the chain’s own list: what is withdrawable now and what is still waiting.',
  unbondTermStructureProv: 'When that schedule was read and whether it is current (a stamp).',
  unbondWithdrawProv: 'When the withdraw times behind the staking moves were read, and from which source (a stamp).',
  pipelineSummary: 'NAM bridged to the listed addresses, split into groups by where it came from, and the NAM remaining with the addresses that sell most of what reaches them.',
  bondedTrend: 'NAM staked over time: the last reading of each period, oldest first.',
  movers: 'The Osmosis addresses with the largest net buying or selling over the window, bot trades left out: net NAM over the window and over the last day, counts of buys and sells, and the time of the last trade.',
  proposals: `The governance proposals in voting or waiting to start, with their votes in NAM${SUMMARY_CLAUSE.inProgress}.`,
  proposalsProv: 'When the proposals were read (a stamp).',
  decided: 'The latest proposals that passed or were rejected, newest first.',
  ibcRefunded7d: 'NAM in sends to Namada over the window that timed out and were refunded; left out of the NAM bridged back.',
  onDeckTotals: 'Totals over the listed receivers: NAM that crossed, sold, sent back and remaining.',
  coverage: 'How far the record of moves reaches on both chains together (a stamp).',
  coverageByChain: 'The same for each chain on its own.',
  onDeckProv: 'The stamp of the Osmosis record behind what each receiver has left.',
} satisfies Record<keyof Pressure, string>;

const blindSpotFields = {
  asOf: 'The moment the answer is as of.',
  shielded: 'NAM in the shielded pool, with its stamp.',
  total: 'All NAM in existence; null when not read.',
  sharePct: 'The shielded pool’s share of all NAM, in percent.',
  trend: 'NAM in the shielded pool over time, oldest first.',
  shields24h: 'NAM into the shielded pool over the last day, every leg counted once: shielding on Namada and bridge crossings straight into the pool.',
  unshields24h: 'NAM out of the shielded pool over the last day, counted the same way.',
  shields7d: 'NAM into the shielded pool over the last seven days.',
  unshields7d: 'NAM out of the shielded pool over the last seven days.',
  bridgeIn24h: 'The part of the last day’s NAM in that came straight over the bridge.',
  bridgeOut24h: 'The part of the last day’s NAM out that left straight over the bridge.',
  bridgeIn7d: 'The part of the seven days’ NAM in that came straight over the bridge.',
  bridgeOut7d: 'The part of the seven days’ NAM out that left straight over the bridge.',
  lastBridgeAt: 'The time of the newest bridge crossing into or out of the pool in the last seven days; null when there is none.',
  ibcShielded7d: 'The two seven-day bridge figures added up, kept for older readers.',
  unshields: 'The largest recent moves out of the pool, in the shape of the moves list: moves to an address, and crossings straight out over the bridge.',
  outGroups: 'The recipients of the window’s moves out, ranked by their total: for each, its label, the number of moves, their NAM, the first and last time, and its largest move.',
  outRead: 'How many moves out the recipients and shares were counted over.',
  outShares: 'By move id, for the listed moves out: the pool’s NAM before the move and the move’s share of it, with a stamp.',
  makeup: 'The pool as a ledger since the record’s start: NAM in by shielding and by bridge, NAM out with the fees the pool paid, the chain’s running total of shielded rewards and the pool’s balance as last read. Null while never written.',
  passthroughs7d: 'Moves out of the pool in the last seven days that match an earlier move in by amount and time, each with how many moves in could match and a confidence. A match by amount and time is not proof that one owner made both.',
  turnstileNam7d: 'The NAM that went in and came out within a day as such a matched pair, over the last seven days.',
  stickySharePct7d: 'The share of the seven days’ moves that was not such a quick round trip, in percent.',
  pulseSeries: 'NAM in, NAM out and the net per period over time, with the running net and the bridge and matched parts.',
  coverage: 'How far the record of moves reaches on both chains together (a stamp).',
  coverageByChain: 'The same for each chain on its own.',
} satisfies Record<keyof BlindSpot, string>;

const bridgesFields = {
  asOf: 'When the answer was made.',
  account: 'NAM in Namada’s bridge account, which holds the NAM sent out over every channel, with its stamp.',
  channels: 'Every bridge channel that names its other side, in the chain’s own order: Namada’s id of the channel and the other chain’s, the chain it leads to and its name, whether it is open, the name that chain gives NAM, and the NAM that chain holds through it with a stamp. A chain that is not read has no figure and the reason in its stamp’s note.',
  held: 'The NAM the chains with a current figure hold between them, with a stamp dated by the oldest of those readings; empty when no chain has one.',
  unread: 'The names of the chains with no current figure.',
  stuck: 'NAM in transfers that were refused or timed out on the other chain and never refunded, with a stamp dated by the oldest reading of a transfer’s status; empty when that list was not read.',
  beyondNam: 'The account less the NAM the chains read hold and less the NAM in such transfers. Null unless the account is current, that list was read and every chain that can be read has a current figure: it is never made with a part missing.',
  prov: 'The stamp of the channel list: the Namada node and block it was read from, and when.',
} satisfies Record<keyof BridgesResponse, string>;

// ---------------------------------------------------------------- series

const seriesFields = {
  key: 'The series answered.',
  from: 'The start of the range answered.',
  to: 'The end of the range answered, not included.',
  step: 'The step of the points.',
  stepMs: 'The same step in milliseconds.',
  agg: 'How a step’s value is made from the readings inside it: the last one, or their sum.',
  unit: 'The unit of the values: dollars per NAM, NAM, dollars, a count or percent.',
  points: 'The points, oldest first: the start of the step, its value and, where the series keeps them, the step’s lowest and highest reading and how many readings it holds. A step with no reading has no point.',
  sources: 'The source or sources of the series, each with its first and last point in the answer, the first reading it ever recorded and what that start means in words.',
  start: 'The first reading the series ever recorded; null when it has none.',
  sparse: 'True for a series written only when something happened, such as a trade: a step without a point is then not a gap.',
  coverage: 'How many steps the range holds from the start on, and how many of them have a point.',
  gaps: 'Runs of steps with no reading on a series read on a clock, each with the reason. Empty for a sparse series.',
  prov: 'The newest point’s source, time and status (a stamp).',
  asOf: 'The moment the answer is as of.',
} satisfies Record<keyof SeriesResponse, string>;

const priceChangesFields = {
  asOf: 'The moment the answer is as of.',
  quoted: 'The change of the quoted price over the last hour, six hours, day, seven days and thirty days: for each, the percent, the two readings it is measured between and a stamp. The percent is null, with the reason, when the record does not cover the window.',
  pool: 'The same for the reference pool’s own hourly price, over seven days, thirty days and a year.',
} satisfies Record<keyof PriceChangesResponse, string>;

const volumeFields = {
  asOf: 'The moment the answer is as of.',
  definition: 'What the figures count and how they are priced, in words.',
  windows: 'Executed volume over the last hour, six hours, day, seven days and thirty days: NAM bought and sold, trades, dollars at execution, buyers and sellers, and average prices. Null for a window the record does not cover.',
  prov: 'How far the Osmosis record of trades reaches (a stamp).',
  start: 'The first hour with a recorded trade.',
  osmosis: 'Dollars traded over the last day and seven days as the Osmosis app’s pair summary counts them, with its own stamp.',
  osmosisDefinition: 'What that Osmosis figure counts, in words.',
  disagree: 'True when the site’s and the Osmosis app’s dollar figures for the last day both exist and are far apart.',
} satisfies Record<keyof VolumeResponse, string>;

const pairsFields = {
  asOf: 'When the answer was made.',
  pairs: 'The pools that hold NAM, largest first: the pair, the pool’s size and reserves, its fee, and the Osmosis app’s volume and size for it with their own stamp.',
  prov: 'The stamp of the stored pool list.',
  osmosisProv: 'The stamp of the Osmosis app’s pair summary.',
  osmosisTotals: 'The Osmosis app’s volume over a day and over seven days and its size figure, added up over the pools; null where no pool has the figure.',
} satisfies Record<keyof PairsResponse, string>;

const tradesFields = {
  rows: 'The trades, newest first: time, block, buy or sell, NAM, the other coin, the price and where it came from, the value, the maker with its label and its counts of buys and sells, the pools on the route and the record hash.',
  groups: 'The same trades folded for a tape: consecutive small trades by one maker on one side close together are one group, with their count, NAM, dollars and average price.',
  next: 'The cursor for older trades; null at the end of the record.',
  asOf: 'The moment the answer is as of.',
  foldMs: 'How close together, in milliseconds, consecutive trades fold into one group.',
  foldUnderNam: 'Trades fold only when each is under this many NAM.',
  patternRule: 'The rule behind the repeated small buys mark: the fewest buys, the size each stays under and the window.',
  prov: 'How far the Osmosis record of trades reaches (a stamp).',
  firstTs: 'The time of the first recorded trade.',
} satisfies Record<keyof TradesResponse, string>;

const valuesFields = {
  asOf: 'The moment the answer is as of.',
  fdv: 'All NAM in existence at today’s quoted price, in dollars, with its label, its definition, its inputs and a stamp. The value is null when an input is not recorded.',
  spendable: 'NAM in ordinary accounts on Namada plus NAM on Osmosis at today’s price, in dollars, in the same shape.',
} satisfies Record<keyof ValuesResponse, string>;

const cohortsFields = {
  asOf: 'The moment the answer is as of.',
  day: 'The newest snapshot day at or before that moment; null when none is written.',
  listings: 'The time and blocks of the chain listings the snapshot’s holdings were read from.',
  table: 'The genesis allocation table as loaded: whether it is loaded, the genesis file’s digest and address, the day the copy was reviewed, how many allocations it holds and whether it is the pinned copy.',
  cohorts: 'One row per allocation cohort and one for all of them: its addresses, how many still hold NAM, spendable and staked NAM, NAM sent into the shielded pool, its NAM at genesis and the share of it still held.',
  prov: 'The snapshot’s stamp.',
  large: 'The largest genesis allocations, largest first: what each holds now, what it sent into the shielded pool and the addresses it sent NAM to in plain transfers. Empty under Rewind.',
  largeMinNam: 'The smallest allocation that list holds, in NAM.',
  holdingsProv: 'The stamp of the holder record behind those holdings.',
  movesProv: 'The stamp of the Namada record of moves behind what left them.',
} satisfies Record<keyof GenesisCohortsResponse, string>;

const metricHistoryFields = {
  key: 'The series answered.',
  bucketMs: 'The length of one period in milliseconds.',
  history: 'The points, oldest first: the last reading of each period with its time, the period’s lowest and highest reading and, where kept, how many readings it holds.',
  note: 'Present when the window reaches back before the stored Osmosis record is complete: a sentence that says so.',
} satisfies Record<keyof { key: string; bucketMs: number; history: unknown[]; note?: string }, string>;

const orderflowFields = {
  asOf: 'The moment the answer is as of.',
  hours: 'The length of the window in hours.',
  bucketMs: 'The length of one period in milliseconds.',
  buckets: 'One entry per period, oldest first: NAM bought, NAM sold, the difference, the running difference, the average price paid and the number of trades.',
  netCvdNam: 'NAM bought minus NAM sold over the window.',
  grossVolumeNam: 'NAM bought plus NAM sold over the window.',
  buySharePct: 'The bought share of that volume, in percent; null when there was none.',
  priceChangePct: 'The change of the average price paid from the first period with a price to the last, in percent.',
  absorptionRegime: 'One of five fixed words for how the net buying or selling and the price change compare: bid_absorption, ask_absorption, trend_up, trend_down or balanced.',
  prov: 'How far the Osmosis record of trades reaches (a stamp).',
} satisfies Record<keyof OrderflowResponse, string>;

// ---------------------------------------------------------------- alerts

/** What each alert size is the size of (shared/alerts.ts: the rules' own conditions), by parameter name. */
const ALERT_SIZE_WORDS = {
  ibcInventory: 'The smallest transfer of NAM from Namada to Osmosis the bridge rule fires on.',
  unlock: 'The smallest amount of NAM starting to unstake, or withdrawn after unstaking, the unstaking rule fires on.',
  bigSwap: 'The smallest single buy or sell of NAM on Osmosis the large trade rule fires on.',
  unshield: 'The smallest move of NAM out of the shielded pool to a personal address the rule for it fires on.',
  bond: 'The smallest amount of NAM staked in one transaction the staking rule fires on.',
  exitBridge: 'The smallest send of NAM to Osmosis, by the shielded pool itself or by an address that had at least half of it from the shielded pool in the hour before, the rule for it fires on.',
  liquidity: 'The smallest amount of NAM added to or taken out of a NAM pool on Osmosis in one transaction the liquidity rule fires on.',
} satisfies Record<keyof AlertThresholds, string>;
const ALERT_SIZE_NAMES = Object.keys(DEFAULT_THRESHOLDS) as (keyof AlertThresholds)[];
/** The sizes as the rules route reads them: any number above zero, else the site's own. */
const ALERT_SIZES: ApiParam[] = ALERT_SIZE_NAMES.map((name) => ({
  name, type: 'number', fallback: String(DEFAULT_THRESHOLDS[name]), what: ALERT_SIZE_WORDS[name] + ' A value that is not a number above zero reads as left out.',
}));
/** The same names on the recent alerts, which are read at the site's own sizes only. */
const ALERT_SIZES_REFUSED: ApiParam[] = ALERT_SIZE_NAMES.map((name) => ({
  name, type: 'number', what: 'Not read here: recent alerts are answered at the site’s own sizes, and a request that sends this is refused.',
}));

const alertRulesFields = {
  rules: 'Every alert rule: its id, its title, its condition in words at the size asked, and that size in NAM.',
  defaults: 'The site’s own size for each rule, in NAM, by parameter name.',
} satisfies Record<keyof { rules: AlertRuleInfo[]; defaults: AlertThresholds }, string>;

const alertsRecentFields = {
  since: 'Where the hits start: the start of the window, or later when the window held more moves than one read takes.',
  until: 'Where the window ends: now, or the rewound moment.',
  hits: 'The moves that crossed an alert size in the window, newest first: the rule, the time, the move, a title and detail in words, the NAM, the address and, for a trade, its price.',
  last: 'The newest hit before the window’s end, of any age. Null when the whole record holds none; absent when the search for it did not finish.',
} satisfies Record<keyof AlertsRecentResponse, string>;

const intelFields = {
  topics: 'Recent topics on the Namada forum: title, link, category, counts of posts, replies, views and likes, and times.',
  latestPosts: 'The newest forum posts: the topic, the author’s name, the time and an excerpt.',
  proposals: `Governance proposals as the Namada indexer lists them: title, kind, status, the epochs of the vote and the votes in NAM for, against and abstaining${SUMMARY_CLAUSE.listed}.`,
  validators: 'Validators: address, name, voting power in NAM, commission and state.',
  indexerEpoch: 'The epoch the Namada indexer reported; null when not read.',
  fetchedAt: 'When this copy was read.',
} satisfies Record<keyof IntelResponse, string>;

// ---------------------------------------------------------------- site

const integrityFields = {
  checks: 'The site’s cross-checks, newest first: each with its status, title, detail and the time it last ran. A check that has not run for a while is marked stale.',
  sources: 'Each outside source the site reads, with whether its last read answered, when, and a note in plain words.',
  at: 'When the answer was made.',
  lastTickAt: 'When the site’s last reading of every source completed; null when no completed reading is on record, and left out when that record could not be read.',
} satisfies Record<keyof IntegrityResponse, string>;

const healthFields = {
  ok: 'True when the site completed a reading of its sources recently and no incident is open.',
  lastTickAt: 'When the last reading completed; null when none is on record.',
  lastTickAgeMs: 'How long ago that was, in milliseconds.',
  failing: 'The names of the reads and checks that failed at the last reading.',
  incidents: 'The names of the incidents now open.',
  note: 'Present only when the record of the last reading could not be read: a sentence that says so.',
} satisfies Record<keyof HealthAnswer, string>;

export const API_CATALOG: ApiEndpoint[] = [
  // ---------------------------------------------------------------- market
  {
    path: '/api/overview', group: 'market', title: 'Overview',
    what: 'The site’s headline figures in one answer: the price, all NAM and where it sits, the pools’ totals, the last day’s trading and the holder counts on both chains, each with its stamp.',
    params: [AT],
    fields: overviewFields,
  },
  {
    path: '/api/pools', group: 'market', title: 'Pools',
    what: 'The pools on Osmosis that hold NAM, as the Osmosis router lists them, each with its reserves and its size.',
    params: [],
    fields: poolsFields,
  },
  {
    path: '/api/quote', group: 'market', title: 'Quote',
    what: 'What selling or buying a given amount of NAM returns right now, asked of the Osmosis router: the coins in and out, the price per NAM against the reference price, the fee and the route.',
    params: [
      { name: 'amount', type: 'number', max: 1e12, fallback: '1000', what: 'The amount of NAM to sell or to buy. An amount that is not above zero is refused.' },
      { name: 'side', type: 'choice', values: ['buy', 'sell'], fallback: 'sell', what: 'Whether the NAM is bought or sold. Any other value is refused.' },
    ],
    fields: quoteFields,
  },
  {
    path: '/api/quote/curve', group: 'market', title: 'Size table',
    what: 'The size table the site builds once a minute from the Osmosis router: what selling and buying each listed amount of NAM returns, and the sizes at which the price moves by one and by three percent.',
    params: [],
    fields: quoteCurveFields,
  },

  // ---------------------------------------------------------------- depth
  {
    path: '/api/depth', group: 'depth', title: 'Newest minute',
    what: 'The newest stored minute of depth: what rests at every price for NAM across every Osmosis pool that holds it, merged into one ladder and one curve, with what the fixed sizes would return.',
    params: [],
    fields: depthFields,
    notFound: 'No minute of depth has been stored yet.',
  },
  {
    path: '/api/depth/quote', group: 'depth', title: 'Quote on the stored minute',
    what: 'What selling or buying a given size of NAM returns on the newest stored minute, walked across every priced pool with no outside request: dollars, the average price, the split by pool and how far the average sits from the reference price.',
    params: [
      { name: 'side', type: 'choice', values: ['sell', 'buy'], required: true, what: 'Whether the NAM is sold or bought.' },
      { name: 'nam', type: 'number', required: true, min: QUOTE_NAM_MIN, max: QUOTE_NAM_MAX, what: 'The size in NAM. The answer is for the size rounded, as its `nam` field states.' },
    ],
    fields: depthQuoteFields,
    notFound: 'No minute of depth has been stored yet.',
  },
  {
    path: '/api/depth/history', group: 'depth', title: 'History',
    what: 'The stored depth figures over a range, at steps of one minute or one hour, for one pool or for every pool summed, with the gaps listed.',
    params: [
      { name: 'pool', type: 'text', max: 12, fallback: 'all', what: 'A pool’s number, or `all` for every pool summed. Anything else is refused.' },
      { name: 'from', type: 'when', what: 'The start of the range. Left out: one day before `to`; a start that is not before `to` is refused.' },
      { name: 'to', type: 'when', what: 'The end of the range, not included; a day means its end. Left out, or later than the moment the answer is as of: that moment.' },
      { name: 'step', type: 'choice', values: ['1m', '1h'], fallback: '1m', what: 'The step of the points: one minute or one hour. Any other value is refused.' },
      AT,
    ],
    fields: depthHistoryFields,
  },
  {
    path: '/api/depth/heat', group: 'depth', title: 'Heat bands',
    what: 'For every pool summed, the dollars resting in each price band around the reference price at each stored step of a window.',
    params: [
      { name: 'days', type: 'choice', values: Object.keys(HEAT_DAYS), fallback: String(HEAT_DEFAULT_DAYS), what: 'The length of the window in days; each length is read at its own step. Any other value is refused.' },
      AT,
    ],
    fields: depthHeatFields,
  },
  {
    path: '/api/depth/owners', group: 'depth', title: 'Position and order owners',
    what: 'The newest hourly reading of the positions and resting orders behind the depth, grouped by the address that holds them, with their sizes and shares.',
    params: [],
    fields: depthOwnersFields,
    notFound: 'No hourly reading of the owners has been stored yet.',
  },
  {
    path: '/api/depth/changes', group: 'depth', title: 'Changes',
    what: 'Liquidity that appeared, left or filled, as the difference between two readings of the pools, newest first.',
    params: [
      { name: 'pool', type: 'text', max: 12, what: 'A pool’s number, for that pool’s changes only. Left out: every pool; anything else is refused.' },
      { name: 'before', type: 'text', max: 200, what: 'The `next` of the page before, for the rows after it. Anything that is not such a cursor is refused.' },
      { name: 'limit', type: 'whole', min: 1, max: CHANGES_LIMIT_MAX, fallback: String(CHANGES_LIMIT_MAX), what: 'Rows per page. A value outside the range is refused.' },
    ],
    fields: depthChangesFields,
  },

  // ---------------------------------------------------------------- moves
  {
    path: '/api/flows', group: 'moves', title: 'Moves',
    what: 'Recorded moves of NAM on Namada and Osmosis, newest first, filtered by chain, kind, size, address, record or block and paged by cursor.',
    params: [
      FLOW_CHAIN, FLOW_KIND, FLOW_WHALE, FLOW_MIN_NAM, FLOW_ARB, FLOW_PAIRS, FLOW_SEARCH, AT,
      { name: 'page', type: 'whole', min: 1, max: 100_000, fallback: '1', what: 'A page by number, for older links; `before` wins when both are sent. A number above the largest is refused, and so is a page past the first of a text search without `before`.' },
      LIST_LIMIT,
      { name: 'before', type: 'text', max: CURSOR_MAX_LENGTH, what: 'The `next` of the page before, for the rows after it; or a time in unix milliseconds, for the moves older than it. Anything else reads as the first page.' },
      FLOW_SINCE, FLOW_ADDR, FLOW_HASH, FLOW_HEIGHT,
      { name: 'count', type: 'choice', values: ['none'], what: 'Rows only: no count is taken and `total` is null. Any other value is refused.' },
    ],
    fields: flowsFields,
  },
  {
    path: '/api/search', group: 'moves', title: 'Search',
    what: 'Addresses, records, names, pools and blocks that match a text, grouped and ranked, from current data.',
    params: [
      { name: 'q', type: 'text', max: INPUT_MAX, what: 'The text to look for: the start or end of an address, the start of a record’s hash, a block height, a pool number or words of a name. Longer text is cut at the largest length; left out, the answer is empty.' },
      { name: 'limit', type: 'whole', min: 1, max: 10, fallback: '6', what: 'Results per group. A larger number is read as the largest; anything else that is not a whole number in the range reads as left out.' },
    ],
    fields: searchFields,
  },
  {
    path: '/api/export/flows', group: 'moves', title: 'Moves as a file',
    what: 'The moves a set of filters selects, newest first, as a CSV file with the columns time_utc, chain, kind, nam, value_usd, price_usd, from, from_label, from_label_source, from_label_author, to, to_label, to_label_source, to_label_author, tx_hash, time_source, price_source, settle_usd_per_nam, settle_usd and price_basis. The X-Total-Count header says how many moves match, when they were counted, and X-Truncated whether the file holds fewer.',
    params: [
      FLOW_CHAIN, FLOW_KIND, FLOW_WHALE, FLOW_MIN_NAM, FLOW_ARB, FLOW_PAIRS, FLOW_SEARCH, AT,
      { name: 'limit', type: 'whole', min: 100, max: 5000, fallback: '5000', what: 'The most rows in the file. A number outside the range is read as the nearest end of it; zero, and a value that is not a number, read as left out.' },
      EXPORT_FORMAT, FLOW_SINCE, FLOW_ADDR, FLOW_HASH, FLOW_HEIGHT,
    ],
    fields: {},
    csv: true,
  },

  // ---------------------------------------------------------------- holders
  {
    path: '/api/holders', group: 'holders', title: 'Holders',
    what: 'Addresses that hold spendable or staked NAM on Namada, or NAM on Osmosis, largest first, with protocol accounts and pools left out. Balances are current: this route does not rewind.',
    params: [
      HOLDER_CHAIN, HOLDER_BY, HOLDER_CATEGORY, HOLDER_SEARCH,
      { name: 'page', type: 'whole', min: 1, max: 100_000, fallback: '1', what: 'A page by number; `after` wins when both are sent. A number above the largest is refused.' },
      LIST_LIMIT,
      { name: 'after', type: 'text', max: CURSOR_MAX_LENGTH, what: 'The `next` of the page before, for the rows after it; anything that is not such a cursor is ignored. A cursor further down the list than the route pages through is refused.' },
      HOLDER_MIN, HOLDER_MAX,
    ],
    fields: holdersFields,
  },
  {
    path: '/api/address/{address}', group: 'holders', title: 'Address',
    what: 'One address: what it holds and has staked, its place among holders, its label, its newest moves and the addresses it moved NAM with.',
    params: [],
    pathParam: { name: 'address', type: 'address', required: true, what: 'A whole Namada or Osmosis address. Anything else is refused.' },
    fields: addressFields,
  },
  {
    path: '/api/export/holders', group: 'holders', title: 'Holders as a file',
    what: 'The holder list a set of filters selects, in the list’s order, as a CSV file with the columns rank, chain, address, spendable_nam, staked_nam, staked_is_estimate, total_nam, pct_total_supply, label, category, label_source, spendable_checked_at and stake_checked_at. The X-Total-Count header says how many holders match, when they were counted, and X-Truncated whether the file holds fewer.',
    params: [
      HOLDER_CHAIN, HOLDER_BY, HOLDER_CATEGORY, HOLDER_SEARCH,
      { name: 'limit', type: 'whole', min: 100, max: 10_000, fallback: '10000', what: 'The most rows in the file. A number outside the range is read as the nearest end of it; zero, and a value that is not a number, read as left out.' },
      EXPORT_FORMAT, HOLDER_MIN, HOLDER_MAX,
    ],
    fields: {},
    csv: true,
  },
  {
    path: '/api/validators', group: 'holders', title: 'Validators',
    what: 'Every validator with NAM staked with it on one UTC day, largest stake first, with how that stake is spread across them. The stakes are the first complete listing of each day, read from a Namada node; names, commission and state are the Namada indexer’s.',
    params: [
      { name: 'day', type: 'day', what: 'The day to answer for. Left out: the newest day on record. A value that is not a day, and a day with no listing on record, is refused.' },
    ],
    fields: validatorsFields,
  },
  {
    path: '/api/validators/history', group: 'holders', title: 'One validator over time',
    what: 'One validator’s stake, the number of addresses staked with it, its commission and its state on each of its newest days on record, oldest first.',
    params: [
      { name: 'validator', type: 'address', required: true, what: 'The validator’s whole Namada address. Anything else is refused.' },
      { name: 'days', type: 'whole', min: 1, max: VALIDATOR_DAYS_MAX, fallback: String(VALIDATOR_HISTORY_DAYS), what: 'How many of its newest days to answer with. Anything but a plain whole number in the range is refused.' },
    ],
    fields: validatorHistoryFields,
    notFound: 'A validator with no row on record.',
  },

  // ---------------------------------------------------------------- supply
  {
    path: '/api/pressure', group: 'supply', title: 'Supply on its way',
    what: 'NAM that could reach the market: what crossed the bridge to Osmosis in the window and what its receivers still hold, the staking moves and the schedule of NAM leaving staking, the largest net buyers and sellers, and the open governance proposals.',
    params: [
      AT,
      { name: 'days', type: 'whole', min: 1, max: 365, fallback: '7', what: 'The length of the window in days. A number outside the range is read as the nearest end of it, and a value that is not a number as left out.' },
    ],
    fields: pressureFields,
  },
  {
    path: '/api/blindspot', group: 'supply', title: 'Shielded pool',
    what: 'The shielded pool seen from outside: how much NAM it holds and its share of all NAM, what went in and came out over the last day and week, the largest moves out, and the pool as a ledger since the record began.',
    params: [AT],
    fields: blindSpotFields,
  },
  {
    path: '/api/bridges', group: 'supply', title: 'Bridges',
    what: 'Every bridge channel Namada has opened, the chain each leads to and the NAM that chain holds through it, set against the NAM in Namada’s bridge account. Current only: this route does not rewind.',
    params: [],
    fields: bridgesFields,
  },

  // ---------------------------------------------------------------- series
  {
    path: '/api/series', group: 'series', title: 'One series',
    what: 'One stored series over a range at a chosen step, with its sources, the day its record begins and its gaps.',
    params: [
      { name: 'key', type: 'text', required: true, what: 'The name of the stored series, for example `price.usd`. The series cover prices, hourly and daily trading, pool totals and single pools, staked and shielded NAM, staking inflation, counts of shielded transactions, holder counts and the genesis cohorts; an unknown name is answered as not found, with the names served.' },
      { name: 'from', type: 'when', what: 'The start of the range. Left out: thirty days before `to`; a start that is not before `to` is refused.' },
      { name: 'to', type: 'when', what: 'The end of the range, not included; a day means its end. Left out, or later than the moment the answer is as of: that moment.' },
      { name: 'step', type: 'choice', values: Object.keys(SERIES_STEP_MS), what: 'The length of a step. A step finer than the series is written at is raised to the series’ own, and one that would hold more points than one answer takes is refused; left out, the finest step that fits one answer.' },
      AT,
    ],
    fields: seriesFields,
    notFound: 'A name that is not a series this route serves.',
  },
  {
    path: '/api/series/changes', group: 'series', title: 'Price changes',
    what: 'How far the NAM price moved over fixed windows, from the quoted price and from the pool price, each change with the two readings it is measured between.',
    params: [AT],
    fields: priceChangesFields,
  },
  {
    path: '/api/series/volume', group: 'series', title: 'Volume',
    what: 'Executed NAM volume on Osmosis over fixed windows, with its definition, and the Osmosis app’s own figure beside it.',
    params: [AT],
    fields: volumeFields,
  },
  {
    path: '/api/series/pairs', group: 'series', title: 'Pairs',
    what: 'The pools on Osmosis that hold NAM, each with its size from its reserves and the Osmosis app’s volume for it. Current only: this route does not rewind.',
    params: [],
    fields: pairsFields,
  },
  {
    path: '/api/series/trades', group: 'series', title: 'Trades',
    what: 'Executed NAM trades on Osmosis, newest first, bot trades left out, each with its price, maker and route, and the same trades folded into groups.',
    params: [
      { name: 'before', type: 'text', max: CURSOR_MAX_LENGTH, what: 'The `next` of the page before, for the older trades; or a time in unix milliseconds, for the trades older than it. Anything else reads as the first page.' },
      { name: 'maker', type: 'address', what: 'Only one maker’s trades. Anything that is not a whole address is refused.' },
      { name: 'min', type: 'number', min: 0, what: 'Only trades of at least this many NAM. A value that is not an amount is refused.' },
      { name: 'limit', type: 'whole', min: LIMIT_MIN, max: TRADES_LIMIT_MAX, fallback: String(PAGE_SIZE), what: 'Rows per page. A whole number outside the range is read as the nearest end of it.' },
      AT,
    ],
    fields: tradesFields,
  },
  {
    path: '/api/series/values', group: 'series', title: 'Derived values',
    what: 'Two derived dollar figures, each with its definition and its inputs: all NAM at today’s price, and spendable NAM at today’s price.',
    params: [AT],
    fields: valuesFields,
  },
  {
    path: '/api/series/cohorts', group: 'series', title: 'Genesis cohorts',
    what: 'The genesis allocation cohorts on the newest daily snapshot: what each still holds of its NAM at genesis, and the largest allocations with what each holds now and what left it.',
    params: [AT],
    fields: cohortsFields,
  },
  {
    path: '/api/metrics/history', group: 'series', title: 'Charted history',
    what: 'The history of the series the site’s charts read from this route, the quoted price, the executed price and NAM staked, as the last reading of each period over a window of hours.',
    params: [
      { name: 'key', type: 'choice', values: ['price.swap_1h', 'price.usd', 'supply.total_stake'], fallback: 'price.usd', what: 'The series: the executed price by the hour, the quoted price, or NAM staked. Any other name is answered as not found.' },
      { name: 'hours', type: 'whole', min: 1, max: HISTORY_ALL_DAYS * DAY_HOURS, fallback: '24', what: 'The length of the window in hours; the length of a period follows from it. Anything but a plain whole number in the range is refused.' },
      AT,
    ],
    fields: metricHistoryFields,
    notFound: 'A name that is not a series this route serves.',
  },
  {
    path: '/api/orderflow', group: 'series', title: 'Bought and sold',
    what: 'NAM bought and NAM sold on Osmosis per period over a window, bot trades left out, with the running difference and the average price paid in each period.',
    params: [
      AT,
      { name: 'hours', type: 'whole', min: 1, max: 36_000, fallback: '720', what: 'The length of the window in hours; the length of a period follows from it. A number above the largest is read as the largest.' },
    ],
    fields: orderflowFields,
  },

  // ---------------------------------------------------------------- alerts
  {
    path: '/api/alerts/rules', group: 'alerts', title: 'Alert rules',
    what: 'The alert rules and the size in NAM at which each fires, at the site’s own sizes or at sizes sent with the request.',
    params: ALERT_SIZES,
    fields: alertRulesFields,
  },
  {
    path: '/api/alerts/recent', group: 'alerts', title: 'Recent alerts',
    what: 'The moves that crossed one of the site’s alert sizes in a recent window, newest first, and the newest such move of any age.',
    params: [
      AT,
      { name: 'since', type: 'time', what: 'An own start for the window, read no further back than the widest window `days` offers; anything that is not a time reads as left out. Sent together with `days`, the request is refused.' },
      { name: 'days', type: 'choice', values: ALERT_WINDOW_DAYS.filter((d) => d > 1).map(String), what: 'The length of the window in days. Left out: the last day; any other value is refused.' },
      ...ALERT_SIZES_REFUSED,
    ],
    fields: alertsRecentFields,
  },
  {
    path: '/api/intel', group: 'alerts', title: 'Votes and forum',
    what: 'The governance proposals, validators and forum posts the site reads, as its last stored copy with the time it was read.',
    params: [],
    fields: intelFields,
  },

  // ---------------------------------------------------------------- site
  {
    path: '/api/integrity', group: 'site', title: 'Cross-checks',
    what: 'The checks the site runs on its own figures against other sources, each with its result, the state of every source it reads and when its last reading of every source completed.',
    params: [],
    fields: integrityFields,
  },
  {
    path: '/api/health', group: 'site', title: 'Health',
    what: 'Whether the site’s last reading of its sources completed recently and no incident is open, with the names of what is failing. The same answer is sent with an error status when it is not.',
    params: [],
    fields: healthFields,
  },
];

/**
 * Routes with an edge copy (CACHE_PARAMS) that are not part of the documented API, each with the reason. The test
 * requires every CACHE_PARAMS route to be in API_CATALOG or here.
 */
export const NOT_DOCUMENTED: Record<string, string> = {
  '/api/ask': 'The state of the Ask chat, which is not open to readers yet.',
  '/api/donation': 'The donation addresses the footer shows.',
};

export const endpointByPath = (path: string): ApiEndpoint | undefined => API_CATALOG.find((e) => e.path === path);
