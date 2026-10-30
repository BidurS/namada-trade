// Provenance vocabulary for the UI (system.md 8 and 12; build-plan 5.2).
//
// The server speaks `live | stale | missing | conflict`. The UI says fresh, old, no data and
// sources disagree, always with a word next to any colour. Technical source names (the
// ones the worker writes into `Provenance.source`) are shown in plain words; the technical
// name appears only in the sheet, under "Technical name".
import type { ReactNode } from 'react';
import type { Check, Pressure, Provenance, SourceStatus, Sourced } from '../../../shared/types';
import { ageOf, fmtCount, fmtDayMonthYear, fmtMonthYear, fmtNamRule, fmtPctRule, fmtSharePct, fmtUtcClock, fmtUtcLong } from './format';
import { DEPTH_CHECK_TITLES } from '../../../shared/depth-checks';

export type Status = SourceStatus;
/** The four data states as the UI names them (the `data-status` attribute values). */
export type UiStatus = 'fresh' | 'old' | 'none' | 'disagree';

/**
 * The stamp every figure carries. A `Provenance` from the API is a valid Stamp; the extra
 * fields are for the sheet: a plain source name, what a derived value was made from, and
 * extra rows (e.g. "Staked, read from the chain" / "14,662,107 NAM").
 */
export interface Stamp extends Provenance {
  /** Plain source name for the stamp text ("Osmosis quote"); defaults to PLAIN_SOURCE[source]. */
  plain?: string;
  /** For derived values: what was combined ("price x alert size"). */
  derivedFrom?: string;
  /** For derived values: each input with its own source, time and status (filled by derive()). */
  inputs?: { name: string; at: number | null; status: Status }[];
  /** Extra sheet rows, label then value. */
  extra?: [string, ReactNode][];
}

export type { Provenance, Sourced };

export const UI_STATUS: Record<Status, UiStatus> = { live: 'fresh', stale: 'old', missing: 'none', conflict: 'disagree' };
export const uiStatus = (s: Status | null | undefined): UiStatus => (s ? UI_STATUS[s] : 'none');

/** The visible state word (sentence case). */
export const STATUS_WORD: Record<UiStatus, string> = { fresh: 'fresh', old: 'old', none: 'no data', disagree: 'sources disagree' };
export const statusWord = (s: Status | null | undefined): string => STATUS_WORD[uiStatus(s)];

/** Worst-first order used by derive() and scope summaries: no data > disagree > old > fresh. */
export const STATUS_RANK: Record<Status, number> = { live: 0, stale: 1, conflict: 2, missing: 3 };
export const worstStatus = (list: Status[]): Status =>
  list.reduce<Status>((w, s) => (STATUS_RANK[s] > STATUS_RANK[w] ? s : w), 'live');

/**
 * Technical source name (as the worker writes it) to the plain word on the stamp. Prefix
 * matches cover the parametrised names ("Namada RPC Papadritta", "Namada RPC x (vp/pos…)").
 */
export const PLAIN_SOURCE: Record<string, string> = {
  'Osmosis SQS': 'Osmosis quote',
  'Osmosis SQS (stored)': 'Osmosis quote',
  'Osmosis quote': 'Osmosis quote',
  'Osmosis router': 'Osmosis quote',
  'Osmosis SQS pools': 'Osmosis pools',
  'Osmosis SQS pools (stored)': 'Osmosis pools',
  'Osmosis bank': 'Osmosis supply',
  'Keplr Osmosis bank/supply': 'Osmosis supply',
  'executed NAM/USDC swaps (hourly median)': 'Executed swaps',
  'D1 flow index': 'Flow index',
  'D1 flow index (daily)': 'Flow index',
  'executed Osmosis swaps (flow index)': 'Executed swaps',
  'Osmosis data API': 'Osmosis app data',
  'D1 index (RPC failed)': 'Flow index',
  'last indexed Namada flow': 'Flow index',
  'last indexed Osmosis flow': 'Flow index',
  'Namada RPC abci_query': 'Namada node',
  'Namada RPC (MASP balance)': 'Namada node',
  'Namada RPC status': 'Namada node',
  'Namada nodes': 'Namada nodes',
  'namada-rpc': 'Namada node',
  'Namada chain parameters': 'Chain parameter',
  'Namada governance (indexer)': 'Namada indexer',
  'Namada indexer (unbond withdraw times)': 'Namada indexer',
  'indexer.namada.net': 'Namada indexer',
  'NamadaTrade holder index': 'Holder index',
  'bond/unbond history (estimate)': 'Flow estimate',
  derived: 'Derived',
  'size table': 'Size table',
  'cross-check': 'Cross-checks',
};

const PREFIXES: [string, string][] = [
  ['Namada RPC', 'Namada node'],
  ['Osmosis SQS pools', 'Osmosis pools'],
  // the pools' sizes from their reserves (worker/src/pool-sizes.ts): the stored list, the depth minute's or the list's
  ['Osmosis pool reserves', 'Osmosis pools'],
  ['Osmosis SQS', 'Osmosis quote'],
  ['Keplr Osmosis', 'Osmosis supply'],
  ['Osmosis public REST', 'Osmosis supply'],
  ['D1 ', 'Flow index'],
  ['indexer', 'Namada indexer'],
];

/**
 * The NAM price read as the spot of the route the Osmosis router quotes for a size (the worker's price-how.ts, when
 * the price list gives NAM no price): 'Osmosis SQS route spot, 1,000 NAM', stored or not, says the size in plain words.
 */
const ROUTE_SPOT = /^Osmosis SQS route spot(, [\d,.]+ NAM)?/;

/** Plain words for a stamp's source. Unknown names pass through unchanged (never invented). */
export const plainSource = (p: Pick<Stamp, 'source' | 'plain'> | null | undefined): string => {
  if (!p) return 'Unknown source';
  if (p.plain) return p.plain;
  const exact = PLAIN_SOURCE[p.source];
  if (exact) return exact;
  const route = ROUTE_SPOT.exec(p.source);
  if (route) return `Osmosis route quote${route[1] ?? ''}`;
  for (const [pre, word] of PREFIXES) if (p.source.startsWith(pre)) return word;
  return p.source;
};

/**
 * The stamp text (system.md 8, ProvChip/ProvDot): "{source} · {age}"; old: "{source} · old {age}";
 * none: "{source} · no data"; disagree: "{source} · disagree {age}". The dot never stands alone.
 */
export const stampText = (p: Stamp, now: number, label?: string): string => {
  const src = label ?? plainSource(p);
  const ui = uiStatus(p.status);
  const age = ageOf(p.at, now);
  if (ui === 'none') return `${src} · no data`;
  if (p.at == null) return `${src} · ${ui === 'fresh' ? 'time unknown' : STATUS_WORD[ui]}`;
  if (ui === 'old') return `${src} · old ${age}`;
  if (ui === 'disagree') return `${src} · disagree ${age}`;
  return `${src} · ${age}`;
};

/** The accessible name of a stamp button: "NAM price: fresh, 10 s. Show source." */
export const stampAria = (what: string, p: Stamp, now: number): string => {
  const ui = uiStatus(p.status);
  const age = p.at == null ? 'time unknown' : ageOf(p.at, now) === 'now' ? 'just now' : ageOf(p.at, now);
  return `${what}: ${STATUS_WORD[ui]}${ui === 'none' ? '' : `, ${age}`}. Show source.`;
};

/** One scope-sheet row value: "Namada indexer · 11:24 UTC · 9 s · fresh". */
export const scopeRowText = (p: Stamp, now: number): string => {
  const ui = uiStatus(p.status);
  if (p.at == null) return `${plainSource(p)} · ${STATUS_WORD[ui]}`;
  const age = ageOf(p.at, now);
  return `${plainSource(p)} · ${fmtUtcClock(p.at)} · ${age === 'now' ? 'just now' : age} · ${STATUS_WORD[ui]}`;
};

/**
 * The age span of a scope ("9 s to 10 s", "32 min to 3.2 h", "just now"), youngest to oldest.
 * Unknown times are skipped; all unknown gives "time unknown".
 */
export const ageRange = (stamps: Stamp[], now: number): string => {
  const ats = stamps.map((s) => s.at).filter((a): a is number => a != null);
  if (!ats.length) return 'time unknown';
  const young = ageOf(Math.max(...ats), now);
  const old = ageOf(Math.min(...ats), now);
  const w = (a: string) => (a === 'now' ? 'just now' : a);
  if (young === old) return w(young);
  return `${young} to ${old}`;
};

/**
 * Plain titles for the cross-checks, keyed by `check.key` (the worker's titles are
 * operator text and appear only under "How it is computed").
 */
export const CHECK_TITLES: Record<string, string> = {
  ibc_conservation: 'NAM locked at the Namada bridge (for every chain) matches NAM on Osmosis',
  bonded_coverage: 'Staked NAM is traced to the addresses that staked it',
  rpc_consensus: 'Two Namada nodes agree on the latest block',
  supply_integrity: 'NAM in staking, the bridge, the shielded pool and public funding never exceeds all NAM',
  indexer_lag: 'The Namada indexer (indexer.namada.net) keeps up with the chain',
  supply_cross_source: 'Total supply is the same in two sources',
  price_vs_execution: 'The quoted price matches what trades paid',
  stake_within_staking_account: 'What is staked fits in the staking account',
  namada_index_lag: "This site's Namada records keep up with the chain",
  osmosis_index: "This site's Osmosis records are listening and caught up",
  osmosis_stream_share: 'Osmosis moves reach this site as they happen',
  bridge_records_paired: 'Every bridge crossing is on record on both chains',
  // the depth module's four checks, titled where the module keeps its words (shared/depth.ts)
  ...DEPTH_CHECK_TITLES,
};

/** A check's plain title: CHECK_TITLES, else its key in words. */
export const checkTitle = (c: Pick<Check, 'key'>): string => CHECK_TITLES[c.key] ?? `${c.key.charAt(0).toUpperCase()}${c.key.slice(1).replace(/_/g, ' ')}`;

const detailNum = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v.replace(/[%,\s]/g, '')) : NaN;
  return Number.isFinite(n) ? n : null;
};
const plural = (n: number, one: string, many: string) => `${fmtCount(n)} ${Math.abs(n) === 1 ? one : many}`;
/**
 * The share of moves found late as the stream-share line shows it, from the counts: one decimal, but a share under the
 * pass line never reads as the line or over it (4.97% is "4.97%", two decimals cut, not "5.0%"), and a share that is
 * not nothing never reads 0.0% (1 of 3,000 is "0.033%").
 */
const lateShare = (late: number, n: number, line: number | null): string => {
  const s = (late / n) * 100;
  const one = Math.round(s * 10) / 10;
  if (line != null && s < line && one >= line) return fmtPctRule(Math.floor(s * 100) / 100, 2);
  if (late > 0 && one === 0) return fmtSharePct(s);
  return fmtPctRule(s, 1);
};

/**
 * A check's result in one plain line under its title ("1,614 NAM apart", "68.2% of staked NAM matched to
 * addresses"), from the detail fields the worker sends; null when the detail is not one we know.
 */
export function checkDetail(c: Check): string | null {
  const d = c.detail ?? {};
  switch (c.key) {
    case 'ibc_conservation': {
      // `driftNam` is the difference once the packets stuck in the escrow are counted. Each packet carries its
      // own note ("stuck in a transfer to Noble that was refused and never refunded") and send date, so the
      // sentence names what it counts: "Equal, counting 1,614 NAM stuck in a transfer to Noble … (26 Jun 2026)".
      // `over` names the larger side once the gap is past the check's tolerance (a result from before 2026-10-21
      // has none). The bridge holds NAM for every chain and only Osmosis is read, so the bridge holding more is
      // said as that, with what it may be, never as a plain mismatch.
      const x = detailNum(d.driftNam);
      if (x == null) return null;
      const stuck = detailNum(d.stuckNam) ?? 0;
      const amt = fmtNamRule(Math.abs(x));
      const gap = d.over === 'escrow' ? `The Namada bridge holds ${amt} NAM more than Osmosis counts`
        : d.over === 'osmosis' ? `Osmosis counts ${amt} NAM more than the Namada bridge holds`
        : Math.abs(x) < 1 ? 'Equal' : `${amt} NAM apart`;
      const why = d.over === 'escrow' ? '; the bridge holds NAM for every chain and only Osmosis is read, so the difference may be NAM sent to another chain' : '';
      if (!(stuck > 0)) return `${gap}${why}`;
      const packets = Array.isArray(d.stuckPackets) ? (d.stuckPackets as { sentAt?: unknown; note?: unknown }[]) : [];
      const dates = packets.map((p) => p.sentAt).filter((v): v is string => typeof v === 'string').map((v) => Date.parse(v)).filter(Number.isFinite).sort();
      const when = dates.length ? ` (${packets.length === 1 ? '' : 'since '}${fmtDayMonthYear(dates[0])})` : '';
      const note = packets.length === 1 && typeof packets[0].note === 'string' ? packets[0].note : null;
      const what = note ?? (packets.length <= 1 ? 'stuck in a transfer that was never delivered and never refunded' : `stuck in ${fmtCount(packets.length)} transfers never delivered and never refunded`);
      return `${gap}, counting ${fmtNamRule(stuck)} NAM ${what}${when}${why}`;
    }
    case 'bonded_coverage': {
      const x = detailNum(d.coveragePct);
      if (x == null) return null;
      const n = detailNum(d.stakers);
      const pending = detailNum(d.pendingAddresses) ?? 0;
      const to = n != null ? ` to ${fmtCount(n)} addresses` : '';
      const still = pending > 0 ? `; ${fmtCount(pending)} more addresses are still being read` : '';
      // The chain's bond listing counts bonds before they start earning (the pipeline), so it can run a little
      // above the total stake: then every staked NAM is traced, and the figure says by how much and why it exceeds
      // 100% (slashed bonds are already left out of the listing's sum; the detail carries both figures).
      const pipeline = detailNum(d.pipelineNam);
      const excess = pipeline != null && pipeline > 0 ? `${fmtNamRule(pipeline)} NAM of bonds still waiting to start are listed too` : 'bonds still waiting to start are listed too';
      if (x > 100) return `All staked NAM traced${to}; their bonds add up to ${fmtPctRule(x, 1)} of the total stake because ${excess}${still}`;
      return `${fmtPctRule(x, 1)} of staked NAM traced${to}${still}`;
    }
    case 'rpc_consensus': {
      const x = detailNum(d.heightDiff);
      return x == null ? null : `${plural(Math.abs(x), 'block', 'blocks')} apart`;
    }
    case 'supply_integrity': {
      const x = detailNum(d.pctLocked);
      return x == null ? null : `${fmtPctRule(x)} of all NAM is in those four places`;
    }
    case 'indexer_lag': {
      const x = detailNum(d.lagBlocks);
      return x == null ? null : `${plural(Math.abs(x), 'block', 'blocks')} behind`;
    }
    case 'supply_cross_source': {
      const x = detailNum(d.diffNam);
      if (x == null) return null;
      const src = typeof d.otherSource === 'string' ? d.otherSource.replace(/ \(indexer\.namada\.net\)$/, '') : 'the Namada indexer';
      return `${fmtNamRule(Math.abs(x))} NAM apart (${src} and a Namada node)`;
    }
    case 'price_vs_execution': {
      // Nothing to compare: no trade the check trusts (direct NAM-to-USDC, one pool) in its window.
      if (d.noTrades === true) {
        return typeof d.lastTradeAt === 'number' && Number.isFinite(d.lastTradeAt)
          ? `Last direct NAM-to-USDC trade: ${fmtUtcLong(d.lastTradeAt)}`
          : 'No direct NAM-to-USDC trade on record';
      }
      const x = detailNum(d.deviationPct);
      return x == null ? null : `${fmtPctRule(Math.abs(x))} apart`;
    }
    case 'namada_index_lag': {
      const x = detailNum(d.lagBlocks);
      return x == null ? null : `${plural(Math.abs(x), 'block', 'blocks')} behind`;
    }
    case 'bridge_records_paired': {
      const a = detailNum(d.onlyOnNamada);
      const b = detailNum(d.onlyOnOsmosis);
      if (a == null || b == null) return null;
      // More records than one read takes: only the crossings after judgedFrom were paired, and the line says so.
      const from = detailNum(d.judgedFrom);
      return `${plural(a + b, 'crossing', 'crossings')} on one chain only${from != null ? `, judging only crossings since ${fmtUtcLong(from)}: there were too many records to pair 14 days` : ''}`;
    }
    case 'stake_within_staking_account': {
      const x = detailNum(d.notStakedNam);
      return x == null ? null : `${fmtNamRule(x)} NAM in the staking account is not staked: unstaking, ready to withdraw, or unclaimed rewards`;
    }
    case 'osmosis_index':
      return typeof d.streaming === 'boolean' ? (d.streaming ? 'listening' : 'not listening') : null;
    case 'osmosis_stream_share': {
      // The share of the last 24 h of Osmosis moves that the five-minute catch-up found rather than the live stream
      // (worker/src/cron.ts streamShareCheck), from its counts; a day with no move has nothing to compare, never 0%,
      // and a day with too few moves to judge says how many, not a share.
      if (d.noFlows === true) return 'No Osmosis move in the last 24 h to compare';
      const n = detailNum(d.flows), late = detailNum(d.catchUp);
      if (n == null || late == null || n <= 0 || late < 0 || late > n) return null;
      const min = detailNum(d.minFlows);
      if (d.tooFew === true && min != null) {
        return `Too few to judge: ${plural(n, 'Osmosis move', 'Osmosis moves')} in the last 24 h, ${late === 0 ? 'none' : fmtCount(late)} found late; the share is judged from ${plural(min, 'move', 'moves')}`;
      }
      if (late === 0) return `None found late: ${n === 1 ? 'the one Osmosis move' : `all ${plural(n, 'Osmosis move', 'Osmosis moves')}`} in the last 24 h ${n === 1 ? 'was' : 'were'} heard live`;
      return `${lateShare(late, n, detailNum(d.okBelowPct))} found late: ${fmtCount(late)} of ${plural(n, 'Osmosis move', 'Osmosis moves')} in the last 24 h ${late === 1 ? 'was' : 'were'} not heard live; the five-minute catch-up found ${late === 1 ? 'it' : 'them'}`;
    }
    case 'depth_budget': {
      // The depth store's caps (worker/src/depth/budget.ts budgetCheckStmt): the rows written this month against the
      // cap, the database size the last statement reported, the archive puts; and the store's own reason when a cap
      // stopped its writes. Every figure is the check's own detail, none typed here.
      const rows = detailNum(d.rowsWritten), max = detailNum(d.rowsMonthMax), pct = detailNum(d.pctOfCap);
      if (rows == null || max == null) return null;
      const month = fmtMonthYear(typeof d.month === 'string' ? d.month : null);
      const size = detailNum(d.sizeAfter);
      const puts = detailNum(d.r2Puts);
      const parts = [`${fmtCount(rows)} of ${fmtCount(max)} rows written${month ? ` in ${month}` : ' this month'}${pct != null ? ` (${fmtPctRule(pct, 1)} of the cap)` : ''}`];
      parts.push(size != null ? `database ${(size / 1e9).toFixed(3)} GB` : 'database size not reported');
      if (puts != null) parts.push(`${plural(puts, 'archive put', 'archive puts')}`);
      const why = typeof d.why === 'string' && d.why ? `; ${d.why}` : '';
      return `${parts.join(', ')}${why}`;
    }
    default:
      return null;
  }
}

/** The stamp of the checks as a group: when they last ran. */
export function checksStamp(checks: Check[]): Stamp {
  const ats = checks.map((c) => c.checkedAt).filter((t) => Number.isFinite(t));
  return ats.length
    ? { source: 'cross-check', plain: 'Cross-checks', at: Math.max(...ats), status: 'live' }
    : { source: 'cross-check', plain: 'Cross-checks', at: null, status: 'missing', note: 'No cross-check results were served.' };
}

/**
 * The unstaking wait's stamp: when the chain parameters behind `pressure.unbondingDays` were read (the server
 * sends `unbondingProv`; a server before 2026-10-17 does not, and the stamp then says the time is unknown).
 */
export function unbondingStamp(p: Pick<Pressure, 'unbondingDays' | 'unbondingProv'> | null | undefined): Stamp | null {
  if (!p) return null;
  // A server from 2026-10-18 on measures the epoch and adds the penalty (cubic slashing) window; an older one
  // counted unbonding + pipeline epochs of a fixed length.
  const derivedFrom = p.unbondingProv ? '(pipeline + unbonding + penalty window epochs) × measured epoch length' : '(unbonding + pipeline epochs) × epoch length';
  if (p.unbondingDays == null) return { source: 'Namada chain parameters', plain: 'Chain parameter', at: null, status: 'missing', note: p.unbondingProv?.note ?? 'The chain parameters could not be read.' };
  if (p.unbondingProv) return { ...p.unbondingProv, plain: 'Chain parameter', derivedFrom };
  // A reading with no time is not "read within its usual refresh time", so it never gets the fresh dot.
  return { source: 'Namada chain parameters', plain: 'Chain parameter', at: null, status: 'stale', note: 'The time this setting was read is not known.', derivedFrom };
}

/**
 * Check status to the UI state and word: ok passes; warn and fail need a look; stale has no recent result (its source
 * stopped answering); idle ran with nothing to compare (no trade in its window), which is not a fault.
 */
export const checkUi = (s: Check['status']): { status: UiStatus; word: string } =>
  s === 'ok' ? { status: 'fresh', word: 'Passes' }
  : s === 'stale' ? { status: 'none', word: 'No recent result' }
  : s === 'idle' ? { status: 'none', word: 'Nothing to compare' }
  : { status: s === 'warn' ? 'old' : 'disagree', word: 'Needs a look' };

/** Build a Stamp from a `Sourced<T>` (or pass a Provenance through). */
export const stampOf = (s: Sourced<unknown> | Provenance | null | undefined, plain?: string): Stamp | null => {
  if (!s) return null;
  const p = 'prov' in s ? s.prov : s;
  return plain ? { ...p, plain } : p;
};

const isStampLike = (o: Record<string, unknown>): boolean => typeof o.source === 'string' && typeof o.status === 'string' && 'at' in o;

/**
 * Every stamp in a response whose status is 'live' marked 'stale', with `note` in front of its own note:
 * the shell's overview when the page stopped refreshing (the last poll failed, or no answer for two polls).
 * A server's 'live' was true when it answered; it is not true minutes later. Other states are kept (no
 * data stays no data, disagree stays disagree). A deep copy only where something changed; the input is not
 * touched. Values are never changed.
 */
export function ageOutStamps<T>(x: T, note: string): T {
  if (Array.isArray(x)) {
    let changed = false;
    const out = x.map((v) => {
      const w = ageOutStamps(v, note);
      if (w !== v) changed = true;
      return w;
    });
    return (changed ? out : x) as T;
  }
  if (!x || typeof x !== 'object') return x;
  const o = x as Record<string, unknown>;
  let out: Record<string, unknown> | null = null;
  for (const [k, v] of Object.entries(o)) {
    if (v && typeof v === 'object') {
      const w = ageOutStamps(v, note);
      if (w !== v) (out ??= { ...o })[k] = w;
    }
  }
  if (isStampLike(o) && o.status === 'live') {
    out ??= { ...o };
    out.status = 'stale';
    out.note = typeof o.note === 'string' && o.note ? `${note} ${o.note}` : note;
  }
  return (out ?? o) as T;
}
