/**
 * Prices for the NAM moves stored without one while the live hub had no quote (2026-10-21/22: it asked the Osmosis
 * quote service every 6 s and got nothing back, worker/src/live-quote.ts). Reads the remote D1 with read-only
 * SELECTs and writes SQL for the owner to check and apply (scripts/d1-apply.ts). Writes nothing itself.
 *
 *   npx tsx scripts/repair-quote-prices.ts [--since YYYY-MM-DD]          # 1: scripts/out/repair/quote-prices.sql
 *   npx tsx scripts/repair-quote-prices.ts --hours [--since YYYY-MM-DD]  # 2, after 1 is applied: quote-hours.sql
 *
 * 1. Each move since --since (default 2026-10-21) with no price, in NAM (a move in another coin is never priced as NAM),
 *    gets the quote the cron stored for its own minute: the newest price.usd reading at or before it, at most
 *    QUOTE_MATCH_MS before it, as the hub now prices a move it finds late (HubQuote.at). value_usd is that price times
 *    the move's NAM, and meta.priceSource 'spot' says it is the quote ("quote at the time"). A move with no reading in
 *    that window keeps no price and is listed. Each statement changes the row only while it still has no price.
 * 2. Each trade-hour with a buy or sell priced by 1 gets its rollup keys again (series.ts swapHourStmts, the cron's
 *    own code, over the hour's rows as they are now): dex.swaps_1h.usd (written only when every trade of the hour has
 *    a value) and the buy and sell averages changed; the other keys come out as they were. Each closed UTC day with a
 *    move priced by 1 gets its flow index again (series.ts dayAggregates and dayStmts, as the daily job writes it:
 *    flow_edges_daily replaced whole, activity_daily and the daily keys such as dex.volume_usd_daily). The daily job
 *    reads a day again only on the two days after it, so a day repaired later would keep its unpriced edges for good.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { d1 as d1once } from './lib';
import { QUOTE_MATCH_MS } from '../worker/src/analytics';
import { swapHourStmts, dayAggregates, dayStmts, isoDay, type SwapRow, type DayFlowRow } from '../worker/src/series';
import { DAY_FLOWS_SQL, REFUNDS_SQL } from '../worker/src/series-sql';
import { inlineSql } from '../worker/src/db';

const H = 3_600_000, D = 86_400_000;
const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const since = Date.parse(`${arg('--since') ?? '2026-10-21'}T00:00:00Z`);
if (!Number.isFinite(since)) throw new Error('--since is not a day');
const OUT = join(import.meta.dirname, 'out', 'repair');
mkdirSync(OUT, { recursive: true });
const sqlStr = (s: string) => `'${s.replace(/'/g, "''")}'`;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

/** Read-only SELECT on production, retried on Cloudflare's transient 7403. */
function d1<T = any>(sql: string): T[] {
  for (let i = 0; ; i++) {
    try { return d1once<T>(sql); } catch (e) { if (i >= 5) throw e; }
  }
}

if (!args.includes('--hours')) {
  const rows = d1<{ id: string; ts: number; chain: string; kind: string; amount_num: number }>(
    `SELECT id, ts, chain, kind, amount_num FROM flows WHERE price_usd IS NULL AND ts >= ${since} AND amount_num > 0 AND json_extract(meta, '$.tokenSymbol') IS NULL ORDER BY ts`,
  );
  if (!rows.length) { console.error('no move without a price'); process.exit(0); }
  const quotes = d1<{ ts: number; value: number }>(
    `SELECT ts, value FROM metrics WHERE key = 'price.usd' AND ts >= ${Number(rows[0].ts) - QUOTE_MATCH_MS} AND ts <= ${Number(rows[rows.length - 1].ts)} ORDER BY ts`,
  ).map((q) => ({ ts: Number(q.ts), value: Number(q.value) }));
  /** The newest reading at or before ts (binary search), or null. */
  const at = (ts: number) => {
    let lo = 0, hi = quotes.length - 1, best = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (quotes[m].ts <= ts) { best = m; lo = m + 1; } else hi = m - 1; }
    return best >= 0 ? quotes[best] : null;
  };
  const sql: string[] = [], listed: string[] = [], left: string[] = [];
  const tally = new Map<string, number>();
  for (const r of rows) {
    const ts = Number(r.ts), q = at(ts);
    if (!q || ts - q.ts > QUOTE_MATCH_MS || !(q.value > 0)) { left.push(`${r.id}\t${iso(ts)}\tno stored quote within ${QUOTE_MATCH_MS / 60_000} min before it`); continue; }
    sql.push(`UPDATE flows SET price_usd = ${q.value}, value_usd = ${q.value} * amount_num, meta = json_set(COALESCE(meta, '{}'), '$.priceSource', 'spot') WHERE id = ${sqlStr(r.id)} AND price_usd IS NULL;`);
    listed.push([r.id, iso(ts), r.chain, r.kind, r.amount_num, iso(q.ts), q.value].join('\t'));
    const k = `${r.chain} ${r.kind}`;
    tally.set(k, (tally.get(k) ?? 0) + 1);
  }
  writeFileSync(join(OUT, 'quote-prices.sql'), sql.join('\n') + '\n');
  writeFileSync(join(OUT, 'quote-prices.tsv'), ['id\tts\tchain\tkind\tnam\tquote_ts\tquote_usd', ...listed].join('\n') + '\n');
  writeFileSync(join(OUT, 'quote-prices-left.tsv'), left.join('\n') + '\n');
  console.error(`${rows.length} moves without a price since ${iso(since)}; ${sql.length} priced (${[...tally].map(([k, n]) => `${k} ${n}`).join(', ')}), ${left.length} left (quote-prices-left.tsv); ${quotes.length} stored quotes read`);
} else {
  // the trade-hours with a buy or sell priced by step 1 (its rows say so), closed hours only (the cron writes an open hour)
  const now = Date.now();
  const hours = d1<{ h: number }>(
    `SELECT DISTINCT ts - (ts % ${H}) AS h FROM flows WHERE chain = 'osmosis' AND kind IN ('buy', 'sell') AND ts >= ${since} AND json_extract(meta, '$.priceSource') = 'spot' ORDER BY h`,
  ).map((x) => Number(x.h)).filter((h) => h + H <= Math.floor(now / H) * H);
  const lines: string[] = [];
  for (const h of hours) {
    const rows = d1<SwapRow>(`SELECT id, ts, kind, amount_num, counter_denom, counter_amount, pool_id, value_usd, from_addr, to_addr, meta FROM flows WHERE kind IN ('buy', 'sell') AND chain = 'osmosis' AND ts >= ${h} AND ts < ${h + H}`)
      .map((r) => ({ ...r, ts: Number(r.ts) }));
    lines.push(...swapHourStmts(rows, h).map(inlineSql));
  }
  const hourLines = lines.length;
  // the closed UTC days with a move priced by step 1 (closed: the daily job writes a day only once it has ended)
  const days = d1<{ d: number }>(
    `SELECT DISTINCT ts - (ts % ${D}) AS d FROM flows WHERE ts >= ${since} AND json_extract(meta, '$.priceSource') = 'spot' ORDER BY d`,
  ).map((x) => Number(x.d)).filter((d) => d + D <= Math.floor(now / D) * D);
  for (const d of days) {
    const rows = d1<DayFlowRow>(DAY_FLOWS_SQL.replace('f.ts >= ? AND f.ts < ?', `f.ts >= ${d} AND f.ts < ${d + D}`)).map((r) => ({ ...r, ts: Number(r.ts) }));
    const refunds = d1<DayFlowRow>(REFUNDS_SQL.replace('ts >= ? AND ts < ?', `ts >= ${d} AND ts < ${d + 4 * D}`)).map((r) => ({ ...r, ts: Number(r.ts) }));
    lines.push(...dayStmts(isoDay(d), dayAggregates(rows, refunds)).map(inlineSql));
  }
  writeFileSync(join(OUT, 'quote-hours.sql'), lines.join('\n') + '\n');
  console.error(`${hours.length} trade-hours (${hours.length ? `${iso(hours[0])} .. ${iso(hours[hours.length - 1])}` : '-'}): ${hourLines} statements; ${days.length} closed days (${days.map(isoDay).join(', ') || '-'}): ${lines.length - hourLines} statements; to quote-hours.sql`);
}
