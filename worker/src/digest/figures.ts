// The figures of the daily and weekly digest (spec section 5), read from D1 alone and nothing fetched. The reads run
// as three db.batch waves (waves.ts), every statement from sql.ts with bound parameters; the answers are collected
// into DigestReads and shaped by pure functions, so the tests shape the real stored answers of 2026-10-23 without a
// database and run the statements themselves on the SQLite stand-in. Each section is read inside its own try: a
// section whose statement failed is a NotRead with "the database did not answer this read", never a missing section
// and never a 0. Only the header part (the kv anchors and the epoch at T) throws, so nothing is sent on a tick whose
// database did not answer at all.
import type { ChainParams } from '../../../shared/types';
import { explorerHashOf, safeHttpUrl } from '../../../shared/flow-rules';
import { ibcRowOf, timedOutSends, NAMADA_CURSOR_MAX_LAG, NAMADA_CURSOR_STALE_MS, OSMOSIS_LIVE_STALE_MS, OSMOSIS_SWEEP_STALE_MS } from '../analytics';
import { osmosisTrustedStart } from '../holders';
import { epochClock, epochClockAt, epochEnd, type EpochClock } from './epoch';
import {
  BALANCE_LISTING_BOUND_MS, BASE_WINDOW_MS, BOND_LISTING_BOUND_MS, EXECUTED_COMPARE_MS, EXECUTED_SHOW_MS, GOV_LINK_MAX, HOLDER_FIGURES_BOUND_MS, HOURLY_BOUND_MS,
  INTEL_STALE_MS, MINUTE_BOUND_MS, OSMOSIS_PASS_TRUST_MS, PARAMS_STALE_MS, boundOf, changeFrom, firstRow, metricFigure, readNow,
} from './freshness';
import { ANCHOR_KV_KEYS, DIGEST_TRADES_MAX, MASP_ADDRESS, SQL } from './sql';
import { AGGREGATE_POOL_ID } from '../depth/sql';
import { DEPTH_OFFSETS_PCT, DEPTH_QUOTABLE_SIZE, OFFSET_10_INDEX } from '../../../shared/depth';
import {
  DB_NOT_ANSWERED, HOUR_MS, ReadFailed, digestWindow, fmtClock, isNotRead, notRead, rowsOf, staleReason, valueOf,
  type Answer, type Change, type DigestKind, type DigestWindow, type Figure, type MetricFigure, type MetricRow, type Stamp,
} from './types';
import { Wave, type Handle, type Prepared } from './waves';

export type { DigestKind, DigestWindow, Figure, NotRead, Stamp, MetricFigure, Change } from './types';
export { digestWindow, isNotRead } from './types';

// ------------------------------------------------------------------------------------------------- source names

/** The names each figure is marked with: the health rows' own where a probe exists, this site's indexes otherwise. */
export const SOURCES = {
  totalStake: 'Namada RPC (total stake)',
  posBalance: 'Namada RPC (PoS balance)',
  mintedSupply: 'Namada RPC (minted supply)',
  escrow: 'Namada RPC (IBC escrow)',
  maspBalance: 'Namada RPC (MASP balance)',
  epoch: 'Namada RPC (epoch)',
  osmosisSupply: 'Keplr Osmosis REST (supply)',
  quote: 'Osmosis SQS (price)',
  tradeIndex: "this site's Osmosis trade index (single-pool NAM/USDC swaps of at least 50 NAM)",
  osmosisApi: 'Osmosis data API (summary)',
  namadaScan: "this site's Namada block scan",
  osmosisIndex: "this site's Osmosis stream and catch-up search",
  bondListing: "the chain's bond listing",
  balanceListing: "the chain's balance listing",
  osmosisHolders: 'Keplr Osmosis REST (holders)',
  holderIndex: "this site's holder index",
  osmosisHolderIndex: "this site's Osmosis holder index",
  params: 'indexer.namada.net chain parameters',
  proposals: 'indexer.namada.net proposals',
  validatorDaily: 'the first complete bond listings of the two days',
  depthStore: "this site's depth store (every Osmosis pool holding NAM, read by the minute)",
} as const;

/** The health rows two "not read" rules read (spec 5.8, 5.9). */
export const HEALTH_ROWS = { balanceListing: 'Namada RPC (balance listing)', indexer: 'Namada indexer (indexer.namada.net)' } as const;

// ------------------------------------------------------------------------------------------------- row shapes

export interface KvRow { key: string; value: string; updated_at: number }
export interface ListingRow { at: number; kind: string; height: number; provider: string }
export interface PosKindRow { kind: string; n: number; nam: number | null; largest: number | null; first_ts: number | null; last_ts: number | null; late: number | null }
export interface LargestRow { id: string; tx_hash: string; ts: number; height: number; amount_num: number; validator: string | null; inner_hash: string | null; wrapper: string | null }
export interface TieRow { amount_num: number; n: number; validators: number }
export interface SumRow { nam: number | null; n: number | null }
export interface QueueRow { withdraw_epoch: number; nam: number; n: number }
export interface TrustedRow { n: number; vwap: number | null; lo: number | null; hi: number | null; last_ts: number | null }
export interface TradesRow {
  n: number; nam: number | null; usd: number | null; unpriced: number | null; traders: number; buy_nam: number | null; sell_nam: number | null; last_ts: number | null;
  how_execution?: number | null; how_pool_1h?: number | null; how_spot?: number | null; how_swap_1h?: number | null; how_unstated?: number | null;
}

/** The priced trades of a window by how each one's dollar price was set (shared/flow-rules.ts priceHowOf). */
export interface PriceBasisCounts { execution: number; pool_1h: number; spot: number; swap_1h: number; unstated: number }
export interface BridgeRow { kind: string; n: number; nam: number | null; largest: number | null; late: number | null }
export interface IbcFlowRow { id: string; ts: number; from_addr: string | null; to_addr: string | null; amount_num: number; meta: string | null }
export interface MaspRow { kind: string; n: number; nam: number | null; fee_nam?: number | null }
export interface FeeRow { n: number; fee_nam: number | null }
export interface ProposalRow {
  id: number; status: string | null; type: string | null; startEpoch: number | null; endEpoch: number | null; title: string | null;
  discussionsUrl: string | null; fetchedAt: number | null; indexerEpoch: number | null;
}
export interface ClaimRow { key: string; updated_at: number }
export interface VdDayRow { day: string; validators: number; stake: number | null; delegators: number | null; as_of: number | null; height: number | null; names_at: number | null }
export interface VdMoveRow { validator: string; name: string | null; state: string | null; s_today: number; s_yday: number | null; d: number; d_today: number | null; d_yday: number | null }
export interface VdSetsRow { joined: number; left_: number; gross: number | null }
export interface VdStateRow { validator: string; name: string | null; s_from: string | null; s_to: string | null }
/** The depth store's newest hourly row of the aggregate: the hour, the read behind it and the two figures (NULL with the reason in note when not filled). */
export interface DepthHourRow { hour: number; at: number; height: number | null; sell_10k: number | null; bid_10: number | null; n: number; note: string | null }
/** The window's hourly rows of the aggregate: the lowest and highest of the hours' own extremes, and how many hours had a row. */
/** n is the count of hours the lowest and highest were taken over (rows with a figure); stored counts every row of the window. */
export interface DepthDayRow { lo: number | null; hi: number | null; n: number; stored: number }

/** Every statement's answer, by name; the pure shapers read only this. */
export interface DigestReads {
  anchors: Answer<KvRow>;
  /** latest(key, t), keyed `${key}@${t}` */
  instants: Record<string, Answer<MetricRow>>;
  /** the reading at exactly t, keyed the same way */
  exact: Record<string, Answer<MetricRow>>;
  /** the series' first row, by key, read only when a base was missing */
  firstTs: Record<string, Answer<{ first_ts: number | null }>>;
  /** listings rows by their time */
  listings: Record<string, Answer<ListingRow>>;
  epochAnchor: Answer<{ started: number | null }>;
  epochBefore: Answer<{ before_ts: number; before_value: number }>;
  posByKind: Answer<PosKindRow>;
  largest: { bond: Answer<LargestRow>; unbond: Answer<LargestRow> };
  ties: { bond: Answer<TieRow>; unbond: Answer<TieRow> };
  withdrawnBetween: Answer<SumRow>;
  queueMatured: Answer<SumRow>;
  queueRange: Answer<QueueRow>;
  queueNext: Answer<QueueRow>;
  queueFirst: Answer<{ e: number | null }>;
  trusted: Answer<TrustedRow>;
  trades: Answer<TradesRow>;
  bridge: Answer<BridgeRow>;
  refunds: Answer<IbcFlowRow>;
  /** null when no refund fell in the window (the read is then not needed) */
  bridgeOuts: Answer<IbcFlowRow> | null;
  maspIn: Answer<MaspRow>;
  maspOut: Answer<MaspRow>;
  maspFees: Answer<FeeRow>;
  proposals: Answer<ProposalRow>;
  govClaims: Answer<ClaimRow>;
  vdDays: Answer<VdDayRow>;
  vdMoves: Answer<VdMoveRow>;
  vdSets: Answer<VdSetsRow>;
  vdStates: Answer<VdStateRow>;
  depthHour: Answer<DepthHourRow>;
  depthDay: Answer<DepthDayRow>;
  /** the two days compared, decided while reading; null when validator_daily could not be read */
  vdCompared: { day: string; baseDay: string; noListingToday: boolean; baseIsOldest: boolean } | null;
}

export const instantKey = (key: string, t: number) => `${key}@${t}`;

// ------------------------------------------------------------------------------------------------- figure shapes

/** A window counted only to the index's position: the rows counted are real, moves since are not counted. */
export interface PartialWindow { countedTo: number; height: number | null }

export interface NamadaIndex { cursor: { height: number; at: number } | null; head: number | null; lag: number; behind: boolean; partial: PartialWindow | null; stamp: Stamp }
export interface OsmosisIndex { streaming: boolean; live: { connected: boolean; at: number; height: number | null } | null; sweep: { height: number; at: number } | null; behind: boolean; partial: PartialWindow | null; stamp: Stamp }
export interface ListingState { at: number; completeAt: number | null; height: number | null; provider: string | null; epoch: number | null; failedAt: number | null; error: string | null; live: boolean }

export interface Anchors {
  epoch: EpochClock;
  epochReading: Figure<MetricRow>;
  namada: NamadaIndex;
  osmosis: OsmosisIndex;
  bondListing: ListingState | null;
  balanceListing: ListingState | null;
  params: (ChainParams & { fetchedAt?: number }) | null;
  paramsLive: boolean;
  mintedSupply: Figure<MetricFigure>;
}

export interface Staked {
  totalStake: Figure<MetricFigure>;
  /** the PoS account's balance: staked + unstaking + withdrawable + unclaimed rewards; never "bonded" */
  account: Figure<MetricFigure>;
  /** account − total stake when both are live: arithmetic on two marked figures */
  onItsWayOutOrUnclaimed: number | null;
  stakers: Figure<MetricFigure>;
  validators: Figure<{ value: number; at: number }>;
}

export interface Largest { amount: number; ts: number; height: number; txHash: string; explorerHash: string; validator: string | null; ties: number; validators: number }
export interface RequestKind {
  n: number; nam: number;
  /** the largest request's amount, from the window's GROUP BY (known even when the row read below failed) */
  largestNam: number | null;
  /** the earliest request of that size, with how many share it */
  largest: Largest | null;
  late: number; firstTs: number | null; lastTs: number | null;
}
export interface Requests { bonds: RequestKind; unbonds: RequestKind; decodeFailures: number; partial: PartialWindow | null }

export interface Bucket { epoch: number; nam: number; n: number; at: number | null; epochsAway: number }
export interface Matured {
  nam: number;
  /** the epochs that matured between the two listings, (epoch at the base listing, epoch at the current one]; null when an epoch reading is missing */
  epochs: [number, number] | null;
  base: { at: number; withdrawable: number }; withdrawnBetween: { nam: number; n: number };
  /** the queue's own sum over those epochs; the line adds it when it differs from the identity by more than 1 NAM */
  direct: { nam: number; n: number } | null; differs: boolean;
}
export interface Pipeline {
  listing: { at: number; height: number | null; provider: string | null; epoch: number | null };
  inFlight: number;
  withdrawable: number;
  withdrawableEpochs: [number | null, number | null];
  /** without a base listing: why, the queue's direct sum over the epochs since the base instant (withdrawals since not
   *  counted), and those epochs when the epoch at the base instant was read */
  matured: Matured | { notComputed: string; direct: { nam: number; n: number } | null; epochs?: [number, number] | null };
  withdrawn: { n: number; nam: number; largest: number | null; lastTs: number | null } | null;
  unlocking: Figure<{ epochs: [number, number] | null; approx: boolean; buckets: Bucket[]; nam: number; n: number; next: Bucket | null }>;
}

export interface Rewards { n: number; nam: number; largest: number | null; late: number; partial: PartialWindow | null }

export interface Executed {
  last: { hourStart: number; price: number; n: number | null } | null;
  status: 'compared' | 'no-comparison' | 'none-in-24h' | 'none';
  /** quote / executed − 1 (negative: the quote is under the executed price), with the price_vs_execution check's bands */
  comparison: { pct: number; band: 'ok' | 'warn' | 'fail' } | null;
  vwap: { n: number; vwap: number; lo: number; hi: number; lastTs: number | null } | null;
}
export interface Price { quote: Figure<MetricFigure & { longChange: Change | null }>; executed: Figure<Executed> }

export interface Trades {
  n: number; nam: number; usd: number | null; unpriced: number; traders: number; buyNam: number; sellNam: number; lastTs: number | null;
  /** the priced trades by how each price was set, so the dollar sum names its bases; null when the answer did not carry them */
  basis: PriceBasisCounts | null;
  /** the window held more than DIGEST_TRADES_MAX trades; the figures count the newest rows read */
  more: boolean;
  apiVolumeUsd: Figure<{ value: number; at: number }>;
  partial: PartialWindow | null;
}

export interface BridgeLeg { n: number; nam: number; largest: number | null }
export interface Bridge {
  /** Osmosis ibc_in: NAM arriving on Osmosis */
  toOsmosis: BridgeLeg;
  /** Osmosis ibc_out: NAM leaving Osmosis for Namada, timed-out sends refunded in the window left out */
  toNamada: BridgeLeg;
  refunded: { n: number; nam: number };
  netToNamada: number;
  late: number;
  escrow: Figure<MetricFigure & { matches: boolean | null; differsBy: number | null }>;
  partial: PartialWindow | null;
}

export interface Masp {
  in: { shield: { n: number; nam: number }; ibcIn: { n: number; nam: number }; total: number };
  out: { unshield: { n: number; nam: number }; ibcOut: { n: number; nam: number }; feesNam: number; total: number };
  net: number;
  balance: Figure<MetricFigure & { matches: boolean | null; differsBy: number | null }>;
  partial: PartialWindow | null;
}

export interface Top10 { nam: number; at: number; share: number | null; denominator: Figure<MetricFigure>; yesterday: { share: number; at: number } | null }
export interface Holders {
  namada: Figure<MetricFigure & { listing: { height: number; provider: string } | null }>;
  osmosis: Figure<MetricFigure & { notCurrent: { trustedStartedAt: number | null } | null }>;
  namadaTop10: Figure<Top10>;
  osmosisTop10: Figure<Top10>;
  stakeTop10Pct: Figure<MetricFigure>;
}

export interface Proposal { id: number; status: string | null; type: string | null; startEpoch: number | null; endEpoch: number | null; title: string; link: string }
export interface GovEvent { id: number; status: string; at: number; proposal: Proposal | null }
export interface Governance {
  fetchedAt: number; indexerEpoch: number | null; proposals: Proposal[];
  opened: GovEvent[]; closed: GovEvent[];
  ending: (Proposal & { at: number | null; epochsAway: number })[]; endingEpochs: [number, number] | null; approx: boolean;
  /** the list is page 1 only (20 newest): a proposal older than the 20th that changes state is not seen */
  pageOneOnly: boolean;
}

export interface ValidatorMove { validator: string; name: string | null; state: string | null; stake: number; stakeBefore: number | null; delta: number; delegators: number | null; delegatorsBefore: number | null }
export interface Validators {
  day: string; baseDay: string; dayRow: VdDayRow; baseRow: VdDayRow;
  joined: number; left: number; stateChanges: { validator: string; name: string | null; from: string | null; to: string | null }[];
  stakeDelta: number | null; gross: number | null; moves: ValidatorMove[];
  noListingToday: boolean; baseIsOldest: boolean;
}

/** One depth line: a figure of the newest closed hour with the hour it names and the read it came from. */
export interface DepthLine { usd: number; hour: number; at: number; height: number | null }
/** The two depth lines of the price-and-trades section (depth plan section 6): what selling the quotable size fetched
 *  across every pool at the newest closed hour, with the window's lowest and highest when the hours carry them, and the
 *  USD of bids within DEPTH_OFFSETS_PCT[OFFSET_10_INDEX] of the reference price. Each is its own figure: the hour's row
 *  can hold one and not the other (NULL with the reason in its note), and an hour not stored leaves both not read. */
export interface Depth {
  sizeNam: number;
  withinPct: number;
  /** window: the lowest and highest over `hours` hours with a figure of the `stored` rows the window holds */
  sell: Figure<DepthLine & { window: { lo: number; hi: number; hours: number; stored: number } | null }>;
  bids: Figure<DepthLine>;
}

export interface DigestFigures {
  kind: DigestKind;
  now: number;
  from: number;
  to: number;
  anchors: Anchors;
  staked: Figure<Staked>;
  requests: Figure<Requests>;
  pipeline: Figure<Pipeline>;
  rewards: Figure<Rewards>;
  price: Figure<Price>;
  trades: Figure<Trades>;
  bridge: Figure<Bridge>;
  masp: Figure<Masp>;
  holders: Figure<Holders>;
  governance: Figure<Governance>;
  validators: Figure<Validators>;
  depth: Figure<Depth>;
}

// ------------------------------------------------------------------------------------------------- the reads

/** Metrics keys read at T and at the base instant. */
const BOTH_INSTANTS = [
  'supply.total_stake', 'supply.pos_bonded', 'stake.stakers', 'stake.withdrawable_nam', 'price.usd', 'supply.ibc_escrow', 'supply.masp_shielded',
  'holders.namada', 'holders.osmosis', 'supply.total', 'supply.osmosis', 'stake.top10_pct',
] as const;
/** Metrics keys read at T only. */
const NOW_ONLY = ['stake.validators', 'stake.unbonding_nam', 'epoch', 'price.swap_1h'] as const;
/** The Osmosis data API's own volume figure for the variant's span. */
export const apiVolumeKey = (kind: DigestKind) => (kind === 'weekly' ? 'dex.volume_7d_usd_osmosis' : 'dex.volume_24h_usd_osmosis');
/** The shortest an epoch can be on mainnet (chain.params.minEpochSec): the anchor's lower bound when the parameters are missing. */
const MIN_EPOCH_MS = 6 * HOUR_MS;

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const kvParse = <T = any>(rows: KvRow[], key: string): T | null => {
  const r = rows.find((x) => x.key === key);
  if (!r) return null;
  try { return JSON.parse(r.value) as T; } catch { return null; }
};
const kvRaw = (rows: KvRow[], key: string): KvRow | null => rows.find((x) => x.key === key) ?? null;
const first = <T>(a: Answer<T>): T | null => (a.ok && a.rows.length ? a.rows[0] : null);
/** The epoch running at the base instant: the last reading at or before it, when taken within MINUTE_BOUND_MS of it. */
const epochAtBase = (a: Answer<MetricRow> | undefined, baseAt: number): MetricRow | null => {
  const row = a ? first(a) : null;
  return row && baseAt - row.ts <= MINUTE_BOUND_MS ? row : null;
};

/**
 * Reads every figure of the digest from D1 (nothing fetched) and shapes it. `log` receives every statement prepared
 * with its parameters, for the cost tests. Throws only when the header part (the kv anchors, the epoch at T) failed.
 */
export async function readDigestFigures(db: D1Database, now: number, kind: DigestKind, log?: Prepared[]): Promise<DigestFigures> {
  const win = digestWindow(now, kind);
  const reads = await collectDigestReads(db, win, log);
  return shapeDigestFigures(reads, win);
}

/** The three waves: anchors, instants and the window's flows; the dependent instants; the queue and the validator diff. */
export async function collectDigestReads(db: D1Database, win: DigestWindow, log?: Prepared[]): Promise<DigestReads> {
  const { now, from, to, baseAt, kind } = win;
  const today = utcDay(now);
  const baseDay = utcDay(kind === 'weekly' ? now - 7 * 24 * HOUR_MS : now - 24 * HOUR_MS);

  // ---- wave 1: the kv anchors, the metric instants, and every flows window that depends on nothing
  const w1 = new Wave(db, log);
  const anchors = w1.add<KvRow>(SQL.anchors, [...ANCHOR_KV_KEYS]);
  const inst: Record<string, Handle<MetricRow>> = {};
  const want = (key: string, t: number) => { inst[instantKey(key, t)] = w1.add<MetricRow>(SQL.latest, [key, t]); };
  for (const k of BOTH_INSTANTS) { want(k, now); want(k, baseAt); }
  for (const k of NOW_ONLY) want(k, now);
  want(apiVolumeKey(kind), now);
  want('holders.namada.top10_nam', baseAt);
  want('holders.osmosis.top10_nam', baseAt);
  if (win.priceLongBaseAt != null) want('price.usd', win.priceLongBaseAt);
  const posByKind = w1.add<PosKindRow>(SQL.posByKind, [from, to]);
  const largestBond = w1.add<LargestRow>(SQL.posLargest, ['bond', from, to]);
  const largestUnbond = w1.add<LargestRow>(SQL.posLargest, ['unbond', from, to]);
  const tieBond = w1.add<TieRow>(SQL.posLargestTie, ['bond', from, to]);
  const tieUnbond = w1.add<TieRow>(SQL.posLargestTie, ['unbond', from, to]);
  const queueFirst = w1.add<{ e: number | null }>(SQL.queueFirst, []);
  const trusted = w1.add<TrustedRow>(SQL.trusted, [from, to]);
  const trades = w1.add<TradesRow>(SQL.trades, [from, to]);
  const bridge = w1.add<BridgeRow>(SQL.bridge, [from, to]);
  const refunds = w1.add<IbcFlowRow>(SQL.refunds, [from, to + 3 * 24 * HOUR_MS]);
  const maspIn = w1.add<MaspRow>(SQL.maspIn, [MASP_ADDRESS, from, to]);
  const maspOut = w1.add<MaspRow>(SQL.maspOut, [MASP_ADDRESS, from, to]);
  const maspFees = w1.add<FeeRow>(SQL.maspOtherCoinFees, [MASP_ADDRESS, from, to]);
  const proposals = w1.add<ProposalRow>(SQL.proposals, []);
  const govClaims = w1.add<ClaimRow>(SQL.govClaims, [from, to]);
  const vdDays = w1.add<VdDayRow>(SQL.vdDays, [today, baseDay]);
  const depthHour = w1.add<DepthHourRow>(SQL.depthHour, [AGGREGATE_POOL_ID, now]);
  const depthDay = w1.add<DepthDayRow>(SQL.depthDay, [AGGREGATE_POOL_ID, from, to]);
  await w1.run();

  // the header part: without the anchors or the epoch nothing is built this tick
  if (!anchors.answer.ok) throw new Error(`digest: the kv anchors could not be read (${anchors.answer.error})`);
  const epochNow = inst[instantKey('epoch', now)];
  if (!epochNow.answer.ok) throw new Error(`digest: the epoch could not be read (${epochNow.answer.error})`);

  const kvRows = anchors.answer.rows;
  const params = kvParse<ChainParams & { fetchedAt?: number }>(kvRows, 'chain.params');
  const paramsLive = !!params && params.fetchedAt != null && now - params.fetchedAt <= PARAMS_STALE_MS;
  const epochMs = paramsLive && params?.epochSec ? params.epochSec * 1000 : null;
  const eRow = first(epochNow.answer);
  const eLive = eRow && now - eRow.ts <= MINUTE_BOUND_MS ? eRow : null;

  // ---- wave 2: what depends on an instant
  const w2 = new Wave(db, log);
  const firstTs: Record<string, Handle<{ first_ts: number | null }>> = {};
  const baseKeys: [string, number][] = [...BOTH_INSTANTS.map((k) => [k, baseAt] as [string, number]), ['holders.namada.top10_nam', baseAt], ['holders.osmosis.top10_nam', baseAt]];
  if (win.priceLongBaseAt != null) baseKeys.push(['price.usd', win.priceLongBaseAt]);
  for (const [k, t] of baseKeys) {
    const a = inst[instantKey(k, t)].answer;
    if (a.ok && a.rows.length === 0 && !firstTs[k]) firstTs[k] = w2.add(SQL.firstTs, [k]);
  }
  const listingAts = new Set<number>();
  for (const k of ['stake.withdrawable_nam', 'holders.namada'] as const) {
    for (const t of [now, baseAt]) { const r = first(inst[instantKey(k, t)].answer); if (r) listingAts.add(r.ts); }
  }
  const listings: Record<string, Handle<ListingRow>> = {};
  for (const at of listingAts) listings[String(at)] = w2.add<ListingRow>(SQL.listingAt, [at]);
  const anchorRange = [now - 2 * (epochMs ?? MIN_EPOCH_MS), now];
  const epochAnchor = eLive ? w2.add<{ started: number | null }>(SQL.epochAnchor, [...anchorRange, eLive.value]) : null;
  const epochBefore = eLive ? w2.add<{ before_ts: number; before_value: number }>(SQL.epochBefore, [...anchorRange, eLive.value]) : null;
  const lNow = first(inst[instantKey('stake.withdrawable_nam', now)].answer);
  const l24 = first(inst[instantKey('stake.withdrawable_nam', baseAt)].answer);
  const exact: Record<string, Handle<MetricRow>> = {};
  if (lNow) inst[instantKey('epoch', lNow.ts)] = w2.add<MetricRow>(SQL.latest, ['epoch', lNow.ts]);
  if (l24 && (!lNow || l24.ts !== lNow.ts)) inst[instantKey('epoch', l24.ts)] = w2.add<MetricRow>(SQL.latest, ['epoch', l24.ts]);
  // Without a bond listing near the base instant, the epoch then still bounds the unbonds that matured since (the
  // queue's direct sum over those epochs, withdrawals since not counted).
  const baseListingNear = !!l24 && baseAt - l24.ts <= BASE_WINDOW_MS;
  if (!baseListingNear && !inst[instantKey('epoch', baseAt)]) inst[instantKey('epoch', baseAt)] = w2.add<MetricRow>(SQL.latest, ['epoch', baseAt]);
  const withdrawnBetween = lNow && l24 ? w2.add<SumRow>(SQL.withdrawnBetween, [l24.ts, lNow.ts]) : null;
  const hRow = first(inst[instantKey('price.swap_1h', now)].answer);
  if (hRow) exact[instantKey('price.swap_1h.n', hRow.ts)] = w2.add<MetricRow>(SQL.at, ['price.swap_1h.n', hRow.ts]);
  const bridgeOuts = refunds.answer.ok && refunds.answer.rows.length ? w2.add<IbcFlowRow>(SQL.bridgeOuts, [from, to]) : null;
  // the validator days: today's rows may not exist yet (the first listing lands about 00:10–00:30 UTC), the weekly's base day may be before the table starts
  let vdCompared: DigestReads['vdCompared'] = null;
  let vdFallback: Handle<{ day: string | null }> | null = null;
  if (vdDays.answer.ok) {
    const days = vdDays.answer.rows.map((r) => r.day);
    const hasToday = days.includes(today), hasBase = days.includes(baseDay);
    if (hasToday && hasBase) vdCompared = { day: today, baseDay, noListingToday: false, baseIsOldest: false };
    else if (!hasToday) vdFallback = w2.add<{ day: string | null }>(SQL.vdNewestDays, []);
    else vdFallback = w2.add<{ day: string | null }>(SQL.vdOldestDay, []);
  }
  const vdEarly = vdCompared ? { moves: w2.add<VdMoveRow>(SQL.vdMoves, [vdCompared.baseDay, vdCompared.day]), sets: w2.add<VdSetsRow>(SQL.vdSets, [vdCompared.day, vdCompared.baseDay]), states: w2.add<VdStateRow>(SQL.vdStates, [vdCompared.baseDay, vdCompared.day]) } : null;
  await w2.run();

  // ---- wave 3: the queue by the clock, the matured epochs, a deferred validator diff
  const w3 = new Wave(db, log);
  const started = epochAnchor && epochAnchor.answer.ok ? first(epochAnchor.answer)?.started ?? null : null;
  const beforeRow = epochBefore && epochBefore.answer.ok ? first(epochBefore.answer) : null;
  const clock = epochClock(now, eLive?.value ?? null, eLive?.ts ?? null, started, beforeRow ? { ts: beforeRow.before_ts, value: beforeRow.before_value } : null, params, paramsLive);
  const eEnd = epochEnd(clock, win.horizonMs);
  const queueRange = eLive && eEnd != null ? w3.add<QueueRow>(SQL.queueRange, [eLive.value, eEnd]) : null;
  const queueNext = eLive ? w3.add<QueueRow>(SQL.queueNext, [eEnd ?? eLive.value]) : null;
  const eAtLNow = lNow ? first(inst[instantKey('epoch', lNow.ts)].answer) : null;
  const eAtL24 = baseListingNear && l24 ? first(inst[instantKey('epoch', l24.ts)].answer) : epochAtBase(inst[instantKey('epoch', baseAt)]?.answer, baseAt);
  const queueMatured = eAtLNow && eAtL24 ? w3.add<SumRow>(SQL.queueSum, [eAtL24.value, eAtLNow.value]) : null;
  let vdLate: typeof vdEarly = null;
  let vdDaysLate: Handle<VdDayRow> | null = null;
  if (vdFallback && vdFallback.answer.ok) {
    const days = vdFallback.answer.rows.map((r) => r.day).filter((d): d is string => !!d);
    const known = vdDays.answer.ok ? vdDays.answer.rows.map((r) => r.day) : [];
    if (!known.includes(today) && days.length >= 2) vdCompared = { day: days[0], baseDay: days[1], noListingToday: true, baseIsOldest: false };
    else if (known.includes(today) && days.length === 1 && days[0] < today) vdCompared = { day: today, baseDay: days[0], noListingToday: false, baseIsOldest: true };
    if (vdCompared) {
      const need = [vdCompared.day, vdCompared.baseDay].filter((d) => !known.includes(d));
      vdLate = { moves: w3.add<VdMoveRow>(SQL.vdMoves, [vdCompared.baseDay, vdCompared.day]), sets: w3.add<VdSetsRow>(SQL.vdSets, [vdCompared.day, vdCompared.baseDay]), states: w3.add<VdStateRow>(SQL.vdStates, [vdCompared.baseDay, vdCompared.day]) };
      if (need.length) vdDaysLate = w3.add<VdDayRow>(SQL.vdDays, [vdCompared.day, vdCompared.baseDay]);
    }
  }
  await w3.run();

  const vd = vdEarly ?? vdLate;
  const ans = <T>(h: Handle<T> | null | undefined, why = 'not run'): Answer<T> => (h ? h.answer : { ok: false, error: why });
  return {
    anchors: anchors.answer,
    instants: Object.fromEntries(Object.entries(inst).map(([k, h]) => [k, h.answer])),
    exact: Object.fromEntries(Object.entries(exact).map(([k, h]) => [k, h.answer])),
    firstTs: Object.fromEntries(Object.entries(firstTs).map(([k, h]) => [k, h.answer])),
    listings: Object.fromEntries(Object.entries(listings).map(([k, h]) => [k, h.answer])),
    epochAnchor: ans(epochAnchor, 'the epoch at T is not live'),
    epochBefore: ans(epochBefore, 'the epoch at T is not live'),
    posByKind: posByKind.answer,
    largest: { bond: largestBond.answer, unbond: largestUnbond.answer },
    ties: { bond: tieBond.answer, unbond: tieUnbond.answer },
    withdrawnBetween: ans(withdrawnBetween, 'a listing is missing'),
    queueMatured: ans(queueMatured, 'a listing epoch is missing'),
    queueRange: ans(queueRange, 'the epoch clock is not known'),
    queueNext: ans(queueNext, 'the epoch at T is not live'),
    queueFirst: queueFirst.answer,
    trusted: trusted.answer,
    trades: trades.answer,
    bridge: bridge.answer,
    refunds: refunds.answer,
    bridgeOuts: bridgeOuts ? bridgeOuts.answer : null,
    maspIn: maspIn.answer,
    maspOut: maspOut.answer,
    maspFees: maspFees.answer,
    proposals: proposals.answer,
    govClaims: govClaims.answer,
    vdDays: vdDaysLate ? vdDaysLate.answer : vdDays.answer,
    vdMoves: ans(vd?.moves, 'no snapshot days'),
    vdSets: ans(vd?.sets, 'no snapshot days'),
    vdStates: ans(vd?.states, 'no snapshot days'),
    depthHour: depthHour.answer,
    depthDay: depthDay.answer,
    vdCompared,
  };
}

// ------------------------------------------------------------------------------------------------- the shapes

/** A section's figure from its shaper; a failed statement is its NotRead, any other fault is said in words, never a 0. */
function section<T>(source: string, fn: () => Figure<T>): Figure<T> {
  try { return fn(); } catch (e) {
    if (e instanceof ReadFailed) return notRead(source, null, DB_NOT_ANSWERED);
    return notRead(source, null, `this figure could not be computed (${String((e as Error)?.message ?? e).slice(0, 120)})`);
  }
}

const inst = (r: DigestReads, key: string, t: number, source: string): MetricRow | null => firstRow(rowsOf(r.instants[instantKey(key, t)], source));
const firstTsOf = (r: DigestReads, key: string): number | null | undefined => {
  const a = r.firstTs[key];
  if (!a) return undefined;
  return a.ok ? a.rows[0]?.first_ts ?? null : undefined;
};
const metric = (r: DigestReads, win: DigestWindow, source: string, key: string, baseAt = win.baseAt): Figure<MetricFigure> =>
  metricFigure(source, key, inst(r, key, win.now, source), inst(r, key, baseAt, source), firstTsOf(r, key), win.now, baseAt);

/** Shapes the collected answers into the figures (pure; the tests feed it the stored answers of 2026-10-23). */
export function shapeDigestFigures(r: DigestReads, win: DigestWindow): DigestFigures {
  const anchors = shapeAnchors(r, win);
  return {
    kind: win.kind, now: win.now, from: win.from, to: win.to, anchors,
    staked: section(SOURCES.totalStake, () => shapeStaked(r, win)),
    requests: section(SOURCES.namadaScan, () => shapeRequests(r, win, anchors)),
    pipeline: section(SOURCES.bondListing, () => shapePipeline(r, win, anchors)),
    rewards: section(SOURCES.namadaScan, () => shapeRewards(r, anchors)),
    price: section(SOURCES.quote, () => shapePrice(r, win)),
    trades: section(SOURCES.osmosisIndex, () => shapeTrades(r, win, anchors)),
    bridge: section(SOURCES.osmosisIndex, () => shapeBridge(r, win, anchors)),
    masp: section(SOURCES.namadaScan, () => shapeMasp(r, win, anchors)),
    holders: section(SOURCES.balanceListing, () => shapeHolders(r, win, anchors)),
    governance: section(SOURCES.proposals, () => shapeGovernance(r, win, anchors)),
    validators: section(SOURCES.validatorDaily, () => shapeValidators(r, win)),
    depth: section(SOURCES.depthStore, () => shapeDepth(r, win)),
  };
}

// ---- 5.12 anchors: the epoch clock, the two indexes, the listings, the parameters, the minted supply

function listingState(v: any, raw: KvRow | null, now: number, boundMs: number): ListingState | null {
  if (!v || typeof v !== 'object') return null;
  const completeAt = Number.isFinite(v.completeAt) ? Number(v.completeAt) : null;
  const failedAt = Number.isFinite(v.failedAt) ? Number(v.failedAt) : null;
  // live: a complete pass within the bound, and no failure since it (a failure before a later complete pass is history)
  const live = completeAt != null && now - completeAt <= boundMs && !(failedAt != null && failedAt > completeAt);
  return {
    at: Number.isFinite(v.at) ? Number(v.at) : raw?.updated_at ?? 0, completeAt, height: Number.isFinite(v.height) ? Number(v.height) : null,
    provider: typeof v.provider === 'string' && v.provider ? v.provider : null, epoch: Number.isFinite(v.epoch) ? Number(v.epoch) : null,
    failedAt, error: typeof v.error === 'string' ? v.error : null, live,
  };
}

export function shapeAnchors(r: DigestReads, win: DigestWindow): Anchors {
  const { now } = win;
  const kv = rowsOf(r.anchors, 'kv anchors');
  const params = kvParse<ChainParams & { fetchedAt?: number }>(kv, 'chain.params');
  const paramsLive = !!params && params.fetchedAt != null && now - params.fetchedAt <= PARAMS_STALE_MS;
  const epochReading = readNow(SOURCES.epoch, inst(r, 'epoch', now, SOURCES.epoch), now, MINUTE_BOUND_MS);
  const eLive = isNotRead(epochReading) ? null : epochReading.value;
  const started = r.epochAnchor.ok ? r.epochAnchor.rows[0]?.started ?? null : null;
  const b = r.epochBefore.ok ? r.epochBefore.rows[0] ?? null : null;
  const epoch = epochClock(now, eLive?.value ?? null, eLive?.ts ?? null, started, b ? { ts: b.before_ts, value: b.before_value } : null, params, paramsLive);

  // the Namada scan's cursor (kv namada.cursor: the block as the value, the write time as updated_at) against the head
  const cur = kvRaw(kv, 'namada.cursor');
  const curH = Number(cur?.value);
  const cursor = cur && Number.isFinite(curH) && curH > 0 ? { height: curH, at: cur.updated_at } : null;
  const head = kvParse<{ height?: number }>(kv, 'namada.head');
  const headH = head && Number.isFinite(head.height) ? Number(head.height) : null;
  const lag = cursor && headH != null && headH > cursor.height ? headH - cursor.height : 0;
  const nBehind = !!cursor && (now - cursor.at > NAMADA_CURSOR_STALE_MS || lag > NAMADA_CURSOR_MAX_LAG);
  const namada: NamadaIndex = {
    cursor, head: headH, lag, behind: nBehind,
    partial: nBehind && cursor ? { countedTo: cursor.at, height: cursor.height } : null,
    stamp: cursor
      ? { source: SOURCES.namadaScan, at: cursor.at, height: cursor.height, status: nBehind ? 'stale' : 'live', ...(nBehind ? { note: `read to block ${cursor.height} at ${fmtClock(cursor.at)}; moves since are not counted` } : {}) }
      : { source: SOURCES.namadaScan, at: now, status: 'stale', note: 'the scan has not reported a position' },
  };

  // the Osmosis stream, else the last catch-up search
  const liveRaw = kvRaw(kv, 'osmosis.live');
  const liveV = kvParse<{ connected?: boolean; height?: number }>(kv, 'osmosis.live');
  const live = liveRaw && liveV ? { connected: !!liveV.connected, at: liveRaw.updated_at, height: Number.isFinite(liveV.height) ? Number(liveV.height) : null } : null;
  const sweepV = kvParse<{ height?: number; at?: number }>(kv, 'osmosis.cursor');
  const sweep = sweepV && Number(sweepV.height) > 0 && Number(sweepV.at) > 0 ? { height: Number(sweepV.height), at: Number(sweepV.at) } : null;
  const streaming = !!live && live.connected && now - live.at <= OSMOSIS_LIVE_STALE_MS;
  const oBehind = !streaming && (!sweep || now - sweep.at > OSMOSIS_SWEEP_STALE_MS);
  const osmosis: OsmosisIndex = {
    streaming, live, sweep, behind: oBehind,
    partial: oBehind && sweep ? { countedTo: sweep.at, height: sweep.height } : oBehind && live ? { countedTo: live.at, height: live.height } : null,
    stamp: streaming
      ? { source: SOURCES.osmosisIndex, at: live!.at, height: live!.height ?? sweep?.height ?? null, status: 'live' }
      : sweep
        ? { source: SOURCES.osmosisIndex, at: sweep.at, height: sweep.height, status: oBehind ? 'stale' : 'live', ...(oBehind ? { note: `swept to height ${sweep.height} at ${fmtClock(sweep.at)}; moves since are not counted` } : {}) }
        : { source: SOURCES.osmosisIndex, at: live?.at ?? now, status: 'stale', note: 'the Osmosis index has not reported a position' },
  };

  return {
    epoch, epochReading, namada, osmosis,
    bondListing: listingState(kvParse(kv, 'bond.listing'), kvRaw(kv, 'bond.listing'), now, BOND_LISTING_BOUND_MS),
    balanceListing: listingState(kvParse(kv, 'balance.listing'), kvRaw(kv, 'balance.listing'), now, BALANCE_LISTING_BOUND_MS),
    params, paramsLive,
    mintedSupply: section(SOURCES.mintedSupply, () => metric(r, win, SOURCES.mintedSupply, 'supply.total')),
  };
}

// ---- 5.1 staked NAM

export function shapeStaked(r: DigestReads, win: DigestWindow): Figure<Staked> {
  const totalStake = metric(r, win, SOURCES.totalStake, 'supply.total_stake');
  const account = metric(r, win, SOURCES.posBalance, 'supply.pos_bonded');
  const stakers = metric(r, win, SOURCES.bondListing, 'stake.stakers');
  const v = readNow(SOURCES.bondListing, inst(r, 'stake.validators', win.now, SOURCES.bondListing), win.now, BOND_LISTING_BOUND_MS);
  const validators: Figure<{ value: number; at: number }> = isNotRead(v) ? v : { value: { value: v.value.value, at: v.value.ts }, stamp: v.stamp };
  const ts = valueOf(totalStake), ac = valueOf(account);
  const stamp: Stamp = isNotRead(totalStake) ? (isNotRead(account) ? { source: SOURCES.totalStake, at: win.now, status: 'stale', note: 'neither reading is live' } : account.stamp) : totalStake.stamp;
  return { value: { totalStake, account, onItsWayOutOrUnclaimed: ts && ac ? ac.value - ts.value : null, stakers, validators }, stamp };
}

// ---- 5.2 bond and unbond requests, 5.4 rewards

const kindRow = (rows: PosKindRow[], kind: string): PosKindRow | null => rows.find((x) => x.kind === kind) ?? null;

function requestKind(rows: PosKindRow[], kind: 'bond' | 'unbond', largest: Answer<LargestRow>, tie: Answer<TieRow>): RequestKind {
  const k = kindRow(rows, kind);
  const l = firstRow(rowsOf(largest, SOURCES.namadaScan));
  const t = firstRow(rowsOf(tie, SOURCES.namadaScan));
  return {
    n: k?.n ?? 0, nam: k?.nam ?? 0, largestNam: k?.largest ?? null, late: k?.late ?? 0, firstTs: k?.first_ts ?? null, lastTs: k?.last_ts ?? null,
    largest: l ? {
      amount: l.amount_num, ts: l.ts, height: l.height, txHash: l.tx_hash,
      explorerHash: explorerHashOf({ txHash: l.tx_hash, meta: l.wrapper ? { wrapper: l.wrapper } : null }),
      validator: l.validator, ties: t && t.amount_num === l.amount_num ? t.n : 1, validators: t && t.amount_num === l.amount_num ? t.validators : l.validator ? 1 : 0,
    } : null,
  };
}

function decodeFailuresIn(kv: KvRow[], from: number, to: number): number {
  let n = 0;
  for (const key of ['namada.bonds.live', 'namada.unbonds.live']) {
    const v = kvParse<{ failures?: { at?: number }[] }>(kv, key);
    for (const f of v?.failures ?? []) if (Number.isFinite(f?.at) && Number(f.at) >= from && Number(f.at) < to) n++;
  }
  return n;
}

export function shapeRequests(r: DigestReads, win: DigestWindow, a: Anchors): Figure<Requests> {
  const rows = rowsOf(r.posByKind, SOURCES.namadaScan);
  const kv = rowsOf(r.anchors, SOURCES.namadaScan);
  return {
    value: {
      bonds: requestKind(rows, 'bond', r.largest.bond, r.ties.bond),
      unbonds: requestKind(rows, 'unbond', r.largest.unbond, r.ties.unbond),
      decodeFailures: decodeFailuresIn(kv, win.from, win.to),
      partial: a.namada.partial,
    },
    stamp: a.namada.stamp,
  };
}

export function shapeRewards(r: DigestReads, a: Anchors): Figure<Rewards> {
  const k = kindRow(rowsOf(r.posByKind, SOURCES.namadaScan), 'rewards');
  return { value: { n: k?.n ?? 0, nam: k?.nam ?? 0, largest: k?.largest ?? null, late: k?.late ?? 0, partial: a.namada.partial }, stamp: a.namada.stamp };
}

// ---- 5.3 the unbonding pipeline

export function shapePipeline(r: DigestReads, win: DigestWindow, a: Anchors): Figure<Pipeline> {
  const src = SOURCES.bondListing;
  const bl = a.bondListing;
  if (!bl || !bl.live) {
    const last = bl?.completeAt ?? null;
    const why = bl?.error ? ` (${bl.error})` : bl?.failedAt && bl.completeAt && bl.failedAt > bl.completeAt ? ` (the listing failed at ${fmtClock(bl.failedAt)})` : '';
    return notRead(src, last, last == null ? `no complete bond listing on record${why}` : `not read since ${fmtClock(last)}${why}`);
  }
  const lNow = inst(r, 'stake.withdrawable_nam', win.now, src);
  const inFlightRow = inst(r, 'stake.unbonding_nam', win.now, src);
  if (!lNow || win.now - lNow.ts > BOND_LISTING_BOUND_MS) return notRead(src, lNow?.ts ?? null, staleReason(lNow?.ts ?? null, win.now));
  if (!inFlightRow || win.now - inFlightRow.ts > BOND_LISTING_BOUND_MS) return notRead(src, inFlightRow?.ts ?? null, staleReason(inFlightRow?.ts ?? null, win.now));
  const listingRow = firstRow(rowsOf(r.listings[String(lNow.ts)] ?? { ok: true, rows: [] }, src));
  const eAtLNow = firstRow(rowsOf(r.instants[instantKey('epoch', lNow.ts)], src));
  const listing = { at: lNow.ts, height: listingRow?.height ?? (bl.completeAt === lNow.ts ? bl.height : null), provider: listingRow?.provider ?? (bl.completeAt === lNow.ts ? bl.provider : null), epoch: eAtLNow?.value ?? null };

  // became withdrawable (settlement 7): W(L_now) − W(L_24) + withdrawn(L_24.ts, L_now.ts]; the queue's direct sum is the cross-check
  const l24 = inst(r, 'stake.withdrawable_nam', win.baseAt, src);
  const baseChange = l24 ? changeFrom(lNow, l24, win.baseAt, BOND_LISTING_BOUND_MS, firstTsOf(r, 'stake.withdrawable_nam')) : changeFrom(lNow, null, win.baseAt, BOND_LISTING_BOUND_MS, firstTsOf(r, 'stake.withdrawable_nam'));
  const direct = r.queueMatured.ok ? firstRow(r.queueMatured.rows) : null;
  const directSum = direct ? { nam: direct.nam ?? 0, n: direct.n ?? 0 } : null;
  let matured: Pipeline['matured'];
  if (baseChange.kind !== 'ok' || !l24) {
    const why = baseChange.kind === 'before-start'
      ? `no listing ${win.kind === 'weekly' ? '7 d' : '24 h'} ago: series starts ${baseChange.firstTs != null ? new Date(baseChange.firstTs).toISOString() : 'later'}`
      : `no listing between ${fmtClock((baseChange as { from: number }).from)} and ${fmtClock(win.baseAt)} UTC`;
    // the epoch running at the base instant, when read: the queue's direct sum covers (that epoch, the listing's]
    const eBase = epochAtBase(r.instants[instantKey('epoch', win.baseAt)], win.baseAt);
    matured = { notComputed: why, direct: directSum, epochs: eBase && eAtLNow ? [eBase.value + 1, eAtLNow.value] : null };
  } else {
    const wd = firstRow(rowsOf(r.withdrawnBetween, src));
    const eAtL24 = firstRow(rowsOf(r.instants[instantKey('epoch', l24.ts)], src));
    const withdrawnBetween = { nam: wd?.nam ?? 0, n: wd?.n ?? 0 };
    const nam = lNow.value - l24.value + withdrawnBetween.nam;
    matured = {
      nam, epochs: eAtL24 && eAtLNow ? [eAtL24.value + 1, eAtLNow.value] : null, base: { at: l24.ts, withdrawable: l24.value }, withdrawnBetween,
      direct: directSum, differs: directSum ? Math.abs(nam - directSum.nam) > 1 : false,
    };
  }

  const w = kindRow(rowsOf(r.posByKind, src), 'withdraw');
  const withdrawn = w ? { n: w.n, nam: w.nam ?? 0, largest: w.largest, lastTs: w.last_ts } : null;

  // unlocking ahead: the queue's buckets in (E_now, E_end] by the clock; the next bucket when the span is empty
  const c = a.epoch;
  let unlocking: Pipeline['unlocking'];
  if (c.eNow == null) unlocking = notRead(SOURCES.epoch, c.epochAt, staleReason(c.epochAt, win.now));
  else if (c.epochMs == null) {
    const next = firstRow(rowsOf(r.queueNext, src));
    unlocking = {
      value: { epochs: null, approx: true, buckets: [], nam: 0, n: 0, next: next ? { epoch: next.withdraw_epoch, nam: next.nam, n: next.n, at: null, epochsAway: next.withdraw_epoch - c.eNow } : null },
      stamp: { source: SOURCES.params, at: c.paramsAt ?? win.now, status: 'stale', note: c.paramsAt == null ? 'chain parameters not read: the epoch length is unknown, so no span in time can be given' : `chain parameters last read ${fmtClock(c.paramsAt)}: the epoch length is not trusted, so no span in time can be given` },
    };
  } else {
    const eEnd = epochEnd(c, win.horizonMs)!;
    const rows = rowsOf(r.queueRange, src);
    const buckets: Bucket[] = rows.map((q) => ({ epoch: q.withdraw_epoch, nam: q.nam, n: q.n, at: epochClockAt(c, q.withdraw_epoch), epochsAway: q.withdraw_epoch - c.eNow! }));
    const nx = firstRow(rowsOf(r.queueNext, src));
    const next = nx ? { epoch: nx.withdraw_epoch, nam: nx.nam, n: nx.n, at: epochClockAt(c, nx.withdraw_epoch), epochsAway: nx.withdraw_epoch - c.eNow } : null;
    unlocking = {
      value: { epochs: [c.eNow + 1, eEnd], approx: c.approx, buckets, nam: buckets.reduce((s, b) => s + b.nam, 0), n: buckets.reduce((s, b) => s + b.n, 0), next },
      stamp: { source: SOURCES.params, at: c.startedAt ?? c.epochAt ?? win.now, status: c.approx ? 'stale' : 'live', note: c.approx ? `the current epoch's start could not be read: epochs ahead are about ${Math.round(win.horizonMs / c.epochMs)} per ${win.kind === 'weekly' ? '7 d' : '24 h'}` : undefined },
    };
  }

  const qFirst = r.queueFirst.ok ? r.queueFirst.rows[0]?.e ?? null : null;
  return {
    value: {
      listing, inFlight: inFlightRow.value, withdrawable: lNow.value, withdrawableEpochs: [qFirst, listing.epoch], matured, withdrawn, unlocking,
    },
    stamp: { source: src, at: lNow.ts, height: listing.height, status: 'live', ...(listing.provider ? { note: listing.provider } : {}) },
  };
}

// ---- 5.5 price and trades

export function shapePrice(r: DigestReads, win: DigestWindow): Figure<Price> {
  const q = metric(r, win, SOURCES.quote, 'price.usd');
  let quote: Price['quote'];
  if (isNotRead(q)) quote = q;
  else {
    const longChange = win.priceLongBaseAt != null
      ? changeFrom({ ts: q.value.at, value: q.value.value }, inst(r, 'price.usd', win.priceLongBaseAt, SOURCES.quote), win.priceLongBaseAt, MINUTE_BOUND_MS, firstTsOf(r, 'price.usd'))
      : null;
    quote = { value: { ...q.value, longChange }, stamp: q.stamp };
  }
  const h = inst(r, 'price.swap_1h', win.now, SOURCES.tradeIndex);
  const tr = firstRow(rowsOf(r.trusted, SOURCES.tradeIndex));
  const vwap = tr && tr.n >= 2 && tr.vwap != null ? { n: tr.n, vwap: tr.vwap, lo: tr.lo ?? tr.vwap, hi: tr.hi ?? tr.vwap, lastTs: tr.last_ts } : null;
  let executed: Figure<Executed>;
  if (!h) executed = { value: { last: null, status: 'none', comparison: null, vwap }, stamp: { source: SOURCES.tradeIndex, at: win.now, status: 'stale', note: 'no trusted trade on record' } };
  else {
    const nRow = firstRow(rowsOf(r.exact[instantKey('price.swap_1h.n', h.ts)] ?? { ok: true, rows: [] }, SOURCES.tradeIndex));
    const age = win.now - h.ts;
    const qv = valueOf(quote);
    let comparison: Executed['comparison'] = null;
    let status: Executed['status'] = 'none-in-24h';
    if (age <= EXECUTED_COMPARE_MS && qv && h.value > 0) {
      const pct = qv.value / h.value - 1;
      comparison = { pct, band: Math.abs(pct) < 0.05 ? 'ok' : Math.abs(pct) < 0.15 ? 'warn' : 'fail' };
      status = 'compared';
    } else if (age <= EXECUTED_SHOW_MS) status = 'no-comparison';
    executed = { value: { last: { hourStart: h.ts, price: h.value, n: nRow?.value ?? null }, status, comparison, vwap }, stamp: { source: SOURCES.tradeIndex, at: h.ts, status: age <= HOURLY_BOUND_MS ? 'live' : 'stale' } };
  }
  const stamp: Stamp = isNotRead(quote) ? (isNotRead(executed) ? { source: SOURCES.quote, at: win.now, status: 'stale' } : executed.stamp) : quote.stamp;
  return { value: { quote, executed }, stamp };
}

export function shapeTrades(r: DigestReads, win: DigestWindow, a: Anchors): Figure<Trades> {
  const t = firstRow(rowsOf(r.trades, SOURCES.osmosisIndex));
  const key = apiVolumeKey(win.kind);
  const api = readNow(SOURCES.osmosisApi, inst(r, key, win.now, SOURCES.osmosisApi), win.now, boundOf(key));
  const apiVolumeUsd: Figure<{ value: number; at: number }> = isNotRead(api) ? api : { value: { value: api.value.value, at: api.value.ts }, stamp: api.stamp };
  return {
    value: {
      n: t?.n ?? 0, nam: t?.nam ?? 0, usd: t && t.n ? t.usd : null, unpriced: t?.unpriced ?? 0, traders: t?.traders ?? 0, buyNam: t?.buy_nam ?? 0, sellNam: t?.sell_nam ?? 0, lastTs: t?.last_ts ?? null,
      basis: t && t.how_execution == null ? null : { execution: t?.how_execution ?? 0, pool_1h: t?.how_pool_1h ?? 0, spot: t?.how_spot ?? 0, swap_1h: t?.how_swap_1h ?? 0, unstated: t?.how_unstated ?? 0 },
      more: (t?.n ?? 0) > DIGEST_TRADES_MAX, apiVolumeUsd, partial: a.osmosis.partial,
    },
    stamp: a.osmosis.stamp,
  };
}

// ---- the depth lines (depth plan section 6)

/** A stored hour's figure is shown while its last minute is within HOURLY_BOUND_MS of T, as the other hourly keys are. */
export const DEPTH_HOUR_NOT_STORED = "no hour of this site's depth store is on record yet";
export const depthFigureMissing = (note: string | null): string => `the hour's row carries no figure for it${note ? ` (${note})` : ''}`;

export function shapeDepth(r: DigestReads, win: DigestWindow): Figure<Depth> {
  const src = SOURCES.depthStore;
  const row = firstRow(rowsOf(r.depthHour, src));
  const sizeNam = DEPTH_QUOTABLE_SIZE, withinPct = DEPTH_OFFSETS_PCT[OFFSET_10_INDEX];
  if (!row) {
    const nr = notRead(src, null, DEPTH_HOUR_NOT_STORED);
    return { value: { sizeNam, withinPct, sell: nr, bids: nr }, stamp: { source: src, at: win.now, status: 'stale', note: DEPTH_HOUR_NOT_STORED } };
  }
  const stale = win.now - row.at > HOURLY_BOUND_MS;
  const line = (v: number | null): Figure<DepthLine> => {
    if (stale) return notRead(src, row.at, staleReason(row.at, win.now));
    if (v == null || !Number.isFinite(v)) return notRead(src, row.at, depthFigureMissing(row.note));
    return { value: { usd: v, hour: row.hour, at: row.at, height: row.height }, stamp: { source: src, at: row.at, height: row.height, status: 'live' } };
  };
  const sellLine = line(row.sell_10k);
  let sell: Depth['sell'];
  if (isNotRead(sellLine)) sell = sellLine;
  else {
    // the window's extremes come from the hours' own lowest and highest, counted over the hours that carry one (an
    // hour whose reference pool was not read has no figure and is among the stored rows only); a window whose rows
    // carry none has no range
    const dayAnswer = r.depthDay.ok ? firstRow(r.depthDay.rows) : null;
    const window = dayAnswer && dayAnswer.lo != null && dayAnswer.hi != null && Number.isFinite(dayAnswer.lo) && Number.isFinite(dayAnswer.hi) && dayAnswer.n > 0
      ? { lo: dayAnswer.lo, hi: dayAnswer.hi, hours: dayAnswer.n, stored: dayAnswer.stored } : null;
    sell = { value: { ...sellLine.value, window }, stamp: sellLine.stamp };
  }
  const bids = line(row.bid_10);
  const stamp: Stamp = isNotRead(sell) ? (isNotRead(bids) ? { source: src, at: row.at, height: row.height, status: 'stale', note: sell.reason } : bids.stamp) : sell.stamp;
  return { value: { sizeNam, withinPct, sell, bids }, stamp };
}

// ---- 5.6 the bridge

export function shapeBridge(r: DigestReads, win: DigestWindow, a: Anchors): Figure<Bridge> {
  const src = SOURCES.osmosisIndex;
  const rows = rowsOf(r.bridge, src);
  const leg = (kind: string): BridgeLeg => { const k = rows.find((x) => x.kind === kind); return { n: k?.n ?? 0, nam: k?.nam ?? 0, largest: k?.largest ?? null }; };
  const toOsmosis = leg('ibc_in');
  let toNamada = leg('ibc_out');
  const late = rows.reduce((s, x) => s + (x.late ?? 0), 0);
  // timed-out sends refunded in the window + 3 days are left out, as series.dayAggregates does
  const refundRows = rowsOf(r.refunds, src);
  let refunded = { n: 0, nam: 0 };
  if (refundRows.length && r.bridgeOuts) {
    const outs = rowsOf(r.bridgeOuts, src).filter((o) => o.ts >= win.from && o.ts < win.to).map(ibcRowOf);
    const gone = timedOutSends(outs, refundRows.map(ibcRowOf));
    const goneRows = outs.filter((o) => gone.has(o.id));
    refunded = { n: goneRows.length, nam: goneRows.reduce((s, o) => s + o.amount, 0) };
    if (goneRows.length) {
      const kept = outs.filter((o) => !gone.has(o.id));
      toNamada = { n: toNamada.n - goneRows.length, nam: toNamada.nam - refunded.nam, largest: kept.length ? Math.max(...kept.map((o) => o.amount)) : null };
    }
  }
  const netToNamada = toNamada.nam - toOsmosis.nam;
  const e = metric(r, win, SOURCES.escrow, 'supply.ibc_escrow');
  let escrow: Bridge['escrow'];
  if (isNotRead(e)) escrow = e;
  else {
    // the escrow holds the NAM on Osmosis: it falls by what came back to Namada
    const d = e.value.change.kind === 'ok' ? e.value.change.delta + netToNamada : null;
    escrow = { value: { ...e.value, matches: d == null ? null : Math.abs(d) <= 1, differsBy: d == null ? null : d }, stamp: e.stamp };
  }
  return { value: { toOsmosis, toNamada, refunded, netToNamada, late, escrow, partial: a.osmosis.partial }, stamp: a.osmosis.stamp };
}

// ---- 5.7 the shielded pool

export function shapeMasp(r: DigestReads, win: DigestWindow, a: Anchors): Figure<Masp> {
  const src = SOURCES.namadaScan;
  const ins = rowsOf(r.maspIn, src), outs = rowsOf(r.maspOut, src), fees = firstRow(rowsOf(r.maspFees, src));
  const pick = (rows: MaspRow[], kind: string) => { const k = rows.find((x) => x.kind === kind); return { n: k?.n ?? 0, nam: k?.nam ?? 0 }; };
  const shield = pick(ins, 'shield'), ibcIn = pick(ins, 'ibc_in'), unshield = pick(outs, 'unshield'), ibcOut = pick(outs, 'ibc_out');
  const feesNam = outs.reduce((s, x) => s + (x.fee_nam ?? 0), 0) + (fees?.fee_nam ?? 0);
  const inTotal = shield.nam + ibcIn.nam;
  const outTotal = unshield.nam + ibcOut.nam + feesNam;
  const net = inTotal - outTotal;
  const b = metric(r, win, SOURCES.maspBalance, 'supply.masp_shielded');
  let balance: Masp['balance'];
  if (isNotRead(b)) balance = b;
  else {
    const d = b.value.change.kind === 'ok' ? b.value.change.delta - net : null;
    balance = { value: { ...b.value, matches: d == null ? null : Math.abs(d) <= 1, differsBy: d }, stamp: b.stamp };
  }
  return { value: { in: { shield, ibcIn, total: inTotal }, out: { unshield, ibcOut, feesNam, total: outTotal }, net, balance, partial: a.namada.partial }, stamp: a.namada.stamp };
}

// ---- 5.8 holders

function healthRow(kv: KvRow[], name: string): { ok: boolean; at: number | null; note: string | null } | null {
  const h = kvParse<Record<string, { ok?: boolean; at?: number; note?: string }>>(kv, 'source.health');
  const v = h?.[name];
  return v ? { ok: !!v.ok, at: Number.isFinite(v.at) ? Number(v.at) : null, note: v.note ?? null } : null;
}

function top10(kv: KvRow[], chain: 'namada' | 'osmosis', denominator: Figure<MetricFigure>, denomBaseRow: MetricRow | null, yesterdayRow: MetricRow | null, now: number, source: string): Figure<Top10> {
  const hf = kvParse<any>(kv, 'holders.figures');
  const t = hf?.[chain]?.top10;
  const s = t && Number.isFinite(t.s) ? Number(t.s) : null, at = t && Number.isFinite(t.at) ? Number(t.at) : null;
  if (s == null || at == null) return notRead(source, at, at == null ? 'no top-10 sum on record' : staleReason(at, now));
  if (now - at > HOLDER_FIGURES_BOUND_MS) return notRead(source, at, staleReason(at, now));
  const den = valueOf(denominator);
  const yesterday = yesterdayRow && denomBaseRow && denomBaseRow.value > 0 && Math.abs(denomBaseRow.ts - yesterdayRow.ts) <= 3 * HOUR_MS ? { share: yesterdayRow.value / denomBaseRow.value, at: yesterdayRow.ts } : null;
  return { value: { nam: s, at, share: den && den.value > 0 ? s / den.value : null, denominator, yesterday }, stamp: { source, at, status: 'live' } };
}

export function shapeHolders(r: DigestReads, win: DigestWindow, a: Anchors): Figure<Holders> {
  const kv = rowsOf(r.anchors, SOURCES.balanceListing);
  const { now } = win;
  // Namada: one row per complete balance listing; the listing's own record and health row decide "not read" (R2: the old count is not printed)
  const hb = healthRow(kv, HEALTH_ROWS.balanceListing);
  const bl = a.balanceListing;
  let namada: Holders['namada'];
  const n = metric(r, win, SOURCES.balanceListing, 'holders.namada');
  if (isNotRead(n)) namada = n;
  else if ((bl && !bl.live) || (hb && !hb.ok)) {
    const last = bl?.completeAt ?? n.value.at;
    namada = notRead(SOURCES.balanceListing, last, `the balance listing last completed ${fmtClock(last)}${bl?.error ? ` (${bl.error})` : hb && !hb.ok && hb.note ? ` (${hb.note})` : ''}`);
  } else {
    const lr = firstRow(rowsOf(r.listings[String(n.value.at)] ?? { ok: true, rows: [] }, SOURCES.balanceListing));
    namada = { value: { ...n.value, listing: lr ? { height: lr.height, provider: lr.provider } : null }, stamp: { ...n.stamp, height: lr?.height ?? null, ...(lr ? { note: lr.provider } : {}) } };
  }
  // Osmosis: hourly at the pass's stamp; a trusted pass older than 6 h makes the count "not current"
  const o = metric(r, win, SOURCES.osmosisHolders, 'holders.osmosis');
  let osmosis: Holders['osmosis'];
  if (isNotRead(o)) osmosis = o;
  else {
    const trusted = osmosisTrustedStart(kvRaw(kv, 'osmosis.holders.pass')?.value);
    const notCurrent = trusted === undefined ? null : trusted == null || now - trusted > OSMOSIS_PASS_TRUST_MS ? { trustedStartedAt: trusted } : null;
    osmosis = { value: { ...o.value, notCurrent }, stamp: o.stamp };
  }
  const minted = a.mintedSupply;
  const onOsmosis = metric(r, win, SOURCES.osmosisSupply, 'supply.osmosis');
  const namadaTop10 = top10(kv, 'namada', minted, inst(r, 'supply.total', win.baseAt, SOURCES.holderIndex), inst(r, 'holders.namada.top10_nam', win.baseAt, SOURCES.holderIndex), now, SOURCES.holderIndex);
  const osmosisTop10 = top10(kv, 'osmosis', onOsmosis, inst(r, 'supply.osmosis', win.baseAt, SOURCES.osmosisHolderIndex), inst(r, 'holders.osmosis.top10_nam', win.baseAt, SOURCES.osmosisHolderIndex), now, SOURCES.osmosisHolderIndex);
  const stakeTop10Pct = metric(r, win, SOURCES.bondListing, 'stake.top10_pct');
  const stamp: Stamp = isNotRead(namada) ? (isNotRead(osmosis) ? { source: SOURCES.balanceListing, at: now, status: 'stale' } : osmosis.stamp) : namada.stamp;
  return { value: { namada, osmosis, namadaTop10, osmosisTop10, stakeTop10Pct }, stamp };
}

// ---- 5.9 governance

const CLOSED_STATUSES = new Set(['passed', 'rejected']);
const isClosedStatus = (s: string) => CLOSED_STATUSES.has(s) || s.startsWith('executed');

export function proposalLink(id: number, discussionsUrl: unknown): string {
  const own = safeHttpUrl(discussionsUrl);
  return own && own.length <= GOV_LINK_MAX ? own : `https://namada.valopers.com/proposals/${id}`;
}

export function shapeGovernance(r: DigestReads, win: DigestWindow, a: Anchors): Figure<Governance> {
  const src = SOURCES.proposals;
  const kv = rowsOf(r.anchors, src);
  const rows = rowsOf(r.proposals, src);
  const fetchedAt = rows[0]?.fetchedAt ?? (kvRaw(kv, 'intel.cache')?.updated_at ?? null);
  if (fetchedAt == null) return notRead(src, null, 'no proposal list on record');
  const hi = healthRow(kv, HEALTH_ROWS.indexer);
  if (win.now - fetchedAt > INTEL_STALE_MS || (hi && !hi.ok)) return notRead(src, fetchedAt, `not read since ${fmtClock(fetchedAt)}${hi && !hi.ok && hi.note ? ` (${hi.note})` : ''}`);
  const proposals: Proposal[] = rows.map((p) => ({ id: Number(p.id), status: p.status, type: p.type, startEpoch: p.startEpoch, endEpoch: p.endEpoch, title: (p.title ?? '').slice(0, 80), link: proposalLink(Number(p.id), p.discussionsUrl) }));
  const byId = new Map(proposals.map((p) => [p.id, p]));
  const opened: GovEvent[] = [], closed: GovEvent[] = [];
  for (const c of rowsOf(r.govClaims, src)) {
    const m = /^alert:gov:prop:(\d+):(.+)$/.exec(c.key);
    if (!m) continue;
    const ev: GovEvent = { id: Number(m[1]), status: m[2], at: c.updated_at, proposal: byId.get(Number(m[1])) ?? null };
    // a proposal's first claim is written with its first status: 'pending' is a proposal first seen, 'voting' one opened for votes
    if (m[2] === 'voting' || m[2] === 'pending') opened.push(ev);
    else if (isClosedStatus(m[2])) closed.push(ev);
  }
  const c = a.epoch;
  const eEnd = epochEnd(c, win.horizonMs);
  const endingEpochs: [number, number] | null = c.eNow != null && eEnd != null ? [c.eNow + 1, eEnd] : null;
  const ending = endingEpochs
    ? proposals.filter((p) => p.status === 'voting' && p.endEpoch != null && p.endEpoch > c.eNow! && p.endEpoch <= endingEpochs[1])
      .map((p) => ({ ...p, at: epochClockAt(c, p.endEpoch!), epochsAway: p.endEpoch! - c.eNow! }))
    : [];
  return {
    value: { fetchedAt, indexerEpoch: rows[0]?.indexerEpoch ?? null, proposals, opened, closed, ending, endingEpochs, approx: c.approx, pageOneOnly: proposals.length >= 20 },
    stamp: { source: src, at: fetchedAt, status: 'live' },
  };
}

// ---- 5.10 validators

export function shapeValidators(r: DigestReads, win: DigestWindow): Figure<Validators> {
  const src = SOURCES.validatorDaily;
  const days = rowsOf(r.vdDays, src);
  if (!r.vdCompared) return notRead(src, days.reduce<number | null>((m, d) => (d.as_of != null && (m == null || d.as_of > m) ? d.as_of : m), null), days.length ? 'only one snapshot day exists' : 'no validator snapshot on record');
  const { day, baseDay } = r.vdCompared;
  const dayRow = days.find((d) => d.day === day), baseRow = days.find((d) => d.day === baseDay);
  if (!dayRow || !baseRow) return notRead(src, dayRow?.as_of ?? null, `the snapshot of ${!dayRow ? day : baseDay} has no rows`);
  const sets = firstRow(rowsOf(r.vdSets, src));
  const moves = rowsOf(r.vdMoves, src).map((m) => ({ validator: m.validator, name: m.name, state: m.state, stake: m.s_today, stakeBefore: m.s_yday, delta: m.d, delegators: m.d_today, delegatorsBefore: m.d_yday }));
  const stateChanges = rowsOf(r.vdStates, src).map((s) => ({ validator: s.validator, name: s.name, from: s.s_from, to: s.s_to }));
  return {
    value: {
      day, baseDay, dayRow, baseRow, joined: sets?.joined ?? 0, left: sets?.left_ ?? 0, stateChanges,
      stakeDelta: dayRow.stake != null && baseRow.stake != null ? dayRow.stake - baseRow.stake : null, gross: sets?.gross ?? null, moves,
      noListingToday: r.vdCompared.noListingToday, baseIsOldest: r.vdCompared.baseIsOldest,
    },
    stamp: { source: src, at: dayRow.as_of ?? win.now, height: dayRow.height, status: r.vdCompared.noListingToday ? 'stale' : 'live', ...(dayRow.names_at ? { note: `names by indexer.namada.net, read ${fmtClock(dayRow.names_at)}` } : {}) },
  };
}
