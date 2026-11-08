// Every coin in the shielded pool besides NAM (builder G of the halt release, 2026-11-08; migration 0024).
//
// The live hub keeps the pool's post-balance of every coin a block's token/transfer events carry (parse/namada.ts
// NamadaParsed.maspCoins) in one kv row, masp.coins: { <token address>: { base, height, at } }, merged block by block
// (mergeMaspCoins). A coin that arrived or left by an IBC mint or burn at the pool carries no post-balance: its entry
// holds base null until the daily job reads the chain. Once a day the job (series.ts daily(), part 'shielded coins')
// confirms each stored coin with one ABCI read of the pool's balance key for that token (sources/namada.ts
// maspCoinBalance, the multitoken key with the coin's address in NAM's place) and writes one masp_coins_daily row per
// coin, saying whether the figure is the read or the last post-balance, and a metrics row masp.coin.<symbol>.daily for
// a coin the parser's token table names (NAMADA_TOKENS; a token it does not name is stored by address and shown
// nowhere). NAM is not here: its pool balance is the minute reading (supply.masp_shielded) and each flow's maspPostNam.
//
// One alert, to the operator's channel alone (never subscribers, never X): a coin's pool balance that falls to 0 or by
// half or more in one block, when the coin is quoted on this site and its pool balance before the fall was worth
// COIN_FALL_FLOOR_USD or more at that quote. The words name the coin, the amounts and the block (coinFallWords); the
// fall is also kept on the coin's kv entry (`fell`), posted or not. Nothing is said about who moved it or why.
import type { MaspCoinSeen } from './parse/namada';
import { NAMADA_TOKENS } from './parse/namada';
import type { Stmt } from './db';
import { stmt } from './db';
import { QUOTE_KEYS } from '../../shared/settle';

/** The hub's row of every coin's pool balance as the blocks gave it. */
export const MASP_COINS_KV = 'masp.coins';

/** One coin's entry in kv masp.coins. */
export interface MaspCoinEntry {
  /** the pool's balance in the coin's base units after block `height`'s last event for it, as the chain writes it; null when that event was an IBC mint or burn, which gives none */
  base: string | null;
  height: number;
  /** when the hub wrote it (unix ms) */
  at: number;
  /** the block's own time */
  ts?: number;
  /** the last fall the fall rule found for the coin (coinFallOf), whether or not it was posted */
  fell?: { fromBase: string; toBase: string; height: number; ts: number; at: number; posted: boolean };
}
export type MaspCoins = Record<string, MaspCoinEntry>;

/** A fall of a coin's pool balance in one block that the rule names (coinFallOf). */
export interface CoinFall { token: string; fromBase: bigint; toBase: bigint; height: number; ts: number }

const isBase = (s: unknown): s is string => typeof s === 'string' && /^\d+$/.test(s);

/**
 * The stored row read as a MaspCoins map: entries with a token address key and a well-formed base (or null) are kept,
 * anything else is dropped (never guessed).
 */
export function maspCoinsOf(raw: unknown): MaspCoins {
  const out: MaspCoins = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [token, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^tnam1[02-9ac-hj-np-z]{10,}$/.test(token) || !v || typeof v !== 'object') continue;
    const e = v as Record<string, unknown>;
    if (!(e.base === null || isBase(e.base)) || !Number.isInteger(e.height) || !Number.isFinite(e.at)) continue;
    const entry: MaspCoinEntry = { base: e.base as string | null, height: e.height as number, at: e.at as number };
    if (Number.isFinite(e.ts)) entry.ts = e.ts as number;
    const f = e.fell as Record<string, unknown> | undefined;
    if (f && isBase(f.fromBase) && isBase(f.toBase) && Number.isInteger(f.height) && Number.isFinite(f.ts) && Number.isFinite(f.at)) {
      entry.fell = { fromBase: f.fromBase, toBase: f.toBase, height: f.height as number, ts: f.ts as number, at: f.at as number, posted: f.posted === true };
    }
    out[token] = entry;
  }
  return out;
}

/**
 * The fall rule: the pool's balance of a coin went from `from` to `to` in one block and `to` is 0, or at most half of
 * `from`. A coin first seen (no stored base), one whose new word is an IBC event (no post-balance), or a block older
 * than the stored one (a block read again) is never a fall.
 */
export const isCoinFall = (from: bigint, to: bigint): boolean => from > 0n && (to === 0n || to * 2n <= from);

/**
 * The stored map after one block: each coin the block's events named takes the block's word (a post-balance, or null
 * after an IBC mint or burn), stamped with the block and the time; a coin from a block at or below the stored one
 * changes nothing (the scan read a block again). Returns the next map and the falls the block made (isCoinFall),
 * which the caller may post and which are kept on the entry either way.
 */
export function mergeMaspCoins(prev: MaspCoins, seen: Record<string, MaspCoinSeen>, height: number, ts: number, now: number): { next: MaspCoins; falls: CoinFall[] } {
  const next: MaspCoins = { ...prev };
  const falls: CoinFall[] = [];
  for (const [token, s] of Object.entries(seen)) {
    const p = prev[token];
    if (p && p.height >= height) continue;
    const entry: MaspCoinEntry = { base: s.base, height, at: now, ts, ...(p?.fell ? { fell: p.fell } : {}) };
    if (p && isBase(p.base) && isBase(s.base)) {
      const from = BigInt(p.base), to = BigInt(s.base);
      if (isCoinFall(from, to)) {
        falls.push({ token, fromBase: from, toBase: to, height, ts });
        entry.fell = { fromBase: p.base, toBase: s.base, height, ts, at: now, posted: false };
      }
    }
    next[token] = entry;
  }
  return { next, falls };
}

// ---------------------------------------------------------------- the coin's quote on this site

/**
 * How a coin of the pool is quoted on this site, by the token table's symbol: a dollar for Noble USDC however it came
 * (shared/settle.ts counts USDC at a dollar), else the minute quote of the coins the Osmosis price list is asked for
 * (shared/settle.ts QUOTE_KEYS, written each tick by the cron). A coin not here has no quote on this site, so no fall
 * of it reaches the floor: nothing is priced from elsewhere.
 */
export const MASP_COIN_QUOTE: Readonly<Record<string, { stable: true } | { metric: string }>> = {
  'USDC (Noble)': { stable: true },
  'USDC (via Osmosis)': { stable: true },
  OSMO: { metric: QUOTE_KEYS.OSMO },
  ATOM: { metric: QUOTE_KEYS.ATOM },
  TIA: { metric: QUOTE_KEYS.TIA },
  allETH: { metric: QUOTE_KEYS.ETH },
};

/** A coin's name and decimals from the parser's token table, or null for a token it does not name. */
export const coinOf = (token: string): { symbol: string; decimals: number } | null => {
  const t = NAMADA_TOKENS[token];
  return t ? { symbol: t.symbol, decimals: t.decimals } : null;
};

/** The metrics key of a coin's daily pool balance: the symbol in lower case, every run of other characters one underscore ("usdc_noble"). */
export const coinDailyKey = (symbol: string): string => `masp.coin.${symbol.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}.daily`;

/** Base units as a number of the coin's units (a float: for display and the metrics row, never for a comparison). */
export const coinUnits = (base: bigint | string, decimals: number): number => Number(BigInt(base)) / 10 ** decimals;

/** The pool balance before the fall, in US dollars at `usdEach`, or null when the coin has no quote. */
export const fallValueUsd = (fall: CoinFall, decimals: number, usdEach: number | null): number | null =>
  usdEach != null && usdEach > 0 ? coinUnits(fall.fromBase, decimals) * usdEach : null;

/** The floor: a fall is posted only when the coin's pool balance before it was worth at least this at the site's quote. */
export const COIN_FALL_FLOOR_USD = 1000;

const nf = (n: number, maxFrac: number) => n.toLocaleString('en-US', { maximumFractionDigits: maxFrac });
const n0 = (n: number) => nf(n, 0);
/** A coin amount in its units from base units, all decimals kept and trailing zeros trimmed ("150,355.823285", "0"). */
export function coinAmountWords(base: bigint, decimals: number): string {
  const digits = base.toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = decimals ? digits.slice(-decimals).replace(/0+$/, '') : '';
  return frac ? `${whole}.${frac}` : whole;
}
const clock = (ms: number) => `${new Date(ms).toISOString().slice(0, 10)} ${new Date(ms).toISOString().slice(11, 16)} UTC`;

/**
 * The operator's line for one fall: the coin, the pool's balance before and after, the share that left, the block and
 * its time, and the dollar value before the fall at the quote the site had. Plain words about a balance; nothing about
 * a person or a reason.
 */
export function coinFallWords(fall: CoinFall, symbol: string, decimals: number, valueUsd: number, quoteAt: number | null): string {
  const pct = fall.fromBase === 0n ? 100 : Number(((fall.fromBase - fall.toBase) * 10000n) / fall.fromBase) / 100;
  const to = fall.toBase === 0n ? '0' : coinAmountWords(fall.toBase, decimals);
  const quote = quoteAt != null ? `the site's quote at ${clock(quoteAt)}` : "the site's quote";
  return `Shielded pool, ${symbol}: the pool's balance went from ${coinAmountWords(fall.fromBase, decimals)} to ${to} ${symbol} in block ${n0(fall.height)} (${clock(fall.ts)}), ${nf(pct, 1)}% of it. Before the block the balance was worth about ${n0(valueUsd)} US dollars at ${quote}.`;
}

// ---------------------------------------------------------------- the daily rows (series.ts daily(), part 'shielded coins')

/** One coin's figure for the day's row: the read, or the hub's post-balance when the read failed. */
export interface CoinDayFigure { token: string; base: string; basis: 'read' | 'post-balance'; height: number | null; provider: string | null; at: number }

export const COIN_DAY_SQL = `INSERT OR REPLACE INTO masp_coins_daily (day, token, symbol, base, units, basis, height, provider, at) VALUES (?,?,?,?,?,?,?,?,?)`;

/**
 * The statements for one day's coin rows: a masp_coins_daily row per figure (symbol and units from the token table,
 * null for a token it does not name), and a metrics row masp.coin.<symbol>.daily for a named coin, at the day's start.
 */
export function coinDayStmts(day: string, figures: CoinDayFigure[]): Stmt[] {
  const ts = Date.parse(`${day}T00:00:00Z`);
  const out: Stmt[] = [];
  for (const f of figures) {
    if (!isBase(f.base)) continue;
    const c = coinOf(f.token);
    const units = c ? coinUnits(f.base, c.decimals) : null;
    out.push({ sql: COIN_DAY_SQL, params: [day, f.token, c?.symbol ?? null, f.base, units, f.basis, f.height, f.provider, f.at] });
    if (c && units != null && Number.isFinite(units)) out.push(stmt.metric(ts, coinDailyKey(c.symbol), units));
  }
  return out;
}

/**
 * The day's figure for each stored coin from the reads: the read when it answered (`basis` 'read', its block and
 * node), else the hub's post-balance when the entry has one ('post-balance', its block), else nothing for the coin.
 */
export function coinDayFigures(coins: MaspCoins, reads: Record<string, { base: string; height: number; provider: string } | null>, now: number): { figures: CoinDayFigure[]; notRead: string[]; unknown: string[] } {
  const figures: CoinDayFigure[] = [];
  const notRead: string[] = [];
  const unknown: string[] = [];
  for (const [token, e] of Object.entries(coins)) {
    const r = reads[token];
    if (r && isBase(r.base)) figures.push({ token, base: r.base, basis: 'read', height: r.height, provider: r.provider, at: now });
    else {
      notRead.push(token);
      if (isBase(e.base)) figures.push({ token, base: e.base, basis: 'post-balance', height: e.height, provider: null, at: now });
      else unknown.push(token);
    }
  }
  return { figures, notRead, unknown };
}
