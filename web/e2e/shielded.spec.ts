// Shielded (/shielded), S4. Layout checks run in every project of the G6 matrix; the rest once.
import { BODY } from '../../shared/copy';
import { routeById } from '../../shared/routes';
import { BANNED } from '../../scripts/copy-lint';
import { REWIND_AT, animationsIn, apiUrls, expect, gotoRoute, isExempt, isLiveOnly, layoutAudit, onlyIn, test, trackRequests } from './helpers';
import type { Page } from '@playwright/test';

const ROUTE = routeById('shielded');
const SHOTS = process.env.SHIELDED_SHOTS || '';

/** Words of system.md 5.4 found in a text (the rendered half of G5, for the views the gates spec never opens). */
const banned = (text: string) => BANNED.filter((b) => b.re.test(text)).map((b) => b.word);

/**
 * The live blind-spot response with the in-and-out slices and the pairs added (a server before 2026-10-20
 * sends neither). The slice figures are test inputs built on the live `asOf`, never shown as real data.
 */
async function withSlices(page: Page) {
  await page.route('**/api/blindspot*', async (route) => {
    const res = await route.fetch();
    const j = await res.json();
    const H = 3_600_000;
    const b0 = Math.floor(j.asOf / (6 * H)) * 6 * H;
    const pulseSeries = [];
    let cum = 0;
    for (let i = 119; i >= 0; i--) {
      const inNam = i % 7 === 0 ? 120_000 : i % 3 === 0 ? 8_500 : 0;
      const outNam = i % 5 === 0 ? 60_002.83 : i % 4 === 0 ? 2_250 : 0;
      if (!inNam && !outNam) continue;
      cum += inNam - outNam;
      pulseSeries.push({ ts: b0 - i * 6 * H, inNam, outNam, netNam: inNam - outNam, cumNetNam: cum, turnstileNam: i % 5 === 0 ? 30_000 : 0, bridgeInNam: 0, bridgeOutNam: 0 });
    }
    const first = j.unshields[0];
    const passthroughs7d = first
      ? [{ inTs: first.ts - 1.2 * H, outTs: first.ts, dwellMs: 1.2 * H, inFrom: 'tnam1test', outTo: first.to, inAmount: first.amount, outAmount: first.amount, relDiff: 0, anonymitySetK: 3, confidence: 'low' }]
      : [];
    await route.fulfill({ response: res, json: { ...j, pulseSeries, passthroughs7d, turnstileNam7d: first?.amount ?? 0, stickySharePct7d: 87.3 } });
  });
}

/**
 * The live blind-spot response with the slices, the pairs and the share left out, as a server before
 * 2026-10-20 answered. Production sends them since the 2026-10-20 15:31Z deploy, so the missing state is built
 * here rather than read from whichever server answers.
 */
async function withoutSlices(page: Page) {
  await page.route('**/api/blindspot*', async (route) => {
    const res = await route.fetch();
    const j = await res.json();
    delete j.pulseSeries;
    delete j.passthroughs7d;
    delete j.stickySharePct7d;
    delete j.turnstileNam7d;
    await route.fulfill({ response: res, json: j });
  });
}

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

  test('moved in and out, older server (mocked): without the slices or the pairs it reads as "—" with the reason, nothing invented, no crash', async ({ page }) => {
    await withoutSlices(page);
    await gotoRoute(page, '/shielded');
    await ready(page);
    // the view switch is always there once the figures are; the default view is the total
    await expect(page.locator('#shd-chart-h')).toHaveText(/^Shielded NAM/);
    await page.getByRole('radio', { name: 'Moved in and out' }).check();
    const flow = page.locator('.shd-flow');
    await expect(flow.locator('#shd-flow-h')).toHaveText('Moved in and out of the shielded set');
    await expect(flow.locator('.readout [data-num][data-status="none"]')).toHaveText('—');
    await expect(flow.locator('.readout .num__x--why')).toContainText('does not yet send how much NAM moved in and out of the shielded set, so there is no chart to draw');
    // a space after the dash, one full stop, no unit line for a chart that is not drawn, no age beside "no data"
    expect(await flow.locator('.readout').innerText()).toMatch(/^— This server/);
    await expect(flow.locator('.chartsec__title .cap')).toHaveCount(0);
    await expect(flow.locator('.srcb')).not.toContainText(/\d+\s?(s|min|h)\b.*no data/);
    await expect(flow.locator('.chart-box')).toHaveCount(0);
    await expect(flow.locator('.cstats')).toHaveCount(0);
    await expect(flow.locator('.srcb')).toBeVisible();
    await expect(flow.locator('.srcb')).toContainText('no data');
    // the share of the week's moves not in a pair: its own stamp, "—" with the reason
    const pairs = page.locator('.shd-pairs');
    await expect(pairs.locator('[data-num][data-status="none"]')).toHaveText('—');
    await expect(pairs.locator('.num__x--why')).toContainText('does not send this figure');
    expect(await pairs.innerText()).not.toContain('..');
    await expect(pairs.locator('.pdot')).toBeVisible();
    await expect(page.locator('.mor__pt')).toHaveCount(0);
    expect(await unstamped(page)).toEqual([]);
    expect(banned(await page.locator('main').innerText())).toEqual([]);
    const a = await layoutAudit(page, 'main');
    expect(a.overflowX, `scrollWidth ${a.scrollWidth} > ${a.innerWidth}`).toBe(false);
    expect(a.smallText).toEqual([]);
    expect(a.smallTargets).toEqual([]);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/shielded-flow-missing-375.png`, fullPage: true });
  });

  test('moved in and out, with the slices and the pairs (mocked): one axis, 11 px ticks, a stamped readout that follows the keys, plain words', async ({ page }) => {
    await withSlices(page);
    await gotoRoute(page, '/shielded');
    await ready(page);
    await page.getByRole('radio', { name: 'Moved in and out' }).check();
    const flow = page.locator('.shd-flow');
    // the takeaway title: the figure is stamped, the words say which way the NAM went
    await expect(flow.locator('#shd-flow-h')).toHaveText(/^[\d,.]+[kM]? NAM more moved (in than out|out than in) over 30 days$/);
    await expect(flow.locator('#shd-flow-h [data-num]')).toBeVisible();
    // the plot: a container-measured SVG, bars up and down, the paired part inside the out bar, no bar buttons
    await expect(flow.locator('.chart-box svg rect.shd-flow__in').first()).toBeVisible();
    await expect(flow.locator('.chart-box svg rect.shd-flow__out').first()).toBeVisible();
    await expect(flow.locator('.chart-box svg rect.shd-flow__back').first()).toBeVisible();
    await expect(flow.locator('.chart-box button')).toHaveCount(0);
    expect(await flow.locator('.chart-box svg text.c-tick').evaluateAll((els) => els.map((e) => getComputedStyle(e).fontSize))).toEqual(expect.arrayContaining(['11px']));
    expect(await flow.locator('.chart-box svg text.c-tick').evaluateAll((els) => [...new Set(els.map((e) => getComputedStyle(e).fontSize))])).toEqual(['11px']);
    // no minimum heights: a 2,250 NAM out bar is drawn far shorter than a 60,002 NAM one
    const outs = await flow.locator('.chart-box svg rect.shd-flow__out').evaluateAll((els) => els.map((e) => Number(e.getAttribute('height'))));
    expect(Math.min(...outs)).toBeLessThan(Math.max(...outs) / 10);
    // the readout follows the arrow keys, every figure in it is covered by the chart's SourceLine
    // the latest 6 hours of the mock are still running at the live asOf: said as "so far"
    await expect(flow.locator('.readout .readout__k')).toHaveText(/^Net in the latest 6 hours/);
    await expect(flow.locator('.sr-only')).toContainText(/still running, it ends at \d\d:\d\d UTC|ended /);
    await flow.locator('.chart-box').focus();
    await page.keyboard.press('ArrowLeft');
    await expect(flow.locator('.readout .readout__k')).toHaveText('Net in these 6 hours');
    await expect(flow.locator('.readout .readout__t')).toContainText('UTC');
    await expect(flow.locator('.srcb')).toBeVisible();
    await expect(flow.locator('.srcb')).toHaveAttribute('data-scope', /every 6 hours/);
    // the strip and the key
    await expect(flow.locator('.cstats > div')).toHaveCount(4);
    await expect(flow.locator('.cstats')).toContainText('Moved in');
    await expect(flow.locator('.cstats')).toContainText('paired with a move in within 24 hours');
    await expect(flow.locator('.key')).toContainText('the same amount had gone in during the 24 hours before');
    // the window: 7d narrows the count in the subtitle
    const cap30 = await flow.locator('.cap').textContent();
    await page.getByRole('radio', { name: '7d' }).check();
    await expect(flow.locator('.cap')).not.toHaveText(cap30 ?? '');
    await expect(flow.locator('#shd-flow-h')).toContainText('over 7 days');
    // the share of the week's moves not in a pair, and the paired row, in words a holder can read
    await expect(page.locator('.shd-pairs [data-num]').first()).toHaveText('87.3%');
    await expect(page.locator('.shd-pairs')).toContainText('(1 such pair)');
    await expect(page.locator('.mor__pt .tag')).toHaveText('May pair with a move in');
    await expect(page.locator('.mor__ptx')).toContainText('the same amount went in 1.2 h earlier');
    await expect(page.locator('.mor__ptx')).toContainText('3 moves in could be the one');
    await expect(page.locator('.mor__ptx')).toContainText('a loose match');
    expect(await unstamped(page)).toEqual([]);
    expect(banned(await page.locator('main').innerText())).toEqual([]);
    const a = await layoutAudit(page, 'main');
    expect(a.overflowX, `scrollWidth ${a.scrollWidth} > ${a.innerWidth}`).toBe(false);
    expect(a.tables).toBe(0);
    expect(a.smallText).toEqual([]);
    expect(a.smallTargets).toEqual([]);
    if (SHOTS) {
      await page.getByRole('radio', { name: '30d' }).check();
      await page.screenshot({ path: `${SHOTS}/shielded-flow-375.png`, fullPage: true });
    }
  });

  test('moved in and out, an empty series (mocked): nothing drawn on a made-up scale, the strip says 0', async ({ page }) => {
    await page.route('**/api/blindspot*', async (route) => {
      const res = await route.fetch();
      const j = await res.json();
      await route.fulfill({ response: res, json: { ...j, pulseSeries: [] } });
    });
    await gotoRoute(page, '/shielded');
    await ready(page);
    await page.getByRole('radio', { name: 'Moved in and out' }).check();
    const flow = page.locator('.shd-flow');
    await expect(flow.locator('#shd-flow-h')).toHaveText('Nothing moved in or out over 30 days');
    await expect(flow.locator('.readout')).toContainText('No moves in or out in this window.');
    await expect(flow.locator('.chart-box')).toHaveCount(0);
    await expect(flow.locator('.cstats dd').first()).toHaveText(/^0NAM/);
    await expect(flow.locator('.cstats')).not.toContainText('—');
  });

  test('G7: nothing on the screen animates under reduced motion, in either view', async ({ page }) => {
    await withSlices(page);
    await gotoRoute(page, '/shielded', { reducedMotion: true });
    await ready(page);
    await page.waitForTimeout(800);
    expect(await animationsIn(page, 'main')).toBe(0);
    await page.getByRole('radio', { name: 'Moved in and out' }).check();
    await expect(page.locator('.shd-flow .chart-box svg')).toBeVisible();
    await page.waitForTimeout(800);
    expect(await animationsIn(page, 'main')).toBe(0);
  });

  test('G7: nothing on the screen animates under reduced motion', async ({ page }) => {
    await gotoRoute(page, '/shielded', { reducedMotion: true });
    await ready(page);
    await page.waitForTimeout(800);
    expect(await animationsIn(page, 'main')).toBe(0);
  });
});
