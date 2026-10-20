/**
 * Apply .sql files to the remote D1 in batches through `wrangler d1 execute --command`
 * (works with the OAuth login, which lacks the scope `--file` imports need).
 *
 *   node --experimental-strip-types scripts/d1-apply.ts scripts/out/history/01_osmo_ts_000.sql [...more]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const MAX_BYTES = 90_000;

for (const file of process.argv.slice(2)) {
  // Comment-only lines are dropped before a statement is sent: `wrangler ... --command "-- …"` would read a leading
  // `--` as an option, and generated .sql files put every statement on one line, so no value ever starts a line with it.
  const stmts = readFileSync(file, 'utf8').split(/;\s*\n/).map((s) => s.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean);
  let batch: string[] = [], size = 0, done = 0;
  const flush = () => {
    if (!batch.length) return;
    execFileSync('npx', ['wrangler', 'd1', 'execute', 'namada-trade-db', '--remote', '--yes', '--command', batch.join(';\n') + ';'], {
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
