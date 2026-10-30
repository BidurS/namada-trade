// What the site's own public voices post: the X account (sources/x.ts) and the public Telegram channel
// (TELEGRAM_CHANNEL, sources/telegram.ts). Both take their moves from one selector (scale plan, Stage 1 item 3, owner
// 2026-10-29): each closed UTC hour gives at most one move, the hour's largest by dollars, read from the stored moves
// once HOUR_SETTLE_MS have passed since the hour closed, so the post is the hour's largest and never the first move to
// arrive (the live path posted every move of 10,000 NAM and up until the day's posts were spent: on 29 Oct by 19:30
// UTC, before the evening's moves, and a run of them could crowd out the 13:00 UTC recap).
//
// A move qualifies when the site's own channel hears of it (sources/discord.ts operatorMove: NAM, at or above the
// chain's whale size, no bot round trip, no rewards claim) and its dollars are known and at least PUBLIC_POST_USD_MIN:
// a trade's settle price (what its trader got or paid, fees in: shared/settle.ts), else its NAM times the price stored
// with it, with that price's source. A move whose dollars are not known is never valued at a guess: it does not qualify.
//
// The post is built from an allowlist of the move's fields (PublicMove): its kind, chain and NAM (the title the site
// writes, shared/flow-words.ts moveTitle), its pools (digits only), the dollars with where they come from, each side
// as a protocol account's name or a short real address (util.ts isRealAddress: the checksum too), the time and the
// block. Nothing an outsider wrote reaches it: no memo, no label or tag, no forum text, no bridge receiver that is not
// an address. The other public posts must carry some outsider text (a proposal's title, a forum topic's title and its
// category); plainOutsider keeps it to plain words: no link, no bare domain, no mention, no hidden character.
import type { Chain, Flow, FlowKind } from '../../shared/types';
import { INTERNAL_ADDRESSES, isInternal } from '../../shared/alerts';
import { isIbcRefund, priceAtOf, priceHowOf, priceRouteOf, priceSourceWords, type PriceHow } from '../../shared/flow-rules';
import { CHAIN_WORD, listWords, moveTitle, partiesOf } from '../../shared/flow-words';
import { bridgeDest } from '../../shared/kinds';
import { fmtAddr, fmtUsdRule } from '../../shared/format';
import { settleUsd } from '../../shared/settle';
import { rowToFlow, settlePrices } from './analytics';
import { NAM_AMOUNT, NOT_BOT } from './flows-query';
import { isRealAddress } from './util';
import { crossingOf, cutText, operatorMove, PROTOCOL_WORDS } from './sources/discord';

const HOUR = 3_600_000;
/**
 * A move is posted only from this many dollars, beside the chain's NAM whale size: on 2026-10-29 the 10,000 NAM of
 * the whale size alone was about $8, the cheapest move anyone could make to be posted (scale plan, Stage 1 item 3).
 */
export const PUBLIC_POST_USD_MIN = 100;
/**
 * An hour is read this long after it closed: past one catch-up search (live-hub.ts OSMOSIS_SWEEP_EVERY_MS, 5 min) and a
 * scan the live hub reads late (LATE_SCAN_MS, 5 min), so a move the live feed missed is in the hour it happened in.
 */
export const HOUR_SETTLE_MS = 10 * 60_000;
/**
 * The hour's largest moves by NAM that are read, then ranked by dollars: a move outside them could rank first only by
 * being worth more per NAM than fifty larger moves of its own hour.
 */
export const PUBLIC_HOUR_READ = 50;

/** The hour's moves that may qualify, the largest NAM first: one range of the flows_ts index, bounded by the hour and by PUBLIC_HOUR_READ. */
export const HOUR_MOVES_SQL = `SELECT f.id, f.chain, f.height, f.ts, f.tx_hash, f.kind, f.from_addr, f.to_addr, f.amount_num, f.counter_denom,
       f.counter_amount, f.pool_id, f.price_usd, f.value_usd, f.meta
  FROM flows f INDEXED BY flows_ts
  WHERE f.ts >= ?1 AND f.ts < ?2 AND f.amount_num >= ?3 AND f.kind != 'rewards' AND ${NAM_AMOUNT} AND ${NOT_BOT}
  ORDER BY f.amount_num DESC, f.ts ASC, f.id ASC LIMIT ${PUBLIC_HOUR_READ}`;

/** The NAM whale size of each chain's moves (wrangler.jsonc WHALE_OSMOSIS_NAM, WHALE_NAMADA_NAM). */
export interface NamFloors { osmosis: number; namada: number }
export const namFloors = (env: { WHALE_OSMOSIS_NAM?: string; WHALE_NAMADA_NAM?: string }): NamFloors => ({
  osmosis: Number(env.WHALE_OSMOSIS_NAM || 10000),
  namada: Number(env.WHALE_NAMADA_NAM || 10000),
});

/**
 * Everything a public post says of a move, and nothing else: the allowlist. Each side is in words already: a protocol
 * account's name, a short real address, or the site's own words for a side that is none (no address, or text a
 * bridge sender chose).
 */
export interface PublicMove {
  /** the record's id and its crossing (sources/discord.ts crossingOf), for the claims only; never written in a post */
  id: string;
  crossing: string | null;
  kind: FlowKind;
  chain: Chain;
  nam: number;
  /** a crossing to Namada into the shielded pool (the title says so) */
  intoShielded: boolean;
  /** a bridge refund (the title says so) */
  refund: boolean;
  /** the pools a trade or a pool move went through, digits only */
  pools: string[];
  /** the side the move is about, and the other, in words */
  who: string;
  other: string;
  /** the side the move is about when it is a real address of either chain and no protocol account: its page on the site */
  person: string | null;
  /** the move's dollars: a trade's settle (`settle`), else NAM times the price stored with it (`price`) */
  usd: number;
  usdPerNam: number;
  basis: { kind: 'settle'; side: 'buy' | 'sell' } | { kind: 'price'; how: PriceHow; source: string };
  ts: number;
  height: number;
}

/** A side in words: a protocol account by its name, a real address short, or the site's words for a side that is none. */
function sideWords(a: string | null | undefined, bridgeEnd?: string): string {
  if (!a) return 'an account this record does not name';
  if (bridgeEnd && (a === INTERNAL_ADDRESSES.ibc || a === INTERNAL_ADDRESSES.osmoTransfer)) return bridgeEnd;
  if (PROTOCOL_WORDS[a]) return PROTOCOL_WORDS[a];
  return isRealAddress(a) ? fmtAddr(a) : 'text that is not an address';
}

/**
 * A stored move as a public post may use it, or null when it does not qualify: not a move the site's channel hears of
 * at its chain's whale size, its dollars not known, or under PUBLIC_POST_USD_MIN. `settle` is the trade's settle price,
 * when it has one.
 */
export function publicMoveOf(f: Flow, floors: NamFloors, settle: Flow['settle'] | null = null): PublicMove | null {
  if (!operatorMove(f, f.chain === 'namada' ? floors.namada : floors.osmosis)) return null;
  const trade = f.kind === 'buy' || f.kind === 'sell';
  let usd: number, usdPerNam: number, basis: PublicMove['basis'];
  if (trade && settle) {
    usd = settleUsd(settle);
    usdPerNam = settle.usdPerNam;
    basis = { kind: 'settle', side: settle.side };
  } else {
    const how = priceHowOf(f);
    if (how === 'none' || !(Number(f.priceUsd) > 0)) return null;
    usdPerNam = Number(f.priceUsd);
    usd = f.amount * usdPerNam;
    basis = { kind: 'price', how, source: priceSourceWords(how, priceAtOf(f), priceRouteOf(f)).short };
  }
  if (!Number.isFinite(usd) || usd < PUBLIC_POST_USD_MIN) return null;
  const { party, other } = partiesOf(f);
  const dest = bridgeDest(f.kind, f.chain);
  const here = dest === 'osmosis' ? 'Namada' : 'Osmosis', there = dest === 'osmosis' ? 'Osmosis' : 'Namada';
  // a crossing names the sender and the receiver in that order, whichever is the person
  const crossing = dest != null;
  const [first, second] = crossing || f.kind === 'transfer' || f.kind === 'pos_balance' ? [f.from, f.to] : [party.address, other.address];
  const pools = (f.poolId ?? '').split(',').map((x) => x.trim()).filter((x) => /^\d{1,10}$/.test(x));
  return {
    id: f.id, crossing: crossingOf(f), kind: f.kind, chain: f.chain, nam: f.amount,
    intoShielded: dest === 'namada' && f.to === INTERNAL_ADDRESSES.masp,
    refund: isIbcRefund(f),
    pools,
    who: sideWords(first, crossing ? `a sender on ${here} this record does not name` : undefined),
    other: sideWords(second, crossing ? `a receiver on ${there} this record does not name` : undefined),
    person: party.address && !isInternal(party.address) && isRealAddress(party.address) ? party.address : null,
    usd, usdPerNam, basis, ts: f.ts, height: f.height,
  };
}

/** Largest dollars first; an equal sum, the earlier move, then the id. */
const byDollars = (a: PublicMove, b: PublicMove) => b.usd - a.usd || a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The hour [start, end)'s qualifying moves, the largest by dollars first: the PUBLIC_HOUR_READ largest by NAM, each
 * trade priced at its settle (analytics.ts settlePrices, one quote seek per coin that needs one). Throws when the
 * moves cannot be read: a read that failed is not a quiet hour.
 */
export async function hourMoves(db: D1Database, start: number, end: number, floors: NamFloors): Promise<PublicMove[]> {
  const rows = (await db.prepare(HOUR_MOVES_SQL).bind(start, end, Math.min(floors.osmosis, floors.namada)).all()).results ?? [];
  const flows = rows.map(rowToFlow);
  const trades = flows.filter((f) => f.kind === 'buy' || f.kind === 'sell');
  const settles = trades.length ? await settlePrices(db, trades).catch(() => trades.map(() => null)) : [];
  const settleOf = new Map(trades.map((f, i) => [f.id, settles[i] ?? null]));
  return flows.map((f) => publicMoveOf(f, floors, settleOf.get(f.id) ?? null)).filter((m): m is PublicMove => m != null).sort(byDollars);
}

/** One closed hour as the public posts take it: its bounds, its key in the claims ("2026-10-29T09"), and its moves, read once whoever asks first. */
export interface PublicHour { start: number; end: number; key: string; moves: () => Promise<PublicMove[]> }

/** The hour the posts are due for at `now`: the latest one closed at least HOUR_SETTLE_MS ago. */
export function publicHour(db: D1Database, now: number, floors: NamFloors): PublicHour {
  const end = Math.floor((now - HOUR_SETTLE_MS) / HOUR) * HOUR;
  const start = end - HOUR;
  let read: Promise<PublicMove[]> | null = null;
  return { start, end, key: new Date(start).toISOString().slice(0, 13), moves: () => (read ??= hourMoves(db, start, end, floors)) };
}

/** Whether a claim key is taken: one kv seek. A read that fails counts as taken, so nothing is posted on it this time. */
export async function claimTaken(db: D1Database, key: string): Promise<boolean> {
  try {
    return !!(await db.prepare('SELECT 1 x FROM kv WHERE key = ?').bind(key).first());
  } catch {
    return true;
  }
}

/**
 * The first of the hour's moves a voice has not posted, by the key `postedKey` names for each (its crossing, so a
 * crossing's other record, an hour later, gives way to that hour's next move; else its record, so a move the live
 * posts carried before this selector is not posted again), and whether a larger one was passed over. One kv seek a
 * move, until the first not posted.
 */
export async function firstUnposted(db: D1Database, moves: PublicMove[], postedKey: (m: PublicMove) => string): Promise<{ move: PublicMove; passed: boolean } | null> {
  for (const [i, m] of moves.entries()) if (!(await claimTaken(db, postedKey(m)))) return { move: m, passed: i > 0 };
  return null;
}

// ---------------------------------------------------------------- the words

/** The title, in the site's words (moveTitle), from the allowlisted fields alone. */
export function publicTitle(m: PublicMove): string {
  return moveTitle({ kind: m.kind, chain: m.chain, amount: m.nam, to: m.intoShielded ? INTERNAL_ADDRESSES.masp : null, meta: m.refund ? { ibcTimeoutRefund: true } : null });
}

/** "pool 3005", "pools 3005, 3368 and 3009", "pools 3005, 3368, 3009 and 2 more". */
const poolWords = (pools: string[]) =>
  pools.length > 3 ? `pools ${pools.slice(0, 3).join(', ')} and ${pools.length - 3} more` : `pool${pools.length > 1 ? 's' : ''} ${listWords(pools)}`;

/** Who moved it, in words, with the pools of a trade or a pool move ("Sold by osmo1nn62s9…evpvh in pools 3005, 3368 and 3009"). */
export function publicWho(m: PublicMove): string {
  const via = m.pools.length ? poolWords(m.pools) : '';
  switch (m.kind) {
    case 'buy': return `Bought by ${m.who}${via ? ` in ${via}` : ''}`;
    case 'sell': return `Sold by ${m.who}${via ? ` in ${via}` : ''}`;
    case 'ibc_in': case 'ibc_out': case 'transfer': case 'pos_balance': return `From ${m.who} to ${m.other}`;
    case 'shield': return `From ${m.who} into the shielded pool`;
    case 'unshield': return `To ${m.who}, from the shielded pool`;
    case 'withdraw': case 'pgf': return `To ${m.who}`;
    case 'lp_add': case 'lp_remove': return `By ${m.who}${via ? `, ${via}` : ''}`;
    default: return m.refund ? `Refunded to ${m.who}: a send to Namada that timed out` : `By ${m.who}`;
  }
}

/** The dollars and where they come from, as the move's card says them (sources/discord.ts moveCard). */
export function publicValue(m: PublicMove): string {
  const usd = fmtUsdRule(m.usd), each = fmtUsdRule(m.usdPerNam);
  if (m.basis.kind === 'settle') return `Settled at ${each} a NAM, ${usd} in all (what the trader ${m.basis.side === 'sell' ? 'got' : 'paid'}, fees in).`;
  const trade = m.kind === 'buy' || m.kind === 'sell';
  if (trade && m.basis.how === 'execution') return `At ${each} a NAM, ${usd} in all (${m.basis.source}).`;
  if (trade) return `What it settled at is not on record; at ${each} a NAM (${m.basis.source}) it is worth about ${usd}.`;
  return `Worth ${usd} at ${each} a NAM (${m.basis.source}).`;
}

/**
 * Why the move is posted: it is the largest of its hour (named when `h` is given; a post that gives the move's time
 * leaves it out for room), and what the choice leaves out. `passed`: a larger move of the hour was posted already (a
 * crossing's other record, an hour before), so this is the largest left.
 */
export const publicWhy = (h: Pick<PublicHour, 'end'> | null, passed = false) =>
  `Largest move of the hour${h ? ` ending ${new Date(h.end).toISOString().slice(11, 16)} UTC` : ''}${passed ? ' not posted already' : ''}, bot round trips and rewards claims left out`;

/** The record it comes from ("Osmosis record, block 73,444,230"). */
export const publicRecord = (m: PublicMove) =>
  `${CHAIN_WORD[m.chain] ?? 'Chain'} record, block ${Number.isFinite(m.height) ? m.height.toLocaleString('en-US') : 'not known'}`;

// ---------------------------------------------------------------- outsider text

/**
 * Text an outsider wrote (a proposal's title, a forum topic's title or category) as plain words a public post may
 * carry, cut to `max` characters (sources/discord.ts cutText: never inside a character of two code units):
 * - compatibility forms folded (NFKC: the fullwidth ＠ and ． are an @ and a dot), and the ideographic 。 read as a
 *   dot, as domain names read it;
 * - no control, format, private-use or lone surrogate character (the private range is the one sources/telegram.ts
 *   hide uses for escapes);
 * - no link: a scheme is dropped, and every dot that would make a domain is written "[.]" ("namada-claim[.]xyz");
 * - no mention: an @ is "(at)";
 * - one line.
 */
export function plainOutsider(s: unknown, max: number): string {
  const t = String(s ?? '').normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cs}]/gu, ' ')
    .replace(/\u3002/g, '.')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/+/gi, '')
    .replace(/(?<=[\p{L}\p{N}_-])\.(?=\p{L})/gu, '[.]')
    .replace(/@/g, '(at)')
    .replace(/\s+/g, ' ')
    .trim();
  return cutText(t, max);
}
