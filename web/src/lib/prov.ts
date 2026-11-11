// Provenance vocabulary for the UI (system.md 8 and 12; build-plan 5.2).
//
// The server speaks `live | stale | missing | conflict`. The UI says fresh, old, no data and
// sources disagree, always with a word next to any colour. Technical source names (the
// ones the worker writes into `Provenance.source`) are shown in plain words; the technical
// name appears only in the sheet, under "Technical name".
import type { ReactNode } from 'react';
import type { Check, Pressure, Provenance, SourceStatus, Sourced } from '../../../shared/types';
import { MINUS, ageOf, fmtCount, fmtDayMonthYear, fmtMonthYear, fmtNamRule, fmtPctRule, fmtSharePct, fmtUtcClock, fmtUtcLong } from './format';
import { DEPTH_CHECK_TITLES } from '../../../shared/depth-checks';
import { notJudgedAcross } from '../../../shared/halts';

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
  // the pool's balance after a move, as the block's own transfer event records it (meta.maspPostNam), and the chain's
  // running total of shielded rewards (the daily ledger's read of the pool's max_total_rewards key)
  'Namada block record (pool balance after the move)': 'Namada block record',
  'Namada RPC (shielded rewards total)': 'Namada node',
  // the shielded transactions a day (worker/src/series-api.ts MASP_ACTIVITY_SOURCE): this site's own record of each block
  'NamadaTrade shielded-transaction record (daily)': 'Shielded-transaction record',
  // the genesis cohorts (worker/src/series-api.ts COHORT_SOURCE, GENESIS_TABLE_SOURCE): the allocation table from the
  // public genesis file, joined with the holder index and the flow index once a day
  'Genesis allocations · holder index · D1 flow index (daily snapshot)': 'Genesis file, holder index and flow index',
  'Genesis allocations (namada-mainnet-genesis balances.toml)': 'Genesis file',
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

/**
 * The technical source names the shielded page's ledger and moves-out shares carry (as the Worker writes them:
 * analytics.ts POOL_RECORD_SOURCE, series.ts readMaspMakeup), kept here so the screen types no raw name.
 */
export const POOL_SOURCES = {
  record: 'Namada block record (pool balance after the move)',
  reading: 'Namada RPC (MASP balance)',
  rewards: 'Namada RPC (shielded rewards total)',
  index: 'D1 flow index',
} as const;

/** The technical source names of the Supply page's since-genesis figures (worker/src/api.ts, the overview's supply.shieldedRewards and supply.mint). */
export const SUPPLY_SOURCES = {
  rewards: POOL_SOURCES.rewards,
  mint: 'Namada RPC abci_query (last_inflation_amount)',
} as const;

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
 * none: "{source} · no data"; disagree: "{source} · disagree {age}"; the current record of an event:
 * "{source} · last trade {age} ago". The dot never stands alone.
 */
export const stampText = (p: Stamp, now: number, label?: string): string => {
  const src = label ?? plainSource(p);
  const ui = uiStatus(p.status);
  const age = ageOf(p.at, now);
  if (ui === 'none') return `${src} · no data`;
  if (p.at == null) return `${src} · ${ui === 'fresh' ? 'time unknown' : STATUS_WORD[ui]}`;
  if (ui === 'old') return `${src} · old ${age}`;
  if (ui === 'disagree') return `${src} · disagree ${age}`;
  // the record of an event that is current: its age is how long ago the event was, said as that (owner decision 48)
  if (p.event === 'trade') return `${src} · last trade ${age} ago`;
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
  ibc_conservation: 'NAM locked at the Namada bridge matches NAM on the chains it bridges to',
  bonded_coverage: 'Staked NAM is traced to the addresses that staked it',
  rpc_consensus: 'Two Namada nodes agree on the latest block',
  supply_integrity: 'NAM in staking, the bridge, the shielded pool and public funding never exceeds all NAM',
  indexer_lag: 'The Namada indexer (indexer.namada.net) keeps up with the chain',
  supply_cross_source: 'Total supply is the same in two sources',
  price_vs_execution: 'The quoted price matches what trades paid',
  stake_within_staking_account: 'What is staked fits in the staking account',
  // the mint rule and the balance listing's sum (worker/src/cron.ts mintRuleNext, listingSumCheck)
  supply_mint_rule: "All NAM minted changes only as an epoch starts, and only by what that epoch's inflation adds",
  balances_sum_to_minted: 'The NAM balances add up to all NAM minted',
  namada_index_lag: "This site's Namada records keep up with the chain",
  osmosis_index: "This site's Osmosis records are listening and caught up",
  osmosis_stream_share: 'Osmosis moves reach this site as they happen',
  bridge_records_paired: 'Every bridge crossing is on record on both chains',
  // the trust checks of 2026-11-07 (worker/src/cron.ts maspLedgerCheck, posRemainderNext, bondSourcesCheck, maspCoverageCheck)
  masp_ledger: "The shielded pool's NAM moves add up to its balance change",
  pos_remainder: "The staking account's NAM outside bonds and unstaking rises only by staking inflation and slashing",
  bond_sources: 'No protocol account appears as a staker',
  masp_tx_coverage: "Every shielded transaction Namada's shielded-transaction indexer lists for the blocks this site has scanned since this record began is in this site's record",
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
 * An exact NAM amount from base units (a string of digits, as the checks that judge to the base unit send them), all
 * six decimals kept: "1,148,754,488.433455", "0.000012", "−19,961.144868"; null when it is not one. Never a float.
 */
const exactNam = (base: unknown): string | null => {
  if (typeof base !== 'string' || !/^-?\d+$/.test(base)) return null;
  const neg = base.startsWith('-');
  const digits = (neg ? base.slice(1) : base).replace(/^0+(?=\d)/, '').padStart(7, '0');
  const whole = digits.slice(0, -6).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg && /[1-9]/.test(digits) ? MINUS : ''}${whole}.${digits.slice(-6)}`;
};
/** A NAM amount from a float the worker summed, six decimals kept ("1,234.567890", "−0.000250"); null when it is not a number. */
const nam6 = (v: unknown): string | null => {
  const n = detailNum(v);
  if (n == null) return null;
  const s = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 6, maximumFractionDigits: 6 });
  return `${n < 0 && /[1-9]/.test(s) ? MINUS : ''}${s}`;
};
/** An epoch number as the chain names it ("2738", no grouping). */
const epochNo = (n: number | null): string => (n == null ? '—' : String(Math.round(n)));
/**
 * A pair not judged across a stretch in which Namada made no blocks (shared/halts.ts), from a check's detail.halt, in
 * the words the Worker wrote its note in; null when the detail carries none.
 */
const acrossWords = (h: unknown): string | null => {
  const o = h && typeof h === 'object' ? (h as Record<string, unknown>) : null;
  const lastBlock = detailNum(o?.lastBlock);
  if (lastBlock == null) return null;
  const w = notJudgedAcross({ lastBlock, lastBlockAt: detailNum(o?.lastBlockAt), resumedAt: detailNum(o?.resumedAt) });
  return w.charAt(0).toUpperCase() + w.slice(1);
};
/** A base-unit string without its sign. */
const unsigned = (base: unknown): unknown => (typeof base === 'string' ? base.replace(/^-/, '') : base);
/** Why the mint rule did not judge a minute (worker/src/cron.ts MintNotJudged), in words. */
const MINT_NOT_JUDGED: Record<string, string> = {
  'minted-not-read': 'the total of all NAM was not read',
  'epoch-not-read': 'the epoch was not read',
  'different-blocks': 'the total and the epoch came from different blocks',
  older: 'the answer was older than the last one judged',
  'step-not-read': "the chain's record of the new epoch's inflation was not read",
};
/** One epoch step of the mint rule, from the detail (its amounts are base-unit strings). */
interface MintStepDetail { epoch: number; height: number; grewBase: string; stakingBase: string; shieldedBase: string; fits?: boolean }
const mintStepOf = (v: unknown): MintStepDetail | null => {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  const epoch = detailNum(o?.epoch), height = detailNum(o?.height);
  return o && epoch != null && height != null && exactNam(o.grewBase) != null && exactNam(o.stakingBase) != null ? { ...(o as unknown as MintStepDetail), epoch, height } : null;
};
/**
 * What an epoch step added, as the line says it: the staking inflation alone, or with the rest, which the chain records
 * no figure for: only that it is within the shielded pool's own rise, where shielded rewards are credited.
 */
const mintStepWords = (s: MintStepDetail): string => {
  const shielded = exactNam(s.shieldedBase);
  return shielded != null && /[1-9]/.test(s.shieldedBase)
    ? `${exactNam(s.stakingBase)} NAM of staking inflation the chain recorded and ${shielded} NAM more, within the shielded pool's own rise, where shielded rewards are credited`
    : 'exactly the staking inflation the chain recorded';
};
/** The node or nodes a broken mint rule rests on: "node A", "nodes A and B"; null when the detail names none. */
const mintNodes = (...names: unknown[]): string | null => {
  const set = [...new Set(names.filter((x): x is string => typeof x === 'string' && x !== ''))];
  return set.length === 0 ? null : set.length === 1 ? `node ${set[0]}` : `nodes ${set[0]} and ${set[1]}`;
};
/**
 * A span the mint rule did not judge exactly (worker/src/cron.ts MintRuleState.unjudged), after "Not judged": a gap
 * of epochs, public funding minting, or more than the staking inflation on a shielded-reward epoch that the shielded
 * pool's own change over the same blocks cannot account for. null when the detail is not one of these.
 */
const mintSpanWords = (u: Record<string, unknown> | null): string | null => {
  const v = u?.verdict && typeof u.verdict === 'object' ? (u.verdict as Record<string, unknown>) : null;
  if (!u || !v) return null;
  const from = detailNum(u.fromHeight), to = detailNum(u.toHeight);
  if (v.kind === 'gap') {
    const n = detailNum(v.epochs);
    return n == null ? null : `across ${plural(n, 'epoch', 'epochs')}${from != null && to != null ? `: no reading between blocks ${fmtCount(from)} and ${fmtCount(to)}` : ''}`;
  }
  const at = epochNo(detailNum(u.toEpoch));
  if (v.kind === 'public-funding') return `exactly as epoch ${at} started: public funding mints NAM too, on a base this check does not compute`;
  const st = v.kind === 'shielded-unchecked' ? mintStepOf(v.step) : null;
  if (!st || exactNam(st.shieldedBase) == null || from == null || to == null) return null;
  const rise = exactNam((v.step as Record<string, unknown>).maspRiseBase);
  const pool = rise == null ? `was not read at both blocks (${fmtCount(from)} and ${fmtCount(to)})` : `changed by ${rise} NAM between blocks ${fmtCount(from)} and ${fmtCount(to)}`;
  return `exactly as epoch ${at} started: all NAM minted grew by ${exactNam(st.grewBase)} NAM, ${exactNam(st.shieldedBase)} NAM more than the staking inflation the chain recorded, while the shielded pool's NAM, where shielded rewards are credited, ${pool}`;
};
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
      // Since 2026-11-10 the check also counts the NAM on every other chain a channel leads to that could be read
      // (worker/src/bridges.ts): `otherChainsRead` names them and `otherChainsUnread` the ones with no current figure.
      // A result from before then, or from a tick with no channel list yet, has neither (absent or null), and reads
      // as it did: only Osmosis was read.
      const names = (v: unknown): string[] | null => (Array.isArray(v) ? v.filter((n): n is string => typeof n === 'string') : null);
      const read = names(d.otherChainsRead), unread = names(d.otherChainsUnread) ?? [];
      const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
      const also = read?.length ? ` and the ${fmtCount(read.length)} other ${read.length === 1 ? 'chain' : 'chains'} read` : '';
      const gap = d.over === 'escrow' ? `The Namada bridge holds ${amt} NAM more than Osmosis${also ? `${also} hold` : ' counts'}`
        : d.over === 'osmosis' ? `Osmosis${also} ${also ? 'count' : 'counts'} ${amt} NAM more than the Namada bridge holds`
        : Math.abs(x) < 1 ? 'Equal' : `${amt} NAM apart`;
      const why = d.over !== 'escrow' ? ''
        : read == null ? '; the bridge holds NAM for every chain and only Osmosis is read, so the difference may be NAM sent to another chain'
          : unread.length ? `; ${list(unread)} ${unread.length === 1 ? 'is' : 'are'} not read, so the difference may be NAM sent there`
            : '; every other chain the bridge has a channel to was read';
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
      // 2026-11-08: while the chain makes no block (the halt), the index stands at its newest block and the row is idle.
      if (d.notJudged === 'no-new-blocks') return 'at the chain\'s newest block: no new block to index';
      // no node answered its height this tick: the index cannot be placed against the chain (the node row says which failed)
      if (d.notJudged === 'head-not-read') return 'no Namada node answered its height: the index cannot be placed against the chain';
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
      // Split by the last bond listing when the worker sends it (cron.ts stakeSplit, from 2026-11-02): what it lists as
      // unstaking, its bonds still waiting to start, and the rest, which no listing names. The parts are as of the
      // listing's block, so the line names it.
      const x = detailNum(d.notStakedNam);
      if (x == null) return null;
      const u = detailNum(d.unstakingNam), rest = detailNum(d.restNam), h = detailNum(d.listingHeight);
      if (u == null || rest == null || h == null) return `${fmtNamRule(x)} NAM in the staking account is not staked: unstaking, ready to withdraw, or unclaimed rewards`;
      const w = detailNum(d.waitingNam) ?? 0;
      const waiting = w >= 1 ? `, ${fmtNamRule(w)} in bonds still waiting to start` : '';
      return `${fmtNamRule(x)} NAM in the staking account is not staked: ${fmtNamRule(u)} unstaking or ready to withdraw (the chain's bond listing at block ${fmtCount(h)})${waiting}, and ${fmtNamRule(rest)} neither staked nor unstaking, which the bond listing does not name (unclaimed rewards are held here)`;
    }
    case 'supply_mint_rule': {
      // The minted total judged every minute against the last reading the rule held for (worker/src/cron.ts
      // mintRuleNext): unchanged within an epoch, and at an epoch's start grown by what the chain recorded. A rule broken
      // in the last day is said first, as the answers of the node or nodes it rests on, with both blocks; a span not
      // judged exactly in the last day is said after the minute's own line. Never more than what was compared.
      const epoch = detailNum(d.epoch), height = detailNum(d.height);
      const step = mintStepOf(d.lastStep);
      const b = d.broke && typeof d.broke === 'object' ? (d.broke as Record<string, unknown>) : null;
      if (b) {
        const v = (b.verdict && typeof b.verdict === 'object' ? b.verdict : {}) as Record<string, unknown>;
        const bs = mintStepOf(v.step);
        const nodes = mintNodes(b.fromProvider, b.provider);
        const whose = `the answers${nodes ? ` of ${nodes}` : ''} for all NAM minted`;
        const span = `blocks ${fmtCount(detailNum(b.fromHeight))} to ${fmtCount(detailNum(b.toHeight))}`;
        const what = v.kind === 'changed' && exactNam(v.byBase) != null ? `${whose} changed by ${exactNam(v.byBase)} NAM within epoch ${epochNo(detailNum(b.toEpoch))} (${span}), though all NAM minted changes only as an epoch starts`
          : v.kind === 'step-off' && bs ? `${whose} grew by ${exactNam(bs.grewBase)} NAM as epoch ${epochNo(bs.epoch)} started (${span}), not the ${exactNam(bs.stakingBase)} NAM of staking inflation the chain recorded`
          : null;
        if (what) return `On ${fmtUtcLong(detailNum(b.at))} ${what}; read again every minute`;
      }
      const u = d.unjudged && typeof d.unjudged === 'object' ? (d.unjudged as Record<string, unknown>) : null;
      const span = mintSpanWords(u);
      if (d.verdict === 'gap' || d.verdict === 'public-funding' || d.verdict === 'shielded-unchecked') return span ? `Not judged ${span}` : null;
      const line = ((): string | null => {
        switch (d.verdict) {
          case 'same':
            if (epoch == null || height == null) return null;
            return `Unchanged within epoch ${epochNo(epoch)} (block ${fmtCount(height)})${step && step.epoch === epoch && step.fits !== false ? `; as the epoch started it grew by ${exactNam(step.grewBase)} NAM, ${mintStepWords(step)}` : ''}`;
          case 'step':
            return step ? `Grew by ${exactNam(step.grewBase)} NAM as epoch ${epochNo(step.epoch)} started (read at block ${fmtCount(step.height)}): ${mintStepWords(step)}` : null;
          case 'first':
            return height == null ? null : `First reading at block ${fmtCount(height)}; the next minute is judged against it`;
          case 'pending':
            return height == null ? null : `The reading at block ${fmtCount(height)} does not fit the one before; the next minute decides`;
          case 'not-judged': {
            if (d.why === 'halt') return acrossWords(d.halt);
            const why = typeof d.why === 'string' ? MINT_NOT_JUDGED[d.why] : undefined;
            const last = detailNum(d.judgedAt);
            return `Not judged this minute${why ? `: ${why}` : ''}${last != null ? `; last judged ${fmtUtcLong(last)}` : ''}`;
          }
          default:
            return null;
        }
      })();
      const at = detailNum(u?.at);
      return line && span && at != null ? `${line}; on ${fmtUtcLong(at)}, not judged ${span}` : line;
    }
    case 'balances_sum_to_minted': {
      // Every balance in the chain's balance listing against the minted total the same answer carries, to the base
      // unit (worker/src/cron.ts listingSumCheck), hourly. A difference is said as one, with its block and node.
      const h = detailNum(d.height);
      const block = h != null ? `block ${fmtCount(h)}` : null;
      if (d.judged !== true) return d.notJudged === 'not-read' ? 'Not added up: the balances could not be read at the last try' : `Not added up: the last answer${block ? ` (${block})` : ''} could not be used`;
      const minted = exactNam(d.mintedBase), off = exactNam(unsigned(d.diffBase));
      if (minted == null || off == null) return null;
      const n = detailNum(d.balances);
      if (!/[1-9]/.test(String(d.diffBase))) return `${n != null ? `${plural(n, 'balance', 'balances')} add` : 'The balances add'} up to ${minted} NAM, exactly all NAM minted${block ? ` (${block})` : ''}`;
      return `The balances differ from all NAM minted (${minted} NAM) by ${off} NAM${block ? ` at ${block}` : ''}${typeof d.provider === 'string' ? ` (node ${d.provider})` : ''}; read again next hour`;
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
      // the moves a history repair wrote, found by neither, are counted apart
      const repaired = detailNum(d.repaired);
      const plus = repaired != null && repaired > 0 ? `; ${plural(repaired, 'more move', 'more moves')} written by a history repair ${repaired === 1 ? 'is' : 'are'} not counted` : '';
      if (late === 0) return `None found late: ${n === 1 ? 'the one Osmosis move' : `all ${plural(n, 'Osmosis move', 'Osmosis moves')}`} in the last 24 h ${n === 1 ? 'was' : 'were'} heard live${plus}`;
      return `${lateShare(late, n, detailNum(d.okBelowPct))} found late: ${fmtCount(late)} of ${plural(n, 'Osmosis move', 'Osmosis moves')} in the last 24 h ${late === 1 ? 'was' : 'were'} not heard live; the five-minute catch-up found ${late === 1 ? 'it' : 'them'}${plus}`;
    }
    case 'masp_ledger': {
      // The shielded pool's day ledger (worker/src/cron.ts maspLedgerCheck): the moves in and out of the pool over a UTC
      // day against its balance change, within 1 NAM; on a day a shielded-reward epoch started, the rest against the
      // rise of the chain's total of shielded rewards. The day is named first; a day not judged says why.
      const day = typeof d.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.day) ? fmtDayMonthYear(Date.parse(`${d.day}T00:00:00Z`)) : null;
      if (!day) return null;
      if (d.judged !== true) {
        switch (d.notJudged) {
          case 'scan-behind': {
            const lag = detailNum(d.scanLagBlocks);
            return `${day}: not judged yet, this site's block scan is ${lag != null ? `${plural(lag, 'block', 'blocks')} behind the chain` : "not at the chain's head"}, so the day's moves are not all on record; tried again in 15 minutes`;
          }
          case 'balance-not-read': return `${day}: not judged, the pool's balance was not read at the ${d.endRead === false ? 'end' : 'start'} of the day`;
          case 'nothing-happened': return `${day}: no move into or out of the shielded pool, and its balance did not change`;
          case 'halt': { const w = acrossWords(d.halt); return w ? `${day}: ${w.charAt(0).toLowerCase()}${w.slice(1)}` : `${day}: not judged`; }
          case 'halt-unread': return `${day}: not judged yet, the time blocks were made again after a halt could not be read; tried again`;
          case 'reward-unknown': return `${day}: not judged, whether a shielded-reward epoch started in the day could not be told${typeof d.note === 'string' && d.note ? ` (${d.note})` : ''}`;
          case 'reward-not-read': return `${day}: a shielded-reward day: not judged, the chain's total of shielded rewards was not read at both ends of the day`;
          default: return `${day}: not judged`;
        }
      }
      const inNam = nam6(d.inNam), outNam = nam6(d.outNam), fees = nam6(d.feesNam), delta = nam6(d.deltaNam), residual = detailNum(d.residualNam);
      if (inNam == null || outNam == null || fees == null || delta == null || residual == null) return null;
      const off = nam6(Math.abs(residual));
      const line = `${day}: ${inNam} NAM in and ${outNam} NAM out (${fees} NAM of it the pool's fees); the pool's balance changed by ${delta} NAM, ${off === '0.000000' ? 'exactly' : `${off} NAM ${residual > 0 ? 'more' : 'less'} than`} the net of its moves`;
      const reward = d.rewardDay === true ? nam6(d.rewardNam) : null;
      const epoch = epochNo(detailNum(d.rewardEpoch));
      if (c.status === 'warn') return `${line}${reward != null ? `, on a day a shielded-reward epoch (${epoch}) started whose rewards the chain's total of shielded rewards puts at ${reward} NAM` : ''}`;
      return reward != null ? `${line}: the shielded rewards credited as epoch ${epoch} started, which the chain's total of shielded rewards puts at ${reward} NAM` : line;
    }
    case 'pos_remainder': {
      // The staking account's NAM outside bonds and unstaking between two complete bond listings (worker/src/cron.ts
      // posRemainderNext): a rise within the staking inflation of an epoch that started between them plus the NAM newly
      // slashed, a fall (not judged), or NAM that entered outside bonds and rewards. Both listings' blocks are named.
      const h = detailNum(d.height), from = detailNum(d.fromHeight), to = detailNum(d.toHeight);
      if (d.judged !== true) {
        switch (d.notJudged) {
          case 'first': return h == null ? null : `No earlier complete bond listing to compare with; the listing at block ${fmtCount(h)} is kept for the next`;
          case 'same-block': return from == null ? null : `The chain has not moved since the bond listing at block ${fmtCount(from)}: nothing new to judge`;
          case 'older': return h == null || from == null ? null : `The listing at block ${fmtCount(h)} is older than the one compared last (block ${fmtCount(from)}): not judged`;
          case 'epochs-apart': {
            const n = detailNum(d.epochsApart);
            return n == null || from == null || h == null ? null : `${plural(Math.abs(n), 'epoch', 'epochs')} started between the listings at blocks ${fmtCount(from)} and ${fmtCount(h)}: not judged, the chain keeps only the last epoch's staking inflation`;
          }
          case 'no-figures': return 'The last bond listing carries no figures for this check yet; the next listing does';
          case 'halt': return acrossWords(d.halt);
          case 'no-new-listing': return `No complete bond listing since ${fmtUtcLong(detailNum(d.listingCompleteAt))}${h != null ? ` (block ${fmtCount(h)})` : ''}: nothing new to judge`;
          default: return null;
        }
      }
      const rise = exactNam(d.riseBase);
      if (from == null || to == null || rise == null) return null;
      const blocks = `the bond listings at blocks ${fmtCount(from)} and ${fmtCount(to)}`;
      if (String(d.riseBase).startsWith('-')) return `Between ${blocks} the staking account's NAM outside bonds and unstaking fell by ${exactNam(unsigned(d.riseBase))} NAM; a fall is not judged by this check`;
      const allowed = exactNam(d.allowedBase);
      if (c.status === 'warn') {
        const over = exactNam(d.overBase) ?? rise;
        return `NAM entered the staking account outside bonds and rewards: ${over} NAM between listings at blocks ${fmtCount(from)} and ${fmtCount(to)}${allowed != null ? ` (its NAM outside bonds and unstaking rose by ${rise} NAM, ${allowed} NAM of it what staking inflation and slashing account for)` : ''}; read again at the next listing`;
      }
      const parts: string[] = [];
      const infl = exactNam(d.inflationBase);
      if (d.epochStarted === true && infl != null) parts.push(`the ${infl} NAM of staking inflation the chain recorded as epoch ${epochNo(detailNum(d.toEpoch))} started`);
      const slashed = exactNam(d.slashedRiseBase);
      if (slashed != null && /^[0-9]*[1-9]/.test(String(d.slashedRiseBase))) parts.push(`the ${slashed} NAM newly slashed`);
      return `Between ${blocks} the staking account's NAM outside bonds and unstaking rose by ${rise} NAM, ${parts.length ? `within ${parts.join(' and ')}` : 'within the 1 NAM allowed: no epoch started between them and nothing was newly slashed'}`;
    }
    case 'bond_sources': {
      // The bond listing's sources against the protocol accounts (worker/src/cron.ts bondSourcesCheck): none, or each
      // named with its bonded NAM. The protocol accounts are the only addresses a check line ever carries.
      if (d.judged !== true) return 'Not judged: the bond listing was not read at the last try';
      const h = detailNum(d.height);
      const block = h != null ? ` at block ${fmtCount(h)}` : '';
      const list = Array.isArray(d.internal) ? (d.internal as { address?: unknown; bondedBase?: unknown; bondedNam?: unknown }[]) : [];
      if (list.length === 0) {
        const n = detailNum(d.sources);
        return `${n != null ? `None of the ${plural(n, 'source', 'sources')}` : 'No source'} in the bond listing${block} is a protocol account`;
      }
      const named = list.map((x) => `${typeof x.address === 'string' ? x.address : 'an internal address'} with ${exactNam(x.bondedBase) ?? fmtNamRule(detailNum(x.bondedNam))} NAM bonded`).join('; ');
      return `${list.length === 1 ? 'A protocol account is' : `${fmtCount(list.length)} protocol accounts are`} listed as a staker in the bond listing${block}: ${named}`;
    }
    case 'masp_tx_coverage': {
      // This site's record of shielded transactions against Namada's shielded-transaction indexer (worker/src/cron.ts
      // maspCoverageCheck): every transaction the indexer lists for the blocks judged is on record, or the misses are
      // named by block, transaction and batch index, nothing more.
      if (d.judged !== true) {
        const cursor = detailNum(d.cursor), judgedTo = detailNum(d.judgedTo), ih = detailNum(d.indexerHeight);
        switch (d.notJudged) {
          case 'first-run': return cursor == null ? null : `This site's record of shielded transactions starts at block ${fmtCount(cursor)}; the blocks after it are judged from the next hour`;
          case 'no-new-heights': return judgedTo == null ? null : `No block scanned since block ${fmtCount(judgedTo)}: nothing new to compare`;
          case 'indexer-behind': return ih == null || judgedTo == null ? null : `The indexer's last shielded transaction is at block ${fmtCount(ih)}, below the blocks waiting to be judged (from ${fmtCount(judgedTo + 1)}): nothing to compare yet`;
          case 'no-cursor': return "This site's block scan has no position on record: nothing to compare";
          case 'indexer-not-read': return 'The indexer could not be read at the last try: nothing compared this hour';
          default: return null;
        }
      }
      const n = detailNum(d.indexerTxs), m = detailNum(d.missing), from = detailNum(d.from), to = detailNum(d.to);
      if (n == null || m == null || from == null || to == null) return null;
      const blocks = `blocks ${fmtCount(from)} to ${fmtCount(to)}`;
      if (n === 0) return `No shielded transaction in ${blocks}, in the indexer's record or this site's`;
      if (m === 0) return n === 1 ? `The one shielded transaction the indexer lists for ${blocks} is in this site's record` : `All ${plural(n, 'shielded transaction', 'shielded transactions')} the indexer lists for ${blocks} are in this site's record`;
      const misses = Array.isArray(d.misses) ? (d.misses as { height?: unknown; blockIndex?: unknown; batchIndex?: unknown }[]) : [];
      const named = misses.slice(0, 3).map((x) => `block ${fmtCount(detailNum(x.height))}, transaction ${fmtCount(detailNum(x.blockIndex))}, batch ${fmtCount(detailNum(x.batchIndex))}`).join('; ');
      return `${fmtCount(m)} of ${plural(n, 'shielded transaction', 'shielded transactions')} the indexer lists for ${blocks} ${m === 1 ? 'is' : 'are'} not in this site's record: ${named}${m > 3 ? `; and ${fmtCount(m - 3)} more` : ''}`;
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
