/**
 * Apply .sql files to the remote D1 in batches through `wrangler d1 execute --command`
 * (works with the OAuth login, which lacks the scope `--file` imports need).
 *
 *   node --experimental-strip-types scripts/d1-apply.ts scripts/out/history/01_osmo_ts_000.sql [...more]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { sqlStatements } from './sql-statements.ts';

const MAX_BYTES = 90_000;

// Statements are read as SQLite reads them, so a value holding a line break, a `;` or a comment marker stays in its
// string. Comments outside strings are dropped: `wrangler ... --command "-- …"` would read a leading `--` as an option.
// Every file is read before any is sent, so a file that is refused (a quote that never closes, a trigger, a NUL) stops
// the run with nothing sent.
const files = process.argv.slice(2).map((file) => {
  try {
    return { file, stmts: sqlStatements(readFileSync(file, 'utf8')) };
  } catch (e) {
    throw new Error(`${file}: ${e instanceof Error ? e.message : String(e)}; nothing was sent`);
  }
});

for (const { file, stmts } of files) {
  let batch: string[] = [], size = 0, done = 0;
  const flush = () => {
    if (!batch.length) return;
    const command = batch.join(';\n') + ';';
    // A batch is sent only when it reads back as exactly the statements it was made of.
    const back = sqlStatements(command);
    if (back.length !== batch.length || back.some((s, i) => s !== batch[i])) {
      throw new Error(`${file}: statements ${done + 1}-${done + batch.length} do not read back as written; nothing of them was sent`);
    }
    execFileSync('npx', ['wrangler', 'd1', 'execute', 'namada-trade-db', '--remote', '--yes', '--command', command], {
      stdio: ['ignore', 'ignore', 'inherit'],
      maxBuffer: 64 * 1024 * 1024,
    });
    done += batch.length;
    console.log(`${file}: ${done}/${stmts.length}`);
    batch = []; size = 0;
  };
  for (const s of stmts) {
    if (size + s.length > MAX_BYTES) flush();
    batch.push(s); size += s.length + 2;
  }
  flush();
}
