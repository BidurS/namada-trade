// The platform pages (docs/design/platform-plan.md, release A): /developers, /status, /methodology, /privacy and
// /terms, the bridges page (release B) and the validators page (release C). What the cross-route gates cannot say for them on their own: that every sentence of the page's copy
// (shared/copy.ts BODY, the words the server-rendered page states) is visible text in the app, that each page
// passes the layout rules of the content pages, and that the API page's reference is the catalog. The layout checks
// run in every project of the G6 matrix; the rest run once (375).
import { BODY } from '../../shared/copy';
import { PLATFORM_ROUTES, routeByPath } from '../../shared/routes';
import { API_CATALOG, API_GROUPS } from '../../shared/api-catalog';
import { API_LIMITS } from '../../shared/api-limits';
import { expect, gotoRoute, layoutAudit, onlyIn, test } from './helpers';

/** The pages this spec covers: the five platform pages, and the bridges page (release B) and the validators page (release C), which are built the same way. */
const PAGES = [...PLATFORM_ROUTES, routeByPath('/bridges')!, routeByPath('/validators')!, routeByPath('/governance')!];

/** Every plain-language sentence of a page, in order. */
const sentencesOf = (id: string): string[] => {
  const c = BODY[id];
  return [...c.paras, ...(c.sections ?? []).flatMap((s) => [s.h2, ...s.paras])];
};

/** Wait until the page's figures have arrived: no skeleton block left inside main. */
async function settled(page: import('@playwright/test').Page) {
  await expect(page.locator('main .skel__b, main [aria-busy="true"]')).toHaveCount(0, { timeout: 30_000 });
}

test.describe('layout, every viewport', () => {
  for (const r of PAGES) {
    test(`${r.path}: no overflow, no <table>, 44 px targets, text at least 11 px`, async ({ page }) => {
      await gotoRoute(page, r.path);
      await settled(page);
      const a = await layoutAudit(page, 'main');
      expect(a.overflowX, `scrollWidth ${a.scrollWidth} > ${a.innerWidth}`).toBe(false);
      expect(a.tables).toBe(0);
      expect(a.smallText).toEqual([]);
      expect(a.smallTargets).toEqual([]);
    });
  }

  test('/developers with a route open: no overflow, 44 px targets', async ({ page }) => {
    await gotoRoute(page, '/developers');
    // the longest entries: the moves list (sixteen parameters, a long list of kinds) and the depth answer's fields
    for (const id of ['r-api-flows', 'r-api-depth', 'r-api-export-flows']) await page.locator(`#${id} > summary`).click();
    const a = await layoutAudit(page, 'main');
    expect(a.overflowX, `scrollWidth ${a.scrollWidth} > ${a.innerWidth}`).toBe(false);
    expect(a.smallText).toEqual([]);
    expect(a.smallTargets).toEqual([]);
  });
});

test.describe('the words and the reference', () => {
  test('one h1 equal to RouteDef.h1, and every BODY sentence is visible text', async ({ page }, info) => {
    test.skip(onlyIn(info.project.name), 'runs once');
    for (const r of PAGES) {
      await gotoRoute(page, r.path);
      await settled(page);
      await expect(page.locator('h1')).toHaveCount(1);
      await expect(page.locator('h1')).toHaveText(r.h1);
      const main = page.locator('main');
      for (const s of sentencesOf(r.id)) await expect(main, `${r.path}: "${s.slice(0, 40)}…"`).toContainText(s, { useInnerText: true });
      for (const sec of BODY[r.id].sections ?? []) await expect(page.getByRole('heading', { level: 2, name: sec.h2 })).toBeVisible();
    }
  });

  test('/developers lists every documented route under its group, and the limits', async ({ page }, info) => {
    test.skip(onlyIn(info.project.name), 'runs once');
    await gotoRoute(page, '/developers');
    await expect(page.locator('details.api-ep')).toHaveCount(API_CATALOG.length);
    for (const g of API_GROUPS) await expect(page.getByRole('heading', { level: 2, name: g.title, exact: true })).toBeVisible();
    for (const e of API_CATALOG) await expect(page.locator('details.api-ep summary', { hasText: `GET ${e.path}` }).first()).toBeVisible();
    await expect(page.locator('.api-limits .api-row')).toHaveCount(API_LIMITS.length);
    // a route opens to its parameters and the fields of its answer, each field named once
    const flows = page.locator('#r-api-flows');
    await flows.locator('summary').click();
    await expect(flows.locator('.api-rows').first().locator('.api-row')).toHaveCount(API_CATALOG.find((e) => e.path === '/api/flows')!.params.length);
    await expect(flows.getByText('Fields of the answer')).toBeVisible();
    // the document a program reads is linked as it is, and opens apart from the page
    await expect(page.locator('a[href="/openapi.json"]')).toHaveAttribute('target', '_blank');
  });

  test('/status: the cross-checks are listed under their plain titles, with the count the band states', async ({ page }, info) => {
    test.skip(onlyIn(info.project.name), 'runs once');
    await gotoRoute(page, '/status');
    await settled(page);
    const rows = page.locator('.st-checks .seo-state');
    await expect(rows.first()).toBeVisible();
    const n = await rows.count();
    expect(n).toBeGreaterThan(0);
    // the band's first figure states the same total ("10 of 20 cross-checks pass")
    const band = (await page.locator('.seo-hero').innerText()).replace(/\s+/g, ' ');
    expect(band).toMatch(new RegExp(`\\bof ${n} cross-checks pass`));
    // operator text is only under "How it is computed"
    await expect(page.locator('details.how.st-how')).toHaveCount(1);
    await expect(page.locator('details.how.st-how')).not.toHaveAttribute('open', '');
  });
});
