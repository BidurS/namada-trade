// Trade screen data (S2). The live-only requests (/api/quote, /api/quote/curve, /api/pools) are
// never made while rewound (N3, W12); the price history and the record of what was bought and sold go
// through the API's fetch wrapper, which adds ?at= under Rewind. Polls run only while the tab is visible,
// and the record of what was bought and sold is fetched only while the screen shows it (N9).
import { useCallback, useEffect, useRef, useState } from 'react';
import type { OrderflowResponse, PoolInfo, Provenance, QuoteCurveResponse } from '../../../../shared/types';
import { historyFetchHours } from '../../../../shared/history';
import { fetchMetricSeries, fetchOrderflow, fetchPools, fetchQuote, fetchQuoteCurve } from '../../api';
import { useVisible } from '../../app/index';
import type { ChartRange } from '../../ui/index';
import type { QuoteCode, QuoteResult, Side } from './model';
import { quoteKey } from './model';

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
  executed: { t: number; v: number }[];
  quoted: { t: number; v: number }[];
  /** the server's spacing of the executed points (null when it does not say) */
  executedBucketMs: number | null;
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

/** The server answered 404: it does not have this endpoint (an older deploy), as opposed to failing. */
const isUnserved = (e: unknown): boolean => e instanceof Error && /^HTTP 404\b/.test(e.message);

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
  useEffect(() => {
    if (!enabled) return;
    if (!visible && hasData) return;
    let alive = true;
    const run = () =>
      fnRef.current().then(
        (data) => {
          if (!alive) return;
          setState({ for: key, data, error: null, unserved: false, fetchedAt: Date.now(), failedAt: null });
        },
        (err: unknown) => {
          if (!alive) return;
          const error = historyFailWords(err);
          const unserved = isUnserved(err);
          // a refresh keeps the series it had for this key (marked old by the screen); a first load has nothing to keep
          setState((s) => (s.for === key && s.data ? { ...s, error, unserved, failedAt: Date.now() } : { for: key, data: null, error, unserved, fetchedAt: null, failedAt: Date.now() }));
        },
      );
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

/**
 * The executed-swap price (hourly medians, or longer buckets over long windows) and the recorded quoted price,
 * as of `at` under Rewind. Switching between 24h, 7d and 30d reuses the 30-day fetch; 90d, 1y and All fetch
 * deeper history (shared/history.ts). The executed price is an hourly median: a 5 min refresh is plenty.
 */
export function usePriceHistory(at: number | null, range: ChartRange = '30d'): HistoryLoad<History> {
  const hours = historyFetchHours(range);
  const key = `${at ?? 'live'}:${hours}`;
  return useHistory<History>(
    key,
    () =>
      Promise.all([fetchMetricSeries('price.swap_1h', hours, at), fetchMetricSeries('price.usd', hours, at)]).then(([e, q]) => ({
        executed: e.history.map((r) => ({ t: r.ts, v: r.value })),
        quoted: q.history.map((r) => ({ t: r.ts, v: r.value })),
        executedBucketMs: e.bucketMs,
      })),
    true,
    at ? null : 300_000,
  );
}

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
