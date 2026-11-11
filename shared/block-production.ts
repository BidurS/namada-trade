// Whether Namada is making blocks, measured: judged from the site's own last reading of the Namada nodes and the
// network indexer (the cross-checks rpc_consensus and indexer_lag, which worker/src/cron.ts writes every minute with
// each node's newest block and the indexer's). Namada makes a block every few seconds, so a newest block far older
// than the reading, confirmed by a second source, means none is being made. This is not the Namada team's notice
// (shared/halt.ts, set by hand): it says when blocks stop and when they start again with nothing changed on the site.
// The served status page (worker/src/seo.ts statusFacts), the app's (web/src/screens/seo/Status.tsx) and the
// overview's stamp of the newest Namada block (worker/src/api.ts) all state it from here.
import { NAMADA_CHAIN_ID } from './config';
import { fmtAge, fmtCount, fmtUtcLong } from './format';

/** A newest block older than this at the reading means no block is being made (worker/src/sources/namada.ts HEAD_MAX_AGE_MS). */
export const BLOCKS_STOPPED_AFTER_MS = 5 * 60_000;
/** The nodes are asked every minute: a reading older than this is said as old. */
export const BLOCKS_READING_MAX_AGE_MS = 15 * 60_000;
/** The indexer's newest block counts only when it was read in the same reading as the nodes'. */
const SAME_READING_MS = 2 * 60_000;
/** A block time further ahead of the reading than this is a node's clock, not a block: that answer is not used. */
const AHEAD_MS = 60_000;

/** A stored cross-check as the overview serves it (detail an object) or as its table row holds it (detail JSON text). */
export interface CheckLike { key: string; detail: unknown; checkedAt: number }

export interface BlockProduction {
  /** 'making': a recent newest block; 'stopped': none for longer than BLOCKS_STOPPED_AFTER_MS, confirmed by a second source; 'unknown': the reading cannot tell */
  state: 'making' | 'stopped' | 'unknown';
  /** the newest block a node on Namada's chain reported, and when it was made */
  height: number | null;
  blockAt: number | null;
  /** when the nodes were asked; null when they have not been */
  readAt: number | null;
  /** nodes asked; of them, those whose newest block is used, those still catching up, those whose answer could not be
   *  used (another chain, or a block time ahead of the reading), and those that gave no newest block */
  asked: number;
  answered: number;
  catching: number;
  unusable: number;
  silent: number;
  /** the network indexer's newest block at the same reading, when it was read */
  indexerHeight: number | null;
  /** the reading is older than BLOCKS_READING_MAX_AGE_MS */
  oldReading: boolean;
  /** why the reading cannot tell, when state is 'unknown' */
  why: string | null;
}

const parsed = (d: unknown): Record<string, unknown> | null => {
  if (typeof d === 'string') { try { const v = JSON.parse(d); return v && typeof v === 'object' ? v : null; } catch { return null; } }
  return d && typeof d === 'object' ? (d as Record<string, unknown>) : null;
};
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const CANNOT = 'so the reading cannot tell whether blocks are being made.';

export function blockProduction(checks: readonly CheckLike[] | null | undefined, now: number): BlockProduction {
  const rpc = checks?.find((c) => c.key === 'rpc_consensus');
  const none = { height: null, blockAt: null, asked: 0, answered: 0, catching: 0, unusable: 0, silent: 0, indexerHeight: null };
  if (!rpc || !finite(rpc.checkedAt)) return { ...none, state: 'unknown', readAt: null, oldReading: false, why: 'The Namada nodes have not been asked yet.' };
  const readAt = rpc.checkedAt;
  const oldReading = now - readAt > BLOCKS_READING_MAX_AGE_MS;
  const raw = parsed(rpc.detail)?.statuses;
  const statuses = (Array.isArray(raw) ? raw : []).map(parsed);
  // each node's answer, sorted: no newest block at all, still catching up, not usable, or used
  let silent = 0, catching = 0, unusable = 0;
  const answers: { height: number; time: number }[] = [];
  // nodes still catching up: their blocks are the chain's, so a recent one shows blocks are being made, and a newer
  // one than the old block the others give shows the chain has moved past it
  const catchingBlocks: { height: number; time: number }[] = [];
  const otherChain = (s: Record<string, unknown>) => typeof s.network === 'string' && s.network !== '' && s.network !== NAMADA_CHAIN_ID;
  for (const s of statuses) {
    if (!s || s.error != null) { silent++; continue; }
    const block = finite(s.height) && s.height > 0 && finite(s.time);
    if (otherChain(s) || (block && (s.time as number) > readAt + AHEAD_MS)) unusable++;
    else if (s.catchingUp === true) { catching++; if (block) catchingBlocks.push({ height: s.height as number, time: s.time as number }); }
    else if (!block) silent++;
    else answers.push({ height: s.height as number, time: s.time as number });
  }
  const idx = checks?.find((c) => c.key === 'indexer_lag');
  const idxH = idx && finite(idx.checkedAt) && Math.abs(idx.checkedAt - readAt) <= SAME_READING_MS ? Number(parsed(idx.detail)?.indexerHeight) : NaN;
  const indexerHeight = Number.isFinite(idxH) && idxH > 0 ? idxH : null;
  const base = { readAt, asked: statuses.length, answered: answers.length, catching, unusable, silent, indexerHeight, oldReading };
  // any node with a recent newest block, catching up or not, shows blocks are being made; the newest of those is stated
  const pick = (xs: { height: number; time: number }[]) => xs.reduce((a, b) => (b.height > a.height || (b.height === a.height && b.time > a.time) ? b : a));
  const recent = [...answers, ...catchingBlocks].filter((a) => readAt - a.time <= BLOCKS_STOPPED_AFTER_MS);
  if (recent.length) { const r = pick(recent); return { ...base, height: r.height, blockAt: r.time, state: 'making', why: null }; }
  if (!answers.length) {
    const why = silent === statuses.length
      ? 'No Namada node answered at the last reading.'
      : `${catching + unusable === 1 ? 'The Namada node that answered' : 'The Namada nodes that answered'} ${[catching ? `${catching + unusable === 1 ? 'was' : 'were'} still catching up` : '', unusable ? 'gave an answer this site cannot use' : ''].filter(Boolean).join(' or ')}, ${CANNOT}`;
    return { ...base, height: null, blockAt: null, state: 'unknown', why };
  }
  const newest = pick(answers);
  const { height, time: blockAt } = newest;
  // an old block while the indexer, or a node still catching up, is at a newer one: the chain may be moving
  const catchingTop = catchingBlocks.length ? pick(catchingBlocks).height : 0;
  if ((indexerHeight != null && indexerHeight > height) || catchingTop > height) {
    const who = answers.length === 1 ? 'Namada node that gave its newest block was' : 'Namada nodes that gave their newest block were';
    const past = indexerHeight != null && indexerHeight > height ? 'the network indexer' : 'a node still catching up';
    return { ...base, height, blockAt, state: 'unknown', why: `The ${who} behind ${past}, ${CANNOT}` };
  }
  // one source's old block alone cannot tell a still network from a node that stopped: a second node at the same
  // block, or the indexer at it, is needed to say no block is being made
  const witnesses = answers.filter((a) => a.height === height).length + (indexerHeight === height ? 1 : 0);
  if (witnesses < 2) {
    const why = answers.length === 1
      ? `Only one Namada node gave its newest block, and nothing else confirmed it, ${CANNOT}`
      : `The Namada nodes that gave their newest block gave different ones, and the newest was not confirmed by another node or the indexer, ${CANNOT}`;
    return { ...base, height, blockAt, state: 'unknown', why };
  }
  return { ...base, height, blockAt, state: 'stopped', why: null };
}

/** The judgement in one sentence, as of the reading; null when the nodes have not been asked. */
export function blocksSentence(b: BlockProduction): string | null {
  if (b.readAt == null) return null;
  if (b.state === 'unknown' || b.height == null || b.blockAt == null) return b.why;
  return b.state === 'making'
    ? `At the last reading Namada was making blocks: the newest, block ${fmtCount(b.height)}, was made at ${fmtUtcLong(b.blockAt)}.`
    : `At the last reading Namada had made no block since block ${fmtCount(b.height)}, made at ${fmtUtcLong(b.blockAt)}: ${fmtAge(b.readAt - b.blockAt)} earlier.`;
}

const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** Who said so: what each node asked gave, and whether the indexer's newest block is the same one. */
export function blocksWho(b: BlockProduction): string | null {
  if (b.readAt == null || !b.asked) return null;
  const n = fmtCount;
  const parts = [
    b.answered ? `${n(b.answered)} gave ${b.answered === 1 ? 'its' : 'their'} newest block` : '',
    b.catching ? `${n(b.catching)} ${b.catching === 1 ? 'was' : 'were'} still catching up` : '',
    b.unusable ? `${n(b.unusable)} could not be used` : '',
    b.silent ? `${n(b.silent)} did not answer` : '',
  ].filter(Boolean);
  const idx = b.indexerHeight == null || b.height == null ? '' : b.indexerHeight === b.height ? '; the network indexer\'s newest block is the same' : `; the network indexer's newest block is ${n(b.indexerHeight)}`;
  return `Of ${n(b.asked)} Namada ${b.asked === 1 ? 'node' : 'nodes'} asked, ${list(parts)}${idx}.`;
}
