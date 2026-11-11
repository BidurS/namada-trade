// The stretches in which Namada made no blocks, as this site's checks treat them: a check that compares two readings
// does not judge a pair on either side of one (worker/src/cron.ts: the mint rule, the staking account's remainder, the
// shielded pool's daily ledger; the digest's two balance lines, worker/src/digest/message.ts). Whatever a node answers
// after such a stretch is the chain as it was made again, and a difference between it and a reading from before says
// nothing about the rule the check holds; the row says the pair was not judged, and the next pair, both after it, is
// judged as any other.
//
// Each stretch is named by the last block made before it: a reading at that block or before it and a reading at a
// later block are on either side, so no end has to be known for a pair of blocks. A pair of times needs one: the header
// time of the first block made after it. The table gives the header times measured for the stretches of the past (the
// chain's own blocks, test/fixtures/namada_blockchain_*.json; a test holds them equal). For a stretch whose end is not
// in the table, this site's block scan records that block's time when it reads it (kv resumedKv, live-hub.ts), and
// until it has, a pair of times is judged as before. The heights are the ones scripts/incidents.ts lists with their
// sources; a test holds the two lists equal.
import { fmtCount, fmtUtcLong } from './format';

export interface NoBlocks {
  /** the last block made before the stretch */
  lastBlock: number;
  /** that block's header time (unix ms) */
  lastBlockAt: number;
  /** the header time of the first block made after it; null while it is not in the table */
  resumedAt: number | null;
}

/** Every stretch on record, oldest first. */
export const NO_BLOCKS: readonly NoBlocks[] = [
  { lastBlock: 4_514_501, lastBlockAt: Date.UTC(2025, 11, 2, 16, 23, 46, 260), resumedAt: Date.UTC(2025, 11, 2, 18, 23, 14, 740) },
  { lastBlock: 7_912_187, lastBlockAt: Date.UTC(2026, 8, 1, 23, 43, 16, 697), resumedAt: Date.UTC(2026, 8, 2, 3, 6, 47, 809) },
  { lastBlock: 7_913_446, lastBlockAt: Date.UTC(2026, 8, 2, 6, 16, 49, 514), resumedAt: Date.UTC(2026, 8, 3, 15, 42, 46, 238) },
  { lastBlock: 7_914_107, lastBlockAt: Date.UTC(2026, 8, 3, 17, 31, 2, 225), resumedAt: Date.UTC(2026, 8, 6, 13, 12, 47, 329) },
  { lastBlock: 7_914_153, lastBlockAt: Date.UTC(2026, 8, 6, 13, 45, 22, 59), resumedAt: Date.UTC(2026, 8, 14, 16, 50, 23, 85) },
  { lastBlock: 8_200_078, lastBlockAt: Date.UTC(2026, 9, 7, 10, 12, 15, 744), resumedAt: Date.UTC(2026, 9, 8, 17, 3, 23, 821) },
  { lastBlock: 8_517_986, lastBlockAt: Date.UTC(2026, 10, 2, 22, 49, 36, 642), resumedAt: null },
];

/** Where the block scan records the header time of the first block made after a stretch whose end is not in the table. */
export const resumedKv = (lastBlock: number): string => `halt.resumed.${lastBlock}`;
/** The stretches whose end is not in the table: the block scan records it. */
export const openStretches = (list: readonly NoBlocks[] = NO_BLOCKS): NoBlocks[] => list.filter((s) => s.resumedAt == null);

/**
 * The records the block scan writes after reading blocks `lastScanned + 1` to `done`: for each stretch whose end is
 * not in the table, the first block after it, with its header time, when that block was among the ones read.
 */
export function resumedSeen(lastScanned: number, done: number, timeOf: (height: number) => number | undefined, list: readonly NoBlocks[] = NO_BLOCKS): { key: string; height: number; ts: number }[] {
  const out: { key: string; height: number; ts: number }[] = [];
  for (const s of openStretches(list)) {
    const first = s.lastBlock + 1, ts = timeOf(first);
    if (lastScanned < first && done >= first && Number.isFinite(ts)) out.push({ key: resumedKv(s.lastBlock), height: first, ts: ts! });
  }
  return out;
}

/** The stretch between two readings at blocks `from` and `to` (one at its last block or before, the other after), or null. */
export function noBlocksBetween(from: number | null | undefined, to: number | null | undefined, list: readonly NoBlocks[] = NO_BLOCKS): NoBlocks | null {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return list.find((s) => from! <= s.lastBlock && to! > s.lastBlock) ?? null;
}

/** The time of the first block after `s`: the table's, else the one the block scan recorded for it (`measured`, by last block). */
export const resumedOf = (s: NoBlocks, measured: Readonly<Record<number, number>> = {}): number | null => s.resumedAt ?? (Number.isFinite(measured[s.lastBlock]) && measured[s.lastBlock] > s.lastBlockAt ? measured[s.lastBlock] : null);

/**
 * The stretch two readings at times `startTs` and `endTs` are on either side of: one taken before the first block
 * after it was made, the other at that time or later. A stretch whose end is neither in the table nor in `measured`
 * is passed over. Returned with its end filled in.
 */
export function noBlocksAcrossTimes(startTs: number, endTs: number, measured: Readonly<Record<number, number>> = {}, list: readonly NoBlocks[] = NO_BLOCKS): NoBlocks | null {
  for (const s of list) {
    const end = resumedOf(s, measured);
    if (end != null && startTs < end && endTs >= end) return { ...s, resumedAt: end };
  }
  return null;
}

/** What a row says of a pair not judged across a stretch: from when to when no block was made, or after which block. */
export function notJudgedAcross(s: { lastBlock: number; lastBlockAt: number | null; resumedAt: number | null }): string {
  if (s.lastBlockAt != null && s.resumedAt != null) {
    return `not judged across a halt: Namada made no blocks from ${fmtUtcLong(s.lastBlockAt)} (block ${fmtCount(s.lastBlock)}) to ${fmtUtcLong(s.resumedAt)}`;
  }
  return `not judged across a halt: Namada made no blocks for a time after block ${fmtCount(s.lastBlock)}${s.lastBlockAt != null ? ` (${fmtUtcLong(s.lastBlockAt)})` : ''}`;
}

/** The fields a check's detail carries for it, so a page can say it in the same words. */
export const acrossDetail = (s: NoBlocks) => ({ lastBlock: s.lastBlock, lastBlockAt: s.lastBlockAt, resumedAt: s.resumedAt });
