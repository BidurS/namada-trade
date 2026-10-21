import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryRunner, clearQueryCache, prefetchQuery } from '../web/src/lib/useQuery';
import { RECENT_KEY, RECENT_LEGACY_KEY, RECENT_MAX, clearRecent, frecency, noteRecent, readRecent, recentScore, topRecent, type RecentStore } from '../web/src/app/recent';

const DAY = 86_400_000;
const memStore = (init: Record<string, string> = {}): RecentStore & { data: Map<string, string> } => {
  const data = new Map(Object.entries(init));
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, String(v)), removeItem: (k) => void data.delete(k) };
};

/** A fetcher whose answers the test releases by hand; it records each call's signal. */
function manual<T>() {
  const calls: { key: string; signal: AbortSignal; resolve: (v: T) => void; reject: (e: unknown) => void }[] = [];
  const make = (key: string) => (signal: AbortSignal) =>
    new Promise<T>((resolve, reject) => {
      calls.push({ key, signal, resolve, reject });
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  return { calls, make };
}

describe('QueryRunner (lib/useQuery.ts)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearQueryCache();
  });
  afterEach(() => vi.useRealTimers());

  it('debounces, then asks once; a newer key cancels the older request and its late answer is never shown', async () => {
    const f = manual<string>();
    let changes = 0;
    const r = new QueryRunner<string>(() => changes++);
    r.set('a', f.make('a'), { debounceMs: 150 });
    expect(r.state).toMatchObject({ key: 'a', busy: true, settled: false, data: null });
    vi.advanceTimersByTime(149);
    expect(f.calls.length).toBe(0);
    vi.advanceTimersByTime(1);
    expect(f.calls.map((c) => c.key)).toEqual(['a']);
    r.set('ab', f.make('ab'), { debounceMs: 150 });
    expect(f.calls[0].signal.aborted).toBe(true); // cancelled on the wire
    vi.advanceTimersByTime(150);
    expect(f.calls.map((c) => c.key)).toEqual(['a', 'ab']);
    f.calls[0].resolve('A late'); // the old answer arrives anyway
    await vi.runAllTimersAsync();
    expect(r.state.data).toBeNull();
    f.calls[1].resolve('AB');
    await vi.runAllTimersAsync();
    expect(r.state).toMatchObject({ key: 'ab', data: 'AB', busy: false, settled: true, error: null });
    expect(changes).toBeGreaterThan(0);
  });

  it('keystrokes inside the debounce send no request at all', () => {
    const f = manual<string>();
    const r = new QueryRunner<string>();
    for (const k of ['z', 'zo', 'zon', 'zond', 'zonda']) {
      r.set(k, f.make(k), { debounceMs: 150 });
      vi.advanceTimersByTime(40);
    }
    vi.advanceTimersByTime(150);
    expect(f.calls.map((c) => c.key)).toEqual(['zonda']);
  });

  it('the sequence guard drops an answer even when the fetcher ignores the signal', async () => {
    const resolvers: ((v: string) => void)[] = [];
    const deaf = () => new Promise<string>((res) => resolvers.push(res)); // never listens to abort
    const r = new QueryRunner<string>();
    r.set('x', deaf, {});
    r.set('y', deaf, {});
    resolvers[0]('X');
    await vi.runAllTimersAsync();
    expect(r.state.data).toBeNull();
    resolvers[1]('Y');
    await vi.runAllTimersAsync();
    expect(r.state.data).toBe('Y');
  });

  it('a failure is an error for its key; a cancelled request is not', async () => {
    const f = manual<string>();
    const r = new QueryRunner<string>();
    r.set('bad', f.make('bad'), {});
    f.calls[0].reject(new Error('HTTP 503'));
    await vi.runAllTimersAsync();
    expect(r.state).toMatchObject({ key: 'bad', settled: true, busy: false });
    expect(String(r.state.error)).toContain('503');
    r.set('next', f.make('next'), {});
    r.set(null, f.make('none'), {});
    await vi.runAllTimersAsync();
    expect(f.calls[1].signal.aborted).toBe(true);
    expect(r.state).toMatchObject({ key: null, error: null, settled: true, busy: false, data: null });
  });

  it('keepPrevious keeps the last answer as previous while the next key loads; flush asks at once', async () => {
    const f = manual<string>();
    const r = new QueryRunner<string>();
    r.set('a', f.make('a'), { debounceMs: 150, keepPrevious: true });
    r.flush();
    expect(f.calls.length).toBe(1);
    f.calls[0].resolve('A');
    await vi.runAllTimersAsync();
    r.set('ab', f.make('ab'), { debounceMs: 150, keepPrevious: true });
    expect(r.state).toMatchObject({ key: 'ab', data: null, previous: 'A', previousKey: 'a', busy: true });
  });

  it('staleMs reuses a recent answer without a request; retry asks again past the cache', async () => {
    const f = manual<string>();
    const r = new QueryRunner<string>(undefined, () => Date.now());
    r.set('k', f.make('k'), { staleMs: 15_000 });
    f.calls[0].resolve('K1');
    await vi.runAllTimersAsync();
    r.set('other', f.make('other'), { staleMs: 15_000 });
    r.set('k', f.make('k'), { staleMs: 15_000 });
    expect(r.state).toMatchObject({ key: 'k', data: 'K1', settled: true });
    expect(f.calls.map((c) => c.key)).toEqual(['k', 'other']);
    r.retry();
    expect(f.calls.map((c) => c.key)).toEqual(['k', 'other', 'k']);
    vi.advanceTimersByTime(16_000);
    const r2 = new QueryRunner<string>(undefined, () => Date.now());
    r2.set('k', f.make('k2'), { staleMs: 15_000 });
    expect(r2.state.busy).toBe(true); // older than staleMs: asked again
  });

  it('dispose cancels, and the next set asks again for the same key (a strict-mode remount)', () => {
    const f = manual<string>();
    const r = new QueryRunner<string>();
    r.set('s', f.make('s'), {});
    r.dispose();
    expect(f.calls[0].signal.aborted).toBe(true);
    r.set('s', f.make('s'), {});
    expect(f.calls.length).toBe(2);
  });

  it('prefetchQuery fills the cache once per key', async () => {
    let n = 0;
    const fetcher = async () => `v${++n}`;
    await Promise.all([prefetchQuery('p', fetcher, { staleMs: 60_000 }), prefetchQuery('p', fetcher, { staleMs: 60_000 })]);
    expect(n).toBe(1);
    const r = new QueryRunner<string>();
    r.set('p', fetcher, { staleMs: 60_000 });
    expect(r.state).toMatchObject({ data: 'v1', busy: false });
    expect(n).toBe(1);
  });
});

describe('recent (app/recent.ts): this browser only', () => {
  const now = Date.UTC(2026, 9, 20, 12);

  it('counts opens, keeps the newest first, merges a label, and ranks by frecency', () => {
    const s = memStore();
    noteRecent('address', 'tnam1qaaa', { now: now - 10 * DAY, store: s, label: 'Old friend' });
    noteRecent('address', 'tnam1qaaa', { now: now - 9 * DAY, store: s });
    noteRecent('search', '  Zondax  ', { now: now - DAY, store: s });
    noteRecent('search', 'zondax', { now, store: s });
    noteRecent('view', '/holders', { now, store: s, label: 'Holders' });
    const list = readRecent(s, now);
    expect(list.map((e) => `${e.kind}:${e.key}:${e.opens}`)).toEqual(['view:/holders:1', 'search:zondax:2', 'address:tnam1qaaa:2']);
    expect(list.find((e) => e.kind === 'address')?.label).toBe('Old friend');
    expect(frecency({ opens: 2, lastAt: now - 7 * DAY }, now)).toBeCloseTo(1, 6);
    expect(topRecent(list, 2, now).map((e) => e.key)).toEqual(['zondax', '/holders']);
    expect(recentScore(list, 'search', 'ZONDAX', now)).toBeGreaterThan(1.8);
    expect(recentScore(list, 'address', 'tnam1qzzz', now)).toBe(0);
  });

  it('never keeps more than RECENT_MAX, dropping the lowest frecency', () => {
    const s = memStore();
    noteRecent('search', 'often', { now: now - DAY, store: s });
    noteRecent('search', 'often', { now: now - DAY, store: s });
    noteRecent('search', 'often', { now: now - DAY, store: s });
    for (let i = 0; i < RECENT_MAX + 5; i++) noteRecent('search', `term ${i}`, { now: now - (RECENT_MAX + 5 - i) * 60_000, store: s });
    const list = readRecent(s, now);
    expect(list.length).toBe(RECENT_MAX);
    expect(list.some((e) => e.key === 'often')).toBe(true);
  });

  it('moves the first build\'s nt.recentAddr once, in its order, and removes it', () => {
    const s = memStore({ [RECENT_LEGACY_KEY]: JSON.stringify(['tnam1qnew', 'osmo1old', 42, 'not an address']) });
    const list = readRecent(s, now);
    expect(list.map((e) => e.key)).toEqual(['tnam1qnew', 'osmo1old']);
    expect(topRecent(list, 5, now).map((e) => e.key)).toEqual(['tnam1qnew', 'osmo1old']);
    expect(s.data.has(RECENT_LEGACY_KEY)).toBe(false);
    expect(JSON.parse(s.data.get(RECENT_KEY)!)).toHaveLength(2);
  });

  it('drops malformed stored values instead of guessing, and survives storage that throws', () => {
    const s = memStore({ [RECENT_KEY]: JSON.stringify([{ kind: 'address', key: 'javascript:alert(1)', opens: 1, lastAt: now }, { kind: 'view', key: '//evil.example', opens: 1, lastAt: now }, { kind: 'search', key: 'ok', opens: -3, lastAt: now }, { kind: 'nope', key: 'x', opens: 1, lastAt: now }, 'junk']) });
    expect(readRecent(s, now)).toEqual([{ kind: 'search', key: 'ok', opens: 1, lastAt: now }]);
    const broken: RecentStore = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => { throw new Error('denied'); } };
    expect(readRecent(broken, now)).toEqual([]);
    expect(() => noteRecent('search', 'x', { store: broken, now })).not.toThrow();
    expect(() => clearRecent(broken)).not.toThrow();
    expect(readRecent(null)).toEqual([]);
  });

  it('Clear recent removes both keys', () => {
    const s = memStore({ [RECENT_LEGACY_KEY]: '[]' });
    noteRecent('search', 'x', { store: s, now });
    clearRecent(s);
    expect([...s.data.keys()]).toEqual([]);
  });
});
