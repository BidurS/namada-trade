// The supply bar's shares (owner decision 45, 2026-11-10): each printed share is rounded on its own, so the staked
// share reads the same on the bar as on every other page. The bar's widths stay the unrounded shares. When the parts,
// each rounded on its own, do not read a hundred together, one line says what they read; nothing is nudged.
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SupplyBar, type SupplySegment } from '../web/src/ui/SupplyBar';
import { fmtPctRule } from '../shared/format';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const seg = (key: SupplySegment['key'], name: string, nam: number): SupplySegment => ({ key, name, nam });
const draw = (segments: SupplySegment[]) => renderToStaticMarkup(createElement(SupplyBar, { segments }));

describe('the supply bar\'s shares', () => {
  it('prints each share as every other page prints it, rounded on its own', () => {
    // 23.46% staked: a rule that makes the parts add to a hundred would print 23.4 here; rounded on its own it is 23.5
    const segments = [seg('staked', 'Staked', 23.46), seg('unstaking', 'Leaving staking', 6.46), seg('pgf', 'Public funding', 7.76), seg('shielded', 'Shielded', 2.76), seg('rest', 'Everything else', 57.56), seg('osmosis', 'On Osmosis', 2)];
    const total = segments.reduce((a, s) => a + (s.nam as number), 0);
    const html = draw(segments);
    const t = text(html);
    for (const s of segments) expect(t, s.name).toContain(`${s.name} ${fmtPctRule(((s.nam as number) / total) * 100, 1)}`);
    expect(t).toContain('Staked 23.5%');
    // the widths are the unrounded shares
    expect(html).toContain(`flex:${(23.46 / total) * 100} 1 0%`);
  });

  it('says what the parts read together when that is not a hundred, and says nothing when it is', () => {
    const off = draw([seg('staked', 'Staked', 33.35), seg('rest', 'Everything else', 33.35), seg('osmosis', 'On Osmosis', 33.3)]);
    expect(text(off)).toMatch(/Each share is rounded on its own, so together they read 100\.1%\s*\./);
    const even = draw([seg('staked', 'Staked', 25), seg('rest', 'Everything else', 75)]);
    expect(text(even)).not.toContain('rounded on its own');
    expect(text(even)).toContain('Staked 25.0%');
  });

  it('a part with no reading has no share, and nothing at all is one sentence', () => {
    const html = draw([seg('staked', 'Staked', 40), { key: 'shielded', name: 'Shielded', nam: null }, seg('rest', 'Everything else', 60)]);
    expect(text(html)).toMatch(/Shielded\s+—/);
    expect(text(draw([{ key: 'staked', name: 'Staked', nam: null }]))).toContain('The supply split has no data right now.');
  });
});
