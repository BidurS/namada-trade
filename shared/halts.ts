// The stretches in which Namada made no blocks, as this site's checks treat them: a check that compares two readings
// does not judge a pair on either side of one (worker/src/cron.ts: the mint rule, the staking account's remainder, the
// shielded pool's daily ledger; the digest's two balance lines, worker/src/digest/message.ts). Whatever a node answers
// after such a stretch is the chain as it was made again, and a difference between it and a reading from before says
// nothing about the rule the check holds; the row says the pair was not judged, and the next pair, both after it, is
// judged as any other.
//
// Each stretch is named by the last block made before it: a reading at that block or before it and a reading at a
// later block are on either side, so no end has to be known for a pair of blocks. A pair of times needs one: the time
// blocks were made again. A block's header time is the time the block before it was agreed on, so the first block
// after a stretch carries either the time blocks were made again (when the last block was agreed on only then) or a
// time seconds after the last block's (when it was agreed on before the stretch), and a block made from votes signed
// during the stretch can carry a time from inside it. So the end is measured where it happens: the time the first block
// committed after the stretch was committed, the signing time in its commit at which two thirds of the power had
// signed (endByCommits, commitTime). When the commits cannot be read, the end is the header time of the first of the
// three blocks after the stretch that is END_GAP_MS or more after the last block's AND is followed by the next block
// within FOLLOW_GAP_MS (endAfter): blocks were being made at that time. The table gives the ends
// measured for the stretches of the past (the chain's own blocks, test/fixtures/namada_blockchain_*.json; a test
// holds them equal). For a stretch whose end is not in the table, the tick reads it from a node within a minute of the
// blocks that tell it and records it (kv resumedKv, cron.ts readResumed). The heights are the
// ones scripts/incidents.ts lists with their sources; a test holds the two lists equal.
import { fmtCount, fmtUtcLong } from './format';

export interface NoBlocks {
  /** the last block made before the stretch */
  lastBlock: number;
  /** that block's header time (unix ms) */
  lastBlockAt: number;
  /** when blocks were made again: the time the first block after it committed (endByCommits); null while it is not in the table */
  resumedAt: number | null;
}

/** Every stretch on record, oldest first. */
export const NO_BLOCKS: readonly NoBlocks[] = [
  { lastBlock: 4_514_501, lastBlockAt: Date.UTC(2025, 11, 2, 16, 23, 46, 260), resumedAt: Date.UTC(2025, 11, 2, 18, 23, 14, 933) },
  { lastBlock: 7_912_187, lastBlockAt: Date.UTC(2026, 8, 1, 23, 43, 16, 697), resumedAt: Date.UTC(2026, 8, 2, 3, 6, 53, 900) },
  { lastBlock: 7_913_446, lastBlockAt: Date.UTC(2026, 8, 2, 6, 16, 49, 514), resumedAt: Date.UTC(2026, 8, 3, 15, 42, 53, 131) },
  { lastBlock: 7_914_107, lastBlockAt: Date.UTC(2026, 8, 3, 17, 31, 2, 225), resumedAt: Date.UTC(2026, 8, 6, 13, 37, 29, 999) },
  { lastBlock: 7_914_153, lastBlockAt: Date.UTC(2026, 8, 6, 13, 45, 22, 59), resumedAt: Date.UTC(2026, 8, 14, 17, 3, 27, 763) },
  { lastBlock: 8_200_078, lastBlockAt: Date.UTC(2026, 9, 7, 10, 12, 15, 744), resumedAt: Date.UTC(2026, 9, 8, 17, 14, 16, 253) },
  { lastBlock: 8_517_986, lastBlockAt: Date.UTC(2026, 10, 2, 22, 49, 36, 642), resumedAt: null },
];

/** A header shorter than this after the last block's is the time the last block was agreed on, never the time blocks were made again (one this long or more can be, endAfter). */
export const END_GAP_MS = 10 * 60_000;
/**
 * A header followed by the next block's within this is a time blocks were being made (Namada makes a block every 6 to 7
 * seconds). A block's header is the weighted median of the signing times in the commit of the block before it, so the
 * first block after a restart can carry a time earlier than when blocks moved: signatures made before or during the
 * stretch count among the earliest (8,517,987's commit holds 21.53% of power precommitted on 3 November 2026), and
 * after past restarts the first block's header was 11 to 25 minutes before the next one's (7,914,107, 7,914,153,
 * 8,200,078). Such a header is followed by the next only minutes or days later and is no end; the next one, signed
 * once blocks move, is.
 */
export const FOLLOW_GAP_MS = 5 * 60_000;
/** The blocks after a stretch's last block among which its end is looked for. */
export const END_SPAN = 3;
/**
 * The end of a stretch from the header times of the blocks after it (`timeOf`, by height): the first of the END_SPAN
 * blocks after its last block whose header is END_GAP_MS or more after the last block's and whose next block's header
 * is FOLLOW_GAP_MS or less after it (and later than it). undefined when a header needed to tell is not known (not read, or not made yet);
 * null when none of them is.
 */
export function endAfter(s: Pick<NoBlocks, 'lastBlock' | 'lastBlockAt'>, timeOf: (height: number) => number | undefined): { height: number; ts: number } | null | undefined {
  const at = (h: number) => { const t = timeOf(h); return t != null && Number.isFinite(t) ? t : undefined; };
  for (let h = s.lastBlock + 1; h <= s.lastBlock + END_SPAN; h++) {
    const t = at(h);
    if (t == null) return undefined;
    if (t - s.lastBlockAt < END_GAP_MS) continue;
    const next = at(h + 1);
    if (next == null) return undefined;
    if (next > t && next - t <= FOLLOW_GAP_MS) return { height: h, ts: t };
  }
  return null;
}
/** One signature of a block's commit, in the order of the validator set at that height (CometBFT keeps them so). */
export interface CommitSig { flag: number; address: string; ts: number }
/** One validator of the set at a height, as /validators lists them. */
export interface SetValidator { address: string; power: bigint }
/**
 * When a block was committed: the signing time at which the voting power of the commit's signatures (flag 2), taken in
 * time order, first passes two thirds of the set's power, as CometBFT needs to commit. Signatures made before or
 * during a stretch count among the earliest, and the crossing always lands on one made once enough power was back.
 * null when the commit and the set do not line up (a different length, or a signature whose validator is another).
 */
export function commitTime(sigs: readonly CommitSig[], set: readonly SetValidator[]): number | null {
  if (!sigs.length || sigs.length !== set.length) return null;
  const total = set.reduce((a, v) => a + v.power, 0n);
  const signed: { ts: number; power: bigint }[] = [];
  for (let i = 0; i < sigs.length; i++) {
    if (sigs[i].flag !== 2) continue;
    if (sigs[i].address !== set[i].address || !Number.isFinite(sigs[i].ts)) return null;
    signed.push({ ts: sigs[i].ts, power: set[i].power });
  }
  signed.sort((a, b) => a.ts - b.ts);
  let sum = 0n;
  for (const x of signed) {
    sum += x.power;
    if (sum * 3n > total * 2n) return x.ts;
  }
  return null;
}
/**
 * The end of a stretch from when the blocks around it were committed (`committedAt`, by height): the commit time of
 * the first of its last block and the END_SPAN blocks after it that was committed END_GAP_MS or more after the last
 * block's header. A last block can be committed only when blocks are made again (every stretch before 8,517,986), or
 * seconds after it, before the stretch (8,517,986, committed at 22:49:51). undefined when a commit needed to tell is not
 * known; null when none of them is that late.
 */
export function endByCommits(s: Pick<NoBlocks, 'lastBlock' | 'lastBlockAt'>, committedAt: (height: number) => number | undefined): { height: number; ts: number } | null | undefined {
  for (let h = s.lastBlock; h <= s.lastBlock + END_SPAN; h++) {
    const t = committedAt(h);
    if (t == null || !Number.isFinite(t)) return undefined;
    if (t - s.lastBlockAt >= END_GAP_MS) return { height: h, ts: t };
  }
  return null;
}
/** The version of the rule a recorded end was told by: a record without it (or with an older one) is told again from the chain. */
export const RESUMED_RULE = 4;
/** Where the tick records the end of a stretch whose end is not in the table (cron.ts readResumed: the block, the time, the rule, how it was told). */
export const resumedKv = (lastBlock: number): string => `halt.resumed.${lastBlock}`;
/** The stretches whose end is not in the table: the tick records it. */
export const openStretches = (list: readonly NoBlocks[] = NO_BLOCKS): NoBlocks[] => list.filter((s) => s.resumedAt == null);

/** The stretch between two readings at blocks `from` and `to` (one at its last block or before, the other after), or null. */
export function noBlocksBetween(from: number | null | undefined, to: number | null | undefined, list: readonly NoBlocks[] = NO_BLOCKS): NoBlocks | null {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return list.find((s) => from! <= s.lastBlock && to! > s.lastBlock) ?? null;
}

/** The time of the first block after `s`: the table's, else the one the block scan recorded for it (`measured`, by last block). */
export const resumedOf = (s: NoBlocks, measured: Readonly<Record<number, number>> = {}): number | null => s.resumedAt ?? (validEnd(s, measured[s.lastBlock]) ? measured[s.lastBlock] : null);
/** Whether a measured end can be a stretch's end: END_GAP_MS or more after its last block's header (a record of the block agreed on seconds after it is not). */
export const validEnd = (s: Pick<NoBlocks, 'lastBlockAt'>, ts: unknown): ts is number => typeof ts === 'number' && Number.isFinite(ts) && ts - s.lastBlockAt >= END_GAP_MS;

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

/** The end a kv resumedKv record holds, when it was told by the current rule (RESUMED_RULE) and can be an end; else null. */
export function recordedEnd(s: Pick<NoBlocks, 'lastBlockAt'>, value: string | null | undefined): number | null {
  let v: { ts?: unknown; rule?: unknown } | null = null;
  try { v = JSON.parse(value ?? ''); } catch { return null; }
  if (!v || v.rule !== RESUMED_RULE) return null;
  const ts = Number(v.ts);
  return validEnd(s, ts) ? ts : null;
}
/** How a kv resumedKv record's end was told: from the commits, or from the headers when no commit could be read (provisional). */
export function recordedHow(value: string | null | undefined): 'commit' | 'header' | null {
  try { const v = JSON.parse(value ?? ''); return v?.how === 'commit' || v?.how === 'header' ? v.how : null; } catch { return null; }
}
