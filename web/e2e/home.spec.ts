// Home (S1): the route's own checks (build-plan 8, "Per-screen acceptance", Home row) on top of the
// shell's. Layout checks run in every project of the G6 matrix; the data and behaviour checks run once
// (375x812), against production data through the dev proxy, so they assert relations between what the
// API sends and what the page shows rather than fixed numbers.
import fs from 'node:fs';
import type { Check, Holder, QuoteCurveResponse } from '../../shared/types';
import { BODY } from '../../shared/copy';
import { ROUTES } from '../../shared/routes';
import { PROOF } from '../src/generated/proof';
import { REWIND_AT, animationsIn, apiUrls, expect, gotoRoute, isExempt, isLiveOnly, layoutAudit, onlyIn, test, trackRequests } from './helpers';

const HOME = ROUTES.find((r) => r.id === 'home')!;
/** The rewind example on the page: the first alert before the largest move out of the staking account (scripts/export-proof.ts). */
const EXAMPLE_AT = PROOF.rewindExample?.rewindAt ?? REWIND_AT;
/** The dated design snapshot (17 Oct 2026 11:24 UTC): a full size table to answer /api/quote/curve with. */
const SNAP = JSON.parse(fs.readFileSync(new URL('../../docs/design/data/snapshot.json', import.meta.url), 'utf8'));
const BUSY = 'The Osmosis quote service is busy right now.';
/** The size table as the worker sends it when the quote service has no price: no sizes, no data. */
const EMPTY_CURVE = { ...SNAP.curve, curve: [], maxSafeClip1PctNam: null, maxSafeClip3PctNam: null, prov: { source: 'Osmosis SQS', at: null, status: 'missing', note: BUSY } };

/** Ten holder rows whose spendable balances were all read `readAgo` ms ago, none changed over 7 days. */
function holdersRead(readAgo: number) {
  const at = Date.now() - readAgo;
  const holders: Holder[] = Array.from({ length: 10 }, (_, i) => ({
    rank: i + 1, chain: 'namada', address: `tnam1qtest${String(i).padStart(2, '0')}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`, balance: 1_000_000 - i * 10_000, bonded: 0, bondedEstimated: null, bondedVerifiedAt: at,
    total: 1_000_000 - i * 10_000, pctSupply: 0.1, change24h: 0, change7d: 0, label: null, category: null, linked: [], updatedAt: at, verifiedAt: at,
    status: readAgo > 6 * 3_600_000 ? 'stale' : 'live', statusNote: null,
  }));
  return { total: 10, page: 1, limit: 10, holders };
}

/** Wait until the figures the layout depends on have arrived (skeletons replaced). */
async function loaded(page: import('@playwright/test').Page) {
  await expect(page.locator('.home .hero .hero-n__v [data-num]')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.home .hrow').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.home .tp, .home .tape__none, .home .tape .home-none').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.home .lg, .home .sec .home-none').first()).toBeVisible({ timeout: 30_000 });
}

test.describe('Home layout, every viewport', () => {
  test('one h1 equal to RouteDef.h1; no overflow, no <table>, 44 px targets, text at least 11 px', async ({ page }) => {
    await gotoRoute(page, '/');
    await loaded(page);
    const a = await layoutAudit(page, 'main');
    expect(a.h1).toEqual([HOME.h1]);
    expect(a.overflowX, `scrollWidth ${a.scrollWidth} > ${a.innerWidth}`).toBe(false);
    expect(a.tables).toBe(0);
    expect(a.smallText).toEqual([]);
    expect(a.smallTargets).toEqual([]);
  });

  test('rewound: banner, the same h1, no overflow, no small targets', async ({ page }) => {
    await gotoRoute(page, `/?at=${EXAMPLE_AT}`);
    await expect(page.locator('.rwb')).toBeVisible();
    await expect(page.locator('.home .hero .hero-n__v [data-num]')).toBeVisible({ timeout: 30_000 });
    const a = await layoutAudit(page, 'main');
    expect(a.h1).toEqual([HOME.h1]);
    expect(a.overflowX).toBe(false);
    expect(a.tables).toBe(0);
    expect(a.smallTargets).toEqual([]);
    expect(a.smallText).toEqual([]);
  });
});

test.describe('Home, once', () => {
  test.beforeEach(({}, info) => test.skip(onlyIn(info.project.name), 'viewport-independent: runs in 375x812'));

  test('first screen at 375 x 812: H1, price, 24 h pill, chip, primary action, fact strip and the ruler edge', async ({ page }) => {
    await gotoRoute(page, '/');
    await loaded(page);
    const tabbar = (await page.locator('nav.tabbar').boundingBox())?.y ?? 812;
    for (const sel of ['main h1', '.home .hero .hero-n__v', '.home .hero .delta', '.home .hero .chip', '.home .hero .btn--primary', '.home .hero .facts', '.home .hero .ruler']) {
      const box = await page.locator(sel).first().boundingBox();
      expect(box, sel).not.toBeNull();
      expect(box!.y + box!.height, `${sel} ends above the tab bar`).toBeLessThanOrEqual(tabbar + 1);
    }
  });

  test('the route copy (BODY.home) is visible text', async ({ page }) => {
    await gotoRoute(page, '/');
    for (const para of BODY.home.paras) await expect(page.locator('main').getByText(para, { exact: true })).toBeVisible();
  });

  test('provenance rationing: at most two ProvChips; every panel has a SourceLine', async ({ page }) => {
    await gotoRoute(page, '/');
    await loaded(page);
    await page.waitForTimeout(1500);
    expect(await page.locator('main .chip').count()).toBeLessThanOrEqual(2);
    for (const sec of ['#home-changed', '#home-where', '#home-who', '#home-trust']) {
      await expect(page.locator(`section:has(> ${sec}) .srcb`).first(), sec).toBeVisible();
    }
  });

  test('N1: every visible figure has its own provenance control or sits in a scope with a visible SourceLine', async ({ page }) => {
    await gotoRoute(page, '/');
    await loaded(page);
    await page.waitForTimeout(1500);
    const orphans = await page.evaluate(() => {
      const seen = (el: Element | null | undefined) => !!el && el.getBoundingClientRect().width > 0;
      const out: string[] = [];
      for (const n of document.querySelectorAll('main [data-num]')) {
        if (!seen(n)) continue;
        const own = n.closest('.num')?.querySelector('[data-prov]') ?? n.closest('[data-prov-group]')?.querySelector('[data-prov]');
        const scope = n.closest('[data-prov-scope]');
        const line = scope ? [...scope.querySelectorAll('.srcb')].some(seen) : false;
        if (!seen(own) && !line) out.push((n.textContent ?? '').trim().slice(0, 30));
      }
      return out;
    });
    expect(orphans).toEqual([]);
  });

  test('latest moves: six rows of 1,000 NAM or more from /api/flows?minNam=1000', async ({ page, baseURL }) => {
    const reqs = trackRequests(page);
    await gotoRoute(page, '/');
    await expect(page.locator('.home .tp')).toHaveCount(6, { timeout: 30_000 });
    const flows = apiUrls(reqs, baseURL!).filter((u) => u.pathname === '/api/flows' && u.searchParams.get('minNam') === '1000');
    expect(flows.length).toBeGreaterThan(0);
    for (const t of await page.locator('.home .tp .tp__n').allInnerTexts()) {
      const n = Number(t.replace(/[^\d.]/g, ''));
      expect(n, t).toBeGreaterThanOrEqual(1000);
    }
  });

  test('supply: the legend sums to 100%; the escrow notice shows exactly when the bridge check is not ok', async ({ page }) => {
    await gotoRoute(page, '/');
    await loaded(page);
    const shares = (await page.locator('.home .legend .lg__p').allInnerTexts()).map((t) => Number(t.replace('%', '')));
    // five segments, six once the server sends the staking account's unstaking part separately (2026-10-18)
    const ov0 = await (await page.request.get('/api/overview')).json();
    expect(shares).toHaveLength(ov0.supply.unstaking != null ? 6 : 5);
    expect(Math.round(shares.reduce((a, b) => a + b, 0) * 10) / 10).toBe(100);
    const ov = await (await page.request.get('/api/overview')).json();
    const bridge = (ov.checks as Check[]).find((c) => c.key === 'ibc_conservation');
    const notice = page.locator('section:has(> #home-where) .notice');
    if (bridge && bridge.status !== 'ok') await expect(notice).toContainText('NAM apart');
    else await expect(notice).toHaveCount(0);
  });

  test('holders: ten rows, each with a name line and an address line, no chip per row', async ({ page }) => {
    await gotoRoute(page, '/');
    await loaded(page);
    const rows = page.locator('.home .dl--holders .hrow');
    await expect(rows).toHaveCount(10);
    for (let i = 0; i < 10; i++) {
      await expect(rows.nth(i).locator('.hrow__name')).toBeVisible();
      await expect(rows.nth(i).locator('.hrow__addr')).toBeVisible();
    }
    expect(await page.locator('.home .dl--holders .chip').count()).toBe(0);
    await expect(page.locator('section:has(> #home-who)').getByRole('link', { name: /^All [\d,]+ holders/ })).toHaveAttribute('href', '/holders');
  });

  test('the order-size curve snaps to the listed sizes (arrow keys step between real quotes)', async ({ page }) => {
    await gotoRoute(page, '/');
    const curve: QuoteCurveResponse = await (await page.request.get('/api/quote/curve')).json();
    const sizes = curve.curve.map((p) => p.amountNam).sort((a, b) => a - b);
    test.skip(sizes.length < 2, 'the size table is empty right now');
    const slider = page.locator('.home .explore input[type=range]');
    await expect(slider).toBeVisible({ timeout: 30_000 });
    const out = page.locator('.home .explore .curve__size');
    await slider.focus();
    await page.keyboard.press('Home');
    await expect(out).toHaveText(`${sizes[0].toLocaleString('en-US')} NAM`);
    for (const n of sizes.slice(1)) {
      await page.keyboard.press('ArrowRight');
      await expect(out).toHaveText(`${n.toLocaleString('en-US')} NAM`);
      await expect(page.locator('.home .explore .curve__how')).toContainText('A real quote');
    }
  });

  test('holders: "No balance here changed in the last 7 days" only from balances read in the last 6 hours', async ({ page }) => {
    let readAgo = 2.8 * 86_400_000;
    await page.route(/\/api\/holders\?/, (r) => r.fulfill({ json: holdersRead(readAgo) }));
    const sentence = page.locator('section:has(> #home-who) .hl__sentence');
    // read 2.8 days ago: the zeros say nothing about the last 2.8 days, so the one age sentence says changes are not known
    await gotoRoute(page, '/');
    await expect(sentence).toContainText('Balances were last checked 2.8 days ago, so they are shown dimmed and their changes over 7 days are not known.', { timeout: 30_000 });
    await expect(sentence).not.toContainText('No balance here changed');
    // read an hour ago: the zeros are real, said once
    readAgo = 3_600_000;
    await page.reload();
    await expect(sentence).toHaveText('No balance here changed in the last 7 days.', { timeout: 30_000 });
  });

  test('an empty size table: the explore panel says so with its source line, no endless skeleton, no "Drag the size below."', async ({ page }) => {
    await page.route(/\/api\/quote\/curve/, (r) => r.fulfill({ json: EMPTY_CURVE }));
    await gotoRoute(page, '/');
    const explore = page.locator('.home .explore');
    await expect(explore.locator('.notice')).toContainText('The size table is empty.', { timeout: 30_000 });
    await expect(explore).toContainText(BUSY);
    await expect(explore.locator('.srcb')).toBeVisible();
    await expect(explore.locator('.explore__wait')).toHaveCount(0);
    await expect(page.locator('.home .step').nth(3).locator('.step__copy')).not.toContainText('Drag the size below.');
  });

  test('a size-table refresh that comes back empty keeps the last table, marked old with its own time', async ({ page }) => {
    await page.clock.install();
    let good = true;
    await page.route(/\/api\/quote\/curve/, (r) => r.fulfill({ json: good ? { ...SNAP.curve, prov: { ...SNAP.curve.prov, at: Date.now() } } : EMPTY_CURVE }));
    await gotoRoute(page, '/');
    const explore = page.locator('.home .explore');
    await expect(explore.locator('input[type=range]')).toBeVisible({ timeout: 30_000 });
    good = false;
    await page.clock.runFor(65_000);
    // the earlier reading, with its own age, in the old state (the source line's words are joined by no-break spaces)
    await expect(explore.locator('.srcb')).toHaveAttribute('data-status', 'old');
    await expect(explore.locator('.srcb')).toContainText(/Size table\s+·\s+1\s+min\s+·\s+old/);
    await expect(explore.locator('input[type=range]')).toBeVisible();
    await expect(explore.locator('.notice')).toHaveCount(0);
  });

  test('no earlier alert: only a full search says "none on record"; a failed or 30-day search says what it knows', async ({ page }) => {
    // an older server (no `last` field): the page reads the last 30 days itself
    let wide: 'fail' | 'empty' | 'none' = 'fail';
    await page.route(/\/api\/alerts\/recent/, (r) => {
      const u = new URL(r.request().url());
      const since = Number(u.searchParams.get('since'));
      const now = Date.now();
      const isWide = since > 0 && since < now - 29 * 86_400_000;
      if (wide === 'none') return r.fulfill({ json: { since: now - 86_400_000, until: now, hits: [], last: null } }); // a current server that searched everything
      if (!isWide) return r.fulfill({ json: { since: since || now - 86_400_000, until: now, hits: [] } });
      return wide === 'fail' ? r.fulfill({ status: 503, body: 'unavailable' }) : r.fulfill({ json: { since, until: now, hits: [] } });
    });
    const empty = page.locator('section:has(> #home-changed) .empty');
    await gotoRoute(page, '/');
    await expect(empty).toContainText('Nothing crossed an alert size in 24 hours.', { timeout: 30_000 });
    await expect(empty).toContainText('The last alert could not be read.');
    await expect(empty).not.toContainText('No earlier alert is on record.');
    wide = 'empty';
    await page.reload();
    await expect(empty).toContainText(/No alert in the last 30\sdays\./, { timeout: 30_000 });
    await expect(empty).not.toContainText('No earlier alert is on record.');
    wide = 'none';
    await page.reload();
    await expect(empty).toContainText('No earlier alert is on record.', { timeout: 30_000 });
  });

  test('a bridge crossing is named by where the NAM went, in Latest moves and in alert hits', async ({ page }) => {
    const now = Date.now();
    const row = (id: string, chain: 'namada' | 'osmosis', kind: 'ibc_in' | 'ibc_out', agoH: number, addr: string) => ({
      id, chain, kind, height: 1, ts: now - agoH * 3_600_000, txHash: id.toUpperCase(), from: addr, to: 'tnam1pkkqmkyqtgwnhqw8n8k4w2xyh2ytcvg9e0xws09y', amount: 20_000, valueUsd: 20, meta: null,
    });
    const flows = [
      row('a1', 'namada', 'ibc_in', 1.7, 'osmo1testaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1'), // the receiving chain's record of Osmosis to Namada
      row('a2', 'osmosis', 'ibc_out', 7.7, 'osmo1testbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2'), // the sending chain's record of Osmosis to Namada
    ];
    await page.route(/\/api\/flows\?.*minNam=1000/, (r) => r.fulfill({ json: { total: flows.length, page: 1, limit: 10, flows } }));
    const hit = { ruleId: 'ibc_inventory', ts: now - 3_600_000, flowId: 'h1', chain: 'osmosis', title: '30,000 NAM bridged to Osmosis', detail: '', amountNam: 30_000, address: 'osmo1testcccccccccccccccccccccccccccccccccccc3' };
    await page.route(/\/api\/alerts\/recent/, (r) => r.fulfill({ json: { since: now - 86_400_000, until: now, hits: [hit], last: hit } }));
    await gotoRoute(page, '/');
    const moves = page.locator('.home .tape .tp');
    for (const a of ['1.7 h ago', '7.7 h ago']) {
      const r = moves.filter({ hasText: a });
      await expect(r, a).toContainText('Bridged to Namada', { timeout: 30_000 });
      await expect(r, a).toContainText('Osmosis to Namada');
    }
    await expect(page.locator('.home .tape')).not.toContainText(/Bridge, (arriving|leaving) side/);
    await expect(page.locator('section:has(> #home-changed) .hit').first()).toContainText('Bridged to Osmosis');
  });

  test('when the data service stops answering, the kept moves and hits read old, said once, never fresh', async ({ page }) => {
    await page.clock.install();
    await gotoRoute(page, '/');
    await expect(page.locator('.home .tp').first()).toBeVisible({ timeout: 30_000 });
    await page.route('**/api/**', (r) => r.abort());
    await page.clock.runFor(70_000);
    const tape = page.locator('.home .tape');
    await expect(tape.locator('.old')).toContainText(/did not answer|has not answered/, { timeout: 15_000 });
    await expect(tape.locator('.dl.is-old, .is-old').first()).toBeVisible();
    const states = await tape.locator('.tp [data-num]').evaluateAll((els) => els.map((e) => e.getAttribute('data-status')));
    expect(states.length).toBeGreaterThan(0);
    expect(states.filter((x) => x === 'fresh'), 'no move keeps a fresh state under a failed refresh').toEqual([]);
    const hits = page.locator('section:has(> #home-changed) .hit__n');
    if (await hits.count()) expect(await hits.evaluateAll((els) => els.map((e) => e.getAttribute('data-status')).filter((x) => x === 'fresh'))).toEqual([]);
  });

  test('the overview never answers: "—" and the reason where skeletons waited, not endless skeletons', async ({ page }) => {
    await page.route(/\/api\/overview/, (r) => r.fulfill({ status: 503, body: 'unavailable' }));
    await gotoRoute(page, '/');
    await expect(page.locator('.home .hero .hero-n__v [data-num]')).toHaveText('—', { timeout: 30_000 });
    await expect(page.locator('.home .hero .chip')).toContainText('no data');
    await expect(page.locator('section:has(> #home-where)')).toContainText('The supply figures did not load');
    await expect(page.locator('section:has(> #home-who) .lead')).not.toContainText('The 10 biggest holders own');
    await expect(page.locator('section:has(> #home-who)')).toContainText('The share the ten biggest holders own is not available right now.');
    await expect(page.locator('.home .hrow').first()).toBeVisible({ timeout: 30_000 });
    // past one 20 s poll: still nothing waiting
    await page.waitForTimeout(1500);
    const waiting = await page.locator('.home .hero .skel__b, .home .hero [aria-busy="true"], section:has(> #home-where) .skel__b, section:has(> #home-who) .lead .skel__b, .home .path .step .skel__b').count();
    expect(waiting).toBe(0);
  });

  test('old flow index: Latest moves says when the index last checked each chain, not a "newest move" age', async ({ page }) => {
    await page.route(/\/api\/overview/, async (r) => {
      const res = await r.fetch();
      const o = await res.json();
      const t = Date.now();
      o.dex.coverage = { ...o.dex.coverage, at: t - 40 * 60_000, status: 'stale' };
      o.namada.coverage = { ...o.namada.coverage, at: t - 2 * 3_600_000, status: 'stale' };
      await r.fulfill({ response: res, json: o });
    });
    await gotoRoute(page, '/');
    const line = page.locator('.home .tape .old');
    await expect(line).toHaveText(/^The flow index last checked Osmosis 40\smin ago and Namada 2\sh ago, so these rows are shown dimmed\.$/, { timeout: 30_000 });
    await expect(page.locator('.home .tape')).not.toContainText('The newest recorded move');
  });

  test('the holder count carries the age of the balances behind it, on Home as on /holders', async ({ page }) => {
    await page.route(/\/api\/holders\?/, (r) => r.fulfill({ json: holdersRead(2.8 * 86_400_000) }));
    // a server that stamps the count itself (overview.concentration.namadaProv) is given the same 2.8-day-old reading
    await page.route('**/api/overview*', async (r) => {
      const res = await r.fetch();
      const ov = await res.json();
      if (ov.concentration) ov.concentration.namadaProv = { source: 'NamadaTrade holder index', at: Date.now() - 2.8 * 86_400_000, status: 'stale', note: 'fixture' };
      await r.fulfill({ response: res, json: ov });
    });
    await gotoRoute(page, '/');
    const facts = page.locator('.home .hero .scope-facts');
    await expect(facts.locator('.srcb')).toContainText(/2\.8\sdays/, { timeout: 30_000 });
    await expect(facts.locator('.srcb')).toHaveAttribute('data-status', /old|none|disagree/);
  });

  test('trust: the static proof block shows its date; the rewind example links /supply?at=<first alert>', async ({ page }) => {
    await gotoRoute(page, '/');
    const [y, m, d] = PROOF.reportDate.split('-').map(Number);
    const day = `${d} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${y}`;
    await expect(page.locator('.home .proof')).toContainText(`Static, dated ${day}`);
    await expect(page.locator('.home .proof')).toContainText(`report of ${day}`);
    const link = page.locator('.home .why a');
    await expect(link).toHaveAttribute('href', `/supply?at=${EXAMPLE_AT}`);
    await link.click();
    await expect(page).toHaveURL(`/supply?at=${EXAMPLE_AT}`);
    await expect(page.locator('.rwb')).toBeVisible();
  });

  test('N3: rewound Home: every /api request carries at= except the exempt list; no quote or pool request', async ({ page, baseURL }) => {
    const reqs = trackRequests(page);
    await gotoRoute(page, `/?at=${EXAMPLE_AT}`);
    await expect(page.locator('.rwb')).toContainText('Rewound');
    await expect(page.locator('.home .hrow').first()).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(2000);
    const api = apiUrls(reqs, baseURL!);
    expect(api.length).toBeGreaterThan(0);
    for (const u of api) {
      expect(isLiveOnly(u.pathname), `live-only call while rewound: ${u.pathname}`).toBe(false);
      if (isExempt(u.pathname) || u.pathname === '/api/alerts/rules') continue;
      expect(u.searchParams.get('at'), u.pathname + u.search).toBe(String(EXAMPLE_AT));
    }
    // exempt data is worded honestly; live-only data says it is paused
    await expect(page.locator('section:has(> #home-who)')).toContainText('Balances were not recorded over time; these are current');
    await expect(page.locator('.home .sec--ticket')).toContainText('Live quotes are paused while rewound.');
    // the example's alert is the newest hit at that moment
    await expect(page.locator('section:has(> #home-changed) .hit').first()).toContainText('just now');
    // navigation keeps ?at=
    await expect(page.locator('.home .hero .btn--primary')).toHaveAttribute('href', `/trade?at=${EXAMPLE_AT}`);
  });

  test('G7: nothing on Home animates under reduced motion', async ({ page }) => {
    await gotoRoute(page, '/', { reducedMotion: true });
    await loaded(page);
    await page.waitForTimeout(800);
    expect(await animationsIn(page, 'main')).toBe(0);
  });

  test('no layout shift from the price arriving: the hero keeps its height', async ({ page }) => {
    await page.route('**/api/overview*', async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });
    await gotoRoute(page, '/');
    const before = await page.locator('.home .hero').boundingBox();
    await expect(page.locator('.home .hero .hero-n__v [data-num]')).toBeVisible({ timeout: 30_000 });
    const after = await page.locator('.home .hero').boundingBox();
    expect(Math.abs((after?.height ?? 0) - (before?.height ?? 0))).toBeLessThanOrEqual(4);
  });
});
