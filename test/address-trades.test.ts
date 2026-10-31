// An address's trades at what they realised (web/src/lib/settle.ts tradesOf, tradesWords; the address sheet's
// caption above its moves). The wallet traced on 2026-10-29 sold 1,855,245 NAM for 754.45 allUSDC, while its rows'
// values, NAM at the price of each minute, came to 1,332 USD; the sheet showed neither total. A trade counts for the
// address that made it, at its settle price, and one without a settle price is counted and named, never priced at the
// minute's quote in its place.
import { describe, it, expect } from 'vitest';
import { tradesOf, tradesWords } from '../web/src/lib/settle';
import type { Flow } from '../shared/types';
import type { Settle } from '../shared/settle';

const ME = 'osmo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
const OTHER = 'osmo1zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';
const settle = (side: 'buy' | 'sell', nam: number, usd: number): Settle => ({ side, usdPerNam: usd / nam, nam, coins: [{ symbol: 'allUSDC', amount: side === 'sell' ? usd : -usd, usdEach: 1, rate: 'stable' }], gasUsd: 0.0075, gasLeftOut: false });
let n = 0;
const flow = (kind: Flow['kind'], from: string | null, to: string | null, amount: number, s?: Settle, valueUsd = amount * 0.0007): Flow =>
  ({ id: `osmosis:T${n++}:swap`, chain: 'osmosis', height: 1, ts: 1, txHash: `T${n}`, kind, from, to, amount, priceUsd: 0.0007, valueUsd, ...(s ? { settle: s } : {}) }) as Flow;

describe('an address’s trades at what they realised', () => {
  it('sums the address’s own sales and buys at their settle prices, not their values at the minute’s price', () => {
    const rows = [
      flow('sell', ME, null, 800000, settle('sell', 799995, 113.6)),
      flow('sell', ME, null, 20000, settle('sell', 20000, 15.06)),
      flow('buy', null, ME, 1000, settle('buy', 1000, 0.8)),
      flow('sell', OTHER, null, 5000, settle('sell', 5000, 3)),
      flow('transfer', ME, OTHER, 100),
    ];
    const t = tradesOf(rows, ME);
    expect(t.sold).toEqual({ n: 2, priced: 2, nam: 819995, usd: expect.closeTo(128.66, 6), gasLeftOut: 0, quoted: 0 });
    expect(t.bought).toEqual({ n: 1, priced: 1, nam: 1000, usd: expect.closeTo(0.8, 6), gasLeftOut: 0, quoted: 0 });
    // the rows' own values (NAM at the minute's price) would have said 574 USD for the two sales
    expect(rows.slice(0, 2).reduce((s, f) => s + (f.valueUsd ?? 0), 0)).toBeCloseTo(574, 6);
    expect(tradesWords(t, 'the 5 moves listed below')).toBe('Sold 819,995 NAM in 2 sales for $128.66 as settled, fees and gas in. Bought 1,000 NAM in 1 buy paying $0.80 as settled, fees and gas in. Counted over the 5 moves listed below.');
  });

  it('a trade without a settle price is counted and named, never priced at the minute’s quote', () => {
    const t = tradesOf([flow('sell', ME, null, 20000, settle('sell', 20000, 15.06)), flow('sell', ME, null, 2000), flow('sell', ME, null, 2000)], ME);
    expect(t.sold).toMatchObject({ n: 3, priced: 1, nam: 20000 });
    expect(tradesWords(t, 'the newest 3 moves listed below')).toBe('Sold 20,000 NAM in 1 sale for $15.06 as settled, fees and gas in; 2 sales without a settle price are left out. Counted over the newest 3 moves listed below.');
    expect(tradesWords(tradesOf([flow('buy', null, ME, 10)], ME), 'the 1 move listed below')).toBe('No buy has a settle price; 1 buy without a settle price is left out. Counted over the 1 move listed below.');
  });

  it('a priced trade whose gas had no price, or that valued a coin at the minute’s quote, is named (review of 2026-10-30)', () => {
    const noGas: Settle = { ...settle('sell', 20000, 15.06), gasUsd: null, gasLeftOut: true };
    const quoted: Settle = { side: 'sell', usdPerNam: 0.0007, nam: 10000, coins: [{ symbol: 'OSMO', amount: 50, usdEach: 0.14, rate: 'quote' }], gasUsd: 0.007, gasLeftOut: false };
    const t = tradesOf([flow('sell', ME, null, 20000, noGas), flow('sell', ME, null, 10000, quoted)], ME);
    expect(t.sold).toMatchObject({ n: 2, priced: 2, gasLeftOut: 1, quoted: 1 });
    expect(tradesWords(t, 'the 2 moves listed below')).toBe('Sold 30,000 NAM in 2 sales for $22.06 as settled, fees and gas in; 1 sale valued a coin at the minute’s Osmosis quote; 1 sale paid gas in a coin with no price, left out of the sum. Counted over the 2 moves listed below.');
    // a total under a cent says so, never $0.00
    expect(tradesWords(tradesOf([flow('buy', null, ME, 1, settle('buy', 1, 0.001))], ME), 'the 1 move listed below')).toBe('Bought 1.00 NAM in 1 buy paying under $0.01 as settled, fees and gas in. Counted over the 1 move listed below.');
  });

  it('an address with no trades has no sentence', () => {
    expect(tradesWords(tradesOf([flow('transfer', ME, OTHER, 1)], ME), 'the 1 move listed below')).toBe(null);
  });
});
