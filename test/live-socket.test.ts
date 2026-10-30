// Scale plan 2026-10-29, Stage 1 item 7: the page's live socket (web/src/app/live-socket.ts, used by overview.tsx).
// The hub holds every socket in memory and walks them all on each message, and a tab left open in the background kept
// its socket for good; after a deploy every page came back 3 s later in the same second, then at 6, 12, 24 and 30 s.
// Now a tab hidden for 5 minutes closes its socket and opens one at once when it shows again, each wait before a
// reconnect has 0 to 3 s added at random (the 3 s doubling to 30 s is as it was), and every opening after the first
// says so, so the page fetches the recent moves again (seedInto) and a move made while the socket was closed is listed.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HIDDEN_CLOSE_MS, RECONNECT_FIRST_MS, RECONNECT_JITTER_MS, RECONNECT_MAX_MS, openLiveSocket, reconnectDelay, seedInto } from '../web/src/app/live-socket';
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
  const log = { opens: [] as boolean[], closes: 0, messages: [] as unknown[] };
  const sock = openLiveSocket({
    url: 'wss://namada.trade/ws',
    visible: p.visible, subscribeVisible: p.subscribeVisible,
    onOpen: (again) => log.opens.push(again),
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

describe('seedInto: the recent moves fetched again when the socket opens', () => {
  const f = (id: string, ts: number) => ({ id, ts } as Flow);
  it('merges with the moves listed when it reaches back to them', () => {
    const prev = [f('s3', 300), f('a', 200), f('b', 100)];
    expect(seedInto(prev, [f('c', 250), f('a', 200)], 100).map((x) => x.id)).toEqual(['s3', 'c', 'a', 'b']);
  });
  it('replaces them when it does not: the moves between would be missing with nothing to say so', () => {
    const prev = [f('a', 200), f('b', 100)];
    expect(seedInto(prev, [f('y', 900), f('x', 800)], 100).map((x) => x.id)).toEqual(['y', 'x']);
  });
  it('keeps the newest `keep`, and a first seed fills an empty list', () => {
    expect(seedInto([], [f('b', 2), f('a', 1)], 1).map((x) => x.id)).toEqual(['b']);
    expect(seedInto([f('a', 1)], [], 10).map((x) => x.id)).toEqual(['a']);
  });
});
