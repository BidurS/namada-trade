// Exact-viewport screenshots and layout audit with the installed Google Chrome (no browser download).
//
// usage: node scripts/shoot.mjs <url> <out.png> [width=375] [height=812] [--full | --tall] [--light] [--reduced] [--scale=2] [--wait=1500]
//
// Prints one JSON line: { overflowX, scrollWidth, innerWidth, smallText, smallTargets, tables, h1, consoleErrors }
//   overflowX     true when the page scrolls sideways (scrollWidth > innerWidth)
//   smallText     visible text nodes under 11 px (first 10)
//   smallTargets  interactive elements whose hit box is under 44 x 44 (first 10; inline links in prose are skipped)
import { chromium } from '@playwright/test';

const [url, out, w = '375', h = '812', ...flags] = process.argv.slice(2);
if (!url || !out) { console.error('usage: node scripts/shoot.mjs <url> <out.png> [width] [height] [--full] [--light] [--reduced] [--scale=2] [--wait=1500]'); process.exit(2); }
const flag = (n) => flags.includes(`--${n}`);
const opt = (n, d) => { const f = flags.find((x) => x.startsWith(`--${n}=`)); return f ? Number(f.split('=')[1]) : d; };

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({
  viewport: { width: Number(w), height: Number(h) },
  deviceScaleFactor: opt('scale', Number(w) < 768 ? 2 : 1),
  isMobile: Number(w) < 768,
  hasTouch: Number(w) < 768,
  colorScheme: flag('light') ? 'light' : 'dark',
  reducedMotion: flag('reduced') ? 'reduce' : 'no-preference',
});
const page = await ctx.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
page.on('pageerror', (e) => consoleErrors.push(String(e).slice(0, 200)));
if (flag('light')) await page.addInitScript(() => { try { localStorage.setItem('nt.theme', 'light'); } catch {} });
await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(opt('wait', 1500));

const audit = await page.evaluate(() => {
  const de = document.documentElement;
  const smallText = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const n = walker.currentNode; const t = n.textContent.trim(); if (!t) continue;
    const el = n.parentElement; const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
    const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    const px = parseFloat(cs.fontSize); if (px < 11) smallText.push(`${px}px "${t.slice(0, 40)}"`);
  }
  const smallTargets = [];
  for (const el of document.querySelectorAll('a[href], button, [role=button], input, select, textarea, [tabindex]:not([tabindex="-1"])')) {
    const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
    if (el.tagName === 'A' && el.closest('p, li > p, .prose')) continue;
    // effective hit box: the element plus ::after (the 44 px pseudo-element pattern)
    const after = getComputedStyle(el, '::after');
    let ew = r.width, eh = r.height;
    if (after.content !== 'none' && after.position === 'absolute') {
      const ins = (v) => (v === 'auto' ? 0 : -parseFloat(v) || 0);
      ew = r.width + ins(after.left) + ins(after.right); eh = r.height + ins(after.top) + ins(after.bottom);
    }
    if (ew < 44 || eh < 44) smallTargets.push(`${Math.round(ew)}x${Math.round(eh)} ${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30)}"`);
  }
  return {
    overflowX: de.scrollWidth > window.innerWidth, scrollWidth: de.scrollWidth, innerWidth: window.innerWidth,
    pageHeight: de.scrollHeight, h1: [...document.querySelectorAll('h1')].map((x) => x.textContent.trim()),
    tables: document.querySelectorAll('table').length,
    smallText: smallText.slice(0, 10), smallTextCount: smallText.length,
    smallTargets: smallTargets.slice(0, 10), smallTargetCount: smallTargets.length,
  };
});
if (flag('tall')) {
  // --tall: a full-page shot taken with the window as tall as the page, so the sticky header sits at
  // the top and the fixed tab bar at the bottom, as on a phone (Chrome's beyond-viewport capture
  // paints both at the first window's position instead). Width, and so every layout, is unchanged.
  const tall = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: Number(w), height: tall });
  await page.waitForTimeout(800);
  const again = await page.evaluate(() => document.documentElement.scrollHeight);
  if (again !== tall) { await page.setViewportSize({ width: Number(w), height: again }); await page.waitForTimeout(500); }
  await page.screenshot({ path: out });
} else {
  await page.screenshot({ path: out, fullPage: flag('full') });
}
console.log(JSON.stringify({ ...audit, consoleErrors: consoleErrors.slice(0, 5) }));
await browser.close();
