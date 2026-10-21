// Shared helpers for every spec in web/e2e (F1). Screen owners import from here:
//   import { test, expect, VIEWPORTS, REWIND_AT, gotoRoute, layoutAudit, trackApi } from './helpers';
import { expect, test, type Page, type Request } from '@playwright/test';
import { ROUTES } from '../../shared/routes';

export { expect, test };

/** Gate G6 viewport matrix (the config makes one project per entry). */
export const VIEWPORTS = [
  { width: 360, height: 780 },
  { width: 375, height: 812 },
  { width: 390, height: 844 },
  { width: 412, height: 915 },
  { width: 768, height: 1024 },
  { width: 1280, height: 800 },
] as const;

/** The 320 px header smoke (G6). */
export const SMOKE_320 = { width: 320, height: 700 } as const;

/** A rewound moment with data (the N3 example: /supply?at=1788116700000). */
export const REWIND_AT = 1788116700000;

/** Every app route path from shared/routes.ts. */
export const ROUTE_PATHS = ROUTES.map((r) => r.path);

/** /api paths that do not take ?at= (build-plan 6); the UI says so in words instead. */
export const REWIND_EXEMPT = ['/api/holders', '/api/address/', '/api/search', '/api/integrity', '/api/export/', '/api/me', '/api/auth', '/api/labels'];
export const REWIND_LIVE_ONLY = ['/api/quote', '/api/pools'];
const under = (path: string, p: string) => path === p.replace(/\/$/, '') || path.startsWith(p.endsWith('/') ? p : `${p}/`);
export const isExempt = (path: string) => REWIND_EXEMPT.some((p) => under(path, p));
export const isLiveOnly = (path: string) => REWIND_LIVE_ONLY.some((p) => under(path, p));

/** Is this project the one viewport a viewport-independent test runs in? */
export const onlyIn = (projectName: string, wanted = '375x812') => projectName !== wanted;

/** Open a path and wait until the shell and the route's h1 are rendered. */
export async function gotoRoute(page: Page, path: string, opts: { reducedMotion?: boolean } = {}) {
  if (opts.reducedMotion) await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await page.locator('header.hdr').waitFor();
  await page.locator('main h1').first().waitFor({ timeout: 30_000 });
}

/** Record every request the page makes (call before goto). */
export function trackRequests(page: Page): Request[] {
  const list: Request[] = [];
  page.on('request', (r) => list.push(r));
  return list;
}

/** Only the same-origin /api requests, as URLs. */
export const apiUrls = (reqs: Request[], origin: string): URL[] =>
  reqs.map((r) => new URL(r.url())).filter((u) => u.origin === origin && u.pathname.startsWith('/api/'));

export interface LayoutAudit {
  overflowX: boolean;
  scrollWidth: number;
  innerWidth: number;
  h1: string[];
  tables: number;
  smallText: string[];
  smallTargets: string[];
  targetCount: number;
}

/**
 * The shoot.mjs audit, inside a test: horizontal overflow, <table> count, visible text under
 * 11 px, interactive elements whose effective hit box (the element plus an absolutely positioned
 * ::after, the 44 px pattern) is under 44 x 44. Inline links in running text are exempt.
 * `scope` limits text and target checks to a selector (e.g. 'header.hdr, nav.tabbar').
 */
export async function layoutAudit(page: Page, scope = 'body'): Promise<LayoutAudit> {
  return page.evaluate((sel) => {
    const de = document.documentElement;
    const roots = [...document.querySelectorAll(sel)];
    const smallText: string[] = [];
    const smallTargets: string[] = [];
    let targetCount = 0;
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none';
    };
    for (const root of roots) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const n = walker.currentNode;
        const t = (n.textContent ?? '').trim();
        if (!t || !n.parentElement || !visible(n.parentElement)) continue;
        const px = parseFloat(getComputedStyle(n.parentElement).fontSize);
        if (px < 11) smallText.push(`${px}px "${t.slice(0, 40)}"`);
      }
      for (const el of root.querySelectorAll('a[href], button, [role=button], input, select, textarea, [tabindex]:not([tabindex="-1"])')) {
        if (!visible(el)) continue;
        if (el.tagName === 'A' && el.closest('p, li > p, .prose')) continue;
        targetCount++;
        const r = el.getBoundingClientRect();
        const after = getComputedStyle(el, '::after');
        let w = r.width;
        let h = r.height;
        if (after.content !== 'none' && after.position === 'absolute') {
          const ins = (v: string) => (v === 'auto' ? 0 : -parseFloat(v) || 0);
          w = r.width + ins(after.left) + ins(after.right);
          h = r.height + ins(after.top) + ins(after.bottom);
        }
        if (w < 44 || h < 44) smallTargets.push(`${Math.round(w)}x${Math.round(h)} ${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30)}"`);
      }
    }
    return {
      // against the visual viewport: a phone (isMobile) stretches the layout viewport, and so innerWidth, to fit content
      // wider than the screen (a 369 px header on a 360 px phone read innerWidth 369, scrollWidth 369: no overflow)
      overflowX: de.scrollWidth > Math.round(window.visualViewport?.width ?? window.innerWidth),
      scrollWidth: de.scrollWidth,
      innerWidth: window.innerWidth,
      h1: [...document.querySelectorAll('h1')].map((x) => (x.textContent ?? '').trim()),
      tables: document.querySelectorAll('table').length,
      smallText,
      smallTargets,
      targetCount,
    };
  }, scope);
}

/** Running animations under an element (G7 asks for none under reduced motion). */
export async function animationsIn(page: Page, scope = 'body'): Promise<number> {
  return page.evaluate((sel) => {
    const roots = [...document.querySelectorAll(sel)];
    return document.getAnimations().filter((a) => {
      const t = (a.effect as KeyframeEffect | null)?.target;
      return !!t && roots.some((r) => r.contains(t));
    }).length;
  }, scope);
}
