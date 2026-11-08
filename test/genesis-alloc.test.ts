// The genesis allocation table (migration 0023; scripts/genesis-alloc.ts; shared/genesis.ts): the script parses the
// public balances file as the label script does, refuses a copy that is not the pinned one, gives every allocation one
// cohort in the labels' order of precedence, and prints INSERT OR REPLACE statements the operator loads in batches with
// scripts/d1-apply.ts, plus the kv row the API serves as the table's provenance. The fixture is ten lines of the file
// as published (namada-net/namada-mainnet-genesis genesis/balances.toml, main, read 2026-11-07), one of each cohort and
// of each precedence rule, plus one made-up allocation of the file's shape (the parser does not checksum) that carries
// the made-up holdings of the schema test, so no figure is pinned to a real address. No network: the text is given to
// the parser.
import { describe, it, expect } from 'vitest';
import { testD1, insert } from './d1-sqlite';
import { ALLOC_CATEGORIES, ALLOC_PLAIN, GENESIS_ALLOC_KV, GENESIS_DIGEST, GENESIS_URL, allocCategory, allocCategoryOf, cohortKey, parseGenesisToml } from '../shared/genesis';
import { GENESIS_DIGEST as LABELS_DIGEST, GENESIS_URL as LABELS_URL, genesisDigest as labelsDigest, parseGenesisToml as labelsParse } from '../scripts/genesis-labels';
import { ROWS_PER_STMT, allocRows, allocSql, allocSummary, checkGenesis, genesisDigest } from '../scripts/genesis-alloc';
import { sqlStatements } from '../scripts/sql-statements';
import { ALLOC_COHORTS_SQL } from '../worker/src/series-sql';

/** A made-up address of the file's shape (as test/genesis-cohorts-api.test.ts builds them), never a real allocation's. */
const MADE_UP = `tnam1q${'21'.padStart(39, '0')}`;
const TOML = `[token.NAM]

${MADE_UP} = "12000000.000000" # (categories: ['af_backers'])
tnam1qrl2yv5v8hqe3sh5tmtt22l0gaz30eq6gcmzgpys = "20000000.000000" # (categories: ['af_backers'])
tnam1qzzvjjaullcn205wgppf67s2c77aw4ynmg2v4jra = "6142285.000000" # (categories: ['early_core_contributors'])
tnam1qrga82gr2u234hd6h7trn5dy8kfy7smnyvsex9qm = "1.000000" # (categories: ['pg_validators'])
tnam1qre8g4k8cknny5dgnalw9nuu9lfneerl6ykfswug = "5000000.000000" # (categories: ['r&d_ecosystem_dev']) (name: Knowable)
tnam1qz3nl7434q5cjdgequtl50frlpnwmepsmu5uchz2 = "4020000.000000" # (categories: ['public_allocations_completed'])
tnam1qr04nd9pc4yjw88ymdumka5mkvdw9fessvvzqcz9 = "8751025.957751" # (categories: ['af_backers', 'public_allocations_completed'])
tnam1q9gg5fpumzk9l764zex5es0cmvmkx2fghs58fhmk = "1666666.666667" # (categories: ['af_backers']) (name: Anoma Foundation)
tnam1qydnp0feth8jf9l0uhycd7l8nruhrwwtagl0r6js = "4577979.333334" # (categories: ['early_core_contributors']) (name: Anoma Foundation)
tnam1qr97z3c0f5x20hjwa60j207yf652vm75xsktkju3 = "270834.340000" # (categories: ['pg_validators', 'public_allocations_completed'])
tnam1qxpxtw4cu4ht96fu999ya7mzuhapaly7mywwchvr = "16666666.666675" # (categories: ['r&d_ecosystem_dev']) (name: Heliax)
tnam1qxdzup2hcvhswcgw5kerd5lfkf04t64y3scgqm5v = "55270111.750000" # (categories: ['public_allocations_future']) (name: Luminara)
`;
const NOW = Date.UTC(2026, 10, 7, 12, 0);

describe('one shared reading of the genesis file', () => {
  it('the label script and the allocation script read the same address under the same pin with the same parser', () => {
    expect(LABELS_URL).toBe(GENESIS_URL);
    expect(LABELS_DIGEST).toBe(GENESIS_DIGEST);
    expect(labelsParse).toBe(parseGenesisToml);
    const gen = parseGenesisToml(TOML);
    expect(labelsDigest(gen)).toBe(genesisDigest(gen));
    expect(Object.keys(gen)).toHaveLength(12);
    expect(gen['tnam1qr04nd9pc4yjw88ymdumka5mkvdw9fessvvzqcz9']).toEqual({ amount: 8751025.957751, categories: ['af_backers', 'public_allocations_completed'], name: null });
  });

  it('refuses a copy that is not the pinned one, and takes the fixture under its own digest', () => {
    const gen = parseGenesisToml(TOML);
    expect(() => checkGenesis(gen)).toThrow(/not the reviewed copy/);
    expect(() => checkGenesis({})).toThrow(/no NAM allocations/);
    expect(checkGenesis(gen, genesisDigest(gen))).toBe(gen);
  });
});

describe('each allocation falls in one cohort, in the labels\' order of precedence', () => {
  const gen = parseGenesisToml(TOML);
  const cat = (a: string) => allocCategory(gen[a]);

  it('backers first, then named foundation and company allocations, then the file\'s own categories', () => {
    expect(cat('tnam1qrl2yv5v8hqe3sh5tmtt22l0gaz30eq6gcmzgpys')).toBe('backer');
    expect(cat(MADE_UP)).toBe('backer');
    expect(cat('tnam1qr04nd9pc4yjw88ymdumka5mkvdw9fessvvzqcz9')).toBe('backer'); // backer and public sale: a backer
    expect(cat('tnam1q9gg5fpumzk9l764zex5es0cmvmkx2fghs58fhmk')).toBe('backer'); // a named foundation allocation in the backers' category: a backer, as its label is
    expect(cat('tnam1qydnp0feth8jf9l0uhycd7l8nruhrwwtagl0r6js')).toBe('foundation'); // a named foundation allocation among the contributors: foundation, as its label is
    expect(cat('tnam1qxpxtw4cu4ht96fu999ya7mzuhapaly7mywwchvr')).toBe('foundation');
    expect(cat('tnam1qzzvjjaullcn205wgppf67s2c77aw4ynmg2v4jra')).toBe('team');
    expect(cat('tnam1qrga82gr2u234hd6h7trn5dy8kfy7smnyvsex9qm')).toBe('validators');
    expect(cat('tnam1qr97z3c0f5x20hjwa60j207yf652vm75xsktkju3')).toBe('validators'); // a validator that also bought in the public sale
    expect(cat('tnam1qre8g4k8cknny5dgnalw9nuu9lfneerl6ykfswug')).toBe('ecosystem');
    expect(cat('tnam1qz3nl7434q5cjdgequtl50frlpnwmepsmu5uchz2')).toBe('public_completed');
    expect(cat('tnam1qxdzup2hcvhswcgw5kerd5lfkf04t64y3scgqm5v')).toBe('public_future');
    expect(allocCategory({ categories: ['something_else'], name: null })).toBeNull();
    expect(allocCategory({ categories: [], name: 'Someone' })).toBeNull();
  });

  it('every cohort has a plain name and a cohort_daily category that reads back', () => {
    for (const c of ALLOC_CATEGORIES) {
      expect(ALLOC_PLAIN[c]).toMatch(/^[A-Z]/);
      expect(cohortKey(c)).toBe(`alloc.${c}`);
      expect(allocCategoryOf(cohortKey(c))).toBe(c);
    }
    expect(allocCategoryOf('alloc.all')).toBe('all');
    expect(allocCategoryOf('backer')).toBeNull();
    expect(allocCategoryOf('alloc.other')).toBeNull();
  });

  it('allocRows gives one row per allocation in address order, and refuses an allocation no cohort rule names', () => {
    const rows = allocRows(gen);
    expect(rows).toHaveLength(12);
    expect(rows.map((r) => r.address)).toEqual(Object.keys(gen).sort());
    expect(rows.find((r) => r.address === 'tnam1qxdzup2hcvhswcgw5kerd5lfkf04t64y3scgqm5v')).toEqual({ address: 'tnam1qxdzup2hcvhswcgw5kerd5lfkf04t64y3scgqm5v', amount: 55270111.75, category: 'public_future' });
    expect(() => allocRows({ ...gen, tnam1qnocohort0000000000000000000000000000000000: { amount: 1, categories: ['x'], name: null } })).toThrow(/falls in no cohort/);
    expect(() => allocRows({ 'osmo1notnamada': { amount: 1, categories: ['af_backers'], name: null } })).toThrow(/not a Namada address/);
  });
});

describe('the SQL the operator loads', () => {
  const gen = parseGenesisToml(TOML);
  const rows = allocRows(gen);
  const summary = allocSummary(rows, genesisDigest(gen), NOW);
  const sql = allocSql(rows, summary);

  it('is INSERT OR REPLACE rows of the table, ROWS_PER_STMT a statement, then the kv summary; every statement reads back whole', () => {
    expect(ROWS_PER_STMT).toBe(200);
    expect(sql).toHaveLength(2); // 12 rows in one statement, then the kv row
    expect(sql[0]).toMatch(/^INSERT OR REPLACE INTO genesis_alloc \(address, amount_num, category\) VALUES\n\('tnam1q/);
    expect(sql[0].match(/\('tnam1/g)).toHaveLength(12);
    expect(sql[0]).toContain("('tnam1qxdzup2hcvhswcgw5kerd5lfkf04t64y3scgqm5v',55270111.75,'public_future')");
    expect(sql[0]).toContain("('tnam1qrga82gr2u234hd6h7trn5dy8kfy7smnyvsex9qm',1,'validators')");
    expect(sql[0]).not.toMatch(/e\+|e-/);
    expect(sql[1]).toMatch(new RegExp(`^INSERT OR REPLACE INTO kv \\(key, value, updated_at\\) VALUES \\('${GENESIS_ALLOC_KV}', '`));
    expect(sql[1]).toMatch(new RegExp(`, ${NOW}\\)$`));
    // as scripts/d1-apply.ts splits the file it writes: the same statements, nothing lost to a quote or a line break
    const text = sql.map((s) => `${s};`).join('\n') + '\n';
    expect(sqlStatements(`-- a comment line\n${text}`)).toEqual(sql);
    // many rows: a statement per ROWS_PER_STMT
    const many = Object.fromEntries(Array.from({ length: 450 }, (_, i) => [`tnam1q${String(i).padStart(39, '0')}`, { amount: i + 0.5, categories: ['public_allocations_completed'], name: null }]));
    const manySql = allocSql(allocRows(many), allocSummary(allocRows(many), 'd', NOW));
    expect(manySql).toHaveLength(4); // 200 + 200 + 50, then kv
    expect(manySql[2].match(/\('tnam1/g)).toHaveLength(50);
  });

  it('the summary counts and sums each cohort exactly (in millionths), with the file\'s address and the review date', () => {
    expect(summary).toMatchObject({ digest: genesisDigest(gen), url: GENESIS_URL, reviewedOn: '2026-10-19', writtenAt: NOW, n: 12 });
    expect(summary.sumNam).toBeCloseTo(12000000 + 20000000 + 6142285 + 1 + 5000000 + 4020000 + 8751025.957751 + 1666666.666667 + 4577979.333334 + 270834.34 + 16666666.666675 + 55270111.75, 6);
    expect(summary.byCategory.backer.n).toBe(4);
    expect(summary.byCategory.backer.nam).toBe(42417692.624418); // exact in millionths, not the float sum of the four amounts
    expect(summary.byCategory.foundation.n).toBe(2);
    expect(summary.byCategory.foundation.nam).toBeCloseTo(4577979.333334 + 16666666.666675, 6);
    expect(summary.byCategory.validators).toEqual({ n: 2, nam: 270835.34 });
    expect(summary.byCategory.public_future).toEqual({ n: 1, nam: 55270111.75 });
    expect(Object.keys(summary.byCategory).sort()).toEqual([...ALLOC_CATEGORIES].sort());
  });

  it('loads into the schema of migration 0023 and the daily cohort query groups it by cohort with what each address holds', async () => {
    const db = testD1();
    for (const s of sqlStatements(sql.map((x) => `${x};`).join('\n'))) db.raw.prepare(s).run();
    expect(db.raw.prepare('SELECT COUNT(*) n FROM genesis_alloc').get().n).toBe(12);
    const kv = JSON.parse(db.raw.prepare('SELECT value FROM kv WHERE key = ?').get(GENESIS_ALLOC_KV).value);
    expect(kv.n).toBe(12);
    // a rerun rewrites the same rows: still 12
    for (const s of sqlStatements(sql.map((x) => `${x};`).join('\n'))) db.raw.prepare(s).run();
    expect(db.raw.prepare('SELECT COUNT(*) n FROM genesis_alloc').get().n).toBe(12);
    // made-up holdings on the made-up backer allocation: 5,000,000 spendable and 1,000,000 staked (the real addresses of the
    // fixture carry no holdings here); the public-sale wallet holds nothing listed
    insert(db, 'holders', [{ chain: 'namada', address: MADE_UP, balance: '5000000000000', balance_num: 5_000_000, updated_at: NOW }]);
    insert(db, 'stakes', [{ address: MADE_UP, bonded_num: 1_000_000, delegations: '[]', updated_at: NOW }]);
    const cohorts = Object.fromEntries(db.raw.prepare(ALLOC_COHORTS_SQL).all().map((r: any) => [r.category, { ...r }]));
    expect(cohorts.backer).toMatchObject({ category: 'backer', addrs: 4, addrs_with_nam: 1, spendable: 5_000_000, staked: 1_000_000 });
    expect(cohorts.backer.alloc_nam).toBeCloseTo(42417692.624418, 6);
    expect(cohorts.public_completed).toEqual({ category: 'public_completed', addrs: 1, addrs_with_nam: 0, spendable: 0, staked: 0, alloc_nam: 4_020_000 });
    expect(Object.keys(cohorts).sort()).toEqual([...ALLOC_CATEGORIES].sort());
  });
});
