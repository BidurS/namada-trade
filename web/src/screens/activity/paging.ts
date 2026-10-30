// Activity (S5): numbered pages for the Holders and Transactions lists (docs/design/nav-search-plan.md 2.3,
// owner decision 2026-10-20: First ‹ Page [n] of N › Last, never "Load more"). The page and the rows per page live
// in the URL with every other list parameter (urlState.ts); the sizes and caps live here, never typed into JSX (the
// N2 lint), with the helpers that place and focus rows under the sticky stack.

import { PAGE_SIZES, PAGE_SIZE, type PageSize } from '../../../../shared/paging';
/** The rows-per-page choices and the default, from shared/paging.ts (one list for the API and both screens). */
export { PAGE_SIZES, PAGE_SIZE };
export type { PageSize };
/** The holder export's row cap (worker/src/api.ts HOLDER_EXPORT_MAX). */
export const HOLDER_CSV_MAX = 10_000;
/** The flow export's row cap (worker/src/api.ts FLOW_EXPORT_MAX). */
export const FLOW_CSV_MAX = 5_000;
/** How long a row reached by "Go to rank" stays highlighted (ms). */
export const HIT_MS = 1_600;

/** The number of pages for `total` rows (at least 1, so an empty list is page 1 of 1). */
export const pageCount = (total: number, size: number = PAGE_SIZE): number => Math.max(1, Math.ceil(total / size));

/**
 * The pages a holder list is served on: its count's, up to the first `reach` holders when the server pages no further
 * (HoldersResponse.pagedTo); with no count (`over`: more than that many match, which is never fewer than `reach`),
 * the pages of the reach, every one of them full. null when neither is known.
 */
export const servedPages = (total: number | null, over: number | null, reach: number | null, size: number): number | null =>
  total != null ? pageCount(reach != null ? Math.min(total, reach) : total, size) : over != null && reach != null && over >= reach ? pageCount(reach, size) : null;

/** The page that holds the row at 1-based position `rank`. */
export const pageOfRank = (rank: number, size: number): number => Math.max(1, Math.ceil(rank / size));

// ---------------------------------------------------------------- the sticky stack and rows

/**
 * The bottom edge, in viewport px, of what stays stuck at the top of the window: the site header, the rewound
 * banner, and the given elements when they are sticky (the list head on phones, the column heads on desktop).
 * Measured, not assumed, so a wrapped count line or a two-line banner is counted at its real height.
 */
export function stuckBottom(extra: (Element | null | undefined)[] = []): number {
  let bottom = 0;
  for (const el of [document.querySelector('header.hdr'), document.querySelector('.rwb'), ...extra]) {
    if (!(el instanceof HTMLElement)) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || (cs.position !== 'sticky' && cs.position !== 'fixed')) continue;
    bottom = Math.max(bottom, (parseFloat(cs.top) || 0) + el.getBoundingClientRect().height);
  }
  return bottom;
}

/** The list's sticky parts: its head (phones) and the column heads (desktop). */
const stickyOf = (head: HTMLElement | null, list: HTMLElement | null) => [head, list?.querySelector('.dl__head, .txl__head')];

const GAP = 8;

/**
 * Bring a row into view under the sticky stack: `top` puts it right under the stack; `nearest` scrolls only
 * when it is hidden behind the stack or below the window. Instant (no smooth scroll: it is a jump).
 */
export function revealRow(row: HTMLElement, head: HTMLElement | null, list: HTMLElement | null, how: 'top' | 'nearest' = 'nearest') {
  const top = stuckBottom(stickyOf(head, list)) + GAP;
  const r = row.getBoundingClientRect();
  const bottomEdge = window.innerHeight - (document.querySelector('nav.tabbar')?.getBoundingClientRect().height ?? 0) - GAP;
  let dy = 0;
  if (how === 'top' || r.top < top) dy = r.top - top;
  else if (r.bottom > bottomEdge) dy = Math.min(r.bottom - bottomEdge, r.top - top);
  if (dy) window.scrollTo({ top: window.scrollY + dy, left: 0, behavior: 'instant' as ScrollBehavior });
}

/** Focus a row without the browser's own scroll (revealRow placed it), as a roving tab stop. */
export function focusRow(row: HTMLElement, list: HTMLElement | null, rowSel: string) {
  rovingTo(row, list, rowSel);
  row.focus({ preventScroll: true });
}

/** Roving tabindex: the given row is the list's one tab stop (0), every other row -1. */
export function rovingTo(row: HTMLElement | null, list: HTMLElement | null, rowSel: string) {
  if (!list) return;
  const rows = list.querySelectorAll<HTMLElement>(rowSel);
  rows.forEach((r) => r.setAttribute('tabindex', r === row ? '0' : '-1'));
  if (!row && rows[0]) rows[0].setAttribute('tabindex', '0');
}

/**
 * After a page change: the list's head where it sits (desktop) or the first row right under the stuck head
 * (phones), then focus on the first row (`focus` false: the scroll only, while the new rows load).
 */
export function focusFirstRow(head: HTMLElement | null, list: HTMLElement | null, rowSel: string, focus = true) {
  const row = list?.querySelector<HTMLElement>(rowSel);
  if (head && getComputedStyle(head).position !== 'sticky') {
    const top = stuckBottom() + GAP;
    const dy = head.getBoundingClientRect().top - top;
    if (dy) window.scrollTo({ top: window.scrollY + dy, left: 0, behavior: 'instant' as ScrollBehavior });
  } else if (row) revealRow(row, head, list, 'top');
  if (row && focus) focusRow(row, list, rowSel);
}

/** The first row whose top is at or under the sticky stack (the row a reader is looking at), and its index. */
export function firstVisibleRow(head: HTMLElement | null, list: HTMLElement | null, rowSel: string): { row: HTMLElement; index: number } | null {
  if (!list) return null;
  const top = stuckBottom(stickyOf(head, list));
  const rows = [...list.querySelectorAll<HTMLElement>(rowSel)];
  const i = rows.findIndex((r) => r.getBoundingClientRect().bottom > top + GAP);
  return i >= 0 ? { row: rows[i], index: i } : null;
}

/** Mark a row as just reached (a short highlight; static under reduced motion, see activity.css). */
export function flashRow(row: HTMLElement) {
  row.classList.remove('is-hit');
  void row.offsetWidth;
  row.classList.add('is-hit');
  window.setTimeout(() => row.classList.remove('is-hit'), HIT_MS);
}
