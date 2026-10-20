// The mark and the wordmark (F1; owner decision 1: the dial).
//
// The dial: a ring open at the top right, a needle, a hub (system.md 8, "Icon, Wordmark and
// mark"). It says "a reading", is distinct from Namada's symbol, and survives at 16 px.
// Yellow on black in the header (32 px) and footer (40 px); the favicon and app icons in
// web/public are drawn from the same three shapes (MARK_SHAPES).
//
//   <Mark className="brand__mark" />           decorative; the link around it is named
//   <Wordmark />                               "NAMADA TRADE", TRADE in --accent-text
//   <Mark title="Namada Trade" />              when the mark stands alone as an image

/** The dial on a 32 unit grid. Single source for the React mark and the static icons. */
export const MARK_SHAPES = {
  viewBox: '0 0 32 32',
  ring: { d: 'M16 3.5a12.5 12.5 0 1 0 12.5 12.5', strokeWidth: 4.5 },
  needle: { d: 'M16 16 25 7', strokeWidth: 3.2 },
  hub: { cx: 16, cy: 16, r: 2.6 },
} as const;

export interface MarkProps {
  className?: string;
  /** Accessible name when the mark is shown on its own; omit when a labelled link wraps it. */
  title?: string;
}

export function Mark({ className = 'mark', title }: MarkProps) {
  const m = MARK_SHAPES;
  return (
    <svg className={className} viewBox={m.viewBox} aria-hidden={title ? undefined : true} role={title ? 'img' : undefined} focusable="false">
      {title ? <title>{title}</title> : null}
      <path d={m.ring.d} fill="none" stroke="currentColor" strokeWidth={m.ring.strokeWidth} />
      <path d={m.needle.d} fill="none" stroke="currentColor" strokeWidth={m.needle.strokeWidth} />
      <circle cx={m.hub.cx} cy={m.hub.cy} r={m.hub.r} fill="currentColor" />
    </svg>
  );
}

export interface WordmarkProps {
  /** Class for the text (the header uses `brand__word`, the footer styles it through `.foot__brand`). */
  className?: string;
}

/** "NAMADA TRADE": Space Grotesk 700 caps, tracking 0.06em, TRADE in --accent-text (CSS: .wordmark). */
export function Wordmark({ className = 'wordmark' }: WordmarkProps) {
  return (
    <span className={className}>
      Namada <b>Trade</b>
    </span>
  );
}
