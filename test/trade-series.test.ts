// The Trade screen's pure model (web/src/screens/trade/series.ts, screener-plan 2.1 to 2.7): series requests by range,
// what a series answer becomes on the chart, the change cells, the trades tape's folding, and the derived values.
import { describe, it, expect } from 'vitest';
import type { Flow, PriceChange, SeriesResponse, TradeRow, TradesResponse } from '../shared/types';
import { SERIES_MAX_POINTS, SERIES_STEP_MS } from '../shared/types';
import {
  adjacentPairs, allNamValue, bandOf, barsOf, changeCells, durationWords, flatOf, foldTrades, groupsOfPage, isLongRange, joinGroups, lateBase,
  listWords, onPriceAxis, pointsOf, runsOf, seriesStepFor, seriesWindow, slotsOf, spendableValue, startOf, tapeOf, tradeOfFlow, turnoverPct, vsPaidPct,
} from '../web/src/screens/trade/series';

const H = 3_600_000;
const DAY = 24 * H;

const series = (over: Partial<SeriesResponse> = {}): SeriesResponse => ({
  key: 'price.swap_1h', from: 0, to: 10 * H, step: '1h', stepMs: H, agg: 'last', unit: 'usd_per_nam', points: [],
  sources: [{ source: 'executed NAM/USDC swaps (hourly median)', from: null, to: null, start: 2 * H, startNote: '', backfilled: false }],
  start: 2 * H, sparse: true, coverage: { steps: 8, withPoint: 0 }, gaps: [], prov: { source: 'x', at: null, status: 'missing' }, asOf: 10 * H, ...over,
});

const row = (i: number, ts: number, kind: 'buy' | 'sell', maker: string | null, nam = 100, valueUsd: number | null = 0.1, route = ['3005']): TradeRow => ({
  id: `r${i}`, ts, height: 1000 - i, tsSource: 'block', kind, nam, counterSymbol: 'USDC', counterAmount: valueUsd, priceUsd: valueUsd == null ? null : valueUsd / nam,
  priceSource: valueUsd == null ? null : 'execution', valueUsd, maker, makerLabelPlain: null, makerTrades: null, route, txHash: `T${i}`, pattern: null,
});
/** The server's fold rule (TradesResponse.foldMs, foldUnderNam). */
const RULE = { foldMs: 600_000, underNam: 2000 };

describe('the chart requests', () => {
  it('picks the finest step that keeps the answer within SERIES_MAX_POINTS', () => {
    expect(seriesStepFor(30)).toBe('1h');
    expect(seriesStepFor(90)).toBe('1h');
    expect(seriesStepFor(365)).toBe('6h');
    expect(seriesStepFor(1200)).toBe('1d');
    for (const d of [1, 30, 90, 124, 125, 365, 749, 750, 1200, 3000]) expect((d * DAY) / SERIES_STEP_MS[seriesStepFor(d)]).toBeLessThanOrEqual(SERIES_MAX_POINTS);
  });
  it('asks from a UTC day, so a window keeps one cache entry for the day', () => {
    const end = Date.parse('2026-10-20T22:09:03Z');
    expect(seriesWindow('30d', end)).toEqual({ days: 30, from: '2026-09-20', step: '1h', stepMs: H });
    expect(seriesWindow('24h', end).from).toBe('2026-09-20');
    expect(seriesWindow('1y', end)).toMatchObject({ from: '2025-10-20', step: '6h' });
    expect(seriesWindow('all', end).step).toBe('1d');
    expect(isLongRange('90d') && isLongRange('1y') && isLongRange('all')).toBe(true);
    expect(isLongRange('30d') || isLongRange('7d') || isLongRange('24h')).toBe(false);
  });
});

describe('a series answer on the chart', () => {
  it('keeps points in time order and only finite ones; the band only where lo and hi exist; flat steps; bars never negative', () => {
    const r = series({ points: [{ t: 3 * H, v: 2, lo: 1, hi: 3, flat: true }, { t: H, v: 1 }, { t: 2 * H, v: Number.NaN }, { t: 4 * H, v: -1 }] });
    expect(pointsOf(r).map((p) => p.t)).toEqual([H, 3 * H, 4 * H]);
    // a point keeps its newest reading's own time when the answer sends one (the chart's ages read it)
    expect(pointsOf(series({ points: [{ t: 6 * H, v: 1, at: 9 * H }, { t: 0, v: 1 }] }))).toEqual([{ t: 0, v: 1 }, { t: 6 * H, v: 1, at: 9 * H }]);
    expect(bandOf(r)).toEqual([{ t: 3 * H, lo: 1, hi: 3 }]);
    expect(flatOf(r)).toEqual([3 * H]);
    expect(barsOf(r).map((b) => b.t)).toEqual([H, 3 * H]);
  });
  it('draws a series on the price axis only in dollars per NAM', () => {
    expect(onPriceAxis(series())).toBe(true);
    expect(onPriceAxis(series({ unit: 'nam' }))).toBe(false);
    expect(onPriceAxis(null)).toBe(false);
  });
  it('joins two executed points only when both steps traded', () => {
    const pts = [0, 1, 3, 4, 5, 9].map((h) => ({ t: h * H, v: 1 }));
    expect(adjacentPairs(pts, H).map(([a, b]) => [a.t / H, b.t / H])).toEqual([[0, 1], [3, 4], [4, 5]]);
  });
  it('breaks a line where the record has no reading', () => {
    expect(runsOf([0, 1, 2, 6, 7].map((h) => ({ t: h * H })), 2 * H).map((r) => r.length)).toEqual([3, 2]);
  });
  it('counts slots and empty slots from the window, so 3 trade hours in 24 read as 21 empty', () => {
    const now = 100.5 * H;
    const bars = [98, 97, 91].map((h) => ({ t: h * H, nam: 1, usd: null, n: 1 }));
    const s = slotsOf(bars, now - DAY, now, H);
    expect(s).toMatchObject({ slots: 24, withBar: 3 });
    expect(s.empty).toHaveLength(21);
  });
  it('says when a series starts, and why when it cannot', () => {
    expect(startOf('executed price', series())).toEqual({ what: 'executed price', at: 2 * H, backfilled: false });
    expect(startOf('executed price', series({ start: null }))).toMatchObject({ at: null, why: 'the series has no reading yet' });
    expect(startOf('pool price', null)).toMatchObject({ at: null, why: 'this server does not say when it begins' });
    expect(startOf('x', series({ sources: [{ source: 's', from: 0, to: 1, start: 1, startNote: '', backfilled: true }] })).backfilled).toBe(true);
  });
});

describe('price changes', () => {
  const ch = (pct: number | null, note?: string): PriceChange => ({
    window: 'h24', windowMs: DAY, pct, now: { value: 2, at: DAY }, base: pct == null ? null : { value: 1, at: 120_000 }, baseLagMs: pct == null ? null : 120_000,
    prov: { source: 'Osmosis SQS', at: DAY, status: pct == null ? 'missing' : 'live', ...(note ? { note } : {}) }, ...(note ? { note } : {}),
  });
  it('shows windows with a base and lists the others with the server reason once, never as 0', () => {
    const note = 'The quoted price has been recorded since 15 Oct 2026.';
    const c = changeCells({ h1: ch(1), h6: ch(-2), h24: ch(8.1), d7: ch(null, note), d30: ch(null, note) }, ['h1', 'h6', 'h24', 'd7', 'd30']);
    expect(c.shown.map((x) => x.word)).toEqual(['1 h', '6 h', '24 h']);
    expect(c.notYet).toEqual({ words: ['7 days', '30 days'], notes: [note] });
    expect(listWords(c.notYet.words)).toBe('7 days and 30 days');
    expect(listWords(['1 h', '6 h', '24 h'])).toBe('1 h, 6 h and 24 h');
  });
  it('says "recorded since" once when several windows wait for the same start', () => {
    const n = (w: string, d: string) => `The quoted price has been recorded since 15 Oct 2026, so its ${w} change is known from ${d}.`;
    const c = changeCells({ h1: ch(1), d7: ch(null, n('7-day', '21 Oct 2026')), d30: ch(null, n('30-day', '12 Nov 2026')) }, ['h1', 'd7', 'd30']);
    expect(c.notYet.notes).toEqual(['The quoted price has been recorded since 15 Oct 2026, so its 7-day change is known from 21 Oct 2026 and its 30-day change from 12 Nov 2026.']);
    expect(changeCells({ d7: ch(null, n('7-day', '21 Oct 2026')), d30: ch(null, 'A gap.') }, ['d7', 'd30']).notYet.notes).toEqual([n('7-day', '21 Oct 2026'), 'A gap.']);
  });
  it('a window missing from the answer is not covered', () => {
    expect(changeCells({}, ['y1']).notYet.words).toEqual(['1 year']);
  });
  it('a base read more than a minute late is said', () => {
    expect(lateBase(ch(1))).toBe(120_000);
    expect(lateBase({ ...ch(1), baseLagMs: 30_000 })).toBeNull();
  });
});

describe('the trades tape', () => {
  it('folds consecutive trades by one maker on one side within the fold time, and nothing else', () => {
    const rows = [
      row(1, 100 * 60_000, 'buy', 'A'), row(2, 95 * 60_000, 'buy', 'A'), row(3, 86 * 60_000, 'buy', 'A'),
      row(4, 70 * 60_000, 'buy', 'A'), // 16 min after the last: a new run
      row(5, 69 * 60_000, 'sell', 'A'), // other side
      row(6, 68 * 60_000, 'sell', 'B'), // other maker
      row(7, 67 * 60_000, 'buy', null), row(8, 66 * 60_000, 'buy', null), // makers unknown never fold
    ];
    const g = foldTrades(rows, RULE);
    expect(g.map((x) => x.n)).toEqual([3, 1, 1, 1, 1, 1]);
    expect(g[0]).toMatchObject({ maker: 'A', kind: 'buy', ids: ['r1', 'r2', 'r3'], nam: 300, firstTs: 86 * 60_000, lastTs: 100 * 60_000 });
    expect(g[0].avgPriceUsd).toBeCloseTo(0.001);
  });
  it('sums dollars over the priced rows only and counts the rest; no price at all is null, never 0', () => {
    const g = foldTrades([row(1, 3, 'buy', 'A', 100, 0.2), row(2, 2, 'buy', 'A', 100, null)], RULE)[0];
    expect(g).toMatchObject({ usd: 0.2, unpriced: 1, avgPriceUsd: 0.002 });
    const none = foldTrades([row(1, 3, 'buy', 'A', 100, null)], RULE)[0];
    expect(none).toMatchObject({ usd: null, avgPriceUsd: null, unpriced: 1 });
  });
  it("uses the server's groups, and folds here when they do not cover the page exactly", () => {
    const rows = [row(1, 3 * 60_000, 'buy', 'A'), row(2, 2 * 60_000, 'buy', 'A'), row(3, 60_000, 'sell', 'B')];
    const page: TradesResponse = {
      rows, groups: [{ maker: 'A', kind: 'buy', ids: ['r1', 'r2'], n: 2, nam: 200, usd: 0.2, unpriced: 0, avgPriceUsd: 0.001, firstTs: 2 * 60_000, lastTs: 3 * 60_000, pattern: 'repeated_small_buys' },
        { maker: 'B', kind: 'sell', ids: ['r3'], n: 1, nam: 100, usd: 0.1, unpriced: 0, avgPriceUsd: 0.001, firstTs: 60_000, lastTs: 60_000, pattern: null }],
      next: null, asOf: 0, foldMs: 600_000, patternRule: { minBuys: 20, underNam: 2000, windowMs: DAY }, prov: { source: 'D1 flow index', at: 0, status: 'live' }, firstTs: 0,
    };
    const g = groupsOfPage(page);
    expect(g.map((x) => x.ids)).toEqual([['r1', 'r2'], ['r3']]);
    expect(g[0].pattern).toBe('repeated_small_buys');
    // a group naming a row the page lacks: folded here instead, every row once
    const broken = groupsOfPage({ ...page, groups: [{ ...page.groups[0], ids: ['r1', 'rX'] }] });
    expect(broken.flatMap((x) => x.ids).sort()).toEqual(['r1', 'r2', 'r3']);
    // a row in no group: folded here instead
    expect(groupsOfPage({ ...page, groups: [page.groups[0]] }).flatMap((x) => x.ids)).toEqual(['r1', 'r2', 'r3']);
  });
  it('joins a run cut at a boundary when the older part continues it', () => {
    const a = foldTrades([row(1, 10 * 60_000, 'buy', 'A')], RULE, true);
    const b = foldTrades([row(2, 5 * 60_000, 'buy', 'A'), row(3, 60_000, 'sell', 'A')], RULE);
    const j = joinGroups(a, b, RULE);
    expect(j.map((x) => x.ids)).toEqual([['r1', 'r2'], ['r3']]);
    expect(j[0].live).toBe(false);
    expect(joinGroups([], b, RULE)).toBe(b);
  });
  it('folds only trades each under the size bound and through a pool the whole run shares, as the server does', () => {
    // a 750,000 NAM buy 4 minutes after a 120 NAM buy by the same address: two rows, never "2 buys of about 375,060 NAM"
    expect(foldTrades([row(2, 4 * 60_000, 'buy', 'A', 750_000), row(1, 0, 'buy', 'A', 120)], RULE).map((g) => g.n)).toEqual([1, 1]);
    // exactly at the bound is not under it
    expect(foldTrades([row(2, 60_000, 'buy', 'A', 2000), row(1, 0, 'buy', 'A', 120)], RULE).map((g) => g.n)).toEqual([1, 1]);
    // routes differ but share pool 3005: one run; a row through none of the run's common pools starts a new one
    const g = foldTrades([row(1, 3 * 60_000, 'buy', 'A', 100, 0.1, ['3368', '3005']), row(2, 2 * 60_000, 'buy', 'A', 100, 0.1, ['3005', '1']), row(3, 60_000, 'buy', 'A', 100, 0.1, ['3368'])], RULE);
    expect(g.map((x) => x.ids)).toEqual([['r1', 'r2'], ['r3']]);
    // a row with no route never folds
    expect(foldTrades([row(1, 60_000, 'buy', 'A', 100, 0.1, []), row(2, 0, 'buy', 'A', 100, 0.1, [])], RULE).map((x) => x.n)).toEqual([1, 1]);
    // a large live trade is never joined onto the page's first run of small ones
    const small = foldTrades([row(2, 4 * 60_000, 'buy', 'A', 150), row(3, 0, 'buy', 'A', 140)], RULE);
    expect(small.map((x) => x.n)).toEqual([2]);
    const big = foldTrades([row(1, 8 * 60_000, 'buy', 'A', 2_000_000)], RULE, true);
    expect(joinGroups(big, small, RULE).map((x) => x.n)).toEqual([1, 2]);
    // nor a small live trade onto a page run it shares no pool with
    const other = foldTrades([row(1, 8 * 60_000, 'buy', 'A', 100, 0.1, ['1'])], RULE, true);
    expect(joinGroups(other, small, RULE).map((x) => x.n)).toEqual([1, 2]);
  });
  it('takes a live Osmosis buy or sell as a tape row, never a bot round trip, another chain or another kind', () => {
    const f: Flow = { id: 'osmosis:L1:swap', chain: 'osmosis', height: 9, ts: 9, txHash: 'L1', kind: 'buy', from: null, to: 'osmo1to', amount: 1179, counterDenom: 'USDC', counterAmount: 1.37, poolId: '3368,3005', priceUsd: 1.37 / 1179, valueUsd: 1.37, meta: { trader: 'osmo1signer' } };
    const r = tradeOfFlow(f)!;
    expect(r).toMatchObject({ maker: 'osmo1signer', nam: 1179, priceSource: 'execution', route: ['3368', '3005'], makerTrades: null, pattern: null });
    expect(tradeOfFlow({ ...f, meta: { trader: 'osmo1signer', arb: true } })).toBeNull();
    expect(tradeOfFlow({ ...f, chain: 'namada' })).toBeNull();
    expect(tradeOfFlow({ ...f, kind: 'lp_add' })).toBeNull();
    const unpriced = tradeOfFlow({ ...f, priceUsd: null, valueUsd: null })!;
    expect(unpriced).toMatchObject({ priceUsd: null, priceSource: null, valueUsd: null, priceNote: 'No price was recorded for this trade.' });
    expect(tradeOfFlow({ ...f, meta: {} })!.maker).toBe('osmo1to');
    expect(tradeOfFlow({ ...f, kind: 'sell', from: 'osmo1from', to: null, meta: {} })!.maker).toBe('osmo1from');
  });
  it('puts live trades newer than the page on top, at most `max` groups; without a page the tape is the stream alone', () => {
    const page: TradesResponse = {
      rows: [row(1, 1000, 'sell', 'B')], groups: [], next: null, asOf: 0, foldMs: 600_000, patternRule: { minBuys: 20, underNam: 2000, windowMs: DAY },
      prov: { source: 'D1 flow index', at: 0, status: 'live' }, firstTs: 0,
    };
    const live = (id: string, ts: number, kind: 'buy' | 'sell' = 'buy', amount = 10): Flow => ({ id, chain: 'osmosis', height: ts, ts, txHash: id, kind, from: null, to: 'osmo1x', amount, poolId: '3005', priceUsd: 0.001, valueUsd: 0.01, meta: { trader: 'osmo1x' } });
    const t = tapeOf(page, [live('a', 2000), live('b', 500), live('r1', 3000)], { foldMs: 600_000, max: 20 });
    expect(t.groups.map((g) => g.ids)).toEqual([['a'], ['r1']]);
    expect(t).toMatchObject({ streamed: 1, fromStream: false });
    expect(tapeOf(null, [live('a', 2000), live('b', 500)], { foldMs: 600_000, max: 20 }).groups.map((g) => g.ids)).toEqual([['a', 'b']]);
    expect(tapeOf(null, [live('a', 2000), live('b', 500, 'sell')], { foldMs: 600_000, max: 1 }).groups).toHaveLength(1);
    expect(tapeOf(null, [live('a', 2000)], { foldMs: 600_000, max: 20, maker: 'osmo1other' }).groups).toEqual([]);
    // the size bound holds on the stream too (no page: the published rule), and the page's own bound when it states one
    expect(tapeOf(null, [live('a', 2000, 'buy', 750_000), live('b', 500, 'buy', 120)], { foldMs: 600_000, max: 20 }).groups.map((g) => g.n)).toEqual([1, 1]);
    expect(tapeOf({ ...page, foldUnderNam: 50 }, [live('a', 2000, 'buy', 100), live('b', 1500, 'buy', 120)], { max: 20 }).groups.map((g) => g.n)).toEqual([1, 1, 1]);
  });
});

describe('derived values', () => {
  it('all NAM and spendable NAM at today’s price; null when an input is missing, never a stand-in', () => {
    expect(allNamValue(1_147_657_323, 0.0011664)).toBeCloseTo(1_338_627.5, 0);
    expect(spendableValue(645_713_820, 19_757_918, 0.0011664)).toBeCloseTo(776_206.24, 1);
    expect(allNamValue(null, 0.001)).toBeNull();
    expect(spendableValue(1, null, 0.001)).toBeNull();
    expect(spendableValue(1, 1, 0)).toBeNull();
  });
  it('turnover and the price against what buyers paid', () => {
    expect(turnoverPct(325, 2008)).toBeCloseTo(16.19, 2);
    expect(turnoverPct(325, 0)).toBeNull();
    expect(vsPaidPct(0.001166, 0.000894)).toBeCloseTo(30.43, 2);
    expect(vsPaidPct(0.001, null)).toBeNull();
  });
  it('rule spans in words', () => {
    expect(durationWords(600_000)).toBe('10 minutes');
    expect(durationWords(DAY)).toBe('24 hours');
    expect(durationWords(7 * DAY)).toBe('7 days');
    expect(durationWords(H)).toBe('an hour');
  });
});
