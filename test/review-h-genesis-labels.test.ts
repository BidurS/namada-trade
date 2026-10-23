// Security review (2026-10-22), genesis labels: the genesis file is read from a branch that can move and its names
// come from comment text, so scripts/genesis-labels.ts takes it only when it answers 200 and parses to the reviewed
// copy, writes no label on a protocol account and replaces no label from another source, and the genesis cohorts
// leave protocol accounts out as the size cohorts do. No network: fetch is a stub and the file is a fixture.
import { describe, it, expect, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { testD1, insert, runStmts } from './d1-sqlite';
import { INTERNAL_LABELS, NAMADA } from '../worker/src/config';
import { stmt } from '../worker/src/db';
import { COHORT_LABELLED_SQL, HOLDER_COHORTS_NAMADA_SQL } from '../worker/src/series-sql';
import { noneCohort } from '../worker/src/series';
import {
  GENESIS_DIGEST, GENESIS_URL, checkGenesis, fetchGenesis, genesisDigest, genesisLabelStmts, parseGenesisToml,
} from '../scripts/genesis-labels';

const POS = NAMADA.internal.pos;
const BACKER = 'tnam1qtestbacker000000000000000000000000000000';
const OTHER = 'tnam1qtestother0000000000000000000000000000000';
const TOML = [
  '[token.NAM]',
  `${POS} = "1.0" # (name: Namada Foundation treasury)`,
  `${BACKER} = "5.0" # categories: ['af_backers']`,
  `${OTHER} = "2.0" # (name: Anoma Foundation)`,
  '[token.OTHER]',
  `${OTHER} = "9.0" # (name: not NAM)`,
].join('\n');
const CACHE = join(__dirname, '..', 'scripts', 'out', 'namada', 'genesis.json');

const answer = (body: string, status = 200) => vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch;
const labelOf = (d1: ReturnType<typeof testD1>, a: string) => {
  const r = d1.raw.prepare('SELECT label, category, source FROM labels WHERE address = ?').get(a);
  return r ? { ...r } : null;
};

describe('the genesis file is held to the reviewed copy', () => {
  const parsed = parseGenesisToml(TOML);

  it('parses only the [token.NAM] lines, with names and categories from the comments', () => {
    expect(parsed).toEqual({
      [POS]: { amount: 1, categories: [], name: 'Namada Foundation treasury' },
      [BACKER]: { amount: 5, categories: ['af_backers'], name: null },
      [OTHER]: { amount: 2, categories: [], name: 'Anoma Foundation' },
    });
  });

  it('refuses allocations that are not the pinned copy, and an empty parse', () => {
    expect(() => checkGenesis(parsed)).toThrow(/not the reviewed copy/);
    expect(() => checkGenesis({}, genesisDigest({}))).toThrow(/no NAM allocations/);
    expect(checkGenesis(parsed, genesisDigest(parsed))).toBe(parsed);
    // the digest does not depend on the order of the lines
    const reordered = parseGenesisToml(['[token.NAM]', ...TOML.split('\n').slice(1, 4).reverse()].join('\n'));
    expect(genesisDigest(reordered)).toBe(genesisDigest(parsed));
    // a changed name is a different copy
    expect(genesisDigest(parseGenesisToml(TOML.replace('Anoma Foundation', 'Anoma Foundation reserve')))).not.toBe(genesisDigest(parsed));
  });

  it('fetches the file once, refuses a non-200 answer and a moved branch, and takes the pinned copy', async () => {
    const ok = answer(TOML);
    await expect(fetchGenesis(ok)).rejects.toThrow(/not the reviewed copy/);
    expect((ok as any).mock.calls.map((c: unknown[]) => c[0])).toEqual([GENESIS_URL]);
    await expect(fetchGenesis(answer('404: Not Found', 404), genesisDigest(parsed))).rejects.toThrow(/answered 404/);
    await expect(fetchGenesis(answer('<html>not the file</html>'), genesisDigest(parsed))).rejects.toThrow(/no NAM allocations/);
    await expect(fetchGenesis(answer(TOML), genesisDigest(parsed))).resolves.toEqual(parsed);
  });

  it.skipIf(!existsSync(CACHE))('the pin is the reviewed cache, so sql from it still runs', () => {
    const cached = JSON.parse(readFileSync(CACHE, 'utf8'));
    expect(genesisDigest(cached)).toBe(GENESIS_DIGEST);
    expect(() => checkGenesis(cached)).not.toThrow();
  });
});

describe('genesis labels', () => {
  it('write no label on a protocol account and replace no label from another source', async () => {
    const d1 = testD1();
    // as the sql step writes them: the protocol labels first, then the genesis ones
    await runStmts(d1, Object.entries(INTERNAL_LABELS).map(([a, l]) => stmt.label(a, a.startsWith('osmo') ? 'osmosis' : 'namada', l.label, l.category, 'auto', null, 1)));
    insert(d1, 'labels', [{ address: OTHER, chain: 'namada', label: 'Validator X', category: 'validator', source: 'valopers', updated_at: 1 }]);
    const stmts = genesisLabelStmts(parseGenesisToml(TOML), 2);
    expect(stmts.map((s) => s.params[0])).toEqual([BACKER, OTHER]);
    await runStmts(d1, stmts);
    expect(labelOf(d1, POS)).toEqual({ label: INTERNAL_LABELS[POS].label, category: 'pos', source: 'auto' });
    expect(labelOf(d1, OTHER)).toEqual({ label: 'Validator X', category: 'validator', source: 'valopers' });
    expect(labelOf(d1, BACKER)).toEqual({ label: 'Genesis: af_backers', category: 'backer', source: 'genesis' });
    // a rerun of the genesis step refreshes its own label
    await runStmts(d1, [stmt.genesisLabel(BACKER, 'Genesis: af_backers, early_backer', 'backer', null, 3)]);
    expect(labelOf(d1, BACKER)).toMatchObject({ label: 'Genesis: af_backers, early_backer', source: 'genesis' });
  });

  it('never replace a wallet tag', async () => {
    const d1 = testD1();
    insert(d1, 'labels', [{ address: BACKER, chain: 'namada', label: 'my wallet', category: 'other', source: 'user', author: 'tnam1author', updated_at: 1 }]);
    await runStmts(d1, genesisLabelStmts(parseGenesisToml(TOML), 2));
    expect(labelOf(d1, BACKER)).toEqual({ label: 'my wallet', category: 'other', source: 'user' });
  });

  it('a genesis label already on a protocol account in a database copy moves nothing out of the none cohort', () => {
    const d1 = testD1();
    insert(d1, 'labels', [{ address: POS, chain: 'namada', label: 'Namada Foundation treasury', category: 'foundation', source: 'genesis', updated_at: 1 }]);
    insert(d1, 'holders', [{ chain: 'namada', address: POS, balance: '1000000000000', balance_num: 1_000_000, updated_at: 1 }]);
    const labelled = d1.raw.prepare(COHORT_LABELLED_SQL).all().map((r: any) => ({ ...r }));
    expect(labelled).toEqual([]);
    const cohorts = d1.raw.prepare(HOLDER_COHORTS_NAMADA_SQL).all().map((r: any) => ({ ...r }));
    expect(noneCohort(cohorts, labelled)).toMatchObject({ spendable: 0, staked: 0, addrs: 0 });
  });
});
