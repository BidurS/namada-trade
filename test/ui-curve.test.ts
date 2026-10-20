// OrderSizeCurve and chart math (web/src/ui/curveMath.ts, chartMath.ts). The rules from
// system.md 7.2: at a quoted size the readout equals the quote exactly; between two sizes it is
// an estimate on a straight line between those two quotes, naming them; outside the range "—".
import { describe, it, expect } from 'vitest';
import { curveAt, fromApi, normalise, sliderToSize, sizeToSlider, logPos, SNAP, SLIDER_MAX, type CurveQuote } from '../web/src/ui/curveMath';
import { niceTicks, stepDecimals, tickLabel, nearestIndex, pathOf, stackLabels, takeaway, hoursWithData } from '../web/src/ui/chartMath';
import type { SlippageCurvePoint } from '../shared/types';

// shape of /api/quote/curve rows (values are arbitrary test inputs, not shown anywhere)
const api: SlippageCurvePoint[] = [
  { amountNam: 1000, usdSize: 1.0254, buyImpactPct: 3.143, sellImpactPct: 0.4609, buyEffectiveUsd: null, sellEffectiveUsd: null, sellOutUsdc: 1.019668, buyInUsdc: 1.025415 },
  { amountNam: 5000, usdSize: 5.1271, buyImpactPct: 5.5959, sellImpactPct: 1.4908, buyEffectiveUsd: null, sellEffectiveUsd: null, sellOutUsdc: 5.045588, buyInUsdc: 5.127073 },
  { amountNam: 10000, usdSize: 10.2541, buyImpactPct: 9.1087, sellImpactPct: 2.7486, buyEffectiveUsd: null, sellEffectiveUsd: null, sellOutUsdc: 9.962327, buyInUsdc: 10.254146 },
  { amountNam: 25000, usdSize: 25.6354, buyImpactPct: 20.4881, sellImpactPct: 6.3365, buyEffectiveUsd: null, sellEffectiveUsd: null, sellOutUsdc: 23.986977, buyInUsdc: 25.635366 },
  { amountNam: 50000, usdSize: 51.2707, buyImpactPct: 28.1473, sellImpactPct: 12.3412, buyEffectiveUsd: null, sellEffectiveUsd: null, sellOutUsdc: 44.898364, buyInUsdc: 51.270732 },
  { amountNam: 100000, usdSize: 102.5415, buyImpactPct: 32.7882, sellImpactPct: 26.2738, buyEffectiveUsd: null, sellEffectiveUsd: null, sellOutUsdc: 75.524291, buyInUsdc: 102.541464 },
];
const P: CurveQuote[] = api.map(fromApi);
const sizes = P.map((p) => p.n);

describe('curveAt', () => {
  it('at every quoted size the readout IS the quote (same object, exact values)', () => {
    for (const q of P) {
      const r = curveAt(P, q.n);
      expect(r.kind).toBe('quote');
      if (r.kind !== 'quote') continue;
      expect(r.q).toBe(q);
      expect(r.q.sellOut).toBe(api.find((a) => a.amountNam === q.n)!.sellOutUsdc);
      expect(r.q.sellMove).toBe(api.find((a) => a.amountNam === q.n)!.sellImpactPct);
    }
  });
  it('between two sizes: an estimate on the straight line between those two quotes, naming both', () => {
    const r = curveAt(P, 7500);
    expect(r.kind).toBe('estimate');
    if (r.kind !== 'estimate') return;
    expect(r.a.n).toBe(5000);
    expect(r.b.n).toBe(10000);
    const t = (7500 - 5000) / (10000 - 5000);
    expect(r.v.sellOut).toBeCloseTo(5.045588 + (9.962327 - 5.045588) * t, 12);
    expect(r.v.sellMove).toBeCloseTo(1.4908 + (2.7486 - 1.4908) * t, 12);
    expect(r.v.buyIn).toBeCloseTo(5.127073 + (10.254146 - 5.127073) * t, 12);
    expect(r.v.worth).toBeCloseTo(5.1271 + (10.2541 - 5.1271) * t, 12);
  });
  it('the estimate never leaves the two quotes it is drawn between', () => {
    for (let n = 1001; n < 100000; n += 997) {
      const r = curveAt(P, n);
      if (r.kind !== 'estimate') continue;
      const lo = Math.min(r.a.sellOut!, r.b.sellOut!);
      const hi = Math.max(r.a.sellOut!, r.b.sellOut!);
      expect(r.v.sellOut!).toBeGreaterThanOrEqual(lo);
      expect(r.v.sellOut!).toBeLessThanOrEqual(hi);
    }
  });
  it('outside the quoted range it will not guess', () => {
    expect(curveAt(P, 999).kind).toBe('out');
    expect(curveAt(P, 100001).kind).toBe('out');
    expect(curveAt(P, 500).kind).toBe('out');
    const r = curveAt(P, 200000);
    expect(r).toEqual({ kind: 'out', n: 200000, lo: 1000, hi: 100000 });
    expect(curveAt([], 5000).kind).toBe('out');
  });
  it('missing sides stay missing in an estimate (no stand-in)', () => {
    const Q = P.map((p) => (p.n === 10000 ? { ...p, buyIn: null } : p));
    const r = curveAt(Q, 7500);
    expect(r.kind).toBe('estimate');
    if (r.kind === 'estimate') expect(r.v.buyIn).toBeNull();
  });
  it('normalises order and duplicates', () => {
    expect(normalise([P[2], P[0], P[1], P[0]]).map((p) => p.n)).toEqual([1000, 5000, 10000]);
  });
  it('reads magnitudes from the API (the readout carries the sign)', () => {
    expect(fromApi({ ...api[0], sellImpactPct: -0.46 }).sellMove).toBe(0.46);
  });
});

describe('slider (log scale, snapping)', () => {
  it('maps the ends to the smallest and largest quote', () => {
    expect(sliderToSize(0, sizes)).toBe(1000);
    expect(sliderToSize(SLIDER_MAX, sizes)).toBe(100000);
    expect(logPos(10000, 1000, 100000)).toBeCloseTo(0.5, 12);
    expect(sizeToSlider(10000, 1000, 100000)).toBe(500);
  });
  it('snaps to a real quote within the snap distance', () => {
    for (const n of sizes) {
      const exact = logPos(n, 1000, 100000) * SLIDER_MAX;
      expect(sliderToSize(sizeToSlider(n, 1000, 100000), sizes)).toBe(n);
      expect(sliderToSize(Math.min(SLIDER_MAX, Math.floor(exact + SNAP)), sizes)).toBe(n);
      expect(sliderToSize(Math.max(0, Math.ceil(exact - SNAP)), sizes)).toBe(n);
    }
  });
  it('between snaps it gives a rounded size inside the range', () => {
    const n = sliderToSize(420, sizes);
    expect(sizes).not.toContain(n);
    expect(n).toBeGreaterThan(5000);
    expect(n).toBeLessThan(10000);
    expect(n % 10).toBe(0);
    expect(curveAt(P, n).kind).toBe('estimate');
  });
});

describe('chart ticks (1-2-5, 4 to 5 on y)', () => {
  it('price axis', () => {
    const t = niceTicks(0.000589, 0.00111);
    expect(t.ticks).toEqual([0.0004, 0.0006, 0.0008, 0.001, 0.0012]);
    expect(tickLabel(0.001, t.step)).toBe('0.0010');
  });
  it('a tight 24 h window', () => {
    const t = niceTicks(0.001012, 0.0010212);
    expect(t.ticks.length).toBeGreaterThanOrEqual(3);
    expect(t.ticks.length).toBeLessThanOrEqual(5);
    expect(stepDecimals(t.step)).toBe(6);
    const m = t.step / 10 ** Math.floor(Math.log10(t.step));
    expect([1, 2, 5]).toContain(Math.round(m));
  });
  it('percent axis from zero', () => {
    expect(niceTicks(0, 32.79 * 1.02, { zero: true }).ticks).toEqual([0, 10, 20, 30, 40]);
  });
  it('every step is 1, 2 or 5 times a power of ten and the ticks cover the data', () => {
    for (const [a, b] of [[3, 97], [0.12, 0.13], [1e6, 3.4e8], [-5, 5], [7, 7]]) {
      const t = niceTicks(a, b);
      const m = t.step / 10 ** Math.floor(Math.log10(t.step));
      expect([1, 2, 5, 10]).toContain(Math.round(m));
      expect(t.ticks.length).toBeLessThanOrEqual(5);
      expect(t.lo).toBeLessThanOrEqual(Math.min(a, b));
      expect(t.hi).toBeGreaterThanOrEqual(Math.max(a, b));
    }
  });
});

describe('chart helpers', () => {
  it('nearest point', () => {
    expect(nearestIndex([10, 20, 30], 24)).toBe(1);
    expect(nearestIndex([10, 20, 30], 26)).toBe(2);
    expect(nearestIndex([], 5)).toBe(-1);
  });
  it('two points or fewer: no path (dots, not a trend)', () => {
    expect(pathOf([[0, 0]])).toBe('');
    expect(pathOf([[0, 0], [10, 5]])).toBe('M0.0 0.0L10.0 5.0');
  });
  it('event labels never overlap', () => {
    expect(stackLabels([{ x: 70, text: '+35.7%' }, { x: 210, text: '+21.2%' }, { x: 165, text: '+20.8%' }])).toEqual([0, 0, 1]);
  });
  it('the takeaway title', () => {
    expect(takeaway(0.000589, 0.001012, '18 Sep')).toBe('Executed price up 72% since 18 Sep');
    expect(takeaway(0.0010212, 0.001012, '16 Oct')).toBe('Executed price down 0.9% since 16 Oct');
    expect(takeaway(1, 1, '1 Oct')).toBe('Executed price flat since 1 Oct');
    expect(takeaway(null, 1, 'x')).toBeNull();
  });
  it('counts hours with data', () => {
    const h = 3_600_000;
    expect(hoursWithData([0, 10, h + 1, 5 * h])).toBe(3);
  });
});
