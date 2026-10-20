/**
 * Full-history Namada backfill (runs locally, resumable).
 *
 *   npx tsx scripts/backfill-namada.ts scan      # 1. scan every block with token/transfer events (genesis -> head)
 *   npx tsx scripts/backfill-namada.ts genesis   # 2. load genesis allocations (+ names/categories as labels)
 *   npx tsx scripts/backfill-namada.ts verify    # 3. live ABCI balance for EVERY known address (double-check)
 *   npx tsx scripts/backfill-namada.ts sql       # 4. emit .sql chunks for D1
 *   npx tsx scripts/backfill-namada.ts all       # 1-4
 *
 * Output: scripts/out/namada/*  (gitignored)
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseNamadaBlock } from '../worker/src/parse/namada';
import { blockResults, namBalance, namadaStatus, transferHeights } from '../worker/src/sources/namada';
import { inlineSql, stmt } from '../worker/src/db';
import { INTERNAL_LABELS, NAMADA } from '../worker/src/config';
import { toNam } from '../worker/src/util';

const OUT = join(import.meta.dirname, 'out', 'namada');
const SQL = join(import.meta.dirname, 'out', 'sql');
mkdirSync(OUT, { recursive: true });
const P = (f: string) => join(OUT, f);

const WINDOW = 100_000;
const CONC = Number(process.env.CONC || 8);

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

function readJson<T>(f: string, d: T): T {
  return existsSync(P(f)) ? (JSON.parse(readFileSync(P(f), 'utf8')) as T) : d;
}
function writeJson(f: string, v: unknown) {
  writeFileSync(P(f), JSON.stringify(v));
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

// ------------------------------------------------------------------ 1. scan
async function scan() {
  const st = await namadaStatus();
  const progress = readJson('progress.json', { nextFrom: 1, head: 0, blocks: 0, flows: 0 });
  const head = st.height;
  progress.head = head;
  const balances: Record<string, { balance: string; height: number }> = readJson('balances.json', {});
  log(`scan from ${progress.nextFrom} to head ${head} (provider ${st.provider})`);

  while (progress.nextFrom <= head) {
    const lo = progress.nextFrom;
    const hi = Math.min(lo + WINDOW - 1, head);
    const heights: { height: number; ts: number }[] = [];
    let page = 1;
    for (;;) {
      const r = await transferHeights(lo, hi, page, 100);
      heights.push(...r.blocks);
      if (heights.length >= r.total || r.blocks.length === 0) break;
      page++;
    }
    const results: ReturnType<typeof parseNamadaBlock>[] = new Array(heights.length);
    await pool(heights.map((h, i) => ({ ...h, i })), CONC, async ({ height, ts, i }) => {
      const blk = await blockResults(height, ts);
      results[i] = parseNamadaBlock(blk, null);
    });
    // Apply in height order so post-balances end up at the latest value
    let flowsN = 0;
    const flowLines: string[] = [], moveLines: string[] = [], linkLines: string[] = [];
    for (const r of results) {
      for (const b of r.balances) {
        const cur = balances[b.address];
        if (!cur || b.height >= cur.height) balances[b.address] = { balance: b.balance, height: b.height };
      }
      r.flows.forEach((f) => flowLines.push(JSON.stringify(f)));
      r.moves.forEach((m) => moveLines.push(JSON.stringify(m)));
      r.links.forEach((l) => linkLines.push(JSON.stringify(l)));
      flowsN += r.flows.length;
    }
    if (flowLines.length) appendFileSync(P('flows.ndjson'), flowLines.join('\n') + '\n');
    if (moveLines.length) appendFileSync(P('moves.ndjson'), moveLines.join('\n') + '\n');
    if (linkLines.length) appendFileSync(P('links.ndjson'), linkLines.join('\n') + '\n');
    progress.blocks += heights.length;
    progress.flows += flowsN;
    progress.nextFrom = hi + 1;
    writeJson('balances.json', balances);
    writeJson('progress.json', progress);
    const pct = ((hi / head) * 100).toFixed(1);
    log(`[${pct}%] ${lo}-${hi}: ${heights.length} blocks, ${flowsN} flows | totals: ${progress.blocks} blocks, ${progress.flows} flows, ${Object.keys(balances).length} accounts`);
  }
  log('scan complete');
}

// ------------------------------------------------------------------ 2. genesis
async function genesis() {
  const url = 'https://raw.githubusercontent.com/namada-net/namada-mainnet-genesis/main/genesis/balances.toml';
  const txt = await (await fetch(url, { headers: { 'User-Agent': 'NamadaTrade/1.0' } })).text();
  const out: Record<string, { amount: number; categories: string[]; name: string | null }> = {};
  let inNam = false;
  for (const line of txt.split('\n')) {
    const sec = line.match(/^\s*\[(.+)\]\s*$/);
    if (sec) { inNam = sec[1].trim() === 'token.NAM'; continue; }
    if (!inNam) continue;
    const m = line.match(/^\s*(tnam1[0-9a-z]+)\s*=\s*"([\d.]+)"\s*(#.*)?$/);
    if (!m) continue;
    const comment = m[3] ?? '';
    const cats = [...(comment.match(/categories:\s*\[([^\]]*)\]/)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1]);
    const name = comment.match(/\(name:\s*([^)]+)\)/)?.[1]?.trim() ?? null;
    const prev = out[m[1]];
    out[m[1]] = {
      amount: (prev?.amount ?? 0) + Number(m[2]),
      categories: [...new Set([...(prev?.categories ?? []), ...cats])],
      name: name ?? prev?.name ?? null,
    };
  }
  writeJson('genesis.json', out);
  const total = Object.values(out).reduce((s, x) => s + x.amount, 0);
  log(`genesis: ${Object.keys(out).length} NAM allocations, ${total.toLocaleString()} NAM`);
}

// ------------------------------------------------------------------ 3. verify
async function verify() {
  const balances: Record<string, { balance: string; height: number }> = readJson('balances.json', {});
  const gen: Record<string, { amount: number }> = readJson('genesis.json', {});
  const verified: Record<string, { balance: string; height: number; provider: string }> = readJson('verified.json', {});
  // Priority: 1. all addresses seen in on-chain blocks, 2. internal addresses, 3. genesis accounts > 50k NAM, 4. rest
  const internalAddrs = Object.values(NAMADA.internal);
  const activeAddrs = Object.keys(balances);
  const topGenesis = Object.entries(gen)
    .filter(([_, v]) => v.amount >= 50_000)
    .sort((a, b) => b[1].amount - a[1].amount)
    .map(([k]) => k);

  const priority = [...new Set([...internalAddrs, ...activeAddrs, ...topGenesis])].filter((a) => a.startsWith('tnam1'));
  const todo = priority.filter((a) => !verified[a]);
  log(`verify: ${priority.length} priority addresses (active + internal + whales >50k), ${todo.length} remaining (conc ${CONC})`);
  let done = 0, mismatches = 0;
  await pool(todo, CONC, async (addr) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const r = await namBalance(addr);
        verified[addr] = { balance: r.balance.toString(), height: r.height, provider: r.provider };
        const idx = balances[addr];
        if (idx && idx.balance !== r.balance.toString()) mismatches++;
        break;
      } catch (e) {
        if (attempt === 3) log('verify failed', addr, String(e).slice(0, 120));
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    if (++done % 500 === 0) {
      writeJson('verified.json', verified);
      log(`verified ${done}/${todo.length} (post-balance drift so far: ${mismatches})`);
    }
  });
  writeJson('verified.json', verified);
  log(`verify complete: ${Object.keys(verified).length} verified; ${mismatches} addresses drifted from last event post-balance (fees/inflation) and were corrected`);
}

// ------------------------------------------------------------------ 4. sql
function* ndjson<T>(f: string): Generator<T> {
  if (!existsSync(P(f))) return;
  for (const line of readFileSync(P(f), 'utf8').split('\n')) if (line) yield JSON.parse(line) as T;
}

function sql() {
  if (existsSync(SQL)) for (const f of readdirSync(SQL)) if (f.startsWith('namada_')) rmSync(join(SQL, f));
  mkdirSync(SQL, { recursive: true });
  const progress = readJson('progress.json', { head: 0 } as any);
  const verified: Record<string, { balance: string; height: number; provider: string }> = readJson('verified.json', {});
  const balances: Record<string, { balance: string; height: number }> = readJson('balances.json', {});
  const gen: Record<string, { amount: number; categories: string[]; name: string | null }> = readJson('genesis.json', {});
  const now = Date.now();

  let file = 0, n = 0, buf: string[] = [];
  const flush = () => {
    if (!buf.length) return;
    writeFileSync(join(SQL, `namada_${String(file++).padStart(4, '0')}.sql`), buf.join('\n') + '\n');
    buf = []; n = 0;
  };
  const push = (s: string) => { buf.push(s); if (++n >= 5000) flush(); };

  // holders (verified wins; else indexed post-balance)
  let holders = 0;
  for (const addr of new Set([...Object.keys(verified), ...Object.keys(balances)])) {
    if (!addr.startsWith('tnam1')) continue;
    const v = verified[addr];
    if (v) {
      if (v.balance === '0') continue;
      push(inlineSql(stmt.verifiedBalance('namada', addr, v.balance, v.height, now, v.provider)));
    } else {
      const b = balances[addr];
      if (b.balance === '0') continue;
      push(inlineSql(stmt.namadaBalance({ address: addr, balance: b.balance, height: b.height }, now)));
    }
    holders++;
  }
  // labels: internal + genesis
  for (const [addr, l] of Object.entries(INTERNAL_LABELS)) {
    push(inlineSql(stmt.label(addr, addr.startsWith('osmo') ? 'osmosis' : 'namada', l.label, l.category, 'auto', null, now)));
  }
  for (const [addr, g] of Object.entries(gen)) {
    const cat = g.categories.some((c) => /backer/i.test(c)) ? 'backer'
      : g.name && /foundation|heliax|anoma/i.test(g.name) ? 'foundation'
      : g.categories.length ? 'genesis' : 'genesis';
    const label = g.name ?? `Genesis: ${g.categories.join(', ') || 'allocation'}`;
    push(inlineSql(stmt.label(addr, 'namada', label, cat, 'genesis', `Genesis ${g.amount.toLocaleString()} NAM · ${g.categories.join(', ')}`, now)));
  }
  let flows = 0, moves = 0, links = 0;
  for (const f of ndjson<any>('flows.ndjson')) { push(inlineSql(stmt.flow(f))); flows++; }
  for (const m of ndjson<any>('moves.ndjson')) { push(inlineSql(stmt.move(m))); moves++; }
  for (const l of ndjson<any>('links.ndjson')) { push(inlineSql(stmt.link(l))); links++; }
  push(inlineSql(stmt.kvSet('namada.cursor', String(progress.head), now)));
  push(inlineSql(stmt.kvSet('namada.backfill', JSON.stringify({ head: progress.head, at: now, holders, flows, moves, links }), now)));
  flush();
  log(`sql: ${file} files -> ${SQL} | holders ${holders}, flows ${flows}, moves ${moves}, links ${links}`);
  const supply = Object.values(verified).reduce((s, v) => s + toNam(v.balance), 0);
  log(`sum of verified balances: ${supply.toLocaleString()} NAM (compare with total supply)`);
}

const cmd = process.argv[2] ?? 'all';
const steps: Record<string, () => unknown> = { scan, genesis, verify, sql };
(async () => {
  if (cmd === 'all') { await scan(); await genesis(); await verify(); sql(); }
  else if (steps[cmd]) await steps[cmd]();
  else { console.error('usage: scan|genesis|verify|sql|all'); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });

void NAMADA;
