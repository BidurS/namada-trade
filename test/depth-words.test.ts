// Every sentence shared/depth.ts gives the page is checked against the banned words (test/banned-words.ts, the copy
// lint's list). The fixed sentences hold no figure at all; the sentences built from a read or from the module's
// configuration (the book's pool, a coin's price, a clock) carry only the figure passed in: a number on the page comes
// from a read or the configuration, never from these words.
import { describe, it, expect } from 'vitest';
import { BANNED } from './banned-words';
import { DEPTH_WORDS, DEPTH_FIXED_WORDS, DEPTH_BUILT_WORDS, DEPTH_PAGE_WORDS, DEPTH_SOURCES, CURVE_RANGES, heroWords, splitWords, foldFar, routerSays, cliffWords, marketWords, tradesInView, bookSource, counterUsdHow, dustWords, minuteRowsKept, historyRowsWords, heatRowsWords, changesRowsWords, HEAT_EDGES, HEAT_BANDS, HEAT_TOP_RATIO, HEAT_RANGE_WORDS, DEPTH_SIZES, DEPTH_OFFSETS_PCT, DEPTH_TOUCH_SIZE } from '../shared/depth';

describe('the depth words', () => {
  it('none carries a banned word', () => {
    for (const w of DEPTH_WORDS) expect(w, w).not.toMatch(BANNED);
    for (const w of Object.values(DEPTH_SOURCES)) expect(w).not.toMatch(BANNED);
  });
  it('the fixed sentences carry no figure at all', () => {
    expect(DEPTH_FIXED_WORDS.length).toBeGreaterThan(10);
    for (const w of DEPTH_FIXED_WORDS) expect(w, w).not.toMatch(/\d/);
    expect(Object.keys(DEPTH_SOURCES)).not.toContain('book');
  });
  it('the built sentences carry only the figure passed in: the book’s pool from the configuration, a coin’s price, a clock, the retention and the stored reads’ counts', () => {
    expect(DEPTH_BUILT_WORDS.length).toBe(14);
    expect(minuteRowsKept(30).match(/\d+/g)).toEqual(['30']);
    expect(historyRowsWords('depth_minute', 'all', 1420, 1440).match(/\d+/g)).toEqual(['1420', '1440']);
    expect(heatRowsWords('depth_hourly', 720).match(/\d+/g)).toEqual(['720']);
    expect(changesRowsWords(null, 200)).toBe('depth_changes rows: 200');
    expect(changesRowsWords('3005', 7)).toBe('depth_changes rows of pool 3005: 7');
    expect(dustWords(1, 'NAM')).toBe('holds under 1 NAM and almost none of the other coin, so the pool is listed and not read');
    expect(dustWords(1, 'NAM').match(/\d+/g)).toEqual(['1']);
    expect(bookSource('3008')).toBe('Osmosis order book contract (pool 3008)');
    expect(bookSource('3008').match(/\d+/g)).toEqual(['3008']);
    expect(bookSource('12').match(/\d+/g)).toEqual(['12']);
    expect(counterUsdHow('OSMO', 0.0529, '02:56 UTC')).toContain('0.0529 USD');
    expect(counterUsdHow('OSMO', 0.0529, '02:56 UTC').match(/\d+(\.\d+)?/g)).toEqual(['0.0529', '02', '56']);
  });
  it('the page’s sentences (step S5) carry no banned word; every figure in one is an argument, never typed; the fixed ones among them hold no digit', () => {
    expect(DEPTH_PAGE_WORDS.length).toBeGreaterThan(60);
    for (const w of DEPTH_PAGE_WORDS) expect(w, w).not.toMatch(BANNED);
    expect(DEPTH_WORDS).toEqual(expect.arrayContaining([...DEPTH_PAGE_WORDS]));
    expect(heroWords('sell', '9.922965', '10,000', 'NAM').match(/\d[\d,.]*/g)).toEqual(['9.922965', '10,000']);
    expect(splitWords('pool 3005', '9,242', 'NAM', '92%').match(/\d[\d,.]*/g)).toEqual(['3005', '9,242', '92']);
    expect(foldFar('ask', 1171, '50%', '198.57', '1,322,018 NAM').match(/\d[\d,.]*/g)).toEqual(['1171', '50', '198.57', '1,322,018']);
    expect(routerSays('1.014160', '1,000', 'NAM', 'pool 3005', '02:47 UTC').match(/\d[\d,.:]*/g)).toEqual(['1.014160', '1,000', '3005', '02:47']);
    expect(cliffWords('1,000', 'NAM', '100,000', '−16.6%', '1,000,000', '−67.7%').match(/\d[\d,.]*/g)).toEqual(['1,000', '100,000', '16.6', '1,000,000', '67.7']);
    expect(marketWords('sell', '$507', '10,000', 'NAM', '2%').match(/\d[\d,.]*/g)).toEqual(['507', '10,000', '2']);
    expect(tradesInView(387, 389, 7).match(/\d+/g)).toEqual(['387', '389', '7']);
    // the curve's three windows are input choices (as a chart's 24h / 7d / 30d), the only page words with a digit of their own
    const withDigit = DEPTH_PAGE_WORDS.filter((w) => /\d/.test(w));
    const sampled = [heroWords('sell', '9.922965', '10,000', 'NAM')];
    expect(withDigit.length).toBeGreaterThan(sampled.length);
    for (const r of CURVE_RANGES) expect(DEPTH_PAGE_WORDS).toContain(r.label);
  });
  it('the constants the page and the Worker share are the plan’s: four sizes, six offsets, the touch at a hundred, 112 heat bands from a quarter of the reference to almost four times it', () => {
    expect([...DEPTH_SIZES]).toEqual([1000, 10000, 100000, 1000000]);
    expect([...DEPTH_OFFSETS_PCT]).toEqual([1, 2, 5, 10, 25, 50]);
    expect(DEPTH_TOUCH_SIZE).toBe(100);
    expect(HEAT_BANDS).toBe(112);
    expect(HEAT_EDGES.length).toBe(113);
    expect(HEAT_EDGES[0]).toBe(0.25);
    // 112 bands of two and a half percent from a quarter reach 3.97 times the reference, not four (no whole count does): the words say so
    expect(HEAT_TOP_RATIO).toBe(HEAT_EDGES[112]);
    expect(HEAT_TOP_RATIO).toBeCloseTo(3.972, 3);
    expect(HEAT_TOP_RATIO).toBeLessThan(4);
    expect(HEAT_TOP_RATIO * 1.025).toBeGreaterThan(4);
    expect(HEAT_RANGE_WORDS).toContain('almost four times');
  });
});
