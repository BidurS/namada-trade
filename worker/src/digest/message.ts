// The daily and weekly digest's Discord message, built from a figures object (the digest spec of 2026-10-23, sections
// 6 to 9): the shared embed with its eleven fields and its Sources entries, the superscript marks every figure ends
// with, the "not read" line shapes, the late note, the operator's embed, a subscriber's watchlist embed, the
// attachment references for the charts that are present, and fit(), which trims a message into Discord's limits in
// the documented order. Nothing here reads a database or posts anything: every function is a pure function of its
// input and a fixed "now", so the tests run on literal figures. The figures object is defined here from the spec; the
// module that reads it from D1 is written apart and fills this shape.
import type { Provenance } from '../../../shared/types';
import { DIGEST_HOUR_UTC } from '../../../shared/alerts';
import { explorerHashOf, safeHttpUrl } from '../../../shared/flow-rules';
import { NAMADA } from '../config';
import { NAMADA_CURSOR_MAX_LAG, NAMADA_CURSOR_STALE_MS, OSMOSIS_LIVE_STALE_MS, OSMOSIS_SWEEP_STALE_MS } from '../analytics';
import type { PriceBasisCounts } from './figures';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// ------------------------------------------------------------------------------------------------- constants

/** The digest is due from this hour of each UTC day (shared with the Settings page, which names it). */
export { DIGEST_HOUR_UTC };
/** A digest sent later than this after 08:00 UTC says so in its description. */
export const DIGEST_LATE_NOTE_MS = 2 * MIN;
/** A subscriber's watchlist embed shows at most this many lines before "and N more"; fit() trims to 10, then 5. */
export const DIGEST_WATCH_LINES = 20;
/** One run reads at most this many watched addresses over every subscriber (the per-user read's cap). */
export const DIGEST_WATCH_ADDRS_MAX = 5_000;
/** The shared embed's character budget, as Discord counts (title, description, field names and values, footer). */
export const DIGEST_SHARED_MAX = 4_600;
/** The recipient's own embed's budget (the operator's, or the watchlist). */
export const DIGEST_OWN_MAX = 1_200;
/** The whole message's budget, a margin under Discord's 6,000 over every embed. */
export const DIGEST_MESSAGE_MAX = 5_800;
/** The window's trade rows are read up to this many (the newest); past it the line says so. */
export const DIGEST_TRADES_MAX = 20_000;
/** Discord's own limits, which fit() never exceeds. */
export const DISCORD_FIELD_MAX = 1_024;
export const DISCORD_TITLE_MAX = 256;
export const DISCORD_DESCRIPTION_MAX = 4_096;
export const DISCORD_FIELDS_MAX = 25;
export const DISCORD_EMBEDS_MAX = 10;
export const DISCORD_MESSAGE_MAX = 6_000;
/** The same bound as the governance alert puts on a proposal's own discussion link. */
export const GOV_LINK_MAX = 512;

export const DIGEST_URL = 'https://namada.trade/';
export const DIGEST_COLOR_DAILY = 0x5865f2;
export const DIGEST_COLOR_WEEKLY = 0x3498db;
export const DIGEST_COLOR_OPERATOR = 0xfee75c;
export const DIGEST_COLOR_WATCHLIST = 0x9b59b6;

/** A minute key's "now" reading must be within this of T to be shown. */
export const MINUTE_KEY_BOUND_MS = 10 * MIN;
/** A figure whose stamp is older than this (and than its key's cadence) also shows its time inline. */
export const INLINE_AS_OF_MS = 15 * MIN;
/** A base reading is taken within this much before its instant. */
export const BASE_WINDOW_MS = 2 * HOUR;
/** The executed hourly price is compared with the quote only while the hour is this recent (the price check's rule). */
export const EXECUTED_COMPARE_MS = 6 * HOUR;
/** The Osmosis holder pass is "current" while the last pass that added up to the supply started within this. */
export const OSMOSIS_PASS_TRUST_MS = 6 * HOUR;
/** The spec's "not read" reason for a section whose statements threw. */
export const DB_NOT_ANSWERED = 'the database did not answer this read';

/** How often each kind of key is written; a key's "now" bound is max(10 min, 3 × its cadence). */
export const CADENCE = { minute: MIN, bondListing: 40 * MIN, balanceListing: HOUR, hourly: HOUR } as const;
export const boundOf = (cadenceMs: number): number => Math.max(MINUTE_KEY_BOUND_MS, 3 * cadenceMs);

// ------------------------------------------------------------------------------------------------- the figures (input)

export type DigestKind = 'daily' | 'weekly';

/** A figure whose source did not answer: the last reading's time is given, its value is not. */
export interface NotRead { notRead: true; source: string; lastAt: number | null; reason: string }
export const isNotRead = (x: unknown): x is NotRead => typeof x === 'object' && x !== null && (x as NotRead).notRead === true;
/** A section figure: its value, or why it is not read. `prov` is the reader's provenance, carried for the API. */
export type Figure<T> = { value: T; prov?: Provenance } | NotRead;

export type ChangeLabel = '24 h' | '7 d' | '30 d';
/** The reading a change is measured against, or why there is none. */
export type Base =
  | { at: number; value: number }
  | { gap: { from: number; to: number } }
  | { seriesStart: number };
export interface ChangeBase { label: ChangeLabel; instant: number; base: Base }
/** A metrics key's "now" reading with the base(s) its changes are measured against. */
export interface Metric { value: number; at: number; cadenceMs: number; bases: ChangeBase[] }
export type MetricFigure = Metric | NotRead;

export interface ListingStamp { at: number; height: number | null; epoch?: number | null; provider: string | null }
/** The epoch clock: the current epoch, where it began (the first reading of its value) and the chain's epoch length. */
export interface EpochClock {
  epoch: number;
  at: number;
  /** the first reading of this epoch's value; null when none in the last two epochs (the clock is then "about") */
  startedAt: number | null;
  /** the reading gap before that first reading: the anchor's error */
  plusMinusMs: number | null;
  /** kv chain.params; null when missing or older than 24 h (epochs only, no clock time) */
  params: { epochSec: number; epochSecNote: string | null; fetchedAt: number } | null;
}
export interface NamadaIndex { cursor: number | null; cursorAt: number | null; head: number | null }
export interface OsmosisIndex {
  live: { connected: boolean; at: number; height: number | null } | null;
  sweep: { height: number; at: number } | null;
}
export interface Anchors {
  namada: NamadaIndex | null;
  osmosis: OsmosisIndex | null;
  bondListing: ListingStamp | null;
  balanceListing: ListingStamp | null;
  epoch: EpochClock | null;
}

export interface StakedValue { totalStake: MetricFigure; posAccount: MetricFigure; stakers: MetricFigure; validators: MetricFigure }

export interface LargestRequest {
  amount: number; ts: number; height: number;
  /** the row's tx_hash and meta.wrapper, for the explorer link; no link when the hash is not known */
  txHash?: string | null; wrapper?: string | null;
  validator: string | null;
  /** how many requests of this size the window holds (1 when no tie) and how many validators they went to */
  ties: number; tieValidators: number;
}
export interface RequestSide { n: number; nam: number; late: number; largest: LargestRequest | null }
export interface RequestsValue { bonds: RequestSide; unbonds: RequestSide; decodeFailures: number }

export interface Bucket { epoch: number; nam: number; n: number }
export interface PipelineValue {
  /** the bond listing the in-flight and withdrawable figures come from (L_now) */
  listing: ListingStamp;
  inFlight: number;
  withdrawable: number;
  /** the oldest epoch still in the queue, for "(epochs 56–2,696)" */
  queueFromEpoch: number | null;
  /** the listing at the base instant (L_24 or L_7) and its withdrawable figure; null when no listing in its window */
  base: { listing: ListingStamp; withdrawable: number } | null;
  /** the epoch running at the base instant, for the matured range when the base listing is missing */
  baseEpoch: number | null;
  /** withdraw flows in (L_base.ts, L_now.ts] */
  withdrawnBetween: { nam: number; n: number };
  /** the queue's direct sum over the matured epochs; null when the base epoch is unknown */
  directMatured: { nam: number; n: number } | null;
  /** the window's withdraw row: count, NAM, the largest, the time of the one withdrawal when there is one */
  withdrawn: { n: number; nam: number; largest: number; ts: number | null };
  /** unbond_queue rows with withdraw_epoch after the current epoch, ascending */
  buckets: Bucket[];
}

export interface RewardsValue { n: number; nam: number; largest: number; late: number }

/**
 * How the quote was read, as the site names a stored price (price-how.ts storedPriceSource and storedPriceNote): the
 * price list's name, or the route's with the note that says why and which pools; absent, the quote service's name.
 */
/** How the quote was read, as the site names a stored price; `bases`: a change's base read another way, with that way's name. */
export interface QuoteSource { name: string; note?: string; bases?: { label: ChangeLabel; name: string }[] }
export interface PriceValue { quote: MetricFigure; source?: QuoteSource }

export interface TradesValue {
  /** price.swap_1h's last hour (the trusted trades' median) with its trade count (null when the count row is missing);
   *  null when no hour is on record; a NotRead when the read itself failed */
  executed: { hourStart: number; price: number; n: number | null } | null | NotRead;
  /** the window's trusted trades; printed only from two trades */
  vwap: { n: number; vwap: number; lo: number; hi: number } | null;
  /** `usd` is null when no trade of the window carries a price (the sum of no values is not 0) */
  window: { n: number; nam: number; usd: number | null; unpriced: number; traders: number; buyNam: number; sellNam: number; overBound: boolean; basis?: PriceBasisCounts | null };
  /** the Osmosis data API's own figure (24 h, or 7 d for the weekly), in USD */
  dataApi: MetricFigure;
}

export interface BridgeSide { n: number; nam: number; largest: number; late: number }
/** The Osmosis records: ibc_in is NAM arriving on Osmosis (Namada → Osmosis), ibc_out NAM leaving it for Namada. */
export interface BridgeValue { ibcIn: BridgeSide; ibcOut: BridgeSide; refunded: { n: number; nam: number }; escrow: MetricFigure }

export interface Count { n: number; nam: number }
export interface MaspValue { shield: Count; ibcIn: Count; unshield: Count; ibcOut: Count; feesNam: number; balance: MetricFigure }

export interface Top10 { nam: number; at: number; previousPct: number | null }
export interface HoldersValue {
  namada: MetricFigure;
  osmosis: MetricFigure;
  /** kv osmosis.holders.pass trustedStartedAt; the count is "not current" when older than 6 h, or when no pass has
   *  ever added up to the supply ('never') */
  osmosisPassTrustedAt: number | null | 'never';
  /** null: no top-10 clause; a NotRead: the clause says the sum was not read and the Sources entry says so */
  namadaTop10: Top10 | NotRead | null;
  osmosisTop10: Top10 | NotRead | null;
  /** the denominators: minted NAM (Namada RPC) and the NAM on Osmosis (Keplr supply) */
  mintedNam: MetricFigure;
  osmosisNam: MetricFigure;
  stakeTop10Pct: MetricFigure;
}

export interface Proposal { id: number; title: string; status: string; type: string; startEpoch: number; endEpoch: number; discussionsUrl: string | null }
export interface GovValue {
  fetchedAt: number;
  indexerEpoch: number | null;
  /** page 1 of the indexer's list, newest first */
  proposals: Proposal[];
  opened: { id: number; at: number }[];
  closed: { id: number; status: string; at: number }[];
}

export interface ValidatorDay { day: string; validators: number; stake: number; asOf: number; height: number; namesAt: number | null }
export interface Mover { validator: string; name: string | null; state: string | null; d: number; delegatorsToday: number | null; delegatorsBase: number | null }
export interface ValidatorsValue {
  today: ValidatorDay;
  base: ValidatorDay;
  /** true when today's rows do not exist yet and the two newest days were compared */
  noListingToday: boolean;
  /** true when the day a period back has no snapshot and the oldest day present is the base (the table's first days) */
  baseIsOldest?: boolean;
  /** validators whose state is not on record in one of the two snapshots: not compared, never counted as a change */
  statesNotCompared?: number;
  joined: number;
  left: number;
  gross: number;
  movers: Mover[];
  stateChanges: { validator: string; name: string | null; from: string | null; to: string | null }[];
}

/** A chart the post attaches, or the sentence saying why it is left out. */
export interface ChartRef {
  /** the attachment's file name, referenced as attachment://<file> */
  file: string;
  /** "Price, 7 days" */
  title: string;
  /** the caption (the legend lives in the text), or the "no chart" sentence when the picture is left out */
  caption: string;
  notes?: string[];
  present: boolean;
}

export interface DigestFigures {
  kind: DigestKind;
  now: number;
  from: number;
  to: number;
  anchors: Anchors;
  staked: Figure<StakedValue>;
  requests: Figure<RequestsValue>;
  pipeline: Figure<PipelineValue>;
  rewards: Figure<RewardsValue>;
  price: Figure<PriceValue>;
  trades: Figure<TradesValue>;
  bridge: Figure<BridgeValue>;
  masp: Figure<MaspValue>;
  holders: Figure<HoldersValue>;
  governance: Figure<GovValue>;
  validators: Figure<ValidatorsValue>;
  charts?: ChartRef[];
}

/** The operator's own figures (section 8). */
export interface HealthFlip { name: string; from: number; to: number | null; note: string }
export interface DigestLast { key: string; at: number; targets: number; posted: number; skipped: number }
export interface OperatorFigures {
  /** `since` is when a source went not ok (the health log's flip); null when that is not on record, and the line then
   *  gives `asOf`, the row's last probe (source.health keeps one row a name, rewritten every tick) */
  health: Figure<{ ok: number; total: number; notOk: { name: string; since: number | null; asOf?: number; note: string }[] }>;
  /** the health log's entries in the window, grouped; firstAt is the log's oldest entry (null when empty) */
  healthLog: Figure<{ firstAt: number | null; flips: HealthFlip[] }>;
  /** `since` is when the check's state began (the health log's flip); null when that is not on record, and the line
   *  then gives `asOf`, the last time the check ran */
  checks: Figure<{ ok: number; total: number; failing: { key: string; status: string; since: number | null; asOf?: number }[]; idle?: string[] }>;
  claims: Figure<{ n: number; moves: number; crossings: number; firstAt: number | null; lastAt: number | null }>;
  /** kv alerts.skipped when its last case is in the window; a NotRead when the record could not be read */
  skipped: { what: string; n: number; at: number; total: number } | null | NotRead;
  /** the previous period's digest.last, the days with no digest, and this one's targets; `sentWithoutRecord` when the
   *  previous period's claim exists but no delivery record was written for it */
  previous: { last: DigestLast | null; missed: string[]; sentWithoutRecord?: boolean } | NotRead;
  channels: number;
  subscribers: number;
  watchCapWallets: number;
}

/** One watched address's line: the spendable NAM now and at the base instant, each with its reading's time. */
export interface WatchLine {
  address: string;
  chain: 'namada' | 'osmosis';
  /** spendable NAM now; null when the chain lists none for it */
  now: number | null;
  nowAt: number | null;
  /** the base reading; null when no span covers the instant ("not known") */
  base: number | null;
  baseAt: number | null;
}

// ------------------------------------------------------------------------------------------------- the message (output)

export interface EmbedField { name: string; value: string; inline?: boolean }
export interface Embed {
  title?: string;
  url?: string;
  color?: number;
  description?: string;
  fields?: EmbedField[];
  footer?: { text: string };
  timestamp?: string;
  image?: { url: string };
}

/** What fit() may shrink: chart captions to their first sentence, the governance titles, the Sources entries' provider
 *  names (none of these drops a figure), the watchlist lines, then the validator movers and the attached charts'
 *  captions (these drop figures, so they come only when the shared embed is over the whole message's budget). */
export interface TrimState { captions: 'full' | 'first' | 'none'; movers: 5 | 3 | 0; govTitle: 80 | 40; watchLines: 20 | 10 | 5; providers: boolean }
export const TRIM_FULL: TrimState = { captions: 'full', movers: 5, govTitle: 80, watchLines: 20, providers: true };
export type TrimStep = 'captions' | 'movers' | 'govTitle' | 'watchLines' | 'providers' | 'captionsOff';
export const TRIM_ORDER: readonly TrimStep[] = ['captions', 'govTitle', 'providers', 'watchLines', 'watchLines', 'movers', 'movers', 'captionsOff'];
/** The shared embed's steps that drop no figure (it is brought within its share by these alone). */
export const SHARED_SOFT_STEPS: readonly TrimStep[] = ['captions', 'govTitle', 'providers'];
/** The shared embed's steps that drop figures: only when it is over the whole message's budget on its own. */
export const SHARED_HARD_STEPS: readonly TrimStep[] = ['movers', 'captionsOff'];
/** The step that changes a watchlist embed. */
const OWN_STEPS: readonly TrimStep[] = ['watchLines'];
/** The shared embed's limit when it travels without the recipient's own embed: the whole message's budget (the
 *  chart gallery's embeds carry no text). */
export const DIGEST_SHARED_ALONE_MAX = DIGEST_MESSAGE_MAX;

/** The state after one more step, or null when that step has nothing left to shrink. */
export function trimNext(t: TrimState, step: TrimStep): TrimState | null {
  switch (step) {
    case 'captions': return t.captions === 'full' ? { ...t, captions: 'first' } : null;
    case 'captionsOff': return t.captions !== 'none' ? { ...t, captions: 'none' } : null;
    case 'movers': return t.movers === 5 ? { ...t, movers: 3 } : t.movers === 3 ? { ...t, movers: 0 } : null;
    case 'govTitle': return t.govTitle === 80 ? { ...t, govTitle: 40 } : null;
    case 'watchLines': return t.watchLines === 20 ? { ...t, watchLines: 10 } : t.watchLines === 10 ? { ...t, watchLines: 5 } : null;
    case 'providers': return t.providers ? { ...t, providers: false } : null;
  }
}

export interface DigestBody {
  key: string;
  what: string;
  kind: DigestKind;
  /** the shared embed, built once and identical for every recipient (fitShared) */
  shared: Embed;
  /** the trim the shared embed was built at, and whether the last resort had to cut it */
  trim: TrimState;
  hardCut: boolean;
  /** charts 2 to 4 as embeds sharing the digest's url (Discord shows them as one gallery under it) */
  gallery: Embed[];
  /** the attachment names the post must carry */
  files: string[];
  /** the Sources entries as `shared` lists them */
  marks: Mark[];
  /** the shared embed at any trim, for fit() */
  render: (t: TrimState) => Embed;
}

// ------------------------------------------------------------------------------------------------- words

/** Text an outsider wrote (a proposal title, a validator name): Discord's masked-link syntax is broken. */
export const plainMd = (s: string): string => s.replace(/\]\(/g, '] (');
/** A value shown inside a code span: a backtick or line break could close the span. */
export const codeSafe = (s: string): string => s.replace(/[`\r\n]/g, '');
/** An address shortened as the alerts shorten a party: the first 14 and last 6 characters in a code span. */
export const shortAddr = (a: string): string => `\`${codeSafe(a.slice(0, 14))}…${codeSafe(a.slice(-6))}\``;

const MINUS = '−';
const SUPERSCRIPT = ['⁰', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹'];
export const sup = (n: number): string => [...String(n)].map((d) => SUPERSCRIPT[Number(d)] ?? d).join('');
export const SUP_RE = /[⁰¹²³⁴⁵⁶⁷⁸⁹]/;

const abs2 = (x: number): string => Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** "373,220.00"; a negative number carries the minus sign. */
export const num2 = (x: number): string => `${x < 0 ? MINUS : ''}${abs2(x)}`;
export const nam = (x: number): string => `${num2(x)} NAM`;
/** "+467,207.00" / "−720,267.35"; zero is "+0.00" (callers say "no change" where that is the figure). */
export const signed2 = (x: number): string => `${x < 0 ? MINUS : '+'}${abs2(x)}`;
export const signedNam = (x: number): string => `${signed2(x)} NAM`;
export const int = (x: number): string => `${x < 0 ? MINUS : ''}${Math.abs(Math.round(x)).toLocaleString('en-US')}`;
export const signedInt = (x: number): string => `${x < 0 ? MINUS : '+'}${Math.abs(Math.round(x)).toLocaleString('en-US')}`;
/** A share or change as a percentage with two decimals and a sign: "+0.17 %". `x` is a ratio (0.0017). */
export const pct = (x: number): string => `${x < 0 ? MINUS : '+'}${(Math.abs(x) * 100).toFixed(2)} %`;
/** An unsigned percentage of a ratio: "4.68 %". */
export const pctAbs = (x: number): string => `${(Math.abs(x) * 100).toFixed(2)} %`;
/** A stored percentage (53.15 for 53.15 %). */
export const pctStored = (x: number): string => `${x.toFixed(2)} %`;
export const usdPrice = (x: number): string => `$${x.toFixed(8)}`;
export const usd = (x: number): string => `${x < 0 ? MINUS : ''}$${abs2(x)}`;
export const plural = (n: number, one: string, many = `${one}s`): string => `${int(n)} ${n === 1 ? one : many}`;
const COUNT_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
export const countWord = (n: number): string => COUNT_WORDS[n] ?? int(n);

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = (n: number): string => String(n).padStart(2, '0');
const utcDay = (ts: number): number => Math.floor(ts / DAY);
export const clock = (ts: number): string => { const d = new Date(ts); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
export const dayMon = (ts: number): string => { const d = new Date(ts); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };
export const dayMonYear = (ts: number): string => `${dayMon(ts)} ${new Date(ts).getUTCFullYear()}`;
export const dowDayMonYear = (ts: number): string => `${DOW[new Date(ts).getUTCDay()]} ${dayMonYear(ts)}`;
export const dayMonClock = (ts: number): string => `${dayMon(ts)} ${clock(ts)}`;
export const isoDate = (ts: number): string => new Date(ts).toISOString().slice(0, 10);
/** "HH:MM UTC" on T's UTC day, "HH:MM UTC yesterday" the day before, else "D Mon HH:MM UTC". */
export function timeWords(ts: number, now: number): string {
  const d = utcDay(now) - utcDay(ts);
  if (d === 0) return `${clock(ts)} UTC`;
  if (d === 1) return `${clock(ts)} UTC yesterday`;
  return `${dayMonClock(ts)} UTC`;
}
/** As timeWords, with "today" said on T's day: the validators' listing times and the alerts' last claim name both days. */
export const timeWordsToday = (ts: number, now: number): string => (utcDay(now) === utcDay(ts) ? `${clock(ts)} UTC today` : timeWords(ts, now));
/** The "vs" clause's time: " at HH:MM UTC yesterday" or ", D Mon HH:MM UTC" for another day. */
export function atWords(ts: number, now: number): string {
  const d = utcDay(now) - utcDay(ts);
  return d === 0 || d === 1 ? ` at ${timeWords(ts, now)}` : `, ${timeWords(ts, now)}`;
}
/** The day a clock time belongs to when it is not T's: " yesterday" or ", D Mon". */
function dayTail(ts: number, now: number): string {
  const d = utcDay(now) - utcDay(ts);
  return d === 0 ? '' : d === 1 ? ' yesterday' : `, ${dayMon(ts)}`;
}
/** "3 min", "1 h 48 min", "2 h", "5 h 2 min". */
export function ago(ms: number): string {
  const m = Math.max(0, Math.round(ms / MIN));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

// ------------------------------------------------------------------------------------------------- keys and timing

/** 08:00 UTC of now's UTC date: when the day's digest is due. */
export function digestDueAt(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), DIGEST_HOUR_UTC);
}
/** The ISO week of a date, "2026-W44": the week that holds its Thursday. */
export function isoWeek(ts: number): string {
  const d = new Date(Date.UTC(new Date(ts).getUTCFullYear(), new Date(ts).getUTCMonth(), new Date(ts).getUTCDate()));
  const dow = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dow);
  const year = d.getUTCFullYear();
  const week = Math.ceil(((d.getTime() - Date.UTC(year, 0, 1)) / DAY + 1) / 7);
  return `${year}-W${pad(week)}`;
}
/** The claim key of a period: alert:digest:daily:<date> or alert:digest:weekly:<ISO week>. */
export const digestKey = (now: number, kind: DigestKind): string =>
  kind === 'daily' ? `alert:digest:daily:${isoDate(now)}` : `alert:digest:weekly:${isoWeek(now)}`;
/** The label postAll and the health row show: "digest 2026-10-23" or "weekly digest 2026-W44"; never an address. */
export const digestLabel = (now: number, kind: DigestKind): string =>
  kind === 'daily' ? `digest ${isoDate(now)}` : `weekly digest ${isoWeek(now)}`;
/** The late note of section 2 when the send is more than DIGEST_LATE_NOTE_MS after 08:00 UTC; '' otherwise. */
export function lateNote(now: number): string {
  const late = now - digestDueAt(now);
  if (late <= DIGEST_LATE_NOTE_MS) return '';
  return ` Sent at ${clock(now)} UTC, the first run at or after ${pad(DIGEST_HOUR_UTC)}:00 UTC in which it could be sent (${ago(late)} late).`;
}

// ------------------------------------------------------------------------------------------------- marks

/** The sources a digest cites, in the order of the sections that own them: the numbering follows this order over the
 *  marks the digest uses, so a source several fields share keeps one number. */
export const MARK_ORDER = [
  'totalStake', 'posBalance', 'namadaScan', 'bondListing', 'epochClock', 'sqsQuote', 'tradeIndex', 'osmosisIndex', 'dataApi',
  'escrow', 'maspBalance', 'balanceListing', 'namadaTop10', 'osmosisHolders', 'osmosisTop10', 'proposals', 'validatorDaily',
] as const;
export type MarkKey = (typeof MARK_ORDER)[number];
/** A Sources entry: the source and its time, the provider name fit() may drop, and a tail that cites another mark. */
export interface MarkEntry { text: string; provider?: string | null; tail?: string }
export interface Mark extends MarkEntry { n: number; key: MarkKey }

class Marks {
  private readonly numbers = new Map<MarkKey, number>();
  private readonly entries = new Map<MarkKey, MarkEntry>();
  /** With an order, the numbers are fixed by it; without, a key takes the next number when first used (the collecting pass). */
  constructor(order: readonly MarkKey[] | null) {
    if (order) order.forEach((k, i) => this.numbers.set(k, i + 1));
  }
  number(key: MarkKey): number {
    let n = this.numbers.get(key);
    if (n == null) { n = this.numbers.size + 1; this.numbers.set(key, n); }
    return n;
  }
  sup(key: MarkKey): string { return sup(this.number(key)); }
  /** Names the source behind a mark; the first entry for a key stands. */
  cite(key: MarkKey, entry: MarkEntry): void {
    this.number(key);
    if (!this.entries.has(key)) this.entries.set(key, entry);
  }
  used(): MarkKey[] { return MARK_ORDER.filter((k) => this.numbers.has(k)); }
  list(): Mark[] {
    return this.used()
      .map((key) => ({ n: this.number(key), key, ...(this.entries.get(key) ?? { text: 'source not named' }) }))
      .sort((a, b) => a.n - b.n);
  }
}

export const markText = (m: Mark, providers: boolean): string =>
  `${sup(m.n)} ${m.text}${providers && m.provider ? ` (${m.provider})` : ''}${m.tail ?? ''}`;

// ------------------------------------------------------------------------------------------------- not-read shapes

/**
 * The "not read" line for a figure: the source's last answer and its age, never its value. A section whose statements
 * threw says so; a figure the store never had names the source alone.
 */
export function notReadLine(label: string, nr: NotRead, now: number, style: 'default' | 'since' = 'default'): string {
  const reason = (nr.reason ?? '').trim();
  if (reason === DB_NOT_ANSWERED || nr.lastAt == null) return `${label}: not read — ${reason || `${nr.source} has no reading on record`}.`;
  const when = timeWords(nr.lastAt, now), age = ago(now - nr.lastAt);
  const why = reason ? ` (${reason})` : '';
  if (style === 'since') return `${label}: not read since ${when} — ${nr.source} last answered then, ${age} ago${why}; the figure is not shown.`;
  return `${label}: not read — ${nr.source} last answered ${when}, ${age} ago${why}; the figure is not shown.`;
}
const notReadEntry = (source: string, nr: NotRead, now: number): MarkEntry =>
  ({ text: `${source}: not read${nr.lastAt != null ? `, last answered ${timeWords(nr.lastAt, now)}` : ''}` });

// ------------------------------------------------------------------------------------------------- the shared embed

interface EpochRange {
  now: number;
  /** the epoch running at T + horizon; null when the epoch length is not read */
  end: number | null;
  /** true when the range comes from the epoch length alone (no anchor) */
  about: boolean;
  plusMinusMs: number | null;
  epochMs: number | null;
  clockOf: (e: number) => number | null;
}
/** E_end and the clock of an epoch from the anchor (section 5.3): started + (e − E_now) × epochSec. */
export function epochRange(c: EpochClock | null, now: number, horizonMs: number): EpochRange | null {
  if (!c) return null;
  const epochMs = c.params ? c.params.epochSec * 1000 : null;
  if (epochMs == null) return { now: c.epoch, end: null, about: true, plusMinusMs: null, epochMs: null, clockOf: () => null };
  if (c.startedAt == null) {
    return { now: c.epoch, end: c.epoch + Math.round(horizonMs / epochMs), about: true, plusMinusMs: null, epochMs, clockOf: () => null };
  }
  const started = c.startedAt;
  return {
    now: c.epoch,
    end: c.epoch + Math.floor((now + horizonMs - started) / epochMs),
    about: false,
    plusMinusMs: c.plusMinusMs,
    epochMs,
    clockOf: (e) => started + (e - c.epoch) * epochMs,
  };
}

interface Ctx {
  fig: DigestFigures;
  now: number;
  kind: DigestKind;
  trim: TrimState;
  marks: Marks;
  /** the window's name in the lines: '24 h' or '7 d' */
  win: ChangeLabel;
  horizonMs: number;
  epochs: EpochRange | null;
}

const epochsWords = (from: number, to: number): string => (from === to ? `epoch ${int(to)}` : `epochs ${int(from)}–${int(to)}`);

/** " (as of HH:MM UTC)" when a reading is older than both 15 min and its key's cadence. */
function asOf(m: Metric, c: Ctx): string {
  const age = c.now - m.at;
  return age > Math.max(INLINE_AS_OF_MS, m.cadenceMs) ? ` (as of ${timeWords(m.at, c.now)})` : '';
}

/** The parenthesised note for a base that is missing: a gap in the readings or a series that starts later. */
function baseNote(b: ChangeBase, c: Ctx): string {
  if ('gap' in b.base) return `(${b.label} change not read: no reading between ${clock(b.base.gap.from)} and ${clock(b.base.gap.to)} UTC${dayTail(b.base.gap.to, c.now)})`;
  if ('seriesStart' in b.base) return `(no reading ${b.label} ago: series starts ${dayMonClock(b.base.seriesStart)} UTC)`;
  return '';
}
/** Whether a found base's time is named: always for a headline figure, else when it is more than the key's bound off its instant. */
const nameBase = (m: Metric, b: ChangeBase, base: { at: number }, mode: 'always' | 'off-bound'): boolean =>
  mode === 'always' || Math.abs(b.instant - base.at) > boundOf(m.cadenceMs);

/** The NAM changes of a metric: " · 24 h: +467,207.00 NAM (+0.17 %) vs 267,307,557.27 at 07:59 UTC yesterday" per base. */
function namChanges(m: Metric, c: Ctx, o: { pct: boolean; nameBase: 'always' | 'off-bound' }): string {
  return m.bases.map((b) => {
    if (!('at' in b.base)) return ` ${baseNote(b, c)}`;
    const d = m.value - b.base.value;
    const vs = nameBase(m, b, b.base, o.nameBase) ? ` vs ${num2(b.base.value)}${atWords(b.base.at, c.now)}` : '';
    return ` · ${b.label}: ${signedNam(d)}${o.pct && b.base.value ? ` (${pct(d / b.base.value)})` : ''}${vs}`;
  }).join('');
}
/** A count's change: "−2 / 24 h", "no change / 24 h", "−1 / 24 h, vs 64,826 at 07:27 UTC yesterday", or the base note. */
function countDelta(m: Metric, c: Ctx, mode: 'always' | 'off-bound'): string {
  const b = m.bases[0];
  if (!b) return `no ${c.win} base`;
  if (!('at' in b.base)) return baseNote(b, c).slice(1, -1);
  const d = m.value - b.base.value;
  const vs = nameBase(m, b, b.base, mode) ? `, vs ${int(b.base.value)}${atWords(b.base.at, c.now)}` : '';
  return `${d === 0 ? 'no change' : signedInt(d)} / ${b.label}${vs}`;
}

const fieldNotRead = (name: string, nr: NotRead, c: Ctx, inline = false): EmbedField => ({ name, value: notReadLine(name, nr, c.now), inline });

/** The Namada flow index's state: its cite, and the partial-window line when the scan is behind. */
function namadaIndex(c: Ctx): { behind: string | null } {
  const ix = c.fig.anchors.namada;
  if (!ix || ix.cursor == null || ix.cursorAt == null) {
    c.marks.cite('namadaScan', { text: `this site's Namada block scan (its cursor was not read)` });
    return { behind: null };
  }
  c.marks.cite('namadaScan', { text: `this site's Namada block scan, read to block ${int(ix.cursor)} at ${timeWords(ix.cursorAt, c.now)}` });
  const stale = c.now - ix.cursorAt > NAMADA_CURSOR_STALE_MS;
  const lagging = ix.head != null && ix.head - ix.cursor > NAMADA_CURSOR_MAX_LAG;
  if (!stale && !lagging) return { behind: null };
  return { behind: `counted to ${timeWords(ix.cursorAt, c.now)} only ${c.marks.sup('namadaScan')} — this site's Namada scan is behind (read to block ${int(ix.cursor)}); moves since are not counted.` };
}
/** The Osmosis index's state: the stream is up, or the sweep is recent, or the lines count to the sweep only. */
function osmosisIndex(c: Ctx): { behind: string | null } {
  const ix = c.fig.anchors.osmosis;
  const live = ix?.live ?? null, sweep = ix?.sweep ?? null;
  const streaming = !!live && live.connected && c.now - live.at <= OSMOSIS_LIVE_STALE_MS;
  const sweptWords = sweep ? `swept to height ${int(sweep.height)} at ${timeWords(sweep.at, c.now)}` : 'no catch-up search on record';
  c.marks.cite('osmosisIndex', { text: `this site's Osmosis stream and catch-up search, ${sweptWords}${streaming ? '' : live ? `; stream down since ${timeWords(live.at, c.now)}` : ''}` });
  if (streaming) return { behind: null };
  if (sweep && c.now - sweep.at <= OSMOSIS_SWEEP_STALE_MS) return { behind: null };
  if (!sweep) return { behind: `counted by this site's Osmosis index ${c.marks.sup('osmosisIndex')}, whose stream is down and whose catch-up search has no record; moves may be missing.` };
  return { behind: `counted to ${timeWords(sweep.at, c.now)} only ${c.marks.sup('osmosisIndex')} — this site's Osmosis index is behind (${sweptWords}); moves since are not counted.` };
}

function citeBondListing(c: Ctx, fallbackAt: number | null): void {
  const l = c.fig.anchors.bondListing;
  if (l) c.marks.cite('bondListing', { text: `the chain's bond listing${l.height != null ? `, height ${int(l.height)}` : ''}, ${timeWords(l.at, c.now)}`, provider: l.provider });
  else c.marks.cite('bondListing', { text: `the chain's bond listing${fallbackAt != null ? `, ${timeWords(fallbackAt, c.now)}` : ''}` });
}

function fieldStaked(c: Ctx): EmbedField {
  const name = 'Staked NAM';
  const f = c.fig.staked;
  if (isNotRead(f)) return fieldNotRead(name, f, c);
  const v = f.value;
  const lines: string[] = [];
  const ts = v.totalStake;
  if (isNotRead(ts)) {
    c.marks.cite('totalStake', notReadEntry('Namada RPC (total stake)', ts, c.now));
    lines.push(notReadLine('Total stake', ts, c.now));
  } else {
    c.marks.cite('totalStake', { text: `Namada RPC (total stake) ${timeWords(ts.at, c.now)}` });
    lines.push(`Total stake ${nam(ts.value)} ${c.marks.sup('totalStake')}${asOf(ts, c)}${namChanges(ts, c, { pct: true, nameBase: 'always' })}.`);
  }
  const st = v.stakers, va = v.validators;
  citeBondListing(c, isNotRead(st) ? st.lastAt : st.at);
  if (isNotRead(st)) lines.push(notReadLine('Stakers', st, c.now));
  else {
    const withValidators = isNotRead(va) ? '' : ` with ${plural(va.value, 'validator')}`;
    lines.push(`${int(st.value)} stakers (${countDelta(st, c, 'off-bound')})${withValidators} ${c.marks.sup('bondListing')}.`);
  }
  const pa = v.posAccount;
  if (isNotRead(pa)) {
    c.marks.cite('posBalance', notReadEntry('Namada RPC (PoS balance)', pa, c.now));
    lines.push(notReadLine('Staking account', pa, c.now));
  } else {
    c.marks.cite('posBalance', { text: `Namada RPC (PoS balance) ${timeWords(pa.at, c.now)}` });
    let line = `Staking account ${nam(pa.value)} ${c.marks.sup('posBalance')}${asOf(pa, c)} (stake + unbonding + withdrawable + rewards)${namChanges(pa, c, { pct: false, nameBase: 'off-bound' })}.`;
    if (!isNotRead(ts)) line += ` On its way out or unclaimed: ${nam(pa.value - ts.value)} (the account less total stake).`;
    lines.push(line);
  }
  return { name, value: lines.join('\n'), inline: false };
}

/** " [tx ↗](explorer)" on the wrapper hash the explorer files the move under; '' when the hash is not known. */
const txLink = (r: { txHash?: string | null; wrapper?: string | null }): string =>
  r.txHash ? ` [tx ↗](${NAMADA.explorerTx(explorerHashOf({ txHash: r.txHash, meta: r.wrapper ? { wrapper: r.wrapper } : null }))})` : '';

function requestSide(label: string, s: RequestSide, c: Ctx): string {
  if (s.n === 0) return `${label}: no requests.`;
  const late = s.late ? ` (${s.late} found late)` : '';
  let out = `${label}: ${plural(s.n, 'request')}${late}, ${nam(s.nam)}`;
  const l = s.largest;
  if (l) {
    const when = timeWords(l.ts, c.now);
    out += l.ties > 1
      ? `, largest ${nam(l.amount)} (${countWord(l.ties)} of that size at ${when}, block ${int(l.height)}, to ${countWord(l.tieValidators)} validator${l.tieValidators === 1 ? '' : 's'})${txLink(l)}`
      : `, largest ${nam(l.amount)} at ${when}${txLink(l)}`;
  }
  return `${out}.`;
}

function fieldRequests(c: Ctx): EmbedField {
  const name = `Bond and unbond requests (${c.win})`;
  const f = c.fig.requests;
  if (isNotRead(f)) return fieldNotRead(name, f, c);
  const v = f.value;
  const ix = namadaIndex(c);
  const parts = [requestSide('Bonds', v.bonds, c), requestSide('Unbonds', v.unbonds, c)];
  if (v.decodeFailures > 0) parts.push(`${plural(v.decodeFailures, 'block')} could not be decoded.`);
  const body = `${parts.join(' ')} ${c.marks.sup('namadaScan')}`;
  return { name, value: ix.behind ? `${name}: ${ix.behind}\n${body}` : body, inline: false };
}

function citeEpochClock(c: Ctx): void {
  const e = c.fig.anchors.epoch;
  if (!e) { c.marks.cite('epochClock', { text: 'the epoch clock (the epoch was not read)' }); return; }
  const started = e.startedAt != null ? `began ${timeWords(e.startedAt, c.now)} (first reading)` : `at ${timeWords(e.at, c.now)}; its start was not read (the clock is about)`;
  // The stored note reads "about 6.00 h an epoch, measured over the last 30 epochs": the method clause is what the entry adds.
  const method = e.params?.epochSecNote?.includes('measured') ? ` ${e.params.epochSecNote.slice(e.params.epochSecNote.indexOf('measured'))}` : '';
  const params = e.params
    ? `epoch length ${int(e.params.epochSec)} s${method}; indexer.namada.net chain parameters`
    : 'chain parameters not read: no clock';
  c.marks.cite('epochClock', { text: `epoch ${int(e.epoch)} ${started}; ${params}` });
}

function fieldPipeline(c: Ctx): EmbedField {
  const name = 'Unbonding pipeline';
  const f = c.fig.pipeline;
  if (isNotRead(f)) return fieldNotRead(name, f, c);
  const v = f.value;
  c.marks.cite('bondListing', { text: `the chain's bond listing${v.listing.height != null ? `, height ${int(v.listing.height)}` : ''}, ${timeWords(v.listing.at, c.now)}`, provider: v.listing.provider });
  namadaIndex(c);
  citeEpochClock(c);
  const L = c.marks.sup('bondListing'), S = c.marks.sup('namadaScan'), E = c.marks.sup('epochClock');
  const ep = c.epochs;
  const horizon = c.kind === 'daily' ? 'the next 24 h' : 'the next 7 days';
  const parts: string[] = [`Waiting to unlock (in flight): ${nam(v.inFlight)} ${L}.`];

  // Became withdrawable: the identity between the two listings, the queue's direct sum as the cross-check.
  const nowEpoch = v.listing.epoch ?? ep?.now ?? null;
  const baseEpoch = v.base?.listing.epoch ?? v.baseEpoch;
  const range = baseEpoch != null && nowEpoch != null ? (baseEpoch < nowEpoch ? ` (${epochsWords(baseEpoch + 1, nowEpoch)})` : ' (no epoch ended since the base listing)') : '';
  let matured: string;
  if (v.base) {
    const identity = v.withdrawable - v.base.withdrawable + v.withdrawnBetween.nam;
    const direct = v.directMatured;
    const waiting = direct && Math.abs(identity - direct.nam) > 1 ? ` (of which ${nam(direct.nam)} still waiting to be withdrawn)` : '';
    matured = `Became withdrawable in the last ${c.win}${range}: ${nam(identity)} ${L} ${S}${waiting}`;
  } else if (v.directMatured) {
    // the queue's own sum over the epochs since the base instant: what is still waiting, withdrawals since not counted
    const inN = v.directMatured.n ? ` in ${plural(v.directMatured.n, 'unbond')}` : '';
    matured = `Became withdrawable in the last ${c.win}${range}: ${nam(v.directMatured.nam)}${inN} ${L} (unbonds withdrawn since are not counted: no bond listing ${c.win} ago)`;
  } else {
    matured = `Became withdrawable in the last ${c.win}: not computed (no bond listing ${c.win} ago and the epoch then is not read)`;
  }
  const w = v.withdrawn;
  const withdrawn = w.n === 0
    ? `withdrawn in the ${c.win}: none ${S}`
    : w.n === 1
      ? `withdrawn in the ${c.win}: ${nam(w.nam)} in 1 withdrawal${w.ts != null ? ` (${timeWords(w.ts, c.now)})` : ''} ${S}`
      : `withdrawn in the ${c.win}: ${nam(w.nam)} in ${w.n} withdrawals (largest ${nam(w.largest)}) ${S}`;
  parts.push(`${matured}; ${withdrawn}.`);

  // Unlocking in the horizon, and the next bucket when nothing unlocks in it.
  const bucketWords = (b: Bucket): string => {
    if (!ep) return `${nam(b.nam)} (${plural(b.n, 'unbond')}) at epoch ${int(b.epoch)}`;
    const away = b.epoch - ep.now;
    const at = ep.clockOf(b.epoch);
    const when = at != null
      ? `, about ${clock(at)} UTC on ${dayMon(at)}${ep.plusMinusMs != null ? ` (± ${ago(ep.plusMinusMs)})` : ''}`
      : ep.epochMs != null ? `, about ${plural(away, 'epoch')} away` : `, ${plural(away, 'epoch')} away`;
    return `${nam(b.nam)} (${plural(b.n, 'unbond')}) at epoch ${int(b.epoch)}${when}`;
  };
  if (!ep || ep.end == null) {
    const next = v.buckets[0];
    parts.push(`Unlocking in ${horizon}: not computed (the epoch length is not read)${next ? `; next: ${bucketWords(next)} ${E}` : ''}.`);
  } else {
    const inRange = v.buckets.filter((b) => b.epoch > ep.now && b.epoch <= ep.end!);
    const sum = inRange.reduce((a, b) => a + b.nam, 0), n = inRange.reduce((a, b) => a + b.n, 0);
    const label = `Unlocking in ${horizon} (${ep.about ? 'about ' : ''}${epochsWords(ep.now + 1, ep.end)})`;
    if (inRange.length === 0) {
      const next = v.buckets.find((b) => b.epoch > ep.end!);
      parts.push(`${label}: ${nam(0)} ${L}${next ? `; next: ${bucketWords(next)} ${E}` : '; nothing further in the queue'}.`);
    } else if (inRange.length === 1) {
      parts.push(`${label}: ${bucketWords(inRange[0])} ${L} ${E}.`);
    } else {
      // several epochs: each as "NAM (unbonds) at epoch, day time", the units and the clock's error said once
      const clocked = inRange.every((b) => ep.clockOf(b.epoch) != null);
      const item = (b: Bucket): string => {
        const at = ep.clockOf(b.epoch);
        return `${num2(b.nam)} (${int(b.n)}) at ${int(b.epoch)}${at != null ? `, ${dayMon(at)} ${clock(at)}` : ''}`;
      };
      const key = clocked
        ? `NAM (unbonds) at epoch, about when UTC${ep.plusMinusMs != null ? ` ± ${ago(ep.plusMinusMs)}` : ''}`
        : 'NAM (unbonds) at epoch';
      parts.push(`${label}: ${nam(sum)} in ${plural(n, 'unbond')} ${L}; ${key} ${E}: ${inRange.map(item).join('; ')}.`);
    }
  }
  const queueRange = v.queueFromEpoch != null && nowEpoch != null ? ` (${epochsWords(v.queueFromEpoch, nowEpoch)})` : '';
  parts.push(`Withdrawable and not yet withdrawn: ${nam(v.withdrawable)} ${L}${queueRange}.`);
  return { name, value: parts.join(' '), inline: false };
}

function fieldRewards(c: Ctx): EmbedField {
  const name = `Rewards claimed (${c.win})`;
  const f = c.fig.rewards;
  if (isNotRead(f)) return fieldNotRead(name, f, c);
  const v = f.value;
  const ix = namadaIndex(c);
  const body = v.n === 0
    ? `No claims ${c.marks.sup('namadaScan')}.`
    : `${plural(v.n, 'claim')}${v.late ? ` (${v.late} found late)` : ''}, ${nam(v.nam)}, largest ${nam(v.largest)} ${c.marks.sup('namadaScan')}.`;
  return { name, value: ix.behind ? `${name}: ${ix.behind}\n${body}` : body, inline: false };
}

function fieldPrice(c: Ctx): EmbedField {
  const name = 'Price';
  const f = c.fig.price;
  if (isNotRead(f)) return fieldNotRead(name, f, c, true);
  const q = f.value.quote;
  const src = f.value.source;
  if (isNotRead(q)) {
    c.marks.cite('sqsQuote', notReadEntry(src?.name ?? 'Osmosis SQS quote', q, c.now));
    // the field's name is the line's subject: "Price: not read — …" once, never "Price: Price: …"
    return { name, value: notReadLine('The quote', q, c.now), inline: true };
  }
  // the source as the site names a stored price; the route's note is the part fit() may drop with the provider names
  // a change compares two readings: a base read another way than the reading now is named beside the source
  const other = new Map<string, ChangeLabel[]>();
  for (const b of src?.bases ?? []) if (q.bases.some((x) => x.label === b.label && 'at' in x.base)) other.set(b.name, [...(other.get(b.name) ?? []), b.label]);
  const basesWords = [...other].map(([n, labels]) => `; the ${labels.join(' and ')} ${labels.length > 1 ? 'bases' : 'base'} read as ${n}`).join('');
  c.marks.cite('sqsQuote', { text: `${src?.name ?? 'Osmosis SQS quote'} ${timeWords(q.at, c.now)}${basesWords}`, provider: src?.note ?? null });
  const changes = q.bases.map((b) => {
    if (!('at' in b.base)) return baseNote(b, c);
    return `${b.label} ${pct(q.value / b.base.value - 1)} (vs ${usdPrice(b.base.value)}${atWords(b.base.at, c.now)})`;
  });
  return { name, value: [`${usdPrice(q.value)} ${c.marks.sup('sqsQuote')}${asOf(q, c)}`, ...changes].join(' · '), inline: true };
}

function fieldTrades(c: Ctx): EmbedField {
  const name = 'Trades';
  const f = c.fig.trades;
  if (isNotRead(f)) return fieldNotRead(name, f, c, true);
  const v = f.value;
  const ix = osmosisIndex(c);
  const quote = !isNotRead(c.fig.price) && !isNotRead(c.fig.price.value.quote) ? c.fig.price.value.quote.value : null;
  const parts: string[] = [];
  const ex = v.executed;
  if (isNotRead(ex)) {
    c.marks.cite('tradeIndex', notReadEntry(`this site's Osmosis trade index (single-pool NAM/USDC swaps ≥ 50 NAM)`, ex, c.now));
    parts.push(notReadLine('Last executed hour', ex, c.now));
  } else if (!ex) {
    c.marks.cite('tradeIndex', { text: `this site's Osmosis trade index (single-pool NAM/USDC swaps ≥ 50 NAM), no trusted hour on record` });
    parts.push(`No executed NAM/USDC trade on record ${c.marks.sup('tradeIndex')}.`);
  } else {
    c.marks.cite('tradeIndex', { text: `this site's Osmosis trade index (single-pool NAM/USDC swaps ≥ 50 NAM), hour ${timeWords(ex.hourStart, c.now)}` });
    const T = c.marks.sup('tradeIndex');
    // the hour is named by its start; its age is the start's, as the price check measures it (an hour begun within 6 h)
    const age = c.now - ex.hourStart;
    // The hour's count is written beside its median; a missing count row is said, never shown as a number.
    const from = ex.n != null ? `${usdPrice(ex.price)} from ${plural(ex.n, 'trade')} ${T}` : `${usdPrice(ex.price)} ${T} (the hour's trade count is not on record)`;
    if (age <= DAY) {
      let compare: string;
      if (quote == null) compare = '; no comparison: the quote is not read';
      else if (age > EXECUTED_COMPARE_MS) compare = `; no comparison: the hour began ${ago(age)} ago, and the check compares hours begun within 6 h`;
      else if (!(ex.price > 0)) compare = "; no comparison: the hour's median is not a price";
      else {
        const dev = quote / ex.price - 1;
        const band = Math.abs(dev) >= 0.15 ? ' (outside the 15 % band)' : Math.abs(dev) >= 0.05 ? ' (outside the 5 % band)' : '';
        compare = `; the quote is ${pctAbs(dev)} ${dev < 0 ? 'under' : 'over'} it${band}`;
      }
      parts.push(`Last executed hour ${timeWords(ex.hourStart, c.now)}: ${from}${compare}.`);
    } else {
      parts.push(`No executed NAM/USDC trade in the last 24 h (last ${timeWords(ex.hourStart, c.now)}) ${T}.`);
    }
    if (v.vwap && v.vwap.n >= 2) parts.push(`${c.win} VWAP of ${v.vwap.n} trusted trades ${usdPrice(v.vwap.vwap)} (${usdPrice(v.vwap.lo)}–${usdPrice(v.vwap.hi)}) ${T}.`);
  }
  const w = v.window;
  const count = w.overBound ? `more than ${int(DIGEST_TRADES_MAX)} trades (the newest ${int(DIGEST_TRADES_MAX)} counted)` : plural(w.n, 'trade');
  // No priced trade in the window: the dollar sum is unknown, so it is said in words and never printed as $0.00.
  const atExecution = w.usd == null ? `no USD value at execution (${plural(w.unpriced, 'trade')} unpriced)` : `${usd(w.usd)} ${basisWords(w.n - w.unpriced, w.unpriced, w.basis)}`;
  parts.push(`${c.win}: ${count}, ${nam(w.nam)} (bought ${num2(w.buyNam)} / sold ${num2(w.sellNam)}), ${atExecution}, ${plural(w.traders, 'trader')} ${c.marks.sup('osmosisIndex')}.`);
  const api = v.dataApi;
  if (isNotRead(api)) {
    c.marks.cite('dataApi', notReadEntry('Osmosis data API', api, c.now));
    parts.push(notReadLine(`Osmosis data API ${c.win}`, api, c.now));
  } else {
    c.marks.cite('dataApi', { text: `Osmosis data API, updated ${timeWords(api.at, c.now)}` });
    parts.push(`Osmosis data API ${c.win}: ${usd(api.value)} ${c.marks.sup('dataApi')}${asOf(api, c)}.`);
  }
  const body = parts.join(' ');
  return { name, value: ix.behind ? `${name}: ${ix.behind}\n${body}` : body, inline: true };
}

/**
 * The basis of the window's dollar sum: "at execution" only when every priced trade carries its own USDC price,
 * otherwise "at the stored prices" with each basis counted (a sum whose bases were not read says so plainly).
 */
function basisWords(priced: number, unpriced: number, b: PriceBasisCounts | null | undefined): string {
  const left = unpriced > 0 ? `${unpriced} of them unpriced` : '';
  if (b && priced > 0 && b.execution === priced) return `at execution${left ? ` (${left})` : ''}`;
  const parts = b
    ? ([
      [b.execution, 'at execution'], [b.pool_1h, 'at the pool close of their hour'], [b.spot, 'at the Osmosis quote of their minute'],
      [b.swap_1h, 'at the median trade of their hour'], [b.unstated, 'with no stated basis'],
    ] as const).filter(([n]) => n > 0).map(([n, w]) => `${int(n)} ${w}`).join(', ')
    : 'their bases not read';
  const inner = [parts, left].filter(Boolean).join('; ');
  return `at the stored prices${inner ? ` (${inner})` : ''}`;
}

function bridgeSide(label: string, s: BridgeSide): string {
  if (s.n === 0) return `${label} none.`;
  const largest = s.n > 1 ? `, largest ${num2(s.largest)}` : '';
  const late = s.late ? `, ${s.late} found late` : '';
  return `${label} ${nam(s.nam)} (${plural(s.n, 'crossing')}${largest}${late}).`;
}

function fieldBridge(c: Ctx): EmbedField {
  const name = `Bridge (${c.win})`;
  const f = c.fig.bridge;
  if (isNotRead(f)) return fieldNotRead(name, f, c, true);
  const v = f.value;
  const ix = osmosisIndex(c);
  const net = v.ibcOut.nam - v.ibcIn.nam;
  const parts = [bridgeSide('Namada → Osmosis', v.ibcIn), bridgeSide('Osmosis → Namada', v.ibcOut)];
  if (v.refunded.n > 0) parts.push(`(${v.refunded.n} refunded, ${nam(v.refunded.nam)}, left out.)`);
  parts.push(net < 0 ? `Net ${nam(-net)} to Osmosis ${c.marks.sup('osmosisIndex')}.` : `Net ${signedNam(net)} to Namada ${c.marks.sup('osmosisIndex')}.`);
  const e = v.escrow;
  if (isNotRead(e)) {
    c.marks.cite('escrow', notReadEntry('Namada RPC (IBC escrow)', e, c.now));
    parts.push(notReadLine('Escrow', e, c.now));
  } else {
    c.marks.cite('escrow', { text: `Namada RPC (IBC escrow) ${timeWords(e.at, c.now)}` });
    const b = e.bases[0];
    let change = '';
    if (b && 'at' in b.base) {
      const d = e.value - b.base.value;
      const diff = Math.abs(d + net);
      change = `, ${signed2(d)} / ${b.label}${diff <= 1 ? ' (matches)' : ` (differs by ${nam(diff)})`}`;
    } else if (b) change = ` ${baseNote(b, c)}`;
    parts.push(`Escrow ${nam(e.value)} ${c.marks.sup('escrow')}${asOf(e, c)}${change}.`);
  }
  const body = parts.join(' ');
  return { name, value: ix.behind ? `${name}: ${ix.behind}\n${body}` : body, inline: true };
}

function fieldMasp(c: Ctx): EmbedField {
  const name = `Shielded pool (${c.win})`;
  const f = c.fig.masp;
  if (isNotRead(f)) return fieldNotRead(name, f, c, true);
  const v = f.value;
  const ix = namadaIndex(c);
  const inNam = v.shield.nam + v.ibcIn.nam, outNam = v.unshield.nam + v.ibcOut.nam + v.feesNam, net = inNam - outNam;
  const inParts = [v.ibcIn.n ? plural(v.ibcIn.n, 'shielded IBC deposit') : '', v.shield.n ? plural(v.shield.n, 'shielding') : ''].filter(Boolean);
  const outParts = [v.unshield.n ? plural(v.unshield.n, 'unshielding') : '', v.ibcOut.n ? plural(v.ibcOut.n, 'shielded IBC withdrawal') : '', v.feesNam ? `incl. ${nam(v.feesNam)} of fees` : ''].filter(Boolean);
  const parts = [
    `In ${nam(inNam)}${inParts.length ? ` (${inParts.join(', ')})` : ''}.`,
    `Out ${nam(outNam)}${outParts.length ? ` (${outParts.join(', ')})` : ''}.`,
    `Net ${signedNam(net)} ${c.marks.sup('namadaScan')}.`,
  ];
  const bal = v.balance;
  if (isNotRead(bal)) {
    c.marks.cite('maspBalance', notReadEntry('Namada RPC (MASP balance)', bal, c.now));
    parts.push(notReadLine('Pool balance', bal, c.now));
  } else {
    c.marks.cite('maspBalance', { text: `Namada RPC (MASP balance) ${timeWords(bal.at, c.now)}` });
    const b = bal.bases[0];
    let change = '';
    if (b && 'at' in b.base) {
      const d = bal.value - b.base.value;
      const diff = Math.abs(d - net);
      change = `, ${signed2(d)} / ${b.label}${diff <= 1 ? ' (matches)' : ` (differs by ${nam(diff)}: shielded rewards accrue inside the pool once per MASP epoch with no event)`}`;
    } else if (b) change = ` ${baseNote(b, c)}`;
    parts.push(`Pool balance ${nam(bal.value)} ${c.marks.sup('maspBalance')}${asOf(bal, c)}${change}.`);
  }
  const body = parts.join(' ');
  return { name, value: ix.behind ? `${name}: ${ix.behind}\n${body}` : body, inline: true };
}

function fieldHolders(c: Ctx): EmbedField {
  const name = 'Holders';
  const f = c.fig.holders;
  if (isNotRead(f)) return fieldNotRead(name, f, c);
  const v = f.value;
  const parts: string[] = [];
  const yesterday = c.kind === 'daily' ? 'yesterday' : '7 d ago';
  const top10 = (key: MarkKey, t: Top10 | NotRead | null, denom: MetricFigure, of: string): string => {
    if (!t) return '';
    // A top-10 sum past its bound: the clause says so without a figure (the trailing stop is the caller's).
    if (isNotRead(t)) return `; ${notReadLine('the 10 largest', t, c.now).replace(/\.$/, '')}`;
    if (isNotRead(denom)) return `; the 10 largest hold ${nam(t.nam)} (share not computed: ${denom.source} not read) ${c.marks.sup(key)}`;
    const prev = t.previousPct != null ? ` (${pctStored(t.previousPct)} ${yesterday})` : '';
    return `; the 10 largest hold ${nam(t.nam)} = ${pctAbs(t.nam / denom.value)} of ${of}${prev} ${c.marks.sup(key)}`;
  };
  // Namada: the balance listing's count, the holder index's top 10 as a share of minted NAM.
  const n = v.namada, bl = c.fig.anchors.balanceListing;
  if (isNotRead(n)) {
    c.marks.cite('balanceListing', notReadEntry("the chain's balance listing", n, c.now));
    // the stop is added after the top-10 clause below, so the not-read sentence goes in without its own
    parts.push(notReadLine('Namada holders', n, c.now).replace(/\.$/, ''));
  } else {
    citeBondListing(c, null);
    c.marks.cite('balanceListing', {
      text: `the chain's balance listing${bl?.height != null ? `, height ${int(bl.height)}` : ''}, ${timeWords(bl?.at ?? n.at, c.now)}`,
      provider: bl?.provider ?? null,
      tail: `, with the bond listing ${c.marks.sup('bondListing')}`,
    });
    parts.push(`Namada ${int(n.value)} ${c.marks.sup('balanceListing')}${asOf(n, c)} (${countDelta(n, c, 'always')})`);
  }
  if (v.namadaTop10) {
    const minted = v.mintedNam;
    const t = v.namadaTop10;
    c.marks.cite('namadaTop10', isNotRead(t)
      ? notReadEntry("this site's holder index, the 10 largest by total NAM", t, c.now)
      : { text: `this site's holder index, the 10 largest by total NAM, as of the ${clock(t.at)} listing; minted NAM ${isNotRead(minted) ? 'not read' : `${num2(minted.value)}, Namada RPC ${timeWords(minted.at, c.now)}`}` });
    parts[parts.length - 1] += top10('namadaTop10', t, minted, 'minted NAM');
  }
  parts[parts.length - 1] += '.';
  // Osmosis: Keplr's holder list at its pass, the Osmosis holder index's top 10 as a share of the NAM on Osmosis.
  const o = v.osmosis;
  if (isNotRead(o)) {
    c.marks.cite('osmosisHolders', notReadEntry('Keplr Osmosis REST holder list', o, c.now));
    parts.push(notReadLine('Osmosis holders', o, c.now).replace(/\.$/, ''));
  } else {
    c.marks.cite('osmosisHolders', { text: `Keplr Osmosis REST holder list, pass of ${timeWords(o.at, c.now)}` });
    const trusted = v.osmosisPassTrustedAt;
    const current = trusted === 'never'
      ? ' — not current: no pass has yet added up to the supply'
      : trusted != null && c.now - trusted > OSMOSIS_PASS_TRUST_MS ? ` — not current: the last pass that added up to the supply started ${timeWords(trusted, c.now)}` : '';
    parts.push(`Osmosis ${int(o.value)} ${c.marks.sup('osmosisHolders')}${asOf(o, c)} (${countDelta(o, c, 'off-bound')})${current}`);
  }
  if (v.osmosisTop10) {
    const supply = v.osmosisNam;
    const t = v.osmosisTop10;
    c.marks.cite('osmosisTop10', isNotRead(t)
      ? notReadEntry("this site's Osmosis holder index", t, c.now)
      : { text: `this site's Osmosis holder index ${timeWords(t.at, c.now)}; NAM on Osmosis ${isNotRead(supply) ? 'not read' : `${num2(supply.value)}, Keplr Osmosis REST (supply) ${timeWords(supply.at, c.now)}`}` });
    parts[parts.length - 1] += top10('osmosisTop10', t, supply, 'the NAM on Osmosis');
  }
  parts[parts.length - 1] += '.';
  // Staking concentration from the bond listing's series.
  const s = v.stakeTop10Pct;
  if (isNotRead(s)) parts.push(notReadLine('Staking concentration', s, c.now));
  else {
    citeBondListing(c, s.at);
    const b = s.bases[0];
    const prev = b && 'at' in b.base ? ` (${pctStored(b.base.value)} ${yesterday})` : b ? ` ${baseNote(b, c)}` : '';
    parts.push(`Staking: the 10 largest validators hold ${pctStored(s.value)} of stake ${c.marks.sup('bondListing')}${prev}.`);
  }
  return { name, value: parts.join(' '), inline: false };
}

const statusWord = (s: string): string => {
  const l = s.toLowerCase();
  if (l.includes('reject')) return 'rejected';
  if (l.includes('pass')) return 'passed';
  return plainMd(codeSafe(s));
};

function fieldGovernance(c: Ctx): EmbedField {
  const name = 'Governance';
  const f = c.fig.governance;
  if (isNotRead(f)) {
    c.marks.cite('proposals', notReadEntry('indexer.namada.net proposals', f, c.now));
    return { name, value: notReadLine(name, f, c.now, 'since'), inline: false };
  }
  const v = f.value;
  const ep = c.epochs;
  c.marks.cite('proposals', { text: `indexer.namada.net proposals, read ${timeWords(v.fetchedAt, c.now)}${ep ? `; chain epoch ${int(ep.now)}` : ''}` });
  const byId = new Map(v.proposals.map((p) => [p.id, p]));
  let unseen = false;
  const named = (id: number): string => {
    const p = byId.get(id);
    if (!p) { unseen = true; return `#${id} (not among the ${v.proposals.length} newest on record)`; }
    const own = safeHttpUrl(p.discussionsUrl);
    const url = own && own.length <= GOV_LINK_MAX ? own : `https://namada.valopers.com/proposals/${p.id}`;
    const title = plainMd(codeSafe(p.title)).trim();
    const cut = title.length > c.trim.govTitle ? `${title.slice(0, c.trim.govTitle - 1).trimEnd()}…` : title;
    return `#${p.id} [${cut}](${url})`;
  };
  const opened = v.opened.length ? v.opened.map((o) => named(o.id)).join('; ') : 'none';
  const closed = v.closed.length ? v.closed.map((o) => `${named(o.id)} ${statusWord(o.status)}`).join('; ') : 'none';
  const horizon = c.kind === 'daily' ? 'Ending within 24 h' : 'Ending within 7 days';
  let ending: string;
  if (!ep || ep.end == null) ending = `${horizon}: not computed (the epoch clock is not read)`;
  else {
    const end = ep.end;
    const soon = v.proposals.filter((p) => p.status.toLowerCase() === 'voting' && p.endEpoch > ep.now && p.endEpoch <= end);
    const list = soon.map((p) => {
      const at = ep.clockOf(p.endEpoch);
      const when = at != null ? `, about ${ago(at - c.now)} ${c.marks.sup('epochClock')}` : '';
      return `${named(p.id)}, voting ends at epoch ${int(p.endEpoch)}${when}`;
    });
    ending = `${horizon} (${ep.about ? 'about ' : ''}${epochsWords(ep.now + 1, end)}): ${list.length ? list.join('; ') : 'none'}`;
  }
  const newest = v.proposals.reduce<Proposal | null>((a, p) => (a == null || p.id > a.id ? p : a), null);
  // the list read is the indexer's first page, so its length is the page's, not the chain's count of proposals
  const record = newest ? `Newest of the ${plural(v.proposals.length, 'proposal')} read: #${newest.id} (${statusWord(newest.status)})` : 'no proposals on record';
  const caveat = unseen ? ` The list is page 1 only (the ${v.proposals.length} newest): a proposal older than those that changes state is not named here.` : '';
  return { name, value: `Opened: ${opened}. Closed: ${closed}. ${ending}. ${record} ${c.marks.sup('proposals')}.${caveat}`, inline: false };
}

const validatorName = (v: { validator: string; name: string | null }): string => (v.name ? plainMd(codeSafe(v.name)) : shortAddr(v.validator));

function fieldValidators(c: Ctx): EmbedField {
  const name = 'Validators';
  const f = c.fig.validators;
  if (isNotRead(f)) return fieldNotRead(name, f, c);
  const v = f.value;
  c.marks.cite('validatorDaily', {
    text: `the first complete bond listings of ${dayMon(v.base.asOf)} (${clock(v.base.asOf)} UTC, height ${int(v.base.height)}) and ${dayMon(v.today.asOf)} (${clock(v.today.asOf)} UTC, height ${int(v.today.height)})${v.today.namesAt != null ? `; names by indexer.namada.net, read ${timeWords(v.today.namesAt, c.now)}` : '; names not read'}`,
  });
  const parts: string[] = [];
  if (v.noListingToday) parts.push(`No listing yet today; last snapshot ${dayMon(v.today.asOf)} as of ${timeWords(v.today.asOf, c.now)}.`);
  if (v.baseIsOldest) parts.push(`The snapshots start ${dayMon(v.base.asOf)}, so that day is the base, not ${c.kind === 'weekly' ? '7 days' : '1 day'} back.`);
  const both = v.today.validators - v.joined;
  // A state not on record in one snapshot is not compared, never counted as a change (nor as "0 changes" when no
  // state could be compared at all).
  const nc = v.statesNotCompared ?? 0;
  const compared = both - nc;
  let states: string;
  if (nc > 0 && compared <= 0) states = 'states not compared (not on record in one snapshot)';
  else {
    const changes = v.stateChanges.length
      ? `${plural(v.stateChanges.length, 'state change')} (${v.stateChanges.map((s) => `${validatorName(s)} ${s.from ?? 'none'} → ${s.to ?? 'none'}`).join(', ')})`
      : '0 state changes';
    states = nc > 0 ? `${changes} among the ${int(compared)} compared (${int(nc)} not on record in one snapshot)` : changes;
  }
  parts.push(`${both} with stake on both days ${c.marks.sup('validatorDaily')}; ${v.joined} joined, ${v.left} left, ${states} (listing ${timeWords(v.base.asOf, c.now)} → ${timeWordsToday(v.today.asOf, c.now)}).`);
  parts.push(`Stake ${signedNam(v.today.stake - v.base.stake)} between the listings; gross |change| ${nam(v.gross)}.`);
  const movers = v.movers.slice(0, c.trim.movers);
  if (movers.length) {
    let word = ' delegators';
    const list = movers.map((m) => {
      let deleg = '';
      if (m.delegatorsToday != null && m.delegatorsBase != null && m.delegatorsToday !== m.delegatorsBase) {
        deleg = ` (${int(m.delegatorsBase)} → ${int(m.delegatorsToday)}${word})`;
        word = '';
      }
      return `${validatorName(m)} ${signed2(m.d)}${deleg}`;
    });
    parts.push(`Largest moves: ${list.join(', ')}.`);
  }
  parts.push('Redelegations are not decoded.');
  return { name, value: parts.join(' '), inline: false };
}

const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];
const firstSentence = (s: string): string => { const m = /^.*?[.!?](?=\s|$)/.exec(s); return m ? m[0] : s; };

/** One field per chart: its caption, or the sentence saying why the picture is left out. With the captions off, an
 *  attached chart's field goes (its picture and alt text stay); a left-out chart's sentence always stays. */
function fieldsPictures(c: Ctx): EmbedField[] {
  const charts = c.fig.charts ?? [];
  return charts.flatMap((ch, i) => {
    if (c.trim.captions === 'none' && ch.present) return [];
    const caption = c.trim.captions !== 'full' ? firstSentence(ch.caption) : [ch.caption, ...(ch.notes ?? [])].join(' ');
    return [{ name: `${CIRCLED[i] ?? `${i + 1}.`} ${ch.title}`, value: caption, inline: false }];
  });
}

/** The Sources entries packed into fields of at most 1,024 characters: "Sources" alone, or "Sources (1)", "Sources (2)", … */
function fieldsSources(marks: Mark[], providers: boolean): EmbedField[] {
  const texts = marks.map((m) => markText(m, providers));
  const groups: string[][] = [];
  let cur: string[] = [];
  for (const t of texts) {
    const next = [...cur, t].join(' · ');
    if (cur.length && next.length > DISCORD_FIELD_MAX) { groups.push(cur); cur = [t]; }
    else cur.push(t);
  }
  if (cur.length) groups.push(cur);
  if (groups.length === 0) return [];
  if (groups.length === 1) return [{ name: 'Sources', value: groups[0].join(' · '), inline: false }];
  return groups.map((g, i) => ({ name: `Sources (${i + 1})`, value: g.join(' · '), inline: false }));
}

function renderFields(c: Ctx): EmbedField[] {
  return [
    fieldStaked(c), fieldRequests(c), fieldPipeline(c), fieldRewards(c), fieldPrice(c), fieldTrades(c), fieldBridge(c),
    fieldMasp(c), fieldHolders(c), fieldGovernance(c), fieldValidators(c), ...fieldsPictures(c),
  ];
}

/** A metric's first change as a percentage with its window: " (+0.15 % / 24 h)"; '' when its base was not read. */
function pctChange(m: Metric): string {
  const b = m.bases[0];
  if (!b || !('at' in b.base) || !b.base.value) return '';
  return ` (${pct(m.value / b.base.value - 1)} / ${b.label})`;
}

/**
 * The description's first sentence: the day's three figures, each with its mark, so a phone's push (the title and the
 * first lines of the description) shows the day: total stake and its change, the price and its change (or "price not
 * read"), the trade count and NAM. The marks are those the fields already cite.
 */
function leadSentence(c: Ctx): string {
  const parts: string[] = [];
  const st = c.fig.staked;
  const ts = isNotRead(st) ? st : st.value.totalStake;
  parts.push(isNotRead(ts) ? 'Total stake not read' : `Total stake ${nam(ts.value)} ${c.marks.sup('totalStake')}${pctChange(ts)}`);
  const pr = c.fig.price;
  const q = isNotRead(pr) ? pr : pr.value.quote;
  parts.push(isNotRead(q) ? 'price not read' : `price ${usdPrice(q.value)} ${c.marks.sup('sqsQuote')}${pctChange(q)}`);
  const tr = c.fig.trades;
  if (isNotRead(tr)) parts.push('trades not read');
  else {
    const w = tr.value.window;
    const count = w.overBound ? `more than ${int(DIGEST_TRADES_MAX)} trades` : plural(w.n, 'trade');
    parts.push(`${count}, ${nam(w.nam)} ${c.marks.sup('osmosisIndex')}`);
  }
  return `${parts.join(' · ')}.`;
}

/** The shared embed at a trim: two passes over the fields, the first to learn which marks the digest uses, the second
 *  with the numbers fixed in MARK_ORDER over those. */
export function renderShared(fig: DigestFigures, now: number, kind: DigestKind, trim: TrimState = TRIM_FULL): { embed: Embed; marks: Mark[] } {
  const horizonMs = kind === 'daily' ? DAY : 7 * DAY;
  const ctx = (marks: Marks): Ctx => ({ fig, now, kind, trim, marks, win: kind === 'daily' ? '24 h' : '7 d', horizonMs, epochs: epochRange(fig.anchors.epoch, now, horizonMs) });
  const first = new Marks(null);
  renderFields(ctx(first));
  const marks = new Marks(first.used());
  const c = ctx(marks);
  const fields = renderFields(c);
  const opening = leadSentence(c);
  const list = marks.list();
  fields.push(...fieldsSources(list, trim.providers));
  const lead = (fig.charts ?? []).find((ch) => ch.present);
  const embed: Embed = {
    title: kind === 'daily'
      ? `NAM daily digest · ${dowDayMonYear(now)}, ${clock(now)} UTC`
      : `NAM weekly digest · 7 days to ${dowDayMonYear(now)}, ${clock(now)} UTC`,
    url: DIGEST_URL,
    color: kind === 'daily' ? DIGEST_COLOR_DAILY : DIGEST_COLOR_WEEKLY,
    description:
      `${opening} The ${kind === 'daily' ? '24 h' : '7 × 24 h'} to <t:${Math.floor(now / 1000)}:f>. ` +
      'Each mark names its source in Sources; "not read" means no answer in time, never 0.' + lateNote(now),
    fields: fields.map((f) => ({ ...f, value: cutValue(f.value) })),
    footer: { text: `NamadaTrade · ${kind} digest · figures as read · turn it off in Settings` },
    timestamp: new Date(now).toISOString(),
    ...(lead ? { image: { url: `attachment://${lead.file}` } } : {}),
  };
  return { embed, marks: list };
}

/**
 * The shared embed, once for every recipient: brought within its share (DIGEST_SHARED_MAX) by the steps that drop no
 * figure. When those are not enough it stays as it is, up to the whole message's budget, and the recipient's own
 * embed goes in the next message (fitMessage); only past that budget do the steps that drop figures come, and the
 * last resort (hardCut) after them.
 */
export function fitShared(render: (t: TrimState) => Embed): { trim: TrimState; embed: Embed; hardCut: boolean } {
  let trim = fitAlone(render, DIGEST_SHARED_MAX, SHARED_SOFT_STEPS, TRIM_FULL);
  if (discordCount(render(trim)) > DIGEST_SHARED_ALONE_MAX) trim = fitAlone(render, DIGEST_SHARED_ALONE_MAX, SHARED_HARD_STEPS, trim);
  const embed = tidy(render(trim));
  if (discordCount(embed) <= DIGEST_SHARED_ALONE_MAX) return { trim, embed, hardCut: false };
  return { trim, embed: hardCut(embed, DIGEST_SHARED_ALONE_MAX), hardCut: true };
}

/** The whole digest: the shared embed (fitShared), the chart gallery, the files to attach, the claim key and label. */
export function buildDigest(fig: DigestFigures, now: number, kind: DigestKind): DigestBody {
  const render = (t: TrimState): Embed => renderShared(fig, now, kind, t).embed;
  const fitted = fitShared(render);
  const { marks } = renderShared(fig, now, kind, fitted.trim);
  const present = (fig.charts ?? []).filter((ch) => ch.present);
  return {
    key: digestKey(now, kind),
    what: digestLabel(now, kind),
    kind,
    shared: fitted.embed,
    trim: fitted.trim,
    hardCut: fitted.hardCut,
    gallery: present.slice(1).map((ch) => ({ url: DIGEST_URL, image: { url: `attachment://${ch.file}` } })),
    files: present.map((ch) => ch.file),
    marks,
    render,
  };
}

// ------------------------------------------------------------------------------------------------- the operator embed

/** The operator embed names at most this many sources not ok, and as many flips, before "and N more". */
export const OPERATOR_LISTED_MAX = 6;
/** Each named source's note is cut to this many characters. */
export const OPERATOR_NOTE_MAX = 90;
/** The sources line is never cut below this many characters to keep the embed within its share. */
export const OPERATOR_LINE_FLOOR = 240;

export function operatorEmbed(ops: OperatorFigures, now: number, kind: DigestKind = 'daily'): Embed {
  const win = kind === 'daily' ? '24 h' : '7 d';
  const t = `${clock(now)} UTC`;
  const lines: string[] = [];
  const h = ops.health, log = ops.healthLog, ch = ops.checks, cl = ops.claims;
  const channels = ops.channels === 1 && ops.subscribers === 0 ? 'the operator channel only (0 subscribers)' : `${plural(ops.channels, 'channel')} (${plural(ops.subscribers, 'subscriber')})`;
  const allClear =
    !isNotRead(h) && h.value.notOk.length === 0 &&
    !isNotRead(log) && log.value.flips.length === 0 && log.value.firstAt != null && log.value.firstAt <= now - (kind === 'daily' ? DAY : 7 * DAY) &&
    !isNotRead(ch) && ch.value.failing.length === 0 &&
    ops.skipped == null &&
    !isNotRead(ops.previous) && ops.previous.missed.length === 0 && ops.previous.last != null && ops.previous.last.posted === ops.previous.last.targets;
  if (allClear) {
    lines.push('All sources answered through the day; every check passed; no alert post was held back; the digest reached every channel.');
    lines.push(`This digest: ${channels}.`);
  } else {
    // a) the sources now, and the flips the health log holds for the window
    if (isNotRead(h)) lines.push(notReadLine(`Sources at ${t}`, h, now));
    else {
      const notOkWhen = (x: { since: number | null; asOf?: number }) => (x.since != null ? `since ${timeWords(x.since, now)}` : x.asOf != null ? `at its probe of ${timeWords(x.asOf, now)} (its start is not on record)` : '(its start is not on record)');
      // a day with many sources down lists the first few, each note cut short, so the lines after this one stay
      const listed = h.value.notOk.slice(0, OPERATOR_LISTED_MAX);
      const unlisted = h.value.notOk.length - listed.length;
      const notOk = h.value.notOk.length
        ? `; not ok: ${listed.map((x) => `${x.name} ${notOkWhen(x)}: ${cutValue(plainMd(codeSafe(x.note)), OPERATOR_NOTE_MAX)}`).join('; ')}${unlisted ? `; and ${unlisted} more (the Sources sheet lists them)` : ''}`
        : '';
      let flips = '';
      if (isNotRead(log)) flips = ` ${notReadLine('Faults during the day', log, now)}`;
      else {
        const fl = log.value.flips;
        if (fl.length) {
          const shown = fl.slice(0, OPERATOR_LISTED_MAX);
          flips = ` Degraded during the day: ${shown.map((x) => x.to != null
            ? `${x.name}: not ok ${clock(x.from)}–${clock(x.to)} UTC (${ago(x.to - x.from)})`
            : `${x.name}: not ok since ${timeWords(x.from, now)} (still)`).join('; ')}${fl.length > shown.length ? `; and ${fl.length - shown.length} more` : ''}.`;
        }
        const first = log.value.firstAt;
        if (first == null) flips += ` Faults that cleared before ${clock(now)}: no record (the health log starts with this deploy).`;
        else if (first > now - (kind === 'daily' ? DAY : 7 * DAY)) flips += ` Faults that cleared before ${timeWords(first, now)} have no record${kind === 'weekly' ? ' (the log covers the last 48 h only)' : ''}.`;
      }
      lines.push(`Sources at ${t}: ${h.value.ok} of ${h.value.total} ok${notOk}.${flips}`);
    }
    // b) the checks
    if (isNotRead(ch)) lines.push(notReadLine('Checks', ch, now));
    else {
      // "since" only when the state's start is on record (the health log's flip); otherwise the last run's time
      const when = (x: { since: number | null; asOf?: number }) => (x.since != null ? `since ${timeWords(x.since, now)}` : x.asOf != null ? `as of its run at ${timeWords(x.asOf, now)}` : '(its start is not on record)');
      const failing = ch.value.failing.length ? `; ${ch.value.failing.map((x) => `${x.key} ${x.status} ${when(x)}`).join('; ')}` : '';
      // a check that ran with nothing to compare is idle: neither ok nor failing, so it is named
      const idle = ch.value.idle ?? [];
      const idleWords = idle.length ? `, ${idle.length} idle (${idle.join(', ')}: nothing to compare when last run)` : '';
      lines.push(`Checks: ${ch.value.ok} of ${ch.value.total} ok${idleWords}${failing}.`);
    }
    // c) the alerts posted (the claims) and the posts not sent
    const sk = ops.skipped;
    const skipped = isNotRead(sk)
      ? 'the record of posts not sent was not read'
      : sk
        ? `${plural(sk.n, 'post')} for ${plainMd(codeSafe(sk.what))} not sent at ${timeWords(sk.at, now)}; ${int(sk.total)} in all`
        : 'none not sent on record';
    if (isNotRead(cl)) lines.push(`${notReadLine(`Alerts in the ${win}`, cl, now)} ${skipped[0].toUpperCase()}${skipped.slice(1)}.`);
    else {
      const v = cl.value;
      // a bridge crossing is one of the moves (its per-channel claim is no post of its own); other: governance, forum, digests
      const other = v.n - v.moves;
      const moves = `${int(v.moves)} moves${v.crossings > 0 ? `, ${int(v.crossings)} of them bridge crossings` : ''}`;
      const kinds = v.n ? ` (${[moves, other > 0 ? `${int(other)} other` : ''].filter(Boolean).join(', ')}${v.firstAt != null && v.lastAt != null ? `; first ${timeWords(v.firstAt, now)}, last ${timeWordsToday(v.lastAt, now)}` : ''})` : '';
      lines.push(`Alerts in the ${win}: ${int(v.n)} posted${kinds}; ${skipped}.`);
    }
    // d) this digest's channels and the previous period's delivery
    const prev = ops.previous;
    let previous: string;
    if (isNotRead(prev)) previous = notReadLine(kind === 'daily' ? "Yesterday's digest" : 'The previous weekly digest', prev, now).replace(/\.$/, '');
    else if (prev.missed.length) previous = `No digest was sent on ${prev.missed.map((d) => dayMon(Date.parse(`${d}T00:00:00Z`))).join(', ')} (no run between 08:00 and 24:00 UTC)`;
    else if (prev.sentWithoutRecord) previous = `${kind === 'daily' ? "Yesterday's digest" : 'The previous weekly digest'} was sent; its delivery count is not on record`;
    else if (prev.last) {
      const cut = prev.last.targets - prev.last.posted;
      previous = `${kind === 'daily' ? "Yesterday's digest" : 'The previous weekly digest'} reached ${prev.last.posted} of ${plural(prev.last.targets, 'channel')}${cut > 0 ? ` (${cut} not sent)` : ''}`;
    } else previous = `${kind === 'daily' ? 'Yesterday' : 'The Monday before'}: no digest on record (the first one)`;
    lines.push(`This digest: ${channels}. ${previous}.`);
  }
  // e) the per-user address cap
  if (ops.watchCapWallets > 0) lines.push(`The per-user address cap (${int(DIGEST_WATCH_ADDRS_MAX)}) was reached: ${plural(ops.watchCapWallets, 'wallet')} got no watchlist.`);
  // within the embed's share: the sources line, the longest, is cut first, so the checks, the alerts and the digest's
  // own delivery are always said
  const total = lines.join('\n').length;
  if (total > DIGEST_OWN_MAX && lines.length > 1 && !allClear) lines[0] = cutValue(lines[0], Math.max(OPERATOR_LINE_FLOOR, lines[0].length - (total - DIGEST_OWN_MAX)));
  return { title: 'Operator', color: DIGEST_COLOR_OPERATOR, description: cutValue(lines.join('\n'), DISCORD_DESCRIPTION_MAX) };
}

// ------------------------------------------------------------------------------------------------- the watchlist embed

const chainWords = (chain: WatchLine['chain']): { name: string; stamp: string } =>
  chain === 'namada' ? { name: 'Namada', stamp: 'listing' } : { name: 'Osmosis', stamp: 'pass' };

/** One watched address's line, in the four shapes of section 5.11. */
export function watchLineText(l: WatchLine, now: number, win: ChangeLabel): string {
  const a = shortAddr(l.address);
  const ch = chainWords(l.chain);
  if (l.now == null) return `${a}  not listed (the chain lists no spendable NAM for it)`;
  const asOfNow = l.nowAt != null ? ` — ${ch.name}, as of the ${clock(l.nowAt)} UTC ${ch.stamp}` : ` — ${ch.name}`;
  if (l.base == null) return `${a}  ${win} ago: not known (no reading) — now ${nam(l.now)}`;
  const d = l.now - l.base;
  if (Math.abs(d) < 0.005) return `${a}  no change (${nam(l.now)})${asOfNow}`;
  const from = l.baseAt != null ? `; ${win} ago from the reading at ${timeWords(l.baseAt, now)}` : '';
  return `${a}  ${signedNam(d)} spendable (now ${nam(l.now)})${asOfNow}${from}`;
}

/** A subscriber's own embed: the lines sorted by |change|, at most `lines` of them, then "and N more", then the rule. */
export function watchlistEmbed(lines: WatchLine[] | NotRead, now: number, kind: DigestKind = 'daily', maxLines = DIGEST_WATCH_LINES): Embed {
  const win: ChangeLabel = kind === 'daily' ? '24 h' : '7 d';
  const title = `Your watchlist (${win})`;
  if (isNotRead(lines)) {
    const text = lines.reason === DB_NOT_ANSWERED || !lines.reason
      ? notReadLine('Your watchlist', lines, now)
      : `Your watchlist: not read this time — ${lines.reason}.`;
    return { title, color: DIGEST_COLOR_WATCHLIST, description: text };
  }
  const rank = (l: WatchLine): number => (l.now != null && l.base != null ? Math.abs(l.now - l.base) : -1);
  const sorted = [...lines].sort((x, y) => rank(y) - rank(x) || (x.address < y.address ? -1 : x.address > y.address ? 1 : 0));
  const shown = sorted.slice(0, maxLines), rest = sorted.slice(maxLines);
  const out = shown.map((l) => watchLineText(l, now, win));
  if (rest.length) {
    const unchanged = rest.filter((l) => l.now != null && l.base != null && Math.abs(l.now - l.base) < 0.005).length;
    const notRead = rest.filter((l) => l.now == null || l.base == null).length;
    out.push(`and ${rest.length} more: ${unchanged} unchanged, ${notRead} not read`);
  }
  out.push('Spendable NAM only; staked changes are not computed. Addresses are shown shortened, never their tags. One digest per channel.');
  return { title, color: DIGEST_COLOR_WATCHLIST, description: cutValue(out.join('\n'), DISCORD_DESCRIPTION_MAX) };
}

// ------------------------------------------------------------------------------------------------- limits and fit()

/** The characters Discord counts for one embed: title, description, every field's name and value, the footer. */
export function discordCount(e: Embed): number {
  return (e.title?.length ?? 0) + (e.description?.length ?? 0) + (e.footer?.text.length ?? 0) +
    (e.fields ?? []).reduce((a, f) => a + f.name.length + f.value.length, 0);
}
export const messageCount = (embeds: Embed[]): number => embeds.reduce((a, e) => a + discordCount(e), 0);

/**
 * A field value cut to `max` characters, ending with "…": the cut falls at a word boundary, never between a number and
 * its mark (nor right after a number, a percentage or a NAM amount), never inside a masked link or a code span.
 */
export function cutValue(s: string, max = DISCORD_FIELD_MAX): string {
  if (s.length <= max) return s;
  let p = max - 1;
  while (p > 0) {
    const q = lastBoundary(s, p);
    if (q <= 0) break;
    const head = s.slice(0, q).replace(/[\s·;,]+$/, ''), rest = s.slice(q);
    const splitsMark = SUP_RE.test(rest.trimStart().charAt(0)) || /[\d%]$|\bNAM$/.test(head);
    const lb = head.lastIndexOf('[');
    const openLink = lb >= 0 && head.indexOf(')', lb) < 0 && s.slice(lb).includes('](');
    const openCode = (head.split('`').length - 1) % 2 === 1;
    if (head.length && !splitsMark && !openLink && !openCode) return `${head}…`;
    p = q - 1;
  }
  return `${s.slice(0, max - 1)}…`;
}

/** Field values are never cut below this by the last resort. */
const HARD_CUT_FLOOR = 80;
/**
 * The last resort when every trim step is spent and an embed is still over its budget: the longest field values are cut
 * down, the longest first and down to the next longest, never below 80 characters, the Sources fields last, then the
 * description. A cut value ends with "…", so the reader sees it is cut.
 */
export function hardCut(e: Embed, max: number): Embed {
  let out = e;
  for (let guard = 0; guard < 128; guard++) {
    const over = discordCount(out) - max;
    if (over <= 0) return out;
    const fields = out.fields ?? [];
    const longest = (sources: boolean) => fields
      .map((f, i) => ({ i, len: f.value.length, sources: f.name.startsWith('Sources') }))
      .filter((x) => x.sources === sources && x.len > HARD_CUT_FLOOR)
      .sort((a, b) => b.len - a.len);
    const cands = longest(false).length ? longest(false) : longest(true);
    if (cands.length) {
      const [first, second] = cands;
      const floor = second && second.len < first.len ? second.len : HARD_CUT_FLOOR;
      const target = Math.max(floor, first.len - over);
      out = { ...out, fields: fields.map((f, i) => (i === first.i ? { ...f, value: cutValue(f.value, target) } : f)) };
      continue;
    }
    if (out.description && out.description.length > HARD_CUT_FLOOR) {
      out = { ...out, description: cutValue(out.description, Math.max(HARD_CUT_FLOOR, out.description.length - over)) };
      continue;
    }
    return out;
  }
  return out;
}
function lastBoundary(s: string, p: number): number {
  for (let i = p; i > 0; i--) if (/\s/.test(s.charAt(i))) return i;
  return 0;
}

/** Applies the allowed steps in TRIM_ORDER to one renderer until its embed is within `max`; the trim reached. */
function fitAlone(render: (t: TrimState) => Embed, max: number, allowed: readonly TrimStep[], from: TrimState): TrimState {
  let trim = from;
  if (discordCount(render(trim)) <= max) return trim;
  for (const step of TRIM_ORDER) {
    if (!allowed.includes(step)) continue;
    const next = trimNext(trim, step);
    if (!next) continue;
    trim = next;
    if (discordCount(render(trim)) <= max) return trim;
  }
  return trim;
}

export type FitPart = Embed | ((t: TrimState) => Embed);
export interface FitInput {
  /** the shared embed: as built (DigestBody.shared, the same for every recipient), or its renderer (fitShared runs) */
  shared: FitPart;
  /** the recipient's own embed (≤ DIGEST_OWN_MAX): the operator's, or a watchlist renderer */
  own?: FitPart | null;
  /** embeds that carry no text (the chart gallery) */
  gallery?: Embed[];
}
export interface FitResult {
  /** the first message: the shared embed, the gallery and, when the message has room for it, the recipient's own embed */
  embeds: Embed[];
  /** the recipient's own embed when the first message has no room for it: it goes first in the next message */
  ownApart: Embed | null;
  trim: TrimState;
  /** whether the first message is within DIGEST_MESSAGE_MAX */
  fits: boolean;
  /** true when the last resort cut field values down (hardCut) */
  hardCut: boolean;
}

/**
 * The recipient's message: the shared embed exactly as built for everyone, the gallery, and the recipient's own embed
 * (its watchlist lines trimmed 20 → 10 → 5 towards DIGEST_OWN_MAX) when the message has room for it within
 * DIGEST_MESSAGE_MAX; otherwise the own embed is returned apart, for the next message, and no figure of either is cut.
 * Every field value is cut to 1,024 on its own. It never throws on size.
 */
export function fitMessage(input: FitInput): FitResult {
  const renderOf = (p: FitPart): ((t: TrimState) => Embed) => (typeof p === 'function' ? p : () => p);
  const shared = typeof input.shared === 'function' ? fitShared(input.shared) : { trim: TRIM_FULL, embed: tidy(input.shared), hardCut: false };
  const gallery = input.gallery ?? [];
  let trim = shared.trim;
  let own: Embed | null = null;
  let hard = shared.hardCut;
  if (input.own) {
    const render = renderOf(input.own);
    trim = fitAlone(render, DIGEST_OWN_MAX, OWN_STEPS, trim);
    own = tidy(render(trim));
    // an own embed past a whole message is cut (its description is at most 4,096, so this does not happen)
    if (discordCount(own) > DIGEST_MESSAGE_MAX) { own = hardCut(own, DIGEST_MESSAGE_MAX); hard = true; }
  }
  const first = [shared.embed, ...gallery];
  const together = own ? [...first, own] : first;
  const fitsTogether = messageCount(together) <= DIGEST_MESSAGE_MAX && together.length <= DISCORD_EMBEDS_MAX;
  const embeds = fitsTogether ? together : first;
  return { embeds, ownApart: fitsTogether ? null : own, trim, fits: messageCount(embeds) <= DIGEST_MESSAGE_MAX, hardCut: hard };
}
/** The spec's name: the embeds of a message that fits. */
export const fit = (input: FitInput): Embed[] => fitMessage(input).embeds;

/** Discord's per-part limits applied to one embed: the title, the description, each field's value, the field count. */
function tidy(e: Embed): Embed {
  return {
    ...e,
    ...(e.title != null ? { title: e.title.length > DISCORD_TITLE_MAX ? `${e.title.slice(0, DISCORD_TITLE_MAX - 1)}…` : e.title } : {}),
    ...(e.description != null ? { description: cutValue(e.description, DISCORD_DESCRIPTION_MAX) } : {}),
    ...(e.fields ? { fields: e.fields.slice(0, DISCORD_FIELDS_MAX).map((f) => ({ ...f, value: cutValue(f.value) })) } : {}),
  };
}

/** The webhook body: the sender's name and the embeds; allowed_mentions is the poster's to add. */
export function digestPayload(embeds: Embed[], avatarUrl?: string): { username: string; avatar_url?: string; embeds: Embed[] } {
  return { username: 'NamadaTrade', ...(avatarUrl ? { avatar_url: avatarUrl } : {}), embeds: embeds.slice(0, DISCORD_EMBEDS_MAX) };
}
