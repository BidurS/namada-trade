// Activity (S5): /activity (Transactions) and /holders (Holders), one screen with two tabs.
// Layout checks run in every project of the G6 matrix; behaviour checks run once (375x812) or
// where the width matters (the filter sheet below 1024 px, inline filters from 1024 px).
import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { BODY } from '../../shared/copy';
import { ROUTES, SITE } from '../../shared/routes';
import { REWIND_AT, animationsIn, apiUrls, expect, gotoRoute, isExempt, isLiveOnly, layoutAudit, onlyIn, test, trackRequests } from './helpers';

const ACT = ROUTES.find((r) => r.id === 'activity')!;

/** Open the filter sheet (retried: under a loaded machine the first tap can land before the screen settles). */
async function openSheet(page: Page, sheet: Locator) {
  await expect(async () => {
    if (!(await sheet.isVisible())) await page.locator('.act-filterbtn').click();
    await expect(sheet).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
}
const HOL = ROUTES.find((r) => r.id === 'holders')!;

test.describe('layout, every viewport', () => {
  for (const r of [ACT, HOL]) {
    test(`${r.path}: one h1, rows, figures, no overflow, no <table>, 44 px targets, text at least 11 px`, async ({ page }) => {
      await gotoRoute(page, r.path);
      await expect(page.locator('h1')).toHaveCount(1);
      await expect(page.locator('h1')).toHaveText(r.h1);
      const row = r.id === 'activity' ? '.tx' : '.hrow';
      await expect(page.locator(`main ${row}`).first()).toBeVisible({ timeout: 30_000 });
      // the four hero figures and the list count are real numbers (or a stated no-data)
      await expect(page.locator('.act-facts .fact__n [data-num]')).toHaveCount(4);
      await expect(page.locator('.act-count [data-num]').first()).toBeVisible();
      // one SourceLine under the strip and one under the list
      await expect(page.locator('.act-facts .srcb')).toHaveCount(1);
      await expect(page.locator('.act-scope .srcb')).toHaveCount(1);
      const a = await layoutAudit(page, 'main');
      expect(a.overflowX, `scrollWidth ${a.scrollWidth} > ${a.innerWidth}`).toBe(false);
      expect(a.tables).toBe(0);
      expect(a.smallTargets).toEqual([]);
      expect(a.smallText).toEqual([]);
    });
  }

  test('the pager: every control at least 44 px, the page field 44 px high, no sideways scroll (360, 375, 1280)', async ({ page }, info) => {
    test.skip(!['360x780', '375x812', '1280x800'].includes(info.project.name), 'runs at 360, 375 and 1280');
    for (const path of [`${HOL.path}?page=3`, `${ACT.path}?page=2`]) {
      await gotoRoute(page, path);
      await expect(page.locator(path.startsWith('/holders') ? 'main .hrow' : 'main .tx').first()).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('main .act-scope')).not.toHaveAttribute('aria-busy', 'true', { timeout: 30_000 });
      const head = page.locator('.act-pager--head');
      await expect(head.getByRole('textbox', { name: 'Page number' })).toHaveValue(path.endsWith('3') ? '3' : '2');
      const boxes = await page.locator('main nav.pager').evaluateAll((navs) =>
        navs.flatMap((n) => [...n.querySelectorAll('a, input')].filter((el) => el.getBoundingClientRect().width > 0).map((el) => {
          const r = el.getBoundingClientRect();
          return { name: el.getAttribute('aria-label') ?? el.textContent ?? '', w: r.width, h: r.height, right: r.right };
        })),
      );
      expect(boxes.length).toBeGreaterThanOrEqual(10);
      for (const b of boxes) {
        expect(b.w, `${path} ${b.name} width`).toBeGreaterThanOrEqual(44);
        expect(b.h, `${path} ${b.name} height`).toBeGreaterThanOrEqual(44);
        expect(b.right, `${path} ${b.name} inside the viewport`).toBeLessThanOrEqual(page.viewportSize()!.width);
      }
      // the five required controls sit on one line below 1024 px
      const tops = await head.locator('.pager__row > a, .pager__row > .pager__pos').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
      expect(new Set(tops).size, `${path}: one line`).toBe(1);
      const csv = page.locator('main a.act-csv');
      const cb = (await csv.boundingBox())!;
      expect(cb.height).toBeGreaterThanOrEqual(44);
      const a = await layoutAudit(page, 'main');
      expect(a.overflowX, `${path}: scrollWidth ${a.scrollWidth} > ${a.innerWidth}`).toBe(false);
      expect(a.smallTargets).toEqual([]);
      expect(a.smallText).toEqual([]);
    }
  });

  test('filters: a sheet with a count badge below 1024 px, inline from 1024 px', async ({ page }) => {
    await gotoRoute(page, ACT.path);
    await expect(page.locator('main .tx').first()).toBeVisible({ timeout: 30_000 });
    const wide = (page.viewportSize()?.width ?? 0) >= 1024;
    if (wide) {
      await expect(page.locator('.act-filterbtn')).toHaveCount(0);
      await expect(page.locator('.act-filters')).toBeVisible();
      await page.locator('.act-filters .chipsel__o', { hasText: /^Sell$/ }).click();
      await expect(page.locator('.act-count')).toContainText('match the filters');
    } else {
      await expect(page.locator('.act-filters')).toHaveCount(0);
      await expect(page.locator('.act-filterbtn .badge')).toHaveCount(0);
      const sheet = page.getByRole('dialog', { name: 'Filter moves' });
      await openSheet(page, sheet);
      await sheet.locator('.chipsel__o', { hasText: /^Sell$/ }).click();
      await sheet.locator('.sheet__foot .btn--primary').click();
      await expect(sheet).toBeHidden();
      await expect(page.locator('.act-filterbtn .badge')).toHaveText('1');
      const a = await layoutAudit(page, 'main');
      expect(a.overflowX).toBe(false);
    }
  });
});

test.describe('holder row states (API answer modified in the test)', () => {
  test('a conflict row carries its own mark, a stale row in a fresh list too, and the 7-day column appears', async ({ page }) => {
    await page.route('**/api/holders?**', async (route) => {
      // a read the page itself dropped (a newer one replaced it) is disposed by the browser: nothing to answer
      const res = await route.fetch().catch(() => null);
      const j = res ? await res.json().catch(() => null) : null;
      if (!j) return route.abort().catch(() => undefined);
      const now = Date.now();
      j.holders = j.holders.map((h: Record<string, unknown>, i: number) => ({ ...h, status: 'live', statusNote: null, verifiedAt: now - 60_000, change7d: 0 }));
      Object.assign(j.holders[0], { status: 'conflict', statusNote: 'Two staked readings differ.', bonded: 14_662_107, bondedEstimated: 14_562_107, bondedVerifiedAt: now - 3 * 86_400_000 });
      Object.assign(j.holders[1], { status: 'stale', statusNote: 'Checked more than 6 hours ago.', verifiedAt: now - 8 * 3_600_000 });
      Object.assign(j.holders[2], { change7d: 1234.5 });
      await route.fulfill({ json: j });
    });
    await gotoRoute(page, HOL.path);
    await expect(page.locator('main .hrow').first()).toBeVisible({ timeout: 30_000 });
    // the list is not dimmed as a whole; the two rows that differ carry their own mark
    await expect(page.locator('.act-scope .is-old')).toHaveCount(0);
    await expect(page.locator('main .hrow').nth(1).locator('.hrow__tags .pdot')).toContainText('checked 8 h ago');
    const wide = await page.locator('.dl--holders').evaluate((el) => el.getBoundingClientRect().width >= 930);
    if (wide) {
      await expect(page.locator('.dl--chg')).toHaveCount(1);
      await expect(page.locator('main .hrow').nth(2).locator('.hrow__chg')).toContainText('+1,235');
      await expect(page.locator('main .hrow').first().locator('.hrow__est .pdot')).toContainText('estimate 14,562,107');
      await expect(page.locator('main .hrow').first().locator('.hrow__stake [data-num]')).toHaveAttribute('data-status', 'disagree');
    } else {
      await expect(page.locator('main .hrow').first().locator('.hrow__x .pdot')).toContainText('staked figures differ by 100,000 NAM');
      await expect(page.locator('main .hrow').nth(2).locator('.act-chg')).toContainText('+1,235 in 7 days');
    }
    const a = await layoutAudit(page, 'main');
    expect(a.overflowX).toBe(false);
    expect(a.smallTargets).toEqual([]);
    // a holder read still in flight when the test ends must not fail it ("Response has been disposed")
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('Osmosis: the considered empty state when no rows come back', async ({ page }, info) => {
    test.skip(onlyIn(info.project.name), 'runs once');
    await page.route('**/api/holders?**chain=osmosis**', (route) => route.fulfill({ json: { total: 0, page: 1, limit: 50, holders: [] } }));
    await gotoRoute(page, HOL.path);
    await expect(page.locator('main .hrow').first()).toBeVisible({ timeout: 30_000 });
    const sheet = page.getByRole('dialog', { name: 'Filter holders' });
    await openSheet(page, sheet);
    await sheet.locator('.seg__opt', { hasText: 'Osmosis' }).click();
    await sheet.locator('.sheet__foot .btn--primary').click();
    await expect(page.locator('main .empty')).toContainText('The Osmosis list was not captured.');
    await expect(page.locator('main .empty [data-num]').first()).toBeVisible();
  });
});

// ---------------------------------------------------------------------------------------------
// The holder figures (hero strip) carry the age of the balances behind them, the same rule as Home
// (screens/activity/holderStamp.ts); the "What" chips count what they say they count.
// ---------------------------------------------------------------------------------------------
const TOP10 = /\/api\/holders\?.*limit=10(&|$)/;
const LIST = /\/api\/holders\?.*limit=50(&|$)/;
const OVERVIEW = /\/api\/overview(\?|$)/;

test.describe('holder figures and chips (API answers modified in the test)', () => {
  test.beforeEach(({}, info) => test.skip(onlyIn(info.project.name), 'runs once'));

  test('an older server: the ten biggest rows give the age, and old Namada balances dim the Namada figures only', async ({ page }) => {
    const now = Date.now();
    await page.route(OVERVIEW, async (route) => {
      const res = await route.fetch();
      const o = await res.json();
      delete o.concentration.namadaProv;
      delete o.concentration.osmosisProv;
      await route.fulfill({ response: res, json: o });
    });
    await page.route(TOP10, async (route) => {
      const res = await route.fetch();
      const j = await res.json();
      const osm = new URL(route.request().url()).searchParams.get('chain') === 'osmosis';
      const at = osm ? now - 60_000 : now - 3 * 864e5;
      j.holders = j.holders.map((h: Record<string, unknown>) => ({ ...h, verifiedAt: at, updatedAt: at, status: osm ? 'live' : 'stale', statusNote: null }));
      await route.fulfill({ json: j });
    });
    await gotoRoute(page, HOL.path);
    const n = page.locator('.act-facts .fact__n [data-num]');
    await expect(n).toHaveCount(4, { timeout: 30_000 });
    await expect(n.nth(0)).toHaveAttribute('data-status', 'old'); // holders on Namada
    await expect(n.nth(1)).toHaveAttribute('data-status', 'old'); // their top-10 share
    await expect(n.nth(2)).toHaveAttribute('data-status', 'fresh'); // holders on Osmosis
    await expect(page.locator('.act-facts .facts__old')).toContainText(/The Namada figures are counted from balances last checked 3\sdays ago, so they are shown dimmed\./);
    await expect(page.locator('.act-facts .facts__old')).not.toContainText('Osmosis');
  });

  test('a server that stamps the holder figures: its stamps are used and no extra rows are fetched', async ({ page }) => {
    const reqs = trackRequests(page);
    const now = Date.now();
    await page.route(OVERVIEW, async (route) => {
      const res = await route.fetch();
      const o = await res.json();
      o.concentration.namadaProv = { source: 'NamadaTrade holder index', at: now - 2 * 864e5, status: 'stale', note: 'Fixture: the oldest balance behind the count.' };
      o.concentration.osmosisProv = { source: 'NamadaTrade holder index', at: now - 60_000, status: 'live' };
      await route.fulfill({ response: res, json: o });
    });
    await gotoRoute(page, HOL.path);
    const n = page.locator('.act-facts .fact__n [data-num]');
    await expect(n).toHaveCount(4, { timeout: 30_000 });
    await expect(n.nth(0)).toHaveAttribute('data-status', 'old');
    await expect(n.nth(2)).toHaveAttribute('data-status', 'fresh');
    await expect(page.locator('.act-facts .facts__old')).toContainText(/last checked 2\sdays ago/);
    await expect(page.locator('main .hrow').first()).toBeVisible({ timeout: 30_000 });
    expect(reqs.filter((r) => TOP10.test(r.url()))).toHaveLength(0);
  });

  test('the "What" chips count every holder when the server sends the counts, and say what they count when it does not', async ({ page }) => {
    await page.route(LIST, async (route) => {
      // a read the page itself cancelled (a newer one replaced it) has nothing to answer
      const res = await route.fetch().catch(() => null);
      const j = res ? await res.json().catch(() => null) : null;
      if (!j) return route.abort().catch(() => undefined);
      j.categories = { total: 2212, counts: [{ category: 'backer', n: 248 }, { category: 'genesis', n: 120 }, { category: 'none', n: 1800 }] };
      await route.fulfill({ json: j }).catch(() => undefined);
    });
    await gotoRoute(page, HOL.path);
    await expect(page.locator('main .hrow').first()).toBeVisible({ timeout: 30_000 });
    const sheet = page.getByRole('dialog', { name: 'Filter holders' });
    await openSheet(page, sheet);
    const cats = sheet.locator('.act-cats');
    await expect(cats.locator('legend')).toHaveText('What');
    await expect(cats.locator('.chipsel__o', { hasText: 'Backer' })).toContainText('248');
    await expect(cats.locator('.chipsel__o', { hasText: 'All' })).toContainText('2,212');
    // an older server (before the stored totals: no categories, asOf, countsAt or next; the production server sends
    // all four): counted among the rows loaded, and the legend says so
    await page.unroute(LIST);
    await page.route(LIST, async (route) => {
      const res = await route.fetch().catch(() => null);
      const j = res ? await res.json().catch(() => null) : null;
      if (!j) return route.abort().catch(() => undefined);
      for (const k of ['categories', 'asOf', 'countsAt', 'next']) delete j[k];
      await route.fulfill({ json: j }).catch(() => undefined);
    });
    await page.reload();
    await expect(page.locator('main .hrow').first()).toBeVisible({ timeout: 30_000 });
    await openSheet(page, sheet);
    await expect(sheet.locator('.act-cats legend')).toHaveText(/^What, counted among the \d[\d,]* biggest loaded$/);
  });
});

test.describe('wide screens', () => {
  test("from 1024 px the page keeps the header's edges; only the transaction table runs wider", async ({ page }) => {
    test.skip((page.viewportSize()?.width ?? 0) < 1024, 'the edges differ only from 1024 px');
    const left = (sel: string) => page.locator(sel).first().evaluate((el) => Math.round(el.getBoundingClientRect().left));
    for (const r of [ACT, HOL]) {
      await gotoRoute(page, r.path);
      await expect(page.locator(r.id === 'activity' ? 'main .tx' : 'main .hrow').first()).toBeVisible({ timeout: 30_000 });
      const brand = await left('header .brand');
      expect(await left('main h1'), r.path).toBe(brand);
      expect(await left('.act-bar'), r.path).toBe(brand);
      if (r.id === 'activity') expect(await left('.txl')).toBeLessThanOrEqual(brand);
      else expect(await left('.act-holders')).toBe(brand);
    }
  });
});

test.describe('once', () => {
  test.beforeEach(({}, info) => test.skip(onlyIn(info.project.name), 'viewport-independent: runs in 375x812'));

  test('a tag a signed-in wallet wrote never reads like a curated name: it says who wrote it, on moves and holder rows', async ({ page }) => {
    const TAGGED = 'tnam1qfixturetaggedxxxxxxxxxxxxxxxxxxxxxx9abcd';
    await page.route(/\/api\/flows\?/, async (route) => {
      const res = await route.fetch().catch(() => null);
      const j = res ? await res.json().catch(() => null) : null;
      if (!j) return route.abort().catch(() => undefined);
      if (Array.isArray(j.flows) && j.flows.length) {
        j.flows[0] = {
          ...j.flows[0], chain: 'namada', kind: 'unshield', amount: 25_000, poolId: null, meta: null,
          from: 'tnam1pcqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzmefah', fromLabel: null, fromLabelPlain: 'Shielded pool', fromLabelSource: 'auto', fromLabelAuthor: null,
          to: TAGGED, toLabel: 'Big exchange', toLabelPlain: 'Big exchange', toLabelSource: 'user', toLabelAuthor: 'tnam1qxyzabc…',
        };
      }
      await route.fulfill({ response: res!, json: j });
    });
    await gotoRoute(page, ACT.path);
    const row = page.locator('main .tx').filter({ hasText: 'Big exchange' }).first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row.locator('.tx__by')).toHaveText('Tag by tnam1qxyzabc…');
    // screen readers hear it in the button's name; the curated "Shielded pool" gets no byline
    await expect(row.locator('.tx__addr', { hasText: 'Big exchange' })).toContainText('tag by tnam1qxyzabc…');
    await expect(row.locator('.tx__by')).toHaveCount(1);

    await page.route('**/api/holders?**', async (route) => {
      const res = await route.fetch().catch(() => null);
      const j = res ? await res.json().catch(() => null) : null;
      if (!j) return route.abort().catch(() => undefined);
      if (Array.isArray(j.holders) && j.holders.length) {
        Object.assign(j.holders[0], { label: 'Team wallet', label_plain: 'Team wallet', category: 'team', category_plain: 'Team', label_source: 'user', label_author: null });
      }
      await route.fulfill({ response: res!, json: j });
    });
    await gotoRoute(page, HOL.path);
    const first = page.locator('main .hrow').first();
    await expect(first).toContainText('Team wallet', { timeout: 30_000 });
    // the byline replaces the category, without the ring glyph of a curated category
    await expect(first.locator('.hrow__tags .tag')).toHaveText('Tag by a signed-in wallet');
    await expect(first.locator('.hrow__tags .tag .gly')).toHaveCount(0);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('the route text from shared/copy.ts is visible on both tabs', async ({ page }) => {
    for (const r of [ACT, HOL]) {
      await gotoRoute(page, r.path);
      for (const p of BODY[r.id].paras) await expect(page.locator('main').getByText(p, { exact: true })).toBeVisible();
    }
  });

  test('tabs are real links and keep ?at=', async ({ page }) => {
    await gotoRoute(page, `${ACT.path}?at=${REWIND_AT}`);
    const tab = page.locator('main nav.utabs a', { hasText: 'Holders' });
    await expect(tab).toHaveAttribute('href', `/holders?at=${REWIND_AT}`);
    await tab.click();
    await expect(page).toHaveURL(`/holders?at=${REWIND_AT}`);
    await expect(page.locator('h1')).toHaveText(HOL.h1);
    await page.locator('main nav.utabs a', { hasText: 'Transactions' }).click();
    await expect(page).toHaveURL(`/activity?at=${REWIND_AT}`);
    await expect(page.locator('h1')).toHaveText(ACT.h1);
  });

  test('rewound Transactions: every /api request carries at, nothing live-only, rows at or before that time', async ({ page }) => {
    const reqs = trackRequests(page);
    await gotoRoute(page, `${ACT.path}?at=${REWIND_AT}`);
    await expect(page.locator('.rwb')).toBeVisible();
    await expect(page.locator('main .tx').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.act-count')).toContainText('at or before 30 Aug 2026');
    const urls = apiUrls(reqs, new URL(page.url()).origin);
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) {
      expect(isLiveOnly(u.pathname), u.pathname).toBe(false);
      if (!isExempt(u.pathname)) expect(u.searchParams.get('at'), u.pathname).toBe(String(REWIND_AT));
    }
    const times = await page.locator('main .tx time').evaluateAll((els) => els.map((e) => Date.parse(e.getAttribute('datetime') ?? '')));
    for (const t of times) expect(t).toBeLessThanOrEqual(REWIND_AT);
    const a = await layoutAudit(page, 'main');
    expect(a.overflowX).toBe(false);
  });

  test('rewound Holders: balances are said to be current, not as of the rewound time', async ({ page }) => {
    await gotoRoute(page, `${HOL.path}?at=${REWIND_AT}`);
    await expect(page.locator('main .hrow').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('main').getByText('Balances were not recorded over time', { exact: false }).first()).toBeVisible();
    await expect(page.locator('.act-scope .srcb')).toContainText('current, not as of the rewound time');
  });

  test('holders: two-line rows with a share bar, the 7-day rule, sort and Osmosis', async ({ page }) => {
    await gotoRoute(page, HOL.path);
    await expect(page.locator('main .hrow').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('main .hrow .hrow__bar').first()).toBeVisible();
    // the 7-day column only when a value is not zero; otherwise it is said once
    const chg = await page.locator('.dl--chg').count();
    if (!chg) await expect(page.locator('.act-sentence')).toContainText('7 days');
    // sort by staked, then the Osmosis list
    const sheet = page.getByRole('dialog', { name: 'Filter holders' });
    await openSheet(page, sheet);
    await sheet.locator('.seg__opt', { hasText: 'Staked' }).click();
    await expect(page.locator('.act-count')).toContainText('biggest first by staked NAM');
    await sheet.locator('.seg__opt', { hasText: 'Osmosis' }).click();
    await sheet.locator('.sheet__foot .btn--primary').click();
    await expect(page.locator('.act-count')).toContainText('on Osmosis');
    // rows, or the considered empty state when the list did not come back
    await expect(page.locator('main .hrow, main .empty').first()).toBeVisible({ timeout: 30_000 });
  });

  test('reduced motion: nothing animates once the lists are in', async ({ page }) => {
    for (const r of [ACT, HOL]) {
      await gotoRoute(page, r.path, { reducedMotion: true });
      await expect(page.locator(r.id === 'activity' ? 'main .tx' : 'main .hrow').first()).toBeVisible({ timeout: 30_000 });
      expect(await animationsIn(page, 'main')).toBe(0);
    }
  });

  test('numbered pages: › goes to page 2 (ranks 51 to 100, focus on the first row), Back returns, a typed page, Last', async ({ page }) => {
    await gotoRoute(page, HOL.path);
    const rows = page.locator('main .act-holders .hrow');
    const rank = (i: number) => rows.nth(i).locator('.hrow__rk');
    await expect(rows.first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.act-count')).toContainText(/^A total of [\d,]+ holders found on Namada/);
    await expect(rank(0)).toHaveText('1');
    // "Load more" is gone: numbered pages, the page field and the two ends, above and under the list
    await expect(page.getByRole('button', { name: /Load more/ })).toHaveCount(0);
    await expect(page.locator('main nav.pager')).toHaveCount(2);
    const head = page.locator('.act-pager--head');
    await expect(head.getByRole('link', { name: 'First page' })).toHaveAttribute('aria-disabled', 'true');
    await expect(head.getByRole('link', { name: 'Previous page' })).toHaveAttribute('tabindex', '-1');
    // the links are real: the href carries ?page=
    await expect(head.getByRole('link', { name: 'Next page' })).toHaveAttribute('href', '/holders?page=2');

    await head.getByRole('link', { name: 'Next page' }).click();
    await expect(page).toHaveURL(/\/holders\?page=2$/);
    await expect(rank(0)).toHaveText('51', { timeout: 30_000 });
    await expect(rows).toHaveCount(50);
    await expect(rank(49)).toHaveText('100');
    await expect(rows.first()).toBeFocused();
    await expect(head.getByRole('textbox', { name: 'Page number' })).toHaveValue('2');

    await page.goBack();
    await expect(page).toHaveURL(/\/holders$/);
    await expect(rank(0)).toHaveText('1', { timeout: 30_000 });

    // a typed page: 25 and Enter
    const field = head.getByRole('textbox', { name: 'Page number' });
    await field.fill('25');
    await field.press('Enter');
    await expect(page).toHaveURL(/\/holders\?page=25$/);
    await expect(rank(0)).toHaveText('1,201', { timeout: 30_000 });

    // a page past the end goes to the last page and says so
    const last = Number((await head.locator('.pager__of [data-num]').innerText()).replace(/\D/g, ''));
    expect(last).toBeGreaterThan(25);
    await field.fill(String(last + 1000));
    await field.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/holders\\?page=${last}$`));
    await expect(head.locator('.pager__msg')).toContainText('this is the last');
    await page.goBack();
    await expect(page).toHaveURL(/\/holders\?page=25$/);

    // Last: the last page, its ends disabled
    await head.getByRole('link', { name: 'Last page' }).click();
    await expect(page).toHaveURL(new RegExp(`/holders\\?page=${last}$`));
    await expect(rank(0)).toHaveText(((last - 1) * 50 + 1).toLocaleString('en-US'), { timeout: 30_000 });
    await expect(head.getByRole('link', { name: 'Next page' })).toHaveAttribute('aria-disabled', 'true');
    await expect(head.getByRole('link', { name: 'Last page' })).toHaveAttribute('aria-disabled', 'true');
  });

  test('numbered pages on Transactions: › replaces the rows and focuses the first, its URL carries the server position, the count line, Back', async ({ page }) => {
    await gotoRoute(page, ACT.path);
    const rows = page.locator('main .txl .tx');
    await expect(rows.first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.act-count')).toContainText(/A total of [\d,]+ moves found/);
    const foot = page.locator('.act-pager--foot');
    await foot.getByRole('link', { name: 'Next page' }).click();
    // a page read by › carries the server's position (FlowsResponse.next) next to ?page= (urlState.ts), so the server
    // seeks to it instead of walking an offset and counting again
    await expect(page).toHaveURL(/\/activity\?page=2&cursor=[\w-]+$/);
    await expect(page.locator('main .act-scope')).not.toHaveAttribute('aria-busy', 'true', { timeout: 30_000 });
    await expect(rows.first()).toBeFocused();
    expect(await rows.count()).toBeLessThanOrEqual(50);
    await page.goBack();
    await expect(page).toHaveURL(/\/activity$/);
    await expect(page.locator('.act-pager--head').getByRole('textbox', { name: 'Page number' })).toHaveValue('1');
  });

  test('address rows open the Address sheet', async ({ page }) => {
    await gotoRoute(page, HOL.path);
    const name = page.locator('main .hrow .act-name').first();
    await expect(name).toBeVisible({ timeout: 30_000 });
    await name.click();
    await expect(page).toHaveURL(/[?&]addr=tnam1/);
  });

  test('CSV export links exist on both tabs', async ({ page }) => {
    await gotoRoute(page, ACT.path);
    await expect(page.locator('main a.act-csv[download]')).toBeVisible({ timeout: 30_000 });
    await gotoRoute(page, HOL.path);
    await expect(page.locator('main a.act-csv[download]')).toHaveAttribute('href', /\/api\/export\/holders\?chain=namada/);
  });

  test('N7: a move pushed through the stream appears on top with its source text, animated in', async ({ page }) => {
    const id = `e2e-${Date.now()}`;
    const flow = {
      id, chain: 'osmosis', height: 1, ts: Date.now(), txHash: 'E2ETESTHASH', kind: 'sell',
      from: 'osmo1e2etestaddressxxxxxxxxxxxxxxxxxxxxxx', to: null, amount: 12345.6, counterDenom: 'USDC', counterAmount: 12.3456,
      poolId: '3005', priceUsd: 0.001, valueUsd: 12.3456, meta: { priceSource: 'execution' },
    };
    await page.routeWebSocket('**/ws', (ws) => {
      setTimeout(() => ws.send(JSON.stringify({ type: 'flows', flows: [flow] })), 4000);
    });
    await gotoRoute(page, ACT.path);
    await expect(page.locator('main .tx').first()).toBeVisible({ timeout: 30_000 });
    const row = page.locator('main .tx.is-new').first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row.locator('.tx__nam')).toContainText('12,346');
    await row.locator('.tx__tog').click();
    await expect(row.locator('.tx__more')).toContainText('from this trade itself');
  });
});

// ---------------------------------------------------------------------------------------------
// List controls (nav-search-plan 2.3 to 2.6, 3.3, 3.4): Go to rank, rows per page, Back with the scroll
// offset, the title, the column-head sort, the keys, the sticky list head on phones.
// ---------------------------------------------------------------------------------------------

/** Where a row sits against what stays stuck at the top (header, banner, the list head when sticky). */
async function rowPlacement(page: Page, row: Locator) {
  return row.evaluate((el) => {
    let stuck = 0;
    for (const s of [document.querySelector('header.hdr'), document.querySelector('.rwb'), document.querySelector('.act-head'), document.querySelector('.dl__head, .txl__head')]) {
      if (!(s instanceof HTMLElement)) continue;
      const cs = getComputedStyle(s);
      if (cs.display === 'none' || (cs.position !== 'sticky' && cs.position !== 'fixed')) continue;
      const r = s.getBoundingClientRect();
      // a sticky element counts only where it is stuck (at its `top`), or wherever it is when that is lower
      if (r.bottom > 0 && r.top <= (parseFloat(cs.top) || 0) + 1) stuck = Math.max(stuck, r.bottom);
    }
    const r = el.getBoundingClientRect();
    const tab = document.querySelector('nav.tabbar')?.getBoundingClientRect();
    const floor = tab && getComputedStyle(document.querySelector('nav.tabbar')!).display !== 'none' ? tab.top : window.innerHeight;
    return { top: r.top, bottom: r.bottom, stuck, floor };
  });
}

async function listReady(page: Page, row = '.hrow') {
  await expect(page.locator(`main ${row}`).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('main .act-scope')).not.toHaveAttribute('aria-busy', 'true', { timeout: 30_000 });
}

test.describe('list controls', () => {
  test('Go to rank 1,204 lands on ?page=25 with that row focused, highlighted and in view under the sticky stack (375, 1280)', async ({ page }, info) => {
    test.skip(!['375x812', '1280x800'].includes(info.project.name), 'runs at 375 and 1280');
    await gotoRoute(page, HOL.path);
    await listReady(page);
    const field = page.getByRole('textbox', { name: 'Go to rank' });
    await field.fill('1,204');
    await field.press('Enter');
    await expect(page).toHaveURL(/\/holders\?page=25$/);
    const row = page.locator('main .act-holders .hrow', { has: page.locator('.hrow__rk', { hasText: /^1,204$/ }) });
    await expect(row).toBeFocused({ timeout: 30_000 });
    await expect(row).toHaveClass(/is-hit/);
    const p = await rowPlacement(page, row);
    expect(p.top, `the row starts under the sticky stack (${p.stuck})`).toBeGreaterThanOrEqual(p.stuck - 1);
    expect(p.bottom, 'the row ends above the tab bar or the window edge').toBeLessThanOrEqual(p.floor + 1);
    // the same page: no history entry, the row is reached in place
    await field.fill('1201');
    await field.press('Enter');
    await expect(page.locator('main .act-holders .hrow', { has: page.locator('.hrow__rk', { hasText: /^1,201$/ }) })).toBeFocused();
    await expect(page).toHaveURL(/\/holders\?page=25$/);
    // past the end: one plain sentence with the stamped count; the page stays
    await field.fill('99999999');
    await field.press('Enter');
    const msg = page.locator('.act-tools .pgtools__msg');
    await expect(msg).toContainText(/^There are [\d,]+ holders; pick a rank up to that\.$/);
    await expect(msg.locator('[data-num]')).toHaveCount(1);
    await expect(page).toHaveURL(/\/holders\?page=25$/);
  });

  test('rows per page: 100 gives 100 rows and ?size=100, the pages follow; 50 drops it from the URL', async ({ page }, info) => {
    test.skip(onlyIn(info.project.name), 'runs once');
    await gotoRoute(page, HOL.path);
    await listReady(page);
    const rows = page.locator('main .act-holders .hrow');
    await expect(rows).toHaveCount(50);
    const pages50 = Number((await page.locator('.act-pager--head .pager__of [data-num]').innerText()).replace(/\D/g, ''));
    await page.locator('.act-tools .seg__opt', { hasText: /^100$/ }).click();
    await expect(page).toHaveURL(/\/holders\?size=100$/);
    await listReady(page);
    await expect(rows).toHaveCount(100);
    await expect(rows.nth(99).locator('.hrow__rk')).toHaveText('100');
    const pages100 = Number((await page.locator('.act-pager--head .pager__of [data-num]').innerText()).replace(/\D/g, ''));
    expect(pages100).toBe(Math.ceil(pages50 / 2));
    // the size survives a page change and the pager's links carry it
    await expect(page.locator('.act-pager--head').getByRole('link', { name: 'Next page' })).toHaveAttribute('href', '/holders?size=100&page=2');
    await page.locator('.act-tools .seg__opt', { hasText: /^25$/ }).click();
    await expect(page).toHaveURL(/\/holders\?size=25$/);
    await expect(rows).toHaveCount(25, { timeout: 30_000 });
    await page.locator('.act-tools .seg__opt', { hasText: /^50$/ }).click();
    await expect(page).toHaveURL(/\/holders$/);
    await expect(rows).toHaveCount(50, { timeout: 30_000 });
    // a size in the address bar that is not offered falls back to 50 and is dropped
    await gotoRoute(page, `${HOL.path}?size=7`);
    await expect(page).toHaveURL(/\/holders$/);
  });

  test('Back after a page change restores the page and the scroll offset; the title carries the page', async ({ page }, info) => {
    test.skip(!['375x812', '1280x800'].includes(info.project.name), 'runs at 375 and 1280');
    await gotoRoute(page, HOL.path);
    await listReady(page);
    const foot = page.locator('.act-pager--foot');
    await foot.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const y1 = await page.evaluate(() => Math.round(window.scrollY));
    expect(y1).toBeGreaterThan(500);
    await foot.getByRole('link', { name: 'Next page' }).click();
    await expect(page).toHaveURL(/\/holders\?page=2$/);
    await listReady(page);
    await expect(page.locator('main .act-holders .hrow').first().locator('.hrow__rk')).toHaveText('51');
    await expect(page).toHaveTitle(`Holders, page 2 · ${SITE.name}`);
    const y2 = await page.evaluate(() => Math.round(window.scrollY));
    expect(y2).toBeLessThan(y1);
    await page.goBack();
    await expect(page).toHaveURL(/\/holders$/);
    await expect(page.locator('main .act-holders .hrow').first().locator('.hrow__rk')).toHaveText('1', { timeout: 30_000 });
    await expect.poll(() => page.evaluate(() => Math.round(window.scrollY)), { timeout: 10_000 }).toBeGreaterThanOrEqual(y1 - 2);
    expect(Math.abs((await page.evaluate(() => Math.round(window.scrollY))) - y1)).toBeLessThanOrEqual(2);
    await expect(page).not.toHaveTitle(/page/);
    // Forward: page 2 again, at the offset it was left at
    await page.goForward();
    await expect(page).toHaveURL(/\/holders\?page=2$/);
    await expect.poll(() => page.evaluate(() => Math.round(window.scrollY)), { timeout: 10_000 }).toBeLessThanOrEqual(y2 + 2);
    await expect(page).toHaveTitle(`Holders, page 2 · ${SITE.name}`);
  });

  test('column heads sort the desktop holder list: aria-sort on the head, the order in the count line, page 1', async ({ page }, info) => {
    test.skip(info.project.name !== '1280x800', 'the column heads show from 1024 px');
    await gotoRoute(page, `${HOL.path}?page=3`);
    await listReady(page);
    const head = (name: string) => page.locator('.act-holders .dl__head [role="columnheader"]', { has: page.getByRole('button', { name }) });
    await expect(head('Total NAM, biggest first')).toHaveAttribute('aria-sort', 'descending');
    await expect(head('Spendable, biggest first')).toHaveAttribute('aria-sort', 'none');
    // 7 days and the other heads are plain text, without aria-sort
    await expect(page.locator('.act-holders .dl__head [role="columnheader"]:not([aria-sort])')).toHaveCount(await page.locator('.act-holders .dl__head [role="columnheader"]').count() - 3);
    await page.getByRole('button', { name: 'Spendable, biggest first' }).click();
    await expect(page.locator('.act-count')).toContainText('biggest first by spendable NAM');
    // the sort is in the URL (nav-search-plan 2.4), and a new sort starts from page 1
    await expect(page).toHaveURL(/\/holders\?by=spendable$/);
    await expect(head('Spendable, biggest first')).toHaveAttribute('aria-sort', 'descending');
    await expect(head('Total NAM, biggest first')).toHaveAttribute('aria-sort', 'none');
    await listReady(page);
    await expect(page.locator('main .act-holders .hrow').first().locator('.hrow__rk')).toHaveText('1');
    // the inline "Biggest by" choice follows
    await expect(page.locator('.act-filters').getByRole('radio', { name: 'Spendable' })).toBeChecked();
    await page.getByRole('button', { name: 'Staked, biggest first' }).click();
    await expect(page.locator('.act-count')).toContainText('biggest first by staked NAM');
    await expect(page).toHaveURL(/\/holders\?by=staked$/);
    // Back undoes the sort
    await page.goBack();
    await expect(page).toHaveURL(/\/holders\?by=spendable$/);
    await expect(head('Spendable, biggest first')).toHaveAttribute('aria-sort', 'descending');
  });

  test('keys: j and k walk the rows, ] and [ change the page, Enter opens the address; nothing while typing', async ({ page }, info) => {
    test.skip(!['375x812', '1280x800'].includes(info.project.name), 'runs at 375 and 1280');
    await gotoRoute(page, `${HOL.path}?page=2`);
    await listReady(page);
    const rk = (s: string) => page.locator('main .act-holders .hrow', { has: page.locator('.hrow__rk', { hasText: new RegExp(`^${s}$`) }) });
    await page.locator('main h1').click();
    await page.keyboard.press('j');
    await expect(rk('51')).toBeFocused();
    await page.keyboard.press('j');
    await page.keyboard.press('j');
    await expect(rk('53')).toBeFocused();
    const p = await rowPlacement(page, rk('53'));
    expect(p.top).toBeGreaterThanOrEqual(p.stuck - 1);
    await page.keyboard.press('k');
    await expect(rk('52')).toBeFocused();
    // one tab stop: the row walked to
    await expect(rk('52')).toHaveAttribute('tabindex', '0');
    await expect(rk('51')).toHaveAttribute('tabindex', '-1');
    await page.keyboard.press(']');
    await expect(page).toHaveURL(/\/holders\?page=3$/);
    await expect(rk('101')).toBeFocused({ timeout: 30_000 });
    const q = await rowPlacement(page, rk('101'));
    expect(q.top, 'the sticky list head does not cover the focused row').toBeGreaterThanOrEqual(q.stuck - 1);
    await page.keyboard.press('[');
    await expect(page).toHaveURL(/\/holders\?page=2$/);
    await expect(rk('51')).toBeFocused({ timeout: 30_000 });
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/[?&]addr=tnam1/);
    const sheet = page.locator('dialog[open]');
    await expect(sheet).toBeVisible();
    // while the sheet is open the list keys rest
    await page.keyboard.press(']');
    await expect(page).toHaveURL(/\/holders\?page=2&addr=/);
    await sheet.getByRole('button', { name: /^Close/ }).first().click();
    await expect(page).not.toHaveURL(/[?&]addr=/);
    // typing: the keys are text in the rank field and in the page field
    const field = page.getByRole('textbox', { name: 'Go to rank' });
    await field.click();
    await page.keyboard.type('j]k[');
    await expect(field).toHaveValue('j]k[');
    await expect(field).toBeFocused();
    await expect(page).toHaveURL(/\/holders\?page=2$/);
    const pf = page.locator('.act-pager--head').getByRole('textbox', { name: 'Page number' });
    await pf.click();
    await page.keyboard.press(']');
    await expect(page).toHaveURL(/\/holders\?page=2$/);
  });

  test('keys do nothing inside the search field', async ({ page }, info) => {
    test.skip(info.project.name !== '1280x800', 'the search field is inline from 1024 px');
    await gotoRoute(page, HOL.path);
    await listReady(page);
    const search = page.getByRole('searchbox', { name: 'Search holders by address or name' }).or(page.getByRole('textbox', { name: 'Search holders by address or name' }));
    await search.first().click();
    await page.keyboard.press(']');
    await page.keyboard.press('j');
    await expect(search.first()).toBeFocused();
    await expect(search.first()).toHaveValue(']j');
    await expect(page).not.toHaveURL(/page=2/);
  });

  test('phones: the count line and the pager stay under the header; a page change leaves the first row clear of them', async ({ page }, info) => {
    test.skip(!['360x780', '375x812'].includes(info.project.name), 'phones');
    await gotoRoute(page, `${HOL.path}?page=3`);
    await listReady(page);
    await page.evaluate(() => window.scrollBy(0, 2400));
    await page.waitForTimeout(200);
    const head = page.locator('.act-head');
    const hb = (await head.boundingBox())!;
    const hdr = (await page.locator('header.hdr').boundingBox())!;
    expect(Math.abs(hb.y - (hdr.y + hdr.height)), 'stuck under the header').toBeLessThanOrEqual(2);
    await expect(head.getByRole('link', { name: 'Next page' })).toBeInViewport();
    await head.getByRole('link', { name: 'Next page' }).click();
    await expect(page).toHaveURL(/\/holders\?page=4$/);
    const first = page.locator('main .act-holders .hrow').first();
    await expect(first.locator('.hrow__rk')).toHaveText('151', { timeout: 30_000 });
    await expect(first).toBeFocused();
    const p = await rowPlacement(page, first);
    expect(p.top).toBeGreaterThanOrEqual(p.stuck - 1);
    expect(p.top - p.stuck, 'right under the stuck head').toBeLessThanOrEqual(24);
  });

  test('rewound on a phone: the list head sits under the banner', async ({ page }, info) => {
    test.skip(info.project.name !== '375x812', 'runs at 375');
    await gotoRoute(page, `${HOL.path}?at=${REWIND_AT}`);
    await listReady(page);
    await page.evaluate(() => window.scrollBy(0, 2400));
    await page.waitForTimeout(200);
    const hb = (await page.locator('.act-head').boundingBox())!;
    const bb = (await page.locator('.rwb').boundingBox())!;
    expect(hb.y).toBeGreaterThanOrEqual(bb.y + bb.height - 1);
  });

  test('Transactions: Show moves from before a day reads the list as of that day; Show the newest clears it', async ({ page }, info) => {
    test.skip(onlyIn(info.project.name), 'runs once');
    const reqs = trackRequests(page);
    await gotoRoute(page, ACT.path);
    await listReady(page, '.tx');
    const day = page.getByLabel('Show moves from before');
    await day.fill('2026-01-01');
    await page.locator('.act-tools').getByRole('button', { name: 'Show' }).click();
    const ms = Date.UTC(2026, 0, 1);
    await expect(page).toHaveURL(new RegExp(`/activity\\?before=${ms}$`));
    await expect(page.locator('.act-count')).toContainText('before 1 Jan 2026 (UTC)', { timeout: 30_000 });
    await expect.poll(() => reqs.some((r) => r.url().includes('/api/flows?') && new URL(r.url()).searchParams.get('at') === String(ms - 1))).toBe(true);
    await expect(page.locator('main .tx, main .empty').first()).toBeVisible({ timeout: 30_000 });
    // a day to come is refused in words
    await day.fill('2999-01-01');
    await page.locator('.act-tools').getByRole('button', { name: 'Show' }).click();
    await expect(page.locator('.act-tools .pgtools__msg')).toContainText('has not come yet');
    await page.locator('.act-count').getByRole('link', { name: 'Show the newest' }).click();
    await expect(page).toHaveURL(/\/activity$/);
    await expect(page.locator('.act-count')).not.toContainText('before');
  });

  test('the new controls: 44 px targets, no sideways scroll (360, 375, 1280)', async ({ page }, info) => {
    test.skip(!['360x780', '375x812', '1280x800'].includes(info.project.name), 'runs at 360, 375 and 1280');
    for (const path of [`${HOL.path}?page=25`, `${ACT.path}?size=25`]) {
      await gotoRoute(page, path);
      await listReady(page, path.startsWith('/holders') ? '.hrow' : '.tx');
      const boxes = await page.locator('.act-tools').evaluate((root) =>
        [...root.querySelectorAll('a, input:not([type="radio"]), button, .seg__opt')].filter((el) => el.getBoundingClientRect().width > 0).map((el) => {
          const r = el.getBoundingClientRect();
          return { name: el.getAttribute('aria-label') ?? el.textContent ?? '', w: r.width, h: r.height, right: r.right };
        }),
      );
      expect(boxes.length).toBeGreaterThanOrEqual(5);
      for (const b of boxes) {
        expect(b.w, `${path} ${b.name} width`).toBeGreaterThanOrEqual(44);
        expect(b.h, `${path} ${b.name} height`).toBeGreaterThanOrEqual(44);
        expect(b.right, `${path} ${b.name} inside the viewport`).toBeLessThanOrEqual(page.viewportSize()!.width);
      }
      const a = await layoutAudit(page, 'main');
      expect(a.overflowX, `${path}: scrollWidth ${a.scrollWidth} > ${a.innerWidth}`).toBe(false);
      expect(a.smallTargets).toEqual([]);
      expect(a.smallText).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The lists on the stored-totals and cursor server (nav-search-plan 2.1, 2.2, 2.4, 2.5, 3.5, 4.3). The production
// server answers in that shape, but its counts and rows change, so these tests mock the answers, shaped exactly like
// shared/types.ts (HoldersResponse with asOf, countsAt and categories; FlowsResponse with next, asOf, firstTs and last,
// total null behind a cursor), and assert fixed figures. The stream is mocked silent, so no live move lands on top of
// the mocked rows.
// ---------------------------------------------------------------------------------------------
const B32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
/** A bech32-shaped address for row i: tnam1 + 40 data characters, osmo1 + 38. */
const fxAddr = (i: number, prefix: 'tnam1' | 'osmo1' = 'tnam1') => {
  let s = '';
  for (let k = 0, n = i; k < 8; k++, n = Math.floor(n / 32)) s = B32[n % 32] + s;
  return `${prefix}qx${'q'.repeat(prefix === 'tnam1' ? 30 : 28)}${s}`;
};
const HTOTAL = 64_377;
const H_CATS = { total: HTOTAL, counts: [{ category: 'backer', n: 248 }, { category: 'genesis', n: 120 }, { category: 'none', n: HTOTAL - 368 }] };
function fxHolder(rank: number, o: Record<string, unknown> = {}) {
  const now = Date.now();
  const total = Math.round(60_000_000 / rank);
  return {
    rank, chain: 'namada', address: fxAddr(rank), balance: total * 0.7, bonded: total * 0.3, bondedEstimated: total * 0.3, bondedVerifiedAt: now - 60_000,
    total, pctSupply: (total / 1.15e9) * 100, change24h: 0, change7d: 0, label: null, category: null, label_plain: null, category_plain: null,
    label_source: null, label_author: null, linked: [], updatedAt: now - 60_000, verifiedAt: now - 60_000, status: 'live', statusNote: null, ...o,
  };
}
/** /api/holders as the stored-totals server answers it. `countsAt(page)`: when the count of that page's answer was taken. */
async function mockHolders(page: Page, seen: URL[] = [], countsAt: (pg: number) => number = () => Date.now() - 120_000) {
  await page.route(/\/api\/holders\?/, (route) => {
    const u = new URL(route.request().url());
    seen.push(u);
    const limit = Number(u.searchParams.get('limit') ?? 50);
    const pg = Number(u.searchParams.get('page') ?? 1);
    const cat = u.searchParams.get('category');
    const total = cat ? H_CATS.counts.find((c) => c.category === cat)?.n ?? 0 : HTOTAL;
    const start = (pg - 1) * limit;
    const extra = cat === 'genesis' ? { category: 'genesis', category_plain: 'Genesis', label: 'Genesis: fixture', label_plain: 'Genesis allocation', label_source: 'genesis' } : {};
    const holders = Array.from({ length: Math.max(0, Math.min(limit, total - start)) }, (_, i) => fxHolder(start + i + 1, extra));
    return route.fulfill({ json: { total, page: pg, limit, holders, next: start + limit < total ? 'WzEsInRuYW0xIiwxXQ' : null, asOf: Date.now() - 30_000, countsAt: u.searchParams.get('search') ? null : countsAt(pg), categories: H_CATS } });
  });
}

const FTOTAL = 2_000;
const fxHash = (i: number) => (i.toString(16).toUpperCase().padStart(8, '0') + 'AB'.repeat(28)).slice(0, 64);
function fxFlow(i: number, base: number, kind = i % 2 ? 'sell' : 'buy') {
  const trader = fxAddr(i, 'osmo1');
  return {
    id: `fx:${i}`, chain: 'osmosis', height: 72_000_000 - i, ts: base - i * 60_000, txHash: fxHash(i), explorerHash: fxHash(i), kind,
    from: kind === 'sell' ? trader : null, to: kind === 'buy' ? trader : null, amount: 150_000 + i, counterDenom: 'USDC', counterAmount: 171, poolId: '3005',
    priceUsd: 0.00114, valueUsd: 171, meta: { trader }, fromLabel: null, toLabel: null, fromLabelPlain: null, toLabelPlain: null,
    fromLabelSource: null, toLabelSource: null, fromLabelAuthor: null, toLabelAuthor: null, whale: true,
  };
}
/** A moves position as the server makes it (shared/paging.ts encodeFlowCursor): base64url of [ts, height, id]. */
const fxCursor = (f: { ts: number; height: number; id: string }) => Buffer.from(JSON.stringify([f.ts, f.height, f.id])).toString('base64url');
/** /api/flows as the cursor server answers it: counted only without a position; `next` the last row's position. */
async function mockFlows(page: Page, seen: URL[] = [], o: { total?: number; firstTs?: number; last?: { id: string; ts: number; chain: string } | null } = {}) {
  const base = Date.now() - 5 * 60_000;
  const total = o.total ?? FTOTAL;
  await page.route(/\/api\/flows\?/, (route) => {
    const u = new URL(route.request().url());
    seen.push(u);
    const limit = Number(u.searchParams.get('limit') ?? 50);
    const before = u.searchParams.get('before');
    const kind = u.searchParams.get('kind');
    let start = 0;
    let head = true;
    if (before && !/^\d+$/.test(before)) {
      const [, , id] = JSON.parse(Buffer.from(before, 'base64url').toString()) as [number, number, string];
      start = Number(id.slice(3)) + 1;
      head = false;
    } else start = (Number(u.searchParams.get('page') ?? 1) - 1) * limit;
    const flows = Array.from({ length: Math.max(0, Math.min(limit, total - start)) }, (_, i) => fxFlow(start + i, base, kind === 'sell' || kind === 'buy' ? kind : undefined));
    const lastRow = flows[flows.length - 1];
    return route.fulfill({
      json: {
        total: head ? total : null, page: head ? Number(u.searchParams.get('page') ?? 1) : 1, limit, flows,
        next: lastRow && start + flows.length < total ? fxCursor(lastRow) : null, asOf: Date.now(),
        ...(head ? { firstTs: o.firstTs ?? Date.UTC(2024, 11, 3) } : {}),
        ...(head && !flows.length && o.last !== undefined ? { last: o.last } : {}),
      },
    });
  });
}
const silentStream = (page: Page) => page.routeWebSocket('**/ws', () => {});
const wideOf = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1024;

test.describe('the lists on the stored-totals and cursor server (route mocks)', () => {
  test('holders: the count is over the whole list and says when the order was read; the What counts too; the table says its length', async ({ page }, info) => {
    test.skip(!['375x812', '1280x800'].includes(info.project.name), 'runs at 375 and 1280');
    await silentStream(page);
    await mockHolders(page);
    await gotoRoute(page, HOL.path);
    await listReady(page);
    await expect(page.locator('.act-count')).toHaveText(/^A total of 64,377 holders found on Namada, biggest first by total NAM · ordered at \d\d:\d\d\sUTC\.$/);
    await expect(page.locator('.act-holders')).toHaveAttribute('aria-rowcount', String(HTOTAL + 1));
    await expect(page.locator('main .act-holders .hrow').first()).toHaveAttribute('aria-rowindex', '2');
    await expect(page.locator('.act-scope .srcb')).toHaveAttribute('data-scope', /Holder count and order/);
    // the What chips count every holder (the server's categories), not the rows on this page
    const cats = wideOf(page) ? page.locator('.act-filters .act-cats') : page.getByRole('dialog', { name: 'Filter holders' }).locator('.act-cats');
    if (!wideOf(page)) await openSheet(page, page.getByRole('dialog', { name: 'Filter holders' }));
    await expect(cats.locator('legend')).toHaveText('What');
    await expect(cats.locator('.chipsel__o', { hasText: 'Backer' })).toContainText('248');
    await expect(cats.locator('.chipsel__o', { hasText: 'All' })).toContainText('64,377');
    // page 3: the rows say where they are in the whole list
    await gotoRoute(page, `${HOL.path}?page=3`);
    await listReady(page);
    await expect(page.locator('main .act-holders .hrow').first()).toHaveAttribute('aria-rowindex', '102');
  });

  test('holders: the field reads "genesis >1m" into two chips; Enter moves them into the URL; a chip removed leaves the other, focused', async ({ page }, info) => {
    test.skip(!['375x812', '1280x800'].includes(info.project.name), 'runs at 375 and 1280');
    const seen: URL[] = [];
    await silentStream(page);
    await mockHolders(page, seen);
    await gotoRoute(page, HOL.path);
    await listReady(page);
    const sheet = page.getByRole('dialog', { name: 'Filter holders' });
    if (!wideOf(page)) await openSheet(page, sheet);
    const field = (wideOf(page) ? page.locator('.act-bar') : sheet).getByRole('searchbox', { name: 'Search holders by address or name' });
    await field.fill('genesis >1m');
    await field.press('Enter');
    await expect(page).toHaveURL(/\/holders\?what=genesis&min=1000000$/);
    await expect(field).toHaveValue('');
    await expect.poll(() => seen.some((u) => u.searchParams.get('category') === 'genesis' && u.searchParams.get('min') === '1000000' && !u.searchParams.has('search'))).toBe(true);
    if (!wideOf(page)) {
      await sheet.locator('.sheet__foot .btn--primary').click();
      await expect(sheet).toBeHidden();
      await expect(page.locator('.act-filterbtn .badge')).toHaveText('2');
    }
    const chips = page.locator('main .act-chips .fchip:not(.fchip--clear)');
    await expect(chips).toHaveText([/Genesis only/, /At least 1,000,000 NAM/]);
    await expect(page.locator('.act-count')).toContainText('in “Genesis”');
    await page.getByRole('button', { name: 'Remove filter: Genesis only' }).click();
    await expect(page).toHaveURL(/\/holders\?min=1000000$/);
    await expect(page.getByRole('button', { name: 'Remove filter: At least 1,000,000 NAM' })).toBeFocused();
    // Back brings the chip back
    await page.goBack();
    await expect(page).toHaveURL(/\/holders\?what=genesis&min=1000000$/);
    await expect(chips).toHaveCount(2);
  });

  test('holders: a search names what it looks at when nothing matches; an address end stays in the text', async ({ page }, info) => {
    test.skip(onlyIn(info.project.name), 'runs once');
    const seen: URL[] = [];
    await silentStream(page);
    await page.route(/\/api\/holders\?/, (route) => {
      seen.push(new URL(route.request().url()));
      return route.fulfill({ json: { total: 0, page: 1, limit: 50, holders: [], next: null, asOf: Date.now(), countsAt: null, categories: { total: 0, counts: [] } } });
    });
    await gotoRoute(page, `${HOL.path}?q=${encodeURIComponent('…kj4m')}`);
    await expect(page.locator('main .empty')).toContainText('No holder matches “…kj4m”.');
    await expect(page.locator('main .empty')).toContainText('the start and the end of addresses');
    await expect(page.locator('main .act-chips .fchip')).toHaveText([/Address ends with kj4m/]);
    expect(seen.some((u) => u.searchParams.get('search') === '…kj4m')).toBe(true);
  });

  test('holders: the order counted again between two pages is said once, with a way back to the top', async ({ page }, info) => {
    test.skip(onlyIn(info.project.name), 'runs once');
    const t0 = Date.now() - 20 * 60_000;
    await silentStream(page);
    // page 1 was counted at t0; by the time page 2 is read, the counts were taken again ten minutes later
    await mockHolders(page, [], (pg) => (pg <= 1 ? t0 : t0 + 10 * 60_000));
    await gotoRoute(page, HOL.path);
    await listReady(page);
    await expect(page.locator('main .notice', { hasText: 'The list was refreshed' })).toHaveCount(0);
    await page.locator('.act-pager--head').getByRole('link', { name: 'Next page' }).click();
    await expect(page).toHaveURL(/\/holders\?page=2$/);
    const note = page.locator('main .notice', { hasText: 'The list was refreshed' });
    await expect(note).toBeVisible();
    await expect(note).toContainText(/counted again at \d\d:\d\d\sUTC while you were reading/);
    await note.getByRole('button', { name: 'Start from the top' }).click();
    await expect(page).toHaveURL(/\/holders$/);
    await expect(note).toHaveCount(0);
  });

  test('moves: a shared link ?what=sell&min=100000 opens filtered with two chips, the badge says 2, each chip removes its filter', async ({ page }, info) => {
    test.skip(!['375x812', '1280x800'].includes(info.project.name), 'runs at 375 and 1280');
    const seen: URL[] = [];
    await silentStream(page);
    await mockFlows(page, seen);
    await gotoRoute(page, `${ACT.path}?what=sell&min=100000`);
    await listReady(page, '.tx');
    await expect(page.locator('main .act-chips .fchip:not(.fchip--clear)')).toHaveText([/Sells only/, /At least 100,000 NAM/]);
    expect(seen.some((u) => u.searchParams.get('kind') === 'sell' && u.searchParams.get('minNam') === '100000')).toBe(true);
    if (!wideOf(page)) await expect(page.locator('.act-filterbtn .badge')).toHaveText('2');
    else await expect(page.locator('.act-filters').getByRole('radio', { name: '100,000+' })).toBeChecked();
    await expect(page.locator('.act-count')).toContainText(/^A total of 2,000 moves found that match the filters, newest first · read at \d\d:\d\d\sUTC\./);
    await page.getByRole('button', { name: 'Remove filter: At least 100,000 NAM' }).click();
    await expect(page).toHaveURL(/\/activity\?what=sell$/);
    if (!wideOf(page)) await expect(page.locator('.act-filterbtn .badge')).toHaveText('1');
    await page.getByRole('button', { name: 'Remove filter: Sells only' }).click();
    await expect(page).toHaveURL(/\/activity$/);
    await expect(page.locator('main .act-chips')).toHaveCount(0);
    // the last chip gone: focus goes to the search field (wide) or the Filter button (phones), never the page
    await expect(page.locator(wideOf(page) ? 'main [data-list-search] input' : 'main .act-filterbtn')).toBeFocused();
  });

  test('moves: "sell >100k last 7 days" applies as typed and, on Enter, becomes ?what=sell&min=100000&since=…', async ({ page }, info) => {
    test.skip(!['375x812', '1280x800'].includes(info.project.name), 'runs at 375 and 1280');
    const seen: URL[] = [];
    await silentStream(page);
    await mockFlows(page, seen);
    await gotoRoute(page, ACT.path);
    await listReady(page, '.tx');
    const sheet = page.getByRole('dialog', { name: 'Filter moves' });
    if (!wideOf(page)) await openSheet(page, sheet);
    const field = (wideOf(page) ? page.locator('.act-bar') : sheet).getByRole('searchbox', { name: 'Search moves by address or record' });
    const since = (() => {
      const d = new Date();
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - 6 * 86_400_000).toISOString().slice(0, 10);
    })();
    await field.fill('sell >100k last 7 days');
    // applied while typing: the text is in ?q=, the request carries the filters it understood
    await expect(page).toHaveURL(/\/activity\?q=sell\+%3E100k\+last\+7\+days$/);
    await expect.poll(() => seen.some((u) => u.searchParams.get('kind') === 'sell' && u.searchParams.get('minNam') === '100000' && u.searchParams.get('since') === String(Date.parse(`${since}T00:00:00Z`)) && !u.searchParams.has('search'))).toBe(true);
    await field.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/activity\\?what=sell&min=100000&since=${since}$`));
    await expect(field).toHaveValue('');
    if (!wideOf(page)) {
      await sheet.locator('.sheet__foot .btn--primary').click();
      await expect(page.locator('.act-filterbtn .badge')).toHaveText('3');
    }
    await expect(page.locator('main .act-chips .fchip:not(.fchip--clear)')).toHaveText([/Sells only/, /At least 100,000 NAM/, /Since \d+ \w{3} \d{4}/]);
    // Back: the list before the search (one history entry for the whole search)
    await page.goBack();
    await expect(page).toHaveURL(/\/activity$/);
  });

  test('moves: a word that is not a filter here keeps a chip that says so and filters nothing', async ({ page }, info) => {
    test.skip(onlyIn(info.project.name), 'runs once');
    const seen: URL[] = [];
    await silentStream(page);
    await mockFlows(page, seen);
    await gotoRoute(page, `${ACT.path}?q=foundation`);
    await listReady(page, '.tx');
    const chip = page.locator('main .act-chips .fchip--out');
    await expect(chip).toContainText('Foundation only');
    await expect(chip).toContainText('Not a filter on the moves list.');
    await expect(chip).toHaveAccessibleName(/^Remove: Foundation only, not applied\./);
    await expect(page.locator('.act-filterbtn .badge')).toHaveCount(0);
    expect(seen.every((u) => !u.searchParams.has('search') && !u.searchParams.has('kind'))).toBe(true);
  });

  test('moves: › reads the next page by the server position (no count, no offset), the count is kept, a typed page goes by number', async ({ page }, info) => {
    test.skip(!['375x812', '1280x800'].includes(info.project.name), 'runs at 375 and 1280');
    const seen: URL[] = [];
    await silentStream(page);
    await mockFlows(page, seen);
    await gotoRoute(page, ACT.path);
    await listReady(page, '.tx');
    const head = page.locator('.act-pager--head');
    await expect(head.locator('.pager__of')).toHaveText(/of\s40/);
    const nextHref = await head.getByRole('link', { name: 'Next page' }).getAttribute('href');
    expect(nextHref).toMatch(/^\/activity\?page=2&cursor=/);
    await head.getByRole('link', { name: 'Next page' }).click();
    await expect(page).toHaveURL(/\/activity\?page=2&cursor=[\w-]+$/);
    await listReady(page, '.tx');
    const req2 = seen[seen.length - 1];
    expect(req2.searchParams.get('before')).toBeTruthy();
    expect(JSON.parse(Buffer.from(req2.searchParams.get('before')!, 'base64url').toString())[2]).toBe('fx:49');
    // the server did not count behind the position; the count from page 1 is kept
    await expect(page.locator('.act-count')).toContainText('A total of 2,000 moves found');
    await expect(head.locator('.pager__of')).toHaveText(/of\s40/);
    await expect(head.getByRole('textbox', { name: 'Page number' })).toHaveValue('2');
    await expect(page.locator('main .txl')).toHaveAttribute('aria-rowcount', String(FTOTAL + 1));
    await expect(page.locator('main .txl .tx').first()).toHaveAttribute('aria-rowindex', '52');
    await expect(page.locator('main .txl .tx').first()).toBeFocused();
    await head.getByRole('link', { name: 'Next page' }).click();
    await expect(page).toHaveURL(/\/activity\?page=3&cursor=[\w-]+$/);
    await listReady(page, '.tx');
    expect(JSON.parse(Buffer.from(seen[seen.length - 1].searchParams.get('before')!, 'base64url').toString())[2]).toBe('fx:99');
    // Back: page 2 by its position again
    await page.goBack();
    await expect(page).toHaveURL(/\/activity\?page=2&cursor=/);
    // a typed page has no known position: it goes by number
    const pf = head.getByRole('textbox', { name: 'Page number' });
    await pf.fill('10');
    await pf.press('Enter');
    await expect(page).toHaveURL(/\/activity\?page=10$/);
    await listReady(page, '.tx');
    const req10 = seen[seen.length - 1];
    expect(req10.searchParams.get('page')).toBe('10');
    expect(req10.searchParams.has('before')).toBe(false);
  });

  test('moves: a page opened from its own link, behind a position, says the count is taken on the first page', async ({ page }, info) => {
    test.skip(onlyIn(info.project.name), 'runs once');
    await silentStream(page);
    await mockFlows(page);
    await gotoRoute(page, `${ACT.path}?page=3&cursor=${fxCursor(fxFlow(99, Date.now()))}`);
    await listReady(page, '.tx');
    await expect(page.locator('.act-pager--head .pager__of')).toContainText('—');
    await expect(page.locator('.act-pager--foot .pager__why')).toContainText('counts the moves only on the first page');
    await expect(page.locator('.act-count')).toHaveText(/^Moves 101 to 150, newest first · read at \d\d:\d\d\sUTC\.$/);
    await expect(page.locator('main .txl')).toHaveAttribute('aria-rowcount', '-1');
    await expect(page.locator('.act-pager--head').getByRole('link', { name: 'Next page' })).not.toHaveAttribute('aria-disabled', 'true');
  });

  test('moves: a day before the flow index starts says so, with the first day recorded', async ({ page }, info) => {
    test.skip(onlyIn(info.project.name), 'runs once');
    await silentStream(page);
    await mockFlows(page, [], { total: 0, firstTs: Date.UTC(2024, 11, 3, 9) });
    await gotoRoute(page, `${ACT.path}?before=${Date.UTC(2024, 10, 1)}`);
    await expect(page.locator('main .empty')).toContainText('Nothing that early is recorded.');
    await expect(page.locator('main .empty')).toContainText('The flow index starts on 3 Dec 2024');
    await expect(page.locator('main .act-chips .fchip:not(.fchip--clear)')).toHaveText([/Before 1 Nov 2024/]);
  });

  test('moves: nothing in the window, and the last match of any age offered as a rewind', async ({ page }, info) => {
    test.skip(onlyIn(info.project.name), 'runs once');
    const last = { id: 'fx:last', ts: Date.now() - 2.3 * 86_400_000, chain: 'osmosis' };
    await silentStream(page);
    await mockFlows(page, [], { total: 0, last });
    await gotoRoute(page, `${ACT.path}?what=sell&since=${new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)}`);
    const empty = page.locator('main .empty');
    await expect(empty).toContainText('No recorded move matches these filters.');
    await expect(empty).toContainText(/The last one was 2\.3\sdays ago\./);
    const link = empty.getByRole('link', { name: 'Rewind to it' });
    const href = new URL((await link.getAttribute('href'))!, 'http://x');
    expect(href.searchParams.get('at')).toBe(String(last.ts));
    expect(href.searchParams.get('what')).toBe('sell');
    expect(href.searchParams.has('since')).toBe(false);
  });

  test('the page tabs lead back to each list as it was left', async ({ page }, info) => {
    test.skip(onlyIn(info.project.name), 'runs once');
    await silentStream(page);
    await mockHolders(page);
    await mockFlows(page);
    await gotoRoute(page, `${HOL.path}?by=staked&page=2`);
    await listReady(page);
    await page.locator('main nav.utabs a', { hasText: 'Transactions' }).click();
    await expect(page).toHaveURL(/\/activity$/);
    await listReady(page, '.tx');
    await expect(page.locator('main nav.utabs a', { hasText: 'Holders' })).toHaveAttribute('href', '/holders?by=staked&page=2');
    await page.locator('main nav.utabs a', { hasText: 'Holders' }).click();
    await expect(page).toHaveURL(/\/holders\?by=staked&page=2$/);
    await expect(page.locator('main .act-holders .hrow').first().locator('.hrow__rk')).toHaveText('51', { timeout: 30_000 });
  });

  test('an unreadable value in the address bar falls back to the default and is cleaned without a history entry', async ({ page }, info) => {
    test.skip(onlyIn(info.project.name), 'runs once');
    await silentStream(page);
    await mockFlows(page);
    await gotoRoute(page, `${ACT.path}?what=nonsense&min=-5&bots=maybe&crossings=both&size=50`);
    await expect(page).toHaveURL(/\/activity\?crossings=both$/);
    await expect(page.locator('main .act-chips .fchip:not(.fchip--clear)')).toHaveText([/Both records of each crossing/]);
  });
});

test.describe('chips and the pager on the new server, every viewport', () => {
  for (const path of [`${ACT.path}?what=sell&min=100000&q=tnam1qxqqqqqq&page=2`, `${HOL.path}?what=genesis&q=${encodeURIComponent('…kj4m')}&page=2`]) {
    test(`${path.split('?')[0]} with chips and the pager: no sideways scroll, no <table>, 44 px targets, text at least 11 px`, async ({ page }) => {
      await silentStream(page);
      await mockHolders(page);
      await mockFlows(page);
      await gotoRoute(page, path);
      await listReady(page, path.startsWith('/holders') ? '.hrow' : '.tx');
      await expect(page.locator('main .act-chips .fchip').first()).toBeVisible();
      const a = await layoutAudit(page, 'main');
      expect(a.overflowX, `scrollWidth ${a.scrollWidth} > ${a.innerWidth}`).toBe(false);
      expect(a.tables).toBe(0);
      expect(a.smallTargets).toEqual([]);
      expect(a.smallText).toEqual([]);
      // the chips are 44 px targets inside the viewport (on phones the row scrolls sideways inside itself)
      for (const b of await page.locator('main .act-chips .fchip').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON() as DOMRect))) expect(b.height).toBeGreaterThanOrEqual(44);
    });
    test(`${path.split('?')[0]} with chips: axe AA, dark and light (375, 1280)`, async ({ page }, info) => {
      test.skip(!['375x812', '1280x800'].includes(info.project.name), 'axe runs at 375 and 1280');
      for (const light of [false, true]) {
        await page.addInitScript((l) => { try { localStorage.setItem('nt.theme', l ? 'light' : 'dark'); } catch { /* none */ } }, light);
        await silentStream(page);
        await mockHolders(page);
        await mockFlows(page);
        await gotoRoute(page, path, { reducedMotion: true });
        await listReady(page, path.startsWith('/holders') ? '.hrow' : '.tx');
        await expect(page.locator('main .act-chips .fchip').first()).toBeVisible();
        const r = await new AxeBuilder({ page }).include('main').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).disableRules(['target-size']).analyze();
        expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`), light ? 'light' : 'dark').toEqual([]);
        await page.unrouteAll({ behavior: 'ignoreErrors' });
      }
    });
  }
});
