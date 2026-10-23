// The sheets (S7): Sources, Address, Sign in, Account. build-plan 8 "Sheets" and N5, N8: each opens
// within 100dvh and scrolls inside, focus returns to the invoker, Escape closes, developer detail
// sits only under "How it is computed", the Sources sheet has one row per check.key, and
// /alerts#pair=CODE (and a link printed before it, /alerts?pair=CODE) opens Sign in on the code
// step. Sign-in and account calls are mocked (page.route): no code or test session ever reaches
// the proxied server.
import type { Page } from '@playwright/test';
import type { Overview } from '../../shared/types';
import { REWIND_AT, expect, gotoRoute, layoutAudit, onlyIn, test } from './helpers';

const BANNED = /\b(SQS|IBC|DEX|PoS|MASP|ABCI|RPC|cron|webhooks?|npm|D[1-7])\b|Loading…/;
const ADDR = 'tnam1qqscx40lsm80mgv0e32gtv9wwwhh95x6yuq027zh';

async function noAuthCalls(page: Page) {
  await page.route('**/api/auth/**', (route) => route.fulfill({ status: 400, json: { error: 'that code is not valid or has expired' } }));
}

/** The open sheet fits the window, scrolls inside, and passes the layout audit. */
async function sheetFits(page: Page) {
  const d = page.locator('dialog[open]');
  await expect(d).toBeVisible();
  // measure the settled sheet, not a frame of its opening slide
  await d.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => undefined))));
  const m = await d.evaluate((el) => ({ h: el.getBoundingClientRect().height, top: el.getBoundingClientRect().top, vh: innerHeight, sw: el.scrollWidth, cw: el.clientWidth, oy: getComputedStyle(el).overflowY }));
  expect(m.h).toBeLessThanOrEqual(m.vh);
  expect(m.top).toBeGreaterThanOrEqual(0);
  expect(m.sw, 'no sideways scroll inside the sheet').toBeLessThanOrEqual(m.cw);
  expect(['auto', 'scroll']).toContain(m.oy);
  const a = await layoutAudit(page, 'dialog[open]');
  expect(a.overflowX).toBe(false);
  expect(a.smallText).toEqual([]);
  expect(a.smallTargets).toEqual([]);
}

test.describe('sheets, every viewport', () => {
  test('Sources: fits, scrolls, one row per check.key, Escape closes and focus returns', async ({ page }) => {
    const ov = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/overview' && r.ok());
    await gotoRoute(page, '/alerts');
    const overview = (await (await ov).json()) as Overview;
    const pill = page.locator('.hbtn--status');
    await expect(pill.locator('.hbtn__wait')).toHaveCount(0, { timeout: 30_000 });
    await pill.click();
    const d = page.locator('dialog.sh-src');
    await expect(d.getByRole('heading', { name: 'Where every number comes from' })).toBeVisible();
    await sheetFits(page);
    const keys = await d.locator('li[data-key]').evaluateAll((els) => els.map((e) => e.getAttribute('data-key')));
    expect(keys.sort()).toEqual(overview.checks.map((c) => c.key).sort());
    await expect(d.locator('[data-decision="D6"]')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(d).toHaveCount(0);
    await expect(pill).toBeFocused();
  });

  test('Address: fits, scrolls, balances and moves', async ({ page }) => {
    await gotoRoute(page, `/alerts?addr=${ADDR}`);
    const d = page.locator('dialog.sh-addr');
    await expect(d.locator('.sh-fig [data-num]').first()).toBeVisible({ timeout: 30_000 });
    await expect(d.locator('.sh-mv').first()).toBeVisible();
    await sheetFits(page);
  });

  test('Sign in from an old ?pair= link: fits, the code step is open with the code, and nothing is claimed until Pair is pressed', async ({ page }) => {
    await noAuthCalls(page);
    let claims = 0;
    await page.route('**/api/auth/pair/claim', (route) => { claims++; return route.fallback(); });
    await gotoRoute(page, '/alerts?pair=a1b2c3d4');
    const d = page.locator('dialog.sh-si');
    await expect(d.getByRole('heading', { name: 'Sign in with your Namada wallet' })).toBeVisible();
    await expect(d.getByRole('textbox', { name: 'Pairing code' })).toHaveValue('A1B2C3D4');
    // a link alone never signs a browser in
    await expect(d.locator('.notice[data-tone="danger"]')).toHaveCount(0);
    expect(claims).toBe(0);
    await sheetFits(page);
    await d.getByRole('button', { name: 'Pair', exact: true }).click();
    await expect(d.locator('.notice[data-tone="danger"]')).toContainText('not valid or has expired');
    expect(claims).toBe(1);
  });
});

// ---------------------------------------------------------------- an address report fixture
// One crossing recorded on both chains, one recorded on Namada only, a crossing to a linked address on both
// chains, and a shielded move of another coin (OSMO). The server's counterparties are deliberately wrong
// (both records of a crossing and the OSMO added in): the sheet counts from its own listed moves.
const ME = 'osmo1fixturesheetaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const MASP = 'tnam1pcqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzmefah';
const LINKED = 'tnam1qfixturelinkedbbbbbbbbbbbbbbbbbbbbbbbbb';
function addressFixture() {
  const t = Date.now() - 3_600_000;
  let n = 0;
  const flow = (o: Record<string, unknown>) => ({
    id: `fx-${++n}`, height: 1000 + n, txHash: `${'CD'.repeat(31)}${String(n).padStart(2, '0')}`, counterDenom: null, counterAmount: null, poolId: null, priceUsd: null, valueUsd: null, meta: null,
    fromLabel: null, toLabel: null, fromLabelPlain: null, toLabelPlain: null, whale: true, ...o,
  });
  const flows = [
    flow({ chain: 'namada', kind: 'ibc_in', from: ME, to: MASP, amount: 20_000, ts: t + 10_000, toLabelPlain: 'Shielded pool' }), // the arriving twin of the next one
    flow({ chain: 'osmosis', kind: 'ibc_out', from: ME, to: MASP, amount: 20_000, ts: t, toLabelPlain: 'Shielded pool' }),
    flow({ chain: 'namada', kind: 'ibc_in', from: ME, to: MASP, amount: 20_000, ts: t - 3_600_000, toLabelPlain: 'Shielded pool' }), // no sending record
    flow({ chain: 'namada', kind: 'unshield', from: MASP, to: ME, amount: 200, ts: t - 7_200_000, fromLabelPlain: 'Shielded pool', counterAmount: 200, counterDenom: 'OSMO', meta: { tokenSymbol: 'OSMO' }, whale: false }),
    flow({ chain: 'namada', kind: 'ibc_in', from: ME, to: LINKED, amount: 15_000, ts: t - 9_000_000 + 30_000 }),
    flow({ chain: 'osmosis', kind: 'ibc_out', from: ME, to: LINKED, amount: 15_000, ts: t - 9_000_000 }),
  ];
  return {
    address: ME, chain: 'osmosis', label: null,
    balance: { value: 1000, prov: { source: 'Keplr Osmosis REST (fixture)', at: Date.now(), status: 'live' } },
    indexedBalance: 1000, staking: null, rank: null, change24h: null, change7d: null,
    links: [
      { address: MASP, chain: 'namada', transfers: 2, volume: 40_000, lastSeen: t },
      { address: LINKED, chain: 'namada', transfers: 1, volume: 15_000, lastSeen: t - 9_000_000 },
    ],
    totalFlowsCount: flows.length,
    flows,
    counterparties: [{ address: MASP, label: null, label_plain: 'Shielded pool', inNam: 200, outNam: 60_000, count: 4 }],
  };
}

test.describe('sheets, once', () => {
  test.beforeEach(({}, info) => test.skip(onlyIn(info.project.name), 'viewport-independent: runs in 375x812'));

  // Security review (2026-10-22), the pairing link: its code rode in the query (/alerts?pair=CODE), so the phone's
  // page request carried it to the Worker and into its request logs, where a reader of the logs could claim it before
  // the phone pressed Pair. The link now carries it in the fragment, which a browser never sends.
  test('Sign in from #pair=: the code step is open with the code, no request carries the code, and closing drops it from the address bar', async ({ page }) => {
    await noAuthCalls(page);
    const sent: string[] = [];
    page.on('request', (r) => sent.push(r.url()));
    let claims = 0;
    await page.route('**/api/auth/pair/claim', (route) => { claims++; return route.fallback(); });
    await gotoRoute(page, '/alerts#pair=a1b2c3d4');
    const d = page.locator('dialog.sh-si');
    await expect(d.getByRole('textbox', { name: 'Pairing code' })).toHaveValue('A1B2C3D4');
    expect(claims).toBe(0);
    expect(sent.filter((u) => /a1b2c3d4/i.test(u))).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(d).toHaveCount(0);
    // closing replaced the entry, so no history entry keeps the code
    expect(await page.evaluate(() => location.pathname + location.search + location.hash)).toBe('/alerts');
  });

  test('Address: each crossing once, another coin in its own unit, and the counts agree with the moves listed', async ({ page }) => {
    await page.route(`**/api/address/${ME}`, (route) => route.fulfill({ json: addressFixture() }));
    await gotoRoute(page, `/alerts?addr=${ME}`);
    const d = page.locator('dialog.sh-addr');
    await expect(d.locator('.sh-mv').first()).toBeVisible({ timeout: 30_000 });
    // 6 records, 2 of them the arriving side of a crossing already listed
    await expect(d.locator('.sh-mv')).toHaveCount(4);
    await expect(d.getByRole('heading', { name: /^Moves/ })).toHaveText(/^Moves\s*4$/);
    await expect(d).toContainText('Each bridge crossing is listed once, by the chain it left: 2 records of the same crossings arriving on the other chain are left out.');
    // the shielded OSMO is OSMO, never NAM, and is not added to a NAM figure
    const osmo = d.locator('.sh-mv').filter({ hasText: 'Shielded out' });
    await expect(osmo.locator('.sh-mv__n')).toHaveText('+200 OSMO');
    await expect(osmo).not.toContainText('200.00 OSMO');
    // who it moves NAM with: counted from the listed moves (the server's 60,000 and 4 were both records plus the OSMO)
    const cp = d.locator('.sh-grp').filter({ has: page.getByRole('heading', { name: 'Who it moves NAM with most' }) });
    await expect(cp.locator('.sh-row').first()).toContainText('Shielded pool');
    await expect(cp.locator('.sh-row').first()).toContainText('in 0 · out −40,000 NAM · 2 moves');
    // linked across the bridge: the shielded pool by name, crossings from the same rows
    const links = d.locator('.sh-grp').filter({ has: page.getByRole('heading', { name: 'Linked across the bridge' }) });
    await expect(links.locator('.sh-row').first()).toContainText('Shielded pool');
    await expect(links.locator('.sh-row').first()).toContainText('2 crossings · 40,000 NAM');
    await expect(links.locator('.sh-row').nth(1)).toContainText('1 crossing · 15,000 NAM');
  });

  test('Sources: plain words outside "How it is computed"; operator text inside it', async ({ page }) => {
    await gotoRoute(page, '/alerts');
    await expect(page.locator('.hbtn--status .hbtn__wait')).toHaveCount(0, { timeout: 30_000 });
    await page.locator('.hbtn--status').click();
    const d = page.locator('dialog.sh-src');
    await expect(d.locator('li[data-key]').first()).toBeVisible();
    const outside = await d.evaluate((el) => {
      const c = el.cloneNode(true) as HTMLElement;
      c.querySelectorAll('details').forEach((x) => x.remove());
      return c.textContent ?? '';
    });
    expect(outside).not.toMatch(BANNED);
    await expect(d.locator('li[data-key]').first().locator('.sh-chk__w')).toHaveText(/^(Passes|Needs a look|Nothing to compare)/); // the price check is idle when no trade it trusts fell in its window (lib/prov.ts)
    await d.getByText('How it is computed').click();
    await expect(d.locator('details.sh-how')).toHaveAttribute('open', '');
    await expect(d.locator('details.sh-how .sh-raw dt').first()).toBeVisible();
  });

  test('Sources under Rewind: says the checks were not recorded', async ({ page }) => {
    await gotoRoute(page, `/alerts?at=${REWIND_AT}`);
    await page.locator('.hbtn--status').click();
    await expect(page.locator('dialog.sh-src .sheet__lead')).toContainText('Checks were not recorded then');
    await expect(page.locator('dialog.sh-src li[data-key]')).toHaveCount(0);
  });

  test('Address under Rewind: the balances are said to be current', async ({ page }) => {
    await gotoRoute(page, `/alerts?at=${REWIND_AT}&addr=${ADDR}`);
    const d = page.locator('dialog.sh-addr');
    await expect(d).toContainText('Balances were not recorded over time; these are current, not as of 30 Aug 2026, 19:05 UTC.');
    await expect(d.locator('.sh-fig [data-num]').first()).toBeVisible({ timeout: 30_000 });
    await expect(d.getByText(/^About \$/)).toHaveCount(0);
  });

  test('Sign in from the header: three ways, names only, Escape closes and focus returns', async ({ page }) => {
    await noAuthCalls(page);
    await gotoRoute(page, '/alerts');
    const btn = page.locator('header .ibtn[aria-label^="Account"]');
    await btn.click();
    const d = page.locator('dialog.sh-si');
    await expect(d.locator('.sh-way')).toHaveCount(3);
    await expect(d.locator('.sh-way__t')).toHaveText(['Namada Keychain', 'Keplr', 'Pair with a code']);
    await expect(d.locator('img')).toHaveCount(0);
    await expect(d).toContainText('No transaction, no fee, nothing moves.');
    await expect(d).toContainText('never gets your wallet');
    await page.keyboard.press('Escape');
    await expect(d).toHaveCount(0);
    await expect(btn).toBeFocused();
  });

  test('Account sheet (signed in): the places, appearance and sign out, no confirm()', async ({ page }) => {
    page.on('dialog', (x) => {
      throw new Error(`native dialog: ${x.message()}`);
    });
    await page.addInitScript(() => localStorage.setItem('nt.session', JSON.stringify({ token: 'e2e-test-token', address: 'tnam1qtestaddressfore2eonly000000000000000000000', chain: 'namada', linked: null, via: 'keplr', expiresAt: Date.now() + 10 * 864e5 })));
    let loggedOut = false;
    await page.route('**/api/auth/logout', (route) => {
      loggedOut = true;
      return route.fulfill({ json: { success: true } });
    });
    // a server that is down for the account's own data (503), never a 401: a refused token signs the device out
    // (lib/auth.ts authFetch, since the security review), and this test needs the device signed in
    await page.route('**/api/me/**', (route) => route.fulfill({ status: 503, json: { error: 'down for the test' } }));
    await gotoRoute(page, '/alerts');
    await page.locator('header .ibtn[aria-label^="Account"]').click();
    const d = page.locator('dialog.sh-acct');
    await expect(d.getByRole('heading', { name: 'Your account' })).toBeVisible();
    for (const name of ['Settings', 'Alerts', 'Discord', 'Devices', 'API keys']) await expect(d.getByRole('link', { name: new RegExp(`^${name}`) })).toBeVisible();
    await expect(d).toContainText('with Keplr');
    await d.getByRole('link', { name: /^Devices/ }).click();
    await expect(page).toHaveURL(/\/settings#devices$/);
    await page.locator('header .ibtn[aria-label^="Account"]').click();
    await page.locator('dialog.sh-acct').getByRole('button', { name: 'Sign out on this device' }).click();
    await expect(page.locator('header .ibtn[aria-label="Account: sign in"]')).toBeVisible();
    expect(loggedOut).toBe(true);
  });
});

// ---------------------------------------------------------------- where the Address sheet was opened from (S7, nav-search-plan 3.2)
// The list answers and the address report are route mocks shaped like shared/types.ts (the stored-totals server's
// HoldersResponse and FlowsResponse, an AddressReport with `rankTotal`); the stream is mocked silent.
const FX_B32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const fxAddress = (i: number, prefix: 'tnam1' | 'osmo1' = 'tnam1') => {
  let s = '';
  for (let k = 0, n = i; k < 8; k++, n = Math.floor(n / 32)) s = FX_B32[n % 32] + s;
  return `${prefix}qx${'q'.repeat(prefix === 'tnam1' ? 30 : 28)}${s}`;
};
function fxListHolder(rank: number) {
  const now = Date.now();
  const total = Math.round(60_000_000 / rank);
  return {
    rank, chain: 'namada', address: fxAddress(rank), balance: total * 0.7, bonded: total * 0.3, bondedEstimated: total * 0.3, bondedVerifiedAt: now - 60_000,
    total, pctSupply: (total / 1.15e9) * 100, change24h: 0, change7d: 0, label: null, category: null, label_plain: null, category_plain: null,
    label_source: null, label_author: null, linked: [], updatedAt: now - 60_000, verifiedAt: now - 60_000, status: 'live', statusNote: null,
  };
}
function fxReport(address: string, chain: 'namada' | 'osmosis', rank: number | null, rankTotal: number | null | undefined) {
  return {
    address, chain, label: null,
    balance: { value: 1_000_000, prov: { source: 'Namada RPC (balance read)', at: Date.now(), status: 'live' } },
    indexedBalance: 1_000_000, staking: null, rank, ...(rankTotal !== undefined ? { rankTotal } : {}), change24h: null, change7d: null,
    links: [], totalFlowsCount: 0, flows: [], counterparties: [],
  };
}
async function originMocks(page: Page) {
  await page.routeWebSocket('**/ws', () => {});
  await page.route(/\/api\/holders\?/, (route) => {
    const u = new URL(route.request().url());
    const limit = Number(u.searchParams.get('limit') ?? 50);
    const pg = Number(u.searchParams.get('page') ?? 1);
    const holders = Array.from({ length: limit }, (_, i) => fxListHolder((pg - 1) * limit + i + 1));
    return route.fulfill({ json: { total: 64_377, page: pg, limit, holders, next: null, asOf: Date.now() - 30_000, countsAt: Date.now() - 120_000, categories: { total: 64_377, counts: [] } } });
  });
  const base = Date.now() - 5 * 60_000;
  await page.route(/\/api\/flows\?/, (route) => {
    const u = new URL(route.request().url());
    const limit = Number(u.searchParams.get('limit') ?? 50);
    const flows = Array.from({ length: limit }, (_, i) => {
      const trader = fxAddress(i, 'osmo1');
      const hash = (i.toString(16).toUpperCase().padStart(8, '0') + 'CD'.repeat(28)).slice(0, 64);
      return {
        id: `fx:${i}`, chain: 'osmosis', height: 72_000_000 - i, ts: base - i * 60_000, txHash: hash, explorerHash: hash, kind: 'sell', from: trader, to: null,
        amount: 5_000 + i, counterDenom: 'USDC', counterAmount: 5.7, poolId: '3005', priceUsd: 0.00114, valueUsd: 5.7, meta: { trader },
        fromLabel: null, toLabel: null, fromLabelPlain: null, toLabelPlain: null, fromLabelSource: null, toLabelSource: null, fromLabelAuthor: null, toLabelAuthor: null, whale: false,
      };
    });
    return route.fulfill({ json: { total: 2_000, page: 1, limit, flows, next: 'WzE3OTAwMDAwMDAwMDAsMSwiZng6NDkiXQ', asOf: Date.now(), firstTs: Date.UTC(2024, 11, 3) } });
  });
  await page.route(/\/api\/address\//, (route) => {
    const a = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop() ?? '');
    return route.fulfill({ json: a.startsWith('osmo1') ? fxReport(a, 'osmosis', 7, 7) : fxReport(a, 'namada', 4, Number(a === fxAddress(1)) || 1_204) });
  });
}

test.describe('Address sheet: where it was opened from, and both ranks', () => {
  test('from a holder row: the eyebrow says the list and the rank; the rank line says both orders with one stamp; Escape returns to the row', async ({ page }, info) => {
    test.skip(!['375x812', '1280x800'].includes(info.project.name), 'runs at 375 and 1280');
    await originMocks(page);
    await gotoRoute(page, '/holders');
    const name = page.locator('main .act-holders .hrow').first().locator('.act-name');
    await expect(name).toBeVisible({ timeout: 30_000 });
    await name.click();
    const d = page.locator('dialog.sh-addr');
    await expect(d.locator('.sh-addr__from')).toHaveText('From holders · No. 1 by total NAM');
    // the eyebrow is the 11 px caps line under the title
    await expect(d.locator('.sh-addr__from')).toHaveCSS('text-transform', 'uppercase');
    const ranks = d.locator('.sh-addr__ranks');
    await expect(ranks).toContainText('No. 1 by total NAM');
    await expect(ranks).toContainText('No. 4 by spendable NAM');
    await expect(ranks.locator('[data-num]')).toHaveCount(2);
    await expect(ranks.locator('.pdot')).toHaveCount(1);
    await sheetFits(page);
    await page.keyboard.press('Escape');
    await expect(d).toHaveCount(0);
    await expect(name).toBeFocused();
  });

  test('from a move: "From activity · Move 1 of 2,000"; the same address opened from its link has no eyebrow', async ({ page }, info) => {
    test.skip(onlyIn(info.project.name), 'runs once');
    await originMocks(page);
    await gotoRoute(page, '/activity');
    const who = page.locator('main .txl .tx').first().locator('.tx__addr').first();
    await expect(who).toBeVisible({ timeout: 30_000 });
    await who.click();
    const d = page.locator('dialog.sh-addr');
    await expect(d.locator('.sh-addr__from')).toHaveText('From activity · Move 1 of 2,000');
    await expect(d.locator('.sh-addr__ranks')).toContainText('No. 7 by total NAM');
    await page.keyboard.press('Escape');
    await expect(d).toHaveCount(0);
    // opened from a link (?addr=), the sheet does not claim a list
    await gotoRoute(page, `/alerts?addr=${fxAddress(0, 'osmo1')}`);
    await expect(page.locator('dialog.sh-addr .sh-addr__ranks')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('dialog.sh-addr .sh-addr__from')).toHaveCount(0);
  });

  test('a server before the stored totals: only the spendable rank, stamped', async ({ page }, info) => {
    test.skip(onlyIn(info.project.name), 'runs once');
    const a = fxAddress(3);
    await page.route(/\/api\/address\//, (route) => route.fulfill({ json: fxReport(a, 'namada', 318, undefined) }));
    await gotoRoute(page, `/alerts?addr=${a}`);
    const ranks = page.locator('dialog.sh-addr .sh-addr__ranks');
    await expect(ranks).toHaveText(/^No\. 318 by spendable NAM/);
    await expect(ranks).not.toContainText('total NAM');
    await expect(ranks.locator('.pdot')).toHaveCount(1);
  });
});
