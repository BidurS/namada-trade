// View 4, WHO HOLDS IT (depth plan 3.2; step S6): the owners table from /api/depth/owners (kv depth.owners with each
// address's label as the labels table has it now): the owner (short address and label, opening the address sheet as
// the Holders page does; owner decision 21), where (pool chips), the coins and USD resting, the share with a bar, what
// is held ("4 positions", "10 orders"), since (the oldest item), and a disclosure per owner listing each position's
// range or each order's price and what is left of it. Sorted by share. An owner who placed and pulled orders within
// the week carries "replaced N times this week", counted from the change rows (an order added and one withdrawn by the
// same address). One SourceLine naming the hour's reads; the hour's own three checks with their words. Live only: the
// kv row holds the newest hour, and a rewound page says so.
import { useMemo } from 'react';
import type { DepthChangeRow, DepthOwner, DepthOwnersApiResponse } from '../../../../shared/depth';
import {
  HEAD_HOLDS, HEAD_OWNER, HEAD_POOLS, HEAD_SHARE, HEAD_SINCE, HEAD_USD_RESTING, INVARIANTS_LABEL, INV_NONE, INV_NOT, INV_OK, INVARIANT_WORDS, ITEMS_LABEL, ORDERS_CARRIED, ORDER_BID_UNIT, OWNERS_NONE_LABELLED, OWNERS_REWIND, OWNERS_SOURCE_LABEL, OWNERS_WAITS, SOURCE_OWNERS, WHO_H2,
  headResting, holdsWords, itemOrder, itemPosition, openOwnerAria, ownersLabelled, ownersReadAt, ownersTotals, poolWord, replacedWords, whoLead,
} from '../../../../shared/depth';
import { AddrName, Notice, SkeletonBlock, SourceLine, Tag, type Stamp } from '../../ui/index';
import { fmtAddr, fmtCount, fmtDayMonthYear, fmtNamRule, fmtSharePct, fmtSig, fmtUsdRule, fmtUtcClock } from '../../lib/format';
import type { ChangesWindow } from './data';
import { priceRange, provStamp } from './model';

export interface WhoProps {
  owners: { data: DepthOwnersApiResponse | null; error: string | null };
  changes: { data: ChangesWindow | null };
  symbol: string;
  rewound: boolean;
  headingId: string;
}

const WEEK_MS = 7 * 86_400_000;

/** How many times an owner placed an order and pulled one within the week: the smaller of the two counts, from the change rows. */
export function replacedCount(rows: DepthChangeRow[], address: string, now: number): number {
  let added = 0, removed = 0;
  for (const r of rows) {
    if (r.owner !== address || !r.ref.startsWith('ord:') || r.ts < now - WEEK_MS) continue;
    if (r.kind === 'added') added++;
    else if (r.kind === 'removed') removed++;
  }
  return Math.min(added, removed);
}

/** The owner's pools, the order book named as such (an order rests on the book; a position in a pool). */
const poolsOf = (o: DepthOwner): string[] => {
  const books = new Set(o.items.filter((i) => i.kind === 'order').map((i) => i.pool));
  return o.pools.map((id) => poolWord(id, books.has(id) ? 'cosmwasm' : null));
};
const since = (o: DepthOwner): number | null => o.items.reduce<number | null>((a, i) => (i.since != null && (a == null || i.since < a) ? i.since : a), null);

export function Who({ owners, changes, symbol, rewound, headingId }: WhoProps) {
  const o = owners.data;
  const sorted = useMemo(() => (o ? [...o.owners].sort((a, b) => b.share - a.share) : []), [o]);
  const maxShare = sorted[0]?.share ?? 0;
  const rows = changes.data?.rows ?? [];
  const now = changes.data?.to ?? Date.now();
  const stamp: Stamp | null = o ? { source: SOURCE_OWNERS, plain: SOURCE_OWNERS, at: o.at, height: o.height, status: 'live', note: o.notes[0] } : null;
  const reads = o ? o.prov.slice(0, 12).map((p) => ({ label: p.what, p: provStamp(p) })) : [];
  const invWord = (ok: boolean | null) => (ok === true ? INV_OK : ok === false ? INV_NOT : INV_NONE);

  return (
    <div className="dp-who" data-prov-scope="">
      <h2 id={headingId} className="h2">{WHO_H2}</h2>
      <p className="cap dp-lead">{whoLead(symbol)}</p>
      {rewound ? (
        <Notice tone="info" title={OWNERS_REWIND} />
      ) : o ? (
        <>
          <p className="cap dp-who__totals">
            <b data-num="">{ownersTotals(o.owners.length, o.totals.positions, o.totals.orders, fmtUsdRule(o.totals.usd))}</b> · {o.labelled ? ownersLabelled(o.labelled) : OWNERS_NONE_LABELLED} · {ownersReadAt(fmtUtcClock(o.at), o.height != null ? fmtCount(o.height) : '—')}{!o.orders.read && o.orders.at != null ? ` · ${ORDERS_CARRIED}` : ''}
          </p>
          <div className="dp-orows" role="table" aria-label={WHO_H2}>
            <div className="dp-orow dp-orow--head" role="row">
              <span role="columnheader">{HEAD_OWNER}</span>
              <span role="columnheader">{HEAD_POOLS}</span>
              <span role="columnheader">{headResting(symbol)}</span>
              <span role="columnheader">{HEAD_USD_RESTING}</span>
              <span role="columnheader">{HEAD_SHARE}</span>
              <span role="columnheader">{HEAD_HOLDS}</span>
              <span role="columnheader">{HEAD_SINCE}</span>
            </div>
            {sorted.map((w) => {
              const rep = replacedCount(rows, w.address, now);
              const s = since(w);
              const name = w.label ?? fmtAddr(w.address);
              return (
                <details key={w.address} className="dp-orow" role="row">
                  <summary aria-label={openOwnerAria(name)}>
                    <span role="cell" className="dp-orow__owner">
                      <AddrName address={w.address} label={w.label} />
                      {w.category ? <Tag cat={w.category} /> : null}
                      {rep ? <small className="dp-orow__rep">{replacedWords(rep)}</small> : null}
                    </span>
                    <span role="cell" className="dp-orow__pools">{poolsOf(w).map((p) => <i key={p} className="dp-chip">{p}</i>)}</span>
                    <span role="cell" className="dp-orow__nam" data-num="">{fmtNamRule(w.nam)}<small> {symbol}</small></span>
                    <span role="cell" className="dp-orow__usd" data-num="">{fmtUsdRule(w.usd)}</span>
                    <span role="cell" className="dp-orow__share" data-num="">
                      <i className="dp-orow__bar" style={{ width: `${(maxShare > 0 ? (w.share / maxShare) * 100 : 0).toFixed(1)}%` }} aria-hidden="true" />
                      {fmtSharePct(w.share * 100)}
                    </span>
                    <span role="cell" className="dp-orow__holds">{holdsWords(w.positions, w.orders)}</span>
                    <span role="cell" className="dp-orow__since" data-num="">{s != null ? fmtDayMonthYear(s) : '—'}</span>
                  </summary>
                  <ul className="dp-orow__items" aria-label={ITEMS_LABEL}>
                    {w.items.map((it) => (
                      <li key={`${it.kind}:${it.pool}:${it.id}`}>
                        <i className="dp-chip dp-chip--n">{poolWord(it.pool, it.kind === 'order' ? 'cosmwasm' : null)}</i>{' '}
                        {it.kind === 'position'
                          ? itemPosition(it.id, priceRange(it.loUsd, it.hiUsd), fmtNamRule(it.nam), symbol, fmtUsdRule(it.usd), !!it.inRange)
                          : itemOrder(it.id, it.side ?? null, fmtSig(it.loUsd), fmtNamRule(it.remaining ?? it.nam), fmtNamRule(it.placed ?? it.nam), it.side === 'bid' ? ORDER_BID_UNIT : symbol)}
                        {it.since != null ? <small className="dp-orow__when"> · {fmtDayMonthYear(it.since)}</small> : null}
                      </li>
                    ))}
                  </ul>
                </details>
              );
            })}
          </div>
          <dl className="dp-inv">
            <dt>{INVARIANTS_LABEL}</dt>
            {(['inRange', 'tickStore', 'bookTotals'] as const).map((k) => (
              <dd key={k}><b>{invWord(o.invariants[k]?.ok ?? null)}</b>: {INVARIANT_WORDS[k]}{o.invariants[k]?.note ? ` (${o.invariants[k].note})` : ''}</dd>
            ))}
          </dl>
          <SourceLine items={[{ label: SOURCE_OWNERS, p: stamp }, ...reads]} label={OWNERS_SOURCE_LABEL} />
        </>
      ) : owners.error ? (
        <Notice tone="warning" title={owners.error}>{OWNERS_WAITS}</Notice>
      ) : (
        <div className="dp-bookskel" aria-busy="true" role="status" aria-label={OWNERS_WAITS}><SkeletonBlock height={44} /><SkeletonBlock height={320} /></div>
      )}
    </div>
  );
}

export default Who;
