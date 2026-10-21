// What a trade settled at for its trader: the coins their balance changed by, NAM against everything else, with the
// pools' and the taker's fees and the transaction fee in. The Osmosis parser records the coins (meta.settle,
// worker/src/parse/osmosis.ts); the Worker prices them at the trade's minute; the Alerts page shows the result.

/** A swap row's meta.settle: what the trader's balance changed by in the swap's own messages. */
export interface SettleMeta {
  /** NAM the trader's balance changed by: negative when they gave NAM (a sale), positive when they got it (a buy) */
  nam: number;
  /** Every other coin it changed by, by symbol (negative: paid). A coin routed through the trader and back is 0 and left out. */
  coins: Record<string, number>;
  /** The transaction fee, by symbol, when the trader paid it */
  gas?: Record<string, number>;
  /**
   * USD per unit for a coin, from this transaction's own swap of it against USDC in a pool trusted for that coin's
   * price (OSMOSIS.ratePools): the rate the trade itself converted at. The trader's own hop first, else any.
   */
  rates?: Record<string, number>;
  /** A coin the asset map does not know changed too: the trade has no USD settle price. */
  unknown?: true;
}

/**
 * The coins counted at a dollar: Noble USDC, and allUSDC, Osmosis's alloyed USDC (1:1 with the USDCs it holds; the
 * Osmosis quote service prices every coin in it).
 */
export const SETTLE_STABLES: readonly string[] = ['USDC', 'allUSDC'];

/** The metric that holds a coin's Osmosis quote each minute (worker/src/cron.ts), for a coin with no rate in its transaction. */
export const QUOTE_KEYS: Record<string, string> = { OSMO: 'price.osmo_usd' };

export interface SettledCoin {
  symbol: string;
  /** what the trader's balance changed by (negative: paid) */
  amount: number;
  /** USD per unit, and where it came from: a dollar (SETTLE_STABLES), the transaction's own swap, or the minute's Osmosis quote */
  usdEach: number;
  rate: 'stable' | 'tx' | 'quote';
}

export interface Settle {
  /** USD per NAM the trader gave (a sale: what they got for it, less the transaction fee) or got (a buy: what they paid, plus the fee) */
  usdPerNam: number;
  /** the NAM the trader gave or got, fees in: more than the pools' NAM on a sale that paid its taker fee in NAM */
  nam: number;
  coins: SettledCoin[];
  /** the transaction fee in USD, or null when the trader did not pay it */
  gasUsd: number | null;
  /** the trader paid a fee in a coin with no price at that minute, so it is not in usdPerNam */
  gasLeftOut: boolean;
}

/** The coins of a settle record that need the minute's quote (no USDC, no rate in the transaction). */
export function quotesNeeded(s: SettleMeta): string[] {
  const all = [...Object.keys(s.coins), ...Object.keys(s.gas ?? {})];
  return [...new Set(all.filter((c) => !SETTLE_STABLES.includes(c) && !(s.rates?.[c] && s.rates[c] > 0)))];
}

/** A plain-object check: meta comes from the database. */
export function settleMetaOf(meta: Record<string, unknown> | null | undefined): SettleMeta | null {
  const s = meta?.settle as SettleMeta | undefined;
  if (!s || typeof s !== 'object' || typeof s.nam !== 'number' || !Number.isFinite(s.nam) || !s.coins || typeof s.coins !== 'object') return null;
  return s;
}

/**
 * The trade's settle price, from its settle record and the quotes at its minute (symbol to USD per unit). null when a
 * coin it got or paid has no price (a coin the asset map does not know, or no quote within the minute), when the NAM
 * did not move the trade's way, or when nothing came back for it.
 */
export function settleOf(side: 'buy' | 'sell', s: SettleMeta, quotes: Record<string, number | null | undefined> = {}): Settle | null {
  if (s.unknown) return null;
  const nam = Math.abs(s.nam);
  if (!(nam > 0) || (side === 'sell' ? s.nam >= 0 : s.nam <= 0)) return null;
  const rateOf = (c: string): Pick<SettledCoin, 'usdEach' | 'rate'> | null => {
    if (SETTLE_STABLES.includes(c)) return { usdEach: 1, rate: 'stable' };
    const tx = s.rates?.[c];
    if (tx != null && tx > 0) return { usdEach: tx, rate: 'tx' };
    const q = quotes[c];
    return q != null && q > 0 ? { usdEach: q, rate: 'quote' } : null;
  };
  const coins: SettledCoin[] = [];
  for (const [symbol, amount] of Object.entries(s.coins)) {
    if (!Number.isFinite(amount) || amount === 0) continue;
    const r = rateOf(symbol);
    if (!r) return null;
    coins.push({ symbol, amount, ...r });
  }
  const value = coins.reduce((a, c) => a + c.amount * c.usdEach, 0);
  // a sale gets something for its NAM, a buy pays something
  if (!coins.length || (side === 'sell' ? value <= 0 : value >= 0)) return null;
  let gasUsd: number | null = null, gasLeftOut = false;
  for (const [symbol, amount] of Object.entries(s.gas ?? {})) {
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const r = rateOf(symbol);
    if (!r) { gasLeftOut = true; continue; }
    gasUsd = (gasUsd ?? 0) + amount * r.usdEach;
  }
  const usd = side === 'sell' ? value - (gasUsd ?? 0) : -value + (gasUsd ?? 0);
  return usd > 0 ? { usdPerNam: usd / nam, nam, coins, gasUsd, gasLeftOut } : null;
}
