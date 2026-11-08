// Namada's shielded-transaction indexer (namada-masp-indexer, config.ts MASP_INDEXER): the second source of the
// masp_tx_coverage check (cron.ts maspCoverageCheck), which compares what it lists for a range of blocks with the
// shielded transactions this site's block follower saw (masp-seen.ts). Read for each transaction's place on the chain
// only; the transaction bytes it carries are never kept, and no figure on the site comes from it.
//
// Checked against the live service on 2026-11-07 (GET /health: {"commit":…,"version":"1.4.7"}; there is no
// /api/v1/health):
// - GET /api/v1/height answers {"block_height": N}: its last block with a shielded transaction, not its scan tip
//   (8,517,143 while the chain's last block was 8,517,986).
// - GET /api/v1/tx?height=H&height_offset=N answers {"txs": [{block_height, block_index, batch: [{masp_tx_index,
//   is_masp_fee_payment, bytes}]}]} for the blocks H to H + N, both included (H=8515150, N=100 listed blocks 8515196
//   and 8515250; H=8515250, N=0 listed 8515250). A range whose end is above /height answers HTTP 500 ("Height range
//   8517144 -- 8517154 of the requested txs exceeds latest block height (8517143)"), so a window ends below it.
// - block_index is the transaction's index in the block and masp_tx_index the inner transaction's index in its batch,
//   as the chain's own masp events name them (the indexed-tx attribute masp-seen.ts reads): block 8,515,250
//   {block_index 0, batch_index 0} ↔ (0, masp_tx_index 0); 7,903,391 {1, 0} ↔ (1, 0); 8,512,781, 8,487,061,
//   8,408,965 and 8,395,504 {0, 1} ↔ (0, 1) (test/fixtures/masp_indexer_tx_*.json against the blocks' results).
// - A page of 3,000 blocks was 38 KB at most across the chain's last 40,000 blocks (5 transactions); a window is
//   capped at MASP_INDEXER_MAX_HEIGHTS blocks and a read at MASP_INDEXER_MAX_BYTES.
import { MASP_INDEXER } from '../config';
import { fetchJson } from '../util';

/** The health row of this source, as the sheet names it (cron.ts). */
export const MASP_INDEXER_HEALTH = 'masp.namada.net (MASP transactions)';
/** The most blocks one read asks for (about five hours of blocks). */
export const MASP_INDEXER_MAX_HEIGHTS = 3000;
/** The most one answer may hold; past it the read fails and the window is not judged. */
export const MASP_INDEXER_MAX_BYTES = 2 * 1024 * 1024;
/** One attempt, ten seconds, for each of the two reads an hour. */
export const MASP_INDEXER_TIMEOUT_MS = 10_000;

export interface MaspIndexerOpts { signal?: AbortSignal; timeoutMs?: number }

/** One shielded transaction the indexer lists, by its place on the chain (the same key masp-seen.ts records). */
export interface MaspIndexerTx { height: number; blockIndex: number; batchIndex: number; feePayment: boolean }

const whole = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);

/** The indexer's last block with a shielded transaction (/api/v1/height); an answer of another shape is refused. */
export async function maspIndexerHeight(opts: MaspIndexerOpts = {}): Promise<number> {
  const v = await fetchJson<{ block_height?: unknown }>(`${MASP_INDEXER}/api/v1/height`, { timeoutMs: opts.timeoutMs ?? MASP_INDEXER_TIMEOUT_MS, retries: 0, signal: opts.signal });
  const h = whole(v?.block_height);
  if (h == null || h <= 0) throw new Error('masp indexer: /api/v1/height answered without a block height');
  return h;
}

/**
 * The transactions of a /api/v1/tx answer, one entry per inner transaction, by its place on the chain: an answer whose
 * shape is not the one above, or that lists a block outside `from`..`to`, is refused whole (nothing is judged from a
 * page this reader does not understand). The bytes are not read.
 */
export function parseMaspIndexerTxs(v: unknown, from: number, to: number): MaspIndexerTx[] {
  const txs = (v as { txs?: unknown } | null)?.txs;
  if (!Array.isArray(txs)) throw new Error('masp indexer: answer without a txs list');
  const out: MaspIndexerTx[] = [];
  for (const t of txs as Record<string, unknown>[]) {
    const height = whole(t?.block_height), blockIndex = whole(t?.block_index);
    if (height == null || blockIndex == null || !Array.isArray(t.batch)) throw new Error('masp indexer: a transaction without its block height, block index or batch');
    if (height < from || height > to) throw new Error(`masp indexer: a transaction of block ${height}, outside blocks ${from} to ${to}`);
    for (const b of t.batch as Record<string, unknown>[]) {
      const batchIndex = whole(b?.masp_tx_index);
      if (batchIndex == null) throw new Error(`masp indexer: a transaction of block ${height} without its batch index`);
      out.push({ height, blockIndex, batchIndex, feePayment: b.is_masp_fee_payment === true });
    }
  }
  return out.sort((a, b) => a.height - b.height || a.blockIndex - b.blockIndex || a.batchIndex - b.batchIndex);
}

/** The shielded transactions the indexer lists for the blocks `from` to `to`, both included (at most MASP_INDEXER_MAX_HEIGHTS blocks). */
export async function maspIndexerTxs(from: number, to: number, opts: MaspIndexerOpts = {}): Promise<MaspIndexerTx[]> {
  if (!(Number.isInteger(from) && Number.isInteger(to) && from > 0 && to >= from)) throw new Error(`masp indexer: not a window: blocks ${from} to ${to}`);
  if (to - from + 1 > MASP_INDEXER_MAX_HEIGHTS) throw new Error(`masp indexer: a window of ${to - from + 1} blocks, over the ${MASP_INDEXER_MAX_HEIGHTS} one read asks for`);
  const v = await fetchJson<unknown>(`${MASP_INDEXER}/api/v1/tx?height=${from}&height_offset=${to - from}`, {
    timeoutMs: opts.timeoutMs ?? MASP_INDEXER_TIMEOUT_MS, retries: 0, signal: opts.signal, maxBytes: MASP_INDEXER_MAX_BYTES,
  });
  return parseMaspIndexerTxs(v, from, to);
}
