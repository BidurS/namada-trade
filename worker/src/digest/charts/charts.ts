// The digest's four pictures, drawn on the site's dark surface with its tokens (web/src/styles/tokens.css, dark):
// one y axis with 1-2-5 ticks and the labels in a left gutter, a recessive grid (--line), tick text in --ink-2,
// thin marks (2 px lines, 3 px dots), the primary series in --ink, the secondary in --ink-3 dashed (the site's
// executed / quoted pair), the shielded series in --shielded (always with words, in the embed), bars in --ink-2,
// the empty-slot floor marks in --ink-3 at 45 % (Bars.tsx's c-slot), the last-value pill in --accent (the one
// yellow moment), and the zero baseline in --line-strong. Never a buy or sell hue on a series: a sign is read from
// the geometry (a bar below the baseline), never from a colour. Nothing is interpolated: two points are joined
// only when they are adjacent steps, so a stretch with no reading is a break in the line and, where the stretch is
// wide enough to see (6 px or more), a mark on the floor.
//
// Every chart is a pure function of its input (no clock, no randomness, no platform text): the same input gives
// the same pixels on every runtime, and the same PNG bytes within one runtime. The legend, the sources and the
// as-of stamps are not in the image: each chart returns `words`, the figures the embed's text needs, because a
// phone push shows the text alone and the bitmap font carries only axis labels. A chart whose source was not read
// is left out of the set with a plain sentence in its place (renderChartSet), never drawn empty and never from an
// older reading.
//
// The series each chart takes are the data map's: metrics price.usd.1h (the quote at each closed hour's end) and
// price.swap_1h with price.swap_1h.n (the executed hourly median of trusted trades and its count); metrics
// supply.total_stake.1h; the unbond_queue buckets after the current epoch on the epoch clock of kv chain.params;
// and the day keys bridge.in_daily − bridge.out_daily and masp.in_daily − masp.out_daily. The reads and the
// shaping of rows into these inputs belong to the digest's read step; this module only draws what it is given.
import { Canvas, drawText, hex, mix, textHeight, textWidth, type RGB } from './raster';
import { encodePng, filteredRows } from './png';
// niceTicks, stepDecimals and lin are the site's own, so the digest's axes read like the pages'. The file has no
// React or DOM dependency; the wiring step that may edit existing files can move it to shared/ and re-point both
// imports.
import { lin, niceTicks, stepDecimals } from '../../../../web/src/ui/chartMath';

export const THEME = {
  bg: hex('#0d0d0d'), // --surface
  line: hex('#242424'), // --line
  lineStrong: hex('#666666'), // --line-strong
  ink: hex('#f5f5f5'), // --ink
  ink2: hex('#a8a8a8'), // --ink-2
  ink3: hex('#858585'), // --ink-3
  mark: hex('#ffff00'), // --accent (the pill)
  markInk: hex('#000000'), // --accent-ink
  shielded: hex('#00ffff'), // --shielded
} as const;

export const CHART_W = 800;
export const CHART_H = 300;
/** The bitmap font's scale: 5 × 7 cells at 2 px = 10 × 14 px glyphs (about 11 px text once Discord scales the image). */
export const FONT_SCALE = 2;
/** Empty slots are marked only where a slot is at least this wide (px): Bars.tsx's SLOT_MARK_MIN_PX. */
export const SLOT_MARK_MIN_PX = 6;
const LINE_W = 2;
const DOT_R = 3;
const QUOTE_DASH: readonly [number, number] = [5, 5];

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

// ----------------------------------------------------------------------------------------------- tick words and dates

/** NAM tick label with as many decimals as the step needs: "50M", "341.65M", "980k", "-1.5M" (SeriesChart's namTick). */
export function namTick(v: number, step: number): string {
  if (v === 0) return '0';
  const a = Math.max(Math.abs(v), Math.abs(step));
  const [div, suf] = a >= 1e9 ? [1e9, 'B'] : a >= 1e6 ? [1e6, 'M'] : a >= 1e3 ? [1e3, 'k'] : [1, ''];
  return `${(v / div).toFixed(stepDecimals(step / div))}${suf}`;
}

/** A dollar tick: the step's decimals, no thousands ("0.0005"). */
export const usdTick = (v: number, step: number): string => v.toFixed(stepDecimals(step));

/** Compact NAM for the pill: "267.77M", "37.5k". */
export const namShort = (v: number): string => {
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${(v / 1e3).toFixed(1)}k`;
  return v.toFixed(0);
};

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const p2 = (n: number) => String(n).padStart(2, '0');

/** "16 Oct" */
export const fmtDayMon = (t: number): string => {
  const d = new Date(t);
  return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
};
/** "08:00" */
export const fmtClock = (t: number): string => {
  const d = new Date(t);
  return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
};
/** "16 Oct 08:00" */
export const fmtDayMonClock = (t: number): string => `${fmtDayMon(t)} ${fmtClock(t)}`;
/** The UTC midnight at or before t. */
export const dayStart = (t: number): number => Math.floor(t / DAY_MS) * DAY_MS;

// ----------------------------------------------------------------------------------------------- the frame

export interface Point {
  /** the start of the point's step (unix ms) */
  t: number;
  v: number;
}

export interface ChartPixels {
  w: number;
  h: number;
  rgb: Uint8Array;
  /** every string drawn in the image, for the glyph test */
  labels: string[];
  /** the plot box: the left gutter's edge, the right margin, the top and the baseline (px) */
  box: { L: number; R: number; T: number; base: number };
}

interface Frame {
  cv: Canvas;
  L: number;
  R: number;
  T: number;
  base: number;
  X: (t: number) => number;
  Y: (v: number) => number;
  labels: string[];
}

interface XLabel {
  t: number;
  s: string;
  align: 'left' | 'center' | 'right';
}

interface FrameOpts {
  yTicks: number[];
  yLabels: string[];
  tFrom: number;
  tTo: number;
  xLabels: XLabel[];
}

/** The surface, the grid at the y ticks with their labels in the left gutter, and the x labels under the baseline. */
function frame(opts: FrameOpts): Frame {
  const cv = new Canvas(CHART_W, CHART_H, THEME.bg);
  const labels: string[] = [];
  const L = Math.max(...opts.yLabels.map((s) => textWidth(s, FONT_SCALE))) + 18;
  const R = 14;
  const T = 16;
  const B = 30;
  const base = CHART_H - B;
  const X = lin(opts.tFrom, opts.tTo, L, CHART_W - R);
  const Y = lin(opts.yTicks[0], opts.yTicks[opts.yTicks.length - 1], base, T);
  opts.yTicks.forEach((tick, i) => {
    const y = Math.round(Y(tick));
    cv.hline(L, CHART_W - R, y, THEME.line);
    drawText(cv, L - 8, y - textHeight(FONT_SCALE) / 2, opts.yLabels[i], FONT_SCALE, THEME.ink2, 'right');
    labels.push(opts.yLabels[i]);
  });
  for (const xl of opts.xLabels) {
    const x = xl.align === 'left' ? L : xl.align === 'right' ? CHART_W - R : X(xl.t);
    drawText(cv, x, base + 10, xl.s, FONT_SCALE, THEME.ink2, xl.align);
    labels.push(xl.s);
  }
  return { cv, L, R, T, base, X, Y, labels };
}

const pixelsOf = (f: Frame): ChartPixels => ({ w: CHART_W, h: CHART_H, rgb: f.cv.px, labels: f.labels, box: { L: f.L, R: f.R, T: f.T, base: f.base } });

/** Runs of points split where the next is more than 1.5 steps later: a line never crosses a stretch with no reading. */
export function runs<P extends { t: number }>(pts: P[], stepMs: number): P[][] {
  const out: P[][] = [];
  let cur: P[] = [];
  for (const p of pts) {
    if (cur.length && p.t - cur[cur.length - 1].t > stepMs * 1.5) {
      out.push(cur);
      cur = [];
    }
    cur.push(p);
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * The closed steps of the window: each step that starts at or after `from` (and the series' first row, `start`) and
 * has ended by `to`. The step `to` falls in has not closed, so it is never a slot; a closed step whose row is not due
 * yet (it ended less than `pendingMs` before `to`, its rollup still to run) and has no point is not a slot either:
 * it is neither a reading nor missing.
 */
export function closedSlots(pts: { t: number }[], from: number, to: number, stepMs: number, start?: number | null, pendingMs = 0): { slots: number; empty: number[] } {
  const have = new Set(pts.map((p) => Math.floor(p.t / stepMs)));
  const empty: number[] = [];
  let slots = 0;
  const lo = Math.ceil(Math.max(from, start ?? from) / stepMs);
  for (let k = lo; (k + 1) * stepMs <= to; k++) {
    if (have.has(k)) { slots++; continue; }
    if ((k + 1) * stepMs > to - pendingMs) continue;
    slots++;
    empty.push(k * stepMs);
  }
  return { slots, empty };
}

/** The closed steps with no point: the slots a floor mark can show (closedSlots). */
export function emptySlots(pts: { t: number }[], from: number, to: number, stepMs: number, start?: number | null, pendingMs = 0): number[] {
  return closedSlots(pts, from, to, stepMs, start, pendingMs).empty;
}

/** Contiguous runs of empty slots, as [first slot start, slot count]. */
export function gapRuns(slots: number[], stepMs: number): [number, number][] {
  const out: [number, number][] = [];
  for (const t of slots) {
    const last = out[out.length - 1];
    if (last && t === last[0] + last[1] * stepMs) last[1]++;
    else out.push([t, 1]);
  }
  return out;
}

/** The floor mark's colour: --ink-3 at 45 % over the surface (Bars.tsx's c-slot). */
export const SLOT_MARK: RGB = mix(THEME.ink3, THEME.bg, 0.45);

/** Bars: one floor mark per empty slot, only where a slot is wide enough to see (Bars.tsx's rule). */
function floorMarks(f: Frame, slots: number[], slotW: number): void {
  if (slotW < SLOT_MARK_MIN_PX) return;
  for (const t of slots) f.cv.fillRect(f.X(t) + 1, f.base - 2, Math.max(1, slotW - 2), 2, SLOT_MARK);
}

/** Lines: one floor mark per gap run (a stretch with no reading) wide enough to see; returns how many were marked. */
function gapMarks(f: Frame, slots: number[], stepMs: number): number {
  let n = 0;
  for (const [t, k] of gapRuns(slots, stepMs)) {
    const x0 = f.X(t);
    const w = f.X(t + k * stepMs) - x0;
    if (w < SLOT_MARK_MIN_PX) continue;
    f.cv.fillRect(x0 + 1, f.base - 2, Math.max(1, w - 2), 2, SLOT_MARK);
    n++;
  }
  return n;
}

/** The points of a closed-step series inside [from, to]: the step must have closed by `to`, so the open step at the send time is never drawn. */
const inWindow = <P extends Point>(pts: P[], from: number, to: number, stepMs: number): P[] => pts.filter((p) => p.t >= from && p.t + stepMs <= to);

/** The finite points of a series, oldest first. */
const sorted = <P extends Point>(pts: P[]): P[] => pts.filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v)).sort((a, b) => a.t - b.t);

function polyline(f: Frame, pts: Point[], stepMs: number, c: RGB, dash?: readonly [number, number]): void {
  for (const run of runs(pts, stepMs)) {
    for (let i = 1; i < run.length; i++) f.cv.line(f.X(run[i - 1].t), f.Y(run[i - 1].v), f.X(run[i].t), f.Y(run[i].v), LINE_W, c, 1, dash);
  }
}

/** The dashed "series starts here" rule, when the first row falls inside the window. */
function startRule(f: Frame, start: number | null): void {
  if (start != null) f.cv.vdash(Math.round(f.X(start)), f.T, f.base, 3, 3, THEME.ink3);
}

/**
 * The last-value pill, left of the last point (the site's placement), at the first of four vertical spots (above,
 * below, further above, further below) that no plotted point falls into, so it never hides the line's history.
 */
function pill(f: Frame, lx: number, ly: number, text: string, avoid: [number, number][]): void {
  const pw = textWidth(text, FONT_SCALE) + 16;
  const ph = 20;
  const px = Math.min(CHART_W - f.R - pw, Math.max(f.L, lx - pw - 8));
  const spots = [ly - 28, ly + 10, ly - 52, ly + 34].filter((py) => py >= f.T && py + ph <= f.base);
  const clear = (py: number) => !avoid.some(([x, y]) => x >= px - 3 && x <= px + pw + 3 && y >= py - 4 && y <= py + ph + 4);
  const py = spots.find(clear) ?? spots[0] ?? Math.max(f.T, ly - 28);
  f.cv.pill(px, py, pw, ph, THEME.mark);
  drawText(f.cv, px + pw / 2, py + 3, text, FONT_SCALE, THEME.markInk, 'center');
  f.labels.push(text);
}

/** Three x labels: the window's start, middle and end, as day and month (and the clock on a window under 10 days). */
function xLabelsFor(from: number, to: number): XLabel[] {
  const clock = to - from < 10 * DAY_MS;
  const f = clock ? fmtDayMonClock : fmtDayMon;
  return [
    { t: from, s: f(from), align: 'left' },
    { t: (from + to) / 2, s: f((from + to) / 2), align: 'center' },
    { t: to, s: f(to), align: 'right' },
  ];
}

const lowest = <P extends Point>(pts: P[]): P | null => (pts.length ? pts.reduce((a, b) => (b.v < a.v ? b : a)) : null);
const highest = <P extends Point>(pts: P[]): P | null => (pts.length ? pts.reduce((a, b) => (b.v > a.v ? b : a)) : null);

// ----------------------------------------------------------------------------------------------- 1. price

export interface PriceInput {
  from: number;
  to: number;
  stepMs: number;
  /** metrics price.usd.1h: the quote at each closed hour's end (the hour's last reading), t = the hour's start */
  quote: Point[];
  /** metrics price.swap_1h with price.swap_1h.n: the executed hourly median of trusted trades, t = the hour's start, n = trades in the hour */
  exec: (Point & { n: number })[];
  /** the quote series' first row ever (null or absent: not known); hours before it are not gaps and the start is drawn as a dashed rule */
  quoteFirstTs?: number | null;
  /** how long after an hour closes its rollup row is due: a closed hour within this of `to` and without a row is pending, not missing */
  pendingMs?: number;
  /** false when the quote at the send time is not read: the last-value label is not drawn, since the text shows no price then */
  quoteLive?: boolean;
}

export interface PriceWords {
  /** closed hours in the window after the series began */
  slots: number;
  quoteHours: number;
  quoteGaps: number;
  /** gap runs wide enough to carry a floor mark */
  gapsMarked: number;
  execHours: number;
  execTrades: number;
  last: { quote: Point | null; exec: (Point & { n: number }) | null };
  low: Point | null;
  high: Point | null;
}

/** Executed price as dots joined only across adjacent hours (solid --ink); the quote dashed --ink-3, broken where the record has no reading. */
export function priceChart(input: PriceInput): ChartPixels & { words: PriceWords } {
  const quote = inWindow(sorted(input.quote), input.from, input.to, input.stepMs);
  const exec = inWindow(sorted(input.exec), input.from, input.to, input.stepMs);
  const all = [...quote, ...exec];
  const vals = all.map((p) => p.v);
  const yT = vals.length ? niceTicks(Math.min(...vals), Math.max(...vals), { maxTicks: 5 }) : niceTicks(0, 1);
  const f = frame({ yTicks: yT.ticks, yLabels: yT.ticks.map((t) => usdTick(t, yT.step)), tFrom: input.from, tTo: input.to, xLabels: xLabelsFor(input.from, input.to) });
  startRule(f, input.quoteFirstTs != null && input.quoteFirstTs > input.from ? input.quoteFirstTs : null);
  const closed = closedSlots(quote, input.from, input.to, input.stepMs, input.quoteFirstTs, input.pendingMs ?? 0);
  const gaps = closed.empty;
  const gapsMarked = gapMarks(f, gaps, input.stepMs);
  polyline(f, quote, input.stepMs, THEME.ink3, QUOTE_DASH);
  polyline(f, exec, input.stepMs, THEME.ink);
  for (const p of exec) f.cv.dot(f.X(p.t), f.Y(p.v), DOT_R, THEME.ink);
  const lastQ = quote[quote.length - 1] ?? null;
  // the label names the last closed hour's quote; with no quote read at the send time it would stand for a price the text does not show
  if (lastQ && input.quoteLive !== false) pill(f, f.X(lastQ.t), f.Y(lastQ.v), `$${lastQ.v.toFixed(8)}`, all.map((p) => [f.X(p.t), f.Y(p.v)]));
  return {
    ...pixelsOf(f),
    words: {
      slots: closed.slots,
      quoteHours: quote.length,
      quoteGaps: gaps.length,
      gapsMarked,
      execHours: exec.length,
      execTrades: exec.reduce((a, p) => a + (Number.isFinite(p.n) ? p.n : 0), 0),
      last: { quote: lastQ, exec: exec[exec.length - 1] ?? null },
      low: lowest(all),
      high: highest(all),
    },
  };
}

// ----------------------------------------------------------------------------------------------- 2. staked NAM

export interface StakeInput {
  from: number;
  to: number;
  stepMs: number;
  /** metrics supply.total_stake.1h: total stake at each closed hour's end, t = the hour's start */
  points: Point[];
  /** the series' first row ever (null: not known); hours before it are not gaps and the start is drawn as a dashed rule */
  firstTs: number | null;
  /** how long after an hour closes its rollup row is due (as PriceInput) */
  pendingMs?: number;
  /** false when total stake at the send time is not read: the last-value label is not drawn */
  live?: boolean;
}

export interface StakeWords {
  slots: number;
  hours: number;
  gaps: number;
  gapsMarked: number;
  /** the series' first row when it falls inside the window (the dashed rule's place) */
  startsInWindow: number | null;
  first: Point | null;
  last: Point | null;
  low: Point | null;
  high: Point | null;
}

/** Total stake per closed hour, one --ink line on a y axis fitted to the readings (a flat series is shown flat, not from zero). */
export function stakeChart(input: StakeInput): ChartPixels & { words: StakeWords } {
  const pts = inWindow(sorted(input.points), input.from, input.to, input.stepMs);
  const vals = pts.map((p) => p.v);
  const yT = vals.length ? niceTicks(Math.min(...vals), Math.max(...vals), { maxTicks: 5 }) : niceTicks(0, 1);
  const f = frame({ yTicks: yT.ticks, yLabels: yT.ticks.map((t) => namTick(t, yT.step)), tFrom: input.from, tTo: input.to, xLabels: xLabelsFor(input.from, input.to) });
  const start = input.firstTs != null && input.firstTs > input.from ? input.firstTs : null;
  startRule(f, start);
  const closed = closedSlots(pts, input.from, input.to, input.stepMs, input.firstTs, input.pendingMs ?? 0);
  const gaps = closed.empty;
  const gapsMarked = gapMarks(f, gaps, input.stepMs);
  polyline(f, pts, input.stepMs, THEME.ink);
  if (pts.length <= 60) for (const p of pts) f.cv.dot(f.X(p.t), f.Y(p.v), pts.length <= 2 ? 3.5 : 2, THEME.ink);
  const last = pts[pts.length - 1] ?? null;
  if (last && input.live !== false) pill(f, f.X(last.t), f.Y(last.v), namShort(last.v), pts.map((p) => [f.X(p.t), f.Y(p.v)]));
  return {
    ...pixelsOf(f),
    words: {
      slots: closed.slots,
      hours: pts.length,
      gaps: gaps.length,
      gapsMarked,
      startsInWindow: start,
      first: pts[0] ?? null,
      last,
      low: lowest(pts),
      high: highest(pts),
    },
  };
}

// ----------------------------------------------------------------------------------------------- 3. the unbonding pipeline

export interface PipelineInput {
  /** the first day slot (a UTC midnight) and how many days */
  fromDay: number;
  days: number;
  /** unbond_queue rows with withdraw_epoch after the current epoch */
  buckets: { epoch: number; nam: number; n: number }[];
  /** the current epoch (metrics epoch, the latest reading) */
  eNow: number;
  /** when the current epoch began (the first reading of its value); null: not anchored, the clock is "about" */
  started: number | null;
  /** kv chain.params epochSec × 1000 */
  epochSecMs: number;
  /** when the clock is not anchored, the epoch is taken to have begun at `asOf` less half an epoch: an "about" clock */
  asOf: number;
}

export interface PipelineDay {
  t: number;
  nam: number;
  n: number;
  epochs: number[];
}

export interface PipelineWords {
  slots: number;
  daysWithUnlock: number;
  totalNam: number;
  totalN: number;
  first: PipelineDay | null;
  largest: PipelineDay | null;
  /** buckets past the window's last day (not drawn) */
  beyond: { nam: number; n: number; epochs: number };
  anchored: boolean;
  days: PipelineDay[];
}

/** The clock of an epoch from the current epoch's start. */
export const epochClock = (e: number, eNow: number, started: number, epochSecMs: number): number => started + (e - eNow) * epochSecMs;

/** NAM unlocking per UTC day for the next N days, bars in --ink-2 from zero; a day with nothing to unlock is an empty slot with a floor mark. */
export function pipelineChart(input: PipelineInput): ChartPixels & { words: PipelineWords } {
  const to = input.fromDay + input.days * DAY_MS;
  const started = input.started ?? input.asOf - input.epochSecMs / 2;
  const byDay = new Map<number, PipelineDay>();
  const beyond = { nam: 0, n: 0, epochs: 0 };
  for (const b of input.buckets) {
    if (!(b.epoch > input.eNow)) continue;
    const at = epochClock(b.epoch, input.eNow, started, input.epochSecMs);
    const day = dayStart(at);
    if (day >= to) {
      beyond.nam += b.nam;
      beyond.n += b.n;
      beyond.epochs++;
      continue;
    }
    // an epoch the clock puts before the window's first day (the anchor's error) lands on that first day
    const slot = Math.max(input.fromDay, day);
    const d = byDay.get(slot) ?? { t: slot, nam: 0, n: 0, epochs: [] };
    d.nam += b.nam;
    d.n += b.n;
    d.epochs.push(b.epoch);
    byDay.set(slot, d);
  }
  const days = [...byDay.values()].sort((a, b) => a.t - b.t);
  const max = days.reduce((m, d) => Math.max(m, d.nam), 0);
  const yT = niceTicks(0, max > 0 ? max : 1, { maxTicks: 4, zero: true });
  const midDay = input.fromDay + Math.floor(input.days / 2) * DAY_MS;
  const f = frame({
    yTicks: yT.ticks,
    yLabels: yT.ticks.map((t) => namTick(t, yT.step)),
    tFrom: input.fromDay,
    tTo: to,
    xLabels: [
      { t: input.fromDay, s: fmtDayMon(input.fromDay), align: 'left' },
      { t: midDay, s: fmtDayMon(midDay), align: 'center' },
      { t: to - DAY_MS, s: fmtDayMon(to - DAY_MS), align: 'right' },
    ],
  });
  const slotW = f.X(input.fromDay + DAY_MS) - f.X(input.fromDay);
  const gutter = slotW >= 4 ? 1 : 0;
  const barW = Math.max(1, slotW - 2 * gutter);
  floorMarks(f, emptySlots(days, input.fromDay, to, DAY_MS), slotW);
  f.cv.hline(f.L, CHART_W - f.R, f.base, THEME.lineStrong);
  for (const d of days) f.cv.bar(f.X(d.t) + gutter, barW, f.base, f.Y(d.nam), THEME.ink2);
  return {
    ...pixelsOf(f),
    words: {
      slots: input.days,
      daysWithUnlock: days.length,
      totalNam: days.reduce((a, d) => a + d.nam, 0),
      totalN: days.reduce((a, d) => a + d.n, 0),
      first: days[0] ?? null,
      largest: days.length ? days.reduce((a, b) => (b.nam > a.nam ? b : a)) : null,
      beyond,
      anchored: input.started != null,
      days,
    },
  };
}

// ----------------------------------------------------------------------------------------------- 4. bridge and shielded net flow

export interface FlowDay {
  /** the UTC midnight the day starts at */
  t: number;
  /** bridge.in_daily − bridge.out_daily: the bridge's net to Namada; null: the day's record is missing */
  bridgeNet: number | null;
  /** masp.in_daily − masp.out_daily: the shielded pool's net in; null: the day's record is missing */
  maspNet: number | null;
}

export interface FlowsInput {
  /** one entry per closed UTC day, oldest first; a null net is a day whose record is missing (drawn as a floor mark, said in the embed) */
  days: FlowDay[];
}

export interface FlowsWords {
  days: FlowDay[];
  /** the days with a missing record in either series */
  missing: number[];
  bridgeTotal: number;
  maspTotal: number;
  largest: { bridge: FlowDay | null; masp: FlowDay | null };
}

/** Net flow per UTC day, two bars a day: the bridge's net to Namada in --ink, the shielded pool's net in --shielded; a bar below the baseline is an outflow. */
export function flowsChart(input: FlowsInput): ChartPixels & { words: FlowsWords } {
  const days = [...input.days].sort((a, b) => a.t - b.t);
  if (!days.length) throw new Error('flowsChart needs at least one day');
  const from = days[0].t;
  const to = days[days.length - 1].t + DAY_MS;
  const vals = days.flatMap((d) => [d.bridgeNet, d.maspNet]).filter((v): v is number => v != null && Number.isFinite(v));
  const yT = niceTicks(Math.min(0, ...vals), Math.max(0, ...vals), { maxTicks: 5, zero: true });
  const n = days.length;
  const mid = days[Math.floor(n / 2)].t;
  const xLabels: XLabel[] =
    n <= 8
      ? days.map((d) => ({ t: d.t + DAY_MS / 2, s: fmtDayMon(d.t), align: 'center' as const }))
      : [
          { t: from, s: fmtDayMon(from), align: 'left' },
          { t: mid, s: fmtDayMon(mid), align: 'center' },
          { t: to - DAY_MS, s: fmtDayMon(to - DAY_MS), align: 'right' },
        ];
  const f = frame({ yTicks: yT.ticks, yLabels: yT.ticks.map((t) => namTick(t, yT.step)), tFrom: from, tTo: to, xLabels });
  const slotW = f.X(from + DAY_MS) - f.X(from);
  const gap = slotW >= 12 ? 2 : 0;
  const barW = Math.max(1, Math.floor((slotW - 3 * gap) / 2));
  const y0 = Math.round(f.Y(0));
  const missing: number[] = [];
  for (const d of days) {
    const x = f.X(d.t) + gap;
    const bar = (v: number | null, bx: number, c: RGB) => {
      if (v == null) f.cv.fillRect(bx, y0 - 1, barW, 2, SLOT_MARK);
      else f.cv.bar(bx, barW, y0, f.Y(v), c);
    };
    bar(d.bridgeNet, x, THEME.ink);
    bar(d.maspNet, x + barW + gap, THEME.shielded);
    if (d.bridgeNet == null || d.maspNet == null) missing.push(d.t);
  }
  f.cv.hline(f.L, CHART_W - f.R, y0, THEME.lineStrong);
  const by = (k: 'bridgeNet' | 'maspNet'): FlowDay | null => {
    const have = days.filter((d) => d[k] != null);
    return have.length ? have.reduce((a, b) => (Math.abs(b[k] as number) > Math.abs(a[k] as number) ? b : a)) : null;
  };
  return {
    ...pixelsOf(f),
    words: {
      days,
      missing,
      bridgeTotal: days.reduce((a, d) => a + (d.bridgeNet ?? 0), 0),
      maspTotal: days.reduce((a, d) => a + (d.maspNet ?? 0), 0),
      largest: { bridge: by('bridgeNet'), masp: by('maspNet') },
    },
  };
}

// ----------------------------------------------------------------------------------------------- the file

export interface ChartFile {
  png: Uint8Array;
  bytes: number;
  /** sha-256 of the filtered scanlines: the picture's fingerprint, the same on every runtime */
  rowsHash: string;
}

export async function rowsHash(p: ChartPixels): Promise<string> {
  const rows = filteredRows(p.w, p.h, p.rgb);
  const plain = new Uint8Array(new ArrayBuffer(rows.byteLength));
  plain.set(rows);
  const d = await crypto.subtle.digest('SHA-256', plain);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function toPng(p: ChartPixels): Promise<ChartFile> {
  const png = await encodePng(p.w, p.h, p.rgb);
  return { png, bytes: png.length, rowsHash: await rowsHash(p) };
}

// ----------------------------------------------------------------------------------------------- the set, and what is left out

/** The digest's "not read" shape (spec section 1: digest.ts NotRead), as the read step hands it to the renderer. */
export interface NotRead {
  notRead: true;
  source: string;
  lastAt: number | null;
  reason: string;
}
export const isNotRead = (x: unknown): x is NotRead => typeof x === 'object' && x !== null && (x as NotRead).notRead === true;

export type DigestKind = 'daily' | 'weekly';
export type ChartName = 'price' | 'stake' | 'pipeline' | 'flows';
/** The four charts in the order they are attached. */
export const CHART_NAMES: readonly ChartName[] = ['price', 'stake', 'pipeline', 'flows'];
/** The word a left-out chart's sentence starts with. */
export const CHART_TITLES: Record<ChartName, string> = { price: 'Price', stake: 'Staked NAM', pipeline: 'Unlocks', flows: 'Net flow' };
/** Each chart's window in days: the daily's and the weekly variant's. */
export const CHART_DAYS: Record<DigestKind, Record<ChartName, number>> = {
  daily: { price: 7, stake: 30, pipeline: 30, flows: 7 },
  weekly: { price: 30, stake: 90, pipeline: 90, flows: 30 },
};
/** A picture larger than this is not attached (the design's budget; the four measure 2–15 KB at 800 × 300). */
export const PNG_MAX_BYTES = 100_000;

/** The attachment's file name, which the embed's attachment:// url must match exactly: "price-7d.png", "weekly-stake-90d.png". */
export const chartFileName = (kind: DigestKind, name: ChartName, days: number): string => `${kind === 'weekly' ? 'weekly-' : ''}${name}-${days}d.png`;

/** The sentence that stands where a left-out chart's caption would be. */
export const leftOutSentence = (name: ChartName, nr: NotRead): string =>
  `${CHART_TITLES[name]}: no chart — ${nr.source} ${nr.reason}${nr.lastAt != null ? ` (last read ${fmtDayMonClock(nr.lastAt)} UTC)` : ''}.`;

export interface ChartSetInput {
  price: PriceInput | NotRead;
  stake: StakeInput | NotRead;
  pipeline: PipelineInput | NotRead;
  flows: FlowsInput | NotRead;
}

export type ChartWords =
  | { name: 'price'; words: PriceWords }
  | { name: 'stake'; words: StakeWords }
  | { name: 'pipeline'; words: PipelineWords }
  | { name: 'flows'; words: FlowsWords };

export type RenderedChart = ChartWords &
  ChartFile & {
    /** the attachment's file name */
    file: string;
    /** every string drawn in the image */
    labels: string[];
  };

export interface LeftOutChart {
  name: ChartName;
  sentence: string;
}

export interface ChartSet {
  /** the pictures to attach, in CHART_NAMES order */
  charts: RenderedChart[];
  /** the charts not attached, each with the sentence that takes its place */
  leftOut: LeftOutChart[];
}

/** One chart's pixels, its words under its name, and the days its window spans (for the file name); null when its input is a NotRead. */
function draw(name: ChartName, input: ChartSetInput): { px: ChartPixels; named: ChartWords; days: number } | null {
  switch (name) {
    case 'price': {
      if (isNotRead(input.price)) return null;
      const c = priceChart(input.price);
      return { px: c, named: { name, words: c.words }, days: Math.round((input.price.to - input.price.from) / DAY_MS) };
    }
    case 'stake': {
      if (isNotRead(input.stake)) return null;
      const c = stakeChart(input.stake);
      return { px: c, named: { name, words: c.words }, days: Math.round((input.stake.to - input.stake.from) / DAY_MS) };
    }
    case 'pipeline': {
      if (isNotRead(input.pipeline)) return null;
      const c = pipelineChart(input.pipeline);
      return { px: c, named: { name, words: c.words }, days: input.pipeline.days };
    }
    case 'flows': {
      if (isNotRead(input.flows)) return null;
      const c = flowsChart(input.flows);
      return { px: c, named: { name, words: c.words }, days: input.flows.days.length };
    }
  }
}

/**
 * Renders the four charts of one digest from their inputs. A chart whose input is a NotRead is left out with the
 * read step's sentence; one whose drawing throws is left out with the error's message; one whose PNG is over
 * `maxBytes` is left out with the budget sentence. The other charts still render: nothing here can lose the set.
 */
export async function renderChartSet(input: ChartSetInput, kind: DigestKind, maxBytes = PNG_MAX_BYTES): Promise<ChartSet> {
  const out: ChartSet = { charts: [], leftOut: [] };
  for (const name of CHART_NAMES) {
    const given = input[name];
    if (isNotRead(given)) {
      out.leftOut.push({ name, sentence: leftOutSentence(name, given) });
      continue;
    }
    try {
      const drawn = draw(name, input);
      if (!drawn) continue;
      const file = await toPng(drawn.px);
      if (file.bytes > maxBytes) {
        out.leftOut.push({ name, sentence: `${CHART_TITLES[name]}: no chart — the picture was larger than its budget (${file.bytes.toLocaleString('en-US')} bytes, the bound ${maxBytes.toLocaleString('en-US')}).` });
        continue;
      }
      out.charts.push({ ...drawn.named, ...file, file: chartFileName(kind, name, drawn.days), labels: drawn.px.labels });
    } catch (e) {
      out.leftOut.push({ name, sentence: `${CHART_TITLES[name]}: no chart — the picture could not be drawn (${e instanceof Error ? e.message : String(e)}).` });
    }
  }
  return out;
}
