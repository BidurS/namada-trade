// Security review (2026-10-22), copies of the production database: a user's sealed settings in a copy of the kv
// table open with the production SETTINGS_KEY and with no other key, and the copy outlives the user's delete in the
// bound database. So the key decides who can read an export: the README keeps the production key out of .dev.vars
// and out of files, its export step leaves kv out and writes into a git-ignored folder, and a database copy at the
// repo root or in SQLite form cannot be committed by accident, while new migrations and scripts stay tracked.
//
// Security review (2026-10-22), the copies the ignore rules still let through: every SQL file in scripts/ and
// migrations/ was re-included, so an export written there (scripts/backup.sql) could be committed, and *.db,
// *.sqlite3 and their journals, the sqlite3 command's usual names, were not ignored. Now only the tracked SQL files and
// numbered migrations are re-included, and those names are ignored. The README's copy took eight tables, so a local
// real-data run showed empty series and no unbond queue; it now takes every table the migrations create but kv.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { testD1, insert } from './d1-sqlite';
import { allDeliverable, defaultPrefs, deleteSettings, saveSettings } from '../worker/src/settings';

const ROOT = join(__dirname, '..');
const PROD_KEY = Buffer.alloc(32, 1).toString('base64');
const DEV_KEY = Buffer.alloc(32, 2).toString('base64');
const HOOK = 'https://discord.com/api/webhooks/1/dummy';

const inGit = (() => {
  try { return execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: ROOT, encoding: 'utf8' }).trim() === 'true'; } catch { return false; }
})();

/** Whether the repo's ignore rules exclude a path, whether or not it exists or is tracked. */
function ignored(path: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', '--no-index', path], { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch (e: any) {
    if (e.status === 1) return false;
    throw e;
  }
}

const readme = () => readFileSync(join(ROOT, 'README.md'), 'utf8');

describe('a copy of the production database', () => {
  it('opens with the same key only, and outlives the delete in the bound database', async () => {
    const prod = testD1();
    await saveSettings(prod as any, PROD_KEY, { address: 'tnam1qdummy', notifications: defaultPrefs(), channels: { discord: { enabled: true, webhookUrl: HOOK } }, createdAt: 1, updatedAt: 1 });
    const row = await prod.prepare("SELECT key, value, updated_at FROM kv WHERE key = 'user:tnam1qdummy'").first();
    expect(String(row.value)).not.toContain(HOOK);
    const copy = testD1();
    insert(copy, 'kv', [row]);

    expect((await allDeliverable(copy as any, PROD_KEY)).map((s) => s.channels.discord.webhookUrl)).toEqual([HOOK]);
    expect(await allDeliverable(copy as any, DEV_KEY)).toEqual([]);

    await deleteSettings(prod as any, 'tnam1qdummy');
    expect(await allDeliverable(prod as any, PROD_KEY)).toEqual([]);
    expect(await allDeliverable(copy as any, PROD_KEY)).toHaveLength(1);
  });

  it.skipIf(!inGit)('cannot be committed from the repo root or as SQLite; migrations and scripts stay tracked', () => {
    for (const p of ['backup.sql', 'prod-2026-10-22.sql', 'docs/backup.sql', 'scripts/out/backup/public-2026-10-22.sql', 'prod.sqlite', 'prod.sqlite-wal', '.wrangler/state/v3/d1/x.sqlite', '.dev.vars']) {
      expect(ignored(p), p).toBe(true);
    }
    for (const p of ['migrations/0099_next.sql', 'scripts/rebuild-address-links.sql', 'scripts/repair-pos-balance.sql', 'migrations/0001_init.sql', 'README.md']) {
      expect(ignored(p), p).toBe(false);
    }
  });

  it.skipIf(!inGit)('cannot be committed beside the tracked SQL, or under the other SQLite names', () => {
    for (const p of [
      'scripts/backup.sql', 'scripts/prod-2026-10-23.sql', 'scripts/next.sql', 'migrations/backup.sql', 'migrations/0012.sql', 'migrations/old/0001_init.sql',
      'prod.db', 'prod.db-wal', 'prod.db-shm', 'prod.db-journal', 'prod.sqlite3', 'prod.sqlite3-wal', 'prod.sqlite3-journal', 'docs/prod.db',
    ]) {
      expect(ignored(p), p).toBe(true);
    }
    // No tracked file is ignored: every migration, both repair files and everything else stay as they are.
    expect(execFileSync('git', ['ls-files', '-ci', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' })).toBe('');
    const sql = execFileSync('git', ['ls-files', '*.sql'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
    expect(sql).toContain('scripts/rebuild-address-links.sql');
    expect(sql.filter((p) => p.startsWith('migrations/')).length).toBeGreaterThanOrEqual(11);
    for (const p of sql) expect(ignored(p), p).toBe(false);
  });

  it('README copies every table the migrations create but kv', () => {
    const created = new Set<string>();
    for (const f of readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql'))) {
      for (const m of readFileSync(join(ROOT, 'migrations', f), 'utf8').matchAll(/CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`[]?(\w+)/gi)) created.add(m[1]);
      for (const m of readFileSync(join(ROOT, 'migrations', f), 'utf8').matchAll(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?["`[]?(\w+)/gi)) created.delete(m[1]);
    }
    expect(created).toContain('kv');
    expect(created).toContain('unbond_queue');
    const cmds = readme().match(/wrangler d1 export [^`]*/g) ?? [];
    expect(cmds.length).toBeGreaterThan(0);
    for (const c of cmds) {
      const tables = new Set([...c.matchAll(/--table[= ](\S+)/g)].map((m) => m[1]));
      expect([...created].filter((t) => t !== 'kv' && !tables.has(t)).sort(), c).toEqual([]);
      expect([...tables].filter((t) => !created.has(t)), c).toEqual([]);
    }
  });

  it.skipIf(!inGit)('README exports the public tables only, into a git-ignored folder', () => {
    const cmds = readme().match(/wrangler d1 export [^`]*/g) ?? [];
    expect(cmds.length).toBeGreaterThan(0);
    for (const c of cmds) {
      const tables = [...c.matchAll(/--table[= ](\S+)/g)].map((m) => m[1]);
      expect(tables.length, c).toBeGreaterThan(0);
      expect(tables, c).not.toContain('kv');
      const out = c.match(/--output[= ](\S+)/)?.[1];
      expect(out, c).toBeTruthy();
      expect(ignored(out!.replace('$(date +%F)', '2026-10-22')), c).toBe(true);
    }
  });

  it('README keeps the production SETTINGS_KEY out of .dev.vars and out of files', () => {
    const r = readme();
    expect(/also in `\.dev\.vars`/.test(r), 'the production key is said to be in .dev.vars').toBe(false);
    expect(/\| npx wrangler secret put SETTINGS_KEY/.test(r), 'the production key is piped into the secret').toBe(true);
    expect(/`\.dev\.vars` holds a development key of its own, never the production one/.test(r), '.dev.vars has its own key').toBe(true);
  });
});
