// The phone cut of Trade (platform plan, release E; owner-decisions row 42): the strip's four bands and the rule that
// says which band a link's target sits in (web/src/screens/trade/bands.ts), so /trade#h-pools shows the pools first.
// Pure functions: no browser. The page's own behaviour (one band shown, the jump, the page's length) is pinned in
// web/e2e/trade.spec.ts.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BANDS, FIRST_BAND, bandOfId, hashId } from '../web/src/screens/trade/bands';

const SRC = (file: string) => readFileSync(join(__dirname, '..', 'web', 'src', 'screens', 'trade', file), 'utf8');

/** A document that knows some ids: each maps to the data-band of its nearest marked ancestor (null: in no band). */
const doc = (ids: Record<string, string | null>) => ({
  getElementById: (id: string) => (id in ids ? ({ closest: () => (ids[id] == null ? null : { dataset: { band: ids[id] } }) } as unknown as HTMLElement) : null),
});

describe('the strip', () => {
  it('has four bands at most, the price first, in the order of the page, each a one-word label', () => {
    expect(BANDS.map((b) => b.value)).toEqual(['price', 'size', 'pools', 'trades']);
    expect(BANDS.length).toBeLessThanOrEqual(4);
    expect(FIRST_BAND).toBe(BANDS[0].value);
    for (const b of BANDS) expect(b.label, b.value).toMatch(/^[A-Z][a-z]+$/);
    expect(new Set(BANDS.map((b) => b.label)).size).toBe(BANDS.length);
  });

  it('every band the strip names is marked on an element of the page, and no other band is', () => {
    const marked = ['index.tsx', 'Buyers.tsx', 'SizeBlock.tsx', 'Pools.tsx', 'Tape.tsx'].flatMap((f) => [...SRC(f).matchAll(/data-band="([a-z]+)"/g)].map((m) => m[1]));
    expect([...new Set(marked)].sort()).toEqual(BANDS.map((b) => b.value).sort());
  });
});

describe('hashId', () => {
  it('reads the id a fragment names, decoded', () => {
    expect(hashId('#h-pools')).toBe('h-pools');
    expect(hashId('#h%2Dtape')).toBe('h-tape');
  });
  it('is null for no fragment, an empty one, and one that cannot be decoded', () => {
    expect(hashId('')).toBeNull();
    expect(hashId('#')).toBeNull();
    expect(hashId('#%E0%A4%A')).toBeNull();
  });
});

describe('bandOfId', () => {
  it('reads the band from the page when the target is in it', () => {
    const d = doc({ 'h-pools': 'pools', 'some-row': 'trades', 'tk-ticket': null });
    expect(bandOfId('h-pools', d)).toBe('pools');
    expect(bandOfId('some-row', d)).toBe('trades');
  });
  it('falls back to the heading table for a heading that is not rendered yet', () => {
    const d = doc({});
    expect(bandOfId('h-chart', d)).toBe('price');
    expect(bandOfId('h-daily', d)).toBe('price');
    expect(bandOfId('h-ladder', d)).toBe('size');
    expect(bandOfId('h-pools', d)).toBe('pools');
    expect(bandOfId('h-tape', d)).toBe('trades');
  });
  it('is null for a target in no band (the ticket, the token header), an unknown id, a band name the strip does not have, and no id', () => {
    const d = doc({ 'tk-ticket': null, 'h-head': null, odd: 'footer' });
    expect(bandOfId('tk-ticket', d)).toBeNull();
    expect(bandOfId('h-head', d)).toBeNull();
    expect(bandOfId('odd', d)).toBeNull();
    expect(bandOfId('no-such-id', d)).toBeNull();
    expect(bandOfId(null, d)).toBeNull();
    expect(bandOfId('h-pools', null)).toBe('pools');
  });
  it('every heading id in the table is a heading the page renders', () => {
    const all = ['index.tsx', 'Buyers.tsx', 'SizeBlock.tsx', 'Pools.tsx', 'Tape.tsx', 'Head.tsx'].map(SRC).join('\n');
    for (const id of ['h-chart', 'h-flow', 'h-buyers', 'h-turn', 'h-daily', 'h-ladder', 'h-pools', 'h-tape']) expect(all, id).toContain(`"${id}"`);
  });
});
