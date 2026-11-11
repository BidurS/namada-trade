// What a panel's source line says of its figures (owner decision 48, 2026-11-10). One state for every figure: that
// state's word, as before. Figures in different states: a count of each, so a single figure that was not read no
// longer makes the line say "no data" over a full table, and the dot is the worst state among the figures read.
import { describe, it, expect } from 'vitest';
import { scopeSummary } from '../web/src/ui/SourceLine';
import type { Stamp } from '../web/src/lib/prov';

const NOW = Date.UTC(2026, 10, 10, 12, 0);
const live = (source: string, ageMs = 30_000): Stamp => ({ source, at: NOW - ageMs, status: 'live' });
const stale = (source: string, ageMs = 3_600_000): Stamp => ({ source, at: NOW - ageMs, status: 'stale' });
const missing = (source: string): Stamp => ({ source, at: null, status: 'missing', note: 'not read' });
const conflict = (source: string): Stamp => ({ source, at: NOW - 30_000, status: 'conflict' });
const items = (...ps: Stamp[]) => ps.map((p, i) => ({ label: `figure ${i + 1}`, p }));
const words = (s: string) => s.replace(/ /g, ' ');

describe('a panel\'s source line', () => {
  it('says one state when every figure is in it, as before', () => {
    expect(scopeSummary(items(live('A'), live('A')), NOW)).toMatchObject({ status: 'fresh' });
    expect(words(scopeSummary(items(live('A'), live('A')), NOW).text)).toMatch(/ · A · .+ · fresh$/);
    expect(words(scopeSummary(items(stale('A'), stale('B')), NOW).text)).toMatch(/ · old$/);
    expect(scopeSummary(items(missing('A'), missing('B')), NOW)).toMatchObject({ status: 'none' });
    expect(words(scopeSummary(items(missing('A'), missing('B')), NOW).text)).toMatch(/ · no data$/);
    expect(words(scopeSummary(items(conflict('A')), NOW).text)).toMatch(/ · sources disagree$/);
    expect(scopeSummary([], NOW)).toMatchObject({ status: 'none' });
  });

  it('counts the figures by state when they differ: one not read is one not read, not "no data" over the rest', () => {
    const seven = Array.from({ length: 7 }, (_, i) => live(`chain ${i}`));
    const sum = scopeSummary(items(...seven, missing('Penumbra')), NOW);
    expect(words(sum.text)).toBe(' · 8 sources · 7 fresh · 1 not read');
    expect(words(sum.text)).not.toContain('no data');
    // the dot is the state of the figures that were read
    expect(sum.status).toBe('fresh');
  });

  it('says each state once, in the order fresh, old, disagree, not read, and the dot is the worst that was read', () => {
    const sum = scopeSummary(items(missing('D'), stale('B'), live('A'), conflict('C'), live('A')), NOW);
    expect(words(sum.text)).toBe(' · 4 sources · 2 fresh · 1 old · 1 disagree · 1 not read');
    expect(sum.status).toBe('disagree');
    expect(scopeSummary(items(live('A'), stale('B')), NOW).status).toBe('old');
    expect(words(scopeSummary(items(live('A'), stale('B')), NOW).text)).toBe(' · A, B · 1 fresh · 1 old');
  });

  it('keeps each count with its word on one line', () => {
    expect(scopeSummary(items(live('A'), missing('B')), NOW).text).toContain('1 fresh');
    expect(scopeSummary(items(live('A'), missing('B')), NOW).text).toContain('1 not read');
  });
});
