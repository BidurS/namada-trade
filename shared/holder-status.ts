// Holder row status (W2, owner decision 7), shared by the worker (which sends `status` and
// `statusNote` on every holder row) and the web app (which computes the same for a server that
// predates W2, web/src/lib/compat.ts), so there is one rule.
import type { SourceStatus } from './types';

const H = 3600000;

/** Owner decision 7: a spendable balance older than this is shown as old. */
export const LIQUID_STALE_MS = 6 * H;
/** Owner decision 7: without a chain read of the stake newer than this, estimate and last reading may conflict. */
export const BONDED_FRESH_MS = 24 * H;
/** Owner decision 7: estimate and last known stake must differ by more than this (NAM) to conflict. */
export const CONFLICT_NAM = 1;

const nf = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: Math.abs(n) < 10 ? 2 : 0 });

export interface HolderStatusInput {
  chain: string;
  /** unix ms of the last chain read of the spendable balance; null when never read */
  verifiedAt: number | null;
  /** whether a holders row exists at all (a staker without one has no spendable reading) */
  hasLiquidRow: boolean;
  /** last chain read of the stake (NAM), null if never read */
  bondedRead: number | null;
  bondedVerifiedAt: number | null;
  /** Σbond − Σunbond from the flow history */
  bondedEstimated: number | null;
}

/**
 * Owner decision 7. The chain read of the stake is authoritative when it exists.
 * - `conflict` only when there is no chain read of the stake newer than 24 h AND the estimate and the last
 *   known figure differ by more than 1 NAM;
 * - else `stale` when the spendable balance was last read from the chain more than 6 h ago (or never);
 * - else `live`.
 * A fresh chain read that differs from the estimate is not a row problem: it feeds the bonded-coverage check.
 */
export function holderStatus(r: HolderStatusInput, now: number): { status: SourceStatus; statusNote: string | null } {
  if (r.chain === 'namada' && r.bondedRead != null && r.bondedEstimated != null) {
    const fresh = r.bondedVerifiedAt != null && now - r.bondedVerifiedAt <= BONDED_FRESH_MS;
    const diff = Math.abs(r.bondedEstimated - r.bondedRead);
    if (!fresh && diff > CONFLICT_NAM) {
      return {
        status: 'conflict',
        statusNote: `Staked NAM: the last chain reading (${nf(r.bondedRead)} NAM) and the estimate from staking history (${nf(r.bondedEstimated)} NAM) differ by ${nf(diff)} NAM, and the stake has not been read from the chain in the last 24 hours.`,
      };
    }
  }
  const estimateOnly = r.chain === 'namada' && r.bondedRead == null && (r.bondedEstimated ?? 0) > 0
    ? ' Staked NAM is estimated from staking history; it has not been read from the chain yet.' : '';
  if (!r.hasLiquidRow) return { status: 'stale', statusNote: `The spendable balance has not been read from the chain yet.${estimateOnly}` };
  if (r.verifiedAt == null) return { status: 'stale', statusNote: `The spendable balance has not been checked on chain yet; it comes from the last transfer seen.${estimateOnly}` };
  if (now - r.verifiedAt > LIQUID_STALE_MS) return { status: 'stale', statusNote: `The spendable balance was last checked on chain more than 6 hours ago.${estimateOnly}` };
  return { status: 'live', statusNote: estimateOnly ? estimateOnly.trim() : null };
}
