// Gate G9, the build size report: reads the production build in web/dist (run `npm run build`
// first) and checks the budgets of build-plan 8 and system.md 5.1:
//   initial JS at most 130 KB gzip: every script the first HTML loads (the module entry and its
//     modulepreload links), gzipped at level 9;
//   fonts at most 120 KB: every font file the build emits (woff2 is already compressed).
// It also prints the CSS and the largest lazy chunks, for the record.
//
// usage: node --experimental-strip-types scripts/budgets.ts   (exit 1 when over a budget)
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const ROOT = join(import.meta.dirname, '..');
const DIST = join(ROOT, 'web', 'dist');
const KB = 1024;
const BUDGET = { initialJsGzip: 130 * KB, fonts: 120 * KB };

const html = readFileSync(join(DIST, 'index.html'), 'utf8');
const refs = (re: RegExp) => [...html.matchAll(re)].map((m) => m[1]);
const entry = refs(/<script[^>]+type="module"[^>]+src="([^"]+)"/g);
const preload = refs(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+)"/g);
const css = refs(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g);
const fontPreload = refs(/<link[^>]+rel="preload"[^>]+as="font"[^>]+href="([^"]+)"/g);

const file = (u: string) => join(DIST, u.replace(/^\//, ''));
const gz = (u: string) => gzipSync(readFileSync(file(u)), { level: 9 }).length;
const raw = (u: string) => statSync(file(u)).size;

const initial = [...new Set([...entry, ...preload])];
const initialGzip = initial.reduce((n, u) => n + gz(u), 0);
const initialRaw = initial.reduce((n, u) => n + raw(u), 0);

const assets = readdirSync(join(DIST, 'assets'));
const fonts = assets.filter((f) => /\.(woff2?|ttf|otf)$/.test(f));
const fontBytes = fonts.reduce((n, f) => n + statSync(join(DIST, 'assets', f)).size, 0);
const lazy = assets
  .filter((f) => f.endsWith('.js') && !initial.some((u) => u.endsWith(f)))
  .map((f) => ({ f, gz: gzipSync(readFileSync(join(DIST, 'assets', f)), { level: 9 }).length }))
  .sort((a, b) => b.gz - a.gz);

const k = (n: number) => `${(n / KB).toFixed(1)} KB`;
console.log(`initial JS (${initial.length} files: ${initial.join(', ')}): ${k(initialGzip)} gzip, ${k(initialRaw)} raw; budget ${k(BUDGET.initialJsGzip)}`);
console.log(`fonts (${fonts.length} files: ${fonts.join(', ')}): ${k(fontBytes)}; budget ${k(BUDGET.fonts)}; preloaded: ${fontPreload.join(', ') || 'none'}`);
console.log(`CSS (${css.join(', ')}): ${k(css.reduce((n, u) => n + gz(u), 0))} gzip`);
console.log(`lazy chunks, largest first: ${lazy.slice(0, 8).map((x) => `${x.f} ${k(x.gz)}`).join('; ')}`);
const ok = initialGzip <= BUDGET.initialJsGzip && fontBytes <= BUDGET.fonts && fonts.every((f) => f.endsWith('.woff2'));
console.log(JSON.stringify({ gate: 'G9 budgets', initialJsGzipKB: +(initialGzip / KB).toFixed(1), fontsKB: +(fontBytes / KB).toFixed(1), woff2Only: fonts.every((f) => f.endsWith('.woff2')), ok }));
process.exit(ok ? 0 : 1);
