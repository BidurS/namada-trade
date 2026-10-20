/**
 * One-off repairs found in review 2 (2026-10-17). Reads the remote D1 with read-only SELECTs and public nodes,
 * and writes SQL to scripts/out/repair/ for the owner to check and apply (scripts/d1-apply.ts). Writes nothing.
 * Run migration 0004 first (it deletes twin rows and adds the guard index).
 *
 *   npx tsx scripts/repair-review2.ts legacy    # Namada rows of an older parser build: re-read their blocks
 *   npx tsx scripts/repair-review2.ts refunds   # Osmosis bridge refunds and sends: real receiver, packet sequence
 *
 * legacy: rows whose id is namada:<inner hash>:<i> with neither meta.innerTxHash nor meta.source were written by
 *   the inner-hash parser, which put a whole shielded transfer on its first target (often the fee payer: block
 *   8,273,651 shows "40,000 NAM to tnam1qpmpp…", but the chain sent 0.144159 there and 40,000 to tnam1qq6wus66…).
 *   Each block is read again (block_results) and parsed by the current parser (largest target as recipient, the
 *   fee in meta.maspFeeNam); each old row is replaced by the current row for the same transfer event (same inner
 *   hash and event index), keeping its price and time-source notes. Rows the current parser does not produce are
 *   listed, not touched.
 * refunds: refunds of sends that timed out were stored with the relayer as the receiver and no packet sequence.
 *   Each refund transaction is read again: the 'timeout' event names the receiver, timeout_packet the sequence.
 *   Each bridge send of the last 40 days (public Osmosis nodes keep about six weeks) gets its packet sequence, so
 *   the worker can match refunds to sends exactly (worker/src/analytics.ts timedOutSends).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { d1 as d1Once } from './lib';
import { blockResults } from '../worker/src/sources/namada';
import { parseNamadaBlock } from '../worker/src/parse/namada';
import { normFromTxSearch, parseOsmosisTx, type OsmoCtx } from '../worker/src/parse/osmosis';
import { inlineSql, stmt } from '../worker/src/db';
import { NAM, OSMOSIS } from '../worker/src/config';
import type { Flow } from '../shared/types';

const OUT = join(import.meta.dirname, 'out', 'repair');
mkdirSync(OUT, { recursive: true });
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const q = (v: string) => `'${v.replace(/'/g, "''")}'`;
const metaOf = (m: string | null) => { try { return m ? JSON.parse(m) : {}; } catch { return {}; } };
const OSMO_RPCS = [OSMOSIS.publicRpc, 'https://osmosis-rpc.polkachu.com'];
/** A read-only remote query, retried: the API sometimes answers 7403 for a moment. */
function d1<T = any>(sql: string): T[] {
  let last: unknown;
  for (let i = 0; i < 4; i++) { try { return d1Once<T>(sql); } catch (e) { last = e; execSleep(2000 * (i + 1)); } }
  throw last;
}
function execSleep(ms: number) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

async function getJson(url: string, tries = 4): Promise<any> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(25000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) { last = e; await sleep(700 * 2 ** i); }
  }
  throw last;
}
const osmo = async (path: string) => {
  let last: unknown;
  for (const r of OSMO_RPCS) { try { return await getJson(`${r}${path}`, 2); } catch (e) { last = e; } }
  throw last;
};

async function legacy() {
  const rows = d1<{ id: string; height: number; ts: number; tx_hash: string; kind: string; from_addr: string | null; to_addr: string | null; amount_num: number; price_usd: number | null; meta: string | null }>(
    `SELECT id, height, ts, tx_hash, kind, from_addr, to_addr, amount_num, price_usd, meta FROM flows WHERE chain='namada' AND id LIKE 'namada:%'
       AND (meta IS NULL OR (meta NOT LIKE '%"innerTxHash"%' AND meta NOT LIKE '%"source":%'))`,
  ).filter((r) => r.id.startsWith(`namada:${r.tx_hash}:`));
  const heights = [...new Set(rows.map((r) => r.height))].sort((a, b) => a - b);
  log(`legacy: ${rows.length} rows in ${heights.length} blocks`);
  const existing = new Set<string>();
  for (let i = 0; i < heights.length; i += 200) {
    for (const r of d1<{ id: string }>(`SELECT id FROM flows WHERE chain='namada' AND height IN (${heights.slice(i, i + 200).join(',')})`)) existing.add(r.id);
  }
  const lines: string[] = [];
  const report: Record<string, unknown>[] = [];
  let replaced = 0, deletedTwins = 0, changedRecipient = 0, unmatched = 0;
  for (const h of heights) {
    const mine = rows.filter((r) => r.height === h);
    let parsed: Flow[];
    try { parsed = parseNamadaBlock(await blockResults(h, mine[0].ts), null).flows; } catch (e) { log(`block ${h}: ${String(e).slice(0, 100)}`); unmatched += mine.length; continue; }
    for (const r of mine) {
      const suffix = r.id.slice(`namada:${r.tx_hash}`.length);
      const f = parsed.find((x) => String(x.meta?.innerTxHash ?? '') === r.tx_hash && x.id.endsWith(suffix) && x.id.slice(0, -suffix.length).split(':').length === 2);
      if (!f) { unmatched++; report.push({ id: r.id, height: h, kind: r.kind, nam: r.amount_num, why: 'the current parser has no row for this event' }); continue; }
      lines.push(`DELETE FROM flows WHERE id = ${q(r.id)};`);
      if (existing.has(f.id)) { deletedTwins++; continue; }
      const old = metaOf(r.meta);
      const price = r.price_usd ?? null;
      const row: Flow = {
        ...f, ts: r.ts, priceUsd: price, valueUsd: price != null ? price * f.amount : null,
        meta: { ...(f.meta ?? {}), ...(old.priceSource ? { priceSource: old.priceSource } : {}), ...(old.tsSource ? { tsSource: old.tsSource } : {}), repairedFrom: r.id },
      };
      lines.push(inlineSql(stmt.flow(row)));
      replaced++;
      if (row.to !== r.to_addr || Math.abs(row.amount - r.amount_num) > 1e-6) {
        changedRecipient++;
        report.push({ id: r.id, now: row.id, height: h, kind: row.kind, before: { to: r.to_addr, nam: r.amount_num }, after: { to: row.to, nam: row.amount, maspFeeNam: row.meta?.maspFeeNam ?? null } });
      }
    }
    await sleep(120);
  }
  writeFileSync(join(OUT, 'legacy_flows.sql'), lines.join('\n') + '\n');
  writeFileSync(join(OUT, 'legacy_report.json'), JSON.stringify({ rows: rows.length, blocks: heights.length, replaced, deletedTwins, changedRecipientOrAmount: changedRecipient, unmatched, at: Date.now(), details: report }, null, 1));
  log(`legacy: ${replaced} rows re-keyed to the current parse (${changedRecipient} with another recipient or amount), ${deletedTwins} twins deleted, ${unmatched} left as they are → scripts/out/repair/legacy_flows.sql`);
}

async function refunds() {
  const ctx: OsmoCtx = { poolAddrs: new Map(), priceUsd: null, assets: new Map() };
  const lines: string[] = [];
  const report: Record<string, unknown>[] = [];
  // The amount too: one transaction can time out several packets, and older rows gave each refund the sum of all.
  const fix = (id: string, f: Flow, oldMeta: Record<string, unknown>) => {
    const meta = { ...oldMeta, ...(f.meta ?? {}) };
    lines.push(`UPDATE flows SET to_addr = ${f.to ? q(f.to) : 'NULL'}, amount_num = ${f.amount}, value_usd = CASE WHEN price_usd IS NULL THEN NULL ELSE price_usd * ${f.amount} END, meta = ${q(JSON.stringify(meta))} WHERE id = ${q(id)};`);
  };
  const reparse = async (hash: string, ts: number) => {
    const r = await osmo(`/tx?hash=0x${hash}`);
    return parseOsmosisTx(normFromTxSearch(r.result, ts), ctx).flows;
  };
  const refundRows = d1<{ id: string; tx_hash: string; ts: number; to_addr: string | null; amount_num: number; meta: string | null }>(
    `SELECT id, tx_hash, ts, to_addr, amount_num, meta FROM flows WHERE chain='osmosis' AND kind='other' AND meta LIKE '%"ibcTimeoutRefund":true%' AND meta NOT LIKE '%refundReceiver%'`,
  );
  log(`refunds: ${refundRows.length} refund rows without their receiver`);
  for (const r of refundRows) {
    try {
      const f = (await reparse(r.tx_hash, r.ts)).find((x) => x.id === r.id);
      if (!f) { report.push({ id: r.id, why: 'no refund in the transaction as read now' }); continue; }
      fix(r.id, f, metaOf(r.meta));
      report.push({ id: r.id, before: { to: r.to_addr, nam: r.amount_num }, after: { to: f.to, nam: f.amount }, packetSequence: f.meta?.packetSequence });
    } catch (e) { report.push({ id: r.id, why: String(e).slice(0, 120) }); }
    await sleep(150);
  }
  const sends = d1<{ id: string; tx_hash: string; ts: number; to_addr: string | null; meta: string | null }>(
    `SELECT id, tx_hash, ts, to_addr, meta FROM flows WHERE chain='osmosis' AND kind='ibc_out' AND ts >= ${Date.now() - 40 * 86400000} AND (meta IS NULL OR meta NOT LIKE '%packetSequence%')`,
  );
  log(`refunds: ${sends.length} bridge sends of the last 40 days without their packet sequence`);
  let seq = 0;
  for (const s of sends) {
    try {
      const f = (await reparse(s.tx_hash, s.ts)).find((x) => x.id === s.id);
      if (f?.meta?.packetSequence) { fix(s.id, { ...f, to: s.to_addr }, metaOf(s.meta)); seq++; }
    } catch (e) { report.push({ id: s.id, why: String(e).slice(0, 120) }); }
    await sleep(150);
  }
  writeFileSync(join(OUT, 'osmosis_refunds.sql'), lines.join('\n') + '\n');
  writeFileSync(join(OUT, 'osmosis_refunds_report.json'), JSON.stringify({ refunds: refundRows.length, sendsWithSequence: seq, sends: sends.length, channel: NAM.osmoChannel, at: Date.now(), details: report }, null, 1));
  log(`refunds: ${lines.length} updates → scripts/out/repair/osmosis_refunds.sql`);
}

const step = process.argv[2];
(step === 'legacy' ? legacy() : step === 'refunds' ? refunds() : Promise.reject(new Error('usage: legacy | refunds'))).catch((e) => { console.error(e); process.exit(1); });
