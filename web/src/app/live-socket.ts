// The /ws stream's socket for the shell (overview.tsx): opened once, opened again after a close with a wait that grows
// and a random part, closed once its tab has been hidden for HIDDEN_CLOSE_MS and opened again when the tab shows. The
// hub holds every socket in memory and walks them all on each message (worker/src/ws-admit.ts), so a tab nobody looks
// at gives its place back, and the tabs one deploy disconnects come back spread over a few seconds rather than in one.
// The list of recent moves goes with it (openLiveFeed): every opening after the first fetches the newest moves at once
// and again SEED_SETTLE_MS later, past what the caches keep, and a fetch that does not reach back to the moves listed
// before the close replaces them (seedInto), so a move made while the socket was closed is listed, and a list with a
// hole in it is never shown. Nothing here touches the DOM or React: the socket, the visibility, the fetch and the
// random part come in, so test/live-socket.test.ts drives it as the page does.
import type { Flow } from '../../../shared/types';

/** The first wait before opening the socket again, and the longest: it doubles after each close that follows a failed try. */
export const RECONNECT_FIRST_MS = 3000;
export const RECONNECT_MAX_MS = 30_000;
/** The random part added to each wait: 0 to 3 s. */
export const RECONNECT_JITTER_MS = 3000;
/** A tab hidden this long closes its socket; showing it again opens one at once. */
export const HIDDEN_CLOSE_MS = 5 * 60_000;
/**
 * How long a socket opened again stays open before the newest moves are fetched a second time. The fetch at the
 * opening can be answered from a copy made before it: the edge keeps /api/flows 15 s and the browser 5 s
 * (worker/src/http.ts EDGE_CACHE, BROWSER_CACHE), so a move written while the socket was closed may be missing from it.
 * A copy fetched 20 s after the opening was made after it, and the hub writes a move before it streams it; 5 s more
 * to spare.
 */
export const SEED_SETTLE_MS = 25_000;

/** The wait before the next try: `backoff` (RECONNECT_FIRST_MS doubling to RECONNECT_MAX_MS) and 0 to RECONNECT_JITTER_MS more. */
export function reconnectDelay(backoff: number, random: () => number = Math.random): number {
  const r = random();
  return backoff + Math.floor((Number.isFinite(r) ? Math.min(Math.max(r, 0), 1) : 0) * RECONNECT_JITTER_MS);
}

export interface LiveSocketOpts {
  url: string;
  /** The socket opened; `again` when it is not the first one (a reconnect, or a reopening after the tab was hidden). */
  onOpen: (again: boolean) => void;
  /** A socket opened `again` has stayed open SEED_SETTLE_MS (not called when it closes before). */
  onSettled?: () => void;
  onMessage: (data: unknown) => void;
  /** The socket closed, or was closed for a hidden tab (not called by close()). */
  onClose: () => void;
  /** Whether the tab is visible now, and a subscription to its changes that returns the unsubscribe (overview.tsx's store). */
  visible: () => boolean;
  subscribeVisible: (cb: () => void) => () => void;
  /** The tests' socket and random part; the browser's WebSocket and Math.random otherwise. */
  WebSocketImpl?: new (url: string) => WebSocket;
  random?: () => number;
}

export interface LiveSocket {
  /** Closes the socket for good (the provider's cleanup): no reconnect, and no onClose. */
  close: () => void;
}

export function openLiveSocket(o: LiveSocketOpts): LiveSocket {
  const Ws = o.WebSocketImpl ?? WebSocket;
  let ws: WebSocket | null = null;
  let stopped = false;
  /** Closed for a hidden tab: nothing reconnects until the tab shows. */
  let parked = false;
  let opened = false;
  let backoff = RECONNECT_FIRST_MS;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let hide: ReturnType<typeof setTimeout> | undefined;
  let settle: ReturnType<typeof setTimeout> | undefined;

  const connect = () => {
    if (stopped || parked) return;
    const sock = new Ws(o.url);
    ws = sock;
    // A socket let go (close(), or closed for a hidden tab) says nothing more: its late events are not this one's.
    sock.onopen = () => {
      if (ws !== sock) return;
      backoff = RECONNECT_FIRST_MS;
      const again = opened;
      opened = true;
      o.onOpen(again);
      if (again && o.onSettled) {
        clearTimeout(settle);
        settle = setTimeout(() => {
          settle = undefined;
          if (ws === sock && !stopped) o.onSettled?.();
        }, SEED_SETTLE_MS);
      }
    };
    sock.onmessage = (ev) => {
      if (ws === sock) o.onMessage(ev.data);
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      clearTimeout(settle);
      settle = undefined;
      o.onClose();
      if (stopped || parked) return;
      retry = setTimeout(connect, reconnectDelay(backoff, o.random));
      backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
    };
    sock.onerror = () => sock.close();
  };
  /** Lets the socket go now, without waiting for its close event; a wait for the next try is cancelled. */
  const drop = (notify: boolean) => {
    clearTimeout(retry);
    retry = undefined;
    clearTimeout(settle);
    settle = undefined;
    const sock = ws;
    ws = null;
    if (!sock) return;
    try {
      sock.close();
    } catch {
      /* already closing */
    }
    if (notify) o.onClose();
  };
  const onVisibility = () => {
    if (stopped) return;
    if (o.visible()) {
      clearTimeout(hide);
      hide = undefined;
      if (parked) {
        parked = false;
        backoff = RECONNECT_FIRST_MS;
        connect();
      }
    } else if (hide === undefined && !parked) {
      hide = setTimeout(() => {
        hide = undefined;
        if (stopped || o.visible()) return;
        parked = true;
        drop(true);
      }, HIDDEN_CLOSE_MS);
    }
  };
  const unsubscribe = o.subscribeVisible(onVisibility);
  connect();
  // a tab opened in the background counts its hidden time from now
  onVisibility();
  return {
    close: () => {
      stopped = true;
      clearTimeout(hide);
      unsubscribe();
      drop(false);
    },
  };
}

/**
 * A hole in the list of recent moves (openLiveFeed): `reach`, the newest move listed with nothing missing below it,
 * and `since`, the moves streamed since the socket last opened, which nothing separates from the stream going on.
 */
export interface SeedHole { reach: number; since: ReadonlySet<string> }

/**
 * The recent moves after a fetch of the newest ones (`seed`, newest first), at most `keep`, newest first. `hole`:
 * while moves may be missing from the list (a socket closed, and no fetch since has been sure to cover what it
 * missed); null when nothing is missing. The seed is merged with the list when nothing is missing, or when it reaches
 * back to `hole.reach`, which fills the hole. When it does not (more moves came while the socket was closed than the
 * seed holds), only the moves streamed since the socket last opened stay beside it: the moves listed before would
 * stand under the seed with the ones between missing and nothing to say so. A move streamed since the opening never
 * counts as one the seed reached back to.
 */
export function seedInto(prev: Flow[], seed: Flow[], keep: number, hole: SeedHole | null = null): Flow[] {
  const oldest = seed.reduce((m, f) => Math.min(m, f.ts), Infinity);
  const base = hole && seed.length && oldest > hole.reach ? prev.filter((f) => hole.since.has(f.id)) : prev;
  const ids = new Set(base.map((f) => f.id));
  return [...base, ...seed.filter((f) => !ids.has(f.id))].sort((a, b) => b.ts - a.ts).slice(0, keep);
}

export interface LiveFeedOpts extends Omit<LiveSocketOpts, 'onSettled'> {
  /** The newest moves (web/src/api.ts fetchLiveSeed), newest first; a failure leaves the list as it is. */
  fetchSeed: () => Promise<Flow[]>;
  /** The list's update (React's functional setState): called with a pure function of the list. */
  update: (next: (prev: Flow[]) => Flow[]) => void;
  /** The most moves listed. */
  keep: number;
}

export interface LiveFeed extends LiveSocket {
  /** Moves the stream sent (the shell's 'flows' message): listed first, each once. */
  streamed: (flows: Flow[]) => void;
}

/**
 * The socket (openLiveSocket) and the list of recent moves together, as the shell uses them: the newest moves at
 * once, and at every opening after the first, at once and again when the socket has stayed open SEED_SETTLE_MS. The
 * close of a socket that was open starts a hole (SeedHole, its `reach` the newest move listed then), or, during one,
 * leaves what the socket streamed out of it; each fetch taken raises `reach` to its newest move, and the second fetch,
 * asked with no close since the opening, ends the hole.
 */
export function openLiveFeed(o: LiveFeedOpts): LiveFeed {
  let newest = -Infinity;
  let reach: number | null = null;
  /** During a hole, the moves streamed since the socket last opened (at most `keep`, the newest). */
  let since = new Set<string>();
  /** Closes of an open socket: a second fetch asked before the last one does not end the hole that close began. */
  let closes = 0;
  let open = false;
  let stopped = false;
  const raise = (flows: Flow[]) => {
    for (const f of flows) if (f.ts > newest) newest = f.ts;
  };
  const seed = (settled: boolean) => {
    const asked = closes;
    o.fetchSeed().then(
      (flows) => {
        if (stopped) return;
        const hole = reach == null ? null : { reach, since: new Set(since) };
        raise(flows);
        if (hole) {
          if (settled && asked === closes) {
            reach = null;
            since = new Set();
          } else reach = flows.reduce((m, f) => Math.max(m, f.ts), hole.reach);
        }
        o.update((prev) => seedInto(prev, flows, o.keep, hole));
      },
      () => {},
    );
  };
  seed(false);
  const sock = openLiveSocket({
    ...o,
    onOpen: (again) => {
      open = true;
      o.onOpen(again);
      if (again) seed(false);
    },
    onSettled: () => seed(true),
    onClose: () => {
      // a try that never opened missed nothing it would have streamed
      if (open) {
        closes++;
        if (reach == null) reach = newest;
        since = new Set();
      }
      open = false;
      o.onClose();
    },
  });
  return {
    streamed: (flows) => {
      if (stopped) return;
      raise(flows);
      if (reach != null) {
        for (const f of flows) since.add(f.id);
        for (const id of since) {
          if (since.size <= o.keep) break;
          since.delete(id);
        }
      }
      o.update((prev) => {
        const ids = new Set(prev.map((f) => f.id));
        return [...flows.filter((f) => !ids.has(f.id)), ...prev].slice(0, o.keep);
      });
    },
    close: () => {
      stopped = true;
      sock.close();
    },
  };
}
