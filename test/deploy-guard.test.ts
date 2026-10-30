// The deploy's guardrails (plan Stage 1 item 8, 2026-10-29). scripts/deploy-check.sh deploys only the tip of branch
// integration from a clean tree (--off-tip overrides, loudly), runs npm ci only when node_modules does not match
// package-lock.json and never through a link to another checkout's packages, runs the typecheck, the build and the
// test suite before anything remote changes (--skip-tests leaves the suite out, loudly), and reads the live Worker
// version and a D1 Time Travel bookmark before the migrations, printing the one command that goes back to each (the
// database's restore after the removal of SEND_ALERTS); --dry-run (or DRY_RUN=1) runs the reads and prints every write.
// scripts/export-offsite.sh writes the weekly copy of the database only into an existing folder outside any git
// working tree. Nothing here reaches Cloudflare: the script runs in a scratch repository with stand-ins for npx, npm
// and curl that record each call and answer the reads from saved answers, and the steps' parsers run on saved text.
import { describe, it, expect, afterAll } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const ROOT = join(__dirname, '..');
const DEPLOY = readFileSync(join(ROOT, 'scripts', 'deploy-check.sh'), 'utf8');
const EXPORT = join(ROOT, 'scripts', 'export-offsite.sh');
const scratch = mkdtempSync(join(tmpdir(), 'deploy-guard-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const LIVE = 'a87e78de-beed-4794-a368-c83056d658b4';
const BOOKMARK = '00000094-000006c4-00005114-b4b1f39fb9ede82e2bf18eb433fa111d';
const AUTHOR = 'someone@example.invalid';

/** The Python a step hands to `python3 -c "…"`, as bash passes it (none of these holds a $, a backquote or a \"). */
function program(after: string): string {
  const at = DEPLOY.indexOf(after);
  expect(at, after).toBeGreaterThan(-1);
  const m = DEPLOY.slice(at).match(/python3 -c "\n([\s\S]*?)"/);
  expect(m, after).not.toBeNull();
  return m![1];
}
const py = (src: string, input = '', cwd?: string) => spawnSync('python3', ['-c', src], { input, cwd, encoding: 'utf8' });

// ---------------------------------------------------------------- a scratch repository with stand-ins

const bin = join(scratch, 'bin');
const log = join(scratch, 'calls.log');
mkdirSync(bin);
// npx: the wrangler reads answered as Cloudflare answers them (a warning line before the JSON included); anything
// else is recorded and answers nothing, so a check added later fails here by name rather than reaching the network
writeFileSync(join(bin, 'npx'), `#!/bin/bash
echo "npx $*" >> "${log}"
case "$*" in
  *"secret list"*) echo '[{"name":"SEND_ALERTS","type":"secret_text"},{"name":"SETTINGS_KEY","type":"secret_text"}]' ;;
  *"deployments status"*) echo '▲ [WARNING] a note'; echo '{"id":"d1","created_on":"2026-10-29T14:17:52.776814Z","author_email":"${AUTHOR}","versions":[{"version_id":"${LIVE}","percentage":100}]}' ;;
  *"time-travel info"*) echo '{"bookmark":"${BOOKMARK}"}' ;;
  *"migrations list"*) echo 'No migrations to apply!' ;;
  *holders_total*) echo '[{"results":[{"triggers":8,"objects":7}]}]' ;;
  *kv_session_addr*) echo '[{"results":[{"n":3}]}]' ;;
  *labels_user_author*) echo '[{"results":[{"col":1,"n":2}]}]' ;;
  *kv_alert_claim_time*) echo '[{"results":[{"n":1}]}]' ;;
  *kv_user_deliverable*) echo '[{"results":[{"n":1}]}]' ;;
  *kv_user_telegram*) echo '[{"results":[{"n":2}]}]' ;;
  *depth_minute*) echo '[{"results":[{"tables":3,"n":2}]}]' ;;
  *"r2 bucket list"*) echo 'name: namada-trade-depth' ;;
  *) echo '[{"results":[{}]}]' ;;
esac
`, { mode: 0o755 });
writeFileSync(join(bin, 'npm'), `#!/bin/bash\necho "npm $*" >> "${log}"\n`, { mode: 0o755 });
writeFileSync(join(bin, 'curl'), `#!/bin/bash\necho "curl $*" >> "${log}"\nexit 1\n`, { mode: 0o755 });

const repo = join(scratch, 'repo');
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' });
mkdirSync(join(repo, 'scripts'), { recursive: true });
copyFileSync(join(ROOT, 'scripts', 'deploy-check.sh'), join(repo, 'scripts', 'deploy-check.sh'));
writeFileSync(join(repo, '.gitignore'), 'node_modules\n');
writeFileSync(join(repo, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/a': { version: '1.0.0', integrity: 'sha512-a' } } }));
git('init', '-q', '-b', 'integration');
git('add', '.');
git('commit', '-q', '-m', 'the tip');

/** Runs the copy of deploy-check.sh in the scratch repository: its calls, its output and how it ended. */
function deploy(args: string[], env: Record<string, string> = {}) {
  writeFileSync(log, '');
  const r = spawnSync('bash', ['scripts/deploy-check.sh', ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DRY_RUN: '', ...env } });
  return { status: r.status, out: r.stdout + r.stderr, calls: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) };
}

describe('deploy-check.sh', () => {
  it('a dry run at integration\'s tip runs the reads, prints each write, and names the version and the bookmark to go back to', () => {
    const r = deploy(['--dry-run']);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('ok   clean tree at integration\'s tip');
    expect(r.out).toContain('SEND_ALERTS secret: set');
    expect(r.out).toContain(`live Worker version: ${LIVE} at 100%, deployed 2026-10-29T14:17:52.776814Z`);
    expect(r.out).toContain(`npx wrangler rollback ${LIVE} --message`);
    expect(r.out).toContain(`npx wrangler d1 time-travel restore namada-trade-db --bookmark=${BOOKMARK}`);
    // SEND_ALERTS goes first, then the restore, then it comes back
    expect(r.out.indexOf('secret delete SEND_ALERTS')).toBeLessThan(r.out.indexOf('time-travel restore'));
    expect(r.out.indexOf('time-travel restore')).toBeLessThan(r.out.indexOf('secret put SEND_ALERTS, value yes'));
    // no node_modules here: the install is printed, and so is the typecheck, which would have nothing to run with
    for (const w of ['npm ci', 'npm run typecheck', 'npm run build', 'npx vitest run --maxWorkers=4 --minWorkers=1', 'npx wrangler d1 migrations apply namada-trade-db --remote', 'npx wrangler deploy']) expect(r.out).toContain(`dry run, not run: ${w}`);
    expect(r.out).toContain('== dry run done');
    // who deployed the live version is in the answer and never printed
    expect(r.out).not.toContain(AUTHOR);
    // only reads were made: no install, build, test run, migration, deploy or smoke request
    expect(r.calls.filter((c) => c.startsWith('npm '))).toEqual([]);
    expect(r.calls.some((c) => /migrations apply|wrangler deploy( |$)|secret (put|delete)|time-travel restore|rollback/.test(c))).toBe(false);
    expect(r.calls.some((c) => c.startsWith('curl '))).toBe(false);
    expect(r.calls.filter((c) => /d1 execute/.test(c)).every((c) => /SELECT/.test(c))).toBe(true);
  }, 30_000);

  it('DRY_RUN=1 is the same dry run', () => {
    const r = deploy([], { DRY_RUN: '1' });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('DRY RUN: nothing is installed, built, migrated or deployed');
    expect(r.calls.some((c) => /migrations apply|wrangler deploy( |$)/.test(c))).toBe(false);
  }, 30_000);

  it('a dirty tree is refused before any call, untracked files included', () => {
    writeFileSync(join(repo, 'stray.ts'), 'export {};\n');
    try {
      const r = deploy(['--dry-run']);
      expect(r.status).toBe(1);
      expect(r.out).toContain('FAIL the working tree has 1 changed or untracked path(s):');
      expect(r.out).toContain('?? stray.ts');
      expect(r.out).toContain('--off-tip overrides, loudly');
      expect(r.calls).toEqual([]);
    } finally {
      rmSync(join(repo, 'stray.ts'));
    }
  });

  it('a commit other than integration\'s tip is refused; --off-tip goes on with a loud warning', () => {
    git('checkout', '-q', '-b', 'side');
    writeFileSync(join(repo, 'side.txt'), 'x\n');
    git('add', 'side.txt');
    git('commit', '-q', '-m', 'not on integration');
    try {
      const r = deploy(['--dry-run']);
      expect(r.status).toBe(1);
      expect(r.out).toMatch(/FAIL HEAD is [0-9a-f]{9} \(\d{4}-\d{2}-\d{2}\), not the tip of integration, [0-9a-f]{9}/);
      expect(r.calls).toEqual([]);
      const o = deploy(['--dry-run', '--off-tip']);
      expect(o.status, o.out).toBe(0);
      expect(o.out).toContain('!!! WARNING --off-tip: going on anyway, although');
      expect(o.out).toContain('!!! The live Worker will not be a commit of the public line.');
    } finally {
      git('checkout', '-q', 'integration');
    }
  }, 30_000);

  it('--skip-tests leaves the suite out and says so; an unknown option is refused', () => {
    const r = deploy(['--dry-run', '--skip-tests']);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('!!! WARNING --skip-tests: the test suite was NOT run.');
    expect(r.out).not.toContain('npx vitest run');
    const u = deploy(['--dry-run', '--force']);
    expect(u.status).toBe(2);
    expect(u.out).toContain('unknown option --force');
    expect(u.calls).toEqual([]);
  }, 30_000);

  it('never runs npm ci through a link to another checkout\'s packages: a real run stops before anything else', () => {
    const other = join(scratch, 'other-node_modules');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, '.package-lock.json'), JSON.stringify({ packages: { 'node_modules/a': { version: '0.9.0', integrity: 'sha512-old' } } }));
    symlinkSync(other, join(repo, 'node_modules'));
    try {
      const r = deploy([]);
      expect(r.status).toBe(1);
      expect(r.out).toContain('node_modules/a 0.9.0 installed, the lock has 1.0.0');
      expect(r.out).toContain('FAIL node_modules is a link to another checkout and does not match the lock');
      expect(r.calls).toEqual([]);
      expect(readdirSync(other)).toEqual(['.package-lock.json']);
      // the same link matching the lock: no npm ci, and the run goes on, its typecheck run (a read of the tree)
      writeFileSync(join(other, '.package-lock.json'), JSON.stringify({ packages: { 'node_modules/a': { version: '1.0.0', integrity: 'sha512-a' } } }));
      const ok = deploy(['--dry-run']);
      expect(ok.status, ok.out).toBe(0);
      expect(ok.out).toContain('ok   node_modules matches package-lock.json (1 packages)');
      expect(ok.out).toContain(`node_modules is a link to ${other}; no npm ci`);
      expect(ok.out).not.toContain('dry run, not run: npm ci');
      expect(ok.calls.filter((c) => c.startsWith('npm '))).toEqual(['npm run typecheck']);
    } finally {
      rmSync(join(repo, 'node_modules'));
    }
  }, 30_000);

  it('the order: the guard, the packages, the checks and the secret before the rollback reads, which come before the migrations and the deploy', () => {
    const order = ['== guard', '== packages', 'npm run typecheck', 'npm run build', 'npx vitest run --maxWorkers=4 --minWorkers=1', 'wrangler secret list --format json',
      'wrangler deployments status --json', 'wrangler d1 time-travel info namada-trade-db --json', 'migrations apply', 'npx wrangler deploy 2>&1'];
    const at = order.map((s) => DEPLOY.indexOf(s));
    for (let i = 0; i < order.length; i++) expect(at[i], order[i]).toBeGreaterThan(-1);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // the deploy ships the build the tests ran against: npm run deploy would build again
    expect(DEPLOY).not.toContain('npm run deploy');
  });
});

describe('deploy-check.sh, its readers', () => {
  const lock = program('lock_matches() {');
  const dir = join(scratch, 'lock');
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  const put = (lockPackages: object, installed: object | null) => {
    writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ packages: { '': {}, ...lockPackages } }));
    if (installed) writeFileSync(join(dir, 'node_modules', '.package-lock.json'), JSON.stringify({ packages: installed }));
    else rmSync(join(dir, 'node_modules', '.package-lock.json'), { force: true });
    return py(lock, '', dir);
  };
  const a = { version: '1.0.0', integrity: 'sha512-a' };
  const linux = { version: '0.21.5', optional: true, dev: true, os: ['linux'], cpu: ['x64'] };

  it('the installed tree matches the lock when only another platform\'s optional builds are absent', () => {
    expect(put({ 'node_modules/a': a, 'node_modules/@esbuild/linux-x64': linux }, { 'node_modules/a': a }).status).toBe(0);
  });

  it('a version or integrity that differs, a package missing or one the lock lacks, or no record of the install, is a mismatch', () => {
    const v = put({ 'node_modules/a': a }, { 'node_modules/a': { ...a, version: '1.0.1' } });
    expect(v.status).toBe(1);
    expect(v.stdout).toContain('node_modules/a 1.0.1 installed, the lock has 1.0.0');
    expect(put({ 'node_modules/a': a }, { 'node_modules/a': { ...a, integrity: 'sha512-b' } }).status).toBe(1);
    // optional but not bound to a platform: it should be there
    const opt = put({ 'node_modules/a': a, 'node_modules/b': { version: '2.0.0', optional: true } }, { 'node_modules/a': a });
    expect(opt.status).toBe(1);
    expect(opt.stdout).toContain('node_modules/b missing');
    const extra = put({ 'node_modules/a': a }, { 'node_modules/a': a, 'node_modules/z': { version: '9.9.9' } });
    expect(extra.status).toBe(1);
    expect(extra.stdout).toContain('node_modules/z installed, not in the lock');
    const none = put({ 'node_modules/a': a }, null);
    expect(none.status).toBe(1);
    expect(none.stdout).toContain('the installed tree could not be read');
  });

  it('the live version: the JSON after any warning, the larger share of a split, and never who deployed it', () => {
    const live = program('live=$(echo "$out" |');
    const one = py(live, `▲ [WARNING] a note\n{"created_on":"2026-10-29T14:17:52Z","author_email":"${AUTHOR}","versions":[{"version_id":"${LIVE}","percentage":100}]}`);
    expect(one.status).toBe(0);
    expect(one.stdout.trim().split('\t')).toEqual([LIVE, `${LIVE} at 100%`, '2026-10-29T14:17:52Z']);
    expect(one.stdout).not.toContain(AUTHOR);
    const other = '11111111-2222-3333-4444-555555555555';
    const split = py(live, JSON.stringify({ created_on: 'x', versions: [{ version_id: other, percentage: 10 }, { version_id: LIVE, percentage: 90 }] }, null, 2));
    expect(split.stdout.split('\t')[0]).toBe(LIVE);
    for (const bad of ['✘ [ERROR] Authentication error [code: 10000]', '{"versions":[]}', '{"versions":[{"version_id":"$(touch x)","percentage":100}]}']) expect(py(live, bad).status, bad).toBe(1);
  });

  it('the bookmark: the JSON field, or nothing when the answer is not one', () => {
    const bm = program('bookmark=$(echo "$out" |');
    const ok = py(bm, `{\n  "bookmark": "${BOOKMARK}"\n}`);
    expect(ok.status).toBe(0);
    expect(ok.stdout.trim()).toBe(BOOKMARK);
    for (const bad of ['✘ [ERROR] database not found', '{"bookmark": null}', '{"bookmark": "a; rm -rf ~"}']) expect(py(bm, bad).status, bad).toBe(1);
  });
});

describe('export-offsite.sh', () => {
  const run = (...args: string[]) => {
    const r = spawnSync('bash', [EXPORT, ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DRY_RUN: '' } });
    return { status: r.status, out: r.stdout + r.stderr };
  };
  const outside = join(scratch, 'offsite');
  mkdirSync(outside);

  it('writes only into an existing folder outside any git working tree', () => {
    writeFileSync(log, '');
    expect(run().status).toBe(2);
    expect(run('--dry-run').status).toBe(2);
    expect(run('-x').status).toBe(2);
    expect(run(outside, outside).status).toBe(2);
    const missing = run(join(scratch, 'not-mounted'));
    expect(missing.status).toBe(1);
    expect(missing.out).toContain('is not an existing folder (it is never created');
    const inRepo = run(join(ROOT, 'scripts'));
    expect(inRepo.status).toBe(1);
    expect(inRepo.out).toContain('is inside this repository');
    const otherTree = run(repo);
    expect(otherTree.status).toBe(1);
    expect(otherTree.out).toContain('is inside the git working tree of');
    for (const r of [missing, inRepo, otherTree]) expect(r.out).not.toContain('== export');
    expect(readFileSync(log, 'utf8')).toBe('');
  });

  it('a dry run names the dated file it would write and writes nothing', () => {
    writeFileSync(log, '');
    for (const r of [run('--dry-run', outside), (() => { const x = spawnSync('bash', [EXPORT, outside], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DRY_RUN: '1' } }); return { status: x.status, out: x.stdout }; })()]) {
      expect(r.status, r.out).toBe(0);
      expect(r.out).toMatch(/dry run, not run: npx wrangler d1 export namada-trade-db --remote --skip-confirmation --output=.* then gzip -9 to .*\/namada-trade-db-\d{4}-\d{2}-\d{2}T\d{4}Z\.sql\.gz \(mode 600\)/);
    }
    expect(readdirSync(outside)).toEqual([]);
    expect(readFileSync(log, 'utf8')).toBe('');
  });

  it('the export answers wrangler\'s prompt, drops the line carrying the download link and keeps the copy private', () => {
    const src = readFileSync(EXPORT, 'utf8');
    expect(src).toContain(`npx wrangler d1 export namada-trade-db --remote --skip-confirmation --output="$part" 2>&1 | sed '/following URL manually/d'`);
    expect(src.indexOf('umask 077')).toBeLessThan(src.indexOf('npx wrangler d1 export'));
    expect(src).toContain('chmod 600 "$out"');
  });
});
