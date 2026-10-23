// The repair of the nine staking-account balance transfers (scripts/repair-pos-balance.sql, applied from its copy
// scripts/out/repair/pos_balance_2026-10-20.sql;
// docs/design/screener-plan.md 3.0) run on the D1 stand-in with the real migrations: exactly the guarded rows change,
// the flow-history estimate of the counterparty becomes unknown (NULL, never 0), and a second run changes nothing.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { testD1, insert } from './d1-sqlite';
import { sqlStatements } from '../scripts/sql-statements';

// The tracked copy (scripts/out/ is not in git); the file the orchestrator applies must be the same bytes.
const SQL = readFileSync(join(__dirname, '..', 'scripts', 'repair-pos-balance.sql'), 'utf8');
const OUT = join(__dirname, '..', 'scripts', 'out', 'repair', 'pos_balance_2026-10-20.sql');
/** As scripts/d1-apply.ts reads a file: its statements as SQLite reads them, comments outside strings dropped. */
const statements = sqlStatements(SQL);

const POS = 'tnam1qgqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqc8j2fp';
const A = 'tnam1qry99h4faqtkleuuyecxzrswq7vgkj2hu5kg6dqp';
const B = 'tnam1qrk5pyvtzxjmykcqmhglssshdjf3njac2qvqmlse';
const W = 'namada:7ABE4624B78CD1C37019AA55F0533ED377FB3ABC2F3A46DAED46588DD419D634:0';
// the nine production rows (id, kind, from, to, NAM), read 2026-10-20
const NINE: [string, string, string, string, number][] = [
  [W, 'withdraw', POS, A, 1000000],
  ['namada:C742D695F6ED7897475E22C7B58B708F0FF6F7DA71FBD2212AC1866F37405746:0', 'withdraw', POS, A, 331386682.183413],
  ['namada:D6BB0859F632A73BB5158B36B179A123EF4026D48DAC8FB5356A7ECB65E2D307:0', 'withdraw', POS, A, 1],
  ['namada:6CE238E7E93504F151BE97311640BFF1FEA91DEC7B129BFDCD98C0498E211B19:0', 'bond', B, POS, 100],
  ['namada:333718A78AB5097D35DBC97202D439CFC4EDC69A924944C50722A0AD6D2F5A31:0', 'bond', B, POS, 99999900],
  ['namada:8D27AF94D35CBAF7046FAF9DA9B6D5383BC9458222D1E2F0F68492229DD8F556:0', 'bond', B, POS, 100000000],
  ['namada:0D4F39FABEE73904DF8529DB7EAD621C6ADF5AFD32AFB4DF5F8A31DE6187AFCB:0', 'bond', B, POS, 100000000],
  ['namada:DE2990109B9ABCD28F07476F52DFF9102FAB8DFFC103A8E3C61588E076E40F05:0', 'bond', B, POS, 29386967.189242],
  ['namada:1DA077C41DBB414A178A349B4A98343C4C6FC45105078277B14C4D4336439E9B:0', 'bond', B, POS, 2999715.994171],
];
const flow = (id: string, kind: string, from: string, to: string, nam: number, descriptor: string | null, height = 7900000) => ({
  id, chain: 'namada', height, ts: 1788219123013, tx_hash: id.split(':')[1], kind, from_addr: from, to_addr: to, amount_num: nam,
  meta: JSON.stringify(descriptor ? { descriptor } : { source: 'namada-indexer', txKind: kind }),
});

function seeded() {
  const d1 = testD1();
  insert(d1, 'flows', NINE.map(([id, kind, from, to, nam], i) => flow(id, kind, from, to, nam, 'transfer-from-wasm', 7900823 + i)));
  insert(d1, 'flows', [
    // what must not change: a real bond from the indexer, a real withdrawal by the chain, a holder-to-holder wasm transfer,
    // and a wasm transfer touching the staking account whose id is not one of the nine (the guard lists ids)
    flow('namada:REALBOND:pos', 'bond', 'tnam1qxuser00000000000000000000000000000000', POS, 5000, null),
    flow('namada:REALWITHDRAW:0', 'withdraw', POS, 'tnam1qxuser00000000000000000000000000000000', 4000, 'pos-withdraw-token'),
    flow('namada:HOLDERS:0', 'transfer', A, B, 7, 'transfer-from-wasm'),
    flow('namada:OTHERPOS:0', 'bond', B, POS, 3, 'transfer-from-wasm'),
  ]);
  insert(d1, 'stakes', [
    { address: B, bonded_num: 0, delegations: '[]', estimated_num: 332386683.183413, updated_at: 1 },
    { address: A, bonded_num: 0, delegations: '[]', estimated_num: null, updated_at: 1 },
    { address: 'tnam1qxuser00000000000000000000000000000000', bonded_num: 5000, estimated_num: 5000, updated_at: 1 },
  ]);
  return d1;
}
const apply = (d1: ReturnType<typeof testD1>) => { for (const s of statements) d1.raw.prepare(s).run(); };
const kinds = (d1: ReturnType<typeof testD1>) => Object.fromEntries(d1.raw.prepare('SELECT id, kind FROM flows ORDER BY id').all().map((r: any) => [r.id, r.kind]));

describe('the pos_balance repair', () => {
  it('the copy to apply, when present, is the tracked file', () => {
    if (existsSync(OUT)) expect(readFileSync(OUT, 'utf8')).toBe(SQL);
  });

  it('is two statements as scripts/d1-apply.ts sends them', () => {
    expect(statements).toHaveLength(2);
    expect(statements[0]).toMatch(/^UPDATE flows SET kind = 'pos_balance'/);
    expect(statements[1]).toMatch(/^UPDATE stakes SET estimated_num/);
  });

  it('re-files exactly the nine rows; out and in are equal to the base unit', () => {
    const d1 = seeded();
    apply(d1);
    const k = kinds(d1);
    for (const [id] of NINE) expect(k[id], id).toBe('pos_balance');
    expect(k['namada:REALBOND:pos']).toBe('bond');
    expect(k['namada:REALWITHDRAW:0']).toBe('withdraw');
    expect(k['namada:HOLDERS:0']).toBe('transfer');
    expect(k['namada:OTHERPOS:0']).toBe('bond');
    const r = d1.raw.prepare(`SELECT COUNT(*) n, SUM(CASE WHEN from_addr = ? THEN amount_num ELSE 0 END) out_nam, SUM(CASE WHEN to_addr = ? THEN amount_num ELSE 0 END) in_nam FROM flows WHERE kind = 'pos_balance'`).get(POS, POS);
    expect(r.n).toBe(9);
    expect(r.out_nam).toBeCloseTo(332386683.183413, 6);
    expect(r.in_nam).toBeCloseTo(332386683.183413, 6);
  });

  it('recomputes the estimate from what is left: the counterparty of the nine rows keeps only the bond the guard skipped', () => {
    const d1 = seeded();
    apply(d1);
    const est = (a: string) => d1.raw.prepare('SELECT estimated_num e FROM stakes WHERE address = ?').get(a).e;
    // B's only bond row left is the 3 NAM one outside the id list
    expect(est(B)).toBe(3);
    expect(est(A)).toBeNull();
    expect(est('tnam1qxuser00000000000000000000000000000000')).toBe(5000);
    // without that row the estimate is unknown (NULL), never 0
    d1.raw.prepare(`DELETE FROM flows WHERE id = 'namada:OTHERPOS:0'`).run();
    apply(d1);
    expect(est(B)).toBeNull();
  });

  it('a second run changes nothing', () => {
    const d1 = seeded();
    apply(d1);
    const before = d1.raw.prepare('SELECT * FROM flows ORDER BY id').all();
    const stakes = d1.raw.prepare('SELECT * FROM stakes ORDER BY address').all();
    const changes = statements.map((s) => Number(d1.raw.prepare(s).run().changes));
    expect(changes[0]).toBe(0);
    expect(d1.raw.prepare('SELECT * FROM flows ORDER BY id').all()).toEqual(before);
    expect(d1.raw.prepare('SELECT * FROM stakes ORDER BY address').all()).toEqual(stakes);
  });
});
