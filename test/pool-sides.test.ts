// The NAM pools by what they hold: a pool empty on both sides is not listed (nor counted), and a pool holding only one
// side gets a row of its own that says so instead of a "$0" depth. Pool 3008's answer is the quote service's, as read
// on 2026-10-25: 910,154.558525 NAM, no USDC, liquidity_cap "0". Fetch is stubbed: nothing reaches Osmosis.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { testD1 } from './d1-sqlite';
import { poolSides, poolHoldsSomething, oneSidedWords } from '../shared/pool-sides';
import { fetchNamPools } from '../worker/src/sources/sqs';
import { readPairs } from '../worker/src/series-api';
import { splitPools } from '../web/src/screens/trade/model';
import { NAM } from '../worker/src/config';

afterEach(() => { vi.unstubAllGlobals(); });

const USDC = 'ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4';
const pool3008 = {
  chain_model: { contract_address: 'osmo1cf6jdap430ugk6c27cdm5stqkq7z3rkgfl5ps5nnw3d5409sw3vql4364c', pool_id: 3008, code_id: 885 },
  balances: [{ denom: USDC, amount: '0' }, { denom: NAM.osmoDenom, amount: '910154558525' }],
  type: 3, spread_factor: '0.000000000000000000', liquidity_cap: '0',
};
const emptyPool = { chain_model: { id: 3016 }, balances: [], type: 2, spread_factor: '0.005', liquidity_cap: '0' };
const twoSided = { chain_model: { id: 3005 }, balances: [{ denom: NAM.osmoDenom, amount: '650386950000' }, { denom: USDC, amount: '164630000' }], type: 2, spread_factor: '0.002', liquidity_cap: '165' };

describe('a pool by what it holds', () => {
  it('names both sides, one side, nothing, and an unread reserve', () => {
    expect(poolSides({ namReserve: 650386.95, counterReserve: 164.63 })).toBe('both');
    expect(poolSides({ namReserve: 910154.558525, counterReserve: 0 })).toBe('nam');
    expect(poolSides({ namReserve: 0, counterReserve: 12 })).toBe('coin');
    expect(poolSides({ namReserve: 0, counterReserve: 0 })).toBe('empty');
    expect(poolSides({ namReserve: null, counterReserve: 0 })).toBe('unknown');
    expect(poolHoldsSomething({ namReserve: null, counterReserve: null })).toBe(true);
    expect(oneSidedWords('nam', 'USDC')).toEqual({ depth: 'Only NAM inside', line: 'no USDC inside: it can be bought from, not sold into' });
    expect(oneSidedWords('both', 'USDC')).toBeNull();
  });

  it('the quote service\'s pool list leaves out a pool empty on both sides and keeps pool 3008', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([twoSided, pool3008, emptyPool]), { headers: { 'content-type': 'application/json' } })));
    const r = await fetchNamPools();
    expect(r.pools.map((p) => p.id)).toEqual(['3005', '3008']);
    const p = r.pools.find((x) => x.id === '3008')!;
    expect(p.namReserve).toBeCloseTo(910154.558525, 6);
    expect(p.counterReserve).toBe(0);
  });

  it('the pairs answer leaves out a pool empty on both sides', async () => {
    const db = testD1();
    const live = { pools: [
      { id: '3005', type: 'concentrated', address: '', pair: 'NAM / USDC', counterDenom: USDC, counterSymbol: 'USDC', namReserve: 650386.95, counterReserve: 164.63, liquidityUsd: 165, spreadFactor: 0.002 },
      { id: '3008', type: 'cosmwasm', address: '', pair: 'NAM / USDC', counterDenom: USDC, counterSymbol: 'USDC', namReserve: 910154.558525, counterReserve: 0, liquidityUsd: 0, spreadFactor: 0 },
      { id: '3016', type: 'concentrated', address: '', pair: 'NAM / UNKNOWN', counterDenom: '', counterSymbol: 'UNKNOWN', namReserve: 0, counterReserve: 0, liquidityUsd: 0, spreadFactor: 0.005 },
    ], at: Date.UTC(2026, 9, 25, 12) };
    const r = await readPairs(db as any, Date.UTC(2026, 9, 25, 12, 1), live);
    expect(r.pairs.map((p) => p.poolId)).toEqual(['3005', '3008']);
  });

  it('the Trade page gives a one-sided pool its own row, never the summed "$0" line', () => {
    const rows = [
      { id: '3005', liquidityUsd: 165, namReserve: 650386.95, counterReserve: 164.63 },
      { id: '3008', liquidityUsd: 0, namReserve: 910154.558525, counterReserve: 0 },
      { id: '3020', liquidityUsd: 0.4, namReserve: 300, counterReserve: 0.1 },
    ];
    const { shown, rest, oneSided } = splitPools(rows);
    expect(oneSided.map((p) => p.id)).toEqual(['3008']);
    expect([...shown, ...rest].map((p) => p.id)).not.toContain('3008');
  });
});
