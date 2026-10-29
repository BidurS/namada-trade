// The depth page end to end (step S5), in the style of the Trade spec (web/e2e/trade.spec.ts) but inside vitest: the
// built site (web/dist, `npm run build` first) served from a local static server, Playwright's own Chromium (or the
// installed Google Chrome when that is not downloaded) driven headless at 375 x 812, 320 x 700 and 1280 x 800, and every request answered from the fixtures (the
// API's own answers for the research's chain reads of 2026-10-29, test/fixtures/depth/api_depth_*.json; the design
// snapshot's overview; a few trade rows made up here as chart inputs). Nothing reaches the network: a request to
// any other origin is refused. The checks are the Trade spec's: one h1 with the route's words, no sideways scroll,
// no text under 11 px, every control at least 44 px, the ladder rows at least 40 px; then the page's own states: the
// hero from the stored minute, the split chips, the fact strip, the computed sentences, a typed size asking the quote
// route and the hero following it, a ladder row opening its sheet, the table views, the desktop split with the ladder
// on the left, a rewound page naming the reference pool from the stored rows, the chart holding every trade it
// counts and its mark labels clear of one another, and the words free of the banned list. Skipped, with the reason,
// without the build or a browser, except under CI, where the missing build or browser fails the file.
// With DEPTH_SHOTS=1 it also writes docs/design/build-shots/depth-375.png and depth-1280.png (full page, dark).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join, extname } from 'node:path';
import { chromium, type Browser, type Locator, type Page } from '@playwright/test';
import { depthFixtureText } from './depth-fixtures';
import { BANNED } from './banned-words';
import { routeById } from '../shared/routes';
import { REWIND_NO_BOOK, REWIND_NO_SPLIT, sellQuotableLead, tradesInView } from '../shared/depth';

const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'web', 'dist');
const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
/** Playwright's own Chromium when it is downloaded (`npx playwright install chromium`), else the installed Google Chrome. */
const BROWSER = [chromium.executablePath(), MAC_CHROME].find((p) => p && existsSync(p)) ?? null;
const SHOTS = process.env.DEPTH_SHOTS === '1';
const ROUTE = routeById('depth');
const built = existsSync(join(DIST, 'index.html'));
const ready = built && BROWSER != null;


const fixtureJson = (name: string) => JSON.parse(depthFixtureText(name).split('\n').filter((l) => !l.startsWith('//')).join('\n'));
const LATEST = fixtureJson('api_depth_latest.json');
/** A rewound moment: twenty minutes after the fixture minute (the stored rows around it are built from the fixture, historyOf below). */
const REWIND_AT: number = LATEST.at + 20 * 60_000;
const QUOTES: Record<string, unknown> = { 'sell:7300': fixtureJson('api_depth_quote_sell_7300.json'), 'buy:7300': fixtureJson('api_depth_quote_buy_7300.json'), 'sell:25000': fixtureJson('api_depth_quote_sell_25000.json') };
const SNAP = JSON.parse(readFileSync(join(ROOT, 'docs', 'design', 'data', 'snapshot.json'), 'utf8'));
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

/** The minute as of now: the stored times moved so the stamps read fresh (the figures are untouched). */
function latestNow() {
  const shift = Date.now() - 20_000 - LATEST.at;
  const d = JSON.parse(JSON.stringify(LATEST));
  d.at += shift; d.generatedAt += shift; d.ref.at += shift;
  for (const p of d.pools) { p.balancesAt += shift; if (p.read && 'at' in p.read) p.read.at += shift; if (p.book?.state) p.book.state.at += shift; }
  for (const x of d.prov) x.at += shift;
  if (d.checks.estimate) d.checks.estimate.at += shift;
  return { d, shift };
}
/** A few stored trades of the last week: chart inputs, not figures anyone reads. */
function tradesNow(now: number) {
  const row = (id: string, kind: 'buy' | 'sell', nam: number, usdPerNam: number, ago: number) => ({ id, ts: now - ago, height: 1, tsSource: 'block', kind, nam, counterSymbol: 'USDC', counterAmount: nam * usdPerNam, priceUsd: usdPerNam, priceSource: 'execution', valueUsd: nam * usdPerNam, settle: { side: kind, usdPerNam, nam, coins: [], gasUsd: null, gasLeftOut: false }, maker: null, makerLabelPlain: null, makerTrades: null, route: ['3005'], txHash: id, pattern: null });
  // T5 is worth more than the curve holds at its price (the near window's asks reach about $780 on the fixtures): the axis must grow to draw it
  const rows = [row('T1', 'sell', 10000, 0.00099, 3_600_000), row('T2', 'buy', 400, 0.001025, 7_200_000), row('T3', 'sell', 50000, 0.00081, 2 * 86_400_000), row('T4', 'buy', 5000, 0.0003, 5 * 86_400_000), row('T5', 'buy', 1_000_000, 0.00102, 3 * 86_400_000)];
  return { rows, groups: [], next: null, asOf: now, foldMs: 600_000, patternRule: { minBuys: 20, underNam: 2000, windowMs: 86_400_000 }, prov: { source: 'D1 flow index', at: now - 30_000, status: 'live' } };
}

/** The stored rows of the fixture minute and the one before it, as /api/depth/history answers for the aggregate (the figures are the fixture's). */
function historyOf(at: number) {
  const d = LATEST;
  const pt = (t: number) => ({ t, at: t + 30_000, height: d.ref.height, refUsd: d.ref.usd, spotUsd: null, bid: d.offsets.bid, ask: d.offsets.ask, sell: d.answer.sell.map((f: { usd: number }) => f.usd), buy: d.answer.buy.map((f: { usd: number }) => f.usd), bestBid: d.touch.bestBidEff, bestAsk: d.touch.bestAskEff, bidUsd: d.within.totalBidUsd, askNam: d.within.totalAskNam, note: null });
  const m = Math.floor(d.at / 60_000) * 60_000;
  return { pool: 'all', refPool: '3005', step: '1m', from: at - 600_000, to: at + 1, asOf: at, points: [pt(m - 60_000), pt(m)], gaps: [], start: m - 60_000, cut: false, note: null, prov: [] };
}

async function mockApi(page: Page, origin: string) {
  const { d } = latestNow();
  await page.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.origin !== origin) return route.abort();
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (u.pathname === '/api/depth') return json(d);
    if (u.pathname === '/api/depth/quote') {
      const q = QUOTES[`${u.searchParams.get('side')}:${u.searchParams.get('nam')}`];
      return q ? json(q) : json({ error: 'nam must be one of the sizes the fixtures hold.', reason: 'test', endpoint: '/api/depth/quote' }, 400);
    }
    if (u.pathname === '/api/depth/history') return json(historyOf(Number(u.searchParams.get('at') ?? Date.now())));
    if (u.pathname === '/api/series/trades') return json(tradesNow(Date.now()));
    if (u.pathname === '/api/overview') return json({ ...SNAP.overview, generatedAt: Date.now(), asOf: Date.now() });
    if (u.pathname === '/api/alerts/recent') return json({ hits: [], since: Date.now() - 86_400_000, until: Date.now(), last: null });
    if (u.pathname.startsWith('/api/')) return json({ error: 'This figure is not served yet.', reason: 'not in the test', endpoint: u.pathname }, 404);
    if (u.pathname === '/ws') return route.abort();
    return route.continue();
  });
}

/** The Trade spec's layout audit (web/e2e/helpers.ts layoutAudit), plus the ladder rows' heights. */
async function audit(page: Page) {
  return page.evaluate(() => {
    const de = document.documentElement;
    const visible = (el: Element) => { const r = el.getBoundingClientRect(); if (!r.width || !r.height) return false; const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && cs.display !== 'none'; };
    const smallText: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const n = walker.currentNode;
      const t = (n.textContent ?? '').trim();
      if (!t || !n.parentElement || !visible(n.parentElement)) continue;
      const px = parseFloat(getComputedStyle(n.parentElement).fontSize);
      if (px < 11) smallText.push(`${px}px "${t.slice(0, 40)}"`);
    }
    const smallTargets: string[] = [];
    for (const el of document.querySelectorAll('a[href], button, [role=button], input, select, textarea, [tabindex]:not([tabindex="-1"])')) {
      if (!visible(el)) continue;
      if (el.tagName === 'A' && el.closest('p, li > p, .prose')) continue;
      const r = el.getBoundingClientRect();
      const after = getComputedStyle(el, '::after');
      let w = r.width, h = r.height;
      if (after.content !== 'none' && after.position === 'absolute') { const ins = (v: string) => (v === 'auto' ? 0 : -parseFloat(v) || 0); w = r.width + ins(after.left) + ins(after.right); h = r.height + ins(after.top) + ins(after.bottom); }
      if (w < 44 || h < 44) smallTargets.push(`${Math.round(w)}x${Math.round(h)} ${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30)}"`);
    }
    const rows = [...document.querySelectorAll('.dp-lrow:not(.dp-lrow--head)')].filter(visible).map((r) => Math.round(r.getBoundingClientRect().height));
    return {
      overflowX: de.scrollWidth > Math.round(window.visualViewport?.width ?? window.innerWidth), scrollWidth: de.scrollWidth, innerWidth: window.innerWidth,
      h1: [...document.querySelectorAll('h1')].map((x) => (x.textContent ?? '').trim()), tables: document.querySelectorAll('table').length, smallText, smallTargets, rows,
      text: (document.querySelector('main')?.textContent ?? '').replace(/\s+/g, ' '),
    };
  });
}

let server: Server | null = null;
let origin = '';
let browser: Browser | null = null;

beforeAll(async () => {
  if (!ready) return;
  server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    const file = extname(path) ? join(DIST, path) : join(DIST, 'index.html');
    if (!existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const addr = server.address();
  origin = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  browser = await chromium.launch({ executablePath: BROWSER!, headless: true });
}, 60_000);

/** Two boxes overlap when neither is wholly beside or above the other. */
const overlaps = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

// Under CI the file must run: a missing build or browser is a failure there, not a silent skip.
if (process.env.CI) {
  it('CI: the built site and a browser are present, so the page is tested', () => {
    expect(built, 'web/dist/index.html: run npm run build first').toBe(true);
    expect(BROWSER, 'no browser: npx playwright install chromium').not.toBeNull();
  });
}
afterAll(async () => { await browser?.close(); server?.close(); });

async function open(width: number, height: number, path = '/depth') {
  const ctx = await browser!.newContext({ viewport: { width, height }, deviceScaleFactor: width < 768 ? 2 : 1, isMobile: width < 768, hasTouch: width < 768, colorScheme: 'dark' });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await mockApi(page, origin);
  await page.goto(`${origin}${path}`, { waitUntil: 'domcontentloaded' });
  await page.locator('header.hdr').waitFor();
  await page.locator('main h1').first().waitFor({ timeout: 30_000 });
  return { page, ctx, errors };
}
/** Locator assertions through vitest's own expect.poll (Playwright's matchers need its runner). */
const T = 20_000;
const seen = (loc: Locator, timeout = T) => expect.poll(() => loc.first().isVisible().catch(() => false), { timeout }).toBe(true);
const hidden = (loc: Locator, timeout = T) => expect.poll(() => loc.first().isVisible().catch(() => false), { timeout }).toBe(false);
const count = (loc: Locator, timeout = T) => expect.poll(() => loc.count(), { timeout });
const text = (loc: Locator, timeout = T) => expect.poll(() => loc.first().textContent().then((t) => (t ?? '').replace(/\s+/g, ' ').trim()).catch(() => ''), { timeout });
const settled = async (page: Page) => seen(page.locator('.dp-get [data-num][data-status="fresh"]'));

describe.skipIf(!ready)('the depth page, built, on the fixtures (375, 320 and 1280 wide)', () => {
  for (const [w, h] of [[375, 812], [320, 700], [1280, 800]] as const) {
    it(`${w} x ${h}: one h1, the hero from the stored minute, no sideways scroll, no text under 11 px, 44 px controls, ladder rows at least 40 px`, async () => {
      const { page, ctx, errors } = await open(w, h);
      try {
        await settled(page);
        await count(page.locator('.dp-rows .dp-lrow--ref')).toBe(1);
        const a = await audit(page);
        expect(a.h1).toEqual([ROUTE.h1]);
        expect(a.overflowX, `scrollWidth ${a.scrollWidth} > ${a.innerWidth}`).toBe(false);
        expect(a.tables).toBe(0);
        expect(a.smallText).toEqual([]);
        expect(a.smallTargets).toEqual([]);
        expect(a.rows.length).toBeGreaterThan(5);
        expect(Math.min(...a.rows)).toBeGreaterThanOrEqual(40);
        expect(errors).toEqual([]);
        for (const re of [BANNED]) expect(a.text).not.toMatch(re);
        // the hero is the minute's own figure for 10,000 sold, with its chip; the split names pool 3005 first
        await text(page.locator('.dp-get .hero-n__v [data-num]')).toBe('$9.92');
        await text(page.locator('.dp-get .chip')).toContain('Osmosis chain');
        await text(page.locator('.dp-split__c')).toContain('pool 3005');
        await count(page.locator('.dp-facts .fact')).toBe(6);
        await count(page.locator('.dp-say p')).toBe(3);
        await text(page.locator('.dp-say')).toContain('sell into the pools, not the book');
        await seen(page.locator('.dp-ticket .srcb'));
        if (w >= 1024) {
          // the split: the ladder left, the curve right, both shown
          const la = await page.locator('.dp-book__a').boundingBox();
          const cu = await page.locator('.dp-book__b').boundingBox();
          expect(la && cu && la.x + la.width <= cu.x + 1).toBe(true);
          await hidden(page.locator('.dp-tabs'));
          await seen(page.locator('.dp-chart__plot svg'));
          // the size marks' labels and the reference line's label sit clear of one another
          // (the marks priced inside ½x to 2x: six of the eight on the fixtures, the million-coin fills fall outside; plus the reference label)
          const labels = page.locator('.dp-chart svg text.dpc-mark-l, .dp-chart svg text.dpc-ref-l');
          await count(labels).toBeGreaterThanOrEqual(6);
          const boxes = await labels.evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, text: e.textContent }; }));
          const clashes: string[] = [];
          for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (overlaps(boxes[i], boxes[j])) clashes.push(`${boxes[i].text} / ${boxes[j].text}`);
          expect(clashes).toEqual([]);
          // every label is inside the plot
          const plot = (await page.locator('.dp-chart__plot').boundingBox())!;
          for (const b of boxes) expect(b.y >= plot.y - 1 && b.y + b.height <= plot.y + plot.height + 1 && b.x >= plot.x - 1 && b.x + b.width <= plot.x + plot.width + 1, `${b.text} inside the plot`).toBe(true);
        } else {
          await seen(page.locator('.dp-tabs'));
          await hidden(page.locator('.dp-book__b'));
        }
        if (SHOTS && (w === 375 || w === 1280)) {
          await page.waitForTimeout(600);
          await page.screenshot({ path: join(ROOT, 'docs', 'design', 'build-shots', `depth-${w}.png`), fullPage: true });
        }
      } finally {
        await ctx.close();
      }
    }, 60_000);
  }

  it('a typed size asks the quote route and the hero follows it; a chip reads the minute without a request; buying switches the verb', async () => {
    const { page, ctx } = await open(375, 812);
    try {
      await settled(page);
      const asked: string[] = [];
      page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname === '/api/depth/quote') asked.push(u.search); });
      const input = page.locator('.dp-field input');
      await input.fill('7300');
      await expect.poll(() => asked.some((s) => s.includes('nam=7300') && s.includes('side=sell')), { timeout: 10_000 }).toBe(true);
      const q = QUOTES['sell:7300'] as { usd: number };
      await text(page.locator('.dp-get .hero-n__v [data-num]')).toBe(`$${q.usd.toFixed(2)}`);
      await text(page.locator('.dp-get .hero-n__sub')).toContain('7,300 NAM');
      const before = asked.length;
      await page.getByRole('radio', { name: '1,000', exact: true }).click();
      await text(page.locator('.dp-get .hero-n__v [data-num]')).toBe('$1.01');
      await expect.poll(() => page.locator('.dp-field input').inputValue(), { timeout: T }).toBe('1,000');
      await page.waitForTimeout(700);
      expect(asked.length).toBe(before);
      await page.getByRole('radio', { name: 'Buy NAM' }).click();
      await text(page.locator('.dp-get .hero-n__label')).toBe('You pay');
      await text(page.locator('.dp-get .hero-n__sub')).toContain('to buy 1,000 NAM now');
    } finally {
      await ctx.close();
    }
  }, 60_000);

  it('the ladder: the reference row names the best bid and ask, a row opens its sheet with the pools in the band, the folds open, the band width changes the rows, the table view unfolds everything; the curve tab draws the chart with its key', async () => {
    const { page, ctx } = await open(375, 812);
    try {
      await settled(page);
      await count(page.locator('.dp-rows .dp-lrow--ref')).toBe(1);
      await text(page.locator('.dp-lrow--ref')).toContain('Pool 3005 price 0.0010199');
      await text(page.locator('.dp-lrow--ref')).toContain('best bid for 100 NAM');
      await count(page.locator('.dp-lrow.is-mark')).toBe(1);
      const rows1 = await page.locator('.dp-lrow--bid').count();
      await page.locator('.dp-lrow--bid .dp-lrow__open').first().click();
      const dialog = page.locator('dialog[open]');
      await seen(dialog);
      await text(dialog.locator('.dp-sheet__pools li')).toContain('pool 3005');
      await text(dialog).toContain('selling down to');
      await page.keyboard.press('Escape');
      await count(dialog).toBe(0);
      // a fold opens the rows it hides
      const fold = page.locator('.dp-fold').first();
      const foldText = await fold.textContent();
      expect(foldText).toMatch(/more ask levels above \+50%/);
      await fold.click();
      await text(page.locator('.dp-fold')).toContain('hide the asks');
      // the half-percent width gives more bid rows than the one-percent
      await page.getByRole('radio', { name: '0.5% levels' }).click();
      await expect.poll(() => page.locator('.dp-lrow--bid').count()).toBeGreaterThan(rows1);
      await page.getByRole('button', { name: 'Table view' }).first().click();
      await count(page.locator('.dp-fold')).toBe(0);
      await seen(page.locator('.dp-ladder[data-view="table"]'));
      // the curve
      await page.getByRole('radio', { name: 'Curve' }).click();
      await seen(page.locator('.dp-chart__plot svg'));
      await count(page.locator('.dp-key li')).toBe(4);
      await count(page.locator('.dp-chart svg .dpc-bid')).toBe(1);
      await count(page.locator('.dp-chart svg .dpc-ask')).toBe(1);
      // the four trades priced inside ½x to 2x are all drawn (T5, worth more than the curve holds at its price, among them: the axis grew to hold it), and the sentence counts the same four; T4, at less than a third of the price, is outside
      await count(page.locator('.dp-chart svg .dpc-trade')).toBe(4);
      await text(page.locator('.dp-trades')).toBe(tradesInView(4, 5, 7));
      const plot = (await page.locator('.dp-chart__plot').boundingBox())!;
      const diamonds = await page.locator('.dp-chart svg .dpc-trade').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }));
      for (const b of diamonds) expect(b.y >= plot.y && b.y + b.height <= plot.y + plot.height, 'a trade inside the plot').toBe(true);
      await expect.poll(() => page.locator('.dp-chart svg .c-tick').allTextContents()).toSatisfy((ts: string[]) => ts.some((t) => /^\$1[,.]?[0-9]*k?$/.test(t) && t !== '$1'));
      await page.getByRole('radio', { name: '⅒× to 10×' }).click();
      await count(page.locator('.dp-chart svg text', { hasText: 'log scale' })).toBe(1);
      await count(page.locator('.dp-chart svg .dpc-trade')).toBe(5);
      await text(page.locator('.dp-trades')).toBe(tradesInView(5, 5, 7));
      await page.locator('.dp-chart__plot').focus();
      await page.keyboard.press('ArrowRight');
      await text(page.locator('.dp-chart .readout')).toContain('selling');
      await page.getByRole('button', { name: 'Table view' }).last().click();
      await count(page.locator('.dp-table .dp-trow')).toBeGreaterThan(1);
    } finally {
      await ctx.close();
    }
  }, 60_000);

  it('rewound: the stored minute’s figures with the reference pool named from the history answer (never an empty pool), no split, the field off, no ladder or curve', async () => {
    const { page, ctx, errors } = await open(375, 812, `/depth?at=${REWIND_AT}`);
    try {
      await seen(page.locator('.dp-ticket[data-mode="rewind"]'));
      await text(page.locator('.dp-get .hero-n__v [data-num]')).toBe('$9.92');
      await text(page.locator('.dp-get .hero-n__sub')).toContain('reading of');
      await count(page.locator('.dp-facts .fact')).toBe(6);
      const strip = await page.locator('.dp-facts').textContent();
      expect(strip).toContain('Pool 3005 price');
      expect(strip).toContain('vs pool 3005’s price');
      expect(strip).not.toMatch(/Pool\s{2,}price|pool\s+’s/);
      expect(strip).toContain('not stored per minute');
      await text(page.locator('.dp-split__none')).toBe(REWIND_NO_SPLIT);
      expect(await page.locator('.dp-field input').getAttribute('readonly')).not.toBeNull();
      await text(page.locator('.dp-bookband')).toContain(REWIND_NO_BOOK);
      await count(page.locator('.dp-rows')).toBe(0);
      await count(page.locator('.dp-say p')).toBe(0);
      expect(errors).toEqual([]);
      const a = await audit(page);
      for (const re of [BANNED]) expect(a.text).not.toMatch(re);
    } finally {
      await ctx.close();
    }
  }, 60_000);

  it('Home and Trade carry the two quotable numbers with the minute’s time, linking to /depth', async () => {
    for (const path of ['/', '/trade']) {
      const { page, ctx } = await open(375, 812, path);
      try {
        const line = page.locator('.dp-line');
        await seen(line);
        await text(line).toContain(sellQuotableLead('10,000', 'NAM'));
        await text(line).toContain('$9.92');
        await text(line).toContain('of bids within 10% of the price');
        await seen(line.locator('[data-prov]'));
        await seen(line.locator('a[href="/depth"]'));
      } finally {
        await ctx.close();
      }
    }
  }, 60_000);
});
