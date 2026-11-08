/**
 * The genesis allocation table (migration 0023 genesis_alloc) as SQL for the operator.
 *
 *   node --experimental-strip-types scripts/genesis-alloc.ts            # reads the public file, writes scripts/out/genesis_alloc.sql
 *   node --experimental-strip-types scripts/genesis-alloc.ts <file>     # the same from a local copy of balances.toml
 *   npm run db:apply -- scripts/out/genesis_alloc.sql                   # the operator loads it (batched; never run from here)
 *
 * The file is the one scripts/genesis-labels.ts reads, from the main branch of namada-net/namada-mainnet-genesis, held
 * to the same reviewed copy: the parsed allocations must hash to the digest pinned in shared/genesis.ts, or nothing is
 * written. Every one of the 70,830 allocations becomes a row with its cohort (shared/genesis.ts allocCategory), the
 * public-sale wallets included, so the cohorts' totals come from this table and no label is added for them (the labels
 * table is not touched). One more statement writes kv 'genesis.alloc': the digest, the count, the sum and each cohort's
 * count and NAM, which /api/series/cohorts serves as the table's provenance.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ALLOC_CATEGORIES, GENESIS_ALLOC_KV, GENESIS_DIGEST, GENESIS_REVIEWED_ON, GENESIS_URL, allocCategory, genesisDigestRows, parseGenesisToml,
  type AllocCategory, type GenesisAllocations,
} from '../shared/genesis.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** Rows per INSERT statement: about 22 KB each, four to a db:apply batch of 90 KB. */
export const ROWS_PER_STMT = 200;

export const genesisDigest = (gen: GenesisAllocations): string => createHash('sha256').update(JSON.stringify(genesisDigestRows(gen))).digest('hex');

/** The allocations when they are the reviewed copy; otherwise an error that names the digest found. */
export function checkGenesis(gen: GenesisAllocations, pinned: string = GENESIS_DIGEST): GenesisAllocations {
  const n = Object.keys(gen).length;
  if (!n) throw new Error('genesis: no NAM allocations were parsed; nothing written');
  const found = genesisDigest(gen);
  if (found !== pinned) throw new Error(`genesis: the ${n} parsed allocations (sha256 ${found}) are not the reviewed copy (sha256 ${pinned}); nothing written`);
  return gen;
}

export interface AllocRow { address: string; amount: number; category: AllocCategory }
export interface AllocSummary {
  digest: string; url: string; reviewedOn: string; writtenAt: number; n: number; sumNam: number;
  byCategory: Record<AllocCategory, { n: number; nam: number }>;
}

/** One row per allocation with its cohort, in address order. An allocation no cohort rule names is an error: every row has one. */
export function allocRows(gen: GenesisAllocations): AllocRow[] {
  const out: AllocRow[] = [];
  for (const address of Object.keys(gen).sort()) {
    if (!/^tnam1[0-9a-z]+$/.test(address)) throw new Error(`genesis: ${address} is not a Namada address; nothing written`);
    const g = gen[address];
    const category = allocCategory(g);
    if (!category) throw new Error(`genesis: ${address} (${g.amount} NAM, categories ${JSON.stringify(g.categories)}) falls in no cohort; nothing written`);
    if (!Number.isFinite(g.amount) || g.amount < 0) throw new Error(`genesis: ${address} has no amount; nothing written`);
    out.push({ address, amount: g.amount, category });
  }
  return out;
}

export function allocSummary(rows: AllocRow[], digest: string, writtenAt: number): AllocSummary {
  const byCategory = Object.fromEntries(ALLOC_CATEGORIES.map((c) => [c, { n: 0, nam: 0 }])) as AllocSummary['byCategory'];
  // summed in whole millionths of a NAM (the file's precision), so 70,830 reals add up exactly
  const micro = (n: number) => BigInt(Math.round(n * 1e6));
  const nam = (m: bigint) => Number(m) / 1e6;
  const sums = Object.fromEntries(ALLOC_CATEGORIES.map((c) => [c, 0n])) as Record<AllocCategory, bigint>;
  let sum = 0n;
  for (const r of rows) { byCategory[r.category].n++; sums[r.category] += micro(r.amount); sum += micro(r.amount); }
  for (const c of ALLOC_CATEGORIES) byCategory[c].nam = nam(sums[c]);
  return { digest, url: GENESIS_URL, reviewedOn: GENESIS_REVIEWED_ON, writtenAt, n: rows.length, sumNam: nam(sum), byCategory };
}

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
/** A NAM amount as the file gives it (six decimals at most), never in exponent form. */
const num = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(6).replace(/0+$/, '').replace(/\.$/, ''));

/**
 * The statements: INSERT OR REPLACE of ROWS_PER_STMT allocations each (an address loads once; a rerun rewrites the same
 * rows), then the kv summary row. Plain statements with inline values, so scripts/d1-apply.ts can send them in batches.
 */
export function allocSql(rows: AllocRow[], summary: AllocSummary): string[] {
  const out: string[] = [];
  for (let i = 0; i < rows.length; i += ROWS_PER_STMT) {
    const values = rows.slice(i, i + ROWS_PER_STMT).map((r) => `(${q(r.address)},${num(r.amount)},${q(r.category)})`);
    out.push(`INSERT OR REPLACE INTO genesis_alloc (address, amount_num, category) VALUES\n${values.join(',\n')}`);
  }
  out.push(`INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (${q(GENESIS_ALLOC_KV)}, ${q(JSON.stringify(summary))}, ${summary.writtenAt})`);
  return out;
}

/** The file's text: a local copy when a path is given, else the public file (refused unless it answers 200). */
export async function readGenesisText(file: string | undefined, fetchFn: typeof fetch = fetch): Promise<string> {
  if (file) return readFileSync(file, 'utf8');
  const res = await fetchFn(GENESIS_URL, { headers: { 'User-Agent': 'NamadaTrade/1.0' } });
  if (!res.ok) throw new Error(`genesis: ${GENESIS_URL} answered ${res.status}; nothing written`);
  return res.text();
}

export async function main(file: string | undefined, now = Date.now()): Promise<{ out: string; rows: number; statements: number; bytes: number; summary: AllocSummary }> {
  const gen = checkGenesis(parseGenesisToml(await readGenesisText(file)));
  const rows = allocRows(gen);
  const summary = allocSummary(rows, genesisDigest(gen), now);
  const sql = allocSql(rows, summary);
  const text = `-- genesis_alloc: ${rows.length} allocations of ${GENESIS_URL} (sha256 ${summary.digest}, reviewed ${GENESIS_REVIEWED_ON}),\n`
    + `-- written ${new Date(now).toISOString()} by scripts/genesis-alloc.ts. Load with: npm run db:apply -- scripts/out/genesis_alloc.sql\n`
    + sql.map((s) => `${s};`).join('\n') + '\n';
  const out = join(ROOT, 'scripts', 'out', 'genesis_alloc.sql');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);
  return { out, rows: rows.length, statements: sql.length, bytes: Buffer.byteLength(text), summary };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2]).then((r) => {
    console.log(`wrote ${r.out.slice(ROOT.length + 1)}: ${r.rows} allocations in ${r.statements} statements, ${(r.bytes / 1e6).toFixed(2)} MB, sum ${r.summary.sumNam.toFixed(6)} NAM`);
    for (const c of ALLOC_CATEGORIES) console.log(`  ${c}: ${r.summary.byCategory[c].n} allocations, ${r.summary.byCategory[c].nam.toFixed(6)} NAM`);
  }).catch((e) => { console.error(String(e instanceof Error ? e.message : e)); process.exit(1); });
}
