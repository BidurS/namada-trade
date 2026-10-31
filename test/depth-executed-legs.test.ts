// The depth check's comparison at the NAM pools themselves (worker/src/parse/osmosis.ts meta.legs, worker/src/depth/
// index.ts grossOfLeg and executedCheck), on two trades as an Osmosis node served them on 2026-10-31. Until then the
// check compared a trade whole at the trader's own coins, so a buyer who paid OSMO through another pool paid that hop's
// fees outside the NAM pools and every such buy read about 0.8% short of the depth, a split route up to 3%, which kept
// the operator's incident open for 11 hours that day. Each leg's gross is now rebuilt from the chain's own amounts,
// and these trades show it to the base unit: what the rebuild gives is what the chain shows the trader putting in.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normFromTxSearch, osmoAssets, parseOsmosisTx, type OsmoCtx } from '../worker/src/parse/osmosis';
import { grossOfLeg } from '../worker/src/depth/index';

const fx = (n: string) => JSON.parse(readFileSync(join(__dirname, 'fixtures', n), 'utf8'));
const P3005 = 'osmo1m459jtgn77tz8cffvthq5jh0erswxu9872mjd9qde546mslc6udq85we5r';
const P3368 = 'osmo1h6zkrf476ha3csjmgf6eneh3p43ltmjlppvyzpmpyfxts0zk3k0s288e7l';
const P3402 = 'osmo1rj0hh5zutd4d7rpw3af95zmw965krfh3uk5f8tnpgpx9tj4w79fqvustrn';
const ctx: OsmoCtx = { poolAddrs: new Map([[P3005, '3005'], [P3368, '3368'], [P3402, '3402']]), priceUsd: null, assets: osmoAssets() };
const swapOf = (name: string) => parseOsmosisTx(normFromTxSearch(fx(name), 1), ctx).flows.find((f) => f.kind === 'buy' || f.kind === 'sell')!;
// the pools' fees as the depth reads them: spread from the pool, the taker fee each way from the chain (trading_pair_takerfee, 2026-10-31)
const pool = (type: string, spread: number, taker: number, takerBuy: number) => ({ type, model: { spread }, taker, takerBuy }) as any;
const P = { '3005': pool('concentrated', 0.002, 0.001, 0.001), '3368': pool('concentrated', 0.025, 0.002, 0.008), '3402': pool('balancer', 0.003, 0.002, 0.008) };

describe('a trade compared at the NAM pools', () => {
  it('a buy paid in OSMO through pool 1464: its one NAM leg is the USDC that entered pool 3005 net of the hop’s fees, and its gross is what came out of pool 1464', () => {
    const f = swapOf('osmo_buy_osmo_via_1464_3005.json');
    expect(f).toMatchObject({ kind: 'buy', amount: 5316.014685, poolId: '3005' });
    // the leg's gross is read from the hop's own transfers (the taker fee, the pool's leg, the spread): the chain's charge, so the depth's fees are tested too
    expect(f.meta?.legs).toEqual([{ pool: '3005', nam: 5316.014685, coin: 'USDC', amount: 4.020735, gross: 4.032825 }]);
    // the chain: 4,032,825 USDC out of pool 1464 = 4,033 taker fee + 8,057 spread + 4,020,735 into pool 3005
    expect(grossOfLeg(P['3005'], 4.020735, 0.001)).toBeCloseTo(4.032825, 5);
    // the trader's own coins (the comparison before 2026-10-31): 78.7 OSMO, of which the route's taker fee 0.6296
    expect(78.7 * (4.032825 / 78.062593) / 4.032825 - 1).toBeGreaterThan(0.008);
  });

  it('a split buy paid in OSMO: three legs, one through pool 1221 then 3005, one in concentrated 3368, one in balancer 3402; each gross is the OSMO or USDC the chain shows going into its hop', () => {
    const f = swapOf('osmo_split_buy_3005_3368_3402.json');
    expect(f.kind).toBe('buy');
    expect(f.meta?.legs).toEqual([
      { pool: '3005', nam: 522.327748, coin: 'USDC', amount: 0.397597, gross: 0.398792 },
      { pool: '3368', nam: 65.300623, coin: 'OSMO', amount: 0.9672, gross: 1 },
      { pool: '3402', nam: 65.313891, coin: 'OSMO', amount: 0.992, gross: 1 },
    ]);
    // the gross the chain charged equals the rebuild at the right fees, each way, which is what the depth now reads
    for (const l of f.meta!.legs as { pool: '3005' | '3368' | '3402'; amount: number; gross: number }[]) expect(grossOfLeg(P[l.pool], l.amount, P[l.pool].takerBuy)).toBeCloseTo(l.gross, 5); // within a base unit: the chain rounds each fee to whole units
    // 3005: 398,792 USDC out of pool 1221 went in (399 taker, 796 spread, 397,597 the event's tokens_in)
    expect(grossOfLeg(P['3005'], 0.397597, P['3005'].takerBuy)).toBeCloseTo(0.398792, 5);
    // 3368, concentrated: 1,000,000 uosmo went in (8,000 taker at 0.8%, 24,800 spread, 967,200 tokens_in)
    expect(grossOfLeg(P['3368'], 0.9672, P['3368'].takerBuy)).toBeCloseTo(1, 6);
    // 3402, balancer: 1,000,000 uosmo went in (8,000 taker; its swap fee stays in the pool, so tokens_in is 992,000)
    expect(grossOfLeg(P['3402'], 0.992, P['3402'].takerBuy)).toBeCloseTo(1, 6);
    // at the selling fee (0.2%, the only one the depth read before 2026-10-31) the rebuilt OSMO would be 0.6% short
    expect(1 - grossOfLeg(P['3402'], 0.992, P['3402'].taker)).toBeCloseTo(0.006, 3);
  });
});
