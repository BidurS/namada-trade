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
import { QUOTE_MATCH_MS } from './analytics';

/** The hub asks the quote service at most this often (the cron reads it once a minute). */
export const QUOTE_ASK_EVERY_MS = 30_000;
/** While the service does not answer, the stored quote is read again at most this often (the cron stores one a minute). */
export const QUOTE_STORED_EVERY_MS = 20_000;

export interface HubQuoteNow {
  usd: number;
  /** when the quote was read: the hub's ask, or the cron's stored reading */
  at: number;
  source: 'live' | 'stored';
}

const ok = (x: number | null | undefined): x is number => x != null && Number.isFinite(x) && x > 0;

export class HubQuote {
  private cur: HubQuoteNow | null = null;
  private askedAt = -Infinity;
  private storedAt = -Infinity;

  /**
   * `ask`: the quote service's NAM price now (null when it does not answer). `stored(ts)`: the newest stored quote at
   * or before `ts` (null when none).
   */
  constructor(
    private readonly ask: () => Promise<number | null>,
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
      const usd = await this.ask().catch(() => null);
      if (ok(usd)) this.cur = { usd, at: now, source: 'live' };
      else unanswered = true;
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
    const c = this.current(now);
    if (c && now - ts <= QUOTE_ASK_EVERY_MS) return c.usd;
    const s = await this.stored(ts);
    return s && ok(s.usd) && s.at <= ts && ts - s.at <= QUOTE_MATCH_MS ? s.usd : null;
  }
}

/** The newest quote the cron stored (metrics price.usd) at or before `ts`: one key seek. */
export const storedQuoteReader = (db: D1Database) => async (ts: number): Promise<{ usd: number; at: number } | null> => {
  const r = await db.prepare(`SELECT ts, value FROM metrics WHERE key = 'price.usd' AND ts <= ? ORDER BY ts DESC LIMIT 1`).bind(ts).first<{ ts: number; value: number }>();
  return r ? { usd: Number(r.value), at: Number(r.ts) } : null;
};
