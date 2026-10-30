// "Where NAM trades" (system.md 9.2, screener-plan 2.4): the NAM pools on Osmosis, below the split, full width,
// black. With the pairs route answering, each pool is a row of the pairs list (ui/PairsList.tsx): size and share,
// the Osmosis data API's dollars traded in 24 h and 7 days with its own update time, the trades this site recorded
// through the pool, both coins inside and the fee. Without it, the stored pool list as before, and one line says
// the volume per pool is not served yet ("—" with the reason, never a stand-in). A pool's size is its coins at their
// own prices (worker/src/pool-sizes.ts); one that cannot be priced reads "—" with the reason and counts in no total.
// The pool list is the newest stored reading: under Rewind it is not requested, and the overview's figures as of that
// time stand in its place, each with its own stamp. One SourceLine under the list.
import type { ReactNode } from 'react';
import type { Overview, PairRow, PairsResponse, PoolInfo, Provenance } from '../../../../shared/types';
import { NOT_SERVED } from '../../../../shared/types';
import { REWIND_WORDS } from '../../app/index';
import { DataList, Notice, Num, PoolRestRow, PoolRow, ProvScope, Skeleton, SourceLine, useUiNow } from '../../ui/index';
import type { ScopeItem, Stamp } from '../../ui/index';
import { Inside, PairsList } from '../../ui/PairsList';
import { NBSP, fmtAgo, fmtCount, fmtNamRule, fmtPctRule, fmtUsdWhole } from '../../lib/format';
import type { Depth } from './model';
import { counterName, pairName, restOf, splitPools } from './model';
import { oneSidedWords, poolSides, pricedTotal, totalNotKnownWords } from '../../../../shared/pool-sides';
import type { HistoryLoad } from './data';
import { DepthLine } from '../depth/Line';
import { SITE_SYMBOL } from '../../../../shared/depth';

export interface PoolsProps {
  rewound: boolean;
  pools: { data: { pools: PoolInfo[]; prov: Provenance } | null; error: string | null; loading: boolean };
  /** the pairs list (/api/series/pairs): live only */
  pairs?: HistoryLoad<PairsResponse> | null;
  depth: Depth | null;
  overview: Overview | null;
}

/** The pairs answer as rows: the pools above the share line (at most POOL_ROW_MAX), the rest folded into one row. */
function PairsBody({ r, osmosisLine }: { r: PairsResponse; osmosisLine: ReactNode }) {
  const now = useUiNow();
  const { shown, rest, oneSided } = splitPools<PairRow>(r.pairs);
  const stamp: Stamp = { ...r.prov, plain: 'Osmosis pools' };
  // the pools' money only when the priced pools hold the NAM a total needs (shared/pool-sides.ts pricedTotal); each
  // pool's share is of that total, and none without it
  const sum = pricedTotal(r.pairs);
  const total = sum.usd;
  const totalStamp: Stamp | undefined = total == null ? { ...stamp, status: 'missing', note: totalNotKnownWords(sum) } : undefined;
  const osmoStamp: Stamp = { ...r.osmosisProv, plain: 'Osmosis app data' };
  const hereProv = r.pairs.find((p) => p.here24h.value)?.here24h.prov ?? r.pairs[0]?.here24h.prov ?? null;
  const hereStamp: Stamp | null = hereProv ? { ...hereProv, plain: 'Flow index' } : null;
  const hereTotal = r.pairs.reduce((a, p) => a + (p.here24h.value?.trades ?? 0), 0);
  const anyHere = r.pairs.some((p) => p.here24h.value);
  const share = shown[0] && total != null && total > 0 && shown[0].liquidityUsd != null ? (shown[0].liquidityUsd / total) * 100 : null;
  const items: ScopeItem[] = [
    { label: 'Pool depth, the coins inside and fee', p: stamp },
    { label: 'Dollars traded per pool (Osmosis pair summary)', p: osmoStamp },
    ...(hereStamp ? [{ label: 'Trades recorded here per pool', p: hereStamp }] : []),
  ];
  return (
    <ProvScope
      className="tk-scope"
      old={stamp.status === 'stale'}
      oldSentence={<>The pool list did not answer just now. These figures are its last answer, from {fmtAgo(stamp.at, now)}, so they are shown dimmed.</>}
    >
      <p className="lead">
        <Num as="b" v={r.pairs.length} fmt={fmtCount} /> pools hold <Num as="b" v={total} prov={totalStamp} fmt={fmtUsdWhole} />. The biggest holds{' '}
        <Num as="b" v={share} fmt={(n) => fmtPctRule(n, 1)} showReason={false} /> of it.
      </p>
      {/* the two volume sources, each with its own stamp in view: the Osmosis pair summary's update time and the flow index's */}
      <p className="cap tk-osmo">
        In the last 24 hours Osmosis counts{' '}
        <Num as="b" v={r.osmosisTotals.volume24hUsd} prov={r.osmosisTotals.volume24hUsd == null ? { ...osmoStamp, status: 'missing', note: osmoStamp.note ?? 'no pair has the figure' } : osmoStamp} fmt={fmtUsdWhole} stamp="dot" showAge={false} label="Dollars traded across the NAM pools (Osmosis pair summary)" /> traded across these pools, the priced side only
        {anyHere ? (
          <>; this site recorded <Num as="b" v={hereTotal} prov={hereStamp} fmt={fmtCount} stamp="dot" showAge={false} label="Trades recorded here through the NAM pools" /> {hereTotal === 1 ? 'trade' : 'trades'} through them</>
        ) : null}.
      </p>
      {osmosisLine}
      <PairsList pairs={shown} rest={rest} oneSided={oneSided} totalUsd={total ?? 0} pairName={pairName} label="Pools that trade NAM" />
      <SourceLine items={items} label="Where the pool figures come from" />
    </ProvScope>
  );
}

export function Pools({ rewound, pools, pairs, depth, overview }: PoolsProps) {
  const now = useUiNow();
  const list = pools.data?.pools ?? [];
  const osmosis = overview ? { value: overview.supply.osmosis, prov: { ...overview.supply.osmosisProv, plain: 'Osmosis supply' } as Stamp } : null;

  const osmosisLine = osmosis && osmosis.value != null ? (
    <p className="cap tk-osmo">
      NAM held on Osmosis, in wallets and pools: <Num as="b" v={osmosis.value} prov={osmosis.prov} fmt={fmtNamRule} showAge={false} />{NBSP}NAM.
    </p>
  ) : null;

  // the volume per pool is a figure only the pairs route has: said once, with the reason, when it does not answer
  const pairsMissing = !rewound && pairs && !pairs.data && !pairs.loading ? (pairs.unserved ? NOT_SERVED : pairs.error ?? NOT_SERVED) : null;
  const volumeLine = pairsMissing ? (
    <p className="cap tk-pairsmiss">
      Dollars traded per pool: <Num v={null} prov={{ source: 'Osmosis data API (pairs)', plain: 'Osmosis app data', at: null, status: 'missing', note: pairsMissing }} />
    </p>
  ) : null;

  let body: ReactNode;
  if (!rewound && pairs?.data && pairs.data.pairs.length) {
    body = <PairsBody r={pairs.data} osmosisLine={osmosisLine} />;
  } else if (list.length) {
    const { shown, rest, oneSided } = splitPools(list);
    const total = pricedTotal(list).usd;
    const top = Math.max(0, ...[...shown, ...oneSided].map((p) => (p.liquidityUsd != null && Number.isFinite(p.liquidityUsd) ? p.liquidityUsd : 0)));
    const restSum = restOf(rest);
    const stamp: Stamp = { ...pools.data!.prov, plain: 'Osmosis pools' };
    const share = (p: PoolInfo) => (total != null && total > 0 && p.liquidityUsd != null ? (p.liquidityUsd / total) * 100 : null);
    const size = (p: PoolInfo) => (p.liquidityUsd != null ? <Num v={p.liquidityUsd} fmt={fmtUsdWhole} showReason={false} /> : <Num v={null} prov={p.sizeProv ? { ...p.sizeProv, status: 'missing' } : null} />);
    body = (
      <ProvScope
        className="tk-scope"
        old={stamp.status === 'stale'}
        oldSentence={<>The pool list did not answer just now. These figures are its last answer, from {fmtAgo(stamp.at, now)}, so they are shown dimmed.</>}
      >
        <p className="lead">
          <Num as="b" v={list.length} fmt={fmtCount} /> pools hold <Num as="b" v={total} fmt={fmtUsdWhole} />. The biggest holds{' '}
          <Num as="b" v={share(shown[0])} fmt={(n) => fmtPctRule(n, 1)} showReason={false} /> of it.
        </p>
        {osmosisLine}
        {volumeLine}
        <DataList kind="pools" label="Pools that trade NAM" className="tk-pools">
          {shown.map((p) => (
            <PoolRow
              key={`${p.id}-${p.address}`}
              pair={pairName(p)}
              sub={<span className="mono">{p.id ? `#${p.id}` : 'no id'} · {p.type}</span>}
              depth={size(p)}
              share={<Num v={share(p)} fmt={(n) => fmtPctRule(n, 1)} unit="of all depth" showReason={false} />}
              nam={<Inside nam={p.namReserve} counter={p.counterReserve} coin={counterName(p)} />}
              fee={<Num v={Number.isFinite(p.spreadFactor) ? p.spreadFactor * 100 : null} fmt={(n) => fmtPctRule(n)} unit="fee" showReason={false} />}
              bar={top > 0 && p.liquidityUsd != null ? p.liquidityUsd / top : null}
            />
          ))}
          {oneSided.map((p) => {
            const one = oneSidedWords(poolSides(p), p.counterSymbol && p.counterSymbol !== 'UNKNOWN' && !p.counterSymbol.startsWith('ibc/') ? p.counterSymbol : null)!;
            return (
              <PoolRow
                key={`${p.id}-${p.address}`}
                pair={pairName(p)}
                sub={<><span className="mono">{p.id ? `#${p.id}` : 'no id'} · {p.type}</span> · {one.line}</>}
                depth={size(p)}
                share={<Num v={share(p)} fmt={(n) => fmtPctRule(n, 1)} unit="of all depth" showReason={false} />}
                nam={<Inside nam={p.namReserve} counter={p.counterReserve} coin={counterName(p)} />}
                fee={<Num v={Number.isFinite(p.spreadFactor) ? p.spreadFactor * 100 : null} fmt={(n) => fmtPctRule(n)} unit="fee" showReason={false} />}
                bar={top > 0 && p.liquidityUsd != null ? p.liquidityUsd / top : null}
              />
            );
          })}
          {rest.length ? (
            <PoolRestRow end={<><Num v={restSum.usd} fmt={fmtUsdWhole} /> together, none above <Num v={restSum.max} fmt={fmtUsdWhole} />{restSum.notPriced ? <>; <Num v={restSum.notPriced} fmt={fmtCount} /> of them not priced, so not counted</> : null}</>}>
              <Num as="b" v={rest.length} fmt={fmtCount} /> more {rest.length === 1 ? 'pool' : 'pools'}
            </PoolRestRow>
          ) : null}
        </DataList>
        <SourceLine items={[{ label: 'Pool depth and the coins inside', p: stamp }, ...(osmosis ? [{ label: 'NAM held on Osmosis', p: osmosis.prov }] : [])]} label="Where the pool figures come from" />
      </ProvScope>
    );
  } else if (!rewound && pools.loading) {
    body = (
      <>
        <p className="lead"><span className="tk-lead-skel" aria-hidden="true" /></p>
        <Skeleton rows={8} heights={[68]} label="the pools" />
      </>
    );
  } else {
    // No live list: rewound (not requested) or the pool service did not answer. The overview's
    // figures (as of the rewound time, or the last stored reading) stand in, each with its stamp.
    const why = rewound
      ? `The pool list is a live reading and was not recorded over time, so it is not shown while rewound. ${REWIND_WORDS.quotes}`
      : `${pools.data?.prov.note ?? pools.error ?? 'The pool list did not answer.'} The totals above are the last stored reading.`;
    const stamp = depth?.stamp ?? null;
    const items = [...(stamp ? [{ label: 'Pool depth', p: stamp }] : []), ...(osmosis ? [{ label: 'NAM held on Osmosis', p: osmosis.prov }] : [])];
    body = (
      <ProvScope className="tk-scope">
        {depth && depth.usd != null ? (
          <p className="lead">
            {depth.count != null ? <><Num as="b" v={depth.count} prov={depth.stamp} fmt={fmtCount} showAge={false} /> pools hold</> : 'The pools hold'}{' '}
            <Num as="b" v={depth.usd} prov={depth.stamp} fmt={fmtUsdWhole} />
            {rewound ? ' at that time' : ''}.
          </p>
        ) : null}
        {osmosisLine}
        {volumeLine}
        <Notice tone={rewound ? 'info' : 'warning'} title={rewound ? 'Pool rows are live only.' : 'The pool list is not available.'}>
          {why}
        </Notice>
        {items.length ? <SourceLine items={items} label="Where the pool figures come from" /> : null}
      </ProvScope>
    );
  }

  return (
    <div className="band ground-ink pools">
      <div className="wrap">
        <section className="tk-sec" aria-labelledby="h-pools">
          <h2 id="h-pools" className="h2">Where NAM trades</h2>
          {body}
          {/* the two quotable depth figures of the newest stored minute, with their time, linking to /depth (depth plan 3.1) */}
          <DepthLine live={!rewound} symbol={SITE_SYMBOL} className="tk-depthline" />
        </section>
      </div>
    </div>
  );
}

export default Pools;
