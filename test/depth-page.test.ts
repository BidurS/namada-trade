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
// counts and its mark labels clear of one another, and the words free of the banned list. Step S6 adds the time band
// (the heat from the stored column of the fixtures tiled over the window with a twenty-minute outage and one failed
// minute: a blank column and a broken hairline at 375 and 1280, the paint of a week measured under 200 ms of
// main-thread time through the chart's own performance measure, the legend's five steps and its blank floor, the
// honest start, the executable line broken at the outage, the change rows worded with their owners, the cost line and
// what was left out) and the owners band (the owners of the fixtures' hour with a disclosure per owner, "replaced this
// week" from the change rows, the address control). A pointer swept over the curve, the heat and the executable line at
// 320, 375, 640 and 1280 px, at a 16 px and a 20 px root font, reads each into its readout, moves no plot (the readouts keep one
// height, depth.css) and never clips the curve's pools line. Skipped, with the reason,
// without the build or a browser, except under CI, where the missing build or browser fails the file.
// The phone cut (owner, 2026-10-30) adds: the hero's figure on the first screen at 375 x 667, the page's height in screens
// with each band, the strip showing one evidence band at a time under 1024 px and none of it at 1280, the cost and
// left-out lines behind one disclosure grouped by reason, the owners' largest five and a fold naming the rest, one-line
// leads and folds, and the audit of the new parts at 375 and 320.
// With DEPTH_SHOTS=1 it also writes docs/design/build-shots/depth-375.png and depth-1280.png (full page, dark).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join, extname } from 'node:path';
import { chromium, type Browser, type Locator, type Page } from '@playwright/test';
import { depthFixtureText } from './depth-fixtures';
import { BANNED } from './banned-words';
import { routeById } from '../shared/routes';
import { EXEC_READING, GAPS_NONE, HEAT_EDGES, HEAT_HOW, OPS_FOLD, OWNERS_REWIND, REWIND_NO_BOOK, REWIND_NO_SPLIT, depthLeadShort, leftOutGroup, recordedSince, sellQuotableLead, tradesInView, whoFewer, whoMore, type DepthChangeRow } from '../shared/depth';
import { fmtUtcLong } from '../shared/format';

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
const HEAT_COL = fixtureJson('api_depth_heat_column.json');
const OWNERS = fixtureJson('api_depth_owners.json');
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
/** The stored minutes stop for twenty minutes ten hours before now, and one minute three hours before now failed (on a five-minute grid's fourth minute, the one the week's read keeps, so the week's columns show it too). */
const outageAt = (now: number) => Math.floor((now - 10 * HOUR) / (5 * MIN)) * 5 * MIN;
const failedAt = (now: number) => Math.floor((now - 3 * HOUR) / (5 * MIN)) * 5 * MIN + 4 * MIN;
const stored = (t: number, now: number) => !(t >= outageAt(now) && t < outageAt(now) + 20 * MIN) && t !== failedAt(now);
/** The first stored minute: three days before now. */
const startOf = (now: number) => Math.floor((now - 3 * DAY) / MIN) * MIN;
/** When depth was first recorded (the history answer's recordedSince): a day before the first minute row, as it is once the minute rows' retention has passed and the hourly rows reach further back. */
const recordedFrom = (now: number) => startOf(now) - DAY;
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
  return { pool: 'all', refPool: '3005', step: '1m', from: at - 600_000, to: at + 1, asOf: at, points: [pt(m - 60_000), pt(m)], gaps: [], start: m - 60_000, recordedSince: recordedFrom(at), cut: false, note: null, prov: [] };
}

/** The heat of the last `days` as the route answers it: the fixture's column at every step of the window but the outage and the failed minute. */
function heatOf(days: number, now: number) {
  const step = days === 1 ? '1m' : days === 7 ? '5m' : '1h';
  const stepMs = step === '1m' ? MIN : step === '5m' ? 5 * MIN : HOUR;
  const to = now, from = to - days * DAY;
  const columns: unknown[] = [];
  const first = step === '5m' ? Math.ceil(from / (5 * MIN)) * 5 * MIN + 4 * MIN : Math.ceil(from / stepMs) * stepMs;
  for (let t = first; t < to; t += stepMs) {
    if (t < startOf(now) || (step !== '1h' && !stored(t, now))) continue;
    if (step === '1h' && !stored(t + 59 * MIN, now)) continue;
    columns.push({ t, refUsd: HEAT_COL.refUsd, bid: HEAT_COL.bid, ask: HEAT_COL.ask, height: HEAT_COL.height });
  }
  const table = step === '1h' ? 'depth_hourly' : 'depth_minute';
  return { days, from, to, asOf: now, bands: { edges: [...HEAT_EDGES], pct: 2.5 }, columns, step, max: 272.77, how: 'one column per stored minute of the aggregate', prov: [{ what: `${table} rows of the aggregate: ${columns.length} columns`, url: null, table, key: { pool_id: 'all', from, to, step }, at: now - 30_000, height: HEAT_COL.height, bytes: 1, status: 'stored' }] };
}
/** The stored figures over a window (the executable line): one point per stored minute, or per hour with the hour's own range. */
function historyWindow(from: number, to: number, step: '1m' | '1h', now: number) {
  const d = LATEST;
  const stepMs = step === '1m' ? MIN : HOUR;
  const points: unknown[] = [];
  const gaps: unknown[] = [];
  for (let t = Math.ceil(from / stepMs) * stepMs; t < to; t += stepMs) {
    if (t < startOf(now)) continue;
    if (step === '1m' && !stored(t, now)) continue;
    // the quotable size keeps the minute's own figure (the rewound hero reads it); the other sizes vary a little, so the line has a low and a high
    const sell = d.answer.sell.map((f: { usd: number }, i: number) => (i === 1 ? f.usd * (1 + ((t / stepMs) % 7) * 0.0005) : f.usd));
    points.push({ t, at: t + 30_000, height: d.ref.height, refUsd: d.ref.usd, spotUsd: null, bid: d.offsets.bid, ask: d.offsets.ask, sell, buy: d.answer.buy.map((f: { usd: number }) => f.usd), bestBid: d.touch.bestBidEff, bestAsk: d.touch.bestAskEff, bidUsd: d.within.totalBidUsd, askNam: d.within.totalAskNam, note: null, ...(step === '1h' ? { hour: { sellLo: sell[1] * 0.99, sellHi: sell[1] * 1.01, bidLo: null, bidHi: null, n: 60 } } : {}) });
  }
  if (step === '1m' && outageAt(now) >= from) gaps.push({ from: outageAt(now), to: outageAt(now) + 20 * MIN, why: 'no row was stored for these minutes' });
  return { pool: 'all', refPool: '3005', step, from, to, asOf: now, points, gaps, start: startOf(now), recordedSince: recordedFrom(now), cut: false, note: null, prov: [{ what: `depth_${step === '1m' ? 'minute' : 'hourly'} rows of pool all: ${points.length}`, url: null, table: step === '1m' ? 'depth_minute' : 'depth_hourly', key: { pool_id: 'all', from, to }, at: now - 30_000, height: LATEST.ref.height, bytes: 1, status: 'stored' }] };
}
/** A few change rows of the last days, worded by the page: an order pulled and placed again by the same owner (replaced once this week), a position withdrawn, a pool's reserves grown. */
function changesOf(now: number): DepthChangeRow[] {
  const book = OWNERS.owners.find((o: { orders: number }) => o.orders > 0);
  const pos = OWNERS.owners.find((o: { positions: number }) => o.positions > 0);
  const order = book.items[0], position = pos.items[0];
  return [
    { ts: now - 2 * HOUR, pool: order.pool, ref: `ord:${order.id}`, kind: 'added', side: order.side, loUsd: order.loUsd, hiUsd: order.hiUsd, nam: order.nam, usd: order.usd, owner: book.address, height: 73_429_400 },
    { ts: now - 5 * HOUR, pool: order.pool, ref: `ord:${order.id}`, kind: 'removed', side: order.side, loUsd: order.loUsd, hiUsd: order.hiUsd, nam: order.nam, usd: order.usd, owner: book.address, height: 73_429_300 },
    { ts: now - DAY, pool: position.pool, ref: `pos:${position.id}`, kind: 'removed', side: null, loUsd: position.loUsd, hiUsd: position.hiUsd, nam: position.nam, usd: position.usd, owner: pos.address, height: 73_429_000 },
    { ts: now - 2 * DAY, pool: '3439', ref: 'res', kind: 'grew', side: null, loUsd: null, hiUsd: null, nam: 990, usd: 1.02, owner: null, height: 73_428_000 },
  ];
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
    if (u.pathname === '/api/depth/history') {
      const now = Number(u.searchParams.get('at') ?? Date.now());
      // the rewound hero asks the ten minutes before its moment (useDepthHistoryAt); the executable line asks a window of days
      if (u.searchParams.has('from') && Number(u.searchParams.get('to')) - Number(u.searchParams.get('from')) > HOUR) return json(historyWindow(Number(u.searchParams.get('from')), Math.min(now, Number(u.searchParams.get('to') ?? now)), (u.searchParams.get('step') ?? '1m') as '1m' | '1h', now));
      return json(historyOf(now));
    }
    if (u.pathname === '/api/depth/heat') return json(heatOf(Number(u.searchParams.get('days') ?? 7), Number(u.searchParams.get('at') ?? Date.now())));
    if (u.pathname === '/api/depth/owners') return json({ ...OWNERS, at: Date.now() - 20 * MIN });
    if (u.pathname === '/api/depth/changes') {
      const rows = changesOf(Date.now());
      return json({ pool: null, rows, next: null, limit: 200, prov: [{ what: `depth_changes rows: ${rows.length}`, url: null, table: 'depth_changes', key: { before: Date.now(), limit: 200 }, at: rows[0].ts, height: rows[0].height, bytes: 1, status: 'stored' }] });
    }
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
    // what sticks out past the viewport, for the failure message
    const vw = window.visualViewport?.width ?? window.innerWidth;
    const over = (el: Element) => el.getBoundingClientRect().right > vw + 1;
    const wide = [...document.querySelectorAll('body *')].filter((el) => visible(el) && over(el) && ![...el.children].some(over)).slice(0, 12).map((el) => `${el.tagName.toLowerCase()}.${String(el.getAttribute('class') ?? '').slice(0, 40)} ${Math.round(el.getBoundingClientRect().left)}-${Math.round(el.getBoundingClientRect().right)} "${(el.textContent ?? '').trim().slice(0, 30)}"`);
    return {
      wide,
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
/** A pointer swept across a plot: the readout above it reads every point passed (the longest text seen is returned), and the
 *  plot's top is recorded before the sweep, at every point and once the pointer has left, so a readout that changed height
 *  would show as a second top; every text read is returned too, the readout's heights for the message, and `clipped` says whether a one-line
 *  row of the readout (.readout__d, the curve's pools) was ever wider than its box. The plot is scrolled into view first;
 *  nothing else scrolls during the sweep. */
async function sweep(page: Page, plotSel: string, readoutSel: string) {
  const plot = page.locator(plotSel).first();
  await plot.scrollIntoViewIfNeeded();
  await page.mouse.move(2, 2);
  // the page scrolls smoothly: wait until the plot stands still before reading its top
  let box = (await plot.boundingBox())!;
  for (let k = 0; k < 40; k++) { await page.waitForTimeout(50); const b = (await plot.boundingBox())!; if (b.y === box.y) break; box = b; }
  const top0 = box.y;
  const tops = new Set<number>();
  const heights = new Set<number>();
  let read = '';
  const reads = new Set<string>();
  let clipped = false;
  for (let k = 0; k <= 16; k++) {
    await page.mouse.move(box.x + 52 + ((box.width - 64) * k) / 16, box.y + box.height / 2);
    tops.add((await plot.boundingBox())!.y);
    heights.add((await page.locator(readoutSel).first().boundingBox())!.height);
    const t = ((await page.locator(readoutSel).first().textContent()) ?? '').replace(/\s+/g, ' ').trim();
    if (t.length > read.length) read = t;
    reads.add(t);
    if (await page.locator(`${readoutSel} .readout__d`).evaluateAll((els) => els.some((e) => e.scrollWidth > e.clientWidth))) clipped = true;
  }
  await page.mouse.move(2, 2);
  tops.add((await plot.boundingBox())!.y);
  return { top0, tops: [...tops], heights: [...heights], read, reads: [...reads], clipped };
}

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
/** How many lines the visible elements' text takes, read from the text's own boxes (a 44 px control holds two 18 px lines, so its height cannot say). */
const textLines = (loc: Locator) => loc.evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent != null).map((e) => {
  const r = document.createRange();
  r.selectNodeContents(e);
  const tops = new Set([...r.getClientRects()].filter((b) => b.width > 0.5).map((b) => Math.round(b.top)));
  // boxes on one line can differ in top by a pixel or two (a bold run, a code font): count tops more than 4 px apart
  const lines = [...tops].sort((a, b) => a - b).filter((t, i, all) => i === 0 || t - all[i - 1] > 4).length;
  return { t: (e.textContent ?? '').trim().slice(0, 48), n: lines };
}));
/** Under 1024 px the evidence bands show one at a time: pick one on the strip (from 1024 px every band shows and the strip is hidden). */
const band = async (page: Page, name: 'The book' | 'Over time' | 'Who holds it') => {
  if ((page.viewportSize()?.width ?? 0) < 1024) await page.locator('.dp-strip').getByRole('radio', { name }).click();
};

describe.skipIf(!ready)('the depth page, built, on the fixtures (375, 320 and 1280 wide)', () => {
  for (const [w, h] of [[375, 812], [320, 700], [1280, 800]] as const) {
    it(`${w} x ${h}: one h1, the hero from the stored minute, no sideways scroll, no text under 11 px, 44 px controls, ladder rows at least 40 px`, async () => {
      const { page, ctx, errors } = await open(w, h);
      try {
        await settled(page);
        await count(page.locator('.dp-rows .dp-lrow--ref')).toBe(1);
        const a = await audit(page);
        expect(a.h1).toEqual([ROUTE.h1]);
        expect(a.overflowX, `scrollWidth ${a.scrollWidth} > ${a.innerWidth}: ${a.wide.join(' | ')}`).toBe(false);
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
          // the ladder column is under 720 px at 1280 (five twelfths of the page), so its rows are the narrow one-line rows there too
          const col = (await page.locator('.dp-book__a').boundingBox())!;
          expect(col.width).toBeLessThan(720);
          await expect.poll(() => page.locator('.dp-rows .dp-lrow .dp-chip').evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent != null).length), { timeout: T }).toBe(0);
          await seen(page.locator('.dp-ladder__shared'));
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
      // the phone ladder: no pool chips on the rows, a chevron on each, the shared pools named once above the rows, and every unmarked near row one line
      await expect.poll(() => page.locator('.dp-rows .dp-lrow .dp-chip').evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent != null).length), { timeout: T }).toBe(0);
      await seen(page.locator('.dp-lrow--ask .dp-lrow__chev'));
      await text(page.locator('.dp-ladder__shared')).toMatch(/^pool 3005(, pool \d+){0,2}( and (pool \d+|\d+ more))? rest in every level near the price; tap a level for all of its pools\.$/);
      const nearHeights = await page.locator('.dp-rows .dp-lrow--ask:not(.is-mark), .dp-rows .dp-lrow--bid:not(.is-mark)').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
      expect(nearHeights.length).toBeGreaterThan(5);
      expect(Math.max(...nearHeights), `row heights ${nearHeights.join(', ')}`).toBeLessThanOrEqual(48);
      // a one-line row's text is centred in it: the band's top is half the slack, within a pixel
      const centred = await page.locator('.dp-rows .dp-lrow--ask:not(.is-mark)').first().evaluate((e) => { const r = e.getBoundingClientRect(); const b = e.querySelector('.dp-lrow__band')!.getBoundingClientRect(); return { row: r.height, top: b.top - r.top, band: b.height }; });
      expect(Math.abs(centred.top - (centred.row - centred.band) / 2), `band at ${centred.top} in a ${centred.row} row`).toBeLessThanOrEqual(1);
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
      await count(page.locator('.dp-rows .dp-fold')).toBe(0);
      await seen(page.locator('.dp-ladder[data-view="table"]'));
      // no figure runs out of its cell in the table view, where every band is unfolded and the far rows' distances are long
      const spilt = await page.locator('.dp-rows .dp-lrow__cum, .dp-rows .dp-lrow__dist, .dp-rows .dp-lrow__rest').evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => `${e.className}: ${e.textContent}`));
      expect(spilt).toEqual([]);
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
      await page.locator('.dp-curve').getByRole('button', { name: 'Table view' }).click();
      await count(page.locator('.dp-curve .dp-table .dp-trow')).toBeGreaterThan(1);
    } finally {
      await ctx.close();
    }
  }, 60_000);

  for (const [w, h] of [[375, 812], [320, 700], [640, 900], [1280, 800]] as const) {
    it(`${w} x ${h}: a pointer over the curve, the heat and the executable line reads each into its readout, no plot moves under the pointer and the pools line is whole, at a 16 px and a 20 px root font`, async () => {
      const { page, ctx } = await open(w, h);
      try {
        await settled(page);
        if (w < 1024) await page.getByRole('radio', { name: 'Curve' }).click();
        await seen(page.locator('.dp-chart__plot svg'));
        const over = page.locator('.dp-over');
        await band(page, 'Over time');
        await seen(over.locator('.dph-plot canvas'));
        await seen(over.locator('.dp-exec__plot svg'));
        for (const root of [16, 20]) {
          if (root !== 16) await page.addStyleTag({ content: `html { font-size: ${root}px }` });
          const at = `at a ${root} px root`;
          await band(page, 'The book');
          await seen(page.locator('.dp-chart__plot svg'));
          const curve = await sweep(page, '.dp-chart__plot', '.dp-chart .readout');
          expect(curve.read, at).toMatch(/selling|buying/);
          // the pools line after the words, with a space between: at least one named, at most three, the rest counted, and never wider than its box
          expect(curve.read, at).toMatch(/ here (pool|order book) \d+(, (pool|order book) \d+){0,2}( and \d+ more)?$/);
          expect(curve.clipped, `the pools line unclipped ${at}`).toBe(false);
          expect(curve.tops, `the curve plot held its top ${at} (readout heights ${curve.heights.join(', ')})`).toEqual([curve.top0]);
          await band(page, 'Over time');
          await seen(over.locator('.dph-plot canvas'));
          const heat = await sweep(page, '.dph-plot', '.dph .readout');
          expect(heat.read, at).toMatch(/UTC: /);
          expect(heat.tops, `the heat plot held its top ${at} (readout heights ${heat.heights.join(', ')})`).toEqual([heat.top0]);
          const exec = await sweep(page, '.dp-exec__plot', '.dp-exec .readout');
          expect(exec.reads.some((t) => t.startsWith(`${EXEC_READING} `)), `a minute read ${at}: ${exec.reads.join(' | ')}`).toBe(true);
          expect(exec.tops, `the executable line held its top ${at} (readout heights ${exec.heights.join(', ')})`).toEqual([exec.top0]);
        }
      } finally {
        await ctx.close();
      }
    }, 90_000);
  }

  it('820 wide (a tablet; the desktop split keeps its ladder column under 720 px at any width): the ladder is 720 px or wider, so the rows carry their pool chips in their own column and the shared-pools sentence goes', async () => {
    const { page, ctx } = await open(820, 1100);
    try {
      await settled(page);
      await seen(page.locator('.dp-tabs'));
      const col = (await page.locator('.dp-book__a').boundingBox())!;
      expect(col.width).toBeGreaterThanOrEqual(720);
      await expect.poll(() => page.locator('.dp-rows .dp-lrow .dp-chip').evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent != null).length), { timeout: T }).toBeGreaterThan(20);
      await hidden(page.locator('.dp-ladder__shared'));
      await hidden(page.locator('.dp-lrow__chev'));
      await count(page.locator('.dp-rows .dp-lrow--ref')).toBe(1);
      const ref = (await page.locator('.dp-lrow--ref').boundingBox())!;
      expect(ref.width).toBeGreaterThan(col.width - 40);
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
      await text(page.locator('.dp-who')).toContain(OWNERS_REWIND);
      await band(page, 'Over time');
      await seen(page.locator('.dph-plot canvas'));
      await count(page.locator('.dp-cost')).toBe(0);
      expect(errors).toEqual([]);
      const a = await audit(page);
      for (const re of [BANNED]) expect(a.text).not.toMatch(re);
    } finally {
      await ctx.close();
    }
  }, 60_000);

  for (const [w, h] of [[375, 812], [1280, 800]] as const) {
    it(`${w} wide, over time: a blank column and a broken hairline at the outage, never one path; the paint of a week under 200 ms; the legend's five steps and the blank floor; the honest start; the executable line broken; the change rows with their owners; the cost line and what was left out`, async () => {
      const { page, ctx, errors } = await open(w, h);
      try {
        await settled(page);
        await band(page, 'Over time');
        const over = page.locator('.dp-over');
        await seen(over.locator('.dph-plot canvas'));
        // the phone opens on the day drawn in five-minute columns; the desktop on the week; the five-minute rule is said once (the count and the how), never a third time
        await text(over.locator('.dp-over__cols')).toContain('one column per five minutes');
        await text(over.locator('.dp-over__cols')).not.toContain('narrow screen');
        await text(over.locator('.dp-over__cols')).toMatch(/\d+ blank/);
        // the hairline is more than one path: broken at the outage (and at the failed minute)
        await count(over.locator('.dph-plot svg .dph-ref')).toBeGreaterThanOrEqual(2);
        // the legend: five swatches of the ramp, the blank floor, the reference line, the sized trades, the blank column
        await count(over.locator('.dph-key .dph-sw')).toBe(7);
        await text(over.locator('.dph-key')).toMatch(/under \$[\d.,]+: blank/);
        await text(over.locator('.dph-key')).toContain('and above');
        await text(over.locator('.dph-key')).toContain('sized by its NAM');
        await count(over.locator('.dph-plot svg .dph-trade')).toBeGreaterThanOrEqual(1);
        // the honest start names the first recording (the answer's recordedSince, a day before the minute rows' own start here), never the minute rows' edge
        await text(over.locator('.dp-over__start')).toMatch(/^Depth has been recorded since \d+ \w+ \d{4}, \d\d:\d\d UTC; nothing on the chain gives earlier depth\.$/);
        await text(over.locator('.dp-over__start')).toBe(recordedSince(fmtUtcLong(recordedFrom(Date.now()))).replace(/\s+/g, ' '));
        // the executable line over the day: at least two runs (the outage is a gap at every width), its title from the stored minutes, the hour band, and the window's gaps said in words under it
        await over.getByRole('radio', { name: '24 h' }).click();
        await expect.poll(() => over.locator('.dp-over__cols').textContent().then((t) => /one column per (minute|five minutes), (1440|288) of them/.test(t ?? '')), { timeout: T }).toBe(true);
        // the phone's day is drawn in fives and says so once, never "per stored minute" beside "five-minute columns"; the desktop's says minutes
        if (w < 1024) {
          await text(over.locator('.dp-over__cols')).toContain(HEAT_HOW['5m']);
          await text(over.locator('.dp-over__cols')).not.toContain(HEAT_HOW['1m']);
        } else {
          await text(over.locator('.dp-over__cols')).toContain(HEAT_HOW['1m']);
        }
        await count(over.locator('.dp-exec svg .dp-exec__line')).toBeGreaterThanOrEqual(2);
        await text(over.locator('.dp-exec .chartsec__title')).toContain('Selling 10,000 NAM fetched $');
        await count(over.locator('.dp-exec svg .dp-exec__band')).toBeGreaterThanOrEqual(1);
        await text(over.locator('.dp-exec__gaps')).toMatch(/^1 stretch of this window has no stored row and is drawn blank; the longest, 20 min, began \d+ \w+, \d\d:\d\d UTC$/);
        // the week: the paint measured by the chart itself, under 200 ms of main-thread time; the twenty-minute outage still breaks the line (a bucket is about an hour at 375 px)
        await over.getByRole('radio', { name: '7 d' }).click();
        await expect.poll(() => over.locator('.dp-over__cols').textContent().then((t) => /2,?016 of them|20[01]\d of them/.test(t ?? '')), { timeout: T }).toBe(true);
        const paints = await page.evaluate(() => performance.getEntriesByName('depth-heat-paint').map((e) => e.duration));
        expect(paints.length).toBeGreaterThan(0);
        expect(Math.max(...paints), `paint ms ${paints.map((x) => x.toFixed(1)).join(', ')}`).toBeLessThan(200);
        await count(over.locator('.dph-plot svg .dph-ref')).toBeGreaterThanOrEqual(2);
        await count(over.locator('.dp-exec svg .dp-exec__line')).toBeGreaterThanOrEqual(2);
        await text(over.locator('.dp-exec__gaps')).toContain('1 stretch of this window has no stored row');
        // the keyboard readout: a band at a time, and the blank column named
        await over.locator('.dph-plot').focus();
        await page.keyboard.press('ArrowLeft');
        await text(over.locator('.dph .readout')).toMatch(/UTC: /);
        // the table view says how many of the week's columns it lists (sixty of 2,016, one in 34) and names the blank column
        await over.getByRole('button', { name: 'Table view' }).click();
        await count(over.locator('.dph-table .dph-trow')).toBeGreaterThan(10);
        await count(over.locator('.dph-table .dph-trow:not(.dp-trow--head)')).toBeLessThanOrEqual(61);
        await text(over.locator('.dph-table__note')).toMatch(/^\d+ of 2,?016 columns listed, one in \d+, and the last$/);
        await text(over.locator('.dph-table')).toContain('Reference price');
        await over.getByRole('button', { name: 'Chart view' }).click();
        // the month from the hourly rows: the line from the hours, the band the hours' own, no gap listed by the hourly answer here
        await over.getByRole('radio', { name: '30 d' }).click();
        await expect.poll(() => over.locator('.dp-over__cols').textContent().then((t) => (t ?? '').includes('one column per hour')), { timeout: T }).toBe(true);
        await count(over.locator('.dp-exec svg .dp-exec__band')).toBeGreaterThanOrEqual(1);
        await text(over.locator('.dp-exec__gaps')).toBe(GAPS_NONE);
        // the table names each hourly column by its own stored hour (a whole hour), never by its slot’s start (the window ends at whatever millisecond the page asked; the fixtures hold three days of hours, so a few rows of the sixty)
        await over.getByRole('button', { name: 'Table view' }).click();
        await expect.poll(() => over.locator('.dph-table .dph-trow:not(.dp-trow--head):not(.dph-trow--gap) [role=cell]:first-child').allTextContents(), { timeout: T }).toSatisfy((ts: string[]) => ts.length >= 5 && ts.every((t) => /:00\s?UTC$/.test(t.trim())));
        expect(Date.now() % HOUR).not.toBe(0);
        await over.getByRole('button', { name: 'Chart view' }).click();
        // the change rows, worded, the owner as the address control
        await count(over.locator('.dp-changes__list li')).toBe(4);
        await text(over.locator('.dp-changes__list')).toContain('withdrawn from pool 3005 by');
        await text(over.locator('.dp-changes__list')).toContain('order');
        await text(over.locator('.dp-changes__list')).toContain('the pool’s reserves grew in pool 3439');
        await count(over.locator('.dp-changes__list .xaddr')).toBe(3);
        // the cost line from the minute's own cost, and what was left out
        await text(over.locator('.dp-cost')).toMatch(/\d+ requests, [\d.]+ KB read, [\d.]+ (ms|s) of reading/);
        await text(over.locator('.dp-leftout')).toContain('pool 3020');
        await text(over.locator('.dp-leftout')).toContain('The Namada side');
        await count(over.locator('.srcb')).toBeGreaterThanOrEqual(2);
        expect(errors).toEqual([]);
      } finally {
        await ctx.close();
      }
    }, 90_000);

    it(`${w} wide, who holds it: the owners sorted by share with the address control, pool chips, the coins and USD resting, what is held and since when; a disclosure listing each item; replaced this week from the change rows; the hour's checks`, async () => {
      const { page, ctx, errors } = await open(w, h);
      try {
        await settled(page);
        await band(page, 'Who holds it');
        const who = page.locator('.dp-who');
        await count(who.locator('details.dp-orow')).toBe(OWNERS.owners.length);
        await text(who.locator('.dp-who__totals')).toContain(`${OWNERS.owners.length} owners`);
        // sorted by share: the first row holds the largest share, and the rows never rise
        const shares = await who.locator('.dp-orow__share').allTextContents();
        const nums = shares.map((t) => parseFloat(t.replace(/[^\d.]/g, '')));
        for (let i = 1; i < nums.length; i++) expect(nums[i]).toBeLessThanOrEqual(nums[i - 1] + 1e-9);
        const first = who.locator('details.dp-orow').first();
        await text(first.locator('.dp-orow__pools')).toContain('order book 3008');
        await text(first.locator('.dp-orow__holds')).toMatch(/\d+ orders/);
        await text(first.locator('.dp-orow__nam')).toContain('NAM');
        await text(first.locator('.dp-orow__usd')).toMatch(/^\$/);
        await text(first.locator('.dp-orow__since')).toMatch(/\d{4}/);
        // the owner whose order was pulled and placed again carries the count
        await count(who.locator('.dp-orow__rep', { hasText: 'replaced 1 time this week' })).toBe(1);
        // the disclosure lists each order's price and what is left of it
        await first.locator('summary').click();
        await seen(first.locator('.dp-orow__items li'));
        await count(first.locator('.dp-orow__items li')).toBe(OWNERS.owners[0].items.length);
        await text(first.locator('.dp-orow__items li').first()).toMatch(/order \d+ at [\d.]+: [\d,.]+ of [\d,.]+ (NAM|USD) left/);
        // a position owner's item names its range and that it holds the price
        const posRow = who.locator('details.dp-orow', { hasText: '1 position' }).first();
        await posRow.locator('summary').click();
        await text(posRow.locator('.dp-orow__items')).toContain('position ');
        // the address control opens the address sheet, as the holders list does
        await first.locator('.xaddr').first().click();
        await seen(page.locator('dialog[open]'));
        await page.keyboard.press('Escape');
        // the hour's own checks, each with its word
        await text(who.locator('.dp-inv')).toContain('holds: the positions in range add up to the pool’s current liquidity');
        await seen(who.locator('.srcb'));
        expect(errors).toEqual([]);
      } finally {
        await ctx.close();
      }
    }, 90_000);
  }


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

describe.skipIf(!ready)('the depth page on a phone: the evidence bands one at a time (the phone cut, owner 2026-10-30)', () => {
  const BANDS = ['.dp-bookband', '.dp-overband', '.dp-whoband'] as const;
  const shownBands = (page: Page) => page.evaluate((sels) => sels.filter((s) => { const e = document.querySelector(s); return !!e && e.getBoundingClientRect().height > 0; }), [...BANDS]);
  const screens = (page: Page) => page.evaluate(() => document.documentElement.scrollHeight / window.innerHeight);

  it('375 x 667: the hero’s figure in money is on the first screen above the tab bar, the lead is one line, and the amount field is a cell of the chip row', async () => {
    const { page, ctx, errors } = await open(375, 667);
    try {
      await settled(page);
      const m = await page.evaluate(() => {
        const r = (s: string) => document.querySelector(s)!.getBoundingClientRect();
        const bar = document.querySelector('.tabbar');
        const lead = document.querySelector('.dp-ticket .sub .dp-short')!;
        return { hero: r('.dp-get .hero-n__v'), barTop: bar && bar.getBoundingClientRect().height ? bar.getBoundingClientRect().top : window.innerHeight, scrollY: window.scrollY, leadH: lead.getBoundingClientRect().height, leadLh: parseFloat(getComputedStyle(lead.parentElement!).lineHeight), field: r('.dp-sizes .field__box'), chips: [...document.querySelectorAll('.dp-sizes .pre')].map((e) => e.getBoundingClientRect().top) };
      });
      expect(m.scrollY).toBe(0);
      expect(m.hero.bottom, `the hero ends at ${m.hero.bottom}, the tab bar starts at ${m.barTop}`).toBeLessThanOrEqual(m.barTop);
      expect(m.leadH).toBeLessThanOrEqual(m.leadLh * 1.5);
      await text(page.locator('.dp-ticket .sub .dp-short')).toBe(depthLeadShort('NAM'));
      await hidden(page.locator('.dp-ticket .sub .dp-long'));
      // the field sits on the row of the last chip, not under the chips
      expect(m.chips.some((t) => Math.abs(t - m.field.top) <= 2), `chips at ${m.chips.join(', ')}, the field at ${m.field.top}`).toBe(true);
      expect(Math.round(m.field.height)).toBeGreaterThanOrEqual(44);
      // the chip group keeps its role and the field its name
      await count(page.getByRole('radiogroup', { name: 'Size' })).toBe(1);
      await count(page.getByRole('textbox', { name: 'Amount' })).toBe(1);
      // a typed size shows "asking for this size" under the field while the quote is on its way, and the hero does not move
      await page.route('**/api/depth/quote**', async (route) => { await new Promise((r) => setTimeout(r, 1500)); await route.fallback(); });
      const top0 = (await page.locator('.dp-get .hero-n__v').boundingBox())!.y;
      await page.locator('.dp-sizes .field__in').fill('7300');
      await seen(page.locator('.dp-sizes .field__state'));
      expect((await page.locator('.dp-get .hero-n__v').boundingBox())!.y).toBe(top0);
      await hidden(page.locator('.dp-sizes .field__state'), 10_000);
      expect((await page.locator('.dp-get .hero-n__v').boundingBox())!.y).toBe(top0);
      expect(errors).toEqual([]);
    } finally {
      await ctx.close();
    }
  }, 60_000);

  it('375 x 667: the page is about five to seven screens with each band (about 21 on the same fixtures before the cut), and the strip shows exactly one evidence band', async () => {
    const { page, ctx, errors } = await open(375, 667);
    try {
      await settled(page);
      await seen(page.locator('.dp-strip'));
      // the strip is a real control: three radios with the bands' names, each at least 44 px
      const radios = page.locator('.dp-strip').getByRole('radio');
      await count(radios).toBe(3);
      const opts = await page.locator('.dp-strip .seg__opt').evaluateAll((els) => els.map((e) => ({ t: (e.textContent ?? '').trim(), h: e.getBoundingClientRect().height, w: e.getBoundingClientRect().width })));
      expect(opts.map((o) => o.t)).toEqual(['The book', 'Over time', 'Who holds it']);
      for (const o of opts) expect(Math.min(o.h, o.w), o.t).toBeGreaterThanOrEqual(44);
      await count(page.getByRole('radiogroup', { name: 'Band to show' })).toBe(1);
      const measured: Record<string, number> = {};
      for (const [name, sel] of [['The book', '.dp-bookband'], ['Over time', '.dp-overband'], ['Who holds it', '.dp-whoband']] as const) {
        await band(page, name);
        await expect.poll(() => shownBands(page), { timeout: T }).toEqual([sel]);
        await page.waitForTimeout(300);
        measured[name] = await screens(page);
      }
      // measured on the fixtures on 2026-10-30: the book 6.3, over time 7.0, who holds it 5.6 screens of 667 px
      expect(measured['The book'], JSON.stringify(measured)).toBeLessThanOrEqual(6.5);
      expect(measured['Over time'], JSON.stringify(measured)).toBeLessThanOrEqual(7.5);
      expect(measured['Who holds it'], JSON.stringify(measured)).toBeLessThanOrEqual(6.5);
      // every band stays a labelled section in the DOM, its heading present even while another band shows
      for (const sel of BANDS) {
        const name = await page.locator(sel).evaluate((e) => document.getElementById(e.getAttribute('aria-labelledby') ?? '')?.textContent?.trim() ?? '');
        expect(name.length, sel).toBeGreaterThan(3);
      }
      expect(errors).toEqual([]);
    } finally {
      await ctx.close();
    }
  }, 60_000);

  it('1280 x 800: as before the cut: every band shows, no strip, the full leads and fold words, the cost and left-out lines open, every owner listed', async () => {
    const { page, ctx, errors } = await open(1280, 800);
    try {
      await settled(page);
      await hidden(page.locator('.dp-strip'));
      await expect.poll(() => shownBands(page), { timeout: T }).toEqual([...BANDS]);
      await expect.poll(() => page.locator('.depth .dp-short').evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent != null).length), { timeout: T }).toBe(0);
      await seen(page.locator('.dp-ticket .sub .dp-long'));
      await seen(page.locator('.dp-fold .dp-long'));
      await seen(page.locator('.dp-sizes .field__l'));
      await hidden(page.locator('.dp-cost__fold'));
      await seen(page.locator('.dp-cost__body .dp-leftout'));
      await hidden(page.locator('.dp-who__fold'));
      await expect.poll(() => page.locator('details.dp-orow').evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent != null).length), { timeout: T }).toBe(OWNERS.owners.length);
      await seen(page.locator('.dp-band__eyebrow'));
      expect(errors).toEqual([]);
    } finally {
      await ctx.close();
    }
  }, 60_000);

  it('375 wide: the cost and left-out lines are one line with a disclosure, the left-out pools grouped by reason with a count each', async () => {
    const { page, ctx } = await open(375, 812);
    try {
      await settled(page);
      await band(page, 'Over time');
      const fold = page.locator('.dp-cost__fold');
      await seen(fold);
      await text(fold).toBe(`▸${OPS_FOLD}`);
      expect((await textLines(fold)).map((l) => l.n)).toEqual([1]);
      expect(await fold.getAttribute('aria-expanded')).toBe('false');
      await hidden(page.locator('.dp-cost__body'));
      await fold.click();
      await seen(page.locator('.dp-cost__body .dp-leftout'));
      expect(await fold.getAttribute('aria-expanded')).toBe('true');
      // the reasons as the minute lists them, each once with its count: the fixture's thirteen pools are three reasons
      const by = new Map<string, number>();
      for (const u of LATEST.unpriced as { why: string }[]) by.set(u.why, (by.get(u.why) ?? 0) + 1);
      const items = await page.locator('.dp-leftout li').allTextContents();
      expect(items.length).toBe(by.size + 1);
      for (const [why, n] of by) expect(items.filter((t) => t.startsWith(n === 1 ? `1 pool: ${why}: ` : `${n} pools, each: ${why}: `)).length, why).toBe(1);
      expect(items).toContain(leftOutGroup(1, LATEST.unpriced[0].why, 'pool 3020 (NAM / UM)'));
      expect(items.join(' ')).not.toContain('NAM / nothing');
      // a raw denomination is never shown
      expect(items.join(' ')).not.toMatch(/ibc\/|factory\//);
      await text(page.locator('.dp-cost__body')).toMatch(/\d+ requests, [\d.]+ KB read/);
      await seen(page.locator('.dp-cost__body .srcb'));
    } finally {
      await ctx.close();
    }
  }, 60_000);

  it('375 wide: who holds it shows the totals and the five largest owners, then a fold naming how many more it holds', async () => {
    const { page, ctx } = await open(375, 812);
    try {
      await settled(page);
      await band(page, 'Who holds it');
      const visibleRows = () => page.locator('details.dp-orow').evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent != null).length);
      await seen(page.locator('.dp-who__totals'));
      await expect.poll(visibleRows, { timeout: T }).toBe(5);
      await count(page.locator('details.dp-orow')).toBe(OWNERS.owners.length);
      const fold = page.locator('.dp-who__fold');
      await text(fold).toBe(`▸${whoMore(OWNERS.owners.length - 5)}`);
      expect((await textLines(fold)).map((l) => l.n)).toEqual([1]);
      await fold.click();
      await expect.poll(visibleRows, { timeout: T }).toBe(OWNERS.owners.length);
      await text(fold).toBe(`▾${whoFewer(5)}`);
      expect(await fold.getAttribute('aria-expanded')).toBe('true');
    } finally {
      await ctx.close();
    }
  }, 60_000);

  for (const [w, h] of [[375, 812], [320, 700]] as const) {
    it(`${w} x ${h}: the new parts with every band shown and every new fold open: no text under 11 px, no control under 44 px, no sideways scroll; the leads, the folds and the strip one line; the reference row two lines`, async () => {
      const { page, ctx, errors } = await open(w, h);
      try {
        await settled(page);
        for (const name of ['The book', 'Over time', 'Who holds it'] as const) {
          await band(page, name);
          if (name === 'Over time') await page.locator('.dp-cost__fold').click();
          if (name === 'Who holds it') await page.locator('.dp-who__fold').click();
          await page.waitForTimeout(300);
          const a = await audit(page);
          expect(a.overflowX, `${name}: ${a.wide.join(' | ')}`).toBe(false);
          expect(a.smallText, name).toEqual([]);
          expect(a.smallTargets, name).toEqual([]);
          // the folds stay one line of text
          const folds = await textLines(page.locator('.dp-fold'));
          expect(folds.length, name).toBeGreaterThan(0);
          for (const f of folds) expect(f.n, f.t).toBe(1);
          if (w === 375) {
            const leads = await textLines(page.locator('.dp-lead .dp-short'));
            if (name !== 'Over time') expect(leads.length, name).toBeGreaterThan(0);
            for (const l of leads) expect(l.n, l.t).toBe(1);
          }
        }
        await band(page, 'The book');
        const strip = await textLines(page.locator('.dp-strip .seg__opt > span'));
        expect(strip.length).toBe(3);
        for (const o of strip) expect(o.n, o.t).toBe(1);
        // the reference row: two lines at 375 (the price with the crossing or the spread, then the touch after fees), at most three at 320
        const ref = await textLines(page.locator('.dp-lrow--ref .dp-short'));
        expect(ref.length).toBe(1);
        expect(ref[0].n, ref[0].t).toBeLessThanOrEqual(w === 375 ? 2 : 3);
        await text(page.locator('.dp-lrow--ref .dp-short')).toMatch(/^Pool 3005 price [\d.]+ · (crossed [\d.]+%|spread [−+]?[\d.]+%)100 NAM after fees: bid [\d.]+, ask [\d.]+$/);
        // the curve's lead, on its tab
        if (w === 375) {
          await page.getByRole('radio', { name: 'Curve' }).click();
          const curve = await textLines(page.locator('.dp-curve .dp-lead .dp-short'));
          expect(curve.map((l) => l.n)).toEqual([1]);
        }
        expect(errors).toEqual([]);
      } finally {
        await ctx.close();
      }
    }, 90_000);
  }
});
