/**
 * A read-only D1Database for scripts that run the Worker's own readers against the production database: every
 * statement goes through `wrangler d1 execute namada-trade-db --remote --json --command` (the call scripts/lib.ts d1()
 * makes, kept here with D1's meta so the rows read can be counted), and anything that is not a read is refused before
 * it is sent. A statement must begin with SELECT, WITH or EXPLAIN QUERY PLAN (after comments and whitespace), hold
 * no writing keyword outside its string literals, and be one statement; bound parameters are written in only as
 * finite numbers or single-quoted strings with their quotes doubled, and any other value is refused. D1's 7403 answer
 * (and a call that does not come back) is asked again after a pause, as the repo's other scripts do.
 */
import { execFile } from 'node:child_process';

/** One statement as SQLite tokenizes it: the text outside string literals, quoted identifiers and comments (each
 *  literal kept as an empty pair of quotes), and the positions of its parameters. */
export interface Scanned { bare: string; params: { start: number; end: number; index: number | null; named: boolean }[] }

export function scan(sql: string): Scanned {
  let bare = '';
  const params: Scanned['params'] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === '`') {
      // a quoted string or identifier: a doubled quote is the quote itself
      let j = i + 1;
      while (j < sql.length) { if (sql[j] === c) { if (sql[j + 1] === c) { j += 2; continue; } break; } j++; }
      if (j >= sql.length) throw new Error('refused: an unterminated quote');
      bare += c === "'" ? "''" : '""';
      i = j + 1;
    } else if (c === '-' && sql[i + 1] === '-') {
      const j = sql.indexOf('\n', i);
      bare += ' ';
      i = j < 0 ? sql.length : j + 1;
    } else if (c === '/' && sql[i + 1] === '*') {
      const j = sql.indexOf('*/', i + 2);
      if (j < 0) throw new Error('refused: an unterminated comment');
      bare += ' ';
      i = j + 2;
    } else if (c === '?') {
      let j = i + 1;
      while (j < sql.length && /[0-9]/.test(sql[j])) j++;
      params.push({ start: i, end: j, index: j > i + 1 ? Number(sql.slice(i + 1, j)) : null, named: false });
      bare += '?';
      i = j;
    } else if ((c === ':' || c === '@' || c === '$') && /[A-Za-z_]/.test(sql[i + 1] ?? '')) {
      params.push({ start: i, end: i + 1, index: null, named: true });
      bare += c;
      i++;
    } else {
      bare += c;
      i++;
    }
  }
  return { bare, params };
}

/** Keywords that write or change the database; matched outside literals only ("updated_at" is not "UPDATE"). */
const WRITES = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX|ANALYZE|REPLACE\s+INTO)\b/i;

/** The statement with its parameters written in, or an error when it is not a read or a value is not a number or a string. */
export function inline(sql: string, values: unknown[]): string {
  const s = scan(sql);
  const lead = s.bare.trimStart();
  if (!/^(SELECT|WITH|EXPLAIN\s+QUERY\s+PLAN)\b/i.test(lead)) throw new Error(`refused: not a SELECT, WITH or EXPLAIN QUERY PLAN (${lead.slice(0, 30)})`);
  const w = WRITES.exec(s.bare);
  if (w) throw new Error(`refused: the statement holds ${w[1].toUpperCase()}`);
  if (/;\s*\S/.test(s.bare)) throw new Error('refused: more than one statement');
  if (s.params.some((p) => p.named)) throw new Error('refused: a named parameter');
  // SQLite's numbering: ?NNN is parameter NNN, a bare ? the next after the largest so far
  let max = 0;
  const idx = s.params.map((p) => { const n = p.index ?? max + 1; max = Math.max(max, n); return n; });
  if (max !== values.length) throw new Error(`refused: ${values.length} values bound to ${max} parameters`);
  const lit = (v: unknown): string => {
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new Error('refused: a number that is not finite');
      return v < 0 ? `(${String(v)})` : String(v);
    }
    if (typeof v === 'string') return `'${v.replace(/'/g, "''")}'`;
    throw new Error(`refused: a ${v === null ? 'null' : typeof v} parameter`);
  };
  let out = '';
  let at = 0;
  s.params.forEach((p, k) => { out += sql.slice(at, p.start) + lit(values[idx[k] - 1]); at = p.end; });
  return (out + sql.slice(at)).replace(/\s+/g, ' ').trim();
}

/** One statement as it ran: its text, the rows it gave, D1's rows read, the time, and the tries (0: refused or failed). */
export interface Ran { sql: string; rows: number; rowsRead: number | null; ms: number; tries: number; error?: string }

/** How a statement is run: the default sends it to production through wrangler; a test passes its own. */
export type Runner = (sql: string) => Promise<string>;

export const wranglerRunner = (cwd: string): Runner => (sql) => new Promise((res, rej) => {
  execFile('npx', ['wrangler', 'd1', 'execute', 'namada-trade-db', '--remote', '--json', '--command', sql], { cwd, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 }, (err, stdout) => {
    if (err && !stdout) rej(err); else res(stdout);
  });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A read-only D1Database over `run`, with every statement it ran (or refused) listed in `ran`. */
export function readOnlyD1(run: Runner, opts: { slots?: number; pauseMs?: number; tries?: number } = {}): { db: D1Database; ran: Ran[] } {
  const ran: Ran[] = [];
  const slots = opts.slots ?? 3, pause = opts.pauseMs ?? 3000, tries = opts.tries ?? 6;
  // a few calls at a time keep the run short without bursting D1
  let busy = 0;
  const waiting: (() => void)[] = [];
  const slot = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (busy >= slots) await new Promise<void>((r) => waiting.push(r));
    busy++;
    try { return await fn(); } finally { busy--; waiting.shift()?.(); }
  };
  const query = (sql: string) => slot(async () => {
    const t0 = Date.now();
    let last = '';
    for (let n = 1; n <= tries; n++) {
      let out: string;
      try { out = await run(sql); } catch (e) { last = String((e as Error).message ?? e).slice(0, 200); await sleep(pause * n); continue; }
      let j: any;
      try { j = JSON.parse(out); } catch { last = `not JSON: ${out.slice(0, 120)}`; await sleep(pause * n); continue; }
      if (Array.isArray(j) && j[0]?.results) {
        const meta = (j[0].meta ?? {}) as Record<string, unknown>;
        const results = j[0].results as Record<string, unknown>[];
        ran.push({ sql, rows: results.length, rowsRead: Number.isFinite(Number(meta.rows_read)) ? Number(meta.rows_read) : null, ms: Date.now() - t0, tries: n });
        return { results, meta };
      }
      last = `${j?.error?.text ?? 'error'}${j?.error?.notes?.length ? ` (${j.error.notes.map((x: any) => x.text).join('; ')})` : ''}`;
      if (j?.error?.code === 7403) { await sleep(pause * n); continue; }
      break;
    }
    ran.push({ sql, rows: 0, rowsRead: null, ms: Date.now() - t0, tries: 0, error: last });
    throw new Error(`D1: ${last}`);
  });

  class Statement {
    constructor(readonly sql: string, readonly values: unknown[] = []) {}
    bind(...values: unknown[]) { return new Statement(this.sql, values); }
    async all() {
      let sql: string;
      try { sql = inline(this.sql, this.values); } catch (e) {
        // a refused statement is never sent; it is listed with the reason, and the reader's section says not read
        ran.push({ sql: this.sql.replace(/\s+/g, ' ').trim(), rows: 0, rowsRead: null, ms: 0, tries: 0, error: String((e as Error).message) });
        throw e;
      }
      const r = await query(sql);
      return { results: r.results, success: true as const, meta: r.meta };
    }
    async first(col?: string) { const r = (await this.all()).results[0] ?? null; return r == null ? null : col ? (r as Record<string, unknown>)[col] ?? null : r; }
    async raw() { return (await this.all()).results.map((r) => Object.values(r)); }
    async run(): Promise<never> { throw new Error('refused: run() writes; this database reads only'); }
  }

  const db = {
    prepare: (sql: string) => new Statement(sql),
    // a D1 batch, run statement by statement in order (a failure fails the batch, as D1's does)
    async batch(stmts: Statement[]) {
      const out = [];
      for (const s of stmts) out.push(await s.all());
      return out;
    },
    async exec(): Promise<never> { throw new Error('refused: exec() is not a read'); },
    async dump(): Promise<never> { throw new Error('refused: dump() is not offered'); },
  } as unknown as D1Database;
  return { db, ran };
}
