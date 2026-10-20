import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseDelegators } from '../worker/src/sources/namada';

// A real answer of /vp/pos/bonds_and_unbonds/to/tnam1q8a2xwh072herrmlgf06gvrhna775sqjuufnxydn (2026-10-19): 137
// delegations. Decoded independently (Python) to the last byte: 4,394,385.374146 NAM in bond entries.
const { value } = JSON.parse(readFileSync(new URL('./fixtures/bonds_to_validator.json', import.meta.url), 'utf8'));

describe('staker discovery (bonds and unbonds to a validator)', () => {
  it('reads every delegation to the last byte', () => {
    const d = parseDelegators(value);
    expect(d.size).toBe(137);
    const total = [...d.values()].reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(4394385.374146, 3);
  });
  it('gives real tnam1 addresses (established and implicit)', () => {
    const d = parseDelegators(value);
    for (const a of d.keys()) expect(a).toMatch(/^tnam1[02-9ac-hj-np-z]{40}$/);
  });
  it('a truncated answer is refused, never half-read', () => {
    const cut = btoa(atob(value).slice(0, 5000));
    expect(() => parseDelegators(cut)).toThrow();
  });
});
