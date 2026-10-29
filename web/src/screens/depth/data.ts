// Depth screen data (step S5). The minute (/api/depth) and a quote walked on it (/api/depth/quote) are live readings,
// never asked while rewound (the quote is in REWIND_LIVE_ONLY; the minute takes no `at` and is not asked either); a
// rewound page reads the stored figures of that minute from /api/depth/history, which goes through the shell's fetch
// wrapper with ?at=. The stored trades of the last week come from /api/series/trades, paged behind its cursor.
//
// The minute is asked again every DEPTH_REFRESH_MS while the tab is visible (depth plan section 4; the edge keeps it
// DEPTH_EDGE_SECONDS) and at once when a swap arrives on the live stream (`nudge`: the newest Osmosis buy or sell the
// shell streamed), at most once per NUDGE_MIN_MS. A refresh that fails keeps the last answer, marked old with the time
// it was fetched, so a figure is never shown fresh beside a failure (N2). A server without the routes (404) is
// `unserved`: a missing page with its reason, never a fault, and not asked again.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DepthChangeRow, DepthChangesResponse, DepthHeatResponse, DepthHistoryResponse, DepthOwnersApiResponse, DepthQuoteResponse, DepthResponse } from '../../../../shared/depth';
import { CHANGES_LIMIT_MAX, CURVE_TRADES_DAYS, DEPTH_FAILED, DEPTH_REFRESH_MS, DEPTH_UNSERVED, QUOTE_DEBOUNCE_MS, QUOTE_FAILED, TRADES_FAILED, TRADES_NO_PAGE, roundQuoteNam } from '../../../../shared/depth';
import { TRADES_TAPE_LIMIT, type Provenance, type TradeRow } from '../../../../shared/types';
import { ApiError, fetchDepth, fetchDepthChanges, fetchDepthHeat, fetchDepthHistory, fetchDepthOwners, fetchDepthQuote, fetchTrades, isNotServed } from '../../api';
import { useVisible } from '../../app/index';

/** The stored trades' source name, as the Activity tape names it (a stamp's `source`, shown in the sheet, never in running text). */
export const FLOW_INDEX_SOURCE = 'D1 flow index';

/** A swap on the stream asks the minute again, but not more often than this (the edge copy is 30 s anyway). */
export const NUDGE_MIN_MS = 10_000;
/** The trades pages read for the curve's marks (TRADES_TAPE_LIMIT rows each): the newest 300 trades of the week at most. */
export const TRADES_PAGES_MAX = 5;

export interface Loaded<T> {
  data: T | null;
  /** Plain words when the request failed (never a URL). */
  error: string | null;
  /** The server has no such route (404): `error` holds the plain words. */
  unserved: boolean;
  loading: boolean;
  /** When the answer shown was fetched (unix ms). */
  fetchedAt: number | null;
  /** The last refresh failed at this time; the answer shown is the earlier one, kept, and is old. */
  failedAt: number | null;
  retry: () => void;
}

/** Why a request is not answered, in plain words (never a URL or a status line). */
export const failWords = (e: unknown, failed: string): string => (isNotServed(e) ? DEPTH_UNSERVED : e instanceof ApiError && e.reason ? e.reason : failed);

interface St<T> {
  key: string;
  data: T | null;
  error: string | null;
  unserved: boolean;
  fetchedAt: number | null;
  failedAt: number | null;
}

/**
 * One resource keyed by `key` (null: not asked): fetched when the key changes, every `everyMs` while visible (null:
 * never again) and whenever `nudge` changes (at most once per NUDGE_MIN_MS). The answer remembers its key, so a new
 * ?at= never shows the previous moment's figures under the new one.
 */
function useLoaded<T>(key: string | null, fn: (signal: AbortSignal) => Promise<T>, everyMs: number | null, failed: string, nudge = ''): Loaded<T> {
  const visible = useVisible();
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const [state, setState] = useState<St<T>>({ key: key ?? '', data: null, error: null, unserved: false, fetchedAt: null, failedAt: null });
  const [tick, setTick] = useState(0);
  const unservedFor = useRef<string | null>(null);
  const lastAt = useRef(0);
  const hasData = state.key === key && state.data != null;
  useEffect(() => {
    if (key == null) return;
    if (!visible && hasData) return;
    const me = `${key}|${tick}`;
    if (unservedFor.current === me) return;
    const ctrl = new AbortController();
    let alive = true;
    const run = () => {
      if (!alive) return;
      lastAt.current = Date.now();
      fnRef.current(ctrl.signal).then(
        (data) => alive && setState({ key, data, error: null, unserved: false, fetchedAt: Date.now(), failedAt: null }),
        (err: unknown) => {
          if (!alive || ctrl.signal.aborted) return;
          const error = failWords(err, failed);
          const unserved = isNotServed(err);
          unservedFor.current = unserved ? me : null;
          setState((s) => (s.key === key && s.data ? { ...s, error, unserved, failedAt: Date.now() } : { key, data: null, error, unserved, fetchedAt: null, failedAt: Date.now() }));
        },
      );
    };
    run();
    const id = everyMs ? window.setInterval(run, everyMs) : 0;
    return () => {
      alive = false;
      ctrl.abort();
      if (id) window.clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, visible, tick, everyMs]);
  // a swap on the stream: ask again now, unless the minute was asked within NUDGE_MIN_MS
  useEffect(() => {
    if (!nudge || key == null || !visible) return;
    if (Date.now() - lastAt.current < NUDGE_MIN_MS) return;
    setTick((n) => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nudge]);
  const retry = useCallback(() => {
    setState((s) => (s.key === key && !s.data ? { ...s, error: null, unserved: false } : s));
    setTick((n) => n + 1);
  }, [key]);
  const mine = state.key === key && key != null;
  const data = mine ? state.data : null;
  const error = mine ? state.error : null;
  return { data, error, unserved: mine && error != null && state.unserved, loading: key != null && data == null && error == null, fetchedAt: mine ? state.fetchedAt : null, failedAt: mine && error ? state.failedAt : null, retry };
}

/** The newest stored minute, live only; `nudge` is the newest streamed Osmosis swap's id. */
export const useDepthLatest = (live: boolean, nudge: string, everyMs: number | null = DEPTH_REFRESH_MS) => useLoaded<DepthResponse>(live ? 'live' : null, (signal) => fetchDepth({ signal }), everyMs, DEPTH_FAILED, nudge);

/** The stored minutes around a rewound moment: the last ten before it, so the newest at or before `at` can be read. */
export const useDepthHistoryAt = (at: number | null) =>
  useLoaded<DepthHistoryResponse>(at != null ? `at:${at}` : null, (signal) => fetchDepthHistory({ pool: 'all', from: (at ?? 0) - 10 * 60_000, to: (at ?? 0) + 1, step: '1m', asOf: at }, { signal }), null, DEPTH_FAILED);

export interface QuoteResult {
  key: string;
  side: 'sell' | 'buy';
  nam: number;
  quote: DepthQuoteResponse | null;
  error: string | null;
  askedAt: number;
}
export const quoteKey = (side: 'sell' | 'buy', nam: number) => `${side}:${roundQuoteNam(nam)}`;

/**
 * A quote walked on the stored minute for a typed size (one of the stored sizes needs no request: the minute carries
 * it). Asked after QUOTE_DEBOUNCE_MS of typing (`immediate` skips the wait), again when the minute changes (`minuteAt`),
 * never while `enabled` is false (rewound). The latest settled result is returned with its key; the screen compares.
 */
export function useDepthQuote(enabled: boolean, side: 'sell' | 'buy', nam: number | null, immediate: boolean, minuteAt: number | null) {
  const [result, setResult] = useState<QuoteResult | null>(null);
  const seq = useRef(0);
  useEffect(() => {
    if (!enabled || nam == null || !(nam > 0)) return;
    const key = quoteKey(side, nam);
    const my = ++seq.current;
    const ctrl = new AbortController();
    const timer = window.setTimeout(
      () => {
        const askedAt = Date.now();
        fetchDepthQuote(side, roundQuoteNam(nam), { signal: ctrl.signal }).then(
          (q) => my === seq.current && setResult({ key, side, nam, quote: q, error: null, askedAt }),
          (e: unknown) => my === seq.current && !ctrl.signal.aborted && setResult({ key, side, nam, quote: null, error: failWords(e, QUOTE_FAILED), askedAt }),
        );
      },
      immediate ? 0 : QUOTE_DEBOUNCE_MS,
    );
    return () => {
      window.clearTimeout(timer);
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, side, nam, minuteAt]);
  return result;
}

export interface TradesWeek {
  rows: TradeRow[];
  /** The week's trades were more than the pages read: the rows are the newest `rows.length`. */
  cut: boolean;
  asOf: number;
  /** The flow index's own stamp (the newest page's). */
  prov: Provenance;
  since: number;
}

/** The stored trades of the last CURVE_TRADES_DAYS days (as of `at` under Rewind), newest first, at most TRADES_PAGES_MAX pages. */
export function useTradesWeek(at: number | null) {
  const end = at ?? null;
  return useLoaded<TradesWeek>(
    `trades:${at ?? 'live'}`,
    async (signal) => {
      const now = end ?? Date.now();
      const since = now - CURVE_TRADES_DAYS * 86_400_000;
      const rows: TradeRow[] = [];
      let before: string | null = null;
      let cut = false;
      let prov: Provenance = { at: null, status: 'missing', source: FLOW_INDEX_SOURCE, note: TRADES_NO_PAGE };
      let asOf = now;
      for (let page = 0; page < TRADES_PAGES_MAX; page++) {
        const r = await fetchTrades({ before, asOf: at, limit: TRADES_TAPE_LIMIT }, { signal });
        prov = r.prov;
        asOf = r.asOf;
        rows.push(...r.rows.filter((x) => x.ts >= since));
        const oldest = r.rows[r.rows.length - 1];
        if (!r.next || !oldest || oldest.ts < since) break;
        before = r.next;
        if (page === TRADES_PAGES_MAX - 1) cut = true;
      }
      return { rows, cut, asOf, prov, since };
    },
    at ? null : 5 * 60_000,
    TRADES_FAILED,
  );
}

// ---------------------------------------------------------------- step S6: the time view and the owners

/** The heat bands of the last `days` (as of `at` under Rewind), asked again every DEPTH_REFRESH_MS while live and visible. */
export const useDepthHeat = (days: number, at: number | null) =>
  useLoaded<DepthHeatResponse>(`heat:${days}:${at ?? 'live'}`, (signal) => fetchDepthHeat(days, at, { signal }), at ? null : DEPTH_REFRESH_MS, DEPTH_FAILED);

/**
 * The stored figures of the aggregate over the last `days` for the executable line: minute rows up to a week (the row cap
 * holds thirty days of minutes, but a week is already ten thousand points), hourly rows for the month, each with the
 * hour's own lowest and highest. The window's end is now or the rewound moment.
 */
export const useDepthHistoryWindow = (days: number, at: number | null) => {
  const step: '1m' | '1h' = days > 7 ? '1h' : '1m';
  return useLoaded<DepthHistoryResponse>(
    `hist:${days}:${at ?? 'live'}`,
    (signal) => {
      const end = at ?? Date.now();
      return fetchDepthHistory({ pool: 'all', from: end - days * 86_400_000, to: end + 1, step, asOf: at }, { signal });
    },
    at ? null : DEPTH_REFRESH_MS,
    DEPTH_FAILED,
  );
};

/** The newest hour's owners: live only (the kv row holds the newest hour; a rewound page says so). */
export const useDepthOwners = (live: boolean) => useLoaded<DepthOwnersApiResponse>(live ? 'owners' : null, (signal) => fetchDepthOwners({ signal }), 5 * 60_000, DEPTH_FAILED);

/** The change rows read for a window: at most this many pages of CHANGES_LIMIT_MAX rows (the newest). */
export const CHANGES_PAGES_MAX = 5;
export interface ChangesWindow {
  rows: DepthChangeRow[];
  /** True when the window held more rows than the pages read: the rows are the newest. */
  cut: boolean;
  from: number;
  to: number;
  prov: DepthChangesResponse['prov'];
}
/**
 * The change rows of the last `days` (to `at` under Rewind: the route takes no `at`, so the rows after the moment are
 * dropped here and the pages run until the window's start or the page cap). Newest first.
 */
export function useDepthChanges(days: number, at: number | null) {
  return useLoaded<ChangesWindow>(
    `changes:${days}:${at ?? 'live'}`,
    async (signal) => {
      const to = at ?? Date.now();
      const from = to - days * 86_400_000;
      const rows: DepthChangeRow[] = [];
      let before: string | null = null;
      let cut = false;
      let prov: DepthChangesResponse['prov'] = [];
      for (let page = 0; page < CHANGES_PAGES_MAX; page++) {
        const r = await fetchDepthChanges({ before, limit: CHANGES_LIMIT_MAX }, { signal });
        if (page === 0 || !prov.length) prov = r.prov;
        rows.push(...r.rows.filter((x) => x.ts >= from && x.ts <= to));
        const oldest = r.rows[r.rows.length - 1];
        if (!r.next || !oldest || oldest.ts < from) break;
        before = r.next;
        if (page === CHANGES_PAGES_MAX - 1) cut = true;
      }
      return { rows, cut, from, to, prov };
    },
    at ? null : DEPTH_REFRESH_MS,
    DEPTH_FAILED,
  );
}
