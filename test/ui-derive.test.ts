// derive(): a derived figure takes the OLDEST input time, the WORST input status, and names
// every input (system.md 8, 12). Pure functions only (web/src/lib/derive.ts).
import { describe, it, expect } from 'vitest';
import { derive, derived, inputNames } from '../web/src/lib/derive';
import type { Stamp } from '../web/src/lib/prov';

const now = Date.UTC(2026, 9, 17, 11, 24);
const price: Stamp = { source: 'Osmosis SQS', at: now - 10_000, status: 'live' };
const supply: Stamp = { source: 'Namada RPC abci_query', at: now - 60_000, status: 'live' };
const flows: Stamp = { source: 'D1 flow index', at: now - 3 * 3_600_000, status: 'stale', note: 'last Namada flow 3 h ago' };
const osmo: Stamp = { source: 'Keplr Osmosis bank/supply', at: now - 5_000, status: 'conflict' };
const gone: Stamp = { source: 'Osmosis SQS', at: null, status: 'missing', note: 'The quote service did not answer.' };

describe('derive', () => {
  it('takes the oldest input time', () => {
    expect(derive([price, supply], 'price x supply').at).toBe(supply.at);
    expect(derive([supply, price], 'price x supply').at).toBe(supply.at);
  });
  it('an input with an unknown time makes the result unknown', () => {
    expect(derive([price, gone], 'x').at).toBeNull();
  });
  it('takes the worst status: no data > sources disagree > old > fresh', () => {
    expect(derive([price, supply], 'x').status).toBe('live');
    expect(derive([price, flows], 'x').status).toBe('stale');
    expect(derive([flows, osmo], 'x').status).toBe('conflict');
    expect(derive([osmo, gone, flows], 'x').status).toBe('missing');
  });
  it('names the derivation and every input with its own time and status', () => {
    const d = derive([price, supply], 'price x alert size');
    expect(d.source).toBe('derived');
    expect(d.plain).toBe('Derived');
    expect(d.derivedFrom).toBe('price x alert size');
    expect(d.inputs).toEqual([
      { name: 'Osmosis quote', at: price.at, status: 'live' },
      { name: 'Namada node', at: supply.at, status: 'live' },
    ]);
    expect(inputNames(d)).toBe('Osmosis quote and Namada node');
  });
  it('carries the inputs’ notes', () => {
    expect(derive([price, flows], 'x').note).toBe('last Namada flow 3 h ago');
    expect(derive([price, supply], 'x').note).toBeUndefined();
  });
  it('nothing to derive from is no data', () => {
    const d = derive([], 'x');
    expect(d.status).toBe('missing');
    expect(d.at).toBeNull();
  });
});

describe('derived values', () => {
  it('computes only when every input has a value', () => {
    const r = derived<[number, number]>([{ value: 0.001025, prov: price }, { value: 10_000, prov: supply }], 'price x alert size', (p, n) => p * n);
    expect(r.value).toBeCloseTo(10.25, 10);
    expect(r.prov.at).toBe(supply.at);
  });
  it('a missing input gives no value and says no data (no fallback number)', () => {
    const r = derived<[number, number]>([{ value: null, prov: gone }, { value: 10_000, prov: supply }], 'price x alert size', (p, n) => p * n);
    expect(r.value).toBeNull();
    expect(r.prov.status).toBe('missing');
    expect(r.prov.note).toBe('The quote service did not answer.');
  });
  it('a non-finite result is no data', () => {
    const r = derived<[number, number]>([{ value: 1, prov: price }, { value: 0, prov: supply }], 'a / b', (a, b) => a / b);
    expect(r.value).toBeNull();
    expect(r.prov.status).toBe('missing');
  });
});
