// SourceLine: the panel footer, one button for every figure in the panel (system.md 8, 12).
// "● Source · {source | N sources} · {age or range} · {state word}"; only the lead word is
// underlined. Opens the scope sheet listing each figure (label, source, UTC time, age, state).
//
// ProvScope (N1 as clarified, owner decision 2): a number may sit inside a scope whose
// SourceLine exists, is visible and lists it. The button carries `data-scope` with the item
// labels so the N1 test can check that a scope lists its figures.
import React, { useState } from 'react';
import type { Stamp } from '../lib/prov';
import { STATUS_WORD, ageRange, plainSource, uiStatus, worstStatus } from '../lib/prov';
import { ScopeSheet, type ScopeItem } from './Sheet';
import { NBSP } from '../lib/format';
import { useUiNow } from './now';

export type { ScopeItem };

export interface SourceLineProps {
  items: ScopeItem[];
  /** Sheet title. Default "Where these figures come from". */
  label?: string;
  /** The underlined word. Default "Source". */
  lead?: string;
  /** Text after the lead word instead of " · {sources} · {ages} · {state}" (include your own separator). */
  text?: string | ((now: number) => string);
  /** Render only the button, without the <p class="src"> wrapper. */
  bare?: boolean;
  className?: string;
}

/** "Osmosis quote" / "Namada node, Osmosis supply" / "3 sources". */
export function sourcesText(items: ScopeItem[]): string {
  const names = Array.from(new Set(items.map((i) => (i.p ? plainSource(i.p) : 'no source'))));
  if (names.length === 0) return 'no source';
  if (names.length <= 2) return names.join(', ');
  return `${names.length} sources`;
}

/** " · " with a no-break space before the dot, so a wrapped line never starts with "·". */
const SEP = `${NBSP}· `;
/** Every " · " in a tail (the screens' own `text` too) keeps its dot on the line before. */
const glueSeps = (t: string) => t.replace(/ · /g, SEP);

export function scopeSummary(items: ScopeItem[], now: number): { status: ReturnType<typeof uiStatus>; text: string } {
  const stamps = items.map((i) => i.p).filter((p): p is Stamp => !!p);
  const worst = stamps.length ? worstStatus(stamps.map((s) => s.status)) : 'missing';
  const ui = uiStatus(worst);
  return { status: ui, text: `${SEP}${sourcesText(items)}${SEP}${ageRange(stamps, now)}${SEP}${STATUS_WORD[ui]}` };
}

export function SourceLine({ items, label, lead = 'Source', text, bare, className }: SourceLineProps) {
  const now = useUiNow();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const sum = scopeSummary(items, now);
  const tail = glueSeps(typeof text === 'function' ? text(now) : text ?? sum.text);
  const title = label ?? 'Where these figures come from';
  const btn = (
    <button
      type="button"
      className={`srcb ${bare ? className ?? '' : ''}`}
      data-status={sum.status}
      data-prov=""
      data-scope={items.map((i) => i.label).join('|')}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={() => {
        setMounted(true);
        setOpen(true);
      }}
    >
      <i className="dot" data-status={sum.status} aria-hidden="true" />
      <span>
        <span className="srcb__l">{lead}</span>
        {tail}
      </span>
    </button>
  );
  return (
    <>
      {bare ? btn : <p className={`src ${className ?? ''}`}>{btn}</p>}
      {mounted ? <ScopeSheet items={items} title={title} open={open} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/**
 * A ProvScope: the panel wrapper. `old` dims every figure inside once (.is-old) and prints
 * the one sentence that says why, above the data. Rows that differ carry their own mark.
 */
export function ProvScope({
  as: Tag = 'div',
  old,
  oldSentence,
  className = '',
  children,
  ...rest
}: {
  as?: 'div' | 'section' | 'aside';
  old?: boolean;
  /** "Balances were last checked 2.3 days ago, so they are shown dimmed." Required wording when old. */
  oldSentence?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
} & React.HTMLAttributes<HTMLElement>) {
  return (
    <Tag className={`scope${old ? ' is-old' : ''} ${className}`} data-prov-scope="" {...rest}>
      {old && oldSentence ? (
        <p className="scope__old">
          <i className="dot" data-status="old" aria-hidden="true" />
          <span>{oldSentence}</span>
        </p>
      ) : null}
      {children}
    </Tag>
  );
}

export default SourceLine;
