// HeroNumber (system.md 8): the one large moment of a screen. Label above (13 px 500 ink-2)
// with the ProvChip on the label row, the value (display 64-80, 48 or 32 px), a delta pill
// (inverse fill, a triangle, signed, two decimals) and "since this time yesterday".
import React from 'react';
import { fmtPctSigned } from '../lib/format';

export interface HeroNumberProps {
  label: React.ReactNode;
  /** The figure, usually <Num> or <Num fmt={fmtPriceNode}> for a sub-dollar price. */
  value: React.ReactNode;
  /** Signed change in percent; null shows "no change figure" in words, never a stand-in. */
  delta?: { v: number | null | undefined; since?: string; reason?: string };
  /** The ProvChip for this figure (hero figures are where chips belong). */
  chip?: React.ReactNode;
  /** One sentence under the figure. */
  sub?: React.ReactNode;
  size?: 'display' | '48' | '32';
  className?: string;
}

const Tri = ({ up }: { up: boolean }) => (
  <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">
    <path d={up ? 'M6 2.5 10 9H2z' : 'M6 9.5 10 3H2z'} fill="currentColor" />
  </svg>
);

export function HeroNumber({ label, value, delta, chip, sub, size = 'display', className = '' }: HeroNumberProps) {
  const d = delta?.v;
  const has = d != null && Number.isFinite(d);
  return (
    <div className={`hero-n hero-n--${size} ${className}`}>
      <div className="hero-n__top">
        <p className="hero-n__label">{label}</p>
        {chip}
      </div>
      <p className="hero-n__v">{value}</p>
      {delta ? (
        <p className="hero-n__meta">
          {has ? (
            <span className="delta" data-num="">
              {d !== 0 ? <Tri up={(d as number) > 0} /> : null}
              {fmtPctSigned(d)}
            </span>
          ) : (
            <span className="delta" data-num="" data-status="none">—</span>
          )}
          <span className="hero-n__since">{has ? delta.since ?? 'since this time yesterday' : delta.reason ?? 'no figure for this time yesterday'}</span>
        </p>
      ) : null}
      {sub ? <p className="hero-n__sub">{sub}</p> : null}
    </div>
  );
}

export default HeroNumber;
