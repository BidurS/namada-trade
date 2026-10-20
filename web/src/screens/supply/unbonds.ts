// Supply (S3), decision D3: what became of each unstaking request in the "Unstaking and restaking" list.
//
// An unstaking request (unbond) becomes withdrawable at `liquidAt` (request time + the chain's unstaking
// wait). It is counted as withdrawn when a later withdrawal by the same address in the same list could have
// taken it: made no earlier than one epoch before `liquidAt` (the request can fall late in an epoch), and big
// enough to hold it (a withdrawal takes every matured request with one validator at once). Withdrawals are
// spent oldest request first. The list covers the large staking moves of the last 30 days (the server's
// window and minimum), so a request older than the window is not here, and neither is its NAM.
//
// The same rule gives the two Supply figures: NAM whose wait is over and that was not withdrawn (it can be
// withdrawn and moved at any time) and NAM still in its wait (spendable when the wait ends). Both cover only
// the requests in the list (Pressure.unlocksMinNam NAM or more), and the band says so; when the server also
// counts every request still in its wait, of any size (Pressure.unbondingAll), the second figure is that count
// made to agree with the list (waitingAll).
import type { Pressure, UnlockEntry } from '../../../../shared/types';

const DAY = 86_400_000;

export type UnbondState =
  /** still in its wait */
  | { kind: 'waiting'; liquidAt: number }
  /** wait over, no withdrawal in the list could have taken it */
  | { kind: 'ready'; liquidAt: number }
  /** wait over and withdrawn */
  | { kind: 'withdrawn'; liquidAt: number; withdrawnAt: number }
  /** the wait is not known (the chain parameters were not read) */
  | { kind: 'unknown' };

/**
 * One epoch, the slack for a request made late in its epoch: the measured epoch length when the server sends it
 * (ChainParams.epochSec), else the chain's minimum, else a day when the parameters were not read.
 */
export const epochMs = (p: Pick<Pressure, 'chainParams'>): number => {
  const c = p.chainParams as (Pressure['chainParams'] & { epochSec?: number }) | null | undefined;
  const sec = c?.epochSec ?? c?.minEpochSec;
  return sec && sec > 0 ? sec * 1000 : DAY;
};

/** The state of every unstaking request in the list, keyed by the entry itself. */
export function unbondStates(unlocks: UnlockEntry[], asOf: number, slackMs: number): Map<UnlockEntry, UnbondState> {
  const out = new Map<UnlockEntry, UnbondState>();
  const unbonds = unlocks.filter((u) => u.kind === 'unbond');
  const withdrawnAt = new Map<UnlockEntry, number>();
  const byAddr = new Map<string, UnlockEntry[]>();
  for (const u of unbonds) if (u.liquidAt != null) (byAddr.get(u.address) ?? byAddr.set(u.address, []).get(u.address)!).push(u);
  for (const [addr, list] of byAddr) {
    const open = [...list].sort((a, b) => (a.liquidAt as number) - (b.liquidAt as number));
    const ws = unlocks.filter((w) => w.kind === 'withdraw' && w.address === addr && w.ts <= asOf).sort((a, b) => a.ts - b.ts);
    for (const w of ws) {
      let budget = w.amountNam * 1.01 + 1; // a slashed request comes out a little smaller
      for (const u of open) {
        if (withdrawnAt.has(u)) continue;
        if (u.ts >= w.ts || (u.liquidAt as number) - slackMs > w.ts) continue;
        if (u.amountNam > budget) continue;
        withdrawnAt.set(u, w.ts);
        budget -= u.amountNam;
      }
    }
  }
  for (const u of unbonds) {
    if (u.liquidAt == null) out.set(u, { kind: 'unknown' });
    else if (withdrawnAt.has(u)) out.set(u, { kind: 'withdrawn', liquidAt: u.liquidAt, withdrawnAt: withdrawnAt.get(u)! });
    else if (u.liquidAt > asOf) out.set(u, { kind: 'waiting', liquidAt: u.liquidAt });
    else out.set(u, { kind: 'ready', liquidAt: u.liquidAt });
  }
  return out;
}

export interface UnbondSums {
  /** wait over, not withdrawn */
  ready: { nam: number; n: number };
  /** still in the wait */
  waiting: { nam: number; n: number; soonest: number | null };
  /** requests whose wait is not known */
  unknown: number;
}

export function unbondSums(states: Map<UnlockEntry, UnbondState>): UnbondSums {
  const s: UnbondSums = { ready: { nam: 0, n: 0 }, waiting: { nam: 0, n: 0, soonest: null }, unknown: 0 };
  for (const [u, st] of states) {
    if (st.kind === 'ready') {
      s.ready.nam += u.amountNam;
      s.ready.n += 1;
    } else if (st.kind === 'waiting') {
      s.waiting.nam += u.amountNam;
      s.waiting.n += 1;
      s.waiting.soonest = s.waiting.soonest == null ? st.liquidAt : Math.min(s.waiting.soonest, st.liquidAt);
    } else if (st.kind === 'unknown') s.unknown += 1;
  }
  return s;
}

/**
 * Every unstaking request still in its wait, of any size (Pressure.unbondingAll, sent by a server from 2026-10-18
 * on): the NAM and the number of the requests made from `from` (asOf − the unstaking wait) to asOf. The list
 * itself holds only the requests of at least Pressure.unlocksMinNam.
 */
export interface UnbondingAll {
  nam: number;
  n: number;
  from: number;
}

/** The server's count of every request still in its wait; null when it sent none (an older server, or no wait known). */
export const unbondingAllOf = (p: Pressure): UnbondingAll | null => {
  const a = (p as Pressure & { unbondingAll?: UnbondingAll | null }).unbondingAll;
  return a && Number.isFinite(a.nam) && Number.isFinite(a.n) && Number.isFinite(a.from) ? a : null;
};

/**
 * NAM still in its wait over every request size, made to agree with the list. The server counts the requests
 * made within the wait (request time + the wait, an estimate that can run up to one epoch long); a listed request
 * has its own end of wait (the indexer's withdraw time when it lists it). So a listed request inside that span
 * that the list shows as withdrawable or withdrawn is taken out, and one before it that the list shows as still
 * waiting is added: the two Supply figures never count the same NAM, and this one is never below the list's.
 */
export function waitingAll(all: UnbondingAll, states: Map<UnlockEntry, UnbondState>): { nam: number; n: number } {
  let nam = all.nam;
  let n = all.n;
  for (const [u, st] of states) {
    const inSpan = u.ts >= all.from;
    if (inSpan && (st.kind === 'ready' || st.kind === 'withdrawn')) {
      nam -= u.amountNam;
      n -= 1;
    } else if (!inSpan && st.kind === 'waiting') {
      nam += u.amountNam;
      n += 1;
    }
  }
  return { nam: Math.max(0, nam), n: Math.max(0, n) };
}

/**
 * The list order: unstaked NAM that can be withdrawn now (biggest first), then NAM still in its wait (soonest
 * first), then every other move, newest first as the server sent them.
 */
export function spendableFirst(list: UnlockEntry[], states: Map<UnlockEntry, UnbondState>): UnlockEntry[] {
  const rank = (u: UnlockEntry) => {
    const st = states.get(u);
    return st?.kind === 'ready' ? 0 : st?.kind === 'waiting' ? 1 : 2;
  };
  return list
    .map((u, i) => ({ u, i, r: rank(u) }))
    .sort((a, b) => {
      if (a.r !== b.r) return a.r - b.r;
      if (a.r === 0) return b.u.amountNam - a.u.amountNam;
      if (a.r === 1) return (a.u.liquidAt as number) - (b.u.liquidAt as number);
      return a.i - b.i;
    })
    .map((x) => x.u);
}
