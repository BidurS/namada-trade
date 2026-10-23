import type { Flow, Move } from '../../shared/types';
import type { BalanceUpdate } from './parse/namada';
import { toNam, boundFlowText } from './util';

export interface Stmt { sql: string; params: unknown[] }

/** The most tags one wallet may hold (each address once; editing one's own tag is not counted). */
export const TAGS_PER_AUTHOR = 200;
/** The most new tags the site takes in 24 h, by first write: too few to deface the holder list, enough for real use. */
export const TAGS_PER_DAY = 500;
/** A wallet's other tags, on labels_user_author (migration 0010), counted to the cap at most. */
const OWN_TAGS = (author: string, address: string) =>
  `(SELECT COUNT(*) FROM (SELECT 1 FROM labels INDEXED BY labels_user_author WHERE source = 'user' AND author = ${author} AND address != ${address} LIMIT ${TAGS_PER_AUTHOR}))`;
/** The site's other new tags in the 24 h before `at`, by first write, on labels_user_created (migration 0010). */
const DAY_TAGS = (at: string, address: string) =>
  `(SELECT COUNT(*) FROM (SELECT 1 FROM labels INDEXED BY labels_user_created WHERE source = 'user' AND created_at > ${at} - 86400000 AND address != ${address} LIMIT ${TAGS_PER_DAY}))`;

export const stmt = {
  move: (m: Move): Stmt => ({
    sql: 'INSERT OR IGNORE INTO moves (chain,address,height,ts,tx_hash,idx,delta_num) VALUES (?,?,?,?,?,?,?)',
    params: [m.chain, m.address, m.height, m.ts, m.txHash, m.idx, m.delta],
  }),
  /** A flow row, with its senders' text bounded whichever writer gives it (util.ts boundFlowText; the parsers bound it too). */
  flow: (given: Flow): Stmt => {
    const f = boundFlowText(given);
    return {
      sql: `INSERT OR REPLACE INTO flows (id,chain,height,ts,tx_hash,kind,from_addr,to_addr,amount_num,counter_denom,counter_amount,pool_id,price_usd,value_usd,meta)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      params: [
        f.id, f.chain, f.height, f.ts, f.txHash, f.kind, f.from, f.to, f.amount,
        f.counterDenom ?? null, f.counterAmount ?? null, f.poolId ?? null,
        f.priceUsd ?? null, f.valueUsd ?? null, f.meta ? JSON.stringify(f.meta) : null,
      ],
    };
  },
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
  /**
   * stmt.link for the live writes (live-hub.ts), which may write a block or a transaction again (a scan cursor moved
   * back, a catch-up search that finds a stream transaction): the link is counted only while the flow it came from
   * (`flowId`, one flow per link) is not stored yet. It goes before that flow's own statement in the same batch, so a
   * write that stores the flow counts its link once, and a write of it again never does. Plain ? placeholders, as
   * scripts inline statements with inlineSql.
   */
  linkOnce: (l: { osmo: string; namada: string; amount: number; ts: number; flowId: string }): Stmt => ({
    sql: `INSERT INTO address_links (osmo_addr,namada_addr,first_seen,last_seen,transfers,volume_num)
          SELECT ?,?,?,?,1,? WHERE NOT EXISTS (SELECT 1 FROM flows WHERE id = ?)
          ON CONFLICT(osmo_addr,namada_addr) DO UPDATE SET
            last_seen=MAX(address_links.last_seen, excluded.last_seen),
            first_seen=MIN(address_links.first_seen, excluded.first_seen),
            transfers=address_links.transfers+1,
            volume_num=address_links.volume_num+excluded.volume_num`,
    params: [l.osmo, l.namada, l.ts, l.ts, l.amount, l.flowId],
  }),
  /**
   * A curated label (auto, genesis, valopers). It never replaces a user tag, except a pool label: the quote service
   * listing the address as a NAM pool is the proof, the holder list leaves pools out by this row's category alone
   * (holders.ts notPool, LISTED), and a pool's address can be tagged before its first label is written, so a tag
   * written first must give way (security review, 2026-10-22). The tag's author goes with it.
   */
  label: (address: string, chain: string, label: string, category: string, source: string, note: string | null, at: number): Stmt => ({
    sql: `INSERT INTO labels (address,chain,label,category,source,note,updated_at) VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(address) DO UPDATE SET label=excluded.label, category=excluded.category,
            source=excluded.source, note=excluded.note, updated_at=excluded.updated_at, author=NULL
          WHERE labels.source != 'user' OR excluded.category = 'pool'`,
    params: [address, chain, label, category, source, note, at],
  }),
  /**
   * A label from the genesis file (scripts/genesis-labels.ts). It lands on an address without a label or replaces an
   * earlier genesis label; it never replaces a protocol, pool, validator or user label, so the comment text of a
   * third-party file cannot rename an account another source named (security review, 2026-10-22).
   */
  genesisLabel: (address: string, label: string, category: string, note: string | null, at: number): Stmt => ({
    sql: `INSERT INTO labels (address,chain,label,category,source,note,updated_at) VALUES (?,'namada',?,?,'genesis',?,?)
          ON CONFLICT(address) DO UPDATE SET label=excluded.label, category=excluded.category,
            note=excluded.note, updated_at=excluded.updated_at
          WHERE labels.source = 'genesis'`,
    params: [address, label, category, note, at],
  }),
  /**
   * A tag a signed-in wallet writes. It lands on an address without a label, or replaces a tag the same wallet
   * wrote; it never replaces a curated label or another wallet's tag (the route answers 409 when nothing changed).
   * A new tag is admitted in the same statement only while the wallet holds fewer than TAGS_PER_AUTHOR tags and the
   * site took fewer than TAGS_PER_DAY new ones (by first write, created_at) in the last 24 h: D1 runs one statement at
   * a time, so concurrent posts cannot pass the caps together, and a count that fails fails the write. Editing one's
   * own tag is never counted and keeps its created_at, so a re-save never renews a tag's place in the day.
   */
  userTag: (address: string, chain: string, label: string, category: string, author: string, note: string | null, at: number): Stmt => ({
    sql: `INSERT INTO labels (address,chain,label,category,source,note,updated_at,author,created_at)
          SELECT ?1,?2,?3,?4,'user',?5,?6,?7,?6
          WHERE EXISTS (SELECT 1 FROM labels WHERE address = ?1 AND source = 'user' AND author = ?7)
             OR (${OWN_TAGS('?7', '?1')} < ${TAGS_PER_AUTHOR} AND ${DAY_TAGS('?6', '?1')} < ${TAGS_PER_DAY})
          ON CONFLICT(address) DO UPDATE SET label=excluded.label, category=excluded.category, note=excluded.note,
            updated_at=excluded.updated_at
          WHERE labels.source = 'user' AND labels.author = excluded.author`,
    params: [address, chain, label, category, note, at, author],
  }),
  /** Why userTag changed nothing: the address's row, and the two caps as the insert counted them (only to word the answer). */
  userTagRefusal: (address: string, author: string, at: number): Stmt => ({
    sql: `SELECT (SELECT source FROM labels WHERE address = ?1) source, (SELECT author FROM labels WHERE address = ?1) author,
            ${OWN_TAGS('?2', '?1')} own, ${DAY_TAGS('?3', '?1')} today`,
    params: [address, author, at],
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
  /**
   * Stakes rows stamped from a height above `ceiling` (cron.ts heightCeiling: past the head this tick's answers agree
   * on, never set without one) are re-stamped at the bond listing's `height`, so the guard above takes the listing's
   * rows again (as holders.ts listingUnpinStmts for the balances). 98 addresses a statement.
   */
  stakesUnpin: (addresses: string[], height: number, ceiling: number): Stmt[] => {
    const out: Stmt[] = [];
    for (let i = 0; i < addresses.length; i += 98) {
      const part = addresses.slice(i, i + 98);
      out.push({
        sql: `UPDATE stakes SET verified_height = ?1 WHERE verified_height > ?2 AND address IN (${part.map(() => '?').join(',')})`,
        params: [height, ceiling, ...part],
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
  // A line break is written as a concatenation SQLite evaluates to the same bytes, so each generated statement stays on
  // one line for a reader of the file (scripts/d1-apply.ts reads quoted strings whole, line breaks and all).
  return `(${s.split(/(\r|\n)/).filter(Boolean).map((p) => (p === '\n' ? 'char(10)' : p === '\r' ? 'char(13)' : `'${p}'`)).join(' || ')})`;
}
