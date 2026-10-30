// "What recent buyers paid" and "How much trades against how little" (S2, screener-plan 3.5a and 3.5b), black,
// in the chart column after the chart. Both read the executed volume windows (/api/series/volume): each trade at
// the price it was executed at, bot round trips left out. The first sets today's quoted price against what the
// last 24 hours', 7 days' and 30 days' buyers paid on average, and says how few addresses that is; the second
// sets what traded against the pools' depth today, with NAM bought and sold per day over 14 days as stacked bars
// (the one place a series carries the buy and sell hues, because each part is a buy or a sell).
//
// Descriptive only: "above what buyers paid" is arithmetic, never a reason to act. A window the record does not
// cover is "—" with the reason; a route this server does not serve reads NOT_SERVED. A window that reaches back before
// the stored Osmosis record is complete (shared/osmosis-gap.ts) says so under the table, its figures as stored.
import type { ExecutedVolume, Overview, VolumeResponse } from '../../../../shared/types';
import { NOT_SERVED } from '../../../../shared/types';
import { Num, ProvScope, SkeletonBlock, SourceLine, derive, type Stamp } from '../../ui/index';
import type { ScopeItem } from '../../ui/index';
import { Bars, type BarPoint } from '../../ui/Bars';
import { NBSP, fmtCount, fmtNamRule, fmtPctRule, fmtUsdRule, fmtUsdWhole } from '../../lib/format';
import type { DailyTrades, HistoryLoad } from './data';
import { DAILY_DAYS } from './data';
import type { Depth } from './model';
import { PAID_WINDOWS, WINDOW_WORD, turnoverPct, vsPaidPct } from './series';
import { osmosisGapWindows, reachesOsmosisGap } from '../../../../shared/osmosis-gap';

export interface BuyersProps {
  volume: HistoryLoad<VolumeResponse>;
  daily: HistoryLoad<DailyTrades>;
  overview: Overview | null;
  depth: Depth | null;
  /** Rewind: the quoted price is the one at the rewound time, so it reads "then", never "now" */
  rewound?: boolean;
}

const fin = (x: number | null | undefined): x is number => x != null && Number.isFinite(x);
const WINDOW_LONG: Record<string, string> = { h24: 'Last 24 hours', d7: 'Last 7 days', d30: 'Last 30 days' };
/** A window as the gap sentence names it ("The 30-day window reaches back before then."). */
const WINDOW_SPAN: Record<string, string> = { h24: '24-hour', d7: '7-day', d30: '30-day' };

/** "—" with the reason for a figure whose route does not answer. */
const missing = (why: string): Stamp => ({ source: 'executed NAM swaps (hourly rows)', plain: 'Executed swaps', at: null, status: 'missing', note: why });

export function Buyers({ volume, daily, overview, depth, rewound = false }: BuyersProps) {
  const when = rewound ? 'then' : 'now';
  const v = volume.data;
  const why = volume.unserved ? NOT_SERVED : volume.error ?? NOT_SERVED;
  const volStamp: Stamp | null = v ? { ...v.prov, plain: 'Executed swaps' } : null;
  const priceStamp: Stamp | null = overview ? overview.price.usd.prov : null;
  const price = overview?.price.usd.value ?? null;
  const d7 = v?.windows.d7 ?? null;
  const vs7 = vsPaidPct(price, d7?.buyVwapUsd);
  const vsStamp = volStamp && priceStamp ? derive([priceStamp, volStamp], 'the quoted price against the average price the last 7 days’ buyers paid') : null;
  const notCovered = (w: ExecutedVolume | null): Stamp | null =>
    w ? null : volStamp ? { ...volStamp, status: 'missing', note: v?.start != null ? 'The record does not cover this window yet.' : 'No trade hour is recorded yet.' } : null;
  // the windows shown that reach back before the stored Osmosis record is complete
  const gapped = v ? PAID_WINDOWS.filter((w) => { const x = v.windows[w]; return !!x && reachesOsmosisGap(x.from); }) : [];

  // ---- what traded against the pools' depth
  const h24 = v?.windows.h24 ?? null;
  const usd24 = h24 ? h24.usd ?? (h24.usdPriced > 0 ? h24.usdPriced : null) : null;
  const usd7 = d7 ? d7.usd ?? (d7.usdPriced > 0 ? d7.usdPriced : null) : null;
  const turn24 = turnoverPct(usd24, depth?.usd);
  const turn7 = turnoverPct(usd7, depth?.usd);
  const turnStamp = volStamp && depth ? derive([volStamp, depth.stamp], 'dollars traded at the prices paid / the pools’ depth now') : null;

  const scope: ScopeItem[] = [
    ...(volStamp ? [{ label: 'Average prices paid and received', p: volStamp }] : [{ label: 'Average prices paid and received', p: missing(why) }]),
    ...(priceStamp ? [{ label: `Quoted price ${when}`, p: priceStamp }] : []),
    ...(vsStamp ? [{ label: `${rewound ? 'Then' : 'Now'} against what buyers paid`, p: vsStamp }] : []),
  ];
  const turnScope: ScopeItem[] = [
    ...(turnStamp ? [{ label: 'Traded against the pools’ depth', p: turnStamp }] : [{ label: 'Traded against the pools’ depth', p: missing(why) }]),
    ...(depth ? [{ label: 'Pool depth now', p: depth.stamp }] : []),
  ];

  // ---- 14 days of NAM bought and sold, a stacked bar per day
  const dd = daily.data;
  const bars: BarPoint[] = (() => {
    if (!dd) return [];
    const by = new Map<number, { buy: number; sell: number }>();
    for (const p of dd.buy.points) if (fin(p.v)) by.set(p.t, { buy: p.v, sell: by.get(p.t)?.sell ?? 0 });
    for (const p of dd.sell.points) if (fin(p.v)) by.set(p.t, { buy: by.get(p.t)?.buy ?? 0, sell: p.v });
    return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([t, s]) => ({ t, nam: s.buy + s.sell, stack: s }));
  })();
  const dayMs = 86_400_000;
  const dEnd = dd ? Math.ceil(dd.buy.to / dayMs) * dayMs : 0;
  const dStart = dEnd - DAILY_DAYS * dayMs;
  const dStart0 = dd ? Math.min(dd.buy.start ?? Infinity, dd.sell.start ?? Infinity) : Infinity;

  return (
    <div className="tk-buyers">
      <section className="tk-sub" aria-labelledby="h-buyers" data-prov-scope="">
        <h2 id="h-buyers" className="h2">What recent buyers paid</h2>
        {volume.loading ? (
          <SkeletonBlock height={160} />
        ) : !v ? (
          <p className="tk-miss">Average prices paid and received: <Num v={null} prov={missing(why)} /></p>
        ) : (
          <>
            <p className="lead">
              {rewound ? 'Then' : 'Now'} <Num as="b" v={price} fmt={fmtUsdRule} showReason={false} />
              {fin(vs7) ? (
                <>, <Num as="b" v={Math.abs(vs7)} fmt={(n) => fmtPctRule(n, 1)} /> {vs7 >= 0 ? 'above' : 'below'} what the last 7 days’ buyers paid on average.</>
              ) : (
                <>. What the last 7 days’ buyers paid: <Num v={null} prov={notCovered(d7) ?? missing('no buy in the last 7 days had a price')} /></>
              )}
            </p>
            <div className="tk-paid" role="table" aria-label="What buyers paid and sellers got, by window">
              {PAID_WINDOWS.map((w) => {
                const x = v.windows[w];
                return (
                  <div key={w} className="tk-paid__r" role="row">
                    <span className="tk-paid__w" role="cell">{WINDOW_LONG[w] ?? WINDOW_WORD[w]}</span>
                    {x ? (
                      <>
                        <span className="tk-paid__b" role="cell">
                          Buyers paid <Num as="b" v={x.buyVwapUsd} fmt={fmtUsdRule} prov={x.buyVwapUsd == null ? { ...volStamp!, status: 'missing', note: x.buys ? 'none of the buys had a price' : 'no buy in this window' } : undefined} />
                          <span className="tk-paid__n"> (<span data-num="">{fmtCount(x.buyers)}</span> {x.buyers === 1 ? 'address' : 'addresses'}, <span data-num="">{fmtNamRule(x.buyNam)}</span>{NBSP}NAM)</span>
                        </span>
                        <span className="tk-paid__s" role="cell">
                          Sellers got <Num as="b" v={x.sellVwapUsd} fmt={fmtUsdRule} prov={x.sellVwapUsd == null ? { ...volStamp!, status: 'missing', note: x.sells ? 'none of the sells had a price' : 'no sell in this window' } : undefined} />
                          <span className="tk-paid__n"> (<span data-num="">{fmtCount(x.sellers)}</span> {x.sellers === 1 ? 'address' : 'addresses'}, <span data-num="">{fmtNamRule(x.sellNam)}</span>{NBSP}NAM)</span>
                        </span>
                      </>
                    ) : (
                      <span className="tk-paid__b" role="cell"><Num v={null} prov={notCovered(x)} /></span>
                    )}
                  </div>
                );
              })}
            </div>
            {d7 && d7.buyers > 0 && d7.buyers <= 5 ? (
              <p className="cap">
                Only <span data-num="">{fmtCount(d7.buyers)}</span> {d7.buyers === 1 ? 'address' : 'addresses'} bought in the last 7 days, so these averages are their trades, not a broad market.
              </p>
            ) : null}
            {PAID_WINDOWS.some((w) => v.windows[w]?.tradersHow === 'distinct_per_hour_summed') ? (
              <p className="cap">Addresses are counted once in each hour with a trade, and the hours added up, so one address trading in many hours counts many times.</p>
            ) : null}
            {v.windows.d30 ? (
              <p className="cap">
                <span data-num="">{fmtCount(v.windows.d30.hoursWithTrade)}</span> of the last <span data-num="">{fmtCount(v.windows.d30.hours)}</span> hours had a trade. An average over few trades moves with each one.
              </p>
            ) : null}
            {gapped.length ? <p className="cap tk-gap">{osmosisGapWindows(gapped.map((w) => WINDOW_SPAN[w] ?? WINDOW_WORD[w]))}</p> : null}
          </>
        )}
        <SourceLine items={scope} label="Where the average prices come from" />
      </section>

      <section className="tk-sub" aria-labelledby="h-turn" data-prov-scope="">
        <h2 id="h-turn" className="h2">How much trades against how little</h2>
        {volume.loading ? (
          <SkeletonBlock height={80} />
        ) : !v ? (
          <p className="tk-miss">What traded against the pools’ depth: <Num v={null} prov={missing(why)} /></p>
        ) : (
          <ProvScope className="tk-turn">
            <p className="lead">
              {fin(turn24) ? (
                <><Num as="b" v={turn24} fmt={(n) => fmtPctRule(n, 1)} /> of the pools’ depth traded in the last 24 hours</>
              ) : (
                <>Traded in the last 24 hours against the pools’ depth: <Num v={null} prov={notCovered(h24) ?? missing('no trade in the last 24 hours had a price')} /></>
              )}
              {fin(turn24) ? <>: <Num v={usd24} fmt={fmtUsdWhole} /> against <Num v={depth?.usd ?? null} fmt={fmtUsdWhole} showReason={false} />.</> : null}
            </p>
            {fin(turn7) ? (
              <p className="cap">
                In the last 7 days <Num v={usd7} fmt={fmtUsdWhole} /> traded, <Num v={turn7} fmt={(n) => fmtPctRule(n, 1)} /> of today’s depth. Depth is today’s reading, not each day’s.
              </p>
            ) : null}
          </ProvScope>
        )}
        {dd ? <SourceLine items={turnScope} label="Where the turnover comes from" /> : null}
        {daily.loading ? (
          <SkeletonBlock height={200} />
        ) : dd ? (
          <Bars
            bars={bars}
            from={dStart}
            to={dEnd}
            stepMs={dayMs}
            start={Number.isFinite(dStart0) ? dStart0 : null}
            title="NAM bought and sold each day"
            headingId="h-daily"
            unit={<>NAM per UTC day over the last <span data-num="">{DAILY_DAYS}</span> days, bought and sold stacked, bot round trips left out.</>}
            scope={[{ label: 'NAM bought per day', p: { ...dd.buy.prov, plain: 'Executed swaps' } }, { label: 'NAM sold per day', p: { ...dd.sell.prov, plain: 'Executed swaps' } }]}
            startWhat="Trades recorded"
            stacked
          />
        ) : (
          <p className="tk-miss">NAM bought and sold each day: <Num v={null} prov={missing(daily.unserved ? NOT_SERVED : daily.error ?? NOT_SERVED)} /></p>
        )}
        {dd ? null : <SourceLine items={turnScope} label="Where the turnover comes from" />}
      </section>
    </div>
  );
}

export default Buyers;
