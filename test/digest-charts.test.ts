// The digest chart renderer (worker/src/digest/charts): the pixel buffer and its font, the PNG encoder, the four
// charts and their weekly variants rendered from stored production rows (byte-identical on a second render, a valid
// PNG, under 100 KB, every label in the font), the gap rule checked on pixels, and the set builder's "left out when
// not read" rule. No database and no fetch: the fixtures in test/fixtures/digest-charts/ are the answers of
// read-only SELECTs on the production database on 2026-10-23 (wrangler d1 execute --remote --json --command),
// kept verbatim:
//   price_quote_1h     SELECT ts, value FROM metrics WHERE key='price.usd.1h' AND ts>=1792134000000 AND ts<=1792742400000 ORDER BY ts
//   price_exec_1h      SELECT key, ts, value FROM metrics WHERE key IN ('price.swap_1h','price.swap_1h.n') AND ts>=1792134000000 AND ts<=1792742400000 ORDER BY key, ts
//   stake_1h           SELECT ts, value FROM metrics WHERE key='supply.total_stake.1h' AND ts>=1790150400000 AND ts<=1792742400000 ORDER BY ts
//   stake_first        SELECT MIN(ts) first_ts FROM metrics WHERE key='supply.total_stake.1h'
//   flows_daily        SELECT key, ts, value FROM metrics WHERE key IN ('bridge.in_daily','bridge.out_daily','bridge.refunded_daily','masp.in_daily','masp.out_daily') AND ts>=1792108800000 AND ts<=1792627200000 ORDER BY key, ts
//   queue              SELECT withdraw_epoch, nam, n, listed_at, height FROM unbond_queue WHERE withdraw_epoch > 2690 ORDER BY withdraw_epoch
//   epoch_now          SELECT ts, value FROM metrics WHERE key='epoch' ORDER BY ts DESC LIMIT 1
//   epoch_anchor       SELECT value e, MIN(ts) started, COUNT(*) n FROM metrics WHERE key='epoch' AND ts > <read time − 2 epochs> AND ts <= <read time> GROUP BY value ORDER BY value
//   epoch_before       SELECT MAX(ts) before_ts FROM metrics WHERE key='epoch' AND ts < 1792769491995
//   chain_params       SELECT value, updated_at FROM kv WHERE key='chain.params'
//   bond_listing       SELECT json_extract(value,'$.completeAt') completeAt, json_extract(value,'$.height') height, … FROM kv WHERE key='bond.listing'
//   price_quote_1h_30d, price_exec_1h_30d, flows_daily_30d: the same statements over the 30-day windows (ts>=1790146800000; the days 23 Sep to 22 Oct)
//   price_first        SELECT MIN(ts) first_ts FROM metrics WHERE key='price.usd.1h'
// A = 2026-10-23T08:00:00Z is the spec's worked-example instant for the series charts; the unbond queue is current
// state, so the pipeline is drawn as the queue stood when it was read (16:20 UTC) on the anchor of epoch 2,698. The
// gap tests cut a stretch of hours out of the real rows: a gap is rows the store does not have.
import { describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Canvas, drawText, hasGlyph, hex, missingGlyphs, mix, textWidth } from '../worker/src/digest/charts/raster';
import { PNG_SIGNATURE, crc32, encodePng, filteredRows } from '../worker/src/digest/charts/png';
import {
  CHART_DAYS,
  CHART_H,
  CHART_W,
  DAY_MS,
  HOUR_MS,
  PNG_MAX_BYTES,
  SLOT_MARK,
  THEME,
  chartFileName,
  dayStart,
  emptySlots,
  epochClock,
  flowsChart,
  gapRuns,
  leftOutSentence,
  namTick,
  pipelineChart,
  priceChart,
  renderChartSet,
  rowsHash,
  runs,
  stakeChart,
  toPng,
  usdTick,
  type ChartPixels,
  type ChartSetInput,
  type FlowDay,
  type NotRead,
  type PipelineInput,
  type Point,
  type PriceInput,
  type StakeInput,
} from '../worker/src/digest/charts/charts';

// ------------------------------------------------------------------------------------------------ the stored rows

const dir = join(__dirname, 'fixtures', 'digest-charts');
const rows = <R>(name: string): R[] => (JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8')) as { results: R[] }[])[0].results;
interface MetricRow {
  ts: number;
  value: number;
}
interface KeyedRow extends MetricRow {
  key: string;
}

/** 2026-10-23T08:00:00Z, the worked example's instant. */
const A = Date.UTC(2026, 9, 23, 8);
/** When the queue was read (2026-10-23T16:20Z); the pipeline is drawn from the date of its read. */
const T_QUEUE = Date.UTC(2026, 9, 23, 16, 20);

const points = (rs: MetricRow[]): Point[] => rs.map((r) => ({ t: r.ts, v: r.value }));
/** price.swap_1h joined with price.swap_1h.n on the hour. */
const execPoints = (rs: KeyedRow[]): (Point & { n: number })[] => {
  const n = new Map(rs.filter((r) => r.key === 'price.swap_1h.n').map((r) => [r.ts, r.value]));
  return rs.filter((r) => r.key === 'price.swap_1h').map((r) => ({ t: r.ts, v: r.value, n: n.get(r.ts) ?? 0 }));
};
/** The day keys as nets: bridge.in_daily − bridge.out_daily and masp.in_daily − masp.out_daily; a day without both keys of a pair is null. */
const flowDays = (rs: KeyedRow[], lastDay: number, days: number): FlowDay[] => {
  const by = new Map(rs.map((r) => [`${r.key}@${r.ts}`, r.value]));
  const net = (a: string, b: string, t: number) => {
    const x = by.get(`${a}@${t}`);
    const y = by.get(`${b}@${t}`);
    return x != null && y != null ? x - y : null;
  };
  return Array.from({ length: days }, (_, i) => {
    const t = lastDay - (days - 1 - i) * DAY_MS;
    return { t, bridgeNet: net('bridge.in_daily', 'bridge.out_daily', t), maspNet: net('masp.in_daily', 'masp.out_daily', t) };
  });
};

const quoteFirst = rows<{ first_ts: number }>('price_first')[0].first_ts; // 2026-10-15T04:00Z
const stakeFirst = rows<{ first_ts: number }>('stake_first')[0].first_ts; // 2026-10-18T04:00Z
const epochNow = rows<MetricRow>('epoch_now')[0]; // 2,698
const anchor = rows<{ e: number; started: number }>('epoch_anchor').find((a) => a.e === epochNow.value)!;
const params = JSON.parse(rows<{ value: string }>('chain_params')[0].value) as { epochSec: number };
const queue = rows<{ withdraw_epoch: number; nam: number; n: number }>('queue');

const priceInput = (days: number, quote: MetricRow[], exec: KeyedRow[]): PriceInput => ({ from: A - days * DAY_MS, to: A, stepMs: HOUR_MS, quote: points(quote), exec: execPoints(exec), quoteFirstTs: quoteFirst });
const stakeInput = (days: number): StakeInput => ({ from: A - days * DAY_MS, to: A, stepMs: HOUR_MS, points: points(rows<MetricRow>('stake_1h')), firstTs: stakeFirst });
const pipelineInput = (days: number): PipelineInput => ({
  fromDay: dayStart(T_QUEUE),
  days,
  buckets: queue.filter((r) => r.withdraw_epoch > epochNow.value).map((r) => ({ epoch: r.withdraw_epoch, nam: r.nam, n: r.n })),
  eNow: epochNow.value,
  started: anchor.started,
  epochSecMs: params.epochSec * 1000,
  asOf: T_QUEUE,
});
const LAST_DAY = Date.UTC(2026, 9, 22);

const daily: ChartSetInput = {
  price: priceInput(7, rows('price_quote_1h'), rows('price_exec_1h')),
  stake: stakeInput(30),
  pipeline: pipelineInput(30),
  flows: { days: flowDays(rows('flows_daily'), LAST_DAY, 7) },
};
const weekly: ChartSetInput = {
  price: priceInput(30, rows('price_quote_1h_30d'), rows('price_exec_1h_30d')),
  stake: stakeInput(90),
  pipeline: pipelineInput(90),
  flows: { days: flowDays(rows('flows_daily_30d'), LAST_DAY, 30) },
};

// ------------------------------------------------------------------------------------------------ pixel and file helpers

const same = (a: readonly number[], b: readonly number[]) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
const px = (rgb: Uint8Array, w: number, x: number, y: number): [number, number, number] => [rgb[(y * w + x) * 3], rgb[(y * w + x) * 3 + 1], rgb[(y * w + x) * 3 + 2]];
/** Pixels of exactly colour c inside [x0, x1) × [y0, y1). */
function count(p: ChartPixels, c: readonly number[], x0: number, y0: number, x1: number, y1: number): number {
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (same(px(p.rgb, p.w, x, y), c)) n++;
  return n;
}
/** Pixels within 40 a channel of colour c (anti-aliased fringes count) inside the rectangle. */
function near(p: ChartPixels, c: readonly number[], x0: number, y0: number, x1: number, y1: number): number {
  let n = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const v = px(p.rgb, p.w, x, y);
      if (Math.abs(v[0] - c[0]) < 40 && Math.abs(v[1] - c[1]) < 40 && Math.abs(v[2] - c[2]) < 40) n++;
    }
  return n;
}
/** Pixels that are anything but the surface and the grid inside the rectangle: what was drawn there. */
function inked(p: ChartPixels, x0: number, y0: number, x1: number, y1: number): number {
  let n = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const v = px(p.rgb, p.w, x, y);
      if (!same(v, THEME.bg) && !same(v, THEME.line)) n++;
    }
  return n;
}
/** The x of a step start, from the chart's own box. */
const xOf = (p: ChartPixels, from: number, to: number) => (t: number) => Math.round(p.box.L + ((t - from) / (to - from)) * (CHART_W - p.box.L - p.box.R));

/** The chunks of a PNG file, with the signature and every CRC checked. */
function chunksOf(png: Uint8Array): { type: string; data: Uint8Array }[] {
  expect([...png.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const out: { type: string; data: Uint8Array }[] = [];
  let o = 8;
  while (o < png.length) {
    const len = dv.getUint32(o);
    const type = String.fromCharCode(png[o + 4], png[o + 5], png[o + 6], png[o + 7]);
    expect(dv.getUint32(o + 8 + len)).toBe(crc32(png, o + 4, o + 8 + len));
    out.push({ type, data: png.subarray(o + 8, o + 8 + len) });
    o += 12 + len;
  }
  expect(o).toBe(png.length);
  return out;
}
/** A well-formed RGB PNG of w × h whose IDAT inflates back to the filtered rows of `rgb`. */
function expectPng(png: Uint8Array, w: number, h: number, rgb: Uint8Array): void {
  const chunks = chunksOf(png);
  expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
  const ihdr = new DataView(chunks[0].data.buffer, chunks[0].data.byteOffset, 13);
  expect(ihdr.getUint32(0)).toBe(w);
  expect(ihdr.getUint32(4)).toBe(h);
  expect([...chunks[0].data.subarray(8)]).toEqual([8, 2, 0, 0, 0]);
  expect(chunks[2].data.length).toBe(0);
  const raw = inflateSync(Buffer.from(chunks[1].data));
  expect(raw.length).toBe((3 * w + 1) * h);
  expect(raw.equals(Buffer.from(filteredRows(w, h, rgb)))).toBe(true);
}
const equalBytes = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

// ------------------------------------------------------------------------------------------------ raster and font

describe('the pixel buffer', () => {
  it('fills and blends, and keeps a rectangle on whole pixels', () => {
    const cv = new Canvas(10, 10, hex('#000000'));
    cv.fillRect(2, 2, 3, 3, hex('#ffffff'));
    expect(cv.at(2, 2)).toEqual([255, 255, 255]);
    expect(cv.at(4, 4)).toEqual([255, 255, 255]);
    expect(cv.at(5, 5)).toEqual([0, 0, 0]);
    expect(cv.at(1, 2)).toEqual([0, 0, 0]);
    cv.blend(0, 0, hex('#ffffff'), 0.5);
    expect(cv.at(0, 0)).toEqual([128, 128, 128]);
    expect(mix(hex('#ffffff'), hex('#000000'), 0.25)).toEqual([64, 64, 64]);
    expect(() => new Canvas(0, 4, THEME.bg)).toThrow();
  });
  it('anti-aliases a diagonal line: full coverage on the axis, partial beside it, none far away', () => {
    const cv = new Canvas(40, 40, hex('#000000'));
    cv.line(5, 5, 35, 35, 2, hex('#ffffff'));
    expect(cv.at(20, 20)).toEqual([255, 255, 255]);
    const beside = cv.at(22, 20)[0];
    expect(beside).toBeGreaterThan(0);
    expect(beside).toBeLessThan(255);
    expect(cv.at(30, 5)).toEqual([0, 0, 0]);
  });
  it('dashes a line and clips at the canvas edge without throwing', () => {
    const cv = new Canvas(60, 10, hex('#000000'));
    cv.line(0, 5, 60, 5, 2, hex('#ffffff'), 1, [5, 5]);
    let on = 0;
    for (let x = 0; x < 60; x++) if (cv.at(x, 5)[0] === 255) on++;
    expect(on).toBeGreaterThan(20);
    expect(on).toBeLessThan(45);
    expect(() => cv.line(-20, -20, 100, 100, 3, hex('#ffffff'))).not.toThrow();
    expect(() => cv.dot(-5, 5, 10, hex('#ffffff'))).not.toThrow();
    expect(() => cv.fillRect(-5, -5, 100, 100, hex('#ffffff'))).not.toThrow();
  });
  it('a bar sits above the baseline for a value above it, below for one below, and is one pixel when the two rows meet', () => {
    const cv = new Canvas(10, 20, hex('#000000'));
    const w = hex('#ffffff');
    cv.bar(0, 2, 10, 4, w); // above: rows 4..9, the value's row to the row before the baseline
    cv.bar(3, 2, 10, 16, w); // below: rows 11..16, the row after the baseline to the value's row
    cv.bar(6, 2, 10, 10, w); // level: row 9 only
    expect(cv.at(0, 3)).toEqual([0, 0, 0]);
    expect(cv.at(0, 4)).toEqual([255, 255, 255]);
    expect(cv.at(0, 9)).toEqual([255, 255, 255]);
    expect(cv.at(0, 10)).toEqual([0, 0, 0]); // the baseline row is left for the zero line
    expect(cv.at(3, 10)).toEqual([0, 0, 0]);
    expect(cv.at(3, 11)).toEqual([255, 255, 255]);
    expect(cv.at(3, 16)).toEqual([255, 255, 255]);
    expect(cv.at(3, 17)).toEqual([0, 0, 0]);
    expect(cv.at(6, 9)).toEqual([255, 255, 255]);
    expect(cv.at(6, 8)).toEqual([0, 0, 0]);
    expect(cv.at(6, 10)).toEqual([0, 0, 0]);
  });
  it('draws the same bytes twice', () => {
    const draw = () => {
      const cv = new Canvas(50, 30, THEME.bg);
      cv.line(3.3, 4.4, 44.1, 22.2, 2, THEME.ink);
      cv.dot(20.5, 10.25, 3, THEME.shielded);
      cv.pill(5, 5, 30, 12, THEME.mark);
      cv.vdash(48, 0, 30, 3, 3, THEME.ink3);
      drawText(cv, 2, 18, '0.0015', 1, THEME.ink2);
      return cv.px;
    };
    expect(equalBytes(draw(), draw())).toBe(true);
  });
});

describe('the bitmap font', () => {
  it('has every character an axis label or a pill can print, and reports the ones it lacks', () => {
    const needed = '0123456789.,-+:%$/ kMB' + 'JanFebMarAprMayJunJulAugSepOctNovDec' + 'UTC';
    expect(missingGlyphs(needed)).toEqual([]);
    expect(hasGlyph('Z')).toBe(false);
    expect(missingGlyphs('12Z!Z')).toEqual(['Z', '!']);
    expect(namTick(267_200_000, 200_000)).toBe('267.2M');
    expect(namTick(-1_500_000, 500_000)).toBe('-1.5M');
    expect(namTick(50_000, 50_000)).toBe('50k');
    expect(usdTick(0.0005, 0.0005)).toBe('0.0005');
  });
  it('measures and aligns', () => {
    expect(textWidth('123', 2)).toBe((3 * 6 - 1) * 2);
    expect(textWidth('', 2)).toBe(0);
    const left = new Canvas(40, 20, hex('#000000'));
    expect(drawText(left, 0, 0, '1', 2, hex('#ffffff'))).toBe(10);
    let lit = 0;
    for (let y = 0; y < 20; y++) for (let x = 0; x < 40; x++) if (left.at(x, y)[0] === 255) lit++;
    expect(lit).toBeGreaterThan(0);
    const right = new Canvas(40, 20, hex('#000000'));
    drawText(right, 40, 0, '1', 2, hex('#ffffff'), 'right');
    let litRight = 0;
    for (let y = 0; y < 20; y++) for (let x = 30; x < 40; x++) if (right.at(x, y)[0] === 255) litRight++;
    expect(litRight).toBe(lit);
    for (let y = 0; y < 20; y++) for (let x = 0; x < 30; x++) expect(right.at(x, y)).toEqual([0, 0, 0]);
  });
});

// ------------------------------------------------------------------------------------------------ png

describe('the PNG encoder', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new TextEncoder().encode('IEND'))).toBe(0xae426082);
  });
  it('writes the signature, IHDR, one IDAT and IEND with good CRCs, and the IDAT inflates to the filtered rows', async () => {
    const cv = new Canvas(16, 8, THEME.bg);
    cv.line(0, 0, 16, 8, 2, THEME.ink);
    const png = await encodePng(16, 8, cv.px);
    expectPng(png, 16, 8, cv.px);
    expect(equalBytes(png, await encodePng(16, 8, cv.px))).toBe(true);
  });
  it('picks a filter per row and refuses a pixel buffer of the wrong size', () => {
    const flat = new Canvas(4, 2, THEME.bg);
    const rows = filteredRows(4, 2, flat.px);
    expect(rows.length).toBe((4 * 3 + 1) * 2);
    expect(rows[13]).toBe(2); // a row equal to the one above filters to zeros with Up
    expect(() => filteredRows(4, 4, new Uint8Array(10))).toThrow(/expected 48/);
  });
});

// ------------------------------------------------------------------------------------------------ the four daily charts

describe('the four daily charts from the stored rows', () => {
  const checks = async (draw: () => ChartPixels) => {
    const a = draw();
    const b = draw();
    expect(equalBytes(a.rgb, b.rgb)).toBe(true);
    const fa = await toPng(a);
    const fb = await toPng(b);
    expect(equalBytes(fa.png, fb.png)).toBe(true);
    expect(fa.rowsHash).toBe(fb.rowsHash);
    expect(fa.rowsHash).toBe(await rowsHash(a));
    expectPng(fa.png, CHART_W, CHART_H, a.rgb);
    expect(fa.bytes).toBe(fa.png.length);
    expect(fa.bytes).toBeLessThan(PNG_MAX_BYTES);
    expect(a.labels.flatMap(missingGlyphs)).toEqual([]);
    for (const l of a.labels) expect(l).not.toMatch(/tnam1|osmo1/);
    return a;
  };

  it('price, 7 days: the quote every closed hour, 34 hours with a trade, the hour of the send never a point', async () => {
    const c = await checks(() => priceChart(daily.price as PriceInput));
    const w = priceChart(daily.price as PriceInput).words;
    expect(w).toMatchObject({ slots: 168, quoteHours: 168, quoteGaps: 0, gapsMarked: 0, execHours: 34, execTrades: 157 });
    expect(w.last.quote?.t).toBe(A - HOUR_MS); // the 07:00 hour: the 08:00 row the fixture holds is the open hour at the send
    expect(w.last.quote?.v).toBeCloseTo(0.00087359, 8);
    expect(w.last.exec).toMatchObject({ t: Date.UTC(2026, 9, 23, 5), n: 1 });
    expect(w.last.exec?.v).toBeCloseTo(0.0009165, 7);
    expect(w.low).toMatchObject({ t: Date.UTC(2026, 9, 21, 14) });
    expect(w.low?.v).toBeCloseTo(0.00016402, 8);
    expect(w.high).toMatchObject({ t: Date.UTC(2026, 9, 19, 10) });
    expect(w.high?.v).toBeCloseTo(0.00152799, 8);
    expect(c.labels).toEqual(['0.0000', '0.0005', '0.0010', '0.0015', '0.0020', '16 Oct 08:00', '19 Oct 20:00', '23 Oct 08:00', '$0.00087359']);
    // no start rule: the quote series began 15 Oct, before the window
    expect(count(c, THEME.ink3, c.box.L, c.box.T, c.box.L + 1, c.box.base)).toBeLessThan(20);
  });

  it('staked NAM, 30 days: the axis fitted to the readings, a dashed rule where the series starts and nothing before it', async () => {
    const c = await checks(() => stakeChart(daily.stake as StakeInput));
    const w = stakeChart(daily.stake as StakeInput).words;
    expect(w).toMatchObject({ slots: 124, hours: 124, gaps: 0, gapsMarked: 0, startsInWindow: stakeFirst });
    expect(w.first).toEqual({ t: stakeFirst, v: 267_180_094.223579 });
    expect(w.last).toEqual({ t: A - HOUR_MS, v: 267_774_764.266631 });
    expect(w.low?.v).toBe(267_174_076.755088);
    expect(w.high?.v).toBe(267_780_557.266631);
    expect(c.labels).toEqual(['267.0M', '267.2M', '267.4M', '267.6M', '267.8M', '23 Sep', '8 Oct', '23 Oct', '267.77M']);
    const x = xOf(c, A - 30 * DAY_MS, A);
    const xs = x(stakeFirst);
    expect(count(c, THEME.ink3, xs, c.box.T, xs + 1, c.box.base)).toBeGreaterThan(100);
    // before the start, past the first point's round cap: only the surface and the grid
    expect(inked(c, c.box.L, c.box.T, xs - 3, c.box.base - 4)).toBe(0);
    expect(near(c, THEME.ink, xs + 2, c.box.T, CHART_W - c.box.R, c.box.base - 4)).toBeGreaterThan(200);
  });

  it('unlocks, 30 days: each bucket on its unlock day from the epoch clock, empty days marked on the floor', async () => {
    const c = await checks(() => pipelineChart(daily.pipeline as PipelineInput));
    const w = pipelineChart(daily.pipeline as PipelineInput).words;
    expect(w).toMatchObject({ slots: 30, daysWithUnlock: 7, totalN: 33, beyond: { nam: 0, n: 0, epochs: 0 }, anchored: true });
    expect(w.totalNam).toBeCloseTo(182_982.018281, 6);
    expect(w.days.map((d) => [new Date(d.t).toISOString().slice(0, 10), +d.nam.toFixed(2), d.epochs])).toEqual([
      ['2026-10-25', 37_489.27, [2704]],
      ['2026-10-26', 5_784.37, [2708]],
      ['2026-10-27', 159.92, [2715]],
      ['2026-10-30', 101_000, [2725, 2726]],
      ['2026-10-31', 6_628.47, [2729, 2731]],
      ['2026-11-05', 30_900, [2750, 2751]],
      ['2026-11-06', 1_020, [2753]],
    ]);
    expect(w.first?.t).toBe(Date.UTC(2026, 9, 25));
    expect(w.largest?.t).toBe(Date.UTC(2026, 9, 30));
    expect(c.labels).toEqual(['0', '50k', '100k', '150k', '23 Oct', '7 Nov', '21 Nov']);
    const d0 = dayStart(T_QUEUE);
    const x = xOf(c, d0, d0 + 30 * DAY_MS);
    const { T: top, base } = c.box;
    // a bar of ink-2 on 30 Oct (day 7) and none on 29 Oct (day 6), which carries a floor mark instead
    expect(count(c, THEME.ink2, x(d0 + 7 * DAY_MS) + 2, top, x(d0 + 8 * DAY_MS) - 2, base - 3)).toBeGreaterThan(100);
    expect(count(c, THEME.ink2, x(d0 + 6 * DAY_MS) + 2, top, x(d0 + 7 * DAY_MS) - 2, base - 3)).toBe(0);
    expect(count(c, SLOT_MARK, x(d0 + 6 * DAY_MS) + 2, base - 2, x(d0 + 7 * DAY_MS) - 2, base)).toBeGreaterThan(10);
    expect(count(c, SLOT_MARK, x(d0 + 7 * DAY_MS) + 2, base - 2, x(d0 + 8 * DAY_MS) - 2, base)).toBe(0);
    // the zero line in --line-strong along the baseline
    expect(count(c, THEME.lineStrong, c.box.L, base, CHART_W - c.box.R, base + 1)).toBeGreaterThan(600);
  });

  it('net flow, 7 days: two bars a day, an outflow below the zero line in the series colour and nothing above it', async () => {
    const c = await checks(() => flowsChart(daily.flows as { days: FlowDay[] }));
    const w = flowsChart(daily.flows as { days: FlowDay[] }).words;
    expect(w.missing).toEqual([]);
    expect(w.days[6].t).toBe(LAST_DAY);
    expect(w.days[6].bridgeNet).toBeCloseTo(357_587.454814, 6);
    expect(w.days[6].maspNet).toBeCloseTo(75_999.575682, 6);
    expect(w.days[5]).toMatchObject({ t: Date.UTC(2026, 9, 21), bridgeNet: -1_500_912 });
    expect(w.days[5].maspNet).toBeCloseTo(-1_736_000.742288, 6);
    expect(w.bridgeTotal).toBeCloseTo(-784_253.891821, 6);
    expect(w.maspTotal).toBeCloseTo(-1_515_006.328607, 6);
    expect(w.largest.bridge?.t).toBe(Date.UTC(2026, 9, 21));
    expect(w.largest.masp?.t).toBe(Date.UTC(2026, 9, 21));
    expect(c.labels).toEqual(['-2M', '-1M', '0', '1M', '16 Oct', '17 Oct', '18 Oct', '19 Oct', '20 Oct', '21 Oct', '22 Oct']);
    const from = Date.UTC(2026, 9, 16);
    const x = xOf(c, from, LAST_DAY + DAY_MS);
    const { T: top, base } = c.box;
    const y0 = Math.round(top + (base - top) / 3); // the ticks run −2M..1M, so zero sits a third of the way down
    expect(count(c, THEME.lineStrong, c.box.L, y0, CHART_W - c.box.R, y0 + 1)).toBeGreaterThan(600);
    // 21 Oct: ink and cyan below the line, nothing above it
    expect(count(c, THEME.ink, x(from + 5 * DAY_MS), y0 + 2, x(from + 6 * DAY_MS), base - 1)).toBeGreaterThan(500);
    expect(count(c, THEME.shielded, x(from + 5 * DAY_MS), y0 + 2, x(from + 6 * DAY_MS), base - 1)).toBeGreaterThan(500);
    expect(inked(c, x(from + 5 * DAY_MS), top, x(from + 6 * DAY_MS), y0 - 1)).toBe(0);
    // 22 Oct: both bars above the line, nothing below it
    expect(count(c, THEME.ink, x(from + 6 * DAY_MS), top, x(from + 7 * DAY_MS), y0 - 1)).toBeGreaterThan(100);
    expect(count(c, THEME.shielded, x(from + 6 * DAY_MS), top, x(from + 7 * DAY_MS), y0 - 1)).toBeGreaterThan(20);
    expect(inked(c, x(from + 6 * DAY_MS), y0 + 2, x(from + 7 * DAY_MS), base - 1)).toBe(0);
  });
});

// ------------------------------------------------------------------------------------------------ the weekly variants

describe('the weekly variants', () => {
  it('renders the 30- and 90-day pictures under their own file names, the same bytes on a second render, each under 100 KB', async () => {
    const a = await renderChartSet(weekly, 'weekly');
    const b = await renderChartSet(weekly, 'weekly');
    expect(a.leftOut).toEqual([]);
    expect(a.charts.map((c) => c.file)).toEqual(['weekly-price-30d.png', 'weekly-stake-90d.png', 'weekly-pipeline-90d.png', 'weekly-flows-30d.png']);
    expect(a.charts.map((c) => c.name)).toEqual(['price', 'stake', 'pipeline', 'flows']);
    for (let i = 0; i < 4; i++) {
      expect(equalBytes(a.charts[i].png, b.charts[i].png)).toBe(true);
      expect(a.charts[i].rowsHash).toBe(b.charts[i].rowsHash);
      expect(a.charts[i].bytes).toBeLessThan(PNG_MAX_BYTES);
      expect(chunksOf(a.charts[i].png).map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
      expect(a.charts[i].labels.flatMap(missingGlyphs)).toEqual([]);
    }
    expect(a.charts.reduce((n, c) => n + c.bytes, 0)).toBeLessThan(200_000);
  });
  it('price, 30 days: the quote series starts inside the window, so the hours before it are not gaps and a dashed rule marks the start', () => {
    const input = weekly.price as PriceInput;
    const c = priceChart(input);
    expect(c.words).toMatchObject({ slots: 196, quoteHours: 196, quoteGaps: 0, execHours: 95 });
    expect(c.labels.slice(-4)).toEqual(['23 Sep', '8 Oct', '23 Oct', '$0.00087359']);
    const xs = xOf(c, input.from, input.to)(quoteFirst);
    expect(count(c, THEME.ink3, xs, c.box.T, xs + 1, c.box.base)).toBeGreaterThan(100);
    expect(count(c, SLOT_MARK, c.box.L, c.box.base - 2, xs, c.box.base)).toBe(0);
  });
  it('staked NAM, 90 days: the same 124 hours on a longer axis, blank before the start', () => {
    const input = weekly.stake as StakeInput;
    const c = stakeChart(input);
    expect(c.words).toMatchObject({ slots: 124, hours: 124, gaps: 0, startsInWindow: stakeFirst });
    expect(c.labels.slice(5, 8)).toEqual(['25 Jul', '8 Sep', '23 Oct']);
    const xs = xOf(c, input.from, input.to)(stakeFirst);
    // nothing of the series and no floor mark before the start (the pill may sit there: the series is a sliver at the right edge)
    expect(near(c, THEME.ink, c.box.L, c.box.T, xs - 3, c.box.base - 4)).toBe(0);
    expect(count(c, SLOT_MARK, c.box.L, c.box.base - 2, xs, c.box.base)).toBe(0);
    expect(count(c, THEME.ink3, xs, c.box.T, xs + 1, c.box.base)).toBeGreaterThan(100);
    expect(count(c, THEME.mark, c.box.L, c.box.T, CHART_W - c.box.R, c.box.base)).toBeGreaterThan(500);
  });
  it('unlocks, 90 days, and net flow, 30 days: the same buckets on 90 slots; thirty days with three x labels', () => {
    const p = pipelineChart(weekly.pipeline as PipelineInput);
    expect(p.words).toMatchObject({ slots: 90, daysWithUnlock: 7, totalN: 33, beyond: { epochs: 0 } });
    expect(p.labels.slice(-3)).toEqual(['23 Oct', '7 Dec', '20 Jan']);
    const f = flowsChart(weekly.flows as { days: FlowDay[] });
    expect(f.words.days.length).toBe(30);
    expect(f.words.missing).toEqual([]);
    expect(f.labels.filter((l) => /Sep|Oct/.test(l))).toEqual(['23 Sep', '8 Oct', '22 Oct']);
  });
  it('CHART_DAYS names each window and chartFileName the attachment', () => {
    expect(CHART_DAYS).toEqual({ daily: { price: 7, stake: 30, pipeline: 30, flows: 7 }, weekly: { price: 30, stake: 90, pipeline: 90, flows: 30 } });
    expect(chartFileName('daily', 'price', 7)).toBe('price-7d.png');
    expect(chartFileName('weekly', 'flows', 30)).toBe('weekly-flows-30d.png');
  });
});

// ------------------------------------------------------------------------------------------------ a gap is a gap

describe('a stretch with no reading is a break, never a line across it', () => {
  it('splits runs at a gap, finds the empty slots and groups them into gap runs', () => {
    const pts = [{ t: 0 }, { t: HOUR_MS }, { t: 3 * HOUR_MS }, { t: 4 * HOUR_MS }];
    expect(runs(pts, HOUR_MS).map((r) => r.length)).toEqual([2, 2]);
    expect(emptySlots(pts, 0, 6 * HOUR_MS, HOUR_MS)).toEqual([2 * HOUR_MS, 5 * HOUR_MS]);
    expect(emptySlots(pts, 0, 6 * HOUR_MS, HOUR_MS, 3 * HOUR_MS)).toEqual([5 * HOUR_MS]);
    expect(gapRuns([2, 3, 4, 8, 10, 11].map((h) => h * HOUR_MS), HOUR_MS)).toEqual([
      [2 * HOUR_MS, 3],
      [8 * HOUR_MS, 1],
      [10 * HOUR_MS, 2],
    ]);
  });
  it('price: eleven quote hours cut out of the real rows leave a hole with nothing drawn in it and one floor mark under it', () => {
    const input = daily.price as PriceInput;
    const hour = (p: Point) => (p.t - input.from) / HOUR_MS;
    const quote = input.quote.filter((p) => hour(p) < 27 || hour(p) > 37);
    const c = priceChart({ ...input, quote });
    expect(c.words).toMatchObject({ slots: 168, quoteHours: 157, quoteGaps: 11, gapsMarked: 1, execHours: 34, execTrades: 157 });
    const x = xOf(c, input.from, input.to);
    const h = (k: number) => x(input.from + k * HOUR_MS);
    const { T: top, base } = c.box;
    // the hole's interior: only the surface and the grid above the floor
    expect(inked(c, h(29), top, h(36), base - 4)).toBe(0);
    // one floor mark the width of the run, and none elsewhere on the floor
    expect(count(c, SLOT_MARK, h(27), base - 2, h(38), base)).toBeGreaterThan(60);
    expect(count(c, SLOT_MARK, h(40), base - 2, h(120), base)).toBe(0);
    // the quote is drawn where it exists, on both sides of the hole
    expect(near(c, THEME.ink3, h(10), top, h(26), base - 4)).toBeGreaterThan(20);
    expect(near(c, THEME.ink3, h(40), top, h(60), base - 4)).toBeGreaterThan(20);
  });
  it('price: a quote read every second hour is never joined, and the open hour at the send is not a point', () => {
    const input = daily.price as PriceInput;
    const quote = input.quote.filter((p) => ((p.t - input.from) / HOUR_MS) % 2 === 0);
    const c = priceChart({ ...input, quote, exec: [], quoteFirstTs: null });
    expect(c.words).toMatchObject({ quoteHours: 84, quoteGaps: 84, gapsMarked: 0, execHours: 0 });
    expect(c.words.last.quote?.t).toBe(A - 2 * HOUR_MS);
    expect(near(c, THEME.ink3, c.box.L, c.box.T, CHART_W - c.box.R, c.box.base - 4)).toBe(0);
  });
  it('staked NAM over one day: the hour cut out breaks the line (no ink between its neighbours) while adjacent hours are joined', () => {
    const from = A - DAY_MS;
    const all = (daily.stake as StakeInput).points;
    const cut = from + 10 * HOUR_MS;
    const input: StakeInput = { from, to: A, stepMs: HOUR_MS, points: all.filter((p) => p.t !== cut), firstTs: stakeFirst };
    const c = stakeChart(input);
    expect(c.words).toMatchObject({ slots: 24, hours: 23, gaps: 1, gapsMarked: 1, startsInWindow: null });
    const x = xOf(c, from, A);
    const h = (k: number) => x(from + k * HOUR_MS);
    const { T: top, base } = c.box;
    expect(h(1) - h(0)).toBeGreaterThan(20);
    // between hours 9 and 11, past the dots' reach, no ink: the line is broken
    expect(near(c, THEME.ink, h(9) + 4, top, h(11) - 4, base - 4)).toBe(0);
    // the slot carries a floor mark
    expect(count(c, SLOT_MARK, h(10) + 1, base - 2, h(11) - 1, base)).toBeGreaterThan(20);
    // between hours 5 and 6 the line is there
    expect(near(c, THEME.ink, h(5) + 4, top, h(6) - 4, base - 4)).toBeGreaterThan(0);
    // and the same rows render the same bytes again
    expect(equalBytes(c.rgb, stakeChart(input).rgb)).toBe(true);
  });
  it('the hour the send time falls in is never a slot, nor a closed hour whose rollup is not due yet; a closed hour past it with no row is missing', () => {
    const series = (from: number, to: number, skip: number | null = null): Point[] => {
      const out: Point[] = [];
      for (let t = Math.ceil(from / HOUR_MS) * HOUR_MS; t + HOUR_MS <= to; t += HOUR_MS) if (t !== skip) out.push({ t, v: 267e6 + (t - from) / 1e3 });
      return out;
    };
    // sent at 08:43: 23 closed hours from 09:00 yesterday to the 07:00 hour, every one read; the 08:00 hour is open
    const late = A + 43 * 60_000;
    const full = stakeChart({ from: late - DAY_MS, to: late, stepMs: HOUR_MS, points: series(late - DAY_MS, late), firstTs: null, pendingMs: 15 * 60_000 });
    expect(full.words).toMatchObject({ slots: 23, hours: 23, gaps: 0 });
    // the 07:00 hour's row missing at 08:43 is missing (its rollup was due by 08:15)
    const missing = stakeChart({ from: late - DAY_MS, to: late, stepMs: HOUR_MS, points: series(late - DAY_MS, late, A - HOUR_MS), firstTs: null, pendingMs: 15 * 60_000 });
    expect(missing.words).toMatchObject({ slots: 23, hours: 22, gaps: 1 });
    // at 08:10 it is not due yet: neither a reading nor missing
    const early = A + 10 * 60_000;
    const pending = stakeChart({ from: early - DAY_MS, to: early, stepMs: HOUR_MS, points: series(early - DAY_MS, early, A - HOUR_MS), firstTs: null, pendingMs: 15 * 60_000 });
    expect(pending.words).toMatchObject({ slots: 22, hours: 22, gaps: 0 });
    const q = priceChart({ from: late - DAY_MS, to: late, stepMs: HOUR_MS, quote: series(late - DAY_MS, late).map((p) => ({ ...p, v: 0.0009 })), exec: [], quoteFirstTs: null, pendingMs: 15 * 60_000 });
    expect(q.words).toMatchObject({ slots: 23, quoteHours: 23, quoteGaps: 0 });
  });

  it('the last-value label is drawn only while the reading at the send time is read', () => {
    const input = daily.price as PriceInput;
    expect(priceChart(input).labels.at(-1)).toBe('$0.00087359');
    expect(priceChart({ ...input, quoteLive: false }).labels.some((l) => l.startsWith('$'))).toBe(false);
    const stake = daily.stake as StakeInput;
    expect(stakeChart(stake).labels.at(-1)).toBe('267.77M');
    expect(stakeChart({ ...stake, live: false }).labels).not.toContain('267.77M');
  });

  it('net flow: a day whose shielded record is withheld draws no cyan bar, a floor mark in its slot, and is named in the words', () => {
    const days = (daily.flows as { days: FlowDay[] }).days.map((d) => (d.t === Date.UTC(2026, 9, 18) ? { ...d, maspNet: null } : d));
    const c = flowsChart({ days });
    expect(c.words.missing).toEqual([Date.UTC(2026, 9, 18)]);
    expect(c.words.maspTotal).toBeCloseTo(-1_515_006.328607 + 10_000.376659, 6);
    const from = Date.UTC(2026, 9, 16);
    const x = xOf(c, from, LAST_DAY + DAY_MS);
    const { T: top, base } = c.box;
    expect(count(c, THEME.shielded, x(from + 2 * DAY_MS), top, x(from + 3 * DAY_MS), base)).toBe(0);
    expect(count(c, SLOT_MARK, x(from + 2 * DAY_MS), top, x(from + 3 * DAY_MS), base)).toBeGreaterThan(10);
    expect(count(c, THEME.ink, x(from + 2 * DAY_MS), top, x(from + 3 * DAY_MS), base)).toBeGreaterThan(50);
  });
});

// ------------------------------------------------------------------------------------------------ the pipeline's clock

describe('the unbonding pipeline', () => {
  const eNow = epochNow.value;
  const epochSecMs = params.epochSec * 1000;
  it('puts an epoch on the clock from the current epoch’s start, leaves a withdrawable epoch out, and counts buckets beyond the window', () => {
    expect(epochClock(2704, eNow, anchor.started, epochSecMs)).toBe(anchor.started + 6 * epochSecMs);
    const input = pipelineInput(10);
    const c = pipelineChart({ ...input, buckets: [...input.buckets, { epoch: eNow - 2, nam: 999_999, n: 9 }] });
    expect(c.words.daysWithUnlock).toBe(5); // 25, 26, 27, 30 and 31 Oct fall inside ten days
    expect(c.words.totalNam).toBeCloseTo(182_982.018281 - 30_900 - 1_020, 6);
    expect(c.words.beyond).toEqual({ nam: 31_920, n: 13, epochs: 3 });
  });
  it('without an anchor the clock is about (half an epoch before the read) and the words say the days are not anchored', () => {
    const c = pipelineChart({ ...pipelineInput(30), started: null });
    expect(c.words.anchored).toBe(false);
    expect(c.words.totalN).toBe(33);
    // the about clock starts the epoch at 13:10 instead of 15:31, so epoch 2,715 slips from 27 Oct 21:36 to 19:15: the same day
    expect(c.words.days.map((d) => new Date(d.t).toISOString().slice(0, 10))).toEqual(['2026-10-25', '2026-10-26', '2026-10-27', '2026-10-30', '2026-10-31', '2026-11-05', '2026-11-06']);
  });
});

// ------------------------------------------------------------------------------------------------ left out when not read

describe('a chart whose source was not read is left out with a sentence, and the others still go', () => {
  const notRead: NotRead = { notRead: true, source: 'Osmosis SQS quote (hourly rollup) and this site’s Osmosis trade index', lastAt: A - 3 * DAY_MS, reason: 'no price reading in the 7 days to 23 Oct 08:00 UTC' };

  it('the full daily set: four files under the daily names, the same bytes on a second render', async () => {
    const a = await renderChartSet(daily, 'daily');
    const b = await renderChartSet(daily, 'daily');
    expect(a.leftOut).toEqual([]);
    expect(a.charts.map((c) => c.file)).toEqual(['price-7d.png', 'stake-30d.png', 'pipeline-30d.png', 'flows-7d.png']);
    for (let i = 0; i < 4; i++) {
      expect(equalBytes(a.charts[i].png, b.charts[i].png)).toBe(true);
      expect(a.charts[i].bytes).toBeLessThan(PNG_MAX_BYTES);
    }
    expect(a.charts.reduce((n, c) => n + c.bytes, 0)).toBeLessThan(200_000);
    const price = a.charts[0];
    if (price.name === 'price') expect(price.words.execTrades).toBe(157);
    else throw new Error('the first chart is the price chart');
  });
  it('one NotRead: that chart is replaced by its sentence with the last reading’s time; three pictures remain', async () => {
    const set = await renderChartSet({ ...daily, price: notRead }, 'daily');
    expect(set.charts.map((c) => c.file)).toEqual(['stake-30d.png', 'pipeline-30d.png', 'flows-7d.png']);
    expect(set.leftOut).toEqual([{ name: 'price', sentence: 'Price: no chart — Osmosis SQS quote (hourly rollup) and this site’s Osmosis trade index no price reading in the 7 days to 23 Oct 08:00 UTC (last read 20 Oct 08:00 UTC).' }]);
    expect(leftOutSentence('stake', { notRead: true, source: 'Namada RPC (total stake), hourly rollup', lastAt: null, reason: 'no total-stake reading in the 30 days to 23 Oct 08:00 UTC' })).toBe('Staked NAM: no chart — Namada RPC (total stake), hourly rollup no total-stake reading in the 30 days to 23 Oct 08:00 UTC.');
  });
  it('every source not read: no picture, four sentences in the charts’ order', async () => {
    const nr = (reason: string): NotRead => ({ notRead: true, source: 'the database', lastAt: null, reason });
    const set = await renderChartSet({ price: nr('did not answer this read'), stake: nr('did not answer this read'), pipeline: nr('did not answer this read'), flows: nr('did not answer this read') }, 'weekly');
    expect(set.charts).toEqual([]);
    expect(set.leftOut.map((l) => l.name)).toEqual(['price', 'stake', 'pipeline', 'flows']);
    expect(set.leftOut[2].sentence).toBe('Unlocks: no chart — the database did not answer this read.');
  });
  it('a picture over its byte budget is not attached, and a drawing that throws loses only its own chart', async () => {
    const tight = await renderChartSet(daily, 'daily', 1_000);
    expect(tight.charts).toEqual([]);
    expect(tight.leftOut.map((l) => l.name)).toEqual(['price', 'stake', 'pipeline', 'flows']);
    expect(tight.leftOut[0].sentence).toMatch(/^Price: no chart — the picture was larger than its budget \([\d,]+ bytes, the bound 1,000\)\.$/);
    const broken = await renderChartSet({ ...daily, flows: { days: [] } }, 'daily');
    expect(broken.charts.map((c) => c.file)).toEqual(['price-7d.png', 'stake-30d.png', 'pipeline-30d.png']);
    expect(broken.leftOut).toEqual([{ name: 'flows', sentence: 'Net flow: no chart — the picture could not be drawn (flowsChart needs at least one day).' }]);
  });
});
