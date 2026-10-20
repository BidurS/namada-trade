// Gate G4, contrast over the tokens: reads docs/design/tokens.css (web/src/styles/tokens.css is a
// verbatim copy and is compared too) and checks every pair in docs/design/system.md 4.1, in both
// themes and on the yellow ground, with WCAG 2.1 relative luminance:
//   text at least 4.5 (no large-text exemption is taken: every pair is held to 4.5);
//   control borders, chart marks, focus rings and status dots at least 3.
// The rendered half of the gate (axe AA on every route, and "--ink-3 never on a number") runs in
// Playwright: web/e2e/gates.spec.ts.
//
// usage: node --experimental-strip-types scripts/contrast.ts   (exit 1 on any failure)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const css = readFileSync(join(ROOT, 'docs', 'design', 'tokens.css'), 'utf8');
const copy = readFileSync(join(ROOT, 'web', 'src', 'styles', 'tokens.css'), 'utf8');

type RGB = [number, number, number];

/** The body of the first rule whose selector text contains `marker` (braces balanced). */
function block(marker: string): string {
  const i = css.indexOf(marker);
  if (i < 0) throw new Error(`tokens.css: no block ${marker}`);
  const open = css.indexOf('{', i);
  let depth = 0;
  for (let j = open; j < css.length; j++) {
    if (css[j] === '{') depth++;
    else if (css[j] === '}' && --depth === 0) return css.slice(open + 1, j);
  }
  throw new Error(`tokens.css: unbalanced block ${marker}`);
}

/** `--name: #hex` declarations of a block (other values are not colours). */
function vars(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\b/g)) out[m[1]] = m[2].toLowerCase();
  return out;
}

const hex = (h: string): RGB => {
  let s = h.replace('#', '');
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
};
const lum = ([r, g, b]: RGB) => {
  const f = (c: number) => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
export const ratio = (a: RGB, b: RGB) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
/** `fg` at `alpha` over `bg` (a tint or a wash). */
const over = (fg: RGB, alpha: number, bg: RGB): RGB => [0, 1, 2].map((i) => Math.round(fg[i] * alpha + bg[i] * (1 - alpha))) as RGB;

const dark = vars(block(':where(:root[data-theme="dark"])'));
const light = { ...dark, ...vars(block(':root[data-theme="light"] {')) };
const accent = vars(block('.ground-accent {'));
const tintOf = (body: string, fallback: number) => {
  const m = /--tag-tint:\s*([\d.]+)%/.exec(body);
  return m ? Number(m[1]) / 100 : fallback;
};
const darkTint = tintOf(block(':where(:root[data-theme="dark"])'), 0.06);
const lightTint = tintOf(block(':root[data-theme="light"] {'), 0.05);

interface Row { theme: string; fg: string; bg: string; ratio: number; min: number; ok: boolean }
const rows: Row[] = [];
const need = (theme: string, fgName: string, fg: RGB, bgName: string, bg: RGB, min: number) => {
  const r = ratio(fg, bg);
  rows.push({ theme, fg: fgName, bg: bgName, ratio: Math.round(r * 100) / 100, min, ok: r >= min - 1e-9 });
};
const tok = (t: Record<string, string>, n: string): RGB => {
  if (!t[n]) throw new Error(`tokens.css: ${n} is not a hex colour`);
  return hex(t[n]);
};

const GROUNDS = ['--bg', '--surface', '--surface-2'];
const FLOW = ['--buy', '--sell', '--ibc', '--shield', '--pos'];

for (const [theme, t, tint] of [['dark', dark, darkTint], ['light', light, lightTint]] as const) {
  // text on the three grounds
  const text = ['--ink', '--ink-2', '--ink-3', '--good', '--warn', '--bad', '--shielded', ...(theme === 'light' ? ['--accent-text'] : [])];
  for (const fg of text) for (const g of GROUNDS) need(theme, fg, tok(t, fg), g, tok(t, g), 4.5);
  // flow hues as plain text on the grounds (dark lists them; light uses them only on a tint)
  if (theme === 'dark') for (const fg of FLOW) for (const g of GROUNDS) need(theme, fg, tok(t, fg), g, tok(t, g), 4.5);
  // flow tag text on its own tint over bg and surface (tags sit there only)
  for (const fg of FLOW) for (const g of ['--bg', '--surface']) need(theme, `${fg} tag`, tok(t, fg), `${fg} ${Math.round(tint * 100)}% over ${g}`, over(tok(t, fg), tint, tok(t, g)), 4.5);
  // control borders, the chip boundary: 3:1 (WCAG 1.4.11)
  for (const g of GROUNDS) need(theme, '--line-strong', tok(t, '--line-strong'), g, tok(t, g), 3);
  // focus ring on the page ground
  need(theme, '--focus', tok(t, '--focus'), '--bg', tok(t, '--bg'), 3);
  // the primary button
  need(theme, '--btn-primary-ink', tok(t, '--btn-primary-ink'), '--btn-primary-bg', tok(t, '--btn-primary-bg'), 4.5);
  // supply bar: labels inside the staked and rest segments
  need(theme, theme === 'dark' ? '#000 label' : '#fff label', theme === 'dark' ? hex('#000000') : hex('#ffffff'), '--fill-staked', tok(t, '--fill-staked'), 4.5);
  need(theme, theme === 'dark' ? '--ink label' : '#000 label', theme === 'dark' ? tok(t, '--ink') : hex('#000000'), '--fill-rest', tok(t, '--fill-rest'), 4.5);
  // chart marks: executed line (ink) and quoted line (ink-3) on the page ground
  need(theme, 'executed line --ink', tok(t, '--ink'), '--bg', tok(t, '--bg'), 3);
  need(theme, 'quoted line --ink-3', tok(t, '--ink-3'), '--bg', tok(t, '--bg'), 3);
}

// the bezel (header and tab bar are black in both themes)
need('chrome', '--chrome-ink', tok(dark, '--chrome-ink'), '--chrome', tok(dark, '--chrome'), 4.5);
need('chrome', '--chrome-ink-2', tok(dark, '--chrome-ink-2'), '--chrome', tok(dark, '--chrome'), 4.5);
// yellow as text or a mark on black, and black on yellow
need('dark', '--accent-text', tok(dark, '--accent-text'), '--bg', tok(dark, '--bg'), 4.5);
need('dark', '--accent-ink', tok(dark, '--accent-ink'), '--accent', tok(dark, '--accent'), 4.5);
// light: --c-mark is black with yellow ink (last-value pill, Osmosis slice)
need('light', 'mark ink #ffff00', hex('#ffff00'), 'mark #000', hex('#000000'), 4.5);

// the yellow ground (.ground-accent)
const Y = tok(dark, '--accent');
need('yellow', '--c-ink #000', hex('#000000'), '--accent', Y, 4.5);
need('yellow', '--accent-ink-2', tok(dark, '--accent-ink-2'), '--accent', Y, 4.5);
need('yellow', '--accent-ink-3', tok(dark, '--accent-ink-3'), '--accent', Y, 4.5);
need('yellow', 'line-strong #000', hex('#000000'), '--accent', Y, 3);
need('yellow', 'quoted line --accent-ink-3', tok(dark, '--accent-ink-3'), '--accent', Y, 3);
// chips on yellow are black pills: their text and the status dots beside the words
need('yellow', '--accent-chip-ink', tok(dark, '--accent-chip-ink'), 'chip #000', hex('#000000'), 4.5);
for (const s of ['--good', '--warn', '--bad']) need('yellow', `${s} dot`, tok(dark, s), 'chip #000', hex('#000000'), 3);
// the notice wash on yellow: black at 6%
const wash = over(hex('#000000'), 0.06, Y);
for (const fg of [['#000', hex('#000000')], ['--accent-ink-2', tok(dark, '--accent-ink-2')], ['--accent-ink-3', tok(dark, '--accent-ink-3')]] as const) need('yellow', fg[0], fg[1], 'notice wash (black 6%)', wash, 4.5);
void accent;

const failed = rows.filter((r) => !r.ok);
for (const r of rows) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.theme.padEnd(6)} ${r.fg.padEnd(30)} on ${r.bg.padEnd(30)} ${r.ratio.toFixed(2).padStart(6)}  (min ${r.min})`);
const sameCopy = css === copy;
console.log(JSON.stringify({ gate: 'G4 contrast (tokens)', pairs: rows.length, failed: failed.length, copyIsVerbatim: sameCopy }));
process.exit(failed.length || !sameCopy ? 1 : 0);
