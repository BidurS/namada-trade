// Trades paid in OSMO, ATOM, KYVE, TIA or ETH before the cron quoted those coins had no settle price (461 stored trades,
// 963,326 NAM, 2026-08-11 to 2026-10-21, counted on 2026-10-23), although each transaction carried the trader's own hop
// through that coin's USDC pool: OSMOSIS.ratePools trusted only pool 1464, for OSMO, and the router sent the OSMO leg
// through 1221 or 1263. The six pools the router used now set the rate (worker/src/config.ts ratePools): the rate is
// the trader's own hop, whatever the pool's depth, since it is what that trader converted at. One real transaction per
// pool below (test/fixtures/osmo_*_pool*.json, read from osmosis-rpc.publicnode.com on 2026-10-23), the arithmetic
// written from the hop's own numbers. A seventh (osmo_buy_unknown_coin.json) paid a coin the parser does not name: its
// record now keeps that coin's denom so a repair can find the trade without reading the transaction again.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normFromTxSearch, osmoAssets, parseOsmosisTx, RATE_MIN_BASE, type OsmoCtx } from '../worker/src/parse/osmosis';
import { OSMOSIS } from '../worker/src/config';
import { settleOf, quotesNeeded, settleMetaOf, type SettleMeta } from '../shared/settle';

const ctx: OsmoCtx = { poolAddrs: new Map(), priceUsd: null, assets: osmoAssets() };
const load = (name: string) => JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'));
const swapOf = (tx: any) => parseOsmosisTx(normFromTxSearch(tx, 0), ctx).flows.find((f) => f.id.endsWith(':swap'))!;
const settled = (name: string) => {
  const f = swapOf(load(name));
  const s = f.meta.settle as SettleMeta;
  return { f, s, p: settleOf(f.kind as 'buy' | 'sell', s) };
};
/** Moves every hop through `pool` to a pool nothing trusts, as a trade through a pool outside ratePools would read. */
const untrusted = (tx: any, pool: string) => {
  const moved = JSON.parse(JSON.stringify(tx));
  for (const e of moved.tx_result.events) for (const a of e.attributes) if (a.key === 'pool_id' && a.value === pool) a.value = '9999';
  return moved;
};

describe('the pools a coin may be priced in (OSMOSIS.ratePools)', () => {
  it('names each quoted coin\'s USDC pool as the router used it, and only coins the cron quotes', () => {
    expect(OSMOSIS.ratePools).toEqual({
      '1464': 'uosmo',
      '1221': 'uosmo',
      '1263': 'uosmo',
      '1251': OSMOSIS.quotedCoins.ATOM,
      '1247': OSMOSIS.quotedCoins.TIA,
      '1652': OSMOSIS.quotedCoins.KYVE,
      '1948': OSMOSIS.quotedCoins.ETH,
    });
    const quoted = Object.values(OSMOSIS.quotedCoins);
    for (const denom of Object.values(OSMOSIS.ratePools)) expect(quoted).toContain(denom);
    expect(RATE_MIN_BASE).toBe(10_000n);
  });
});

describe('a buy paid in ATOM through pool 1251 (FD060BA2…, block 70,869,425)', () => {
  // The trader put in 1 ATOM: 0.996503 ATOM reached pool 1251 (the rest was the taker fee) and came out as 1.768082
  // USDC; 1.762781 USDC went into pool 3005 and bought 2,610.91115 NAM. Gas 0.076623 OSMO, and no OSMO/USDC hop in the
  // transaction, so the gas has no rate of its own.
  const atomRate = 1.768082 / 0.996503;
  it('values the ATOM at the trader\'s own hop; its gas still wants the minute\'s OSMO quote', () => {
    const { f, s, p } = settled('osmo_buy_atom_pool1251.json');
    expect(f.kind).toBe('buy');
    expect(f.amount).toBeCloseTo(2610.91115, 6);
    expect(f.poolId).toBe('3005');
    expect(s.nam).toBeCloseTo(2610.91115, 6);
    expect(s.coins).toEqual({ ATOM: -1 });
    expect(s.gas).toEqual({ OSMO: 0.076623 });
    expect(Object.keys(s.rates!)).toEqual(['ATOM']);
    expect(s.rates!.ATOM).toBeCloseTo(atomRate, 12);
    expect(s.unknown).toBeUndefined();
    expect(quotesNeeded(s)).toEqual(['OSMO']);
    expect(p).toMatchObject({ side: 'buy', gasUsd: null, gasLeftOut: true });
    expect(p!.nam).toBeCloseTo(2610.91115, 6);
    expect(p!.coins).toHaveLength(1);
    expect(p!.coins[0]).toMatchObject({ symbol: 'ATOM', amount: -1, rate: 'tx' });
    expect(p!.coins[0].usdEach).toBeCloseTo(atomRate, 12);
    expect(p!.usdPerNam).toBeCloseTo(atomRate / 2610.91115, 12);
    // with the OSMO quote for its minute the gas counts too
    expect(settleOf('buy', s, { OSMO: 0.05 })!.usdPerNam).toBeCloseTo((atomRate + 0.076623 * 0.05) / 2610.91115, 12);
  });
  it('through a pool outside ratePools the same hop sets no rate: the trade then needs the ATOM quote', () => {
    const s = swapOf(untrusted(load('osmo_buy_atom_pool1251.json'), '1251')).meta.settle as SettleMeta;
    expect(s.coins).toEqual({ ATOM: -1 });
    expect(s.rates).toBeUndefined();
    expect(quotesNeeded(s)).toEqual(['ATOM', 'OSMO']);
    expect(settleOf('buy', s)).toBeNull();
  });
});

describe('a sale paid in TIA through pool 1247 (464DD69E…, block 72,942,998)', () => {
  // The trader gave 7,548.755684 NAM: 7,526.124515 reached pool 3005 (22.631169 was the taker fee, in NAM) and came
  // out as 5.941405 USDC; 5.926558 USDC went into pool 1247 and came out as 9.531948 TIA. Gas 0.048343 OSMO, valued at
  // ProtoRev's backrun through pool 1464 in the same transaction (23.9976 OSMO for 1.14009 USDC), the trader having no
  // OSMO hop of their own.
  const tiaRate = 5.926558 / 9.531948;
  const osmoRate = 1.14009 / 23.9976;
  it('values the TIA at the trader\'s own hop and the gas at the transaction\'s OSMO hop', () => {
    const { f, s, p } = settled('osmo_sell_tia_pool1247.json');
    expect(f.kind).toBe('sell');
    expect(f.amount).toBeCloseTo(7526.124515, 6);
    expect(s.nam).toBeCloseTo(-7548.755684, 6);
    expect(s.coins).toEqual({ TIA: 9.531948 });
    expect(s.gas).toEqual({ OSMO: 0.048343 });
    expect(Object.keys(s.rates!).sort()).toEqual(['OSMO', 'TIA']);
    expect(s.rates!.TIA).toBeCloseTo(tiaRate, 12);
    expect(s.rates!.OSMO).toBeCloseTo(osmoRate, 12);
    expect(quotesNeeded(s)).toEqual([]);
    expect(p).toMatchObject({ side: 'sell', gasLeftOut: false });
    expect(p!.coins[0]).toMatchObject({ symbol: 'TIA', amount: 9.531948, rate: 'tx' });
    expect(p!.gasUsd).toBeCloseTo(0.048343 * osmoRate, 12);
    // what the TIA was worth at that hop is the USDC that went into it
    expect(9.531948 * tiaRate).toBeCloseTo(5.926558, 12);
    expect(p!.usdPerNam).toBeCloseTo((9.531948 * tiaRate - 0.048343 * osmoRate) / 7548.755684, 12);
  });
});

describe('a sale paid in KYVE through pool 1652 (EADD1781…, block 72,504,066)', () => {
  // The trader gave 2,000 NAM: 1,994.004 reached pool 3005 (5.996 was the taker fee) and came out as 1.739474 USDC;
  // 1.730788 USDC went into pool 1652 and came out as 943.1852 KYVE. Gas 0.048414 OSMO, with no OSMO hop at all.
  const kyveRate = 1.730788 / 943.1852;
  it('values the KYVE at the trader\'s own hop; the gas is left out until the OSMO quote', () => {
    const { f, s, p } = settled('osmo_sell_kyve_pool1652.json');
    expect(f.kind).toBe('sell');
    expect(f.amount).toBeCloseTo(1994.004, 6);
    expect(s.nam).toBeCloseTo(-2000, 9);
    expect(s.coins).toEqual({ KYVE: 943.1852 });
    expect(s.gas).toEqual({ OSMO: 0.048414 });
    expect(Object.keys(s.rates!)).toEqual(['KYVE']);
    expect(s.rates!.KYVE).toBeCloseTo(kyveRate, 15);
    expect(quotesNeeded(s)).toEqual(['OSMO']);
    expect(p).toMatchObject({ side: 'sell', gasUsd: null, gasLeftOut: true });
    expect(p!.coins[0]).toMatchObject({ symbol: 'KYVE', amount: 943.1852, rate: 'tx' });
    expect(p!.usdPerNam).toBeCloseTo((943.1852 * kyveRate) / 2000, 15);
    expect(p!.usdPerNam).toBeCloseTo(1.730788 / 2000, 15);
  });
});

describe('a buy paid in ETH through pool 1948 (D1680992…, block 69,649,401)', () => {
  // The trader paid 0.000409135580829676 allETH (symbol ETH, 18 decimals): 0.000408726547532742 reached pool 1948 (the
  // rest was the taker fee) and came out as 1.008272 USDC; 1.005249 USDC went into pool 3005 and bought 1,761.854327
  // NAM. Gas 970,956,443,138 wei of the same coin, valued at the same hop.
  const ethRate = 1.008272 / 0.000408726547532742;
  const gasEth = 9.70956443138e-7;
  it('values the ETH, and the gas paid in it, at the trader\'s own hop', () => {
    const { f, s, p } = settled('osmo_buy_eth_pool1948.json');
    expect(f.kind).toBe('buy');
    expect(f.amount).toBeCloseTo(1761.854327, 6);
    expect(s.coins.ETH).toBeCloseTo(-0.000409135580829676, 15);
    expect(Object.keys(s.coins)).toEqual(['ETH']);
    expect(s.gas!.ETH).toBeCloseTo(gasEth, 18);
    expect(Object.keys(s.rates!)).toEqual(['ETH']);
    expect(s.rates!.ETH).toBeCloseTo(ethRate, 9);
    expect(quotesNeeded(s)).toEqual([]);
    expect(p).toMatchObject({ side: 'buy', gasLeftOut: false });
    expect(p!.coins[0]).toMatchObject({ symbol: 'ETH', rate: 'tx' });
    expect(p!.gasUsd).toBeCloseTo(gasEth * ethRate, 12);
    expect(p!.usdPerNam).toBeCloseTo(((0.000409135580829676 + gasEth) * ethRate) / 1761.854327, 12);
  });
});

describe('buys paid in OSMO through pools 1221 and 1263, the router\'s choices for the OSMO leg', () => {
  it('pool 1221 (F3E7CFDE…, block 72,408,847): 12 OSMO, 11.880192 of it into the pool for 0.558809 USDC', () => {
    // 0.557134 USDC went into pool 3005 and bought 602.799025 NAM; gas 0.04406 OSMO at the same hop
    const osmoRate = 0.558809 / 11.880192;
    const { f, s, p } = settled('osmo_buy_osmo_pool1221.json');
    expect(f.kind).toBe('buy');
    expect(f.amount).toBeCloseTo(602.799025, 6);
    expect(s.coins).toEqual({ OSMO: -12 });
    expect(s.gas).toEqual({ OSMO: 0.04406 });
    expect(Object.keys(s.rates!)).toEqual(['OSMO']);
    expect(s.rates!.OSMO).toBeCloseTo(osmoRate, 12);
    expect(quotesNeeded(s)).toEqual([]);
    expect(p).toMatchObject({ side: 'buy', gasLeftOut: false });
    expect(p!.coins[0]).toMatchObject({ symbol: 'OSMO', amount: -12, rate: 'tx' });
    expect(p!.gasUsd).toBeCloseTo(0.04406 * osmoRate, 12);
    expect(p!.usdPerNam).toBeCloseTo(((12 + 0.04406) * osmoRate) / 602.799025, 12);
  });
  it('pool 1263 (04EFCC4F…, block 72,765,184): 10 OSMO, 9.91504 of it into the pool for 0.433145 USDC', () => {
    // 0.431846 USDC went into pool 3005 and bought 411.7819 NAM; gas 0.044078 OSMO at the same hop
    const osmoRate = 0.433145 / 9.91504;
    const { f, s, p } = settled('osmo_buy_osmo_pool1263.json');
    expect(f.kind).toBe('buy');
    expect(f.amount).toBeCloseTo(411.7819, 6);
    expect(s.coins).toEqual({ OSMO: -10 });
    expect(s.gas).toEqual({ OSMO: 0.044078 });
    expect(Object.keys(s.rates!)).toEqual(['OSMO']);
    expect(s.rates!.OSMO).toBeCloseTo(osmoRate, 12);
    expect(quotesNeeded(s)).toEqual([]);
    expect(p).toMatchObject({ side: 'buy', gasLeftOut: false });
    expect(p!.gasUsd).toBeCloseTo(0.044078 * osmoRate, 12);
    expect(p!.usdPerNam).toBeCloseTo(((10 + 0.044078) * osmoRate) / 411.7819, 12);
  });
  it('before 1221 was trusted the same trade had no rate and waited for a quote that was never stored for its minute', () => {
    const s = swapOf(untrusted(load('osmo_buy_osmo_pool1221.json'), '1221')).meta.settle as SettleMeta;
    expect(s.rates).toBeUndefined();
    expect(quotesNeeded(s)).toEqual(['OSMO']);
    expect(settleOf('buy', s)).toBeNull();
  });
});

describe('a buy paid in a coin the parser does not name (04AFB0E2…, block 69,425,734)', () => {
  // The trader paid 90 of ibc/094FB7… (SAGA in the Osmosis asset list; not in osmoAssets): 89.82009 reached pool 3440
  // and came out as 1.350963 USDC, 1.346913 USDC went into pool 3005 and bought 2,057.76257 NAM. Gas 0.048685 OSMO at
  // ProtoRev's hop through pool 1464 (0.179157 USDC for 5.02261 OSMO).
  const saga = 'ibc/094FB70C3006906F67F5D674073D2DAFAFB41537E7033098F5C752F211E7B6C2';
  it('keeps that coin\'s denom in the record and has no settle price', () => {
    const { f, s, p } = settled('osmo_buy_unknown_coin.json');
    expect(f.kind).toBe('buy');
    expect(f.amount).toBeCloseTo(2057.76257, 6);
    expect(s.coins).toEqual({});
    expect(s.unknown).toEqual([saga]);
    expect(s.gas).toEqual({ OSMO: 0.048685 });
    expect(s.rates!.OSMO).toBeCloseTo(0.179157 / 5.02261, 12);
    expect(quotesNeeded(s)).toEqual([]);
    expect(p).toBeNull();
    // the stored form is the same record, and a row's meta still reads as one
    const stored = JSON.parse(JSON.stringify({ trader: f.meta.trader, settle: s }));
    expect(settleMetaOf(stored)!.unknown).toEqual([saga]);
    expect(JSON.stringify(stored)).toContain(saga);
  });
  it('a record written before 2026-10-23 says only that a coin was unknown, and is still no settle price', () => {
    const old: SettleMeta = { nam: 2057.76257, coins: {}, unknown: true, gas: { OSMO: 0.048685 } };
    expect(settleMetaOf({ settle: old })).toEqual(old);
    expect(settleOf('buy', old, { OSMO: 0.05 })).toBeNull();
  });
});
