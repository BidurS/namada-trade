// Trade (/trade), S2: system.md 9.2 and the Trade row of build-plan section 8.
// Layout checks run in every viewport of the G6 matrix with production data (read-only proxy).
// State checks run once (375x812) with the quote endpoints answered from the dated design snapshot
// (docs/design/data/snapshot.json, captured 17 Oct 2026 11:24 UTC), so the degraded, live and down
// states are each exercised whatever production is doing at the time.
import fs from 'node:fs';
import type { Page } from '@playwright/test';
import { BODY } from '../../shared/copy';
import { routeById } from '../../shared/routes';
import { REWIND_AT, apiUrls, expect, gotoRoute, isExempt, isLiveOnly, layoutAudit, onlyIn, test, trackRequests } from './helpers';

const ROUTE = routeById('trade');
const SNAP = JSON.parse(fs.readFileSync(new URL('../../docs/design/data/snapshot.json', import.meta.url), 'utf8'));
const DOWN = 'The Osmosis quote service is not answering.';

/** The quote endpoints, answered from the snapshot. `quote`: 'down' (degraded), 'live', or both 'down' and an empty table. */
async function mockQuotes(page: Page, mode: 'table' | 'live' | 'down') {
  const now = Date.now();
  const curve = mode === 'down'
    ? { ...SNAP.curve, curve: [], maxSafeClip1PctNam: null, maxSafeClip3PctNam: null, prov: { source: 'Osmosis SQS', at: null, status: 'missing', note: DOWN } }
    : { ...SNAP.curve, prov: { ...SNAP.curve.prov, at: now - 2000 } };
  const pools = mode === 'down'
    ? { pools: [], prov: { source: 'Osmosis SQS pools', at: null, status: 'missing', note: DOWN } }
    : { ...SNAP.pools, prov: { ...SNAP.pools.prov, at: now - 2000 } };
  await page.route(/\/api\/quote\/curve/, (r) => r.fulfill({ json: curve }));
  await page.route(/\/api\/pools/, (r) => r.fulfill({ json: pools }));
  await page.route(/\/api\/quote\?/, (r) => {
    if (mode !== 'live') return r.fulfill({ json: { quote: null, error: DOWN, code: 'unavailable' } });
    // a live answer for any amount: the snapshot's 5,000 NAM row reused, scaled to the asked amount
    const u = new URL(r.request().url());
    const amount = Number(u.searchParams.get('amount'));
    const side = u.searchParams.get('side') as 'sell' | 'buy';
    const row = SNAP.curve.curve.find((p: { amountNam: number }) => p.amountNam === 5000);
    const k = amount / 5000;
    const spot = SNAP.curve.spotUsd;
    const quote = side === 'sell'
      ? { amountNam: amount, side, inAmount: amount, inSymbol: 'NAM', outAmount: row.sellOutUsdc * k, outSymbol: 'USDC', spotPriceUsd: spot, effectivePriceUsd: row.sellEffectiveUsd, usdcValue: row.sellOutUsdc * k, priceImpactPct: row.sellImpactPct, effectiveFeePct: 0.2, route: [], prov: { source: 'Osmosis SQS router', at: Date.now(), status: 'live' } }
      : { amountNam: amount, side, inAmount: row.buyInUsdc * k, inSymbol: 'USDC', outAmount: (row.buyInUsdc * k) / row.buyEffectiveUsd, outSymbol: 'NAM', spotPriceUsd: spot, effectivePriceUsd: row.buyEffectiveUsd, usdcValue: row.buyInUsdc * k, priceImpactPct: row.buyImpactPct, effectiveFeePct: 0.2, route: [], prov: { source: 'Osmosis SQS router', at: Date.now(), status: 'live' } };
    return r.fulfill({ json: { quote } });
  });
}

/** The ticket has settled: no skeleton left in the "You get" block. */
async function settled(page: Page) {
  await expect(page.locator('.get[aria-busy="true"]')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator('.get__v [data-num]')).toBeVisible();
}

test.describe('layout, every viewport', () => {
  test('live: one h1, no overflow, no <table>, 44 px targets, text at least 11 px', async ({ page }) => {
    await gotoRoute(page, '/trade');
    await settled(page);
    await expect(page.locator('#h-chart')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('h1')).toHaveCount(1);
    await expect(page.locator('h1')).toHaveText(ROUTE.h1);
    const a = await layoutAudit(page);
    expect(a.overflowX, `scrollWidth ${a.scrollWidth} > ${a.innerWidth}`).toBe(false);
    expect(a.tables).toBe(0);
    expect(a.smallText).toEqual([]);
    expect(a.smallTargets).toEqual([]);
  });

  test('rewound: no overflow, no live-only request', async ({ page }) => {
    const reqs = trackRequests(page);
    await gotoRoute(page, `/trade?at=${REWIND_AT}`);
    await expect(page.locator('.rwb')).toBeVisible();
    await expect(page.locator('#h-chart')).toBeVisible({ timeout: 30_000 });
    const a = await layoutAudit(page);
    expect(a.overflowX).toBe(false);
    expect(a.tables).toBe(0);
    expect(a.smallTargets).toEqual([]);
    expect(apiUrls(reqs, new URL(page.url()).origin).filter((u) => isLiveOnly(u.pathname)).map(String)).toEqual([]);
  });
});

test.describe('once', () => {
  test.beforeEach(({}, info) => test.skip(onlyIn(info.project.name), 'viewport-independent: runs in 375x812'));

  test('the h1, the page text from shared/copy.ts and the key figures render', async ({ page }) => {
    await gotoRoute(page, '/trade');
    await expect(page.locator('h1')).toHaveText(ROUTE.h1);
    for (const p of BODY.trade.paras) await expect(page.getByText(p, { exact: true })).toBeVisible();
    await expect(page.locator('[data-decision="D1"]')).toHaveCount(1);
    await settled(page);
    await expect(page.locator('.get__prov [data-prov]')).toBeVisible();
    await expect(page.locator('#h-chart')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.chartsec .cstats [data-num]').first()).toBeVisible();
    await expect(page.locator('#h-ladder')).toBeVisible();
    await expect(page.locator('#h-pools')).toBeVisible();
    // every panel ends in a SourceLine
    for (const sel of ['.tk-chart', '.ladder', '.pools']) await expect(page.locator(`${sel} .srcb`).first()).toBeVisible();
  });

  test('degraded: the size-table marker, paragraph and chip; listed sizes only; one figure everywhere', async ({ page }) => {
    await mockQuotes(page, 'table');
    await gotoRoute(page, '/trade');
    await settled(page);
    await expect(page.locator('.field__top')).toContainText('live quote not answering');
    await expect(page.locator('.get')).toContainText('from the size table');
    await expect(page.locator('.get__why').first()).toContainText('These figures come from the size table');
    await expect(page.locator('.get__prov .chip')).toHaveText(/Size table · (now|\d+\ss)/);
    await expect(page.locator('.tk-field input')).toHaveAttribute('readonly', '');
    await expect(page.locator('.tk-note')).toContainText('Listed sizes only');
    await expect(page.locator('.lrow')).toHaveCount(6);
    // the 5,000 NAM sale reads −1.49% in the ticket, the thin-market notice, the curve readout and the picked ladder row
    const move = '−1.49%';
    await expect(page.locator('.pair__big')).toHaveText(move);
    await expect(page.locator('.notice--thin')).toContainText(`already moves the price ${move}`);
    await expect(page.locator('.curve__read')).toContainText(move);
    await expect(page.locator('.lrow.is-sel .lrow__smv')).toHaveText(move);
    // a ladder row sets the ticket
    await page.locator('.lrow__pick[aria-label="Quote 25,000 NAM"]').click();
    await expect(page.locator('.tk-field input')).toHaveValue('25,000');
    await expect(page.locator('.lrow.is-sel .lrow__size')).toContainText('25,000');
    // buying: the verb follows the side
    await page.getByRole('radio', { name: 'Buy NAM with USDC' }).click();
    await expect(page.locator('h1')).toHaveText('What would I pay to buy NAM now?');
    await expect(page.locator('.get__k')).toContainText('You pay');
    await expect(page.locator('.pair__big')).toHaveText(/^\+\d+\.\d\d%$/);
    // the safe sizes say "buying or selling" (the worse side, W6)
    await expect(page.locator('.tk-safe')).toContainText('buying or selling');
  });

  test('live: the Osmosis quote chip and a real input that quotes any amount', async ({ page }) => {
    await mockQuotes(page, 'live');
    const reqs = trackRequests(page);
    await gotoRoute(page, '/trade');
    await settled(page);
    await expect(page.locator('.get__prov .chip')).toHaveText(/Osmosis quote · (now|\d+\ss)/);
    await expect(page.locator('.field__top')).not.toContainText('not answering');
    await expect(page.locator('.get__why')).toHaveCount(0);
    const input = page.locator('.tk-field input');
    await expect(input).not.toHaveAttribute('readonly', '');
    await input.fill('7300');
    await expect.poll(() => apiUrls(reqs, new URL(page.url()).origin).some((u) => u.pathname === '/api/quote' && u.searchParams.get('amount') === '7300')).toBe(true);
    await settled(page);
    await expect(page.locator('.get__s')).toContainText('7,300 NAM');
    // the curve shows the typed amount as a cursor between two real quotes, labelled
    await expect(page.locator('.curve__how')).toContainText('Estimate');
    // not an amount: said under the field, nothing asked
    await input.fill('abc');
    await expect(page.locator('.tk-field')).toContainText('That is not an amount.');
  });

  test('down: no figure, the reason in view, the last stored price', async ({ page }) => {
    await mockQuotes(page, 'down');
    await gotoRoute(page, '/trade');
    await settled(page);
    await expect(page.locator('.get__v [data-num]')).toHaveText('—');
    await expect(page.locator('.get__s')).toContainText(DOWN);
    await expect(page.locator('.pair dt').first()).toHaveText('Last quoted price');
    await expect(page.locator('.ladder')).toContainText('The size table is empty.');
    await expect(page.locator('.pools')).toContainText('The pool list is not available.');
    await expect(page.locator('.lrow')).toHaveCount(0);
  });

  test('a refresh that comes back empty keeps the last answer, marked old with its own time', async ({ page }) => {
    await page.clock.install();
    let good = true;
    await page.route(/\/api\/quote\/curve/, (r) => r.fulfill({ json: good ? { ...SNAP.curve, prov: { ...SNAP.curve.prov, at: Date.now() } } : { ...SNAP.curve, curve: [], prov: { source: 'Osmosis SQS', at: null, status: 'missing', note: DOWN } } }));
    await page.route(/\/api\/pools/, (r) => r.fulfill({ json: good ? { ...SNAP.pools, prov: { ...SNAP.pools.prov, at: Date.now() } } : { pools: [], prov: { source: 'Osmosis SQS pools', at: null, status: 'missing', note: DOWN } } }));
    await page.route(/\/api\/quote\?/, (r) => r.fulfill({ json: { quote: null, error: DOWN, code: 'unavailable' } }));
    await gotoRoute(page, '/trade');
    await expect(page.locator('.lrow')).toHaveCount(6);
    await expect(page.locator('.pools .prow').first()).toBeVisible();
    good = false;
    await page.clock.runFor(125_000);
    await expect(page.locator('.lrow')).toHaveCount(6);
    await expect(page.locator('.get__prov .chip')).toHaveText(/Size table · old\s2\smin/);
    await expect(page.locator('.ladder .scope__old')).toContainText('its last answer, from 2 min ago');
    await expect(page.locator('.pools .scope__old')).toContainText('its last answer, from 2 min ago');
  });

  test('a failed price history says so with Try again, never "No trades in this window" and never an endless skeleton', async ({ page }) => {
    let down = true;
    await page.route(/\/api\/metrics\/history/, (r) => (down ? r.fulfill({ status: 503, body: 'unavailable' }) : r.continue()));
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await gotoRoute(page, '/trade');
    const chart = page.locator('.tk-chart');
    await expect(chart.locator('#h-chart')).toHaveText('The price history did not load', { timeout: 30_000 });
    await expect(chart).toContainText('The server answered with an error.');
    await expect(chart.locator('[aria-busy="true"]')).toHaveCount(0);
    await expect(chart).not.toContainText('No trades in this window');
    await expect(chart).not.toContainText('No trade in this window');
    // Try again, with the history answering now: the chart comes back
    down = false;
    await chart.getByRole('button', { name: 'Try again' }).click();
    await expect(chart.locator('.chartsec')).toBeVisible({ timeout: 30_000 });
    await expect(chart.locator('#h-chart')).not.toHaveText('The price history did not load');
    expect(errors.filter((e) => /metrics\/history/.test(e)), 'no uncaught rejection from the history request').toEqual([]);
  });

  test('a failed price-history refresh keeps the chart, marked old with the time it was fetched', async ({ page }) => {
    await page.clock.install();
    let down = false;
    await page.route(/\/api\/metrics\/history/, (r) => (down ? r.fulfill({ status: 503, body: 'unavailable' }) : r.continue()));
    await gotoRoute(page, '/trade');
    const chart = page.locator('.tk-chart');
    await expect(chart.locator('.chartsec')).toBeVisible({ timeout: 30_000 });
    const heading = await chart.locator('#h-chart').innerText();
    down = true;
    await page.clock.runFor(305_000);
    await expect(chart.locator('.scope__old')).toContainText('The latest refresh of the price history did not answer, so this is the history fetched at', { timeout: 15_000 });
    await expect(chart.locator('.chartsec')).toBeVisible();
    await expect(chart.locator('#h-chart')).toHaveText(heading);
    await expect(chart.locator('.chartsec .srcb').first()).toHaveAttribute('data-status', /old|none/);
    await expect(chart).not.toContainText('No trades in this window');
  });

  test('safe sizes say how they were made: "under" the smallest size, never a figure scaled down from zero (an older server)', async ({ page }) => {
    // the snapshot as an older server sent it: 1,000 NAM already moves the price 3.14% (buying), and the server
    // scaled 318 and 954 NAM down from zero, which no quote supports
    await mockQuotes(page, 'table');
    await gotoRoute(page, '/trade');
    const safe = page.locator('.tk-safe');
    // both limits under the smallest size: one sentence, never "under 1,000 NAM" twice
    await expect(safe).toContainText(/Even the smallest size quoted, 1,000\sNAM, moves the price 3\.14%, the worse of buying or selling, so no listed order moves it 1% or less, or 3% or less\./, { timeout: 30_000 });
    await expect(safe).not.toContainText('under');
    await expect(safe).not.toContainText('318');
    await expect(safe).not.toContainText('954');
    await expect(safe).not.toContainText('read off the size table');
  });

  test('safe sizes from a current server: "about" between two listed sizes, "at least" past the largest', async ({ page }) => {
    const now = Date.now();
    const imp = [0.5, 1.6, 2, 2.4, 2.6, 2.9];
    const curve = {
      ...SNAP.curve,
      curve: SNAP.curve.curve.map((p: { amountNam: number }, i: number) => ({ ...p, sellImpactPct: imp[i], buyImpactPct: imp[i] })),
      maxSafeClip1PctNam: 2000,
      maxSafeClip3PctNam: 100000,
      safeClip1Pct: { nam: 2000, how: 'interpolated', smallestNam: 1000, smallestImpactPct: 0.5 },
      safeClip3Pct: { nam: 100000, how: 'at_least', smallestNam: 1000, smallestImpactPct: 0.5 },
      prov: { ...SNAP.curve.prov, at: now - 2000 },
    };
    await page.route(/\/api\/quote\/curve/, (r) => r.fulfill({ json: curve }));
    await page.route(/\/api\/quote\?/, (r) => r.fulfill({ json: { quote: null, error: DOWN, code: 'unavailable' } }));
    await gotoRoute(page, '/trade');
    const safe = page.locator('.tk-safe');
    await expect(safe).toContainText(/1% or less, buying or selling, is about\s2,000\sNAM; 3% or less, at least\s100,000\sNAM\./, { timeout: 30_000 });
    await expect(safe).toContainText('“About” is a straight line between the two listed sizes around the limit, not a quote.');
    await expect(safe).toContainText('“At least”: even the largest size quoted moves the price less than that.');
  });

  test('rewound: no quote, size-table or pool request; every other /api request carries at', async ({ page }) => {
    const reqs = trackRequests(page);
    await gotoRoute(page, `/trade?at=${REWIND_AT}`);
    await expect(page.locator('.rwb')).toBeVisible();
    await expect(page.locator('.field__top')).toContainText('live quotes paused');
    await expect(page.locator('.get__s')).toContainText('Live quotes are paused while rewound.');
    await expect(page.locator('#h-chart')).toBeVisible({ timeout: 30_000 });
    await page.waitForLoadState('networkidle');
    const urls = apiUrls(reqs, new URL(page.url()).origin);
    expect(urls.filter((u) => isLiveOnly(u.pathname)).map(String)).toEqual([]);
    expect(urls.filter((u) => !isExempt(u.pathname) && u.searchParams.get('at') !== String(REWIND_AT)).map(String)).toEqual([]);
    expect(urls.some((u) => u.pathname === '/api/metrics/history')).toBe(true);
    // picking a size does not ask for a quote either
    await page.locator('.pre', { hasText: '10,000' }).click();
    await expect(page.locator('.tk-field input')).toHaveValue('10,000');
    await page.waitForTimeout(800);
    expect(apiUrls(reqs, new URL(page.url()).origin).filter((u) => isLiveOnly(u.pathname)).map(String)).toEqual([]);
  });
});

test.describe('desktop widths', () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== '1280x800', 'the split column maths: runs in 1280x800, resized'));

  test('the ticket keeps its width from 1200 px up, and every preset keeps its text inside its outline', async ({ page }) => {
    await gotoRoute(page, '/trade');
    await expect(page.locator('.ticket .pre').first()).toBeVisible();
    const width: Record<number, number> = {};
    for (const w of [1024, 1100, 1280, 1600, 1920, 2560]) {
      await page.setViewportSize({ width: w, height: 900 });
      const m = await page.evaluate(() => {
        const ticket = document.querySelector('.ticket')!.getBoundingClientRect().width;
        const pres = [...document.querySelectorAll('.ticket .pre')].map((p) => {
          const b = p.getBoundingClientRect();
          const walk = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
          let l = Infinity;
          let r = -Infinity;
          while (walk.nextNode()) {
            if (!walk.currentNode.textContent?.trim()) continue;
            const range = document.createRange();
            range.selectNodeContents(walk.currentNode);
            for (const x of range.getClientRects()) { l = Math.min(l, x.left); r = Math.max(r, x.right); }
          }
          return { text: (p.textContent ?? '').trim(), inset: Math.min(l - b.left, b.right - r) };
        });
        return { ticket, pres };
      });
      width[w] = m.ticket;
      // 8 px from the outer edge: clear of the 1.5 px outline and the pill's rounded end
      for (const p of m.pres) expect(p.inset, `${w} px: "${p.text}" sits inside its pill`).toBeGreaterThanOrEqual(8);
    }
    expect(width[1024]).toBeGreaterThanOrEqual(360);
    expect(width[1100]).toBeGreaterThanOrEqual(width[1024]);
    for (const w of [1600, 1920, 2560]) expect(Math.abs(width[w] - width[1280]), `ticket ${width[w]} px at ${w} vs ${width[1280]} px at 1280`).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------------------------------
// The second chart (what was bought and sold), the "All" cap and the size table's jump sentence. The
// record is answered synthetically (production does not serve /api/orderflow until the deploy that adds
// it, and then its figures change by the hour), so each state is exercised whatever the server does.
// ---------------------------------------------------------------------------------------------------
const H = 3_600_000;
const DAY = 24 * H;
const HISTORY_ALL_DAYS = 1200;

/** A record of what was bought and sold over `hours`, in the worker's bucket sizes. */
function flowAnswer(hours: number, asOf = Date.now()) {
  const bucketMs = hours <= 48 ? H : hours <= 24 * 14 ? 2 * H : hours <= 24 * 45 ? 6 * H : DAY;
  const n = Math.min(120, Math.floor((hours * H) / bucketMs));
  const start = Math.floor((asOf - n * bucketMs) / bucketMs) * bucketMs;
  let cvd = 0;
  const buckets = [];
  for (let i = 0; i < n; i++) {
    const buyNam = 800 + ((i * 137) % 2500);
    const sellNam = 600 + ((i * 251) % 3100);
    cvd += buyNam - sellNam;
    buckets.push({ ts: start + i * bucketMs, buyNam, sellNam, netDeltaNam: buyNam - sellNam, cvdNam: cvd, vwapUsd: 0.0011, trades: 3 });
  }
  const totalBuy = buckets.reduce((a, b) => a + b.buyNam, 0);
  const totalSell = buckets.reduce((a, b) => a + b.sellNam, 0);
  return { asOf, hours, bucketMs, buckets, netCvdNam: cvd, grossVolumeNam: totalBuy + totalSell, buySharePct: (totalBuy / (totalBuy + totalSell)) * 100, priceChangePct: 1.2, absorptionRegime: 'balanced', prov: { source: 'D1 flow index', at: asOf - 20_000, status: 'live' } };
}
const hoursOf = (url: string) => Number(new URL(url).searchParams.get('hours') || 720);
const SHOW = 'Show what was bought and sold';
const HIDE = 'Hide what was bought and sold';

test.describe('what was bought and sold, the cap and the jump', () => {
  test.beforeEach(({}, info) => test.skip(onlyIn(info.project.name), 'viewport-independent: runs in 375x812'));

  test('closed by default and nothing fetched for it; a server without the record says so as missing, never as a fault', async ({ page }) => {
    // production before the deploy that adds the endpoint answers 404: pinned here so the case holds after it too
    await page.route(/\/api\/orderflow/, (r) => r.fulfill({ status: 404, body: 'not found' }));
    const reqs = trackRequests(page);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await gotoRoute(page, '/trade');
    const chart = page.locator('.tk-chart');
    await expect(chart.locator('#h-chart')).toBeVisible({ timeout: 30_000 });
    // no toggle row above the price chart, and no request for the record while it is closed
    await expect(chart.locator('.tk-chart__mode')).toHaveCount(0);
    await expect(chart.locator('.tk-flow')).toHaveCount(0);
    expect(apiUrls(reqs, new URL(page.url()).origin).filter((u) => u.pathname === '/api/orderflow')).toEqual([]);
    await chart.getByRole('button', { name: SHOW }).click();
    const flow = chart.locator('.tk-flow');
    await expect(flow.locator('#h-flow')).toHaveText('What was bought and sold');
    // missing with its reason: the em dash, the plain sentence, a stamp reading "no data"; no warning, no Try again
    await expect(flow.locator('[data-num]')).toHaveText('—');
    await expect(flow).toContainText('This server does not keep an hour-by-hour record of what was bought and sold yet');
    await expect(flow.locator('[data-prov]')).toContainText('no data');
    await expect(flow.locator('.notice')).toHaveCount(0);
    await expect(flow.getByRole('button', { name: 'Try again' })).toHaveCount(0);
    await expect(flow).not.toContainText('did not load');
    await expect(flow).not.toContainText('error');
    expect(apiUrls(reqs, new URL(page.url()).origin).filter((u) => u.pathname === '/api/orderflow')).toHaveLength(1);
    // the words on the screen's own controls carry no jargon
    for (const sel of ['.tk-more', '.tk-chartmiss']) for (const word of ['Orderflow', 'CVD', 'orderflow']) await expect(chart.locator(sel)).not.toContainText(word);
    await chart.getByRole('button', { name: HIDE }).click();
    await expect(chart.locator('.tk-flow')).toHaveCount(0);
    expect(errors.filter((e) => /orderflow/.test(e))).toEqual([]);
  });

  test('with the record served: the chart, its own range, a SourceLine, and requests only while it is shown', async ({ page }) => {
    await page.clock.install();
    await page.route(/\/api\/orderflow/, (r) => r.fulfill({ json: flowAnswer(hoursOf(r.request().url())) }));
    const reqs = trackRequests(page);
    await gotoRoute(page, '/trade');
    const chart = page.locator('.tk-chart');
    await expect(chart.locator('#h-chart')).toBeVisible({ timeout: 30_000 });
    await chart.getByRole('button', { name: SHOW }).click();
    const flow = chart.locator('.tk-flow');
    await expect(flow.locator('#h-flow')).toBeVisible();
    await expect(flow.locator('.chartsec .srcb')).toBeVisible();
    await expect(flow.locator('.chartsec .srcb')).toHaveAttribute('data-status', 'fresh');
    const flowReqs = () => apiUrls(reqs, new URL(page.url()).origin).filter((u) => u.pathname === '/api/orderflow');
    expect(flowReqs().map(hoursOf)).toEqual([720]);
    // its own range: the price chart stays on 30d while the record goes to 90d
    await flow.getByRole('radio', { name: '90d' }).click();
    await expect.poll(() => flowReqs().map(hoursOf)).toEqual([720, 2160]);
    await expect(chart.locator('.chartsec').first().getByRole('radio', { name: '30d' })).toBeChecked();
    // refreshed every 2 min while shown, not once hidden
    await page.clock.runFor(125_000);
    await expect.poll(() => flowReqs().length).toBe(3);
    await chart.getByRole('button', { name: HIDE }).click();
    await page.clock.runFor(250_000);
    expect(flowReqs().length).toBe(3);
    // the audit holds with the second chart open
    await chart.getByRole('button', { name: SHOW }).click();
    await expect(flow.locator('#h-flow')).toBeVisible();
    const a = await layoutAudit(page, '.tk-chart');
    expect(a.overflowX).toBe(false);
    expect(a.smallText).toEqual([]);
    expect(a.smallTargets).toEqual([]);
  });

  test('a failed fetch of the record says so with Try again; a failed refresh keeps the chart, marked old', async ({ page }) => {
    await page.clock.install();
    let mode: 'down' | 'up' = 'down';
    await page.route(/\/api\/orderflow/, (r) => (mode === 'down' ? r.fulfill({ status: 503, body: 'unavailable' }) : r.fulfill({ json: flowAnswer(hoursOf(r.request().url())) })));
    await gotoRoute(page, '/trade');
    const chart = page.locator('.tk-chart');
    await expect(chart.locator('#h-chart')).toBeVisible({ timeout: 30_000 });
    await chart.getByRole('button', { name: SHOW }).click();
    const flow = chart.locator('.tk-flow');
    await expect(flow.locator('#h-flow')).toHaveText('The record of what was bought and sold did not load');
    await expect(flow).toContainText('The server answered with an error.');
    await expect(flow.locator('[aria-busy="true"]')).toHaveCount(0);
    mode = 'up';
    await flow.getByRole('button', { name: 'Try again' }).click();
    await expect(flow.locator('.chartsec')).toBeVisible();
    const heading = await flow.locator('#h-flow').innerText();
    mode = 'down';
    await page.clock.runFor(125_000);
    await expect(flow.locator('.scope__old')).toContainText('The latest refresh of the record of what was bought and sold did not answer, so this is the record fetched at');
    await expect(flow.locator('.chartsec')).toBeVisible();
    await expect(flow.locator('#h-flow')).toHaveText(heading);
    await expect(flow.locator('.chartsec .srcb')).toHaveAttribute('data-status', /old|none/);
  });

  test('"All" is a cap: the price chart says so only when the history runs into it', async ({ page }) => {
    const now = Date.now();
    await page.route(/\/api\/metrics\/history/, (r) => {
      const u = new URL(r.request().url());
      const hours = Number(u.searchParams.get('hours'));
      const from = now - hours * H;
      const step = hours > 400 * 24 ? DAY : 6 * H;
      const history = [];
      for (let t = from + step / 2; t <= now; t += step) history.push({ ts: t, value: 0.001 + ((t / step) % 9) * 0.00001 });
      return r.fulfill({ json: { history, bucketMs: step } });
    });
    await gotoRoute(page, '/trade');
    const chart = page.locator('.tk-chart .chartsec').first();
    await expect(chart.locator('#h-chart')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.tk-chart .tk-cap')).toHaveCount(0);
    await chart.getByRole('radio', { name: 'All' }).click();
    const cap = page.locator('.tk-chart .tk-cap');
    await expect(cap).toBeVisible({ timeout: 30_000 });
    await expect(cap).toContainText(`“All” reaches back ${HISTORY_ALL_DAYS.toLocaleString('en-US')} days`);
    await expect(cap).toContainText('older than that are not drawn');
    // a record that begins later than the cap shows all of itself: no cap sentence
    await chart.getByRole('radio', { name: '90d' }).click();
    await expect(cap).toHaveCount(0);
  });

  test('the size table marks where selling costs much more per NAM: one sentence from the rows, never the server\'s prose', async ({ page }) => {
    const now = Date.now();
    const marg = [0.48, 1.79, 4.3, 9.3, 14.1, 23];
    const curve = {
      ...SNAP.curve,
      liquidityCliffNam: 5000,
      cliffNote: 'Concentrated Liquidity cliff above 5,000 NAM: marginal sell slippage jumps 2.4x (1.79% → 4.30%) on the 5,000–10,000 NAM slice.',
      curve: SNAP.curve.curve.map((p: { amountNam: number }, i: number) => ({ ...p, marginalSellImpactPct: marg[i] })),
      prov: { ...SNAP.curve.prov, at: now - 2000 },
    };
    await page.route(/\/api\/quote\/curve/, (r) => r.fulfill({ json: curve }));
    await page.route(/\/api\/quote\?/, (r) => r.fulfill({ json: { quote: null, error: DOWN, code: 'unavailable' } }));
    await gotoRoute(page, '/trade');
    const jump = page.locator('.tk-jump');
    await expect(jump).toContainText(/Above 5,000\sNAM, each extra NAM sold gets a much lower price: selling the slice from 5,000 to 10,000\sNAM on its own moves the price 4\.30%, against 1\.79% for the slice from 1,000 to 5,000\sNAM just below it\./, { timeout: 30_000 });
    await expect(page.locator('.ladder')).not.toContainText('Concentrated Liquidity');
    await expect(page.locator('.ladder')).not.toContainText('slippage');
    // every figure in the sentence is a stamped number inside the block's scope, which lists it
    expect(await jump.locator('[data-num]').count()).toBeGreaterThanOrEqual(6);
    await expect(page.locator('.ladder .srcb')).toHaveAttribute('data-scope', /Where selling starts to cost much more per NAM/);
  });

  test('a marked size whose slice moves cannot be worked out says the mark and the reason, never "—, against —"', async ({ page }) => {
    const now = Date.now();
    const curve = { ...SNAP.curve, liquidityCliffNam: 5000, spotUsd: null, prov: { ...SNAP.curve.prov, at: now - 2000 } };
    await page.route(/\/api\/quote\/curve/, (r) => r.fulfill({ json: curve }));
    await page.route(/\/api\/quote\?/, (r) => r.fulfill({ json: { quote: null, error: DOWN, code: 'unavailable' } }));
    await gotoRoute(page, '/trade');
    const jump = page.locator('.tk-jump');
    await expect(jump).toContainText(/Above 5,000\sNAM the server marks a size where selling starts to cost much more per NAM; — the price move of each slice is not known/, { timeout: 30_000 });
    await expect(jump).not.toContainText('against');
    await expect(page.locator('.ladder .srcb')).toHaveAttribute('data-scope', /Where selling starts to cost much more per NAM/);
  });

  test('without a marked size (the snapshot, an older server) there is no jump sentence and nothing crashes', async ({ page }) => {
    await mockQuotes(page, 'table');
    await gotoRoute(page, '/trade');
    await expect(page.locator('.lrow')).toHaveCount(6, { timeout: 30_000 });
    await expect(page.locator('.tk-jump')).toHaveCount(0);
    await expect(page.locator('.ladder .srcb')).not.toHaveAttribute('data-scope', /cost much more/);
  });
});
