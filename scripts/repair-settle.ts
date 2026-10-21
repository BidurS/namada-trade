/**
 * The settle record (meta.settle, shared/settle.ts) for Osmosis swap rows written before the parser kept one
 * (2026-10-21). Reads the remote D1 with read-only SELECTs and a public Osmosis node, and writes SQL to
 * scripts/out/repair/settle.sql for the owner to check and apply (scripts/d1-apply.ts). Writes nothing itself.
 *
 *   node --experimental-strip-types scripts/repair-settle.ts [days=40]
 *
 * Each swap row of the last `days` days (public nodes keep about six weeks) without a settle record has its
 * transaction read again and parsed by the current parser. The record is added only when the parser makes the same
 * row (same id, kind and trader); the row's other columns are left as they are. Rows it cannot read or match are
 * listed, not touched.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { d1 } from './lib';
import { normFromTxSearch, parseOsmosisTx, type OsmoCtx } from '../worker/src/parse/osmosis';
import { fetchNamPools } from '../worker/src/sources/sqs';
import { OSMOSIS } from '../worker/src/config';
import { settleOf, quotesNeeded, type SettleMeta } from '../shared/settle';

const RPCS = [OSMOSIS.publicRpc, 'https://osmosis-rpc.polkachu.com'];
const days = Number(process.argv[2] ?? 40);
const sqlStr = (s: string) => `'${s.replace(/'/g, "''")}'`;

async function tx(hash: string): Promise<any> {
  for (let i = 0; i < 6; i++) {
    const url = `${RPCS[i % RPCS.length]}/tx?hash=0x${hash}`;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (r.ok) return (await r.json()).result;
    } catch { /* next node */ }
    await new Promise((ok) => setTimeout(ok, 500 * (i + 1)));
  }
  return null;
}

const since = Date.now() - days * 86_400_000;
const rows = d1<{ id: string; ts: number; kind: string; tx_hash: string; amount_num: number; meta: string | null }>(
  `SELECT id, ts, kind, tx_hash, amount_num, meta FROM flows WHERE chain = 'osmosis' AND kind IN ('buy','sell') AND ts >= ${since} AND json_extract(meta, '$.settle') IS NULL ORDER BY ts DESC`,
);
const pools = await fetchNamPools();
const ctx: OsmoCtx = {
  poolAddrs: new Map(pools.pools.map((p) => [p.address, p.id])),
  priceUsd: null,
  assets: new Map([
    [OSMOSIS.usdcDenom, { symbol: 'USDC', decimals: 6, stable: true }],
    ['uosmo', { symbol: 'OSMO', decimals: 6 }],
  ]),
};
console.error(`${rows.length} swap rows without a settle record since ${new Date(since).toISOString()}; ${ctx.poolAddrs.size} pool addresses`);

const out: string[] = [], skipped: string[] = [];
const byHash = new Map<string, typeof rows>();
for (const r of rows) byHash.set(r.tx_hash, [...(byHash.get(r.tx_hash) ?? []), r]);
const hashes = [...byHash.keys()];
let done = 0;
const work = async () => {
  for (;;) {
    const h = hashes.shift();
    if (!h) return;
    const t = await tx(h);
    done++;
    if (done % 50 === 0) console.error(`${done}/${byHash.size}`);
    for (const r of byHash.get(h)!) {
      if (!t) { skipped.push(`${r.id}\tnot readable`); continue; }
      const f = parseOsmosisTx(normFromTxSearch(t, Number(r.ts)), ctx).flows.find((x) => x.id === r.id);
      const meta = JSON.parse(r.meta ?? '{}');
      if (!f || f.kind !== r.kind || (f.meta.trader ?? null) !== (meta.trader ?? null)) { skipped.push(`${r.id}\tparsed differently`); continue; }
      const s = f.meta.settle as SettleMeta | undefined;
      if (!s) { skipped.push(`${r.id}\tno settle record (no coin of the trader's own came back)`); continue; }
      const p = settleOf(r.kind as 'buy' | 'sell', s);
      console.log([r.id.slice(8, 20), r.kind, r.amount_num.toFixed(0), (-s.nam).toFixed(2), JSON.stringify(s.coins), p ? p.usdPerNam.toPrecision(4) : `needs ${quotesNeeded(s).join(',')}`].join('\t'));
      out.push(`UPDATE flows SET meta = json_set(COALESCE(meta, '{}'), '$.settle', json(${sqlStr(JSON.stringify(s))})) WHERE id = ${sqlStr(r.id)} AND json_extract(meta, '$.settle') IS NULL;`);
    }
  }
};
await Promise.all([work(), work(), work()]);
const dir = join(import.meta.dirname, 'out', 'repair');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'settle.sql'), out.join('\n') + '\n');
writeFileSync(join(dir, 'settle-skipped.tsv'), skipped.join('\n') + '\n');
console.error(`${out.length} updates to ${join(dir, 'settle.sql')}; ${skipped.length} left (settle-skipped.tsv)`);
