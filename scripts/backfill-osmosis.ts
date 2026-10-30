/**
 * The Osmosis history against the database: every transaction of the NAM queries and of each NAM pool's address the
 * chain holds over a range of heights, which of them the database stores, and which it lacks, with their hashes. Reads
 * the remote D1 with read-only SELECTs (scripts/d1-readonly.ts) and the public Osmosis node's deep index
 * (scripts/osmosis-pager.ts). Without --dry-run it also writes the SQL that stores what is missing, for the owner to
 * check and apply (scripts/d1-apply.ts); it writes nothing to the database itself.
 *
 *   npx tsx scripts/backfill-osmosis.ts --dry-run --from <height|YYYY-MM-DD> --to <height|YYYY-MM-DD> [--pools 3005,3008]
 *     # prints the report; writes no SQL
 *   npx tsx scripts/backfill-osmosis.ts --from <height|date> --to <height|date> [--pools ...] [--mark 2026-10-30]
 *     # scripts/out/repair/osmosis-history-NNNN.sql, osmosis-history.tsv (each transaction written) and
 *     # osmosis-history.txt (the report)
 *   [--fresh]  # read the chain again from the start, not from the progress a stopped run of the same range kept
 *
 * A date is the first block at or after 00:00 UTC that day; --to <date> ends just before it, so
 * `--from 2026-08-10 --to 2026-10-21` reads 10 Aug to the end of 20 Oct. A range is clamped to the oldest NAM
 * transfer the node holds (no reachable node holds blocks before 2026-08-10).
 *
 * The queries: the stream's four (worker/src/sources/osmosis.ts OSMOSIS_QUERIES: pool 3005's swaps, NAM transfers,
 * the NAM channel's packets both ways) and, for each NAM pool the Osmosis router lists now (`--pools` keeps some), its
 * address as a transfer's sender and as its recipient (osmosisPoolQueries; a CosmWasm pool's address is its contract,
 * so pool 3008's are its order book's). These last find what moves only a pool's other coin (a bid on the 3008 order
 * book, a USDC-only position withdrawal), which matches none of the four. Each query is read oldest first from the deep
 * index; a read that keeps failing stops the run with an error, so a query is never cut short in silence (the history
 * before 2026-10-21 lacked at least 350 pool transactions: this script paged newest first and left a query at its
 * first page error, osmosis-pool-completeness-2026-10-29.md). What the chain gave is kept a page at a time in
 * scripts/out/repair/osmosis-history-progress-<from>-<to>.jsonl (each transaction's hash, height and parse summary, no
 * database figure), so a run stopped part way goes on from the page it stopped at when started again with the same
 * range, pools and node; the database is read afresh each run.
 *
 * Each transaction is parsed as the live hub parses it (worker/src/parse/osmosis.ts parseOsmosisTx and poolLegsOf,
 * with the router's pool addresses), and is stored when, for each pool whose queries found it:
 * - it moves the pool's NAM: the database has its NAM move at that pool's address (moves, by tx_hash);
 * - it moves the pool's other coins (a swap's USDC or OSMO leg as much as a USDC-only withdrawal): pool_legs has its
 *   legs at that pool's address (migration 0018; before that migration is applied every such transaction is missing);
 * and, for one with NAM rows, any of its moves or flows rows is stored.
 * The database is read by tx_hash only, 90 hashes a statement, through the moves primary key (chain, tx_hash, ...),
 * flows_hash and pool_legs's primary key; the report gives each statement's rows read.
 *
 * What the writing mode writes, each missing transaction read again by its hash, at its block's time (rows marked
 * meta.restored = --mark, default today, for
 *   npx tsx scripts/rebuild-derived.ts --key restored --mark <mark>
 * which writes the trade-hours and the days they fall in again):
 * - nothing of it stored ('missing'): its flows, moves and address links as the hub writes them (the links counted
 *   only while their flow is not stored, db.ts stmt.linkOnce) and its pool legs (meta.tsSource 'block', meta.via
 *   'history repair'). A trade the parser prices at its own USDC (pool 3005) keeps that price ('execution' before the
 *   minute quotes start); every other row is priced as scripts/rederive-osmosis.ts prices a new row: the minute quote
 *   stored at most QUOTE_MATCH_MS before it ('spot', from 2026-10-15), else the nearest hourly swap price within six
 *   hours ('swap_1h'), else none ('unknown');
 * - stored in part, a pool's NAM move missing ('part'): the moves the parser gives at the addresses where none of the
 *   transaction's is stored, and its pool legs, when every move stored is one the parser gives (the same index,
 *   address and NAM to the micro unit); otherwise it is listed as stored otherwise than the parser reads it, and
 *   nothing of it is written (it needs a look);
 * - its NAM rows stored, a pool's legs in its other coins missing ('legs'): its pool legs (migration 0018 first).
 * Each transaction's statements stay in one file, and a file holds at most FILE_BYTES, which d1-apply.ts sends as one
 * command: a transaction's links never land without the flows they are counted against, so a file applied again, or
 * after a failure, counts nothing twice.
 *
 * Holders and pool labels are no longer written here: the cron keeps both (cron.ts, the Keplr holder list and the
 * router's pools each tick).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normFromTxSearch, osmoAssets, parseOsmosisTx, poolLegsOf, type OsmoCtx, type PoolLeg } from '../worker/src/parse/osmosis';
import { OSMOSIS_QUERIES, osmosisPoolQueries } from '../worker/src/sources/osmosis';
import { fetchNamPools } from '../worker/src/sources/sqs';
import { inlineSql, stmt } from '../worker/src/db';
import { OSMOSIS } from '../worker/src/config';
import { QUOTE_MATCH_MS } from '../worker/src/analytics';
import type { Flow } from '../shared/types';
import { OsmosisPager, PagerError } from './osmosis-pager';
import { readOnlyD1, wranglerRunner, type Ran } from './d1-readonly';

const H = 3_600_000;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'scripts', 'out', 'repair');
/** Queries read at once. */
const AT_ONCE = 3;
/** Hashes a database read names (D1 binds at most 100 parameters). */
const HASHES_A_READ = 90;
/** A price no quote ever has: the parser sets it where it prices at the quote (as scripts/rederive-osmosis.ts). */
const QUOTE_MARK = 7777;
/**
 * The most bytes of statements a repair file holds, each counted with 2 more as d1-apply.ts counts them: it sends a
 * file within its MAX_BYTES (90,000) as one `wrangler d1 execute --command`, one batch.
 */
export const FILE_BYTES = 85_000;
/** A stored move is the parser's when its NAM differs by less than this (delta_num is REAL). */
const SAME_NAM = 1e-6;

const log = (...a: unknown[]) => console.error(new Date().toISOString().slice(11, 19), ...a);
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const args: string[] = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };

/** One transaction as the run keeps it: where it was found and what the parser makes of it, not its events. */
export interface Seen {
  hash: string;
  height: number;
  /** The queries that found it (their index in the run's list). */
  found: Set<number>;
  flows: number;
  moves: number;
  /** NAM moved at each pool address (its moves, summed). */
  namAt: Map<string, number>;
  /** Each pool address's legs in its other coins: denom to signed base units. */
  legsAt: Map<string, Map<string, bigint>>;
}

/** What one transaction's parse gives the report. */
export function seenOf(t: any, ctx: OsmoCtx, q: number, into: Map<string, Seen>): Seen {
  const hash = String(t.hash).toUpperCase();
  const had = into.get(hash);
  if (had) { had.found.add(q); return had; }
  const norm = normFromTxSearch(t, 0);
  const p = parseOsmosisTx(norm, { ...ctx, priceUsd: null });
  const s: Seen = { hash, height: Number(t.height), found: new Set([q]), flows: p.flows.length, moves: p.moves.length, namAt: new Map(), legsAt: new Map() };
  for (const m of p.moves) if (ctx.poolAddrs.has(m.address)) s.namAt.set(m.address, (s.namAt.get(m.address) ?? 0) + m.delta);
  for (const l of poolLegsOf(norm, ctx.poolAddrs)) {
    const d = s.legsAt.get(l.address) ?? s.legsAt.set(l.address, new Map()).get(l.address)!;
    d.set(l.denom, (d.get(l.denom) ?? 0n) + BigInt(l.delta));
  }
  into.set(hash, s);
  return s;
}

/** A Seen as a line of the progress file holds it (without the queries: the line names its own). */
export const seenToJson = (s: Seen) => ({
  hash: s.hash, height: s.height, flows: s.flows, moves: s.moves,
  namAt: [...s.namAt], legsAt: [...s.legsAt].map(([a, d]) => [a, [...d].map(([denom, v]) => [denom, String(v)])]),
});
/** A progress line's transaction put back into the run's map, found by query `q`. */
export function seenFromJson(x: any, q: number, into: Map<string, Seen>) {
  const had = into.get(x.hash);
  if (had) { had.found.add(q); return; }
  into.set(x.hash, {
    hash: x.hash, height: x.height, found: new Set([q]), flows: x.flows, moves: x.moves,
    namAt: new Map(x.namAt), legsAt: new Map(x.legsAt.map(([a, d]: [string, [string, string][]]) => [a, new Map(d.map(([denom, v]) => [denom, BigInt(v)]))])),
  });
}

/**
 * The progress a stopped run of the same range, pools and deep index kept: the transactions it read, query by query,
 * and for each query the last page handed on, or that it was read whole. A file of another run is not read.
 */
export function loadProgress(text: string, head: object, into: Map<string, Seen>): { pages: Map<number, number>; done: Map<number, { inRange: number; total: number }> } | null {
  const lines = text.split('\n').filter(Boolean);
  if (!lines.length || lines[0] !== JSON.stringify(head)) return null;
  const pages = new Map<number, number>(), done = new Map<number, { inRange: number; total: number }>();
  for (const line of lines.slice(1)) {
    let x: any;
    // a run stopped while writing a line leaves it cut short: the page is read again
    try { x = JSON.parse(line); } catch { continue; }
    if (x.done) { done.set(x.q, { inRange: x.inRange, total: x.total }); continue; }
    for (const t of x.txs) seenFromJson(t, x.q, into);
    pages.set(x.q, Math.max(pages.get(x.q) ?? 0, x.page));
  }
  return { pages, done };
}

/**
 * What the database holds of the transactions: moves (each transaction's rows: address, index and NAM), flows, pool
 * legs' addresses (null: no such table).
 */
export interface Stored {
  moves: Map<string, Set<string>>;
  moveRows: Map<string, { address: string; idx: number; delta: number }[]>;
  flows: Set<string>;
  legs: Map<string, Set<string>> | null;
}

export async function storedOf(db: D1Database, hashes: string[]): Promise<Stored> {
  const out: Stored = { moves: new Map(), moveRows: new Map(), flows: new Set(), legs: null };
  const t = await db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'pool_legs'`).first<{ n: number }>();
  if (Number(t?.n) > 0) out.legs = new Map();
  const add = (m: Map<string, Set<string>>, h: string, a: string) => (m.get(h) ?? m.set(h, new Set()).get(h)!).add(a);
  for (let i = 0; i < hashes.length; i += HASHES_A_READ) {
    const part = hashes.slice(i, i + HASHES_A_READ);
    const marks = part.map(() => '?').join(',');
    const mv = await db.prepare(`SELECT tx_hash, address, idx, delta_num FROM moves WHERE chain = 'osmosis' AND tx_hash IN (${marks})`).bind(...part).all<{ tx_hash: string; address: string; idx: number; delta_num: number }>();
    for (const r of mv.results ?? []) {
      add(out.moves, r.tx_hash, r.address);
      (out.moveRows.get(r.tx_hash) ?? out.moveRows.set(r.tx_hash, []).get(r.tx_hash)!).push({ address: r.address, idx: Number(r.idx), delta: Number(r.delta_num) });
    }
    // by the hash alone: with a chain term beside it SQLite may take flows_chain_height and read every Osmosis flow
    const fl = await db.prepare(`SELECT DISTINCT tx_hash FROM flows WHERE tx_hash IN (${marks})`).bind(...part).all<{ tx_hash: string }>();
    for (const r of fl.results ?? []) out.flows.add(r.tx_hash);
    if (out.legs) {
      const lg = await db.prepare(`SELECT DISTINCT tx_hash, address FROM pool_legs WHERE chain = 'osmosis' AND tx_hash IN (${marks})`).bind(...part).all<{ tx_hash: string; address: string }>();
      for (const r of lg.results ?? []) add(out.legs, r.tx_hash, r.address);
    }
  }
  return out;
}

export interface PoolRef { id: string; address: string; pair: string }
export type Verdict = 'missing' | 'part' | 'legs';
/** Each transaction the database lacks, and how: nothing of it stored ('missing'), stored without a pool's NAM move ('part'), or its NAM rows stored and a pool's legs in its other coins missing ('legs'). */
export interface Missing { s: Seen; verdict: Verdict; pools: string[] }

/**
 * Per pool and over all: on chain, stored, and the list of what is missing. A pool's other coin is judged for every
 * transaction that moves it, a swap that moves the pool's NAM too as much as one that moves the other coin alone
 * (`other.only` counts these), so pool_legs is checked as a ledger of its own.
 */
export function judge(seen: Map<string, Seen>, stored: Stored, pools: PoolRef[], poolQueryOf: Map<number, string>) {
  const perPool = pools.map((p) => ({ pool: p, nam: { chain: 0, stored: 0 }, other: { chain: 0, stored: 0, only: 0 }, gross: 0, missingNam: 0 }));
  const byAddr = new Map(perPool.map((x) => [x.pool.address, x]));
  const missing = new Map<string, Missing>();
  const miss = (s: Seen, verdict: Verdict, pool?: string) => {
    const m = missing.get(s.hash) ?? missing.set(s.hash, { s, verdict, pools: [] }).get(s.hash)!;
    // nothing stored outranks stored in part, which outranks the legs alone
    if (verdict === 'missing' || (verdict === 'part' && m.verdict === 'legs')) m.verdict = verdict;
    if (pool && !m.pools.includes(pool)) m.pools.push(pool);
  };
  let rowsChain = 0, rowsStored = 0;
  for (const s of seen.values()) {
    const any = stored.flows.has(s.hash) || stored.moves.has(s.hash);
    const rows = s.flows > 0 || s.moves > 0;
    if (rows) {
      rowsChain++;
      if (any) rowsStored++; else miss(s, 'missing');
    }
    // by pool, not by query: one found by both of a pool's queries (a transfer in and one out) counts once
    for (const addr of new Set([...s.found].map((q) => poolQueryOf.get(q)).filter((a): a is string => !!a))) {
      const x = byAddr.get(addr);
      if (!x) continue;
      if (s.namAt.has(addr)) {
        x.nam.chain++;
        if (stored.moves.get(s.hash)?.has(addr)) x.nam.stored++;
        else { x.gross += Math.abs(s.namAt.get(addr)!); x.missingNam++; miss(s, any ? 'part' : 'missing', x.pool.id); }
      }
      if (s.legsAt.has(addr)) {
        x.other.chain++;
        if (!s.namAt.has(addr)) x.other.only++;
        if (stored.legs?.get(s.hash)?.has(addr)) x.other.stored++;
        else miss(s, rows && !any ? 'missing' : 'legs', x.pool.id);
      }
    }
  }
  return { perPool, missing: [...missing.values()].sort((a, b) => a.s.height - b.s.height), rowsChain, rowsStored };
}

export interface Pricing {
  /** The quote for a row with no price of its own at `ts` (see the header). */
  quoteFor: (ts: number) => { price: number | null; source: 'spot' | 'swap_1h' | 'unknown' };
  /** The first minute quote stored (price.usd); a trade priced at its own USDC before it says 'execution'. */
  minuteFrom: number;
  mark: string;
}

export interface Repair { sql: string[]; flows: number; moves: number; legs: number; differs?: string }

/**
 * The SQL that writes one missing transaction, read again by its hash, at its block's time `ts` (see the header): its
 * pool legs alone ('legs'); the moves at the addresses none of its stored moves (`have`) is at, and its pool legs,
 * when every stored move is the parser's ('part'; else `differs` says how, and nothing is written); or its address
 * links (each counted once, stmt.linkOnce), flows, moves and pool legs, as the hub writes them, each flow priced as the
 * header says and marked restored ('missing').
 */
export function repairRows(t: any, ts: number, verdict: Verdict, ctx: OsmoCtx, pricing: Pricing, have: { address: string; idx: number; delta: number }[] = []): Repair {
  const norm = normFromTxSearch(t, ts);
  const legs: PoolLeg[] = poolLegsOf(norm, ctx.poolAddrs);
  const legSql = legs.map((l) => inlineSql(stmt.poolLeg(l)));
  if (verdict === 'legs') return { sql: legSql, flows: 0, moves: 0, legs: legs.length };
  const p = parseOsmosisTx(norm, { ...ctx, priceUsd: QUOTE_MARK });
  if (verdict === 'part') {
    const mine = new Map(p.moves.map((m) => [`${m.idx}|${m.address}`, m]));
    const other = have.find((r) => { const m = mine.get(`${r.idx}|${r.address}`); return !m || Math.abs(m.delta - r.delta) >= SAME_NAM; });
    if (other) return { sql: [], flows: 0, moves: 0, legs: 0, differs: `a stored move (${other.address}, index ${other.idx}, ${other.delta} NAM) the parser does not give` };
    const at = new Set(have.map((r) => r.address));
    const moves = p.moves.filter((m) => !at.has(m.address));
    return { sql: [...moves.map((m) => inlineSql(stmt.move(m))), ...legSql], flows: 0, moves: moves.length, legs: legs.length };
  }
  const priced: Flow[] = p.flows.map((f) => {
    const own = f.priceUsd != null && f.priceUsd !== QUOTE_MARK ? f.priceUsd : null;
    const q = own != null ? { price: own, source: ts < pricing.minuteFrom ? 'execution' : null } : pricing.quoteFor(ts);
    const { priceSource: _drop, ...rest } = (f.meta ?? {}) as Record<string, unknown>;
    return { ...f, priceUsd: q.price, valueUsd: q.price == null ? null : q.price * f.amount, meta: { ...rest, ...(q.source ? { priceSource: q.source } : {}), tsSource: 'block', via: 'history repair', restored: pricing.mark } };
  });
  return {
    sql: [...p.links.map((l) => inlineSql(stmt.linkOnce(l))), ...priced.map((f) => inlineSql(stmt.flow(f))), ...p.moves.map((x) => inlineSql(stmt.move(x))), ...legSql],
    flows: priced.length, moves: p.moves.length, legs: legs.length,
  };
}

/**
 * Transactions' statements put in files of at most FILE_BYTES, a transaction's never split between two (see the
 * header). One larger than a file alone stops the run: it would be sent in parts.
 */
export function packFiles(units: { hash: string; sql: string[] }[]): string[][] {
  const files: string[][] = [];
  let cur: string[] = [], size = 0;
  for (const u of units) {
    const n = u.sql.reduce((a, s) => a + s.length + 2, 0);
    if (n > FILE_BYTES) throw new Error(`transaction ${u.hash}: ${n} bytes of statements, more than one file holds (${FILE_BYTES}); write it by hand`);
    if (cur.length && size + n > FILE_BYTES) { files.push(cur); cur = []; size = 0; }
    cur.push(...u.sql);
    size += n;
  }
  if (cur.length) files.push(cur);
  return files;
}

/** Each statement's text and rows read, for the report. */
const readsOf = (ran: Ran[]) => {
  const by = new Map<string, { n: number; rows: number; read: number }>();
  for (const r of ran) {
    const k = r.sql.replace(/IN \([^)]*\)/, 'IN (...)').slice(0, 110);
    const x = by.get(k) ?? by.set(k, { n: 0, rows: 0, read: 0 }).get(k)!;
    x.n++; x.rows += r.rows; x.read += r.rowsRead ?? 0;
  }
  return [...by].map(([k, x]) => `  ${x.n} x ${k}: ${x.rows} rows, ${x.read} rows read`);
};

async function main() {
  const dry = args.includes('--dry-run');
  const fromArg = arg('--from'), toArg = arg('--to');
  if (!fromArg || !toArg) throw new Error('give --from and --to (a height, or a date YYYY-MM-DD)');
  const only = arg('--pools')?.split(',').map((x) => x.trim()).filter(Boolean);
  const mark = arg('--mark') ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(mark)) throw new Error(`--mark must be a date: ${mark}`);

  const router = await fetchNamPools();
  if (router.error || !router.pools.length) throw new Error(`the Osmosis router listed no NAM pools (${router.error ?? 'none'}): not reading with an empty pool map`);
  const all: PoolRef[] = router.pools.filter((p) => p.address).map((p) => ({ id: p.id, address: p.address, pair: p.pair }));
  const pools = only ? all.filter((p) => only.includes(p.id)) : all;
  if (only && pools.length !== only.length) throw new Error(`--pools: the router lists ${pools.map((p) => p.id).join(', ') || 'none'} of ${only.join(', ')}`);
  // the parser knows every pool the router lists, whichever are searched
  const ctx: OsmoCtx = { poolAddrs: new Map(all.map((p) => [p.address, p.id])), priceUsd: null, assets: osmoAssets() };

  const pager = new OsmosisPager(OSMOSIS.publicRpc);
  const st = await pager.status();
  log(`node ${OSMOSIS.publicRpc}: head ${st.head}; the deep index's first block ${st.deepFirst}${st.horizon !== st.deepFirst ? `, the other's ${st.horizon}` : ' (no other index answered the /status reads)'}`);

  // the oldest NAM transfer the deep index holds bounds every range
  const namQ = OSMOSIS_QUERIES[1];
  const namSt = await pager.query(namQ);
  if (namSt.first == null) throw new Error(`the deep index (first block ${st.deepFirst}) holds no transaction of "${namQ}"`);
  const heightOf = async (a: string, end: boolean): Promise<number> => {
    if (/^\d+$/.test(a)) return Number(a);
    const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(a) ? `${a}T00:00:00Z` : a);
    if (!Number.isFinite(ms)) throw new Error(`not a height or a date: ${a}`);
    // the first block at or after `ms`, by halving between the oldest NAM transfer and the head
    let lo = namSt.first!, hi = st.head;
    if ((await pager.blockTime(lo)) >= ms) return end ? lo - 1 : lo;
    if ((await pager.blockTime(hi)) < ms) return end ? hi : hi + 1;
    while (lo + 1 < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if ((await pager.blockTime(mid)) >= ms) hi = mid; else lo = mid;
    }
    return end ? hi - 1 : hi;
  };
  const from = Math.max(await heightOf(fromArg, false), namSt.first);
  const to = Math.min(await heightOf(toArg, true), st.head);
  if (to < from) throw new Error(`an empty range: ${from} to ${to}`);
  log(`range ${from} to ${to}${from === namSt.first ? ' (from the oldest NAM transfer the node holds)' : ''}`);

  const queries: { q: string; pool?: PoolRef }[] = [...OSMOSIS_QUERIES.map((q) => ({ q })), ...pools.flatMap((p) => osmosisPoolQueries(p.address).map((q) => ({ q, pool: p })))];
  const poolQueryOf = new Map<number, string>();
  queries.forEach((x, i) => { if (x.pool) poolQueryOf.set(i, x.pool.address); });
  const seen = new Map<string, Seen>();
  const perQuery: { q: string; inRange: number; total: number }[] = queries.map((x) => ({ q: x.q, inRange: 0, total: 0 }));

  // the chain's answers kept a page at a time, for a run stopped part way (see the header)
  mkdirSync(OUT, { recursive: true });
  const progressFile = join(OUT, `osmosis-history-progress-${from}-${to}.jsonl`);
  const progressHead = { from, to, deepFirst: st.deepFirst, queries: queries.map((x) => x.q), poolAddrs: [...ctx.poolAddrs.keys()].sort() };
  const kept = !args.includes('--fresh') && existsSync(progressFile) ? loadProgress(readFileSync(progressFile, 'utf8'), progressHead, seen) : null;
  if (kept) {
    for (const [i, d] of kept.done) Object.assign(perQuery[i], d);
    for (const [i] of kept.pages) if (!kept.done.has(i)) perQuery[i].inRange = [...seen.values()].filter((s) => s.found.has(i)).length;
    log(`going on from ${progressFile.slice(ROOT.length + 1)}: ${kept.done.size} of ${queries.length} queries read whole, ${seen.size} transactions`);
  } else {
    seen.clear();
    writeFileSync(progressFile, JSON.stringify(progressHead) + '\n');
  }

  let next = 0, done = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= queries.length) return;
      const { q } = queries[i];
      if (kept?.done.has(i)) { log(`${++done}/${queries.length} ${q}: ${perQuery[i].inRange} in range (read before)`); continue; }
      const after = kept?.pages.get(i);
      await pager.read(q, from, to, (txs, page) => {
        perQuery[i].inRange += txs.length;
        for (const t of txs) seenOf(t, ctx, i, seen);
        appendFileSync(progressFile, JSON.stringify({ q: i, page, txs: txs.map((t) => seenToJson(seen.get(String(t.hash).toUpperCase())!)) }) + '\n');
      }, after != null ? after + 1 : undefined);
      perQuery[i].total = (await pager.query(q)).total;
      appendFileSync(progressFile, JSON.stringify({ q: i, done: true, inRange: perQuery[i].inRange, total: perQuery[i].total }) + '\n');
      log(`${++done}/${queries.length} ${q}: ${perQuery[i].inRange} in range (${perQuery[i].total} in all)`);
    }
  };
  await Promise.all(Array.from({ length: AT_ONCE }, worker));

  // the database, read only, by tx_hash
  const { db, ran } = readOnlyD1(wranglerRunner(ROOT));
  const hashes = [...seen.values()].filter((s) => s.flows || s.moves || s.legsAt.size).map((s) => s.hash);
  log(`${seen.size} transactions found, ${hashes.length} make rows: reading the database for them`);
  const stored = await storedOf(db, hashes);
  const { perPool, missing, rowsChain, rowsStored } = judge(seen, stored, pools, poolQueryOf);

  const lines: string[] = [];
  lines.push(`Osmosis history against the database, blocks ${from} to ${to}${dry ? ' (dry run: nothing written)' : ''}`);
  lines.push(`Node ${OSMOSIS.publicRpc}: head ${st.head}; every answer taken from the deep index (first block ${st.deepFirst}, named by a /status in the same request)${st.horizon !== st.deepFirst ? `; the other index starts at block ${st.horizon}` : ''}. ${pager.stats.reads} reads (${(pager.stats.bytes / 1e6).toFixed(1)} MB), ${pager.stats.shallow} answers of the other index asked again, ${pager.stats.failed} failed reads asked again.`);
  lines.push(`Queries (${queries.length}), each read oldest first:`);
  for (const x of perQuery) lines.push(`  ${x.q}: ${x.inRange} in range, ${x.total} in all`);
  lines.push('');
  lines.push(`Per pool: transactions that move its NAM (stored: the NAM move at its address), and those that move its other coins, with or without its NAM (stored: the legs in pool_legs${stored.legs ? '' : ', a table this database does not have yet (migration 0018)'})`);
  for (const x of perPool) {
    lines.push(`  ${x.pool.id.padEnd(5)} ${x.pool.pair.padEnd(14)} ${x.pool.address}: NAM ${x.nam.chain} on chain, ${x.nam.stored} stored, ${x.nam.chain - x.nam.stored} missing (${x.gross.toFixed(6)} NAM gross); other coins ${x.other.chain} on chain (${x.other.only} without its NAM), ${x.other.stored} stored, ${x.other.chain - x.other.stored} missing`);
  }
  lines.push(`All transactions with NAM rows: ${rowsChain} on chain, ${rowsStored} with rows stored, ${rowsChain - rowsStored} with none.`);
  lines.push('');
  const word: Record<Verdict, string> = { missing: 'nothing stored', part: 'stored in part (no NAM move at the pool)', legs: 'its legs in the other coins not in pool_legs' };
  lines.push(`Missing (${missing.length}): hash, height, pools, what`);
  for (const m of missing) {
    const at = [...m.s.namAt].map(([a, v]) => `${ctx.poolAddrs.get(a)} ${v >= 0 ? '+' : ''}${v.toFixed(6)} NAM`);
    const legs = [...m.s.legsAt].flatMap(([a, d]) => [...d].map(([denom, v]) => `${ctx.poolAddrs.get(a)} ${v >= 0n ? '+' : ''}${v} ${denom === OSMOSIS.usdcDenom ? 'uusdc' : denom}`));
    lines.push(`  ${m.s.hash} ${m.s.height} ${m.pools.join(',') || '-'} ${word[m.verdict]}${at.length ? `; ${at.join(', ')}` : ''}${legs.length ? `; ${legs.join(', ')}` : ''}`);
  }
  lines.push('');
  lines.push(`Database reads (read only, by tx_hash, ${HASHES_A_READ} hashes a statement):`);
  lines.push(...readsOf(ran));

  if (dry) { console.log(lines.join('\n')); return; }

  // ---- the SQL for what is missing ----
  if (missing.some((m) => m.s.legsAt.size) && !stored.legs) lines.push('', 'pool_legs is not in the database yet: apply migration 0018 before this SQL.');
  const minute: { ts: number; value: number }[] = [], hourly: { ts: number; value: number }[] = [];
  const units: { hash: string; sql: string[] }[] = [];
  const tsv: string[] = ['hash\theight\tts\twhat\tflows\tmoves\tpool_legs'];
  const differ: string[] = [];
  if (missing.length) {
    const times = new Map<number, number>();
    for (const m of missing) if (!times.has(m.s.height)) times.set(m.s.height, await pager.blockTime(m.s.height));
    const lo = Math.min(...times.values()), hi = Math.max(...times.values());
    minute.push(...((await db.prepare(`SELECT ts, value FROM metrics WHERE key = 'price.usd' AND ts BETWEEN ? AND ? ORDER BY ts`).bind(lo - QUOTE_MATCH_MS, hi).all<{ ts: number; value: number }>()).results ?? []).map((x) => ({ ts: Number(x.ts), value: Number(x.value) })));
    hourly.push(...((await db.prepare(`SELECT ts, value FROM metrics WHERE key = 'price.swap_1h' AND ts BETWEEN ? AND ? ORDER BY ts`).bind(lo - 7 * H, hi + 7 * H).all<{ ts: number; value: number }>()).results ?? []).map((x) => ({ ts: Number(x.ts), value: Number(x.value) })));
    const firstMinute = await db.prepare(`SELECT MIN(ts) AS ts FROM metrics WHERE key = 'price.usd'`).first<{ ts: number | null }>();
    const MINUTE_FROM = firstMinute?.ts != null ? Number(firstMinute.ts) : Infinity;
    const quoteFor = (ts: number): { price: number | null; source: 'spot' | 'swap_1h' | 'unknown' } => {
      if (ts >= MINUTE_FROM) {
        let m: { ts: number; value: number } | null = null;
        for (const x of minute) { if (x.ts <= ts) m = x; else break; }
        if (m && ts - m.ts <= QUOTE_MATCH_MS && m.value > 0) return { price: m.value, source: 'spot' };
      }
      let best: { d: number; v: number } | null = null;
      for (const x of hourly) { const d = Math.abs(x.ts + 1_800_000 - ts); if (!best || d < best.d) best = { d, v: x.value }; }
      return best && best.d <= 6 * H && best.v > 0 ? { price: best.v, source: 'swap_1h' } : { price: null, source: 'unknown' };
    };
    for (const m of missing) {
      const ts = times.get(m.s.height)!;
      const r = repairRows(await pager.tx(m.s.hash), ts, m.verdict, ctx, { quoteFor, minuteFrom: MINUTE_FROM, mark }, stored.moveRows.get(m.s.hash));
      if (r.differs) { differ.push(`  ${m.s.hash} ${m.s.height}: ${r.differs}`); continue; }
      if (r.sql.length) units.push({ hash: m.s.hash, sql: r.sql });
      tsv.push(`${m.s.hash}\t${m.s.height}\t${iso(ts)}\t${m.verdict === 'legs' ? 'pool legs' : m.verdict}\t${r.flows}\t${r.moves}\t${r.legs}`);
    }
  }
  const files: string[] = [];
  for (const part of packFiles(units)) {
    const f = join(OUT, `osmosis-history-${String(files.length).padStart(4, '0')}.sql`);
    writeFileSync(f, part.join('\n') + '\n');
    files.push(f);
  }
  const statements = units.reduce((a, u) => a + u.sql.length, 0);
  lines.push('', `Written: ${statements} statements for ${units.length} transactions in ${files.length} file(s), each sent by d1-apply as one command.`);
  if (differ.length) lines.push(`Stored otherwise than the parser reads them, not written (${differ.length}; each needs a look):`, ...differ);
  lines.push(`Then: node --experimental-strip-types scripts/d1-apply.ts ${files.map((f) => f.slice(ROOT.length + 1)).join(' ') || '(none)'}`);
  lines.push(`and:  npx tsx scripts/rebuild-derived.ts --key restored --mark ${mark} --out scripts/out/repair/osmosis-history-derived.sql (check it, then apply it the same way)`);
  writeFileSync(join(OUT, 'osmosis-history.tsv'), tsv.join('\n') + '\n');
  writeFileSync(join(OUT, 'osmosis-history.txt'), lines.join('\n') + '\n');
  console.log(lines.join('\n'));
}

// run only as a script (the test imports the helpers)
if (process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof PagerError ? `stopped: ${e.message}` : e);
    process.exit(1);
  });
}
