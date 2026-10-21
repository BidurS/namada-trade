// Trade screen data (S2). The live-only requests (/api/quote, /api/quote/curve, /api/pools, /api/series/pairs)
// are never made while rewound (N3, W12); the price history, the price changes, the volume, the trades tape and
// the record of what was bought and sold go through the API's fetch wrapper, which adds ?at= under Rewind. Polls
// run only while the tab is visible, and the record of what was bought and sold is fetched only while the screen
// shows it (N9).
//
// The chart reads /api/series (screener-plan 2.12: each series with its sources, honest start and gaps); on a
// server that does not serve it yet (it answers 404 or 501) it reads the older /api/metrics/history for the
// executed and quoted prices, and the figures only the new route has (the hourly volume bars, the pool price, the
// start dates) read "—" with the reason, never a stand-in. The other series panels do the same with their own
// route: a route that is not served is a missing figure with its reason, not a fault, and is not asked again.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { OrderflowResponse, PairsResponse, PoolInfo, PriceChangesResponse, Provenance, QuoteCurveResponse, SeriesResponse, TradesResponse, VolumeResponse } from '../../../../shared/types';
import { NOT_SERVED, SERIES_STEP_MS, TRADES_TAPE_LIMIT } from '../../../../shared/types';
import { DAILY_DAYS, historyFetchHours } from '../../../../shared/history';
import { fetchMetricSeries, fetchOrderflow, fetchPairs, fetchPools, fetchPriceChanges, fetchQuote, fetchQuoteCurve, fetchSeries, fetchTrades, fetchVolume, isNotServed, type MetricPoint } from '../../api';
import { useVisible } from '../../app/index';
import type { ChartRange } from '../../ui/index';
import type { QuoteCode, QuoteResult, Side } from './model';
import { quoteKey } from './model';
import { bandOf, barsOf, flatOf, isLongRange, onPriceAxis, pointsOf, seriesWindow, startOf, type BandPt, type BarPt, type Pt, type SeriesStart } from './series';

export interface Load<T> {
  data: T | null;
  /** Plain words when the request itself failed (never the URL). */
  error: string | null;
  /** True until the first answer. */
  loading: boolean;
}

/**
 * How a resource keeps its last good answer when a refresh comes back empty or fails: the earlier
 * reading stays on screen with its own time, marked old, and says why (never a stand-in figure).
 */
interface Keep<T> {
  empty: (d: T) => boolean;
  why: (d: T) => string | undefined;
  stale: (prev: T, why: string) => T;
}

/** One live-only resource: fetched on mount and every `everyMs` while visible; never while `enabled` is false. */
function useLiveResource<T>(enabled: boolean, fn: () => Promise<T>, everyMs: number, failWords: string, keep: Keep<T>): Load<T> {
  const visible = useVisible();
  const [state, setState] = useState<Load<T>>({ data: null, error: null, loading: enabled });
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const keepRef = useRef(keep);
  keepRef.current = keep;
  useEffect(() => {
    if (!enabled) {
      setState({ data: null, error: null, loading: false });
      return;
    }
    if (!visible) return;
    let alive = true;
    const run = () =>
      fnRef.current().then(
        (data) =>
          alive &&
          setState((s) => {
            const k = keepRef.current;
            if (k.empty(data) && s.data && !k.empty(s.data)) return { data: k.stale(s.data, k.why(data) ?? failWords), error: null, loading: false };
            return { data, error: null, loading: false };
          }),
        () => alive && setState((s) => ({ data: s.data && !keepRef.current.empty(s.data) ? keepRef.current.stale(s.data, failWords) : s.data, error: failWords, loading: false })),
      );
    run();
    const id = window.setInterval(run, everyMs);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [enabled, visible, everyMs, failWords]);
  return state;
}

const TABLE_KEEP: Keep<QuoteCurveResponse> = {
  empty: (d) => !d.curve.length,
  why: (d) => d.prov.note,
  stale: (prev, why) => ({ ...prev, prov: { ...prev.prov, status: 'stale', note: `${why} This is the last size table it sent.` } }),
};

const POOLS_KEEP: Keep<{ pools: PoolInfo[]; prov: Provenance }> = {
  empty: (d) => !d.pools.length,
  why: (d) => d.prov.note,
  stale: (prev, why) => ({ ...prev, prov: { ...prev.prov, status: 'stale', note: `${why} These are the last pools it sent.` } }),
};

/** The size table: six real quotes at once (edge-cached 60 s by the worker). */
export const useSizeTable = (live: boolean) =>
  useLiveResource<QuoteCurveResponse>(live, fetchQuoteCurve, 60_000, 'The size table could not be fetched.', TABLE_KEEP);

/** The NAM pools on Osmosis. */
export const usePools = (live: boolean) =>
  useLiveResource<{ pools: PoolInfo[]; prov: Provenance }>(live, fetchPools, 120_000, 'The pool list could not be fetched.', POOLS_KEEP);

// ---------------------------------------------------------------- stored series over time

export interface History {
  executed: Pt[];
  quoted: Pt[];
  /** the server's spacing of the executed points (null when it does not say) */
  executedBucketMs: number | null;
  /** the quoted price's lowest and highest reading per hour (short ranges; empty when the answer has none) */
  band: BandPt[];
  /** the pool price (90d, 1y, All) from the Osmosis data API; null when not drawn (`poolMissing` says why on a long range) */
  pool: Pt[] | null;
  poolStepMs: number | null;
  /** pool steps in which no trade moved the pool */
  flatHours: number[];
  poolMissing: string | null;
  /** NAM traded per hour (24h, 7d, 30d); null when not drawn (`barsMissing` says why on a short range) */
  bars: BarPt[] | null;
  barsStepMs: number | null;
  barsMissing: string | null;
  /** when each drawn series honestly begins (screener-plan 3.9) */
  starts: SeriesStart[];
  executedStart: number | null;
  /** the series answers' own stamps (absent on the older read: the overview's stamps are used) */
  prov: { executed?: Provenance; quoted?: Provenance; pool?: Provenance; bars?: Provenance };
  /** true: read from /api/series; false: the older /api/metrics/history */
  fromSeries: boolean;
}

/**
 * A stored series fetched for a window, as of `at` under Rewind. A failed request is an error, never an empty
 * series: with nothing shown yet it says so (and the screen offers Try again); after a good answer a failed
 * refresh keeps that series, with `failedAt` set, so the screen marks it old and says since when. A server
 * that does not serve the record at all (it answers 404, as production does before a deploy that adds the
 * endpoint) is `unserved`: that is a missing figure with its reason, not a fault, and Try again is pointless.
 */
export interface HistoryLoad<T> extends Load<T> {
  /** When the series shown was fetched (unix ms). */
  fetchedAt: number | null;
  /** The last refresh failed: when. The series shown (if any) is the earlier one, kept, and is old. */
  failedAt: number | null;
  /** The server has no such record (HTTP 404): `error` holds the plain words. */
  unserved: boolean;
  /** Ask again now (the "Try again" button). */
  retry: () => void;
}

/** Why a series is not shown, in plain words (never a URL or a status line). */
export const historyFailWords = (e: unknown): string =>
  isUnserved(e) ? 'This server does not serve it yet.' : e instanceof Error && /HTTP \d+/.test(e.message) ? 'The server answered with an error.' : 'The server did not answer.';

/**
 * The server does not serve this route: 404 (an older deploy without it) or 501 (mounted, not built yet), as
 * opposed to failing. Anything that only reads "HTTP 404" (a hand-made error in a test) counts too.
 */
const isUnserved = (e: unknown): boolean => isNotServed(e) || (e instanceof Error && /^HTTP (404|501)\b/.test(e.message));

interface HistoryState<T> {
  for: string;
  data: T | null;
  error: string | null;
  unserved: boolean;
  fetchedAt: number | null;
  failedAt: number | null;
}

/**
 * One stored series keyed by `key` (the moment and the window): fetched when the key changes and every `everyMs`
 * while visible (null: never refreshed, a rewound window never changes); not at all while `enabled` is false.
 * The answer remembers which key it is for, so a new ?at= or window never shows the previous one.
 */
function useHistory<T>(key: string, fn: () => Promise<T>, enabled: boolean, everyMs: number | null): HistoryLoad<T> {
  const visible = useVisible();
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const [state, setState] = useState<HistoryState<T>>({ for: key, data: null, error: null, unserved: false, fetchedAt: null, failedAt: null });
  const [tick, setTick] = useState(0);
  const hasData = state.for === key && state.data != null;
  // a route this server does not serve is not asked again for the same key (only a new key or Try again asks)
  const unservedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    if (!visible && hasData) return;
    let alive = true;
    const me = `${key}|${tick}`;
    const run = () => {
      if (unservedFor.current === me) return;
      fnRef.current().then(
        (data) => {
          if (!alive) return;
          setState({ for: key, data, error: null, unserved: false, fetchedAt: Date.now(), failedAt: null });
        },
        (err: unknown) => {
          if (!alive) return;
          const error = historyFailWords(err);
          const unserved = isUnserved(err);
          unservedFor.current = unserved ? me : null;
          // a refresh keeps the series it had for this key (marked old by the screen); a first load has nothing to keep
          setState((s) => (s.for === key && s.data ? { ...s, error, unserved, failedAt: Date.now() } : { for: key, data: null, error, unserved, fetchedAt: null, failedAt: Date.now() }));
        },
      );
    };
    run();
    const id = everyMs ? window.setInterval(run, everyMs) : 0;
    return () => {
      alive = false;
      if (id) window.clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, visible, tick, everyMs]);
  const retry = useCallback(() => {
    // back to the waiting state while the new request is out (an earlier series, if any, stays shown)
    setState((s) => (s.for === key && !s.data ? { ...s, error: null, unserved: false } : s));
    setTick((n) => n + 1);
  }, [key]);
  const mine = state.for === key;
  const data = mine ? state.data : null;
  const error = mine ? state.error : null;
  return {
    data,
    error,
    loading: enabled && data == null && error == null,
    fetchedAt: mine ? state.fetchedAt : null,
    failedAt: mine && error ? state.failedAt : null,
    unserved: mine && error != null && state.unserved,
    retry,
  };
}

/** The route /api/series answered "not served" once: the chart reads the older history from then on (a deploy reloads the page). */
let seriesUnserved = false;

/** Why a figure only the series route has is not drawn, from the request's failure. */
const seriesMissWords = (e: unknown) => (isUnserved(e) ? NOT_SERVED : historyFailWords(e));

const drawn = (r: SeriesResponse) => (onPriceAxis(r) ? pointsOf(r) : []);

/** The chart from /api/series: executed and quoted always, then the hourly volume (short ranges) or the pool price (long ones). */
async function chartFromSeries(range: ChartRange, at: number | null): Promise<History | null> {
  const end = at ?? Date.now();
  const long = isLongRange(range);
  const win = seriesWindow(range, end);
  const q = (key: string) => fetchSeries({ key, from: win.from, step: win.step, asOf: at });
  const [eR, qR, xR] = await Promise.allSettled([q('price.swap_1h'), q('price.usd'), q(long ? 'price.pool_1h' : 'dex.swaps_1h.nam')]);
  if (eR.status === 'rejected') {
    if (isUnserved(eR.reason)) return null;
    throw eR.reason;
  }
  if (qR.status === 'rejected') throw qR.reason;
  const e = eR.value;
  const qu = qR.value;
  const x = xR.status === 'fulfilled' ? xR.value : null;
  const xMiss = xR.status === 'rejected' ? seriesMissWords(xR.reason) : null;
  const starts: SeriesStart[] = [startOf('executed price', e), startOf('quoted price', qu)];
  const out: History = {
    executed: drawn(e),
    quoted: drawn(qu),
    executedBucketMs: e.stepMs || SERIES_STEP_MS[win.step],
    band: long ? [] : bandOf(qu),
    pool: null,
    poolStepMs: null,
    flatHours: [],
    poolMissing: null,
    bars: null,
    barsStepMs: null,
    barsMissing: null,
    starts,
    executedStart: e.start ?? null,
    prov: { executed: e.prov, quoted: qu.prov },
    fromSeries: true,
  };
  if (long) {
    if (x && onPriceAxis(x)) {
      out.pool = pointsOf(x);
      out.poolStepMs = x.stepMs || SERIES_STEP_MS[win.step];
      out.flatHours = flatOf(x);
      out.prov.pool = x.prov;
      starts.push(startOf('pool price', x));
    } else out.poolMissing = xMiss ?? 'the pool price is not in dollars per NAM, so it is not drawn on this axis';
  } else if (x && x.unit === 'nam') {
    out.bars = barsOf(x);
    out.barsStepMs = x.stepMs || SERIES_STEP_MS[win.step];
    out.prov.bars = x.prov;
    starts.push(startOf('NAM traded per hour', x));
  } else out.barsMissing = xMiss ?? 'the hourly volume is not in NAM, so it is not drawn';
  return out;
}

const pts = (h: MetricPoint[]) => h.map((r) => ({ t: r.ts, v: r.value }));

/** The chart from the older /api/metrics/history (a server before the series route): the executed and quoted prices only. */
async function chartFromHistory(range: ChartRange, at: number | null): Promise<History> {
  const hours = historyFetchHours(range);
  const long = isLongRange(range);
  const [e, q] = await Promise.all([fetchMetricSeries('price.swap_1h', hours, at), fetchMetricSeries('price.usd', hours, at)]);
  const hourlyQuotes = q.bucketMs != null && q.bucketMs <= 3_600_000;
  const why = 'this server does not say when they begin yet';
  return {
    executed: pts(e.history),
    quoted: pts(q.history),
    executedBucketMs: e.bucketMs,
    band: !long && hourlyQuotes ? q.history.filter((r) => r.lo != null && r.hi != null && Number.isFinite(r.lo) && Number.isFinite(r.hi)).map((r) => ({ t: r.ts, lo: r.lo as number, hi: r.hi as number })) : [],
    pool: null,
    poolStepMs: null,
    flatHours: [],
    poolMissing: long ? NOT_SERVED : null,
    bars: null,
    barsStepMs: null,
    barsMissing: long ? null : NOT_SERVED,
    starts: [
      { what: 'executed price', at: null, backfilled: false, why },
      { what: 'quoted price', at: null, backfilled: false, why },
    ],
    executedStart: null,
    prov: {},
    fromSeries: false,
  };
}

/**
 * The chart's series for a range, as of `at` under Rewind: the executed-swap price (hourly medians, or longer
 * steps over long windows), the quoted price with its hourly band, and either the hourly volume (24h, 7d, 30d)
 * or the pool price (90d, 1y, All). Switching between 24h, 7d and 30d reuses the 30-day fetch; 90d, 1y and All
 * fetch deeper history (shared/history.ts). The executed price is an hourly median: a 5 min refresh is plenty.
 */
export function usePriceHistory(at: number | null, range: ChartRange = '30d'): HistoryLoad<History> {
  const hours = historyFetchHours(range);
  const key = `${at ?? 'live'}:${hours}`;
  return useHistory<History>(
    key,
    async () => {
      if (!seriesUnserved) {
        const r = await chartFromSeries(range, at);
        if (r) return r;
        seriesUnserved = true;
      }
      return chartFromHistory(range, at);
    },
    true,
    at ? null : 300_000,
  );
}

// ---------------------------------------------------------------- the series panels (screener-plan 2.1 to 2.5)

/** The quoted price's and the pool price's changes, each with the reading it is measured from. Refreshed every minute live. */
export const usePriceChanges = (at: number | null) => useHistory<PriceChangesResponse>(`${at ?? 'live'}`, () => fetchPriceChanges(at), true, at ? null : 60_000);

/** Executed volume per window with its definition, and the Osmosis pair summary's figure. Refreshed every 2 min live. */
export const useVolume = (at: number | null) => useHistory<VolumeResponse>(`${at ?? 'live'}`, () => fetchVolume(at), true, at ? null : 120_000);

/** The NAM pools with their Osmosis volume: a live reading, never asked while rewound. */
export const usePairs = (live: boolean) => useHistory<PairsResponse>(live ? 'live' : 'off', () => fetchPairs(), live, 120_000);

/** The days "How much trades against how little" draws (screener-plan 3.5b): shared/history.ts. */
export { DAILY_DAYS };

/** NAM bought and NAM sold per UTC day over the last DAILY_DAYS days: two daily sums of the hourly trade rows. */
export interface DailyTrades {
  buy: SeriesResponse;
  sell: SeriesResponse;
}
export const useDailyTrades = (at: number | null) =>
  useHistory<DailyTrades>(
    `${at ?? 'live'}`,
    async () => {
      const end = at ?? Date.now();
      const from = new Date(end - DAILY_DAYS * 86_400_000).toISOString().slice(0, 10);
      const [buy, sell] = await Promise.all([
        fetchSeries({ key: 'dex.swaps_1h.buy_nam', from, step: '1d', asOf: at }),
        fetchSeries({ key: 'dex.swaps_1h.sell_nam', from, step: '1d', asOf: at }),
      ]);
      return { buy, sell };
    },
    true,
    at ? null : 600_000,
  );

/** The newest trades (one maker's, when `maker` is set), as of `at` under Rewind; refreshed every minute live. */
export const TAPE_LIMIT = TRADES_TAPE_LIMIT;
export const useTrades = (at: number | null, maker: string | null) =>
  useHistory<TradesResponse>(`${at ?? 'live'}:${maker ?? ''}`, () => fetchTrades({ asOf: at, maker, limit: TAPE_LIMIT }), true, at ? null : 60_000);

/**
 * What was bought and sold on Osmosis over the window, in buckets (NAM bought and NAM sold per hour, or per
 * longer bucket over long windows, with the running difference), as of `at` under Rewind. Fetched only while
 * `enabled` (the screen shows it), and refreshed every 2 min while it is.
 */
export function useOrderflowHistory(at: number | null, range: ChartRange = '30d', enabled = true): HistoryLoad<OrderflowResponse> {
  const hours = historyFetchHours(range);
  const key = `${at ?? 'live'}:${hours}`;
  return useHistory<OrderflowResponse>(key, () => fetchOrderflow(hours, at), enabled, at ? null : 120_000);
}

const DOWN_WORDS = 'The Osmosis quote service is not answering.';

/**
 * The live quote for the ticket's amount and side. Asked on change (`immediate` skips the typing
 * debounce), again every 30 s while visible, and never while `enabled` is false (rewound).
 * Returns the latest settled result, for whichever amount and side it was asked; the screen compares its key.
 */
export function useQuote(enabled: boolean, side: Side, amount: number | null, immediate: boolean) {
  const visible = useVisible();
  const [result, setResult] = useState<QuoteResult | null>(null);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    if (!enabled || !visible) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 30_000);
    return () => window.clearInterval(id);
  }, [enabled, visible]);

  useEffect(() => {
    if (!enabled || amount == null || !(amount > 0)) return;
    const key = quoteKey(side, amount);
    const my = ++seq.current;
    const timer = window.setTimeout(
      () => {
        const askedAt = Date.now();
        fetchQuote(amount, side).then(
          (r) => {
            if (my !== seq.current) return;
            setResult({ key, amount, side, quote: r.quote ?? null, error: r.quote ? null : r.error ?? DOWN_WORDS, code: r.quote ? null : ((r as { code?: QuoteCode }).code ?? 'unavailable'), askedAt });
          },
          () => {
            if (my !== seq.current) return;
            setResult({ key, amount, side, quote: null, error: DOWN_WORDS, code: 'unavailable', askedAt });
          },
        );
      },
      immediate ? 0 : 400,
    );
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, side, amount, tick]);

  return { result };
}
