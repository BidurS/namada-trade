// The words for a trade's settle price (shared/settle.ts), one sentence the Alerts page and the trades tape both use:
// what the trader gave and got, each coin that is not USDC with the rate it was valued at and where that rate came
// from, and the gas.
import type { Settle, SettledCoin } from '../../../shared/settle';
import { fmtCoin, fmtNamRule, fmtUsdRule } from './format';

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
