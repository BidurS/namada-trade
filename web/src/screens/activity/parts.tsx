// Activity (S5): pieces shared by the Transactions and Holders tabs.
//
// - useWide(): the 1024 px switch between the filter sheet (phones, tablets) and inline filters.
// - ActivityBar: the page tabs (real links, /activity and /holders, ?at= carried) and the Filter
//   button with its count badge (below 1024 px only).
// - FilterSheet: the bottom sheet (kit Sheet) that holds the same controls on phones.
import React, { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { Button, SearchField, Sheet, Tabs } from '../../ui';
export { SearchField } from '../../ui';
import { hrefFor } from '../../app/index';
import { SHORTCUTS, useSlashTarget } from '../../app/keys';
import { rovingTo } from './paging';
import { listPath } from './urlState';

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
        // each tab's link leads back to that list as it was left (its filters, page and size; urlState.ts)
        { label: 'Transactions', href: hrefFor(view === 'activity' ? '/activity' : listPath('/activity')), current: view === 'activity' },
        { label: 'Holders', href: hrefFor(view === 'holders' ? '/holders' : listPath('/holders')), current: view === 'holders' },
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
          // the name starts with what the button shows ("Filter 2"), so speech input can say it (WCAG 2.5.3)
          aria-label={filterCount ? `Filter ${filterCount} on` : 'Filter'}
        >
          Filter
          {filterCount ? (
            <>
              {' '}
              <span className="badge" aria-hidden="true">
                {filterCount}
              </span>
            </>
          ) : null}
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

// ---------------------------------------------------------------- the list's search field (nav-search-plan 4.3)
/**
 * The kit's SearchField with the list's two moments: `onType` while the reader types (the field applies its text a
 * moment after typing stops), `onCommit` on Enter or when focus leaves the field (the screen then moves the filter
 * words out of the text into their own parameters, urlState.ts). `hint` is the line under the field (phones).
 */
export function ListSearch({
  label,
  compact,
  value,
  placeholder,
  hint,
  onType,
  onCommit,
}: {
  label: string;
  compact?: boolean;
  value: string;
  placeholder?: string;
  hint?: string;
  onType: (v: string) => void;
  onCommit: (v: string) => void;
}) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  // "/" focuses this field while it is on screen (app/keys.ts)
  useSlashTarget(ref);
  // After a commit the screen may take words out of the text (they became chips). The kit's field follows its `value`
  // only when that changes, and a commit can end on the value it started from (typed and committed in one go), so the
  // field is drawn again from `value` when what it shows no longer matches; focus stays in it.
  const [gen, setGen] = useState(0);
  const pending = useRef<{ focused: boolean } | null>(null);
  useLayoutEffect(() => {
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    const input = ref.current?.querySelector('input');
    if (input && input.value.replace(/\s+/g, ' ').trim() !== value) {
      setGen((g) => g + 1);
      if (p.focused) requestAnimationFrame(() => ref.current?.querySelector('input')?.focus());
    }
  });
  // the hint describes the input (the kit's SearchField takes no aria-describedby yet; ui/Field.tsx is F3's)
  useEffect(() => {
    const input = ref.current?.querySelector('input');
    if (!input) return;
    if (hint) input.setAttribute('aria-describedby', `${id}h`);
    else input.removeAttribute('aria-describedby');
  }, [hint, id, gen]);
  const typed = (e: React.SyntheticEvent) => (e.target instanceof HTMLInputElement ? e.target.value.replace(/\s+/g, ' ').trim() : null);
  const commit = (v: string, focused: boolean) => {
    pending.current = { focused };
    onCommit(v);
  };
  return (
    <div
      ref={ref}
      className={`act-search${compact ? ' act-search--bar' : ''}`}
      data-list-search=""
      onInput={() => {
        pending.current = null;
      }}
      onKeyDown={(e) => {
        const v = e.key === 'Enter' ? typed(e) : null;
        if (v != null) commit(v, true);
      }}
      onBlur={(e) => {
        // leaving for the field's own clear button is not leaving the field; leaving for a chip lets the chip decide
        if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
        if (e.relatedTarget instanceof Element && e.relatedTarget.closest('.fchips')) return;
        const v = typed(e);
        if (v != null) commit(v, false);
      }}
    >
      <SearchField key={gen} label={label} compact={compact} value={value} onChange={onType} placeholder={placeholder} />
      {hint ? (
        <p className="act-hint" id={`${id}h`}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}
