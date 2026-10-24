// The picture of the digest's "Trades worth attention" section: the Osmosis quote over the window as a line, with
// each trade as a disc at its own time and its own settle price (never the quote), bought and sold in the site's two
// hues, the largest trades ringed in the site's accent. Drawn by hand into an RGBA buffer (no canvas, no fonts, no
// text: the embed's words carry the legend and every value) and written as a PNG whose one IDAT is deflated by the
// platform's CompressionStream, so it runs in a Worker and in Node alike. A pure function of its input: the same
// rows give the same pixels on every runtime (the deflate bytes may differ by runtime; the pixels do not).
//
// The hues are the site's tokens (web/src/styles/tokens.css), copied because the Worker does not read CSS:
// --bg #000000 (the surface), --line #242424 (hairline grid), --ink-2 #a8a8a8 (the quote line), --buy #3987e5,
// --sell #d95926, --accent #ffff00 (the ring on the largest trades). Checked with the dataviz palette validator on
// #000000: lightness band, chroma, colour-vision ΔE 26.8, normal-vision ΔE 31.8, contrast at least 3:1.
//
// The price axis is fitted to the quote and to the trades of at least DIGEST_ATTN_AXIS_MIN_NAM: a trade of a few NAM
// settled with its gas in can sit far off the market and would squash the line flat. Such a small trade outside the
// fitted axis is not drawn, and the picture counts it so the words can say so. The grid's step is a round 1-2-5 step
// sized to the axis (the site's niceTicks), a handful of lines whatever the range.
import { niceTicks } from '../../../../web/src/ui/chartMath';

/** One stored reading of the quote (metrics price.usd). */
export interface PicturePoint { ts: number; value: number }
/** One trade to draw: its time, side, NAM and the price it is placed at (its settle price, else its own recorded price). */
export interface PictureTrade { ts: number; kind: 'buy' | 'sell'; nam: number; price: number }

export interface AttentionPicture {
  /** the PNG file */
  png: Uint8Array;
  width: number;
  height: number;
  /** how many of the largest trades carry the accent ring (0 when ringsOff) */
  ringed: number;
  /** more than DIGEST_ATTN_PNG_RING_MAX trades: discs without rings, and the legend says so */
  ringsOff: boolean;
  /** the y axis spans the quotes and the prices of the trades of at least DIGEST_ATTN_AXIS_MIN_NAM */
  yMin: number;
  yMax: number;
  quotes: number;
  /** the trades drawn */
  trades: number;
  /** trades under DIGEST_ATTN_AXIS_MIN_NAM whose price falls outside the axis: not drawn */
  offAxis: number;
}

export const DIGEST_ATTN_PNG = { w: 1200, h: 420 } as const;
/** A picture larger than this is not attached (Discord takes 8 MB; the digest keeps far under it). */
export const DIGEST_ATTN_PNG_MAX_BYTES = 1024 * 1024;
/** Past this many trades the discs are drawn without their rings. */
export const DIGEST_ATTN_PNG_RING_MAX = 2000;
/** The largest trades that get the accent ring. */
export const DIGEST_ATTN_PNG_RINGED = 3;
/** A gap between two quote readings longer than this is left open in the line. */
export const DIGEST_ATTN_PNG_GAP_MS = 10 * 60_000;
/** Trades of at least this many NAM set the price axis with the quote (the trade index's own floor for a trusted
 *  trade); a smaller one outside that axis is not drawn. */
export const DIGEST_ATTN_AXIS_MIN_NAM = 50;
/** The grid's horizontal lines: at most this many round steps over the axis. */
export const DIGEST_ATTN_GRID_LINES = 5;

type RGB = readonly [number, number, number];
const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
export const PICTURE_COLOURS = {
  surface: hex('#000000'),
  grid: hex('#242424'),
  baseline: hex('#383835'),
  line: hex('#a8a8a8'),
  buy: hex('#3987e5'),
  sell: hex('#d95926'),
  mark: hex('#ffff00'),
} as const;

const PAD = { l: 24, r: 24, t: 24, b: 28 } as const;
const GRID_HOURS = 6;
const R_MIN = 5;
const R_MAX = 16;

/** The plot's frame: where a time and a price land, and a trade's radius, so a test can sample the pixels it expects. */
export function attentionFrame(series: readonly PicturePoint[], trades: readonly PictureTrade[], from: number, to: number) {
  const { w: W, h: H } = DIGEST_ATTN_PNG;
  // the axis: the quote and the trades of at least DIGEST_ATTN_AXIS_MIN_NAM (a dust trade's price never sets it)
  const ys = [...series.map((q) => q.value), ...trades.filter((t) => t.nam >= DIGEST_ATTN_AXIS_MIN_NAM).map((t) => t.price)].filter((v) => Number.isFinite(v));
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const span = yMax - yMin || yMin * 0.1 || 1;
  const lo = yMin - span * 0.12;
  const hi = yMax + span * 0.12;
  const maxNam = Math.max(0, ...trades.map((t) => t.nam));
  return {
    yMin,
    yMax,
    lo,
    hi,
    /** a trade drawn on this axis: any trade inside it, and every trade of at least DIGEST_ATTN_AXIS_MIN_NAM */
    onAxis: (t: PictureTrade) => t.nam >= DIGEST_ATTN_AXIS_MIN_NAM || (t.price >= lo && t.price <= hi),
    /** the grid's prices: a round step sized to the axis */
    grid: niceTicks(lo, hi, { maxTicks: DIGEST_ATTN_GRID_LINES }).ticks.filter((v) => v > lo && v < hi),
    x: (ts: number) => PAD.l + ((ts - from) / (to - from || 1)) * (W - PAD.l - PAD.r),
    y: (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b),
    r: (nam: number) => R_MIN + (R_MAX - R_MIN) * Math.sqrt(maxNam > 0 ? nam / maxNam : 0),
  };
}

/** The frame's pixels: RGBA, W × H × 4. Exported so a test can check the drawing without decoding a PNG. */
export function drawAttention(series: readonly PicturePoint[], trades: readonly PictureTrade[], from: number, to: number, opts: { ringsOff?: boolean } = {}): { px: Uint8Array; ringed: number; ringsOff: boolean; yMin: number; yMax: number; drawn: number; offAxis: number } {
  const { w: W, h: H } = DIGEST_ATTN_PNG;
  const px = new Uint8Array(W * H * 4);
  const put = (x: number, y: number, c: RGB, a = 1) => {
    if (x < 0 || y < 0 || x >= W || y >= H || a <= 0) return;
    const i = (y * W + x) * 4;
    if (a >= 1) { px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255; return; }
    px[i] = Math.round(px[i] * (1 - a) + c[0] * a);
    px[i + 1] = Math.round(px[i + 1] * (1 - a) + c[1] * a);
    px[i + 2] = Math.round(px[i + 2] * (1 - a) + c[2] * a);
    px[i + 3] = 255;
  };
  for (let i = 0; i < px.length; i += 4) { px[i] = PICTURE_COLOURS.surface[0]; px[i + 1] = PICTURE_COLOURS.surface[1]; px[i + 2] = PICTURE_COLOURS.surface[2]; px[i + 3] = 255; }

  const f = attentionFrame(series, trades, from, to);

  // the grid: a hairline at each round step of the axis and at a steady time step, one step off the surface
  for (const v of f.grid) {
    const y = Math.round(f.y(v));
    for (let x = PAD.l; x < W - PAD.r; x++) put(x, y, PICTURE_COLOURS.grid);
  }
  // every six hours over a day, every day over a longer window (a week's 28 six-hour lines would crowd the plot)
  const gridMs = (to - from > 2 * 86_400_000 ? 24 : GRID_HOURS) * 3600_000;
  for (let t = from; t <= to; t += gridMs) {
    const x = Math.round(f.x(t));
    for (let y = PAD.t; y < H - PAD.b; y++) put(x, y, PICTURE_COLOURS.grid);
  }
  for (let x = PAD.l; x < W - PAD.r; x++) put(x, H - PAD.b, PICTURE_COLOURS.baseline);

  // a stroke of width w between two points, with coverage by distance from the centre line
  const seg = (x0: number, y0: number, x1: number, y1: number, c: RGB, w: number) => {
    const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy) || 1;
    const minX = Math.floor(Math.min(x0, x1) - w), maxX = Math.ceil(Math.max(x0, x1) + w);
    const minY = Math.floor(Math.min(y0, y1) - w), maxY = Math.ceil(Math.max(y0, y1) + w);
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / (len * len)));
      const d = Math.hypot(x - (x0 + t * dx), y - (y0 + t * dy));
      const a = Math.max(0, Math.min(1, w / 2 + 0.5 - d));
      if (a > 0) put(x, y, c, a);
    }
  };
  // the quote line: consecutive readings joined, a gap longer than DIGEST_ATTN_PNG_GAP_MS left open
  for (let i = 1; i < series.length; i++) {
    if (series[i].ts - series[i - 1].ts > DIGEST_ATTN_PNG_GAP_MS) continue;
    seg(f.x(series[i - 1].ts), f.y(series[i - 1].value), f.x(series[i].ts), f.y(series[i].value), PICTURE_COLOURS.line, 2);
  }

  const disc = (cx: number, cy: number, r: number, c: RGB) => {
    for (let y = Math.floor(cy - r - 1); y <= Math.ceil(cy + r + 1); y++) for (let x = Math.floor(cx - r - 1); x <= Math.ceil(cx + r + 1); x++) {
      const a = Math.max(0, Math.min(1, r + 0.5 - Math.hypot(x - cx, y - cy)));
      if (a > 0) put(x, y, c, a);
    }
  };
  // the trades, largest first so a small one is never hidden under a large one; a surface ring keeps neighbours apart;
  // a small trade off the axis is left out (and counted)
  const onAxis = trades.filter(f.onAxis);
  const ranked = [...onAxis].sort((a, b) => b.nam - a.nam || a.ts - b.ts);
  // the caller says when the window held more trades than the renderer was given (the read's bound), so the rings go then too
  const ringsOff = !!opts.ringsOff || ranked.length > DIGEST_ATTN_PNG_RING_MAX;
  const ringed = ringsOff ? 0 : Math.min(DIGEST_ATTN_PNG_RINGED, ranked.length);
  ranked.forEach((t, i) => {
    const r = f.r(t.nam);
    const cx = f.x(t.ts), cy = f.y(t.price);
    if (!ringsOff && i < ringed) { disc(cx, cy, r + 4, PICTURE_COLOURS.mark); disc(cx, cy, r + 2, PICTURE_COLOURS.surface); }
    if (!ringsOff) disc(cx, cy, r + 2, PICTURE_COLOURS.surface);
    disc(cx, cy, r, t.kind === 'buy' ? PICTURE_COLOURS.buy : PICTURE_COLOURS.sell);
  });
  return { px, ringed, ringsOff, yMin: f.yMin, yMax: f.yMax, drawn: onAxis.length, offAxis: trades.length - onAxis.length };
}

// ---------------------------------------------------------------- PNG

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();

/** CRC-32 as PNG uses it, over bytes[start, end). */
export function crc32(b: Uint8Array, start = 0, end = b.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

/** zlib-framed deflate through the platform's CompressionStream (what an IDAT holds; 'deflate-raw' would not do). */
export async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const plain = new Uint8Array(new ArrayBuffer(data.byteLength));
  plain.set(data);
  const stream = new Blob([plain]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The PNG file for a W × H RGBA buffer: filter 0 on every scanline, one IDAT. */
export async function encodeRgbaPng(w: number, h: number, px: Uint8Array): Promise<Uint8Array> {
  if (px.length !== w * h * 4) throw new Error(`pixel buffer is ${px.length} bytes, expected ${w * h * 4}`);
  const stride = w * 4;
  const raw = new Uint8Array(h * (stride + 1));
  for (let y = 0; y < h; y++) { raw[y * (stride + 1)] = 0; raw.set(px.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1); }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  const idat = await deflate(raw);
  const parts = [PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** The chunks of a PNG file with their CRCs checked, for the tests. */
export function readPngChunks(png: Uint8Array): { type: string; data: Uint8Array }[] {
  for (let i = 0; i < 8; i++) if (png[i] !== PNG_SIGNATURE[i]) throw new Error('not a PNG');
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const out: { type: string; data: Uint8Array }[] = [];
  let o = 8;
  while (o < png.length) {
    const len = dv.getUint32(o);
    const type = String.fromCharCode(png[o + 4], png[o + 5], png[o + 6], png[o + 7]);
    if (dv.getUint32(o + 8 + len) !== crc32(png, o + 4, o + 8 + len)) throw new Error(`bad CRC on ${type}`);
    out.push({ type, data: png.subarray(o + 8, o + 8 + len) });
    o += 12 + len;
  }
  return out;
}

/**
 * The section's picture, or null when there is nothing to draw (no quote reading in the window), when the file would
 * be larger than DIGEST_ATTN_PNG_MAX_BYTES, or when anything throws: the section then goes without a picture and
 * without its legend sentence; the fields are unchanged. Trades without a price are not drawn.
 */
export async function renderAttentionPng(series: readonly PicturePoint[], trades: readonly PictureTrade[], from: number, to: number, opts: { ringsOff?: boolean } = {}): Promise<AttentionPicture | null> {
  try {
    const quotes = series.filter((q) => Number.isFinite(q.value) && q.value > 0);
    const drawn = trades.filter((t) => Number.isFinite(t.price) && t.price > 0 && Number.isFinite(t.nam) && t.nam > 0);
    if (!quotes.length) return null;
    const d = drawAttention(quotes, drawn, from, to, opts);
    const png = await encodeRgbaPng(DIGEST_ATTN_PNG.w, DIGEST_ATTN_PNG.h, d.px);
    if (png.length > DIGEST_ATTN_PNG_MAX_BYTES) return null;
    return { png, width: DIGEST_ATTN_PNG.w, height: DIGEST_ATTN_PNG.h, ringed: d.ringed, ringsOff: d.ringsOff, yMin: d.yMin, yMax: d.yMax, quotes: quotes.length, trades: d.drawn, offAxis: d.offAxis };
  } catch {
    return null;
  }
}
