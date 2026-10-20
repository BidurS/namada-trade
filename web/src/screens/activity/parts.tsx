// Activity (S5): pieces shared by the Transactions and Holders tabs.
//
// - useWide(): the 1024 px switch between the filter sheet (phones, tablets) and inline filters.
// - ActivityBar: the page tabs (real links, /activity and /holders, ?at= carried) and the Filter
//   button with its count badge (below 1024 px only).
// - FilterSheet: the bottom sheet (kit Sheet) that holds the same controls on phones.
import React, { useEffect, useState, useSyncExternalStore, type RefObject } from 'react';
import { Button, Sheet, Tabs } from '../../ui';
export { SearchField } from '../../ui';
import { hrefFor } from '../../app/index';
import { SHORTCUTS } from '../../app/keys';
import { rovingTo } from './paging';

// ---------------------------------------------------------------- the 1024 px switch
const WIDE = '(min-width: 1024px)';
function subscribeWide(cb: () => void) {
  const m = window.matchMedia(WIDE);
  m.addEventListener('change', cb);
  return () => m.removeEventListener('change', cb);
}
const wideSnap = () => window.matchMedia(WIDE).matches;
/** True from 1024 px: filters are inline controls; below, they live in a sheet behind the Filter button. */
export const useWide = (): boolean => useSyncExternalStore(subscribeWide, wideSnap, () => false);

// ---------------------------------------------------------------- page tabs and the Filter button
export function ActivityBar({
  view,
  wide,
  filterCount,
  filterOpen,
  onFilter,
  search,
}: {
  view: 'activity' | 'holders';
  wide: boolean;
  filterCount: number;
  filterOpen: boolean;
  onFilter: () => void;
  /** From 1024 px the search box sits at the right end of the tab bar. */
  search?: React.ReactNode;
}) {
  return (
    <Tabs
      label="Activity views"
      className="act-bar"
      items={[
        { label: 'Transactions', href: hrefFor('/activity'), current: view === 'activity' },
        { label: 'Holders', href: hrefFor('/holders'), current: view === 'holders' },
      ]}
    >
      {wide ? (
        <div className="act-bar__end">{search}</div>
      ) : (
        <Button
          variant="secondary"
          size="sm"
          icon="filter"
          className="act-filterbtn"
          onClick={onFilter}
          aria-haspopup="dialog"
          aria-expanded={filterOpen}
          aria-label={filterCount ? `Filter, ${filterCount} on` : 'Filter'}
        >
          Filter
          {filterCount ? <span className="badge" aria-hidden="true">{filterCount}</span> : null}
        </Button>
      )}
    </Tabs>
  );
}

/**
 * The filter controls: inline from 1024 px, a bottom sheet below. The sheet stays mounted after it
 * first opens so the kit Sheet can close itself (Escape, scrim, Close) and return focus.
 */
export function FilterPanel({
  wide,
  open,
  onClose,
  title,
  show,
  children,
}: {
  wide: boolean;
  open: boolean;
  onClose: () => void;
  /** Sheet heading and the inline group's name ("Filter moves"). */
  title: string;
  /** The sheet's one action ("Show 1,204 moves"). */
  show: React.ReactNode;
  children: React.ReactNode;
}) {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);
  if (wide) {
    return (
      <div className="act-filters" role="group" aria-label={title}>
        {children}
      </div>
    );
  }
  if (!mounted) return null;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={title}
      className="act-fsheet"
      foot={
        <Button variant="primary" block onClick={onClose}>
          {show}
        </Button>
      }
    >
      <div className="act-fbody">{children}</div>
    </Sheet>
  );
}

/** One labelled group of controls (Chain, What, Size …). */
export function FilterSet({ label, children, className = '' }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <fieldset className={`fset act-fset ${className}`}>
      <legend className="fset__l">{label}</legend>
      {children}
    </fieldset>
  );
}

// ---------------------------------------------------------------- rows you can walk (nav-search-plan 3.4)
/**
 * A roving tab stop over the list's rows: one row is in the tab order (the first, or the last one focused or
 * walked to), the others take focus only from the keys. Re-applied when new rows arrive (`rows` changes).
 */
export function useRovingRows(list: RefObject<HTMLElement | null>, rowSel: string, rows: unknown) {
  useEffect(() => {
    const el = list.current;
    if (!el) return;
    const active = document.activeElement?.closest(rowSel) as HTMLElement | null;
    rovingTo(active && el.contains(active) ? active : null, el, rowSel);
    const onFocus = (e: FocusEvent) => {
      const r = (e.target as Element | null)?.closest?.(rowSel) as HTMLElement | null;
      if (r && el.contains(r) && r.getAttribute('tabindex') !== '0') rovingTo(r, el, rowSel);
    };
    el.addEventListener('focusin', onFocus);
    return () => el.removeEventListener('focusin', onFocus);
  }, [list, rowSel, rows]);
}

/** The list keys, in words, from the one table in app/keys.ts; only where there is a keyboard (pointer: fine). */
export function KeysHint() {
  const keys = SHORTCUTS.filter((k) => k.where === 'lists');
  return (
    <p className="act-keys">
      <span className="act-keys__t">Keys</span>
      {keys.map((k) => (
        <span key={k.does} className="act-keys__k">
          {k.keys.map((x) => (
            <kbd key={x}>{x}</kbd>
          ))}{' '}
          {k.does}
        </span>
      ))}
    </p>
  );
}
