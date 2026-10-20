// Activity (S5): /activity (Transactions) and /holders (Holders), one screen with two tabs.
// Layout checks run in every project of the G6 matrix; behaviour checks run once (375x812) or
// where the width matters (the filter sheet below 1024 px, inline filters from 1024 px).
import type { Locator, Page } from '@playwright/test';
import { BODY } from '../../shared/copy';
import { ROUTES } from '../../shared/routes';
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
      const res = await route.fetch();
      const j = await res.json();
      j.categories = { total: 2212, counts: [{ category: 'backer', n: 248 }, { category: 'genesis', n: 120 }, { category: 'none', n: 1800 }] };
      await route.fulfill({ json: j });
    });
    await gotoRoute(page, HOL.path);
    await expect(page.locator('main .hrow').first()).toBeVisible({ timeout: 30_000 });
    const sheet = page.getByRole('dialog', { name: 'Filter holders' });
    await openSheet(page, sheet);
    const cats = sheet.locator('.act-cats');
    await expect(cats.locator('legend')).toHaveText('What');
    await expect(cats.locator('.chipsel__o', { hasText: 'Backer' })).toContainText('248');
    await expect(cats.locator('.chipsel__o', { hasText: 'All' })).toContainText('2,212');
    // an older server: counted among the rows loaded, and the legend says so
    await page.unroute(LIST);
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

  test('Load more appends the next page', async ({ page }) => {
    await gotoRoute(page, HOL.path);
    await expect(page.locator('main .hrow').first()).toBeVisible({ timeout: 30_000 });
    const before = await page.locator('main .hrow').count();
    await page.getByRole('button', { name: 'Load more holders' }).click();
    await expect.poll(() => page.locator('main .hrow').count(), { timeout: 30_000 }).toBeGreaterThan(before);
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
