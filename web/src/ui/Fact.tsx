// Fact strip (system.md 8): 3 columns (4 on Holders, 2 x 2 on phones), 24 px numbers, 13 px
// labels, a 2 px ink top rule and hairlines between columns, and ONE SourceLine under the strip
// for all of its figures (a ProvScope, N1 as clarified).
//
// The SourceLine's height is held from the first frame (a placeholder until a figure's stamp
// arrives), so the band does not grow when data lands. `old` dims every figure once and the
// strip says why in one sentence (`oldSentence`); `sourceText` replaces the line's summary
// (e.g. "current, not as of the rewound time").
import React from 'react';
import type { ScopeItem } from './Sheet';
import { SourceLine } from './SourceLine';

export interface FactItem {
  /** The figure, usually a <Num> (no stamp of its own: the strip's SourceLine covers it). */
  n: React.ReactNode;
  label: React.ReactNode;
  /** Its scope entry for the SourceLine (label and stamp). */
  scope?: ScopeItem;
}

export interface FactProps {
  items: FactItem[];
  /** Sheet title for the strip's SourceLine. */
  sourceLabel?: string;
  /** Text after the SourceLine's lead word instead of its summary (include your own " · "). */
  sourceText?: string | ((now: number) => string);
  /** Every figure in the strip is old: dim once (.is-old). */
  old?: boolean;
  /** The one sentence that says why the strip is dimmed (shown under the strip when `old`). */
  oldSentence?: React.ReactNode;
  /** Extra content between the strip and its SourceLine. */
  children?: React.ReactNode;
  className?: string;
}

export function Fact({ items, sourceLabel = 'Where these figures come from', sourceText, old, oldSentence, children, className = '' }: FactProps) {
  const scope = items.map((i) => i.scope).filter((s): s is ScopeItem => !!s);
  const cols = items.length === 4 ? ' facts--4' : items.length === 2 ? ' facts--2' : '';
  return (
    <div className={`scope-facts${old ? ' is-old' : ''} ${className}`} data-prov-scope="">
      <ul className={`facts${cols}`}>
        {items.map((it, i) => (
          <li key={i} className="fact">
            <span className="fact__n">{it.n}</span>
            <span className="fact__l">{it.label}</span>
          </li>
        ))}
      </ul>
      {old && oldSentence ? (
        <p className="scope__old facts__old">
          <i className="dot" data-status="old" aria-hidden="true" />
          <span>{oldSentence}</span>
        </p>
      ) : null}
      {children}
      {scope.length ? <SourceLine items={scope} label={sourceLabel} text={sourceText} /> : <p className="src src--wait" aria-hidden="true" />}
    </div>
  );
}

export default Fact;
