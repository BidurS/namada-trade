// Provenance vocabulary for the UI (system.md 8 and 12; build-plan 5.2).
//
// The server speaks `live | stale | missing | conflict`. The UI says fresh, old, no data and
// sources disagree, always with a word next to any colour. Technical source names (the
// ones the worker writes into `Provenance.source`) are shown in plain words; the technical
// name appears only in the sheet, under "Technical name".
import type { ReactNode } from 'react';
import type { Check, Pressure, Provenance, SourceStatus, Sourced } from '../../../shared/types';
import { ageOf, fmtCount, fmtDayMonthYear, fmtNamRule, fmtPctRule, fmtUtcClock, fmtUtcLong } from './format';

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
  ['Osmosis SQS', 'Osmosis quote'],
  ['Keplr Osmosis', 'Osmosis supply'],
  ['D1 ', 'Flow index'],
  ['indexer', 'Namada indexer'],
];

/** Plain words for a stamp's source. Unknown names pass through unchanged (never invented). */
export const plainSource = (p: Pick<Stamp, 'source' | 'plain'> | null | undefined): string => {
  if (!p) return 'Unknown source';
  if (p.plain) return p.plain;
  const exact = PLAIN_SOURCE[p.source];
  if (exact) return exact;
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
  ibc_conservation: 'NAM locked at the Namada bridge matches NAM on Osmosis',
  bonded_coverage: 'Staked NAM is traced to the addresses that staked it',
  rpc_consensus: 'Two Namada nodes agree on the latest block',
  supply_integrity: 'NAM in staking, the bridge, the shielded pool and public funding never exceeds all NAM',
  indexer_lag: 'The Namada indexer (indexer.namada.net) keeps up with the chain',
  supply_cross_source: 'Total supply is the same in two sources',
  price_vs_execution: 'The quoted price matches what trades paid',
  stake_within_staking_account: 'What is staked fits in the staking account',
  namada_index_lag: "This site's Namada records keep up with the chain",
  osmosis_index: "This site's Osmosis records are listening and caught up",
  bridge_records_paired: 'Every bridge crossing is on record on both chains',
};

/** A check's plain title: CHECK_TITLES, else its key in words. */
export const checkTitle = (c: Pick<Check, 'key'>): string => CHECK_TITLES[c.key] ?? `${c.key.charAt(0).toUpperCase()}${c.key.slice(1).replace(/_/g, ' ')}`;

const detailNum = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v.replace(/[%,\s]/g, '')) : NaN;
  return Number.isFinite(n) ? n : null;
};
const plural = (n: number, one: string, many: string) => `${fmtCount(n)} ${Math.abs(n) === 1 ? one : many}`;

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
      const x = detailNum(d.driftNam);
      if (x == null) return null;
      const stuck = detailNum(d.stuckNam) ?? 0;
      const gap = Math.abs(x) < 1 ? 'Equal' : `${fmtNamRule(Math.abs(x))} NAM apart`;
      if (!(stuck > 0)) return gap;
      const packets = Array.isArray(d.stuckPackets) ? (d.stuckPackets as { sentAt?: unknown; note?: unknown }[]) : [];
      const dates = packets.map((p) => p.sentAt).filter((v): v is string => typeof v === 'string').map((v) => Date.parse(v)).filter(Number.isFinite).sort();
      const when = dates.length ? ` (${packets.length === 1 ? '' : 'since '}${fmtDayMonthYear(dates[0])})` : '';
      const note = packets.length === 1 && typeof packets[0].note === 'string' ? packets[0].note : null;
      const what = note ?? (packets.length <= 1 ? 'stuck in a transfer that was never delivered and never refunded' : `stuck in ${fmtCount(packets.length)} transfers never delivered and never refunded`);
      return `${gap}, counting ${fmtNamRule(stuck)} NAM ${what}${when}`;
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
      return a == null || b == null ? null : `${plural(a + b, 'crossing', 'crossings')} on one chain only`;
    }
    case 'stake_within_staking_account': {
      const x = detailNum(d.notStakedNam);
      return x == null ? null : `${fmtNamRule(x)} NAM in the staking account is not staked: unstaking, ready to withdraw, or unclaimed rewards`;
    }
    case 'osmosis_index':
      return typeof d.streaming === 'boolean' ? (d.streaming ? 'listening' : 'not listening') : null;
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
