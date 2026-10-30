// The live data every screen shares (F1): /api/overview polled every 20 s (one fetch per
// rewound time under Rewind), the /ws stream (live only), the recent flows seed, the Alerts
// count since the last visit, and the one ticking clock for ages (useNow).
//
// Logic carried over from the old App.tsx: polling, the WebSocket with reconnect, the stream's
// price message replacing overview.price.usd with its own provenance, the flow seed, and
// nt.lastSeen. Nothing here invents a value: a figure the API did not send stays null. The
// socket itself (live-socket.ts) is closed while its tab has been hidden for 5 minutes, and the
// seed is fetched again each time it opens after the first, at once and once past the caches.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { AlertHit, Flow, LiveMessage, Overview } from '../../../shared/types';
import { fetchAlertsRecent, fetchLiveSeed, fetchOverview } from '../api';
import { openLiveFeed } from './live-socket';
import { useReplay } from './replay';
import { useWallNow } from '../ui/now';
import { useRoute } from './router';
import { ageOutStamps, type Stamp } from '../lib/prov';
import { fmtUtcClock } from '../lib/format';

const POLL_MS = 20_000;
/** No answer for two polls (or the last one failed): the figures shown are old, whatever the server said then. */
export const STALE_AFTER_MS = 2 * POLL_MS;
/** A request in flight this long is not yet a missed poll (a tab coming back, a slow answer). */
const PENDING_GRACE_MS = 10_000;
/** One quick retry after a poll fails, so a single blip does not leave the page old for a whole poll. */
const RETRY_MS = 5_000;
/** The stream's first hello can report the Osmosis feed down for a moment while it connects. */
export const UPSTREAM_GRACE_MS = 15_000;
const ALERTS_POLL_MS = 60_000;
const FLOW_KEEP = 100;
/** The note on a price that came through the stream. */
const STREAM_NOTE = 'Received from the live stream.';

// ---- the clock: one 5 s ticker for every age on the page (the UI kit's store, ui/now.tsx) --------
/** Wall-clock now, re-rendering every 5 s (and when the tab becomes visible). */
export const useNow = useWallNow;

/** "Now" for ages: the rewound time under Rewind, else useNow(). Ages under Rewind are measured from that moment. */
export function useClock(): number {
  const { at } = useReplay();
  const now = useNow();
  return at ?? now;
}

// ---- document visibility ------------------------------------------------------------------
const visSubs = new Set<() => void>();
const onVis = () => visSubs.forEach((f) => f());
function subscribeVis(cb: () => void) {
  if (!visSubs.size) document.addEventListener('visibilitychange', onVis);
  visSubs.add(cb);
  return () => {
    visSubs.delete(cb);
    if (!visSubs.size) document.removeEventListener('visibilitychange', onVis);
  };
}
const visSnap = () => document.visibilityState === 'visible';
/** True while the tab is visible. */
export const useVisible = (): boolean => useSyncExternalStore(subscribeVis, visSnap, () => true);

// ---- the provider ---------------------------------------------------------------------------
export interface StreamState {
  /** The /ws stream is open (never under Rewind). */
  connected: boolean;
  /** When the last stream message arrived (unix ms). */
  lastAt: number | null;
  /**
   * The hub's own Osmosis feed, from its hello and status messages: false while Osmosis moves are not
   * streamed (Namada moves still are); null before the hub has said.
   */
  osmosis: boolean | null;
  /** Since when `osmosis` has had its current value (unix ms). */
  osmosisSince: number | null;
}

/** False when the hub has reported its Osmosis feed down for longer than the cold-start grace; null when not known. */
export function osmosisStreaming(s: StreamState, now: number): boolean | null {
  if (!s.connected || s.osmosis == null) return null;
  if (s.osmosis) return true;
  return s.osmosisSince != null && now - s.osmosisSince < UPSTREAM_GRACE_MS ? null : false;
}

/** The stamp of "new moves as they happen" (the live stream), in the words the lists use. */
export function streamStamp(s: StreamState, now: number): Stamp {
  if (!s.connected) return { source: 'live stream', plain: 'Live stream', at: s.lastAt, status: 'missing', note: 'The live stream is not connected; the list shows moves recorded up to when it was fetched.' };
  if (osmosisStreaming(s, now) === false) return { source: 'live stream', plain: 'Live stream', at: s.lastAt, status: 'stale', note: 'Osmosis moves are not streaming right now; Namada moves are.' };
  return { source: 'live stream', plain: 'Live stream', at: s.lastAt, status: 'live', note: 'New moves arrive as they are recorded.' };
}

export interface AlertsBadge {
  /** Alert hits since the last visit that have not been seen on /alerts (0 under Rewind). */
  count: number;
  /** The previous visit's last moment (nt.lastSeen at boot), the start of "Since you were away"; null on a first visit. */
  since: number | null;
  /** The hits counted, newest first. */
  hits: AlertHit[];
}

export interface OverviewValue {
  /**
   * The latest /api/overview (as of the rewound time under Rewind); null until the first answer. While
   * live and `stale`, every stamp the server sent as live reads old ('stale'), with a note saying since
   * when the page has not refreshed (the streamed price stays live while the stream delivers it).
   */
  overview: Overview | null;
  /** Why the last fetch failed, in plain words; null when it answered. Set with or without an older overview. */
  error: string | null;
  /** When the current overview arrived (unix ms). */
  receivedAt: number | null;
  /** Live only: the figures shown are older than they should be (the last poll failed, or two polls went unanswered). */
  stale: boolean;
  /** A request for the overview is in flight (e.g. after refresh()). */
  pending: boolean;
  stream: StreamState;
  /** Recent flows: the 30 newest at load plus every streamed one, newest first (live only, [] under Rewind). */
  liveFlows: Flow[];
  /** Ids of flows that arrived through the stream (animate those in, never the seed). */
  streamedIds: ReadonlySet<string>;
  alerts: AlertsBadge;
  /** Fetch the overview again now. */
  refresh: () => void;
}

const NO_STREAM: StreamState = { connected: false, lastAt: null, osmosis: null, osmosisSince: null };
const empty: OverviewValue = {
  overview: null, error: null, receivedAt: null, stale: false, pending: false,
  stream: NO_STREAM,
  liveFlows: [], streamedIds: new Set(),
  alerts: { count: 0, since: null, hits: [] },
  refresh: () => {},
};
const OverviewCtx = createContext<OverviewValue>(empty);

const readLastSeen = (): number | null => {
  try {
    const v = Number(localStorage.getItem('nt.lastSeen'));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
};
const writeLastSeen = () => {
  try {
    localStorage.setItem('nt.lastSeen', String(Date.now()));
  } catch {
    /* private mode: the count just starts from 24 h ago next time */
  }
};

export function OverviewProvider({ children }: { children: React.ReactNode }) {
  const { at } = useReplay();
  const { view } = useRoute();
  const visible = useVisible();

  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [receivedAt, setReceivedAt] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const [stream, setStream] = useState<StreamState>(NO_STREAM);
  const [liveFlows, setLiveFlows] = useState<Flow[]>([]);
  const streamed = useRef<Set<string>>(new Set());
  const [streamedIds, setStreamedIds] = useState<ReadonlySet<string>>(new Set());

  // ---- age: is what is shown older than it should be? (live only; read from refs so a render never races a fetch)
  const receivedRef = useRef<number | null>(null);
  const pendingRef = useRef<number | null>(null);
  const errorRef = useRef<string | null>(null);
  const connectedRef = useRef(false);
  /** When the price shown came through the stream (its own time); null when it is the polled price. */
  const streamPriceAt = useRef<number | null>(null);
  const [age, setAge] = useState({ old: false, priceLive: false });
  const checkAge = useCallback(() => {
    const t = Date.now();
    const r = receivedRef.current;
    const p = pendingRef.current;
    const old = errorRef.current != null || (r != null && t - r > STALE_AFTER_MS && !(p != null && t - p < PENDING_GRACE_MS));
    const sp = streamPriceAt.current;
    const priceLive = connectedRef.current && sp != null && t - sp <= STALE_AFTER_MS;
    setAge((a) => (a.old === old && a.priceLive === priceLive ? a : { old, priceLive }));
  }, []);

  // ---- overview: poll while live and visible, one fetch per rewound time
  const seq = useRef(0);
  const lastFetch = useRef(0);
  const retry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const loadRef = useRef<() => void>(() => {});
  const load = useCallback(() => {
    const n = ++seq.current;
    lastFetch.current = Date.now();
    pendingRef.current = Date.now();
    clearTimeout(retry.current);
    setPending(true);
    fetchOverview(at)
      .then((o) => {
        if (n !== seq.current) return; // a newer request (or a new ?at=) superseded this one
        receivedRef.current = Date.now();
        pendingRef.current = null;
        errorRef.current = null;
        streamPriceAt.current = null; // the polled price replaces the streamed one
        setOverview(o);
        setError(null);
        setReceivedAt(receivedRef.current);
        setPending(false);
        checkAge();
      })
      .catch((e: unknown) => {
        if (n !== seq.current) return;
        const first = errorRef.current == null;
        const words = e instanceof Error && /HTTP \d+/.test(e.message) ? 'The data service answered with an error.' : 'The data service did not answer.';
        pendingRef.current = null;
        errorRef.current = words;
        setError(words);
        setPending(false);
        checkAge();
        if (first && !at) retry.current = setTimeout(() => document.visibilityState === 'visible' && loadRef.current(), RETRY_MS);
      });
  }, [at, checkAge]);
  loadRef.current = load;

  useEffect(() => {
    // a new rewound time (or back to now): drop the old figures, and the old failure, so nothing shows as if dated
    setOverview(null);
    setReceivedAt(null);
    setError(null);
    receivedRef.current = null;
    errorRef.current = null;
    streamPriceAt.current = null;
    setAge({ old: false, priceLive: false });
    load();
    return () => clearTimeout(retry.current);
  }, [load]);

  useEffect(() => {
    if (at || !visible) return;
    if (Date.now() - lastFetch.current > POLL_MS) load();
    const t = setInterval(load, POLL_MS);
    // the age is checked on its own clock, so a poll that never answers still turns the figures old
    const a = setInterval(checkAge, 5_000);
    return () => {
      clearInterval(t);
      clearInterval(a);
    };
  }, [at, visible, load, checkAge]);

  // ---- flows seed and the WebSocket stream (live only)
  useEffect(() => {
    if (at) {
      setLiveFlows([]);
      setStream(NO_STREAM);
      connectedRef.current = false;
      return;
    }
    let alive = true;
    // the socket and the recent moves (live-socket.ts openLiveFeed): the newest moves at load, and at every opening
    // after the first (a reconnect, or a tab shown again after its socket was closed) at once and again 25 s later,
    // past what the caches keep, so what came while it was closed is listed and a list with a hole is never shown;
    // reconnected after 3 s doubling to 30 s, each with 0 to 3 s more; closed after its tab has been hidden for 5
    // minutes, and opened again when the tab shows
    const feed = openLiveFeed({
      url: `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`,
      visible: visSnap,
      subscribeVisible: subscribeVis,
      keep: FLOW_KEEP,
      fetchSeed: () => fetchLiveSeed(30).then((r) => r.flows),
      update: (next) => {
        if (alive) setLiveFlows(next);
      },
      onOpen: () => {
        connectedRef.current = true;
        setStream((s) => ({ ...s, connected: true }));
      },
      onMessage: (data) => {
        let msg: LiveMessage;
        try {
          msg = JSON.parse(String(data)) as LiveMessage;
        } catch {
          return;
        }
        const t = Date.now();
        connectedRef.current = true;
        if (msg.type === 'hello' || msg.type === 'status') {
          // the hub says whether its own Osmosis feed is up (Osmosis moves stream only through it)
          const up = !!msg.upstream?.osmosis;
          setStream((s) => ({ connected: true, lastAt: t, osmosis: up, osmosisSince: s.osmosis === up && s.osmosisSince != null ? s.osmosisSince : t }));
        } else {
          setStream((s) => ({ ...s, connected: true, lastAt: t }));
        }
        if (msg.type === 'flows') {
          for (const f of msg.flows) streamed.current.add(f.id);
          setStreamedIds(new Set(streamed.current));
          feed.streamed(msg.flows);
        } else if (msg.type === 'price') {
          // the streamed quote carries the hub's source name for the price (the price list, or the route's spot) and
          // its note; a hub from before 2026-10-24 sends neither, and the server's own source name is kept
          setOverview((prev) => (prev ? { ...prev, price: { ...prev.price, usd: { value: msg.usd, prov: { source: msg.source ?? prev.price.usd.prov.source, at: msg.at, status: 'live', note: msg.note ? `${STREAM_NOTE} ${msg.note}` : STREAM_NOTE } } } } : prev));
          streamPriceAt.current = msg.at;
          checkAge();
        }
      },
      onClose: () => {
        connectedRef.current = false;
        setStream((s) => ({ ...s, connected: false, osmosis: null, osmosisSince: null }));
        checkAge();
      },
    });
    return () => {
      alive = false;
      feed.close();
    };
  }, [at, checkAge]);

  // ---- Alerts count since the last visit (live only)
  const since = useMemo(readLastSeen, []);
  const [alertHits, setAlertHits] = useState<AlertHit[]>([]);
  const [seenAt, setSeenAt] = useState<number | null>(null);
  useEffect(() => {
    const save = setInterval(writeLastSeen, 30_000);
    const onHide = () => {
      if (document.visibilityState === 'hidden') writeLastSeen();
    };
    window.addEventListener('pagehide', writeLastSeen);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      clearInterval(save);
      window.removeEventListener('pagehide', writeLastSeen);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, []);
  useEffect(() => {
    if (at || !visible) return;
    let alive = true;
    const get = () =>
      fetchAlertsRecent(null, since ?? undefined)
        .then((r) => alive && setAlertHits([...r.hits].sort((a, b) => b.ts - a.ts)))
        .catch(() => {});
    get();
    const t = setInterval(get, ALERTS_POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [at, visible, since]);
  // opening /alerts counts as seeing them
  useEffect(() => {
    if (view === 'alerts') setSeenAt(Date.now());
  }, [view, alertHits]);

  const alerts = useMemo<AlertsBadge>(() => {
    const floor = seenAt ?? 0;
    const unseen = at ? [] : alertHits.filter((h) => h.ts > floor);
    return { count: unseen.length, since, hits: unseen };
  }, [alertHits, seenAt, since, at]);

  // ---- what the screens get: while live and old, every 'live' stamp reads old and says since when
  const stale = !at && overview != null && age.old;
  const shown = useMemo<Overview | null>(() => {
    if (!overview || !stale) return overview;
    const since = receivedAt != null ? fmtUtcClock(receivedAt) : null;
    const why = error ? `: ${error.charAt(0).toLowerCase()}${error.slice(1)}` : '.';
    const note = since ? `This page has not refreshed since ${since}${why}` : `This page has not refreshed${why}`;
    const aged = ageOutStamps(overview, note);
    // the streamed price is current while the stream is delivering it
    return age.priceLive ? { ...aged, price: { ...aged.price, usd: overview.price.usd } } : aged;
  }, [overview, stale, receivedAt, error, age.priceLive]);

  const value = useMemo<OverviewValue>(
    () => ({ overview: shown, error, receivedAt, stale, pending, stream, liveFlows, streamedIds, alerts, refresh: load }),
    [shown, error, receivedAt, stale, pending, stream, liveFlows, streamedIds, alerts, load],
  );
  return <OverviewCtx.Provider value={value}>{children}</OverviewCtx.Provider>;
}

/** { overview, error, receivedAt, stale, pending, stream, liveFlows, streamedIds, alerts, refresh } */
export const useOverview = (): OverviewValue => useContext(OverviewCtx);

/**
 * True when the overview never answered: there is no figure from it, and the shell's bar under the header
 * says why (with one "Try again"). A screen then shows "—" where it would show a loading skeleton.
 */
export function useOverviewFailed(): boolean {
  const { overview, error } = useContext(OverviewCtx);
  return overview == null && error != null;
}
