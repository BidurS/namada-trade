import { priorUnshields, sendsToStamp, stampShieldedExits } from './exit-bridge';
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './util';
import type { LiveMessage, Flow } from '../../shared/types';
import { OSMOSIS, NAMADA, keplrHeaders } from './config';
import { normFromWs, normFromTxSearch, osmoAssets, parseOsmosisTx, poolLegsOf, type OsmoCtx, type OsmoParsed, type PoolLeg } from './parse/osmosis';
import { OSMOSIS_QUERIES, osmosisPoolQueries } from './sources/osmosis';
import { parseNamadaBlock } from './parse/namada';
import { blockHasUnbond, parseNamadaUnbonds } from './parse/namada-unbond';
import { blockHasBond, parseNamadaBonds } from './parse/namada-bond';
import type { PosParse } from './parse/namada-pos';
import { feePayersOf } from './parse/namada-tx';
import { blockMetas, blockResults, blockTxs, chainHead, headBound, headSince, namadaStatusAll, HEAD_AGREE_BLOCKS, HEAD_BOUND_BLOCK_MS, HEAD_VOTE_MAX_AGE_MS, RpcBreaker, LIVE_READ, type HeadVote, type ReadOpts, type Rpc } from './sources/namada';
import type { NamadaBlock } from './parse/namada';
import { runBatch, stmt, kvGet, kvGetJson, kvSet } from './db';
import { admitAmong } from './ws-admit';
import { clientOfRequest, type Client } from './client-key';
import { fetchNamPools } from './sources/sqs';
import { readStoredPools } from './pool-sizes';
import { HubQuote, askQuoteService, storedQuoteReader } from './live-quote';
import { priceRouteAt, stampPriceRoute } from './price-how';
import { sendTelegramMove, telegramRun, TG_LIVE_MS, TG_LIVE_SENDS } from './sources/telegram';
import { alarmBudget, configureAlerts, fanoutBudget, flushAlerts, isNamWhale, noteNotSent, offeredForAlerts, sendDiscordWhaleAlert, sendsAlerts, spentOut, FANOUT_DEADLINE_MS, UsersUnreadError, WEBHOOK_TIMEOUT_MS, type AlertBudget, type PendingAlert } from './sources/discord';
import { fetchJson, HttpError, redact, registerSecrets, FETCH_TEXT_MAX_BYTES, ReadBudgetError, ResponseTooLargeError, type ReadBudget } from './util';
import { watchCronStall, OPS_STALL_LOOK_MS } from './ops';

/** Moves found late (by the catch-up search, or by a Namada scan that was behind) alert only when they happened within this window. */
export const LATE_ALERT_MAX_AGE_MS = 24 * 3600_000;
/**
 * The alerts' pending list: the subscribers' part of each move's alert that a dispatch could not send (its post count,
 * its deadline, an alert's window or the invalid-answer budget cut it; discord.ts PendingAlert), one entry per move
 * under a key of this prefix, its time and a sequence number, in this object's own storage (not D1: the list is the
 * hub's alone, and the storage holds at most 128 KiB a value, so each part is a value of its own). The next alarm
 * sends them first, in order, marked found late, under its own budget, and keeps what does not fit. An alert an
 * honest subscriber is entitled to is sent now, or waits and is sent so (owner decision 14); it is never dropped for a
 * budget, a deadline or a count, and a part is let go only when every channel left was posted or recorded as not sent
 * (a hook held for the window as kept rate-limited, discord.ts RATE_LIMITED_HOLD_AFTER, or a channel past its share
 * of the list, PENDING_CHANNEL_MAX), no row holds its links, or its move is older than LATE_ALERT_MAX_AGE_MS.
 */
export const PENDING_PREFIX = 'alerts.pending:';
/**
 * The most subscriber posts the list holds across its parts (a part counts at least one): past it a part is recorded
 * with the posts not sent (kv alerts.skipped) instead of kept, and each channel holds at most its share of it
 * (PENDING_CHANNEL_MAX). The list is read in pages of PENDING_PAGE parts, and an alarm reads only as far as its count
 * lets it post, so the bound is what the storage holds, not what an alarm reads:
 * a part holds a move (about 1 KB) and at most DELIVERABLE_MAX channel digests (about 17 KB), so the list stays under
 * about 850 MB at the very most, far less in practice (a busy address's watchers after an outage make parts of one
 * move each, a few hundred bytes). The count is kept here and read from the list once per instance (countPending).
 */
export const PENDING_POSTS_MAX = 50_000;
/**
 * Each channel's share of the pending list: the most posts its parts hold for one channel (a link's digest, discord.ts
 * PendingAlert `only`). Past it, that channel's post of a part is recorded with the posts not sent and the rest of the
 * part is kept, so the other channels' posts are untouched: hooks whose posts keep waiting without ever being held (a
 * 429 of shared scope is neither counted toward the hold nor an invalid answer, and such a part is let go only at
 * LATE_ALERT_MAX_AGE_MS) fill the list only twenty-five channels at their share together. It is twice the backlog
 * one honest watcher of a busy address can have after an outage (a catch-up search of about a thousand of its moves,
 * test/pending-list-bound.test.ts), so an honest channel reaches it only with that many of its own alerts waiting at
 * once, which only an outage of hours of the delivery itself leaves. A part that names no channel (its settings could
 * not be read, or it was kept by code before 2026-10-23) is bounded by PENDING_POSTS_MAX alone.
 */
export const PENDING_CHANNEL_MAX = PENDING_POSTS_MAX / 25;
/** Parts read per page of the pending list (DO storage lists in key order, so a page follows the last key read). */
export const PENDING_PAGE = 100;
/** kv `alerts.pending`: the pending list's size as the hub last wrote it (notePending), read by the cron's health row. */
export interface AlertsPending { parts: number; posts: number; at: number }
/**
 * How long after a Namada block's own time the live scan may read it and still be keeping up. A block read later was
 * read by a scan that was behind (an outage of the Worker or of the nodes, or blocks read again), not by the scan's
 * normal lag: the alarm runs every 6 s and the chain makes a block about every 7 s, so a scan keeping up reads each
 * block seconds after it, and a node whose newest block is older than this (sources/namada.ts HEAD_MAX_AGE_MS, the
 * same 5 minutes) is not followed at all. It is also about SCAN_MAX_LAG blocks, the furthest behind the scan alerted
 * when it still jumped. Such a block's moves are marked found late (meta.via 'late scan'), stored so, and alerted
 * with the time they happened (owner decision 14, sources/discord.ts buildFlowDiscordBody), as the catch-up
 * search's are.
 */
export const LATE_SCAN_MS = 5 * 60_000;

/** The Osmosis subscriptions (sources/osmosis.ts): the stream listens to these and the catch-up search repeats them. */
export { OSMOSIS_QUERIES };
/**
 * The most NAM pools whose addresses the catch-up search also reads (osmosisPoolQueries, two queries each), in the
 * order the hub learned them (the router's list, largest first). Anyone can create a pool holding NAM; past this many,
 * a pool's transactions in its other coin alone are left to scripts/backfill-osmosis.ts, and its NAM is still read by
 * OSMOSIS_QUERIES. The router listed 26 on 2026-10-29.
 */
export const OSMOSIS_POOL_QUERY_MAX = 40;
/**
 * Pool-address queries probed in one read by a catch-up search (one transaction each, newest first), as a JSON-RPC
 * batch with a /status before and after them (live-hub.ts probePools): the public node answers ten calls in one
 * (eleven are refused, "batch request exceeds maximum (10)", measured 2026-10-29), so the 52 queries of 26 pools cost
 * seven subrequests of the alarm, not 52. A batch not answered whole is asked query by query, as before.
 */
export const POOL_PROBE_BATCH = 8;
/**
 * Pages of 50 the pool-address queries read in all, per catch-up search, beside OSMOSIS_SWEEP_PAGES each for the
 * stream's queries: with every pool busy (after an outage) they could otherwise take 4 pages each, 208 for 26 pools,
 * each a subrequest of the alarm's (discord.ts LIVE_ALERT_POSTS). A query left unread for it keeps its place and the
 * pool queries keep their floor (OsmosisCursor `poolsFrom`), while the cursor moves with the stream's queries; the
 * next search starts its pool queries with that one (`poolsNext`).
 */
export const OSMOSIS_POOL_SWEEP_PAGES = 12;
/** How often the hub reads the router's NAM pools again (fetchNamPools), and how often while it knows none. */
export const OSMOSIS_POOLS_EVERY_MS = 60 * 60_000;
export const OSMOSIS_POOLS_RETRY_MS = 5 * 60_000;
/** Transactions whose pool legs failed to write (writeOsmoTx) kept for the next catch-up search, and how many it writes again. */
const LEGS_RETRY_MAX = 500;
const LEGS_RETRY_EACH = 20;
/** How often the stream state is written to kv (osmosis.live) and the catch-up search runs. */
export const OSMOSIS_LIVE_EVERY_MS = 60_000;
export const OSMOSIS_SWEEP_EVERY_MS = 5 * 60_000;
/**
 * A move the catch-up search found is one the open socket should have delivered when the socket opened at least this
 * long before the move's block and the block is this old now: the stream gives a transaction within seconds of its
 * block, so a move younger than that may still be on its way, and one just after a reconnect may have come in the gap.
 */
export const OSMOSIS_DEAF_GRACE_MS = 2 * 60_000;
/**
 * How long after the Osmosis node cuts the socket the hub opens a new one. On 2026-10-31 the endpoint cut every open
 * socket at the same instant every one to two minutes (00:47:48.4 and 00:48:55.4 UTC for two test sockets opened 25 s
 * apart, and the hub's own, code 1006 with no close frame), whatever the socket sent: a request every 15 s made no
 * difference. The hub cannot stop the cuts, only shorten the gap each leaves, which the catch-up search fills: at a
 * cut a minute or two, the 5 s it waited before was several percent of the day, the size of the stream-share check
 * (6 to 8%). A socket that fails to open is still retried after 5 s (ensureOsmosisWs), so a node that is down is not
 * asked once a second.
 */
export const OSMOSIS_RECONNECT_MS = 1_000;
/** The move's time when the open socket (open since `since`) should have delivered it and did not; null otherwise. */
export const osmoDeafAt = (since: number | null, open: boolean, ts: number, now: number): number | null =>
  open && since != null && ts - since >= OSMOSIS_DEAF_GRACE_MS && now - ts >= OSMOSIS_DEAF_GRACE_MS ? ts : null;
/**
 * Pages of 50 per query and sweep, newest first (the search cannot take a height range on the public node). A query
 * with more than these above the cursor is read on by the next search from where this one stopped (OsmosisResume).
 */
export const OSMOSIS_SWEEP_PAGES = 4;
/**
 * The most bytes of transaction pages one catch-up search holds at once (util.ts fetchJson's `budget`): every page
 * it keeps a transaction of stays in memory until the search writes them. A page of 50 was 0.8 to 1.7 MB on
 * 2026-10-22 and the four queries' four pages about 13 MB in all; a 16 MiB answer takes about 65 MB of heap to read,
 * so pages held and the page being read stay well inside the 128 MB isolate. A page none of whose transactions is
 * kept (all looked at before, stored, or seen by the stream) gives its bytes back.
 */
export const OSMOSIS_SWEEP_MAX_BYTES = 24 * 1024 * 1024;

/**
 * kv `osmosis.cursor`: every Osmosis transaction matching the queries up to `height` has been looked at. `skipped`:
 * the transactions a search could not read (each one alone past the cap on every node), newest last. `resume`: for a
 * search that did not finish, how far it read each query above `height`, so the next one goes on from there.
 * `depth`: the fewest blocks a node answering a search's /status held behind its head (its latest height less its
 * earliest_block_height), and when a node that shallow was last seen (nodeDepth). `shallow`: the short answers the
 * last search did not take as the end of their query, because the range began below the blocks that depth reaches;
 * dropped by the next search that finishes.
 * `pools`: the NAM pools whose addresses the search read (osmosisPoolQueries); 0 while the hub knows none (the router
 * not read yet), when a transaction that moves only a pool's other coin is not searched for.
 * `blockAt`: the time of the block the cursor reached, from the /status of the search that moved it to that head (its
 * latest_block_time); a cursor that stopped below the head keeps the one it had. Every Osmosis transaction of the
 * queries up to it has been looked at: the public posts read an hour once it is past the hour's end
 * (public-posts.ts hourCovered).
 * `poolsFrom`: while a search leaves a pool-address query not read down to the cursor (their pages spent, a read that
 * failed, an empty answer from an index that may not hold the range), the block those queries are read down to, below
 * `height`, the `at` of the cursor that had it, and why; their places are in `resume`. The cursor never waits on them.
 * `poolsNext`: the pool-address query the next search's pool queries start with, the first the last one left unread
 * for want of pages.
 */
export interface OsmosisCursor {
  height: number; at: number; added?: number; error?: string; skipped?: { at: number; note: string }[]; resume?: Record<string, OsmosisResume>;
  depth?: OsmosisDepth; shallow?: { at: number; note: string }; pools?: number;
  blockAt?: number; poolsFrom?: { height: number; at: number; note: string }; poolsNext?: string;
}
/**
 * The shallowest node the searches have seen (OsmosisCursor `depth`): how many blocks it held behind its head, and
 * when a node that shallow was last seen. `deeper`: once it has not been seen for OSMOSIS_DEPTH_KEEP_MS, the /status
 * answers since then, all deeper (how many, and the fewest blocks among them), counted to OSMOSIS_DEPTH_RETIRE.
 */
export interface OsmosisDepth { blocks: number; at: number; deeper?: { blocks: number; n: number } }
/**
 * How long the shallowest depth seen stands on its own without a node that shallow seen again (OsmosisDepth).
 * osmosis-rpc.publicnode.com answers each request from one of two backends: one held blocks from 73,431,644 (about 16
 * hours), the other from 68,229,727 (2026-08-10), and its tx_search counted 123 and 3,913 swaps of pool 3005 from one
 * request to the next (2026-10-29). A /status from the deep one says nothing of the one that answers the next read,
 * so the search goes by the shallowest seen, which about half the searches' /status show. Past this time the kept
 * depth still stands: only OSMOSIS_DEPTH_RETIRE deeper answers in a row retire it, never the first one after an
 * outage, which is when the searches have the oldest range to read.
 */
export const OSMOSIS_DEPTH_KEEP_MS = 86_400_000;
/**
 * The /status answers in a row, each deeper than the kept depth and all after OSMOSIS_DEPTH_KEEP_MS, that retire it
 * for the fewest blocks among them (the shallow backend gone, or grown past twice what was kept): with two backends
 * taking turns at random, twelve answers in a row from the deep one while the shallow one still answers is one chance
 * in 4,096. One a search, so twelve searches, an hour at OSMOSIS_SWEEP_EVERY_MS.
 */
export const OSMOSIS_DEPTH_RETIRE = 12;
/**
 * A /status depth of fewer blocks is not taken as a node's (nor is a kept one, from code before this rule): about an
 * hour of Osmosis blocks (a block about every 0.86 s on 2026-10-29: heights 73,444,230 at 06:31 UTC and 73,489,118 at
 * the 17:16 epoch block), against 350 between two searches. A backend that has just synced from a snapshot answers
 * with a few hundred blocks; kept, it would hold every search's range below it and stop the cursor for as long as it
 * stood, while such a node may only miss the minutes it has not yet synced.
 */
export const OSMOSIS_DEPTH_FLOOR = 4_000;
/**
 * The cursor's `depth` after a /status at `now` whose head is `head` and whose earliest_block_height is `earliest`:
 * the fewer blocks of the kept and the new; a depth up to twice the kept one is the same backend seen again (it
 * prunes in steps, or keeps growing from one earliest block) and keeps it current; a deeper one leaves it as it was,
 * and once the kept one has not been seen for OSMOSIS_DEPTH_KEEP_MS, OSMOSIS_DEPTH_RETIRE of those in a row give way to
 * the shallowest of them. An answer without an earliest height (or one above its head), or under OSMOSIS_DEPTH_FLOOR,
 * says nothing, and the kept depth stays as it was.
 */
export function nodeDepth(kept: OsmosisDepth | undefined, head: number, earliest: unknown, now: number): OsmosisDepth | undefined {
  const e = typeof earliest === 'string' && /^\d+$/.test(earliest) ? Number(earliest) : typeof earliest === 'number' ? earliest : NaN;
  const seen = Number.isSafeInteger(e) && e > 0 && e <= head ? head - e : null;
  const k = kept && Number.isSafeInteger(kept.blocks) && kept.blocks >= OSMOSIS_DEPTH_FLOOR && Number.isFinite(kept.at) ? kept : undefined;
  if (seen == null || seen < OSMOSIS_DEPTH_FLOOR) return k;
  if (!k || seen <= k.blocks) return { blocks: seen, at: now };
  if (seen <= 2 * k.blocks) return { blocks: k.blocks, at: now };
  if (now - k.at <= OSMOSIS_DEPTH_KEEP_MS) return k;
  const d = k.deeper && Number.isSafeInteger(k.deeper.blocks) && Number.isSafeInteger(k.deeper.n) && k.deeper.n > 0
    ? { blocks: Math.min(k.deeper.blocks, seen), n: k.deeper.n + 1 } : { blocks: seen, n: 1 };
  return d.n >= OSMOSIS_DEPTH_RETIRE ? { blocks: d.blocks, at: now } : { blocks: k.blocks, at: k.at, deeper: d };
}
/**
 * Where a catch-up search that did not finish left one query. The search can only page from the newest transaction,
 * so a query with more than OSMOSIS_SWEEP_PAGES pages above the cursor (they came faster than the searches, or the
 * searches failed for a while) was read again from the newest by every search and stopped at the same depth, and the
 * cursor never moved again. Every transaction of the query at most `top` high, from the newest down to transaction
 * `last` (at height `low`, the `n`th of them), has been looked at; with no `last`, every one down to the cursor (`low`).
 * The next search reads down to `top`, counts what came since, and goes on from the page `last` is on.
 */
export interface OsmosisResume { top: number; low: number; n: number; last?: string }

/**
 * kv `namada.unbonds.live` and `namada.bonds.live`: outcome of the live unbond and bond decoders (the requests decoded,
 * the last block whose requests were read, and the last failures), surfaced by the cron health probe.
 */
export interface LiveUnbondStatus {
  decoded: number;
  lastHeight?: number;
  lastAt?: number;
  failures: { height: number; at: number; note: string }[];
  /**
   * The first block the live scan read with this decoder in place, written once when the row is made (scanNamada,
   * notePosStarts): the scan reads every block from there in order, so every applied request from this block on is
   * the decoder's to find, and the history backfill's unbond-gap step ends its range here. A row made before this
   * was recorded (the unbond decoder's, deployed before 2026-10-23) has none, and is never given one later: a later
   * block would not be where the decoder started.
   */
  firstHeight?: number;
}
export type LiveBondStatus = LiveUnbondStatus;

/** A PoS request the live scan decodes from tx bytes: its kind, its decoder and the kv row of its outcome. */
interface LivePosRequest { kind: 'unbond' | 'bond'; kv: string; parse: (blk: NamadaBlock, txs: string[], priceUsd: number | null) => PosParse }
const UNBOND_LIVE: LivePosRequest = { kind: 'unbond', kv: 'namada.unbonds.live', parse: parseNamadaUnbonds };
const BOND_LIVE: LivePosRequest = { kind: 'bond', kv: 'namada.bonds.live', parse: parseNamadaBonds };

/**
 * kv `namada.scan`: blocks the live scan could not read as blocks (a shape it does not understand), a cursor it found
 * above the head, and heads it could not follow, surfaced by the cron health probe.
 */
export interface LiveScanStatus {
  failures: { height: number; at: number; note: string }[];
}
/**
 * The most blocks one tick reads on one node's word (no two nodes agree on the head) and in a re-read of blocks read so
 * while the nodes disagreed; and how far below the head the scan restarts from a cursor found above it. On a head two
 * nodes agree on, a scan behind reads on from its cursor as far as the alarm's deadline lets it, and never jumps.
 */
export const SCAN_MAX_LAG = 50;
/** How often the same kind of head note (no node at the head, nodes that disagree) is recorded in kv `namada.scan`. */
export const HEAD_NOTE_EVERY_MS = 10 * 60_000;
/**
 * One deadline for an alarm's reads. The next Namada scan starts only when the alarm ends, and a scan behind the head
 * reads on from its cursor until this deadline: no read of the scan or the catch-up search starts or goes on past
 * this, and what they did not reach is left for the next alarm (the scan's cursor) or the next search (the Osmosis
 * cursor is kept). A scan or a search after a long outage goes on over several alarms.
 */
export const ALARM_DEADLINE_MS = 150_000;
/**
 * The part of an alarm a catch-up search that is due keeps for itself: the Namada scan's reads end this much before
 * ALARM_DEADLINE_MS, so Namada nodes slow enough to keep the scan busy to the deadline cannot keep the search from
 * ever starting (one chain's slowness is never the other's).
 */
export const SWEEP_RESERVE_MS = 60_000;
/**
 * How long the live scan waits for each node's /status (no retry): a status is about 1 KB, answered in 0.2 s on
 * 2026-10-22, and the scan waits for every node's, so a node that accepts the request and never answers costs each
 * tick this long, not a block read's timeout.
 */
export const LIVE_STATUS_MS = 3000;
/** The indexer's vote (checks 'indexer_lag') counts only when the indexer was this close to the nodes' head when stored. */
const VOTE_MAX_LAG_BLOCKS = HEAD_AGREE_BLOCKS;
/**
 * How far behind the chain the indexer may be when its latest block bounds one node's word (the cron's indexer_lag
 * check warns up to 500 blocks): an honest node alone stays within it while the indexer lags that much.
 */
const VOTE_BOUND_LAG_BLOCKS = 500;
/** How many catch-up transactions that make no row are remembered (rowlessOsmoTx). */
const OSMO_ROWLESS_MAX = 2000;
/**
 * An alarm marked running for this long is taken as ended: every read it makes ends on its own timer, and the scan's
 * and the search's at ALARM_DEADLINE_MS, so a run still marked after this is one whose invocation ended without its
 * own `finally` (the platform stopped it and kept the instance). The next alarm takes over and records it in the
 * scan's health record (kv `namada.scan`), rather than every later alarm only re-arming.
 */
export const ALARM_LEASE_MS = 10 * 60_000;

/**
 * metrics `site.live_sockets`: the most sockets the hub held open at once in an hour (the live feed's readers, counted
 * as one number: nothing of a socket is kept), labelled with the hour's start and written once, at the first alarm
 * after the hour ends. `site.live_sockets.minutes`, beside it: how many minutes of the hour the count covered (60, or
 * fewer when it began after the hour did: the first hour after a deploy that brought the count, or a count the
 * object's storage could not give back). An hour with no row was not counted (no instance ran in it); it is never 0.
 * No route serves them (api.ts HISTORY_KEYS says why): the owner reads them in D1.
 */
export const LIVE_SOCKETS_KEY = 'site.live_sockets';
export const LIVE_SOCKETS_MINUTES_KEY = `${LIVE_SOCKETS_KEY}.minutes`;
/** The hour's count so far, kept in the object's storage at most this often, so a restart (a deploy) goes on counting the hour. */
export const SOCKET_MARK_SAVE_MS = 60_000;
/** Hours ended whose row could not be written yet (D1 refused), kept for the next alarms: the newest this many. */
export const SOCKET_MARKS_KEPT = 48;
/** The object's storage key of the count (SocketMarks). */
export const SOCKET_MARK_STORE = 'sockets.mark';
/** One hour's count of open sockets: the hour's start, the most open at once, and from when in the hour it was counted. */
export interface SocketMark { hour: number; max: number; from: number }
interface SocketMarks { now: SocketMark | null; done: SocketMark[] }
const HOUR_MS = 3_600_000;
const isMark = (m: unknown): m is SocketMark => {
  const x = m as SocketMark | null;
  return !!x && Number.isInteger(x.hour) && x.hour % HOUR_MS === 0 && Number.isInteger(x.max) && x.max >= 0 && Number.isFinite(x.from) && x.from >= x.hour && x.from < x.hour + HOUR_MS;
};
/**
 * The rows of an hour ended: the most sockets open at once and the minutes counted, each kept at the higher of the
 * stored and the new value, so an hour written again (a restart before the storage took the write) never lowers it.
 */
export function liveSocketStmts(m: SocketMark) {
  const sql = 'INSERT INTO metrics (ts,key,value) VALUES (?,?,?) ON CONFLICT(key, ts) DO UPDATE SET value = MAX(value, excluded.value)';
  const minutes = Math.max(0, Math.min(60, Math.round((m.hour + HOUR_MS - m.from) / 60_000)));
  return [{ sql, params: [m.hour, LIVE_SOCKETS_KEY, m.max] }, { sql, params: [m.hour, LIVE_SOCKETS_MINUTES_KEY, minutes] }];
}

export class LiveHub extends DurableObject<Env> {
  private sessions = new Set<WebSocket>();
  /** The client each socket came from (client-key.ts: an IPv4 address, an IPv6 /64 and /48; ws-admit.ts caps each). */
  private clients = new WeakMap<WebSocket, Client>();
  private osmoWs: WebSocket | null = null;
  private isConnectingOsmo = false;
  /** The alarm run in progress, and when it started: only that run's `finally` clears it (ALARM_LEASE_MS). */
  private alarmRun: { since: number } | null = null;
  private seenOsmoTx = new Set<string>();
  /**
   * Catch-up transactions that make no row (another coin on a NAM channel, a swap of other pools): the next search
   * lets them go without parsing them again. The newest OSMO_ROWLESS_MAX are kept (made on first use).
   */
  private rowlessOsmoTx?: Set<string>;
  /**
   * Pool legs whose write failed (writeOsmoTx), by transaction: the next catch-up search writes them again, at most
   * LEGS_RETRY_EACH, and the newest LEGS_RETRY_MAX are kept (made on first use). In memory only: what a restart or the
   * bound loses, scripts/backfill-osmosis.ts finds (it checks every pool transaction's legs, NAM swaps' among them).
   */
  private legsUnwritten?: Map<string, PoolLeg[]>;
  /** When the router's NAM pools were last read (refreshContext, refreshPools). */
  private poolsAt?: number;
  /**
   * Osmosis transactions whose write threw, by hash, until the catch-up search has them written whole and alerted.
   * Each one's rows go to D1 in one batch (writeOsmoTx), so a write that threw left none of them or all of them (a
   * batch can commit and then lose its answer): the search reads such a hash again even when its rows are stored,
   * writes it only when they are not, and alerts it (the alert claims keep a move from being posted twice).
   */
  private osmoRetryTx = new Map<string, number>(); // hash -> block height
  /**
   * The lowest height of a stream transaction whose rows could not be written since the last catch-up search that
   * covered it, and a count of such failures: the next search reads from below that height, and a complete search
   * clears it (and osmoRetryTx) only when no write failed after the search began.
   */
  private osmoRetryFrom: number | null = null;
  private osmoRetryGen = 0;
  /**
   * Stream transactions whose rows are being written, by hash: their height and when the write began. A catch-up
   * search that finishes meanwhile keeps its cursor below them (sweepOsmosis).
   */
  private osmoWriting = new Map<string, { height: number; since: number }>();
  private osmoHeight = 0;
  private namadaHeight = 0;
  /** The last head note recorded (noteHead): its kind and when. */
  private headNote: { kind: string; at: number } | null = null;
  /**
   * The last head two answers agreed on (chainHead `agreed`), and when: one node's word may take the scan only as far
   * as the chain can have gone since (sources/namada.ts headBound). `read`: the highest block the scan read while the
   * head was agreed on; the blocks above it were read on one node's word, and are read again once two answers agree.
   * Kept in kv `namada.head` (at most once a minute) so a restart keeps it; undefined until that row is read.
   */
  private lastAgreed: { height: number; at: number; read?: number } | null | undefined = undefined;
  /**
   * The lower node followed when two nodes last disagreed, and when (kept until two answers agree again): one of them
   * is wrong and nothing told which, so a node alone afterwards is followed no higher than this one has had time to
   * reach (HEAD_BOUND_BLOCK_MS a block). Honest nodes at the head never disagree, so it never holds one back.
   */
  private lowSeen: { height: number; at: number } | null = null;
  /**
   * Since the last agreed head: the nodes the scan read from (none agreeing), and whether two nodes disagreed. Blocks
   * read then are read again on the next agreed head only when a disagreement was seen (an outage of one node with the
   * other going on alone is not one), and only from nodes not read from then (the same node would answer the same).
   */
  private loneFrom?: Set<string>;
  private disputedSince = false;
  /** A re-read of blocks read on one node's word: it goes on to `to`, from these nodes, before the scan may jump again. */
  private reread: { to: number; rpcs: Rpc[] } | null = null;
  /** Whether this instance has made sure both live decoders' kv rows exist (notePosStarts). */
  private posStartsNoted = false;
  /** How many parts the alerts' pending list holds (PENDING_PREFIX) and how many posts across them, as last counted (countPending); null until counted. */
  private pendingN: number | null = null;
  private pendingPosts: number | null = null;
  /** How many posts the pending list holds for each channel its parts name (PENDING_CHANNEL_MAX), counted with them. */
  private pendingBy: Map<string, number> | null = null;
  /** The counts last written to kv `alerts.pending` (notePending), so a tick writes only a change. */
  private pendingNoted: string | null = null;
  private pendingSeq = 0;
  private lastAgreedSaved = 0;
  private osmoSince: number | null = null;
  private osmoLastMsgAt: number | null = null;
  /** Why the hub closed an open Osmosis socket since it started: a node's error message, or the catch-up search finding a move the open socket never delivered (reported in kv osmosis.live). */
  private osmoDrops = { error: 0, deaf: 0, lastAt: null as number | null, closes: 0, lastClose: null as { code: number; reason: string; openMs: number; at: number } | null };
  /** When this hub instance started: a later time in kv osmosis.live than the one before is a restart (its socket and its counts begin again). */
  private readonly bornAt = Date.now();
  private lastLiveReport = 0;
  private lastSweep = 0;
  /** When the alarm last looked at the cron's last completed tick (ops.ts watchCronStall). */
  private lastStallLook = 0;
  private needSweep = true;
  /** The NAM quote new moves are priced at, as osmoCtx.priceUsd: null when none is fresh (worker/src/live-quote.ts). */
  private lastPriceUsd: number | null = null;
  private quote: HubQuote;
  /**
   * The pool addresses and the first quote (refreshContext), read once the constructor has returned. An Osmosis move
   * parsed before the pool addresses are known would book a deposit to a pool as a plain transfer, so the stream's
   * messages wait for it and the catch-up search starts only once it is read (or failed, as before); the sockets
   * and the Namada scan never wait for it. `contextRead`: it has settled.
   */
  private context?: Promise<void>;
  private contextRead = false;
  /** The hour of open sockets being counted (metrics site.live_sockets), and the hours ended and not yet written. */
  private socketMark: SocketMark | null = null;
  private socketMarksDone: SocketMark[] = [];
  /** What the object's storage last took of the count (SOCKET_MARK_STORE), and when. */
  private socketMarkSaved: string | null = null;
  private socketMarkSavedAt = 0;
  private osmoCtx: OsmoCtx = {
    poolAddrs: new Map(),
    priceUsd: null,
    assets: osmoAssets(),
  };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    configureAlerts(env.SETTINGS_KEY, sendsAlerts(env));
    registerSecrets(env.KEPLR_KEY);
    // the cron's own read (the price list, else the route's spot), with the source name and note that say which
    this.quote = new HubQuote(askQuoteService, storedQuoteReader(env.DB));
    // Only the object's own storage inside: while it runs no socket is accepted and no alarm runs, and the pool
    // addresses and the first quote come from the Osmosis router, which can answer slowly for a minute and more
    // (own audit 2026-10-29, Low 14). They are read after it (context), and only Osmosis moves wait for them.
    this.ctx.blockConcurrencyWhile(async () => {
      // Schedule first alarm for Namada polling
      const currentAlarm = await this.ctx.storage.getAlarm();
      if (!currentAlarm) {
        await this.ctx.storage.setAlarm(Date.now() + 2000);
      }
      await this.loadSocketMark();
    });
    this.context = this.refreshContext()
      .catch((e) => console.error('refreshContext error:', e))
      .finally(() => { this.contextRead = true; });
    // Connect to Osmosis WS (its messages wait for the context: handleOsmosisMessage)
    this.ensureOsmosisWs();
  }

  /**
   * The pool accounts the live parser books liquidity against: the cron's stored pool list (pool-sizes.ts readStoredPools;
   * each address was checked as a pool account's when the cron read it), so a hub that starts, on a visitor's socket or
   * its own alarm, asks no outside service. The router's own list only while none is stored (the first minute after the
   * cron began storing it, or a stored row that cannot be read).
   */
  async refreshContext() {
    await this.refreshPools();
    await this.refreshQuote();
  }

  /**
   * The router's NAM pools added to osmoCtx.poolAddrs (a pool it no longer lists stays: its address is still a
   * pool's). Read at start and again every OSMOSIS_POOLS_EVERY_MS from the alarm, every OSMOSIS_POOLS_RETRY_MS while
   * none is known, so a pool made after the hub started, or a router that failed at its start, is searched by address
   * within the hour (the catch-up's cursor says how many are, `pools`).
   */
  async refreshPools() {
    this.poolsAt = Date.now();
    try {
      const stored = this.env?.DB ? await readStoredPools(this.env.DB) : null;
      const { pools } = stored?.pools.length ? stored : await fetchNamPools();
      for (const p of pools) {
        if (p.address) this.osmoCtx.poolAddrs.set(p.address, p.id);
      }
    } catch (e) {
      console.error('refreshContext error:', e);
    }
  }

  /**
   * The quote for moves now (HubQuote.refresh), kept in osmoCtx.priceUsd and lastPriceUsd. A change is broadcast only
   * when it is the hub's own answer from the quote service: the page shows a streamed price as live, and the cron's
   * stored minute reaches it through its own polls, labelled as stored.
   */
  /**
   * The NAM size of the route whose spot a quote the hub priced moves at was (price-how.ts stampPriceRoute): the hub's
   * own ask says it; for a stored quote the cron's log of how it read the price does (undefined when it cannot be
   * read, and nothing is marked).
   */
  private async routeOf(q: { at: number; stored: boolean; routeNam?: number | null } | null): Promise<number | null | undefined> {
    if (!q) return null;
    if (!q.stored && q.routeNam !== undefined) return q.routeNam;
    return priceRouteAt(this.env.DB, q.at);
  }

  private async refreshQuote() {
    const q = await this.quote.refresh(Date.now()).catch(() => null);
    const usd = q?.usd ?? null;
    this.osmoCtx.priceUsd = usd;
    if (usd !== this.lastPriceUsd) {
      this.lastPriceUsd = usd;
      if (q?.source === 'live') this.broadcast({ type: 'price', usd: q.usd, at: q.at, ...(q.priceSource ? { source: q.priceSource } : {}), ...(q.priceNote ? { note: q.priceNote } : {}) });
    }
  }

  private ensureOsmosisWs() {
    if (this.osmoWs || this.isConnectingOsmo || !this.env.KEPLR_KEY) return;
    this.isConnectingOsmo = true;
    // The key goes in a header (keplrHeaders), never in the URL, and only a fetch upgrade can send a WebSocket one.
    // A handshake that neither opens nor fails within this long is abandoned (and retried), so a half-open one can
    // never leave `isConnectingOsmo` set for good.
    const ctrl = new AbortController();
    const pending = setTimeout(() => ctrl.abort('timeout'), 20_000);
    const retry = (why: unknown) => {
      clearTimeout(pending);
      console.error(`Osmosis WS not opened: ${redact(String(why))}`);
      this.isConnectingOsmo = false;
      setTimeout(() => this.ensureOsmosisWs(), 5000);
    };
    let res: Promise<Response>;
    try {
      res = fetch(OSMOSIS.keplrWs, { headers: { Upgrade: 'websocket', ...keplrHeaders(this.env.KEPLR_KEY) }, signal: ctrl.signal });
    } catch (e) {
      retry(e);
      return;
    }
    res.then((r) => {
      const ws = r.webSocket;
      if (!ws) { r.body?.cancel().catch(() => {}); retry(`HTTP ${r.status}, not a WebSocket`); return; }
      clearTimeout(pending);
      ws.accept();
      this.openedOsmosisWs(ws);
    }, retry);
  }

  /** The Osmosis socket, accepted: its listeners (a close reconnects in 5 s), then its subscriptions. */
  private openedOsmosisWs(ws: WebSocket) {
    this.osmoWs = ws;
    this.isConnectingOsmo = false;
    console.log('Connected to Osmosis WebSocket');

    ws.addEventListener('message', async (event) => {
      // the time it came, which a wait for the pool addresses does not move (handleOsmosisMessage)
      const at = Date.now();
      try {
        const msg = JSON.parse(event.data as string);
        // A node that ends a subscription says so in a message with an error (CometBFT: "subscription was cancelled
        // (reason: client is not pulling messages fast enough)") and keeps the socket open, which then delivers
        // nothing for that query while the hub reads it as connected. Any error is taken as a lost subscription: the
        // socket is closed, so the close handler reconnects in 5 s and the next alarm's catch-up search reads the gap.
        if (msg && typeof msg === 'object' && 'error' in msg && msg.error) {
          const words = redact(JSON.stringify(msg.error)).slice(0, 200);
          // Only a cancelled subscription closes the socket: an error a node keeps giving to one subscribe (a lower
          // subscription limit, a query it refuses) would close it every 5 s for good, while the other queries work.
          if (/subscription was cancel/i.test(words)) {
            console.error(`Osmosis WS subscription cancelled, reconnecting: ${words}`);
            this.osmoDrops.error++;
            this.osmoDrops.lastAt = Date.now();
            this.dropOsmosisWs(ws);
          } else console.error(`Osmosis WS error message: ${words}`);
          return;
        }
        await this.handleOsmosisMessage(msg, at);
      } catch (e) {
        console.error('Error handling Osmosis WS message:', e);
      }
    });

    const openedAt = Date.now();
    ws.addEventListener('close', (ev: CloseEvent) => {
      // a socket the hub already let go (dropOsmosisWs) closing late: the new one is not touched
      if (this.osmoWs !== ws) return;
      // Why it closed, kept with the drops (kv osmosis.live): on 2026-10-30 the hub opened a new socket about once a
      // minute with nothing saying why, which is where the stream's missed moves come from (8% of a day's moves).
      const code = Number(ev?.code ?? 0), reason = String(ev?.reason ?? '').slice(0, 80), openMs = Date.now() - openedAt;
      console.log(`Osmosis WS closed: code ${code}${reason ? ` (${reason})` : ''}, open ${Math.round(openMs / 1000)} s`);
      this.osmoDrops.closes++;
      this.osmoDrops.lastClose = { code, reason, openMs, at: Date.now() };
      this.osmoWs = null;
      this.isConnectingOsmo = false;
      this.osmoSince = null;
      this.needSweep = true;
      // the node cut it: a new socket after OSMOSIS_RECONNECT_MS
      setTimeout(() => this.ensureOsmosisWs(), OSMOSIS_RECONNECT_MS);
    });

    ws.addEventListener('error', (err) => {
      console.error('Osmosis WS error:', err);
      ws.close();
    });

    this.osmoSince = Date.now();
    // A reconnect may have missed transactions: the next alarm runs the catch-up search.
    this.needSweep = true;
    // Subscriptions
    const queries = OSMOSIS_QUERIES.map((q) => `tm.event='Tx' AND ${q}`);

    queries.forEach((q, i) => {
      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'subscribe',
          id: i + 1,
          params: { query: q },
        }),
      );
    });

    this.broadcastStatus();
  }

  /**
   * Lets go of an Osmosis socket the hub found deaf or cancelled: it is no longer the hub's socket from this moment
   * (so a runtime that fires `close` only once the node answers, or never, cannot hold the reconnect), the next alarm's
   * catch-up search reads the gap, and a new socket opens after OSMOSIS_RECONNECT_MS.
   */
  private dropOsmosisWs(ws: WebSocket) {
    if (this.osmoWs !== ws) return;
    this.osmoWs = null;
    this.osmoSince = null;
    this.needSweep = true;
    try { ws.close(); } catch {}
    setTimeout(() => this.ensureOsmosisWs(), OSMOSIS_RECONNECT_MS);
  }

  /** One stream message, `at` the time it came: a move's time is when the stream gave it (normFromWs). */
  private async handleOsmosisMessage(msg: any, at = Date.now()) {
    // Read with the pool addresses: a message that comes before they are read waits for them (in order, as it came),
    // and keeps the time it came, not the time the wait ended (the router can take a minute and more).
    if (this.context && !this.contextRead) await this.context;
    const norm = normFromWs(msg, at);
    if (!norm) return;
    this.osmoLastMsgAt = at;

    // Deduplicate multiple WS subscription matches for the same Osmosis tx hash. The hash is held while the
    // transaction is written (the other subscriptions' copies of it return here) and stays seen only once its rows
    // are written: the catch-up search skips a seen hash. A copy arriving after its write threw leaves it to the
    // search (osmoRetryTx), which knows whether that write stored its rows: writing them again would count its
    // address links twice.
    if (norm.hash) {
      if (this.seenOsmoTx.has(norm.hash) || this.osmoRetryTx.has(norm.hash)) return;
      this.seenOsmoTx.add(norm.hash);
      if (this.seenOsmoTx.size > 1000) {
        const oldest = this.seenOsmoTx.values().next().value;
        if (oldest) this.seenOsmoTx.delete(oldest);
      }
    }

    if (norm.height > this.osmoHeight) this.osmoHeight = norm.height;

    // priced at the quote for now, its age checked here (a slow alarm tick can hold the last refresh for minutes)
    const q = this.quote.current(Date.now());
    const parsed = parseOsmosisTx(norm, { ...this.osmoCtx, priceUsd: q?.usd ?? null });
    const legs = poolLegsOf(norm, this.osmoCtx.poolAddrs);
    if (!parsed.flows.length && !parsed.moves.length) {
      // a pool's other coin alone: no NAM row, nothing to show or alert
      if (legs.length) await this.writeOsmoTx(parsed, legs);
      return;
    }
    stampPriceRoute(parsed.flows, await this.routeOf(q && { at: q.at, stored: q.source === 'stored', routeNam: q.routeNam }));

    // Persist to D1, in one batch. A write that fails (a transient D1 error) is neither broadcast nor alerted, and it
    // stored none of the transaction's rows or, when the batch committed and its answer was lost, all of them: the
    // hash is forgotten as seen and kept for a retry, so the catch-up search reads the transaction again, from below
    // its height even when its cursor has passed it (a search that ran meanwhile skipped the hash as seen), writes
    // it if nothing of it is stored, and alerts it as found late. A parse that throws is not retried: it would throw
    // the same way again.
    if (norm.hash) this.osmoWriting.set(norm.hash, { height: norm.height, since: Date.now() });
    try {
      await this.writeOsmoTx(parsed, legs);
    } catch (e) {
      this.noteOsmoWriteFailed(norm.hash, norm.height);
      throw e;
    } finally {
      if (norm.hash) this.osmoWriting.delete(norm.hash);
    }

    // Broadcast to UI
    this.broadcast({ type: 'flows', flows: parsed.flows });

    await this.alertFlows(parsed.flows);
  }

  /**
   * One Osmosis transaction's rows in one D1 batch, which D1 runs as one transaction: a write that fails stores
   * none of them (in runBatch's 80-statement batches the first ones of a large transaction, a relayer's many receives
   * or a multi-send, would stay stored on their own, and the rest be lost). The links go first: each is counted only
   * while its flow is not stored yet (db.ts stmt.linkOnce), so a transaction written twice counts its links once.
   * The pool's legs in its other coins (`legs`, parse/osmosis.ts poolLegsOf, migration 0018) follow in a batch of
   * their own, and a failure there is logged, never thrown: the NAM rows never wait on them, and a write that threw
   * would hold the catch-up's cursor below the transaction (a database without the table refuses every one). Legs not
   * written are kept for the next catch-up search (legsUnwritten), which finds the transaction stored and reads it
   * no further.
   */
  private async writeOsmoTx(parsed: OsmoParsed, legs: PoolLeg[] = []) {
    const stmts = [...parsed.links.map(stmt.linkOnce), ...parsed.flows.map(stmt.flow), ...parsed.moves.map(stmt.move)];
    if (stmts.length) await runBatch(this.env.DB, stmts, stmts.length);
    if (legs.length) {
      await runBatch(this.env.DB, legs.map(stmt.poolLeg), legs.length).catch((e) => {
        console.error(`Osmosis pool legs of ${legs[0].txHash} not written:`, e);
        const kept = (this.legsUnwritten ??= new Map());
        kept.delete(legs[0].txHash);
        kept.set(legs[0].txHash, legs);
        for (const hash of kept.keys()) { if (kept.size <= LEGS_RETRY_MAX) break; kept.delete(hash); }
      });
    }
  }

  /**
   * Each pool-address query's newest transaction's height (`h`, -Infinity for a query with none), POOL_PROBE_BATCH
   * queries a read (`post`), and the first block of the index that answered it (`first`): each read is a batch of a
   * /status, the queries and a /status, as scripts/osmosis-pager.ts reads (the public node answered every batch measured
   * from one index, 2026-10-29), and the first block is known only when both /status answers name the same one. The
   * queries of a batch not answered whole are asked one by one (`get`), with no first block known. A query no read
   * answered is left out: it is read like the others.
   */
  private async probePools(qs: string[], get: (path: string) => Promise<any>, post: (body: string) => Promise<unknown[] | null>, signal?: AbortSignal): Promise<Map<string, { h: number; first: number | null }>> {
    const out = new Map<string, { h: number; first: number | null }>();
    const take = (q: string, r: any, first: number | null) => {
      const txs = r?.txs;
      if (!Array.isArray(txs)) return;
      const h = txs.length ? Number(txs[0]?.height) : -Infinity;
      if (!Number.isNaN(h)) out.set(q, { h, first });
    };
    const status = (id: number) => ({ jsonrpc: '2.0', id, method: 'status', params: {} });
    const firstOf = (a: any) => { const e = Number(a?.result?.sync_info?.earliest_block_height); return Number.isSafeInteger(e) && e > 0 ? e : null; };
    for (let i = 0; i < qs.length; i += POOL_PROBE_BATCH) {
      if (signal?.aborted) break;
      const part = qs.slice(i, i + POOL_PROBE_BATCH);
      const last = part.length + 1;
      const calls = [status(0), ...part.map((query, k) => ({ jsonrpc: '2.0', id: k + 1, method: 'tx_search', params: { query, page: '1', per_page: '1', order_by: 'desc' } })), status(last)];
      const answer = await post(JSON.stringify(calls)).catch(() => null);
      const by = new Map<number, { result?: unknown }>();
      for (const x of answer ?? []) {
        const a = x as { id?: unknown; error?: unknown; result?: unknown };
        if (typeof a?.id === 'number' && !a.error) by.set(a.id, a);
      }
      const e0 = firstOf(by.get(0)), e1 = firstOf(by.get(last));
      const first = e0 != null && e0 === e1 ? e0 : null;
      part.forEach((q, k) => { if (by.has(k + 1)) take(q, by.get(k + 1)!.result, first); });
      await Promise.all(part.filter((q) => !out.has(q)).map(async (q) => take(q, (await get(`/tx_search?query=${encodeURIComponent(`"${q}"`)}&page=1&per_page=1&order_by=%22desc%22`).catch(() => null))?.result, null)));
    }
    return out;
  }

  /** The pool legs earlier writes failed to store, written again (INSERT OR IGNORE), oldest first; the first failure leaves the rest for the next search. */
  private async retryLegs() {
    const kept = this.legsUnwritten;
    if (!kept?.size) return;
    for (const [hash, legs] of [...kept].slice(0, LEGS_RETRY_EACH)) {
      try {
        await runBatch(this.env.DB, legs.map(stmt.poolLeg), legs.length);
        kept.delete(hash);
      } catch (e) {
        console.error(`Osmosis pool legs of ${hash} not written again:`, e);
        return;
      }
    }
  }

  /** A write of Osmosis transaction `hash` at `height` threw: the next catch-up search reads it again (osmoRetryTx). */
  private noteOsmoWriteFailed(hash: string, height: number) {
    if (hash) {
      this.seenOsmoTx.delete(hash);
      this.osmoRetryTx.set(hash, Number.isFinite(height) && height > 0 ? height : 0);
      if (this.osmoRetryTx.size > 1000) {
        const oldest = this.osmoRetryTx.keys().next().value;
        if (oldest) this.osmoRetryTx.delete(oldest);
      }
    }
    if (Number.isFinite(height) && height > 0) this.osmoRetryFrom = Math.min(this.osmoRetryFrom ?? height, height);
    this.osmoRetryGen += 1;
  }

  /**
   * Discord alerts for whale movements (>= 10k NAM) and user watchlist/MASP webhooks. The same path serves the
   * live stream, the catch-up search and the Namada scan; sendDiscordWhaleAlert claims a key per move (its flow id)
   * once it has somewhere to post it, so a move is never posted twice and never holds back another move of the same
   * transaction, and a bridge crossing's two records (one per chain) reach each channel once. `minNam`: the NAM size
   * from which a move is offered to the per-user rules at all (100 on Osmosis, 10 on Namada); shielded moves and
   * moves in another coin (no NAM size, watchlist only) always are (discord.ts offeredForAlerts). The whale size is
   * NAM too: another coin's units never make a NAM whale.
   *
   * `budget` is the dispatch's (discord.ts AlertBudget): an alarm's (alarmBudget), shared by its pending alerts, its
   * Namada scan and its Osmosis catch-up search, bounds their posts together by one count and the alarm's own
   * deadline, each alert with a fan-out window of its own, so a slow or hostile set of webhooks cannot push the alarm
   * past its deadline and starve the other chain's catch-up search or the next block scan, and the time the search
   * spends reading blocks between its alerts never cuts a subscriber. A caller that gives none (the live stream, a
   * direct call) gets one for these moves (fanoutBudget: one window across them and a post count), whose records are
   * written when they are sent. Subscribers' posts the budget cuts are kept for the next alarm (defer), never dropped.
   */
  private async alertFlows(flows: Flow[], threshold = Number(this.env.WHALE_OSMOSIS_NAM || 10000), minNam = 100, budget?: AlertBudget) {
    const own = budget ?? fanoutBudget(true);
    try {
      await this.alertEach(flows, threshold, minNam, own);
    } finally {
      if (!budget) {
        await flushAlerts(this.env.DB, own);
        await this.notePending().catch((e) => console.error('alerts: the pending list\'s size was not written:', e));
      }
    }
  }

  private async alertEach(flows: Flow[], threshold: number, minNam: number, budget: AlertBudget) {
    const offered: Flow[] = [];
    for (const f of flows) {
      if (isNamWhale(f, threshold)) f.whale = true;
      if (offeredForAlerts(f, minNam)) {
        // valued by the row's own price only (the card never multiplies by a current quote): a move found late with no
        // quote for its minute is never valued at today's
        const left = await sendDiscordWhaleAlert(this.env.DISCORD_WEBHOOK_URL, f, this.env.DB, threshold, budget);
        if (left) await this.defer(left, budget);
        offered.push(f);
      }
    }
    // The same moves to Telegram's subscribers, after Discord's, claimed apart and under their own share of the
    // invocation's messages and time (sources/telegram.ts TgRun), never past the dispatch's deadline; it never throws.
    // The site's public voices (X, the public Telegram channel) take no move from here: the cron posts each closed
    // hour's largest (public-posts.ts).
    if (offered.length) {
      const run = telegramRun(TG_LIVE_SENDS, TG_LIVE_MS, budget.deadline);
      for (const f of offered) await sendTelegramMove(this.env, f, run);
      if (run.skipped) console.warn(`telegram: ${run.skipped} messages not sent (the invocation's share was spent)`);
    }
  }

  /** The posts a part counts for the list's bound: at least one, so a part whose subscribers are not yet known (a failed read) is bounded too. */
  private static partPosts = (p: PendingAlert) => Math.max(1, p.n);

  /**
   * Counts the pending list once per instance, in pages (PENDING_PAGE), so the count is this object's and never
   * trusted from an earlier write: how many parts, how many posts across them (partPosts), and how many for each
   * channel they name (pendingBy). A restart or a deploy counts again from the storage.
   */
  private async countPending(): Promise<void> {
    if (this.pendingN != null && this.pendingPosts != null) { this.pendingBy ??= new Map(); return; }
    let n = 0, posts = 0, after: string | undefined;
    const by = new Map<string, number>();
    for (;;) {
      const page = await this.ctx.storage.list<PendingAlert>({ prefix: PENDING_PREFIX, limit: PENDING_PAGE, ...(after ? { startAfter: after } : {}) });
      if (!page.size) break;
      for (const [key, p] of page) {
        n++;
        posts += LiveHub.partPosts(p);
        for (const k of p.only ?? []) by.set(k, (by.get(k) ?? 0) + 1);
        after = key;
      }
      if (page.size < PENDING_PAGE) break;
    }
    this.pendingN = n;
    this.pendingPosts = posts;
    this.pendingBy = by;
  }

  /** Adds (`sign` 1) or takes out (-1) one post for each channel part `p` names, in the per-channel count. */
  private countChannels(p: PendingAlert, sign: 1 | -1) {
    const by = (this.pendingBy ??= new Map());
    for (const k of p.only ?? []) {
      const n = (by.get(k) ?? 0) + sign;
      if (n > 0) by.set(k, n);
      else by.delete(k);
    }
  }

  /**
   * Keeps the subscribers' part of an alert that did not fit this dispatch for the next alarm (PENDING_PREFIX), at
   * once, so an invocation the platform ends keeps it too. A channel the list already holds PENDING_CHANNEL_MAX posts
   * for has its post of the part recorded with the posts not sent, and the rest of the part is kept. Past
   * PENDING_POSTS_MAX posts across the parts, or when the storage cannot be written, the part is recorded with the
   * posts not sent instead: never dropped unseen.
   */
  private async defer(p: PendingAlert, budget: AlertBudget) {
    try {
      await this.countPending();
      if (p.only?.length) {
        const by = this.pendingBy!;
        const full = new Set(p.only.filter((k) => (by.get(k) ?? 0) >= PENDING_CHANNEL_MAX));
        if (full.size) {
          console.warn(`alerts: ${full.size} subscriber post(s) for move ${p.flow.id} not kept: the channel holds its share of the pending list`);
          await noteNotSent(this.env.DB, budget, full.size, `move ${p.flow.id} (${full.size} post(s), each to a channel past its share of the pending list, ${PENDING_CHANNEL_MAX} posts)`).catch(() => {});
          p = { ...p, only: p.only.filter((k) => !full.has(k)), n: Math.max(0, p.n - full.size) };
          if (!p.only!.length) return;
        }
      }
      const posts = LiveHub.partPosts(p);
      if (this.pendingPosts! + posts > PENDING_POSTS_MAX) throw new Error(`the pending list holds ${this.pendingPosts} posts (${PENDING_POSTS_MAX} at most)`);
      const key = `${PENDING_PREFIX}${String(p.at).padStart(14, '0')}:${String(this.pendingSeq++ % 10_000).padStart(4, '0')}`;
      await this.ctx.storage.put(key, p);
      this.pendingN!++;
      this.pendingPosts! += posts;
      this.countChannels(p, 1);
    } catch (e) {
      console.error(`alerts: ${p.n} subscriber post(s) for move ${p.flow.id} could not be kept for the next alarm:`, e);
      await noteNotSent(this.env.DB, budget, p.n, `move ${p.flow.id} (not kept for a later run: ${String(e).slice(0, 80)})`).catch(() => {});
    }
  }

  /**
   * Sends the alerts' pending list first, in order, under this alarm's `budget`: each part to the subscribers that
   * still match its move, marked found late (discord.ts sendDiscordWhaleAlert `resume`); what does not fit, waits for
   * its quiet hours to end, or could not be read is kept again, in its place, and the parts after it wait too once
   * the budget is spent or the settings could not be read (UsersUnreadError: every part would fail the same way). The
   * list is read in pages (PENDING_PAGE), as far as the budget lets the alarm post, so the whole list is never read at
   * once, and a part is written back only when it changed. A part whose move happened more than LATE_ALERT_MAX_AGE_MS
   * ago is let go and recorded, as a move found that late is never alerted; nothing else lets a part go but every
   * channel posted or recorded as not sent (a hook held as kept rate-limited), or no row holding its links any more.
   */
  private async sendPending(budget: AlertBudget) {
    try {
      await this.countPending();
    } catch (e) {
      console.error('alerts: the pending list could not be read; it is read again next alarm:', e);
      return;
    }
    let after: string | undefined;
    for (let more = true; more && !spentOut(budget);) {
      let page: Map<string, PendingAlert>;
      try {
        page = await this.ctx.storage.list<PendingAlert>({ prefix: PENDING_PREFIX, limit: PENDING_PAGE, ...(after ? { startAfter: after } : {}) });
      } catch (e) {
        console.error('alerts: the pending list could not be read; it is read again next alarm:', e);
        return;
      }
      more = page.size >= PENDING_PAGE;
      for (const [key, p] of page) {
        after = key;
        if (spentOut(budget)) return;
        try {
          if (Date.now() - p.flow.ts > LATE_ALERT_MAX_AGE_MS) {
            await noteNotSent(this.env.DB, budget, p.n, `move ${p.flow.id} (waited past ${LATE_ALERT_MAX_AGE_MS / 3_600_000} h)`);
            await this.dropPending(key, p);
            continue;
          }
          const left = await sendDiscordWhaleAlert(undefined, p.flow, this.env.DB, undefined, budget, p);
          if (left) {
            // Written back only when it changed: a part found paused, or cut whole by the budget, is the same part,
            // and writing it at every alarm would be a storage write per part per alarm for nothing.
            if (!LiveHub.samePart(p, left)) {
              await this.ctx.storage.put(key, left);
              this.countChannels(p, -1);
              this.countChannels(left, 1);
            }
            this.pendingPosts! += LiveHub.partPosts(left) - LiveHub.partPosts(p);
          } else await this.dropPending(key, p);
        } catch (e) {
          if (e instanceof UsersUnreadError) {
            console.error(`alerts: the pending alerts wait for the next alarm: ${e.message}`);
            return;
          }
          console.error(`alerts: the pending alert for move ${p.flow.id} was not sent this alarm:`, e);
        }
      }
    }
  }

  /** Whether two parts of one move are the same part: as many posts, the same claims, and the same channels left. */
  private static samePart(a: PendingAlert, b: PendingAlert): boolean {
    if (a.n !== b.n || a.claims !== b.claims || !!a.only !== !!b.only) return false;
    if (!a.only || !b.only) return true;
    if (a.only.length !== b.only.length) return false;
    const keys = new Set(a.only);
    return b.only.every((k) => keys.has(k));
  }

  /** Lets a part go (every channel posted or recorded, nobody left to post to, or past the age limit) and counts it out. */
  private async dropPending(key: string, p: PendingAlert) {
    await this.ctx.storage.delete(key);
    this.pendingN!--;
    this.pendingPosts! -= LiveHub.partPosts(p);
    this.countChannels(p, -1);
  }

  /**
   * Writes the pending list's size to kv `alerts.pending` (parts, posts, when), once per dispatch when it changed,
   * so the cron's "Discord alert delivery" health row shows a sustained delay. A failed write is tried again by the
   * next dispatch.
   */
  private async notePending() {
    if (this.pendingN == null || this.pendingPosts == null) return;
    const note = `${this.pendingN}:${this.pendingPosts}`;
    if (note === this.pendingNoted) return;
    await kvSet(this.env.DB, 'alerts.pending', { parts: this.pendingN, posts: this.pendingPosts, at: Date.now() } satisfies AlertsPending);
    this.pendingNoted = note;
  }

  /** A block the scan could not read as a block, or a head or a cursor it could not follow: recorded for the health view (kv `namada.scan`). */
  private async noteScanFailure(height: number, note: string) {
    const status = (await kvGetJson<LiveScanStatus>(this.env.DB, 'namada.scan').catch(() => null)) ?? { failures: [] };
    status.failures = [...status.failures, { height, at: Date.now(), note: note.slice(0, 300) }].slice(-20);
    await kvSet(this.env.DB, 'namada.scan', status).catch(() => {});
  }

  /**
   * A head the scan cannot follow, or nodes that disagree on it, recorded as noteScanFailure records a block: the
   * same kind at most every HEAD_NOTE_EVERY_MS, so a node down for an hour leaves a few notes, not one every tick
   * pushing the notes of unreadable blocks out of the list.
   */
  private async noteHead(height: number, kind: string, note: string) {
    const now = Date.now();
    if (this.headNote && this.headNote.kind === kind && now - this.headNote.at < HEAD_NOTE_EVERY_MS) return;
    this.headNote = { kind, at: now };
    await this.noteScanFailure(height, note);
  }

  /** A catch-up transaction that makes no row: the newest OSMO_ROWLESS_MAX are let go unread by later searches. */
  private noteRowless(hash: string) {
    const set = (this.rowlessOsmoTx ??= new Set());
    set.add(hash);
    if (set.size > OSMO_ROWLESS_MAX) {
      const oldest = set.values().next().value;
      if (oldest) set.delete(oldest);
    }
  }

  /**
   * The last agreed head (lastAgreed), read from kv `namada.head` the first time it is wanted after a restart; null
   * when none was ever stored, undefined when that read failed (it is read again on the next tick: a failed read is
   * not a missing row).
   */
  private async agreedHead(): Promise<{ height: number; at: number; read?: number } | null | undefined> {
    if (this.lastAgreed === undefined) {
      let v: { height: number; at: number; read?: number } | null;
      try { v = await kvGetJson<{ height: number; at: number; read?: number }>(this.env.DB, 'namada.head'); } catch { return undefined; }
      this.lastAgreed = v && Number.isInteger(v.height) && v.height > 0 && Number.isFinite(v.at)
        ? { height: v.height, at: v.at, ...(Number.isInteger(v.read) ? { read: v.read } : {}) } : null;
    }
    return this.lastAgreed;
  }

  /** A head two answers agreed on this tick: kept as lastAgreed (with the `read` of earlier ticks), and in kv at most once a minute. */
  private async noteAgreed(height: number, now: number) {
    const prev = await this.agreedHead().catch(() => undefined);
    this.lastAgreed = { height, at: now, ...(prev?.read != null ? { read: prev.read } : {}) };
    if (now - this.lastAgreedSaved < 60_000) return;
    this.lastAgreedSaved = now;
    await kvSet(this.env.DB, 'namada.head', this.lastAgreed).catch(() => {});
  }

  /**
   * The indexer's latest block as the cron last stored it (checks 'indexer_lag', written every minute), for chainHead
   * when the nodes do not agree. `vote` may vouch for a node: null when there is none, or when the indexer was not near
   * the nodes' head then (its own lag past VOTE_MAX_LAG_BLOCKS), so a lagging indexer cannot vouch for a node that is
   * behind too. `raw` is the same block whatever that lag (stored in the last HEAD_VOTE_MAX_AGE_MS): it only bounds
   * how high one node's word may take the scan.
   */
  private async indexerVote(): Promise<{ raw: HeadVote | null; lagOk: boolean }> {
    const none = { raw: null, lagOk: false };
    const row = await this.env.DB.prepare("SELECT detail, checked_at FROM checks WHERE key = 'indexer_lag'").first<{ detail: string; checked_at: number }>().catch(() => null);
    if (!row) return none;
    let d: { indexerHeight?: unknown; lagBlocks?: unknown } | null = null;
    try { d = JSON.parse(row.detail); } catch { return none; }
    const height = Number(d?.indexerHeight), at = Number(row.checked_at);
    const raw = Number.isInteger(height) && height > 0 && at > Date.now() - HEAD_VOTE_MAX_AGE_MS ? { height, at } : null;
    const lag = Number(d?.lagBlocks);
    return { raw, lagOk: Number.isFinite(lag) && Math.abs(lag) <= VOTE_MAX_LAG_BLOCKS };
  }

  async alarm() {
    const started = Date.now();
    if (this.alarmRun && started - this.alarmRun.since < ALARM_LEASE_MS) {
      await this.ctx.storage.setAlarm(started + 6000);
      return;
    }
    const stale = this.alarmRun;
    const run = { since: started };
    this.alarmRun = run;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort('alarm deadline'), ALARM_DEADLINE_MS);
    // A catch-up search due now keeps SWEEP_RESERVE_MS of the alarm: the scan's reads end that much sooner.
    const sweepDue = this.needSweep || started - this.lastSweep >= OSMOSIS_SWEEP_EVERY_MS;
    const scanEnd = new AbortController();
    const scanTimer = setTimeout(() => scanEnd.abort('alarm deadline'), sweepDue ? ALARM_DEADLINE_MS - SWEEP_RESERVE_MS : ALARM_DEADLINE_MS);
    // One alert budget for the whole alarm (discord.ts alarmBudget): the pending alerts', the Namada scan's and the
    // catch-up search's posts share one count, each alert has a fan-out window of its own, and no subscriber post
    // starts once its last answer could come after the alarm's deadline; what the count or the deadline cuts waits
    // for the next alarm (defer). The scan's alerts also leave the search its reserve: when a search is due, their
    // subscriber posts all end within FANOUT_DEADLINE_MS of the end of the scan's reads.
    const alertEnd = started + ALARM_DEADLINE_MS - WEBHOOK_TIMEOUT_MS;
    const alerts = alarmBudget(sweepDue ? Math.min(alertEnd, started + ALARM_DEADLINE_MS - SWEEP_RESERVE_MS + FANOUT_DEADLINE_MS - WEBHOOK_TIMEOUT_MS) : alertEnd, true);

    try {
      if (stale) {
        console.error(`LiveHub alarm: the run started ${new Date(stale.since).toISOString()} never ended; this one takes over`);
        await this.noteScanFailure(this.namadaHeight, `the live scan's alarm of ${new Date(stale.since).toISOString()} never ended; the next one took over after ${ALARM_LEASE_MS / 60_000} min`);
      }
      // 0. The alerts kept from earlier dispatches go first (sendPending), in order.
      await this.sendPending(alerts);
      // 1. The Namada scan. Whatever happens to it (both nodes down, a D1 error), the Osmosis side below still runs:
      //    one chain's outage is never the other's.
      try {
        await this.scanNamada(scanEnd.signal, alerts);
      } catch (err) {
        console.error('Namada scan:', err);
      }
      alerts.deadline = alertEnd;

      // The quote for new moves (at most one ask of the quote service every 30 s; else the cron's stored minute)
      await this.refreshQuote();

      // Ensure Osmosis WS stays active
      this.ensureOsmosisWs();

      // A cron that has stopped completing ticks cannot say so itself: the hub looks at its last completed tick at most
      // once a minute (one kv read) and opens the operator's incident past CRON_STALE_MS (ops.ts watchCronStall).
      if (Date.now() - this.lastStallLook >= OPS_STALL_LOOK_MS) {
        this.lastStallLook = Date.now();
        await watchCronStall(this.env).catch((e) => console.error('ops: the cron\'s ticks', e));
      }

      // The Osmosis index's own state for the coverage stamps, and the catch-up search for what the stream missed.
      const t = Date.now();
      if (t - this.lastLiveReport >= OSMOSIS_LIVE_EVERY_MS) {
        this.lastLiveReport = t;
        await kvSet(this.env.DB, 'osmosis.live', { connected: !!this.osmoWs, since: this.osmoSince, lastMsgAt: this.osmoLastMsgAt, height: this.osmoHeight || null, drops: this.osmoDrops, hubSince: this.bornAt }).catch(() => {});
      }
      // The hour's count of open sockets, and the hours ended written once each.
      await this.noteSockets(t).catch((e) => console.error('live sockets: the hour\'s count was not written:', e));
      // A search that would start after the deadline waits for the next alarm, still due; so does one before the pool
      // addresses are read (the constructor's context), which would book a deposit to a pool as a transfer.
      const contextIn = !this.context || this.contextRead;
      if (!deadline.signal.aborted && contextIn && (this.needSweep || t - this.lastSweep >= OSMOSIS_SWEEP_EVERY_MS)) {
        this.lastSweep = t;
        this.needSweep = false;
        // the pools whose addresses the search reads (one read of the router an hour, every search while none is known)
        if (this.poolsAt != null && t - this.poolsAt >= (this.osmoCtx.poolAddrs.size ? OSMOSIS_POOLS_EVERY_MS : OSMOSIS_POOLS_RETRY_MS)) await this.refreshPools();
        await this.sweepOsmosis(deadline.signal, alerts).catch((e) => console.error('Osmosis catch-up search:', e));
      }
    } catch (err) {
      console.error('LiveHub alarm error:', err);
    } finally {
      clearTimeout(timer);
      clearTimeout(scanTimer);
      // The alarm's shared records (invalid answers, posts not sent, successful posts) are written once, and the
      // pending list's size when it changed.
      await flushAlerts(this.env.DB, alerts).catch((e) => console.error('LiveHub alerts:', e));
      await this.notePending().catch((e) => console.error('alerts: the pending list\'s size was not written:', e));
      // A run taken over after ALARM_LEASE_MS that ends later leaves the newer run's mark alone.
      if (this.alarmRun === run) this.alarmRun = null;
      // Reschedule alarm every 6 seconds
      await this.ctx.storage.setAlarm(Date.now() + 6000);
    }
  }

  /**
   * One pass over the Namada blocks since the cursor. A block whose time, events or PoS requests' tx bytes cannot be
   * fetched this tick, or whose rows cannot be written, is left for the next tick: the cursor never passes it. A block
   * this parser cannot read as a block (a shape it does not know) is recorded as not scanned (kv `namada.scan`), since
   * a retry would only stall the scan. The scan never jumps blocks: behind on a head two nodes agree on (chainHead
   * `byNodes`), it reads on from its cursor until the alarm's deadline, and on any other head at most SCAN_MAX_LAG
   * blocks a tick, never past where the chain can have gone since the last agreed head (headBound). A cursor found
   * above the head is moved back below it, and said so, only on a head two nodes agree on; otherwise it waits.
   * Each block's moves are alerted right after its rows are written, as the catch-up search's are, so a scan that
   * reads on to the alarm's deadline sends its alerts throughout the alarm; the cursor is written before a block's
   * alerts, so a slow webhook holds up the next block's read, never what the scan has done, and the subscriber posts
   * the alarm's budget cuts wait for the next alarm (alertFlows). A move in a block read more than LATE_SCAN_MS after
   * its time (a scan reading on after an outage) is marked found late (meta.via 'late scan') and alerted so; one older
   * than LATE_ALERT_MAX_AGE_MS is stored and not alerted. `signal`: the alarm's deadline (ALARM_DEADLINE_MS); the
   * blocks after it wait for the next alarm, as a block that cannot be fetched does.
   */
  private async scanNamada(signal?: AbortSignal, alerts?: AlertBudget) {
    // Every node's status side by side: the scan follows only nodes whose answer shows they are at this chain's head
    // (sources/namada.ts chainHead: the chain id, not catching up, a recent newest block, agreement), and reads the
    // blocks from those nodes only.
    const statuses = await namadaStatusAll({ timeoutMs: LIVE_STATUS_MS, retries: 0, signal });
    if (statuses.every((s) => 'error' in s)) throw new Error('no Namada node answered /status');
    const cursor = Number(await kvGet(this.env.DB, 'namada.cursor')) || 0;
    const now = Date.now();
    let at = chainHead(statuses, now, cursor);
    // Nodes that do not agree, or a node alone: the indexer's latest block, as the cron stored it, is a third answer,
    // and one node's word is followed only as far as the chain can have gone since the last agreed head.
    if (!at.agreed) {
      const { raw, lagOk } = await this.indexerVote();
      const last = await this.agreedHead();
      // The last agreed head could not be read (a D1 error after a restart): one node's word is not followed this tick.
      if (last === undefined) return;
      // The indexer vouches for a node unless it is seen to lag: behind the last agreed head, or (with none known) far
      // behind the nodes when the cron stored it. Its lag is not measured against the highest node now: one node far
      // ahead would void the vote just when it is needed.
      const vote = raw && (last ? raw.height >= last.height - HEAD_AGREE_BLOCKS : lagOk) ? raw : null;
      // As far as the chain can have gone since the last agreed head, and since the indexer's latest block (read
      // whatever its lag, with VOTE_BOUND_LAG_BLOCKS more for that lag) unless that block is behind the last agreed
      // head: an indexer seen to lag bounds nothing.
      const byAgreed = headBound(last, now);
      const byIndexer = raw && (!last || raw.height >= last.height - HEAD_AGREE_BLOCKS) ? headBound(raw, now)! + VOTE_BOUND_LAG_BLOCKS : null;
      const bound = byAgreed != null && byIndexer != null ? Math.min(byAgreed, byIndexer) : byAgreed ?? byIndexer;
      // A node alone after two nodes disagreed: no higher than the lower one followed then has had time to reach.
      const byLow = this.lowSeen ? this.lowSeen.height + Math.max(0, Math.floor((now - this.lowSeen.at) / HEAD_BOUND_BLOCK_MS)) : null;
      at = chainHead(statuses, now, cursor, vote, bound, headSince(last, now), byLow);
      if (at.disputed) this.disputedSince = true;
      if (at.disputed && at.height != null) this.lowSeen = { height: at.height, at: now };
      if (!at.agreed) for (const r of at.rpcs) (this.loneFrom ??= new Set()).add(r.provider);
    }
    if (at.agreed && at.height != null) await this.noteAgreed(at.height, now);
    if (at.note) await this.noteHead(cursor + 1, at.height == null ? 'none' : 'disagree', at.note);
    if (at.height == null) return;
    const head = at.height;
    // One short attempt per node, the nodes that failed this tick asked last (as the cron does).
    const read: ReadOpts = { ...LIVE_READ, rpcs: at.rpcs, breaker: new RpcBreaker(), signal };
    let lastScanned = cursor || head - 1;
    // A cursor above the head of every node followed was written from blocks this chain does not have (a node that
    // answered for another chain or with a height it had not reached). Left there, it would stop the scan until the
    // chain passed it: the scan restarts SCAN_MAX_LAG blocks below the head and says so. The blocks
    // it reads again are written as before (a link is counted only with a flow not stored yet, db.ts stmt.linkOnce).
    // Only a head two nodes agree on moves the cursor back (one node and the indexer can both be behind by as much: a
    // node stuck behind and an indexer lagging as far), and chainHead follows no single node far below it.
    // Blocks the scan read on one node's word (above lastAgreed.read) while two nodes disagreed are read again once two
    // answers agree on a head below them, from the nodes it did not read them from (the same node would answer the
    // same): never further back than the blocks read while a head was agreed on, so a node and an indexer that are both
    // behind cannot take back what two answers confirmed. One node going on alone while the other was out is not read
    // again: nothing contradicted it.
    const readAgreed = this.lastAgreed?.read;
    if (at.agreed) {
      const fresh = at.rpcs.filter((r) => !this.loneFrom?.has(r.provider));
      const disputed = this.disputedSince;
      this.lowSeen = null;
      this.disputedSince = false;
      this.loneFrom?.clear();
      if (disputed && fresh.length && lastScanned > head && !(at.byNodes && lastScanned > head + HEAD_AGREE_BLOCKS) && readAgreed != null && readAgreed < head && lastScanned > readAgreed) {
        await this.noteScanFailure(readAgreed + 1, `blocks ${readAgreed + 1} to ${lastScanned} were read on one node's word while the nodes disagreed; they are read again from ${fresh.map((r) => r.provider).join(' and ')}`);
        this.reread = { to: lastScanned, rpcs: fresh };
        lastScanned = readAgreed;
        await kvSet(this.env.DB, 'namada.cursor', String(lastScanned));
      }
    }
    if (this.reread && lastScanned >= this.reread.to) this.reread = null;
    if (!this.reread && lastScanned > head + HEAD_AGREE_BLOCKS) {
      if (!at.byNodes) {
        await this.noteHead(head, 'above', `the scan's cursor ${lastScanned} is ${lastScanned - head} blocks above the head ${head}, which only one node and the indexer give: it is moved back only on a head both nodes agree on, and the scan waits`);
        return;
      }
      await this.noteScanFailure(head, `the scan's cursor ${lastScanned} was ${lastScanned - head} blocks above the head ${head}: the scan restarts at block ${head - SCAN_MAX_LAG + 1}, and blocks it missed before then are not scanned`);
      lastScanned = head - SCAN_MAX_LAG;
      await kvSet(this.env.DB, 'namada.cursor', String(lastScanned));
    }
    // The last block this tick reads: on a head two nodes agree on, the head, however far behind the cursor is: every
    // block is read in order, as many as the alarm's deadline allows, and the next tick goes on from where this one
    // stopped (a jump would lose every flow of the blocks jumped). On a head two nodes do not agree on, SCAN_MAX_LAG
    // blocks on from the cursor, so one node's word (with or without the indexer's) never takes the scan far. A re-read
    // goes on SCAN_MAX_LAG a tick from its own nodes.
    let upTo = head;
    if (this.reread) {
      read.rpcs = this.reread.rpcs;
      upTo = Math.min(head, this.reread.to, lastScanned + SCAN_MAX_LAG);
    } else if (!at.byNodes) upTo = Math.min(head, lastScanned + SCAN_MAX_LAG);
    if (upTo <= lastScanned) return;

    // The first block each live decoder reads, recorded once in its kv row before the scan reads it.
    if (!this.posStartsNoted) {
      try { await this.notePosStarts(lastScanned + 1); } catch (e) { console.error('live decoders\' first block not recorded, asked again next tick:', e); }
    }
    // Real block times (max 20 per call), read as the scan reaches them, so a scan far behind asks only for the
    // blocks it gets to. A block whose time cannot be fetched is not processed this tick (the cursor stays below it
    // and the next alarm retries): rows never carry an import-time timestamp.
    const times = new Map<number, number>();
    let metasTo = lastScanned; // the last block a window of metas was asked for
    let done = lastScanned;
    let written = lastScanned; // the cursor as last written this tick
    const whaleNam = Number(this.env.WHALE_NAMADA_NAM || 10000);
    for (let h = lastScanned + 1; h <= upTo; h++) {
      // The block's moves to alert once its rows are written (found late when the scan was behind, and never when
      // older than LATE_ALERT_MAX_AGE_MS: blocks read on after a long outage are stored and shown, never alerted, so
      // the channels are not flooded with old news; owner decision 14, as the catch-up search's moves).
      const toAlert: Flow[] = [];
      if (signal?.aborted) break;
      if (!times.has(h) && h > metasTo) {
        metasTo = Math.min(upTo, h + 19);
        try { for (const m of await blockMetas(h, metasTo, read)) times.set(m.height, m.ts); } catch {}
      }
      if (!times.has(h)) {
        try { for (const m of await blockMetas(h, h, read)) times.set(m.height, m.ts); } catch {}
        if (!times.has(h)) {
          console.error(`Namada block ${h}: block time unavailable from every RPC; retrying next tick`);
          break;
        }
      }
      let blk: NamadaBlock;
      try {
        blk = await blockResults(h, times.get(h)!, read);
      } catch (e) {
        console.error(`Namada block ${h}: block_results unavailable from every RPC; retrying next tick:`, e);
        break;
      }
      // The quote for the block's own minute (the scan may be behind). One that cannot be read holds the block for the
      // next tick, as a block that cannot be fetched does (inside the try below it would be skipped as not scanned).
      let priceUsd: number | null = null;
      let route: number | null | undefined = null;
      if (blk.events && blk.events.length > 0) {
        try {
          const q = await this.quote.quoteFor(blk.ts, Date.now());
          priceUsd = q?.usd ?? null;
          route = await this.routeOf(q);
        } catch (e) {
          console.error(`Namada block ${h}: its minute's stored quote could not be read; retrying next tick:`, e);
          break;
        }
      }
      let retryBlock = false;
      try {
        if (blk.events && blk.events.length > 0) {
          // The block's tx bytes, read once for whichever reading below needs them (a read that fails is asked again).
          let txs: string[] | null = null;
          const txsOf = async () => (txs ??= await blockTxs(h, read));
          let parsed = parseNamadaBlock(blk, priceUsd);
          // The shielded pool's fee is tied to the account that paid gas only when the wrapper names it (no event
          // does): the block's tx bytes are fetched only for a block whose pool fee the events alone had to read.
          // Bytes no node gives leave that reading (parse/namada.ts namFlows says what it cannot tell): a fee is never
          // worth holding up the scan. A read the alarm's own deadline cut says nothing of the nodes: the block, none
          // of it written yet, waits for the next alarm and is read whole then.
          if (parsed.feePayerWanted.length) {
            try {
              parsed = parseNamadaBlock(blk, priceUsd, feePayersOf(await txsOf()));
            } catch (e) {
              if (signal?.aborted) retryBlock = true;
              else console.error(`Namada block ${h}: tx bytes unavailable, the shielded pool's fee read from the events alone:`, e);
            }
          }
          // PoS unbond and bond requests move no tokens with an event: decode them from the block's tx bytes (only when
          // a tx/applied result wrote an unbond or a bond key, so most blocks cost no extra RPC call).
          for (const req of [blockHasUnbond(blk) && UNBOND_LIVE, blockHasBond(blk) && BOND_LIVE]) {
            if (!req || retryBlock) continue;
            try {
              parsed.flows.push(...(await this.livePosRequests(req, blk, txsOf, read, priceUsd)));
            } catch (e) {
              // Nothing of this block has been written yet: leave the cursor below it and retry next tick.
              console.error(`Namada block ${h}: tx bytes unavailable, retrying next tick:`, e);
              retryBlock = true;
            }
          }
          if (!retryBlock && (parsed.flows.length > 0 || parsed.balances.length > 0)) {
            const now = Date.now();
            // A block read well after its time (the scan was behind): its moves are found late, and say so.
            if (now - blk.ts > LATE_SCAN_MS) for (const f of parsed.flows) f.meta = { ...(f.meta ?? {}), via: 'late scan' };
            // Priced at a quote that was a route's spot: the moves say which route (price-how.ts stampPriceRoute).
            stampPriceRoute(parsed.flows, route);
            // A send over the bridge whose NAM had just left the shielded pool says so (exit-bridge.ts): one read of the
            // senders' unshields, only for a block with a send. A read that fails leaves the sends unstamped, never the
            // block unwritten: the stamp is what one alert rule reads, not a figure.
            const sends = sendsToStamp(parsed.flows);
            if (sends.length) {
              const prior = await priorUnshields(this.env.DB, sends).catch((e) => { console.error(`Namada block ${h}: the senders' unshields could not be read, the sends are left unstamped:`, e); return null; });
              if (prior) stampShieldedExits(parsed.flows, prior);
            }
            // Each link right before its own flow (db.ts stmt.linkOnce: counted only while that flow is not stored),
            // the pairs first, so runBatch's batches of 80 never part a link from its flow: a block read again (a
            // cursor moved back) or written again after a failed batch counts each link once.
            const linkOf = new Map(parsed.links.map((l) => [l.flowId, l]));
            const flowIds = new Set(parsed.flows.map((f) => f.id));
            const stmts = [
              ...parsed.flows.filter((f) => linkOf.has(f.id)).flatMap((f) => [stmt.linkOnce(linkOf.get(f.id)!), stmt.flow(f)]),
              ...parsed.flows.filter((f) => !linkOf.has(f.id)).map(stmt.flow),
              ...parsed.moves.map(stmt.move),
              ...parsed.balances.map((b) => stmt.namadaBalance(b, now)),
              ...parsed.links.filter((l) => !flowIds.has(l.flowId)).map(stmt.linkOnce),
            ];
            try {
              await runBatch(this.env.DB, stmts);
            } catch (e) {
              console.error(`Namada block ${h}: rows could not be written, retrying next tick:`, e);
              retryBlock = true;
            }
            if (!retryBlock && parsed.flows.length > 0) {
              this.broadcast({ type: 'flows', flows: parsed.flows });
              toAlert.push(...parsed.flows.filter((f) => now - f.ts <= LATE_ALERT_MAX_AGE_MS));
            }
          }
        }
      } catch (e) {
        console.error(`Error processing Namada block ${h}:`, e);
        await this.noteScanFailure(h, `block ${h} not scanned: ${String(e)}`);
      }
      if (retryBlock) break;
      done = h;
      this.namadaHeight = h;
      if (toAlert.length) {
        // The cursor first: a cursor write that fails leaves the block to be read again next tick, and its moves'
        // claims keep them from being posted twice.
        try { await kvSet(this.env.DB, 'namada.cursor', String(done)); written = done; } catch (e) { console.error(`Namada block ${h}: the cursor could not be written before its alerts:`, e); }
        await this.alertFlows(toAlert, whaleNam, 10, alerts).catch((e) => console.error('Namada alerts:', e));
      }
    }
    if (done > written) await kvSet(this.env.DB, 'namada.cursor', String(done));
    // What the scan read while the head was agreed on (lastAgreed.read): blocks up to it are not read again.
    if (at.agreed && this.lastAgreed) this.lastAgreed.read = done;
  }

  /**
   * Unbond or bond flows for a block whose tx/applied results wrote a PoS unbond or bond key. Decodes the block's tx
   * bytes (`txsOf`, read once a block); the outcome (decoded / undecoded / fetch failure) is kept in the request's kv
   * row (`namada.unbonds.live`, `namada.bonds.live`) so the cron health view can show it. A failure throws so the
   * block is logged and held, never silently half-written.
   */
  private async livePosRequests(req: LivePosRequest, blk: NamadaBlock, txsOf: () => Promise<string[]>, read: ReadOpts, priceUsd: number | null) {
    const stored = await kvGet(this.env.DB, req.kv);
    let status: LiveUnbondStatus | null = null;
    try { status = stored ? (JSON.parse(stored) as LiveUnbondStatus) : null; } catch {}
    // No row yet (notePosStarts could not write it): this block is the first the decoder reads. A row that cannot be
    // read was made earlier, so its first block is not known and none is recorded.
    status ??= { decoded: 0, failures: [], ...(stored == null ? { firstHeight: blk.height } : {}) };
    try {
      const p = req.parse(blk, await txsOf(), priceUsd);
      status.decoded += p.flows.length;
      status.lastHeight = blk.height;
      status.lastAt = Date.now();
      if (p.undecoded.length) {
        for (const u of p.undecoded) console.error(`Namada block ${blk.height}: ${req.kind} ${u.innerHash} not decoded: ${u.reason}`);
        status.failures.push({ height: blk.height, at: Date.now(), note: p.undecoded.map((u) => `${u.innerHash.slice(0, 8)}: ${u.reason}`).join(' | ').slice(0, 300) });
      }
      return p.flows;
    } catch (e) {
      // A read the alarm's own deadline cut is not a failed read: the block is held and decoded by the next alarm.
      if (!read.signal?.aborted) status.failures.push({ height: blk.height, at: Date.now(), note: String(e).slice(0, 300) });
      throw e;
    } finally {
      status.failures = status.failures.slice(-20);
      await kvSet(this.env.DB, req.kv, status).catch(() => {});
    }
  }

  /**
   * Makes each live decoder's kv row (`namada.unbonds.live`, `namada.bonds.live`) that does not exist yet, with
   * `firstHeight` the block the scan reads next: the first block that decoder reads, since the scan never jumps. A row
   * that exists is left as it is. Once both rows are known to exist, this instance does not ask again.
   */
  private async notePosStarts(height: number) {
    for (const req of [UNBOND_LIVE, BOND_LIVE]) {
      if ((await kvGet(this.env.DB, req.kv)) != null) continue;
      const row: LiveUnbondStatus = { decoded: 0, failures: [], firstHeight: height };
      await kvSet(this.env.DB, req.kv, row);
    }
    this.posStartsNoted = true;
  }

  /**
   * The catch-up search: the stream is not a ledger (a dropped connection or a missed message loses a transaction,
   * as on 2026-10-17 a 20,000 NAM bridge send was lost). Each query is searched newest first until it reaches the
   * height already covered, the stream's OSMOSIS_QUERIES and two for each NAM pool's address (osmosisPoolQueries: a
   * pool's transactions in its other coin alone, which the stream never sees; a pool the hub learns of, at start or
   * from the router's list read again each hour (refreshPools), is searched from the cursor on, and what came before
   * is scripts/backfill-osmosis.ts's; together these read at most OSMOSIS_POOL_SWEEP_PAGES pages, after the stream's
   * queries, their probes POOL_PROBE_BATCH queries a read); transactions not yet in `flows` are parsed
   * and written with their block time, a pool's legs in its other coins with them (poolLegsOf), and those
   * whose write threw (osmoRetryTx) are alerted even when that write stored them. The cursor moves to the head read
   * at the start only when every one of the stream's queries answered (a pool query left behind keeps a floor of its
   * own, the cursor's `poolsFrom`), and to just below a stream transaction still being written or retried. A query with more than OSMOSIS_SWEEP_PAGES pages above the cursor is read on by the next search from
   * where this one stopped (the cursor's `resume`), so a backlog of any size is read through over several searches.
   * `signal`: the alarm's deadline (ALARM_DEADLINE_MS); a search it
   * ends is not complete, and the transactions it did not reach are read by the next one.
   * The pages it keeps transactions of share OSMOSIS_SWEEP_MAX_BYTES: a search that reaches it is not complete. A page
   * past the cap on every node is the same chain data on both: it is read again in pages of 10, and one of those past
   * it in pages of 1; a single transaction past it is skipped and named in the cursor (`skipped`), so the query still
   * answers and the search can finish. A short answer ends a query only when the nodes are known to hold the blocks it
   * answers for (nodeDepth, the cursor's `depth`, from the search's one /status): the public node's shallow backend,
   * after an outage longer than its history, answers short for want of the blocks, and the cursor never passes them.
   */
  private async sweepOsmosis(signal?: AbortSignal, alerts?: AlertBudget) {
    const prev = await kvGetJson<OsmosisCursor>(this.env.DB, 'osmosis.cursor');
    // The search's late alerts: each has a fan-out window of its own, opened at its first post, so the time the search
    // spends reading blocks and writing rows between two alerts never cuts a subscriber; together they are bounded by
    // the alarm's post count and its deadline (`alerts`, discord.ts alarmBudget), or, called on its own, by a budget
    // of the same kind ending with the alarm's deadline from now.
    const budget = alerts ?? alarmBudget(Date.now() + ALARM_DEADLINE_MS - WEBHOOK_TIMEOUT_MS, true);
    try {
      await this.sweepOsmosisWith(signal, prev, budget);
    } finally {
      if (!alerts) await flushAlerts(this.env.DB, budget);
    }
  }

  private async sweepOsmosisWith(signal: AbortSignal | undefined, prev: OsmosisCursor | null, alerts: AlertBudget) {
    // the time of the first move this search wrote that the socket, open since before it, should have delivered
    let deafAt: number | null = null;
    const rpcs = [{ provider: 'publicnode', url: OSMOSIS.publicRpc }, ...(this.env.KEPLR_KEY ? [{ provider: 'keplr', url: OSMOSIS.keplrRpc }] : [])];
    // Keplr's key travels in a header, never in the URL an error message carries.
    const initOf = (provider: string): RequestInit | undefined => (provider === 'keplr' ? { headers: keplrHeaders(this.env.KEPLR_KEY) } : undefined);
    // A node that failed a read of this search is asked last for the rest of it: one that accepts requests and never
    // answers would otherwise cost every read its 25 s before the other is asked.
    const breaker = new RpcBreaker();
    // A page of 50 transactions was 1.7 MB on 2026-10-22 and an Osmosis block is at most 3 MB: each read may be as
    // large as a listing (util.ts FETCH_TEXT_MAX_BYTES). An answer past it says nothing of the node (the other one
    // holds the same chain data), so no node is asked last for it, but the next node is still asked (one node could
    // pad its answer); the read is refused as too large only when every node's answer is. A read past what is left of
    // the search's `budget` asks no other node.
    const get = async (path: string, budget?: ReadBudget) => {
      let last: unknown, tooLarge: unknown, overBudget: unknown, large = 0;
      for (const r of breaker.order(rpcs)) {
        if (signal?.aborted) break;
        try { return await fetchJson<any>(`${r.url}${path}`, { timeoutMs: 25000, retries: 0, maxBytes: FETCH_TEXT_MAX_BYTES, signal, budget, init: initOf(r.provider) }); } catch (e) {
          // Past the budget's bytes left, as past the cap: the next node's answer of the same page may be smaller (one
          // node can pad its answers), so it is asked; the read fails only when every node's answer is too large.
          if (e instanceof ReadBudgetError) { overBudget = e; large++; continue; }
          if (e instanceof ResponseTooLargeError) { tooLarge = e; large++; continue; }
          last = e;
          if (!signal?.aborted) breaker.failed(r.provider);
        }
      }
      if (large === rpcs.length) throw overBudget ?? tooLarge;
      throw last ?? (tooLarge ? new Error(`only some nodes answered, past the cap: ${String(tooLarge)}`) : new Error('the catch-up search passed the alarm deadline'));
    };
    // A JSON-RPC batch (the pool probes), its answer handed back when it is one (an array). Only a node that has failed
    // no read of this search, and has not refused a batch in it, is asked; with none, the probes' queries are asked one
    // by one (`get`, the nodes in the breaker's order). A node that gives no answer is asked last for the rest of the
    // search, as for `get`; one that answers with something else (a node refusing batches: an error object, a 405) is
    // asked for no batch again. Else a node that accepts requests and never answers would cost every batch its 25 s,
    // the breaker putting it back first whenever the other node refused a batch: six batches, the alarm's deadline.
    const noBatch = new Set<string>();
    const post = async (body: string): Promise<unknown[] | null> => {
      for (const r of breaker.order(rpcs)) {
        if (signal?.aborted) break;
        if (noBatch.has(r.provider) || breaker.failures(r.provider) > 0) continue;
        try {
          const a = await fetchJson<unknown>(r.url, { timeoutMs: 25000, retries: 0, maxBytes: FETCH_TEXT_MAX_BYTES, signal, init: { method: 'POST', body, headers: { 'Content-Type': 'application/json', ...(r.provider === 'keplr' ? keplrHeaders(this.env.KEPLR_KEY) : {}) } } });
          if (Array.isArray(a)) return a;
          noBatch.add(r.provider);
        } catch (e) {
          if (e instanceof HttpError) noBatch.add(r.provider);
          else if (!(e instanceof ResponseTooLargeError) && !signal?.aborted) breaker.failed(r.provider);
        }
      }
      return null;
    };
    // pool legs an earlier write failed to store
    await this.retryLegs();
    const status = await get('/status');
    const head = Number(status?.result?.sync_info?.latest_block_height) || 0;
    if (!head) throw new Error('no Osmosis head height');
    // How far back the nodes answering this search are known to hold blocks (nodeDepth, from this /status and the
    // ones before it: no other read is made for it). A query's short answer is the end of the query only when what it
    // says is absent starts at or above `knownFrom` (walk); with no depth known, as before.
    const depth = nodeDepth(prev?.depth, head, status?.result?.sync_info?.earliest_block_height, Date.now());
    const knownFrom = depth ? head - depth.blocks : -Infinity;
    // The head's own time, kept with a cursor moved to it (OsmosisCursor `blockAt`).
    const headAt = Date.parse(status?.result?.sync_info?.latest_block_time ?? '');
    const shallowNotes: { q: string; note: string }[] = [];
    // A stream transaction whose write failed is read again even below the cursor (handleOsmosisMessage).
    const retryGen = this.osmoRetryGen;
    const floor = Math.min(prev?.height ?? 0, this.osmoRetryFrom != null ? this.osmoRetryFrom - 1 : Infinity);
    // The pool-address queries (osmosisPoolQueries) are read down to a floor of their own (`poolFloor`, the cursor's
    // `poolsFrom`), never above the stream's queries' floor: a search that leaves one of them unread still moves the
    // cursor once the stream's four are read down to theirs, and the next searches read the pool queries on from where
    // they stopped. Without a cursor yet none is read (what came before is scripts/backfill-osmosis.ts's).
    const ofPools = [...this.osmoCtx.poolAddrs.keys()].slice(0, OSMOSIS_POOL_QUERY_MAX).flatMap(osmosisPoolQueries);
    const poolQueries = floor > 0 ? ofPools : [];
    const ofPool = new Set(poolQueries);
    const pf = prev?.poolsFrom;
    const poolFloor = pf && Number.isSafeInteger(pf.height) && pf.height > 0 ? Math.min(floor, pf.height) : floor;
    /** The floor query `q` is read down to (each closure below reads its query's as `floor`). */
    const floorOf = (q: string) => (ofPool.has(q) ? poolFloor : floor);
    const found = new Map<string, any>();
    const have = new Set<string>();
    const looked = new Set<string>();
    const budget: ReadBudget = { left: OSMOSIS_SWEEP_MAX_BYTES };
    const skipped: string[] = [];
    /**
     * One read's transactions: those above the floor, up to the head, are looked at once each. One already stored
     * (and not a stream write that threw), seen by the stream, or that makes no row is let go at once (whether a
     * transaction makes a flow or a move does not depend on its time or price), and the read gives back to the budget
     * all its bytes but those of the transactions kept: only what the search will write or alert is held. `floor`: the
     * floor of the query read (floorOf).
     */
    const keep = async (txs: any[], bytes: number, floor: number) => {
      const fresh = txs.filter((t) => Number(t.height) > floor && Number(t.height) <= head);
      const ask = [...new Set(fresh.map((t) => String(t.hash).toUpperCase()))].filter((h) => !looked.has(h));
      for (let i = 0; i < ask.length; i += 90) {
        const part = ask.slice(i, i + 90);
        const r = await this.env.DB.prepare(`SELECT DISTINCT tx_hash FROM flows WHERE chain='osmosis' AND tx_hash IN (${part.map(() => '?').join(',')})`).bind(...part).all<{ tx_hash: string }>();
        for (const x of r.results || []) have.add(x.tx_hash);
      }
      let keptBytes = 0;
      for (const t of fresh) {
        const hash = String(t.hash).toUpperCase();
        if (looked.has(hash)) continue;
        looked.add(hash);
        if ((have.has(hash) && !this.osmoRetryTx.has(hash)) || this.seenOsmoTx.has(hash) || this.rowlessOsmoTx?.has(hash)) continue;
        const norm = normFromTxSearch(t, 0);
        const probe = parseOsmosisTx(norm, { ...this.osmoCtx, priceUsd: null });
        if (!probe.flows.length && !probe.moves.length && !poolLegsOf(norm, this.osmoCtx.poolAddrs).length) { this.noteRowless(hash); continue; }
        found.set(hash, t);
        keptBytes += JSON.stringify(t).length;
      }
      budget.left += Math.max(0, bytes - keptBytes);
    };
    type Row = { h: number; pos: number };
    /**
     * `per` transactions of query `q` from position (page - 1) * per, newest first: how many there were (`n`, a
     * skipped one counted), the lowest and highest heights read, and each transaction read put in `rows` (by hash: its
     * height and position). `after`: the height of the last transaction this query read.
     */
    const search = async (q: string, page: number, per: number, after: { height: number | null }, rows: Map<string, Row>): Promise<{ n: number; low: number; high: number }> => {
      const floor = floorOf(q);
      const before = budget.left;
      let r: any;
      try {
        r = await get(`/tx_search?query=${encodeURIComponent(`"${q}"`)}&page=${page}&per_page=${per}&order_by=%22desc%22`, budget);
      } catch (e) {
        if (!(e instanceof ResponseTooLargeError)) throw e;
        if (per === 1) {
          // One transaction past the cap on every node. One below the floor was looked at before and is not named.
          // Its height is at most the one read before it, which is what the paging below needs; it never shows that
          // a page starts above a height (`high`).
          if (after.height == null || after.height > floor) skipped.push(`query "${q}": ${after.height == null ? 'the newest transaction' : `the transaction after block ${after.height}`} was past the cap on every node and is not read`);
          return { n: 1, low: after.height ?? Infinity, high: -Infinity };
        }
        const sub = per === 50 ? 10 : 1;
        let n = 0, low = Infinity, high = -Infinity;
        for (let i = 1; i <= per / sub; i++) {
          const part = await search(q, (page - 1) * (per / sub) + i, sub, after, rows);
          n += part.n;
          low = Math.min(low, part.low);
          high = Math.max(high, part.high);
          if (part.n < sub || part.low <= floor) break;
        }
        return { n, low, high };
      }
      const txs: any[] = r?.result?.txs ?? [];
      await keep(txs, before - budget.left, floor);
      txs.forEach((t, i) => rows.set(String(t.hash).toUpperCase(), { h: Number(t.height), pos: (page - 1) * per + i }));
      if (txs.length) after.height = Number(txs[txs.length - 1].height);
      const hs = txs.map((t) => Number(t.height));
      return { n: txs.length, low: txs.length ? Math.min(...hs) : Infinity, high: txs.length ? Math.max(...hs) : -Infinity };
    };
    /**
     * Whether a short answer `r` of query `q` is the end of the query: it says the query has nothing older from block
     * `from` up, which a node can say only of blocks it holds. A node shallower than that (the public node's shallow
     * backend after an outage of the searches longer than its 16 hours) answers short for want of the blocks, so its
     * answer is not taken: the query is not done, the cursor stays, and the note says why (the cursor's `shallow`).
     */
    const ends = (q: string, r: { low: number }, from: number) => {
      if (from >= knownFrom) return true;
      shallowNotes.push({ q, note: `query "${q}": the answer ended ${Number.isFinite(r.low) ? `at block ${r.low}` : 'with no transaction'}, and the nodes are known to hold blocks only from ${knownFrom}, above block ${from} where the range starts; it is asked again` });
      return false;
    };
    /**
     * One query, newest first, at most OSMOSIS_SWEEP_PAGES pages: down to the floor or, with the place the last search
     * left (`old`), down to its top and then on from the page its last transaction should be on, counted from the
     * newest with what came since. That page is taken only when it holds that transaction or its newest transaction is
     * above that one's height, so nothing after the place is passed over (a node a little behind answers the pages a
     * little lower); else the page before it is read. `rows`: the transactions read from the newest down and from the
     * page taken on. `done`: the query was read down to the floor. `old`: the place gone on from, whose transactions
     * lie between those read from the newest and those read from the page taken (null when it was not gone on from).
     * `stand`: the answers did not reach the place, which stands as it was. `shallow`: a short answer was not taken as
     * the end of the query (ends).
     */
    let pagesRead = 0;
    const walk = async (q: string, old: OsmosisResume | null, rows: Map<string, Row>, cap = OSMOSIS_SWEEP_PAGES): Promise<{ done: boolean; old: OsmosisResume | null; stand?: boolean; shallow?: boolean }> => {
      const floor = floorOf(q);
      const after = { height: null as number | null };
      let pages = 0, page = 0;
      const read = (p: number, into = rows) => { pages++; pagesRead++; return search(q, p, 50, after, into); };
      // Without a previous cursor one page is enough to start from.
      if (!floor) { await read(1); return { done: true, old: null }; }
      const stop = old ? old.top : floor;
      for (;;) {
        if (pages >= cap) return { done: false, old: null };
        const r = await read(++page);
        if (r.low <= floor) return { done: true, old: null };
        if (r.low <= stop) break;
        // The end of the query: it is read down to the floor (below the place's top, the place covers it), or a node
        // that does not have the place's transactions answered (the place stands for the next search), or one whose
        // blocks may not reach back that far (ends).
        if (r.n < 50) {
          if (old && old.n > 0) return { done: false, old, stand: true };
          if (ends(q, r, old && old.low <= floor ? old.top + 1 : floor + 1)) return { done: true, old: null };
          return { done: false, old, stand: !!old, shallow: true };
        }
      }
      if (!old || !old.last || old.low <= floor) return { done: true, old };
      const fromTop = page;
      let above = Infinity;
      for (const r of rows.values()) if (r.h <= old.top) above = Math.min(above, r.pos);
      page = rows.has(old.last) ? fromTop + 1 : Math.max(fromTop + 1, Math.floor((above + old.n - 1) / 50) + 1);
      let taken = page === fromTop + 1;
      // The end of the query counts only once the answers reach past the place: before that, a node that does not have
      // the place's transactions answered.
      let past = [...rows].some(([hash, x]) => hash === old.last || x.h < old.low);
      while (pages < cap) {
        const into = new Map<string, Row>();
        const r = await read(page, into);
        if (!taken) {
          if (!(into.has(old.last) || r.high > old.low)) { if (--page === fromTop + 1) taken = true; continue; }
          taken = true;
        }
        for (const [hash, x] of into) { rows.set(hash, x); if (hash === old.last || x.h < old.low) past = true; }
        if (r.low <= floor) return { done: true, old };
        if (r.n < 50) return past && ends(q, r, floor + 1) ? { done: true, old } : { done: false, old, stand: true };
        page++;
      }
      // No page taken: the place does not fit what the nodes answer now, and only the pages from the newest count.
      return { done: false, old: taken ? old : null };
    };
    // A place is gone on from only while its top is above the floor, and it holds no stream transaction whose write
    // threw (the search reads that one again). Its top may be above this search's head: the head can be a few blocks
    // below the last search's (the other node answered /status, or a second search runs seconds after the first when
    // the stream reconnects), and dropping the place would start the catch-up again from the newest. The transactions
    // above the head are not looked at (keep), and a place left from this search's own reads has this head as top.
    const placeOf = (q: string): OsmosisResume | null => {
      const floor = floorOf(q);
      const o = prev?.resume?.[q];
      if (!o || !(Number.isFinite(o.top) && Number.isFinite(o.low) && Number.isInteger(o.n) && o.n >= 0)) return null;
      if (o.top <= floor || o.low > o.top || (o.low > floor && typeof o.last !== 'string')) return null;
      const from = o.low > floor ? o.low : floor + 1;
      return [...this.osmoRetryTx.values()].some((h) => h >= from && h <= o.top) ? null : o;
    };
    let complete = true;
    // Whether every pool-address query was read down to its floor (or was quiet, or its place held): only then does
    // their floor move with the cursor (`poolsFrom`). A pool query left unread never holds the cursor.
    let poolsDone = true;
    const walks = new Map<string, { done: boolean; old: OsmosisResume | null; stand?: boolean; shallow?: boolean; rows: Map<string, Row> } | null>();
    /** Query `q` read (walk), at most `cap` pages, into `walks`: whether it was read down to its floor. */
    const readOne = async (q: string, old: OsmosisResume | null, cap: number): Promise<boolean> => {
      const rows = new Map<string, Row>();
      try {
        const w = await walk(q, old, rows, cap);
        walks.set(q, { ...w, rows });
        return w.done;
      } catch (e) {
        walks.set(q, null);
        console.error(`Osmosis catch-up search "${q}":`, e);
        return false;
      }
    };
    // The stream's queries first: what the stream missed of NAM never waits on the pools' probes or their pages.
    for (const q of OSMOSIS_QUERIES) if (!(await readOne(q, placeOf(q), OSMOSIS_SWEEP_PAGES))) complete = false;
    // The pool-address queries (osmosisPoolQueries) find what moves only a pool's other coin, which matches none of
    // OSMOSIS_QUERIES. Most pools see nothing for hours, so each is first asked for its newest transaction alone,
    // POOL_PROBE_BATCH queries a read (probePools), and is read like the others only when that one is above its floor,
    // or above the top of a place read down to the floor (a place gone on from part way is read on without asking). A
    // probe that fails says nothing, and its query is read like the others. An answer with a transaction comes from an
    // index that holds that block, and so every block above it; an empty one says the range holds nothing only when
    // the index is known to hold where the range starts: its batch's /status names the index's first block, or the
    // nodes are known to hold it (knownFrom, as `ends` asks). Else (the public node's shallow backend, after the
    // searches stopped for longer than its 16 hours) the query is left as it was for the next search's probe, which
    // may come from the other index: a walk's pages could come from the same one. Together they read at most
    // OSMOSIS_POOL_SWEEP_PAGES pages, from the query the last search left unread for want of them (`poolsNext`), so
    // that when more of them have something new than the pages allow, the ones late in the list are read too.
    const goingOn = (o: OsmosisResume | null) => !!o && o.low > poolFloor;
    const probed = await this.probePools(poolQueries.filter((q) => !goingOn(placeOf(q))), get, post, signal);
    // nothing above the floor: read down to it; nothing above a place's top: its place holds as it was
    const quiet = new Set<string>(), holding = new Set<string>(), unsure = new Set<string>();
    for (const [q, { h, first }] of probed) {
      const o = placeOf(q);
      const top = o ? o.top : poolFloor;
      if (h > top) continue;
      if (Number.isFinite(h) || top + 1 >= knownFrom || (first != null && first <= top + 1)) (o ? holding : quiet).add(q);
      else unsure.add(q);
    }
    let poolPages = OSMOSIS_POOL_SWEEP_PAGES;
    const start = Math.max(0, poolQueries.indexOf(prev?.poolsNext ?? ''));
    let poolsNext: string | undefined;
    let unread = 0;
    for (const q of [...poolQueries.slice(start), ...poolQueries.slice(0, start)]) {
      if (quiet.has(q)) { walks.set(q, { done: true, old: null, rows: new Map() }); continue; }
      // carried as it was (below), and nothing to read
      if (holding.has(q)) { walks.set(q, null); continue; }
      if (unsure.has(q)) { walks.set(q, null); poolsDone = false; continue; }
      const old = placeOf(q);
      // a place gone on from takes two pages: the newest down to its top, then on from its last
      if (poolPages < (goingOn(old) ? 2 : 1)) { walks.set(q, null); poolsDone = false; poolsNext ??= q; unread++; continue; }
      const before = pagesRead;
      if (!(await readOne(q, old, Math.min(OSMOSIS_SWEEP_PAGES, poolPages)))) poolsDone = false;
      poolPages -= pagesRead - before;
    }
    let added = 0;
    const times = new Map<number, number>();
    // The transactions kept and not yet written or let go: a place never passes one (the next search reads it again).
    const unwritten = new Set(found.keys());
    for (const [hash, t] of found) {
      if (signal?.aborted) { complete = false; break; }
      if (this.seenOsmoTx.has(hash)) { unwritten.delete(hash); continue; }
      // A transaction whose write threw (osmoRetryTx) is read again though rows of it are stored: that write stored
      // all of its rows (one batch), so they are not written again, but nothing alerted them.
      if (have.has(hash) && !this.osmoRetryTx.has(hash)) { unwritten.delete(hash); continue; }
      const h = Number(t.height);
      if (!times.has(h)) {
        const b = await get(`/block?height=${h}`).catch(() => null);
        const ts = Date.parse(b?.result?.block?.header?.time ?? '');
        if (!Number.isFinite(ts)) { complete = false; continue; } // no block time: never written with a made-up one
        times.set(h, ts);
      }
      // A transaction found late is priced at its own minute's quote, never the current one; one whose quote could not
      // be read is left for the next search, as one without a block time is. One with no flow (a pool's other coin
      // alone) has nothing to price, and no quote is read for it.
      let priceUsd: number | null = null;
      let route: number | null | undefined;
      if (parseOsmosisTx(normFromTxSearch(t, 0), { ...this.osmoCtx, priceUsd: null }).flows.length) {
        try {
          const q = await this.quote.quoteFor(times.get(h)!, Date.now());
          priceUsd = q?.usd ?? null;
          route = await this.routeOf(q);
        } catch {
          complete = false;
          continue;
        }
      }
      const norm = normFromTxSearch(t, times.get(h)!);
      const parsed = parseOsmosisTx(norm, { ...this.osmoCtx, priceUsd });
      // a pool's legs in its other coins, at the block's time (a transaction may have these alone: no flow to show or alert)
      const legs = poolLegsOf(norm, this.osmoCtx.poolAddrs);
      stampPriceRoute(parsed.flows, route);
      // Written below, or the search ends here (a write that throws ends it before the cursor is written).
      unwritten.delete(hash);
      if (!parsed.flows.length && !parsed.moves.length && !legs.length) continue;
      for (const f of parsed.flows) f.meta = { ...(f.meta ?? {}), tsSource: 'block', via: 'catch-up search' };
      if (!have.has(hash)) {
        try {
          await this.writeOsmoTx(parsed, legs);
        } catch (e) {
          this.noteOsmoWriteFailed(hash, h);
          throw e;
        }
        added += parsed.flows.length;
        // a transaction the stream did deliver, whose write failed (osmoRetryTx), is not one the socket missed
        if (parsed.flows.length && !this.osmoRetryTx.has(hash)) deafAt ??= osmoDeafAt(this.osmoSince, this.osmoWs != null, times.get(h)!, Date.now());
      }
      this.seenOsmoTx.add(hash);
      this.osmoRetryTx.delete(hash);
      if (parsed.flows.length) this.broadcast({ type: 'flows', flows: parsed.flows });
      // Owner decision 14: a move the live stream missed still alerts, marked as found late (discord.ts), unless
      // it is older than LATE_ALERT_MAX_AGE_MS, so a long outage does not flood the channels with old news.
      const recent = parsed.flows.filter((f) => Date.now() - f.ts <= LATE_ALERT_MAX_AGE_MS);
      if (recent.length) await this.alertFlows(recent, undefined, undefined, alerts).catch((e) => console.error('late alert:', e));
    }
    // A move the open socket should have delivered and did not: the socket is deaf (a subscription the node ended
    // without a message the hub could read). It is closed, so the close handler opens a new one with every query.
    if (deafAt != null && this.osmoWs) {
      console.error(`Osmosis WS deaf: the catch-up search wrote a move of ${new Date(deafAt).toISOString()} the socket, open since ${new Date(this.osmoSince ?? 0).toISOString()}, did not deliver; reconnecting`);
      this.osmoDrops.deaf++;
      this.osmoDrops.lastAt = Date.now();
      this.dropOsmosisWs(this.osmoWs);
    }
    if (head > this.osmoHeight) this.osmoHeight = head;
    if (complete && this.osmoRetryGen === retryGen) {
      // Only what this search could have read is done: a transaction above the head it read (the public node can lag
      // the stream) stays queued, with the height the next search starts below.
      for (const [hash, h] of this.osmoRetryTx) if (h <= head) this.osmoRetryTx.delete(hash);
      const left = [...this.osmoRetryTx.values()];
      this.osmoRetryFrom = left.length ? Math.min(...left) : null;
    }
    // The cursor never passes a stream transaction not yet known written: one whose write is still running (this
    // search skipped it as seen), or one whose write threw after this search began (still in osmoRetryTx). The retry
    // list lives in memory only, so a cursor past such a transaction would lose it for good if the hub restarted
    // before the next search; kept below it, the first search after a restart finds it again. A write running longer
    // than a search interval is not waited on, and the cursor never moves back for a height the stream reported.
    const now = Date.now();
    const pending = [
      ...[...this.osmoWriting.values()].filter((w) => now - w.since < OSMOSIS_SWEEP_EVERY_MS).map((w) => w.height),
      ...this.osmoRetryTx.values(),
    ].filter((h) => h > 0 && h <= head);
    const upTo = pending.length ? Math.max(prev?.height ?? 0, Math.min(...pending) - 1) : head;
    // The transactions no node could give within the cap, kept with the cursor (the newest 20, each named once).
    for (const note of skipped) console.error(`Osmosis catch-up search: ${note}`);
    const skips = [...(prev?.skipped ?? []), ...[...new Set(skipped)].filter((note) => !prev?.skipped?.some((s) => s.note === note)).map((note) => ({ at: now, note }))].slice(-20);
    const kept = skips.length ? { skipped: skips } : {};
    // Where each query is left when the cursor stays, and each pool-address query when their floor stays: down to the
    // last transaction read before one not written yet (no block time, no quote, the deadline), and never past one. The rows are taken in the order read, which is the
    // query's order (positions from two nodes' answers need not agree). A query that failed, or read nothing to go on
    // from, keeps its place.
    // Nor is a place left past a stream transaction not yet known written, the ones `pending` keeps the cursor below:
    // this search let it go as seen while its write ran, and only the hub's memory says to read it again, which a
    // restart empties. The place ends above its hash and above its block (the node's index may not give it yet), so
    // the next search, or the first one after a restart, reads it again.
    for (const hash of this.osmoRetryTx.keys()) unwritten.add(hash);
    for (const [hash, w] of this.osmoWriting) if (now - w.since < OSMOSIS_SWEEP_EVERY_MS) unwritten.add(hash);
    const held = pending.length ? Math.max(...pending) : -Infinity;
    const resume: Record<string, OsmosisResume> = {};
    if (!complete || !poolsDone) {
      for (const [q, w] of walks) {
        // the cursor moves: only the pool queries left behind keep places, below their own floor
        if (complete && !ofPool.has(q)) continue;
        const floor = floorOf(q);
        const carried = prev?.resume?.[q];
        if (!w) { if (carried) resume[q] = carried; continue; }
        const old = w.old;
        if (w.stand && old) { resume[q] = old; continue; }
        // A short answer not taken (walk `shallow`) leaves no place of its own: the page after it is past what that node
        // holds (an error), and the next search reads from the newest again, down to the cursor on a node that has it.
        if (w.shallow) continue;
        const list = [...w.rows].map(([hash, x], i) => ({ hash, ...x, i }));
        const inRange = (x: { h: number }) => x.h > floor && x.h <= head;
        const oldAt = old?.last ? list.findIndex((x) => x.hash === old.last) : -1;
        const ofOld = (x: { h: number; i: number }) => !!old && x.h <= old.top && (oldAt >= 0 ? x.i <= oldAt : x.h > old.low);
        // The place gone on from holds while none of its own transactions read again is still to be written: one this
        // search kept and did not write, or a stream transaction not yet known written. Such a one shows the place was
        // wrong about it (the node's index did not give it to the search that took its block as top, say), or only
        // the hub's memory says to read it again. The place is then cut at it like any other, not written back.
        const holds = !!old && !list.some((x) => ofOld(x) && inRange(x) && unwritten.has(x.hash));
        // A transaction at or below a held block ends the place too, except the place's own read again while it
        // holds: the search that read them first looked at them.
        const cut = list.find((x) => inRange(x) && (unwritten.has(x.hash) || (x.h <= held && !(holds && ofOld(x)))));
        // The place gone on from is written back when the cut is above its top, and also when a held block lies above
        // its top (`pending` holds blocks up to this head only) though no row above the top was cut at: the node's
        // index may not give that block's transaction yet, and a place from this search's reads would take this head
        // as top over it. Its top stays below the block, so the next search reads the block from the newest.
        if (holds && old && ((cut && cut.h > old.top) || held > old.top)) { resume[q] = old; continue; }
        // Read down to the floor: the next search reads it down to this head only (none read: it reads one page, except
        // while the range starts below what the nodes are known to hold, where that page may come from a node that
        // cannot end the query: the place keeps what this search found, so each query has to be ended only once).
        if (w.done && !cut) { if (list.some(inRange) || floor + 1 < knownFrom) resume[q] = { top: head, low: floor, n: 0 }; continue; }
        const aboveHead = list.filter((x) => x.h > head).length;
        const last = list.filter((x) => inRange(x) && (!cut || x.i < cut.i)).at(-1);
        // Nothing read before the cut: a place the walk went on from is kept only while it holds, since one that does
        // not covers the cut, and one it did not go on from is kept as it was.
        const o = old ? (holds ? old : null) : carried;
        if (last) resume[q] = { top: head, low: last.h, n: last.pos + 1 - aboveHead, last: last.hash };
        else if (o) resume[q] = o;
      }
    }
    const behind = Object.keys(resume).length > 0;
    // The depth the nodes are known to hold, and the stream's queries' short answers not taken for it: kept until a
    // search finishes (the cron's osmosis_index check carries them with the cursor's error, analytics.ts indexState).
    // The pool queries' go with their floor (`poolsFrom`).
    for (const x of shallowNotes) console.warn(`Osmosis catch-up search: ${x.note}`);
    const namShallow = shallowNotes.filter((x) => !ofPool.has(x.q)).map((x) => x.note);
    const shallow = namShallow.length ? { at: now, note: namShallow.join('; ').slice(0, 1000) } : complete ? undefined : prev?.shallow;
    const known = { ...(depth ? { depth } : {}), ...(shallow ? { shallow } : {}) };
    const pools = ofPools.length / 2;
    const height = complete ? upTo : prev?.height ?? 0;
    // The pool queries' own floor, while one of them is left behind, with why.
    const poolNotes = [
      unread ? `${unread} not read: the search's ${OSMOSIS_POOL_SWEEP_PAGES} pages for them were spent, and the next search starts with them` : '',
      unsure.size ? `${unsure.size} answered with no transaction by an index whose first block is above where their range starts, asked again` : '',
      ...shallowNotes.filter((x) => ofPool.has(x.q)).map((x) => x.note),
    ].filter(Boolean);
    const poolsFrom = !poolsDone && poolFloor > 0 && poolFloor < height
      ? { height: poolFloor, at: pf && pf.height === poolFloor && Number.isFinite(pf.at) ? pf.at : prev?.at ?? 0, note: `Of the pool-address queries, ${poolNotes.length ? poolNotes.join('; ') : 'some were not read down to the block'}.`.slice(0, 1000) }
      : undefined;
    const ofPoolsLeft = { ...(poolsFrom ? { poolsFrom } : {}), ...(poolsNext ? { poolsNext } : {}) };
    // The head's time goes with a cursor moved to the head; a cursor that stopped below it keeps the time it had.
    const blockAt = complete && upTo === head && Number.isFinite(headAt) ? headAt : prev?.blockAt;
    const timeOf = blockAt != null && Number.isFinite(blockAt) ? { blockAt } : {};
    const next: OsmosisCursor = complete
      ? { height, at: Date.now(), added, ...kept, ...known, pools, ...timeOf, ...ofPoolsLeft, ...(behind ? { resume } : {}) }
      : {
          height, at: prev?.at ?? 0, added, ...kept, ...known, pools, ...timeOf, ...ofPoolsLeft,
          error: namShallow.length ? 'The last catch-up search did not finish: a node answered from blocks that may not reach back to the cursor, and the next search asks again.'
            : behind ? 'The last catch-up search did not finish; the next one goes on from where it stopped.' : 'The last catch-up search did not finish; it is retried.',
          ...(behind ? { resume } : {}),
        };
    if (complete || prev) await kvSet(this.env.DB, 'osmosis.cursor', next);
    if (!complete) this.needSweep = false; // retried on the regular schedule, not every alarm
  }

  private broadcast(msg: LiveMessage) {
    const raw = JSON.stringify(msg);
    for (const ws of this.sessions) {
      try {
        ws.send(raw);
      } catch {
        this.dropSocket(ws);
      }
    }
  }

  /** A socket leaves the hub: counted first, so an hour that ended since the last count still holds it. */
  private dropSocket(ws: WebSocket) {
    if (!this.sessions.has(ws)) return;
    this.countSockets();
    this.sessions.delete(ws);
  }

  /**
   * The hour's count of open sockets (SocketMark), called after a socket is added, before one leaves, and at every
   * alarm: nothing changed since the last call, so the sockets open now were open when an hour that began since then
   * began. That hour is ended (kept for its row) and the new one starts from them, then the count is raised to the
   * sockets open now. The first count of an instance with nothing stored for the hour starts now, not at the hour.
   */
  private countSockets(now = Date.now()) {
    const hour = Math.floor(now / HOUR_MS) * HOUR_MS;
    const n = this.sessions.size;
    let m = this.socketMark;
    if (!m) m = { hour, max: n, from: now };
    else if (m.hour !== hour) {
      this.socketMarksDone = [...(this.socketMarksDone ?? []), m].slice(-SOCKET_MARKS_KEPT);
      m = { hour, max: n, from: hour };
    }
    if (n > m.max) m = { ...m, max: n };
    this.socketMark = m;
  }

  /**
   * The count as the object's storage kept it (SOCKET_MARK_STORE), read in the constructor: this hour's goes on (a
   * restart, or a deploy, keeps the hour's count), an earlier hour's is ended and written by the next alarm. One that
   * cannot be read starts a count now.
   */
  private async loadSocketMark() {
    const now = Date.now();
    const hour = Math.floor(now / HOUR_MS) * HOUR_MS;
    let kept: SocketMarks | undefined;
    try { kept = await this.ctx.storage.get<SocketMarks>(SOCKET_MARK_STORE); } catch (e) { console.error('live sockets: the stored count could not be read:', e); }
    const done = Array.isArray(kept?.done) ? kept.done.filter(isMark) : [];
    const m = isMark(kept?.now) ? kept.now : null;
    if (m && m.hour === hour) this.socketMark = { ...m, max: Math.max(m.max, this.sessions.size) };
    else {
      if (m && m.hour < hour) done.push(m);
      this.socketMark = { hour, max: this.sessions.size, from: now };
    }
    this.socketMarksDone = [...this.socketMarksDone, ...done].slice(-SOCKET_MARKS_KEPT);
  }

  /**
   * At every alarm: the count (countSockets), each hour ended written to metrics in one batch (liveSocketStmts), and
   * the count kept in the object's storage when it changed, at most every SOCKET_MARK_SAVE_MS and at once after a
   * write. A write that fails keeps its hours for the next alarm.
   */
  private async noteSockets(now = Date.now()) {
    this.countSockets(now);
    let wrote = false;
    const done = (this.socketMarksDone ??= []);
    if (done.length) {
      try {
        await runBatch(this.env.DB, done.flatMap(liveSocketStmts));
        this.socketMarksDone = this.socketMarksDone.filter((m) => !done.includes(m));
        wrote = true;
      } catch (e) {
        console.error(`live sockets: ${done.length} hour(s) not written, tried again next alarm:`, e);
      }
    }
    const v: SocketMarks = { now: this.socketMark, done: this.socketMarksDone };
    const s = JSON.stringify(v);
    if (s === this.socketMarkSaved || (!wrote && now - this.socketMarkSavedAt < SOCKET_MARK_SAVE_MS)) return;
    try {
      await this.ctx.storage.put(SOCKET_MARK_STORE, v);
      this.socketMarkSaved = s;
      this.socketMarkSavedAt = now;
    } catch (e) {
      console.error('live sockets: the count was not kept in storage:', e);
    }
  }

  private broadcastStatus() {
    this.broadcast({
      type: 'status',
      upstream: { osmosis: !!this.osmoWs, namada: true },
      heights: { osmosis: this.osmoHeight, namada: this.namadaHeight },
      at: Date.now(),
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected websocket upgrade', { status: 426 });
      }
      // Admission (ws-admit.ts): the hub holds every socket in memory and walks them all on each broadcast.
      // Counted per client (client-key.ts: an IPv4 address, an IPv6 /64 and its /48); a request without the header
      // (a local run, a direct origin call) shares one bucket rather than none.
      const who = clientOfRequest(request);
      const verdict = admitAmong([...this.sessions].map((s) => this.clients.get(s)), who);
      if (verdict === 'full') return new Response('The live feed is full right now; try again in a minute.', { status: 503, headers: { 'retry-after': '60' } });
      if (verdict === 'ip') return new Response('Too many live connections from your address or its network.', { status: 429, headers: { 'retry-after': '60' } });
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];

      server.accept();
      this.sessions.add(server);
      this.clients.set(server, who);
      this.countSockets();

      // Send initial hello
      server.send(
        JSON.stringify({
          type: 'hello',
          at: Date.now(),
          upstream: { osmosis: !!this.osmoWs, namada: true },
        } as LiveMessage),
      );

      server.addEventListener('message', (ev) => {
        if (ev.data === 'ping') {
          server.send('pong');
          return;
        }
        // The feed is one way: nothing a client sends is read or relayed, and a client that sends anything else is
        // disconnected (so a stream of large frames cannot keep the hub busy).
        this.dropSocket(server);
        try { server.close(1008, 'the feed is one way'); } catch {}
      });

      server.addEventListener('close', () => {
        this.dropSocket(server);
      });
      server.addEventListener('error', () => {
        this.dropSocket(server);
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('Not found', { status: 404 });
  }
}
