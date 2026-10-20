// The shell (F1): header, tab bar, footer, router, Rewind, keys, palette, theme, fonts.
// Viewport-independent checks run once (in the 375x812 project); layout checks run in every
// project of the G6 matrix plus a 320 px smoke.
import { NOT_FOUND } from '../../shared/copy';
import { ROUTES, TABS } from '../../shared/routes';
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

  test('palette: a failed search says so; a slow answer for older text never replaces the newer one', async ({ page }) => {
    await gotoRoute(page, '/');
    let fail = true;
    await page.route(/\/api\/search/, async (r) => {
      if (fail) return r.fulfill({ status: 503, body: 'down' });
      const q = new URL(r.request().url()).searchParams.get('q') ?? '';
      if (q === 'tnam1qa') await new Promise((x) => setTimeout(x, 2500));
      await r.fulfill({ contentType: 'application/json', body: JSON.stringify({ results: [{ type: 'address', value: `tnam1qzz${q}`, title: `RESULT FOR ${q}`, chain: 'namada' }] }) });
    });
    await page.keyboard.press('/');
    const box = page.getByRole('combobox');
    await box.fill('foundation');
    await expect(page.locator('.pal__note')).toContainText('The search did not answer');
    await expect(page.locator('.pal__note')).not.toContainText('No address');
    fail = false;
    await box.fill('');
    await box.pressSequentially('tnam1qa', { delay: 20 });
    await page.waitForTimeout(400);
    await box.pressSequentially('b');
    await expect(page.locator('.pal__l', { hasText: 'RESULT FOR' })).toHaveText(['RESULT FOR tnam1qab']);
    await page.waitForTimeout(2600);
    await expect(page.locator('.pal__l', { hasText: 'RESULT FOR' })).toHaveText(['RESULT FOR tnam1qab']);
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
    await page.keyboard.press('/');
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
