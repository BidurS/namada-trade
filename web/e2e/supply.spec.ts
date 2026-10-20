// Supply (/supply), S3. Layout checks run in every project of the G6 matrix; the rest once.
import { BODY } from '../../shared/copy';
import { routeById } from '../../shared/routes';
import { REWIND_AT, animationsIn, apiUrls, expect, gotoRoute, isExempt, isLiveOnly, layoutAudit, onlyIn, test, trackRequests } from './helpers';
import type { Page } from '@playwright/test';

const ROUTE = routeById('supply');

/** Wait until the pressure figures have replaced the skeletons. */
async function ready(page: Page) {
  await expect(page.locator('.sp-hero__n .hero-n__v [data-num]')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#rts-h')).toBeVisible();
}

/**
 * N1 as clarified (system.md 12): every [data-num] in main has its own provenance control, or
 * sits in a scope whose SourceLine exists and is visible.
 */
async function unstamped(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const bad: string[] = [];
    for (const el of document.querySelectorAll('main [data-num]')) {
      const r = (el as HTMLElement).getBoundingClientRect();
      if (!r.width && !r.height) continue; // a hidden layout twin (phone row vs table cell)
      const scope = el.closest('[data-prov-scope]');
      const line = scope?.querySelector('.srcb');
      const own = ['.num', '.hero-n', 'p'].some((s) => el.closest(s)?.querySelector('[data-prov]')); // its own stamp, in the same figure or sentence
      if ((line && (line as HTMLElement).offsetParent !== null) || own) continue;
      bad.push((el.textContent ?? '').trim().slice(0, 30));
    }
    return bad;
  });
}

/**
 * Taps on every address in Ready to sell (the stacked receiver and "from" lines, and the list of addresses with
 * nothing left): the top, middle and bottom of each line box, at three points across. Returns every tap that
 * lands on another control (a tap on one address must never open another).
 */
async function wrongTaps(page: Page, sel = '.rts .xaddr, .rts-gone .xaddr'): Promise<string[]> {
  const els = page.locator(sel);
  const out: string[] = [];
  for (let i = 0; i < (await els.count()); i++) {
    await els.nth(i).evaluate((el) => el.scrollIntoView({ block: 'center' }));
    out.push(...(await els.nth(i).evaluate((el) => {
      const ctrl = (e: Element | null) => e?.closest('a[href], button, [role=button], input, select, textarea, [tabindex]:not([tabindex="-1"])') ?? null;
      const bad: string[] = [];
      for (const r of el.getClientRects()) {
        for (const fy of [0.1, 0.5, 0.9]) for (const fx of [0.15, 0.5, 0.85]) {
          const hit = ctrl(document.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy));
          if (hit && hit !== el) bad.push(`${(el.textContent ?? '').trim().slice(0, 30)} @${fy} -> ${(hit.textContent ?? '').trim().slice(0, 30)}`);
        }
      }
      return bad;
    })));
  }
  return out;
}

// ---------------------------------------------------------------- a fixture over the live answer
// Known staking moves and ready-to-sell rows on top of the live /api/pressure answer: the panels must
// render them as the rules say (supply/unbonds.ts), not invent them.
const D = 864e5;
const FX = {
  ready: 'tnam1qfixturereadyaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  withdrawn: 'tnam1qfixturewithdrawnbbbbbbbbbbbbbbbbbbbbbbbb',
  withdrawnShort: 'tnam1qfixt…bbbbb',
  waiting: 'tnam1qfixturewaitingcccccccccccccccccccccccc',
  restake: 'tnam1qfixturerestakeddddddddddddddddddddddddd',
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pressureFixture(live: any) {
  const a: number = live.asOf;
  let n = 0;
  const row = (o: Record<string, unknown>) => ({ label: null, labelPlain: null, liquidAt: null, outcome: null, txHash: `${'AB'.repeat(31)}${String(++n).padStart(2, '0')}`, ...o });
  const unlocks = [
    row({ kind: 'unbond', address: FX.waiting, amountNam: 500_000, ts: a - 2 * D, liquidAt: a + 12 * D }),
    row({ kind: 'bond', address: FX.restake, amountNam: 900_000, ts: a - 3 * D + 60_000 }),
    row({ kind: 'withdraw', address: FX.restake, amountNam: 400_000, ts: a - 3 * D, outcome: { kind: 'rebonded', amountNam: 900_000 } }),
    row({ kind: 'withdraw', address: FX.restake, amountNam: 500_000, ts: a - 3 * D - 60_000, outcome: { kind: 'rebonded', amountNam: 900_000 } }),
    row({ kind: 'withdraw', address: FX.withdrawn, amountNam: 1_000_000, ts: a - 5 * D, outcome: { kind: 'liquid', amountNam: 1_000_000 } }),
    row({ kind: 'unbond', address: FX.ready, amountNam: 2_000_000, ts: a - 20 * D, liquidAt: a - 6 * D }),
    row({ kind: 'unbond', address: FX.withdrawn, amountNam: 1_000_000, ts: a - 20 * D - 60_000, liquidAt: a - 6 * D - 60_000 }),
  ];
  const deck = (o: Record<string, unknown>) => ({ label: null, labelPlain: null, linkedNamada: null, linkedLabel: null, linkedLabelPlain: null, soldSince: 0, bridgedOutSince: 0, priorSells30d: 0, firstArrival: a - 2 * D, lastSeen: a - D, ...o });
  const onDeck = [
    deck({ address: 'osmo1fixtureleftaaaaaaaaaaaaaaaaaaaaaaaaaaa', bridgedIn: 1000, soldSince: 400, remaining: 600 }),
    deck({ address: 'osmo1fixturegonebbbbbbbbbbbbbbbbbbbbbbbbbbb', bridgedIn: 500, soldSince: 500, remaining: 0 }),
  ];
  // unbondingAll is the server's total of every request still in its wait; null here so the band reads these rows.
  // no chain list of every request (production sends one since 2026-10-20): these figures come from the listed requests
  return { ...live, unbondingDays: live.unbondingDays ?? 13.75, unbondingAll: null, unbondTermStructure: undefined, unbondTermStructureProv: undefined, unlocks, onDeck, onDeckTotal: 600 };
}

/** Ready to sell rows whose receiver sits over a linked Namada address (named and not), and three addresses with nothing left. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stackedFixture(live: any) {
  const base = pressureFixture(live);
  const a: number = live.asOf;
  const deck = (i: number, o: Record<string, unknown>) => ({
    address: `osmo1fixturestack${String(i).padStart(2, '0')}${'a'.repeat(25)}`, label: null, labelPlain: null, linkedNamada: `tnam1qfixturestack${String(i).padStart(2, '0')}${'b'.repeat(25)}`,
    linkedLabel: null, linkedLabelPlain: null, bridgedIn: 20_000, soldSince: 0, bridgedOutSince: 0, remaining: 20_000 - i, priorSells30d: 0, firstArrival: a - 2 * D, lastSeen: a - D, ...o,
  });
  const onDeck = [
    deck(1, { linkedLabelPlain: 'Public sale allocation (genesis)', priorSells30d: 6_517 }),
    deck(2, {}),
    deck(3, { labelPlain: 'Fixture desk' }),
    deck(4, { labelPlain: 'Fixture market maker with a long name', linkedLabelPlain: 'Genesis: early core contributors' }),
    deck(5, { remaining: 0, soldSince: 20_000 }),
    deck(6, { remaining: 0, bridgedOutSince: 20_000, linkedNamada: null }),
    deck(7, { remaining: 0, soldSince: 15_000, bridgedOutSince: 5_000 }),
  ];
  return { ...base, onDeck, onDeckTotal: onDeck.reduce((t, e) => t + e.remaining, 0) };
}

/**
 * The unstaking days and where the NAM came from, over the fixture: the chain's own list of every request (a
 * day-1 and a day-5 bucket, one bucket with no known time, NAM whose wait is over), a listed request of an address
 * that sold what it unlocked before, and Ready to sell rows with a selling estimate above and below the cut, a
 * likely shielded-set round trip and a likely middle address.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deepFixture(live: any) {
  const base = pressureFixture(live);
  const a: number = live.asOf;
  const SELLER = 'tnam1qfixturesellerssssssssssssssssssssssssss';
  const unlocks = [
    ...base.unlocks,
    { kind: 'withdraw', address: SELLER, label: null, labelPlain: null, amountNam: 300_000, ts: a - 9 * D, liquidAt: null, txHash: `${'EF'.repeat(31)}01`, outcome: { kind: 'sold', amountNam: 250_000 } },
    { kind: 'unbond', address: SELLER, label: null, labelPlain: null, amountNam: 400_000, ts: a - 9 * D, liquidAt: a + 4.5 * D, liquidAtSource: 'estimate', txHash: `${'EF'.repeat(31)}02`, outcome: null },
  ];
  const term = {
    at: a, height: 1, currentEpoch: 100, epochSec: 21_600, epochSecSource: 'fixture',
    withdrawableNowNam: 7_654_321, inFlightNam: 1_403_000, totalUnbondingNam: 9_057_321,
    buckets: [
      { withdrawEpoch: 90, estimatedAt: a, withdrawableNow: true, amountNam: 7_654_321, count: 30 },
      { withdrawEpoch: 101, estimatedAt: a + 0.5 * D, withdrawableNow: false, amountNam: 3_000, count: 7 },
      { withdrawEpoch: 118, estimatedAt: a + 4.5 * D, withdrawableNow: false, amountNam: 900_000, count: 3 },
      { withdrawEpoch: 140, estimatedAt: a + 11.5 * D, withdrawableNow: false, amountNam: 500_000, count: 1 },
      { withdrawEpoch: 150, estimatedAt: null, withdrawableNow: false, amountNam: 1_234, count: 1 },
    ],
  };
  const deck = (o: Record<string, unknown>) => ({ label: null, labelPlain: null, linkedNamada: null, linkedLabel: null, linkedLabelPlain: null, soldSince: 0, bridgedOutSince: 0, priorSells30d: 0, firstArrival: a - 2 * D, lastSeen: a - D, ...o });
  const onDeck = [
    deck({ address: 'osmo1fixturehighaaaaaaaaaaaaaaaaaaaaaaaaaaa', bridgedIn: 1000, soldSince: 400, soldCounted: 400, sentBackCounted: 0, remaining: 600, dumpHazardScore: 0.7, priorSells30d: 8_174 }),
    deck({ address: 'osmo1fixturelowbbbbbbbbbbbbbbbbbbbbbbbbbbbb', bridgedIn: 500, soldCounted: 0, sentBackCounted: 0, remaining: 500, dumpHazardScore: 0.2,
      linkedNamada: 'tnam1qfixtureburnercccccccccccccccccccccccccc', hopOriginNamada: { address: 'tnam1qfixtureorigindddddddddddddddddddddddd', label: null, labelPlain: null },
      passthroughFrom: { address: 'tnam1qfixtureshieldeeeeeeeeeeeeeeeeeeeeeeeee', dwellMs: 3_600_000, anonymitySetK: 3, confidence: 'medium' } }),
  ];
  const pipelineSummary = { cohorts: { genesisBackersNam: 0, maspTurnstileNam: 500, burnerHopNam: 0, transparentNam: 1000 }, highHazardRemainingNam: 600 };
  return {
    ...base, unbondingDays: 14.01, unlocks, unbondTermStructure: term, unbondTermStructureProv: { source: 'Namada RPC (bond listing: every unbond on the chain)', at: a, status: 'live' },
    onDeck, onDeckTotal: 1100, onDeckTotals: { bridgedIn: 1500, sold: 400, sentBack: 0, remaining: 1100 }, pipelineSummary,
  };
}

/** Words the screen must not use: verdicts on wallets and expert terms as plain words. */
const JUDGING = /\b(dump|hazard|sticky|turnstile|maturity wall|pipeline|on deck|burner|cohort|disposition|MASP)\b/i;

test.describe('layout, every viewport', () => {
  test('live: one h1, the key figures, no overflow, no <table>, 44 px targets, text at least 11 px', async ({ page }) => {
    await gotoRoute(page, '/supply');
    await ready(page);
    await expect(page.locator('h1')).toHaveCount(1);
    await expect(page.locator('h1')).toHaveText(ROUTE.h1);
    await expect(page.locator('.ipg-facts .fact')).toHaveCount(6);
    await expect(page.locator('.ipg-facts .srcb')).toBeVisible();
    const a = await layoutAudit(page, 'main');
    expect(a.overflowX, `scrollWidth ${a.scrollWidth} > ${a.innerWidth}`).toBe(false);
    expect(a.tables).toBe(0);
    expect(a.smallText).toEqual([]);
    expect(a.smallTargets).toEqual([]);
  });

  test('rewound: banner, figures as of then, no overflow', async ({ page }) => {
    await gotoRoute(page, `/supply?at=${REWIND_AT}`);
    await ready(page);
    await expect(page.locator('.rwb')).toBeVisible();
    await expect(page.locator('.ipg-band .eyebrow')).toContainText('30 Aug 2026');
    const a = await layoutAudit(page, 'main');
    expect(a.overflowX).toBe(false);
    expect(a.smallTargets).toEqual([]);
    expect(a.smallText).toEqual([]);
  });
});

test.describe('taps, every viewport', () => {
  test('stacked addresses: a tap on either line opens that line\'s address, never its neighbour\'s; every target 44 px', async ({ page }) => {
    await gotoRoute(page, '/supply');
    await ready(page);
    const live = await page.evaluate(() => fetch('/api/pressure?days=7').then((r) => r.json()));
    await page.route('**/api/pressure?*', (route) => route.fulfill({ json: stackedFixture(live) }));
    await page.reload();
    await ready(page);
    await expect(page.locator('.rts__row')).toHaveCount(4);
    await expect(page.locator('.rts__sub .xaddr')).toHaveCount(4);
    await expect(page.locator('.rts-gone .xaddr')).toHaveCount(3);
    await expect(page.locator('.rts-gone')).toContainText('3 more addresses that received NAM in the last 7 days have none of it left, all sold or sent back');
    expect(await wrongTaps(page)).toEqual([]);
    const a = await layoutAudit(page, 'main');
    expect(a.overflowX).toBe(false);
    expect(a.smallTargets).toEqual([]);
  });
});

test.describe('unstaking days and origins, every viewport', () => {
  test('the day chart has no controls narrower than 44 px, every day reads as a row, nothing judges a wallet', async ({ page }) => {
    await gotoRoute(page, '/supply');
    await ready(page);
    const live = await page.evaluate(() => fetch('/api/pressure?days=7').then((r) => r.json()));
    await page.route('**/api/pressure?*', (route) => route.fulfill({ json: deepFixture(live) }));
    await page.reload();
    await ready(page);
    const days = page.locator('.ul-days');
    // the wait of 14.01 days is "about 14 days" in the lead, and the chart runs the same 14 days
    await expect(days.locator('#ul-days-h')).toHaveText('NAM whose unstaking wait ends each day for the next 14 days');
    await expect(page.locator('#unstaking .ipg-lead')).toContainText('takes about 14 days');
    // the strip's "still unstaking" is the chain list's own figure, the one the chart adds up
    const still = page.locator('.sp-facts .fact').nth(4);
    await expect(still.locator('.fact__n')).toContainText('1,403,000');
    await expect(still.locator('.fact__l')).toContainText("from the chain's own list");
    await expect(days.locator('.ul-days__box svg text.c-tick').first()).toBeAttached();
    await expect(days.locator('.ul-days__box button, .ul-days__box [tabindex]')).toHaveCount(0);
    // day 1: the chain's 3,000 NAM, no address; day 5: the chain's 900,000, of which the listed 400,000 of an address that sold before
    const rows = days.locator('.ul-days__row');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText('+1d');
    await expect(rows.nth(0)).toContainText('3,000');
    await expect(rows.nth(0)).toContainText('7 requests');
    await expect(rows.nth(1)).toContainText('+5d');
    await expect(rows.nth(1)).toContainText('900,000');
    await expect(rows.nth(1)).toContainText('400,000 from addresses that sold or moved most before');
    await expect(rows.nth(1)).toContainText('500,000 with no earlier unlock on record');
    await expect(rows.nth(2)).toContainText('+12d');
    await expect(days).toContainText('7,654,321');
    await expect(days).toContainText('1,234');
    await expect(days.locator('.ul-days__key')).toContainText('at least 60% of what they unlocked before');
    await expect(days.locator('.srcb')).toBeVisible();
    await expect(page.locator('main')).not.toContainText(JUDGING);
    expect(await unstamped(page)).toEqual([]);
    const a = await layoutAudit(page, 'main');
    expect(a.overflowX, `scrollWidth ${a.scrollWidth} > ${a.innerWidth}`).toBe(false);
    expect(a.tables).toBe(0);
    expect(a.smallText).toEqual([]);
    expect(a.smallTargets).toEqual([]);
  });
});

test.describe('once', () => {
  test.beforeEach(({}, info) => test.skip(onlyIn(info.project.name), 'viewport-independent: runs in 375x812'));

  test('the plain paragraphs from shared/copy.ts are visible (seo-requirements 3)', async ({ page }) => {
    await gotoRoute(page, '/supply');
    for (const p of BODY.supply.paras) await expect(page.getByText(p, { exact: true })).toBeVisible();
  });

  test('panels carry their decisions and every figure has a source (N1, N4)', async ({ page }) => {
    await gotoRoute(page, '/supply');
    await ready(page);
    for (const d of ['D2', 'D3', 'D4']) expect(await page.locator(`main [data-decision="${d}"]`).count(), d).toBeGreaterThan(0);
    expect(await page.locator('main [data-decision]:not([data-decision="D2"]):not([data-decision="D3"]):not([data-decision="D4"])').count()).toBe(0);
    await expect(page.locator('main .chip')).toHaveCount(1); // the hero figure only (rationing rule)
    expect(await unstamped(page)).toEqual([]);
    await expect(page.locator('main')).not.toContainText(/\bD[1-7]\b/);
  });

  test('the window: 1, 7 and 30 days; the hero sentence and the request follow it', async ({ page }) => {
    const reqs = trackRequests(page);
    await gotoRoute(page, '/supply');
    await ready(page);
    await page.getByRole('radio', { name: '30 days' }).check();
    await expect(page.locator('.sp-hero__def')).toContainText('the last 30 days');
    expect(reqs.some((r) => /\/api\/pressure\?.*days=30/.test(r.url()))).toBe(true);
    await page.getByRole('radio', { name: '1 day' }).check();
    await expect(page.locator('.sp-hero__def')).toContainText('the last day');
  });

  test('N3: rewound, every /api request carries at= except the exempt list, and no live-only call', async ({ page, baseURL }) => {
    const reqs = trackRequests(page);
    await gotoRoute(page, `/supply?at=${REWIND_AT}`);
    await ready(page);
    await page.waitForTimeout(1500);
    const api = apiUrls(reqs, baseURL!);
    expect(api.some((u) => u.pathname === '/api/pressure')).toBe(true);
    for (const u of api) {
      if (isExempt(u.pathname)) continue;
      expect(isLiveOnly(u.pathname), `live-only call while rewound: ${u.pathname}`).toBe(false);
      expect(u.searchParams.get('at'), u.pathname + u.search).toBe(String(REWIND_AT));
    }
    // dollar values are worded as of then, not "now"
    await expect(page.locator('.sp-hero__usd')).toContainText('at the price then');
  });

  test('votes: the panel shows only when a proposal is in progress', async ({ page }) => {
    await gotoRoute(page, '/supply');
    await ready(page);
    const live = await page.evaluate(() => fetch('/api/pressure?days=7').then((r) => r.json()));
    if (!live.proposals.length) await expect(page.locator('#vote-h')).toHaveCount(0);
    // the same response with one proposal added (a fixture: the panel must render it, not invent it)
    const proposal = { id: 4242, title: 'Fixture proposal', authors: null, abstract: null, type: 'default_with_wasm', status: 'voting', startEpoch: 1, endEpoch: 2, activationEpoch: 3, yayNam: 3, nayNam: 2, abstainNam: 1, discussionsUrl: null };
    await page.route('**/api/pressure?*', (route) => route.fulfill({ json: { ...live, proposals: [proposal] } }));
    await page.reload();
    await ready(page);
    await expect(page.locator('#vote-h')).toHaveText('Votes in progress');
    await expect(page.locator('.vote')).toContainText('Fixture proposal');
    await expect(page.locator('.vote')).toContainText('Voting now');
    const a = await layoutAudit(page, 'main');
    expect(a.overflowX).toBe(false);
    expect(a.smallTargets).toEqual([]);
  });

  test('an address name opens the address sheet', async ({ page }) => {
    await gotoRoute(page, '/supply');
    await ready(page);
    const name = page.locator('.mvr__row .xaddr').first();
    test.skip((await name.count()) === 0, 'no movers in the window');
    await name.click();
    await expect(page.locator('dialog[open]')).toBeVisible();
    await expect(page).toHaveURL(/[?&]addr=/);
  });

  test('when the request fails the page says so, in words, without a stand-in figure', async ({ page }) => {
    await page.route('**/api/pressure?*', (route) => route.fulfill({ status: 503, body: 'down' }));
    await gotoRoute(page, '/supply');
    await expect(page.getByText('The supply lists did not load.')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.sp-hero__n')).toHaveCount(0);
    await expect(page.locator('main')).not.toContainText(/http|\/api\//);
    const a = await layoutAudit(page, 'main');
    expect(a.overflowX).toBe(false);
  });

  test('unstaked NAM: two figures in the band; the link opens the Unstaking list with those requests first', async ({ page }) => {
    await gotoRoute(page, '/supply');
    await ready(page);
    const live = await page.evaluate(() => fetch('/api/pressure?days=7').then((r) => r.json()));
    await page.route('**/api/pressure?*', (route) => route.fulfill({ json: pressureFixture(live) }));
    await page.reload();
    await ready(page);
    const facts = page.locator('.sp-facts .fact');
    await expect(facts).toHaveCount(6);
    // wait over and not withdrawn: A's 2,000,000 (B's request was withdrawn); still in the wait: C's 500,000
    await expect(facts.nth(3).locator('.fact__n')).toContainText('2,000,000');
    await expect(facts.nth(4).locator('.fact__n')).toContainText('500,000');
    await expect(facts.nth(4).locator('.fact__l')).toContainText('still unstaking');
    const link = facts.nth(3).getByRole('link', { name: 'unstaked, wait over, not withdrawn' });
    await link.click();
    await expect(page).toHaveURL(/\/supply#unstaking$/);
    await expect(page.getByRole('radio', { name: /^Unstaking/ })).toBeChecked();
    const rows = page.locator('#unstaking .ulr__row');
    await expect(rows.nth(0)).toContainText('2,000,000');
    await expect(rows.nth(0)).toContainText('Wait over since');
    await expect(rows.nth(0)).toContainText('No withdrawal of it is recorded');
    await expect(rows.nth(1)).toContainText('500,000');
    await expect(rows.nth(1)).toContainText('Sellable in');
    await expect(page.locator('#unstaking .ul-order')).toBeVisible();
    await expect(rows.filter({ hasText: FX.withdrawnShort }).filter({ hasText: 'Unstaking' })).toContainText('Withdrawn');
    // a restake: only that the same address staked again within 48 h, and one total for two unlocks
    await expect(rows.filter({ hasText: 'Restaked, not a sale' }).first()).toContainText('The same address staked 900,000 NAM again within 48 hours, one total for its 2 unlocks listed here.');
    await expect(page.locator('#unstaking .ipg-lead')).toContainText('A restake is NAM staked again after unlocking; it is not a sale.');
    await expect(page.locator('main')).not.toContainText('between validators');
    const a = await layoutAudit(page, 'main');
    expect(a.overflowX).toBe(false);
    expect(a.smallTargets).toEqual([]);
  });

  test('unstaked NAM: each staking figure says which requests it counts; a count of every size replaces a 0 that hides small requests', async ({ page }) => {
    await gotoRoute(page, '/supply');
    await ready(page);
    const live = await page.evaluate(() => fetch('/api/pressure?days=7').then((r) => r.json()));
    const fx = pressureFixture(live);
    const a: number = fx.asOf;
    // a server that sends the list's minimum but no count of every size: both figures say they count the large requests only
    await page.route('**/api/pressure?*', (route) => route.fulfill({ json: { ...fx, unlocksMinNam: 100_000, unbondingAll: undefined } }));
    await page.reload();
    await ready(page);
    const facts = page.locator('.sp-facts .fact');
    await expect(facts.nth(3).locator('.fact__n')).toContainText('2,000,000');
    await expect(facts.nth(3).locator('.fact__l')).toContainText('only requests of 100,000 NAM or more');
    await expect(facts.nth(4).locator('.fact__n')).toContainText('500,000');
    await expect(facts.nth(4).locator('.fact__l')).toContainText('only requests of 100,000 NAM or more');
    await expect(page.locator('#unstaking .ipg-lead')).toContainText('The staking moves of 100,000 NAM or more in the last 30');
    // a server that counts every request still in its wait (of any size). A listed request made inside that span whose own
    // end of wait (the indexer's) has passed is withdrawable: it counts once, in the first figure, never in both.
    const early = { kind: 'unbond', address: 'tnam1qfixtureearlyeeeeeeeeeeeeeeeeeeeeeeeeeeee', label: null, labelPlain: null, amountNam: 300_000, ts: a - 13.6 * D, liquidAt: a - 3_600_000, liquidAtSource: 'indexer', outcome: null, txHash: `${'CD'.repeat(31)}01` };
    await page.unroute('**/api/pressure?*');
    await page.route('**/api/pressure?*', (route) => route.fulfill({
      json: { ...fx, unlocksMinNam: 100_000, unlocks: [...fx.unlocks, early], unbondingAll: { nam: 854_062, n: 13, from: a - 13.75 * D } },
    }));
    await page.reload();
    await ready(page);
    await expect(facts.nth(3).locator('.fact__n')).toContainText('2,300,000');
    await expect(facts.nth(3).locator('.fact__l')).toContainText('only requests of 100,000 NAM or more');
    await expect(facts.nth(4).locator('.fact__n')).toContainText('554,062');
    await expect(facts.nth(4).locator('.fact__l')).toContainText('counting requests of every size');
    await expect(facts.nth(4).locator('.fact__l')).not.toContainText('only requests of');
    // the source sheet names what each staking figure counts
    await page.locator('.sp-facts .srcb').first().click();
    await expect(page.locator('dialog[open]')).toContainText('Unstaked NAM still in its wait, requests of every size');
    await expect(page.locator('dialog[open]')).toContainText('Unstaked NAM whose wait is over and that was not withdrawn, only requests of 100,000 NAM or more');
    await page.keyboard.press('Escape');
    const lay = await layoutAudit(page, 'main');
    expect(lay.overflowX).toBe(false);
    expect(lay.smallTargets).toEqual([]);
  });

  test('ready to sell: an address with nothing left is named under the list, not a row; the column says "last crossed in"', async ({ page }) => {
    await gotoRoute(page, '/supply');
    await ready(page);
    const live = await page.evaluate(() => fetch('/api/pressure?days=7').then((r) => r.json()));
    await page.route('**/api/pressure?*', (route) => route.fulfill({ json: pressureFixture(live) }));
    await page.reload();
    await ready(page);
    await expect(page.locator('.rts__row')).toHaveCount(1);
    await expect(page.locator('.rts__row')).toContainText('last crossed in');
    await expect(page.locator('.rts-gone')).toContainText('One more address that received NAM in the last 7 days has none of it left, all sold or sent back');
    await expect(page.locator('.rts-gone .xaddr')).toHaveCount(1);
    await expect(page.locator('main')).not.toContainText('last seen');
  });

  test('ready to sell: a shared genesis label prints its short address, so a seller never reads as the largest holder', async ({ page }) => {
    await gotoRoute(page, '/supply');
    await ready(page);
    const live = await page.evaluate(() => fetch('/api/pressure?days=7').then((r) => r.json()));
    const SELLER = 'tnam1qrt5tarfixturesellerxxxxxxxxxxxxxxxx7k2vd';
    await page.route('**/api/pressure?*', (route) => {
      const fx = pressureFixture(live);
      fx.onDeck[0] = { ...fx.onDeck[0], linkedNamada: SELLER, linkedLabel: 'Genesis: public_allocations_completed', linkedLabelPlain: 'Public sale allocation (genesis)' };
      fx.onDeck[1] = { ...fx.onDeck[1], label: 'Genesis: public_allocations_completed', labelPlain: 'Public sale allocation (genesis)' };
      return route.fulfill({ json: fx });
    });
    await page.reload();
    await ready(page);
    const short = `${SELLER.slice(0, 10)}…${SELLER.slice(-5)}`;
    await expect(page.locator('.rts__row .rts__link')).toContainText(`from Public sale allocation (genesis) ${short}`);
    // the address that has none left, named in the list under the rows, carries its own short address
    await expect(page.locator('.rts-gone .xaddr__a')).toHaveText('osmo1fixtu…bbbbb');
  });

  test('a tag a signed-in wallet wrote says who wrote it, on Ready to sell and Unstaking rows', async ({ page }) => {
    await gotoRoute(page, '/supply');
    await ready(page);
    const live = await page.evaluate(() => fetch('/api/pressure?days=7').then((r) => r.json()));
    await page.route('**/api/pressure?*', (route) => {
      const fx = pressureFixture(live);
      fx.onDeck[0] = { ...fx.onDeck[0], label: 'Big exchange', labelPlain: 'Big exchange', labelSource: 'user', labelAuthor: 'tnam1qxyzabc…' };
      fx.unlocks[0] = { ...fx.unlocks[0], label: 'Team wallet', labelPlain: 'Team wallet', labelSource: 'user', labelAuthor: null };
      return route.fulfill({ json: fx });
    });
    await page.reload();
    await ready(page);
    await expect(page.locator('.rts__row .rts__name .xaddr')).toContainText('Big exchange · Tag by tnam1qxyzabc…');
    await expect(page.locator('.ulr__row .xaddr', { hasText: 'Team wallet' })).toContainText('Team wallet · Tag by a signed-in wallet');
  });

  test('live: refreshed every 2 minutes; a failed refresh keeps the figures, marked old with the reason', async ({ page }) => {
    await page.clock.install();
    const reqs = trackRequests(page);
    const pressureCalls = () => reqs.filter((r) => new URL(r.url()).pathname === '/api/pressure').length;
    await gotoRoute(page, '/supply');
    await ready(page);
    const first = pressureCalls();
    await page.route('**/api/pressure?*', (route) => route.fulfill({ status: 503, body: 'down' }));
    await page.clock.fastForward('02:05');
    await expect.poll(pressureCalls).toBeGreaterThan(first);
    await expect(page.locator('.sp-facts .facts__old')).toContainText('The latest refresh did not answer, so these figures are from');
    await expect(page.locator('.sp-hero__n .hero-n__v [data-num]')).toHaveAttribute('data-status', 'old');
    await expect(page.locator('#rts-h')).toBeVisible(); // the lists stay; no skeletons
    await page.unroute('**/api/pressure?*');
    await page.clock.fastForward('02:05');
    await expect(page.locator('.sp-facts .facts__old')).toHaveCount(0);
  });

  test('where the NAM came from: two bars written out, a selling estimate only at the cut, likely links hedged', async ({ page }) => {
    await gotoRoute(page, '/supply');
    await ready(page);
    const live = await page.evaluate(() => fetch('/api/pressure?days=7').then((r) => r.json()));
    await page.route('**/api/pressure?*', (route) => route.fulfill({ json: deepFixture(live) }));
    await page.reload();
    await ready(page);
    const pipe = page.locator('.sp-pipe');
    await expect(pipe.locator('#sp-pipe-h')).toHaveText('Where this NAM came from, and what happened to it');
    await expect(pipe.locator('.sp-pipe__item')).toHaveCount(7);
    await expect(pipe.locator('.sp-pipe__item', { hasText: 'Out of the shielded set' })).toContainText('500');
    await expect(pipe.locator('.sp-pipe__item', { hasText: 'Still there' })).toContainText('1,100');
    await expect(pipe).toContainText('600 NAM sits with addresses whose selling estimate is 60% or more');
    await expect(pipe.locator('.srcb')).toBeVisible();
    await expect(pipe.locator('[title]')).toHaveCount(0);
    const rows = page.locator('.rts__row');
    await expect(rows.nth(0).locator('.rts__tags')).toContainText('Selling estimate 70%');
    await expect(rows.nth(0).locator('.rts__tags')).toContainText('Sold 8,174 NAM in the 30 days before the window');
    await expect(rows.nth(1)).not.toContainText('Selling estimate');
    await expect(rows.nth(1)).toContainText('likely through a middle address, from');
    await expect(rows.nth(1)).toContainText('Likely out of the shielded set less than a day after going in (one of 3 moves of that size it could match)');
    await expect(page.locator('main')).not.toContainText(JUDGING);
    // a server that does not send the split: said, not hidden
    await page.unroute('**/api/pressure?*');
    await page.route('**/api/pressure?*', (route) => route.fulfill({ json: { ...deepFixture(live), pipelineSummary: undefined } }));
    await page.reload();
    await ready(page);
    await expect(page.locator('.sp-pipe')).toHaveCount(0);
    await expect(page.locator('.sp-pipe__none')).toContainText('not sent by this server');
  });

  test('a server that answers for a shorter window than the one picked says so', async ({ page }) => {
    await gotoRoute(page, '/supply');
    await ready(page);
    const live = await page.evaluate(() => fetch('/api/pressure?days=7').then((r) => r.json()));
    await page.route('**/api/pressure?*', (route) => {
      const days = Number(new URL(route.request().url()).searchParams.get('days'));
      return route.fulfill({ json: { ...live, windowDays: Math.min(days, 30) } });
    });
    await page.getByRole('radio', { name: '1 year' }).check();
    await expect(page.locator('.sp-hero__note')).toHaveText('You picked the last year, but the server answered for the last 30 days: every figure on this page covers the last 30 days.');
    await page.getByRole('radio', { name: '7 days' }).check();
    await expect(page.locator('.sp-hero__note')).toHaveCount(0);
  });

  test('G7: nothing on the screen animates under reduced motion', async ({ page }) => {
    await gotoRoute(page, '/supply', { reducedMotion: true });
    await ready(page);
    await page.waitForTimeout(800);
    expect(await animationsIn(page, 'main')).toBe(0);
  });
});

// ---------------------------------------------------------------- the review's edge cases (once)
test.describe('edge cases, once', () => {
  test('a split of origins without its parts, or with one part missing, never crashes and never prints shares over a part', async ({ page }, info) => {
    test.skip(onlyIn(info.project.name), 'runs once');
    await gotoRoute(page, '/supply');
    await ready(page);
    const live = await page.evaluate(() => fetch('/api/pressure?days=7').then((r) => r.json()));
    const base = { ...live, onDeckTotals: { bridgedIn: 2_335, sold: 300, sentBack: 35, remaining: 2_000 } };
    // no cohorts at all: the screen stands, and the origins are said to be not sent
    await page.route('**/api/pressure?*', (route) => route.fulfill({ json: { ...base, pipelineSummary: { highHazardRemainingNam: 5 } } }));
    await page.reload();
    await ready(page);
    await expect(page.locator('.sp-pipe__none')).toBeVisible();
    await expect(page.locator('main')).not.toContainText('did not load');
    // one cohort missing: its figure is "—" with the reason, no percentages and no bar for the origins
    await page.unroute('**/api/pressure?*');
    await page.route('**/api/pressure?*', (route) => route.fulfill({
      json: { ...base, pipelineSummary: { highHazardRemainingNam: 0, cohorts: { genesisBackersNam: null, maspTurnstileNam: 0, burnerHopNam: 0, transparentNam: 2_335 } } },
    }));
    await page.reload();
    await ready(page);
    const before = page.locator('.sp-pipe__row').first();
    await expect(before).toContainText('did not send every origin');
    await expect(before.locator('.sp-pipe__track')).toHaveCount(0);
    await expect(before.locator('.sp-pipe__pct')).toHaveCount(0);
    await expect(before.locator('[data-num][data-status="none"]').first()).toHaveText('—');
    expect(await unstamped(page)).toEqual([]);
  });

  test('a response without its window says so, never "undefined days"', async ({ page }, info) => {
    test.skip(onlyIn(info.project.name), 'runs once');
    await gotoRoute(page, '/supply');
    await ready(page);
    const live = await page.evaluate(() => fetch('/api/pressure?days=7').then((r) => r.json()));
    const j = { ...live };
    delete j.windowDays;
    await page.route('**/api/pressure?*', (route) => route.fulfill({ json: j }));
    await page.reload();
    await ready(page);
    await expect(page.locator('main')).not.toContainText('undefined');
    await expect(page.locator('.sp-hero__note')).toHaveCount(0);
  });

  test('staked NAM over a longer range: a failed answer reads as "—" with Try again, never the 14-day readings under it', async ({ page }, info) => {
    test.skip(onlyIn(info.project.name), 'runs once');
    await gotoRoute(page, '/supply');
    await ready(page);
    const live = await page.evaluate(() => fetch('/api/pressure?days=7').then((r) => r.json()));
    // a record that began 15 days ago, so the ranges are offered
    const a: number = live.asOf;
    const bondedTrend = Array.from({ length: 61 }, (_, i) => ({ ts: a - (60 - i) * 6 * 3_600_000, value: 267_000_000 + i * 100 }));
    await page.route('**/api/pressure?*', (route) => route.fulfill({ json: { ...live, bondedTrend } }));
    await page.route('**/api/metrics/history*', (route) => route.fulfill({ status: 500, body: 'no' }));
    await page.reload();
    await ready(page);
    const mode = page.locator('.ul-chart__mode');
    if (await mode.count()) await mode.getByRole('radio', { name: 'Staked NAM over time' }).check();
    await page.locator('.ul-chart').getByRole('radio', { name: '1y' }).check();
    const miss = page.locator('.ul-stake-miss');
    await expect(miss).toContainText('— The server did not answer for that range.');
    await expect(miss.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(page.locator('.ul-chart .chart-box')).toHaveCount(0);
    // back to 14d: the recorded readings again
    await miss.getByRole('radio', { name: '14d' }).click();
    await expect(page.locator('.ul-chart .chart-box svg').first()).toBeVisible();
  });
});
