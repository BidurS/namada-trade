import type { Flow, Move } from '../../shared/types';
import type { BalanceUpdate } from './parse/namada';
import { toNam } from './util';

export interface Stmt { sql: string; params: unknown[] }

export const stmt = {
  move: (m: Move): Stmt => ({
    sql: 'INSERT OR IGNORE INTO moves (chain,address,height,ts,tx_hash,idx,delta_num) VALUES (?,?,?,?,?,?,?)',
    params: [m.chain, m.address, m.height, m.ts, m.txHash, m.idx, m.delta],
  }),
  flow: (f: Flow): Stmt => ({
    sql: `INSERT OR REPLACE INTO flows (id,chain,height,ts,tx_hash,kind,from_addr,to_addr,amount_num,counter_denom,counter_amount,pool_id,price_usd,value_usd,meta)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    params: [
      f.id, f.chain, f.height, f.ts, f.txHash, f.kind, f.from, f.to, f.amount,
      f.counterDenom ?? null, f.counterAmount ?? null, f.poolId ?? null,
      f.priceUsd ?? null, f.valueUsd ?? null, f.meta ? JSON.stringify(f.meta) : null,
    ],
  }),
  /** Namada post-balance: only overwrite if the update is newer than what we have. A new row holding NAM gets first_seen (migration 0007); an existing row keeps its own. */
  namadaBalance: (b: BalanceUpdate, at: number): Stmt => ({
    sql: `INSERT INTO holders (chain,address,balance,balance_num,updated_height,updated_at,first_seen)
          VALUES ('namada',?,?,?,?,?,?)
          ON CONFLICT(chain,address) DO UPDATE SET
            balance=excluded.balance, balance_num=excluded.balance_num,
            updated_height=excluded.updated_height, updated_at=excluded.updated_at
          WHERE excluded.updated_height >= COALESCE(holders.updated_height,0)`,
    params: [b.address, b.balance, toNam(b.balance), b.height, at, toNam(b.balance) > 0 ? at : null],
  }),
  /**
   * A balance read from the chain (or the Osmosis bank) at `at`. Monotonic: a read older than the one stored is
   * ignored, so a slower, older run can never re-stamp rows after a newer run (which would let the newer run's
   * "no longer in the list" step zero them, holders.ts osmosisDroppedStmt).
   */
  verifiedBalance: (chain: string, address: string, balance: string, height: number | null, at: number, src: string): Stmt => ({
    sql: `INSERT INTO holders (chain,address,balance,balance_num,updated_height,updated_at,verified_at,verified_src)
          VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT(chain,address) DO UPDATE SET
            balance=excluded.balance, balance_num=excluded.balance_num,
            updated_height=MAX(COALESCE(holders.updated_height,0), COALESCE(excluded.updated_height,0)),
            updated_at=excluded.updated_at, verified_at=excluded.verified_at, verified_src=excluded.verified_src
          WHERE COALESCE(excluded.verified_at, 0) >= COALESCE(holders.verified_at, 0)`,
    params: [chain, address, balance, toNam(balance), height, at, at, src],
  }),
  link: (l: { osmo: string; namada: string; amount: number; ts: number }): Stmt => ({
    sql: `INSERT INTO address_links (osmo_addr,namada_addr,first_seen,last_seen,transfers,volume_num)
          VALUES (?,?,?,?,1,?)
          ON CONFLICT(osmo_addr,namada_addr) DO UPDATE SET
            last_seen=MAX(address_links.last_seen, excluded.last_seen),
            first_seen=MIN(address_links.first_seen, excluded.first_seen),
            transfers=address_links.transfers+1,
            volume_num=address_links.volume_num+excluded.volume_num`,
    params: [l.osmo, l.namada, l.ts, l.ts, l.amount],
  }),
  /** A curated label (auto, genesis, valopers). Never replaces a user tag. */
  label: (address: string, chain: string, label: string, category: string, source: string, note: string | null, at: number): Stmt => ({
    sql: `INSERT INTO labels (address,chain,label,category,source,note,updated_at) VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(address) DO UPDATE SET label=excluded.label, category=excluded.category,
            source=excluded.source, note=excluded.note, updated_at=excluded.updated_at
          WHERE labels.source != 'user'`,
    params: [address, chain, label, category, source, note, at],
  }),
  /**
   * A tag a signed-in wallet writes. It lands on an address without a label, or replaces a tag the same wallet
   * wrote; it never replaces a curated label or another wallet's tag (the route answers 409 when nothing changed).
   */
  userTag: (address: string, chain: string, label: string, category: string, author: string, note: string | null, at: number): Stmt => ({
    sql: `INSERT INTO labels (address,chain,label,category,source,note,updated_at,author) VALUES (?,?,?,?,'user',?,?,?)
          ON CONFLICT(address) DO UPDATE SET label=excluded.label, category=excluded.category, note=excluded.note,
            updated_at=excluded.updated_at
          WHERE labels.source = 'user' AND labels.author = excluded.author`,
    params: [address, chain, label, category, note, at, author],
  }),
  kvSet: (key: string, value: string, at: number): Stmt => ({
    sql: 'INSERT OR REPLACE INTO kv (key,value,updated_at) VALUES (?,?,?)',
    params: [key, value, at],
  }),
  /**
   * Stakes rows the bond listing writes: several rows a statement (8 parameters a row, 12 rows a statement: D1
   * binds at most 100). Guarded by height: a row written from a later chain height (`verified_height`, migration
   * 0006) is never overwritten by an older answer, so a slow node's listing cannot undo a newer one (as
   * listingBalanceStmts for the balances). The gate (cron.ts heightGate) refuses an answer whose height is not one,
   * so a stored height is always a height.
   */
  stakesVerified: (rows: { address: string; bondedNam: number; delegations: unknown }[], epoch: number, height: number, at: number, src: string): Stmt[] => {
    const out: Stmt[] = [];
    for (let i = 0; i < rows.length; i += 12) {
      const part = rows.slice(i, i + 12);
      out.push({
        sql: `INSERT INTO stakes (address,bonded_num,delegations,verified_at,verified_epoch,verified_height,verified_src,updated_at) VALUES ${part.map(() => '(?,?,?,?,?,?,?,?)').join(',')}
          ON CONFLICT(address) DO UPDATE SET bonded_num=excluded.bonded_num, delegations=excluded.delegations,
            verified_at=excluded.verified_at, verified_epoch=excluded.verified_epoch, verified_height=excluded.verified_height, verified_src=excluded.verified_src, updated_at=excluded.updated_at
          WHERE excluded.verified_height >= COALESCE(stakes.verified_height, 0)`,
        params: part.flatMap((r) => [r.address, r.bondedNam, JSON.stringify(r.delegations), at, epoch, height, src, at]),
      });
    }
    return out;
  },
  metric: (ts: number, key: string, value: number): Stmt => ({
    sql: 'INSERT OR REPLACE INTO metrics (ts,key,value) VALUES (?,?,?)',
    params: [ts, key, value],
  }),
  check: (key: string, status: string, title: string, detail: unknown, at: number): Stmt => ({
    sql: 'INSERT OR REPLACE INTO checks (key,status,title,detail,checked_at) VALUES (?,?,?,?,?)',
    params: [key, status, title, JSON.stringify(detail), at],
  }),
};

/** Execute statements in D1 batches (D1 batch is atomic per call). Returns how many rows they changed. */
export async function runBatch(db: D1Database, stmts: Stmt[], size = 80): Promise<number> {
  let changes = 0;
  for (let i = 0; i < stmts.length; i += size) {
    const slice = stmts.slice(i, i + size);
    const res = await db.batch(slice.map((s) => db.prepare(s.sql).bind(...s.params)));
    for (const r of res ?? []) changes += Number((r as { meta?: { changes?: number } })?.meta?.changes ?? 0);
  }
  return changes;
}

export async function kvGet(db: D1Database, key: string): Promise<string | null> {
  const r = await db.prepare('SELECT value FROM kv WHERE key=?').bind(key).first<{ value: string }>();
  return r?.value ?? null;
}

export async function kvGetJson<T>(db: D1Database, key: string): Promise<T | null> {
  const v = await kvGet(db, key);
  if (!v) return null;
  try { return JSON.parse(v) as T; } catch { return null; }
}

export async function kvSet(db: D1Database, key: string, value: unknown): Promise<void> {
  const s = stmt.kvSet(key, typeof value === 'string' ? value : JSON.stringify(value), Date.now());
  await db.prepare(s.sql).bind(...s.params).run();
}

/** Inline params into SQL text (for offline .sql file generation in backfill scripts). */
export function inlineSql(s: Stmt): string {
  let i = 0;
  const sql = s.sql.replace(/\s+/g, ' ').replace(/\?/g, () => lit(s.params[i++]));
  return sql.trim() + ';';
}

function lit(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'boolean') return v ? '1' : '0';
  const s = String(v).replace(/'/g, "''");
  if (!/[\r\n]/.test(s)) return `'${s}'`;
  // A line break inside a literal would split the generated .sql file (scripts/d1-apply.ts splits on ";\n"), so the
  // value is written as a concatenation SQLite evaluates to the same bytes: nothing stored is changed.
  return `(${s.split(/(\r|\n)/).filter(Boolean).map((p) => (p === '\n' ? 'char(10)' : p === '\r' ? 'char(13)' : `'${p}'`)).join(' || ')})`;
}
