/**
 * The genesis allocations behind the labels with source 'genesis', and the statements that write them.
 *
 * The file is read from the main branch of namada-net/namada-mainnet-genesis, which can move, and its names and
 * categories come from comment text, which is not consensus data. So the parsed allocations must match the reviewed
 * copy pinned below before they are cached or written as SQL: a branch that moved, a page that is not the file, or a
 * cache written by an older run is refused, and nothing is written. The labels never land on a protocol account and
 * never replace a label from another source (security review, 2026-10-22).
 */
import { createHash } from 'node:crypto';
import { INTERNAL_LABELS } from '../worker/src/config';
import { stmt, type Stmt } from '../worker/src/db';

export type GenesisAllocations = Record<string, { amount: number; categories: string[]; name: string | null }>;

export const GENESIS_URL = 'https://raw.githubusercontent.com/namada-net/namada-mainnet-genesis/main/genesis/balances.toml';

/**
 * sha256 of the reviewed allocations (genesisDigest): the parse cached in scripts/out/namada/genesis.json on
 * 2026-10-19, 70,830 NAM allocations that sum to the 1,000,000,000 NAM genesis supply. Its 269 backer, 21 foundation
 * and 64 named entries are the counts of the genesis labels on production (read 2026-10-23). To take a different
 * file, review what changed and pin its digest here in a commit.
 */
export const GENESIS_DIGEST = '449f6f2a66a09d13bf0083926de70b2d9d8782c5665dfbd2d2344bd871f683cb';

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

/** sha256 over every allocation in address order: address, amount, categories and name. */
export function genesisDigest(gen: GenesisAllocations): string {
  const rows = Object.keys(gen).sort().map((a) => [a, gen[a].amount, gen[a].categories, gen[a].name]);
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

/** The allocations when they are the reviewed copy; otherwise an error that names the digest found. */
export function checkGenesis(gen: GenesisAllocations, pinned: string = GENESIS_DIGEST): GenesisAllocations {
  const n = Object.keys(gen).length;
  if (!n) throw new Error('genesis: no NAM allocations were parsed; nothing written');
  const found = genesisDigest(gen);
  if (found !== pinned) {
    throw new Error(`genesis: the ${n} parsed allocations (sha256 ${found}) are not the reviewed copy (sha256 ${pinned}); nothing written`);
  }
  return gen;
}

/** Reads the file, refuses an answer that is not 200, and returns the allocations only when they are the reviewed copy. */
export async function fetchGenesis(fetchFn: typeof fetch = fetch, pinned: string = GENESIS_DIGEST): Promise<GenesisAllocations> {
  const res = await fetchFn(GENESIS_URL, { headers: { 'User-Agent': 'NamadaTrade/1.0' } });
  if (!res.ok) throw new Error(`genesis: ${GENESIS_URL} answered ${res.status}; nothing written`);
  return checkGenesis(parseGenesisToml(await res.text()), pinned);
}

/** One label per allocation, protocol accounts left out: they keep their own label and stay out of the cohorts. */
export function genesisLabelStmts(gen: GenesisAllocations, now: number): Stmt[] {
  const out: Stmt[] = [];
  for (const [addr, g] of Object.entries(gen)) {
    if (INTERNAL_LABELS[addr] || !/^tnam1[0-9a-z]+$/.test(addr)) continue;
    const cat = g.categories.some((c) => /backer/i.test(c)) ? 'backer'
      : g.name && /foundation|heliax|anoma/i.test(g.name) ? 'foundation'
      : 'genesis';
    const label = g.name ?? `Genesis: ${g.categories.join(', ') || 'allocation'}`;
    out.push(stmt.genesisLabel(addr, label, cat, `Genesis ${g.amount.toLocaleString()} NAM · ${g.categories.join(', ')}`, now));
  }
  return out;
}
