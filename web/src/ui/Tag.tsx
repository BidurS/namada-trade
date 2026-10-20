// Tag (system.md 8): sentence case, 12 px 500, 24 px high, 2 px radius, a 12 px SVG glyph plus
// a word. Flow tags carry the kind's hue on a 6 % tint and their expert term on tap (a button
// that opens the glossary popover). Category tags (Genesis, Foundation, Backer, Snapshot,
// "Static, dated …", Estimate) are outlined; show one only when it adds information.
import React from 'react';
import type { Chain, FlowKind } from '../../../shared/types';
import type { TagKind } from '../lib/kinds';
import { kindInfo } from '../lib/kinds';
import { glossaryEntry } from '../lib/glossary';
import { Ico } from './ico';
import { GlossPop, useGlossPop } from './Term';

export interface TagProps {
  /** A flow kind (design name or the API's FlowKind). */
  kind?: TagKind | FlowKind;
  /** The flow's chain: with an API bridge kind (ibc_in, ibc_out) the tag says where the NAM went. */
  chain?: Chain | null;
  /** A category tag with this text ("Genesis", "Estimate", "Static, dated 17 Oct 2026"). */
  cat?: React.ReactNode;
  /** Category look: outlined (cat), ink outline (ref, e.g. "Sets the price"), or yellow (you). */
  look?: 'cat' | 'ref' | 'you';
  /** Show the ring glyph on a category tag. */
  ring?: boolean;
  /** Glossary entry for a category tag (makes it a button). */
  term?: string;
  /** Flow tags are buttons by default; `plain` renders a non-interactive span (e.g. inside a link). */
  plain?: boolean;
  className?: string;
}

export function Tag({ kind, chain, cat, look = 'cat', ring, term, plain, className = '' }: TagProps) {
  const { btnRef, popRef, popId } = useGlossPop();
  if (kind) {
    const k = kindInfo(kind, chain);
    const g = k.term ? glossaryEntry(k.term) : undefined;
    const cls = `tag tag--flow tag--${k.hue} ${className}`;
    const inner = (
      <>
        <Ico name={k.glyph} className="gly" />
        {k.word}
      </>
    );
    if (plain) return <span className={cls}>{inner}</span>;
    return (
      <>
        <button ref={btnRef} type="button" className={cls} aria-haspopup="dialog" aria-expanded="false" aria-label={`${k.word}. What this means.`}>
          {inner}
        </button>
        <GlossPop popRef={popRef} popId={popId} c={{ plain: k.word, expert: k.expert, text: g?.text }} />
      </>
    );
  }
  const cls = `tag tag--${look} ${className}`;
  const inner = (
    <>
      {ring ? <Ico name="ring" className="gly" /> : null}
      {cat}
    </>
  );
  const g = term ? glossaryEntry(term) : undefined;
  if (!g || plain) return <span className={cls}>{inner}</span>;
  return (
    <>
      <button ref={btnRef} type="button" className={cls} aria-haspopup="dialog" aria-expanded="false">
        {inner}
      </button>
      <GlossPop popRef={popRef} popId={popId} c={{ plain: g.plain, expert: g.expert, text: g.text }} />
    </>
  );
}

export default Tag;
