import type { Env } from './util';
import { runBatch, stmt, kvGet, kvSet, kvGetJson } from './db';
import { fetchOsmosisHolderList, fetchOsmosisSupplyBase, OSMOSIS_HOLDER_PAGES } from './sources/osmosis';
import { fetchNamPools, fetchNamPrice } from './sources/sqs';
import { namBalance, namBalanceQuick, namTotalSupply, namTotalStake, namadaEpoch, namadaStatusAll, delegationsAt, answeringRpcs, QUICK, RpcBreaker, validatorAddresses, delegatorsOf, type ReadOpts, type Rpc } from './sources/namada';
import { fetchIntel } from './sources/intel';
import { sendDiscordForumAlert, sendDiscordGovAlert } from './sources/discord';
import { NAM, NAMADA, OSMOSIS, IBC_STUCK } from './config';
import { fetchJson, toNam } from './util';
import type { SourceHealth } from '../../shared/types';
import type { Stmt } from './db';
import { sweepAuth } from './auth';
import { NOT_LEGACY_TWIN } from './flows-query';
import { unbondAddresses, fetchUnbonds, type UnbondWithdrawCache } from './analytics';
import { chainParams, indexState, NAMADA_CURSOR_MAX_LAG, NAMADA_CURSOR_STALE_MS, OSMOSIS_LIVE_STALE_MS, OSMOSIS_SWEEP_STALE_MS, timedOutSends, ibcRowOf } from './analytics';
import type { LiveUnbondStatus } from './live-hub';
import {
  LIQUID_DUE_SQL, LIQUID_PER_TICK, LIQUID_CONCURRENCY, LIQUID_TIME_BUDGET_MS, LIQUID_STALE_MS, INTERNAL_ADDRS,
  liquidReadStmt, osmosisDroppedStmt, spanStmts, pruneSpansStmt, chunks,
} from './holders';

const INDEXER = 'https://indexer.namada.net/api/v1';

async function syncIntelAndAlerts(env: Env) {
  try {
    const intel = await fetchIntel();

    // 1. Cache latest intel snapshot in D1 kv for instant API reads
    if (intel.topics.length > 0 || intel.proposals.length > 0) {
      await kvSet(env.DB, 'intel.cache', JSON.stringify(intel));
    }

    // 2. Check Namada Forum latest posts for new topics or replies
    if (intel.latestPosts.length > 0) {
      const maxPostId = Math.max(...intel.latestPosts.map((p) => p.id));
      const storedPostIdStr = await kvGet(env.DB, 'forum.last_post_id');

      if (!storedPostIdStr) {
        // Initialize cursor to current head so we don't spam historical posts on first boot
        await kvSet(env.DB, 'forum.last_post_id', String(maxPostId));
      } else {
        const lastPostId = Number(storedPostIdStr);
        if (maxPostId > lastPostId) {
          const newPosts = intel.latestPosts.filter((p) => p.id > lastPostId).sort((a, b) => a.id - b.id);
          for (const post of newPosts) await sendDiscordForumAlert(env.DISCORD_WEBHOOK_URL, post, env.DB);
          await kvSet(env.DB, 'forum.last_post_id', String(maxPostId));
        }
      }
    }

    // 3. Check Namada On-Chain Governance Proposals for new proposals or status changes
    if (intel.proposals.length > 0) {
      const storedGovStr = await kvGet(env.DB, 'gov.state');
      const currentState: Record<string, string> = {};
      for (const p of intel.proposals) currentState[String(p.id)] = p.status;

      if (!storedGovStr) {
        await kvSet(env.DB, 'gov.state', JSON.stringify(currentState));
      } else {
        let prevState: Record<string, string> = {};
        try { prevState = JSON.parse(storedGovStr); } catch {}

        let changed = false;
        for (const prop of [...intel.proposals].sort((a, b) => a.id - b.id)) {
          const prevStatus = prevState[String(prop.id)];
          if (!prevStatus) {
            changed = true;
            await sendDiscordGovAlert(env.DISCORD_WEBHOOK_URL, prop, true, env.DB);
            prevState[String(prop.id)] = prop.status;
          } else if (prevStatus !== prop.status) {
            changed = true;
            await sendDiscordGovAlert(env.DISCORD_WEBHOOK_URL, prop, false, env.DB);
            prevState[String(prop.id)] = prop.status;
          }
        }
        if (changed) await kvSet(env.DB, 'gov.state', JSON.stringify(prevState));
      }
  }
  } catch (err) {
    console.error('syncIntelAndAlerts error:', err);
  }
}

/** Time a source call; record ok/latency/note instead of letting a failure become a silent zero. */
async function probe<T>(health: SourceHealth[], name: string, fn: () => Promise<T>): Promise<T | null> {
  const t0 = Date.now();
  try {
    const v = await fn();
    health.push({ name, ok: true, at: Date.now(), latencyMs: Date.now() - t0 });
    return v;
  } catch (e) {
    health.push({ name, ok: false, at: Date.now(), latencyMs: Date.now() - t0, note: String(e).slice(0, 160) });
    return null;
  }
}

/** Namada addresses whose stake is read from the chain per tick, and how many at once. */
export const STAKE_PER_TICK = 120;
export const STAKE_CONCURRENCY = 6;
/** Validators whose delegations are listed per tick (staker discovery): 252 validators, a full pass about hourly. */
export const DISCOVER_PER_TICK = 4;
/**
 * One deadline for the whole tick. Cloudflare stops a scheduled run after 15 minutes and the trigger fires every
 * minute, so a tick that waits on a node that accepts requests and never answers must end well inside a minute:
 * batches are not started after this, and reads still running are aborted at it.
 */
export const TICK_DEADLINE_MS = 45_000;
/**
 * Time kept for the balance refresh (W13) at the end of the tick: stake reads stop starting this long before the
 * deadline, and the ones still running are ended then, so slow stake reads can never take the refresh's turn.
 * Enough for the refresh's 50 reads at a healthy node's speed (2 to 3 s measured) and one batch that waits out a
 * quick timeout (8 s) before the other node answers.
 */
export const REFRESH_RESERVE_MS = 12_000;
/** Keplr REST reads in a tick: a short timeout and one retry, inside the tick's deadline. */
export const KEPLR_TICK = { timeoutMs: 10_000, retries: 1 } as const;

/** A signal that ends at `endAt` or with `parent`, whichever comes first; `done` clears its timer. */
export function phaseSignal(parent: AbortSignal, endAt: number): { signal: AbortSignal; done: () => void } {
  const c = new AbortController();
  const t = setTimeout(() => c.abort('phase end'), Math.max(0, endAt - Date.now()));
  const on = () => c.abort('tick deadline');
  if (parent.aborted) c.abort('tick deadline');
  else parent.addEventListener('abort', on);
  return { signal: c.signal, done: () => { clearTimeout(t); parent.removeEventListener('abort', on); } };
}
/** A tick that finds the lock held by another, younger than this, records "skipped" and does nothing. */
export const TICK_LOCK_MS = 90_000;
/** A balance read answered at a height more than this many blocks below the node head is from a lagging node. */
export const LAGGING_BLOCKS = 5;

/** Take the tick lock (kv cron.lock) unless another tick holds it and has not expired; true when taken. */
export async function takeTickLock(db: D1Database, id: string, now: number): Promise<boolean> {
  const r = await db.prepare(`INSERT INTO kv (key, value, updated_at) VALUES ('cron.lock', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at WHERE kv.updated_at < ?`)
    .bind(id, now, now - TICK_LOCK_MS).run().catch(() => null);
  // A D1 without the kv table (or a failure) must not stop the tick: run unlocked.
  return r == null ? true : Number(r.meta?.changes ?? 0) > 0;
}
export async function releaseTickLock(db: D1Database, id: string) {
  await db.prepare(`DELETE FROM kv WHERE key = 'cron.lock' AND value = ?`).bind(id).run().catch(() => {});
}

export interface RefreshOpts {
  /** the nodes to read from this tick (status answered), in order */
  rpcs?: readonly Rpc[];
  /** the highest node height this tick: a read answered more than LAGGING_BLOCKS below it is retried on another node */
  headHeight?: number | null;
  /** the tick's deadline: no batch starts after it, and reads still running end at it */
  signal?: AbortSignal;
  deadlineAt?: number;
  /** the tick's record of nodes that failed a read (they are asked last) */
  breaker?: RpcBreaker;
}

/**
 * The health of a batch of chain reads (the stake verification, the balance refresh): ok only when something was
 * written, or nothing was due, and fewer than half of the reads that ran failed. `due` counts every address in
 * line this tick, `attempted` only the reads that ran to an answer or a failure (not those the time limit left).
 * So a tick that wrote nothing, because every read failed, every answer was refused, or the time limit left every
 * address, is not ok, and the Sources sheet shows its note.
 */
export function batchHealthOk(due: number, written: number, attempted: number, failed: number): boolean {
  return (due === 0 || written > 0) && failed < Math.max(1, attempted / 2);
}

/**
 * Re-read a rolling batch of Namada spendable balances from the chain (W13). Before this existed, an address that
 * did not move kept the balance and date of the 2026-10-15 backfill.
 *
 * Health counts what landed, not what was built: `landed` rows were written; `rejected` reads were older than the
 * row's newest post-balance (the guard in liquidReadStmt) and changed nothing; `failed` reads got no answer, no
 * height, or only a lagging node's answer. Addresses the time budget left for the next tick are not counted as
 * attempted. ok = something landed (or nothing was due) and fewer than half the attempts failed.
 */
export async function refreshLiquidBalances(
  env: Env, health: SourceHealth[], read: (owner: string, opts?: ReadOpts) => Promise<{ balance: bigint; height: number; provider: string }> = namBalanceQuick,
  opts: RefreshOpts = {},
): Promise<{ read: number; failed: number; landed: number; rejected: number }> {
  const stamp = Date.now();
  const name = 'Namada RPC (balance refresh)';
  let due: { address: string }[];
  try {
    due = (await env.DB.prepare(LIQUID_DUE_SQL).bind(stamp - LIQUID_STALE_MS, LIQUID_PER_TICK).all<{ address: string }>()).results || [];
  } catch (e) {
    health.push({ name, ok: false, at: stamp, note: `The list of balances to re-read could not be loaded: ${String(e).slice(0, 120)}` });
    return { read: 0, failed: 0, landed: 0, rejected: 0 };
  }
  const list = due.map((r) => r.address).filter((a) => !INTERNAL_ADDRS.includes(a));
  const rpcs = opts.rpcs;
  const minHeight = opts.headHeight ? opts.headHeight - LAGGING_BLOCKS : 0;
  const stmts: Stmt[] = [];
  let failed = 0, lagging = 0, attempted = 0;
  const readOne = async (a: string) => {
    const base: ReadOpts = { ...(rpcs ? { rpcs } : {}), ...(opts.signal ? { signal: opts.signal } : {}), ...(opts.breaker ? { breaker: opts.breaker } : {}) };
    let r = await read(a, base).catch(() => null);
    // A node stuck at an older height still answers, so it would never fail over by itself: ask the others.
    if (r && minHeight > 0 && r.height > 0 && r.height < minHeight) {
      const others = (rpcs ?? []).filter((x) => x.provider !== r!.provider);
      const again = others.length ? await read(a, { ...base, rpcs: others }).catch(() => null) : null;
      if (again && again.height >= minHeight) r = again;
      else { lagging++; return null; }
    }
    return r;
  };
  const budgetEnd = Math.min(stamp + LIQUID_TIME_BUDGET_MS, opts.deadlineAt ?? Infinity);
  for (let i = 0; i < list.length && Date.now() < budgetEnd && !opts.signal?.aborted; i += LIQUID_CONCURRENCY) {
    const part = list.slice(i, i + LIQUID_CONCURRENCY);
    attempted += part.length;
    const batch = await Promise.all(part.map((a) => readOne(a).then((r) => ({ a, r }))));
    for (const x of batch) {
      // A read without a block height cannot be ordered against the LiveHub's post-balances: not used.
      if (x.r && x.r.height > 0) stmts.push(liquidReadStmt('namada', x.a, x.r.balance.toString(), x.r.height, stamp, x.r.provider));
      else failed++;
    }
  }
  let landed = 0;
  if (stmts.length) {
    landed = await runBatch(env.DB, stmts);
    // A separate batch: if the spans table is missing (migration not applied yet) the balances still land.
    const readAddrs = stmts.map((s) => s.params[1] as string);
    await runBatch(env.DB, chunks(readAddrs, 10).flatMap((part) => spanStmts('namada', stamp, part))).catch((e) => console.error('namada balance spans', e));
  }
  const rejected = stmts.length - landed;
  const skipped = list.length - attempted;
  const ok = batchHealthOk(list.length, landed, attempted, failed);
  const parts = [
    `${landed} spendable balances read from the chain and written this tick`,
    rejected > 0 ? `${rejected} reads older than a transfer already recorded (not written)` : '',
    failed > 0 ? `${failed} failed${lagging ? ` (${lagging} only from a node behind the chain)` : ''}` : '',
    skipped > 0 ? `${skipped} left for the next tick (time budget)` : '',
  ].filter(Boolean);
  health.push({ name, ok, at: stamp, note: parts.join(', ') });
  return { read: stmts.length, failed, landed, rejected };
}

/**
 * Osmosis holder list → rows. Only a list the bank said was complete, and whose balances add up to the bank's own
 * supply of NAM there (within 0.5%, as transfers can land between page reads), may zero holders missing from it.
 */
export function osmosisListCheck(holders: { balance: string }[], complete: boolean, supplyBase: bigint | null, capped = false): { trust: boolean; note: string } {
  const sum = holders.reduce((a, h) => a + BigInt(h.balance || '0'), 0n);
  if (!complete) return { trust: false, note: capped
    ? `${holders.length} holders read and the page cap was reached, so rows past it are not refreshed and missing holders are not zeroed`
    : `${holders.length} holders read, but a page came back without the bank's page information, so missing holders are not zeroed` };
  if (supplyBase == null || supplyBase <= 0n) return { trust: false, note: `${holders.length} holders read; the supply could not be read to check the list, so missing holders are not zeroed` };
  const diff = sum > supplyBase ? sum - supplyBase : supplyBase - sum;
  const pct = Number((diff * 1_000_000n) / supplyBase) / 10_000;
  return pct <= 0.5
    ? { trust: true, note: `${holders.length} holders, adding up to the supply within ${pct.toFixed(3)}%` }
    : { trust: false, note: `${holders.length} holders add up to ${pct.toFixed(2)}% away from the supply, so missing holders are not zeroed` };
}

/**
 * Bridge crossings recorded on one chain and not on the other: each Namada bridge row (to or from an osmo1 address)
 * should have the Osmosis record of the same transfer (same addresses and amount within 15 minutes), and the other
 * way round. Rows younger than 30 minutes are not judged (relayers can be slow). Refunded sends are left out.
 */
export function unpairedCrossings(namada: any[], osmosis: any[], now: number): { namadaOnly: any[]; osmosisOnly: any[] } {
  const W = 15 * 60000, SETTLE = 30 * 60000;
  const used = new Set<any>();
  const namadaOnly: any[] = [];
  // Older Namada rows name the bridge escrow instead of the Osmosis address, and a shielded withdrawal leaves the
  // pool on Namada but is sent from a one-time transparent address on the packet: then the other address, the
  // amount and the time have to do.
  const same = (a: string | null, b: string | null) => a === b || a === NAMADA.internal.ibc || (a === NAMADA.internal.masp && !!b?.startsWith('tnam1'));
  for (const n of namada) {
    const want = n.kind === 'ibc_in' ? 'ibc_out' : 'ibc_in';
    const m = osmosis.find((o) => !used.has(o) && o.kind === want && same(n.from_addr, o.from_addr) && same(n.to_addr, o.to_addr) && Math.abs(o.amount_num - n.amount_num) < 1e-6 && Math.abs(o.ts - n.ts) <= W);
    if (m) used.add(m);
    else if (now - n.ts > SETTLE) namadaOnly.push(n);
  }
  const osmosisOnly = osmosis.filter((o) => !used.has(o) && now - o.ts > SETTLE);
  return { namadaOnly, osmosisOnly };
}

export async function runCron(env: Env) {
  const now = Date.now();
  const health: SourceHealth[] = [];
  const lockId = `${now}-${Math.random().toString(36).slice(2, 8)}`;
  console.log('cron tick', new Date(now).toISOString());
  if (!(await takeTickLock(env.DB, lockId, now))) {
    // Another tick is still running (a slow node): this one does nothing rather than repeat the same reads.
    await mergeHealth(env, [{ name: 'cron', ok: true, at: now, note: 'Skipped: the previous run was still going.' }]);
    return;
  }
  const deadline = new AbortController();
  const deadlineAt = now + TICK_DEADLINE_MS;
  const timer = setTimeout(() => deadline.abort('tick deadline'), TICK_DEADLINE_MS);
  const signal = deadline.signal;
  const late = () => Date.now() >= deadlineAt || signal.aborted;
  // Nodes that fail a read this tick are asked last for the rest of it (a node can answer its status and hang on
  // every query, which the status check cannot see).
  const breaker = new RpcBreaker();

  // 0. Forum and governance alerts run beside the chain reads (they need nothing from them), so a slow chain node
  //    cannot hold them up and they cannot delay the chain reads; expired sign-in records are swept first.
  const intel = syncIntelAndAlerts(env).catch((e) => console.error('intel', e));
  try {
    await sweepAuth(env.DB);

    // Which Namada nodes answer this tick (a short status read each). A node that does not is left out of every
    // read below, so a node that accepts requests and never answers costs one status read, not one per address.
    const rpcStatuses = await namadaStatusAll({ timeoutMs: 6000, retries: 0 });
    const rpcs = answeringRpcs(rpcStatuses as { provider: string; error?: string }[]);
    const validRpcs = rpcStatuses.filter((r: any) => !r.error) as any[];
    const headHeight = validRpcs.length ? Math.max(...validRpcs.map((r: any) => Number(r.height) || 0)) : null;
    // Quick reads (one attempt per node, 8 s): a node that answers its status and hangs on queries falls over to
    // the next node within seconds instead of 15 s × 3 attempts.
    const nread: ReadOpts = { ...QUICK, rpcs, signal, breaker };
    const nodeHealth = (rpcStatuses as any[]).map((r) => {
      const h: SourceHealth = { name: `Namada RPC ${r.provider}`, ok: !r.error, at: now, note: r.error ? String(r.error).slice(0, 120) : `height ${r.height}` };
      health.push(h);
      return { provider: r.provider as string, h };
    });

    // 1. Everything read from outside that nothing else waits for, side by side: the Osmosis side (holders every
    //    10 min, supply, price, pools), the outside indexer, and the Namada supply split via ABCI. A source that
    //    hangs costs its own timeout, never the others' (a hung Keplr used to hold every Namada read past the
    //    deadline). The quick, usually fast requests go first: a Worker opens at most six connections at once.
    const osmoCountRes = await env.DB.prepare("SELECT COUNT(*) as c FROM holders WHERE chain='osmosis'").first<{ c: number }>().catch(() => ({ c: 0 }));
    const shouldSyncHolders = !osmoCountRes?.c || now % 600000 < 60000;
    const keplr = { ...KEPLR_TICK, signal };

    // The holder list (every 10 min, a page at a time) is written when it arrives, after the Namada phases: nothing
    // waits for it, so a slow list can never take their time.
    const holderSync = shouldSyncHolders ? probe(health, 'Keplr Osmosis REST (holders)', () => fetchOsmosisHolderList(env.KEPLR_KEY, OSMOSIS_HOLDER_PAGES, keplr)) : Promise.resolve(null);
    const [osmoSupplyRes, price, poolRes, idxBlock, idxSupply, totalRes, posRes, stakeRes, ibcRes, maspRes, pgfRes, epoch] = await Promise.all([
      probe(health, 'Keplr Osmosis REST (supply)', () => fetchOsmosisSupplyBase(env.KEPLR_KEY, keplr)),
      fetchNamPrice(),
      fetchNamPools(),
      // Independent source: indexer.namada.net vs RPC (height) and vs ABCI (minted supply)
      probe(health, 'Namada indexer (indexer.namada.net)', () => fetchJson<any>(`${INDEXER}/chain/block/latest`, { timeoutMs: 8000, retries: 1, signal })),
      fetchJson<any>(`${INDEXER}/chain/token-supply?address=${NAM.namadaToken}`, { timeoutMs: 8000, retries: 1, signal }).catch(() => null),
      // 2. Namada supply partition via ABCI. A failed read is recorded as missing, never as 0.
      probe(health, 'Namada RPC (minted supply)', () => namTotalSupply(nread)),
      probe(health, 'Namada RPC (PoS balance)', () => namBalance(NAMADA.internal.pos, nread)),
      probe(health, 'Namada RPC (total stake)', () => namTotalStake(nread)),
      probe(health, 'Namada RPC (IBC escrow)', () => namBalance(NAMADA.internal.ibc, nread)),
      probe(health, 'Namada RPC (MASP balance)', () => namBalance(NAMADA.internal.masp, nread)),
      probe(health, 'Namada RPC (PGF balance)', () => namBalance(NAMADA.internal.pgf, nread)),
      probe(health, 'Namada RPC (epoch)', () => namadaEpoch(nread)),
    ]);
    const osmoSupply = osmoSupplyRes ? toNam(osmoSupplyRes) : null;
    health.push({ name: 'Osmosis SQS (price)', ok: price.usd != null, at: price.at, note: price.error });
    health.push({ name: 'Osmosis SQS (pools)', ok: poolRes.pools.length > 0, at: poolRes.at, note: poolRes.error });

    // Every pool the quote service lists is labelled, so the holder list can leave pools out (holders.ts notPool).
    if (shouldSyncHolders && poolRes.pools.length) {
      await runBatch(env.DB, poolRes.pools.filter((p) => p.address).map((p) => stmt.label(p.address, 'osmosis', `Osmosis Pool #${p.id} (${p.pair})`, 'pool', 'auto', null, now))).catch((e) => console.error('pool labels', e));
    }

    const internalStmts = [];
    const metricStmts = [];
    const totalNam = totalRes ? toNam(totalRes.supply) : null;
    const posNam = posRes ? toNam(posRes.balance) : null;
    const stakeNam = stakeRes ? toNam(stakeRes.stake) : null;
    const ibcEscrowNam = ibcRes ? toNam(ibcRes.balance) : null;
    const maspNam = maspRes ? toNam(maspRes.balance) : null;
    const pgfNam = pgfRes ? toNam(pgfRes.balance) : null;

    for (const [addr, r] of [[NAMADA.internal.pos, posRes], [NAMADA.internal.ibc, ibcRes], [NAMADA.internal.masp, maspRes], [NAMADA.internal.pgf, pgfRes]] as const) {
      if (r) internalStmts.push(stmt.verifiedBalance('namada', addr, r.balance.toString(), r.height, now, r.provider));
    }
    if (totalNam != null && totalNam > 0) metricStmts.push(stmt.metric(now, 'supply.total', totalNam));
    // supply.pos_bonded keeps its name for history: it is the staking account's balance, not what is staked.
    if (posNam != null) metricStmts.push(stmt.metric(now, 'supply.pos_bonded', posNam));
    // What is staked: the chain's total stake.
    if (stakeNam != null && stakeNam > 0) metricStmts.push(stmt.metric(now, 'supply.total_stake', stakeNam));
    if (ibcEscrowNam != null) metricStmts.push(stmt.metric(now, 'supply.ibc_escrow', ibcEscrowNam));
    if (maspNam != null) metricStmts.push(stmt.metric(now, 'supply.masp_shielded', maspNam));
    if (pgfNam != null) metricStmts.push(stmt.metric(now, 'supply.pgf', pgfNam));
    if (osmoSupply != null && osmoSupply > 0) metricStmts.push(stmt.metric(now, 'supply.osmosis', osmoSupply));
    if (totalNam != null && posNam != null && ibcEscrowNam != null && maspNam != null && pgfNam != null) {
      metricStmts.push(stmt.metric(now, 'supply.liquid', Math.max(0, totalNam - (posNam + ibcEscrowNam + maspNam + pgfNam))));
    }
    if (epoch != null && epoch > 0) metricStmts.push(stmt.metric(now, 'epoch', epoch));
    if (price.usd) metricStmts.push(stmt.metric(now, 'price.usd', price.usd));
    if (poolRes.pools.length) {
      // Pool depth is recorded so replay can show what liquidity looked like at the time.
      metricStmts.push(stmt.metric(now, 'dex.liquidity_usd', poolRes.pools.reduce((a, p) => a + p.liquidityUsd, 0)), stmt.metric(now, 'dex.pool_count', poolRes.pools.length));
      const ref = poolRes.pools.find((p) => p.id === OSMOSIS.refPoolId);
      if (ref) metricStmts.push(stmt.metric(now, 'dex.ref_pool_liquidity_usd', ref.liquidityUsd), stmt.metric(now, 'dex.ref_pool_nam', ref.namReserve), stmt.metric(now, 'dex.ref_pool_counter', ref.counterReserve));
    }

    // 3. Executed-swap price for the current hour: median of single-pool NAM/USDC swaps.
    const hour = Math.floor(now / 3600000) * 3600000;
    const swaps = await env.DB.prepare(
      `SELECT amount_num, counter_amount FROM flows WHERE chain='osmosis' AND counter_denom='USDC' AND kind IN ('buy','sell')
       AND amount_num >= 50 AND counter_amount > 0 AND pool_id IS NOT NULL AND pool_id NOT LIKE '%,%' AND ts >= ? AND ts < ?`,
    ).bind(hour, hour + 3600000).all<{ amount_num: number; counter_amount: number }>().catch(() => ({ results: [] as any[] }));
    const px = (swaps.results || []).map((s) => s.counter_amount / s.amount_num).sort((a, b) => a - b);
    if (px.length) {
      const m = px.length % 2 ? px[px.length >> 1] : (px[px.length / 2 - 1] + px[px.length / 2]) / 2;
      metricStmts.push(stmt.metric(hour, 'price.swap_1h', m), stmt.metric(hour, 'price.swap_1h.n', px.length));
    }

    await runBatch(env.DB, [...internalStmts, ...metricStmts]);

    // 4. Integrity checks. Each compares two independent sources.
    const checkStmts = [];

    if (ibcEscrowNam != null && osmoSupply != null) {
      // Namada keeps one escrow for every channel; NAM on other chains is 0 (checked 2026-10-19), and transfers
      // known to be stuck in it (config IBC_STUCK) are counted, so only an unexplained gap needs a look.
      const stuckNam = IBC_STUCK.reduce((a, x) => a + x.nam, 0);
      const rawGap = ibcEscrowNam - osmoSupply;
      const drift = rawGap - stuckNam;
      const ibcDiff = Math.abs(drift);
      checkStmts.push(stmt.check('ibc_conservation', ibcDiff < 100 ? 'ok' : ibcDiff < 10000 ? 'warn' : 'fail',
        'IBC conservation: Namada escrow = Osmosis voucher supply + known stuck transfers',
        { namadaIbcEscrow: ibcEscrowNam, osmosisSupply: osmoSupply, rawGapNam: rawGap, stuckNam, stuck: IBC_STUCK, driftNam: drift, sources: ['Namada RPC abci_query', 'Keplr Osmosis bank/supply'] }, now));
    }

    const rpcDiff = validRpcs.length >= 2 ? Math.abs(validRpcs[0].height - validRpcs[1].height) : null;
    checkStmts.push(stmt.check('rpc_consensus', validRpcs.length >= 2 && (rpcDiff ?? 0) <= 3 ? 'ok' : validRpcs.length >= 1 ? 'warn' : 'fail',
      'Namada RPC agreement (5ElementsNodes vs Papadritta)', { statuses: rpcStatuses, heightDiff: rpcDiff }, now));

    if (totalNam != null && posNam != null && ibcEscrowNam != null && maspNam != null && pgfNam != null) {
      const sumAccounted = posNam + ibcEscrowNam + maspNam + pgfNam;
      checkStmts.push(stmt.check('supply_integrity', sumAccounted <= totalNam && totalNam > 0 ? 'ok' : 'fail',
        'Supply partition: locked + escrowed ≤ minted',
        { totalMinted: totalNam, allocatedOrLocked: sumAccounted, transparentLiquid: totalNam - sumAccounted, pctLocked: ((sumAccounted / totalNam) * 100).toFixed(2) + '%' }, now));
    }
    if (posNam != null && stakeNam != null) {
      // The staking account always holds at least what is staked; the rest is on its way out.
      checkStmts.push(stmt.check('stake_within_staking_account', stakeNam <= posNam + 1 ? 'ok' : 'fail',
        'Total stake ≤ staking account balance (the rest is unstaking, withdrawable or unclaimed rewards)',
        { totalStakeNam: stakeNam, posBalanceNam: posNam, notStakedNam: posNam - stakeNam }, now));
    }

    // Live unbond decoder (LiveHub alarm): last outcome recorded in kv by liveUnbonds()
    const unb = await kvGetJson<LiveUnbondStatus>(env.DB, 'namada.unbonds.live');
    if (unb) {
      const lastFail = unb.failures[unb.failures.length - 1];
      const failedRecently = !!lastFail && now - lastFail.at < 24 * 3600000;
      health.push({
        name: 'Namada RPC (live unbond decode)', ok: !failedRecently, at: unb.lastAt ?? lastFail?.at ?? now,
        note: failedRecently
          ? `block ${lastFail.height}: ${lastFail.note}`.slice(0, 160)
          : `${unb.decoded} unbond request(s) decoded${unb.lastHeight ? `, last at block ${unb.lastHeight}` : ''}`,
      });
    }

    if (idxBlock && headHeight) {
      const idxH = Number(idxBlock.block);
      const lag = headHeight - idxH;
      checkStmts.push(stmt.check('indexer_lag', Math.abs(lag) <= 20 ? 'ok' : Math.abs(lag) <= 500 ? 'warn' : 'fail',
        'indexer.namada.net height vs Namada RPC height (the outside indexer, not this site\'s flow index)', { indexerHeight: idxH, rpcHeight: headHeight, lagBlocks: lag }, now));
    }
    // The second source is the outside indexer; when it does not answer (on 2026-10-19 its token-supply answer
    // turned to null for hours), a second Namada node, so the check keeps running instead of going quiet.
    if (totalNam != null) {
      let other: { label: string; nam: number } | null = null;
      if (idxSupply?.totalSupply) other = { label: 'Namada indexer (indexer.namada.net)', nam: Number(BigInt(idxSupply.totalSupply)) / 1e6 };
      else {
        // A node that already failed a read this tick is not asked again: a hung node would cost a full timeout.
        const rest = rpcs.filter((r) => r.provider !== totalRes?.provider && breaker.failures(r.provider) === 0);
        const r2 = rest.length && !late() ? await namTotalSupply({ ...nread, rpcs: rest }).catch(() => null) : null;
        if (r2) other = { label: `Namada node ${r2.provider}`, nam: toNam(r2.supply) };
      }
      if (other) {
        const diff = Math.abs(other.nam - totalNam);
        checkStmts.push(stmt.check('supply_cross_source', diff / totalNam < 0.001 ? 'ok' : diff / totalNam < 0.01 ? 'warn' : 'fail',
          `Minted supply: ${other.label} vs Namada node ${totalRes?.provider ?? ''}`.trim(),
          { other: other.nam, otherSource: other.label, abci: totalNam, abciSource: `Namada node ${totalRes?.provider ?? ''}`.trim(), diffNam: diff }, now));
      }
    }

    // This site's own flow index: the Namada block scanner against the node head, the Osmosis stream and catch-up.
    const ix = await indexState(env.DB, now).catch(() => null);
    if (ix) {
      const c = ix.namadaCursor;
      const lag = c && headHeight ? Math.max(0, headHeight - c.height) : null;
      const quiet = c ? now - c.at > NAMADA_CURSOR_STALE_MS : true;
      checkStmts.push(stmt.check('namada_index_lag', !c ? 'fail' : !quiet && (lag ?? 0) <= NAMADA_CURSOR_MAX_LAG ? 'ok' : (lag ?? 0) <= 500 && now - c.at < 30 * 60000 ? 'warn' : 'fail',
        'This site\'s Namada flow index vs the Namada RPC head', { cursorHeight: c?.height ?? null, cursorWrittenAt: c?.at ?? null, rpcHeight: headHeight, lagBlocks: lag }, now));
      const l = ix.osmosisLive, sw = ix.osmosisSweep;
      const streaming = !!l && l.connected && now - l.at <= OSMOSIS_LIVE_STALE_MS;
      const swept = !!sw && now - sw.at <= OSMOSIS_SWEEP_STALE_MS;
      checkStmts.push(stmt.check('osmosis_index', streaming && swept ? 'ok' : streaming || swept ? 'warn' : 'fail',
        'This site\'s Osmosis flow index: live stream and catch-up search', { streaming, lastStreamReport: l?.at ?? null, sweptToHeight: sw?.height ?? null, sweptAt: sw?.at ?? null }, now));
    }

    // Every bridge crossing should be on record on both chains (14 days; the last 30 minutes are not judged).
    const from14 = now - 14 * 86400000;
    const [nb, ob, orf] = await Promise.all([
      env.DB.prepare(`SELECT f.id, f.kind, f.ts, f.from_addr, f.to_addr, f.amount_num FROM flows f WHERE f.chain='namada' AND f.kind IN ('ibc_in','ibc_out') AND f.ts >= ?
                      AND (f.from_addr LIKE 'osmo1%' OR f.to_addr LIKE 'osmo1%' OR f.from_addr = ? OR f.to_addr = ?) AND (f.meta IS NULL OR f.meta NOT LIKE '%"tokenSymbol":%') AND ${NOT_LEGACY_TWIN}`)
        .bind(from14, NAMADA.internal.ibc, NAMADA.internal.ibc).all<any>().catch(() => null),
      env.DB.prepare(`SELECT id, kind, ts, from_addr, to_addr, amount_num, meta FROM flows WHERE chain='osmosis' AND kind IN ('ibc_in','ibc_out') AND ts >= ?`).bind(from14 - 15 * 60000).all<any>().catch(() => null),
      env.DB.prepare(`SELECT id, ts, from_addr, to_addr, amount_num, meta FROM flows WHERE chain='osmosis' AND kind='other' AND ts >= ? AND meta LIKE '%"ibcTimeoutRefund":true%'`).bind(from14).all<any>().catch(() => null),
    ]);
    if (nb && ob && orf) {
      const outs = (ob.results || []).filter((r: any) => r.kind === 'ibc_out');
      const gone = timedOutSends(outs.map(ibcRowOf), (orf.results || []).map(ibcRowOf));
      const osmo = (ob.results || []).filter((r: any) => !gone.has(r.id) && r.ts >= from14);
      const u = unpairedCrossings(nb.results || [], osmo, now);
      const n = u.namadaOnly.length + u.osmosisOnly.length;
      const sample = (rows: any[]) => rows.slice(0, 3).map((r) => ({ id: r.id, ts: r.ts, nam: r.amount_num }));
      checkStmts.push(stmt.check('bridge_records_paired', n === 0 ? 'ok' : 'warn',
        'Every bridge crossing is on record on both chains (14 days)',
        { namadaRows: (nb.results || []).length, osmosisRows: osmo.length, onlyOnNamada: u.namadaOnly.length, onlyOnOsmosis: u.osmosisOnly.length,
          onlyOnNamadaNam: u.namadaOnly.reduce((a, r) => a + r.amount_num, 0), onlyOnOsmosisNam: u.osmosisOnly.reduce((a, r) => a + r.amount_num, 0),
          examples: { namada: sample(u.namadaOnly), osmosis: sample(u.osmosisOnly) } }, now));
    }

    // SQS mid vs the last hour's executed swap price
    const lastSwap = await env.DB.prepare(`SELECT ts, value FROM metrics WHERE key='price.swap_1h' ORDER BY ts DESC LIMIT 1`).first<{ ts: number; value: number }>().catch(() => null);
    if (price.usd && lastSwap && now - lastSwap.ts < 6 * 3600000) {
      const dev = Math.abs(price.usd / lastSwap.value - 1) * 100;
      checkStmts.push(stmt.check('price_vs_execution', dev < 5 ? 'ok' : dev < 15 ? 'warn' : 'fail',
        'SQS mid price vs executed swap price (last hour with trades)', { sqsUsd: price.usd, executedUsd: lastSwap.value, executedAt: lastSwap.ts, deviationPct: dev.toFixed(2) }, now));
    }

    await runBatch(env.DB, checkStmts);
    // What has been learnt so far is written now: a stall in the stake phase must not hide it.
    await mergeHealth(env, health);

    // 5. Bonded stake. Estimates for every address from bond/unbond history (every 10 min); chain verification of up
    //    to STAKE_PER_TICK addresses per tick, most-stale first, written batch by batch (partial progress lands).
    if (now % 600000 < 60000 || !(await env.DB.prepare('SELECT 1 FROM stakes LIMIT 1').first().catch(() => null))) {
      await env.DB.prepare(`INSERT INTO stakes (address, estimated_num, updated_at)
        SELECT addr, SUM(amt), ? FROM (
          SELECT from_addr addr, amount_num amt FROM flows WHERE chain='namada' AND kind='bond' AND from_addr IS NOT NULL
          UNION ALL SELECT to_addr, -amount_num FROM flows WHERE chain='namada' AND kind='unbond' AND to_addr IS NOT NULL
        ) GROUP BY addr
        ON CONFLICT(address) DO UPDATE SET estimated_num=excluded.estimated_num, updated_at=excluded.updated_at`).bind(now).run().catch((e) => console.error('stake estimates', e));
      // Genesis-bonded accounts have no bond tx; make sure every liquid holder is verified on chain too.
      await env.DB.prepare(`INSERT OR IGNORE INTO stakes (address, updated_at) SELECT address, ? FROM holders WHERE chain='namada' AND address LIKE 'tnam1q%'`).bind(now).run().catch(() => {});
    }
    // 4b. Staker discovery: every delegation the chain lists, a few validators a tick (a full pass about hourly),
    //     so stakers that never moved since the flow index began (genesis and early delegators) are read too.
    //     New addresses enter `stakes` unverified; the verifier below reads them first.
    if (!late()) {
      const discName = 'Namada RPC (staker discovery)';
      try {
        type Discovery = { validators: string[]; listedAt: number; next: number; found: number; passAt: number | null };
        let disc = await kvGetJson<Discovery>(env.DB, 'stake.discovery');
        if (!disc || !disc.validators?.length || now - disc.listedAt > 6 * 3600_000) {
          const validators = await validatorAddresses(nread);
          disc = { validators, listedAt: now, next: (disc?.next ?? 0) % Math.max(1, validators.length), found: disc?.found ?? 0, passAt: disc?.passAt ?? null };
        }
        let read = 0, found = 0, failed = 0;
        for (let k = 0; k < DISCOVER_PER_TICK && !late(); k++) {
          const v = disc.validators[disc.next];
          try {
            const addrs = [...(await delegatorsOf(v, nread)).keys()].filter((a) => a.startsWith('tnam1q'));
            const stmts: Stmt[] = [];
            for (let i = 0; i < addrs.length; i += 45) {
              const part = addrs.slice(i, i + 45);
              stmts.push({ sql: `INSERT OR IGNORE INTO stakes (address, updated_at) VALUES ${part.map(() => '(?, ?)').join(',')}`, params: part.flatMap((a) => [a, now]) });
            }
            found += stmts.length ? await runBatch(env.DB, stmts) : 0;
            read++;
          } catch (e) {
            failed++;
            if (signal.aborted) break;
          }
          disc.next = (disc.next + 1) % disc.validators.length;
          if (disc.next === 0) disc.passAt = now;
        }
        disc.found += found;
        await kvSet(env.DB, 'stake.discovery', disc);
        health.push({ name: discName, ok: read > 0 || failed === 0, at: now,
          note: `${read} validators read this tick, ${found} new stakers found${failed ? `, ${failed} failed` : ''}; ${disc.validators.length} validators in all` });
      } catch (e) {
        health.push({ name: discName, ok: false, at: now, note: `Validator list not read: ${String(e).slice(0, 100)}` });
      }
    }

    const stakeName = 'Namada RPC (stake verification)';
    if (epoch) {
      const todo = await env.DB.prepare(`SELECT address FROM stakes ORDER BY COALESCE(verified_at, 0) ASC, COALESCE(bonded_num, estimated_num, 0) DESC LIMIT ?`).bind(STAKE_PER_TICK).all<{ address: string }>().catch(() => ({ results: [] as { address: string }[] }));
      // `done`: rows written (D1's own count); `fails`: reads that got no usable answer; reads still running when
      // the stake phase ended (REFRESH_RESERVE_MS before the deadline) are neither: they are left for the next tick.
      let fails = 0, done = 0, attempted = 0;
      const list = todo.results || [];
      const stakeEnd = deadlineAt - REFRESH_RESERVE_MS;
      const phase = phaseSignal(signal, stakeEnd);
      const quick: ReadOpts = { ...QUICK, rpcs, signal: phase.signal, breaker };
      try {
        for (let i = 0; i < list.length && Date.now() < stakeEnd && !phase.signal.aborted; i += STAKE_CONCURRENCY) {
          const part = list.slice(i, i + STAKE_CONCURRENCY);
          const batch = await Promise.all(part.map((r) => delegationsAt(r.address, epoch, quick)
            .then((d) => ({ a: r.address, d, cut: false }), () => ({ a: r.address, d: null, cut: phase.signal.aborted }))));
          for (const x of batch) {
            if (x.d) attempted++;
            else if (!x.cut) { attempted++; fails++; }
          }
          const stmts = batch.flatMap((x) => (x.d ? [stmt.stakeVerified(x.a, x.d.bondedNam, x.d.delegations, epoch, now, x.d.provider)] : []));
          if (stmts.length) done += await runBatch(env.DB, stmts);
        }
      } finally {
        phase.done();
      }
      const left = list.length - attempted;
      // As the refresh: ok only when something was written (or nothing was due) and fewer than half the reads failed,
      // so a tick whose time limit left every address reads as not ok, with the note shown.
      const ok = batchHealthOk(list.length, done, attempted, fails);
      health.push({ name: stakeName, ok, at: now, note: `${done} addresses verified this tick, ${fails} failed${left > 0 ? `, ${left} left for the next tick (time limit)` : ''}` });

      const cov = await env.DB.prepare(`SELECT SUM(bonded_num) v, COUNT(bonded_num) n, COUNT(*) total, SUM(CASE WHEN bonded_num > 0 THEN 1 ELSE 0 END) stakers FROM stakes`).first<{ v: number | null; n: number; total: number; stakers: number | null }>().catch(() => null);
      // Owner decision 7: where the chain read and the flow-history estimate differ, that is reported here, not on the row.
      const mis = await env.DB.prepare(`SELECT COUNT(*) n, SUM(ABS(estimated_num - bonded_num)) total,
            (SELECT address FROM stakes WHERE bonded_num IS NOT NULL AND estimated_num IS NOT NULL ORDER BY ABS(estimated_num - bonded_num) DESC LIMIT 1) top_addr,
            MAX(ABS(estimated_num - bonded_num)) top_nam
          FROM stakes WHERE bonded_num IS NOT NULL AND estimated_num IS NOT NULL AND ABS(estimated_num - bonded_num) > 1`)
        .first<{ n: number; total: number | null; top_addr: string | null; top_nam: number | null }>().catch(() => null);
      // Measured against what is staked (the chain's total stake), not the staking account's balance, which also
      // holds NAM on its way out and would make full coverage read as 78%.
      if (cov && stakeNam != null && cov.n > 0) {
        const pct = (cov.v ?? 0) / stakeNam * 100;
        // Passes when the addresses read so far add up to the chain's total stake (within 2%); addresses still
        // waiting to be read are reported, not counted as a fault.
        await runBatch(env.DB, [stmt.check('bonded_coverage', Math.abs(100 - pct) < 2 ? 'ok' : 'warn',
          'Bonded stake: Σ verified per-address bonds vs the chain\'s total stake',
          {
            verifiedAddresses: cov.n, knownAddresses: cov.total, pendingAddresses: cov.total - cov.n, stakers: cov.stakers ?? null,
            sumVerifiedNam: cov.v, totalStakeNam: stakeNam, posBalanceNam: posNam, coveragePct: pct.toFixed(1) + '%',
            estimateMismatches: mis?.n ?? null, estimateMismatchNam: mis?.total ?? null,
            largestMismatch: mis?.top_nam ? { address: mis.top_addr, nam: mis.top_nam } : null,
          }, now)]).catch(() => {});
      }
    } else {
      // Without the epoch no stake can be read: say so, rather than keep showing the last tick's result.
      health.push({ name: stakeName, ok: false, at: now, note: 'Not run this tick: the epoch could not be read from the chain.' });
    }

    // 5b. Spendable Namada balances (W13): re-read from the chain the addresses checked longest ago, a bounded batch
    //     per tick (≤ LIQUID_PER_TICK addresses, one attempt per answering node, stops at the budget or the deadline).
    if (!late()) {
      await refreshLiquidBalances(env, health, namBalanceQuick, { rpcs, headHeight, signal, deadlineAt, breaker }).catch((e) => {
        health.push({ name: 'Namada RPC (balance refresh)', ok: false, at: Date.now(), note: String(e).slice(0, 160) });
      });
    } else {
      health.push({ name: 'Namada RPC (balance refresh)', ok: false, at: Date.now(), note: 'Not run this tick: the tick ran out of time on slower reads.' });
    }

    // 6. The Osmosis holder list, read beside everything above.
    const holderList = await holderSync;
    const holders = holderList?.holders ?? null;
    if (holderList && holders && holders.length > 0) {
      await runBatch(env.DB, holders.filter((h) => h.balanceNum > 0).map((h) => stmt.verifiedBalance('osmosis', h.address, h.balance, null, now, 'keplr_rest')));
      // A complete list that adds up to the supply also tells who no longer holds NAM there: their old balance is
      // not kept as if current. Anything less (a page without a next key, the page cap, a sum off the supply) is
      // not trusted to zero anyone.
      const chk = osmosisListCheck(holders, holderList.complete, osmoSupplyRes, holderList.capped);
      if (chk.trust) await runBatch(env.DB, [osmosisDroppedStmt(now)]).catch((e) => console.error('osmosis dropped holders', e));
      const h = health.find((x) => x.name === 'Keplr Osmosis REST (holders)');
      if (h) { h.note = chk.note; h.ok = chk.trust; }
      // Hourly, record the readings for the 24 h / 7 d changes (a separate batch: a missing table must not undo the balances).
      if (now % 3600000 < 60000) await runBatch(env.DB, spanStmts('osmosis', now)).catch((e) => console.error('osmosis balance spans', e));
    }

    // Balance readings older than any window still asked for (hourly).
    if (now % 3600000 < 60000) await runBatch(env.DB, [pruneSpansStmt(now)]).catch((e) => console.error('prune balance spans', e));

    // Chain parameters (unbonding period, staking rate, measured epoch length): cached 6 h, refreshed here so
    // pages never wait on the indexer.
    if (!late()) await chainParams(env.DB, signal).catch(() => {});

    // The indexer's withdraw times of the unbonds the unlock list shows (every 10 minutes): exact where it has them.
    if (now % 600000 < 60000 && !late()) {
      const addrs = await unbondAddresses(env.DB, now);
      const byAddress: UnbondWithdrawCache['byAddress'] = {};
      let failedUnbonds = 0;
      for (let i = 0; i < addrs.length && !late(); i += 4) {
        await Promise.all(addrs.slice(i, i + 4).map((a) => fetchUnbonds(a, signal).then((u) => { byAddress[a] = u; }).catch(() => { failedUnbonds++; })));
      }
      if (Object.keys(byAddress).length || !addrs.length) await kvSet(env.DB, 'unbond.withdraw', { at: now, byAddress } satisfies UnbondWithdrawCache).catch(() => {});
      health.push({ name: 'Namada indexer (unbond withdraw times)', ok: failedUnbonds < Math.max(1, addrs.length / 2), at: now, note: `${Object.keys(byAddress).length} of ${addrs.length} addresses read${failedUnbonds ? `, ${failedUnbonds} failed` : ''}` });
    }

    // A node that answered its status but then failed reads is not "ok": the status alone cannot see a node that
    // hangs on queries, and the Sources sheet should say why the other node answered instead.
    for (const { provider, h } of nodeHealth) {
      const n = breaker.failures(provider);
      if (h.ok && n > 0) { h.ok = false; h.note = `${h.note}; ${n} ${n === 1 ? 'read' : 'reads'} got no answer this tick, so another node was asked`; }
    }
  } catch (err) {
    console.error('cron error:', err);
    health.push({ name: 'cron', ok: false, at: Date.now(), note: String(err).slice(0, 160) });
  } finally {
    clearTimeout(timer);
    await mergeHealth(env, health);
    // The forum and governance alerts end before the lock is released (every send is claimed once, and every
    // webhook post has its own timeout), so two ticks never run them at the same time; the health above is
    // already written and cannot be held up by them.
    await intel;
    await releaseTickLock(env.DB, lockId);
  }
}

/** Merge into the stored health map so a probe that did not run this tick keeps its last result. */
async function mergeHealth(env: Env, health: SourceHealth[]) {
  const prev = (await kvGetJson<Record<string, SourceHealth>>(env.DB, 'source.health').catch(() => null)) ?? {};
  for (const h of health) prev[h.name] = h;
  await kvSet(env.DB, 'source.health', prev).catch(() => {});
}
