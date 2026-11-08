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
import { GENESIS_DIGEST, GENESIS_URL, genesisDigestRows, parseGenesisToml, type GenesisAllocations } from '../shared/genesis';

// The file's address, the pinned digest and the parser live in shared/genesis.ts since the allocation table
// (scripts/genesis-alloc.ts, migration 0023) reads the same file under the same pin; re-exported so callers keep one import.
export { GENESIS_DIGEST, GENESIS_URL, parseGenesisToml, type GenesisAllocations };

/** sha256 over every allocation in address order: address, amount, categories and name. */
export function genesisDigest(gen: GenesisAllocations): string {
  return createHash('sha256').update(JSON.stringify(genesisDigestRows(gen))).digest('hex');
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
