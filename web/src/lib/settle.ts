// The words for a trade's settle price (shared/settle.ts), one sentence the Alerts page and the trades tape both use:
// what the trader gave and got, each coin that is not USDC with the rate it was valued at and where that rate came
// from, and the gas.
import type { Flow } from '../../../shared/types';
import { QUOTE_KEYS, quotesNeeded, settleMetaOf, settleOf, type Settle, type SettledCoin } from '../../../shared/settle';
import { fmtCoin, fmtCount, fmtNamRule, fmtUsdRule } from './format';
import { fmtCoinAmount } from '../../../shared/format';

const coinWords = (c: SettledCoin) => `${fmtCoin(Math.abs(c.amount), c.rate === 'stable' ? 2 : 4)} ${c.symbol}`;

const valuedWords = (c: SettledCoin) =>
  c.rate === 'stable'
    ? c.symbol === 'USDC' ? '' : ` (Osmosis’s alloyed ${c.symbol.replace(/^all/, '')}, counted at a dollar)`
    : ` (${fmtUsdRule(Math.abs(c.amount) * c.usdEach)} at ${fmtUsdRule(c.usdEach)} per ${c.symbol}, ${c.rate === 'tx' ? `this transaction’s own ${c.symbol}/USDC rate` : `the Osmosis ${c.symbol} quote for that minute`})`;

const listWords = (cs: SettledCoin[]) => cs.map((c) => coinWords(c) + valuedWords(c)).join(' and ');

/**
 * "gave 20,000 NAM, fees in, for 295.2836 OSMO ($14.10 at $0.047752 per OSMO, this transaction's own OSMO/USDC
 * rate), less $0.003441 of gas": lower case, no full stop, for the caller to place.
 */
export function settleWords(s: Settle): string {
  const got = s.coins.filter((c) => c.amount > 0), paid = s.coins.filter((c) => c.amount < 0);
  const nam = `${fmtNamRule(s.nam)} NAM`;
  const trade = s.side === 'sell'
    ? `gave ${nam}, fees in, for ${listWords(got)}${paid.length ? `, and paid ${listWords(paid)}` : ''}`
    : `paid ${listWords(paid)}, fees in, for ${nam}${got.length ? `, and got ${listWords(got)}` : ''}`;
  const gas = s.gasUsd != null ? `, ${s.side === 'sell' ? 'less' : 'plus'} ${fmtUsdRule(s.gasUsd)} of gas` : '';
  return trade + gas;
}

/** The sentence a settle price owes when its gas could not be counted; empty otherwise. */
export const settleGasNote = (s: Settle): string => (s.gasLeftOut ? 'Its gas is left out: its coin has no price for that minute.' : '');

/**
 * A move's settle price: the Worker's (Flow.settle, priced at its minute), else, for a trade from the live stream, from
 * its own coins when none needs a stored quote (as the trades tape prices its live rows); null otherwise.
 */
export function flowSettle(f: Flow): Settle | null {
  if (f.settle) return f.settle;
  if (f.kind !== 'buy' && f.kind !== 'sell') return null;
  const rec = settleMetaOf(f.meta ?? null);
  return rec && !quotesNeeded(rec).some((c) => QUOTE_KEYS[c]) ? settleOf(f.kind, rec) : null;
}

/** One side of an address's trades: how many, the NAM and dollars of those with a settle price, how many have none, and of the priced ones how many had their gas left out or a coin valued at the minute's quote. */
export interface TradeSide { n: number; priced: number; nam: number; usd: number; gasLeftOut: number; quoted: number }

/**
 * An address's sales and buys over the moves given, at their settle prices (flowSettle: what it got for its NAM less
 * gas, or paid plus gas), so the total is what the trades realised, not their NAM at the price of the minute. A trade
 * counts for the address that made it (a sale's sender, a buy's receiver); one without a settle price is counted in
 * `n` and left out of the sums, and the words say how many, as they say how many priced trades had no price for their
 * gas or valued a coin at the minute's Osmosis quote rather than its own transaction's rate.
 */
export function tradesOf(flows: readonly Flow[], address: string): { sold: TradeSide; bought: TradeSide } {
  const side = (): TradeSide => ({ n: 0, priced: 0, nam: 0, usd: 0, gasLeftOut: 0, quoted: 0 });
  const out = { sold: side(), bought: side() };
  for (const f of flows) {
    const s = f.kind === 'sell' && f.from === address ? out.sold : f.kind === 'buy' && f.to === address ? out.bought : null;
    if (!s) continue;
    s.n++;
    const p = flowSettle(f);
    if (!p || !(p.usdPerNam > 0)) continue;
    s.priced++;
    s.nam += p.nam;
    s.usd += p.usdPerNam * p.nam;
    if (p.gasLeftOut) s.gasLeftOut++;
    if (p.coins.some((c) => c.rate === 'quote')) s.quoted++;
  }
  return out;
}

/** A sum of dollars over trades, to the cent: "$851.55", "$0.80", "under $0.01". */
const usdTotal = (v: number): string => (v > 0 && v < 0.005 ? 'under $0.01' : `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

/** "Sold 1,972,745 NAM in 76 sales for $851.55 as settled, fees and gas in": one sentence a side, with the trades left out and the ones valued another way named. */
export function tradesWords(t: { sold: TradeSide; bought: TradeSide }, over: string): string | null {
  const one = (s: TradeSide, verb: 'Sold' | 'Bought', noun: [string, string]) => {
    if (!s.n) return '';
    const name = (n: number) => (n === 1 ? `1 ${noun[0]}` : `${fmtCount(n)} ${noun[1]}`);
    const left = s.n - s.priced;
    const sum = s.priced ? `${verb} ${fmtNamRule(s.nam)} NAM in ${name(s.priced)} ${verb === 'Sold' ? 'for' : 'paying'} ${usdTotal(s.usd)} as settled, fees and gas in` : `${verb === 'Sold' ? 'No sale' : 'No buy'} has a settle price`;
    const notes = [
      s.quoted ? `${name(s.quoted)} valued a coin at the minute’s Osmosis quote` : '',
      s.gasLeftOut ? `${name(s.gasLeftOut)} paid gas in a coin with no price, left out of the sum` : '',
      left ? `${name(left)} without a settle price ${left === 1 ? 'is' : 'are'} left out` : '',
    ].filter(Boolean);
    return `${sum}${notes.length ? `; ${notes.join('; ')}` : ''}.`;
  };
  const words = [one(t.sold, 'Sold', ['sale', 'sales']), one(t.bought, 'Bought', ['buy', 'buys'])].filter(Boolean);
  return words.length ? `${words.join(' ')} Counted over ${over}.` : null;
}

/** The coins a move carried beside its NAM (meta.alsoCoins, by symbol; meta.alsoCoinsUnknown, by denom in base units), in words: "60.52 USDC", "0.0450 USDC". */
export function alsoCoinsWords(f: Pick<Flow, 'meta'>): string | null {
  const m = f.meta ?? null;
  const known = m && typeof m.alsoCoins === 'object' && m.alsoCoins ? (m.alsoCoins as Record<string, unknown>) : {};
  const unknown = m && typeof m.alsoCoinsUnknown === 'object' && m.alsoCoinsUnknown ? (m.alsoCoinsUnknown as Record<string, unknown>) : {};
  const parts = [
    ...Object.entries(known).filter(([, v]) => typeof v === 'number' && Number.isFinite(v) && v > 0).map(([sym, v]) => `${fmtCoinAmount(v as number)} ${sym}`),
    ...Object.entries(unknown).filter(([, v]) => typeof v === 'string' && /^\d+$/.test(v as string)).map(([denom, v]) => `${(v as string).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} base units of ${denom.length > 24 ? `${denom.slice(0, 20)}…` : denom}`),
  ];
  return parts.length ? parts.join(' and ') : null;
}

/** A transfer that paid a concentrated position's rewards (meta.reward), in words: "Spread rewards of position 15533215 in pool 3005". */
export function rewardWords(f: Pick<Flow, 'meta'>): string | null {
  const m = f.meta ?? null;
  if (!m || (m.reward !== 'spread' && m.reward !== 'incentive')) return null;
  const what = m.reward === 'spread' ? 'Spread rewards' : 'Incentives';
  const pos = typeof m.rewardPosition === 'string' ? ` of position ${m.rewardPosition}` : '';
  const pool = typeof m.rewardPool === 'string' ? ` in pool ${m.rewardPool}` : '';
  return `${what}${pos}${pool}`;
}
