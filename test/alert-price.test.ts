// A trade alert's price is what that trade settled at (user report, 2026-10-21: the newest Alerts rows had no price,
// and older ones showed whatever price the row was written with). Its own USDC per NAM when its coins say so; else
// the Osmosis quote stored for its minute, labelled a quote; else none.
import { describe, it, expect } from 'vitest';
import { evaluateFlow, paidPerNam, SUMMED_LEGS_FROM } from '../shared/alerts';
import { alertsBetween, withQuotes, QUOTE_MATCH_MS } from '../worker/src/analytics';
import { DEFAULT_THRESHOLDS } from '../shared/alerts';
import { testD1, insert } from './d1-sqlite';
import type { Flow } from '../shared/types';

const T = SUMMED_LEGS_FROM + 3_600_000;
const sell = (o: Partial<Flow> = {}): Flow => ({
  id: 'osmosis:H:swap', chain: 'osmosis', height: 1, ts: T, txHash: 'H', kind: 'sell', from: 'osmo1seller', to: null, amount: 20000,
  counterDenom: 'USDC', counterAmount: 5, poolId: '3005,3368', priceUsd: 0.0009, valueUsd: 18, meta: {}, ...o,
} as Flow);

describe('the price a trade alert shows', () => {
  it('is the USDC the trade paid per NAM, from its own coins, never the price the row was stored with', () => {
    const [h] = evaluateFlow(sell());
    expect(h.title).toBe('Sold 20,000 NAM');
    expect(h.price).toEqual({ usd: 5 / 20000, source: 'paid', at: T });
  });
  it('a trade paid in another coin, or several, has no settle price of its own', () => {
    expect(evaluateFlow(sell({ counterDenom: 'OSMO', counterAmount: 30 }))[0].price).toBeNull();
    expect(evaluateFlow(sell({ counterDenom: null, counterAmount: null, priceUsd: null }))[0].price).toBeNull();
  });
  it('an older row counts only through pool 3005 alone (its coin then is the whole trade\'s, and real USDC)', () => {
    const old = SUMMED_LEGS_FROM - 60_000;
    expect(paidPerNam(sell({ ts: old, poolId: '3005,3368' }))).toBeNull();
    expect(paidPerNam(sell({ ts: old, poolId: '3005' }))).toBe(5 / 20000);
  });
  it('without its own price, the alert reads the quote stored for its minute, and says it is a quote', async () => {
    const db = testD1();
    insert(db, 'metrics', [
      { ts: T - 10 * 60_000, key: 'price.usd', value: 0.0011 },
      { ts: T - 2 * 60_000, key: 'price.usd', value: 0.00034 },
      { ts: T + 60_000, key: 'price.usd', value: 0.5 },
    ]);
    const row = (f: Flow) => ({ id: f.id, chain: f.chain, height: 1, ts: f.ts, tx_hash: f.txHash, kind: f.kind, from_addr: f.from, to_addr: f.to, amount_num: f.amount, counter_denom: f.counterDenom, counter_amount: f.counterAmount, pool_id: f.poolId, price_usd: f.priceUsd, value_usd: f.valueUsd, meta: '{}' });
    insert(db, 'flows', [row(sell({ counterDenom: null, counterAmount: null, priceUsd: null })), row(sell({ id: 'osmosis:P:swap', txHash: 'P', ts: T - 30_000 }))]);
    const hits = await alertsBetween(db as any, T - 3_600_000, T + 1, DEFAULT_THRESHOLDS);
    const byId = Object.fromEntries(hits.map((h) => [h.flowId, h.price]));
    expect(byId['osmosis:H:swap']).toEqual({ usd: 0.00034, source: 'quote', at: T - 2 * 60_000 });
    expect(byId['osmosis:P:swap']).toEqual({ usd: 5 / 20000, source: 'paid', at: T - 30_000 });
  });
  it('a quote older than its window is not the price of the trade\'s minute', async () => {
    const db = testD1();
    insert(db, 'metrics', [{ ts: T - QUOTE_MATCH_MS - 1, key: 'price.usd', value: 0.0011 }]);
    const [h] = await withQuotes(db as any, evaluateFlow(sell({ counterDenom: null, counterAmount: null })));
    expect(h.price).toBeNull();
  });
});
