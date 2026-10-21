// A trade alert's price is what the trade settled at for its trader, everything taken into account (user report,
// 2026-10-21: the Alerts page showed the minute's quote, $0.000847, for a sale that got $0.000705 a NAM). Transaction
// 0C99E2C3… (test/fixtures/osmo_split_route_osmo.json) sold 20,000 NAM in one split-route message: 14,000 through
// pool 3005 to USDC and on through pool 1464 to OSMO, 6,000 through pool 3368 to OSMO. The trader got 295.283615
// OSMO, paid 0.072058 OSMO of gas, and their USDC came back to where it started; 19,796.328 NAM reached the pools,
// the rest went in taker fees and spread.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normFromTxSearch, osmoAssets, parseOsmosisTx, type OsmoCtx } from '../worker/src/parse/osmosis';
import { settleOf, quotesNeeded, type SettleMeta } from '../shared/settle';
import { alertsBetween } from '../worker/src/analytics';
import { DEFAULT_THRESHOLDS } from '../shared/alerts';
import { testD1, insert } from './d1-sqlite';

const raw = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'osmo_split_route_osmo.json'), 'utf8'));
const ctx: OsmoCtx = {
  poolAddrs: new Map(),
  priceUsd: 0.000847,
  assets: osmoAssets(),
};
const T = 1_792_609_409_646;
const ownRate = 9.950747 / 208.383389; // the trader's own USDC → OSMO hop through pool 1464
const swapOf = (tx: any) => parseOsmosisTx(normFromTxSearch(tx, T), ctx).flows.find((f) => f.id.endsWith(':swap'))!;

describe('a trade\'s settle record (meta.settle)', () => {
  it('holds every coin the trader\'s balance changed by in the swap, the gas they paid, and the rate the transaction converted OSMO at', () => {
    const f = swapOf(raw);
    expect(f.kind).toBe('sell');
    expect(f.amount).toBeCloseTo(19796.328, 6);
    const s = f.meta.settle as SettleMeta;
    expect(s.nam).toBeCloseTo(-20000, 9);
    expect(Object.keys(s.coins)).toEqual(['OSMO']); // the USDC between the two hops nets to 0
    expect(s.coins.OSMO).toBeCloseTo(295.283615, 9);
    expect(s.gas).toEqual({ OSMO: 0.072058 });
    // the trader's own hop, not ProtoRev's later one through the same pool (3.541751 / 74.055378)
    expect(s.rates?.OSMO).toBeCloseTo(ownRate, 12);
  });
  it('settles at the OSMO it got, at that rate, less its gas, per NAM it gave', () => {
    const s = settleOf('sell', swapOf(raw).meta.settle as SettleMeta)!;
    expect(s.nam).toBeCloseTo(20000, 9);
    expect(s.usdPerNam).toBeCloseTo(((295.283615 - 0.072058) * ownRate) / 20000, 12);
    expect(s.usdPerNam).toBeCloseTo(0.000705, 6);
    expect(s.gasUsd).toBeCloseTo(0.072058 * ownRate, 12);
    expect(s.coins).toEqual([{ symbol: 'OSMO', amount: s.coins[0].amount, usdEach: ownRate, rate: 'tx' }]);
  });
  it('a pool not trusted for the OSMO price sets no rate: the coin then needs the minute\'s quote', () => {
    const moved = JSON.parse(JSON.stringify(raw));
    for (const e of moved.tx_result.events) for (const a of e.attributes) if (a.key === 'pool_id' && a.value === '1464') a.value = '9999';
    const s = swapOf(moved).meta.settle as SettleMeta;
    expect(s.rates).toBeUndefined();
    expect(quotesNeeded(s)).toEqual(['OSMO']);
    expect(settleOf('sell', s)).toBeNull();
    expect(settleOf('sell', s, { OSMO: 0.05 })!.coins[0]).toMatchObject({ usdEach: 0.05, rate: 'quote' });
  });
  it('a transaction without msg_index gets no settle record (its fee and post-handler transfers look like the swap\'s)', () => {
    const old = JSON.parse(JSON.stringify(raw));
    for (const e of old.tx_result.events) e.attributes = e.attributes.filter((a: any) => a.key !== 'msg_index');
    expect(swapOf(old).meta.settle).toBeUndefined();
  });
});

describe('a buy paid in allUSDC', () => {
  // 4E8F93F0… (test/fixtures/osmo_buy_allusdc.json): 7.2 allUSDC to Noble USDC 1:1 (pool 3497) and on to NAM through
  // pool 3005, 4.788005 allUSDC to OSMO (pool 3499) and on to NAM through pool 3368; 12 allUSDC left the trader, the
  // other 0.011995 in taker fees; gas 0.004426 allUSDC.
  const raw2 = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'osmo_buy_allusdc.json'), 'utf8'));
  it('settles at the allUSDC it paid, counted at a dollar, plus its gas, per NAM it got', () => {
    const f = swapOf(raw2);
    expect(f.kind).toBe('buy');
    const s = f.meta.settle as SettleMeta;
    expect(s.coins).toEqual({ allUSDC: -12 });
    expect(s.gas).toEqual({ allUSDC: 0.004426 });
    expect(s.unknown).toBeUndefined();
    const p = settleOf('buy', s)!;
    expect(p.coins[0].rate).toBe('stable');
    expect(p.usdPerNam).toBeCloseTo((12 + 0.004426) / s.nam, 12);
    expect(s.nam).toBeCloseTo(f.amount, 6);
  });
});

describe('settleOf', () => {
  const buy: SettleMeta = { nam: 1000, coins: { USDC: -0.75 }, gas: { OSMO: 0.05 } };
  it('a buy settles at what it paid plus its gas, per NAM it got', () => {
    expect(settleOf('buy', buy, { OSMO: 0.04 })!.usdPerNam).toBeCloseTo((0.75 + 0.002) / 1000, 12);
  });
  it('gas in a coin with no price is left out and said so; a coin with no price leaves no settle price at all', () => {
    const s = settleOf('buy', buy)!;
    expect(s.usdPerNam).toBeCloseTo(0.75 / 1000, 12);
    expect(s.gasLeftOut).toBe(true);
    expect(settleOf('buy', { nam: 1000, coins: { OSMO: -20 } })).toBeNull();
  });
  it('a coin the asset map does not know, NAM that moved the other way, or nothing back is no settle price', () => {
    expect(settleOf('buy', { ...buy, unknown: true }, { OSMO: 1 })).toBeNull();
    expect(settleOf('sell', buy, { OSMO: 1 })).toBeNull();
    expect(settleOf('sell', { nam: -1000, coins: { USDC: -1 } })).toBeNull();
  });
});

describe('the alert shows the settle price', () => {
  it('ahead of the trade\'s own USDC and of the NAM quote, valuing OSMO at the quote stored for the minute when the transaction has no rate', async () => {
    const db = testD1();
    insert(db, 'metrics', [
      { ts: T - 60_000, key: 'price.usd', value: 0.000847 },
      { ts: T - 30_000, key: 'price.osmo_usd', value: 0.048 },
      { ts: T + 60_000, key: 'price.osmo_usd', value: 9 },
    ]);
    const settle: SettleMeta = { nam: -20000, coins: { OSMO: 295.283615 }, gas: { OSMO: 0.072058 } };
    const row = (id: string, meta: object, counter: [string | null, number | null]) => ({
      id, chain: 'osmosis', height: 1, ts: T, tx_hash: id, kind: 'sell', from_addr: 'osmo1seller', to_addr: null, amount_num: 19796.328,
      counter_denom: counter[0], counter_amount: counter[1], pool_id: '3005,1464,3368', price_usd: null, value_usd: null, meta: JSON.stringify(meta),
    });
    insert(db, 'flows', [
      row('osmosis:A:swap', { settle }, ['OSMO', 295.283615]),
      row('osmosis:B:swap', { settle: { nam: -20000, coins: { USDC: 14.2 } } }, ['USDC', 14.2]),
      row('osmosis:C:swap', {}, [null, null]),
    ]);
    const hits = await alertsBetween(db as any, T - 3_600_000, T + 1, DEFAULT_THRESHOLDS);
    const p = Object.fromEntries(hits.map((h) => [h.flowId, h.price]));
    expect(p['osmosis:A:swap']).toMatchObject({ source: 'settled', at: T });
    expect(p['osmosis:A:swap']!.usd).toBeCloseTo(((295.283615 - 0.072058) * 0.048) / 20000, 12);
    expect(p['osmosis:A:swap']!.settle!.coins[0].rate).toBe('quote');
    // per NAM the trader gave (20,000), not the 19,796.328 that reached the pools
    expect(p['osmosis:B:swap']).toMatchObject({ usd: 14.2 / 20000, source: 'settled' });
    expect(p['osmosis:C:swap']).toEqual({ usd: 0.000847, source: 'quote', at: T - 60_000 });
  });
});
