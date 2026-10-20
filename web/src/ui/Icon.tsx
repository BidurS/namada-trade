// Icons (F1). One 24 px grid with a 1.5 px round stroke (`.ico`, 1.9 on the active tab) and
// 12 px flow glyphs (`.gly`). The reference set is the ICONS block of
// docs/design/final/build.mjs; the four new glyphs (bot, pgf, pool-add, pool-remove) and
// copy, external, download are drawn on the same grids. No Unicode dingbats anywhere.
//
//   <Icon name="search" />                 24 px grid, class "ico" (20 px box) by default
//   <Icon name="buy" className="gly" />    12 px glyph
//   <Glyph name="buy" />                   the same, shorter
//
// Icons are decorative (aria-hidden) unless `title` is given; the control around them
// carries the accessible name.
import React from 'react';

type Shape =
  | readonly ['p', string]
  | readonly ['c', number, number, number]
  | readonly ['r', number, number, number, number, number];

/** 24 px grid */
const ICONS = {
  home: [['p', 'M4 11 12 4l8 7v8.5a.5.5 0 0 1-.5.5H15v-6H9v6H4.5a.5.5 0 0 1-.5-.5z']],
  trade: [['p', 'M7 20V5M7 5 3.5 8.5M7 5l3.5 3.5M17 4v15M17 19l-3.5-3.5M17 19l3.5-3.5']],
  supply: [['p', 'm12 4-9 4.5 9 4.5 9-4.5zM3 12.5l9 4.5 9-4.5M3 16.5l9 4.5 9-4.5']],
  shielded: [['p', 'M12 3 4.5 6v5.5c0 4.4 3.1 7.8 7.5 9.5 4.4-1.7 7.5-5.1 7.5-9.5V6z']],
  activity: [['p', 'M3 12h4l2.5-6 4 12 2.5-6H21']],
  alerts: [['p', 'M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0']],
  search: [['c', 11, 11, 6.5], ['p', 'm16 16 4.5 4.5']],
  account: [['c', 12, 8.5, 3.8], ['p', 'M4.5 20c.8-3.6 3.8-5.5 7.5-5.5s6.7 1.9 7.5 5.5']],
  rewind: [['p', 'M4 12a8 8 0 1 0 2.6-5.9M4 4.5v4h4M12 8v4.5l3 1.8']],
  arrow: [['p', 'M4 12h15M13.5 6.5 19 12l-5.5 5.5']],
  close: [['p', 'm6 6 12 12M18 6 6 18']],
  chev: [['p', 'm6 9 6 6 6-6']],
  filter: [['p', 'M4 7h10M18 7h2M4 17h2M10 17h10'], ['c', 16, 7, 2], ['c', 8, 17, 2]],
  info: [['c', 12, 12, 8.5], ['p', 'M12 11v5.5M12 7.8v.4']],
  warn: [['p', 'M12 4 2.8 19.5h18.4zM12 10v4.5M12 16.8v.4']],
  check: [['p', 'm5 12.5 4.5 4.5L19 7.5']],
  copy: [['r', 8.5, 8.5, 11, 11, 1], ['p', 'M15.5 5.5V5a.5.5 0 0 0-.5-.5H5a.5.5 0 0 0-.5.5v10a.5.5 0 0 0 .5.5h.5']],
  external: [['p', 'M14 4.5h5.5V10M19.5 4.5 11 13M17 14v5a.5.5 0 0 1-.5.5h-11A.5.5 0 0 1 5 19V8a.5.5 0 0 1 .5-.5H10']],
  download: [['p', 'M12 4v11M7 10.5l5 5 5-5M5 20h14']],
} as const satisfies Record<string, readonly Shape[]>;

/** 12 px grid (flow glyphs; stroke 1.4 via `.gly`) */
const GLYPHS = {
  buy: [['p', 'M3 9l6-6M4 3h5v5']],
  sell: [['p', 'M3 3l6 6M9 4v5H4']],
  shield: [['p', 'M6 1.2 2.2 2.7v3c0 2.4 1.6 4 3.8 4.9 2.2-.9 3.8-2.5 3.8-4.9v-3z']],
  lock: [['r', 2.5, 5.5, 7, 5, 0.5], ['p', 'M4 5.5V4a2 2 0 0 1 4 0v1.5']],
  bridge: [['p', 'M1.5 8.5a4.5 4.5 0 0 1 9 0M3 8.5v2M9 8.5v2M1 10.5h10']],
  ring: [['c', 6, 6, 3.6]],
  /** Bot trade: a round trip */
  bot: [['p', 'M2.2 5.2A3.9 3.9 0 0 1 9 3.4M9.8 6.8A3.9 3.9 0 0 1 3 8.6M9.2 1.4v2.2H7M2.8 10.6V8.4H5']],
  /** Public funding: a civic building */
  pgf: [['p', 'M1.5 4.3 6 1.8l4.5 2.5zM2.8 5.6v3.6M6 5.6v3.6M9.2 5.6v3.6M1.2 10.6h9.6']],
  /** Added to pool: a pool with a plus */
  'pool-add': [['p', 'M1.5 6.2h9a4.5 4.2 0 0 1-9 0zM6 .9v3.4M4.3 2.6h3.4']],
  /** Removed from pool: a pool with a minus */
  'pool-remove': [['p', 'M1.5 6.2h9a4.5 4.2 0 0 1-9 0zM4.3 2.6h3.4']],
  arrow: [['p', 'M1.5 6h8.5M7 3l3 3-3 3']],
  check: [['p', 'm2.2 6.3 2.4 2.4 5.2-5.2']],
} as const satisfies Record<string, readonly Shape[]>;

export type GridIconName = keyof typeof ICONS;
export type GlyphName = keyof typeof GLYPHS;
export type IconName = GridIconName | GlyphName;

export const ICON_NAMES = Object.keys(ICONS) as GridIconName[];
export const GLYPH_NAMES = Object.keys(GLYPHS) as GlyphName[];

const draw = (shapes: readonly Shape[]) =>
  shapes.map((s, i) =>
    s[0] === 'p' ? <path key={i} d={s[1]} />
    : s[0] === 'c' ? <circle key={i} cx={s[1]} cy={s[2]} r={s[3]} />
    : <rect key={i} x={s[1]} y={s[2]} width={s[3]} height={s[4]} rx={s[5]} />,
  );

export interface IconProps extends Omit<React.SVGProps<SVGSVGElement>, 'name' | 'ref'> {
  name: IconName;
  /** `ico` (20 px, default), `ico ico--btn`, `ico ico--inline`, `gly`, `gly gly--lg`, or your own sized class. */
  className?: string;
  /** Makes the icon an image with this name; omit for decorative icons (the usual case). */
  title?: string;
}

/**
 * One icon. A name that exists on both grids (arrow, check) draws the 12 px glyph when the
 * class is a glyph class (`gly`), else the 24 px icon. An unknown name draws nothing.
 */
export function Icon({ name, className = 'ico', title, ...rest }: IconProps) {
  const wantsGlyph = /\bgly\b/.test(className);
  const glyph = (GLYPHS as Record<string, readonly Shape[]>)[name];
  const icon = (ICONS as Record<string, readonly Shape[]>)[name];
  const useGlyph = glyph && (wantsGlyph || !icon);
  const shapes = useGlyph ? glyph : icon;
  if (!shapes) return null;
  return (
    <svg
      className={className}
      viewBox={useGlyph ? '0 0 12 12' : '0 0 24 24'}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      focusable="false"
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {draw(shapes)}
    </svg>
  );
}

/** A 12 px flow glyph (`.gly`). */
export function Glyph({ name, className = 'gly', ...rest }: Omit<IconProps, 'name'> & { name: GlyphName }) {
  return <Icon name={name} className={className} {...rest} />;
}
