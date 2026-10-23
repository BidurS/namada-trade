/**
 * The shielded-pool history rows and the two-node rule. The masp step of scripts/backfill-history.ts wrote 6,704
 * corrective flows on 2026-10-16 (meta.source 'namada-rpc-block-results': the pool's shielded IBC withdrawals of
 * 42.5M NAM, its fee legs to gas payers, a few shields and deposits, at 4,657 heights from 2,384,224 to 7,172,196),
 * each from the block_results answer of ONE archive node, before scripts/chain-agree.ts made two agreeing nodes the
 * rule for history (the step now records the nodes in meta.blockBy; these rows have none). This script brings those
 * rows under the rule without rewriting them: it reads every one of their heights from two nodes again and, for each
 * row whose block two nodes agree on, emits an UPDATE that sets meta.blockBy to the two nodes, in the form the masp
 * step writes it (the node URLs). Nothing else about a row changes.
 *
 * Reads the remote D1 with read-only SELECTs (scripts/lib.ts) and block_results from the public archive nodes the
 * masp step names, and writes SQL for the owner to check and apply (npm run db:apply -- <file>). Writes nothing itself.
 *
 *   npx tsx scripts/stamp-block-agreement.ts [--limit N] [--heights 2384224,3000049]    # writes scripts/out/blockby/
 *
 * Agreement: the nodes are asked in turn (chain-agree.ts agreed) until two give the same events for the block, every
 * event a parser reads (begin, end and finalize block events and the transactions' events), attribute order aside;
 * a block no two nodes agree on is listed with each node's answer digests, and its rows are not stamped. The rows of
 * an agreed block are also checked against what the current block parser (worker/src/parse/namada.ts, with the
 * wrappers' fee payers from /block where it asks for them) reads from the agreed events, matched by inner transaction
 * hash: kind, amount, both ends and the wrapper hash. Every difference is reported (differences.tsv, report.txt) and
 * none is changed. A row whose transaction the agreed block does not hold at all is not stamped: its data did not come
 * from this block. The report names no address: an end is shown by its last six characters.
 *
 * Each UPDATE is idempotent and guarded: it sets blockBy only on a row whose meta still lacks it and whose columns and
 * meta are as this run read them, so a row stamped before or changed since is left alone.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGREE, agreed, eventsKey, maspEvents, type Agreed } from './chain-agree';
import { d1 as d1once } from './lib';
import { NAMADA } from '../worker/src/config';
import { parseNamadaBlock } from '../worker/src/parse/namada';
import { feePayersOf } from '../worker/src/parse/namada-tx';
import type { RawEvent } from '../worker/src/parse/osmosis';
import type { Flow } from '../shared/types';

export const SOURCE = 'namada-rpc-block-results';
/** The archive nodes the masp step reads (backfill-history.ts ARCHIVE_RPCS, not exported), named as it names them. */
export const ARCHIVE_RPCS: readonly string[] = [...NAMADA.rpcs.map((r) => r.url), 'https://namada-rpc.polkachu.com', 'https://namada-rpc.stakeandrelax.net'];

export type StoredRow = { id: string; height: number; ts: number; tx_hash: string; kind: string; from_addr: string | null; to_addr: string | null; amount_num: number; meta: string | null };

// ------------------------------------------------------------------ pure parts (test/stamp-block-agreement.test.ts)

/** The events of a block_results answer as the Worker's blockResults reads them, or null for an answer without any. */
export function blockEvents(answer: any): RawEvent[] | null {
  const r = answer?.result;
  if (!r || typeof r !== 'object') return null;
  const evs: RawEvent[] = [...(r.begin_block_events ?? []), ...(r.end_block_events ?? []), ...(r.finalize_block_events ?? []), ...((r.txs_results ?? []) as any[]).flatMap((t) => t?.events ?? [])];
  return evs.length ? evs : null;
}

/** Two answers are the same block when every event is, attribute order aside (chain-agree.ts eventsKey, over every event). */
export const allEventsKey = (events: readonly RawEvent[]): string =>
  JSON.stringify(events.map((e) => [String(e?.type ?? ''), (Array.isArray(e?.attributes) ? e.attributes : []).map((a: any) => [String(a?.key ?? ''), String(a?.value ?? '')]).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))]));

/** The nodes starting from the i-th, so the reads of one run are spread over all of them. */
export const nodeOrder = (nodes: readonly string[], i: number): string[] => {
  const k = nodes.length ? ((i % nodes.length) + nodes.length) % nodes.length : 0;
  return [...nodes.slice(k), ...nodes.slice(0, k)];
};

export type Verdict = 'same' | 'same but the ends' | 'fee folded' | 'differs' | 'not in block';
export interface Comparison { verdict: Verdict; detail: string }

const near = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
const short = (a: string | null | undefined) => (a ? `…${a.slice(-6)}` : '(none)');
const innerOf = (f: Flow) => String(f.meta?.innerTxHash ?? '').toUpperCase();
const metaOf = (r: StoredRow): Record<string, unknown> => { try { return JSON.parse(r.meta ?? '{}') ?? {}; } catch { return {}; } };
const oneRow = (f: Flow) => `${f.kind} ${f.amount} ${f.meta?.tokenSymbol ? `${f.meta.tokenSymbol} ` : ''}${short(f.from)}->${short(f.to)}`;

/**
 * One stored row against the current parser's flows of the agreed block (`flows`, those not matched yet), by inner
 * transaction hash (the row's tx_hash; the parser keeps it in meta.innerTxHash under the wrapper's hash):
 * - same: a NAM flow of that transaction with the row's kind, amount and ends, and the row's wrapper as its tx hash;
 * - same but the ends: the same but for the end the parser resolves from the IBC packet (the stored escrow is the
 *   flow's meta.escrow, and the flow's other end is the packet's receiver or sender);
 * - fee folded: no flow carries this leg, and a flow of the transaction keeps its amount as the pool's fee (maspFeeNam);
 * - differs: the transaction is in the block, read otherwise (the detail says what differs, and the parser's other NAM
 *   rows of it);
 * - not in block: no flow of the agreed block comes from this transaction.
 * `used` collects the flow a same or same-but-the-ends row took, so two stored rows never stand on one leg.
 */
export function compareRow(r: StoredRow, flows: readonly Flow[], used: Set<Flow> = new Set()): Comparison {
  const inner = r.tx_hash.toUpperCase();
  const ofTx = flows.filter((f) => innerOf(f) === inner);
  if (!ofTx.length) return { verdict: 'not in block', detail: 'the agreed block holds no event of this transaction' };
  const nam = ofTx.filter((f) => !f.meta?.tokenSymbol && !used.has(f));
  const storedWrapper = String(metaOf(r).wrapper ?? '').toUpperCase();
  const wrapperNote = (f: Flow) => (storedWrapper && f.txHash.toUpperCase() !== storedWrapper ? `wrapper ${storedWrapper.slice(0, 8)} -> ${f.txHash.toUpperCase().slice(0, 8)}` : '');
  const sameEnds = (f: Flow) => (f.from ?? '') === (r.from_addr ?? '') && (f.to ?? '') === (r.to_addr ?? '');
  const exact = nam.find((f) => f.kind === r.kind && near(f.amount, r.amount_num) && sameEnds(f));
  if (exact) {
    used.add(exact);
    const w = wrapperNote(exact);
    return w ? { verdict: 'differs', detail: w } : { verdict: 'same', detail: '' };
  }
  const out = r.kind === 'ibc_out';
  const viaPacket = nam.find((f) => f.kind === r.kind && near(f.amount, r.amount_num) && (out
    ? f.meta?.escrow === r.to_addr && (f.from ?? '') === (r.from_addr ?? '')
    : r.kind === 'ibc_in' && f.meta?.escrow === r.from_addr && (f.to ?? '') === (r.to_addr ?? '')));
  if (viaPacket) {
    used.add(viaPacket);
    const seq = viaPacket.meta?.packetSequence ? `, sequence ${viaPacket.meta.packetSequence}` : '';
    const detail = out ? `to ${short(r.to_addr)} -> ${short(viaPacket.to)} (the packet's receiver${seq})` : `from ${short(r.from_addr)} -> ${short(viaPacket.from)} (the packet's sender${seq})`;
    const w = wrapperNote(viaPacket);
    return { verdict: w ? 'differs' : 'same but the ends', detail: w ? `${detail}; ${w}` : detail };
  }
  const fee = ofTx.find((f) => typeof f.meta?.maspFeeNam === 'number' && near(f.meta.maspFeeNam as number, r.amount_num));
  if (fee && r.kind === 'unshield') return { verdict: 'fee folded', detail: `the parser keeps this ${r.amount_num} NAM leg as the pool's fee (maspFeeNam) on its ${oneRow(fee)}` };
  const best = [...nam].sort((a, b) => (a.kind === r.kind ? 0 : 1) - (b.kind === r.kind ? 0 : 1) || Math.abs(a.amount - r.amount_num) - Math.abs(b.amount - r.amount_num))[0];
  if (!best) return { verdict: 'differs', detail: `the parser reads this transaction as ${ofTx.map(oneRow).join(', ')}: no NAM leg left for this row` };
  const parts: string[] = [];
  if (best.kind !== r.kind) parts.push(`kind ${r.kind} -> ${best.kind}`);
  if (!near(best.amount, r.amount_num)) parts.push(`amount ${r.amount_num} -> ${best.amount}`);
  if ((best.from ?? '') !== (r.from_addr ?? '')) parts.push(`from ${short(r.from_addr)} -> ${short(best.from)}`);
  if ((best.to ?? '') !== (r.to_addr ?? '')) parts.push(`to ${short(r.to_addr)} -> ${short(best.to)}`);
  const w = wrapperNote(best);
  if (w) parts.push(w);
  const others = nam.filter((f) => f !== best).map(oneRow);
  return { verdict: 'differs', detail: parts.join('; ') + (others.length ? ` (the parser's other NAM rows of this transaction: ${others.join(', ')})` : '') };
}

/** Every stored row of one block against the parser's flows of it, by id. */
export function compareRows(stored: readonly StoredRow[], flows: readonly Flow[]): Map<string, Comparison> {
  const used = new Set<Flow>();
  return new Map(stored.map((r) => [r.id, compareRow(r, flows, used)]));
}

/** A stored row is stamped when its block is agreed and holds its transaction. */
export const stampable = (c: Comparison): boolean => c.verdict !== 'not in block';

export const q = (v: unknown): string => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? (Number.isFinite(v) ? String(v) : 'NULL') : `'${String(v).replace(/'/g, "''")}'`);

/**
 * The UPDATE that stamps one row with the nodes that agree on its block. Idempotent: a row whose meta already has a
 * blockBy is not matched. Guarded: every column and the meta must be as this run read them, so a row changed since
 * (another repair, the parser) is left alone and listed by the owner's own apply count.
 */
export function stampSql(r: StoredRow, by: readonly string[]): string {
  if (by.length < AGREE) throw new Error(`stamp of ${r.id}: ${by.length} node(s), ${AGREE} must agree`);
  return `UPDATE flows SET meta = json_set(meta, '$.blockBy', json(${q(JSON.stringify(by))})) WHERE id = ${q(r.id)} AND chain = 'namada' AND height = ${r.height} AND tx_hash = ${q(r.tx_hash)} AND kind = ${q(r.kind)} AND COALESCE(from_addr, '') = ${q(r.from_addr ?? '')} AND COALESCE(to_addr, '') = ${q(r.to_addr ?? '')} AND ABS(amount_num - ${q(r.amount_num)}) <= 1e-9 AND json_extract(meta, '$.source') = ${q(SOURCE)} AND json_extract(meta, '$.blockBy') IS NULL AND meta = ${q(r.meta)};`;
}

// ------------------------------------------------------------------ the run

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

/** A read-only query, asked again (after a pause) when wrangler fails, as on D1's 7403 rate limit. */
function d1<T = any>(sql: string): T[] {
  for (let i = 0; ; i++) {
    try { return d1once<T>(sql); } catch (e) {
      if (i >= 5) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000 * (i + 1));
    }
  }
}

/** GET as text: a 429 or 5xx is tried again twice, any other refusal throws (chain-agree.ts agreed takes it as no answer). */
async function getText(url: string, tries = 3): Promise<string> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'NamadaTrade-stamp/1.0', Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { final: true });
      return await res.text();
    } catch (e) {
      last = e;
      if ((e as { final?: boolean })?.final) break;
      await sleep(700 * 2 ** i);
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

/** What one node answered for a block, for the record of a disagreement: size and digests of the answer and of its keys. */
type Answer = { bytes: number; raw: string; events: string | null; maspEvents: string | null; error?: string };

async function main() {
  const args = process.argv.slice(2);
  const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const limit = Number(arg('--limit') ?? 0);
  const only = new Set((arg('--heights') ?? '').split(',').map(Number).filter((h) => Number.isSafeInteger(h) && h > 0));
  const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out', 'blockby');
  mkdirSync(OUT, { recursive: true });
  const startedAt = new Date();

  const all = d1<StoredRow>(`SELECT id, height, ts, tx_hash, kind, from_addr, to_addr, amount_num, meta FROM flows WHERE chain = 'namada' AND json_extract(meta, '$.source') = ${q(SOURCE)} ORDER BY height, id`)
    .map((r) => ({ ...r, height: Number(r.height), ts: Number(r.ts), amount_num: Number(r.amount_num) }));
  const already = all.filter((r) => metaOf(r).blockBy != null);
  const rows = all.filter((r) => metaOf(r).blockBy == null);
  const byH = new Map<number, StoredRow[]>();
  for (const r of rows) (byH.get(r.height) ?? byH.set(r.height, []).get(r.height)!).push(r);
  let heights = [...byH.keys()].sort((a, b) => a - b);
  if (only.size) heights = heights.filter((h) => only.has(h));
  if (limit > 0) heights = heights.slice(0, limit);
  const lo = heights[0], hi = heights[heights.length - 1];
  log(`${all.length} rows of source ${SOURCE} (${already.length} already stamped, left alone); ${rows.length} to stamp at ${byH.size} heights; this run reads ${heights.length} heights${heights.length ? ` ${lo}..${hi}` : ''} from ${ARCHIVE_RPCS.join(', ')}`);

  const sql: string[] = [];
  const diffs: string[] = ['height\tid\tkind\tamount\tverdict\tdetail'];
  const disagreed: { height: number; rows: number; error: string; answers: Record<string, Answer> }[] = [];
  const pairs = new Map<string, number>();
  const verdicts = new Map<Verdict, number>();
  const notStamped = { 'block not agreed': 0, 'not in block': 0 };
  let stamped = 0, agreedHeights = 0, feePayerHeights = 0, feePayerUnread = 0, done = 0;
  const tally = <K>(m: Map<K, number>, k: K) => m.set(k, (m.get(k) ?? 0) + 1);

  await pool(heights, 6, async (h, i) => {
    const stored = byH.get(h)!;
    const answers: Record<string, Answer> = {};
    const nodes = nodeOrder(ARCHIVE_RPCS, i);
    let a: Agreed<RawEvent[]> | null = null, error = '';
    try {
      a = await agreed(nodes, async (node) => {
        let text: string;
        try { text = await getText(`${node}/block_results?height=${h}`); } catch (e) { answers[node] = { bytes: 0, raw: '', events: null, maspEvents: null, error: String(e instanceof Error ? e.message : e).slice(0, 120) }; throw e; }
        let json: any = null;
        try { json = JSON.parse(text); } catch { /* not JSON: no events below */ }
        const evs = blockEvents(json);
        const masp = maspEvents(json);
        answers[node] = { bytes: text.length, raw: sha(text), events: evs ? sha(allEventsKey(evs)) : null, maspEvents: masp ? sha(eventsKey(masp)) : null };
        return evs;
      }, allEventsKey);
      if (!a) error = `no ${AGREE} nodes gave the same events`;
    } catch (e) { error = String(e instanceof Error ? e.message : e).slice(0, 160); }
    if (!a) {
      disagreed.push({ height: h, rows: stored.length, error, answers });
      notStamped['block not agreed'] += stored.length;
      log(`  ${h}: ${error} (${stored.length} rows not stamped)`);
    } else {
      agreedHeights++;
      tally(pairs, a.by.join(' + '));
      // The current parser's reading of the agreed events, with the wrappers' fee payers when it asks for them: the
      // block's transactions, taken as the events are, only when two nodes give the same.
      let p = parseNamadaBlock({ height: h, ts: stored[0].ts, events: a.value }, null);
      if (p.feePayerWanted.length) {
        feePayerHeights++;
        let txs: Agreed<string[]> | null = null;
        try {
          txs = await agreed([...a.by, ...nodes.filter((n) => !a!.by.includes(n))], async (node) => {
            const v = JSON.parse(await getText(`${node}/block?height=${h}`));
            return Array.isArray(v?.result?.block?.data?.txs) ? (v.result.block.data.txs as string[]) : null;
          });
        } catch { /* counted below */ }
        if (txs) p = parseNamadaBlock({ height: h, ts: stored[0].ts, events: a.value }, null, feePayersOf(txs.value));
        else feePayerUnread++;
      }
      const cmp = compareRows(stored, p.flows);
      for (const r of stored) {
        const c = cmp.get(r.id)!;
        tally(verdicts, c.verdict);
        if (stampable(c)) { sql.push(stampSql(r, a.by)); stamped++; } else notStamped['not in block']++;
        if (c.verdict !== 'same') diffs.push([h, r.id, r.kind, r.amount_num, c.verdict, c.detail].join('\t'));
      }
    }
    if (++done % 200 === 0 || done === heights.length) log(`  ${done}/${heights.length} heights: ${agreedHeights} agreed, ${disagreed.length} not; ${stamped} rows stamped`);
  });

  const head = [
    `-- scripts/stamp-block-agreement.ts, ${startedAt.toISOString()}: meta.blockBy for the rows of source '${SOURCE}' whose block two`,
    `-- archive nodes agree on (every event of the block, attribute order aside). ${stamped} rows at ${agreedHeights} heights; each statement`,
    `-- changes only a row still as read, with no blockBy yet. Apply with: npm run db:apply -- scripts/out/blockby/stamp-block-agreement.sql`,
  ];
  writeFileSync(join(OUT, 'stamp-block-agreement.sql'), [...head, ...sql].join('\n') + '\n');
  writeFileSync(join(OUT, 'differences.tsv'), diffs.join('\n') + '\n');
  const order: Verdict[] = ['same', 'same but the ends', 'fee folded', 'differs', 'not in block'];
  const report = {
    at: startedAt.toISOString(), source: SOURCE, nodes: ARCHIVE_RPCS, rows: all.length, alreadyStamped: already.length, heightsInStore: byH.size,
    heightsRead: heights.length, from: lo ?? null, to: hi ?? null, agreed: agreedHeights, disagreed: disagreed.length,
    pairs: Object.fromEntries([...pairs].sort((x, y) => y[1] - x[1])), stamped, notStamped,
    verdicts: Object.fromEntries(order.map((v) => [v, verdicts.get(v) ?? 0])), feePayerHeights, feePayerUnread, disagreements: disagreed,
  };
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 1));
  const lines = [
    `stamp-block-agreement, ${startedAt.toISOString()} (finished ${new Date().toISOString()})`,
    `rows of source '${SOURCE}': ${all.length} at ${new Set(all.map((r) => r.height)).size} heights; ${already.length} already stamped (left alone); ${rows.length} without blockBy at ${byH.size} heights`,
    `nodes asked, in turn from a different one each height: ${ARCHIVE_RPCS.join(', ')}`,
    `heights read: ${heights.length}${heights.length ? ` (${lo}..${hi})` : ''}; agreed by two nodes: ${agreedHeights}; no two nodes agreed: ${disagreed.length}`,
    `node pairs that agreed: ${[...pairs].sort((x, y) => y[1] - x[1]).map(([k, n]) => `${k}: ${n}`).join('; ') || 'none'}`,
    `rows stamped: ${stamped} (one UPDATE each, stamp-block-agreement.sql); not stamped: ${notStamped['block not agreed']} at blocks no two nodes agreed on, ${notStamped['not in block']} whose transaction the agreed block does not hold`,
    `rows against the current parser's reading of the agreed block: ${order.map((v) => `${v} ${verdicts.get(v) ?? 0}`).join('; ')} (each row that is not the same is in differences.tsv)`,
    `  same but the ends: the end the parser resolves from the IBC packet (the stored escrow is the row's meta.escrow now); fee folded: a leg the parser keeps as maspFeeNam on the transfer's own row`,
    `fee payers read from /block (two nodes agreeing) for ${feePayerHeights} heights the parser asked for them; not readable from two nodes for ${feePayerUnread} (parsed without)`,
  ];
  if (disagreed.length) {
    lines.push('blocks no two nodes agreed on (bytes, digest of the answer, of its events, of its token/masp events; an error when a node gave no answer):');
    for (const d of disagreed) {
      lines.push(`  ${d.height} (${d.rows} rows): ${d.error}`);
      for (const [node, x] of Object.entries(d.answers)) lines.push(`    ${node}: ${x.error ? x.error : `${x.bytes} B, answer ${x.raw}, events ${x.events ?? 'none'}, token/masp events ${x.maspEvents ?? 'none'}`}`);
    }
  }
  writeFileSync(join(OUT, 'report.txt'), lines.join('\n') + '\n');
  for (const l of lines) log(l);
  log(`written to ${OUT}`);
}

const isMain = process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
