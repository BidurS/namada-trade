// Decision-level queries over D1 (see docs/decisions.md). Every function takes `asOf` so the same
// code serves the live UI and replay mode.
import type {
  AlertHit, BlindSpot, ChainParams, Flow, GovernanceProposal, IntelResponse, MoverEntry, OnDeckEntry,
  Pressure, Provenance, Sourced, UnlockEntry,
} from '../../shared/types';
import { evaluateFlows, INTERNAL_ADDRESSES, isInternal, type AlertThresholds } from '../../shared/alerts';
import { kvGetJson, kvSet } from './db';
import { NAM_AMOUNT, NOT_LEGACY_TWIN } from './flows-query';
import { safeHttpUrl, explorerHashOf } from '../../shared/flow-rules';
import { fetchJson } from './util';
import { INTERNAL_LABELS } from './config';
import { label_plain, labelAuthorShort } from './labels';

const H = 3600000, D = 86400000;
/** Supply's "Unstaking and restaking" list: moves of at least this many NAM over this many days (sent with the response). */
export const UNLOCKS_MIN_NAM = 100_000;
export const UNLOCKS_WINDOW_DAYS = 30;
const INDEXER = 'https://indexer.namada.net/api/v1';

export function safeParseJson(str: string | null | undefined, fallback: any = {}) {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

export function rowToFlow(r: any): Flow {
  const meta = safeParseJson(r.meta, null);
  return {
    id: r.id, chain: r.chain, height: r.height, ts: r.ts, txHash: r.tx_hash, explorerHash: explorerHashOf({ txHash: r.tx_hash, meta }), kind: r.kind,
    from: r.from_addr, to: r.to_addr, amount: r.amount_num,
    counterDenom: r.counter_denom, counterAmount: r.counter_amount, poolId: r.pool_id,
    priceUsd: r.price_usd, valueUsd: r.value_usd, meta,
    fromLabel: r.from_label || (r.from_addr ? INTERNAL_LABELS[r.from_addr]?.label ?? null : null),
    toLabel: r.to_label || (r.to_addr ? INTERNAL_LABELS[r.to_addr]?.label ?? null : null),
    fromLabelPlain: label_plain(r.from_label, r.from_addr, r.from_label_source),
    toLabelPlain: label_plain(r.to_label, r.to_addr, r.to_label_source),
    fromLabelSource: r.from_label ? r.from_label_source ?? null : r.from_addr && INTERNAL_LABELS[r.from_addr] ? 'auto' : null,
    toLabelSource: r.to_label ? r.to_label_source ?? null : r.to_addr && INTERNAL_LABELS[r.to_addr] ? 'auto' : null,
    // A wallet's own tag says whose it is ("Tag by tnam1qxyz…"), so it never passes for a curated name.
    fromLabelAuthor: r.from_label ? labelAuthorShort(r.from_label_source, r.from_label_author) : null,
    toLabelAuthor: r.to_label ? labelAuthorShort(r.to_label_source, r.to_label_author) : null,
    whale: r.amount_num >= 10000,
  };
}

export const FLOW_SELECT = `
  SELECT f.id, f.chain, f.height, f.ts, f.tx_hash, f.kind, f.from_addr, f.to_addr, f.amount_num, f.counter_denom,
         f.counter_amount, f.pool_id, f.price_usd, f.value_usd, f.meta, l1.label AS from_label, l2.label AS to_label,
         l1.source AS from_label_source, l2.source AS to_label_source, l1.author AS from_label_author, l2.author AS to_label_author
  FROM flows f LEFT JOIN labels l1 ON f.from_addr = l1.address LEFT JOIN labels l2 ON f.to_addr = l2.address`;

/** Provenance for a value read from a timestamp: live within `maxAgeMs`, else stale. */
export function provAt(source: string, at: number | null, now: number, maxAgeMs: number, extra: Partial<Provenance> = {}): Provenance {
  if (at == null) return { source, at: null, status: 'missing', note: extra.note ?? 'no value recorded', ...extra };
  const age = now - at;
  return { source, at, status: age <= maxAgeMs ? 'live' : 'stale', ...(age > maxAgeMs ? { note: `${Math.round(age / 60000)} min old` } : {}), ...extra };
}

/** Latest metric at or before `asOf`. */
export async function metricAt(db: D1Database, key: string, asOf: number): Promise<{ ts: number; value: number } | null> {
  return db.prepare('SELECT ts, value FROM metrics WHERE key = ? AND ts <= ? ORDER BY ts DESC LIMIT 1').bind(key, asOf).first<{ ts: number; value: number }>().catch(() => null);
}

export interface SeriesPoint { ts: number; value: number; lo: number; hi: number; n: number }

/**
 * One point per bucket: the LAST reading in it (`value`, at `ts`, the time of that reading), with the lowest and
 * highest reading in the bucket (`lo`, `hi`) and how many readings it holds (`n`). Never an average: a point
 * labelled with a reading's time carries that reading's value.
 */
export async function metricSeries(db: D1Database, key: string, from: number, to: number, bucketMs = H): Promise<SeriesPoint[]> {
  const r = await db
    .prepare(`SELECT b.ts AS ts, m.value AS value, b.lo AS lo, b.hi AS hi, b.n AS n
              FROM (SELECT MAX(ts) AS ts, MIN(value) AS lo, MAX(value) AS hi, COUNT(*) AS n FROM metrics
                    WHERE key = ? AND ts >= ? AND ts <= ? GROUP BY CAST(ts / ? AS INTEGER)) b
              JOIN metrics m ON m.key = ? AND m.ts = b.ts ORDER BY b.ts`)
    .bind(key, from, to, bucketMs, key)
    .all<SeriesPoint>()
    .catch(() => ({ results: [] as SeriesPoint[] }));
  return r.results || [];
}

export async function flowCoverage(db: D1Database, asOf: number): Promise<{ osmosis: number | null; namada: number | null }> {
  const r = await db
    .prepare(`SELECT (SELECT MAX(ts) FROM flows WHERE chain='osmosis' AND ts <= ?) AS o, (SELECT MAX(ts) FROM flows WHERE chain='namada' AND ts <= ?) AS n`)
    .bind(asOf, asOf)
    .first<{ o: number | null; n: number | null }>()
    .catch(() => null);
  return { osmosis: r?.o ?? null, namada: r?.n ?? null };
}

export const fmtAge = (ms: number) => (ms < 60000 ? 'under a minute ago' : ms < H ? `${Math.round(ms / 60000)} min ago` : ms < D ? `${(ms / H).toFixed(1)} h ago` : `${(ms / D).toFixed(1)} days ago`);

/** Where each chain's flow index is: what the scanners wrote to kv, the node head the cron read, the newest move. */
export interface IndexState {
  lastMove: { osmosis: number | null; namada: number | null };
  /** the LiveHub's Namada block cursor (kv namada.cursor): the last block scanned, and when it was written */
  namadaCursor: { height: number; at: number } | null;
  /** the highest Namada node height from the cron's agreement check, and when it was read */
  namadaHead: { height: number; at: number } | null;
  /** the LiveHub's Osmosis stream (kv osmosis.live), written about every minute while the LiveHub runs */
  osmosisLive: { connected: boolean; since: number | null; lastMsgAt: number | null; height: number | null; at: number } | null;
  /** the last finished catch-up search of Osmosis (kv osmosis.cursor): it looked at the matching transactions up to `height` */
  osmosisSweep: { height: number; at: number } | null;
}

/** A Namada scanner that has not written its cursor for this long, or is this many blocks behind the head, is old. */
export const NAMADA_CURSOR_STALE_MS = 3 * 60000;
export const NAMADA_CURSOR_MAX_LAG = 30;
/** The Osmosis stream reports about every minute; older than this it counts as down. */
export const OSMOSIS_LIVE_STALE_MS = 3 * 60000;
/** An Osmosis index whose stream is down and whose last catch-up search is older than this is old. */
export const OSMOSIS_SWEEP_STALE_MS = 15 * 60000;

export async function indexState(db: D1Database, asOf: number): Promise<IndexState> {
  const r = await db
    .prepare(`SELECT (SELECT MAX(ts) FROM flows WHERE chain='osmosis' AND ts <= ?) AS o, (SELECT MAX(ts) FROM flows WHERE chain='namada' AND ts <= ?) AS n,
                     (SELECT value FROM kv WHERE key='namada.cursor') AS nc, (SELECT updated_at FROM kv WHERE key='namada.cursor') AS nca,
                     (SELECT value FROM kv WHERE key='osmosis.live') AS ol, (SELECT updated_at FROM kv WHERE key='osmosis.live') AS ola,
                     (SELECT value FROM kv WHERE key='osmosis.cursor') AS oc,
                     (SELECT detail FROM checks WHERE key='rpc_consensus') AS rc, (SELECT checked_at FROM checks WHERE key='rpc_consensus') AS rca`)
    .bind(asOf, asOf)
    .first<any>()
    .catch(() => null);
  const ncH = Number(r?.nc);
  const live = safeParseJson(r?.ol, null);
  const sweep = safeParseJson(r?.oc, null);
  const statuses: any[] = safeParseJson(r?.rc, {})?.statuses ?? [];
  const headH = Math.max(0, ...statuses.map((x) => Number(x?.height) || 0));
  return {
    lastMove: { osmosis: r?.o ?? null, namada: r?.n ?? null },
    namadaCursor: Number.isFinite(ncH) && ncH > 0 && r?.nca ? { height: ncH, at: Number(r.nca) } : null,
    namadaHead: headH > 0 && r?.rca ? { height: headH, at: Number(r.rca) } : null,
    osmosisLive: live && r?.ola ? { connected: !!live.connected, since: live.since ?? null, lastMsgAt: live.lastMsgAt ?? null, height: live.height ?? null, at: Number(r.ola) } : null,
    osmosisSweep: sweep && Number(sweep.height) > 0 && Number(sweep.at) > 0 ? { height: Number(sweep.height), at: Number(sweep.at) } : null,
  };
}

const SRC = 'D1 flow index';

/**
 * How current one chain's flow index is. Live mode: measured from the scanner itself, never from the newest
 * move (a quiet chain is not an old index). Namada: the block cursor, old when not written for 3 minutes or
 * more than 30 blocks behind the node head. Osmosis: the stream while it reports, else the last catch-up search,
 * old after 15 minutes. The newest move goes in the note. Rewound: the index as of that time, from the newest move.
 */
export function chainCoverage(st: IndexState, chain: 'osmosis' | 'namada', asOf: number, replay: boolean): Provenance {
  const name = chain === 'osmosis' ? 'Osmosis' : 'Namada';
  const last = st.lastMove[chain];
  const moveNote = last ? `Last ${name} move ${fmtAge(asOf - last)}.` : `No ${name} moves are indexed yet.`;
  if (replay) return last ? { source: SRC, at: last, status: 'live' } : { source: SRC, at: null, status: 'missing', note: 'No moves were indexed before that time.' };
  if (chain === 'namada') {
    const c = st.namadaCursor;
    if (!c) return last ? provAt(SRC, last, asOf, 15 * 60000, { note: `The block scanner has not reported yet. ${moveNote}` }) : { source: SRC, at: null, status: 'missing', note: moveNote };
    const lag = st.namadaHead && st.namadaHead.height > c.height ? st.namadaHead.height - c.height : 0;
    const quiet = asOf - c.at > NAMADA_CURSOR_STALE_MS;
    const behind = lag > NAMADA_CURSOR_MAX_LAG;
    const note = `Scanned to block ${c.height.toLocaleString('en-US')} ${fmtAge(asOf - c.at)}${lag > 0 ? `, ${lag.toLocaleString('en-US')} blocks behind the chain` : ''}. ${moveNote}`;
    return { source: SRC, at: c.at, height: c.height, status: quiet || behind ? 'stale' : 'live', note };
  }
  const l = st.osmosisLive;
  const s = st.osmosisSweep;
  const streaming = !!l && l.connected && asOf - l.at <= OSMOSIS_LIVE_STALE_MS;
  if (streaming) {
    const note = `Listening to Osmosis${s ? `; the catch-up search reached block ${s.height.toLocaleString('en-US')} ${fmtAge(asOf - s.at)}` : ''}. ${moveNote}`;
    return { source: SRC, at: l!.at, height: l!.height ?? s?.height ?? null, status: 'live', note };
  }
  if (s) {
    const note = `The live Osmosis stream is down; the catch-up search reached block ${s.height.toLocaleString('en-US')} ${fmtAge(asOf - s.at)}. ${moveNote}`;
    return { source: SRC, at: s.at, height: s.height, status: asOf - s.at <= OSMOSIS_SWEEP_STALE_MS ? 'live' : 'stale', note };
  }
  // Before the LiveHub reported anything (an older deploy): the newest move is all there is, and the note says so.
  return last ? provAt(SRC, last, asOf, 15 * 60000, { note: `The Osmosis scanner has not reported yet. ${moveNote}` }) : { source: SRC, at: null, status: 'missing', note: moveNote };
}

/** Both chains together (lists that mix them): the older of the two, old if either is. */
export function combinedCoverage(a: Provenance, b: Provenance): Provenance {
  const rank = { live: 0, stale: 1, conflict: 2, missing: 3 } as const;
  const worse = rank[b.status] > rank[a.status] ? b : a;
  const at = a.at != null && b.at != null ? Math.min(a.at, b.at) : null;
  const note = [a.note, b.note].filter(Boolean).join(' ');
  return { source: SRC, at: worse.status === 'missing' ? null : at ?? worse.at, status: worse.status, ...(note ? { note } : {}) };
}

/** Coverage of both chains and of each, from one index read. */
export async function coverageOf(db: D1Database, asOf: number, replay: boolean) {
  const st = await indexState(db, asOf);
  const osmosis = chainCoverage(st, 'osmosis', asOf, replay);
  const namada = chainCoverage(st, 'namada', asOf, replay);
  return { state: st, osmosis, namada, both: combinedCoverage(osmosis, namada) };
}

/** @deprecated kept for callers that only know the newest move per chain (replay-style stamp). */
export function coverageProv(cov: { osmosis: number | null; namada: number | null }, asOf: number, replay: boolean): Provenance {
  const st: IndexState = { lastMove: cov, namadaCursor: null, namadaHead: null, osmosisLive: null, osmosisSweep: null };
  return combinedCoverage(chainCoverage(st, 'osmosis', asOf, replay), chainCoverage(st, 'namada', asOf, replay));
}

// ---------------------------------------------------------------- chain parameters

export type { ChainParams } from '../../shared/types';

/**
 * Measured epoch length (seconds) from the recorded `epoch` metric (one reading a minute): an epoch's length is
 * the time between the first readings of it and of the next one, counted only when the readings around both
 * changes are at most 5 minutes apart (a gap in the readings would make an epoch look longer). The average over
 * the last 30 days' epochs, when at least 3 qualify; else the average since genesis. Never below the chain's
 * minimum. Returns how it was measured, in plain words.
 */
export async function measureEpochSec(db: D1Database, now: number, minEpochSec: number, genesisMs: number | null): Promise<{ sec: number; note: string }> {
  const r = await db
    .prepare(`SELECT value AS e, MIN(ts) AS first, MAX(ts) AS last FROM metrics WHERE key='epoch' AND ts >= ? AND ts <= ? GROUP BY value ORDER BY value`)
    .bind(now - 30 * D, now)
    .all<{ e: number; first: number; last: number }>()
    .catch(() => ({ results: [] as { e: number; first: number; last: number }[] }));
  const rows = r.results || [];
  const TIGHT = 5 * 60000;
  const tightStart = (i: number) => i > 0 && rows[i - 1].e === rows[i].e - 1 && rows[i].first - rows[i - 1].last <= TIGHT;
  const lengths: number[] = [];
  for (let i = 1; i < rows.length - 1; i++) if (tightStart(i) && tightStart(i + 1)) lengths.push((rows[i + 1].first - rows[i].first) / 1000);
  if (lengths.length >= 3) {
    const v = Math.max(minEpochSec, lengths.reduce((a, x) => a + x, 0) / lengths.length);
    return { sec: v, note: `about ${(v / 3600).toFixed(2)} h an epoch, measured over the last ${lengths.length} epochs` };
  }
  const last = await metricAt(db, 'epoch', now);
  if (genesisMs && last && last.value > 0) {
    const v = Math.max(minEpochSec, (last.ts - genesisMs) / 1000 / last.value);
    return { sec: v, note: `about ${(v / 3600).toFixed(2)} h an epoch, the average since the chain started (${Math.round(last.value)} epochs)` };
  }
  return { sec: minEpochSec, note: `the shortest an epoch can be (${(minEpochSec / 3600).toFixed(0)} h); epochs are often longer` };
}

/** Epochs after an unbond request until it can be withdrawn: pipeline + unbonding + slashing window (56 on mainnet). */
export const withdrawEpochs = (p: ChainParams): number => p.pipelineLength + p.unbondingLength + (p.cubicSlashingWindowLength ?? 0);

/**
 * Chain parameters from the indexer, cached 6 h in kv `chain.params`, with the measured epoch length. For the
 * cron only: request paths read the cache (`cachedChainParams`) and never wait on the indexer.
 */
export async function chainParams(db: D1Database, signal?: AbortSignal): Promise<ChainParams | null> {
  const cached = await kvGetJson<any>(db, 'chain.params');
  if (cached && cached.apr !== undefined && cached.epochSec !== undefined && Date.now() - cached.fetchedAt < 6 * H) return cached;
  try {
    const p = await fetchJson<any>(`${INDEXER}/chain/parameters`, { timeoutMs: 8000, retries: 1, signal });
    const apr = Number(p.apr);
    const cubic = Number(p.cubicSlashingWindowLength);
    const minEpochSec = Number(p.minDuration);
    const genesisTime = Number(p.genesisTime) > 0 ? Number(p.genesisTime) * 1000 : null;
    const ep = await measureEpochSec(db, Date.now(), minEpochSec, genesisTime);
    const v: ChainParams = {
      unbondingLength: Number(p.unbondingLength), pipelineLength: Number(p.pipelineLength),
      cubicSlashingWindowLength: Number.isFinite(cubic) && cubic >= 0 ? cubic : null,
      minEpochSec, epochSec: ep.sec, epochSecNote: ep.note, genesisTime,
      apr: Number.isFinite(apr) && apr > 0 ? apr : null, fetchedAt: Date.now(),
    };
    await kvSet(db, 'chain.params', v).catch(() => {});
    return v;
  } catch {
    return cached ?? null;
  }
}

/** The cached chain parameters as they are (any age; their `fetchedAt` says when they were read). No fetch. */
export async function cachedChainParams(db: D1Database): Promise<ChainParams | null> {
  const v = await kvGetJson<ChainParams>(db, 'chain.params').catch(() => null);
  return v && Number.isFinite(v.unbondingLength) && Number.isFinite(v.pipelineLength) && Number(v.minEpochSec) > 0 ? v : null;
}

/** kv `unbond.withdraw`: indexer.namada.net's pending unbonds of the addresses in the unlock list (cron, 10 min). */
export interface UnbondWithdrawCache {
  at: number;
  byAddress: Record<string, { validator: string; amountNam: number; withdrawEpoch: number; withdrawTime: number }[]>;
}

/** The addresses whose unbonds the unlock list shows, for the cron to look up (same window and size as pressure()). */
export async function unbondAddresses(db: D1Database, now: number): Promise<string[]> {
  const r = await db.prepare(`SELECT DISTINCT to_addr a FROM flows WHERE chain='namada' AND kind='unbond' AND amount_num >= ? AND ts >= ? AND to_addr IS NOT NULL LIMIT 60`)
    .bind(UNLOCKS_MIN_NAM, now - UNLOCKS_WINDOW_DAYS * D).all<{ a: string }>().catch(() => ({ results: [] as { a: string }[] }));
  return (r.results || []).map((x) => x.a);
}

/** One address's pending unbonds from the indexer (NAM amounts, withdraw time in ms). */
export async function fetchUnbonds(address: string, signal?: AbortSignal): Promise<UnbondWithdrawCache['byAddress'][string]> {
  const r = await fetchJson<any>(`${INDEXER}/pos/unbond/${address}`, { timeoutMs: 6000, retries: 0, signal });
  return (r?.results ?? []).map((u: any) => ({
    validator: String(u?.validator?.address ?? ''), amountNam: Number(u?.minDenomAmount ?? 0) / 1e6,
    withdrawEpoch: Number(u?.withdrawEpoch ?? 0), withdrawTime: Number(u?.withdrawTime ?? 0) * 1000,
  })).filter((u: any) => u.amountNam > 0 && u.withdrawTime > 0);
}

/** The unstaking wait from the parameters: epochs, the epoch length used (s), and days. */
export function unbondingWait(p: ChainParams | null): { epochs: number; epochSec: number; days: number } | null {
  if (!p || !(p.minEpochSec > 0)) return null;
  const epochs = withdrawEpochs(p);
  const epochSec = Math.max(p.minEpochSec, p.epochSec ?? p.minEpochSec);
  return { epochs, epochSec, days: (epochs * epochSec) / 86400 };
}

// ---------------------------------------------------------------- bridge timeouts

export interface IbcRow { id: string; ts: number; from: string | null; to: string | null; amount: number; seq: string | null; receiverKnown?: boolean }

export function ibcRowOf(r: any): IbcRow {
  const m = typeof r.meta === 'string' ? safeParseJson(r.meta, {}) : r.meta ?? {};
  return { id: r.id, ts: r.ts, from: r.from_addr ?? null, to: r.to_addr ?? null, amount: r.amount_num, seq: m?.packetSequence != null ? String(m.packetSequence) : null, receiverKnown: !!m?.refundReceiver };
}

/**
 * The Osmosis → Namada sends that timed out and were refunded on Osmosis (their NAM never left), as a set of
 * ibc_out ids. Matched by packet sequence; rows written before sequences were stored match a refund of the same
 * amount within 3 days after the send (and the same sender when the refund names its receiver). Each refund
 * cancels one send.
 */
export function timedOutSends(outs: IbcRow[], refunds: IbcRow[]): Set<string> {
  const done = new Set<string>();
  const used = new Set<string>();
  const bySeq = new Map<string, IbcRow>();
  for (const o of outs) if (o.seq) bySeq.set(o.seq, o);
  for (const r of refunds) {
    const o = r.seq ? bySeq.get(r.seq) : undefined;
    if (o && !done.has(o.id)) { done.add(o.id); used.add(r.id); }
  }
  const sorted = [...outs].sort((a, b) => b.ts - a.ts);
  for (const r of [...refunds].sort((a, b) => a.ts - b.ts)) {
    if (used.has(r.id)) continue;
    const o = sorted.find((x) => !done.has(x.id) && !(x.seq && r.seq) && Math.abs(x.amount - r.amount) < 1e-6 && x.ts <= r.ts && r.ts - x.ts <= 3 * D && (!r.receiverKnown || r.to === x.from));
    if (o) { done.add(o.id); used.add(r.id); }
  }
  return done;
}

/** Osmosis bridge-out rows and refunds in [from, to), with the timed-out sends removed. */
async function osmosisSendsOut(db: D1Database, from: number, to: number): Promise<{ outs: IbcRow[]; refunded: number }> {
  const [outs, refunds] = await Promise.all([
    db.prepare(`SELECT id, ts, from_addr, to_addr, amount_num, meta FROM flows WHERE chain='osmosis' AND kind='ibc_out' AND ts >= ? AND ts < ?`).bind(from, to).all<any>(),
    // A refund always follows its send, so the refunds of the window's sends are inside the window too (as of `to`).
    db.prepare(`SELECT id, ts, from_addr, to_addr, amount_num, meta FROM flows WHERE chain='osmosis' AND kind='other' AND ts >= ? AND ts < ? AND meta LIKE '%"ibcTimeoutRefund":true%'`).bind(from, to).all<any>(),
  ]);
  const o = (outs.results || []).map(ibcRowOf);
  const r = (refunds.results || []).map(ibcRowOf);
  const gone = timedOutSends(o, r);
  return { outs: o.filter((x) => !gone.has(x.id)), refunded: o.filter((x) => gone.has(x.id)).reduce((a, x) => a + x.amount, 0) };
}

/** NAM bridged onto Osmosis minus NAM really bridged off it (refunded sends left out) in [from, to), bots excluded. */
// A failed read rejects (the caller reports null, never a 0 that looks like a quiet day).
export async function osmosisNetIbc(db: D1Database, from: number, to: number): Promise<number> {
  const [inRow, out] = await Promise.all([
    db.prepare(`SELECT SUM(amount_num) s FROM flows WHERE chain='osmosis' AND kind='ibc_in' AND ts >= ? AND ts < ?`).bind(from, to).first<{ s: number | null }>(),
    osmosisSendsOut(db, from, to),
  ]);
  return (inRow?.s ?? 0) - out.outs.reduce((a, x) => a + x.amount, 0);
}

/**
 * Share follow-up moves out over an address's withdrawals in time order: each withdrawal takes, from the moves
 * inside its window and not yet taken, at most its own amount. Returns the amount per kind for each withdrawal.
 */
export function allocateFollowUps<K extends string>(
  withdrawals: { key: string; ts: number; amount: number }[],
  moves: { kind: K; ts: number; amount: number; windowMs: number }[],
): Map<string, Record<K, number>> {
  const out = new Map<string, Record<K, number>>();
  const left = moves.map((m) => ({ ...m, left: m.amount })).sort((a, b) => a.ts - b.ts);
  for (const w of [...withdrawals].sort((a, b) => a.ts - b.ts)) {
    const got = {} as Record<K, number>;
    let cap = w.amount;
    for (const m of left) {
      if (cap <= 0) break;
      if (m.left <= 0 || m.ts < w.ts || m.ts >= w.ts + m.windowMs) continue;
      const take = Math.min(m.left, cap);
      m.left -= take;
      cap -= take;
      got[m.kind] = (got[m.kind] ?? 0) + take;
    }
    out.set(w.key, got);
  }
  return out;
}

// ---------------------------------------------------------------- pressure (D2, D3, D4)

export async function pressure(db: D1Database, asOf: number, replay: boolean, windowDays = 7): Promise<Pressure> {
  const from = asOf - windowDays * D;

  const [ibcIn, ibcInAll, sells, sendsOut, unlockRows, bondedTrend, swapRows, cov, params, intel] = await Promise.all([
    db.prepare(`SELECT f.to_addr AS addr, SUM(f.amount_num) AS nam, MIN(f.ts) AS first_ts, MAX(f.ts) AS last_ts, l.label, l.source AS label_source, l.author AS label_author
                FROM flows f LEFT JOIN labels l ON l.address = f.to_addr
                WHERE f.chain='osmosis' AND f.kind='ibc_in' AND f.ts >= ? AND f.ts < ? AND f.to_addr IS NOT NULL
                GROUP BY f.to_addr ORDER BY nam DESC LIMIT 40`).bind(from, asOf).all<any>(),
    db.prepare(`SELECT SUM(amount_num) s FROM flows WHERE chain='osmosis' AND kind='ibc_in' AND ts >= ? AND ts < ?`).bind(from, asOf).first<{ s: number | null }>().catch(() => null),
    db.prepare(`SELECT from_addr AS addr, ts, amount_num FROM flows WHERE chain='osmosis' AND kind='sell' AND ts >= ? AND ts < ?
                AND (meta IS NULL OR meta NOT LIKE '%"arb":true%')`).bind(from - 30 * D, asOf).all<any>(),
    osmosisSendsOut(db, from, asOf),
    db.prepare(`${FLOW_SELECT} WHERE f.chain='namada' AND f.kind IN ('withdraw','bond','unbond') AND f.amount_num >= ? AND f.ts >= ? AND f.ts < ? AND ${NOT_LEGACY_TWIN}
                ORDER BY f.ts DESC LIMIT 60`).bind(UNLOCKS_MIN_NAM, asOf - UNLOCKS_WINDOW_DAYS * D, asOf).all<any>(),
    // The chain's own total stake (not the staking account's balance, which also holds NAM on its way out).
    metricSeries(db, 'supply.total_stake', asOf - 14 * D, asOf, 6 * H),
    db.prepare(`SELECT kind, from_addr, to_addr, ts, amount_num FROM flows WHERE chain='osmosis' AND kind IN ('buy','sell') AND ts >= ? AND ts < ?
                AND (meta IS NULL OR meta NOT LIKE '%"arb":true%')`).bind(from, asOf).all<any>(),
    coverageOf(db, asOf, replay),
    // Request path: the cached parameters only (the cron refreshes them), so a slow indexer never holds this answer.
    cachedChainParams(db),
    kvGetJson<IntelResponse>(db, 'intel.cache'),
  ]);
  const withdrawTimes = await kvGetJson<UnbondWithdrawCache>(db, 'unbond.withdraw').catch(() => null);

  // D2: inventory on deck
  const sellsByAddr = new Map<string, { ts: number; nam: number }[]>();
  for (const s of sells.results || []) (sellsByAddr.get(s.addr) ?? sellsByAddr.set(s.addr, []).get(s.addr)!).push({ ts: s.ts, nam: s.amount_num });
  const outByAddr = new Map<string, { ts: number; nam: number }[]>();
  for (const o of sendsOut.outs) if (o.from) (outByAddr.get(o.from) ?? outByAddr.set(o.from, []).get(o.from)!).push({ ts: o.ts, nam: o.amount });

  const receivers = (ibcIn.results || []).map((r: any) => r.addr as string);
  const links = receivers.length
    ? await db.prepare(`SELECT l.osmo_addr, l.namada_addr, lb.label, lb.source, lb.author FROM address_links l LEFT JOIN labels lb ON lb.address = l.namada_addr
                        WHERE l.osmo_addr IN (${receivers.map(() => '?').join(',')}) ORDER BY l.volume_num DESC`).bind(...receivers).all<any>()
    : { results: [] as any[] };
  const linkOf = new Map<string, { addr: string; label: string | null; source: string | null; author: string | null }>();
  for (const l of links.results || []) if (!linkOf.has(l.osmo_addr)) linkOf.set(l.osmo_addr, { addr: l.namada_addr, label: l.label ?? INTERNAL_LABELS[l.namada_addr]?.label ?? null, source: l.label ? l.source ?? null : INTERNAL_LABELS[l.namada_addr] ? 'auto' : null, author: l.author ?? null });

  const onDeck: OnDeckEntry[] = (ibcIn.results || [])
    .filter((r: any) => !isInternal(r.addr))
    .map((r: any) => {
      const soldSince = (sellsByAddr.get(r.addr) ?? []).filter((s) => s.ts >= r.first_ts).reduce((a, s) => a + s.nam, 0);
      const priorSells30d = (sellsByAddr.get(r.addr) ?? []).filter((s) => s.ts < from).reduce((a, s) => a + s.nam, 0);
      const bridgedOutSince = (outByAddr.get(r.addr) ?? []).filter((s) => s.ts >= r.first_ts).reduce((a, s) => a + s.nam, 0);
      // Counted against what crossed: sales first, then sends back, each at most what is left.
      const soldCounted = Math.min(soldSince, r.nam);
      const sentBackCounted = Math.min(bridgedOutSince, r.nam - soldCounted);
      const link = linkOf.get(r.addr);
      return {
        address: r.addr, label: r.label ?? INTERNAL_LABELS[r.addr]?.label ?? null, labelPlain: label_plain(r.label ?? INTERNAL_LABELS[r.addr]?.label ?? null, r.addr, r.label_source),
        labelSource: r.label ? r.label_source ?? null : INTERNAL_LABELS[r.addr] ? 'auto' : null, labelAuthor: r.label ? labelAuthorShort(r.label_source, r.label_author) : null,
        linkedNamada: link?.addr ?? null, linkedLabel: link?.label ?? null, linkedLabelPlain: link ? label_plain(link.label, link.addr, link.source) : null,
        linkedLabelSource: link?.label ? link.source : null, linkedLabelAuthor: link?.label ? labelAuthorShort(link.source, link.author) : null,
        bridgedIn: r.nam, soldSince, bridgedOutSince, remaining: Math.max(0, r.nam - soldCounted - sentBackCounted),
        soldCounted, sentBackCounted,
        priorSells30d, firstArrival: r.first_ts, lastSeen: r.last_ts,
      };
    })
    .sort((a: OnDeckEntry, b: OnDeckEntry) => b.remaining - a.remaining);

  // Market-wide: every receiver (not only the 40 listed), and every send back that really left (refunds out).
  const ibcIn7d = ibcInAll?.s ?? 0;
  const ibcOut7d = sendsOut.outs.reduce((a, x) => a + x.amount, 0);
  const onDeckTotals = {
    bridgedIn: onDeck.reduce((a, e) => a + e.bridgedIn, 0),
    sold: onDeck.reduce((a, e) => a + (e.soldCounted ?? 0), 0),
    sentBack: onDeck.reduce((a, e) => a + (e.sentBackCounted ?? 0), 0),
    remaining: onDeck.reduce((a, e) => a + e.remaining, 0),
  };

  // D3: unlocks of at least UNLOCKS_MIN_NAM over the last UNLOCKS_WINDOW_DAYS days. unbond = request (liquid after the unbonding period); withdraw = completed; bond = overhang removed.
  const wait = unbondingWait(params);
  // Every unstaking request still in its wait, of any size (the list keeps only UNLOCKS_MIN_NAM and up), so Supply
  // never shows 0 NAM unstaking while smaller requests wait: the requests made within the wait before asOf (the
  // request time + the wait, an estimate that can run up to one epoch long). No wait known, or a failed count: null, never 0.
  const countUnbonding = async (from: number) => {
    const r = await db.prepare(`SELECT COUNT(*) AS n, SUM(f.amount_num) AS s FROM flows f WHERE f.chain='namada' AND f.kind='unbond' AND f.ts >= ? AND f.ts < ? AND ${NOT_LEGACY_TWIN}`)
      .bind(from, asOf).first<{ n: number; s: number | null }>();
    return { nam: r?.s ?? 0, n: r?.n ?? 0, from };
  };
  const unbondingAll = wait ? await countUnbonding(asOf - wait.epochs * wait.epochSec * 1000).catch(() => null) : null;
  const unlocks: UnlockEntry[] = (unlockRows.results || []).map((r: any) => {
    const f = rowToFlow(r);
    const user = f.kind === 'bond' ? f.from : f.to;
    const label = (f.kind === 'bond' ? f.fromLabel : f.toLabel) ?? null;
    const src = f.kind === 'bond' ? f.fromLabelSource : f.toLabelSource;
    const author = f.kind === 'bond' ? f.fromLabelAuthor : f.toLabelAuthor;
    // The indexer's own withdraw time for this unbond (address, validator, amount) when it lists it; else ts + the wait.
    const listed = f.kind === 'unbond' && user ? withdrawTimes?.byAddress?.[user]?.find((u) => Math.abs(u.amountNam - f.amount) < 1e-6 && (!f.meta?.validator || u.validator === f.meta.validator)) : undefined;
    const liquidAt = f.kind !== 'unbond' ? null : listed ? listed.withdrawTime : wait ? f.ts + wait.epochs * wait.epochSec * 1000 : null;
    return {
      address: user ?? '', label, labelPlain: label_plain(label, user, src), labelSource: label ? src ?? null : null, labelAuthor: label ? author ?? null : null, kind: f.kind as UnlockEntry['kind'],
      amountNam: f.amount, ts: f.ts, txHash: f.txHash, explorerHash: f.explorerHash,
      liquidAt, liquidAtSource: liquidAt == null ? null : listed ? 'indexer' : 'estimate',
      outcome: null,
    };
  });
  // What did each withdrawer do with the NAM next? A re-bond is a validator move, not a sale. One address's later
  // moves are shared out over its withdrawals (oldest first, each capped at its own amount), never counted twice.
  const withdraws = unlocks.filter((u) => u.kind === 'withdraw' && u.address);
  if (withdraws.length) {
    const addrs = [...new Set(withdraws.map((w) => w.address))];
    const after = await db.prepare(`SELECT from_addr, to_addr, kind, ts, amount_num FROM flows WHERE chain='namada' AND kind IN ('bond','ibc_out','shield') AND from_addr IN (${addrs.map(() => '?').join(',')}) AND ts >= ? AND ts < ?`)
      .bind(...addrs, Math.min(...withdraws.map((w) => w.ts)), Math.min(asOf, Math.max(...withdraws.map((w) => w.ts)) + 48 * H)).all<any>().catch(() => ({ results: [] as any[] }));
    const osmoLinks = await db.prepare(`SELECT osmo_addr, namada_addr FROM address_links WHERE namada_addr IN (${addrs.map(() => '?').join(',')})`).bind(...addrs).all<any>().catch(() => ({ results: [] as any[] }));
    const osmoOf = new Map((osmoLinks.results || []).map((l: any) => [l.namada_addr, l.osmo_addr]));
    const sold = osmoOf.size
      ? await db.prepare(`SELECT from_addr, ts, amount_num FROM flows WHERE chain='osmosis' AND kind='sell' AND from_addr IN (${[...osmoOf.values()].map(() => '?').join(',')}) AND ts >= ? AND ts < ?`)
          .bind(...osmoOf.values(), Math.min(...withdraws.map((w) => w.ts)), asOf).all<any>().catch(() => ({ results: [] as any[] }))
      : { results: [] as any[] };
    type K = 'rebonded' | 'bridged_out' | 'shielded' | 'sold';
    const KIND: Record<string, K> = { bond: 'rebonded', ibc_out: 'bridged_out', shield: 'shielded' };
    for (const addr of addrs) {
      const mine = withdraws.filter((w) => w.address === addr);
      const moves = [
        ...(after.results || []).filter((r: any) => r.from_addr === addr && KIND[r.kind]).map((r: any) => ({ kind: KIND[r.kind], ts: r.ts, amount: r.amount_num, windowMs: 48 * H })),
        ...(sold.results || []).filter((r: any) => osmoOf.has(addr) && r.from_addr === osmoOf.get(addr)).map((r: any) => ({ kind: 'sold' as K, ts: r.ts, amount: r.amount_num, windowMs: 7 * D })),
      ];
      const alloc = allocateFollowUps<K>(mine.map((w, i) => ({ key: `${w.txHash}:${i}`, ts: w.ts, amount: w.amountNam })), moves);
      mine.forEach((w, i) => {
        const got = alloc.get(`${w.txHash}:${i}`) ?? ({} as Record<K, number>);
        const best = (['rebonded', 'bridged_out', 'sold', 'shielded'] as K[]).map((k) => [k, got[k] ?? 0] as const).sort((a, b) => b[1] - a[1])[0];
        w.outcome = asOf - w.ts < 48 * H && best[1] === 0 ? null : best[1] > 0 ? { kind: best[0], amountNam: best[1] } : { kind: 'liquid', amountNam: w.amountNam };
      });
    }
  }

  // D4: movers (DEX only; arbitrage excluded)
  const mv = new Map<string, MoverEntry>();
  for (const s of swapRows.results || []) {
    const addr = s.kind === 'buy' ? s.to_addr : s.from_addr;
    if (!addr) continue;
    const m = mv.get(addr) ?? { address: addr, label: null, labelPlain: null, chain: 'osmosis' as const, netNam24h: 0, netNam7d: 0, buys: 0, sells: 0, lastTs: 0 };
    const signed = s.kind === 'buy' ? s.amount_num : -s.amount_num;
    m.netNam7d += signed;
    if (s.ts >= asOf - D) m.netNam24h += signed;
    if (s.kind === 'buy') m.buys++; else m.sells++;
    m.lastTs = Math.max(m.lastTs, s.ts);
    mv.set(addr, m);
  }
  const movers = [...mv.values()].sort((a, b) => Math.abs(b.netNam7d) - Math.abs(a.netNam7d)).slice(0, 20);
  if (movers.length) {
    const lbl = await db.prepare(`SELECT address, label, source, author FROM labels WHERE address IN (${movers.map(() => '?').join(',')})`).bind(...movers.map((m) => m.address)).all<any>();
    const byAddr = new Map((lbl.results || []).map((l: any) => [l.address, l]));
    for (const m of movers) {
      const l = byAddr.get(m.address);
      m.label = l?.label ?? INTERNAL_LABELS[m.address]?.label ?? null;
      m.labelPlain = label_plain(m.label, m.address, l?.source);
      m.labelSource = l?.label ? l.source ?? null : INTERNAL_LABELS[m.address] ? 'auto' : null;
      m.labelAuthor = l?.label ? labelAuthorShort(l.source, l.author) : null;
    }
  }

  const proposals: GovernanceProposal[] = (intel?.proposals ?? []).filter((p) => /voting|pending/i.test(p.status)).slice(0, 8)
    .map((p) => ({ ...p, discussionsUrl: safeHttpUrl(p.discussionsUrl) }));
  const now = Date.now();
  // Chain parameters and proposals are current readings (no history), also under Rewind: their stamps say when they were read.
  const current = replay ? { note: 'A current reading, not as of the rewound time.' } : {};
  const waitNote = wait && params
    ? `${wait.epochs} epochs (${params.pipelineLength} pipeline, ${params.unbondingLength} unbonding${params.cubicSlashingWindowLength ? `, ${params.cubicSlashingWindowLength} slashing window` : ''}) of ${params.epochSecNote ?? `at least ${(params.minEpochSec / 3600).toFixed(0)} h`}.`
    : undefined;
  const unbondingProv: Provenance = params?.fetchedAt
    ? provAt('Namada chain parameters', params.fetchedAt, now, 12 * H, { ...(waitNote ? { note: replay ? `${waitNote} ${current.note}` : waitNote } : current) })
    : { source: 'Namada chain parameters', at: null, status: 'missing', note: 'The chain parameters could not be read.' };
  const proposalsProv: Provenance = intel?.fetchedAt
    ? provAt('Namada governance (indexer)', intel.fetchedAt, now, 6 * H, current)
    : { source: 'Namada governance (indexer)', at: null, status: 'missing', note: 'Votes have not been read yet.' };

  return {
    asOf, windowDays, onDeck, onDeckTotal: onDeckTotals.remaining, onDeckTotals, ibcIn7d, ibcOut7d, ibcRefunded7d: sendsOut.refunded,
    unlocks, unlocksWindowDays: UNLOCKS_WINDOW_DAYS, unlocksMinNam: UNLOCKS_MIN_NAM, unbondingAll,
    unbondingDays: wait ? wait.days : null, unbondingEpochs: wait?.epochs ?? null, epochHours: wait ? wait.epochSec / 3600 : null,
    unbondingProv, chainParams: params,
    bondedTrend: bondedTrend.map((p) => ({ ts: p.ts, value: p.value })), movers, proposals, proposalsProv,
    coverage: cov.both,
    coverageByChain: { osmosis: cov.osmosis, namada: cov.namada },
  };
}

// ---------------------------------------------------------------- blind spot (D5)

const MASP = INTERNAL_ADDRESSES.masp;
const ESCROW = INTERNAL_ADDRESSES.ibc;
const PAIR_MS = 15 * 60000;

interface PoolLeg { ts: number; amount: number; dir: 'in' | 'out'; bridge: boolean; from: string | null; to: string | null }

/**
 * Every NAM leg into or out of the shielded pool, once. Namada records: shield / unshield, and bridge crossings
 * straight into or out of the pool (escrow → pool, pool → escrow, recorded as ibc_in / ibc_out, or as shield /
 * unshield by older parser builds). Osmosis records of crossings to or from the pool are added when Namada has
 * no record of the same crossing (same amount within 15 minutes, and the same Osmosis address when Namada
 * knows it), so a crossing the Namada scanner missed still counts. Refunded sends are left out.
 */
export function maspLegs(namada: any[], osmosisOut: IbcRow[], osmosisIn: any[]): PoolLeg[] {
  const legs: PoolLeg[] = [];
  for (const r of namada) {
    const toPool = r.to_addr === MASP, fromPool = r.from_addr === MASP;
    if (!toPool && !fromPool) continue;
    const other = toPool ? r.from_addr : r.to_addr;
    const bridge = r.kind === 'ibc_in' || r.kind === 'ibc_out' || other === ESCROW || (typeof other === 'string' && other.startsWith('osmo1'));
    legs.push({ ts: r.ts, amount: r.amount_num, dir: toPool ? 'in' : 'out', bridge, from: r.from_addr, to: r.to_addr });
  }
  const used = new Set<PoolLeg>();
  const pairs = (l: PoolLeg, dir: 'in' | 'out', osmoAddr: string | null, amount: number, ts: number) =>
    !used.has(l) && l.bridge && l.dir === dir && Math.abs(l.amount - amount) < 1e-6 && Math.abs(l.ts - ts) <= PAIR_MS &&
    (() => { const known = dir === 'in' ? l.from : l.to; return !known || known === ESCROW || !known.startsWith('osmo1') || known === osmoAddr; })();
  const extra: PoolLeg[] = [];
  for (const o of osmosisOut) {
    if (o.to !== MASP) continue;
    const twin = legs.find((l) => pairs(l, 'in', o.from, o.amount, o.ts));
    if (twin) used.add(twin);
    else extra.push({ ts: o.ts, amount: o.amount, dir: 'in', bridge: true, from: o.from, to: MASP });
  }
  for (const r of osmosisIn) {
    if (r.from_addr !== MASP) continue;
    const twin = legs.find((l) => pairs(l, 'out', r.to_addr, r.amount_num, r.ts));
    if (twin) used.add(twin);
    else extra.push({ ts: r.ts, amount: r.amount_num, dir: 'out', bridge: true, from: MASP, to: r.to_addr });
  }
  return [...legs, ...extra];
}

export async function blindSpot(db: D1Database, asOf: number, replay: boolean): Promise<BlindSpot> {
  const from7 = asOf - 7 * D;
  const [shielded, total, trendRecent, trendDaily, namadaLegs, osmoOut, osmoIn, unshieldRows, cov] = await Promise.all([
    metricAt(db, 'supply.masp_shielded', asOf),
    metricAt(db, 'supply.total', asOf),
    metricSeries(db, 'supply.masp_shielded', asOf - 7 * D, asOf, 6 * H),
    db.prepare(`SELECT ts, value FROM metrics WHERE key='supply.masp_shielded.daily' AND ts <= ? ORDER BY ts`).bind(asOf).all<{ ts: number; value: number }>().catch(() => ({ results: [] as any[] })),
    // NAM only (shielding another coin is not NAM), each transfer once (older twin rows left out).
    db.prepare(`SELECT f.kind, f.ts, f.from_addr, f.to_addr, f.amount_num FROM flows f WHERE f.chain='namada' AND f.ts >= ? AND f.ts < ?
                AND f.kind IN ('shield','unshield','ibc_in','ibc_out') AND (f.to_addr = ? OR f.from_addr = ?) AND ${NAM_AMOUNT} AND ${NOT_LEGACY_TWIN}`)
      .bind(from7, asOf, MASP, MASP).all<any>().catch(() => ({ results: [] as any[] })),
    osmosisSendsOut(db, from7 - PAIR_MS, asOf).catch(() => ({ outs: [] as IbcRow[], refunded: 0 })),
    db.prepare(`SELECT ts, from_addr, to_addr, amount_num FROM flows WHERE chain='osmosis' AND kind='ibc_in' AND from_addr = ? AND ts >= ? AND ts < ?`)
      .bind(MASP, from7 - PAIR_MS, asOf).all<any>().catch(() => ({ results: [] as any[] })),
    // The largest moves out of the pool to an address: unshields and crossings straight out over the bridge.
    db.prepare(`${FLOW_SELECT} WHERE f.chain='namada' AND f.ts >= ? AND f.ts < ? AND f.from_addr = ?
                AND (f.kind = 'unshield' OR (f.kind = 'ibc_out' AND f.to_addr LIKE 'osmo1%'))
                AND f.to_addr NOT IN (?,?,?,?) AND ${NAM_AMOUNT} AND ${NOT_LEGACY_TWIN}
                ORDER BY f.amount_num DESC LIMIT 25`).bind(asOf - 30 * D, asOf, MASP, INTERNAL_ADDRESSES.pos, INTERNAL_ADDRESSES.ibc, INTERNAL_ADDRESSES.pgf, INTERNAL_ADDRESSES.governance).all<any>(),
    coverageOf(db, asOf, replay),
  ]);

  const legs = maspLegs(namadaLegs.results || [], osmoOut.outs, osmoIn.results || []).filter((l) => l.ts >= from7 && l.ts < asOf);
  const sum = (since: number, dir: 'in' | 'out', bridge?: boolean) => legs.filter((l) => l.ts >= since && l.dir === dir && (bridge == null || l.bridge === bridge)).reduce((a, l) => a + l.amount, 0);
  const d1 = asOf - D;
  const bridgeLegs = legs.filter((l) => l.bridge);

  const daily = (trendDaily.results || []).filter((d: any) => !trendRecent.length || d.ts < trendRecent[0].ts);
  const trend = [...daily, ...trendRecent.map((p) => ({ ts: p.ts, value: p.value }))];
  const shieldedS: Sourced<number> = { value: shielded?.value ?? null, prov: replay ? (shielded ? { source: 'Namada RPC (MASP balance)', at: shielded.ts, status: 'live' } : { source: 'Namada RPC (MASP balance)', at: null, status: 'missing', note: 'Not recorded at that time.' }) : provAt('Namada RPC (MASP balance)', shielded?.ts ?? null, asOf, 10 * 60000) };

  const bridgeIn7d = sum(from7, 'in', true), bridgeOut7d = sum(from7, 'out', true);
  return {
    asOf,
    shielded: shieldedS,
    total: total?.value ?? null,
    sharePct: shielded && total && total.value > 0 ? (shielded.value / total.value) * 100 : null,
    trend,
    shields24h: sum(d1, 'in'), unshields24h: sum(d1, 'out'), shields7d: sum(from7, 'in'), unshields7d: sum(from7, 'out'),
    bridgeIn24h: sum(d1, 'in', true), bridgeOut24h: sum(d1, 'out', true), bridgeIn7d, bridgeOut7d,
    lastBridgeAt: bridgeLegs.length ? Math.max(...bridgeLegs.map((l) => l.ts)) : null,
    ibcShielded7d: bridgeIn7d + bridgeOut7d,
    unshields: (unshieldRows.results || []).map(rowToFlow),
    // The pool's figures come from Namada records (and Osmosis records of crossings): both indexes matter.
    coverage: cov.both,
    coverageByChain: { osmosis: cov.osmosis, namada: cov.namada },
  };
}

// ---------------------------------------------------------------- alerts (D7)

export async function alertsBetween(db: D1Database, from: number, to: number, th: AlertThresholds): Promise<AlertHit[]> {
  const minAmt = Math.min(th.ibcInventory, th.unlock, th.bigSwap, th.unshield, th.bond);
  const rows = await db
    .prepare(`${FLOW_SELECT} WHERE f.ts >= ? AND f.ts < ? AND f.amount_num >= ? AND f.kind IN ('ibc_in','withdraw','unbond','buy','sell','unshield','bond') AND ${NOT_LEGACY_TWIN} ORDER BY f.ts DESC LIMIT 500`)
    .bind(from, to, minAmt)
    .all<any>();
  return evaluateFlows((rows.results || []).map(rowToFlow), th);
}

/**
 * The most recent alert hit before `to`, of any age (W5), for the "nothing crossed an alert size" state.
 * The SQL narrows to flows each rule could fire on (its chain, kinds and size); the shared rules then decide,
 * exactly as for live alerts. Pages back newest first: null only when the search reached the oldest record and
 * found none; undefined when it gave up after `pages` full pages (not known, so never "none on record").
 */
export async function lastAlertBefore(db: D1Database, to: number, th: AlertThresholds, pages = 5, pageSize = 100): Promise<AlertHit | null | undefined> {
  const cond = `((f.chain='osmosis' AND f.kind='ibc_in' AND f.amount_num >= ?)
    OR (f.chain='namada' AND f.kind IN ('withdraw','unbond') AND f.amount_num >= ?)
    OR (f.chain='osmosis' AND f.kind IN ('buy','sell') AND f.amount_num >= ?)
    OR (f.chain='namada' AND f.kind='unshield' AND f.amount_num >= ?)
    OR (f.chain='namada' AND f.kind='bond' AND f.amount_num >= ?))`;
  for (let p = 0; p < pages; p++) {
    const rows = await db
      .prepare(`${FLOW_SELECT} WHERE f.ts < ? AND ${cond} AND ${NOT_LEGACY_TWIN} ORDER BY f.ts DESC, f.height DESC LIMIT ? OFFSET ?`)
      .bind(to, th.ibcInventory, th.unlock, th.bigSwap, th.unshield, th.bond, pageSize, p * pageSize)
      .all<any>();
    const list = rows.results || [];
    const hits = evaluateFlows(list.map(rowToFlow), th);
    if (hits.length) return hits[0];
    if (list.length < pageSize) return null;
  }
  return undefined;
}
