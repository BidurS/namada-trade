// The per-address limits on the public API as the API page states them (web/src/screens/seo/Developers.tsx). The
// numbers are the ones the Worker is configured with (wrangler.jsonc ratelimits) and the kinds are the ones the Worker
// sorts a request into (worker/src/http.ts limiterFor, isReplay, wsLimited). Each is counted by the address a request
// comes from (worker/src/client-key.ts: an IPv6 address by its /64) and by the kind of route, so two kinds do not
// share a count. test/platform-pages.test.ts holds each row equal to its binding, so the page cannot state a limit
// the site does not have.

export interface ApiLimit {
  /** The Worker's binding the row is checked against (wrangler.jsonc ratelimits[].name). */
  binding: 'HEAVY_LIMITER' | 'SEARCH_LIMITER' | 'REPLAY_LIMITER' | 'WS_LIMITER';
  /** What kind of request it counts, in plain words. */
  what: string;
  /** Requests allowed in `seconds`. */
  limit: number;
  seconds: number;
}

export const API_LIMITS: ApiLimit[] = [
  { binding: 'HEAVY_LIMITER', what: 'A live quote, an address report, or a file of moves or holders, each counted apart', limit: 30, seconds: 60 },
  { binding: 'SEARCH_LIMITER', what: 'A search, and the lists of moves or holders searched by text', limit: 120, seconds: 60 },
  { binding: 'REPLAY_LIMITER', what: 'A read of a past moment, a metric history, an alert size of your own, or a list page the pages do not ask for themselves; counted only when the answer was not already kept', limit: 120, seconds: 60 },
  { binding: 'WS_LIMITER', what: 'An attempt to open the live connection', limit: 60, seconds: 60 },
];
