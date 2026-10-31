// API contract shared by the Worker and the web UI.
import type { Settle } from './settle';

export type Chain = 'osmosis' | 'namada';

export type FlowKind =
  | 'buy' | 'sell' | 'transfer' | 'ibc_in' | 'ibc_out'
  | 'bond' | 'unbond' | 'withdraw' | 'rewards' | 'shield' | 'unshield'
  | 'lp_add' | 'lp_remove' | 'pgf' | 'other'
  /** A transparent transfer of the staking account's own balance (descriptor `transfer-from-wasm`, either side the
   *  staking account): not a holder staking or unstaking, and the chain's total stake does not move with it
   *  (docs/design/screener-plan.md 3.0). */
  | 'pos_balance';

export interface Flow {
  id: string;
  chain: Chain;
  height: number;
  ts: number;
  txHash: string;
  /** The hash to open this move on a public explorer (shared/flow-rules.ts explorerHashOf); absent on live stream rows, where it equals txHash */
  explorerHash?: string;
  kind: FlowKind;
  from: string | null;
  to: string | null;
  amount: number;              // NAM
  counterDenom?: string | null; // e.g. 'USDC' for swaps
  counterAmount?: number | null;
  poolId?: string | null;
  priceUsd?: number | null;
  valueUsd?: number | null;
  /** May carry `tsSource` ('block' | 'extrapolated' | 'interpolated'), `priceSource`
   *  ('execution' | 'swap_1h' | 'spot' | 'pool_1h' | 'unknown'; 'pool_1h' with `priceAt`, the hour of the stored
   *  price.pool_1h close it is, and `repaired`, the day of the repair that set it; 'spot' with `priceRoute`, the NAM size of
   *  the route whose spot the quote was when the price list gave NAM none, worker/src/price-how.ts stampPriceRoute), `via`
   *  ('catch-up search' | 'late scan': the move was found late), `arb`, `trader`, `source`, and `textCut`: the whole length of
   *  each sender's text the row keeps only the start of (`memo`, `from`, `to`; worker/src/util.ts boundFlowText). */
  meta?: Record<string, unknown> | null;
  fromLabel?: string | null;
  toLabel?: string | null;
  /** The labels as the site shows them (worker/src/labels.ts): no expert words, genesis names in plain words */
  fromLabelPlain?: string | null;
  toLabelPlain?: string | null;
  /**
   * Where each label came from: 'genesis', 'auto' (pools, protocol accounts), 'valopers', or 'user' (a tag a
   * signed-in wallet wrote; show it as that wallet's tag, never like curated data). null when there is no label.
   */
  fromLabelSource?: string | null;
  toLabelSource?: string | null;
  /** for a user tag: the start of the address of the wallet that wrote it ("tnam1qxyz…"); null otherwise */
  fromLabelAuthor?: string | null;
  toLabelAuthor?: string | null;
  whale?: boolean;
  /** A trade's settle price (shared/settle.ts), priced at its minute by the Worker; absent when it has none (and on live rows, priced by the page from their own coins) */
  settle?: Settle;
}

/**
 * GET /api/flows: newest first (`ORDER BY ts DESC, height DESC, id DESC`). Parameters: FlowsRequest. The fields after
 * `flows` are the cursor build's (docs/design/nav-search-plan.md 2.2); a server before it sends none of them, and a
 * client then pages by `?page=` (web/src/api.ts fetchFlowsPage does).
 */
export interface FlowsResponse {
  /**
   * Moves that match the filters, counted on the head page only. null behind a cursor (`?before=` a cursor): the
   * head page said it, and with `count=none`; a client never reads an absent count as 0. A text search (`search=`)
   * is never counted by a second walk: null unless its head page holds every match.
   */
  total: number | null;
  /** 1 behind a cursor (the client counts its own position) */
  page: number;
  limit: number;
  flows: Flow[];
  /**
   * the cursor for the older rows (send it back as `?before=`); null on the last page. Absent on older servers. A text
   * search reads at most SEARCH_SCAN moves a request (worker/src/flows-query.ts): its page can hold fewer rows than
   * `limit`, or none, and still carry `next`; read on from it.
   */
  next?: string | null;
  /** when the page was read; with `?at=` the rewound time */
  asOf?: number;
  /** the oldest move in the index for this chain filter ("The flow index starts on 3 Dec 2024"); on the head page and on a date jump (`?before=<unix ms>`), else absent */
  firstTs?: number | null;
  /**
   * On a head page whose chain filter takes Osmosis moves and whose window reaches back before the stored Osmosis
   * record is complete (shared/osmosis-gap.ts): the sentence that says the count is of an incomplete record. Absent
   * otherwise.
   */
  totalNote?: string;
  /**
   * On an empty head page: the newest move that matches every filter but the time window (`since`, `before`), of any
   * age, for "The last one was 2.3 days ago. Rewind to it." null when none is recorded; absent when not searched.
   */
  last?: { id: string; ts: number; chain: Chain } | null;
  /**
   * On a head page whose address start (`addr`, not a whole address) matches more than this many moves
   * (worker/src/flows-query.ts FEW_ROWS), or whose filters the stored counts do not answer and that match more than
   * COUNT_MAX (10,000): `total` is null and the moves are not counted further. Absent otherwise.
   */
  totalOver?: number;
}

/**
 * The query parameters of GET /api/flows and GET /api/export/flows, as the URL carries them (every one an optional
 * string). Each must be in worker/src/http.ts CACHE_PARAMS['/api/flows'] (test/routes.test.ts checks it).
 */
export interface FlowsRequest {
  chain?: 'namada' | 'osmosis';
  /** a FlowKind, or the groups 'dex' (buys, sells, pool moves), 'ibc' (bridge records), 'native' */
  kind?: string;
  whale?: 'true';
  /** at least this many NAM (NAM flows only) */
  minNam?: string;
  /** 'false': bot round trips left out */
  arb?: 'false';
  /** 'one': each bridge crossing once */
  pairs?: 'one';
  /** address or record contains the text (`LIKE '%…%'`, the slow path; rate-limited) */
  search?: string;
  /** unix ms: nothing newer (Rewind) */
  at?: string;
  /** offset page (kept one release for old links; `before` wins when both are sent) */
  page?: string;
  /** 10 to 100 (shared/paging.ts clampLimit) */
  limit?: string;
  /** a moves cursor (FlowsResponse.next) or a plain unix-ms time (a date jump): shared/paging.ts parseBeforeParam */
  before?: string;
  /** unix ms: moves at or after it ("last 7 days", "since 1 Oct") */
  since?: string;
  /** an address start of ADDRESS_PREFIX_MIN (shared/search-grammar.ts) characters or more, or a whole address: either side */
  addr?: string;
  /** HASH_PREFIX_MIN or more hex characters of a record (upper-cased by the route) */
  hash?: string;
  /** a block height */
  height?: string;
  /** 'none': rows only, no count (FlowsResponse.total comes back null): Home's latest moves and the live feed's first rows */
  count?: 'none';
}

/** A raw balance change (ledger entry) */
export interface Move {
  chain: Chain;
  address: string;
  height: number;
  ts: number;
  txHash: string;
  idx: number;
  delta: number; // NAM
}

export interface Label {
  address: string;
  chain: Chain;
  /** as the source wrote it, e.g. "Genesis: af_backers" */
  label: string;
  category: string;
  source: string;
  note?: string | null;
  /** what the site shows, e.g. "Early backers (genesis)" (owner decision 6) */
  label_plain?: string | null;
  category_plain?: string | null;
  /** as `source`; for a user tag, `label_author` is the start of the tagging wallet's address ("tnam1qxyz…") */
  label_source?: string | null;
  label_author?: string | null;
}

export interface Holder {
  rank: number;
  chain: Chain;
  address: string;
  /** liquid (transparent) balance */
  balance: number;
  /** bonded stake (Namada only): chain-verified when `bondedVerifiedAt` is set, else the history estimate, null if unknown */
  bonded: number | null;
  bondedEstimated: number | null;
  bondedVerifiedAt: number | null;
  total: number;
  pctSupply: number | null;
  /**
   * Change of the spendable balance over the last 24 h / 7 days (NAM), from recorded chain reads
   * (worker/src/holders.ts). null when the balance at the start of the window is not known (no reading
   * then, or it changed around then): never 0 as a placeholder.
   */
  change24h: number | null;
  change7d: number | null;
  /** raw label and category, as the source wrote them */
  label?: string | null;
  category?: string | null;
  /** what the site shows (owner decision 6): "Early backers (genesis)", "Foundation" */
  label_plain?: string | null;
  category_plain?: string | null;
  /** where the label came from ('genesis', 'auto', 'valopers', 'user'); a 'user' tag is a wallet's own tag, not curated */
  label_source?: string | null;
  /** for a user tag: the start of the address of the wallet that wrote it (e.g. "tnam1qxyz…"); null otherwise */
  label_author?: string | null;
  linked?: string[];
  /** last write of the spendable balance (a chain read or a transfer's post-balance) */
  updatedAt: number | null;
  /** last time the spendable balance was read from the chain itself; null if never */
  verifiedAt: number | null;
  /**
   * Owner decision 7: `stale` when the spendable balance was last read from the chain more than 6 h ago
   * (or never); `conflict` only when the stake has no chain read newer than 24 h and the estimate and the
   * last known figure differ by more than 1 NAM; otherwise `live`. The UI words are fresh, old, sources disagree.
   */
  status: SourceStatus;
  /** Why the row is old or disagrees, in plain words; null when there is nothing to say */
  statusNote: string | null;
}

/**
 * GET /api/holders. Not available under rewind: balances are current, not as of `at`. Parameters: HoldersRequest.
 * The fields after `holders` are the stored-totals build's (docs/design/nav-search-plan.md 2.1); a server before it
 * sends none of them.
 */
export interface HoldersResponse {
  /**
   * Holders the chain, category, size and search select. Without a search or a size it comes from the counts the
   * cron keeps (kv holders.counts, HolderCountsKv; stamped by `countsAt`); with one it is counted in the request, up
   * to `totalOver`: null when more match than that (never 0, never the bound read as the count).
   */
  total: number | null;
  /**
   * When more holders match a size range than the request counts (worker/src/holders.ts WALK_COUNT_MAX, 10,000):
   * `total` is null and this is the bound ("more than 10,000"). Absent otherwise.
   */
  totalOver?: number;
  /**
   * When more holders match than this site's server pages (worker/src/api.ts HOLDER_PAGE_REACH, 10,000): the list is
   * served to that rank and no further ("showing the first 10,000"). A page past it has no rows and the page that ends
   * there no `next`; the holders after it are reached by a size range or a search. Absent otherwise.
   */
  pagedTo?: number;
  /** the page these rows are (with `after`, the page the cursor's rank falls on) */
  page: number;
  limit: number;
  /** rank = (page − 1) × limit + i + 1, or, after a cursor, the cursor's rank + i + 1 */
  holders: Holder[];
  /** the cursor for the rows after the last one here (send it back as `?after=`); null on the last page served */
  next?: string | null;
  /** when the list was read: the order (and so every rank) is as of this time */
  asOf?: number;
  /** when `total` and `categories` were counted; null when counted in this request (a search) */
  countsAt?: number | null;
  /**
   * Holders by category over the same chain, size and search, the category filter itself left out (so every
   * "What" chip has its count): `total` all of them, `counts` per raw category in lower case, 'none' for no label.
   */
  categories?: { total: number; counts: { category: string; n: number }[] } | null;
}

/** The sort of the holder list: total (spendable + staked), spendable ('liquid') or staked ('bonded'). */
export type HoldersBy = 'total' | 'liquid' | 'bonded';

/**
 * The query parameters of GET /api/holders and GET /api/export/holders, as the URL carries them. Each must be in
 * worker/src/http.ts CACHE_PARAMS['/api/holders'].
 */
export interface HoldersRequest {
  /** default 'all' on the API (the UI sends 'namada' by default) */
  chain?: 'all' | 'namada' | 'osmosis';
  by?: HoldersBy;
  /** a raw category in lower case, or 'none' (no label) */
  category?: string;
  /** read with shared/search-grammar.ts parse(…, { list: 'holders' }): an address start or end, names, sizes, groups */
  search?: string;
  /** NAM on the sort's figure (total by default): at least / at most */
  min?: string;
  max?: string;
  /** offset page, from 1 */
  page?: string;
  /** a holders cursor (HoldersResponse.next); wins over `page` */
  after?: string;
  /** 10 to 100 */
  limit?: string;
}

/**
 * kv 'holders.counts', written by the cron after a listing pass that wrote rows and otherwise every 10 minutes
 * (nav-search-plan.md 2.1): holder counts by chain and category over the stored totals (total_num > 0, protocol
 * and pool accounts left out). Read by /api/holders (no search), /api/overview and the server-rendered pages.
 */
export interface HolderCountsKv {
  /** when the counts were taken (unix ms) */
  at: number;
  byChain: Record<'namada' | 'osmosis' | 'all', {
    all: number;
    /** per raw category in lower case (labelled holders only) */
    byCategory: Record<string, number>;
    /** holders with no label */
    none: number;
    /** holders with under 1 NAM in all (fee dust and test amounts count as holders) */
    under1Nam: number;
  }>;
}

// ---------------------------------------------------------------- provenance

/** How much to trust a number: where it came from, when, and whether it is current. */
export type SourceStatus = 'live' | 'stale' | 'missing' | 'conflict';

export interface Provenance {
  source: string;
  /** unix ms when the value was obtained from the source; null when missing */
  at: number | null;
  height?: number | null;
  status: SourceStatus;
  /** Why it is stale/missing/conflicting, in plain words */
  note?: string;
}

export interface Sourced<T> {
  value: T | null;
  prov: Provenance;
}

export interface SourceHealth {
  name: string;
  ok: boolean;
  at: number;
  latencyMs?: number;
  note?: string;
  /**
   * On a row that stays not ok for a while after one failure (a day for the live decoders' and the scan's, a post not
   * sent, a save refused): when that failure was. The operator's incidents (worker/src/ops.ts readMark) count a new
   * failure as a new failed read, never the same one read again, a success since, or new words on the row.
   */
  failedAt?: number;
}

export interface Check {
  key: string;
  /** 'stale': the check has not run for CHECK_STALE_MS (its source stopped answering); its last result is in detail
   *  but it is not counted as passing. 'idle': the check ran but had nothing to compare (the price check when no
   *  trade it trusts happened in its window); neither a pass nor a fault. */
  status: 'ok' | 'warn' | 'fail' | 'stale' | 'idle';
  title: string;
  detail: Record<string, unknown>;
  checkedAt: number;
}

// ---------------------------------------------------------------- overview

export interface PoolInfo {
  id: string;
  type: 'balancer' | 'stableswap' | 'concentrated' | 'cosmwasm' | string;
  address: string;
  pair: string;              // e.g. NAM/USDC
  counterDenom: string;
  counterSymbol: string;
  /** whole NAM in the pool */
  namReserve: number;
  /** whole coins of the other side; null when the coin's decimals are not known (an empty side is 0 in any unit) */
  counterReserve: number | null;
  /**
   * The other side in base units, only while its decimals are not known (sources/sqs.ts fetchNamPools): the cron sizes
   * it with the decimals the depth module read (pool-sizes.ts sizePools) and never stores or serves it.
   */
  counterBase?: string;
  /**
   * The pool's size in US dollars: its NAM at the site's NAM price plus its other coin at that coin's price
   * (worker/src/pool-sizes.ts), never the router's liquidity_cap. null when a side that holds coins cannot be priced:
   * `sizeProv` then says why ("not priced"), never 0.
   */
  liquidityUsd: number | null;
  /** the two sides of `liquidityUsd` in US dollars; null when that side cannot be priced (absent on the router's own list) */
  namUsd?: number | null;
  counterUsd?: number | null;
  /** where the size came from: the depth minute or the pool list, its time, height and price, or why it is not priced */
  sizeProv?: Provenance;
  /**
   * The Osmosis router's own liquidity_cap for the pool, kept for comparison only: it counts NAM at nothing while the
   * router gives NAM no price (23 Oct to 29 Oct 2026), and it moves only in a block where the pool changes.
   */
  routerLiquidityUsd?: number | null;
  spreadFactor: number;
  volume24hUsd?: number | null;
}

export interface Overview {
  generatedAt: number;
  /** When set, every number is computed as of this time (replay). */
  asOf: number | null;
  price: {
    /** Osmosis SQS mid price */
    usd: Sourced<number>;
    /** Last executed single-pool NAM/USDC swap price (hourly median) */
    swap1h: Sourced<number>;
    change24h: number | null;
  };
  supply: {
    total: number | null;
    /**
     * NAM staked with validators: the chain's own total stake (ABCI /vp/pos/total_stake). Not the staking
     * account's balance, which also holds NAM on its way out (`unstaking`). null when not read.
     */
    bonded: number | null;
    /** the staking account's whole NAM balance (staked + `unstaking`), null when not read */
    posBalance?: number | null;
    /**
     * NAM in the staking account that is not staked: unstaking, unbonds already withdrawable (sellable without
     * waiting) and rewards not yet claimed. posBalance − bonded from the same reading; null when either is missing.
     */
    unstaking?: number | null;
    pgf: number | null;
    shielded: number | null;
    ibcEscrow: number | null;
    osmosis: number | null;
    transparentLiquid: number | null;
    prov: Provenance;
    osmosisProv: Provenance;
  };
  heads: {
    osmosis: Sourced<number>;
    namada: Sourced<number>;
    epoch: number | null;
  };
  dex: {
    pools: number;
    /**
     * the pools' money: each pool's coins at their own prices (worker/src/pool-sizes.ts), the priced pools summed; null
     * when the priced pools hold too little of the NAM for a total (shared/pool-sides.ts pricedTotal), `prov` says why
     */
    liquidityUsd: number | null;
    refPoolLiquidityUsd: number | null;
    /**
     * how many of `pools` the total counts (the rest cannot be priced and are left out); null when not known: a total
     * stored before the pools were sized from their reserves, or a server before 2026-10-29
     */
    pricedPools?: number | null;
    /** holders on Osmosis (protocol accounts excluded); null when the count could not be read, never 0 as a stand-in. Current, not as of ?at= */
    holders: number | null;
    volume24hNam: number;
    volume24hUsd: number | null;
    buys24h: number;
    sells24h: number;
    buyNam24h: number;
    sellNam24h: number;
    netIbc24h: number | null;     // + = NAM arriving on Osmosis; null when the records could not be read
    prov: Provenance;      // pool data
    coverage: Provenance;  // flow index coverage (last indexed flow)
  };
  namada: {
    /** holders on Namada (spendable or staked, protocol accounts excluded); null when unknown. Current, not as of ?at= */
    holders: number | null;
    /** of those, how many hold under 1 NAM in all (fee dust and test amounts count as holders); null when unknown or on older servers */
    holdersUnder1Nam?: number | null;
    flows24h: number;
    bonded24h: number;
    withdrawn24h: number;
    shielded24h: number;
    unshielded24h: number;
    coverage: Provenance;
  };
  concentration: {
    osmosisTop10Pct: number | null;
    namadaTop10Pct: number | null;
    /**
     * The stamp of each chain's holder figures, the holder count and the top-10 share alike: when the balances
     * behind them were read (old past 6 h, owner decision 7), never the answer's own time. Absent on servers
     * before 2026-10-18 (web/src/screens/activity/holderStamp.ts then reads it from the holder rows).
     */
    namadaProv?: Provenance | null;
    osmosisProv?: Provenance | null;
  };
  checks: Check[];
  sources: SourceHealth[];
}

// ---------------------------------------------------------------- pressure (D2, D3, D4)

export interface OnDeckEntry {
  address: string;          // osmo1 receiver
  label: string | null;
  /** what the site shows for `label` (owner decision 6, shared/labels.ts) */
  labelPlain: string | null;
  /** where `label` came from ('user': a wallet's own tag, shown as "Tag by …", shared/labels.ts tagByline) and its author */
  labelSource?: string | null;
  labelAuthor?: string | null;
  linkedNamada: string | null;
  linkedLabel: string | null;
  linkedLabelPlain: string | null;
  linkedLabelSource?: string | null;
  linkedLabelAuthor?: string | null;
  bridgedIn: number;        // NAM received over IBC in window
  soldSince: number;        // NAM sold on DEX after first arrival
  bridgedOutSince: number;  // NAM sent back over IBC after first arrival (sends that timed out and were refunded left out)
  remaining: number;        // bridgedIn - soldSince - bridgedOutSince, floored at 0
  /**
   * The part of `soldSince` and `bridgedOutSince` counted against what crossed (sales first, then sends back,
   * each at most what is left), so bridgedIn = soldCounted + sentBackCounted + remaining exactly. `soldSince` can
   * be larger than `bridgedIn` (the address also sold NAM it bought on Osmosis); the excess is not counted.
   */
  soldCounted?: number;
  sentBackCounted?: number;
  priorSells30d: number;    // NAM this address sold in the 30d before the window
  firstArrival: number;
  lastSeen: number;
  /**
   * When `linkedNamada` is an intermediate burner address that received its funds via a recent Namada transfer
   * within 48h before bridging, the upstream Namada origin (2-hop attribution).
   */
  hopOriginNamada?: { address: string; label: string | null; labelPlain: string | null; labelSource?: string | null } | null;
  /**
   * When NAM arrived on Osmosis from the MASP (shielded IBC out) and matches a prior MASP shield leg within 24h
   * by amount conservation and low anonymity-set entropy, the probabilistic turnstile origin.
   */
  passthroughFrom?: { address: string; dwellMs: number; anonymitySetK: number; confidence: 'high' | 'medium' | 'low' } | null;
  /** Empirical Bayesian dump hazard score in [0, 1] based on this entity's prior sell propensity and origin cohort. */
  dumpHazardScore?: number;
}

export interface UnbondMaturityBucket {
  withdrawEpoch: number;
  /** Estimated unix ms when this epoch becomes withdrawable (at or before `at` when `withdrawableNow` is true) */
  estimatedAt: number | null;
  withdrawableNow: boolean;
  amountNam: number;
  count: number;
}

/**
 * Consensus-verified forward unlock schedule decoded directly from `/vp/pos/bonds_and_unbonds/to`.
 * Distinguishes unbonds that have already passed their `withdrawEpoch` (`withdrawableNowNam`, liquid on demand)
 * from unbonds still in the unbonding pipeline (`inFlightNam`).
 */
export interface UnbondTermStructure {
  at: number;
  height: number;
  currentEpoch: number;
  /** the measured epoch length the bucket times are computed from (epochs remaining × this), and where it came from; null when it could not be read, and then every in-flight `estimatedAt` is null */
  epochSec?: number | null;
  epochSecSource?: string | null;
  withdrawableNowNam: number;
  inFlightNam: number;
  totalUnbondingNam: number;
  buckets: UnbondMaturityBucket[];
}

export interface UnlockEntry {
  address: string;
  label: string | null;
  labelPlain: string | null;
  /** as OnDeckEntry.labelSource / labelAuthor */
  labelSource?: string | null;
  labelAuthor?: string | null;
  kind: 'withdraw' | 'bond' | 'unbond';
  amountNam: number;
  ts: number;
  txHash: string;
  /** as Flow.explorerHash */
  explorerHash?: string;
  /**
   * For unbond requests: an estimate of when the NAM becomes withdrawable, ts + `Pressure.unbondingEpochs`
   * epochs of the measured length (`ChainParams.epochSec`). It errs late by at most one epoch (the request was
   * made part way into its epoch). null if the parameters are unknown.
   */
  liquidAt: number | null;
  /**
   * Where `liquidAt` came from: 'consensus' when matched against the ABCI bond/unbond listing, 'indexer' when
   * indexer.namada.net lists this unbond with its withdraw time, 'estimate' when it is ts + the measured wait.
   */
  liquidAtSource?: 'consensus' | 'indexer' | 'estimate' | null;
  /** when `liquidAt` is null although the chain lists the unbond: the withdraw epoch and why there is no time */
  liquidAtNote?: string;
  /**
   * For withdrawals: what the address did with the NAM in the following 48 h (sales: 7 days), including 2-hop
   * burner transfers. The address's later moves are shared out over its withdrawals in time order, each withdrawal
   * getting at most its own amount, so one restake is never credited to several withdrawals.
   */
  outcome?: { kind: 'rebonded' | 'bridged_out' | 'sold' | 'shielded' | 'liquid'; amountNam: number } | null;
}

export interface MoverEntry {
  address: string;
  label: string | null;
  labelPlain: string | null;
  /** as OnDeckEntry.labelSource / labelAuthor */
  labelSource?: string | null;
  labelAuthor?: string | null;
  chain: Chain;
  netNam24h: number;
  netNam7d: number;
  buys: number;
  sells: number;
  lastTs: number;
  /** Rolling volume turnaround ratio in [0, 1]: 1 means equal buy and sell volume (cross-block arbitrage / market making). */
  turnaroundRatio?: number;
  /** True when the trader's rolling activity matches a cross-block non-atomic arbitrage or solver pattern. */
  crossBlockArb?: boolean;
}

/** Namada staking parameters from the indexer (worker/src/analytics.ts chainParams). */
export interface ChainParams {
  unbondingLength: number;
  pipelineLength: number;
  /** epochs added to every unbond for slashing (1 on mainnet); null when the indexer did not send it */
  cubicSlashingWindowLength?: number | null;
  /** the shortest an epoch can be (6 h); real epochs also need 2,700 blocks, so they are often longer */
  minEpochSec: number;
  /** measured length of an epoch in seconds (see `epochSecNote`), at least `minEpochSec` */
  epochSec?: number;
  /** how `epochSec` was measured, in plain words */
  epochSecNote?: string;
  /** chain start, unix ms */
  genesisTime?: number | null;
  /** the staking rate the indexer reports (a fraction, e.g. 0.05), null when it sends none */
  apr: number | null;
  fetchedAt: number;
}

export interface SupplyCohortBreakdown {
  /** Bridged in over the window by cohort (NAM) */
  cohorts: {
    genesisBackersNam: number;
    maspTurnstileNam: number;
    burnerHopNam: number;
    transparentNam: number;
  };
  /** Remaining NAM with addresses whose dumpHazardScore is at least SELLS_MOST_CUT (shared/supply-thresholds.ts) */
  highHazardRemainingNam: number;
}

export interface Pressure {
  asOf: number;
  windowDays: number;
  onDeck: OnDeckEntry[];
  onDeckTotal: number;
  /** NAM bridged in / back out over `windowDays` (the names predate the window choice; they are not always 7 days) */
  ibcIn7d: number;
  ibcOut7d: number;
  unlocks: UnlockEntry[];
  /** the unlock list covers this many days and moves of at least this many NAM (absent on servers before 2026-10-17) */
  unlocksWindowDays?: number;
  unlocksMinNam?: number;
  /**
   * Every unstaking request still in its wait, of any size (`unlocks` holds only requests of at least
   * `unlocksMinNam`): the NAM and the number of the requests made from `from` (asOf − the unstaking wait) to
   * `asOf`. null when the wait is not known or the count failed; absent on servers before 2026-10-18.
   */
  unbondingAll?: { nam: number; n: number; from: number } | null;
  /**
   * The unstaking wait in days: `unbondingEpochs` epochs of the measured length (ChainParams.epochSec). An
   * estimate: epochs last at least 6 h and longer when blocks are slow.
   */
  unbondingDays: number | null;
  /** pipeline + unbonding + slashing-window epochs (56 on mainnet) after which an unbond can be withdrawn */
  unbondingEpochs?: number | null;
  /** the measured epoch length behind `unbondingDays`, in hours */
  epochHours?: number | null;
  /** when the chain parameters behind `unbondingDays` were read (absent on servers before 2026-10-17) */
  unbondingProv?: Provenance;
  /** the chain parameters themselves, null when they could not be read (absent on servers before 2026-10-17) */
  chainParams?: ChainParams | null;
  /** Consensus-verified epoch-by-epoch unlock term structure decoded from the ABCI bond/unbond listing. */
  unbondTermStructure?: UnbondTermStructure | null;
  /** when the term structure was read and whether it is current (stale past three bond-listing intervals, missing when there is none) */
  unbondTermStructureProv?: Provenance;
  /**
   * when the withdraw times behind the unlock list's 'consensus' and 'indexer' ends of the wait were read, and who
   * wrote them (`source`: the bond listing's Namada node, or the Namada indexer while no listing completes); when it
   * is not live they were not used, and every unbond row carries the estimate (absent on servers before 2026-10-22)
   */
  unbondWithdrawProv?: Provenance;
  /** Cohort breakdown of supply crossing to Osmosis and remaining on deck. */
  pipelineSummary?: SupplyCohortBreakdown;
  /** NAM staked (the chain's total stake), last reading of each 6-hour period over 14 days */
  bondedTrend: { ts: number; value: number }[];
  movers: MoverEntry[];
  proposals: GovernanceProposal[];
  /** when the proposals were read (absent on servers before 2026-10-17) */
  proposalsProv?: Provenance;
  /** NAM in sends to Namada over the window that timed out and were refunded (left out of `ibcOut7d`) */
  ibcRefunded7d?: number;
  /**
   * Totals over the `onDeck` receivers, so the Ready to sell arithmetic closes:
   * bridgedIn − sold − sentBack = remaining (= onDeckTotal). `ibcIn7d` / `ibcOut7d` are market-wide instead.
   */
  onDeckTotals?: { bridgedIn: number; sold: number; sentBack: number; remaining: number };
  /** both chains' flow indexes together (the older of the two) */
  coverage: Provenance;
  /** each chain's flow index on its own: stamp an Osmosis-only figure with `osmosis`, a Namada-only one with `namada` */
  coverageByChain?: { osmosis: Provenance; namada: Provenance };
  /**
   * The Osmosis index's stamp for what each receiver has left (onDeck and its totals), whose sells are read from 30 days
   * before the window: it carries the history-gap sentence while that reaches back before the stored record is complete
   * (shared/osmosis-gap.ts). Absent on servers before 2026-10-29.
   */
  onDeckProv?: Provenance;
}

// ---------------------------------------------------------------- blind spot (D5)

export interface MaspPassthroughLink {
  inTs: number;
  outTs: number;
  dwellMs: number;
  inFrom: string | null;
  outTo: string | null;
  inAmount: number;
  outAmount: number;
  relDiff: number;
  /** Number of candidate inflows in the window matching the outflow amount within tolerance (k-anonymity) */
  anonymitySetK: number;
  confidence: 'high' | 'medium' | 'low';
}

export interface MaspPulseBucket {
  ts: number;
  inNam: number;
  outNam: number;
  netNam: number;
  cumNetNam: number;
  turnstileNam: number;
  bridgeInNam: number;
  bridgeOutNam: number;
}

export interface BlindSpot {
  asOf: number;
  shielded: Sourced<number>;
  total: number | null;
  sharePct: number | null;
  trend: { ts: number; value: number }[];
  /**
   * NAM into / out of the shielded pool, every leg counted once: shielding and unshielding on Namada, and bridge
   * crossings straight into or out of the pool (recorded on Namada, or only on Osmosis), NAM only.
   */
  shields24h: number;
  unshields24h: number;
  shields7d: number;
  unshields7d: number;
  /** the bridge part of the figures above */
  bridgeIn24h?: number;
  bridgeOut24h?: number;
  bridgeIn7d?: number;
  bridgeOut7d?: number;
  /** time of the most recent bridge crossing into or out of the pool in the last 7 days, null if none */
  lastBridgeAt?: number | null;
  /** bridgeIn7d + bridgeOut7d (kept for clients before 2026-10-18) */
  ibcShielded7d: number;
  /** the largest recent moves out of the pool to an address (unshields and bridge crossings out), 30 days */
  unshields: Flow[];
  /** Probabilistic timing/amount-correlated MASP round-trips (<24h dwell time) in the last 7 days */
  passthroughs7d?: MaspPassthroughLink[];
  /** Total NAM that entered and exited the MASP as a matched <24h turnstile passthrough in the last 7 days */
  turnstileNam7d?: number;
  /** Share of 7d MASP activity that remained sticky (not rapid round-trip transit), in [0, 100] */
  stickySharePct7d?: number | null;
  /** Bucketed MASP inflow/outflow pulse and turnstile volume over time */
  pulseSeries?: MaspPulseBucket[];
  coverage: Provenance;
  coverageByChain?: { osmosis: Provenance; namada: Provenance };
}

// ---------------------------------------------------------------- alerts (D7)

/** GET /api/alerts/recent */
export interface AlertsRecentResponse {
  since: number;
  until: number;
  /** hits in [since, until), newest first */
  hits: AlertHit[];
  /**
   * the most recent hit before `until` of any age (for the empty state: "The last one: …"). Omitted when the
   * server's own search failed or gave up (not known); null only when it searched every record and found none.
   */
  last?: AlertHit | null;
}

export interface AlertHit {
  ruleId: string;
  ts: number;
  flowId: string;
  chain: Chain;
  /** as Flow.explorerHash */
  explorerHash?: string;
  title: string;
  detail: string;
  amountNam: number;
  address: string | null;
  /**
   * Trades only, its USD per NAM. 'settled': what the trade settled at for its trader, every coin their balance changed
   * by with the fees and the transaction fee in (`settle` says which coins, at what rates; shared/settle.ts). 'paid':
   * for a row recorded before the parser kept those coins, its own USDC per NAM. 'quote': the trade has neither (paid
   * in a coin with no price at that minute), so the Osmosis NAM quote stored for that minute (`at` = the quote's
   * time). 'pool_1h': no quote was stored for that minute either, and the row's price is the pool's hourly close a
   * repair set (Flow.meta.priceSource 'pool_1h'; `at` = the hour, meta.priceAt). `at` is otherwise the trade's time.
   * null when none is on record.
   */
  price?: { usd: number; source: 'settled' | 'paid' | 'quote' | 'pool_1h'; at: number; settle?: Settle } | null;
}

export interface AlertRuleInfo {
  id: string;
  title: string;
  decision: string;
  condition: string;
  thresholdNam: number;
}

// ---------------------------------------------------------------- address

export interface ValidatorDelegation {
  validatorAddress: string;
  validatorName: string | null;
  amountNam: number;
  commission: number;
  state: string;
  avatar?: string | null;
}

export interface AddressStaking {
  bondedNam: number;
  unbondingNam: number;
  totalPositionNam: number;
  delegations: ValidatorDelegation[];
  /** Σbond − Σunbond from the flows history, for comparison with the chain value */
  estimatedNam: number | null;
  prov: Provenance;
}

export interface AddressReport {
  address: string;
  chain: Chain;
  label: Label | null;
  balance: Sourced<number>;
  indexedBalance: number | null;
  staking?: AddressStaking | null;
  /** position by spendable NAM on its chain (No. N by spendable NAM), null when not ranked */
  rank: number | null;
  /**
   * position by total NAM (spendable + staked), the holder list's default order: `COUNT(*) + 1` of the holders ahead
   * of it on the stored totals. null when not ranked; absent on servers before the stored-totals build.
   */
  rankTotal?: number | null;
  /** as Holder.change24h / change7d: from recorded chain reads, null when not known */
  change24h: number | null;
  change7d: number | null;
  links: { address: string; chain: Chain; transfers: number; volume: number; lastSeen: number }[];
  totalFlowsCount?: number;
  /**
   * Why the count and the list may be short, beside them: an Osmosis address whose stored moves reach back before the
   * stored Osmosis record is complete (shared/osmosis-gap.ts). Absent when no such gap is known.
   */
  flowsNote?: string;
  flows: Flow[];
  /**
   * Who the address moves NAM with, over `flows`: NAM only and each bridge crossing once (shared/flow-rules.ts
   * counterpartiesOf), with where each label came from ('user': a wallet's own tag, shown as "Tag by …").
   */
  counterparties: { address: string; label: string | null; label_plain?: string | null; label_source?: string | null; label_author?: string | null; inNam: number; outNam: number; count: number }[];
}

/** The groups of a search answer, in the palette's order (nav-search-plan.md 4.6). */
export type SearchGroup = 'addresses' | 'records' | 'names' | 'pools' | 'blocks';
/** What a result is: an address, a record (transaction), a name (a label), a validator's name, a pool, a block. */
export type SearchResultKind = 'address' | 'record' | 'name' | 'validator' | 'pool' | 'block';
/** How the text matched, for the ranking tiers (exact, then start of the value, then its end, then a word start, then inside). */
export type SearchMatch = 'exact' | 'start' | 'end' | 'word' | 'contains';

export interface SearchResult {
  /** the kind in the first build's words, kept for clients before nav step 5 ('validator' and 'block' are new) */
  type: 'address' | 'tx' | 'label' | 'pool' | 'validator' | 'block';
  chain?: Chain;
  /** the address, the record's explorer hash, the pool id or the block height */
  value: string;
  /** plain words (labels as label_plain) */
  title: string;
  subtitle?: string;
  /** for address and label results */
  label?: string | null;
  label_plain?: string | null;
  category_plain?: string | null;
  /** the group it is listed under; absent on servers before nav step 5 */
  group?: SearchGroup;
  /** what it is; absent on servers before nav step 5 */
  kind?: SearchResultKind;
  /** how it matched the text */
  match?: SearchMatch;
  /**
   * The site path that shows it: an address opens its sheet (`/holders?addr=<address>`), a record the moves list on
   * its hash (`/activity?q=<hash>`), a block the moves list on its height, a pool `/trade`.
   */
  href?: string;
  /** a record on a public explorer (opened in a new tab), for records only */
  external?: string | null;
  /**
   * The source and age of what the subtitle states (the holder index's reading behind "staked 1.2 million NAM",
   * the label's source behind a name); null when the subtitle states no figure.
   */
  stamp?: Provenance | null;
}

/** GET /api/search?q=&limit= (SearchRequest): current data, grouped; `results` keeps its first-build shape. */
export interface SearchResponse {
  /** every group's results, groups in SearchGroup order, at most `limit` per group, best first inside a group */
  results: SearchResult[];
  /** when the answer was read; absent on servers before nav step 5 */
  asOf?: number;
  /** per group: how many are listed and whether more matched than the limit */
  groups?: { group: SearchGroup; n: number; more: boolean }[];
}

/** The query parameters of GET /api/search. */
export interface SearchRequest {
  /** the text typed; read with shared/search-grammar.ts parse (no list) */
  q: string;
  /** results per group, 1 to 10 (default 6) */
  limit?: string;
}

// ---------------------------------------------------------------- trade (D1)

export interface PriceQuote {
  amountNam: number;
  side: 'buy' | 'sell';
  inAmount: number;
  inSymbol: string;
  outAmount: number;
  outSymbol: string;
  spotPriceUsd: number;
  effectivePriceUsd: number;
  usdcValue: number;
  priceImpactPct: number;
  effectiveFeePct: number;
  route: string[];
  prov: Provenance;
}

export interface SlippageCurvePoint {
  amountNam: number;
  usdSize: number;
  buyImpactPct: number | null;
  sellImpactPct: number | null;
  buyEffectiveUsd: number | null;
  sellEffectiveUsd: number | null;
  sellOutUsdc: number | null;
  /**
   * USDC to spend to buy about `amountNam` NAM: the router is asked what a USDC amount buys, and the amount is
   * adjusted until the NAM out is within 0.5% of `amountNam` (worker/src/sources/sqs.ts quoteBuyFor). The NAM
   * the final quote returns is `buyOutNam`; when the router could not be brought that close, `buyExact` is false.
   */
  buyInUsdc: number | null;
  /** NAM the final buy quote returns for `buyInUsdc` (null when there is no buy quote) */
  buyOutNam?: number | null;
  /** true when `buyOutNam` is within 0.5% of `amountNam` */
  buyExact?: boolean;
  /** Marginal execution price (ΔUSDC / ΔNAM) for the incremental slice from the previous tier to `amountNam` */
  marginalSellUsd?: number | null;
  /** Marginal sell price impact (%) for the incremental slice against `spotUsd` */
  marginalSellImpactPct?: number | null;
  /** Marginal buy price (ΔUSDC / ΔNAM) for the incremental slice from the previous tier to `amountNam` */
  marginalBuyUsd?: number | null;
}

/** How a safe-size figure was made (QuoteCurveResponse.safeClip1Pct / safeClip3Pct). */
export interface SafeClipInfo {
  /** NAM, or null when the smallest quoted size already moves the price more than the limit */
  nam: number | null;
  /**
   * 'interpolated': between the two quoted sizes around the limit; 'at_least': no quoted size reaches the limit,
   * so it is at least the largest one; 'below_smallest': even the smallest quoted size moves the price more.
   */
  how: 'interpolated' | 'at_least' | 'below_smallest';
  /** the smallest quoted size and its worse-side price move, for the 'below_smallest' sentence */
  smallestNam: number;
  smallestImpactPct: number;
}

export interface QuoteCurveResponse {
  spotUsd: number | null;
  /** the NAM pools in the tick's pool list (worker/src/pool-sizes.ts curveWithPools); null when that list was not read, never 0 for it */
  poolsCount: number | null;
  /** the pools' size from their reserves (worker/src/pool-sizes.ts), the priced pools only; null when none is priced */
  totalLiquidityUsd: number | null;
  refPoolLiquidityUsd: number | null;
  /**
   * The order size (NAM) at which the price move reaches 1% (resp. 3%) on the WORSE of the two sides (W6):
   * `safeClip` in worker/src/sources/sqs.ts takes max(sellImpactPct, buyImpactPct) at every listed size, so the
   * figure holds for buying or selling alike, and UI copy says "buying or selling", never only "selling".
   * It is an estimate between listed sizes: interpolated linearly between the two sizes around the limit, and
   * equal to the largest listed size when no listed size reaches the limit (read it as "at least"). null when
   * no size has both sides quoted, or when even the smallest quoted size moves the price more than the limit
   * (`safeClip1Pct.how` is then 'below_smallest': say "under 1,000 NAM", never a number no quote supports).
   */
  maxSafeClip1PctNam: number | null;
  maxSafeClip3PctNam: number | null;
  /** the same figures with how each was made; nam is null (never scaled down from 0) below the smallest size */
  safeClip1Pct?: SafeClipInfo | null;
  safeClip3Pct?: SafeClipInfo | null;
  /**
   * Order size (NAM) above which Concentrated Liquidity tick boundaries cause a >2.5x jump in marginal slippage
   * (or liquidity exhaustion); null when marginal slippage progresses smoothly across all quoted tiers.
   */
  liquidityCliffNam?: number | null;
  cliffNote?: string | null;
  curve: SlippageCurvePoint[];
  prov: Provenance;
}

export interface OrderflowBucket {
  ts: number;
  buyNam: number;
  sellNam: number;
  netDeltaNam: number;
  cvdNam: number;
  vwapUsd: number | null;
  trades: number;
}

export interface OrderflowResponse {
  asOf: number;
  hours: number;
  bucketMs: number;
  buckets: OrderflowBucket[];
  netCvdNam: number;
  grossVolumeNam: number;
  buySharePct: number | null;
  priceChangePct: number | null;
  absorptionRegime: 'bid_absorption' | 'ask_absorption' | 'trend_up' | 'trend_down' | 'balanced';
  prov: Provenance;
}

// ---------------------------------------------------------------- intel

export interface ForumTopic {
  id: number;
  title: string;
  slug: string;
  url: string;
  categoryId: number;
  categoryName: string;
  postsCount: number;
  replyCount: number;
  views: number;
  likeCount: number;
  createdAt: string;
  lastPostedAt: string;
  lastPoster: string;
  pinned: boolean;
}

export interface ForumPost {
  id: number;
  topicId: number;
  topicTitle: string;
  topicSlug: string;
  postNumber: number;
  url: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  createdAt: string;
  excerpt: string;
  isNewTopic: boolean;
}

export interface GovernanceProposal {
  id: number;
  title: string;
  authors: string | null;
  abstract: string | null;
  type: string;
  status: string;
  startEpoch: number;
  endEpoch: number;
  activationEpoch: number;
  yayNam: number;
  nayNam: number;
  abstainNam: number;
  discussionsUrl: string | null;
}

export interface ValidatorSummary {
  address: string;
  name: string | null;
  votingPowerNam: number;
  commission: number;
  state: string;
  avatar: string | null;
}

export interface IntelResponse {
  topics: ForumTopic[];
  latestPosts: ForumPost[];
  proposals: GovernanceProposal[];
  validators: ValidatorSummary[];
  indexerEpoch: number | null;
  fetchedAt: number;
}

// ---------------------------------------------------------------- per-user settings (D7)

export type AlertRuleId = 'ibc_inventory' | 'unlock' | 'big_swap' | 'unshield' | 'bond' | 'exit_bridge';

export interface RulePref { on: boolean; thresholdNam: number }

export interface NotificationPrefs {
  rules: Record<AlertRuleId, RulePref>;
  /** Any flow touching one of these addresses, regardless of size */
  watchlist: string[];
  watchlistOn: boolean;
  forumAndGov: boolean;
  /**
   * The daily digest at 08:00 UTC (and the weekly on Mondays), sent even in quiet hours; off by default. A row saved
   * before the switch existed has no such field and reads as off.
   */
  dailyDigest?: boolean;
  /** UTC hours [start, end) during which nothing is sent; null = always */
  quietHoursUtc: { start: number; end: number } | null;
}

/**
 * `stopped`: why the channel is off though its owner did not pause it: Discord answered that its webhook is gone (404)
 * or its token is wrong (401), to an alert or to the connection notice a save posts; or (reason 'notice') that notice
 * did not reach the channel when the link was saved (`status` is Discord's answer, or 0 when it gave none); with
 * `savedAt`, a channel saved on with the note below was turned off later because no post reached it (`status`: the
 * answer at `at` that blamed the link, or, with `tries`, the answer to the last of the notices posted again on as many
 * days, none of which reached it).
 * `notice`: sending is on, but the connection notice the save posted did not reach the channel, twice, with an answer
 * that says nothing of the link (`status`: a 5xx, a 429 that is not the link's own, or 0 for no answer; `at`: when the
 * link was saved): no post has reached the link yet, and the first alert, or a test message, proves or stops it; a
 * day with no post taken has the notice posted again, once a day (`tries`: how many, and the last one's answer and
 * time), which proves or stops it the same way. Left out once a post has succeeded.
 */
export interface DiscordChannel { enabled: boolean; webhookUrlMasked: string | null; hasUrl: boolean; stopped?: { status: number; at: number; reason?: 'notice'; savedAt?: number; tries?: number } | null; notice?: { status: number; at: number; tries?: { n: number; status: number; at: number } } | null }

/**
 * A Telegram chat the alerts go to (worker/src/telegram-bot.ts): linked only by the bot's own handshake (the owner
 * opens the bot from Settings and presses Start, or adds it to a group), never by a chat id the page sends. `linked`:
 * a chat is linked; `enabled`: alerts are sent to it; `kind`: a private chat with the bot, or a group; `title`: a
 * group's name as Telegram gave it (null for a private chat); `stopped`: why the chat was unlinked though its owner did
 * not press Disconnect (the person blocked the bot or sent /stop, or the bot was removed from the group).
 */
export interface TelegramChannel {
  linked: boolean;
  enabled: boolean;
  kind: 'private' | 'group' | null;
  title: string | null;
  linkedAt: number | null;
  stopped?: { reason: 'blocked' | 'removed' | 'stop'; at: number } | null;
}

/** What the API returns: secrets are never included, only whether they exist. */
export interface UserSettings {
  address: string;
  notifications: NotificationPrefs;
  /** `telegram` is absent from an answer of a server without the channel. */
  channels: { discord: DiscordChannel; telegram?: TelegramChannel };
  createdAt: number;
  updatedAt: number;
}

export interface SessionInfo { id: string; via: 'namada' | 'keplr' | 'pair' | 'api'; createdAt: number; expiresAt: number; lastUsedAt: number | null; current: boolean }

export interface DonationConfig {
  transparentAddress: string | null;
  shieldedAddress: string | null;
  osmosisAddress: string | null;
}

export type LiveMessage =
  | { type: 'hello'; at: number; upstream: { osmosis: boolean; namada: boolean } }
  | { type: 'flows'; flows: Flow[] }
  | { type: 'status'; upstream: { osmosis: boolean; namada: boolean }; heights: { osmosis?: number; namada?: number }; at: number }
  /** `source` and `note`: how the hub read the price (the price list, or the route's spot), as the overview says it */
  | { type: 'price'; usd: number; at: number; source?: string; note?: string };

// ---------------------------------------------------------------- series and the Trade basics
// docs/design/screener-plan.md 2.1 to 2.6, 2.11 and the read contract 2.12; mounted at /api/series by one line in
// worker/src/api.ts (worker/src/api-series.ts). Every answer carries its provenance and its honest start (3.9):
// nothing is drawn before a series starts, a window not yet covered is null with the reason (never 0), and a pool
// hour without a trade is a flat tick, never a candle.

/**
 * The body of every series answer that is not a reading: a request refused as asked (400), an unknown key or path
 * under /api/series (404) and a failure on our side (500), all sent no-store. (501, a route mounted but not built,
 * existed only while the routes were being built; the client still reads it as not served.)
 */
export interface NotServedBody {
  /** plain words for the reader ("This figure is not served yet.") */
  error: string;
  /** what is missing, for the developer reading the answer */
  reason: string;
  endpoint: string;
}
/** The words a panel prints when its route is not served: 404 from a server without the routes (screener-plan 8: the "—" state, never an error). */
export const NOT_SERVED = 'This figure is not served yet.';

/** The step of a series answer. */
export type SeriesStep = '1m' | '1h' | '6h' | '1d';
export const SERIES_STEP_MS: Record<SeriesStep, number> = { '1m': 60_000, '1h': 3_600_000, '6h': 21_600_000, '1d': 86_400_000 };
/** The most points one series answer holds; a wider range at a finer step is refused (400) with the reason. */
export const SERIES_MAX_POINTS = 3000;
/** The unit of a series' values. */
export type SeriesUnit = 'usd_per_nam' | 'nam' | 'usd' | 'count' | 'pct';
/** How a step's value is made from the readings inside it: the last one (prices, depth, supply) or their sum (volume, counts). */
export type SeriesAgg = 'last' | 'sum';

/**
 * GET /api/series?key=&from=&to=&step=&at= (query parameters as the URL carries them). Each must be in
 * worker/src/http.ts CACHE_PARAMS['/api/series'] once the route is cached.
 */
export interface SeriesRequest {
  /**
   * A served key; anything else is a 404. price.usd, price.swap_1h, price.pool_1h,
   * dex.swaps_1h.{nam,buy_nam,sell_nam,n,buyers,sellers}, dex.liquidity_usd, supply.total_stake, supply.masp_shielded,
   * dex.volume_24h_usd_osmosis, dex.volume_7d_usd_osmosis, dex.volume_usd_daily.osmosis,
   * dex.ref_pool_liquidity_usd.daily.osmosis, dex.volume_nam_daily, dex.traders_daily, dex.hours_with_trades_daily,
   * holders.namada, holders.osmosis, and pool_hourly.<pool id>.<liquidity_usd|nam_reserve|volume_24h_usd_osmosis|
   * volume_7d_usd_osmosis|liquidity_usd_osmosis>.
   */
  key: string;
  /** unix ms or YYYY-MM-DD (UTC midnight); default `to` − 30 days */
  from?: string;
  /** unix ms or YYYY-MM-DD (the end of that day); default now, or `at` */
  to?: string;
  /** default: the finest of 1m, 1h, 6h, 1d that keeps the answer within SERIES_MAX_POINTS */
  step?: SeriesStep;
  /** Rewind: nothing newer than this */
  at?: string;
}

export interface SeriesSample {
  /** start of the step (unix ms) */
  t: number;
  /**
   * the time of the step's newest reading (unix ms), when it is not the step's start: a minute reading of the hour
   * not rolled up yet, or the last hour that traded in a 6-hour or daily step. Absent: the reading is keyed at `t`.
   */
  at?: number;
  /** the step's value: its last reading ('last') or the sum of its readings ('sum') */
  v: number;
  /** the step's lowest and highest reading and how many readings it holds */
  lo?: number;
  hi?: number;
  n?: number;
  /** index into SeriesResponse.sources; absent means sources[0] */
  src?: number;
  /** pool price only: no trade moved the pool in that hour (open = high = low = close); drawn as a flat tick, never a candle */
  flat?: boolean;
}

export interface SeriesSource {
  /** the technical source word (shown in plain words through web/src/lib/prov.ts) */
  source: string;
  /** this source's first and last point in the answer; null when it has none in this range */
  from: number | null;
  to: number | null;
  /** its honest start: the first reading it ever recorded for the key, whatever the range asked */
  start: number | null;
  /** what the start means, in plain words ("Recorded every minute since 15 Oct 2026; nothing earlier exists.") */
  startNote: string;
  /** true when the history before its writer shipped was filled in once from stored rows (startNote says from which) */
  backfilled: boolean;
}

/** A stretch the record does not cover (the reader was not running, the source did not answer): not "no trade". */
export interface SeriesGap {
  from: number;
  to: number;
  /** in plain words */
  why: string;
}

export interface SeriesResponse {
  key: string;
  /** the range answered, [from, to) in unix ms */
  from: number;
  to: number;
  step: SeriesStep;
  stepMs: number;
  agg: SeriesAgg;
  unit: SeriesUnit;
  /** oldest first; a step with no reading has no point (nothing is filled in) */
  points: SeriesSample[];
  /** one or more sources (a series stitched from two keys names both, each with its own start) */
  sources: SeriesSource[];
  /** the series' honest start (the earliest source start): a chart draws nothing before it and prints it under itself */
  start: number | null;
  /**
   * true for a series written only when something happened (executed swaps, trade volume): a step without a point
   * had no trade, which is not a gap. false for readings taken on a clock (the quoted price, depth, supply): a run of
   * steps without a point is listed in `gaps`.
   */
  sparse: boolean;
  /** steps in the range from `start` on, and how many have a point ("70 of the last 720 hours had a trade") */
  coverage: { steps: number; withPoint: number };
  /** runs of steps on a clock series with no reading, merged; empty for a sparse series */
  gaps: SeriesGap[];
  /** the newest point's source, time and status (missing with the reason when the range has no point) */
  prov: Provenance;
  asOf: number;
}

/** The windows of the price changes (screener-plan 2.1). */
export type PriceChangeWindow = 'h1' | 'h6' | 'h24' | 'd7' | 'd30';
export const PRICE_CHANGE_WINDOW_MS: Record<PriceChangeWindow, number> = { h1: 3_600_000, h6: 21_600_000, h24: 86_400_000, d7: 604_800_000, d30: 2_592_000_000 };
/** The windows of the pool-price changes (the Osmosis data API pair series reaches back to 20 Jun 2025). */
export type PoolChangeWindow = 'd7' | 'd30' | 'y1';
export const POOL_CHANGE_WINDOW_MS: Record<PoolChangeWindow, number> = { d7: 604_800_000, d30: 2_592_000_000, y1: 31_536_000_000 };
/**
 * A change's base may come at most this share of its window after the window's start (3 minutes for 1 h, 72 for
 * 24 h, 8.4 hours for 7 days); a later first reading means the window is not covered, and the change is null.
 */
export const PRICE_BASE_MAX_LAG_SHARE = 0.05;

/** One reading a change is measured between. */
export interface PriceReading {
  value: number;
  at: number;
}

export interface PriceChange {
  window: PriceChangeWindow | PoolChangeWindow;
  windowMs: number;
  /** (now − base) / base × 100; null when the window is not covered or a reading is missing (the note says which) */
  pct: number | null;
  /** the reading it is measured to (the latest at or before asOf) */
  now: PriceReading | null;
  /** the reading it is measured from: the first stored reading at or after now.at − windowMs */
  base: PriceReading | null;
  /** base.at − (now.at − windowMs): how far after the window's start the base was read (0 on time) */
  baseLagMs: number | null;
  prov: Provenance;
  /** "The quoted price has been recorded since 15 Oct 2026." when not covered */
  note?: string;
}

/** GET /api/series/changes?at= */
export interface PriceChangesResponse {
  asOf: number;
  /** from the quoted price (metric price.usd: the Osmosis router, every minute since 15 Oct 2026 04:14 UTC) */
  quoted: Record<PriceChangeWindow, PriceChange>;
  /** from the pool price (metric price.pool_1h: Osmosis data API, pool 3005 spot, hourly closes); labelled "pool price", never mixed with `quoted` */
  pool: Record<PoolChangeWindow, PriceChange>;
}

/** The windows of the volume figures (screener-plan 2.2). */
export type VolumeWindow = 'h1' | 'h6' | 'h24' | 'd7' | 'd30';
export const VOLUME_WINDOW_MS: Record<VolumeWindow, number> = { h1: 3_600_000, h6: 21_600_000, h24: 86_400_000, d7: 604_800_000, d30: 2_592_000_000 };
/** Our 24 h dollar volume and the Osmosis pair summary's disagree when they are more than this many percent apart. */
export const VOLUME_DISAGREE_PCT = 25;

/** Executed volume over one window, summed from the hourly trade rows (metrics dex.swaps_1h.*, at most 720 per key). */
export interface ExecutedVolume {
  window: VolumeWindow;
  /** [from, to) in unix ms */
  from: number;
  to: number;
  /** NAM bought plus NAM sold, bot round trips left out */
  nam: number;
  buyNam: number;
  sellNam: number;
  buys: number;
  sells: number;
  /** dollars at execution (the sum of each trade's value then); null when any trade of the window has none */
  usd: number | null;
  /** dollars over the trades that have a value, and how many have none */
  usdPriced: number;
  unpriced: number;
  /** makers (signers) who bought and who sold; `tradersHow` says how they are counted */
  buyers: number;
  sellers: number;
  /** 'distinct': each address once in the window; 'distinct_per_hour_summed': once per hour, the hours added up (say so) */
  tradersHow: 'distinct' | 'distinct_per_hour_summed';
  /** dollars per NAM over the priced trades (all, buys, sells); null when none is priced */
  vwapUsd: number | null;
  buyVwapUsd: number | null;
  sellVwapUsd: number | null;
  /** hours of the window with at least one trade, of `hours` */
  hoursWithTrade: number;
  hours: number;
}

/** GET /api/series/volume?at= : every window in one answer (one read of at most 720 rows per key). */
export interface VolumeResponse {
  asOf: number;
  /** printed with the figure (shared/copy.ts, the 'volume' fact): what is counted and how it is priced */
  definition: string;
  /** null for a window the record does not cover (executed volume is recorded since 12 Aug 2026) */
  windows: Record<VolumeWindow, ExecutedVolume | null>;
  /** the flow index's Osmosis coverage (how far the swaps are read) */
  prov: Provenance;
  /** the first trade-hour recorded: the figures' honest start */
  start: number | null;
  /** the Osmosis data API pair summary over the NAM pairs (priced leg only), with its own update time */
  osmosis: Sourced<{ usd24h: number | null; usd7d: number | null }>;
  /** what the Osmosis figure counts, printed beside it */
  osmosisDefinition: string;
  /** both 24 h dollar figures exist and are more than VOLUME_DISAGREE_PCT apart: show the disagree state, both reachable */
  disagree: boolean;
}

/** One pool holding NAM (the pairs list, screener-plan 2.4). */
export interface PairRow {
  poolId: string;
  /** e.g. 'NAM/USDC' */
  pair: string;
  counterSymbol: string | null;
  type: PoolInfo['type'] | null;
  /**
   * the pool's size (its NAM at the site's price plus its other coin at that coin's price, the cron's stored pool list:
   * worker/src/pool-sizes.ts), its reserves in whole coins and its fee; null when the pool is not listed, or the size
   * when the pool cannot be priced (`sizeProv` says why)
   */
  liquidityUsd: number | null;
  namReserve: number | null;
  counterReserve: number | null;
  spreadFactor: number | null;
  /** where the size came from, or why the pool is not priced (absent when the pool list did not name the pool) */
  sizeProv?: Provenance;
  /** the pair summary's dollars traded in 24 h and 7 d (priced leg only) and its liquidity; value null with "Osmosis does not list this pool's volume" when absent */
  osmosis: Sourced<{ volume24hUsd: number | null; volume7dUsd: number | null; liquidityUsd: number | null }>;
  /** trades recorded here through this pool in 24 h, from the swap legs; value null with the note until legs are recorded */
  here24h: Sourced<{ trades: number; nam: number }>;
  /** when the pool was created (read once from the chain, kv pool.created.<id>); null when not read */
  createdAt: number | null;
}

/** GET /api/series/pairs : the NAM pools, deepest first. */
export interface PairsResponse {
  asOf: number;
  pairs: PairRow[];
  /** the cron's stored pool list (the router's reserves priced from the depth minute or the stored price), old past its age */
  prov: Provenance;
  /** the pair summary (its own update time, `last_update_at`) */
  osmosisProv: Provenance;
  /** sums over the pairs of the summary's figures that are known; null when no pair has the figure */
  osmosisTotals: { volume24hUsd: number | null; volume7dUsd: number | null; liquidityUsd: number | null };
}

/** Consecutive trades by one maker on one side this close together fold into one tape row (screener-plan 2.5). */
export const TRADE_FOLD_MS = 600_000;
/** Consecutive trades fold only when each is under this many NAM: a bigger trade always stands alone on the tape. */
export const TRADE_FOLD_UNDER_NAM = 2000;
/** The most rows a trades page holds. */
export const TRADES_LIMIT_MAX = 100;
/** The rows the Trade page's tape asks for (any other `limit` is a cache entry no page asks for: worker/src/http.ts isReplay). */
export const TRADES_TAPE_LIMIT = 60;

/** The query parameters of GET /api/series/trades. */
export interface TradesRequest {
  /** a moves cursor (TradesResponse.next) or a plain unix-ms time: shared/paging.ts parseBeforeParam */
  before?: string;
  /** one maker's trades only (a whole address) */
  maker?: string;
  /** at least this many NAM */
  min?: string;
  /** 10 to TRADES_LIMIT_MAX */
  limit?: string;
  at?: string;
}

export type TradePattern = 'repeated_small_buys';

/** One executed NAM swap on Osmosis (bot round trips left out). */
export interface TradeRow {
  id: string;
  ts: number;
  height: number;
  /** how the time is known, as Flow.meta.tsSource ('block', 'extrapolated', 'interpolated'); null when not said */
  tsSource: string | null;
  kind: 'buy' | 'sell';
  nam: number;
  counterSymbol: string | null;
  counterAmount: number | null;
  /** the trade's own price, dollars per NAM, and where it came from; null with `priceNote` when none was recorded (no pool spot price stands in) */
  priceUsd: number | null;
  priceSource: 'execution' | 'swap_1h' | 'spot' | 'pool_1h' | 'unknown' | null;
  /** with priceSource 'pool_1h': the hour of the pool's close the price is (Flow.meta.priceAt) */
  priceAt?: number;
  valueUsd: number | null;
  priceNote?: string;
  /**
   * What the trade settled at for its trader (shared/settle.ts): every coin their balance changed by, the pools' and
   * the taker's fees and the gas in, per NAM they gave or got. Absent when the row has no settle record or a coin in
   * it has no price at that minute; the row then shows priceUsd with its basis. The tape shows this ahead of priceUsd
   * and sums it (shared/settle.ts tradeValue).
   */
  settle?: Settle;
  /** the trader (Flow.meta.trader: the account whose NAM the swap moved, else the signer), else the receiving (buy) or sending (sell) address */
  maker: string | null;
  makerLabelPlain: string | null;
  makerLabelSource?: string | null;
  makerLabelAuthor?: string | null;
  /** the maker's recorded buys and sells, all time, bots left out (one grouped count per page) */
  makerTrades: { buys: number; sells: number } | null;
  /** the pools the swap went through, in order */
  route: string[];
  txHash: string;
  explorerHash?: string;
  /** the maker's pattern in the 24 h before this trade (TradesResponse.patternRule): a description, never a claim about intent */
  pattern: TradePattern | null;
}

/**
 * A run of consecutive rows by one maker on one side, each under foldUnderNam NAM, within foldMs of the next, and
 * through a pool every row of the run went through (the router picks each trade's route, so routes differ): one tape
 * row ("bought 12 times, 4,210 NAM, $4.91 average") with the rows behind a disclosure. A single trade is a group of one. A run is
 * cut at the page's end; the next page's first group may continue it (same maker and side, within foldMs) and the
 * client joins the two.
 */
export interface TradeGroup {
  maker: string | null;
  kind: 'buy' | 'sell';
  /** the folded rows' ids, newest first (rows in TradesResponse.rows) */
  ids: string[];
  n: number;
  nam: number;
  /** dollars over the priced rows (each its settle price's dollars when it has one: shared/settle.ts tradeValue), and how many have no price; null when none is priced */
  usd: number | null;
  unpriced: number;
  /** those dollars per NAM over the same rows (a settled row's NAM is what its trader gave or got); null when none is priced */
  avgPriceUsd: number | null;
  firstTs: number;
  lastTs: number;
  pattern: TradePattern | null;
}

/** GET /api/series/trades : the trades tape, newest first, keyset paged on (ts, height, id). */
export interface TradesResponse {
  rows: TradeRow[];
  groups: TradeGroup[];
  /** the cursor for older trades (send it back as `?before=`); null at the end of the record */
  next: string | null;
  asOf: number;
  /** the fold rule, sent so the tape can say it: TRADE_FOLD_MS */
  foldMs: number;
  /** consecutive trades fold only when each is under this many NAM (TRADE_FOLD_UNDER_NAM) */
  foldUnderNam?: number;
  /** "Repeated small buys": at least `minBuys` buys under `underNam` NAM within `windowMs` (20, 2,000, 24 h in the plan) */
  patternRule: { minBuys: number; underNam: number; windowMs: number };
  /** the flow index's Osmosis coverage */
  prov: Provenance;
  /** the first trade recorded: the tape's honest start */
  firstTs: number | null;
}

/** One input of a derived figure, with its own source and time. */
export interface ValueInput { name: string; value: number | null; at: number | null; source: string; status: Provenance['status'] }
/** A figure derived from stored readings, printed only with its definition (screener-plan 2.7: never "market cap"). */
export interface ValueFigure {
  label: string;
  definition: string;
  /** dollars; null when an input is not recorded (prov.note says which) */
  value: number | null;
  inputs: ValueInput[];
  /** source 'derived': the oldest input's time and the worst input's status */
  prov: Provenance;
}
/** GET /api/series/values?at=: all NAM and spendable NAM at today's price, each with its definition and inputs. */
export interface ValuesResponse { asOf: number; fdv: ValueFigure; spendable: ValueFigure }
