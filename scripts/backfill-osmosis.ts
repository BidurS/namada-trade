/**
 * Osmosis backfill (runs locally).
 *
 *   npx tsx scripts/backfill-osmosis.ts
 *
 * Fetches all ~1,330 Osmosis NAM holders + past transactions on pool 3005 and IBC channel-98451.
 * Emits .sql chunks to scripts/out/sql/osmosis_*.sql
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchOsmosisHolders, searchOsmosisTxs } from '../worker/src/sources/osmosis';
import { normFromTxSearch, parseOsmosisTx, type OsmoCtx } from '../worker/src/parse/osmosis';
import { inlineSql, stmt } from '../worker/src/db';
import { fetchNamPools, fetchNamPrice } from '../worker/src/sources/sqs';
import { NAM, OSMOSIS } from '../worker/src/config';

const SQL = join(import.meta.dirname, 'out', 'sql');
mkdirSync(SQL, { recursive: true });

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

const KEPLR_KEY = process.env.KEPLR_KEY || '';
if (!KEPLR_KEY) { console.error('Set KEPLR_KEY (see .dev.vars)'); process.exit(1); }

async function main() {
  log(`Starting Osmosis backfill...`);

  // 1. Pools & price context
  const { pools } = await fetchNamPools();
  const poolAddrs = new Map<string, string>();
  for (const p of pools) {
    if (p.address) poolAddrs.set(p.address, p.id);
  }
  const { usd: priceUsd } = await fetchNamPrice();
  const ctx: OsmoCtx = {
    poolAddrs,
    priceUsd,
    assets: new Map([
      [OSMOSIS.usdcDenom, { symbol: 'USDC', decimals: 6, stable: true }],
      ['uosmo', { symbol: 'OSMO', decimals: 6 }],
    ]),
  };

  const now = Date.now();
  let file = 0, n = 0, buf: string[] = [];
  const flush = () => {
    if (!buf.length) return;
    writeFileSync(join(SQL, `osmosis_${String(file++).padStart(4, '0')}.sql`), buf.join('\n') + '\n');
    buf = []; n = 0;
  };
  const push = (s: string) => { buf.push(s); if (++n >= 5000) flush(); };

  // 2. Holders
  log(`Fetching Osmosis holders...`);
  const holders = await fetchOsmosisHolders(KEPLR_KEY);
  log(`Found ${holders.length} Osmosis holders`);

  for (const h of holders) {
    if (h.balanceNum > 0) {
      push(inlineSql(stmt.verifiedBalance('osmosis', h.address, h.balance, null, now, 'keplr_rest')));
    }
  }

  // 3. Pool labels
  for (const p of pools) {
    if (p.address) {
      push(inlineSql(stmt.label(p.address, 'osmosis', `Osmosis Pool #${p.id} (${p.pair})`, 'pool', 'auto', `Liquidity: $${p.liquidityUsd.toFixed(2)}`, now)));
    }
  }
  push(inlineSql(stmt.label(OSMOSIS.transferModule, 'osmosis', 'Osmosis IBC Transfer Module', 'module', 'auto', null, now)));

  // 4. Past transactions (pool 3005 swaps + IBC transfers)
  log(`Searching past Osmosis NAM txs...`);
  const queries = [
    "token_swapped.pool_id='3005'",
    `transfer.amount CONTAINS '${NAM.osmoHash}'`,
    `recv_packet.packet_dst_channel='${NAM.osmoChannel}'`,
    `send_packet.packet_src_channel='${NAM.osmoChannel}'`,
  ];

  const seenTx = new Set<string>();
  let flowCount = 0, moveCount = 0, linkCount = 0;

  for (const q of queries) {
    let page = 1;
    for (;;) {
      try {
        const { txs, total } = await searchOsmosisTxs(KEPLR_KEY, q, page, 50, 'desc');
        for (const raw of txs) {
          if (seenTx.has(raw.hash)) continue;
          seenTx.add(raw.hash);
          const norm = normFromTxSearch(raw, now);
          const parsed = parseOsmosisTx(norm, ctx);
          for (const f of parsed.flows) { push(inlineSql(stmt.flow(f))); flowCount++; }
          for (const m of parsed.moves) { push(inlineSql(stmt.move(m))); moveCount++; }
          for (const l of parsed.links) { push(inlineSql(stmt.link(l))); linkCount++; }
        }
        if (page * 50 >= total || txs.length === 0) break;
        page++;
      } catch (e) {
        log(`Query "${q}" page ${page} error:`, String(e).slice(0, 100));
        break;
      }
    }
  }

  flush();
  log(`Osmosis backfill done: ${file} files -> ${SQL} | ${holders.length} holders, ${flowCount} flows, ${moveCount} moves, ${linkCount} links`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
