// A pixel buffer and the few marks a digest chart needs: crisp rectangles and bars on whole pixels, anti-aliased
// lines of any width (round caps, optional dashes), filled dots, the last-value pill, and a 5 × 7 bitmap font for
// axis labels. No canvas, no system fonts, no dependencies: Uint8Array only, so it draws the same bytes in the
// Worker and in Node. RGB, three bytes a pixel, top-left origin.
//
// Anti-aliasing is by signed distance: a pixel's coverage by a stroke is clamp(halfWidth + 0.5 − distance, 0, 1),
// where distance is from the pixel's centre to the stroke's centre line (a segment, or a point for a dot). It is
// exact for a disc and within a pixel for a segment, costs one square root per pixel in the stroke's bounding box,
// and is deterministic: the same input gives the same bytes on every runtime, because every step is integer or
// IEEE double arithmetic in a fixed order.

export type RGB = readonly [number, number, number];

/** "#rrggbb" to RGB. */
export function hex(s: string): RGB {
  const n = parseInt(s.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** The colour `fg` at opacity `a` over `bg`, as one solid colour (a pre-mixed CSS color-mix). */
export function mix(fg: RGB, bg: RGB, a: number): RGB {
  return [Math.round(bg[0] + (fg[0] - bg[0]) * a), Math.round(bg[1] + (fg[1] - bg[1]) * a), Math.round(bg[2] + (fg[2] - bg[2]) * a)];
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export class Canvas {
  readonly w: number;
  readonly h: number;
  /** RGB rows, w × h × 3 bytes. */
  readonly px: Uint8Array;

  constructor(w: number, h: number, bg: RGB) {
    if (!(Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0)) throw new Error('canvas size must be positive integers');
    this.w = w;
    this.h = h;
    this.px = new Uint8Array(w * h * 3);
    for (let i = 0; i < this.px.length; i += 3) {
      this.px[i] = bg[0];
      this.px[i + 1] = bg[1];
      this.px[i + 2] = bg[2];
    }
  }

  /** Blends colour c at coverage a (0..1) into the pixel (x, y); outside the canvas nothing happens. */
  blend(x: number, y: number, c: RGB, a: number): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h || a <= 0) return;
    const i = (y * this.w + x) * 3;
    if (a >= 1) {
      this.px[i] = c[0];
      this.px[i + 1] = c[1];
      this.px[i + 2] = c[2];
      return;
    }
    const p = this.px;
    p[i] = Math.round(p[i] + (c[0] - p[i]) * a);
    p[i + 1] = Math.round(p[i + 1] + (c[1] - p[i + 1]) * a);
    p[i + 2] = Math.round(p[i + 2] + (c[2] - p[i + 2]) * a);
  }

  /** Reads one pixel. */
  at(x: number, y: number): RGB {
    const i = (y * this.w + x) * 3;
    return [this.px[i], this.px[i + 1], this.px[i + 2]];
  }

  /** A crisp rectangle on whole pixels: x, y, w, h are rounded and the edges never anti-aliased (bars, grid, text). */
  fillRect(x: number, y: number, w: number, h: number, c: RGB, a = 1): void {
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.w, Math.round(x + w));
    const y1 = Math.min(this.h, Math.round(y + h));
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) this.blend(xx, yy, c, a);
  }

  /** A one-pixel horizontal rule from x0 (inclusive) to x1 (exclusive) on row y. */
  hline(x0: number, x1: number, y: number, c: RGB, a = 1): void {
    this.fillRect(Math.min(x0, x1), y, Math.abs(x1 - x0), 1, c, a);
  }

  /** A one-pixel vertical rule on column x from y0 (inclusive) to y1 (exclusive). */
  vline(x: number, y0: number, y1: number, c: RGB, a = 1): void {
    this.fillRect(x, Math.min(y0, y1), 1, Math.abs(y1 - y0), c, a);
  }

  /** A dashed one-pixel vertical rule (on, off in pixels): the "series starts here" rule. */
  vdash(x: number, y0: number, y1: number, on: number, off: number, c: RGB, a = 1): void {
    const top = Math.min(y0, y1);
    const bot = Math.max(y0, y1);
    for (let y = top; y < bot; y += on + off) this.fillRect(x, y, 1, Math.min(on, bot - y), c, a);
  }

  /**
   * A crisp bar of width w at column x between the baseline row yBase and the value's row yValue: above the
   * baseline when yValue is smaller, below it when larger, and a one-pixel line just above the baseline when the
   * two round to the same row, so a bar is never invisible and its sign is read from its side of the baseline.
   * The baseline row itself is left for the chart's zero line.
   */
  bar(x: number, w: number, yBase: number, yValue: number, c: RGB): void {
    const y0 = Math.round(yBase);
    const yv = Math.round(yValue);
    if (yv === y0) this.fillRect(x, y0 - 1, w, 1, c);
    else if (yv < y0) this.fillRect(x, yv, w, y0 - yv, c);
    else this.fillRect(x, y0 + 1, w, yv - y0, c);
  }

  /**
   * An anti-aliased stroke from (x0, y0) to (x1, y1), `width` pixels wide with round caps. With `dash` = [on, off]
   * the stroke is cut into dashes along its length (each dash a capped segment).
   */
  line(x0: number, y0: number, x1: number, y1: number, width: number, c: RGB, a = 1, dash?: readonly [number, number]): void {
    if (!dash) {
      this.segment(x0, y0, x1, y1, width, c, a);
      return;
    }
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len === 0) return this.segment(x0, y0, x1, y1, width, c, a);
    const [on, off] = dash;
    for (let s = 0; s < len; s += on + off) {
      const e = Math.min(len, s + on);
      this.segment(x0 + (dx * s) / len, y0 + (dy * s) / len, x0 + (dx * e) / len, y0 + (dy * e) / len, width, c, a);
    }
  }

  private segment(x0: number, y0: number, x1: number, y1: number, width: number, c: RGB, a: number): void {
    const hw = width / 2;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const l2 = dx * dx + dy * dy;
    const bx0 = Math.max(0, Math.floor(Math.min(x0, x1) - hw - 1));
    const bx1 = Math.min(this.w - 1, Math.ceil(Math.max(x0, x1) + hw + 1));
    const by0 = Math.max(0, Math.floor(Math.min(y0, y1) - hw - 1));
    const by1 = Math.min(this.h - 1, Math.ceil(Math.max(y0, y1) + hw + 1));
    for (let y = by0; y <= by1; y++) {
      const py = y + 0.5;
      for (let x = bx0; x <= bx1; x++) {
        const px = x + 0.5;
        let t = l2 > 0 ? ((px - x0) * dx + (py - y0) * dy) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = px - (x0 + t * dx);
        const ey = py - (y0 + t * dy);
        const cov = clamp01(hw + 0.5 - Math.sqrt(ex * ex + ey * ey));
        if (cov > 0) this.blend(x, y, c, cov * a);
      }
    }
  }

  /** An anti-aliased filled disc of radius r at (cx, cy). */
  dot(cx: number, cy: number, r: number, c: RGB, a = 1): void {
    const bx0 = Math.max(0, Math.floor(cx - r - 1));
    const bx1 = Math.min(this.w - 1, Math.ceil(cx + r + 1));
    const by0 = Math.max(0, Math.floor(cy - r - 1));
    const by1 = Math.min(this.h - 1, Math.ceil(cy + r + 1));
    for (let y = by0; y <= by1; y++) {
      for (let x = bx0; x <= bx1; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        const cov = clamp01(r + 0.5 - d);
        if (cov > 0) this.blend(x, y, c, cov * a);
      }
    }
  }

  /** A pill (a rectangle with fully round ends) of height h at (x, y), width w: the last-value pill. */
  pill(x: number, y: number, w: number, h: number, c: RGB): void {
    const r = h / 2;
    this.line(x + r, y + r, x + w - r, y + r, h, c);
  }
}

// ----------------------------------------------------------------------------------------------- the bitmap font

// A 5 × 7 bitmap font for the few characters an axis label needs: digits, the signs and separators of a number
// ("-", "+", ".", ",", ":", "%", "$", "/"), the unit letters of a NAM tick ("k", "M", "B") and the letters of the
// twelve month abbreviations and of "UTC". Everything else in a digest (legends, sources, the as-of stamps) is text
// in the embed, where Discord's own font carries it. Each glyph is drawn as whole-pixel squares at an integer
// scale, so text is crisp and deterministic; a character the font lacks draws as a hollow box and is reported by
// missingGlyphs(), which the tests assert is empty for every label the charts produce.

export const GLYPH_W = 5;
export const GLYPH_H = 7;
/** Horizontal advance in cells (the glyph plus one empty column). */
export const ADVANCE = 6;

const GLYPHS: Record<string, string[]> = {
  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['#####', '...#.', '..#..', '...#.', '....#', '#...#', '.###.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
  ',': ['.....', '.....', '.....', '.....', '.##..', '..#..', '.#...'],
  '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
  '+': ['.....', '..#..', '..#..', '#####', '..#..', '..#..', '.....'],
  ':': ['.....', '.##..', '.##..', '.....', '.##..', '.##..', '.....'],
  '%': ['##..#', '##..#', '...#.', '..#..', '.#...', '#..##', '#..##'],
  $: ['..#..', '.####', '#.#..', '.###.', '..#.#', '####.', '..#..'],
  '/': ['....#', '...#.', '...#.', '..#..', '.#...', '.#...', '#....'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  a: ['.....', '.....', '.###.', '....#', '.####', '#...#', '.####'],
  b: ['#....', '#....', '####.', '#...#', '#...#', '#...#', '####.'],
  c: ['.....', '.....', '.###.', '#....', '#....', '#...#', '.###.'],
  d: ['....#', '....#', '.####', '#...#', '#...#', '#...#', '.####'],
  e: ['.....', '.....', '.###.', '#...#', '#####', '#....', '.###.'],
  g: ['.....', '.####', '#...#', '#...#', '.####', '....#', '.###.'],
  h: ['#....', '#....', '####.', '#...#', '#...#', '#...#', '#...#'],
  i: ['..#..', '.....', '.##..', '..#..', '..#..', '..#..', '.###.'],
  k: ['#....', '#....', '#..#.', '#.#..', '##...', '#.#..', '#..#.'],
  l: ['.##..', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  m: ['.....', '.....', '##.#.', '#.#.#', '#.#.#', '#...#', '#...#'],
  n: ['.....', '.....', '####.', '#...#', '#...#', '#...#', '#...#'],
  o: ['.....', '.....', '.###.', '#...#', '#...#', '#...#', '.###.'],
  p: ['.....', '.....', '####.', '#...#', '####.', '#....', '#....'],
  r: ['.....', '.....', '#.##.', '##..#', '#....', '#....', '#....'],
  s: ['.....', '.....', '.####', '#....', '.###.', '....#', '####.'],
  t: ['.#...', '.#...', '####.', '.#...', '.#...', '.#..#', '..##.'],
  u: ['.....', '.....', '#...#', '#...#', '#...#', '#..##', '.##.#'],
  v: ['.....', '.....', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  x: ['.....', '.....', '#...#', '.#.#.', '..#..', '.#.#.', '#...#'],
  y: ['.....', '.....', '#...#', '#...#', '.####', '....#', '.###.'],
};
const BOX = ['#####', '#...#', '#...#', '#...#', '#...#', '#...#', '#####'];

export const hasGlyph = (ch: string): boolean => Object.prototype.hasOwnProperty.call(GLYPHS, ch);

/** The characters of `s` the font cannot draw (each once, in order). */
export function missingGlyphs(s: string): string[] {
  const out: string[] = [];
  for (const ch of s) if (!hasGlyph(ch) && !out.includes(ch)) out.push(ch);
  return out;
}

/** Width in pixels of `s` at `scale` (no trailing gap). */
export function textWidth(s: string, scale: number): number {
  const n = [...s].length;
  return n === 0 ? 0 : (n * ADVANCE - 1) * scale;
}

export const textHeight = (scale: number): number => GLYPH_H * scale;

/**
 * Draws `s` with its top-left at (x, y) ('left'), its top-right at x ('right') or centred on x ('center'), each
 * glyph as whole-pixel squares of `scale` pixels. Returns the width drawn.
 */
export function drawText(cv: Canvas, x: number, y: number, s: string, scale: number, c: RGB, align: 'left' | 'right' | 'center' = 'left'): number {
  const w = textWidth(s, scale);
  let x0 = Math.round(align === 'right' ? x - w : align === 'center' ? x - w / 2 : x);
  const y0 = Math.round(y);
  for (const ch of s) {
    const g = GLYPHS[ch] ?? BOX;
    for (let r = 0; r < GLYPH_H; r++) {
      const row = g[r];
      for (let col = 0; col < GLYPH_W; col++) if (row[col] === '#') cv.fillRect(x0 + col * scale, y0 + r * scale, scale, scale, c);
    }
    x0 += ADVANCE * scale;
  }
  return w;
}
