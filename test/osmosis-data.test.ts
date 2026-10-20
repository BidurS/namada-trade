// The Osmosis data API parser (worker/src/sources/osmosis-data.ts) on answers read on 2026-10-20 19:17 UTC:
// test/fixtures/osmosis-pair-summary.json (the 27 NAM pairs of /pairs/v2/summary kept byte for byte, plus three
// other pairs) and osmosis-pair-chart.json (/pairs/v1/historical/3005/chart?range=7d, the whole answer, 169 hourly
// points from 13 Oct 19:00 to 20 Oct 19:00 UTC). The expected figures were summed independently in Python.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { parsePairSummary, parsePairChart, fetchPairSummary, fetchPairChart, pairChartUrl, OSMOSIS_DATA_TIMEOUT_MS } from '../worker/src/sources/osmosis-data';
import { NAM, OSMOSIS } from '../worker/src/config';

const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));
afterEach(() => vi.unstubAllGlobals());

describe('the pair summary', () => {
  const s = parsePairSummary(fx('osmosis-pair-summary.json'));
  it('keeps the 27 NAM pairs and no other, with the summary\'s own update time', () => {
    expect(s.pairs).toHaveLength(27);
    expect(s.pairs.every((p) => p.base === NAM.osmoDenom || p.quote === NAM.osmoDenom)).toBe(true);
    expect(s.at).toBe(1792523803000);
    expect(s.pairs.map((p) => p.poolId)).toContain('3005');
    expect(s.pairs.map((p) => p.poolId)).not.toContain('3008'); // the transmuter is not in the summary
  });
  it('sums the dollar volumes and the priced-side liquidity of those pairs', () => {
    expect(s.volume24hUsd).toBeCloseTo(58.17255882543361, 9);
    expect(s.volume7dUsd).toBeCloseTo(641.7472355501536, 9);
    expect(s.liquidityUsd).toBeCloseTo(372.417288930319, 9);
    expect(s.pairs.find((p) => p.poolId === '3005')).toMatchObject({ volume24hUsd: 34.098059, volume7dUsd: 427.48607200000004, liquidityUsd: 209.277765, baseSymbol: 'USDC.n', quoteSymbol: 'NAM' });
  });
  it('a missing or malformed figure is null, never 0; an answer of another shape is refused', () => {
    const one = (v: unknown) => parsePairSummary({ data: [{ pool_id: '1', base_address: NAM.osmoDenom, quote_address: 'uosmo', volume_24h: v, volume_7d: 'x', liquidity: -3 }], last_update_at: 5 });
    expect(one(undefined).pairs[0]).toMatchObject({ volume24hUsd: null, volume7dUsd: null, liquidityUsd: null });
    expect(one(undefined)).toMatchObject({ volume24hUsd: null, at: 5000 });
    expect(one('2.5').pairs[0].volume24hUsd).toBe(2.5);
    expect(parsePairSummary({ data: [] })).toMatchObject({ at: null, pairs: [], volume24hUsd: null });
    expect(() => parsePairSummary({ pairs: [] })).toThrow(/no data list/);
  });
});

describe('the pair chart', () => {
  const c = parsePairChart(fx('osmosis-pair-chart.json'))!;
  it('169 hourly points, oldest first, in ms; 78 of them flat (no trade moved the pool that hour)', () => {
    expect(c).toHaveLength(169);
    expect(c[0].t).toBe(Date.UTC(2026, 9, 13, 19));
    expect(c[168].t).toBe(Date.UTC(2026, 9, 20, 19));
    expect(c.every((p, i) => i === 0 || p.t - c[i - 1].t === 3600000)).toBe(true);
    expect(c.filter((p) => p.flat)).toHaveLength(78);
  });
  it('turns NAM per USDC into dollars per NAM, high and low swapping places', () => {
    const p = c[168];
    expect(p.raw.close).toBe(878.983065291);
    expect(p.usd.close).toBeCloseTo(0.0011376783, 9);
    const moved = c.find((x) => !x.flat)!;
    expect(moved.usd.high).toBe(1 / moved.raw.low);
    expect(moved.usd.low).toBe(1 / moved.raw.high);
    expect(moved.usd.high).toBeGreaterThan(moved.usd.low);
  });
  it('[] (pool 3008) is "no series", not an empty chart; a point without a price is left out; not a list is refused', () => {
    expect(parsePairChart([])).toBeNull();
    expect(parsePairChart([{ time: 3600, open: 1, high: 1, low: 0, close: 1 }, { time: 7200, open: 2, high: 2, low: 2, close: 2 }])).toHaveLength(1);
    expect(() => parsePairChart({ data: [] })).toThrow(/not a list/);
  });
});

describe('the requests', () => {
  it('ask the documented URLs once, with a 10 s timeout and no retry, and refuse what is not JSON of the shape', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (u: string) => { urls.push(u); return new Response(u.includes('summary') ? JSON.stringify(fx('osmosis-pair-summary.json')) : '[]', { status: 200 }); });
    expect((await fetchPairSummary()).pairs).toHaveLength(27);
    expect(await fetchPairChart('3008')).toBeNull();
    expect(urls).toEqual(['https://data.app.osmosis.zone/pairs/v2/summary', pairChartUrl('3008', '7d')]);
    expect(pairChartUrl(OSMOSIS.refPoolId, '7d')).toBe(`https://data.app.osmosis.zone/pairs/v1/historical/3005/chart?asset_in=${encodeURIComponent(NAM.osmoDenom)}&asset_out=${encodeURIComponent(OSMOSIS.usdcDenom)}&range=7d&asset_type=denom`);
    expect(OSMOSIS_DATA_TIMEOUT_MS).toBe(10_000);
    vi.stubGlobal('fetch', async () => new Response('busy', { status: 503 }));
    await expect(fetchPairSummary()).rejects.toThrow();
  });
});
