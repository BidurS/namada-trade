/**
 * History backfill (runs locally, resumable). Writes SQL to scripts/out/history/*.sql, then upload with
 *   npx wrangler d1 execute namada-trade-db --remote --file=<file>
 *
 *   node --experimental-strip-types scripts/backfill-history.ts osmo-ts     # 1. real block times for backfilled Osmosis rows
 *   node --experimental-strip-types scripts/backfill-history.ts price       # 2. hourly NAM price from executed USDC swaps
 *   node --experimental-strip-types scripts/backfill-history.ts namada      # 3. pre-index Namada history from the public indexer
 *   node --experimental-strip-types scripts/backfill-history.ts masp        # 4. MASP NAM balance read off the chain (post-balances) + corrective flows
 *
 * Every row written here records where its timestamp and price came from (meta.tsSource / meta.priceSource),
 * so the UI can tell exact values from estimates.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = join(import.meta.dirname, 'out', 'history');
mkdirSync(OUT, { recursive: true });
const P = (f: string) => join(OUT, f);
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Timestamp the original Osmosis backfill stamped on every row (import time, not block time). */
const OSMO_BACKFILL_TS = 1792036810093;
const NAM_TOKEN = 'tnam1q9gr66cvu4hrzm0sd5kmlnjje82gs3xlfg3v6nu7';
const MASP = 'tnam1pcqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzmefah';
const INDEXER = 'https://indexer.namada.net';
const NAMADA_RPCS = ['https://rpc-namada.5elementsnodes.com', 'https://rpc.papadritta.com'];
const OSMO_RPCS = ['https://rpc-osmosis.ecostake.com', 'https://osmosis-rpc.polkachu.com', 'https://osmosis-rpc.publicnode.com'];

// ------------------------------------------------------------------ helpers
function d1<T = any>(sql: string): T[] {
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'namada-trade-db', '--remote', '--json', '--command', sql], {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const parsed = JSON.parse(out);
  return parsed.flatMap((r: any) => r.results) as T[];
}

async function getJson(url: string, tries = 5): Promise<any> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'NamadaTrade-backfill/1.0', Accept: 'application/json' }, signal: AbortSignal.timeout(25000) });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
      return await res.json();
    } catch (e) {
      last = e;
      await sleep(800 * 2 ** i);
    }
  }
  throw last;
}

async function pool<T>(items: T[], n: number, fn: (t: T, i: number) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k], k); }
  }));
}

const q = (v: unknown): string =>
  v === null || v === undefined ? 'NULL' : typeof v === 'number' ? (Number.isFinite(v) ? String(v) : 'NULL') : `'${String(v).replace(/'/g, "''")}'`;

function writeChunks(prefix: string, lines: string[], per = 4000) {
  let n = 0;
  for (let i = 0; i < lines.length; i += per) {
    writeFileSync(P(`${prefix}_${String(n++).padStart(3, '0')}.sql`), lines.slice(i, i + per).join('\n') + '\n');
  }
  log(`${prefix}: ${lines.length} statements in ${n} file(s)`);
}

/** Block times for heights via /blockchain (20 metas per call), trying each RPC in turn. */
async function blockTimes(rpcs: string[], heights: number[], conc = 4): Promise<Map<number, number>> {
  const want = [...new Set(heights)].sort((a, b) => a - b);
  const windows: [number, number][] = [];
  for (let i = 0; i < want.length; ) {
    const lo = want[i];
    let j = i;
    while (j + 1 < want.length && want[j + 1] - lo < 20) j++;
    windows.push([lo, want[j]]);
    i = j + 1;
  }
  const out = new Map<number, number>();
  let done = 0;
  await pool(windows, conc, async ([lo, hi]) => {
    for (const rpc of rpcs) {
      try {
        const r = await getJson(`${rpc}/blockchain?minHeight=${lo}&maxHeight=${hi}`, 3);
        for (const m of r.result.block_metas) out.set(Number(m.header.height), Date.parse(m.header.time));
        break;
      } catch {}
    }
    if (++done % 200 === 0) log(`  block times ${done}/${windows.length}`);
  });
  return out;
}

/** Piecewise-linear height -> time from sorted anchors; extrapolates at the ends. */
function interpolator(anchors: [number, number][]) {
  const a = [...anchors].sort((x, y) => x[0] - y[0]);
  return (h: number): number => {
    let i = a.findIndex(([ah]) => ah >= h);
    if (i === -1) i = a.length - 1;
    if (i === 0) i = 1;
    const [h0, t0] = a[i - 1], [h1, t1] = a[i];
    return Math.round(t0 + ((h - h0) * (t1 - t0)) / (h1 - h0));
  };
}

// ------------------------------------------------------------------ 1. osmo-ts
async function osmoTs() {
  const rows = d1<{ height: number }>(`SELECT DISTINCT height FROM flows WHERE chain='osmosis' AND ts=${OSMO_BACKFILL_TS}
                                       UNION SELECT DISTINCT height FROM moves WHERE chain='osmosis' AND ts=${OSMO_BACKFILL_TS}`);
  const heights = rows.map((r) => r.height);
  log(`osmo-ts: ${heights.length} heights carry the import timestamp`);
  const exact = await blockTimes(OSMO_RPCS, heights);
  const missing = heights.filter((h) => !exact.has(h));
  log(`osmo-ts: ${exact.size} exact block times, ${missing.length} below public-node retention`);

  // Extrapolate pruned heights from the earliest 200 exact anchors (Osmosis block time is steady over weeks).
  const anchors = [...exact.entries()].sort((a, b) => a[0] - b[0]);
  const fit = anchors.slice(0, 200);
  const n = fit.length;
  const mh = fit.reduce((s, [h]) => s + h, 0) / n, mt = fit.reduce((s, [, t]) => s + t, 0) / n;
  const slope = fit.reduce((s, [h, t]) => s + (h - mh) * (t - mt), 0) / fit.reduce((s, [h]) => s + (h - mh) ** 2, 0);
  log(`osmo-ts: fitted block time ${(slope / 1000).toFixed(3)}s from ${n} anchors`);
  const est = (h: number) => Math.round(mt + (h - mh) * slope);

  const tsOf = new Map<number, { ts: number; src: string }>();
  for (const h of heights) tsOf.set(h, exact.has(h) ? { ts: exact.get(h)!, src: 'block' } : { ts: est(h), src: 'extrapolated' });
  writeFileSync(P('osmo_ts.json'), JSON.stringify([...tsOf.entries()]));

  const lines: string[] = [];
  for (const [h, { ts, src }] of tsOf) {
    lines.push(`UPDATE flows SET ts=${ts}, meta=json_set(COALESCE(meta,'{}'),'$.tsSource',${q(src)}) WHERE chain='osmosis' AND height=${h} AND ts=${OSMO_BACKFILL_TS};`);
    lines.push(`UPDATE moves SET ts=${ts} WHERE chain='osmosis' AND height=${h} AND ts=${OSMO_BACKFILL_TS};`);
  }
  // Cross-chain links were stamped with the import time too; rebuild their first/last seen from the corrected flows.
  lines.push(`UPDATE address_links SET
    first_seen=COALESCE((SELECT MIN(ts) FROM flows f WHERE (f.from_addr=address_links.osmo_addr AND f.to_addr=address_links.namada_addr) OR (f.from_addr=address_links.namada_addr AND f.to_addr=address_links.osmo_addr)), first_seen),
    last_seen=COALESCE((SELECT MAX(ts) FROM flows f WHERE (f.from_addr=address_links.osmo_addr AND f.to_addr=address_links.namada_addr) OR (f.from_addr=address_links.namada_addr AND f.to_addr=address_links.osmo_addr)), last_seen);`);
  writeChunks('01_osmo_ts', lines);
}

// ------------------------------------------------------------------ 2. price
async function price() {
  // Needs osmo-ts uploaded first so swaps sit at their real times.
  // Single-pool swaps only: multi-pool routes are cyclic arbs whose recorded USDC is only one leg.
  const swaps = d1<{ id: string; ts: number; amount_num: number; counter_amount: number; kind: string }>(
    `SELECT id, ts, amount_num, counter_amount, kind FROM flows
     WHERE chain='osmosis' AND counter_denom='USDC' AND kind IN ('buy','sell') AND amount_num >= 50 AND counter_amount > 0
       AND pool_id IS NOT NULL AND pool_id NOT LIKE '%,%'`,
  );
  log(`price: ${swaps.length} USDC swaps`);
  const byHour = new Map<number, number[]>();
  for (const s of swaps) {
    const hr = Math.floor(s.ts / 3600000) * 3600000;
    (byHour.get(hr) ?? byHour.set(hr, []).get(hr)!).push(s.counter_amount / s.amount_num);
  }
  const median = (xs: number[]) => { const a = [...xs].sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
  const series: [number, number, number][] = [];
  for (const [hr, px] of [...byHour.entries()].sort((a, b) => a[0] - b[0])) {
    const m = median(px);
    const kept = px.filter((p) => Math.abs(p / m - 1) <= 0.35); // drop multi-hop/arb artefacts far off the hour's median
    if (kept.length) series.push([hr, median(kept), kept.length]);
  }
  writeFileSync(P('price_hourly.json'), JSON.stringify(series));
  const lines = series.flatMap(([hr, p, n]) => [
    `INSERT OR REPLACE INTO metrics (ts,key,value) VALUES (${hr},'price.swap_1h',${p});`,
    `INSERT OR REPLACE INTO metrics (ts,key,value) VALUES (${hr},'price.swap_1h.n',${n});`,
  ]);

  // Re-price backfilled flows that were valued at import-day spot.
  const nearest = (ts: number): number | null => {
    let best: [number, number] | null = null;
    for (const [hr, p] of series) { const d = Math.abs(hr + 1800000 - ts); if (!best || d < best[0]) best = [d, p]; }
    return best && best[0] <= 6 * 3600000 ? best[1] : null;
  };
  const flows = d1<{ id: string; ts: number; amount_num: number; counter_denom: string | null; counter_amount: number | null; kind: string; pool_id: string | null }>(
    `SELECT id, ts, amount_num, counter_denom, counter_amount, kind, pool_id FROM flows WHERE chain='osmosis'`,
  );
  for (const f of flows) {
    let p: number | null, src: string;
    if (f.counter_denom === 'USDC' && (f.kind === 'buy' || f.kind === 'sell') && f.counter_amount && f.pool_id && !f.pool_id.includes(',')) {
      p = f.counter_amount / f.amount_num; src = 'execution';
    } else {
      p = nearest(f.ts); src = p == null ? 'unknown' : 'swap_1h';
    }
    lines.push(`UPDATE flows SET price_usd=${q(p)}, value_usd=${q(p == null ? null : p * f.amount_num)}, meta=json_set(COALESCE(meta,'{}'),'$.priceSource',${q(src)}) WHERE id=${q(f.id)};`);
  }
  log(`price: ${series.length} hourly points, ${flows.length} flows re-priced`);
  writeChunks('02_price', lines);
}

// ------------------------------------------------------------------ 3. namada
type HistItem = { tx: { id: string; wrapperId: string; kind: string; data: string; exitCode: string }; kind: string; blockHeight: number };

async function addressHistory(addr: string): Promise<HistItem[]> {
  const out: HistItem[] = [];
  for (let page = 1; ; page++) {
    const r = await getJson(`${INDEXER}/api/v1/chain/history?addresses=${addr}&page=${page}`);
    out.push(...(r.results ?? []));
    const total = r.pagination?.totalPages ?? 0;
    if (total > 200 && page % 100 === 0) log(`  ${addr.slice(0, 14)}… page ${page}/${total}`);
    if (page >= total) break;
  }
  return out;
}

function transferOf(data: string): { sources: any[]; targets: any[] } | null {
  try {
    const d = JSON.parse(data);
    const t = Array.isArray(d) ? d.find((x) => x && x.sources) : d;
    return t?.sources ? t : null;
  } catch { return null; }
}

/** Indexer tx -> NamadaTrade flows (NAM legs only). */
function toFlows(it: HistItem, ts: number, tsSource: string): any[] {
  if (it.tx.exitCode !== 'applied') return [];
  const t = transferOf(it.tx.data);
  if (!t) return [];
  const src = t.sources.filter((s) => s.token === NAM_TOKEN);
  const tgt = t.targets.filter((s) => s.token === NAM_TOKEN);
  if (!src.length || !tgt.length) return [];
  const amt = (x: any) => Number(BigInt(x.amount)) / 1e6;
  const main = src.reduce((a, b) => (amt(b) > amt(a) ? b : a));
  const kindMap: Record<string, string> = {
    transparentTransfer: 'transfer', shieldingTransfer: 'shield', unshieldingTransfer: 'unshield',
    ibcShieldingTransfer: 'ibc_in', ibcUnshieldingTransfer: 'ibc_out',
  };
  let kind = kindMap[it.tx.kind];
  if (it.tx.kind === 'ibcTransparentTransfer') kind = main.type === 'external' ? 'ibc_in' : 'ibc_out';
  if (!kind) return [];
  const meta: Record<string, unknown> = { source: 'namada-indexer', txKind: it.tx.kind, wrapper: it.tx.wrapperId, tsSource };
  if (it.tx.kind.startsWith('ibc') && it.tx.kind !== 'ibcTransparentTransfer') meta.shielded = true;
  return tgt.map((g, i) => ({
    id: `namada:${it.tx.id.toUpperCase()}:h${i}`,
    height: it.blockHeight, ts, txHash: it.tx.id.toUpperCase(), kind,
    from: main.owner, to: g.owner, amount: amt(g), meta,
  }));
}

async function namada() {
  const cutoff = d1<{ h: number }>(`SELECT MIN(height) h FROM flows WHERE chain='namada'`)[0].h;
  log(`namada: RPC event index starts at ${cutoff}; backfilling heights below it from ${INDEXER}`);

  const doneFile = P('namada_done.json');
  const done: Record<string, true> = existsSync(doneFile) ? JSON.parse(readFileSync(doneFile, 'utf8')) : {};
  const itemsFile = P('namada_items.ndjson');

  const addrs = [
    ...d1<{ address: string }>(`SELECT address FROM holders WHERE chain='namada' AND balance_num > 0 ORDER BY balance_num DESC`).map((r) => r.address),
    ...d1<{ address: string }>(`SELECT address FROM labels WHERE chain='namada' AND category IN ('foundation','backer','team','cex','whale','watch')`).map((r) => r.address),
  ];
  const todo = [...new Set([...addrs, MASP])].filter((a) => a.startsWith('tnam1') && !done[a]);
  log(`namada: ${todo.length} addresses to pull (${Object.keys(done).length} already done)`);

  let n = 0;
  await pool(todo, 6, async (addr) => {
    try {
      const items = (await addressHistory(addr)).filter((x) => x.blockHeight < cutoff && x.tx.exitCode === 'applied');
      if (items.length) appendFileSync(itemsFile, items.map((x) => JSON.stringify(x)).join('\n') + '\n');
      done[addr] = true;
    } catch (e) {
      log(`  failed ${addr}: ${String(e).slice(0, 80)}`);
    }
    if (++n % 100 === 0) { writeFileSync(doneFile, JSON.stringify(done)); log(`  ${n}/${todo.length} addresses`); }
  });
  writeFileSync(doneFile, JSON.stringify(done));

  // Dedupe by inner tx id, keep only txs that move NAM.
  const byId = new Map<string, HistItem>();
  for (const line of readFileSync(itemsFile, 'utf8').split('\n')) {
    if (!line) continue;
    const it = JSON.parse(line) as HistItem;
    if (!byId.has(it.tx.id) && it.tx.data.includes(NAM_TOKEN)) byId.set(it.tx.id, it);
  }
  const items = [...byId.values()];
  log(`namada: ${items.length} unique NAM txs below ${cutoff}`);

  // Timestamps: anchors every 10k blocks, exact lookups for anything >= 10k NAM.
  const anchorHeights: number[] = [];
  for (let h = 1; h <= cutoff + 10000; h += 10000) anchorHeights.push(h);
  const anchors = await blockTimes(NAMADA_RPCS, anchorHeights, 6);
  const interp = interpolator([...anchors.entries()]);
  const big = items.filter((it) => {
    const t = transferOf(it.tx.data);
    return t?.targets.some((g) => g.token === NAM_TOKEN && Number(BigInt(g.amount)) / 1e6 >= 10000);
  });
  const exact = await blockTimes(NAMADA_RPCS, big.map((b) => b.blockHeight), 6);
  log(`namada: ${anchors.size} anchors, ${exact.size} exact times for whale-size txs`);

  const lines: string[] = [];
  let flows = 0, relayRepeats = 0;
  const links = new Map<string, { osmo: string; namada: string; n: number; vol: number; first: number; last: number }>();
  // IBC packets are often relayed more than once; the indexer records every applied relay as its own tx
  // although only the first moves funds. Keep the first (kind, from, to, amount) seen within 20 blocks.
  const seenIbc = new Map<string, number>();
  for (const it of [...items].sort((a, b) => a.blockHeight - b.blockHeight)) {
    const ts = exact.get(it.blockHeight) ?? interp(it.blockHeight);
    const src = exact.has(it.blockHeight) ? 'block' : 'interpolated';
    for (const f of toFlows(it, ts, src)) {
      if (f.kind === 'ibc_in' || f.kind === 'ibc_out') {
        const k = `${f.kind}|${f.from}|${f.to}|${f.amount.toFixed(3)}`;
        const prev = seenIbc.get(k);
        if (prev != null && f.height - prev <= 20) { relayRepeats++; continue; }
        seenIbc.set(k, f.height);
      }
      lines.push(`INSERT OR IGNORE INTO flows (id,chain,height,ts,tx_hash,kind,from_addr,to_addr,amount_num,meta) VALUES (${q(f.id)},'namada',${f.height},${f.ts},${q(f.txHash)},${q(f.kind)},${q(f.from)},${q(f.to)},${f.amount},${q(JSON.stringify(f.meta))});`);
      flows++;
      // A link means NAM arrived: only a receive (ibc_in, osmo1 sender -> tnam1 receiver) links the two, never a
      // send, whose receiver is text the sender chose and whose NAM comes back on a timeout (docs/security-review.md, E1).
      const osmo = f.kind === 'ibc_in' && f.from?.startsWith('osmo1') ? f.from : null;
      const nam = f.kind === 'ibc_in' && f.to?.startsWith('tnam1') && f.to !== MASP ? f.to : null;
      if (osmo && nam) {
        const k = `${osmo}|${nam}`;
        const l = links.get(k) ?? { osmo, namada: nam, n: 0, vol: 0, first: ts, last: ts };
        l.n++; l.vol += f.amount; l.first = Math.min(l.first, ts); l.last = Math.max(l.last, ts);
        links.set(k, l);
      }
    }
  }
  for (const l of links.values()) {
    lines.push(`INSERT INTO address_links (osmo_addr,namada_addr,first_seen,last_seen,transfers,volume_num) VALUES (${q(l.osmo)},${q(l.namada)},${l.first},${l.last},${l.n},${l.vol})
      ON CONFLICT(osmo_addr,namada_addr) DO UPDATE SET first_seen=MIN(address_links.first_seen,excluded.first_seen), last_seen=MAX(address_links.last_seen,excluded.last_seen),
      transfers=address_links.transfers+excluded.transfers, volume_num=address_links.volume_num+excluded.volume_num;`);
  }
  lines.push(`INSERT OR REPLACE INTO kv (key,value,updated_at) VALUES ('namada.history_backfill',${q(JSON.stringify({ below: cutoff, txs: items.length, flows, links: links.size, source: INDEXER, at: Date.now() }))},${Date.now()});`);
  writeFileSync(P('namada_anchors.json'), JSON.stringify([...anchors.entries()]));
  log(`namada: ${flows} flows (${relayRepeats} repeated IBC relays dropped), ${links.size} osmo<->namada links`);
  writeChunks('03_namada', lines);
}

// ------------------------------------------------------------------ 4. masp
// Shielded-pool NAM balance from the chain itself. Every `token/transfer` event that touches the MASP carries
// `post-balances`, the exact NAM balance of the MASP right after that transfer, and the RPCs keep block_results
// for the whole chain. So instead of trusting a flow list to be complete, the daily series is read off those
// post-balances, and the flow list is checked against them:
//   residual(i) = post[i] - (post[i-1] + in_i - out_i)
// is > 0 only when NAM was minted into the pool between the two points (shielded rewards), and < 0 only when a
// MASP outflow sits in a block we have not looked at. Negative residuals are hunted down by scanning the blocks
// in between (block metas first, so empty blocks cost nothing), and every MASP leg the chain shows that `flows`
// lacks is emitted as a corrective INSERT (meta.source = 'namada-rpc-block-results', never an overwrite).
const IBC_ESCROW = 'tnam1qcqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqvtr7x4';
/** Public nodes that serve block_results and block metas back to genesis (checked 2026-10-16). */
const ARCHIVE_RPCS = [...NAMADA_RPCS, 'https://namada-rpc.polkachu.com', 'https://namada-rpc.stakeandrelax.net'];
const BLOCKS_DIR = P('masp_blocks');
type TokenEvent = { type: string; attrs: Record<string, string> };
type MaspBlock = { height: number; rpc: string; nEvents: number; events: TokenEvent[] };
type Leg = { inner: string; wrapper: string; from: string; to: string; amount: number; descriptor: string };
type Point = { h: number; post: number | null; in: number; out: number; legs: Leg[] };

const bare = (a: string) => a.slice(a.indexOf('/') + 1);
const pairs = (json: string | undefined): [string, string, number][] => {
  if (!json) return [];
  try { return (JSON.parse(json) as [[string, string], string][]).map(([[acct, tok], amt]) => [bare(acct), tok, Number(BigInt(amt))]); } catch { return []; }
};

/** Full indexer history of the MASP address (newest first). Resumable: stops at the first page whose items are all known. */
async function maspHistory(): Promise<HistItem[]> {
  const file = P('masp_history.ndjson'), doneFile = P('masp_history.complete');
  const known = new Map<string, HistItem>();
  if (existsSync(file)) for (const line of readFileSync(file, 'utf8').split('\n')) if (line) { const it = JSON.parse(line) as HistItem; known.set(it.tx.id, it); }
  const complete = existsSync(doneFile); // only a finished pull may stop at the first already-known page
  const first = await getJson(`${INDEXER}/api/v1/chain/history?addresses=${MASP}&page=1`);
  const total = first.pagination?.totalPages ?? 1;
  log(`masp: MASP history has ${first.pagination?.totalItems} items on ${total} pages (${known.size} cached)`);
  let fresh = 0, stop = false, next = 2;
  const take = (rows: HistItem[]) => {
    let allKnown = rows.length > 0;
    for (const it of rows) { if (!known.has(it.tx.id)) { known.set(it.tx.id, it); appendFileSync(file, JSON.stringify(it) + '\n'); fresh++; allKnown = false; } }
    return allKnown;
  };
  if (take(first.results ?? []) && complete) stop = true;
  await pool(Array.from({ length: 8 }), 8, async () => {
    while (!stop && next <= total) {
      const page = next++;
      const r = await getJson(`${INDEXER}/api/v1/chain/history?addresses=${MASP}&page=${page}`);
      if (take(r.results ?? []) && complete) stop = true; // older pages are already cached
      if (page % 200 === 0) log(`  MASP history page ${page}/${total}`);
    }
  });
  if (!stop) writeFileSync(doneFile, String(Date.now()));
  log(`masp: ${fresh} new history items`);
  return [...known.values()];
}

/** block_results of one height, reduced to its token/masp events; cached. Null when every RPC returns an empty block. */
async function maspBlock(h: number, rpcs = ARCHIVE_RPCS): Promise<MaspBlock | null> {
  const f = join(BLOCKS_DIR, `${h}.json`);
  if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'));
  for (let t = 0; t < 2 * rpcs.length; t++) {
    const rpc = rpcs[t % rpcs.length];
    try {
      const r = (await getJson(`${rpc}/block_results?height=${h}`, 1)).result;
      const evs: any[] = [...(r.end_block_events ?? []), ...(r.finalize_block_events ?? []), ...((r.txs_results ?? []) as any[]).flatMap((x) => x.events ?? [])];
      if (!evs.length) { if (t >= rpcs.length) return null; continue; }
      const blk: MaspBlock = { height: h, rpc, nEvents: evs.length, events: evs.filter((e) => /^(token|masp)\//.test(e.type)).map((e) => ({ type: e.type, attrs: Object.fromEntries(e.attributes.map((a: any) => [a.key, a.value])) })) };
      writeFileSync(f, JSON.stringify(blk));
      return blk;
    } catch { await sleep(400 * (t + 1)); }
  }
  throw new Error(`block_results ${h} unavailable`);
}

/** MASP NAM legs and post-balance of one block. */
function pointOf(b: MaspBlock): Point {
  const p: Point = { h: b.height, post: null, in: 0, out: 0, legs: [] };
  for (const e of b.events) {
    if (e.type !== 'token/transfer') continue;
    const a = e.attrs;
    const src = pairs(a['source-accounts']).filter(([, tok]) => tok === NAM_TOKEN);
    const tgt = pairs(a['target-accounts']).filter(([, tok]) => tok === NAM_TOKEN);
    for (const [acct, tok, amt] of pairs(a['post-balances'])) if (tok === NAM_TOKEN && acct === MASP) p.post = amt / 1e6;
    const mSrc = src.filter(([acct]) => acct === MASP), mTgt = tgt.filter(([acct]) => acct === MASP);
    if (!mSrc.length && !mTgt.length) continue;
    const inner = (a['inner-tx-hash'] || a.hash || '').toUpperCase(), wrapper = (a.hash || '').toUpperCase(), descriptor = a['token-event-descriptor'] ?? '';
    if (mSrc.length) for (const [to, , amt] of tgt.filter(([acct]) => acct !== MASP)) { p.legs.push({ inner, wrapper, from: MASP, to, amount: amt / 1e6, descriptor }); p.out += amt / 1e6; }
    if (mTgt.length) for (const [from, , amt] of src.filter(([acct]) => acct !== MASP)) { p.legs.push({ inner, wrapper, from, to: MASP, amount: amt / 1e6, descriptor }); p.in += amt / 1e6; }
  }
  return p;
}

/** Heights in (lo, hi) whose blocks carry transactions, from /blockchain metas (20 per call). */
async function busyHeights(lo: number, hi: number): Promise<number[]> {
  const out: number[] = [];
  const windows: [number, number][] = [];
  for (let a = lo + 1; a < hi; a += 20) windows.push([a, Math.min(hi - 1, a + 19)]);
  await pool(windows, 8, async ([a, b], i) => {
    for (let t = 0; t < ARCHIVE_RPCS.length; t++) {
      const rpc = ARCHIVE_RPCS[(i + t) % ARCHIVE_RPCS.length];
      try {
        const r = await getJson(`${rpc}/blockchain?minHeight=${a}&maxHeight=${b}`, 2);
        for (const m of r.result.block_metas) if (Number(m.num_txs) > 0) out.push(Number(m.header.height));
        return;
      } catch {}
    }
    throw new Error(`block metas ${a}-${b} unavailable`);
  });
  return out.sort((x, y) => x - y);
}

async function masp() {
  mkdirSync(BLOCKS_DIR, { recursive: true });
  const cur = d1<{ value: number; ts: number }>(`SELECT value, ts FROM metrics WHERE key='supply.masp_shielded' ORDER BY ts DESC LIMIT 1`)[0];
  const d1Rows = d1<{ id: string; height: number; ts: number; tx_hash: string; kind: string; from_addr: string; to_addr: string; amount_num: number; meta: string | null }>(
    `SELECT id, height, ts, tx_hash, kind, from_addr, to_addr, amount_num, meta FROM flows WHERE chain='namada' AND (from_addr='${MASP}' OR to_addr='${MASP}')`,
  );
  const metaOf = (r: { meta: string | null }) => { try { return JSON.parse(r.meta ?? '{}'); } catch { return {}; } };
  const namRows = d1Rows.filter((r) => { const m = metaOf(r); return !m.tokenSymbol && !m.tokenAddress; });
  log(`masp: ${d1Rows.length} MASP rows in flows (${d1Rows.length - namRows.length} are other tokens and are ignored)`);

  // 1. Heights that certainly hold a MASP NAM transfer: indexer history of the MASP + everything already in flows.
  const items = await maspHistory();
  const heights = new Set<number>(namRows.map((r) => r.height));
  for (const it of items) if (it.tx.exitCode === 'applied' && it.tx.data.includes(MASP) && it.tx.data.includes(NAM_TOKEN)) heights.add(it.blockHeight);
  if (existsSync(P('namada_items.ndjson'))) for (const line of readFileSync(P('namada_items.ndjson'), 'utf8').split('\n')) {
    if (!line) continue; const it = JSON.parse(line) as HistItem;
    if (it.tx.exitCode === 'applied' && /hield|mixed/i.test(it.tx.kind) && it.tx.data.includes(MASP) && it.tx.data.includes(NAM_TOKEN)) heights.add(it.blockHeight);
  }
  log(`masp: ${heights.size} known heights; fetching block_results`);
  // Every block read so far (known heights and blocks found by earlier scans) is part of the ledger.
  const blocks = new Map<number, MaspBlock>();
  for (const f of readdirSync(BLOCKS_DIR)) if (f.endsWith('.json')) { const b = JSON.parse(readFileSync(join(BLOCKS_DIR, f), 'utf8')) as MaspBlock; blocks.set(b.height, b); }
  log(`masp: ${blocks.size} blocks cached from earlier runs`);
  let n = 0, missing = 0;
  await pool([...heights].sort((a, b) => a - b), 8, async (h) => {
    try { const b = await maspBlock(h); if (b) blocks.set(h, b); else missing++; } catch (e) { missing++; log(`  ${String(e).slice(0, 80)}`); }
    if (++n % 2000 === 0) log(`  blocks ${n}/${heights.size}`);
  });
  if (missing) log(`masp: ${missing} known heights could not be read from any RPC`);

  // 2. Ledger + negative residuals -> scan the blocks in between for the outflows we have not seen.
  const scanFile = P('masp_scan.json');
  // Coverage of the scan as merged height ranges [lo, hi] (inclusive): once a block has been looked at it is never
  // fetched again, however the points around it move as more blocks join the ledger.
  const covered: [number, number][] = existsSync(scanFile) ? JSON.parse(readFileSync(scanFile, 'utf8')) : [];
  const addCovered = (lo: number, hi: number) => {
    if (hi < lo) return;
    covered.push([lo, hi]); covered.sort((a, b) => a[0] - b[0]);
    const out: [number, number][] = [];
    for (const r of covered) { const l = out[out.length - 1]; if (l && r[0] <= l[1] + 1) l[1] = Math.max(l[1], r[1]); else out.push([...r] as [number, number]); }
    covered.length = 0; covered.push(...out);
    writeFileSync(scanFile, JSON.stringify(covered));
  };
  const uncovered = (lo: number, hi: number): [number, number][] => {
    const out: [number, number][] = []; let cur = lo;
    for (const [a, b] of covered) { if (b < cur) continue; if (a > hi) break; if (a > cur) out.push([cur, Math.min(hi, a - 1)]); cur = Math.max(cur, b + 1); if (cur > hi) break; }
    if (cur <= hi) out.push([cur, hi]);
    return out;
  };
  const ledger = () => [...blocks.values()].map(pointOf).filter((p) => p.post != null).sort((a, b) => a.h - b.h);
  const gaps = (pts: Point[]) => {
    const out: { from: number; to: number; r: number }[] = [];
    for (let i = 1; i < pts.length; i++) { const r = pts[i].post! - (pts[i - 1].post! + pts[i].in - pts[i].out); if (Math.abs(r) > 0.000001) out.push({ from: pts[i - 1].h, to: pts[i].h, r }); }
    return out;
  };
  let pts = ledger();
  const all = gaps(pts);
  // Negative residuals are missing outflows: scan until the found legs add up to the residual. Positive residuals are
  // mostly rewards minted at MASP-epoch boundaries (no event), but may hide small outflows too: scan the whole span.
  const todo = all.map((g) => ({ ...g, parts: uncovered(g.from + 1, g.to - 1) })).filter((g) => g.parts.length);
  const span = todo.reduce((s, g) => s + g.parts.reduce((t, [a, b]) => t + b - a + 1, 0), 0);
  const neg = all.filter((g) => g.r < 0);
  log(`masp: ${pts.length} points, ${neg.length} negative residuals (${neg.reduce((s, g) => s + g.r, 0).toFixed(0)} NAM) and ${all.length - neg.length} positive (${all.filter((g) => g.r > 0).reduce((s, g) => s + g.r, 0).toFixed(0)} NAM); ${todo.length} gaps / ${span} blocks to scan`);
  let scannedBlocks = 0;
  await pool(todo.sort((a, b) => (a.r < 0 && b.r < 0 ? a.r - b.r : a.r < 0 ? -1 : b.r < 0 ? 1 : b.r - a.r)), 3, async (g) => {
    let found = 0, looked = 0, explained = false;
    for (const [lo, hi] of g.parts) {
      if (explained) break;
      const busy = await busyHeights(lo - 1, hi + 1);
      for (let i = 0; i < busy.length && !explained; i += 8) {
        const chunk = busy.slice(i, i + 8);
        await pool(chunk, 8, async (h) => { const b = await maspBlock(h); if (b) { const p = pointOf(b); if (p.legs.length) { blocks.set(h, b); found += p.in - p.out; } } });
        scannedBlocks += chunk.length; looked += chunk.length;
        explained = g.r < 0 && Math.abs(found - g.r) < 0.000001;
        addCovered(lo, explained ? chunk[chunk.length - 1] : hi);
      }
      if (!busy.length) addCovered(lo, hi);
    }
    const left = g.r - found;
    log(`  gap ${g.from}-${g.to}: residual ${g.r.toFixed(2)} NAM, legs found ${found.toFixed(2)} in ${looked} busy blocks${Math.abs(left) < 0.000001 ? '' : left > 0 ? ` (+${left.toFixed(2)} minted)` : ` (${left.toFixed(2)} NOT explained)`}`);
  });
  pts = ledger();
  const remaining = gaps(pts).filter((g) => g.r < 0);
  const unexplained = remaining.reduce((s, g) => s + g.r, 0);
  const minted = gaps(pts).filter((g) => g.r > 0).reduce((s, g) => s + g.r, 0);
  const last = pts[pts.length - 1];
  log(`masp: ${pts.length} points ${pts[0].h}..${last.h}; first post-balance ${pts[0].post!.toFixed(2)} NAM; last ${last.post!.toFixed(2)} (live metric ${cur.value.toFixed(2)})`);
  log(`masp: minted into the pool between points ${minted.toFixed(2)} NAM; unexplained outflow ${unexplained.toFixed(2)} NAM in ${remaining.length} gaps (scanned ${scannedBlocks} blocks this run)`);

  // 3. Block times for every point (exact), then flows the chain shows and `flows` lacks.
  const timesFile = P('masp_times.json');
  const times = new Map<number, number>(existsSync(timesFile) ? JSON.parse(readFileSync(timesFile, 'utf8')) : []);
  const need = pts.map((p) => p.h).filter((h) => !times.has(h));
  if (need.length) { log(`masp: block times for ${need.length} heights`); for (const [h, t] of await blockTimes(ARCHIVE_RPCS, need, 8)) times.set(h, t); writeFileSync(timesFile, JSON.stringify([...times.entries()])); }
  const untimed = pts.filter((p) => !times.has(p.h));
  if (untimed.length) throw new Error(`no block time for ${untimed.length} heights (first ${untimed[0].h}); rerun`);

  const have = new Set<string>();
  for (const r of d1Rows) { have.add(r.tx_hash.toUpperCase()); const m = metaOf(r); if (m.innerTxHash) have.add(String(m.innerTxHash).toUpperCase()); const idHash = r.id.split(':')[1]; if (idHash) have.add(idHash.toUpperCase()); }
  const lines: string[] = [];
  let added = 0, addedIn = 0, addedOut = 0;
  const kindOf = (l: Leg) => (l.to === MASP ? (l.from === IBC_ESCROW ? 'ibc_in' : 'shield') : l.to === IBC_ESCROW ? 'ibc_out' : 'unshield');
  for (const p of pts) {
    const byInner = new Map<string, Leg[]>();
    for (const l of p.legs) (byInner.get(l.inner) ?? byInner.set(l.inner, []).get(l.inner)!).push(l);
    for (const [inner, legs] of byInner) {
      if (have.has(inner)) continue;
      legs.forEach((l, i) => {
        const kind = kindOf(l);
        const meta = { source: 'namada-rpc-block-results', descriptor: l.descriptor, wrapper: l.wrapper, tsSource: 'block', ...(kind.startsWith('ibc') ? { shielded: true } : {}) };
        lines.push(`INSERT OR IGNORE INTO flows (id,chain,height,ts,tx_hash,kind,from_addr,to_addr,amount_num,meta) VALUES (${q(`namada:${inner}:c${i}`)},'namada',${p.h},${times.get(p.h)},${q(inner)},${q(kind)},${q(l.from)},${q(l.to)},${l.amount},${q(JSON.stringify(meta))});`);
        added++; if (l.to === MASP) addedIn += l.amount; else addedOut += l.amount;
      });
    }
  }
  log(`masp: ${added} MASP legs missing from flows (${addedIn.toFixed(0)} NAM in, ${addedOut.toFixed(0)} NAM out)`);

  // Twin rows: the same transfer written once under its inner hash and once under its wrapper hash (two parser builds).
  const innerRefs = new Set(d1Rows.map((r) => String(metaOf(r).innerTxHash ?? '').toUpperCase()).filter(Boolean));
  const twins = namRows.filter((r) => innerRefs.has(r.tx_hash.toUpperCase()) && !metaOf(r).innerTxHash);
  if (twins.length) log(`masp: ${twins.length} RPC rows are twins of wrapper-hash rows (${twins.reduce((s, r) => s + r.amount_num, 0).toFixed(0)} NAM double counted in flows; ids ${twins.slice(0, 5).map((r) => r.id).join(', ')}${twins.length > 5 ? ', …' : ''})`);

  // Flows-only reconstruction (the old method) for the record: starts at the live balance, undoes every NAM flow.
  let bal = cur.value;
  const twinIds = new Set(twins.map((r) => r.id));
  for (const r of namRows) if (!twinIds.has(r.id)) bal += r.from_addr === MASP ? r.amount_num + Number(metaOf(r).maspFeeNam ?? 0) : -r.amount_num;
  // The pool's NAM fee for a transfer of another coin (block 8,294,006) is kept on that coin's row, as meta.maspFeeNam
  // (an older row's feeNam is every NAM source of the event, whoever sent it, so it is not read).
  for (const r of d1Rows) { const m = metaOf(r); if (m.tokenSymbol || m.tokenAddress) bal += Number(m.maspFeeNam ?? 0); }
  const balWithChain = bal - addedIn + addedOut;
  log(`masp: flows-only reconstruction before the first flow: ${bal.toFixed(0)} NAM as stored, ${balWithChain.toFixed(0)} NAM with the corrective rows (chain says ${pts[0].post!.toFixed(0)} + ${minted.toFixed(0)} minted)`);

  // 4. Daily series straight from the chain: the MASP balance after the last MASP transfer of each UTC day.
  const ok = Math.abs(unexplained) <= cur.value * 0.02;
  const report = { method: 'MASP NAM post-balance from token/transfer events in block_results', points: pts.length, firstHeight: pts[0].h, lastHeight: last.h, firstBalance: pts[0].post, lastBalance: last.post, liveBalance: cur.value,
    minted, unexplained, unexplainedGaps: remaining.length, missingFlows: added, missingIn: addedIn, missingOut: addedOut, twins: twins.length, flowsOnlyReconstruction: balWithChain, written: ok, at: Date.now() };
  writeFileSync(P('masp_report.json'), JSON.stringify({ ...report, gaps: remaining.sort((a, b) => a.r - b.r).slice(0, 50) }, null, 1));
  if (added) writeChunks('04_masp_flows', lines);
  if (!ok) { log(`masp: unexplained outflow ${unexplained.toFixed(0)} NAM exceeds 2% of the pool (${(cur.value * 0.02).toFixed(0)}): daily series NOT written`); return; }
  const daily: string[] = [];
  const firstDay = Math.floor(times.get(pts[0].h)! / 86400000) * 86400000;
  const today = Math.floor(cur.ts / 86400000) * 86400000;
  let i = 0, v = pts[0].post!;
  for (let day = firstDay; day <= today; day += 86400000) {
    while (i < pts.length && times.get(pts[i].h)! < day + 86400000) v = pts[i++].post!;
    daily.push(`INSERT OR REPLACE INTO metrics (ts,key,value) VALUES (${day},'supply.masp_shielded.daily',${v});`);
  }
  daily.push(`INSERT OR REPLACE INTO kv (key,value,updated_at) VALUES ('namada.masp_history',${q(JSON.stringify(report))},${Date.now()});`);
  writeChunks('04_masp_daily', daily);
}

// ------------------------------------------------------------------ 5. pos (bond / unbond requests from the pulled history)
async function pos() {
  const cutoff = d1<{ h: number }>(`SELECT MIN(height) h FROM flows WHERE chain='namada' AND (meta IS NULL OR json_extract(meta,'$.source') IS NULL)`)[0].h;
  const anchors = new Map<number, number>(JSON.parse(readFileSync(P('namada_anchors.json'), 'utf8')));
  const interp = interpolator([...anchors.entries()]);
  const seen = new Set<string>();
  const items: HistItem[] = [];
  for (const line of readFileSync(P('namada_items.ndjson'), 'utf8').split('\n')) {
    if (!line) continue;
    const it = JSON.parse(line) as HistItem;
    if (seen.has(it.tx.id) || it.tx.exitCode !== 'applied' || it.blockHeight >= cutoff) continue;
    if (it.tx.kind !== 'bond' && it.tx.kind !== 'unbond') continue;
    seen.add(it.tx.id); items.push(it);
  }
  const big = items.filter((it) => { try { return Number(BigInt(JSON.parse(it.tx.data).amount || '0')) / 1e6 >= 100000; } catch { return false; } });
  const exact = await blockTimes(NAMADA_RPCS, big.map((b) => b.blockHeight), 6);
  const POS = 'tnam1qgqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqc8j2fp';
  const lines: string[] = [];
  for (const it of items) {
    let d: any; try { d = JSON.parse(it.tx.data); } catch { continue; }
    const amt = Number(BigInt(d.amount || '0')) / 1e6;
    if (!(amt > 0) || !d.source) continue;
    const ts = exact.get(it.blockHeight) ?? interp(it.blockHeight);
    const meta = { source: 'namada-indexer', txKind: it.tx.kind, validator: d.validator, wrapper: it.tx.wrapperId, tsSource: exact.has(it.blockHeight) ? 'block' : 'interpolated' };
    const [from, to] = it.tx.kind === 'bond' ? [d.source, POS] : [POS, d.source];
    lines.push(`INSERT OR IGNORE INTO flows (id,chain,height,ts,tx_hash,kind,from_addr,to_addr,amount_num,meta) VALUES (${q(`namada:${it.tx.id.toUpperCase()}:pos`)},'namada',${it.blockHeight},${ts},${q(it.tx.id.toUpperCase())},${q(it.tx.kind)},${q(from)},${q(to)},${amt},${q(JSON.stringify(meta))});`);
  }
  log(`pos: ${items.length} bond/unbond txs below ${cutoff} (${exact.size} exact times for ≥100k)`);
  writeChunks('05_pos', lines);
}

// ------------------------------------------------------------------ 6. unbond-gap
// Bond/unbond requests between the end of the indexer pull (RPC index start) and the first block the live
// decoder handled. History comes newest-first, so most addresses cost one request.
async function unbondGap() {
  const from = d1<{ h: number }>(`SELECT MIN(height) h FROM flows WHERE chain='namada' AND (meta IS NULL OR json_extract(meta,'$.source') IS NULL)`)[0].h;
  const liveMin = d1<{ h: number | null }>(`SELECT MIN(height) h FROM flows WHERE chain='namada' AND kind='unbond' AND json_extract(meta,'$.source')='namada-rpc'`)[0].h;
  const head = Number((await getJson(`${NAMADA_RPCS[0]}/status`)).result.sync_info.latest_block_height);
  const to = liveMin ?? head;
  log(`unbond-gap: heights [${from}, ${to}) · live decoder ${liveMin ? `starts at ${liveMin}` : 'has not decoded anything yet'}`);

  const addrs = [...new Set([
    ...d1<{ address: string }>(`SELECT address FROM holders WHERE chain='namada' AND balance_num > 0`).map((r) => r.address),
    ...d1<{ address: string }>(`SELECT DISTINCT from_addr address FROM flows WHERE chain='namada' AND kind='bond' AND height >= ${from - 500000}`).map((r) => r.address),
  ])].filter((a) => a && a.startsWith('tnam1') && a !== MASP);
  log(`unbond-gap: ${addrs.length} addresses`);

  const items = new Map<string, HistItem>();
  let n = 0;
  await pool(addrs, 6, async (addr) => {
    try {
      for (let page = 1; page <= 50; page++) {
        const r = await getJson(`${INDEXER}/api/v1/chain/history?addresses=${addr}&page=${page}`);
        const rows: HistItem[] = r.results ?? [];
        for (const it of rows) if (it.blockHeight >= from && it.blockHeight < to && it.tx.exitCode === 'applied' && (it.tx.kind === 'bond' || it.tx.kind === 'unbond')) items.set(it.tx.id, it);
        if (!rows.length || rows[rows.length - 1].blockHeight < from || page >= (r.pagination?.totalPages ?? 0)) break;
      }
    } catch (e) { log(`  failed ${addr}: ${String(e).slice(0, 80)}`); }
    if (++n % 300 === 0) log(`  ${n}/${addrs.length}`);
  });
  const list = [...items.values()];
  log(`unbond-gap: ${list.length} bond/unbond txs in range`);

  const anchorHeights: number[] = [];
  for (let h = from; h <= to + 2000; h += 2000) anchorHeights.push(h);
  const anchors = await blockTimes(NAMADA_RPCS, anchorHeights, 6);
  const interp = interpolator([...anchors.entries()]);
  const big = list.filter((it) => { try { return Number(BigInt(JSON.parse(it.tx.data).amount || '0')) / 1e6 >= 100000; } catch { return false; } });
  const exact = await blockTimes(NAMADA_RPCS, big.map((b) => b.blockHeight), 6);
  const POS = 'tnam1qgqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqc8j2fp';
  const lines: string[] = [];
  for (const it of list) {
    let d: any; try { d = JSON.parse(it.tx.data); } catch { continue; }
    const amt = Number(BigInt(d.amount || '0')) / 1e6;
    if (!(amt > 0) || !d.source) continue;
    const ts = exact.get(it.blockHeight) ?? interp(it.blockHeight);
    const meta = { source: 'namada-indexer', txKind: it.tx.kind, validator: d.validator, wrapper: it.tx.wrapperId, tsSource: exact.has(it.blockHeight) ? 'block' : 'interpolated' };
    const [fromA, toA] = it.tx.kind === 'bond' ? [d.source, POS] : [POS, d.source];
    lines.push(`INSERT OR IGNORE INTO flows (id,chain,height,ts,tx_hash,kind,from_addr,to_addr,amount_num,meta) VALUES (${q(`namada:${it.tx.id.toUpperCase()}:pos`)},'namada',${it.blockHeight},${ts},${q(it.tx.id.toUpperCase())},${q(it.tx.kind)},${q(fromA)},${q(toA)},${amt},${q(JSON.stringify(meta))});`);
  }
  writeChunks('06_unbond_gap', lines);
}

const steps: Record<string, () => Promise<void>> = { 'osmo-ts': osmoTs, price, namada, masp, pos, 'unbond-gap': unbondGap };
const cmd = process.argv[2];
if (!steps[cmd]) { console.error(`usage: ${Object.keys(steps).join('|')}`); process.exit(1); }
steps[cmd]().catch((e) => { console.error(e); process.exit(1); });
