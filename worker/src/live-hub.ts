import { DurableObject } from 'cloudflare:workers';
import type { Env } from './util';
import type { LiveMessage, Flow } from '../../shared/types';
import { OSMOSIS, NAM, NAMADA } from './config';
import { normFromWs, normFromTxSearch, osmoAssets, parseOsmosisTx, type OsmoCtx, type OsmoParsed } from './parse/osmosis';
import { parseNamadaBlock } from './parse/namada';
import { blockHasUnbond, parseNamadaUnbonds } from './parse/namada-unbond';
import { feePayersOf } from './parse/namada-tx';
import { blockMetas, blockResults, blockTxs, chainHead, headBound, headSince, namadaStatusAll, HEAD_AGREE_BLOCKS, HEAD_BOUND_BLOCK_MS, HEAD_VOTE_MAX_AGE_MS, RpcBreaker, LIVE_READ, type HeadVote, type ReadOpts, type Rpc } from './sources/namada';
import type { NamadaBlock } from './parse/namada';
import { runBatch, stmt, kvGet, kvGetJson, kvSet } from './db';
import { admitSocket } from './ws-admit';
import { fetchNamPools, fetchNamPrice } from './sources/sqs';
import { HubQuote, storedQuoteReader } from './live-quote';
import { configureAlerts, isNamWhale, offeredForAlerts, sendDiscordWhaleAlert } from './sources/discord';
import { fetchJson, FETCH_TEXT_MAX_BYTES, ReadBudgetError, ResponseTooLargeError, type ReadBudget } from './util';

/** Moves found late by the catch-up search alert only when they happened within this window. */
export const LATE_ALERT_MAX_AGE_MS = 24 * 3600_000;

/** The Osmosis subscriptions: the stream listens to these and the catch-up search repeats them. */
export const OSMOSIS_QUERIES = [
  "token_swapped.pool_id='3005'",
  `transfer.amount CONTAINS '${NAM.osmoHash}'`,
  `recv_packet.packet_dst_channel='${NAM.osmoChannel}'`,
  `send_packet.packet_src_channel='${NAM.osmoChannel}'`,
];
/** How often the stream state is written to kv (osmosis.live) and the catch-up search runs. */
export const OSMOSIS_LIVE_EVERY_MS = 60_000;
export const OSMOSIS_SWEEP_EVERY_MS = 5 * 60_000;
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
 */
export interface OsmosisCursor { height: number; at: number; added?: number; error?: string; skipped?: { at: number; note: string }[]; resume?: Record<string, OsmosisResume> }
/**
 * Where a catch-up search that did not finish left one query. The search can only page from the newest transaction,
 * so a query with more than OSMOSIS_SWEEP_PAGES pages above the cursor (they came faster than the searches, or the
 * searches failed for a while) was read again from the newest by every search and stopped at the same depth, and the
 * cursor never moved again. Every transaction of the query at most `top` high, from the newest down to transaction
 * `last` (at height `low`, the `n`th of them), has been looked at; with no `last`, every one down to the cursor (`low`).
 * The next search reads down to `top`, counts what came since, and goes on from the page `last` is on.
 */
export interface OsmosisResume { top: number; low: number; n: number; last?: string }

/** kv `namada.unbonds.live`: outcome of the live unbond decoder, surfaced by the cron health probe. */
export interface LiveUnbondStatus {
  decoded: number;
  lastHeight?: number;
  lastAt?: number;
  failures: { height: number; at: number; note: string }[];
}

/** kv `namada.scan`: blocks the live scan could not read as blocks (a shape it does not understand, or a gap it had to jump), surfaced by the cron health probe. */
export interface LiveScanStatus {
  failures: { height: number; at: number; note: string }[];
}
/** How far behind the head the scan may fall before it jumps ahead (the blocks it jumps over are recorded as not scanned). */
export const SCAN_MAX_LAG = 50;
/** How often the same kind of head note (no node at the head, nodes that disagree) is recorded in kv `namada.scan`. */
export const HEAD_NOTE_EVERY_MS = 10 * 60_000;
/**
 * One deadline for an alarm's reads. The next Namada scan starts only when the alarm ends, and a scan more than
 * SCAN_MAX_LAG blocks behind (about 341 s at 6.8 s a block) jumps the blocks between: no read of the scan or the
 * catch-up search starts or goes on past this, and what they did not reach is left for the next alarm (the scan's
 * cursor) or the next search (the Osmosis cursor is kept). A search after a long outage goes on over several searches.
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

export class LiveHub extends DurableObject<Env> {
  private sessions = new Set<WebSocket>();
  /** The client address each socket came from (ws-admit.ts caps per address). */
  private ips = new WeakMap<WebSocket, string>();
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
  private lastAgreedSaved = 0;
  private osmoSince: number | null = null;
  private osmoLastMsgAt: number | null = null;
  private lastLiveReport = 0;
  private lastSweep = 0;
  private needSweep = true;
  /** The NAM quote new moves are priced at, as osmoCtx.priceUsd: null when none is fresh (worker/src/live-quote.ts). */
  private lastPriceUsd: number | null = null;
  private quote: HubQuote;
  private osmoCtx: OsmoCtx = {
    poolAddrs: new Map(),
    priceUsd: null,
    assets: osmoAssets(),
  };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    configureAlerts(env.SETTINGS_KEY);
    this.quote = new HubQuote(async () => (await fetchNamPrice()).usd, storedQuoteReader(env.DB));
    this.ctx.blockConcurrencyWhile(async () => {
      // Initialize pool mappings & price
      await this.refreshContext();
      // Schedule first alarm for Namada polling
      const currentAlarm = await this.ctx.storage.getAlarm();
      if (!currentAlarm) {
        await this.ctx.storage.setAlarm(Date.now() + 2000);
      }
      // Connect to Osmosis WS
      this.ensureOsmosisWs();
    });
  }

  async refreshContext() {
    try {
      const { pools } = await fetchNamPools();
      for (const p of pools) {
        if (p.address) this.osmoCtx.poolAddrs.set(p.address, p.id);
      }
    } catch (e) {
      console.error('refreshContext error:', e);
    }
    await this.refreshQuote();
  }

  /**
   * The quote for moves now (HubQuote.refresh), kept in osmoCtx.priceUsd and lastPriceUsd. A change is broadcast only
   * when it is the hub's own answer from the quote service: the page shows a streamed price as live, and the cron's
   * stored minute reaches it through its own polls, labelled as stored.
   */
  private async refreshQuote() {
    const q = await this.quote.refresh(Date.now()).catch(() => null);
    const usd = q?.usd ?? null;
    this.osmoCtx.priceUsd = usd;
    if (usd !== this.lastPriceUsd) {
      this.lastPriceUsd = usd;
      if (q?.source === 'live') this.broadcast({ type: 'price', usd: q.usd, at: q.at });
    }
  }

  private ensureOsmosisWs() {
    if (this.osmoWs || this.isConnectingOsmo || !this.env.KEPLR_KEY) return;
    this.isConnectingOsmo = true;

    try {
      const wsUrl = OSMOSIS.keplrWs(this.env.KEPLR_KEY);
      const ws = new WebSocket(wsUrl);
      // A connection that neither opens nor fails within this long is closed (its close listener reconnects), so a
      // half-open handshake can never leave `isConnectingOsmo` set for good.
      let opened = false;
      const pending = setTimeout(() => { if (!opened) { try { ws.close(); } catch {} } }, 20_000);

      ws.addEventListener('open', () => {
        opened = true;
        clearTimeout(pending);
        this.osmoWs = ws;
        this.isConnectingOsmo = false;
        console.log('Connected to Osmosis WebSocket');

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
      });

      ws.addEventListener('message', async (event) => {
        try {
          const msg = JSON.parse(event.data as string);
          await this.handleOsmosisMessage(msg);
        } catch (e) {
          console.error('Error handling Osmosis WS message:', e);
        }
      });

      ws.addEventListener('close', () => {
        clearTimeout(pending);
        this.osmoWs = null;
        this.isConnectingOsmo = false;
        this.osmoSince = null;
        this.needSweep = true;
        // Reconnect in 5 seconds
        setTimeout(() => this.ensureOsmosisWs(), 5000);
      });

      ws.addEventListener('error', (err) => {
        console.error('Osmosis WS error:', err);
        ws.close();
      });
    } catch (e) {
      this.isConnectingOsmo = false;
      setTimeout(() => this.ensureOsmosisWs(), 5000);
    }
  }

  private async handleOsmosisMessage(msg: any) {
    const norm = normFromWs(msg, Date.now());
    if (!norm) return;
    this.osmoLastMsgAt = Date.now();

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
    const parsed = parseOsmosisTx(norm, { ...this.osmoCtx, priceUsd: this.quote.current(Date.now())?.usd ?? null });
    if (!parsed.flows.length && !parsed.moves.length) return;

    // Persist to D1, in one batch. A write that fails (a transient D1 error) is neither broadcast nor alerted, and it
    // stored none of the transaction's rows or, when the batch committed and its answer was lost, all of them: the
    // hash is forgotten as seen and kept for a retry, so the catch-up search reads the transaction again, from below
    // its height even when its cursor has passed it (a search that ran meanwhile skipped the hash as seen), writes
    // it if nothing of it is stored, and alerts it as found late. A parse that throws is not retried: it would throw
    // the same way again.
    if (norm.hash) this.osmoWriting.set(norm.hash, { height: norm.height, since: Date.now() });
    try {
      await this.writeOsmoTx(parsed);
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
   */
  private async writeOsmoTx(parsed: OsmoParsed) {
    const stmts = [...parsed.links.map(stmt.linkOnce), ...parsed.flows.map(stmt.flow), ...parsed.moves.map(stmt.move)];
    await runBatch(this.env.DB, stmts, Math.max(1, stmts.length));
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
   */
  private async alertFlows(flows: Flow[], threshold = Number(this.env.WHALE_OSMOSIS_NAM || 10000), minNam = 100) {
    for (const f of flows) {
      if (isNamWhale(f, threshold)) f.whale = true;
      if (offeredForAlerts(f, minNam)) {
        // valued by the row's own price only: a move found late with no quote for its minute is never valued at today's
        await sendDiscordWhaleAlert(
          this.env.DISCORD_WEBHOOK_URL,
          f,
          null,
          this.env.DB,
          threshold,
        );
      }
    }
  }

  /** A block the scan could not read as a block, or a gap it jumped: recorded for the health view (kv `namada.scan`). */
  private async noteScanFailure(height: number, note: string) {
    const status = (await kvGetJson<LiveScanStatus>(this.env.DB, 'namada.scan').catch(() => null)) ?? { failures: [] };
    status.failures = [...status.failures, { height, at: Date.now(), note: note.slice(0, 300) }].slice(-20);
    await kvSet(this.env.DB, 'namada.scan', status).catch(() => {});
  }

  /**
   * A head the scan cannot follow, or nodes that disagree on it, recorded as noteScanFailure records a block: the
   * same kind at most every HEAD_NOTE_EVERY_MS, so a node down for an hour leaves a few notes, not one every tick
   * pushing the notes of skipped blocks out of the list.
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

    try {
      if (stale) {
        console.error(`LiveHub alarm: the run started ${new Date(stale.since).toISOString()} never ended; this one takes over`);
        await this.noteScanFailure(this.namadaHeight, `the live scan's alarm of ${new Date(stale.since).toISOString()} never ended; the next one took over after ${ALARM_LEASE_MS / 60_000} min`);
      }
      // 1. The Namada scan. Whatever happens to it (both nodes down, a D1 error), the Osmosis side below still runs:
      //    one chain's outage is never the other's.
      try {
        await this.scanNamada(scanEnd.signal);
      } catch (err) {
        console.error('Namada scan:', err);
      }

      // The quote for new moves (at most one ask of the quote service every 30 s; else the cron's stored minute)
      await this.refreshQuote();

      // Ensure Osmosis WS stays active
      this.ensureOsmosisWs();

      // The Osmosis index's own state for the coverage stamps, and the catch-up search for what the stream missed.
      const t = Date.now();
      if (t - this.lastLiveReport >= OSMOSIS_LIVE_EVERY_MS) {
        this.lastLiveReport = t;
        await kvSet(this.env.DB, 'osmosis.live', { connected: !!this.osmoWs, since: this.osmoSince, lastMsgAt: this.osmoLastMsgAt, height: this.osmoHeight || null }).catch(() => {});
      }
      // A search that would start after the deadline waits for the next alarm, still due.
      if (!deadline.signal.aborted && (this.needSweep || t - this.lastSweep >= OSMOSIS_SWEEP_EVERY_MS)) {
        this.lastSweep = t;
        this.needSweep = false;
        await this.sweepOsmosis(deadline.signal).catch((e) => console.error('Osmosis catch-up search:', e));
      }
    } catch (err) {
      console.error('LiveHub alarm error:', err);
    } finally {
      clearTimeout(timer);
      clearTimeout(scanTimer);
      // A run taken over after ALARM_LEASE_MS that ends later leaves the newer run's mark alone.
      if (this.alarmRun === run) this.alarmRun = null;
      // Reschedule alarm every 6 seconds
      await this.ctx.storage.setAlarm(Date.now() + 6000);
    }
  }

  /**
   * One pass over the Namada blocks since the cursor. A block whose time, events or unbonds' tx bytes cannot be
   * fetched this tick, or whose rows cannot be written, is left for the next tick: the cursor never passes it. A block
   * this parser cannot read as a block (a shape it does not know) is recorded as not scanned (kv `namada.scan`), since
   * a retry would only stall the scan; so is a gap the scan jumps when it has fallen more than SCAN_MAX_LAG blocks
   * behind, and a cursor found above the head, which the scan moves back below it. Only a head two nodes agree on
   * (chainHead `byNodes`) does either: otherwise the scan goes on at most SCAN_MAX_LAG blocks a tick from its cursor,
   * never past where the chain can have gone since the last agreed head (headBound), and a cursor above the head
   * waits.
   * Alerts go out after the cursor is written, so a slow webhook can hold up alerts, never the scan. `signal`: the
   * alarm's deadline (ALARM_DEADLINE_MS); the blocks after it wait for the next alarm, as a block that cannot be
   * fetched does.
   */
  private async scanNamada(signal?: AbortSignal) {
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
    // chain passed it: the scan restarts SCAN_MAX_LAG blocks below the head, as after a jump, and says so. The blocks
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
    // The last block this tick reads: the head, or on a head two nodes do not agree on SCAN_MAX_LAG blocks on from the
    // cursor, so one node's word (with or without the indexer's) never makes the scan skip blocks. A re-read goes on
    // SCAN_MAX_LAG a tick from its own nodes and jumps none of them.
    let upTo = head;
    if (this.reread) {
      read.rpcs = this.reread.rpcs;
      upTo = Math.min(head, this.reread.to, lastScanned + SCAN_MAX_LAG);
    } else if (lastScanned < head - SCAN_MAX_LAG) {
      if (at.byNodes) {
        await this.noteScanFailure(lastScanned + 1, `blocks ${lastScanned + 1} to ${head - SCAN_MAX_LAG} not scanned: the scan had fallen more than ${SCAN_MAX_LAG} blocks behind`);
        lastScanned = head - SCAN_MAX_LAG;
      } else upTo = lastScanned + SCAN_MAX_LAG;
    }
    if (upTo <= lastScanned) return;

    // Real block times (max 20 per call). A block whose time cannot be fetched is not processed this tick
    // (the cursor stays below it and the next alarm retries): rows never carry an import-time timestamp.
    const times = new Map<number, number>();
    for (let lo = lastScanned + 1; lo <= upTo; lo += 20) {
      try { for (const m of await blockMetas(lo, Math.min(upTo, lo + 19), read)) times.set(m.height, m.ts); } catch {}
    }
    let done = lastScanned;
    const toAlert: Flow[] = [];
    for (let h = lastScanned + 1; h <= upTo; h++) {
      if (signal?.aborted) break;
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
      if (blk.events && blk.events.length > 0) {
        try {
          priceUsd = await this.quote.at(blk.ts, Date.now());
        } catch (e) {
          console.error(`Namada block ${h}: its minute's stored quote could not be read; retrying next tick:`, e);
          break;
        }
      }
      let retryBlock = false;
      try {
        if (blk.events && blk.events.length > 0) {
          let parsed = parseNamadaBlock(blk, priceUsd);
          // The shielded pool's fee is tied to the account that paid gas only when the wrapper names it (no event
          // does): the block's tx bytes are fetched only for a block whose pool fee the events alone had to read.
          // Bytes no node gives leave that reading (parse/namada.ts namFlows says what it cannot tell): a fee is never
          // worth holding up the scan. A read the alarm's own deadline cut says nothing of the nodes: the block, none
          // of it written yet, waits for the next alarm and is read whole then.
          if (parsed.feePayerWanted.length) {
            try {
              parsed = parseNamadaBlock(blk, priceUsd, feePayersOf(await blockTxs(h, read)));
            } catch (e) {
              if (signal?.aborted) retryBlock = true;
              else console.error(`Namada block ${h}: tx bytes unavailable, the shielded pool's fee read from the events alone:`, e);
            }
          }
          // PoS unbond requests move no tokens: decode them from the block's tx bytes (only when a
          // tx/applied result touched an unbond key, so most blocks cost no extra RPC call).
          if (!retryBlock && blockHasUnbond(blk)) {
            try {
              parsed.flows.push(...(await this.liveUnbonds(blk, read, priceUsd)));
            } catch (e) {
              // Nothing of this block has been written yet: leave the cursor below it and retry next tick.
              console.error(`Namada block ${h}: tx bytes unavailable, retrying next tick:`, e);
              retryBlock = true;
            }
          }
          if (!retryBlock && (parsed.flows.length > 0 || parsed.balances.length > 0)) {
            const now = Date.now();
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
              toAlert.push(...parsed.flows);
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
    }
    if (done > lastScanned) await kvSet(this.env.DB, 'namada.cursor', String(done));
    // What the scan read while the head was agreed on (lastAgreed.read): blocks up to it are not read again.
    if (at.agreed && this.lastAgreed) this.lastAgreed.read = done;
    if (toAlert.length) await this.alertFlows(toAlert, Number(this.env.WHALE_NAMADA_NAM || 10000), 10).catch((e) => console.error('Namada alerts:', e));
  }

  /**
   * Unbond flows for a block whose tx/applied results touched a PoS unbond key. Fetches the block's tx bytes and
   * decodes them; the outcome (decoded / skipped / undecoded / fetch failure) is kept in kv `namada.unbonds.live`
   * so the cron health view can show it. A failure throws so the block is logged, never silently half-written.
   */
  private async liveUnbonds(blk: NamadaBlock, read: ReadOpts, priceUsd: number | null) {
    const status = (await kvGetJson<LiveUnbondStatus>(this.env.DB, 'namada.unbonds.live')) ?? { decoded: 0, failures: [] };
    try {
      const txs = await blockTxs(blk.height, read);
      const p = parseNamadaUnbonds(blk, txs, priceUsd);
      status.decoded += p.flows.length;
      status.lastHeight = blk.height;
      status.lastAt = Date.now();
      if (p.undecoded.length) {
        for (const u of p.undecoded) console.error(`Namada block ${blk.height}: unbond ${u.innerHash} not decoded: ${u.reason}`);
        status.failures.push({ height: blk.height, at: Date.now(), note: p.undecoded.map((u) => `${u.innerHash.slice(0, 8)}: ${u.reason}`).join(' | ').slice(0, 300) });
      }
      return p.flows;
    } catch (e) {
      // A read the alarm's own deadline cut is not a failed read: the block is held and decoded by the next alarm.
      if (!read.signal?.aborted) status.failures.push({ height: blk.height, at: Date.now(), note: String(e).slice(0, 300) });
      throw e;
    } finally {
      status.failures = status.failures.slice(-20);
      await kvSet(this.env.DB, 'namada.unbonds.live', status).catch(() => {});
    }
  }

  /**
   * The catch-up search: the stream is not a ledger (a dropped connection or a missed message loses a transaction,
   * as on 2026-10-17 a 20,000 NAM bridge send was lost). Each query is searched newest first until it reaches the
   * height already covered; transactions not yet in `flows` are parsed and written with their block time, and those
   * whose write threw (osmoRetryTx) are alerted even when that write stored them. The cursor moves to the head read
   * at the start only when every query answered, and to just below a stream transaction still being written or
   * retried. A query with more than OSMOSIS_SWEEP_PAGES pages above the cursor is read on by the next search from
   * where this one stopped (the cursor's `resume`), so a backlog of any size is read through over several searches.
   * `signal`: the alarm's deadline (ALARM_DEADLINE_MS); a search it
   * ends is not complete, and the transactions it did not reach are read by the next one.
   * The pages it keeps transactions of share OSMOSIS_SWEEP_MAX_BYTES: a search that reaches it is not complete. A page
   * past the cap on every node is the same chain data on both: it is read again in pages of 10, and one of those past
   * it in pages of 1; a single transaction past it is skipped and named in the cursor (`skipped`), so the query still
   * answers and the search can finish.
   */
  private async sweepOsmosis(signal?: AbortSignal) {
    const prev = await kvGetJson<OsmosisCursor>(this.env.DB, 'osmosis.cursor');
    const rpcs = [{ provider: 'publicnode', url: OSMOSIS.publicRpc }, ...(this.env.KEPLR_KEY ? [{ provider: 'keplr', url: OSMOSIS.keplrRpc(this.env.KEPLR_KEY) }] : [])];
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
        try { return await fetchJson<any>(`${r.url}${path}`, { timeoutMs: 25000, retries: 0, maxBytes: FETCH_TEXT_MAX_BYTES, signal, budget }); } catch (e) {
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
    const head = Number((await get('/status'))?.result?.sync_info?.latest_block_height) || 0;
    if (!head) throw new Error('no Osmosis head height');
    // A stream transaction whose write failed is read again even below the cursor (handleOsmosisMessage).
    const retryGen = this.osmoRetryGen;
    const floor = Math.min(prev?.height ?? 0, this.osmoRetryFrom != null ? this.osmoRetryFrom - 1 : Infinity);
    const found = new Map<string, any>();
    const have = new Set<string>();
    const looked = new Set<string>();
    const budget: ReadBudget = { left: OSMOSIS_SWEEP_MAX_BYTES };
    const skipped: string[] = [];
    /**
     * One read's transactions: those above the floor, up to the head, are looked at once each. One already stored
     * (and not a stream write that threw), seen by the stream, or that makes no row is let go at once (whether a
     * transaction makes a flow or a move does not depend on its time or price), and the read gives back to the budget
     * all its bytes but those of the transactions kept: only what the search will write or alert is held.
     */
    const keep = async (txs: any[], bytes: number) => {
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
        const probe = parseOsmosisTx(normFromTxSearch(t, 0), { ...this.osmoCtx, priceUsd: null });
        if (!probe.flows.length && !probe.moves.length) { this.noteRowless(hash); continue; }
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
      await keep(txs, before - budget.left);
      txs.forEach((t, i) => rows.set(String(t.hash).toUpperCase(), { h: Number(t.height), pos: (page - 1) * per + i }));
      if (txs.length) after.height = Number(txs[txs.length - 1].height);
      const hs = txs.map((t) => Number(t.height));
      return { n: txs.length, low: txs.length ? Math.min(...hs) : Infinity, high: txs.length ? Math.max(...hs) : -Infinity };
    };
    /**
     * One query, newest first, at most OSMOSIS_SWEEP_PAGES pages: down to the floor or, with the place the last search
     * left (`old`), down to its top and then on from the page its last transaction should be on, counted from the
     * newest with what came since. That page is taken only when it holds that transaction or its newest transaction is
     * above that one's height, so nothing after the place is passed over (a node a little behind answers the pages a
     * little lower); else the page before it is read. `rows`: the transactions read from the newest down and from the
     * page taken on. `done`: the query was read down to the floor. `old`: the place gone on from, whose transactions
     * lie between those read from the newest and those read from the page taken (null when it was not gone on from).
     * `stand`: the answers did not reach the place, which stands as it was.
     */
    const walk = async (q: string, old: OsmosisResume | null, rows: Map<string, Row>): Promise<{ done: boolean; old: OsmosisResume | null; stand?: boolean }> => {
      const after = { height: null as number | null };
      let pages = 0, page = 0;
      const read = (p: number, into = rows) => { pages++; return search(q, p, 50, after, into); };
      // Without a previous cursor one page is enough to start from.
      if (!floor) { await read(1); return { done: true, old: null }; }
      const stop = old ? old.top : floor;
      for (;;) {
        if (pages >= OSMOSIS_SWEEP_PAGES) return { done: false, old: null };
        const r = await read(++page);
        if (r.low <= floor) return { done: true, old: null };
        if (r.low <= stop) break;
        // The end of the query: it is read down to the floor, or a node that does not have the place's transactions
        // answered (the place stands for the next search).
        if (r.n < 50) return old && old.n > 0 ? { done: false, old, stand: true } : { done: true, old: null };
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
      while (pages < OSMOSIS_SWEEP_PAGES) {
        const into = new Map<string, Row>();
        const r = await read(page, into);
        if (!taken) {
          if (!(into.has(old.last) || r.high > old.low)) { if (--page === fromTop + 1) taken = true; continue; }
          taken = true;
        }
        for (const [hash, x] of into) { rows.set(hash, x); if (hash === old.last || x.h < old.low) past = true; }
        if (r.low <= floor) return { done: true, old };
        if (r.n < 50) return past ? { done: true, old } : { done: false, old, stand: true };
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
      const o = prev?.resume?.[q];
      if (!o || !(Number.isFinite(o.top) && Number.isFinite(o.low) && Number.isInteger(o.n) && o.n >= 0)) return null;
      if (o.top <= floor || o.low > o.top || (o.low > floor && typeof o.last !== 'string')) return null;
      const from = o.low > floor ? o.low : floor + 1;
      return [...this.osmoRetryTx.values()].some((h) => h >= from && h <= o.top) ? null : o;
    };
    let complete = true;
    const walks = new Map<string, { done: boolean; old: OsmosisResume | null; stand?: boolean; rows: Map<string, Row> } | null>();
    for (const q of OSMOSIS_QUERIES) {
      const rows = new Map<string, Row>();
      try {
        const w = await walk(q, placeOf(q), rows);
        walks.set(q, { ...w, rows });
        if (!w.done) complete = false;
      } catch (e) {
        walks.set(q, null);
        complete = false;
        console.error(`Osmosis catch-up search "${q}":`, e);
      }
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
      // be read is left for the next search, as one without a block time is.
      let priceUsd: number | null;
      try {
        priceUsd = await this.quote.at(times.get(h)!, Date.now());
      } catch {
        complete = false;
        continue;
      }
      const parsed = parseOsmosisTx(normFromTxSearch(t, times.get(h)!), { ...this.osmoCtx, priceUsd });
      // Written below, or the search ends here (a write that throws ends it before the cursor is written).
      unwritten.delete(hash);
      if (!parsed.flows.length && !parsed.moves.length) continue;
      for (const f of parsed.flows) f.meta = { ...(f.meta ?? {}), tsSource: 'block', via: 'catch-up search' };
      if (!have.has(hash)) {
        try {
          await this.writeOsmoTx(parsed);
        } catch (e) {
          this.noteOsmoWriteFailed(hash, h);
          throw e;
        }
        added += parsed.flows.length;
      }
      this.seenOsmoTx.add(hash);
      this.osmoRetryTx.delete(hash);
      if (parsed.flows.length) this.broadcast({ type: 'flows', flows: parsed.flows });
      // Owner decision 14: a move the live stream missed still alerts, marked as found late (discord.ts), unless
      // it is older than LATE_ALERT_MAX_AGE_MS, so a long outage does not flood the channels with old news.
      const recent = parsed.flows.filter((f) => Date.now() - f.ts <= LATE_ALERT_MAX_AGE_MS);
      if (recent.length) await this.alertFlows(recent).catch((e) => console.error('late alert:', e));
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
    // Where each query is left when the cursor stays: down to the last transaction read before one not written yet (no
    // block time, no quote, the deadline), and never past one. The rows are taken in the order read, which is the
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
    if (!complete) {
      for (const [q, w] of walks) {
        const carried = prev?.resume?.[q];
        if (!w) { if (carried) resume[q] = carried; continue; }
        const old = w.old;
        if (w.stand && old) { resume[q] = old; continue; }
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
        // Read down to the floor: the next search reads it down to this head only (none read: it reads one page).
        if (w.done && !cut) { if (list.some(inRange)) resume[q] = { top: head, low: floor, n: 0 }; continue; }
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
    const next: OsmosisCursor = complete
      ? { height: upTo, at: Date.now(), added, ...kept }
      : {
          height: prev?.height ?? 0, at: prev?.at ?? 0, added, ...kept,
          error: behind ? 'The last catch-up search did not finish; the next one goes on from where it stopped.' : 'The last catch-up search did not finish; it is retried.',
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
        this.sessions.delete(ws);
      }
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
      // A request without the header (a local run, a direct origin call) shares one bucket rather than none.
      const ip = request.headers.get('cf-connecting-ip') || 'unknown';
      const sameIp = [...this.sessions].filter((s) => this.ips.get(s) === ip).length;
      const verdict = admitSocket(this.sessions.size, sameIp);
      if (verdict === 'full') return new Response('The live feed is full right now; try again in a minute.', { status: 503, headers: { 'retry-after': '60' } });
      if (verdict === 'ip') return new Response('Too many live connections from your address.', { status: 429, headers: { 'retry-after': '60' } });
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];

      server.accept();
      this.sessions.add(server);
      this.ips.set(server, ip);

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
        this.sessions.delete(server);
        try { server.close(1008, 'the feed is one way'); } catch {}
      });

      server.addEventListener('close', () => {
        this.sessions.delete(server);
      });
      server.addEventListener('error', () => {
        this.sessions.delete(server);
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('Not found', { status: 404 });
  }
}
