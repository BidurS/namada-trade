// Charts (the UI kit's PriceChart, OrderflowChart and OrderSizeCurve, on the Trade screen): plain words
// with the expert term only in the glossary popover, every figure inside a scope whose SourceLine is
// visible and lists it (N1), no banned word (G5), one y axis per plot (7.2), the readout by keyboard,
// and the phone layout at 375 px (no sideways scroll, text at least 11 px, targets at least 44 px).
// The record of what was bought and sold and the size table's slice figures are answered from fixtures
// (production serves neither before the deploy that adds them); the price chart runs on production data.
import fs from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, gotoRoute, layoutAudit, onlyIn, test } from './helpers';

const SNAP = JSON.parse(fs.readFileSync(new URL('../../docs/design/data/snapshot.json', import.meta.url), 'utf8'));
const H = 3_600_000;
const DOWN = 'The Osmosis quote service is not answering.';

/** The banned words of system.md 5.4 (scripts/copy-lint.ts), and the expert words these charts used to print. */
const BANNED = [/\bSQS\b/, /\bIBC\b/, /\bDEX\b/, /\bPoS\b/, /\bMASP\b/, /\bABCI\b/, /\bRPC\b/, /\bcron\b/i, /\bwebhooks?\b/i, /\bnpm\b/i, /\bD[1-7]\b/, /\bLoading(…|\.\.\.)/i];
const JARGON = [/\bCVD\b/, /\bVWAP\b/, /orderflow/i, /absorption/i, /regime/i, /aggressive/i, /marginal/i, /cliff/i, /slippage/i, /\btick\b/i, /bucket/i, /\barb\b/i, /Concentrated/];

/** The visible words and accessible names inside `sel`, minus the glossary popovers (allowlisted, like the gate). */
async function wordsIn(page: Page, sel: string): Promise<string> {
  return page.evaluate((s) => {
    const parts: string[] = [];
    for (const r of document.querySelectorAll(s)) {
      const c = r.cloneNode(true) as HTMLElement;
      c.querySelectorAll('.pop, script, style, .sr-only').forEach((x) => x.remove());
      parts.push(c.textContent ?? '');
      for (const el of c.querySelectorAll('[aria-label], [title]')) for (const a of ['aria-label', 'title']) parts.push(el.getAttribute(a) ?? '');
    }
    return parts.join('\n');
  }, sel);
}
const offending = (text: string, res: RegExp[]) => res.filter((re) => re.test(text)).map((re) => `${re}: "${text.slice(Math.max(0, text.search(re) - 30), text.search(re) + 30).replace(/\s+/g, ' ')}"`);

/** N1 inside `sel`, as gates.spec.ts checks it: every visible [data-num] has its own control or a scope with a visible SourceLine. */
async function orphansIn(page: Page, sel: string): Promise<string[]> {
  return page.evaluate((s) => {
    const seen = (el: Element | null | undefined) => !!el && (el as HTMLElement).getBoundingClientRect().width > 0 && getComputedStyle(el).visibility !== 'hidden';
    const out: string[] = [];
    for (const n of document.querySelectorAll(`${s} [data-num]`)) {
      if (!seen(n) || n.closest('dialog')) continue;
      const own = [n.closest('.num'), n.closest('[data-prov-group]')].some((g) => g && [...g.querySelectorAll('[data-prov]')].some(seen));
      if (own) continue;
      let ok = false;
      for (let sc = n.closest('[data-prov-scope]'); sc && !ok; sc = sc.parentElement?.closest('[data-prov-scope]') ?? null) {
        ok = [...sc.querySelectorAll('.srcb')].some((b) => seen(b) && !!(b as HTMLElement).dataset.scope);
      }
      if (!ok) out.push((n.textContent ?? '').trim().slice(0, 24));
    }
    return out;
  }, sel);
}

/** A record of what was bought and sold over `hours`, in the worker's bucket sizes, with gaps and an unpriced span. */
function flowAnswer(hours: number, asOf = Date.now()) {
  const bucketMs = hours <= 48 ? H : hours <= 24 * 14 ? 2 * H : hours <= 24 * 45 ? 6 * H : 24 * H;
  const n = Math.floor((hours * H) / bucketMs);
  const start = Math.floor((asOf - n * bucketMs) / bucketMs) * bucketMs;
  let cvd = 0;
  const buckets = [];
  for (let i = 0; i < n; i++) {
    if (i % 3 === 1) continue; // a span without a swap
    const buyNam = 800 + ((i * 137) % 2500);
    const sellNam = 600 + ((i * 251) % 3100);
    cvd += buyNam - sellNam;
    buckets.push({ ts: start + i * bucketMs, buyNam, sellNam, netDeltaNam: buyNam - sellNam, cvdNam: cvd, vwapUsd: i % 5 === 0 ? null : 0.0011 + (i % 7) * 0.00001, trades: 2 + (i % 4) });
  }
  const totalBuy = buckets.reduce((a, b) => a + b.buyNam, 0);
  const totalSell = buckets.reduce((a, b) => a + b.sellNam, 0);
  return {
    asOf,
    hours,
    bucketMs,
    buckets,
    netCvdNam: cvd,
    grossVolumeNam: totalBuy + totalSell,
    buySharePct: (totalBuy / (totalBuy + totalSell)) * 100,
    priceChangePct: 1.2,
    absorptionRegime: 'bid_absorption',
    prov: { source: 'D1 flow index', at: asOf - 20_000, status: 'live' },
  };
}
const hoursOf = (url: string) => Number(new URL(url).searchParams.get('hours') || 720);

/** The snapshot's size table with the server's slice figures and a marked size (worker/src/sources/sqs.ts annotateSlippageCurve). */
function tableWithSlices(markNam: number | null, withSlices = true) {
  const rows = [...SNAP.curve.curve].sort((a: { amountNam: number }, b: { amountNam: number }) => a.amountNam - b.amountNam);
  const spot = SNAP.curve.spotUsd as number;
  let prevNam = 0;
  let prevSell = 0;
  let prevBuy = 0;
  // the snapshot's buy rows cost exactly the quoted price (buyInUsdc = usdSize); a real table pays the move on top
  const curve = rows.map((row: { amountNam: number; usdSize: number; buyImpactPct: number; sellOutUsdc: number }) => {
    const p = { ...row, buyInUsdc: row.usdSize * (1 + row.buyImpactPct / 100) };
    const dN = p.amountNam - prevNam;
    const marginalSellUsd = (p.sellOutUsdc - prevSell) / dN;
    const marginalBuyUsd = (p.buyInUsdc - prevBuy) / dN;
    const marginalSellImpactPct = Math.max(0, ((spot - marginalSellUsd) / spot) * 100);
    prevNam = p.amountNam;
    prevSell = p.sellOutUsdc;
    prevBuy = p.buyInUsdc;
    return withSlices ? { ...p, marginalSellUsd, marginalBuyUsd, marginalSellImpactPct } : p;
  });
  return {
    ...SNAP.curve,
    curve,
    liquidityCliffNam: markNam,
    cliffNote: markNam ? `Concentrated Liquidity cliff above ${markNam.toLocaleString('en-US')} NAM: marginal sell slippage jumps 3.0x (1.00% → 3.00%) on the next slice.` : null,
    prov: { ...SNAP.curve.prov, at: Date.now() - 2000 },
  };
}

test.describe('charts, at 375 px', () => {
  test.beforeEach(({}, info) => test.skip(onlyIn(info.project.name), 'viewport-independent: runs in 375x812'));

  test('what was bought and sold: plain words, every figure in scope, one axis per plot, the readout by keyboard, the phone layout', async ({ page }) => {
    await page.route(/\/api\/orderflow/, (r) => r.fulfill({ json: flowAnswer(hoursOf(r.request().url())) }));
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await gotoRoute(page, '/trade');
    const chart = page.locator('.tk-chart');
    await expect(chart.locator('#h-chart')).toBeVisible({ timeout: 30_000 });
    await chart.getByRole('button', { name: 'Show what was bought and sold' }).click();
    const flow = chart.locator('.tk-flow .chartsec');
    await expect(flow.locator('#h-flow')).toHaveText(/^\S+ NAM more (bought than sold|sold than bought) since \d+ \w+$|^As much NAM bought as sold since/);
    // words: nothing banned, none of the expert words the chart used to print (the glossary popover is the place for them)
    const text = await wordsIn(page, '.tk-flow');
    expect(offending(text, BANNED)).toEqual([]);
    expect(offending(text, JARGON)).toEqual([]);
    await expect(flow.locator('.chartsec__title .cap')).toHaveText('NAM bought and sold on Osmosis per 6 hours, bot trades left out, and the running total of bought minus sold.');
    await expect(flow.locator('.key li')).toHaveText(['NAM bought per 6 hours', 'NAM sold per 6 hours', 'Bought minus sold, running total']);
    await expect(flow.locator('.cstats dt')).toHaveText(['Bought minus sold', 'NAM bought and sold', 'Share bought', 'Average price change']);
    // the server's reading of the whole window, said as what happened; the spans with a swap counted in words
    await expect(flow).toContainText('More NAM was sold than bought over this window, and the average price changed little.');
    await expect(flow).toContainText(/of the \d+ 6-hour spans since \d+ \w+ had/);
    // the expert term is one tap away
    await flow.locator('.key .term').click();
    await expect(page.locator('.pop:popover-open, .pop.is-open').first()).toContainText('Cumulative volume delta');
    await page.keyboard.press('Escape');
    // one y axis per plot: two zero lines, one running-total line, bars, and no dimmed group
    const svg = flow.locator('.chart-box svg');
    await expect(svg.locator('line.c-axis')).toHaveCount(2);
    await expect(svg.locator('path.c-exec')).toHaveCount(1);
    expect(await svg.locator('rect.c-bar-buy').count()).toBeGreaterThan(10);
    await expect(svg.locator('g[opacity]')).toHaveCount(0);
    // every figure sits in the section's scope; its SourceLine is visible and lists the series
    expect(await orphansIn(page, '.tk-flow')).toEqual([]);
    await expect(flow.locator('.srcb')).toBeVisible();
    await expect(flow.locator('.srcb')).toHaveAttribute('data-scope', /running total/);
    // the readout by keyboard: a read bar is outlined, the others never dim; Escape returns to the running total
    await flow.locator('.chart-box').focus();
    await page.keyboard.press('ArrowLeft');
    await expect(flow.locator('.readout__k')).toHaveText('Bought minus sold, up to this span');
    await expect(flow.locator('.readout__t')).toContainText(/bought [\d,]+ · sold [\d,]+/);
    await expect(svg.locator('.is-pick')).toHaveCount(2);
    await page.keyboard.press('Escape');
    await expect(flow.locator('.readout__k')).toHaveText('Bought minus sold so far');
    // its own range inside the fetched record: 7d shows a week, and the whole-window sentence is then left out
    await flow.getByRole('radio', { name: '7d' }).click();
    await expect(flow.locator('.cstats')).toContainText(/since \d+ \w+/);
    await expect(flow).not.toContainText('over this window');
    await flow.getByRole('radio', { name: '30d' }).click();
    await expect(flow).toContainText('over this window');
    // the phone layout with the second chart open
    const a = await layoutAudit(page, 'body');
    expect(a.overflowX, `scrollWidth ${a.scrollWidth} > ${a.innerWidth}`).toBe(false);
    expect(a.smallText).toEqual([]);
    expect(a.smallTargets).toEqual([]);
    await flow.scrollIntoViewIfNeeded();
    await flow.screenshot({ path: test.info().outputPath('flow-375.png') });
    expect(errors).toEqual([]);
  });

  test('the size table: the slice view in plain words, one line per side, the marked size, three figures of one slice', async ({ page }) => {
    await page.route(/\/api\/quote\/curve/, (r) => r.fulfill({ json: tableWithSlices(10_000) }));
    await page.route(/\/api\/quote\?/, (r) => r.fulfill({ json: { quote: null, error: DOWN, code: 'unavailable' } }));
    await gotoRoute(page, '/trade');
    const block = page.locator('.ladder');
    await expect(block.locator('.curve__mode')).toBeVisible({ timeout: 30_000 });
    await expect(block.getByRole('radio', { name: 'Each slice' })).toBeEnabled();
    // the mark is drawn and explained in the key; the server's own sentence about it is never printed
    const svg = block.locator('.curve svg');
    await expect(svg.locator('.c-evtl')).toHaveText('above 10k');
    await expect(block.locator('.curve__key')).toContainText('above this size each extra NAM sold gets a much lower price');
    let text = await wordsIn(page, '.ladder');
    expect(offending(text, BANNED)).toEqual([]);
    expect(offending(text, JARGON)).toEqual([]);
    // the whole-order view is the default, with its three figures
    await expect(block.locator('.curve__read dt')).toHaveText(['Worth', 'You get', 'Price moves']);
    await expect(svg.locator('path.cv-sell')).toHaveCount(1);
    await expect(svg.locator('path.cv-buy')).toHaveCount(1);
    // the slice view: two lines (selling solid, buying dashed), straight between the dots, and three figures of one slice
    await block.getByRole('radio', { name: 'Each slice' }).click();
    await expect(block.locator('.curve__key')).toContainText('Each slice on its own: the NAM between one listed size and the next');
    await expect(block.locator('.curve__read dt').nth(1)).toHaveText('You get for that slice');
    await expect(block.locator('.curve__read dt').nth(2)).toHaveText('Price move for that slice');
    await expect(svg.locator('path.cv-sell')).toHaveCount(1);
    await expect(svg.locator('path.cv-buy')).toHaveCount(1);
    expect(await svg.locator('path.cv-sell').getAttribute('d')).not.toMatch(/[HV]/);
    await block.locator('.lrow__pick[aria-label="Quote 25,000 NAM"]').click();
    await expect(block.locator('.curve__read')).toContainText('15,000 NAM');
    // the readout says which slice, and the note never says "logarithmic"
    await expect(block.locator('.curve__read dt').first()).toHaveText('Slice from 10,000 to 25,000');
    await expect(block.locator('.curve__note')).not.toContainText('logarithmic');
    await expect(block.locator('.curve__note')).toContainText('each step is a multiple');
    await expect(block.locator('.curve__how')).toContainText('The slice from 10,000 to 25,000 NAM on its own, from the two real quotes around it.');
    await expect(block.locator('.curve__how')).toContainText(/The pools pay \$0\.\d{6} per NAM for it\./);
    const row = tableWithSlices(10_000).curve.find((p: { amountNam: number }) => p.amountNam === 25_000);
    await expect(block.locator('.curve__read dd').nth(2)).toHaveText(`−${row.marginalSellImpactPct.toFixed(2)}%`);
    // buying: the same slice from the buyer's side
    await page.getByRole('radio', { name: 'Buy NAM with USDC' }).click();
    await expect(block.locator('.curve__read dt')).toHaveText(['Slice from 10,000 to 25,000', 'You pay for that slice', 'Price move for that slice']);
    await expect(block.locator('.curve__read dd').nth(2)).toHaveText(/^\+\d+\.\d\d%$/);
    text = await wordsIn(page, '.ladder');
    expect(offending(text, BANNED)).toEqual([]);
    expect(offending(text, JARGON)).toEqual([]);
    expect(await orphansIn(page, '.ladder')).toEqual([]);
    const a = await layoutAudit(page, 'body');
    expect(a.overflowX, `scrollWidth ${a.scrollWidth} > ${a.innerWidth}`).toBe(false);
    expect(a.smallText).toEqual([]);
    expect(a.smallTargets).toEqual([]);
    await block.locator('.curve').scrollIntoViewIfNeeded();
    await block.locator('.curve-box').screenshot({ path: test.info().outputPath('slices-375.png') });
    // back to the whole order
    await block.getByRole('radio', { name: 'Whole order' }).click();
    await expect(block.locator('.curve__read dt')).toHaveText(['Worth', 'You pay', 'Price moves']);
  });

  test('a size table without slice figures: the view is off and says why; no mark, no sentence', async ({ page }) => {
    const bare = tableWithSlices(null, false);
    bare.curve = bare.curve.map((p: Record<string, unknown>) => ({ ...p, sellOutUsdc: null, buyInUsdc: null }));
    await page.route(/\/api\/quote\/curve/, (r) => r.fulfill({ json: bare }));
    await page.route(/\/api\/quote\?/, (r) => r.fulfill({ json: { quote: null, error: DOWN, code: 'unavailable' } }));
    await gotoRoute(page, '/trade');
    const block = page.locator('.ladder');
    await expect(block.locator('.curve__mode')).toBeVisible({ timeout: 30_000 });
    await expect(block.getByRole('radio', { name: 'Each slice' })).toBeDisabled();
    await expect(block.locator('.curve__mode .cap')).toHaveText('The size table gave no figure for any slice on its own, so that view is off.');
    await expect(block.locator('.curve svg .c-evtl')).toHaveCount(0);
    await expect(block.locator('.curve__read dt')).toHaveText(['Worth', 'You get', 'Price moves']);
  });

  test('the price chart: the unit and the count in words; a thinned long range is said as such; six pills fit the phone', async ({ page }) => {
    await gotoRoute(page, '/trade');
    const chart = page.locator('.tk-chart .chartsec').first();
    await expect(chart.locator('#h-chart')).toBeVisible({ timeout: 30_000 });
    // the series' stamps come with the overview; the line holds its place until then
    await expect(chart.locator('.srcb')).toBeVisible({ timeout: 30_000 });
    await expect(chart.locator('.chartsec__title .cap')).toHaveText(/^USDC paid per NAM in real trades: each point is the middle price of one hour’s trades, [\d,]+ points?\.$/);
    // the sparse sentence (the start dates are their own line under it, .c-starts)
    const caps = chart.locator(':scope > .cap:not(.c-starts)');
    await expect(caps).toContainText(/of the [\d,]+ hours since \d+ \w+ had/);
    await expect(caps).not.toContainText('bucketed');
    await chart.getByRole('radio', { name: '90d' }).click();
    await expect(caps).toContainText('a gap is not an hour without a trade', { timeout: 30_000 });
    await expect(caps).not.toContainText(/hours since/);
    await expect(chart.locator('.chartsec__title .cap')).toContainText('middle price of one hour’s trades');
    const text = await wordsIn(page, '.tk-chart');
    expect(offending(text, BANNED)).toEqual([]);
    expect(offending(text, [/bucket/i])).toEqual([]);
    expect(await orphansIn(page, '.tk-chart')).toEqual([]);
    // the six range pills stay inside the column
    const seg = chart.locator('.seg--range');
    await expect(seg.getByRole('radio')).toHaveCount(6);
    const box = (await seg.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(375 - 16 + 0.5);
    const a = await layoutAudit(page, 'body');
    expect(a.overflowX, `scrollWidth ${a.scrollWidth} > ${a.innerWidth}`).toBe(false);
    expect(a.smallText).toEqual([]);
    expect(a.smallTargets).toEqual([]);
    await chart.screenshot({ path: test.info().outputPath('price-90d-375.png') });
  });
});

// ---------------------------------------------------------------------------------------------------
// The price chart with the series route answering (screener-plan 2.6): production does not serve /api/series
// yet, so the chart's three requests are answered with SeriesResponse shapes (shared/types.ts). The full
// screener fixtures and the Trade panels' tests are in trade.spec.ts; these check the chart grammar only.
// ---------------------------------------------------------------------------------------------------
type Sample = { t: number; v: number; lo?: number; hi?: number; n?: number; flat?: boolean };
function seriesAnswer(key: string, unit: 'usd_per_nam' | 'nam', points: Sample[], stepMs: number, start: number) {
  const last = points[points.length - 1];
  const source = key === 'price.pool_1h' ? 'Osmosis data API' : key === 'price.usd' ? 'Osmosis SQS' : 'executed NAM/USDC swaps (hourly median)';
  return {
    key, from: points[0]?.t ?? start, to: Date.now(), step: stepMs === H ? '1h' : stepMs === 6 * H ? '6h' : '1d', stepMs, agg: unit === 'nam' ? 'sum' : 'last', unit, points,
    sources: [{ source, from: points[0]?.t ?? null, to: last?.t ?? null, start, startNote: '', backfilled: false }], start,
    sparse: key !== 'price.usd', coverage: { steps: 0, withPoint: points.length }, gaps: [],
    prov: { source, at: last?.t ?? null, status: last ? 'live' : 'missing' }, asOf: Date.now(),
  };
}
async function mockChartSeries(page: Page) {
  const now = Date.now();
  const h0 = Math.floor(now / H) * H;
  await page.route(/\/api\/series\?/, (r) => {
    const u = new URL(r.request().url());
    const key = u.searchParams.get('key')!;
    const stepMs = u.searchParams.get('step') === '6h' ? 6 * H : u.searchParams.get('step') === '1d' ? 24 * H : H;
    const hours = [2, 3, 4, 9, 30, 31, 55, 80, 140, 300].map((k) => h0 - k * H);
    if (key === 'price.swap_1h') return r.fulfill({ json: seriesAnswer(key, 'usd_per_nam', hours.map((t, i) => ({ t, v: 0.0011 + (i % 4) * 0.00002, n: 1 })).sort((a, b) => a.t - b.t), stepMs, h0 - 2000 * H) });
    if (key === 'price.usd') {
      const pts: Sample[] = [];
      for (let t = h0 - 120 * H; t <= h0; t += stepMs) pts.push({ t, v: 0.00112, lo: 0.00111, hi: 0.00114, n: 60 });
      return r.fulfill({ json: seriesAnswer(key, 'usd_per_nam', pts, stepMs, h0 - 130 * H) });
    }
    if (key === 'dex.swaps_1h.nam') return r.fulfill({ json: seriesAnswer(key, 'nam', hours.map((t, i) => ({ t, v: 300 + i * 90, n: 1 })).sort((a, b) => a.t - b.t), stepMs, h0 - 2000 * H) });
    if (key === 'price.pool_1h') {
      const pts: Sample[] = [];
      for (let t = h0 - 400 * 24 * H, i = 0; t <= h0; t += stepMs, i++) pts.push({ t, v: 0.0011 + (i % 11) * 0.00001, ...(i % 3 === 0 ? { flat: true } : {}) });
      return r.fulfill({ json: seriesAnswer(key, 'usd_per_nam', pts, stepMs, h0 - 486 * 24 * H) });
    }
    return r.fulfill({ status: 404, json: { error: 'This figure is not served yet.', reason: 'Unknown key.', endpoint: '/api/series' } });
  });
}

test.describe('the price chart with the series route, at 375 px', () => {
  test.beforeEach(({}, info) => test.skip(onlyIn(info.project.name), 'viewport-independent: runs in 375x812'));

  test('one axis per plot: prices on the price plot, NAM on the bars strip under it; no buy or sell hue on any series; plain words; every figure in scope', async ({ page }) => {
    await mockChartSeries(page);
    await gotoRoute(page, '/trade');
    const chart = page.locator('.tk-chart .chartsec').first();
    await expect(chart.locator('g.c-bars')).toBeVisible({ timeout: 30_000 });
    const ticks = await chart.locator('.chart-box svg > g > text.c-tick, .chart-box svg > g.c-bars > text.c-tick').allTextContents();
    const strip = await chart.locator('g.c-bars text.c-tick').allTextContents();
    expect(strip.length).toBe(2);
    expect(strip[0]).toMatch(/^[\d.]+k? NAM$/);
    expect(strip[1]).toBe('0');
    // the price plot's own labels are all prices; none of them is a NAM figure
    const priceTicks = ticks.filter((t) => !strip.includes(t));
    expect(priceTicks.length).toBeGreaterThanOrEqual(3);
    for (const t of priceTicks) expect(t).toMatch(/^0\.\d+$/);
    // series colours: never the buy or sell hue
    const fills = await chart.locator('.chart-box').evaluate((el) => {
      const hue = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
      const used = [...el.querySelectorAll('rect.c-bar, path.c-exec, path.c-quote, path.c-band, path.c-pool, circle.c-exec-dot')].map((n) => [getComputedStyle(n).fill, getComputedStyle(n).stroke]).flat();
      const probe = document.createElement('i');
      document.body.append(probe);
      const rgb = (v: string) => { probe.style.color = `var(${v})`; return getComputedStyle(probe).color; };
      const banned = [rgb('--buy'), rgb('--sell')];
      probe.remove();
      return { used: [...new Set(used)], banned, hue: hue('--buy') };
    });
    for (const b of fills.banned) expect(fills.used).not.toContain(b);
    const text = await wordsIn(page, '.tk-chart');
    expect(offending(text, BANNED)).toEqual([]);
    expect(offending(text, JARGON)).toEqual([]);
    expect(await orphansIn(page, '.tk-chart')).toEqual([]);
    const a = await layoutAudit(page, '.tk-chart');
    expect(a.overflowX).toBe(false);
    expect(a.smallText).toEqual([]);
    expect(a.smallTargets).toEqual([]);
    await chart.screenshot({ path: test.info().outputPath('price-served-30d-375.png') });
  });

  test('the long ranges read the pool price by keyboard and say it is not a trade; the arrow keys walk it', async ({ page }) => {
    await mockChartSeries(page);
    await gotoRoute(page, '/trade');
    const chart = page.locator('.tk-chart .chartsec').first();
    await expect(chart.locator('#h-chart')).toBeVisible({ timeout: 30_000 });
    await chart.getByRole('radio', { name: '1y' }).click();
    await expect(chart.locator('path.c-pool').first()).toBeVisible({ timeout: 30_000 });
    const box = chart.locator('.chart-box');
    await box.focus();
    await page.keyboard.press('Home');
    const first = await chart.locator('.readout').innerText();
    expect(first).toContain('Pool price, not a trade');
    await page.keyboard.press('ArrowRight');
    await expect(chart.locator('.readout')).not.toHaveText(first);
    await page.keyboard.press('Escape');
    await expect(chart.locator('.readout')).toContainText('Last trade');
    const text = await wordsIn(page, '.tk-chart');
    expect(offending(text, JARGON)).toEqual([]);
    expect(await orphansIn(page, '.tk-chart')).toEqual([]);
    await chart.screenshot({ path: test.info().outputPath('price-served-1y-375.png') });
  });
});
