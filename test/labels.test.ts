// W3: plain label and category words (owner decision 6). The raw labels are the ones in production on 2026-10-17.
import { describe, it, expect } from 'vitest';
import { label_plain, category_plain, labelSearchTerms } from '../worker/src/labels';
import { INTERNAL_LABELS } from '../worker/src/config';

describe('label_plain', () => {
  it('names the two genesis allocations the owner decided on', () => {
    expect(label_plain('Genesis: af backers')).toBe('Early backers (genesis)');
    expect(label_plain('Genesis: af_backers')).toBe('Early backers (genesis)');
    expect(label_plain('Genesis: public_allocations_completed')).toBe('Public sale allocation (genesis)');
    expect(label_plain('Genesis: public allocations completed')).toBe('Public sale allocation (genesis)');
  });

  it('spells out any other genesis label, underscores as spaces, first letter capital', () => {
    expect(label_plain('Genesis: early_core_contributors')).toBe('Genesis: Early core contributors');
    expect(label_plain('Genesis: pg_validators')).toBe('Genesis: Pg validators');
    expect(label_plain('Genesis: r&d_ecosystem_dev')).toBe('Genesis: R&d ecosystem dev');
  });

  it('joins combined genesis labels in plain words', () => {
    expect(label_plain('Genesis: af_backers, public_allocations_completed')).toBe('Early backers and public sale allocation (genesis)');
    expect(label_plain('Genesis: pg_validators, public_allocations_completed')).toBe('Genesis: Pg validators and public sale allocation');
    expect(label_plain('Genesis: af_backers, early_core_contributors, public_allocations_completed, r&d_ecosystem_dev'))
      .toBe('Genesis: Early backers, early core contributors, public sale allocation and r&d ecosystem dev');
  });

  it('names protocol accounts without expert words, and leaves other labels as they are', () => {
    for (const [addr, l] of Object.entries(INTERNAL_LABELS)) {
      const p = label_plain(l.label, addr)!;
      expect(p, addr).toBeTruthy();
      expect(p, addr).not.toMatch(/\b(PoS|IBC|MASP)\b/i);
    }
    expect(label_plain(null, 'tnam1pcqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzmefah')).toBe('Shielded pool');
    expect(label_plain('Anoma Foundation')).toBe('Anoma Foundation');
    expect(label_plain('Heliax')).toBe('Heliax');
    expect(label_plain('Osmosis Pool #3005 (NAM / USDC)')).toBe('Osmosis Pool #3005 (NAM / USDC)');
    expect(label_plain(null)).toBeNull();
    expect(label_plain('')).toBeNull();
  });
});

describe('category_plain', () => {
  it('uses the decision\'s words, then the word with a capital', () => {
    expect(['genesis', 'foundation', 'validator', 'exchange', 'bridge', 'pgf'].map(category_plain))
      .toEqual(['Genesis', 'Foundation', 'Validator', 'Exchange', 'Bridge', 'Public funding']);
    expect(category_plain('backer')).toBe('Backer');
    expect(category_plain('pool')).toBe('Pool');
    expect(category_plain('watch')).toBe('Watch');
    expect(category_plain(null)).toBeNull();
  });

  it('never shows an expert word for a protocol category', () => {
    for (const c of ['pos', 'masp', 'ibc', 'module', 'cex']) expect(category_plain(c), c).not.toMatch(/\b(PoS|IBC|MASP|CEX|module)\b/i);
  });
});

describe('labelSearchTerms', () => {
  it('finds raw genesis names from plain words', () => {
    expect(labelSearchTerms('early backers')).toContain('af_backers');
    expect(labelSearchTerms('public sale')).toContain('public_allocations_completed');
    expect(labelSearchTerms('early core')).toContain('early_core');
    expect(labelSearchTerms('  ')).toEqual([]);
  });
});
