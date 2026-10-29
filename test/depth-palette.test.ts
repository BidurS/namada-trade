// The depth chart's two categorical hues (depth plan 3.4): bids in the site's --buy and asks in --sell, both themes,
// validated by the dataviz skill's palette validator (validate_palette.js: lightness band, chroma floor, colour-vision
// separation, the normal-vision floor and contrast against the chart surface) on the token values read from
// docs/design/tokens.css, never on typed hexes. The stored trades are the ground's --c-ink-2 with a shape and a legend,
// never a third slot (a gray fails the validator as a slot, and rightly: the research recorded it). The validator is
// vendored unchanged at scripts/validate_palette.js, so the checks run on every machine and in CI, never skipped.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const TOKENS = readFileSync(join(ROOT, 'docs', 'design', 'tokens.css'), 'utf8');
const VALIDATOR = join(ROOT, 'scripts', 'validate_palette.js');

/** A token's value inside a block (`:root` dark, `:root[data-theme="light"]`), as tokens.css writes it. */
function token(block: string, name: string): string {
  const start = TOKENS.indexOf(block);
  expect(start, block).toBeGreaterThanOrEqual(0);
  const body = TOKENS.slice(start, TOKENS.indexOf('\n  }', start));
  const m = new RegExp(`${name.replace(/[-]/g, '\\-')}:\\s*(#[0-9a-fA-F]{6})`).exec(body);
  expect(m, `${name} in ${block}`).not.toBeNull();
  return m![1].toLowerCase();
}

const DARK = { buy: token(':where(:root[data-theme="dark"])', '--buy'), sell: token(':where(:root[data-theme="dark"])', '--sell'), bg: token(':where(:root[data-theme="dark"])', '--bg') };
const LIGHT = { buy: token(':root[data-theme="light"]', '--buy'), sell: token(':root[data-theme="light"]', '--sell'), bg: token(':root[data-theme="light"]', '--bg') };

describe('the depth palette: the site’s --buy and --sell on each theme’s ground', () => {
  it('the tokens are the hues the research validated on 2026-10-29 (proto/palette-validation.txt)', () => {
    expect(DARK).toEqual({ buy: '#3987e5', sell: '#d95926', bg: '#000000' });
    expect(LIGHT).toEqual({ buy: '#1f5fb0', sell: '#b8431a', bg: '#f4f4f2' });
  });

  it('pass every computable check of the vendored validator, both themes', () => {
    for (const [mode, t] of [['dark', DARK], ['light', LIGHT]] as const) {
      const out = execFileSync('node', [VALIDATOR, `${t.buy},${t.sell}`, '--mode', mode, '--surface', t.bg], { encoding: 'utf8' });
      expect(out, `${mode}: ${out}`).toContain('ALL CHECKS PASS');
      for (const check of ['Lightness band', 'Chroma floor', 'CVD separation', 'Normal-vision floor', 'Contrast vs surface']) expect(out, `${mode} ${check}`).toMatch(new RegExp(`\\[PASS\\]\\s+${check}`));
    }
  });

  it('the chart draws bids in --buy, asks in --sell, the trades in the ground’s secondary ink with a diamond, and the reference in --c-mark', () => {
    const css = readFileSync(join(ROOT, 'web', 'src', 'styles', 'screens', 'depth.css'), 'utf8');
    expect(css).toMatch(/\.dpc-bid\s*\{[^}]*stroke:\s*var\(--buy\)/);
    expect(css).toMatch(/\.dpc-ask\s*\{[^}]*stroke:\s*var\(--sell\)/);
    expect(css).toMatch(/\.dpc-trade\s*\{[^}]*fill:\s*var\(--c-ink-2\)/);
    expect(css).toMatch(/\.dpc-key-trade\s*\{[^}]*rotate\(45deg\)/);
    expect(css).toMatch(/\.dpc-ref\s*\{[^}]*stroke:\s*var\(--c-mark\)/);
    expect(css).toMatch(/\.dp-lrow--bid \.dp-lrow__bar[^}]*var\(--buy\)/);
    expect(css).toMatch(/\.dp-lrow--ask \.dp-lrow__bar[^}]*var\(--sell\)/);
    // no typed hex on the page's own styles: every colour is a token
    expect(css).not.toMatch(/#[0-9a-f]{3,6}\b/i);
  });
});
