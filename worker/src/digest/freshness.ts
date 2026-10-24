// The freshness rules of a stored reading (spec section 5, settlement 12). A "now" reading must be within its key's
// bound of T (three times the key's cadence) or the figure is not read: the value is not printed, the last reading's
// time is. A base reading (24 h or 7 d ago) is the last reading at or before its instant, taken when within
// BASE_WINDOW_MS of it; when it is more than the key's bound before the instant the line names its time; none in the
// window gives no change; a series that starts after the instant says where it starts.
import { HOLDER_FIGURES_SERVE_MS } from '../holders';
import { UNBOND_TERM_STALE_MS } from '../analytics';
import { DAY_MS, HOUR_MS, notRead, staleReason, type Change, type Figure, type MetricFigure, type MetricRow } from './types';

/** Minute keys (supply.*, price.usd, epoch, dex.liquidity_usd): a tick a minute, bound 10 min. */
export const MINUTE_BOUND_MS = 10 * 60_000;
/** Bond-listing keys (stake.*): one listing every 40 min (cron.ts BOND_LISTING_MS), bound 3 × 40 min, the coverage check's rule (analytics.ts UNBOND_TERM_STALE_MS). */
export const BOND_LISTING_BOUND_MS = UNBOND_TERM_STALE_MS;
/** Balance-listing keys (holders.namada*): one listing an hour (cron.ts BALANCE_LISTING_MS), bound 3 h. */
export const BALANCE_LISTING_BOUND_MS = 3 * HOUR_MS;
/** Hourly keys (holders.osmosis, price.swap_1h*, dex.volume_24h_usd_osmosis): bound 3 h. */
export const HOURLY_BOUND_MS = 3 * HOUR_MS;
/** A base reading is taken within this of its instant. */
export const BASE_WINDOW_MS = 2 * HOUR_MS;
/** kv chain.params is refreshed every 6 h; older than this the digest gives epochs only, never a clock time. */
export const PARAMS_STALE_MS = DAY_MS;
/** kv intel.cache is rewritten every tick the read succeeds; older than this governance is not read. */
export const INTEL_STALE_MS = 30 * 60_000;
/** kv holders.figures' top-10 sums are served while this old (holders.ts HOLDER_FIGURES_SERVE_MS, 2 h). */
export const HOLDER_FIGURES_BOUND_MS = HOLDER_FIGURES_SERVE_MS;
/** An Osmosis holder pass that added up to the supply must have started within this of T, or the count is "not current". */
export const OSMOSIS_PASS_TRUST_MS = 6 * HOUR_MS;
/** The executed price is compared with the quote while its hour is this old (cron.ts PRICE_CHECK_WINDOW_MS, the price_vs_execution check's rule). */
export const EXECUTED_COMPARE_MS = 6 * HOUR_MS;
/** Past this the line says no executed trade in the last 24 h. */
export const EXECUTED_SHOW_MS = DAY_MS;
/** A check not run for this long is not counted as passing (api.ts CHECK_STALE_MS). */
export const CHECK_STALE_MS = 15 * 60_000;
/** A proposal's own discussion link is used when no longer than this (discord.ts GOV_LINK_MAX). */
export const GOV_LINK_MAX = 512;

/** The bound of each metrics key the digest reads. */
export const KEY_BOUNDS: Readonly<Record<string, number>> = {
  'supply.total_stake': MINUTE_BOUND_MS,
  'supply.pos_bonded': MINUTE_BOUND_MS,
  'supply.total': MINUTE_BOUND_MS,
  'supply.osmosis': MINUTE_BOUND_MS,
  'supply.ibc_escrow': MINUTE_BOUND_MS,
  'supply.masp_shielded': MINUTE_BOUND_MS,
  'price.usd': MINUTE_BOUND_MS,
  'epoch': MINUTE_BOUND_MS,
  'dex.liquidity_usd': MINUTE_BOUND_MS,
  'stake.stakers': BOND_LISTING_BOUND_MS,
  'stake.validators': BOND_LISTING_BOUND_MS,
  'stake.unbonding_nam': BOND_LISTING_BOUND_MS,
  'stake.withdrawable_nam': BOND_LISTING_BOUND_MS,
  'stake.top10_pct': BOND_LISTING_BOUND_MS,
  'holders.namada': BALANCE_LISTING_BOUND_MS,
  'holders.namada.top10_nam': BALANCE_LISTING_BOUND_MS,
  'holders.osmosis': HOURLY_BOUND_MS,
  'holders.osmosis.top10_nam': HOURLY_BOUND_MS,
  'price.swap_1h': HOURLY_BOUND_MS,
  'price.swap_1h.n': HOURLY_BOUND_MS,
  'dex.volume_24h_usd_osmosis': HOURLY_BOUND_MS,
  'dex.volume_7d_usd_osmosis': HOURLY_BOUND_MS,
};

export const boundOf = (key: string): number => KEY_BOUNDS[key] ?? MINUTE_BOUND_MS;

/** The first row of a latest() answer, or null. */
export const firstRow = <T>(rows: T[] | null | undefined): T | null => (rows && rows.length ? rows[0] : null);

/** A "now" reading within its bound of `now`, or the NotRead of its source (the last reading's time, no value). */
export function readNow(source: string, row: MetricRow | null, now: number, boundMs: number): Figure<MetricRow> {
  if (!row || !Number.isFinite(row.value)) return notRead(source, row?.ts ?? null, staleReason(row?.ts ?? null, now));
  if (now - row.ts > boundMs) return notRead(source, row.ts, staleReason(row.ts, now));
  return { value: row, stamp: { source, at: row.ts, status: 'live' } };
}

/**
 * The change from the base reading: the last reading at or before `baseAt`, when within BASE_WINDOW_MS of it.
 * `firstTs` is the series' first row (read only when no base exists); undefined when that read did not run.
 */
export function changeFrom(nowRow: MetricRow, baseRow: MetricRow | null, baseAt: number, boundMs: number, firstTs: number | null | undefined): Change {
  if (!baseRow) return { kind: 'before-start', firstTs: firstTs ?? null };
  if (baseAt - baseRow.ts > BASE_WINDOW_MS) return { kind: 'no-base', from: baseAt - BASE_WINDOW_MS, to: baseAt, lastBefore: baseRow };
  const delta = nowRow.value - baseRow.value;
  return { kind: 'ok', base: baseRow, delta, pct: baseRow.value !== 0 ? delta / baseRow.value : null, baseOff: baseAt - baseRow.ts > boundMs };
}

/** A metrics-backed figure: the live reading at `now` with its change against the base instant, or its NotRead. */
export function metricFigure(
  source: string, key: string, nowRow: MetricRow | null, baseRow: MetricRow | null, firstTs: number | null | undefined,
  now: number, baseAt: number, boundMs = boundOf(key),
): Figure<MetricFigure> {
  const r = readNow(source, nowRow, now, boundMs);
  if ('notRead' in r) return r;
  return { value: { value: r.value.value, at: r.value.ts, change: changeFrom(r.value, baseRow, baseAt, boundMs, firstTs) }, stamp: r.stamp };
}
