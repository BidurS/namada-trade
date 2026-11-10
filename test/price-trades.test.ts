// One figure, one value: the Trade tab counts "hours with a trade" in three places and each counts something else.
// Each place says what it counts, in the words of shared/price-trades.ts, and the rule's number in those words is the
// number the Worker applies.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { ANY_TRADE_HOURS_HAD, PRICE_HOURS_HAD, PRICE_TRADE_MIN_NAM, PRICE_TRADE_WORDS } from '../shared/price-trades';
import { singlePoolUsdc } from '../worker/src/series';
import { SINGLE_POOL_USDC_SWAP } from '../worker/src/cron';
import { OSMOSIS } from '../worker/src/config';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe('the trades the executed price counts', () => {
  it('the words name the rule the Worker applies, with its own number', () => {
    expect(PRICE_TRADE_WORDS).toBe(`a NAM / USDC trade of at least ${PRICE_TRADE_MIN_NAM} NAM through one pool`);
    const row = (amount_num: number) => ({ counter_denom: 'USDC', kind: 'sell', amount_num, counter_amount: 1, pool_id: OSMOSIS.pricePoolIds[0] }) as any;
    expect(singlePoolUsdc(row(PRICE_TRADE_MIN_NAM))).toBe(true);
    expect(singlePoolUsdc(row(PRICE_TRADE_MIN_NAM - 0.000001))).toBe(false);
    expect(SINGLE_POOL_USDC_SWAP).toContain(`amount_num >= ${PRICE_TRADE_MIN_NAM} `);
  });

  it('each count of hours on Trade says what it counts, and no two say the same', () => {
    const chart = read('web/src/ui/PriceChart.tsx'), buyers = read('web/src/screens/trade/Buyers.tsx');
    expect(PRICE_HOURS_HAD).toBe(`had ${PRICE_TRADE_WORDS}, the trades this line takes its price from`);
    expect(ANY_TRADE_HOURS_HAD).toBe('had a buy or a sell of any size, bot round trips left out');
    expect(PRICE_HOURS_HAD).not.toBe(ANY_TRADE_HOURS_HAD);
    // the price line: both of its sentences
    expect(chart.split('{PRICE_HOURS_HAD}').length - 1).toBe(2);
    // the average-price panel
    expect(buyers.split('{ANY_TRADE_HOURS_HAD}').length - 1).toBe(1);
    // neither says the bare words the other could be read under
    for (const src of [chart, buyers]) {
      expect(src).not.toContain('had a trade');
      expect(src).not.toContain('hours with trades');
    }
    // the bars' sentence for a screen reader counts bars, not trades
    expect(chart).toContain('hours of the window have a bar.');
  });
});

import { poolCounts } from '../shared/pool-sides';

describe('the pools that hold NAM, counted one way', () => {
  it('counts a pool as holding only when a side was read above zero, and a pool with no reading apart', () => {
    const pools = [
      { namReserve: 10, counterReserve: 5 },
      { namReserve: 0, counterReserve: 3 },
      { namReserve: 7, counterReserve: null },
      { namReserve: 0, counterReserve: 0 },
      { namReserve: null, counterReserve: null },
      { namReserve: null, counterReserve: null },
    ];
    expect(poolCounts(pools)).toEqual({ holding: 3, unread: 2 });
    expect(poolCounts([])).toEqual({ holding: 0, unread: 0 });
  });

  it('the Trade tab states that count beside the total, and says the pools with no reading apart', () => {
    const src = read('web/src/screens/trade/Pools.tsx');
    expect(src).toContain('const { holding, unread } = poolCounts(r.pairs);');
    expect(src).toContain('<Num as="b" v={holding} fmt={fmtCount} />');
    expect(src).not.toContain('v={r.pairs.length}');
    expect(src).toContain('listed by Osmosis and not in the pool list read here, so nothing is counted for');
  });
});

describe('the NAM whose unstaking wait is over, stated once', () => {
  it('the Supply strip shows the chain list\'s figure of every size when it was read, and names the list\'s own figure as that', () => {
    const src = read('web/src/screens/supply/index.tsx');
    expect(src).toContain('const readyFromChain = fromChain && Number.isFinite(term!.withdrawableNowNam);');
    expect(src).toContain('n: readyFromChain ? ulFact(term!.withdrawableNowNam, termReadyStamp) : ulFact(sums?.ready.nam, readyStamp),');
    expect(src).toContain('the list below holds <Num v={sums.ready.nam} prov={readyStamp}');
    // the figure of the large recent requests alone is never printed without saying which requests it counts
    expect(src).toContain('sizeLine(readyFromChain ? "counting requests of every size, from the chain\'s own list" : `counting ${minWords}`)');
  });
});
