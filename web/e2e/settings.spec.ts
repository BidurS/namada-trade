// Settings (/settings), S6. build-plan 8 "Settings": sections in order; the Discord test message
// still sends; delete is the one destructive button; the privacy line is true (owner decision 5).
// Signed-in states use a test session made up here and mocked /api/me/* (page.route): nothing
// reaches the proxied server.
import type { Page } from '@playwright/test';
import { SITE } from '../../shared/copy';
import { ROUTES } from '../../shared/routes';
import { expect, gotoRoute, layoutAudit, onlyIn, test } from './helpers';

const ROUTE = ROUTES.find((r) => r.id === 'settings')!;
const BANNED = /\b(SQS|IBC|DEX|PoS|MASP|ABCI|RPC|cron|webhooks?|npm|D[1-7])\b|Loading…/;
const ORDER = ['Alert rules', 'Where alerts go', 'Watchlist', 'Quiet hours', 'Devices', 'For developers', 'Your data', 'Appearance'];

async function signIn(page: Page) {
  const now = Date.now();
  const settings = {
    address: 'tnam1qtestaddressfore2eonly000000000000000000000',
    notifications: {
      rules: { ibc_inventory: { on: true, thresholdNam: 25000 }, unlock: { on: true, thresholdNam: 100000 }, big_swap: { on: true, thresholdNam: 10000 }, unshield: { on: true, thresholdNam: 50000 }, bond: { on: true, thresholdNam: 1000000 } },
      watchlist: [] as string[], watchlistOn: true, forumAndGov: false, quietHoursUtc: null as null | { start: number; end: number },
    },
    channels: { discord: { enabled: true, hasUrl: true, webhookUrlMasked: 'https://discord.com/api/webhooks/1••••abcd' } },
    createdAt: now - 30 * 864e5, updatedAt: now - 36e5,
  };
  const sessions = [
    { id: 's1', via: 'namada', createdAt: now - 4 * 864e5, expiresAt: now + 26 * 864e5, lastUsedAt: now - 6e4, current: true },
    { id: 's2', via: 'pair', createdAt: now - 2 * 864e5, expiresAt: now + 28 * 864e5, lastUsedAt: null, current: false },
  ];
  const calls: { method: string; path: string; body: unknown }[] = [];
  await page.addInitScript((a) => localStorage.setItem('nt.session', JSON.stringify({ token: 'e2e-test-token', address: a, chain: 'namada', linked: null, via: 'namada', expiresAt: Date.now() + 26 * 864e5 })), settings.address);
  await page.route('**/api/me/**', async (route) => {
    const r = route.request();
    const path = new URL(r.url()).pathname;
    const body = r.method() === 'GET' ? null : r.postDataJSON();
    calls.push({ method: r.method(), path, body });
    if (path === '/api/me/settings' && r.method() === 'PUT') {
      const n = (body as { notifications?: Record<string, unknown> }).notifications ?? {};
      if (n.rules) Object.assign(settings.notifications.rules, n.rules);
      if ('quietHoursUtc' in n) settings.notifications.quietHoursUtc = n.quietHoursUtc as never;
      return route.fulfill({ json: { settings } });
    }
    if (path === '/api/me/settings') return route.fulfill({ json: { settings } });
    if (path === '/api/me/sessions') return route.fulfill({ json: { sessions } });
    if (path === '/api/me/settings/test') return route.fulfill({ json: { success: true } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.route('**/api/auth/**', (route) => route.fulfill({ json: { success: true } }));
  return { calls };
}

test.describe('settings, every viewport', () => {
  test('signed out: one h1, no overflow, no table, 44 px targets, text at least 11 px', async ({ page }) => {
    await gotoRoute(page, '/settings');
    const a = await layoutAudit(page, 'main');
    expect(a.overflowX).toBe(false);
    expect(a.tables).toBe(0);
    expect(a.h1).toEqual([ROUTE.h1]);
    expect(a.smallText).toEqual([]);
    expect(a.smallTargets).toEqual([]);
  });

  test('signed in: no overflow, no table, 44 px targets, text at least 11 px', async ({ page }) => {
    await signIn(page);
    await gotoRoute(page, '/settings');
    await expect(page.locator('#rules .swrow').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#devices .st-dev')).toHaveCount(2);
    const a = await layoutAudit(page, 'main');
    expect(a.overflowX, `scrollWidth ${a.scrollWidth} > ${a.innerWidth}`).toBe(false);
    expect(a.tables).toBe(0);
    expect(a.smallText).toEqual([]);
    expect(a.smallTargets).toEqual([]);
  });
});

test.describe('settings, once', () => {
  test.beforeEach(({}, info) => test.skip(onlyIn(info.project.name), 'viewport-independent: runs in 375x812'));

  test('signed out: what signing in is for, what is stored, the privacy line, Appearance works', async ({ page }) => {
    await gotoRoute(page, '/settings');
    await expect(page.locator('main h2')).toHaveText(['Sign in', 'Your data', 'Appearance']);
    await expect(page.getByText(SITE.privacy, { exact: true })).toBeVisible();
    await expect(page.getByText(/operator cannot read your watchlist/)).toBeVisible();
    await page.locator('#appearance').getByRole('radio', { name: 'Light' }).check();
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('light');
    await page.locator('#appearance').getByRole('radio', { name: 'Dark' }).check();
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBeNull();
    await page.locator('#signin').getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator('dialog.sh-si')).toBeVisible();
    expect(await page.locator('main').innerText()).not.toMatch(BANNED);
  });

  test('signed in: sections in order, one destructive button, no expert words outside For developers', async ({ page }) => {
    await signIn(page);
    await gotoRoute(page, '/settings');
    await expect(page.locator('#rules .swrow').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('main .st-panel > h2')).toHaveText(ORDER);
    await expect(page.locator('main .btn--destructive:visible')).toHaveCount(1);
    await expect(page.locator('main .btn--primary:visible')).toHaveCount(1);
    const text = await page.locator('main .st-panel:not(#developers)').allInnerTexts();
    expect(text.join('\n')).not.toMatch(BANNED);
    await expect(page.getByText(SITE.privacy, { exact: true })).toBeVisible();
  });

  test('signed in: a rule toggle and a size save only what changed', async ({ page }) => {
    const { calls } = await signIn(page);
    await gotoRoute(page, '/settings');
    const row = page.locator('#rules .st-rule').filter({ hasText: 'Large trade' });
    await row.getByRole('switch').click();
    await expect(row.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    await row.getByRole('switch').click();
    const size = row.getByRole('textbox', { name: 'Alert size' });
    await size.fill('20000');
    await size.blur();
    await expect(page.locator('#rules .st-status')).toContainText('alerts from 20,000 NAM');
    const puts = calls.filter((c) => c.method === 'PUT').map((c) => c.body);
    expect(puts).toEqual([
      { notifications: { rules: { big_swap: { on: false, thresholdNam: 10000 } } } },
      { notifications: { rules: { big_swap: { on: true, thresholdNam: 10000 } } } },
      { notifications: { rules: { big_swap: { on: true, thresholdNam: 20000 } } } },
    ]);
    await size.fill('ten');
    await size.blur();
    await expect(row.locator('.notice')).toContainText('whole number');
  });

  test('signed in: the Discord test message sends; delete asks once in the page, never confirm()', async ({ page }) => {
    const { calls } = await signIn(page);
    page.on('dialog', (d) => {
      throw new Error(`native dialog: ${d.message()}`);
    });
    await gotoRoute(page, '/settings#delivery');
    await page.locator('#delivery').getByRole('button', { name: 'Send a test message' }).click();
    await expect(page.locator('#delivery')).toContainText('A test message was posted to the channel.');
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/me/settings/test')).toBe(true);
    await expect(page.locator('#delivery')).toContainText('ends in abcd');
    await page.locator('#data').getByRole('button', { name: 'Delete everything' }).click();
    await expect(page.locator('#data').getByRole('button', { name: 'Yes, delete everything' })).toBeVisible();
    await expect(page.locator('main .btn--destructive:visible')).toHaveCount(1);
    await page.locator('#data').getByRole('button', { name: 'Keep my data' }).click();
    await expect(page.locator('#data').getByRole('button', { name: 'Delete everything' })).toBeVisible();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  // Security review (2026-10-22), alerts off on the server: a Worker without SEND_ALERTS answered the test with
  // { success: false }, and the page said Discord had refused it, blaming the user's working link. The server now
  // answers 503 "Alerts are off on this server", and the page says that instead.
  test('signed in: on a server that sends no alerts, the test message says so and does not blame the link', async ({ page }) => {
    await signIn(page);
    await page.route('**/api/me/settings/test', (route) => route.fulfill({ status: 503, json: { error: 'Alerts are off on this server' } }));
    await gotoRoute(page, '/settings#delivery');
    await page.locator('#delivery').getByRole('button', { name: 'Send a test message' }).click();
    await expect(page.locator('#delivery')).toContainText('Alerts are off on this server, so no test message was sent. Your saved link was not tried and is not at fault.');
    await expect(page.locator('#delivery')).not.toContainText('Discord refused');
    expect(await page.locator('#delivery').innerText()).not.toMatch(BANNED);
  });

  test('signed in: pairing a phone loads the QR code only when a code is made', async ({ page }) => {
    await signIn(page);
    await page.route('**/api/auth/pair', (route) => route.fulfill({ json: { code: 'a1b2c3d4', expiresAt: Date.now() + 6e5 } }));
    const qr: string[] = [];
    page.on('request', (r) => {
      if (/qrcode/i.test(r.url())) qr.push(r.url());
    });
    await gotoRoute(page, '/settings#devices');
    await expect(page.locator('#devices .st-dev').first()).toBeVisible({ timeout: 30_000 });
    expect(qr).toEqual([]);
    await page.locator('#devices').getByRole('button', { name: 'Make a code' }).click();
    await expect(page.locator('.sh-pairdev__c')).toHaveText('A1B2C3D4');
    await expect(page.locator('.sh-pairdev__qr img')).toBeVisible();
    // the code rides in the fragment, which a browser never sends (Security review, 2026-10-22)
    await expect(page.locator('.sh-pairdev__link')).toContainText('/alerts#pair=a1b2c3d4');
    await expect(page.locator('.sh-pairdev__link')).not.toContainText('?pair=');
  });
});
