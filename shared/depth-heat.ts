// The time view's arithmetic (depth plan 3.2 view 3; step S6), pure and shared so the page and its tests run the same
// code: the stored heat bands decoded, the window cut into slots of one step each (a slot with no stored column is a
// gap, never filled in: verify.txt C2), the five colour steps of the ramp read off the window's own largest band, and
// the rule every line over time follows: a run of points breaks wherever a step has no reading, so no path is drawn
// across a gap. Nothing here names a coin or types a figure.
import { HEAT_EDGES } from './depth';

/** A base64 string of little-endian float32 values (the form the heat bands are stored in), decoded: the one decoder of the stored form, used by the Worker's routes and the page alike (worker/src/depth/model.ts packF32 writes it). */
export function unpackF32(s: string): Float32Array {
  const bin = atob(s);
  const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  const dv = new DataView(b.buffer);
  return Float32Array.from({ length: b.length >> 2 }, (_, i) => dv.getFloat32(i * 4, true));
}

/** One stored column: the aggregate's bands at one step, relative to that step's reference price. */
export interface HeatColumn {
  t: number;
  refUsd: number;
  height: number | null;
  bid: Float32Array;
  ask: Float32Array;
}

/** The step length of each heat window, in ms. */
export const HEAT_STEP_MS: Record<'1m' | '5m' | '1h', number> = { '1m': 60_000, '5m': 300_000, '1h': 3_600_000 };

/** The stored columns decoded, in time order; a column with a reference price that is not a positive number is left out (nothing can be placed on the price axis without one). */
export function decodeHeat(columns: { t: number; refUsd: number; bid: string; ask: string; height: number | null }[]): HeatColumn[] {
  const out: HeatColumn[] = [];
  for (const c of columns) {
    if (!(c.refUsd > 0) || !Number.isFinite(c.t)) continue;
    out.push({ t: c.t, refUsd: c.refUsd, height: c.height, bid: unpackF32(c.bid), ask: unpackF32(c.ask) });
  }
  return out.sort((a, b) => a.t - b.t);
}

/**
 * The window [from, to) cut into slots of `stepMs`, each holding the stored column of that step or null when none was
 * stored (the Worker's five-minute read keeps the last minute of each five: a column at minute four of its five falls in
 * the slot that starts at minute zero, so a column is placed by the slot its time falls in, never moved). Two columns in
 * one slot keep the later one. The slot count is the window's own, so a missing step is a blank slot and not a narrower
 * chart.
 */
export function slotColumns(columns: HeatColumn[], stepMs: number, from: number, to: number): (HeatColumn | null)[] {
  const n = Math.max(0, Math.ceil((to - from) / stepMs));
  const slots: (HeatColumn | null)[] = Array.from({ length: n }, () => null);
  for (const c of columns) {
    const k = Math.floor((c.t - from) / stepMs);
    if (k < 0 || k >= n) continue;
    const cur = slots[k];
    if (!cur || c.t > cur.t) slots[k] = c;
  }
  return slots;
}

/** The ramp has this many steps; the lowest step's floor is the window's largest band divided by HEAT_SPAN, and a band under it is blank. */
export const HEAT_STEPS = 5;
export const HEAT_SPAN = 1000;

/** The six edges of the five steps, rising by a fixed ratio from the floor to the largest band of the window; null when no band holds anything. */
export function heatStepEdges(max: number): number[] | null {
  if (!(max > 0)) return null;
  const ratio = HEAT_SPAN ** (1 / HEAT_STEPS);
  return Array.from({ length: HEAT_STEPS + 1 }, (_, i) => max / ratio ** (HEAT_STEPS - i));
}

/** The step a band's figure falls in (0 is the faintest), or null under the floor. */
export function heatStepOf(v: number, edges: number[]): number | null {
  if (!(v >= edges[0])) return null;
  for (let i = HEAT_STEPS - 1; i >= 0; i--) if (v >= edges[i]) return i;
  return null;
}

/** The largest band over the columns given (the colour scale is the window's own, not the whole store's). */
export function heatMax(columns: HeatColumn[]): number {
  let max = 0;
  for (const c of columns) for (const side of [c.bid, c.ask]) for (let i = 0; i < side.length; i++) if (side[i] > max) max = side[i];
  return max;
}

/** The price span the columns reach: the lowest band's floor and the highest band's ceiling over every column, as ratios of each reference (HEAT_EDGES). */
export function heatPriceSpan(columns: HeatColumn[]): { lo: number; hi: number } | null {
  if (!columns.length) return null;
  let lo = Infinity, hi = 0;
  for (const c of columns) {
    lo = Math.min(lo, c.refUsd * HEAT_EDGES[0]);
    hi = Math.max(hi, c.refUsd * HEAT_EDGES[HEAT_EDGES.length - 1]);
  }
  return { lo, hi };
}

/**
 * The band a price falls in for a column: k such that ref x edges[k] <= price < ref x edges[k + 1], or null outside the
 * bands. The bands are relative to each column's own reference, so the same absolute price is a different band when the
 * reference moves (the chart draws absolute prices on its axis and reads each column by this).
 */
export function bandAt(c: HeatColumn, price: number, edges: readonly number[] = HEAT_EDGES): number | null {
  const r = price / c.refUsd;
  if (!(r >= edges[0]) || r >= edges[edges.length - 1]) return null;
  // the edges are a geometric series: the index is a logarithm, checked against the neighbours for rounding
  const step = edges[1] / edges[0];
  let k = Math.floor(Math.log(r / edges[0]) / Math.log(step));
  if (k < 0) k = 0;
  if (k > edges.length - 2) k = edges.length - 2;
  while (k > 0 && r < edges[k]) k--;
  while (k < edges.length - 2 && r >= edges[k + 1]) k++;
  return k;
}

/**
 * The figure resting in a band of a column: the bids and the asks stored for it summed, with each side's own figure
 * kept so the readout can say them apart, and the side word `bid` or `ask` when only one side rests there. Most bands
 * hold one side (bids under the reference, asks above it), but not all: the edges have no edge at the reference itself
 * (they are a geometric series from a quarter), so one band straddles it and holds both, and in an aggregate of many
 * pools an ask can rest under the reference pool's price and a bid above it (the fixtures' crossed spread). A cell
 * never drops what rests in it.
 */
export const bandValue = (c: HeatColumn, k: number, _edges: readonly number[] = HEAT_EDGES): { side: 'bid' | 'ask' | 'both'; usd: number; bid: number; ask: number } => {
  const bid = c.bid[k] ?? 0, ask = c.ask[k] ?? 0;
  return { side: bid > 0 && ask > 0 ? 'both' : ask > 0 ? 'ask' : 'bid', usd: bid + ask, bid, ask };
};

/**
 * Runs of points split wherever the next point is more than `gapMs` later: a line is drawn run by run and never across
 * a stretch with no reading (verify.txt C2, made a rule). A point whose value is null ends its run too.
 */
export function runsOf<T extends { t: number; v?: number | null }>(points: T[], gapMs: number): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  const sorted = [...points].sort((a, b) => a.t - b.t);
  for (const p of sorted) {
    const missing = 'v' in p && (p.v == null || !Number.isFinite(p.v));
    if (missing) {
      if (cur.length) out.push(cur);
      cur = [];
      continue;
    }
    if (cur.length && p.t - cur[cur.length - 1].t > gapMs) {
      out.push(cur);
      cur = [];
    }
    cur.push(p);
  }
  if (cur.length) out.push(cur);
  return out;
}

/** A series point over time with a value or none, and (an hourly row) the range the hour spanned. */
export interface LinePoint {
  t: number;
  v: number | null;
  lo?: number | null;
  hi?: number | null;
}

/**
 * The lo/hi band of a minute series per bucket of `bucketMs` (the hour, as the stored hourly rows roll it): the lowest
 * and highest value among the minutes of each bucket, at the bucket's start. A bucket with no minute has no band.
 */
export function bandOf(points: LinePoint[], bucketMs: number): { t: number; lo: number; hi: number }[] {
  const by = new Map<number, { lo: number; hi: number }>();
  for (const p of points) {
    if (p.v == null || !Number.isFinite(p.v)) continue;
    const b = Math.floor(p.t / bucketMs) * bucketMs;
    const cur = by.get(b);
    if (!cur) by.set(b, { lo: p.v, hi: p.v });
    else { cur.lo = Math.min(cur.lo, p.v); cur.hi = Math.max(cur.hi, p.v); }
  }
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([t, r]) => ({ t, ...r }));
}

/**
 * A long minute series cut into `n` buckets over [from, to) for drawing: each bucket's value is the last reading in it,
 * and a bucket is null when it holds no reading or when any step inside it has none (a point whose value is null),
 * so a missing minute is a gap at every width, however narrow the chart: an outage shorter than a bucket still breaks
 * the line (verify.txt C2, made a rule). The steps before the first stored reading and after the last one are not
 * gaps (the series has not begun, or the newest minutes are not yet due), so the line's ends are not cut off. `n`
 * under the point count returns the points themselves.
 */
export function bucketLine(points: LinePoint[], from: number, to: number, n: number): LinePoint[] {
  const sorted = [...points].sort((a, b) => a.t - b.t);
  if (n <= 0 || points.length <= n) return sorted;
  const w = (to - from) / n;
  const out: LinePoint[] = Array.from({ length: n }, (_, i) => ({ t: from + i * w, v: null }));
  const stored = (p: LinePoint) => p.v != null && Number.isFinite(p.v);
  const first = sorted.find(stored)?.t ?? Infinity;
  const last = [...sorted].reverse().find(stored)?.t ?? -Infinity;
  const gapped = new Set<number>();
  for (const p of sorted) {
    const k = Math.floor((p.t - from) / w);
    if (k < 0 || k >= n) continue;
    if (!stored(p)) { if (p.t > first && p.t < last) gapped.add(k); continue; }
    out[k] = { t: out[k].t, v: p.v };
  }
  for (const k of gapped) out[k] = { t: out[k].t, v: null };
  return out;
}

/**
 * The hairline's runs as the heat chart draws them: one point per stored column at the column's own time (never the
 * slot's start or middle: the window's `from` is any millisecond, so a column stored at a whole minute or hour falls
 * anywhere inside its slot) with the column's reference price, the run broken at every slot with no column, so no path
 * crosses a blank slot; a run of one point is drawn as a short dash, never joined.
 */
export function hairlineRuns(columns: HeatColumn[], stepMs: number, from: number, to: number): { t: number; v: number }[][] {
  const out: { t: number; v: number }[][] = [];
  let cur: { t: number; v: number }[] = [];
  for (const c of slotColumns(columns, stepMs, from, to)) {
    if (!c) { if (cur.length) out.push(cur); cur = []; continue; }
    cur.push({ t: c.t, v: c.refUsd });
  }
  if (cur.length) out.push(cur);
  return out;
}

/** The executable line's runs as the chart draws them at `n` buckets across the window: bucketed, then split at every empty bucket. */
export function lineRuns(points: LinePoint[], from: number, to: number, n: number): LinePoint[][] {
  const drawn = bucketLine(points, from, to, n);
  const step = drawn.length < points.length ? (to - from) / n : drawn.length > 1 ? Math.min(...drawn.slice(1).map((p, i) => p.t - drawn[i].t)) : to - from;
  return runsOf(drawn, step * 1.5);
}
