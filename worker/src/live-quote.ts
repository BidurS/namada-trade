// The NAM quote the live hub prices new moves at (worker/src/live-hub.ts). The hub asked the Osmosis quote service on
// every alarm tick (6 s, up to three tries each). The service answers bursts from one address with 403 or 429
// (sources/sqs.ts), and from the hub it answered nothing for hours: on 2026-10-21 every trade not priced by its own
// USDC stored no price from 19:20 UTC on, while the cron's one read a minute went through. A quote that did come back
// was kept for good, so a move could also be priced at a quote hours old.
//
// Now the hub asks the service at most every QUOTE_ASK_EVERY_MS. When it does not answer, the hub reads the quote
// the cron stored for the minute (metrics price.usd, the same service's answer). A quote older than QUOTE_MATCH_MS
// prices nothing: a move gets its own minute's quote or none. A move found late (the catch-up search, a Namada scan
// that fell behind) gets the quote stored for its own minute, never the current one.
//
// The hub's ask is sources/sqs.ts fetchNamPrice, the cron's own read: when the price list gives NAM no price (from
// 16:36 UTC on 23 Oct 2026), the spot of the route the router quotes for 1,000 NAM, with the source name and note
// that say so (price-how.ts), which the hub sends with the price it streams.
import { QUOTE_MATCH_MS } from './analytics';
import { fetchNamPrice } from './sources/sqs';
import { livePriceProv } from './price-how';

/** The hub asks the quote service at most this often (the cron reads it once a minute). */
export const QUOTE_ASK_EVERY_MS = 30_000;
/** While the service does not answer, the stored quote is read again at most this often (the cron stores one a minute). */
export const QUOTE_STORED_EVERY_MS = 20_000;

export interface HubQuoteNow {
  usd: number;
  /** when the quote was read: the hub's ask, or the cron's stored reading */
  at: number;
  source: 'live' | 'stored';
  /** for the hub's own ask: the price's technical source name, and its note (the route's), as the ask gave them */
  priceSource?: string;
  priceNote?: string;
  /**
   * for the hub's own ask: the NAM size of the route whose spot the price is (the price list gave NAM none), or null
   * for the price list; absent for a stored quote, whose way the cron's price.how log says (price-how.ts priceRouteAt)
   */
  routeNam?: number | null;
}

/** What an ask answers: the price alone, or the price with the source name, note and route size of how it was read. */
export type HubAsk = number | { usd: number | null; priceSource?: string; priceNote?: string; routeNam?: number | null } | null;

const ok = (x: number | null | undefined): x is number => x != null && Number.isFinite(x) && x > 0;

export class HubQuote {
  private cur: HubQuoteNow | null = null;
  private askedAt = -Infinity;
  private storedAt = -Infinity;

  /**
   * `ask`: the quote service's NAM price now (null when it does not answer), alone or with how it was read.
   * `stored(ts)`: the newest stored quote at or before `ts` (null when none).
   */
  constructor(
    private readonly ask: () => Promise<HubAsk>,
    private readonly stored: (ts: number) => Promise<{ usd: number; at: number } | null>,
  ) {}

  /** The quote for a move happening at `now`: null when the newest one read is more than QUOTE_MATCH_MS old. */
  current(now: number): HubQuoteNow | null {
    return this.cur && now - this.cur.at <= QUOTE_MATCH_MS ? this.cur : null;
  }

  /**
   * One alarm tick: asks the service when an ask is due; when it did not answer, or the quote in hand is the stored
   * one or no longer the latest ask's, reads the stored quote when that read is due (a stored quote replaces the one
   * in hand only when it is newer). Returns current(now).
   */
  async refresh(now: number): Promise<HubQuoteNow | null> {
    let unanswered = false;
    if (now - this.askedAt >= QUOTE_ASK_EVERY_MS) {
      this.askedAt = now;
      const a = await this.ask().catch(() => null);
      const usd = a != null && typeof a === 'object' ? a.usd : a;
      if (ok(usd)) {
        this.cur = { usd, at: now, source: 'live' };
        if (a != null && typeof a === 'object' && a.priceSource) this.cur.priceSource = a.priceSource;
        if (a != null && typeof a === 'object' && a.priceNote) this.cur.priceNote = a.priceNote;
        if (a != null && typeof a === 'object' && a.routeNam !== undefined) this.cur.routeNam = a.routeNam;
      } else unanswered = true;
    }
    const stale = !this.cur || this.cur.source === 'stored' || now - this.cur.at > QUOTE_ASK_EVERY_MS;
    if ((unanswered || stale) && (unanswered || now - this.storedAt >= QUOTE_STORED_EVERY_MS)) {
      this.storedAt = now;
      const s = await this.stored(now).catch(() => null);
      if (s && ok(s.usd) && s.at <= now && now - s.at <= QUOTE_MATCH_MS && (!this.cur || s.at > this.cur.at)) this.cur = { usd: s.usd, at: s.at, source: 'stored' };
    }
    return this.current(now);
  }

  /**
   * The quote for a move at `ts` read at `now`: the current one when the move is at most QUOTE_ASK_EVERY_MS older than
   * now; else the stored quote at or before `ts`, at most QUOTE_MATCH_MS before it; null when there is none. Throws
   * when the stored quote cannot be read, so the caller holds the move for a retry rather than store it unpriced.
   */
  async at(ts: number, now: number): Promise<number | null> {
    return (await this.quoteFor(ts, now))?.usd ?? null;
  }

  /**
   * The quote `at` gives, with when it was read and how: the current one (the hub's own ask carries its route size;
   * a stored one does not) or the stored one of the move's minute (`stored`: its way is the cron's price.how log's).
   */
  async quoteFor(ts: number, now: number): Promise<{ usd: number; at: number; stored: boolean; routeNam?: number | null } | null> {
    const c = this.current(now);
    if (c && now - ts <= QUOTE_ASK_EVERY_MS) return { usd: c.usd, at: c.at, stored: c.source === 'stored', ...(c.routeNam !== undefined ? { routeNam: c.routeNam } : {}) };
    const s = await this.stored(ts);
    return s && ok(s.usd) && s.at <= ts && ts - s.at <= QUOTE_MATCH_MS ? { usd: s.usd, at: s.at, stored: true } : null;
  }
}

/**
 * The hub's ask: the cron's own read (sources/sqs.ts fetchNamPrice: the price list, else the route's spot), with the
 * source name and note that say which (price-how.ts livePriceProv); null when it gives no price.
 */
export async function askQuoteService(): Promise<HubAsk> {
  const p = await fetchNamPrice();
  if (p.usd == null) return null;
  const prov = livePriceProv(p);
  return { usd: p.usd, priceSource: prov.source, ...(prov.note ? { priceNote: prov.note } : {}), routeNam: p.how?.how === 'route' ? p.how.refNam : null };
}

/** The newest quote the cron stored (metrics price.usd) at or before `ts`: one key seek. */
export const storedQuoteReader = (db: D1Database) => async (ts: number): Promise<{ usd: number; at: number } | null> => {
  const r = await db.prepare(`SELECT ts, value FROM metrics WHERE key = 'price.usd' AND ts <= ? ORDER BY ts DESC LIMIT 1`).bind(ts).first<{ ts: number; value: number }>();
  return r ? { usd: Number(r.value), at: Number(r.ts) } : null;
};
