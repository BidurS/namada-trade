// Sparkline (Home hero, desktop): the executed price over the window, 64 px tall, measured in
// CSS px, a left-to-right wipe on first paint. Two points or fewer draw as dots, not a trend.
// The caption (change and its stamp) is the screen's, passed as children.
import React from 'react';
import { lin, pathOf } from './chartMath';
import { useSize } from './useSize';

export interface SparklineProps {
  points: { t: number; v: number }[];
  /** Accessible description ("Executed price, $0.000589 on 18 Sep to $0.001012 on 17 Oct"). */
  label: string;
  /** Caption under the line (e.g. "+72% since 18 Sep, executed price" and a ProvDot). */
  children?: React.ReactNode;
  className?: string;
}

export function Sparkline({ points, label, children, className = '' }: SparklineProps) {
  const [ref, { w, h }] = useSize<HTMLDivElement>();
  const P = points.filter((p) => Number.isFinite(p.v) && Number.isFinite(p.t)).sort((a, b) => a.t - b.t);
  const vs = P.map((p) => p.v);
  const lo = Math.min(...vs);
  const hi = Math.max(...vs);
  const X = lin(P[0]?.t ?? 0, P[P.length - 1]?.t ?? 1, 2, Math.max(3, w - 2));
  const Y = lin(lo, hi, Math.max(3, h - 3), 3);
  const pts = P.map((p) => [X(p.t), Y(p.v)] as [number, number]);
  return (
    <div className={`spark ${className}`}>
      <div className="spark__plot" ref={ref}>
        {w > 0 && P.length ? (
          <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label}>
            {pts.length > 2 ? (
              <g className="c-wipe">
                <path d={pathOf(pts)} />
              </g>
            ) : (
              pts.map(([x, y], i) => <circle key={i} cx={x} cy={y} r={3} />)
            )}
          </svg>
        ) : null}
      </div>
      {children ? <p className="spark__c">{children}</p> : null}
    </div>
  );
}

export default Sparkline;
