// FilterChips (docs/design/nav-search-plan.md 3.5): the active-filter strip. One chip per filter that is on and per
// word the list's search field understood, in plain words; each chip is a button that removes it ("Remove filter:
// At least 100,000 NAM"), 44 px high with a 12 px close glyph, in the selected-chip look (system.md 8 Chip). A word
// that was understood but is not applied (a holders word on the moves list, a second size) keeps a chip with a dashed
// edge and its note in view, so no chip ever says a filter is on when it is not. The row scrolls sideways on phones
// (edge fade, no scrollbar) and wraps from 640 px; it renders nothing when no filter is on.
//
// Focus: removing a chip moves focus to the chip now in its place (or the one before it); removing the last one calls
// `onEmpty` (the screen focuses its search field), so focus is never dropped onto the page.
import { useLayoutEffect, useRef } from 'react';
import { Icon } from './Icon';

export interface FilterChip {
  /** Stable across renders (the filter, or the word's position and text). */
  key: string;
  /** What is on, in plain words ("Sells only"). */
  label: string;
  /** Why it was read this way, or why it is left out; shown in the chip. */
  note?: string;
  /** False: understood but not applied (dashed edge, the note says why). Default true. */
  applied?: boolean;
  onRemove: () => void;
}

export interface FilterChipsProps {
  chips: FilterChip[];
  /** Accessible name of the strip. */
  label?: string;
  /** A last chip that removes every filter, shown from two chips on. */
  clearLabel?: string;
  onClear?: () => void;
  /** Called after the last chip was removed (the screen moves focus to its search field). */
  onEmpty?: () => void;
  className?: string;
}

export function FilterChips({ chips, label = 'Filters on', clearLabel = 'Clear all', onClear, onEmpty, className = '' }: FilterChipsProps) {
  const ref = useRef<HTMLUListElement>(null);
  /** After a removal: the index whose chip takes focus once the strip has re-rendered. */
  const refocus = useRef<number | null>(null);
  useLayoutEffect(() => {
    const i = refocus.current;
    if (i == null) return;
    refocus.current = null;
    const btns = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button.fchip:not(.fchip--clear)') ?? [])];
    if (btns.length) btns[Math.min(i, btns.length - 1)].focus();
    else onEmpty?.();
  });
  if (!chips.length) return null;
  const remove = (i: number, fn: () => void) => {
    const inside = !!ref.current?.contains(document.activeElement);
    fn();
    if (inside) refocus.current = Math.max(0, i);
  };
  return (
    <div className={`fchips ${className}`} role="group" aria-label={label}>
      <ul className="fchips__row" ref={ref}>
        {chips.map((c, i) => {
          const out = c.applied === false;
          const name = out ? `Remove: ${c.label}, not applied.${c.note ? ` ${c.note}` : ''}` : `Remove filter: ${c.label}${c.note ? `. ${c.note}` : ''}`;
          return (
            <li key={c.key} className="fchips__i">
              <button type="button" className={`fchip${out ? ' fchip--out' : ''}`} aria-label={name} onClick={() => remove(i, c.onRemove)}>
                <span className="fchip__t">
                  <span className="fchip__l">{c.label}</span>
                  {c.note ? <span className="fchip__n">{c.note}</span> : null}
                </span>
                <Icon name="close" className="ico fchip__x" />
              </button>
            </li>
          );
        })}
        {onClear && chips.length > 1 ? (
          <li className="fchips__i">
            <button
              type="button"
              className="fchip fchip--clear"
              onClick={() => {
                const inside = !!ref.current?.contains(document.activeElement);
                onClear();
                if (inside) refocus.current = 0;
              }}
            >
              {clearLabel}
            </button>
          </li>
        ) : null}
      </ul>
    </div>
  );
}

export default FilterChips;
