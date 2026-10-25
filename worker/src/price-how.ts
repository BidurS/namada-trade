// How the NAM quote (metrics price.usd) was read, kept where the readers can say it. The quote service's price list
// gave NAM no price from 16:36 UTC on 23 Oct 2026 (after the 21 Oct sell-off left NAM's pools holding little besides
// NAM; the service gives no reason), and sources/sqs.ts fetchNamPrice then reads the spot price of pool 3005 alone, quoted for
// ROUTE_REF_NAM NAM. The cron keeps each change of the way it read the price in one kv row, price.how, written only
// when the way changes: the overview names the stored price's source and its route from it, as does a visitor's
// quote, whose spot is the stored minute.
import type { SourceHealth, Provenance } from '../../shared/types';
import { stmt, type Stmt } from './db';
import { priceSourceName, type NamPrice, type NamPriceHow } from './sources/sqs';

/** The kv row that keeps the changes of the way the NAM quote was read. */
export const PRICE_HOW_KEY = 'price.how';
/**
 * The changes price.how keeps, the newest last. The list dropped NAM on and off before the outage (14 changes in 45
 * minutes on 23 Oct), so 500 keeps at least a day of such flapping; a minute older than the oldest kept change is
 * named by the list's source.
 */
export const PRICE_HOW_KEEP = 500;
/** The health row of the NAM quote. */
export const PRICE_HEALTH_NAME = 'Osmosis SQS (price)';

/** One way the price was read, from `since` (the cron minute it was first read so) until the next entry's. */
export type PriceHowEntry = NamPriceHow & { since: number };
export interface PriceHowLog { log: PriceHowEntry[] }

/** Two readings the same way: the same path, size and pools; the liquidity figures may differ. */
function sameWay(a: NamPriceHow, b: NamPriceHow): boolean {
  if (a.how !== b.how) return false;
  if (a.how === 'list' || b.how === 'list') return true;
  const ids = (h: Extract<NamPriceHow, { how: 'route' }>) => JSON.stringify(h.routes.map((r) => r.map((p) => p.id)));
  return a.refNam === b.refNam && ids(a) === ids(b);
}

/**
 * The write that records `how` as of `at`, or null when the stored log's newest entry is already that way (the row
 * is written only when the way changes). An unreadable stored row starts a new log.
 */
export function priceHowStmt(prev: PriceHowLog | null, how: NamPriceHow | undefined, at: number): Stmt | null {
  if (!how) return null;
  const log = Array.isArray(prev?.log) ? prev!.log : [];
  const last = log[log.length - 1];
  if (last && sameWay(last, how)) return null;
  const next: PriceHowLog = { log: [...log, { ...how, since: at }].slice(-PRICE_HOW_KEEP) };
  return stmt.kvSet(PRICE_HOW_KEY, JSON.stringify(next), at);
}

/**
 * The way the price stored at `ts` was read: the newest entry from at or before `ts`. Null before the first entry
 * (the price list was then the only way) and with no log.
 */
export function priceHowAt(log: PriceHowLog | null | undefined, ts: number | null | undefined): PriceHowEntry | null {
  if (ts == null || !Array.isArray(log?.log)) return null;
  let found: PriceHowEntry | null = null;
  for (const e of log!.log) if (Number.isFinite(e?.since) && e.since <= ts && (!found || e.since >= found.since)) found = e;
  return found;
}

const usd = (v: number) => `$${v < 10 ? v.toFixed(2) : Math.round(v).toLocaleString('en-US')}`;
const utc = (t: number) => `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/**
 * The route price in plain words (no service or protocol acronyms: the site shows it under the price): why the price
 * list was not used, the size, each route's pools with their liquidity, and the thinnest pool's. `figuresAt`: for a
 * stored price, the time its entry's liquidity was read (the minute the way began); the sentence is then in the past.
 */
export function routeNote(how: Extract<NamPriceHow, { how: 'route' }>, figuresAt?: number): string {
  const past = figuresAt != null;
  // the first pool of a route is the one the NAM goes into; the service counts none of a pool's NAM in its liquidity
  const pool = (p: { id: string; liquidityUsd: number | null }, i: number) => `pool ${p.id}${p.liquidityUsd != null ? ` (${usd(p.liquidityUsd)}${i === 0 ? ' besides its NAM' : ''})` : ''}`;
  const routes = how.routes.filter((r) => r.length).map((r) => r.map(pool).join(', then '));
  const path = routes.length ? `: ${routes.join('; and ')}` : '';
  const asOf = past ? ` (liquidity as read at ${utc(figuresAt)})` : '';
  return past
    ? `The Osmosis quote service's price list gave NAM no price, so the price is the spot price of the pool it quoted for selling ${how.refNam.toLocaleString('en-US')} NAM${path}${asOf}. The service counts no NAM in a pool's liquidity, as it gives NAM no price.`
    : `The Osmosis quote service's price list gives NAM no price, so the price is the spot price of the pool it quotes for selling ${how.refNam.toLocaleString('en-US')} NAM${path}. The service counts no NAM in a pool's liquidity, as it gives NAM no price.`;
}

/** The health row of the NAM quote: ok when either way gave a price; the route says how, a failure why. */
export function priceHealth(p: Pick<NamPrice, 'usd' | 'at' | 'error' | 'how'>): SourceHealth {
  if (p.usd == null) return { name: PRICE_HEALTH_NAME, ok: false, at: p.at, note: p.error };
  return p.how?.how === 'route' ? { name: PRICE_HEALTH_NAME, ok: true, at: p.at, note: routeNote(p.how) } : { name: PRICE_HEALTH_NAME, ok: true, at: p.at };
}

/** The provenance of a price fetchNamPrice just read: the list's source name, or the route's with its note. */
export function livePriceProv(p: Pick<NamPrice, 'at' | 'how'>): Provenance {
  const prov: Provenance = { source: priceSourceName(p.how), at: p.at, status: 'live' };
  return p.how?.how === 'route' ? { ...prov, note: routeNote(p.how) } : prov;
}

/** The source name of a stored price read `how` (the entry priceHowAt gives; null: the price list). */
export const storedPriceSource = (how: NamPriceHow | null | undefined): string => `${priceSourceName(how)} (stored)`;

/** The route note of a stored price, with the time its liquidity was read; undefined for the price list. */
export const storedPriceNote = (how: PriceHowEntry | null | undefined): string | undefined =>
  how?.how === 'route' ? routeNote(how, how.since) : undefined;

// ---------------------------------------------------------------- the route's mark on a move's price

/** The cron's log of how the quote was read, as the live hub keeps it: read again at most this often. */
export const PRICE_HOW_READ_MS = 60_000;
let howCopy: { at: number; log: PriceHowLog | null } | null = null;

/**
 * The NAM size of the route whose spot the quote stored at `at` is (the cron read it so: price.how), null when it was
 * the price list's, undefined when the log cannot be read. The log is read again at most every PRICE_HOW_READ_MS.
 */
export async function priceRouteAt(db: D1Database, at: number, now = Date.now()): Promise<number | null | undefined> {
  if (!howCopy || now - howCopy.at >= PRICE_HOW_READ_MS) {
    try {
      const v = await db.prepare('SELECT value FROM kv WHERE key = ?').bind(PRICE_HOW_KEY).first<{ value: string }>();
      howCopy = { at: now, log: v ? (JSON.parse(v.value) as PriceHowLog) : null };
    } catch {
      return undefined;
    }
  }
  const e = priceHowAt(howCopy.log, at);
  return e?.how === 'route' ? e.refNam : null;
}

/** Forgets the live hub's copy of the log (tests). */
export const resetPriceRouteCopy = () => { howCopy = null; };

/**
 * Marks the moves priced at a quote that was a route's spot (meta.priceSource 'spot') with the route's NAM size
 * (meta.priceRoute), so the moves list and an alert name the route as the price's source ("Osmosis route quote,
 * 1,000 NAM"). `refNam` null or undefined: the quote was the price list's, or how it was read is not known; nothing
 * is marked.
 */
export function stampPriceRoute<F extends { meta?: Record<string, unknown> | null; priceUsd?: number | null }>(flows: F[], refNam: number | null | undefined): F[] {
  if (refNam == null || !(refNam > 0)) return flows;
  for (const f of flows) if (f.priceUsd != null && f.meta?.priceSource === 'spot') f.meta = { ...f.meta, priceRoute: refNam };
  return flows;
}
