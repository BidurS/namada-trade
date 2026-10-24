// The epoch clock (spec 5.3, settlement 8). The current epoch's start is anchored on its first `epoch` reading in
// the metrics table (exact to one reading gap, which the clock reports as its error); the epoch length comes from
// kv chain.params. E_end is the epoch running at T + horizon; the clock of an epoch e is started + (e − E_now) ×
// epochSec. Without an anchor the fallback is e24 = round(horizon / epochSec) epochs and the word "about", with no
// clock time; without the epoch length (chain.params missing or older than a day) there are epochs only.
import type { ChainParams } from '../../../shared/types';

export interface EpochClock {
  /** T, the digest's now */
  now: number;
  /** E_now, the epoch at T; null when the epoch reading is not live */
  eNow: number | null;
  /** the epoch reading's time */
  epochAt: number | null;
  /** the first reading of E_now (the epoch's start, exact to one reading gap); null when it could not be read */
  startedAt: number | null;
  /** the gap between the anchor and the reading before it: the clock's error */
  errorMs: number | null;
  /** the measured epoch length in ms (chain.params.epochSec), null when the parameters are missing or stale */
  epochMs: number | null;
  epochSecNote: string | null;
  paramsAt: number | null;
  /** true when the anchor could not be read: epochs ahead are "about" and no clock time is given */
  approx: boolean;
}

/**
 * `before` is the reading just before the anchor: the anchor is trusted only when that reading exists and is of an
 * earlier epoch (the first reading of E_now in the range is then the epoch's first reading, to one gap). No reading
 * before it (the series starts there) or one of the same epoch (the epoch began before the range) leaves no anchor.
 */
export function epochClock(now: number, eNow: number | null, epochAt: number | null, startedAt: number | null, before: { ts: number; value: number } | null, params: (ChainParams & { fetchedAt?: number }) | null, paramsLive: boolean): EpochClock {
  const epochMs = paramsLive && params?.epochSec && Number.isFinite(params.epochSec) && params.epochSec > 0 ? params.epochSec * 1000 : null;
  const anchored = eNow != null && startedAt != null && Number.isFinite(startedAt) && before != null && Number.isFinite(before.ts) && before.value !== eNow;
  return {
    now, eNow, epochAt,
    startedAt: anchored ? startedAt : null,
    errorMs: anchored ? startedAt! - before!.ts : null,
    epochMs,
    epochSecNote: paramsLive ? params?.epochSecNote ?? null : null,
    paramsAt: params?.fetchedAt ?? null,
    approx: !anchored,
  };
}

/** The epoch running at T + horizonMs; null when the epoch or the epoch length is not known. */
export function epochEnd(c: EpochClock, horizonMs: number): number | null {
  if (c.eNow == null || c.epochMs == null) return null;
  if (c.startedAt == null) return c.eNow + Math.round(horizonMs / c.epochMs);
  return c.eNow + Math.floor((c.now + horizonMs - c.startedAt) / c.epochMs);
}

/** When epoch e begins by the anchor; null without an anchor or an epoch length. */
export function epochClockAt(c: EpochClock, e: number): number | null {
  if (c.eNow == null || c.epochMs == null || c.startedAt == null) return null;
  return c.startedAt + (e - c.eNow) * c.epochMs;
}
