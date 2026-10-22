/**
 * Re-derive the Namada flows the block parser wrote (worker/src/parse/namada.ts and namada-unbond.ts: the live scan
 * and scripts/repair-review2.ts legacy, rows with meta.innerTxHash; and the unbond rows of source 'namada-rpc') with
 * the parser as it is now. The group C fixes of 2026-10-21 (7f1dd3c, d3887b1, 2294855, 50cb1ca) changed how a bridge
 * row binds its packet (meta.channel, meta.packetSequence), how a shielded withdrawal names its Osmosis receiver, and
 * how the shielded pool's fee is read (meta.maspFeeNam). Reads the remote D1 with read-only SELECTs and every block
 * those rows are in from the public Namada RPCs, and writes SQL for the owner to check and apply (scripts/d1-apply.ts).
 * Writes nothing itself.
 *
 *   npx tsx scripts/rederive-namada.ts        # scripts/out/rederive/namada.sql + namada-report.json
 *
 * Each block is parsed as the live scan parses it (events, then with the wrappers' fee payers when the parse asks for
 * them, and the unbond requests when the block has any), and its rows compared with the stored ones by id. A row both
 * have gets an UPDATE of what the parser decides (ends, amount, kind and the parser's meta keys; its price follows a
 * changed amount), kept as stored: ts, height, price basis, tsSource, repairedFrom, source and any key the parser does
 * not write; each statement changes the row only while it is still as read. A row only the parser writes is inserted
 * with INSERT OR IGNORE at the block's time (a row another import stored under the same id, as the indexer's unbonds,
 * stays as it is), a NAM row priced at the quote stored for its minute ('spot'). A row only the store has is listed,
 * never deleted. Rows newer than an hour are left for another run (the live scan may still be writing their block).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { d1 as d1once } from './lib';
import { blockResults, blockTxs } from '../worker/src/sources/namada';
import { parseNamadaBlock } from '../worker/src/parse/namada';
import { feePayersOf } from '../worker/src/parse/namada-tx';
import { blockHasUnbond, parseNamadaUnbonds } from '../worker/src/parse/namada-unbond';
import { QUOTE_MATCH_MS } from '../worker/src/analytics';
import type { Flow } from '../shared/types';

const H = 3_600_000;
const OUT = join(import.meta.dirname, 'out', 'rederive');
mkdirSync(OUT, { recursive: true });
/** The keys the Namada parsers write into a row's meta; any other stored key is kept. */
const PARSER_KEYS = ['innerTxHash', 'descriptor', 'escrow', 'maspFeeNam', 'feeNam', 'otherNam', 'tokenSymbol', 'tokenAddress', 'packetSequence', 'channel', 'wrapper', 'validator', 'txKind', 'code', 'pairing', 'shielded', 'memo'];
const MARK = 7777;
const q = (v: unknown): string => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? (Number.isFinite(v) ? String(v) : 'NULL') : `'${String(v).replace(/'/g, "''")}'`);
const near = (a: number | null, b: number | null) => (a == null || b == null ? a == b : Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b)));
const sameJson = (a: unknown, b: unknown) => {
  const norm = (x: unknown): unknown => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([k], [l]) => (k < l ? -1 : 1)).map(([k, v]) => [k, norm(v)])) : typeof x === 'number' ? Number(x.toPrecision(12)) : x);
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function d1<T = any>(sql: string): T[] {
  for (let i = 0; ; i++) {
    try { return d1once<T>(sql); } catch (e) { if (i >= 5) throw e; }
  }
}

type Row = { id: string; height: number; ts: number; kind: string; from_addr: string | null; to_addr: string | null; amount_num: number; counter_denom: string | null; price_usd: number | null; value_usd: number | null; meta: string | null };
const now = Date.now();
const rows = d1<Row>(`SELECT id, height, ts, kind, from_addr, to_addr, amount_num, counter_denom, price_usd, value_usd, meta FROM flows WHERE chain = 'namada' AND (json_extract(meta, '$.innerTxHash') IS NOT NULL OR json_extract(meta, '$.source') = 'namada-rpc') AND ts < ${now - H}`)
  .map((r) => ({ ...r, height: Number(r.height), ts: Number(r.ts) }));
const byH = new Map<number, Row[]>();
for (const r of rows) (byH.get(r.height) ?? byH.set(r.height, []).get(r.height)!).push(r);
console.error(`${rows.length} parser rows in ${byH.size} blocks`);

const sql: string[] = [], report: Record<string, unknown>[] = [], listed: string[] = [], unread: number[] = [];
const tally: Record<string, number> = {};
const count = (k: string) => { tally[k] = (tally[k] ?? 0) + 1; };
let done = 0;
for (const [h, stored] of [...byH].sort((a, b) => a[0] - b[0])) {
  let flows: Flow[];
  try {
    const blk = await blockResults(h, stored[0].ts);
    let p = parseNamadaBlock(blk, MARK);
    if (p.feePayerWanted.length) p = parseNamadaBlock(blk, MARK, feePayersOf(await blockTxs(h)));
    flows = [...p.flows];
    if (blockHasUnbond(blk)) flows.push(...parseNamadaUnbonds(blk, await blockTxs(h), MARK).flows);
  } catch (e) {
    unread.push(h); count('block not readable');
    continue;
  }
  if (++done % 100 === 0) console.error(`${done}/${byH.size}`);
  const want = new Map(flows.map((f) => [f.id, f]));
  for (const r of stored) {
    const f = want.get(r.id);
    if (!f) { listed.push(`${r.id}\tstored, not written by the parser now: left as is`); count('stored only (listed)'); continue; }
    const sm = JSON.parse(r.meta ?? '{}') as Record<string, unknown>;
    const pm = Object.fromEntries(Object.entries(f.meta ?? {}).filter(([k]) => PARSER_KEYS.includes(k)));
    const set: Record<string, unknown> = {};
    const diff: Record<string, [unknown, unknown]> = {};
    const col = (c: keyof Row, v: unknown, isNum = false) => {
      const old = r[c] as unknown;
      if (isNum ? !near(old as number | null, v as number | null) : (old ?? null) !== (v ?? null)) { set[c] = v; diff[c] = [old, v]; }
    };
    col('kind', f.kind); col('from_addr', f.from); col('to_addr', f.to); col('amount_num', f.amount, true); col('counter_denom', f.counterDenom ?? null);
    const meta: Record<string, unknown> = Object.fromEntries(Object.entries(sm).filter(([k]) => !PARSER_KEYS.includes(k)));
    Object.assign(meta, pm);
    // a float that differs only past twelve significant digits (maspFeeNam sums) is the same reading
    const metaChanged = !sameJson(meta, sm);
    if (metaChanged) diff.meta = [Object.keys(sm).filter((k) => !sameJson(sm[k], meta[k])), Object.keys(meta).filter((k) => !sameJson(sm[k], meta[k]))];
    if ('amount_num' in set && r.price_usd != null) set.value_usd = r.price_usd * (set.amount_num as number);
    if (!Object.keys(set).length && !metaChanged) { count('same'); continue; }
    set.meta = JSON.stringify({ ...(metaChanged ? meta : sm), rederived: '2026-10-22' });
    sql.push(`UPDATE flows SET ${Object.entries(set).map(([c, v]) => `${c} = ${q(v)}`).join(', ')} WHERE id = ${q(r.id)} AND ABS(amount_num - ${q(r.amount_num)}) <= 1e-9 AND COALESCE(to_addr, '') = ${q(r.to_addr ?? '')} AND COALESCE(meta, '') = ${q(r.meta ?? '')};`);
    report.push({ id: r.id, height: h, effect: 'update', kind: r.kind, diff });
    count(`update ${Object.keys(diff).sort().join('+')}`);
  }
  for (const f of flows) {
    if (stored.some((r) => r.id === f.id)) continue;
    const quoted = f.priceUsd === MARK;
    const qt = quoted ? d1<{ ts: number; value: number }>(`SELECT ts, value FROM metrics WHERE key = 'price.usd' AND ts <= ${stored[0].ts} AND ts >= ${stored[0].ts - QUOTE_MATCH_MS} ORDER BY ts DESC LIMIT 1`)[0] ?? null : null;
    const price = quoted ? (qt ? Number(qt.value) : null) : f.priceUsd ?? null;
    const { priceSource: _ps, ...fm } = (f.meta ?? {}) as Record<string, unknown>;
    const meta = { ...fm, ...(quoted && price != null ? { priceSource: 'spot' } : {}), rederived: '2026-10-22' };
    sql.push(`INSERT OR IGNORE INTO flows (id,chain,height,ts,tx_hash,kind,from_addr,to_addr,amount_num,counter_denom,counter_amount,pool_id,price_usd,value_usd,meta) VALUES (${[f.id, 'namada', h, stored[0].ts, f.txHash, f.kind, f.from, f.to, f.amount, f.counterDenom ?? null, f.counterAmount ?? null, f.poolId ?? null, price, price == null ? null : price * f.amount, JSON.stringify(meta)].map(q).join(',')});`);
    report.push({ id: f.id, height: h, effect: 'insert or ignore', kind: f.kind, from: f.from, to: f.to, amount: f.amount, token: f.meta?.tokenSymbol ?? 'NAM', price });
    count(`insert or ignore ${f.kind}${f.meta?.tokenSymbol ? ` (${f.meta.tokenSymbol})` : ''}`);
  }
  await sleep(120);
}
writeFileSync(join(OUT, 'namada.sql'), sql.join('\n') + '\n');
writeFileSync(join(OUT, 'namada-report.json'), JSON.stringify({ at: new Date(now).toISOString(), tally, unread, listed, rows: report }, null, 1));
console.error(JSON.stringify(tally, null, 1));
console.error(`${sql.length} statements to ${join(OUT, 'namada.sql')}; ${unread.length} blocks unreadable, ${listed.length} listed`);
