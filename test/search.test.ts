// GET /api/search (docs/design/nav-search-plan.md 4.2): grouped results (addresses, records, names, pools, blocks),
// ranked exact → start → end → word start, at most `limit` a group with `more`, `asOf` on every answer; names on the
// label_tokens table (migration 0008) and, without it, by LIKE with the same results; every group one index read.
import { describe, it, expect } from 'vitest';
import { app } from '../worker/src/api';
import { labelWords, wordCond, wordKeys, labelMatches } from '../worker/src/holders';
import { HASH_COLUMNS } from '../worker/src/flows-query';
import { stmt } from '../worker/src/db';
import { NAMADA } from '../worker/src/config';
import { testD1, insert, runStmts, type TestD1 } from './d1-sqlite';
import type { FlowsResponse, SearchResponse } from '../shared/types';
import { explorerHashOf } from '../shared/flow-rules';

const B32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const tn = (n: number, end = 'qqqq') => `tnam1q${B32[n % 32]}${B32[Math.floor(n / 32) % 32]}${'q'.repeat(33)}${end}`;
const T = Date.UTC(2026, 9, 21, 9, 30);
const HASH = (n: number) => `${n.toString(16).toUpperCase().padStart(4, '0')}${'E'.repeat(60)}`;
const ZONDAX = tn(1, 'kj4m');
const VAL = tn(2, 'v4l1');
const POOL = `osmo1${'z'.repeat(38)}`;
const SAME_START = ['qq0q', 'qq2q', 'qq3q', 'qq4q', 'qq5q'].map((end) => tn(1, end));

async function seeded(): Promise<TestD1> {
  const db = testD1();
  await runStmts(db, [
    ...[1, 2, 3, 4, 5].map((i) => stmt.namadaBalance({ address: tn(i, i === 1 ? 'kj4m' : i === 2 ? 'v4l1' : `${B32[i]}kj4`), balance: String(i * 1_000_000_000), height: 10 } as any, T - 60_000)),
    // five more with the same start as Zondax's address, smaller
    ...SAME_START.map((a, i) => stmt.namadaBalance({ address: a, balance: String((i + 1) * 1_000_000), height: 10 } as any, T - 60_000)),
    stmt.label(ZONDAX, 'namada', 'Zondax', 'other', 'auto', null, T - 3600_000),
    stmt.label(tn(3, `${B32[3]}kj4`), 'namada', 'Genesis: af_backers', 'backer', 'genesis', null, T - 3600_000),
    stmt.label(POOL, 'osmosis', 'Osmosis Pool #3005 (NAM / USDC)', 'pool', 'auto', null, T - 3600_000),
    stmt.userTag(tn(4, `${B32[4]}kj4`), 'namada', 'Zonda fan club', 'watch', `tnam1q${'a'.repeat(39)}`, null, T - 3600_000),
  ]);
  insert(db, 'kv', [{ key: 'validators.names', value: JSON.stringify({ at: T - 3600_000, validators: [{ address: VAL, name: 'Zond Validators', commission: 0.05, state: 'consensus' }, { address: tn(9), name: 'Other', commission: 0.1, state: 'jailed' }] }), updated_at: T }]);
  insert(db, 'flows', [
    { id: `namada:${HASH(1)}:0`, chain: 'namada', height: 8_294_006, ts: T - 7200_000, tx_hash: HASH(1), kind: 'transfer', from_addr: ZONDAX, to_addr: tn(3), amount_num: 1234.5, meta: JSON.stringify({ wrapper: 'ABCD0000' + 'F'.repeat(56) }) },
    { id: `namada:${HASH(2)}:0`, chain: 'namada', height: 8_294_006, ts: T - 7200_000, tx_hash: HASH(2), kind: 'bond', from_addr: ZONDAX, to_addr: VAL, amount_num: 50, meta: JSON.stringify({ innerTxHash: 'DCBA0000' + 'F'.repeat(56), source: 'x' }) },
    { id: `osmosis:${HASH(3)}:0`, chain: 'osmosis', height: 99_000_001, ts: T - 3600_000, tx_hash: HASH(3), kind: 'sell', from_addr: POOL, to_addr: POOL, amount_num: 2_500_000, meta: null },
  ]);
  return db;
}
const search = async (db: TestD1, q: string, extra = '') => {
  const res = await app.request(`/api/search?q=${encodeURIComponent(q)}${extra}`, {}, { DB: db } as any);
  expect(res.status, q).toBe(200);
  return (await res.json()) as SearchResponse;
};
const group = (r: SearchResponse, g: string) => r.results.filter((x) => x.group === g);

describe('label words (label_tokens): the triggers keep them, and the SQL and the API read a word the same way', () => {
  it('a label written, renamed (only when the words change) and deleted', async () => {
    const db = testD1();
    const words = (a: string) => db.raw.prepare('SELECT token FROM label_tokens WHERE address = ? ORDER BY token').all(a).map((r: any) => r.token);
    await runStmts(db, [stmt.label('tnam1x', 'namada', 'Osmosis Pool #3405 (NAM / ibc/BC26A7…)', 'pool', 'auto', null, 1)]);
    expect(words('tnam1x')).toEqual(['3405', 'bc26a7', 'ibc', 'nam', 'osmosis', 'pool']);
    expect(words('tnam1x')).toEqual([...new Set(labelWords('Osmosis Pool #3405 (NAM / ibc/BC26A7…)'))].sort());
    await runStmts(db, [stmt.label('tnam1x', 'namada', 'Genesis: r&d_ecosystem_dev, af_backers', 'backer', 'genesis', null, 2)]);
    expect(words('tnam1x')).toEqual(['af', 'backers', 'd', 'dev', 'ecosystem', 'genesis', 'r']);
    const before = db.raw.prepare('SELECT total_changes() n').get().n;
    await runStmts(db, [stmt.label('tnam1x', 'namada', 'Genesis: r&d_ecosystem_dev, af_backers', 'backer', 'genesis', null, 3)]); // the 10-minute pool rewrite case
    expect(db.raw.prepare('SELECT total_changes() n').get().n - before).toBe(1); // the label row only
    db.raw.prepare('DELETE FROM labels WHERE address = ?').run('tnam1x');
    expect(words('tnam1x')).toEqual([]);
    // the view and the JS split agree on every label shape the site holds
    for (const label of ['Knowable', 'Anoma Foundation', 'Namada PoS account (staked + unstaking + unclaimed rewards)', 'Osmosis Pool #3263 (NAM / factory/osmo1twk0/alloyed/allZEC)', 'A "quoted" \\back\\ tag; x=y', 'tab\there']) {
      await runStmts(db, [stmt.label('tnam1y', 'namada', label, 'other', 'auto', null, 4)]);
      expect(words('tnam1y'), label).toEqual([...new Set(labelWords(label))].sort());
    }
  });

  it('a typed word reads one range of the primary key; a plain name finds its raw fragment ("early" finds af_backers)', () => {
    const db = testD1();
    const c = wordCond(wordKeys('early'), 'l.address');
    const plan = (db.raw.prepare(`EXPLAIN QUERY PLAN SELECT l.address FROM labels l WHERE ${c.sql}`).all(...c.params) as { detail: string }[]).map((r) => r.detail).join(' | ');
    expect(plan).toMatch(/SEARCH t USING PRIMARY KEY \(token>\? AND token<\?\)/);
    expect(plan).toMatch(/SEARCH t USING PRIMARY KEY \(token=\?\)/);
    expect(plan).not.toMatch(/SCAN|TEMP B-TREE/);
    expect(wordKeys('early').exact).toEqual(['backers']);
    expect(labelMatches('Genesis: af_backers', tn(1), 'genesis', [wordKeys('early')])).toBe(true); // "Early backers (genesis)"
    expect(labelMatches('Zondax', tn(1), 'auto', [wordKeys('zond')])).toBe(true);
    expect(labelMatches('Zondax', tn(1), 'auto', [wordKeys('ondax')])).toBe(false); // a word start, nothing looser
  });
});

describe('the words a name is searched by', () => {
  it('keep the order typed and the filter words, and leave out identifiers, sizes and dates', async () => {
    const db = await seeded();
    await runStmts(db, [stmt.label(tn(7), 'namada', 'Anoma Foundation', 'foundation', 'genesis', null, T)]);
    await runStmts(db, [stmt.namadaBalance({ address: tn(7), balance: '5000000', height: 11 } as any, T)]);
    expect(group(await search(db, 'Anoma Foundation'), 'names')).toMatchObject([{ title: 'Anoma Foundation', match: 'exact' }]);
    expect(group(await search(db, '"anoma foundation"'), 'names')).toMatchObject([{ title: 'Anoma Foundation', match: 'exact' }]);
    expect(group(await search(db, 'anoma >100k last 7 days'), 'names')).toMatchObject([{ title: 'Anoma Foundation', match: 'start' }]);
  });

  it('a name says what its address holds, never repeats the address (clients print it beside the name), and the larger holding comes first', async () => {
    const db = await seeded();
    await runStmts(db, [stmt.label(tn(7), 'namada', 'Anoma Foundation', 'foundation', 'genesis', null, T), stmt.label(tn(8), 'namada', 'Anoma Foundation', 'foundation', 'genesis', null, T)]);
    await runStmts(db, [stmt.namadaBalance({ address: tn(7), balance: '5000000', height: 11 } as any, T), stmt.namadaBalance({ address: tn(8), balance: '50000000000000', height: 11 } as any, T)]);
    const names = group(await search(db, 'anoma'), 'names');
    expect(names.map((n) => n.value)).toEqual([tn(8), tn(7)]);
    expect(names.map((n) => n.subtitle)).toEqual(['Foundation · Namada address · 50.0 million NAM', 'Foundation · Namada address · 5 NAM']);
    for (const n of names) expect(n.subtitle).not.toContain(n.value.slice(0, 10));
  });
});

describe('GET /api/search', () => {
  it('every answer is grouped, in order, with asOf; an empty text is an empty answer', async () => {
    const db = await seeded();
    const r = await search(db, 'zond');
    expect(r.asOf).toBeGreaterThan(0);
    expect(r.groups!.map((g) => g.group)).toEqual(['addresses', 'records', 'names', 'pools', 'blocks']);
    for (const x of r.results) expect(x.group && x.kind && x.match && x.href).toBeTruthy();
    const empty = await search(db, '   ');
    expect(empty).toMatchObject({ results: [], groups: [] });
    expect(empty.asOf).toBeGreaterThan(0);
  });

  it('names: word starts across labels, tags, validators and protocol accounts, the whole name first', async () => {
    const db = await seeded();
    const r = await search(db, 'zond');
    const names = group(r, 'names');
    expect(names.map((n) => n.title)).toEqual(['Zondax', 'Zond Validators', 'Zonda fan club']);
    expect(names.map((n) => n.match)).toEqual(['start', 'start', 'start']);
    expect(names[1]).toMatchObject({ type: 'validator', kind: 'validator', value: VAL, category_plain: 'Validator' });
    expect(names[1].stamp).toMatchObject({ source: 'Namada indexer validator list', at: T - 3600_000 });
    expect(names[2].category_plain).toMatch(/^Tag by tnam1q/);
    expect(group(await search(db, 'zondax'), 'names')[0]).toMatchObject({ title: 'Zondax', match: 'exact', href: `/holders?addr=${ZONDAX}` });
    expect(group(await search(db, 'early'), 'names').map((n) => n.title)).toEqual(['Early backers (genesis)']);
    expect(group(await search(db, 'shielded pool'), 'names').map((n) => n.value)).toEqual([NAMADA.internal.masp]);
    expect(group(await search(db, 'ondax'), 'names')).toEqual([]);
  });

  it('pools by their number or a word of their pair; blocks by their height', async () => {
    const db = await seeded();
    expect(group(await search(db, '3005'), 'pools')).toMatchObject([{ type: 'pool', value: '3005', title: 'Osmosis pool 3005 (NAM / USDC)', match: 'exact', href: '/trade' }]);
    expect(group(await search(db, 'usdc'), 'pools').map((p) => p.value)).toEqual(['3005']);
    expect(group(await search(db, 'usdc'), 'names')).toEqual([]);
    const blocks = group(await search(db, '8294006'), 'blocks');
    expect(blocks).toMatchObject([{ type: 'block', value: '8294006', title: 'Block 8,294,006 on Namada', match: 'exact' }]);
    expect(blocks[0].subtitle).toMatch(/^2 moves recorded/);
    expect(group(await search(db, '8294007'), 'blocks')).toEqual([]);
  });

  it('addresses: a whole one (always, even unknown), a start (the biggest holders first), an end, the short form', async () => {
    const db = await seeded();
    const whole = group(await search(db, ZONDAX), 'addresses');
    expect(whole).toMatchObject([{ type: 'address', value: ZONDAX, match: 'exact', title: `Zondax (${ZONDAX.slice(0, 10)}…${ZONDAX.slice(-5)})` }]);
    expect(whole[0].subtitle).toBe('Namada address · Other · 1,000 NAM');
    expect(whole[0].stamp).toMatchObject({ source: 'NamadaTrade holder index', at: T - 60_000 });
    const unknown = tn(300, 'zzzz');
    expect(group(await search(db, unknown), 'addresses')).toMatchObject([{ value: unknown, match: 'exact', subtitle: 'Namada address', stamp: null }]);
    const start = group(await search(db, ZONDAX.slice(0, 8)), 'addresses');
    expect(start.length).toBe(6);
    expect(start[0]).toMatchObject({ value: ZONDAX, match: 'start' });
    expect(start.slice(1).map((s) => s.value)).toEqual([...SAME_START].reverse());
    expect(group(await search(db, ZONDAX.slice(0, 8), '&limit=2'), 'addresses')).toHaveLength(2);
    expect((await search(db, ZONDAX.slice(0, 8), '&limit=2')).groups!.find((g) => g.group === 'addresses')).toEqual({ group: 'addresses', n: 2, more: true });
    const end = group(await search(db, '…kj4m'), 'addresses');
    expect(end.map((e) => [e.value, e.match])).toEqual([[ZONDAX, 'end']]);
    expect(group(await search(db, 'kj4'), 'addresses')).toEqual([]); // under 4 characters is not an address end
    expect(group(await search(db, `${ZONDAX.slice(0, 9)}…kj4m`), 'addresses').map((e) => e.value)).toEqual([ZONDAX]);
  });

  it('records: by the start of the stored hash, the explorer (wrapper) hash or the inner hash; a whole one matches exactly', async () => {
    const db = await seeded();
    const byStart = group(await search(db, HASH(1).slice(0, 8)), 'records');
    expect(byStart).toMatchObject([{ type: 'tx', kind: 'record', match: 'start', chain: 'namada', title: 'Sent 1,235 NAM' }]);
    // the explorer files indexer rows under the wrapper hash: the result is that hash
    expect(byStart[0].value).toBe('ABCD0000' + 'F'.repeat(56));
    expect(byStart[0].external).toBe(`https://namada.valopers.com/transactions/ABCD0000${'F'.repeat(56)}`);
    expect(group(await search(db, 'abcd0000'), 'records').map((x) => x.match)).toEqual(['start']);
    expect(group(await search(db, 'DCBA0000'), 'records').map((x) => x.title)).toEqual(['Staked 50 NAM']);
    expect(group(await search(db, HASH(3)), 'records')).toMatchObject([{ match: 'exact', chain: 'osmosis', title: 'Sold 2.5 million NAM', external: `https://www.mintscan.io/osmosis/tx/${HASH(3)}` }]);
    for (const col of HASH_COLUMNS) {
      const plan = (db.raw.prepare(`EXPLAIN QUERY PLAN SELECT f.id FROM flows f WHERE ${col} >= ? AND ${col} < ? LIMIT 7`).all('A', 'B') as { detail: string }[]).map((r) => r.detail).join(' | ');
      expect(plan).toMatch(/^SEARCH f USING INDEX flows_hash/);
    }
  });

  it('records: one imported from the Namada indexer, which keeps its explorer hash in lower case, is found by that hash, and its link lands on it', async () => {
    const db = await seeded();
    // production keeps every indexer row's meta.wrapper in lower case (44,770 of 51,477 Namada rows, 2026-10-20)
    const INNER = '73B3B328' + '0D'.repeat(28);
    const WRAP = '6fd79a0a' + 'c3'.repeat(28);
    insert(db, 'flows', [{ id: `namada:${INNER}:0`, chain: 'namada', height: 8_300_000, ts: Date.now() - 600_000, tx_hash: INNER, kind: 'transfer', from_addr: ZONDAX, to_addr: tn(3), amount_num: 10, meta: JSON.stringify({ wrapper: WRAP, source: 'namada-indexer' }) }]);
    const shown = explorerHashOf({ txHash: INNER, meta: { wrapper: WRAP } });
    expect(shown).toBe(WRAP.toUpperCase());
    const byInner = group(await search(db, INNER.slice(0, 12)), 'records');
    expect(byInner.map((x) => [x.value, x.href])).toEqual([[shown, `/activity?q=${shown}`]]);
    // the hash the site shows, its start, and the start as the explorer prints it (lower case)
    for (const q of [shown, shown.slice(0, 12), WRAP.slice(0, 12)]) expect(group(await search(db, q), 'records').map((x) => x.value), q).toEqual([shown]);
    expect(group(await search(db, shown), 'records')[0].match).toBe('exact');
    // the Records result's own link: /activity?q=<shown> reads ?hash=<shown>, which finds the record
    const res = await app.request(`/api/flows?hash=${shown}`, {}, { DB: db } as any);
    const flows = (await res.json()) as FlowsResponse;
    expect(flows.flows.map((f) => f.id)).toEqual([`namada:${INNER}:0`]);
    expect(flows.total).toBe(1);
  });

  it('names: a word thousands of labels share lists the biggest holders among them first, within a bounded read', async () => {
    const db = testD1();
    // 400 genesis allocations, holdings rising with the address (the label read in key order would show the smallest first)
    const addrs = Array.from({ length: 400 }, (_, i) => tn(i, `${B32[i % 32]}${B32[Math.floor(i / 32) % 32]}aa`));
    await runStmts(db, [
      ...addrs.map((a, i) => stmt.namadaBalance({ address: a, balance: String((1000 + i) * 1_000_000), height: 10 } as any, T - 60_000)),
      ...addrs.map((a) => stmt.label(a, 'namada', 'Genesis: public_allocations_completed', 'genesis', 'genesis', null, T - 3600_000)),
    ]);
    const names = group(await search(db, 'genesis'), 'names');
    const biggest = [...addrs].reverse().slice(0, 6);
    expect(names.map((n) => n.value)).toEqual(biggest);
    expect((await search(db, 'genesis')).groups!.find((g) => g.group === 'names')).toMatchObject({ n: 6, more: true });
  });

  it('addresses: every address of a start is ranked by what it holds (a bucket of hundreds, not the first 50 in key order)', async () => {
    const db = testD1();
    // 300 addresses under one 8-character start, holdings rising with the key
    const addrs = Array.from({ length: 300 }, (_, i) => `tnam1qqx${B32[i % 32]}${B32[Math.floor(i / 32) % 32]}${'q'.repeat(30)}${B32[i % 7]}aaa`);
    await runStmts(db, addrs.map((a, i) => stmt.namadaBalance({ address: a, balance: String((1 + i) * 1_000_000), height: 10 } as any, T - 60_000)));
    const start = group(await search(db, 'tnam1qqx'), 'addresses');
    const want = addrs.map((a, i) => [a, i] as const).sort((x, y) => y[1] - x[1]).slice(0, 6).map(([a]) => a);
    expect(start.map((s) => s.value)).toEqual(want);
  });

  it('a long pasted text answers (never a 500 for too many bound parameters), and every typed word still has to match', async () => {
    const db = await seeded();
    const binds: number[] = [];
    const prep = db.prepare.bind(db);
    (db as any).prepare = (sql: string) => {
      const st: any = prep(sql);
      const wrap = (x: any): any => ({ ...x, bind: (...p: unknown[]) => { binds.push(p.length); return wrap(x.bind(...p)); }, first: x.first.bind(x), all: x.all.bind(x), run: x.run.bind(x), raw: x.raw?.bind(x) });
      return wrap(st);
    };
    const words = Array.from({ length: 150 }, (_, i) => `${'abcdefghijklmnopqrstuvwxyz'[i % 26]}`).join(' ');
    expect(words.length).toBeLessThanOrEqual(300);
    await search(db, words);
    const sixty = Array.from({ length: 60 }, (_, i) => `${'abcdefghijklmnopqrstuvwxyz'[i % 26]}${'abcdefghijklmnopqrstuvwxyz'[(i * 7) % 26]}`).join(' ');
    await search(db, sixty);
    for (const q of [words, sixty]) {
      const r = await app.request(`/api/holders?chain=namada&search=${encodeURIComponent(q)}`, {}, { DB: db } as any);
      expect(r.status, q.slice(0, 20)).not.toBe(500);
    }
    expect(Math.max(...binds)).toBeLessThanOrEqual(100);
    // the ninth word (left out of the statement) still excludes a label: "zond" finds Zondax, "zond zz" does not
    expect(group(await search(db, 'zond a b c d e f g zzzzz'), 'names')).toEqual([]);
    expect(group(await search(db, 'zondax'), 'names').map((n) => n.title)).toEqual(['Zondax']);
  });

  it('the Holders search reads "anywhere in an address" only for text that could be in one: never for a name', async () => {
    const db = await seeded();
    const likes: string[] = [];
    const prep = db.prepare.bind(db);
    (db as any).prepare = (sql: string) => { if (/\bLIKE\b/.test(sql) && /h\.address LIKE/.test(sql)) likes.push(sql); return prep(sql); };
    const holders = async (q: string) => {
      const r = await app.request(`/api/holders?chain=namada&search=${encodeURIComponent(q)}`, {}, { DB: db } as any);
      expect(r.status, q).toBe(200);
      return (await r.json()) as { holders: { address: string }[] };
    };
    // names of 8 letters or more: b, i, o and 1 are not address characters, and a name has no digit (a pass over every holder for nothing)
    for (const q of ['knowable', 'luminara', 'everstake']) {
      await holders(q);
      expect(likes, q).toEqual([]);
    }
    // nine or more address characters with a digit, from inside an address (eight would read as an address end): found anywhere in it
    const mid = ZONDAX.slice(-10, -1);
    const r = await holders(mid);
    expect(likes.length).toBe(1);
    expect(r.holders.map((h) => h.address)).toContain(ZONDAX);
  });

  it('the limit is 1 to 10 a group (6 by default), and the first build\'s fields stay', async () => {
    const db = await seeded();
    const r = await search(db, ZONDAX.slice(0, 8), '&limit=50');
    expect(group(r, 'addresses').length).toBe(6); // 6 rows exist
    for (const x of r.results) expect(typeof x.value === 'string' && typeof x.title === 'string' && typeof x.subtitle === 'string').toBe(true);
    expect(group(await search(db, ZONDAX.slice(0, 8), '&limit=0'), 'addresses')).toHaveLength(6);
  });

  // last in the file: the route notes once per isolate that the table is missing
  it('without label_tokens (migration 0008 not applied yet) the names are the same, read by LIKE', async () => {
    const db = await seeded();
    const withTokens = (await search(db, 'zond')).results.map((x) => x.value);
    const early = (await search(db, 'early')).results.map((x) => x.value);
    db.exec('DROP TRIGGER label_tokens_ai; DROP TRIGGER label_tokens_au; DROP TRIGGER label_tokens_ad; DROP VIEW label_words; DROP VIEW label_json; DROP VIEW label_text; DROP TABLE label_tokens;');
    expect((await search(db, 'zond')).results.map((x) => x.value)).toEqual(withTokens);
    expect((await search(db, 'early')).results.map((x) => x.value)).toEqual(early);
  });
});
