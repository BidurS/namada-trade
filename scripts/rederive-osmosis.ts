/**
 * Re-derive the stored Osmosis flows with the current parser (worker/src/parse/osmosis.ts). The group C fixes of
 * 2026-10-21 (aceefa9, 155e396, 8c349eb, 259b827 and OSMOSIS.pricePoolIds) changed how swaps are read from 15:40 UTC
 * that day; rows written before keep the old reading: a multi-pool swap's coin is its first leg's, a ProtoRev backrun
 * is merged into the signer's swap, a trade outside pool 3005 sets its own price, a swap's other sends are not
 * recorded, bridge rows lack their packet sequence. Reads the remote D1 with read-only SELECTs and the transactions
 * from a public Osmosis node (or a local copy), and writes SQL for the owner to check and apply (scripts/d1-apply.ts).
 * Writes nothing itself.
 *
 *   npx tsx scripts/rederive-osmosis.ts [--cache <dir of <HASH>.json>]   # scripts/out/rederive/osmosis.sql + report
 *
 * Every stored transaction older than an hour is parsed again (pool addresses from the Osmosis router's current
 * list, the asset map of osmoAssets) and its rows compared with the stored ones by id:
 * - a row both have: UPDATE of what the parser decides (from, to, amount, coin, pools and the parser's meta keys),
 *   and of the price when its basis changed or its amount did. Kept as stored: ts, height, kind, the settle record
 *   (a swap without one gets the parser's), tsSource, via and any key the parser does not write. Each statement changes the row only while it is still as read.
 * - a row only the parser writes: INSERT OR IGNORE at the transaction's stored time.
 * - a row only the store has: DELETE, only where the parser writes another row of the same transaction in its place
 *   (a deposit read as a transfer while the hub's pool list lacked the pool); any other is listed, never deleted.
 * Prices (meta.priceSource says which): a trade's own USDC per NAM when the parser sets one (pool 3005 only);
 * otherwise a row that kept a quote price keeps it (its value follows a changed amount), and a row that loses its own
 * price, or a new row, takes the quote the cron stored for its minute ('spot', the newest price.usd at most
 * QUOTE_MATCH_MS before it, from 2026-10-15 when the minute quotes start) or, before that, the hourly price the history
 * backfill priced its rows with ('swap_1h', the nearest price.swap_1h within six hours, as scripts/backfill-history.ts
 * did), else none ('unknown'). The hourly price is the series as the rebuild will store it from the re-derived trades
 * (pass 1), and every row before the minute quotes priced at it, or with none, is priced from it again.
 */
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { d1 as d1once } from './lib';
import { normFromTxSearch, osmoAssets, parseOsmosisTx, type OsmoCtx } from '../worker/src/parse/osmosis';
import { fetchNamPools } from '../worker/src/sources/sqs';
import { OSMOSIS } from '../worker/src/config';
import { QUOTE_MATCH_MS } from '../worker/src/analytics';
import { swapHourStmts, type SwapRow } from '../worker/src/series';
import type { Flow } from '../shared/types';

const H = 3_600_000;
const OUT = join(import.meta.dirname, 'out', 'rederive');
mkdirSync(OUT, { recursive: true });
const args = process.argv.slice(2);
const cacheDir = (() => { const i = args.indexOf('--cache'); return i >= 0 ? args[i + 1] : null; })();
const RPCS = [OSMOSIS.publicRpc, 'https://osmosis-rpc.polkachu.com'];
/** The keys the parser writes into a row's meta; any other stored key (tsSource, via, settle, priceSource...) is kept. */
const PARSER_KEYS = ['trader', 'arb', 'namSold', 'namBought', 'postHandler', 'memo', 'channel', 'packetSequence', 'ibcTimeoutRefund', 'refundReason', 'ackError', 'refundReceiver', 'relayer', 'textCut'];
/** A price no quote ever has: the parser sets it where it prices at the quote, so a row's own price tells itself apart. */
const QUOTE_MARK = 7777;

const q = (v: unknown): string => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? (Number.isFinite(v) ? String(v) : 'NULL') : `'${String(v).replace(/'/g, "''")}'`);
const near = (a: number | null, b: number | null) => (a == null || b == null ? a == b : Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b)));
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

function d1<T = any>(sql: string): T[] {
  for (let i = 0; ; i++) {
    try { return d1once<T>(sql); } catch (e) { if (i >= 5) throw e; }
  }
}

async function tx(hash: string): Promise<any | null> {
  if (cacheDir) {
    const f = join(cacheDir, `${hash}.json`);
    if (existsSync(f)) { const j = JSON.parse(readFileSync(f, 'utf8')); return j.result ?? j; }
  }
  for (let i = 0; i < 6; i++) {
    try {
      const r = await fetch(`${RPCS[i % RPCS.length]}/tx?hash=0x${hash}`, { signal: AbortSignal.timeout(15000) });
      if (r.ok) { const j = await r.json(); if (j.result) return j.result; }
    } catch { /* next node */ }
    await new Promise((ok) => setTimeout(ok, 400 * (i + 1)));
  }
  return null;
}

type Row = { id: string; height: number; ts: number; tx_hash: string; kind: string; from_addr: string | null; to_addr: string | null; amount_num: number; counter_denom: string | null; counter_amount: number | null; pool_id: string | null; price_usd: number | null; value_usd: number | null; meta: string | null };

const now = Date.now();
const rows: Row[] = [];
for (let page = 0; ; page++) {
  const part = d1<Row>(`SELECT id, height, ts, tx_hash, kind, from_addr, to_addr, amount_num, counter_denom, counter_amount, pool_id, price_usd, value_usd, meta FROM flows WHERE chain = 'osmosis' ORDER BY id LIMIT 500 OFFSET ${page * 500}`);
  rows.push(...part.map((r) => ({ ...r, ts: Number(r.ts), height: Number(r.height) })));
  if (part.length < 500) break;
}
const byTx = new Map<string, Row[]>();
for (const r of rows) (byTx.get(r.tx_hash) ?? byTx.set(r.tx_hash, []).get(r.tx_hash)!).push(r);
// a transaction the hub may still be writing (its rows less than an hour old) is left for another run
for (const [h, rs] of byTx) if (rs.some((r) => now - r.ts < H)) byTx.delete(h);

const minute = d1<{ ts: number; value: number }>(`SELECT ts, value FROM metrics WHERE key = 'price.usd' ORDER BY ts`).map((x) => ({ ts: Number(x.ts), value: Number(x.value) }));
const hourly = d1<{ ts: number; value: number }>(`SELECT ts, value FROM metrics WHERE key = 'price.swap_1h' ORDER BY ts`).map((x) => ({ ts: Number(x.ts), value: Number(x.value) }));
const MINUTE_FROM = minute.length ? minute[0].ts : Infinity;
const atOrBefore = (xs: { ts: number; value: number }[], ts: number) => {
  let lo = 0, hi = xs.length - 1, best = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (xs[m].ts <= ts) { best = m; lo = m + 1; } else hi = m - 1; }
  return best >= 0 ? xs[best] : null;
};
/** The quote for a move at ts that has no price of its own (see the header). */
function quoteFor(ts: number): { price: number | null; source: 'spot' | 'swap_1h' | 'unknown' } {
  if (ts >= MINUTE_FROM) {
    const m = atOrBefore(minute, ts);
    if (m && ts - m.ts <= QUOTE_MATCH_MS && m.value > 0) return { price: m.value, source: 'spot' };
  }
  let best: { d: number; v: number } | null = null;
  for (const x of hourly) { const d = Math.abs(x.ts + 1_800_000 - ts); if (!best || d < best.d) best = { d, v: x.value }; }
  return best && best.d <= 6 * H && best.v > 0 ? { price: best.v, source: 'swap_1h' } : { price: null, source: 'unknown' };
}
/** A stored row priced at its own USDC (meta.priceSource 'execution', or none with a USDC coin that gives its price). */
const ownStored = (r: Row, m: Record<string, unknown>) =>
  m.priceSource === 'execution' || (m.priceSource == null && r.counter_denom === 'USDC' && r.counter_amount != null && r.amount_num > 0 && r.price_usd != null && near(r.price_usd, r.counter_amount / r.amount_num));

const pools = await fetchNamPools();
if (!pools.pools.length) throw new Error('the Osmosis router listed no NAM pools: not re-deriving with an empty pool map');
const ctx: OsmoCtx = { poolAddrs: new Map(pools.pools.filter((p) => p.address).map((p) => [p.address, p.id])), priceUsd: QUOTE_MARK, assets: osmoAssets() };
console.error(`${rows.length} stored rows in ${byTx.size} transactions older than an hour; ${ctx.poolAddrs.size} pools; ${minute.length} minute quotes from ${iso(MINUTE_FROM)}, ${hourly.length} hourly prices`);

const sql: string[] = [], report: Record<string, unknown>[] = [], unread: string[] = [], listed: string[] = [];
const tally: Record<string, number> = {};
const count = (k: string) => { tally[k] = (tally[k] ?? 0) + 1; };
const hashes = [...byTx.keys()];
let done = 0;

// Pass 1: every transaction parsed, before anything is priced.
const parsedOf = new Map<string, Flow[]>();
{
  const queue = [...hashes];
  const read = async () => {
    for (;;) {
      const hash = queue.shift();
      if (!hash) return;
      const t = await tx(hash);
      if (++done % 250 === 0) console.error(`read ${done}/${hashes.length}`);
      if (!t?.tx_result) { unread.push(hash); count('transaction not readable'); continue; }
      const ts = Math.min(...byTx.get(hash)!.map((r) => r.ts));
      parsedOf.set(hash, parseOsmosisTx(normFromTxSearch(t, ts), ctx).flows);
    }
  };
  await Promise.all([read(), read()]);
}

// The hourly price as the rebuild (scripts/rebuild-derived.ts, series.ts swapHourStmts) will store it: each closed
// hour with a buy or sell, from its trades as re-derived (the trusted swaps alone set it, never a price or a value),
// laid over the stored series. A row priced at the hourly price is priced from this, so it agrees with the series
// once the rebuild has run (review, 2026-10-22: priced from the series as stored, 648 rows would have disagreed).
{
  const after = new Map<number, SwapRow[]>();
  for (const [hash, flows] of parsedOf) for (const f of flows) {
    if (f.kind !== 'buy' && f.kind !== 'sell') continue;
    const h = Math.floor(f.ts / H) * H;
    if (h + H > Math.floor(now / H) * H) continue;
    (after.get(h) ?? after.set(h, []).get(h)!).push({ id: f.id, ts: f.ts, kind: f.kind, amount_num: f.amount, counter_denom: f.counterDenom ?? null, counter_amount: f.counterAmount ?? null, pool_id: f.poolId ?? null, value_usd: null, from_addr: f.from, to_addr: f.to, meta: JSON.stringify(f.meta ?? {}) } as SwapRow);
    void hash;
  }
  const series = new Map(hourly.map((x) => [x.ts, x.value]));
  let changed = 0;
  for (const [h, rs] of after) {
    const st = swapHourStmts(rs, h).find((x) => x.params[1] === 'price.swap_1h');
    const v = st ? Number(st.params[2]) : null;
    if ((series.get(h) ?? null) !== v) changed++;
    if (v == null) series.delete(h); else series.set(h, v);
  }
  hourly.splice(0, hourly.length, ...[...series].sort((a, b) => a[0] - b[0]).map(([ts, value]) => ({ ts, value })));
  console.error(`hourly price: ${changed} of ${after.size} trade-hours differ from the stored series once re-derived`);
}

async function one(hash: string) {
  const stored = byTx.get(hash)!;
  const parsed = parsedOf.get(hash);
  if (!parsed) return;
  const ts = Math.min(...stored.map((r) => r.ts));
  const want = new Map(parsed.map((f) => [f.id, f]));
  const have = new Map(stored.map((r) => [r.id, r]));
  const base = stored.find((r) => r.ts === ts)!;
  const baseMeta = JSON.parse(base.meta ?? '{}');

  const priceOf = (f: Flow) => (f.priceUsd != null && f.priceUsd !== QUOTE_MARK ? f.priceUsd : null);
  for (const f of parsed) {
    const r = have.get(f.id);
    const own = priceOf(f);
    const pm = Object.fromEntries(Object.entries(f.meta ?? {}).filter(([k]) => PARSER_KEYS.includes(k)));
    if (!r) {
      // a row the parser writes and the store lacks: at the transaction's stored time
      const p = own != null ? { price: own, source: (ts < MINUTE_FROM ? 'execution' : null) as string | null } : quoteFor(ts);
      const meta: Record<string, unknown> = { ...pm, ...(baseMeta.tsSource ? { tsSource: baseMeta.tsSource } : {}), ...(baseMeta.via ? { via: baseMeta.via } : {}), ...(p.source ? { priceSource: p.source } : {}), rederived: '2026-10-22' };
      sql.push(`INSERT OR IGNORE INTO flows (id,chain,height,ts,tx_hash,kind,from_addr,to_addr,amount_num,counter_denom,counter_amount,pool_id,price_usd,value_usd,meta) VALUES (${[f.id, 'osmosis', base.height, ts, hash, f.kind, f.from, f.to, f.amount, f.counterDenom ?? null, f.counterAmount ?? null, f.poolId ?? null, p.price, p.price == null ? null : p.price * f.amount, JSON.stringify(meta)].map(q).join(',')});`);
      report.push({ id: f.id, effect: 'insert', kind: f.kind, from: f.from, to: f.to, nam: f.amount, price: p.price, priceSource: p.source });
      count(`insert ${f.id.split(':')[2]}`);
      continue;
    }
    const sm = JSON.parse(r.meta ?? '{}') as Record<string, unknown>;
    const set: Record<string, unknown> = {};
    const diff: Record<string, [unknown, unknown]> = {};
    const col = (c: keyof Row, v: unknown, isNum = false) => {
      const old = r[c] as unknown;
      if (isNum ? !near(old as number | null, v as number | null) : (old ?? null) !== (v ?? null)) { set[c] = v; diff[c] = [old, v]; }
    };
    if (f.kind !== r.kind) { listed.push(`${r.id}\tkind ${r.kind} -> ${f.kind}: not changed here`); count('kind differs (listed)'); continue; }
    col('from_addr', f.from); col('to_addr', f.to); col('amount_num', f.amount, true);
    col('counter_denom', f.counterDenom ?? null); col('counter_amount', f.counterAmount ?? null, true); col('pool_id', f.poolId ?? null);
    // the meta: the parser's keys as it writes them now, every other stored key kept
    const meta: Record<string, unknown> = Object.fromEntries(Object.entries(sm).filter(([k]) => !PARSER_KEYS.includes(k)));
    Object.assign(meta, pm);
    // a swap older than the settle backfill's 40 days gets its settle record too (a stored one is kept as it is)
    if (meta.settle == null && f.meta?.settle != null) meta.settle = f.meta.settle;
    // the price: own when the parser sets one; a stored quote price is kept; a lost own price takes the quote
    const amount = (set.amount_num as number | undefined) ?? r.amount_num;
    let price = r.price_usd, source = (sm.priceSource as string | undefined) ?? null;
    // an own price that stays own keeps its stored label; one that becomes own is labelled as the era's rows are
    if (own != null) { price = own; source = ownStored(r, sm) ? ((sm.priceSource as string | undefined) ?? null) : r.ts < MINUTE_FROM ? 'execution' : null; }
    else if (ownStored(r, sm)) { const p = quoteFor(r.ts); price = p.price; source = p.source; }
    // a row before the minute quotes priced at the hourly price (or with none) takes it from the series as it will stand
    else if (r.ts < MINUTE_FROM && (sm.priceSource === 'swap_1h' || sm.priceSource === 'unknown')) { const p = quoteFor(r.ts); price = p.price; source = p.source; }
    if (source) meta.priceSource = source; else delete meta.priceSource;
    if (!near(price, r.price_usd)) { set.price_usd = price; diff.price_usd = [r.price_usd, price]; }
    const value = price == null ? null : price * amount;
    if (!near(value, r.value_usd)) set.value_usd = value;
    const metaText = JSON.stringify(meta);
    const same = JSON.stringify(Object.fromEntries(Object.entries(meta).sort())) === JSON.stringify(Object.fromEntries(Object.entries(sm).sort()));
    if (!same) { set.meta = { ...meta, rederived: '2026-10-22' }; diff.meta = [Object.keys(sm).filter((k) => !(k in meta) || JSON.stringify(sm[k]) !== JSON.stringify(meta[k])), Object.keys(meta).filter((k) => !(k in sm) || JSON.stringify(sm[k]) !== JSON.stringify(meta[k]))]; }
    if (!Object.keys(set).length) { count('same'); continue; }
    if (set.meta) set.meta = JSON.stringify(set.meta); else if (Object.keys(set).length) set.meta = JSON.stringify({ ...JSON.parse(metaText), rederived: '2026-10-22' });
    const assigns = Object.entries(set).map(([c, v]) => `${c} = ${q(v)}`).join(', ');
    sql.push(`UPDATE flows SET ${assigns} WHERE id = ${q(r.id)} AND ABS(amount_num - ${q(r.amount_num)}) <= 1e-9 AND ABS(COALESCE(price_usd, -1) - ${q(r.price_usd ?? -1)}) <= 1e-15 AND COALESCE(meta, '') = ${q(r.meta ?? '')};`);
    report.push({ id: r.id, effect: 'update', kind: r.kind, diff });
    count(`update ${Object.keys(diff).sort().join('+')}`);
  }
  for (const r of stored) {
    if (want.has(r.id)) continue;
    // replaced only by another row of the same transaction that the store lacks (a pool deposit read as a transfer)
    const replaced = parsed.some((f) => !have.has(f.id));
    if (replaced) {
      sql.push(`DELETE FROM flows WHERE id = ${q(r.id)} AND ABS(amount_num - ${q(r.amount_num)}) <= 1e-9 AND kind = ${q(r.kind)};`);
      report.push({ id: r.id, effect: 'delete', kind: r.kind, from: r.from_addr, to: r.to_addr, nam: r.amount_num });
      count(`delete ${r.id.split(':')[2]}`);
    } else {
      listed.push(`${r.id}\tstored, not written by the parser, nothing replaces it: left as is`);
      count('stored only (listed)');
    }
  }
}

// Pass 2: the statements.
for (const h of hashes) await one(h);
writeFileSync(join(OUT, 'osmosis.sql'), sql.join('\n') + '\n');
writeFileSync(join(OUT, 'osmosis-report.json'), JSON.stringify({ at: iso(now), tally, unread, listed, rows: report }, null, 1));
console.error(JSON.stringify(tally, null, 1));
console.error(`${sql.length} statements to ${join(OUT, 'osmosis.sql')}; ${unread.length} unreadable, ${listed.length} listed`);
