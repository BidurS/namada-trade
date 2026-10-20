// SupplyBar (system.md 8): segments in a fixed order: Staked (label inside), Leaving staking (the
// staking account's NAM that is not stake: unstaking, withdrawable or unclaimed rewards; hatched in
// the staked colour), Public funding (hatched), Shielded, Everything else spendable (label inside),
// On Osmosis (--c-mark, with a flag above: "1.7% on Osmosis"). 44 px high (56 from 640), 2 px gaps, at least 4 px a segment,
// a real 0-100 % scale beneath, and a legend row per segment (swatch, name, share, NAM figure
// and a plain note). Shares are rounded so the legend sums to exactly 100 %. Segments grow once
// on first paint; the numbers are final from the first frame.
import React from 'react';
import { roundToTotal } from '../lib/format';

export type SupplyKey = 'staked' | 'unstaking' | 'pgf' | 'shielded' | 'rest' | 'osmosis';

export interface SupplySegment {
  key: SupplyKey;
  /** Legend name ("Staked", "Everything else spendable"). */
  name: string;
  /** Short label inside a large segment ("Staked", "Spendable"). */
  short?: string;
  /** NAM in this segment (the shares are computed from these). */
  nam: number | null;
  /** The NAM figure for the legend, usually <Num> (so its state shows). */
  namNode?: React.ReactNode;
  /** Plain note after the figure ("locked with validators, cannot be sold"). */
  note?: React.ReactNode;
}

export interface SupplyBarProps {
  segments: SupplySegment[];
  /** Hide the legend rows (the bar alone, e.g. a compact band). */
  legend?: boolean;
  /** Decimals on the shares (1 by default). */
  digits?: number;
  className?: string;
}

const ORDER: SupplyKey[] = ['staked', 'unstaking', 'pgf', 'shielded', 'rest', 'osmosis'];
const INSIDE_MIN = 15; // percent: below this a label does not fit inside its segment

export function SupplyBar({ segments, legend = true, digits = 1, className = '' }: SupplyBarProps) {
  const segs = ORDER.map((k) => segments.find((s) => s.key === k)).filter((s): s is SupplySegment => !!s);
  const known = segs.filter((s) => s.nam != null && Number.isFinite(s.nam) && (s.nam as number) >= 0);
  const total = known.reduce((a, s) => a + (s.nam as number), 0);
  if (!known.length || !(total > 0)) {
    return <p className={`cap ${className}`}>The supply split has no data right now.</p>;
  }
  const raw = known.map((s) => ((s.nam as number) / total) * 100);
  const shares = roundToTotal(raw, digits, 100);
  const share = (k: SupplyKey) => {
    const i = known.findIndex((s) => s.key === k);
    return i < 0 ? null : shares[i];
  };
  const pct = (v: number | null) => (v == null ? '—' : `${v.toFixed(digits)}%`);
  const osm = share('osmosis');
  const aria = `Supply bar: ${known.map((s, i) => `${s.name} ${pct(shares[i])}`).join(', ')}`;

  return (
    <div className={className}>
      <div className="supply" role="img" aria-label={aria}>
        <div className="supply__flag" aria-hidden="true">{osm != null ? <span>{pct(osm)} on Osmosis</span> : null}</div>
        <div className="supply__bar" aria-hidden="true">
          {known.map((s, i) => (
            <i key={s.key} className={`sg sg--${s.key}`} style={{ flex: `${raw[i]} 1 0%`, ['--i' as string]: i } as React.CSSProperties}>
              {raw[i] >= INSIDE_MIN && (s.key === 'staked' || s.key === 'rest') ? <span className="sg__l">{s.short ?? s.name} {pct(shares[i])}</span> : null}
            </i>
          ))}
        </div>
        <div className="supply__rule" aria-hidden="true" />
        <div className="supply__scale" aria-hidden="true"><span>0</span><span>25</span><span>50</span><span>75</span><span>100%</span></div>
      </div>
      {legend ? (
        <ul className="legend">
          {segs.map((s) => {
            const p = share(s.key);
            return (
              <li key={s.key} className={`lg lg--${s.key}`}>
                <i className={`lg__sw sg sg--${s.key}`} aria-hidden="true" />
                <span className="lg__n">{s.name}</span>
                <span className="lg__p" data-num="" data-status={p == null ? 'none' : undefined}>{pct(p)}</span>
                <span className="lg__v">
                  {s.namNode ?? (s.nam == null ? 'no data' : `${Math.round(s.nam).toLocaleString('en-US')} NAM`)}
                  {s.note ? <> · {s.note}</> : null}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

export default SupplyBar;
