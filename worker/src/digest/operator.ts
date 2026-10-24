// The operator embed's figures (spec section 8): sources degraded during the day from the health log and the current
// health map, checks not passing, alert posts claimed and not sent, and the digest's own delivery record. Nothing in
// them is personal: source names, counts, times. One db.batch wave; the pure shaper takes the answers, so the tests
// shape literal health rows.
import { CHECK_STALE_MS } from './freshness';
import { SQL } from './sql';
import { DAY_MS, DB_NOT_ANSWERED, ReadFailed, digestWindow, notRead, rowsOf, type Answer, type DigestKind, type DigestWindow, type Figure } from './types';
import { Wave, type Prepared } from './waves';

/** kv key of the last daily digest's delivery record { key, at, targets, posted, skipped, waiting }. */
export const DIGEST_LAST_KV = 'digest.last';
/** kv key of the last weekly digest's delivery record, apart from the daily's so a Monday's weekly leaves Tuesday's
 *  "yesterday's digest" line its record. */
export const DIGEST_LAST_WEEKLY_KV = 'digest.last.weekly';
/** The delivery record of a kind of digest. */
export const digestLastKv = (kind: DigestKind): string => (kind === 'weekly' ? DIGEST_LAST_WEEKLY_KV : DIGEST_LAST_KV);
/** kv key of the health log cron.ts mergeHealth appends to on every ok flip: [{ name, at, ok, note }]. */
export const DIGEST_HEALTH_LOG_KV = 'source.health.log';

export interface HealthLogRow { name: string; at: number; ok: number | boolean; note: string | null }
export interface HealthRow { name: string; ok: number | boolean; at: number | null; note: string | null }
export interface CheckRow { key: string; status: string; checked_at: number }
export interface ClaimsRow {
  moves: number | null; crossing_repeats: number | null; crossings: number | null; governance: number | null; forum: number | null; digests: number | null;
  second_keys: number | null; other: number | null; first_at: number | null; last_at: number | null;
}
export interface KvValueRow { key: string; value: string; updated_at: number }

export interface OperatorReads {
  healthLog: Answer<HealthLogRow>;
  health: Answer<HealthRow>;
  checks: Answer<CheckRow>;
  claims: Answer<ClaimsRow>;
  kv: Answer<KvValueRow>;
  /** the claim rows of the digest keys asked about (digestKeysAsked) */
  digestClaims: Answer<{ key: string; updated_at: number }>;
  digestKeysAsked: string[];
}

/** A source not ok from `from` until `to` (null: still not ok at T). */
export interface HealthEpisode { name: string; from: number; to: number | null; note: string | null }

export interface SourcesLine {
  ok: number; total: number;
  notOk: { name: string; since: number | null; note: string | null }[];
  episodes: HealthEpisode[];
  /** the log's first entry in the window, or null when the log is empty: faults that cleared before it have no record */
  logFrom: number | null;
}
/** `idle`: the checks that ran and had nothing to compare (status 'idle'), named so the count adds up. */
export interface ChecksLine { ok: number; total: number; notPassing: { key: string; status: string; checkedAt: number; stale: boolean }[]; idle: string[] }
export interface AlertsLine {
  /** the posts the claims stand for: `n` = moves + governance + forum + digests + other; `crossings` are among the moves */
  claimed: { n: number; moves: number; crossings: number; governance: number; forum: number; digests: number; other: number; firstAt: number | null; lastAt: number | null };
  /** kv alerts.skipped when its last case fell in the window */
  skipped: { total: number; last: { what: string; n: number; at: number } } | null;
}
export interface DigestLast { key: string; at: number; targets: number; posted: number; skipped: number }
export interface DeliveryLine {
  /** the last digest's record, whatever its period */
  last: DigestLast | null;
  /** the previous period's key and whether it was claimed (sent) */
  previous: { key: string; sentAt: number | null };
  /** the weekly: the daily keys of the week not claimed */
  dailiesNotSent: string[];
}

export interface OperatorFigures {
  kind: DigestKind; now: number; from: number; to: number;
  sources: Figure<SourcesLine>;
  checks: Figure<ChecksLine>;
  alerts: Figure<AlertsLine>;
  delivery: Figure<DeliveryLine>;
}

// ---- the digest's claim keys (spec section 2: one key per period)

export const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const dailyClaimKey = (ms: number) => `alert:digest:daily:${utcDate(ms)}`;

/** The ISO week of a UTC instant: the week containing it, numbered by its Thursday's year. */
export function isoWeek(ms: number): { year: number; week: number } {
  const d = new Date(ms);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((t.getTime() - firstThursday.getTime()) / DAY_MS - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return { year: t.getUTCFullYear(), week };
}
export const weeklyClaimKey = (ms: number) => { const w = isoWeek(ms); return `alert:digest:weekly:${w.year}-W${String(w.week).padStart(2, '0')}`; };

/** The keys the operator embed asks about: the previous period's, and for the weekly the week's seven dailies. */
export function digestKeysAsked(now: number, kind: DigestKind): string[] {
  if (kind === 'weekly') return [weeklyClaimKey(now - 7 * DAY_MS), ...Array.from({ length: 7 }, (_, i) => dailyClaimKey(now - (7 - i) * DAY_MS))];
  return [dailyClaimKey(now - DAY_MS)];
}

// ---- the reads

export async function readOperatorFigures(db: D1Database, now: number, kind: DigestKind, log?: Prepared[]): Promise<OperatorFigures> {
  const win = digestWindow(now, kind);
  const reads = await collectOperatorReads(db, win, log);
  return shapeOperatorFigures(reads, win);
}

export async function collectOperatorReads(db: D1Database, win: DigestWindow, log?: Prepared[]): Promise<OperatorReads> {
  const keys = digestKeysAsked(win.now, win.kind);
  const w = new Wave(db, log);
  const healthLog = w.add<HealthLogRow>(SQL.healthLog, [win.from]);
  const health = w.add<HealthRow>(SQL.health, []);
  const checks = w.add<CheckRow>(SQL.checks, []);
  const claims = w.add<ClaimsRow>(SQL.claims, [win.from, win.to]);
  const kv = w.add<KvValueRow>(SQL.operatorKv, []);
  const digestClaims = w.add<{ key: string; updated_at: number }>(SQL.digestClaims(keys.length), keys);
  await w.run();
  return { healthLog: healthLog.answer, health: health.answer, checks: checks.answer, claims: claims.answer, kv: kv.answer, digestClaims: digestClaims.answer, digestKeysAsked: keys };
}

// ---- the shapes

function section<T>(source: string, fn: () => Figure<T>): Figure<T> {
  try { return fn(); } catch (e) {
    if (e instanceof ReadFailed) return notRead(source, null, DB_NOT_ANSWERED);
    return notRead(source, null, `this line could not be computed (${String((e as Error)?.message ?? e).slice(0, 120)})`);
  }
}

export function shapeOperatorFigures(r: OperatorReads, win: DigestWindow): OperatorFigures {
  return {
    kind: win.kind, now: win.now, from: win.from, to: win.to,
    sources: section('source.health', () => shapeSources(r, win)),
    checks: section('checks', () => shapeChecks(r, win)),
    alerts: section('alert claims', () => shapeAlerts(r, win)),
    delivery: section('digest.last', () => shapeDelivery(r, win.kind)),
  };
}

/** Episodes of "not ok" per source from the log's flips in the window: a not-ok entry opens one, the next ok entry of that name closes it. */
export function healthEpisodes(rows: HealthLogRow[]): HealthEpisode[] {
  const byName = new Map<string, HealthLogRow[]>();
  for (const e of rows) (byName.get(e.name) ?? byName.set(e.name, []).get(e.name)!).push(e);
  const out: HealthEpisode[] = [];
  for (const [name, list] of byName) {
    list.sort((a, b) => a.at - b.at);
    let open: HealthEpisode | null = null;
    for (const e of list) {
      const ok = e.ok === true || e.ok === 1;
      if (!ok && !open) open = { name, from: e.at, to: null, note: e.note };
      else if (ok && open) { open.to = e.at; out.push(open); open = null; }
    }
    if (open) out.push(open);
  }
  return out.sort((a, b) => a.from - b.from || a.name.localeCompare(b.name));
}

export function shapeSources(r: OperatorReads, win: DigestWindow): Figure<SourcesLine> {
  const health = rowsOf(r.health, 'source.health');
  const logRows = rowsOf(r.healthLog, 'source.health.log').filter((e) => e.at >= win.from && e.at < win.to);
  const okRows = health.filter((h) => h.ok === true || h.ok === 1);
  const notOk = health.filter((h) => !(h.ok === true || h.ok === 1)).map((h) => ({ name: h.name, since: h.at, note: h.note }));
  const at = health.reduce<number | null>((m, h) => (h.at != null && (m == null || h.at > m) ? h.at : m), null);
  return {
    value: { ok: okRows.length, total: health.length, notOk, episodes: healthEpisodes(logRows), logFrom: logRows.length ? Math.min(...logRows.map((e) => e.at)) : null },
    stamp: { source: 'source.health', at: at ?? win.now, status: 'live' },
  };
}

export function shapeChecks(r: OperatorReads, win: DigestWindow): Figure<ChecksLine> {
  const rows = rowsOf(r.checks, 'checks');
  const notPassing = rows
    .map((c) => ({ key: c.key, status: c.status, checkedAt: c.checked_at, stale: win.now - c.checked_at > CHECK_STALE_MS }))
    .filter((c) => (c.status !== 'ok' && c.status !== 'idle') || c.stale);
  return {
    value: {
      ok: rows.filter((c) => c.status === 'ok' && win.now - c.checked_at <= CHECK_STALE_MS).length, total: rows.length, notPassing,
      idle: rows.filter((c) => c.status === 'idle' && win.now - c.checked_at <= CHECK_STALE_MS).map((c) => c.key),
    },
    stamp: { source: 'checks', at: rows.reduce((m, c) => Math.max(m, c.checked_at), 0) || win.now, status: 'live' },
  };
}

export function shapeAlerts(r: OperatorReads, win: DigestWindow): Figure<AlertsLine> {
  const c = rowsOf(r.claims, 'alert claims')[0];
  const kv = rowsOf(r.kv, 'alerts.skipped');
  const raw = kv.find((x) => x.key === 'alerts.skipped');
  let skipped: AlertsLine['skipped'] = null;
  if (raw) {
    try {
      const v = JSON.parse(raw.value) as { total?: number; last?: { what?: string; n?: number; at?: number } };
      if (v?.last && Number.isFinite(v.last.at) && Number(v.last.at) >= win.from && Number(v.last.at) < win.to) {
        skipped = { total: Number(v.total ?? 0), last: { what: String(v.last.what ?? ''), n: Number(v.last.n ?? 0), at: Number(v.last.at) } };
      }
    } catch { /* an unreadable record is no record */ }
  }
  return {
    value: {
      claimed: (() => {
        // a crossing's record that claimed its flow id after the crossing was claimed was not posted again
        const moves = Math.max(0, (c?.moves ?? 0) - (c?.crossing_repeats ?? 0));
        const governance = c?.governance ?? 0, forum = c?.forum ?? 0, digests = c?.digests ?? 0, other = c?.other ?? 0;
        return { n: moves + governance + forum + digests + other, moves, crossings: c?.crossings ?? 0, governance, forum, digests, other, firstAt: c?.first_at ?? null, lastAt: c?.last_at ?? null };
      })(),
      skipped,
    },
    stamp: { source: 'alert claims', at: win.now, status: 'live' },
  };
}

export function shapeDelivery(r: OperatorReads, kind: DigestKind = 'daily'): Figure<DeliveryLine> {
  const kv = rowsOf(r.kv, 'digest.last');
  const claims = rowsOf(r.digestClaims, 'digest claims');
  const raw = kv.find((x) => x.key === digestLastKv(kind));
  let last: DigestLast | null = null;
  if (raw) {
    try {
      const v = JSON.parse(raw.value);
      if (v && typeof v.key === 'string' && Number.isFinite(v.at)) last = { key: v.key, at: Number(v.at), targets: Number(v.targets ?? 0), posted: Number(v.posted ?? 0), skipped: Number(v.skipped ?? 0) };
    } catch { /* an unreadable record is no record */ }
  }
  const [previousKey, ...dailies] = r.digestKeysAsked;
  const claimedAt = (key: string) => claims.find((c) => c.key === key)?.updated_at ?? null;
  return {
    value: { last, previous: { key: previousKey, sentAt: claimedAt(previousKey) }, dailiesNotSent: dailies.filter((k) => claimedAt(k) == null) },
    stamp: { source: DIGEST_LAST_KV, at: last?.at ?? (raw?.updated_at ?? 0), status: 'live' },
  };
}
