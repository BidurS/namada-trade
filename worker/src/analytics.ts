// Decision-level queries over D1 (see docs/decisions.md). Every function takes `asOf` so the same
// code serves the live UI and replay mode.
import type {
  AlertHit, BlindSpot, ChainParams, Flow, GovernanceProposal, IntelResponse, MaspPassthroughLink, MaspPulseBucket, MoverEntry, OnDeckEntry,
  OrderflowBucket, OrderflowResponse, Pressure, Provenance, Sourced, SupplyCohortBreakdown, UnbondMaturityBucket, UnbondTermStructure, UnlockEntry,
} from '../../shared/types';
import type { BondListing } from './sources/namada';
import { evaluateFlows, INTERNAL_ADDRESSES, isInternal, type AlertThresholds } from '../../shared/alerts';
import { QUOTE_KEYS, quotesNeeded, settleMetaOf, settleOf, type Settle } from '../../shared/settle';
import { SELLS_MOST_CUT } from '../../shared/supply-thresholds';
import { kvGetJson, kvSet } from './db';
import { NAM_AMOUNT, NOT_LEGACY_TWIN } from './flows-query';
import { safeHttpUrl, explorerHashOf, isOtherCoin } from '../../shared/flow-rules';
import { fetchJson } from './util';
import { INTERNAL_LABELS } from './config';
import { label_plain, labelAuthorShort } from './labels';
import { chunks } from './holders';

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
    // 10,000 NAM, as the live alerts' isNamWhale: a row in another coin (meta.tokenSymbol) is in that coin's units.
    whale: r.amount_num >= 10000 && !isOtherCoin({ meta }),
  };
}

/**
 * The flow rows with both sides' labels. `hint` (an `INDEXED BY` clause) goes on `flows f`: without table statistics
 * SQLite's planner takes the equality index flows_chain_height for any `chain = ?` and walks every row of that chain
 * (52,463 Namada rows on 2026-10-20) where a time or kind range would read a few hundred.
 */
export const flowSelect = (hint = '') => `
  SELECT f.id, f.chain, f.height, f.ts, f.tx_hash, f.kind, f.from_addr, f.to_addr, f.amount_num, f.counter_denom,
         f.counter_amount, f.pool_id, f.price_usd, f.value_usd, f.meta, l1.label AS from_label, l2.label AS to_label,
         l1.source AS from_label_source, l2.source AS to_label_source, l1.author AS from_label_author, l2.author AS to_label_author
  FROM flows f${hint ? ` ${hint}` : ''} LEFT JOIN labels l1 ON f.from_addr = l1.address LEFT JOIN labels l2 ON f.to_addr = l2.address`;
export const FLOW_SELECT = flowSelect();

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

/** A history point; `n` is absent when the bucket holds a rolled-up hour (a rollup keeps no count of its readings). */
export type HistoryPoint = Omit<SeriesPoint, 'n'> & { n?: number };
/** One key's rows in [?2, ?3) in index order: `SEARCH metrics USING INDEX sqlite_autoindex_metrics_1 (key=? AND ts>? AND ts<?)`, rows read = rows returned. */
export const METRIC_RANGE_SQL = 'SELECT key, ts, value FROM metrics WHERE key = ?1 AND ts >= ?2 AND ts < ?3 ORDER BY ts';
/** The same over a key's three hourly rollup keys (series.ts rollupStmts). */
export const ROLLUP_RANGE_SQL = 'SELECT key, ts, value FROM metrics WHERE key IN (?1, ?2, ?3) AND ts >= ?4 AND ts < ?5 ORDER BY key, ts';

/**
 * metricSeries for a minute key with hourly rollups (series-sql.ts ROLLUP_KEYS) at a bucket of an hour or more:
 * every complete hour of [from, to] from its rollup rows (`<key>.1h` the hour's last reading, `.1h.lo`, `.1h.hi`,
 * labelled with the hour's start, as /api/series labels them), and from the minute readings only the partial hour at
 * each end and the two hours before the last, which the hourly job may not have rolled yet (an hour with a rollup
 * row is read from it). Rows read: at most 3 per hour of the window plus 240 minute rows, whatever the key's age;
 * metricSeries reads every minute row of the window (21,131 rows for price.usd since 15 Oct on 2026-10-22).
 */
export async function metricSeriesRolled(db: D1Database, key: string, from: number, to: number, bucketMs: number): Promise<HistoryPoint[]> {
  const hs = Math.ceil(from / H) * H; // the first complete hour
  const he = Math.floor((to + 1) / H) * H; // the end of the last complete hour
  const tail = Math.max(hs, he - 2 * H);
  type Row = { key: string; ts: number; value: number };
  const range = (sql: string, ...p: unknown[]) => db.prepare(sql).bind(...p).all<Row>().then((r) => r.results || [], () => [] as Row[]);
  const [rolled, head, minutes] = await Promise.all([
    hs < he ? range(ROLLUP_RANGE_SQL, `${key}.1h`, `${key}.1h.lo`, `${key}.1h.hi`, hs, he) : Promise.resolve([] as Row[]),
    from < hs ? range(METRIC_RANGE_SQL, key, from, Math.min(hs, to + 1)) : Promise.resolve([] as Row[]),
    range(METRIC_RANGE_SQL, key, tail, to + 1),
  ]);
  const hours = new Map<number, HistoryPoint>();
  for (const r of rolled) {
    if (r.key !== `${key}.1h`) continue;
    const v = Number(r.value);
    hours.set(Number(r.ts), { ts: Number(r.ts), value: v, lo: v, hi: v });
  }
  for (const r of rolled) {
    const p = hours.get(Number(r.ts));
    if (!p || r.key === `${key}.1h`) continue;
    if (r.key === `${key}.1h.lo`) p.lo = Math.min(p.lo, Number(r.value));
    else p.hi = Math.max(p.hi, Number(r.value));
  }
  const rolledHours = new Set(hours.keys());
  for (const r of [...head, ...minutes]) {
    const ts = Number(r.ts), v = Number(r.value), h = Math.floor(ts / H) * H;
    if (rolledHours.has(h)) continue;
    const p = hours.get(h);
    if (!p) hours.set(h, { ts, value: v, lo: v, hi: v, n: 1 });
    else { p.ts = ts; p.value = v; p.lo = Math.min(p.lo, v); p.hi = Math.max(p.hi, v); p.n = (p.n ?? 0) + 1; }
  }
  const out = new Map<number, HistoryPoint>();
  for (const h of [...hours.keys()].sort((a, b) => a - b)) {
    const p = hours.get(h)!, b = Math.floor(h / bucketMs), q = out.get(b);
    if (!q) { out.set(b, { ...p }); continue; }
    q.ts = p.ts; q.value = p.value; q.lo = Math.min(q.lo, p.lo); q.hi = Math.max(q.hi, p.hi);
    if (q.n != null && p.n != null) q.n += p.n; else delete q.n;
  }
  return [...out.values()];
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

/**
 * The newest move of each chain at or before `asOf` walks flows_ts down from `asOf` and stops at the first row of
 * that chain (3 rows read on 2026-10-20); `MAX(ts) … WHERE chain = ?` walked every row of the chain on
 * flows_chain_height (55,228 rows, on every overview, pressure and page render).
 */
const LAST_MOVE_SQL = (chain: 'osmosis' | 'namada') => `(SELECT ts FROM flows INDEXED BY flows_ts WHERE ts <= ? AND chain = '${chain}' ORDER BY ts DESC LIMIT 1)`;

export async function indexState(db: D1Database, asOf: number): Promise<IndexState> {
  const r = await db
    .prepare(`SELECT ${LAST_MOVE_SQL('osmosis')} AS o, ${LAST_MOVE_SQL('namada')} AS n,
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

/** The term structure is rewritten when a bond listing completes (every BOND_LISTING_MS, cron.ts); older than three intervals it is stale. */
export const UNBOND_TERM_STALE_MS = 3 * 40 * 60_000;
/**
 * The withdraw times are rewritten when a bond listing completes, or from the indexer at the next 10-minute mark
 * when no listing has completed in three intervals or the listing's write of them did not land (cron.ts). Older than
 * that they are not used: the unlock list shows its labelled estimates instead.
 */
export const UNBOND_WITHDRAW_STALE_MS = UNBOND_TERM_STALE_MS + 10 * 60_000;
/** A burner's upstream origin counts only from transfers in this window before its NAM first arrived on Osmosis ... */
export const HOP_ORIGIN_WINDOW_MS = 48 * 3600_000;
/** ... that add up to at least this many NAM and this share of what crossed. */
export const HOP_ORIGIN_MIN_NAM = 1_000;
export const HOP_ORIGIN_SHARE = 0.1;

/**
 * kv `unbond.withdraw`: the unbonds the unlock list can look up, by address (consensus bond listing or indexer
 * fallback). From the bond listing that is every unbond of at least UNLOCKS_MIN_NAM on the chain, pending or
 * withdrawable: the list shows only requests of that size and matches them by amount, so a smaller unbond is never
 * read. The map is one kv row, and D1 keeps at most 2,000,000 bytes a row: with every unbond in it, it held 6,043
 * entries in 1.04 MB on 2026-10-22, and unbonds of a base unit, which cost only their fees, could fill it. Kept to the
 * list's floor it has at most one entry per 100,000 NAM unbonding (37 million NAM that day: 75 entries, 12 KB).
 */
export interface UnbondWithdrawCache {
  at: number;
  /**
   * who wrote the map: 'consensus' (runBondListing, from the chain's bond listing) or 'indexer' (the cron's fallback,
   * fetchUnbonds); absent on maps written before 2026-10-23, whose entries say it (unbondWithdrawWriter)
   */
  source?: 'consensus' | 'indexer';
  byAddress: Record<string, { validator: string; amountNam: number; withdrawEpoch: number; withdrawTime: number | null; source?: 'consensus' | 'indexer' }[]>;
}

/**
 * Who wrote a stored withdraw map: its `source`, or on a map without one what its entries say (every entry from the
 * bond listing carries 'consensus'; the indexer's carry none); null when that cannot be told (an empty map, or both).
 */
export function unbondWithdrawWriter(m: UnbondWithdrawCache | null | undefined): 'consensus' | 'indexer' | null {
  if (!m) return null;
  if (m.source === 'consensus' || m.source === 'indexer') return m.source;
  const entries = Object.values(m.byAddress ?? {}).flat();
  if (!entries.length) return null;
  if (entries.every((e) => e?.source === 'consensus')) return 'consensus';
  return entries.every((e) => e?.source == null || e.source === 'indexer') ? 'indexer' : null;
}
/**
 * The source named on the withdraw times' stamp (unbondWithdrawProv), by who wrote the map: the names of the Sources
 * rows that say whether each wrote it (cron.ts runBondListing and the indexer fallback).
 */
export const UNBOND_WITHDRAW_SOURCE = {
  consensus: 'Namada RPC (unbond withdraw times)',
  indexer: 'Namada indexer (unbond withdraw times)',
  unknown: 'Namada RPC (bond listing), or the Namada indexer while no listing completes',
} as const;

/**
 * Build the consensus-verified forward unlock term structure and per-address withdraw cache directly from the
 * decoded `/vp/pos/bonds_and_unbonds/to` listing. Distinguishes unbonds that have already passed `withdrawEpoch`
 * (`withdrawableNowNam`, liquid on demand) from unbonds still in the unbonding pipeline (`inFlightNam`).
 */
export function buildUnbondTermStructure(
  listing: BondListing,
  height: number,
  currentEpoch: number,
  at: number,
  epochSec: number | null,
  epochSecSource: string | null = null,
): { termStructure: UnbondTermStructure; withdrawCache: UnbondWithdrawCache } {
  // The withdraw epoch is the chain's; the clock time is epochs × the measured epoch length. Without a measured
  // length there is no time (never a stand-in figure): the entry carries the epoch and a null time.
  const sec = epochSec && epochSec > 0 ? epochSec : null;
  let withdrawableNowBase = 0n;
  let inFlightBase = 0n;
  const bucketMap = new Map<number, { amountBase: bigint; count: number }>();
  const byAddress: UnbondWithdrawCache['byAddress'] = {};
  // The smallest unbond an unlock row can match (pressure(): the row's amount within 1e-6 NAM), one base unit under the floor.
  const cacheMinBase = BigInt(UNLOCKS_MIN_NAM) * 1_000_000n - 1n;

  for (const [address, src] of listing.sources) {
    if (!src.unbonds || src.unbonds.length === 0) continue;
    const addrList: UnbondWithdrawCache['byAddress'][string] = [];
    for (const u of src.unbonds) {
      if (u.amountBase <= 0n) continue;
      const withdrawableNow = u.withdrawEpoch <= currentEpoch;
      if (withdrawableNow) withdrawableNowBase += u.amountBase;
      else inFlightBase += u.amountBase;

      const b = bucketMap.get(u.withdrawEpoch) ?? { amountBase: 0n, count: 0 };
      b.amountBase += u.amountBase;
      b.count++;
      bucketMap.set(u.withdrawEpoch, b);

      // The term structure above counts every unbond; the withdraw cache keeps only those the unlock list can show.
      if (u.amountBase < cacheMinBase) continue;
      const epochsRemaining = Math.max(0, u.withdrawEpoch - currentEpoch);
      const withdrawTime = epochsRemaining === 0 ? at : sec ? at + epochsRemaining * sec * 1000 : null;
      addrList.push({
        validator: u.validator,
        amountNam: u.amountNam,
        withdrawEpoch: u.withdrawEpoch,
        withdrawTime,
        source: 'consensus',
      });
    }
    if (addrList.length > 0) byAddress[address] = addrList;
  }

  const buckets: UnbondMaturityBucket[] = [...bucketMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([withdrawEpoch, b]) => {
      const withdrawableNow = withdrawEpoch <= currentEpoch;
      const epochsRemaining = Math.max(0, withdrawEpoch - currentEpoch);
      return {
        withdrawEpoch,
        estimatedAt: epochsRemaining === 0 ? at : sec ? at + epochsRemaining * sec * 1000 : null,
        withdrawableNow,
        amountNam: Number(b.amountBase) / 1e6,
        count: b.count,
      };
    });

  const withdrawableNowNam = Number(withdrawableNowBase) / 1e6;
  const inFlightNam = Number(inFlightBase) / 1e6;
  return {
    termStructure: {
      at,
      height,
      currentEpoch,
      epochSec: sec,
      epochSecSource: sec ? epochSecSource : null,
      withdrawableNowNam,
      inFlightNam,
      totalUnbondingNam: withdrawableNowNam + inFlightNam,
      buckets,
    },
    withdrawCache: { at, source: 'consensus', byAddress },
  };
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
  // A refund that carries a sequence and matched none can only be an older send's that has none, so it looks
  // through those alone: every send stored now carries one, and the rows are as many as chain users make.
  const unsequenced = sorted.filter((x) => !x.seq);
  for (const r of [...refunds].sort((a, b) => a.ts - b.ts)) {
    if (used.has(r.id)) continue;
    const o = (r.seq ? unsequenced : sorted).find((x) => !done.has(x.id) && Math.abs(x.amount - r.amount) < 1e-6 && x.ts <= r.ts && r.ts - x.ts <= 3 * D && (!r.receiverKnown || r.to === x.from));
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
 * inside its window and not yet taken, at most its own amount. A move made with NAM that first had to cross to
 * another account (a sale on Osmosis) names those crossings in `via`: it is then also held to the NAM that crossed
 * at or after the withdrawal and at or before the move, each crossing backing at most its own amount. A sale made
 * before any NAM crossed, or larger than what crossed, cannot all have been the withdrawn NAM.
 * Returns the amount per kind for each withdrawal.
 */
export function allocateFollowUps<K extends string>(
  withdrawals: { key: string; ts: number; amount: number }[],
  moves: { kind: K; ts: number; amount: number; windowMs: number; via?: string }[],
  crossings: Map<string, { ts: number; amount: number }[]> = new Map(),
): Map<string, Record<K, number>> {
  const out = new Map<string, Record<K, number>>();
  const left = moves.map((m) => ({ ...m, left: m.amount })).sort((a, b) => a.ts - b.ts);
  const backing = new Map([...crossings].map(([k, list]) => [k, list.map((c) => ({ ts: c.ts, left: c.amount })).sort((a, b) => a.ts - b.ts)]));
  for (const w of [...withdrawals].sort((a, b) => a.ts - b.ts)) {
    const got = {} as Record<K, number>;
    let cap = w.amount;
    for (const m of left) {
      if (cap <= 0) break;
      if (m.left <= 0 || m.ts < w.ts || m.ts >= w.ts + m.windowMs) continue;
      let take = Math.min(m.left, cap);
      if (m.via !== undefined) {
        // the earliest crossings first: one made before a later withdrawal can back none of that withdrawal's moves
        const cs = (backing.get(m.via) ?? []).filter((c) => c.left > 0 && c.ts >= w.ts && c.ts <= m.ts);
        take = Math.min(take, cs.reduce((a, c) => a + c.left, 0));
        let need = take;
        for (const c of cs) {
          if (need <= 0) break;
          const used = Math.min(c.left, need);
          c.left -= used;
          need -= used;
        }
        if (take <= 0) continue;
      }
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
  const trendSpanDays = Math.max(14, windowDays);
  const trendBucketMs = trendSpanDays > 90 ? D : 6 * H;

  const [ibcIn, ibcInAll, sells, sendsOut, unlockRows, bondedTrend, swapRows, cov, params, intel] = await Promise.all([
    db.prepare(`SELECT f.to_addr AS addr, SUM(f.amount_num) AS nam, MIN(f.ts) AS first_ts, MAX(f.ts) AS last_ts, l.label, l.source AS label_source, l.author AS label_author
                FROM flows f LEFT JOIN labels l ON l.address = f.to_addr
                WHERE f.chain='osmosis' AND f.kind='ibc_in' AND f.ts >= ? AND f.ts < ? AND f.to_addr IS NOT NULL
                GROUP BY f.to_addr ORDER BY nam DESC LIMIT 40`).bind(from, asOf).all<any>(),
    db.prepare(`SELECT SUM(amount_num) s FROM flows WHERE chain='osmosis' AND kind='ibc_in' AND ts >= ? AND ts < ?`).bind(from, asOf).first<{ s: number | null }>().catch(() => null),
    db.prepare(`SELECT from_addr AS addr, ts, amount_num FROM flows WHERE chain='osmosis' AND kind='sell' AND ts >= ? AND ts < ?
                AND (meta IS NULL OR meta NOT LIKE '%"arb":true%')`).bind(from - 30 * D, asOf).all<any>(),
    osmosisSendsOut(db, from, asOf),
    // The three kinds' ranges on flows_kind (332 rows read on 2026-10-20 against 52,627 on flows_chain_height).
    db.prepare(`${flowSelect('INDEXED BY flows_kind')} WHERE f.chain='namada' AND f.kind IN ('withdraw','bond','unbond') AND f.amount_num >= ? AND f.ts >= ? AND f.ts < ? AND ${NOT_LEGACY_TWIN}
                ORDER BY f.ts DESC LIMIT 60`).bind(UNLOCKS_MIN_NAM, asOf - Math.max(UNLOCKS_WINDOW_DAYS, windowDays) * D, asOf).all<any>(),
    // The chain's own total stake (not the staking account's balance, which also holds NAM on its way out).
    metricSeries(db, 'supply.total_stake', asOf - trendSpanDays * D, asOf, trendBucketMs),
    db.prepare(`SELECT kind, from_addr, to_addr, ts, amount_num FROM flows WHERE chain='osmosis' AND kind IN ('buy','sell') AND ts >= ? AND ts < ?
                AND (meta IS NULL OR meta NOT LIKE '%"arb":true%')`).bind(from, asOf).all<any>(),
    coverageOf(db, asOf, replay),
    // Request path: the cached parameters only (the cron refreshes them), so a slow indexer never holds this answer.
    cachedChainParams(db),
    kvGetJson<IntelResponse>(db, 'intel.cache'),
  ]);
  const [withdrawTimes, termStored] = await Promise.all([
    kvGetJson<UnbondWithdrawCache>(db, 'unbond.withdraw').catch(() => null),
    kvGetJson<UnbondTermStructure>(db, 'unbond.term_structure').catch(() => null),
  ]);
  // The term structure is rewritten only when a bond listing completes; like every other figure it is stamped by
  // its age (stale past UNBOND_TERM_STALE_MS, missing when there is none or it was written after `asOf`).
  const unbondTermStructure = termStored && termStored.at <= asOf ? termStored : null;
  const unbondTermStructureProv = provAt('Namada RPC (bond listing: every unbond on the chain)', unbondTermStructure?.at ?? null, asOf, UNBOND_TERM_STALE_MS,
    unbondTermStructure ? { height: unbondTermStructure.height } : { note: termStored ? 'The bond listing had not been read at this moment.' : 'The bond listing has not been read yet.' });
  // The withdraw times are used only while current. A map that was not rewritten (no listing completed, or its write
  // failed) keeps unbonds since withdrawn, whose ends of the wait would be shown for a later request of the same
  // address, validator and amount, and lacks the new ones; past UNBOND_WITHDRAW_STALE_MS, or written after `asOf`,
  // every unbond row takes the labelled estimate, and the stamp says how old the map is.
  const withdrawAt = withdrawTimes && Number.isFinite(withdrawTimes.at) && withdrawTimes.at <= asOf ? withdrawTimes.at : null;
  // The stamp names who wrote the map: the chain's bond listing, or the indexer while no listing completes.
  const unbondWithdrawProv = provAt(UNBOND_WITHDRAW_SOURCE[(withdrawAt == null ? null : unbondWithdrawWriter(withdrawTimes)) ?? 'unknown'], withdrawAt, asOf, UNBOND_WITHDRAW_STALE_MS,
    withdrawAt == null ? { note: withdrawTimes ? 'The withdraw times had not been read at this moment.' : 'The withdraw times have not been read yet.' } : {});
  const withdrawLive = unbondWithdrawProv.status === 'live' ? withdrawTimes : null;

  // D2: inventory on deck
  const sellsByAddr = new Map<string, { ts: number; nam: number }[]>();
  for (const s of sells.results || []) (sellsByAddr.get(s.addr) ?? sellsByAddr.set(s.addr, []).get(s.addr)!).push({ ts: s.ts, nam: s.amount_num });
  const outByAddr = new Map<string, { ts: number; nam: number }[]>();
  for (const o of sendsOut.outs) if (o.from) (outByAddr.get(o.from) ?? outByAddr.set(o.from, []).get(o.from)!).push({ ts: o.ts, nam: o.amount });

  const receivers = (ibcIn.results || []).map((r: any) => r.addr as string);
  // A receiver's Namada origin is the tnam1 address that sent it the NAM it got in the window: the sender of its
  // own crossings as Osmosis recorded them (an Osmosis ibc_in row: from_addr the Namada sender, to_addr this
  // receiver), the largest first. Not address_links: that table keeps one row per (osmo1, tnam1) pair for both
  // directions, so an Osmosis account that sent NAM to a Namada wallet of its choosing (a genesis wallet, say)
  // would be shown as coming from that wallet, and its NAM counted in that wallet's cohort.
  const links = receivers.length
    ? await db.prepare(`SELECT f.to_addr AS osmo_addr, f.from_addr AS namada_addr, SUM(f.amount_num) AS nam, MIN(f.ts) AS first_ts, lb.label, lb.source, lb.author
                        FROM flows f INDEXED BY flows_to LEFT JOIN labels lb ON lb.address = f.from_addr
                        WHERE f.to_addr IN (${receivers.map(() => '?').join(',')}) AND f.ts >= ? AND f.ts < ? AND f.chain='osmosis' AND f.kind='ibc_in' AND f.from_addr LIKE 'tnam1%'
                        GROUP BY f.to_addr, f.from_addr ORDER BY nam DESC, first_ts ASC, namada_addr ASC`).bind(...receivers, from, asOf).all<any>()
    : { results: [] as any[] };
  // Every Namada sender of each receiver with the NAM it sent it in the window and its own first crossing, the
  // largest first: the first is the receiver's shown origin (linkedNamada), and each sender's NAM goes to that
  // sender's own cohort (below), so NAM a receiver also got from others is not counted as its largest sender's.
  type Sender = { addr: string; nam: number; firstTs: number; label: string | null; source: string | null; author: string | null };
  const sendersOf = new Map<string, Sender[]>();
  for (const l of links.results || []) {
    const s: Sender = { addr: l.namada_addr, nam: Number(l.nam) || 0, firstTs: Number(l.first_ts), label: l.label ?? INTERNAL_LABELS[l.namada_addr]?.label ?? null, source: l.label ? l.source ?? null : INTERNAL_LABELS[l.namada_addr] ? 'auto' : null, author: l.author ?? null };
    (sendersOf.get(l.osmo_addr) ?? sendersOf.set(l.osmo_addr, []).get(l.osmo_addr)!).push(s);
  }
  const linkOf = new Map([...sendersOf].map(([osmo, list]) => [osmo, list[0]] as const));

  /**
   * The Osmosis account each address in `sinceOf` sent NAM to from its own `since` on (the one it sent the most),
   * with those crossings, from Osmosis's own records of them (from_addr the Namada sender). Not address_links, which
   * keeps both directions in one row: an Osmosis account that sent NAM to a withdrawer is not where the withdrawer's
   * NAM went, and its sales are not the withdrawer's. Nor a crossing made before the address's own `since` (its first
   * listed withdrawal, or the first transfer a burner got after its sender's): it cannot have carried withdrawn NAM,
   * whatever another address withdrew earlier. The read starts at the earliest `since` (each address's range on
   * flows_from stays a few rows) and each address's own is applied to its rows. Accounts in `skip` are passed over.
   */
  const sentToOsmosis = async (sinceOf: Map<string, number>, skip: Set<string> = new Set()) => {
    const out = new Map<string, { osmo: string; crossings: { ts: number; amount: number }[] }>();
    if (!sinceOf.size) return out;
    const namadaAddrs = [...sinceOf.keys()];
    const r = await db.prepare(`SELECT from_addr AS namada_addr, to_addr AS osmo_addr, ts, amount_num FROM flows INDEXED BY flows_from
                                WHERE from_addr IN (${namadaAddrs.map(() => '?').join(',')}) AND ts >= ? AND ts < ? AND chain='osmosis' AND kind='ibc_in' AND to_addr LIKE 'osmo1%'`)
      .bind(...namadaAddrs, Math.min(...sinceOf.values()), asOf).all<any>().catch(() => ({ results: [] as any[] }));
    const pairs = new Map<string, { namada: string; osmo: string; nam: number; first: number; crossings: { ts: number; amount: number }[] }>();
    for (const c of r.results || []) {
      if (!(c.ts >= (sinceOf.get(c.namada_addr) ?? Infinity)) || skip.has(c.osmo_addr)) continue;
      const k = `${c.namada_addr} ${c.osmo_addr}`;
      const p = pairs.get(k) ?? pairs.set(k, { namada: c.namada_addr, osmo: c.osmo_addr, nam: 0, first: c.ts, crossings: [] }).get(k)!;
      p.nam += c.amount_num;
      p.first = Math.min(p.first, c.ts);
      p.crossings.push({ ts: c.ts, amount: c.amount_num });
    }
    // the most NAM, then the earliest first crossing, then the account (the order the grouped read used)
    const ranked = [...pairs.values()].sort((a, b) => b.nam - a.nam || a.first - b.first || (a.osmo < b.osmo ? -1 : a.osmo > b.osmo ? 1 : 0));
    for (const p of ranked) if (!out.has(p.namada)) out.set(p.namada, { osmo: p.osmo, crossings: p.crossings });
    return out;
  };

  // 2-hop burner attribution for unlabeled Namada senders: an unlabeled tnam1 bridge sender that received Namada
  // transfers in the 48 h before its own NAM first arrived on the receiver names the upstream origin, when those
  // transfers are a meaningful part of what it sent across (HOP_ORIGIN_SHARE of it, and at least
  // HOP_ORIGIN_MIN_NAM): a dust transfer eight days earlier is neither. Every sender is read, not only the largest,
  // since each sender's NAM goes to its own cohort; the list is split to fit D1's bound parameters.
  // A tag a signed-in wallet wrote names nothing here (series.ts sideCategory): its address is read as untagged.
  const unlabeled = [...sendersOf.values()].flat().filter((s) => (!s.label || s.source === 'user') && !isInternal(s.addr));
  const unlabeledSenders = [...new Set(unlabeled.map((s) => s.addr))];
  const hopRowsByBurner = new Map<string, { origin: string; nam: number; ts: number; label: string | null; source: string | null }[]>();
  if (unlabeledSenders.length) {
    const firsts = unlabeled.map((s) => s.firstTs).filter((t) => Number.isFinite(t));
    const lo = (firsts.length ? Math.min(...firsts) : from) - HOP_ORIGIN_WINDOW_MS;
    const hi = firsts.length ? Math.max(...firsts) : asOf;
    const hopParts = await Promise.all(chunks(unlabeledSenders, 3).map((part) => db.prepare(
      `SELECT f.to_addr AS burner, f.from_addr AS origin, f.amount_num AS nam, f.ts, l.label, l.source
       FROM flows f LEFT JOIN labels l ON l.address = f.from_addr
       WHERE f.chain='namada' AND f.kind='transfer' AND f.to_addr IN (${part.map(() => '?').join(',')})
         AND f.from_addr IS NOT NULL AND f.amount_num >= ? AND f.ts >= ? AND f.ts < ? AND ${NOT_LEGACY_TWIN}
       ORDER BY f.amount_num DESC LIMIT 500`,
    ).bind(...part, HOP_ORIGIN_MIN_NAM, lo, hi).all<any>().catch(() => ({ results: [] as any[] }))));
    for (const hr of hopParts.flatMap((r) => r.results || [])) {
      if (!hr.burner || !hr.origin || isInternal(hr.origin)) continue;
      (hopRowsByBurner.get(hr.burner) ?? hopRowsByBurner.set(hr.burner, []).get(hr.burner)!).push({ origin: hr.origin, nam: hr.nam, ts: hr.ts, label: hr.label ?? null, source: hr.source ?? null });
    }
  }
  /** The largest origin of the burner's transfers in the 48 h before `firstTs`, when it sent at least the floor and HOP_ORIGIN_SHARE of `bridgedIn` (what the burner sent the receiver). */
  const hopOriginOf = (burner: string, firstTs: number, bridgedIn: number) => {
    const rows = hopRowsByBurner.get(burner);
    if (!rows) return null;
    const byOrigin = new Map<string, { nam: number; label: string | null; source: string | null }>();
    for (const r of rows) {
      if (r.ts < firstTs - HOP_ORIGIN_WINDOW_MS || r.ts >= firstTs) continue;
      const o = byOrigin.get(r.origin) ?? byOrigin.set(r.origin, { nam: 0, label: r.label, source: r.source }).get(r.origin)!;
      o.nam += r.nam;
    }
    let best: { address: string; nam: number; label: string | null; source: string | null } | null = null;
    for (const [address, o] of byOrigin) if (!best || o.nam > best.nam) best = { address, ...o };
    if (!best || best.nam < Math.max(HOP_ORIGIN_MIN_NAM, bridgedIn * HOP_ORIGIN_SHARE)) return null;
    const lbl = best.label ?? INTERNAL_LABELS[best.address]?.label ?? null;
    return { address: best.address, label: lbl, labelPlain: label_plain(lbl, best.address, best.source), labelSource: best.label ? best.source : null };
  };

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
      // read against the shown sender's own first crossing and NAM, as its share of the cohorts is
      const hopOriginNamada = link?.addr ? hopOriginOf(link.addr, link.firstTs, link.nam) : null;
      // Empirical Bayesian Beta-Binomial dump hazard score in [0, 1]
      const empiricalPropensity = (soldCounted + priorSells30d + 5_000) / (r.nam + priorSells30d + 25_000);
      const hazardBoost = (soldCounted > 0 ? 0.25 : 0) + (priorSells30d > 0 ? 0.15 : 0) + (hopOriginNamada ? 0.1 : 0);
      const dumpHazardScore = Number(Math.min(0.99, empiricalPropensity * 0.7 + hazardBoost).toFixed(3));
      return {
        address: r.addr, label: r.label ?? INTERNAL_LABELS[r.addr]?.label ?? null, labelPlain: label_plain(r.label ?? INTERNAL_LABELS[r.addr]?.label ?? null, r.addr, r.label_source),
        labelSource: r.label ? r.label_source ?? null : INTERNAL_LABELS[r.addr] ? 'auto' : null, labelAuthor: r.label ? labelAuthorShort(r.label_source, r.label_author) : null,
        linkedNamada: link?.addr ?? null, linkedLabel: link?.label ?? null, linkedLabelPlain: link ? label_plain(link.label, link.addr, link.source) : null,
        linkedLabelSource: link?.label ? link.source : null, linkedLabelAuthor: link?.label ? labelAuthorShort(link.source, link.author) : null,
        bridgedIn: r.nam, soldSince, bridgedOutSince, remaining: Math.max(0, r.nam - soldCounted - sentBackCounted),
        soldCounted, sentBackCounted,
        priorSells30d, firstArrival: r.first_ts, lastSeen: r.last_ts,
        ...(hopOriginNamada ? { hopOriginNamada } : {}),
        dumpHazardScore,
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
    // Consensus bond listing or indexer withdraw time for this unbond (address, validator, amount) when listed; else ts + the wait.
    const listed = f.kind === 'unbond' && user ? withdrawLive?.byAddress?.[user]?.find((u) => Math.abs(u.amountNam - f.amount) < 1e-6 && (!f.meta?.validator || u.validator === f.meta.validator)) : undefined;
    // A listed unbond whose time could not be computed (the chain's epoch length was not read when the listing was
    // applied) stays without a time: the epoch is known, the clock time is not, and nothing stands in for it.
    const liquidAt = f.kind !== 'unbond' ? null : listed ? listed.withdrawTime : wait ? f.ts + wait.epochs * wait.epochSec * 1000 : null;
    const liquidAtNote = f.kind === 'unbond' && listed && listed.withdrawTime == null
      ? `Withdrawable from epoch ${listed.withdrawEpoch.toLocaleString('en-US')} (the chain's bond listing); the time is not known because the epoch length could not be read.`
      : undefined;
    return {
      address: user ?? '', label, labelPlain: label_plain(label, user, src), labelSource: label ? src ?? null : null, labelAuthor: label ? author ?? null : null, kind: f.kind as UnlockEntry['kind'],
      amountNam: f.amount, ts: f.ts, txHash: f.txHash, explorerHash: f.explorerHash,
      liquidAt, liquidAtSource: liquidAt == null ? null : listed ? (listed.source ?? 'indexer') : 'estimate',
      ...(liquidAtNote ? { liquidAtNote } : {}),
      outcome: null,
    };
  });
  // What did each withdrawer do with the NAM next? A re-bond is a validator move, not a sale. One address's later
  // moves (including 2-hop burner transfers) are shared out over its withdrawals (oldest first, each capped at its own amount), never counted twice.
  // A sale on Osmosis counts only up to the NAM the withdrawer (or its burner) sent the selling account between the
  // withdrawal and the sale.
  const withdraws = unlocks.filter((u) => u.kind === 'withdraw' && u.address);
  if (withdraws.length) {
    const addrs = [...new Set(withdraws.map((w) => w.address))];
    const minW = Math.min(...withdraws.map((w) => w.ts));
    // each address's own first listed withdrawal: its crossings before that cannot have carried withdrawn NAM
    const firstW = new Map<string, number>();
    for (const w of withdraws) firstW.set(w.address, Math.min(firstW.get(w.address) ?? Infinity, w.ts));
    const maxFollow = Math.min(asOf, Math.max(...withdraws.map((w) => w.ts)) + 48 * H);
    const [after, hopTransfers, osmoOf] = await Promise.all([
      // Each address's range on flows_from (a few dozen rows; 52,463 on flows_chain_height on 2026-10-20).
      db.prepare(`SELECT from_addr, to_addr, kind, ts, amount_num FROM flows INDEXED BY flows_from WHERE chain='namada' AND kind IN ('bond','ibc_out','shield') AND from_addr IN (${addrs.map(() => '?').join(',')}) AND ts >= ? AND ts < ?`)
        .bind(...addrs, minW, maxFollow).all<any>().catch(() => ({ results: [] as any[] })),
      db.prepare(`SELECT f.from_addr, f.to_addr, f.ts, f.amount_num FROM flows f WHERE f.chain='namada' AND f.kind='transfer' AND f.from_addr IN (${addrs.map(() => '?').join(',')}) AND f.to_addr IS NOT NULL AND f.ts >= ? AND f.ts < ? AND ${NOT_LEGACY_TWIN}`)
        .bind(...addrs, minW, maxFollow).all<any>().catch(() => ({ results: [] as any[] })),
      sentToOsmosis(firstW),
    ]);
    const sellers = [...new Set([...osmoOf.values()].map((o) => o.osmo))];
    const sold = sellers.length
      ? await db.prepare(`SELECT from_addr, ts, amount_num FROM flows WHERE chain='osmosis' AND kind='sell' AND from_addr IN (${sellers.map(() => '?').join(',')}) AND ts >= ? AND ts < ?`)
          .bind(...sellers, minW, asOf).all<any>().catch(() => ({ results: [] as any[] }))
      : { results: [] as any[] };

    type K = 'rebonded' | 'bridged_out' | 'shielded' | 'sold';
    const KIND: Record<string, K> = { bond: 'rebonded', ibc_out: 'bridged_out', shield: 'shielded' };

    // 2-hop burner follow-up attribution: if a withdrawer transferred NAM to a burner address `to_addr`, query the burner's follow-up actions.
    const hopMovesByOrigin = new Map<string, { kind: K; ts: number; amount: number; windowMs: number }[]>();
    const burners = [...new Set((hopTransfers.results || []).map((r: any) => r.to_addr as string).filter((a) => a && !isInternal(a) && !addrs.includes(a)))].slice(0, 40);
    if (burners.length) {
      // A burner's crossings count from the first transfer it got from a withdrawer after that withdrawer's own
      // first withdrawal; a burner that got none after one has no Osmosis account here.
      const burnerSince = new Map<string, number>();
      for (const t of hopTransfers.results || []) {
        if (!burners.includes(t.to_addr) || !(t.ts >= (firstW.get(t.from_addr) ?? Infinity))) continue;
        burnerSince.set(t.to_addr, Math.min(burnerSince.get(t.to_addr) ?? Infinity, t.ts));
      }
      // An Osmosis account a withdrawer and its burner both sent NAM to is one seller: its sales are attributed
      // through the withdrawer's own crossing, never again through the burner's.
      const [burnerAfter, burnerOsmo] = await Promise.all([
        db.prepare(`SELECT from_addr, kind, ts, amount_num FROM flows INDEXED BY flows_from WHERE chain='namada' AND kind IN ('bond','ibc_out','shield') AND from_addr IN (${burners.map(() => '?').join(',')}) AND ts >= ? AND ts < ?`)
          .bind(...burners, minW, maxFollow).all<any>().catch(() => ({ results: [] as any[] })),
        sentToOsmosis(burnerSince, new Set(sellers)),
      ]);
      const burnerSellers = [...new Set([...burnerOsmo.values()].map((o) => o.osmo))];
      const burnerSold = burnerSellers.length
        ? await db.prepare(`SELECT from_addr, ts, amount_num FROM flows WHERE chain='osmosis' AND kind='sell' AND from_addr IN (${burnerSellers.map(() => '?').join(',')}) AND ts >= ? AND ts < ?`)
            .bind(...burnerSellers, minW, asOf).all<any>().catch(() => ({ results: [] as any[] }))
        : { results: [] as any[] };

      for (const bAddr of burners) {
        const incoming = (hopTransfers.results || []).filter((r: any) => r.to_addr === bAddr);
        const bOsmo = burnerOsmo.get(bAddr);
        const bMoves = [
          ...(burnerAfter.results || []).filter((r: any) => r.from_addr === bAddr && KIND[r.kind]).map((r: any) => ({ kind: KIND[r.kind], ts: r.ts, amount: r.amount_num, windowMs: 48 * H })),
          // a sale counts up to what the burner sent the account between the transfer and the sale
          ...(bOsmo ? (burnerSold.results || []).filter((r: any) => r.from_addr === bOsmo.osmo).map((r: any) => ({ kind: 'sold' as K, ts: r.ts, amount: r.amount_num, windowMs: 7 * D, via: bAddr })) : []),
        ];
        if (!bMoves.length) continue;
        const bAlloc = allocateFollowUps<K>(incoming.map((t: any, idx: number) => ({ key: `${idx}`, ts: t.ts, amount: t.amount_num })), bMoves,
          bOsmo ? new Map([[bAddr, bOsmo.crossings]]) : undefined);
        incoming.forEach((t: any, idx: number) => {
          const got = bAlloc.get(`${idx}`);
          if (!got) return;
          for (const k of ['rebonded', 'bridged_out', 'sold', 'shielded'] as K[]) {
            if ((got[k] ?? 0) > 0) {
              const list = hopMovesByOrigin.get(t.from_addr) ?? [];
              list.push({ kind: k, ts: t.ts, amount: got[k], windowMs: k === 'sold' ? 7 * D : 48 * H });
              hopMovesByOrigin.set(t.from_addr, list);
            }
          }
        });
      }
    }

    for (const addr of addrs) {
      const mine = withdraws.filter((w) => w.address === addr);
      const osmo = osmoOf.get(addr);
      const moves = [
        ...(after.results || []).filter((r: any) => r.from_addr === addr && KIND[r.kind]).map((r: any) => ({ kind: KIND[r.kind], ts: r.ts, amount: r.amount_num, windowMs: 48 * H })),
        // a sale counts up to what the withdrawer sent the account between the withdrawal and the sale
        ...(osmo ? (sold.results || []).filter((r: any) => r.from_addr === osmo.osmo).map((r: any) => ({ kind: 'sold' as K, ts: r.ts, amount: r.amount_num, windowMs: 7 * D, via: addr })) : []),
        ...(hopMovesByOrigin.get(addr) ?? []),
      ];
      const alloc = allocateFollowUps<K>(mine.map((w, i) => ({ key: `${w.txHash}:${i}`, ts: w.ts, amount: w.amountNam })), moves,
        osmo ? new Map([[addr, osmo.crossings]]) : undefined);
      mine.forEach((w, i) => {
        const got = alloc.get(`${w.txHash}:${i}`) ?? ({} as Record<K, number>);
        const best = (['rebonded', 'bridged_out', 'sold', 'shielded'] as K[]).map((k) => [k, got[k] ?? 0] as const).sort((a, b) => b[1] - a[1])[0];
        w.outcome = asOf - w.ts < 48 * H && best[1] === 0 ? null : best[1] > 0 ? { kind: best[0], amountNam: best[1] } : { kind: 'liquid', amountNam: w.amountNam };
      });
    }
  }

  // D4: movers (DEX only; atomic arbitrage excluded, cross-block turnaround ratio annotated)
  const mv = new Map<string, MoverEntry & { buyNam: number; sellNam: number }>();
  for (const s of swapRows.results || []) {
    const addr = s.kind === 'buy' ? s.to_addr : s.from_addr;
    if (!addr) continue;
    const m = mv.get(addr) ?? { address: addr, label: null, labelPlain: null, chain: 'osmosis' as const, netNam24h: 0, netNam7d: 0, buys: 0, sells: 0, lastTs: 0, buyNam: 0, sellNam: 0 };
    const signed = s.kind === 'buy' ? s.amount_num : -s.amount_num;
    m.netNam7d += signed;
    if (s.ts >= asOf - D) m.netNam24h += signed;
    if (s.kind === 'buy') { m.buys++; m.buyNam += s.amount_num; } else { m.sells++; m.sellNam += s.amount_num; }
    m.lastTs = Math.max(m.lastTs, s.ts);
    mv.set(addr, m);
  }
  const movers: MoverEntry[] = [...mv.values()]
    .map(({ buyNam, sellNam, ...m }) => {
      const gross = buyNam + sellNam;
      const turnaroundRatio = gross > 0 ? Number((1 - Math.abs(m.netNam7d) / gross).toFixed(4)) : 0;
      const crossBlockArb = m.buys + m.sells >= 6 && m.buys > 0 && m.sells > 0 && turnaroundRatio >= 0.85;
      return { ...m, turnaroundRatio, crossBlockArb };
    })
    .sort((a, b) => Math.abs(b.netNam7d) - Math.abs(a.netNam7d))
    .slice(0, 20);
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

  // Cohort attribution for Chart 3 (Cross-Chain Supply-to-Dump Pipeline)
  let genesisBackersNam = 0;
  let maspTurnstileNam = 0;
  let burnerHopNam = 0;
  let transparentNam = 0;
  let highHazardRemainingNam = 0;
  const EARLY = /genesis|backer|foundation|team/i;
  /** The genesis file's addresses, and a curated name with those words; never a tag a signed-in wallet wrote (shared/labels.ts label_plain). */
  const early = (label: string | null | undefined, source: string | null | undefined) => source === 'genesis' || (source !== 'user' && EARLY.test(label ?? ''));
  for (const e of onDeck) {
    if ((e.dumpHazardScore ?? 0) >= SELLS_MOST_CUT) highHazardRemainingNam += e.remaining;
    // The receiver's own tag, or a matched pass through the shielded set, decides for all it got.
    if (early(e.label, e.labelSource)) { genesisBackersNam += e.bridgedIn; continue; }
    if (e.passthroughFrom) { maspTurnstileNam += e.bridgedIn; continue; }
    // Otherwise each Namada sender's own NAM into it (its crossings in the window) goes to that sender's cohort, so
    // NAM from untagged senders is never counted as a tagged largest sender's, nor the reverse.
    let fromSenders = 0;
    for (const s of sendersOf.get(e.address) ?? []) {
      const nam = Math.min(s.nam, e.bridgedIn - fromSenders);
      if (!(nam > 0)) break;
      fromSenders += nam;
      const hop = hopOriginOf(s.addr, s.firstTs, s.nam);
      if (early(s.label, s.source) || (hop && early(hop.label, hop.labelSource))) genesisBackersNam += nam;
      else if (s.addr === MASP) maspTurnstileNam += nam;
      else if (hop) burnerHopNam += nam;
      else transparentNam += nam;
    }
    // NAM whose sender Osmosis did not record as a tnam1 address names no Namada origin; it stays in the last part
    // as it did before, so the parts add up to what crossed.
    transparentNam += Math.max(0, e.bridgedIn - fromSenders);
  }
  const pipelineSummary: SupplyCohortBreakdown = {
    cohorts: {
      genesisBackersNam,
      maspTurnstileNam,
      burnerHopNam,
      transparentNam,
    },
    highHazardRemainingNam,
  };

  return {
    asOf, windowDays, onDeck, onDeckTotal: onDeckTotals.remaining, onDeckTotals, ibcIn7d, ibcOut7d, ibcRefunded7d: sendsOut.refunded,
    unlocks, unlocksWindowDays: Math.max(UNLOCKS_WINDOW_DAYS, windowDays), unlocksMinNam: UNLOCKS_MIN_NAM, unbondingAll,
    unbondingDays: wait ? wait.days : null, unbondingEpochs: wait?.epochs ?? null, epochHours: wait ? wait.epochSec / 3600 : null,
    unbondingProv, chainParams: params,
    ...(unbondTermStructure ? { unbondTermStructure } : {}), unbondTermStructureProv, unbondWithdrawProv,
    pipelineSummary,
    bondedTrend: bondedTrend.map((p) => ({ ts: p.ts, value: p.value })), movers, proposals, proposalsProv,
    coverage: cov.both,
    coverageByChain: { osmosis: cov.osmosis, namada: cov.namada },
  };
}

// ---------------------------------------------------------------- blind spot (D5)

const MASP = INTERNAL_ADDRESSES.masp;
const ESCROW = INTERNAL_ADDRESSES.ibc;
const PAIR_MS = 15 * 60000;

export interface PoolLeg { ts: number; amount: number; dir: 'in' | 'out'; bridge: boolean; from: string | null; to: string | null }

/**
 * Probabilistic timing & amount-correlation matcher over MASP pool legs (`matchMaspPassthroughs`).
 * Identifies rapid turnstile passthroughs where an entity shields X NAM and unshields (or shielded-IBC-outs)
 * X - ε NAM within `windowMs` (default 24h), computing the candidate anonymity set size k (number of distinct
 * inflows in the window matching the outflow amount within `maxRelDiff`).
 */
export function matchMaspPassthroughs(
  legs: PoolLeg[],
  windowMs = 24 * H,
  maxRelDiff = 0.005,
): MaspPassthroughLink[] {
  const ins = legs
    .filter((l) => l.dir === 'in' && l.amount > 0 && l.from && !isInternal(l.from))
    .sort((a, b) => a.ts - b.ts);
  const outs = legs
    .filter((l) => l.dir === 'out' && l.amount > 0 && l.to && !isInternal(l.to))
    .sort((a, b) => a.ts - b.ts);

  const usedIn = new Set<number>();
  const links: MaspPassthroughLink[] = [];

  for (const out of outs) {
    const candidates: { idx: number; leg: PoolLeg; relDiff: number; dwellMs: number }[] = [];
    for (let i = 0; i < ins.length; i++) {
      const inp = ins[i];
      const dwellMs = out.ts - inp.ts;
      if (dwellMs < 0 || dwellMs > windowMs) continue;
      // Outflow is normally slightly smaller than or equal to inflow due to MASP fee legs
      if (out.amount > inp.amount * (1 + maxRelDiff)) continue;
      const relDiff = Math.abs(inp.amount - out.amount) / inp.amount;
      if (relDiff <= maxRelDiff) {
        candidates.push({ idx: i, leg: inp, relDiff, dwellMs });
      }
    }
    if (!candidates.length) continue;
    const anonymitySetK = candidates.length;
    const available = candidates
      .filter((c) => !usedIn.has(c.idx))
      .sort((a, b) => a.relDiff - b.relDiff || a.dwellMs - b.dwellMs);
    if (!available.length) continue;
    const best = available[0];
    usedIn.add(best.idx);
    const confidence: MaspPassthroughLink['confidence'] =
      anonymitySetK === 1 && best.dwellMs <= 6 * H && best.relDiff <= 0.001
        ? 'high'
        : anonymitySetK <= 2 && best.dwellMs <= 24 * H
          ? 'medium'
          : 'low';
    links.push({
      inTs: best.leg.ts,
      outTs: out.ts,
      dwellMs: best.dwellMs,
      inFrom: best.leg.from,
      outTo: out.to,
      inAmount: best.leg.amount,
      outAmount: out.amount,
      relDiff: Number(best.relDiff.toFixed(6)),
      anonymitySetK,
      confidence,
    });
  }
  return links.sort((a, b) => b.outTs - a.outTs);
}

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
  const from30 = asOf - 30 * D;
  const from7 = asOf - 7 * D;
  const [shielded, total, trendRecent, trendDaily, namadaLegs, osmoOut, osmoIn, unshieldRows, cov] = await Promise.all([
    metricAt(db, 'supply.masp_shielded', asOf),
    metricAt(db, 'supply.total', asOf),
    metricSeries(db, 'supply.masp_shielded', asOf - 7 * D, asOf, 6 * H),
    db.prepare(`SELECT ts, value FROM metrics WHERE key='supply.masp_shielded.daily' AND ts <= ? ORDER BY ts`).bind(asOf).all<{ ts: number; value: number }>().catch(() => ({ results: [] as any[] })),
    // NAM only (shielding another coin is not NAM), each transfer once (older twin rows left out).
    db.prepare(`SELECT f.kind, f.ts, f.from_addr, f.to_addr, f.amount_num FROM flows f WHERE f.chain='namada' AND f.ts >= ? AND f.ts < ?
                AND f.kind IN ('shield','unshield','ibc_in','ibc_out') AND (f.to_addr = ? OR f.from_addr = ?) AND ${NAM_AMOUNT} AND ${NOT_LEGACY_TWIN}`)
      .bind(from30, asOf, MASP, MASP).all<any>().catch(() => ({ results: [] as any[] })),
    osmosisSendsOut(db, from30 - PAIR_MS, asOf).catch(() => ({ outs: [] as IbcRow[], refunded: 0 })),
    db.prepare(`SELECT ts, from_addr, to_addr, amount_num FROM flows WHERE chain='osmosis' AND kind='ibc_in' AND from_addr = ? AND ts >= ? AND ts < ?`)
      .bind(MASP, from30 - PAIR_MS, asOf).all<any>().catch(() => ({ results: [] as any[] })),
    // The largest moves out of the pool to an address: unshields and crossings straight out over the bridge.
    db.prepare(`${FLOW_SELECT} WHERE f.chain='namada' AND f.ts >= ? AND f.ts < ? AND f.from_addr = ?
                AND (f.kind = 'unshield' OR (f.kind = 'ibc_out' AND f.to_addr LIKE 'osmo1%'))
                AND f.to_addr NOT IN (?,?,?,?) AND ${NAM_AMOUNT} AND ${NOT_LEGACY_TWIN}
                ORDER BY f.amount_num DESC LIMIT 25`).bind(asOf - 30 * D, asOf, MASP, INTERNAL_ADDRESSES.pos, INTERNAL_ADDRESSES.ibc, INTERNAL_ADDRESSES.pgf, INTERNAL_ADDRESSES.governance).all<any>(),
    coverageOf(db, asOf, replay),
  ]);

  const allLegs30 = maspLegs(namadaLegs.results || [], osmoOut.outs, osmoIn.results || []).filter((l) => l.ts >= from30 && l.ts < asOf);
  const legs = allLegs30.filter((l) => l.ts >= from7);
  const sum = (since: number, dir: 'in' | 'out', bridge?: boolean) => legs.filter((l) => l.ts >= since && l.dir === dir && (bridge == null || l.bridge === bridge)).reduce((a, l) => a + l.amount, 0);
  const d1 = asOf - D;
  const bridgeLegs = legs.filter((l) => l.bridge);

  const daily = (trendDaily.results || []).filter((d: any) => !trendRecent.length || d.ts < trendRecent[0].ts);
  const trend = [...daily, ...trendRecent.map((p) => ({ ts: p.ts, value: p.value }))];
  const shieldedS: Sourced<number> = { value: shielded?.value ?? null, prov: replay ? (shielded ? { source: 'Namada RPC (MASP balance)', at: shielded.ts, status: 'live' } : { source: 'Namada RPC (MASP balance)', at: null, status: 'missing', note: 'Not recorded at that time.' }) : provAt('Namada RPC (MASP balance)', shielded?.ts ?? null, asOf, 10 * 60000) };

  const shields7d = sum(from7, 'in'), unshields7d = sum(from7, 'out');
  const passthroughs7d = matchMaspPassthroughs(legs);
  const turnstileNam7d = passthroughs7d.reduce((a, p) => a + p.outAmount, 0);
  const maxFlow7d = Math.max(shields7d, unshields7d);
  const stickySharePct7d = maxFlow7d > 0 ? Math.max(0, Math.min(100, (1 - turnstileNam7d / maxFlow7d) * 100)) : null;

  // Build 6-hour pulse buckets over the 30-day window for Chart 4 (MASP Net Shielding Pulse & Turnstile)
  const passthroughs30 = matchMaspPassthroughs(allLegs30);
  const pulseBucketMs = 6 * H;
  const pulseMap = new Map<number, { inNam: number; outNam: number; turnstileNam: number; bridgeInNam: number; bridgeOutNam: number }>();
  for (const l of allLegs30) {
    const b = Math.floor(l.ts / pulseBucketMs) * pulseBucketMs;
    const cur = pulseMap.get(b) ?? { inNam: 0, outNam: 0, turnstileNam: 0, bridgeInNam: 0, bridgeOutNam: 0 };
    if (l.dir === 'in') {
      cur.inNam += l.amount;
      if (l.bridge) cur.bridgeInNam += l.amount;
    } else {
      cur.outNam += l.amount;
      if (l.bridge) cur.bridgeOutNam += l.amount;
    }
    pulseMap.set(b, cur);
  }
  for (const pt of passthroughs30) {
    const b = Math.floor(pt.outTs / pulseBucketMs) * pulseBucketMs;
    const cur = pulseMap.get(b) ?? { inNam: 0, outNam: 0, turnstileNam: 0, bridgeInNam: 0, bridgeOutNam: 0 };
    cur.turnstileNam += pt.outAmount;
    pulseMap.set(b, cur);
  }
  let cumNetNam = 0;
  const pulseSeries: MaspPulseBucket[] = [...pulseMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ts, b]) => {
      const netNam = b.inNam - b.outNam;
      cumNetNam += netNam;
      return {
        ts,
        inNam: b.inNam,
        outNam: b.outNam,
        netNam,
        cumNetNam,
        turnstileNam: b.turnstileNam,
        bridgeInNam: b.bridgeInNam,
        bridgeOutNam: b.bridgeOutNam,
      };
    });

  const bridgeIn7d = sum(from7, 'in', true), bridgeOut7d = sum(from7, 'out', true);
  return {
    asOf,
    shielded: shieldedS,
    total: total?.value ?? null,
    sharePct: shielded && total && total.value > 0 ? (shielded.value / total.value) * 100 : null,
    trend,
    shields24h: sum(d1, 'in'), unshields24h: sum(d1, 'out'), shields7d, unshields7d,
    bridgeIn24h: sum(d1, 'in', true), bridgeOut24h: sum(d1, 'out', true), bridgeIn7d, bridgeOut7d,
    lastBridgeAt: bridgeLegs.length ? Math.max(...bridgeLegs.map((l) => l.ts)) : null,
    ibcShielded7d: bridgeIn7d + bridgeOut7d,
    unshields: (unshieldRows.results || []).map(rowToFlow),
    passthroughs7d,
    turnstileNam7d,
    stickySharePct7d,
    pulseSeries,
    // The pool's figures come from Namada records (and Osmosis records of crossings): both indexes matter.
    coverage: cov.both,
    coverageByChain: { osmosis: cov.osmosis, namada: cov.namada },
  };
}

// ---------------------------------------------------------------- orderflow & CVD (D1, Chart 1)

/**
 * Signed orderflow & Cumulative Volume Delta (CVD) over any time window (`hours`, up to 1,500 days).
 * Excludes atomic arbitrage round-trips (`arb: true`) so `netDeltaNam` and `cvdNam` measure genuine directional
 * taker pressure against Osmosis pools, and compares CVD direction with VWAP price change to detect limit/CL
 * absorption vs. directional trend.
 */
export async function orderflowSeries(db: D1Database, asOf: number, replay: boolean, hours = 24 * 30): Promise<OrderflowResponse> {
  const bucketMs = hours <= 48 ? H : hours <= 24 * 14 ? 2 * H : hours <= 24 * 45 ? 6 * H : D;
  const from = asOf - hours * H;
  const [rows, cov] = await Promise.all([
    db.prepare(
      `SELECT CAST(ts / ? AS INTEGER) * ? AS b_ts,
              SUM(CASE WHEN kind='buy' THEN amount_num ELSE 0 END) AS buy_nam,
              SUM(CASE WHEN kind='sell' THEN amount_num ELSE 0 END) AS sell_nam,
              SUM(CASE WHEN price_usd > 0 AND amount_num > 0 THEN price_usd * amount_num
                       WHEN counter_denom='USDC' AND counter_amount > 0 THEN counter_amount
                       ELSE 0 END) AS usd_notional,
              SUM(CASE WHEN (price_usd > 0 OR (counter_denom='USDC' AND counter_amount > 0)) AND amount_num > 0 THEN amount_num ELSE 0 END) AS priced_nam,
              COUNT(*) AS trades
       FROM flows
       WHERE chain='osmosis' AND kind IN ('buy','sell') AND ts >= ? AND ts <= ?
         AND (meta IS NULL OR meta NOT LIKE '%"arb":true%')
       GROUP BY CAST(ts / ? AS INTEGER)
       ORDER BY b_ts ASC`,
    )
      .bind(bucketMs, bucketMs, from, asOf, bucketMs)
      .all<any>()
      .catch(() => ({ results: [] as any[] })),
    coverageOf(db, asOf, replay),
  ]);

  let cvdNam = 0;
  let totalBuy = 0;
  let totalSell = 0;
  const buckets: OrderflowBucket[] = (rows.results || []).map((r: any) => {
    const buyNam = Number(r.buy_nam || 0);
    const sellNam = Number(r.sell_nam || 0);
    const netDeltaNam = buyNam - sellNam;
    cvdNam += netDeltaNam;
    totalBuy += buyNam;
    totalSell += sellNam;
    const pricedNam = Number(r.priced_nam || 0);
    const usdNotional = Number(r.usd_notional || 0);
    return {
      ts: Number(r.b_ts),
      buyNam,
      sellNam,
      netDeltaNam,
      cvdNam,
      vwapUsd: pricedNam > 0 && usdNotional > 0 ? usdNotional / pricedNam : null,
      trades: Number(r.trades || 0),
    };
  });

  const grossVolumeNam = totalBuy + totalSell;
  const buySharePct = grossVolumeNam > 0 ? (totalBuy / grossVolumeNam) * 100 : null;
  const priced = buckets.filter((b) => b.vwapUsd != null && b.vwapUsd > 0);
  const firstPx = priced[0]?.vwapUsd ?? null;
  const lastPx = priced[priced.length - 1]?.vwapUsd ?? null;
  const priceChangePct = firstPx && lastPx && firstPx > 0 ? ((lastPx - firstPx) / firstPx) * 100 : null;

  const netRatio = grossVolumeNam > 0 ? cvdNam / grossVolumeNam : 0;
  let absorptionRegime: OrderflowResponse['absorptionRegime'] = 'balanced';
  if (Math.abs(netRatio) >= 0.08 && priceChangePct != null) {
    if (netRatio < -0.08 && priceChangePct >= -1.0) absorptionRegime = 'bid_absorption';
    else if (netRatio > 0.08 && priceChangePct <= 1.0) absorptionRegime = 'ask_absorption';
    else if (netRatio > 0.08 && priceChangePct > 1.0) absorptionRegime = 'trend_up';
    else if (netRatio < -0.08 && priceChangePct < -1.0) absorptionRegime = 'trend_down';
  }

  return {
    asOf,
    hours,
    bucketMs,
    buckets,
    netCvdNam: cvdNam,
    grossVolumeNam,
    buySharePct,
    priceChangePct,
    absorptionRegime,
    prov: cov.osmosis,
  };
}

// ---------------------------------------------------------------- alerts (D7)

/**
 * Alert hits between `from` and `to`. Every rule's size is NAM, so rows in another coin (meta.tokenSymbol,
 * NAM_AMOUNT) are left out, as the site's other NAM reads of the same kinds leave them out, and never fill the 500
 * rows read.
 */
export async function alertsBetween(db: D1Database, from: number, to: number, th: AlertThresholds): Promise<AlertHit[]> {
  const minAmt = Math.min(th.ibcInventory, th.unlock, th.bigSwap, th.unshield, th.bond);
  const rows = await db
    .prepare(`${FLOW_SELECT} WHERE f.ts >= ? AND f.ts < ? AND f.amount_num >= ? AND f.kind IN ('ibc_in','withdraw','unbond','buy','sell','unshield','bond') AND ${NAM_AMOUNT} AND ${NOT_LEGACY_TWIN} ORDER BY f.ts DESC LIMIT 500`)
    .bind(from, to, minAmt)
    .all<any>();
  const flows = (rows.results || []).map(rowToFlow);
  return withQuotes(db, evaluateFlows(flows, th), flows);
}

/** A quote this much older than a trade is no longer the price of its minute. */
export const QUOTE_MATCH_MS = 5 * 60_000;

const quoteAt = (db: D1Database, key: string, ts: number) =>
  db.prepare(`SELECT ts, value FROM metrics WHERE key = ? AND ts <= ? AND ts >= ? ORDER BY ts DESC LIMIT 1`).bind(key, ts, ts - QUOTE_MATCH_MS);

/** A trade's settle price needs a quote for one coin at the trade's minute: the trade, the coin, its metric. */
type QuoteAsk = { i: number; sym: string; ts: number };

/**
 * Each trade's settle price (shared/settle.ts) from its settle record (meta.settle): USDC and allUSDC at a dollar, a
 * coin with a rate in its own transaction at that rate, any other at its Osmosis quote stored for the trade's minute
 * (the latest reading at or before the trade, at most QUOTE_MATCH_MS before it). null for a trade that is not a buy
 * or a sell, has no record, or has a coin with no price. One key seek per coin a trade needs quoted, 50 to a batch.
 * A trade with a seek in a batch that fails is null too: a quote that could not be read is not a coin with no price
 * at that minute (settleOf would leave its gas out and say so), so the trade keeps its recorded price instead.
 */
export async function settlePrices(db: D1Database, trades: readonly { kind: string; ts: number; meta?: Record<string, unknown> | null }[]): Promise<(Settle | null)[]> {
  const recs = trades.map((t) => (t.kind === 'buy' || t.kind === 'sell' ? settleMetaOf(t.meta) : null));
  const asks: QuoteAsk[] = [];
  recs.forEach((s, i) => { if (s) for (const sym of quotesNeeded(s)) if (QUOTE_KEYS[sym]) asks.push({ i, sym, ts: trades[i].ts }); });
  const quotes: Record<string, number>[] = trades.map(() => ({}));
  const unread = new Set<number>();
  for (let k = 0; k < asks.length; k += 50) {
    const part = asks.slice(k, k + 50);
    const res = await db.batch(part.map((a) => quoteAt(db, QUOTE_KEYS[a.sym], a.ts))).catch(() => null);
    if (!res) part.forEach((a) => unread.add(a.i));
    res?.forEach((r, j) => {
      const row = (r.results?.[0] ?? null) as { value: number } | null;
      if (row && row.value > 0) quotes[part[j].i][part[j].sym] = row.value;
    });
  }
  return recs.map((s, i) => (s && !unread.has(i) ? settleOf(trades[i].kind as 'buy' | 'sell', s, quotes[i]) : null));
}

/** Each buy or sell among `flows` gets its settle price (settlePrices), when it has one: the lists and exports of moves. */
export async function withSettles(db: D1Database, flows: Flow[]): Promise<Flow[]> {
  const trades = flows.filter((f) => f.kind === 'buy' || f.kind === 'sell');
  if (!trades.length) return flows;
  const ss = await settlePrices(db, trades).catch(() => trades.map(() => null));
  trades.forEach((f, i) => { if (ss[i]) f.settle = ss[i]!; });
  return flows;
}

/**
 * Each trade hit's price. First what it settled at for its trader (settlePrices: every coin their balance changed by,
 * fees and gas in; 'settled'). Else, for a row recorded before the parser kept those coins, its own USDC per NAM
 * ('paid', set by the rule). Else the NAM quote stored for its minute: the latest price.usd reading at or before the
 * trade, at most QUOTE_MATCH_MS before it, labelled 'quote' so it is never read as what the trade paid. None found:
 * the hit says no price is on record. One key seek per quote.
 */
export async function withQuotes(db: D1Database, hits: AlertHit[], flows: Flow[] = []): Promise<AlertHit[]> {
  const byId = new Map(flows.map((f) => [f.id, f]));
  const trades = hits.filter((h) => h.ruleId === 'big_swap');
  const withFlow = trades.filter((h) => byId.has(h.flowId));
  const settles = await settlePrices(db, withFlow.map((h) => byId.get(h.flowId)!));
  withFlow.forEach((h, i) => {
    const settle = settles[i];
    if (settle) h.price = { usd: settle.usdPerNam, source: 'settled', at: byId.get(h.flowId)!.ts, settle };
  });
  const need = trades.filter((h) => !h.price);
  for (let i = 0; i < need.length; i += 50) {
    const part = need.slice(i, i + 50);
    const res = await db.batch(part.map((h) => quoteAt(db, 'price.usd', h.ts))).catch(() => null);
    res?.forEach((r, j) => {
      const row = (r.results?.[0] ?? null) as { ts: number; value: number } | null;
      if (row && row.value > 0) part[j].price = { usd: row.value, source: 'quote', at: Number(row.ts) };
    });
  }
  return hits;
}

/**
 * The most recent alert hit before `to`, of any age (W5), for the "nothing crossed an alert size" state.
 * The SQL narrows to flows each rule could fire on (its chain, kinds and NAM size; rows in another coin are left
 * out, NAM_AMOUNT, so they never fill a page); the shared rules then decide, exactly as for live alerts. Pages back
 * newest first: null only when the search reached the oldest record and found none; undefined when it gave up after
 * `pages` full pages (not known, so never "none on record").
 */
export async function lastAlertBefore(db: D1Database, to: number, th: AlertThresholds, pages = 5, pageSize = 100): Promise<AlertHit | null | undefined> {
  const cond = `((f.chain='osmosis' AND f.kind='ibc_in' AND f.amount_num >= ?)
    OR (f.chain='namada' AND f.kind IN ('withdraw','unbond') AND f.amount_num >= ?)
    OR (f.chain='osmosis' AND f.kind IN ('buy','sell') AND f.amount_num >= ?)
    OR (f.chain='namada' AND f.kind='unshield' AND f.amount_num >= ?)
    OR (f.chain='namada' AND f.kind='bond' AND f.amount_num >= ?))`;
  // Newest first on flows_ts, stopping at the page's last row (4,501 rows read for the first page on 2026-10-20); the
  // planner's own choice, one range per kind on flows_kind merged and sorted whole, read 40,134 for every page.
  for (let p = 0; p < pages; p++) {
    const rows = await db
      .prepare(`${flowSelect('INDEXED BY flows_ts')} WHERE f.ts < ? AND ${cond} AND ${NAM_AMOUNT} AND ${NOT_LEGACY_TWIN} ORDER BY f.ts DESC, f.height DESC LIMIT ? OFFSET ?`)

      .bind(to, th.ibcInventory, th.unlock, th.bigSwap, th.unshield, th.bond, pageSize, p * pageSize)
      .all<any>();
    const list = rows.results || [];
    const flows = list.map(rowToFlow);
    const hits = evaluateFlows(flows, th);
    if (hits.length) return (await withQuotes(db, [hits[0]], flows))[0];
    if (list.length < pageSize) return null;
  }
  return undefined;
}
