// What the read-only sub-apps share (worker/src/api-series.ts, api-depth.ts): the refusal an input error becomes, the
// `?at=` reading, the plain-words refusal body and the wrapper that runs one route. A route's own refusal is an
// ApiInputError (400 or 404, the message in plain words); anything else thrown is a failure, logged and answered 500.
// No refusal or failure is ever cached (Cache-Control: no-store), so a bad request never becomes the stored copy.
import type { Context } from 'hono';
import type { Env } from './util';
import type { NotServedBody } from '../../shared/types';

export class ApiInputError extends Error {
  constructor(readonly status: 400 | 404, message: string, readonly reason?: string) { super(message); }
}

/** `?at=<unix ms>`: answers as of that time (Rewind); anything else, or a time not in the past, is now. */
export function asOfOf(raw: string | undefined, now = Date.now()): { asOf: number; replay: boolean } {
  const at = raw ? Number(raw) : NaN;
  return Number.isFinite(at) && at > 0 && at < now ? { asOf: at, replay: true } : { asOf: now, replay: false };
}

export const refuse = (c: Context, status: 400 | 404 | 500, endpoint: string, error: string, reason?: string) => {
  const body: NotServedBody = { error, reason: reason ?? error, endpoint };
  c.header('Cache-Control', 'no-store');
  return c.json(body, status);
};

/** Run one route: an ApiInputError is the route's own refusal; anything else is a failure, never cached. */
export const route = (path: string, run: (c: Context<{ Bindings: Env }>) => Promise<unknown>) => async (c: Context<{ Bindings: Env }>) => {
  try {
    return c.json(await run(c));
  } catch (e) {
    if (e instanceof ApiInputError) return refuse(c, e.status, path, e.message, e.reason);
    console.error(path, e);
    return refuse(c, 500, path, 'Something went wrong on our side.');
  }
};
