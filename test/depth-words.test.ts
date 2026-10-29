// Every sentence shared/depth.ts gives the page is checked against the banned words (test/banned-words.ts, the copy
// lint's list). The fixed sentences hold no figure at all; the sentences built from a read or from the module's
// configuration (the book's pool, a coin's price, a clock) carry only the figure passed in: a number on the page comes
// from a read or the configuration, never from these words.
import { describe, it, expect } from 'vitest';
import { BANNED } from './banned-words';
import { DEPTH_WORDS, DEPTH_FIXED_WORDS, DEPTH_BUILT_WORDS, DEPTH_SOURCES, bookSource, counterUsdHow, HEAT_EDGES, HEAT_BANDS, HEAT_TOP_RATIO, HEAT_RANGE_WORDS, DEPTH_SIZES, DEPTH_OFFSETS_PCT, DEPTH_TOUCH_SIZE } from '../shared/depth';

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
  it('the built sentences carry only the figure passed in: the book’s pool from the configuration, a coin’s price, a clock', () => {
    expect(DEPTH_BUILT_WORDS.length).toBe(4);
    expect(bookSource('3008')).toBe('Osmosis order book contract (pool 3008)');
    expect(bookSource('3008').match(/\d+/g)).toEqual(['3008']);
    expect(bookSource('12').match(/\d+/g)).toEqual(['12']);
    expect(counterUsdHow('OSMO', 0.0529, '02:56 UTC')).toContain('0.0529 USD');
    expect(counterUsdHow('OSMO', 0.0529, '02:56 UTC').match(/\d+(\.\d+)?/g)).toEqual(['0.0529', '02', '56']);
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
