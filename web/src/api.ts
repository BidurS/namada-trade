import type {
  Overview, AddressReport, SearchResult, PoolInfo, PriceQuote, QuoteCurveResponse, Check, IntelResponse,
  Pressure, BlindSpot, AlertRuleInfo, Provenance, SourceHealth, UserSettings, SessionInfo,
  FlowsResponse, HoldersResponse, AlertsRecentResponse,
} from '../../shared/types';

export type { FlowsResponse, HoldersResponse, AlertsRecentResponse };

import { authFetch } from './lib/auth';
import { filterFlows, plainNotes, serverIgnoredFlowFilter, withAddressReport, withFlow, withHolder, withOverview, withPressure } from './lib/compat';

const at = (asOf: number | null, q: URLSearchParams = new URLSearchParams()) => {
  if (asOf) q.set('at', String(asOf));
  const s = q.toString();
  return s ? `?${s}` : '';
};

/** GET a JSON endpoint. Stamp notes come back in plain words (lib/compat.ts plainNotes: a no-op on a current server). */
async function get<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return plainNotes((await res.json()) as T);
}

export const fetchOverview = (asOf: number | null) => get<Overview>(`/api/overview${at(asOf)}`).then(withOverview);
export const fetchPressure = (asOf: number | null, days = 7) => get<Pressure>(`/api/pressure${at(asOf, new URLSearchParams({ days: String(days) }))}`).then(withPressure);
export const fetchBlindSpot = (asOf: number | null) => get<BlindSpot>(`/api/blindspot${at(asOf)}`).then((b) => ({ ...b, unshields: b.unshields.map(withFlow) }));
export const fetchAlertRules = () => get<{ rules: AlertRuleInfo[] }>('/api/alerts/rules');
/**
 * Alert hits in [since, until) and `last`: the most recent hit of any age before `until` (the empty state's
 * "The last one: …"). `since` defaults to 24 h before `until`; `until` is now, or the rewind time.
 */
export const fetchAlertsRecent = (asOf: number | null, since?: number) =>
  get<AlertsRecentResponse>(`/api/alerts/recent${at(asOf, new URLSearchParams(since ? { since: String(since) } : {}))}`);

/**
 * An alerts answer with how far `last` is known. `last: null` alone means none is on record (the server
 * searched everything). With `lastUnknown`, the search for it failed: say nothing, or that it could not
 * be read. With `lastSearchedMs`, only that span before `until` was searched and it held no alert: say
 * "No alert in the last 30 days", never "none on record".
 */
export interface AlertsWithLast extends AlertsRecentResponse {
  lastUnknown?: boolean;
  lastSearchedMs?: number;
}

const LAST_WINDOW_MS = 30 * 86_400_000;

/**
 * fetchAlertsRecent, and `last` answered as far as it can be: a server that predates W5 sends no `last`, so
 * one 30-day read finds the newest hit. A current server answers in one request (and omits `last` when its
 * own search failed, which reads as not known).
 */
export async function fetchAlertsRecentWithLast(asOf: number | null, since?: number): Promise<AlertsWithLast> {
  const r = await fetchAlertsRecent(asOf, since);
  if (r.last !== undefined) return r;
  if (r.hits.length) return { ...r, last: r.hits[0] };
  const wide = await fetchAlertsRecent(asOf, (asOf ?? Date.now()) - LAST_WINDOW_MS).catch(() => null);
  if (!wide) return { ...r, last: null, lastUnknown: true };
  return wide.hits[0] ? { ...r, last: wide.hits[0] } : { ...r, last: null, lastSearchedMs: LAST_WINDOW_MS };
}

/**
 * Holder rows with a server `status` and `statusNote` (owner decision 7), `label_plain` / `category_plain`
 * (owner decision 6) and 24 h / 7 d changes that are null when not known. No `at`: balances are current,
 * not as of a rewind time, and the UI says so.
 */
export function fetchHolders(chain = 'all', page = 1, limit = 50, search = '', by: 'total' | 'liquid' | 'bonded' = 'total', category = '') {
  const q = new URLSearchParams({ chain, page: String(page), limit: String(limit), by, ...(search ? { search } : {}), ...(category ? { category } : {}) });
  return get<HoldersResponse>(`/api/holders?${q}`).then((r) => {
    const now = Date.now();
    return { ...r, holders: r.holders.map((h) => withHolder(h, now)) };
  });
}

export interface FlowsQuery {
  asOf?: number | null;
  chain?: string;
  kind?: string;
  whale?: boolean;
  search?: string;
  page?: number;
  /** clamped to 10…100 by the server */
  limit?: number;
  /** at least this many NAM; flows of other coins never count */
  minNam?: number;
  /** false: bot trades (round trips) removed */
  arb?: boolean;
  /** 'one': each bridge crossing once (it is recorded on both chains) */
  pairs?: 'one';
}

/** The query string of /api/flows (also used by its CSV export). */
export function flowsParams(opts: FlowsQuery = {}): URLSearchParams {
  const q = new URLSearchParams();
  if (opts.chain && opts.chain !== 'all') q.set('chain', opts.chain);
  if (opts.kind && opts.kind !== 'all') q.set('kind', opts.kind);
  if (opts.whale) q.set('whale', 'true');
  if (opts.search) q.set('search', opts.search);
  if (opts.page) q.set('page', String(opts.page));
  if (opts.limit) q.set('limit', String(opts.limit));
  if (opts.minNam != null && opts.minNam > 0) q.set('minNam', String(opts.minNam));
  if (opts.arb === false) q.set('arb', 'false');
  if (opts.pairs === 'one') q.set('pairs', 'one');
  if (opts.asOf) q.set('at', String(opts.asOf));
  return q;
}

/**
 * A page of flows. `exact` is false when the size, bot or crossing rules were applied here, because the
 * server (one that predates W1) ignored them: `total` is then the server's count before those rules (an
 * upper bound, never "the moves that match"), and `more` says whether a later page may hold more rows.
 */
export interface FlowsPage extends FlowsResponse {
  exact: boolean;
  more: boolean;
}

/** Set once a page gives away a server that predates W1 (it ignored ?minNam, ?arb=false or ?pairs=one). */
let flowRulesIgnored = false;
/** How page 1 of each query was read, so its later pages keep the same paging ('client': 100-row pages filtered here). */
const flowPaging = new Map<string, 'server' | 'client'>();

/**
 * Flows newest first. With `asOf`, nothing newer than that time (rewind). A server that predates W1 ignores
 * ?minNam, ?arb=false and ?pairs=one (a row the filter would remove gives it away, lib/flows.ts): then the
 * same rules run here over 100-row server pages (page n of the list is server page n), and the answer says
 * that its total is not the count of matches. The rules also run over a current server's page, where they
 * remove nothing.
 */
export async function fetchFlows(opts: FlowsQuery = {}): Promise<FlowsPage> {
  const rules = { minNam: opts.minNam, arb: opts.arb, pairs: opts.pairs };
  const hasRules = (rules.minNam ?? 0) > 0 || rules.arb === false || rules.pairs === 'one';
  const page = opts.page ?? 1;
  const limit = opts.limit ?? 50;
  const key = flowsParams({ ...opts, page: undefined, limit: undefined }).toString();
  let mode = hasRules ? flowPaging.get(key) ?? (flowRulesIgnored ? 'client' : undefined) : 'server';
  if (mode !== 'client') {
    const r = await get<FlowsResponse>(`/api/flows?${flowsParams(opts)}`);
    if (mode === 'server' || !serverIgnoredFlowFilter(r.flows, rules)) {
      if (hasRules && page === 1) flowPaging.set(key, 'server');
      const flows = hasRules ? filterFlows(r.flows, rules) : r.flows;
      const exact = flows.length === r.flows.length;
      return { ...r, flows: flows.map(withFlow), exact, more: page * (r.limit || limit) < r.total };
    }
    flowRulesIgnored = true;
    mode = 'client';
  }
  if (page === 1) flowPaging.set(key, 'client');
  const wide = await get<FlowsResponse>(`/api/flows?${flowsParams({ ...opts, page, limit: 100 })}`);
  return { ...wide, limit, flows: filterFlows(wide.flows, rules).map(withFlow), exact: false, more: wide.flows.length >= 100 };
}

/** The CSV of the moves a query selects (the same filters as fetchFlows; up to 5,000 rows, newest first). */
export const flowsCsvHref = (opts: FlowsQuery = {}) => {
  const q = flowsParams({ ...opts, page: undefined, limit: undefined });
  q.set('format', 'csv');
  q.set('limit', '5000');
  return `/api/export/flows?${q}`;
};

/** The CSV of the holder list (the same chain, order, category and search as fetchHolders). */
export const holdersCsvHref = (o: { chain?: string; by?: 'total' | 'liquid' | 'bonded'; category?: string; search?: string } = {}) => {
  const q = new URLSearchParams({ chain: o.chain ?? 'all', by: o.by ?? 'total', format: 'csv' });
  if (o.category) q.set('category', o.category);
  if (o.search) q.set('search', o.search);
  return `/api/export/holders?${q}`;
};

/**
 * Home "Latest moves": at least `minNam` NAM, bots removed, each bridge crossing once, newest first
 * (the server sends at least 10 rows; the list shows six).
 */
export const fetchLatestMoves = (asOf: number | null, minNam = 1000) => fetchFlows({ asOf, minNam, arb: false, pairs: 'one', limit: 10 });

export const fetchPools = () => get<{ pools: PoolInfo[]; prov: Provenance }>('/api/pools');
export const fetchQuote = (amount: number, side: 'buy' | 'sell') => get<{ quote: PriceQuote | null; error?: string }>(`/api/quote?amount=${amount}&side=${side}`);
export const fetchQuoteCurve = () => get<QuoteCurveResponse>('/api/quote/curve');
export const fetchAddressReport = (address: string) => get<AddressReport>(`/api/address/${address}`).then(withAddressReport);
export const fetchIntegrity = () => get<{ checks: Check[]; sources: SourceHealth[]; at: number }>('/api/integrity');
export const fetchIntel = (refresh = false) => get<IntelResponse>(`/api/intel${refresh ? '?refresh=true' : ''}`);

/** Address, transaction and label search. Rejects when the server does not answer: a failure is not "no match". */
export async function searchOmni(query: string): Promise<SearchResult[]> {
  if (!query.trim()) return [];
  return (await get<{ results: SearchResult[] }>(`/api/search?q=${encodeURIComponent(query)}`)).results ?? [];
}

/**
 * A stored metric's history, oldest first. Rejects when the server does not answer, so a failed read is
 * never shown as "no trades in this window"; an empty array is a real empty answer.
 */
export interface MetricPoint {
  ts: number;
  /** the last reading of the bucket, at `ts` */
  value: number;
  /** the bucket's lowest and highest reading and how many it holds (absent on servers before 2026-10-18) */
  lo?: number;
  hi?: number;
  n?: number;
}
export async function fetchMetricHistory(key: string, hours: number, asOf: number | null = null): Promise<MetricPoint[]> {
  return (await get<{ history: MetricPoint[]; bucketMs?: number }>(`/api/metrics/history${at(asOf, new URLSearchParams({ key, hours: String(hours) }))}`)).history ?? [];
}

export async function saveLabel(address: string, label: string, category = 'watch', note = ''): Promise<{ ok: boolean; error?: string }> {
  const res = await authFetch('/api/labels', { method: 'POST', body: JSON.stringify({ address, label, category, note }) });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, error: data.error };
}

// ---- signed-in user
async function meJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await authFetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
export const fetchSettings = () => meJson<{ settings: UserSettings }>('/api/me/settings').then((r) => r.settings);
export const updateSettings = (patch: unknown) => meJson<{ settings: UserSettings }>('/api/me/settings', { method: 'PUT', body: JSON.stringify(patch) }).then((r) => r.settings);
export const testDiscord = () => meJson<{ success: boolean }>('/api/me/settings/test', { method: 'POST', body: '{}' });
export const fetchSessions = () => meJson<{ sessions: SessionInfo[] }>('/api/me/sessions').then((r) => r.sessions);
export const revokeSession = (id: string) => meJson<{ success: boolean }>(`/api/me/sessions/${id}`, { method: 'DELETE' });
export const createApiKey = () => meJson<{ token: string; expiresAt: number }>('/api/me/apikey', { method: 'POST', body: '{}' });
export const exportMe = () => meJson<unknown>('/api/me/export');
export const deleteMe = () => meJson<{ success: boolean }>('/api/me', { method: 'DELETE' });
