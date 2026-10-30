// The series API (docs/design/screener-plan.md 2.12 and the Trade basics 2.1 to 2.7, 2.11), a Hono sub-app mounted
// by one line in api.ts: `app.route('/api/series', seriesApp)`. The contract is in shared/types.ts; the reads and
// their costs are in worker/src/series-api.ts.
//
//   GET /api/series?key=&from=&to=&step=&at=        SeriesResponse        points with their sources, start and gaps
//   GET /api/series/changes?at=                     PriceChangesResponse  1 h / 6 h / 24 h / 7 d / 30 d, each with its base
//   GET /api/series/volume?at=                      VolumeResponse        executed volume per window, with its definition
//   GET /api/series/pairs                           PairsResponse         the NAM pools with the Osmosis data API's volume
//   GET /api/series/trades?before=&maker=&min=&limit=&at=  TradesResponse  the tape, keyset paged, repeats folded
//   GET /api/series/values?at=                      ValuesResponse        all NAM and spendable NAM at today's price,
//                                                                         each with its definition (never "market cap")
//
// A request the route cannot answer as asked is refused with plain words (400), an unknown key or path is a 404 in
// the NotServedBody shape, and no refusal or failure is ever cached (Cache-Control: no-store). Every query
// parameter a route reads is listed in SERIES_PARAMS and read only through `params()`, so the edge cache key
// (worker/src/http.ts CACHE_PARAMS) can be checked against it (test/series-api.test.ts). The refusal body, the `?at=`
// reading and the route wrapper are worker/src/api-route.ts, shared with the depth routes.
import { Hono, type Context } from 'hono';
import type { Env } from './util';
import { NOT_SERVED, TRADES_LIMIT_MAX } from '../../shared/types';
import { asOfOf, refuse, route } from './api-route';
import { parseBeforeParam, clampLimit, LIMIT_MIN } from '../../shared/paging';
import { isWholeAddress } from '../../shared/search-grammar';
import { readPoolsRow } from './pool-sizes';
import { readSeries, readChanges, readVolume, readPairs, readTrades, readValues, SeriesInputError } from './series-api';

export const seriesApp = new Hono<{ Bindings: Env }>();

/** The query parameters each route reads. The edge cache key must list every one (worker/src/http.ts CACHE_PARAMS). */
export const SERIES_PARAMS = {
  '/api/series': ['key', 'from', 'to', 'step', 'at'],
  '/api/series/changes': ['at'],
  '/api/series/volume': ['at'],
  '/api/series/pairs': [],
  '/api/series/trades': ['before', 'maker', 'min', 'limit', 'at'],
  '/api/series/values': ['at'],
} as const satisfies Record<string, readonly string[]>;
type Route = keyof typeof SERIES_PARAMS;

/** The parameters of one route, and nothing else (a parameter not listed for the route cannot be read). */
function params<R extends Route>(c: Context, route: R): Record<(typeof SERIES_PARAMS)[R][number], string | undefined> {
  const out = {} as Record<string, string | undefined>;
  for (const k of SERIES_PARAMS[route] as readonly string[]) out[k] = c.req.query(k);
  return out as Record<(typeof SERIES_PARAMS)[R][number], string | undefined>;
}

seriesApp.get('/', route('/api/series', async (c) => {
  const p = params(c, '/api/series');
  if (!p.key) throw new SeriesInputError(400, 'key is required: the stored series to read (for example price.usd).');
  const { asOf, replay } = asOfOf(p.at);
  return readSeries(c.env.DB, { key: p.key, from: p.from, to: p.to, step: p.step }, asOf, replay);
}));

seriesApp.get('/changes', route('/api/series/changes', async (c) => {
  const { asOf, replay } = asOfOf(params(c, '/api/series/changes').at);
  return readChanges(c.env.DB, asOf, replay);
}));

seriesApp.get('/volume', route('/api/series/volume', async (c) => {
  const { asOf, replay } = asOfOf(params(c, '/api/series/volume').at);
  return readVolume(c.env.DB, asOf, replay);
}));

seriesApp.get('/pairs', route('/api/series/pairs', async (c) => {
  params(c, '/api/series/pairs');
  // Current only: the cron's stored pool list (as /api/pools; never the router), the stored hour of the Osmosis app's figures beside it.
  const r = await readPoolsRow(c.env.DB);
  return readPairs(c.env.DB, Date.now(), r.row, r.failed);
}));

seriesApp.get('/trades', route('/api/series/trades', async (c) => {
  const p = params(c, '/api/series/trades');
  const { asOf, replay } = asOfOf(p.at);
  const maker = p.maker ? p.maker.trim().toLowerCase() : null;
  if (maker && !isWholeAddress(maker)) throw new SeriesInputError(400, 'maker must be a whole address.');
  let min: number | null = null;
  if (p.min != null && p.min !== '') {
    min = Number(p.min);
    if (!Number.isFinite(min) || min < 0) throw new SeriesInputError(400, 'min must be a number of NAM, 0 or more.');
    if (min === 0) min = null;
  }
  // `before`: a cursor from a previous page or a plain unix-ms time; anything else is the head page (shared/paging.ts).
  const limit = Math.min(TRADES_LIMIT_MAX, Math.max(LIMIT_MIN, clampLimit(p.limit)));
  return readTrades(c.env.DB, { before: parseBeforeParam(p.before), maker, min, limit }, asOf, replay);
}));

seriesApp.get('/values', route('/api/series/values', async (c) => {
  const { asOf, replay } = asOfOf(params(c, '/api/series/values').at);
  return readValues(c.env.DB, asOf, replay);
}));

seriesApp.all('*', (c) => refuse(c, 404, new URL(c.req.url).pathname, NOT_SERVED, 'No such series route.'));
