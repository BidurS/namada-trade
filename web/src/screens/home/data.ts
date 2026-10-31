// Home (S1): the data the screen reads besides the shell's overview, and the pure helpers that
// turn API rows into what the sections show. Nothing here invents a value (N2): a figure the API
// did not send stays null and the section says so in words.
//
// Requests (build-plan Phase 2, Home row; section 6 for Rewind):
//   live and rewound   /api/pressure?days=7, /api/alerts/recent, /api/alerts/rules,
//                      /api/flows?minNam=1000&arb=false&pairs=one, /api/holders (exempt: current balances),
//                      /api/metrics/history (desktop sparkline only)
//   live only          /api/quote/curve, /api/quote?amount=5000&side=sell (never requested while rewound)
// The shell's fetch wrapper adds ?at= to every /api GET while rewound; asOf is passed as well.
import { useEffect, useMemo, useState } from 'react';
import type { AlertHit, AlertRuleInfo, Flow, FlowsResponse, HoldersResponse, Pressure, PriceQuote, QuoteCurveResponse } from '../../../../shared/types';
import { type AlertsWithLast, fetchAlertRules, fetchAlertsRecentWithLast, fetchHolders, fetchLatestMoves, fetchMetricHistory, fetchPressure, fetchQuote, fetchQuoteCurve } from '../../api';
import { applyFlowRules, mergeFlows } from '../../lib/flows';
import { fmtAddr, fmtUtcClock } from '../../lib/format';
import { ageOutStamps } from '../../lib/prov';
import type { TagKind } from '../../lib/kinds';
import { partyOf as sharedPartyOf } from '../../../../shared/flow-words';
import { useOverview, useVisible } from '../../app/index';

// ---------------------------------------------------------------- fetching

export interface Res<T> {
  data: T | null;
  /** Plain words when the request failed (never a URL or a status line). */
  error: string | null;
  /** When the data shown was fetched (unix ms). */
  fetchedAt?: number | null;
  /**
   * The data shown is older than its refresh says it should be: its last refresh failed, or the page has stopped
   * refreshing (the shell's overview is old) and this answer is not newer than the page's last good one. Its
   * stamps then read old with the reason (lib/prov.ts ageOutStamps), and a list says so once.
   */
  old?: boolean;
  /** Why it is old, in one sentence (with the time it was fetched). */
  oldWhy?: string;
}

const FAILED = 'The server did not answer.';
/** A request with no answer after this long counts as failed (a browser fetch can hang for minutes). */
export const FETCH_TIMEOUT_MS = 30_000;
const timeout = (ms: number) => new Promise<never>((_, no) => setTimeout(() => no(new Error('timeout')), ms));

/** The note on the stamps of an answer kept after its refresh failed. */
export const refreshFailedNote = (fetchedAt: number | null | undefined): string =>
  fetchedAt != null ? `The latest refresh did not answer, so this is the reading fetched at ${fmtUtcClock(fetchedAt)}.` : 'The latest refresh did not answer, so this is an earlier reading.';
/** The note on the stamps of an answer kept while the whole page has stopped refreshing. */
export const pageStaleNote = (receivedAt: number | null, fetchedAt: number | null | undefined): string =>
  `The data service has not answered since ${receivedAt != null ? fmtUtcClock(receivedAt) : 'the page opened'}, so this is the reading fetched at ${fmtUtcClock(fetchedAt)}.`;

/**
 * How a polled resource keeps its last good answer when a refresh comes back empty or fails (as Trade
 * does, trade/data.ts): the earlier reading stays with its own time, marked old, and says why. Never a
 * stand-in figure, and never for another key.
 */
export interface Keep<T> {
  empty: (d: T) => boolean;
  /** The earlier answer, marked old; `why` is the empty answer's reason, or undefined when the request failed. */
  stale: (prev: T, why: string | undefined) => T;
  /** The empty answer's own reason (its stamp note). */
  why: (d: T) => string | undefined;
}

/**
 * Fetch once per `key` (null: do not fetch). A new key clears the old answer first, so a figure from
 * another rewound moment is never shown under the new one. `every` refetches while the tab is visible;
 * a refresh that fails keeps the last answer with every 'live' stamp in it marked old and the reason (or, with
 * `keep`, as `keep.stale` says); with `keep`, a refresh that comes back empty keeps the last good answer too.
 * A change of `nudge` asks again at once (Home asks every resource again when the page goes old, so a dead
 * service shows on every figure within one request, not only at each resource's next poll).
 */
export function useFetch<T>(key: string | null, load: () => Promise<T>, every?: number, keep?: Keep<T>, nudge?: string): Res<T> {
  type St = Res<T> & { key: string | null; fetchedAt: number | null; failedAt: number | null };
  const [state, setState] = useState<St>({ data: null, error: null, key, fetchedAt: null, failedAt: null });
  const visible = useVisible();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!every || key == null || !visible) return;
    const t = setInterval(() => setTick((n) => n + 1), every);
    return () => clearInterval(t);
  }, [every, key, visible]);

  useEffect(() => {
    if (key == null) {
      setState({ data: null, error: null, key, fetchedAt: null, failedAt: null });
      return;
    }
    let live = true;
    setState((s) => (s.key === key ? s : { data: null, error: null, key, fetchedAt: null, failedAt: null }));
    const kept = (s: St) => (keep && s.key === key && s.data != null && !keep.empty(s.data) ? s.data : null);
    Promise.race([load(), timeout(FETCH_TIMEOUT_MS)]).then(
      (data) =>
        live &&
        setState((s) => {
          const prev = kept(s);
          if (prev != null && keep!.empty(data)) return { data: keep!.stale(prev, keep!.why(data)), error: null, key, fetchedAt: s.fetchedAt, failedAt: null };
          return { data, error: null, key, fetchedAt: Date.now(), failedAt: null };
        }),
      () =>
        live &&
        setState((s) => {
          const prev = kept(s);
          if (prev != null) return { data: keep!.stale(prev, undefined), error: FAILED, key, fetchedAt: s.fetchedAt, failedAt: Date.now() };
          // the earlier answer for this key stays, its 'live' stamps marked old with the reason (never shown as fresh)
          if (s.key === key && s.data != null) return { data: ageOutStamps(s.data, refreshFailedNote(s.fetchedAt)), error: FAILED, key, fetchedAt: s.fetchedAt, failedAt: Date.now() };
          return { data: null, error: FAILED, key, fetchedAt: null, failedAt: Date.now() };
        }),
    );
    return () => {
      live = false;
    };
    // `load` is re-created every render; the key says when the request changes.
  }, [key, tick, nudge]);

  if (state.key !== key) return { data: null, error: null, fetchedAt: null, old: false };
  const failed = state.data != null && state.failedAt != null;
  return { data: state.data, error: state.error, fetchedAt: state.fetchedAt, old: failed, oldWhy: failed ? refreshFailedNote(state.fetchedAt) : undefined };
}

/**
 * While the page has stopped refreshing (the shell's overview is old: `pageStale`, last good answer at
 * `receivedAt`), an answer that is not newer than that is old too: its 'live' stamps read old with the reason,
 * so no Home figure keeps a fresh dot under the bar that says the page is old. An answer fetched after the
 * page's last good overview is newer than what the bar speaks of, and keeps its own state.
 */
export function useAgedRes<T>(r: Res<T>, pageStale: boolean, receivedAt: number | null): Res<T> {
  const aged = pageStale && r.data != null && !r.old && !(r.fetchedAt != null && receivedAt != null && r.fetchedAt > receivedAt);
  const note = aged ? pageStaleNote(receivedAt, r.fetchedAt) : '';
  const data = useMemo(() => (aged && r.data != null ? ageOutStamps(r.data, note) : r.data), [aged, r.data, note]);
  return aged ? { ...r, data, old: true, oldWhy: note } : r;
}

/** True from the given width up, following resizes (the sparkline is fetched only where it shows); the hook lives with the UI kit, the depth page uses it too. */
export { useMinWidth } from '../../ui/useMinWidth';

const MIN = 60_000;

/** The size table: a refresh with no sizes (the quote service had no price) keeps the last table, marked old. */
export const CURVE_KEEP: Keep<QuoteCurveResponse> = {
  empty: (d) => !d.curve.length,
  why: (d) => d.prov.note,
  stale: (prev, why) => ({ ...prev, prov: { ...prev.prov, status: 'stale', note: `${why ?? 'The size table could not be fetched.'} This is the last size table it sent.` } }),
};

export interface HomeData {
  pressure: Res<Pressure>;
  alerts: Res<AlertsWithLast>;
  rules: Res<{ rules: AlertRuleInfo[] }>;
  flows: Res<FlowsResponse>;
  holders: Res<HoldersResponse>;
  curve: Res<QuoteCurveResponse>;
  quote: Res<{ quote: PriceQuote | null; error?: string }>;
  spark: Res<{ ts: number; value: number }[]>;
}

/** The mini-ticket's size: one of the six listed sizes, so the size table can answer when the live quote does not. */
export const TICKET_NAM = 5000;
/** Latest moves: at least this many NAM (the copy deck's "1,000 NAM or more" is this request parameter). */
export const MOVES_MIN_NAM = 1000;
export const MOVES_SHOWN = 6;

export function useHomeData(at: number | null, wide: boolean): HomeData {
  const k = (name: string) => `${name}@${at ?? 'live'}`;
  const live = at == null;
  // the page's own age (the shell's overview): while it is old, so is every answer not newer than its last good one
  const { stale, receivedAt } = useOverview();
  const old = live && stale;
  // when the page goes old (and when it comes back), every polled resource asks again at once
  const n = old ? `old@${receivedAt ?? 0}` : 'ok';
  return {
    pressure: useAgedRes(useFetch(k('pressure'), () => fetchPressure(at, 7), live ? 5 * MIN : undefined, undefined, n), old, receivedAt),
    alerts: useAgedRes(useFetch(k('alerts'), () => fetchAlertsRecentWithLast(at), live ? MIN : undefined, undefined, n), old, receivedAt),
    rules: useFetch('rules', () => fetchAlertRules()),
    flows: useAgedRes(useFetch(k('flows'), () => fetchLatestMoves(at, MOVES_MIN_NAM), live ? MIN : undefined, undefined, n), old, receivedAt),
    // exempt from Rewind: current balances, said in words under Rewind
    holders: useAgedRes(useFetch('holders', () => fetchHolders('namada', 1, 10, '', 'total'), live ? 5 * MIN : undefined, undefined, n), old, receivedAt),
    // live only (build-plan 6, W12): not requested while rewound
    curve: useAgedRes(useFetch(live ? 'curve' : null, () => fetchQuoteCurve(), MIN, CURVE_KEEP, n), old, receivedAt),
    quote: useAgedRes(useFetch(live ? 'quote' : null, () => fetchQuote(TICKET_NAM, 'sell'), MIN, undefined, n), old, receivedAt),
    spark: useFetch(wide ? k('spark') : null, () => fetchMetricHistory('price.swap_1h', 24 * 30, at)),
  };
}

// ---------------------------------------------------------------- latest moves

/**
 * Latest moves: the server's page (?minNam, ?arb=false, ?pairs=one) with the streamed rows on top. Streamed rows
 * are not filtered by the server, so the same rules (lib/flows.ts) run over the merged list. Newest first.
 */
export const latestMoves = (rows: Flow[], min = MOVES_MIN_NAM): Flow[] => applyFlowRules(mergeFlows(rows), { minNam: min, arb: false, pairs: 'one' });

const CHAIN_WORD = { namada: 'Namada', osmosis: 'Osmosis' } as const;

/** Which side of a move to name: the person, never the protocol account (staking, bridge, shielded pool); the same rule a Discord alert names its person by (shared/flow-words.ts). */
export function partyOf(f: Flow): { address: string | null; label: string | null; source: string | null; author: string | null } {
  return sharedPartyOf(f);
}

/** Where a bridge crossing went, in place names ("Osmosis to Namada"); null for other kinds. */
export function crossingWords(f: Flow): string | null {
  if (f.kind !== 'ibc_in' && f.kind !== 'ibc_out') return null;
  const here = CHAIN_WORD[f.chain];
  const there = f.chain === 'namada' ? 'Osmosis' : 'Namada';
  return f.kind === 'ibc_in' ? `${there} to ${here}` : `${here} to ${there}`;
}

/** Buys add NAM to the market and sells take it out; other kinds carry no sign (the caption says where it went). */
export const moveSign = (f: Flow): 1 | -1 | 0 => (f.kind === 'buy' ? 1 : f.kind === 'sell' ? -1 : 0);

export const partyText = (p: { address: string | null; label: string | null }) => (p.label ? p.label : fmtAddr(p.address));

// ---------------------------------------------------------------- alerts

/** The flow tag for an alert hit, from its rule (and, where a rule covers two kinds, its own title). */
export function hitKind(h: AlertHit): TagKind | null {
  switch (h.ruleId) {
    case 'ibc_inventory':
      // the rule fires on NAM arriving on Osmosis (its ibc_in): a crossing to Osmosis, the same words as Activity's
      return 'toOsmosis';
    case 'unshield':
    case 'exit_bridge':
      // a send over the bridge the shielded set paid for: drawn as a move out of it, as its first step was
      return 'shieldOut';
    case 'bond':
      return 'staked';
    case 'unlock':
      return /start/i.test(h.title) ? 'unstaking' : 'unlocked';
    case 'big_swap':
      return /^sold/i.test(h.title) ? 'sell' : /^bought/i.test(h.title) ? 'buy' : null;
    default:
      return null;
  }
}

/** The page a rewind to an alert opens on: the one that shows that kind of move first. */
export const hitPage = (h: AlertHit): string => (h.ruleId === 'unshield' || h.ruleId === 'exit_bridge' ? '/shielded' : h.ruleId === 'big_swap' ? '/activity' : '/supply');

