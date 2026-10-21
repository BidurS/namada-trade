// Cross-route gates (build-plan 8), on top of each screen's own spec:
//   G4  axe AA on every route (dark and light, live and rewound, with the sheets open) and
//       "--ink-3 never on a number";
//   G5  the rendered half of the copy lint (scripts/copy-lint.ts is the source half), Home reading
//       grade, sentence case of headings;
//   G6  every route in every viewport, live and rewound, plus every sheet open;
//   G7  no animation under reduced motion on any route; no layout shift when data arrives;
//   G9  tabular figures at 48 px in the self-hosted font;
//   G10 N1 (each status mocked; the scope rule on every route), N2 (an odd-value fixture is what
//       the page prints), N3 (every route rewound), N4 (decision sets per view), N9 (network).
// Viewport-independent checks run once (375x812); width-dependent ones name their projects.
import AxeBuilder from '@axe-core/playwright';
import type { Page, Route } from '@playwright/test';
import { BODY, NOT_FOUND } from '../../shared/copy';
import { ROUTES } from '../../shared/routes';
import type { Overview, SearchResponse } from '../../shared/types';
import { REWIND_AT, animationsIn, apiUrls, expect, gotoRoute, isExempt, isLiveOnly, layoutAudit, onlyIn, test, trackRequests } from './helpers';
import { inlineScriptHashes, pagePolicies } from '../../worker/src/http';

/** Every route plus an unknown path (the not-found view). */
const PATHS = [...ROUTES.map((r) => r.path), '/no-such-page'];
const h1Of = (path: string) => ROUTES.find((r) => r.path === path)?.h1 ?? NOT_FOUND.h1;
const withAt = (path: string, at = REWIND_AT) => `${path}${path.includes('?') ? '&' : '?'}at=${at}`;

/** The banned words of system.md 5.4 (the same list as scripts/copy-lint.ts). */
const BANNED: { word: string; re: RegExp }[] = [
  { word: 'SQS', re: /\bSQS\b/ },
  { word: 'IBC', re: /\bIBC\b/ },
  { word: 'DEX', re: /\bDEX\b/ },
  { word: 'PoS', re: /\bPoS\b/ },
  { word: 'MASP', re: /\bMASP\b/ },
  { word: 'ABCI', re: /\bABCI\b/ },
  { word: 'RPC', re: /\bRPC\b/ },
  { word: 'cron', re: /\bcron\b/i },
  { word: 'webhook', re: /\bwebhooks?\b/i },
  { word: 'npm', re: /\bnpm\b/i },
  { word: 'D1 to D7', re: /\bD[1-7]\b/ },
  { word: 'Loading…', re: /\bLoading(…|\.\.\.)/i },
];
/** Allowlisted places: the "How it is computed" disclosures and Settings "For developers". */
const ALLOW = 'details.how, #developers, .pop, script, style, noscript, template';

/** Wait until the skeletons in main are replaced (soft: a slow source must not hide the other checks). */
async function settled(page: Page, ms = 30_000) {
  await expect(page.locator('main .skel__b, main [aria-busy="true"]')).toHaveCount(0, { timeout: ms }).catch(() => undefined);
  await page.waitForTimeout(400);
}

/** The open dialog fits the window, scrolls inside, and passes the layout audit (G6 with a sheet open). */
async function sheetFits(page: Page, sel = 'dialog[open]') {
  const d = page.locator(sel).last();
  await expect(d).toBeVisible();
  await d.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => undefined))));
  const m = await d.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { h: r.height, top: r.top, bottom: r.bottom, vh: innerHeight, sw: el.scrollWidth, cw: el.clientWidth, oy: getComputedStyle(el).overflowY };
  });
  expect(m.h, 'sheet height within the window').toBeLessThanOrEqual(m.vh + 0.5);
  expect(m.top).toBeGreaterThanOrEqual(-0.5);
  expect(m.sw, 'no sideways scroll inside the sheet').toBeLessThanOrEqual(m.cw + 0.5);
  const a = await layoutAudit(page, sel);
  expect(a.overflowX).toBe(false);
  expect(a.smallText).toEqual([]);
  expect(a.smallTargets).toEqual([]);
}

/** Provenance text (chips, dots, source lines, ages, reasons) is at least 12 px (G6). */
async function smallProvenance(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('.chip, .pdot, .srcb, .num__x')]
      .filter((el) => el.getBoundingClientRect().width > 0)
      .map((el) => ({ px: parseFloat(getComputedStyle(el).fontSize), t: (el.textContent ?? '').trim().slice(0, 30) }))
      .filter((x) => x.px < 12)
      .map((x) => `${x.px}px "${x.t}"`),
  );
}

/** Replace /api/overview with the real answer passed through `edit` (fetched through the proxy). */
async function editOverview(page: Page, edit: (o: Overview) => void) {
  await page.route(/\/api\/overview(\?|$)/, async (route: Route) => {
    try {
      const res = await route.fetch();
      const o = (await res.json()) as Overview;
      edit(o);
      await route.fulfill({ response: res, json: o });
    } catch {
      /* the test ended while a poll was in flight */
    }
  });
}

// ---------------------------------------------------------------------------------------------
// G6: every route in every viewport, live and rewound
// ---------------------------------------------------------------------------------------------
test.describe('G6 every route, every viewport', () => {
  for (const path of PATHS) {
    test(`${path}: live and rewound, the whole page`, async ({ page }) => {
      test.setTimeout(150_000);
      for (const p of [path, withAt(path)]) {
        await gotoRoute(page, p);
        if (p !== path) await expect(page.locator('.rwb')).toBeVisible();
        await settled(page);
        const a = await layoutAudit(page, 'body');
        expect.soft(a.h1, p).toEqual([h1Of(path)]);
        expect.soft(a.overflowX, `${p}: scrollWidth ${a.scrollWidth} > ${a.innerWidth}`).toBe(false);
        expect.soft(a.tables, p).toBe(0);
        expect.soft(a.smallText, p).toEqual([]);
        expect.soft(a.smallTargets, `${p}: ${a.smallTargets.length} of ${a.targetCount} targets under 44 px`).toEqual([]);
        expect.soft(await smallProvenance(page), p).toEqual([]);
      }
    });
  }
});

// ---------------------------------------------------------------------------------------------
// G6: each sheet open, every viewport (Sources, Address and Sign in are also in sheets.spec.ts)
// ---------------------------------------------------------------------------------------------
test.describe('G6 sheets open, every viewport', () => {
  test('search palette, live and rewound', async ({ page }) => {
    for (const p of ['/', withAt('/')]) {
      await gotoRoute(page, p);
      await page.locator('header button[aria-label="Search"]').click();
      await expect(page.locator('dialog.pal')).toBeVisible();
      await sheetFits(page, 'dialog.pal');
      await page.keyboard.press('Escape');
      await expect(page.locator('dialog.pal')).toHaveCount(0);
    }
  });

  test('provenance sheet from the hero chip, and the scope sheet from a source line; live and rewound', async ({ page }) => {
    for (const p of ['/', withAt('/')]) {
      await gotoRoute(page, p);
      await expect(page.locator('.home .hero .chip')).toBeVisible({ timeout: 30_000 });
      await page.locator('.home .hero .chip').click();
      await sheetFits(page);
      await page.keyboard.press('Escape');
      await expect(page.locator('dialog[open]')).toHaveCount(0);
      const line = page.locator('main .srcb').first();
      await expect(line).toBeVisible({ timeout: 30_000 });
      await line.click();
      await sheetFits(page);
      await page.keyboard.press('Escape');
      await expect(page.locator('dialog[open]')).toHaveCount(0);
    }
  });

  test('Sources sheet rewound', async ({ page }) => {
    await gotoRoute(page, withAt('/alerts'));
    await page.locator('.hbtn--status').click();
    await expect(page.locator('dialog.sh-src')).toBeVisible();
    await sheetFits(page, 'dialog.sh-src');
  });

  test('Activity filter sheet (phones and tablets)', async ({ page }) => {
    test.skip((page.viewportSize()?.width ?? 0) >= 1024, 'inline filters from 1024 px');
    await gotoRoute(page, '/activity');
    await settled(page);
    const sheet = page.locator('dialog.act-fsheet');
    for (let i = 0; i < 3 && !(await sheet.isVisible()); i++) {
      await page.locator('.act-filterbtn').click();
      await page.waitForTimeout(300);
    }
    await sheetFits(page, 'dialog.act-fsheet');
  });

  test('Account sheet (signed in, mocked)', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('nt.session', JSON.stringify({ token: 'e2e-test-token', address: 'tnam1qtestaddressfore2eonly000000000000000000000', chain: 'namada', linked: null, via: 'keplr', expiresAt: Date.now() + 10 * 864e5 })));
    await page.route('**/api/me/**', (route) => route.fulfill({ status: 401, json: { error: 'sign in first' } }));
    await page.route('**/api/auth/**', (route) => route.fulfill({ status: 400, json: { error: 'not in this test' } }));
    await gotoRoute(page, '/faq');
    await page.locator('header .ibtn[aria-label^="Account"]').click();
    await expect(page.locator('dialog.sh-acct')).toBeVisible();
    await sheetFits(page, 'dialog.sh-acct');
  });

  test('glossary term popover', async ({ page }) => {
    await gotoRoute(page, '/learn/how-nam-trading-works');
    await settled(page);
    const term = page.locator('main button.term').first();
    await expect(term).toBeVisible();
    await term.click();
    const pop = page.locator('.pop:popover-open, dialog[open]').first();
    await expect(pop).toBeVisible();
    await pop.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished.catch(() => undefined))));
    const m = await pop.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, vw: innerWidth, vh: innerHeight };
    });
    expect(m.left).toBeGreaterThanOrEqual(0);
    expect(m.right).toBeLessThanOrEqual(m.vw + 0.5);
    expect(m.bottom).toBeLessThanOrEqual(m.vh + 0.5);
    const a = await layoutAudit(page, '.pop:popover-open');
    expect(a.smallText).toEqual([]);
    expect(a.smallTargets).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// G4: axe AA on every route; --ink-3 never on a number
// ---------------------------------------------------------------------------------------------
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
// target-size (WCAG 2.2, 24 px) is left to G6, which is stricter (44 px) and counts the ::after hit
// areas the design uses; axe measures the element box only and cannot see them.
const axe = (page: Page) => new AxeBuilder({ page }).withTags(AXE_TAGS).disableRules(['target-size']);
const axeSummary = (r: Awaited<ReturnType<AxeBuilder['analyze']>>) =>
  r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.length} × ${v.nodes.slice(0, 3).map((n) => `${n.target.join(' ')} ${n.failureSummary?.split('\n')[1]?.trim() ?? ''}`).join(' | ')}`);

test.describe('G4 axe AA', () => {
  for (const path of PATHS) {
    test(`${path}: dark live, light live, dark rewound`, async ({ page }, info) => {
      test.skip(!['375x812', '1280x800'].includes(info.project.name), 'axe runs at 375 and 1280');
      test.setTimeout(180_000);
      const runs: [string, boolean, boolean][] = [['dark live', false, false], ['light live', true, false], ['dark rewound', false, true]];
      for (const [name, light, rewound] of runs) {
        if (light && info.project.name !== '375x812') continue;
        await page.addInitScript((l) => { try { localStorage.setItem('nt.theme', l ? 'light' : 'dark'); } catch { /* none */ } }, light);
        await gotoRoute(page, rewound ? withAt(path) : path, { reducedMotion: true });
        await settled(page);
        const r = await axe(page).analyze();
        expect.soft(axeSummary(r), `${path} ${name}`).toEqual([]);
      }
    });
  }

  test('sheets open: Sources, palette, provenance, sign in', async ({ page }, info) => {
    test.skip(!['375x812', '1280x800'].includes(info.project.name), 'axe runs at 375 and 1280');
    await page.route('**/api/auth/**', (route) => route.fulfill({ status: 400, json: { error: 'not in this test' } }));
    await gotoRoute(page, '/', { reducedMotion: true });
    await settled(page);
    const opens: [string, () => Promise<void>][] = [
      ['Sources', async () => { await expect(page.locator('.hbtn--status .hbtn__wait')).toHaveCount(0, { timeout: 30_000 }); await page.locator('.hbtn--status').click(); }],
      ['palette', () => page.locator('header button[aria-label="Search"]').click()],
      ['provenance', () => page.locator('.home .hero .chip').click()],
      ['sign in', () => page.locator('header .ibtn[aria-label^="Account"]').click()],
    ];
    for (const [name, open] of opens) {
      await open();
      await expect(page.locator('dialog[open]')).toBeVisible();
      await page.waitForTimeout(300);
      const r = await axe(page).include('dialog[open]').analyze();
      expect.soft(axeSummary(r), name).toEqual([]);
      await page.keyboard.press('Escape');
      await expect(page.locator('dialog[open]')).toHaveCount(0);
    }
  });

  test('--ink-3 is never the colour of a number, on any route, either theme', async ({ page }, info) => {
    test.skip(onlyIn(info.project.name), 'runs once');
    test.setTimeout(240_000);
    for (const light of [false, true]) {
      await page.addInitScript((l) => { try { localStorage.setItem('nt.theme', l ? 'light' : 'dark'); } catch { /* none */ } }, light);
      for (const path of PATHS) {
        await gotoRoute(page, path, { reducedMotion: true });
        await settled(page);
        const bad = await page.evaluate(() => {
          const out: string[] = [];
          for (const n of document.querySelectorAll('[data-num]')) {
            if (!n.getBoundingClientRect().width || !n.parentElement) continue;
            const probe = document.createElement('span');
            probe.style.color = 'var(--c-ink-3)';
            n.parentElement.appendChild(probe);
            const ink3 = getComputedStyle(probe).color;
            probe.remove();
            if (getComputedStyle(n).color === ink3) out.push((n.textContent ?? '').trim().slice(0, 30));
          }
          return out;
        });
        expect.soft(bad, `${light ? 'light' : 'dark'} ${path}`).toEqual([]);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------
// G5: the rendered copy lint, Home reading grade, sentence case
// ---------------------------------------------------------------------------------------------
/** Visible words and the accessible names of a subtree, minus the allowlisted places. */
async function renderedText(page: Page, root = 'body'): Promise<string> {
  return page.evaluate(([sel, allow]) => {
    const parts: string[] = [];
    for (const r of document.querySelectorAll(sel)) {
      const c = r.cloneNode(true) as HTMLElement;
      c.querySelectorAll(allow).forEach((x) => x.remove());
      parts.push(c.textContent ?? '');
      for (const el of c.querySelectorAll('[aria-label], [title], [placeholder], [alt], [aria-description]')) {
        for (const a of ['aria-label', 'title', 'placeholder', 'alt', 'aria-description']) {
          const v = el.getAttribute(a);
          if (v) parts.push(v);
        }
      }
    }
    return parts.join('\n');
  }, [root, ALLOW] as const);
}
const findBanned = (text: string) => BANNED.filter((b) => b.re.test(text)).map((b) => `${b.word}: "${(text.match(b.re) ? text.slice(Math.max(0, text.search(b.re) - 40), text.search(b.re) + 40) : '').replace(/\s+/g, ' ')}"`);

/** Words that keep a capital inside a sentence-case heading. */
const MONTHS = new Set(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
const PROPER = new Set(['Ethereum', 'Google', 'Cloudflare', 'NAM', 'Namada', 'Osmosis', 'USDC', 'UTC', 'Discord', 'Keplr', 'Keychain', 'Anoma', 'Foundation', 'Heliax', 'API', 'CSV', 'QR', 'I', 'NamadaTrade', 'Namada’s', "Namada's", 'Osmosis’s']);

test.describe('G5 copy, rendered', () => {
  test.beforeEach(({}, info) => test.skip(onlyIn(info.project.name), 'runs once'));

  test('no banned word in the rendered text of any route, live or rewound, or in the open sheets', async ({ page }) => {
    test.setTimeout(240_000);
    await page.route('**/api/auth/**', (route) => route.fulfill({ status: 400, json: { error: 'not in this test' } }));
    for (const path of PATHS) {
      for (const p of [path, withAt(path)]) {
        await gotoRoute(page, p);
        await settled(page);
        expect.soft(findBanned(await renderedText(page)), p).toEqual([]);
      }
    }
    await gotoRoute(page, '/');
    await settled(page);
    const opens: [string, () => Promise<void>][] = [
      ['Sources', async () => { await expect(page.locator('.hbtn--status .hbtn__wait')).toHaveCount(0, { timeout: 30_000 }); await page.locator('.hbtn--status').click(); }],
      ['palette', () => page.locator('header button[aria-label="Search"]').click()],
      ['provenance', () => page.locator('.home .hero .chip').click()],
      ['scope', () => page.locator('main .srcb').first().click()],
      ['sign in', () => page.locator('header .ibtn[aria-label^="Account"]').click()],
    ];
    for (const [name, open] of opens) {
      await open();
      await expect(page.locator('dialog[open]')).toBeVisible();
      expect(findBanned(await renderedText(page, 'dialog[open]')), name).toEqual([]);
      await page.keyboard.press('Escape');
      await expect(page.locator('dialog[open]')).toHaveCount(0);
    }
  });

  test('Home copy reads at grade 8 or below (Flesch-Kincaid)', async ({ page }) => {
    await gotoRoute(page, '/');
    await settled(page);
    const prose = await page.evaluate(() => [...document.querySelectorAll('main p')].filter((e) => e.getBoundingClientRect().width > 0 && !e.closest('.src, .srcb, .facts, .tape, .dl, .lg, [role="table"]')).map((e) => (e.textContent ?? '').trim()).filter((t) => /[a-z]{3}/.test(t)));
    const text = prose.join('. ');
    const words = text.split(/\s+/).filter((w) => /[A-Za-z]/.test(w));
    const sentences = Math.max(1, (text.match(/[.!?](\s|$)/g) ?? []).length);
    const syl = (w: string) => {
      const s = w.toLowerCase().replace(/[^a-z]/g, '');
      if (s.length <= 3) return 1;
      const m = s.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '').match(/[aeiouy]{1,2}/g);
      return Math.max(1, m ? m.length : 1);
    };
    const syllables = words.reduce((n, w) => n + syl(w), 0);
    const grade = 0.39 * (words.length / sentences) + 11.8 * (syllables / words.length) - 15.59;
    console.log(`G5 Home reading grade ${grade.toFixed(1)} (${words.length} words, ${sentences} sentences)`);
    expect(grade).toBeLessThanOrEqual(8);
  });

  test('sentence case: headings, buttons and tabs capitalise only the first word and names', async ({ page }) => {
    test.setTimeout(180_000);
    const out: string[] = [];
    for (const path of PATHS) {
      await gotoRoute(page, path);
      await settled(page);
      const items = await page.evaluate(() =>
        [...document.querySelectorAll('main h2, main h3, main button, main [role="tab"], main legend, header button, nav a, footer a')]
          // names of addresses and the wordmark are names, not sentences
          .filter((e) => e.getBoundingClientRect().width > 0 && !e.closest('.xaddr, .tx__addr, .hrow__name, .brand, .act-name, [data-name]'))
          // each text node is its own phrase (a page link is a name, then a question; a row is a label, then a value)
          .flatMap((e) => {
            const out: string[] = [];
            const w = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
            while (w.nextNode()) {
              const t = (w.currentNode.textContent ?? '').replace(/\s+/g, ' ').trim();
              if (t && /[a-z]/.test(t) && (w.currentNode.parentElement?.getBoundingClientRect().width ?? 0) > 0) out.push(t);
            }
            return out;
          }),
      );
      for (const t of items) {
        // each "·", ":" or "," part is its own phrase (a source line lists names: "Flow index, Derived")
        for (const seg of t.split(/\s*[·:,(]\s*|\s+\n\s*/)) {
          const words = seg.split(/[\s/–—]+/).filter(Boolean).slice(1);
          const caps = words.filter((w) => {
            const bare = w.replace(/[.?!)’'"]+$/, '').replace(/[’']s$/, '');
            return /^[A-Z][a-z]/.test(bare) && !PROPER.has(bare) && !MONTHS.has(bare.slice(0, 3));
          });
          if (caps.length) out.push(`${path}: "${t.slice(0, 60)}" (${caps.join(', ')})`);
        }
      }
    }
    expect([...new Set(out)]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// G7: motion and layout shift
// ---------------------------------------------------------------------------------------------
const CLS_SCRIPT = () => {
  const w = window as unknown as { __cls: number; __shifts: string[] };
  w.__cls = 0;
  w.__shifts = [];
  new PerformanceObserver((list) => {
    for (const e of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean; sources?: { node?: Node }[] })[]) {
      if (e.hadRecentInput) continue;
      w.__cls += e.value;
      const n = e.sources?.[0]?.node as Element | undefined;
      w.__shifts.push(`${e.value.toFixed(4)} ${n?.nodeName ?? '?'}.${(n as Element | undefined)?.className?.toString().slice(0, 40) ?? ''}`);
    }
  }).observe({ type: 'layout-shift', buffered: true });
};

test.describe('G7 motion', () => {
  test('reduced motion: document.getAnimations() is empty on every route, live and with the palette open', async ({ page }, info) => {
    test.skip(!['375x812', '1280x800'].includes(info.project.name), 'runs at 375 and 1280');
    test.setTimeout(240_000);
    for (const path of PATHS) {
      await gotoRoute(page, path, { reducedMotion: true });
      await settled(page);
      await page.waitForTimeout(600);
      expect(await page.evaluate(() => document.getAnimations().map((a) => `${(a as CSSAnimation).animationName ?? a.constructor.name} on ${((a.effect as KeyframeEffect | null)?.target as Element | null)?.className ?? '?'}`)), path).toEqual([]);
    }
    await page.locator('header button[aria-label="Search"]').click();
    await expect(page.locator('dialog.pal')).toBeVisible();
    expect(await animationsIn(page, 'body')).toBe(0);
  });

  for (const delay of [0, 1500]) {
    test(`layout shift under 0.1 on every route${delay ? `, with every /api answer held ${delay} ms` : ''}`, async ({ page }, info) => {
      test.skip(!['375x812', '1280x800'].includes(info.project.name), 'runs at 375 and 1280');
      test.setTimeout(300_000);
      if (delay) await page.route(/\/api\//, async (route) => { await new Promise((r) => setTimeout(r, delay)); await route.continue(); });
      await page.addInitScript(CLS_SCRIPT);
      const bad: string[] = [];
      for (const path of PATHS) {
        await gotoRoute(page, path);
        await settled(page);
        await page.waitForTimeout(1200);
        const r = await page.evaluate(() => {
          const w = window as unknown as { __cls: number; __shifts: string[] };
          return { __cls: w.__cls ?? 0, __shifts: w.__shifts ?? [] };
        });
        console.log(`G7 CLS ${info.project.name} ${path}${delay ? ` (held ${delay} ms)` : ''}: ${r.__cls.toFixed(4)} ${r.__shifts.slice(0, 4).join('; ')}`);
        if (r.__cls >= 0.1) bad.push(`${path}: ${r.__cls.toFixed(3)} (${r.__shifts.slice(0, 4).join('; ')})`);
      }
      expect(bad).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------------------------
// G9: tabular figures in the self-hosted font
// ---------------------------------------------------------------------------------------------
test('G9 tabular figures: 1, 0 and 8 are one width at 48 px in Space Grotesk; the hero price uses them', async ({ page }, info) => {
  test.skip(onlyIn(info.project.name), 'runs once');
  await gotoRoute(page, '/');
  await expect(page.locator('.home .hero .hero-n__v [data-num]')).toBeVisible({ timeout: 30_000 });
  const r = await page.evaluate(async () => {
    await document.fonts.load('500 48px "Space Grotesk Variable"');
    await document.fonts.ready;
    const w = (ch: string) => {
      const s = document.createElement('span');
      s.textContent = ch;
      s.style.cssText = 'position:absolute;left:-9999px;font:500 48px "Space Grotesk Variable";font-variant-numeric:tabular-nums;white-space:pre';
      document.body.appendChild(s);
      const x = s.getBoundingClientRect().width;
      s.remove();
      return x;
    };
    const hero = document.querySelector('.home .hero .hero-n__v') as HTMLElement;
    const cs = getComputedStyle(hero);
    return { one: w('1'), zero: w('0'), eight: w('8'), loaded: document.fonts.check('500 48px "Space Grotesk Variable"'), heroFamily: cs.fontFamily, heroNumeric: cs.fontVariantNumeric, heroFeatures: cs.fontFeatureSettings };
  });
  console.log(`G9 tnum at 48 px: 1=${r.one.toFixed(2)} 0=${r.zero.toFixed(2)} 8=${r.eight.toFixed(2)}; hero ${r.heroFamily} / ${r.heroNumeric} / ${r.heroFeatures}`);
  expect(r.loaded).toBe(true);
  expect(Math.abs(r.one - r.zero)).toBeLessThan(0.01);
  expect(Math.abs(r.eight - r.zero)).toBeLessThan(0.01);
  expect(r.heroFamily).toContain('Space Grotesk');
  expect(`${r.heroNumeric} ${r.heroFeatures}`).toMatch(/tabular-nums|"tnum"/);
});

// ---------------------------------------------------------------------------------------------
// G10: N1 to N4 and N9
// ---------------------------------------------------------------------------------------------
test.describe('G10 data honesty', () => {
  test('N1: each status of the price stamp has its own look, words and age (mocked overview)', async ({ page }, info) => {
    test.skip(onlyIn(info.project.name), 'runs once');
    const hero = page.locator('.home .hero .hero-n__v [data-num]');
    const chip = page.locator('.home .hero .chip');
    const cases: { status: 'stale' | 'missing' | 'conflict'; ui: string; deco: string; chipWord: RegExp }[] = [
      { status: 'stale', ui: 'old', deco: 'dotted', chipWord: /old 3\.\d\sh/ },
      { status: 'conflict', ui: 'disagree', deco: 'wavy', chipWord: /disagree/ },
      { status: 'missing', ui: 'none', deco: 'dashed', chipWord: /no data/ },
    ];
    for (const c of cases) {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await editOverview(page, (o) => {
        o.price.usd.prov = { ...o.price.usd.prov, status: c.status, at: o.generatedAt - 3.2 * 3_600_000, note: c.status === 'missing' ? 'e2e: the router gave no price' : o.price.usd.prov.note };
        if (c.status === 'missing') (o.price.usd as { value: number | null }).value = null;
      });
      await gotoRoute(page, '/');
      await expect(hero).toBeVisible({ timeout: 30_000 });
      await expect(hero).toHaveAttribute('data-status', c.ui);
      await expect(chip).toContainText(c.chipWord);
      const deco = await hero.evaluate((el) => {
        const v = el.querySelector('.num__v') ?? el;
        return getComputedStyle(v).textDecorationStyle + ' ' + getComputedStyle(el).textDecorationStyle;
      });
      expect(deco, c.status).toContain(c.deco);
      if (c.status === 'missing') {
        await expect(hero).toHaveText('—');
        // the reason is in view without hover
        await expect(page.locator('.home .hero').getByText('e2e: the router gave no price').first()).toBeVisible();
      }
      // the header price follows the same stamp
      await expect(page.locator('.hprice [data-num]').first()).toHaveAttribute('data-status', c.ui);
    }
  });

  for (const vp of ['375x812', '1280x800']) {
    test(`N1 (${vp}): every visible figure on every route has its own control or a visible SourceLine that lists its scope`, async ({ page }, info) => {
      test.skip(info.project.name !== vp, `runs in ${vp}`);
      test.setTimeout(240_000);
      for (const path of PATHS) {
        for (const p of [path, withAt(path)]) {
          await gotoRoute(page, p);
          await settled(page);
          const orphans = await page.evaluate(() => {
            const seen = (el: Element | null | undefined) => !!el && (el as HTMLElement).getBoundingClientRect().width > 0 && getComputedStyle(el).visibility !== 'hidden';
            const out: string[] = [];
            for (const n of document.querySelectorAll('body [data-num]')) {
              if (!seen(n) || n.closest('dialog')) continue;
              // its own control: in its .num, its [data-prov-group], or the group a [data-prov-ref] names
              // (a sentence that repeats a figure stamped right above it); the header price is itself a stamp button
              const ref = (n.closest('[data-prov-ref]') as HTMLElement | null)?.dataset.provRef;
              const groups = [n.closest('.num'), n.closest('[data-prov-group]'), n.closest('.hero-n'), ref ? document.getElementById(ref) : null];
              const own = groups.some((g) => g && [...g.querySelectorAll('[data-prov]')].some(seen)) || !!n.closest('button.hprice');
              if (own) continue;
              let ok = false;
              for (let s = n.closest('[data-prov-scope]'); s && !ok; s = s.parentElement?.closest('[data-prov-scope]') ?? null) {
                ok = [...s.querySelectorAll('.srcb')].some((b) => seen(b) && !!(b as HTMLElement).dataset.scope);
              }
              if (!ok) out.push(`${(n.textContent ?? '').trim().slice(0, 24)} in ${(n.closest('section, aside, header, footer') as HTMLElement | null)?.className?.toString().slice(0, 40) ?? '?'}`);
            }
            return out;
          });
          expect.soft(orphans, p).toEqual([]);
        }
      }
    });
  }

  test('N2: an odd-value fixture is exactly what Home and the header print', async ({ page }, info) => {
    test.skip(onlyIn(info.project.name), 'runs once');
    const PRICE = 0.00137913;
    const HOLDERS = 2357;
    await editOverview(page, (o) => {
      o.price.usd.value = PRICE;
      o.price.change24h = 3.1415;
      o.namada.holders = HOLDERS;
    });
    await gotoRoute(page, '/');
    const hero = page.locator('.home .hero');
    await expect(hero.locator('.hero-n__v [data-num]')).toBeVisible({ timeout: 30_000 });
    await expect(hero.locator('.hero-n__v [data-num]')).toHaveText('$0.001379');
    await expect(hero).toContainText('+3.14%');
    await expect(hero.locator('.facts')).toContainText('2,357');
    await expect(page.locator('.hprice')).toContainText('0.001379');
  });

  test('N3: every route rewound at 375: no overflow, the banner, every /api request carries at= except the exempt list, links keep at=', async ({ page, baseURL }, info) => {
    test.skip(onlyIn(info.project.name), 'runs once');
    test.setTimeout(240_000);
    for (const path of PATHS) {
      const reqs = trackRequests(page);
      await gotoRoute(page, withAt(path));
      await expect(page.locator('.rwb')).toBeVisible();
      await settled(page);
      await page.waitForTimeout(800);
      for (const u of apiUrls(reqs, baseURL!)) {
        if (isExempt(u.pathname)) continue;
        expect.soft(isLiveOnly(u.pathname), `${path}: live-only call while rewound: ${u.pathname}`).toBe(false);
        expect.soft(u.searchParams.get('at'), `${path}: ${u.pathname}${u.search}`).toBe(String(REWIND_AT));
      }
      const a = await layoutAudit(page, 'body');
      expect.soft(a.overflowX, path).toBe(false);
      await expect(page.locator('.hbtn--rewind')).toBeHidden();
      const links = await page.evaluate(() => [...document.querySelectorAll('nav.tabbar a[href], header a[href], footer a[href], main a[href^="/"]')].map((a) => a.getAttribute('href') ?? '').filter((h) => h.startsWith('/') && !h.startsWith('/api/') && !h.startsWith('//')));
      // a link may rewind to another moment (the Home example); it never drops the rewound state
      for (const h of links) expect.soft(new URL(h, 'http://x').searchParams.get('at'), `${path}: link ${h}`).toMatch(/^\d{13}$/);
      page.removeAllListeners('request');
    }
  });

  test('N4: data-decision sets per view; no bare D1 to D7 in visible text', async ({ page }, info) => {
    test.skip(onlyIn(info.project.name), 'runs once');
    const WANT: Record<string, string[]> = { '/trade': ['D1'], '/supply': ['D2', 'D3', 'D4'], '/shielded': ['D5'], '/alerts': ['D7'] };
    for (const path of PATHS) {
      await gotoRoute(page, path);
      await settled(page);
      const got = await page.evaluate(() => [...new Set([...document.querySelectorAll('main [data-decision]')].map((e) => e.getAttribute('data-decision')))].sort());
      const want = [...(WANT[path] ?? [])];
      // Votes (D3) shows only when a proposal is open; Unstaking carries D3 too, so the set is complete.
      expect.soft(got, path).toEqual(want);
      const text = await page.evaluate(() => document.body.innerText);
      expect.soft(text, path).not.toMatch(/\bD[1-7]\b/);
    }
    await page.locator('.hbtn--status').click();
    await expect(page.locator('dialog.sh-src [data-decision="D6"]')).toHaveCount(1);
  });

  test('N9: every route requests only same-origin /api, /ws and assets; fonts are self-hosted', async ({ page, baseURL }, info) => {
    test.skip(onlyIn(info.project.name), 'runs once');
    test.setTimeout(180_000);
    const reqs = trackRequests(page);
    for (const path of PATHS) {
      await gotoRoute(page, path);
      await settled(page);
    }
    const urls = reqs.map((r) => r.url()).filter((u) => !u.startsWith('data:') && !u.startsWith('blob:'));
    expect(urls.filter((u) => !u.startsWith(baseURL!))).toEqual([]);
    // dev-server module paths (/src, /@vite, /node_modules, /@react-refresh, /@fs) stand in for the built /assets
    const allowed = /^\/(api\/|ws(\?|$)|assets\/|src\/|@vite\/|@react-refresh|@fs\/|@id\/|node_modules\/|fonts\/|favicon\.svg|icon[\w-]*\.(png|svg)|apple-touch-icon\.png|manifest\.webmanifest|og\.png|$)/;
    const pages = new Set(PATHS);
    const odd = reqs
      .filter((r) => !r.url().startsWith('data:') && !r.url().startsWith('blob:'))
      .map((r) => ({ u: new URL(r.url()), doc: r.resourceType() === 'document' }))
      .filter(({ u, doc }) => !allowed.test(u.pathname) && !(doc && pages.has(u.pathname)))
      .map(({ u }) => u.pathname);
    expect([...new Set(odd)]).toEqual([]);
    const fonts = reqs.filter((r) => r.resourceType() === 'font').map((r) => r.url());
    expect(fonts.length).toBeGreaterThan(0);
    for (const f of fonts) expect(f.startsWith(baseURL!), f).toBe(true);
  });

  // The page policy the Worker sends (worker/src/http.ts pagePolicies), enforced here: Vite sends none, so each
  // document is fetched, its inline scripts hashed exactly as the Worker does, and the policy set as an enforced
  // Content-Security-Policy header. Any violation (a script, style, font, image or request the policy would block
  // once ENFORCE_SCRIPT_POLICY is flipped) fails the gate.
  test('CSP: the page policy, enforced, blocks nothing on any route', async ({ page }, info) => {
    test.skip(onlyIn(info.project.name), 'runs once');
    test.setTimeout(180_000);
    await page.addInitScript(() => {
      const w = window as unknown as { __csp?: string[] };
      document.addEventListener('securitypolicyviolation', (e) => (w.__csp ||= []).push(`${e.violatedDirective} ${e.blockedURI}`));
    });
    await page.route('**/*', async (route) => {
      if (route.request().resourceType() !== 'document') return route.fallback();
      const res = await route.fetch();
      const html = await res.text();
      const policy = pagePolicies(await inlineScriptHashes(html), new URL(route.request().url())).scripts;
      return route.fulfill({ response: res, body: html, headers: { ...res.headers(), 'content-security-policy': policy } });
    });
    for (const path of ['/', '/trade', '/supply', '/shielded', '/activity', '/holders', '/alerts', '/settings', '/staking', '/faq', '/nope']) {
      await gotoRoute(page, path);
      await settled(page);
      const v = await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []);
      expect(v, `${path}: blocked by the page policy`).toEqual([]);
    }
  });

  // A genesis label ("Public sale allocation (genesis)") is shared by thousands of addresses: a row that names one
  // prints its short address too, or a seller reads as the largest holder. A protocol account's name stays alone.
  for (const vp of ['375x812', '1280x800']) {
    test(`a shared label carries its short address in the transaction rows (${vp}); a protocol account's name does not`, async ({ page }, info) => {
      test.skip(info.project.name !== vp, `runs in ${vp}`);
      const SELLER = 'tnam1qrt5tarfixturesellerxxxxxxxxxxxxxxxx7k2vd';
      const POS = 'tnam1qgqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqc8j2fp';
      await page.route(/\/api\/flows\?/, async (route) => {
        // the live feed's seed can still be in flight when the test ends: its fetch then fails, which is not an error
        const res = await route.fetch().catch(() => null);
        if (!res) return;
        const j = await res.json();
        if (Array.isArray(j.flows) && j.flows.length) {
          j.flows[0] = {
            ...j.flows[0], chain: 'namada', kind: 'bond', amount: 25_000, poolId: null,
            from: SELLER, fromLabel: 'Genesis: public_allocations_completed', fromLabelPlain: 'Public sale allocation (genesis)',
            to: POS, toLabel: null, toLabelPlain: 'Staking account (staked and unstaking NAM)',
          };
        }
        await route.fulfill({ response: res, json: j }).catch(() => undefined);
      });
      await gotoRoute(page, '/activity');
      const row = page.locator('main .tx').filter({ hasText: 'Public sale allocation (genesis)' }).first();
      await expect(row).toBeVisible({ timeout: 30_000 });
      // right after the seller's name, and only there (not after "Staking account"); phone rows print the shorter
      // form, the table the usual one (fmtAddr)
      await expect(row.locator('.tx__la')).toHaveCount(1);
      const la = row.locator('.tx__addr:has-text("Public sale allocation (genesis)") + .tx__la');
      const [shown, short] = vp === '375x812' ? ['.tx__as', `${SELLER.slice(0, 8)}…${SELLER.slice(-4)}`] : ['.tx__al', `${SELLER.slice(0, 10)}…${SELLER.slice(-5)}`];
      await expect(la.locator(shown)).toBeVisible();
      await expect(la.locator(shown)).toHaveText(short);
      const a = await layoutAudit(page, 'main');
      expect(a.overflowX, `scrollWidth ${a.scrollWidth} > ${a.innerWidth}`).toBe(false);
      expect(a.smallTargets).toEqual([]);
    });
  }
});

// BODY sentences visible on every route that has them (seo-requirements 3; the per-screen specs check their own).
test('SEO: every BODY paragraph and section heading is visible text on its route', async ({ page }, info) => {
  test.skip(onlyIn(info.project.name), 'runs once');
  test.setTimeout(180_000);
  for (const r of ROUTES) {
    const copy = BODY[r.id];
    if (!copy) continue;
    await gotoRoute(page, r.path);
    await settled(page);
    const text = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
    for (const para of copy.paras) expect(text, `${r.path}: "${para.slice(0, 50)}…"`).toContain(para.replace(/\s+/g, ' '));
    for (const s of copy.sections ?? []) {
      await expect(page.locator('main').getByRole('heading', { name: s.h2, exact: true }), `${r.path}: ${s.h2}`).toBeVisible();
      for (const para of s.paras) expect(text, `${r.path}: "${para.slice(0, 50)}…"`).toContain(para.replace(/\s+/g, ' '));
    }
  }
});

// ---------------------------------------------------------------------------------------------
// Search gates (F1, nav-search-plan 6): G4, G5, G6 and G7 with search open on a typed term (the grouped answer of nav
// step 5 mocked in the shared/types.ts SearchResponse shape, as production does not send it yet) and the Keys sheet.
// ---------------------------------------------------------------------------------------------
const SEARCH_MOCK: SearchResponse = {
  asOf: REWIND_AT,
  groups: [{ group: 'addresses', n: 1, more: false }, { group: 'records', n: 1, more: false }, { group: 'names', n: 1, more: false }],
  results: [
    { type: 'address', group: 'addresses', kind: 'address', match: 'start', chain: 'namada', value: 'tnam1qzondx8kq3m5wyc0e4u0u3t9yd2r4a9p7hk2j4mq', title: 'tnam1qzondx8kq3m5wyc0e4u0u3t9yd2r4a9p7hk2j4mq', subtitle: 'Namada address · staked 1.2 million NAM', stamp: null },
    { type: 'tx', group: 'records', kind: 'record', match: 'start', chain: 'osmosis', value: 'ZOND1234ABCD', title: 'Sell, 12,345 NAM', subtitle: 'Block 8,294,006 on Osmosis', href: '/activity?q=ZOND1234ABCD', external: null, stamp: null },
    { type: 'validator', group: 'names', kind: 'validator', match: 'word', chain: 'namada', value: 'tnam1q9zond7xvaw5cq3ldc9pzk4nvlq8ftx3e6j2hwmr', title: 'Zondax', subtitle: 'Validator · Namada address', label: 'Zondax', label_plain: 'Zondax', category_plain: 'Validator', stamp: null },
  ],
};

/** Open search on "zond sell >100k" (server groups, a Lists row, views and actions), settled. */
async function searchOpenTyped(page: Page) {
  await page.route(/\/api\/search/, (r) => r.fulfill({ json: SEARCH_MOCK }));
  await page.locator('header button[aria-label="Search"]').click();
  await expect(page.getByRole('combobox')).toBeFocused();
  await page.getByRole('combobox').fill('zond sell >100k');
  await expect(page.locator('dialog.pal [role="status"]')).toHaveText(/results? in \d+ groups?/, { timeout: 5000 });
}
/** Open the Keys sheet with "?" from the page. */
async function keysOpen(page: Page) {
  await page.locator('main h1').click();
  await page.keyboard.press('?');
  await expect(page.locator('dialog.sh-keys[open]')).toBeVisible();
}

test.describe('search gates', () => {
  test('G6: search on a typed term and the Keys sheet fit every viewport, live and rewound', async ({ page }) => {
    for (const p of ['/faq', withAt('/faq')]) {
      await gotoRoute(page, p);
      await searchOpenTyped(page);
      await sheetFits(page, 'dialog.pal');
      await page.keyboard.press('Escape');
      await expect(page.locator('dialog.pal')).toHaveCount(0);
      await keysOpen(page);
      await sheetFits(page, 'dialog.sh-keys');
      await page.keyboard.press('Escape');
      await expect(page.locator('dialog.sheet')).toHaveCount(0);
    }
  });

  test('G4: axe AA with search open on a typed term, and on the Keys sheet (dark and light)', async ({ page }, info) => {
    test.skip(!['375x812', '1280x800'].includes(info.project.name), 'axe runs at 375 and 1280');
    for (const light of [false, true]) {
      await page.addInitScript((l) => { try { localStorage.setItem('nt.theme', l ? 'light' : 'dark'); } catch { /* none */ } }, light);
      await gotoRoute(page, '/faq', { reducedMotion: true });
      await settled(page);
      await searchOpenTyped(page);
      const r = await axe(page).include('dialog.pal').analyze();
      expect.soft(axeSummary(r), `search typed ${light ? 'light' : 'dark'}`).toEqual([]);
      // a scope chip in the input
      await page.getByRole('combobox').fill('@zond');
      await page.keyboard.press('Tab');
      await expect(page.locator('.pal__scope')).toBeVisible();
      const r2 = await axe(page).include('dialog.pal').analyze();
      expect.soft(axeSummary(r2), `search scoped ${light ? 'light' : 'dark'}`).toEqual([]);
      await page.keyboard.press('Escape');
      await keysOpen(page);
      const r3 = await axe(page).include('dialog.sh-keys').analyze();
      expect.soft(axeSummary(r3), `keys ${light ? 'light' : 'dark'}`).toEqual([]);
      await page.keyboard.press('Escape');
      await expect(page.locator('dialog.sheet')).toHaveCount(0);
    }
  });

  test('G5: no banned word and sentence case in search on a typed term and in the Keys sheet', async ({ page }, info) => {
    test.skip(onlyIn(info.project.name), 'runs once');
    await gotoRoute(page, '/faq');
    await searchOpenTyped(page);
    expect(findBanned(await renderedText(page, 'dialog.pal'))).toEqual([]);
    const caps = await page.evaluate(() =>
      [...document.querySelectorAll('dialog.pal .pal__gh, dialog.pal .pal__l, dialog.pal button, dialog.pal .pal__note, dialog.pal [role="status"]')]
        .map((e) => (e.textContent ?? '').trim())
        .filter(Boolean),
    );
    // headings are caps by style only (their text is sentence case); words after the first are lower case but names
    for (const t of caps)
      for (const seg of t.split(/\s*[·:,(]\s*/)) {
        const bad = seg.split(/\s+/).slice(1).filter((w) => /^[A-Z][a-z]/.test(w) && !PROPER.has(w.replace(/[.?!)’'"]+$/, '')) && !MONTHS.has(w.slice(0, 3)) && !/^(Zondax|Sell)$/.test(w));
        expect(bad, t).toEqual([]);
      }
    await page.keyboard.press('Escape');
    await keysOpen(page);
    expect(findBanned(await renderedText(page, 'dialog.sh-keys'))).toEqual([]);
  });

  test('G7: no animation with search open on a typed term or with the Keys sheet, under reduced motion', async ({ page }, info) => {
    test.skip(!['375x812', '1280x800'].includes(info.project.name), 'runs at 375 and 1280');
    await gotoRoute(page, '/faq', { reducedMotion: true });
    await searchOpenTyped(page);
    const running = () => page.evaluate(() => document.getAnimations().map((a) => `${(a as CSSAnimation).animationName ?? a.constructor.name} on ${((a.effect as KeyframeEffect | null)?.target as Element | null)?.className ?? '?'}`));
    expect(await running()).toEqual([]);
    await page.keyboard.press('Escape');
    await keysOpen(page);
    // the sheet's scrim too: tokens.css's reduced-motion rule covers ::backdrop
    expect(await running()).toEqual([]);
  });
});
