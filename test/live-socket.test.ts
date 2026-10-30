// Scale plan 2026-10-29, Stage 1 item 7: the page's live socket (web/src/app/live-socket.ts, used by overview.tsx).
// The hub holds every socket in memory and walks them all on each message, and a tab left open in the background kept
// its socket for good; after a deploy every page came back 3 s later in the same second, then at 6, 12, 24 and 30 s.
// Now a tab hidden for 5 minutes closes its socket and opens one at once when it shows again, each wait before a
// reconnect has 0 to 3 s added at random (the 3 s doubling to 30 s is as it was), and every opening after the first
// says so, so the page fetches the recent moves again (seedInto) and a move made while the socket was closed is listed.
// The review of 2026-10-29 found two holes in that: the fetch at the opening can be answered from a copy the edge and
// the browser kept from before it (15 s and 5 s), which lacks a move made while the socket was closed, and a move
// streamed before the fetch answered made a fetch that did not reach back to the list look as if it did. The list now
// is fetched again SEED_SETTLE_MS after the opening, and a fetch is judged against the newest move listed when the
// socket closed (openLiveFeed), never against a move streamed since.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HIDDEN_CLOSE_MS, RECONNECT_FIRST_MS, RECONNECT_JITTER_MS, RECONNECT_MAX_MS, SEED_SETTLE_MS, openLiveFeed, openLiveSocket, reconnectDelay, seedInto } from '../web/src/app/live-socket';
import type { Flow } from '../shared/types';

afterEach(() => { vi.useRealTimers(); });

/** A browser socket: the test opens it, closes it from the server's side, and sees the page close it. */
class FakeWs {
  static all: FakeWs[] = [];
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  closedByPage = false;
  constructor(readonly url: string) { FakeWs.all.push(this); }
  close() {
    if (this.closedByPage) return;
    this.closedByPage = true;
    void Promise.resolve().then(() => this.onclose?.());
  }
  open() { this.onopen?.(); }
  drop() { this.onclose?.(); }
}
const last = () => FakeWs.all[FakeWs.all.length - 1];

/** The page's visibility store, as overview.tsx's: a value and subscribers. */
function page(visible = true) {
  const subs = new Set<() => void>();
  return {
    visible: () => visible,
    subscribeVisible: (cb: () => void) => { subs.add(cb); return () => subs.delete(cb); },
    set(v: boolean) { visible = v; subs.forEach((f) => f()); },
    subs,
  };
}

function start(opts: { visible?: boolean; random?: () => number } = {}) {
  FakeWs.all = [];
  const p = page(opts.visible ?? true);
  const log = { opens: [] as boolean[], closes: 0, messages: [] as unknown[], settled: [] as number[] };
  const sock = openLiveSocket({
    url: 'wss://namada.trade/ws',
    visible: p.visible, subscribeVisible: p.subscribeVisible,
    onOpen: (again) => log.opens.push(again),
    onSettled: () => log.settled.push(Date.now()),
    onMessage: (d) => log.messages.push(d),
    onClose: () => { log.closes++; },
    WebSocketImpl: FakeWs as unknown as new (url: string) => WebSocket,
    random: opts.random ?? (() => 0.5),
  });
  return { p, log, sock };
}

describe('the reconnect wait', () => {
  it('is the backoff and 0 to 3 s more, whatever the random part gives', () => {
    for (const backoff of [RECONNECT_FIRST_MS, 6000, RECONNECT_MAX_MS]) {
      expect(reconnectDelay(backoff, () => 0)).toBe(backoff);
      expect(reconnectDelay(backoff, () => 0.5)).toBe(backoff + 1500);
      expect(reconnectDelay(backoff, () => 0.999999)).toBe(backoff + 2999);
      for (const r of [1, 2, -1, NaN, Infinity]) {
        const d = reconnectDelay(backoff, () => r);
        expect(d, String(r)).toBeGreaterThanOrEqual(backoff);
        expect(d, String(r)).toBeLessThanOrEqual(backoff + RECONNECT_JITTER_MS);
      }
      const draws = Array.from({ length: 2000 }, () => reconnectDelay(backoff));
      expect(Math.min(...draws)).toBeGreaterThanOrEqual(backoff);
      expect(Math.max(...draws)).toBeLessThan(backoff + RECONNECT_JITTER_MS);
      // spread over the whole window: the pages a deploy disconnects do not all come back in one second
      expect(Math.min(...draws)).toBeLessThan(backoff + 300);
      expect(Math.max(...draws)).toBeGreaterThan(backoff + 2700);
    }
  });

  it('grows as before, 3 s doubling to 30 s, with its random part; an open sets it back to 3 s and says it is a reopening', async () => {
    vi.useFakeTimers();
    const { log } = start({ random: () => 0.5 });
    expect(FakeWs.all).toHaveLength(1);
    last().open();
    expect(log.opens).toEqual([false]);
    const waits: number[] = [];
    for (let i = 0; i < 6; i++) {
      const n = FakeWs.all.length;
      last().drop();
      let waited = 0;
      while (FakeWs.all.length === n) { await vi.advanceTimersByTimeAsync(100); waited += 100; }
      waits.push(waited);
    }
    expect(waits).toEqual([3000, 6000, 12000, 24000, 30000, 30000].map((b) => b + 1500));
    expect(log.closes).toBe(6);
    last().open();
    expect(log.opens).toEqual([false, true]);
    const n = FakeWs.all.length;
    last().drop();
    await vi.advanceTimersByTimeAsync(RECONNECT_FIRST_MS + 1499);
    expect(FakeWs.all).toHaveLength(n);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWs.all).toHaveLength(n + 1);
  });
});

describe('a hidden tab', () => {
  it('keeps its socket for 5 minutes, then closes it and opens none while hidden; shown again, it opens one at once and says it is a reopening', async () => {
    vi.useFakeTimers();
    const { p, log } = start();
    last().open();
    p.set(false);
    await vi.advanceTimersByTimeAsync(HIDDEN_CLOSE_MS - 1);
    expect(last().closedByPage).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(last().closedByPage).toBe(true);
    expect(log.closes).toBe(1);
    // its own close event, when it comes, says nothing more, and nothing reconnects for the hour it stays hidden
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(FakeWs.all).toHaveLength(1);
    expect(log.closes).toBe(1);
    p.set(true);
    expect(FakeWs.all).toHaveLength(2);
    last().open();
    expect(log.opens).toEqual([false, true]);
  });

  it('shown again before 5 minutes, it keeps the socket, and the next time it is hidden the 5 minutes start again', async () => {
    vi.useFakeTimers();
    const { p } = start();
    last().open();
    p.set(false);
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    p.set(true);
    p.set(false);
    p.set(false); // a second hidden event does not restart the count
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(last().closedByPage).toBe(false);
    expect(FakeWs.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(last().closedByPage).toBe(true);
  });

  it('opened in the background, it counts from then; one waiting to reconnect stops waiting', async () => {
    vi.useFakeTimers();
    const { p } = start({ visible: false });
    last().open();
    await vi.advanceTimersByTimeAsync(HIDDEN_CLOSE_MS);
    expect(last().closedByPage).toBe(true);
    p.set(true);
    expect(FakeWs.all).toHaveLength(2);
    // the server drops it while the tab is hidden again: the wait for the next try ends at the 5 minutes
    last().open();
    p.set(false);
    await vi.advanceTimersByTimeAsync(HIDDEN_CLOSE_MS - 2000);
    last().drop();
    await vi.advanceTimersByTimeAsync(2000);
    expect(FakeWs.all).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(RECONNECT_MAX_MS * 4);
    expect(FakeWs.all).toHaveLength(2);
    p.set(true);
    expect(FakeWs.all).toHaveLength(3);
  });

  it('close() ends it for good: no reconnect, no close callback, and the page\'s visibility is let go', async () => {
    vi.useFakeTimers();
    const { p, log, sock } = start();
    last().open();
    sock.close();
    expect(last().closedByPage).toBe(true);
    await vi.advanceTimersByTimeAsync(RECONNECT_MAX_MS * 4);
    expect(FakeWs.all).toHaveLength(1);
    expect(log.closes).toBe(0);
    expect(p.subs.size).toBe(0);
    last().onmessage?.({ data: '{"type":"hello"}' });
    expect(log.messages).toEqual([]);
  });
});

describe('the second fetch, past the caches', () => {
  it(`comes SEED_SETTLE_MS (${SEED_SETTLE_MS / 1000} s) after each opening but the first, and not for a socket that closed before`, async () => {
    vi.useFakeTimers();
    const { p, log, sock } = start({ random: () => 0 });
    last().open();
    await vi.advanceTimersByTimeAsync(SEED_SETTLE_MS * 2);
    expect(log.settled).toEqual([]);
    last().drop();
    await vi.advanceTimersByTimeAsync(RECONNECT_FIRST_MS);
    last().open();
    const opened = Date.now();
    await vi.advanceTimersByTimeAsync(SEED_SETTLE_MS);
    expect(log.settled).toEqual([opened + SEED_SETTLE_MS]);
    // dropped 10 s after it opened again: no second fetch for it; the next opening has its own
    last().drop();
    await vi.advanceTimersByTimeAsync(RECONNECT_FIRST_MS);
    last().open();
    await vi.advanceTimersByTimeAsync(10_000);
    last().drop();
    await vi.advanceTimersByTimeAsync(SEED_SETTLE_MS * 2);
    expect(log.settled).toHaveLength(1);
    last().open();
    await vi.advanceTimersByTimeAsync(SEED_SETTLE_MS);
    expect(log.settled).toHaveLength(2);
    // a tab shown again opens one at once, and it has its own; close() before its time leaves none
    p.set(false);
    await vi.advanceTimersByTimeAsync(HIDDEN_CLOSE_MS);
    p.set(true);
    last().open();
    await vi.advanceTimersByTimeAsync(SEED_SETTLE_MS);
    expect(log.settled).toHaveLength(3);
    last().drop();
    await vi.advanceTimersByTimeAsync(RECONNECT_FIRST_MS);
    last().open();
    await vi.advanceTimersByTimeAsync(SEED_SETTLE_MS - 1);
    sock.close();
    await vi.advanceTimersByTimeAsync(SEED_SETTLE_MS);
    expect(log.settled).toHaveLength(3);
  });
});

describe('seedInto: the recent moves fetched again when the socket opens', () => {
  const f = (id: string, ts: number) => ({ id, ts } as Flow);
  it('merges with the moves listed when nothing is missing, or when it reaches back to the newest move listed at the close', () => {
    const prev = [f('s3', 300), f('a', 200), f('b', 100)];
    expect(seedInto(prev, [f('c', 250), f('a', 200)], 100).map((x) => x.id)).toEqual(['s3', 'c', 'a', 'b']);
    expect(seedInto(prev, [f('c', 250), f('a', 200)], 100, { reach: 200, since: new Set(['s3']) }).map((x) => x.id)).toEqual(['s3', 'c', 'a', 'b']);
    expect(seedInto([f('a', 200), f('b', 100)], [f('y', 900), f('x', 800)], 100).map((x) => x.id)).toEqual(['y', 'x', 'a', 'b']);
  });
  it('replaces them when it does not: the moves between would be missing with nothing to say so', () => {
    const prev = [f('a', 200), f('b', 100)];
    expect(seedInto(prev, [f('y', 900), f('x', 800)], 100, { reach: 200, since: new Set() }).map((x) => x.id)).toEqual(['y', 'x']);
  });
  it('a move streamed since the reopening stays, and never counts as one the seed reached back to; one streamed while an earlier socket was open goes', () => {
    // F came on the stream before the seed answered; S, after the first close, on a socket that closed again
    const prev = [f('F', 1000), f('S', 300), f('a', 200), f('b', 100)];
    expect(seedInto(prev, [f('y', 900), f('x', 800)], 100, { reach: 200, since: new Set(['F']) }).map((x) => x.id)).toEqual(['F', 'y', 'x']);
  });
  it('keeps the newest `keep`, and a first seed fills an empty list', () => {
    expect(seedInto([], [f('b', 2), f('a', 1)], 1).map((x) => x.id)).toEqual(['b']);
    expect(seedInto([f('a', 1)], [], 10).map((x) => x.id)).toEqual(['a']);
    expect(seedInto([f('a', 1)], [], 10, { reach: 1, since: new Set() }).map((x) => x.id)).toEqual(['a']);
  });
});

/**
 * /api/flows?limit=30 as the page gets it: the newest 30 moves written, from a copy kept up to 20 s (the edge's 15 s
 * and the browser's 5 s), and answered `delay` ms after it is asked.
 */
function server(delay = 0) {
  const moves: Flow[] = [];
  let copy: { at: number; rows: Flow[] } | null = null;
  const newest = (t: number) => moves.filter((x) => x.ts <= t).sort((a, b) => b.ts - a.ts).slice(0, 30);
  const srv = {
    asked: [] as number[],
    write: (id: string, ts = Date.now()) => { const x = { id, ts } as Flow; moves.push(x); return x; },
    /** Another reader's fetch: the copy is made now. */
    warm: () => { copy = { at: Date.now(), rows: newest(Date.now()) }; },
    fetchSeed: () => {
      const t = Date.now();
      srv.asked.push(t);
      if (!copy || t - copy.at >= 20_000) copy = { at: t, rows: newest(t) };
      const rows = copy.rows;
      return delay ? new Promise<Flow[]>((resolve) => setTimeout(() => resolve(rows), delay)) : Promise.resolve(rows);
    },
  };
  return srv;
}
/** The shell as overview.tsx runs it: the feed, its list, and the stream's moves handed to it. */
function shell(srv: ReturnType<typeof server>, opts: { visible?: boolean } = {}) {
  FakeWs.all = [];
  const p = page(opts.visible ?? true);
  let list: Flow[] = [];
  const feed = openLiveFeed({
    url: 'wss://namada.trade/ws', visible: p.visible, subscribeVisible: p.subscribeVisible, keep: 100,
    fetchSeed: srv.fetchSeed, update: (next) => { list = next(list); },
    onOpen: () => {}, onMessage: () => {}, onClose: () => {},
    WebSocketImpl: FakeWs as unknown as new (url: string) => WebSocket, random: () => 0.5,
  });
  return { p, feed, ids: () => list.map((x) => x.id), list: () => list };
}

describe('openLiveFeed: the socket and the list of recent moves, as the shell runs them', () => {
  it('a move written while the socket was closed is listed once the second fetch is past the caches, though the first was answered from an older copy', async () => {
    vi.useFakeTimers();
    const T = Date.now();
    const srv = server();
    for (let i = 0; i < 10; i++) srv.write(`m${i}`, T - 100_000 + i * 10_000);
    const { feed, ids } = shell(srv);
    await vi.advanceTimersByTimeAsync(0);
    expect(ids()).toHaveLength(10);
    last().open();
    await vi.advanceTimersByTimeAsync(10_000);
    feed.streamed([srv.write('S')]);
    await vi.advanceTimersByTimeAsync(5_000);
    srv.warm(); // another reader: the edge's copy is made 15 s after the page loaded
    await vi.advanceTimersByTimeAsync(1_000);
    // a deploy drops the socket; a move is written a second later, while no page holds a socket
    last().drop();
    await vi.advanceTimersByTimeAsync(1_000);
    const M = srv.write('M');
    await vi.advanceTimersByTimeAsync(RECONNECT_FIRST_MS + 1500 - 1000);
    last().open();
    await vi.advanceTimersByTimeAsync(0);
    // the fetch at the opening was answered from the copy made before the move
    expect(srv.asked).toHaveLength(2);
    expect(ids()).not.toContain('M');
    await vi.advanceTimersByTimeAsync(SEED_SETTLE_MS);
    expect(srv.asked).toHaveLength(3);
    expect(ids()[0]).toBe('M');
    expect(ids()).toEqual(['M', 'S', ...Array.from({ length: 10 }, (_, i) => `m${9 - i}`)]);
    expect(feed.streamed).toBeTypeOf('function');
    expect(M.ts).toBeGreaterThan(T);
  });

  it('a tab hidden for two hours while 80 moves came: shown again, a move streamed before the fetch answers does not hide the 50 the fetch cannot hold', async () => {
    vi.useFakeTimers();
    const T = Date.now();
    const srv = server(1_000);
    for (let i = 0; i < 10; i++) srv.write(`m${i}`, T - 100_000 + i * 10_000);
    const { p, feed, ids } = shell(srv);
    await vi.advanceTimersByTimeAsync(1_000);
    last().open();
    p.set(false);
    await vi.advanceTimersByTimeAsync(HIDDEN_CLOSE_MS);
    expect(last().closedByPage).toBe(true);
    for (let i = 0; i < 80; i++) srv.write(`h${i}`, Date.now() + (i + 1) * 90_000);
    await vi.advanceTimersByTimeAsync(2 * 3_600_000);
    p.set(true);
    last().open();
    // the stream sends a move before the fetch at the opening answers
    await vi.advanceTimersByTimeAsync(100);
    feed.streamed([srv.write('F')]);
    await vi.advanceTimersByTimeAsync(900);
    // the list is F and the 30 newest of the 80, never the moves of two hours ago under them with 50 missing between
    expect(ids()).toEqual(['F', ...Array.from({ length: 30 }, (_, i) => `h${79 - i}`)]);
    // the second fetch reaches back to the first: merged, and the list is whole
    await vi.advanceTimersByTimeAsync(SEED_SETTLE_MS);
    expect(srv.asked).toHaveLength(3);
    expect(ids()).toEqual(['F', ...Array.from({ length: 30 }, (_, i) => `h${79 - i}`)]);
    // a later close and reopening whose fetch reaches back keeps everything listed
    last().drop();
    await vi.advanceTimersByTimeAsync(RECONNECT_FIRST_MS + 1500);
    last().open();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ids()).toHaveLength(31);
  });

  it('a socket dropped again before its second fetch: the hole stays open until a socket has been open SEED_SETTLE_MS, and a fetch that fails changes nothing', async () => {
    vi.useFakeTimers();
    const T = Date.now();
    const srv = server();
    for (let i = 0; i < 5; i++) srv.write(`m${i}`, T - 50_000 + i * 10_000);
    let fail = false;
    const fetchSeed = srv.fetchSeed;
    srv.fetchSeed = () => (fail ? Promise.reject(new Error('HTTP 503')) : fetchSeed());
    const { feed, ids } = shell(srv);
    await vi.advanceTimersByTimeAsync(0);
    last().open();
    last().drop();
    await vi.advanceTimersByTimeAsync(RECONNECT_FIRST_MS + 1500);
    last().open();
    await vi.advanceTimersByTimeAsync(10_000);
    // streamed after the first reopening, then dropped before the second fetch
    feed.streamed([srv.write('S1')]);
    last().drop();
    // 40 moves while it is closed again, more than a fetch holds
    for (let i = 0; i < 40; i++) srv.write(`g${i}`, Date.now() + i + 1);
    await vi.advanceTimersByTimeAsync(2 * RECONNECT_FIRST_MS + 1500);
    fail = true;
    last().open();
    await vi.advanceTimersByTimeAsync(0);
    expect(ids()).toEqual(['S1', 'm4', 'm3', 'm2', 'm1', 'm0']);
    fail = false;
    await vi.advanceTimersByTimeAsync(SEED_SETTLE_MS);
    // the second fetch does not reach back to the moves listed at the first close (S1 came after it): they go
    expect(ids()).toEqual(Array.from({ length: 30 }, (_, i) => `g${39 - i}`));
  });

  it('close() ends it: no fetch answered after it is listed', async () => {
    vi.useFakeTimers();
    const srv = server(1_000);
    srv.write('a');
    const { feed, ids } = shell(srv);
    feed.close();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ids()).toEqual([]);
    feed.streamed([srv.write('b')]);
    expect(ids()).toEqual([]);
  });
});
