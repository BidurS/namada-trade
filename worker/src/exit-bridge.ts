// A bridge send that came straight out of the shielded pool (the alert rule 'exit_bridge', shared/alerts.ts). The
// seller traced on 2026-10-29 unshielded 1,601,005, 334,001 and 800,000 NAM to one transparent address (each the sum of
// that hour's unshields to it) and sent 1,500,000, 434,000 and 800,000 to Osmosis between 1.5 and 7.6 minutes later; the unshields were alerts of their own (the 'unshield' rule) but nothing said
// that the NAM was on its way to a market. The Namada scan stamps such a send when it stores it (live-hub.ts
// scanNamada), so every reader of the stored row (the live posts, the Alerts page, the last-alert search) sees the
// same fact without a second read.
import type { Flow } from '../../shared/types';
import { NAM, NAMADA } from './config';

/** How long before a send an unshield to its sender counts as where the send's NAM came from. */
export const EXIT_BRIDGE_WINDOW_MS = 60 * 60_000;
/**
 * The share of the send the unshields in the window must cover: half, so a send mostly from elsewhere does not read
 * as an exit. The seller's send of 434,000 NAM on 2026-10-25 at 16:43:27 UTC followed an unshield of 334,000 at
 * 16:41:58 (with 1 NAM at 16:18:31, 77% of the send), the rest left over from 21 October: 90% would have let it go.
 */
export const EXIT_BRIDGE_SHARE = 0.5;

/** What a send's meta says of its shielded source: the NAM unshielded to its sender in the window, when, and how many unshields; `direct` for a send the shielded pool made itself. */
export interface FromShielded { nam: number; firstAt: number; lastAt: number; unshields: number; direct?: true }

/** An unshield to `to` of `amount` NAM at `ts` (a stored row, or one of the block being written). */
export interface UnshieldRow { to: string; amount: number; ts: number }

/** A NAM unshield: a row in another coin (meta.tokenSymbol, its amount in that coin's units) is not NAM leaving the shielded set. */
const isNamUnshield = (f: Flow) => f.chain === 'namada' && f.kind === 'unshield' && !!f.to && f.amount > 0 && !(f.meta as Record<string, unknown> | null | undefined)?.tokenSymbol;

/** Namada sends to Osmosis (the NAM channel, meta.channel; a send whose packet was not bound has none and is left out) that the shielded pool may be behind. */
export const sendsToStamp = (flows: readonly Flow[]): Flow[] => flows.filter((f) => f.chain === 'namada' && f.kind === 'ibc_out' && !!f.from && f.amount > 0 && (f.meta as Record<string, unknown> | null | undefined)?.channel === NAM.namadaChannel && !(f.meta as Record<string, unknown> | null | undefined)?.tokenSymbol);

/**
 * Stamps each send (meta.fromShielded) whose sender received at least EXIT_BRIDGE_SHARE of it from the shielded pool in
 * the EXIT_BRIDGE_WINDOW_MS before it, from `prior` (the stored unshields of the blocks before this one,
 * priorUnshields) and the unshields of `flows` themselves (this block's). A send the shielded pool made itself (its
 * sender is the pool: a shielded IBC withdrawal) is stamped `direct`. A stamp already on a send is kept. A block read
 * again is parsed afresh and stamped again from the same rows, so it gets the same stamp; if the read of the stored
 * unshields fails that time, its rows are written again without one (the stamp feeds one alert rule, never a figure).
 */
export function stampShieldedExits(flows: Flow[], prior: readonly UnshieldRow[]): void {
  const own: UnshieldRow[] = flows.filter(isNamUnshield).map((f) => ({ to: f.to!, amount: f.amount, ts: f.ts }));
  const all = [...prior, ...own];
  for (const f of sendsToStamp(flows)) {
    if (f.meta && (f.meta as Record<string, unknown>).fromShielded) continue;
    if (f.from === NAMADA.internal.masp) { f.meta = { ...(f.meta ?? {}), fromShielded: { nam: f.amount, firstAt: f.ts, lastAt: f.ts, unshields: 0, direct: true } satisfies FromShielded }; continue; }
    const mine = all.filter((u) => u.to === f.from && u.ts <= f.ts && f.ts - u.ts <= EXIT_BRIDGE_WINDOW_MS);
    const nam = mine.reduce((s, u) => s + u.amount, 0);
    if (!mine.length || nam < f.amount * EXIT_BRIDGE_SHARE) continue;
    const at = mine.map((u) => u.ts);
    f.meta = { ...(f.meta ?? {}), fromShielded: { nam, firstAt: Math.min(...at), lastAt: Math.max(...at), unshields: mine.length } satisfies FromShielded };
  }
}

/**
 * The stored NAM unshields to the senders of `sends` in the window before them, from blocks below the sends' own (that
 * block's unshields are stampShieldedExits' `own`, so a block read again never counts them twice): one read, by the
 * receiver's index (flows_to). Rows in another coin (meta.tokenSymbol) are left out.
 */
export async function priorUnshields(db: D1Database, sends: readonly Flow[]): Promise<UnshieldRow[]> {
  const senders = [...new Set(sends.filter((f) => f.from !== NAMADA.internal.masp).map((f) => f.from!))];
  if (!senders.length) return [];
  const from = Math.min(...sends.map((f) => f.ts)) - EXIT_BRIDGE_WINDOW_MS, to = Math.max(...sends.map((f) => f.ts));
  const below = Math.min(...sends.map((f) => f.height));
  const rows = await db
    .prepare(`SELECT to_addr, amount_num, ts FROM flows INDEXED BY flows_to WHERE to_addr IN (${senders.map(() => '?').join(',')}) AND ts >= ? AND ts <= ? AND height < ? AND chain = 'namada' AND kind = 'unshield' AND (meta IS NULL OR meta NOT LIKE '%"tokenSymbol":%')`)
    .bind(...senders, from, to, below)
    .all<{ to_addr: string; amount_num: number; ts: number }>();
  return (rows.results ?? []).map((r) => ({ to: r.to_addr, amount: Number(r.amount_num), ts: Number(r.ts) }));
}
