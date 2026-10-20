// Activity, Transactions tab (system.md 9.5): every recorded move of NAM, newest first.
//
// Rows (phones): line 1 the kind tag and the signed NAM; line 2 from → to, age and the dollar
// value; a disclosure opens line 3, "time and price source" with the record link. From a 880 px
// container the same cells line up as a table (Time, What, NAM, Value, From and to, Source,
// Record) with the column heads sticky under the header.
//
// Data: GET /api/flows with every filter the API supports (chain, kind or kind group, minimum NAM,
// bot trades left out, each bridge crossing once, address or record search, pages). Under Rewind the
// shell's fetch wrapper adds `at` (rows at or before that time) and nothing is streamed. While live,
// moves that arrive through the stream are merged on top and animate in; nothing else animates.
import { useEffect, useMemo, useState } from 'react';
import type { Flow } from '../../../../shared/types';
import { fetchFlows, flowsCsvHref, type FlowsQuery } from '../../api';
import { osmosisStreaming, streamStamp, useClock, useOverlays, useOverview, useReplay } from '../../app/index';
import { Button, EmptyState, Notice, Num, ProvScope, Segmented, SelectChip, Skeleton, SourceLine, TxList, type ScopeItem, type Stamp } from '../../ui';
import { kindInfo, type TagKind } from '../../lib/kinds';
import { applyFlowRules, isBot } from '../../lib/flows';
import { fmtAge, fmtCount, fmtUtcLong } from '../../lib/format';
import { ActivityBar, FilterPanel, FilterSet, SearchField } from './parts';

// ---------------------------------------------------------------- filters
export interface TxFilters {
  chain: 'all' | 'namada' | 'osmosis';
  /** a FlowKind, a server group ('dex', 'ibc') or 'all' */
  kind: string;
  /** at least this many NAM (0: any size) */
  minNam: '0' | '1000' | '10000' | '100000';
  /** bot round trips shown (tagged) or left out (?arb=false) */
  bots: 'show' | 'hide';
  /** each bridge crossing once (?pairs=one) or both chains' records */
  pairs: 'one' | 'both';
  /** address or record (transaction hash) contains */
  search: string;
}
export const TX_DEFAULT: TxFilters = { chain: 'all', kind: 'all', minNam: '0', bots: 'show', pairs: 'one', search: '' };
export const txFilterCount = (f: TxFilters): number => (Object.keys(TX_DEFAULT) as (keyof TxFilters)[]).filter((k) => f[k] !== TX_DEFAULT[k]).length;

const PAGE = 50;
/** The flow export's row cap (worker/src/api.ts /api/export/flows; web/src/api.ts flowsCsvHref sends it). */
const CSV_MAX = 5000;
const kw = (k: TagKind) => kindInfo(k).word;
/** Kind chips: the two server groups, then each kind in the order a trader reads them. */
const KIND_OPTIONS: { value: string; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'dex', label: 'All trades' },
  { value: 'buy', label: kw('buy') },
  { value: 'sell', label: kw('sell') },
  { value: 'ibc', label: 'All bridge crossings' },
  { value: 'ibc_in', label: kw('bridgedIn') },
  { value: 'ibc_out', label: kw('bridgedOut') },
  { value: 'bond', label: kw('staked') },
  { value: 'unbond', label: kw('unstaking') },
  { value: 'withdraw', label: kw('unlocked') },
  { value: 'rewards', label: kw('reward') },
  { value: 'shield', label: kw('shieldIn') },
  { value: 'unshield', label: kw('shieldOut') },
  { value: 'lp_add', label: kw('poolAdd') },
  { value: 'lp_remove', label: kw('poolRemove') },
  { value: 'transfer', label: kw('transfer') },
  { value: 'pgf', label: kw('pgf') },
  { value: 'other', label: kw('bot') },
];
const GROUPS: Record<string, string[]> = { dex: ['buy', 'sell', 'lp_add', 'lp_remove'], ibc: ['ibc_in', 'ibc_out'] };

/** The server's chain, kind and search conditions (worker/src/flows-query.ts), for rows that arrive by stream. */
function matches(fl: Flow, f: TxFilters): boolean {
  if (f.chain !== 'all' && fl.chain !== f.chain) return false;
  if (f.kind !== 'all' && !(GROUPS[f.kind]?.includes(fl.kind) ?? (f.kind === 'other' ? isBot(fl) : fl.kind === f.kind))) return false;
  if (f.search) {
    const q = f.search.toLowerCase();
    if (![fl.from, fl.to, fl.txHash].some((x) => x?.toLowerCase().includes(q))) return false;
  }
  return true;
}

/** The size, bot and crossing rules as the API takes them. */
const rulesOf = (f: TxFilters) => ({ minNam: Number(f.minNam) || undefined, arb: f.bots === 'hide' ? (false as const) : undefined, pairs: f.pairs === 'one' ? ('one' as const) : undefined });

// ---------------------------------------------------------------- the tab
export default function Transactions({
  filters,
  setFilters,
  wide,
}: {
  filters: TxFilters;
  setFilters: (f: TxFilters) => void;
  wide: boolean;
}) {
  const { at, rewound } = useReplay();
  const now = useClock();
  const { overview, liveFlows, streamedIds, stream } = useOverview();
  const { openAddress } = useOverlays();
  const [sheet, setSheet] = useState(false);

  // ---- page 1 for these filters, then "Load more" appends
  const key = JSON.stringify([filters, at]);
  // exact: `total` is the count of these filters (false: an older server ignored a rule, and `total` is only an
  // upper bound); more: the server holds rows after the last page fetched
  const [data, setData] = useState<{ key: string; flows: Flow[]; total: number; page: number; exact: boolean; more: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [retry, setRetry] = useState(0);
  const q: FlowsQuery = { asOf: at, chain: filters.chain, kind: filters.kind, search: filters.search, ...rulesOf(filters) };
  const query = (page: number) => fetchFlows({ ...q, page, limit: PAGE });
  useEffect(() => {
    let live = true;
    setError(null);
    query(1)
      .then((r) => live && setData({ key, flows: r.flows, total: r.total, page: 1, exact: r.exact, more: r.more }))
      .catch(() => live && setError('The list of moves could not be fetched from this site’s server.'));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, retry]);

  const loadMore = () => {
    if (!data || more) return;
    setMore(true);
    query(data.page + 1)
      .then((r) => {
        setData((d) => {
          if (!d || d.key !== key) return d;
          const ids = new Set(d.flows.map((x) => x.id));
          return { ...d, flows: [...d.flows, ...r.flows.filter((x) => !ids.has(x.id))], total: r.total, page: d.page + 1, exact: d.exact && r.exact, more: r.more };
        });
      })
      .catch(() => setError('More moves could not be fetched from this site’s server.'))
      .finally(() => setMore(false));
  };

  // ---- streamed moves on top (live only, never the load-time seed)
  const fresh = data?.key === key ? data : null;
  const rows = useMemo(() => {
    if (!fresh) return [];
    if (rewound) return fresh.flows;
    const have = new Set(fresh.flows.map((x) => x.id));
    const newest = fresh.flows[0]?.ts ?? 0;
    const add = liveFlows.filter((x) => streamedIds.has(x.id) && !have.has(x.id) && x.ts >= newest && matches(x, filters));
    return add.length ? applyFlowRules([...add, ...fresh.flows], rulesOf(filters)) : fresh.flows;
  }, [fresh, liveFlows, streamedIds, rewound, filters]);
  const added = fresh ? rows.length - fresh.flows.length : 0;
  const exact = fresh?.exact ?? true;
  // not exact: the count of these filters is not known, only the rows listed
  const total = fresh ? (exact ? fresh.total + Math.max(0, added) : rows.length) : null;
  const streaming = osmosisStreaming(stream, now);

  // ---- the list's provenance scope: the flow index per chain, the stream while live
  const scope: ScopeItem[] = [];
  if (overview) {
    if (filters.chain !== 'namada') scope.push({ label: 'Moves on Osmosis', p: overview.dex.coverage });
    if (filters.chain !== 'osmosis') scope.push({ label: 'Moves on Namada', p: overview.namada.coverage });
  }
  if (!rewound) scope.push({ label: 'New moves as they happen', p: streamStamp(stream, now) });
  // the flow index of a chain listed here fell behind: said once, with the oldest such check
  const covStale = overview ? scope.filter((s) => s.p && s.label.startsWith('Moves on') && s.p.status === 'stale').map((s) => s.p as Stamp) : [];
  const covAt = covStale.length ? Math.min(...covStale.map((p) => p.at ?? Infinity)) : null;

  const count = txFilterCount(filters);
  const set = (patch: Partial<TxFilters>) => setFilters({ ...filters, ...patch });
  const showLabel = total == null ? 'Show moves' : `Show ${exact ? '' : 'at least '}${fmtCount(total)} move${total === 1 ? '' : 's'}`;
  const sizeLabel = (n: string) => (n === '0' ? 'Any' : `${fmtCount(Number(n))}+`);

  const search = (compact: boolean) => (
    <SearchField label="Search moves by address or record" compact={compact} value={filters.search} onChange={(v) => set({ search: v })} placeholder={compact ? 'Search an address or record' : 'tnam1…, osmo1… or a record id'} />
  );
  const controls = (
    <>
      <FilterSet label="Chain">
        <Segmented label="Chain" value={filters.chain} onChange={(v) => set({ chain: v })} options={[{ value: 'all', label: 'Both' }, { value: 'namada', label: 'Namada' }, { value: 'osmosis', label: 'Osmosis' }]} />
      </FilterSet>
      <FilterSet label="Size, NAM">
        <Segmented label="Size, NAM" value={filters.minNam} onChange={(v) => set({ minNam: v })} options={(['0', '1000', '10000', '100000'] as const).map((v) => ({ value: v, label: sizeLabel(v) }))} />
      </FilterSet>
      <SelectChip label="What" className="act-kinds" value={filters.kind} onChange={(v) => set({ kind: v })} options={KIND_OPTIONS} />
      <FilterSet label="Bot trades" className="act-fset--opt">
        <Segmented label="Bot trades" value={filters.bots} onChange={(v) => set({ bots: v })} options={[{ value: 'show', label: 'Shown' }, { value: 'hide', label: 'Left out' }]} />
      </FilterSet>
      <FilterSet label="Bridge crossings" className="act-fset--opt">
        <Segmented label="Bridge crossings" value={filters.pairs} onChange={(v) => set({ pairs: v })} options={[{ value: 'one', label: 'Once' }, { value: 'both', label: 'Both records' }]} />
      </FilterSet>
      {wide ? null : search(false)}
      {count ? (
        <Button variant="secondary" size="sm" className="act-clear" onClick={() => setFilters(TX_DEFAULT)}>
          Clear filters
        </Button>
      ) : null}
    </>
  );

  const busy = !!data && data.key !== key;

  return (
    <>
      <ActivityBar view="activity" wide={wide} filterCount={count} filterOpen={sheet} onFilter={() => setSheet(true)} search={wide ? search(true) : null} />
      <FilterPanel wide={wide} open={sheet} onClose={() => setSheet(false)} title="Filter moves" show={showLabel}>
        {controls}
      </FilterPanel>

      <ProvScope className="act-scope" id="act-tx-scope" aria-busy={busy || !data || undefined}>
        <p className="act-count" aria-live="polite">
          {total == null ? (
            <span className="skel__b act-count__sk" aria-hidden="true" />
          ) : (
            <>
              {exact ? null : 'At least '}
              <Num v={total} fmt={fmtCount} /> {total === 1 ? 'move' : 'moves'}
              {count ? (total === 1 ? ' matches the filters' : ' match the filters') : ' recorded'}
              {rewound && at ? <>, at or before {fmtUtcLong(at)}</> : null}, newest first.
              {!rewound ? (
                <span className="act-live" data-status={!stream.connected ? 'none' : streaming === false ? 'old' : 'fresh'}>
                  <i className="dot" data-status={!stream.connected ? 'none' : streaming === false ? 'old' : 'fresh'} aria-hidden="true" />
                  {!stream.connected ? 'Not streaming right now' : streaming === false ? 'Osmosis moves are not streaming right now; Namada moves are' : 'New moves appear as they are recorded'}
                </span>
              ) : null}
            </>
          )}
        </p>
        {covAt != null ? (
          <p className="scope__old act-lag">
            <i className="dot" data-status="old" aria-hidden="true" />
            <span>{Number.isFinite(covAt) ? <>The flow index last checked the chain {fmtAge(now - covAt)} ago, so later moves may not be listed yet.</> : <>The flow index has no recorded time, so later moves may not be listed yet.</>}</span>
          </p>
        ) : null}

        {error && !fresh ? (
          <Notice tone="warning" title="The moves did not load" action={<Button size="sm" onClick={() => setRetry((n) => n + 1)}>Try again</Button>}>
            {error}
          </Notice>
        ) : !fresh && !data ? (
          <Skeleton rows={8} heights={[72]} label="moves" className="act-skel" />
        ) : (
          <div className="act-txwide">
            <TxList rows={busy ? data!.flows : rows} now={now} streamedIds={rewound ? undefined : streamedIds} onAddr={openAddress} busy={busy} />
          </div>
        )}

        {fresh && rows.length === 0 ? (
          <EmptyState title="No recorded move matches these filters.">
            {rewound && at ? <>The list holds moves at or before {fmtUtcLong(at)}. </> : null}
            The chain, kind, size and search chosen above leave nothing to show.
          </EmptyState>
        ) : null}

        {scope.length ? <SourceLine items={scope} label="Where the moves come from" /> : <p className="src act-src-ph" aria-hidden="true" />}
      </ProvScope>

      {fresh && rows.length > 0 ? (
        <div className="act-more">
          {fresh.more ? (
            <Button variant="secondary" busy={more} onClick={loadMore}>
              Load more moves
            </Button>
          ) : null}
          {/* these repeat the count line, whose source is the list's SourceLine above */}
          <p className="cap" data-prov-ref="act-tx-scope">
            {exact ? (
              <>
                <Num v={rows.length} fmt={fmtCount} /> of <Num v={total} fmt={fmtCount} /> shown.
              </>
            ) : (
              <>
                <Num v={rows.length} fmt={fmtCount} /> shown; more may be recorded.
              </>
            )}
            {error && fresh ? ` ${error}` : ''}
          </p>
          <a className="link act-csv" href={flowsCsvHref(q)} download>
            {/* the export holds at most the newest CSV_MAX moves (worker/src/api.ts /api/export/flows) */}
            <span>{exact && total != null && total > CSV_MAX ? `Export the newest ${fmtCount(CSV_MAX)} of ${fmtCount(total)} moves these filters select as CSV` : exact ? 'Export the moves these filters select as CSV' : `Export the moves these filters select as CSV (the newest ${fmtCount(CSV_MAX)} at most)`}</span>
          </a>
        </div>
      ) : null}
    </>
  );
}
