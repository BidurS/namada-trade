// The data behind the digest's four charts (scratchpad digest/charts-design.txt section 2): the D1 statements, bound
// and bounded, one index range each (sqlite_autoindex_metrics_1 on (key, ts), unbond_queue's INTEGER PRIMARY KEY), the
// pure shaping of their rows into the renderer's inputs under the "not read" rules, and the caption each chart's words
// make (the picture carries no legend, so a phone push, which shows text only, still carries the reading). The epoch
// clock, the bond listing's state and the minute readings at T are the figures' own (figures.ts reads them once); this
// file reads only the series. Every chart is shaped on its own: a statement that failed or a source with no reading
// leaves that chart out with a sentence, never an empty picture and never a lost digest.
import {
  CHART_DAYS, CHART_NAMES, CHART_TITLES, DAY_MS, HOUR_MS, dayStart, fmtClock, fmtDayMon, fmtDayMonClock,
  type ChartName, type ChartSet, type ChartSetInput, type DigestKind, type FlowDay, type FlowsInput, type FlowsWords, type NotRead,
  type PipelineInput, type PipelineWords, type PriceInput, type PriceWords, type StakeInput, type StakeWords,
} from './charts';
import { fmtSpan, type Answer } from '../types';
import { Wave, type Prepared } from '../waves';

// ----------------------------------------------------------------------------------------------- bounds

/** A minute key's reading at T must be this recent to count as read now (the figures' MINUTE_BOUND_MS). */
export const CHART_MINUTE_BOUND_MS = 10 * 60_000;
/** The hourly rollup runs in the first 15 min of an hour and catches up 6 hours; a newest closed hour older than this is "behind". */
export const HOURLY_ROLLUP_BOUND_MS = 3 * HOUR_MS;
/** The hourly rollup writes a closed hour's row in the first 15 min of the next hour: a closed hour without a row
 *  within this of the send time is pending, not missing. */
export const HOURLY_ROLLUP_DUE_MS = 15 * 60_000;
/** series.daily() writes a day's keys from 01:00 UTC of the next day. */
export const DAILY_KEYS_FROM_MS = HOUR_MS;
/** The queue beyond the current epoch holds at most the unbonding length's epochs; the read is bounded well above it. */
export const CHART_QUEUE_MAX = 500;
/** A gap this long between the anchor and the reading before it is said in the pipeline's note. */
const ANCHOR_NOTE_MS = 2 * 60_000;

// ----------------------------------------------------------------------------------------------- statements

export const CHART_SQL = {
  /** one key's rows in a window, oldest first, bounded by the window's slot count */
  range: 'SELECT ts, value FROM metrics WHERE key = ? AND ts >= ? AND ts <= ? ORDER BY ts LIMIT ?',
  /** two keys' rows in a window (two PK ranges) */
  range2: 'SELECT key, ts, value FROM metrics WHERE key IN (?, ?) AND ts >= ? AND ts <= ? ORDER BY key, ts LIMIT ?',
  /** the four day keys over the closed days (four PK ranges of N rows) */
  dayKeys: 'SELECT key, ts, value FROM metrics WHERE key IN (?, ?, ?, ?) AND ts >= ? AND ts <= ? ORDER BY key, ts LIMIT ?',
  /** a series' first row (PK, 1 row): a series that starts inside the window is blank before it */
  firstTs: 'SELECT MIN(ts) first_ts FROM metrics WHERE key = ?',
  /** the queue's buckets after the current epoch (INTEGER PRIMARY KEY range) */
  queue: 'SELECT withdraw_epoch, nam, n FROM unbond_queue WHERE withdraw_epoch > ? ORDER BY withdraw_epoch LIMIT ?',
} as const;

export interface MetricRow { ts: number; value: number }
export interface KeyedRow extends MetricRow { key: string }
export interface QueueRow { withdraw_epoch: number; nam: number; n: number }

/** The epoch clock and the bond listing as the figures read them (figures.ts Anchors), in the terms the pipeline chart needs. */
export interface ChartClock {
  /** the epoch at T; null when its reading is not live */
  eNow: number | null;
  epochAt: number | null;
  /** the first reading of the current epoch; null when it could not be anchored */
  startedAt: number | null;
  /** the gap between the anchor and the reading before it */
  errorMs: number | null;
  /** the epoch length from live chain parameters; null when they are missing or older than a day */
  epochMs: number | null;
  paramsAt: number | null;
}
export interface ChartListing { completeAt: number | null; height: number | null; provider: string | null; live: boolean; error: string | null; failedAt: number | null }
/** A minute reading at T: when it was taken, and whether it is within its bound (null: the read itself failed). */
export interface ChartNow { at: number | null; live: boolean }

export interface ChartContext {
  now: number;
  kind: DigestKind;
  clock: ChartClock;
  listing: ChartListing | null;
  quoteNow: ChartNow | null;
  stakeNow: ChartNow | null;
}

/** Every statement's answer; a chart whose statement was not run (the epoch unknown) has null. */
export interface ChartRows {
  quote: Answer<MetricRow>;
  quoteFirst: Answer<{ first_ts: number | null }>;
  exec: Answer<KeyedRow>;
  stake: Answer<MetricRow>;
  stakeFirst: Answer<{ first_ts: number | null }>;
  queue: Answer<QueueRow> | null;
  days: Answer<KeyedRow>;
}

/** The windows each chart reads: the step the send time falls in is excluded by the shapers, not by the read. */
export function chartWindows(now: number, kind: DigestKind) {
  const d = CHART_DAYS[kind];
  const lastDay = dayStart(now) - DAY_MS;
  return {
    days: d,
    price: { from: now - d.price * DAY_MS, to: now, slots: d.price * 24 + 2 },
    stake: { from: now - d.stake * DAY_MS, to: now, slots: d.stake * 24 + 2 },
    flows: { from: lastDay - (d.flows - 1) * DAY_MS, to: lastDay, lastDay, slots: d.flows * 4 },
  };
}

/** One db.batch wave of the series reads (about 7 statements, a few hundred to a few thousand index rows). */
export async function readChartRows(db: D1Database, ctx: ChartContext, log?: Prepared[]): Promise<ChartRows> {
  const w = chartWindows(ctx.now, ctx.kind);
  const wave = new Wave(db, log);
  const quote = wave.add<MetricRow>(CHART_SQL.range, ['price.usd.1h', w.price.from, w.price.to, w.price.slots]);
  const quoteFirst = wave.add<{ first_ts: number | null }>(CHART_SQL.firstTs, ['price.usd.1h']);
  const exec = wave.add<KeyedRow>(CHART_SQL.range2, ['price.swap_1h', 'price.swap_1h.n', w.price.from, w.price.to, 2 * w.price.slots]);
  const stake = wave.add<MetricRow>(CHART_SQL.range, ['supply.total_stake.1h', w.stake.from, w.stake.to, w.stake.slots]);
  const stakeFirst = wave.add<{ first_ts: number | null }>(CHART_SQL.firstTs, ['supply.total_stake.1h']);
  const queue = ctx.clock.eNow != null ? wave.add<QueueRow>(CHART_SQL.queue, [ctx.clock.eNow, CHART_QUEUE_MAX]) : null;
  const days = wave.add<KeyedRow>(CHART_SQL.dayKeys, ['bridge.in_daily', 'bridge.out_daily', 'masp.in_daily', 'masp.out_daily', w.flows.from, w.flows.to, w.flows.slots]);
  await wave.run();
  return {
    quote: quote.answer, quoteFirst: quoteFirst.answer, exec: exec.answer, stake: stake.answer, stakeFirst: stakeFirst.answer,
    queue: queue ? queue.answer : null, days: days.answer,
  };
}

// ----------------------------------------------------------------------------------------------- shaping, under the rules

export interface Shaped<I> {
  input: I;
  /** sentences the caption adds ("series starts …", "quote not read since …") */
  notes: string[];
}

const utc = (t: number): string => `${fmtDayMonClock(t)} UTC`;
const dbNotRead = (): NotRead => ({ notRead: true, source: 'the database', lastAt: null, reason: 'did not answer this read' });
const firstOf = (a: Answer<{ first_ts: number | null }>): number | null => (a.ok ? a.rows[0]?.first_ts ?? null : null);

/** Chart 1: the quote at each closed hour's end and the executed hourly median, `days` to T. */
export function shapePriceChart(rows: ChartRows, ctx: ChartContext): Shaped<PriceInput> | NotRead {
  const w = chartWindows(ctx.now, ctx.kind);
  if (!rows.quote.ok || !rows.exec.ok) return dbNotRead();
  const T = ctx.now;
  // a closed hour only: the row of the hour T falls in is written once it closes and is never a point of a chart to T
  const quote = rows.quote.rows.filter((r) => Number.isFinite(r.value) && r.ts + HOUR_MS <= T).map((r) => ({ t: r.ts, v: r.value }));
  const n = new Map(rows.exec.rows.filter((r) => r.key === 'price.swap_1h.n').map((r) => [r.ts, r.value]));
  const exec = rows.exec.rows
    .filter((r) => r.key === 'price.swap_1h' && Number.isFinite(r.value) && r.ts + HOUR_MS <= T)
    .map((r) => ({ t: r.ts, v: r.value, n: n.get(r.ts) ?? 0 }));
  if (!quote.length && !exec.length) {
    return { notRead: true, source: "the Osmosis SQS quote (hourly rollup) and this site's Osmosis trade index", lastAt: ctx.quoteNow?.at ?? null, reason: `have no price reading in the ${w.days.price} days to ${utc(T)}` };
  }
  const quoteFirstTs = firstOf(rows.quoteFirst);
  const notes: string[] = [];
  if (quoteFirstTs != null && quoteFirstTs > w.price.from) notes.push(`The quote series starts ${utc(quoteFirstTs)}; the chart is blank before it.`);
  if (ctx.quoteNow == null) notes.push('The quote at the send time was not read.');
  else if (!ctx.quoteNow.live) notes.push(ctx.quoteNow.at != null ? `Quote not read since ${utc(ctx.quoteNow.at)} (${fmtSpan(T - ctx.quoteNow.at)} before the send); the line ends there.` : 'The quote has no reading on record.');
  const lastQ = quote[quote.length - 1];
  if (lastQ && T - (lastQ.t + HOUR_MS) > HOURLY_ROLLUP_BOUND_MS) notes.push(`The hourly rollup is behind: its newest closed hour is ${fmtClock(lastQ.t)} UTC.`);
  return { input: { from: w.price.from, to: T, stepMs: HOUR_MS, quote, exec, quoteFirstTs, pendingMs: HOURLY_ROLLUP_DUE_MS, quoteLive: !!ctx.quoteNow?.live }, notes };
}

/** Chart 2: total stake at each closed hour's end, `days` to T. */
export function shapeStakeChart(rows: ChartRows, ctx: ChartContext): Shaped<StakeInput> | NotRead {
  const w = chartWindows(ctx.now, ctx.kind);
  if (!rows.stake.ok) return dbNotRead();
  const T = ctx.now;
  const points = rows.stake.rows.filter((r) => Number.isFinite(r.value) && r.ts + HOUR_MS <= T).map((r) => ({ t: r.ts, v: r.value }));
  if (!points.length) return { notRead: true, source: 'Namada RPC (total stake), hourly rollup', lastAt: ctx.stakeNow?.at ?? null, reason: `has no reading in the ${w.days.stake} days to ${utc(T)}` };
  const firstTs = firstOf(rows.stakeFirst);
  const notes: string[] = [];
  if (firstTs != null && firstTs > w.stake.from) notes.push(`The series starts ${utc(firstTs)}; the chart is blank before it.`);
  if (ctx.stakeNow == null) notes.push('Total stake at the send time was not read.');
  else if (!ctx.stakeNow.live) notes.push(ctx.stakeNow.at != null ? `Total stake not read since ${utc(ctx.stakeNow.at)} (${fmtSpan(T - ctx.stakeNow.at)} before the send); the line ends there.` : 'Total stake has no reading on record.');
  const last = points[points.length - 1];
  if (T - (last.t + HOUR_MS) > HOURLY_ROLLUP_BOUND_MS) notes.push(`The hourly rollup is behind: its newest closed hour is ${fmtClock(last.t)} UTC.`);
  return { input: { from: w.stake.from, to: T, stepMs: HOUR_MS, points, firstTs, pendingMs: HOURLY_ROLLUP_DUE_MS, live: !!ctx.stakeNow?.live }, notes };
}

/** Chart 3: the queue's buckets after the current epoch on the epoch clock, by unlock day for `days` days from T's date. */
export function shapePipelineChart(rows: ChartRows, ctx: ChartContext): Shaped<PipelineInput> | NotRead {
  const w = chartWindows(ctx.now, ctx.kind);
  const T = ctx.now;
  const l = ctx.listing;
  // the queue is the bond listing's: a listing past its bound or failed leaves the chart out
  if (!l || l.completeAt == null) return { notRead: true, source: "the chain's bond listing", lastAt: null, reason: 'has no complete listing on record' };
  if (!l.live) {
    const why = l.error ? `failed (${l.error})` : l.failedAt != null && l.failedAt > l.completeAt ? `failed at ${utc(l.failedAt)}` : `last completed ${fmtSpan(T - l.completeAt)} before the send (bound 2 h)`;
    return { notRead: true, source: "the chain's bond listing", lastAt: l.completeAt, reason: why };
  }
  const c = ctx.clock;
  if (c.epochMs == null) {
    return c.paramsAt != null
      ? { notRead: true, source: 'indexer.namada.net chain parameters (epoch length)', lastAt: c.paramsAt, reason: `were last read ${fmtSpan(T - c.paramsAt)} before the send (bound 24 h): no clock` }
      : { notRead: true, source: 'indexer.namada.net chain parameters (epoch length)', lastAt: null, reason: 'are not on record: unlock epochs cannot be put on a clock' };
  }
  if (c.eNow == null) return { notRead: true, source: 'Namada RPC (epoch)', lastAt: c.epochAt, reason: 'is not read at the send time' };
  if (!rows.queue || !rows.queue.ok) return dbNotRead();
  const notes: string[] = [];
  if (c.startedAt == null) notes.push(`The current epoch's start is not anchored (no reading of it in the last two epochs): the days are about, ± half an epoch (${fmtSpan(c.epochMs / 2)}).`);
  else if (c.errorMs != null && c.errorMs > ANCHOR_NOTE_MS) notes.push(`The epoch clock is anchored on the first reading of epoch ${c.eNow.toLocaleString('en-US')} at ${fmtClock(c.startedAt)} UTC, ± ${fmtSpan(c.errorMs)} (the reading gap before it).`);
  const buckets = rows.queue.rows.filter((r) => r.withdraw_epoch > c.eNow!).map((r) => ({ epoch: r.withdraw_epoch, nam: r.nam, n: r.n }));
  return { input: { fromDay: dayStart(T), days: w.days.pipeline, buckets, eNow: c.eNow, started: c.startedAt, epochSecMs: c.epochMs, asOf: T }, notes };
}

/** Chart 4: net flow per closed UTC day from the day keys: bridge = in − out (to Namada), shielded = in − out. */
export function shapeFlowsChart(rows: ChartRows, ctx: ChartContext): Shaped<FlowsInput> | NotRead {
  const w = chartWindows(ctx.now, ctx.kind);
  if (!rows.days.ok) return dbNotRead();
  const by = new Map<string, number>();
  for (const r of rows.days.rows) if (Number.isFinite(r.value)) by.set(`${r.key}@${r.ts}`, r.value);
  const get = (k: string, t: number) => by.get(`${k}@${t}`);
  const days: FlowDay[] = [];
  const missing: number[] = [];
  for (let k = w.days.flows - 1; k >= 0; k--) {
    const t = w.flows.lastDay - k * DAY_MS;
    const bi = get('bridge.in_daily', t), bo = get('bridge.out_daily', t), mi = get('masp.in_daily', t), mo = get('masp.out_daily', t);
    // a day without both keys of a pair is a missing record, drawn as an empty slot, never as zero
    const bridgeNet = bi != null && bo != null ? bi - bo : null;
    const maspNet = mi != null && mo != null ? mi - mo : null;
    if (bridgeNet == null || maspNet == null) missing.push(t);
    days.push({ t, bridgeNet, maspNet });
  }
  if (missing.length === w.days.flows) {
    return { notRead: true, source: "this site's daily flow record (series.daily)", lastAt: null, reason: `has no day for any of the ${w.days.flows} days to ${fmtDayMon(w.flows.lastDay)}` };
  }
  const notes: string[] = [];
  if (missing.length) {
    const yday = missing.includes(w.flows.lastDay) && ctx.now - dayStart(ctx.now) < DAILY_KEYS_FROM_MS;
    notes.push(`No record for ${missing.map((t) => fmtDayMon(t)).join(', ')} (the day job ${yday ? 'runs from 01:00 UTC' : 'did not write that day'}); those bars are empty, not zero.`);
  }
  return { input: { days }, notes };
}

export interface ShapedCharts {
  input: ChartSetInput;
  notes: Record<ChartName, string[]>;
}

/** The four inputs the renderer takes, each shaped on its own. */
export function shapeCharts(rows: ChartRows, ctx: ChartContext): ShapedCharts {
  const out = { price: shapePriceChart(rows, ctx), stake: shapeStakeChart(rows, ctx), pipeline: shapePipelineChart(rows, ctx), flows: shapeFlowsChart(rows, ctx) };
  const pick = <I>(s: Shaped<I> | NotRead): I | NotRead => ('notRead' in s ? s : s.input);
  const notes = (s: Shaped<unknown> | NotRead): string[] => ('notRead' in s ? [] : s.notes);
  return {
    input: { price: pick(out.price), stake: pick(out.stake), pipeline: pick(out.pipeline), flows: pick(out.flows) },
    notes: { price: notes(out.price), stake: notes(out.stake), pipeline: notes(out.pipeline), flows: notes(out.flows) },
  };
}

// ----------------------------------------------------------------------------------------------- captions (the legend lives in the text)

const num = (v: number): string => v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nam = (v: number): string => `${num(v)} NAM`;
const usd = (v: number): string => `$${v.toFixed(8)}`;
const signed = (v: number): string => `${v < 0 ? '−' : '+'}${nam(Math.abs(v))}`;
const s = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

// Each caption's first sentence is the one the message keeps when it is short of room (message.ts fit() cuts the
// captions to their first sentence before anything else, and a production digest needs that cut), so that sentence is
// the least that reads the picture: its legend and one figure, about 70 characters. The window is in the field's
// name; the counts, the extremes and the notes follow in the sentences kept when there is room.

export function priceCaption(w: PriceWords, input: PriceInput): string {
  const missing = w.quoteGaps ? ` (${w.quoteGaps} h missing)` : '';
  const parts = [
    `Dots: executed hourly median (${w.execHours} of ${w.slots} h); dashed: the hourly quote${missing}.`,
    `The dots are the median of the hour's trusted NAM/USDC trades (${s(w.execTrades, 'trade')}), joined only across adjacent hours; the quote is each hour's last reading (${w.quoteHours} of ${w.slots} hours read${w.quoteGaps ? `, the line broken where one is missing${w.gapsMarked ? ', with a mark on the floor' : ''}` : ''}).`,
  ];
  if (w.low && w.high) parts.push(`Low ${usd(w.low.v)} (${utc(w.low.t)}), high ${usd(w.high.v)} (${utc(w.high.t)}).`);
  if (w.last.quote) parts.push(`Last quote ${usd(w.last.quote.v)} (the ${fmtClock(w.last.quote.t)} hour).`);
  if (w.last.exec) parts.push(`Last executed ${usd(w.last.exec.v)} from ${s(w.last.exec.n, 'trade')} (the ${utc(w.last.exec.t)} hour).`);
  parts.push(`The window ends ${utc(input.to)}; the hour the digest is sent in is not drawn (it has not closed).`);
  return parts.join(' ');
}

export function stakeCaption(w: StakeWords, input: StakeInput): string {
  const missing = w.gaps ? ` (${w.gaps} h missing)` : '';
  const move = w.first && w.last ? `: ${signed(w.last.v - w.first.v)} from ${fmtDayMon(w.first.t)}` : '';
  const parts = [`Hourly total stake${move}${missing}.`];
  if (w.first && w.last) parts.push(`${nam(w.first.v)} at ${utc(w.first.t)} → ${nam(w.last.v)} at the ${fmtClock(w.last.t)} hour, ${w.hours} of ${w.slots} hours read${w.gaps ? `, the line broken where one is missing${w.gapsMarked ? ', with a mark on the floor' : ''}` : ''}.`);
  if (w.low && w.high) parts.push(`Low ${nam(w.low.v)} (${fmtDayMon(w.low.t)}), high ${nam(w.high.v)} (${fmtDayMon(w.high.t)}); the axis is fitted to the readings, not from zero.`);
  parts.push(`The window ends ${utc(input.to)}.`);
  return parts.join(' ');
}

export function pipelineCaption(w: PipelineWords, input: PipelineInput): string {
  const to = input.fromDay + input.days * DAY_MS;
  const parts = [
    `${nam(w.totalNam)} unlocks on ${w.daysWithUnlock} of the ${input.days} days.`,
    `${s(w.totalN, 'unbond')}, one bar per UTC day from ${fmtDayMon(input.fromDay)} to ${fmtDayMon(to - DAY_MS)}; an empty slot is a day with nothing to unlock.`,
  ];
  if (w.first) parts.push(`First: ${nam(w.first.nam)} on ${fmtDayMon(w.first.t)} (epoch${w.first.epochs.length === 1 ? '' : 's'} ${w.first.epochs.map((e) => e.toLocaleString('en-US')).join(', ')}).`);
  if (w.largest && w.largest !== w.first) parts.push(`Largest: ${nam(w.largest.nam)} on ${fmtDayMon(w.largest.t)}.`);
  if (w.beyond.epochs) parts.push(`Beyond the window: ${nam(w.beyond.nam)} in ${s(w.beyond.epochs, 'epoch')}.`);
  parts.push(w.anchored ? "Days from the epoch clock anchored on the current epoch's first reading." : 'Days are about: the epoch clock is not anchored.');
  return parts.join(' ');
}

export function flowsCaption(w: FlowsWords): string {
  const d = w.days;
  const parts = [
    `Net in: bridge ${signed(w.bridgeTotal)} (white), shielded pool ${signed(w.maspTotal)} (cyan).`,
    `One pair of bars per UTC day from ${fmtDayMon(d[0].t)} to ${fmtDayMon(d[d.length - 1].t)}; a bar below the line is an outflow. The bridge's net is Osmosis → Namada less Namada → Osmosis (NAM into Namada); the pool's is shieldings and shielded IBC deposits less unshieldings, shielded withdrawals and fees.`,
  ];
  if (w.largest.bridge && w.largest.bridge.bridgeNet != null) {
    parts.push(`Largest bridge day ${fmtDayMon(w.largest.bridge.t)} (${signed(w.largest.bridge.bridgeNet)})${w.largest.masp && w.largest.masp.maspNet != null ? `; largest shielded day ${fmtDayMon(w.largest.masp.t)} (${signed(w.largest.masp.maspNet)})` : ''}.`);
  }
  return parts.join(' ');
}

/** The chart's name in the embed: "Price, 7 days", "Unlocks, next 30 days". */
export function chartTitle(name: ChartName, kind: DigestKind): string {
  const d = CHART_DAYS[kind][name];
  return name === 'pipeline' ? `${CHART_TITLES[name]}, next ${d} days` : `${CHART_TITLES[name]}, ${d} days`;
}

/** One chart as the message lists it: its attachment and caption, or the sentence that stands where it would be. */
export interface ChartCaption { name: ChartName; file: string; title: string; caption: string; notes: string[]; present: boolean }

/** The captions of a rendered set, in CHART_NAMES order. */
export function chartCaptions(set: ChartSet, shaped: ShapedCharts, kind: DigestKind): ChartCaption[] {
  return CHART_NAMES.map((name): ChartCaption => {
    const title = chartTitle(name, kind);
    const drawn = set.charts.find((c) => c.name === name);
    if (!drawn) {
      const left = set.leftOut.find((l) => l.name === name);
      return { name, file: '', title, caption: left?.sentence ?? `${CHART_TITLES[name]}: no chart.`, notes: [], present: false };
    }
    let caption: string;
    switch (drawn.name) {
      case 'price': caption = priceCaption(drawn.words, shaped.input.price as PriceInput); break;
      case 'stake': caption = stakeCaption(drawn.words, shaped.input.stake as StakeInput); break;
      case 'pipeline': caption = pipelineCaption(drawn.words, shaped.input.pipeline as PipelineInput); break;
      case 'flows': caption = flowsCaption(drawn.words); break;
    }
    return { name, file: drawn.file, title, caption, notes: shaped.notes[name], present: true };
  });
}
