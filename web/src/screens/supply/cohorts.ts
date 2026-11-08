// The genesis cohorts (the Supply page): the parts of the one sentence from /api/series/cohorts, and the chart's series
// keys. Pure functions, no React: a figure the answer does not carry gives null with the reason, never a stand-in (N2).
import type { GenesisCohortRow, GenesisCohortsResponse } from '../../../../shared/types';
import { COHORT_WORDS } from '../../../../shared/copy';
import { ALLOC_PLAIN, cohortKey, type AllocCategory } from '../../../../shared/genesis';
import { fmtCount, fmtDayMonthYear } from '../../../../shared/format';
import type { Stamp } from '../../lib/prov';

/** The technical source word of the allocation table (worker/src/series-api.ts GENESIS_TABLE_SOURCE; plain words in lib/prov.ts). */
export const GENESIS_TABLE_SOURCE = 'Genesis allocations (namada-mainnet-genesis balances.toml)';

/** The allocation table's own stamp: the genesis file's reviewed copy, as loaded (kv genesis.alloc); 'conflict' when it is not the pinned copy. */
export function tableStamp(t: GenesisCohortsResponse['table']): Stamp {
  if (!t.loaded) return { source: GENESIS_TABLE_SOURCE, at: null, status: 'missing', note: COHORT_WORDS.notLoaded };
  const copy = t.reviewedOn ? `reviewed ${fmtDayMonthYear(Date.parse(`${t.reviewedOn}T00:00:00Z`))}` : 'review date not recorded';
  const digest = t.digest ? `sha256 ${t.digest.slice(0, 12)}…` : 'no digest recorded';
  return {
    source: GENESIS_TABLE_SOURCE, at: t.loadedAt, status: t.pinned ? 'live' : 'conflict',
    note: `${t.allocations != null ? `${fmtCount(t.allocations)} allocations` : 'The allocations'} from the file's copy ${copy} (${digest})${t.pinned ? '' : '; this is not the copy the site was reviewed against'}.`,
  };
}

export interface CohortLineParts {
  /** every allocation together: the share held, in percent */
  allPct: number;
  backersPct: number;
  foundationPct: number;
  teamPct: number;
  /** the public sale's completed allocations (the retail wallets) */
  publicPct: number;
  /** NAM every cohort's addresses have sent into the shielded pool since this site's record began */
  shieldedNam: number;
  day: string;
}

export type CohortLineAnswer = { parts: CohortLineParts; why: null } | { parts: null; why: string };

const rowOf = (res: GenesisCohortsResponse, c: AllocCategory | 'all'): GenesisCohortRow | null => res.cohorts.find((r) => r.cohort === c) ?? null;

/** The sentence's six figures, or why it cannot be said: no table, no snapshot, or a cohort whose share cannot be computed. */
export function cohortLineParts(res: GenesisCohortsResponse | null | undefined): CohortLineAnswer {
  if (!res) return { parts: null, why: 'The cohorts did not load.' };
  if (!res.table.loaded) return { parts: null, why: COHORT_WORDS.notLoaded };
  if (!res.day) return { parts: null, why: COHORT_WORDS.noSnapshot };
  const need: (AllocCategory | 'all')[] = ['all', 'backer', 'foundation', 'team', 'public_completed'];
  const pct: Partial<Record<AllocCategory | 'all', number>> = {};
  for (const c of need) {
    const r = rowOf(res, c);
    if (!r) return { parts: null, why: `The snapshot has no row for ${ALLOC_PLAIN[c].toLowerCase()}.` };
    if (r.heldSharePct == null || !Number.isFinite(r.heldSharePct)) return { parts: null, why: `${ALLOC_PLAIN[c]}: the share held cannot be computed (no NAM at genesis on the row).` };
    pct[c] = r.heldSharePct;
  }
  const all = rowOf(res, 'all')!;
  if (all.shieldedOutNam == null || !Number.isFinite(all.shieldedOutNam)) return { parts: null, why: 'The snapshot was written without the shielded moves.' };
  return {
    parts: { allPct: pct.all!, backersPct: pct.backer!, foundationPct: pct.foundation!, teamPct: pct.team!, publicPct: pct.public_completed!, shieldedNam: all.shieldedOutNam, day: res.day },
    why: null,
  };
}

/** The cohorts the chart draws, in legend order, each with its series key (the share held, once a day). */
export const CHART_COHORTS: AllocCategory[] = ['backer', 'foundation', 'team', 'public_completed', 'public_future'];
export const chartKey = (c: AllocCategory): string => `cohort_daily.${cohortKey(c)}.held_share`;
