// The desktop "Right now" rail (system.md 9.1, desktop): four figures beside the narrative, each with
// its own ProvDot, sticky under the header. Hidden below 1024 px (the same figures appear in the
// sections on phones).
import type { Check, Overview, Pressure } from '../../../../shared/types';
import { Num, ProvDot } from '../../ui/index';
import { checksStamp, type Stamp } from '../../lib/prov';
import { fmtNamRule, fmtUsdWhole } from '../../lib/format';
import type { Res } from './data';
import { daysText } from './Path';

export interface RailProps {
  o: Overview | null;
  osmoP: Stamp | null;
  pressure: Res<Pressure>;
  waitP: Stamp | null;
  checks: Check[];
  rewound: boolean;
  /** The overview never answered: each figure's dot says "no data" and why, under its own source. */
  failed?: boolean;
  why?: string | null;
}

export function Rail({ o, osmoP, pressure, waitP, checks, rewound, failed, why }: RailProps) {
  const ok = checks.filter((c) => c.status === 'ok').length;
  const none = (source: Pick<Stamp, 'source' | 'plain'>): Stamp | null => (!o && failed ? { ...source, at: null, status: 'missing', note: why ?? 'The data service did not answer.' } : null);
  const cs = !o && failed ? { ...checksStamp([]), note: why ?? 'The data service did not answer.' } : checksStamp(checks);
  const dexP = o?.dex.prov ?? none({ source: 'Osmosis SQS pools', plain: 'Osmosis pools' });
  const osmP = osmoP ?? none({ source: 'Osmosis bank', plain: 'Osmosis supply' });
  return (
    <aside className="rail" aria-labelledby="home-rail">
      <div className="rail__in">
        <h2 id="home-rail" className="rail__h">{rewound ? 'At that moment' : 'Right now'}</h2>
        <dl className="rail__list">
          <div data-prov-group="">
            <dt>Pool depth</dt>
            <dd><Num v={o?.dex.liquidityUsd} prov={dexP} fmt={fmtUsdWhole} showAge={false} showReason={false} /></dd>
            <dd><ProvDot p={dexP} label="Money in the Osmosis pools" /></dd>
          </div>
          <div data-prov-group="">
            <dt>NAM on Osmosis</dt>
            <dd><Num v={o?.supply.osmosis} prov={osmP} fmt={fmtNamRule} unit="NAM" showAge={false} showReason={false} /></dd>
            <dd><ProvDot p={osmP} label="NAM on Osmosis" /></dd>
          </div>
          <div data-prov-group="">
            <dt>Unstaking wait</dt>
            <dd><Num v={pressure.data?.unbondingDays} prov={waitP} fmt={daysText} unit="days" showAge={false} showReason={false} /></dd>
            <dd><ProvDot p={waitP} label="Unstaking wait" /></dd>
          </div>
          <div data-prov-group="">
            <dt>Cross-checks</dt>
            <dd>
              {checks.length ? (
                <span data-num="" data-status="fresh">{ok} of {checks.length}<span className="u"> pass</span></span>
              ) : (
                <span data-num="" data-status="none">—</span>
              )}
            </dd>
            <dd><ProvDot p={cs} label="Cross-checks" text={checks.length ? undefined : rewound ? 'Cross-checks · not recorded then' : undefined} /></dd>
          </div>
        </dl>
      </div>
    </aside>
  );
}
