// Trade screen data (S2). The live-only requests (/api/quote, /api/quote/curve, /api/pools) are
// never made while rewound (N3, W12); the price history goes through the shell's fetch wrapper,
// which adds ?at= under Rewind. Polls run only while the tab is visible.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { OrderflowResponse, PoolInfo, Provenance, QuoteCurveResponse } from '../../../../shared/types';
import { fetchMetricHistory, fetchOrderflow, fetchPools, fetchQuote, fetchQuoteCurve } from '../../api';
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

export interface History {
  executed: { t: number; v: number }[];
  quoted: { t: number; v: number }[];
}

export interface HistoryLoad extends Load<History> {
  /** When the series shown was fetched (unix ms). */
  fetchedAt: number | null;
  /** The last refresh failed: when. The series shown (if any) is the earlier one, kept, and is old. */
  failedAt: number | null;
  /** Ask again now (the "Try again" button). */
  retry: () => void;
}

/** Why the price history is not shown, in plain words (never a URL or a status line). */
export const historyFailWords = (e: unknown): string =>
  e instanceof Error && /HTTP \d+/.test(e.message) ? 'The server answered with an error.' : 'The server did not answer.';

const rangeFetchHours = (range: ChartRange): number =>
  range === 'all' ? 24 * 1200 : range === '1y' ? 24 * 365 : range === '90d' ? 24 * 90 : 24 * 30;

interface HistoryState {
  for: string;
  data: History | null;
  error: string | null;
  fetchedAt: number | null;
  failedAt: number | null;
}

/**
 * Executed-swap price (hourly/6h/24h medians) and recorded quoted price across short or multi-month/year windows,
 * as of `at` under Rewind. Switching between 24h, 7d, and 30d reuses the 30-day fetch; 90d, 1y, and All fetch deeper history.
 */
export function usePriceHistory(at: number | null, range: ChartRange = '30d'): HistoryLoad {
  const visible = useVisible();
  const hours = rangeFetchHours(range);
  const key = `${at ?? 'live'}:${hours}`;
  const [state, setState] = useState<HistoryState>({ for: key, data: null, error: null, fetchedAt: null, failedAt: null });
  const [tick, setTick] = useState(0);
  const hasData = state.for === key && state.data != null;
  useEffect(() => {
    if (!visible && hasData) return;
    let alive = true;
    const run = () =>
      Promise.all([fetchMetricHistory('price.swap_1h', hours, at), fetchMetricHistory('price.usd', hours, at)]).then(
        ([e, q]) => {
          if (!alive) return;
          setState({ for: key, data: { executed: e.map((r) => ({ t: r.ts, v: r.value })), quoted: q.map((r) => ({ t: r.ts, v: r.value })) }, error: null, fetchedAt: Date.now(), failedAt: null });
        },
        (err: unknown) => {
          if (!alive) return;
          const error = historyFailWords(err);
          setState((s) => (s.for === key && s.data ? { ...s, error, failedAt: Date.now() } : { for: key, data: null, error, fetchedAt: null, failedAt: Date.now() }));
        },
      );
    run();
    const id = at ? 0 : window.setInterval(run, 300_000);
    return () => {
      alive = false;
      if (id) window.clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, visible, tick]);
  const retry = useCallback(() => {
    setState((s) => (s.for === key && !s.data ? { ...s, error: null } : s));
    setTick((n) => n + 1);
  }, [key]);
  const mine = state.for === key;
  const data = mine ? state.data : null;
  const error = mine ? state.error : null;
  return { data, error, loading: data == null && error == null, fetchedAt: mine ? state.fetchedAt : null, failedAt: mine && error ? state.failedAt : null, retry };
}

export interface OrderflowLoad extends Load<OrderflowResponse> {
  fetchedAt: number | null;
  failedAt: number | null;
  retry: () => void;
}

interface OrderflowState {
  for: string;
  data: OrderflowResponse | null;
  error: string | null;
  fetchedAt: number | null;
  failedAt: number | null;
}

/**
 * Signed orderflow & Cumulative Volume Delta (CVD) buckets across short or multi-month/year windows.
 */
export function useOrderflowHistory(at: number | null, range: ChartRange = '30d'): OrderflowLoad {
  const visible = useVisible();
  const hours = rangeFetchHours(range);
  const key = `${at ?? 'live'}:${hours}`;
  const [state, setState] = useState<OrderflowState>({ for: key, data: null, error: null, fetchedAt: null, failedAt: null });
  const [tick, setTick] = useState(0);
  const hasData = state.for === key && state.data != null;
  useEffect(() => {
    if (!visible && hasData) return;
    let alive = true;
    const run = () =>
      fetchOrderflow(hours, at).then(
        (d) => {
          if (!alive) return;
          setState({ for: key, data: d, error: null, fetchedAt: Date.now(), failedAt: null });
        },
        (err: unknown) => {
          if (!alive) return;
          const error = historyFailWords(err);
          setState((s) => (s.for === key && s.data ? { ...s, error, failedAt: Date.now() } : { for: key, data: null, error, fetchedAt: null, failedAt: Date.now() }));
        },
      );
    run();
    const id = at ? 0 : window.setInterval(run, 120_000);
    return () => {
      alive = false;
      if (id) window.clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, visible, tick]);
  const retry = useCallback(() => {
    setState((s) => (s.for === key && !s.data ? { ...s, error: null } : s));
    setTick((n) => n + 1);
  }, [key]);
  const mine = state.for === key;
  const data = mine ? state.data : null;
  const error = mine ? state.error : null;
  return { data, error, loading: data == null && error == null, fetchedAt: mine ? state.fetchedAt : null, failedAt: mine && error ? state.failedAt : null, retry };
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
