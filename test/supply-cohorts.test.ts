// The genesis cohorts on the Supply page (2026-11-07, migration 0023): the one sentence carries only the figures given
// (N2), the pure parts behind it give the reason instead of a stand-in when the answer cannot be said, the allocation
// table's stamp says what copy of the file it is, the new source words have plain names, and the screens pass the copy
// lint. The sentence is the one line a phone gains, in the since-genesis section, in place of the Ready-to-sell lead.
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { lintFile, numLintFile } from '../scripts/copy-lint';
import { COHORT_WORDS } from '../shared/copy';
import { ALLOC_CATEGORIES, ALLOC_PLAIN } from '../shared/genesis';
import { CHART_COHORTS, GENESIS_TABLE_SOURCE, chartKey, cohortLineParts, tableStamp } from '../web/src/screens/supply/cohorts';
import { plainSource } from '../web/src/lib/prov';
import { COHORT_SOURCE, GENESIS_TABLE_SOURCE as WORKER_TABLE_SOURCE } from '../worker/src/series-api';
import { BANNED } from './banned-words';
import type { GenesisCohortRow, GenesisCohortsResponse } from '../shared/types';

const ROOT = join(__dirname, '..');
const NOW = Date.UTC(2026, 10, 7, 12, 0);

const row = (cohort: string, held: number, alloc: number, out: number | null = 0): GenesisCohortRow =>
  ({ cohort, plain: ALLOC_PLAIN[cohort as never] ?? cohort, addrs: 1, addrsWithNam: 1, spendableNam: held, stakedNam: 0, heldNam: held, shieldedOutNam: out, allocNam: alloc, heldSharePct: alloc > 0 ? (held / alloc) * 100 : null });
const response = (over: Partial<GenesisCohortsResponse> = {}): GenesisCohortsResponse => ({
  asOf: NOW, day: '2026-11-03', listings: { at: NOW - 4 * 86_400_000, balanceHeight: 8_517_945, bondHeight: 8_517_754 },
  table: { loaded: true, digest: 'abc123def456789', reviewedOn: '2026-10-19', url: 'https://example.invalid/balances.toml', allocations: 70_830, loadedAt: NOW - 86_400_000, pinned: true },
  cohorts: [
    row('backer', 188_000_000, 325_490_371.809479), row('foundation', 183_000_000, 262_136_775.78539), row('team', 78_000_000, 178_752_263.619042),
    row('validators', 2_000_000, 5_029_861.350088), row('ecosystem', 9_000_000, 18_041_553.169177), row('public_completed', 98_000_000, 155_279_062.516841), row('public_future', 55_000_000, 55_270_111.75),
    row('all', 613_000_000, 1_000_000_000, 1_234_567.891),
  ],
  prov: { source: COHORT_SOURCE, at: NOW - 4 * 86_400_000, status: 'stale' },
  large: [], largeMinNam: 15_000_000,
  holdingsProv: { source: 'NamadaTrade holder index', at: null, status: 'missing' }, movesProv: { source: 'D1 flow index', at: null, status: 'missing' },
  ...over,
});

describe('the one sentence', () => {
  it('carries exactly the figures given and types none of its own (N2); every other sentence of the words has no digit and no banned word', () => {
    const t = COHORT_WORDS.line('61%', '58%', '70%', '44%', '63%', '1,234,568');
    expect(t).toBe('Genesis cohorts hold 61% of their allocations: backers 58%, foundation 70%, team 44%, public sale 63%; 1,234,568 NAM of theirs has moved into the shielded pool.');
    expect(t.replace(/61%|58%|70%|44%|63%|1,234,568/g, '')).not.toMatch(/\d/);
    const letters = [
      COHORT_WORDS.line('A', 'B', 'C', 'D', 'E', 'F'), COHORT_WORDS.heading, COHORT_WORDS.lead, COHORT_WORDS.notLoaded, COHORT_WORDS.noSnapshot,
      ...Object.values(COHORT_WORDS.columns), ...Object.values(COHORT_WORDS.chart), ...Object.values(COHORT_WORDS.scope),
      COHORT_WORDS.large.heading('N'), COHORT_WORDS.large.lead, COHORT_WORDS.large.holds, COHORT_WORDS.large.left, COHORT_WORDS.large.spendable, COHORT_WORDS.large.staked,
      COHORT_WORDS.large.atGenesis('N'), COHORT_WORDS.large.shielded('N', 'M'), COHORT_WORDS.large.sentTo, COHORT_WORDS.large.sentOn('N'), COHORT_WORDS.large.more('N', 'A'),
      COHORT_WORDS.large.none, COHORT_WORDS.large.cut('N'), COHORT_WORDS.large.rewound, COHORT_WORDS.large.notIndexed,
      ...Object.values(ALLOC_PLAIN),
    ];
    for (const s of letters) {
      expect(s, s).not.toMatch(/\d/);
      expect(s, s).not.toMatch(BANNED);
    }
    expect(COHORT_WORDS.large.shielded('16,666,667', '3 moves')).toBe('16,666,667 NAM moved into the shielded pool (3 moves)');
    expect(COHORT_WORDS.large.sentOn('12 addresses')).toBe('has since sent to 12 addresses');
    expect(COHORT_WORDS.large.more('400,000', '5 addresses')).toBe('and 400,000 NAM to 5 addresses more');
  });

  it('its parts come from the newest snapshot: the share held of all, of four cohorts, and the NAM moved into the pool', () => {
    const a = cohortLineParts(response());
    expect(a.why).toBeNull();
    const p = a.parts!;
    expect(p.allPct).toBeCloseTo(61.3, 9);
    expect(p.backersPct).toBeCloseTo((188_000_000 / 325_490_371.809479) * 100, 9);
    expect(p.foundationPct).toBeCloseTo((183_000_000 / 262_136_775.78539) * 100, 9);
    expect(p.teamPct).toBeCloseTo((78_000_000 / 178_752_263.619042) * 100, 9);
    expect(p.publicPct).toBeCloseTo((98_000_000 / 155_279_062.516841) * 100, 9);
    expect(p.shieldedNam).toBe(1_234_567.891);
    expect(p.day).toBe('2026-11-03');
  });

  it('gives the reason, never a stand-in, when the table is not loaded, no snapshot exists, a cohort is missing, or a share cannot be computed', () => {
    expect(cohortLineParts(null)).toEqual({ parts: null, why: 'The cohorts did not load.' });
    expect(cohortLineParts(response({ table: { ...response().table, loaded: false } })).why).toBe(COHORT_WORDS.notLoaded);
    expect(cohortLineParts(response({ day: null, cohorts: [] })).why).toBe(COHORT_WORDS.noSnapshot);
    expect(cohortLineParts(response({ cohorts: response().cohorts.filter((r) => r.cohort !== 'team') })).why).toBe('The snapshot has no row for early core contributors.');
    expect(cohortLineParts(response({ cohorts: response().cohorts.map((r) => (r.cohort === 'backer' ? row('backer', 1, 0) : r)) })).why).toMatch(/^Early backers: the share held cannot be computed/);
    expect(cohortLineParts(response({ cohorts: response().cohorts.map((r) => (r.cohort === 'all' ? row('all', 613_000_000, 1_000_000_000, null) : r)) })).why).toBe('The snapshot was written without the shielded moves.');
  });
});

describe('the stamps and the chart keys', () => {
  it('the allocation table\'s stamp names the copy of the file, is missing when not loaded and disagrees when it is not the pinned copy', () => {
    const t = response().table;
    expect(tableStamp(t)).toEqual({ source: GENESIS_TABLE_SOURCE, at: NOW - 86_400_000, status: 'live', note: '70,830 allocations from the file\'s copy reviewed 19 Oct 2026 (sha256 abc123def456…).' });
    expect(tableStamp({ ...t, loaded: false })).toMatchObject({ status: 'missing', at: null, note: COHORT_WORDS.notLoaded });
    expect(tableStamp({ ...t, pinned: false }).status).toBe('conflict');
    expect(tableStamp({ ...t, pinned: false }).note).toMatch(/this is not the copy the site was reviewed against\.$/);
    expect(tableStamp({ ...t, reviewedOn: null, digest: null, allocations: null }).note).toBe('The allocations from the file\'s copy review date not recorded (no digest recorded).');
  });

  it('the source words the Worker writes have plain names on the stamp', () => {
    expect(WORKER_TABLE_SOURCE).toBe(GENESIS_TABLE_SOURCE);
    expect(plainSource({ source: COHORT_SOURCE })).toBe('Genesis file, holder index and flow index');
    expect(plainSource({ source: GENESIS_TABLE_SOURCE })).toBe('Genesis file');
  });

  it('the chart draws the five briefed cohorts from the share-held series, one key per cohort', () => {
    expect(CHART_COHORTS).toEqual(['backer', 'foundation', 'team', 'public_completed', 'public_future']);
    expect(chartKey('backer')).toBe('cohort_daily.alloc.backer.held_share');
    for (const c of ALLOC_CATEGORIES) expect(chartKey(c)).toMatch(/^cohort_daily\.alloc\.[a-z_]+\.held_share$/);
  });

  it('the screens pass the copy lint and type no figure into JSX', () => {
    for (const f of ['web/src/screens/supply/GenesisCohorts.tsx', 'web/src/screens/supply/SinceGenesis.tsx', 'web/src/screens/supply/ReadyToSell.tsx', 'web/src/screens/supply/index.tsx']) {
      expect(numLintFile(join(ROOT, f)), f).toEqual([]);
      expect(lintFile(join(ROOT, f)), f).toEqual([]);
    }
  });
});
