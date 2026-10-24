/**
 * Prices for the NAM moves stored without one while the cron stored no NAM quote (metrics price.usd) for their
 * minute: from 16:36 UTC on 2026-10-23 to 02:56 UTC on 2026-10-24 the Osmosis quote service's price list left NAM out
 * (fetchNamPrice reads the route spot since), and every move written then has no price. scripts/repair-quote-prices.ts
 * prices a move at the quote stored for its own minute and leaves one with no quote within QUOTE_MATCH_MS before it;
 * this script prices that move at the pool's close the site stores for the hour that holds it (metrics price.pool_1h:
 * the Osmosis data API's chart of pool 3005, NAM against USDC, written every hour for the hour that closed). Reads the
 * remote D1 with read-only SELECTs and writes SQL for the owner to check and apply (scripts/d1-apply.ts). Writes
 * nothing itself.
 *
 *   npx tsx scripts/repair-pool-hour-prices.ts [--since YYYY-MM-DD]
 *     # scripts/out/repair/pool-hour-prices.sql, .tsv, .json (the planned rows), pool-hour-left.tsv, pool-hour-report.txt
 *   npx tsx scripts/rebuild-derived.ts --key repaired --mark 2026-10-24 --planned scripts/out/repair/pool-hour-prices.json \
 *     --out scripts/out/repair/pool-hour-derived.sql
 *     # the trade-hours and the days those moves are in, as they stand once pool-hour-prices.sql is applied: apply it after
 *
 * Which moves: each move since --since (default 2026-10-21) with no price, in NAM (a move in another coin is never
 * priced as NAM) and with no price.usd reading at or before it within QUOTE_MATCH_MS (a move that has one is
 * repair-quote-prices.ts's, priced at the quote of its own minute). Each is priced as the cron prices it, with this
 * close standing in for the quote it had none of: a bot round trip and a Namada move, and a trade with a settle record
 * too. The settle record stays the trade's own price: the moves list, the trades tape and the alert hits show it ahead
 * of price_usd whenever its coins can be priced, and it is never written here. price_usd and value_usd are still the
 * trade's for the hourly and daily sums (dex.swaps_1h.usd, which is written only when every trade of the hour has a
 * value, the hour's buy and sell averages, dex.volume_usd_daily, flow_edges_daily.usd), for the CSV and for the value
 * shown when the settle record cannot be priced, and the cron writes the quote there for every trade it does not price
 * at its own USDC. A trade it does price at its own USDC (in USDC through pool 3005 alone) is never priced here.
 *
 * Its price: the price.pool_1h close stored for the hour that holds the move (ts - ts mod 1 h). No close stored for
 * that hour: the move keeps no price and is listed. value_usd is that price times the move's NAM, as the cron writes it;
 * meta.priceSource 'pool_1h' and meta.priceAt (the hour: the time of the price.pool_1h row) name the row it was read
 * from, and meta.repaired '2026-10-24' marks it for scripts/rebuild-derived.ts --key repaired. Each statement changes
 * the row only while it still has no price and is still a NAM move, so a second apply changes nothing; kind, amount,
 * ends and every other meta key, the settle record among them, are never written.
 *
 * The run checks its SQL on a copy before writing it: the rows it read go into an in-memory SQLite database with the
 * migrations, the SQL is applied twice, and the report says what each pass changed and that no other column changed.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { d1 as d1once } from './lib';
import type { PlannedRow } from './rebuild-derived';
import { QUOTE_MATCH_MS } from '../worker/src/analytics';
import { OSMOSIS } from '../worker/src/config';
import { QUOTE_KEYS, quotesNeeded, settleMetaOf, settleOf } from '../shared/settle';

export const H = 3_600_000;
/** meta.repaired on every row this repair prices (scripts/rebuild-derived.ts --key repaired --mark 2026-10-24). */
export const REPAIRED = '2026-10-24';

/** A stored move, as the selection reads it (every column, so the check on a copy can compare them all). */
export interface Move {
  id: string; chain: string; height: number; ts: number; tx_hash: string; kind: string; from_addr: string | null; to_addr: string | null;
  amount_num: number; counter_denom: string | null; counter_amount: number | null; pool_id: string | null; price_usd: number | null; value_usd: number | null; meta: string | null;
}
/** A stored metrics reading. */
export interface Reading { ts: number; value: number }
export interface Priced { move: Move; hour: number; price: number; value: number }
export interface Left { move: Move; why: string }
/** `priced`: the moves this repair prices; `left`: unpriced moves it leaves without a price; `skipped`: moves that are not its own. */
export interface Plan { priced: Priced[]; left: Left[]; skipped: Left[] }

/** The hour that holds `ts` (its start): the time of the price.pool_1h row of that hour. */
export const hourOf = (ts: number): number => Math.floor(ts / H) * H;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const sqlStr = (s: string) => `'${s.replace(/'/g, "''")}'`;
const metaOf = (m: string | null): Record<string, unknown> => {
  if (!m) return {};
  try { const v = JSON.parse(m); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
};

/**
 * The newest reading at or before `ts`, at most QUOTE_MATCH_MS before it, when its value is above 0: the quote a move
 * of that minute is priced at (the live hub's and repair-quote-prices.ts's rule). null when there is none. `quotes`
 * oldest first.
 */
export function quoteBefore(quotes: readonly Reading[], ts: number): Reading | null {
  let lo = 0, hi = quotes.length - 1, best = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (quotes[m].ts <= ts) { best = m; lo = m + 1; } else hi = m - 1; }
  const q = best >= 0 ? quotes[best] : null;
  return q && ts - q.ts <= QUOTE_MATCH_MS && q.value > 0 ? q : null;
}

/** A trade the cron prices at its own USDC per NAM (worker/src/parse/osmosis.ts): in USDC, through pool 3005 alone, not a round trip. */
export function ownPriced(m: Pick<Move, 'kind' | 'counter_denom' | 'counter_amount' | 'pool_id' | 'meta'>): boolean {
  return (m.kind === 'buy' || m.kind === 'sell') && metaOf(m.meta).arb !== true && m.counter_denom === 'USDC' && (m.counter_amount ?? 0) > 0
    && !!m.pool_id && m.pool_id.split(',').every((p) => OSMOSIS.pricePoolIds.includes(p.trim()));
}

/**
 * Which moves this repair prices, at which close. `quotes`: the price.usd readings, oldest first; `closes`: the
 * price.pool_1h close of each hour (its start to its value).
 */
export function planPoolHourPrices(moves: readonly Move[], quotes: readonly Reading[], closes: ReadonlyMap<number, number>): Plan {
  const plan: Plan = { priced: [], left: [], skipped: [] };
  for (const m of moves) {
    const ts = Number(m.ts);
    if (m.price_usd != null) { plan.skipped.push({ move: m, why: 'it has a price' }); continue; }
    if (metaOf(m.meta).tokenSymbol != null) { plan.skipped.push({ move: m, why: 'a move of another coin, never priced as NAM' }); continue; }
    if (!(m.amount_num > 0)) { plan.skipped.push({ move: m, why: 'no NAM amount' }); continue; }
    const q = quoteBefore(quotes, ts);
    if (q) { plan.skipped.push({ move: m, why: `a quote is stored for its minute (${iso(q.ts)}): scripts/repair-quote-prices.ts prices it` }); continue; }
    if (ownPriced(m)) { plan.left.push({ move: m, why: 'a USDC trade through pool 3005 alone, which the cron prices at its own USDC: never priced from the pool' }); continue; }
    const hour = hourOf(ts), close = closes.get(hour);
    if (close == null || !Number.isFinite(close) || !(close > 0)) { plan.left.push({ move: m, why: `no pool close is stored for the hour of ${iso(hour).slice(0, 16)} UTC` }); continue; }
    plan.priced.push({ move: m, hour, price: close, value: close * m.amount_num });
  }
  return plan;
}

/** The guarded statement for one priced move: it changes the row only while it has no price and is a NAM move. */
export function poolHourSql(p: Priced, mark = REPAIRED): string {
  return `UPDATE flows SET price_usd = ${p.price}, value_usd = ${p.price} * amount_num, meta = json_set(COALESCE(meta, '{}'), '$.priceSource', 'pool_1h', '$.priceAt', ${p.hour}, '$.repaired', ${sqlStr(mark)}) `
    + `WHERE id = ${sqlStr(p.move.id)} AND price_usd IS NULL AND json_extract(COALESCE(meta, '{}'), '$.tokenSymbol') IS NULL;`;
}

/** The row as scripts/rebuild-derived.ts --planned reads it before the statement is applied. */
export const plannedRow = (p: Priced, mark = REPAIRED): PlannedRow => ({ id: p.move.id, price_usd: p.price, meta: { priceSource: 'pool_1h', priceAt: p.hour, repaired: mark } });

// ---------------------------------------------------------------- the check on a copy

const COLS = ['id', 'chain', 'height', 'ts', 'tx_hash', 'kind', 'from_addr', 'to_addr', 'amount_num', 'counter_denom', 'counter_amount', 'pool_id', 'price_usd', 'value_usd', 'meta'] as const;

export interface CopyCheck { firstPass: number; secondPass: number; problems: string[] }

/**
 * The SQL applied twice to a copy of the rows read (an in-memory SQLite database with the migrations): how many rows
 * each pass changed, and every way a row came out other than planned (a column other than price_usd, value_usd and
 * meta changed, a meta key other than the three changed, a price or value other than planned).
 */
export function checkOnCopy(rows: readonly Move[], plan: Plan, sql: readonly string[]): CopyCheck {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path: string) => any };
  const db = new DatabaseSync(':memory:');
  const migrations = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
  for (const f of readdirSync(migrations).filter((x) => x.endsWith('.sql')).sort()) db.exec(readFileSync(join(migrations, f), 'utf8'));
  const ins = db.prepare(`INSERT INTO flows (${COLS.join(',')}) VALUES (${COLS.map(() => '?').join(',')})`);
  for (const r of rows) ins.run(...COLS.map((c) => r[c] ?? null));
  const pass = () => sql.reduce((n, s) => n + Number(db.prepare(s).run().changes), 0);
  const firstPass = pass(), secondPass = pass();
  const problems: string[] = [];
  const planned = new Map(plan.priced.map((p) => [p.move.id, p]));
  for (const r of rows) {
    const now = db.prepare(`SELECT ${COLS.join(',')} FROM flows WHERE id = ?`).get(r.id) as Move;
    for (const c of COLS) if (c !== 'price_usd' && c !== 'value_usd' && c !== 'meta' && (now[c] ?? null) !== (r[c] ?? null)) problems.push(`${r.id}: ${c} changed`);
    const p = planned.get(r.id);
    const before = metaOf(r.meta), after = metaOf(now.meta);
    const set = p ? ['priceSource', 'priceAt', 'repaired'] : [];
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (!set.includes(k) && JSON.stringify(before[k]) !== JSON.stringify(after[k])) problems.push(`${r.id}: meta.${k} changed`);
    }
    if (p) {
      if (now.price_usd !== p.price || now.value_usd !== p.value) problems.push(`${r.id}: price ${now.price_usd}, value ${now.value_usd}, planned ${p.price}, ${p.value}`);
      if (after.priceSource !== 'pool_1h' || after.priceAt !== p.hour || after.repaired !== REPAIRED) problems.push(`${r.id}: meta keys not as planned`);
    } else if (now.price_usd !== r.price_usd || now.value_usd !== r.value_usd || now.meta !== r.meta) problems.push(`${r.id}: changed but not planned`);
  }
  return { firstPass, secondPass, problems };
}

// ---------------------------------------------------------------- the run

function main() {
  const args = process.argv.slice(2);
  const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const since = Date.parse(`${arg('--since') ?? '2026-10-21'}T00:00:00Z`);
  if (!Number.isFinite(since)) throw new Error('--since is not a day');
  const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out', 'repair');
  mkdirSync(OUT, { recursive: true });
  /** Read-only SELECT on production, retried on Cloudflare's transient 7403. */
  const d1 = <T = any>(sql: string): T[] => {
    for (let i = 0; ; i++) {
      try { return d1once<T>(sql); } catch (e) { if (i >= 5) throw e; }
    }
  };
  const readings = (key: string, from: number, to: number) =>
    d1<Reading>(`SELECT ts, value FROM metrics WHERE key = ${sqlStr(key)} AND ts >= ${from} AND ts <= ${to} ORDER BY ts`).map((q) => ({ ts: Number(q.ts), value: Number(q.value) }));

  const moves = d1<Move>(`SELECT ${COLS.join(', ')} FROM flows WHERE price_usd IS NULL AND ts >= ${since} AND amount_num > 0 AND json_extract(meta, '$.tokenSymbol') IS NULL ORDER BY ts, id`)
    .map((r) => ({ ...r, ts: Number(r.ts), height: Number(r.height) }));
  if (!moves.length) { console.error(`no NAM move without a price since ${iso(since)}`); return; }
  const first = moves[0].ts, last = moves[moves.length - 1].ts;
  const quotes = readings('price.usd', first - QUOTE_MATCH_MS, last);
  const closeRows = readings('price.pool_1h', hourOf(first), hourOf(last));
  const closes = new Map(closeRows.map((c) => [c.ts, c.value]));
  const plan = planPoolHourPrices(moves, quotes, closes);
  const sql = plan.priced.map((p) => poolHourSql(p));
  const check = checkOnCopy(moves, plan, sql);
  if (check.problems.length || check.firstPass !== plan.priced.length || check.secondPass !== 0) {
    throw new Error(`the SQL does not do what is planned on a copy: first pass ${check.firstPass} of ${plan.priced.length}, second pass ${check.secondPass}; ${check.problems.slice(0, 5).join('; ')}`);
  }

  // What else stands beside each close: the executed median of the hour's trades (price.swap_1h), when it had some,
  // whether the pool moved in the hour (price.pool_1h.flat), and the quotes either side of each gap.
  const hours = [...new Set(plan.priced.map((p) => p.hour))].sort((a, b) => a - b);
  const swap = new Map(readings('price.swap_1h', hours[0] ?? first, hours[hours.length - 1] ?? last).map((x) => [x.ts, x.value]));
  const flat = new Map(readings('price.pool_1h.flat', hours[0] ?? first, hours[hours.length - 1] ?? last).map((x) => [x.ts, x.value]));
  const edge = (cond: string, order: string) => d1<Reading>(`SELECT ts, value FROM metrics WHERE key = 'price.usd' AND ${cond} ORDER BY ts ${order} LIMIT 1`).map((q) => ({ ts: Number(q.ts), value: Number(q.value) }));
  const bracketed = [...edge(`ts < ${first - QUOTE_MATCH_MS}`, 'DESC'), ...quotes, ...edge(`ts > ${last}`, 'ASC')];
  // How the site values each priced trade with a settle record: its settle price, priced with the coin quotes stored for its minute.
  const coinQuotes: Record<string, Reading[]> = {};
  for (const p of plan.priced) {
    const rec = settleMetaOf(metaOf(p.move.meta));
    if (rec) for (const c of quotesNeeded(rec)) if (QUOTE_KEYS[c] && !coinQuotes[c]) coinQuotes[c] = readings(QUOTE_KEYS[c], first - QUOTE_MATCH_MS, last);
  }
  const settleWord = (p: Priced): string => {
    const rec = (p.move.kind === 'buy' || p.move.kind === 'sell') ? settleMetaOf(metaOf(p.move.meta)) : null;
    if (!rec) return '';
    const q: Record<string, number> = {};
    for (const c of quotesNeeded(rec)) { const r = coinQuotes[c] ? quoteBefore(coinQuotes[c], p.move.ts) : null; if (r) q[c] = r.value; }
    const s = settleOf(p.move.kind as 'buy' | 'sell', rec, q);
    return s ? `settled at ${s.usdPerNam} a NAM (shown)` : 'settle record not priced (the value shown is this one)';
  };

  const tally = new Map<string, { n: number; nam: number; usd: number }>();
  const tsv = ['id\tts\tchain\tkind\tnam\thour\tpool_close_usd\tvalue_usd\tswap_1h_median\tsettle'];
  for (const p of plan.priced) {
    const k = `${p.move.chain} ${p.move.kind}${metaOf(p.move.meta).arb === true ? ' (bot round trip)' : ''}`;
    const t = tally.get(k) ?? { n: 0, nam: 0, usd: 0 };
    tally.set(k, { n: t.n + 1, nam: t.nam + p.move.amount_num, usd: t.usd + p.value });
    tsv.push([p.move.id, iso(p.move.ts), p.move.chain, p.move.kind, p.move.amount_num, iso(p.hour).slice(0, 16), p.price, p.value, swap.get(p.hour) ?? '', settleWord(p)].join('\t'));
  }
  const left = [...plan.left, ...plan.skipped].map((l) => `${l.move.id}\t${iso(l.move.ts)}\t${l.move.chain}\t${l.move.kind}\t${l.move.amount_num}\t${l.why}`);
  writeFileSync(join(OUT, 'pool-hour-prices.sql'), sql.join('\n') + '\n');
  writeFileSync(join(OUT, 'pool-hour-prices.tsv'), tsv.join('\n') + '\n');
  writeFileSync(join(OUT, 'pool-hour-prices.json'), JSON.stringify(plan.priced.map((p) => plannedRow(p)), null, 1) + '\n');
  writeFileSync(join(OUT, 'pool-hour-left.tsv'), left.join('\n') + (left.length ? '\n' : ''));

  const sum = (xs: Priced[], f: (p: Priced) => number) => xs.reduce((a, p) => a + f(p), 0);
  const gaps: string[] = [];
  for (let i = 1; i < bracketed.length; i++) {
    const a = bracketed[i - 1], b = bracketed[i];
    if (b.ts - a.ts <= QUOTE_MATCH_MS) continue;
    const n = plan.priced.filter((p) => p.move.ts > a.ts + QUOTE_MATCH_MS && p.move.ts < b.ts).length;
    gaps.push(`  ${iso(a.ts)} (${a.value}) .. ${iso(b.ts)} (${b.value}): ${((b.ts - a.ts) / 60_000).toFixed(1)} min, ${n} of the moves priced here`);
  }
  const report = [
    `scripts/repair-pool-hour-prices.ts, run ${iso(Date.now())} UTC: NAM moves without a price since ${iso(since)} UTC, read from production (SELECT only)`,
    `${moves.length} moves without a price, ${moves.length ? `${iso(first)} .. ${iso(last)}` : '-'}; ${quotes.length} price.usd readings and ${closeRows.length} price.pool_1h closes read`,
    `stored quotes more than ${QUOTE_MATCH_MS / 60_000} min apart around them (the reading before the gap, the reading after it):${gaps.length ? '' : ' none'}`,
    ...gaps,
    '',
    `priced from the pool's hourly close: ${plan.priced.length} moves, ${sum(plan.priced, (p) => p.move.amount_num)} NAM, ${sum(plan.priced, (p) => p.value)} USD`,
    ...[...tally].map(([k, t]) => `  ${k}: ${t.n} moves, ${t.nam} NAM, ${t.usd} USD`),
    'by hour (the close; whether the pool moved in the hour; the executed median of that hour\'s trades where it had some):',
    ...hours.map((h) => {
      const xs = plan.priced.filter((p) => p.hour === h);
      return `  ${iso(h).slice(0, 16)} UTC: close ${closes.get(h)}${flat.get(h) === 1 ? ' (a flat hour: no trade moved the pool)' : ''}${swap.has(h) ? `, executed median ${swap.get(h)}` : ''}: ${xs.length} moves, ${sum(xs, (p) => p.move.amount_num)} NAM, ${sum(xs, (p) => p.value)} USD`;
    }),
    'each move (id, kind, time UTC, NAM, the hour\'s close, the value; a trade with a settle record says how the site shows it):',
    ...plan.priced.map((p) => `  ${p.move.id}  ${p.move.chain} ${p.move.kind}${metaOf(p.move.meta).arb === true ? ' (bot)' : ''}  ${iso(p.move.ts)}  ${p.move.amount_num} NAM  close ${p.price} (${iso(p.hour).slice(11, 16)})  ${p.value} USD${settleWord(p) ? `  ${settleWord(p)}` : ''}`),
    '',
    `left without a price: ${plan.left.length}`,
    ...plan.left.map((l) => `  ${l.move.id}  ${l.move.kind}  ${iso(l.move.ts)}  ${l.move.amount_num} NAM: ${l.why}`),
    `not this repair's: ${plan.skipped.length}`,
    ...plan.skipped.map((l) => `  ${l.move.id}  ${l.move.kind}  ${iso(l.move.ts)}  ${l.move.amount_num} NAM: ${l.why}`),
    '',
    `check on a copy (the ${moves.length} rows as read, in an in-memory SQLite database with the migrations): the first apply changed ${check.firstPass} rows, the second ${check.secondPass}; `
      + `no column but price_usd, value_usd and meta changed, and no meta key but priceSource, priceAt and repaired`,
  ];
  writeFileSync(join(OUT, 'pool-hour-report.txt'), report.join('\n') + '\n');
  console.error(report.slice(0, 6).join('\n'));
  console.error(`to ${OUT}: pool-hour-prices.sql (${sql.length} statements), .tsv, .json, pool-hour-left.tsv, pool-hour-report.txt`);
}

const isMain = process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
