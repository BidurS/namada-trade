// The /ws stream's socket for the shell (overview.tsx): opened once, opened again after a close with a wait that grows
// and a random part, closed once its tab has been hidden for HIDDEN_CLOSE_MS and opened again when the tab shows. The
// hub holds every socket in memory and walks them all on each message (worker/src/ws-admit.ts), so a tab nobody looks
// at gives its place back, and the tabs one deploy disconnects come back spread over a few seconds rather than in one.
// Every opening after the first tells the shell (onOpen `again`), which fetches the recent moves again (seedInto), so
// a move made while the socket was closed is still listed. Nothing here touches the DOM or React: the socket, the
// visibility and the random part come in, so test/live-socket.test.ts drives it as the page does.
import type { Flow } from '../../../shared/types';

/** The first wait before opening the socket again, and the longest: it doubles after each close that follows a failed try. */
export const RECONNECT_FIRST_MS = 3000;
export const RECONNECT_MAX_MS = 30_000;
/** The random part added to each wait: 0 to 3 s. */
export const RECONNECT_JITTER_MS = 3000;
/** A tab hidden this long closes its socket; showing it again opens one at once. */
export const HIDDEN_CLOSE_MS = 5 * 60_000;

/** The wait before the next try: `backoff` (RECONNECT_FIRST_MS doubling to RECONNECT_MAX_MS) and 0 to RECONNECT_JITTER_MS more. */
export function reconnectDelay(backoff: number, random: () => number = Math.random): number {
  const r = random();
  return backoff + Math.floor((Number.isFinite(r) ? Math.min(Math.max(r, 0), 1) : 0) * RECONNECT_JITTER_MS);
}

export interface LiveSocketOpts {
  url: string;
  /** The socket opened; `again` when it is not the first one (a reconnect, or a reopening after the tab was hidden). */
  onOpen: (again: boolean) => void;
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
    };
    sock.onmessage = (ev) => {
      if (ws === sock) o.onMessage(ev.data);
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
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
 * The recent moves after a fetch of the newest ones (`seed`, newest first), at most `keep`, newest first: merged with
 * those listed when the seed reaches back to them, so the list has no hole. When it does not (more moves came while
 * the socket was closed than the seed holds), the seed alone: the moves between would be missing from the list with
 * nothing to say so.
 */
export function seedInto(prev: Flow[], seed: Flow[], keep: number): Flow[] {
  const oldest = seed.reduce((m, f) => Math.min(m, f.ts), Infinity);
  const newest = prev.reduce((m, f) => Math.max(m, f.ts), -Infinity);
  const base = seed.length && oldest > newest ? [] : prev;
  const ids = new Set(base.map((f) => f.id));
  return [...base, ...seed.filter((f) => !ids.has(f.id))].sort((a, b) => b.ts - a.ts).slice(0, keep);
}
