// The digest's "Trades worth attention" section (scratchpad/digest/attention-design.txt): the window's largest trades
// with the price each settled at and the quote's move after it, the NAM bridged Namada → Osmosis and not yet sold
// with the Supply page's selling estimate, and the unusual events the store can show without guessing (a first
// trade from a top-100 Osmosis holder, a trade over five times the day's median, a large matured unbond withdrawn,
// a large unshielding followed by a bridge-out). Everything is read from D1 with bound parameters and a LIMIT, each
// line's reads inside their own try, so a read that fails makes that line "not read" and never a missing line, a 0
// or an old value shown as fresh. The builder is a pure function of the figures, rendered at four measured levels
// (A0 the full section down to A3 the floor) so the digest's fit rule can take the level the message has room for.
//
// The wiring into the cron, the delivery path and the digest's own fit() comes with the digest module; this file
// exports plain functions over a D1Database, a fixed "now" and a figures object, so every piece is testable alone.
import type { ChainParams } from '../../../shared/types';
import { TRADE_FOLD_MS, TRADE_FOLD_UNDER_NAM } from '../../../shared/types';
import { SETTLE_STABLES, settleMetaOf, type Settle, type SettleMeta } from '../../../shared/settle';
import { DEFAULT_THRESHOLDS, isInternal } from '../../../shared/alerts';
import { SELLS_MOST_PCT } from '../../../shared/supply-thresholds';
import { label_plain, labelAuthorShort, tagByline } from '../../../shared/labels';
import { explorerHashOf } from '../../../shared/flow-rules';
import { NAM_AMOUNT, NOT_LEGACY_TWIN } from '../flows-query';
import { NOT_ARB, foldTrades, tradeRowOf } from '../series-api';
import { REFUNDS_SQL } from '../series-sql';
import {
  HOP_ORIGIN_MIN_NAM, HOP_ORIGIN_SHARE, HOP_ORIGIN_WINDOW_MS, OSMOSIS_LIVE_STALE_MS, OSMOSIS_SWEEP_STALE_MS, QUOTE_MATCH_MS,
  ibcRowOf, safeParseJson, settlePrices, timedOutSends, unbondingWait, withdrawEpochs,
} from '../analytics';
import { INTERNAL_LABELS } from '../config';
import { INTERNAL_ADDRS, notPool } from '../holders';
import {
  DIGEST_ATTN_AXIS_MIN_NAM, DIGEST_ATTN_PNG_GAP_MS, DIGEST_ATTN_PNG_RING_MAX, renderAttentionPng,
  type AttentionPicture, type PicturePoint, type PictureTrade,
} from './charts/attention';

// ---------------------------------------------------------------- constants (attention-design.txt section 8)

/** Trades shown at the full level; the levels below show 2 and 1. */
export const DIGEST_ATTN_TRADES = 3;
/** The largest trades read: the shown ones, the "Others" line and the first-trade rule's candidates. */
export const DIGEST_ATTN_TRADES_READ = 10;
/** Fewer trades than this give no median and no five-times rule. */
export const DIGEST_ATTN_MEDIAN_MIN = 5;
export const DIGEST_ATTN_MULT = 5;
export const DIGEST_ATTN_DECK = 5;
export const DIGEST_ATTN_DECK_READ = 10;
/** The window's trade rows read at most (the newest): the spec's DIGEST_TRADES_MAX. */
export const DIGEST_TRADES_MAX = 20_000;
/** The window's crossings read at most (the newest): the bridge check's bound. */
export const DIGEST_BRIDGE_MAX = 10_000;
export const DIGEST_ATTN_EVENTS = 5;
export const DIGEST_ATTN_MAKERS = 10;
export const DIGEST_ATTN_TOP = 100;
export const DIGEST_ATTN_FIRST_LOOKBACK_MS = 90 * 86_400_000;
export const DIGEST_ATTN_FOLLOW_MAX = 200;
export const DIGEST_ATTN_PRIOR_MAX = 1_000;
export const DIGEST_ATTN_COUNT_MAX = 1_000;
export const DIGEST_ATTN_QUOTE_AFTER_MS = [15 * 60_000, 60 * 60_000] as const;
/** A reading counts as "after 15 min" from here on (the minute key's own freshness bound), and "after 1 h" from 45 min. */
export const DIGEST_ATTN_QUOTE_AFTER_MIN_MS = [10 * 60_000, 45 * 60_000] as const;
export const DIGEST_ATTN_LEVELS = ['A0', 'A1', 'A2', 'A3'] as const;
/** The second message's own cap when the section travels alone (delivery option B). */
export const DIGEST_ATTN_MESSAGE_MAX = 5_800;
/** A Discord field value is at most this long. */
export const DISCORD_FIELD_MAX = 1_024;
/** The quote series read for the picture, the newest first: a minute series has at most 1,440 rows a day (10,080 a
 *  week), so the bound is never the window's own size; past it the newest are drawn and the words say so. */
export const DIGEST_ATTN_SERIES_MAX: Record<'daily' | 'weekly', number> = { daily: 2_000, weekly: 11_000 };
/** The newest quote reading must be this recent at the send time for the picture's line to be read (the minute key's bound). */
export const DIGEST_ATTN_QUOTE_BOUND_MS = 10 * 60_000;
/** The window's traders read for the first-trade rule (each with its largest trade of the window), the most active first. */
export const DIGEST_ATTN_MAKERS_READ = 1_000;
/** A chain.params row older than this gives no epoch clock (the spec's DIGEST_PARAMS_STALE_MS). */
export const DIGEST_PARAMS_STALE_MS = 24 * 3600_000;
/** An Osmosis holder pass whose trusted start is older than this is "not current" (the spec's 5.8 rule). */
export const DIGEST_ATTN_PASS_STALE_MS = 6 * 3600_000;
/** An epoch reading within this of an unbond request's time names its epoch exactly. */
export const DIGEST_ATTN_EPOCH_MATCH_MS = 10 * 60_000;
export const DIGEST_ATTN_COLOUR = 0xffff00;
export const SITE_ADDR_URL = 'https://namada.trade/?addr=';
export const DB_DID_NOT_ANSWER = 'the database did not answer this read';

export type DigestKind = 'daily' | 'weekly';
export type AttentionLevel = (typeof DIGEST_ATTN_LEVELS)[number];

const H = 3600_000;
const D = 24 * H;

// ---------------------------------------------------------------- figures

export interface NotRead { notRead: true; source: string; lastAt: number | null; reason: string }
export const notRead = (source: string, reason: string = DB_DID_NOT_ANSWER, lastAt: number | null = null): NotRead => ({ notRead: true, source, lastAt, reason });
export const isNotRead = (x: unknown): x is NotRead => !!x && typeof x === 'object' && (x as NotRead).notRead === true;

/** A label as the site prints it (shared/labels.ts label_plain), with the "Tag by …" byline of a wallet's tag. */
export interface LabelWords { plain: string; source: string | null; byline: string | null }

export interface QuoteMove {
  /** the reading at or before the trade, at most QUOTE_MATCH_MS before it */
  before: PicturePoint | null;
  /** the reading at or before t + 15 min, at or after t + 10 min */
  after15: PicturePoint | null;
  /** the reading at or before t + 60 min, at or after t + 45 min; 'not yet' when t + 60 min is after T */
  after60: PicturePoint | null | 'not yet';
  /** t + 15 min is after T: nothing past T is read */
  notYet15: boolean;
}

export interface MakerRecord {
  buys: number;
  sells: number;
  /** DIGEST_ATTN_COUNT_MAX was reached on one of the counts */
  bounded: boolean;
  /** a buy or a sale in the 90 days before the window */
  hadBefore: boolean;
  /** place among the DIGEST_ATTN_TOP largest Osmosis holders, 1-based; null when not among them */
  rank: number | null;
  /** the holders row's NAM, null without a row (the list keeps no zero balances) */
  balance: number | null;
}

export interface OwnPrice { usd: number; how: 'execution' | 'swap_1h' | 'spot' | 'unstated' }

/** The coin a trade's gas was paid in and where its rate came from: a dollar, the transaction's own swap, the stored minute quote, or none ('left out'). */
export interface GasWords { coin: string; rate: 'stable' | 'tx' | 'quote' | 'left out' }

/** A trade's price as the section prints it: its settle price with its gas words, else its own recorded price with its basis. */
export interface PricedTrade { settle: Settle | null; own: OwnPrice | null; gas: GasWords | null }

export interface TradeRead extends PricedTrade {
  id: string;
  ts: number;
  kind: 'buy' | 'sell';
  nam: number;
  /** 1-based place by NAM in the window */
  rank: number;
  maker: string | null;
  label: LabelWords | null;
  /** read for the shown trades only */
  move: QuoteMove | NotRead | null;
  record: MakerRecord | NotRead | null;
  route: string[];
  /** the maker is one of the deck's receivers */
  onDeck: boolean;
  txHash: string;
  explorerHash: string;
}

export interface TradesFigures {
  n: number;
  traders: number;
  nam: number;
  usd: number;
  unpriced: number;
  /** more than DIGEST_TRADES_MAX rows: the newest 20,000 counted and ranked */
  bounded: boolean;
  /** null under DIGEST_ATTN_MEDIAN_MIN trades */
  median: number | null;
  /** the DIGEST_ATTN_TRADES_READ largest, ranked */
  read: TradeRead[];
}

export interface DeckSale extends PricedTrade { ts: number; nam: number; settleNam: number | null }

export interface NamadaHolder { balance: number; stake: number; total: number; updatedAt: number | null; above: number }

export interface HopOrigin { address: string; label: LabelWords | null; nam: number }

export interface DeckFollow {
  sales: DeckSale[];
  salesBounded: boolean;
  soldSince: number;
  bridgedOutSince: number;
  soldCounted: number;
  sentBackCounted: number;
  remaining: number;
  /** the sales' settle records gave the whole crossing while the pools' NAM did not: "still there" is the pools' fee */
  feeNote: boolean;
  prior: { n: number; nam: number; bounded: boolean };
  /** pressure()'s dumpHazardScore on the 24 h figures, three decimals */
  hazard: number;
  holder: { balance: number; updatedAt: number | null } | null;
}

export interface DeckRow {
  address: string;
  label: LabelWords | null;
  bridgedIn: number;
  crossings: number;
  firstTs: number;
  lastTs: number;
  sender: { address: string; label: LabelWords | null; nam: number; holder: NamadaHolder | null | NotRead; hop: HopOrigin | null | NotRead } | null;
  follow: DeckFollow | NotRead;
}

export interface DeckFigures {
  crossings: number;
  nam: number;
  receivers: number;
  /** more than DIGEST_BRIDGE_MAX crossings: the newest 10,000 counted */
  bounded: boolean;
  /** the DIGEST_ATTN_DECK_READ largest receivers, by NAM in */
  rows: DeckRow[];
}

export interface RequestMatch { ts: number; nam: number; validator: string; exact: boolean }
export type Maturity =
  | { kind: 'exact'; epoch: number; at: number | null }
  | { kind: 'estimate'; at: number; epochs: number; epochSec: number }
  | { kind: 'none'; why: string };
export interface SinceMoves { restaked: number; bridgedOut: number; shielded: number; transferred: number; transferTo: string | null; transferTargets: number; bounded: boolean }
export interface ValidatorWords { address: string; name: string | null; state: string | null }

export type UnusualEvent =
  | { rule: 'first'; nam: number; ts: number; kind: 'buy' | 'sell'; address: string; label: LabelWords | null; rank: number; record: MakerRecord }
  /** one maker's trades on one side over the bar: how many, their NAM in all, the largest, the first and last time */
  | { rule: 'multiple'; nam: number; ts: number; lastTs: number; n: number; largest: number; kind: 'buy' | 'sell'; address: string | null; label: LabelWords | null; bar: number }
  | {
      rule: 'withdraw'; nam: number; ts: number; address: string; label: LabelWords | null; txHash: string; explorerHash: string;
      request: RequestMatch | null | NotRead; maturity: Maturity | null; since: SinceMoves | NotRead; holder: NamadaHolder | null | NotRead; validator: ValidatorWords | NotRead;
    }
  | { rule: 'unshield'; nam: number; ts: number; address: string; label: LabelWords | null; txHash: string; explorerHash: string; bridgeOut: { nam: number; ts: number } | null | NotRead };

export type UnusualRule = 'first' | 'multiple' | 'withdraw' | 'unshield';

export interface UnusualFigures {
  first: UnusualEvent[] | NotRead;
  multiple: UnusualEvent[] | NotRead;
  withdraw: UnusualEvent[] | NotRead;
  unshield: UnusualEvent[] | NotRead;
  /** the window's traders and how many are top-100 holders, for the "not found" words; `bounded` when more traders
   *  than DIGEST_ATTN_MAKERS_READ traded (the most active were checked) */
  traders: { total: number; top: number; bounded?: boolean } | null;
}

/** The current epoch's clock, from the digest's epoch anchor (spec 5.3): the wiring supplies it when it has one. */
export interface EpochClock { epoch: number; startedAt: number; epochSec: number }

export interface AttentionFigures {
  kind: DigestKind;
  now: number;
  from: number;
  to: number;
  /** the Osmosis index behind (stream down and the sweep stale): the lines count to this time only */
  indexBehind: { countedTo: number; height: number | null } | null;
  /** the Osmosis holder pass's trusted start, for the "not current" note; null when the kv row was not there */
  passTrustedAt: number | null;
  trades: TradesFigures | NotRead;
  deck: DeckFigures | NotRead;
  unusual: UnusualFigures;
  /** the quote readings of the window for the picture, oldest first */
  series: PicturePoint[] | NotRead;
  /** more readings than DIGEST_ATTN_SERIES_MAX: the newest are drawn */
  seriesBounded: boolean;
  /** the window's trades for the picture (the newest DIGEST_ATTN_PNG_RING_MAX + 1 at most), each at its settle price or its own price */
  pictureTrades: PictureTrade[] | NotRead;
  /** more than DIGEST_ATTN_PNG_RING_MAX trades: the newest are drawn, without rings */
  pictureBounded: boolean;
  params: ChainParams | null;
  clock: EpochClock | null;
}

// ---------------------------------------------------------------- statements

const tradeWindow = (limit: number) => `SELECT * FROM flows f INDEXED BY flows_kind
      WHERE f.kind IN ('buy','sell') AND f.chain = 'osmosis' AND f.ts >= ?1 AND f.ts < ?2 AND ${NOT_ARB}
      ORDER BY f.ts DESC LIMIT ${limit}`;
/** The trade's maker as the window's totals count a trader: the stored trader, else the buyer or the seller. */
const TRADER = "COALESCE(json_extract(f.meta, '$.trader'), CASE WHEN f.kind = 'buy' THEN f.to_addr ELSE f.from_addr END)";
/** The protocol accounts (holders.ts INTERNAL_ADDRS) are not holders, as pools are not (holders.ts notPool, by label):
 *  the ranks leave both out as the Holders page does. The pools are left out in SQL; the protocol accounts, a handful
 *  of the config's constants, are read past and taken out after the read, so no address is written into a statement. */
const INTERNAL_N = INTERNAL_ADDRS.length;
const isProtocol = (a: string | null | undefined): boolean => !!a && INTERNAL_ADDRS.includes(a);

/** Every statement the section prepares, exported so the cost test can read each one's plan. Parameters only; no value is ever interpolated. */
export const ATTENTION_SQL = {
  /** L1a: the ten largest and the median row(s) in one pass over the window's newest DIGEST_TRADES_MAX + 1 trades, with the makers' labels. */
  largest: `SELECT r.id, r.ts, r.height, r.tx_hash, r.kind, r.from_addr, r.to_addr, r.amount_num, r.counter_denom, r.counter_amount, r.pool_id, r.price_usd, r.value_usd, r.meta, r.rn, r.n,
       l.label, l.source AS label_source, l.author AS label_author
    FROM (SELECT f.*, ROW_NUMBER() OVER (ORDER BY f.amount_num DESC, f.ts ASC) rn, COUNT(*) OVER () n
          FROM (${tradeWindow(DIGEST_TRADES_MAX + 1)}) f) r
    LEFT JOIN labels l ON l.address = CASE WHEN r.kind = 'buy' THEN r.to_addr ELSE r.from_addr END
    WHERE r.rn <= ${DIGEST_ATTN_TRADES_READ} OR r.rn IN ((r.n + 1) / 2, r.n / 2 + 1)
    ORDER BY r.rn`,
  /** The window's totals (the digest's 5.5 read): count, traders, NAM, dollars at execution, unpriced. */
  totals: `SELECT COUNT(*) n, COALESCE(SUM(amount_num), 0) nam, COALESCE(SUM(value_usd), 0) usd, SUM(CASE WHEN value_usd IS NULL THEN 1 ELSE 0 END) unpriced,
       COUNT(DISTINCT COALESCE(json_extract(meta, '$.trader'), CASE WHEN kind = 'buy' THEN to_addr ELSE from_addr END)) traders
    FROM (SELECT kind, amount_num, value_usd, meta, to_addr, from_addr FROM flows f INDEXED BY flows_kind
          WHERE f.kind IN ('buy','sell') AND f.chain = 'osmosis' AND f.ts >= ?1 AND f.ts < ?2 AND ${NOT_ARB} ORDER BY f.ts DESC LIMIT ${DIGEST_TRADES_MAX + 1})`,
  /** The window's trades for the picture, the newest first. */
  picture: `SELECT f.id, f.ts, f.kind, f.amount_num, f.price_usd, f.counter_denom, f.counter_amount, f.meta FROM flows f INDEXED BY flows_kind
    WHERE f.kind IN ('buy','sell') AND f.chain = 'osmosis' AND f.ts >= ?1 AND f.ts < ?2 AND ${NOT_ARB} ORDER BY f.ts DESC LIMIT ${DIGEST_ATTN_PNG_RING_MAX + 1}`,
  /** The quote's minute readings over the window, the newest first, up to the kind's bound + 1. */
  series: `SELECT ts, value FROM metrics WHERE key = 'price.usd' AND ts > ?1 AND ts <= ?2 ORDER BY ts DESC LIMIT ?3`,
  /** L3a: every trader of the window (as the totals count them), each with its largest trade of the window and its
   *  label, the most active first. */
  makers: `SELECT m.maker, m.n, m.ts, m.kind, m.amount_num, l.label, l.source AS label_source, l.author AS label_author
    FROM (SELECT t.maker, t.ts, t.kind, t.amount_num, COUNT(*) OVER (PARTITION BY t.maker) n,
                 ROW_NUMBER() OVER (PARTITION BY t.maker ORDER BY t.amount_num DESC, t.ts ASC) rk
          FROM (SELECT ${TRADER} maker, f.ts, f.kind, f.amount_num FROM (${tradeWindow(DIGEST_TRADES_MAX + 1)}) f) t
          WHERE t.maker IS NOT NULL) m
    LEFT JOIN labels l ON l.address = m.maker
    WHERE m.rk = 1 ORDER BY m.n DESC, m.amount_num DESC LIMIT ${DIGEST_ATTN_MAKERS_READ + 1}`,
  /** L3b: the window's trades over the five-times bar (?3), by maker and side, with the maker's label. */
  overBar: `SELECT g.maker, g.kind, g.n, g.nam, g.largest, g.first_ts, g.last_ts, l.label, l.source AS label_source, l.author AS label_author
    FROM (SELECT CASE WHEN f.kind = 'buy' THEN f.to_addr ELSE f.from_addr END maker, f.kind, COUNT(*) n, SUM(f.amount_num) nam,
                 MAX(f.amount_num) largest, MIN(f.ts) first_ts, MAX(f.ts) last_ts
          FROM (${tradeWindow(DIGEST_TRADES_MAX + 1)}) f WHERE f.amount_num > ?3 GROUP BY 1, 2) g
    LEFT JOIN labels l ON l.address = g.maker
    ORDER BY g.nam DESC LIMIT ${4 * DIGEST_ATTN_EVENTS}`,
  /** L1c: the quote before a trade and after 15 and 60 minutes, three seeks of the metrics primary key. */
  move: `SELECT
      (SELECT json_object('ts', ts, 'value', value) FROM metrics WHERE key = 'price.usd' AND ts <= ?1 AND ts >= ?2 ORDER BY ts DESC LIMIT 1) before,
      (SELECT json_object('ts', ts, 'value', value) FROM metrics WHERE key = 'price.usd' AND ts <= ?3 AND ts >= ?4 ORDER BY ts DESC LIMIT 1) after15,
      (SELECT json_object('ts', ts, 'value', value) FROM metrics WHERE key = 'price.usd' AND ts <= ?5 AND ts >= ?6 ORDER BY ts DESC LIMIT 1) after60`,
  /** L1d and L3a: a maker's trade before the window (within 90 days), its counts and its holders row. */
  maker: `SELECT
      (SELECT 1 FROM flows f INDEXED BY flows_to WHERE f.to_addr = ?1 AND f.kind = 'buy' AND f.ts >= ?2 AND f.ts < ?3 AND ${NOT_ARB} LIMIT 1) had_buy,
      (SELECT 1 FROM flows f INDEXED BY flows_from WHERE f.from_addr = ?1 AND f.kind = 'sell' AND f.ts >= ?2 AND f.ts < ?3 AND ${NOT_ARB} LIMIT 1) had_sell,
      (SELECT COUNT(*) FROM (SELECT 1 FROM flows f INDEXED BY flows_to WHERE f.to_addr = ?1 AND f.kind = 'buy' AND f.ts < ?4 AND ${NOT_ARB} LIMIT ${DIGEST_ATTN_COUNT_MAX + 1})) buys,
      (SELECT COUNT(*) FROM (SELECT 1 FROM flows f INDEXED BY flows_from WHERE f.from_addr = ?1 AND f.kind = 'sell' AND f.ts < ?4 AND ${NOT_ARB} LIMIT ${DIGEST_ATTN_COUNT_MAX + 1})) sells,
      (SELECT balance_num FROM holders WHERE chain = 'osmosis' AND address = ?1) bal`,
  /** L2a: the window's crossings by receiver and sender, with both labels. */
  deckRows: `SELECT f.to_addr AS addr, f.from_addr AS sender, COUNT(*) n, SUM(f.amount_num) nam, MIN(f.ts) first_ts, MAX(f.ts) last_ts,
       lr.label, lr.source AS label_source, lr.author AS label_author, ls.label AS sender_label, ls.source AS sender_label_source, ls.author AS sender_label_author
    FROM (SELECT * FROM flows f INDEXED BY flows_kind
          WHERE f.kind = 'ibc_in' AND f.chain = 'osmosis' AND f.ts >= ?1 AND f.ts < ?2 AND f.to_addr IS NOT NULL AND ${NAM_AMOUNT}
          ORDER BY f.ts DESC LIMIT ${DIGEST_BRIDGE_MAX + 1}) f
    LEFT JOIN labels lr ON lr.address = f.to_addr LEFT JOIN labels ls ON ls.address = f.from_addr
    GROUP BY f.to_addr, f.from_addr ORDER BY nam DESC LIMIT 20`,
  /** The deck's header: crossings, NAM and receivers over the same bounded range. */
  deckTotals: `SELECT COUNT(*) n, COALESCE(SUM(amount_num), 0) nam, COUNT(DISTINCT to_addr) receivers
    FROM (SELECT amount_num, to_addr FROM flows f INDEXED BY flows_kind
          WHERE f.kind = 'ibc_in' AND f.chain = 'osmosis' AND f.ts >= ?1 AND f.ts < ?2 AND f.to_addr IS NOT NULL AND ${NAM_AMOUNT} ORDER BY f.ts DESC LIMIT ${DIGEST_BRIDGE_MAX + 1})`,
  /** L2b: a receiver's sales and sends back since its first arrival. */
  follow: `SELECT f.id, f.kind, f.ts, f.amount_num, f.price_usd, f.counter_denom, f.counter_amount, f.meta FROM flows f INDEXED BY flows_from
    WHERE f.from_addr = ?1 AND f.kind IN ('sell','ibc_out') AND f.chain = 'osmosis' AND f.ts >= ?2 AND f.ts < ?3 AND ${NOT_ARB} ORDER BY f.ts LIMIT ${DIGEST_ATTN_FOLLOW_MAX + 1}`,
  /** L2c: a receiver's sales in the 30 days before the window. */
  prior: `SELECT COUNT(*) n, COALESCE(SUM(amount_num), 0) nam FROM (SELECT f.amount_num FROM flows f INDEXED BY flows_from
    WHERE f.from_addr = ?1 AND f.kind = 'sell' AND f.chain = 'osmosis' AND f.ts >= ?2 AND f.ts < ?3 AND ${NOT_ARB} LIMIT ${DIGEST_ATTN_PRIOR_MAX + 1}) f`,
  /** L2d: a receiver's holders row. */
  osmoHolder: `SELECT balance_num, updated_at FROM holders WHERE chain = 'osmosis' AND address = ?1`,
  /** L2e and L3c: a Namada address's holders row and the holders above it by total NAM (pools left out; the protocol
   *  accounts among them are taken out with internalNamada's rows), up to the 100 largest and the protocol accounts. */
  namadaHolder: `SELECT h.balance_num, h.stake_num, h.total_num, h.updated_at,
       (SELECT COUNT(*) FROM (SELECT 1 FROM holders h2 INDEXED BY holders_total WHERE h2.chain = 'namada' AND h2.total_num > h.total_num
          AND ${notPool('h2.address')} LIMIT ${DIGEST_ATTN_TOP + INTERNAL_N})) above
    FROM holders h WHERE h.chain = 'namada' AND h.address = ?1`,
  /** The protocol accounts' Namada totals (bound, one primary-key seek each, one column each): to take them out of a rank. */
  internalNamada: `SELECT ${INTERNAL_ADDRS.map((_, i) => `(SELECT total_num FROM holders WHERE chain = 'namada' AND address = ?${i + 1}) t${i}`).join(', ')}`,
  /** L2e: the transfers an unlabeled sender got in the 48 h before its first crossing. */
  hop: `SELECT f.from_addr, f.ts, f.amount_num, l.label, l.source, l.author FROM flows f INDEXED BY flows_to LEFT JOIN labels l ON l.address = f.from_addr
    WHERE f.to_addr = ?1 AND f.kind = 'transfer' AND f.chain = 'namada' AND f.amount_num >= ?2 AND f.ts >= ?3 AND f.ts < ?4 AND ${NOT_LEGACY_TWIN}
    ORDER BY f.amount_num DESC LIMIT 20`,
  /** L3a: the largest Osmosis holders by the Holders page's rule: pools left out here, the protocol accounts after the
   *  read (the 100 largest are what remains). */
  top100: `SELECT address, balance_num FROM holders INDEXED BY holders_rank WHERE chain = 'osmosis' AND ${notPool('holders.address')}
    ORDER BY balance_num DESC, address LIMIT ${DIGEST_ATTN_TOP + INTERNAL_N}`,
  /** L3c: the window's withdrawals of at least the unlock threshold. */
  withdrawals: `SELECT f.id, f.ts, f.height, f.tx_hash, f.from_addr, f.to_addr, f.amount_num, f.meta, l.label, l.source AS label_source, l.author AS label_author
    FROM flows f INDEXED BY flows_kind LEFT JOIN labels l ON l.address = f.to_addr
    WHERE f.kind = 'withdraw' AND f.chain = 'namada' AND f.ts >= ?1 AND f.ts < ?2 AND f.amount_num >= ?3 AND ${NAM_AMOUNT} AND ${NOT_LEGACY_TWIN}
    ORDER BY f.amount_num DESC LIMIT ${DIGEST_ATTN_EVENTS}`,
  /** L3c (i): the unbond requests of the withdrawer before the withdrawal. */
  request: `SELECT f.ts, f.height, f.amount_num, json_extract(f.meta, '$.validator') validator FROM flows f INDEXED BY flows_to
    WHERE f.to_addr = ?1 AND f.kind = 'unbond' AND f.chain = 'namada' AND f.ts < ?2 AND ${NAM_AMOUNT} AND ${NOT_LEGACY_TWIN} ORDER BY f.ts DESC LIMIT 20`,
  /** L3c (ii): what the address did after the withdrawal. */
  after: `SELECT f.kind, f.ts, f.amount_num, f.to_addr FROM flows f INDEXED BY flows_from
    WHERE f.from_addr = ?1 AND f.chain = 'namada' AND f.ts >= ?2 AND f.ts < ?3 AND ${NAM_AMOUNT} AND ${NOT_LEGACY_TWIN} ORDER BY f.ts LIMIT 50`,
  /** L3c (iv): the validator's stored name and state, today's row or yesterday's. */
  validator: `SELECT name, state FROM validator_daily WHERE validator = ?1 AND day IN (?2, ?3) ORDER BY day DESC LIMIT 1`,
  /** L3c: the epoch reading at an unbond request's time, within DIGEST_ATTN_EPOCH_MATCH_MS before it. */
  epochAt: `SELECT ts, value FROM metrics WHERE key = 'epoch' AND ts <= ?1 AND ts >= ?2 ORDER BY ts DESC LIMIT 1`,
  /** L3d: the window's unshieldings of at least the unshield threshold. */
  unshieldings: `SELECT f.id, f.ts, f.height, f.tx_hash, f.to_addr, f.amount_num, f.meta, l.label, l.source AS label_source, l.author AS label_author
    FROM flows f INDEXED BY flows_kind LEFT JOIN labels l ON l.address = f.to_addr
    WHERE f.kind = 'unshield' AND f.chain = 'namada' AND f.ts >= ?1 AND f.ts < ?2 AND f.amount_num >= ?3 AND ${NAM_AMOUNT} AND ${NOT_LEGACY_TWIN}
    ORDER BY f.amount_num DESC LIMIT ${DIGEST_ATTN_EVENTS}`,
  /** L3d: the bridge-out by the receiving address within 48 h of the unshielding. */
  bridgeOut: `SELECT f.ts, f.amount_num, f.to_addr FROM flows f INDEXED BY flows_from
    WHERE f.from_addr = ?1 AND f.kind = 'ibc_out' AND f.chain = 'namada' AND f.ts >= ?2 AND f.ts < ?3 AND ${NAM_AMOUNT} ORDER BY f.ts LIMIT 20`,
  /** The index and pass stamps and the chain parameters: four primary-key rows of kv. */
  kv: `SELECT key, value, updated_at FROM kv WHERE key IN ('osmosis.live', 'osmosis.cursor', 'osmosis.holders.pass', 'chain.params')`,
  /** The refunds of timed-out sends in the window (series-sql.ts REFUNDS_SQL): a refunded send back never left. */
  refunds: REFUNDS_SQL,
} as const;

// ---------------------------------------------------------------- reads

type Row = Record<string, any>;
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
const results = (r: unknown): Row[] => ((r as { results?: Row[] } | null)?.results ?? []) as Row[];

function labelWords(label: string | null | undefined, address: string | null | undefined, source: string | null | undefined, author: string | null | undefined): LabelWords | null {
  const raw = label ?? (address ? INTERNAL_LABELS[address]?.label : null) ?? null;
  const src = label ? source ?? null : raw ? 'auto' : null;
  const plain = label_plain(raw, address, src);
  if (!plain) return null;
  return { plain, source: src, byline: tagByline(src, labelAuthorShort(src, author)) };
}

function ownPrice(r: Row, meta: Record<string, unknown>): OwnPrice | null {
  const usd = r.price_usd;
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0) return null;
  const s = meta.priceSource;
  if (s === 'swap_1h' || s === 'spot') return { usd, how: s };
  if (s === 'execution') return { usd, how: 'execution' };
  if (r.counter_denom === 'USDC' && r.counter_amount > 0 && r.amount_num > 0 && Math.abs(r.counter_amount / r.amount_num - usd) <= usd * 1e-6) return { usd, how: 'execution' };
  return { usd, how: 'unstated' };
}

/** The gas coin of a settle record and how its rate was set, read beside settleOf (which keeps only the gas's dollars). */
export function gasWordsOf(meta: SettleMeta | null, settle: Settle | null): GasWords | null {
  if (!meta?.gas) return null;
  const coin = Object.entries(meta.gas).find(([, a]) => Number.isFinite(a) && a > 0)?.[0];
  if (!coin) return null;
  if (settle?.gasLeftOut) return { coin, rate: 'left out' };
  if (SETTLE_STABLES.includes(coin)) return { coin, rate: 'stable' };
  if ((meta.rates?.[coin] ?? 0) > 0) return { coin, rate: 'tx' };
  return { coin, rate: 'quote' };
}

const point = (v: unknown): PicturePoint | null => {
  const o = typeof v === 'string' ? safeParseJson(v, null) : v;
  return o && Number.isFinite(o.ts) && Number.isFinite(o.value) ? { ts: Number(o.ts), value: Number(o.value) } : null;
};

/** The parsed kv rows the section reads. */
interface KvRows { indexBehind: AttentionFigures['indexBehind']; passTrustedAt: number | null; params: ChainParams | null }

function kvRows(rows: Row[], now: number): KvRows {
  const by = new Map(rows.map((r) => [r.key as string, r]));
  const live = safeParseJson(by.get('osmosis.live')?.value, null);
  const liveAt = Number(by.get('osmosis.live')?.updated_at);
  const cursor = safeParseJson(by.get('osmosis.cursor')?.value, null);
  const streaming = !!live?.connected && Number.isFinite(liveAt) && now - liveAt <= OSMOSIS_LIVE_STALE_MS;
  const sweepAt = Number(cursor?.at);
  const indexBehind = !streaming && Number.isFinite(sweepAt) && sweepAt > 0 && now - sweepAt > OSMOSIS_SWEEP_STALE_MS
    ? { countedTo: sweepAt, height: Number.isFinite(Number(cursor?.height)) ? Number(cursor.height) : null }
    : null;
  const pass = safeParseJson(by.get('osmosis.holders.pass')?.value, null);
  const passTrustedAt = Number.isFinite(Number(pass?.trustedStartedAt)) && Number(pass?.trustedStartedAt) > 0 ? Number(pass.trustedStartedAt) : null;
  const p = safeParseJson(by.get('chain.params')?.value, null) as (ChainParams & { fetchedAt?: number }) | null;
  const params = p && Number.isFinite(p.unbondingLength) && Number.isFinite(p.pipelineLength) && Number(p.fetchedAt) > 0 && now - Number(p.fetchedAt) <= DIGEST_PARAMS_STALE_MS ? p : null;
  return { indexBehind, passTrustedAt, params };
}

/**
 * The section's figures as of `now`, from D1 alone (nothing is fetched). The window is the 24 h to `now` (the
 * weekly: 7 × 24 h). Wave 1 is one batch of the independent statements; wave 2 reads on from its rows in one batch
 * per line (trades, deck, unusual), each inside its own try, so a failure is that line's NotRead and never a lost
 * section. `clock` is the digest's epoch anchor when the wiring has one: with it an exactly known withdraw epoch
 * also gets its clock time.
 */
export async function readAttentionFigures(db: D1Database, now: number, kind: DigestKind = 'daily', opts: { clock?: EpochClock | null } = {}): Promise<AttentionFigures> {
  const from = now - (kind === 'weekly' ? 7 * D : D);
  const to = now;
  const unlock = DEFAULT_THRESHOLDS.unlock;
  const unshield = DEFAULT_THRESHOLDS.unshield;
  const clock = opts.clock ?? null;

  let wave1: Awaited<ReturnType<D1Database['batch']>> | null = null;
  try {
    wave1 = await db.batch([
      db.prepare(ATTENTION_SQL.largest).bind(from, to),
      db.prepare(ATTENTION_SQL.totals).bind(from, to),
      db.prepare(ATTENTION_SQL.deckRows).bind(from, to),
      db.prepare(ATTENTION_SQL.deckTotals).bind(from, to),
      db.prepare(ATTENTION_SQL.refunds).bind(from, to),
      db.prepare(ATTENTION_SQL.top100),
      db.prepare(ATTENTION_SQL.withdrawals).bind(from, to, unlock),
      db.prepare(ATTENTION_SQL.unshieldings).bind(from, to, unshield),
      db.prepare(ATTENTION_SQL.series).bind(from, to, DIGEST_ATTN_SERIES_MAX[kind] + 1),
      db.prepare(ATTENTION_SQL.picture).bind(from, to),
      db.prepare(ATTENTION_SQL.kv),
      db.prepare(ATTENTION_SQL.makers).bind(from, to),
      db.prepare(ATTENTION_SQL.internalNamada).bind(...INTERNAL_ADDRS),
    ]);
  } catch {
    wave1 = null;
  }
  const w = (i: number): Row[] | null => (wave1 ? results(wave1[i]) : null);
  const kv = kvRows(w(10) ?? [], now);
  const fig: AttentionFigures = {
    kind, now, from, to,
    indexBehind: kv.indexBehind,
    passTrustedAt: kv.passTrustedAt,
    trades: notRead('trades'),
    deck: notRead('deck'),
    unusual: { first: notRead('first'), multiple: notRead('multiple'), withdraw: notRead('withdraw'), unshield: notRead('unshield'), traders: null },
    // read newest first so a bound keeps the newest readings; drawn oldest first
    series: w(8) ? (w(8) as Row[]).slice(0, DIGEST_ATTN_SERIES_MAX[kind]).map((r) => ({ ts: num(r.ts), value: num(r.value) })).reverse() : notRead('series'),
    seriesBounded: (w(8)?.length ?? 0) > DIGEST_ATTN_SERIES_MAX[kind],
    pictureTrades: notRead('picture'),
    pictureBounded: false,
    params: kv.params,
    clock,
  };

  const top100 = w(5)?.filter((r) => !isProtocol(r.address as string)).slice(0, DIGEST_ATTN_TOP) ?? null;
  const rankOf = new Map<string, number>();
  top100?.forEach((r, i) => rankOf.set(r.address as string, i + 1));
  // the holders above a Namada address, its protocol accounts taken out (they hold the staked, shielded and escrowed NAM)
  const protocolTotals = Object.values(w(12)?.[0] ?? {}).filter((v) => v != null).map(num);
  const aboveOf = (h: Row): number => Math.max(0, num(h.above) - protocolTotals.filter((t) => t > num(h.total_num)).length);

  // the deck's receivers are known before the trades are built, so a trade by one of them can say "on deck"
  const deckRaw = w(2);
  const receivers = new Set<string>((deckRaw ?? []).map((r) => r.addr as string).filter((a) => !isInternal(a)));

  // ---- the picture's trades: every window trade at its settle price, else its own price
  const picRows = w(9);
  if (picRows) {
    try {
      const metas = picRows.map((r) => safeParseJson(r.meta, {}) as Record<string, unknown>);
      const settles = await settlePrices(db, picRows.map((r, i) => ({ kind: r.kind, ts: r.ts, meta: metas[i] })));
      fig.pictureBounded = picRows.length > DIGEST_ATTN_PNG_RING_MAX;
      fig.pictureTrades = picRows.slice(0, DIGEST_ATTN_PNG_RING_MAX).flatMap((r, i) => {
        const price = settles[i]?.usdPerNam ?? ownPrice(r, metas[i])?.usd ?? null;
        return price ? [{ ts: num(r.ts), kind: r.kind as 'buy' | 'sell', nam: num(r.amount_num), price }] : [];
      });
    } catch {
      fig.pictureTrades = notRead('picture');
    }
  }

  // ---- L1: the largest trades
  const largest = w(0);
  const totals = w(1)?.[0];
  if (largest && totals) {
    try {
      const n = num(totals.n);
      const rows = largest.filter((r) => r.rn <= DIGEST_ATTN_TRADES_READ);
      let median: number | null = null;
      if (n >= DIGEST_ATTN_MEDIAN_MIN) {
        const at = (rn: number) => largest.find((r) => r.rn === rn)?.amount_num as number | undefined;
        if (n % 2 === 1) median = at((n + 1) / 2) ?? null;
        else { const a = at(n / 2), b = at(n / 2 + 1); median = a != null && b != null ? (a + b) / 2 : null; }
      }
      const metas = rows.map((r) => safeParseJson(r.meta, {}) as Record<string, unknown>);
      const settles = await settlePrices(db, rows.map((r, i) => ({ kind: r.kind, ts: r.ts, meta: metas[i] })));
      const read: TradeRead[] = rows.map((r, i) => {
        const maker = (r.kind === 'buy' ? r.to_addr : r.from_addr) ?? null;
        return {
          id: r.id, ts: num(r.ts), kind: r.kind, nam: num(r.amount_num), rank: num(r.rn), maker,
          label: labelWords(r.label, maker, r.label_source, r.label_author),
          settle: settles[i], own: settles[i] ? null : ownPrice(r, metas[i]), gas: gasWordsOf(settleMetaOf(metas[i]), settles[i]),
          move: null, record: null, route: typeof r.pool_id === 'string' ? r.pool_id.split(',').filter(Boolean) : [],
          onDeck: !!maker && receivers.has(maker), txHash: r.tx_hash, explorerHash: explorerHashOf({ txHash: r.tx_hash, meta: metas[i] }),
        };
      });
      fig.trades = { n, traders: num(totals.traders), nam: num(totals.nam), usd: num(totals.usd), unpriced: num(totals.unpriced), bounded: n > DIGEST_TRADES_MAX, median, read };

      // wave 2 for the trades: the quote around each shown trade, every read maker's record and every top-100 trader's
      // (the first-trade rule looks at all of the window's traders, not only the makers of the largest trades)
      const shown = read.slice(0, DIGEST_ATTN_TRADES);
      const windowMakers = (w(11) ?? []).slice(0, DIGEST_ATTN_MAKERS_READ);
      const topMakers = windowMakers.filter((r) => rankOf.has(r.maker as string));
      const makers = [...new Set([
        ...read.map((t) => t.maker).filter((m): m is string => !!m).slice(0, DIGEST_ATTN_MAKERS),
        ...topMakers.map((r) => r.maker as string),
      ])];
      try {
        const [m15, m60] = DIGEST_ATTN_QUOTE_AFTER_MS;
        const [min15, min60] = DIGEST_ATTN_QUOTE_AFTER_MIN_MS;
        const stmts = [
          ...shown.map((t) => {
            const notYet60 = t.ts + m60 > now;
            const notYet15 = t.ts + m15 > now;
            return db.prepare(ATTENTION_SQL.move).bind(
              t.ts, t.ts - QUOTE_MATCH_MS,
              notYet15 ? -1 : t.ts + m15, notYet15 ? 0 : t.ts + min15,
              notYet60 ? -1 : t.ts + m60, notYet60 ? 0 : t.ts + min60,
            );
          }),
          ...makers.map((m) => db.prepare(ATTENTION_SQL.maker).bind(m, from - DIGEST_ATTN_FIRST_LOOKBACK_MS, from, to)),
        ];
        const res = await db.batch(stmts);
        shown.forEach((t, i) => {
          const r = results(res[i])[0] ?? {};
          t.move = { before: point(r.before), after15: point(r.after15), after60: t.ts + m60 > now ? 'not yet' : point(r.after60), notYet15: t.ts + m15 > now };
        });
        const records = new Map<string, MakerRecord>();
        makers.forEach((m, i) => {
          const r = results(res[shown.length + i])[0] ?? {};
          const buys = num(r.buys), sells = num(r.sells);
          records.set(m, {
            buys: Math.min(buys, DIGEST_ATTN_COUNT_MAX), sells: Math.min(sells, DIGEST_ATTN_COUNT_MAX), bounded: buys > DIGEST_ATTN_COUNT_MAX || sells > DIGEST_ATTN_COUNT_MAX,
            hadBefore: r.had_buy != null || r.had_sell != null, rank: rankOf.get(m) ?? null, balance: typeof r.bal === 'number' ? r.bal : null,
          });
        });
        for (const t of read) t.record = t.maker ? records.get(t.maker) ?? null : null;
        // L3a: every top-100 trader of the window with no trade in the 90 days before it, at its largest trade
        if (top100 && w(11)) {
          const first: UnusualEvent[] = [];
          for (const r of topMakers) {
            const m = r.maker as string;
            const rec = records.get(m);
            const rank = rankOf.get(m);
            if (!rec || !rank || rec.hadBefore) continue;
            first.push({ rule: 'first', nam: num(r.amount_num), ts: num(r.ts), kind: r.kind, address: m, label: labelWords(r.label, m, r.label_source, r.label_author), rank, record: rec });
          }
          fig.unusual.first = first;
          fig.unusual.traders = { total: windowMakers.length, top: topMakers.length, ...((w(11)?.length ?? 0) > DIGEST_ATTN_MAKERS_READ ? { bounded: true } : {}) };
        } else fig.unusual.first = notRead('first');
      } catch {
        for (const t of shown) t.move = notRead('quote');
        for (const t of read) t.record = notRead('record');
        fig.unusual.first = notRead('first');
      }
      // L3b: the window's trades over the bar, one event per maker and side (its count, its NAM in all)
      if (median != null) {
        const bar = median * DIGEST_ATTN_MULT;
        try {
          const rows = results((await db.batch([db.prepare(ATTENTION_SQL.overBar).bind(from, to, bar)]))[0]);
          fig.unusual.multiple = rows.map((r) => ({
            rule: 'multiple' as const, nam: num(r.nam), ts: num(r.first_ts), lastTs: num(r.last_ts), n: num(r.n), largest: num(r.largest),
            kind: r.kind as 'buy' | 'sell', address: (r.maker as string | null) ?? null, label: labelWords(r.label, r.maker, r.label_source, r.label_author), bar,
          }));
        } catch {
          fig.unusual.multiple = notRead('multiple');
        }
      } else fig.unusual.multiple = [];
    } catch {
      fig.trades = notRead('trades');
    }
  }

  // ---- L2: NAM on deck
  const deckTotals = w(3)?.[0];
  if (deckRaw && deckTotals) {
    try {
      const refunds = (w(4) ?? []).map(ibcRowOf);
      type Pair = { addr: string; sender: string | null; n: number; nam: number; first: number; last: number; label: LabelWords | null; senderLabel: LabelWords | null };
      const pairs: Pair[] = deckRaw.filter((r) => !isInternal(r.addr)).map((r) => ({
        addr: r.addr, sender: r.sender ?? null, n: num(r.n), nam: num(r.nam), first: num(r.first_ts), last: num(r.last_ts),
        label: labelWords(r.label, r.addr, r.label_source, r.label_author), senderLabel: labelWords(r.sender_label, r.sender, r.sender_label_source, r.sender_label_author),
      }));
      const byAddr = new Map<string, Pair[]>();
      for (const p of pairs) (byAddr.get(p.addr) ?? byAddr.set(p.addr, []).get(p.addr)!).push(p);
      const rows: DeckRow[] = [...byAddr.entries()].map(([addr, list]) => {
        const best = [...list].sort((a, b) => b.nam - a.nam || a.first - b.first)[0];
        return {
          address: addr, label: best.label, bridgedIn: list.reduce((a, p) => a + p.nam, 0), crossings: list.reduce((a, p) => a + p.n, 0),
          firstTs: Math.min(...list.map((p) => p.first)), lastTs: Math.max(...list.map((p) => p.last)),
          sender: best.sender ? { address: best.sender, label: best.senderLabel, nam: best.nam, holder: null, hop: null } : null,
          follow: notRead('deck follow-ups'),
        };
      }).sort((a, b) => b.bridgedIn - a.bridgedIn || a.firstTs - b.firstTs).slice(0, DIGEST_ATTN_DECK_READ);
      fig.deck = { crossings: num(deckTotals.n), nam: num(deckTotals.nam), receivers: num(deckTotals.receivers), bounded: num(deckTotals.n) > DIGEST_BRIDGE_MAX, rows };

      // wave 2 for the deck: follow-ups, prior sales, the holders rows, the sender's rank and, for an unlabeled sender, its hop origin
      try {
        const plan = rows.map((row) => {
          const hop = !!row.sender && (!row.sender.label || row.sender.label.source === 'user') && !isInternal(row.sender.address);
          const stmts = [
            db.prepare(ATTENTION_SQL.follow).bind(row.address, row.firstTs, to),
            db.prepare(ATTENTION_SQL.prior).bind(row.address, from - 30 * D, from),
            db.prepare(ATTENTION_SQL.osmoHolder).bind(row.address),
          ];
          if (row.sender) stmts.push(db.prepare(ATTENTION_SQL.namadaHolder).bind(row.sender.address));
          if (hop && row.sender) stmts.push(db.prepare(ATTENTION_SQL.hop).bind(row.sender.address, HOP_ORIGIN_MIN_NAM, row.firstTs - HOP_ORIGIN_WINDOW_MS, row.firstTs));
          return { row, hop, stmts };
        });
        const res = await db.batch(plan.flatMap((p) => p.stmts));
        let k = 0;
        const saleAsks: { row: DeckRow; sales: Row[] }[] = [];
        for (const { row, hop, stmts } of plan) {
          const got = res.slice(k, k + stmts.length).map(results);
          k += stmts.length;
          const followRows = got[0];
          const prior = got[1][0] ?? {};
          const holder = got[2][0] ?? null;
          if (row.sender) {
            const h = got[3][0] ?? null;
            row.sender.holder = h ? { balance: num(h.balance_num), stake: num(h.stake_num), total: num(h.total_num), updatedAt: h.updated_at ?? null, above: aboveOf(h) } : null;
            if (hop) {
              const origins = new Map<string, HopOrigin>();
              for (const r of got[4]) {
                if (!r.from_addr || isInternal(r.from_addr)) continue;
                const o = origins.get(r.from_addr) ?? origins.set(r.from_addr, { address: r.from_addr, label: labelWords(r.label, r.from_addr, r.source, r.author), nam: 0 }).get(r.from_addr)!;
                o.nam += num(r.amount_num);
              }
              const best = [...origins.values()].sort((a, b) => b.nam - a.nam)[0] ?? null;
              row.sender.hop = best && best.nam >= Math.max(HOP_ORIGIN_MIN_NAM, row.sender.nam * HOP_ORIGIN_SHARE) ? best : null;
            }
          }
          const outs = followRows.filter((r) => r.kind === 'ibc_out').map(ibcRowOf);
          const gone = timedOutSends(outs, refunds);
          const sales = followRows.filter((r) => r.kind === 'sell').slice(0, DIGEST_ATTN_FOLLOW_MAX);
          const soldSince = sales.reduce((a, r) => a + num(r.amount_num), 0);
          const bridgedOutSince = outs.filter((o) => !gone.has(o.id)).reduce((a, o) => a + o.amount, 0);
          const soldCounted = Math.min(soldSince, row.bridgedIn);
          const sentBackCounted = Math.min(bridgedOutSince, row.bridgedIn - soldCounted);
          const priorN = num(prior.n);
          const priorNam = num(prior.nam);
          const hazardBase = (soldCounted + priorNam + 5_000) / (row.bridgedIn + priorNam + 25_000);
          const hopOrigin = row.sender && !isNotRead(row.sender.hop) ? row.sender.hop : null;
          const hazard = Number(Math.min(0.99, hazardBase * 0.7 + (soldCounted > 0 ? 0.25 : 0) + (priorNam > 0 ? 0.15 : 0) + (hopOrigin ? 0.1 : 0)).toFixed(3));
          const saleMetas = sales.map((r) => safeParseJson(r.meta, {}) as Record<string, unknown>);
          const settleNam = saleMetas.reduce((a, meta) => { const s = settleMetaOf(meta); return a + (s ? Math.abs(s.nam) : 0); }, 0);
          row.follow = {
            sales: sales.map((r, i) => ({ ts: num(r.ts), nam: num(r.amount_num), settle: null, own: ownPrice(r, saleMetas[i]), gas: null, settleNam: settleMetaOf(saleMetas[i])?.nam ?? null })),
            salesBounded: followRows.filter((r) => r.kind === 'sell').length > DIGEST_ATTN_FOLLOW_MAX,
            soldSince, bridgedOutSince, soldCounted, sentBackCounted, remaining: Math.max(0, row.bridgedIn - soldCounted - sentBackCounted),
            feeNote: sales.length > 0 && Math.abs(settleNam - row.bridgedIn) <= 1e-6 && Math.abs(soldSince - row.bridgedIn) > 1e-6,
            prior: { n: Math.min(priorN, DIGEST_ATTN_PRIOR_MAX), nam: priorNam, bounded: priorN > DIGEST_ATTN_PRIOR_MAX },
            hazard,
            holder: holder ? { balance: num(holder.balance_num), updatedAt: holder.updated_at ?? null } : null,
          };
          saleAsks.push({ row, sales });
        }
        // the sales' settle prices at their own minutes
        for (const { row, sales } of saleAsks) {
          if (isNotRead(row.follow) || !sales.length) continue;
          const metas = sales.map((r) => safeParseJson(r.meta, {}) as Record<string, unknown>);
          const settles = await settlePrices(db, sales.map((r, i) => ({ kind: 'sell', ts: r.ts, meta: metas[i] })));
          row.follow.sales.forEach((s, i) => { s.settle = settles[i]; s.gas = gasWordsOf(settleMetaOf(metas[i]), settles[i]); if (s.settle) s.own = null; });
        }
      } catch {
        for (const row of rows) { row.follow = notRead('deck follow-ups'); if (row.sender) { row.sender.holder = notRead('sender'); row.sender.hop = notRead('hop'); } }
      }
    } catch {
      fig.deck = notRead('deck');
    }
  }

  // ---- L3c and L3d: withdrawals of matured unbonds, unshieldings followed by a bridge-out
  const wdRows = w(6);
  const unshRows = w(7);
  const today = new Date(now).toISOString().slice(0, 10);
  const yday = new Date(now - D).toISOString().slice(0, 10);
  const wait = unbondingWait(fig.params);
  if (wdRows || unshRows) {
    try {
      const wds = (wdRows ?? []).filter((r) => r.to_addr && !isInternal(r.to_addr));
      const unshs = (unshRows ?? []).filter((r) => r.to_addr && !isInternal(r.to_addr));
      const stmts = [
        ...wds.flatMap((r) => [
          db.prepare(ATTENTION_SQL.request).bind(r.to_addr, r.ts),
          db.prepare(ATTENTION_SQL.after).bind(r.to_addr, r.ts, to),
          db.prepare(ATTENTION_SQL.namadaHolder).bind(r.to_addr),
        ]),
        ...unshs.map((r) => db.prepare(ATTENTION_SQL.bridgeOut).bind(r.to_addr, r.ts, Math.min(to, num(r.ts) + 48 * H))),
      ];
      const res = stmts.length ? await db.batch(stmts) : [];
      const withdraw: UnusualEvent[] = [];
      const second: { ev: Extract<UnusualEvent, { rule: 'withdraw' }>; req: RequestMatch | null }[] = [];
      wds.forEach((r, i) => {
        const [reqRows, afterRows, holderRows] = [results(res[i * 3]), results(res[i * 3 + 1]), results(res[i * 3 + 2])];
        const meta = safeParseJson(r.meta, {}) as Record<string, unknown>;
        const nam = num(r.amount_num);
        const exact = reqRows.find((q) => Math.abs(num(q.amount_num) - nam) <= 1e-6);
        const nearest = exact ?? [...reqRows].sort((a, b) => Math.abs(num(a.amount_num) - nam) - Math.abs(num(b.amount_num) - nam))[0];
        const req: RequestMatch | null = nearest ? { ts: num(nearest.ts), nam: num(nearest.amount_num), validator: String(nearest.validator ?? ''), exact: !!exact } : null;
        const since: SinceMoves = { restaked: 0, bridgedOut: 0, shielded: 0, transferred: 0, transferTo: null, transferTargets: 0, bounded: afterRows.length >= 50 };
        const targets = new Map<string, number>();
        for (const a of afterRows) {
          const v = num(a.amount_num);
          if (a.kind === 'bond') since.restaked += v;
          else if (a.kind === 'ibc_out') since.bridgedOut += v;
          else if (a.kind === 'shield') since.shielded += v;
          else if (a.kind === 'transfer' && a.to_addr) { since.transferred += v; targets.set(a.to_addr, (targets.get(a.to_addr) ?? 0) + v); }
        }
        since.transferTargets = targets.size;
        since.transferTo = [...targets.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
        const h = holderRows[0] ?? null;
        const ev: Extract<UnusualEvent, { rule: 'withdraw' }> = {
          rule: 'withdraw', nam, ts: num(r.ts), address: r.to_addr, label: labelWords(r.label, r.to_addr, r.label_source, r.label_author),
          txHash: r.tx_hash, explorerHash: explorerHashOf({ txHash: r.tx_hash, meta }),
          request: req, maturity: null, since,
          holder: h ? { balance: num(h.balance_num), stake: num(h.stake_num), total: num(h.total_num), updatedAt: h.updated_at ?? null, above: aboveOf(h) } : null,
          validator: { address: req?.validator ?? '', name: null, state: null },
        };
        withdraw.push(ev);
        second.push({ ev, req });
      });
      // the request's epoch and the validator's name need the request first
      const asks = second.filter((s) => s.req);
      if (asks.length) {
        try {
          const res2 = await db.batch(asks.flatMap((s) => [
            db.prepare(ATTENTION_SQL.epochAt).bind(s.req!.ts, s.req!.ts - DIGEST_ATTN_EPOCH_MATCH_MS),
            db.prepare(ATTENTION_SQL.validator).bind(s.req!.validator, today, yday),
          ]));
          asks.forEach((s, i) => {
            const ep = results(res2[i * 2])[0] ?? null;
            const val = results(res2[i * 2 + 1])[0] ?? null;
            s.ev.validator = { address: s.req!.validator, name: val?.name ?? null, state: val?.state ?? null };
            if (ep && fig.params) {
              const epoch = Math.round(num(ep.value)) + withdrawEpochs(fig.params);
              s.ev.maturity = { kind: 'exact', epoch, at: clock ? clock.startedAt + (epoch - clock.epoch) * clock.epochSec * 1000 : null };
            } else if (wait) s.ev.maturity = { kind: 'estimate', at: s.req!.ts + wait.epochs * wait.epochSec * 1000, epochs: wait.epochs, epochSec: wait.epochSec };
            else s.ev.maturity = { kind: 'none', why: 'chain parameters not read' };
          });
        } catch {
          for (const s of asks) { s.ev.validator = notRead('validator'); s.ev.maturity = wait ? { kind: 'estimate', at: s.req!.ts + wait.epochs * wait.epochSec * 1000, epochs: wait.epochs, epochSec: wait.epochSec } : { kind: 'none', why: 'chain parameters not read' }; }
        }
      }
      fig.unusual.withdraw = wdRows ? withdraw : notRead('withdraw');
      const unshieldEvents: UnusualEvent[] = unshs.map((r, i) => {
        const outs = results(res[wds.length * 3 + i]);
        const meta = safeParseJson(r.meta, {}) as Record<string, unknown>;
        const out = outs[0] ?? null;
        return {
          rule: 'unshield', nam: num(r.amount_num), ts: num(r.ts), address: r.to_addr, label: labelWords(r.label, r.to_addr, r.label_source, r.label_author),
          txHash: r.tx_hash, explorerHash: explorerHashOf({ txHash: r.tx_hash, meta }),
          bridgeOut: out ? { nam: outs.reduce((a, o) => a + num(o.amount_num), 0), ts: num(out.ts) } : null,
        };
      });
      fig.unusual.unshield = unshRows ? unshieldEvents : notRead('unshield');
    } catch {
      fig.unusual.withdraw = wdRows ? notRead('withdraw') : fig.unusual.withdraw;
      fig.unusual.unshield = unshRows ? notRead('unshield') : fig.unusual.unshield;
    }
  }
  return fig;
}

/** The quote's readings over the window: the first and the last, and every stretch longer than DIGEST_ATTN_PNG_GAP_MS
 *  with no reading (the line is open there). */
export interface QuoteCoverage { first: number; last: number; gaps: [number, number][] }
export function quoteCoverage(series: readonly PicturePoint[]): QuoteCoverage | null {
  if (!series.length) return null;
  const gaps: [number, number][] = [];
  for (let i = 1; i < series.length; i++) if (series[i].ts - series[i - 1].ts > DIGEST_ATTN_PNG_GAP_MS) gaps.push([series[i - 1].ts, series[i].ts]);
  return { first: series[0].ts, last: series[series.length - 1].ts, gaps };
}

/**
 * Why the picture is left out, in words, or null when its quote line was read: a line with no reading at the send
 * time would be trades on an empty frame, so the picture goes and the description says why in one sentence.
 */
export function pictureLeftOut(fig: AttentionFigures): string | null {
  if (isNotRead(fig.series)) return 'the quote was not read (the database did not answer)';
  const cov = quoteCoverage(fig.series);
  if (!cov) return `the quote has no reading in the ${windowWords(fig.kind)}`;
  if (fig.now - cov.last > DIGEST_ATTN_QUOTE_BOUND_MS) return `the quote was not read since ${whenWords(cov.last, fig.now)}`;
  if (isNotRead(fig.pictureTrades)) return 'the trades were not read (the database did not answer)';
  return null;
}

/** The picture from the figures: null when its quote line or the trades were not read (pictureLeftOut), or the
 *  renderer could not draw it. */
export async function renderAttentionPicture(fig: AttentionFigures): Promise<AttentionPicture | null> {
  if (pictureLeftOut(fig) || isNotRead(fig.series) || isNotRead(fig.pictureTrades)) return null;
  return renderAttentionPng(fig.series, fig.pictureTrades, fig.from, fig.to, { ringsOff: fig.pictureBounded });
}

// ---------------------------------------------------------------- words

const group = (s: string) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
/** NAM with thousands separators and two decimals; a minus is the mathematical sign. */
export const fmtNam = (n: number): string => { const [i, d] = Math.abs(n).toFixed(2).split('.'); return `${n < 0 ? '−' : ''}${group(i)}.${d}`; };
export const fmtCount = (n: number): string => group(String(Math.round(Math.abs(n))));
/** A USD price per NAM, eight decimals. */
export const fmtPrice = (n: number): string => `$${n.toFixed(8)}`;
/** A USD sum: two decimals, four under ten cents (gas). */
export const fmtUsd = (n: number): string => { const a = Math.abs(n); const s = a < 0.1 ? a.toFixed(4) : a.toFixed(2); const [i, d] = s.split('.'); return `${n < 0 ? '−' : ''}$${group(i)}.${d}`; };
export const fmtCoin = (n: number, digits: number): string => { const [i, d] = Math.abs(n).toFixed(digits).split('.'); return `${group(i)}.${d}`; };
/** A signed percentage with two decimals and a space before the sign of percent, as the digest writes them. */
export const fmtPct = (z: number): string => `${z < 0 ? '−' : '+'}${Math.abs(z * 100).toFixed(2)} %`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad2 = (n: number) => String(n).padStart(2, '0');
export const hhmm = (ts: number): string => { const d = new Date(ts); return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`; };
export const dayMon = (ts: number): string => { const d = new Date(ts); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };
export const dayMonYear = (ts: number): string => `${dayMon(ts)} ${new Date(ts).getUTCFullYear()}`;
const utcDay = (ts: number) => Math.floor(ts / D);
/** "HH:MM UTC" on T's UTC date, "HH:MM UTC yesterday" the day before, "D Mon HH:MM UTC" earlier. */
export function whenWords(ts: number, now: number): string {
  const d = utcDay(now) - utcDay(ts);
  if (d === 0) return `${hhmm(ts)} UTC`;
  if (d === 1) return `${hhmm(ts)} UTC yesterday`;
  return `${dayMon(ts)} ${hhmm(ts)} UTC`;
}
/** Two times as one span: "05:01–19:55 UTC yesterday" on one day, else each in full. */
export function spanWords(a: number, b: number, now: number): string {
  if (utcDay(a) === utcDay(b)) {
    const w = whenWords(b, now);
    return w.startsWith(hhmm(b)) ? `${hhmm(a)}–${w}` : `${hhmm(a)}–${hhmm(b)} UTC, ${dayMon(b)}`;
  }
  return `${whenWords(a, now)} to ${whenWords(b, now)}`;
}
/** A delay in the unit it reads best in: seconds under two minutes, minutes under two hours, else hours. */
export function delayWords(ms: number): string {
  const s = ms / 1000;
  if (s < 120) return `${Math.round(s)} s`;
  if (s < 7200) return `${Math.round(s / 60)} min`;
  const h = s / 3600;
  return `${h < 48 ? h.toFixed(1).replace(/\.0$/, '') : Math.round(h)} h`;
}
const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

/** The site's short form of an address (web/src/lib/format.ts fmtAddr): the first ten characters, an ellipsis, the last five. */
export const shortAddr = (a: string): string => (a.length <= 18 ? a : `${a.slice(0, 10)}…${a.slice(-5)}`);
/** Text an outsider chose is shown, never rendered as markdown (worker/src/sources/discord.ts plainMd and codeSafe). */
export const plainMd = (s: string): string => s.replace(/\]\(/g, '] (');
export const codeSafe = (s: string): string => s.replace(/[`\r\n]/g, '');
const code = (addr: string) => `\`${codeSafe(shortAddr(addr))}\``;
const siteLink = (addr: string) => `[${code(addr)}](${SITE_ADDR_URL}${encodeURIComponent(addr)})`;

/** The marks this section prints: the digest's numbering for shared sources, two of its own. The wiring may renumber them. */
export interface AttentionMarks { scan: string; clock: string; quote: string; trades: string; stream: string; listing: string; pass: string; validators: string; labels: string; coinQuote: string }
const SUP = ['⁰', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹'];
/** A mark's superscript digits. */
export const sup = (n: number): string => String(n).split('').map((c) => SUP[Number(c)] ?? c).join('');
/** The number of the mark a Sources entry starts with (Infinity when it starts with none). */
export const supValue = (entry: string): number => {
  const m = /^[⁰¹²³⁴⁵⁶⁷⁸⁹]+/.exec(entry);
  return m ? Number([...m[0]].map((c) => SUP.indexOf(c)).join('')) : Number.POSITIVE_INFINITY;
};
export const DEFAULT_MARKS: AttentionMarks = { scan: sup(3), clock: sup(5), quote: sup(6), trades: sup(7), stream: sup(8), listing: sup(12), pass: sup(14), validators: sup(17), labels: sup(18), coinQuote: sup(19) };

export interface EmbedField { name: string; value: string; inline: boolean }
export interface Embed { title?: string; description?: string; color?: number; fields?: EmbedField[]; image?: { url: string }; url?: string; footer?: { text: string }; timestamp?: string }

export interface AttentionRender {
  level: AttentionLevel;
  embed: Embed;
  /** the characters as Discord counts them: title, description, each field's name and value */
  chars: number;
  /** at A3 the Sources field is dropped: these entries go to the digest's own Sources */
  sourcesAppend: string | null;
}

export interface AttentionBuildOptions {
  marks?: Partial<AttentionMarks>;
  /** the rendered picture: its legend sentence goes in the description and the embed carries attachment://<pictureName> */
  picture?: AttentionPicture | null;
  pictureName?: string;
  /** why the picture is left out (pictureLeftOut), said in the description in one sentence when there is no picture */
  pictureNote?: string | null;
  /** the Sources entries of marks the section owns beside labels and coinQuote, when the wiring gives them its own
   *  numbers: the quote's readings over the window and the trades' own prices */
  ownSources?: Partial<Record<'quote' | 'trades', string>>;
}

interface LevelRule {
  trades: number | 'sides';
  settleDetail: boolean;
  context: boolean;
  others: 'full' | 'short' | 'none';
  deck: number;
  deckState: boolean;
  deckSettleDetail: boolean;
  events: number;
  eventDetail: 'full' | 'short' | 'floor';
  notFound: 'named' | 'short';
  sources: 'long' | 'short' | 'none';
  legend: 'long' | 'short';
  links: boolean;
}

const LEVELS: Record<AttentionLevel, LevelRule> = {
  A0: { trades: 3, settleDetail: true, context: true, others: 'full', deck: 5, deckState: true, deckSettleDetail: true, events: 5, eventDetail: 'full', notFound: 'named', sources: 'long', legend: 'long', links: true },
  A1: { trades: 3, settleDetail: false, context: true, others: 'short', deck: 5, deckState: true, deckSettleDetail: false, events: 5, eventDetail: 'full', notFound: 'named', sources: 'long', legend: 'long', links: true },
  A2: { trades: 'sides', settleDetail: false, context: false, others: 'none', deck: 3, deckState: false, deckSettleDetail: false, events: 3, eventDetail: 'short', notFound: 'short', sources: 'short', legend: 'long', links: true },
  A3: { trades: 1, settleDetail: false, context: false, others: 'none', deck: 1, deckState: false, deckSettleDetail: false, events: 1, eventDetail: 'floor', notFound: 'short', sources: 'none', legend: 'short', links: false },
};

/** Characters as Discord counts an embed: title, description, every field's name and value, the footer. */
export function embedChars(e: Embed): number {
  const len = (s: string | undefined) => (s ? [...s].length : 0);
  return len(e.title) + len(e.description) + (e.fields ?? []).reduce((a, f) => a + len(f.name) + len(f.value), 0) + len(e.footer?.text);
}

/**
 * A field value cut to Discord's 1,024 characters: at the last line break or " · " that fits, ending with "…", so a
 * number is never parted from its mark.
 */
export function cutField(value: string): string {
  const chars = [...value];
  if (chars.length <= DISCORD_FIELD_MAX) return value;
  const room = chars.slice(0, DISCORD_FIELD_MAX - 1).join('');
  const at = Math.max(room.lastIndexOf('\n'), room.lastIndexOf(' · '), room.lastIndexOf('; '), room.lastIndexOf('. '));
  return `${(at > room.length / 2 ? room.slice(0, at) : room.replace(/\s+\S*$/, '')).trimEnd()}…`;
}

/** The label clause after an address: "(Public sale allocation (genesis) ¹⁸)" or "(my note, Tag by tnam1qxyz… ¹⁸)". */
const labelClause = (l: LabelWords | null, m: AttentionMarks): string | null =>
  l ? `${plainMd(codeSafe(l.plain))}${l.byline ? `, ${l.byline}` : ''} ${m.labels}` : null;

/** The coins of a settle clause: a dollar coin by its plain name, any other with the rate it was valued at; the coin-quote mark goes on the first quoted item of a clause. */
function coinsClause(coins: Settle['coins'], quoteMark: () => string): string {
  return coins.map((c) => (c.rate === 'stable'
    ? `${fmtCoin(c.amount, 2)} ${c.symbol.replace(/^all/, '')}`
    : `${fmtCoin(c.amount, 4)} ${c.symbol} at ${c.rate === 'quote' ? `the minute quote${quoteMark()}` : "this transaction's own rate"}`)).join(' and ');
}
const gasLeftOutWords = (p: PricedTrade) => (p.settle?.gasLeftOut && p.gas ? `; gas left out: no ${p.gas.coin} quote within 5 min before` : '');

/** The settle clause of a trade line at A0: the coins, the gas and where a rate that is not a dollar came from. */
function settleClause(p: PricedTrade, m: AttentionMarks): string {
  const s = p.settle!;
  let marked = false;
  const quoteMark = () => { if (marked) return ''; marked = true; return ` ${m.coinQuote}`; };
  if (s.side === 'buy') {
    const paid = coinsClause(s.coins.filter((c) => c.amount < 0), quoteMark);
    const gas = s.gasUsd != null ? ` + ${fmtUsd(s.gasUsd)} gas${p.gas?.rate === 'quote' ? ` at the ${p.gas.coin} minute quote${quoteMark()}` : ''}` : '';
    return `${paid}${gas}, fees in${gasLeftOutWords(p)}`;
  }
  const got = coinsClause(s.coins.filter((c) => c.amount > 0), quoteMark);
  const gas = s.gasUsd != null ? ` − ${fmtUsd(s.gasUsd)} gas${p.gas?.rate === 'quote' ? quoteMark() : ''}` : '';
  return `gave ${fmtNam(s.nam)} NAM, fees in, for ${got}${gas}${gasLeftOutWords(p)}`;
}
/** The deck's settle clause: what the sale got and the gas, without the "gave" words (the header says what was given). */
function deckSettleClause(p: PricedTrade, m: AttentionMarks): string {
  const s = p.settle!;
  let marked = false;
  const quoteMark = () => { if (marked) return ''; marked = true; return ` ${m.coinQuote}`; };
  const got = coinsClause(s.coins.filter((c) => c.amount > 0), quoteMark);
  const gas = s.gasUsd != null ? ` − ${fmtUsd(s.gasUsd)} gas${p.gas?.rate === 'quote' ? quoteMark() : ''}` : '';
  return `${got}${gas}${gasLeftOutWords(p)}`;
}

/** The tape's words for a trade's own price basis (web/src/lib/flows.ts PRICE_SHORT). */
export const PRICE_SHORT: Record<OwnPrice['how'], string> = { execution: "trade's own price", swap_1h: 'hourly median price', spot: 'quote at the time', unstated: 'price basis not stated' };

function priceWords(p: PricedTrade, detail: boolean, m: AttentionMarks, clause: (p: PricedTrade, m: AttentionMarks) => string): string {
  if (p.settle) return `settled at ${fmtPrice(p.settle.usdPerNam)} ${m.trades}${detail ? ` (${clause(p, m)})` : ''}`;
  if (p.own) return `at ${fmtPrice(p.own.usd)} ${m.trades} (${PRICE_SHORT[p.own.how]})`;
  return 'no price was recorded for this trade';
}

/** The coins whose stored minute quote priced a shown trade or a deck sale, for the Sources entry. */
function coinsQuoted(fig: AttentionFigures): string[] {
  const out = new Set<string>();
  const add = (p: PricedTrade | null | undefined) => {
    if (!p?.settle) return;
    for (const c of p.settle.coins) if (c.rate === 'quote') out.add(c.symbol);
    if (p.gas?.rate === 'quote') out.add(p.gas.coin);
  };
  if (!isNotRead(fig.trades)) fig.trades.read.slice(0, DIGEST_ATTN_TRADES).forEach(add);
  if (!isNotRead(fig.deck)) for (const r of fig.deck.rows) if (!isNotRead(r.follow)) r.follow.sales.forEach(add);
  return [...out].sort();
}

function moveWords(mv: QuoteMove | NotRead | null, m: AttentionMarks): string | null {
  if (!mv) return null;
  if (isNotRead(mv)) return `quote move not read ${m.quote}`;
  if (!mv.before) return `no quote within 5 min before ${m.quote}`;
  if (mv.notYet15) return `quote after 15 min: not yet ${m.quote}`;
  if (!mv.after15) return `no quote in the 15 min after ${m.quote}`;
  return `quote ${fmtPct(mv.after15.value / mv.before.value - 1)} in the 15 min after ${m.quote}`;
}

function recordWords(r: MakerRecord): string {
  const n = (k: number, one: string) => (k === 0 ? `no ${one}` : `${r.bounded && k >= DIGEST_ATTN_COUNT_MAX ? `${fmtCount(DIGEST_ATTN_COUNT_MAX)}+` : fmtCount(k)} ${plural(k, one)}`);
  return `${n(r.buys, 'buy')}, ${n(r.sells, 'sale')} on record`;
}

function passNote(fig: AttentionFigures): string | null {
  return fig.passTrustedAt != null && fig.now - fig.passTrustedAt > DIGEST_ATTN_PASS_STALE_MS ? ` (holder list not current since ${hhmm(fig.passTrustedAt)} UTC)` : null;
}

const windowWords = (kind: DigestKind) => (kind === 'weekly' ? '7 days' : '24 h');

// ---------------------------------------------------------------- the fields

function tradesField(fig: AttentionFigures, rule: LevelRule, m: AttentionMarks): string {
  const t = fig.trades;
  if (isNotRead(t)) return `Largest trades: not read — ${t.reason}.`;
  if (!t.read.length) return `No trade in the ${windowWords(fig.kind)} ${m.stream}.`;
  const shown = rule.trades === 'sides'
    ? (['buy', 'sell'] as const).flatMap((k) => { const x = t.read.find((r) => r.kind === k); return x ? [x] : []; }).sort((a, b) => a.rank - b.rank)
    : t.read.slice(0, rule.trades);
  const lines: string[] = [];
  let rankSaid = false;
  const note = passNote(fig);
  shown.forEach((tr, i) => {
    const earlier = shown.slice(0, i).find((x) => x.maker && x.maker === tr.maker);
    const addr = earlier ? 'same address' : tr.maker
      ? `${i === 0 && rule.links ? siteLink(tr.maker) : code(tr.maker)}${tr.label ? ` (${labelClause(tr.label, m)})` : ''}`
      : 'maker not recorded';
    const parts = [priceWords(tr, rule.settleDetail, m, settleClause)];
    // the same move is said once: a trade whose readings are those of a trade shown above adds nothing
    const sameMove = earlier && !isNotRead(earlier.move) && !isNotRead(tr.move) && earlier.move && tr.move && earlier.move.before?.ts === tr.move.before?.ts && earlier.move.after15?.ts === tr.move.after15?.ts;
    const mv = sameMove ? null : moveWords(tr.move, m);
    if (mv) parts.push(mv);
    if (rule.context && !earlier && tr.record) {
      if (isNotRead(tr.record)) parts.push('record not read');
      else {
        const rank = tr.record.rank ? `; No. ${tr.record.rank}${rankSaid ? '' : ' Osmosis holder'} ${m.pass}${!rankSaid && note ? note : ''}` : '';
        if (tr.record.rank) rankSaid = true;
        parts.push(`${recordWords(tr.record)}${rank}`);
      }
    }
    lines.push(`${tr.rank}. ${tr.kind === 'buy' ? 'Bought' : 'Sold'} ${fmtNam(tr.nam)} NAM at ${whenWords(tr.ts, fig.now)}, ${addr} · ${parts.join(' · ')}.`);
  });
  if (rule.others !== 'none') {
    const rest = t.read.filter((r) => !shown.includes(r));
    const smaller = t.n - shown.length;
    if (smaller > 0) {
      const onDeck = rest.filter((r) => r.onDeck && r.kind === 'sell');
      // runs of one maker's small trades fold as the tape folds them (series-api.ts foldTrades)
      const rows = rest.filter((r) => !onDeck.includes(r)).sort((a, b) => b.ts - a.ts).map((r) => tradeRowOf({
        id: r.id, ts: r.ts, height: 0, tx_hash: r.txHash, kind: r.kind, from_addr: r.kind === 'sell' ? r.maker : null, to_addr: r.kind === 'buy' ? r.maker : null, amount_num: r.nam,
        counter_denom: null, counter_amount: null, pool_id: r.route.join(','), price_usd: null, value_usd: null, meta: null, maker_label: null, maker_label_source: null, maker_label_author: null,
      }));
      const runs = foldTrades(rows).filter((g) => g.n >= 2);
      const parts: string[] = [];
      if (rule.others === 'full') {
        if (onDeck.length) parts.push(`${onDeck.length} ${plural(onDeck.length, 'sale')} of ${fmtNam(onDeck.reduce((a, r) => a + r.nam, 0))} NAM (on deck)`);
        for (const g of runs) {
          const first = rest.find((r) => r.id === g.ids[g.ids.length - 1])!;
          const rec = first.record && !isNotRead(first.record) ? first.record : null;
          const who = g.maker ? ` by ${code(g.maker)}` : '';
          const record = rec ? ` (${recordWords(rec)}${rec.rank ? `; No. ${rec.rank}${rankSaid ? '' : ' Osmosis holder'} ${m.pass}` : ''})` : '';
          if (rec?.rank) rankSaid = true;
          parts.push(`${g.n} ${g.kind === 'buy' ? 'buys' : 'sales'} of ~${fmtCount(g.nam / g.n)} NAM within ${delayWords(g.lastTs - g.firstTs)}${who}${record}, ${whenWords(g.firstTs, fig.now)}`);
        }
        // every trade of the window not named above falls into "more": the read ones outside the shown rows, the
        // sales on deck and the runs, and the ones past the read
        const more = t.n - shown.length - onDeck.length - runs.reduce((a, g) => a + g.n, 0);
        if (parts.length) lines.push(`Others: ${parts.join(' and ')}${more > 0 ? `; and ${fmtCount(more)} more${t.bounded ? ' (the newest 20,000 ranked)' : ''}` : ''}.`);
        else lines.push(`Others: ${fmtCount(smaller)} smaller ${plural(smaller, 'trade')}${t.bounded ? ' (the newest 20,000 ranked)' : ''}.`);
      } else {
        if (onDeck.length) parts.push(`${onDeck.length} on deck`);
        for (const g of runs) {
          const first = rest.find((r) => r.id === g.ids[g.ids.length - 1])!;
          const rec = first.record && !isNotRead(first.record) ? first.record : null;
          parts.push(`${g.n} ${g.kind === 'buy' ? 'buys' : 'sales'} of ~${fmtCount(g.nam / g.n)} NAM by one address${rec ? ` (${recordWords(rec)})` : ''}`);
        }
        lines.push(`+ ${fmtCount(smaller)} smaller${parts.length ? `: ${parts.join(', ')}` : ''}.`);
      }
    }
  }
  return lines.join('\n');
}

function senderClause(row: DeckRow, rule: LevelRule, m: AttentionMarks): string {
  const s = row.sender;
  if (!s) return '';
  const parts: string[] = [];
  const label = labelClause(s.label, m);
  if (label) parts.push(label);
  if (s.hop && !isNotRead(s.hop)) parts.push(`funded 2 hops back by ${code(s.hop.address)}${s.hop.label ? ` (${labelClause(s.hop.label, m)})` : ''}`);
  if (rule.deckState) {
    const h = s.holder;
    if (isNotRead(h)) parts.push('sender not read');
    // the holder index keeps spendable and staked NAM apart and ranks by their total, so both parts are said
    else if (h && h.balance === 0 && h.stake === 0 && h.updatedAt != null && h.updatedAt >= row.firstTs) parts.push(`emptied by the crossing ${m.listing}`);
    else if (h) parts.push(`holds ${fmtNam(h.balance)} NAM spendable, ${h.stake === 0 ? '0' : `${fmtNam(h.stake)} NAM`} staked ${m.listing}; ${h.above < DIGEST_ATTN_TOP ? `No. ${h.above + 1} of Namada holders` : `not among the ${DIGEST_ATTN_TOP} largest`}`);
    else parts.push(`not listed ${m.listing}`);
  }
  return ` from ${code(s.address)}${parts.length ? ` (${parts.join('; ')})` : ''}`;
}

function deckField(fig: AttentionFigures, rule: LevelRule, m: AttentionMarks): string {
  const d = fig.deck;
  if (isNotRead(d)) return `NAM on deck: not read — ${d.reason}.`;
  if (!d.crossings) return `No crossing Namada → Osmosis in the ${windowWords(fig.kind)} ${m.stream}.`;
  const follows = d.rows.map((r) => r.follow).filter((f): f is DeckFollow => !isNotRead(f));
  const sum = (k: 'soldCounted' | 'sentBackCounted' | 'remaining') => follows.reduce((a, f) => a + f[k], 0);
  const feeAll = follows.length > 0 && follows.every((f) => f.feeNote || f.remaining === 0) && follows.some((f) => f.feeNote);
  const bridgedWithFollow = d.rows.filter((r) => !isNotRead(r.follow)).reduce((a, r) => a + r.bridgedIn, 0);
  // the header counts every crossing (the transfer module's too); the sums below are the listed receivers'
  const scope = d.receivers > d.rows.length ? ` · of the ${d.rows.length} ${plural(d.rows.length, 'receiver')} listed:` : ' ·';
  const bounded = d.bounded ? ` (the newest ${fmtCount(DIGEST_BRIDGE_MAX)} crossings counted)` : '';
  const tail = follows.length
    ? `${scope} sold since ${fmtNam(sum('soldCounted'))} · sent back ${fmtNam(sum('sentBackCounted'))} · still there ${fmtNam(sum('remaining'))} NAM${rule.deckState && feeAll ? ` (the pools' fee in NAM: all ${fmtNam(bridgedWithFollow)} was given, fees in)` : ''}`
    : ' · follow-ups not read';
  const lines = [`In ${fmtNam(d.nam)} NAM (${fmtCount(d.crossings)} ${plural(d.crossings, 'crossing')}, ${fmtCount(d.receivers)} ${plural(d.receivers, 'address', 'addresses')}) ${m.stream}${bounded}${tail}.`];
  const note = passNote(fig);
  d.rows.slice(0, rule.deck).forEach((row, i) => {
    const addr = `${i === 0 && rule.links ? siteLink(row.address) : code(row.address)}${row.label ? ` (${labelClause(row.label, m)})` : ''}`;
    const parts: string[] = [];
    const f = row.follow;
    if (isNotRead(f)) parts.push('follow-ups not read');
    else {
      if (f.sales.length) {
        const first = f.sales[0];
        const one = f.sales.length === 1 ? first : null;
        let price = '';
        if (one) price = `, ${priceWords(one, rule.deckSettleDetail, m, deckSettleClause)}`;
        else {
          const priced = f.sales.filter((s) => s.settle || s.own);
          const usd = priced.reduce((a, s) => a + (s.settle ? s.settle.usdPerNam * s.settle.nam : s.own!.usd * s.nam), 0);
          const nam = priced.reduce((a, s) => a + (s.settle ? s.settle.nam : s.nam), 0);
          price = ` in ${f.sales.length} sales${f.salesBounded ? ` (${DIGEST_ATTN_FOLLOW_MAX}+: the first ${DIGEST_ATTN_FOLLOW_MAX} counted)` : ''}${nam > 0 ? `, ${fmtPrice(usd / nam)} ${m.trades} on average` : ''}`;
        }
        parts.push(`sold ${fmtNam(f.soldSince)} NAM ${delayWords(first.ts - row.firstTs)} later${price}`);
      } else parts.push('no sale yet');
      if (f.bridgedOutSince > 0) parts.push(`sent back ${fmtNam(f.bridgedOutSince)} NAM`);
      if (rule.deckState && !feeAll && f.feeNote) parts.push(`still there ${fmtNam(f.remaining)} NAM is the pools' fee in NAM (all ${fmtNam(row.bridgedIn)} was given, fees in)`);
      if (rule.deckState) parts.push(f.prior.n === 0 ? 'no sale in the 30 d before' : `${f.prior.bounded ? `${fmtCount(DIGEST_ATTN_PRIOR_MAX)}+` : fmtCount(f.prior.n)} ${plural(f.prior.n, 'sale')}, ${fmtNam(f.prior.nam)} NAM in the 30 d before`);
      parts.push(`selling estimate ${Math.round(f.hazard * 100)} % (from its own sales; the Supply page shows it from ${SELLS_MOST_PCT} %)`);
      if (rule.deckState) parts.push(f.holder ? `holds ${fmtNam(f.holder.balance)} NAM on Osmosis ${m.pass}${note ?? ''}` : `holds no NAM on Osmosis now ${m.pass}${note ?? ''}`);
    }
    lines.push(`${addr} in at ${whenWords(row.firstTs, fig.now)}${senderClause(row, rule, m)} · ${parts.join(' · ')}.`);
  });
  if (d.rows.length > rule.deck) lines.push(`and ${d.rows.length - rule.deck} more ${plural(d.rows.length - rule.deck, 'receiver')}.`);
  return lines.join('\n');
}

const RULE_NAMES: Record<UnusualRule, string> = { first: 'the first-trade rule', multiple: 'the five-times rule', withdraw: 'the matured-unbond rule', unshield: 'the unshield-then-bridge rule' };

function eventLine(ev: UnusualEvent, i: number, fig: AttentionFigures, rule: LevelRule, m: AttentionMarks): string {
  const detail = rule.eventDetail;
  const addrOf = (a: string | null, label: LabelWords | null) => (a ? `${i === 0 && rule.links ? siteLink(a) : code(a)}${label ? ` (${labelClause(label, m)})` : ''}` : 'an address not recorded');
  const verb = (k: 'buy' | 'sell') => (k === 'buy' ? 'Bought' : 'Sold');
  switch (ev.rule) {
    case 'first':
      return `• First trade in 90 days from a top-${DIGEST_ATTN_TOP} holder: ${verb(ev.kind)} ${fmtNam(ev.nam)} NAM at ${whenWords(ev.ts, fig.now)} by ${addrOf(ev.address, ev.label)} (No. ${ev.rank} ${m.pass}${detail === 'full' ? `, ${recordWords(ev.record)}` : ''}).`;
    case 'multiple': {
      // one line per maker and side: how many trades over the bar, their NAM in all, when (the trade records' figures)
      const verbed = ev.kind === 'buy' ? 'bought' : 'sold';
      const bar = `${DIGEST_ATTN_MULT}× the median (${fmtNam(ev.bar)} NAM)`;
      return ev.n > 1
        ? `• ${addrOf(ev.address, ev.label)} ${verbed} ${ev.n} times over ${bar}, ${fmtNam(ev.nam)} NAM in all (largest ${fmtNam(ev.largest)}), ${spanWords(ev.ts, ev.lastTs, fig.now)} ${m.stream}.`
        : `• ${addrOf(ev.address, ev.label)} ${verbed} ${fmtNam(ev.nam)} NAM at ${whenWords(ev.ts, fig.now)}, over ${bar} ${m.stream}.`;
    }
    case 'unshield': {
      const out = ev.bridgeOut;
      const tail = isNotRead(out) ? 'the bridge-out could not be read'
        : out ? `and ${fmtNam(out.nam)} NAM of it crossed to Osmosis ${delayWords(out.ts - ev.ts)} later`
          : `no bridge-out yet (${delayWords(fig.now - ev.ts)} since)`;
      return `• ${fmtNam(ev.nam)} NAM left the shielded set at ${whenWords(ev.ts, fig.now)} to ${addrOf(ev.address, ev.label)}, ${tail} ${m.scan}.`;
    }
    case 'withdraw': {
      const head = `• ${fmtNam(ev.nam)} NAM unlocked and withdrawn from staking at ${whenWords(ev.ts, fig.now)} by ${addrOf(ev.address, ev.label)} ${m.scan}`;
      let req: string;
      if (isNotRead(ev.request)) req = ` — the request could not be read ${m.scan}`;
      else if (!ev.request) req = ` — no unbond request on record for this address ${m.scan}`;
      else {
        const v = ev.validator;
        const vName = isNotRead(v) ? 'a validator not read' : v.name ? plainMd(codeSafe(v.name)) : v.address ? code(v.address) : 'a validator not recorded';
        const state = detail === 'full' && !isNotRead(v) && v.state && v.state !== 'consensus' ? ` (listed ${plainMd(codeSafe(v.state))} ${m.validators})` : '';
        const days = Math.floor((ev.ts - ev.request.ts) / D);
        const lead = ev.request.exact ? `requested ${whenWords(ev.request.ts, fig.now)}` : `nearest request on record: ${fmtNam(ev.request.nam)} NAM on ${whenWords(ev.request.ts, fig.now)}`;
        let maturity = '';
        const mt = ev.maturity;
        if (mt?.kind === 'exact') maturity = `; withdrawable from epoch ${fmtCount(mt.epoch)}${mt.at != null ? `, ${detail === 'full' ? `${dayMon(mt.at)} ${hhmm(mt.at)} UTC` : dayMon(mt.at)}` : ''} ${m.clock}`;
        else if (mt?.kind === 'estimate') maturity = detail === 'full'
          ? `; withdrawable from about ${dayMon(mt.at)} ${hhmm(mt.at)} UTC (${mt.epochs} epochs of ${fmtCount(mt.epochSec)} s = ${(mt.epochs * mt.epochSec / 86400).toFixed(1)} d, an estimate up to one epoch late ${m.clock})`
          : `; withdrawable from about ${dayMon(mt.at)} ${m.clock}`;
        else if (mt?.kind === 'none') maturity = `; maturity not computed (${mt.why}) ${m.clock}`;
        req = ` — ${lead} from ${vName}${state}, ${days} ${plural(days, 'day')} earlier ${m.scan}${maturity}`;
      }
      if (detail === 'floor') return `${head}${req}.`;
      const s = ev.since;
      let since: string;
      if (isNotRead(s)) since = `Since: not read ${m.scan}`;
      else {
        const moves: string[] = [];
        if (s.restaked > 0) moves.push(`restaked ${fmtNam(s.restaked)} NAM`);
        if (s.bridgedOut > 0) moves.push(`bridged out ${fmtNam(s.bridgedOut)} NAM`);
        if (s.shielded > 0) moves.push(`shielded ${fmtNam(s.shielded)} NAM`);
        if (s.transferred > 0) moves.push(`transferred ${fmtNam(s.transferred)} NAM to ${s.transferTargets === 1 && s.transferTo ? code(s.transferTo) : `${s.transferTargets} addresses`}`);
        since = moves.length ? `Since: ${moves.join(', ')}${s.bounded ? ' (the first 50 moves counted)' : ''} ${m.scan}`
          : detail === 'full' ? `Since: no restake, bridge-out, shielding or transfer to ${hhmm(fig.now)} ${m.scan}` : `Since: nothing on record to ${hhmm(fig.now)} ${m.scan}`;
      }
      if (detail === 'short') return `${head}${req}. ${since}.`;
      const h = ev.holder;
      const holding = isNotRead(h) ? `holding not read ${m.listing}`
        : h ? `holds ${fmtNam(h.balance)} NAM spendable, ${h.stake === 0 ? '0' : `${fmtNam(h.stake)} NAM`} staked ${m.listing}; ${h.above < DIGEST_ATTN_TOP ? `No. ${h.above + 1} of Namada holders` : `not among the ${DIGEST_ATTN_TOP} largest holders`}`
          : `not on the holder list ${m.listing}`;
      return `${head}${req}. ${since}; ${holding}.`;
    }
  }
}

function unusualField(fig: AttentionFigures, rule: LevelRule, m: AttentionMarks): { text: string; events: number; notReadRules: number } {
  const u = fig.unusual;
  const rules: UnusualRule[] = ['first', 'multiple', 'withdraw', 'unshield'];
  const answered = rules.filter((r) => !isNotRead(u[r]));
  const notReadRules = rules.filter((r) => isNotRead(u[r]));
  const events = answered.flatMap((r) => u[r] as UnusualEvent[]).sort((a, b) => b.nam - a.nam || a.ts - b.ts);
  const lines = events.slice(0, rule.events).map((ev, i) => eventLine(ev, i, fig, rule, m));
  if (events.length > rule.events) lines.push(`and ${events.length - rule.events} more.`);
  const unfired = answered.filter((r) => (u[r] as UnusualEvent[]).length === 0);
  const tradesRead = !isNotRead(fig.trades);
  const whose = fig.kind === 'weekly' ? "the week's" : "today's";
  if (notReadRules.length) {
    const named = `${notReadRules.length} of the four rules not read (${notReadRules.map((r) => RULE_NAMES[r]).join(', ')})`;
    lines.push(rule.notFound === 'named' && unfired.length ? `${named}. Not found by the others: ${unfired.map((r) => notFoundWords(r, fig, m, tradesRead, whose)).join('; ')}.` : `${named}.`);
  } else if (unfired.length) {
    lines.push(rule.notFound === 'named' ? `Not found: ${unfired.map((r) => notFoundWords(r, fig, m, tradesRead, whose)).join('; ')}.` : 'Nothing else by the four rules.');
  }
  return { text: lines.join('\n'), events: events.length, notReadRules: notReadRules.length };
}

function notFoundWords(r: UnusualRule, fig: AttentionFigures, m: AttentionMarks, tradesRead: boolean, whose: string): string {
  const t = fig.trades;
  switch (r) {
    case 'first': {
      const tr = fig.unusual.traders;
      const total = tr ? `${fmtCount(tr.total)}${tr.bounded ? ' most active' : ''}` : '';
      const why = !tr || !tr.total ? '(no trades)' : tr.top === 0 ? `(none of ${whose} ${total} ${plural(tr.total, 'trader')} is a top-${DIGEST_ATTN_TOP} holder ${m.pass})`
        : `(${tr.top} of ${whose} ${total} ${plural(tr.total, 'trader')} ${tr.top === 1 ? 'is' : 'are'} top-${DIGEST_ATTN_TOP}, each with earlier trades ${m.pass})`;
      return `a first trade from a top-${DIGEST_ATTN_TOP} Osmosis holder ${why}`;
    }
    case 'multiple':
      return `a trade over ${DIGEST_ATTN_MULT}× the median (${!tradesRead || isNotRead(t) ? 'not checked: trades not read' : t.median == null ? `too few trades for a median: ${t.n}` : `${fmtNam(t.median * DIGEST_ATTN_MULT)} NAM`})`;
    case 'withdraw':
      return `a withdrawal of a matured unbond ≥ ${fmtCount(DEFAULT_THRESHOLDS.unlock)} NAM (none ${m.scan})`;
    case 'unshield':
      return `a bridge-out after an unshielding ≥ ${fmtCount(DEFAULT_THRESHOLDS.unshield)} NAM (none ${m.scan})`;
  }
}

/** What the picture's quote line covers: "over the 24 h", or the window with its start and the stretches without a reading. */
function coverageWords(fig: AttentionFigures): string {
  const over = `over the ${windowWords(fig.kind)}`;
  if (isNotRead(fig.series)) return over;
  const cov = quoteCoverage(fig.series);
  if (!cov) return over;
  const parts: string[] = [];
  if (fig.seriesBounded) parts.push(`the newest ${fmtCount(fig.series.length)} readings only`);
  else if (cov.first - fig.from > DIGEST_ATTN_PNG_GAP_MS) parts.push(`from ${whenWords(cov.first, fig.now)}`);
  if (cov.gaps.length) {
    // the two longest stretches are named, in time order; the rest are counted
    const longest = [...cov.gaps].sort((x, y) => (y[1] - y[0]) - (x[1] - x[0]) || x[0] - y[0]).slice(0, 2).sort((x, y) => x[0] - y[0]);
    const named = longest.map(([a, b]) => spanWords(a, b, fig.now)).join(', ');
    parts.push(`no reading ${named}${cov.gaps.length > 2 ? ` and ${cov.gaps.length - 2} more ${plural(cov.gaps.length - 2, 'gap')}` : ''}`);
  }
  return parts.length ? `${over} (${parts.join('; ')})` : over;
}

function description(fig: AttentionFigures, rule: LevelRule, m: AttentionMarks, events: number, notReadRules: number, picture: AttentionPicture | null | undefined, pictureNote?: string | null): string {
  const t = fig.trades;
  const parts: string[] = [];
  if (isNotRead(t)) parts.push(`Trades: not read — ${t.reason}`);
  else if (!t.n) parts.push(`No trade in the ${windowWords(fig.kind)} ${m.stream}`);
  else {
    parts.push(`${fmtCount(t.n)} ${plural(t.n, 'trade')} by ${fmtCount(t.traders)} ${plural(t.traders, 'address', 'addresses')}, ${fmtNam(t.nam)} NAM ${m.stream} (bot round trips left out${t.bounded ? `; more than ${fmtCount(DIGEST_TRADES_MAX)} trades: the newest ${fmtCount(DIGEST_TRADES_MAX)} counted` : ''})`);
    parts.push(t.median != null ? `typical trade ${fmtNam(t.median)} NAM (the median)` : `too few trades for a median: ${t.n}`);
  }
  parts.push(notReadRules ? `${events} unusual ${plural(events, 'event')}, ${notReadRules} of the four rules not read` : events ? `${events} unusual ${plural(events, 'event')} by the four rules` : 'no unusual event by the four rules');
  let text = `${parts.join('; ')}.`;
  if (fig.indexBehind) text += ` Counted to ${hhmm(fig.indexBehind.countedTo)} UTC only ${m.stream} — this site's Osmosis index is behind${fig.indexBehind.height != null ? ` (swept to height ${fmtCount(fig.indexBehind.height)})` : ''}; moves since are not counted.`;
  if (picture) {
    const noRings = picture.ringsOff ? `trades drawn without rings (more than ${fmtCount(DIGEST_ATTN_PNG_RING_MAX)})` : null;
    const off = picture.offAxis ? `; ${fmtCount(picture.offAxis)} ${plural(picture.offAxis, 'trade')} under ${DIGEST_ATTN_AXIS_MIN_NAM} NAM priced off the axis not drawn` : '';
    text += rule.legend === 'long'
      ? ` Picture: the quote ${coverageWords(fig)} with each trade at its own price — blue bought, orange sold, area by NAM, ${noRings ?? (picture.ringed > 1 ? `the ${picture.ringed} largest ringed yellow` : 'the largest ringed yellow')}${off} ${m.quote} ${m.trades}.`
      : ` Picture: the quote ${coverageWords(fig)}; blue bought, orange sold, ${noRings ?? 'the largest ringed yellow'} ${m.quote} ${m.trades}.`;
  } else if (pictureNote) {
    text += ` No picture: ${pictureNote} ${m.quote}.`;
  }
  return text;
}

/**
 * A field's text as Discord fields of at most 1,024 characters: whole lines, a field that would run over continued in
 * a field named "<name> (cont.)", so no line is cut; only a single line past 1,024 is cut (cutField).
 */
export function fieldsOf(name: string, text: string): EmbedField[] {
  const out: EmbedField[] = [];
  let cur: string[] = [];
  const flush = () => { if (cur.length) out.push({ name: out.length ? `${name} (cont.)` : name, value: cutField(cur.join('\n')), inline: false }); cur = []; };
  for (const line of text.split('\n')) {
    if (cur.length && [...[...cur, line].join('\n')].length > DISCORD_FIELD_MAX) flush();
    cur.push(line);
  }
  flush();
  return out;
}

/** The embed at one level. A field longer than Discord's 1,024 characters continues in the next; the title is the window's. */
export function attentionEmbed(fig: AttentionFigures, level: AttentionLevel, opts: AttentionBuildOptions = {}): AttentionRender {
  const rule = LEVELS[level];
  const m: AttentionMarks = { ...DEFAULT_MARKS, ...(opts.marks ?? {}) };
  const unusual = unusualField(fig, rule, m);
  const fields: EmbedField[] = [
    ...fieldsOf('Largest trades', tradesField(fig, rule, m)),
    ...fieldsOf('NAM on deck', deckField(fig, rule, m)),
    ...fieldsOf('Unusual', unusual.text),
  ];
  const desc = description(fig, rule, m, unusual.events, unusual.notReadRules, opts.picture, opts.pictureNote);
  const body = `${desc}\n${fields.map((f) => f.value).join('\n')}`;
  const own: string[] = [];
  // the marks the wiring gave the section's own numbers (the quote's readings, the trades' own prices), in mark order
  const ownMarked = (['quote', 'trades'] as const)
    .filter((k) => opts.ownSources?.[k] && body.includes(m[k]))
    .map((k) => ({ mark: m[k], text: opts.ownSources![k]! }));
  if (body.includes(m.labels)) own.push(rule.sources === 'short' ? `${m.labels} this site's label index` : `${m.labels} this site's label index (genesis file; a wallet's tag says "Tag by …")`);
  if (body.includes(m.coinQuote)) {
    const coins = coinsQuoted(fig).join('/') || 'coin';
    own.push(rule.sources === 'short' ? `${m.coinQuote} Osmosis ${coins} quote at the trade's minute` : `${m.coinQuote} Osmosis ${coins} quote at the trade's minute (≤ 5 min before)`);
  }
  for (const o of ownMarked) own.push(`${o.mark} ${o.text}`);
  own.sort((a, b) => supValue(a) - supValue(b));
  let sourcesAppend: string | null = null;
  if (own.length && rule.sources !== 'none') fields.push({ name: 'Sources (this embed)', value: cutField(`${own.join(' · ')} · other marks: the digest's Sources.`), inline: false });
  else if (own.length) sourcesAppend = own.join(' · ');
  const embed: Embed = {
    title: `Trades worth attention · ${windowWords(fig.kind)} to ${hhmm(fig.now)} UTC, ${dayMonYear(fig.now)}`,
    description: desc,
    color: DIGEST_ATTN_COLOUR,
    fields,
    ...(opts.picture ? { image: { url: `attachment://${opts.pictureName ?? 'attention.png'}` } } : {}),
  };
  return { level, embed, chars: embedChars(embed), sourcesAppend };
}

/** The four levels, measured. */
export function attentionLevels(fig: AttentionFigures, opts: AttentionBuildOptions = {}): Record<AttentionLevel, AttentionRender> {
  return Object.fromEntries(DIGEST_ATTN_LEVELS.map((l) => [l, attentionEmbed(fig, l, opts)])) as Record<AttentionLevel, AttentionRender>;
}

export type AttentionFit = AttentionRender | { leftOut: true; over: number; note: string };

/**
 * The fit rule for this embed alone: the first level, A0 down to A3, whose characters fit the room the message has
 * left for it. A3 is the floor; when even A3 does not fit the embed is left out as a whole and the digest says so.
 * The digest's own fit() orders this against its other trims (A0 → A1 first, its own lines, then A1 → A2 → A3).
 */
export function attentionForRoom(fig: AttentionFigures, room: number, opts: AttentionBuildOptions = {}): AttentionFit {
  let last: AttentionRender | null = null;
  for (const level of DIGEST_ATTN_LEVELS) {
    last = attentionEmbed(fig, level, opts);
    if (last.chars <= room) return last;
  }
  const over = (last?.chars ?? 0) - room;
  return { leftOut: true, over, note: `Trades worth attention: left out for room (${fmtCount(over)} characters over)` };
}

/** The fold rule the Others line uses is the tape's (series-api.ts foldTrades): under this many NAM, within this long of the next. */
export const ATTENTION_FOLD = { underNam: TRADE_FOLD_UNDER_NAM, withinMs: TRADE_FOLD_MS } as const;
