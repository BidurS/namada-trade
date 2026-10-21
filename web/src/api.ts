import type {
  Overview, AddressReport, SearchResult, PoolInfo, PriceQuote, QuoteCurveResponse, Check, IntelResponse,
  Pressure, BlindSpot, OrderflowResponse, AlertRuleInfo, Provenance, SourceHealth, UserSettings, SessionInfo,
  FlowsResponse, HoldersResponse, AlertsRecentResponse, Flow, Holder, HoldersBy, SearchResponse, NotServedBody,
  SeriesResponse, SeriesStep, PriceChangesResponse, VolumeResponse, PairsResponse, TradesResponse, ValuesResponse,
} from '../../shared/types';

export type {
  FlowsResponse, HoldersResponse, AlertsRecentResponse, OrderflowResponse, SearchResponse,
  SeriesResponse, PriceChangesResponse, VolumeResponse, PairsResponse, TradesResponse, ValuesResponse,
};

import { authFetch } from './lib/auth';
import { filterFlows, plainNotes, serverIgnoredFlowFilter, withAddressReport, withFlow, withHolder, withOverview, withPressure } from './lib/compat';

const at = (asOf: number | null, q: URLSearchParams = new URLSearchParams()) => {
  if (asOf) q.set('at', String(asOf));
  const s = q.toString();
  return s ? `?${s}` : '';
};

/** A request the caller can cancel: a superseded keystroke or page aborts its fetch (nav-search-plan.md 4.4). */
export interface RequestOpts {
  signal?: AbortSignal;
}

/**
 * A failed API answer. The message keeps the first build's form, `HTTP <status> <url>` (screens test it with
 * /HTTP \d+/); `reason` is the server's own words when its JSON body has them.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly reason: string | null;
  constructor(status: number, url: string, reason: string | null) {
    super(`HTTP ${status} ${url}`);
    this.name = 'ApiError';
    this.status = status;
    this.reason = reason;
  }
}

/**
 * The route is not served by this server (404: a deploy without it, or an unknown series key; 501: mounted but not
 * built, only while it was being built). A panel shows its "—" state with NOT_SERVED (shared/types.ts), never an
 * error (screener-plan 8).
 */
export const isNotServed = (e: unknown): boolean => e instanceof ApiError && (e.status === 501 || e.status === 404);

/** GET a JSON endpoint. Stamp notes come back in plain words (lib/compat.ts plainNotes: a no-op on a current server). */
async function get<T>(url: string, opts: RequestOpts = {}): Promise<T> {
  const res = await (opts.signal ? fetch(url, { signal: opts.signal }) : fetch(url));
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as Partial<NotServedBody> | null;
    throw new ApiError(res.status, url, typeof body?.reason === 'string' ? body.reason : typeof body?.error === 'string' ? body.error : null);
  }
  return plainNotes((await res.json()) as T);
}

export const fetchOverview = (asOf: number | null) => get<Overview>(`/api/overview${at(asOf)}`).then(withOverview);
export const fetchPressure = (asOf: number | null, days = 7) => get<Pressure>(`/api/pressure${at(asOf, new URLSearchParams({ days: String(days) }))}`).then(withPressure);
export const fetchBlindSpot = (asOf: number | null) => get<BlindSpot>(`/api/blindspot${at(asOf)}`).then((b) => ({ ...b, unshields: b.unshields.map(withFlow) }));
export const fetchOrderflow = (hours = 720, asOf: number | null = null) => get<OrderflowResponse>(`/api/orderflow${at(asOf, new URLSearchParams({ hours: String(hours) }))}`);
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

/** The holder list's query (HoldersRequest in shared/types.ts, typed): the URL state of /holders mapped to the API. */
export interface HoldersQuery {
  chain?: 'all' | 'namada' | 'osmosis';
  by?: HoldersBy;
  /** a raw category in lower case, or 'none' */
  category?: string;
  /** the list field's text; the server reads it with the search grammar */
  search?: string;
  /** NAM on the sort's figure */
  min?: number | null;
  max?: number | null;
  page?: number;
  /** HoldersResponse.next of the page before; wins over `page` on a current server (`page` is still sent for older ones) */
  after?: string | null;
  limit?: number;
}

/** The query string of /api/holders for a HoldersQuery (defaults left out). */
export function holdersParams(o: HoldersQuery = {}): URLSearchParams {
  const q = new URLSearchParams({ chain: o.chain ?? 'all' });
  if (o.by && o.by !== 'total') q.set('by', o.by);
  if (o.category) q.set('category', o.category);
  if (o.search) q.set('search', o.search);
  if (o.min != null && o.min > 0) q.set('min', String(o.min));
  if (o.max != null && o.max > 0) q.set('max', String(o.max));
  if (o.page && o.page > 1) q.set('page', String(o.page));
  if (o.after) q.set('after', o.after);
  if (o.limit) q.set('limit', String(o.limit));
  return q;
}

/**
 * A page of holders. `cursorPaged` is false on a server before the stored-totals build (it sends no `asOf`): it
 * ignored `after`, `min` and `max`, so `next` is null (page by number) and the sizes are applied to these rows here,
 * listed in `ignored` (its `total` then counts the rows before them: an upper bound, said by `exact: false`).
 */
export interface HoldersPage extends HoldersResponse {
  next: string | null;
  cursorPaged: boolean;
  ignored: ('after' | 'min' | 'max')[];
  exact: boolean;
}

const figureOf = (h: Holder, by: HoldersBy | undefined) => (by === 'liquid' ? h.balance : by === 'bonded' ? h.bonded ?? 0 : h.total);

export async function fetchHoldersPage(o: HoldersQuery = {}, opts: RequestOpts = {}): Promise<HoldersPage> {
  const r = await get<HoldersResponse>(`/api/holders?${holdersParams(o)}`, opts);
  const now = Date.now();
  let holders = r.holders.map((h) => withHolder(h, now));
  const current = r.asOf !== undefined;
  const ignored: HoldersPage['ignored'] = [];
  if (!current) {
    if (o.after) ignored.push('after');
    if (o.min != null && o.min > 0) ignored.push('min');
    if (o.max != null && o.max > 0) ignored.push('max');
    if (ignored.includes('min') || ignored.includes('max')) {
      holders = holders.filter((h) => (o.min == null || figureOf(h, o.by) >= o.min) && (o.max == null || figureOf(h, o.by) <= o.max));
    }
  }
  return { ...r, holders, next: current ? r.next ?? null : null, cursorPaged: current, ignored, exact: !ignored.some((k) => k !== 'after') };
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
  /** unix ms: moves at or after it (the cursor build's filters from here on; nav-search-plan.md 2.2) */
  since?: number | null;
  /** an address start (ADDRESS_PREFIX_MIN characters or more) or a whole address, on either side */
  addr?: string | null;
  /** a record (transaction hash) start of HASH_PREFIX_MIN hex characters or more */
  hash?: string | null;
  /** a block height */
  height?: number | null;
  /** 'none': rows only, no count (`total` comes back null): for lists that show rows and never a count */
  count?: 'none';
}

/** A moves page by position: a cursor (FlowsResponse.next) or a plain unix-ms time (a date jump). */
export interface FlowsCursorQuery extends FlowsQuery {
  before?: string | number | null;
}

/** The query string of /api/flows (also used by its CSV export). */
export function flowsParams(opts: FlowsCursorQuery = {}): URLSearchParams {
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
  if (opts.since) q.set('since', String(opts.since));
  if (opts.addr) q.set('addr', opts.addr);
  if (opts.hash) q.set('hash', opts.hash);
  if (opts.height) q.set('height', String(opts.height));
  if (opts.before != null && opts.before !== '') q.set('before', String(opts.before));
  if (opts.count === 'none') q.set('count', 'none');
  return q;
}

/** The cursor build's filters a query sets (a server before that build ignores every one of them). */
const NEW_FLOW_FILTERS = ['since', 'addr', 'hash', 'height'] as const;
type NewFlowFilter = (typeof NEW_FLOW_FILTERS)[number];
const newFiltersOf = (o: FlowsQuery): NewFlowFilter[] => NEW_FLOW_FILTERS.filter((k) => o[k] != null && o[k] !== '' && o[k] !== 0);

/** The cursor build's filters applied to rows here, for a server that ignored them (the same conditions as the route). */
function filterNew(flows: Flow[], o: FlowsQuery): Flow[] {
  const addr = o.addr?.toLowerCase();
  const hash = o.hash?.toUpperCase();
  return flows.filter((f) =>
    (!o.since || f.ts >= o.since) &&
    (!addr || [f.from, f.to].some((a) => !!a && a.startsWith(addr))) &&
    (!hash || f.txHash.toUpperCase().startsWith(hash)) &&
    (!o.height || f.height === o.height));
}

/**
 * A page of flows. `exact` is false when the size, bot or crossing rules were applied here, because the
 * server (one that predates W1) ignored them: `total` is then the server's count before those rules (an
 * upper bound, never "the moves that match"), and `more` says whether a later page may hold more rows.
 * The same holds for the cursor build's filters (since, addr, hash, height) on a server before that build.
 */
export interface FlowsPage extends Omit<FlowsResponse, 'total'> {
  /** a head or offset page always carries its count (a null one only comes behind a cursor: fetchFlowsPage) */
  total: number;
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
  const added = newFiltersOf(opts);
  const page = opts.page ?? 1;
  const limit = opts.limit ?? 50;
  const key = flowsParams({ ...opts, page: undefined, limit: undefined }).toString();
  /** a server that sends no `asOf` predates the cursor build and ignored `added`: those run here, and the count is an upper bound */
  const pageOf = (r: FlowsResponse, flows: Flow[], exact: boolean, more: boolean): FlowsPage => {
    const known = r.asOf !== undefined;
    const kept = added.length && !known ? filterNew(flows, opts) : flows;
    if (r.total == null) throw new ApiError(500, '/api/flows', 'The server sent no count for a page without a cursor.');
    return { ...r, total: r.total, flows: kept.map(withFlow), exact: exact && kept.length === flows.length && (known || !added.length), more };
  };
  let mode = hasRules ? flowPaging.get(key) ?? (flowRulesIgnored ? 'client' : undefined) : 'server';
  if (mode !== 'client') {
    const r = await get<FlowsResponse>(`/api/flows?${flowsParams(opts)}`);
    if (mode === 'server' || !serverIgnoredFlowFilter(r.flows, rules)) {
      if (hasRules && page === 1) flowPaging.set(key, 'server');
      const flows = hasRules ? filterFlows(r.flows, rules) : r.flows;
      const exact = flows.length === r.flows.length;
      return pageOf(r, flows, exact, page * (r.limit || limit) < (r.total ?? 0));
    }
    flowRulesIgnored = true;
    mode = 'client';
  }
  if (page === 1) flowPaging.set(key, 'client');
  const wide = await get<FlowsResponse>(`/api/flows?${flowsParams({ ...opts, page, limit: 100 })}`);
  return { ...pageOf(wide, filterFlows(wide.flows, rules), false, wide.flows.length >= 100), limit, exact: false };
}

/**
 * A page of moves by position (nav-search-plan.md 2.2). On a current server `before` wins over `page` and `next`
 * is the cursor for the older rows; `total` is null behind a cursor (the head page said it). A server before the
 * cursor build sends no `next`: `cursorPaged` is false, it paged by `page` (always sent, so the rows are right),
 * and the filters it does not know are listed in `ignored`: the cursor build's filters are applied to the rows here
 * (`exact` false), a date jump cannot be (`before` listed: the screen says this server cannot jump to a date).
 */
export interface FlowsCursorPage extends FlowsResponse {
  next: string | null;
  cursorPaged: boolean;
  ignored: (NewFlowFilter | 'before')[];
  exact: boolean;
}

export async function fetchFlowsPage(o: FlowsCursorQuery = {}, opts: RequestOpts = {}): Promise<FlowsCursorPage> {
  const r = await get<FlowsResponse>(`/api/flows?${flowsParams(o)}`, opts);
  const cursorPaged = r.next !== undefined;
  if (cursorPaged) return { ...r, flows: r.flows.map(withFlow), next: r.next ?? null, cursorPaged, ignored: [], exact: true };
  const ignored: FlowsCursorPage['ignored'] = [...newFiltersOf(o), ...(o.before != null && o.before !== '' ? (['before'] as const) : [])];
  const flows = filterNew(r.flows, o);
  return { ...r, flows: flows.map(withFlow), next: null, cursorPaged, ignored, exact: flows.length === r.flows.length && !ignored.length };
}

/** The CSV of the moves a query selects (the same filters as fetchFlows; up to 5,000 rows, newest first). */
export const flowsCsvHref = (opts: FlowsQuery = {}) => {
  const q = flowsParams({ ...opts, page: undefined, limit: undefined });
  q.set('format', 'csv');
  q.set('limit', '5000');
  return `/api/export/flows?${q}`;
};

/** The CSV of the holder list (the same chain, order, category, search and sizes as fetchHoldersPage). */
export const holdersCsvHref = (o: { chain?: string; by?: 'total' | 'liquid' | 'bonded'; category?: string; search?: string; min?: number | null; max?: number | null } = {}) => {
  const q = new URLSearchParams({ chain: o.chain ?? 'all', by: o.by ?? 'total', format: 'csv' });
  if (o.category) q.set('category', o.category);
  if (o.search) q.set('search', o.search);
  if (o.min != null && o.min > 0) q.set('min', String(o.min));
  if (o.max != null && o.max > 0) q.set('max', String(o.max));
  return `/api/export/holders?${q}`;
};

/**
 * Newest moves as rows only (`count=none`: the server takes no count, `total` is null): for lists that never show a
 * count. Each row is newest first; the W1 rules run here too, for a server that predates them (lib/compat.ts).
 */
export async function fetchFlowRows(o: FlowsQuery = {}, opts: RequestOpts = {}): Promise<FlowsResponse> {
  const r = await get<FlowsResponse>(`/api/flows?${flowsParams({ ...o, page: undefined, count: 'none' })}`, opts);
  const flows = filterFlows(r.flows, { minNam: o.minNam, arb: o.arb, pairs: o.pairs });
  return { ...r, total: null, flows: flows.map(withFlow) };
}

/**
 * Home "Latest moves": at least `minNam` NAM, bots removed, each bridge crossing once, newest first
 * (the server sends at least 10 rows; the list shows six). Rows only: no count is taken.
 */
export const fetchLatestMoves = (asOf: number | null, minNam = 1000) => fetchFlowRows({ asOf, minNam, arb: false, pairs: 'one', limit: 10 });

/** The live feed's first rows (the shell's stream seeds its list with them): rows only, no count. */
export const fetchLiveSeed = (limit = 30, opts: RequestOpts = {}) => fetchFlowRows({ limit }, opts);

export const fetchPools = () => get<{ pools: PoolInfo[]; prov: Provenance }>('/api/pools');
export const fetchQuote = (amount: number, side: 'buy' | 'sell') => get<{ quote: PriceQuote | null; error?: string }>(`/api/quote?amount=${amount}&side=${side}`);
export const fetchQuoteCurve = () => get<QuoteCurveResponse>('/api/quote/curve');
export const fetchAddressReport = (address: string) => get<AddressReport>(`/api/address/${encodeURIComponent(address)}`).then(withAddressReport);
export const fetchIntegrity = () => get<{ checks: Check[]; sources: SourceHealth[]; at: number }>('/api/integrity');
export const fetchIntel = () => get<IntelResponse>('/api/intel');

/** Address, transaction and label search. Rejects when the server does not answer: a failure is not "no match". */
export async function searchOmni(query: string, opts: RequestOpts = {}): Promise<SearchResult[]> {
  if (!query.trim()) return [];
  return (await get<{ results: SearchResult[] }>(`/api/search?q=${encodeURIComponent(query)}`, opts)).results ?? [];
}

/**
 * The grouped search (nav-search-plan.md 4.2): results with `group`, `kind`, `match`, `href` and `stamp`, and the
 * answer's `asOf`. A server before nav step 5 answers the same shape without them (every result then reads as the
 * first build's `type`). Rejects when the server does not answer.
 */
export async function searchGrouped(query: string, opts: RequestOpts & { limit?: number } = {}): Promise<SearchResponse> {
  if (!query.trim()) return { results: [] };
  const q = new URLSearchParams({ q: query });
  if (opts.limit) q.set('limit', String(opts.limit));
  const r = await get<SearchResponse>(`/api/search?${q}`, opts);
  return { ...r, results: r.results ?? [] };
}

// ---------------------------------------------------------------- series and the Trade basics (shared/types.ts; worker/src/api-series.ts)
// Each rejects with an ApiError; isNotServed(e) is true on a server without the route (404), and the panel shows
// "—" with NOT_SERVED, never an error. A 400 is the route refusing the request as asked, in plain words.

export interface SeriesQuery {
  key: string;
  /** unix ms or YYYY-MM-DD */
  from?: number | string;
  to?: number | string;
  step?: SeriesStep;
  asOf?: number | null;
}

export function seriesParams(o: SeriesQuery): URLSearchParams {
  const q = new URLSearchParams({ key: o.key });
  if (o.from != null && o.from !== '') q.set('from', String(o.from));
  if (o.to != null && o.to !== '') q.set('to', String(o.to));
  if (o.step) q.set('step', o.step);
  if (o.asOf) q.set('at', String(o.asOf));
  return q;
}

/** One stored series with its sources, honest start and gaps. */
export const fetchSeries = (o: SeriesQuery, opts: RequestOpts = {}) => get<SeriesResponse>(`/api/series?${seriesParams(o)}`, opts);
/** The quoted price's 1 h, 6 h, 24 h, 7 d and 30 d changes and the pool price's, each with the reading it is measured from. */
export const fetchPriceChanges = (asOf: number | null, opts: RequestOpts = {}) => get<PriceChangesResponse>(`/api/series/changes${at(asOf)}`, opts);
/** Executed volume per window with its definition, and the Osmosis pair summary's figure beside it. */
export const fetchVolume = (asOf: number | null, opts: RequestOpts = {}) => get<VolumeResponse>(`/api/series/volume${at(asOf)}`, opts);
/** The NAM pools: router depth and the Osmosis data API's volume per pool. Live only (no `at`). */
export const fetchPairs = (opts: RequestOpts = {}) => get<PairsResponse>('/api/series/pairs', opts);
/** All NAM and spendable NAM at today's price, each with its definition and inputs (never "market cap"). */
export const fetchValues = (asOf: number | null, opts: RequestOpts = {}) => get<ValuesResponse>(`/api/series/values${at(asOf)}`, opts);

export interface TradesQuery {
  /** TradesResponse.next, or a unix-ms time */
  before?: string | number | null;
  maker?: string | null;
  min?: number | null;
  limit?: number;
  asOf?: number | null;
}

export function tradesParams(o: TradesQuery = {}): URLSearchParams {
  const q = new URLSearchParams();
  if (o.before != null && o.before !== '') q.set('before', String(o.before));
  if (o.maker) q.set('maker', o.maker);
  if (o.min != null && o.min > 0) q.set('min', String(o.min));
  if (o.limit) q.set('limit', String(o.limit));
  if (o.asOf) q.set('at', String(o.asOf));
  return q;
}

/** The trades tape, newest first, with consecutive repeats folded into groups. */
export const fetchTrades = (o: TradesQuery = {}, opts: RequestOpts = {}) => {
  const q = tradesParams(o).toString();
  return get<TradesResponse>(`/api/series/trades${q ? `?${q}` : ''}`, opts);
};

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
  return (await fetchMetricSeries(key, hours, asOf)).history;
}
/** The same history with the server's point spacing (bucketMs; null when the server does not send it). */
export async function fetchMetricSeries(key: string, hours: number, asOf: number | null = null): Promise<{ history: MetricPoint[]; bucketMs: number | null }> {
  const r = await get<{ history: MetricPoint[]; bucketMs?: number }>(`/api/metrics/history${at(asOf, new URLSearchParams({ key, hours: String(hours) }))}`);
  return { history: r.history ?? [], bucketMs: typeof r.bucketMs === 'number' && r.bucketMs > 0 ? r.bucketMs : null };
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
