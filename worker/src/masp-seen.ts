// The shielded transactions a Namada block's results record, by the chain's own index (migration 0021 masp_seen):
// collected by the live hub from the block_results it already reads for every block (live-hub.ts scanNamada) and
// compared, hourly, with what Namada's shielded-transaction indexer lists for the same blocks (cron.ts
// masp_tx_coverage, sources/masp-indexer.ts). Indexes only: nothing of a transaction's content is read or kept.
import type { NamadaBlock } from './parse/namada';
import type { Stmt } from './db';

/** One shielded transaction a block's results record: the event's indexed-tx, and the word for the event(s) that named it. */
export interface MaspSeen { height: number; blockIndex: number; batchIndex: number; kind: string }

/** The event types that carry a shielded transaction's index, and the word each is recorded by. */
export const MASP_EVENT_KINDS: Readonly<Record<string, string>> = { 'masp/transfer': 'transfer', 'masp/fee-payment': 'fee-payment' };

/** The key of a transaction's place on the chain, as the coverage check pairs the two records. */
export const seenKey = (height: number, blockIndex: number, batchIndex: number): string => `${height}:${blockIndex}:${batchIndex}`;

const index = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : typeof v === 'string' && /^\d{1,12}$/.test(v) ? Number(v) : null);

/**
 * Every shielded transaction `block`'s events record, each once: a `masp/transfer` or `masp/fee-payment` event's
 * `indexed-tx` attribute, {"block_height":H,"block_index":I,"batch_index":B} (as the results of blocks 8,515,250 and
 * 7,903,391 carry it, test/fixtures/masp_block_*.json). An event without the attribute, with one that does not parse
 * or that names another block is left out and counted in `refused`, never guessed. An inner transaction both events
 * name is one row, kind 'fee-payment+transfer' (the kinds sorted, so the same events always give the same word).
 */
export function maspSeenOf(block: NamadaBlock): { seen: MaspSeen[]; refused: number } {
  const by = new Map<string, MaspSeen & { kinds: Set<string> }>();
  let refused = 0;
  for (const e of block.events ?? []) {
    const kind = MASP_EVENT_KINDS[e.type];
    if (!kind) continue;
    const raw = e.attributes?.find((a) => a.key === 'indexed-tx')?.value;
    let parsed: unknown = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
    const o = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    const height = index(o?.block_height), blockIndex = index(o?.block_index), batchIndex = index(o?.batch_index);
    if (height == null || blockIndex == null || batchIndex == null || height !== block.height) { refused++; continue; }
    const k = seenKey(height, blockIndex, batchIndex);
    const row = by.get(k) ?? { height, blockIndex, batchIndex, kind: '', kinds: new Set<string>() };
    row.kinds.add(kind);
    by.set(k, row);
  }
  const seen = [...by.values()]
    .map(({ kinds, ...r }) => ({ ...r, kind: [...kinds].sort().join('+') }))
    .sort((a, b) => a.blockIndex - b.blockIndex || a.batchIndex - b.batchIndex);
  return { seen, refused };
}

/** Rows for masp_seen, INSERT OR IGNORE (a block read again changes nothing), 24 rows a statement (4 parameters a row; D1 binds at most 100). */
export function maspSeenStmts(rows: MaspSeen[]): Stmt[] {
  const out: Stmt[] = [];
  for (let i = 0; i < rows.length; i += 24) {
    const part = rows.slice(i, i + 24);
    out.push({
      sql: `INSERT OR IGNORE INTO masp_seen (height, block_index, batch_index, kind) VALUES ${part.map(() => '(?,?,?,?)').join(',')}`,
      params: part.flatMap((r) => [r.height, r.blockIndex, r.batchIndex, r.kind]),
    });
  }
  return out;
}

/** The rows of masp_seen from one height to another, both included (the coverage check's window), on the primary key. */
export const MASP_SEEN_RANGE_SQL = 'SELECT height, block_index, batch_index, kind FROM masp_seen WHERE height >= ? AND height <= ? ORDER BY height, block_index, batch_index';
