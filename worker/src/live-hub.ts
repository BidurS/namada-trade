import { DurableObject } from 'cloudflare:workers';
import type { Env } from './util';
import type { LiveMessage, Flow } from '../../shared/types';
import { OSMOSIS, NAM, NAMADA } from './config';
import { normFromWs, normFromTxSearch, parseOsmosisTx, type OsmoCtx } from './parse/osmosis';
import { parseNamadaBlock } from './parse/namada';
import { blockHasUnbond, parseNamadaUnbonds } from './parse/namada-unbond';
import { blockMetas, blockResults, blockTxs, namadaStatusAny, RpcBreaker, LIVE_READ, type ReadOpts } from './sources/namada';
import type { NamadaBlock } from './parse/namada';
import { runBatch, stmt, kvGet, kvGetJson, kvSet } from './db';
import { admitSocket } from './ws-admit';
import { fetchNamPools, fetchNamPrice } from './sources/sqs';
import { configureAlerts, sendDiscordWhaleAlert } from './sources/discord';
import { fetchJson } from './util';

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
/** Pages of 50 per query and sweep, newest first (the search cannot take a height range on the public node). */
export const OSMOSIS_SWEEP_PAGES = 4;

/** kv `osmosis.cursor`: every Osmosis transaction matching the queries up to `height` has been looked at. */
export interface OsmosisCursor { height: number; at: number; added?: number; error?: string }

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

export class LiveHub extends DurableObject<Env> {
  private sessions = new Set<WebSocket>();
  /** The client address each socket came from (ws-admit.ts caps per address). */
  private ips = new WeakMap<WebSocket, string>();
  private osmoWs: WebSocket | null = null;
  private isConnectingOsmo = false;
  private isPollingNamada = false;
  private seenOsmoTx = new Set<string>();
  private osmoHeight = 0;
  private namadaHeight = 0;
  private osmoSince: number | null = null;
  private osmoLastMsgAt: number | null = null;
  private lastLiveReport = 0;
  private lastSweep = 0;
  private needSweep = true;
  private lastPriceUsd: number | null = null;
  private osmoCtx: OsmoCtx = {
    poolAddrs: new Map(),
    priceUsd: null,
    assets: new Map([
      [OSMOSIS.usdcDenom, { symbol: 'USDC', decimals: 6, stable: true }],
      ['uosmo', { symbol: 'OSMO', decimals: 6 }],
    ]),
  };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    configureAlerts(env.SETTINGS_KEY);
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
      const { usd } = await fetchNamPrice();
      if (usd) {
        this.lastPriceUsd = usd;
        this.osmoCtx.priceUsd = usd;
      }
    } catch (e) {
      console.error('refreshContext error:', e);
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

    // Deduplicate multiple WS subscription matches for the same Osmosis tx hash
    if (norm.hash) {
      if (this.seenOsmoTx.has(norm.hash)) return;
      this.seenOsmoTx.add(norm.hash);
      if (this.seenOsmoTx.size > 1000) {
        const oldest = this.seenOsmoTx.values().next().value;
        if (oldest) this.seenOsmoTx.delete(oldest);
      }
    }

    if (norm.height > this.osmoHeight) this.osmoHeight = norm.height;

    const parsed = parseOsmosisTx(norm, this.osmoCtx);
    if (!parsed.flows.length && !parsed.moves.length) return;

    // Persist to D1
    const stmts = [
      ...parsed.flows.map(stmt.flow),
      ...parsed.moves.map(stmt.move),
      ...parsed.links.map(stmt.link),
    ];
    await runBatch(this.env.DB, stmts);

    // Broadcast to UI
    this.broadcast({ type: 'flows', flows: parsed.flows });

    await this.alertFlows(parsed.flows);
  }

  /**
   * Discord alerts for whale movements (>= 10k NAM) and user watchlist/MASP webhooks. The same path serves the
   * live stream, the catch-up search and the Namada scan; sendDiscordWhaleAlert claims a key per flow and per
   * transaction, so a move is never posted twice. `minNam`: the size from which a move is offered to the per-user
   * rules at all (100 on Osmosis, 10 on Namada); shielded moves always are.
   */
  private async alertFlows(flows: Flow[], threshold = Number(this.env.WHALE_OSMOSIS_NAM || 10000), minNam = 100) {
    for (const f of flows) {
      if (f.amount >= threshold) f.whale = true;
      if (f.amount >= minNam || f.kind === 'shield' || f.kind === 'unshield') {
        await sendDiscordWhaleAlert(
          this.env.DISCORD_WEBHOOK_URL,
          f,
          this.lastPriceUsd,
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

  async alarm() {
    if (this.isPollingNamada) {
      await this.ctx.storage.setAlarm(Date.now() + 6000);
      return;
    }
    this.isPollingNamada = true;

    try {
      // 1. The Namada scan. Whatever happens to it (both nodes down, a D1 error), the Osmosis side below still runs:
      //    one chain's outage is never the other's.
      try {
        await this.scanNamada();
      } catch (err) {
        console.error('Namada scan:', err);
      }

      // Check price update
      const { usd } = await fetchNamPrice();
      if (usd && usd !== this.lastPriceUsd) {
        this.lastPriceUsd = usd;
        this.osmoCtx.priceUsd = usd;
        this.broadcast({ type: 'price', usd, at: Date.now() });
      }

      // Ensure Osmosis WS stays active
      this.ensureOsmosisWs();

      // The Osmosis index's own state for the coverage stamps, and the catch-up search for what the stream missed.
      const t = Date.now();
      if (t - this.lastLiveReport >= OSMOSIS_LIVE_EVERY_MS) {
        this.lastLiveReport = t;
        await kvSet(this.env.DB, 'osmosis.live', { connected: !!this.osmoWs, since: this.osmoSince, lastMsgAt: this.osmoLastMsgAt, height: this.osmoHeight || null }).catch(() => {});
      }
      if (this.needSweep || t - this.lastSweep >= OSMOSIS_SWEEP_EVERY_MS) {
        this.lastSweep = t;
        this.needSweep = false;
        await this.sweepOsmosis().catch((e) => console.error('Osmosis catch-up search:', e));
      }
    } catch (err) {
      console.error('LiveHub alarm error:', err);
    } finally {
      this.isPollingNamada = false;
      // Reschedule alarm every 6 seconds
      await this.ctx.storage.setAlarm(Date.now() + 6000);
    }
  }

  /**
   * One pass over the Namada blocks since the cursor. A block whose time, events or tx bytes cannot be fetched this
   * tick, or whose rows cannot be written, is left for the next tick: the cursor never passes it. A block this parser
   * cannot read as a block (a shape it does not know) is recorded as not scanned (kv `namada.scan`), since a retry
   * would only stall the scan; so is a gap the scan jumps when it has fallen more than SCAN_MAX_LAG blocks behind.
   * Alerts go out after the cursor is written, so a slow webhook can hold up alerts, never the scan.
   */
  private async scanNamada() {
    // One short attempt per node, the nodes that failed this tick asked last (as the cron does).
    const read: ReadOpts = { ...LIVE_READ, breaker: new RpcBreaker() };
    const head = (await namadaStatusAny(read)).height;
    let lastScanned = Number(await kvGet(this.env.DB, 'namada.cursor')) || head - 1;
    if (lastScanned < head - SCAN_MAX_LAG) {
      await this.noteScanFailure(lastScanned + 1, `blocks ${lastScanned + 1} to ${head - SCAN_MAX_LAG} not scanned: the scan had fallen more than ${SCAN_MAX_LAG} blocks behind`);
      lastScanned = head - SCAN_MAX_LAG;
    }
    if (head <= lastScanned) return;

    // Real block times (max 20 per call). A block whose time cannot be fetched is not processed this tick
    // (the cursor stays below it and the next alarm retries): rows never carry an import-time timestamp.
    const times = new Map<number, number>();
    for (let lo = lastScanned + 1; lo <= head; lo += 20) {
      try { for (const m of await blockMetas(lo, Math.min(head, lo + 19), read)) times.set(m.height, m.ts); } catch {}
    }
    let done = lastScanned;
    const toAlert: Flow[] = [];
    for (let h = lastScanned + 1; h <= head; h++) {
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
      let retryBlock = false;
      try {
        if (blk.events && blk.events.length > 0) {
          const parsed = parseNamadaBlock(blk, this.lastPriceUsd);
          // PoS unbond requests move no tokens: decode them from the block's tx bytes (only when a
          // tx/applied result touched an unbond key, so most blocks cost no extra RPC call).
          if (blockHasUnbond(blk)) {
            try {
              parsed.flows.push(...(await this.liveUnbonds(blk, read)));
            } catch (e) {
              // Nothing of this block has been written yet: leave the cursor below it and retry next tick.
              console.error(`Namada block ${h}: tx bytes unavailable, retrying next tick:`, e);
              retryBlock = true;
            }
          }
          if (!retryBlock && (parsed.flows.length > 0 || parsed.balances.length > 0)) {
            const now = Date.now();
            const stmts = [
              ...parsed.flows.map(stmt.flow),
              ...parsed.moves.map(stmt.move),
              ...parsed.balances.map((b) => stmt.namadaBalance(b, now)),
              ...parsed.links.map(stmt.link),
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
    if (toAlert.length) await this.alertFlows(toAlert, Number(this.env.WHALE_NAMADA_NAM || 10000), 10).catch((e) => console.error('Namada alerts:', e));
  }

  /**
   * Unbond flows for a block whose tx/applied results touched a PoS unbond key. Fetches the block's tx bytes and
   * decodes them; the outcome (decoded / skipped / undecoded / fetch failure) is kept in kv `namada.unbonds.live`
   * so the cron health view can show it. A failure throws so the block is logged, never silently half-written.
   */
  private async liveUnbonds(blk: NamadaBlock, read: ReadOpts) {
    const status = (await kvGetJson<LiveUnbondStatus>(this.env.DB, 'namada.unbonds.live')) ?? { decoded: 0, failures: [] };
    try {
      const txs = await blockTxs(blk.height, read);
      const p = parseNamadaUnbonds(blk, txs, this.lastPriceUsd);
      status.decoded += p.flows.length;
      status.lastHeight = blk.height;
      status.lastAt = Date.now();
      if (p.undecoded.length) {
        for (const u of p.undecoded) console.error(`Namada block ${blk.height}: unbond ${u.innerHash} not decoded: ${u.reason}`);
        status.failures.push({ height: blk.height, at: Date.now(), note: p.undecoded.map((u) => `${u.innerHash.slice(0, 8)}: ${u.reason}`).join(' | ').slice(0, 300) });
      }
      return p.flows;
    } catch (e) {
      status.failures.push({ height: blk.height, at: Date.now(), note: String(e).slice(0, 300) });
      throw e;
    } finally {
      status.failures = status.failures.slice(-20);
      await kvSet(this.env.DB, 'namada.unbonds.live', status).catch(() => {});
    }
  }

  /**
   * The catch-up search: the stream is not a ledger (a dropped connection or a missed message loses a transaction,
   * as on 2026-10-17 a 20,000 NAM bridge send was lost). Each query is searched newest first until it reaches the
   * height already covered; transactions not yet in `flows` are parsed and written with their block time. The
   * cursor moves to the head read at the start only when every query answered.
   */
  private async sweepOsmosis() {
    const prev = await kvGetJson<OsmosisCursor>(this.env.DB, 'osmosis.cursor');
    const rpcs = [OSMOSIS.publicRpc, ...(this.env.KEPLR_KEY ? [OSMOSIS.keplrRpc(this.env.KEPLR_KEY)] : [])];
    const get = async (path: string) => {
      let last: unknown;
      for (const r of rpcs) { try { return await fetchJson<any>(`${r}${path}`, { timeoutMs: 25000, retries: 0 }); } catch (e) { last = e; } }
      throw last;
    };
    const head = Number((await get('/status'))?.result?.sync_info?.latest_block_height) || 0;
    if (!head) throw new Error('no Osmosis head height');
    const floor = prev?.height ?? 0;
    const found = new Map<string, any>();
    let complete = true;
    for (const q of OSMOSIS_QUERIES) {
      try {
        for (let page = 1; page <= OSMOSIS_SWEEP_PAGES; page++) {
          const r = await get(`/tx_search?query=${encodeURIComponent(`"${q}"`)}&page=${page}&per_page=50&order_by=%22desc%22`);
          const txs: any[] = r?.result?.txs ?? [];
          for (const t of txs) if (Number(t.height) > floor && Number(t.height) <= head) found.set(String(t.hash).toUpperCase(), t);
          const low = txs.length ? Math.min(...txs.map((t) => Number(t.height))) : 0;
          if (txs.length < 50 || low <= floor) break;
          // Without a previous cursor one page is enough to start from; a gap longer than the pages is reported.
          if (!floor) break;
          if (page === OSMOSIS_SWEEP_PAGES) complete = false;
        }
      } catch (e) {
        complete = false;
        console.error(`Osmosis catch-up search "${q}":`, e);
      }
    }
    let added = 0;
    const hashes = [...found.keys()];
    const have = new Set<string>();
    for (let i = 0; i < hashes.length; i += 90) {
      const part = hashes.slice(i, i + 90);
      const r = await this.env.DB.prepare(`SELECT DISTINCT tx_hash FROM flows WHERE chain='osmosis' AND tx_hash IN (${part.map(() => '?').join(',')})`).bind(...part).all<{ tx_hash: string }>();
      for (const x of r.results || []) have.add(x.tx_hash);
    }
    const times = new Map<number, number>();
    for (const [hash, t] of found) {
      if (have.has(hash) || this.seenOsmoTx.has(hash)) continue;
      const h = Number(t.height);
      if (!times.has(h)) {
        const b = await get(`/block?height=${h}`).catch(() => null);
        const ts = Date.parse(b?.result?.block?.header?.time ?? '');
        if (!Number.isFinite(ts)) { complete = false; continue; } // no block time: never written with a made-up one
        times.set(h, ts);
      }
      const parsed = parseOsmosisTx(normFromTxSearch(t, times.get(h)!), this.osmoCtx);
      if (!parsed.flows.length && !parsed.moves.length) continue;
      for (const f of parsed.flows) f.meta = { ...(f.meta ?? {}), tsSource: 'block', via: 'catch-up search' };
      await runBatch(this.env.DB, [...parsed.flows.map(stmt.flow), ...parsed.moves.map(stmt.move), ...parsed.links.map(stmt.link)]);
      this.seenOsmoTx.add(hash);
      added += parsed.flows.length;
      if (parsed.flows.length) this.broadcast({ type: 'flows', flows: parsed.flows });
      // Owner decision 14: a move the live stream missed still alerts, marked as found late (discord.ts), unless
      // it is older than LATE_ALERT_MAX_AGE_MS, so a long outage does not flood the channels with old news.
      const recent = parsed.flows.filter((f) => Date.now() - f.ts <= LATE_ALERT_MAX_AGE_MS);
      if (recent.length) await this.alertFlows(recent).catch((e) => console.error('late alert:', e));
    }
    if (head > this.osmoHeight) this.osmoHeight = head;
    const next: OsmosisCursor = complete
      ? { height: head, at: Date.now(), added }
      : { height: prev?.height ?? 0, at: prev?.at ?? 0, added, error: 'The last catch-up search did not finish; it is retried.' };
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
      const ip = request.headers.get('cf-connecting-ip');
      const sameIp = ip ? [...this.sessions].filter((s) => this.ips.get(s) === ip).length : 0;
      const verdict = admitSocket(this.sessions.size, sameIp);
      if (verdict === 'full') return new Response('The live feed is full right now; try again in a minute.', { status: 503, headers: { 'retry-after': '60' } });
      if (verdict === 'ip') return new Response('Too many live connections from your address.', { status: 429, headers: { 'retry-after': '60' } });
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];

      server.accept();
      this.sessions.add(server);
      if (ip) this.ips.set(server, ip);

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
