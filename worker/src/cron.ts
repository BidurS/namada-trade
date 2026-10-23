import type { Env } from './util';
import { runBatch, stmt, kvGet, kvSet, kvGetJson } from './db';
import { fetchOsmosisHolderList, fetchOsmosisSupplyBase, fetchOsmosisBalanceBase, OSMOSIS_HOLDER_PAGES, OSMOSIS_NEXT_KEY_MAX, KEPLR_REST_SRC, type HolderListRead, type KeplrOpts, type OsmosisBalanceRead } from './sources/osmosis';
import { fetchNamPools, fetchNamPrice } from './sources/sqs';
import { QUOTE_KEYS } from '../../shared/settle';
import { namBalance, namTotalSupply, namTotalStake, namadaEpoch, namadaStatusAll, delegationsAt, answeringRpcs, listingHeads, QUICK, RpcBreaker, allNamBalances, allBonds, ListingTooLargeError, LISTING_MAX_VALUE_BYTES, type BalanceListing, type BondListing, type ReadOpts, type Rpc } from './sources/namada';
import { fetchIntelChecked } from './sources/intel';
import { sendDiscordForumAlert, sendDiscordGovAlert, sendsAlerts } from './sources/discord';
import { NAM, NAMADA, OSMOSIS } from './config';
import { fetchJson, toNam, isRealAddress, FETCH_TEXT_MAX_BYTES } from './util';
import type { IntelResponse, SourceHealth } from '../../shared/types';
import type { Stmt } from './db';
import { sweepAuth } from './auth';
import { NOT_LEGACY_TWIN } from './flows-query';
import { unbondAddresses, fetchUnbonds, buildUnbondTermStructure, cachedChainParams, UNLOCKS_MIN_NAM, UNBOND_WITHDRAW_STALE_MS, type UnbondWithdrawCache } from './analytics';
import { chainParams, indexState, NAMADA_CURSOR_MAX_LAG, NAMADA_CURSOR_STALE_MS, OSMOSIS_LIVE_STALE_MS, OSMOSIS_SWEEP_STALE_MS, timedOutSends, ibcRowOf, safeParseJson } from './analytics';
import { INDEXER_IBC_STATUS, innerTxOfRow, reconcileStuckPackets, stuckTotalNam, type StuckCandidate, type StuckList } from './ibc-stuck';
import type { LiveUnbondStatus, LiveScanStatus } from './live-hub';
import type { AlertsSkipped } from './sources/discord';
import {
  INTERNAL_ADDRS, BALANCE_LISTING_SRC, BOND_LISTING_SRC, SPAN_EXTEND_MS, HAS_READING, listingTimes, readHolderFigures, refreshHolderFigures, figuresDue,
  osmosisDroppedStmt, spanStmts, listingBalanceStmts, listingZeroStmts, listingUnpinStmts, listingSpanStmts, pruneSpansStmt, type ListedBalance,
  OSMOSIS_PASS_KV, OSMOSIS_READ_AT_SQL, OSMOSIS_DROPPED_SQL, OSMOSIS_RECHECK_TOP_SQL, OSMOSIS_ROWS_SUM_SQL,
} from './holders';
import * as series from './series';

const INDEXER = 'https://indexer.namada.net/api/v1';
/** kv key of the IBC packets stuck in the escrow (ibc-stuck.ts). */
export const STUCK_PACKETS_KV = 'ibc.stuck_packets';
/** A Namada → Osmosis send on record on Namada only for this long is looked up as a stuck packet. */
export const STUCK_CANDIDATE_AGE_MS = 24 * 3600000;

/** The Sources sheet's row for the forum's latest posts (forum.namada.net posts.json). */
export const FORUM_POSTS_HEALTH = 'Namada forum (latest posts)';
/** The Sources sheet's row for the Discord alert posts: whether this Worker sends them, and the posts not sent. */
export const ALERT_DELIVERY_HEALTH = 'Discord alert delivery';

/**
 * The alert delivery row of a Worker that does not send alerts (sources/discord.ts sendsAlerts: its SEND_ALERTS
 * secret is not yes), or null when it sends. Pushed first on every tick, a tick the lock skips included, so a deploy
 * made before the secret was put shows in the health view and in deploy-check.sh's health list from its first tick,
 * not only once a post that would have reached the operator's channel is dropped.
 */
export function alertDeliveryOff(env: { SEND_ALERTS?: string }, now: number): SourceHealth | null {
  if (sendsAlerts(env)) return null;
  return { name: ALERT_DELIVERY_HEALTH, ok: false, at: now, note: 'Off on this Worker, SEND_ALERTS is not yes: no alert is posted to any channel.' };
}

async function syncIntelAndAlerts(env: Env, health: SourceHealth[]) {
  try {
    const t0 = Date.now();
    const { intel: read, postsError } = await fetchIntelChecked();
    let intel = read;
    let keepStored = false;
    if (postsError) {
      // The posts could not be read (an answer past its size cap, a timeout): the cached posts are kept, as an empty
      // list would blank the feed until the next good read, no forum alert is sent from them, and the row says why.
      // A cache that cannot be read this tick either is not a missing one: nothing is written over it (the topics and
      // proposals are stored again on the next good tick).
      let cached: IntelResponse | null | undefined;
      try { cached = await kvGetJson<IntelResponse>(env.DB, 'intel.cache'); } catch { cached = undefined; }
      if (cached === undefined) keepStored = true;
      else intel = { ...read, latestPosts: cached?.latestPosts ?? [] };
      const kept = keepStored ? 'and the stored copy could not be read, so it stands' : 'so the ones cached are kept';
      health.push({ name: FORUM_POSTS_HEALTH, ok: false, at: Date.now(), latencyMs: Date.now() - t0, note: `The forum's latest posts could not be read, ${kept}: ${postsError}`.slice(0, 160) });
    } else health.push({ name: FORUM_POSTS_HEALTH, ok: true, at: Date.now(), latencyMs: Date.now() - t0, note: `${read.latestPosts.length} latest posts read` });

    // 1. Cache latest intel snapshot in D1 kv for instant API reads
    if (!keepStored && (intel.topics.length > 0 || intel.proposals.length > 0)) {
      await kvSet(env.DB, 'intel.cache', JSON.stringify(intel));
    }

    // 2. Check Namada Forum latest posts for new topics or replies (only from posts read this tick)
    if (!postsError && intel.latestPosts.length > 0) {
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

/**
 * How often each chain listing is read (worker/src/sources/namada.ts allNamBalances, allBonds). Neither public node
 * compresses its answer (checked 2026-10-20 with Accept-Encoding gzip: the bond answer came back as 5,369,673 bytes
 * either way), so a listing costs the node its whole JSON size: 11.98 MB for the balances, 5.37 MB for the bonds.
 * One balance listing an hour and one bond listing every 40 minutes is 24 × 11.98 + 36 × 5.37 = 287.5 + 193.3 =
 * 481 MB a day across both nodes (a tick that carries a listing's writes over re-reads it; only a first run on an
 * empty table needs that). The block follower (live-hub.ts) keeps moved addresses current between listings, so a
 * listing is reconciliation, not the only source of a balance.
 */
export const BALANCE_LISTING_MS = 60 * 60_000;
export const BOND_LISTING_MS = 40 * 60_000;
/** Rows a listing writes in one tick; the rest is written next tick (after re-reading the listing), nothing is lost. */
export const LISTING_WRITE_CAP = 3000;
/** The stake sample's reads end this long before the deadline, so the listing's writes (a SELECT of every stored row, then the diff) get their turn. */
export const LISTING_RESERVE_MS = 20_000;
/**
 * One attempt per node for a listing, started with the tick. Measured on 2026-10-20 against the live nodes: the 12 MB
 * balance answer streamed in 3.5 s at best, 28 s from 5ElementsNodes and 45 s from Papadritta at worst, so a 20 s
 * budget could miss every attempt and the stakes would then never update (the per-address refresh is gone). The
 * first node asked (the one that served the last listing, unless it failed or was refused) gets this long; the
 * second gets what is left of the tick (TICK_DEADLINE_MS), and the apply runs after the deadline on what arrived.
 */
export const LISTING_TIMEOUT_MS = 35_000;
/** A listing that has not landed (no complete pass) for this many of its intervals is reported as not ok every tick, not only on the ticks that read it. */
export const LISTING_OVERDUE_INTERVALS = 2;
/** Stakes re-read per tick with delegations_at (2 requests each), as a sample against the bond listing's rows. */
export const SAMPLE_PER_TICK = 24;
export const SAMPLE_CONCURRENCY = 6;
/** Sample disagreements are reported by the coverage check for this long. */
export const SAMPLE_KEEP_MS = 24 * 3600_000;
/**
 * After a listing read fails (both nodes past the timeout, the deadline), the next try waits this long: a slow day
 * must not cost the nodes a cut-off download every minute (a node streaming at 0.4 MB/s sends 8 MB in the 20 s).
 */
export const LISTING_RETRY_MS = 5 * 60_000;
/**
 * Executed swaps the price check trusts: buys and sells of at least 50 NAM against USDC through one pool trusted for
 * the price (OSMOSIS.pricePoolIds, the reference NAM/USDC pool). A routed trade is left out: its counter amount is not
 * the price of the NAM leg (on 2026-10-20 routed buys through pools 3005 and 3368 worked out at about half the market
 * price). A trade in any other pool is left out too: anyone can create a pool at a price of their choosing, and the
 * stored 'USDC' is a label, which only the reference pool's other coin (Noble USDC) is sure to deserve.
 */
export const SINGLE_POOL_USDC_SWAP = `chain='osmosis' AND counter_denom='USDC' AND kind IN ('buy','sell')
       AND amount_num >= 50 AND counter_amount > 0 AND pool_id IN (${OSMOSIS.pricePoolIds.map((p) => `'${p}'`).join(',')})`;
/** How old the last hour with such a trade may be for the price check to compare against it. */
export const PRICE_CHECK_WINDOW_MS = 6 * 3600000;

/**
 * The hourly stake estimate of every address from its bond and unbond flows (the figure shown only before any bond
 * listing has gone through, holders.ts stakeNum). A row is written only when its estimate changed: rewriting all
 * ~1,167 estimate rows every hour was about 56,000 rows written a day for nothing (`IS NOT` also counts a NULL
 * estimate becoming a number as a change).
 */
export const STAKE_ESTIMATES_SQL = `INSERT INTO stakes (address, estimated_num, updated_at)
  SELECT addr, SUM(amt), ? FROM (
    SELECT from_addr addr, amount_num amt FROM flows WHERE chain='namada' AND kind='bond' AND from_addr IS NOT NULL
    UNION ALL SELECT to_addr, -amount_num FROM flows WHERE chain='namada' AND kind='unbond' AND to_addr IS NOT NULL
  ) GROUP BY addr
  ON CONFLICT(address) DO UPDATE SET estimated_num=excluded.estimated_num, updated_at=excluded.updated_at
  WHERE stakes.estimated_num IS NOT excluded.estimated_num`;

/**
 * The price check: the quoted price against the median price of the last hour with a trusted trade.
 * - null when the quote is not known: nothing is written, so the check goes quiet and is served as 'stale' (its source
 *   stopped answering).
 * - 'idle' when the quote is known but no trusted trade fell in the last 6 h: nothing to compare, which is neither a
 *   pass nor a fault (this market can go a day without one). The time of the last trusted trade goes in the detail.
 * - otherwise ok / warn / fail by how far apart the two prices are (under 5%, under 15%, more).
 */
export function priceVsExecution(
  quoteUsd: number | null | undefined,
  lastSwapHour: { ts: number; value: number } | null,
  lastTradeAt: number | null,
  now: number,
): { status: 'ok' | 'warn' | 'fail' | 'idle'; detail: Record<string, unknown> } | null {
  if (!quoteUsd || !(quoteUsd > 0)) return null;
  if (lastSwapHour && lastSwapHour.value > 0 && now - lastSwapHour.ts < PRICE_CHECK_WINDOW_MS) {
    const dev = Math.abs(quoteUsd / lastSwapHour.value - 1) * 100;
    return {
      status: dev < 5 ? 'ok' : dev < 15 ? 'warn' : 'fail',
      detail: { sqsUsd: quoteUsd, executedUsd: lastSwapHour.value, executedAt: lastSwapHour.ts, deviationPct: dev.toFixed(2) },
    };
  }
  return { status: 'idle', detail: { sqsUsd: quoteUsd, noTrades: true, windowHours: PRICE_CHECK_WINDOW_MS / 3600000, lastTradeAt } };
}

/** Within this many NAM the escrow and the Osmosis supply count as equal (the two are read a few blocks apart). */
export const IBC_TOLERANCE_NAM = 100;
/** Osmosis counting this many NAM more than the escrow holds is a fault, not a look. */
export const IBC_FAIL_NAM = 10_000;
/** What the bridge check compares and what it cannot, in its detail (the escrow is one for every channel). */
export const IBC_COMPARED = 'The Namada IBC escrow (one account for every channel), less the NAM in packets stuck in it, against the NAM voucher supply on Osmosis.';
export const IBC_NOT_COMPARED = 'NAM held for any other channel: it is in the escrow, and no other chain is read. It shows as the escrow over Osmosis, and an Osmosis shortfall of the same size would cancel it out.';

/**
 * The bridge conservation check: Namada's IBC escrow, less the NAM in packets stuck in it (ibc-stuck.ts), against
 * the NAM voucher supply on Osmosis. Namada keeps one escrow for every channel and this site reads no chain's NAM
 * supply but Osmosis's: NAM delivered over another channel stays in the escrow and adds nothing on Osmosis. So the
 * two sides of the gap do not say the same thing:
 * - Osmosis over (it counts more than the escrow holds): a shortfall that nothing on another chain can explain, as
 *   NAM held for other chains only adds to the escrow. 'warn', then 'fail' from IBC_FAIL_NAM.
 * - Escrow over (it holds more than Osmosis counts): NAM held for another chain, or NAM stuck for Osmosis that the
 *   stuck list does not have, which the check cannot tell apart. 'warn': never a pass, as a real Osmosis drift must
 *   not pass, and never a fault, as any holder can send NAM to another chain.
 * An Osmosis shortfall as large as the NAM held for other chains cancels out and reads as equal; the detail says so.
 */
export function ibcConservation(escrowNam: number, osmosisNam: number, stuckNam: number): {
  status: 'ok' | 'warn' | 'fail'; over: 'escrow' | 'osmosis' | null; rawGapNam: number; driftNam: number;
} {
  const rawGapNam = escrowNam - osmosisNam;
  const driftNam = rawGapNam - stuckNam;
  const over = driftNam >= IBC_TOLERANCE_NAM ? 'escrow' : driftNam <= -IBC_TOLERANCE_NAM ? 'osmosis' : null;
  const status = over == null ? 'ok' : over === 'escrow' ? 'warn' : -driftNam < IBC_FAIL_NAM ? 'warn' : 'fail';
  return { status, over, rawGapNam, driftNam };
}

/**
 * One deadline for the whole tick. Cloudflare stops a scheduled run after 15 minutes and the trigger fires every
 * minute, so a tick that waits on a node that accepts requests and never answers must end well inside a minute:
 * batches are not started after this, and reads still running are aborted at it.
 */
export const TICK_DEADLINE_MS = 45_000;
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

/**
 * The health of a batch of chain reads (the stake sample): ok only when something was read, or nothing was due,
 * and fewer than half of the reads that ran failed. `due` counts every address in line this tick, `attempted`
 * only the reads that ran to an answer or a failure (not those the time limit left). So a tick that read nothing,
 * because every read failed or the time limit left every address, is not ok, and the Sources sheet shows its note.
 */
export function batchHealthOk(due: number, written: number, attempted: number, failed: number): boolean {
  return (due === 0 || written > 0) && failed < Math.max(1, attempted / 2);
}

/**
 * Osmosis holder list → rows. Only a list the bank said was complete, and whose balances add up to the bank's own
 * supply of NAM there (within 0.5%, as transfers can land between page reads), may zero holders missing from it.
 */
export function osmosisListCheck(holders: { balance: string }[], complete: boolean, supplyBase: bigint | null, capped = false): { trust: boolean; note: string } {
  return osmosisSumCheck(holders.length, holders.reduce((a, h) => a + BigInt(h.balance || '0'), 0n), complete, supplyBase, capped);
}

/** osmosisListCheck on a count and a sum: a pass read over several ticks (OsmoHolderPass) keeps only these. */
export function osmosisSumCheck(count: number, sum: bigint, complete: boolean, supplyBase: bigint | null, capped = false): { trust: boolean; note: string } {
  if (!complete) return { trust: false, note: capped
    ? `${count} holders read and the page cap was reached, so rows past it are not refreshed and missing holders are not zeroed`
    : `${count} holders read, but a page came back without the bank's page information, so missing holders are not zeroed` };
  if (supplyBase == null || supplyBase <= 0n) return { trust: false, note: `${count} holders read; the supply could not be read to check the list, so missing holders are not zeroed` };
  const pct = supplyGapPct(sum, supplyBase);
  return pct <= OSMO_SUPPLY_TOLERANCE_PCT
    ? { trust: true, note: `${count} holders, adding up to the supply within ${pct.toFixed(3)}%` }
    : { trust: false, note: `${count} holders add up to ${pct.toFixed(2)}% away from the supply, so missing holders are not zeroed` };
}
/** How far a sum of Osmosis balances may be from the bank's supply and still add up to it, in percent. */
const OSMO_SUPPLY_TOLERANCE_PCT = 0.5;
/** How far `sum` is from a positive `supplyBase`, in percent, rounded down to 0.0001%. */
const supplyGapPct = (sum: bigint, supplyBase: bigint) => Number(((sum > supplyBase ? sum - supplyBase : supplyBase - sum) * 1_000_000n) / supplyBase) / 10_000;

/**
 * Whether the Osmosis rows, read after the tick that completes a pass has written its reads by address
 * (recheckOsmosisRows), still add up to the supply: `rowsSum` is OSMOSIS_ROWS_SUM_SQL's answer, null when it could
 * not be read. The list's own sum can add up while its rows do not: two moves between the slices of one pass, one
 * from an address read early to one read late and one from a late address to an early one read before it received,
 * cancel in the list's sum, and the re-read of the early sender then takes its NAM out of the rows while the early
 * receiver is in none. So a pass is trusted (its start becomes the figures' stamp) only when this holds too. The
 * note is null when it holds, so the row reads as it did.
 */
export function osmosisRowsCheck(rowsSum: bigint | null, supplyBase: bigint | null): { trust: boolean; note: string | null } {
  if (rowsSum == null) return { trust: false, note: 'the rows could not be added up after the reads by address, so the pass is not taken as current' };
  if (supplyBase == null || supplyBase <= 0n) return { trust: false, note: 'the supply could not be read to check the rows, so the pass is not taken as current' };
  const pct = supplyGapPct(rowsSum, supplyBase);
  return pct <= OSMO_SUPPLY_TOLERANCE_PCT
    ? { trust: true, note: null }
    : { trust: false, note: `after the reads by address the rows add up to ${pct.toFixed(2)}% away from the supply, so the pass is not taken as current` };
}

/** kv key of the Osmosis holder pass (OsmoHolderPass). */
export const OSMO_PASS_KV = OSMOSIS_PASS_KV;
/**
 * One read of the whole Osmosis holder list, which may go on over several ticks: a tick reads what fits in its time
 * (OSMO_SLICE_RESERVE_MS) and at most OSMOSIS_HOLDER_PAGES pages from the bank's next key (`key`), writes those rows,
 * and the next tick goes on from there. Only the tick that reads the last page may zero the holders the pass did not
 * name (every row it named carries a read time at or after `startedAt`), and only when the pass adds up to the supply
 * and the bank, asked by address, says the holder has none (recheckOsmosisRows). So a list longer than one tick can
 * read is still read whole, and no fixed number of holders stops the zeroing.
 * `key` null: no pass under way (a 10-minute sync from nextOsmoPassAt on starts one). `fails`: slices in a row that failed; at
 * OSMO_PASS_FAILS_MAX the pass is dropped and the next sync starts again from the first page. `spansHour`: the hour
 * (ms / 1 h) whose balance spans a pass recorded; the first pass to start in an hour records them on all its slices.
 * `trustedStartedAt`: the start of the last pass that added up to the supply, both its list and the rows it left
 * after the reads by address (osmosisRowsCheck; on the first record, the oldest reading the count then included): the
 * Osmosis figures and series are stamped no later than it (holders.ts osmosisTrustedStart), so a pass that does not
 * add up never makes them read current. `lastPassMs`: how long the last complete pass took (osmoPassOverdueMs).
 *
 * How far this goes, at the pace measured on 2026-10-23 (810 ms a page, about 37 pages of 100 owners a tick) and with
 * passes an hour or more apart (each records balance spans, so the next waits holders × 2 / 1,000 minutes): the
 * count's stamp is the last trusted pass's start until the next pass completes, so just before that it is as old as
 * the gap between two pass starts and one pass's length together. That passes 6 hours, and the figures read old for
 * part of every cycle, from about 155,000 owners (1,339 on 2026-10-23; fewer if fewer pages fit a tick). Every pass
 * still completes and zeroes; the figures only say they are old.
 */
export interface OsmoHolderPass {
  startedAt: number; key: string | null; pages: number; holders: number; sumBase: string; ticks: number; fails: number;
  spans: boolean; spansHour: number | null; completeAt: number | null; trustedAt: number | null;
  trustedStartedAt: number | null; lastPassMs: number | null;
}
/**
 * A pass not complete after this long, or after twice the last complete pass's length when that is longer (at most
 * OSMO_PASS_OVERDUE_MAX_MS), is reported not ok on every tick it goes on (osmoPassOverdueMs). At about 37 pages a
 * tick, a pass of more than about 111,000 owners takes longer than 30 minutes: scaled with the last pass, a list that
 * grows as owners are added is never reported for its length alone, while one that never ends still is.
 */
export const OSMO_PASS_OVERDUE_MS = 30 * 60_000;
/** The longest a pass may go on before it is reported not ok, however long the last one took. */
export const OSMO_PASS_OVERDUE_MAX_MS = 6 * 3600_000;
/** How old a pass may be before it is reported not ok, after `prev` (OSMO_PASS_OVERDUE_MS). */
export function osmoPassOverdueMs(prev: Pick<OsmoHolderPass, 'lastPassMs'> | null): number {
  const last = prev?.lastPassMs != null && Number.isFinite(prev.lastPassMs) ? prev.lastPassMs : 0;
  return Math.min(OSMO_PASS_OVERDUE_MAX_MS, Math.max(OSMO_PASS_OVERDUE_MS, 2 * last));
}
/** Failed slices in a row after which a pass is dropped (a next key the bank no longer answers). */
export const OSMO_PASS_FAILS_MAX = 3;
/** A slice stops reading pages this long before the tick's deadline, so its writes and the figures after it get their turn. */
export const OSMO_SLICE_RESERVE_MS = 15_000;
/**
 * Rows a minute the passes write on average: a new pass starts at a 10-minute sync only once the last one's rows (each
 * holder's, twice when it recorded balance spans) / this many minutes have gone by since it started. Every pass
 * rewrites each holder's row, so without it an outsider who adds owners would set how many rows D1 writes; 1,000 a
 * minute (43 million a month) is what 10,000 holders every 10 minutes, the old page cap, allowed. 1,339 holders: a
 * pass every 10 minutes, as before; 100,000: one every 100 to 200 minutes.
 */
export const OSMO_PASS_ROWS_PER_MIN = 1000;

/** When the next pass may start after `prev` (OSMO_PASS_ROWS_PER_MIN); 0 without one. */
export function nextOsmoPassAt(prev: OsmoHolderPass | null): number {
  return prev ? prev.startedAt + Math.ceil(((prev.holders * (prev.spans ? 2 : 1)) / OSMO_PASS_ROWS_PER_MIN) * 60_000) : 0;
}

/** The stored pass, or null (none, or unreadable). */
export async function readOsmoPass(db: D1Database): Promise<OsmoHolderPass | null> {
  const p = await kvGetJson<OsmoHolderPass>(db, OSMO_PASS_KV).catch(() => null);
  const time = (t: unknown) => t === null || Number.isFinite(t);
  return p && Number.isFinite(p.startedAt) && Number.isFinite(p.pages) && Number.isFinite(p.holders) && typeof p.sumBase === 'string' && /^\d{1,60}$/.test(p.sumBase)
    && (p.key === null || (typeof p.key === 'string' && p.key.length <= OSMOSIS_NEXT_KEY_MAX))
    && time(p.trustedStartedAt) && (p.lastPassMs === undefined || time(p.lastPassMs)) ? { ...p, lastPassMs: p.lastPassMs ?? null } : null;
}

/**
 * The pass after one slice (`read`, null when the read failed) at `now`, and what the tick should do with it:
 * `zeroBefore` (the pass is complete and its list adds up: the Osmosis holders read before it may be zeroed, each
 * once the bank says by address it has none), `recheckBefore` (the pass completed over several ticks: the largest
 * holders read before it are read again by address), `spans` (record this slice's readings as balance spans), and the
 * health row's ok and note. `withheld`, with `zeroBefore`: the record to store instead of `pass` (complete, its trust
 * not advanced) when the rows no longer add up after the reads by address (osmosisRowsCheck). `seed`: with no stored
 * pass, the oldest reading the Osmosis count includes (holders.ts OSMOSIS_READ_AT_SQL), which stands as the last
 * trusted pass's start until a pass adds up.
 */
export function nextOsmoPass(prev: OsmoHolderPass | null, read: HolderListRead | null, supplyBase: bigint | null, now: number, seed: number | null = null): {
  pass: OsmoHolderPass; zeroBefore: number | null; recheckBefore: number | null; spans: boolean; ok: boolean; note: string | null; withheld?: OsmoHolderPass;
} {
  const going = prev?.key ? prev : null;
  const hour = Math.floor(now / 3600_000);
  if (!read) {
    // A failed slice: the pass keeps its key for the next tick, until it has failed OSMO_PASS_FAILS_MAX times in a row.
    if (!going) return { pass: prev ?? emptyPass(now, seed), zeroBefore: null, recheckBefore: null, spans: false, ok: false, note: null };
    const fails = (going.fails ?? 0) + 1;
    const drop = fails >= OSMO_PASS_FAILS_MAX;
    return { pass: { ...going, fails, key: drop ? null : going.key }, zeroBefore: null, recheckBefore: null, spans: false, ok: false,
      note: drop ? `the read failed ${fails} times in a row at page ${going.pages + 1}, so the pass is dropped and the next sync starts again from the first page` : null };
  }
  const base = going ?? {
    ...emptyPass(now, prev ? prev.trustedStartedAt : seed), spans: hour !== prev?.spansHour, spansHour: hour !== prev?.spansHour ? hour : prev?.spansHour ?? null,
    completeAt: prev?.completeAt ?? null, trustedAt: prev?.trustedAt ?? null, lastPassMs: prev?.lastPassMs ?? null,
  };
  const sum = BigInt(base.sumBase) + read.holders.reduce((a, h) => a + BigInt(h.balance), 0n);
  const pass: OsmoHolderPass = { ...base, key: read.complete ? null : read.nextKey ?? null, pages: base.pages + read.pages, holders: base.holders + read.holders.length, sumBase: sum.toString(), ticks: base.ticks + 1, fails: 0 };
  if (read.complete) {
    const chk = osmosisSumCheck(pass.holders, sum, true, supplyBase);
    const over = pass.ticks > 1 ? ` (one pass of ${pass.pages} pages over ${pass.ticks} ticks since ${new Date(pass.startedAt).toISOString().slice(11, 16)} UTC)` : '';
    const done: OsmoHolderPass = { ...pass, completeAt: now, lastPassMs: now - pass.startedAt };
    return {
      pass: chk.trust ? { ...done, trustedAt: now, trustedStartedAt: pass.startedAt } : done,
      zeroBefore: chk.trust ? pass.startedAt : null, recheckBefore: pass.ticks > 1 ? now : null, spans: pass.spans, ok: chk.trust, note: `${chk.note}${over}`,
      ...(chk.trust ? { withheld: done } : {}),
    };
  }
  if (pass.key) {
    const age = now - pass.startedAt;
    const overdue = osmoPassOverdueMs(pass);
    return { pass, zeroBefore: null, recheckBefore: null, spans: pass.spans, ok: age < overdue,
      note: `${pass.holders} holders read in ${pass.pages} pages since ${new Date(pass.startedAt).toISOString().slice(11, 16)} UTC; the next tick goes on from the bank's next key, and holders missing from the list are zeroed when it is complete${age >= overdue ? ` (not complete after ${Math.round(age / 60_000)} minutes)` : ''}` };
  }
  // Stopped without the bank's page information: the pass ends here, not complete; the next sync starts a new one.
  return { pass, zeroBefore: null, recheckBefore: null, spans: pass.spans, ok: false, note: osmosisSumCheck(pass.holders, sum, false, supplyBase, false).note };
}
const emptyPass = (now: number, trustedStartedAt: number | null): OsmoHolderPass => ({
  startedAt: now, key: null, pages: 0, holders: 0, sumBase: '0', ticks: 0, fails: 0, spans: false, spansHour: null, completeAt: null, trustedAt: null,
  trustedStartedAt, lastPassMs: null,
});

/** Holders a trusted pass did not name that are asked about by address before any is zeroed, largest first, per pass. */
export const OSMO_DROP_RECHECK_MAX = 20;
/** The largest holders read in the earlier slices of a pass of several ticks, read again by address when it completes. */
export const OSMO_TOP_RECHECK = 10;
/** The re-reads by address stop this long before the tick's deadline, so the figures after them get their turn. */
export const OSMO_RECHECK_RESERVE_MS = 5_000;

/**
 * The tick that completes a pass of the Osmosis holder list asks the bank, one address at a time, about the rows the
 * list alone would decide (sources/osmosis.ts fetchOsmosisBalanceBase):
 * - With `zeroBefore` (a trusted pass), the rows it did not name, largest first, at most OSMO_DROP_RECHECK_MAX: only
 *   those the bank says hold none are zeroed (osmosisDroppedStmt), one that holds NAM is written at the bank's
 *   balance, and the rest (past the cap, or no answer) are kept for the next pass. A pass read over several ticks
 *   can miss a holder that received NAM from an address it read later, and still add up within 0.5%. A row whose
 *   address is not an Osmosis address is zeroed without asking: the bank holds nothing there.
 * - With `recheckBefore` (a pass of several ticks), the OSMO_TOP_RECHECK largest holders read before this tick: NAM
 *   that moved between two slices was read at both of its addresses, and the top ten would count it twice.
 * Each address is read from Keplr's REST and, when that fails, from Osmosis's public REST; every answer is written as
 * read at `now`, with the source that gave it. Returns what was done and a note for the health row (null when
 * nothing was left out), which says how many neither source answered. Whether the pass is trusted is decided after
 * this, on the rows it leaves (osmosisRowsCheck).
 */
export async function recheckOsmosisRows(db: D1Database, keplrKey: string, now: number, zeroBefore: number | null, recheckBefore: number | null, opts: KeplrOpts): Promise<{
  zeroed: number; held: number; unanswered: number; more: boolean; reread: number; topUnanswered: number; note: string | null;
}> {
  type Row = { address: string; balance_num: number };
  const [dropped, top] = await Promise.all([
    zeroBefore != null ? db.prepare(OSMOSIS_DROPPED_SQL).bind(zeroBefore, OSMO_DROP_RECHECK_MAX + 1).all<Row>().then((r) => r.results || []) : Promise.resolve([] as Row[]),
    recheckBefore != null ? db.prepare(OSMOSIS_RECHECK_TOP_SQL).bind(recheckBefore, OSMO_TOP_RECHECK).all<Row>().then((r) => r.results || []) : Promise.resolve([] as Row[]),
  ]);
  const more = dropped.length > OSMO_DROP_RECHECK_MAX;
  const gone = dropped.slice(0, OSMO_DROP_RECHECK_MAX);
  const notAddress = gone.filter((r) => isRealAddress(r.address) !== 'osmosis').map((r) => r.address);
  const ask = [...new Set([...top.map((r) => r.address), ...gone.map((r) => r.address)].filter((a) => isRealAddress(a) === 'osmosis'))];
  const answers = new Map<string, OsmosisBalanceRead>();
  for (let i = 0; i < ask.length && !opts.signal?.aborted; i += 4) {
    await Promise.all(ask.slice(i, i + 4).map((a) => fetchOsmosisBalanceBase(keplrKey, a, opts).then((v) => { answers.set(a, v); }, () => {})));
  }
  const goneSet = new Set(gone.map((r) => r.address));
  const zeroRead = gone.filter((r) => answers.get(r.address)?.base === 0n).map((r) => r.address);
  const zero = [...notAddress, ...zeroRead];
  const write = [...answers].filter(([a, v]) => v.base > 0n || !goneSet.has(a));
  const held = gone.filter((r) => (answers.get(r.address)?.base ?? 0n) > 0n).length;
  const unanswered = gone.length - zero.length - held;
  const topUnanswered = top.filter((r) => isRealAddress(r.address) === 'osmosis' && !goneSet.has(r.address) && !answers.has(r.address)).length;
  // A zeroed row names the source that said it holds none (a row whose address is not an Osmosis one, asked of
  // nobody, as the list's own rows do): one statement a source.
  const zeroBy = new Map<string, string[]>([[KEPLR_REST_SRC, [...notAddress]]]);
  for (const a of zeroRead) { const src = answers.get(a)!.src; zeroBy.set(src, [...(zeroBy.get(src) ?? []), a]); }
  const stmts: Stmt[] = [
    ...write.map(([a, v]) => stmt.verifiedBalance('osmosis', a, v.base.toString(), null, now, v.src)),
    ...(zeroBefore != null ? [...zeroBy].filter(([, z]) => z.length > 0).map(([src, z]) => osmosisDroppedStmt(now, zeroBefore, z, src)) : []),
  ];
  if (stmts.length) await runBatch(db, stmts);
  const notes: string[] = [];
  if (held) notes.push(`${held} not named by the list ${held === 1 ? 'holds' : 'hold'} NAM by the bank's balance read by address, so ${held === 1 ? 'it was' : 'they were'} written at that balance`);
  if (unanswered) notes.push(`${unanswered} not named by the list ${unanswered === 1 ? 'was' : 'were'} not zeroed: neither Keplr's REST nor Osmosis's public REST answered the balance read by address in this tick's time, so the next pass asks again`);
  if (topUnanswered) notes.push(`${topUnanswered} of the largest readings of the earlier slices ${topUnanswered === 1 ? 'was' : 'were'} not read again: neither Keplr's REST nor Osmosis's public REST answered the balance read by address in this tick's time`);
  if (more) notes.push(`more than ${OSMO_DROP_RECHECK_MAX} were not named by the list, and at most ${OSMO_DROP_RECHECK_MAX} are asked about by address a pass: the rest are kept for the next passes`);
  return { zeroed: zero.length, held, unanswered, more, reread: write.length - held, topUnanswered, note: notes.length ? notes.join('; ') : null };
}

/** How far apart in time the two records of one crossing may be. */
export const PAIR_WINDOW_MS = 15 * 60000;
/** The most unpaired Namada rows for which the bridge pairing's search for chains of moves (unpairedCrossings) goes past a record another row holds. */
export const PAIR_AUGMENT_ROWS = 200;
/** The most records one such search looks at, in the row's own window and in those of the rows it would move. */
export const PAIR_AUGMENT_LOOKS = 20;
/**
 * The most rows one such search would move, one after another. One row that moves pairs an escrow send beside a later
 * send of the same user and amount, and an escrow receive beside a shielded deposit; chains of up to three were
 * needed to pair as many as can be paired in 180,000 random honest and adversarial cases of two to seven crossings
 * (2026-10-23), and one more is allowed to spare.
 */
export const PAIR_AUGMENT_DEPTH = 4;
/**
 * The most rows each read of the bridge check takes, newest first. The 14 days to 2026-10-22 held 39 crossings a
 * chain and the busiest fortnight since launch 709 on Namada, but any chain user can add rows (a dust transfer is
 * one), so a read is bounded and the memory it takes with it: the three reads at this cap are about 12 MB of
 * answers and as much again once parsed, beside a balance listing that may be in flight.
 */
export const BRIDGE_CHECK_ROWS = 10_000;

/**
 * When a bridge-check read came back full (BRIDGE_CHECK_ROWS rows, newest first), the time after which every record a
 * crossing can pair with is in the reads: its other record within PAIR_WINDOW_MS, its refund after it. Null when no
 * read was full and the whole 14 days are judged.
 */
export function bridgeJudgedFrom(namada: { ts: number }[], osmosis: { ts: number }[], refunds: { ts: number }[]): number | null {
  const oldest = (rows: { ts: number }[]) => rows.reduce((a, r) => Math.min(a, r.ts), Infinity);
  const full = (rows: unknown[]) => rows.length >= BRIDGE_CHECK_ROWS;
  const from = Math.max(
    full(namada) ? oldest(namada) + PAIR_WINDOW_MS : -Infinity,
    full(osmosis) ? oldest(osmosis) + PAIR_WINDOW_MS : -Infinity,
    full(refunds) ? oldest(refunds) : -Infinity,
  );
  return from === -Infinity ? null : from;
}

/**
 * Bridge crossings recorded on one chain and not on the other: each Namada bridge row (to or from an osmo1 address)
 * should have the Osmosis record of the same transfer (same addresses and amount within 15 minutes), and the other
 * way round. Rows younger than 30 minutes are not judged (relayers can be slow). Refunded sends are left out.
 *
 * Chain users decide how many rows there are (a dust transfer is one) and this runs every minute, so the Osmosis
 * records are indexed by kind, addresses and amount and searched by time: the work grows with the rows, not with
 * their product. The Namada rows that name both their addresses are taken first, oldest first, each with the earliest
 * unpaired Osmosis record in its window: with windows of one width that pairs as many records of one key as can be
 * paired. The rows that name the escrow or the shielded pool, which stand for many addresses, are taken after them
 * with the records left, so none takes first the record a row of its own addresses needs (a relayer that delivers a
 * shielded and a transparent crossing of one user and amount in one transaction). A row of its own addresses can
 * still take the one record an escrow row could pair with, and a shielded-pool row the record of an escrow row, so a
 * bounded search then gives an unpaired row a record another row holds whenever that row can move to another record
 * of its own window, directly or through a short chain of such moves (PAIR_AUGMENT_ROWS, PAIR_AUGMENT_LOOKS,
 * PAIR_AUGMENT_DEPTH). When the moves a row needs fit those bounds, as they did in every case tried, it pairs as many
 * as can be paired; past them it does not promise to.
 */
export function unpairedCrossings(namada: any[], osmosis: any[], now: number): { namadaOnly: any[]; osmosisOnly: any[] } {
  const W = PAIR_WINDOW_MS, SETTLE = 30 * 60000;
  // Older Namada rows name the bridge escrow instead of the Osmosis address, and a shielded withdrawal leaves the
  // pool on Namada but is sent from a one-time transparent address on the packet: then the other address, the
  // amount and the time have to do. So a Namada address stands for itself, for any address (the escrow) or for any
  // tnam1 address (the shielded pool), and the Osmosis records are indexed once for each mix of these a Namada row asks.
  // A key is the JSON of [kind, from, to, amount], with 0 for "any address" and 1 for "a tnam1 address", which no
  // address text can be (an Osmosis receiver is text the sender chose).
  type Cls = 'own' | 'any' | 'tnam';
  const clsOf = (a: string | null): Cls => (a === NAMADA.internal.ibc ? 'any' : a === NAMADA.internal.masp ? 'tnam' : 'own');
  const nKey = (c: Cls, a: string | null) => (c === 'own' ? a ?? null : c === 'any' ? 0 : 1);
  // undefined: the record cannot pair with a Namada row of this class (the shielded pool's other address is a tnam1 one).
  const oKey = (c: Cls, b: string | null) => (c === 'own' ? b ?? null : c === 'any' ? 0 : b?.startsWith('tnam1') ? 1 : undefined);
  const keyOf = (kind: unknown, f: string | number | null, t: string | number | null, amount: number) => JSON.stringify([kind, f, t, amount]);
  // Amounts in micro units (NAM has six decimals): one bucket holds one amount, and a Namada row also looks one
  // unit either side, as amounts less than 1e-6 apart have always paired.
  const micro = (x: number) => Math.round(x * 1e6);
  // Records of one time (one block) in the order they were written: by height, then id, the shorter first, so that
  // the packets of one transaction (ids ending :6, :7 … :10) keep their order. The Namada rows are taken in the same
  // order, so two crossings a relayer delivered together are paired in the order they were sent.
  const idOrder = (a: unknown, b: unknown) => { const x = String(a ?? ''), y = String(b ?? ''); return x.length - y.length || (x < y ? -1 : x > y ? 1 : 0); };
  const byTime = (x: any, y: any) => x.ts - y.ts || (Number(x.height) || 0) - (Number(y.height) || 0) || idOrder(x.id, y.id);
  // A bucket's records sorted by time; next[i] leads past records already paired (i itself while it is free).
  type Bucket = { rows: any[]; ts: number[]; next: Int32Array };
  const used = new Set<any>();
  const indexes = new Map<string, Map<string, Bucket>>();
  const indexFor = (fc: Cls, tc: Cls) => {
    let ix = indexes.get(fc + tc);
    if (ix) return ix;
    ix = new Map();
    for (const o of osmosis) {
      const f = oKey(fc, o.from_addr), t = oKey(tc, o.to_addr);
      // A record with no time can never be in a window.
      if (f === undefined || t === undefined || !Number.isFinite(o.ts)) continue;
      const key = keyOf(o.kind, f, t, micro(o.amount_num));
      let b = ix.get(key);
      if (!b) ix.set(key, (b = { rows: [], ts: [], next: new Int32Array(0) }));
      b.rows.push(o);
    }
    for (const b of ix.values()) {
      b.rows.sort(byTime);
      b.ts = b.rows.map((r) => r.ts);
      b.next = Int32Array.from(b.rows, (_, i) => i);
    }
    indexes.set(fc + tc, ix);
    return ix;
  };
  // The first free record at or after i (a record paired through another index is passed over the same way).
  const free = (b: Bucket, i: number) => {
    let r = i;
    while (r < b.rows.length && (b.next[r] !== r || used.has(b.rows[r]))) r = b.next[r] !== r ? b.next[r] : (b.next[r] = r + 1);
    for (let j = i; j < r;) { const nx = b.next[j]; b.next[j] = r; j = nx; }
    return r;
  };
  const firstAtOrAfter = (ts: number[], x: number) => {
    let lo = 0, hi = ts.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (ts[mid] < x) lo = mid + 1; else hi = mid; }
    return lo;
  };
  // The record each paired Namada row holds, and the row each used record is held by.
  const pairOf = new Map<any, any>(), holder = new Map<any, any>();
  const want = (n: any) => (n.kind === 'ibc_in' ? 'ibc_out' : 'ibc_in');
  /** The buckets a Namada row may pair in: its kind, addresses and amount, one micro unit either side. */
  const bucketsOf = (n: any): Bucket[] => {
    const fc = clsOf(n.from_addr), tc = clsOf(n.to_addr);
    const ix = indexFor(fc, tc);
    const f = nKey(fc, n.from_addr), t = nKey(tc, n.to_addr);
    const k = micro(n.amount_num);
    const out: Bucket[] = [];
    for (const d of [0, -1, 1]) { const b = ix.get(keyOf(want(n), f, t, k + d)); if (b) out.push(b); }
    return out;
  };
  const fits = (n: any, o: any) => Math.abs(o.amount_num - n.amount_num) < 1e-6;
  /** The earliest free record in a Namada row's window, or null. */
  const search = (n: any): { b: Bucket; at: number } | null => {
    let best: Bucket | null = null, at = -1;
    for (const b of bucketsOf(n)) {
      const j = free(b, firstAtOrAfter(b.ts, n.ts - W));
      if (j < b.rows.length && b.ts[j] <= n.ts + W && fits(n, b.rows[j]) && (best == null || b.ts[j] < best.ts[at])) { best = b; at = j; }
    }
    return best ? { b: best, at } : null;
  };
  const take = (n: any, hit: { b: Bucket; at: number }) => {
    const o = hit.b.rows[hit.at];
    used.add(o); hit.b.next[hit.at] = hit.at + 1;
    pairOf.set(n, o); holder.set(o, n);
  };
  const timed = namada.filter((n) => Number.isFinite(n.ts)).sort(byTime);
  const own = (n: any) => clsOf(n.from_addr) === 'own' && clsOf(n.to_addr) === 'own';
  const order = [...timed.filter(own), ...timed.filter((n) => !own(n))];
  for (const n of order) {
    const hit = search(n);
    if (hit) take(n, hit);
  }
  // Then a bounded search for chains of moves: a row left unpaired takes a record in its window that another row
  // holds when that row can move to another record of its own window, free or held by a row that can move in turn, at
  // most PAIR_AUGMENT_DEPTH rows down. The pass above can leave one unpaired where both could pair: a Namada row that
  // names the escrow (a packet the parser could not bind) or the shielded pool stands for many addresses, and a row of
  // its own addresses, or another such row, may have taken the earliest record of the one crossing it can pair with.
  // Each unpaired row looks at no more than PAIR_AUGMENT_LOOKS records in all (its window's and those of the rows it
  // would move), and at most PAIR_AUGMENT_ROWS of them get to search past a record another row holds, so the work is
  // bounded for each row and the deeper searches are bounded in all, however many dust rows are unpaired; the most
  // pairs there can be is not promised past those bounds.
  /**
   * A record for `n` (which holds none, or holds the one its caller is taking): a free one in its window, else one
   * another row holds that can itself move on, at most `depth` rows down. `seen`: the records this search has passed
   * on to a deeper row; `budget.looks`: how many records it may still look at; `budget.held`: set once it found a
   * record another row holds (such a search counts toward PAIR_AUGMENT_ROWS).
   */
  const augment = (n: any, depth: number, seen: Set<any>, budget: { looks: number; held: boolean }): boolean => {
    const hit = search(n);
    if (hit) { take(n, hit); return true; }
    if (depth <= 0) return false;
    for (const b of bucketsOf(n)) {
      for (let j = firstAtOrAfter(b.ts, n.ts - W); j < b.rows.length && b.ts[j] <= n.ts + W; j++) {
        if (budget.looks <= 0) return false;
        budget.looks--;
        const o = b.rows[j], n2 = holder.get(o);
        if (n2 == null || n2 === n || seen.has(o) || !fits(n, o)) continue;
        seen.add(o);
        budget.held = true;
        if (augment(n2, depth - 1, seen, budget)) { pairOf.set(n, o); holder.set(o, n); return true; }
      }
    }
    return false;
  };
  let tried = 0;
  for (const n of order) {
    if (tried >= PAIR_AUGMENT_ROWS) break;
    if (pairOf.has(n)) continue;
    const budget = { looks: PAIR_AUGMENT_LOOKS, held: false };
    augment(n, PAIR_AUGMENT_DEPTH, new Set(), budget);
    if (budget.held) tried++;
  }
  const paired = new Set(pairOf.keys());
  const namadaOnly = namada.filter((n) => !paired.has(n) && now - n.ts > SETTLE);
  const osmosisOnly = osmosis.filter((o) => !used.has(o) && now - o.ts > SETTLE);
  return { namadaOnly, osmosisOnly };
}

// ---------------------------------------------------------------- the bulk index: the two chain listings
//
// Every NAM balance and every bond on the chain come from one ABCI answer each (sources/namada.ts). A listing is
// diffed against the stored rows and only the rows that differ are written, so a listing that finds the index
// current costs reads, not writes; a first run on an empty table writes LISTING_WRITE_CAP rows a tick and re-reads
// the listing next tick for the rest. A record of the last listing (kv balance.listing / bond.listing) carries its
// time, height and counts: the overview stamps the holder count with it, and the API treats a row a listing left
// unchanged as confirmed at that time (holders.ts confirmedAt).

/** The record of the last balance listing (kv balance.listing). */
export interface BalanceListingRecord {
  /** when the listing was last read, and when it last went through completely (every differing row written) */
  at: number; completeAt: number | null;
  height: number; provider: string;
  /** keys in the answer; user addresses holding NAM (> 0); their NAM; the answer's decoded size */
  keys: number; holders: number; totalNam: number; bytes: number;
  /** rows written and zeroed this tick, rows still to write, ticks this pass has taken, the read's time */
  written: number; zeroed: number; remaining: number; ticks: number; durationMs: number;
  /** when the span bookkeeping last ran (a complete pass) and when every unchanged span was last extended */
  spansAt: number | null; extendedAt: number | null;
  /** the last read that failed (both nodes) or was refused by the gate, the last error, and how many in a row (the retry backs off) */
  failedAt?: number | null;
  error?: string;
  failures?: number;
  /** the node whose answer the gate last refused; asked last next time */
  refusedProvider?: string | null;
  /** a key count under the shrink floor another node answered, waiting for a second answer to confirm it (shrinkRefusal) */
  smaller?: SmallerCount | null;
  /** rows re-stamped this tick at the listing's height because they were stamped from above floorCeiling */
  unpinned?: number;
}

/** A count under the shrink floor (keys, sources) that a node other than the last listing's answered, and when. */
export interface SmallerCount { count: number; provider: string; at: number }

/** The record of the last bond listing (kv bond.listing). */
export interface BondListingRecord {
  at: number; completeAt: number | null;
  height: number; epoch: number; provider: string;
  /** sources listed (with or without bonds left), sources with bonds, the sum of every bond entry net of slashing in NAM, decoded size */
  sources: number; stakers: number; totalNam: number; bytes: number;
  /** the sum before slashing was taken off, what was slashed, and what the net sum exceeds the chain's total stake by (bonds still in the pipeline; null when the stake was not read that tick) */
  grossNam?: number; slashedNam?: number; pipelineNam?: number | null;
  /** sum of every unbond entry net of slashing (in-flight + withdrawable) decoded from the same listing; undefined when the answer had none */
  unbondingNam?: number;
  written: number; zeroed: number; remaining: number; ticks: number; durationMs: number;
  /** rows already at 0 from another source (the per-address reads before the listing) stamped as the listing's 0 */
  confirmed?: number;
  failedAt?: number | null;
  error?: string;
  failures?: number;
  refusedProvider?: string | null;
  /** a sources count under the shrink floor another node answered, waiting for a second answer to confirm it (shrinkRefusal) */
  smaller?: SmallerCount | null;
  /** rows re-stamped this tick at the listing's height because they were stamped from above floorCeiling */
  unpinned?: number;
}

/** The record of the stake sample (kv stake.sample): a rolling re-read of stakes against the bond listing. */
export interface StakeSampleRecord {
  at: number;
  /** the last address sampled; the next tick continues after it, and starts over after the last one */
  cursor: string;
  checked: number; agreed: number; failed: number;
  /** full passes over every staker so far */
  passes: number;
  /** disagreements of the last SAMPLE_KEEP_MS (a staker is listed once, with its latest sample) */
  disagreements: { address: string; listingNam: number; chainNam: number; epoch: number; at: number }[];
}

/** After one, two, three or more failures in a row the next try waits this many times LISTING_RETRY_MS (5, 15, 60 minutes). */
export const LISTING_RETRY_STEPS = [1, 3, 12];
/** How long after `failures` failures in a row the next read waits. */
export function listingRetryMs(failures: number): number {
  return LISTING_RETRY_MS * LISTING_RETRY_STEPS[Math.min(Math.max(failures, 1), LISTING_RETRY_STEPS.length) - 1];
}

/**
 * A listing is due when there is none, when its last pass has rows left to write, or when its interval has passed;
 * not within the retry wait of a failed or refused read (listingRetryMs: 5 minutes, then 15, then 60, so a slow
 * day does not cost the nodes a cut-off download every five minutes).
 */
export function listingDue(rec: { at: number; remaining: number; failedAt?: number | null; failures?: number } | null | undefined, everyMs: number, now: number): boolean {
  if (rec?.failedAt != null && now - rec.failedAt < listingRetryMs(rec.failures ?? 1)) return false;
  return !rec || rec.remaining > 0 || now - rec.at >= everyMs;
}

const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;

/** A listing whose value passes this share of LISTING_MAX_VALUE_BYTES says how close it is in its row, while there is time to change the reader. */
export const LISTING_HEADROOM_WARN = 0.8;
/** The clause a listing's row adds once its value (decoded bytes) passes LISTING_HEADROOM_WARN of what one read may hold ('' below it). */
export function listingHeadroomNote(bytes: number): string {
  return bytes >= LISTING_HEADROOM_WARN * LISTING_MAX_VALUE_BYTES
    ? `; the answer is ${Math.floor((bytes / LISTING_MAX_VALUE_BYTES) * 100)}% of the ${mb(FETCH_TEXT_MAX_BYTES)} one read may hold`
    : '';
}
/**
 * The row note and record error of a listing read that failed. When every node's answer was past what one read may
 * hold (sources/namada.ts ListingTooLargeError) it says so plainly: asking again will not change it, and the rows stay
 * as of the last complete listing (shown as stale past 6 h) until the reader changes.
 */
export function listingReadFailure(what: 'balance' | 'bond', e: unknown): { note: string; error: string } {
  if (e instanceof ListingTooLargeError) {
    return {
      error: `Too large: past the ${mb(FETCH_TEXT_MAX_BYTES)} one read may hold, from every node`,
      note: `The ${what} listing is too large to read: every node's answer is past the ${mb(FETCH_TEXT_MAX_BYTES)} one read may hold, so ${what === 'bond' ? 'stakes' : 'balances'} stay as of the last complete listing.`,
    };
  }
  return { error: String(e).slice(0, 160), note: `The ${what} listing could not be read: ${String(e).slice(0, 120)}` };
}

/** `rpcs` with the node named `provider` first (the one that served the last listing), the rest in their order. */
export function preferProvider(rpcs: readonly Rpc[], provider: string | null | undefined): readonly Rpc[] {
  const i = provider ? rpcs.findIndex((r) => r.provider === provider) : -1;
  return i > 0 ? [rpcs[i], ...rpcs.slice(0, i), ...rpcs.slice(i + 1)] : rpcs;
}
/**
 * The order a listing asks the nodes in: the node that served the last applied listing first, except that a node
 * whose last answer the gate refused (lagging, short) goes last, so a node 1,000 blocks behind with catching_up
 * false cannot block the listing until it catches up: the other node is asked first.
 */
export function listingRpcs(rpcs: readonly Rpc[], rec: { provider?: string | null; refusedProvider?: string | null } | null | undefined): readonly Rpc[] {
  const avoid = rec?.refusedProvider ?? null;
  const ordered = preferProvider(rpcs, rec?.provider === avoid ? null : rec?.provider);
  if (!avoid) return ordered;
  const rest = ordered.filter((r) => r.provider !== avoid);
  return rest.length ? [...rest, ...ordered.filter((r) => r.provider === avoid)] : ordered;
}
const sameBalance = (a: string | null | undefined, b: string) => a === b || BigInt(a || '0') === BigInt(b);

/** Every row of a table in address order, a page at a time (a page of 20,000 rows is about 2 MB of D1 answer). */
async function pagedRows<T extends { address: string }>(db: D1Database, select: string, pageSize = 20_000): Promise<T[]> {
  const out: T[] = [];
  let after = '';
  for (;;) {
    const page = (await db.prepare(`${select} AND address > ? ORDER BY address LIMIT ?`).bind(after, pageSize).all<T>()).results || [];
    out.push(...page);
    if (page.length < pageSize) return out;
    after = page[page.length - 1].address;
  }
}

export type BalanceLister = (opts: ReadOpts) => Promise<BalanceListing & { height: number; provider: string }>;
export type BondLister = (opts: ReadOpts) => Promise<BondListing & { height: number; provider: string }>;

/** A block height past this is not a height (a timestamp sent as one would be): the gate refuses the listing. */
export const MAX_REASONABLE_HEIGHT = 1_000_000_000;
/** How far behind the tick's head a listing's node may be (100 blocks, about ten minutes) and how far "ahead" (node skew) before its answer is refused. */
export const MAX_LISTING_HEIGHT_DRIFT = 100;
export const MAX_LISTING_HEIGHT_AHEAD = 100;
/** The balances in a listing add up to the minted key it carries exactly (checked to the base unit on 2026-10-20); one part in a million is allowed. */
export const LISTING_SUM_TOLERANCE = 1e-6;
/** The listing's minted key must match the tick's own supply read (a different node, a few blocks apart) within this fraction. */
export const LISTING_SUPPLY_TOLERANCE = 0.001;
/** The bond listing's net sum must be within this fraction of the tick's total-stake read (bonds in the pipeline run it a little over). */
export const LISTING_STAKE_TOLERANCE = 0.02;
/** A listing with fewer keys or sources than this fraction of the previous answer's is a short answer, not a change on the chain. */
export const LISTING_SHRINK_FLOOR = 0.9;
/** A smaller count is confirmed by a second answer within this fraction of it (shrinkRefusal). */
export const LISTING_COUNT_CONFIRM = 0.01;

/** What a tick knows that a listing is checked against before it is applied (balanceGate, bondGate). */
export interface ListingContext {
  /**
   * The chain's head this tick: the lowest node height another of this tick's answers agrees with (sources/namada.ts
   * listingHeads, the indexer's latest block among the answers). null when no two answers agree: no listing is then
   * applied. Left out by a caller with no statuses to check against, which skips the head checks.
   */
  headHeight?: number | null;
  /** two nodes agree on headHeight (listingHeads `byNodes`), not one node and the indexer: see floorCeiling */
  headByNodes?: boolean;
  /**
   * the highest node height another answer agrees with (listingHeads `top`): stored heights are set aside only above
   * it, so rows the live scan wrote from the higher node's blocks while a listing streamed are never taken back
   */
  headTop?: number | null;
  /** this tick's minted-supply read (base units), checked against the balance listing's minted key */
  supplyBase?: bigint | null;
  /** this tick's total-stake read (NAM), checked against the bond listing's net sum */
  stakeNam?: number | null;
}

const n0 = (n: number) => n.toLocaleString('en-US');
/** |a − b| / b as a fraction (nine decimals, exact enough for a tolerance of one part in a million). */
const fracOff = (a: bigint, b: bigint) => Number(((a > b ? a - b : b - a) * 1_000_000_000n) / b) / 1e9;

/**
 * A height above this is not one the chain has reached: MAX_LISTING_HEIGHT_AHEAD blocks above the head this tick's
 * answers agree on (listingHeads); null when they agree on none, or the caller gave no head. A listing from above it
 * is refused (heightGate: ahead of the head), and an internal account's read from above it keeps no height. A stored
 * height is set aside only far above it (floorCeiling). Only an agreed head sets a height aside: one node's word, a
 * node restored from an old snapshot or two nodes catching up, never does.
 */
export function heightCeiling(headHeight: number | null | undefined): number | null {
  return headHeight != null && Number.isFinite(headHeight) && headHeight > 0 ? headHeight + MAX_LISTING_HEIGHT_AHEAD : null;
}
/**
 * How far above a head one node and the indexer agree on a stored height must be before it is set aside (10,000
 * blocks, about 19 hours). A stored height a little above such a head is not one the chain lacks: a node stuck behind
 * without saying it is catching up and an indexer lagging as far can agree on a head below it, and setting it aside
 * then would apply their older listing over newer rows. On a head two nodes agree on, MAX_LISTING_HEIGHT_AHEAD is
 * enough: two node operators are not behind by the same blocks together.
 */
export const FLOOR_SET_ASIDE_BLOCKS = 10_000;
/**
 * Stored listing heights and rows stamped above this are set aside: MAX_LISTING_HEIGHT_AHEAD above a head two nodes
 * agree on (`byNodes`), FLOOR_SET_ASIDE_BLOCKS above one a node and the indexer agree on; null with no agreed head.
 */
export function floorCeiling(headHeight: number | null | undefined, byNodes = false): number | null {
  return headHeight != null && Number.isFinite(headHeight) && headHeight > 0 ? headHeight + (byNodes ? MAX_LISTING_HEIGHT_AHEAD : FLOOR_SET_ASIDE_BLOCKS) : null;
}
/** Whether the last listing's height is set aside this tick (above floorCeiling): its height and its counts are then no floor. */
const setAside = (prev: { completeAt: number | null; height: number } | null | undefined, headHeight: number | null | undefined, byNodes = false): boolean => {
  const ceiling = floorCeiling(headHeight, byNodes);
  return ceiling != null && !!prev?.completeAt && prev.height > ceiling;
};
/** What a listing applied over heights above the ceiling says in its health note (the last listing's height, rows re-stamped); '' when there were none. */
function setAsideNote(ceiling: number | null, prev: { completeAt: number | null; height: number } | null | undefined, rows: number): string {
  const floor = ceiling != null && prev?.completeAt && prev.height > ceiling ? prev.height : null;
  if (ceiling == null || (!floor && !rows)) return '';
  return `; heights above ${n0(ceiling)} (past the head this tick's answers agree on) set aside: ${floor ? `the last listing's ${n0(floor)}, ` : ''}${n0(rows)} rows re-stamped`;
}

/**
 * The height part of the gates: a listing is applied only on a head this tick's answers agree on (listingHeads), when
 * its node is at that head within MAX_LISTING_HEIGHT_DRIFT blocks (a node catching up lists old balances as current
 * and would zero every holder it has not reached) and at most MAX_LISTING_HEIGHT_AHEAD above it, and not older than
 * the listing already applied (the previous record's height), unless that height is above floorCeiling: one node's
 * answer from a height the chain had not reached would otherwise refuse every later listing for good.
 */
function heightGate(what: string, height: number, headHeight: number | null | undefined, prevHeight: number | null | undefined, byNodes = false, top?: number | null): string | null {
  if (!Number.isInteger(height) || height <= 0 || height > MAX_REASONABLE_HEIGHT) return `the ${what} came with an invalid height ${height}`;
  if (headHeight === null) return `no two of this tick's answers agree on the chain's head, so the ${what}'s height cannot be checked`;
  const ceiling = floorCeiling(top ?? headHeight, byNodes);
  if (prevHeight && height < prevHeight && (ceiling == null || prevHeight <= ceiling)) return `the ${what} is from height ${n0(height)}, older than the one already applied (${n0(prevHeight)})`;
  if (headHeight != null && headHeight > 0) {
    if (height < headHeight - MAX_LISTING_HEIGHT_DRIFT) return `the ${what} is from height ${n0(height)}, ${n0(headHeight - height)} blocks behind the head (${n0(headHeight)})`;
    if (height > headHeight + MAX_LISTING_HEIGHT_AHEAD) return `the ${what} is from height ${n0(height)}, ahead of the head (${n0(headHeight)})`;
  }
  return null;
}

/**
 * Whether a balance listing may be applied. Its node must be at the head (heightGate), and the answer whole: every
 * balance in it (user keys and the internal accounts) must add up to the chain's minted total, which the same
 * answer carries (LISTING_SUM_TOLERANCE: they agree to the base unit), that total must match this tick's own
 * supply read (LISTING_SUPPLY_TOLERANCE), and the answer may not have shrunk below LISTING_SHRINK_FLOOR of the
 * previous one's keys. An empty or short answer (a borsh Vec of 0 parses) fails here, never in the rows.
 */
export function balanceGate(listing: (BalanceListing & { height: number; provider?: string }) | null | undefined, ctx: ListingContext & { prev?: BalanceListingRecord | null } = {}): { ok: boolean; reason?: string; sumBase: bigint; mintedBase: bigint; smaller?: { count: number; provider: string } } {
  const no = (reason: string, sumBase = 0n, mintedBase = 0n) => ({ ok: false, reason, sumBase, mintedBase });
  if (!listing || listing.entries.size === 0) return no('the balance listing is empty');
  const h = heightGate('balance listing', listing.height, ctx.headHeight, ctx.prev?.completeAt ? ctx.prev.height : null, ctx.headByNodes, ctx.headTop);
  if (h) return no(h);
  if (!listing.minted) return no('the balance listing has no minted total to check against');
  let mintedBase = 0n;
  try { mintedBase = BigInt(listing.minted); } catch { return no('the minted total could not be read'); }
  if (mintedBase <= 0n) return no('the minted total is not positive', 0n, mintedBase);
  let sumBase = 0n;
  for (const v of listing.entries.values()) sumBase += BigInt(v);
  for (const v of listing.internal.values()) sumBase += BigInt(v);
  const off = fracOff(sumBase, mintedBase);
  if (off > LISTING_SUM_TOLERANCE) return no(`the balances in the listing add up to ${n0(Math.round(Number(sumBase) / 1e6))} NAM, ${(off * 100).toFixed(off < 0.0001 ? 4 : 2)}% off the minted total (${n0(Math.round(Number(mintedBase) / 1e6))} NAM)`, sumBase, mintedBase);
  if (ctx.supplyBase != null && ctx.supplyBase > 0n) {
    const offSupply = fracOff(mintedBase, ctx.supplyBase);
    if (offSupply > LISTING_SUPPLY_TOLERANCE) return no(`the listing's minted total (${n0(Math.round(Number(mintedBase) / 1e6))} NAM) is ${(offSupply * 100).toFixed(2)}% off this tick's supply read (${n0(Math.round(Number(ctx.supplyBase) / 1e6))} NAM)`, sumBase, mintedBase);
  }
  const short = shrinkRefusal(listing.keys, listing.provider, ctx.prev ? { ...ctx.prev, count: ctx.prev.keys } : null, ctx.headTop ?? ctx.headHeight, ctx.headByNodes);
  if (short) return { ...no(`the listing has ${n0(listing.keys)} keys, under ${LISTING_SHRINK_FLOOR * 100}% of the last one's ${n0(ctx.prev!.keys)}`, sumBase, mintedBase), smaller: short.smaller };
  return { ok: true, sumBase, mintedBase };
}

/**
 * The short-answer check of the gates (LISTING_SHRINK_FLOOR on balanceGate's keys, bondGate's sources): null when
 * `count` may be applied, else what to record. The floor is the last complete listing's count, unless its height is
 * set aside this tick (setAside: a listing from a height the chain has not reached gives no floor either). One answer
 * must not set a floor for good: a node that pads its answer (keys of addresses holding nothing, sources with no bond
 * left) would have every honest listing after it refused. So a count under the floor from another node than the one
 * whose listing set it is kept in the record (`smaller`), and a later answer within LISTING_COUNT_CONFIRM of it, from
 * either node, is applied. A short answer from the node that set the count, or one no second answer confirms, is
 * still refused, as every short answer is the first time.
 */
function shrinkRefusal(count: number, provider: string | undefined, prev: { completeAt: number | null; height: number; provider: string; count: number; smaller?: SmallerCount | null } | null, headHeight: number | null | undefined, byNodes = false): { smaller?: { count: number; provider: string } } | null {
  if (!prev?.completeAt || !(prev.count > 0) || count >= prev.count * LISTING_SHRINK_FLOOR || setAside(prev, headHeight, byNodes)) return null;
  const pending = prev.smaller;
  if (pending && pending.count > 0 && Math.abs(count - pending.count) <= pending.count * LISTING_COUNT_CONFIRM) return null;
  return { smaller: provider && provider !== prev.provider ? { count, provider } : undefined };
}

/**
 * Whether a bond listing may be applied: a node at the head (heightGate), a non-empty stake set, its net sum
 * within LISTING_STAKE_TOLERANCE of this tick's total-stake read (the coverage check's own bound), and no shrink
 * below LISTING_SHRINK_FLOOR of the previous answer's sources.
 */
export function bondGate(listing: (BondListing & { height: number; provider?: string }) | null | undefined, ctx: ListingContext & { prev?: BondListingRecord | null } = {}): { ok: boolean; reason?: string; smaller?: { count: number; provider: string } } {
  if (!listing || listing.sources.size === 0 || listing.totalBase <= 0n) return { ok: false, reason: 'the bond listing is empty' };
  const h = heightGate('bond listing', listing.height, ctx.headHeight, ctx.prev?.completeAt ? ctx.prev.height : null, ctx.headByNodes, ctx.headTop);
  if (h) return { ok: false, reason: h };
  if (ctx.stakeNam != null && ctx.stakeNam > 0) {
    const totalNam = Number(listing.totalBase) / 1e6;
    const off = Math.abs(totalNam - ctx.stakeNam) / ctx.stakeNam;
    if (off > LISTING_STAKE_TOLERANCE) return { ok: false, reason: `the bonds in the listing add up to ${n0(Math.round(totalNam))} NAM, ${(off * 100).toFixed(1)}% off this tick's total stake (${n0(Math.round(ctx.stakeNam))} NAM)` };
  }
  const short = shrinkRefusal(listing.sources.size, listing.provider, ctx.prev ? { ...ctx.prev, count: ctx.prev.sources } : null, ctx.headTop ?? ctx.headHeight, ctx.headByNodes);
  if (short) return { ok: false, reason: `the listing names ${n0(listing.sources.size)} sources, under ${LISTING_SHRINK_FLOOR * 100}% of the last one's ${n0(ctx.prev!.sources)}`, smaller: short.smaller };
  return { ok: true };
}

/**
 * Read every NAM balance from the chain and reconcile the Namada holder rows with it: rows whose stored balance
 * differs (or that are new and hold NAM, or were last written by another source) are written with the listing's
 * height and time; stored rows the listing no longer has are zeroed; the balance spans are kept (holders.ts
 * listingSpanStmts) once a pass is complete. At most LISTING_WRITE_CAP rows a tick: what is left is written next
 * tick, after re-reading the listing (the diff is recomputed, so nothing is written twice or lost); the zeroing
 * counts against the same cap. Zero balances the chain lists are not given rows (26,404 of 90,777 keys on
 * 2026-10-20 held nothing). A listing the gate refuses (balanceGate: a lagging node, a short answer) changes
 * nothing and is said so.
 */
export async function runBalanceListing(env: Env, health: SourceHealth[], now: number, read: ReadOpts, list: BalanceLister = allNamBalances, cap = LISTING_WRITE_CAP, ctx: ListingContext = {}): Promise<BalanceListingRecord | null> {
  const name = 'Namada RPC (balance listing)';
  const prev = await kvGetJson<BalanceListingRecord>(env.DB, 'balance.listing').catch(() => null);
  const t0 = Date.now();
  let listing: Awaited<ReturnType<BalanceLister>>;
  try {
    listing = await list({ timeoutMs: LISTING_TIMEOUT_MS, retries: 0, ...read });
  } catch (e) {
    const why = listingReadFailure('balance', e);
    health.push({ name, ok: false, at: now, note: why.note });
    // The record remembers the failure (the next try waits LISTING_RETRY_MS); a pass already complete stays complete.
    const failed: BalanceListingRecord = { ...(prev ?? { at: 0, completeAt: null, height: 0, provider: '', keys: 0, holders: 0, totalNam: 0, bytes: 0, written: 0, zeroed: 0, remaining: 0, ticks: 0, durationMs: 0, spansAt: null, extendedAt: null }), failedAt: now, error: why.error, failures: (prev?.failures ?? 0) + 1 };
    await kvSet(env.DB, 'balance.listing', failed).catch(() => {});
    return failed;
  }
  const gate = balanceGate(listing, { ...ctx, prev });
  if (!gate.ok) {
    // Refused: the rows stay as they are and the pass stays where it was; the record and the sheet say why.
    const error = `Not applied: ${gate.reason}`;
    health.push({ name, ok: false, at: now, note: `The balance listing from ${listing.provider} was not applied: ${gate.reason}`.slice(0, 160) });
    // The node whose answer was refused is asked last next time (listingRpcs): a node 1,000 blocks behind with catching_up false would otherwise be asked first until it caught up.
    const refused: BalanceListingRecord = { ...(prev ?? { at: 0, completeAt: null, height: 0, provider: '', keys: 0, holders: 0, totalNam: 0, bytes: 0, written: 0, zeroed: 0, remaining: 0, ticks: 0, durationMs: 0, spansAt: null, extendedAt: null }), failedAt: now, error, failures: (prev?.failures ?? 0) + 1, refusedProvider: listing.provider };
    // A smaller key count from another node than the last listing's waits for a second answer to confirm it (shrinkRefusal).
    if (gate.smaller) refused.smaller = { ...gate.smaller, at: now };
    await kvSet(env.DB, 'balance.listing', refused).catch(() => {});
    return refused;
  }
  const ticks = (prev && prev.remaining > 0 ? prev.ticks : 0) + 1;
  const rec: BalanceListingRecord = {
    at: now, completeAt: prev?.completeAt ?? null, height: listing.height, provider: listing.provider,
    keys: listing.keys, holders: 0, totalNam: 0, bytes: listing.bytes,
    written: 0, zeroed: 0, remaining: 0, ticks, durationMs: 0, spansAt: prev?.spansAt ?? null, extendedAt: prev?.extendedAt ?? null, failedAt: null, failures: 0, refusedProvider: null,
  };
  try {
    // Rows with a reading only: since migration 0008 a staker with no spendable NAM has a row with none (its place on
    // the stored totals); to the listing such an address is not stored, as before (no '0' is written over it, a
    // first NAM is a new holder).
    const stored = await pagedRows<{ address: string; balance: string; balance_num: number; updated_height: number | null; verified_src: string | null; updated_at: number | null; first_seen: number | null }>(
      env.DB, `SELECT address, balance, balance_num, updated_height, verified_src, updated_at, first_seen FROM holders WHERE chain = 'namada' AND ${HAS_READING('')}`);
    // Rows stamped from above floorCeiling (one node's answer from a height the chain has not reached) would refuse
    // every later write; they are re-stamped at this listing's height first, and the diff below writes or confirms them.
    const ceiling = floorCeiling(ctx.headTop ?? ctx.headHeight, ctx.headByNodes);
    const pinned = ceiling == null ? [] : stored.filter((s) => (s.updated_height ?? 0) > ceiling);
    if (ceiling != null && pinned.length) {
      rec.unpinned = await runBatch(env.DB, listingUnpinStmts(pinned.map((s) => s.address), listing.height, ceiling));
      for (const s of pinned) s.updated_height = listing.height;
    }
    const aside = setAsideNote(ceiling, prev, pinned.length);
    const storedBy = new Map(stored.map((r) => [r.address, r]));
    const toWrite: ListedBalance[] = [];
    let totalBase = 0n;
    for (const [address, balance] of listing.entries) {
      if (balance !== '0') { rec.holders++; totalBase += BigInt(balance); }
      const s = storedBy.get(address);
      if (!s) { if (balance !== '0') toWrite.push({ address, balance }); continue; }
      // The block follower wrote this row from a later block than the listing's: its post-balance is newer (the
      // write guard would refuse the listing's anyway), so the row is not counted as pending.
      if ((s.updated_height ?? 0) > listing.height) continue;
      if (s.verified_src !== BALANCE_LISTING_SRC || !sameBalance(s.balance, balance)) toWrite.push({ address, balance });
    }
    rec.totalNam = Number(totalBase) / 1e6;
    const toZero = stored.filter((s) => !listing.entries.has(s.address) && s.balance_num > 0 && !INTERNAL_ADDRS.includes(s.address) && (s.updated_height ?? 0) <= listing.height).map((s) => s.address);
    toWrite.sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
    const part = toWrite.slice(0, cap);
    // The zeroing follows the writes, under the same cap: a pass is complete when both are done.
    const zeroPart = toZero.slice(0, Math.max(0, cap - part.length));
    rec.remaining = (toWrite.length - part.length) + (toZero.length - zeroPart.length);
    if (part.length) rec.written = await runBatch(env.DB, listingBalanceStmts(part, listing.height, now));
    if (zeroPart.length) rec.zeroed = await runBatch(env.DB, listingZeroStmts(zeroPart, listing.height, now));
    if (rec.remaining === 0) {
      rec.completeAt = now;
      // The holder keys of a complete listing (series.ts: holders.namada, .new_1h, .gone_1h, .under1, .user_nam) and its listings row.
      await series.balanceListingSeries(env.DB, now, listing.entries, stored, listing).catch((e) => console.error('holder listing series', e));
      // Spans: a separate batch, so a missing table (migration not applied) never undoes the balances.
      const extend = rec.extendedAt == null || now - rec.extendedAt >= SPAN_EXTEND_MS;
      try {
        await runBatch(env.DB, listingSpanStmts(now, listing.height, rec.spansAt, extend));
        rec.spansAt = now;
        if (extend) rec.extendedAt = now;
      } catch (e) {
        console.error('namada balance spans', e);
      }
    }
    rec.durationMs = Date.now() - t0;
    health.push({ name, ok: true, at: now, latencyMs: rec.durationMs, note:
      `${listing.keys.toLocaleString('en-US')} balance keys at height ${listing.height.toLocaleString('en-US')} (${mb(listing.bytes)} from ${listing.provider}): `
      + `${rec.holders.toLocaleString('en-US')} addresses hold ${Math.round(rec.totalNam).toLocaleString('en-US')} NAM; ${rec.written.toLocaleString('en-US')} rows written`
      + (rec.zeroed ? `, ${rec.zeroed} zeroed` : '') + (rec.remaining ? `, ${rec.remaining.toLocaleString('en-US')} left for the next tick` : '') + aside + listingHeadroomNote(listing.bytes) });
  } catch (e) {
    // Not applied: the record says so and keeps the pass open, so the next tick reads the listing again.
    rec.remaining = Math.max(1, rec.remaining);
    rec.error = String(e).slice(0, 160);
    rec.durationMs = Date.now() - t0;
    health.push({ name, ok: false, at: now, latencyMs: rec.durationMs, note: `The balance listing was read but not applied: ${rec.error.slice(0, 120)}` });
  }
  await kvSet(env.DB, 'balance.listing', rec).catch(() => {});
  return rec;
}

/**
 * Whether the cron asks the indexer for the unlock list's withdraw times (at a 10-minute mark): when no bond listing
 * has completed in three intervals, or the stored map is older than the last one that did (its write did not land).
 * Once the indexer's map is stored it is newer than that listing, so it is asked again only after the next listing
 * that completes without its write, or when the listings stop.
 */
export function withdrawFallbackDue(completeAt: number | null | undefined, storedAt: number | null | undefined, now: number): boolean {
  if (!completeAt || now - completeAt >= 3 * BOND_LISTING_MS) return true;
  return !(storedAt != null && Number.isFinite(storedAt) && storedAt >= completeAt);
}

/**
 * Read every bond from the chain and reconcile the stakes rows with it: each source's bonded sum and per-validator
 * delegations go to `stakes` (bonded_num, delegations, verified_epoch, verified_at, verified_src BOND_LISTING_SRC)
 * when they differ from the row, with the same cap and carry-over as the balance listing. The listing is every
 * bond on the chain, so a stored row it does not name has no bonds: rows with bonded_num > 0, and rows that only
 * ever had a flow-history estimate (bonded_num NULL), are set to 0 under the same cap. Sources the listing names
 * with no bond left (only unbonds, or slashed whole) get no new row. Each source's sum is net of slashing
 * (sources/namada.ts parseBondListing); it still includes bonds in the pipeline, which the coverage check says.
 * A listing the gate refuses (bondGate) changes nothing and is said so.
 */
export async function runBondListing(env: Env, health: SourceHealth[], now: number, epoch: number, read: ReadOpts, list: BondLister = allBonds, cap = LISTING_WRITE_CAP, ctx: ListingContext = {}): Promise<BondListingRecord | null> {
  const name = 'Namada RPC (bond listing)';
  const prev = await kvGetJson<BondListingRecord>(env.DB, 'bond.listing').catch(() => null);
  const t0 = Date.now();
  let listing: Awaited<ReturnType<BondLister>>;
  try {
    listing = await list({ timeoutMs: LISTING_TIMEOUT_MS, retries: 0, ...read });
  } catch (e) {
    const why = listingReadFailure('bond', e);
    health.push({ name, ok: false, at: now, note: why.note });
    const failed: BondListingRecord = { ...(prev ?? { at: 0, completeAt: null, height: 0, epoch, provider: '', sources: 0, stakers: 0, totalNam: 0, bytes: 0, written: 0, zeroed: 0, remaining: 0, ticks: 0, durationMs: 0 }), failedAt: now, error: why.error, failures: (prev?.failures ?? 0) + 1 };
    await kvSet(env.DB, 'bond.listing', failed).catch(() => {});
    return failed;
  }
  const gate = bondGate(listing, { ...ctx, prev });
  if (!gate.ok) {
    const error = `Not applied: ${gate.reason}`;
    health.push({ name, ok: false, at: now, note: `The bond listing from ${listing.provider} was not applied: ${gate.reason}`.slice(0, 160) });
    const refused: BondListingRecord = { ...(prev ?? { at: 0, completeAt: null, height: 0, epoch, provider: '', sources: 0, stakers: 0, totalNam: 0, bytes: 0, written: 0, zeroed: 0, remaining: 0, ticks: 0, durationMs: 0 }), failedAt: now, error, failures: (prev?.failures ?? 0) + 1, refusedProvider: listing.provider };
    if (gate.smaller) refused.smaller = { ...gate.smaller, at: now };
    await kvSet(env.DB, 'bond.listing', refused).catch(() => {});
    return refused;
  }
  const ticks = (prev && prev.remaining > 0 ? prev.ticks : 0) + 1;
  const totalNam = Number(listing.totalBase) / 1e6;
  const rec: BondListingRecord = {
    at: now, completeAt: prev?.completeAt ?? null, height: listing.height, epoch, provider: listing.provider,
    sources: listing.sources.size, stakers: 0, totalNam, bytes: listing.bytes,
    grossNam: Number(listing.grossBase) / 1e6, slashedNam: Number(listing.slashedBase) / 1e6, pipelineNam: ctx.stakeNam != null ? totalNam - ctx.stakeNam : null,
    // no 0 for a missing figure: a listing without unbonds leaves it undefined
    unbondingNam: listing.unbondingBase != null ? Number(listing.unbondingBase) / 1e6 : undefined,
    written: 0, zeroed: 0, remaining: 0, ticks, durationMs: 0, failedAt: null, failures: 0, refusedProvider: null,
  };
  try {
    const stored = await pagedRows<{ address: string; bonded_num: number | null; estimated_num: number | null; delegations: string | null; verified_src: string | null; verified_height: number | null }>(
      env.DB, `SELECT address, bonded_num, estimated_num, delegations, verified_src, verified_height FROM stakes WHERE 1 = 1`);
    // As the balance listing: rows stamped from above floorCeiling are re-stamped at this listing's height first.
    const ceiling = floorCeiling(ctx.headTop ?? ctx.headHeight, ctx.headByNodes);
    const pinned = ceiling == null ? [] : stored.filter((s) => (s.verified_height ?? 0) > ceiling);
    if (ceiling != null && pinned.length) {
      rec.unpinned = await runBatch(env.DB, stmt.stakesUnpin(pinned.map((s) => s.address), listing.height, ceiling));
      for (const s of pinned) s.verified_height = listing.height;
    }
    const aside = setAsideNote(ceiling, prev, pinned.length);
    const storedBy = new Map(stored.map((r) => [r.address, r]));
    const toWrite: { address: string; bondedNam: number; delegations: { validator: string; amountNam: number }[] }[] = [];
    for (const [address, b] of listing.sources) {
      const bondedNam = Number(b.bondedBase) / 1e6;
      if (b.bondedBase > 0n) rec.stakers++;
      const s = storedBy.get(address);
      if (!s) { if (b.bondedBase > 0n) toWrite.push({ address, bondedNam, delegations: b.delegations }); continue; }
      // A row from a later height than the listing's (a newer listing's) is not pending: the write guard would refuse it.
      if ((s.verified_height ?? 0) > listing.height) continue;
      if (s.verified_src !== BOND_LISTING_SRC || s.bonded_num !== bondedNam || s.delegations !== JSON.stringify(b.delegations)) toWrite.push({ address, bondedNam, delegations: b.delegations });
    }
    // Not named by the listing: a stake the chain no longer lists, or an estimate from the flow history for an
    // address the chain never listed a bond for (an estimate alone must not make a holder: H3, 2026-10-20).
    const toZero = stored.filter((s) => !listing.sources.has(s.address) && ((s.bonded_num ?? 0) > 0 || (s.bonded_num == null && (s.estimated_num ?? 0) > 0)) && (s.verified_height ?? 0) <= listing.height).map((s) => s.address);
    // Not named by the listing and already 0, but from another source (the per-address reads before the listing):
    // the listing confirms the 0, so the row takes its source and time. Otherwise the row keeps its old read time,
    // and every figure that takes the oldest reading behind it (the top 10's) reads as old for ever.
    const toConfirm = stored.filter((s) => !listing.sources.has(s.address) && s.bonded_num === 0 && s.verified_src !== BOND_LISTING_SRC && (s.verified_height ?? 0) <= listing.height).map((s) => s.address);
    toWrite.sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
    const part = toWrite.slice(0, cap);
    const zeroPart = toZero.slice(0, Math.max(0, cap - part.length));
    const confirmPart = toConfirm.slice(0, Math.max(0, cap - part.length - zeroPart.length));
    rec.remaining = (toWrite.length - part.length) + (toZero.length - zeroPart.length) + (toConfirm.length - confirmPart.length);
    const zeroRows = (a: string[]) => stmt.stakesVerified(a.map((address) => ({ address, bondedNam: 0, delegations: [] })), epoch, listing.height, now, BOND_LISTING_SRC);
    if (part.length) rec.written = await runBatch(env.DB, stmt.stakesVerified(part, epoch, listing.height, now, BOND_LISTING_SRC));
    if (zeroPart.length) rec.zeroed = await runBatch(env.DB, zeroRows(zeroPart));
    if (confirmPart.length) rec.confirmed = await runBatch(env.DB, zeroRows(confirmPart));
    const wname = 'Namada RPC (unbond withdraw times)';
    let withdrawHealth: SourceHealth | null = null;
    if (rec.remaining === 0) {
      rec.completeAt = now;
      // The stake keys, the unbond queue, validator_daily and the listings row (series.ts).
      await series.bondListingSeries(env.DB, now, listing, epoch, ctx.stakeNam ?? null).catch((e) => console.error('bond listing series', e));
      // Persist consensus unbond maturity schedule and withdraw cache directly from the decoded bond listing
      try {
        // Without the chain parameters there is no epoch length and no clock time for an unbond (the epoch alone is kept).
        const params = await cachedChainParams(env.DB);
        const epochSec = params ? Math.max(params.minEpochSec, params.epochSec ?? params.minEpochSec) : null;
        const { termStructure, withdrawCache } = buildUnbondTermStructure(listing, listing.height, epoch, now, epochSec, params ? (params.epochSecNote ?? `at least ${params.minEpochSec} s, the chain's minimum`) : null);
        const [term, withdraw] = await Promise.allSettled([
          kvSet(env.DB, 'unbond.term_structure', termStructure),
          kvSet(env.DB, 'unbond.withdraw', withdrawCache),
        ]);
        // The term structure carries its own age (pressure() stamps it). The withdraw times say here whether they were
        // stored: a write D1 refuses is on the Sources sheet, the stored map keeps its own time (pressure() stops using
        // it once it is old), and the cron asks the indexer at the next 10-minute mark (withdrawFallbackDue).
        if (term.status === 'rejected') console.error('unbond term structure', term.reason);
        if (withdraw.status === 'rejected') {
          console.error('unbond withdraw times', withdraw.reason);
          withdrawHealth = { name: wname, ok: false, at: now, note: `Not stored (${String(withdraw.reason).slice(0, 50)}): the unlock list uses the last ones while under ${UNBOND_WITHDRAW_STALE_MS / 60_000} min old, and the indexer is asked meanwhile.`.slice(0, 160) };
        } else {
          const n = Object.values(withdrawCache.byAddress).reduce((a, l) => a + l.length, 0), by = Object.keys(withdrawCache.byAddress).length;
          withdrawHealth = { name: wname, ok: true, at: now, note: `${n0(n)} ${n === 1 ? 'unbond' : 'unbonds'} of ${n0(UNLOCKS_MIN_NAM)} NAM or more (${n0(by)} ${by === 1 ? 'address' : 'addresses'}) at height ${n0(listing.height)}` };
        }
      } catch (e) {
        console.error('unbond term structure', e);
        withdrawHealth = { name: wname, ok: false, at: now, note: `Not built from the bond listing: ${String(e).slice(0, 120)}` };
      }
    }
    rec.durationMs = Date.now() - t0;
    health.push({ name, ok: true, at: now, latencyMs: rec.durationMs, note:
      `${listing.entries.toLocaleString('en-US')} bond entries at height ${listing.height.toLocaleString('en-US')} (${mb(listing.bytes)} from ${listing.provider}): `
      + `${rec.stakers.toLocaleString('en-US')} addresses stake ${Math.round(rec.totalNam).toLocaleString('en-US')} NAM`
      + (rec.slashedNam ? ` (${Math.round(rec.slashedNam).toLocaleString('en-US')} NAM of slashed bonds left out)` : '')
      + `; ${rec.written.toLocaleString('en-US')} rows written`
      + (rec.zeroed ? `, ${rec.zeroed} set to 0` : '') + (rec.confirmed ? `, ${rec.confirmed.toLocaleString('en-US')} confirmed at 0` : '') + (rec.remaining ? `, ${rec.remaining.toLocaleString('en-US')} left for the next tick` : '') + aside + listingHeadroomNote(listing.bytes) });
    if (withdrawHealth) health.push(withdrawHealth);
  } catch (e) {
    rec.remaining = Math.max(1, rec.remaining);
    rec.error = String(e).slice(0, 160);
    rec.durationMs = Date.now() - t0;
    health.push({ name, ok: false, at: now, latencyMs: rec.durationMs, note: `The bond listing was read but not applied: ${rec.error.slice(0, 120)}` });
  }
  await kvSet(env.DB, 'bond.listing', rec).catch(() => {});
  return rec;
}

/**
 * A sample of stakers re-read with delegations_at (the chain's bonded amount at this epoch, self-bond included) and
 * compared with the bond listing's row: SAMPLE_PER_TICK a tick in address order, round and round. A difference
 * (a bond still in the pipeline, a slash) is recorded for the coverage check, never written to the row (owner
 * decision 7: the listing is the chain's figure too, and a row is not marked for a known reason).
 */
export async function sampleStakes(env: Env, health: SourceHealth[], now: number, epoch: number, read: ReadOpts): Promise<StakeSampleRecord | null> {
  const name = 'Namada RPC (stake sample)';
  const prev = await kvGetJson<StakeSampleRecord>(env.DB, 'stake.sample').catch(() => null);
  const rec: StakeSampleRecord = {
    at: now, cursor: prev?.cursor ?? '', checked: 0, agreed: 0, failed: 0, passes: prev?.passes ?? 0,
    disagreements: (prev?.disagreements ?? []).filter((d) => now - d.at < SAMPLE_KEEP_MS),
  };
  if (read.signal?.aborted) {
    // The phase's time was used before the sample's turn (a long listing apply): nothing is wrong with the chain reads.
    health.push({ name, ok: true, at: now, note: 'Not run this tick: the bond listing used its time.' });
    return prev;
  }
  let rows: { address: string; bonded_num: number }[];
  try {
    const q = `SELECT address, bonded_num FROM stakes WHERE verified_src = ? AND bonded_num > 0 AND address > ? ORDER BY address LIMIT ?`;
    rows = (await env.DB.prepare(q).bind(BOND_LISTING_SRC, rec.cursor, SAMPLE_PER_TICK).all<{ address: string; bonded_num: number }>()).results || [];
  } catch (e) {
    health.push({ name, ok: false, at: now, note: `The stakes to sample could not be listed: ${String(e).slice(0, 120)}` });
    return prev;
  }
  const lastPage = rows.length < SAMPLE_PER_TICK;
  let attempted = 0, cut = 0, lastAttempted: string | null = null;
  const fresh = new Map<string, StakeSampleRecord['disagreements'][number]>();
  for (let i = 0; i < rows.length && !read.signal?.aborted; i += SAMPLE_CONCURRENCY) {
    const part = rows.slice(i, i + SAMPLE_CONCURRENCY);
    const batch = await Promise.all(part.map((r) => delegationsAt(r.address, epoch, read).then((d) => ({ r, d }), () => ({ r, d: null }))));
    for (const { r, d } of batch) {
      if (!d && read.signal?.aborted) { cut++; continue; }
      attempted++;
      if (!lastAttempted || r.address > lastAttempted) lastAttempted = r.address;
      if (!d) { rec.failed++; continue; }
      rec.checked++;
      if (Math.abs(d.bondedNam - r.bonded_num) <= 1e-6) rec.agreed++;
      else fresh.set(r.address, { address: r.address, listingNam: r.bonded_num, chainNam: d.bondedNam, epoch, at: now });
    }
  }
  // The cursor moves past the rows actually attempted (a cut row is sampled next tick); a pass is counted when the
  // last page was read to its end.
  if (lastPage && attempted === rows.length) { rec.cursor = ''; if (rows.length) rec.passes++; } else if (lastAttempted) rec.cursor = lastAttempted;
  rec.disagreements = [...rec.disagreements.filter((d) => !rows.some((r) => r.address === d.address)), ...fresh.values()].slice(-200);
  const differ = fresh.size;
  const ok = batchHealthOk(rows.length, rec.checked, attempted, rec.failed);
  health.push({ name, ok, at: now, note: rows.length === 0
    ? 'No stakes from the bond listing to sample yet.'
    : `${rec.agreed} of ${rec.checked} sampled stakes match the bond listing to the base unit`
      + (differ ? `, ${differ} differ (bonds still in the pipeline, or slashed)` : '') + (rec.failed ? `, ${rec.failed} reads failed` : '')
      + (cut ? `, ${cut} left for the next tick (time limit)` : '') + `; ${rec.passes} full passes so far` });
  await kvSet(env.DB, 'stake.sample', rec).catch(() => {});
  return rec;
}

/** Figures of the stakes table the coverage check carries (kept in kv stakes.figures); `at`: when they were read from the table. */
export interface StakesFigures {
  at: number;
  cov: { v: number | null; n: number; stakers: number | null } | null;
  mis: { n: number; total: number | null; top_addr: string | null; top_nam: number | null } | null;
}
/** The coverage check's stakes figures are reused from kv for at most this long while nothing writes stakes. */
export const STAKES_FIGURES_MAX_AGE_MS = 60 * 60_000;

/**
 * The two whole-table reads of stakes behind the coverage check (65,203 and 131,573 rows read on 2026-10-20, every
 * tick). Only the bond listing and the hourly estimate write stakes, so `changed` false (neither wrote this tick)
 * reuses the figures stored in kv stakes.figures while they are under STAKES_FIGURES_MAX_AGE_MS old (one row read);
 * recomputed figures are stored for the next tick.
 */
export async function stakesFigures(db: D1Database, now: number, changed: boolean): Promise<StakesFigures> {
  if (!changed) {
    const f = await kvGetJson<StakesFigures>(db, 'stakes.figures').catch(() => null);
    if (f && Number.isFinite(f.at) && now - f.at < STAKES_FIGURES_MAX_AGE_MS && 'cov' in f && 'mis' in f) return f;
  }
  const [cov, mis] = await Promise.all([
    db.prepare(`SELECT SUM(bonded_num) v, COUNT(bonded_num) n, SUM(CASE WHEN bonded_num > 0 THEN 1 ELSE 0 END) stakers FROM stakes WHERE verified_src = ?`)
      .bind(BOND_LISTING_SRC).first<{ v: number | null; n: number; stakers: number | null }>().catch(() => null),
    db.prepare(`SELECT COUNT(*) n, SUM(ABS(estimated_num - bonded_num)) total,
          (SELECT address FROM stakes WHERE bonded_num IS NOT NULL AND estimated_num IS NOT NULL ORDER BY ABS(estimated_num - bonded_num) DESC LIMIT 1) top_addr,
          MAX(ABS(estimated_num - bonded_num)) top_nam
        FROM stakes WHERE bonded_num IS NOT NULL AND estimated_num IS NOT NULL AND ABS(estimated_num - bonded_num) > 1`)
      .first<{ n: number; total: number | null; top_addr: string | null; top_nam: number | null }>().catch(() => null),
  ]);
  const out: StakesFigures = { at: now, cov, mis };
  if (cov && mis) await kvSet(db, 'stakes.figures', out).catch(() => {});
  return out;
}

/**
 * The bonded-coverage check: the bond listing's sum, net of slashing, against the chain's total stake. The listing
 * runs slightly above the total stake (bonds in the pipeline are listed before they count), so it passes within
 * 2% when its last pass is complete and recent. The detail carries what the UI reads (coveragePct, stakers,
 * pendingAddresses, knownAddresses, pipelineNam, slashedNam), the listing's and the chain's totals, the sample's
 * disagreements, and (owner decision 7) where the chain figure and the flow-history estimate differ.
 */
export async function bondedCoverageCheck(db: D1Database, now: number, stakeNam: number, posNam: number | null, bond: BondListingRecord | null, sample: StakeSampleRecord | null, stakesChanged = true): Promise<Stmt> {
  const title = "Bonded stake: the chain's bond listing (every bond net of slashing, pipeline included) vs its total stake";
  const sf = await stakesFigures(db, now, stakesChanged);
  const { cov, mis } = sf;
  const sampled = sample ? { at: sample.at, checked: sample.checked, agreed: sample.agreed, failed: sample.failed, passes: sample.passes, examples: sample.disagreements.slice(0, 5) } : null;
  const common = {
    verifiedAddresses: cov?.n ?? 0, storedSumNam: cov?.v ?? null, totalStakeNam: stakeNam, posBalanceNam: posNam,
    sampledDisagreements: sample?.disagreements.length ?? 0, sampled,
    estimateMismatches: mis?.n ?? null, estimateMismatchNam: mis?.total ?? null,
    largestMismatch: mis?.top_nam ? { address: mis.top_addr, nam: mis.top_nam } : null,
  };
  if (!bond || !(bond.at > 0)) {
    const note = bond?.error ? `The bond listing could not be read: ${bond.error}` : 'The bond listing has not been read yet.';
    return stmt.check('bonded_coverage', 'warn', title, { ...common, coveragePct: null, stakers: cov?.stakers ?? null, knownAddresses: null, pendingAddresses: null, listingTotalNam: null, note }, now);
  }
  const pct = (bond.totalNam / stakeNam) * 100;
  const recent = now - bond.at < 3 * BOND_LISTING_MS;
  const ok = Math.abs(100 - pct) < 2 && bond.remaining === 0 && recent && !bond.error;
  const unbondingNam = bond.unbondingNam ?? null;
  const posAccountedNam = unbondingNam != null ? bond.totalNam + unbondingNam : null;
  return stmt.check('bonded_coverage', ok ? 'ok' : 'warn', title, {
    ...common,
    coveragePct: pct.toFixed(1) + '%', stakers: bond.stakers, knownAddresses: bond.sources, pendingAddresses: bond.remaining,
    listingTotalNam: bond.totalNam, listingGrossNam: bond.grossNam ?? null, slashedNam: bond.slashedNam ?? null, pipelineNam: bond.totalNam - stakeNam,
    unbondingNam, posAccountedNam, listingAt: bond.at, listingHeight: bond.height, listingEpoch: bond.epoch, listingCompleteAt: bond.completeAt,
    note: !recent ? 'The bond listing is older than three of its intervals.' : bond.error ? `The last bond listing failed: ${bond.error}` : bond.remaining ? `${bond.remaining} addresses are still being written.` : undefined,
  }, now);
}

export async function runCron(env: Env) {
  const now = Date.now();
  const health: SourceHealth[] = [];
  const alertsOff = alertDeliveryOff(env, now);
  if (alertsOff) health.push(alertsOff);
  const lockId = `${now}-${Math.random().toString(36).slice(2, 8)}`;
  console.log('cron tick', new Date(now).toISOString());
  if (!(await takeTickLock(env.DB, lockId, now))) {
    // Another tick is still running (a slow node): this one does nothing rather than repeat the same reads.
    await mergeHealth(env, [...health, { name: 'cron', ok: true, at: now, note: 'Skipped: the previous run was still going.' }]);
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
  const intel = syncIntelAndAlerts(env, health).catch((e) => console.error('intel', e));
  // The chain listing this tick has started reading and not yet handed to its apply (runBondListing and
  // runBalanceListing write its record whatever the answer). A tick that fails in between records the read as failed
  // (the catch below), so the retry wait applies instead of the same multi-megabyte read every minute.
  let listingOpen: { key: 'bond.listing' | 'balance.listing' } | null = null;
  try {
    await sweepAuth(env.DB);

    // Which Namada nodes answer this tick (a short status read each). A node that does not is left out of every
    // read below, so a node that accepts requests and never answers costs one status read, not one per address.
    const rpcStatuses = await namadaStatusAll({ timeoutMs: 6000, retries: 0 });
    const rpcs = answeringRpcs(rpcStatuses as { provider: string; error?: string; catchingUp?: boolean; network?: string }[]);
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
    // A pass of the holder list that a tick did not finish goes on every tick until it is complete (OsmoHolderPass).
    const osmoPass = await readOsmoPass(env.DB);
    const passOn = !!osmoPass?.key;
    const shouldSyncHolders = !osmoCountRes?.c || passOn || (now % 600000 < 60000 && now >= nextOsmoPassAt(osmoPass));
    const keplr = { ...KEPLR_TICK, signal };

    // The holder list (every 10 min, a page at a time) is written when it arrives, after the Namada phases: nothing
    // waits for it, so a slow list can never take their time. Its pages stop OSMO_SLICE_RESERVE_MS before the
    // deadline; a list longer than that goes on next tick from the bank's next key.
    const slice = shouldSyncHolders ? phaseSignal(signal, deadlineAt - OSMO_SLICE_RESERVE_MS) : null;
    const holderSync = slice
      ? probe(health, 'Keplr Osmosis REST (holders)', () => fetchOsmosisHolderList(env.KEPLR_KEY, OSMOSIS_HOLDER_PAGES, {
          ...keplr, signal: slice.signal, resume: true, from: passOn ? osmoPass!.key : null, pagesBefore: passOn ? osmoPass!.pages : 0,
        })).finally(slice.done)
      : Promise.resolve(null);
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
    // The chain listing this tick reads (5a/5d), if one is due, starts now, right after the quick reads above have
    // shown the breaker which node answers: a node can take 30 s to stream the 12 MB balance answer (5ElementsNodes
    // did on 2026-10-20 while Papadritta took 3.5 s), so the read gets the rest of the tick, not what the checks
    // leave. The node that served the last listing is asked first (unless it failed a read this tick); one listing
    // a tick, the bond listing (the shorter interval) before the balance listing.
    const [balPrev, bondPrev] = await Promise.all([kvGetJson<BalanceListingRecord>(env.DB, 'balance.listing').catch(() => null), kvGetJson<BondListingRecord>(env.DB, 'bond.listing').catch(() => null)]);
    // What the chain listings are checked against (the check rows below keep the highest node height, headHeight, so
    // a node's lie shows there): the head this tick's answers agree on (listingHeads: the nodes' statuses and the
    // indexer's latest block). One node's status far from every other answer is not the head, and a listing or a
    // stored height above it is not one the chain has reached (heightCeiling).
    const listingHead = listingHeads(rpcStatuses as { provider: string; error?: string; height?: number; time?: number; catchingUp?: boolean; network?: string }[], Number(idxBlock?.block), now);
    // The bond listing needs the epoch (its rows' verified_epoch), so a tick without one does not start it and the
    // balance listing takes the turn when due. A bond read started for nothing never reaches its record: it would be
    // due again every minute, and the balance listing would never be chosen.
    const bondDue = listingDue(bondPrev, BOND_LISTING_MS, now);
    const due: 'bond' | 'balance' | null = late() ? null : bondDue && epoch ? 'bond' : listingDue(balPrev, BALANCE_LISTING_MS, now) ? 'balance' : null;
    // With no head the answers agree on, the listing due is not read: one node's word would be all its height is
    // checked against. It is recorded as a failed read, so the retry wait applies, and its row says why (5a, 5d).
    const which = listingHead.head == null ? null : due;
    const noHead = due && listingHead.head == null ? `Not read this tick: ${listingHead.note}` : null;
    if (due && noHead) await recordListingFailure(env.DB, due === 'bond' ? 'bond.listing' : 'balance.listing', now, `Not applied: ${listingHead.note}`.slice(0, 160));
    const lread: ReadOpts = { rpcs: listingRpcs(rpcs, which === 'bond' ? bondPrev : balPrev), signal, breaker };
    const bondRead = which === 'bond' ? allBonds({ timeoutMs: LISTING_TIMEOUT_MS, retries: 0, ...lread }).then((v) => ({ v }), (e) => ({ e })) : null;
    const balRead = which === 'balance' ? allNamBalances({ timeoutMs: LISTING_TIMEOUT_MS, retries: 0, ...lread }).then((v) => ({ v }), (e) => ({ e })) : null;
    if (which) listingOpen = { key: which === 'bond' ? 'bond.listing' : 'balance.listing' };
    const started = <T,>(p: Promise<{ v?: T; e?: unknown }>) => async () => { const r = await p; if (r.e !== undefined || !r.v) throw r.e ?? new Error('listing: no answer'); return r.v; };
    const osmoSupply = osmoSupplyRes ? toNam(osmoSupplyRes) : null;
    health.push({ name: 'Osmosis SQS (price)', ok: price.usd != null, at: price.at, note: price.error });
    // A listed pool whose address is not a pool account's is said here, and its address is never labelled.
    const refusedNote = poolRes.refused ? `The pool list named ${poolRes.refused} address${poolRes.refused === 1 ? '' : 'es'} that ${poolRes.refused === 1 ? 'is' : 'are'} not an Osmosis pool account; ${poolRes.refused === 1 ? 'it is' : 'they are'} not labelled a pool.` : undefined;
    const poolsRow: SourceHealth = { name: 'Osmosis SQS (pools)', ok: poolRes.pools.length > 0 && !poolRes.refused, at: poolRes.at, note: poolRes.error ?? refusedNote };
    health.push(poolsRow);

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

    // A read's height is stored only at or under heightCeiling, so never on a tick whose answers agree on no head
    // (stmt.verifiedBalance keeps the higher of the two heights: one node's far-future height would stick there).
    const ceiling = heightCeiling(listingHead.head);
    for (const [addr, r] of [[NAMADA.internal.pos, posRes], [NAMADA.internal.ibc, ibcRes], [NAMADA.internal.masp, maspRes], [NAMADA.internal.pgf, pgfRes]] as const) {
      if (r) internalStmts.push(stmt.verifiedBalance('namada', addr, r.balance.toString(), ceiling != null && r.height <= ceiling ? r.height : null, now, r.provider));
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
    for (const [symbol, v] of Object.entries(price.coinUsd ?? {})) if (QUOTE_KEYS[symbol]) metricStmts.push(stmt.metric(now, QUOTE_KEYS[symbol], v));
    if (poolRes.pools.length) {
      // Pool depth is recorded so replay can show what liquidity looked like at the time.
      metricStmts.push(stmt.metric(now, 'dex.liquidity_usd', poolRes.pools.reduce((a, p) => a + p.liquidityUsd, 0)), stmt.metric(now, 'dex.pool_count', poolRes.pools.length));
      const ref = poolRes.pools.find((p) => p.id === OSMOSIS.refPoolId);
      if (ref) metricStmts.push(stmt.metric(now, 'dex.ref_pool_liquidity_usd', ref.liquidityUsd), stmt.metric(now, 'dex.ref_pool_nam', ref.namReserve), stmt.metric(now, 'dex.ref_pool_counter', ref.counterReserve));
    }

    // 3. Executed-swap price for the current hour: median of single-pool NAM/USDC swaps.
    const hour = Math.floor(now / 3600000) * 3600000;
    const swaps = await env.DB.prepare(
      `SELECT amount_num, counter_amount FROM flows WHERE ${SINGLE_POOL_USDC_SWAP} AND ts >= ? AND ts < ?`,
    ).bind(hour, hour + 3600000).all<{ amount_num: number; counter_amount: number }>().catch(() => ({ results: [] as any[] }));
    const px = (swaps.results || []).map((s) => s.counter_amount / s.amount_num).sort((a, b) => a - b);
    if (px.length) {
      const m = series.medianOf(px);
      metricStmts.push(stmt.metric(hour, 'price.swap_1h', m), stmt.metric(hour, 'price.swap_1h.n', px.length));
    }

    // A figure that is not a finite number (an SQS liquidity_cap or amount that does not parse; every other figure
    // here is checked or counted from integers) is left out and the pools row says which: metrics.value is NOT NULL,
    // so one NaN would fail this whole batch and end the tick. The note joins the row's own (a refused pool address),
    // as the sheet keeps one row a name.
    const unreadable = metricStmts.filter((s) => !Number.isFinite(s.params[2])).map((s) => String(s.params[1]));
    if (unreadable.length) {
      poolsRow.ok = false;
      poolsRow.note = [poolsRow.note, `Not a number, so not stored: ${unreadable.join(', ')}`].filter(Boolean).join(' ').slice(0, 160);
    }
    await runBatch(env.DB, [...internalStmts, ...metricStmts.filter((s) => Number.isFinite(s.params[2]))]);

    // 3b. The series (worker/src/series.ts): once an hour and once a day, each in the first minutes of the hour, on a
    //     tick that reads no chain listing unless the window is closing. The two run side by side, so their outside
    //     requests (the Osmosis data API's two reads, the validator list) overlap instead of adding up, and neither
    //     starts one once the tick is late.
    const seriesCtx = { health, signal, late, listingTick: which !== null };
    await Promise.all([
      series.hourly(env, now, { ...seriesCtx, pools: poolRes.pools, poolsAt: poolRes.at }).catch((e) => { console.error('series hourly', e); health.push({ name: 'Series (hourly)', ok: false, at: now, note: String(e).slice(0, 160) }); }),
      series.daily(env, now, seriesCtx).catch((e) => { console.error('series daily', e); health.push({ name: 'Series (daily snapshot)', ok: false, at: now, note: String(e).slice(0, 160) }); }),
    ]);

    // 4. Integrity checks. Each compares two independent sources.
    const checkStmts = [];

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

    // Live scan (LiveHub alarm): blocks it could not read as blocks or jumped over, recorded by noteScanFailure()
    const scan = await kvGetJson<LiveScanStatus>(env.DB, 'namada.scan');
    if (scan?.failures.length) {
      const last = scan.failures[scan.failures.length - 1];
      const recent = now - last.at < 24 * 3600000;
      health.push({ name: 'Namada RPC (live block scan)', ok: !recent, at: last.at, note: (recent ? last.note : `last unreadable block ${last.height}, more than a day ago`).slice(0, 160) });
    }
    // Alert posts that could not be sent (sources/discord.ts postAll: deadline passed or a webhook backed off). A
    // Worker that does not send alerts keeps the row pushed first (alertDeliveryOff), which this one never replaces.
    // One that sends says so when no post not sent is on record, so the row a tick without the secret wrote does not
    // outlast the secret being put.
    if (!alertsOff) {
      const skipped = await kvGetJson<AlertsSkipped>(env.DB, 'alerts.skipped');
      if (skipped?.last.at) {
        const recent = now - skipped.last.at < 24 * 3600000;
        health.push({ name: ALERT_DELIVERY_HEALTH, ok: !recent, at: skipped.last.at, note: `${skipped.last.n} post(s) for ${skipped.last.what} not sent; ${skipped.total} in all`.slice(0, 160) });
      } else health.push({ name: ALERT_DELIVERY_HEALTH, ok: true, at: now, note: 'On: this Worker posts alerts, and no post not sent is on record.' });
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
      // The indexer's figure is used only as a whole number of base units (it answered a JSON number on 2026-10-22): a
      // decimal, an exponent or an object would make BigInt throw and end the tick, so the second node is asked instead.
      const idxTotal = idxSupply?.totalSupply;
      if (idxTotal && /^\d+$/.test(String(idxTotal))) other = { label: 'Namada indexer (indexer.namada.net)', nam: Number(BigInt(idxTotal)) / 1e6 };
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
    // Each read takes the newest BRIDGE_CHECK_ROWS rows and, of meta, only what the pairing and the stuck-packet list
    // use (never the memo, which the sender writes). When a read comes back full, only the crossings the reads cover
    // whole are judged, and the check says from when (judgedFrom) instead of passing.
    const from14 = now - 14 * 86400000;
    const [nb, ob, orf] = await Promise.all([
      env.DB.prepare(`SELECT f.id, f.kind, f.ts, f.height, f.from_addr, f.to_addr, f.amount_num,
                        json_object('innerTxHash', json_extract(f.meta, '$.innerTxHash'), 'wrapper', json_extract(f.meta, '$.wrapper'), 'channel', json_extract(f.meta, '$.channel'), 'packetSequence', json_extract(f.meta, '$.packetSequence')) meta
                      FROM flows f WHERE f.chain='namada' AND f.kind IN ('ibc_in','ibc_out') AND f.ts >= ?
                      AND (f.from_addr LIKE 'osmo1%' OR f.to_addr LIKE 'osmo1%' OR f.from_addr = ? OR f.to_addr = ?) AND (f.meta IS NULL OR f.meta NOT LIKE '%"tokenSymbol":%') AND ${NOT_LEGACY_TWIN}
                      ORDER BY f.ts DESC LIMIT ?`)
        .bind(from14, NAMADA.internal.ibc, NAMADA.internal.ibc, BRIDGE_CHECK_ROWS).all<any>().catch(() => null),
      env.DB.prepare(`SELECT id, kind, ts, height, from_addr, to_addr, amount_num, json_object('packetSequence', json_extract(meta, '$.packetSequence')) meta
                      FROM flows WHERE chain='osmosis' AND kind IN ('ibc_in','ibc_out') AND ts >= ? ORDER BY ts DESC LIMIT ?`).bind(from14 - 15 * 60000, BRIDGE_CHECK_ROWS).all<any>().catch(() => null),
      env.DB.prepare(`SELECT id, ts, from_addr, to_addr, amount_num, json_object('packetSequence', json_extract(meta, '$.packetSequence'), 'refundReceiver', json_extract(meta, '$.refundReceiver')) meta
                      FROM flows WHERE chain='osmosis' AND kind='other' AND ts >= ? AND meta LIKE '%"ibcTimeoutRefund":true%' ORDER BY ts DESC LIMIT ?`).bind(from14, BRIDGE_CHECK_ROWS).all<any>().catch(() => null),
    ]);
    // Namada → Osmosis sends on record on Namada only for a day or more: candidates for the stuck-packet list.
    const stuckCandidates: StuckCandidate[] = [];
    if (nb && ob && orf) {
      const judgedFrom = bridgeJudgedFrom(nb.results || [], ob.results || [], orf.results || []);
      const outs = (ob.results || []).filter((r: any) => r.kind === 'ibc_out');
      const gone = timedOutSends(outs.map(ibcRowOf), (orf.results || []).map(ibcRowOf));
      const osmo = (ob.results || []).filter((r: any) => !gone.has(r.id) && r.ts >= from14);
      const all = unpairedCrossings(nb.results || [], osmo, now);
      const judged = (r: any) => judgedFrom == null || r.ts > judgedFrom;
      const u = { namadaOnly: all.namadaOnly.filter(judged), osmosisOnly: all.osmosisOnly.filter(judged) };
      const n = u.namadaOnly.length + u.osmosisOnly.length;
      const sample = (rows: any[]) => rows.slice(0, 3).map((r) => ({ id: r.id, ts: r.ts, nam: r.amount_num }));
      checkStmts.push(stmt.check('bridge_records_paired', n === 0 && judgedFrom == null ? 'ok' : 'warn',
        'Every bridge crossing is on record on both chains (14 days)',
        { namadaRows: (nb.results || []).length, osmosisRows: osmo.length, onlyOnNamada: u.namadaOnly.length, onlyOnOsmosis: u.osmosisOnly.length,
          onlyOnNamadaNam: u.namadaOnly.reduce((a, r) => a + r.amount_num, 0), onlyOnOsmosisNam: u.osmosisOnly.reduce((a, r) => a + r.amount_num, 0),
          examples: { namada: sample(u.namadaOnly), osmosis: sample(u.osmosisOnly) },
          ...(judgedFrom != null ? { judgedFrom, rowCap: BRIDGE_CHECK_ROWS, note: `More than ${BRIDGE_CHECK_ROWS.toLocaleString('en-US')} bridge records in 14 days: only the newest crossings were paired, and older ones are not judged.` } : {}) }, now));
      for (const r of u.namadaOnly) {
        if (r.kind !== 'ibc_out' || !String(r.to_addr ?? '').startsWith('osmo1') || now - r.ts < STUCK_CANDIDATE_AGE_MS) continue;
        const innerTx = innerTxOfRow(r);
        if (!innerTx) continue;
        const m = typeof r.meta === 'string' ? safeParseJson(r.meta, {}) : r.meta ?? {};
        stuckCandidates.push({ innerTx, wrapperTx: m?.wrapper ?? (m?.innerTxHash ? r.id.split(':')[1]?.toLowerCase() ?? null : null), height: r.height ?? null, sentAt: new Date(r.ts).toISOString(), nam: r.amount_num, channel: m?.channel ?? null, sequence: m?.packetSequence != null ? Number(m.packetSequence) : null, counterparty: null });
      }
    }

    // IBC conservation: the escrow, less the packets stuck in it (ibc-stuck.ts: each one's status re-read from the
    // indexer every tick, so a relayed acknowledgement or timeout drops it on its own), against the Osmosis supply.
    // Namada keeps one escrow for every channel and no other chain is read (other chains held no NAM when the owner
    // looked on 2026-10-19, but any holder can change that): ibcConservation says which side of the gap is a finding.
    if (ibcEscrowNam != null && osmoSupply != null) {
      const prevStuck = await kvGetJson<StuckList>(env.DB, STUCK_PACKETS_KV).catch(() => null);
      const lookup = (inner: string) => fetchJson<any>(INDEXER_IBC_STATUS(inner), { timeoutMs: 6000, retries: 0, signal })
        .then((r) => (typeof r?.status === 'string' ? { status: r.status, timeout: r.timeout != null ? new Date(Number(r.timeout) / 1e6).toISOString() : null } : null));
      const stuck = await reconcileStuckPackets(prevStuck, stuckCandidates, lookup, now);
      await kvSet(env.DB, STUCK_PACKETS_KV, stuck).catch(() => {});
      const stuckNam = stuckTotalNam(stuck);
      const bridge = ibcConservation(ibcEscrowNam, osmoSupply, stuckNam);
      checkStmts.push(stmt.check('ibc_conservation', bridge.status,
        'IBC conservation: Namada escrow (one for every channel) vs Osmosis voucher supply + packets stuck in the escrow; no other chain is read',
        { namadaIbcEscrow: ibcEscrowNam, osmosisSupply: osmoSupply, rawGapNam: bridge.rawGapNam, stuckNam, driftNam: bridge.driftNam, over: bridge.over,
          compared: IBC_COMPARED, notCompared: IBC_NOT_COMPARED, otherChainsNam: null,
          stuckPackets: stuck.packets.map((p) => ({ innerTx: p.innerTx, nam: p.nam, sentAt: p.sentAt, height: p.height, channel: p.channel, sequence: p.sequence, counterparty: p.counterparty, note: p.note, status: p.status, verifiedAt: p.verifiedAt, stale: !!p.stale, timeout: p.timeout, evidence: p.evidence })),
          stuckDropped: stuck.dropped.slice(-3),
          sources: ['Namada RPC abci_query', 'Keplr Osmosis bank/supply', 'indexer.namada.net /ibc/{tx}/status'] }, now));
    }

    // SQS mid vs the last hour's executed swap price. With no trusted trade in the window the check still runs and
    // says it had nothing to compare (it used to go quiet and read "no recent result", as if a source had failed).
    if (price.usd) {
      const lastSwap = await env.DB.prepare(`SELECT ts, value FROM metrics WHERE key='price.swap_1h' ORDER BY ts DESC LIMIT 1`).first<{ ts: number; value: number }>().catch(() => null);
      const fresh = lastSwap != null && now - lastSwap.ts < PRICE_CHECK_WINDOW_MS;
      // The read can fail: a failed read leaves the time unknown (null), never a guessed one.
      const lastTradeAt = fresh ? null
        : (await env.DB.prepare(`SELECT MAX(ts) t FROM flows WHERE ${SINGLE_POOL_USDC_SWAP}`).first<{ t: number | null }>().catch(() => null))?.t ?? null;
      const r = priceVsExecution(price.usd, lastSwap, lastTradeAt, now);
      if (r) checkStmts.push(stmt.check('price_vs_execution', r.status, 'SQS mid price vs executed swap price (last hour with trades)', r.detail, now));
    }

    await runBatch(env.DB, checkStmts);
    // What has been learnt so far is written now: a stall in the stake phase must not hide it.
    await mergeHealth(env, health);

    // 5. Bonded stake. Estimates for every address from bond/unbond history (hourly since 2026-10-20: the bond listing
    //    is the chain's figure, the estimate only matters before a listing has gone through; screener-plan 5.5 b).
    //    Who stakes comes from the chain's bond listing (5a): an address the listing does not name has no bonds, so
    //    holders no longer need a stakes row of their own.
    let estimatesRan = false;
    if (now % 3600000 < 60000 || !(await env.DB.prepare('SELECT 1 FROM stakes LIMIT 1').first().catch(() => null))) {
      const r = await env.DB.prepare(STAKE_ESTIMATES_SQL).bind(now).run().catch((e) => { console.error('stake estimates', e); return null; });
      estimatesRan = Number(r?.meta?.changes ?? 0) > 0;
    }

    // 5a. The chain listings, never both in one tick (each is a multi-megabyte answer): the bond listing when due
    //     (it needs the epoch for the rows' verified_epoch), else the balance listing when due (5d). The read was
    //     started with the tick (above); here its answer is reconciled with the rows.
    // A listing not read this tick for a reason of its own says why in its row (listingSkipped, with how overdue it is).
    const bondWhy = bondDue && !epoch ? 'Not read this tick: the epoch could not be read from the chain.' : due === 'bond' ? noHead : null;
    const balWhy = due === 'balance' ? noHead : null;
    let bondRec = bondPrev;
    if (bondRead && epoch) {
      listingOpen = null;
      bondRec = await runBondListing(env, health, now, epoch, lread, started(bondRead), LISTING_WRITE_CAP, { headHeight: listingHead.head, headByNodes: listingHead.byNodes, headTop: listingHead.top, stakeNam });
    } else if (bondWhy) {
      // Not started (above): without the epoch the rows cannot be stamped (verified_epoch); without a head, not checked.
      listingSkipped(health, 'Namada RPC (bond listing)', 'bond', bondPrev, BOND_LISTING_MS, now, bondWhy);
    }
    // 5b. A sample of stakes re-read with delegations_at (the chain's bonded amount at this epoch) against the listing.
    //     Its reads end LISTING_RESERVE_MS before the deadline, so a slow node can never take the listing's turn.
    let sampleRec: StakeSampleRecord | null = null;
    if (epoch && !late()) {
      const phase = phaseSignal(signal, deadlineAt - LISTING_RESERVE_MS);
      try { sampleRec = await sampleStakes(env, health, now, epoch, { ...nread, signal: phase.signal }); } finally { phase.done(); }
    } else health.push({ name: 'Namada RPC (stake sample)', ok: false, at: now, note: epoch ? 'Not run this tick: the tick ran out of time on slower reads.' : 'Not run this tick: the epoch could not be read from the chain.' });
    // 5c. The coverage check, every tick: the listing's sum (at most a few intervals old) against this tick's total
    //     stake. Its whole-table reads of stakes run only when this tick wrote stakes (stakesFigures).
    if (stakeNam != null) {
      const sample = sampleRec ?? (await kvGetJson<StakeSampleRecord>(env.DB, 'stake.sample').catch(() => null));
      const stakesChanged = estimatesRan || (!!bondRead && bondRec?.at === now && (bondRec.written + bondRec.zeroed) > 0);
      await runBatch(env.DB, [await bondedCoverageCheck(env.DB, now, stakeNam, posNam, bondRec, sample, stakesChanged)]).catch(() => {});
    }
    // 5d. Spendable balances: the balance listing, when it was the listing due this tick.
    if (balRead) {
      listingOpen = null;
      await runBalanceListing(env, health, now, lread, started(balRead), LISTING_WRITE_CAP, { headHeight: listingHead.head, headByNodes: listingHead.byNodes, headTop: listingHead.top, supplyBase: totalRes?.supply ?? null });
    } else if (balWhy) listingSkipped(health, 'Namada RPC (balance listing)', 'balance', balPrev, BALANCE_LISTING_MS, now, balWhy);
    // 5e. A listing that has not landed for LISTING_OVERDUE_INTERVALS of its intervals is said so every tick, on the
    //     ticks that do not read it too (its last row would otherwise sit in the sheet with its age growing). A
    //     listing skipped for a reason of its own (5a, 5d) has said so already.
    if (!bondRead && !bondWhy) listingOverdue(health, 'Namada RPC (bond listing)', 'bond', bondPrev, BOND_LISTING_MS, now);
    if (!balRead && !balWhy) listingOverdue(health, 'Namada RPC (balance listing)', 'balance', balPrev, BALANCE_LISTING_MS, now);

    // 6. The Osmosis holder list, read beside everything above: this tick's slice of the pass (OsmoHolderPass).
    const holderList = await holderSync;
    const holders = holderList?.holders ?? null;
    if (shouldSyncHolders) {
      // With no stored pass, the count's stamp until a pass adds up is what it is now: the oldest reading it includes.
      const seed = osmoPass ? null : (await env.DB.prepare(OSMOSIS_READ_AT_SQL).first<{ at: number | null }>().catch(() => null))?.at ?? null;
      const step = nextOsmoPass(osmoPass, holderList, osmoSupplyRes, now, seed);
      if (holders && holders.length > 0) await runBatch(env.DB, holders.filter((h) => h.balanceNum > 0).map((h) => stmt.verifiedBalance('osmosis', h.address, h.balance, null, now, KEPLR_REST_SRC)));
      // A complete pass that adds up to the supply also tells who no longer holds NAM there: their old balance is not
      // kept as if current. Anything less (a page without a next key, a sum off the supply, a pass still going) is not
      // trusted to zero anyone. The zeroing reaches only rows no slice of this pass read, and only those the bank,
      // asked by address, says hold none; a pass of several ticks also has its largest earlier readings read again.
      let recheckNote: string | null = null;
      if (step.zeroBefore != null || step.recheckBefore != null) {
        const phase = phaseSignal(signal, deadlineAt - OSMO_RECHECK_RESERVE_MS);
        try {
          recheckNote = (await recheckOsmosisRows(env.DB, env.KEPLR_KEY, now, step.zeroBefore, step.recheckBefore, { ...KEPLR_TICK, signal: phase.signal })).note;
        } catch (e) {
          console.error('osmosis dropped holders', e);
          recheckNote = step.zeroBefore != null
            ? 'the holders not named by the list were not zeroed: their check by address failed, so the next pass asks again'
            : 'the largest readings of the earlier slices were not read again by address: the read failed';
        } finally { phase.done(); }
      }
      // A pass whose list added up is trusted only if the rows it leaves, after the reads by address, still add up to
      // the supply (osmosisRowsCheck); otherwise it is stored complete with the last trusted pass's stamps kept.
      let { pass, ok, note } = step;
      if (step.withheld) {
        const rows = await env.DB.prepare(OSMOSIS_ROWS_SUM_SQL).first<{ s: string | null }>()
          .then((r) => (typeof r?.s === 'string' && /^\d{1,60}$/.test(r.s) ? BigInt(r.s) : null), (e) => { console.error('osmosis holder rows sum', e); return null; });
        const chk = osmosisRowsCheck(rows, osmoSupplyRes);
        if (!chk.trust) { pass = step.withheld; ok = false; note = [note, chk.note].filter(Boolean).join('; '); }
      }
      // The record after the rows: a tick that fails before it reads the same key again.
      await kvSet(env.DB, OSMO_PASS_KV, pass).catch((e) => console.error('osmosis holder pass', e));
      const h = health.find((x) => x.name === 'Keplr Osmosis REST (holders)');
      if (h && holderList) { h.note = [note, recheckNote].filter(Boolean).join('; ') || undefined; h.ok = ok; }
      else if (h && step.note) h.note = `${h.note ?? ''} (${step.note})`.slice(0, 300);
      // The first pass to start in an hour records its readings for the 24 h / 7 d changes, on each of its slices (a
      // separate batch: a missing table must not undo the balances).
      if (holders && holders.length > 0 && step.spans) await runBatch(env.DB, spanStmts('osmosis', now)).catch((e) => console.error('osmosis balance spans', e));
    }

    // 6b. The holder figures (holders.ts, kv holders.figures): after a complete chain listing, after the Osmosis
    //     holder list was written, or when they are old; the overview, the holder list and the pages read them.
    //     State-based: a tick that runs out of time leaves them due for the next one.
    if (!late()) {
      try {
        const prevFig = await readHolderFigures(env.DB);
        // A pass still going leaves the Osmosis part to its 15-minute refresh; the slice that completes it refreshes it.
        const due = figuresDue(prevFig, await listingTimes(env.DB), now, !!(holderList && holders && holders.length > 0 && !holderList.nextKey));
        if (due.namada || due.osmosis) await refreshHolderFigures(env.DB, now, due, prevFig);
      } catch (e) {
        // Not refreshed: the readers use the stored figures while they are under HOLDER_FIGURES_SERVE_MS old, then count for themselves.
        console.error('holder figures', e);
      }

    }

    // Balance readings older than any window still asked for (hourly).

    if (now % 3600000 < 60000) await runBatch(env.DB, [pruneSpansStmt(now)]).catch((e) => console.error('prune balance spans', e));

    // Chain parameters (unbonding period, staking rate, measured epoch length): cached 6 h, refreshed here so
    // pages never wait on the indexer.
    if (!late()) await chainParams(env.DB, signal).catch(() => {});

    // Unbond withdraw times: when the consensus bond listing is current, `runBondListing` already wrote the unbonds
    // the unlock list can show; fall back to the indexer when the bond listing has not completed recently, or its
    // write of them did not land (the stored map is older than the listing).
    if (now % 600000 < 60000 && !late()) {
      const storedAt = (await kvGetJson<UnbondWithdrawCache>(env.DB, 'unbond.withdraw').catch(() => null))?.at ?? null;
      if (withdrawFallbackDue(bondRec?.completeAt, storedAt, now)) {
        const addrs = await unbondAddresses(env.DB, now);
        const byAddress: UnbondWithdrawCache['byAddress'] = {};
        let failedUnbonds = 0;
        for (let i = 0; i < addrs.length && !late(); i += 4) {
          await Promise.all(addrs.slice(i, i + 4).map((a) => fetchUnbonds(a, signal).then((u) => { byAddress[a] = u; }).catch(() => { failedUnbonds++; })));
        }
        const notStored = Object.keys(byAddress).length || !addrs.length
          ? await kvSet(env.DB, 'unbond.withdraw', { at: now, source: 'indexer', byAddress } satisfies UnbondWithdrawCache).then(() => null, (e) => { console.error('unbond withdraw times (indexer)', e); return String(e).slice(0, 60); })
          : null;
        health.push({ name: 'Namada indexer (unbond withdraw times)', ok: !notStored && failedUnbonds < Math.max(1, addrs.length / 2), at: now, note: `${Object.keys(byAddress).length} of ${addrs.length} addresses read${failedUnbonds ? `, ${failedUnbonds} failed` : ''}${notStored ? `; not stored: ${notStored}` : ''}` });
      }
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
    // The tick's reads still running are stopped, a listing download included. A listing read started and never
    // applied is recorded as a failed read, so the next try waits LISTING_RETRY_MS: only the apply writes the record
    // otherwise, and the same read would start again every minute for as long as the tick keeps failing. The record
    // is read again for it (recordListingFailure), never taken from the tick's first read, which may have failed.
    deadline.abort('tick failed');
    if (listingOpen) await recordListingFailure(env.DB, listingOpen.key, now, `Not applied: the tick failed first (${String(err).slice(0, 120)})`);
  } finally {
    clearTimeout(timer);
    const merged = health.length;
    await mergeHealth(env, health);
    // The forum and governance alerts end before the lock is released (every send is claimed once, and every
    // webhook post has its own timeout), so two ticks never run them at the same time; the health above is
    // already written and cannot be held up by them. The forum's row, when its read ended after that write, is
    // merged now.
    await intel;
    if (health.length > merged) await mergeHealth(env, health.slice(merged));
    await releaseTickLock(env.DB, lockId);
  }
}

/**
 * A listing that was not applied this tick for a reason outside its answer (no head the answers agree on, the tick
 * failed after its read started) is recorded as a failed read, so the retry wait applies (listingDue) instead of the
 * same multi-megabyte read every minute. The record is read again here and nothing is written when that read fails:
 * the tick's own first read of it may have failed too, and a record built from nothing would replace a complete one
 * (its completeAt, height, counts and spans) with a blank.
 */
export async function recordListingFailure(db: D1Database, key: 'bond.listing' | 'balance.listing', now: number, error: string): Promise<void> {
  let cur: (Partial<BondListingRecord> & Partial<BalanceListingRecord>) | null;
  try { cur = await kvGetJson<Partial<BondListingRecord> & Partial<BalanceListingRecord>>(db, key); } catch { return; }
  await kvSet(db, key, { at: 0, completeAt: null, remaining: 0, ...cur, failedAt: now, error, failures: (cur?.failures ?? 0) + 1 }).catch(() => {});
}

/**
 * The row of a listing this tick did not read for a reason of its own (no epoch, no head the answers agree on): the
 * reason, and when the listing is also overdue (listingOverdue) that too, in one row, so neither replaces the other.
 */
export function listingSkipped(health: SourceHealth[], name: string, what: 'bond' | 'balance', rec: Parameters<typeof listingOverdue>[3], everyMs: number, now: number, why: string) {
  const overdue: SourceHealth[] = [];
  listingOverdue(overdue, name, what, rec, everyMs, now);
  // The overdue sentence (how long since the last complete listing) is kept whole; the reason is cut to fit beside it.
  const since = overdue[0]?.note?.split(' Last read')[0];
  health.push({ name, ok: false, at: now, note: since ? [why.slice(0, Math.max(0, 160 - since.length - 1)), since].filter(Boolean).join(' ') : why.slice(0, 160) });
}

/** The health row for a listing whose last complete pass is older than LISTING_OVERDUE_INTERVALS of its intervals (or that never completed), with the last error. */
export function listingOverdue(health: SourceHealth[], name: string, what: 'bond' | 'balance', rec: { completeAt: number | null; at: number; error?: string; failedAt?: number | null } | null, everyMs: number, now: number) {
  if (!rec) return;
  const since = rec.completeAt ?? 0;
  if (now - since < LISTING_OVERDUE_INTERVALS * everyMs) return;
  const hours = since ? `for ${(Math.round(((now - since) / 3600_000) * 10) / 10).toLocaleString('en-US')} h` : 'yet';
  const last = rec.error ? ` Last read${rec.failedAt ? ` ${new Date(rec.failedAt).toISOString().slice(11, 16)} UTC` : ''}: ${rec.error}` : '';
  health.push({ name, ok: false, at: now, note: `No complete ${what} listing ${hours} (${what === 'bond' ? 'stakes' : 'balances'} as of the last one).${last}`.slice(0, 160) });
}

/** Probes that no longer run (replaced by the listings on 2026-10-20, the bond index by the bond listing); their last result is dropped from the map. */
export const RETIRED_HEALTH = ['Namada RPC (balance refresh)', 'Namada RPC (stake verification)', 'Namada RPC (staker discovery)', 'Namada RPC (bond index)'];

/** Merge into the stored health map so a probe that did not run this tick keeps its last result. */
async function mergeHealth(env: Env, health: SourceHealth[]) {
  const prev = (await kvGetJson<Record<string, SourceHealth>>(env.DB, 'source.health').catch(() => null)) ?? {};
  for (const n of RETIRED_HEALTH) delete prev[n];
  for (const h of health) prev[h.name] = h;
  await kvSet(env.DB, 'source.health', prev).catch(() => {});
}
