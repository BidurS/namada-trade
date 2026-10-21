// Trade (/trade), S2: system.md 9.2 and the Trade row of build-plan section 8.
// Layout checks run in every viewport of the G6 matrix with production data (read-only proxy).
// State checks run once (375x812) with the quote endpoints answered from the dated design snapshot
// (docs/design/data/snapshot.json, captured 17 Oct 2026 11:24 UTC), so the degraded, live and down
// states are each exercised whatever production is doing at the time.
import fs from 'node:fs';
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { BODY } from '../../shared/copy';
import { routeById } from '../../shared/routes';
import { REWIND_AT, VIEWPORTS, apiUrls, expect, gotoRoute, isExempt, isLiveOnly, layoutAudit, onlyIn, test, trackRequests } from './helpers';
import type {
  ExecutedVolume, PairRow, PairsResponse, PriceChange, PriceChangesResponse, Provenance, SeriesResponse, SeriesSample, SeriesStep, TradeGroup, TradeRow, TradesResponse, VolumeResponse,
} from '../../shared/types';

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

// ---------------------------------------------------------------------------------------------------
// The screener basics (screener-plan 2.1 to 2.6, 3.5, 3.9 and 4.2). Production does not serve /api/series yet,
// so each route is answered from fixtures shaped exactly like the contract types in shared/types.ts
// (SeriesResponse, PriceChangesResponse, VolumeResponse, PairsResponse, TradesResponse), including the missing
// and not-served states, where the page must say "—" and why. The fixtures' figures are the plan's measured ones.
// ---------------------------------------------------------------------------------------------------
const STEP: Record<SeriesStep, number> = { '1m': 60_000, '1h': H, '6h': 6 * H, '1d': DAY };
const fresh = (source: string, at: number): Provenance => ({ source, at, status: 'live' });
const dayStart = (s: string) => Date.parse(`${s}T00:00:00Z`);

interface SeriesOpts {
  now: number;
  /** trade hours in the last 24 h (the honest-chart case: 3 dots, 3 bars, 21 empty slots) */
  hours24?: number[];
  /** the executed series' start */
  execStart?: number;
  quotedStart?: number;
  poolStart?: number;
  /** answer 404 for these keys (a key the server does not know) */
  missingKeys?: string[];
}

/** The executed trade hours: a cluster of three adjacent hours, then scattered ones, over 30 days. */
function tradeHours(o: SeriesOpts): number[] {
  const h0 = Math.floor(o.now / H) * H;
  const last24 = o.hours24 ?? [h0 - 2 * H, h0 - 3 * H, h0 - 9 * H];
  const older: number[] = [];
  for (let i = 0; i < 60; i++) older.push(h0 - (30 + i * 11 + (i % 3)) * H);
  return [...new Set([...last24, ...older])].filter((t) => t >= (o.execStart ?? 0)).sort((a, b) => a - b);
}

function series(key: string, from: number, to: number, step: SeriesStep, o: SeriesOpts): SeriesResponse {
  const ms = STEP[step];
  const pts: SeriesSample[] = [];
  let unit: SeriesResponse['unit'] = 'usd_per_nam';
  let agg: SeriesResponse['agg'] = 'last';
  let sparse = false;
  let source = 'executed NAM/USDC swaps (hourly median)';
  let start: number | null = null;
  let backfilled = false;
  const hours = tradeHours(o);
  if (key === 'price.swap_1h') {
    sparse = true;
    start = o.execStart ?? hours[0];
    backfilled = true;
    const by = new Map<number, number>();
    for (const t of hours) if (t >= from && t < to) by.set(Math.floor(t / ms) * ms, 0.00095 + ((t / H) % 17) * 0.00002);
    for (const [t, v] of [...by].sort((a, b) => a[0] - b[0])) pts.push({ t, v, lo: v, hi: v, n: 1 });
  } else if (key === 'price.usd') {
    source = 'Osmosis SQS';
    start = o.quotedStart ?? o.now - 5.5 * DAY;
    for (let t = Math.ceil(Math.max(from, start) / ms) * ms; t < to; t += ms) {
      const v = 0.00112 + Math.sin(t / (7 * H)) * 0.00003;
      pts.push({ t, v, lo: v - 0.000012, hi: v + 0.000015, n: ms / 60_000 });
    }
  } else if (key === 'dex.swaps_1h.nam' || key === 'dex.swaps_1h.buy_nam' || key === 'dex.swaps_1h.sell_nam') {
    unit = 'nam';
    agg = 'sum';
    sparse = true;
    source = 'executed NAM swaps (hourly rows)';
    start = o.execStart ?? hours[0];
    backfilled = true;
    const by = new Map<number, number>();
    for (const t of hours) {
      if (t < from || t >= to) continue;
      const k = Math.floor(t / ms) * ms;
      const nam = key === 'dex.swaps_1h.sell_nam' ? ((t / H) % 7) % 2 === 0 ? 300 + ((t / H) % 7) * 100 : 0 : 400 + ((t / H) % 9) * 150;
      if (nam > 0) by.set(k, (by.get(k) ?? 0) + nam);
    }
    for (const [t, v] of [...by].sort((a, b) => a[0] - b[0])) pts.push({ t, v, n: 1 });
  } else if (key === 'price.pool_1h') {
    source = 'Osmosis data API';
    start = o.poolStart ?? dayStart('2025-06-20') + 19 * H;
    for (let t = Math.ceil(Math.max(from, start) / ms) * ms, i = 0; t < to; t += ms, i++) {
      const age = (o.now - t) / DAY;
      const v = 0.0011 + Math.max(0, age - 120) * 0.00009 + Math.sin(i / 9) * 0.00005;
      pts.push({ t, v, lo: v, hi: v, ...(i % 5 < 2 ? { flat: true } : {}) });
    }
  }
  const steps = Math.max(0, Math.ceil((to - Math.max(from, start ?? from)) / ms));
  const last = pts[pts.length - 1];
  return {
    key, from, to, step, stepMs: ms, agg, unit, points: pts,
    sources: [{ source, from: pts[0]?.t ?? null, to: last?.t ?? null, start, startNote: 'fixture', backfilled }],
    start, sparse, coverage: { steps, withPoint: pts.length }, gaps: [],
    prov: last ? fresh(source, last.t) : { source, at: null, status: 'missing', note: 'No reading in this range.' },
    asOf: o.now,
  };
}

const change = (window: PriceChange['window'], windowMs: number, now: number, base: number | null, cur: number, source: string, note?: string): PriceChange => ({
  window, windowMs,
  pct: base == null ? null : ((cur - base) / base) * 100,
  now: { value: cur, at: now - 30_000 },
  base: base == null ? null : { value: base, at: now - windowMs + 60_000 },
  baseLagMs: base == null ? null : 60_000,
  prov: base == null ? { source, at: null, status: 'missing', note } : fresh(source, now - 30_000),
  ...(note ? { note } : {}),
});

function changesFixture(now: number): PriceChangesResponse {
  const q = 'Osmosis SQS';
  const note = 'The quoted price has been recorded since 15 Oct 2026.';
  const p = 'Osmosis data API';
  return {
    asOf: now,
    quoted: {
      h1: change('h1', H, now, 0.0011409, 0.001144, q),
      h6: change('h6', 6 * H, now, 0.0011580, 0.001144, q),
      h24: change('h24', DAY, now, 0.0010583, 0.001144, q),
      d7: change('d7', 7 * DAY, now, null, 0.001144, q, note),
      d30: change('d30', 30 * DAY, now, null, 0.001144, q, note),
    },
    pool: {
      d7: change('d7', 7 * DAY, now, 0.0010151, 0.0011664, p),
      d30: change('d30', 30 * DAY, now, 0.000802, 0.0011664, p),
      y1: change('y1', 365 * DAY, now, 0.0411, 0.0011664, p),
    },
  };
}

const vol = (window: ExecutedVolume['window'], ms: number, now: number, nam: number, usd: number | null, buys: number, sells: number, buyers: number, sellers: number, buyVwap: number | null, sellVwap: number | null, hoursWithTrade: number): ExecutedVolume => ({
  window, from: now - ms, to: now, nam, buyNam: nam * 0.9, sellNam: nam * 0.1, buys, sells,
  usd, usdPriced: usd ?? nam * 0.0009, unpriced: usd == null ? 2 : 0, buyers, sellers, tradersHow: window === 'd30' ? 'distinct_per_hour_summed' : 'distinct',
  vwapUsd: buyVwap, buyVwapUsd: buyVwap, sellVwapUsd: sellVwap, hoursWithTrade, hours: Math.round(ms / H),
});

function volumeFixture(now: number, opts: { disagree?: boolean; h24?: boolean } = {}): VolumeResponse {
  return {
    asOf: now,
    definition: 'NAM bought plus NAM sold on Osmosis in the window, each trade at the price it was executed at, bot round trips left out.',
    windows: {
      h1: vol('h1', H, now, 0, 0, 0, 0, 0, 0, null, null, 0),
      h6: vol('h6', 6 * H, now, 2510, 2.9, 6, 0, 1, 0, 0.001155, null, 2),
      h24: opts.h24 === false ? null : vol('h24', DAY, now, 377960, 325, 368, 9, 4, 2, 0.000861, 0.000908, 3),
      d7: vol('d7', 7 * DAY, now, 961000, 866, 805, 44, 5, 3, 0.000894, 0.000908, 41),
      d30: vol('d30', 30 * DAY, now, 1_800_000, null, 896, 61, 22, 9, 0.000757, 0.000739, 70),
    },
    prov: fresh('D1 flow index', now - 40_000),
    start: dayStart('2026-08-11') + 12 * H,
    osmosis: { value: { usd24h: opts.disagree ? 120 : 282, usd7d: 665 }, prov: fresh('Osmosis data API', now - 12 * 60_000) },
    osmosisDefinition: 'Osmosis counts the dollars on the priced side of each pair only.',
    disagree: !!opts.disagree,
  };
}

const pair = (poolId: string, counter: string, type: string, liq: number, nam: number, fee: number, o24: number | null | 'absent', o7: number | null, trades: number | null, now: number, createdAt: number | null): PairRow => ({
  poolId, pair: `NAM/${counter}`, counterSymbol: counter, type: type as PairRow['type'],
  liquidityUsd: liq, namReserve: nam, counterReserve: liq / 2, spreadFactor: fee,
  osmosis: o24 === 'absent'
    ? { value: null, prov: { source: 'Osmosis data API', at: null, status: 'missing', note: 'Osmosis does not list this pool’s volume' } }
    : { value: { volume24hUsd: o24, volume7dUsd: o7, liquidityUsd: liq * 0.5 }, prov: fresh('Osmosis data API', now - 12 * 60_000) },
  here24h: trades == null ? { value: null, prov: { source: 'D1 flow index', at: null, status: 'missing', note: 'swap legs are not recorded yet' } } : { value: { trades, nam: trades * 900 }, prov: fresh('D1 flow index', now - 40_000) },
  createdAt,
});

function pairsFixture(now: number, opts: { legs?: boolean } = {}): PairsResponse {
  const legs = opts.legs !== false;
  const pairs = [
    pair('3005', 'USDC', 'concentrated', 901, 606005, 0.002, 188, 439, legs ? 321 : null, now, dayStart('2025-06-21')),
    pair('3008', 'USDC', 'cosmwasm', 738, 603698, 0, 'absent', null, legs ? 0 : null, now, null),
    pair('3368', 'OSMO', 'concentrated', 170, 72969, 0.025, 61, 140, legs ? 56 : null, now, dayStart('2025-07-02')),
    pair('3020', 'ibc/0FA9232B262B89E77D1335D54FB1E1F506A92A7E4B51524B400DC69C68D28372', 'concentrated', 67, 35119, 0.01, 9, 30, legs ? 0 : null, now, null),
    pair('3402', 'OSMO', 'balancer', 3, 1500, 0.003, 0, 0, legs ? 0 : null, now, null),
    pair('3403', 'ATOM', 'balancer', 2, 1200, 0.003, null, null, legs ? 0 : null, now, null),
  ];
  return {
    asOf: now, pairs,
    prov: fresh('Osmosis SQS pools', now - 20_000),
    osmosisProv: fresh('Osmosis data API', now - 12 * 60_000),
    osmosisTotals: { volume24hUsd: 282, volume7dUsd: 665, liquidityUsd: 984 },
  };
}

const MAKER_A = 'osmo1vkyae7xq3l5c6u5c7mhm2g4r9tmd4x7ad5mlrl4';
const MAKER_B = 'osmo1f56eqgwm6zz73plfvwhamquugjr2ewnusveral';
const MAKER_C = 'osmo1sqdwxh2tlvpmsh7rapjmtmyeg4pn4hu494v9mf';

const row = (i: number, ts: number, kind: 'buy' | 'sell', nam: number, maker: string, price: number | null, extra: Partial<TradeRow> = {}): TradeRow => ({
  id: `osmosis:FIX${String(i).padStart(4, '0')}:swap`, ts, height: 72_880_000 - i, tsSource: 'block', kind, nam,
  counterSymbol: 'USDC', counterAmount: price == null ? null : nam * price,
  priceUsd: price, priceSource: price == null ? null : 'execution', valueUsd: price == null ? null : nam * price,
  ...(price == null ? { priceNote: 'No price was recorded for this trade.' } : {}),
  maker, makerLabelPlain: null, makerLabelSource: null, makerLabelAuthor: null,
  makerTrades: maker === MAKER_A ? { buys: 559, sells: 0 } : maker === MAKER_B ? { buys: 98, sells: 101 } : { buys: 3, sells: 1 },
  route: ['3368', '3005'], txHash: `FIX${String(i).padStart(4, '0')}`, pattern: null, ...extra,
});

/** Groups by the contract's rule: consecutive rows, one maker, one side, each within foldMs of the next. */
function foldFixture(rows: TradeRow[], foldMs: number): TradeGroup[] {
  const out: TradeRow[][] = [];
  for (const r of rows) {
    const g = out[out.length - 1];
    const prev = g?.[g.length - 1];
    if (g && prev && prev.maker === r.maker && prev.kind === r.kind && prev.ts - r.ts <= foldMs) g.push(r);
    else out.push([r]);
  }
  return out.map((g) => {
    const priced = g.filter((r) => r.valueUsd != null);
    const usd = priced.reduce((a, r) => a + (r.valueUsd ?? 0), 0);
    const pnam = priced.reduce((a, r) => a + r.nam, 0);
    return {
      maker: g[0].maker, kind: g[0].kind, ids: g.map((r) => r.id), n: g.length, nam: g.reduce((a, r) => a + r.nam, 0),
      usd: priced.length ? usd : null, unpriced: g.length - priced.length, avgPriceUsd: priced.length ? usd / pnam : null,
      firstTs: Math.min(...g.map((r) => r.ts)), lastTs: Math.max(...g.map((r) => r.ts)), pattern: g.find((r) => r.pattern)?.pattern ?? null,
    };
  });
}

function tradesFixture(now: number, opts: { maker?: string | null } = {}): TradesResponse {
  const rows: TradeRow[] = [];
  let t = now - 3 * 60_000;
  let i = 0;
  // twelve buys by one address, each a few minutes apart: one folded row, with the pattern tag
  for (let k = 0; k < 12; k++, t -= 4 * 60_000) rows.push(row(i++, t, 'buy', 300 + k * 10, MAKER_A, 0.00116 + k * 0.000001, { pattern: 'repeated_small_buys' }));
  t -= 20 * 60_000;
  rows.push(row(i++, t, 'sell', 2991, MAKER_B, 0.0011473));
  t -= 35 * 60_000;
  rows.push(row(i++, t, 'buy', 417, MAKER_C, null, { route: ['3368', '3005', '3015'], counterSymbol: 'OSMO' }));
  t -= 90 * 60_000;
  rows.push(row(i++, t, 'buy', 5120, MAKER_B, 0.00109));
  const shown = opts.maker ? rows.filter((r) => r.maker === opts.maker) : rows;
  return {
    rows: shown, groups: foldFixture(shown, 600_000), next: null, asOf: now, foldMs: 600_000,
    patternRule: { minBuys: 20, underNam: 2000, windowMs: DAY }, prov: fresh('D1 flow index', now - 40_000), firstTs: dayStart('2026-08-11') + 12 * H,
  };
}

/**
 * Answer every /api/series route from the fixtures. The live stream is silenced and its seed (the newest moves at
 * page load) is empty, so a real trade arriving during a test never changes the tape's rows; a test that wants a
 * streamed trade answers the seed itself (routes added later win).
 */
async function mockSeries(page: Page, o: SeriesOpts & { volume?: Parameters<typeof volumeFixture>[1]; pairs?: Parameters<typeof pairsFixture>[1] }) {
  await page.routeWebSocket('**/ws', () => {});
  await page.route(/\/api\/flows\?limit=30(&count=none)?$/, (r) => r.fulfill({ json: { total: 0, page: 1, limit: 30, flows: [] } }));
  await page.route(/\/api\/series\?/, (r) => {
    const u = new URL(r.request().url());
    const key = u.searchParams.get('key') ?? '';
    if (o.missingKeys?.includes(key)) return r.fulfill({ status: 404, json: { error: 'This figure is not served yet.', reason: 'Unknown key.', endpoint: '/api/series' } });
    const step = (u.searchParams.get('step') ?? '1h') as SeriesStep;
    const fromS = u.searchParams.get('from');
    const at = Number(u.searchParams.get('at')) || o.now;
    const from = fromS ? (/^\d+$/.test(fromS) ? Number(fromS) : dayStart(fromS)) : at - 30 * DAY;
    return r.fulfill({ json: series(key, from, at, step, o) });
  });
  await page.route(/\/api\/series\/changes/, (r) => r.fulfill({ json: changesFixture(o.now) }));
  await page.route(/\/api\/series\/volume/, (r) => r.fulfill({ json: volumeFixture(o.now, o.volume) }));
  await page.route(/\/api\/series\/pairs/, (r) => r.fulfill({ json: pairsFixture(o.now, o.pairs) }));
  await page.route(/\/api\/series\/trades/, (r) => {
    const u = new URL(r.request().url());
    return r.fulfill({ json: tradesFixture(o.now, { maker: u.searchParams.get('maker') }) });
  });
}

const NOT_SERVED = 'This figure is not served yet.';
/** Every /api/series route answers 501, as a server with the routes mounted but not built does (worker/src/api-series.ts). */
async function mockSeriesNotBuilt(page: Page) {
  await page.route(/\/api\/series(\/|\?|$)/, (r) => r.fulfill({ status: 501, json: { error: NOT_SERVED, reason: 'Not built yet.', endpoint: new URL(r.request().url()).pathname }, headers: { 'Cache-Control': 'no-store' } }));
}

test.describe('screener basics, served (route mocks), at 375', () => {
  test.beforeEach(({}, info) => test.skip(onlyIn(info.project.name), 'viewport-independent: runs in 375x812'));

  test('the header: price with its stamp, changes with the reading each is measured from, and the windows not covered said with the reason', async ({ page }) => {
    const now = Date.now();
    await mockSeries(page, { now });
    await gotoRoute(page, '/trade');
    const head = page.locator('.tk-head');
    await expect(head.locator('#h-head')).toHaveText('Price, volume and depth');
    await expect(head.locator('.tk-price [data-prov]')).toBeVisible({ timeout: 30_000 });
    const cells = head.locator('.tk-chg__row').first().locator('.tk-chg__c');
    await expect(cells).toHaveCount(3);
    await expect(cells.nth(0)).toContainText('1 h');
    await expect(cells.nth(2)).toContainText('24 h');
    await expect(cells.nth(2).locator('[data-num]')).toHaveText('+8.10%');
    // 7 and 30 days are not covered: one sentence with the server's reason, never 0 and never a figure
    await expect(head.locator('.tk-chg__not').first()).toHaveText('Not known yet: 7 days and 30 days. The quoted price has been recorded since 15 Oct 2026.');
    // the 24 h change opens its two readings
    await cells.nth(2).click();
    await expect(cells.nth(2)).toHaveAttribute('aria-expanded', 'true');
    await expect(head.locator('.tk-chg__base')).toContainText('24 h: the quoted price went from $0.001058');
    await expect(head.locator('.tk-chg__base')).toContainText('to $0.001144');
    await expect(head.locator('.tk-chg__base')).toContainText('The first reading in the window came 1 min after it began.');
    // the pool price's changes on their own row, labelled as not trades
    await expect(head.locator('.tk-chg__k')).toHaveText('Pool price, not trades (Osmosis app data):');
    await expect(head.locator('.tk-chg__row').nth(1).locator('.tk-chg__c')).toHaveCount(3);
    await expect(head.locator('.tk-chg__row').nth(1)).toContainText('1 year');
  });

  test('the header: volume at execution with its definition one tap away, the Osmosis figure beside it, depth and the two value lines', async ({ page }) => {
    const now = Date.now();
    await mockSeries(page, { now });
    await gotoRoute(page, '/trade');
    const facts = page.locator('.tk-head .tk-facts .fact');
    await expect(facts.nth(0).locator('.fact__n [data-num]')).toHaveText('$325', { timeout: 30_000 });
    await expect(facts.nth(0)).toContainText('377,960 NAM in 368 buys and 9 sells');
    await expect(facts.nth(0)).toContainText('Osmosis counts $282');
    await expect(facts.nth(0).locator('.fact__n [data-num]')).toHaveAttribute('data-status', 'fresh');
    // the definition is the server's sentence, one tap away
    await facts.nth(0).getByRole('button', { name: 'Traded, 24 h' }).click();
    await expect(page.locator('.pop:popover-open')).toContainText('each trade at the price it was executed at, bot round trips left out.');
    await page.keyboard.press('Escape');
    await expect(facts.nth(1).locator('.fact__l')).toHaveText('Pool depth');
    await expect(facts.nth(2).locator('.fact__l')).toHaveText('All NAM at today’s price');
    await expect(facts.nth(3).locator('.fact__l')).toHaveText('Spendable NAM at today’s price');
    await facts.nth(3).getByRole('button', { name: 'Spendable NAM at today’s price' }).click();
    await expect(page.locator('.pop:popover-open')).toContainText('Staked NAM, NAM on its way out of staking, the shielded pool and public funding are left out.');
    await page.keyboard.press('Escape');
    for (const i of [1, 2, 3]) await expect(facts.nth(i).locator('.fact__n [data-num]')).toHaveText(/^\$[\d,]+$/);
    // never the phrase "market cap"
    await expect(page.locator('main')).not.toContainText(/market cap/i);
  });

  test('our 24 h volume and the Osmosis figure more than a quarter apart: both shown, both in the disagree state', async ({ page }) => {
    await mockSeries(page, { now: Date.now(), volume: { disagree: true } });
    await gotoRoute(page, '/trade');
    const fact = page.locator('.tk-head .tk-facts .fact').first();
    await expect(fact.locator('.fact__n [data-num]')).toHaveAttribute('data-status', 'disagree', { timeout: 30_000 });
    await expect(fact.locator('.fact__s [data-num][data-status="disagree"]')).toHaveText('$120');
    await expect(fact).toContainText('the two differ by more than a quarter');
  });

  test('a 24 h window the record does not cover reads "—" with the reason, never 0', async ({ page }) => {
    await mockSeries(page, { now: Date.now(), volume: { h24: false } });
    await gotoRoute(page, '/trade');
    const fact = page.locator('.tk-head .tk-facts .fact').first();
    await expect(fact.locator('.fact__n [data-num]')).toHaveText('—', { timeout: 30_000 });
    await expect(fact).toContainText('The trades are recorded hour by hour since 11 Aug 2026, which does not cover the last 24 hours yet.');
    await expect(fact.locator('.fact__n')).not.toContainText('$0');
  });

  test('24h with 3 trade hours: 3 dots, 2 of them joined, 3 bars and 21 empty slots, the band, and the start dates under the chart', async ({ page }) => {
    const now = Date.now();
    await mockSeries(page, { now, execStart: Date.parse('2026-08-11T12:00:00Z') });
    await gotoRoute(page, '/trade');
    const chart = page.locator('.tk-chart .chartsec').first();
    await expect(chart.locator('#h-chart')).toBeVisible({ timeout: 30_000 });
    await chart.getByRole('radio', { name: '24h' }).click();
    const box = chart.locator('.chart-box');
    await expect(box).toHaveAttribute('data-exec', '3');
    await expect(box).toHaveAttribute('data-joined', '1');
    await expect(box.locator('circle.c-exec-dot')).toHaveCount(3);
    await expect(box.locator('g.c-bars')).toHaveAttribute('data-bars', '3');
    await expect(box.locator('g.c-bars')).toHaveAttribute('data-empty', '21');
    await expect(box.locator('rect.c-bar')).toHaveCount(3);
    await expect(box.locator('rect.c-slot')).toHaveCount(21);
    await expect(box.locator('path.c-band').first()).toBeVisible();
    // the sparse sentence reads its counts from the data
    await expect(chart.locator(':scope > .cap').first()).toContainText(/only 3 of the 24 hours since \d+ \w+ had one/);
    await expect(chart.locator('.key')).toContainText('Bars under the chart: NAM traded in each hour; an empty slot is an hour without a trade');
    await expect(chart.locator('.key')).toContainText('Shaded: the lowest and highest quote in each hour');
    await expect(chart.locator('.c-starts')).toHaveText(/^Recorded since: executed price 11 Aug 2026 \(filled in once from stored trades\); quoted price \d+ Oct 2026; NAM traded per hour 11 Aug 2026 \(filled in once from stored trades\)\. Nothing is drawn before a series begins\.$/);
    // the scope lists the bars; the readout says what traded in the hour it reads
    await expect(chart.locator('.srcb')).toHaveAttribute('data-scope', /NAM traded per hour/);
    await box.focus();
    await page.keyboard.press('End');
    await expect(chart.locator('.readout')).toContainText('NAM traded that hour');
  });

  test('90d draws the pool price, not trades, with its flat hours marked; the quoted line only from its own start', async ({ page }) => {
    const now = Date.now();
    const quotedStart = now - 5.5 * DAY;
    await mockSeries(page, { now, quotedStart });
    const reqs = trackRequests(page);
    await gotoRoute(page, '/trade');
    const chart = page.locator('.tk-chart .chartsec').first();
    await expect(chart.locator('#h-chart')).toBeVisible({ timeout: 30_000 });
    await chart.getByRole('radio', { name: '90d' }).click();
    const box = chart.locator('.chart-box');
    await expect(box).not.toHaveAttribute('data-pool', '0');
    await expect(box.locator('path.c-pool').first()).toBeVisible();
    await expect(box.locator('line.c-flat').first()).toBeAttached();
    await expect(box.locator('g.c-bars')).toHaveCount(0);
    await expect(chart.locator('.key')).toContainText('Pool price, not trades (Osmosis app data)');
    await expect(chart.locator('.key')).toContainText('in which no trade moved the pool');
    await expect(chart.locator('.chartsec__title .cap')).toContainText('The thin line is the pool price, not trades: one close per hour from Osmosis app data');
    await expect(chart.locator('.srcb')).toHaveAttribute('data-scope', /Pool price \(not trades\)/);
    await expect(chart.locator('.c-starts')).toContainText('pool price 20 Jun 2025');
    // the request asked the pool series hourly from 90 days back, and nothing quoted before its start was drawn
    const pool = apiUrls(reqs, new URL(page.url()).origin).filter((u) => u.pathname === '/api/series' && u.searchParams.get('key') === 'price.pool_1h');
    expect(pool.map((u) => u.searchParams.get('step'))).toContain('1h');
    const firstQuoteX = await box.evaluate((el) => {
      const d = el.querySelector('path.c-quote')?.getAttribute('d') ?? '';
      return Number(/^M([\d.]+)/.exec(d)?.[1] ?? NaN);
    });
    const plotLeft = await box.evaluate((el) => Math.min(...[...el.querySelectorAll('line.c-grid')].map((l) => Number(l.getAttribute('x1')))));
    const width = await box.evaluate((el) => el.getBoundingClientRect().width);
    // 90 days drawn across the plot: a line from 5.5 days back starts in the last tenth
    expect(firstQuoteX).toBeGreaterThan(plotLeft + (width - plotLeft) * 0.9);
    // pressing and reading on a long range reads the pool price, said as not a trade
    await box.focus();
    await page.keyboard.press('Home');
    await expect(chart.locator('.readout')).toContainText('Pool price, not a trade');
    // 1y asks for 6-hour steps, All for days
    await chart.getByRole('radio', { name: '1y' }).click();
    await expect(chart.locator('.chartsec__title .cap')).toContainText('one close per 6 hours');
    await chart.getByRole('radio', { name: 'All' }).click();
    await expect(chart.locator('.chartsec__title .cap')).toContainText('one close per day');
  });

  test('a pool series the server does not know reads "—" with the reason on the long ranges; the chart still draws', async ({ page }) => {
    await mockSeries(page, { now: Date.now(), missingKeys: ['price.pool_1h'] });
    await gotoRoute(page, '/trade');
    const chart = page.locator('.tk-chart .chartsec').first();
    await expect(chart.locator('#h-chart')).toBeVisible({ timeout: 30_000 });
    await chart.getByRole('radio', { name: '1y' }).click();
    await expect(chart.locator('.key .key__miss')).toHaveText('— Pool price: This figure is not served yet.');
    await expect(chart.locator('.chart-box')).toHaveAttribute('data-pool', '0');
    await expect(chart.locator('circle.c-exec-dot').first()).toBeAttached();
  });

  test('pairs: two volume sources with their own stamps, our own trade count, "—" with the reason where Osmosis does not list a pool', async ({ page }) => {
    await mockSeries(page, { now: Date.now() });
    await gotoRoute(page, '/trade');
    const pools = page.locator('.pools');
    await expect(pools.locator('.pa__row[data-pool]')).toHaveCount(4, { timeout: 30_000 });
    await expect(pools.locator('.pa__row--rest')).toContainText('2 more pools');
    const p3005 = pools.locator('.pa__row[data-pool="3005"]');
    await expect(p3005).toContainText('NAM / USDC');
    await expect(p3005).toContainText('since 21 Jun 2025');
    await expect(p3005.locator('.pa__o24 [data-num]')).toHaveText('$188');
    await expect(p3005.locator('.pa__o7 [data-num]')).toHaveText('$439');
    await expect(p3005.locator('.pa__here [data-num]')).toHaveText('321');
    const p3008 = pools.locator('.pa__row[data-pool="3008"]');
    await expect(p3008.locator('.pa__o24 [data-num]')).toHaveText('—');
    await expect(p3008.locator('.pa__o24')).toContainText('Osmosis does not list this pool’s volume');
    const lead = pools.locator('.tk-osmo').first();
    await expect(lead).toContainText('In the last 24 hours Osmosis counts $282');
    await expect(lead).toContainText('traded across these pools, the priced side only; this site recorded 377');
    // each volume source carries its own stamp in view: the pair summary's update time, the flow index's
    await expect(lead.locator('[data-prov]')).toHaveCount(2);
    await expect(lead.locator('[data-prov]').first()).toContainText('Osmosis app data · 12 min');
    await expect(lead.locator('[data-prov]').nth(1)).toContainText('Flow index');
    // the list's one SourceLine names both volume sources apart
    await expect(pools.locator('.srcb')).toHaveAttribute('data-scope', /Dollars traded per pool \(Osmosis pair summary\)\|Trades recorded here per pool/);
  });

  test('pairs before swap legs are recorded: the trades-here column says why once, not in every row', async ({ page }) => {
    await mockSeries(page, { now: Date.now(), pairs: { legs: false } });
    await gotoRoute(page, '/trade');
    const pools = page.locator('.pools');
    await expect(pools.locator('.pa-notes')).toHaveText('— Trades here per pool: swap legs are not recorded yet', { timeout: 30_000 });
    await expect(pools.locator('.pa__here .num__x--why')).toHaveCount(0);
    await expect(pools.locator('.pa__here [data-num]').first()).toHaveText('—');
  });

  test('the tape: a run folded into one row with the pattern tag, its trades behind a disclosure, a trade without a price, and one maker on request', async ({ page }) => {
    const now = Date.now();
    await mockSeries(page, { now });
    const reqs = trackRequests(page);
    await gotoRoute(page, '/trade');
    const tape = page.locator('.tk-tape');
    const rows = tape.locator('.tr');
    await expect(rows).toHaveCount(4, { timeout: 30_000 });
    const run = rows.first();
    await expect(run).toHaveAttribute('data-n', '12');
    await expect(run.locator('.tr__fold')).toContainText('12 buys of about 355 NAM by the same address');
    await expect(run.locator('.tag--cat')).toHaveText('Repeated small buys');
    await expect(run.locator('.tr__nam [data-num]')).toHaveText('+4,260');
    await expect(tape.locator('.tk-rule')).toContainText('marks an address with at least 20 buys of under 2,000 NAM each within 24 hours. It describes a pattern in the record, not why the trades were made.');
    // the run's trades behind a disclosure, with the maker's record and the filter
    await run.locator('.tr__tog').click();
    await expect(run.locator('.tr__one')).toHaveCount(12);
    await expect(run.locator('.tr__counts')).toContainText('559 buys and 0 sells');
    // a trade without a price: "—" with the reason, never a pool price standing in
    const unpriced = rows.nth(2);
    await expect(unpriced.locator('.tr__val [data-num]')).toHaveText('—');
    await expect(unpriced.locator('.tr__val')).toContainText('No price was recorded for this trade.');
    // a sell carries the true minus
    await expect(rows.nth(1).locator('.tr__nam [data-num]')).toHaveText('−2,991');
    // one maker only
    await run.getByRole('button', { name: 'Only this address’s trades' }).click();
    await expect.poll(() => apiUrls(reqs, new URL(page.url()).origin).some((u) => u.pathname === '/api/series/trades' && u.searchParams.get('maker') === MAKER_A)).toBe(true);
    await expect(tape.locator('.tk-maker')).toContainText('Only trades by');
    await expect(tape.locator('.tr')).toHaveCount(1);
    await tape.getByRole('button', { name: 'Show every address' }).click();
    await expect(tape.locator('.tr')).toHaveCount(4);
    // the maker opens the Address sheet
    await rows.nth(1).locator('.tr__who .xaddr').click();
    await expect(page).toHaveURL(new RegExp(`addr=${MAKER_B}`));
    await expect(tape.locator('a', { hasText: 'All trades on the Activity tab' })).toHaveAttribute('href', '/activity?what=dex&bots=off');
  });

  test('the tape puts a trade from the live stream on top of the recorded page', async ({ page }) => {
    const now = Date.now();
    await mockSeries(page, { now });
    const live = { id: 'osmosis:LIVE0001:swap', chain: 'osmosis', height: 72_890_001, ts: now - 30_000, txHash: 'LIVE0001', kind: 'buy', from: null, to: MAKER_C, amount: 1179, counterDenom: 'USDC', counterAmount: 1.37, poolId: '3005', priceUsd: 0.0011619, valueUsd: 1.37, meta: { trader: MAKER_C, priceSource: 'execution' } };
    await page.route(/\/api\/flows\?limit=30(&count=none)?$/, (r) => r.fulfill({ json: { total: 1, page: 1, limit: 30, flows: [live] } }));
    await gotoRoute(page, '/trade');
    const rows = page.locator('.tk-tape .tr');
    await expect(rows).toHaveCount(5, { timeout: 30_000 });
    await expect(rows.first().locator('.tr__nam [data-num]')).toHaveText('+1,179');
    await expect(rows.first().locator('.tr__val')).toContainText('$1.37');
    await expect(page.locator('.tk-tape .srcb')).toHaveAttribute('data-scope', /Trades from the live stream/);
  });

  test('a server with the routes mounted but not built (501): every new figure reads "—" with the reason, never an error, never a Try again', async ({ page }) => {
    await mockSeriesNotBuilt(page);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await gotoRoute(page, '/trade');
    const head = page.locator('.tk-head');
    await expect(head.locator('.tk-chg__none')).toContainText(`Changes over 1 h, 6 h, 24 h, 7 days and 30 days: — ${NOT_SERVED}`, { timeout: 30_000 });
    await expect(head.locator('.tk-facts .fact').first()).toContainText(NOT_SERVED);
    // the chart falls back to the older history and says which figures are missing
    const chart = page.locator('.tk-chart .chartsec').first();
    await expect(chart.locator('#h-chart')).toBeVisible({ timeout: 30_000 });
    await expect(chart.locator('.key')).toContainText(`NAM traded per hour: ${NOT_SERVED}`);
    await expect(chart.locator('.c-starts')).toContainText('executed price and quoted price: — this server does not say when they begin yet');
    await expect(page.locator('.tk-buyers')).toContainText(NOT_SERVED);
    await expect(page.locator('.pools .tk-pairsmiss')).toContainText(`Dollars traded per pool: — ${NOT_SERVED}`);
    await expect(page.locator('.tk-tape .tk-tape__note')).toContainText(NOT_SERVED);
    for (const sel of ['.tk-head', '.tk-buyers', '.tk-tape']) {
      await expect(page.locator(sel).getByRole('button', { name: /Try again|Ask again/ })).toHaveCount(0);
      await expect(page.locator(sel)).not.toContainText(/did not load|error/i);
    }
    expect(errors).toEqual([]);
  });

  test('rewound: every series request carries at, and the live-only pairs list is not asked for', async ({ page }) => {
    await mockSeries(page, { now: REWIND_AT });
    const reqs = trackRequests(page);
    await gotoRoute(page, `/trade?at=${REWIND_AT}`);
    await expect(page.locator('.tk-tape .tr').first()).toBeVisible({ timeout: 30_000 });
    await page.waitForLoadState('networkidle');
    const urls = apiUrls(reqs, new URL(page.url()).origin).filter((u) => u.pathname.startsWith('/api/series'));
    expect(urls.length).toBeGreaterThanOrEqual(5);
    expect(urls.filter((u) => u.pathname === '/api/series/pairs').map(String)).toEqual([]);
    expect(urls.filter((u) => u.searchParams.get('at') !== String(REWIND_AT)).map(String)).toEqual([]);
    await expect(page.locator('.tk-head .tk-price__k')).toContainText('then');
    // the link to the whole record keeps the rewound time
    await expect(page.locator('.tk-tape a', { hasText: 'All trades on the Activity tab' })).toHaveAttribute('href', `/activity?what=dex&bots=off&at=${REWIND_AT}`);
  });
});

/** The banned words of system.md 5.4 (scripts/copy-lint.ts) and the expert words the Trade panels must not print. */
const BANNED_WORDS = [/\bSQS\b/, /\bIBC\b/, /\bDEX\b/, /\bPoS\b/, /\bMASP\b/, /\bABCI\b/, /\bRPC\b/, /\bcron\b/i, /\bwebhooks?\b/i, /\bD[1-7]\b/, /\bVWAP\b/, /\bFDV\b/, /market cap/i, /\bcandles?\b/i, /\bbucket/i, /\bOHLC\b/, /\bliquidity\b/i];

test.describe('screener basics, empty answers (route mocks), at 375', () => {
  test.beforeEach(({}, info) => test.skip(onlyIn(info.project.name), 'viewport-independent: runs in 375x812'));

  test('a record with nothing in it says so: no trade yet, no window covered, no change known; never 0, never a stand-in', async ({ page }) => {
    const now = Date.now();
    await mockSeries(page, { now });
    const nul = (w: PriceChange['window'], ms: number): PriceChange => ({ window: w, windowMs: ms, pct: null, now: null, base: null, baseLagMs: null, prov: { source: 'Osmosis SQS', at: null, status: 'missing', note: 'No quoted price is recorded yet.' }, note: 'No quoted price is recorded yet.' });
    await page.route(/\/api\/series\/changes/, (r) => r.fulfill({ json: { asOf: now, quoted: { h1: nul('h1', H), h6: nul('h6', 6 * H), h24: nul('h24', DAY), d7: nul('d7', 7 * DAY), d30: nul('d30', 30 * DAY) }, pool: { d7: nul('d7', 7 * DAY), d30: nul('d30', 30 * DAY), y1: nul('y1', 365 * DAY) } } satisfies PriceChangesResponse }));
    await page.route(/\/api\/series\/volume/, (r) => r.fulfill({ json: { ...volumeFixture(now), windows: { h1: null, h6: null, h24: null, d7: null, d30: null }, start: null } satisfies VolumeResponse }));
    await page.route(/\/api\/series\/trades/, (r) => r.fulfill({ json: { ...tradesFixture(now), rows: [], groups: [], firstTs: null } satisfies TradesResponse }));
    // nothing from the live stream's seed either (otherwise its trades would be the tape, as they should)
    await page.route(/\/api\/flows\?limit=30(&count=none)?$/, (r) => r.fulfill({ json: { total: 0, page: 1, limit: 30, flows: [] } }));
    await gotoRoute(page, '/trade');
    const head = page.locator('.tk-head');
    await expect(head.locator('.tk-chg__not').first()).toHaveText('Not known yet: 1 h, 6 h, 24 h, 7 days and 30 days. No quoted price is recorded yet.', { timeout: 30_000 });
    await expect(head.locator('.tk-chg__c')).toHaveCount(0);
    const fact = head.locator('.tk-facts .fact').first();
    await expect(fact.locator('.fact__n [data-num]')).toHaveText('—');
    await expect(fact).toContainText('No trade hour is recorded yet.');
    await expect(page.locator('.tk-buyers .tk-paid__r')).toHaveCount(3);
    await expect(page.locator('.tk-buyers .tk-paid__r [data-num]').first()).toHaveText('—');
    await expect(page.locator('.tk-tape .empty')).toContainText('No trade on record yet.');
    await expect(page.locator('.tk-tape .tr')).toHaveCount(0);
    for (const sel of ['.tk-head', '.tk-buyers', '.tk-tape']) await expect(page.locator(sel)).not.toContainText(/\$0(\.0+)?\b/);
  });
});

test.describe('screener basics, plain words and sources (route mocks), at 375', () => {
  test.beforeEach(({}, info) => test.skip(onlyIn(info.project.name), 'viewport-independent: runs in 375x812'));

  test('every new figure has its own stamp or a scope whose SourceLine lists it (N1), and no banned or expert word is printed', async ({ page }) => {
    await mockSeries(page, { now: Date.now() });
    await gotoRoute(page, '/trade');
    await expect(page.locator('.tk-tape .tr').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.tk-buyers .bars')).toBeVisible();
    await page.locator('.tk-tape .tr__tog').first().click();
    await page.locator('.tk-head .tk-chg__c').nth(2).click();
    const panels = ['.tk-head', '.tk-chart', '.tk-buyers', '.pools', '.tk-tape'];
    const orphans = await page.evaluate((sels) => {
      const seen = (el: Element | null | undefined) => !!el && (el as HTMLElement).getBoundingClientRect().width > 0 && getComputedStyle(el).visibility !== 'hidden';
      const out: string[] = [];
      for (const s of sels) for (const n of document.querySelectorAll(`${s} [data-num]`)) {
        if (!seen(n) || n.closest('dialog')) continue;
        const own = [n.closest('.num'), n.closest('[data-prov-group]')].some((g) => g && [...g.querySelectorAll('[data-prov]')].some(seen));
        if (own) continue;
        let ok = false;
        for (let sc = n.closest('[data-prov-scope]'); sc && !ok; sc = sc.parentElement?.closest('[data-prov-scope]') ?? null) ok = [...sc.querySelectorAll('.srcb')].some((b) => seen(b) && !!(b as HTMLElement).dataset.scope);
        if (!ok) out.push(`${s}: ${(n.textContent ?? '').trim().slice(0, 24)}`);
      }
      return out;
    }, panels);
    expect(orphans).toEqual([]);
    const text = await page.evaluate((sels) => sels.map((s) => {
      const c = document.querySelector(s)?.cloneNode(true) as HTMLElement | undefined;
      c?.querySelectorAll('.pop, script, style').forEach((x) => x.remove());
      return c?.textContent ?? '';
    }).join('\n'), panels);
    expect(BANNED_WORDS.filter((re) => re.test(text)).map(String)).toEqual([]);
  });
});

test.describe('screener basics, accessibility (route mocks)', () => {
  test('axe AA with every new panel full and open, dark and light (375), dark (1280)', async ({ page }, info) => {
    test.skip(!['375x812', '1280x800'].includes(info.project.name), 'axe runs at 375 and 1280');
    for (const light of info.project.name === '375x812' ? [false, true] : [false]) {
      await page.addInitScript((l) => { try { localStorage.setItem('nt.theme', l ? 'light' : 'dark'); } catch { /* none */ } }, light);
      await mockSeries(page, { now: Date.now() });
      await gotoRoute(page, '/trade', { reducedMotion: true });
      await expect(page.locator('.tk-tape .tr').first()).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('.tk-buyers .bars')).toBeVisible();
      await expect(page.locator('.tk-chart .chartsec').first()).toBeVisible({ timeout: 30_000 });
      await page.locator('.tk-tape .tr__tog').first().click();
      await page.locator('.tk-head .tk-chg__c').nth(1).click();
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).disableRules(['target-size']).include('main').analyze();
      expect(r.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`), light ? 'light' : 'dark').toEqual([]);
    }
  });
});

test.describe('screener basics, served (route mocks), every viewport', () => {
  test('layout: one h1, no overflow, no <table>, 44 px targets, text at least 11 px, with every new panel full', async ({ page }) => {
    await mockSeries(page, { now: Date.now() });
    await gotoRoute(page, '/trade');
    await expect(page.locator('.tk-tape .tr').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.pools .pa__row').first()).toBeVisible();
    await expect(page.locator('.tk-head .tk-chg__c').first()).toBeVisible();
    // open a run and a change, so their lines are measured too
    await page.locator('.tk-tape .tr__tog').first().click();
    await page.locator('.tk-head .tk-chg__c').first().click();
    await expect(page.locator('h1')).toHaveCount(1);
    const a = await layoutAudit(page);
    expect(a.overflowX, `scrollWidth ${a.scrollWidth} > ${a.innerWidth}`).toBe(false);
    expect(a.tables).toBe(0);
    expect(a.smallText).toEqual([]);
    expect(a.smallTargets).toEqual([]);
    const vp = page.viewportSize()!;
    if (vp.width === VIEWPORTS[1].width) await page.screenshot({ path: test.info().outputPath('trade-served-375.png'), fullPage: true });
  });
});
