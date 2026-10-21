// One request per key, cancelled when it is superseded (docs/design/nav-search-plan.md 4.4). The search palette and the
// lists ask through this hook so that a superseded keystroke or page never runs to completion on the Worker and the
// database, and a late answer for older text can never replace the answer for newer text:
//   - every request gets its own AbortController, aborted when a newer key arrives, when the key goes to null and
//     when the component unmounts (web/src/api.ts get() passes the signal to fetch);
//   - every request carries a sequence number, and an answer is used only while its number is the newest (the
//     abort is the first guard, the number the second, as the old `live` flag was);
//   - `debounceMs` waits for typing to pause before asking (150 ms in the palette, 250 ms in the list fields);
//     `flush()` asks at once (Enter);
//   - `keepPrevious` keeps the last answer reachable as `previous` while a newer key loads, so a screen never shows a
//     skeleton when it has rows to keep;
//   - `staleMs` reuses an answer from the in-memory cache when it is younger than that (no request at all), and
//     `prefetchQuery` fills that cache ahead of time (the next page, section 4.5). The cache lives in this tab only.
//
// The state machine is QueryRunner (plain TypeScript, no React, unit-tested); useQuery wraps it.
import { useEffect, useReducer, useRef } from 'react';

export interface QueryOptions {
  /** wait this long after the key last changed before asking (0: ask at once) */
  debounceMs?: number;
  /** keep the last answer as `previous` while a newer key loads */
  keepPrevious?: boolean;
  /** reuse a cached answer younger than this (ms); 0 or absent: always ask */
  staleMs?: number;
}

export interface QueryState<T> {
  /** the key this state is about (null: nothing asked) */
  key: string | null;
  /** the answer for `key`; null until it arrives */
  data: T | null;
  /** the last answer received, for whatever key (`previousKey`); kept while a newer key loads when keepPrevious */
  previous: T | null;
  previousKey: string | null;
  /** a request for `key` is waiting for the debounce or in flight */
  busy: boolean;
  /** the request for `key` failed (never set by a cancelled request) */
  error: unknown;
  /** the answer or the failure for `key` has arrived (true for a null key) */
  settled: boolean;
}

export type Fetcher<T> = (signal: AbortSignal) => Promise<T>;

// ---------------------------------------------------------------- the cache (this tab only)

const CACHE_MAX = 64;
const cache = new Map<string, { at: number; value: unknown }>();

function cacheGet<T>(key: string, staleMs: number | undefined, now: number): T | undefined {
  if (!staleMs || staleMs <= 0) return undefined;
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (now - hit.at > staleMs) {
    cache.delete(key);
    return undefined;
  }
  // most recently used last, so the oldest is evicted first
  cache.delete(key);
  cache.set(key, hit);
  return hit.value as T;
}

function cachePut(key: string, value: unknown, now: number) {
  cache.delete(key);
  cache.set(key, { at: now, value });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
}

/** Forget every cached answer (tests, and a sign-out that changes what a key answers). */
export function clearQueryCache() {
  cache.clear();
}

const inflight = new Map<string, Promise<unknown>>();
/**
 * Ask for `key` ahead of time and keep the answer in the cache (a list's next page, section 4.5 point 4). One
 * request per key at a time; a failure is dropped (the real request will say so). Pass a signal to cancel it.
 */
export function prefetchQuery<T>(key: string, fetcher: Fetcher<T>, opts: { staleMs: number; signal?: AbortSignal; now?: () => number }): Promise<T | undefined> {
  const now = opts.now ?? Date.now;
  const hit = cacheGet<T>(key, opts.staleMs, now());
  if (hit !== undefined) return Promise.resolve(hit);
  const running = inflight.get(key) as Promise<T | undefined> | undefined;
  if (running) return running;
  const ctrl = new AbortController();
  opts.signal?.addEventListener('abort', () => ctrl.abort(), { once: true });
  const p = fetcher(ctrl.signal).then(
    (v) => {
      if (!ctrl.signal.aborted) cachePut(key, v, now());
      return v;
    },
    () => undefined,
  ).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// ---------------------------------------------------------------- the state machine

const isAbort = (e: unknown) => !!e && typeof e === 'object' && (e as { name?: unknown }).name === 'AbortError';

const idle = <T>(previous: T | null = null, previousKey: string | null = null): QueryState<T> => ({
  key: null, data: null, previous, previousKey, busy: false, error: null, settled: true,
});

/**
 * One key at a time: `set(key)` cancels whatever was waiting or in flight for the old key and asks for the new one.
 * `onChange` is called after every state change. Timers are setTimeout; `now` is the cache clock.
 */
export class QueryRunner<T> {
  state: QueryState<T> = idle<T>();
  /** undefined: never set, or disposed (the next set always runs) */
  private current: string | null | undefined = undefined;
  private seq = 0;
  private ctrl: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private start: (() => void) | null = null;
  private fetcher: Fetcher<T> | null = null;
  private opts: QueryOptions = {};

  constructor(private readonly onChange: () => void = () => {}, private readonly now: () => number = Date.now) {}

  /** The key now asked for (undefined before the first set and after dispose). */
  get key(): string | null | undefined {
    return this.current;
  }

  set(key: string | null, fetcher: Fetcher<T>, opts: QueryOptions = {}) {
    this.fetcher = fetcher;
    this.opts = opts;
    if (key === this.current) return;
    this.run(key, false);
  }

  /** Ask for the current key again, past the cache and the debounce (Try again). */
  retry() {
    if (this.current == null || !this.fetcher) return;
    this.run(this.current, true);
  }

  /** Ask now instead of waiting for the debounce (Enter). Nothing happens when nothing is waiting. */
  flush() {
    if (!this.timer || !this.start) return;
    clearTimeout(this.timer);
    this.timer = null;
    const go = this.start;
    this.start = null;
    go();
  }

  /** Cancel everything (unmount). The next set() asks again even for the same key. */
  dispose() {
    this.cancel();
    this.seq++;
    this.current = undefined;
  }

  private cancel() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.start = null;
    this.ctrl?.abort();
    this.ctrl = null;
  }

  private emit(next: QueryState<T>) {
    this.state = next;
    this.onChange();
  }

  private run(key: string | null, force: boolean) {
    this.cancel();
    this.current = key;
    const seq = ++this.seq;
    const { previous, previousKey } = this.state;
    const keep = !!this.opts.keepPrevious;
    if (key == null) {
      this.emit(idle<T>(keep ? previous : null, keep ? previousKey : null));
      return;
    }
    const hit = force ? undefined : cacheGet<T>(key, this.opts.staleMs, this.now());
    if (hit !== undefined) {
      this.emit({ key, data: hit, previous: hit, previousKey: key, busy: false, error: null, settled: true });
      return;
    }
    this.emit({ key, data: null, previous: keep ? previous : null, previousKey: keep ? previousKey : null, busy: true, error: null, settled: false });
    const fetcher = this.fetcher!;
    const start = () => {
      this.timer = null;
      this.start = null;
      if (seq !== this.seq) return;
      const ctrl = new AbortController();
      this.ctrl = ctrl;
      let p: Promise<T>;
      try {
        p = fetcher(ctrl.signal);
      } catch (e) {
        p = Promise.reject(e);
      }
      p.then(
        (value) => {
          if (seq !== this.seq || ctrl.signal.aborted) return; // superseded or cancelled: never shown
          this.ctrl = null;
          cachePut(key, value, this.now());
          this.emit({ key, data: value, previous: value, previousKey: key, busy: false, error: null, settled: true });
        },
        (err: unknown) => {
          if (seq !== this.seq || ctrl.signal.aborted || isAbort(err)) return;
          this.ctrl = null;
          this.emit({ ...this.state, key, data: null, busy: false, error: err ?? new Error('The request failed.'), settled: true });
        },
      );
    };
    const wait = force ? 0 : this.opts.debounceMs ?? 0;
    if (wait > 0) {
      this.start = start;
      this.timer = setTimeout(start, wait);
    } else {
      start();
    }
  }
}

// ---------------------------------------------------------------- the hook

export interface QueryResult<T> extends QueryState<T> {
  /** ask now instead of after the debounce */
  flush: () => void;
  /** ask again for the current key (past the cache) */
  retry: () => void;
}

/**
 * `useQuery(key, fetcher, opts)`: the answer for `key` (null asks nothing). The fetcher gets the request's
 * AbortSignal and must pass it on. The fetcher may change between renders; only a new key asks again.
 */
export function useQuery<T>(key: string | null, fetcher: Fetcher<T>, opts: QueryOptions = {}): QueryResult<T> {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const ref = useRef<QueryRunner<T> | null>(null);
  if (!ref.current) ref.current = new QueryRunner<T>(rerender);
  const runner = ref.current;
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    runner.set(key, (signal) => fetcherRef.current(signal), optsRef.current);
  }, [runner, key]);
  // after the key effect, so a remount (React's strict mode runs effects twice) asks again
  useEffect(() => () => runner.dispose(), [runner]);

  const s = runner.state;
  // the render before the effect has run for a new key: nothing is known about it yet
  const state: QueryState<T> =
    runner.key === key && s.key === key
      ? s
      : { key, data: null, previous: opts.keepPrevious ? s.previous : null, previousKey: opts.keepPrevious ? s.previousKey : null, busy: key != null, error: null, settled: key == null };
  return { ...state, flush: () => runner.flush(), retry: () => runner.retry() };
}
