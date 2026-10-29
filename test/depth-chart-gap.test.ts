// The rule of verify.txt C2, made a test (depth plan section 9): a failed or missing minute is a blank column in the
// heat and a break in every line over time, never bridged. The heat chart and the executable line draw from the shared
// helpers of shared/depth-heat.ts (hairlineRuns, lineRuns, slotColumns, bucketLine, runsOf), so the helpers are held
// here on the stored column of the research's reads of 2026-10-29 (test/fixtures/depth/api_depth_heat_column.json)
// tiled over a window with one minute left out: the slot is null, the hairline is two runs and never one path, the
// line is two runs at every width (a bucket holding a missing minute is blank, however narrow the chart); the
// five-minute phone columns keep the gap when the missing minute was the one the column stands for; the hairline's
// points sit at each column's own stored time and never at its slot's start; the band straddling the reference holds
// both sides; the ramp's five steps rise by one fixed ratio from the floor, and a band under the floor is blank. The
// page test (test/depth-page.test.ts) holds the drawn SVG to the same rule. No test reaches the network.
import { describe, it, expect } from 'vitest';
import { depthFixture } from './depth-fixtures';
import { HEAT_BANDS, HEAT_EDGES } from '../shared/depth';
import { HEAT_SPAN, HEAT_STEPS, bandAt, bandOf, bandValue, bucketLine, decodeHeat, hairlineRuns, heatMax, heatPriceSpan, heatStepEdges, heatStepOf, lineRuns, runsOf, slotColumns, unpackF32, type LinePoint } from '../shared/depth-heat';

const MIN = 60_000;
const COL = depthFixture<{ t: number; at: number; height: number; refUsd: number; bid: string; ask: string }>('api_depth_heat_column.json');
/** A window of twenty minutes ending on a whole minute, the stored column at every minute but one (the fourteenth). */
const TO = Math.floor(COL.t / MIN) * MIN + 20 * MIN;
const FROM = TO - 20 * MIN;
const MISSING = FROM + 13 * MIN;
const raw = (skip: (t: number) => boolean) => {
  const out: { t: number; refUsd: number; bid: string; ask: string; height: number | null }[] = [];
  for (let t = FROM; t < TO; t += MIN) if (!skip(t)) out.push({ t, refUsd: COL.refUsd, bid: COL.bid, ask: COL.ask, height: COL.height });
  return out;
};

describe('the stored column decoded', () => {
  it('112 bands a side, float32 as the Worker packs them; the bids rest under the reference and the asks above it', () => {
    const bid = unpackF32(COL.bid), ask = unpackF32(COL.ask);
    expect(bid.length).toBe(HEAT_BANDS);
    expect(ask.length).toBe(HEAT_BANDS);
    const [c] = decodeHeat([{ ...COL }]);
    expect(c.refUsd).toBe(COL.refUsd);
    expect(c.bid[0]).toBeCloseTo(bid[0], 6);
    // the band holding the reference price: the first whose ceiling is above 1
    const k = bandAt(c, c.refUsd);
    expect(k).not.toBeNull();
    expect(HEAT_EDGES[k!]).toBeLessThanOrEqual(1);
    expect(HEAT_EDGES[k! + 1]).toBeGreaterThan(1);
    // under the reference the bands are bids, above it asks; both sides hold something on the fixture
    expect(bandValue(c, 0).side).toBe('bid');
    expect(bandValue(c, HEAT_BANDS - 1).side).toBe('ask');
    expect(bandValue(c, 0).usd).toBeGreaterThan(0);
    expect(bandValue(c, HEAT_BANDS - 1).usd).toBeGreaterThan(0);
    // the band straddling the reference (no edge falls on 1) holds bids under it and asks above it: both, summed, each side kept
    const both = bandValue(c, k!);
    expect(both.side).toBe('both');
    expect(both.bid).toBeGreaterThan(0);
    expect(both.ask).toBeGreaterThan(0);
    expect(both.usd).toBeCloseTo(both.bid + both.ask, 9);
    expect(both.bid).toBeCloseTo(bid[k!], 6);
    expect(both.ask).toBeCloseTo(ask[k!], 6);
    expect(bandValue(c, 0)).toMatchObject({ side: 'bid', ask: 0 });
    expect(bandValue(c, HEAT_BANDS - 1)).toMatchObject({ side: 'ask', bid: 0 });
    // on the fixtures an ask rests under the reference pool's price too (the spread is crossed across pools), and it is kept
    expect(bandValue(c, k! - 1).ask).toBeGreaterThan(0);
    expect(bandValue(c, k! - 1).side).toBe('both');
    // nothing resting is dropped: the bands' figures sum to both sides' totals
    let sum = 0;
    for (let i = 0; i < HEAT_BANDS; i++) sum += bandValue(c, i).usd;
    expect(sum).toBeCloseTo(bid.reduce((a, b) => a + b, 0) + ask.reduce((a, b) => a + b, 0), 3);
    // a price outside the bands is no band
    expect(bandAt(c, c.refUsd * 0.2)).toBeNull();
    expect(bandAt(c, c.refUsd * 5)).toBeNull();
    // the index is exact at every edge
    for (let i = 0; i < HEAT_BANDS; i++) expect(bandAt(c, c.refUsd * HEAT_EDGES[i] * 1.000001)).toBe(i);
    const span = heatPriceSpan([c])!;
    expect(span.lo).toBeCloseTo(c.refUsd * HEAT_EDGES[0], 12);
    expect(span.hi).toBeCloseTo(c.refUsd * HEAT_EDGES[HEAT_BANDS], 12);
  });
});

describe('a missing minute: a blank column and a broken hairline, never one path', () => {
  it('the slot of the missing minute is null, every other slot holds its column, and the hairline is two runs around it', () => {
    const cols = decodeHeat(raw((t) => t === MISSING));
    expect(cols).toHaveLength(19);
    const slots = slotColumns(cols, MIN, FROM, TO);
    expect(slots).toHaveLength(20);
    expect(slots[13]).toBeNull();
    expect(slots.filter((s) => s == null)).toHaveLength(1);
    expect(slots[12]!.t).toBe(MISSING - MIN);
    expect(slots[14]!.t).toBe(MISSING + MIN);
    const runs = hairlineRuns(cols, MIN, FROM, TO);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toHaveLength(13);
    expect(runs[1]).toHaveLength(6);
    // the break is at the missing minute: the first run ends before it, the second starts after it
    expect(runs[0][runs[0].length - 1].t).toBeLessThan(MISSING);
    expect(runs[1][0].t).toBeGreaterThan(MISSING + MIN - 1);
    // and with no minute missing, one run over every slot
    expect(hairlineRuns(decodeHeat(raw(() => false)), MIN, FROM, TO)).toHaveLength(1);
    // each point of a run is at its column's own stored time, never the slot's start or middle: a window that begins
    // twenty-seven seconds past the minute (the route's `to` is whatever millisecond was asked) keeps the columns where they are
    const off = 27_000;
    const shifted = hairlineRuns(cols, MIN, FROM + off, TO + off);
    expect(shifted).toHaveLength(2);
    for (const run of shifted) for (const q of run) { expect(q.t % MIN).toBe(0); expect(cols.some((c) => c.t === q.t)).toBe(true); }
    expect(shifted.flat().map((q) => q.t)).toEqual(cols.map((c) => c.t).filter((t) => t >= FROM + off));
    // on hourly columns the offset can reach almost an hour, and the point still carries the hour itself
    const H = 3_600_000, h0 = Math.ceil(TO / H) * H;
    const hours = decodeHeat([0, 1, 2].map((i) => ({ t: h0 + i * H, refUsd: COL.refUsd, bid: COL.bid, ask: COL.ask, height: COL.height })));
    const hr = hairlineRuns(hours, H, h0 - 59 * MIN, h0 + 3 * H - 59 * MIN);
    expect(hr).toHaveLength(1);
    expect(hr[0].map((q) => q.t)).toEqual([h0, h0 + H, h0 + 2 * H]);
  });
  it('a twenty-minute outage inside a day is one blank stretch of twenty slots; the window keeps its slot count', () => {
    const DAY_TO = TO, DAY_FROM = TO - 1440 * MIN;
    const OUT = DAY_TO - 600 * MIN;
    const cols: { t: number; refUsd: number; bid: string; ask: string; height: number | null }[] = [];
    for (let t = DAY_FROM; t < DAY_TO; t += MIN) if (!(t >= OUT && t < OUT + 20 * MIN)) cols.push({ t, refUsd: COL.refUsd, bid: COL.bid, ask: COL.ask, height: COL.height });
    const slots = slotColumns(decodeHeat(cols), MIN, DAY_FROM, DAY_TO);
    expect(slots).toHaveLength(1440);
    expect(slots.filter((s) => s == null)).toHaveLength(20);
    expect(hairlineRuns(decodeHeat(cols), MIN, DAY_FROM, DAY_TO)).toHaveLength(2);
  });
  it('five-minute columns (the phone’s day, the Worker’s week): a column is placed by the slot its minute falls in, the last of each five kept, and a five with nothing stored stays blank', () => {
    const cols = decodeHeat(raw((t) => t === MISSING));
    const slots = slotColumns(cols, 5 * MIN, FROM, TO);
    expect(slots).toHaveLength(4);
    // the fourteenth minute (index 13) is in the third five (minutes 10 to 14); the five's last stored minute is minute 14, the one after it
    expect(slots[2]!.t).toBe(MISSING + MIN);
    expect(slots[3]!.t).toBe(TO - MIN);
    // the Worker's week read keeps minute four of each five: with those alone, a five whose fourth minute failed is blank
    const fours = decodeHeat(raw((t) => (t - FROM) % (5 * MIN) !== 4 * MIN || t === FROM + 14 * MIN));
    const s5 = slotColumns(fours, 5 * MIN, FROM, TO);
    expect(s5[2]).toBeNull();
    expect(s5.filter((s) => s != null)).toHaveLength(3);
    expect(hairlineRuns(fours, 5 * MIN, FROM, TO)).toHaveLength(2);
  });
  it('the executable line breaks at the missing minute at every width: two runs at full resolution, and the bucket holding the missing minute is blank when the minutes are bucketed to pixels, however wide the bucket', () => {
    const points: LinePoint[] = [];
    for (let t = FROM; t < TO; t += MIN) points.push({ t, v: t === MISSING ? null : 9.92 + (t - FROM) / (100 * MIN) });
    const full = lineRuns(points, FROM, TO, 1000);
    expect(full).toHaveLength(2);
    expect(full[0]).toHaveLength(13);
    expect(full[1]).toHaveLength(6);
    // ten buckets over twenty minutes: the missing minute's bucket (minutes 12 and 13) holds minute 12 too, and is blank all the same;
    // five buckets of four minutes: the bucket of minutes 12 to 15 holds minutes 12, 14 and 15 and is blank, so the gap is drawn at every width
    expect(bucketLine(points, FROM, TO, 10)[6].v).toBeNull();
    expect(bucketLine(points, FROM, TO, 10).filter((p) => p.v == null)).toHaveLength(1);
    expect(lineRuns(points, FROM, TO, 10)).toHaveLength(2);
    expect(bucketLine(points, FROM, TO, 5)[3].v).toBeNull();
    expect(lineRuns(points, FROM, TO, 5)).toHaveLength(2);
    // the steps before the first stored minute and after the last are not gaps: a series that begins late and whose newest minutes are not yet written keeps its ends
    const late = points.map((p) => (p.t < FROM + 3 * MIN || p.t >= TO - MIN ? { t: p.t, v: null } : p));
    const lb = bucketLine(late, FROM, TO, 10);
    expect(lb[0].v).toBeNull(); // minutes 0 and 1: nothing stored
    expect(lb[1].v).not.toBeNull(); // minute 2 is before the first stored minute, so the bucket of minutes 2 and 3 is not a gap
    expect(lb[9].v).not.toBeNull(); // minute 19 is after the last stored minute (not yet due), so the bucket of 18 and 19 is not a gap
    expect(lb.filter((p) => p.v == null)).toHaveLength(2); // the first bucket and the missing minute's
    expect(lineRuns(late, FROM, TO, 10)).toHaveLength(2);
    // a stretch longer than a bucket is a gap at any width: minutes 8 to 15 missing, four buckets of five minutes (the stretch touches three of them: every bucket holding a missing minute is blank)
    const wide = points.map((p) => (p.t >= FROM + 8 * MIN && p.t < FROM + 16 * MIN ? { t: p.t, v: null } : p));
    expect(runsOf(wide, MIN * 1.5)).toHaveLength(2);
    const b = bucketLine(wide, FROM, TO, 4);
    expect(b).toHaveLength(4);
    expect(b.map((p) => p.v == null)).toEqual([false, true, true, true]);
    expect(lineRuns(wide, FROM, TO, 4)).toHaveLength(1);
    // eight buckets of two and a half minutes: the stretch covers buckets 3 to 6, and the line is two runs around it
    expect(bucketLine(wide, FROM, TO, 8).map((p) => p.v == null)).toEqual([false, false, false, true, true, true, true, false]);
    expect(lineRuns(wide, FROM, TO, 8)).toHaveLength(2);
    // a twenty-minute outage inside a week at 154 buckets (375 px wide: a bucket is 65 minutes) is still a gap
    const WEEK = 7 * 1440 * MIN, OUT = TO - 3 * 1440 * MIN;
    const week: LinePoint[] = [];
    for (let t = TO - WEEK; t < TO; t += MIN) week.push({ t, v: t >= OUT && t < OUT + 20 * MIN ? null : 9.92 });
    const wk = bucketLine(week, TO - WEEK, TO, 154);
    expect(wk.filter((p) => p.v == null).length).toBeGreaterThanOrEqual(1);
    expect(wk.filter((p) => p.v == null).length).toBeLessThanOrEqual(2);
    expect(lineRuns(week, TO - WEEK, TO, 154)).toHaveLength(2);
    // runsOf never joins across a null and never thins one away
    expect(runsOf([{ t: 1, v: 1 }, { t: 2, v: null }, { t: 3, v: 1 }], 10)).toHaveLength(2);
    expect(runsOf([{ t: 1, v: 1 }, { t: 2, v: 1 }, { t: 30, v: 1 }], 10)).toHaveLength(2);
  });
  it('the hour band is read off the minutes present: an hour with no minute has no band', () => {
    const H = 3_600_000;
    const h0 = Math.floor(FROM / H) * H;
    const pts: LinePoint[] = [{ t: h0, v: 9.9 }, { t: h0 + MIN, v: 9.8 }, { t: h0 + 2 * MIN, v: null }, { t: h0 + 2 * H, v: 10 }];
    expect(bandOf(pts, H)).toEqual([{ t: h0, lo: 9.8, hi: 9.9 }, { t: h0 + 2 * H, lo: 10, hi: 10 }]);
  });
});

describe('the ramp: five steps from the window’s own largest band, a band under the floor blank', () => {
  it('the six edges rise by one ratio from max / HEAT_SPAN to max; a figure under the floor is no step', () => {
    const [c] = decodeHeat([{ ...COL }]);
    const max = heatMax([c]);
    expect(max).toBeGreaterThan(0);
    const edges = heatStepEdges(max)!;
    expect(edges).toHaveLength(HEAT_STEPS + 1);
    expect(edges[HEAT_STEPS]).toBeCloseTo(max, 9);
    expect(edges[0]).toBeCloseTo(max / HEAT_SPAN, 9);
    for (let i = 1; i <= HEAT_STEPS; i++) expect(edges[i] / edges[i - 1]).toBeCloseTo(HEAT_SPAN ** (1 / HEAT_STEPS), 9);
    expect(heatStepOf(max, edges)).toBe(HEAT_STEPS - 1);
    expect(heatStepOf(edges[0], edges)).toBe(0);
    expect(heatStepOf(edges[0] * 0.999, edges)).toBeNull();
    expect(heatStepOf(0, edges)).toBeNull();
    expect(heatStepEdges(0)).toBeNull();
    // the fixture's bands reach the top step; every band of this column holds more than its floor (the thousandth of the largest), so none is blank
    const steps = new Set<number | null>();
    for (let k = 0; k < HEAT_BANDS; k++) steps.add(heatStepOf(bandValue(c, k).usd, edges));
    expect(steps.has(HEAT_STEPS - 1)).toBe(true);
    expect(steps.size).toBeGreaterThanOrEqual(3);
    expect(steps.has(null)).toBe(false);
    // a second column holding a tenth of the first makes the window's scale the first's, and that column's faint bands fall under the floor
    const faint = { ...c, bid: c.bid.map((v) => v / 2000), ask: c.ask.map((v) => v / 2000) };
    const e2 = heatStepEdges(heatMax([c, faint]))!;
    expect(e2[HEAT_STEPS]).toBeCloseTo(max, 9);
    expect(heatStepOf(bandValue(faint, 0).usd, e2)).toBeNull();
  });
});
