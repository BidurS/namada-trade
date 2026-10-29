// A D1Database stand-in over Node's built-in SQLite, with the real migrations applied, so the Worker's SQL
// runs in tests exactly as written. Only the calls the Worker uses: prepare/bind/first/all/run and batch.
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// `node:sqlite` is loaded at run time: Vite's resolver does not know the module.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path: string) => any };

const MIGRATIONS = join(__dirname, '..', 'migrations');

const val = (v: unknown) => (typeof v === 'boolean' ? (v ? 1 : 0) : v === undefined ? null : v);
const plain = (r: any) => (r == null ? null : { ...r });

class Stmt {
  constructor(private db: any, readonly sql: string, private params: unknown[] = []) {}
  bind(...p: unknown[]) {
    // D1 refuses a query with more than 100 bound parameters; so does the stand-in.
    if (p.length > 100) throw new Error(`D1: too many bound parameters (${p.length} > 100)`);
    return new Stmt(this.db, this.sql, p.map(val));
  }
  async first<T = any>(col?: string): Promise<T | null> {
    const r = this.db.prepare(this.sql).get(...this.params);
    if (r == null) return null;
    return (col ? r[col] : plain(r)) as T;
  }
  async all<T = any>(): Promise<{ results: T[]; success: true }> {
    return { results: this.db.prepare(this.sql).all(...this.params).map(plain), success: true };
  }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: Number(r.changes) } };
  }
  runSync() { return this.db.prepare(this.sql).run(...this.params); }
  /** As D1's batch answers a statement: a query's rows in `results`, a write's changes in `meta`. */
  batchSync(): { success: true; results?: unknown[]; meta: { changes: number } } {
    const st = this.db.prepare(this.sql);
    if (/^\s*(SELECT|WITH)\b/i.test(this.sql)) return { success: true, results: st.all(...this.params).map(plain), meta: { changes: 0 } };
    return { success: true, meta: { changes: Number(st.run(...this.params).changes) } };
  }
}

export interface TestD1 {
  prepare(sql: string): Stmt;
  batch(stmts: Stmt[]): Promise<{ success: true; meta: { changes: number } }[]>;
  exec(sql: string): void;
  /** count of prepare() calls, to check how many queries a code path makes */
  queries: number;
  raw: any;
}

export function testD1(): TestD1 {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) db.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  const d1: TestD1 = {
    queries: 0,
    raw: db,
    prepare(sql: string) { d1.queries++; return new Stmt(db, sql); },
    async batch(stmts: Stmt[]) {
      db.exec('BEGIN');
      const out: { success: true; results?: unknown[]; meta: { changes: number } }[] = [];
      try {
        for (const s of stmts) out.push(s.batchSync());
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      return out;
    },
    exec(sql: string) { db.exec(sql); },
  };
  return d1;
}

/**
 * testD1 with D1's own parameter path: the binding sends bound parameters as JSON (the Worker runs without the
 * d1_binding_jsrpc flag), so a number that is not finite arrives as NULL and fails a NOT NULL column for the whole batch.
 * A job whose figures must be finite or NULL is run through this (test/osmosis-hourly-finite.test.ts, test/depth-minute.test.ts).
 */
export function d1Json(): TestD1 {
  const db = testD1();
  const prepare = db.prepare.bind(db);
  (db as any).prepare = (sql: string) => {
    const s: any = prepare(sql);
    const bind = s.bind.bind(s);
    s.bind = (...p: unknown[]) => bind(...JSON.parse(JSON.stringify(p)));
    return s;
  };
  return db;
}

/** Insert rows into a table from plain objects. */
export function insert(d1: TestD1, table: string, rows: Record<string, unknown>[]) {
  for (const r of rows) {
    const cols = Object.keys(r);
    d1.raw.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => val(r[c])));
  }
}

/** Run a Worker statement list ({ sql, params }) against the stand-in, as runBatch would. */
export async function runStmts(d1: TestD1, stmts: { sql: string; params: unknown[] }[]) {
  await d1.batch(stmts.map((s) => d1.prepare(s.sql).bind(...s.params)));
}
