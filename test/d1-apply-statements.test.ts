// Security review (2026-10-22), d1-apply statement reading: scripts/d1-apply.ts cut a file at every ";" + newline
// and deleted every line that starts with "--", without knowing where a quoted string begins and ends. The generators'
// q() helpers keep a value's raw line breaks, and inlineSql keeps U+2028 and U+2029 (which JavaScript's multiline
// regex reads as line starts), so a sender-chosen IBC receiver or memo holding a line break and then "--" lost the
// rest of its statement, and a value holding ";" and a line break was cut in two and rejoined with other whitespace:
// the text sent to the remote D1 was not the text the generator wrote. Now scripts/sql-statements.ts reads a file as
// SQLite does (quoted strings whole, comments outside them dropped), d1-apply sends a batch only when it reads back
// as the statements it was made of, and a file whose quote never closes, or that creates a trigger, is refused.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { testD1 } from './d1-sqlite';
import { inlineSql, stmt } from '../worker/src/db';
import { normFromTxSearch, parseOsmosisTx, osmoAssets, type OsmoCtx } from '../worker/src/parse/osmosis';
import { sqlStatements } from '../scripts/sql-statements';
import type { Flow } from '../shared/types';

/** scripts/backfill-history.ts q(): quotes doubled, line breaks kept as they are. */
const q = (v: unknown): string =>
  v === null || v === undefined ? 'NULL' : typeof v === 'number' ? (Number.isFinite(v) ? String(v) : 'NULL') : `'${String(v).replace(/'/g, "''")}'`;
/** The row backfill-history.ts writes for an indexer transfer, with q(). */
const historyRow = (f: Flow) =>
  `INSERT OR IGNORE INTO flows (id,chain,height,ts,tx_hash,kind,from_addr,to_addr,amount_num,meta) VALUES (${q(f.id)},'namada',${f.height},${f.ts},${q(f.txHash)},${q(f.kind)},${q(f.from)},${q(f.to)},${f.amount},${q(JSON.stringify(f.meta))})`;
const flow = (id: string, to: string, memo: string): Flow =>
  ({ id, chain: 'osmosis', height: 1, ts: 1, txHash: 'TEST', kind: 'ibc_out', from: null, to, amount: 1, meta: { memo } }) as Flow;
/** A generated file as the scripts write one: each statement on its line, ending ";". */
const file = (stmts: string[]) => stmts.map((s) => s + ';').join('\n') + '\n';
const stored = (sql: string) => {
  const d1 = testD1();
  d1.exec(sql);
  return d1.raw.prepare('SELECT id, to_addr, meta FROM flows ORDER BY id').all().map((r: any) => ({ ...r }));
};
/** What d1-apply sends for a file: its statements joined into one batch, which must read back the same. */
const sent = (text: string) => {
  const stmts = sqlStatements(text);
  const batch = stmts.join(';\n') + ';';
  expect(sqlStatements(batch)).toEqual(stmts);
  return { stmts, batch };
};

const CASES: [string, string[]][] = [
  ['inlineSql, a memo with U+2028 then "--"', [flow('osmosis:TEST:a', 'dummy', 'x -- y'), flow('osmosis:TEST:b', 'dummy', 'plain')].map((f) => inlineSql(stmt.flow(f)).replace(/;$/, ''))],
  ['q(), an address with a line feed then "--"', [flow('osmosis:TEST:a', 'dummy\n-- y', 'plain'), flow('osmosis:TEST:b', 'dummy', 'plain')].map(historyRow)],
  ['q(), an address with ";", a line feed and spaces', [flow('osmosis:TEST:a', 'a;\n  b', 'plain'), flow('osmosis:TEST:b', 'dummy', 'plain')].map(historyRow)],
  ['q(), a carriage return, U+2029 and "/*" in values', [flow('osmosis:TEST:a', 'a\r-- b', 'c /* d'), flow('osmosis:TEST:b', 'dummy', 'plain')].map(historyRow)],
];

describe('d1-apply reads generated statements as written', () => {
  for (const [name, stmts] of CASES) {
    it(`${name}: the same statements, and the same stored rows`, () => {
      const text = file(stmts);
      const { stmts: got, batch } = sent(text);
      expect(got).toEqual(stmts);
      const rows = stored(text);
      expect(rows).toHaveLength(2);
      expect(stored(batch)).toEqual(rows);
    });
  }

  it("an Osmosis bridge send whose receiver and memo hold line breaks is stored as the parser read it", () => {
    const raw = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'osmo_ibc_send.json'), 'utf8'))[0];
    for (const e of raw.tx_result.events) if (e.type === 'ibc_transfer') for (const a of e.attributes) {
      if (a.key === 'receiver') a.value = 'tnam1dummy\n-- note';
      if (a.key === 'memo') a.value = 'line -- note';
    }
    const ctx: OsmoCtx = { poolAddrs: new Map(), priceUsd: null, assets: osmoAssets() };
    const f = parseOsmosisTx(normFromTxSearch(raw, 1), ctx).flows.find((x) => x.kind === 'ibc_out')!;
    expect(f.to).toBe('tnam1dummy\n-- note');
    for (const stmts of [[inlineSql(stmt.flow(f)).replace(/;$/, '')], [historyRow(f)]]) {
      const text = file(stmts);
      const { stmts: got, batch } = sent(text);
      expect(got).toEqual(stmts);
      const [row] = stored(batch);
      expect(row.to_addr).toBe(f.to);
      expect(JSON.parse(row.meta).memo).toBe(f.meta!.memo);
    }
  });

  it('drops comments outside strings, so no batch starts with "--", and keeps them inside strings', () => {
    expect(sqlStatements("-- a\n  -- b\nSELECT 1; -- c\n/* d; */ SELECT '--e;\n' -- f\n;")).toEqual(['SELECT 1', "SELECT '--e;\n'"]);
  });

  it('refuses a quote or block comment that never closes, and a trigger', () => {
    expect(() => sqlStatements("UPDATE flows SET to_addr = 'x;\n")).toThrow(/never closes/);
    expect(() => sqlStatements('UPDATE flows SET kind = 1 /* x;\n')).toThrow(/never closes/);
    expect(() => sqlStatements('CREATE TRIGGER IF NOT EXISTS t AFTER INSERT ON flows BEGIN SELECT 1; END;')).toThrow(/trigger/);
  });

  it('reads the tracked repair files as the statements they were applied as', () => {
    const read = (n: string) => sqlStatements(readFileSync(join(__dirname, '..', 'scripts', n), 'utf8'));
    expect(read('rebuild-address-links.sql')).toHaveLength(2);
    expect(read('repair-pos-balance.sql')).toHaveLength(2);
  });
});
