// What a move's Discord alert says beside the move itself (sources/discord.ts buildFlowDiscordBody): the labels of both
// sides, a trade's settle price, what the person did before it, and what the site's own pages say this kind of move
// means (the NAM on deck at a receiver, when an unstaking request becomes spendable, the staking wait, the validator's
// name, a route's quote). One D1 batch per posted move, read before the move's claim is taken, bounded in time
// (CONTEXT_DEADLINE_MS), run once with no retry, and optional: a batch that fails or comes back late gives the context
// that needs no read, and the alert goes out with the move alone. Nothing here can keep an alert from being posted.
import type { ChainParams, Flow, IntelResponse } from '../../../shared/types';
import { isInternal } from '../../../shared/alerts';
import { QUOTE_KEYS, quotesNeeded, settleMetaOf, settleOf, type Settle } from '../../../shared/settle';
import { CROSSING_PAIR_MS, isBotFlow, isOtherCoin, priceHowOf, priceRouteOf } from '../../../shared/flow-rules';
import { bridgeDest } from '../../../shared/kinds';
import { partiesOf } from '../../../shared/flow-words';
import { label_plain, labelAuthorShort } from '../labels';
import { NAM_AMOUNT, NOT_BOT, NOT_LEGACY_TWIN, RECEIVED_TWIN } from '../flows-query';
import { timedOutSends, ibcRowOf, withdrawEpochs, UNBOND_WITHDRAW_STALE_MS, QUOTE_MATCH_MS, type UnbondWithdrawCache } from '../analytics';
import { priceHowAt, PRICE_HOW_KEY, type PriceHowLog } from '../price-how';
import { chainOf } from '../util';
import { crossingOf } from './discord';

const DAY = 86_400_000;
/** The whole context read (one D1 batch) ends within this long; past it the alert is built without it. */
export const CONTEXT_DEADLINE_MS = 2000;
/** "Before this" lists the person's moves of this many days before the move ... */
export const BEFORE_WINDOW_MS = 7 * DAY;
/** ... at most this many, a run of the same kind merged into one clause. */
export const BEFORE_SHOWN = 3;
/** A trade's earlier trades of the same side are counted over this many days, as the site's on-deck figures count prior sales. */
export const TRADES_WINDOW_MS = 30 * DAY;
/** The person's moves on record are counted up to this many on each side (an exchange's account has tens of thousands). */
export const HISTORY_COUNT_MAX = 1000;
/** The chain parameters, the validator names and the price's read log are read again at most this often by an isolate. */
export const CONTEXT_CACHE_MS = 15_000;

/** An earlier move of an address, for "Before this": `received`, the address was that move's receiver. */
export interface PriorMove { id: string; kind: Flow['kind']; chain: Flow['chain']; amount: number; ts: number; received: boolean; crossing?: string | null }

/**
 * What an alert says beside the move, every member optional: what is not on record (or could not be read) is left out
 * of the message, never guessed. `rule`, `watched` and `whaleNam` say why the post reached its channel.
 */
export interface MoveContext {
  /** a trade's settle price (shared/settle.ts, priced at its minute as analytics.ts settlePrices prices it) */
  settle?: Settle | null;
  /** a trade: the person's newest crossing from Namada to their Osmosis address in the 7 days before */
  crossingIn?: { id: string; amount: number; ts: number; crossing?: string | null } | null;
  /** the person's moves of the 7 days before, newest first, at most three: the move's own crossing, bot trades and other coins left out */
  before?: PriorMove[];
  /** a crossing or a transfer: the other side's, the same way */
  otherBefore?: PriorMove[];
  /** the person's moves on record before this one (`capped`: more than HISTORY_COUNT_MAX on a side, so `first` is not the first) */
  history?: { n: number; first: number | null; last: number | null; capped: boolean } | null;
  /** a trade (or a crossing to Osmosis: the receiver's sales): the trades of this side in the 30 days before, bot trades left out */
  trades30d?: { side: 'buy' | 'sell'; n: number; nam: number; firstTs: number | null } | null;
  /** a crossing to Osmosis: the receiver's NAM bridged in over the 7 days to now and what of it is not yet sold or sent back, as Supply's on-deck list counts it */
  onDeck?: { bridgedIn: number; remaining: number } | null;
  /** an unstaking request: when it becomes spendable, and where that time comes from */
  unlockAt?: { at: number | null; source: 'estimate' | 'consensus' | 'indexer'; note: string } | null;
  /** a bond: the chain's unstaking wait */
  wait?: { epochs: number; days: number; note: string } | null;
  /** a bond or an unbond: the validator's name in the site's validator list */
  validatorName?: string | null;
  /** a move priced at a quote read as the spot of the route the Osmosis router quoted for this many NAM (price.how) */
  priceRoute?: number | null;
  /** a subscriber's post: the first matching rule, in the site's words, at that subscriber's size */
  rule?: { id: string; title: string; thresholdNam: number } | null;
  /** a subscriber's post: the watched addresses this move touches */
  watched?: string[];
  /** the operator's channel: the whale size the move passed */
  whaleNam?: number;
}

/** An address the person of a move can be: a real one of either chain, never a protocol account. */
const personal = (a: string | null | undefined): a is string => !!a && !isInternal(a) && chainOf(a) != null;

/** The context that needs no read: a trade's settle price from its own coins, when none of them needs a stored quote. */
export function contextWithoutReads(flow: Flow): MoveContext {
  if (flow.kind !== 'buy' && flow.kind !== 'sell') return {};
  const rec = settleMetaOf(flow.meta ?? null);
  return rec && !quotesNeeded(rec).some((c) => QUOTE_KEYS[c]) ? { settle: settleOf(flow.kind, rec) } : {};
}

// ---------------------------------------------------------------- per-isolate copies of three kv rows

const cache = new Map<string, { at: number; value: unknown }>();
const cached = <T>(key: string, now: number): T | undefined => {
  const c = cache.get(key);
  return c && now - c.at < CONTEXT_CACHE_MS ? (c.value as T) : undefined;
};
/** What each kv row is kept as: the chain parameters whole, the validators' names only, the price's read log whole. */
const KEEP: Record<string, (v: unknown) => unknown> = {
  'chain.params': (v) => v,
  'intel.cache': (v) => Object.fromEntries(((v as IntelResponse | null)?.validators ?? []).filter((x) => x?.address && x.name).map((x) => [x.address, x.name])),
  [PRICE_HOW_KEY]: (v) => v,
};

// ---------------------------------------------------------------- the batch

/** One statement of the batch and what it fills in when its rows come back. */
interface Read { stmt: D1PreparedStatement; fill: (rows: any[]) => void }

/** A move under this many NAM prints as 0 by the site's rule (shared/format.ts fmtNamRule): dust, never listed or counted. */
export const DUST_NAM = 0.005;

/**
 * The conditions every "Before this" row meets: NAM only and no dust, no bot trade, no older twin, each bridge crossing
 * once (its receiving record left out when its sending record is stored: flows-query.ts RECEIVED_TWIN), and not the
 * move itself nor its own crossing's other record.
 */
function priorConds(flow: Flow): { sql: string; params: unknown[] } {
  const crossing = flow.kind === 'ibc_in' || flow.kind === 'ibc_out';
  return {
    sql: `f.id != ? AND f.amount_num >= ${DUST_NAM} AND ${NAM_AMOUNT} AND ${NOT_BOT} AND ${NOT_LEGACY_TWIN} AND NOT ${RECEIVED_TWIN}`
      + (crossing ? ` AND NOT (f.kind IN ('ibc_in','ibc_out') AND f.chain != ? AND ABS(f.amount_num - ?) < 0.000001 AND f.ts >= ?)` : ''),
    params: [flow.id, ...(crossing ? [flow.chain, flow.amount, flow.ts - CROSSING_PAIR_MS] : [])],
  };
}

/** An address's moves of the window before the move, newest first, from its sending rows and its receiving rows. */
function priorMoves(db: D1Database, flow: Flow, address: string, set: (m: PriorMove[]) => void): Read {
  const c = priorConds(flow);
  const cols = 'f.id, f.chain, f.kind, f.amount_num, f.ts, f.from_addr, f.to_addr, f.meta';
  const stmt = db.prepare(
    `SELECT * FROM (SELECT ${cols} FROM flows f INDEXED BY flows_from WHERE f.from_addr = ? AND f.ts < ? AND f.ts >= ? AND ${c.sql}
     UNION ALL SELECT ${cols} FROM flows f INDEXED BY flows_to WHERE f.to_addr = ? AND f.from_addr IS NOT ? AND f.ts < ? AND f.ts >= ? AND ${c.sql})
     ORDER BY ts DESC LIMIT 8`,
  ).bind(address, flow.ts, flow.ts - BEFORE_WINDOW_MS, ...c.params, address, address, flow.ts, flow.ts - BEFORE_WINDOW_MS, ...c.params);
  const own = crossingOf(flow);
  return {
    stmt,
    fill: (rows) => set(rows
      .map((r) => ({ r, meta: typeof r.meta === 'string' ? safeJson(r.meta) : null }))
      // a record of this move's own crossing that the time rule did not catch (both records carry the packet)
      .filter(({ r, meta }) => !(own && crossingOf({ id: r.id, kind: r.kind, chain: r.chain, meta } as Flow) === own))
      .slice(0, BEFORE_SHOWN)
      .map(({ r, meta }) => ({
        id: String(r.id), kind: r.kind, chain: r.chain, amount: Number(r.amount_num), ts: Number(r.ts), received: r.to_addr === address,
        crossing: crossingOf({ id: r.id, kind: r.kind, chain: r.chain, meta } as Flow),
      }))),
  };
}

const safeJson = (s: string): Record<string, unknown> | null => {
  try { return JSON.parse(s); } catch { return null; }
};

/**
 * The context of one move to be posted: the flow with both sides' labels joined (the live path's flow has none) and
 * what the alert says beside it. Never throws: a batch that fails, or does not come back within `deadlineMs`, gives
 * the flow as it was and the context that needs no read (contextWithoutReads), and says so in the log.
 */
export async function readMoveContext(db: D1Database | undefined, flow: Flow, now = Date.now(), deadlineMs = CONTEXT_DEADLINE_MS): Promise<{ flow: Flow; ctx: MoveContext }> {
  const base = contextWithoutReads(flow);
  if (!db) return { flow, ctx: base };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const out: Flow = { ...flow };
    const ctx: MoveContext = { ...base };
    const reads: Read[] = [];
    const { party, other } = partiesOf(flow);
    const who = personal(party.address) ? party.address : null;
    const theOther = personal(other.address) ? other.address : null;
    const dest = bridgeDest(flow.kind, flow.chain);
    const trade = flow.kind === 'buy' || flow.kind === 'sell';
    const nam = !isOtherCoin(flow);

    // Both sides' labels, as the flows query joins them (analytics.ts rowToFlow), when the flow came without them.
    if (flow.fromLabelSource === undefined && flow.toLabelSource === undefined) {
      const addrs = [...new Set([flow.from, flow.to].filter(personal))];
      if (addrs.length) {
        reads.push({
          stmt: db.prepare(`SELECT address, label, source, author FROM labels WHERE address IN (${addrs.map(() => '?').join(', ')})`).bind(...addrs),
          fill: (rows) => {
            const by = new Map(rows.map((r) => [r.address as string, r]));
            const join = (a: string | null) => {
              const r = a ? by.get(a) : undefined;
              return r ? { label: r.label ?? null, plain: label_plain(r.label, a, r.source), source: r.label ? r.source ?? null : null, author: r.label ? labelAuthorShort(r.source, r.author) : null } : null;
            };
            const fr = join(out.from), tr = join(out.to);
            if (fr) Object.assign(out, { fromLabel: fr.label, fromLabelPlain: fr.plain, fromLabelSource: fr.source, fromLabelAuthor: fr.author });
            if (tr) Object.assign(out, { toLabel: tr.label, toLabelPlain: tr.plain, toLabelSource: tr.source, toLabelAuthor: tr.author });
          },
        });
      }
    }

    // A bot round trip has no "Before this": the list leaves bot trades out, so it would say nothing true of a bot.
    if (nam && who && !isBotFlow(flow)) {
      reads.push(priorMoves(db, flow, who, (m) => { ctx.before = m; }));
      // The person's moves on record before this one, up to HISTORY_COUNT_MAX + 1 a side (counted from the newest).
      const c = priorConds(flow);
      const side = (name: string, index: string, where: string) =>
        `SELECT '${name}' AS side, ts FROM (SELECT f.ts FROM flows f INDEXED BY ${index} WHERE ${where} AND f.ts < ? AND ${c.sql} ORDER BY f.ts DESC LIMIT ${HISTORY_COUNT_MAX + 1})`;
      reads.push({
        stmt: db.prepare(`SELECT side, COUNT(*) AS n, MIN(ts) AS first, MAX(ts) AS last FROM (${side('from', 'flows_from', 'f.from_addr = ?')}
            UNION ALL ${side('to', 'flows_to', 'f.to_addr = ? AND f.from_addr IS NOT ?')}) GROUP BY side`)
          .bind(who, flow.ts, ...c.params, who, who, flow.ts, ...c.params),
        fill: (rows) => {
          const n = rows.reduce((a, r) => a + (Number(r.n) || 0), 0);
          const firsts = rows.map((r) => Number(r.first)).filter(Number.isFinite);
          const lasts = rows.map((r) => Number(r.last)).filter(Number.isFinite);
          ctx.history = { n, first: firsts.length ? Math.min(...firsts) : null, last: lasts.length ? Math.max(...lasts) : null, capped: rows.some((r) => Number(r.n) > HISTORY_COUNT_MAX) };
        },
      });
    }

    // A trade, or a crossing to Osmosis (its receiver's sales): the person's trades of that side in the 30 days before.
    const tradeSide: 'buy' | 'sell' | null = trade ? (flow.kind as 'buy' | 'sell') : dest === 'osmosis' ? 'sell' : null;
    const trader = trade ? who : dest === 'osmosis' && personal(flow.to) && chainOf(flow.to) === 'osmosis' ? flow.to : null;
    if (nam && tradeSide && trader) {
      const col = tradeSide === 'buy' ? 'to_addr' : 'from_addr';
      reads.push({
        stmt: db.prepare(`SELECT COUNT(*) AS n, SUM(f.amount_num) AS nam, MIN(f.ts) AS first FROM flows f INDEXED BY ${tradeSide === 'buy' ? 'flows_to' : 'flows_from'}
            WHERE f.${col} = ? AND f.chain = 'osmosis' AND f.kind = ? AND f.ts < ? AND f.ts >= ? AND f.id != ? AND ${NOT_BOT}`)
          .bind(trader, tradeSide, flow.ts, flow.ts - TRADES_WINDOW_MS, flow.id),
        fill: (rows) => {
          const r = rows[0];
          if (r) ctx.trades30d = { side: tradeSide, n: Number(r.n) || 0, nam: Number(r.nam) || 0, firstTs: r.first != null ? Number(r.first) : null };
        },
      });
    }

    // A trade: the person's newest crossing from Namada in the 7 days before (the question of decision D2: did NAM
    // just arrive to be sold?), named on its own even when other moves came after it.
    if (nam && trade && who && chainOf(who) === 'osmosis') {
      reads.push({
        stmt: db.prepare(`SELECT f.id, f.amount_num, f.ts, f.meta FROM flows f INDEXED BY flows_to WHERE f.to_addr = ? AND f.chain = 'osmosis' AND f.kind = 'ibc_in' AND f.ts < ? AND f.ts >= ? AND ${NAM_AMOUNT} ORDER BY f.ts DESC LIMIT 1`)
          .bind(who, flow.ts, flow.ts - BEFORE_WINDOW_MS),
        fill: (rows) => {
          const r = rows[0];
          if (!r) return;
          const meta = typeof r.meta === 'string' ? safeJson(r.meta) : null;
          ctx.crossingIn = { id: String(r.id), amount: Number(r.amount_num), ts: Number(r.ts), crossing: crossingOf({ id: r.id, kind: 'ibc_in', chain: 'osmosis', meta } as Flow) };
        },
      });
    }

    // A crossing or a transfer: the other side's moves too.
    if (nam && theOther && (dest != null || flow.kind === 'transfer')) reads.push(priorMoves(db, flow, theOther, (m) => { ctx.otherBefore = m; }));

    // A crossing to Osmosis: the receiver's NAM on deck as of now, as Supply's on-deck list counts it (analytics.ts
    // pressure): bridged in over the 7 days to now, less its sales since the first of those crossings, less what it
    // bridged back since then (sends refunded after a timeout left out, analytics.ts timedOutSends).
    const receiver = dest === 'osmosis' && nam && personal(flow.to) && chainOf(flow.to) === 'osmosis' ? flow.to : null;
    if (receiver) {
      const from = now - BEFORE_WINDOW_MS;
      const deck = { in: null as { nam: number; first: number } | null, out: [] as any[], refunds: [] as any[] };
      reads.push({
        stmt: db.prepare(`SELECT SUM(f.amount_num) AS nam, MIN(f.ts) AS first FROM flows f INDEXED BY flows_to WHERE f.to_addr = ? AND f.chain = 'osmosis' AND f.kind = 'ibc_in' AND f.ts >= ? AND f.ts <= ? AND ${NAM_AMOUNT}`)
          .bind(receiver, from, now),
        fill: (rows) => { const r = rows[0]; if (r && r.first != null) deck.in = { nam: Number(r.nam) || 0, first: Number(r.first) }; },
      });
      reads.push({
        stmt: db.prepare(`SELECT f.id, f.kind, f.ts, f.from_addr, f.to_addr, f.amount_num, f.meta FROM flows f INDEXED BY flows_from
            WHERE f.from_addr = ? AND f.chain = 'osmosis' AND f.kind IN ('sell', 'ibc_out') AND f.ts >= ? AND f.ts <= ? AND ${NAM_AMOUNT}
              AND (f.kind != 'sell' OR f.meta IS NULL OR f.meta NOT LIKE '%"arb":true%') LIMIT 2000`).bind(receiver, from, now),
        fill: (rows) => { deck.out = rows; },
      });
      reads.push({
        stmt: db.prepare(`SELECT f.id, f.ts, f.from_addr, f.to_addr, f.amount_num, f.meta FROM flows f INDEXED BY flows_to
            WHERE f.to_addr = ? AND f.chain = 'osmosis' AND f.kind = 'other' AND f.ts >= ? AND f.ts <= ? AND f.meta LIKE '%"ibcTimeoutRefund":true%' LIMIT 500`).bind(receiver, from, now),
        fill: (rows) => {
          deck.refunds = rows;
          if (!deck.in) return;
          const first = deck.in.first;
          const sold = deck.out.filter((r) => r.kind === 'sell' && Number(r.ts) >= first).reduce((a, r) => a + Number(r.amount_num), 0);
          const outs = deck.out.filter((r) => r.kind === 'ibc_out').map(ibcRowOf);
          const gone = timedOutSends(outs, deck.refunds.map(ibcRowOf));
          const sentBack = outs.filter((o) => !gone.has(o.id) && o.ts >= first).reduce((a, o) => a + o.amount, 0);
          const soldCounted = Math.min(sold, deck.in.nam);
          const sentBackCounted = Math.min(sentBack, deck.in.nam - soldCounted);
          ctx.onDeck = { bridgedIn: deck.in.nam, remaining: Math.max(0, deck.in.nam - soldCounted - sentBackCounted) };
        },
      });
    }

    // A trade's coins that need the minute's stored quote (analytics.ts settlePrices does the same seek).
    const rec = trade ? settleMetaOf(flow.meta ?? null) : null;
    const asks = rec ? quotesNeeded(rec).filter((c) => QUOTE_KEYS[c]) : [];
    if (rec && asks.length) {
      const quotes: Record<string, number> = {};
      asks.forEach((sym, i) => reads.push({
        stmt: db.prepare('SELECT ts, value FROM metrics WHERE key = ? AND ts <= ? AND ts >= ? ORDER BY ts DESC LIMIT 1').bind(QUOTE_KEYS[sym], flow.ts, flow.ts - QUOTE_MATCH_MS),
        fill: (rows) => {
          const v = Number(rows[0]?.value);
          if (v > 0) quotes[sym] = v;
          if (i === asks.length - 1) ctx.settle = settleOf(flow.kind as 'buy' | 'sell', rec, quotes);
        },
      }));
    }

    // The kv rows a kind needs, read in the same batch unless this isolate holds a copy younger than CONTEXT_CACHE_MS.
    const pos = flow.kind === 'bond' || flow.kind === 'unbond';
    const route = priceHowOf(flow) === 'spot' && priceRouteOf(flow) == null;
    const keys = [...(pos ? ['chain.params', 'intel.cache'] : []), ...(route ? [PRICE_HOW_KEY] : [])];
    const kv: Record<string, unknown> = {};
    for (const k of keys) { const v = cached<unknown>(k, now); if (v !== undefined) kv[k] = v; }
    const want = [...keys.filter((k) => !(k in kv)), ...(flow.kind === 'unbond' ? ['unbond.withdraw'] : [])];
    if (want.length) {
      reads.push({
        stmt: db.prepare(`SELECT key, value FROM kv WHERE key IN (${want.map(() => '?').join(', ')})`).bind(...want),
        fill: (rows) => {
          for (const k of want) {
            const r = rows.find((x) => x.key === k);
            const v = r ? KEEP[k]?.(safeJson(String(r.value))) ?? safeJson(String(r.value)) : null;
            kv[k] = v;
            if (KEEP[k]) cache.set(k, { at: now, value: v });
          }
        },
      });
    }

    if (reads.length) {
      const late = new Promise<'late'>((resolve) => { timer = setTimeout(() => resolve('late'), deadlineMs); });
      const res = await Promise.race([db.batch(reads.map((r) => r.stmt)), late]);
      if (res === 'late') {
        console.warn(`alerts: the context of move ${flow.id} was not read within ${deadlineMs} ms; the alert goes without it`);
        return { flow, ctx: base };
      }
      reads.forEach((r, i) => r.fill(((res as D1Result[])[i]?.results ?? []) as any[]));
    }

    // What the kv rows say for this move.
    const stored = kv['chain.params'] as ChainParams | null | undefined;
    // the measured epoch length and how it was measured, which every time said from epochs needs
    const params = stored && Number.isFinite(stored.unbondingLength) && Number.isFinite(stored.pipelineLength) && Number(stored.epochSec) > 0
      ? { ...stored, epochSec: Number(stored.epochSec), epochSecNote: stored.epochSecNote ?? `about ${(Number(stored.epochSec) / 3600).toFixed(2)} h an epoch` }
      : null;
    const paramsOk = params != null;
    const validator = typeof flow.meta?.validator === 'string' ? flow.meta.validator : null;
    if (pos && validator) {
      const names = kv['intel.cache'] as Record<string, string> | null | undefined;
      ctx.validatorName = names?.[validator] ?? null;
    }
    if (flow.kind === 'bond' && paramsOk) {
      const epochs = withdrawEpochs(params!);
      ctx.wait = { epochs, days: (epochs * params!.epochSec) / 86400, note: params!.epochSecNote };
    }
    if (flow.kind === 'unbond') {
      const map = kv['unbond.withdraw'] as UnbondWithdrawCache | null | undefined;
      const staker = isInternal(flow.from) ? flow.to : flow.from;
      // The withdraw map as Supply reads it: while current, the entry of this address, amount and validator.
      const live = map && Number.isFinite(map.at) && map.at >= flow.ts && now - map.at <= UNBOND_WITHDRAW_STALE_MS ? map : null;
      const listed = staker ? live?.byAddress?.[staker]?.find((u) => Math.abs(u.amountNam - flow.amount) < 1e-6 && (!validator || u.validator === validator)) : undefined;
      if (listed) {
        const source = listed.source ?? 'indexer';
        ctx.unlockAt = listed.withdrawTime != null
          ? { at: listed.withdrawTime, source, note: source === 'consensus' ? 'the chain’s own list gives the epoch it ends in; the time comes from the measured epoch length' : 'the end of the wait from the Namada indexer' }
          : { at: null, source, note: `withdrawable from epoch ${listed.withdrawEpoch.toLocaleString('en-US')} (the chain’s bond listing); the time is not known because the epoch length could not be read` };
      } else if (paramsOk) {
        const epochs = withdrawEpochs(params!);
        ctx.unlockAt = { at: flow.ts + epochs * params!.epochSec * 1000, source: 'estimate', note: `estimate: the request time + ${epochs} epochs of ${params!.epochSecNote}, late by up to one epoch` };
      }
    }
    if (route) {
      const how = priceHowAt(kv[PRICE_HOW_KEY] as PriceHowLog | null | undefined, flow.ts);
      ctx.priceRoute = how?.how === 'route' ? how.refNam : null;
    }
    return { flow: out, ctx };
  } catch (e) {
    console.warn(`alerts: the context of move ${flow.id} could not be read; the alert goes without it:`, e);
    return { flow, ctx: base };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Forgets this isolate's copies of the kv rows (tests). */
export const resetContextCache = () => cache.clear();
