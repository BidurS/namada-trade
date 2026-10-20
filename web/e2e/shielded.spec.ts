// Shielded (/shielded), S4. Layout checks run in every project of the G6 matrix; the rest once.
import { BODY } from '../../shared/copy';
import { routeById } from '../../shared/routes';
import { REWIND_AT, animationsIn, apiUrls, expect, gotoRoute, isExempt, isLiveOnly, layoutAudit, onlyIn, test, trackRequests } from './helpers';
import type { Page } from '@playwright/test';

const ROUTE = routeById('shielded');

/** Wait until the blind-spot figures have replaced the skeletons. */
async function ready(page: Page) {
  await expect(page.locator('.shd-hero .hero-n__v [data-num]')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#shd-out-h')).toBeVisible();
}

async function unstamped(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const bad: string[] = [];
    for (const el of document.querySelectorAll('main [data-num]')) {
      const r = (el as HTMLElement).getBoundingClientRect();
      if (!r.width && !r.height) continue;
      const line = el.closest('[data-prov-scope]')?.querySelector('.srcb');
      const own = ['.num', '.hero-n', 'p'].some((s) => el.closest(s)?.querySelector('[data-prov]')); // its own stamp, in the same figure or sentence
      const inBand = el.closest('.shd-band')?.querySelector('.srcb');
      if ((line && (line as HTMLElement).offsetParent !== null) || own || inBand) continue;
      bad.push((el.textContent ?? '').trim().slice(0, 30));
    }
    return bad;
  });
}

test.describe('layout, every viewport', () => {
  test('live: one h1, the share hero, the bar, the chart, the rows; no overflow, no <table>', async ({ page }) => {
    await gotoRoute(page, '/shielded');
    await ready(page);
    await expect(page.locator('h1')).toHaveCount(1);
    await expect(page.locator('h1')).toHaveText(ROUTE.h1);
    await expect(page.locator('.shd-band .supply__bar')).toBeVisible();
    await expect(page.locator('.shd-chart .chart-box svg path.c-shielded')).toBeVisible();
    await expect(page.locator('#shd-chart-h')).toHaveText(/^Shielded NAM/);
    expect(await page.locator('[aria-labelledby="shd-out-h"] .mor__row, [aria-labelledby="shd-out-h"] .empty').count()).toBeGreaterThan(0);
    const a = await layoutAudit(page, 'main');
    expect(a.overflowX, `scrollWidth ${a.scrollWidth} > ${a.innerWidth}`).toBe(false);
    expect(a.tables).toBe(0);
    expect(a.smallText).toEqual([]);
    expect(a.smallTargets).toEqual([]);
  });

  test('rewound: banner, no overflow, missing figures say why', async ({ page }) => {
    await gotoRoute(page, `/shielded?at=${REWIND_AT}`);
    await expect(page.locator('#shd-out-h')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.rwb')).toBeVisible();
    await expect(page.locator('.shd-band .eyebrow')).toContainText('30 Aug 2026');
    const a = await layoutAudit(page, 'main');
    expect(a.overflowX).toBe(false);
    expect(a.smallTargets).toEqual([]);
    expect(a.smallText).toEqual([]);
  });
});

test.describe('once', () => {
  test.beforeEach(({}, info) => test.skip(onlyIn(info.project.name), 'viewport-independent: runs in 375x812'));

  test('the plain paragraphs from shared/copy.ts are visible (seo-requirements 3)', async ({ page }) => {
    await gotoRoute(page, '/shielded');
    for (const p of BODY.shielded.paras) await expect(page.getByText(p, { exact: true })).toBeVisible();
  });

  test('every panel is decision D5 and every figure has a source (N1, N4)', async ({ page }) => {
    await gotoRoute(page, '/shielded');
    await ready(page);
    expect(await page.locator('main [data-decision="D5"]').count()).toBeGreaterThan(2);
    expect(await page.locator('main [data-decision]:not([data-decision="D5"])').count()).toBe(0);
    await expect(page.locator('main .chip')).toHaveCount(1);
    expect(await unstamped(page)).toEqual([]);
    await expect(page.locator('main')).not.toContainText(/\bD[1-7]\b/);
  });

  test('the chart range: 30d, 1y and All change the takeaway title', async ({ page }) => {
    await gotoRoute(page, '/shielded');
    await ready(page);
    const title = page.locator('#shd-chart-h');
    const all = await title.textContent();
    await page.getByRole('radio', { name: '30d' }).check();
    await expect(title).not.toHaveText(all ?? '');
    await page.getByRole('radio', { name: 'All' }).check();
    await expect(title).toHaveText(all ?? '');
  });

  test('N3: rewound, every /api request carries at= except the exempt list, and no live-only call', async ({ page, baseURL }) => {
    const reqs = trackRequests(page);
    await gotoRoute(page, `/shielded?at=${REWIND_AT}`);
    await expect(page.locator('#shd-out-h')).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1500);
    const api = apiUrls(reqs, baseURL!);
    expect(api.some((u) => u.pathname === '/api/blindspot')).toBe(true);
    for (const u of api) {
      if (isExempt(u.pathname)) continue;
      expect(isLiveOnly(u.pathname), `live-only call while rewound: ${u.pathname}`).toBe(false);
      expect(u.searchParams.get('at'), u.pathname + u.search).toBe(String(REWIND_AT));
    }
    await expect(page.locator('main')).not.toContainText(/\breplay\b/i);
  });

  test('when the request fails the page says so, in words, without a stand-in figure', async ({ page }) => {
    await page.route('**/api/blindspot*', (route) => route.fulfill({ status: 503, body: 'down' }));
    await gotoRoute(page, '/shielded');
    await expect(page.getByText('The shielded lists did not load.')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.shd-hero .hero-n__v')).toHaveCount(0);
    await expect(page.locator('main')).not.toContainText(/http|\/api\//);
    const a = await layoutAudit(page, 'main');
    expect(a.overflowX).toBe(false);
  });

  test('live: refreshed every 2 minutes; a failed refresh keeps the figures, marked old with the reason', async ({ page }) => {
    await page.clock.install();
    const reqs = trackRequests(page);
    const calls = () => reqs.filter((r) => new URL(r.url()).pathname === '/api/blindspot').length;
    await gotoRoute(page, '/shielded');
    await ready(page);
    const first = calls();
    await page.route('**/api/blindspot*', (route) => route.fulfill({ status: 503, body: 'down' }));
    await page.clock.fastForward('02:05');
    await expect.poll(calls).toBeGreaterThan(first);
    await expect(page.locator('.shd-refresh')).toContainText('The latest refresh did not answer, so these figures are from');
    await expect(page.locator('.shd-hero .hero-n__v [data-num]')).toHaveAttribute('data-status', 'old');
    await expect(page.locator('#shd-out-h')).toBeVisible(); // the lists stay; no skeletons
    await page.unroute('**/api/blindspot*');
    await page.clock.fastForward('02:05');
    await expect(page.locator('.shd-refresh')).toHaveCount(0);
  });

  test('G7: nothing on the screen animates under reduced motion', async ({ page }) => {
    await gotoRoute(page, '/shielded', { reducedMotion: true });
    await ready(page);
    await page.waitForTimeout(800);
    expect(await animationsIn(page, 'main')).toBe(0);
  });
});
