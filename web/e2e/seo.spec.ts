// S8: the content pages (/staking, /osmosis, /learn/how-nam-trading-works, /faq) and the
// not-found view. Layout checks run in every project of the G6 matrix; the rest run once (375).
import fs from 'node:fs';
import { BODY, NOT_FOUND, SITE } from '../../shared/copy';
import { ROUTES, TABS, routeByPath } from '../../shared/routes';
import { REWIND_AT, animationsIn, apiUrls, expect, gotoRoute, isExempt, isLiveOnly, layoutAudit, onlyIn, test, trackRequests } from './helpers';

/** A page link's name: the page's name, then its question ("Supply: Is a big sale coming?"). */
const pageLink = (label: string) => new RegExp(`^${label}: `); // labels have no regex characters

const PAGES = ['/staking', '/osmosis', '/learn/how-nam-trading-works', '/faq'] as const;
const route = (p: string) => routeByPath(p)!;

/** Every plain-language sentence of a page (shared/copy.ts BODY), in order. */
const sentencesOf = (id: string): string[] => {
  const c = BODY[id];
  return [...c.paras, ...(c.sections ?? []).flatMap((s) => [s.h2, ...s.paras])];
};

/** Wait until the page's figures have arrived: no skeleton block left inside main. */
async function settled(page: import('@playwright/test').Page) {
  await expect(page.locator('main .skel__b, main [aria-busy="true"]')).toHaveCount(0, { timeout: 30_000 });
}

test.describe('layout, every viewport', () => {
  for (const path of [...PAGES, '/no-such-page']) {
    test(`${path}: no overflow, no <table>, 44 px targets, text at least 11 px`, async ({ page }) => {
      await gotoRoute(page, path);
      if (path !== '/no-such-page') await settled(page);
      const a = await layoutAudit(page, 'main');
      expect(a.overflowX, `scrollWidth ${a.scrollWidth} > ${a.innerWidth}`).toBe(false);
      expect(a.tables).toBe(0);
      expect(a.smallText).toEqual([]);
      expect(a.smallTargets).toEqual([]);
    });
  }

  test('rewound /staking and /osmosis: no overflow', async ({ page }) => {
    for (const path of ['/staking', '/osmosis']) {
      await gotoRoute(page, `${path}?at=${REWIND_AT}`);
      await expect(page.locator('.rwb')).toBeVisible();
      await settled(page);
      const a = await layoutAudit(page, 'main');
      expect(a.overflowX, path).toBe(false);
      expect(a.smallTargets, path).toEqual([]);
    }
  });
});

test.describe('once', () => {
  test.beforeEach(({}, info) => test.skip(onlyIn(info.project.name), 'viewport-independent: runs in 375x812'));

  test('one h1 equal to RouteDef.h1, and every BODY sentence is visible text', async ({ page }) => {
    for (const path of PAGES) {
      const r = route(path);
      await gotoRoute(page, path);
      await expect(page.locator('h1')).toHaveCount(1);
      await expect(page.locator('h1')).toHaveText(r.h1);
      const main = page.locator('main');
      for (const s of sentencesOf(r.id)) await expect(main, `${path}: "${s.slice(0, 40)}…"`).toContainText(s, { useInnerText: true });
      // each question is an h2 (featured-snippet shape: the next text answers it)
      for (const sec of BODY[r.id].sections ?? []) await expect(page.getByRole('heading', { level: 2, name: sec.h2 })).toBeVisible();
    }
  });

  test('key figures render with their provenance', async ({ page }) => {
    // staking: the staked share (hero, chip) and the unstaking wait
    await gotoRoute(page, '/staking');
    await settled(page);
    await expect(page.locator('.seo-hero .hero-n__v [data-num]')).toHaveText(/^\d{1,2}\.\d%$/);
    await expect(page.locator('.seo-hero .chip')).toHaveCount(1);
    await expect(page.locator('.seo-hero .facts [data-num]').nth(1)).toHaveText(/^\d+(\.\d+)?\sdays$/);
    await expect(page.locator('.seo-hero .srcb')).toHaveCount(1);
    // osmosis: the money in the pools (hero, chip), four facts, a source line per panel
    await gotoRoute(page, '/osmosis');
    await settled(page);
    await expect(page.locator('.seo-hero .hero-n__v [data-num]')).toHaveText(/^\$[\d,]+(\.\d\d)?$/);
    await expect(page.locator('.seo-hero .chip')).toHaveCount(1);
    await expect(page.locator('.seo-hero .fact')).toHaveCount(4);
    expect(await page.locator('main .srcb').count()).toBeGreaterThanOrEqual(4);
    // learn: four steps, each with its figure and its own stamp
    await gotoRoute(page, '/learn/how-nam-trading-works');
    await settled(page);
    await expect(page.locator('.seo-step')).toHaveCount(4);
    await expect(page.locator('.seo-step .pdot')).toHaveCount(4);
    await expect(page.locator('.seo-step__fig [data-num]')).toHaveCount(4);
    // faq: the price and the shielded share in the band
    await gotoRoute(page, '/faq');
    await settled(page);
    await expect(page.locator('.seo-hero .fact [data-num]').first()).toContainText('$0.');
    await expect(page.locator('.seo-hero .fact [data-num]').nth(1)).toHaveText(/%$/);
  });

  test('a staking rate the server does not send is said in plain words, never in operator words', async ({ page }) => {
    // a server from before W13 sends no chainParams; one that tried and failed sends null
    let mode: 'absent' | 'null' = 'absent';
    await page.route(/\/api\/pressure/, async (r) => {
      const j = await (await r.fetch()).json();
      if (mode === 'absent') delete j.chainParams;
      else j.chainParams = null;
      await r.fulfill({ json: j });
    });
    const facts = page.locator('.seo-hero .facts');
    await gotoRoute(page, '/staking');
    await settled(page);
    await expect(facts).toContainText('The staking rate is not available yet.');
    await expect(page.locator('main')).not.toContainText('This server');
    mode = 'null';
    await page.reload();
    await settled(page);
    await expect(facts).toContainText('The chain parameters could not be read.');
  });

  test('ProvChip only on hero figures: at most one per page, none on Learn and FAQ', async ({ page }) => {
    for (const [path, chips] of [['/staking', 1], ['/osmosis', 1], ['/learn/how-nam-trading-works', 0], ['/faq', 0]] as const) {
      await gotoRoute(page, path);
      await settled(page);
      await expect(page.locator('main .chip'), path).toHaveCount(chips);
    }
  });

  test('N1: every figure has its own stamp or sits in a scope whose SourceLine lists it', async ({ page }) => {
    for (const path of PAGES) {
      await gotoRoute(page, path);
      await settled(page);
      const orphans = await page.evaluate(() =>
        [...document.querySelectorAll('main [data-num]')]
          .filter((n) => {
            // its own control: its .num, the hero, a step, or a sentence grouped with its stamp (as gates.spec N1)
            if (n.closest('.num, .hero-n, .seo-step, [data-prov-group]')?.querySelector('[data-prov]')) return false;
            // any enclosing scope whose own SourceLine is rendered and visible
            for (let s = n.closest('[data-prov-scope]'); s; s = s.parentElement?.closest('[data-prov-scope]') ?? null) {
              const line = s.querySelector(':scope > .src > .srcb, :scope > .srcb') as HTMLElement | null;
              if (line && line.offsetParent !== null && line.dataset.scope) return false;
            }
            return true;
          })
          .map((n) => (n.textContent ?? '').trim()),
      );
      expect(orphans, path).toEqual([]);
    }
  });

  test('/osmosis: the largest order under a one percent move says how it was made, never "between two listed sizes" when it is not', async ({ page }) => {
    const snap = JSON.parse(fs.readFileSync(new URL('../../docs/design/data/snapshot.json', import.meta.url), 'utf8'));
    let curve: Record<string, unknown> = { ...snap.curve, prov: { ...snap.curve.prov, at: Date.now() - 2000 } };
    await page.route(/\/api\/quote\/curve/, (r) => r.fulfill({ json: curve }));
    const row = page.locator('section:has(> #q-move) .seo-fig').first();
    // an older server: 1,000 NAM already moves the price 3.14% (buying), and it scaled 318 NAM down from zero
    await gotoRoute(page, '/osmosis');
    await expect(row.locator('dd')).toHaveText(/^under\s1,000\sNAM$/, { timeout: 30_000 });
    await expect(row.locator('dt')).toContainText('the smallest size quoted already moves the price 3.14%');
    await expect(row).not.toContainText('318');
    await expect(row).not.toContainText('between two listed sizes');
    // a current server: between two listed sizes, said as such
    const imp = [0.5, 1.6, 2, 2.4, 2.6, 2.9];
    curve = {
      ...snap.curve,
      curve: snap.curve.curve.map((p: Record<string, unknown>, i: number) => ({ ...p, sellImpactPct: imp[i], buyImpactPct: imp[i] })),
      maxSafeClip1PctNam: 2000,
      safeClip1Pct: { nam: 2000, how: 'interpolated', smallestNam: 1000, smallestImpactPct: 0.5 },
      prov: { ...snap.curve.prov, at: Date.now() - 2000 },
    };
    await page.reload();
    await expect(row.locator('dd')).toHaveText(/^about\s2,000\sNAM$/, { timeout: 30_000 });
    await expect(row.locator('dt')).toContainText('a straight line between the two listed sizes around it, not a quote');
    // no listed size reaches one percent: at least the largest
    curve = { ...curve, curve: snap.curve.curve.map((p: Record<string, unknown>) => ({ ...p, sellImpactPct: 0.4, buyImpactPct: 0.6 })), maxSafeClip1PctNam: 100000, safeClip1Pct: { nam: 100000, how: 'at_least', smallestNam: 1000, smallestImpactPct: 0.6 } };
    await page.reload();
    await expect(row.locator('dd')).toHaveText(/^at least\s100,000\sNAM$/, { timeout: 30_000 });
    await expect(row.locator('dt')).toContainText('even the largest size quoted moves the price less');
  });

  test('links to the app screens are real anchors', async ({ page }) => {
    await gotoRoute(page, '/staking');
    const rel = page.locator('nav.seo-rel');
    await expect(rel.getByRole('link', { name: pageLink('Supply') })).toHaveAttribute('href', '/supply');
    await rel.getByRole('link', { name: pageLink('Supply') }).click();
    await expect(page).toHaveURL('/supply');
  });

  test('FAQ: one open <details> per question; a tap folds it', async ({ page }) => {
    await gotoRoute(page, '/faq');
    const qs = page.locator('details.seo-q');
    await expect(qs).toHaveCount(BODY.faq.sections!.length);
    for (let i = 0; i < BODY.faq.sections!.length; i++) await expect(qs.nth(i)).toHaveAttribute('open', '');
    await qs.first().locator('summary').click();
    await expect(qs.first()).not.toHaveAttribute('open', '');
    await expect(qs.first().locator('.seo-answer')).toBeHidden();
  });

  test('official links: the footer\'s line leads to the FAQ answer, whose names are the site\'s own links', async ({ page }) => {
    await gotoRoute(page, '/trade');
    const foot = page.locator('footer.foot');
    await expect(foot).toContainText(SITE.neverAsks);
    await foot.getByRole('link', { name: 'Official links', exact: true }).click();
    await expect(page).toHaveURL(/\/faq#q-official$/);
    // the shell scrolls to the top on a new path; the page then brings the answer into view
    await expect(page.locator('h2#q-official')).toBeInViewport({ timeout: 30_000 });
    const answer = page.locator('details.seo-q', { has: page.locator('h2#q-official') }).locator('.seo-answer');
    const links = await answer.locator('a').evaluateAll((as) => as.map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('target')]));
    expect(links).toEqual([
      ['namada.trade', 'https://namada.trade/', null],
      ['@namadatrade', SITE.x, '_blank'],
      [`@${SITE.telegram.bot}`, `https://t.me/${SITE.telegram.bot}`, '_blank'],
      ['github.com/BidurS/namada-trade', SITE.repo, '_blank'],
    ]);
    await expect(answer).toHaveText(BODY.faq.sections!.at(-1)!.paras[0]);
  });

  test('rewound: every /api request carries at= (exempt list aside), no live-only or current-only call, and the pages say so', async ({ page, baseURL }) => {
    const reqs = trackRequests(page);
    for (const path of PAGES) {
      const start = reqs.length;
      await gotoRoute(page, `${path}?at=${REWIND_AT}`);
      await expect(page.locator('.rwb')).toContainText('Rewound');
      await settled(page);
      await page.waitForTimeout(1000);
      const api = apiUrls(reqs.slice(start), baseURL!);
      expect(api.length, path).toBeGreaterThan(0);
      for (const u of api) {
        if (isExempt(u.pathname)) continue;
        expect(isLiveOnly(u.pathname), `${path}: live-only call while rewound: ${u.pathname}`).toBe(false);
        expect(u.pathname, `${path}: validators are current only`).not.toBe('/api/intel');
        expect(u.searchParams.get('at'), `${path}: ${u.pathname}${u.search}`).toBe(String(REWIND_AT));
      }
      // the eyebrow dateline is the rewound moment (1788116700000 is 30 Aug 2026, 19:05 UTC)
      await expect(page.locator('.seo-eyebrow')).toContainText('30 Aug 2026');
    }
    await gotoRoute(page, `/osmosis?at=${REWIND_AT}`);
    await expect(page.locator('main')).toContainText('Live quotes are paused while rewound.');
    await gotoRoute(page, `/staking?at=${REWIND_AT}`);
    await settled(page);
    await expect(page.locator('main')).toContainText('Validator commissions were not recorded over time.');
  });

  test('not found: the h1, the six main screens as links, and search', async ({ page }) => {
    await gotoRoute(page, '/no-such-page');
    await expect(page.locator('h1')).toHaveText(NOT_FOUND.h1);
    const main = page.locator('main');
    for (const t of TABS) await expect(main.getByRole('link', { name: pageLink(t.label) })).toHaveAttribute('href', t.path);
    for (const r of ROUTES.filter((x) => x.index && !x.guide && !TABS.some((t) => t.path === x.path))) await expect(main.getByRole('link', { name: pageLink(r.label) })).toBeVisible();
    await main.getByRole('button', { name: 'Search' }).click();
    await expect(page.locator('dialog.pal')).toBeVisible();
  });

  test('G7: nothing animates under reduced motion', async ({ page }) => {
    for (const path of PAGES) {
      await gotoRoute(page, path, { reducedMotion: true });
      await settled(page);
      expect(await animationsIn(page, 'main'), path).toBe(0);
    }
  });

  test('no banned words in the visible text', async ({ page }) => {
    const banned = /\b(SQS|IBC|DEX|PoS|MASP|ABCI|RPC|cron|webhook|npm|D[1-7])\b|Loading…/;
    for (const path of [...PAGES, '/no-such-page']) {
      await gotoRoute(page, path);
      if (path !== '/no-such-page') await settled(page);
      const text = await page.locator('main').innerText();
      expect(text.match(banned)?.[0] ?? null, path).toBeNull();
    }
  });
});
