// One line to the operator the first time, while the alerts are paused, that a tick sees Namada making blocks.
//
// The pause (ALERTS_PAUSED) holds every post: alerts, the digests, the operator's incidents. This is the one line that
// goes around it, as the pause's own notice does (halt-notice.ts): it is posted directly to the operator's two places
// (the operator's Discord webhook, as text with no mention, and the owner's Telegram chat), and to nowhere else. No
// subscriber, no public channel and no X post is made by it, and nothing else is un-gated: the incidents stay held.
//
// When: two witnesses say Namada made a block after the one the nodes stood at (witnessesOf). The height the nodes
// stood at (`before`) is recorded once, on a tick in which no node had a block from the last HEAD_MAX_AGE_MS and at
// least two nodes agreed on a height (the highest height two of them gave within HEAD_AGREE_BLOCKS of each other), so
// no single node, whatever height it gives, can set it. A witness is then a node on this chain, not catching up, whose
// newest block is from the last minutes, or whose height is past `before`; two of them count when their heights are
// within HEAD_AGREE_BLOCKS of each other. The network indexer gives a height and no time, so it is a witness only when
// its height is past `before`, beside one node. One node's word is never enough. A run of blocks that ended before any
// tick saw two witnesses at once still leaves two nodes past `before`, so it is told too, with its block's own time.
//
// Once: before each try the record is written (kv blocksSeenKv, one for each pause, keyed by the pause's own value) and
// only the run whose write lands posts. A place that answered with a proof that it did not take the line (429, 502,
// 503 or a refusal of the request) leaves the try refused; any other answer, or none, may have posted, so the try's
// outcome is unknown. A further try is made only after a try that every place refused, at most BLOCKS_SEEN_TRIES in
// all, BLOCKS_SEEN_RETRY_MS apart; after a try whose outcome is unknown none is, so the line is never posted twice.
// What it says is measured: the block, its time, and who gave it. It says nothing about why.
import type { Env } from './util';
import { HALT } from '../../shared/halt';
import { NAMADA } from './config';
import { HEAD_AGREE_BLOCKS, HEAD_MAX_AGE_MS, MAX_HEAD_HEIGHT } from './sources/namada';
import { SENDER, WEBHOOK_TIMEOUT_MS, alertsPausedIn, textSafe } from './sources/discord';
import { tgSend } from './sources/telegram';

/** The record's key for a pause: one line for each pause, whatever its value is. */
export const blocksSeenKv = (pause: string): string => `ops.blocks_seen.${pause.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)}`;
/** The most tries of the line, each after one that every place refused. */
export const BLOCKS_SEEN_TRIES = 5;
/** A refused try is made again no sooner than this. */
export const BLOCKS_SEEN_RETRY_MS = 15 * 60_000;

export interface BlocksSeen {
  /** the highest block a node on this chain gave while no node had a recent block: what the indexer must pass */
  before?: number | null;
  /** the block the line names, and its own time */
  height?: number; blockAt?: number | null;
  /** tries made; when the last one was made; when a try was last refused by every place; when a place took it */
  tries?: number; pendingAt?: number | null; refusedAt?: number | null; toldAt?: number | null;
}

/** What the tick saw: the block it names, its time, the nodes that gave it, and whether the indexer is past `before`. */
export interface HeadSeen { height: number; blockAt: number | null; nodes: number; indexer: boolean }

/** One node's status as the tick read it (sources/namada.ts namadaStatusAll). */
export interface StatusLike { error?: string; height?: number; time?: number; catchingUp?: boolean; network?: string }

const isHeight = (h: unknown): h is number => Number.isInteger(h) && (h as number) > 0 && (h as number) <= MAX_HEAD_HEIGHT;

/** A node's answer as this reads it: its height, its newest block's time, and whether that block is from the last minutes. */
export interface NodeSeen { height: number; time: number; fresh: boolean }

/** The tick's nodes on this chain that are not catching up and gave a height and a block time not ahead of the reading. */
export function nodesOf(statuses: readonly StatusLike[], now: number): NodeSeen[] {
  const out: NodeSeen[] = [];
  for (const s of statuses) {
    if (s.error || s.catchingUp || s.network !== NAMADA.chainId || !isHeight(s.height)) continue;
    const t = Number(s.time);
    if (!Number.isFinite(t) || t >= now + 60_000) continue;
    out.push({ height: s.height, time: t, fresh: t > now - HEAD_MAX_AGE_MS });
  }
  return out;
}

/** The nodes of `list` whose height is within HEAD_AGREE_BLOCKS of another's. */
const agreeing = (list: readonly NodeSeen[]): NodeSeen[] => list.filter((a, i) => list.some((b, j) => j !== i && Math.abs(a.height - b.height) <= HEAD_AGREE_BLOCKS));

/** The height the nodes stand at: the highest two of them agree on, when none has a block from the last minutes; else null. */
export function stoodAt(nodes: readonly NodeSeen[]): number | null {
  if (nodes.some((n) => n.fresh)) return null;
  const a = agreeing(nodes);
  return a.length ? Math.max(...a.map((n) => n.height)) : null;
}

/** Whether two witnesses say a block was made after `before`, and what they say (null: fewer than two). */
export function witnessesOf(nodes: readonly NodeSeen[], indexerHeight: number | null | undefined, before: number | null): HeadSeen | null {
  // a node is a witness when its block is from the last minutes (and past `before`, when that is known), or when its height is past `before`
  const past = nodes.filter((n) => (before == null ? n.fresh : n.height > before));
  if (!past.length) return null;
  const agreed = agreeing(past);
  const indexer = before != null && isHeight(indexerHeight) && indexerHeight > before;
  const named = agreed.length >= 2 ? agreed : indexer ? past : [];
  if (!named.length) return null;
  const lowest = named.reduce((a, b) => (a.height <= b.height ? a : b));
  return { height: lowest.height, blockAt: lowest.time, nodes: agreed.length >= 2 ? agreed.length : 1, indexer };
}

const utc = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
/** The line, in measured words: what the nodes report and which of the site's own switches are on. */
export function blocksSeenLine(seen: HeadSeen, haltBarOn: boolean = HALT.on): string {
  const who = `${seen.nodes} ${seen.nodes === 1 ? 'node' : 'nodes'}${seen.indexer ? ' and the network indexer' : ''}`;
  const when = seen.blockAt != null ? `, made ${utc(seen.blockAt)}` : '';
  const still = haltBarOn ? 'The halt bar and the alert pause on this site are still on.' : 'The alert pause on this site is still on.';
  return `${seen.nodes >= 2 ? 'Namada nodes report' : 'A Namada node reports'} new blocks: block ${seen.height.toLocaleString('en-US')}${when}, read on ${who}. ${still}`;
}

type BlocksEnv = Pick<Env, 'DB' | 'SEND_ALERTS' | 'ALERTS_PAUSED' | 'DISCORD_WEBHOOK_URL' | 'TELEGRAM_BOT_TOKEN' | 'TELEGRAM_OWNER_CHAT'>;
type Outcome = 'took' | 'refused' | 'unknown';
/** An answer that proves the post was not taken: too many requests, the service unavailable, or a refused request. */
const refused = (status: number) => status === 429 || status === 502 || status === 503 || (status >= 400 && status < 500);
const htmlText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The line to the operator's two places, directly, once each: what each place did with it. */
async function tell(env: BlocksEnv, line: string): Promise<Outcome[]> {
  const out: Promise<Outcome>[] = [];
  if (env.DISCORD_WEBHOOK_URL) {
    out.push(fetch(env.DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...SENDER, content: textSafe(line), allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    }).then((r): Outcome => (r.ok ? 'took' : refused(r.status) ? 'refused' : 'unknown'), (): Outcome => 'unknown'));
  }
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_OWNER_CHAT) {
    out.push(tgSend(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_OWNER_CHAT.trim(), { html: htmlText(line) })
      .then((a): Outcome => (a.ok ? 'took' : a.status > 0 && refused(a.status) ? 'refused' : 'unknown'), (): Outcome => 'unknown'));
  }
  return Promise.all(out);
}

const parse = (raw: string): BlocksSeen | null => {
  try { const v = JSON.parse(raw); return v && typeof v === 'object' ? (v as BlocksSeen) : null; } catch { return null; }
};

/** What this isolate knows of the record: the height the nodes stand at as noted (`<key>:<height>`), or `<key>:told`. */
let beforeNoted: string | null = null;
/** Forgets what this isolate knows (the tests' fresh isolate). */
export function resetBlocksSeenMemory() { beforeNoted = null; }

export type BlocksSeenDid = 'not paused' | 'no new block' | 'one witness' | 'no place' | 'told before' | 'outcome unknown' | 'tries used' | 'waiting' | 'another run' | 'told' | 'not taken';

/**
 * Called by every tick with its nodes' status answers and the indexer's newest block. Does nothing unless this
 * Worker's alerts are paused (a Worker that sends, paused). Returns what it did, for the tick's log.
 */
export async function noteBlocksSeen(env: BlocksEnv, statuses: readonly StatusLike[], indexerHeight: number | null | undefined, now: number): Promise<BlocksSeenDid> {
  if (!alertsPausedIn(env) || !env.ALERTS_PAUSED) return 'not paused';
  const key = blocksSeenKv(env.ALERTS_PAUSED);
  const nodes = nodesOf(statuses, now);
  const stood = stoodAt(nodes);
  // the line told already, or the nodes standing at the height already noted here: this isolate asks nothing
  if (beforeNoted === `${key}:told`) return 'told before';
  if (stood != null && beforeNoted === `${key}:${stood}`) return 'no new block';
  if (!nodes.length) return 'no new block';
  const row = await env.DB.prepare('SELECT value FROM kv WHERE key = ?').bind(key).first<{ value: string }>();
  const rec = row ? parse(row.value) : null;
  // a record that cannot be read is taken as told: the line is never sent on a guess
  if (row && !rec) return 'told before';
  if (rec?.toldAt != null) { beforeNoted = `${key}:told`; return 'told before'; }
  const before = isHeight(rec?.before) ? rec!.before! : null;
  if (before == null && stood != null) {
    // the first height the nodes are seen standing at: recorded once, and never changed after
    const next = JSON.stringify({ ...(rec ?? {}), before: stood } satisfies BlocksSeen);
    await (row
      ? env.DB.prepare('UPDATE kv SET value = ?, updated_at = ? WHERE key = ? AND value = ?').bind(next, now, key, row.value)
      : env.DB.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING').bind(key, next, now)).run();
    beforeNoted = `${key}:${stood}`;
    return 'no new block';
  }
  const seen = witnessesOf(nodes, indexerHeight, before);
  if (!seen) {
    if (stood != null && stood === before) beforeNoted = `${key}:${stood}`;
    return nodes.some((n) => n.fresh) ? 'one witness' : 'no new block';
  }
  if (!env.DISCORD_WEBHOOK_URL && !(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_OWNER_CHAT)) return 'no place';
  const tries = Number(rec?.tries) || 0;
  if (tries > 0) {
    if (rec!.refusedAt == null || rec!.pendingAt == null || rec!.refusedAt < rec!.pendingAt) return 'outcome unknown';
    if (tries >= BLOCKS_SEEN_TRIES) return 'tries used';
    if (now - rec!.pendingAt < BLOCKS_SEEN_RETRY_MS) return 'waiting';
  }
  const pending: BlocksSeen = { ...(rec ?? {}), before, height: seen.height, blockAt: seen.blockAt, tries: tries + 1, pendingAt: now, refusedAt: rec?.refusedAt ?? null, toldAt: null };
  const text = JSON.stringify(pending);
  const w = await (row
    ? env.DB.prepare('UPDATE kv SET value = ?, updated_at = ? WHERE key = ? AND value = ?').bind(text, now, key, row.value)
    : env.DB.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING').bind(key, text, now)).run();
  if (!w.meta?.changes) return 'another run';
  const outcomes = await tell(env, blocksSeenLine(seen));
  const done: BlocksSeen | null = outcomes.includes('took') ? { ...pending, toldAt: now } : outcomes.every((o) => o === 'refused') ? { ...pending, refusedAt: now } : null;
  // a try whose outcome is unknown stays as written: no further try is made
  if (done) {
    await env.DB.prepare('UPDATE kv SET value = ?, updated_at = ? WHERE key = ?').bind(JSON.stringify(done), now, key).run()
      .catch((e: unknown) => console.error('blocks seen: the outcome of the try was not written', e));
  }
  return outcomes.includes('took') ? 'told' : done ? 'not taken' : 'outcome unknown';
}
