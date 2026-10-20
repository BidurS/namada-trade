// Alerts (/alerts), S6. build-plan 8 "Alerts": the empty state shows the last event and a rewind
// link; rules are Switch rows, locked when signed out; delivery is one line with one action; the
// rewound page asks every /api with at= and offers no "since your last visit".
// Account calls are mocked (page.route) so no test session ever reaches the proxied server.
import type { Page } from '@playwright/test';
import { BODY } from '../../shared/copy';
import { ROUTES } from '../../shared/routes';
import { REWIND_AT, animationsIn, apiUrls, expect, gotoRoute, isExempt, isLiveOnly, layoutAudit, onlyIn, test, trackRequests } from './helpers';

const ROUTE = ROUTES.find((r) => r.id === 'alerts')!;
const BANNED = /\b(SQS|IBC|DEX|PoS|MASP|ABCI|RPC|cron|webhooks?|npm|D[1-7])\b|Loading…/;

/** A test session (made up here) and mocked account calls. Nothing goes to the server. */
async function signIn(page: Page) {
  const now = Date.now();
  const settings = {
    address: 'tnam1qtestaddressfore2eonly000000000000000000000',
    notifications: {
      rules: { ibc_inventory: { on: true, thresholdNam: 25000 }, unlock: { on: true, thresholdNam: 100000 }, big_swap: { on: false, thresholdNam: 50000 }, unshield: { on: true, thresholdNam: 50000 }, bond: { on: true, thresholdNam: 1000000 } },
      watchlist: [], watchlistOn: true, forumAndGov: false, quietHoursUtc: null,
    },
    channels: { discord: { enabled: true, hasUrl: true, webhookUrlMasked: 'https://discord.com/api/webhooks/1••••abcd' } },
    createdAt: now - 864e5, updatedAt: now - 36e5,
  };
  const puts: unknown[] = [];
  await page.addInitScript((a) => localStorage.setItem('nt.session', JSON.stringify({ token: 'e2e-test-token', address: a, chain: 'namada', linked: null, via: 'namada', expiresAt: Date.now() + 20 * 864e5 })), settings.address);
  await page.route('**/api/me/**', async (route) => {
    const r = route.request();
    if (r.method() === 'PUT') {
      const body = r.postDataJSON();
      puts.push(body);
      for (const [k, v] of Object.entries(body.notifications?.rules ?? {})) (settings.notifications.rules as Record<string, unknown>)[k] = v;
      return route.fulfill({ json: { settings } });
    }
    return route.fulfill({ json: { settings, sessions: [] } });
  });
  await page.route('**/api/auth/**', (route) => route.fulfill({ status: 400, json: { error: 'not in tests' } }));
  return { puts };
}

test.describe('alerts, every viewport', () => {
  test('one h1, no overflow, no table, 44 px targets, text at least 11 px', async ({ page }) => {
    await gotoRoute(page, '/alerts');
    await expect(page.locator('.al-read .hero-n__v [data-num]')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.al-rules .swrow')).toHaveCount(5, { timeout: 30_000 });
    await expect(page.locator('.al-hits .al-list, .al-hits .empty')).toBeVisible({ timeout: 30_000 });
    const a = await layoutAudit(page, 'main');
    expect(a.overflowX, `scrollWidth ${a.scrollWidth} > ${a.innerWidth}`).toBe(false);
    expect(a.tables).toBe(0);
    expect(a.h1).toEqual([ROUTE.h1]);
    expect(a.smallText).toEqual([]);
    expect(a.smallTargets).toEqual([]);
  });

  test('rewound: no overflow, the window ends at the rewound time', async ({ page }) => {
    await gotoRoute(page, `/alerts?at=${REWIND_AT}`);
    await expect(page.locator('.al-read .hero-n__sub')).toContainText('30 Aug 2026', { timeout: 30_000 });
    const a = await layoutAudit(page, 'main');
    expect(a.overflowX).toBe(false);
    expect(a.smallTargets).toEqual([]);
  });
});

test.describe('alerts, once', () => {
  test.beforeEach(({}, info) => test.skip(onlyIn(info.project.name), 'viewport-independent: runs in 375x812'));

  test('the plain text, the reading, the rules locked when signed out, one action', async ({ page }) => {
    await gotoRoute(page, '/alerts');
    for (const p of BODY.alerts.paras) await expect(page.getByText(p, { exact: true })).toBeVisible();
    await expect(page.locator('[data-decision="D7"]')).toHaveCount(1);
    await expect(page.locator('.al-read .hero-n__v [data-num]')).toHaveText(/^\d[\d,]*$/, { timeout: 30_000 });
    await expect(page.locator('.al-read .chip')).toContainText('Flow index');
    const rows = page.locator('.al-rules .swrow');
    await expect(rows).toHaveCount(5, { timeout: 30_000 });
    for (const title of ['NAM bridged to Osmosis', 'NAM unstaked', 'Large trade', 'NAM left the shielded set', 'Large amount staked']) await expect(rows.filter({ hasText: title })).toHaveCount(1);
    await expect(page.locator('.al-rules .swrow__lock')).toHaveCount(5);
    for (const sw of await page.locator('.al-rules [role="switch"]').all()) await expect(sw).toBeDisabled();
    // each size has its dollar value, derived from the price, in the panel's one SourceLine scope
    await expect(page.locator('.al-rules .swrow__d [data-num]')).toHaveCount(5);
    await expect(page.locator('.al-rules .srcb')).toHaveAttribute('data-scope', /Alert sizes/);
    // where alerts go: one line, one action
    await expect(page.locator('.al-deliv .btn, .al-deliv .link')).toHaveCount(1);
    await page.locator('.al-deliv').getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator('dialog.sh-si')).toBeVisible();
    // copy: no expert words in the page's own text
    expect(await page.locator('main').innerText()).not.toMatch(BANNED);
  });

  test('empty state names the last one and links to it rewound; hits list otherwise', async ({ page }) => {
    await gotoRoute(page, '/alerts');
    const empty = page.locator('.al-hits .empty');
    const list = page.locator('.al-hits .al-list');
    await expect(empty.or(list)).toBeVisible({ timeout: 30_000 });
    if (await empty.isVisible()) {
      await expect(empty).toContainText(/Nothing crossed an alert size/);
      await expect(empty).toContainText('Alert sizes are small on purpose');
      const link = empty.getByRole('link', { name: 'Rewind to it' });
      if (await link.count()) {
        await expect(empty).toContainText('The last one:');
        const href = await link.getAttribute('href');
        expect(href).toMatch(/^\/alerts\?at=\d+$/);
        await link.click();
        await expect(page).toHaveURL(/\/alerts\?at=\d+/);
        await expect(page.locator('.al-hits .al-list .al-hit').first()).toBeVisible({ timeout: 30_000 });
      }
    } else {
      const hit = list.locator('.al-hit').first();
      await expect(hit.locator('.tag')).toBeVisible();
      await expect(hit.getByRole('link', { name: /Transaction/ })).toHaveAttribute('href', /mintscan\.io|namada\.valopers\.com/);
    }
  });

  test('empty state, old price: the dollar figure says its age once, and the full stop stays on its line', async ({ page }) => {
    const now = Date.now();
    await page.route('**/api/alerts/recent*', (route) => route.fulfill({ json: { since: now - 864e5, until: now, hits: [], last: null } }));
    await page.route(/\/api\/overview(\?|$)/, async (route) => {
      const res = await route.fetch();
      const o = await res.json();
      o.price.usd = { value: 0.001, prov: { source: 'Osmosis SQS (stored)', at: now - 3 * 3_600_000, status: 'stale', note: 'The live price could not be fetched.' } };
      await route.fulfill({ response: res, json: o });
    });
    await gotoRoute(page, '/alerts');
    const empty = page.locator('.al-hits .empty');
    await expect(empty).toContainText('Alert sizes are small on purpose', { timeout: 30_000 });
    const fig = empty.locator('.al-nowrap');
    await expect(fig.locator('[data-num]')).toHaveAttribute('data-status', 'old');
    await expect(fig.locator('.num__x--age')).toHaveCount(0); // the dot says "old 3 h"; the figure does not say it again
    await expect(fig.locator('.pdot')).toContainText(/old\s3\sh/);
    // the figure, its dot and the full stop are one line box
    expect(await fig.evaluate((el) => new Set([...el.getClientRects()].map((r) => Math.round(r.top))).size)).toBe(1);
    expect(await fig.evaluate((el) => (el.textContent ?? '').trim().endsWith('.'))).toBe(true);
  });

  test('the window: 7 days asks for a week of hits', async ({ page }) => {
    await gotoRoute(page, '/alerts');
    await expect(page.locator('.al-read .hero-n__v [data-num]')).toBeVisible({ timeout: 30_000 });
    const req = page.waitForRequest((r) => r.url().includes('/api/alerts/recent') && Number(new URL(r.url()).searchParams.get('since')) < Date.now() - 6 * 864e5);
    await page.locator('.al-win').getByRole('radio', { name: '7 days' }).check();
    await req;
    await expect(page.locator('.al-read .hero-n__label')).toHaveText('In the last 7 days');
  });

  test('N3: rewound, every /api request carries at= except the exempt list, no live-only call', async ({ page, baseURL }) => {
    const reqs = trackRequests(page);
    await gotoRoute(page, `/alerts?at=${REWIND_AT}`);
    await expect(page.locator('.al-read .hero-n__v [data-num]')).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1500);
    const api = apiUrls(reqs, baseURL!);
    expect(api.some((u) => u.pathname === '/api/alerts/recent')).toBe(true);
    for (const u of api) {
      if (isExempt(u.pathname)) continue;
      expect(isLiveOnly(u.pathname), u.pathname).toBe(false);
      expect(u.searchParams.get('at'), u.pathname + u.search).toBe(String(REWIND_AT));
    }
    await expect(page.locator('.al-win').getByRole('radio', { name: 'Last visit' })).toHaveCount(0);
    await expect(page.locator('.al-read .hero-n__label')).toHaveText('In the 24 hours before then');
    await expect(page.locator('.al-rules')).toContainText('not recorded over time');
  });

  test('signed in: the switches are yours, and a toggle saves only that rule', async ({ page }) => {
    const { puts } = await signIn(page);
    await gotoRoute(page, '/alerts');
    const trade = page.locator('.al-rules .swrow').filter({ hasText: 'Large trade' });
    const sw = trade.getByRole('switch');
    await expect(sw).toBeEnabled({ timeout: 30_000 });
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await expect(trade).toContainText('Your size: 50,000 NAM');
    await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    expect(puts).toEqual([{ notifications: { rules: { big_swap: { on: true, thresholdNam: 50000 } } } }]);
    await expect(page.locator('.al-deliv')).toContainText('Alerts go to your Discord channel');
    await expect(page.locator('.al-deliv').getByRole('link', { name: 'Open settings' })).toHaveAttribute('href', '/settings#delivery');
  });

  test('G7: nothing animates under reduced motion', async ({ page }) => {
    await gotoRoute(page, '/alerts', { reducedMotion: true });
    await page.waitForTimeout(1500);
    expect(await animationsIn(page, 'main')).toBe(0);
  });
});
