// Pieces the Supply (S3) and Shielded (S4) screens share: the sentences that say a list is old,
// the window words and the refreshing loader. The list pieces (AddrName, RecordLink, YouTag,
// useShowAll) are in ui/ListBits.tsx.
import React, { useEffect, useRef, useState } from 'react';
import { useVisible } from '../../app/index';
import { NBSP, fmtAgo, fmtUtcClock } from '../../lib/format';
import type { Stamp } from '../../lib/prov';

// ---------------------------------------------------------------- loading and refreshing

const MIN = 60_000;

export interface LiveLoad<T> {
  data: T | null;
  /** the request for this view failed and there is nothing to show */
  failed: boolean;
  /** a new view (another window) is on its way; the figures shown are the previous view's */
  busy: boolean;
  /** when the figures shown were fetched */
  fetchedAt: number | null;
  /** the last refresh failed (the figures shown are kept, and are old): when it failed */
  refreshFailedAt: number | null;
}

/**
 * Fetch a screen's figures for a view (`key`; `at` is the Rewind time) and, while live and the tab is visible,
 * refresh them every `everyMs` and when the tab becomes visible again. A new rewound moment drops the old
 * figures (skeletons; never shown as if they were then); another view keeps them dimmed until the answer
 * comes. A refresh that fails keeps the figures and reports it (refreshFailedAt), so the screen can mark them
 * old with the reason instead of dropping to skeletons.
 */
export function useLiveLoad<T>(at: number | null, key: string, load: () => Promise<T>, everyMs = 2 * MIN): LiveLoad<T> {
  const visible = useVisible();
  const [tick, setTick] = useState(0);
  const [st, setSt] = useState<LiveLoad<T>>({ data: null, failed: false, busy: true, fetchedAt: null, refreshFailedAt: null });
  const lastAt = useRef(at);
  const shown = useRef<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;

  // live: refresh on a timer while visible, and as soon as the tab is visible again
  const wasVisible = useRef(visible);
  useEffect(() => {
    const back = visible && !wasVisible.current;
    wasVisible.current = visible;
    if (at != null || !visible) return;
    if (back) setTick((n) => n + 1);
    const t = setInterval(() => setTick((n) => n + 1), everyMs);
    return () => clearInterval(t);
  }, [at, visible, everyMs]);

  useEffect(() => {
    let alive = true;
    const view = `${at ?? 'live'}|${key}`;
    const refresh = shown.current === view;
    if (lastAt.current !== at) {
      lastAt.current = at;
      shown.current = null;
      setSt({ data: null, failed: false, busy: true, fetchedAt: null, refreshFailedAt: null });
    } else if (!refresh) setSt((s) => ({ ...s, failed: false, busy: true }));
    loadRef.current().then(
      (data) => {
        if (!alive) return;
        shown.current = view;
        setSt({ data, failed: false, busy: false, fetchedAt: Date.now(), refreshFailedAt: null });
      },
      () => {
        if (!alive) return;
        // a refresh keeps what is shown; a new view has nothing true to show
        if (refresh) setSt((s) => ({ ...s, refreshFailedAt: Date.now() }));
        else {
          shown.current = null;
          setSt({ data: null, failed: true, busy: false, fetchedAt: null, refreshFailedAt: null });
        }
      },
    );
    return () => {
      alive = false;
    };
  }, [at, key, tick]);

  return st;
}

/** The note on every stamp of figures kept after a failed refresh (lib/prov.ts ageOutStamps). */
export const refreshFailedNote = (fetchedAt: number | null): string => `The latest refresh did not answer, so this is the reading fetched at ${fmtUtcClock(fetchedAt)}.`;

/** One sentence for figures kept after a failed refresh. */
export const refreshFailedSentence = (fetchedAt: number | null, now: number): React.ReactNode => (
  <>The latest refresh did not answer, so these figures are from {fmtAgo(fetchedAt, now)} and are shown dimmed.</>
);

// ---------------------------------------------------------------- old lists

/** One sentence for a list whose records are old (system.md 8, SourceLine): said once, above the rows. */
export const oldRowsSentence = (p: Stamp | null | undefined, now: number, what = 'these rows'): React.ReactNode =>
  p?.at != null ? <>The flow index last checked the chain {fmtAgo(p.at, now)}, so {what} are shown dimmed.</> : <>The flow index has no recorded time, so {what} are shown dimmed.</>;

export const isOld = (p: Stamp | null | undefined) => !!p && (p.status === 'stale' || p.status === 'missing');

// ---------------------------------------------------------------- windows

export type WindowDays = 1 | 7 | 30 | 90 | 365;
export const WINDOW_WORDS: Record<WindowDays, string> = {
  1: 'day',
  7: `7${NBSP}days`,
  30: `30${NBSP}days`,
  90: `90${NBSP}days`,
  365: 'year',
};
/** "the last day", "the last 7 days", "the last year" (number and unit never split over two lines) */
export const lastWindow = (d: number) => (d === 1 ? 'the last day' : d === 365 ? 'the last year' : `the last ${d}${NBSP}days`);
