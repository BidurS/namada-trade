// Security review (2026-10-22), a NUL in a generated value: an Osmosis IBC receiver is chosen by the sender, the parser
// keeps it as sent, and inlineSql and the scripts' q() helpers write it into a .sql file unchanged, U+0000 included.
// scripts/sql-statements.ts read a string past the NUL, but SQLite ends its input there (the literal never closes)
// and Node refuses a command-line argument that holds one, so scripts/d1-apply.ts stopped at that batch after the
// file's earlier batches were applied to the remote D1. Now a file that holds a NUL anywhere is refused, and d1-apply
// reads every file before it sends any, so a refused file stops the run with nothing sent.
//
// d1-apply runs as a copy in a temporary folder with wrangler replaced by a stub: nothing is sent anywhere.
import { describe, it, expect, afterEach } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testD1 } from './d1-sqlite';
import { inlineSql, stmt } from '../worker/src/db';
import { normFromTxSearch, parseOsmosisTx, osmoAssets, type OsmoCtx } from '../worker/src/parse/osmosis';
import { sqlStatements } from '../scripts/sql-statements';

const ROOT = join(__dirname, '..');

/** Three flow statements as inlineSql writes them, the middle one with the parser's receiver holding U+0000. */
function nulFile(): { text: string; plain: string } {
  const raw = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'osmo_ibc_send.json'), 'utf8'))[0];
  for (const e of raw.tx_result.events) if (e.type === 'ibc_transfer') for (const a of e.attributes) if (a.key === 'receiver') a.value = 'tnam1dummy\u0000x';
  const ctx: OsmoCtx = { poolAddrs: new Map(), priceUsd: null, assets: osmoAssets() };
  const f = parseOsmosisTx(normFromTxSearch(raw, 1), ctx).flows.find((x) => x.kind === 'ibc_out')!;
  expect(f.to).toBe('tnam1dummy\u0000x'); // the parser keeps the receiver as sent
  const before = inlineSql(stmt.flow({ ...f, id: 'osmosis:TEST:a', to: 'tnam1plain' }));
  const bad = inlineSql(stmt.flow({ ...f, id: 'osmosis:TEST:b' }));
  const after = inlineSql(stmt.flow({ ...f, id: 'osmosis:TEST:c', to: 'tnam1plain' }));
  return { text: [before, bad, after].join('\n') + '\n', plain: [before, after].join('\n') + '\n' };
}

describe('a file that holds a NUL', () => {
  it('SQLite and Node do not read it as the statements it seems to hold', () => {
    const { text } = nulFile();
    const d1 = testD1();
    expect(() => d1.exec(text)).toThrow(/unrecognized token/);
    expect(() => execFileSync('/usr/bin/true', ['--command', text])).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' }));
  });

  it('is refused, wherever the NUL is', () => {
    expect(() => sqlStatements(nulFile().text)).toThrow(/NUL \(U\+0000\) at offset \d+ \(line 2\)/);
    expect(() => sqlStatements('SELECT 1; -- a note \u0000\nSELECT 2;')).toThrow(/NUL/);
    expect(() => sqlStatements('SELECT 1;\u0000')).toThrow(/NUL/);
    expect(sqlStatements(nulFile().plain)).toHaveLength(2);
  });
});

describe('d1-apply and a refused file', () => {
  const dirs: string[] = [];
  afterEach(() => {
    delete (globalThis as any).__d1ApplyWrangler;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** Runs a copy of d1-apply on `files` (name to text) and returns the commands it would have sent, or its error. */
  async function apply(files: [string, string][]): Promise<{ sent: string[][]; error: Error | null }> {
    const dir = mkdtempSync(join(tmpdir(), 'd1-apply-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'scripts'));
    const IMPORT_CP = "import { execFileSync } from 'node:child_process';";
    const src = readFileSync(join(ROOT, 'scripts', 'd1-apply.ts'), 'utf8');
    // The copy has no child_process at all, so nothing can reach wrangler.
    expect(src).toContain(IMPORT_CP);
    writeFileSync(join(dir, 'scripts', 'd1-apply.ts'), src.replace(IMPORT_CP, 'const execFileSync = (globalThis as any).__d1ApplyWrangler;'));
    copyFileSync(join(ROOT, 'scripts', 'sql-statements.ts'), join(dir, 'scripts', 'sql-statements.ts'));
    const paths = files.map(([name, text]) => { const p = join(dir, name); writeFileSync(p, text); return p; });
    const sent: string[][] = [];
    (globalThis as any).__d1ApplyWrangler = (cmd: string, args: string[]) => { sent.push([cmd, ...args]); return ''; };
    const argv = process.argv;
    process.argv = [argv[0], join(dir, 'scripts', 'd1-apply.ts'), ...paths];
    const log = console.log;
    console.log = () => {};
    let error: Error | null = null;
    try {
      await import(join(dir, 'scripts', 'd1-apply.ts'));
    } catch (e) {
      error = e as Error;
    } finally {
      process.argv = argv;
      console.log = log;
    }
    return { sent, error };
  }

  it('a good file is sent as one batch of its statements', async () => {
    const { plain } = nulFile();
    const { sent, error } = await apply([['good.sql', plain]]);
    expect(error).toBeNull();
    expect(sent).toEqual([['npx', 'wrangler', 'd1', 'execute', 'namada-trade-db', '--remote', '--yes', '--command', sqlStatements(plain).join(';\n') + ';']]);
  });

  it('a file with a NUL stops the run before anything is sent, the files before it included', async () => {
    const { text, plain } = nulFile();
    const { sent, error } = await apply([['good.sql', plain], ['nul.sql', text]]);
    expect(error?.message).toMatch(/nul\.sql: a NUL \(U\+0000\) at offset \d+ \(line 2\): SQLite would end the text there; nothing was sent/);
    expect(sent).toEqual([]);
  });
});
