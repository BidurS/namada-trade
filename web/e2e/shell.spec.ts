// The shell (F1): header, tab bar, footer, router, Rewind, keys, palette, theme, fonts.
// Viewport-independent checks run once (in the 375x812 project); layout checks run in every
// project of the G6 matrix plus a 320 px smoke.
//
// Search (nav-search-plan 3.1, 3.3, 3.6, 4.4, 4.6, 4.7): production answers /api/search in the first build's shape
// (no `group`), so the grouped answer of nav step 5 is mocked here exactly as shared/types.ts SearchResponse says
// (SEARCH_ANSWER), and the first-build shape is tested as the fallback path.
import type { Page, Request, Route } from '@playwright/test';
import { NOT_FOUND } from '../../shared/copy';
import { ROUTES, TABS } from '../../shared/routes';
import type { SearchResponse, SearchResult } from '../../shared/types';
import { REWIND_AT, SMOKE_320, animationsIn, apiUrls, expect, gotoRoute, isExempt, isLiveOnly, layoutAudit, onlyIn, test, trackRequests } from './helpers';

const SHELL = 'header.hdr, nav.tabbar, footer.foot, .rwb';
/** A route whose body is plain text, so the layout audit measures the shell itself. */
const PLAIN = '/faq';

test.describe('layout, every viewport', () => {
  test('header, tab bar and footer: no overflow, 44 px targets, text at least 11 px', async ({ page }) => {
    await gotoRoute(page, PLAIN);
    await expect(page.locator('.hprice__v[data-num]')).toBeVisible({ timeout: 30_000 });
    const a = await layoutAudit(page, SHELL);
    expect(a.overflowX, `scrollWidth ${a.scrollWidth} > ${a.innerWidth}`).toBe(false);
    expect(a.smallTargets).toEqual([]);
    expect(a.smallText).toEqual([]);
    expect(a.tables).toBe(0);
  });

  test('rewound: banner, no overflow, header Rewind only from 1024 px', async ({ page }) => {
    await gotoRoute(page, `${PLAIN}?at=${REWIND_AT}`);
    await expect(page.locator('.rwb')).toBeVisible();
    const a = await layoutAudit(page, SHELL);
    expect(a.overflowX).toBe(false);
    expect(a.smallTargets).toEqual([]);
    const wide = (page.viewportSize()?.width ?? 0) >= 1024;
    await expect(page.locator('.hbtn--rewind')).toBeVisible({ visible: wide });
  });
});

test.describe('header search, every viewport', () => {
  test('a field-shaped button with the words or "Search" and the "/" hint from 1024 px; the 44 px icon below', async ({ page }) => {
    await gotoRoute(page, PLAIN);
    await expect(page.locator('.hprice__v[data-num]')).toBeVisible({ timeout: 30_000 });
    const b = page.locator('header button[aria-label="Search"]');
    await expect(b).toHaveAttribute('aria-keyshortcuts', '/ Control+K Meta+K');
    const box = (await b.boundingBox())!;
    const width = page.viewportSize()!.width;
    const fine = await page.evaluate(() => matchMedia('(pointer: fine)').matches);
    if (width >= 1024) {
      expect(box.width, 'the field takes the room the header has').toBeGreaterThan(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
      await expect(b.locator('.hsearch__k')).toBeVisible({ visible: fine });
    } else {
      expect(Math.round(box.width)).toBe(44);
      await expect(b.locator('.hsearch__t')).toBeHidden();
      await expect(b.locator('.hsearch__w')).toBeHidden();
      await expect(b.locator('.hsearch__k')).toBeHidden();
    }
    const a = await layoutAudit(page, 'header.hdr');
    expect(a.overflowX).toBe(false);
    expect(a.smallTargets).toEqual([]);
    expect(a.smallText).toEqual([]);
  });
});

test.describe('header search at the desktop widths', () => {
  for (const width of [1024, 1100, 1199, 1200, 1280, 1440]) {
    test(`${width}: the row fits and the field says what fits`, async ({ page }, info) => {
      test.skip(onlyIn(info.project.name, '1280x800'), 'one desktop project');
      await page.setViewportSize({ width, height: 600 });
      await gotoRoute(page, PLAIN);
      await expect(page.locator('.hprice__v[data-num]')).toBeVisible({ timeout: 30_000 });
      const m = await page.evaluate(() => {
        const b = document.querySelector('.hsearch')!;
        const shown = (sel: string) => getComputedStyle(b.querySelector(sel)!).display !== 'none';
        return { sw: document.documentElement.scrollWidth, w: b.getBoundingClientRect().width, words: shown('.hsearch__t'), word: shown('.hsearch__w'), hint: shown('.hsearch__k') };
      });
      expect(m.sw, 'no sideways scroll').toBeLessThanOrEqual(width);
      expect(m.w).toBeGreaterThan(44);
      expect(m.w).toBeLessThanOrEqual(260);
      expect(m.hint, 'the "/" hint').toBe(true);
      // the words when they fit, "Search" when only that fits; never both
      expect(m.words && m.word).toBe(false);
      if (m.w >= 230) expect(m.words).toBe(true);
    });
  }
});

test.describe('320 px header smoke', () => {
  test.use({ viewport: SMOKE_320 });
  test('live and rewound', async ({ page }, info) => {
    test.skip(onlyIn(info.project.name), 'runs once');
    for (const path of [PLAIN, `${PLAIN}?at=${REWIND_AT}`]) {
      await gotoRoute(page, path);
      await expect(page.locator('.hprice__v[data-num]')).toBeVisible({ timeout: 30_000 });
      const a = await layoutAudit(page, SHELL);
      expect(a.overflowX, path).toBe(false);
      expect(a.smallTargets, path).toEqual([]);
      expect(a.smallText, path).toEqual([]);
    }
  });
});

test.describe('once', () => {
  test.beforeEach(({}, info) => test.skip(onlyIn(info.project.name), 'viewport-independent: runs in 375x812'));

  test('every route renders one h1 equal to RouteDef.h1 and sets the title', async ({ page }) => {
    for (const r of ROUTES) {
      await gotoRoute(page, r.path);
      await expect(page.locator('h1')).toHaveCount(1);
      await expect(page.locator('h1')).toHaveText(r.h1);
      await expect(page).toHaveTitle(r.path === '/' ? `NamadaTrade: ${r.title}` : `${r.title} · NamadaTrade`);
    }
  });

  test('unknown path renders the not-found view and keeps its URL', async ({ page }) => {
    await gotoRoute(page, '/no-such-page');
    await expect(page.locator('h1')).toHaveText(NOT_FOUND.h1);
    expect(new URL(page.url()).pathname).toBe('/no-such-page');
    for (const t of TABS) await expect(page.locator('main').getByRole('link', { name: new RegExp(`^${t.label}: `) })).toBeVisible();
  });

  test('aliases and old hash links normalise with replaceState and keep ?at=', async ({ page }) => {
    await page.goto('/');
    await page.locator('main h1').waitFor();
    const before = await page.evaluate(() => history.length);
    await page.evaluate((at) => { history.pushState(null, '', `/pressure?at=${at}`); dispatchEvent(new PopStateEvent('popstate')); }, REWIND_AT);
    await expect(page).toHaveURL(`/supply?at=${REWIND_AT}`);
    expect(await page.evaluate(() => history.length)).toBe(before + 1); // the alias replaced the pushed entry
    await page.goto(`/#/blind?at=${REWIND_AT}`);
    await expect(page).toHaveURL(`/shielded?at=${REWIND_AT}`);
    await page.goto('/Trade/');
    await expect(page).toHaveURL('/trade');
  });

  test('tabs are real links: a plain click navigates in place, a modified click does not', async ({ page, context }) => {
    await gotoRoute(page, '/');
    await page.evaluate(() => ((window as unknown as { __marker: number }).__marker = 1));
    await page.locator('nav.tabbar').getByRole('link', { name: 'Trade' }).click();
    await expect(page).toHaveURL('/trade');
    expect(await page.evaluate(() => (window as unknown as { __marker?: number }).__marker)).toBe(1); // no reload
    await expect(page.locator('nav.tabbar a[aria-current="page"]')).toHaveText(/Trade/);
    const popup = context.waitForEvent('page');
    await page.locator('nav.tabbar').getByRole('link', { name: 'Supply' }).click({ modifiers: ['ControlOrMeta'] });
    await popup;
    await expect(page).toHaveURL('/trade');
  });

  test('?at= survives navigation; Back to now drops it', async ({ page }) => {
    await gotoRoute(page, `/supply?at=${REWIND_AT}`);
    await expect(page.locator('nav.tabbar').getByRole('link', { name: 'Trade' })).toHaveAttribute('href', `/trade?at=${REWIND_AT}`);
    await page.locator('nav.tabbar').getByRole('link', { name: 'Trade' }).click();
    await expect(page).toHaveURL(`/trade?at=${REWIND_AT}`);
    await page.getByRole('button', { name: 'Back to now' }).click();
    await expect(page).toHaveURL('/trade');
    await expect(page.locator('.rwb')).toHaveCount(0);
  });

  test('N3: rewound /supply at 375: every /api request carries at= except the exempt list, no live-only call', async ({ page, baseURL }) => {
    const reqs = trackRequests(page);
    await gotoRoute(page, `/supply?at=${REWIND_AT}`);
    await expect(page.locator('.rwb')).toContainText('Rewound');
    await page.waitForTimeout(2500);
    const api = apiUrls(reqs, baseURL!);
    expect(api.length).toBeGreaterThan(0);
    for (const u of api) {
      if (isExempt(u.pathname)) continue;
      expect(isLiveOnly(u.pathname), `live-only call while rewound: ${u.pathname}`).toBe(false);
      expect(u.searchParams.get('at'), u.pathname + u.search).toBe(String(REWIND_AT));
    }
    await expect(page.locator('.hbtn--rewind')).toBeHidden();
    await expect(page.locator('.hbtn--status')).toHaveAttribute('aria-label', /Checks were not recorded then/);
  });

  test('N9: only same-origin requests; fonts are self-hosted', async ({ page, baseURL }) => {
    const reqs = trackRequests(page);
    await gotoRoute(page, '/');
    await page.waitForTimeout(1500);
    const foreign = reqs.map((r) => r.url()).filter((u) => !u.startsWith(baseURL!) && !u.startsWith('data:') && !u.startsWith('blob:'));
    expect(foreign).toEqual([]);
    expect(await page.evaluate(() => document.fonts.check('500 16px "Space Grotesk Variable"'))).toBe(true);
  });

  test('keys: 1 to 6 switch tabs; with Meta, Ctrl or Alt they do nothing', async ({ page }) => {
    await gotoRoute(page, '/');
    await page.keyboard.press('2');
    await expect(page).toHaveURL('/trade');
    await page.keyboard.press('Alt+3');
    await page.keyboard.press('Control+4');
    await expect(page).toHaveURL('/trade');
    await page.keyboard.press('6');
    await expect(page).toHaveURL('/alerts');
  });

  test('router: every entry keeps its scroll offset in history.state; Back and Forward restore it', async ({ page }, info) => {
    test.skip(onlyIn(info.project.name), 'runs once');
    await gotoRoute(page, '/');
    await page.waitForTimeout(1500);
    await page.evaluate(() => window.scrollTo(0, 1200));
    await expect.poll(() => page.evaluate(() => (history.state as { scrollY?: number } | null)?.scrollY)).toBe(1200);
    await page.keyboard.press('2');
    await expect(page).toHaveURL('/trade');
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    await page.goBack();
    await expect(page).toHaveURL('/');
    await expect.poll(() => page.evaluate(() => Math.round(window.scrollY)), { timeout: 10_000 }).toBe(1200);
    await page.goForward();
    await expect(page).toHaveURL('/trade');
    await expect.poll(() => page.evaluate(() => Math.round(window.scrollY))).toBe(0);
  });

  test('palette: "/" opens it, Escape closes it, focus returns; Ctrl or Cmd K toggles', async ({ page }) => {
    await gotoRoute(page, '/');
    await page.getByRole('button', { name: 'Search', exact: true }).focus();
    await page.keyboard.press('/');
    const dialog = page.locator('dialog.pal');
    await expect(dialog).toBeVisible();
    await expect(page.getByRole('combobox')).toBeFocused();
    await page.keyboard.type('shield');
    await expect(dialog.getByRole('option', { name: /Shielded/ }).first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.locator('dialog.pal')).toBeVisible();
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.locator('dialog.pal')).toHaveCount(0);
  });

  test('theme: dark by default with no attribute; light from nt.theme before first paint', async ({ page }) => {
    await gotoRoute(page, PLAIN);
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBeNull();
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(0, 0, 0)');
    await page.addInitScript(() => localStorage.setItem('nt.theme', 'light'));
    await gotoRoute(page, PLAIN);
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('light');
    // the bezel stays black in both themes
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('header.hdr')!).backgroundColor)).toBe('rgb(0, 0, 0)');
  });

  test('G7: the shell runs no animation under reduced motion', async ({ page }) => {
    await gotoRoute(page, PLAIN, { reducedMotion: true });
    await page.waitForTimeout(1000);
    expect(await animationsIn(page, SHELL)).toBe(0);
  });

  test('footer: disclaimer and links, with the source code link (owner decision 4)', async ({ page }) => {
    await gotoRoute(page, PLAIN);
    const foot = page.locator('footer.foot');
    await expect(foot).toContainText('It is not investment advice and is not affiliated with Namada or the Anoma Foundation.');
    // the explainer pages under the names they carry everywhere else (shared/routes.ts labels)
    for (const name of ['How we know', 'Settings', 'API', 'Questions', 'Staking', 'Holders', 'NAM on Osmosis', 'How NAM trading works']) await expect(foot.getByRole(name === 'How we know' ? 'button' : 'link', { name, exact: true })).toBeVisible();
    await expect(foot.getByRole('link', { name: 'Source code', exact: true })).toHaveAttribute('href', 'https://github.com/BidurS/namada-trade');
    // "Buy me a coffee": a 44 px button that opens the shielded address with copy and a QR code
    const coffee = foot.getByRole('button', { name: /Buy me a coffee/ });
    expect((await coffee.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await coffee.click();
    const sheet = page.locator('dialog[open]');
    await expect(sheet).toContainText('znam13nhljeczcggkq4jqfn64mzdsp8d56wgt6t33ja5chzdfqjxnhghwrm2a6hs7tph5uffsj2rv379');
    await expect(sheet.getByRole('button', { name: /Copy address/ })).toBeVisible();
    await expect(sheet.locator('img[alt^="QR code"]')).toBeVisible();
    // the Zcash side (owner, 2026-10-21): the switch shows the unified address with its own QR code
    await sheet.getByRole('radio', { name: 'Zcash' }).check();
    await expect(sheet).toContainText('Shielded Zcash address');
    await expect(sheet).toContainText('u1xpk2qkpfdu48myyvpm3rfqujkz94xfn0tsuwt3ql6mddutsvh92mt7g5h752xce7meeywx9gqad8m9g97ygz3x5jertlkj8kycv74wvh90v85ecxycakh24ggk077w8pzkg3xtw32nawyu00ns4ckeva7537f9f9navw5uhus5c5kxkd');
    await expect(sheet.locator('img[alt="QR code of the shielded Zcash address"]')).toBeVisible();
    await expect(sheet).not.toContainText('znam13nhljeczcggkq4jqfn64mzdsp8d56wgt6t33ja5chzdfqjxnhghwrm2a6hs7tph5uffsj2rv379');
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
  });

  test('a future ?at= is live: the URL drops it and no rewind label shows', async ({ page }) => {
    await gotoRoute(page, '/supply?at=9999999999999');
    await expect(page).toHaveURL('/supply');
    await expect(page.locator('.rwb')).toHaveCount(0);
  });

  test('Back announces the page it returns to', async ({ page }) => {
    await gotoRoute(page, '/');
    await page.locator('nav.tabbar').getByRole('link', { name: 'Supply' }).click();
    const live = page.locator('main > p.sr-only[aria-live]');
    await expect(live).toContainText('NAM supply');
    await page.goBack();
    await expect(page).toHaveURL('/');
    await expect(live).toContainText('NamadaTrade: ');
  });

  test('a link to the #section already in the URL goes there again', async ({ page }) => {
    await gotoRoute(page, '/settings#appearance');
    await expect(page.locator('#appearance')).toBeVisible();
    await page.evaluate(() => scrollTo(0, 0));
    // the shell's navigate(), as a Link inside a sheet calls it (the dev server's module path)
    await page.evaluate(async () => {
      const path = '/src/app/router.ts';
      const r = (await import(/* @vite-ignore */ path)) as { navigate: (to: string) => void };
      r.navigate('/settings#appearance');
    });
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0);
    await expect(page.locator('#appearance')).toBeFocused();
  });

  test('a code chunk that is gone after a deploy: search and sheets show a notice, the app stays', async ({ page }) => {
    await gotoRoute(page, '/');
    // what the server answers for a chunk the deploy removed (the dev server's module paths)
    await page.route(/\/src\/(app\/Palette\.tsx|screens\/sheets\/)/, (r) => r.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' }));
    await page.keyboard.press('/');
    const failed = page.locator('dialog.load-failed');
    await expect(failed).toBeVisible();
    await expect(failed).toContainText('This part did not load');
    await expect(failed.getByRole('button', { name: 'Reload the page' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    await expect(page.locator('main h1')).toBeVisible();
    await page.locator('.hbtn--status').click();
    await expect(failed).toBeVisible();
    await failed.getByRole('button', { name: 'Close' }).click();
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    await expect(page.locator('.hbtn--status')).toBeFocused();
  });

  test('palette: focus returns from the close button; a sheet opened from it returns focus to its opener', async ({ page }) => {
    await gotoRoute(page, '/');
    const search = page.getByRole('button', { name: 'Search', exact: true });
    await search.click();
    await page.locator('dialog.pal .pal__x').click();
    await expect(page.locator('dialog.pal')).toHaveCount(0);
    await expect(search).toBeFocused();
    await search.click();
    await page.getByRole('combobox').fill('where every');
    await page.keyboard.press('Enter');
    await expect(page.locator('dialog.sheet[open]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    await expect(search).toBeFocused();
  });

  test('palette: a failed search says so in plain words; a slow answer for older text is cancelled and never shown', async ({ page }) => {
    await gotoRoute(page, '/');
    let fail: number | null = 503;
    const asked: string[] = [];
    await page.route(/\/api\/search/, async (r) => {
      const q = new URL(r.request().url()).searchParams.get('q') ?? '';
      asked.push(q);
      try {
        if (fail === 503) return await r.fulfill({ status: 503, body: 'down' });
        if (fail === 429) return await r.fulfill({ status: 429, json: { error: 'Too many searches from your address; try again in a minute.' } });
        if (q === 'tnamqa') await new Promise((x) => setTimeout(x, 2500));
        await r.fulfill({ json: answer([name(`RESULT FOR ${q}`, `tnam1qzz${q}`)]) });
      } catch {
        /* cancelled by the page: the route is gone */
      }
    });
    const aborted: string[] = [];
    page.on('requestfailed', (r) => r.url().includes('/api/search') && aborted.push(new URL(r.url()).searchParams.get('q') ?? ''));
    await page.keyboard.press('/');
    const box = page.getByRole('combobox');
    await box.fill('foundation');
    await expect(page.locator('.pal__note')).toHaveText('The search service did not answer; pages and words still work.');
    await expect(page.locator('.pal__note')).not.toContainText('No address');
    // the pages and words still work
    await expect(page.locator('.pal__gloss')).toBeVisible();
    fail = 429;
    await box.fill('zondax');
    await expect(page.locator('.pal__note')).toHaveText('Too many searches from your address; try again in a minute; pages and words still work.');
    fail = null;
    await box.fill('');
    await box.pressSequentially('tnamqa', { delay: 20 });
    await page.waitForTimeout(400);
    await box.pressSequentially('b');
    await expect(page.locator('.pal__l', { hasText: 'RESULT FOR' })).toHaveText(['RESULT FOR tnamqab']);
    await page.waitForTimeout(2600);
    await expect(page.locator('.pal__l', { hasText: 'RESULT FOR' })).toHaveText(['RESULT FOR tnamqab']);
    // the superseded request was cancelled in the browser, not left to run
    expect(aborted).toContain('tnamqa');
    // no request for the keystrokes inside the 150 ms pause
    expect(asked.filter((q) => q.startsWith('tnamq') && q.length < 6)).toEqual([]);
  });

  test('glossary cards without the Popover API: hidden until a tap, then Escape or a tap outside closes them', async ({ page }) => {
    await page.addInitScript(() => {
      const p = HTMLElement.prototype as unknown as Record<string, unknown>;
      delete p.showPopover;
      delete p.hidePopover;
      delete p.togglePopover;
    });
    await gotoRoute(page, '/activity');
    await expect(page.locator('.txl button.tag').first()).toBeVisible({ timeout: 30_000 });
    expect(await page.evaluate(() => [...document.querySelectorAll('.pop')].filter((p) => getComputedStyle(p).display !== 'none').length)).toBe(0);
    await page.locator('.txl button.tag').first().click();
    await expect(page.locator('.pop.is-open')).toHaveCount(1);
    await expect(page.locator('.pop.is-open')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.pop.is-open')).toHaveCount(0);
    await page.locator('.txl button.tag').nth(1).click();
    await expect(page.locator('.pop.is-open')).toHaveCount(1);
    await page.locator('main h1').click();
    await expect(page.locator('.pop.is-open')).toHaveCount(0);
    // shortcuts still work (the overlay check does not throw)
    await page.keyboard.press('3');
    await expect(page).toHaveURL('/supply');
  });

  test('when the overview stops answering, the figures turn old and a bar says since when', async ({ page }) => {
    await page.clock.install();
    let fail = false;
    await page.routeWebSocket(/\/ws/, (ws) => ws.close());
    await page.route(/\/api\/overview/, async (r) => {
      if (fail) return r.fulfill({ status: 503, body: 'x' });
      const resp = await r.fetch();
      const j = await resp.json();
      j.price.usd.prov.status = 'live';
      await r.fulfill({ response: resp, json: j });
    });
    await gotoRoute(page, PLAIN);
    await expect(page.locator('.hprice .dot')).toHaveAttribute('data-status', 'fresh');
    await expect(page.locator('.upd--stale')).toHaveCount(0);
    fail = true;
    await page.clock.runFor(21_000);
    await expect(page.locator('.upd--stale')).toContainText('have not refreshed since');
    await expect(page.locator('.hprice .dot')).toHaveAttribute('data-status', 'old');
    await expect(page.locator('.hbtn--status')).toHaveAttribute('aria-label', /Not refreshed since/);
    fail = false;
    await page.locator('.upd--stale').getByRole('button', { name: 'Try again' }).click();
    await expect(page.locator('.upd--stale')).toHaveCount(0);
    await expect(page.locator('.hprice .dot')).toHaveAttribute('data-status', 'fresh');
  });

  test('when the overview never answers, the header price says so instead of waiting', async ({ page }) => {
    await page.route(/\/api\/overview/, (r) => r.fulfill({ status: 503, body: 'x' }));
    await gotoRoute(page, PLAIN);
    await expect(page.locator('.hprice__v')).toHaveText('—');
    await expect(page.locator('.hprice')).toHaveAttribute('aria-label', /no data, the data service/);
    await expect(page.locator('.upd--stale')).toContainText('The figures did not load: the data service answered with an error.');
    await expect(page.locator('.upd--stale').getByRole('button', { name: 'Try again' })).toBeVisible();
  });
});

test.describe('overlays at 1280', () => {
  test.use({ viewport: { width: 1280, height: 800 } });
  test.beforeEach(({}, info) => test.skip(onlyIn(info.project.name), 'runs once'));

  test('search: a text selection dragged out of the box does not close it; the page behind does not scroll', async ({ page }) => {
    await gotoRoute(page, '/activity');
    // on a list page "/" goes to the list's own field from 1024 px; Ctrl or Cmd K opens search
    await page.keyboard.press('ControlOrMeta+k');
    const box = page.getByRole('combobox');
    await box.fill('staking');
    const b = (await box.boundingBox())!;
    const d = (await page.locator('dialog.pal').boundingBox())!;
    await page.mouse.move(b.x + b.width - 4, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(d.x - 30, b.y + b.height / 2, { steps: 5 });
    await page.mouse.up();
    await expect(page.locator('dialog.pal')).toBeVisible();
    await page.mouse.move(d.x + d.width / 2, d.y + d.height + 40);
    for (let i = 0; i < 4; i++) await page.mouse.wheel(0, 300);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => scrollY)).toBe(0);
    await page.mouse.click(20, 780);
    await expect(page.locator('dialog.pal')).toHaveCount(0);
  });

  test('sheet: a text selection dragged out of it does not close it', async ({ page }) => {
    await gotoRoute(page, '/activity?addr=osmo1f56eqgwm6zz73plfvwhamquugjr2ewnusveral');
    const sheet = page.locator('dialog.sheet[open]');
    await expect(sheet).toBeVisible();
    const t = (await sheet.locator('.sheet__t').boundingBox())!;
    const s = (await sheet.boundingBox())!;
    await page.mouse.move(t.x + t.width - 4, t.y + t.height / 2);
    await page.mouse.down();
    await page.mouse.move(s.x - 40, t.y + t.height / 2, { steps: 6 });
    await page.mouse.up();
    await expect(sheet).toBeVisible();
    await expect(page).toHaveURL(/addr=osmo1f56/);
  });
});

// ---------------------------------------------------------------------------------------------
// Search (nav-search-plan 4.4, 4.6, 4.7): the grouped answer mocked in the contract's shape
// ---------------------------------------------------------------------------------------------
const ADDR_A = 'tnam1qzondx8kq3m5wyc0e4u0u3t9yd2r4a9p7hk2j4mq';
const ADDR_V = 'tnam1q9zond7xvaw5cq3ldc9pzk4nvlq8ftx3e6j2hwmr';
const ADDR_N = 'tnam1qxbizond2ljhd8u4v5w6y7z8c9d0e2f3g4h5j6kp';
const HASH = 'ZOND1234ABCD5678EF90ZOND1234ABCD5678EF90ZOND1234ABCD5678EF90AB';
const name = (title: string, value: string, extra: Partial<SearchResult> = {}): SearchResult => ({
  type: 'label', group: 'names', kind: 'name', match: 'contains', chain: 'namada', value, title, subtitle: 'Shared label · Namada address', label: title, label_plain: title, category_plain: null, href: `/holders?addr=${value}`, stamp: null, ...extra,
});
/** The answer of GET /api/search?q= from nav step 5 on (shared/types.ts SearchResponse). */
const answer = (results: SearchResult[]): SearchResponse => {
  const groups = [...new Set(results.map((r) => r.group!))].map((group) => ({ group, n: results.filter((r) => r.group === group).length, more: false }));
  return { results, asOf: Date.now(), groups };
};
const SEARCH_ANSWER = answer([
  { type: 'address', group: 'addresses', kind: 'address', match: 'start', chain: 'namada', value: ADDR_A, title: ADDR_A, subtitle: 'Namada address · staked 1.2 million NAM', href: `/holders?addr=${ADDR_A}`, stamp: null },
  { type: 'tx', group: 'records', kind: 'record', match: 'start', chain: 'namada', value: HASH, title: 'Sell, 12,345 NAM', subtitle: 'Block 8,294,006 on Namada', href: `/activity?q=${HASH}`, external: `https://namada.valopers.com/transactions/${HASH}`, stamp: null },
  name('Zondax', ADDR_V, { type: 'validator', kind: 'validator', match: 'word', subtitle: 'Validator · Namada address', category_plain: 'Validator' }),
  name('Bizond treasury', ADDR_N),
]);

/** Answer /api/search (after `delayMs`): SEARCH_ANSWER for text with "zond" or "hold", nothing otherwise. Returns the texts asked for. */
async function mockSearch(page: Page, delayMs = 0, body: (q: string) => unknown = (q) => (/zond|hold/i.test(q) ? SEARCH_ANSWER : answer([]))): Promise<string[]> {
  const asked: string[] = [];
  await page.route(/\/api\/search/, async (r: Route) => {
    const q = new URL(r.request().url()).searchParams.get('q') ?? '';
    asked.push(q);
    if (delayMs) await new Promise((x) => setTimeout(x, delayMs));
    await r.fulfill({ json: body(q) }).catch(() => undefined);
  });
  return asked;
}

const optionTexts = (page: Page) => page.locator('dialog.pal [role="option"] .pal__l').allTextContents();
const groupTitles = (page: Page) => page.locator('dialog.pal [role="listbox"] [role="group"] .pal__gh').allTextContents();
/** The palette's group with this heading. */
const group = (page: Page, title: string) => page.locator('dialog.pal [role="group"]').filter({ has: page.locator('.pal__gh', { hasText: new RegExp(`^${title}$`) }) });
/** Open search with "/" and wait until its box has focus (the palette's code loads on first use). */
async function openSearch(page: Page) {
  await page.keyboard.press('/');
  await expect(page.getByRole('combobox')).toBeFocused();
}

test.describe('search', () => {
  test.beforeEach(({}, info) => test.skip(onlyIn(info.project.name), 'viewport-independent: runs in 375x812'));

  test('local groups render on the keystroke, before the server answers (the server held 2 s)', async ({ page }) => {
    await mockSearch(page, 2000);
    await gotoRoute(page, PLAIN);
    await openSearch(page);
    const box = page.getByRole('combobox');
    await box.pressSequentially('hold');
    const t0 = Date.now();
    await expect(page.locator('dialog.pal [role="option"]', { hasText: 'Holders' }).first()).toBeVisible({ timeout: 200 });
    expect(Date.now() - t0).toBeLessThan(200);
    // the server's groups arrive later, above the views (Addresses, Records, Names before Views)
    await expect.poll(() => groupTitles(page), { timeout: 5000 }).toEqual(['Addresses', 'Records', 'Names', 'Views']);
  });

  test('groups in order, ranked inside: exact, start, end, word, inside; the combobox wiring', async ({ page }) => {
    await mockSearch(page);
    await gotoRoute(page, PLAIN);
    await openSearch(page);
    const box = page.getByRole('combobox');
    await expect(box).toHaveAttribute('aria-autocomplete', 'list');
    await box.fill('zond');
    await expect.poll(() => groupTitles(page)).toEqual(['Addresses', 'Records', 'Names']);
    // Names: "Zondax" (a word start) before "Bizond treasury" (inside), whatever the server's order
    expect(await page.locator('[role="group"]', { hasText: 'Names' }).locator('.pal__l').allTextContents()).toEqual(['Zondax', 'Bizond treasury']);
    await expect(box).toHaveAttribute('aria-expanded', 'true');
    const list = page.locator('dialog.pal [role="listbox"]');
    await expect(box).toHaveAttribute('aria-controls', (await list.getAttribute('id'))!);
    // each option is described by its group's heading, and the active one is the input's active descendant
    const first = page.locator('dialog.pal [role="option"]').first();
    const gh = await page.locator('dialog.pal [role="group"]').first().getAttribute('aria-labelledby');
    await expect(first).toHaveAttribute('aria-describedby', gh!);
    await expect(box).toHaveAttribute('aria-activedescendant', (await first.getAttribute('id'))!);
    await expect(first).toHaveAttribute('aria-selected', 'true');
    // the glossary is a plain list, not options
    await box.fill('stak');
    await expect(page.locator('.pal__gloss')).toContainText('Staked');
    expect(await optionTexts(page)).not.toContain('Staked');
    // nothing listed: not expanded, and the listbox is hidden (never an empty listbox)
    await box.fill('qqqqqqqqqqqqqq');
    await expect(page.locator('.pal__note')).toHaveText('No address, record or name matches “qqqqqqqqqqqqqq”.');
    await expect(box).toHaveAttribute('aria-expanded', 'false');
    await expect(list).toBeHidden();
  });

  test('keys: Down, Down, Enter runs the third result; Home, End, Page Down and Page Up move the active one', async ({ page }) => {
    await mockSearch(page);
    await gotoRoute(page, PLAIN);
    await openSearch(page);
    const box = page.getByRole('combobox');
    await box.fill('zond');
    await expect.poll(() => optionTexts(page)).toEqual(['tnam1qzond…2j4mq', 'Sell, 12,345 NAM', 'Zondax', 'Bizond treasury']);
    const active = async () => (await page.locator(`[id="${await box.getAttribute('aria-activedescendant')}"] .pal__l`).textContent()) ?? '';
    await page.keyboard.press('End');
    expect(await active()).toBe('Bizond treasury');
    await page.keyboard.press('Home');
    expect(await active()).toBe('tnam1qzond…2j4mq');
    await page.keyboard.press('PageDown');
    expect(await active()).toBe('Bizond treasury'); // eight rows down, held at the last
    await page.keyboard.press('PageUp');
    expect(await active()).toBe('tnam1qzond…2j4mq');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    expect(await active()).toBe('Zondax');
    await page.keyboard.press('Enter');
    await expect(page.locator('dialog.pal')).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`addr=${ADDR_V}`));
    await expect(page.locator('dialog.sheet[open]')).toBeVisible();
  });

  test('a record opens the moves list on its hash (href); a first-build record opens the explorer in a new tab', async ({ page, context }) => {
    await mockSearch(page);
    await gotoRoute(page, PLAIN);
    await openSearch(page);
    await page.getByRole('combobox').fill('#zond');
    await expect.poll(() => groupTitles(page)).toEqual(['Records']);
    await expect(page.locator('dialog.pal [role="option"]')).toContainText('On the moves list');
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    // the first build: { type: 'tx', title: 'sell 12345 NAM' } without group or href
    await mockSearch(page, 0, () => ({ results: [{ type: 'tx', chain: 'namada', value: HASH, title: 'sell 12,345 NAM', subtitle: `block 8294006 on namada · ${HASH.slice(0, 12)}…` }] }));
    const box = page.getByRole('combobox');
    await box.fill('');
    await box.fill('#zondb');
    await expect(page.locator('dialog.pal [role="option"] .pal__l')).toHaveText(['Sell, 12,345 NAM']);
    await expect(page.locator('dialog.pal [role="option"] .pal__s')).toContainText('Block 8,294,006 on Namada');
    await expect(page.locator('dialog.pal [role="option"] .pal__s')).toContainText('On the explorer, in a new tab');
    await context.route('https://namada.valopers.com/**', (r) => r.fulfill({ contentType: 'text/plain', body: 'the explorer' }));
    const popup = context.waitForEvent('page');
    await page.keyboard.press('Enter');
    expect((await popup).url()).toContain(`namada.valopers.com/transactions/${HASH}`);
  });

  test('the first-build answer: names read from `type`; its echoes of a typed address start and of a block number are dropped', async ({ page }) => {
    await mockSearch(page, 0, (q) => ({
      results: [
        { type: 'address', chain: 'namada', value: q, title: q, subtitle: 'Namada address', label: null, label_plain: null, category_plain: null },
        { type: 'label', chain: 'namada', value: 'tnam1q8nm4ar7aua8035du0m8x6amfe4407uzvqtfs6lm', title: 'Anoma Foundation', subtitle: 'Foundation · tnam1q8nm4ar…', label: 'Anoma Foundation', label_plain: 'Anoma Foundation', category_plain: 'Foundation' },
      ],
    }));
    await gotoRoute(page, PLAIN);
    await openSearch(page);
    await page.getByRole('combobox').fill('tnam1q8nm');
    // no Addresses group: the echo names no account; the address start is also a filter for both lists (in ?q=)
    await expect.poll(() => groupTitles(page)).toEqual(['Names', 'Lists']);
    await expect(group(page, 'Names').locator('[role="option"]')).toHaveCount(1);
    await expect(group(page, 'Names').locator('.pal__s')).toHaveText('tnam1q8nm4…fs6lm · Foundation · Namada address');
    await expect(group(page, 'Lists').locator('.pal__l')).toHaveText(['Moves: address starts with tnam1q8nm…', 'Holders: address starts with tnam1q8nm…']);
    // a block number: the first build answers "Osmosis pool #8294006", which is no pool; the Lists row is the answer
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await mockSearch(page, 0, (q) => ({ results: [{ type: 'pool', chain: 'osmosis', value: q, title: `Osmosis pool #${q}`, subtitle: 'pool depth and reserves' }] }));
    await page.getByRole('combobox').fill('8294006');
    await expect(page.locator('dialog.pal [role="option"] .pal__l')).toHaveText(['Moves: block 8,294,006']);
    await expect(page.locator('.pal__note')).toHaveCount(0);
  });

  test('scopes: @ keeps addresses and names, Tab makes it a chip, Backspace in the empty box removes it; > and ? stay local', async ({ page }) => {
    const asked = await mockSearch(page);
    await gotoRoute(page, PLAIN);
    await openSearch(page);
    const box = page.getByRole('combobox');
    await box.fill('@zond');
    await expect.poll(() => groupTitles(page)).toEqual(['Addresses', 'Names']);
    await expect(box).toHaveAttribute('aria-description', 'Searching addresses and names');
    expect(asked[asked.length - 1]).toBe('zond'); // the prefix is not sent
    await page.keyboard.press('Tab');
    await expect(page.locator('.pal__scope')).toContainText('Addresses and names');
    await expect(box).toHaveValue('zond');
    await expect(box).toBeFocused();
    await expect.poll(() => groupTitles(page)).toEqual(['Addresses', 'Names']);
    await box.fill('');
    await page.keyboard.press('Backspace');
    await expect(page.locator('.pal__scope')).toHaveCount(0);
    await expect(box).not.toHaveAttribute('aria-description', /./);
    const before = asked.length;
    await box.fill('>keys');
    await expect.poll(() => groupTitles(page)).toEqual(['Actions']);
    await box.fill('?stak');
    await expect(page.locator('dialog.pal [role="listbox"]')).toBeHidden();
    await expect(page.locator('.pal__gloss')).toContainText('Staked');
    await page.waitForTimeout(400);
    expect(asked.length, 'actions and the glossary ask the server nothing').toBe(before);
  });

  test('the status line says "N results in M groups" once per settled text, not per keystroke', async ({ page }) => {
    await mockSearch(page, 300);
    await gotoRoute(page, PLAIN);
    await openSearch(page);
    await page.evaluate(() => {
      const el = document.querySelector('dialog.pal [role="status"]')!;
      const w = window as unknown as { __said: string[] };
      w.__said = [];
      new MutationObserver(() => w.__said.push(el.textContent ?? '')).observe(el, { childList: true, characterData: true, subtree: true });
    });
    const status = page.locator('dialog.pal [role="status"]');
    await expect(status).toHaveAttribute('aria-live', 'polite');
    await page.getByRole('combobox').pressSequentially('zonda', { delay: 60 });
    await expect(status).toHaveText('4 results in 3 groups.', { timeout: 5000 });
    await page.waitForTimeout(800);
    const said = await page.evaluate(() => (window as unknown as { __said: string[] }).__said.filter(Boolean));
    expect(said.length, said.join(' | ')).toBeLessThanOrEqual(2);
  });

  test('the words typed as filters become a Lists row with the list parameters', async ({ page }) => {
    await mockSearch(page, 0, () => answer([]));
    await gotoRoute(page, PLAIN);
    await openSearch(page);
    await page.getByRole('combobox').fill('sell >100k');
    const row = page.locator('dialog.pal [role="option"]', { hasText: 'Moves:' });
    await expect(row.locator('.pal__l')).toHaveText('Moves: sells only, at least 100,000 NAM');
    // understood as filters: "no match" would add nothing
    await expect(page.locator('.pal__note')).toHaveCount(0);
    await page.getByRole('combobox').fill('foundation >1m');
    await expect(page.locator('dialog.pal [role="option"]', { hasText: 'Holders:' }).locator('.pal__l')).toHaveText('Holders: foundation only, at least 1,000,000 NAM');
    // identifiers and free words stay in ?q= for the list to read; filters become its parameters
    await page.getByRole('combobox').fill('sell >100k last 7 days zondax');
    await expect(row.locator('.pal__l')).toHaveText(/^Moves: sells only, at least 100,000 NAM, last 7 days/);
    await page.getByRole('combobox').fill('sell >100k');
    await row.click();
    await expect(page).toHaveURL(/\/activity\?what=sell&min=100000$/);
  });

  test('Recent: an address opened from search comes back first; Clear recent empties it; recents are never sent', async ({ page, baseURL }) => {
    const reqs = trackRequests(page);
    await page.addInitScript(() => {
      // the first build's key, moved once into nt.recent; and a private search seeded
      if (!localStorage.getItem('nt.recent') && !sessionStorage.getItem('seeded')) {
        localStorage.setItem('nt.recentAddr', JSON.stringify(['osmo1f56eqgwm6zz73plfvwhamquugjr2ewnusveral']));
        sessionStorage.setItem('seeded', '1');
      }
    });
    await mockSearch(page);
    await gotoRoute(page, PLAIN);
    await page.keyboard.press('/');
    await expect(group(page, 'Recent').locator('.pal__l')).toHaveText(['osmo1f56eq…veral']);
    expect(await page.evaluate(() => localStorage.getItem('nt.recentAddr'))).toBeNull();
    // open a validator from a search: it comes back first in Recent, with its name; the search is not kept (an address was opened)
    await page.getByRole('combobox').fill('zond');
    await page.locator('dialog.pal [role="option"]', { hasText: 'Zondax' }).click();
    await expect(page.locator('dialog.sheet[open]')).toBeVisible();
    await page.keyboard.press('Escape');
    // the sheet is unmounted (its dialog stops key events while it is still in the page)
    await expect(page.locator('dialog.sheet')).toHaveCount(0);
    // a record run from a search keeps the search
    await openSearch(page);
    await page.getByRole('combobox').fill('zond');
    await page.locator('dialog.pal [role="option"]', { hasText: 'Sell, 12,345 NAM' }).click();
    await expect(page).toHaveURL(/\/activity\?q=ZOND/);
    await page.goBack();
    await expect(page).toHaveURL(/\/faq$/);
    await expect(page.locator('main h1')).toHaveText(ROUTES.find((r) => r.path === PLAIN)!.h1);
    await openSearch(page);
    const recent = group(page, 'Recent');
    await expect(recent.locator('.pal__l')).toHaveText(['Search again: zond', 'Zondax', 'osmo1f56eq…veral']);
    const stored = await page.evaluate(() => localStorage.getItem('nt.recent') ?? '');
    for (const kept of ['zond', ADDR_V, 'osmo1f56eq']) expect(stored).toContain(kept);
    // N9: nothing left the site, and the address only Recent held (never opened here) was never sent
    expect(reqs.filter((r) => !r.url().startsWith(baseURL!)).map((r) => r.url())).toEqual([]);
    expect(reqs.filter((r) => r.url().includes('osmo1f56eq')).map((r) => r.url())).toEqual([]);
    // Search again puts the text back
    await recent.locator('[role="option"]', { hasText: 'Search again' }).click();
    await expect(page.getByRole('combobox')).toHaveValue('zond');
    await page.getByRole('combobox').fill('');
    await page.locator('dialog.pal [role="option"]', { hasText: 'Clear recent' }).click();
    await expect(group(page, 'Recent')).toHaveCount(0);
    await expect(page.locator('dialog.pal [role="status"]')).toHaveText('Recent cleared.');
    expect(await page.evaluate(() => [localStorage.getItem('nt.recent'), localStorage.getItem('nt.recentAddr')])).toEqual([null, null]);
    await expect(page.locator('dialog.pal [role="option"]', { hasText: 'Clear recent' })).toHaveCount(0);
  });

  test('N9 with recents stored: opening search sends nothing, and nothing leaves the site', async ({ page, baseURL }) => {
    await page.addInitScript(() =>
      localStorage.setItem('nt.recent', JSON.stringify([
        { kind: 'search', key: 'privatetermxyz', opens: 2, lastAt: Date.now() - 1000 },
        { kind: 'address', key: 'tnam1qprivate7xvaw5cq3ldc9pzk4nvlq8ftx3e6j2hw', label: 'Mine', opens: 1, lastAt: Date.now() - 2000 },
      ])),
    );
    const reqs: Request[] = trackRequests(page);
    await gotoRoute(page, PLAIN);
    await page.keyboard.press('/');
    await expect(group(page, 'Recent').locator('.pal__l')).toHaveText(['Search again: privatetermxyz', 'Mine']);
    await page.waitForTimeout(1000);
    const urls = reqs.map((r) => `${r.url()} ${r.postData() ?? ''}`);
    expect(urls.filter((u) => /privatetermxyz|tnam1qprivate/.test(u))).toEqual([]);
    expect(urls.filter((u) => !u.startsWith(baseURL!) && !u.startsWith('data:') && !u.startsWith('blob:'))).toEqual([]);
  });

  test('"?" opens the Keys sheet, which lists every row of SHORTCUTS; Escape returns focus to where it was', async ({ page }) => {
    await gotoRoute(page, PLAIN);
    await page.locator('main h1').click(); // focus on the page, not in a field
    await page.keyboard.press('?');
    const sheet = page.locator('dialog.sh-keys[open]');
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('.sheet__t')).toHaveText('Keys');
    const shortcuts = await page.evaluate(async () => {
      const path = '/src/app/keys.ts';
      const m = (await import(/* @vite-ignore */ path)) as { SHORTCUTS: { keys: string[]; does: string }[] };
      return m.SHORTCUTS.map((s) => ({ keys: s.keys, does: s.does }));
    });
    const rows = sheet.locator('.sh-keys__row');
    await expect(rows).toHaveCount(shortcuts.length);
    for (const [i, s] of shortcuts.entries()) {
      await expect(rows.nth(i).locator('dd')).toHaveText(s.does.charAt(0).toUpperCase() + s.does.slice(1));
      for (const k of s.keys) await expect(rows.nth(i).locator('kbd', { hasText: k }).first()).toBeVisible();
    }
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    expect(await page.evaluate(() => document.activeElement === document.body || document.activeElement?.tagName === 'MAIN')).toBe(true);
    // not while typing: "?" in the search box is text
    await openSearch(page);
    await page.keyboard.press('?');
    await expect(page.getByRole('combobox')).toHaveValue('?');
    await expect(page.locator('dialog.sh-keys')).toHaveCount(0);
    // "Keys" in search opens the same sheet
    await page.getByRole('combobox').fill('keys');
    await page.keyboard.press('Enter');
    await expect(page.locator('dialog.sh-keys[open]')).toBeVisible();
  });

  test('"/" on a list page focuses the list\'s own search field where it is on screen; elsewhere it opens search', async ({ page }) => {
    await gotoRoute(page, '/');
    await page.keyboard.press('/');
    await expect(page.locator('dialog.pal')).toBeVisible();
    await page.keyboard.press('Escape');
    // phones: the list's field is inside the closed Filter sheet, so "/" opens search as everywhere else
    await gotoRoute(page, '/holders');
    await expect(page.locator('main [role="row"][aria-rowindex="2"]')).toBeVisible();
    await page.keyboard.press('/');
    await expect(page.locator('dialog.pal')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('dialog.pal[open]')).toHaveCount(0);
    // from 1024 px the field sits in the list's bar: "/" focuses it, Ctrl or Cmd K still opens search
    await page.setViewportSize({ width: 1280, height: 800 });
    await gotoRoute(page, '/holders');
    await expect(page.locator('main [data-list-search] input')).toBeVisible();
    await page.keyboard.press('/');
    await expect(page.locator('dialog.pal[open]')).toHaveCount(0);
    await expect(page.locator('main [data-list-search] input').first()).toBeFocused();
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.locator('dialog.pal')).toBeVisible();
  });
});

test.describe('search on phones, every viewport', () => {
  test('full-height sheet: the input stays at the top while results scroll; 44 px rows; no sideways scroll; scope chip fits', async ({ page }) => {
    await mockSearch(page);
    await gotoRoute(page, PLAIN);
    await page.locator('header button[aria-label="Search"]').click();
    const d = page.locator('dialog.pal');
    await expect(d).toBeVisible();
    await page.getByRole('combobox').fill('@zond');
    await page.keyboard.press('Tab');
    await expect.poll(() => groupTitles(page)).toEqual(['Addresses', 'Names']);
    const a = await layoutAudit(page, 'dialog.pal');
    expect(a.overflowX).toBe(false);
    expect(a.smallText).toEqual([]);
    expect(a.smallTargets).toEqual([]);
    const m = await d.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, h: el.getBoundingClientRect().height, vh: innerHeight, rows: [...el.querySelectorAll('[role="option"]')].map((o) => o.getBoundingClientRect().height) }));
    expect(m.sw).toBeLessThanOrEqual(m.cw);
    for (const h of m.rows) expect(h).toBeGreaterThanOrEqual(44);
    if ((page.viewportSize()?.width ?? 0) < 1024) expect(Math.round(m.h)).toBe(m.vh);
    // the input stays put while the results scroll (measured after the opening slide has finished)
    await d.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => undefined))));
    const y0 = (await page.getByRole('combobox').boundingBox())!.y;
    await page.locator('.pal__body').evaluate((el) => el.scrollTo(0, el.scrollHeight));
    expect((await page.getByRole('combobox').boundingBox())!.y).toBeCloseTo(y0, 1);
  });
});
