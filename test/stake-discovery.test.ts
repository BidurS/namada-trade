import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseBondListing } from '../worker/src/sources/namada';

// A real answer of /vp/pos/bonds_and_unbonds/to/tnam1q8a2xwh072herrmlgf06gvrhna775sqjuufnxydn (2026-10-19): 137
// delegations. Decoded independently (Python) to the last byte: 4,394,385.374146 NAM in bond entries. The
// per-validator answer has the layout of the whole-chain listing the cron reads (test/bulk-index.test.ts).
const { value } = JSON.parse(readFileSync(new URL('./fixtures/bonds_to_validator.json', import.meta.url), 'utf8'));

describe('bonds and unbonds to one validator', () => {
  it('reads every delegation to the last byte', () => {
    const d = parseBondListing(value);
    expect(d.sources.size).toBe(137);
    expect(d.entries).toBe(137);
    expect(Number(d.totalBase) / 1e6).toBeCloseTo(4394385.374146, 3);
  });
  it('gives real tnam1 addresses (established and implicit), each bonded to this one validator', () => {
    const d = parseBondListing(value);
    for (const [a, b] of d.sources) {
      expect(a).toMatch(/^tnam1[02-9ac-hj-np-z]{40}$/);
      for (const x of b.delegations) expect(x.validator).toBe('tnam1q8a2xwh072herrmlgf06gvrhna775sqjuufnxydn');
    }
  });
  it('a truncated answer is refused, never half-read', () => {
    const cut = btoa(atob(value).slice(0, 5000));
    expect(() => parseBondListing(cut)).toThrow();
  });
});
