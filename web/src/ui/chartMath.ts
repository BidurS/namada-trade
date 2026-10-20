// Pure chart helpers (no React, no DOM): unit-tested in test/ui-curve.test.ts.

/** Decimal places of a 1-2-5 step (0.0002 → 4, 10 → 0). */
export function stepDecimals(step: number): number {
  if (!(step > 0) || !Number.isFinite(step)) return 0;
  return Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
}

/**
 * 1-2-5 ticks covering [min, max] with at most `maxTicks` ticks (default 5) and, when the data
 * allows, at least 4. A flat series gets a band around its value. `zero` forces 0 as the floor.
 */
export function niceTicks(min: number, max: number, opts: { maxTicks?: number; zero?: boolean } = {}): { ticks: number[]; step: number; lo: number; hi: number } {
  const maxTicks = opts.maxTicks ?? 5;
  let a = Math.min(min, max);
  let b = Math.max(min, max);
  if (opts.zero) a = Math.min(0, a);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return { ticks: [0, 1], step: 1, lo: 0, hi: 1 };
  if (a === b) {
    const pad = a === 0 ? 1 : Math.abs(a) * 0.05;
    a -= opts.zero && a - pad < 0 ? a : pad;
    b += pad;
  }
  const span = b - a;
  const base = 10 ** Math.floor(Math.log10(span / maxTicks));
  const cands = [1, 2, 5, 10, 20, 50].map((m) => m * base);
  let step = cands[cands.length - 1];
  for (const s of cands) {
    const n = Math.ceil(b / s - 1e-9) - Math.floor(a / s + 1e-9) + 1;
    if (n <= maxTicks) {
      step = s;
      break;
    }
  }
  const d = stepDecimals(step) + 2;
  const lo = Number((Math.floor(a / step + 1e-9) * step).toFixed(d));
  const hi = Number((Math.ceil(b / step - 1e-9) * step).toFixed(d));
  const ticks: number[] = [];
  for (let v = lo, i = 0; v <= hi + step / 2 && i < 50; v += step, i++) ticks.push(Number(v.toFixed(d)));
  return { ticks, step, lo, hi };
}

/** Tick label with the step's decimals ("0.0004", "10%"). */
export const tickLabel = (v: number, step: number, suffix = ''): string => `${v.toFixed(stepDecimals(step))}${suffix}`;

/** Linear map. */
export const lin = (d0: number, d1: number, r0: number, r1: number) => (v: number) => (d1 === d0 ? (r0 + r1) / 2 : r0 + ((v - d0) / (d1 - d0)) * (r1 - r0));

/** Index of the point whose x is nearest to `x` (points sorted by x). */
export function nearestIndex(xs: number[], x: number): number {
  if (!xs.length) return -1;
  let lo = 0;
  let hi = xs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid;
    else hi = mid;
  }
  return Math.abs(xs[lo] - x) <= Math.abs(xs[hi] - x) ? lo : hi;
}

/** SVG path through points; one point gives no path (draw dots, not a trend). */
export function pathOf(pts: [number, number][]): string {
  if (pts.length < 2) return '';
  return pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join('');
}

/**
 * Places labels (≤ 12 characters, 11 px mono ≈ 6.6 px a character) in rows so none overlap.
 * Returns the row index for each label, in input order.
 */
export function stackLabels(items: { x: number; text: string }[], charW = 6.6, gap = 8): number[] {
  const rows: [number, number][][] = [];
  return items.map(({ x, text }) => {
    const w = text.length * charW;
    const span: [number, number] = [x, x + 4 + w];
    for (let r = 0; ; r++) {
      rows[r] ??= [];
      if (rows[r].every(([a, b]) => span[1] + gap <= a || span[0] >= b + gap)) {
        rows[r].push(span);
        return r;
      }
      if (r > 6) return r;
    }
  });
}

/** A takeaway calls a change smaller than this percent "less than" it rather than up or down. */
export const FLAT_PCT = 0.05;

/**
 * The chart's takeaway title: "Executed price up 72% since 18 Sep". Whole percent from 10 %
 * up, one decimal below; under FLAT_PCT it says "changed less than FLAT_PCT%". Needs two points; otherwise null.
 */
export function takeaway(first: number | null | undefined, last: number | null | undefined, sinceLabel: string, what = 'Executed price'): string | null {
  if (first == null || last == null || !(first > 0) || !Number.isFinite(last)) return null;
  const pct = ((last - first) / first) * 100;
  const a = Math.abs(pct);
  // the cut is said in the title, so a small change on a narrow axis is never called "flat" without its rule
  if (a < FLAT_PCT) return `${what} changed less than ${FLAT_PCT}% since ${sinceLabel}`;
  const n = a >= 10 ? Math.round(a).toString() : (Math.round(a * 10) / 10).toString();
  return `${what} ${pct > 0 ? 'up' : 'down'} ${n}% since ${sinceLabel}`;
}

/** Count of distinct hours with at least one point. */
export const hoursWithData = (ts: number[]): number => new Set(ts.map((t) => Math.floor(t / 3_600_000))).size;
