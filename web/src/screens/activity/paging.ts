// Activity (S5): numbered pages for the Holders and Transactions lists (docs/design/nav-search-plan.md 2.3,
// owner decision 2026-10-20: First ‹ Page [n] of N › Last, never "Load more"). The page lives in the URL
// (?page=N, 1 when absent); the sizes live here, never typed into JSX (the N2 lint).

/** Rows per page on both lists (the API clamps `limit` to 10…100, worker/src/api.ts). */
export const PAGE_SIZE = 50;
/** The holder export's row cap (worker/src/api.ts HOLDER_EXPORT_MAX). */
export const HOLDER_CSV_MAX = 10_000;
/** The flow export's row cap (worker/src/api.ts FLOW_EXPORT_MAX). */
export const FLOW_CSV_MAX = 5_000;

/** `?page=` as a page number: a whole number from 1, otherwise null (the caller normalises it away). */
export function parsePage(raw: string | null): number | null {
  if (raw == null || !/^\d{1,6}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 ? n : null;
}

/** The number of pages for `total` rows (at least 1, so an empty list is page 1 of 1). */
export const pageCount = (total: number, size = PAGE_SIZE): number => Math.max(1, Math.ceil(total / size));

/** The current URL with ?page= set (dropped for page 1, so canonical links stay short); every other parameter kept. */
export function pageHref(page: number): string {
  const u = new URL(location.href);
  if (page <= 1) u.searchParams.delete('page');
  else u.searchParams.set('page', String(page));
  return `${u.pathname}${u.search}${u.hash}`;
}

/** The first row of the list on screen: scroll the list's head under the sticky header, then focus the row. */
export function focusFirstRow(head: HTMLElement | null, list: HTMLElement | null, rowSel: string) {
  head?.scrollIntoView({ block: 'start', behavior: 'instant' as ScrollBehavior });
  const row = list?.querySelector<HTMLElement>(rowSel);
  if (!row) return;
  row.setAttribute('tabindex', '-1');
  row.focus({ preventScroll: true });
}
