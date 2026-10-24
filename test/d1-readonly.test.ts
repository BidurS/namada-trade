// Daily digest (2026-10-23): scripts/d1-readonly.ts, the read-only database scripts/preview-digest.ts reads production
// through. Anything that is not a read is refused before it is sent; parameters are written in only as numbers or
// quoted strings, in SQLite's numbering; D1's 7403 is asked again; and the digest built through it from the survey's
// seeded rows is byte for byte the digest built with bound parameters on the same rows. No remote call is made: the
// runner here answers from the SQLite stand-in in wrangler's --json shape.
import { describe, expect, it } from 'vitest';
import { testD1, type TestD1 } from './d1-sqlite';
import { seedCharts, seedSurvey, T } from './digest-survey';
import { inline, readOnlyD1, scan, type Runner } from '../scripts/d1-readonly';
import { readAndBuildDigest } from '../worker/src/digest/build';

/** wrangler's --json answer for one statement, from the stand-in. */
const sqliteRunner = (db: TestD1): Runner => async (sql) => JSON.stringify([{ results: db.raw.prepare(sql).all().map((r: object) => ({ ...r })), success: true, meta: { rows_read: 1 } }]);

describe('the guard: only reads are sent', () => {
  it('refuses writes, write keywords outside literals, more than one statement and a write behind a comment or a WITH', () => {
    for (const sql of [
      "INSERT INTO kv (key, value, updated_at) VALUES ('a', 'b', 1)",
      "UPDATE kv SET value = 'x'",
      'DELETE FROM kv',
      'DROP TABLE kv',
      'PRAGMA table_info(kv)',
      "ATTACH DATABASE 'x' AS y",
      'WITH x AS (SELECT 1) DELETE FROM kv',
      'SELECT 1; DELETE FROM kv',
      '/* SELECT */ DELETE FROM kv',
      '-- SELECT\nUPDATE kv SET value = 1',
      "REPLACE INTO kv (key) VALUES ('a')",
      'EXPLAIN DELETE FROM kv',
      'VACUUM',
    ]) expect(() => inline(sql, []), sql).toThrow(/^refused/);
  });

  it('accepts a SELECT after comments and whitespace, a WITH, an EXPLAIN QUERY PLAN; a keyword inside a literal or a column name is not a write', () => {
    expect(inline('  -- the anchors\n  /* one */ SELECT key, updated_at FROM kv WHERE key = ?', ['a'])).toBe("-- the anchors /* one */ SELECT key, updated_at FROM kv WHERE key = 'a'");
    expect(inline('WITH x AS (SELECT 1 a) SELECT a FROM x', [])).toBe('WITH x AS (SELECT 1 a) SELECT a FROM x');
    expect(inline('explain query plan select * from kv where key = ?', ['k'])).toBe("explain query plan select * from kv where key = 'k'");
    expect(inline("SELECT 'DELETE FROM kv; UPDATE' AS s, updated_at FROM kv WHERE key LIKE '%?%'", [])).toBe("SELECT 'DELETE FROM kv; UPDATE' AS s, updated_at FROM kv WHERE key LIKE '%?%'");
  });

  it('writes parameters in only as finite numbers or quoted strings with quotes doubled, in SQLite\'s numbering', () => {
    expect(inline('SELECT ? a, ? b, ? c', [1792742400000, -5, "it's"])).toBe("SELECT 1792742400000 a, (-5) b, 'it''s' c");
    expect(inline('SELECT ?2 a, ?1 b, ?2 c', ['x', 0.5])).toBe("SELECT 0.5 a, 'x' b, 0.5 c");
    expect(inline('SELECT ?2 a, ? b', [1, 2, 3])).toBe('SELECT 2 a, 3 b');
    for (const v of [null, undefined, true, 1n, {}, [], Number.NaN, Number.POSITIVE_INFINITY]) expect(() => inline('SELECT ?', [v]), String(v)).toThrow(/^refused/);
    expect(() => inline('SELECT ?, ?', [1])).toThrow(/2 parameters/);
    expect(() => inline('SELECT ?', [1, 2])).toThrow(/2 values bound to 1/);
    expect(() => inline('SELECT :name', [1])).toThrow(/named/);
    expect(() => inline("SELECT 'open", [])).toThrow(/unterminated/);
    expect(scan("SELECT json_extract(meta, '$.via') FROM flows").params).toEqual([]);
  });

  it('refuses run(), exec() and dump(); a refused statement is listed and never sent', async () => {
    const sent: string[] = [];
    const { db, ran } = readOnlyD1(async (sql) => { sent.push(sql); return '[]'; }, { pauseMs: 0 });
    await expect(db.prepare('SELECT 1').run()).rejects.toThrow(/refused/);
    await expect(db.exec('SELECT 1')).rejects.toThrow(/refused/);
    await expect(db.prepare('DELETE FROM kv').all()).rejects.toThrow(/refused/);
    await expect(db.prepare('SELECT ?').bind(null).all()).rejects.toThrow(/null/);
    expect(sent).toEqual([]);
    expect(ran.map((r) => r.error)).toEqual(['refused: not a SELECT, WITH or EXPLAIN QUERY PLAN (DELETE FROM kv)', 'refused: a null parameter']);
  });

  it('asks again after D1\'s 7403 and counts the tries; another error is not asked again', async () => {
    let n = 0;
    const flaky: Runner = async () => (++n < 3
      ? JSON.stringify({ error: { text: 'A request to the Cloudflare API failed.', notes: [{ text: 'not authorized [code: 7403]' }], code: 7403 } })
      : JSON.stringify([{ results: [{ one: 1 }], success: true, meta: { rows_read: 1 } }]));
    const { db, ran } = readOnlyD1(flaky, { pauseMs: 0 });
    expect(await db.prepare('SELECT 1 AS one').first()).toEqual({ one: 1 });
    expect(ran).toMatchObject([{ rows: 1, rowsRead: 1, tries: 3 }]);
    let m = 0;
    const broken: Runner = async () => { m++; return JSON.stringify({ error: { text: 'no such table: nope', code: 7500 } }); };
    const b = readOnlyD1(broken, { pauseMs: 0 });
    await expect(b.db.prepare('SELECT * FROM nope').all()).rejects.toThrow(/no such table/);
    expect(m).toBe(1);
  });
});

describe('the digest through the read-only database', () => {
  it('is the digest built with bound parameters, on the same rows: every statement written in reads the same', async () => {
    const db = testD1();
    seedSurvey(db);
    seedCharts(db);
    const direct = await readAndBuildDigest(db, T, 'daily');
    const { db: ro, ran } = readOnlyD1(sqliteRunner(db), { pauseMs: 0 });
    const shimmed = await readAndBuildDigest(ro, T, 'daily');
    expect(ran.filter((r) => r.error)).toEqual([]);
    expect(ran.length).toBeGreaterThan(70);
    const strip = (ps: typeof direct.operatorPosts) => ps.map((p) => ({ payload: p.payload, files: p.files.map((f) => [f.name, f.bytes.length]) }));
    expect(strip(shimmed.operatorPosts)).toEqual(strip(direct.operatorPosts));
    expect(shimmed.notes).toEqual(direct.notes);
  });
});
