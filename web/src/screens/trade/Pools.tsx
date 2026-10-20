// "Where NAM trades" (system.md 9.2): the NAM pools on Osmosis as rows (phones) or a table (from
// 600 px of its own width), below the split, full width, black. The pool list is a live reading:
// under Rewind it is not requested, and the overview's figures as of that time stand in its place,
// each with its own stamp. One SourceLine under the list.
import type { ReactNode } from 'react';
import type { Overview, PoolInfo, Provenance } from '../../../../shared/types';
import { REWIND_WORDS } from '../../app/index';
import { DataList, Notice, Num, PoolRestRow, PoolRow, ProvScope, Skeleton, SourceLine, useUiNow } from '../../ui/index';
import type { Stamp } from '../../ui/index';
import { NBSP, fmtAgo, fmtCount, fmtNamRule, fmtPctRule, fmtUsdWhole } from '../../lib/format';
import type { Depth } from './model';
import { pairName, splitPools } from './model';

export interface PoolsProps {
  rewound: boolean;
  pools: { data: { pools: PoolInfo[]; prov: Provenance } | null; error: string | null; loading: boolean };
  depth: Depth | null;
  overview: Overview | null;
}

export function Pools({ rewound, pools, depth, overview }: PoolsProps) {
  const now = useUiNow();
  const list = pools.data?.pools ?? [];
  const osmosis = overview ? { value: overview.supply.osmosis, prov: { ...overview.supply.osmosisProv, plain: 'Osmosis supply' } as Stamp } : null;

  const osmosisLine = osmosis && osmosis.value != null ? (
    <p className="cap tk-osmo">
      NAM held on Osmosis, in wallets and pools: <Num as="b" v={osmosis.value} prov={osmosis.prov} fmt={fmtNamRule} showAge={false} />{NBSP}NAM.
    </p>
  ) : null;

  let body: ReactNode;
  if (list.length) {
    const { shown, rest, total } = splitPools(list);
    const top = shown[0]?.liquidityUsd || 0;
    const restUsd = rest.reduce((a, p) => a + (p.liquidityUsd || 0), 0);
    const restMax = rest.reduce((a, p) => Math.max(a, p.liquidityUsd || 0), 0);
    const stamp: Stamp = { ...pools.data!.prov, plain: 'Osmosis pools' };
    const share = (p: PoolInfo) => (total > 0 ? (p.liquidityUsd / total) * 100 : null);
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
        <DataList kind="pools" label="Pools that trade NAM" className="tk-pools">
          {shown.map((p) => (
            <PoolRow
              key={`${p.id}-${p.address}`}
              pair={pairName(p)}
              sub={<span className="mono">{p.id ? `#${p.id}` : 'no id'} · {p.type}</span>}
              depth={<Num v={p.liquidityUsd} fmt={fmtUsdWhole} showReason={false} />}
              share={<Num v={share(p)} fmt={(n) => fmtPctRule(n, 1)} unit="of all depth" showReason={false} />}
              nam={<Num v={p.namReserve} fmt={fmtNamRule} unit="NAM" showReason={false} />}
              fee={<Num v={Number.isFinite(p.spreadFactor) ? p.spreadFactor * 100 : null} fmt={(n) => fmtPctRule(n)} unit="fee" showReason={false} />}
              bar={top > 0 ? p.liquidityUsd / top : null}
            />
          ))}
          {rest.length ? (
            <PoolRestRow end={<><Num v={restUsd} fmt={fmtUsdWhole} /> together, none above <Num v={restMax} fmt={fmtUsdWhole} /></>}>
              <Num as="b" v={rest.length} fmt={fmtCount} /> more {rest.length === 1 ? 'pool' : 'pools'}
            </PoolRestRow>
          ) : null}
        </DataList>
        <SourceLine items={[{ label: 'Pool depth and NAM inside', p: stamp }, ...(osmosis ? [{ label: 'NAM held on Osmosis', p: osmosis.prov }] : [])]} label="Where the pool figures come from" />
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
        </section>
      </div>
    </div>
  );
}

export default Pools;
