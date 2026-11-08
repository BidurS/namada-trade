// The genesis allocations as this site reads them: the public balances file of namada-net/namada-mainnet-genesis, its
// reviewed copy's digest, and the cohort each allocation falls in. Shared by the label script (scripts/genesis-labels.ts),
// the allocation script (scripts/genesis-alloc.ts), the daily cohort writer (worker/src/series.ts) and the Supply page,
// so one file says what a "backer", the "team" or the "public sale" is. No dependency: the scripts run under Node and the
// Worker and the web app bundle this file.

export const GENESIS_URL = 'https://raw.githubusercontent.com/namada-net/namada-mainnet-genesis/main/genesis/balances.toml';

/**
 * sha256 of the reviewed allocations (scripts/genesis-labels.ts genesisDigest over genesisDigestRows): the parse cached
 * on 2026-10-19, 70,830 NAM allocations that sum to the 1,000,000,000 NAM genesis supply. To take a different file,
 * review what changed and pin its digest here in a commit.
 */
export const GENESIS_DIGEST = '449f6f2a66a09d13bf0083926de70b2d9d8782c5665dfbd2d2344bd871f683cb';
/** The day the pinned copy was reviewed (the date every figure from the file carries). */
export const GENESIS_REVIEWED_ON = '2026-10-19';
/** The kv row the allocation script writes with the table (digest, count, sum, the categories' sums), read by the API as the table's provenance. */
export const GENESIS_ALLOC_KV = 'genesis.alloc';

export type GenesisAllocations = Record<string, { amount: number; categories: string[]; name: string | null }>;

/** The [token.NAM] lines of balances.toml: amount per address, with the comment's categories and name. */
export function parseGenesisToml(txt: string): GenesisAllocations {
  const out: GenesisAllocations = {};
  let inNam = false;
  for (const line of txt.split('\n')) {
    const sec = line.match(/^\s*\[(.+)\]\s*$/);
    if (sec) { inNam = sec[1].trim() === 'token.NAM'; continue; }
    if (!inNam) continue;
    const m = line.match(/^\s*(tnam1[0-9a-z]+)\s*=\s*"([\d.]+)"\s*(#.*)?$/);
    if (!m) continue;
    const comment = m[3] ?? '';
    const cats = [...(comment.match(/categories:\s*\[([^\]]*)\]/)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1]);
    const name = comment.match(/\(name:\s*([^)]+)\)/)?.[1]?.trim() ?? null;
    const prev = out[m[1]];
    out[m[1]] = {
      amount: (prev?.amount ?? 0) + Number(m[2]),
      categories: [...new Set([...(prev?.categories ?? []), ...cats])],
      name: name ?? prev?.name ?? null,
    };
  }
  return out;
}

/** What the digest hashes (JSON of this, sha256): every allocation in address order, with amount, categories and name. */
export function genesisDigestRows(gen: GenesisAllocations): [string, number, string[], string | null][] {
  return Object.keys(gen).sort().map((a) => [a, gen[a].amount, gen[a].categories, gen[a].name]);
}

/**
 * The cohorts of the allocation table (genesis_alloc.category), in the order the page lists them. One per allocation,
 * decided in this order, the same order the genesis labels use for their categories: an allocation in the backers'
 * category is a backer whatever else it says; a named foundation or company allocation is 'foundation'; then the
 * file's own categories. 'team' is the file's early_core_contributors; 'validators' its pg_validators; 'ecosystem' its
 * r&d_ecosystem_dev; 'public_completed' and 'public_future' its public_allocations_completed / _future.
 */
export const ALLOC_CATEGORIES = ['backer', 'foundation', 'team', 'validators', 'ecosystem', 'public_completed', 'public_future'] as const;
export type AllocCategory = (typeof ALLOC_CATEGORIES)[number];

export function allocCategory(g: { categories: string[]; name: string | null }): AllocCategory | null {
  if (g.categories.some((c) => /backer/i.test(c))) return 'backer';
  if (g.name && /foundation|heliax|anoma/i.test(g.name)) return 'foundation';
  if (g.categories.includes('early_core_contributors')) return 'team';
  if (g.categories.includes('pg_validators')) return 'validators';
  if (g.categories.includes('r&d_ecosystem_dev')) return 'ecosystem';
  if (g.categories.includes('public_allocations_future')) return 'public_future';
  if (g.categories.includes('public_allocations_completed')) return 'public_completed';
  return null;
}

/** The cohort_daily category of an allocation cohort ('alloc.backer'); 'alloc.all' is every allocation together. */
export const cohortKey = (c: AllocCategory | 'all'): string => `alloc.${c}`;
export const ALLOC_ALL = cohortKey('all');
/** A cohort_daily category back to its allocation cohort, or null for a row this table did not write. */
export function allocCategoryOf(category: string): AllocCategory | 'all' | null {
  const c = category.startsWith('alloc.') ? category.slice('alloc.'.length) : null;
  return c === 'all' || (ALLOC_CATEGORIES as readonly string[]).includes(c ?? '') ? (c as AllocCategory | 'all') : null;
}

/** Plain names of the cohorts (owner decision 6 for the backers' and the public sale's words). */
export const ALLOC_PLAIN: Record<AllocCategory | 'all', string> = {
  all: 'Every genesis allocation',
  backer: 'Early backers',
  foundation: 'Foundation and company allocations',
  team: 'Early core contributors',
  validators: 'Validators at genesis',
  ecosystem: 'Ecosystem development grants',
  public_completed: 'Public sale allocation',
  public_future: 'Public sale, held for later allocation',
};
