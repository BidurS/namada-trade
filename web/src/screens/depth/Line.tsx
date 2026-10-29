// The two quotable numbers (ux-principles 14) as one line for Home's Trade section and Trade's "Where NAM trades":
// what selling the quotable size fetches across every pool and the USD of bids within the quoted distance of the
// price, each from the newest stored minute with that minute's own time (a ProvDot), linking to /depth. Live only:
// the minute takes no `at`. A server without the route, or one that did not answer, is a missing figure with its
// reason in view, never a stand-in and never a fault.
import { DEPTH_LINK, DEPTH_OFFSETS_PCT, DEPTH_PLAIN_SOURCE, DEPTH_QUOTABLE_SIZE, LINE_BID_LABEL, LINE_DOT_LABEL, LINE_SELL_LABEL, LINE_SOURCE, OFFSET_10_INDEX, SELL_QUOTABLE_TAIL, bidQuotableTail, sellQuotableLead } from '../../../../shared/depth';
import { Link } from '../../app/index';
import { Icon, Num, ProvDot, SkeletonBlock, type Stamp } from '../../ui/index';
import { fmtNamRule, fmtPctRule, fmtUsdRule } from '../../lib/format';
import { useDepthLatest } from './data';
import { depthStamp, storedFill } from './model';

export interface DepthLineProps {
  live: boolean;
  symbol: string;
  className?: string;
}

export function DepthLine({ live, symbol, className = '' }: DepthLineProps) {
  const r = useDepthLatest(live, '', null);
  if (!live) return null;
  const d = r.data;
  const stamp: Stamp | null = d ? depthStamp(d) : r.error ? { source: LINE_SOURCE, plain: DEPTH_PLAIN_SOURCE, at: null, status: 'missing', note: r.error } : null;
  const fill = d ? storedFill(d, 'sell', DEPTH_QUOTABLE_SIZE) : null;
  const nam = fmtNamRule(DEPTH_QUOTABLE_SIZE);
  const pct = fmtPctRule(DEPTH_OFFSETS_PCT[OFFSET_10_INDEX], 0);
  return (
    <p className={`cap dp-line ${className}`} data-prov-group="">
      {!stamp ? (
        <SkeletonBlock height={16} width="60%" />
      ) : d && fill?.complete ? (
        <>
          <span>{sellQuotableLead(nam, symbol)} </span>
          <Num v={fill.usd} prov={stamp} fmt={fmtUsdRule} showAge={false} showReason={false} as="b" label={LINE_SELL_LABEL} />
          <span> {SELL_QUOTABLE_TAIL} · </span>
          <Num v={d.within.bidUsd10} prov={stamp} fmt={fmtUsdRule} showAge={false} showReason={false} as="b" label={LINE_BID_LABEL} />
          <span> {bidQuotableTail(pct)}</span>
          {' '}<ProvDot p={stamp} label={LINE_DOT_LABEL} />
        </>
      ) : (
        <>
          {sellQuotableLead(nam, symbol)} <Num v={null} prov={stamp} label={LINE_SELL_LABEL} />
        </>
      )}
      {' '}
      <Link to="/depth" className="dp-line__a">{DEPTH_LINK}<Icon name="arrow" className="ico ico--inline" /></Link>
    </p>
  );
}

export default DepthLine;
