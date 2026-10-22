// The trades tape shows each trade's settle price (owner, 2026-10-21: "for each trade we want the exact settle price
// of that trade, everything taken into account"): the server prices each row's settle record at its minute, the
// page prices the live stream's rows from their own coins, both sum a run's dollars the same way (shared/settle.ts
// tradeValue), and the row's details say what was given and got at what rates.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { app } from '../worker/src/api';
import * as S from '../worker/src/series-api';
import { settlePrices } from '../worker/src/analytics';
import { testD1, type TestD1 } from './d1-sqlite';
import { settleOf, settleUsd, tradeValue, type Settle, type SettleMeta } from '../shared/settle';
import { foldTrades as foldOnPage, tradeOfFlow } from '../web/src/screens/trade/series';
import { settleGasNote, settleWords } from '../web/src/lib/settle';
import type { Flow, TradeRow, TradesResponse } from '../shared/types';

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 21, 22, 30);
const osmo = (i: number) => `osmo1${String(i).padStart(38, '0')}`;
const RATE = 9.950747 / 208.383389; // 0C99E2C3…'s own USDC → OSMO hop through pool 1464

afterEach(() => { vi.useRealTimers(); });
const at = (t: number) => vi.useFakeTimers({ now: t, toFake: ['Date'] });

async function trades(db: TestD1, q = ''): Promise<TradesResponse> {
  const res = await app.request(`/api/series/trades?limit=50${q}`, {}, { DB: db } as any);
  expect(res.status).toBe(200);
  return (await res.json()) as TradesResponse;
}

interface T { id: string; ts: number; kind: 'buy' | 'sell'; maker: string; nam: number; usd: number | null; settle?: SettleMeta; route?: string }
function insert(db: TestD1, ts: T[], quotes: [number, string, number][] = []) {
  db.raw.exec('BEGIN');
  const st = db.raw.prepare(`INSERT INTO flows (id, chain, height, ts, tx_hash, kind, from_addr, to_addr, amount_num, counter_denom, counter_amount, pool_id, price_usd, value_usd, meta)
    VALUES (?, 'osmosis', ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)`);
  ts.forEach((t, i) => st.run(t.id, 1000 + i, t.ts, t.id.split(':')[1], t.kind, t.kind === 'buy' ? null : t.maker, t.kind === 'buy' ? t.maker : null, t.nam,
    t.route ?? '3005', t.usd != null ? t.usd / t.nam : null, t.usd, JSON.stringify({ trader: t.maker, ...(t.settle ? { settle: t.settle } : {}) })));
  const q = db.raw.prepare('INSERT INTO metrics (ts, key, value) VALUES (?, ?, ?)');
  for (const [ts, key, value] of quotes) q.run(ts, key, value);
  db.raw.exec('COMMIT');
}

const sale: SettleMeta = { nam: -20000, coins: { OSMO: 295.283615 }, gas: { OSMO: 0.072058 }, rates: { OSMO: RATE } };
const saleUsdPerNam = ((295.283615 - 0.072058) * RATE) / 20000;

describe('GET /api/series/trades: each row\'s settle price', () => {
  it('prices the settle record at the trade\'s minute, keeps the row\'s recorded price beside it, and leaves a row it cannot price as it was', async () => {
    at(NOW);
    const db = testD1();
    const t0 = NOW - 60 * MIN;
    insert(db, [
      // sold through 3005 → 1464 and 3368 for OSMO, the OSMO valued at the transaction's own rate (0C99E2C3…)
      { id: 'osmosis:A1:swap', ts: t0, kind: 'sell', maker: osmo(1), nam: 19796.328, usd: 16.77, settle: sale, route: '3005,1464,3368' },
      // paid OSMO with no OSMO/USDC swap in its transaction: the OSMO quote stored for its minute
      { id: 'osmosis:B1:swap', ts: t0 - 10 * MIN, kind: 'buy', maker: osmo(2), nam: 25000, usd: 21, settle: { nam: 25000, coins: { OSMO: -400 } } },
      // the same, but the newest OSMO quote is more than five minutes older than the trade
      { id: 'osmosis:B2:swap', ts: t0 - 40 * MIN, kind: 'buy', maker: osmo(3), nam: 25000, usd: 21, settle: { nam: 25000, coins: { OSMO: -400 } } },
      // paid in a coin the asset map does not know
      { id: 'osmosis:U1:swap', ts: t0 - 50 * MIN, kind: 'buy', maker: osmo(4), nam: 25000, usd: 21, settle: { nam: 25000, coins: {}, unknown: true } },
      // no settle record (recorded before the parser kept one)
      { id: 'osmosis:N1:swap', ts: t0 - 55 * MIN, kind: 'sell', maker: osmo(5), nam: 25000, usd: 20 },
    ], [
      [t0 - 10 * MIN - 30_000, 'price.osmo_usd', 0.05],
      [t0 - 10 * MIN + MIN, 'price.osmo_usd', 9], // after the trade: never its price
      [t0 - 40 * MIN - 5 * MIN - 1, 'price.osmo_usd', 0.07], // too old for B2
    ]);
    const body = await trades(db);
    const row = Object.fromEntries(body.rows.map((r) => [r.id, r]));
    expect(row['osmosis:A1:swap'].settle).toMatchObject({ side: 'sell', nam: 20000, gasLeftOut: false });
    expect(row['osmosis:A1:swap'].settle!.usdPerNam).toBeCloseTo(saleUsdPerNam, 12);
    expect(row['osmosis:A1:swap'].settle!.coins).toEqual([{ symbol: 'OSMO', amount: 295.283615, usdEach: RATE, rate: 'tx' }]);
    // the row's own recorded price and value are still sent as they were stored
    expect(row['osmosis:A1:swap'].valueUsd).toBe(16.77);
    expect(row['osmosis:B1:swap'].settle).toMatchObject({ side: 'buy', usdPerNam: (400 * 0.05) / 25000 });
    expect(row['osmosis:B1:swap'].settle!.coins[0]).toMatchObject({ usdEach: 0.05, rate: 'quote' });
    expect(row['osmosis:B2:swap'].settle).toBeUndefined();
    expect(row['osmosis:U1:swap'].settle).toBeUndefined();
    expect(row['osmosis:N1:swap'].settle).toBeUndefined();
    // a run of one: its dollars are the settle price's, its average the settle price
    const g = body.groups.find((x) => x.ids[0] === 'osmosis:A1:swap')!;
    expect(g.usd).toBeCloseTo(saleUsdPerNam * 20000, 9);
    expect(g.avgPriceUsd).toBeCloseTo(saleUsdPerNam, 12);
    expect(body.groups.find((x) => x.ids[0] === 'osmosis:B2:swap')!.usd).toBe(21);
  });

  it('a folded run sums each row\'s settle dollars, else its recorded value, over the NAM each is per', async () => {
    at(NOW);
    const db = testD1();
    const t0 = NOW - 30 * MIN;
    insert(db, [
      { id: 'osmosis:F1:swap', ts: t0, kind: 'buy', maker: osmo(7), nam: 1000, usd: 0.9, settle: { nam: 1000, coins: { USDC: -0.8 }, gas: { USDC: 0.01 } } },
      { id: 'osmosis:F2:swap', ts: t0 - MIN, kind: 'buy', maker: osmo(7), nam: 1200, usd: 1.1 },
    ]);
    const body = await trades(db);
    expect(body.groups).toHaveLength(1);
    const [g] = body.groups;
    expect(g.n).toBe(2);
    expect(g.usd).toBeCloseTo(0.81 + 1.1, 12);
    expect(g.avgPriceUsd).toBeCloseTo((0.81 + 1.1) / 2200, 12);
  });
});

describe('settlePrices when a quote cannot be read', () => {
  it('a trade that needed a quote has no settle price (never one that leaves its gas out as if the coin had no price); one that needed none is priced', async () => {
    const db = { batch: async () => { throw new Error('D1 is busy'); }, prepare: () => ({ bind: () => ({}) }) };
    const [gas, coin, own] = await settlePrices(db as any, [
      { kind: 'buy', ts: NOW, meta: { settle: { nam: 1000, coins: { USDC: -0.8 }, gas: { OSMO: 0.05 } } } },
      { kind: 'buy', ts: NOW, meta: { settle: { nam: 1000, coins: { OSMO: -20 } } } },
      { kind: 'buy', ts: NOW, meta: { settle: { nam: 1000, coins: { USDC: -0.8 }, gas: { USDC: 0.01 } } } },
    ]);
    expect(gas).toBeNull();
    expect(coin).toBeNull();
    expect(own).toMatchObject({ usdPerNam: 0.81 / 1000, gasLeftOut: false });
  });
});

describe('the page\'s rows and runs', () => {
  const flow = (o: Partial<Flow>): Flow => ({
    id: 'osmosis:L1:swap', chain: 'osmosis', height: 1, ts: NOW, txHash: 'L1', kind: 'buy', from: null, to: osmo(8), amount: 1000,
    counterDenom: 'USDC', counterAmount: 0.8, poolId: '3005', priceUsd: 0.0008, valueUsd: 0.8, meta: { trader: osmo(8) }, ...o,
  } as Flow);
  it('a live trade is priced by its own coins; one that needs a coin\'s quote waits for the server\'s page', () => {
    const own = tradeOfFlow(flow({ meta: { trader: osmo(8), settle: { nam: 1000, coins: { allUSDC: -0.82 }, gas: { allUSDC: 0.004 } } } }))!;
    expect(own.settle).toMatchObject({ side: 'buy', usdPerNam: 0.824 / 1000 });
    const needsQuote = tradeOfFlow(flow({ meta: { trader: osmo(8), settle: { nam: 1000, coins: { OSMO: -20 } } } }))!;
    expect(needsQuote.settle).toBeUndefined();
    expect(needsQuote.priceUsd).toBe(0.0008);
    // review, 2026-10-21: paid in USDC with its gas in OSMO and no OSMO rate in the transaction (the usual fee coin) was
    // priced here without its gas, saying OSMO had no price for that minute; it waits for the server's quote instead
    const gasQuote = tradeOfFlow(flow({ meta: { trader: osmo(8), settle: { nam: 1000, coins: { USDC: -0.8 }, gas: { OSMO: 0.05 } } } }))!;
    expect(gasQuote.settle).toBeUndefined();
    const gasRated = tradeOfFlow(flow({ meta: { trader: osmo(8), settle: { nam: 1000, coins: { USDC: -0.8 }, gas: { OSMO: 0.05 }, rates: { OSMO: 0.04 } } } }))!;
    expect(gasRated.settle).toMatchObject({ usdPerNam: 0.802 / 1000, gasUsd: 0.002, gasLeftOut: false });
  });
  it('the page folds and sums a run exactly as the server does', () => {
    const settle = settleOf('buy', { nam: 1010, coins: { USDC: -0.8 } })!;
    const r = (id: string, ts: number, nam: number, valueUsd: number | null, s?: Settle): TradeRow => ({
      id, ts, height: 1, tsSource: null, kind: 'buy', nam, counterSymbol: null, counterAmount: null, priceUsd: valueUsd != null ? valueUsd / nam : null,
      priceSource: 'execution', valueUsd, maker: osmo(9), makerLabelPlain: null, makerTrades: null, route: ['3005'], txHash: id, pattern: null, ...(s ? { settle: s } : {}),
    });
    const rows = [r('a', NOW, 1000, 0.9, settle), r('b', NOW - MIN, 500, 0.4), r('c', NOW - 2 * MIN, 700, null)];
    const server = S.foldTrades(rows);
    const page = foldOnPage(rows, { foldMs: 10 * MIN, underNam: 2000 });
    expect(server).toHaveLength(1);
    expect(page).toHaveLength(1);
    expect(page[0].usd).toBeCloseTo(server[0].usd!, 12);
    expect(page[0].avgPriceUsd).toBeCloseTo(server[0].avgPriceUsd!, 12);
    expect(server[0].usd).toBeCloseTo(0.8 + 0.4, 12);
    expect(server[0].avgPriceUsd).toBeCloseTo(1.2 / 1510, 12);
    expect(server[0].unpriced).toBe(1);
    expect(tradeValue(rows[0])).toEqual({ usd: settleUsd(settle), nam: 1010 });
  });
});

describe('the words for a settle price', () => {
  it('a sale: what was given, fees in, for what, at which rate, less gas', () => {
    const s = settleOf('sell', sale)!;
    expect(settleWords(s)).toBe('gave 20,000 NAM, fees in, for 295.2836 OSMO ($14.10 at $0.047752 per OSMO, this transaction’s own OSMO/USDC rate), less $0.003441 of gas');
    expect(settleGasNote(s)).toBe('');
  });
  it('a buy in allUSDC; gas in a coin with no price is said to be left out', () => {
    const s = settleOf('buy', { nam: 14287.0385, coins: { allUSDC: -12 }, gas: { OSMO: 0.05 } })!;
    expect(settleWords(s)).toBe('paid 12.00 allUSDC (Osmosis’s alloyed USDC, counted at a dollar), fees in, for 14,287 NAM');
    expect(settleGasNote(s)).toMatch(/gas is left out/);
    const q = settleOf('buy', { nam: 25000, coins: { OSMO: -400 } }, { OSMO: 0.05 })!;
    expect(settleWords(q)).toBe('paid 400.0000 OSMO ($20.00 at $0.050000 per OSMO, the Osmosis OSMO quote for that minute), fees in, for 25,000 NAM');
  });
});
