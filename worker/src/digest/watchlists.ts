// The per-user part of the digest (spec 5.11): the change of spendable NAM on each watched address over the window,
// read for every admitted wallet in one pass. The addresses of every admitted wallet are de-duplicated into a map
// address → wallets, split by chain and read in chunks of WATCH_CHUNK bound parameters (D1 refuses more than 100)
// from holders (the balance now) and balance_spans (the reading that contained the base instant: a span is a stretch
// of identical chain readings; a base in a gap is "not known", never 0). Bounded at DIGEST_WATCH_ADDRS_MAX addresses
// a run in the wallets' order: a wallet past the cap gets a NotRead that says so. No address is written anywhere:
// bound as parameters only, never in a statement's text, never printed.
import { BALANCE_LISTING_SRC, confirmedAt } from '../holders';
import { chainOf } from '../util';
import { SQL } from './sql';
import { DB_NOT_ANSWERED, digestWindow, notRead, type DigestKind, type NotRead } from './types';
import { Wave, type Prepared } from './waves';

/** The most watched addresses one digest run reads, over every wallet, first saved first. */
export const DIGEST_WATCH_ADDRS_MAX = 5_000;
/** Addresses per statement (D1 refuses more than 100 bound parameters; the chain is one more). */
export const WATCH_CHUNK = 90;
/** Statements per db.batch. */
export const WATCH_BATCH = 50;
/** The reason a wallet past the cap sees. */
export const WATCH_CAP_REASON = `not read this time — the digest's address cap (${DIGEST_WATCH_ADDRS_MAX.toLocaleString('en-US')}) was reached; see the Holders page`;

export interface WatchWallet { address: string; watchlist: string[] }

export interface WatchLine {
  address: string;
  chain: 'namada' | 'osmosis' | null;
  /** 'changed' / 'unchanged' with both readings; 'not-listed': no holders row (the chain lists no spendable NAM for it); 'base-unknown': no reading at the base instant */
  status: 'changed' | 'unchanged' | 'not-listed' | 'base-unknown';
  /** spendable NAM now */
  now: number | null;
  /** spendable NAM at the base instant, from the span that contained it */
  base: number | null;
  change: number | null;
  /** when the current reading was confirmed: the row's own read, or the last complete listing's time when the row is older (holders.ts confirmedAt) */
  asOf: number | null;
  /** the span that held the base: its first and last read */
  baseSpan: { fromTs: number; toTs: number } | null;
}

export interface WatchResult {
  /** per wallet address: its lines, or the NotRead its embed shows */
  lines: Map<string, WatchLine[] | NotRead>;
  wallets: number;
  admitted: number;
  /** wallets past the address cap */
  capped: number;
  /** distinct addresses read */
  addresses: number;
  statements: number;
  batches: number;
}

interface HolderRow { address: string; balance_num: number | null; verified_at: number | null; verified_src: string | null; updated_at: number | null }
interface SpanRow { address: string; balance_num: number; from_ts: number; to_ts: number }

const chunks = <T>(xs: T[], n: number): T[][] => { const out: T[][] = []; for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n)); return out; };

/** Which wallets are read this run: in order, while the distinct addresses stay within the cap. */
export function admitWallets(wallets: WatchWallet[]): { admitted: WatchWallet[]; capped: WatchWallet[]; addresses: Map<string, string[]> } {
  const addresses = new Map<string, string[]>();
  const admitted: WatchWallet[] = [], capped: WatchWallet[] = [];
  for (const w of wallets) {
    const list = [...new Set(w.watchlist)];
    const fresh = list.filter((a) => !addresses.has(a)).length;
    if (addresses.size + fresh > DIGEST_WATCH_ADDRS_MAX) { capped.push(w); continue; }
    admitted.push(w);
    for (const a of list) (addresses.get(a) ?? addresses.set(a, []).get(a)!).push(w.address);
  }
  return { admitted, capped, addresses };
}

/** The line of one address from its holders row, its base span and the listing stamps (pure). */
export function watchLine(address: string, holder: HolderRow | null, span: SpanRow | null, listingAt: number | null): WatchLine {
  const chain = chainOf(address);
  if (!holder || !chain) return { address, chain, status: 'not-listed', now: null, base: null, change: null, asOf: null, baseSpan: null };
  const now = holder.balance_num ?? null;
  // an Osmosis row's own read time stands (a row older than the pass's start is shown with its time); a Namada row the listing wrote is as fresh as the listing
  const asOf = chain === 'namada'
    ? confirmedAt(holder.verified_at ?? holder.updated_at, holder.verified_src, BALANCE_LISTING_SRC, listingAt)
    : holder.verified_at ?? holder.updated_at ?? null;
  if (!span) return { address, chain, status: 'base-unknown', now, base: null, change: null, asOf, baseSpan: null };
  const change = now == null ? null : now - span.balance_num;
  return { address, chain, status: change != null && Math.abs(change) >= 1e-6 ? 'changed' : 'unchanged', now, base: span.balance_num, change, asOf, baseSpan: { fromTs: span.from_ts, toTs: span.to_ts } };
}

/**
 * Reads the watchlists of `wallets` (first saved first) for the window ending at `now`. A failed batch makes every
 * admitted wallet's lines the NotRead; the digest itself is never lost to it.
 */
export async function readWatchlists(db: D1Database, wallets: WatchWallet[], now: number, kind: DigestKind = 'daily', log?: Prepared[]): Promise<WatchResult> {
  const win = digestWindow(now, kind);
  const { admitted, capped, addresses } = admitWallets(wallets);
  const lines = new Map<string, WatchLine[] | NotRead>();
  for (const w of capped) lines.set(w.address, notRead('watchlist', null, WATCH_CAP_REASON));
  const byChain: Record<'namada' | 'osmosis', string[]> = { namada: [], osmosis: [] };
  for (const a of addresses.keys()) { const c = chainOf(a); if (c) byChain[c].push(a); }

  // the statements: the listing stamps, then one holders and one spans read per chunk of each chain
  const stmts: { sql: string; params: unknown[]; kind: 'kv' | 'holders' | 'spans' }[] = [{ sql: SQL.watchKv, params: [], kind: 'kv' }];
  for (const chain of ['namada', 'osmosis'] as const) {
    for (const part of chunks(byChain[chain], WATCH_CHUNK)) {
      stmts.push({ sql: SQL.watchHolders(part.length), params: [chain, ...part], kind: 'holders' });
      stmts.push({ sql: SQL.watchSpans(part.length), params: [chain, ...part, win.baseAt, win.baseAt], kind: 'spans' });
    }
  }
  const holders = new Map<string, HolderRow>();
  const spans = new Map<string, SpanRow>();
  let listingAt: number | null = null;
  let failedRead = false, batches = 0;
  if (admitted.length) {
    for (const group of chunks(stmts, WATCH_BATCH)) {
      const w = new Wave(db, log);
      const handles = group.map((s) => ({ kind: s.kind, h: w.add<any>(s.sql, s.params) }));
      await w.run();
      batches++;
      for (const { kind: k, h } of handles) {
        if (!h.answer.ok) { failedRead = true; continue; }
        for (const row of h.answer.rows as any[]) {
          if (k === 'holders') holders.set(row.address, row as HolderRow);
          else if (k === 'spans') spans.set(row.address, row as SpanRow);
          else if (k === 'kv') {
            try {
              const v = JSON.parse(row.value);
              if (row.key === 'balance.listing' && Number.isFinite(v?.completeAt)) listingAt = Number(v.completeAt);
            } catch { /* an unreadable stamp is no stamp */ }
          }
        }
      }
    }
  }
  for (const w of admitted) {
    if (failedRead) { lines.set(w.address, notRead('watchlist', null, DB_NOT_ANSWERED)); continue; }
    const seen = new Set<string>();
    const out: WatchLine[] = [];
    for (const a of w.watchlist) {
      if (seen.has(a)) continue;
      seen.add(a);
      out.push(watchLine(a, holders.get(a) ?? null, spans.get(a) ?? null, listingAt));
    }
    lines.set(w.address, out);
  }
  return { lines, wallets: wallets.length, admitted: admitted.length, capped: capped.length, addresses: addresses.size, statements: admitted.length ? stmts.length : 0, batches };
}
