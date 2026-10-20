// API contract shared by the Worker and the web UI.

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
   *  ('execution' | 'swap_1h' | 'spot' | 'unknown'), `arb`, `trader`, `source`. */
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
}

/** GET /api/flows: newest first. */
export interface FlowsResponse {
  total: number;
  page: number;
  limit: number;
  flows: Flow[];
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

/** GET /api/holders. Not available under rewind: balances are current, not as of `at`. */
export interface HoldersResponse {
  total: number;
  page: number;
  limit: number;
  holders: Holder[];
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
  namReserve: number;
  counterReserve: number;
  liquidityUsd: number;
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
    liquidityUsd: number | null;
    refPoolLiquidityUsd: number | null;
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
  hopOriginNamada?: { address: string; label: string | null; labelPlain: string | null } | null;
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
  rank: number | null;
  /** as Holder.change24h / change7d: from recorded chain reads, null when not known */
  change24h: number | null;
  change7d: number | null;
  links: { address: string; chain: Chain; transfers: number; volume: number; lastSeen: number }[];
  totalFlowsCount?: number;
  flows: Flow[];
  /**
   * Who the address moves NAM with, over `flows`: NAM only and each bridge crossing once (shared/flow-rules.ts
   * counterpartiesOf), with where each label came from ('user': a wallet's own tag, shown as "Tag by …").
   */
  counterparties: { address: string; label: string | null; label_plain?: string | null; label_source?: string | null; label_author?: string | null; inNam: number; outNam: number; count: number }[];
}

export interface SearchResult {
  type: 'address' | 'tx' | 'label' | 'pool';
  chain?: Chain;
  value: string;
  /** plain words (labels as label_plain) */
  title: string;
  subtitle?: string;
  /** for address and label results */
  label?: string | null;
  label_plain?: string | null;
  category_plain?: string | null;
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
  poolsCount: number;
  totalLiquidityUsd: number;
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

export type AlertRuleId = 'ibc_inventory' | 'unlock' | 'big_swap' | 'unshield' | 'bond';

export interface RulePref { on: boolean; thresholdNam: number }

export interface NotificationPrefs {
  rules: Record<AlertRuleId, RulePref>;
  /** Any flow touching one of these addresses, regardless of size */
  watchlist: string[];
  watchlistOn: boolean;
  forumAndGov: boolean;
  /** UTC hours [start, end) during which nothing is sent; null = always */
  quietHoursUtc: { start: number; end: number } | null;
}

export interface DiscordChannel { enabled: boolean; webhookUrlMasked: string | null; hasUrl: boolean }

/** What the API returns: secrets are never included, only whether they exist. */
export interface UserSettings {
  address: string;
  notifications: NotificationPrefs;
  channels: { discord: DiscordChannel };
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
  | { type: 'price'; usd: number; at: number };
